// test/packAssets.test.js — 工坊包 schema 的四组中间层能力声明（DESIGN §28.13，A 段：纯加法地基）。
//
// 为什么需要这四组字段：一个第三方「完整资源包导入 / 校验 / 服务端准入」的 mod 在我们的 A 层**什么都不贡献**，
// 而 `pack.json` 没有地方表达它要的四件事（客户端资源容器、C 层注册点、分发前钩子、只读路由），所以真校验器
// 两边都判它 `EMPTY_PACK`（`_up/mod4-pack/pack/validator-verdict.json`）。缺口、四组字段的形状与理由写在
// `_up/mod4-pack/pack/README.md` §4，本文件是它落成代码后的契约。
//
// 本文件钉住四件事（A 段的全部载重）：
//   1. **默认缺省 = 今天逐字节不变**：不声明这些字段的包，归一化清单里**不得**多出这四个键，`identifyPack` 的
//      内容哈希与 `manifest` 也不得改变。这是本刀最容易做坏的地方 —— 无条件把键写进归一化清单，会让**所有**
//      已存在的包摘要改变，房间的摘要闸门随即误判（DESIGN §28.2）。
//   2. **形状合法就接受，并如实出现在解析结果里**（值按提案归一化：缺省 `serverPolicy: "serve"` /
//      `verify: "sha256"` / `cache: "no-cache"`）。
//   3. **坏形状一律点名拒绝**：断言的是**拒绝码**，不是「失败了就行」—— 一个静默丢弃的声明比一条报错坏得多
//      （作者看到的是「包合法、但什么都没生效」）。
//   4. **声明进了身份哈希**：声明了这些字段的包，内容哈希必须覆盖它们，且这个新哈希会传到 `modSetOf` 的线摘要。
//
// Run: node --test test/packAssets.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  normalizePackManifest, WORKSHOP_CONTENT_FILES,
  ASSETS_SERVER_POLICIES, ASSETS_VERIFY_ALGORITHMS, CLIENT_PANEL_SLOTS, CLIENT_REQUIRES, ROUTE_CACHE_POLICIES,
} from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { MOD_API_VERSION } from '../shared/constants.js';
import { appVersionMatches } from '../shared/packs.js';
import { modSetOf, modDigest, canonicalJson } from '../shared/modIdentity.js';
import { C2S } from '../shared/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** `docs/examples/` 就是仓库里既有的工坊根：一个子目录一个包（clementia / demo-workshop / kit-demo）。 */
const EXAMPLES = join(ROOT, 'docs/examples');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 归一化一份临时的 `pack.json`（目录名与 id 一致，`hasAssets` 由用例自己给）。 */
const norm = (raw, opts = {}) => normalizePackManifest({ id: 'p', ...raw }, 'p', opts);
/** 一份合法的四组声明（每组一份，用来做「声明了 ⇒ 接受并如实出现」与「声明了 ⇒ 摘要变了」的正例）。 */
const VALID = {
  assets: { container: 'packs/resources-0.1.0.spresources', manifest: 'resource-manifest.json' },
  client: {
    panels: [{ id: 'sp-resource-import', slot: 'root.overlays', module: 'resources/preloadModal.js', order: 10, gate: 'session.preloadRequired' }],
    requires: ['serviceWorker', 'cacheStorage', 'webCrypto'],
  },
  server: { preDispatch: { module: 'server/resourceAdmission.mjs', policy: 'admission-files.json', intercepts: ['room.create', 'room.join', 'room.spectate', 'room.start'] } },
  routes: [{ path: '/data/resource-manifest.json', file: 'resource-manifest.json', cache: 'no-cache' }],
};
const GROUP_KEY = { assets: 'assets', client: 'client', server: 'server', routes: 'routes' };
const FOUR_KEYS = ['assets', 'client', 'server', 'routes'];

let tmp;
let wsRoot;
/** 临时工坊根里的包：`base`（无声明）、四个「只声明一组」的包，以及两组不同写法的 assets 包（键序不同）。
 *
 * B3a 段之后「声明了却不可用 ⇒ 拒绝整个包」也覆盖 `assets` 与 `server.preDispatch`（DESIGN §28.13.3），所以这份
 * 夹具里**每一条声明都真的带着它的文件**：容器 + 旁挂 `.sha256` + 清单，或准入模块 + 策略文件。声明与文件之间
 * 的落差本身就是本刀要消掉的那类静默失败，夹具不能再造一个。 */
