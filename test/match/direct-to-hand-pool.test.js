// The playtest deal (`MatchPhases.grantDirectToHand`, the SP_PLAYTEST / SP_DIRECT_TO_HAND switch) draws its copies from
// `PlayerState.poolOf` — the UNIQUE dispatch point (design-level A, docs/PS100-MIGRATION.md §10-A). Two halves make that
// routing safe, and both need their own assertion:
//
//   gate ON  (> MAX_SEATS): the copies leave the OWNER's own pool and the shared catalog stays at its caps — pinned in
//                           test/ps100-variant-ac.test.js.
//   gate OFF (≤ MAX_SEATS): `poolOf` hands back the very `m.pool` object, so the deal must charge the shared catalog
//                           exactly as the pre-change `this.pool.take(...)` did. test/ps100-variant-ac.test.js pins this
//                           half for `harness.give()` but NOT for `grantDirectToHand`; this file pins it here.
//
// The gate-OFF equality is what makes the routing change free for every existing deployment (no production server runs
// the 100-seat variant), and it is what a later edit can silently break — routing OFF to the player's own pool, or
// taking with `overdraw` — so it gets a dedicated assertion rather than relying on "poolOf returns m.pool anyway".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SEATS } from '../../shared/constants.js';
import { makeMatch, chessOfTier, checkInvariants } from './harness.js';

test('A gate OFF (≤ MAX_SEATS): the playtest deal still charges the SHARED pool — the very object poolOf returns', () => {
  const env = process.env;
  const saved = { playtest: env.SP_PLAYTEST, direct: env.SP_DIRECT_TO_HAND };
  try {
    const h = makeMatch({ mode: 'coop', humans: 2, bots: 2, seed: 91, fake: true }).start();
    h.toPrep(1);
    const m = h.m, ps = h.ps('p_0');
    assert.equal(m.seatCap, MAX_SEATS, 'the official ceiling: the gate is off');
    assert.equal(ps.variantOn(), false);
    const direct = chessOfTier(1).filter((x) => m.pool.has(x))[0];
    assert.ok(direct, 'a tier-1 base with pool copies');
    assert.equal(ps.poolOf(direct), m.pool, 'OFF: the route IS the shared catalog object, not a copy of it');
    env.SP_PLAYTEST = '1';
    env.SP_DIRECT_TO_HAND = direct;
    const before = m.pool.left(direct);
    m.grantDirectToHand([ps]);
    assert.ok(ps.hand.some((p) => p && p.id === direct), 'the dealt chess reached the hand');
    assert.equal(m.pool.left(direct), before - 1, 'OFF: the deal debits the SHARED catalog, exactly as before');
    assert.equal(checkInvariants(m), true, 'and the room-wide conservation still holds');
    m.dispose();
  } finally {
    if (saved.playtest === undefined) delete env.SP_PLAYTEST; else env.SP_PLAYTEST = saved.playtest;
    if (saved.direct === undefined) delete env.SP_DIRECT_TO_HAND; else env.SP_DIRECT_TO_HAND = saved.direct;
  }
});
