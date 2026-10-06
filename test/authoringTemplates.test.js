// test/authoringTemplates.test.js — 「以现成内容为模板新建」的两个纯函数（shared/chessAuthoring.js 的
// specFromChessRecord、shared/enemyAuthoring.js 的 specFromEnemyRecord）。
//
// 为什么单独测这两个函数：它们是「新建干员/怪物更省事」这条链路的**唯一**转换点。判断标准很硬——
// 拿一份真实的官方记录转成 spec，再用 derive 转回去，两份记录在这些字段上必须逐项相同。
// 只要这条成立，模板新建就不可能悄悄丢掉干员的攻击范围、技能黑板或天赋；一旦哪天字段改名，
// 这条测试会先失败，而不是让用户保存出一个「看着像但其实少了东西」的干员。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { specFromChessRecord, deriveChessRecord, validateChessRecord, authoringErrors } from '../shared/chessAuthoring.js';
import { specFromEnemyRecord, deriveEnemy, validateEnemy, enemyErrors } from '../shared/enemyAuthoring.js';
import { statSummary, statReference, statPosition } from '../shared/statReference.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHESS = JSON.parse(readFileSync(join(ROOT, 'data', 'chess.json'), 'utf8'));
const ENEMIES = JSON.parse(readFileSync(join(ROOT, 'data', 'enemies.json'), 'utf8'));

/** 挑一对有技能、有天赋、有攻击范围的官方记录：模板测试要覆盖的正是这些「搬丢了也看不出来」的字段。 */
function pickPair() {
  for (const [id, rec] of Object.entries(CHESS)) {
    if (!rec || rec.isGolden) continue;
    const golden = rec.goldenId ? CHESS[rec.goldenId] : null;
    if (!golden) continue;
    if (!rec.skill || !Array.isArray(rec.talents) || !rec.talents.some((t) => t && t.desc)) continue;
    if (!Array.isArray(rec.rangeGrid) || !rec.rangeGrid.length) continue;
    if (!rec.assets || !rec.assets.spine) continue;
    return { id, rec, golden };
  }
  return null;
}

const PAIR = pickPair();

describe('模板新建：干员（specFromChessRecord）', () => {
  test('官方数据里找得到一对可当模板的记录（否则下面的往返测试没意义）', () => {
    assert.ok(PAIR, 'data/chess.json 里应该有带技能/天赋/攻击范围的官方干员对');
  });

  test('往返一次：模板派生的记录与原件在这些字段上逐项相同', () => {
    const { rec, golden } = PAIR;
    const spec = specFromChessRecord(rec, golden);
    spec.id = 'template_probe'; // 模板故意不带 id，这里给一个才能派生
    const out = deriveChessRecord(spec);
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const got = out.base;
    const gold = out.golden;

    // 身份与外观
    assert.equal(got.tier, rec.tier);
    assert.equal(got.profession, rec.profession);
    assert.equal(got.subProfessionId, rec.subProfessionId);
    assert.equal(got.position, rec.position);
    assert.equal(got.assets.spine, rec.assets.spine);
    assert.equal(got.trait.desc, rec.trait.desc);

    // 攻击范围：表单原本没有这一项，模板能不能把官方范围带过来就靠这里
    assert.deepEqual(got.rangeGrid, rec.rangeGrid);

    // 两态数值
    for (const k of ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat']) {
      assert.equal(got.stats[k], rec.stats[k], `普通态 ${k}`);
      assert.equal(gold.stats[k], golden.stats[k], `精锐态 ${k}`);
    }

    // 技能：类型、消耗、持续时间、黑板与技能范围
    assert.equal(got.skill.skillType, rec.skill.skillType);
    assert.equal(got.skill.durationType, rec.skill.durationType);
    assert.equal(got.skill.spType, rec.skill.spType);
    assert.equal(got.skill.spCost, rec.skill.spCost);
    assert.equal(got.skill.initSp, rec.skill.initSp);
    assert.equal(got.skill.duration, rec.skill.duration);
    assert.equal(got.skill.trigger.rule, rec.skill.trigger.rule);
    assert.deepEqual(got.skill.bb, rec.skill.bb);
    assert.equal(got.skill.desc, rec.skill.desc);

    // 天赋：名字、说明、黑板
    assert.equal(got.talents.length, rec.talents.length);
    got.talents.forEach((t, i) => {
      assert.equal(t.name, rec.talents[i].name);
      assert.equal(t.desc, rec.talents[i].desc);
      assert.deepEqual(t.bb, rec.talents[i].bb);
    });

    // 羁绊与价格/稀有度
    assert.deepEqual(got.bonds, rec.bonds);
    assert.equal(got.price, rec.price);
    assert.equal(got.rarity, rec.rarity);
  });

  test('模板不带 id（否则会直接撞官方 id），但带上名字供作者改名', () => {
    const { rec, golden } = PAIR;
    const spec = specFromChessRecord(rec, golden);
    assert.equal(spec.id, '');
    assert.equal(spec.name, rec.name);
    assert.equal(spec.appellation, rec.appellation);
  });

  test('派生出的记录不会撞官方 id，校验层 0 错误', () => {
    const { rec, golden } = PAIR;
    const spec = specFromChessRecord(rec, golden);
    spec.id = 'template_probe_2';
    const out = deriveChessRecord(spec);
    assert.equal(out.ok, true);
    const officialIds = new Set(Object.keys(CHESS));
    for (const r of [out.base, out.golden]) {
      assert.deepEqual(authoringErrors(validateChessRecord(r, { officialIds })), [], `${r.chessId} 应该 0 错误`);
    }
  });

  test('缺少精锐记录时，两态数值取同一份', () => {
    const { rec } = PAIR;
    const spec = specFromChessRecord(rec, null);
    assert.deepEqual(spec.stats.golden, spec.stats.normal);
  });

  test('不是对象就返回 null，不抛异常', () => {
    assert.equal(specFromChessRecord(null), null);
    assert.equal(specFromChessRecord('nope'), null);
    assert.equal(specFromChessRecord([]), null);
  });

  test('字段残缺的记录也能转，缺的用合理默认值补上', () => {
    const spec = specFromChessRecord({ name: '半份记录', tier: 3, profession: 'MEDIC', position: 'RANGED' });
    assert.equal(spec.name, '半份记录');
    assert.equal(spec.tier, 3);
    assert.equal(spec.profession, 'MEDIC');
    assert.equal(spec.subProfessionId, '');
    assert.equal(spec.assetsSpine, '');
    assert.deepEqual(spec.talents, []);
    assert.equal(spec.stats.normal.maxHp, 1400);
    assert.equal(spec.stats.normal.bat, 1.2);
    assert.equal(spec.skill, undefined, '没有技能就留空，别凭空造一个');
    const out = deriveChessRecord({ ...spec, id: 'half' });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
  });
});

