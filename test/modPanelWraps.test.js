// test/modPanelWraps.test.js — 组件级改写：`pack.json.client.panels[].wraps`（DESIGN §28.19, docs/WORKSHOP.md §1.9.7）。
//
// 槽位（九个 `[data-mod-slot]` 宿主）只能表达「插进这个位置」。一个包要表达的是「**这个界面现在长得不一样了**」——
// 所以面板还可以**包裹**（`wrap`）或**替换**（`replace`）引擎的一个**具名组件**。本文件逐条钉住这件事：
//
//   1. 声明：`[{ component, mode }]`，闭枚举 + 三种点名拒绝码（`CLIENT_WRAP_UNKNOWN_COMPONENT` /
//      `CLIENT_WRAP_BAD_MODE` / `CLIENT_WRAP_BAD_SHAPE`），一条用不了的声明让**整个面板**落地不了；
//   2. 注册表：引擎组件经 `modComponent(id, impl)` 渲染（`impl` 就是今天那份实现），**没有任何包声明 wraps 时
//      渲染树逐字不变**（同一个 vnode、同一份 props、不多一层组件、不多一次快照）；
//   3. 语义：链的次序 = 既有面板比较器（order → 包 id → 面板 id，§28.3）；`wrap` 拿到下方那一份当 `orig`，
//      `replace` 拿到的 `orig` 是 `null`（它下方整段不再渲染），混合链是确定的；
//   4. 边界：改写拿到的 `ctx` = 面板那份冻结注入面 + `component` + `props`（这一帧的只读深拷贝），没有 store、
//      没有 engine、没有 Match/Battle；
//   5. 失败隔离：抛异常 / 什么都没返回 ⇒ 这一环退回它下面那一份并**点名一次**（`CLIENT_WRAP_THREW` /
//      `CLIENT_WRAP_NO_RENDER`），屏幕照旧；
//   6. 传输：`welcome.modPanels` 原样带出 `wraps`，模块 URL / 注册路径一字不动。
//
// 浏览器里真的 import + 真的渲染在本机跑不了（没有 Chrome）：那是 `SP_E2E=1` 的路径（docs/WORKSHOP.md §4.4）。
// **这里跑的是全部纯逻辑**：形状层、装载期、服务面、注册点、链的求值、失败隔离、注入面。
//
// Run: node --test test/modPanelWraps.test.js
import { describe, test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  normalizePackManifest, CLIENT_WRAP_COMPONENTS, CLIENT_WRAP_MODES, CLIENT_PANEL_SLOTS, WORKSHOP_PANEL_PREFIX,
} from '../shared/workshop.js';
import { loadWorkshop, loadWorkshopPanels } from '../server/workshop.js';
import { startServer } from '../server/index.js';
import { createStore, initialState } from '../public/js/store.js';
import { createPanelRegistry } from '../public/js/ui/extensions.js';
import {
  MOD_COMPONENT_IDS, MOD_WRAP_MODES, modComponent, setComponentWraps, clearComponentWraps,
  wrappedComponentIds, componentWrapLinks,
} from '../public/js/ui/modComponents.js';
import { h } from '../public/vendor/preact.module.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 一个够用的假 DOM：`root.overlays` 这一类浮层由注册点按需创建。 */
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
    render(slot) {
      const el = makeEl('div');
      el.setAttribute('data-mod-slot', slot);
      slots.set(slot, el);
      return el;
    },
    resolve: (slot) => slots.get(slot) || null,
    create: (tag) => { const el = makeEl(tag); created.push(el); return el; },
  };
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** 遍历一棵 vnode 树（只看已经造出来的节点；函数组件**不调用** —— 引擎组件在树里以 `vnode.type` 出现）。 */
function* walkVnodes(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walkVnodes(n); return; }
  if (!node || typeof node !== 'object') return;
  if (node.type !== undefined) yield node;
  const kids = node.props ? node.props.children : null;
  if (kids !== null && kids !== undefined && typeof kids === 'object') yield* walkVnodes(kids);
}

/** 已渲染树的形状：元素节点写成 `tag.class`，组件节点写成组件名（**不调用**它们：引擎组件的 hooks 只能在渲染里跑）。 */
const shapeOf = (vnode) => [...walkVnodes(vnode)].map((v) => (typeof v.type === 'string' ? `${v.type}${v.props?.class ? `.${v.props.class}` : ''}` : v.type.name));

// ---------------------------------------------------------------------------------------------------
// 引擎组件：`modComponent` 是定义引擎组件的唯一入口，测试用的实现走同一条路（真组件在 public/js/ui 里各自登记）。
// ---------------------------------------------------------------------------------------------------
/** 引擎这一份实现的每一次调用（引擎组件拿到的是哪一份 props，靠它钉）。 */
let engineProps = [];
const ENGINE_ID = 'game.bondStrip';
/** 引擎这一份实现（`modComponent` 拿到的第二个参数 —— 组件 id 与实现的对应关系就靠它）。 */
function engineImpl(props) {
  engineProps.push(props);
  return h('i', { class: 'engine' }, props.title);
}
const Engine = modComponent(ENGINE_ID, engineImpl);

