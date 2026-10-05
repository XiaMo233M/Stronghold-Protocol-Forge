// test/stageAuthoring.test.js — authoring a workshop STAGE (map): shared/stageAuthoring.js + server/stageAuthoring.js.
//
// The load-bearing test is the first one: the derived tables of every OFFICIAL stage must be reproduced exactly from
// its rows/legend/devices. If that holds, the map editor's foundation is the sim's own arithmetic; if it does not, then
// a hand-drawn map would send enemies down routes the map does not have.
//
// The second thing pinned here is that a workshop stage can actually be SELECTED: a stage only enters a match when the
// mode's `stages` list names it, and `config` is deliberately not workshop-contributable, so the loader appends a
// stage's own `modes` entries instead (shared/workshop.js linkWorkshopStages).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { deriveGroundPaths, deriveStage, deriveRoutePaths, validateStageRecord } from '../server/stageAuthoring.js';
import {
  deriveDeployTiles, validateStage, validateRoutes, stageErrors, normalizeRows, glyphUsage, GATE_PAIRS, TILE_PALETTE,
  STAGE_ROWS, STAGE_COLS, HEIGHT_VALUES, BUILDABLE_VALUES, PASSABLE_VALUES, ROUTE_MOTIONS,
} from '../shared/stageAuthoring.js';
import { applyWorkshop } from '../shared/workshop.js';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const STAGES = JSON.parse(fs.readFileSync(join(DATA_DIR, 'stages.json'), 'utf8'));
const CONFIG = JSON.parse(fs.readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));

/** An all-road 19×21 map with an enemy gate and an objective, so paths and deploy tiles both derive. */
const GLYPH_LEGEND = {
  r: { tileKey: 'tile_road', height: 'LOW', buildable: 'ALL', passable: 'ALL', groundPassable: true, flyPassable: true, special: null, bb: {} },
  S: { tileKey: 'tile_start', height: 'LOW', buildable: 'NONE', passable: 'ALL', groundPassable: true, flyPassable: true, special: 'start', bb: {} },
  E: { tileKey: 'tile_end', height: 'LOW', buildable: 'NONE', passable: 'ALL', groundPassable: true, flyPassable: true, special: 'end', bb: {} },
};
const SPEC = {
  id: 'ws_test_map',
  name: '工坊测试图',
  weight: 50,
  modes: ['mode_multi_normal'],
  rows: Array.from({ length: STAGE_ROWS }, (_, r) => (r === 9 ? `S${'r'.repeat(STAGE_COLS - 2)}E` : 'r'.repeat(STAGE_COLS))),
  tiles: GLYPH_LEGEND,
  devices: [],
};

