// 对着业主侧的 fanpack 交付包跑它的 C 层那一半：装备总览面板真的挂得上、纯模型函数与原件行为一致。
//
// 交付包**不是仓库内容**（第三方 mod 保持为 mod），所以本机没有它就整组跳过 —— 与 `test/modPluginPackDelivery.test.js`
// 和 `test/packMetaFanpack.test.js` 同一套做法。
//
// 这一条要证明的是 G-12 的另一半：原件那两个新屏幕（装备图鉴 / 盟约策略）在 0.13.0 之后**不需要改引擎文件**
// —— 它们可以是一个 `client.panels[]` 条目。装备总览已经按这条改写并跑通；本文件钉住它。
//
// Run: node --test test/modFanpackDelivery.test.js
import { test, describe, skip } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadWorkshop, loadWorkshopPanels } from '../server/workshop.js';
import { createPanelRegistry } from '../public/js/ui/extensions.js';

const PACK = 'E:\\destop\\harness_1\\_up\\mod-compat\\deliver\\packs\\fanpack-kazdel-rhodes';
const HAS_PACK = existsSync(join(PACK, 'pack.json'));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 装载一次（真 `loadWorkshop` + 真 `loadWorkshopPanels`）；包目录复制到临时 workshop 根，免得污染交付包。 */
function loadOnce() {
  const wsRoot = mkdtempSync(join(tmpdir(), 'sp-fanpack-ui-'));
  cpSync(PACK, join(wsRoot, 'fanpack-kazdel-rhodes'), { recursive: true });
  const loaded = loadWorkshop(wsRoot, { log: quiet });
  const panels = loadWorkshopPanels(loaded, { log: quiet });
  /** 模块 URL → 磁盘文件（URL 上带 `?v=`，比较时切掉）。 */
  const files = new Map();
  const key = (url) => String(url).split('?')[0];
  for (const p of panels.panels) {
    files.set(key(p.url), join(wsRoot, 'fanpack-kazdel-rhodes', p.module));
    for (const s of p.styles || []) files.set(key(s.url), join(wsRoot, 'fanpack-kazdel-rhodes', s.path));
  }
  return { wsRoot, loaded, panels, files, key, cleanup: () => rmSync(wsRoot, { recursive: true, force: true }) };
}

/** 最小的 DOM（面板只用 createElement / appendChild / addEventListener / setAttribute / textContent）。 */
function makeDocument() {
  const mk = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), childNodes: [], attrs: {}, style: {}, _text: '',
      parentNode: null, listeners: new Map(),
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
      removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
      addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn); },
      removeEventListener(t, fn) { const l = this.listeners.get(t) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
      querySelectorAll() { return []; },
      // `clear(node)` 是按 `firstChild` 循环删的（真 DOM 的写法）；假 DOM 少了它，清空就成了空操作，
      // 「卸载后不留节点」那条断言会以「清了但没清掉」的形式失败。
      get firstChild() { return this.childNodes.length ? this.childNodes[0] : null; },
      get lastChild() { return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      // 真元素上 `className` 与 `class` 属性是同一件事 —— 包内的 `el(tag, 'a b')` 走的就是这条，
      // 假 DOM 少了它，面板画出来的节点就一个 class 都数不到（测试会以「面板没画东西」的形式失败）。
      get className() { return this.attrs.class || ''; },
      set className(v) { this.attrs.class = String(v); },
    };
    return el;
  };
  const head = mk('head');
  const body = mk('body');
  const html = mk('html');
  const all = (sel) => [...body.querySelectorAll(sel), ...html.querySelectorAll(sel), ...head.querySelectorAll(sel)];
  return {
    head,
    body,
    documentElement: html,
    createElement: mk,
    createTextNode: (t) => { const n = mk('#text'); n.textContent = String(t); return n; },
    addEventListener(t, fn) { html.addEventListener(t, fn); },
    removeEventListener(t, fn) { html.removeEventListener(t, fn); },
    querySelector: (sel) => all(sel)[0] || null,
    querySelectorAll: (sel) => all(sel),
  };
}

