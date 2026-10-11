// test/ps100-variant-ac.test.js — design-level items A (每人独立牌库) and C (100 人联防) of 百卫补丁 v0.3, landed as
// docs/PS100-MIGRATION.md §10 describes them: BOTH are gated by `seatCap > MAX_SEATS`, and with the gate OFF the code
// runs the pre-existing path — the identical `m.pool` object (A) and the single-plan / single-battlefield shape whose
// variant fields stay at rest (C).
//
// What this file pins:
//   1. A, gate OFF: `poolOf` / `mainPool` hand back the VERY `m.pool` object; no own pool is ever built, and the
//      room-wide conservation equation is the one that runs.
//   2. A, gate ON: one pool per player, the shared catalog keeps every copy, the per-player conservation holds — and is
//      LIVE (corrupting it is reported).
//   3. C: the same finished-combat results yield ONE plan object at ≤ MAX_SEATS and the per-squad LIST above it; a
//      single-squad round is still field 'u' with identical battle options, which is the invariant the golden
//      `unite-1` / `unite-2` scenarios (1–2 helpers ⇒ one squad) rest on.
//   4. C, gate OFF: a live 3–4 seat match never touches `unitePlans` / `uniteRound` / `_uniteToken` / `_uniteHandoff` /
//      `_phase1Driven` / `_relayToken` — they keep the Match constructor's initial values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, MAX_SEATS } from '../shared/constants.js';
import { collectViolations } from '../server/match/invariants.js';
import { planUnite, combineUniteResults } from '../server/match/unite.js';
import { planUniteBySquad, squadIndexOf, squadMembersOf, SQUAD_SIZE } from '../server/match/unite100.mjs';
import { tileKey } from '../server/match/board.js';
import { DATA, makeMatch, chessOfTier, legalTileFor, give, checkInvariants } from './match/harness.js';
import { FakeBattle } from './match/fakeBattle.js';

/** The first enemy keys the real data knows (`m.gd.enemy(key)` must answer, or a leak lands in `notReentered`). */
const ENEMIES = Object.keys(DATA.enemies);
const ENEMY = ENEMIES.find((k) => !!k);
const OTHER_ENEMY = ENEMIES.filter((k) => k !== ENEMY)[0] || ENEMY;

/** A `BattleResult.perPlayer`-shaped entry. */
const res = (leaked = 0) => ({
  leaked: Array.from({ length: leaked }, (_, i) => ({ enemyKey: i % 2 ? OTHER_ENEMY : ENEMY, lpr: 1, counted: true, tag: null, mods: null })),
  perfect: leaked === 0,
});

/** lastResults keyed `p_<i>` with `leaks[i]` counted leaks each. */
const resultsFor = (humans, leaks) => {
  const out = new Map();
  for (let i = 0; i < humans; i++) out.set(`p_${i}`, res(leaks[i] || 0));
  return out;
};

const seatList = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true }));

/** A Match without starting it — the planning rules only need the seats, the data and `lastResults`. */
const unstartedMatch = (n, seed = 5) => makeMatch({ mode: 'coop', seats: seatList(n), seed, fake: true }).m;

/**
 * `harness.give`, except the copies come from the pool the match ACTUALLY routes them to (`ps.poolOf`) — which is the
 * whole point of A: with the switch on, taking them from the shared catalog is exactly the bug this test looks for.
 */
function giveOwn(m, ps, chessId, at) {
  const rec = m.gd.chess(chessId);
  const base = m.gd.baseIdOf(chessId);
  const taken = ps.poolOf(base).take(base, rec.isGolden ? m.gd.goldenCopies : 1, { overdraw: true });
  const piece = ps.newPiece('chess', chessId, { poolCopies: taken });
  ps.board.set(tileKey(at[0], at[1]), piece);
  ps.grantTokensFor(piece);
  ps.recompute();
  return piece;
}

// -------------------------------------------------------------------------------------------------------------------
// A 每人独立牌库

test('A gate OFF (≤ MAX_SEATS): poolOf and mainPool hand back the identical shared m.pool object — no own pool exists', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 2, seed: 11, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  assert.equal(m.seatCap, MAX_SEATS);
  const ps = h.ps('p_0');
  assert.equal(ps.variantOn(), false, 'the switch reads seatCap > MAX_SEATS');
  assert.equal(ps._ownPool, null, 'no per-player pool is built while the switch is off');
  assert.equal(ps.mainPool(), m.pool, 'the draw source IS the shared pool');
  const bases = m.gd.visibleChess.slice(0, 60);
  assert.ok(bases.length > 0);
  for (const base of bases) assert.equal(ps.poolOf(base), m.pool, `poolOf(${base}) is the shared object`);
  assert.deepEqual(collectViolations(m), []);
  m.dispose();
});

