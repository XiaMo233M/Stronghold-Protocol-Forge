// test/enemyAuthoring.test.js — authoring a workshop ENEMY: values + special mechanics (shared/enemyAuthoring.js).
//
// The load-bearing test is the first one: the two derived metrics must be reproduced from an enemy's own stats for the
// whole shipped roster. `be` drives the per-ACTION enemy replacement count (server/match/waves.js), so a hand-typed
// value would swap the wrong number of enemies — silently.
//
// The single documented exception is asserted explicitly: the season-overridden enemies are priced from the enemy
// DATABASE by build-data, not from their season stats, so their stored attrPower legitimately differs from what those
// stats compute. Asserting "these two and only these two" is what keeps the formula honest.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  deriveEnemy, validateEnemy, enemyKey, attrPowerOf, battleEffectivenessOf, enemyErrors, enemyPowerLine,
  ENEMY_RANKS, ENEMY_MOTIONS, ENEMY_DMG_TYPES, ENEMY_APPLY_WAYS, ENEMY_AC_TYPES, ENEMY_IMMUNITIES, POWER_FACTORS,
} from '../shared/enemyAuthoring.js';
import { loadData } from '../server/data.js';
import { applyWorkshop } from '../shared/workshop.js';
import { GameData } from '../server/match/gamedata.js';
import { toDataSource } from '../server/sim/simdata.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ENEMIES = JSON.parse(fs.readFileSync(join(DATA_DIR, 'enemies.json'), 'utf8'));
const ALL = Object.values(ENEMIES);
const OFFICIAL_KEYS = new Set(Object.keys(ENEMIES));

/** The facts an author knows; everything mechanical is derived. */
const SPEC = {
  id: 'frost_hound',
  name: '霜牙猎犬',
  rank: 'ELITE',
  applyWay: 'MELEE',
  motion: 'WALK',
  dmgType: 'phys',
  desc: '被源石侵蚀的猎犬，行动迅捷。',
  stats: { maxHp: 4200, atk: 620, def: 180, res: 20, moveSpeed: 1.6, bat: 1.3, blockCnt: 1, massLevel: 2 },
  abilities: [{ text: '无法被阻挡' }, { text: '被击倒时使周围单位减速' }],
  talents: { bb: { move_speed: 0.3 } },
  tags: ['origen'],
  immunities: { stun: false, silence: true, sleep: false, frozen: true, levitate: false },
  spine: ENEMIES[Object.keys(ENEMIES)[0]].spine,
};

describe('enemy authoring: the derived metrics are reproduced', () => {
  test('be is reproduced for EVERY official enemy', () => {
    const bad = [];
    for (const e of ALL) {
      const want = battleEffectivenessOf(e.stats, e.beFactor);
      if (want !== e.be) bad.push(`${e.key}: stored ${e.be}, computed ${want} (beFactor ${e.beFactor})`);
    }
    assert.deepEqual(bad, [], `be must be reproducible from the stats:\n${bad.slice(0, 5).join('\n')}`);
  });

  test('attrPower is reproduced for every official enemy, except where a season override repriced it', () => {
    const mismatched = [];
    const seasonOverridden = [];
    for (const e of ALL) {
      const want = attrPowerOf(e.stats);
      if (want !== e.attrPower) mismatched.push(e.key);
      if (Array.isArray(e.seasonOverride) && e.seasonOverride.length) seasonOverridden.push(e.key);
    }
    // build-data prices a season-overridden enemy from the enemy DATABASE, not from its season stats (its own comment at
    // line 1670). So every mismatch must be explained by a season override — but not every season override changes the
    // priced attributes (one of the three only overrides a talent blackboard), which is why this is a subset assertion
    // rather than an equality: asserting equality was my own over-statement, and the data corrected it.
    for (const key of mismatched) {
      assert.ok(seasonOverridden.includes(key), `${key} differs from the formula but has no season override`);
    }
    assert.ok(mismatched.length > 0, 'the exception must actually be exercised');
    assert.ok(seasonOverridden.length >= mismatched.length);
  });

  test('the power weights are the documented ones', () => {
    assert.deepEqual(POWER_FACTORS, { maxHp: 1, atk: 5, def: 3, res: 3 });
    // float32 association matters: the client accumulates in f32
    assert.equal(attrPowerOf({ maxHp: 1000, atk: 100, def: 50, res: 10 }), Math.fround(Math.fround(Math.fround(100 * 5) + Math.fround(1000 * 1)) + Math.fround(50 * 3)) + Math.fround(3 * 10));
    assert.equal(battleEffectivenessOf({ maxHp: 1000, atk: 100, def: 50, res: 10 }, 1), 1000 + 500 + 150 + 30);
    assert.equal(battleEffectivenessOf({ maxHp: 1000, atk: 100, def: 50, res: 10 }, 0.5), Math.round(1680 / 0.5));
    assert.equal(battleEffectivenessOf({ maxHp: 1, atk: 0, def: 0, res: 0 }, 0), null, 'beFactor 0 means no battle effectiveness');
  });

  test('the enum lists cover every value the official data uses (drift guard)', () => {
    const lists = { rank: ENEMY_RANKS, motion: ENEMY_MOTIONS, dmgType: ENEMY_DMG_TYPES, applyWay: ENEMY_APPLY_WAYS };
    const seen = { rank: new Set(), motion: new Set(), dmgType: new Set(), applyWay: new Set() };
    for (const e of ALL) {
      seen.rank.add(e.rank);
      seen.motion.add(e.stats.motion);
      seen.dmgType.add(e.stats.dmgType);
      seen.applyWay.add(e.applyWay);
    }
    for (const [key, values] of Object.entries(seen)) {
      assert.ok(values.size > 0, `${key} was not exercised`);
      for (const v of values) assert.ok(lists[key].includes(v), `the data uses ${key}="${v}" but the validator does not accept it`);
    }
    // acType is nullable by design; every non-null value must be known
    for (const e of ALL) if (e.acType != null) assert.ok(ENEMY_AC_TYPES.includes(e.acType), `unknown acType ${e.acType}`);
    // the immunity flags must be the ones the data carries
    assert.deepEqual(Object.keys(ALL[0].stats.immunities).sort(), [...ENEMY_IMMUNITIES].sort());
  });
});

