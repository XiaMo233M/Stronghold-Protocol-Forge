// 百卫补丁 v0.3 → Forge 分支的移植回归 (docs/PS100-MIGRATION.md).
//
// Every item below is a THIRD-PARTY 100-seat change that had to be re-expressed so that a match at the official
// scale (≤ MAX_SEATS = 4 seats) behaves EXACTLY as it did before. Those "no-op at ≤ 4" claims are the point of this
// file: they are asserted against the pre-migration formula, not merely described.
//
// The 100-seat behaviours (what the item buys once a deployment raises the cap) are asserted too, so a regression
// that quietly re-clamps them fails here instead of only in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SEATS, DEFAULT_MAX_SEATS, PHASE, maxSeatsFrom, BOSS_HIT_LIMIT, bossHitLimitFrom } from '../shared/constants.js';
import { MAX_ALIVE_ENEMIES, MAX_ALIVE_ENEMIES_PER_PLAYER, aliveEnemyCap } from '../server/sim/constants.js';
import { bossPoolShareOf, GameData } from '../server/match/gamedata.js';
import { LOBBY_DEFAULTS, Room } from '../server/lobby.js';
import { validateC2S } from '../shared/protocol.js';
import { collectViolations } from '../server/match/invariants.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { leaderHitCancelled } from '../server/sim/damage.js';
import { normalizeSeats } from '../public/js/screens/room.js';
import { DATA as MATCH_DATA, makeMatch } from './match/harness.js';
import { planUnite } from '../server/match/unite.js';

// ---------------------------------------------------------------------------------------------------------------
// §1 the seat cap is configurable; its DEFAULT ceiling is 20 since 业主裁令 2026-10-12 (`MAX_SEATS` is the official
// room and the variant gate's reference, not the default)

test('ps100 §1: MAX_SEATS stays the official 4; the DEFAULT ceiling is 20 and SP_MAX_SEATS overrides it', () => {
  assert.equal(MAX_SEATS, 4, 'the official room is 1–4 players: this constant must not move');
  assert.equal(maxSeatsFrom(), DEFAULT_MAX_SEATS, 'no SP_MAX_SEATS in the environment ⇒ the default ceiling (20)');
  assert.equal(LOBBY_DEFAULTS.maxSeats, DEFAULT_MAX_SEATS, 'the Lobby default follows the same rule');
});

test('ps100 §1: maxSeatsFrom reads SP_MAX_SEATS and falls back on anything unusable', () => {
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '100' }), 100);
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '  100  ' }), 100, 'surrounding whitespace is tolerated');
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '4' }), 4, 'and the official room is still one env var away');
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '20' }), DEFAULT_MAX_SEATS);
  for (const bad of ['', '   ', 'junk', '0', '-5', 'NaN', 'Infinity']) {
    assert.equal(maxSeatsFrom({ SP_MAX_SEATS: bad }), DEFAULT_MAX_SEATS, `unusable value ${JSON.stringify(bad)} ⇒ the default`);
  }
  assert.equal(maxSeatsFrom({}), DEFAULT_MAX_SEATS, 'an environment without the variable');
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '7.8' }), 7, 'a fraction is floored, never zero');
});

test('ps100 §1: a room honours its seat cap and keeps the protocol gate in step with it', () => {
  // The class default is the official 4 (the class is also built directly by tests / packages), and the protocol gate
  // is the SERVER's ceiling — the same `maxSeatsFrom` the Lobby uses, so the two can never drift.
  const official = new Room('ABCD', 'coop', 'NORMAL', 0, MAX_SEATS);
  assert.equal(official.seatCap, MAX_SEATS);
  assert.equal(official.seats.length, MAX_SEATS);
  const cap = maxSeatsFrom();
  assert.equal(cap, DEFAULT_MAX_SEATS, 'this process has no SP_MAX_SEATS');
  assert.equal(validateC2S({ t: 'room.removeBot', seat: cap - 1 }), null, 'the last seat of the ceiling is addressable');
  assert.equal(validateC2S({ t: 'room.removeBot', seat: cap }), 'bad field seat', 'and nothing beyond it');
  assert.equal(validateC2S({ t: 'room.kick', seat: cap, playerId: 'p_0' }), 'bad field seat');
  // a 100-seat room: the seats exist and the same gate admits them
  const big = new Room('WXYZ', 'coop', 'NORMAL', 0, 100);
  assert.equal(big.seatCap, 100);
  assert.equal(big.seats.length, 100);
});