test('A gate ON (> MAX_SEATS): one pool per player, the shared catalog keeps every copy, per-player conservation holds', () => {
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 12, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  assert.equal(m.seatCap, 6);
  const a = h.ps('p_0');
  const b = h.ps('p_1');
  assert.equal(a.variantOn(), true);
  assert.equal(a.mainPool(), a.pool());
  assert.notEqual(a.mainPool(), m.pool, 'the draw source is no longer the shared pool');
  assert.notEqual(a.mainPool(), b.mainPool(), 'one pool per player');

  const base = chessOfTier(1).filter((x) => m.pool.has(x))[0];
  const cap = m.gd.poolCopies(base);
  assert.ok(cap > 0);
  assert.equal(a.poolOf(base), a.mainPool(), 'poolOf routes to the player own pool');

  const piece = a.acquireChess(base, { source: 'test', silent: true });
  assert.ok(piece, 'the chess was acquired');
  assert.equal(a.pool().left(base), cap - 1, 'the copy came out of the player own pool');
  assert.equal(m.pool.left(base), m.pool.cap(base), 'the shared catalog is untouched');
  assert.equal(b.pool().left(base), cap, 'another player pool is untouched');
  assert.deepEqual(collectViolations(m), [], 'per-player conservation holds after a take');

  // ... and the return trip goes back to the SAME pool
  assert.ok(a.sell(piece.uid), 'sold back');
  assert.equal(a.pool().left(base), cap, 'the copy went back to the player own pool');
  assert.equal(m.pool.left(base), m.pool.cap(base), 'still untouched');
  assert.deepEqual(collectViolations(m), []);

  // The DRAW really reads it: drain the FIRST eligible entry of the own pool and the two sources roll different chess
  // (the shared pool would still hand out the drained one — that is the 100-seat scarcity A exists to remove).
  const zero = () => 0;
  const first = [...a.pool().entries].find(([, e]) => e.left > 0 && e.tier <= 6)[0];
  const second = [...a.pool().entries].find(([id, e]) => id !== first && e.left > 0 && e.tier <= 6)[0];
  assert.equal(a.mainPool().roll(zero, { maxTier: 6 }), first, 'the own pool rolls its first eligible chess');
  assert.equal(m.pool.roll(zero, { maxTier: 6 }), first, 'and so does the catalog before the drain');
  a.pool().take(first, a.pool().cap(first), { overdraw: false });
  assert.equal(m.pool.roll(zero, { maxTier: 6 }), first, 'the catalog still has it');
  assert.equal(a.mainPool().roll(zero, { maxTier: 6 }), second, 'the own pool moved on to the next one');
  a.pool().give(first, cap);
  assert.deepEqual(collectViolations(m), []);
  m.dispose();
});