describe('stage authoring: the derivation reproduces the official data', () => {
  test('every official stage: groundPaths, groundPathsWithDevices and deployTiles are reproduced exactly', () => {
    const failures = [];
    assert.ok(Object.keys(STAGES).length >= 11, 'expected the real stages.json');
    for (const [id, stage] of Object.entries(STAGES)) {
      // A stored stage feeds the derivation directly: rows + tiles(legend) + devices.
      const derived = deriveGroundPaths(stage);
      if (JSON.stringify(derived.groundPaths) !== JSON.stringify(stage.groundPaths)) {
        const a = Object.keys(stage.groundPaths || {});
        const b = Object.keys(derived.groundPaths);
        failures.push(`${id}: groundPaths differ (stored ${a.length} routes, derived ${b.length}; first mismatch ${a.find((k, i) => JSON.stringify(stage.groundPaths[k]) !== JSON.stringify(derived.groundPaths[k])) || b.find((k) => !a.includes(k))})`);
      }
      if (JSON.stringify(derived.groundPathsWithDevices) !== JSON.stringify(stage.groundPathsWithDevices)) {
        failures.push(`${id}: groundPathsWithDevices differ`);
      }
      const deploy = deriveDeployTiles(normalizeRows(stage.rows), stage.tiles, stage.devices);
      if (JSON.stringify(deploy) !== JSON.stringify(stage.deployTiles)) {
        failures.push(`${id}: deployTiles differ (stored normal ${stage.deployTiles?.normal?.melee?.length ?? '?'} melee, derived ${deploy.normal.melee.length})`);
      }
    }
    assert.deepEqual(failures, [], `the derivation must reproduce data/stages.json:\n${failures.join('\n')}`);
  });

  test('the validator accepts the official stages (no false positives)', () => {
    const bad = [];
    for (const [id, stage] of Object.entries(STAGES)) {
      const errs = stageErrors(validateStageRecord(stage, { id, officialIds: new Set() }));
      if (errs.length) bad.push(`${id}: ${errs.map((e) => `${e.code}(${e.field})`).join(',')}`);
    }
    assert.deepEqual(bad, [], `official stages rejected:\n${bad.join('\n')}`);
  });

  test('the 12 route pairs are the ones the data uses', () => {
    assert.equal(GATE_PAIRS.length, 12);
    assert.deepEqual(GATE_PAIRS[0], [[9, 10], [9, 2]]);
    assert.deepEqual(GATE_PAIRS[11], [[5, 10], [1, 17]]);
  });

  test('the legend vocabularies cover every value the official data uses (drift guard)', () => {
    // The lesson from the PROFESSIONS bug: assert against the DATA, not against a length or a memory. `FLY_ONLY` is
    // what the stored `passableMask` actually says, and the first version of this validator invented `FLY` instead.
    const lists = { height: HEIGHT_VALUES, buildable: BUILDABLE_VALUES, passable: PASSABLE_VALUES };
    const seen = { height: new Set(), buildable: new Set(), passable: new Set() };
    for (const stage of Object.values(STAGES)) {
      for (const t of Object.values(stage.tiles || {})) {
        for (const key of Object.keys(seen)) if (t[key] !== undefined) seen[key].add(t[key]);
      }
    }
    for (const [key, values] of Object.entries(seen)) {
      assert.ok(values.size > 0, `${key} was not exercised — the guard is not testing anything`);
      for (const v of values) {
        assert.ok(lists[key].includes(v), `the official data uses ${key}="${v}" but the validator does not accept it`);
      }
    }
  });
});