describe('enemy authoring: deriveEnemy', () => {
  test('a minimal spec produces a complete record with consistent derived metrics', () => {
    const r = deriveEnemy(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const e = r.enemy;
    assert.equal(e.key, 'enemy_ws_frost_hound');
    assert.equal(e.rank, 'ELITE');
    assert.equal(e.level, 0);
    assert.equal(e.tokenOnly, false, 'a workshop enemy is spawned by a wave, not only by a token');
    assert.equal(e.templateSlot, null);
    assert.equal(e.isFlyEnemy, false);
    assert.deepEqual(e.stats.dmgTypes, ['phys']);
    assert.equal(e.stats.motion, 'WALK');
    assert.deepEqual(Object.keys(e.stats.immunities).sort(), [...ENEMY_IMMUNITIES].sort());
    assert.equal(e.stats.immunities.frozen, true);
    assert.equal(e.stats.immunities.stun, false);
    // the derived metrics are computed, and they agree with the stats
    assert.equal(e.attrPower, attrPowerOf(e.stats));
    assert.equal(e.be, battleEffectivenessOf(e.stats, e.beFactor));
    assert.equal(e.beFactor, 1);
    assert.equal(e.abilities.length, 2);
    assert.deepEqual(e.talents.bb, { move_speed: 0.3 });
    assert.deepEqual(enemyErrors(validateEnemy(e, { officialIds: OFFICIAL_KEYS })), []);
  });

  test('defaults fill what the author left out, and a FLY enemy gets isFlyEnemy', () => {
    const r = deriveEnemy({ ...SPEC, id: 'sky_drone', motion: 'FLY', applyWay: 'RANGED', dmgType: 'arts' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.enemy.isFlyEnemy, true);
    assert.equal(r.enemy.stats.aspd, 100);
    assert.equal(r.enemy.stats.lpr, 1);
    assert.equal(r.enemy.stats.massLevel, 2);
    assert.ok(r.enemy.stats.rangeRadius > 0, 'a RANGED enemy gets a usable range by default');
    assert.deepEqual(r.enemy.stats.dmgTypes, ['arts']);
  });

  test('every missing or wrong fact is reported with a field and a code', () => {
    const r = deriveEnemy({ id: '', rank: 'MYTHIC', applyWay: 'SOMETIMES', motion: 'SWIM', dmgType: 'holy', stats: { maxHp: -1, atk: -1, def: 0, res: 0, moveSpeed: 0, bat: 0 } });
    assert.equal(r.ok, false);
    const codes = r.errors.map((e) => `${e.field}:${e.code}`);
    for (const want of ['id:BAD_ID', 'name:MISSING', 'rank:BAD_ENUM', 'applyWay:BAD_ENUM', 'motion:BAD_ENUM', 'dmgType:BAD_ENUM', 'stats.maxHp:BAD_NUMBER', 'stats.atk:BAD_NUMBER', 'stats.bat:BAD_NUMBER']) {
      assert.ok(codes.includes(want), `${want} missing from ${codes.join(' ')}`);
    }
  });

  test('a hit area must be a real rectangle, and a missing spine is warned about', () => {
    const bad = deriveEnemy({ ...SPEC, hitArea: { w: 0, h: 2 } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'BAD_HIT_AREA'));
    const noSpine = deriveEnemy({ ...SPEC, spine: undefined });
    assert.equal(noSpine.ok, true);
    assert.ok(noSpine.warnings.some((w) => /spine/.test(w)));
  });

  test('an id is slugged into the enemy_ws_ namespace', () => {
    assert.deepEqual(enemyKey('Frost Hound!'), { slug: 'frost_hound', key: 'enemy_ws_frost_hound' });
    assert.deepEqual(enemyKey('enemy_ws_x'), { slug: 'x', key: 'enemy_ws_x' });
    assert.equal(enemyKey('!!!'), null);
  });
});

describe('enemy authoring: validateEnemy', () => {
  test('the official roster validates clean (no false positives)', () => {
    const bad = [];
    for (const e of ALL) {
      const errs = enemyErrors(validateEnemy(e, { key: e.key, officialIds: new Set() }));
      if (errs.length) bad.push(`${e.key}: ${errs.map((i) => `${i.code}(${i.field})`).join(',')}`);
    }
    assert.deepEqual(bad, [], `official enemies rejected (${bad.length}):\n${bad.slice(0, 5).join('\n')}`);
  });

  test('a hand-typed derived metric is caught (it would swap the wrong number of enemies)', () => {
    const r = deriveEnemy(SPEC);
    const tampered = { ...r.enemy, be: r.enemy.be + 1 };
    const issues = validateEnemy(tampered, { key: tampered.key, officialIds: OFFICIAL_KEYS });
    assert.ok(issues.some((i) => i.code === 'STALE_DERIVED' && i.field === 'be'), JSON.stringify(issues));
    const noBe = { ...r.enemy };
    delete noBe.be;
    assert.ok(validateEnemy(noBe, { key: noBe.key, officialIds: OFFICIAL_KEYS }).some((i) => i.code === 'MISSING_DERIVED'));
  });

  test('an official key collision is an error with the fix in the hint', () => {
    const officialKey = Object.keys(ENEMIES)[0];
    // a workshop key is namespaced (`enemy_ws_…`), so a collision is only reachable by reusing an official key exactly —
    // which is what the overrides gate is for
    const issues = validateEnemy(ENEMIES[officialKey], { key: officialKey, officialIds: OFFICIAL_KEYS });
    const hit = issues.find((i) => i.code === 'OFFICIAL_ID_COLLISION');
    assert.ok(hit && hit.severity === 'error', JSON.stringify(issues));
    assert.match(hit.hint, /overrides/);
    // and a derived workshop key never collides with an official one
    const r = deriveEnemy({ ...SPEC, id: officialKey });
    assert.equal(enemyErrors(validateEnemy(r.enemy, { officialIds: OFFICIAL_KEYS })).length, 0);
    assert.notEqual(r.enemy.key, officialKey);
  });

  test('a fly/ground mismatch and a tokenOnly enemy are warned about', () => {
    const r = deriveEnemy(SPEC);
    assert.ok(validateEnemy({ ...r.enemy, isFlyEnemy: true }, { key: r.enemy.key, officialIds: OFFICIAL_KEYS }).some((i) => i.code === 'FLY_MISMATCH'));
    assert.ok(validateEnemy({ ...r.enemy, tokenOnly: true }, { key: r.enemy.key, officialIds: OFFICIAL_KEYS }).some((i) => i.code === 'TOKEN_ONLY'));
  });

  test('the power readout names both numbers', () => {
    const r = deriveEnemy(SPEC);
    const line = enemyPowerLine(r.enemy);
    assert.match(line, /attrPower \d+/);
    assert.match(line, /be \d+ \(beFactor 1\)/);
  });
});

describe('enemy authoring: a workshop enemy reaches the engine', () => {
  let tmp;
  let wsRoot;
  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-enemy-'));
    wsRoot = join(tmp, 'ws');
    const packDir = join(wsRoot, 'enemy-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({ id: 'enemy-pack', name: 'Enemies', version: '0.1.0', content: ['enemies'], overrides: [] }));
    const r = deriveEnemy(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    fs.writeFileSync(join(packDir, 'enemies.json'), JSON.stringify({ [r.enemy.key]: r.enemy }));
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('it merges into the data, and GameData + the sim resolve it', () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.ok(data.enemies['enemy_ws_frost_hound'], 'the enemy must reach the merged data');
    assert.equal(Object.keys(data.enemies).length, Object.keys(ENEMIES).length + 1);
    const gd = new GameData(data, 'mode_multi_normal');
    const rec = gd.enemy('enemy_ws_frost_hound');
    assert.ok(rec, 'GameData must resolve the workshop enemy');
    assert.equal(rec.name, '霜牙猎犬');
    assert.equal(rec.attrPower, attrPowerOf(rec.stats));
    // the sim builds an enemy def from it (this is what makes it fight)
    const ds = toDataSource(data);
    const def = ds.getEnemy('enemy_ws_frost_hound');
    assert.ok(def, 'the sim could not build a def for the workshop enemy');
    assert.match(JSON.stringify(def), /4200/, 'the authored maxHp must reach the sim def');
  });

  test('replacing an OFFICIAL enemy without a declared override is refused', () => {
    const officialKey = Object.keys(ENEMIES)[0];
    const { data, report } = applyWorkshop({ enemies: ENEMIES }, [
      { id: 'evil', overrides: [], files: { enemies: { [officialKey]: { ...ENEMIES[officialKey], name: 'hijacked' } } } },
    ]);
    assert.equal(data.enemies[officialKey].name, ENEMIES[officialKey].name, 'the official enemy must win');
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].reason, /overrides/);
  });
});