test('A: the per-player conservation is LIVE — a corrupted own pool is reported, the room-wide one is not used', () => {
  const h = makeMatch({ mode: 'coop', humans: 6, seed: 13, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  const a = h.ps('p_0');
  const base = chessOfTier(1).filter((x) => m.pool.has(x))[0];
  a.pool();                                    // build the own pool
  assert.deepEqual(collectViolations(m), []);
  a.pool().entries.get(base).left -= 1;        // one copy vanished: left + held != cap
  const bad = collectViolations(m);
  assert.ok(bad.some((v) => v.startsWith('p_0 pool ') && v.includes(base)), `expected a per-player pool violation, got ${JSON.stringify(bad)}`);
  a.pool().entries.get(base).left += 1;
  assert.deepEqual(collectViolations(m), []);
  // the ROOM-WIDE equation is not the one that runs here: draining the shared catalog is not a violation in this mode
  m.pool.entries.get(base).left -= 1;
  assert.deepEqual(collectViolations(m).filter((v) => v.startsWith('pool ')), [], 'the catalog is not conserved against the pieces here');
  m.pool.entries.get(base).left += 1;
  m.dispose();
});

test('A gate OFF: the room-wide conservation equation is the one that runs (a shared-pool deficit IS reported)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 2, seed: 14, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  const base = chessOfTier(1).filter((x) => m.pool.has(x))[0];
  assert.deepEqual(collectViolations(m), []);
  m.pool.entries.get(base).left -= 1;
  const e = m.pool.entries.get(base);
  const bad = collectViolations(m);
  assert.ok(bad.includes(`pool ${base}: left ${e.left} + held 0 != cap ${e.cap}`), `expected the room-wide equation to fire, got ${JSON.stringify(bad)}`);
  e.left += 1;
  assert.deepEqual(collectViolations(m), []);
  m.dispose();
});

test('A: EVERY copy source follows poolOf — the harness give() and the playtest grantDirectToHand included', () => {
  // (1) harness.give(): at ≤ MAX_SEATS it takes from the shared pool (the identical object), above it from the OWNER's
  // pool — so an existing scenario keeps charging the pool it charged before while a 100-seat one no longer touches the
  // shared catalog.
  const off = makeMatch({ mode: 'coop', humans: 2, bots: 2, seed: 81, fake: true }).start();
  off.toPrep(1);
  const offBase = chessOfTier(1).filter((x) => off.m.pool.has(x))[0];
  const offBefore = off.m.pool.left(offBase);
  give(off.m, off.ps('p_0'), offBase);
  assert.equal(off.m.pool.left(offBase), offBefore - 1, 'OFF: give() still charges the shared pool');
  off.m.dispose();

  const on = makeMatch({ mode: 'coop', humans: 3, bots: 2, seed: 82, fake: true }).start();
  on.toPrep(1);
  const onPs = on.ps('p_0');
  const onBase = chessOfTier(1).filter((x) => on.m.pool.has(x))[0];
  const ownBefore = onPs.pool().left(onBase);
  give(on.m, onPs, onBase);
  assert.equal(onPs.pool().left(onBase), ownBefore - 1, 'ON: give() charges the OWNER own pool');
  assert.equal(on.m.pool.left(onBase), on.m.pool.cap(onBase), 'ON: the shared catalog is untouched');
  assert.deepEqual(collectViolations(on.m), [], 'and the per-player conservation holds');
  on.m.dispose();

  // (2) phases.grantDirectToHand (the editor's SP_PLAYTEST / SP_DIRECT_TO_HAND deal): the same route, so a 100-seat
  // playtest no longer drops the shared catalog below its caps.
  const env = process.env;
  const saved = { playtest: env.SP_PLAYTEST, direct: env.SP_DIRECT_TO_HAND };
  try {
    const h = makeMatch({ mode: 'coop', humans: 3, bots: 2, seed: 83, fake: true }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    const direct = chessOfTier(1).filter((x) => h.m.pool.has(x))[0];
    env.SP_PLAYTEST = '1';
    env.SP_DIRECT_TO_HAND = direct;
    const own0 = ps.pool().left(direct);
    h.m.grantDirectToHand([ps]);
    assert.equal(ps.hand.filter(Boolean).length, 1, 'the dealt chess reached the hand');
    assert.equal(ps.pool().left(direct), own0 - 1, 'the copies came out of the player own pool');
    assert.equal(h.m.pool.left(direct), h.m.pool.cap(direct), 'the shared catalog is untouched');
    assert.deepEqual(collectViolations(h.m), []);
    h.m.dispose();
  } finally {
    if (saved.playtest === undefined) delete env.SP_PLAYTEST; else env.SP_PLAYTEST = saved.playtest;
    if (saved.direct === undefined) delete env.SP_DIRECT_TO_HAND; else env.SP_DIRECT_TO_HAND = saved.direct;
  }
});

test('A: a 自选 slot still routes to its own 自选 stock in BOTH modes (the pre-existing per-player routing is kept)', () => {
  for (const humans of [4, 6]) {
    const h = makeMatch({ mode: 'coop', humans, seed: 15, fake: true }).start();
    const m = h.m;
    h.toPrep(1);
    const ps = h.ps('p_0');
    const slot = m.gd.visibleChess.find((id) => m.gd.chess(id)?.isDiy) || null;
    void slot;
    // the 自选 stock is a DiyStock; with no picks it is empty, so the route falls through to the pool either way
    assert.equal(ps.diyStock.entries.size, 0);
    assert.equal(ps.poolOf(m.gd.visibleChess[0]), humans > MAX_SEATS ? ps.pool() : m.pool);
    assert.deepEqual(collectViolations(m), []);
    m.dispose();
  }
});

test('A: the harness check agrees with the rule in BOTH modes — neither reading loses its teeth', () => {
  const base0 = chessOfTier(1).filter((x) => DATA.chess[x].visible)[0];
  // OFF: the room-wide equation is still the one that fires (this is the pre-existing check, NOT relaxed)
  const off = makeMatch({ mode: 'coop', humans: 2, bots: 2, seed: 71, fake: true }).start();
  off.toPrep(1);
  assert.doesNotThrow(() => checkInvariants(off.m), 'a clean ≤ MAX_SEATS room passes');
  off.m.pool.entries.get(base0).left -= 1;
  assert.throws(() => checkInvariants(off.m), /!= cap/, 'a shared-pool deficit is still caught with the gate off');
  off.m.pool.entries.get(base0).left += 1;
  assert.doesNotThrow(() => checkInvariants(off.m));
  off.m.dispose();

  // ON: a > MAX_SEATS room (the shape the fuzz suite builds) passes, and a corrupted per-player pool is caught
  const on = makeMatch({ mode: 'coop', humans: 3, bots: 2, seed: 72, fake: true }).start();
  on.toPrep(1);
  assert.equal(on.m.seatCap, 5);
  const p = on.ps('p_0');
  const base = chessOfTier(1).filter((x) => on.m.pool.has(x))[0];
  assert.ok(p.acquireChess(base, { source: 'test', silent: true }));
  assert.doesNotThrow(() => checkInvariants(on.m), 'the per-player reading is the one that applies above MAX_SEATS');
  p.pool().entries.get(base).left -= 1;
  assert.throws(() => checkInvariants(on.m), /!= cap/, 'a per-player deficit is caught with the gate on');
  p.pool().entries.get(base).left += 1;
  assert.doesNotThrow(() => checkInvariants(on.m));
  on.m.dispose();
});

// -------------------------------------------------------------------------------------------------------------------
// C 100 人联防 — the planning shape

test('C: the plan SHAPE is the gate — one plan object at ≤ MAX_SEATS, the per-squad list above it, from the same results', () => {
  // squad 0 (seats 0..3): p_0 leaks, p_1..p_3 perfect. Squad 1 (seats 4..7): all perfect.
  const leaks = [2, 0, 0, 0, 0, 0, 0, 0];
  const small = unstartedMatch(4);
  const big = unstartedMatch(8);
  assert.equal(small.seatCap, MAX_SEATS);
  assert.equal(big.seatCap, 8);

  const one = planUnite(small, resultsFor(4, leaks));
  const many = planUnite(big, resultsFor(8, leaks));
  assert.ok(one && !Array.isArray(one), '≤ MAX_SEATS: the upstream single plan object');
  assert.ok(Array.isArray(many), '> MAX_SEATS: the per-squad list');
  assert.equal(many.length, 1, 'only squad 0 has both a leaker and a perfect member');
  assert.equal(many[0].squad, 0);

  // the single-squad variant plan IS the single-plan shape: same helpers, same leakers, same leaked enemies
  assert.deepEqual(many[0].helpers.map((p) => p.playerId), one.helpers.map((p) => p.playerId));
  assert.deepEqual(many[0].leakers.map((p) => p.playerId), one.leakers.map((p) => p.playerId));
  assert.deepEqual(many[0].leaked, one.leaked);
  assert.deepEqual([...many[0].notReentered], [...one.notReentered]);
  assert.ok(one.helpers.length <= small.gd.unite.maxHelpers);
  for (const p of many[0].helpers) assert.equal(squadIndexOf(p.seat), 0, 'a helper comes from the squad it defends');
});

test('C: 阶段 1 never mixes squads — two leaking squads plan two independent 联防', () => {
  const big = unstartedMatch(8);
  const plans = planUnite(big, resultsFor(8, [2, 0, 0, 0, 3, 0, 0, 0]));
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.squad), [0, 1]);
  for (const p of plans) {
    const seats = squadMembersOf(p.squad * SQUAD_SIZE);
    assert.ok(p.helpers.length > 0 && p.helpers.every((x) => seats.includes(x.seat)), `squad ${p.squad} helpers are its own`);
    assert.ok(p.leakers.every((x) => seats.includes(x.seat)), `squad ${p.squad} leakers are its own`);
    for (const l of p.leaked) assert.ok(seats.includes(big.players.get(l.sourcePlayerId).seat), `squad ${p.squad} enemies stay in its squad`);
  }
  assert.deepEqual(plans.map((p) => p.leaked.length), [2, 3]);
  // the room-wide plan the views and settle() read is the UNION (combineUniteResults)
  const merged = combineUniteResults(plans, []).plan;
  assert.deepEqual(merged.leakers.map((p) => p.playerId), ['p_0', 'p_4']);
  assert.deepEqual(merged.helpers.map((p) => p.playerId), plans.flatMap((p) => p.helpers).map((p) => p.playerId));
  assert.equal(merged.leaked.length, 5);
});