describe('stage authoring: deriving a new map', () => {
  test('a drawn map derives its paths, deploy tiles and defaults', () => {
    const r = deriveStage(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const s = r.stage;
    assert.equal(s.id, 'ws_test_map');
    assert.deepEqual(s.size, [STAGE_ROWS, STAGE_COLS]);
    assert.equal(s.rows.length, STAGE_ROWS);
    assert.equal(s.active, true);
    assert.deepEqual(s.modes, ['mode_multi_normal']);
    assert.deepEqual(s.options, { characterLimit: 8, moveMultiplier: 0.5 });
    // the all-road normal rect (rows 9-12, cols 2-10) is all LOW+ALL → melee-deployable
    assert.equal(s.deployTiles.normal.melee.length, 4 * 9);
    // at least one ground route derived from the gate to the objective area
    assert.ok(Object.keys(s.groundPaths).length > 0, 'no ground route derived');
    assert.ok(Object.keys(s.groundPathsWithDevices).length > 0);
    assert.deepEqual(stageErrors(validateStageRecord(s, { id: s.id, officialIds: new Set() })), []);
  });

  test('a stage with no `modes` still derives, but the author is warned it can never be selected', () => {
    const r = deriveStage({ ...SPEC, modes: [] });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /no `modes`/.test(w)), r.warnings.join(' | '));
  });

  test('an unplayable grid is refused with a field and a code', () => {
    const short = deriveStage({ ...SPEC, rows: ['rrrr'] });
    assert.equal(short.ok, false);
    assert.ok(short.errors.some((e) => e.code === 'BAD_SIZE'));

    const unknownGlyph = deriveStage({ ...SPEC, rows: Array.from({ length: STAGE_ROWS }, () => 'Z'.repeat(STAGE_COLS)) });
    assert.equal(unknownGlyph.ok, false);
    assert.ok(unknownGlyph.errors.some((e) => e.code === 'GLYPH_UNDEFINED'), JSON.stringify(unknownGlyph.errors));

    const badEnum = deriveStage({ ...SPEC, tiles: { ...GLYPH_LEGEND, r: { ...GLYPH_LEGEND.r, buildable: 'SOMETIMES' } } });
    assert.equal(badEnum.ok, false);
    assert.ok(badEnum.errors.some((e) => e.code === 'BAD_ENUM'));
  });

  test('rows may be given as one newline-separated string', () => {
    const rows = SPEC.rows.join('\n');
    const r = deriveStage({ ...SPEC, rows });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.stage.rows, SPEC.rows);
  });

  test('a stage id that collides with the official data is an error with the fix in the hint', () => {
    const officialId = Object.keys(STAGES)[0];
    const issues = validateStage({ ...SPEC, id: officialId }, { officialIds: new Set(Object.keys(STAGES)) });
    const hit = issues.find((i) => i.code === 'OFFICIAL_ID_COLLISION');
    assert.ok(hit && hit.severity === 'error');
    assert.match(hit.hint, /overrides/);
  });

  test('a device outside the grid, and a missing gate/objective, are reported', () => {
    const issues = validateStage({ ...SPEC, rows: SPEC.rows.map((l) => l.replace('S', 'r').replace('E', 'r')), devices: [{ key: 'trap_x', pos: [99, 0], role: 'crate' }] }, { officialIds: new Set() });
    const codes = new Set(issues.map((i) => i.code));
    assert.ok(codes.has('OUT_OF_BOUNDS'), [...codes].join(' '));
    assert.ok(codes.has('NO_GATE'), [...codes].join(' '));
    assert.ok(codes.has('NO_GOAL'), [...codes].join(' '));
  });

  test('the palette covers the glyphs a stage is normally drawn with', () => {
    const glyphs = TILE_PALETTE.map((t) => t.glyph);
    for (const g of ['r', 'f', '#', 'S', 'E', 'm', 'd']) assert.ok(glyphs.includes(g), `palette missing ${g}`);
    assert.equal(new Set(glyphs).size, glyphs.length, 'palette glyphs must be unique');
    for (const t of TILE_PALETTE) assert.ok(t.label && t.tileKey && t.height && t.buildable, JSON.stringify(t));
  });

  test('glyphUsage counts what the rows actually use', () => {
    const u = glyphUsage(SPEC.rows);
    assert.equal(u.get('S'), 1);
    assert.equal(u.get('E'), 1);
    assert.equal(u.get('r'), STAGE_ROWS * STAGE_COLS - 2);
  });
});

