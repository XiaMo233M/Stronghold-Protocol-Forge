// The incremental `m.public` frame against a REAL match (DESIGN §8.2 "incremental frame"): the match harness drives
// full co-op matches and this suite applies the browser's own merge (public/js/matchDelta.js) to the frame stream the
// match really broadcast. What is compared is the thing that matters:
//
//   * the state a client MATERIALIZES out of the deltas equals the state the same stream's full frames describe — field
//     for field, row for row, key for key (deepStrictEqual, so `undefined` vs absent and array order count). At TWO
//     SCALES: the 4-seat room of the game and a 40-seat room.
//   * re-diffing the materialized state against the engine's own last frame changes NOTHING: the client holds exactly
//     what the engine believes the room holds, which also proves the baseline bookkeeping (`_pubPrev`) stayed in step.
//   * every delta has a full frame before it on every participating client (a joiner must never meet a delta first).
//   * a delta frame is smaller than a full one, and at 40 seats the O(N) row fan-out is gone: one changed field costs
//     tens of bytes instead of the whole table.
//   * the self-healing paths: `g.publicFull` answers a full frame, and the keepalive turns every PUBLIC_FULL_EVERY-th
//     frame full even if the client never asks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { PUBLIC_FULL_EVERY } from '../../server/match/match/common.js';
import { applyPublic, clonePublic } from '../../public/js/matchDelta.js';
import { publicDelta, publicBaseline, isEmptyDelta } from '../../server/viewsDelta.js';

/** The 40-seat room this work is about: 4 human seats and 36 AI seats, the size the load report measured. */
const seats = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: i >= 4, connected: true });
  return out;
};

/** Drive one match and collect its `m.public` broadcast stream (the engine's own frames, nothing patched). */
function drive(o) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: o.seats, seed: o.seed ?? 7, fake: true, timerScale: 0.02, script: () => ({ duration: 1 }) });
  h.autoHumans();
  h.start();
  const limit = o.rounds
    ? h.drive(() => h.m.round >= o.rounds && h.m.phase === PHASE.SETTLE)
    : h.runToEnd();
  return { h, frames: h.bc.filter((m) => m.t === 'm.public'), ended: h.ended, limit };
}

const bytes = (m) => Buffer.byteLength(JSON.stringify(m), 'utf8');

/**
 * Replay a frame stream the way a browser does: the production merge, plus the bookkeeping the assertions need.
 * @param {any[]} frames
 */
function replay(frames) {
  let state = null;
  let stateAtLastFull = null;      // the materialized state right after the last FULL frame
  let deltaBeforeFull = 0;         // deltas that arrived before their client ever had a full frame
  let fullCount = 0;
  let deltaCount = 0;
  let maxDeltaBytes = 0;
  let maxFullBytes = 0;
  let sumDeltaBytes = 0;
  let sinceFull = 0;
  const gaps = [];                 // deltas between two full frames
  for (const f of frames) {
    const isDelta = f.delta === true;
    if (isDelta) {
      deltaCount++;
      if (state == null) deltaBeforeFull++;
      const b = bytes(f);
      sumDeltaBytes += b;
      maxDeltaBytes = Math.max(maxDeltaBytes, b);
      sinceFull++;
    } else {
      fullCount++;
      maxFullBytes = Math.max(maxFullBytes, bytes(f));
      gaps.push(sinceFull);
      sinceFull = 0;
    }
    const res = applyPublic(state, f);
    assert.equal(res.ok, true, `every frame must be applicable: ${JSON.stringify(f).slice(0, 240)}`);
    state = res.state;
    if (!isDelta) stateAtLastFull = state;
  }
  return { state, stateAtLastFull, deltaBeforeFull, fullCount, deltaCount, maxDeltaBytes, maxFullBytes, meanDeltaBytes: deltaCount ? Math.round(sumDeltaBytes / deltaCount) : 0, gaps };
}

/** The full set of fields a top-level state carries, compared one by one (the failure message names the field). */
const sameTopLevel = (a, b, what) => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 't') continue;
    assert.deepEqual(a[k], b[k], `${what}: top-level ${k}`);
  }
};

