// test/modPluginPackDelivery.test.js — C 层注册点对着**业主侧那份真实交付包**跑一遍
// （`client.panels[]` 的九个宿主 / `wraps` / `styles` / `data` / `messages`，DESIGN §28.8 / §28.19）。
//
// 这份测试是**为改写插件包 v0.2.1 写的验证**，它钉的是「交付包真的能被装载器与客户端注册点吃下去」，
// 不是仓库自身的功能 —— 因此它有一条硬前置：**交付包不在本机就整体跳过**（照 `test/packMetaFanpack.test.js`
// 的既有做法：那份社区 mod 也不在仓库里，本机没有就 `assert.ok(true, '跳过')`）。
//
// 交付包的位置（业主侧，**不是仓库内容**、不进发行版）：
//   `E:\destop\harness_1\_up\mod-compat\deliver\packs\plugin-pack`
// 用环境变量 `SP_PLUGIN_PACK` 可以指到别处（一份解包后的副本）。
//
// 为什么这份验证必须存在（而不是只跑一个一次性脚本）：§28.8 的三层里，**服务端那一半**（装载、裁剪、
// 路由、welcome）与**纯逻辑那一半**（注册点的形状复判、宿主解析、能力判定、数据口）在本机都能真跑；
// 唯一跑不了的是**浏览器里真的 import 与真的渲染**（没有 Chrome —— `SP_E2E=1` 的可选路径，
// docs/WORKSHOP.md §4.4 的同一个 standing gap）。这份测试把前两者全部真跑。
//
// Run: node --test test/modPluginPackDelivery.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadWorkshop, loadWorkshopPanels, panelModuleIssues } from '../server/workshop.js';
import { workshopPanelFilesFor } from '../server/http/workshop.js';
import { normalizePackManifest } from '../shared/workshop.js';
import { createPanelRegistry, MOD_PANEL_SLOTS } from '../public/js/ui/extensions.js';
import { MOD_COMPONENT_IDS } from '../public/js/ui/modComponents.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 交付包（业主侧）。本机没有 ⇒ 全部跳过。 */
const PACK_DIR = process.env.SP_PLUGIN_PACK
  || 'E:\\destop\\harness_1\\_up\\mod-compat\\deliver\\packs\\plugin-pack';
const HAS_PACK = fs.existsSync(path.join(PACK_DIR, 'pack.json'));

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// 一个够用的**假 DOM**：注册点与包内面板只用到 createElement / appendChild / setAttribute /
// addEventListener / classList / querySelectorAll / remove 这几样。
// ---------------------------------------------------------------------------------------------------
function makeNode(tag = 'div') {
  const self = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    rel: '',
    href: '',
    value: '',
    textContent: '',
    disabled: false,
    style: {
      _m: new Map(),
      setProperty(k, v) { this._m.set(k, v); },
      getPropertyValue(k) { return this._m.get(k) || ''; },
      removeProperty(k) { this._m.delete(k); },
    },
    attrs: {},
    listeners: {},
    /** 面板模块用 `classList.toggle` 做开关态；一份够用的实现。 */
    get classList() {
      const list = () => String(self.className).split(/\s+/).filter(Boolean);
      return {
        add(c) { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
        remove(c) { self.className = list().filter((x) => x !== c).join(' '); },
        toggle(c, on) {
          const has = list().includes(c);
          const want = on === undefined ? !has : !!on;
          if (want && !has) self.className = [...list(), c].join(' ');
          else if (!want && has) self.className = list().filter((x) => x !== c).join(' ');
        },
        contains(c) { return list().includes(c); },
      };
    },
    addEventListener(type, fn) {
      if (!self.listeners[type]) self.listeners[type] = [];
      self.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const l = self.listeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    /** 判据用：真的把一个事件派发给这个节点上的监听器。 */
    dispatch(type, ev) {
      const base = { target: self, currentTarget: self, stopPropagation() {}, preventDefault() {} };
      for (const fn of [...(self.listeners[type] || [])]) fn(Object.assign(base, ev || {}));
    },
    setAttribute(k, v) { self.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(self.attrs, k) ? self.attrs[k] : null; },
    appendChild(child) { child.parentNode = self; self.children.push(child); return child; },
    append(...kids) { for (const k of kids) self.appendChild(k); },
    remove() {
      if (!self.parentNode) return;
      const i = self.parentNode.children.indexOf(self);
      if (i >= 0) self.parentNode.children.splice(i, 1);
      self.parentNode = null;
    },
    removeChild(child) {
      const i = self.children.indexOf(child);
      if (i >= 0) self.children.splice(i, 1);
      child.parentNode = null;
    },
    get firstChild() { return self.children[0] || null; },
    querySelectorAll(sel) { return descendants(self).filter((n) => matches(n, sel)); },
    querySelector(sel) { return self.querySelectorAll(sel)[0] || null; },
  };
  return self;
}

function descendants(node, out = []) {
  for (const c of node.children || []) { out.push(c); descendants(c, out); }
  return out;
}

function matches(node, sel) {
  const m = /^\[data-mod-slot="([^"]+)"\]$/.exec(sel);
  if (m) return node.getAttribute('data-mod-slot') === m[1];
  return false;
}

