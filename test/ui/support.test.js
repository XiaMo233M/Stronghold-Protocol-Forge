// test/ui/support.test.js — 助战 client logic (shared/support.js + ui/supportModel.js + ui/supportSync.js).
//
// The loadout has a twin of this file, and the DIFFERENCES are what this one exists to pin:
//   1. the pool is the SERVER's, so the sync never sends before `room.state.support` has arrived;
//   2. a refusal is NEVER silently defaulted (a fallback could be a different operator than the player chose, which is
//      exactly what "没有即禁用" forbids) — the player is told and their selection is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSupport } from '../../shared/support.js';
import {
  readCatalog, parseStored, toStored, tierOf, usedOf, tierUsage, sanitizeSupport, toggleSupport,
  checkSelection, usageLine, SUPPORT_PREF, SUPPORT_STORED_VERSION,
} from '../../public/js/ui/supportModel.js';
import { installSupportSync, SYNC_DEBOUNCE_MS, RETRY_MS } from '../../public/js/ui/supportSync.js';
import { createStore } from '../../public/js/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHESS = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
const getChess = (id) => (Object.hasOwn(CHESS, id) ? CHESS[id] : null);

/** Visible, non-golden base records of a tier — what the pool may legally list. */
const basesOf = (tier) => Object.values(CHESS)
  .filter((c) => c.tier === tier && !c.isGolden && c.visible !== false && !c.isHidden && !c.isDiy && (!c.baseId || c.baseId === c.chessId))
  .map((c) => c.chessId);
const T5 = basesOf(5);
const T6 = basesOf(6);
const [A5, B5, C5] = T5;
const [A6, B6] = T6;

const CAT = readCatalog({
  enabled: true, label: '助战', capacity: 3, slots: { 5: 2, 6: 1 },
  tiers: [{ tier: 5, slots: 2, ids: [A5, B5, C5] }, { tier: 6, slots: 1, ids: [A6, B6] }],
});

test('readCatalog: tolerant, and a junk/absent catalog is null (the sync must then wait, not guess)', () => {
  assert.equal(readCatalog(null), null);
  assert.equal(readCatalog('x'), null);
  // an EMPTY object is a catalog the server did send (support off), which is different from never having received one:
  // null means "wait", an empty catalog means "there is nothing to pick"
  const empty = readCatalog({});
  assert.equal(empty.enabled, false);
  assert.deepEqual(empty.tiers, []);
  const c = readCatalog({ enabled: false, tiers: [{ tier: 5, slots: 2, ids: [A5] }] });
  assert.equal(c.enabled, false, 'enabled:false stays disabled');
  assert.deepEqual(c.tiers.map((t) => t.tier), [5]);
  const junk = readCatalog({ enabled: true, tiers: [{ tier: 5, slots: 0, ids: [A5] }, { tier: 6, slots: 1, ids: [] }, { tier: 'x' }, null, { tier: 4, slots: 1, ids: [A5] }] });
  assert.deepEqual(junk.tiers.map((t) => t.tier), [4], 'a tier with no slots or no ids is dropped');
  assert.equal(junk.capacity, 1);
  assert.equal(readCatalog({ enabled: true, label: '' }).label, '助战');
  assert.equal(CAT.capacity, 3);
  assert.deepEqual(CAT.slots, { 5: 2, 6: 1 });
});

test('parseStored / toStored: tolerant of junk, an older bare array, duplicates and oversize', () => {
  assert.deepEqual(parseStored(null), []);
  assert.deepEqual(parseStored({ entries: [A5, A5, 'x'.repeat(999), 42, A6] }), [A5, A6], 'deduped, junk dropped');
  assert.deepEqual(parseStored([A5]), [A5], 'bare array (older build)');
  const many = Array.from({ length: 40 }, (_, i) => `chess_char_1_${i}_a`);
  assert.ok(parseStored({ entries: many }).length <= 16, 'capped at the wire limit');
  const e = [A5];
  assert.deepEqual(parseStored(JSON.parse(JSON.stringify(toStored(e)))), e);
  assert.equal(toStored(e).v, SUPPORT_STORED_VERSION);
});

test('tierOf / usedOf / tierUsage: per-tier accounting', () => {
  assert.equal(tierOf(CAT, A5), 5);
  assert.equal(tierOf(CAT, A6), 6);
  assert.equal(tierOf(CAT, 'chess_not_in_pool'), null);
  assert.equal(tierOf(null, A5), null);
  assert.equal(usedOf(CAT, [A5, B5, A6], 5), 2);
  assert.equal(usedOf(CAT, [A5], 9), 0);
  const u = tierUsage(CAT, [A5, B5]);
  assert.deepEqual(u.map((x) => [x.tier, x.used, x.slots, x.full]), [[5, 2, 2, true], [6, 0, 1, false]]);
  assert.deepEqual(tierUsage(null, [A5]), []);
  assert.equal(usageLine(CAT, [A5]), '5级 1/2 · 6级 0/1');
  assert.equal(usageLine(null, []), '本服务器未开启助战');
});

