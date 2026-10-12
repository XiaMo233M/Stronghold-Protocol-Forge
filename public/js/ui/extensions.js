// public/js/ui/extensions.js — the C-layer registration point (DESIGN §28.8, docs/WORKSHOP.md §1.9.3).
//
// A workshop pack's client interface is DECLARED, not patched in: `pack.json.client.panels[]` names a module inside the
// pack and one of four mount points. The server registers that module under `/workshop-panels/<pack>/<module>` (only
// registered URLs are servable) and sends the list in `welcome` (`modPanels`) — a frame the server already sends, so a
// server with no such pack produces **no new request, no new DOM and no new global** in the browser.
//
// The owner's ruling of 2026-10-10 added a second half, "both paths at once":
//   * `client.theme.vars` — a handful of CSS custom properties, an **additive** write (`applyTheme`, restored on
//     `dispose`), which is what §28.8 always described;
//   * `client.panels[].styles[]` — a panel's OWN `.css`, injected from the same registered route (a `<link>` appended
//     to `<head>`, so it lands after the engine's styles) and removed on `dispose`. A declaration that brings a whole
//     new component (the reference pack's `chat.css` is 21 KB of it) cannot be expressed as variables, which is why
//     this half exists at all.
//
//   * `client.panels[].messages[]` — **包自己的消息通道** (owner's ruling 2026-10-10, docs/WORKSHOP.md §1.9.6):
//     `ctx.net.send('<channel>', data)` and `ctx.net.on('<channel>', fn)` reach the owner's other clients in the same
//     room. The ENGINE defines the envelope (`pack.msg`), the PACK defines the channel — so a pack cannot invent a
//     protocol type, and `b.*` stays out of reach. Engine message types (`S2C`) keep working through `on` unchanged.
//
//   * `client.panels[].wraps[]` — **组件级改写** (DESIGN §28.19, docs/WORKSHOP.md §1.9.7): a panel may also WRAP or
//     REPLACE one of the engine's named components (`public/js/ui/modComponents.js`). A slot says "insert here"; this
//     says "this screen looks different now" — the reference community pack rewrites whole screens, which no mount
//     point can express. The chain is ordered by the same comparator as mounting (order → pack id → panel id, §28.3),
//     and the wrapper's `ctx` is the SAME frozen surface a panel gets plus exactly two things: `component` (which id
//     this link rewrites) and `props` (a read-only deep snapshot of the component's props, this render's). There is
//     still no store handle, no engine and no match state — the boundary is what is not passed in. A wrap declaration
//     that cannot be used drops the WHOLE panel, never half of it (the stance below).
//
// This module turns that list into mounts. Three properties are load-bearing:
//
//   * THE BOUNDARY IS WHAT IS NOT PASSED IN (DESIGN §28.8). A panel's factory gets a frozen object with exactly
//     `{ id, pack, slot, order, gate, log, host, session, net }`:
//       - `host` is a plain element the registry owns — the pack may fill it, nothing else;
//       - `session.setPreload({ required, ready })` is the ONLY store write a panel gets (the entry gate, 缺口 3);
//       - `net.{ on, sendResourceMessage }` is the ONLY network access (缺口 4: the resource challenge arrives before
//         `hello`, so `send()` would drop the message — `sendResourceMessage` goes through `_sendRaw`).
//         Since §28.24 / §28.25 the same facade carries two **readings** that originate no frame and drive no behaviour:
//         `net.status()` (the connection snapshot `public/js/net.js` already publishes as its `'status'` event) and
//         `net.welcome()` (the `welcome` frame the client already received). Both are frozen copies and both are `null`
//         when there is nothing to report — a panel may draw the wrong thing, never compute the wrong thing.
//         §28.32 adds `net.transport()` on the same terms (the socket parameters only the server knows: the browser's
//         `WebSocket` API exposes no `Sec-WebSocket-Extensions`) and §28.31 adds two cells on the OTHER two facades:
//         `me.voice` (`{ global, byChar }`, the voice-dub reading — a panel cannot see the settings store) and
//         `session.setVoiceLang(charId, lang)`, the ONE setting cell a panel may write (closed enum `VOICE_LANGS`,
//         local-only, playback-time — see `VOICE_CHAR_ID_RE` for the boundary in full).
//     There is no store handle, no store slice, no engine and no match state, so a C module can be wrong in the
//     rendering sense and cannot be wrong in the result sense.
//   * A DECLARATION THAT CANNOT BE USED IS NAMED, never silently skipped: an unknown slot, a URL outside the
//     registration route, a module without `mount`, a gate that names no store path, a browser capability the pack
//     requires and this browser lacks. Each one costs one named line and mounts no half-working panel.
//   * NOTHING IS DONE UNTIL A PACK DECLARES SOMETHING. `apply([])` imports no module, creates no element and (on a
//     plain install) does not even subscribe to the store.
//
// Pure logic with an injected DOM (`dom`), an injected module loader (`importModule`) and an injected capability
// environment (`env`), so `test/modClientPanels.test.js` can run all of it in Node (there is no Chrome on this machine:
// the browser half is the opt-in `SP_E2E=1` path, see docs/WORKSHOP.md §4.4 for the same standing gap).

import { t } from '../../../shared/i18n.js';
import { validateC2S } from '../../../shared/protocol.js';
// 立绘解析链的**唯一 hook**（皮肤层第 1 步）：核心只认识「有一个函数可能回答这个 id」，不认识「皮肤」。
import { setAppearanceLookup, clearAppearanceLookup } from './portraitChain.js';
// 素材加载源的**排序面**（DESIGN §28.40）：与外观提供者逐字同构的一条注册链 —— 一个提供者、最多一个、点名拒绝。
// 这个模块没有依赖（不 import common.js/bundle.js），所以面板这条路不因为多了它而变重。
import { setSourceOrder, clearSourceOrder } from '../resources/sources.js';
// 引擎已经定义好的服务端→客户端类型（`shared/protocol.js S2C`）。**不在这里抄一份**：抄一份就是第二个会漂的真相，
// 而漂的方向是「一个面板订阅了一个引擎其实不会发的名字」—— 那正是这一层到处在拒绝的形态。
import { S2C } from '../../../shared/protocol.js';
// 配音词表（`shared/constants.js VOICE_LANGS`，编辑器 / CLI / 工坊校验器都读它）。**不在这里抄一份**：抄一份
// 就是第二个会漂的真相，而漂的方向是「面板写了一个引擎不认识的配音」—— 那正是这一层到处在拒绝的形态。
// 这个模块是纯数据，所以 `extensions.js` 仍然能在 Node 里整套跑（`test/modClientPanels.test.js` 就是这么跑的）。
import { VOICE_LANGS } from '../../../shared/constants.js';
// 组件级改写（DESIGN §28.19）：引擎的具名组件注册表。**只有包真的声明了 `wraps` 才会走到它**——
// 没有任何包声明时 `setComponentWraps` 一次都不会被调用，链表是空的，组件里的那一次查找之后就是引擎今天那份实现。
import { MOD_COMPONENT_IDS, MOD_WRAP_MODES, setComponentWraps, clearComponentWraps, wrappedComponentIds } from './modComponents.js';

/** 引擎类型集合（`net.on(type)` 对它们照旧原样透传）。 */
const S2C_TYPES = new Set(S2C);

/**
 * The mount points (DESIGN §28.8). The first four are 0.11.0's **overlays** — the registry creates their container on
 * demand and `public/css/components.css` fixes them. The last five live **inside components the engine already renders**
 * (the owner's ruling of 2026-10-10): the component renders `[data-mod-slot="…"]` and the panel fills it, which is how a
 * pack marks a shop card, adds a gesture to the bond strip or inserts a section into 操作员详情.
 *
 * Kept here as its own table because importing `shared/workshop.js` would pull the whole pack schema into the page; a
 * test pins the two tables together, the same way `test/kitImports.test.js` pins the import map to the whitelist.
 */
export const MOD_PANEL_SLOTS = Object.freeze([
  'root.overlays', 'root.guide', 'screen.game.aside', 'screen.result.footer',
  'screen.game.shopCard', 'screen.game.bondStrip', 'screen.game.hud', 'screen.game.overlay',
  'screen.loadout.detail',
]);

/**
 * Hosts the engine renders MORE THAN ONCE (one container per shop card). A panel declaring one of these mounts into
 * **every** match and learns which one it is through `ctx.hostKey` — that is what makes "a mark on each card" possible
 * without handing the pack the store (DESIGN §28.8's boundary). `shared/workshop.js CLIENT_PANEL_REPEATABLE` is the
 * other copy; a test pins them together.
 */
export const MOD_PANEL_REPEATABLE = Object.freeze(['screen.game.shopCard']);

/** The URL prefix a panel module is served under: `shared/workshop.js WORKSHOP_PANEL_PREFIX` (pinned by a test). */
export const MOD_PANEL_PREFIX = '/workshop-panels/';

/** The browser capabilities a pack may require: `shared/workshop.js CLIENT_REQUIRES` (pinned by a test). */
export const MOD_PANEL_REQUIRES = Object.freeze(['serviceWorker', 'cacheStorage', 'webCrypto']);

/** The selector of a slot container: an existing one wins, otherwise the registry creates it (see `browserSlotHost`). */
export const slotSelector = (slot) => `[data-mod-slot="${slot}"]`;

/**
 * 引擎**按需创建**容器的宿主：0.11.0 的四个浮层。其余宿主由组件自己渲染 `[data-mod-slot]`，注册点只查不造 ——
 * 一个「谁也不认识的位置」比一个没挂上的面板难查得多。
 */
export const MOD_PANEL_CREATED = Object.freeze(['root.overlays', 'root.guide', 'screen.game.aside', 'screen.result.footer']);

/**
 * **面板偏好**的容量上限（`ctx.session.setPref` / `getPref`）与「面板能主动发的引擎消息」闭枚举。
 *
 * 两处都是**刻意的摩擦**：
 *   * 偏好只收短标量 —— 让它成为第二个数据库是它最可能的变坏方式；
 *   * `PANEL_SEND_TYPES` 只列**展示**类的引擎消息。面板能改对局状态的那一天，就是这一层失效的那一天；
 *     所以加一条要同时改这张表、那条消息的 C2S 形状、以及一条测试。
 */
export const PREFS_MAX_KEY = 64;
export const PREFS_MAX_VALUE = 512;
export const PANEL_SEND_TYPES = Object.freeze(['room.appearance']);

/**
 * **面板能写设置的那一格**（`ctx.session.setVoiceLang(charId, lang)`，业主裁决 2026-10-11：「能优化就优化，
 * 但要守边界」）。这一格开了一个**新类**：在此之前 `session.setPreload` 只能写 store 里两个入口闸门标志，
 * 面板**从来**改不了玩家自己的设置。所以边界写在这里，一条都不含糊：
 *
 *   * **只有这一个写口**，只写设置库里的 `voiceLangByChar`（逐干员的配音覆盖）**一格**：其它设置（音量、
 *     静音、画质、文字大小、快捷键、工坊外观开关）面板连**读**都读不到（`ctx.me.voice` 只给配音那两格），
 *     更一个都写不了；
 *   * **只影响这一台机器**：配音语言在**播放时**解析（`public/js/audio.js:1020` / `:1026` 读注入的
 *     `voiceLangOf`，它最终走 `ui/gameLogic/settings.js voiceLangFor`，缺档回退「覆盖 → 全局 → 默认」），
 *     整个写口是纯 localStorage 偏好 —— 不发帧、不落对局、**改动不了任何人的战果**；
 *   * **闭枚举**：值只收 `VOICE_LANGS`（`shared/constants.js`，cn / jp / en / kr）里的成员，或 `''` / `null`
 *     （= 清掉这一格的覆盖，回到跟随全局）。别的值一律**拒绝并点名**，绝不静默丢弃；`VOICE_LANGS` 本身
 *     一个字也不许改（它不从属于面板）。
 *
 * 干员 id 的形状：`sanitizeVoiceLangByChar` 只收 `/^char_[A-Za-z0-9_]{1,64}$/` 的键。这里**必须**先判一次
 * ——否则一个形状不对的 id 会被那个清洗器**静默丢掉**，而面板会以为写成功了。两处判据由
 * `test/modClientSettings.test.js` 钉在一起（这个文件与别处同形：`THEME_VAR_RE` 也是这么钉的）。
 */
export const VOICE_CHAR_ID_RE = /^char_[A-Za-z0-9_]{1,64}$/;