describe('stage authoring: the routes (出生点 → 防守点)', () => {
  const GATE = { r: 9, c: 0 };
  const GOAL = { r: 9, c: STAGE_COLS - 1 };
  const ROUTE = { motion: 'WALK', start: [GATE.r, GATE.c], end: [GOAL.r, GOAL.c], checkpoints: [] };

  test('a WALK route is walked on the sim flow field, a FLY route straight between its points', () => {
    const walk = deriveRoutePaths(SPEC, [ROUTE]);
    assert.equal(walk.length, 1);
    assert.equal(walk[0].motion, 'WALK');
    assert.ok(Array.isArray(walk[0].path) && walk[0].path.length >= 2, JSON.stringify(walk[0]));
    assert.deepEqual(walk[0].path[0], [GATE.r, GATE.c], 'the path starts at the route start');
    assert.deepEqual(walk[0].path[walk[0].path.length - 1], [GOAL.r, GOAL.c], 'and ends at the route end');

    const fly = deriveRoutePaths(SPEC, [{ motion: 'FLY', start: [GATE.r, GATE.c], end: [GOAL.r, GOAL.c], checkpoints: [[0, 10]] }]);
    assert.deepEqual(fly[0].path, [[GATE.r, GATE.c], [0, 10], [GOAL.r, GOAL.c]], 'a FLY route is its own polyline');
  });

  test('a route nothing can walk is refused, with the reason', () => {
    // a wall splitting the gate from the objective: there is no ground way across
    const walled = Array.from({ length: STAGE_ROWS }, () => `${'r'.repeat(10)}X${'r'.repeat(10)}`);
    walled[9] = `S${'r'.repeat(9)}X${'r'.repeat(9)}E`;
    assert.equal(walled[9].length, STAGE_COLS);
    // the wall glyph must exist in the legend, or the validator rightly reports an undefined glyph first
    const tiles = { ...GLYPH_LEGEND, X: { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE', groundPassable: false, flyPassable: false, special: null, bb: {} } };
    const spec = { ...SPEC, rows: walled, tiles };
    const derived = deriveStage({ ...spec, routes: [ROUTE] });
    assert.equal(derived.ok, false);
    assert.ok(derived.errors.some((e) => e.code === 'ROUTE_NOPATH'), JSON.stringify(derived.errors));
    // and the raw derivation says why
    assert.equal(deriveRoutePaths(spec, [ROUTE])[0].path, null);
    assert.match(deriveRoutePaths(spec, [ROUTE])[0].reason, /no ground route/);
  });

  test('routes are validated structurally, and a gate/objective mismatch is only a warning', () => {
    const issues = validateRoutes([
      { motion: 'SWIM', start: [0, 0], end: [1, 1], checkpoints: [] },
      { motion: 'WALK', start: [99, 0], end: [1, 1], checkpoints: [[0, 999]] },
      { motion: 'WALK', start: [5, 5], end: [6, 6], checkpoints: [] },
    ], SPEC.rows, SPEC.tiles);
    const codes = issues.map((i) => i.code);
    assert.ok(codes.includes('BAD_ENUM'), codes.join(' '));
    assert.equal(issues.filter((i) => i.code === 'BAD_POS').length, 2, codes.join(' '));
    const gate = issues.find((i) => i.code === 'START_NOT_ON_GATE');
    const goal = issues.find((i) => i.code === 'END_NOT_ON_GOAL');
    assert.ok(gate && gate.severity === 'warning', 'routing from a non-gate tile is legal (teleporters, boss spawns)');
    assert.ok(goal && goal.severity === 'warning');
    assert.equal(ROUTE_MOTIONS.length, 2);
  });

  test('a route between the painted gate and objective is silent', () => {
    assert.deepEqual(validateRoutes([ROUTE], SPEC.rows, SPEC.tiles), []);
  });

  test('deriveStage reports the route paths and does NOT write routes into the record', () => {
    const r = deriveStage({ ...SPEC, routes: [ROUTE, { motion: 'FLY', start: [9, 0], end: [9, 20], checkpoints: [] }] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.routePaths.length, 2);
    assert.ok(r.routePaths.every((p) => p.path));
    // the stage RECORD has no routes field: the engine reads routes from the wave template
    assert.equal(Object.hasOwn(r.stage, 'routes'), false, 'routes belong to the wave, not to the stage record');
    // and the record still validates as a record
    assert.deepEqual(stageErrors(validateStageRecord(r.stage, { id: r.stage.id, officialIds: new Set() })), []);
  });

  test('a checkpoint may use the object shape the engine also accepts', () => {
    const r = deriveRoutePaths(SPEC, [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [{ type: 'MOVE', pos: [9, 10] }] }]);
    assert.ok(Array.isArray(r[0].path));
    assert.deepEqual(r[0].path[0], [9, 0]);
    assert.ok(r[0].path.some(([rr, cc]) => rr === 9 && cc === 10), 'the path passes through the checkpoint');
    // a malformed checkpoint is reported rather than silently dropped
    const bad = validateRoutes([{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [{ pos: [99, 99] }] }], SPEC.rows, SPEC.tiles);
    assert.ok(bad.some((i) => i.code === 'BAD_POS'), JSON.stringify(bad));
  });
});

describe('stage authoring: a workshop stage becomes selectable', () => {
  test('the stale-derived check catches rows edited after the paths were computed', () => {
    const r = deriveStage(SPEC);
    assert.equal(r.ok, true);
    // move a road tile to a wall: the stored paths are now a route the map no longer has
    const edited = { ...r.stage, rows: r.stage.rows.map((l, i) => (i === 11 ? l.slice(0, 5) + 'X' + l.slice(6) : l)) };
    const issues = validateStageRecord(edited, { id: edited.id, officialIds: new Set() });
    assert.ok(issues.some((i) => i.code === 'STALE_DERIVED'), issues.map((i) => i.code).join(' '));
  });

  test('a missing derived table is reported as missing, not as valid', () => {
    const r = deriveStage(SPEC);
    const noPaths = { ...r.stage, groundPaths: undefined, groundPathsWithDevices: undefined };
    const issues = validateStageRecord(noPaths, { id: r.stage.id, officialIds: new Set() });
    assert.equal(issues.filter((i) => i.code === 'MISSING_DERIVED').length, 2, issues.map((i) => i.code).join(' '));
  });

  test('the loader appends a workshop stage to its modes (and never rewrites config)', () => {
    const r = deriveStage(SPEC);
    assert.equal(r.ok, true);
    // config is not workshop-contributable: the pack ships only stages.json
    const { data, report } = applyWorkshop({ stages: {}, config: structuredClone(CONFIG) }, [
      { id: 'stage-pack', name: 'Stage', overrides: [], files: { stages: { [r.stage.id]: r.stage } } },
    ]);
    assert.deepEqual(report.added.stages, [r.stage.id]);
    assert.deepEqual(report.linkedStages, [`${r.stage.id} -> mode_multi_normal`]);
    const mode = data.config.modes.mode_multi_normal;
    assert.ok(mode.stages.includes(r.stage.id), 'the mode must list the new stage');
    // …and nothing else in config was touched
    const before = structuredClone(CONFIG);
    for (const [modeId, m] of Object.entries(before.modes)) {
      const after = data.config.modes[modeId];
      assert.deepEqual(after.stages.filter((x) => x !== r.stage.id), m.stages, `mode ${modeId} stage list was altered`);
      assert.deepEqual({ ...after, stages: null }, { ...m, stages: null }, `mode ${modeId} was modified beyond its stage list`);
    }
  });

  test('end to end: loadData merges the stage and the engine can resolve it', () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-stage-'));
    const wsRoot = join(tmp, 'ws');
    const packDir = join(wsRoot, 'stage-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({ id: 'stage-pack', name: 'Stage', version: '0.1.0', content: ['stages'], overrides: [] }));
    const r = deriveStage(SPEC);
    assert.equal(r.ok, true);
    fs.writeFileSync(join(packDir, 'stages.json'), JSON.stringify({ [r.stage.id]: r.stage }));
    try {
      const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
      assert.ok(data.stages['ws_test_map'], 'the stage must reach the merged data');
      assert.ok(data.config.modes.mode_multi_normal.stages.includes('ws_test_map'), 'the mode must list it');
      const gd = new GameData(data, 'mode_multi_normal');
      const stage = gd.stage('ws_test_map');
      assert.ok(stage, 'GameData must resolve the workshop stage');
      assert.equal(stage.rows.length, STAGE_ROWS);
      // the derived tables survive the merge and are what the engine sees
      assert.deepEqual(stage.groundPaths, r.stage.groundPaths);
      assert.ok(stage.deployTiles.normal.melee.length > 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an official stage replaced without a declared override is refused (data and stage rules agree)', () => {
    const officialId = Object.keys(STAGES)[0];
    const { data, report } = applyWorkshop({ stages: STAGES }, [
      { id: 'evil', overrides: [], files: { stages: { [officialId]: { ...STAGES[officialId], name: 'hijacked' } } } },
    ]);
    assert.equal(data.stages[officialId].name, STAGES[officialId].name, 'the official stage must win');
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].reason, /overrides/);
  });
});
