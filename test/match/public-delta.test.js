// The incremental `m.public` frame (DESIGN §8.2 "incremental frame"): server/viewsDelta.js produces the patch and
// public/js/matchDelta.js merges it back. This suite pins the two halves against EACH OTHER and against the rule that
// matters: the state a client materializes out of a stream of deltas is exactly the full frame's state — field for
// field, including arrays' order, absent keys vs `undefined`, and `null` as a real value.
//
// The end-to-end half (a real match's own frame stream, 4 seats and 40 seats, compared against the full frames the same
// match emitted) is test/match/public-delta-match.test.js; this file pins the rules themselves.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { publicDelta, publicBaseline, isEmptyDelta } from '../../server/viewsDelta.js';
import { applyPublic, canMerge, mergePublic, clonePublic, emptyPublic } from '../../public/js/matchDelta.js';

/** A deep clone of a fixture value, then `over` merged in — the pattern every "next frame" below is built with. */
const deepMerge = (base, over) => {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out;
};

/** The next full view of a fixture: same values, freshly built objects (what publicView really returns each frame). */
const rebuild = (base, over = {}) => deepMerge(base, over);

/** A full public view fixture (the exact shape MatchViews.publicView emits, trimmed to what these rules touch). */
const view = (over = {}) => deepMerge({
  t: 'm.public',
  phase: 'PREP',
  round: 2,
  lastRound: 9,
  deadline: 1000,
  serverNow: 1_700_000_000_000,
  modeId: 'mode_coop_normal',
  difficulty: 'NORMAL',
  stageId: 'stage_01',
  setupRevision: 3,
  rerollVote: null,
  factions: ['A', 'B'],
  disabledBonds: ['b1'],
  drawnDisabledBonds: [],
  bannedChess: ['char_x'],
  bossId: null,
  hiddenBossId: null,
  bossRound: 0,
  hiddenRound: 0,
  spRound: false,
  combatMode: 'client',
  paused: false,
  players: [
    { playerId: 'p_0', seat: 0, name: 'P0', isBot: false, connected: true, alive: true, lp: 40, bandId: null, shopLevel: 3, boardCount: 2, ready: false, bonds: [], fieldId: null, status: 'acting', autoplay: false },
    { playerId: 'p_1', seat: 1, name: 'P1', isBot: true, connected: true, alive: true, lp: 30, bandId: 'band_bldsk', shopLevel: 2, boardCount: 1, ready: true, bonds: [{ bondId: 'b1', count: 2, active: false, tier: 0, layers: 0 }], fieldId: null, status: 'ready', autoplay: false },
  ],
  fields: [{ fieldId: 'n:p_0', kind: 'normal', players: ['p_0'], live: true, progress: { killed: 0, resolved: null, total: 5, done: false } }],
}, over);

/** Apply a wire frame to a baseline exactly like the browser does (the production merge, no test-side reimplementation). */
const step = (base, frame) => {
  const res = applyPublic(base, frame);
  assert.equal(res.ok, true, `frame must be mergeable: ${JSON.stringify(frame)}`);
  return res.state;
};

/** The row a browser materializes out of the default fixture's first player (the comparison side of every row test). */
const clientRow = () => clonePublic(view()).players[0];

