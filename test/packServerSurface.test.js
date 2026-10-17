// test/packServerSurface.test.js — 本批新增的四格服务端能力（DESIGN §28.14/§28.30/§28.31/§28.32/§28.33）。
//
// 一份文件钉五件事，因为它们是同一条线上的东西（「包只能观察 / 只能声明，不能设值、不能注入代码」）：
//   1. `server.modules` 的**源码静态扫描**（那是 `shared/modSurface.js` 从第一天起就承诺、而引擎一直没实现的一条）；
//   2. `boot(config)` 的**冻结只读配置快照**（读得到、改不动、环境变量走白名单）；
//   3. `uses: ["metrics"]` 的**只读标量快照**（是值不是句柄；样本过期就 `null` + 点名）；
//   4. `uses: ["route"]` 的**动态只读端点**（`/mod/<包id>/…`、GET/HEAD、no-store/no-cache、核心保留命名空间）；
//   5. `pack.json.server.transport` 的**声明式传输配置**（生效值进 `welcome.transport`，不是声明值）；
//   6. 作者自备 CDN 的语音素材（§28.33：https only + sha256 核对 + 失败点名 + 绝不内置任何素材地址）。
//
// Run: node --test --test-concurrency=4 test/packServerSurface.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { normalizePackManifest, CLIENT_PANEL_DATA_TABLES, CLIENT_MAX_PANEL_DATA_TABLES, VOICE_CDN_AUDIO_EXTS } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import {
  loadServerModules, mountServerModules, serverModuleSourceIssues, bootConfigSnapshot, BOOT_CONFIG_ENV_KEYS, ModuleRefused,
} from '../server/modModules.js';
import { hostMetrics, HOST_METRICS_FIELDS, resetHostMetrics } from '../server/hostMetrics.js';
import { dynamicRoutePathIssue, RESERVED_ROUTE_PREFIXES, DYNAMIC_ROUTE_MAX_BYTES, runDynamicRoute } from '../server/http/routeMount.js';
import { transportPolicy, WS_MAX_PAYLOAD } from '../server/http/websocket.js';
import { materializeVoiceCdn, dropFailedVoiceCdnFiles, voiceCdnCachePath } from '../server/voiceCdn.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
describe('§28.14 补账：`server.modules` 的源码静态扫描在 import 之前', () => {
  test('禁的是服务端代码那一段：process / globalThis / require / eval / new Function', () => {
    for (const needle of ['process', 'globalThis', 'require', 'eval', 'new Function']) {
      const src = `export function registerServer(host) { const x = ${needle}; }\n`;
      const issues = serverModuleSourceIssues(src, 'p', 'm');
      assert.equal(issues.length, 1, `${needle} 应当被拒`);
      assert.equal(issues[0].code, 'MODULES_BAD_SOURCE');
      assert.match(issues[0].reason, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      // 拒绝文案必须指出**替代路径**，否则作者只知道「我的包没了」。
      assert.match(issues[0].reason, /host\.metrics/);
    }
  });

  test('`globalThis` 那一格：`globalThis.process` 被点名拒（这份扫描最明显的缺口）', () => {
    // 这一格曾经被**拿掉**过：仓库里那个 `server.modules` fixture 拿 `globalThis` 与同进程的测试通信，
    // 于是「禁掉 globalThis」会把一个合法模块连带整包裁掉。现在那个用例走**引擎显式注入**的 `host.io`
    // （`test/packMatchMsg.test.js`，那个包的 `server.modules[].write: true`），所以 `globalThis` 没有存在理由：
    // 它开着的时候 `globalThis.process` 绕得过 `process` 那一格 —— 这是整份扫描里最明显的一条缺口。
    const issues = serverModuleSourceIssues('export function registerServer(host) { return globalThis.process.env; }\n', 'p', 'm');
    assert.equal(issues.length, 1, '`globalThis.process` 必须被拒（改前这里一条都不报）');
    assert.equal(issues[0].code, 'MODULES_BAD_SOURCE');
    assert.match(issues[0].reason, /globalThis/, '点名的必须是 `globalThis` 那一格');
    // 诚实的一句照旧：这仍然是**启发式，不是沙箱** —— 把名字拼成两段就绕得过（那三处也一样绕得过，
    // 见 docs/design/mod-layer.md §28.14 的那段免责）。
    assert.deepEqual(serverModuleSourceIssues("const g = global['global' + 'This'];\n", 'p', 'm'), []);
  });

  test('不误伤：注释里的 process 不算，时钟 / 随机不在这一格的名单里（它不在对局循环里跑）', () => {
    assert.deepEqual(serverModuleSourceIssues('// process.env is mentioned in prose\nconst a = 1;\n', 'p', 'm'), []);
    assert.deepEqual(serverModuleSourceIssues('export function registerServer(h){ h.healthz(() => ({ at: Date.now(), r: Math.random() })); }\n', 'p', 'm'), []);
  });

  test('装载期：一个用 process 的模块让**整包**在同一个裁剪点被拒（错误码点名）', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-srcscan-'));
    try {
      const dir = path.join(tmp, 'p');
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'p', name: 'P', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
        server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'] }] },
      }));
      fs.writeFileSync(path.join(dir, 'server', 'm.mjs'), 'export function registerServer(host) { host.log.info(process.pid); }\n');
      const { modules, errors } = await loadServerModules(loadWorkshop(tmp, { log: quiet }), { log: quiet, stateRoot: path.join(tmp, 'var') });
      assert.deepEqual(modules, []);
      assert.equal(errors[0].code, 'MODULES_BAD_SOURCE');
      assert.match(errors[0].reason, /process/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('装载期：一个用 `globalThis.process` 的模块同样让整包被拒（改前这一条是绿的 = 缺口开着）', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-srcscan-gt-'));
    try {
      const dir = path.join(tmp, 'p');
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'p', name: 'P', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
        server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'] }] },
      }));
      fs.writeFileSync(path.join(dir, 'server', 'm.mjs'), 'export function registerServer(host) { host.log.info(globalThis.process.pid); }\n');
      const { modules, errors } = await loadServerModules(loadWorkshop(tmp, { log: quiet }), { log: quiet, stateRoot: path.join(tmp, 'var') });
      assert.deepEqual(modules, [], '走 globalThis 摸到 process 的模块不该被装载');
      assert.equal(errors[0].code, 'MODULES_BAD_SOURCE');
      assert.match(errors[0].reason, /globalThis/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('§28.14 boot(config)：冻结的只读配置快照', () => {
  test('白名单就是包能观察的那几个 SP_*，多余的看不见；引擎私有的一律不给包看', () => {
    // ① **包可见**白名单：恰好这四个。它们都是"只读观察"性质（表情开关 / 舞台 / 状态目录 / 工坊目录）——
    //    `onBoot` 快照的 `env` 只带这些（shared/modSurface.js：包只能观察不能设值，也永远不能声明启动变量）。
    assert.deepEqual([...BOOT_CONFIG_ENV_KEYS], ['SP_BOT_EMOTES', 'SP_STAGE', 'SP_STATE_DIR', 'SP_WORKSHOP']);
    // ② **引擎私有 / 安全边界参数**：引擎确实读它们，但**故意不给包看**。
    //    `SP_CSP` = 站点 CSP 响应头开关（server/index.js，`off` 才关闭）；`SP_MATCH_HOST` = 对局宿主用子进程还是
    //    worker 线程；`SP_PLUGIN_SCRIPTS` = 插件脚本模式（沙箱开不开）。三者都是运维/安全面，包读到没有正当用途。
    //    ⚠️ **不要"好心"把它们加进上面的白名单** —— 尤其 `SP_PLUGIN_SCRIPTS` 是沙箱开关。
    const ENGINE_PRIVATE_SP = ['SP_CSP', 'SP_MATCH_HOST', 'SP_PLUGIN_SCRIPTS'];
    // 反射源码：引擎里读过的 `process.env.SP_*` 必须两份都归类（新读一个而没归类就红）。
    const src = [path.join(ROOT, 'server/index.js'), path.join(ROOT, 'server/modModules.js'),
      path.join(ROOT, 'server/match/Match.js'), path.join(ROOT, 'server/match/botEmotes.js')]
      .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const read = [...new Set([...src.matchAll(/process\.env\.(SP_[A-Z_]+)/g)].map((m) => m[1]))].sort();
    // ③ 引擎读到的 = 包可见 ∪ 引擎私有。任何一侧漏分类 ⇒ 这条红。
    assert.deepEqual(read, [...BOOT_CONFIG_ENV_KEYS, ...ENGINE_PRIVATE_SP].sort(),
      '引擎读的每个 SP_* 都必须在「包可见白名单」或「引擎私有」里显式归类');
    // 且两者不相交：私有的一旦漏进白名单，包就能读到安全边界参数。
    for (const k of ENGINE_PRIVATE_SP) {
      assert.ok(!BOOT_CONFIG_ENV_KEYS.includes(k), `${k} 是引擎私有/安全边界参数，不该给包看`);
    }
  });

  test('深冻结、值不是句柄、env 只带白名单里的', () => {
    const cfg = bootConfigSnapshot({ port: 8080, host: '127.0.0.1', stateRoot: '/var', env: { SP_STATE_DIR: '/var', SP_STAGE: 'x', SECRET_TOKEN: 'nope' } });
    assert.deepEqual(cfg, { port: 8080, host: '127.0.0.1', stateDir: '/var', env: { SP_STAGE: 'x', SP_STATE_DIR: '/var' } });
    assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.env));
    assert.throws(() => { cfg.port = 1; }, TypeError, '冻结对象在严格模式（ESM）下写入即抛 —— 包只能观察');
    assert.throws(() => { cfg.env.SP_STAGE = 'y'; }, TypeError);
    assert.equal('process' in cfg, false);
  });

  test('`onBoot` 真的收到这个快照（同一份冻结对象）', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-bootcfg-'));
    try {
      const dir = path.join(tmp, 'p');
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'p', name: 'P', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
        server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'] }] },
      }));
      fs.writeFileSync(path.join(dir, 'server', 'm.mjs'), 'export function registerServer(h){ h.onBoot(() => {}); }\n');
      // 装载器注入：这样拿到的就是**同一个**模块实例（动态 import 同一路径会因 `?v=` 查询串不同而造出两份实例）。
      let seen = null;
      const importModule = async () => ({ registerServer: (host) => host.onBoot((cfg) => { seen = cfg; }) });
      const loaded = loadWorkshop(tmp, { log: quiet });
      const { modules, errors } = await loadServerModules(loaded, { log: quiet, stateRoot: path.join(tmp, 'var'), importModule });
      assert.deepEqual(errors, []);
      const mount = mountServerModules(modules, { log: quiet });
      const cfg = bootConfigSnapshot({ port: 1234, host: 'h', stateRoot: '/v', env: {} });
      mount.boot(cfg);
      assert.equal(seen, cfg);
      assert.ok(Object.isFrozen(seen));
      assert.throws(() => { seen.port = 1; }, TypeError);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('§28.31 metrics：只读标量快照（是值不是句柄）', () => {
  test('字段闭集、冻结、里面没有一个函数 / 句柄', () => {
    resetHostMetrics();
    try {
      const snap = hostMetrics({ now: Date.now(), log: quiet });
      assert.deepEqual(Object.keys(snap).sort(), [...HOST_METRICS_FIELDS].sort());
      assert.ok(Object.isFrozen(snap));
      for (const [k, v] of Object.entries(snap)) {
        assert.ok(v === null || typeof v === 'number' || typeof v === 'string', `${k} 必须是标量（不是句柄 / 函数）`);
      }
      assert.equal(typeof snap.rss, 'number');
      assert.equal(snap.state, 'ok');
      // 给一个"未来"的 now 逼出过期分支：loop* 一律 null + state stale + 一条点名的 warn。
      const said = [];
      resetHostMetrics();
      const stale = hostMetrics({ now: Date.now() + 10 ** 7, staleMs: 1000, log: { warn: (m) => said.push(m) } });
      assert.equal(stale.state, 'stale');
      for (const k of ['loopP50', 'loopP95', 'loopP99', 'loopMax']) assert.equal(stale[k], null, `${k} 过期时必须是 null，绝不报旧值`);
      assert.equal(said.length, 1);
      assert.match(said[0], /stale/);
      assert.equal(hostMetrics({ now: Date.now() + 10 ** 7, staleMs: 1000, log: { warn: (m) => said.push(m) } }).state, 'stale');
      assert.equal(said.length, 1, '过期只点名一次，不是每次读一行');
    } finally { resetHostMetrics(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('§28.32 动态只读端点：命名空间、保留路径、缓存策略、同步返回值', () => {
  test('路径必须在 /mod/<包id>/… 里，且不能落在引擎保留的命名空间上', () => {
    assert.equal(dynamicRoutePathIssue('/mod/p/stats.json', 'p'), null);
    for (const prefix of RESERVED_ROUTE_PREFIXES) {
      assert.match(String(dynamicRoutePathIssue(`${prefix}/x.json`, 'p')), /namespace|engine owns|mod\//, `${prefix} 必须够不着`);
    }
    assert.match(dynamicRoutePathIssue('/data/support.json', 'p'), /mod\//);
    assert.match(dynamicRoutePathIssue('/mod/other/stats.json', 'p'), /belongs to pack/);
    assert.match(dynamicRoutePathIssue('/mod/p', 'p'), /must name something/);
    assert.match(dynamicRoutePathIssue('/mod/p/../x', 'p'), /"\." or "\.\."/);
    assert.match(dynamicRoutePathIssue('mod/p/x', 'p'), /absolute HTTP path/);
  });

  test('回调必须同步返回 JSON 可序列化的值，且有大小上限', () => {
    assert.equal(runDynamicRoute(() => ({ a: 1 })).body.toString(), '{"a":1}');
    assert.match(runDynamicRoute(() => Promise.resolve(1)).reason, /synchronously/);
    assert.match(runDynamicRoute(() => undefined).reason, /undefined/);
    assert.match(runDynamicRoute(() => { throw new Error('boom'); }).reason, /boom/);
    const big = runDynamicRoute(() => ({ x: 'y'.repeat(DYNAMIC_ROUTE_MAX_BYTES + 1) }));
    assert.equal(big.ok, false);
    assert.match(big.reason, /at most/);
  });

  test('没声明 `route` 就抛（不是 undefined），声明了就登记', async () => {
    const { hostFor } = await harness();
    assert.throws(() => hostFor({ uses: ['boot'], packId: 'p', moduleId: 'm' }).route('/mod/p/x.json', () => 1), (e) => e instanceof ModuleRefused && e.code === 'MODULE_USE_UNDECLARED');
    assert.throws(() => hostFor({ uses: ['route'], packId: 'p', moduleId: 'm' }).route('/data/x.json', () => 1), (e) => e instanceof ModuleRefused && e.code === 'MODULE_ROUTE_REFUSED');
    assert.throws(() => hostFor({ uses: ['route'], packId: 'p', moduleId: 'm' }).route('/mod/p/x.json', () => 1, { cache: 'public' }), (e) => e instanceof ModuleRefused && e.code === 'MODULE_ROUTE_REFUSED');
    // `metrics` 同一条：没声明一碰就抛。
    assert.throws(() => hostFor({ uses: ['boot'], packId: 'p', moduleId: 'm' }).metrics(), (e) => e instanceof ModuleRefused && e.code === 'MODULE_USE_UNDECLARED');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('§28.30 transport：声明式配置 → 生效值', () => {
  // 0.2.6 进场（上游 WS_DEFLATE）：**缺省改了** —— 从前「没有声明 ⇒ perMessageDeflate: false」，现在是引擎自己的
  // WS_DEFLATE（1 KB 起、2 KB 窗口、不保留上下文）。包声明仍然是唯一的声明式入口，只是没人声明时引擎自己开。
  test('没有声明 ⇒ 引擎的 WS_DEFLATE；多包声明按包 id 小的赢；生效值如实报', () => {
    const off = transportPolicy(new Map(), { log: quiet });
    assert.equal(off.perMessageDeflate.threshold, 1024);
    assert.equal(off.perMessageDeflate.serverNoContextTakeover, true);
    assert.equal(off.perMessageDeflate.serverMaxWindowBits, 11);
    assert.equal(off.perMessageDeflate.zlibDeflateOptions.memLevel, 7);
    assert.deepEqual(off.transport, { deflate: true, params: null, maxPayload: WS_MAX_PAYLOAD, threshold: 1024 });

    const said = [];
    const b = new Map([['b-pack', { deflate: true }], ['a-pack', { deflate: true, threshold: 512, level: 6 }]]);
    const on = transportPolicy(b, { log: { info: (m) => said.push(m), warn: (m) => said.push(m) } });
    assert.equal(on.transport.deflate, true);
    assert.equal(on.transport.threshold, 512);
    assert.equal(on.perMessageDeflate.threshold, 512);
    assert.equal(on.perMessageDeflate.zlibDeflateOptions.level, 6);
    assert.match(on.transport.params, /threshold=512/);
    assert.ok(said.some((m) => /"b-pack".*ignored/.test(m)), '被盖住的那一包必须点名');

    // 声明 `deflate: false` 时报的就是 false（**不是**把声明值当成生效值）。
    const offDecl = transportPolicy(new Map([['a', { deflate: false, threshold: 512 }]]), { log: quiet });
    assert.equal(offDecl.perMessageDeflate, false);
    assert.deepEqual(offDecl.transport, { deflate: false, params: null, maxPayload: WS_MAX_PAYLOAD, threshold: null });
  });

  test('形状层：deflate 必填、字段闭集、区间把得住', () => {
    const base = (extra) => ({ id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x', server: { transport: extra } });
    const norm = (extra) => normalizePackManifest(base(extra), 'p', { hasAssets: false });
    assert.equal(norm({ deflate: true, threshold: 512 }).ok, true);
    assert.equal(norm({ threshold: 512 }).error, 'TRANSPORT_BAD_DEFLATE');
    assert.equal(norm({ deflate: true, nope: 1 }).error, 'TRANSPORT_UNKNOWN_FIELD');
    assert.equal(norm({ deflate: true, level: 10 }).error, 'TRANSPORT_BAD_VALUE');
    assert.equal(norm({ deflate: true, threshold: -1 }).error, 'TRANSPORT_BAD_VALUE');
    assert.equal(norm({ deflate: 'yes' }).error, 'TRANSPORT_BAD_DEFLATE');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('§28.33 CDN 语音素材：https only + sha256 核对 + 失败点名', () => {
  const CDN = (over = {}) => ({ url: 'https://cdn.example.com/a.mp3', sha256: sha256('AUDIO'), file: 'voice/c1/place_1.mp3', ...over });
  // `hasAssets` 是**装载器**才知道的事实（这个包有没有 assets/ 文件夹）：CDN 条目**不需要**它，包内路径需要。
  const norm = (extra, hasAssets = false) => normalizePackManifest({ id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x', ...extra }, 'p', { hasAssets });

  test('形状层：合法条目进 `voiceCdn`；协议 / 摘要 / 扩展名 / 授权各自点名', () => {
    const ok = norm({ voices: { c1: { place: [CDN()] } } });
    assert.equal(ok.ok, true, ok.ok ? '' : `${ok.error} — ${ok.detail}`);
    assert.equal(ok.pack.voiceCdn.length, 1);
    assert.equal(ok.pack.voiceCdn[0].file, 'voice/c1/place_1.mp3');
    assert.deepEqual(ok.pack.voices, { c1: { place: ['voice/c1/place_1.mp3'] } }, '文件位置进同一张表 ⇒ 播放侧一个字节都不用改');

    assert.equal(norm({ voices: { c1: { place: [CDN({ url: 'http://cdn.example.com/a.mp3' })] } } }).error, 'VOICE_CDN_BAD_URL');
    assert.equal(norm({ voices: { c1: { place: [CDN({ url: 'https://u:p@cdn.example.com/a.mp3' })] } } }).error, 'VOICE_CDN_BAD_URL');
    assert.equal(norm({ voices: { c1: { place: [CDN({ sha256: 'ABC' })] } } }).error, 'VOICE_CDN_BAD_DIGEST');
    assert.equal(norm({ voices: { c1: { place: [CDN({ file: 'voice/a.txt' })] } } }).error, 'VOICE_CDN_BAD_FILE');
    assert.equal(norm({ voices: { c1: { place: [CDN({ nope: 1 })] } } }).error, 'VOICE_CDN_UNKNOWN_FIELD');
    assert.equal(norm({ license: undefined, voices: { c1: { place: [CDN()] } } }).error, 'VOICE_CDN_NEEDS_LICENSE');
    // 一条 CDN 条目都没有 ⇒ 归一化结果里没有 `voiceCdn` 这个键（老包哈希逐字节不变）。
    // 包内路径的那一档仍然是「必须放进 assets/ 文件夹」—— 这条既有规则一字未动。
    assert.equal('voiceCdn' in norm({ voices: { c1: { place: ['voice/a.mp3'] } } }, true).pack, false);
    assert.equal(norm({ voices: { c1: { place: ['voice/a.mp3'] } } }, false).error, 'VOICE_NEEDS_ASSETS');
    assert.ok(VOICE_CDN_AUDIO_EXTS.includes('.mp3'));
  });

  test('取回来要过 sha256：对得上才落盘；对不上 / 取不到 ⇒ 逐条点名且不进覆盖表', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-voicecdn-'));
    try {
      const body = Buffer.from('AUDIO');
      const good = { deflate: undefined, id: 'p', voiceCdn: [{ lang: null, charId: 'c1', slot: 'place', file: 'voice/a.mp3', url: 'https://cdn.example.com/a.mp3', sha256: sha256(body) }] };
      const bad = { id: 'q', voiceCdn: [{ lang: null, charId: 'c1', slot: 'place', file: 'voice/b.mp3', url: 'https://cdn.example.com/b.mp3', sha256: sha256('OTHER') }] };
      const gone = { id: 'r', voiceCdn: [{ lang: null, charId: 'c1', slot: 'place', file: 'voice/c.mp3', url: 'https://cdn.example.com/c.mp3', sha256: sha256('X') }] };
      let calls = 0;
      const fetchImpl = async (url) => {
        calls++;
        if (url.endsWith('c.mp3')) return { ok: false, status: 404, statusText: 'Not Found' };
        return { ok: true, status: 200, arrayBuffer: async () => body };
      };
      const said = [];
      const log = { warn: (m) => said.push(m), info: (m) => said.push(m) };
      const res = await materializeVoiceCdn([good, bad, gone], { stateRoot: tmp, log, fetchImpl });
      assert.deepEqual([...res.overrides.keys()], ['p/voice/a.mp3']);
      assert.equal(fs.readFileSync(voiceCdnCachePath(tmp, sha256(body)), 'utf8'), 'AUDIO');
      assert.equal(fs.existsSync(voiceCdnCachePath(tmp, sha256('OTHER'))), false, '摘要对不上：一个字节都不许落盘');
      const codes = res.errors.map((e) => e.code).sort();
      assert.deepEqual(codes, ['VOICE_CDN_DIGEST_MISMATCH', 'VOICE_CDN_FETCH_FAILED']);
      assert.equal(res.failed.size, 2);
      assert.ok(said.some((m) => /VOICE_CDN_DIGEST_MISMATCH/.test(m)) && said.some((m) => /VOICE_CDN_FETCH_FAILED/.test(m)), '每一条失败都要点名');
      // 缓存命中不再联网（第二次调用 calls 不增加）。
      const before = calls;
      await materializeVoiceCdn([good], { stateRoot: tmp, log: quiet, fetchImpl });
      assert.equal(calls, before);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('取不到的台词从语音表里摘掉（回落默认配音，而不是留一条永远 404 的静音）', () => {
    const packs = [{ id: 'p', voices: { c1: { place: ['voice/a.mp3', 'voice/b.mp3'] } }, voiceLangs: { jp: { c1: { place: ['voice/a.mp3'] } } }, voiceCdn: [{ lang: null, charId: 'c1', slot: 'place', file: 'voice/b.mp3', url: 'https://x/b.mp3', sha256: sha256('B') }] }];
    const out = dropFailedVoiceCdnFiles(packs, new Set(['p\u0000voice/b.mp3']));
    assert.deepEqual(out[0].voices, { c1: { place: ['voice/a.mp3'] } });
    assert.deepEqual(out[0].voiceLangs.jp, { c1: { place: ['voice/a.mp3'] } });
    assert.deepEqual(out[0].voiceCdn, []);
    // 全摘掉的语种整档消失（与 VOICE_LANG_EMPTY 同一条语义）。
    const all = dropFailedVoiceCdnFiles([{ id: 'p', voices: {}, voiceLangs: { jp: { c1: { place: ['voice/a.mp3'] } } }, voiceCdn: [{ file: 'voice/a.mp3' }] }], new Set(['p\u0000voice/a.mp3']));
    assert.deepEqual(all[0].voiceLangs, {});
    assert.equal(packs[0].voices.c1.place.length, 2, '原对象一个字节不动');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('面板数据口：上限与名单不可能再悄悄错开（bug 修复，§28.8）', () => {
  test('上限就是「全部」，14 张全声明被接受', () => {
    assert.equal(CLIENT_MAX_PANEL_DATA_TABLES, CLIENT_PANEL_DATA_TABLES.length);
    const r = normalizePackManifest({
      id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x',
      client: { panels: [{ id: 'x', slot: 'root.overlays', module: 'ui/x.js', data: [...CLIENT_PANEL_DATA_TABLES] }] },
    }, 'p', { hasAssets: false });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
    assert.equal(r.pack.client.panels[0].data.length, CLIENT_MAX_PANEL_DATA_TABLES);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('真服务器：route / healthz / welcome.transport 接起来', () => {
  let tmp;
  let srv;
  const clients = [];
  const saved = process.env.SP_STATE_DIR;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-srvsurface-'));
    process.env.SP_STATE_DIR = path.join(tmp, 'var');
    const dir = path.join(tmp, 'ws', 'ops-pack');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'ops-pack', name: 'Ops', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      server: { modules: [{ id: 'ops', entry: 'server/ops.mjs', uses: ['boot', 'healthz', 'metrics', 'route'] }], transport: { deflate: true, threshold: 512 } },
    }));
    fs.writeFileSync(path.join(dir, 'server', 'ops.mjs'), [
      'let boots = 0;',
      'export function registerServer(host) {',
      '  host.onBoot((cfg) => { boots += 1; host.log.info("booted", cfg.port > 0, Object.isFrozen(cfg)); });',
      '  host.healthz(() => ({ boots, rss: host.metrics().rss }));',
      '  host.route("/mod/ops-pack/stats.json", () => ({ boots, metric: HOST_FIELDS }));',
      `}`,
      '',
    ].join('\n').replace('HOST_FIELDS', JSON.stringify(HOST_METRICS_FIELDS)));
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: path.join(tmp, 'ws') });
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch { /* already closed */ } }
    if (srv) await srv.close();
    if (saved === undefined) delete process.env.SP_STATE_DIR; else process.env.SP_STATE_DIR = saved;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('动态端点：GET 200 JSON + no-store；POST 405；未声明的 /mod 路径 404', async () => {
    const res = await fetch(`${srv.url}/mod/ops-pack/stats.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store', '动态端点默认 no-store（没有 public）');
    const body = await res.json();
    assert.equal(body.boots, 1, 'onBoot 已经跑过（端口绑好之后）');
    assert.deepEqual(body.metric, [...HOST_METRICS_FIELDS], '`host.metrics()` 在真服务器里可用');
    const post = await fetch(`${srv.url}/mod/ops-pack/stats.json`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal((await fetch(`${srv.url}/mod/ops-pack/nope.json`)).status, 404, '只有逐字声明的路径被回答');
  });

  test('`/healthz`：`ok` 恒 true、恒 200、包的字段照旧在 `modHealth` 里', async () => {
    const res = await fetch(`${srv.url}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.modHealth['ops-pack'].boots, 1);
    assert.equal(typeof body.modHealth['ops-pack'].rss, 'number');
  });

  test('`welcome.transport` 真的落了字段，而且报的是生效值', async () => {
    const c = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
    clients.push(c);
    const welcome = await c.hello('Ops');
    assert.ok(welcome.transport, 'welcome 上必须有 transport（客户端那格靠它，缺了就只能是 null）');
    assert.deepEqual(welcome.transport, { deflate: true, params: 'threshold=512', maxPayload: WS_MAX_PAYLOAD, threshold: 512 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** 最小的 `moduleHost` 工厂（直接测宿主对象，不起服务器）。 */
async function harness() {
  const { moduleHost } = await import('../server/modModules.js');
  const registered = [];
  return {
    registered,
    hostFor: ({ uses, packId, moduleId }) => moduleHost({
      packId, moduleId, hash: 'h', dir: '/tmp', uses, write: false, stateRoot: '/tmp',
      log: quiet, registry: Object.assign(() => true, { route: (e) => { registered.push(e); return true; } }),
    }),
  };
}
