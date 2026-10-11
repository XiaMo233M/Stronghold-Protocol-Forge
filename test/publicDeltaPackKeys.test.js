// test/publicDeltaPackKeys.test.js — the mod compatibility line of the `m.public` incremental frame (DESIGN §8.2.1):
// what a workshop pack's `publicView()` override (DESIGN §28.14 `matchClass`) may add, and how the engine degrades when
// the value it returns is not the JSON it needs.
//
// The three defects this suite pins down (each one had a minimal reproduction; the header of server/viewsDelta.js
// carries the rules, docs/design/network.md §8.2.1 carries them for a pack author):
//   1. a top-level key a pack added (`econ` / `revival`) was outside `SCALAR_KEYS`, so it went into NEITHER the patch
//      nor the baseline: a change to it alone produced no frame at all, and the client kept the value of its last full
//      frame (the HUD read reserve 0 while the server said 30) until the 32-frame keepalive.
//   2. the baseline could alias the pack's own objects — `publicBaseline` copied only the view's top level and the
//      players ARRAY, and the delta path stored the view's own rows in the next baseline — so a pack that cached its
//      row objects and rewrote a field of one left the baseline and the current view holding THE SAME object: every
//      comparison was `old[k] === cur[k]` and the whole row (engine fields included) left the diff forever.
//   3. a value JSON cannot carry (a cycle, a `BigInt`) made the differ throw inside `_maybeSendPublic`, and the frame was
//      swallowed: neither the delta nor the full frame went out, so that tick reached no client at all.
//
// Every test FAILS against the pre-fix code and PASSES after it (checked by mutation — the before/after log is in the
// change report). Nothing here relaxes an existing assertion; test/match/public-delta*.test.js and
// test/publicDeltaPacks.test.js are untouched.
//
// The real third-party pack used for the end-to-end block is mod-xie (促融共竞) — `econ` / `revival` on top, the row
// fields `pendingDeath` / `revivalReason` inside. It lives OUTSIDE the repository, so the suite says so and skips that
// block when it is not on this machine (every other block still runs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { FakeBattle } from './match/fakeBattle.js';
import { PHASE } from '../shared/constants.js';
import { applyPublic } from '../public/js/matchDelta.js';
import { publicDelta, publicBaseline, isEmptyDelta } from '../server/viewsDelta.js';

const STUB_LOG = { info() {}, debug() {}, warn() {}, error() {} };
const DATA = getData({ log: STUB_LOG });

/** The real pack's id and where its rewritten copy lives (outside the repository). */
const PACK_ID = 'mod-xie';
const PACK_ROOT = 'E:\\destop\\harness_1\\_up\\mod-rewrites\\促融共竞经济玩法\\mod-xie';
let pack = null;
let packWhy = '';
try {
  accessSync(path.join(PACK_ROOT, 'server', 'mod.mjs'));
  pack = await import(pathToFileURL(path.join(PACK_ROOT, 'server', 'mod.mjs')).href);
} catch (e) {
  packWhy = e && e.message ? e.message : String(e);
}
const packAvailable = !!(pack && typeof pack.registerServer === 'function');
if (!packAvailable) console.error(`[pack] real mod-xie not loadable from this checkout (${packWhy})`);
else console.error('[pack] real mod-xie loaded (econ/revival + pendingDeath/revivalReason)');
const withPack = (name, fn) => test(name, { skip: packAvailable ? false : `real mod-xie not on this machine (${packWhy})` }, fn);

/** `n` human seats then `bots` AI seats (the shape the match suites use). */
const seatsOf = (n, bots = 0) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true });
  for (let i = 0; i < bots; i++) out.push({ seat: out.length, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true });
  return out;
};

/**
 * A Match standing in for a pack's `matchClass` wrapper: it appends the same two top-level probe keys and the same two
 * row fields to `super.publicView()` (the switch is `this.__pk`, armed before `start()`).
 */
class PackProbeMatch extends Match {
  start() {
    if (this.__pk) { this.__pkRound = 1; this.__pkSpent = 0; }
    return super.start();
  }
  econPublicView() {
    return this.__pk ? { reserve: this.__pkRound * 2, transferLeft: Math.max(0, 8 - this.__pkSpent), projects: [], relief: null } : null;
  }
  publicView() {
    const view = super.publicView();
    if (!this.__pk || !view || typeof view !== 'object') return view;
    view.econ = this.econPublicView();
    view.revival = null;
    for (const row of view.players) {
      const ps = this.players.get(row.playerId);
      if (!ps) continue;
      row.pendingDeath = !!ps.pendingDeath;
      row.revivalReason = ps.revivalUnavailableReason || null;
    }
    return view;
  }
}