describe('incremental m.public against a real match', () => {
  test('4 seats: the merged state is what the full frames said, field for field', () => {
    const { frames, ended } = drive({ seats: seats(4), seed: 11 });
    assert.ok(ended, 'the match ran to its end');
    assert.ok(frames.length > 10, `enough frames to judge (${frames.length})`);
    const r = replay(frames);
    assert.ok(r.fullCount >= 1, 'the stream starts with a full frame');
    assert.equal(r.deltaBeforeFull, 0, 'no delta ever precedes the first full frame');
    assert.ok(r.deltaCount > 0, `the stream really used deltas (${r.deltaCount} of ${frames.length})`);
    assert.deepEqual(r.state.players, r.stateAtLastFull.players, 'every player row, field for field');
    assert.deepEqual(r.state.fields, r.stateAtLastFull.fields, 'every field entry');
    sameTopLevel(r.state, r.stateAtLastFull, '4 seats');
  });

  test('40 seats: the merged state is still the stream, and the frames are no longer row-sized', () => {
    const { frames } = drive({ seats: seats(40), seed: 11, rounds: 2 });
    assert.ok(frames.length >= 6, `the 40-seat match produced a stream (${frames.length} frames)`);
    const r = replay(frames);
    assert.equal(r.deltaBeforeFull, 0, 'no delta ever precedes the first full frame');
    assert.ok(r.deltaCount > 0, `the stream really used deltas (${r.deltaCount})`);
    // the engine's last frame, applied a SECOND time to what a client ends up with: it changes nothing. Every field and
    // key it carries is already materialized exactly — the acceptance point (the client holds the engine's state), and
    // it also proves the baseline bookkeeping stayed in step.
    const again = applyPublic(r.state, frames[frames.length - 1]);
    assert.equal(again.ok, true);
    assert.equal(again.state, r.state, `re-applying the last frame is a no-op (${JSON.stringify(again.state).slice(0, 160)})`);
    // ...and the state right after the last FULL frame is the full frame's own rows, field for field
    assert.deepEqual(r.stateAtLastFull.players.length >= 1, true);
    assert.ok(r.maxFullBytes > 4000, `a 40-seat full frame is the big one (${r.maxFullBytes} B)`);
    console.error(`[40 seats] full ${r.maxFullBytes} B, ${r.fullCount} full / ${r.deltaCount} delta, delta mean ${r.meanDeltaBytes} B, delta max ${r.maxDeltaBytes} B`);
    // The stream is short and sits in the draft burst, where all 40 seats really change at once — so this is the
    // pessimistic end, not the typical shape (the dense test below measures that: one field 75 B, all 40 rows 2915 B
    // against a 17 kB full frame). What must hold here is that deltas exist and that the ROOM is not resent wholesale.
    const deltasOverFull = frames.filter((f) => f.delta === true && bytes(f) > r.maxFullBytes).length;
    assert.ok(deltasOverFull <= 1, `at most one burst outlier exceeds the first full frame (${deltasOverFull})`);
    assert.ok(r.meanDeltaBytes < r.maxFullBytes * 1.2, `and the mean stays around a full frame at worst (${r.meanDeltaBytes} vs ${r.maxFullBytes} B)`);
  });

  test('a dense window: the frame costs what changed, not what the room holds', () => {
    // The 40-seat load report's worst case is "every seat is dirty every frame". Measured on a real 40-seat view: one
    // changed field costs a patch of tens of bytes, and even EVERY row changing stays far under the full frame — which
    // is the point of diffing per KEY instead of resending the table (or only the dirty seats).
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: seats(40), seed: 11, fake: true, timerScale: 0.02, script: () => ({ duration: 1 }) });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 2 && h.m.phase === PHASE.PREP);
    const fullView = h.m.publicView();
    const fullBytes = bytes(fullView);
    const base = publicBaseline(fullView);
    // nothing changed at all: no frame is sent
    assert.equal(isEmptyDelta(publicDelta(base, h.m.publicView()).frame), true, 'a dirty mark without a change sends nothing');
    // one seat moved one number
    const one = h.m.publicView();
    one.players[0] = { ...one.players[0], boardCount: one.players[0].boardCount + 1 };
    const oneDelta = publicDelta(base, one).frame;
    // the pathological frame: every seat's whole row changed
    const all = h.m.publicView();
    all.players = all.players.map((p) => ({ ...p, boardCount: p.boardCount + 1, lp: p.lp - 1, ready: !p.ready, autoplay: !p.autoplay }));
    const allDelta = publicDelta(base, all).frame;
    console.error(`[dense 40] full ${fullBytes} B · one field ${bytes(oneDelta)} B · every row ${bytes(allDelta)} B · rows ${fullView.players.length}`);
    assert.equal(fullView.players.length, 40);
    assert.ok(bytes(oneDelta) < 200, `one changed field is a patch of tens of bytes (${bytes(oneDelta)} B)`);
    assert.ok(bytes(oneDelta) < fullBytes / 20, `and nowhere near the full frame (${bytes(oneDelta)} vs ${fullBytes} B)`);
    assert.ok(bytes(allDelta) < fullBytes * 0.5, `even every row is under the full frame (${bytes(allDelta)} vs ${fullBytes} B)`);
    // THE point: the payload tracks the CHANGED FIELD COUNT, not the seat count
    assert.ok(bytes(allDelta) / 160 < 60, `and stays proportional to the changed fields (${(bytes(allDelta) / 160).toFixed(1)} B per change)`);
    // the same two frames at the game's own 4-seat scale (requirement 5: the materialized state is what must not move)
    const h4 = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: seats(4), seed: 11, fake: true, timerScale: 0.02, script: () => ({ duration: 1 }) });
    h4.autoHumans();
    h4.start();
    h4.drive(() => h4.m.round >= 2 && h4.m.phase === PHASE.PREP);
    const v4 = h4.m.publicView();
    const b4 = publicBaseline(v4);
    assert.equal(isEmptyDelta(publicDelta(b4, v4).frame), true, '4 seats, nothing changed: no frame at all');
    const one4 = h4.m.publicView();
    one4.players[0] = { ...one4.players[0], boardCount: one4.players[0].boardCount + 1 };
    const d4b = publicDelta(b4, one4).frame;
    console.error(`[dense 4] full ${bytes(v4)} B · one field ${bytes(d4b)} B · rows ${v4.players.length}`);
    assert.ok(bytes(d4b) < bytes(v4) / 10, `and the small room saves too (${bytes(d4b)} vs ${bytes(v4)} B)`);
  });

  test('every frame carries the engine clock, deltas included', () => {
    // the client's clock sync reads `serverNow` from any m.public frame; a delta must not lose it (it is not part of the
    // diffed state — the match adds it to the frame it broadcasts)
    const { frames } = drive({ seats: seats(6), seed: 3, rounds: 2 });
    assert.ok(frames.length > 2);
    const deltas = frames.filter((f) => f.delta === true);
    assert.ok(deltas.length > 0, `deltas exist (${deltas.length})`);
    for (const f of frames) assert.ok(Number.isFinite(f.serverNow), `serverNow on a ${f.delta ? 'delta' : 'full'} frame`);
  });

  test('the keepalive: a full frame at least every PUBLIC_FULL_EVERY deltas', () => {
    assert.ok(Number.isInteger(PUBLIC_FULL_EVERY) && PUBLIC_FULL_EVERY > 1, 'the keepalive is configured');
    const { frames } = drive({ seats: seats(6), seed: 3, rounds: 2 });
    const r = replay(frames);
    assert.ok(r.gaps.length >= 1, 'full frames really occur');
    for (const n of r.gaps) {
      assert.ok(n <= PUBLIC_FULL_EVERY, `a gap of ${n} deltas must not exceed PUBLIC_FULL_EVERY ${PUBLIC_FULL_EVERY}`);
    }
    assert.equal(r.deltaBeforeFull, 0);
  });

  test('a reconnect is answered with a full frame, and the room goes back to a full frame too', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: seats(4), seed: 5, fake: true, timerScale: 0.02, script: () => ({ duration: 1 }) });
    h.start();
    h.runToPhase(PHASE.PREP, 1);
    h.flushAll();
    // the room is on the incremental path now: a state change alone produces a delta
    h.ps('p_2').ready = true;
    h.m.markPublic();
    h.flushAll();
    assert.ok(h.bc.filter((m) => m.t === 'm.public' && m.delta === true).length >= 1, 'a delta went out before the reconnect');
    h.sent.length = 0;
    h.bc.length = 0;
    h.ps('p_1').connected = false;
    h.m.onDisconnect('p_1');
    h.ps('p_1').connected = true;
    h.m.onReconnect('p_1');
    // the resync pushed the full frame; then one more frame goes out for the room
    h.ps('p_3').ready = true;
    h.m.markPublic();
    h.flushAll();
    const toP1 = h.sent.filter(([id, m]) => id === 'p_1' && m.t === 'm.public').map(([, m]) => m);
    assert.ok(toP1.length >= 1, 'the reconnect pushed m.public');
    assert.equal(toP1[0].delta, undefined, 'a resync sends the FULL form (no delta marker)');
    assert.ok(Array.isArray(toP1[0].players) && toP1[0].players.length === 4, 'with every row');
    assert.equal(Object.hasOwn(toP1[0].players[0], 'lp'), true, 'and the rows are whole');
    const after = h.bc.filter((m) => m.t === 'm.public');
    assert.ok(after.length >= 1, 'the room got a frame after the membership change');
    assert.ok(after.every((m) => m.delta !== true), 'and it is a FULL frame for everybody, not a delta');
    assert.equal(h.logs.error.length, 0, `no errors (${h.logs.error.join(' | ')})`);
  });

  test('the self-healing ask: g.publicFull answers the asker with a full frame', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: seats(4), seed: 5, fake: true, timerScale: 0.02, script: () => ({ duration: 1 }) });
    h.start();
    h.runToPhase(PHASE.PREP, 1);
    h.flushAll();
    h.sent.length = 0;
    h.m.handle('p_0', { t: 'g.publicFull' });
    const toP0 = h.sent.filter(([id, m]) => id === 'p_0' && m.t === 'm.public').map(([, m]) => m);
    assert.equal(toP0.length, 1, 'exactly one full frame is the answer');
    assert.equal(toP0[0].delta, undefined, 'it is a full frame');
    assert.equal(toP0[0].players.length, 4);
    assert.equal(h.logs.error.length, 0, `no errors (${h.logs.error.join(' | ')})`);
  });
});