beforeEach(() => {
  setComponentWraps(new Map());
  engineProps = [];
});

// ---------------------------------------------------------------------------------------------------
// 1. 一张表，两个读者：客户端组件表与 shared/workshop.js 的闭枚举逐字一致
// ---------------------------------------------------------------------------------------------------
describe('组件级改写：客户端组件表与形状层闭枚举一致（防止第二个会漂移的真相）', () => {
  test('两个 id 表、两个 mode 表逐字相同；组件命名空间与槽位命名空间不重叠', () => {
    assert.deepEqual(MOD_COMPONENT_IDS, [...CLIENT_WRAP_COMPONENTS]);
    assert.deepEqual(MOD_WRAP_MODES, [...CLIENT_WRAP_MODES]);
    assert.deepEqual([...CLIENT_WRAP_MODES], ['wrap', 'replace']);
    // 名字长得像但**不是**同一件事：`game.bondStrip` 是组件，`screen.game.bondStrip` 是它里面的容器。
    // 两个命名空间不许混用 —— 组件 id 出现在槽位枚举里（或反过来）就是一个作者一定会踩的坑。
    for (const id of CLIENT_WRAP_COMPONENTS) {
      assert.ok(!CLIENT_PANEL_SLOTS.includes(id), `${id} 不该同时是一个槽位`);
    }
    assert.ok(!CLIENT_WRAP_COMPONENTS.includes('screen.game.bondStrip'));
  });

  test("引擎的每一个具名组件在 public/js 里真的有一处 modComponent('<id>')，且没有一处是野的", () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(path.join(ROOT, 'public/js'));
    /** @type {Map<string, string[]>} */
    const calls = new Map();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const line of src.split('\n')) {
        // 注释里的示例（注册表自己的文件头就写着 `modComponent('<id>', impl)`）不是调用点。
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const m of line.matchAll(/modComponent\(\s*'([^']+)'/g)) {
          calls.set(m[1], [...(calls.get(m[1]) || []), rel]);
        }
      }
    }
    for (const id of MOD_COMPONENT_IDS) {
      assert.equal((calls.get(id) || []).length, 1, `${id} 必须恰好有一处 modComponent('${id}')（一个组件一处实现）`);
    }
    for (const [id, sites] of calls) {
      assert.ok(MOD_COMPONENT_IDS.includes(id), `${sites.join(', ')} 里的 "${id}" 不在闭枚举里（modComponent 会直接抛）`);
    }
    assert.equal(calls.size, MOD_COMPONENT_IDS.length, '登记的组件数 = 枚举数');
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 声明：形状层（三种点名拒绝码 + 进身份哈希）
// ---------------------------------------------------------------------------------------------------
describe('声明：client.panels[].wraps', () => {
  const norm = (panel) => normalizePackManifest({ id: 'p', client: { panels: [panel] } }, 'p', {});
  const panel = (wraps) => ({ id: 'p1', slot: 'root.overlays', module: 'ui/a.js', wraps });

  test('合法声明：按组件名排序进清单（键序是清单字节的一部分）；不声明就不多这个键', () => {
    const r = norm(panel([{ component: 'game.hud.topBar', mode: 'wrap' }, { component: 'game.bondStrip', mode: 'replace' }]));
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.client.panels[0].wraps, [
      { component: 'game.bondStrip', mode: 'replace' },
      { component: 'game.hud.topBar', mode: 'wrap' },
    ]);
    // 两种书写次序 ⇒ 同一份字节
    const other = norm(panel([{ component: 'game.bondStrip', mode: 'replace' }, { component: 'game.hud.topBar', mode: 'wrap' }]));
    assert.equal(JSON.stringify(other.pack.client.panels), JSON.stringify(r.pack.client.panels));
    // 不声明 ⇒ 归一化清单里**不得**多出这个键（否则所有既有包的摘要都会变，§28.2）
    const plain = norm({ id: 'p1', slot: 'root.overlays', module: 'ui/a.js' });
    assert.equal(plain.ok, true, plain.detail);
    assert.deepEqual(plain.pack.client.panels, [{ id: 'p1', slot: 'root.overlays', module: 'ui/a.js' }]);
    assert.equal('wraps' in plain.pack.client.panels[0], false);
  });

  test('未知组件：CLIENT_WRAP_UNKNOWN_COMPONENT，理由里列出全部合法 id', () => {
    const r = norm(panel([{ component: 'game.hud.nope', mode: 'wrap' }]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'CLIENT_WRAP_UNKNOWN_COMPONENT');
    for (const id of CLIENT_WRAP_COMPONENTS) assert.ok(r.detail.includes(id), `${r.detail} 少了 ${id}`);
    assert.ok(r.detail.includes('game.hud.nope'), '理由里点名那个坏值');
  });

  test('坏 / 缺 mode：CLIENT_WRAP_BAD_MODE（大小写写错也算）', () => {
    for (const mode of ['banana', 'Wrap', 'REPLACE', undefined, 3, null]) {
      const r = norm(panel([{ component: 'game.bondStrip', mode }]));
      assert.equal(r.ok, false, `mode=${JSON.stringify(mode)}`);
      assert.equal(r.error, 'CLIENT_WRAP_BAD_MODE', `mode=${JSON.stringify(mode)} → ${r.error}`);
      assert.ok(r.detail.includes('game.bondStrip'));
      assert.ok(r.detail.includes('wrap') && r.detail.includes('replace'));
    }
  });

  test('坏形状：CLIENT_WRAP_BAD_SHAPE（不是数组 / 空数组 / 条目不是对象 / 未知键 / 重复 / 超上限 / component 不是字符串）', () => {
    const cases = [
      ['不是数组', 'ui/a.js'],
      ['空数组', []],
      ['条目不是对象', [7]],
      ['缺 component', [{ mode: 'wrap' }]],
      ['component 不是字符串', [{ component: 7, mode: 'wrap' }]],
      ['条目里的未知键', [{ component: 'game.bondStrip', mode: 'wrap', css: 'x' }]],
      ['同一个组件两条', [{ component: 'game.bondStrip', mode: 'wrap' }, { component: 'game.bondStrip', mode: 'replace' }]],
      ['超过组件数（9 条）', Array.from({ length: 9 }, () => ({ component: CLIENT_WRAP_COMPONENTS[0], mode: 'wrap' }))],
    ];
    for (const [why, wraps] of cases) {
      const r = norm(panel(wraps));
      assert.equal(r.ok, false, why);
      assert.equal(r.error, 'CLIENT_WRAP_BAD_SHAPE', `${why} → ${r.error} (${r.detail})`);
      assert.ok(r.detail.includes('p1'), `${why}: 理由要点名面板`);
    }
  });

  test('进身份哈希：只有 mode 不同 ⇒ 两个摘要（声明能改变客户端行为，就必须在哈希里）', () => {
    const hashOf = (wraps) => {
      const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-wraps-hash-'));
      const dir = path.join(root, 'ident');
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'ident', version: '0.1.0', license: 'CC0-1.0',
        client: { panels: [{ id: 'p1', slot: 'root.overlays', module: 'ui/a.js', wraps }] },
      }));
      fs.writeFileSync(path.join(dir, 'ui/a.js'), 'export function wrap() { return (orig) => orig; }\n');
      const loaded = loadWorkshop(root, { log: quiet });
      assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
      fs.rmSync(root, { recursive: true, force: true });
      return loaded.packs[0].hash;
    };
    const wrap = hashOf([{ component: 'game.bondStrip', mode: 'wrap' }]);
    const replace = hashOf([{ component: 'game.bondStrip', mode: 'replace' }]);
    assert.notEqual(wrap, replace, 'wrap 与 replace 是两种行为，不能共用一个摘要');
    assert.equal(hashOf([{ component: 'game.bondStrip', mode: 'wrap' }]), wrap, '同一份声明两次装载 ⇒ 同一个摘要');
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. 装载期 + 传输：整包被拒 / 原样带出 / URL 一字不动 / welcome
// ---------------------------------------------------------------------------------------------------
const MODULE_JS = 'export function mount() {}\nexport function wrap(ctx) { return (orig) => orig; }\n';
let tmp;

/** 一个只放一份 pack.json（+ 可选文件）的临时工坊根。 */
function packRoot(id, pack, files = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-wraps-root-'));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, version: '0.1.0', ...pack }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return root;
}

/** 一个声明了 wraps 的包目录（写在临时工坊里）。 */
function writePack(root, id, wraps, file = 'ui/a.js') {
  const dir = path.join(root, id);
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, version: '0.1.0', license: 'CC0-1.0',
    client: { panels: [{ id: 'p1', slot: 'root.overlays', module: file, wraps }] },
  }));
  fs.writeFileSync(path.join(dir, file), MODULE_JS);
}