/** The real pack wrapped exactly as server/index.js does it (`registerServer({ matchClass })`). */
function realPackClass() {
  let cls = null;
  pack.registerServer({ matchClass: (fn) => { cls = fn(Match); } });
  assert.equal(typeof cls, 'function', 'the pack registered a matchClass wrapper');
  return cls;
}

/**
 * A real Match wearing a pack wrapper, wired like test/match/harness.js (markPublic / flush / capture). Each `m.public`
 * is also stored as `{ frame, view }`: the frame as it goes on the WIRE (a JSON copy — a pack that mutates a cached row
 * after the broadcast must not move what was sent) and the server's OWN view of that same instant (also a copy, and read
 * HERE: the real pack keeps its `econ` object and rewrites it in place, so a view read later is a later state).
 */
function makePackedMatch(o = {}) {
  const sched = new VirtualScheduler({ instantCombat: true });
  const h = { bc: [], frames: [], sentFrames: [], logs: { error: [] } };
  const Base = o.real ? realPackClass() : PackProbeMatch;
  class TestMatch extends Base {
    constructor(opts) { super(opts); this.__testView = () => this.publicView(); }
  }
  h.m = new TestMatch({
    roomCode: 'TEST', mode: 'coop', difficulty: 'NORMAL', seats: o.seats ?? seatsOf(3, 1), seed: o.seed ?? 11,
    data: DATA, scheduler: sched,
    log: { info() {}, debug() {}, warn() {}, error: (...a) => h.logs.error.push(a.map(String).join(' ')) },
    send: () => true,
    broadcast: (msg) => {
      h.bc.push(msg);
      if (msg.t !== 'm.public') return;
      let view;
      let wire;
      try { view = JSON.parse(JSON.stringify(h.m.__testView())); } catch { view = null; }
      try { wire = JSON.parse(JSON.stringify(msg)); } catch { wire = msg; }   // a cyclic payload is not serializable
      h.frames.push(wire);
      h.sentFrames.push({ frame: wire, view });
    },
    onEnd: () => {},
    BattleClass: FakeBattle,
    timerScale: 0.02,
    botRehearsal: 0,
    mods: { digest: 'a'.repeat(64), packs: [{ id: PACK_ID }] },
  });
  if (o.pk) h.m.__pk = true;      // armed BEFORE start(), the way a pack arms itself
  h.start = () => { h.m.start(); return h; };
  /** Advance the virtual clock past the ≤10/s throttle, then flush — one frame per call. */
  h.flushAll = () => { sched.advance(300); h.m.flush(true); };
  h.autoHumans = () => { for (const ps of h.m.players.values()) if (!ps.isBot) ps.autoplay = true; return h; };
  h.drive = (pred, maxSteps = 3e6) => {
    for (let i = 0; i < maxSteps; i++) {
      if (pred()) return true;
      if (h.m.ended) return !!pred();
      for (const ps of h.m.players.values()) {
        if (ps.isBot || ps.left) continue;
        if (h.m.phase === 'INFO_CHECK' && !ps.infoReady) h.m.handle(ps.playerId, { t: 'g.infoReady' });
        if (h.m.phase === 'BAND_DRAFT' && h.m.draftTurn() === ps.playerId) h.m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
        if (h.m.phase === 'PREP' && ps.alive && !ps.ready) {
          if (ps.personalChoice) h.m.handle(ps.playerId, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
          if (!ps.tempEmpty) ps.resolveTemp();
          h.m.handle(ps.playerId, { t: 'g.ready', ready: true });
        }
      }
      if (pred()) return true;
      if (!sched.runNext()) return !!pred();
    }
    return !!pred();
  };
  return h;
}

/** A row as the CLIENT holds it after a full frame: a null field leaves the row (matchDelta normalizeRow). */
const canonRow = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) if (v !== null) o[k] = v; return o; };

/** The same JSON VALUE with the key order ignored (a patch adds keys in wire order; a full frame in view order). */
const canonJson = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${v[k] === undefined ? 'null' : canonJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
};