test('ps100 §1 (D): room.state carries the cap ONLY when it leaves the official 4, so a 4-seat frame is unchanged', () => {
  const vanilla = new Room('AAAA', 'coop', 'NORMAL', 0, MAX_SEATS);
  const frame = vanilla.toState();
  assert.equal(Object.hasOwn(frame, 'seatCap'), false, 'a 4-seat room adds no key (byte-for-byte the old frame)');
  assert.equal(frame.seats.length, MAX_SEATS);
  // …and a bigger room tells the client what to pad to, without the client guessing
  const wide = new Room('BBBB', 'coop', 'NORMAL', 0, 100);
  const wideFrame = wide.toState();
  assert.equal(wideFrame.seatCap, 100);
  assert.equal(wideFrame.seats.length, 100);
});

test('ps100 §1 (D): the client pads its seat cards to the SERVER cap, clamped against a bogus value', () => {
  // absent / unusable ⇒ the official 4 (this is what keeps every existing room's DOM identical)
  assert.equal(normalizeSeats({ mode: 'coop', seats: [null, null, null, null] }).length, MAX_SEATS);
  for (const bad of [undefined, null, 0, -3, 1.5, 'x', NaN]) {
    assert.equal(normalizeSeats({ mode: 'coop', seatCap: bad, seats: [null] }).length, MAX_SEATS, `junk seatCap ${String(bad)}`);
  }
  // the server's cap is honoured …
  assert.equal(normalizeSeats({ mode: 'coop', seatCap: 100, seats: [null] }).length, 100);
  assert.equal(normalizeSeats({ mode: 'coop', seatCap: 8, seats: [null, null] }).length, 8);
  // … but a hostile/garbage one cannot make the tab allocate unbounded memory
  assert.equal(normalizeSeats({ mode: 'coop', seatCap: 1e9, seats: [null] }).length, 256, 'clamped, not a RangeError');
  // solo is always exactly one seat, whatever the frame claims
  assert.equal(normalizeSeats({ mode: 'solo', seatCap: 100, seats: [null] }).length, 1);
});

