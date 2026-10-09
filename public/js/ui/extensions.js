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

/**
 * The four mount points — the closed enum of `shared/workshop.js CLIENT_PANEL_SLOTS`, kept here as its own table because
 * importing that module would pull the whole pack schema into the page. A test pins the two tables together, the same
 * way `test/kitImports.test.js` pins the import map to the whitelist.
 */
export const MOD_PANEL_SLOTS = Object.freeze(['root.overlays', 'root.guide', 'screen.game.aside', 'screen.result.footer']);

/** The URL prefix a panel module is served under: `shared/workshop.js WORKSHOP_PANEL_PREFIX` (pinned by a test). */
export const MOD_PANEL_PREFIX = '/workshop-panels/';

/** The browser capabilities a pack may require: `shared/workshop.js CLIENT_REQUIRES` (pinned by a test). */
export const MOD_PANEL_REQUIRES = Object.freeze(['serviceWorker', 'cacheStorage', 'webCrypto']);

/** The selector of a slot container: an existing one wins, otherwise the registry creates it (see `browserSlotHost`). */
export const slotSelector = (slot) => `[data-mod-slot="${slot}"]`;

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
 * }} deps
 * @returns {{ apply: (list: any) => { accepted: number },
 *   mounted: () => string[], refusals: () => Array<{ code: string, detail: string }>, dispose: () => void }}
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

  /** @type {Array<any>} */
  let panels = [];
  /** panel key -> { rec, host, unmount } while mounted (or being mounted). */
  const mounted = new Map();
  /** panel keys that were refused: never retried (their URL is content-addressed, so a retry cannot succeed). */
  const blocked = new Set();
  /** panel key -> its host element (created once, inside the slot container). */
  const hosts = new Map();
  /** @type {Array<{ code: string, detail: string }>} */
  const rejected = [];
  /** 注入过的样式表元素：`dispose` 要把它们一并撤掉 —— 注入过一次的东西必须能收回来。 */
  const styleEls = [];
  /** 主题变量被我们改之前的原值（空字符串 = 当时没有这个变量，撤销时 removeProperty）。 */
  const themePrevious = new Map();
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
    return {
      key, id, pack, slot: raw.slot, url,
      order: Number.isInteger(raw.order) ? raw.order : 0,
      gate: typeof raw.gate === 'string' && raw.gate ? raw.gate : null,
      requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
      styles,
    };
  }

  /** The frozen surface one panel module is called with (see the header: what is NOT here is the point). */
  function panelContext(rec, host) {
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
    const netFacade = Object.freeze({
      on: (type, fn) => (net && typeof net.on === 'function' ? net.on(type, fn) : () => {}),
      sendResourceMessage: (msg) => (net && typeof net.sendResourceMessage === 'function' ? net.sendResourceMessage(msg) : false),
    });
    return Object.freeze({
      id: rec.id, pack: rec.pack, slot: rec.slot, order: rec.order, gate: rec.gate,
      host, session, net: netFacade, log: scoped,
    });
  }

  /** The slot container exists (or is created) only when a panel really mounts: absent means "this shell has no such
   * mount point yet", and the next store change retries. */
  function ensureHost(rec) {
    const had = hosts.get(rec.key);
    if (had) return had;
    const container = slotHost(rec.slot);
    if (!container || typeof container.appendChild !== 'function') return null;
    const el = createElement('div');
    if (!el) return null;
    el.className = 'mod-panel';
    if (typeof el.setAttribute === 'function') el.setAttribute('data-mod-panel', rec.key);
    container.appendChild(el);
    hosts.set(rec.key, el);
    return el;
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

  async function mountOne(rec, host) {
    let mod;
    try {
      mod = await importModule(rec.url);
    } catch (err) {
      mounted.delete(rec.key);
      blocked.add(rec.key);
      refuse('CLIENT_PANEL_IMPORT_FAILED', `panel "${rec.key}" failed to import ${rec.url}: ${err && err.message ? err.message : String(err)}`);
      return true;
    }
    const factory = mod && typeof mod.mount === 'function' ? mod.mount
      : (mod && typeof mod.default === 'function' ? mod.default : null);
    if (!factory) {
      mounted.delete(rec.key);
      blocked.add(rec.key);
      refuse('CLIENT_PANEL_NO_MOUNT', `panel "${rec.key}" (${rec.url}) must export mount(ctx) (or default-export that function)`);
      return true;
    }
    let result;
    try {
      result = await factory(panelContext(rec, host));
    } catch (err) {
      mounted.delete(rec.key);
      blocked.add(rec.key);
      refuse('CLIENT_PANEL_MOUNT_FAILED', `panel "${rec.key}" threw while mounting: ${err && err.message ? err.message : String(err)}`);
      return true;
    }
    const entry = mounted.get(rec.key);
    if (entry) entry.unmount = result && typeof result.unmount === 'function' ? result.unmount : null;
    return true;
  }

  async function flush() {
    if (disposed) return;
    if (flushing) { dirty = true; return; }
    flushing = true;
    try {
      for (const rec of panels) {
        if (disposed) return;
        if (mounted.has(rec.key) || blocked.has(rec.key)) continue;
        const missing = capabilityIssues(rec.requires, env);
        if (missing.length) {
          blocked.add(rec.key);
          refuse('CLIENT_REQUIRES_UNSUPPORTED', `panel "${rec.key}" requires ${missing.join(', ')}, which this browser does not provide`);
          // 明示：浏览器不支持不是「装了但静默不工作」—— 玩家与作者都必须看到这句话（DESIGN §28.13）。
          notify(t('{0} 需要浏览器支持 {1}，当前浏览器不支持 —— 这个包的面板不会挂载', [rec.pack, missing.join(', ')]), 'error');
          continue;
        }
        if (rec.gate) {
          const gate = readGate(store.get(), rec.gate);
          if (!gate.ok) {
            blocked.add(rec.key);
            refuse('CLIENT_PANEL_GATE_UNKNOWN', `panel "${rec.key}" gates on ${JSON.stringify(rec.gate)}, which is not a path of the client store`);
            continue;
          }
          if (!gate.value) continue; // not yet: the next store change retries
        }
        // The slot container exists only once the app shell rendered it: absent means "not yet", not "failed", so
        // nothing is recorded and the next store change retries (no element is invented for a slot that is not there).
        const host = ensureHost(rec);
        if (!host) continue;
        if (!injectStyles(rec)) { blocked.add(rec.key); continue; }
        mounted.set(rec.key, { rec, host, unmount: null });
        await mountOne(rec, host);
      }
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
      for (const el of styleEls) {
        if (el && typeof el.remove === 'function') el.remove();
      }
      styleEls.length = 0;
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      subscribed = false;
    },
  };
}