// ---- 怪物 --------------------------------------------------------------------------------------------------------

/** 挑一只有机制文字、有 spine、有标签的官方怪：模板最容易搬丢的就是这几样。 */
function pickEnemy() {
  for (const rec of Object.values(ENEMIES)) {
    if (!rec || typeof rec.key !== 'string' || !rec.spine) continue;
    if (!Array.isArray(rec.abilities) || !rec.abilities.length) continue;
    if (!Array.isArray(rec.tags) || !rec.tags.length) continue;
    if (!Number.isFinite(rec.stats?.maxHp) || !Number.isFinite(rec.stats?.atk)) continue;
    return rec;
  }
  return null;
}

/** 双属性怪：只有 13 只，但正好是「复制模板会悄悄改行为」的那一类，单独挑一只来钉。 */
function pickMultiTypeEnemy() {
  return Object.values(ENEMIES).find((r) => r && Array.isArray(r.stats?.dmgTypes) && r.stats.dmgTypes.length > 1) || null;
}

const ENEMY = pickEnemy();
const MULTI = pickMultiTypeEnemy();
const STAT_KEYS = ['maxHp', 'atk', 'def', 'res', 'moveSpeed', 'bat', 'aspd', 'rangeRadius', 'rawRangeRadius', 'blockCnt',
  'massLevel', 'lpr', 'hpRecoveryPerSec', 'elementRes', 'elementDmgRes', 'hitRatePhys', 'hitRateArts', 'tauntLevel'];