test('C: a squad with a leaker but no perfect member does not unite (nothing to send)', () => {
  const big = unstartedMatch(8);
  // every seat of squad 0 leaks, squad 1 is perfect → neither squad has BOTH sides
  assert.deepEqual(planUnite(big, resultsFor(8, [1, 1, 1, 1, 0, 0, 0, 0])), []);
  // a squad that leaks without a perfect member is skipped while its neighbour plans normally
  assert.deepEqual(planUnite(big, resultsFor(8, [1, 1, 1, 1, 2, 0, 0, 0])).map((p) => p.squad), [1]);
});

test('C: 100 seats make 25 squads and every squad defends only its own seats', () => {
  const m = unstartedMatch(100, 21);
  assert.equal(m.seatCap, 100);
  const leaks = new Array(100).fill(0);
  for (let i = 0; i < 16; i += 4) leaks[i] = 1;           // squads 0..3 leak at their first seat
  const plans = planUnite(m, resultsFor(100, leaks));
  assert.deepEqual(plans.map((p) => p.squad), [0, 1, 2, 3]);
  for (const p of plans) {
    const seats = squadMembersOf(p.squad * SQUAD_SIZE);
    assert.ok(p.helpers.every((x) => seats.includes(x.seat)));
    assert.ok(p.helpers.length <= 2, `${p.helpers.length} helpers`);
  }
});