const CONTAINER = 'packs/resources-0.1.0.spresources';
const ADMISSION_MODULE = 'server/resourceAdmission.mjs';
/** 演示容器：足够小，内容无所谓 —— 装载期只校验「摘要对得上」。 */
const CONTAINER_BYTES = Buffer.from('SPRES001 fake demo container for the loader gate\n', 'utf8');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SIDECAR = `${sha256(CONTAINER_BYTES)}  resources-0.1.0.spresources\n`;
const PACKS = {
  base: { name: 'Base', files: { chess: { chess_ws_base_a: { chessId: 'chess_ws_base_a', name: 'base' } } } },
  onlyAssets: {
    name: 'OnlyAssets',
    assets: VALID.assets,
    extra: { [CONTAINER]: CONTAINER_BYTES, [`${CONTAINER}.sha256`]: SIDECAR, 'resource-manifest.json': '{ "format": 1, "files": [] }' },
  },
  // B2 段：一个声明了面板的包必须**真的带着那个模块**（声明了却不可用的声明拒绝整个包），所以夹具把它写进磁盘
  onlyClient: { name: 'OnlyClient', client: VALID.client, extra: { 'resources/preloadModal.js': 'export function mount() {}\n' } },
  // B3a 段：同理，一个声明了准入钩子的包必须真的带着模块与策略文件
  onlyServer: {
    name: 'OnlyServer',
    server: VALID.server,
    extra: { [ADMISSION_MODULE]: 'export function createPreDispatch() { return { preDispatch() { return false; } }; }\n', 'admission-files.json': '{ "version": "v1", "files": [] }' },
  },
  onlyRoutes: { name: 'OnlyRoutes', routes: VALID.routes },
  assetsA: {
    name: 'AssetsA',
    assets: { container: 'packs/a.spresources', manifest: 'm.json', serverPolicy: 'cache-only', verify: 'sha256' },
    extra: { 'packs/a.spresources': CONTAINER_BYTES, 'packs/a.spresources.sha256': SIDECAR, 'm.json': '{ "format": 1, "files": [] }' },
  },
  assetsB: {
    name: 'AssetsB',
    assets: { verify: 'sha256', serverPolicy: 'cache-only', manifest: 'm.json', container: 'packs/a.spresources' },
    extra: { 'packs/a.spresources': CONTAINER_BYTES, 'packs/a.spresources.sha256': SIDECAR, 'm.json': '{ "format": 1, "files": [] }' },
  },
};

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-packassets-'));
  wsRoot = join(tmp, 'ws');
  for (const [id, pack] of Object.entries(PACKS)) {
    const dir = join(wsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const { name, files, extra, ...decl } = pack;
    const content = Object.keys(files || {});
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id, name, version: '0.1.0', content, ...decl }));
    for (const [file, records] of Object.entries(files || {})) fs.writeFileSync(join(dir, `${file}.json`), JSON.stringify(records));
    for (const [file, body] of Object.entries(extra || {})) {
      fs.mkdirSync(join(dir, dirname(file)), { recursive: true });
      fs.writeFileSync(join(dir, file), body);
    }
  }
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('四组声明: 默认缺省 = 今天逐字节不变（本刀最重要的一条）', () => {
  test('没声明这四组字段的包，归一化结果里**不得**多出这四个键（多一个键就是所有已存在包的摘要一起变）', () => {
    const r = norm({ content: ['chess'] });
    assert.equal(r.ok, true, JSON.stringify(r));
    for (const key of FOUR_KEYS) {
      assert.equal(key in r.pack, false, `归一化清单里不该有 "${key}" —— 无条件写进去会让所有已存在的包哈希改变`);
    }
    // 对照组：声明了就**必须**在（否则第 3 条「进身份哈希」就无从谈起）
    assert.deepEqual(Object.keys(VALID).filter((g) => !(GROUP_KEY[g] in norm({ content: ['chess'], [g]: VALID[g] }).pack)), []);
  });

  test('仓库里三份真实包的 `identifyPack` 哈希与 manifest 逐字节不变（值取自 450e9ea 的装载器实测）', () => {
    // 这三个数字是**基线快照**：本刀之前（450e9ea）用同一份包字节跑出来的 hash。它们只在包目录的内容真的
    // 变了、或哈希算法真的变了时才应当移动 —— 前者由包自己的作者负责，后者是有意为之的设计变更。
    const BASELINE = {
      clementia: '96ebc2d4998c5897b25b6b7dbc0e497f84e7e45c974b68d7eb661f93a28d4e58',
      'demo-workshop': '15092019fd1dbc85589af4b89102746c3a3c0389aef3847d7d9a335bca1a73ef',
      'kit-demo': '77b80c6e74021508d5857208d669da36cc74f20384798a6d5a269fd37f9e4f35',
    };
    const loaded = loadWorkshop(EXAMPLES, { log: quiet });
    assert.deepEqual(loaded.errors, [], '三份示例包必须都加载成功');
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), Object.keys(BASELINE).sort());
    for (const pack of loaded.packs) {
      assert.equal(pack.hash, BASELINE[pack.id], `${pack.id}: 缺省包的内容哈希变了`);
      assert.equal(pack.manifest.some((m) => /^(assets|client|server|routes)$/.test(m.path)), false,
        `${pack.id}: 哈希清单里多出了新声明的条目（缺省包不该有）`);
    }
    // 归一化清单本身也逐字节相同：直接比**那份清单的顶层键集合**，缺一个或多一个都会在这里响
    const demo = loaded.packs.find((p) => p.id === 'demo-workshop');
    for (const key of FOUR_KEYS) assert.equal(key in demo, false, `装载结果 ${key}`);
    const parsedDemo = normalizePackManifest(
      JSON.parse(fs.readFileSync(join(EXAMPLES, 'demo-workshop', 'pack.json'), 'utf8')), 'demo-workshop',
      { hasAssets: fs.existsSync(join(EXAMPLES, 'demo-workshop', 'assets')) });
    assert.equal(parsedDemo.ok, true, JSON.stringify(parsedDemo));
    assert.deepEqual(Object.keys(parsedDemo.pack).sort(), [
      'api', 'art', 'author', 'bondIcons', 'combat', 'content', 'description', 'game', 'gameVersion', 'hasAssets',
      'id', 'itemIcons', 'layer', 'license', 'name', 'operators', 'overrides', 'playtest', 'support', 'version',
      'voiceLangs', 'voices',
    ], '450e9ea 的归一化清单键集合（新字段只在声明过时才出现）');
    // 关键词法不成立：`canonicalJson` 覆盖嵌套键（记录里本来就有 `assets`），所以这里只确认它没多出顶层那四组
    assert.ok(demo.manifest.some((m) => m.path === 'pack.json'));
  });

  test('没有新声明的包也不会因为「EMPTY_PACK 之外的新闸门」被拒：既有判决一字未改', () => {
    // 只带 playtest 的包照旧被拒（既有裁决，`test/playtestDirectToHand.test.js` 有同一断言）
    assert.equal(norm({ content: [], playtest: { directToHand: ['a'] } }).error, 'EMPTY_PACK');
    // 什么都没有照旧被拒
    assert.equal(norm({ content: [] }).error, 'EMPTY_PACK');
    // 空对象 = 没声明：四组里空的那几组不是贡献项（与 `voices: {}` / `art: { chars: {} }` 同一个语义）
    assert.equal(norm({ content: [], routes: [] }).error, 'EMPTY_PACK');
    // 而一组**有内容**的新声明就是贡献项：A 段把提案的语义落死（B 段实现行为时不用再改）
    for (const group of Object.keys(VALID)) {
      const r = norm({ content: [], [group]: VALID[group] });
      assert.equal(r.ok, true, `只声明 ${group} 的包应当合法：${JSON.stringify(r)}`);
      assert.deepEqual(r.pack.content, []);
    }
  });
});

