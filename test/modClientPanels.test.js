// test/modClientPanels.test.js — C 层注册点：`pack.json.client.panels[]` / `client.requires`
// （DESIGN §28.8 / §28.13.3，docs/WORKSHOP.md §1.9.3）。A 段只认下声明（`test/packAssets.test.js` 钉形状层），
// 本刀把两半落地：
//
//   服务端 —— 声明合法 ⇒ 模块在 `/workshop-panels/<pack>/<module>` 被注册、可服务，清单随 `welcome.modPanels` 到达
//             客户端；声明**不可用**（文件不在 / 不是 `.js` / 逃出包目录）⇒ **整个包被拒**（本刀的纪律裁决，
//             不是「包照旧加载、只是那个面板不出现」）；
//   客户端 —— 按 `slot` 挂到四个宿主、按 `order`（再按包 id、面板 id）决定顺序、按 `gate`（store 点路径）决定
//             什么时候挂；`requires` 缺一项就**明示「浏览器不支持」**；面板拿到的注入面是冻结且极小的
//             （没有 store / net / engine 内部对象）。
//
// 浏览器侧（真的 import 模块、真的渲染）在本机跑不了（没有 Chrome）：那是 `SP_E2E=1` 的路径，与
// `test/ui/kitimports.e2e.test.js` 同一个standing gap（docs/WORKSHOP.md §4.4）。**纯逻辑部分这里全部真跑** ——
// 装载期判据、服务面、welcome 帧、注册点、能力判定、注入面、三处客户端缺口。
//
// Run: node --test test/modClientPanels.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, CLIENT_PANEL_SLOTS, CLIENT_REQUIRES, WORKSHOP_PANEL_PREFIX } from '../shared/workshop.js';
import { loadWorkshop, loadWorkshopPanels, panelModuleIssues } from '../server/workshop.js';
import { workshopPanelFilesFor } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';
import { createStore, initialState, selectRoute, entryGateBlocked } from '../public/js/store.js';
import { Net, RESOURCE_MSG_TYPES } from '../public/js/net.js';
import {
  createPanelRegistry, capabilityIssues, readGate, slotSelector, browserSlotHost,
  MOD_PANEL_SLOTS, MOD_PANEL_PREFIX, MOD_PANEL_REQUIRES,
} from '../public/js/ui/extensions.js';
import { portraitEntry, clearAppearanceLookup, currentAppearanceLookup } from '../public/js/ui/portraitChain.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const EXAMPLES = path.join(ROOT, 'docs/examples');

const PRELOAD_MODULE = 'resources/preloadModal.js';
const CN_MODULE = 'sub/我的 面板.js';
const CN_MODULE_ENCODED = 'sub/%E6%88%91%E7%9A%84%20%E9%9D%A2%E6%9D%BF.js';
const PANEL_JS = 'export function mount(ctx) { return { unmount() {} }; }\n';
/** 一份最小的合法 `chess.json`（给「不声明 client」的对照组用：包不能是空的）。 */
const CHESS = { chess_ws_panel: { chessId: 'chess_ws_panel', name: 'panel' } };
const CHESS_FILES = { 'chess.json': JSON.stringify(CHESS) };

/** 工坊根：两个**只声明 `client`** 的包（`client` 本身即贡献项 ⇒ 不是 EMPTY_PACK），外加两个只用来对身份哈希的包。 */
const PACKS = {
  'panel-pack': {
    pack: {
      license: 'CC0-1.0',
      client: {
        panels: [
          { id: 'sp-resource-import', slot: 'root.overlays', module: PRELOAD_MODULE, order: 10, gate: 'session.preloadRequired' },
          { id: 'aside-note', slot: 'screen.game.aside', module: CN_MODULE },
        ],
        requires: ['cacheStorage'],
      },
    },
    files: { [PRELOAD_MODULE]: PANEL_JS, [CN_MODULE]: PANEL_JS },
  },
  'demo-pack': {
    pack: { license: 'CC0-1.0', client: { panels: [{ id: 'aaa', slot: 'root.guide', module: 'gate.js', order: -5 }] } },
    files: { 'gate.js': PANEL_JS },
  },
  // 同一个 pack.json（不声明 client）+ 一个**没被声明**的 `.js`：不声明就不进哈希，两份必须同摘要
  'undeclared-a': { pack: { license: 'CC0-1.0', name: 'Undeclared', content: ['chess'] }, files: { ...CHESS_FILES, 'resources/extra.js': PANEL_JS } },
  'undeclared-b': { pack: { license: 'CC0-1.0', name: 'Undeclared', content: ['chess'] }, files: { ...CHESS_FILES } },
};

let tmp;
let wsRoot;

