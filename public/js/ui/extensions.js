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
// 引擎已经定义好的服务端→客户端类型（`shared/protocol.js S2C`）。**不在这里抄一份**：抄一份就是第二个会漂的真相，
// 而漂的方向是「一个面板订阅了一个引擎其实不会发的名字」—— 那正是这一层到处在拒绝的形态。
import { S2C } from '../../../shared/protocol.js';
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
 *   net?: { on: Function, sendResourceMessage: Function } | null,
 *   log?: { info?: Function, warn?: Function, error?: Function } | null,
 *   notify?: (text: string, kind?: string) => void,
 *   importModule?: (url: string) => Promise<any>,
 *   slotHost?: (slot: string) => any,
 *   createElement?: (tag: string) => any,
 *   env?: Record<string, boolean>,
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

  /** One named refusal: reported to the console and collected for the caller (a test, a diagnostic report). */
  function refuse(code, detail) {
    rejected.push({ code, detail });
    log?.error?.(`[mod-panels] ${code}: ${detail}`);
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
    const meFacade = Object.freeze({
      get playerId() { return readMe().playerId; },
      get name() { return readMe().name; },
      get room() { return readMe().room; },
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
    const factory = mod && typeof mod.mount === 'function' ? mod.mount
      : (mod && typeof mod.default === 'function' ? mod.default : null);
    if (!factory) {
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
