// public/js/ui/supportSync.js — 助战 selection state + server sync (the twin of ui/loadoutSync.js).
//
// `supportStore` holds the per-browser selection (`entries`, persisted through store.js savePref) and the picker screen
// state (open / origin / the catalog the server sent). `installSupportSync()` (called once by main.js) keeps the
// server's copy current: after every `welcome` (a new or resumed session — the server keeps the selection on the session
// and on the seat, so joining a room needs no resend) and after every edit (debounced), it sends `room.support {entries}`.
//
// TWO RULES DIFFER FROM THE LOADOUT, both from shared/support.js:
//
//   1. **The pool is the server's, so the client cannot send before it knows it.** `room.state.support` is what declares
//      the pool; until it has arrived the sync WAITS (state 'waiting') instead of sending a selection it cannot check.
//      (The loadout can sanitise against data/chess.json offline; support has no offline source of truth.)
//   2. **A refusal is never silently defaulted.** The loadout falls back to defaults when the server refuses; support
//      must not, because the fallback could be a DIFFERENT operator than the player chose — and the point of the pool is
//      that a disabled operator stays disabled. So a refusal is reported to the player and the local selection is kept
//      for the player to fix.
//
// `sync.state` ∈ 'idle' | 'waiting' | 'pending' | 'sending' | 'synced' | 'locked' | 'error' is mirrored into the store.

import { createStore, loadPref, savePref } from '../store.js';
import { SUPPORT_PREF, parseStored, toStored, readCatalog, sanitizeSupport } from './supportModel.js';
import { toast } from './toasts.js';

export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

function readStored() {
  try { return parseStored(loadPref(SUPPORT_PREF, null)); } catch { return []; }
}

/** Selection + picker state (separate from the app store: it must survive room / match resets). */
export const supportStore = createStore({
  entries: readStored(),
  open: false,
  from: null,        // 'lobby' | 'room' | 'briefing'
  catalog: null,     // the last catalog the server sent (null = never sent)
  sync: 'idle',
});

/** Replace the selection (persisted at once; the sync picks the change up). */
export function setSupportEntries(entries) {
  const next = Array.isArray(entries) ? [...entries] : [];
  try { savePref(SUPPORT_PREF, toStored(next)); } catch { /* private mode / no storage: the session still syncs */ }
  supportStore.set({ entries: next });
}

/** Clear the selection. */
export const clearSupport = () => setSupportEntries([]);

/** Open the 助战 picker. @param {'lobby'|'room'|'briefing'} from */
export function openSupport(from = 'lobby') {
  supportStore.set({ open: true, from });
}
export const closeSupport = () => supportStore.set({ open: false });

/**
 * Wire the sync once. Dependencies are injectable for tests.
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function },
 *   target?: ReturnType<typeof createStore>, notify?: (text: string) => void }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installSupportSync({ net, timers, target = supportStore, notify } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const tell = notify || ((text) => toast(text, 'warn'));
  let timer = null;
  let seq = 0;            // room.support requests sent (an older reply never overrides a newer one's state)
  let pendingJson = null; // JSON of the newest request still awaiting its reply
  let lastSent = null;    // JSON of the last selection the server accepted (on this session)
  let edited = false;     // an edit is waiting to be sent (a lock refusal is then worth telling the player)
  let disposed = false;

  const setState = (sync) => { if (target.get().sync !== sync) target.set({ sync }); };

  /** Apply a corrected selection to the INJECTED target (never to the module store, which a test does not use). */
  const apply = (entries) => {
    try { savePref(SUPPORT_PREF, toStored(entries)); } catch { /* no storage: the session still syncs */ }
    target.set({ entries: [...entries] });
  };

  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed) return;
    if (net.status !== 'online') { setState('idle'); return; }   // the next welcome resends
    const catalog = target.get().catalog;
    // Rule 1: without the server's pool there is nothing to check against, and sending an unchecked selection risks a
    // refusal of the WHOLE message. Wait for room.state instead of guessing.
    if (catalog == null) { setState('waiting'); return; }
    const { entries, dropped } = sanitizeSupport(catalog, target.get().entries);
    if (dropped.length) {
      // the pool shrank since this browser stored its selection: tell the player, do not shrink it silently
      tell(`助战卡池已变化，${dropped.length} 个已选干员不再可用`);
      apply(entries);
      return; // the setter reschedules
    }
    const json = JSON.stringify(entries);
    if (json === pendingJson) return;                               // the same content is already on its way
    if (json === lastSent && pendingJson == null) { edited = false; setState('synced'); return; }
    const my = ++seq;
    const wasEdit = edited;
    edited = false;
    pendingJson = json;
    setState('sending');
    try {
      await net.request('room.support', { entries });
      if (my !== seq) return;
      pendingJson = null;
      lastSent = json;
      setState('synced');
      if (wasEdit && !entries.length) tell('已取消全部助战');
    } catch (err) {
      if (my !== seq) return;
      pendingJson = null;
      const code = err && err.code;
      if (code === 'WRONG_PHASE' || code === 'ROOM_STARTED') {
        // the server stored it for the next match; the running one keeps the supports it granted
        lastSent = json;
        setState('locked');
        if (wasEdit) tell('本局的助战已锁定，修改将在下一局生效');
      } else if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') {
        edited = edited || wasEdit;
        schedule(RETRY_MS);
      } else if (code === 'BAD_TARGET' || code === 'BAD_MSG') {
        // Rule 2: report it and keep the local selection — never fall back to something the player did not choose
        console.warn('[support] room.support refused', code, err && err.detail);
        setState('error');
        tell('助战选择被服务器拒绝：' + ((err && err.detail) || code));
      } else {
        console.warn('[support] room.support refused', code, err && err.detail);
        setState('error');
      }
    }
  }

  const offWelcome = net.on('welcome', () => { lastSent = null; pendingJson = null; seq++; schedule(50); });
  const offStore = target.subscribe((s, prev) => {
    if (s.entries !== prev.entries) { edited = true; schedule(); }
    // closing the picker sends a pending edit at once: the player's next click must not overtake the debounced request
    if (prev.open && !s.open && timer != null) { T.clearTimeout(timer); timer = null; void flush(); }
  });
  const offRoom = net.on('room.state', (msg) => {
    if (!msg) return;
    const catalog = readCatalog(msg.support);
    if (catalog == null) return;                 // an older server, or a state frame without the catalog: keep what we have
    const prev = target.get();
    const patch = {};
    if (JSON.stringify(catalog) !== JSON.stringify(prev.catalog)) patch.catalog = catalog;
    // a match leaving INFO_CHECK locked the selection; a new match accepts it again
    if (!msg.inMatch && prev.sync === 'locked') { lastSent = null; patch.sync = 'pending'; }
    if (Object.keys(patch).length) target.set(patch);
    if (patch.catalog) {
      // a freshly arrived catalog may invalidate the stored selection: sanitise and resend (sanitizeSupport is applied
      // in flush as well; doing it here means the UI shows the drop immediately, before the request)
      const { entries, dropped } = sanitizeSupport(catalog, prev.entries);
      if (dropped.length) { tell(`助战卡池里没有 ${dropped.length} 个已选干员，已移除`); apply(entries); }
      else schedule(50);
    } else if (patch.sync === 'pending') {
      // the match that had locked the selection is over, but the catalog is the one we already had: nothing above
      // reschedules, so the held selection would never go out (caught by test/ui/support.test.js)
      schedule(50);
    }
  });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome(); offStore(); offRoom();
    },
  };
}