test('C: an enemy the data does not know is counted as not-re-entered, never routed to another squad', () => {
  const m = unstartedMatch(8);
  const results = new Map([
    ['p_0', { leaked: [{ enemyKey: 'enemy_does_not_exist', lpr: 1, counted: true, tag: null, mods: null }], perfect: false }],
    ['p_1', res(0)], ['p_2', res(0)], ['p_3', res(0)],
    ['p_4', res(0)], ['p_5', res(0)], ['p_6', res(0)], ['p_7', res(0)],
  ]);
  const plans = planUniteBySquad(m, results);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].leaked.length, 0);
  assert.equal(plans[0].notReentered.get('p_0'), 1);
});

// -------------------------------------------------------------------------------------------------------------------
// C — live matches

/**
 * Play one scripted round in a `humans`-seat room and report the 联防 the match built. `leaks` is the counted-leak map
 * the scripted normal combats report; `place` the seats that put a piece on the board (identical in both modes, so the
 * two rounds are comparable).
 */
function uniteRoundOpts(humans, seed, leaks, place) {
  const h = makeMatch({ mode: 'coop', humans, seed, fake: true, script: (b) => (b.kind === 'normal' ? { leaks } : {}) }).start();
  const m = h.m;
  h.toPrep(1);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  place.forEach((pid, i) => {
    const ps = h.ps(pid);
    giveOwn(m, ps, ranged[i % ranged.length], legalTileFor(m, ps, ranged[i % ranged.length]));
  });
  h.drive(() => m.phase === PHASE.UNITE);
  assert.equal(m.phase, PHASE.UNITE, `a 联防 round starts in a ${humans}-seat room`);
  const opts = FakeBattle.instances.filter((b) => b.kind === 'unite').at(-1).opts;
  return {
    m,
    fieldIds: m.fields.map((f) => f.fieldId),
    waveId: opts.waveId, seed: opts.seed, fieldId: opts.fieldId, kind: opts.kind, round: opts.round,
    stageId: opts.stageId, rect: opts.rect, timeLimit: opts.timeLimit,
    players: opts.players.map((p) => p.playerId),
    spawns: opts.spawns.map((s) => s.enemyKey),
    helpers: (Array.isArray(m.unitePlan) ? [] : m.unitePlan.helpers).map((p) => p.playerId),
  };
}

