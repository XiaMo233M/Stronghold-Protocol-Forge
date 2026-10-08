// test/stageRules.test.js — the map authoring RULES of v0.9.0: what a new map derives, and what an author may say.
//
// Four things are pinned here, each because getting it wrong is silent in game:
//   1. `opts.paths` — a new map has NO 寻路 unless the author asks (业主口径: 自动寻路只能点按钮画). data/stages.json is
//      unaffected: the official tables stay reproduced exactly by test/stageAuthoring.test.js.
//   2. `kind` / `helpers` — a 联防图 declares itself, and nothing else may carry a helpers count.
//   3. the tile rules — LOW+RANGED is a 远程位 (the engine's board.js:106 rule the shared copy was missing), a map may
//      opt into 地面也能放高台 (`options.groundHighGround`), and 深水区 is never deployable.
//   4. 空气 (`-`) — the world outside the map: it must be mechanically IDENTICAL to 阻隔 (`X`), presentation aside.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveStage, validateStageRecord } from '../server/stageAuthoring.js';
import { normalizeLegendEntry, DEPLOY_REFUSED_TILES as ENGINE_REFUSED } from '../server/sim/grid.js';
import {
  TILE_PALETTE, DEPLOY_REFUSED_TILES, groundRuleOf, sampleStageSpec, SAMPLE_STAGE_SPEC,
  deriveDeployTiles, validateStage, stageErrors, STAGE_ROWS, STAGE_COLS,
} from '../shared/stageAuthoring.js';