/**
 * 面板偏好表（模块级、内存里）。
 *
 * **为什么必须在内存里**：`public/js/ui/extensions.js` 在**服务端测试里也被 import**（注册点的用例跑在 Node 下），
 * 而 `localStorage` 在那里不存在 —— 一处在模块顶层碰 `localStorage` 的代码会让那一整组用例炸掉。
 * 键按 `<包 id>/<面板写的键>` 前缀分区：两个包用同一个键名不会互相覆盖（否则是**跨包串味**，最难查的那种）。
 * @type {Map<string, any>}
 */
const prefs = new Map();
const setPref = (k, v) => { prefs.set(k, v); };
const getPref = (k) => prefs.get(k);
/** 清空（测试用；`dispose()` 不收，因为偏好本来就该活过界面）。 */
export const clearPanelPrefs = () => { prefs.clear(); };

/**
 * 宿主容器用来告诉面板「你是哪一份」的属性名（`ctx.hostKey` 的来源）。
 *
 * 三个读者共用这一个名字，所以它必须是一份真相：注册点（`hostKeyOf`）、**渲染宿主的引擎组件**
 * （商店卡每张一个、`screen.loadout.detail` 给出当前干员）、以及包作者（照它写选择器）。
 * 一个包改不动它 —— 它只**读**这个属性。
 */
export const SLOT_KEY_ATTR = 'data-mod-slot-key';

/** 一个宿主容器自己带的键（`SLOT_KEY_ATTR`）—— 可重复宿主用它告诉面板「你是哪一份」（商店卡那个键就是棋子 id）。 */
export function hostKeyOf(el) {
  if (!el || typeof el.getAttribute !== 'function') return null;
  const k = el.getAttribute(SLOT_KEY_ATTR);
  return typeof k === 'string' && k ? k : null;
}

/** 一份**只读深拷贝**的缓存（同一份原始对象只造一次快照，整份共享）。 */
const snapshotCache = new WeakMap();

/**
 * 造一份冻结的深拷贝 —— `ctx.data.get()` 交给包的东西。
 *
 * 为什么不直接把引擎那份冻上：`public/js/data.js` 缓存的对象是引擎自己的家当（语言切换、补位清单都可能再写它），
 * 冻住它等于让一个包把引擎的缓存变成只读。包拿到的必须是**快照**：它改自己的那份，谁也看不见。
 * 数组与普通对象照原样深拷，`null` / 标量直接返回（JSON 数据里没有循环引用）。
 * @param {any} value
 * @returns {any}
 */
export function readonlySnapshot(value) {
  if (value === null || typeof value !== 'object') return value;
  const had = snapshotCache.get(value);
  if (had) return had;
  /** @type {any} */
  const copy = Array.isArray(value) ? [] : {};
  snapshotCache.set(value, copy);
  if (Array.isArray(value)) {
    for (const item of value) copy.push(readonlySnapshot(item));
  } else {
    for (const [k, v] of Object.entries(value)) copy[k] = readonlySnapshot(v);
  }
  return Object.freeze(copy);
}

/** 组件已经渲染出来的全部该宿主的容器（可重复宿主会有多个）；浏览器里是 `querySelectorAll`。 */
export function browserSlotHosts(slot) {
  const doc = globalThis.document;
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  return [...doc.querySelectorAll(slotSelector(slot))];
}

/** 主题变量的名字：与 `shared/workshop.js CLIENT_THEME_VAR_RE` 逐字相同（两处真相会漂，所以测试把它们钉在一起）。 */
export const THEME_VAR_RE = /^--[A-Za-z0-9_-]{1,64}$/;

/** 样式表注入到哪里（`<head>` 末尾 = 排在引擎样式之后，这正是裁决里那条顺序要求）。 */
function browserStyleHost() {
  const doc = globalThis.document;
  return doc && doc.head ? doc.head : null;
}

/** 主题变量写到哪个元素上（`:root`）。 */
function browserThemeHost() {
  const doc = globalThis.document;
  return doc && doc.documentElement ? doc.documentElement : null;
}

/**
 * The slot container for a mount point, created **on demand**. A page whose packs declare no panel therefore adds no
 * DOM at all — the app shell (`main.js`) renders nothing for this layer, and the four containers exist only once a
 * panel really mounts into one. An app shell that renders its own `[data-mod-slot="…"]` element wins (that is the
 * addressing contract, and the reason the attribute is public).
 * @param {string} slot
 * @returns {any} the container, or null when there is no document (Node)
 */
export function browserSlotHost(slot) {
  const doc = globalThis.document;
  if (!doc) return null;
  const found = doc.querySelector(slotSelector(slot));
  if (found) return found;
  const el = doc.createElement('div');
  el.className = 'mod-slot';
  el.setAttribute('data-mod-slot', slot);
  (doc.body || doc.documentElement).appendChild(el);
  return el;
}

/** The browser as the capability check sees it (`globalThis` lookups, so Node can run this module). */
function browserEnv() {
  const nav = globalThis.navigator;
  const crypto = globalThis.crypto;
  return {
    serviceWorker: !!nav && 'serviceWorker' in nav,
    cacheStorage: 'caches' in globalThis && !!globalThis.caches,
    webCrypto: !!(crypto && crypto.subtle && typeof crypto.subtle.digest === 'function'),
  };
}

/**
 * Which of a declaration's `requires` this environment cannot satisfy. `serviceWorker` / `cacheStorage` / `webCrypto`
 * are the closed list (DESIGN §28.13); a name outside it is unsupported by definition here — a capability this build
 * cannot check is not a capability it may promise.
 * @param {string[]|undefined} requires
 * @param {Record<string, boolean>} [env]
 * @returns {string[]} the missing capability names (empty = everything is there)
 */
export function capabilityIssues(requires, env = browserEnv()) {
  const out = [];
  for (const name of Array.isArray(requires) ? requires : []) {
    if (!env || !env[name]) out.push(String(name));
  }
  return out;
}

/**
 * Resolve a panel `gate` — a dotted path into the client store — read-only. `ok: false` means the path is **not a path
 * of this store at all**: the declaration names a condition that can never hold, so the panel is refused by name
 * instead of never appearing (the discipline §28.13.3 states for the pack side, applied to the one thing only the
 * client can judge). Deriving the addressable surface from the store itself avoids a second truth that drifts.
 * @param {any} state the store's current state
 * @param {string} path e.g. `session.preloadRequired`
 * @returns {{ ok: boolean, value: any }}
 */
export function readGate(state, path) {
  if (typeof path !== 'string' || !path) return { ok: false, value: undefined };
  let cur = state;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return { ok: false, value: undefined };
    cur = cur[seg];
  }
  return { ok: true, value: cur };
}

