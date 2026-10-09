// test/modAssets.test.js — `assets` 声明的**服务端行为**（B3a 段：DESIGN §28.13.3/§28.13.4，
// docs/WORKSHOP.md §1.9.4）。A 段只认下声明（形状层，`test/packAssets.test.js` 钉住），本刀把服务端那一半落地：
//
//   容器与清单 —— `assets.container`（包内 `.spresources`）与 `assets.manifest`（包内 `.json`）在
//                `/workshop-resources/<pack>/<声明路径>` 上被服务。纪律照 B2 的模块路由：**只有装载器注册过的 URL**
//                会被回答，未注册 / 目录穿越 / 不在声明里 ⇒ 404；`?v=<hash12>` 是缓存键。容器可达数百 MB，所以它
//                **流式**出去（`fs.createReadStream` + `pipeline`），绝不整读进内存。
//   `serverPolicy` —— `serve`（缺省）= 今天的服务器行为一个字节不变；`cache-only` = `/assets/` 与 `/fonts/` 回
//                **412 且不回源**，而且**只在包显式声明时**生效。它是部署语义（那两棵树是全服务器共用的），所以是
//                进程级的，启动日志里点名是哪个包声明的。
//   `verify`    —— 按声明校验容器（旁挂 `<container>.sha256`，`sha256` 是缺省算法）。校验失败**明示**：整包被拒，
//                理由里点名 `ASSETS_VERIFY_FAILED`（摘要对不上）或 `ASSETS_VERIFY_UNAVAILABLE`（声明了校验却没有
//                摘要文件）—— 绝不静默放行。
//
// 外加 B1 留下的口子（本刀补齐并对齐）：`server.preDispatch` 以前只拒那个钩子、包照旧加载，现在与 `client` /
// `assets` 同一口径 —— **声明了却不可用 ⇒ 拒绝整个包**（DESIGN §28.13.3）。
//
// Run: node --test test/modAssets.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { WORKSHOP_RESOURCE_PREFIX, ASSETS_FILE_CODES } from '../shared/workshop.js';
import { loadWorkshop, assetsIssues, preDispatchIssues, sha256FileSync } from '../server/workshop.js';
import { workshopResourceFilesFor, isCacheOnlyPath, resourceServerPolicy } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** `docs/examples/` 是仓库里既有的**真实**工坊根（三份示例包，一份都没声明 `assets`）：不变量对照的基线。 */
const EXAMPLES = join(ROOT, 'docs/examples');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const CONT = 'packs/resources-0.1.0.spresources';
const MANIFEST = 'resource-manifest.json';
/** 容器的字节：不解析内容（服务端只把它当字节流），但让它是**一段可辨认的**东西，便于断言 200 的 body。 */
const CONT_BYTES = Buffer.concat([
  Buffer.from('SPRES001', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('{"format":"sp-resource-pack","version":1}', 'utf8'),
  Buffer.alloc(300 * 1024, 0x5a), // 300 KiB：够大到「整读进内存」这件事会在下面被看见
]);
const MANIFEST_BODY = JSON.stringify({ format: 1, version: 'deadbeefcafe', files: [
  { url: '/assets/demo-0.bin', size: 2048, hash: '26ad4b31297b', tier: 2 },
] });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SIDECAR = `${sha(CONT_BYTES)}  resources-0.1.0.spresources\n`;
const CONT_SHA = sha(CONT_BYTES);

/** 一个合法的准入钩子（对齐后它只是「合法」的那一半，用来证明好声明照旧生效）。 */
const HOOK_SOURCE = `export function createPreDispatch() { return { preDispatch() { return false; } }; }\n`;

let tmp;
let wsRoot;

/**
 * 写一个工坊包：`pack.json` + `extra` 里的文件。`assets: false` 表示不声明。
 * @returns {string} 包的目录
 */
function writePack(root, id, { assets = null, server = null, routes = null, content = null, extra = {} } = {}) {
  const dir = join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const decl = {};
  if (assets) decl.assets = assets;
  if (server) decl.server = server;
  if (routes) decl.routes = routes;
  const pack = { id, version: '0.1.0', license: 'CC0-1.0', ...(content ? { content } : {}), ...decl };
  fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify(pack));
  for (const [rel, body] of Object.entries(extra)) {
    const abs = join(dir, ...rel.split('/'));
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const DECL = { container: CONT, manifest: MANIFEST };
const BASE_FILES = { [CONT]: CONT_BYTES, [`${CONT}.sha256`]: SIDECAR, [MANIFEST]: MANIFEST_BODY };

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modassets-'));
  wsRoot = join(tmp, 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });
  // `resource-pack`：`serve`（缺省值写出来）—— 容器与清单都可取
  writePack(wsRoot, 'resource-pack', { assets: DECL, extra: BASE_FILES });
  // `cache-pack`：同一个声明 + `cache-only`
  writePack(wsRoot, 'cache-pack', { assets: { ...DECL, serverPolicy: 'cache-only' }, extra: BASE_FILES });
  // `serve-explicit`：显式 `serve`（对照组：声明了 `assets` 但不要求 412）
  writePack(wsRoot, 'serve-explicit', { assets: { ...DECL, serverPolicy: 'serve' }, extra: BASE_FILES });
  // 不声明 `assets` 的普通数据包（对照组的另一半）
  writePack(wsRoot, 'plain-pack', { content: ['chess'], extra: { 'chess.json': JSON.stringify({ chess_ws_plain_a: { chessId: 'chess_ws_plain_a', name: 'p' } }) } });
  // 坏摘要：旁挂写的是另一份文件的摘要
  writePack(wsRoot, 'bad-digest', { assets: { container: 'c.spresources', manifest: 'm.json' }, extra: { 'c.spresources': CONT_BYTES, 'c.spresources.sha256': `${sha(Buffer.from('other'))}  c.spresources\n`, 'm.json': MANIFEST_BODY } });
  // 声明了校验却没有摘要文件
  writePack(wsRoot, 'no-sidecar', { assets: { container: 'c.spresources', manifest: 'm.json' }, extra: { 'c.spresources': CONT_BYTES, 'm.json': MANIFEST_BODY } });
  // 容器文件不在包里
  writePack(wsRoot, 'no-container', { assets: { container: 'gone.spresources', manifest: 'm.json' }, extra: { 'm.json': MANIFEST_BODY } });
  // 清单文件不在包里
  writePack(wsRoot, 'no-manifest', { assets: { container: 'c.spresources', manifest: 'gone.json' }, extra: { 'c.spresources': CONT_BYTES, 'c.spresources.sha256': SIDECAR } });
  // `server.preDispatch` 的对齐用例：文件不在 ⇒ 整包被拒（B1 以前只是「钩子被拒」）
  writePack(wsRoot, 'hook-missing-module', { server: { preDispatch: { module: 'server/gone.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'p.json': '{}' } });
  writePack(wsRoot, 'hook-missing-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'gone.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE } });
  writePack(wsRoot, 'hook-bad-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '[1,2,3]' } });
  writePack(wsRoot, 'hook-unknown-type', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['match.queue'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
  // 好声明（对照组）+ 一个既声明 assets 又声明 hooks 的包（两组闸门互不干扰）
  writePack(wsRoot, 'hook-ok', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{"version":"v1"}' } });
});

after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------
// 1. 不变量：不声明 `assets` ⇒ 服务器行为逐字节不变
// ---------------------------------------------------------------------------------------------------
describe('不声明 assets：没有新路由、没有新头、没有新分支', () => {
  test('真实夹具（docs/examples 三份示例包）装载后没有任何资源表，也没有 412 策略', () => {
    const loaded = loadWorkshop(EXAMPLES, { log: quiet });
    assert.deepEqual(loaded.errors, [], '三份示例包必须都加载成功');
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), ['clementia', 'demo-workshop', 'kit-demo']);
    for (const p of loaded.packs) {
      assert.equal('assets' in p, false, `${p.id}: 没声明就不该有 assets 键`);
      assert.equal('assetsDigest' in p, false, `${p.id}: 没声明就不该有容器摘要`);
    }
    assert.equal(workshopResourceFilesFor(loaded.packs, EXAMPLES).size, 0);
    assert.equal(resourceServerPolicy(new Map(), { log: quiet }), 'serve');
  });

  test('真服务器：`/workshop-resources/` 一个字节都不服务（404），`/assets` 也不回 412', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    try {
      for (const p of [
        WORKSHOP_RESOURCE_PREFIX,
        `${WORKSHOP_RESOURCE_PREFIX}clementia/`,
        `${WORKSHOP_RESOURCE_PREFIX}clementia/packs/x.spresources`,
        `${WORKSHOP_RESOURCE_PREFIX}demo-workshop/resource-manifest.json`,
      ]) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
      // 没有包声明 `cache-only` ⇒ `/assets/` 的行为与 B2 之后完全相同（本机通常没有 public/assets/<name>，
      // 所以这里断言的是**不是 412**：412 只可能由本刀的开关产生，缺文件是 404）。
      const miss = await fetch(`${srv.url}/assets/definitely-not-here-${Date.now()}.png`);
      assert.notEqual(miss.status, 412, '/assets 不得因为本刀变成 412');
      assert.equal((await fetch(`${srv.url}/fonts/definitely-not-here.css`)).status === 412, false);
    } finally {
      await srv.close();
    }
  });

  test('不声明 `assets` 的包：`loadWorkshop` 的结果里一个字段都不多（与 `plain-pack` 对照）', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const plain = loaded.packs.find((p) => p.id === 'plain-pack');
    assert.ok(plain);
    assert.equal('assets' in plain, false);
    assert.equal('assetsDigest' in plain, false);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 容器与清单：注册 URL 可服务、`?v=` 生效、穿越 / 未注册 ⇒ 404、大文件不整读
// ---------------------------------------------------------------------------------------------------
describe('容器与清单的服务（包作用域路由，照 B2 的纪律）', () => {
  test('服务表：只有声明过的那两个 URL，键是**不带查询串**的路径，且容器带装载期算出的摘要', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const digests = new Map(loaded.packs.filter((p) => p.assetsDigest).map((p) => [p.id, p.assetsDigest]));
    const files = workshopResourceFilesFor(loaded.packs, wsRoot, { digests });
    // 五个声明了 assets 且容器摘要正确的包（resource-pack / cache-pack / serve-explicit 各两个 URL）
    for (const id of ['resource-pack', 'cache-pack', 'serve-explicit']) {
      const cont = files.get(`${WORKSHOP_RESOURCE_PREFIX}${id}/${CONT}`);
      const man = files.get(`${WORKSHOP_RESOURCE_PREFIX}${id}/${MANIFEST}`);
      assert.ok(cont, `${id}: 容器必须注册`);
      assert.ok(man, `${id}: 清单必须注册`);
      assert.equal(cont.kind, 'container');
      assert.equal(man.kind, 'manifest');
      assert.equal(cont.sha256, CONT_SHA, '容器条目的摘要是装载期校验过的那个（不重算）');
      assert.equal(man.sha256, null, '清单没有整包摘要');
      assert.equal(cont.url, `${WORKSHOP_RESOURCE_PREFIX}${id}/${CONT}?v=${loaded.packs.find((p) => p.id === id).hash.slice(0, 12)}`);
    }
    // 未声明的路径不进表：`pack.json`、`kits/…`、`assets/…`、别的包的文件
    for (const url of [
      `${WORKSHOP_RESOURCE_PREFIX}plain-pack/${CONT}`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/pack.json`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/${CONT}.sha256`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/assets/x.png`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/../plain-pack/pack.json`,
    ]) {
      assert.equal(files.has(url), false, url);
    }
    assert.equal(workshopResourceFilesFor(loaded.packs, null).size, 0, '关掉工坊就是空表');
    assert.equal(workshopResourceFilesFor(null, wsRoot).size, 0);
  });

  test('真 HTTP：容器与清单都 200，`?v=` 只是缓存键（带与不带同一个 body）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const base = `${srv.url}${WORKSHOP_RESOURCE_PREFIX}resource-pack`;
      const cont = await fetch(`${base}/${CONT}?v=abcdef123456`);
      assert.equal(cont.status, 200);
      assert.equal(cont.headers.get('content-type'), 'application/octet-stream');
      assert.equal(cont.headers.get('cache-control'), 'no-cache');
      assert.equal(cont.headers.get('x-sp-resource-sha256'), CONT_SHA, 'HTTP 头带的就是装载期校验过的摘要');
      assert.equal(Number(cont.headers.get('content-length')), CONT_BYTES.length);
      assert.deepEqual(Buffer.from(await cont.arrayBuffer()), CONT_BYTES, '字节逐字节相同');
      // 不带 `?v=` 也拿同一份（`?v=` 是缓存键，不是路由的一部分）
      const bare = await fetch(`${base}/${CONT}`);
      assert.equal(bare.status, 200);
      assert.deepEqual(Buffer.from(await bare.arrayBuffer()), CONT_BYTES);
      // HEAD：有头、无 body
      const head = await fetch(`${base}/${CONT}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      // 清单：`.json` 的 Content-Type，body 就是文件字节
      const man = await fetch(`${base}/${MANIFEST}?v=abcdef123456`);
      assert.equal(man.status, 200);
      assert.equal(man.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(await man.text(), MANIFEST_BODY);
      assert.equal(man.headers.get('x-sp-resource-sha256'), null, '清单不该带容器摘要头');
    } finally {
      await srv.close();
    }
  });

  test('真 HTTP：未注册 / 穿越 / 摘要文件 / 别的包 / 包清单一律 404', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      for (const p of [
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/pack.json`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/${CONT}.sha256`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/not-declared.json`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/../plain-pack/pack.json`,
        `${WORKSHOP_RESOURCE_PREFIX}plain-pack/${CONT}`,
        `${WORKSHOP_RESOURCE_PREFIX}`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/`,
      ]) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
    } finally {
      await srv.close();
    }
  });

  test('大文件不整读：容器走 `fs.createReadStream`（而不是整读进内存）', async () => {
    const origStream = fs.createReadStream;
    /** @type {string[]} */
    const streamed = [];
    // 真实容器可达数百 MB：一次把整个包读进内存就是这条路由唯一不能犯的错。插桩打在 `fs.createReadStream` 上
    // （`server/http/static.js` 用的是 `import fs from 'node:fs'` 的活绑定），断言容器**确实**经流式送出。
    fs.createReadStream = function patched(...args) { streamed.push(String(args[0])); return origStream.apply(this, args); };
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const url = `${srv.url}${WORKSHOP_RESOURCE_PREFIX}resource-pack/${CONT}`;
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, CONT_BYTES.length);
      assert.deepEqual(body, CONT_BYTES, '流式送出的字节与文件逐字节相同');
      const abs = join(wsRoot, 'resource-pack', CONT);
      // 插桩是全局的（同一进程里别的请求也会调用它），所以只断言**这一个文件**是否出现在流式调用里。
      assert.ok(streamed.includes(abs), `容器必须经 fs.createReadStream 送出（实际：${streamed.join(', ')}）`);
    } finally {
      fs.createReadStream = origStream;
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. `serverPolicy`：`serve` 缺省不变，`cache-only` 只在显式声明时生效
// ---------------------------------------------------------------------------------------------------
describe('serverPolicy：serve（默认）不变，cache-only 只在声明时生效', () => {
  test('`isCacheOnlyPath` 覆盖 `/assets`、`/fonts` 两棵树（含裸挂载），不碰别的', () => {
    for (const p of ['/assets', '/assets/', '/assets/x.png', '/assets/a/b/c.js', '/fonts', '/fonts/x.woff2']) {
      assert.equal(isCacheOnlyPath(p), true, p);
    }
    for (const p of ['/asset', '/assetsx', '/media/bgm/act1', '/data/chess.json', '/workshop-assets/p/a.png', '/', '/workshop-resources/p/x']) {
      assert.equal(isCacheOnlyPath(p), false, p);
    }
  });

  test('求解进程策略：没有任何声明 ⇒ serve；一个 cache-only ⇒ cache-only 并点名是哪个包', () => {
    const seen = [];
    const log = { info: (...a) => seen.push(a[0]), warn() {}, error() {}, debug() {} };
    assert.equal(resourceServerPolicy(new Map([['a', 'serve'], ['b', 'serve']]), { log }), 'serve');
    assert.equal(resourceServerPolicy({ a: 'serve' }), 'serve');
    assert.equal(resourceServerPolicy(null), 'serve');
    assert.deepEqual(seen, [], '全是 serve 时一行日志都不该有');
    assert.equal(resourceServerPolicy(new Map([['a', 'serve'], ['z', 'cache-only'], ['b', 'cache-only']]), { log }), 'cache-only');
    assert.equal(seen.length, 1, '翻成 cache-only 必须有且只有一条启动日志');
    assert.match(seen[0], /cache-only/);
    assert.match(seen[0], /"b", "z"/, '日志点名是哪些包声明的（排序后）');
  });

  test('真服务器：声明 `cache-only` ⇒ `/assets/…` 与 `/fonts/…` 412，且短路在文件系统之前', async () => {
    // 用**本机真的存在**的两份素材做对照（`tools/fetch-assets.mjs` 的产物，git-ignored；本机没有就跳过）：
    // 它们平时是 200，声明 `cache-only` 之后必须变成 412 —— 这是「不回源」最直接的证据：走文件系统就只能是
    // 200 或 404（缺文件），绝不可能是 412。412 只可能由本刀那个分支产生。
    const BGM = '/assets/audio/bgm/m_bat_abyssalhunters_intro.mp3';
    const FONT = '/fonts/bender-regular.woff2';
    const haveBgm = fs.existsSync(join(ROOT, 'public', ...BGM.split('/').filter(Boolean)));
    const haveFont = fs.existsSync(join(ROOT, 'public', ...FONT.split('/').filter(Boolean)));
    assert.ok(haveBgm && haveFont, '本机素材缺失（tools/fetch-assets.mjs 的产物），这份对照跑不了');
    const serveSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    const cacheSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      // 对照组：没有 `cache-only` 时它们是 200（本机真的有这两份文件）
      assert.equal((await fetch(serveSrv.url + BGM, { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(serveSrv.url + FONT, { method: 'HEAD' })).status, 200);
      for (const p of [BGM, FONT, '/assets/x.png', '/assets/', '/assets', '/fonts/x.woff2', '/fonts']) {
        const res = await fetch(cacheSrv.url + p);
        assert.equal(res.status, 412, p);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }
      // 别的路由完全不受影响
      assert.equal((await fetch(`${cacheSrv.url}/data/chess.json`)).status, 200);
      assert.equal((await fetch(`${cacheSrv.url}/healthz`)).status, 200);
    } finally {
      await serveSrv.close();
      await cacheSrv.close();
    }
  });

  test('真服务器：只有显式 `serve` 的包 ⇒ `/assets/…` 不 412（缺文件是 404，不是策略）', async () => {
    const serveOnly = join(tmp, 'ws-serve-only');
    writePack(serveOnly, 'resource-pack', { assets: { ...DECL, serverPolicy: 'serve' }, extra: BASE_FILES });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: serveOnly });
    try {
      const res = await fetch(`${srv.url}/assets/definitely-not-here-${Date.now()}.png`);
      assert.notEqual(res.status, 412);
      assert.equal(res.status, 404);
      assert.equal((await fetch(`${srv.url}/fonts/nope.woff2`)).status !== 412, true);
    } finally {
      await srv.close();
    }
  });

  test('`plain-pack`（不声明 assets）与 `cache-only` 包同时装着：策略是进程级的，日志点名声明者', async () => {
    const ws = join(tmp, 'ws-two');
    writePack(ws, 'a-plain', { content: ['chess'], extra: { 'chess.json': JSON.stringify({ chess_ws_a: { chessId: 'chess_ws_a', name: 'a' } }) } });
    writePack(ws, 'z-cache', { assets: { ...DECL, serverPolicy: 'cache-only' }, extra: BASE_FILES });
    const lines = [];
    const log = { info: (...a) => lines.push(a[0]), warn() {}, error() {}, debug() {} };
    const loaded = loadWorkshop(ws, { log: quiet });
    const policy = resourceServerPolicy(new Map(loaded.packs.filter((p) => p.assets).map((p) => [p.id, p.assets.serverPolicy])), { log });
    assert.equal(policy, 'cache-only');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"z-cache"/);
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws });
    try {
      assert.equal((await fetch(`${srv.url}/assets/x.png`)).status, 412, '一个包声明就够改变整个服务器的 /assets');
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. `verify`：校验失败明示（点名拒绝码），绝不静默放行
// ---------------------------------------------------------------------------------------------------
describe('verify：按声明校验容器，失败点名', () => {
  test('摘要对得上 ⇒ 无 issue，并把摘要交出来（服务面不重算）', () => {
    const dir = join(wsRoot, 'resource-pack');
    const r = assetsIssues({ assets: { ...DECL, serverPolicy: 'serve', verify: 'sha256' } }, dir);
    assert.deepEqual(r.issues, []);
    assert.equal(r.digest, CONT_SHA);
    assert.equal(r.containerAbs, join(dir, CONT));
    assert.equal(r.manifestAbs, join(dir, MANIFEST));
    assert.equal(sha256FileSync(join(dir, CONT)), CONT_SHA, '流式摘要与一次性摘要同值');
  });

  test('摘要对不上 ⇒ `ASSETS_VERIFY_FAILED`（不是静默放行），且带出两个值', () => {
    const dir = join(wsRoot, 'bad-digest');
    const r = assetsIssues({ assets: { container: 'c.spresources', manifest: 'm.json', serverPolicy: 'serve', verify: 'sha256' } }, dir);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].code, ASSETS_FILE_CODES.VERIFY_FAILED);
    assert.match(r.issues[0].reason, /does not match/i);
    assert.match(r.issues[0].reason, new RegExp(CONT_SHA), '理由里要能看出文件真实的摘要');
    assert.equal(r.digest, null, '没通过校验就没有可交出去的摘要');
  });

  test('声明了校验却没有旁挂摘要 ⇒ `ASSETS_VERIFY_UNAVAILABLE`（与「对不上」是两个不同的回答）', () => {
    const r = assetsIssues({ assets: { container: 'c.spresources', manifest: 'm.json', serverPolicy: 'serve', verify: 'sha256' } }, join(wsRoot, 'no-sidecar'));
    assert.equal(r.issues[0].code, ASSETS_FILE_CODES.VERIFY_UNAVAILABLE);
    assert.match(r.issues[0].reason, /c\.spresources\.sha256/);
  });

  test('容器 / 清单不在包里 ⇒ 沿用形状层的两个码（作者看到的是同一个字段名）', () => {
    const noCont = assetsIssues({ assets: { container: 'gone.spresources', manifest: 'm.json', serverPolicy: 'serve', verify: 'sha256' } }, join(wsRoot, 'no-container'));
    assert.equal(noCont.issues[0].code, ASSETS_FILE_CODES.CONTAINER);
    assert.match(noCont.issues[0].reason, /not a readable file/);
    const noMan = assetsIssues({ assets: { container: 'c.spresources', manifest: 'gone.json', serverPolicy: 'serve', verify: 'sha256' } }, join(wsRoot, 'no-manifest'));
    assert.equal(noMan.issues[0].code, ASSETS_FILE_CODES.MANIFEST);
    // 没声明 / 没目录时什么都不判（不猜路径、不凭空报错）
    assert.deepEqual(assetsIssues({}, wsRoot).issues, []);
    assert.deepEqual(assetsIssues({ assets: DECL }, '').issues, []);
  });

  test('装载期：坏摘要的包**不进 `loaded.packs`**，理由里点名拒绝码', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const listed = loaded.packs.map((p) => p.id);
    for (const id of ['resource-pack', 'cache-pack', 'serve-explicit', 'plain-pack']) {
      assert.ok(listed.includes(id), `${id} 应当加载（${listed.join(',')}）`);
    }
    for (const [id, code] of [
      ['bad-digest', ASSETS_FILE_CODES.VERIFY_FAILED],
      ['no-sidecar', ASSETS_FILE_CODES.VERIFY_UNAVAILABLE],
      ['no-container', ASSETS_FILE_CODES.CONTAINER],
      ['no-manifest', ASSETS_FILE_CODES.MANIFEST],
    ]) {
      assert.equal(listed.includes(id), false, `${id} 不得进 loaded.packs`);
      const err = loaded.errors.find((e) => e.pack === id);
      assert.ok(err, `${id}: 必须有具名错误`);
      assert.match(err.reason, new RegExp(`^${code}: `), err.reason);
    }
  });

  test('真服务器：坏摘要的包不存在，它的 URL 也 404（不是 200 + 坏字节）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      assert.equal((await fetch(`${srv.url}${WORKSHOP_RESOURCE_PREFIX}bad-digest/c.spresources`)).status, 404);
      assert.equal((await fetch(`${srv.url}${WORKSHOP_RESOURCE_PREFIX}no-sidecar/c.spresources`)).status, 404);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. `server.preDispatch` 对齐：声明了却不可用 ⇒ 整包被拒（B1 留下的口子）
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch 对齐：不可用 ⇒ 拒绝整个包（与 client / assets 同一口径）', () => {
  test('`preDispatchIssues` 五种坏声明各自具名（与形状层同名）', () => {
    const at = (id, pack) => preDispatchIssues(pack, join(wsRoot, id));
    assert.deepEqual(preDispatchIssues({}, wsRoot), []);
    assert.equal(at('hook-missing-module', { server: { preDispatch: { module: 'server/gone.mjs', policy: 'p.json', intercepts: ['room.create'] } } })[0].code, 'PREDISPATCH_BAD_MODULE');
    assert.equal(at('hook-missing-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'gone.json', intercepts: ['room.create'] } } })[0].code, 'PREDISPATCH_BAD_POLICY');
    assert.equal(at('hook-bad-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } } })[0].code, 'PREDISPATCH_BAD_POLICY');
    assert.match(at('hook-bad-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } } })[0].reason, /must be a JSON object/);
    const unknown = at('hook-unknown-type', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['match.queue'] } } });
    assert.equal(unknown[0].code, 'PREDISPATCH_UNKNOWN_TYPE');
    assert.match(unknown[0].reason, /match\.queue/);
    // 路径逃出包：形状层拒过一次，装载期再拒一次（防御纵深）
    const escape = preDispatchIssues({ server: { preDispatch: { module: '../x.mjs', policy: 'p.json', intercepts: ['room.create'] } } }, join(wsRoot, 'hook-ok'));
    assert.equal(escape[0].code, 'PREDISPATCH_BAD_PATH');
    // 注入一份窄协议：名单里的类型在本服务器不存在
    const narrow = { 'room.join': 1 };
    assert.equal(preDispatchIssues({ server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } } }, join(wsRoot, 'hook-ok'), { c2s: narrow })[0].code, 'PREDISPATCH_UNKNOWN_TYPE');
  });

  test('装载期：四种坏声明让整个包不出现，好声明照旧加载', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const listed = loaded.packs.map((p) => p.id);
    assert.ok(listed.includes('hook-ok'), listed.join(','));
    for (const [id, code] of [
      ['hook-missing-module', 'PREDISPATCH_BAD_MODULE'],
      ['hook-missing-policy', 'PREDISPATCH_BAD_POLICY'],
      ['hook-bad-policy', 'PREDISPATCH_BAD_POLICY'],
      ['hook-unknown-type', 'PREDISPATCH_UNKNOWN_TYPE'],
    ]) {
      assert.equal(listed.includes(id), false, `${id} 不得进 loaded.packs（「加载了但能力没生效」是禁止的结局）`);
      assert.match(loaded.errors.find((e) => e.pack === id).reason, new RegExp(`^${code}: `));
    }
  });

  test('回归：一个只声明 `server.preDispatch` 的好包照旧是合法包（这条纪律不是「拒绝一切」）', async () => {
    const ws = join(tmp, 'ws-hook-only');
    writePack(ws, 'hook-only', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs.map((p) => p.id), ['hook-only']);
    // 真服务器起来之后钩子是真的装上了（不是「包在、钩子没有」）
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws });
    try {
      assert.equal(srv.lobby.welcomeInfo().mods.packs.length, 1);
    } finally {
      await srv.close();
    }
  });

  test('两组闸门互不干扰：一个包同时声明 assets 与 hooks，两边都过才加载', () => {
    const ws = join(tmp, 'ws-both');
    writePack(ws, 'both-ok', { assets: DECL, server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { ...BASE_FILES, 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
    writePack(ws, 'both-bad-hook', { assets: DECL, server: { preDispatch: { module: 'server/gone.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { ...BASE_FILES, 'p.json': '{}' } });
    writePack(ws, 'both-bad-assets', { assets: { container: 'gone.spresources', manifest: MANIFEST }, server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { [MANIFEST]: MANIFEST_BODY, 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['both-ok']);
    assert.equal(loaded.errors.length, 2);
    assert.match(loaded.errors.find((e) => e.pack === 'both-bad-hook').reason, /^PREDISPATCH_BAD_MODULE: /);
    assert.match(loaded.errors.find((e) => e.pack === 'both-bad-assets').reason, /^ASSETS_BAD_CONTAINER: /);
  });
});
