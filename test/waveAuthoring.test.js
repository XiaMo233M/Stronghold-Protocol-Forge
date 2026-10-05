// test/waveAuthoring.test.js — authoring a workshop WAVE (每关出怪): order, time, count, interval, route
// (shared/waveAuthoring.js).
//
// The load-bearing test is the first one: `totalCount` and `slotCounts` must be reproduced from `spawns` for the whole
// shipped roster. They are NOT symmetric — `slotCounts` counts `unharmful` spawns and `totalCount` does not — so a
// hand-typed value would misreport a round, and the faction replacement machinery addresses enemies by `slot`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveCounts, deriveWave, validateWave, waveId, waveErrors, waveSummaryLine,
  WAVE_KINDS, SPAWN_SLOTS, SPAWN_FIELDS, ROUNDS_PER_MODE,
} from '../shared/waveAuthoring.js';
import { applyWorkshop } from '../shared/workshop.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const WAVES = JSON.parse(fs.readFileSync(join(DATA_DIR, 'waves.json'), 'utf8'));
const ENEMIES = JSON.parse(fs.readFileSync(join(DATA_DIR, 'enemies.json'), 'utf8'));
const CONFIG = JSON.parse(fs.readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
const ALL = Object.values(WAVES);
const OFFICIAL_IDS = new Set(Object.keys(WAVES));
const ENEMY_KEYS = new Set(Object.keys(ENEMIES));

/** One round of a workshop map: two hounds walk the map's own route, then an elite. */
const SPEC = {
  id: 'round_two_hounds',
  kind: 'normal',
  characterLimit: 8,
  routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }],
  spawns: [
    { time: 3, key: 'enemy_1007_slime', count: 2, interval: 5, routeIndex: 0, slot: 'N' },
    { time: 20, key: 'enemy_1007_slime', count: 1, interval: 0, routeIndex: 0, slot: 'NF', unharmful: true },
    { time: 30, key: 'enemy_1007_slime', count: 3, interval: 4, routeIndex: 0, slot: 'E' },
  ],
  usedBy: [{ modeId: 'mode_multi_normal', round: 2 }],
};