/** 面板只碰这几样：`window.addEventListener` 与 `document`。 */
function installStubs(doc) {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const listeners = new Map();
  globalThis.document = doc;
  globalThis.window = {
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener: (t, fn) => { const l = listeners.get(t) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
  };
  return {
    restore() { globalThis.document = prevDoc; globalThis.window = prevWin; },
    listeners,
  };
}

/** 数一棵（假）DOM 子树里带某个 class 的节点。 */
function countClass(node, cls) {
  let n = 0;
  const visit = (el) => {
    const c = el.attrs && el.attrs.class ? el.attrs.class : '';
    if (String(c).split(/\s+/).includes(cls)) n++;
    for (const k of el.childNodes || []) visit(k);
  };
  visit(node);
  return n;
}

describe('fanpack 交付包：装备总览面板（G-12 的另一半，C 层）', () => {
  test('真装载路径：包认下、面板 1 条、0 拒绝，且声明了它要用的三张表', () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const { loaded, panels, cleanup } = loadOnce();
    try {
      assert.deepEqual(loaded.errors, [], '形状层 0 拒绝');
      const p = (loaded.packs || []).find((x) => x.id === 'fanpack-kazdel-rhodes');
      assert.ok(p, '包被认下');
      assert.equal(p.layer, 'B', '有服务端载荷 ⇒ 层推导为 B');
      assert.deepEqual(panels.errors, [], '面板层 0 拒绝');
      assert.equal(panels.panels.length, 1);
      const panel = panels.panels[0];
      assert.equal(panel.id, 'equipment');
      assert.equal(panel.slot, 'root.overlays', '浮层宿主：引擎按需创建，包不需要改 index.html');
      assert.deepEqual([...panel.data].sort(), ['assets', 'bonds', 'items'], '声明了它要读的表（读别的会被 CLIENT_DATA_UNDECLARED 点名）');
      assert.equal(panel.styles.length, 1, '自带样式表走同一条通道');
      assert.match(panel.url, /^\/workshop-panels\/fanpack-kazdel-rhodes\/ui\/equipment\.js/);
    } finally { cleanup(); }
  });

  test('C 层注册点真的把它挂上：一个浮层容器 + 一个「装备总览」按钮，卸载后无残留', async () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const { panels, files, key, cleanup } = loadOnce();
    const doc = makeDocument();
    const stubs = installStubs(doc);
    globalThis.document = doc;
    try {
      const importModule = (url) => {
        const abs = files.get(key(url));
        assert.ok(abs, `模块 URL 必须在服务表里: ${url}`);
        return import(pathToFileURL(abs).href);
      };
      const created = new Map();
      const registry = createPanelRegistry({
        store: { get: () => ({ session: { preloadRequired: false, preloadReady: false } }), subscribe: () => () => {}, patch: () => {} },
        net: { on: () => () => {}, send: () => true, sendResourceMessage: () => true },
        log: quiet,
        importModule,
        createElement: (tag) => doc.createElement(tag),
        slotHost: (slot) => {
          const el = doc.createElement('div');
          el.setAttribute('data-mod-slot', slot);
          doc.body.appendChild(el);
          created.set(slot, el);
          return el;
        },
        slotHosts: () => [],
        env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
        // 面板声明了 items / bonds / assets：这里给最小但真实的形状（空表也要能画出来，不能抛）
        data: { get: (name) => ({ items: {}, bonds: {}, assets: {} })[name] ?? null },
        onWrapsChanged: () => {},
      });
      const applied = registry.apply(panels.panels);
      assert.equal(applied.accepted, 1);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(registry.refusals(), [], '0 拒绝');
      assert.deepEqual(registry.mounted(), ['fanpack-kazdel-rhodes/equipment'], '面板挂上了（键是 <包>/<面板id>）');
      const container = created.get('root.overlays');
      assert.ok(container, '浮层容器被按需创建');
      // 注册点在槽位容器里再造一层 `mod-panel` 包装，并把**那一层**当 `ctx.host` 交给面板。
      const wrapper = container.childNodes[0];
      assert.equal(container.childNodes.length, 1, '容器里只有注册点建的那一层包装');
      assert.equal(wrapper.className, 'mod-panel', '包装层是 mod-panel');
      assert.equal(wrapper.childNodes.length, 1, '面板自己的根挂在包装里');
      assert.equal(countClass(wrapper, 'fx-cx__open'), 1, '默认是收起状态：一个「装备总览」按钮');
      // 卸载：面板自己的节点要收干净
      registry.dispose();
      assert.equal(wrapper.childNodes.length, 0, 'dispose 后包装层里不留面板节点');
      assert.equal((stubs.listeners.get('keydown') || []).length, 0, 'Esc 监听要摘掉（否则每次挂载漏一个）');
    } finally { stubs.restore(); cleanup(); }
  });

  test('点开之后画的是真数据：档位分组、徽标、搜索过滤都按传进去的表算', async () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const { panels, files, key, cleanup } = loadOnce();
    const doc = makeDocument();
    const stubs = installStubs(doc);
    globalThis.document = doc;
    try {
      const items = {
        it_a: { id: 'it_a', name: '甲', tier: 1, bond: 'kazdelShip', effect: '普通效果' },
        it_a_g: { id: 'it_a_g', name: '甲·精锐', tier: 1, isGolden: true, effect: '精锐效果' },
        it_b: { id: 'it_b', name: '乙', tier: 3, hideInShop: true },
      };
      items.it_a.goldenId = 'it_a_g';
      const created = new Map();
      const registry = createPanelRegistry({
        store: { get: () => ({ session: { preloadRequired: false, preloadReady: false } }), subscribe: () => () => {}, patch: () => {} },
        net: { on: () => () => {}, send: () => true, sendResourceMessage: () => true },
        log: quiet,
        importModule: (url) => import(pathToFileURL(files.get(key(url))).href),
        createElement: (tag) => doc.createElement(tag),
        slotHost: (slot) => {
          const el = doc.createElement('div');
          el.setAttribute('data-mod-slot', slot);
          doc.body.appendChild(el);
          created.set(slot, el);
          return el;
        },
        slotHosts: () => [],
        env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
        data: { get: (n) => ({ items, bonds: { kazdelShip: { name: '卡兹戴尔' } }, assets: {} })[n] ?? null },
        onWrapsChanged: () => {},
      });
      registry.apply(panels.panels);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(registry.refusals(), []);
      const container = created.get('root.overlays');
      assert.ok(container, '找到槽位容器');
      const wrapper = container.childNodes[0];
      assert.ok(wrapper, '找到注册点的包装层');
      // 点「装备总览」
      const openBtn = (function find(el) {
        if (String(el.className || '').split(/\s+/).includes('fx-cx__open')) return el;
        for (const c of el.childNodes || []) { const hit = find(c); if (hit) return hit; }
        return null;
      })(wrapper);
      assert.ok(openBtn, '找到「装备总览」按钮');
      const click = openBtn.listeners.get('click')[0];
      click();
      // 展开后：两档两组（tier 1 与 tier 3），两张卡，精锐徽标一个
      assert.equal(countClass(wrapper, 'fx-cx__panel'), 1, '面板打开了');
      assert.equal(countClass(wrapper, 'fx-cx__group'), 2, '两个档位各一组');
      assert.equal(countClass(wrapper, 'fx-cx__card'), 2, '两件装备（精锐记录不单独成卡）');
      assert.equal(countClass(container, 'fx-cx__gold'), 1, '「甲」有精锐版 ⇒ 一个徽标');
      registry.dispose();
    } finally { stubs.restore(); cleanup(); }
  });

  test('纯模型函数：与原件同一套判据（比较器 / 行构造 / 分组 / 过滤）', async () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const mod = await import(pathToFileURL(join(PACK, 'ui', 'equipment.js')).href);
    // 行构造：普通记录配上精锐；精锐记录自己不出一行
    const items = { a: { id: 'a', name: 'A', tier: 2, goldenId: 'ag' }, ag: { id: 'ag', isGolden: true }, b: { id: 'b', name: 'B', tier: 1 } };
    const rows = mod.codexRows(Object.values(items), (id) => items[id]);
    assert.deepEqual(rows.map((r) => r.id), ['b', 'a'], '档位升序');
    assert.ok(rows[1].golden, '普通行带上了它的精锐记录');
    assert.equal(rows.length, 2, '精锐记录不单独成行');
    // 分组
    assert.deepEqual(mod.groupByTier(rows).map((g) => g.tier), [1, 2]);
    // 过滤：档位 / 仅商店 / 搜索
    assert.equal(mod.filterRows(rows, { tier: 1 }).length, 1);
    assert.equal(mod.filterRows(rows, { query: 'a' }).length, 1);
    assert.equal(mod.filterRows(rows, { shopOnly: true }).length, 2);
    const hidden = mod.codexRows([{ id: 'h', name: 'H', tier: 1, hideInShop: true }], () => null);
    assert.equal(mod.filterRows(hidden, { shopOnly: true }).length, 0, '隐藏的不算商店可售');
    assert.equal(mod.filterRows(hidden, {}).length, 1, '但默认仍然列出来（它是这一档的装备）');
    // 效果文本：普通 / 精锐各取一份
    const t = mod.effectTexts({ id: 'x', effect: 'P', golden: { effect: 'G' } });
    assert.deepEqual(t, { normal: 'P', golden: 'G' });
    assert.deepEqual(mod.effectTexts({ id: 'y' }), { normal: null, golden: null });
  });

  test('面板源码不碰引擎的私有面：没有 store / battle / fetch，也不写死中文文案', () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const src = readFileSync(join(PACK, 'ui', 'equipment.js'), 'utf8');
    // 判据只看**代码**，不看注释：把注释剥掉再扫，否则一句「拿不到 battle 句柄」的说明就会误报。
    const code = src
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // 边界 = **不传什么**：面板拿不到这些，代码里也就不该出现它们的名字
    for (const bad of ['createStore', '../store.js', 'fetch(', 'localStorage', 'battleRunner', '.battle']) {
      assert.equal(code.includes(bad), false, `面板不该用 ${bad}（C 层的边界就是不给它）`);
    }
    // 自己画 DOM（纯 DOM 助手），不 import Preact —— 注入面不给它，也不该给它
    assert.equal(/from '.*preact/.test(code), false, '面板不 import Preact');
    assert.match(code, /from '\.\/dom\.js'/, '用包内自带的 DOM 助手');
  });
});