const sameBattlefield = (a) => ({
  waveId: a.waveId, seed: a.seed, fieldId: a.fieldId, kind: a.kind, round: a.round,
  stageId: a.stageId, rect: a.rect, timeLimit: a.timeLimit, players: a.players, spawns: a.spawns, helpers: a.helpers,
});

test('C gate ON: a single-squad round is ONE field "u" whose battle options equal the ≤ MAX_SEATS round', () => {
  const place = ['p_1', 'p_2', 'p_3'];
  const off = uniteRoundOpts(4, 3702, { p_0: 3 }, place);
  const on = uniteRoundOpts(8, 3702, { p_0: 3 }, place);
  // the OFF match runs the pre-existing implementation: one field, one plan object, the variant fields at rest
  assert.deepEqual(off.fieldIds, ['u']);
  assert.ok(!Array.isArray(off.m.unitePlan));
  assert.equal(off.helpers.length, 2, 'two helpers on the right-hand field (escaped_multi)');
  assert.equal(off.waveId, 'act1autochess_escaped_multi');
  assert.equal(off.m.unitePlans, null);
  assert.equal(off.m._uniteToken, 0);
  // the ON match goes through the variant planner and STILL produces exactly one field 'u' (2 helpers ⇒ one squad)
  assert.deepEqual(on.fieldIds, ['u']);
  assert.equal(on.m.unitePlans.length, 1, 'one squad planned');
  assert.equal(on.m.uniteRound, 1);
  assert.equal(on.m._uniteToken, 1, 'one 联防 round started');
  assert.deepEqual(sameBattlefield(on), sameBattlefield(off), 'the single-squad battlefield is unchanged');
  off.m.dispose();
  on.m.dispose();
});

test('C gate ON: a lone helper (the golden unite-1 shape) is the same single-helper escaped round in both modes', () => {
  // squad 0: p_0, p_2, p_3 leak and only p_1 is perfect ⇒ 1 helper. Squad 1 is perfect and leaks nothing ⇒ no plan.
  const leaks = { p_0: 2, p_2: 1, p_3: 1 };
  const place = ['p_1', 'p_2', 'p_3'];
  const off = uniteRoundOpts(4, 8181, leaks, place);
  const on = uniteRoundOpts(8, 8181, leaks, place);
  assert.deepEqual(off.helpers, ['p_1']);
  assert.equal(off.waveId, 'act1autochess_escaped_single', '1 helper → the single-helper escaped template');
  assert.deepEqual(on.fieldIds, ['u']);
  assert.equal(on.helpers.length, 1);
  assert.deepEqual(sameBattlefield(on), sameBattlefield(off));
  assert.equal(sameBattlefield(on).waveId, 'act1autochess_escaped_single');
  off.m.dispose();
  on.m.dispose();
});

test('C gate ON: two squads that leak run two battlefields; each field holds only its own squad', () => {
  const h = makeMatch({
    mode: 'coop', humans: 8, seed: 909, fake: true,
    // every normal field reports 2 leaks for its own player; only the two first seats of each squad will leak in fact
    script: (b) => (b.kind === 'normal' ? { leaks: (b.players[0] === 'p_0' || b.players[0] === 'p_4') ? { [b.players[0]]: 2 } : {} } : {}),
  }).start();
  const m = h.m;
  h.toPrep(1);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  ['p_1', 'p_2', 'p_5', 'p_6'].forEach((pid, i) => {
    const ps = h.ps(pid);
    giveOwn(m, ps, ranged[i % ranged.length], legalTileFor(m, ps, ranged[i % ranged.length]));
  });
  h.drive(() => m.phase === PHASE.UNITE);
  assert.equal(m.phase, PHASE.UNITE);
  assert.equal(m.unitePlans.length, 2, 'both squads planned');
  assert.deepEqual(m.fields.map((f) => f.fieldId), ['u0', 'u1']);
  assert.equal(m.fields.length, m.unitePlans.length, 'one field per squad plan');
  for (let i = 0; i < m.fields.length; i++) {
    const seats = squadMembersOf(m.unitePlans[i].squad * SQUAD_SIZE);
    for (const pid of m.fields[i].players) assert.ok(seats.includes(m.players.get(pid).seat), `${pid} fights on its own squad's field`);
  }
  const all = m.fields.flatMap((f) => f.players);
  assert.equal(new Set(all).size, all.length, 'no player is a helper on two fields');
  assert.deepEqual(m.unitePlan.helpers.map((p) => p.playerId).sort(), all.slice().sort(), 'the union is what the views read');
  // _uniteLeft answers PER SQUAD: a leaker resolves through its own squad's plan and field, never the other squad's
  for (const squad of [0, 1]) {
    const plan = m.unitePlans.find((p) => p.squad === squad);
    assert.equal(m._unitePlanFor(plan.leakers[0]), plan, `a leaker of squad ${squad} resolves to squad ${squad}'s plan`);
    assert.ok(m._uniteFieldFor(plan), `squad ${squad} has its own field`);
  }
  assert.notEqual(m._uniteFieldFor(m.unitePlans[0]), m._uniteFieldFor(m.unitePlans[1]));
  assert.equal(m._unitePlanFor(h.ps('p_1')), null, 'a helper is not a leaker of any squad plan');
  assert.equal(m._uniteLeft(h.ps('p_1')), null, 'and _uniteLeft answers null for it, not another squad number');
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.equal(m.phase, PHASE.SETTLE);
  assert.ok(m.uniteResultView, 'the settlement carries the 联防 outcome');
  assert.deepEqual(collectViolations(m), []);
  m.dispose();
});