test('sanitizeSupport: drops what the pool no longer lists and trims over-quota tiers', () => {
  assert.deepEqual(sanitizeSupport(CAT, [A5, B5, A6]), { entries: [A5, B5, A6], dropped: [], reason: null });
  const gone = sanitizeSupport(CAT, [A5, 'chess_gone', A6]);
  assert.deepEqual(gone.entries, [A5, A6]);
  assert.deepEqual(gone.dropped, ['chess_gone']);
  assert.match(gone.reason, /pool changed/);
  // three tier-5 when only two slots exist: the earliest two are kept, deterministically
  const over = sanitizeSupport(CAT, [A5, B5, C5]);
  assert.deepEqual(over.entries, [A5, B5]);
  assert.deepEqual(over.dropped, [C5]);
  // a disabled server accepts nothing
  assert.deepEqual(sanitizeSupport(readCatalog({ enabled: false, tiers: [] }), [A5]), { entries: [], dropped: [A5], reason: 'support is off on this server' });
  // no catalog = no knowledge: the selection is passed through untouched (the sync waits instead)
  assert.deepEqual(sanitizeSupport(null, [A5]).entries, [A5]);
});

test('toggleSupport: adds, removes, refuses a full tier, and never adds an operator outside the pool', () => {
  assert.deepEqual(toggleSupport(CAT, [], A5).entries, [A5]);
  assert.deepEqual(toggleSupport(CAT, [A5], A5).entries, []);
  const full = toggleSupport(CAT, [A5, B5], C5);
  assert.equal(full.changed, false);
  assert.equal(full.full, true, 'the UI shows why the click did nothing');
  const outside = toggleSupport(CAT, [], 'chess_not_in_pool');
  assert.deepEqual(outside, { entries: [], changed: false, full: false }, 'an unlisted operator is DISABLED, not addable');
  const tier6Full = toggleSupport(CAT, [A6], B6);
  assert.equal(tier6Full.full, true);
});

test('checkSelection agrees with the server\'s own checkSupport (the picker cannot disagree with the match)', () => {
  const good = [A5, A6];
  const mine = checkSelection(CAT, good, getChess);
  const server = checkSupport(good, { enabled: true, slots: { 5: 2, 6: 1 }, pool: { 5: [A5, B5, C5], 6: [A6, B6] } }, getChess);
  assert.equal(mine.ok, true, JSON.stringify(mine));
  assert.equal(server.ok, true, JSON.stringify(server));
  // an id outside the pool: both refuse
  assert.equal(checkSelection(CAT, ['chess_nope'], getChess).error, 'BAD_TARGET');
  assert.equal(checkSupport(['chess_nope'], { enabled: true, slots: { 5: 2 }, pool: { 5: [A5] } }, getChess).error, 'BAD_TARGET');
  // beyond the slots: both refuse
  assert.equal(checkSelection(CAT, [A5, B5, C5], getChess).error, 'BAD_TARGET');
  assert.equal(checkSupport([A5, B5, C5], { enabled: true, slots: { 5: 2 }, pool: { 5: [A5, B5, C5] } }, getChess).error, 'BAD_TARGET');
  // no catalog yet: the client refuses to claim it is fine
  assert.equal(checkSelection(null, [], getChess).error, 'NO_CATALOG');
});

// ---- sync ---------------------------------------------------------------------------------------------------------------

function fakeNet() {
  const listeners = new Map();
  const net = {
    status: 'online',
    sent: [],
    replies: [],
    on(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); return () => listeners.get(t).delete(fn); },
    emit(t, msg) { for (const fn of listeners.get(t) || []) fn(msg); },
    request(t, fields) {
      net.sent.push({ t, ...fields });
      const r = net.replies.shift();
      if (!r) return Promise.resolve({ t: 'ok' });
      if (r.throw) return Promise.reject(r.throw);
      return r.error ? Promise.reject(Object.assign(new Error(r.error), { code: r.error, detail: r.detail })) : Promise.resolve({ t: 'ok' });
    },
  };
  return net;
}
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => q.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}
const CATALOG_FRAME = { enabled: true, label: '助战', capacity: 3, slots: { 5: 2, 6: 1 }, tiers: [{ tier: 5, slots: 2, ids: [A5, B5, C5] }, { tier: 6, slots: 1, ids: [A6, B6] }] };
const syncStore = (entries = []) => createStore({ entries, open: false, from: null, catalog: null, sync: 'idle' });