before(() => { tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-wraps-ws-')); });
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('装载期：用不了的 wraps 声明拒整包；合法的照旧是 C 层', () => {
  test('合法：包进已加载集合、层级 C、wraps 归一化后就在 pack.client 上', () => {
    const root = packRoot('wrap-pack', {
      license: 'CC0-1.0',
      client: {
        panels: [{
          id: 'hud-badge', slot: 'root.overlays', module: 'ui/badge.js',
          wraps: [{ component: 'game.hud.topBar', mode: 'wrap' }, { component: 'game.bondStrip', mode: 'replace' }],
        }],
      },
    }, { 'ui/badge.js': MODULE_JS });
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const pack = loaded.packs[0];
    assert.equal(pack.layer, 'C');
    assert.equal(pack.combat, false, '组件级改写改不了对局结果（与面板同一条边界）');
    assert.deepEqual(pack.client.panels[0].wraps, [
      { component: 'game.bondStrip', mode: 'replace' },
      { component: 'game.hud.topBar', mode: 'wrap' },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('不可用：未知组件 / 坏 mode / 坏形状 ⇒ **整个包**被拒（不是「加载了但改写没生效」）', () => {
    const cases = [
      ['unknown', [{ component: 'game.nope', mode: 'wrap' }], 'CLIENT_WRAP_UNKNOWN_COMPONENT'],
      ['mode', [{ component: 'game.bondStrip', mode: 'x' }], 'CLIENT_WRAP_BAD_MODE'],
      ['missing-mode', [{ component: 'game.bondStrip' }], 'CLIENT_WRAP_BAD_MODE'],
      ['empty', [], 'CLIENT_WRAP_BAD_SHAPE'],
    ];
    for (const [label, wraps, code] of cases) {
      const root = fs.mkdtempSync(path.join(tmp, `bad-${label}-`));
      writePack(root, label, wraps);
      const loaded = loadWorkshop(root, { log: quiet });
      assert.equal(loaded.packs.length, 0, `${label}: 整包被拒`);
      assert.equal(loaded.errors.length, 1, `${label}: ${JSON.stringify(loaded.errors)}`);
      assert.match(loaded.errors[0].reason, new RegExp(code), label);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('传输：welcome.modPanels 原样带出 wraps，模块 URL / 注册路径一字不动', () => {
  test('清单：wraps 逐字透传；没声明的面板不多这个字段；URL 仍是 /workshop-panels/', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'ws-'));
    writePack(root, 'wrap-pack', [{ component: 'game.hud.topBar', mode: 'wrap' }]);
    fs.mkdirSync(path.join(root, 'plain-pack/ui'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plain-pack/pack.json'), JSON.stringify({
      id: 'plain-pack', version: '0.1.0', license: 'CC0-1.0',
      client: { panels: [{ id: 'note', slot: 'root.guide', module: 'ui/note.js' }] },
    }));
    fs.writeFileSync(path.join(root, 'plain-pack/ui/note.js'), MODULE_JS);

    const { panels, errors } = loadWorkshopPanels(loadWorkshop(root, { log: quiet }), { log: quiet });
    assert.deepEqual(errors, []);
    const badge = panels.find((p) => p.id === 'p1');
    assert.deepEqual(badge.wraps, [{ component: 'game.hud.topBar', mode: 'wrap' }]);
    assert.equal(badge.url, `${WORKSHOP_PANEL_PREFIX}wrap-pack/ui/a.js?v=${badge.hash.slice(0, 12)}`);
    assert.match(badge.url, /^\/workshop-panels\/wrap-pack\/ui\/a\.js\?v=[0-9a-f]{12}$/);
    assert.equal('wraps' in panels.find((p) => p.pack === 'plain-pack'), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('真握手：welcome.modPanels 里那一份带 wraps', async () => {
    const root = fs.mkdtempSync(path.join(tmp, 'wsw-'));
    writePack(root, 'wrap-pack', [{ component: 'game.shopCard', mode: 'replace' }]);
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
    /** @type {any} */
    let client = null;
    try {
      client = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
      const welcome = await client.hello('改写博士');
      assert.equal(welcome.modPanels.length, 1);
      assert.deepEqual(welcome.modPanels[0].wraps, [{ component: 'game.shopCard', mode: 'replace' }]);
      assert.equal(welcome.modPanels[0].pack, 'wrap-pack');
    } finally {
      if (client) { try { await client.close(); } catch { /* already closed */ } }
      await srv.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. 注册点与链（纯逻辑，Node 里真跑）
// ---------------------------------------------------------------------------------------------------
/** 一个模块：`wrap(ctx)` 记下 ctx，返回一个把 `orig` 包在 `<div class="marker">` 里的渲染函数。 */
function wrapModule(marker, opts = {}) {
  const mod = {
    wrap: (ctx) => {
      if (opts.throwAt === 'factory') throw new Error('factory boom');
      if (opts.ctxs) opts.ctxs.push(ctx);
      if (opts.notAFunction) return 'nope';
      return (orig) => {
        if (opts.throwAt === 'render') throw new Error('render boom');
        if (opts.nothing) return undefined;
        return h('div', { class: marker, 'data-component': ctx.component, 'data-title': ctx.props?.title ?? null }, orig);
      };
    },
  };
  if (opts.mount) mod.mount = () => ({ unmount() {} });
  return mod;
}

/** 一个记录一切的注册点工厂（与 test/modClientPanels.test.js 的 harness 同形，多一个 onWrapsChanged）。 */
function harness({ modules = new Map(), hosts = new Map() } = {}) {
  const store = createStore(initialState);
  const dom = fakeDom();
  const imported = [];
  const logs = [];
  const rerenders = [];
  const registry = createPanelRegistry({
    store,
    net: { on: () => () => {}, sendResourceMessage: () => true },
    log: { info() {}, warn() {}, error: (...a) => logs.push(String(a[1] ?? a[0])) },
    notify: () => {},
    importModule: async (url) => { imported.push(url); return modules.has(url) ? modules.get(url) : { mount() {} }; },
    createElement: (tag) => dom.create(tag),
    slotHost: (slot) => dom.resolve(slot) || dom.render(slot),
    slotHosts: (slot) => hosts.get(slot) || [],
    env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
    onWrapsChanged: (links) => rerenders.push(links),
  });
  return { store, dom, registry, imported, logs, rerenders };
}

const URL_A = `${WORKSHOP_PANEL_PREFIX}alpha/a.js?v=1`;
const URL_B = `${WORKSHOP_PANEL_PREFIX}beta/b.js?v=1`;
const URL_C = `${WORKSHOP_PANEL_PREFIX}gamma/g.js?v=1`;
const wire = (over = {}) => ({
  id: 'p1', pack: 'alpha', slot: 'root.overlays', url: URL_A,
  order: 0, gate: null, requires: [], wraps: [{ component: ENGINE_ID, mode: 'wrap' }], ...over,
});

describe('没有声明 = 什么都没有：链是空的，引擎渲染的就是今天那一份', () => {
  test('空清单：不 import 包模块、不建 DOM、不重画、组件直通实现（同一个 vnode、同一份 props）', async () => {
    const h1 = harness();
    for (const list of [[], null, undefined]) h1.registry.apply(list);
    await settle();
    assert.deepEqual(h1.imported, []);
    assert.deepEqual(h1.dom.created, []);
    assert.deepEqual(h1.rerenders, []);
    assert.deepEqual(wrappedComponentIds(), []);
    assert.deepEqual(h1.registry.wrapped(), []);
    assert.equal(h1.dom.resolve('root.overlays'), null, '没有改写就没有容器');
    // 引擎组件：返回的**就是**实现那一份 vnode，props 也**就是**引擎给的那一份（同一性，不是相等）
    const props = { title: 'x' };
    const out = Engine(props);
    assert.equal(engineProps.length, 1);
    assert.equal(engineProps[0], props);
    assert.equal(out.type, 'i');
    assert.equal(out.props.class, 'engine');
  });

  test('一个不声明 wraps 的面板照旧挂载（今天的行为一字不改），但链是空的、不重画', async () => {
    const h1 = harness();
    const res = h1.registry.apply([wire({ wraps: undefined })]);
    assert.equal(res.accepted, 1);
    await settle();
    assert.deepEqual(h1.registry.mounted(), ['alpha/p1'], '挂载那条路一个字节没变');
    assert.deepEqual(h1.rerenders, [], '没有链就没有重画');
    assert.deepEqual(h1.registry.wrapped(), []);
    assert.deepEqual(shapeOf(Engine({ title: 'x' })), ['i.engine'], '引擎组件在树里还是它自己那份实现（没有多一层组件边界）');
  });

  test('客户端复判「空数组」与形状层同一个码：`wraps: []` 是坏声明，不是「没声明」', async () => {
    const h1 = harness();
    assert.equal(h1.registry.apply([wire({ wraps: [] })]).accepted, 0);
    await settle();
    assert.deepEqual(h1.imported, []);
    assert.deepEqual(h1.registry.mounted(), []);
    assert.deepEqual(h1.registry.refusals().map((r) => r.code), ['CLIENT_WRAP_BAD_SHAPE']);
  });

  test('setComponentWraps 是「链真的变了」的唯一判据（同一份链重复注册不重画）', () => {
    const link = { pack: 'alpha', panel: 'p1', component: ENGINE_ID, mode: 'wrap' };
    assert.equal(setComponentWraps(new Map([[ENGINE_ID, [link]]])), true);
    assert.equal(setComponentWraps(new Map([[ENGINE_ID, [link]]])), false, '同一份链不通知重画');
    assert.deepEqual(wrappedComponentIds(), [ENGINE_ID]);
    assert.deepEqual(componentWrapLinks(ENGINE_ID), [{ pack: 'alpha', panel: 'p1', mode: 'wrap' }]);
    clearComponentWraps();
    assert.deepEqual(wrappedComponentIds(), []);
  });
});

describe('链：次序 = 既有面板比较器；wrap 合成、replace 换掉、混合链确定', () => {
  test('两个包改同一个组件：order 小的在内层；与数组次序、发现次序都无关', async () => {
    const mods = new Map([[URL_A, wrapModule('a')], [URL_B, wrapModule('b')]]);
    const h1 = harness({ modules: mods });
    // beta 先到、order 更大 ⇒ 它在外层
    h1.registry.apply([
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 10 }),
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 0 }),
    ]);
    await settle();
    assert.deepEqual(h1.registry.wrapped(), [ENGINE_ID], '两条链挂在同一个组件上');
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.b', 'div.a', 'engineImpl']);
    assert.deepEqual(h1.rerenders, [2], '两个 wrap 链接 ⇒ 通知一次重画，带链接数');
    // 同一份声明换个数组次序：结果一字不差（次序来自 order / 包 id，不是到达次序）
    const h2 = harness({ modules: mods });
    h2.registry.apply([
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 0 }),
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 10 }),
    ]);
    await settle();
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.b', 'div.a', 'engineImpl']);
    // order 相同 ⇒ 包 id 小的在内层（§28.3 的同一条比较器）
    const h3 = harness({ modules: mods });
    h3.registry.apply([
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 5 }),
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 5 }),
    ]);
    await settle();
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.b', 'div.a', 'engineImpl']);
    // order 反过来 ⇒ 链也反过来（order 真的说了算）
    const h4 = harness({ modules: mods });
    h4.registry.apply([
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 0 }),
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 10 }),
    ]);
    await settle();
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'div.b', 'engineImpl']);
  });

  test('内层拿到的是引擎的 vnode（类型是实现本身、props 是引擎那一份）', async () => {
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')]]) });
    h1.registry.apply([wire()]);
    await settle();
    const tree = Engine({ title: 'T' });
    const nodes = [...walkVnodes(tree)];
    assert.deepEqual(nodes.map((v) => v.type), ['div', engineImpl]);
    assert.equal(nodes[1].props.title, 'T', '引擎组件拿到的 props 就是引擎自己的那一份');
    assert.equal(nodes[0].props.class, 'a');
    assert.equal(nodes[0].props['data-component'], ENGINE_ID, 'ctx.component 说明这条链改的是哪一个组件');
  });

  test('replace：orig 是 null，下方整段（引擎实现 + 内层 wrap）不再渲染，链从它的结果继续', async () => {
    const seen = [];
    const replaceModule = { wrap: () => (orig) => { seen.push(orig); return h('div', { class: 'replaced' }); } };
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')], [URL_B, replaceModule]]) });
    h1.registry.apply([
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 0 }),
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 10, wraps: [{ component: ENGINE_ID, mode: 'replace' }] }),
    ]);
    await settle();
    const tree = Engine({ title: 'T' });
    assert.deepEqual(seen, [null], 'replace 档拿到的 orig 是 null —— 引擎，而不是作者，决定下方不再渲染');
    assert.deepEqual(shapeOf(tree), ['div.replaced'], '内层 wrap 与引擎实现都不在了');
  });

  test('混合链 wrap → replace → wrap：外层的 orig 是 replace 的结果，中间那一段整段丢掉', async () => {
    const h1 = harness({
      modules: new Map([
        [URL_A, wrapModule('a')],
        [URL_B, { wrap: () => (orig) => { assert.equal(orig, null); return h('div', { class: 'b' }); } }],
        [URL_C, wrapModule('c')],
      ]),
    });
    h1.registry.apply([
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 0 }),
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 10, wraps: [{ component: ENGINE_ID, mode: 'replace' }] }),
      wire({ pack: 'gamma', id: 'pg', url: URL_C, order: 20 }),
    ]);
    await settle();
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.c', 'div.b'], 'a 与引擎都不在，最外层是 c');
  });

  test('声明的槽位容器还没渲染 ⇒ 改写照旧注册（改写挂在组件上，与容器无关）', async () => {
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')]]), hosts: new Map() });
    h1.registry.apply([wire({ slot: 'screen.game.bondStrip' })]); // 组件渲染的宿主：此刻还没有
    await settle();
    assert.deepEqual(h1.registry.mounted(), [], '容器不存在 ⇒ 不挂（槽位那条路今天的行为）');
    assert.deepEqual(h1.registry.refusals(), [], '「还没到时候」不是失败');
    assert.deepEqual(h1.registry.wrapped(), [ENGINE_ID], '改写不靠容器：它挂在组件上');
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'engineImpl']);
  });

  test('一个面板声明两个组件：两条链互不影响，各自按同一份次序', async () => {
    const other = modComponent('game.shopCard', function Item(props) { return h('b', { class: 'card' }, props.id); });
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')]]) });
    h1.registry.apply([wire({
      wraps: [{ component: ENGINE_ID, mode: 'wrap' }, { component: 'game.shopCard', mode: 'wrap' }],
    })]);
    await settle();
    assert.deepEqual(h1.registry.wrapped(), ['game.bondStrip', 'game.shopCard']);
    assert.deepEqual(shapeOf(other({ id: 'x' })), ['div.a', 'Item']);
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'engineImpl']);
  });
});