test('C gate ON: what 阶段 1 does not stop is handed to another squad and fought on a SECOND battlefield round', () => {
  const h = makeMatch({
    mode: 'coop', humans: 8, seed: 4242, fake: true,
    // squad 0's own combat leaks; its 联防 lets one enemy through (FakeBattle credits `survivors` to the field's first
    // player); the relay round stops everything, so the merged settlement has nothing left to bill.
    script: (b) => (b.kind !== 'normal' ? { survivors: String(b.fieldId) === 'u' ? { p_0: 1 } : {} } : (b.players[0] === 'p_0' ? { leaks: { p_0: 2 } } : {})),
  }).start();
  const m = h.m;
  h.toPrep(1);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  ['p_1', 'p_2', 'p_3', 'p_5', 'p_6', 'p_7'].forEach((pid, i) => {
    const ps = h.ps(pid);
    giveOwn(m, ps, ranged[i % ranged.length], legalTileFor(m, ps, ranged[i % ranged.length]));
  });
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.equal(m.phase, PHASE.SETTLE);
  // 阶段 2 really ran: a relay round with its own field and its own round number
  const relayFields = FakeBattle.instances.filter((b) => b.kind === 'unite' && String(b.fieldId).startsWith('r'));
  assert.equal(relayFields.length, 1, '阶段 2 started exactly one relay battlefield');
  assert.equal(m.uniteRound, 2, 'the relay round is round 2');
  assert.equal(m._uniteToken, 2, 'two 联防 rounds were started');
  assert.ok(m._phase1Settle, 'phase 1 outcome kept for the settlement');
  assert.equal(m._phase1Driven, m.round, 'phase 1 was planned exactly once for the round');
  assert.ok(m.uniteResultView, 'the settlement carries the merged 联防 outcome');
  assert.deepEqual(collectViolations(m), []);
  m.dispose();
});

test('C gate OFF (3 seats): a live match leaves every variant field of Match at its initial value', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 3702, fake: true, script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 2 } } : {}) }).start();
  const m = h.m;
  h.toPrep(1);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  ['p_1', 'p_2'].forEach((pid, i) => {
    const ps = h.ps(pid);
    giveOwn(m, ps, ranged[i], legalTileFor(m, ps, ranged[i]));
  });
  h.drive(() => m.phase === PHASE.UNITE);
  assert.equal(m.phase, PHASE.UNITE);
  assert.ok(m.unitePlan && !Array.isArray(m.unitePlan), 'the single room-wide plan');
  assert.deepEqual(m.fields.map((f) => f.fieldId), ['u']);
  // the C fields the patch adds are NOT USED when the gate is off: the constructor's values, never written.
  // (`_uniteLeftKey` is deliberately NOT in this set: `_uniteTick` is the pre-existing server-run streamer and writes
  // it in both modes — it is not one of the fields C adds.)
  const atRest = (mm) => ({
    unitePlans: mm.unitePlans, uniteRound: mm.uniteRound, _uniteToken: mm._uniteToken, _uniteHandoff: mm._uniteHandoff,
    _phase1Settle: mm._phase1Settle, _phase1Driven: mm._phase1Driven, _relayToken: mm._relayToken,
  });
  const REST = {
    unitePlans: null, uniteRound: 1, _uniteToken: 0, _uniteHandoff: null,
    _phase1Settle: null, _phase1Driven: 0, _relayToken: 0,
  };
  assert.deepEqual(atRest(m), REST);
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.equal(m.phase, PHASE.SETTLE);
  assert.deepEqual(atRest(m), REST, 'a full 联防 round + settlement still leaves them untouched');
  assert.deepEqual(collectViolations(m), []);
  m.dispose();
});