const GLYPH_LEGEND = {
  r: { tileKey: 'tile_road', height: 'LOW', buildable: 'ALL', passable: 'ALL', groundPassable: true, flyPassable: true, special: null, bb: {} },
  f: { tileKey: 'tile_floor', height: 'LOW', buildable: 'NONE', passable: 'ALL', groundPassable: true, flyPassable: true, special: null, bb: {} },
  x: { tileKey: 'tile_deepsea', height: 'LOW', buildable: 'NONE', passable: 'ALL', groundPassable: true, flyPassable: true, special: 'deepsea', terrain: 'deepsea', bb: {} },
  h: { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'RANGED', passable: 'FLY', groundPassable: false, flyPassable: true, special: null, bb: {} },
  X: { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE', groundPassable: false, flyPassable: false, special: null, bb: {} },
  S: { tileKey: 'tile_start', height: 'LOW', buildable: 'NONE', passable: 'ALL', groundPassable: true, flyPassable: true, special: 'start', bb: {} },
  E: { tileKey: 'tile_end', height: 'LOW', buildable: 'NONE', passable: 'ALL', groundPassable: true, flyPassable: true, special: 'end', bb: {} },
};

/** An all-road map with a gate and an objective — the shape a new map starts from, and NO routes. */
const SPEC = {
  id: 'ws_rules_map',
  name: '规则测试图',
  weight: 50,
  modes: ['mode_multi_normal'],
  rows: Array.from({ length: STAGE_ROWS }, (_, r) => (r === 9 ? `S${'r'.repeat(STAGE_COLS - 2)}E` : 'r'.repeat(STAGE_COLS))),
  tiles: GLYPH_LEGEND,
  devices: [],
};
const ROUTE = { motion: 'WALK', start: [9, 0], end: [9, STAGE_COLS - 1], checkpoints: [] };

const tileKeys = (tiles) => tiles.map(([r, c]) => `${r},${c}`).sort();

describe('stage rules: 寻路 is opt-in (opts.paths)', () => {
  test('a new map with no drawn route carries NO derived paths, and that is not a warning', () => {
    const r = deriveStage(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.stage.groundPaths, {}, 'no drawn route must mean no derived ground routes');
    assert.deepEqual(r.stage.groundPathsWithDevices, {});
    // "one route could not be computed" is only worth saying when a route was asked for: the absence of the 12 official
    // gate pairs on a hand-drawn map is the normal case, not a defect
    assert.deepEqual(r.warnings.filter((w) => /ground route/.test(w)), [], r.warnings.join(' | '));
  });

  test('an explicit paths:false leaves `groundPaths` in the record but empty (readers may keep iterating it)', () => {
    const r = deriveStage({ ...SPEC, routes: [ROUTE] }, { paths: false });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.stage.groundPaths, {});
    assert.deepEqual(r.stage.groundPathsWithDevices, {});
    // the authored route itself is still walked by the sim: paths is about the 12 GATE pairs, not about the routes
    assert.equal(r.routePaths.length, 1);
    assert.ok(r.routePaths[0].path, JSON.stringify(r.routePaths[0]));
  });

  test('an explicit paths:true derives the official gate pairs', () => {
    const r = deriveStage(SPEC, { paths: true });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(Object.keys(r.stage.groundPaths).length > 0, 'the sim must derive ground routes when asked');
    assert.deepEqual(Object.keys(r.stage.groundPaths), Object.keys(r.stage.groundPathsWithDevices));
    assert.deepEqual(stageErrors(validateStageRecord(r.stage, { id: r.stage.id, officialIds: new Set() })), []);
  });

  test('the default follows the drawn routes: any authored route turns 寻路 on', () => {
    const r = deriveStage({ ...SPEC, routes: [ROUTE] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(Object.keys(r.stage.groundPaths).length > 0, 'a map that drew a route keeps the derived gate paths');
  });

  test('an empty routes array is the same as no routes at all', () => {
    const r = deriveStage({ ...SPEC, routes: [] });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.stage.groundPaths, {});
  });

  test('a record derived without 寻路 still validates as a record (a route-less map is not a broken map)', () => {
    const r = deriveStage(SPEC);
    assert.deepEqual(stageErrors(validateStageRecord(r.stage, { id: r.stage.id, officialIds: new Set() })), []);
    // …and re-deriving it a second time (what the editor does on every save) is still clean
    const again = deriveStage(r.stage, { paths: false });
    assert.deepEqual(stageErrors(validateStageRecord(again.stage, { id: again.stage.id, officialIds: new Set() })), []);
  });

  test('a stale non-empty table is still an error (the check was not weakened into uselessness)', () => {
    const r = deriveStage(SPEC, { paths: true });
    const edited = { ...r.stage, rows: r.stage.rows.map((l, i) => (i === 11 ? `${l.slice(0, 5)}X${l.slice(6)}` : l)) };
    const issues = validateStageRecord(edited, { id: edited.id, officialIds: new Set() });
    assert.ok(issues.some((i) => i.code === 'STALE_DERIVED'), issues.map((i) => i.code).join(' '));
    // and the missing-table error is untouched
    const gone = { ...r.stage, groundPaths: undefined, groundPathsWithDevices: undefined };
    assert.equal(validateStageRecord(gone, { id: gone.id, officialIds: new Set() }).filter((i) => i.code === 'MISSING_DERIVED').length, 2);
  });
});

describe('stage rules: 联防图 declares itself (kind / helpers)', () => {
  test('kind:unit passes through with its helpers, and helpers defaults to 2', () => {
    const one = deriveStage({ ...SPEC, kind: 'unite', helpers: 1 });
    assert.equal(one.ok, true, JSON.stringify(one.errors));
    assert.equal(one.stage.kind, 'unite');
    assert.equal(one.stage.helpers, 1);
    const auto = deriveStage({ ...SPEC, kind: 'unite' });
    assert.equal(auto.ok, true, JSON.stringify(auto.errors));
    assert.equal(auto.stage.helpers, 2, 'a unite map that does not say gets the default 2');
  });

  test('a solo map carries neither field, and the record shape is unchanged', () => {
    const r = deriveStage(SPEC);
    assert.equal(Object.hasOwn(r.stage, 'kind'), false);
    assert.equal(Object.hasOwn(r.stage, 'helpers'), false);
  });

  test('bad kind / helpers values are refused with the field and the code', () => {
    const cases = [
      [{ kind: 'normal' }, 'kind', 'BAD_KIND'],
      [{ kind: 'unite', helpers: 0 }, 'helpers', 'BAD_HELPERS'],
      [{ kind: 'unite', helpers: 3 }, 'helpers', 'BAD_HELPERS'],
      [{ kind: 'unite', helpers: 1.5 }, 'helpers', 'BAD_HELPERS'],
      // helpers on a map that is not a 联防图: it would be metadata nothing reads
      [{ helpers: 2 }, 'helpers', 'HELPERS_WITHOUT_KIND'],
    ];
    for (const [patch, field, code] of cases) {
      const r = deriveStage({ ...SPEC, ...patch });
      assert.equal(r.ok, false, `${JSON.stringify(patch)} must be refused`);
      assert.ok(r.errors.some((e) => e.field === field && e.code === code), `${JSON.stringify(patch)} → ${JSON.stringify(r.errors)}`);
      // the validator reports it directly too
      assert.ok(validateStage({ ...SPEC, ...patch }).some((i) => i.code === code));
    }
  });
});

describe('stage rules: the deploy rules (3)', () => {
  test('LOW + buildable RANGED is a 远程位 — the rule the shared copy was missing', () => {
    const legend = { ...GLYPH_LEGEND, g: { tileKey: 'tile_floor', height: 'LOW', buildable: 'RANGED', passable: 'ALL', groundPassable: true, flyPassable: true, special: null, bb: {} } };
    const rows = SPEC.rows.map((l) => l.replace(/r/g, 'g'));
    const d = deriveDeployTiles(rows, legend, []);
    // the whole normal rect (rows 9-12 × cols 2-10) is LOW+RANGED now
    assert.equal(d.normal.melee.length, 0, JSON.stringify(d.normal.melee));
    assert.equal(d.normal.rangedOnly.length, 4 * 9);
    assert.deepEqual(tileKeys(d.normal.rangedOnly), [...Array(4)].flatMap((_, i) => [...Array(9)].map((__, j) => `${9 + i},${2 + j}`)).sort());
    // the engine classifies exactly the same tile the same way (board.js:106), so the two never drift
    const t = normalizeLegendEntry('g', legend.g);
    assert.equal(t.height, 'LOW');
    assert.equal(t.build, 'RANGED');
    // a ground 远程位 is NOT a melee position
    assert.equal(d.normal.melee.length, 0);
  });

  test('深水区 is never deployable, whatever the legend claims', () => {
    // a deepsea tile painted INSIDE the normal deploy rect (row 10, col 5), with a legend that claims it is fully
    // buildable — the case a data typo would produce, and the one the engine refuses by KEY
    const rows = SPEC.rows.map((l, r) => (r === 10 ? `${l.slice(0, 5)}x${l.slice(6)}` : l));
    const legend = { ...GLYPH_LEGEND, x: { ...GLYPH_LEGEND.x, buildable: 'ALL' } };
    for (const groundHighGround of [false, true]) {
      const d = deriveDeployTiles(rows, legend, [], { groundHighGround });
      assert.equal(tileKeys(d.normal.melee).includes('10,5'), false, `deepsea must not be a melee position (groundHighGround ${groundHighGround})`);
      assert.equal(tileKeys(d.normal.rangedOnly).includes('10,5'), false, `deepsea must not be a 远程位 (groundHighGround ${groundHighGround})`);
    }
    const r = deriveStage({ ...SPEC, rows, tiles: legend, options: { groundHighGround: true } });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(tileKeys(r.stage.deployTiles.normal.melee).includes('10,5'), false);
    assert.equal(tileKeys(r.stage.deployTiles.normal.rangedOnly).includes('10,5'), false);
    // the engine's own legend normaliser refuses it too, so a workshop map cannot disagree with the sim
    assert.equal(normalizeLegendEntry('x', legend.x).build, 'NONE');
    // and the authoring set IS the engine's set: a drift here would deploy units the engine refuses
    assert.deepEqual([...DEPLOY_REFUSED_TILES].sort(), [...ENGINE_REFUSED].sort());
  });

  test('地面也能放高台 is the map’s own switch (options.groundHighGround, default false)', () => {
    // a grid that has 高台, road AND plain ground inside the normal rect: the switch must move exactly the ground
    const rows = SPEC.rows.map((l, r) => (r === 10 ? `${l.slice(0, 4)}ff${l.slice(6)}` : l));
    const options = { characterLimit: 8, moveMultiplier: 0.5 };
    const off = deriveStage({ ...SPEC, rows, options });
    const on = deriveStage({ ...SPEC, rows, options: { ...options, groundHighGround: true } });
    assert.equal(off.ok, true, JSON.stringify(off.errors));
    assert.equal(on.ok, true, JSON.stringify(on.errors));
    // the switch travels in the record (the editor reads it back) and the pure read agrees
    assert.equal(groundRuleOf(SPEC), false);
    assert.equal(groundRuleOf(on.stage), true);
    assert.equal(on.stage.options.groundHighGround, true);
    assert.equal(Object.hasOwn(off.stage.options, 'groundHighGround'), false, 'a plain record keeps its options shape');
    // the ONLY thing that changes is which ground tiles are 远程位
    assert.deepEqual(tileKeys(on.stage.deployTiles.normal.melee), tileKeys(off.stage.deployTiles.normal.melee), 'melee tiles must not move');
    const before = new Set(tileKeys(off.stage.deployTiles.normal.rangedOnly));
    const after = tileKeys(on.stage.deployTiles.normal.rangedOnly);
    assert.ok(after.length > before.size, `地面开关必须真的加上格子 (${before.size} → ${after.length})`);
    for (const k of before) assert.ok(after.includes(k), `${k} was a 远程位 already and must stay one`);
    // the added ones are exactly the LOW/NONE ground the legend describes, and never 阻隔/深水区
    const legend = SPEC.tiles;
    const added = after.filter((k) => !before.has(k));
    assert.deepEqual(added, ['10,4', '10,5'], JSON.stringify(added));
    for (const k of added) {
      const [r, c] = k.split(',').map(Number);
      const t = legend[rows[r][c]];
      assert.equal(t.height, 'LOW');
      assert.equal(t.buildable, 'NONE');
      assert.equal(DEPLOY_REFUSED_TILES.has(t.tileKey), false, `${k} is refused by key and must stay out`);
    }
    assert.deepEqual(stageErrors(validateStageRecord(on.stage, { id: on.stage.id, officialIds: new Set() })), []);
    assert.deepEqual(stageErrors(validateStageRecord(off.stage, { id: off.stage.id, officialIds: new Set() })), []);
  });

  test('an active device still overrides the tile it sits on (and a blocked one is removed)', () => {
    const devices = [
      { key: 'trap_040_canoe', pos: [10, 5], role: 'waterPlatform', active: true },
      { key: 'trap_1105_accrate', pos: [10, 6], role: 'crate', active: true },
    ];
    const d = deriveDeployTiles(SPEC.rows, SPEC.tiles, devices);
    assert.ok(tileKeys(d.normal.melee).includes('10,5'), 'a 特制水上平台 device makes its tile melee-deployable');
    assert.equal(tileKeys(d.normal.melee).includes('10,6'), false, 'a crate blocks its tile');
  });

  test('the ground switch cannot open the 12 gate routes: it is a deploy rule, not a path rule', () => {
    const on = deriveStage({ ...SPEC, options: { groundHighGround: true } }, { paths: true });
    assert.equal(on.ok, true, JSON.stringify(on.errors));
    const off = deriveStage(SPEC, { paths: true });
    assert.deepEqual(on.stage.groundPaths, off.stage.groundPaths, 'deploy rules must not move the enemy routes');
  });
});

describe('stage rules: 空气 outside the map (4)', () => {
  test('the palette has the air glyph, drawn as tile_forbidden with the air marker', () => {
    const air = TILE_PALETTE.find((t) => t.glyph === '-');
    assert.ok(air, 'the palette needs the 空气 glyph');
    assert.equal(air.tileKey, 'tile_forbidden');
    assert.equal(air.air, true);
    assert.equal(air.height, 'HIGH');
    assert.equal(air.buildable, 'NONE');
    assert.equal(air.passable, 'NONE');
    assert.equal(new Set(TILE_PALETTE.map((t) => t.glyph)).size, TILE_PALETTE.length, 'palette glyphs stay unique');
  });

  test('the engine reads an air entry as a plain forbidden tile (the marker is ignored)', () => {
    const withAir = normalizeLegendEntry('-', { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE', air: true });
    const wall = normalizeLegendEntry('X', { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE' });
    // identical but for the glyph the author wrote — `air` must not reach any mechanical field
    assert.deepEqual({ ...withAir, glyph: null }, { ...wall, glyph: null });
    assert.equal(withAir.pass, 'NONE');
    assert.equal(withAir.build, 'NONE');
    assert.equal(withAir.special, null);
    assert.equal(Object.hasOwn(withAir, 'air'), false);
  });

  test('`-` and `X` differ in PRESENTATION only: the validator says the same thing about both', () => {
    const airSpec = { ...SPEC, rows: SPEC.rows.map((l, r) => (r === 0 ? '-'.repeat(STAGE_COLS) : l)) };
    const airLegend = { ...GLYPH_LEGEND, '-': { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE', air: true } };
    const air = deriveStage({ ...airSpec, tiles: airLegend });
    const wall = deriveStage({ ...airSpec, tiles: { ...airLegend, '-': { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE' } } });
    assert.equal(air.ok, true, JSON.stringify(air.errors));
    assert.equal(wall.ok, true, JSON.stringify(wall.errors));
    // the derived record is identical apart from the marker the author wrote
    assert.deepEqual(air.stage.deployTiles, wall.stage.deployTiles);
    assert.deepEqual(air.stage.groundPaths, wall.stage.groundPaths);
    assert.deepEqual(validateStage({ ...airSpec, tiles: airLegend }).map((i) => i.code), validateStage({ ...airSpec, tiles: { ...airLegend, '-': { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE' } } }).map((i) => i.code));
    // an air tile may not be deployed on either
    for (const k of [...tileKeys(air.stage.deployTiles.normal.melee), ...tileKeys(air.stage.deployTiles.normal.rangedOnly)]) {
      const [r] = k.split(',').map(Number);
      assert.notEqual(r, 0, 'air must never be a deploy tile');
    }
  });
});

describe('stage rules: the 样板地图 (SAMPLE_STAGE_SPEC)', () => {
  test('a device on a refused tile still wins — the official 深水区 + 特制水上平台 pair', () => {
    // The rule order matters: devices are applied FIRST (build-data, and the engine's buildDeployMap), so a 特制水上平台
    // standing on 深水区 makes that tile deployable. Refusing the tile before the device would silently drop the whole
    // canoe scene — the official act1autochess_m05 stores exactly those tiles as melee positions.
    //
    // The engine normalises 深水区 to build: 'NONE' whatever the legend says, so that is the entry this test uses.
    const rows = SPEC.rows.map((l, r) => (r === 10 ? `${l.slice(0, 5)}x${l.slice(6)}` : l));
    const legend = { ...GLYPH_LEGEND, x: { ...GLYPH_LEGEND.x, buildable: 'NONE' } };
    const d = deriveDeployTiles(rows, legend, [{ key: 'trap_040_canoe', pos: [10, 5], role: 'waterPlatform', active: true }]);
    assert.ok(tileKeys(d.normal.melee).includes('10,5'), 'the platform device makes its 深水区 tile deployable');
    // the platform was the only thing that could deploy there, so the change is attributed to it
    assert.ok(d.normal.changedByDevices.some(([r, c]) => r === 10 && c === 5), 'a device that CREATES a deploy tile is a change to it');
    // without the device the same tile disappears from both lists
    const bare = deriveDeployTiles(rows, legend, []);
    assert.equal(tileKeys(bare.normal.melee).includes('10,5'), false);
    assert.equal(tileKeys(bare.normal.rangedOnly).includes('10,5'), false);
  });

  test('its shape is what the editor’s 「以模板新建」 needs', () => {
    assert.equal(SAMPLE_STAGE_SPEC.id, 'ws_sample_map');
    assert.equal(typeof SAMPLE_STAGE_SPEC.name, 'string');
    assert.ok(SAMPLE_STAGE_SPEC.name.length > 0);
    assert.equal(typeof SAMPLE_STAGE_SPEC.spec, 'object');
    assert.equal(SAMPLE_STAGE_SPEC.spec.id, SAMPLE_STAGE_SPEC.id);
  });

  test('it is 19×21 and every glyph it uses is in its own legend', () => {
    const spec = sampleStageSpec();
    assert.equal(spec.rows.length, STAGE_ROWS);
    for (const line of spec.rows) assert.equal(line.length, STAGE_COLS);
    for (const line of spec.rows) for (const ch of line) assert.ok(spec.tiles[ch], `the sample uses "${ch}" without a legend entry`);
    // every glyph of the palette is offered, so the author can keep painting
    for (const t of TILE_PALETTE) assert.ok(spec.tiles[t.glyph], `the sample legend is missing the palette glyph ${t.glyph}`);
    assert.deepEqual(stageErrors(validateStage(spec)), []);
  });

  test('it contains a gate, an objective, road, ground, 高台, 阻隔 and a ring of 空气', () => {
    const spec = sampleStageSpec();
    const used = new Set(spec.rows.join(''));
    for (const g of ['S', 'E', 'r', 'f', '#', 'X', '-']) assert.ok(used.has(g), `the sample must use "${g}"`);
    for (const line of [spec.rows[0], spec.rows[STAGE_ROWS - 1]]) {
      assert.equal(line, '-'.repeat(STAGE_COLS), 'air must frame the map');
    }
  });

  test('it derives cleanly with 寻路 both off and on, and its drawn route is walkable', () => {
    const spec = sampleStageSpec();
    const off = deriveStage(spec);
    assert.equal(off.ok, true, JSON.stringify(off.errors));
    assert.deepEqual(stageErrors(validateStageRecord(off.stage, { id: off.stage.id, officialIds: new Set() })), []);
    assert.equal(spec.routes.length > 0, true, 'the sample must carry a drawn route so 自动寻路 has something to draw');
    assert.ok(off.routePaths.every((p) => p.path), JSON.stringify(off.routePaths));
    // the drawn route starts on the gate and ends on the objective, so the editor's warnings stay quiet
    assert.deepEqual(validateStage(spec).filter((i) => i.code.startsWith('START_') || i.code.startsWith('END_')), []);
    // the map has none of the 12 official gate pairs (the 高台 ring blocks every gate), so asking for 寻路 is a no-op
    // rather than an error — and it must stay a no-op, because `paths` must never move the enemy routes
    const on = deriveStage(spec, { paths: true });
    assert.equal(on.ok, true, JSON.stringify(on.errors));
    assert.deepEqual(on.stage.groundPaths, off.stage.groundPaths);
    assert.deepEqual(on.stage.groundPathsWithDevices, off.stage.groundPathsWithDevices);
    assert.deepEqual(stageErrors(validateStageRecord(on.stage, { id: on.stage.id, officialIds: new Set() })), []);
  });

  test('it is 单人视角: one deployment field with both melee and ranged positions', () => {
    const r = deriveStage(sampleStageSpec());
    assert.ok(r.stage.deployTiles.normal.melee.length > 0, 'melee positions');
    assert.ok(r.stage.deployTiles.normal.rangedOnly.length > 0, '高台 positions');
    // 高台 tiles inside the normal rect are the 远程位; the melee ones are road/地面
    const rows = r.stage.rows;
    for (const [rr, c] of r.stage.deployTiles.normal.rangedOnly) assert.ok(['#', 'f', 'S', 'E'].includes(rows[rr][c]), `${rr},${c} = ${rows[rr][c]}`);
  });

  test('every construction returns a private copy, so a form cannot corrupt the template', () => {
    const a = sampleStageSpec();
    a.rows[0] = 'X'.repeat(STAGE_COLS);
    a.options.characterLimit = 99;
    a.routes[0].start[0] = 0;
    const b = sampleStageSpec();
    assert.equal(b.rows[0], '-'.repeat(STAGE_COLS));
    assert.equal(b.options.characterLimit, 8);
    assert.deepEqual(b.routes[0].start, [6, 2]);
    assert.equal(deriveStage(b).ok, true);
  });
});