describe('边界：改写拿到的 ctx 是面板那份 + component + props（只读快照）', () => {
  test('键集合 = 面板那 11 个 + component + props；没有 store / engine / match；host 与 hostKey 是 null', async () => {
    const ctxs = [];
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a', { ctxs })]]) });
    h1.registry.apply([wire()]);
    await settle();
    Engine({ title: 'T' });
    assert.equal(ctxs.length, 1, 'wrap(ctx) 每次渲染调用一次');
    const ctx = ctxs[0];
    assert.deepEqual(Object.keys(ctx).sort(), [
      'component', 'data', 'gate', 'host', 'hostKey', 'id', 'log', 'me', 'net', 'order', 'pack', 'props', 'session', 'slot',
    ]);
    assert.equal(ctx.component, ENGINE_ID);
    assert.equal(ctx.id, 'p1');
    assert.equal(ctx.pack, 'alpha');
    assert.equal(ctx.slot, 'root.overlays');
    assert.equal(ctx.host, null, '改写没有宿主可挂');
    assert.equal(ctx.hostKey, null);
    assert.ok(Object.isFrozen(ctx));
    assert.ok(Object.isFrozen(ctx.session) && Object.isFrozen(ctx.net) && Object.isFrozen(ctx.log) && Object.isFrozen(ctx.data));
    assert.equal(ctx.store, undefined, '不给 store');
    assert.equal(ctx.engine, undefined);
    assert.equal(ctx.match, undefined);
    // 每次渲染一个 ctx（props 是这一帧的）
    Engine({ title: 'T2' });
    assert.equal(ctxs.length, 2);
    assert.equal(ctxs[1].props.title, 'T2');
  });

  test('props 是冻结的深拷贝，与引擎自己那份**脱钩**：改它一个字节都改不到引擎的', async () => {
    const ctxs = [];
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a', { ctxs })]]) });
    h1.registry.apply([wire()]);
    await settle();
    const props = { title: 'T', nested: { list: [1, 2], deep: { ok: true } } };
    Engine(props);
    const snap = ctxs[0].props;
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.nested) && Object.isFrozen(snap.nested.list) && Object.isFrozen(snap.nested.deep));
    assert.notEqual(snap, props);
    assert.notEqual(snap.nested, props.nested);
    assert.notEqual(snap.nested.list, props.nested.list);
    assert.deepEqual(snap, props, '内容一样（是一份深拷贝，不是一个空对象）');
    assert.throws(() => { snap.title = 'x'; }, TypeError, '冻结：写不进去');
    assert.throws(() => { snap.nested.list.push(3); }, TypeError);
    assert.throws(() => { snap.nested.deep.ok = false; }, TypeError);
    assert.equal(props.title, 'T');
    assert.deepEqual(props.nested.list, [1, 2], '引擎自己那份一个字节没动');
    assert.equal(props.nested.deep.ok, true);
  });
});