describe('四组声明: 形状合法 ⇒ 接受，并如实出现在解析结果里', () => {
  test('assets：四个字段，缺省 serverPolicy="serve" / verify="sha256"', () => {
    const r = norm({ content: ['chess'], assets: VALID.assets });
    assert.deepEqual(r.pack.assets, {
      container: 'packs/resources-0.1.0.spresources', manifest: 'resource-manifest.json',
      serverPolicy: 'serve', verify: 'sha256',
    });
    // 显式给了就照给（cache-only 是提案里的第二个值）
    assert.equal(norm({ content: ['chess'], assets: { ...VALID.assets, serverPolicy: 'cache-only' } }).pack.assets.serverPolicy, 'cache-only');
    assert.deepEqual(ASSETS_SERVER_POLICIES, ['serve', 'cache-only']);
    assert.deepEqual(ASSETS_VERIFY_ALGORITHMS, ['sha256']);
  });

  test('client：面板按 id 排序、requires 按闭枚举次序归一化（键序是清单字节的一部分）', () => {
    const r = norm({ content: ['chess'], client: VALID.client });
    assert.deepEqual(r.pack.client, {
      panels: [{ id: 'sp-resource-import', slot: 'root.overlays', module: 'resources/preloadModal.js', order: 10, gate: 'session.preloadRequired' }],
      requires: ['serviceWorker', 'cacheStorage', 'webCrypto'],   // 闭枚举的次序，不是书写次序
    });
    assert.deepEqual(CLIENT_PANEL_SLOTS, ['root.overlays', 'root.guide', 'screen.game.aside', 'screen.result.footer']);
    assert.deepEqual(CLIENT_REQUIRES, ['serviceWorker', 'cacheStorage', 'webCrypto']);
    // 可选字段不写就不出现（不然「没声明」与「声明成 undefined」会是两种字节）
    const minimal = norm({ content: ['chess'], client: { panels: [{ id: 'p1', slot: 'root.guide', module: 'a/b.js' }] } });
    assert.deepEqual(minimal.pack.client.panels, [{ id: 'p1', slot: 'root.guide', module: 'a/b.js' }]);
    assert.deepEqual(minimal.pack.client.requires, []);
    // 两个面板按 id 排序，与书写顺序无关
    const two = norm({ content: ['chess'], client: { panels: [{ id: 'zz', slot: 'root.guide', module: 'a.js' }, { id: 'aa', slot: 'root.overlays', module: 'b.js' }] } });
    assert.deepEqual(two.pack.client.panels.map((p) => p.id), ['aa', 'zz']);
  });

  test('server.preDispatch：intercepts 必须是 C2S 里真实存在的类型', () => {
    const r = norm({ content: ['chess'], server: VALID.server });
    assert.deepEqual(r.pack.server, {
      preDispatch: { module: 'server/resourceAdmission.mjs', policy: 'admission-files.json', intercepts: ['room.create', 'room.join', 'room.spectate', 'room.start'] },
    });    // 名单是从协议反推的，不是这里抄的第二份真相
    for (const t of VALID.server.preDispatch.intercepts) assert.ok(Object.hasOwn(C2S, t), `${t} 必须在 C2S 里`);
    // 协议里没有 `match.queue` / `queue.join`（原件写的那两个）—— 它们必须被点名拒绝，而不是被放行
    for (const t of ['match.queue', 'queue.join']) assert.equal(Object.hasOwn(C2S, t), false);
  });

  test('routes：只读、绝对路径、包内 .json、缺省 cache="no-cache"', () => {
    const r = norm({ content: ['chess'], routes: VALID.routes });
    assert.deepEqual(r.pack.routes, [{ path: '/data/resource-manifest.json', file: 'resource-manifest.json', cache: 'no-cache' }]);
    assert.deepEqual(ROUTE_CACHE_POLICIES, ['no-cache', 'no-store', 'public']);
    assert.equal(norm({ content: ['chess'], routes: [{ path: '/a.json', file: 'a.json', cache: 'public' }] }).pack.routes[0].cache, 'public');
  });
});

