// public/js/ui/modComponents.js — 引擎组件注册表（DESIGN §28.19, docs/WORKSHOP.md §1.9.7）。
//
// 一个包的面板今天只能**插进一个槽位**（`[data-mod-slot]`，九个宿主）。槽位表达不了「这个界面现在长得不一样了」，
// 而真实社区的插件包是整屏重画的 —— 所以这里补上另一半：面板可以**包裹**（`wrap`）或**替换**（`replace`）引擎的
// 一个**具名组件**。一个组件 id 就是一个 `modComponent(id, impl)` 出来的实现：`impl` **就是**今天那份实现，
// 引擎的渲染树里多出来的只是一次集合查找。
//
// 四条载重性质：
//
//   * **没有声明就没有成本**：没有任何包声明 wraps 时 `wrapped` 是空集合，`ModComponent` 的第一次查找之后直接
//     `return impl(props)` —— 渲染出来的 vnode 与今天**逐字相同**（没有多一层组件边界、没有快照、没有新 DOM）。
//     组件是**通过注册表**渲染的（每个 id 一处 `modComponent` 调用），但注册表在没被声明时是一条直路。
//   * **链是渲染期解的**：`wrap(ctx)` 每次渲染都会被调用一次 —— 它拿到的 `ctx.props` 是**这一帧**的只读快照
//     （`extensions.js` 用 `readonlySnapshot` 造），所以 `wrap` 必须是 ctx 的纯函数，返回
//     `(orig) => vnode`（见下）。
//   * **次序不是到达次序**：链由调用方（`setComponentWraps`，C 层注册点）按**既有面板比较器**排好 ——
//     `order` → 包 id → 面板 id（§28.3），最先的那一条贴着引擎组件（内层），最后的那一条在最外面。
//   * **失败隔离**：链上任何一环抛异常、或什么都没返回，这一环就退回它**下面**那一份（最内层就是引擎自己的组件），
//     并且**只点名一次**（`CLIENT_WRAP_THREW` / `CLIENT_WRAP_NO_RENDER`）。一个写坏的包不能把屏幕弄没。
//
// 模块契约（包那一侧，`pack.json.client.panels[].module` 里的 `wrap` 导出）：
//
//   export function wrap(ctx) {          // ctx = 面板那份冻结注入面 + component + props（只读快照）
//     return (orig) => html`...${orig}...`;   // orig = 链条下方那一份（`replace` 档拿到的是 null）
//   }
//
// `orig` 是**一个 vnode**，不是 DOM 节点、也不是组件：直接嵌进你返回的那棵树里即可。
// 本模块只做三件事：一个组件的查找、链的依次求值、以及失败时退回下一层。它不认识包、不认识 store、
// 不认识 `pack.json` —— 声明与拒绝码都在 C 层注册点（`public/js/ui/extensions.js`）。

import { h } from '../../vendor/preact.module.js';

/**
 * 引擎**具名组件**的闭枚举：每个 id 都在 `public/js/**` 里有一处 `modComponent('<id>', impl)`。
 *
 * 这份名单是**客户端**的唯一真相（`shared/workshop.js CLIENT_WRAP_COMPONENTS` 是形状层为了不加载客户端也能判死
 * 而放的副本，`test/modPanelWraps.test.js` 把两个表钉在一起）。挑进这张表的都是**纯视图**组件：它们只画，
 * 改不了对局结果（这正是 C 层存在的意义）—— 组件本身与「面板不给 store」是同一条边界。
 */
export const MOD_COMPONENT_IDS = Object.freeze([
  'game.bondStrip', 'game.hud.topBar', 'game.shopCard', 'loadout.detail',
]);

/** 改写方式：`wrap` 包一层（内层结果作为 `orig` 交给它）；`replace` 整段换掉（`orig` 是 `null`）。 */
export const MOD_WRAP_MODES = Object.freeze(['wrap', 'replace']);

/** component id -> 链（内层在前）。空 Map = 没有任何包声明 wraps = 引擎照今天的样子渲染。 */
const chains = new Map();
/** 有链的组件 id（组件里那一次查找查的就是它）。 */
const wrapped = new Set();
/** 链表的签名：用来判断「这次注册真的改动了什么」，只有变了才通知页面重画。 */
let signature = '';

/**
 * 定义一个引擎组件：`impl` 就是它今天那份实现，返回的函数是引擎渲染树里用的那一个。
 *
 * 没有包改写这个 id 时它**直接**返回 `impl(props)`（同一个 vnode，不多一层组件、不多一次快照）；有链时按次序
 * 求值（见文件头）。id 不在 `MOD_COMPONENT_IDS` 里是**引擎自己的编程错误**（不是包的问题），所以这里直接抛 ——
 * 一处写错的 id 由 `test/modPanelWraps.test.js` 的源码扫描钉死，不会走到线上。
 * @template {Function} T
 * @param {string} id 组件 id（`MOD_COMPONENT_IDS` 之一）
 * @param {T} impl 引擎自己的实现（函数组件）
 * @returns {T} 引擎渲染树里用的组件
 */