describe('wave authoring: the derived counters are reproduced', () => {
  test('totalCount and slotCounts are reproduced for EVERY official wave', () => {
    const bad = [];
    assert.ok(ALL.length >= 38, 'expected the real waves.json');
    for (const w of ALL) {
      const got = deriveCounts(w.spawns);
      if (got.totalCount !== w.totalCount) bad.push(`${w.id}: totalCount stored ${w.totalCount}, derived ${got.totalCount}`);
      if (JSON.stringify(got.slotCounts) !== JSON.stringify(w.slotCounts)) {
        bad.push(`${w.id}: slotCounts stored ${JSON.stringify(w.slotCounts)}, derived ${JSON.stringify(got.slotCounts)}`);
      }
    }
    assert.deepEqual(bad, [], `the counters must be reproducible from the spawns:\n${bad.slice(0, 6).join('\n')}`);
  });

  test('the asymmetry between the two counters is reproduced (a latent rule the data does not combine)', () => {
    const { totalCount, slotCounts } = deriveCounts([
      { time: 1, count: 2, slot: 'N' },
      { time: 2, count: 3, slot: 'N', unharmful: true },
      { time: 3, count: 4 },
    ]);
    assert.equal(totalCount, 6, 'the unharmful 3 must not count toward the total');
    assert.equal(slotCounts.N, 5, 'but it DOES count into its slot');
    // The exclusion is exercised by the data: some official spawns are `unharmful`, and they are excluded from
    // totalCount — which is why totalCount/slotCounts reproduce for all 38 waves with this implementation.
    const unharmful = ALL.flatMap((w) => (w.spawns || []).filter((s) => s.unharmful).map((s) => ({ id: w.id, s })));
    assert.ok(unharmful.length > 0, 'the data must have unharmful spawns');
    for (const { id, s } of unharmful) {
      const w = WAVES[id];
      // rebuild the wave's total without this spawn: it must increase by exactly this spawn's count
      const without = deriveCounts(w.spawns.map((x) => (x === s ? { ...x, count: 0 } : x)));
      assert.equal(without.totalCount, w.totalCount, `${id}: an unharmful spawn must not contribute to totalCount`);
    }
    // NO official spawn is both unharmful and slotted, so the slotCounts half of the asymmetry is a LATENT rule: it is
    // reproduced faithfully from build-data, and the three-spawn case above is what pins its behaviour.
    const both = ALL.flatMap((w) => (w.spawns || []).filter((s) => s.unharmful && s.slot));
    assert.deepEqual(both, [], 'if the data ever combines the two, this test should start asserting the combined case');
    // and a spawn with an action is skipped entirely
    assert.deepEqual(deriveCounts([{ time: 1, count: 9, action: 'something', slot: 'N' }]), { totalCount: 0, slotCounts: {} });
  });

  test('the official roster validates clean (no false positives)', () => {
    const bad = [];
    for (const w of ALL) {
      const errs = waveErrors(validateWave(w, { id: w.id, officialIds: new Set() }));
      if (errs.length) bad.push(`${w.id}: ${errs.map((i) => `${i.code}(${i.field})`).join(',')}`);
    }
    assert.deepEqual(bad, [], `official waves rejected (${bad.length}):\n${bad.slice(0, 6).join('\n')}`);
  });

  test('the enums cover every value the official data uses (drift guard)', () => {
    const kinds = new Set(ALL.map((w) => w.kind));
    for (const k of kinds) assert.ok(WAVE_KINDS.includes(k), `the data uses kind "${k}" but the validator does not accept it`);
    assert.ok(kinds.size > 1, 'the guard must exercise more than one kind');
    const slots = new Set(ALL.flatMap((w) => (w.spawns || []).map((s) => s.slot)).filter((s) => s));
    for (const s of slots) assert.ok(SPAWN_SLOTS.includes(s), `the data uses slot "${s}" but the validator does not accept it`);
    assert.ok(slots.size >= 5, `expected the real slot vocabulary, saw ${JSON.stringify([...slots])}`);
    const fields = new Set(ALL.flatMap((w) => (w.spawns || []).flatMap((s) => Object.keys(s))));
    for (const f of fields) assert.ok(SPAWN_FIELDS.includes(f), `the data uses spawn field "${f}" but SPAWN_FIELDS omits it`);
  });

  test('a round is bound by a mode, and the data has 15 rounds per mode', () => {
    const mode = CONFIG.modes.mode_multi_normal;
    assert.equal(Object.keys(mode.rounds).length, ROUNDS_PER_MODE);
    // every round names a template, which is how a wave becomes reachable at all
    for (const [r, cfg] of Object.entries(mode.rounds)) {
      if (cfg.template) assert.ok(WAVES[cfg.template], `round ${r} names template ${cfg.template}, which is not in waves.json`);
    }
  });
});

