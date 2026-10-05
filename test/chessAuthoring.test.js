// test/chessAuthoring.test.js — the authoring interface (shared/chessAuthoring.js, docs/WORKSHOP.md).
//
// This is the contract an ordinary AI (or the editor UI) uses to turn "skill text + normal/elite numbers" into a chess
// record the engine accepts. Two halves, both required for it to be usable in a self-correction loop:
//   * deriveChessRecord(spec) fills every mechanical field, so the author supplies only creative facts;
//   * validateChessRecord(rec) reports every problem with a field/code/hint — never throws, never stops at the first.
// The most valuable check is BB_UNKNOWN_KEY: the generic kit (server/sim/content/generic.js) is what lets an operator
// fight with NO JavaScript, and it reads a fixed key set. An invented key silently does nothing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  deriveChessRecord, validateChessRecord, classify, chessIds, formatIssues, authoringErrors,
  GENERIC_BB_KEYS, PROFESSIONS, SKILL_TYPES, SP_TYPES, isKnownBbKey, bbKeyBase,
} from '../shared/chessAuthoring.js';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';
import { makeMatch, give, legalTileFor } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const officialChess = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));
const OFFICIAL_IDS = new Set(Object.keys(officialChess));

/** A minimal, realistic spec: everything an author must decide, nothing mechanical. */
const SPEC = {
  id: 'abyss_hunter',
  name: '深渊猎手',
  tier: 5,
  profession: 'SNIPER',
  subProfessionId: 'fastshot',
  position: 'RANGED',
  assetsSpine: officialChess['chess_char_5_01_a'].assets.spine,
  stats: {
    normal: { maxHp: 1500, atk: 480, def: 140, res: 0, cost: 18, blockCnt: 1, bat: 1.0 },
    golden: { maxHp: 1900, atk: 620, def: 180, res: 0, cost: 18, blockCnt: 1, bat: 1.0 },
  },
  skill: {
    name: '贯穿射击', desc: '攻击力+60%，攻击装有8发弹药',
    skillType: 'MANUAL', durationType: 'AMMO', spType: 'INCREASE_WITH_TIME',
    spCost: 30, initSp: 10, trigger_time: 8, bb: { atk: 0.6, atk_scale: 1.6, trigger_time: 8 },
  },
};