/** 一份够跑注册点的 document（`head` 收样式、`body` 收浮层宿主）。 */
function makeDocument() {
  const head = makeNode('head');
  const body = makeNode('body');
  const documentElement = makeNode('html');
  const all = (sel) => [...body.querySelectorAll(sel), ...documentElement.querySelectorAll(sel), ...head.querySelectorAll(sel)];
  return {
    head,
    body,
    documentElement,
    createElement: (tag) => makeNode(tag),
    createTextNode: (t) => { const n = makeNode('#text'); n.textContent = String(t); return n; },
    addEventListener(type, fn) { documentElement.addEventListener(type, fn); },
    removeEventListener(type, fn) { documentElement.removeEventListener(type, fn); },
    querySelector: (sel) => all(sel)[0] || null,
    querySelectorAll: (sel) => all(sel),
  };
}

let tmp = null;
let staged = null;

/**
 * 面板会在浏览器里起定时器、发 `/healthz`、写 `localStorage`。在 Node 里跑注册点时必须把这些替掉，
 * 否则一个 `setInterval` 会把测试进程钉住（`node --test` 等不到退出），一次真 `fetch` 会打到一个不存在的端口。
 * ⇒ 装一份**可控的**环境，并在卸载时全部还原。
 */
function installBrowserStubs() {
  const saved = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    innerWidth: globalThis.innerWidth,
    innerHeight: globalThis.innerHeight,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
  };
  /** 起过的定时器 id（面板的 `unmount` 应当把它们收回去）。 */
  const timers = new Set();
  let nextId = 1;
  globalThis.setInterval = () => { const id = nextId++; timers.add(id); return id; };
  globalThis.clearInterval = (id) => { timers.delete(id); };
  // `setTimeout` 保留真实现（注册点的挂载路径与面板的首帧都可能用到），但记录 id 以便收尾。
  const realSetTimeout = saved.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms, ...rest);
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) });
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  return {
    timers,
    restore() {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete globalThis[k];
        else globalThis[k] = saved[k];
      }
    },
  };
}