describe('incremental m.public: the server diff', () => {
  test('the first frame is full and a no-op frame carries nothing to send', () => {
    const base = publicBaseline(view());
    // an unchanged view: the delta must carry nothing at all (the caller then sends no frame)
    const same = publicDelta(base, view());
    assert.equal(isEmptyDelta(same.frame), true, 'no change => nothing to send');
    assert.deepEqual(Object.keys(same.frame), ['t', 'delta'], JSON.stringify(same.frame));
  });

  test('a scalar that changed rides the frame; serverNow is never part of the diff', () => {
    const base = publicBaseline(view());
    const { frame } = publicDelta(base, view({ phase: 'COMBAT', round: 3, serverNow: 1_700_000_000_999 }));
    assert.equal(frame.delta, true);
    assert.equal(frame.phase, 'COMBAT');
    assert.equal(frame.round, 3);
    assert.equal(Object.hasOwn(frame, 'serverNow'), false, 'serverNow is not part of the diffed state (the match adds it)');
    assert.equal(Object.hasOwn(frame, 'players'), false, 'unchanged rows are not resent');
    assert.equal(Object.hasOwn(frame, 'fields'), false);
  });

  test('row patches are field-level: only the changed field, always with the playerId', () => {
    const base = publicBaseline(view());
    const next = view();
    next.players[1].lp = 29;
    next.players[1].boardCount = 3;
    const { frame } = publicDelta(base, next);
    assert.deepEqual(frame.players, [{ playerId: 'p_1', lp: 29, boardCount: 3 }]);
  });

  test('a row field that left the row is said out loud as null, and the client deletes it', () => {
    const withPending = view();
    withPending.players[0].pendingLp = 4;
    const base = publicBaseline(withPending);
    const { frame } = publicDelta(base, view());
    assert.deepEqual(frame.players, [{ playerId: 'p_0', pendingLp: null }]);
    // the client's row then matches a full frame without the key: the same fields, the same values
    const merged = step(clonePublic(withPending), frame);
    assert.deepEqual(merged.players[0], clientRow());
    assert.equal(merged.players[0].pendingLp, undefined);
  });

  test('a top-level null is a value; a absent top-level key is named in gone and deleted', () => {
    const base = publicBaseline(view({ bossId: 'boss_7', teamLp: 30 }));
    const next = view({ bossId: null });
    delete next.teamLp;
    const { frame } = publicDelta(base, next);
    assert.equal(frame.bossId, null, 'null is the value, not a deletion');
    assert.deepEqual(frame.gone, ['teamLp'], 'the key that left the view is named');
    // the client keeps the null and deletes the gone key — exactly what a full frame without it materializes to
    const merged = step(clonePublic(view({ bossId: 'boss_7', teamLp: 30 })), frame);
    assert.equal(merged.bossId, null);
    assert.equal(Object.hasOwn(merged, 'teamLp'), false);
    assert.deepEqual(Object.keys(merged).sort(), Object.keys(clonePublic(next)).sort());
  });

  test('a row null normalizes to the same absent key on both paths', () => {
    // a row's unset bandId is null in the full frame and null in the patch: one rule, one resulting state
    const withBand = view();
    withBand.players[0].bandId = 'band_x';
    const b2 = publicBaseline(withBand);
    const r2 = publicDelta(b2, view());
    assert.deepEqual(r2.frame.players, [{ playerId: 'p_0', bandId: null }]);
    const merged = step(clonePublic(withBand), r2.frame);
    assert.deepEqual(merged.players[0], clientRow());
    assert.equal(Object.hasOwn(merged.players[0], 'bandId'), false, 'an unset row field leaves the row');
  });
  test('a departed seat is a gone patch; a new seat is its whole row', () => {
    const base = publicBaseline(view());
    const fresh = { playerId: 'p_2', seat: 2, name: 'P2', isBot: false, connected: true, alive: true, lp: 45, bandId: null, shopLevel: 1, boardCount: 0, ready: false, bonds: [], fieldId: null, status: 'acting', autoplay: false };
    const next = view({ players: [view().players[0], fresh] });
    const { frame } = publicDelta(base, next);
    const seen = frame.players.map((p) => ({ id: p.playerId, gone: !!p.gone })).sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepEqual(seen, [{ id: 'p_1', gone: true }, { id: 'p_2', gone: false }], 'only the rows that changed are patched');
    assert.deepEqual(frame.players.find((p) => p.playerId === 'p_2'), fresh, 'a new seat is sent whole');
    assert.equal(frame.players.find((p) => p.playerId === 'p_0'), undefined, 'an unchanged row is not resent');
  });

  test('fields: an unchanged entry is not resent, a changed one is patched per entry', () => {
    const base = publicBaseline(view());
    const next = view();
    next.fields[0].progress = { killed: 2, resolved: 1, total: 5, done: false };
    const { frame } = publicDelta(base, next);
    assert.deepEqual(frame.fields, [{ fieldId: 'n:p_0', progress: { killed: 2, resolved: 1, total: 5, done: false } }]);
    // the merged list is the full list, entry for entry
    const merged = step(clonePublic(view()), frame);
    assert.deepEqual(merged.fields, clonePublic(next).fields);
    const r2 = publicDelta(publicBaseline(view()), view());
    assert.equal(Object.hasOwn(r2.frame, 'fields'), false, 'an identical field list is not resent');
  });

  test('a field that left the list is a gone patch; a new one arrives whole', () => {
    const two = view({ fields: [view().fields[0], { fieldId: 'n:p_1', kind: 'normal', players: ['p_1'], live: true }] });
    const base = publicBaseline(two);
    const one = view();
    const f1 = publicDelta(base, one);
    assert.deepEqual(f1.frame.fields, [{ fieldId: 'n:p_1', gone: true }], 'only the dropped entry rides the frame');
    const merged = step(clonePublic(two), f1.frame);
    assert.deepEqual(merged.fields, clonePublic(one).fields, 'the gone entry is dropped');
    // and back again: the new entry arrives whole
    const back = publicDelta(publicBaseline(one), two);
    assert.deepEqual(back.frame.fields, [{ fieldId: 'n:p_1', kind: 'normal', players: ['p_1'], live: true }]);
    assert.deepEqual(step(clonePublic(one), back.frame).fields, clonePublic(two).fields);
  });

  test('objects that are equal but freshly built do not make a frame', () => {
    const base = publicBaseline(view());
    const next = view();
    next.draft = { order: ['p_0', 'p_1'], turn: 'p_0', picks: {}, skipsLeft: {} };
    const { frame } = publicDelta(base, next);
    assert.deepEqual(frame.draft, next.draft);
    const r2 = publicDelta(publicBaseline(next), view({ draft: { order: ['p_0', 'p_1'], turn: 'p_0', picks: {}, skipsLeft: {} } }));
    assert.equal(isEmptyDelta(r2.frame), true, 'an equal draft object is not a change');
  });
});