describe('chess authoring: deriveChessRecord', () => {
  test('the minimal spec produces both states and links them', () => {
    const r = deriveChessRecord(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.base.chessId, 'chess_ws_abyss_hunter_a');
    assert.equal(r.golden.chessId, 'chess_ws_abyss_hunter_b');
    assert.equal(r.base.goldenId, r.golden.chessId);
    assert.equal(r.golden.baseId, r.base.chessId);
    assert.equal(r.base.isGolden, false);
    assert.equal(r.golden.isGolden, true);
    assert.equal(r.base.upgradeChessId, r.golden.chessId);
    assert.equal(r.golden.upgradeNum, 0);
    assert.equal(r.base.visible, true, 'it must enter the shop pool');
    assert.equal(r.base.tier, 5);
    assert.equal(r.base.price, 4, 'price comes from the tier');
    assert.equal(r.base.rarity, 5);
    assert.equal(r.base.name, '深渊猎手', 'the name must be carried, or the operator shows as its id');
    assert.equal(r.golden.name, '深渊猎手');
  });

  test('the two states keep their own numbers', () => {
    const r = deriveChessRecord(SPEC);
    assert.equal(r.base.stats.maxHp, 1500);
    assert.equal(r.base.stats.atk, 480);
    assert.equal(r.golden.stats.maxHp, 1900);
    assert.equal(r.golden.stats.atk, 620);
    assert.equal(r.base.status.skillLevel, 4);
    assert.equal(r.golden.status.skillLevel, 7);
    // defaults fill what the author left out
    assert.equal(r.base.stats.aspd, 100);
    assert.equal(r.base.stats.respawnTime, 70);
    assert.equal(r.base.stats.spRecovery, 1);
  });

  test('classification is derived from the profession, not invented', () => {
    const r = deriveChessRecord(SPEC);
    assert.equal(r.base.dmgType, 'phys');
    assert.equal(r.base.attackKind, 'ranged');
    assert.equal(r.base.projectile, 'arrow');
    assert.equal(r.base.canHitFly, true);
    assert.deepEqual(classify({ profession: 'MEDIC', position: 'RANGED' }), { dmgType: 'heal', attackKind: 'heal', projectile: 'orb', canHitFly: false });
    assert.equal(classify({ profession: 'CASTER', position: 'RANGED' }).dmgType, 'arts');
    assert.equal(classify({ profession: 'SNIPER', subProfessionId: 'bard', position: 'RANGED' }).attackKind, 'none');
    assert.equal(classify({ profession: 'SNIPER', subProfessionId: 'fortress', position: 'RANGED' }).canHitFly, false);
    assert.equal(classify({ profession: 'WARRIOR', position: 'MELEE' }).attackKind, 'melee');
  });

  test('a melee operator gets a melee grid and a ranged one a ranged grid', () => {
    const melee = deriveChessRecord({ ...SPEC, id: 'brawler', profession: 'WARRIOR', position: 'MELEE', subProfessionId: 'sword' });
    assert.deepEqual(melee.base.rangeGrid, [[0, 0], [0, 1]]);
    assert.equal(deriveChessRecord(SPEC).base.rangeGrid.length > 2, true);
  });

  test('every missing or wrong fact is reported once, with a field and a code', () => {
    const r = deriveChessRecord({ id: '', tier: 9, profession: 'BARD', position: 'FLYING', stats: {} });
    assert.equal(r.ok, false);
    const codes = r.errors.map((e) => `${e.field}:${e.code}`);
    assert.ok(codes.includes('id:BAD_ID'), codes.join(' '));
    assert.ok(codes.includes('name:MISSING'));
    assert.ok(codes.includes('tier:BAD_TIER'));
    assert.ok(codes.includes('profession:BAD_PROFESSION'));
    assert.ok(codes.includes('position:BAD_POSITION'));
    assert.ok(codes.includes('stats.normal:MISSING'));
    assert.ok(codes.includes('stats.golden:MISSING'));
    for (const e of r.errors) assert.ok(e.message && e.code && e.field !== undefined);
  });

  test('bad numbers are refused with the offending field named', () => {
    const bad = { ...SPEC, stats: { normal: { maxHp: -1, atk: -5, def: 0, res: 200, bat: 0, cost: -1, blockCnt: 1 }, golden: { ...SPEC.stats.golden } } };
    const r = deriveChessRecord(bad);
    assert.equal(r.ok, false);
    const fields = r.errors.map((e) => e.field);
    for (const f of ['stats.normal.maxHp', 'stats.normal.atk', 'stats.normal.res', 'stats.normal.bat', 'stats.normal.cost']) {
      assert.ok(fields.includes(f), `${f} not reported: ${fields.join(' ')}`);
    }
  });

  test('an id is slugged into the chess_ws_ namespace', () => {
    assert.deepEqual(chessIds('Abyss Hunter!'), { slug: 'abyss_hunter', base: 'chess_ws_abyss_hunter_a', golden: 'chess_ws_abyss_hunter_b' });
    assert.deepEqual(chessIds('chess_ws_x_b'), { slug: 'x', base: 'chess_ws_x_a', golden: 'chess_ws_x_b' });
    assert.equal(chessIds('!!!'), null);
  });

  test('an unknown generic-kit key is a warning, not a silent no-op', () => {
    const r = deriveChessRecord({ ...SPEC, skill: { ...SPEC.skill, bb: { atk: 0.5, made_up_key: 3 } } });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('made_up_key')), r.warnings.join(' | '));
  });
});