describe('失败隔离：一个写坏的包不能把屏幕弄没', () => {
  test('wrap 抛异常（工厂 / 渲染两处）⇒ 渲染引擎自己那一份，点名一次', async () => {
    for (const throwAt of ['factory', 'render']) {
      setComponentWraps(new Map());
      const h1 = harness({ modules: new Map([[URL_A, wrapModule('a', { throwAt })]]) });
      h1.registry.apply([wire()]);
      await settle();
      assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['engineImpl'], `${throwAt}: 屏幕是引擎那一份`);
      Engine({ title: 'T' });
      Engine({ title: 'T' });
      const thrown = h1.registry.refusals().filter((r) => r.code === 'CLIENT_WRAP_THREW');
      assert.equal(thrown.length, 1, `${throwAt}: 只点名一次（渲染三次也只报一条）`);
      assert.match(thrown[0].detail, /alpha\/p1/, '理由里点名牌与面板');
      assert.ok(thrown[0].detail.includes(ENGINE_ID), '并说明改的是哪一个组件');
    }
  });

  test('渲染返回 null / undefined，或 wrap 返回的不是函数 ⇒ 退回下方那一份，CLIENT_WRAP_NO_RENDER 点名一次', async () => {
    const cases = [
      ['null render', { nothing: true }],
      ['not a function', { notAFunction: true }],
    ];
    for (const [label, opts] of cases) {
      setComponentWraps(new Map());
      const h1 = harness({ modules: new Map([[URL_A, wrapModule('a', opts)]]) });
      h1.registry.apply([wire()]);
      await settle();
      assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['engineImpl'], label);
      Engine({ title: 'T' });
      const hits = h1.registry.refusals().filter((r) => r.code === 'CLIENT_WRAP_NO_RENDER');
      assert.equal(hits.length, 1, `${label}: 只点名一次`);
      assert.match(hits[0].detail, /alpha\/p1/);
    }
  });

  test('外层的包坏了，内层的改写照旧生效（退回的是**它下面那一份**，不是整屏）', async () => {
    const h1 = harness({
      modules: new Map([[URL_A, wrapModule('a')], [URL_B, wrapModule('b', { throwAt: 'render' })]]),
    });
    h1.registry.apply([
      wire({ pack: 'alpha', id: 'pa', url: URL_A, order: 0 }),
      wire({ pack: 'beta', id: 'pb', url: URL_B, order: 10 }),
    ]);
    await settle();
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'engineImpl']);
    assert.equal(h1.registry.refusals().filter((r) => r.code === 'CLIENT_WRAP_THREW').length, 1);
  });

  test('模块没有 wrap 导出 ⇒ CLIENT_WRAP_NO_EXPORT，整个面板不落地（连 mount 都不调）', async () => {
    let mounted = 0;
    const h1 = harness({ modules: new Map([[URL_A, { mount: () => { mounted++; return {}; } }]]) });
    const res = h1.registry.apply([wire()]);
    assert.equal(res.accepted, 1, '声明本身合法：拒绝发生在装载期');
    await settle();
    assert.equal(mounted, 0, '一半的改写不存在：槽位也不挂');
    assert.deepEqual(h1.registry.mounted(), []);
    assert.deepEqual(wrappedComponentIds(), []);
    const hits = h1.registry.refusals().filter((r) => r.code === 'CLIENT_WRAP_NO_EXPORT');
    assert.equal(hits.length, 1);
    assert.match(hits[0].detail, /alpha\/p1/);
  });

  test('只改写、没有 mount 的模块：不点名、不建容器，链照常生效', async () => {
    let appended = 0;
    const hosts = new Map([['screen.game.hud', [{ appendChild() { appended++; } }]]]);
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')]]), hosts });
    h1.registry.apply([wire({ slot: 'screen.game.hud' })]);
    await settle();
    assert.deepEqual(h1.registry.refusals(), [], '声明只改写不是坏声明');
    assert.deepEqual(h1.registry.mounted(), [], '没有 mount 就不算挂上了');
    assert.deepEqual(h1.dom.created, [], '也不建那个空容器');
    assert.equal(appended, 0);
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'engineImpl']);
  });

  test('既挂又改：两件事都做，模块只 import 一次', async () => {
    let mounted = 0;
    const h1 = harness({ modules: new Map([[URL_A, { ...wrapModule('a'), mount: () => { mounted++; return { unmount() {} }; } }]]) });
    h1.registry.apply([wire()]);
    await settle();
    assert.equal(mounted, 1);
    assert.deepEqual(h1.registry.mounted(), ['alpha/p1']);
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'engineImpl']);
    assert.deepEqual(h1.imported, [URL_A], '同一个面板的模块只 import 一次（挂载那条路复用改写那条的模块对象）');
  });

  test('gate 关着 ⇒ 连模块都不 import；开了才注册链', async () => {
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')]]) });
    h1.registry.apply([wire({ gate: 'session.preloadRequired' })]);
    await settle();
    assert.deepEqual(h1.imported, []);
    assert.deepEqual(wrappedComponentIds(), []);
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['i.engine'], '闸门关着时引擎照旧');
    h1.store.patch('session', { preloadRequired: true });
    await settle();
    assert.deepEqual(wrappedComponentIds(), [ENGINE_ID]);
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['div.a', 'engineImpl']);
  });

  test('dispose：链撤回，引擎回到自己那一份', async () => {
    const h1 = harness({ modules: new Map([[URL_A, wrapModule('a')]]) });
    h1.registry.apply([wire()]);
    await settle();
    assert.deepEqual(h1.registry.wrapped(), [ENGINE_ID]);
    h1.registry.dispose();
    assert.deepEqual(wrappedComponentIds(), []);
    assert.deepEqual(h1.registry.wrapped(), []);
    assert.deepEqual(shapeOf(Engine({ title: 'T' })), ['i.engine']);
  });
});

