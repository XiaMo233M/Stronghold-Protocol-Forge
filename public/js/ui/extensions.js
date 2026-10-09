// public/js/ui/extensions.js — the C-layer registration point (DESIGN §28.8, docs/WORKSHOP.md §1.9.3).
//
// A workshop pack's client interface is DECLARED, not patched in: `pack.json.client.panels[]` names a module inside the
// pack and one of four mount points. The server registers that module under `/workshop-panels/<pack>/<module>` (only
// registered URLs are servable) and sends the list in `welcome` (`modPanels`) — a frame the server already sends, so a
// server with no such pack produces **no new request, no new DOM and no new global** in the browser.
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
    return {
      key, id, pack, slot: raw.slot, url,
      order: Number.isInteger(raw.order) ? raw.order : 0,
      gate: typeof raw.gate === 'string' && raw.gate ? raw.gate : null,
      requires: Array.isArray(raw.requires) ? raw.requires.map(String) : [],
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
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      subscribed = false;
    },
  };
}