describe('chess authoring: validateChessRecord', () => {
  test('a derived record validates clean, and so does EVERY shop-eligible official record', () => {
    const r = deriveChessRecord(SPEC);
    assert.equal(r.base.name, SPEC.name);
    assert.equal(r.golden.name, SPEC.name);
    assert.deepEqual(authoringErrors(validateChessRecord(r.base, { officialIds: OFFICIAL_IDS })), []);
    assert.deepEqual(authoringErrors(validateChessRecord(r.golden, { officialIds: OFFICIAL_IDS })), []);
    // Sweep EVERY visible official record. Sampling one record is exactly what let a wrong PROFESSIONS list survive:
    // it rejected 88 official operators (TANK/PIONEER/SPECIAL were missing) while this test stayed green.
    const bad = [];
    for (const [id, rec] of Object.entries(officialChess)) {
      if (!rec.visible || rec.isHidden || rec.isDiy) continue;
      const errs = authoringErrors(validateChessRecord(rec, { id, officialIds: new Set() }));
      if (errs.length) bad.push(`${id}: ${formatIssues(errs)}`);
    }
    assert.deepEqual(bad, [], `the validator rejects official operators (${bad.length}):\n${bad.slice(0, 5).join('\n')}`);
  });

  test('reports every problem at once instead of stopping at the first', () => {
    const rec = { chessId: 'x', golden: true, tier: 0, profession: 'NOPE', position: 'NOPE', rangeGrid: [], stats: {}, talents: 'no', bonds: null };
    const issues = validateChessRecord(rec, { officialIds: new Set() });
    const codes = new Set(issues.map((i) => i.code));
    for (const c of ['BAD_TIER', 'BAD_PROFESSION', 'BAD_POSITION', 'BAD_RANGE', 'MISSING', 'BAD_TALENTS', 'BAD_BONDS']) {
      assert.ok(codes.has(c), `${c} missing from ${[...codes].join(' ')}`);
    }
    assert.ok(issues.every((i) => i.severity === 'error' || i.severity === 'warning'));
    assert.match(formatIssues(issues), /^ERROR /);
  });

  test('an official-id collision is an error with the fix in the hint', () => {
    const issues = validateChessRecord(officialChess['chess_char_1_01_a'], { officialIds: OFFICIAL_IDS });
    const hit = issues.find((i) => i.code === 'OFFICIAL_ID_COLLISION');
    assert.ok(hit && hit.severity === 'error');
    assert.match(hit.hint, /overrides/);
  });

  test('a MANUAL skill with no cost is flagged (it would fire forever)', () => {
    const r = deriveChessRecord({ ...SPEC, skill: { ...SPEC.skill, spCost: 0, initSp: 0 } });
    const issues = validateChessRecord(r.base, { officialIds: OFFICIAL_IDS });
    assert.ok(issues.some((i) => i.code === 'MANUAL_NO_COST'), formatIssues(issues));
  });

  test('AMMO with no count, and a duration with no blackboard, are both flagged', () => {
    const r = deriveChessRecord({ ...SPEC, skill: { name: 's', desc: 'd', durationType: 'AMMO', spType: SP_TYPES[0], spCost: 10, bb: {} } });
    const issues = validateChessRecord(r.base, { officialIds: OFFICIAL_IDS });
    assert.ok(issues.some((i) => i.code === 'AMMO_NO_COUNT' || i.code === 'EMPTY_BB'), formatIssues(issues));
  });

  test('skills[] filled while skill is null is reported (the engine fights with `skill`)', () => {
    const r = deriveChessRecord(SPEC);
    const broken = { ...r.base, skill: null };
    assert.ok(validateChessRecord(broken, { officialIds: OFFICIAL_IDS }).some((i) => i.code === 'SKILL_MISMATCH'));
  });
});