/** Replay the recorded stream the way a browser does and judge it with the server's full view of the same moment. */
function replay(h) {
  let state = null;
  let deltas = 0;
  let fulls = 0;
  const mismatches = [];
  for (const [i, { frame, view }] of h.sentFrames.entries()) {
    const res = applyPublic(state, frame);
    assert.equal(res.ok, true, `every frame must be applicable: ${JSON.stringify(frame).slice(0, 200)}`);
    state = res.state;
    if (frame.delta === true) deltas++; else fulls++;
    if (!view) continue;
    // Both sides are read the way a client reads them: the top level without the wire marker, and `players` through the
    // same row normalization a full frame gets (`matchDelta normalizeRow`: a row `null` is "unset" on both paths).
    const want = {};
    for (const [k, v] of Object.entries(view)) if (k !== 't') want[k] = k === 'players' ? v.map(canonRow) : v;
    const got = { ...state, players: Array.isArray(state.players) ? state.players.map(canonRow) : state.players };
    const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((k) => {
      if (!(k in got) || !(k in want)) return true;
      return canonJson(got[k]) !== canonJson(want[k]);
    });
    if (keys.length) mismatches.push({ i, isDelta: frame.delta === true, keys, got: JSON.stringify(keys.map((k) => got[k])).slice(0, 160), want: JSON.stringify(keys.map((k) => want[k])).slice(0, 160) });
  }
  return { state, deltas, fulls, mismatches };
}

/** The client-side merge of one full view then one frame — the smallest end-to-end proof a value arrived. */
const clientAfter = (fullView, frame) => {
  const wire = { t: 'm.public', ...fullView };
  const first = applyPublic(null, JSON.parse(JSON.stringify(wire)));
  assert.equal(first.ok, true, `the full frame applies (${JSON.stringify(wire).slice(0, 160)})`);
  const second = applyPublic(first.state, JSON.parse(JSON.stringify(frame)));
  assert.equal(second.ok, true, `the frame applies (${JSON.stringify(frame).slice(0, 200)})`);
  return second.state;
};

