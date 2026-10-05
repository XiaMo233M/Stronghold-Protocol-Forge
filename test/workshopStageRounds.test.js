// test/workshopStageRounds.test.js — option B: the ROUNDS are scoped to the MAP.
//
// The engine picks the stage (setupMatchWaves, by weight from `mode.stages`) and the round's wave template
// (`mode.rounds[r].template`) INDEPENDENTLY, so a workshop map that inherited an official template would send its
// enemies down routes its terrain does not have. A stage may therefore carry its own per-round templates
// (`stage.rounds`), which buildNormalWave / buildBossWave read first; the mode's remain the fallback.
//
// The test that matters as much as the feature: an OFFICIAL stage (no `rounds` field) and a call with no stageId at all
// must resolve exactly what they resolved before.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { buildNormalWave, buildBossWave } from '../server/match/waves.js';
import { createRng } from '../server/sim/rng.js';
import { deriveStage } from '../server/stageAuthoring.js';
import { deriveWave } from '../shared/waveAuthoring.js';
import { TILE_PALETTE, STAGE_ROWS, STAGE_COLS, stageErrors } from '../shared/stageAuthoring.js';
import { validateStage } from '../shared/stageAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const CONFIG = JSON.parse(fs.readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
const STAGES = JSON.parse(fs.readFileSync(join(DATA_DIR, 'stages.json'), 'utf8'));
const MODE = 'mode_multi_normal';
const MODE_CFG = CONFIG.modes[MODE];
const MODE_ROUND3 = MODE_CFG.rounds['3'].template;
const BOSS_ROUND = Number.isInteger(MODE_CFG.bossRound) && MODE_CFG.bossRound > 0 ? MODE_CFG.bossRound : 14;
const OFFICIAL_STAGE = Object.keys(STAGES)[0];
const FACTION_TYPES = ['TIMES', 'INVISIBLE', 'FLY'];

const legend = () => Object.fromEntries(TILE_PALETTE.map((t) => [t.glyph, {
  tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable,
  groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE', special: t.special ?? null, bb: {},
}]));

/** A workshop map whose round 3 (and the boss round) run the pack's OWN waves. */
function stageSpec(extra = {}) {
  return {
    id: 'ws_rounds_map', name: '回合测试图', weight: 50, modes: [MODE],
    rows: Array.from({ length: STAGE_ROWS }, (_, r) => (r === 9 ? `S${'r'.repeat(STAGE_COLS - 2)}E` : 'r'.repeat(STAGE_COLS))),
    tiles: legend(),
    devices: [],
    routes: [{ motion: 'WALK', start: [9, 0], end: [9, STAGE_COLS - 1], checkpoints: [] }],
    ...extra,
  };
}

function waveSpec(id, usedBy) {
  return {
    id, kind: 'normal',
    routes: [{ motion: 'WALK', start: [9, 0], end: [9, STAGE_COLS - 1], checkpoints: [] }],
    spawns: [{ time: 3, key: 'enemy_1007_slime', count: 2, interval: 5, routeIndex: 0, slot: 'N' }],
    usedBy,
  };
}