describe('chess authoring: the generic-kit key list stays true', () => {
  test('every canonical key is documented in generic.js (drift guard)', () => {
    const src = fs.readFileSync(join(ROOT, 'server/sim/content/generic.js'), 'utf8');
    const missing = GENERIC_BB_KEYS.filter((k) => !src.includes(k));
    assert.deepEqual([...new Set(missing)], [], 'GENERIC_BB_KEYS lists keys that generic.js does not mention');
    // the list holds BASE names only: a prefixed entry would be duplicated logic
    assert.deepEqual(GENERIC_BB_KEYS.filter((k) => k.includes('@')), [], 'GENERIC_BB_KEYS must hold base names only');
  });

  test('the three spellings of a key are all accepted, and only one prefix is stripped', () => {
    for (const k of ['atk_scale', 'attack@atk_scale', 'skill@atk_scale']) assert.equal(isKnownBbKey(k), true, k);
    assert.equal(isKnownBbKey('stun'), true);
    assert.equal(isKnownBbKey('attack@stun'), true);
    assert.equal(bbKeyBase('attack@stun'), 'stun');
    assert.equal(bbKeyBase('skill@atk'), 'atk');
    assert.equal(bbKeyBase('atk'), 'atk');
    assert.equal(isKnownBbKey('attack@attack@atk_scale'), false, 'only one prefix is stripped');
    assert.equal(isKnownBbKey('made_up_key'), false);
  });

  test('an ammo count in its attack@ spelling still counts as a count', () => {
    const r = deriveChessRecord({
      ...SPEC,
      skill: { ...SPEC.skill, durationType: 'AMMO', spType: SP_TYPES[0], spCost: 10, bb: { atk: 0.5, 'attack@trigger_time': 8 } },
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const issues = validateChessRecord(r.base, { officialIds: OFFICIAL_IDS });
    assert.equal(issues.some((i) => i.code === 'AMMO_NO_COUNT'), false, formatIssues(issues));
    assert.equal(issues.some((i) => i.code === 'BB_UNKNOWN_KEY'), false, formatIssues(issues));
    assert.deepEqual(authoringErrors(issues), [], formatIssues(issues));
  });

  test('bb.cnt is a real ammo key (generic.js reads it)', () => {
    assert.equal(isKnownBbKey('cnt'), true);
    const r = deriveChessRecord({ ...SPEC, skill: { ...SPEC.skill, durationType: 'AMMO', spType: SP_TYPES[0], spCost: 10, bb: { cnt: 6 } } });
    const issues = validateChessRecord(r.base, { officialIds: OFFICIAL_IDS });
    assert.equal(issues.some((i) => i.code === 'AMMO_NO_COUNT'), false, formatIssues(issues));
  });

  test('the enums match the sim', async () => {
    const simdata = await import('../server/sim/simdata.js');
    // The sim normalises an spType to a short form by substring (normSpType), so an authored record may carry either;
    // the documented set is the official spelling that data/*.json uses.
    assert.equal(simdata.normSpType('INCREASE_WITH_TIME'), 'time');
    assert.equal(simdata.normSpType('INCREASE_WHEN_ATTACK'), 'attack');
    assert.equal(simdata.normSpType('INCREASE_WHEN_TAKEN_DAMAGE'), 'hurt');
    assert.equal(simdata.normSpType('ON_DEPLOY'), 'none', 'a passive / on-deploy skill recovers no SP');
    for (const t of SKILL_TYPES) assert.equal(simdata.normalizeSkill({ skill: { skillType: t, bb: {} } }).skillType, t);
  });

  test('PROFESSIONS is exactly the set the official data uses (drift guard)', () => {
    // The root cause of the worst bug in this feature: an invented vocabulary. Asserting the LENGTH passed while the
    // names were wrong, so the guard must compare against the data itself.
    const used = new Set(Object.values(officialChess).map((r) => r.profession).filter((p) => typeof p === 'string'));
    assert.deepEqual([...used].sort(), [...PROFESSIONS].sort(),
      'PROFESSIONS must equal the professions in data/chess.json: a name the engine never matches silently loses every aura/talent');
    for (const p of ['TANK', 'PIONEER', 'SPECIAL']) assert.ok(PROFESSIONS.includes(p), `${p} (重装/先锋/特种) must be authorable`);
    for (const p of ['DEFENDER', 'VANGUARD', 'SPECIALIST']) {
      assert.equal(PROFESSIONS.includes(p), false, `${p} is a global-Arknights name this project's data does not use`);
      assert.equal(deriveChessRecord({ ...SPEC, profession: p }).ok, false, `${p} must be refused`);
    }
  });

  test('a key the engine reads in ONE spelling is reported, not silently ignored (BB_SPELLING)', () => {
    // range_radius is read only as `attack@range_radius` (generic.js:182) — writing it plainly produced no splash and
    // no warning, which is the exact failure BB_UNKNOWN_KEY exists to prevent.
    const plain = deriveChessRecord({ ...SPEC, skill: { ...SPEC.skill, bb: { range_radius: 1.5 } } });
    assert.equal(plain.ok, true);
    assert.ok(plain.warnings.some((w) => w.includes('attack@range_radius')), plain.warnings.join(' | '));
    assert.ok(validateChessRecord(plain.base, { officialIds: OFFICIAL_IDS }).some((i) => i.code === 'BB_SPELLING'));

    // duration / aoe_cd are plain-only (generic.js:258/281/303/352)
    const prefixed = deriveChessRecord({ ...SPEC, skill: { ...SPEC.skill, bb: { 'attack@duration': 5, 'skill@aoe_cd': 2 } } });
    const issues = validateChessRecord(prefixed.base, { officialIds: OFFICIAL_IDS });
    assert.equal(issues.filter((i) => i.code === 'BB_SPELLING').length, 2, formatIssues(issues));

    // the correct spellings raise nothing
    const good = deriveChessRecord({ ...SPEC, skill: { ...SPEC.skill, bb: { 'attack@range_radius': 1.5, duration: 5, aoe_cd: 2 } } });
    assert.deepEqual(authoringErrors(validateChessRecord(good.base, { officialIds: OFFICIAL_IDS })), []);
    assert.equal(validateChessRecord(good.base, { officialIds: OFFICIAL_IDS }).some((i) => i.code === 'BB_SPELLING'), false);
  });
});

describe('chess authoring: the derived pair is playable end to end', () => {
  test('a pack built from the spec loads, validates, reaches the pool and fights', () => {
    const derived = deriveChessRecord(SPEC);
    assert.equal(derived.ok, true);
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-authoring-'));
    const wsRoot = join(tmp, 'ws');
    const packDir = join(wsRoot, 'authored');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({
      id: 'authored', name: 'Authored', version: '0.1.0', content: ['chess'], overrides: [],
    }));
    fs.writeFileSync(join(packDir, 'chess.json'), JSON.stringify({ [derived.base.chessId]: derived.base, [derived.golden.chessId]: derived.golden }));

    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.ok(data.chess['chess_ws_abyss_hunter_a'], 'the authored operator must reach the merged data');
    assert.equal(Object.keys(data.chess).length, 268);

    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.visibleChess.includes('chess_ws_abyss_hunter_a'), 'it must be shop-eligible');
    assert.equal(gd.tierOf('chess_ws_abyss_hunter_a'), 5);
    assert.equal(gd.goldenIdOf('chess_ws_abyss_hunter_a'), 'chess_ws_abyss_hunter_b');
    assert.equal(new SharedPool(gd, {}).cap('chess_ws_abyss_hunter_a'), 8);

    // it resolves in the sim and survives a real battle
    const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 31, data });
    h.start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    const tile = legalTileFor(h.m, ps, 'chess_ws_abyss_hunter_a');
    assert.ok(tile, 'the authored operator has no legal tile');
    give(h.m, ps, 'chess_ws_abyss_hunter_a', 'board', tile);
    assert.ok(h.drive(() => h.m.round >= 2 || h.ended != null), `stuck at ${h.m.phase} R${h.m.round}`);
    assert.deepEqual(h.logs.error, []);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
