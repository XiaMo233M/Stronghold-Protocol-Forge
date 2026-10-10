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

describe('fanpack 交付包：两个只读面板（G-12 的另一半，C 层）', () => {
  test('真装载路径：包认下、面板 2 条、0 拒绝，且各自声明了它要用的表', () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const { loaded, panels, cleanup } = loadOnce();
    try {
      assert.deepEqual(loaded.errors, [], '形状层 0 拒绝');
      const p = (loaded.packs || []).find((x) => x.id === 'fanpack-kazdel-rhodes');
      assert.ok(p, '包被认下');
      assert.equal(p.layer, 'B', '有服务端载荷 ⇒ 层推导为 B');
      assert.deepEqual(panels.errors, [], '面板层 0 拒绝');
      assert.equal(panels.panels.length, 2, '两条面板声明（装备总览 + 盟约策略）');
      const panel = panels.panels.find((p) => p.id === 'equipment');
      assert.ok(panel, '装备总览那条在');
      assert.equal(panel.slot, 'root.overlays', '浮层宿主：引擎按需创建，包不需要改 index.html');
      assert.deepEqual([...panel.data].sort(), ['assets', 'bonds', 'items'], '声明了它要读的表（读别的会被 CLIENT_DATA_UNDECLARED 点名）');
      assert.equal(panel.styles.length, 1, '自带样式表走同一条通道');
      assert.match(panel.url, /^\/workshop-panels\/fanpack-kazdel-rhodes\/ui\/equipment\.js/);
      const al = panels.panels.find((p) => p.id === 'alliances');
      assert.ok(al, '盟约策略那条在');
      assert.equal(al.slot, 'root.overlays');
      assert.deepEqual([...al.data].sort(), ['assets', 'bands', 'bonds', 'chess', 'items'], '盟约屏要读五张表');
      assert.match(al.url, /^\/workshop-panels\/fanpack-kazdel-rhodes\/ui\/alliances\.js/);
      // 两条声明共用同一份样式表：**按面板各注入一次**（注册点的键是面板键），所以是 2 个 `<link>`、
      // 指向同一个 URL（同一份字节、同一个 `?v=`）。
      assert.equal(al.styles[0].path, panel.styles[0].path, '两条面板共用一份 css');
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
          // 与引擎的 `browserSlotHost` 一致：同一个槽位**只建一次**，之后返回那一个（真实现先 querySelector 找已有的）。
          // 每次调用都新建一个的话，同一槽位上的多条面板会各自拿到不同的容器，测出来的结构就不是浏览器里的样子。
          if (!created.has(slot)) {
            const el = doc.createElement('div');
            el.setAttribute('data-mod-slot', slot);
            doc.body.appendChild(el);
            created.set(slot, el);
          }
          return created.get(slot);
        },
        slotHosts: () => [],
        env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
        // 面板声明了那几张表：这里给最小但真实的形状（空表也要能画出来，不能抛）
        data: { get: (name) => ({ items: {}, bonds: {}, bands: {}, chess: {}, assets: {} })[name] ?? null },
        onWrapsChanged: () => {},
      });
      const applied = registry.apply(panels.panels);
      assert.equal(applied.accepted, 2, '两条声明都被接受');
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(registry.refusals(), [], '0 拒绝');
      assert.deepEqual(registry.mounted(), ['fanpack-kazdel-rhodes/alliances', 'fanpack-kazdel-rhodes/equipment'], '两条面板都挂上了（键是 <包>/<面板id>）');
      const container = created.get('root.overlays');
      assert.ok(container, '浮层容器被按需创建');
      // 注册点在槽位容器里再造一层 `mod-panel` 包装，并把**那一层**当 `ctx.host` 交给面板。
      // 两条面板都挂这个槽位 ⇒ 容器里两层包装；按 `data-mod-panel` 认人。
      assert.equal(container.childNodes.length, 2, '两条面板各一层包装');
      const wrapperOf = (key) => container.childNodes.find((n) => n.getAttribute('data-mod-panel') === key);
      const wrapper = wrapperOf('fanpack-kazdel-rhodes/equipment');
      assert.ok(wrapper, '找到装备总览那层包装');
      assert.equal(wrapper.className, 'mod-panel', '包装层是 mod-panel');
      assert.equal(wrapper.childNodes.length, 1, '面板自己的根挂在包装里');
      assert.equal(countClass(wrapper, 'fx-cx__open'), 1, '默认是收起状态：一个「装备总览」按钮');
      const alWrapper = wrapperOf('fanpack-kazdel-rhodes/alliances');
      assert.equal(countClass(alWrapper, 'fx-al__open'), 1, '盟约策略也是收起状态：一个按钮');
      // 两条声明共用同一份样式表：**按面板各注入一次**（注册点的键是面板键），2 个 `<link>` 指向同一个 URL。
      const styleUrls = registry.styleUrls();
      assert.equal(styleUrls.length, 2, '两个面板各注入一次');
      assert.equal(new Set(styleUrls).size, 1, '全部指向同一份样式表');
      // 卸载：面板自己的节点要收干净
      registry.dispose();
      assert.equal(wrapper.childNodes.length, 0, 'dispose 后包装层里不留面板节点');
      assert.equal(alWrapper.childNodes.length, 0, '两条面板都要收干净');
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
          // 与引擎的 `browserSlotHost` 一致：同一个槽位**只建一次**，之后返回那一个（真实现先 querySelector 找已有的）。
          // 每次调用都新建一个的话，同一槽位上的多条面板会各自拿到不同的容器，测出来的结构就不是浏览器里的样子。
          if (!created.has(slot)) {
            const el = doc.createElement('div');
            el.setAttribute('data-mod-slot', slot);
            doc.body.appendChild(el);
            created.set(slot, el);
          }
          return created.get(slot);
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
      const wrapper = container.childNodes.find((n) => n.getAttribute('data-mod-panel') === 'fanpack-kazdel-rhodes/equipment');
      assert.ok(wrapper, '找到装备总览那层包装');
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

  test('盟约策略面板的纯模型函数：与原件同一套判据（分层 / 成员 / 装备 / 过滤）', async () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const al = await import(pathToFileURL(join(PACK, 'ui', 'alliances.js')).href);

    // 排序：核心盟约在前（按 bondOrder），附加在后
    const rows = al.bondRows([
      { bondId: 'add1', isCore: false, bondOrder: 1 },
      { bondId: 'core2', isCore: true, bondOrder: 2 },
      { bondId: 'core1', isCore: true, bondOrder: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.bond.bondId), ['core1', 'core2', 'add1']);
    assert.deepEqual(rows.map((r) => r.isCore), [true, true, false]);

    // 分层：有阈值就按阈值个数，没有就按 maxCount
    assert.deepEqual(al.bondLayers({ thresholds: [2, 4, 6] }), [0, 1, 2, 3]);
    assert.deepEqual(al.bondLayers({ maxCount: 3 }), [0, 1, 2, 3]);
    assert.deepEqual(al.bondLayers({}), [0, 1], '都没有 ⇒ 至少基础层 + 一层');
    assert.deepEqual(al.bondLayers({ maxCount: 99 }), Array.from({ length: 11 }, (_, i) => i), 'maxCount 夹在 10');

    // 每层的所需人数来自 thresholds[i-1]；基础层是 null
    const layers = al.bondLayerTexts({ thresholds: [2, 4], effectDescRaw: 'x{0}' });
    assert.deepEqual(layers.map((l) => l.need), [null, 2, 4]);

    // 成员按阶级排（数据里的次序不是按阶的）
    const members = al.bondMembers({ members: [5, 3] }, (id) => ({ id, name: `m${id}`, tier: id }));
    assert.deepEqual(members.map((m) => m.tier), [3, 5]);

    // 配套装备：只看非精锐且 giveBondId 命中的
    const eq = al.bondEquipment('b1', [
      { id: 'i1', tier: 2, giveBondId: 'b1' },
      { id: 'i2', tier: 1, giveBondId: 'b1' },
      { id: 'i3', tier: 1, giveBondId: 'other' },
      { id: 'i4', tier: 1, giveBondId: 'b1', isGolden: true },
    ]);
    assert.deepEqual(eq.map((i) => i.id), ['i2', 'i1'], '只留非精锐、按档位');

    // 生效阶段：只留有标签的
    assert.deepEqual(al.bondPhases([{ bond: { activeType: 'BATTLE' } }, { bond: { activeType: 'MANI' } }, { bond: { activeType: 'BATTLE' } }]), ['BATTLE']);

    // 过滤：核心 / 附加、阶段、自由搜索
    const fr = al.bondRows([
      { bondId: 'a', isCore: true, activeType: 'BATTLE', name: '卡兹戴尔' },
      { bondId: 'b', isCore: false, activeType: 'ALL', name: '罗德岛' },
    ]);
    assert.equal(al.filterBonds(fr, { core: true }).length, 1);
    assert.equal(al.filterBonds(fr, { core: false }).length, 1);
    assert.equal(al.filterBonds(fr, { phase: 'ALL' }).length, 1);
    assert.equal(al.filterBonds(fr, { query: '卡兹' }).length, 1);
    assert.equal(al.filterBonds(fr, { query: '不存在的词' }).length, 0);

    // 机变：按模式过滤
    const br = al.bandRows([{ bandId: 'x', sortId: 2 }, { bandId: 'y', sortId: 1 }]);
    assert.deepEqual(br.map((r) => r.band.bandId), ['y', 'x'], '按 sortId');
    // 模式过滤**只作用于有 modeTypeList 的记录**：没有那个字段的策略不会被这个筛选项排除（原件同一条判据）
    assert.equal(al.filterBands(br, { mode: 'MULTI' }, {}).length, 2, '没有 modeTypeList ⇒ 模式过滤不排除它');
    assert.equal(al.filterBands([{ band: { bandId: 'z', modeTypeList: ['MULTI'] } }], { mode: 'MULTI' }).length, 1);
    assert.equal(al.filterBands([{ band: { bandId: 'z', modeTypeList: ['LOCAL'] } }], { mode: 'MULTI' }).length, 0, '有不包含该模式的清单 ⇒ 排除');
  });

  test('效果文本格式化链（bondfmt.js）逐字等价：占位符、百分比、四位小数、层数型概率夹 100%', async () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const bf = await import(pathToFileURL(join(PACK, 'ui', 'bondfmt.js')).href);
    assert.equal(bf.formatPlaceholder(1.2345, '0.00'), '1.23');
    assert.equal(bf.formatPlaceholder(0.5, '0.0%'), '50.0%');
    assert.equal(bf.formatPlaceholder(-0.0001, '0'), '0', '不许出现 -0');
    assert.equal(bf.formatPlaceholder('nope', '0'), '?');
    assert.equal(bf.fillPlaceholders('a{0}b{1}', ['X', 'Y']), 'aXbY');
    assert.equal(bf.fillPlaceholders('a{9}', ['X']), 'a{9}', '不认识的索引原样留着');
    // bb[base] + bb[perStack] × layers
    const bond = { effectDescRaw: '{0}', effectDescParams: [{ index: 0, base: 'atk', perStack: 'per' }], bb: { atk: 10, per: 5 } };
    assert.equal(bf.formatBondEffect(bond, 0), '10');
    assert.equal(bf.formatBondEffect(bond, 3), '25');
    // 层数型概率：值夹在 1（sim 是 min(1, …)），**渲染格式来自 param 的 `format`**（没有就退成 `'0'`）。
    // 下面每一行都对着引擎 `public/js/ui/richText.js` 的同一个输入实测过（`_up/mod-compat/out/cmp-bondfmt.mjs`，6/6 等价）：
    // 没有 `format` 时引擎也输出 `'1'` —— 这不是移植的偏差，是本函数的既有行为（`formats[i] || fmt`）。
    const prob = { effectDescRaw: '{0}', effectDescParams: [{ index: 0, base: 'base_prob', perStack: 'prob_per_stack' }], bb: { base_prob: 0.5, prob_per_stack: 0.3 } };
    assert.equal(bf.formatBondEffect(prob, 0), '1', '无 format ⇒ 0 位小数；0.5 四舍五入成 1（与引擎一致）');
    assert.equal(bf.formatBondEffect(prob, 10), '1', '3.5 被夹在 1（与引擎一致）');
    const probPct = { ...prob, effectDescParams: [{ index: 0, base: 'base_prob', perStack: 'prob_per_stack', format: '0.0%' }] };
    assert.equal(bf.formatBondEffect(probPct, 0), '50.0%', 'param 给了格式就按它渲染');
    assert.equal(bf.formatBondEffect(probPct, 10), '100.0%', '超过 100% 要夹住');
  });

  test('面板源码不碰引擎的私有面：没有 store / battle / fetch，也不写死中文文案', () => {
    if (!HAS_PACK) return skip('本机没有 fanpack 交付包');
    const src = readFileSync(join(PACK, 'ui', 'alliances.js'), 'utf8');
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