before(() => {
  if (!HAS_PACK) return;
  tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-pluginpack-'));
  staged = path.join(tmp, 'plugin-pack');
  fs.cpSync(PACK_DIR, staged, { recursive: true });
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** 本机没有那份交付包时跳过（它不是仓库内容）。 */
const skip = () => assert.ok(true, `本机没有那份交付包（${PACK_DIR}）—— 跳过这一条`);

/** 装载 + 服务表，一次拿齐（每条测试都用同一份装载结果）。 */
function loadOnce() {
  const loaded = loadWorkshop(tmp, { log: quiet });
  const pack = (loaded.packs || []).find((p) => p.id === 'plugin-pack');
  const panels = loadWorkshopPanels(loaded, { log: quiet });
  const files = workshopPanelFilesFor(panels.panels, tmp);
  return { loaded, pack, panels, files };
}

/** 一个 URL（带 `?v=`）在服务表里的键：**去掉查询串再解码**（`server/http/static.js` 就是比这个）。 */
const tableKey = (url) => decodeURIComponent(String(url).split('?')[0]);

describe('交付包：形状层与装载期的三处读者一致', () => {
  test('loadWorkshop 认下它，loadWorkshopPanels 0 拒绝，wraps 到了线上清单', () => {
    if (!HAS_PACK) return skip();
    const { loaded, pack, panels } = loadOnce();
    assert.ok(pack, '装载器必须认下这个包');
    assert.deepEqual(loaded.errors || [], [], '形状层 0 error');
    assert.equal(pack.layer, 'C', '它自带客户端界面 ⇒ 推导成 C 层');
    assert.deepEqual(panels.errors, [], '面板装载 0 拒绝');
    assert.ok(panels.panels.length >= 9, `声明了 9 个面板（实际 ${panels.panels.length}）`);
    for (const p of panels.panels) {
      assert.ok(MOD_PANEL_SLOTS.includes(p.slot), `${p.id} 的 slot 在闭枚举里`);
      assert.ok(p.url.startsWith('/workshop-panels/plugin-pack/'), `${p.id} 的 URL 走面板通道`);
    }
    const marks = panels.panels.find((p) => p.id === 'card-marks');
    assert.deepEqual(marks.wraps, [{ component: 'game.shopCard', mode: 'wrap' }]);
    assert.ok(MOD_COMPONENT_IDS.includes(marks.wraps[0].component), '组件名在客户端注册表里');
  });

  test('每个面板的 module 文件都真的在包目录里（面板模块判据）', () => {
    if (!HAS_PACK) return skip();
    const { pack } = loadOnce();
    const issues = panelModuleIssues(pack, staged);
    assert.deepEqual(issues, [], '没有「文件不在 / 不是 .js / 逃出包目录」');
  });

  test('服务表登记了模块与样式表，且只登记这些（路由不是文件服务器）', () => {
    if (!HAS_PACK) return skip();
    const { panels, files } = loadOnce();
    for (const p of panels.panels) {
      const abs = files.get(tableKey(p.url));
      assert.ok(typeof abs === 'string', `${p.id} 的模块 URL 被登记`);
      assert.ok(fs.existsSync(abs), `${p.id} 的模块文件在磁盘上`);
      for (const s of p.styles || []) {
        assert.ok(typeof files.get(tableKey(s.url)) === 'string', `${p.id} 的样式表 URL 被登记`);
      }
    }
    assert.equal(files.has('/workshop-panels/plugin-pack/pack.json'), false, 'pack.json 取不到');
  });

  test('形状层对交付包的原始声明是放行的（不是靠装载器兜着）', () => {
    if (!HAS_PACK) return skip();
    const raw = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
    const norm = normalizePackManifest(raw, 'plugin-pack', {});
    assert.equal(norm.ok, true, norm.detail);
  });

  test('i18n 四语种真的合并（74 键里 72 条新增，两条重叠按事实处理）', async () => {
    if (!HAS_PACK) return skip();
    const { mergeWorkshopI18n } = await import('../shared/workshop.js');
    const { panels } = loadOnce();
    const decl = panels.panels.length ? JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8')) : null;
    for (const code of Object.keys(decl.i18n)) {
      const ours = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', `${code}.json`), 'utf8'));
      const theirs = JSON.parse(fs.readFileSync(path.join(PACK_DIR, decl.i18n[code]), 'utf8'));
      const r = mergeWorkshopI18n(ours, theirs, { pack: 'plugin-pack', lang: code });
      assert.equal(r.ok, true, `${code}: ${r.detail}`);
      assert.equal(r.added.length, 72, `${code}: 74 键里 2 键引擎已有`);
      assert.equal(r.conflicts.length, code === 'en' ? 1 : 0, `${code}: 冲突条数`);
    }
  });
});

describe('交付包：C 层注册点真的把这些面板挂起来', () => {
  test('九个宿主都挂上，模块被真的 import，wraps 注册成链，样式注入一次', async () => {
    if (!HAS_PACK) return skip();
    const { panels, files } = loadOnce();
    const doc = makeDocument();
    const stubs = installBrowserStubs();
    globalThis.document = doc;
    try {
      /** 真的 import 包里的模块（Node 原生 ESM；浏览器那条路是 SP_E2E）。 */
      const importModule = (url) => {
        const abs = files.get(tableKey(url));
        assert.ok(abs, `模块 URL 必须在服务表里: ${url}`);
        return import(pathToFileURL(abs).href);
      };
      // 组件渲染出来的宿主：这里造一份（商店卡每张一个 `data-mod-slot-key`）。
      const cardHost = doc.createElement('span');
      cardHost.setAttribute('data-mod-slot-key', 'chess_test_1');
      // 后五个宿主**由组件自己渲染**（注册点只查不造）—— 所以这里替引擎的组件把它们的容器先渲染出来，
      // 正是引擎在真实渲染里做的事（`screens/game.js` / `bondStrip.js` / `detailPanel.js` 的 `[data-mod-slot]`）。
      const componentHosts = new Map();
      for (const slot of ['screen.game.hud', 'screen.game.overlay', 'screen.loadout.detail']) {
        const el = doc.createElement('span');
        el.setAttribute('data-mod-slot', slot);
        doc.body.appendChild(el);
        componentHosts.set(slot, el);
      }
      const created = new Map();
      const registry = createPanelRegistry({
        store: {
          get: () => ({ session: { preloadRequired: false, preloadReady: false } }),
          subscribe: () => () => {},
          patch: () => {},
        },
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
        // 引擎的 `browserSlotHosts` 是 `document.querySelectorAll('[data-mod-slot="…"]')`：
        // 浮层那条路由 `slotHost` 按需造，其余由组件渲染 ⇒ 这里把两者一起答出来。
        slotHosts: (slot) => {
          if (slot === 'screen.game.shopCard') return [cardHost];
          const rendered = componentHosts.get(slot);
          return rendered ? [rendered] : [];
        },
        env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
        data: { get: () => null },
        onWrapsChanged: () => {},
      });

      const applied = registry.apply(panels.panels);
      assert.equal(applied.accepted, panels.panels.length, '每一条声明都被接受');
      // 挂载是异步的（模块 import）⇒ 让微任务跑完。
      await new Promise((r) => setTimeout(r, 80));

      assert.deepEqual(registry.refusals(), [], '0 拒绝');
      const mounted = registry.mounted();
      assert.equal(mounted.length, panels.panels.length,
        `九个面板全部挂上（实际 ${mounted.length}：${mounted.join(', ')}）`);
      // 引擎**按需创建**的四个浮层宿主真的被建出来了（本包声明了其中三个）。
      for (const slot of ['root.overlays', 'root.guide']) {
        assert.ok(created.has(slot), `浮层宿主由注册点按需创建：${slot}`);
      }
      // 组件渲染出来的那三个宿主**没有**被凭空造出来（注册点只查不造）。
      assert.equal(created.has('screen.game.hud'), false, '组件宿主不该由注册点创建');
      // 可重复宿主：卡片那一个是带 hostKey 的那一份。
      assert.ok(mounted.some((k) => k === 'plugin-pack/card-marks#chess_test_1'),
        `商店卡宿主按 hostKey 区分：${mounted.filter((k) => k.includes('card-marks')).join(', ')}`);
      // `wraps` 真的注册成链（`wrapped()` 是引擎组件注册表视图）。
      assert.ok(registry.wrapped().includes('game.shopCard'), `组件链已注册：${registry.wrapped().join(', ')}`);
      // 样式表按**面板**各注入一次（`injectStylesOnce` 的键是面板键）—— 本包有 7 个面板声明了同一份 `.css`，
      // 所以这里应当是 7 个 `<link>`，全部指向**同一个** URL（同一份字节、同一个 `?v=`）。
      const styleUrls = registry.styleUrls();
      const declaredWithStyles = panels.panels.filter((p) => (p.styles || []).length).length;
      assert.equal(styleUrls.length, declaredWithStyles,
        `声明了样式表的面板各注入一次（${declaredWithStyles} 个面板）：${styleUrls.length}`);
      assert.equal(new Set(styleUrls).size, 1, `全部指向同一份样式表：${[...new Set(styleUrls)].join(', ')}`);
      // URL 带 `?v=<包摘要前 12 位>`（缓存键），所以判据是"查询串之前以 .css 结尾"。
      assert.ok(styleUrls[0].split('?')[0].endsWith('.css'), `样式表 URL：${styleUrls[0]}`);

      registry.dispose();
      assert.deepEqual(registry.mounted(), [], 'dispose 之后全部卸载');
      assert.equal(registry.styleUrls().length, 0, 'dispose 之后样式表被移除');
      assert.deepEqual(registry.wrapped(), [], 'dispose 之后组件链撤回');
      // 面板起的定时器必须被 `unmount` 收回去（一个包不许在页面上留下一个永远在跑的 interval）。
      assert.equal(stubs.timers.size, 0, `dispose 之后没有遗留定时器（剩 ${stubs.timers.size}）`);
    } finally {
      stubs.restore();
      delete globalThis.document;
    }
  });

  test('声明过的每个 module 文件都导出 mount / default / wrap 之一', async () => {
    if (!HAS_PACK) return skip();
    const raw = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
    const seen = new Set();
    for (const p of raw.client.panels) {
      seen.add(p.module);
      const mod = await import(pathToFileURL(path.join(PACK_DIR, p.module)).href);
      const hasMount = typeof mod.mount === 'function' || typeof mod.default === 'function';
      const hasWrap = typeof mod.wrap === 'function';
      assert.ok(hasMount || hasWrap, `${p.module} 必须导出 mount / default / wrap 之一`);
      if ((p.wraps || []).length) assert.ok(hasWrap, `${p.module} 声明了 wraps ⇒ 必须导出 wrap`);
    }
    assert.equal(seen.size, raw.client.panels.length, '每个面板一个模块文件');
  });

  test('只读数据口：只读声明过的表，写在自己的那一份上（第二个读者）', async () => {
    if (!HAS_PACK) return skip();
    const { panels, files } = loadOnce();
    const doc = makeDocument();
    const stubs = installBrowserStubs();
    globalThis.document = doc;
    try {
      const chessTable = { chess_a: { chessId: 'chess_a', name: 'A', visible: true } };
      /** 被面板真的读过的表。 */
      const read = [];
      // 声明了 `data` 的面板里，`card-marks` 挂的是**可重复宿主** ⇒ 必须给它一张卡，否则它根本挂不上，
      // 也就不会读到 `chess`（那会是一条假通过：数据口没被验到）。
      const cardHost = doc.createElement('span');
      cardHost.setAttribute('data-mod-slot-key', 'chess_test_1');
      const registry = createPanelRegistry({
        store: { get: () => ({}), subscribe: () => () => {}, patch: () => {} },
        net: { on: () => () => {}, send: () => true, sendResourceMessage: () => true },
        log: quiet,
        importModule: (url) => import(pathToFileURL(files.get(tableKey(url))).href),
        createElement: (tag) => doc.createElement(tag),
        slotHost: (slot) => { const el = doc.createElement('div'); el.setAttribute('data-mod-slot', slot); doc.body.appendChild(el); return el; },
        slotHosts: (slot) => (slot === 'screen.game.shopCard' ? [cardHost] : []),
        data: { get: (name) => { read.push(name); return name === 'chess' ? chessTable : null; } },
        env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
        onWrapsChanged: () => {},
      });
      registry.apply(panels.panels);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(registry.refusals(), [], '0 拒绝（声明过的表读得到，没声明的没人读）');
      // 声明过 `data` 的面板真的读到了那张表（`card-marks` 挂进每一张卡时读 `chess`）。
      assert.ok(read.includes('chess'), `声明过的表被真的读过（读过：${[...new Set(read)].join(', ') || '（无）'}）`);
      // 而且**只读声明过的表**：`bonds` / `notices` / `assets` 各自被它们自己的面板读过，没有越界读取。
      for (const name of read) {
        assert.ok(['chess', 'bonds', 'backups', 'enemies', 'notices', 'assets'].includes(name),
          `读的表必须是某个面板声明过的：${name}`);
      }
      registry.dispose();
      assert.equal(stubs.timers.size, 0, 'dispose 之后没有遗留定时器');
    } finally {
      stubs.restore();
      delete globalThis.document;
    }
  });
});