describe('四组声明: 坏形状 ⇒ 点名拒绝（断言拒绝码）', () => {
  /** [这一组该被拒的写法, 期望的拒绝码, 说明]。每条都同时断言 ok === false。 */
  const CASES = [
    // assets —— 形状 / 未知键 / 非法值 / 容器与清单的扩展名
    ['assets', { assets: [] }, 'ASSETS_DECL_BAD_SHAPE', '不是对象'],
    ['assets', { assets: 'packs/x.spresources' }, 'ASSETS_DECL_BAD_SHAPE', '是字符串'],
    ['assets', { assets: { ...VALID.assets, containers: 'x.spresources' } }, 'ASSETS_UNKNOWN_FIELD', '键名拼错（containers）'],
    ['assets', { assets: { manifest: 'm.json' } }, 'ASSETS_BAD_CONTAINER', '缺 container'],
    ['assets', { assets: { container: '/abs/x.spresources', manifest: 'm.json' } }, 'ASSETS_BAD_CONTAINER', '绝对路径'],
    ['assets', { assets: { container: '../x.spresources', manifest: 'm.json' } }, 'ASSETS_BAD_CONTAINER', '路径穿越'],
    ['assets', { assets: { container: 'packs/x.zip', manifest: 'm.json' } }, 'ASSETS_BAD_CONTAINER', '不是 .spresources'],
    ['assets', { assets: { container: 'packs/x.spresources' } }, 'ASSETS_BAD_MANIFEST', '缺 manifest'],
    ['assets', { assets: { container: 'packs/x.spresources', manifest: 'm.js' } }, 'ASSETS_BAD_MANIFEST', '清单不是 .json'],
    ['assets', { assets: { ...VALID.assets, serverPolicy: 'preload' } }, 'ASSETS_BAD_SERVER_POLICY', '非法枚举值'],
    ['assets', { assets: { ...VALID.assets, verify: 'md5' } }, 'ASSETS_BAD_VERIFY', '非法算法'],
    // client —— 面板字段 / 闭枚举 slot / module 形状 / order / requires
    ['client', { client: [] }, 'CLIENT_DECL_BAD_SHAPE', '不是对象'],
    ['client', { client: { panels: [], requires: [] } }, 'CLIENT_BAD_PANELS', '空面板数组'],
    ['client', { client: { panels: 'x' } }, 'CLIENT_BAD_PANELS', 'panels 不是数组'],
    ['client', { client: { panels: ['x'] } }, 'CLIENT_BAD_PANEL', '面板不是对象'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'a.js', mount: 'x' }] } }, 'CLIENT_PANEL_UNKNOWN_FIELD', '未知面板字段'],
    ['client', { client: { panels: [{ slot: 'root.overlays', module: 'a.js' }] } }, 'CLIENT_BAD_PANEL_ID', '缺 id'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'a.js' }, { id: 'p', slot: 'root.guide', module: 'b.js' }] } }, 'CLIENT_PANEL_DUPLICATE_ID', '同一个 id 两个面板'],
    ['client', { client: { panels: [{ id: 'p', slot: 'overlays', module: 'a.js' }] } }, 'CLIENT_BAD_PANEL_SLOT', 'slot 不在闭枚举里'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: '/abs/a.js' }] } }, 'CLIENT_BAD_PANEL_MODULE', '绝对 module 路径'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'https://cdn/a.js' }] } }, 'CLIENT_BAD_PANEL_MODULE', 'module 是 URL'],
    // B2 段补：这条通道只送代码（服务面 `/workshop-panels/` 只服务 `.js`），所以形状层也要拒非 `.js` ——
    // 否则一个 `module: "x.html"` 的包合法、进哈希，而浏览器永远拿不到它（「包合法、面板不出现」）。
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'x.html' }] } }, 'CLIENT_BAD_PANEL_MODULE', 'module 不是 .js'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: '.hidden.js' }] } }, 'CLIENT_BAD_PANEL_MODULE', '点文件'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'a.js', order: '10' }] } }, 'CLIENT_BAD_PANEL_ORDER', 'order 不是整数'],
    ['client', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'a.js', gate: 3 }] } }, 'CLIENT_BAD_PANEL_GATE', 'gate 不是字符串'],
    ['client', { client: { panels: VALID.client.panels, requires: 'serviceWorker' } }, 'CLIENT_BAD_REQUIRES', 'requires 不是数组'],
    ['client', { client: { panels: VALID.client.panels, requires: ['serviceworker'] } }, 'CLIENT_UNKNOWN_REQUIRE', '能力名不在闭枚举里'],
    // `theme` 曾经落在这里（0.11.0 时它还不是 `client` 的字段），2026-10-10 的业主裁决把它收进了已知字段，
    // 所以「未知键点名」这一条换一个真的未知键来钉 —— 判据本身没变，变的是哪个键属于已知集合。
    ['client', { client: { ...VALID.client, colour: true } }, 'CLIENT_UNKNOWN_FIELD', '未知顶层键'],
    // server.preDispatch —— 未知键 / 路径 / 扩展名 / 拦截类型
    ['server', { server: [] }, 'SERVER_DECL_BAD_SHAPE', '不是对象'],
    ['server', { server: { hooks: {} } }, 'SERVER_UNKNOWN_FIELD', '未知顶层键'],
    ['server', { server: { preDispatch: 'x' } }, 'PREDISPATCH_BAD_SHAPE', '不是对象'],
    ['server', { server: { preDispatch: { ...VALID.server.preDispatch, policy2: 'x' } } }, 'PREDISPATCH_UNKNOWN_FIELD', '未知字段'],
    ['server', { server: { preDispatch: { module: '/abs/a.mjs', policy: 'p.json', intercepts: ['room.create'] } } }, 'PREDISPATCH_BAD_PATH', 'module 绝对路径'],
    ['server', { server: { preDispatch: { module: 'a.mjs', policy: '../p.json', intercepts: ['room.create'] } } }, 'PREDISPATCH_BAD_PATH', 'policy 路径穿越'],
    ['server', { server: { preDispatch: { module: 'a.js', policy: 'p.json', intercepts: ['room.create'] } } }, 'PREDISPATCH_BAD_MODULE', 'module 不是 .mjs'],
    ['server', { server: { preDispatch: { module: 'a.mjs', policy: 'p.js', intercepts: ['room.create'] } } }, 'PREDISPATCH_BAD_POLICY', 'policy 不是 .json'],
    ['server', { server: { preDispatch: { module: 'a.mjs', policy: 'p.json' } } }, 'PREDISPATCH_BAD_INTERCEPTS', '缺 intercepts'],
    ['server', { server: { preDispatch: { module: 'a.mjs', policy: 'p.json', intercepts: [] } } }, 'PREDISPATCH_BAD_INTERCEPTS', '空 intercepts'],
    ['server', { server: { preDispatch: { module: 'a.mjs', policy: 'p.json', intercepts: ['match.queue'] } } }, 'PREDISPATCH_UNKNOWN_TYPE', '协议里没有的类型'],
    ['server', { server: { preDispatch: { module: 'a.mjs', policy: 'p.json', intercepts: [42] } } }, 'PREDISPATCH_UNKNOWN_TYPE', '元素不是字符串'],
    // routes —— 数组形状 / 未知键 / 路径 / 代码与标记 / 缓存
    ['routes', { routes: {} }, 'ROUTES_BAD_SHAPE', '不是数组'],
    ['routes', { routes: ['x'] }, 'ROUTES_BAD_SHAPE', '元素不是对象'],
    ['routes', { routes: [{ path: '/a.json', file: 'a.json', cache: 'public', type: 'GET' }] }, 'ROUTE_UNKNOWN_FIELD', '未知字段'],
    ['routes', { routes: [{ path: 'data/a.json', file: 'a.json' }] }, 'ROUTE_BAD_PATH', '不是绝对路径'],
    ['routes', { routes: [{ path: '/../a.json', file: 'a.json' }] }, 'ROUTE_BAD_PATH', '路径穿越'],
    ['routes', { routes: [{ path: '/a.json', file: 'a.json' }, { path: '/a.json', file: 'b.json' }] }, 'ROUTE_DUPLICATE_PATH', '同一个 path 两条'],
    ['routes', { routes: [{ path: '/a.json', file: '/abs/a.json' }] }, 'ROUTE_BAD_FILE', 'file 绝对路径'],
    ['routes', { routes: [{ path: '/a.json', file: 'a.js' }] }, 'ROUTE_BAD_FILE', 'file 是代码'],
    ['routes', { routes: [{ path: '/a.html', file: 'a.html' }] }, 'ROUTE_BAD_FILE', 'file 是标记'],
    ['routes', { routes: [{ path: '/a.json', file: 'a.json', cache: 'forever' }] }, 'ROUTE_BAD_CACHE', '非法缓存语义'],
  ];

  test('每一组的坏形状都给出**具名**拒绝码', () => {
    for (const [group, extra, code, why] of CASES) {
      const r = norm({ content: ['chess'], ...extra });
      assert.equal(r.ok, false, `${group}/${why}: 必须被拒`);
      assert.equal(r.error, code, `${group}/${why}: 拒绝码应当点名`);
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0, `${group}/${why}: 拒绝要带 detail`);
    }
  });

  test('拒绝码的覆盖面：这份用例表本身不许悄悄缩水（每组至少 3 条）', () => {
    for (const group of Object.keys(VALID)) {
      const n = CASES.filter(([g]) => g === group).length;
      assert.ok(n >= 3, `${group}: 只有 ${n} 条坏形状用例`);
    }
    assert.ok(CASES.length >= 40, `坏形状用例只有 ${CASES.length} 条`);
  });

  test('坏形状的声明不会让包「合法但少了一条能力」：整条清单被拒', () => {
    const r = norm({ content: ['chess'], assets: { container: 'x.zip', manifest: 'm.json' } });
    assert.equal(r.ok, false);
    assert.equal(r.pack, undefined, '拒绝时不得返回半份归一化清单');
  });
});