describe('模板新建：怪物（specFromEnemyRecord）', () => {
  test('官方数据里找得到可当模板的怪物（否则下面的往返测试没意义）', () => {
    assert.ok(ENEMY, 'data/enemies.json 里应该有带机制文字/tags/spine 的官方怪');
  });

  test('往返一次：模板派生的记录与原件逐项相同（含 spine、机制文字、数值与派生量）', () => {
    const spec = specFromEnemyRecord(ENEMY);
    spec.id = 'template_probe';
    const out = deriveEnemy(spec);
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const got = out.enemy;

    assert.equal(got.name, ENEMY.name);
    assert.equal(got.rank, ENEMY.rank);
    assert.equal(got.applyWay, ENEMY.applyWay);
    assert.equal(got.desc, ENEMY.desc);
    assert.equal(got.spine, ENEMY.spine, '外观是模板最该带对的东西：填错只会静默变占位模型');
    assert.equal(got.modelScale, ENEMY.modelScale ?? null);
    assert.equal(got.beFactor, ENEMY.beFactor);

    for (const k of STAT_KEYS) {
      if (ENEMY.stats[k] === undefined) continue;
      assert.equal(got.stats[k], ENEMY.stats[k], `stats.${k}`);
    }
    assert.equal(got.stats.motion, ENEMY.stats.motion);
    assert.equal(got.stats.dmgType, ENEMY.stats.dmgType);
    assert.deepEqual(got.stats.dmgTypes, ENEMY.stats.dmgTypes);
    assert.deepEqual(got.stats.immunities, ENEMY.stats.immunities);
    assert.deepEqual(got.stats.otherImmunities, ENEMY.stats.otherImmunities);

    assert.deepEqual(got.abilities.map((a) => [a.text, a.format]), ENEMY.abilities.map((a) => [a.text, a.format]));
    assert.deepEqual(got.talents.bb, ENEMY.talents.bb);
    assert.deepEqual(got.skills, ENEMY.skills);
    assert.deepEqual(got.tags, ENEMY.tags);
    assert.equal(got.acType, ENEMY.acType);
    assert.deepEqual(got.acTypes, ENEMY.acTypes);
    assert.deepEqual(got.hitArea, ENEMY.hitArea);
    assert.deepEqual(got.attackAnim, ENEMY.attackAnim);
    assert.equal(got.isFlyEnemy, ENEMY.isFlyEnemy);
    assert.equal(got.notCountInTotal, ENEMY.notCountInTotal);

    // 派生量必须跟着数值走：抄错就会在游戏里变成另一种强度的怪
    assert.equal(got.be, ENEMY.be);
    assert.equal(got.attrPower, ENEMY.attrPower);
    assert.deepEqual(out.warnings, [], '模板是照着一只合法怪物生成的，不该有任何警告');
  });

  test('模板不带 key（否则撞官方 id），但带上名字供作者改名', () => {
    const spec = specFromEnemyRecord(ENEMY);
    assert.equal(spec.id, '');
    assert.equal(spec.name, ENEMY.name);
  });

  test('派生出的怪物不会撞官方 key，校验层 0 错误', () => {
    const spec = specFromEnemyRecord(ENEMY);
    spec.id = 'template_probe';
    const out = deriveEnemy(spec);
    assert.equal(out.ok, true);
    const officialIds = new Set(Object.keys(ENEMIES));
    assert.deepEqual(enemyErrors(validateEnemy(out.enemy, { officialIds })), []);
  });

  test('双属性怪复制过来还是双属性（不会被 spec 的单值 dmgType 吃掉一半）', () => {
    assert.ok(MULTI, 'data/enemies.json 里应该有同时打两种伤害的怪');
    const spec = specFromEnemyRecord(MULTI);
    spec.id = 'template_probe';
    const out = deriveEnemy(spec);
    assert.equal(out.ok, true);
    assert.deepEqual(out.enemy.stats.dmgTypes, MULTI.stats.dmgTypes);
  });

  test('不给 dmgTypes 时行为与以前一致：由 dmgType 推导', () => {
    const a = deriveEnemy({ id: 'x', name: 'x', dmgType: 'arts', stats: { maxHp: 10, atk: 1, def: 0, res: 0, moveSpeed: 1, bat: 1 } });
    assert.deepEqual(a.enemy.stats.dmgTypes, ['arts']);
    const b = deriveEnemy({ id: 'y', name: 'y', dmgType: 'none', stats: { maxHp: 10, atk: 0, def: 0, res: 0, moveSpeed: 1, bat: 1 } });
    assert.deepEqual(b.enemy.stats.dmgTypes, []);
  });

  test('不是对象就返回 null，不抛异常', () => {
    assert.equal(specFromEnemyRecord(null), null);
    assert.equal(specFromEnemyRecord('nope'), null);
    assert.equal(specFromEnemyRecord([]), null);
  });

  test('字段残缺的记录也能转，缺的用默认值补上', () => {
    const spec = specFromEnemyRecord({ key: 'enemy_1', name: '半份怪', stats: { maxHp: 500 } });
    assert.equal(spec.name, '半份怪');
    assert.equal(spec.rank, 'NORMAL');
    assert.equal(spec.applyWay, 'MELEE');
    assert.equal(spec.spine, undefined, '没有 spine 就不要硬塞一个空串');
    assert.deepEqual(spec.tags, []);
    const out = deriveEnemy({ ...spec, id: 'half' });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    assert.equal(out.enemy.stats.maxHp, 500);
    assert.equal(out.enemy.stats.bat, 1, '缺的数值走 ENEMY_STAT_DEFAULTS');
  });
});