/** Mount order: `order` first, then the smaller pack id (DESIGN §28.3), then the panel id. Never the arrival order. */
function comparePanels(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  if (a.pack !== b.pack) return a.pack < b.pack ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isPanelId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && !/[\s\u0000-\u001f]/.test(v);

/**
 * Create the registry the page uses (one per page; `main.js`).
 *
 * @param {{
 *   store: { get: () => any, subscribe: (fn: Function) => Function, patch: (key: string, value: object) => void },
 *   net?: { on: Function, sendResourceMessage: Function, snapshot?: Function } | null,
 *   log?: { info?: Function, warn?: Function, error?: Function } | null,
 *   notify?: (text: string, kind?: string) => void,
 *   importModule?: (url: string) => Promise<any>,
 *   slotHost?: (slot: string) => any,
 *   createElement?: (tag: string) => any,
 *   env?: Record<string, boolean>,
 *   settings?: { get: () => any, setVoiceLang: (charId: string, lang: string) => boolean } | null,
 *   battle?: { damage: () => any } | null,
 *   onWrapsChanged?: (links: number) => void,
 * }} deps
 * @returns {{ apply: (list: any) => { accepted: number },
 *   mounted: () => string[], wrapped: () => string[], refusals: () => Array<{ code: string, detail: string }>, dispose: () => void }}
 */
export function createPanelRegistry(deps) {
  const store = deps.store;
  const net = deps.net || null;
  const log = deps.log || console;
  const notify = typeof deps.notify === 'function' ? deps.notify : () => {};
  const importModule = deps.importModule || ((url) => import(/* @vite-ignore */ url));
  const slotHost = deps.slotHost || browserSlotHost;
  const createElement = deps.createElement
    || ((tag) => (globalThis.document ? globalThis.document.createElement(tag) : null));
  const env = deps.env || browserEnv();
  const styleHost = deps.styleHost || browserStyleHost;
  const themeHost = deps.themeHost || browserThemeHost;
  const slotHosts = deps.slotHosts || browserSlotHosts;
  /** 客户端数据层（`public/js/data.js`）。注入而不是 import：那是浏览器模块（fetch / location），
   *  extensions.js 必须能在 Node 里整套跑（`test/modClientPanels.test.js` 就是这么跑的）。 */
  const dataApi = deps.data || null;
  /**
   * **设置库的注入面**（业主裁决 2026-10-11 的第二个件）：`{ get, setVoiceLang }`。
   *
   * 为什么是注入而不是 import：设置库住在 `public/js/ui/settings.js`，而那个模块拖进 Preact、音频管理器、
   * 数据层与语言包 —— 这里是**能在 Node 下整套跑**的一层，不能因为一格读数把整条界面链拖进来（`data` 那一格
   * 是同一条理由）。注入的两样都来自引擎自己那一份真相：
   *   * `get()` → `settingsStore.get()`（`ctx.me.voice` 的唯一来源）；
   *   * `setVoiceLang(charId, lang)` → `ui/settings.js setVoiceLangByChar`（**唯一一个**面板能写的设置格，
   *     它只改 `voiceLangByChar` 并走那条既有 sanitize + savePref 的路径）。
   * 没有注入时两格都**拿不到就是 `null` / 点名拒绝**，不抛、不编造（见 `ctx.me.voice` 与
   * `ctx.session.setVoiceLang`）。
   */
  const settingsApi = deps.settings || null;
  /**
   * **战斗运行时的注入面**（业主裁决 2026-10-11 的第二批：`ctx.battle.damage()`，DESIGN §28.38）：注入的是
   * **一个函数**（`battleRunner.damage`），不是 runner 句柄 —— 与 `settings` / `data` 同一条理由：这个文件必须能在
   * Node 下整套跑，而 `public/js/battle/runner.js` 拖进 `/sim/` 加载器、渲染帧调度与 `net`/`store` 单例。
   *
   * 「不传什么就是边界」在这里同样成立：面板拿到的是**一次读一份的冻结副本**，没有 `step`、没有 `Battle`、
   * 没有 `_entries`，也没有 `stats()` 那种运行时可写面。没有注入时那一格**拿不到就是 `null`**（一行日志，见
   * `noteBattleGap`），不抛、不编造。
   */
  const battleApi = deps.battle || null;
  /** 组件级改写注册成功之后的**重画回调**（DESIGN §28.19）：链是渲染期生效的，注册完成之后已经画出来的那一帧
   *  必须重画一次（`main.js` 重新 `render` 同一个 `<App/>`）。没有包声明 `wraps` 时它一次都不会被调用。 */
  const onWrapsChanged = typeof deps.onWrapsChanged === 'function' ? deps.onWrapsChanged : () => {};
  /** 表名 → 冻结快照（首次读时造一次，之后共享；没声明过的表根本走不到这里）。 */
  const dataSnapshots = new Map();

  /** @type {Array<any>} */
  let panels = [];
  /** panel key -> { rec, host, unmount } while mounted (or being mounted). Repeatable hosts key by
   *  `<panel>#<hostKey>` — one entry per container the panel mounted into. */
  const mounted = new Map();
  /** mount keys that were refused: never retried (their URL is content-addressed, so a retry cannot succeed). */
  const blocked = new Set();
  /** PANEL keys refused for a reason that holds for every container: a missing capability, an unknown gate path. */
  const blockedPanels = new Set();
  /** panels whose stylesheets are already injected (N mounts share one injection). */
  const styled = new Set();
  /** panel key -> its host element (created once, inside the slot container). */
  const hosts = new Map();
  /** @type {Array<{ code: string, detail: string }>} */
  const rejected = [];
  /** 注入过的样式表元素：`dispose` 要把它们一并撤掉 —— 注入过一次的东西必须能收回来。 */
  const styleEls = [];
  /** 主题变量被我们改之前的原值（空字符串 = 当时没有这个变量，撤销时 removeProperty）。 */
  const themePrevious = new Map();
  /** 面板订阅包通道（`net.on('<通道>')`）拿到的退订函数：`dispose` 要一并撤掉。 */
  const channelOffs = [];
  /**
   * 引擎自己那一份 `welcome` 快照（DESIGN §28.24 / §28.25，面板 `ctx.net.welcome()` 的**唯一**来源）。
   *
   * 引擎本来就在订阅 `welcome`（`main.js` 的 `onWelcome` / 面板清单 / 资源声明 / 主题），这里只是把**同一条**帧
   * 的只读深拷贝留下最后一份：`null` = 这一页还没收到过任何一帧（干净安装、标题屏、握手被拒都算）。
   * 面板由**同一条** welcome 装载，注册点自己的订阅在 `apply()` 之前就注册好了，所以这一帧它收得到 ——
   * 但这仍然**不保证**首帧可见（订阅者顺序、服务端重发都不由面板决定）：拿不到就是 `null`，不编造。
   * @type {any}
   */
  let welcomeSnapshot = null;
  /**
   * `ctx.net.transport()` 那一格**为什么拿不到**已经报过的原因（每种原因只记一行）。
   *
   * 「不许静默失败」在这里的正确形状是**一次一行**，不是每次读一行：面板可能每秒问一次，而
   * 「这台服务器没有那一格字段」是一个**安装事实**（不是故障）—— 每帧刷屏的日志和没有日志一样没用。
   * 没收到 `welcome` 时**不记**：那是「还没到时候」（标题屏、握手中），不是缺字段。
   * @type {Set<string>}
   */
  const transportGapsLogged = new Set();
  /** panel key -> 它注册成功的 wraps 链接（模块每个面板只 import 一次）。 */
  const wrapLinks = new Map();
  /** panel key -> 这个模块导出过 `mount` / `default` 吗（**只改写**的模块没有，也不该因此被点名拒绝）。 */
  const wrapMounts = new Map();
  /** panel key -> 为一个面板的 wraps 已经 import 过的模块（挂载那条路复用同一个模块对象，不重复 import）。 */
  const wrapModules = new Map();
  let subscribed = false;
  let unsubscribe = null;
  let flushing = false;
  let dirty = false;
  let disposed = false;
  /**
   * 那一份 `welcome` 快照的订阅退订函数（`dispose` 要一并撤掉 —— 注入过一次的东西必须能收回来）。
   *
   * **为什么在构造时就订阅，而不是等某个面板读第一格时再订阅**：`main.js` 在收到 `welcome` 的那一次回调里才
   * `apply()` 面板清单（`:341`），所以「读第一格时再订阅」注定**永远**追不上任何一帧 —— 连重连的那一帧都追不上。
   * 注册点本来就活在这一层订阅里（它与 `modPanels` / `assets` / `theme` 是同一个订阅者的邻居），先订阅一格
   * 读面不新增任何**帧**、任何请求、任何 DOM：只是在别人已经在处理的那条帧上留一份只读副本。
   * @type {Function|null}
   */
  let unsubscribeWelcome = null;

  /** One named refusal: reported to the console and collected for the caller (a test, a diagnostic report). */
  function refuse(code, detail) {
    rejected.push({ code, detail });
    log?.error?.(`[mod-panels] ${code}: ${detail}`);
  }

  /**
   * `ctx.net.transport()` 拿不到读数时的那**一行**日志（每种原因一次，见 `transportGapsLogged` 的注释）。
   *
   * 走注册点的 `log`（`main.js` 接的是页面控制台）：面板的 `ctx.log` 是按包分区的，而「这格字段这台服务器
   * 根本没有」是一个**引擎级**的事实，该在页面控制台上说一次，而不是在每个读它的包的日志里各说一次。
   * @param {string} reason @param {string} detail
   */
  function noteTransportGap(reason, detail) {
    if (transportGapsLogged.has(reason)) return;
    transportGapsLogged.add(reason);
    log?.warn?.(`[mod-panels] CLIENT_TRANSPORT_UNAVAILABLE (${reason}): ${detail}`);
  }

  /**
   * `ctx.battle.damage()`（DESIGN §28.38）拿不到读数时的那**一行**日志，每种原因一次（`transportGapsLogged`
   * 的同一条规矩、同一个理由：面板每秒可能读一次，「这一格没接上」是一个**引擎级安装事实**，刷屏的日志与没有日志
   * 一样没用）。走注册点的 `log`，不走进面板自己的 `ctx.log` —— 那是按包分区的，而这件事只发生一次。
   *
   * **没有正在跑的战斗时不记**（`without-battle` 那条路根本走不到这里）：那是一个**正常状态**（准备期、结算期、
   * 刚开局），不是一个缺件。日志留给三种真的「接不上」：门面没被注入、`damage()` 抛了、返回值不成形。
   * @type {Set<string>}
   */
  const battleGapsLogged = new Set();
  /** @param {string} reason @param {string} detail */
  function noteBattleGap(reason, detail) {
    if (battleGapsLogged.has(reason)) return;
    battleGapsLogged.add(reason);
    log?.warn?.(`[mod-panels] CLIENT_BATTLE_UNAVAILABLE (${reason}): ${detail}`);
  }

  // 引擎自己那一份 `welcome` 快照（DESIGN §28.24 / §28.25）。`net.on` 不在（Node 用例、注入面极小的宿主）时什么都不做：
  // 那一格读面就是 `null`，面板照样装得上。
  if (net && typeof net.on === 'function') {
    try {
      const off = net.on('welcome', (msg) => { welcomeSnapshot = readonlySnapshot(msg ?? null); });
      if (typeof off === 'function') unsubscribeWelcome = off;
    } catch (err) {
      log?.error?.('[mod-panels] could not subscribe to `welcome` for ctx.net.welcome()', err);
    }
  }

  /** The wire entry, re-judged here: the client is a second reader of the same declaration (the server was the first). */
  function normalize(raw) {
    if (!isPlainObj(raw)) { refuse('CLIENT_BAD_PANEL', `panel declaration is not an object: ${JSON.stringify(raw)}`); return null; }
    const id = raw.id;
    const pack = raw.pack;
    if (!isPanelId(id)) { refuse('CLIENT_BAD_PANEL_ID', `panel id ${JSON.stringify(id)} is not a usable id`); return null; }
    if (typeof pack !== 'string' || !pack) { refuse('CLIENT_BAD_PANEL_ID', `panel "${id}" has no pack id`); return null; }
    const key = `${pack}/${id}`;
    if (!MOD_PANEL_SLOTS.includes(raw.slot)) {
      refuse('CLIENT_BAD_PANEL_SLOT', `panel "${key}" declares slot ${JSON.stringify(raw.slot)} — not one of ${MOD_PANEL_SLOTS.join(', ')}`);
      return null;
    }
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (!url.startsWith(MOD_PANEL_PREFIX) || !url.split('?')[0].endsWith('.js')) {
      refuse('CLIENT_BAD_PANEL_MODULE', `panel "${key}" declares ${JSON.stringify(raw.url)} — only ${MOD_PANEL_PREFIX}<pack>/<module>.js is importable`);
      return null;
    }
    if (raw.order !== undefined && !Number.isInteger(raw.order)) {
      refuse('CLIENT_BAD_PANEL_ORDER', `panel "${key}" declares order ${JSON.stringify(raw.order)} — an integer or nothing`);
      return null;
    }
    if (raw.gate !== undefined && raw.gate !== null && (typeof raw.gate !== 'string' || !raw.gate)) {
      refuse('CLIENT_BAD_PANEL_GATE', `panel "${key}" declares gate ${JSON.stringify(raw.gate)} — a store path or nothing`);
      return null;
    }
    if (raw.requires !== undefined && !Array.isArray(raw.requires)) {
      refuse('CLIENT_UNKNOWN_REQUIRE', `panel "${key}" declares requires ${JSON.stringify(raw.requires)} — a list or nothing`);
      return null;
    }
    // 面板自带的样式表（业主裁决 2026-10-10）：客户端是**第二个读者**，所以与模块走同一条复判 —— 只认登记过的
    // 前缀 + `.css`。一份样式表的 URL 坏了不是「少一个样式」，而是这个面板看起来是坏的而没人知道为什么，所以它是
    // 点名拒绝整个面板（与坏模块同一个结局）。
    /** @type {Array<{ path: string, url: string }>} */
    const styles = [];
    for (const style of Array.isArray(raw.styles) ? raw.styles : []) {
      const url = style && typeof style.url === 'string' ? style.url : '';
      const stylePath = style && typeof style.path === 'string' ? style.path : '';
      if (!url.startsWith(MOD_PANEL_PREFIX) || !url.split('?')[0].endsWith('.css') || !stylePath) {
        refuse('CLIENT_BAD_PANEL_STYLE', `panel "${key}" declares stylesheet ${JSON.stringify(url)} — only ${MOD_PANEL_PREFIX}<pack>/<file>.css is injectable`);
        return null;
      }
      styles.push({ path: stylePath, url });
    }
    // 组件级改写（`client.panels[].wraps`，DESIGN §28.19）：这个面板要包裹 / 替换哪几个引擎具名组件。客户端是
    // **第二个读者**，所以与形状层同一条复判、同一批拒绝码。三条都用同一个出口：**点名 + 整个面板不落地** ——
    // 链挂了一半（这个组件改了、那个没改）比完全没改更难查，而「静默丢掉一条声明」正是这一层到处在拒绝的形态。
    /** @type {Array<{ component: string, mode: string }>} */
    const wraps = [];
    if (raw.wraps !== undefined) {
      if (!Array.isArray(raw.wraps) || !raw.wraps.length) {
        refuse('CLIENT_WRAP_BAD_SHAPE', `panel "${key}" declares wraps ${JSON.stringify(raw.wraps)} — a non-empty array of { component, mode }`);
        return null;
      }
      // 上限就是**枚举的大小**（一个组件一条链，重复的那条下面会被拒）：链长在**引擎组件**上，一次渲染要走完整条
      // 链 —— 一个坏掉 / 敌意的服务端不该能用一千条声明把 HUD 的每一帧变成一千层递归。
      if (raw.wraps.length > MOD_COMPONENT_IDS.length) {
        refuse('CLIENT_WRAP_BAD_SHAPE', `panel "${key}" declares ${raw.wraps.length} wraps — at most ${MOD_COMPONENT_IDS.length} components per panel (one link per component)`);
        return null;
      }
      for (const entry of raw.wraps) {
        if (!isPlainObj(entry) || typeof entry.component !== 'string' || !entry.component) {
          refuse('CLIENT_WRAP_BAD_SHAPE', `panel "${key}" declares the wrap ${JSON.stringify(entry)} — every entry is { component, mode } and component names an engine component`);
          return null;
        }
        if (!MOD_COMPONENT_IDS.includes(entry.component)) {
          refuse('CLIENT_WRAP_UNKNOWN_COMPONENT', `panel "${key}" wraps ${JSON.stringify(entry.component)}, which is not an engine component this build renders — one of ${MOD_COMPONENT_IDS.join(', ')}`);
          return null;
        }
        if (!MOD_WRAP_MODES.includes(entry.mode)) {
          refuse('CLIENT_WRAP_BAD_MODE', `panel "${key}" wraps "${entry.component}" with mode ${JSON.stringify(entry.mode)} — "wrap" (compose with the engine's own component) or "replace" (supply the whole subtree)`);
          return null;
        }
        if (wraps.some((w) => w.component === entry.component)) {
          refuse('CLIENT_WRAP_BAD_SHAPE', `panel "${key}" wraps "${entry.component}" twice — one component, one link (two links would be two wrappers nobody can tell apart)`);
          return null;
        }
        wraps.push({ component: entry.component, mode: entry.mode });
      }
    }
    return {
      key, id, pack, slot: raw.slot, url,
      wraps,
      order: Number.isInteger(raw.order) ? raw.order : 0,
      gate: typeof raw.gate === 'string' && raw.gate ? raw.gate : null,
      requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
      styles,
      // 数据口：这一版线上形状是数组（形状层已经判过名字在闭枚举里）；客户端是**第二个读者**，所以只认数组，
      // 别的写法当作「没声明」处理（一个坏字段不该让整个面板挂不上，但读了没声明的表会被点名，见 ctx.data.get）。
      data: Array.isArray(raw.data) ? raw.data.map(String) : [],
      // 包通道（`client.panels[].messages`）：客户端只把 `pack.msg` 交给**声明过**这个通道的面板。
      messages: Array.isArray(raw.messages) ? raw.messages.map(String) : [],
    };
  }

  /**
   * 已经注册的外观提供者（`<包>/<面板id>`）或 null；`appearanceRefused` 记「有人想注册但被拒」。
   * 进程内**最多一个**：见 `appearance()` 的三条性质。
   */
  let appearanceProvider = null;
  let appearanceRefused = false;

  /**
   * 已经注册的**素材加载源**提供者（`<包>/<面板id>`）或 null；`sourcesRefused` 记「有人想注册但被拒」。
   * 与上面那一对逐条同构，理由见 `registerSources`。见 DESIGN §28.40。
   */
  let sourcesProvider = null;
  let sourcesRefused = false;

  /**
   * 一个模块导出了 `appearance(ctx)` 时，把它接进解析链。
   *
   * 顺序：先 import，再这里，最后才是 `mount` —— 外观在**第一帧之前**就位，否则首帧画的是原版、下一帧才跳过去
   * （一个「闪一下再变」的错比不生效更难查）。失败一律**点名**，不静默。
   * @param {any} rec @param {any} mod
   * @returns {boolean} 是否成功建立（没有导出 `appearance` 时返回 true：那是「这个面板不提供外观」，不是失败）
   */
  function registerAppearance(rec, mod) {
    const fn = mod && typeof mod.appearance === 'function' ? mod.appearance : null;
    if (!fn) return true;
    if (appearanceProvider) {
      appearanceRefused = true;
      refuse('CLIENT_APPEARANCE_TAKEN', `panel "${rec.key}" exports appearance(ctx) but "${appearanceProvider}" already provides one — at most ONE appearance provider may be active (which operator's art it answers must not depend on import order)`);
      return false;
    }
    let provided;
    try {
      // `ctx` 与面板同一份（同一个边界：没有 store / match / battle）
      provided = fn(panelContext(rec, null, null));
    } catch (err) {
      refuse('CLIENT_APPEARANCE_THREW', `panel "${rec.key}" threw in appearance(ctx): ${err && err.message ? err.message : String(err)}`);
      return false;
    }
    const lookup = provided && typeof provided.lookup === 'function' ? provided.lookup : null;
    if (!lookup) {
      refuse('CLIENT_APPEARANCE_BAD_SHAPE', `panel "${rec.key}" appearance(ctx) must return { lookup(kind, charId, id) } (got ${provided === null ? 'null' : typeof provided})`);
      return false;
    }
    // 链只认「一个函数」：`list(charId)` 这类别的成员由提供者自己拿着，核心不认识「有哪些外观」。
    if (!setAppearanceLookup(lookup)) {
      refuse('CLIENT_APPEARANCE_TAKEN', `panel "${rec.key}" could not register its appearance provider`);
      return false;
    }
    appearanceProvider = rec.key;
    return true;
  }

  /**
   * **素材加载源**的提供者（`sources(ctx)`，DESIGN §28.40）—— 与 `registerAppearance` **逐条同构**，因为它们是同一
   * 张表面的两半：`pack.json.assets.mirrors[]` 说「哪些镜像被允许」，这个提供者只说「先试哪一条」。
   *
   * 四条性质，逐条照抄外观那条（差异只有一处，写在最后）：
   *   * **顺序**：import 之后、`mount` 之前 —— 一条只提供加载源、不挂界面的模块也该生效（与「只提供外观」同族）；
   *   * **最多一个**：后注册者被点名拒绝（`CLIENT_SOURCES_TAKEN`）——「哪台主机先说话」不许取决于 import 顺序；
   *   * **失败一律点名**：抛错 `CLIENT_SOURCES_THREW`、没有 `order` 成员 `CLIENT_SOURCES_BAD_SHAPE`；
   *   * **不导出 `sources` 时不是失败**（返回 `true`）：那是「这个面板不管加载源」，是绝大多数面板。
   *
   * **唯一的差异**：这里收的**不是一个能被调用的值，而是一个函数**。外观那条收到的是 `lookup`，因为链每一帧要拿它
   * 回答一次「这个干员画哪一张」；加载源这条一次导入只问一次「先试哪一条」，所以注册的是一个纯函数，由
   * `resources/sources.js orderDeclared()` 在**导入那一刻**调用，并且**只接受已声明 id 的排列/子集** ——
   * 一个主机名或 URL 在那里被拒（`CLIENT_SOURCES_BAD_ORDER`）。于是「包能改加载源」与「包不能指定任意主机」这两句话
   * 同时成立，而后者是**结构性**的：这个注册面没有位置写下任何地址。
   * @param {any} rec @param {any} mod
   * @returns {boolean} 是否成功建立（没有导出 `sources` 时返回 true：那是「这个面板不提供加载源」）
   */
  function registerSources(rec, mod) {
    const fn = mod && typeof mod.sources === 'function' ? mod.sources : null;
    if (!fn) return true;
    if (sourcesProvider) {
      sourcesRefused = true;
      refuse('CLIENT_SOURCES_TAKEN', `panel "${rec.key}" exports sources(ctx) but "${sourcesProvider}" already provides one — at most ONE load-source provider may be active (which mirror speaks first must not depend on import order)`);
      return false;
    }
    let provided;
    try {
      // `ctx` 与面板同一份（同一个边界：没有 store / match / battle）
      provided = fn(panelContext(rec, null, null));
    } catch (err) {
      refuse('CLIENT_SOURCES_THREW', `panel "${rec.key}" threw in sources(ctx): ${err && err.message ? err.message : String(err)}`);
      return false;
    }
    const order = provided && typeof provided.order === 'function' ? provided.order : null;
    if (!order) {
      refuse('CLIENT_SOURCES_BAD_SHAPE', `panel "${rec.key}" sources(ctx) must return { order(mirrors) } (got ${provided === null ? 'null' : typeof provided}) — the mirrors themselves are declared in pack.json, never here`);
      return false;
    }
    if (!setSourceOrder(order, rec.key)) {
      refuse('CLIENT_SOURCES_TAKEN', `panel "${rec.key}" could not register its load-source provider`);
      return false;
    }
    sourcesProvider = rec.key;
    return true;
  }

  /**
   * The frozen surface one panel module is called with (see the header: what is NOT here is the point).
   *
   * `extra` is how a **component rewrite** (DESIGN §28.19) gets its two additions on top of the very same object:
   * `{ component, props }` — the id this link rewrites and that component's props as a read-only deep snapshot. A
   * wrapper is not mounted anywhere, so `host` / `hostKey` are `null` for it (the shape is the same; nothing else is
   * added, and there is still no store, no engine and no match state).
   */
  function panelContext(rec, host, hostKey = null, extra = null) {
    const scoped = Object.freeze({
      info: (...a) => log?.info?.(`[mod ${rec.key}]`, ...a),
      warn: (...a) => log?.warn?.(`[mod ${rec.key}]`, ...a),
      error: (...a) => log?.error?.(`[mod ${rec.key}]`, ...a),
    });
    const session = Object.freeze({
      /**
       * The entry gate (缺口 3): the two `session` flags `selectRoute` reads. The ONLY store write a panel gets.
       * @param {{ required?: boolean, ready?: boolean }} state
       * @returns {boolean} whether anything was written
       */
      setPreload(state) {
        /** @type {Record<string, boolean>} */
        const patch = {};
        if (state && typeof state.required === 'boolean') patch.preloadRequired = state.required;
        if (state && typeof state.ready === 'boolean') patch.preloadReady = state.ready;
        if (!Object.keys(patch).length) return false;
        store.patch('session', patch);
        return true;
      },
      /**
       * **这一格的偏好**（`prefs` 那个模块级表，不是 store）：一个面板要记住「每干员选了哪套」这类东西，
       * 而它**没有** localStorage / store 的写权限 —— 所以引擎给一格受限的键值口。
       *
       * 为什么不是把 store 交出去：store 里放着对局状态（`match` / `room` / `me`），
       * 一个面板能写它就等于能改对局 —— 那是这一层从头到尾在避免的事。这一格**只有**偏好。
       *
       * 键与值都有界：键 1..64 字符，值只收 `string` / `number` / `boolean` / `null`（复杂结构请自己
       * 序列化成字符串）—— 一个面板不该把任意对象塞进偏好里，那会让「偏好」变成第二个数据库。
       * **越界一律 `false` 并点名**，不静默。
       * @param {string} key @param {string|number|boolean|null} value
       * @returns {boolean} 是否写入
       */
      setPref(key, value) {
        if (typeof key !== 'string' || !key || key.length > PREFS_MAX_KEY) {
          refuse('CLIENT_PREF_BAD_KEY', `panel "${rec.key}" setPref("${String(key).slice(0, 40)}") — the key must be a non-empty string of at most ${PREFS_MAX_KEY} characters`);
          return false;
        }
        const ok = value === null || ['string', 'number', 'boolean'].includes(typeof value);
        if (!ok) {
          refuse('CLIENT_PREF_BAD_VALUE', `panel "${rec.key}" setPref("${key}", ${typeof value}) — the value must be a string, number, boolean or null (serialise anything larger yourself)`);
          return false;
        }
        if (typeof value === 'string' && value.length > PREFS_MAX_VALUE) {
          refuse('CLIENT_PREF_BAD_VALUE', `panel "${rec.key}" setPref("${key}") — a string value of at most ${PREFS_MAX_VALUE} characters`);
          return false;
        }
        setPref(`${rec.pack}/${key}`, value);
        return true;
      },
      /** 读回 `setPref` 写下的那一格（没有时是 `dflt`）。 */
      getPref(key, dflt = null) {
        if (typeof key !== 'string' || !key) return dflt;
        const v = getPref(`${rec.pack}/${key}`);
        return v === undefined ? dflt : v;
      },
      /**
       * **设置库里唯一一格面板能写的东西**：某个干员的配音语言（业主裁决 2026-10-11「能优化就优化，但要守边界」）。
       *
       * 面板今天读得到这台机器用哪套配音（`ctx.me.voice`），但改不了它 —— 而「这个干员的语音我想听另一种」
       * 正是干员详情里那个切换口做的事。所以给一格**受限**写口，形状与 `setPreload` 同族（成功/失败用布尔回答），
       * 边界见模块顶部 `VOICE_CHAR_ID_RE` 的注释，三条：
       *   * 只写 `voiceLangByChar` 的**这一格**，其它设置一个字节都不动；
       *   * 值只收 `VOICE_LANGS` 的成员，或 `''` / `null`（清掉覆盖 ⇒ 回到跟随全局）；
       *   * 纯本地偏好：播放时解析，发不出帧、改不了对局 —— 「面板可以画错、但不能算错」在这里就是
       *     「面板可以让你多听一句别的配音，但不能多打一点伤害」。
       *
       * **越界一律 `false` 并点名**（`CLIENT_VOICE_*`），不静默：一个被丢掉的写入如果只是「没反应」，
       * 作者会以为是引擎的 bug；`undefined`（忘了传第二个参数）也**不是**清空 —— 清空要写明 `''` 或 `null`。
       * @param {string} charId 干员 id（形状见 `VOICE_CHAR_ID_RE`，与 `sanitizeVoiceLangByChar` 同一判据）
       * @param {'cn'|'jp'|'en'|'kr'|''|null} lang 配音语言，或空值 = 清除这一格的覆盖
       * @returns {boolean} 是否写入
       */
      setVoiceLang(charId, lang) {
        if (typeof charId !== 'string' || !VOICE_CHAR_ID_RE.test(charId)) {
          refuse('CLIENT_VOICE_BAD_CHAR', `panel "${rec.key}" setVoiceLang(${JSON.stringify(typeof charId === 'string' ? charId.slice(0, 40) : charId)}, …) — an operator id must be "char_" + 1..64 of A-Za-z0-9_ (the same shape a per-operator voice-override key may have)`);
          return false;
        }
        const clear = lang === '' || lang === null;
        if (!clear && !VOICE_LANGS.includes(lang)) {
          refuse('CLIENT_VOICE_BAD_LANG', `panel "${rec.key}" setVoiceLang("${charId}", ${JSON.stringify(lang)}) — the dub must be one of ${VOICE_LANGS.join(', ')}, or "" / null to clear this operator's override. That is the whole list: a panel cannot invent a dub, and an omitted argument is not a clear (write "" instead)`);
          return false;
        }
        if (!settingsApi || typeof settingsApi.setVoiceLang !== 'function') {
          refuse('CLIENT_VOICE_NO_SETTINGS', `panel "${rec.key}" setVoiceLang("${charId}", …) — this page injected no settings store, so the write is refused by name instead of silently doing nothing`);
          return false;
        }
        /** @type {boolean} */
        let ok;
        try { ok = settingsApi.setVoiceLang(charId, clear ? '' : lang) === true; } catch (err) {
          refuse('CLIENT_VOICE_WRITE_FAILED', `panel "${rec.key}" setVoiceLang("${charId}") threw in the settings store: ${err && err.message ? err.message : String(err)}`);
          return false;
        }
        if (!ok) {
          // 到这里说明两边的判据都过了、而设置库自己没写：它那一层还有一条上限（`VOICE_OVERRIDE_MAX`，400 个
          // 干员）—— 一个**只有引擎知道**的边界，所以在这里点名，而不是让面板以为写成功了。
          refuse('CLIENT_VOICE_REFUSED', `panel "${rec.key}" setVoiceLang("${charId}", ${JSON.stringify(lang)}) was refused by the settings store (the per-operator override table has a size limit of its own; nothing was written)`);
          return false;
        }
        return true;
      },
      /**
       * **发一条引擎消息**（业主裁决：面板要能主动做一件对房内可见的事，例如换装广播）。
       *
       * 白名单是**闭枚举** `PANEL_SEND_TYPES`，不是「想发什么发什么」：面板能改的是**展示**，
       * 所以今天只有 `room.appearance`（它只改别人看到的外观、不碰战果）。加一条要同时改这张表、
       * 它的 C2S 形状与一条测试 —— 这是有意的摩擦（一个面板能改对局状态的那一天，就是这一层失效的那一天）。
       *
       * 形状由 `shared/protocol.js` 再判一遍（客户端是**第一个**读者，服务端是最后的）：这里先判一次
       * 是为了让作者当场看到问题，而不是等一个 `error` 帧回来。
       * @param {string} type @param {any} fields
       * @returns {boolean} 是否发出去了
       */
      send(type, fields) {
        if (typeof type !== 'string' || !PANEL_SEND_TYPES.includes(type)) {
          refuse('CLIENT_SEND_NOT_ALLOWED', `panel "${rec.key}" send("${String(type).slice(0, 40)}") — a panel may only send ${PANEL_SEND_TYPES.map((x) => `"${x}"`).join(', ')} (the closed list of engine messages a panel may originate; everything else is not a display action)`);
          return false;
        }
        if (!net || typeof net.send !== 'function') return false;
        const msg = { t: type, ...(fields && typeof fields === 'object' ? fields : {}) };
        // 客户端先判一次形状（与服务端同一份判据）：判不过就**不发**，并点名 —— 发出去只会换回一个 error 帧
        const bad = typeof validateC2S === 'function' ? validateC2S(msg) : null;
        if (bad) {
          refuse('CLIENT_SEND_BAD_SHAPE', `panel "${rec.key}" send("${type}") has a bad shape: ${bad}`);
          return false;
        }
        return net.send(msg);
      },
    });
    // 只读会话态的取数：每次读都重新取一次 store（面板挂上之后**不重挂**，一次性的值会变陈旧 —— 与
    // `ctx.data.get()` 同一条思路：那份读的是活数据层、每次调用都取当前值）。取不到就是 `null`：
    // 「还没进房间」是一个合法状态，不是错误（面板该画空态，而不是抛）。
    /** @returns {{ playerId: string|null, name: string|null, room: object|null }} 一次读的冻结快照 */
    const readMe = () => {
      const snap = (store && typeof store.get === 'function' ? store.get() : null) || {};
      const me = snap.me && typeof snap.me === 'object' ? snap.me : null;
      const meId = me && typeof me.playerId === 'string' && me.playerId ? me.playerId : null;
      const meName = me && typeof me.name === 'string' && me.name ? me.name : null;
      const rawRoom = snap.room && typeof snap.room === 'object' ? snap.room : null;
      const seats = rawRoom && Array.isArray(rawRoom.seats) ? rawRoom.seats : null;
      const seatIdx = seats ? seats.findIndex((s) => s && s.playerId === meId) : -1;
      // 房间快照只带**展示面**：座位表本身就是公开视图，面板拿 playerId 自己找。
      const room = rawRoom ? Object.freeze({
        code: typeof rawRoom.code === 'string' ? rawRoom.code : null,
        mode: typeof rawRoom.mode === 'string' ? rawRoom.mode : null,
        difficulty: typeof rawRoom.difficulty === 'string' ? rawRoom.difficulty : null,
        inMatch: !!rawRoom.inMatch,
        // 我的座位号；旁观 / 不在座为 null
        mySeat: seatIdx >= 0 ? seatIdx : null,
        // 我是不是旁观者：与 `store.isSpectating` 同一条判据（座位表里没有我、观众席里有我）
        spectating: !!(rawRoom.spectators && Array.isArray(rawRoom.spectators)
          && rawRoom.spectators.some((s) => s && s.playerId === meId)),
        // 房间自己那一套（W-A）：面板要知道"这一局跑的是哪几个包"时用它；没声明就是 null
        mods: Array.isArray(rawRoom.mods) ? Object.freeze([...rawRoom.mods]) : null,
      }) : null;
      return Object.freeze({ playerId: meId, name: meName, room });
    };
    /**
     * **只读会话态**（业主裁决「一格只读会话态」）：面板答不出来、只能由引擎告知的事实。
     *
     * 三项：`playerId` / `name`（我是谁 —— 自己的座位、自己的消息，面板无法从别处推出来）、
     * `room`（房间的**展示面**快照：`code` / `mode` / `difficulty` / `inMatch` / `mySeat` / `spectating` / `mods`）。
     * `cardMarks` 靠"换局"清标记、`chat` 靠 `spectating` 禁输入、`matchOverlay` 靠 `inMatch`。
     *
     * **为什么是 getter 而不是固定值**：面板挂上之后**不重挂**（注册点不会因为 store 变了再调一次 `mount`），
     * 一次性的值会一直停在挂载那一刻。所以这三个读数**每次读都取当前值**，与 `ctx.data.get()` 同一条思路。
     *
     * **刻意不含 `search`（野排匹配态）**：那个读数今天活在**大厅屏自己的 `useState`** 里（`screens/lobby.js`
     * 订阅 `room.queued`），store 里没有它。要让面板读到就得先把它提升进 store —— 那是**为一个已无价值的件**
     * （引擎 0.13.0 已自带快速匹配）新增一格客户端全局状态，属于「不必要的不动」。真要做，是另一件事。
     *
     * **边界仍然由「不传什么」保证**：只有这几样标量/浅快照 —— **没有** store 句柄、没有 match / battle 对象、
     * 没有 battleRunner、没有 audio。面板**读得到、改不动、也算不了**。
     */
    /**
     * **配音读数**（`ctx.me.voice`，业主裁决 2026-10-11）：`{ global, byChar }`，与 `readMe()` 同形 ——
     * **每次读都重新取一次设置库**，返回一份新的冻结对象。
     *
     * 为什么面板答不出来：设置库住在**另一个** store（`public/js/ui/settings.js:50` 的 `settingsStore`，
     * 与 `ctx.me` 读的那个 `public/js/store.js` 不是同一个），而注入面里没有 store 句柄 —— 面板拿不到
     * 「这台机器现在用哪套配音」，也推不出逐干员的覆盖。
     *
     * 形状与只读语义：
     *   * `global`：全局配音（`settings.voiceLang`），永远是 `VOICE_LANGS` 的成员；设置库没注入 / 不成形时整格是 `null`；
     *   * `byChar`：逐干员覆盖的**冻结浅拷贝**（缺档 = 不在这里，不是 `null`）—— 连同 `global` 就是完整的
     *     「覆盖 → 全局」链，而链的最后一档（默认配音）由 `sanitizeSettings` 保证不会露出来：store 里的
     *     `voiceLang` 一定是 `VOICE_LANGS` 的成员，所以 `byChar[charId] ?? global` 就是引擎播放时用的那个语言。
     *     这里对 store 里的值**再判一次**（第二个读者）：形状不是 `char_…` 的键、不在 `VOICE_LANGS` 里的值一律
     *     不进快照 —— 面板照它画出来的东西不该与音频管理器播放的不一致。
     *
     * 它是**读数**：改它 `TypeError`，引擎之后的选择变化不会回溯进**已经发出去**的那一份（每次读都是新的）。
     * @returns {{ global: string|null, byChar: Record<string, string> }|null}
     */
    const readVoice = () => {
      /** @type {any} */
      let s;
      try { s = settingsApi && typeof settingsApi.get === 'function' ? settingsApi.get() : null; } catch { return null; }
      if (!s || typeof s !== 'object') return null;
      /** @type {Record<string, string>} */
      const byChar = {};
      const raw = s.voiceLangByChar;
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (VOICE_CHAR_ID_RE.test(k) && VOICE_LANGS.includes(v)) byChar[k] = v;
      }
      return Object.freeze({
        global: VOICE_LANGS.includes(s.voiceLang) ? s.voiceLang : null,
        byChar: Object.freeze(byChar),
      });
    };
    const meFacade = Object.freeze({
      get playerId() { return readMe().playerId; },
      get name() { return readMe().name; },
      get room() { return readMe().room; },
      /**
       * 配音读数（见 `readVoice`）。**不**放进 `snapshot()`：那三个格来自**一次** `store.get()`（「一次取全」
       * 才不撕裂），而这一格来自另一个 store —— 混进去会让「一次读」这句话变成两个来源的假话。
       */
      get voice() { return readVoice(); },
      /** 一次取全（一次 `store.get()`，三样一致）：面板要同时用两个以上的读数时用它，避免三次分别取出现撕裂。 */
      snapshot: readMe,
    });
    const netFacade = Object.freeze({
      /**
       * 订阅。**引擎类型**（`shared/protocol.js S2C`）照旧原样透传；其余名字被当作**这个包自己的通道**，必须先在
       * `client.panels[].messages` 里声明过，否则**点名**（`CLIENT_CHANNEL_UNDECLARED`）并返回一个什么都不做的
       * 退订函数 —— 一个永远不会响的订阅是这一层最不愿留下的东西（作者会一直等一条不会来的消息）。
       * @param {string} type 引擎类型，或本包声明过的通道名
       * @param {Function} fn
       * @returns {Function} 退订
       */
      on(type, fn) {
        if (typeof type !== 'string' || typeof fn !== 'function') return () => {};
        if (S2C_TYPES.has(type)) return net && typeof net.on === 'function' ? net.on(type, fn) : () => {};
        if (!rec.messages.includes(type)) {
          refuse('CLIENT_CHANNEL_UNDECLARED', `panel "${rec.key}" subscribes to "${type}" without declaring it — add it to client.panels["${rec.id}"].messages (declared: ${rec.messages.join(', ') || 'none'}), or use an engine message type`);
          return () => {};
        }
        if (!net || typeof net.on !== 'function') return () => {};
        // 引擎把 `pack.msg` 发给整个房间；这里按**包 + 通道**筛自己那一份（第二个读者）。
        const off = net.on('pack.msg', (msg) => {
          if (!msg || msg.pack !== rec.pack || msg.channel !== type) return;
          fn(msg.data, msg);
        });
        channelOffs.push(off);
        return off;
      },
      /**
       * 发一条**自己的**通道消息（§1.9.6）：引擎只当不透明载荷转发，不解释、不落库、不判断谁该收。频率与大小由
       * 服务端管（`PACK_MSG_LIMITS`），形状由 `shared/protocol.js` 判 —— 客户端这一层只管「你有没有声明这条通道」。
       * @param {string} channel
       * @param {any} [data] 不透明 JSON（服务端有一个大小上限）
       * @returns {boolean} 是否发出去了
       */
      send(channel, data) {
        if (typeof channel !== 'string' || !channel) return false;
        if (!rec.messages.includes(channel)) {
          refuse('CLIENT_CHANNEL_UNDECLARED', `panel "${rec.key}" sends on "${channel}" without declaring it — add it to client.panels["${rec.id}"].messages (declared: ${rec.messages.join(', ') || 'none'})`);
          return false;
        }
        if (!net || typeof net.send !== 'function') return false;
        return net.send({ t: 'pack.msg', pack: rec.pack, channel, ...(data === undefined ? {} : { data }) });
      },
      sendResourceMessage: (msg) => (net && typeof net.sendResourceMessage === 'function' ? net.sendResourceMessage(msg) : false),
      /**
       * **连接读数**（DESIGN §28.24 / §28.25，业主裁决「引擎补两格只读读面」）：引擎自己已经握着的那份连接状态的**只读快照**。
       *
       * 来源是 `public/js/net.js` 的 `Net.snapshot()`（`'status'` 事件携带的就是它）——**同一条事实**，不是第二份推断：
       * 连接 / 重连 / 延迟 / 最后一次错误只有引擎答得出来，面板拿不到 `WebSocket`、拿不到心跳往返。
       *
       * 形状（键与 `Net.status` 的取值一字不差）：
       * ```
       * { status: 'idle'|'connecting'|'connected'|'handshaking'|'online'|'reconnecting'|'closed',
       *   attempt: number, retryAt: number, ping: number|null,
       *   lastError: { code: string, text: string } | null }
       * ```
       * 只读语义：**每次调用都是一份新的、冻结的副本**，只带上面这五个键（`playerId` 等引擎内部字段不外传）；
       * 改它不影响引擎的状态，引擎之后的状态变化也不会污染**已经发出去**的那一份。
       *
       * 拿不到时返回 `null`，**不抛、不编造**：注入的 `net` 没有 `snapshot()`（Node 用例、极小的宿主），
       * 或它的返回值不是一个带字符串 `status` 的对象。没有读数就是没有读数 —— 面板该画空态。
       *
       * 这是一格**读数**，不是一条通道：它不新增协议消息、不发任何帧、不改变引擎行为。
       * @returns {{ status: string, attempt: number, retryAt: number, ping: number|null, lastError: { code: string, text: string }|null }|null}
       */
      status() {
        if (!net || typeof net.snapshot !== 'function') return null;
        let snap;
        try { snap = net.snapshot(); } catch { return null; }
        if (!snap || typeof snap !== 'object' || typeof snap.status !== 'string') return null;
        const err = snap.lastError && typeof snap.lastError === 'object'
          ? Object.freeze({
            code: typeof snap.lastError.code === 'string' ? snap.lastError.code : null,
            text: typeof snap.lastError.text === 'string' ? snap.lastError.text : null,
          })
          : null;
        return Object.freeze({
          status: snap.status,
          attempt: Number.isFinite(snap.attempt) ? snap.attempt : 0,
          retryAt: Number.isFinite(snap.retryAt) ? snap.retryAt : 0,
          ping: Number.isFinite(snap.ping) ? snap.ping : null,
          lastError: err,
        });
      },
      /**
       * **服务器身份读数**（DESIGN §28.24 / §28.25）：客户端**已经收到的那一帧 `welcome`** 的只读快照
       * （`shared/protocol.js` S2C 的 `welcome`，服务端 `server/net.js:713` 组装）。
       *
       * 与 `ctx.net.on('welcome', fn)` 是**同一份事实**，只是不必再等一帧：面板由同一条 welcome 装载，
       * 自己订阅的那一份首帧大概率赶不上（包侧 README 记过这一点），而注册点本来就在这条帧上。
       *
       * 只读语义：**冻结的深拷贝**（与 `ctx.data.get()` 同一个 `readonlySnapshot`），面板改不动它，
       * 引擎之后收到的帧也不会污染**已经发出去**的那一份。帧里的字段原样保留（`playerId` / `name` / `token` /
       * `serverNow` / `version` / 可选的 `mods` / `modPanels` / `modAssets` / `modTheme` / `maxSeats` …）——
       * 它是引擎已经发给页面的那一份，不裁剪、不改名、不补默认值。
       *
       * 拿不到时返回 `null`，**不抛、不编造**：这一页还没收到过任何一帧 `welcome`（标题屏、握手被拒、干净安装）。
       * 它也不触发任何新请求：读的就是引擎已经收到的那一份。
       * @returns {any|null}
       */
      welcome() {
        return welcomeSnapshot;
      },
      /**
       * **传输层读数**（DESIGN §28.32，业主裁决 2026-10-11 的「动态挂点」那一批）：这一条 WebSocket 连接实际跑在
       * 什么参数上 —— 压缩开关与参数、单帧上限、压缩阈值。
       *
       * **为什么只能由服务端给**：浏览器侧的 `WebSocket` API **不暴露** `Sec-WebSocket-Extensions`（也没有
       * `maxPayload`），所以面板（以及引擎自己）都推不出来 —— 而这正是 `permessage-deflate` 那种会让
       * 「帧大小 / 延迟 / CPU」三件事一起变的配置最容易被误判的地方。服务端知道它自己启动时用的参数，于是在
       * `welcome` 里带一格**只读**字段；这一格读的就是那一帧（与 `ctx.net.welcome()` 同一条事实、同一份快照）。
       *
       * 形状（服务端那一格的四个键，逐个复判；键名与 `shared/protocol.js` 的 `welcome` 注释一致）：
       * ```
       * { deflate: boolean|null, params: string|null, maxPayload: number, threshold: number|null }
       * ```
       * `deflate` / `params` / `threshold` 读不到就是 `null`（不是 `false` / `''` / `0`：「不知道」与「关着」
       * 是两件事）；`maxPayload` 是必填的那一格，不成形（不是有限非负数）就**整格 `null`** —— 半个读数比
       * 没有读数更容易被算错。
       *
       * 拿不到时返回 `null`，**不抛、不编造**，并**记一行**（注册点的 `log` = 页面控制台，每种原因只记一次）：
       *   * 这一页还没收到过任何 `welcome`（标题屏、握手被拒）—— 这是「还没到时候」，**不记**；
       *   * 收到的 `welcome` 里**没有** `transport`（老服务器 / 未装服务端那一格的部署）—— 记一行，
       *     并如实说明「待服务端补字段」，**不自己造一个默认值**（一个凭空来的 `maxPayload: 65536` 比
       *     `null` 危险得多：面板会照它去解释为什么帧被拒）。
       *
       * 这是一格**读数**：不新增协议消息、不发任何帧、不改变引擎行为（与 `status()` / `welcome()` 同一条判据，
       * `test/modClientNetReads.test.js` 的四个出口计数器一并管着它）。
       * @returns {{ deflate: boolean|null, params: string|null, maxPayload: number, threshold: number|null }|null}
       */
      transport() {
        if (!welcomeSnapshot) return null;
        const raw = welcomeSnapshot.transport;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          noteTransportGap('absent', 'the `welcome` frame this page received carries no `transport` field — returning null (the server side of this cell, `pack.json.server.transport`, is not installed on this deployment; nothing is invented here)');
          return null;
        }
        const maxPayload = raw.maxPayload;
        if (!Number.isFinite(maxPayload) || maxPayload < 0) {
          noteTransportGap('bad-max', `the \`welcome.transport.maxPayload\` this page received is not a finite number ≥ 0 (${JSON.stringify(maxPayload)}) — the whole reading is null rather than half a reading`);
          return null;
        }
        return Object.freeze({
          deflate: typeof raw.deflate === 'boolean' ? raw.deflate : null,
          params: typeof raw.params === 'string' ? raw.params : null,
          maxPayload,
          threshold: Number.isFinite(raw.threshold) ? raw.threshold : null,
        });
      },
    });
    /**
     * **战斗读数**（DESIGN §28.38，业主裁决 2026-10-11 的第二批）：这一场战斗的**逐单位伤害累计**，连同一个
     * **时间基准**，让包自己算 DPS（「伤害看板」点名的那一格）。
     *
     * **为什么引擎必须给**：默认路径下战斗在这台机器上跑（`public/js/battle/runner.js`），伤害元组走 runner
     * **自己的** listener map，**根本不进 `net`** ⇒ 面板订阅不到（§28.30 已查明）。而伤害数字早在模拟里算好了：
     * `server/sim/damage.js:424` 每次命中写 `source.stats.dmg`，`:371` 写 `battle._pp(ownerId).damageDealt`，
     * `:352` 写 `bossDamage`。这一格就是**把已经在那儿的数字取出来**，不是第二份账。
     *
     * **形状**（一次读一份新的、冻结的副本；`dmg` / `bossDmg` / `kills` / `heal` 取整，与结果页 `compactResult`
     * 同一口径）：
     * ```
     * { battleId, fieldId, kind, authoritative, own, gt, t0,
     *   players: [{ playerId, dmg, bossDmg, kills, heal }],
     *   units:   [{ id, uid, defId, ownerId, kind, dmg, kills, heal }] }
     * ```
     * `gt` 是**战斗内秒**（`Battle.time`），`t0` 恒为 0（一局一场）⇒ `dps = dmg / (gt - t0)`。`uid` 是这块棋在那个
     * 玩家棋盘上的 id（与 `ctx.me` 的名单、`battleRunner.unitIdOf()` 同一个号）—— 面板对名单要用它。`players[]` 里
     * 的 `dmg` 已经含 `bossDmg`（与 `m.result` 的 `stats.dmgDealt` 同一口径），所以「总伤」与「领袖伤害」都在这一格，
     * 作者不必再拼 `m.result` + `b.pool` 两个面。
     *
     * **只给本场**：读的就是**屏上这一场**（与 `battleRunner.unitStats()` 同一语义）。**队友那几场不在这一格里**，
     * 正在准备的下一场也不在；一次战斗只有一个 `battleId`。面板要的是**全队总伤**时请走 `m.result`
     * （`players[].stats.dmgDealt`，那是服务端按每个玩家累出来的全队口径）。
     *
     * 只读语义：**每次调用都是一份新的、冻结到第二层的副本**（嵌套对象与数组逐个冻上）—— 面板写它当场 `TypeError`，
     * 引擎之后的新伤害也不会回溯进**已经发出去**的那一份。
     *
     * **这里不用 `readonlySnapshot`，是有意的**：那个函数的底图缓存是**按源对象**缓存的（`snapshotCache`），而这一格
     * 每次读都造一个**新对象** ⇒ 用它等于每次读往缓存里塞一个新键，一局几千次读就把缓存撑爆。它适用的场合是
     * 「每次读拿到同一个源对象」（`ctx.data.get()` 那几张表）。
     *
     * 拿不到时返回 `null`，**不抛、不编造** —— 而且**绝不**让这一格把别的东西带崩，所以四条出口分开写：
     *   * 没注入 `battle`（Node 用例、极小的宿主）⇒ `null` + 一行；
     *   * `damage()` 抛了 ⇒ `null` + 一行；
     *   * 返回值不是一个对象 ⇒ `null` + 一行（半个读数比没有更危险）；
     *   * 引擎说「这一场拿不到」（`null`：没有正在跑的战斗、战斗还没建好）⇒ `null`，**不记日志**（正常状态，不是缺件）。
     *
     * 它是一格**读数**，不是一条通道：不新增协议消息、不发任何帧、不改变战斗行为（判据见 `test/modClientBattleReads.test.js`）。
     * @returns {{ battleId: string, fieldId: string|null, kind: string, authoritative: boolean, own: boolean,
     *   gt: number, t0: number, players: ReadonlyArray<object>, units: ReadonlyArray<object> }|null}
     */
    const battleFacade = Object.freeze({
      damage() {
        if (!battleApi || typeof battleApi.damage !== 'function') {
          noteBattleGap('absent', 'no battle runtime is injected into this registry — returning null (main.js passes `battle: battleRunner`; a Node harness or a minimal host passes nothing, and nothing is invented here)');
          return null;
        }
        let snap;
        try { snap = battleApi.damage(); } catch (err) {
          noteBattleGap('threw', `the injected battle runtime threw in damage(): ${err && err.message ? err.message : String(err)}`);
          return null;
        }
        if (snap === null || snap === undefined) return null;   // 正常状态：这一场没有可读的战斗
        if (typeof snap !== 'object' || Array.isArray(snap)) {
          noteBattleGap('bad-shape', `damage() returned ${Array.isArray(snap) ? 'an array' : typeof snap} instead of an object — the whole reading is null rather than half a reading`);
          return null;
        }
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
        // 冻结到第二层：面板手里的每一格都改不动（`readonlySnapshot` 不适用，见上）
        const units = [];
        for (const u of Array.isArray(snap.units) ? snap.units : []) {
          if (!u || typeof u !== 'object') continue;
          units.push(Object.freeze({
            id: Number.isInteger(u.id) ? u.id : null,
            uid: Number.isInteger(u.uid) ? u.uid : null,
            defId: typeof u.defId === 'string' ? u.defId : null,
            ownerId: typeof u.ownerId === 'string' ? u.ownerId : null,
            kind: typeof u.kind === 'string' ? u.kind : null,
            dmg: num(u.dmg), kills: num(u.kills), heal: num(u.heal),
          }));
        }
        const players = [];
        for (const p of Array.isArray(snap.players) ? snap.players : []) {
          if (!p || typeof p !== 'object' || typeof p.playerId !== 'string') continue;
          players.push(Object.freeze({
            playerId: p.playerId, dmg: num(p.dmg), bossDmg: num(p.bossDmg), kills: num(p.kills), heal: num(p.heal),
          }));
        }
        return Object.freeze({
          battleId: typeof snap.battleId === 'string' ? snap.battleId : null,
          fieldId: typeof snap.fieldId === 'string' ? snap.fieldId : null,
          kind: typeof snap.kind === 'string' ? snap.kind : null,
          authoritative: !!snap.authoritative,
          own: !!snap.own,
          gt: num(snap.gt),
          t0: num(snap.t0),
          players: Object.freeze(players),
          units: Object.freeze(units),
        });
      },
    });
    /**
     * 数据口（业主裁决 2026-10-10）：面板**只读**的那几张表。
     *
     * 读一张**没在 `client.panels[].data` 里声明过**的表会返回 `null` 并**点名**（`CLIENT_DATA_UNDECLARED`，
     * 与别处的拒绝同一个出口：控制台一行 + `refusals()`）。不抛异常是有意的：一个包多读一行不该让整个界面消失，
     * 但这件事必须看得见 —— 「静默拿到 undefined」才是要消灭的那一种。
     */
    const dataFacade = Object.freeze({
      /**
       * 一张表的**只读快照**（冻结的深拷贝；同一个包多次调用拿到同一份），或 `null`。
       * @param {string} name e.g. 'chess'
       * @returns {any}
       */
      get(name) {
        if (typeof name !== 'string' || !name) return null;
        if (!rec.data.includes(name)) {
          refuse('CLIENT_DATA_UNDECLARED', `panel "${rec.key}" reads the data table "${name}" without declaring it — add it to client.panels["${rec.id}"].data (declared: ${rec.data.join(', ') || 'none'})`);
          return null;
        }
        if (!dataSnapshots.has(name)) {
          let raw = null;
          try { raw = dataApi && typeof dataApi.get === 'function' ? dataApi.get(name) : null; } catch { raw = null; }
          dataSnapshots.set(name, raw === undefined || raw === null ? null : readonlySnapshot(raw));
        }
        return dataSnapshots.get(name);
      },
      /** 这个面板声明过、可以读的表名（只读）。 */
      tables: () => [...rec.data],
    });
    return Object.freeze({
      id: rec.id, pack: rec.pack, slot: rec.slot, order: rec.order, gate: rec.gate,
      host, hostKey, session, net: netFacade, data: dataFacade, log: scoped,
      // 战斗读数（DESIGN §28.38）：这一场战斗的逐单位 / 逐人累计伤害 + 时间基准，供包自己算 DPS。
      // 仍然没有 runner 句柄、没有 Battle、没有 match 对象 —— 只有这一格冻结读数。
      battle: battleFacade,
      // 只读会话态（`playerId` / `name` / `room` 快照）：面板答不出来的那几件事实，由引擎告知。
      // 它是**活的只读读数**（每次读取当前 store），没有 store 句柄、没有 match / battle / runner / audio。
      me: meFacade,
      ...(extra || {}),
    });
  }

  /**
   * 一个面板这次要挂进**哪些**容器（业主裁决 2026-10-10 的「插进已存在的组件」那一半）。三种宿主：
   *   * **浮层**（`MOD_PANEL_CREATED`，0.11.0 的四个）—— 引擎按需创建容器（`slotHost`）；
   *   * **组件渲染的**（`screen.game.bondStrip` / `.hud` / `.overlay` / `screen.loadout.detail`）—— **只查不造**：
   *     容器没渲染出来就是「还没到时候」，下一次 store 变化再试。凭空虚造一个的结局是面板画在页面上一个谁也不
   *     认识的位置，而作者与玩家都不会知道为什么；
   *   * **可重复的**（`MOD_PANEL_REPEATABLE`，每张商店卡一个）—— 全部返回，面板挂进**每一个**。
   * @param {any} rec
   * @returns {Array<{ el: any, key: string|null }>}
   */
  function hostTargets(rec) {
    const found = (typeof slotHosts === 'function' ? slotHosts(rec.slot) : null) || [];
    const list = (Array.isArray(found) ? found : []).filter((el) => el && typeof el.appendChild === 'function');
    if (list.length) return list.map((el) => ({ el, key: hostKeyOf(el) }));
    if (!MOD_PANEL_CREATED.includes(rec.slot)) return [];
    const el = slotHost(rec.slot);
    return el && typeof el.appendChild === 'function' ? [{ el, key: null }] : [];
  }

  /** 这次挂载的键：可重复宿主按容器自己的键区分（不可重复的就是面板键本身）。 */
  function mountKeyOf(rec, key) { return key === null || key === undefined ? rec.key : `${rec.key}#${key}`; }

  /** 容器里那个属于这次挂载的 `div`（一个容器一次，缓存）。 */
  function ensureHost(rec, container, mk) {
    const had = hosts.get(mk);
    if (had) return had;
    const el = createElement('div');
    if (!el) return null;
    el.className = 'mod-panel';
    if (typeof el.setAttribute === 'function') el.setAttribute('data-mod-panel', mk);
    container.appendChild(el);
    hosts.set(mk, el);
    return el;
  }

  /** 样式表按**面板**注入一次：可重复宿主下会挂 N 份，样式只该在页面上出现一份。 */
  function injectStylesOnce(rec) {
    if (styled.has(rec.key)) return true;
    if (!injectStyles(rec)) return false;
    styled.add(rec.key);
    return true;
  }

  /**
   * 注入一个面板自带的样式表（业主裁决 2026-10-10）。三条性质：
   *   * **排在引擎样式之后**：`<link>` 追加到 `<head>` 末尾，后到的规则在层叠里更靠后；
   *   * **在调用工厂之前**注入：面板首次渲染时它自己的样式已经在层叠里（否则第一帧是没样式的）；
   *   * **可以收回来**：元素记在 `styleEls` 里，`dispose()` 一并移除。
   * 没有可注入的宿主（Node、一个没有 `<head>` 的壳）时**点名拒绝这个面板**，而不是「挂了但没样式」——
   * 那正是 §28.13.3 那条纪律：一条用不了的声明不许变成「装了但静默不工作」。
   * @param {any} rec
   * @returns {boolean} 全部注入成功
   */
  function injectStyles(rec) {
    if (!rec.styles.length) return true;
    const parent = styleHost();
    if (!parent || typeof parent.appendChild !== 'function') {
      refuse('CLIENT_PANEL_NO_STYLE_HOST', `panel "${rec.key}" declares ${rec.styles.length} stylesheet(s) but this page has no <head> to inject them into`);
      return false;
    }
    for (const style of rec.styles) {
      const el = createElement('link');
      if (!el) {
        refuse('CLIENT_PANEL_STYLE_FAILED', `panel "${rec.key}": could not create the element for stylesheet ${style.url}`);
        return false;
      }
      el.rel = 'stylesheet';
      el.href = style.url;
      if (typeof el.setAttribute === 'function') el.setAttribute('data-mod-style', `${rec.key}:${style.path}`);
      parent.appendChild(el);
      styleEls.push(el);
    }
    return true;
  }

  async function mountOne(rec, host, mk, hostKey) {
    // 声明了 `wraps` 的面板已经为它的链 import 过这个模块了：同一个 URL 只 import 一次（模块对象直接复用）。
    let mod = wrapModules.get(rec.key);
    if (!mod) {
      try {
        mod = await importModule(rec.url);
      } catch (err) {
        mounted.delete(mk);
        blocked.add(mk);
        refuse('CLIENT_PANEL_IMPORT_FAILED', `panel "${rec.key}" failed to import ${rec.url}: ${err && err.message ? err.message : String(err)}`);
        return true;
      }
    }
    // 外观提供者（皮肤层第 2 步）：**在 mount 之前**接进解析链，否则首帧画原版、下一帧才跳过去。
    // 它不依赖宿主是否渲染出来，所以放在 factory 判定之前 —— 一个只提供外观、不挂任何界面的模块也该生效。
    registerAppearance(rec, mod);
    // 素材加载源提供者（§28.40）：同一条理由、同一个位置 —— 「先试哪一条镜像」要在**第一次导入之前**就位，
    // 否则第一次导入走的是声明顺序、第二次才按玩家选的来（同一件事两个结果）。
    registerSources(rec, mod);
    const factory = mod && typeof mod.mount === 'function' ? mod.mount
      : (mod && typeof mod.default === 'function' ? mod.default : null);
    if (!factory) {
      // 一个**只提供外观 / 只提供加载源**的模块（导出 `appearance` / `sources` 而没有 `mount`）不是错误：它已经
      // 完成了它要做的事。其余情况仍旧点名（`CLIENT_PANEL_NO_MOUNT`）—— 声明了要挂却挂不上，必须响亮。
      if (appearanceProvider === rec.key || sourcesProvider === rec.key) return false;
      mounted.delete(mk);
      blocked.add(mk);
      refuse('CLIENT_PANEL_NO_MOUNT', `panel "${rec.key}" (${rec.url}) must export mount(ctx) (or default-export that function)`);
      return true;
    }
    let result;
    try {
      result = await factory(panelContext(rec, host, hostKey));
    } catch (err) {
      mounted.delete(mk);
      blocked.add(mk);
      refuse('CLIENT_PANEL_MOUNT_FAILED', `panel "${rec.key}" threw while mounting: ${err && err.message ? err.message : String(err)}`);
      return true;
    }
    const entry = mounted.get(mk);
    if (entry) entry.unmount = result && typeof result.unmount === 'function' ? result.unmount : null;
    return true;
  }

  /**
   * 组件级改写（`client.panels[].wraps`，DESIGN §28.19）：把一个面板的 wraps 声明变成长在引擎组件上的链。
   *
   * 三件事按这个次序发生，每一件都是**具名**的：
   *   * 模块 import 不了 ⇒ `CLIENT_PANEL_IMPORT_FAILED`（与挂载路径同一个码：坏的是这个字段，不是「在哪一层发现的」）；
   *   * 模块没有 `wrap` 导出 ⇒ `CLIENT_WRAP_NO_EXPORT`，**整个面板**不落地（连它声明的槽位也不挂 ——
   *     「一半的改写」比完全没有改写更难查）；
   *   * 导出过 `mount` 没有：记下来。一个**只改写**的模块不需要 `mount`，它声明了槽位也不往里面挂东西
   *     （所以那个空容器也不建）。
   *
   * 模块每个面板只 import 一次：挂载那条路复用这里拿到的模块对象（`wrapModules`），所以「既挂又改」的面板不会
   * import 两次。
   * @param {any} rec
   * @returns {Promise<boolean>} 链注册成功？
   */
  async function registerWraps(rec) {
    if (!rec.wraps.length || wrapLinks.has(rec.key)) return true;
    let mod;
    try {
      mod = await importModule(rec.url);
    } catch (err) {
      blockedPanels.add(rec.key);
      refuse('CLIENT_PANEL_IMPORT_FAILED', `panel "${rec.key}" failed to import ${rec.url}: ${err && err.message ? err.message : String(err)}`);
      return false;
    }
    const wrap = mod && typeof mod.wrap === 'function' ? mod.wrap : null;
    if (!wrap) {
      blockedPanels.add(rec.key);
      refuse('CLIENT_WRAP_NO_EXPORT', `panel "${rec.key}" declares wraps but ${rec.url} exports no wrap(ctx) — a rewrite that cannot be used drops the whole panel (its slot is not mounted either)`);
      return false;
    }
    wrapMounts.set(rec.key, typeof mod.mount === 'function' || typeof mod.default === 'function');
    wrapModules.set(rec.key, mod);
    wrapLinks.set(rec.key, rec.wraps.map((w) => ({
      component: w.component, mode: w.mode, pack: rec.pack, panel: rec.id, key: rec.key, wrap,
      report: refuse, reported: new Set(),
      // ctx = 面板那份冻结注入面 + `component` + `props`（这一帧的只读深拷贝，用数据口那一个 `readonlySnapshot`）。
      // 一个改写没有宿主可挂，所以 `host` / `hostKey` 是 `null`；除这两个之外**不多给任何东西**。
      makeCtx: (props) => panelContext(rec, null, null, { component: w.component, props: readonlySnapshot(props) }),
    })));
    return true;
  }

  /**
   * 重建每个组件的链。`panels` 已经按**既有面板比较器**排好（order → 包 id → 面板 id，§28.3），所以这个循环的
   * 次序**就是**链的次序：最先的那一条贴着引擎组件（内层），最后的那一条在最外面。只有链表真的变了才通知页面
   * 重画一次 —— 一个没声明 wraps 的服务器上，这个函数连一次都不会走到「变了」。
   */
  function syncWrapChains() {
    /** @type {Map<string, any[]>} */
    const byComponent = new Map();
    let links = 0;
    for (const rec of panels) {
      for (const link of wrapLinks.get(rec.key) || []) {
        if (!byComponent.has(link.component)) byComponent.set(link.component, []);
        byComponent.get(link.component).push(link);
        links++;
      }
    }
    if (setComponentWraps(byComponent)) onWrapsChanged(links);
  }

  async function flush() {
    if (disposed) return;
    if (flushing) { dirty = true; return; }
    flushing = true;
    try {
      for (const rec of panels) {
        if (disposed) return;
        if (blockedPanels.has(rec.key)) continue;
        const missing = capabilityIssues(rec.requires, env);
        if (missing.length) {
          blockedPanels.add(rec.key);
          refuse('CLIENT_REQUIRES_UNSUPPORTED', `panel "${rec.key}" requires ${missing.join(', ')}, which this browser does not provide`);
          // 明示：浏览器不支持不是「装了但静默不工作」—— 玩家与作者都必须看到这句话（DESIGN §28.13）。
          notify(t('{0} 需要浏览器支持 {1}，当前浏览器不支持 —— 这个包的面板不会挂载', [rec.pack, missing.join(', ')]), 'error');
          continue;
        }
        if (rec.gate) {
          const gate = readGate(store.get(), rec.gate);
          if (!gate.ok) {
            blockedPanels.add(rec.key);
            refuse('CLIENT_PANEL_GATE_UNKNOWN', `panel "${rec.key}" gates on ${JSON.stringify(rec.gate)}, which is not a path of the client store`);
            continue;
          }
          if (!gate.value) continue; // not yet: the next store change retries
        }
        // 组件级改写（DESIGN §28.19）：与槽位挂载**互相独立** —— 一个只改写的模块不导出 `mount`，一个既挂又改的模块
        // 两件事都做；链也**不依赖任何容器已经渲染**（这正是「改写一个组件」与「插进一个槽位」的区别）。
        if (rec.wraps.length) {
          if (!(await registerWraps(rec))) continue;      // 声明用不了 ⇒ 整个面板不落地（槽位也不挂）
          // 自带样式表在**改写生效之前**注入：改写的第一帧就该有它自己的样式（与挂载路径同一份 `styles[]`）。
          if (!injectStylesOnce(rec)) { blockedPanels.add(rec.key); continue; }
          if (wrapMounts.get(rec.key) === false) continue; // 只改写的模块：不建那个空容器
        }
        // 容器只在组件真的渲染出 `[data-mod-slot]` 之后才存在：没有就是「还没到时候」，不记任何东西，
        // 下一次 store 变化再试（可重复宿主因此会随着新卡片出现而逐个挂上）。
        const targets = hostTargets(rec);
        if (!targets.length) continue;
        if (!injectStylesOnce(rec)) { for (const { key } of targets) blocked.add(mountKeyOf(rec, key)); continue; }
        for (const { el, key } of targets) {
          if (disposed) return;
          const mk = mountKeyOf(rec, key);
          if (mounted.has(mk) || blocked.has(mk)) continue;
          const host = ensureHost(rec, el, mk);
          if (!host) continue;
          mounted.set(mk, { rec, host, unmount: null, key });
          await mountOne(rec, host, mk, key);
        }
      }
      // 链在**所有**面板都判过之后重建一次：`panels` 的次序就是链的次序，没声明 wraps 时这里什么都不做。
      syncWrapChains();
    } finally {
      flushing = false;
      if (dirty && !disposed) { dirty = false; void flush(); }
    }
  }

  function subscribe() {
    if (subscribed || disposed) return;
    subscribed = true;
    unsubscribe = store.subscribe(() => { void flush(); });
  }

  return {
    /**
     * Take the panel list of a `welcome` (`modPanels`). An empty list or an absent field means no pack declares a
     * client interface: nothing is imported, no element is created, no subscription is made. Mounting is asynchronous
     * (a module import), so refusals are read through `refusals()` rather than from this return value.
     * @param {any} list
     * @returns {{ accepted: number }}
     */
    apply(list) {
      if (disposed) return { accepted: 0 };
      /** @type {Array<any>} */
      const incoming = [];
      for (const raw of Array.isArray(list) ? list : []) {
        const rec = normalize(raw);
        if (rec && !incoming.some((p) => p.key === rec.key)) incoming.push(rec);
      }
      panels = incoming.sort(comparePanels);
      if (panels.length) subscribe();
      void flush();
      return { accepted: panels.length };
    },
    /** The panel keys currently mounted (test / diagnostic surface). */
    mounted: () => [...mounted.keys()].sort(),
    /** The engine component ids some panel currently rewrites (test / diagnostic surface, DESIGN §28.19). */
    wrapped: () => wrappedComponentIds(),
    /** The registered stylesheet URLs currently injected, in injection order (test / diagnostic surface). */
    styleUrls: () => styleEls.map((el) => el && el.href).filter((u) => typeof u === 'string'),
    /**
     * **外观提供者**的注册面（皮肤层的第 2 步，设计稿 §2 / §6）：一个面板模块**可以**（不是必须）导出
     * `appearance(ctx)`，返回 `{ lookup(kind, charId, id), list(charId) }`。它在模块 import 之后、`mount` 之前被调用，
     * 拿到的 `ctx` 与面板同一份（所以它同样没有 store / match / battle）。
     *
     * **`kind` 是 `'portrait'` / `'avatar'`**：链按这一条 kind 各问一次、只取这一条 kind 的字段，所以立绘与
     * 头像在提供者这一层就是两件可分开回答的事（偏好按 kind 分开记也是提供者自己的事）。步骤 4 那个
     * `opts.lookup` 是**另一条口**（历史形状，第一参数恒为 `'chars'`），两者不是同一个问题。
     *
     * 三条性质，每条都有理由：
     *   * **进程内最多一个提供者**：后注册者被**点名拒绝**（`CLIENT_APPEARANCE_TAKEN`）—— 「谁提供外观」不能有歧义，
     *     否则同一个干员的立绘取决于两个 mod 的加载次序；
     *   * **注册进解析链的唯一 hook**（`portraitChain.setAppearanceLookup`）：链本身不认识「皮肤」，
     *     它只知道「有一个函数可能回答这个 (kind, charId, id)」；
     *   * **没有提供者时链与今天逐字相同**（`currentAppearanceLookup()` 返回 `undefined`）。
     *
     * 为什么放在面板模块上而不是另开一个「mod 清单」：客户端能加载的代码只有**服务端声明过的那几条**
     * （`welcome.modPanels`），多开一条通道就等于多一处「服务端说加载了、浏览器永远拿不到」。同一个模块既挂界面、
     * 又提供外观，是**一条**已验证的加载路径。
     * @returns {{ providedBy: string|null, refused: boolean }}
     */
    appearance: () => ({ providedBy: appearanceProvider, refused: appearanceRefused }),
    /**
     * 素材加载源的提供者（`sources(ctx)`，DESIGN §28.40）。三条与 `appearance` 逐字相同：
     *   * **进程内最多一个**：后注册者被**点名拒绝**（`CLIENT_SOURCES_TAKEN`）——「哪台主机先说话」不能有歧义；
     *   * **注册进排序面的唯一 hook**（`resources/sources.js setSourceOrder`）：那个模块认识「一个函数」，**不**
     *     认识「有哪些主机」—— 主机只在 `pack.json.assets.mirrors[]`，且每一条都在装载期与包内容器摘要比对过；
     *   * **没有提供者时导入路径与今天逐字相同**（`orderDeclared` 不调用任何东西，按声明顺序；一个没声明
     *     `mirrors` 的包连这一步都不到）。
     *
     * 与 `appearance` 唯一的不同写在 `registerSources` 里：这里注册的是**函数**而不是一张查找表，因为「先试哪一条」
     * 一次导入只问一次，而不是每一帧问一次。
     * @returns {{ providedBy: string|null, refused: boolean }}
     */
    sources: () => ({ providedBy: sourcesProvider, refused: sourcesRefused }),
    /**
     * 包写的主题变量（`welcome.modTheme`, 业主裁决 2026-10-10）：写 CSS 自定义属性，**加法**语义 —— 只写这几个名字，
     * 不动任何规则、不替换任何样式表。原值记下来，`dispose()` 时按名字恢复。
     *
     * 客户端是**第二个读者**：与别处一样复判一遍形状（`--` 开头的名字、字符串值），坏名字跳过而不是写进去 ——
     * 一个不叫 `--x` 的键写进去是什么都不发生，那正是这一版到处在消灭的静默失败。
     * @param {{ vars?: Record<string, string> }} theme
     * @returns {{ applied: number }}
     */
    applyTheme(theme) {
      if (disposed) return { applied: 0 };
      const vars = theme && isPlainObj(theme.vars) ? theme.vars : null;
      if (!vars) return { applied: 0 };
      const root = themeHost();
      if (!root || !root.style || typeof root.style.setProperty !== 'function') return { applied: 0 };
      let applied = 0;
      for (const [name, value] of Object.entries(vars)) {
        if (!THEME_VAR_RE.test(name) || typeof value !== 'string' || !value) continue;
        if (!themePrevious.has(name)) themePrevious.set(name, root.style.getPropertyValue(name) || '');
        root.style.setProperty(name, value);
        applied++;
      }
      return { applied };
    },
    /** Every refusal so far, declaration and mount alike (test / diagnostic surface). */
    refusals: () => rejected.map((r) => ({ ...r })),
    /** Unmount every panel and stop following the store. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [key, entry] of mounted) {
        if (typeof entry.unmount !== 'function') continue;
        try { entry.unmount(); } catch (err) { log?.error?.(`[mod-panels] ${key} unmount failed`, err); }
      }
      mounted.clear();
      // 外观提供者随注册点一起收回：链回到「没有 hook」那条路径（与今天逐字相同），而不是留着一个指向
      // 已经拆掉的模块的函数 —— 那会让立绘继续解析到一套已经没人管的素材上。
      clearAppearanceLookup();
      appearanceProvider = null;
      // 加载源提供者同一条理由：排序面回到「没有 hook」那条路径，而不是留着一个指向已经拆掉的模块的函数 ——
      // 那会让下一次导入按一个没人再维护的顺序去试镜像。
      clearSourceOrder();
      sourcesProvider = null;
      for (const [, el] of hosts) {
        if (el && typeof el.remove === 'function') el.remove();
      }
      hosts.clear();
      // 注入过的东西一并收回：样式表元素移除，主题变量按名字恢复原值（原本没有这个变量就删掉它）。
      const root = themeHost();
      for (const [name, before] of themePrevious) {
        if (!root || !root.style) break;
        try {
          if (before) root.style.setProperty(name, before);
          else if (typeof root.style.removeProperty === 'function') root.style.removeProperty(name);
        } catch (err) { log?.error?.(`[mod-panels] theme ${name} restore failed`, err); }
      }
      themePrevious.clear();
      for (const off of channelOffs) {
        if (typeof off !== 'function') continue;
        try { off(); } catch (err) { log?.error?.('[mod-panels] channel unsubscribe failed', err); }
      }
      channelOffs.length = 0;
      // 引擎自己那一份 `welcome` 快照的订阅：与包通道的退订同一个出口（注入过一次的东西必须能收回来）。
      if (typeof unsubscribeWelcome === 'function') {
        try { unsubscribeWelcome(); } catch (err) { log?.error?.('[mod-panels] welcome unsubscribe failed', err); }
      }
      unsubscribeWelcome = null;
      welcomeSnapshot = null;
      for (const el of styleEls) {
        if (el && typeof el.remove === 'function') el.remove();
      }
      styleEls.length = 0;
      // 组件级改写一并撤回：链空了之后，引擎下一次渲染就是它今天那份实现（没有链就没有快照、没有分支变化）。
      clearComponentWraps();
      wrapLinks.clear();
      wrapMounts.clear();
      wrapModules.clear();
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      subscribed = false;
    },
  };
}