describe('四组声明: 进身份哈希（DESIGN §28.2 / §28.13）', () => {
  test('声明了这些字段的包：内容哈希确实变了，且是**归一化后**的声明算进去的', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const by = (id) => loaded.packs.find((p) => p.id === id);
    const base = by('base');
    assert.ok(base, loaded.packs.map((p) => p.id).join(','));
    for (const id of ['onlyAssets', 'onlyClient', 'onlyServer', 'onlyRoutes']) {
      const p = by(id);
      assert.ok(p, `${id} 必须加载成功（只声明一组能力也是贡献）`);
      assert.notEqual(p.hash, base.hash, `${id}: 声明必须进内容哈希（同一个摘要下两种行为是不允许的）`);
      assert.ok(p.manifest.some((m) => m.path === 'pack.json'), `${id}: 归一化清单仍进哈希清单`);
    }
    // B2 段：C 层面板的**模块源码**也进哈希清单（DESIGN §28.8）—— 声明能改变客户端行为，模块的字节同样能，
    // 一个不算源码的摘要会让两份不同的面板共用一个身份。
    assert.ok(by('onlyClient').manifest.some((m) => m.path === 'resources/preloadModal.js'),
      'C 层面板的模块源码必须在身份清单里');
    // 键序不影响哈希：两份写法不同（`verify` / `serverPolicy` / `manifest` / `container` 顺序颠倒）、归一化后相同的
    // 声明，必须是同一份字节 —— 这正是 `canonicalJson` 排序键、`pack.json` 条目哈希它的那条链。
    // （两个包的 id/name 不同，所以整包哈希本来就不同；这里比的是**声明那一段的字节**。）
    assert.deepEqual(by('assetsA').assets, by('assetsB').assets);
    assert.equal(canonicalJson(by('assetsA').assets), canonicalJson(by('assetsB').assets),
      '同一个声明两种书写顺序 = 同一份字节');
    // ...而不同的声明必须哈希不同（`cache-only` 与 `serve` 是两种客户端行为）
    assert.notEqual(modDigest([{ id: 'a', hash: by('onlyAssets').hash }]), modDigest([{ id: 'a', hash: base.hash }]));
    // 装载结果带着声明本身（B 段要读的就是这些字段）
    assert.deepEqual(by('onlyRoutes').routes, VALID.routes);
    assert.deepEqual(by('onlyServer').server, VALID.server);
  });

  test('新哈希会传到线摘要：`modSetOf` 的 digest 随声明改变', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const entry = (id) => {
      const p = loaded.packs.find((x) => x.id === id);
      return { id: 'modded', hash: p.hash, layer: p.layer, combat: p.combat, api: p.api };
    };
    const oldSet = modSetOf([entry('base')]);
    const newSet = modSetOf([entry('onlyAssets')]);
    assert.ok(oldSet && newSet);
    assert.notEqual(newSet.digest, oldSet.digest, '客户端回话用的摘要必须跟着内容一起变（换内容 = 换摘要）');
    assert.notEqual(oldSet.packs[0].hash, newSet.packs[0].hash);
    // 同一个包反复装载：摘要稳定（缓存/重启不该让摘要漂移）
    assert.equal(modSetOf([entry('onlyAssets')]).digest, newSet.digest);
  });
});