/** True when no row of the room's baseline is an object the pack handed back. */
function baselineIsAliasFree(h, cache) {
  const rows = h.m._pubPrev && Array.isArray(h.m._pubPrev.players) ? h.m._pubPrev.players : [];
  for (const row of rows) {
    for (const c of cache.values()) {
      if (row === c) return false;
      for (const k of Object.keys(c)) if (c[k] && typeof c[k] === 'object' && row[k] === c[k]) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// A. the contract of a pack-added TOP-LEVEL key
// ---------------------------------------------------------------------------------------------------------------

describe('包加的顶层键（unknown key ⇒ 全量，已知后照常增量）', () => {
  test('A1 视图多出一个引擎白名单外的顶层键 ⇒ 差集拒绝（ok:false）而不是静默丢弃', () => {
    const v1 = { t: 'm.public', phase: 'PREP', players: [{ playerId: 'p_0', lp: 10 }] };
    const v2 = { ...v1, econ: { reserve: 5 } };
    const base = publicBaseline(v1);
    assert.equal(Object.hasOwn(base, 'econ'), false, 'the baseline has no such key');
    const d = publicDelta(base, v2);
    assert.equal(d.ok, false, 'THE FIX: a shape the baseline never saw is refused, never silently dropped');
    assert.match(d.why, /unknown top-level key "econ"/, `the reason names the key (${d.why})`);
    assert.equal(Object.hasOwn(d.frame, 'econ'), false, 'no half-patch is handed out (the caller sends the FULL frame)');
    // the engine's own per-frame keys are NOT unknown: they are on the explicit ignore list
    const s1 = { t: 'm.public', phase: 'PREP', serverNow: 1000, players: [] };
    const s2 = { t: 'm.public', phase: 'PREP', serverNow: 1016, players: [] };
    const ds = publicDelta(publicBaseline(s1), s2);
    assert.equal(ds.ok, true, 'serverNow is ignored, never an unknown key');
    assert.equal(isEmptyDelta(ds.frame), true, 'a clock-only change is still "nothing to send"');
    assert.equal(Object.hasOwn(publicBaseline(s1), 'serverNow'), false, 'and it is not in the baseline either');
  });

  test('A2 只改包键：修复前整帧不发（isEmptyDelta），修复后基线知道了它就照常增量', () => {
    const v1 = { t: 'm.public', phase: 'PREP', econ: { reserve: 0 }, players: [{ playerId: 'p_0', lp: 10 }] };
    const v2 = { t: 'm.public', phase: 'PREP', econ: { reserve: 5 }, players: [{ playerId: 'p_0', lp: 10 }] };
    const first = publicDelta(publicBaseline({ t: 'm.public', phase: 'PREP', players: [{ playerId: 'p_0', lp: 10 }] }), v1);
    assert.equal(first.ok, false, 'the key APPEARING is a full-frame reset point');
    const base = publicBaseline(v1);
    const d = publicDelta(base, v2);
    assert.equal(d.ok, true, 'THE FIX: once the baseline holds the key it diffs like any engine key');
    assert.deepEqual(d.frame.econ, { reserve: 5 }, 'the change to the pack key alone rides the patch');
    assert.equal(isEmptyDelta(d.frame), false, 'so the frame is NOT empty — a pack-only change really sends');
    const stripped = { ...base };
    delete stripped.econ;
    assert.equal(publicDelta(stripped, v2).ok, false, 'and a baseline without it can only be repaired by a full frame');
    const client = clientAfter(v1, d.frame);
    assert.deepEqual(client.econ, { reserve: 5 }, 'the client materializes the pack key’s new value');
    assert.equal(canonJson(d.next.econ), canonJson({ reserve: 5 }), 'and the next baseline carries it (no stale compare)');
  });

  test('A3 包键出现 / 消失 / 再次出现：gone 与重新下发', () => {
    const withKey = { t: 'm.public', phase: 'PREP', econ: { reserve: 3 }, players: [] };
    const without = { t: 'm.public', phase: 'PREP', players: [] };
    const gone = publicDelta(publicBaseline(withKey), without);
    assert.equal(gone.ok, true, 'a key the baseline holds may leave');
    assert.deepEqual(gone.frame.gone, ['econ'], 'it is spelled in gone, so the client deletes it');
    assert.equal(Object.hasOwn(gone.next, 'econ'), false, 'and the baseline forgets it');
    const back = publicDelta(publicBaseline(without), withKey);
    assert.equal(back.ok, false, 'the key coming back is a shape change again → full frame (never a stale client)');
    const client = clientAfter(withKey, gone.frame);
    assert.equal(Object.hasOwn(client, 'econ'), false, 'the client dropped it');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// B. the baseline must not alias the pack's objects
// ---------------------------------------------------------------------------------------------------------------

describe('基线不与包返回的对象混叠（原地改缓存行）', () => {
  test('B1 publicBaseline 深拷贝：原地改包缓存的行，物化后仍与全量等价', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 9, pk: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    // the pack caches the rows it returns and rewrites a field of one in place (its own field AND an engine field)
    const cache = new Map();
    const packView = () => {
      const view = h.m.publicView();
      view.players = view.players.map((row) => {
        let cached = cache.get(row.playerId);
        if (!cached) { cached = { ...row, packField: { level: 0 } }; cache.set(row.playerId, cached); }
        return cached;
      });
      return view;
    };
    const base = publicBaseline(packView());
    const row = cache.get('p_0');
    assert.notEqual(base.players[0], row, 'THE FIX: the baseline holds its own copy, never the pack’s row object');
    assert.notEqual(base.players[0].packField, row.packField, 'and its nested objects are copies too (a deep copy)');
    row.packField = { level: 7 };
    row.lp = row.lp - 3;
    const cur = packView();
    const d = publicDelta(base, cur);
    assert.equal(d.ok, true, 'the diff still works');
    const patch = (d.frame.players || []).find((p) => p.playerId === 'p_0');
    assert.ok(patch, 'the mutated row IS patched');
    assert.deepEqual(patch.packField, { level: 7 }, 'the pack’s own field is seen through the copy');
    assert.equal(patch.lp, row.lp, 'and so is the engine field changed in the same row');
    assert.equal(isEmptyDelta(d.frame), false, 'the frame is not empty');
    // the acceptance point: the client materializes exactly the pack's own full view (rows normalized) — read BEFORE
    // the pack writes again below, because a full frame IS a JSON snapshot of the view at its moment
    const want = cur.players.map(canonRow);
    const client = clientAfter(base, d.frame);
    assert.equal(canonJson(client.players.map(canonRow)), canonJson(want), 'materialized ≡ the full view, field for field');
    // THE NEXT BASELINE TOO (the delta path used to store the view's own row object)
    const nextRow = (d.next.players || []).find((p) => p.playerId === 'p_0');
    assert.notEqual(nextRow, row, 'and the baseline the DELTA produces is a copy of the row as well');
    assert.notEqual(nextRow.packField, row.packField, 'nested objects included');
    row.packField = { level: 99 };                       // the pack writes again, after the frame
    assert.equal(nextRow.packField.level, 7, 'a later in-place write cannot move the baseline (it is a snapshot)');
    // the contrast: an ALIASED baseline sees neither change — that is what "the whole row leaves the diff" meant
    const aliased = { ...base, players: [...cache.values()] };
    const same = publicDelta(aliased, cur);
    assert.equal(same.ok, true, 'an aliased baseline still "diffs"');
    assert.equal((same.frame.players || []).find((p) => p.playerId === 'p_0'), undefined, 'and reports no row change at all (the old defect)');
  });

  test('B2 真对局帧流：包原地改行 → 客户端最终仍与服务器的视图一致', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 5, pk: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    // The pack caches the row objects it returns, hands the same ones out every frame, and writes to them IN PLACE.
    // The write is driven by the test (never by a view call), so the scenario has no side effect the test cannot see.
    const cache = new Map();
    const realView = h.m.publicView.bind(h.m);
    h.m.publicView = () => {
      const view = realView();
      view.players = view.players.map((r) => {
        let c = cache.get(r.playerId);
        if (!c) { c = { ...r, packSeq: 0, packField: { level: 0 } }; cache.set(r.playerId, c); }
        else for (const k of Object.keys(r)) c[k] = r[k];      // the row stays the same object, its engine fields refresh
        return c;
      });
      return view;
    };
    const packWrite = () => { for (const c of cache.values()) { c.packSeq += 1; c.packField = { level: c.packField.level + 1 }; } };
    h.flushAll();                                   // the baseline now holds the pack's rows
    const levelAfterBaseline = cache.get('p_0').packField.level;
    assert.equal(baselineIsAliasFree(h, cache), true, 'the baseline row is not the pack’s cached row object');
    for (let i = 0; i < 3; i++) { packWrite(); h.m.markPublic(); h.flushAll(); }
    const r = replay(h);
    assert.ok(r.deltas > 0, `the stream used deltas (${r.deltas} delta / ${r.fulls} full)`);
    // THE INVARIANT THE DEFECT BROKE: with an aliased baseline the row stops being patched at all, so the client's copy
    // of the pack's own field freezes while the pack keeps moving it. At the end the two must be the same state — the
    // same acceptance point test/match/public-delta-match.test.js uses (the materialized state IS the server's view).
    const finalView = h.m.__testView();
    assert.equal(canonJson(r.state.players.map(canonRow)), canonJson(finalView.players.map(canonRow)), 'the client ends on the server’s own rows, field for field');
    const clientLevel = r.state.players.find((p) => p.playerId === 'p_0').packField.level;
    assert.equal(clientLevel, finalView.players.find((p) => p.playerId === 'p_0').packField.level, 'the pack’s own row field advanced to the server’s value');
    assert.ok(clientLevel > levelAfterBaseline, `and it really moved after the baseline (${levelAfterBaseline} → ${clientLevel})`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C. values JSON cannot carry: each one's behaviour after the fix
// ---------------------------------------------------------------------------------------------------------------

describe('怪值（循环引用 / BigInt / Map / Set / NaN）修复后的行为', () => {
  const cyc = () => { const o = {}; o.self = o; return o; };

  test('C1 循环引用：差集仍然抛（既有规则），改的是调用方（见 D3 的引擎行为）', () => {
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', draft: { a: 1 } }), { t: 'm.public', draft: cyc() }), /circular/i, 'a cycle under a whitelisted key still throws');
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', draft: [1] }), { t: 'm.public', draft: [cyc()] }), /circular/i, 'an array containing a cycle too');
    assert.throws(() => publicDelta(
      publicBaseline({ t: 'm.public', players: [{ playerId: 'p_0', packField: { a: 1 } }] }),
      { t: 'm.public', players: [{ playerId: 'p_0', packField: cyc() }] },
    ), /circular/i, 'and inside a pack row field');
    const shared = { t: 'm.public', extra: { k: 1 } };
    assert.equal(publicDelta(publicBaseline(shared), shared).ok, true, 'the SAME object on both sides is not a change');
  });

  test('C2 BigInt：同样抛（由调用方兜住 → 全量），不再吞掉该 tick 的状态', () => {
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', sp: { n: 1 } }), { t: 'm.public', sp: { n: 1n } }), /BigInt/i, 'a BigInt under a whitelisted key throws');
    assert.equal(JSON.stringify({ t: 'm.public', n: 1 }), '{"t":"m.public","n":1}', 'the full-frame fallback is plain JSON whenever the pack’s values are');
  });

  test('C3 Map / Set：顶层容器被拒绝（全量）；嵌在普通值里的仍是已知残留', () => {
    const topMap = publicDelta(publicBaseline({ t: 'm.public', teamLp: new Map([['a', 1]]) }), { t: 'm.public', teamLp: new Map([['b', 2]]) });
    assert.equal(topMap.ok, false, 'THE FIX: a top-level Map is refused, never patched as an object');
    assert.match(topMap.why, /not a JSON value \(Map\)/, `the reason names the container (${topMap.why})`);
    assert.equal(publicDelta(publicBaseline({ t: 'm.public', teamLp: { s: new Set([1]) } }), { t: 'm.public', teamLp: new Set([2]) }).ok, false, 'the same for a Set');
    const rowMap = publicDelta(
      publicBaseline({ t: 'm.public', players: [{ playerId: 'p_0', packField: new Map([['a', 1]]) }] }),
      { t: 'm.public', players: [{ playerId: 'p_0', packField: new Map([['b', 2]]) }] },
    );
    assert.equal(rowMap.ok, false, 'and inside a pack row field');
    // RESIDUE, said out loud: nested inside an otherwise plain value the two Maps still stringify to `{}`, so the pair
    // compares equal and the change does NOT ride the frame (the full-frame keepalive is what repairs it)
    const nested = publicDelta(
      publicBaseline({ t: 'm.public', teamLp: { m: new Map([['a', 1]]) } }),
      { t: 'm.public', teamLp: { m: new Map([['b', 2]]) } },
    );
    assert.equal(nested.ok, true, 'the nested case is still diffable (the container itself is a plain object)');
    assert.equal(isEmptyDelta(nested.frame), true, 'and it still reads as "nothing changed" — the documented residue, not a fix');
    const shared = { t: 'm.public', extra: { m: new Map([['a', 1]]) } };
    assert.equal(isEmptyDelta(publicDelta(publicBaseline(shared), shared).frame), true, 'the same Map object is not a change');
    assert.equal(publicDelta(publicBaseline({ t: 'm.public', teamLp: { o: 1 } }), { t: 'm.public', teamLp: { o: 2 } }).ok, true, 'plain objects stay exact');
  });

  test('C4 函数值：拒绝（不是 JSON 值）；纯 JSON 视图不受影响', () => {
    const d = publicDelta(publicBaseline({ t: 'm.public', round: 1, hook: () => 1 }), { t: 'm.public', round: 1, hook: () => 1 });
    assert.equal(d.ok, false, 'a function value is refused (it would vanish on the wire)');
    assert.match(d.why, /not a JSON value/, `the reason says why (${d.why})`);
    const plain = publicDelta(publicBaseline({ t: 'm.public', round: 1 }), { t: 'm.public', round: 2 });
    assert.equal(plain.ok, true, 'a plain view diffs normally');
    assert.equal(plain.frame.round, 2);
  });

  test('C5 NaN：不是可 diff 的 JSON 值 → 回落全量（旧行为＝线上 null ≠ 服务器 NaN，永远对不上）', () => {
    const nan = { t: 'm.public', round: NaN };
    const both = publicDelta(publicBaseline(nan), { ...nan });
    assert.equal(both.ok, false, 'THE FIX: NaN is refused at the door, so the caller sends the FULL frame');
    assert.match(both.why, /not a JSON value \(NaN or Infinity\)/, `the reason names it (${both.why})`);
    assert.equal(Object.hasOwn(both.frame, 'round'), false, 'and nothing half-built is handed out');
    assert.equal(JSON.stringify({ round: NaN }), '{"round":null}', 'JSON.stringify still turns NaN into null — the wire lie');
    assert.equal(publicDelta(publicBaseline({ t: 'm.public', round: 1 }), { t: 'm.public', round: NaN }).ok, false, 'a NaN appearing is refused the same way');
    assert.equal(publicDelta(publicBaseline({ t: 'm.public', round: 1 }), { t: 'm.public', round: Infinity }).ok, false, 'Infinity is refused as well');
  });

  test('C6 视图整体仍是 JSON 纯值：既有判据不变（对象重建不算变化、行字段照常增量）', () => {
    const base = { t: 'm.public', phase: 'PREP', factions: ['a'], players: [{ playerId: 'p_0', lp: 10, bonds: [] }] };
    const rebuilt = { t: 'm.public', phase: 'PREP', factions: ['a'], players: [{ playerId: 'p_0', lp: 10, bonds: [] }] };
    assert.equal(isEmptyDelta(publicDelta(publicBaseline(base), rebuilt).frame), true, 'a rebuilt-but-equal view sends nothing');
    const changed = { t: 'm.public', phase: 'PREP', factions: ['a'], players: [{ playerId: 'p_0', lp: 9, bonds: [] }] };
    const d = publicDelta(publicBaseline(base), changed);
    assert.equal(d.ok, true);
    assert.deepEqual(d.frame.players, [{ playerId: 'p_0', lp: 9 }], 'a row field still rides a field-level patch');
    assert.equal(clientAfter(base, d.frame).players[0].lp, 9, 'and the client materializes it');
    // an undefined-valued key is not a JSON value either: the baseline drops it, so the client's state is comparable
    const withUndef = { t: 'm.public', phase: 'PREP', goneKey: undefined, players: [] };
    assert.equal(Object.hasOwn(publicBaseline(withUndef), 'goneKey'), false, 'a key the wire never carried is not in the baseline');
    assert.equal(publicDelta(publicBaseline(withUndef), withUndef).ok, true, 'and the same view still diffs clean');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// D. the engine path: the FULL frame really goes out (no tick is ever swallowed)
// ---------------------------------------------------------------------------------------------------------------

describe('_maybeSendPublic 的安全退化（整帧不再被吞）', () => {
  test('D1 视图多出一个新顶层键 ⇒ 该 tick 发的是全量，随后只改包键走增量', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 11, pk: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    // one ordinary delta first, so the room is on the incremental path
    const before = h.frames.length;
    h.m.players.get('p_0').lp = h.m.players.get('p_0').lp - 1;
    h.m.markPublic();
    h.flushAll();
    const step = h.frames.slice(before);
    assert.ok(step.some((f) => f.delta === true), `a scalar change is a delta (${step.map((f) => f.delta ?? 'full').join(',')})`);
    // a NEW top-level key appears (the pack arms itself mid-match): the next frame must be FULL and carry it
    const n = h.frames.length;
    h.m.markPublicFull();
    h.m.markPublic();
    h.m.__pkRound = 3;
    h.m.__pk = true;
    h.flushAll();
    const intro = h.frames.slice(n).find((f) => Object.hasOwn(f, 'econ'));
    assert.ok(intro, 'THE FIX: a frame carrying the new key went out');
    assert.equal(intro.delta, undefined, 'and it is the FULL form (a shape the baseline never saw)');
    // from now on the key is part of the room's baseline: changing it ALONE is a delta
    const m = h.frames.length;
    h.m.__pkRound = 5;
    h.m.markPublic();
    h.flushAll();
    const after = h.frames.slice(m);
    assert.equal(after.length, 1, `exactly one frame went out (${after.map((f) => f.delta ?? 'full').join(',')})`);
    assert.equal(after[0].delta, true, 'and it is a DELTA');
    assert.deepEqual(after[0].econ, { reserve: 10, transferLeft: 8, projects: [], relief: null }, 'carrying the pack key alone');
    const r = replay(h);
    assert.deepEqual(r.mismatches, [], 'every frame matches the server’s own view, the pack key included');
    assert.equal(canonJson(r.state.econ), canonJson(h.m.__testView().econ), 'the materialized econ ≡ the server’s view');
  });

  test('D2 只改包键的 HUD：客户端下一步就拿到新值（不再冻结到下一次全量帧）', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 11, pk: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    const intro = h.frames.find((f) => Object.hasOwn(f, 'econ'));
    assert.ok(intro, 'a full frame introduced the pack key');
    assert.equal(intro.delta, undefined, 'the introducing frame is full');
    const stateOfFull = applyPublic(null, JSON.parse(JSON.stringify(intro))).state;
    assert.equal(stateOfFull.econ.reserve, 2, `the client starts on the pack’s first value (${JSON.stringify(stateOfFull.econ)})`);
    const n = h.frames.length;
    h.m.__pkRound = 15;                            // the pack’s own key changes, nothing else does
    h.m.markPublic();
    h.flushAll();
    const delta = h.frames.slice(n).find((f) => f.delta === true);
    assert.ok(delta, 'a pack-key-only change DOES send a delta (the old defect sent nothing at all)');
    assert.deepEqual(delta.econ, { reserve: 30, transferLeft: 8, projects: [], relief: null }, 'and it carries the pack key');
    const merged = applyPublic(stateOfFull, JSON.parse(JSON.stringify(delta))).state;
    assert.equal(merged.econ.reserve, h.m.publicView().econ.reserve, `the HUD reads the server’s own value (${merged.econ.reserve})`);
    assert.equal(merged.econ.reserve, 30, 'the real number a pack-only change carries');
  });

  test('D3 循环引用：差集抛 → try/catch 兜住 → 该 tick 仍然发全量（帧不被吞）', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 11, pk: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    const cyc = () => { const o = { n: 1 }; o.self = o; return o; };
    // the pack puts a cycle where the differ has to decide whether it changed: under a whitelisted scalar key
    const realView = PackProbeMatch.prototype.publicView;
    h.m.publicView = () => { const v = realView.call(h.m); v.sp = cyc(); return v; };
    const before = h.frames.length;
    h.m.markPublic();
    h.flushAll();
    assert.ok(h.frames.length > before, 'THE FIX: a frame went out for this tick (the old code dropped it whole)');
    const last = h.frames[h.frames.length - 1];
    assert.equal(last.delta, undefined, 'it is the FULL frame (the safe degradation)');
    assert.ok(h.logs.error.some((x) => /public/.test(x)), `the throw is still logged (${h.logs.error.join(' | ')})`);
    // the tick after the cycle is gone: a normal delta again, no leftover state
    h.m.publicView = realView.bind(h.m);
    h.m.players.get('p_0').lp = h.m.players.get('p_0').lp - 1;
    const n = h.frames.length;
    h.m.markPublic();
    h.flushAll();
    const next = h.frames.slice(n);
    assert.ok(next.length >= 1, 'the next tick publishes again');
    assert.equal(next[next.length - 1].delta, true, 'and it is a delta (the stream recovered)');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// E. the real third-party pack, end to end
// ---------------------------------------------------------------------------------------------------------------

describe('真包 mod-xie 端到端：econ / revival 实时', () => {
  withPack('E1 真包帧流：包键逐帧与服务器视图一致，HUD 不再冻结', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 5, real: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    assert.equal(pack.isXieRoom(h.m.mods), true, 'the room names the pack');
    const intro = h.frames[0];
    assert.equal(intro.delta, undefined, 'the first frame is full');
    assert.ok(Object.hasOwn(intro, 'econ') && Object.hasOwn(intro, 'revival'), 'and carries the pack’s two probe keys');
    h.drive(() => h.m.round >= 2, 3e6);
    h.m.markPublic();
    h.flushAll();
    const r = replay(h);
    assert.ok(r.fulls + r.deltas > 1, `frames were published (${r.fulls} full / ${r.deltas} delta)`);
    console.error(`[mod-xie] ${r.fulls} full / ${r.deltas} delta · econ on ${h.frames.filter((f) => Object.hasOwn(f, 'econ')).length} frames`);
    assert.deepEqual(r.mismatches, [], 'every frame matches the server’s own view, pack keys included');
    assert.ok(Object.hasOwn(r.state, 'econ'), 'the client holds the pack key at the end of the stream');
    assert.equal(h.logs.error.length, 0, `no engine errors (${h.logs.error.join(' | ')})`);
  });

  withPack('E2 真包：改包键后的下一帧就送达（不再等 32 帧）', () => {
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 5, real: true });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    // the pack's own state moves (its own econ bookkeeping), and nothing else is touched
    h.m.econRound.spent = (h.m.econRound.spent || 0) + 3;
    const want = h.m.publicView().econ;
    const n = h.frames.length;
    h.m.markPublic();
    h.flushAll();
    const sent = h.frames.slice(n);
    assert.ok(sent.length >= 1, 'THE FIX: the frame went out (the old code sent nothing)');
    const frame = sent.find((f) => Object.hasOwn(f, 'econ')) || sent[sent.length - 1];
    assert.ok(Object.hasOwn(frame, 'econ'), 'and it names the pack key');
    // the state the browser holds before that frame: the WHOLE stream replayed through the production merge
    let state = null;
    for (let i = 0; i < n; i++) {
      const res = applyPublic(state, h.frames[i]);
      assert.equal(res.ok, true, `frame ${i} applies`);
      state = res.state;
    }
    const merged = applyPublic(state, JSON.parse(JSON.stringify(frame)));
    assert.equal(merged.ok, true, 'the frame merges into the client’s state');
    assert.equal(canonJson(merged.state.econ), canonJson(want), 'the client holds the pack’s new value right away');
  });
});