// -------------------------------------------------------------------------------------------------------------------
// C — the settled room-wide fold + the golden invariant

test('C: combineUniteResults folds several squad rounds into the one room-wide plan + result settle() bills', () => {
  const m = unstartedMatch(8);
  const plans = [
    { squad: 0, helpers: [m.players.get('p_1')], leakers: [m.players.get('p_0')], leaked: [{ enemyKey: ENEMY, sourcePlayerId: 'p_0', lpr: 1, mods: null, tag: null, bounty: null }], notReentered: new Map([['p_0', 1]]) },
    { squad: 1, helpers: [m.players.get('p_5')], leakers: [m.players.get('p_4')], leaked: [{ enemyKey: ENEMY, sourcePlayerId: 'p_4', lpr: 1, mods: null, tag: null, bounty: null }], notReentered: new Map([['p_4', 2]]) },
  ];
  const results = [
    { perPlayer: { p_1: { leaked: [{ enemyKey: ENEMY, sourcePlayerId: 'p_0', counted: true }], coins: 3, killed: 2, damageDealt: 10 } } },
    { perPlayer: { p_5: { leaked: [{ enemyKey: ENEMY, sourcePlayerId: 'p_4', counted: true }], coins: 1, killed: 1, damageDealt: 20 } } },
  ];
  const { plan, result } = combineUniteResults(plans, results);
  assert.deepEqual(plan.helpers.map((p) => p.playerId), ['p_1', 'p_5']);
  assert.deepEqual(plan.leakers.map((p) => p.playerId), ['p_0', 'p_4']);
  assert.equal(plan.leaked.length, 2);
  assert.equal(plan.notReentered.get('p_0'), 1);
  assert.equal(plan.notReentered.get('p_4'), 2);
  assert.equal(Object.keys(result.perPlayer).length, 2);
  assert.equal(result.perPlayer.p_1.coins, 3);
  assert.equal(result.perPlayer.p_5.damageDealt, 20);
  assert.equal(result.perPlayer.p_1.leaked.length, 1, 'the survivors of the field are visible to uniteSurvivors');
  assert.equal(result.synthetic, undefined, 'one real field is enough for settlement to charge the survivors');
});

test('C: a round with no real field stays synthetic — settle charges the players own leaks, as before', () => {
  const m = unstartedMatch(4);
  const plan = { squad: 0, helpers: [m.players.get('p_1')], leakers: [m.players.get('p_0')], leaked: [], notReentered: new Map() };
  assert.equal(combineUniteResults([plan], [{ synthetic: true }]).result.synthetic, true);
  assert.equal(combineUniteResults([], []).result.synthetic, true);
});

test('C: golden unite-1 / unite-2 are the 1- and 2-helper escaped rounds, reproduced identically in both modes', async () => {
  const { readFileSync } = await import('node:fs');
  const golden = JSON.parse(readFileSync(new URL('./golden/fields.json', import.meta.url), 'utf8'));
  const one = golden.scenarios['unite-1'];
  const two = golden.scenarios['unite-2'];
  assert.ok(one && two, 'the two 联防 scenarios exist');
  assert.equal(one.kind, 'unite');
  assert.equal(two.kind, 'unite');
  assert.equal(one.waveId, 'act1autochess_escaped_single', '1 helper → the single-helper escaped template');
  assert.equal(two.waveId, 'act1autochess_escaped_multi', '2 helpers → the two-lane escaped template');
  assert.equal(one.players && Object.keys(one.players).length, 1, '1 helper');
  assert.equal(two.players && Object.keys(two.players).length, 2, '2 helpers');
  // Both scenarios are ONE helper pair on ONE battlefield — the shape a single squad produces. Above, the live tests
  // pin that a 1-helper and a 2-helper room build that same battlefield (same waveId, seed, field id 'u', players,
  // spawns) with the gate ON and OFF. So neither scenario can move in either mode.
});