describe('option B: rounds scoped to the map', () => {
  let tmp;
  let wsRoot;
  let gd;
  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-rounds-'));
    wsRoot = join(tmp, 'ws');
    const packDir = join(wsRoot, 'rounds-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({
      id: 'rounds-pack', name: 'Rounds', version: '0.1.0', content: ['stages', 'waves'], overrides: [],
    }));

    const own = deriveWave(waveSpec('ws_round_three', [{ modeId: MODE, round: 3 }]));
    const boss = deriveWave(waveSpec('ws_round_boss', [{ modeId: MODE, round: BOSS_ROUND }]));
    assert.equal(own.ok, true, JSON.stringify(own.errors));
    assert.equal(boss.ok, true, JSON.stringify(boss.errors));
    fs.writeFileSync(join(packDir, 'waves.json'), JSON.stringify({ [own.wave.id]: own.wave, [boss.wave.id]: boss.wave }));

    const spec = stageSpec({
      rounds: { 3: 'wave_ws_ws_round_three' },
      bossRounds: { [BOSS_ROUND]: { 'boss_any': 'wave_ws_ws_round_boss' } },
    });
    const derived = deriveStage(spec);
    assert.equal(derived.ok, true, JSON.stringify(derived.errors));
    assert.deepEqual(derived.stage.rounds, { 3: 'wave_ws_ws_round_three' });
    assert.deepEqual(derived.stage.bossRounds, { [BOSS_ROUND]: { boss_any: 'wave_ws_ws_round_boss' } });
    fs.writeFileSync(join(packDir, 'stages.json'), JSON.stringify({ [derived.stage.id]: derived.stage }));

    gd = new GameData(loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot }), MODE);
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('the map declares its round templates, and the record carries them through', () => {
    const stage = gd.stage('ws_rounds_map');
    assert.ok(stage, 'the workshop stage must reach the data');
    assert.deepEqual(stage.rounds, { 3: 'wave_ws_ws_round_three' });
    assert.ok(gd.wave('wave_ws_ws_round_three'), 'the wave it names must exist');
  });

  test('a declared round runs the MAP\'s wave; an undeclared one falls back to the mode\'s', () => {
    const declared = buildNormalWave(gd, createRng(1), FACTION_TYPES, 3, 'ws_rounds_map');
    assert.equal(declared.templateId, 'wave_ws_ws_round_three', 'the map\'s own round 3 must win');
    const other = buildNormalWave(gd, createRng(1), FACTION_TYPES, 4, 'ws_rounds_map');
    assert.equal(other.templateId, MODE_CFG.rounds['4'].template, 'round 4 is not declared, so the mode\'s is used');
  });

  test('an OFFICIAL stage, and a call with no stageId, resolve exactly as before', () => {
    const official = buildNormalWave(gd, createRng(1), FACTION_TYPES, 3, OFFICIAL_STAGE);
    assert.equal(official.templateId, MODE_ROUND3, 'an official stage has no `rounds` field: unchanged');
    assert.equal(Object.hasOwn(STAGES[OFFICIAL_STAGE], 'rounds'), false);
    const noStage = buildNormalWave(gd, createRng(1), FACTION_TYPES, 3);
    assert.equal(noStage.templateId, MODE_ROUND3, 'the stageId argument is optional (backwards compatible)');
    const unknownStage = buildNormalWave(gd, createRng(1), FACTION_TYPES, 3, 'no_such_stage');
    assert.equal(unknownStage.templateId, MODE_ROUND3, 'an unknown stage falls back rather than breaking the round');
  });

  test("a map's boss round runs its own boss wave", () => {
    const w = buildBossWave(gd, createRng(1), FACTION_TYPES, BOSS_ROUND, { bossId: 'boss_any', solo: false }, 'ws_rounds_map');
    assert.equal(w.templateId, 'wave_ws_ws_round_boss');
    const official = buildBossWave(gd, createRng(1), FACTION_TYPES, BOSS_ROUND, { bossId: 'boss_any', solo: false }, OFFICIAL_STAGE);
    assert.notEqual(official.templateId, 'wave_ws_ws_round_boss');
  });

  test('a template id nothing defines falls back to the mode (a typo must not break the round)', () => {
    const typo = stageSpec({ rounds: { 3: 'wave_does_not_exist' } });
    assert.equal(deriveStage(typo).ok, true, 'a missing target is not a derive error — the engine falls back');
    const stage = deriveStage(typo).stage;
    assert.equal(stage.rounds['3'], 'wave_does_not_exist');
    // the engine: an id that does not resolve is ignored, so the round still runs the mode's template
    const data = gd.raw;
    const withTypo = new GameData({ ...data, stages: { ...data.stages, typo_map: stage } }, MODE);
    assert.equal(buildNormalWave(withTypo, createRng(1), FACTION_TYPES, 3, 'typo_map').templateId, MODE_ROUND3);
  });

  test('the round declarations are validated (round keys and the template shape)', () => {
    const bad = validateStage(stageSpec({ rounds: { 0: 'w', 99: 'w', 3: 42 } }), { officialIds: new Set() });
    const codes = bad.map((i) => `${i.field}:${i.code}`);
    assert.ok(codes.includes('rounds[0]:BAD_ROUND'), codes.join(' '));
    assert.ok(codes.includes('rounds[99]:BAD_ROUND'), codes.join(' '));
    assert.ok(codes.includes('rounds[3]:BAD_TEMPLATE'), codes.join(' '));
    // an official-shaped stage declares neither field, so nothing is reported
    assert.deepEqual(stageErrors(validateStage(stageSpec(), { officialIds: new Set() })), []);
    const badBoss = validateStage(stageSpec({ bossRounds: { 14: 'not-an-object' } }), { officialIds: new Set() });
    assert.ok(badBoss.some((i) => i.code === 'BAD_TEMPLATE'), JSON.stringify(badBoss));
  });
});
