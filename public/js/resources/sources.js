// public/js/resources/sources.js — 素材加载源：**镜像的排序面**（DESIGN §28.40，docs/WORKSHOP.md §1.21）。
//
// 这个模块回答的问题只有一个：「作者声明的那几条镜像，先试哪一条」。它**不回答**「有哪些镜像」——那是
// `pack.json.assets.mirrors[]`（形状与装载期比对在 `shared/workshop.js` 与 `server/workshop.js`），而地址从来不在
// 这里。分开这两件事就是这个设计的全部价值：
//
//   1. **结构上不可能引入主机名。** 提供者（面板模块导出的 `sources(ctx)`）拿到的是**已声明**的镜像列表，返回的
//      只能是这些 `id` 的一个排列 / 子集。喂一个主机名、一条 URL、一个没声明过的 id 进去 ⇒
//      `CLIENT_SOURCES_BAD_ORDER`，整条顺序**作废**（不半信半疑），回落声明顺序。所以即使一个提供者想指到自己的
//      域名，它**没有位置**写那个域名：`importFromServer` 拼地址时读的是 `pack.json` 里那一条，而那条已经在装载期
//      与包内容器的摘要比对过（`server/workshop.js assetsMirrorIssues`）。
//   2. **最多一个提供者。** 与外观提供者逐字同构（`public/js/ui/extensions.js registerAppearance` +
//      `public/js/ui/portraitChain.js setAppearanceLookup`）：「哪一台主机先说话」不许取决于模块 import 顺序。
//   3. **关掉时逐字不变。** 门控默认 `true`（与设置默认同值，唯一写入面是 `public/js/ui/settings.js`）；关掉之后
//      `importFromServer` 走的与「这个包没声明 `mirrors`」**完全同一条**路径（镜像那条 URL 一次都不被请求），
//      而一个没声明 `mirrors` 的包连这个模块都不会被问到。门控**不在这个文件里判**：这里是纯的「怎么排」，
//      「要不要用镜像」是调用方那一个 `if` —— 两件事分开，「关掉时一次都不问」才是一条能独立断言的路径。
//
// 与 SW（`public/js/resources/service.js`）的分工写清楚，免得两处口径互相污染：SW 回答「这条 `/assets` 请求能不能
// 用本地已校验的字节回答」，它**不回源**、也不认识镜像；镜像只决定**容器的字节从哪台主机取回来**，取回来之后
// 进的是同一份 Cache Storage、同一份逐文件 SHA-1[0:12] 索引。

/** 门控（`settings.workshopSources`）：默认开，与设置默认同值。 */
let enabled = true;
/** 已经注册的排序函数，或 null。进程内**最多一个**。 */
let orderer = null;
/** 注册它的面板（`<包>/<面板id>`），只用于诊断与读数。 */
let ordererKey = null;
/** 有人想注册但被拒（与 `appearanceRefused` 同一条读数）。 */
let refused = false;

/** 设置那一格的唯一写入面（`public/js/ui/settings.js`）。@param {boolean} on @returns {boolean} 写入后的值 */
export const setSourcesEnabled = (on) => { enabled = on !== false; return enabled; };
/** 今天的门控值。 */
export const sourcesEnabled = () => enabled;
/** 今天的提供者（`<包>/<面板id>`）或 null。 */
export const currentSourceOrderer = () => ordererKey;
/** 有没有人想注册而没成功（读数用）。 */
export const sourcesRegistrationRefused = () => refused;
/** 记一笔「有人想注册而被拒」（调用方负责点名那条拒绝）。 */
export const markSourcesRegistrationRefused = () => { refused = true; };

/**
 * 接进一个排序函数。**首次调用者赢**，第二次返回 `false`（调用方点名 `CLIENT_SOURCES_TAKEN`）。
 * @param {(mirrors: ReadonlyArray<{ id: string, base: string, sha256: string }>) => unknown} fn
 * @param {string|null} key 注册它的面板（`<包>/<面板id>`）
 * @returns {boolean} 是否建立
 */
export function setSourceOrder(fn, key = null) {
  if (typeof fn !== 'function') return false;
  if (orderer) return false;
  orderer = fn;
  ordererKey = typeof key === 'string' && key ? key : null;
  return true;
}

/** 忘了那个提供者（测试 / dispose 用）。 */
export function clearSourceOrder() { orderer = null; ordererKey = null; }
/** 把读数也清掉（`clearPanelPrefs` 的同族，测试用）。 */
export function resetSourcesState() { enabled = true; orderer = null; ordererKey = null; refused = false; }