test('sync: waits for the server catalog, then sends; edits debounce; identical content is not resent', async () => {
  const net = fakeNet();
  const T = fakeTimers();
  const target = syncStore([A5, 'chess_gone']);
  const told = [];
  const s = installSupportSync({ net, timers: T, target, notify: (t) => told.push(t) });

  net.emit('welcome', {});
  await T.advance(100);
  assert.equal(net.sent.length, 0, 'nothing may be sent before the pool is known');
  assert.equal(target.get().sync, 'waiting');

  // room.state delivers the catalog: the stale id is dropped, and the corrected selection goes out
  net.emit('room.state', { support: CATALOG_FRAME, inMatch: false });
  await T.advance(SYNC_DEBOUNCE_MS + 20);
  assert.deepEqual(net.sent, [{ t: 'room.support', entries: [A5] }]);
  assert.deepEqual(target.get().entries, [A5], 'the invalid entry was removed, not the whole selection');
  assert.equal(target.get().sync, 'synced');
  assert.ok(told.some((t) => /卡池/.test(t)), told.join(' | '));

  target.set({ entries: [A5, A6] });
  target.set({ entries: [A6] });
  await T.advance(SYNC_DEBOUNCE_MS - 10);
  assert.equal(net.sent.length, 1, 'debounced');
  await T.advance(20);
  assert.equal(net.sent.length, 2);
  assert.deepEqual(net.sent[1].entries, [A6]);

  target.set({ entries: [A6, A5] });
  target.set({ entries: [A6] });   // back to the content already sent: the net result is a no-op
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(net.sent.length, 2, 'content identical to what the server already has is not resent');
  net.emit('welcome', {});
  await T.advance(100);
  assert.equal(net.sent.length, 3, 'a new or resumed session always gets it again');
  s.dispose();
});

test('sync: a refusal is REPORTED and the selection is kept — never silently defaulted', async () => {
  const net = fakeNet();
  const T = fakeTimers();
  const target = syncStore([A5]);
  const told = [];
  const s = installSupportSync({ net, timers: T, target, notify: (t) => told.push(t) });
  net.emit('room.state', { support: CATALOG_FRAME });
  await T.advance(100);
  assert.equal(target.get().sync, 'synced');

  net.replies.push({ error: 'BAD_TARGET', detail: 'support x is not in the server pool' });
  target.set({ entries: [A6] });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(target.get().sync, 'error');
  assert.deepEqual(target.get().entries, [A6], 'the player\'s choice is kept so they can fix it');
  assert.ok(told.some((t) => /拒绝/.test(t) && /not in the server pool/.test(t)), told.join(' | '));
  s.dispose();
});

test('sync: a locked match (WRONG_PHASE) is not an error; it resends when the room leaves the match; RATE retries', async () => {
  const net = fakeNet();
  const T = fakeTimers();
  const target = syncStore([A5]);
  const told = [];
  const s = installSupportSync({ net, timers: T, target, notify: (t) => told.push(t) });
  net.emit('room.state', { support: CATALOG_FRAME });
  await T.advance(100);
  net.replies.push({ error: 'WRONG_PHASE' });
  target.set({ entries: [A6] });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(target.get().sync, 'locked');
  assert.ok(told.some((t) => /锁定/.test(t)), told.join(' | '));

  net.emit('room.state', { support: CATALOG_FRAME, inMatch: false });
  await T.advance(SYNC_DEBOUNCE_MS + 20);
  assert.equal(target.get().sync, 'synced');
  assert.deepEqual(net.sent.at(-1).entries, [A6]);

  net.replies.push({ error: 'RATE' });
  target.set({ entries: [] });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(target.get().sync, 'pending', 'rate limited: retried later');
  await T.advance(RETRY_MS + 20);
  assert.deepEqual(net.sent.at(-1).entries, []);
  assert.equal(target.get().sync, 'synced');
  s.dispose();
});

test('sync: offline waits for the next welcome; a catalog that arrives late still triggers a send', async () => {
  const net = fakeNet();
  const T = fakeTimers();
  const target = syncStore([A5]);
  const s = installSupportSync({ net, timers: T, target, notify: () => {} });
  net.status = 'offline';
  net.emit('welcome', {});
  await T.advance(100);
  assert.equal(net.sent.length, 0);
  assert.equal(target.get().sync, 'idle');
  net.status = 'online';
  net.emit('welcome', {});
  await T.advance(100);
  assert.equal(net.sent.length, 0, 'still no pool');
  assert.equal(target.get().sync, 'waiting');
  net.emit('room.state', { support: CATALOG_FRAME });
  await T.advance(100);
  assert.deepEqual(net.sent, [{ t: 'room.support', entries: [A5] }]);
  s.dispose();
});

test('sync: closing the picker sends a pending edit at once', async () => {
  const net = fakeNet();
  const T = fakeTimers();
  const target = syncStore([]);
  const s = installSupportSync({ net, timers: T, target, notify: () => {} });
  net.emit('room.state', { support: CATALOG_FRAME });
  await T.advance(100);
  // the first flush always sends, even when empty: it CLEARS any selection a previous session left on this session token
  assert.deepEqual(net.sent, [{ t: 'room.support', entries: [] }]);
  target.set({ open: true });
  target.set({ entries: [A5] });
  target.set({ open: false });
  await T.advance(10);
  assert.deepEqual(net.sent.at(-1), { t: 'room.support', entries: [A5] }, 'the debounce was cut short by closing');
  s.dispose();
});

test('the pref key is the one the store persists under', () => {
  assert.equal(SUPPORT_PREF, 'support');
});