/** 一个只放一份 `pack.json`（+ 可选文件）的临时工坊根，返回根目录。同 id 调两次 = 两份同身份的包（不同目录）。 */
function packRoot(id, pack, files = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-panels-root-'));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, version: '0.1.0', ...pack }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return root;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-modpanels-'));
  wsRoot = path.join(tmp, 'ws');
  for (const [id, pack] of Object.entries(PACKS)) {
    const dir = path.join(wsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, version: '0.1.0', ...pack.pack }));
    for (const [rel, body] of Object.entries(pack.files)) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
  }
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------
// 1. 一张表，两个读者：客户端的槽位/能力表与 shared/workshop.js 的闭枚举逐字一致
// ---------------------------------------------------------------------------------------------------
describe('C 层：客户端的表与形状层的闭枚举一致（防止第二个会漂移的真相）', () => {
  test('slot / requires / URL 前缀三处都钉在 shared/workshop.js 上', () => {
    assert.deepEqual(MOD_PANEL_SLOTS, [...CLIENT_PANEL_SLOTS]);
    assert.deepEqual(MOD_PANEL_REQUIRES, [...CLIENT_REQUIRES]);
    assert.equal(MOD_PANEL_PREFIX, WORKSHOP_PANEL_PREFIX);
    assert.equal(MOD_PANEL_PREFIX, '/workshop-panels/');
    assert.equal(slotSelector('root.overlays'), '[data-mod-slot="root.overlays"]');
  });

  test('`module` 必须是 `.js`（B2 段补的形状层判据：A 段只判了「相对、不是 URL」）', () => {
    const norm = (panel) => normalizePackManifest({ id: 'p', client: { panels: [panel] } }, 'p', {});
    for (const [module_, code, why] of [
      ['gate.html', 'CLIENT_BAD_PANEL_MODULE', '标注文件送不出去'],
      ['data.json', 'CLIENT_BAD_PANEL_MODULE', '数据文件不是这条通道的东西'],
      ['/abs/a.js', 'CLIENT_BAD_PANEL_MODULE', '绝对路径'],
      ['https://cdn/a.js', 'CLIENT_BAD_PANEL_MODULE', 'URL'],
      ['../outside.js', 'CLIENT_BAD_PANEL_MODULE', '包外'],
      ['.hidden.js', 'CLIENT_BAD_PANEL_MODULE', '点文件'],
    ]) {
      const r = norm({ id: 'p', slot: 'root.overlays', module: module_ });
      assert.equal(r.ok, false, `${why}: ${module_}`);
      assert.equal(r.error, code, `${why}: ${module_} → ${r.error}`);
    }
    // 正例：`.js` 通过，仍是 A 段的归一化结果（order / gate 缺省就不写进去）
    const ok = norm({ id: 'p1', slot: 'root.guide', module: 'a/b.js' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.pack.client.panels, [{ id: 'p1', slot: 'root.guide', module: 'a/b.js' }]);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 装载期：声明可用 ⇒ 注册；声明不可用 ⇒ 整包被拒（本刀的纪律裁决）
// ---------------------------------------------------------------------------------------------------
describe('C 层装载期：合法声明进包，不可用声明拒整包', () => {
  test('只声明 client 的包是合法包（不是 EMPTY_PACK），层级推导为 C、不改对局结果', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), ['demo-pack', 'panel-pack', 'undeclared-a', 'undeclared-b']);
    const pack = loaded.packs.find((p) => p.id === 'panel-pack');
    assert.deepEqual(pack.client.panels.map((p) => p.id), ['aside-note', 'sp-resource-import'], 'A 段：面板按 id 排序');
    assert.equal(pack.layer, 'C', '§28.8：一个只挂面板的包就是 C 层');
    assert.equal(pack.combat, false, '§28.8：面板改不了对局结果');
    assert.deepEqual(pack.client.requires, ['cacheStorage']);
  });

  test('文件不在 / 不是 `.js` / 逃出包目录 ⇒ 整个包被拒，拒绝码与形状层同名', () => {
    const cases = [
      ['missing', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'gone.js' }] } }, /not a readable file/],
      ['shape-html', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'a.html' }] } }, /CLIENT_BAD_PANEL_MODULE/],
      ['shape-escape', { client: { panels: [{ id: 'p', slot: 'root.overlays', module: '../x.js' }] } }, /CLIENT_BAD_PANEL_MODULE/],
    ];
    for (const [label, pack, pattern] of cases) {
      const root = packRoot(label, { license: 'CC0-1.0', ...pack });
      const loaded = loadWorkshop(root, { log: quiet });
      assert.equal(loaded.packs.length, 0, `${label}: 整包被拒（不是「加载了但面板不出现」）`);
      assert.equal(loaded.errors.length, 1, `${label}: ${JSON.stringify(loaded.errors)}`);
      assert.match(loaded.errors[0].reason, pattern, label);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('`panelModuleIssues` 是那一条纪律的判定函数（逐面板点名）', () => {
    const root = packRoot('issues', { license: 'CC0-1.0' }, { 'ok.js': PANEL_JS });
    const dir = path.join(root, 'issues');
    const pack = { client: { panels: [
      { id: 'fine', module: 'ok.js' },
      { id: 'gone', module: 'nope.js' },
      { id: 'code', module: 'x.js' },
      { id: 'up', module: '../escape.js' },
    ] } };
    const issues = panelModuleIssues(pack, dir);
    assert.deepEqual(issues.map((i) => i.id), ['gone', 'code', 'up']);
    for (const i of issues) assert.equal(i.code, 'CLIENT_BAD_PANEL_MODULE');
    assert.deepEqual(panelModuleIssues({}, dir), []);
    assert.deepEqual(panelModuleIssues(pack, ''), [], '没有包目录时不做判定（不猜路径）');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('身份：**声明了**的面板模块进内容哈希，没声明的文件不进（DESIGN §28.8）', () => {
    // 同样的 pack.json（同一个包 id），模块字节不同 ⇒ 两个摘要
    const decl = { license: 'CC0-1.0', client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'm.js' }] } };
    const a = packRoot('ident', decl, { 'm.js': PANEL_JS });
    const b = packRoot('ident', decl, { 'm.js': `// 另一份实现\n${PANEL_JS}` });
    const ha = loadWorkshop(a, { log: quiet }).packs[0].hash;
    const hb = loadWorkshop(b, { log: quiet }).packs[0].hash;
    assert.notEqual(ha, hb, '面板源码不在身份里 ⇒ 两份不同的面板会共用一个摘要');
    // 两个包都**没有**声明 client：多出来的那个 `.js` 文件不进哈希
    const plain = { license: 'CC0-1.0', content: ['chess'] };
    const ea = loadWorkshop(packRoot('un', plain, { ...CHESS_FILES, 'm.js': PANEL_JS }), { log: quiet }).packs[0].hash;
    const eb = loadWorkshop(packRoot('un', plain, { ...CHESS_FILES }), { log: quiet }).packs[0].hash;
    assert.equal(ea, eb, '没声明的文件不许进哈希（否则每加一个文件就换一次身份）');
    for (const r of [a, b]) fs.rmSync(r, { recursive: true, force: true });
  });

  test('三份真实夹具（docs/examples）一个面板都不声明 ⇒ 清单为空、包对象里没有 client', () => {
    const loaded = loadWorkshop(EXAMPLES, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.packs.length >= 3);
    for (const p of loaded.packs) assert.equal(p.client, undefined, `${p.id} 不该有 client`);
    const { panels, errors } = loadWorkshopPanels(loaded, { log: quiet });
    assert.deepEqual(panels, []);
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. 服务端：清单（随 welcome 走）与服务表（只在已注册 URL 上服务）
// ---------------------------------------------------------------------------------------------------
describe('C 层：清单与模块服务面', () => {
  test('清单：URL 带包内容哈希、order/gate 缺省明确、按 order → 包 id → 面板 id 排序', () => {
    const { panels, errors } = loadWorkshopPanels(loadWorkshop(wsRoot, { log: quiet }), { log: quiet });
    assert.deepEqual(errors, []);
    assert.deepEqual(panels.map((p) => `${p.pack}/${p.id}`), ['demo-pack/aaa', 'panel-pack/aside-note', 'panel-pack/sp-resource-import']);
    const demo = panels[0];
    assert.equal(demo.order, -5);
    assert.equal(demo.gate, null, '没声明 gate 就是 null（不是空串）');
    assert.deepEqual(demo.requires, []);
    const preload = panels[2];
    assert.equal(preload.order, 10);
    assert.equal(preload.gate, 'session.preloadRequired');
    assert.deepEqual(preload.requires, ['cacheStorage']);
    assert.ok(Object.isFrozen(preload.requires));
    assert.equal(preload.url, `${WORKSHOP_PANEL_PREFIX}panel-pack/${PRELOAD_MODULE}?v=${preload.hash.slice(0, 12)}`);
    assert.match(preload.url, /^\/workshop-panels\/panel-pack\/resources\/preloadModal\.js\?v=[0-9a-f]{12}$/);
    // 包名 / 路径分段百分号编码：声明里的中文与空格不在 URL 里裸奔
    assert.equal(panels[1].url, `${WORKSHOP_PANEL_PREFIX}panel-pack/${CN_MODULE_ENCODED}?v=${panels[1].hash.slice(0, 12)}`);
  });

  test('服务表：键是**解码后**的路径，并且只有已注册的 `.js` 进表', () => {
    const { panels } = loadWorkshopPanels(loadWorkshop(wsRoot, { log: quiet }), { log: quiet });
    const files = workshopPanelFilesFor(panels, wsRoot);
    assert.equal(files.size, 3);
    const key = `${WORKSHOP_PANEL_PREFIX}panel-pack/${CN_MODULE}`;
    assert.equal(files.get(key), path.join(wsRoot, 'panel-pack', CN_MODULE));
    // 形状像 `.js` 但没被注册的 URL、非 `.js`、逃出包目录的 module 一律不进表
    assert.equal(workshopPanelFilesFor([{ pack: 'panel-pack', module: 'nope.js', url: '/workshop-panels/panel-pack/nope.js' }], wsRoot).size, 1, '表是「装载器说过的 URL」，服务时再判文件在不在');
    assert.equal(workshopPanelFilesFor([{ pack: 'p', module: 'a.html', url: '/workshop-panels/p/a.html' }], wsRoot).size, 0);
    assert.equal(workshopPanelFilesFor([{ pack: 'p', module: '../x.js', url: '/workshop-panels/p/../x.js' }], wsRoot).size, 0);
    assert.equal(workshopPanelFilesFor(panels, null).size, 0, '关掉工坊就是空表');
    assert.equal(workshopPanelFilesFor(null, wsRoot).size, 0);
  });

  test('真 HTTP：注册的 URL 送 `.js`；未注册 / 穿越 / `.html` / 包清单都拿不到', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const listed = srv.lobby.welcomeInfo().modPanels;
      assert.equal(listed.length, 3);
      const url = listed.find((p) => p.id === 'sp-resource-import').url;
      const res = await fetch(srv.url + url);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /javascript/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.match(await res.text(), /export function mount/);
      // 编码过的中文模块：同一个 URL 换回来的是同一份文件
      const cn = await fetch(srv.url + listed.find((p) => p.id === 'aside-note').url);
      assert.equal(cn.status, 200);
      assert.match(await cn.text(), /export function mount/);
      // 未注册 / 穿越 / 非 `.js` / 包自己的清单
      for (const p of [
        '/workshop-panels/panel-pack/nope.js',
        '/workshop-panels/panel-pack/../chess.json',
        '/workshop-panels/panel-pack/resources/preloadModal.html',
        '/workshop-panels/panel-pack/pack.json',
        '/workshop-panels/',
        '/workshop-panels/panel-pack/resources/',
      ]) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
    } finally {
      await srv.close();
    }
  });

  test('welcome：声明了才有 `modPanels`；真实夹具（无声明）那次握手一个字段都不多', async () => {
    const withPacks = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    const without = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    const clients = [];
    try {
      const c1 = await TestClient.connect(`${withPacks.url.replace('http', 'ws')}/ws`);
      clients.push(c1);
      const w1 = await c1.hello('面板博士');
      assert.equal(w1.modPanels.length, 3);
      assert.equal(w1.modPanels[0].pack, 'demo-pack');
      assert.equal(w1.mods.packs.length, 4, '四个包都在线摘要里（含两个只声明 client 的）');

      const c2 = await TestClient.connect(`${without.url.replace('http', 'ws')}/ws`);
      clients.push(c2);
      const w2 = await c2.hello('干净博士');
      assert.ok(w2.mods && w2.mods.packs.length >= 3, '真实夹具的包在摘要里（这次对照确实装了包）');
      assert.equal('modPanels' in w2, false, '没有包声明 client ⇒ welcome 里没有这个字段');
      assert.deepEqual(Object.keys(w1).sort(), [...Object.keys(w2), 'modPanels'].sort(),
        '两侧 welcome 的字段集合只差 modPanels 一个');
      // 服务端那一半：装箱函数本身在没有面板时不加字段
      assert.equal('modPanels' in without.lobby.welcomeInfo(), false);
      assert.equal(withPacks.lobby.welcomeInfo().modPanels.length, 3);
    } finally {
      for (const c of clients) { try { await c.close(); } catch { /* already closed */ } }
      await withPacks.close();
      await without.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. 客户端注册点：纯逻辑（真跑）
// ---------------------------------------------------------------------------------------------------
/** 一个够用的假 DOM：槽位容器由注册点按需创建（`slotHost`），所以这里模拟「查询 → 没有就造一个」。 */
function fakeDom() {
  const slots = new Map();
  const created = [];
  const makeEl = (tag) => ({
    tag, className: '', attributes: {}, children: [], removed: false,
    setAttribute(k, v) { this.attributes[k] = v; },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; },
  });
  return {
    created,
    /** 页面壳自己渲染的槽位（也可以不渲染：那样注册点会自己造，见 `browserSlotHost`）。 */
    render(slot) {
      const el = makeEl('div');
      el.className = 'mod-slot';
      el.setAttribute('data-mod-slot', slot);
      slots.set(slot, el);
      return el;
    },
    resolve: (slot) => slots.get(slot) || null,
    create: (tag) => { const el = makeEl(tag); created.push(el); return el; },
    slotEl: (slot) => slots.get(slot),
  };
}

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** 一个记录一切的注册点工厂：注入假的模块加载器、假的 DOM、假的能力环境、可断言的 notify。 */
function harness({ env = { serviceWorker: true, cacheStorage: true, webCrypto: true }, modules = new Map(), slotHost = null } = {}) {
  const store = createStore(initialState);
  const dom = fakeDom();
  const imported = [];
  const notify = [];
  const logs = [];
  const registry = createPanelRegistry({
    store,
    net: { on: () => () => {}, sendResourceMessage: () => true },
    log: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
    notify: (text, kind) => notify.push([text, kind]),
    importModule: async (url) => {
      imported.push(url);
      if (modules.has(url)) return modules.get(url);
      return { mount: () => ({ unmount() {} }) };
    },
    // 缺省：像浏览器那样「查不到就造一个」（`browserSlotHost`）；用例可以传一个总是 null 的来测「还没渲染」
    slotHost: slotHost || ((slot) => dom.resolve(slot) || dom.render(slot)),
    createElement: (tag) => dom.create(tag),
    env,
  });
  return { store, dom, registry, imported, notify, logs, apply: (list) => registry.apply(list) };
}

const wire = (over = {}) => ({
  id: 'p1', pack: 'alpha', slot: 'root.overlays',
  url: `${MOD_PANEL_PREFIX}alpha/gate.js?v=0123456789ab`,
  order: 0, gate: null, requires: [], ...over,
});

describe('C 层客户端：注册点', () => {
  test('不声明 ⇒ 什么都不做：不 import、不建元素（连槽位容器都不建）、不订阅 store', () => {
    let subscribed = 0;
    const store = createStore(initialState);
    const originalSubscribe = store.subscribe;
    store.subscribe = (fn) => { subscribed++; return originalSubscribe(fn); };
    const dom = fakeDom();
    const imported = [];
    const registry = createPanelRegistry({
      store,
      importModule: async (u) => { imported.push(u); return {}; },
      slotHost: (slot) => dom.resolve(slot) || dom.render(slot),
      createElement: (tag) => dom.create(tag),
    });
    for (const list of [[], null, undefined]) registry.apply(list);
    assert.deepEqual(imported, []);
    assert.deepEqual(dom.created, []);
    assert.equal(dom.slotEl('root.overlays'), undefined, '没有面板就不该有槽位容器（「没有新 DOM」）');
    assert.equal(subscribed, 0, '一个面板都没有时连 store 都不订阅');
    assert.deepEqual(registry.mounted(), []);
  });

  test('槽位容器按需创建（`browserSlotHost`）：页面壳没渲染就自己造一个，渲染了就沿用', () => {
    const created = [];
    const body = { children: [], appendChild(el) { this.children.push(el); return el; } };
    const makeEl = (tag) => ({
      tag, className: '', attributes: {}, children: [],
      setAttribute(k, v) { this.attributes[k] = v; },
      appendChild(child) { this.children.push(child); return child; },
    });
    const savedDoc = globalThis.document;
    try {
      // 页面里还没有这个槽位：造一个、挂到 body、带上寻址用的类与属性
      globalThis.document = {
        querySelector: () => null,
        createElement: (tag) => { const el = makeEl(tag); created.push(el); return el; },
        body,
      };
      const made = browserSlotHost('root.overlays');
      assert.equal(made.className, 'mod-slot');
      assert.equal(made.attributes['data-mod-slot'], 'root.overlays');
      assert.deepEqual(body.children, [made], '容器挂到 body 上（四个浮层都是 fixed 定位）');
      // 已有同名元素：沿用，不再造
      const existing = makeEl('div');
      globalThis.document.querySelector = (sel) => (sel === slotSelector('root.guide') ? existing : null);
      assert.equal(browserSlotHost('root.guide'), existing);
      assert.equal(created.length, 1, '只有一个容器是造出来的');
      // 没有 document（Node）：null，调用方按「还没到」处理
      globalThis.document = undefined;
      assert.equal(browserSlotHost('root.overlays'), null);
    } finally {
      globalThis.document = savedDoc;
    }
  });

  test('合法清单 ⇒ 按 order / 包 id / 面板 id 顺序挂载，宿主元素进对应槽位', async () => {
    const mountedOrder = [];
    const mods = new Map([
      ['/workshop-panels/beta/b.js?v=1', { mount: () => { mountedOrder.push('beta/b'); } }],
      ['/workshop-panels/alpha/a.js?v=1', { mount: () => { mountedOrder.push('alpha/a'); } }],
      ['/workshop-panels/alpha/z.js?v=1', { mount: () => { mountedOrder.push('alpha/z'); } }],
    ]);
    const h = harness({ modules: mods });
    const res = h.apply([
      wire({ id: 'b', pack: 'beta', url: '/workshop-panels/beta/b.js?v=1', order: 5, slot: 'root.guide' }),
      wire({ id: 'z', pack: 'alpha', url: '/workshop-panels/alpha/z.js?v=1', order: 5, slot: 'root.overlays' }),
      wire({ id: 'a', pack: 'alpha', url: '/workshop-panels/alpha/a.js?v=1', order: 5, slot: 'root.overlays' }),
    ]);
    assert.equal(res.accepted, 3);
    await settle();
    assert.deepEqual(mountedOrder, ['alpha/a', 'alpha/z', 'beta/b'], 'order 相同 → 包 id 小的先，再按面板 id');
    assert.deepEqual(h.registry.mounted(), ['alpha/a', 'alpha/z', 'beta/b']);
    assert.equal(h.dom.created.length, 3);
    assert.equal(h.dom.slotEl('root.overlays').children.length, 2);
    assert.equal(h.dom.slotEl('root.guide').children.length, 1);
    assert.equal(h.dom.created[0].attributes['data-mod-panel'], 'alpha/a');
    assert.equal(h.dom.created[0].className, 'mod-panel');
    // 换一个 `order`，顺序随之改变（顺序真的来自声明，不是数组次序）
    const h2 = harness({ modules: mods });
    mountedOrder.length = 0;
    h2.apply([
      wire({ id: 'b', pack: 'beta', url: '/workshop-panels/beta/b.js?v=1', order: -1, slot: 'root.guide' }),
      wire({ id: 'z', pack: 'alpha', url: '/workshop-panels/alpha/z.js?v=1', order: 5, slot: 'root.overlays' }),
    ]);
    await settle();
    assert.deepEqual(mountedOrder, ['beta/b', 'alpha/z']);
  });

  test('注入面冻结且极小：只有 id/pack/slot/order/gate/log/host/session/net，没有 store 内部对象', async () => {
    const seen = [];
    const h = harness();
    const realNet = { on: () => () => {}, sendResourceMessage: () => true };
    const registry = createPanelRegistry({
      store: h.store, net: realNet, log: quiet,
      importModule: async () => ({ mount: (ctx) => { seen.push(ctx); } }),
      slotHost: (s) => h.dom.resolve(s) || h.dom.render(s), createElement: (t) => h.dom.create(t),
      env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
    });
    h.store.patch('session', { entered: true });
    registry.apply([wire({ gate: 'session.entered', url: `${MOD_PANEL_PREFIX}alpha/gate.js?v=1` })]);
    await settle();
    assert.equal(seen.length, 1);
    const ctx = seen[0];
    // `hostKey` 是业主 2026-10-10 裁决里「可重复宿主」那一半（每张商店卡一个容器）：不可重复的宿主它是 `null`。
    // `data` 是同一条裁决里的**数据口**（`ctx.data.get('<表>')` 返回冻结快照）。
    // `me` 是「一格只读会话态」：`{ playerId, name, room }` 一份**冻结快照** —— 面板答不出来的那几件事实。
    assert.deepEqual(Object.keys(ctx).sort(),
      ['data', 'gate', 'host', 'hostKey', 'id', 'log', 'me', 'net', 'order', 'pack', 'session', 'slot']);
    assert.equal(ctx.hostKey, null, '不可重复的宿主没有键');
    assert.ok(Object.isFrozen(ctx));
    assert.ok(Object.isFrozen(ctx.session));
    assert.ok(Object.isFrozen(ctx.net));
    assert.ok(Object.isFrozen(ctx.log));
    assert.ok(Object.isFrozen(ctx.me), '会话态也是一份冻结快照');
    // 只读会话态的形状与**边界**：只有这三样，没有 store / match / battle / runner / audio
    assert.deepEqual(Object.keys(ctx.me).sort(), ['name', 'playerId', 'room', 'snapshot'],
      '只读会话态：三样读数 + 一次取全的 snapshot（没有别的）');
    assert.equal(ctx.store, undefined, '不给 store');
    assert.equal(ctx.engine, undefined);
    assert.equal(ctx.match, undefined);
    assert.equal(ctx.me.battle, undefined, '会话态里没有对局对象');
    assert.equal(ctx.me.runner, undefined, '也没有战斗播放层');
    assert.equal(ctx.me.audio, undefined);
    assert.notEqual(ctx.net, realNet, '给的是受控门面，不是 net 本身');
    assert.equal(typeof ctx.net.sendResourceMessage, 'function');
    assert.equal(typeof ctx.session.setPreload, 'function');
    assert.equal(typeof ctx.host.appendChild, 'function');
    assert.throws(() => { ctx.extra = 1; }, TypeError);
    assert.equal(ctx.gate, 'session.entered');
  });

  // 「一格只读会话态」：面板答不出来的那几件事实（我是谁 / 房间的展示面），由引擎以**冻结快照**告知。
  // 这条是它的语义钉子：房间三类状态（不在房间 / 就座 / 旁观）各自读出什么。
  test('只读会话态 me：不在房间时是空态；就座时给出座位号；旁观时 spectating=true 且 mySeat=null', async () => {
    const seen = [];
    const URL_S1 = `${MOD_PANEL_PREFIX}alpha/s1.js?v=1`;
    const h = harness({ modules: new Map([[URL_S1, { mount: (ctx) => { seen.push(ctx.me); } }]]) });
    const list = [wire({ url: URL_S1 })];

    // ① 还没进房间：三样都是空态（不是错误 —— 面板该画空态，不该抛）
    h.apply(list);
    await settle();
    assert.equal(seen.length, 1);
    const me = seen[0];
    assert.deepEqual({ ...me.snapshot() }, { playerId: null, name: null, room: null }, '没进房间时是干净的空态');

    // ② 就座：拿到自己的 playerId / name、房间码与座位号
    //    注意：面板**挂上之后不重挂**，所以这三点是**活的只读读数**（每次读都取当前值），不是挂载那一刻的定格。
    h.store.patch('me', { playerId: 'p1', name: '甲' });
    h.store.patch('room', {
      code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', inMatch: false, mods: ['alpha'],
      seats: [{ playerId: 'p1', seat: 0 }, { playerId: 'p2', seat: 1 }], spectators: [],
    });
    await settle();
    assert.equal(me.playerId, 'p1', 'store 变了之后读得到新值（不是挂载时的定格）');
    assert.equal(me.name, '甲');
    assert.equal(me.room.code, 'ABCD');
    assert.equal(me.room.mySeat, 0, '座位号让面板能在 seats 里定位自己');
    assert.equal(me.room.spectating, false);
    assert.deepEqual([...me.room.mods], ['alpha'], '房间自己那一套（W-A）也读得到');

    // ③ 旁观：座位表里没有我、观众席里有我 ⇒ spectating=true 且 mySeat=null
    h.store.patch('room', {
      code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', inMatch: true,
      seats: [{ playerId: 'p2', seat: 0 }], spectators: [{ playerId: 'p1' }],
    });
    await settle();
    assert.equal(me.room.mySeat, null, '旁观没有座位号');
    assert.equal(me.room.spectating, true);
    assert.equal(me.room.inMatch, true, '对局中：面板据此决定要不要显示对局相关的块');
    // 没声明集合的房间：`mods` 是 null（不是 undefined）——面板可以按 falsy 判。
    // 注意 `store.patch('room', …)` 是**浅合并**（store 的既有语义），所以要显式写 `mods: null` 才清得掉。
    h.store.patch('room', { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', inMatch: false, mods: null, seats: [], spectators: [] });
    await settle();
    assert.equal(me.room.mods, null, '没声明集合的房间：mods 是 null');
    // 快照是**冻结**的：面板改不动它（也就改不了引擎那份）
    assert.throws(() => { me.room.code = 'ZZZZ'; }, TypeError);
    assert.throws(() => { me.playerId = 'p9'; }, TypeError);
    // 一次取全：三样来自同一次 store 读（避免面板分三次读出现撕裂）
    assert.deepEqual(Object.keys({ ...me.snapshot() }).sort(), ['name', 'playerId', 'room']);
  });

  test('gate：等路径为真才挂；路径不存在 ⇒ 具名拒绝（不是永远不出现）', async () => {
    const seen = [];
    const h = harness({ modules: new Map([[`${MOD_PANEL_PREFIX}alpha/gate.js?v=1`, { mount: () => { seen.push('mounted'); } }]]) });
    h.apply([wire({ url: `${MOD_PANEL_PREFIX}alpha/gate.js?v=1`, gate: 'session.preloadRequired' })]);
    await settle();
    assert.deepEqual(seen, [], '闸门关着就不挂');
    assert.deepEqual(h.imported, [], '闸门关着连模块都不 import');
    h.store.patch('session', { preloadRequired: true });
    await settle();
    assert.deepEqual(seen, ['mounted']);
    // 同一个注册点里再加一个闸门名不存在的面板
    h.apply([
      wire({ url: `${MOD_PANEL_PREFIX}alpha/gate.js?v=1`, gate: 'session.preloadRequired' }),
      wire({ id: 'ghost', url: `${MOD_PANEL_PREFIX}alpha/ghost.js?v=1`, gate: 'session.neverSuchFlag' }),
    ]);
    await settle();
    assert.ok(h.registry.refusals().some((r) => r.code === 'CLIENT_PANEL_GATE_UNKNOWN'), JSON.stringify(h.registry.refusals()));
    assert.deepEqual(h.registry.mounted(), ['alpha/p1'], '名字不存在的闸门不会被当成「等一等」');
  });

  test('requires：缺一项即明示「浏览器不支持」，不挂载、点名、通知玩家', async () => {
    const h = harness({
      env: { serviceWorker: false, cacheStorage: false, webCrypto: false },
      modules: new Map([[`${MOD_PANEL_PREFIX}alpha/gate.js?v=1`, { mount: () => { throw new Error('不该被调用'); } }]]),
    });
    h.apply([wire({ url: `${MOD_PANEL_PREFIX}alpha/gate.js?v=1`, requires: ['cacheStorage', 'webCrypto'] })]);
    await settle();
    assert.deepEqual(h.registry.mounted(), []);
    assert.deepEqual(h.imported, [], '能力不足时连模块都不 import');
    assert.equal(h.notify.length, 1);
    assert.match(h.notify[0][0], /alpha/);
    assert.match(h.notify[0][0], /cacheStorage, webCrypto/);
    assert.equal(h.notify[0][1], 'error');
    const names = h.logs.filter(([k]) => k === 'error').map((l) => String(l[1]));
    assert.ok(names.some((s) => s.includes('CLIENT_REQUIRES_UNSUPPORTED')), names.join('\n'));
    // 能力齐了才挂
    const ok = harness();
    ok.apply([wire()]);
    await settle();
    assert.deepEqual(ok.registry.mounted(), ['alpha/p1']);
    assert.deepEqual(ok.notify, []);
  });

  test('坏清单逐条具名拒绝：URL 不在注册路由上 / 未知 slot / 模块没有 mount / 模块抛异常 / 缺 id', async () => {
    const h = harness({
      modules: new Map([
        [`${MOD_PANEL_PREFIX}alpha/nomount.js?v=1`, { somethingElse: true }],
        [`${MOD_PANEL_PREFIX}alpha/throws.js?v=1`, { mount: () => { throw new Error('boom'); } }],
      ]),
    });
    const res = h.apply([
      wire({ url: 'https://evil.example/x.js' }),
      wire({ id: 'slot', slot: 'root.nowhere' }),
      wire({ id: 'nomount', url: `${MOD_PANEL_PREFIX}alpha/nomount.js?v=1` }),
      wire({ id: 'throws', url: `${MOD_PANEL_PREFIX}alpha/throws.js?v=1` }),
      wire({ id: '' }),
      'not an object',
    ]);
    assert.equal(res.accepted, 2, '声明本身合法（坏的是模块的导出），拒绝发生在挂载期');
    await settle();
    const codes = h.registry.refusals().map((r) => r.code);
    for (const code of ['CLIENT_BAD_PANEL_MODULE', 'CLIENT_BAD_PANEL_SLOT', 'CLIENT_PANEL_NO_MOUNT', 'CLIENT_PANEL_MOUNT_FAILED', 'CLIENT_BAD_PANEL_ID', 'CLIENT_BAD_PANEL']) {
      assert.ok(codes.includes(code), `${code} missing in ${JSON.stringify(codes)}`);
    }
    // 只有 nomount / throws 真的被尝试 import（前两个在校验层就被拒）
    assert.deepEqual(h.imported, [`${MOD_PANEL_PREFIX}alpha/nomount.js?v=1`, `${MOD_PANEL_PREFIX}alpha/throws.js?v=1`]);
    assert.deepEqual(h.registry.mounted(), []);
  });

  test('宿主还不存在（页面壳自己管槽位）⇒ 先等着，槽位一出现（下一次 store 变化）就挂上', async () => {
    let rendered = false; // 页面壳自己的槽位：一开始还没有
    const h = harness({ slotHost: (slot) => (rendered ? (h.dom.resolve(slot) || h.dom.render(slot)) : null) });
    h.apply([wire()]);
    await settle();
    assert.deepEqual(h.registry.mounted(), [], '宿主没就绪：不能凭空造一个槽位');
    assert.deepEqual(h.imported, []);
    assert.deepEqual(h.logs.filter(([k]) => k === 'error'), [], '不是失败，是「还没到」');
    rendered = true;
    h.dom.render('root.overlays');
    h.store.patch('ui', { restoring: false }); // 任意一次 store 变化都会重试
    await settle();
    assert.deepEqual(h.registry.mounted(), ['alpha/p1']);
  });

  test('dispose()：调用 unmount、摘掉宿主、停止跟随 store', async () => {
    const unmounted = [];
    const h = harness({
      modules: new Map([[`${MOD_PANEL_PREFIX}alpha/gate.js?v=1`, { mount: () => ({ unmount: () => unmounted.push('alpha/p1') }) }]]),
    });
    h.apply([wire({ url: `${MOD_PANEL_PREFIX}alpha/gate.js?v=1` })]);
    await settle();
    assert.deepEqual(h.registry.mounted(), ['alpha/p1']);
    const el = h.dom.created[0];
    h.registry.dispose();
    assert.deepEqual(unmounted, ['alpha/p1']);
    assert.equal(el.removed, true);
    assert.deepEqual(h.registry.mounted(), []);
    const before = h.imported.length;
    h.store.patch('session', { entered: true });
    h.apply([wire({ id: 'again' })]);
    await settle();
    assert.equal(h.imported.length, before, 'dispose 之后不再挂任何东西');
  });

  test('capabilityIssues / readGate：能力判定与 store 路径解析（包含未知能力名）', () => {
    assert.deepEqual(capabilityIssues([], {}), []);
    assert.deepEqual(capabilityIssues(undefined), []);
    assert.deepEqual(capabilityIssues(['cacheStorage'], { cacheStorage: true }), []);
    assert.deepEqual(capabilityIssues(['cacheStorage', 'webCrypto'], { cacheStorage: true }), ['webCrypto']);
    assert.deepEqual(capabilityIssues(['somethingNew'], { somethingNew: false }), ['somethingNew'], '不认识的能力不许当成「有」');
    const state = { session: { entered: true, preloadRequired: false, preloadReady: false } };
    assert.deepEqual(readGate(state, 'session.entered'), { ok: true, value: true });
    assert.deepEqual(readGate(state, 'session.preloadReady'), { ok: true, value: false });
    assert.equal(readGate(state, 'session.nope').ok, false);
    assert.equal(readGate(state, 'nope.deep').ok, false);
    assert.equal(readGate(state, 'session.constructor').ok, false, '原型链上的名字不是 store 路径');
    assert.equal(readGate(state, '').ok, false);
    assert.equal(readGate(null, 'session').ok, false);
  });
});

// ---------------------------------------------------------------------------------------------------
// 4b. 外观提供者（皮肤层第 2 步，设计稿 §2 / §6）：一个进程最多一个，接进解析链的**唯一 hook**。
//
// 三条性质各有一条测试：最多一个（后注册者点名拒绝）/ 接进链（链真的走它）/ dispose 收回（回到「没有 hook」
// 那条与今天逐字相同的路径）。外加两条边界：只提供外观不挂界面的模块是合法的；抛异常或形状不对都点名拒绝。
// ---------------------------------------------------------------------------------------------------
describe('外观提供者：一个进程最多一个，接进解析链', () => {
  const URL_AP1 = `${MOD_PANEL_PREFIX}alpha/app1.js?v=1`;
  const URL_AP2 = `${MOD_PANEL_PREFIX}beta/app2.js?v=1`;
  const M2 = { chars: { char_a: { portrait: 'a/p1.png' } } };
  const askChain = () => portraitEntry(M2, { charId: 'char_a', assets: { portrait: 'summer' } }, { lookup: currentAppearanceLookup() });

  test('模块导出 appearance(ctx) ⇒ 接进链；appearance() 报出是谁提供的', async () => {
    clearAppearanceLookup();
    const h = harness({
      modules: new Map([[URL_AP1, {
        // 只提供外观、不挂界面 —— 合法形态（它已经把要做的事做完了）
        appearance: () => ({ lookup: (kind, charId, id) => (id === 'summer' ? { portrait: 's/p.png' } : null) }),
      }]]),
    });
    h.apply([wire({ url: URL_AP1 })]);
    await settle();
    assert.deepEqual(h.registry.refusals(), [], '0 拒绝');
    assert.equal(h.registry.appearance().providedBy, 'alpha/p1');
    assert.equal(askChain(), 's/p.png', '链真的走了它');
    clearAppearanceLookup();
  });

  test('第二个提供者被点名拒绝（谁提供外观不能取决于加载次序）', async () => {
    clearAppearanceLookup();
    const h = harness({
      modules: new Map([
        [URL_AP1, { appearance: () => ({ lookup: () => null }), mount: () => ({ unmount() {} }) }],
        [URL_AP2, { appearance: () => ({ lookup: () => null }), mount: () => ({ unmount() {} }) }],
      ]),
    });
    h.apply([
      wire({ id: 'p1', pack: 'alpha', url: URL_AP1, order: 0 }),
      wire({ id: 'p2', pack: 'beta', url: URL_AP2, order: 1 }),
    ]);
    await settle();
    const refused = h.registry.refusals();
    assert.equal(refused.length, 1, `恰好一条拒绝：${JSON.stringify(refused)}`);
    assert.equal(refused[0].code, 'CLIENT_APPEARANCE_TAKEN');
    assert.match(refused[0].detail, /alpha\/p1/, '理由要点名先来的那个');
    assert.equal(h.registry.appearance().providedBy, 'alpha/p1', '先来的继续有效');
    clearAppearanceLookup();
  });

  test('appearance 抛异常 / 形状不对 ⇒ 点名拒绝，链不受影响', async () => {
    clearAppearanceLookup();
    const URL_BAD = `${MOD_PANEL_PREFIX}alpha/bad.js?v=1`;
    const URL_SHAPE = `${MOD_PANEL_PREFIX}alpha/shape.js?v=1`;
    const h1 = harness({ modules: new Map([[URL_BAD, { appearance: () => { throw new Error('boom'); } }]]) });
    h1.apply([wire({ url: URL_BAD })]);
    await settle();
    assert.equal(h1.registry.refusals()[0].code, 'CLIENT_APPEARANCE_THREW');
    assert.equal(h1.registry.appearance().providedBy, null);
    const h2 = harness({ modules: new Map([[URL_SHAPE, { appearance: () => ({ list: () => [] }) }]]) });
    h2.apply([wire({ url: URL_SHAPE })]);
    await settle();
    assert.equal(h2.registry.refusals()[0].code, 'CLIENT_APPEARANCE_BAD_SHAPE', '必须有 lookup');
    clearAppearanceLookup();
  });

  test('不导出 appearance 的面板一切照旧（这是绝大多数）', async () => {
    clearAppearanceLookup();
    const h = harness({ modules: new Map([[URL_AP1, { mount: () => ({ unmount() {} }) }]]) });
    h.apply([wire({ url: URL_AP1 })]);
    await settle();
    assert.deepEqual(h.registry.refusals(), []);
    assert.equal(h.registry.appearance().providedBy, null);
    assert.equal(currentAppearanceLookup(), undefined, '链上没有 hook ⇒ 与今天逐字相同');
  });

  test('dispose 把提供者收回去：链回到「没有 hook」', async () => {
    clearAppearanceLookup();
    const h = harness({ modules: new Map([[URL_AP1, { appearance: () => ({ lookup: () => ({ portrait: 'x' }) }) }]]) });
    h.apply([wire({ url: URL_AP1 })]);
    await settle();
    assert.equal(typeof currentAppearanceLookup(), 'function');
    h.registry.dispose();
    assert.equal(currentAppearanceLookup(), undefined, 'dispose 之后回到与今天逐字相同的链');
    assert.equal(h.registry.appearance().providedBy, null);
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. 客户端三处既有缺口（mod4 侦查报告点名，至今未动）
// ---------------------------------------------------------------------------------------------------
describe('客户端缺口：资源消息 / 入口闸门 / wasEntered 旁路', () => {
  /** 一个已经连上但还没 `hello` 的 Net（status === 'connecting'）：挑战就是在这个窗口里到的。 */
  function connectingNet() {
    const frames = [];
    const net = new Net({ url: 'ws://test/ws', WebSocket: class {}, getToken: () => null });
    net.ws = { readyState: 1, send: (s) => frames.push(JSON.parse(s)) };
    net.status = 'connecting';
    return { net, frames };
  }

  test('sendResourceMessage 走 `_sendRaw`：`hello` 之前（status 不是 online）也发得出去', () => {
    const { net, frames } = connectingNet();
    assert.deepEqual([...RESOURCE_MSG_TYPES], ['resource.proof', 'resource.challenge.request', 'resource.reset']);
    // send() 在这个窗口里会静默丢掉 —— 这正是缺口 4
    assert.equal(net.send('resource.challenge.request'), false);
    assert.deepEqual(frames, []);
    // 资源消息走 _sendRaw
    assert.equal(net.sendResourceMessage({ t: 'resource.challenge.request' }), true);
    assert.equal(net.sendResourceMessage({ t: 'resource.reset' }), true);
    assert.equal(net.sendResourceMessage({ t: 'resource.proof', nonce: 'a'.repeat(48), version: 'b'.repeat(12), proofs: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)] }), true);
    assert.deepEqual(frames.map((f) => f.t), ['resource.challenge.request', 'resource.reset', 'resource.proof']);
    // 其它类型 / 形状不对的帧：本地具名拒绝，一个字节都不写
    const w = console.warn;
    console.warn = () => {};
    try {
      assert.equal(net.sendResourceMessage({ t: 'room.create' }), false);
      assert.equal(net.sendResourceMessage({ t: 'resource.proof', nonce: 'short' }), false);
      assert.equal(net.sendResourceMessage(null), false);
      assert.equal(net.sendResourceMessage({ t: 'resource.proof', nonce: 'a'.repeat(48), version: 'b'.repeat(12), proofs: ['c'.repeat(64)] }), false);
    } finally {
      console.warn = w;
    }
    assert.equal(frames.length, 3);
    // 断言「真的用了 _sendRaw」：Socket 一关就返回 false（send() 会先被 status 挡掉，看不出这一点）
    net.ws.readyState = 3;
    assert.equal(net.sendResourceMessage({ t: 'resource.reset' }), false);
  });

  test('store：preloadRequired / preloadReady 默认 false，闸门表达式与路由一起生效', () => {
    assert.equal(initialState.session.preloadRequired, false);
    assert.equal(initialState.session.preloadReady, false);
    assert.equal(entryGateBlocked({ session: {} }), false);
    assert.equal(entryGateBlocked({ session: { preloadRequired: true, preloadReady: false } }), true);
    assert.equal(entryGateBlocked({ session: { preloadRequired: true, preloadReady: true } }), false);
    assert.equal(entryGateBlocked(undefined), false);
    // selectRoute 的既有行为一字未改（默认状态下这一行等价于不存在）
    const base = { session: { entered: true }, room: null, match: { public: null } };
    assert.equal(selectRoute({ ...base, session: { entered: false } }), 'title');
    assert.equal(selectRoute(base), 'lobby');
    assert.equal(selectRoute({ ...base, room: { code: 'ABCD' } }), 'room');
    assert.equal(selectRoute({ ...base, room: { code: 'ABCD', inMatch: true } }), 'game');
    assert.equal(selectRoute({ ...base, room: { code: 'ABCD' }, match: { public: { phase: 'PREP' } } }), 'game');
    assert.equal(selectRoute(undefined), 'title');
    // 闸门关上：无论在哪个房间 / 哪个阶段，路由都是标题页
    const closed = { session: { entered: true, preloadRequired: true, preloadReady: false } };
    assert.equal(selectRoute({ ...base, ...closed }), 'title');
    assert.equal(selectRoute({ ...base, ...closed, room: { code: 'ABCD', inMatch: true } }), 'title');
    assert.equal(selectRoute({ ...base, ...closed, match: { public: { phase: 'PREP' } } }), 'title');
    // 就绪之后照常放行
    assert.equal(selectRoute({ ...base, session: { entered: true, preloadRequired: true, preloadReady: true } }), 'lobby');
  });

  test('main.js：boot 不再整片替换 session（wasEntered 旁路），两条深链都看闸门', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
    // 缺口 8：`identity.wasEntered()` 开机就能把 entered 置真，所以 boot 那次 set 必须摊开现有 session，
    // 否则 `preloadRequired` 每次开机都被重置掉，闸门形同虚设
    assert.match(src, /session: \{ \.\.\.s\.session, entered \}/);
    assert.doesNotMatch(src, /session: \{ entered \}/);
    // 两条深链（?playtest= / ?room=）不能绕过闸门
    assert.match(src, /if \(entryGateBlocked\(s\)\) return;/);
    assert.equal((src.match(/entryGateBlocked\(s\)/g) || []).length, 2, '两个调度器各一条');
    // 四个槽位由注册点按需创建（main.js 一个槽位容器都不渲染 —— 「没有新 DOM」）
    assert.doesNotMatch(src, /data-mod-slot/, '页面壳不许渲染槽位容器：容器只在面板真的挂载时才存在');
    assert.doesNotMatch(src, /ModSlots/);
    assert.match(src, /msg\.modPanels/);
    assert.match(src, /createPanelRegistry\(\{/);
    // 没有新全局：__SP__ 里不许出现面板注册点
    const sp = src.match(/globalThis\.__SP__ = \{([^}]*)\}/);
    assert.ok(sp);
    assert.doesNotMatch(sp[1], /panel/i);
  });
});