export function modComponent(id, impl) {
  if (typeof impl !== 'function') {
    throw new Error(`[mod-components] "${id}" has no implementation (modComponent(id, impl))`);
  }
  if (!MOD_COMPONENT_IDS.includes(id)) {
    throw new Error(`[mod-components] "${id}" is not a declared engine component (one of: ${MOD_COMPONENT_IDS.join(', ')})`);
  }
  function ModComponent(props) {
    if (!wrapped.has(id)) return impl(props);
    return renderChain(id, impl, props);
  }
  return /** @type {T} */ (ModComponent);
}

/**
 * 换掉整个链表（C 层注册点在每次 `apply` / 注册成功后调用一次）。
 *
 * 传进来的是**已经排好序**的链：`Map<component id, link[]>`，数组下标 0 贴着引擎组件。这里不排序 ——
 * 次序是面板比较器（§28.3）的事，抄一份比较器就是第二个会漂的真相。
 * @param {Map<string, any[]>} table
 * @returns {boolean} 链表是否真的变了（调用方据此决定要不要让页面重画一次）
 */
export function setComponentWraps(table) {
  chains.clear();
  wrapped.clear();
  for (const [id, links] of table) {
    if (!Array.isArray(links) || !links.length) continue;
    chains.set(id, Object.freeze([...links]));
    wrapped.add(id);
  }
  const next = MOD_COMPONENT_IDS.filter((id) => chains.has(id)).map((id) => `${id}:${chains.get(id).length}`).join(',');
  const changed = next !== signature;
  signature = next;
  return changed;
}

/** 撤掉所有链（`dispose()`）：注册表不再改写任何组件，引擎照今天的样子渲染。 */
export function clearComponentWraps() {
  chains.clear();
  wrapped.clear();
  signature = '';
}

/** 现在被改写的组件 id（诊断 / 测试面）。 */
export function wrappedComponentIds() {
  return MOD_COMPONENT_IDS.filter((id) => wrapped.has(id));
}

/** 某个组件的链（只读视图：包、面板、方式）。 */
export function componentWrapLinks(id) {
  return (chains.get(id) || []).map((link) => ({ pack: link.pack, panel: link.panel, mode: link.mode }));
}

const describe = (err) => (err && err.message ? err.message : String(err));
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);

/**
 * 一条链上的一环坏了：**点名一次**（同一个 code 只报第一次，否则一次渲染一条、一秒能刷满控制台），
 * 并让调用方退回 `orig`。
 * @param {any} link
 * @param {string} code
 * @param {string} why
 */
function fail(link, code, why) {
  if (!link.reported) link.reported = new Set();
  if (link.reported.has(code)) return;
  link.reported.add(code);
  link.report?.(code, `panel "${link.pack}/${link.panel}" ${link.mode === 'replace' ? 'replaces' : 'wraps'} "${link.component}" and ${why} — this render falls back to the chain below it (for the innermost link: the engine's own component)`);
}

/**
 * 求值一环：`wrap(ctx)` 返回 `(orig) => vnode`。
 * @param {any} link
 * @param {any} orig 链条下方那一份（`replace` 档是 `null`：引擎，不是作者，决定它不再被渲染）
 * @param {any} props 引擎这一帧交给组件的 props（原样；快照由 `makeCtx` 造）
 * @returns {any} vnode，或 `null`（这一环坏了：调用方退回 `orig`）
 */
function applyLink(link, orig, props) {
  let render;
  try {
    render = link.wrap(link.makeCtx(props));
  } catch (err) {
    fail(link, 'CLIENT_WRAP_THREW', `its wrap(ctx) threw: ${describe(err)}`);
    return null;
  }
  if (typeof render !== 'function') {
    fail(link, 'CLIENT_WRAP_NO_RENDER', `its wrap(ctx) returned ${typeOf(render)} instead of a function (orig) => vnode`);
    return null;
  }
  let out;
  try {
    out = render(orig);
  } catch (err) {
    fail(link, 'CLIENT_WRAP_THREW', `rendering the wrapper threw: ${describe(err)}`);
    return null;
  }
  if (out === null || out === undefined) {
    fail(link, 'CLIENT_WRAP_NO_RENDER', 'the wrapper rendered nothing (null / undefined)');
    return null;
  }
  return out;
}

/**
 * 依次求值一条链：最内层是引擎自己的组件（`h(impl, props)` —— 它拿到的就是这一帧的 props），每一环拿链条
 * 下方那一份当 `orig`。`replace` 档拿到的 `orig` 是 `null`（引擎决定它下方的整段不再被渲染），它的结果继续
 * 作为外层的 `orig`。任何一环坏了就退回**它下面那一份**：最内层坏掉 = 引擎自己那份照旧画出来。
 * @param {string} id
 * @param {Function} impl
 * @param {any} props
 * @returns {any}
 */
function renderChain(id, impl, props) {
  const links = chains.get(id);
  let rendered = h(impl, props);
  for (const link of links) {
    const below = rendered;
    const out = applyLink(link, link.mode === 'replace' ? null : below, props);
    rendered = out === null ? below : out;
  }
  return rendered;
}