describe('`MOD_API_VERSION`（DESIGN §28.5 的前置项）', () => {
  test('常量存在，且是「包声明了 api 才比对」的那一边', () => {
    assert.equal(MOD_API_VERSION, 1);
    // 比对用的是三段版本串（`appVersionMatches` 读 `vM.m.p`，**读不出来时算匹配**）—— 这条断言就是把那个兜底
    // 钉住：如果有人把整数直接传进去，`2.x` 也会「匹配」，于是每一份声明都被放行
    assert.equal(appVersionMatches('2.x', 1), true, 'appVersionMatches 读不出三段版本时的兜底是「匹配」');
    assert.equal(appVersionMatches('2.x', `${MOD_API_VERSION}.0.0`), false);
    assert.equal(appVersionMatches('1.x', `${MOD_API_VERSION}.0.0`), true);
    assert.equal(appVersionMatches('>=1 <2', `${MOD_API_VERSION}.0.0`), true);
    assert.equal(appVersionMatches('*', `${MOD_API_VERSION}.0.0`), true);
    assert.equal(appVersionMatches('>=2', `${MOD_API_VERSION}.0.0`), false);
  });

  test('包声明了 api：区间含本 build 就接受，不含就点名拒绝（没声明的包一个字节不受影响）', () => {
    const ok = norm({ content: ['chess'], api: '>=1 <2' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.pack.api, '>=1 <2');
    assert.equal(norm({ content: ['chess'], api: '1.x' }).ok, true);
    // 没声明：api 为 null，且不因为「缺声明」被拒
    assert.equal(norm({ content: ['chess'] }).pack.api, null);
    // 声明了却排除本 build：拒绝，理由里有声明的区间与本 build 的号
    const bad = norm({ content: ['chess'], api: '2.x' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'MOD_API_INCOMPATIBLE');
    assert.match(bad.detail, /2\.x/);
    assert.match(bad.detail, new RegExp(String(MOD_API_VERSION)));
    // 先判语法，再判区间：写坏的区间照旧是 BAD_API_RANGE
    assert.equal(norm({ content: ['chess'], api: 'not a range' }).error, 'BAD_API_RANGE');
    // 一个只声明 api 的包仍然是空包（api 是声明，不是贡献项）
    assert.equal(norm({ content: [], api: '1.x' }).error, 'EMPTY_PACK');
  });
});

describe('四组声明: 边界与既有语义', () => {
  test('四组字段都在 `content` 白名单之外（它们是 pack.json 的字段名，不是可以写进 content 的文件名）', () => {
    for (const k of FOUR_KEYS) assert.equal(WORKSHOP_CONTENT_FILES.includes(k), false, `${k} 不是内容文件`);
  });

  test('声明与 `content` / `overrides` 并存时互不干扰', () => {
    const r = norm({ content: ['chess', 'bonds'], overrides: ['chess:chess_char_1_01_a'], assets: VALID.assets, routes: VALID.routes });
    assert.deepEqual(r.pack.content, ['bonds', 'chess']);
    assert.deepEqual(r.pack.overrides, ['chess:chess_char_1_01_a']);
    assert.ok(r.pack.assets && r.pack.routes);
  });

  test('装载器不会因为一个只带新声明的包报「没有内容文件」', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), Object.keys(PACKS).sort());
  });
});