describe('客户端复判：与形状层同一批拒绝码，且**整个面板**不落地', () => {
  test('未知组件 / 坏 mode / 坏形状 ⇒ 面板被丢（不 import、不挂、不建 DOM）', async () => {
    const h1 = harness();
    const res = h1.registry.apply([
      wire({ id: 'unknown', wraps: [{ component: 'game.nope', mode: 'wrap' }] }),
      wire({ id: 'mode', wraps: [{ component: ENGINE_ID, mode: 'banana' }] }),
      wire({ id: 'shape', wraps: 'x' }),
      wire({ id: 'missing', wraps: [{ component: ENGINE_ID }] }),
      wire({ id: 'twice', wraps: [{ component: ENGINE_ID, mode: 'wrap' }, { component: ENGINE_ID, mode: 'replace' }] }),
      wire({ id: 'many', wraps: Array.from({ length: 9 }, () => ({ component: ENGINE_ID, mode: 'wrap' })) }),
    ]);
    assert.equal(res.accepted, 0);
    await settle();
    assert.deepEqual(h1.imported, []);
    assert.deepEqual(h1.registry.mounted(), []);
    assert.deepEqual(h1.dom.created, []);
    const codes = h1.registry.refusals().map((r) => r.code);
    for (const code of ['CLIENT_WRAP_UNKNOWN_COMPONENT', 'CLIENT_WRAP_BAD_MODE', 'CLIENT_WRAP_BAD_SHAPE']) {
      assert.ok(codes.includes(code), `${code} missing in ${JSON.stringify(codes)}`);
    }
    const unknown = h1.registry.refusals().find((r) => r.code === 'CLIENT_WRAP_UNKNOWN_COMPONENT');
    assert.match(unknown.detail, /alpha\/unknown/, '理由里点名包与面板');
    for (const id of MOD_COMPONENT_IDS) assert.ok(unknown.detail.includes(id), '理由里列出全部合法 id');
  });
});

describe('main.js 的接线：改写注册完成之后重画一次（没有声明时一次都不调用）', () => {
  test('注入 onWrapsChanged 并在 boot 之后重画同一个 <App/>；页面上没有新全局', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
    assert.match(src, /onWrapsChanged:/);
    assert.match(src, /if \(appRoot\) render\(html`<\$\{App\} \/>`, appRoot\)/, '重画就是再 render 同一个 <App/>（Preact 就地 diff）');
    assert.match(src, /appRoot = root;/);
    assert.match(src, /if \(Array\.isArray\(msg && msg\.modPanels\) && msg\.modPanels\.length\) modPanels\.apply\(msg\.modPanels\)/);
    const sp = src.match(/globalThis\.__SP__ = \{([^}]*)\}/);
    assert.ok(sp);
    assert.doesNotMatch(sp[1], /wrap/i, '没有新全局');
  });
});