// ---- 数值参照 ----------------------------------------------------------------------------------------------------

describe('数值参照：区间与刻度', () => {
  test('statSummary 给出 min / 中位 / max，脏值一律忽略', () => {
    assert.deepEqual(statSummary([5, 1, 3]), { min: 1, p50: 3, max: 5, count: 3 });
    assert.deepEqual(statSummary([1, 2, 3, 4]), { min: 1, p50: 2.5, max: 4, count: 4 });
    assert.deepEqual(statSummary([7]), { min: 7, p50: 7, max: 7, count: 1 });
    assert.deepEqual(statSummary([3, 'x', null, undefined, NaN, 9]), { min: 3, p50: 6, max: 9, count: 2 });
    assert.equal(statSummary([]), null);
    assert.equal(statSummary(null), null);
  });

  test('statReference 按分组统计，缺分组的不进表', () => {
    const items = [
      { prof: 'A', hp: 100 }, { prof: 'A', hp: 300 }, { prof: 'B', hp: 50 }, { prof: null, hp: 999 },
    ];
    const ref = statReference(items, { groupOf: (i) => i.prof, valueOf: (i, f) => i[f], fields: ['hp'] });
    assert.deepEqual(Object.keys(ref).sort(), ['A', 'B']);
    assert.deepEqual(ref.A.hp, { min: 100, p50: 200, max: 300, count: 2 });
    assert.deepEqual(ref.B.hp, { min: 50, p50: 50, max: 50, count: 1 });
    // 指定 otherGroup 时，缺分组的才被收进去
    const ref2 = statReference(items, { groupOf: (i) => i.prof, valueOf: (i, f) => i[f], fields: ['hp'], otherGroup: 'OTHER' });
    assert.deepEqual(ref2.OTHER.hp, { min: 999, p50: 999, max: 999, count: 1 });
  });

  test('statReference 对官方真实数据算得出各职业区间（每个职业至少有一条）', () => {
    const bases = Object.values(CHESS).filter((r) => r && !r.isGolden && r.visible && !r.isHidden && !r.isDiy);
    const ref = statReference(bases, { groupOf: (r) => r.profession, valueOf: (r, f) => r.stats?.[f], fields: ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat'] });
    const professions = new Set(bases.map((r) => r.profession));
    for (const p of professions) {
      assert.ok(ref[p], `职业 ${p} 应该有区间`);
      assert.ok(ref[p].maxHp.min > 0 && ref[p].maxHp.max >= ref[p].maxHp.min, `${p} 的生命区间要合理`);
      assert.equal(ref[p].maxHp.count, bases.filter((r) => r.profession === p).length);
    }
  });

  test('怪物按档位（rank）也能算区间', () => {
    const ref = statReference(Object.values(ENEMIES), { groupOf: (r) => r.rank, valueOf: (r, f) => r.stats?.[f], fields: ['maxHp', 'atk', 'def', 'res'] });
    assert.ok(ref.NORMAL.maxHp.count > 50);
    assert.ok(ref.ELITE.maxHp.p50 > ref.NORMAL.maxHp.p50, '精英怪的中位生命应该高于普通怪');
    assert.ok(ref.BOSS.maxHp.p50 > ref.ELITE.maxHp.p50, '领袖的中位生命应该高于精英');
  });

  test('statPosition 把数值映射到 0..1，并标出越界', () => {
    const ref = { min: 100, p50: 200, max: 300 };
    assert.deepEqual(statPosition(100, ref), { ratio: 0, aboveMax: false, belowMin: false });
    assert.deepEqual(statPosition(200, ref), { ratio: 0.5, aboveMax: false, belowMin: false });
    assert.deepEqual(statPosition(300, ref), { ratio: 1, aboveMax: false, belowMin: false });
    assert.deepEqual(statPosition(900, ref), { ratio: 1, aboveMax: true, belowMin: false });
    assert.deepEqual(statPosition(1, ref), { ratio: 0, aboveMax: false, belowMin: true });
    assert.equal(statPosition(1, { min: 5, p50: 5, max: 5 }).ratio, 0.5, '区间退化成一个点时画在中间');
    assert.equal(statPosition(NaN, ref), null);
    assert.equal(statPosition(1, null), null);
  });
});