describe('incremental m.public: rules the two halves share', () => {
  test('a delta is refused without a baseline, a full frame never is', () => {
    const full = view();
    assert.deepEqual(applyPublic(null, full), { ok: true, state: clonePublic(full) });
    assert.deepEqual(applyPublic(null, { t: 'm.public', delta: true, phase: 'PREP' }), { ok: false, reason: 'no-base' });
    assert.equal(canMerge(emptyPublic(), { t: 'm.public', delta: true }), true, 'an empty baseline is still a baseline');
  });

  test('a malformed delta is refused (never applied half-way)', () => {
    const base = clonePublic(view());
    assert.equal(canMerge(base, { t: 'm.public', delta: true, players: [{ seat: 3 }] }), false);
    assert.deepEqual(applyPublic(base, { t: 'm.public', delta: true, players: [{ seat: 3 }] }), { ok: false, reason: 'bad-delta' });
    assert.deepEqual(applyPublic(base, { t: 'm.public', delta: true, fields: {} }), { ok: false, reason: 'bad-delta' });
    assert.deepEqual(applyPublic(base, { t: 'm.private', delta: true }), { ok: false, reason: 'bad-delta' });
    assert.deepEqual(applyPublic(base, null), { ok: false, reason: 'bad-delta' });
  });

  test('the merge never aliases the baseline or the frame', () => {
    const base = clonePublic(view());
    const before = JSON.stringify(base);
    const frame = { t: 'm.public', delta: true, players: [{ playerId: 'p_0', lp: 1 }], factions: ['C'] };
    const out = mergePublic(base, frame);
    assert.equal(JSON.stringify(base), before, 'the baseline is untouched');
    assert.notEqual(out.players, base.players, 'the row array is copied');
    assert.notEqual(out.factions, base.factions, 'a replaced array value is copied');
    assert.deepEqual(out.factions, ['C']);
    assert.equal(base.players[0].lp, 40, 'the baseline row is untouched');
    assert.equal(out.players[0].lp, 1);
  });
});