/** 一个形状可用的镜像条目？形状层已经判过一遍，这里是客户端侧的第二个读者（同一个理由：读的可能是手搓对象）。 */
const usableMirror = (m) => !!m && typeof m.id === 'string' && m.id
  && typeof m.base === 'string' && m.base.startsWith('https://') && typeof m.sha256 === 'string';

/** 冻结一份只读的镜像读数：提供者拿到的**不是** `pack.json` 那个对象本身（它不许改它）。 */
const frozenMirror = (m) => Object.freeze({ id: m.id, base: m.base, sha256: m.sha256 });

/**
 * 把作者声明的镜像排成「先试哪一条」。
 *
 * 四种情形都落到**一个**返回值形状上（`{ ids, refusals }`），因为调用方（`host.js importFromServer`）只该有
 * 一条路径：能排就按排的来，排不了就按声明顺序来，而「排不了」**必须点名**（`refusals` 里一条，调用方逐条 warn）。
 *
 * 拒绝的四种写法，全部**整条作废**（不半信半疑地采用一半顺序 —— 那会让「哪台先说话」变成一件没人能复现的事）：
 *   * 返回值不是数组 ⇒ `CLIENT_SOURCES_BAD_ORDER`（`null` / `undefined` 例外：那是「我没什么可排的」，走声明顺序）；
 *   * 数组里有一条不是字符串、或不是**已声明**的 id ⇒ `CLIENT_SOURCES_BAD_ORDER`（**喂主机名 / URL 会落在这里**）；
 *   * 提供者抛异常 ⇒ `CLIENT_SOURCES_THREW`；
 *   * 提供者是 `async`（返回 thenable）⇒ `CLIENT_SOURCES_ASYNC`：这是一条**同步**读物，等一个 promise 会让「先试
 *     哪一条」变成一件有时序的事，而它必须能在一帧里回答完（与 §28.35 拒绝 `Promise` 同一条理由）。
 * @param {ReadonlyArray<{ id: string, base: string, sha256: string }>|null|undefined} mirrors
 * @returns {{ ids: string[], refusals: Array<{ code: string, detail: string }> }}
 */
export function orderDeclared(mirrors) {
  const list = (Array.isArray(mirrors) ? mirrors : []).filter(usableMirror);
  const declared = list.map((m) => m.id);
  if (!list.length) return { ids: [], refusals: [] };
  // 门控（`sourcesEnabled()`）**不在这里判**：这一格是纯的「怎么排」，而「要不要用镜像」是调用方那一个 `if`
  // （`host.js importFromServer`）。两件事分开，所以「关掉时一次都不问」是一条能独立断言的路径。
  if (!orderer) return { ids: declared, refusals: [] };
  const frozen = Object.freeze(list.map(frozenMirror));
  /** @type {unknown} */
  let asked;
  try {
    asked = orderer(frozen);
  } catch (err) {
    return { ids: declared, refusals: [{ code: 'CLIENT_SOURCES_THREW', detail: `sources(ctx) threw: ${err && err.message ? err.message : String(err)}` }] };
  }
  if (asked && typeof asked.then === 'function') {
    return { ids: declared, refusals: [{ code: 'CLIENT_SOURCES_ASYNC', detail: 'sources(ctx) returned a promise: this is a synchronous read (the order must be answerable in one frame), so the declared order is used instead' }] };
  }
  if (asked === null || asked === undefined) return { ids: declared, refusals: [] };
  if (!Array.isArray(asked)) {
    return { ids: declared, refusals: [{ code: 'CLIENT_SOURCES_BAD_ORDER', detail: `sources(ctx) must return an array of declared mirror ids (got ${typeof asked}) — a host name or a URL is not a mirror: the addresses live in pack.json, and every one of them was checked against this pack's container digest at load time` }] };
  }
  /** @type {string[]} */
  const head = [];
  /** @type {unknown[]} */
  const unknown = [];
  const seen = new Set();
  for (const id of asked) {
    if (typeof id !== 'string' || !declared.includes(id)) { unknown.push(id); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    head.push(id);
  }
  if (unknown.length) {
    return { ids: declared, refusals: [{ code: 'CLIENT_SOURCES_BAD_ORDER', detail: `sources(ctx) named ${unknown.length} id(s) this pack never declared (${unknown.slice(0, 3).map((v) => JSON.stringify(typeof v === 'string' ? v.slice(0, 60) : v)).join(', ')}) — only the ${declared.length} declared id(s) ${declared.join(' / ')} may be ordered; a host name or a URL is refused here on purpose` }] };
  }
  // 子集是允许的（「今天只想用这两条」），剩下的按声明顺序排在后面 —— 于是「排出来的永远是声明的那些 id 的一个排列」。
  return { ids: [...head, ...declared.filter((id) => !seen.has(id))], refusals: [] };
}