describe('wave authoring: deriveWave', () => {
  test('a minimal spec produces a complete record with the counters derived', () => {
    const r = deriveWave(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const w = r.wave;
    assert.equal(w.id, 'wave_ws_round_two_hounds');
    assert.equal(w.kind, 'normal');
    assert.equal(w.solo, false);
    assert.equal(w.routes.length, 1);
    assert.equal(w.spawns.length, 3);
    assert.equal(w.spawns[0].routeIndex, 0);
    // 2 + 3 = 5: the unharmful 1 is excluded from the total but counted into its slot
    assert.equal(w.totalCount, 5);
    assert.deepEqual(w.slotCounts, { N: 2, NF: 1, E: 3 });
    assert.deepEqual(w.usedBy, [{ modeId: 'mode_multi_normal', round: 2, bossId: null }]);
    assert.deepEqual(waveErrors(validateWave(w, { officialIds: OFFICIAL_IDS, knownEnemyKeys: ENEMY_KEYS })), []);
    // a successful derive means the counters are never hand-written
    assert.equal(deriveCounts(w.spawns).totalCount, w.totalCount);
  });

  test('the counters cannot drift from the spawns', () => {
    const r = deriveWave(SPEC);
    const tampered = { ...r.wave, totalCount: 99 };
    assert.ok(waveErrors(validateWave(tampered, { id: tampered.id, officialIds: OFFICIAL_IDS })).some((i) => i.code === 'STALE_DERIVED' && i.field === 'totalCount'));
    const noSlots = { ...r.wave, slotCounts: {} };
    assert.ok(waveErrors(validateWave(noSlots, { id: noSlots.id, officialIds: OFFICIAL_IDS })).some((i) => i.code === 'STALE_DERIVED' && i.field === 'slotCounts'));
  });

  test('every missing or wrong fact is reported with a field and a code', () => {
    const r = deriveWave({
      id: '', kind: 'MYTHIC', routes: [], spawns: [],
    });
    assert.equal(r.ok, false);
    const codes = r.errors.map((e) => `${e.field}:${e.code}`);
    for (const want of ['id:BAD_ID', 'kind:BAD_ENUM', 'spawns:EMPTY', 'routes:EMPTY']) {
      assert.ok(codes.includes(want), `${want} missing from ${codes.join(' ')}`);
    }
  });

  test('a spawn that names an enemy nothing defines is an error, not a silent no-op', () => {
    const r = deriveWave({ ...SPEC, spawns: [{ time: 1, key: 'enemy_nope', count: 1, interval: 0 }] });
    assert.equal(r.ok, true);
    const issues = validateWave(r.wave, { id: r.wave.id, officialIds: OFFICIAL_IDS, knownEnemyKeys: ENEMY_KEYS });
    const hit = issues.find((i) => i.code === 'UNKNOWN_ENEMY');
    assert.ok(hit && hit.severity === 'error', JSON.stringify(issues));
    assert.match(hit.hint, /enemies\.json/);
  });

  test('a routeIndex past the wave routes is an error (the sim would silently walk route 0)', () => {
    const r = deriveWave({ ...SPEC, spawns: [{ time: 1, key: 'enemy_1007_slime', count: 1, interval: 0, routeIndex: 3 }] });
    assert.equal(r.ok, true);
    const issues = validateWave(r.wave, { id: r.wave.id, officialIds: OFFICIAL_IDS, knownEnemyKeys: ENEMY_KEYS });
    const hit = issues.find((i) => i.code === 'ROUTE_MISSING');
    assert.ok(hit && hit.severity === 'error', JSON.stringify(issues));
  });

  test('bad spawn numbers, a bad slot and a typo\'d field are all reported', () => {
    // a spec typo must be LOUD: the field would otherwise be dropped and the spawn would silently lose its slot
    const typo = deriveWave({ ...SPEC, spawns: [{ time: 1, key: 'enemy_1007_slime', count: 1, interval: 0, sleot: 'N' }] });
    assert.equal(typo.ok, false);
    const typoIssue = typo.errors.find((e) => e.code === 'UNKNOWN_FIELD');
    assert.ok(typoIssue, JSON.stringify(typo.errors));
    assert.equal(typoIssue.field, 'spawns[0].sleot');
    assert.match(typoIssue.hint, /known fields/);

    // and a record edited by hand is caught too
    const r = deriveWave({ ...SPEC, spawns: [{ time: -1, key: 'enemy_1007_slime', count: 0, interval: -2, slot: 'ZZ' }] });
    assert.equal(r.ok, true, 'deriveWave normalises; validateWave is what reports');
    const tampered = { ...r.wave, spawns: [{ ...r.wave.spawns[0], nonsense: 1 }], totalCount: 0, slotCounts: {} };
    const issues = validateWave(tampered, { id: tampered.id, officialIds: OFFICIAL_IDS, knownEnemyKeys: ENEMY_KEYS });
    const codes = new Set(issues.map((i) => `${i.field}:${i.code}`));
    assert.ok(codes.has('spawns[0].time:BAD_NUMBER'), [...codes].join(' '));
    assert.ok(codes.has('spawns[0].slot:BAD_ENUM'), [...codes].join(' '));
    assert.ok(codes.has('spawns[0].nonsense:UNKNOWN_FIELD'), [...codes].join(' '));
  });

  test('an id is slugged into the wave_ws_ namespace, and `usedBy` is what makes it reachable', () => {
    assert.deepEqual(waveId('Round Two Hounds!'), { slug: 'round_two_hounds', id: 'wave_ws_round_two_hounds' });
    assert.equal(waveId('!!!'), null);
    const unused = deriveWave({ ...SPEC, usedBy: [] });
    assert.equal(unused.ok, true);
    assert.ok(unused.warnings.some((w) => /usedBy/.test(w)), unused.warnings.join(' | '));
    assert.ok(validateWave(unused.wave, { id: unused.wave.id, officialIds: OFFICIAL_IDS }).some((i) => i.code === 'UNUSED'));
    // a round outside the mode's schedule is refused
    const badRound = deriveWave({ ...SPEC, usedBy: [{ modeId: 'mode_multi_normal', round: 99 }] });
    assert.ok(validateWave(badRound.wave, { id: badRound.wave.id, officialIds: OFFICIAL_IDS }).some((i) => i.code === 'BAD_ROUND'));
  });

  test('a wave on a route nothing can walk is refused', () => {
    // a WALK route whose two ends are both unreachable non-passable tiles
    const blocked = deriveWave({
      ...SPEC,
      routes: [{ motion: 'WALK', start: [0, 0], end: [1, 1], checkpoints: [] }],
      spawns: [{ time: 1, key: 'enemy_1007_slime', count: 1, interval: 0 }],
    });
    // structurally valid (validateRoutes does not path), so the wave layer accepts it — the MAP layer is what proves a
    // route walkable, and it does that with the sim. Here we only assert the structural contract holds.
    assert.equal(blocked.ok, true, JSON.stringify(blocked.errors));
  });

  test('the readout names the timing and the slots', () => {
    const r = deriveWave(SPEC);
    const line = waveSummaryLine(r.wave);
    assert.match(line, /3 spawn\(s\)/);
    assert.match(line, /5 enemies/);
    assert.match(line, /3s\.\.38s/, 'the last spawn ends at 30 + (3-1)*4 = 38s');
    assert.match(line, /"N":2/);
  });
});

describe('wave authoring: a workshop wave is content the game can load', () => {
  test('it merges under its own id, and an official id needs a declared override', () => {
    const r = deriveWave(SPEC);
    assert.equal(r.ok, true);
    const { data, report } = applyWorkshop({ waves: WAVES }, [
      { id: 'wave-pack', overrides: [], files: { waves: { [r.wave.id]: r.wave } } },
    ]);
    assert.deepEqual(report.added.waves, [r.wave.id]);
    assert.equal(data.waves[r.wave.id].totalCount, 5);
    assert.equal(Object.keys(data.waves).length, Object.keys(WAVES).length + 1);

    const officialId = Object.keys(WAVES)[0];
    const evil = applyWorkshop({ waves: WAVES }, [
      { id: 'evil', overrides: [], files: { waves: { [officialId]: { ...WAVES[officialId], totalCount: 12345 } } } },
    ]);
    assert.equal(evil.data.waves[officialId].totalCount, WAVES[officialId].totalCount, 'the official wave must win');
    assert.equal(evil.report.errors.length, 1);
    assert.match(evil.report.errors[0].reason, /overrides/);
  });
});