test('ps100 §1: the seat gate is the SAME number the room has (one source, no drift)', () => {
  // C2S is the single gate: the handler below it only checks that the seat holds an AI / the confirmed player.
  // Whatever SEAT_CAP the protocol captured must therefore be ≥ the room's own cap, or a legitimate room becomes
  // unaddressable. Both read maxSeatsFrom(), so this holds for every environment.
  const cap = maxSeatsFrom();
  for (const t of ['room.removeBot', 'room.kick']) {
    const extra = t === 'room.kick' ? { playerId: 'p_0' } : {};
    assert.equal(validateC2S({ t, seat: cap - 1, ...extra }), null, `${t} admits seat ${cap - 1}`);
    assert.equal(validateC2S({ t, seat: cap, ...extra }), 'bad field seat', `${t} refuses seat ${cap}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// §2 the living-enemy rail keeps its single-player meaning

test('ps100 §2: aliveEnemyCap is EXACTLY the flat rail at one player (every normal field)', () => {
  assert.equal(MAX_ALIVE_ENEMIES, 600, 'the rail the robustness suite pins');
  assert.equal(MAX_ALIVE_ENEMIES_PER_PLAYER, MAX_ALIVE_ENEMIES, 'one player\'s board is the unit of the allowance');
  assert.equal(aliveEnemyCap(1), MAX_ALIVE_ENEMIES, 'no-op for every solo / boss / hidden / normal field');
  // a missing, zero or unparsable count is one player, never zero enemies or an unbounded field
  for (const bad of [undefined, null, NaN, 0, -3, '', 'junk', Infinity]) {
    assert.equal(aliveEnemyCap(bad), MAX_ALIVE_ENEMIES, `unusable player count ${JSON.stringify(bad)} ⇒ one player`);
  }
});

test('ps100 §2: a shared field scales the rail per player (the 100-seat 联防 field)', () => {
  assert.equal(aliveEnemyCap(2), 2 * MAX_ALIVE_ENEMIES);
  assert.equal(aliveEnemyCap(4), 4 * MAX_ALIVE_ENEMIES);
  assert.equal(aliveEnemyCap(3.9), 3 * MAX_ALIVE_ENEMIES, 'floored');
  // it stays a runaway guard: the allowance is always ≥ the flat rail
  for (const n of [1, 2, 4, 100]) assert.ok(aliveEnemyCap(n) >= MAX_ALIVE_ENEMIES);
});

// ---------------------------------------------------------------------------------------------------------------
// §3 the boss-pool ceiling is no longer the 4-seat calibration

test('ps100 §3: bossPoolShareOf is unchanged for EVERY ≤4-seat case (old formula, verbatim)', () => {
  const cfg = { perPlayer: true, coop: 1, solo: 1, aliveFull: 4, aliveScaling: false };
  // the pre-migration body, copied: full = max(1, floor(aliveFull)); alive = min(full, n)
  const before = (alive) => 1 * Math.min(Math.max(1, Math.floor(4)), alive);
  for (const seatCap of [undefined, 1, 2, 3, 4]) {
    for (let alive = 1; alive <= 8; alive++) {
      assert.equal(bossPoolShareOf(undefined, cfg, false, alive, seatCap), before(alive), `seatCap=${seatCap} alive=${alive}`);
    }
  }
  // solo is untouched by the ceiling in every configuration
  assert.equal(bossPoolShareOf(undefined, cfg, true, 4, 100), 1);
  assert.equal(bossPoolShareOf(undefined, cfg, true, 100, 100), 1);
  // defaults when the caller passes nothing (the ≤4 call shape every existing caller uses)
  assert.equal(bossPoolShareOf(undefined, cfg, false, 32), before(4), 'no seatCap ⇒ the 4-seat ceiling, as before');
});

test('ps100 §3: a bigger room stops being clamped to the 4-seat pool (FINDINGS-100 §3.4 numbers)', () => {
  const cfg = { perPlayer: true, coop: 1, solo: 1, aliveFull: 4, aliveScaling: false };
  // the probe: bloodPoint 400000 × alive 32 was 1600000 (alive clamped to 4) and must be 12800000
  const BP = 400000;
  assert.equal(BP * bossPoolShareOf(undefined, cfg, false, 32, 4), 1600000, 'the 4-seat room keeps its pool');
  assert.equal(BP * bossPoolShareOf(undefined, cfg, false, 32, 100), 12800000, 'a 100-seat room scales linearly');
  // linear in the alive count up to the seat cap
  for (const alive of [4, 16, 32, 100]) assert.equal(bossPoolShareOf(undefined, cfg, false, alive, 100), alive);
  assert.equal(bossPoolShareOf(undefined, cfg, false, 100, 100), 100);
  // the config stays the authority: a HIGHER aliveFull is still honoured, a lower one cannot clamp a bigger room
  assert.equal(bossPoolShareOf(undefined, { ...cfg, aliveFull: 200 }, false, 150, 100), 150);
  assert.equal(bossPoolShareOf(undefined, { ...cfg, aliveFull: 4 }, false, 150, 100), 100);
});

test('ps100 §3: GameData carries the seat cap, defaulting to MAX_SEATS', () => {
  const gd = new GameData({}, 'mode_multi_normal');
  assert.equal(gd.seatCap, MAX_SEATS);
  assert.equal(new GameData({}, 'mode_multi_normal', { seatCap: 100 }).seatCap, 100);
  // unusable values fall back rather than producing a zero / NaN ceiling
  for (const bad of [0, -1, NaN, 'x', null]) assert.equal(new GameData({}, 'mode_multi_normal', { seatCap: bad }).seatCap, MAX_SEATS);
  assert.equal(new GameData({}, 'mode_multi_normal', { seatCap: 7.9 }).seatCap, 7);
});

// ---------------------------------------------------------------------------------------------------------------
// §5 the lone human in a co-op room can no longer stall the prep forever

test('ps100 §5: a lone human + AI teammates arms the prep deadline (the stall that had none)', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 3, seed: 5, fake: true, timerScale: 1 }).start();
  const m = h.m;
  assert.equal(m.loneHuman, true, 'exactly one human seat');
  assert.equal(m.soloUntimed, true, 'the playtest #4 item 3 rule still holds for every other phase');
  assert.equal(m.hasReadyableHuman, true, 'that human is the seat the prep waits for');
  assert.ok(h.drive(() => m.phase === PHASE.PREP && m.round === 1, { ready: false }), 'reached PREP with the human unready');
  assert.ok(m.deadline > 0, 'PREP publishes a deadline');
  assert.ok(m._phaseTimer, 'and arms a real timer');
  // THE positive assertion for this fix: the lone-human co-op room IS timed. Without it a revert of the guard would
  // silently restore the deadlock (the test below would still pass, since a stalled prep trivially "does not advance").
  assert.equal(m.prepFallbackGuard, true, 'this is the lone-human co-op room the guard exists for');
  assert.equal(m.prepDeadlineSeconds(), m.gd.prepTime(m.round), 'it gets the timer the DATA already declares for the round');
  assert.equal(m.prepUntimed, false, 'so its prep is not untimed');
  // the human never presses Ready: the deadline must carry the match on instead of stalling it
  h.sched.advance(10 * 60_000);
  assert.notEqual(m.phase, PHASE.PREP, 'the prep cannot wait forever on a silent human');
  m.dispose();
});

test('ps100 §5: only the lone-human room falls back to the infoCheck guard; every other room keeps the data’s own decision', () => {
  // a co-op room with two humans: the prep is timed by the DATA (as it always was) — the guard must not touch it
  const two = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 5, fake: true, timerScale: 1 }).start();
  assert.ok(two.drive(() => two.m.phase === PHASE.PREP && two.m.round === 1, { ready: false }), 'reached PREP R1');
  assert.equal(two.m.prepFallbackGuard, false, 'two humans ⇒ no fallback');
  assert.equal(two.m.prepDeadlineSeconds(), two.m.gd.prepTime(1), 'still exactly the round’s own prepTime');
  assert.equal(two.m.prepDeadlineSeconds(), 65, 'and that value is the one the data declares');
  two.m.dispose();
  // an all-AI room: nobody can press Ready, so nothing is timed and the fallback guard is irrelevant
  const ai = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 0, bots: 4, seed: 5, fake: true, timerScale: 1 }).start();
  assert.ok(ai.drive(() => ai.m.phase === PHASE.PREP && ai.m.round === 1, { ready: false }), 'reached PREP R1');
  assert.equal(ai.m.prepFallbackGuard, false, 'no lone human ⇒ no fallback');
  assert.equal(ai.m.hasReadyableHuman, false, 'nobody can press Ready');
  assert.equal(ai.m.prepDeadlineSeconds(), ai.m.gd.prepTime(1), 'the AI room uses the data’s own timer too');
  ai.m.dispose();
});

test('ps100 §5: solo keeps its untimed prep (nobody waits on anybody)', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, bots: 0, seed: 5, fake: true, timerScale: 1 }).start();
  const m = h.m;
  assert.equal(m.isSolo, true);
  assert.equal(m.prepUntimed, true, 'solo prep stays untimed');
  assert.ok(h.drive(() => m.phase === PHASE.PREP && m.round === 1, { ready: false }), 'reached PREP');
  assert.equal(m.deadline, 0, 'no countdown for a solo prep');
  assert.equal(m._phaseTimer, null, 'and no timer');
  m.dispose();
});

test('ps100 §5: an all-AI co-op room has no human to wait for and keeps its untimed prep path', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 0, bots: 4, seed: 5, fake: true, timerScale: 1 }).start();
  const m = h.m;
  assert.equal(m.hasReadyableHuman, false);
  assert.equal(m.prepUntimed, true, 'no human can press Ready ⇒ nothing to time');
  m.dispose();
});

// ---------------------------------------------------------------------------------------------------------------
// §5b 限伤 (`BOSS_HIT_LIMIT`) stays 300000 and is overridable per deployment — NOT switched off

test('ps100 §5b: 限伤 keeps its official 300000 default and is byte-for-byte unchanged without an override', () => {
  assert.equal(BOSS_HIT_LIMIT, 300000, 'the official MAX_BATTLE_DAMAGE — the patch’s Infinity is NOT the default');
  // no environment ⇒ undefined ⇒ damage.js falls back to BOSS_HIT_LIMIT
  assert.equal(bossHitLimitFrom({}), undefined);
  assert.equal(bossHitLimitFrom(undefined), undefined);
  for (const unset of ['', '  ']) assert.equal(bossHitLimitFrom({ SP_BOSS_HIT_LIMIT: unset }), undefined, `unset ${JSON.stringify(unset)}`);
  for (const junk of ['junk', '-5', 'NaN', '1e999']) assert.equal(bossHitLimitFrom({ SP_BOSS_HIT_LIMIT: junk }), undefined, `junk ${junk}`);
});

test('ps100 §5b: a deployment may move or disable the rail, with the constant’s own 0 / Infinity = off semantics', () => {
  assert.equal(bossHitLimitFrom({ SP_BOSS_HIT_LIMIT: '500000' }), 500000);
  assert.equal(bossHitLimitFrom({ SP_BOSS_HIT_LIMIT: ' 750000 ' }), 750000);
  for (const off of ['0', 'off', 'OFF', 'infinity', 'Infinity', 'inf']) {
    assert.equal(bossHitLimitFrom({ SP_BOSS_HIT_LIMIT: off }), Infinity, `${off} disables the limit`);
  }
});

test('ps100 §5b: the override reaches a REAL battle and decides the cancels (spec round-trip included)', () => {
  const build = (extra) => createBattleFromSpec(
    buildBattleSpec({ kind: 'boss', seed: 3, round: 14, modeId: 'mode_multi_normal', ...extra }), MATCH_DATA, { quiet: true });
  const dflt = build({});
  const wide = build({ bossHitLimit: 500000 });
  const off = build({ bossHitLimit: Infinity });
  // the default battle carries no field at all ⇒ damage.js reads BOSS_HIT_LIMIT
  assert.equal(dflt.bossHitLimit, undefined, 'an unconfigured battle is untouched');
  assert.equal(wide.bossHitLimit, 500000);
  assert.equal(off.bossHitLimit, Infinity, 'JSON null is rebuilt as Infinity on the client path');
  // the rail decides: 400000 is cancelled at the official 300000, survives a 500000 rail, and "off" cancels nothing
  const leader = (b) => b.units.find((u) => u.side === 'enemy' && u.isBoss) || { isBoss: true, x: 0, y: 0, id: 1 };
  assert.equal(leaderHitCancelled(dflt, leader(dflt), 400000), true, 'official rail cancels 400000');
  assert.equal(leaderHitCancelled(wide, leader(wide), 400000), false, 'a 500000 rail lets 400000 through');
  assert.equal(leaderHitCancelled(wide, leader(wide), 1000000), true, 'and still cancels 1000000');
  assert.equal(leaderHitCancelled(off, leader(off), 1000000), false, '“off” cancels nothing');
  // the spec only carries the key when it was asked for, so old specs are byte-for-byte unchanged
  assert.equal(Object.hasOwn(buildBattleSpec({ kind: 'boss', seed: 1 }), 'bossHitLimit'), false);
});

// ---------------------------------------------------------------------------------------------------------------
// §6 the two DESIGN-LEVEL items that landed behind the same switch (docs/PS100-MIGRATION.md §10, §11):
//   A 每人独立牌库 (gated in PlayerState.poolOf, the unique dispatch point) and
//   C 100 人联防 (gated in MatchUnite.startUnite's argument shape).
// Both are index entries here; test/ps100-variant-ac.test.js carries the full two-direction suite
// (gate ON and OFF, the live per-player conservation, one plan object vs the per-squad list, the single-squad
// battlefield equality and the 阶段 2 relay round).

test('ps100 §6A: the switch is PARTICIPANT COUNT, and OFF it hands back the identical m.pool — even in a 20-seat room', () => {
  const mk = (humans) => makeMatch({ mode: 'coop', humans, seed: 60 + humans, fake: true }).start();
  const small = mk(MAX_SEATS);
  small.toPrep(1);
  const s = small.ps('p_0');
  assert.equal(small.m.participants, MAX_SEATS);
  assert.equal(small.m.variant, false);
  assert.equal(s.variantOn(), false, 'the switch reads the participant count, not the room capacity');
  assert.equal(s.mainPool(), small.m.pool, 'OFF: the draw source IS the shared pool object');
  assert.equal(s._ownPool, null, 'OFF: no per-player pool is ever built');
  for (const base of small.m.gd.visibleChess.slice(0, 40)) assert.equal(s.poolOf(base), small.m.pool);
  small.m.dispose();

  const big = mk(MAX_SEATS + 1);
  big.toPrep(1);
  const b = big.ps('p_0');
  assert.equal(big.m.participants, MAX_SEATS + 1);
  assert.equal(b.variantOn(), true, 'one participant past the official 4 turns it on');
  assert.notEqual(b.mainPool(), big.m.pool, 'ON: the draw source is the player own pool');
  assert.equal(b.poolOf(big.m.gd.visibleChess[0]), b.mainPool());
  big.m.dispose();
});

test('ps100 §6A: 闸门读在场参与者数 —— a 20-seat room with only 4 players in it stays on the ORIGINAL path', () => {
  const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true }));
  // Capacity 20 (the new default ceiling), participants 4: the seat list is what the Match sees, so `seatCap` is 20 and
  // the gate must still be OFF. This is the core case of 业主裁令 2026-10-12.
  const h = makeMatch({ mode: 'coop', seats: seats(4), seatCap: 20, seed: 61, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  assert.equal(h.m.seatCap, 20, 'the room really is a 20-seat room …');
  assert.equal(h.m.participants, 4, '… with four participants');
  assert.equal(h.m.variant, false);
  assert.equal(ps.variantOn(), false, 'so the capacity never turns the variant on');
  assert.equal(ps.mainPool(), h.m.pool, 'the shared pool object, exactly as before');
  assert.equal(ps._ownPool, null, 'and no per-player pool is built');
  assert.deepEqual(collectViolations(h.m), [], 'the room-wide invariant reading passes');
  h.m.dispose();
});

test('ps100 §6C: the 联防 shape follows the PARTICIPANTS — one plan object at ≤ 4, the per-squad list above it', () => {
  // the same finished-combat results in a 4-participant and an 8-participant room; squad 0 leaks, everything else is perfect
  const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true }));
  const mk = (n, seatCap) => makeMatch({ mode: 'coop', seats: seats(n), ...(seatCap ? { seatCap } : {}), seed: 6, fake: true }).m;
  const results = (n) => new Map(Array.from({ length: n }, (_, i) => [`p_${i}`, {
    leaked: i === 0 ? [{ enemyKey: Object.keys(MATCH_DATA.enemies)[0], lpr: 1, counted: true, tag: null, mods: null }] : [],
    perfect: i !== 0,
  }]));
  const small = mk(MAX_SEATS);
  const big = mk(MAX_SEATS + 4);
  const one = planUnite(small, results(MAX_SEATS));
  const many = planUnite(big, results(MAX_SEATS + 4));
  assert.ok(one && !Array.isArray(one), '≤ 4 participants: the upstream single plan object');
  assert.ok(Array.isArray(many), '> 4 participants: the per-squad plan list');
  assert.equal(many.length, 1, 'only squad 0 has both a leaker and a perfect member');
  assert.deepEqual(many[0].helpers.map((p) => p.playerId), one.helpers.map((p) => p.playerId));
  assert.deepEqual(many[0].leakers.map((p) => p.playerId), one.leakers.map((p) => p.playerId));
  // …and CAPACITY alone never changes the shape: the same four people in a 20-seat room get the single plan object.
  const wideRoom = mk(MAX_SEATS, 20);
  assert.equal(wideRoom.seatCap, 20);
  const stillOne = planUnite(wideRoom, results(MAX_SEATS));
  assert.ok(stillOne && !Array.isArray(stillOne), '容量 20 只坐 4 人 ⇒ 原路径');
  assert.deepEqual(stillOne.helpers.map((p) => p.playerId), one.helpers.map((p) => p.playerId));
  // and the fields C adds to Match stay at rest for a ≤ MAX_SEATS room (a live match is pinned in the §6 file)
  assert.equal(small.unitePlans, null);
  assert.equal(small.uniteRound, 1);
  assert.equal(small._uniteToken, 0);
});

test('ps100 §6D: the settlement frame names the path (m.result.variant) — capacity never decides it', () => {
  const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true }));
  const four = makeMatch({ mode: 'coop', seats: seats(4), seatCap: 20, seed: 71, fake: true }).start();
  four.drive(() => four.ended != null);
  assert.ok(four.ended, 'the match ended');
  assert.equal(four.ended.variant, false, '4 participants in a 20-seat room report the ORIGINAL path');
  const frame = four.sent.map(([, msg]) => msg).find((msg) => msg.t === 'm.result');
  assert.ok(frame, 'the settlement frame was sent');
  assert.equal(frame.variant, false, 'and it rides the wire');
  four.m.dispose();

  const five = makeMatch({ mode: 'coop', seats: seats(5), seatCap: MAX_SEATS, seed: 72, fake: true }).start();
  five.drive(() => five.ended != null);
  assert.ok(five.ended, 'the match ended');
  assert.equal(five.ended.variant, true, '5 participants report the variant even when the capacity is the official 4');
  const wideFrame = five.sent.map(([, msg]) => msg).find((msg) => msg.t === 'm.result');
  assert.equal(wideFrame.variant, true);
  five.m.dispose();
});
