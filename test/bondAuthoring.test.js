// test/bondAuthoring.test.js — 盟约的创作层（shared/bondAuthoring.js）。
//
// 这一层的核心承诺是「往返一致」：官方 23 条盟约 → spec → 记录，字段必须原样回来，校验层 0 错误。
// 另外三条容易静默出错的规则也钉在这里：
//   * 阈值必须严格递增（引擎按第一个阈值算激活）；
//   * `activeCount` 必须等于第一个阈值（引擎的 fallback 就是它）；
//   * **新盟约没有 genericBuffs 就没有战斗加成** —— 这条要以 warning 说出来，不能安静地不加。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveBondRecord, specFromBondRecord, validateBondRecord, bondErrors, formatBondIssues,
  BOND_COUNT_MODES, BOND_THRESHOLD_TEMPLATES, BOND_ACTIVE_TYPES, GENERIC_BB_KEYS,
  looksLikeBondId, thresholdLine, genericBonusLine, battleEffectVerdict,
} from '../shared/bondAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BONDS = JSON.parse(readFileSync(join(ROOT, 'data/bonds.json'), 'utf8'));
const OFFICIAL_IDS = new Set(Object.keys(BONDS));
const EFFECTS = JSON.parse(readFileSync(join(ROOT, 'data/effects.json'), 'utf8'));
const ASSETS = JSON.parse(readFileSync(join(ROOT, 'data/assets.json'), 'utf8'));

/** 一份最小可用的新盟约 spec。 */
const spec = (o = {}) => ({
  id: 'testShip', name: '测试盟约', desc: '测试用', thresholds: [2, 4, 6], countMode: 'BOARD',
  weight: 10, genericBuffs: true, bb: { base_atk: 0.1, atk_per_stack: 0.01 }, ...o,
});

describe('盟约创作层：官方 23 条的往返', () => {
  test('每条官方盟约都能转成 spec 再转回来，关键字段一模一样', () => {
    for (const [id, rec] of Object.entries(BONDS)) {
      const s = specFromBondRecord(rec);
      assert.ok(s, `${id}: specFromBondRecord 应该返回对象`);
      s.id = id;
      const out = deriveBondRecord(s, { memberIds: rec.members });
      assert.equal(out.ok, true, `${id}: ${JSON.stringify(out.errors)}`);
      for (const k of ['name', 'isCore', 'weight', 'countMode', 'countsHand', 'countsGoldenOnly', 'thresholdTemplate', 'activeType', 'noStack']) {
        assert.deepEqual(out.bond[k], rec[k], `${id}.${k}`);
      }
      assert.deepEqual(out.bond.thresholds, rec.thresholds, `${id}.thresholds`);
      assert.equal(out.bond.activeCount, rec.thresholds[0], `${id}.activeCount`);
      assert.deepEqual(out.bond.members, [...rec.members].sort(), `${id}.members`);
      assert.equal(out.bond.bondId, id);
    }
  });

  test('转回来的 spec 不带 id（模板不能顺手撞官方 id）', () => {
    for (const rec of Object.values(BONDS)) assert.equal(specFromBondRecord(rec).id, '');
    assert.equal(specFromBondRecord(null), null);
    assert.equal(specFromBondRecord('nope'), null);
  });

  test('官方记录原样通过校验（把「覆盖」当成声明的除外）', () => {
    for (const [id, rec] of Object.entries(BONDS)) {
      const issues = validateBondRecord(rec, { id, officialIds: new Set(), engineIds: OFFICIAL_IDS });
      assert.deepEqual(bondErrors(issues), [], `${id}: ${formatBondIssues(issues)}`);
      // 官方盟约不报「没有通用加成就没有战斗加成」——它的效果在引擎里
      assert.equal(issues.some((i) => i.code === 'NO_IMPLEMENTATION'), false, id);
    }
  });

  test('官方 id 会报 OFFICIAL_ID_COLLISION，声明覆盖后不再报', () => {
    const rec = BONDS.yanShip;
    const collide = validateBondRecord(rec, { id: 'yanShip', officialIds: OFFICIAL_IDS, engineIds: OFFICIAL_IDS });
    assert.equal(collide.some((i) => i.code === 'OFFICIAL_ID_COLLISION' && i.severity === 'error'), true);
    assert.match(collide.find((i) => i.code === 'OFFICIAL_ID_COLLISION').hint, /bonds:yanShip/);
    // 本包声明了覆盖 → 调用方把这条从 officialIds 里去掉，于是 0 个错误
    assert.deepEqual(bondErrors(validateBondRecord(rec, { id: 'yanShip', officialIds: new Set(), engineIds: OFFICIAL_IDS })), []);
  });
});

describe('盟约创作层：校验挡住的东西', () => {
  test('id / 名称 / 阈值 / 枚举 / 权重', () => {
    const bad = deriveBondRecord({ ...spec(), id: '1bad', name: '', thresholds: [0, -1], countMode: 'NOPE' });
    assert.equal(bad.ok, false);
    const codes = bad.errors.map((e) => `${e.field}:${e.code}`);
    assert.ok(codes.includes('id:BAD_ID'), JSON.stringify(codes));
    assert.ok(codes.includes('name:MISSING'));
    assert.ok(codes.includes('thresholds:MISSING'), '全被过滤掉后就是没有阈值');
    assert.ok(codes.includes('countMode:BAD_ENUM'));

    const asc = deriveBondRecord(spec({ thresholds: [4, 4] }));
    assert.equal(asc.ok, false);
    assert.equal(asc.errors.some((e) => e.code === 'NOT_ASCENDING'), true);

    const bb = deriveBondRecord(spec({ bb: { base_atk: 'x' } }));
    assert.equal(bb.ok, false);
    assert.equal(bb.errors.some((e) => e.field === 'bb.base_atk'), true);
  });

  test('新盟约没打开通用加成 → 明确警告「战斗里什么也不加」', () => {
    const out = deriveBondRecord(spec({ genericBuffs: false }));
    assert.equal(out.ok, true);
    const issues = validateBondRecord(out.bond, { id: 'testShip', officialIds: OFFICIAL_IDS });
    const warn = issues.find((i) => i.code === 'NO_IMPLEMENTATION');
    assert.ok(warn, formatBondIssues(issues));
    assert.equal(warn.severity, 'warning');
    assert.match(warn.message, /no battle effect/);
  });

  test('打开了通用加成却一个键都没写 → 警告', () => {
    const out = deriveBondRecord(spec({ bb: {} }));
    assert.equal(out.warnings.some((w) => /战斗里不会有任何加成/.test(w)), true, JSON.stringify(out.warnings));
  });

  test('不认识的 / 只有官方才读的黑板键都要说出来', () => {
    const officialOnly = deriveBondRecord(spec({ bb: { base_atk: 0.1, power_bond_char_cnt: 6 } }));
    assert.equal(officialOnly.warnings.some((w) => /power_bond_char_cnt/.test(w) && /新盟约写了没用/.test(w)), true);
    const junk = deriveBondRecord(spec({ bb: { base_atk: 0.1, whatever_key: 1 } }));
    assert.equal(junk.warnings.some((w) => /whatever_key/.test(w)), true);
  });

  test('图标（按盟约 id 查）与效果 id 查不到时只是警告；覆盖官方盟约沿用官方图标', () => {
    const iconKeys = Object.keys(ASSETS.bonds ?? {});
    // 新 id：清单里没有 → 会显示圆点
    const fresh = deriveBondRecord(spec({ id: 'brandNewShip' }), { iconIds: iconKeys, effectIds: Object.keys(EFFECTS) });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.warnings.some((w) => /brandNewShip/.test(w) && /圆点/.test(w)), true);
    // 覆盖官方：官方 id 在清单里 → 安静
    const over = deriveBondRecord(spec({ id: 'yanShip' }), { iconIds: iconKeys, effectIds: Object.keys(EFFECTS) });
    assert.equal(over.warnings.some((w) => /圆点/.test(w)), false);
    // 效果 id 不在 data/effects.json 里 → 警告
    const eff = deriveBondRecord(spec({ effectId: 'bondeffect_nope' }), { iconIds: iconKeys, effectIds: Object.keys(EFFECTS) });
    assert.equal(eff.warnings.some((w) => /bondeffect_nope/.test(w)), true);
    const effOk = deriveBondRecord(spec({ effectId: 'bondeffect_yan' }), { iconIds: iconKeys, effectIds: Object.keys(EFFECTS) });
    assert.equal(effOk.warnings.some((w) => /bondeffect_yan/.test(w)), false);
  });

  test('缺少 desc / members / effectId 的警告', () => {
    const out = deriveBondRecord(spec({ desc: '', effectId: '' }));
    assert.equal(out.warnings.some((w) => /desc 是空的/.test(w)), true);
    const issues = validateBondRecord(out.bond, { id: 'testShip', officialIds: OFFICIAL_IDS });
    assert.equal(issues.some((i) => i.code === 'NO_EFFECT'), true);
    const noMembers = validateBondRecord({ ...out.bond, members: undefined }, { id: 'testShip', officialIds: OFFICIAL_IDS });
    assert.equal(noMembers.some((i) => i.code === 'MISSING' && i.field === 'members'), true);
  });

  test('weight 0 会被点出来（永不被禁），负权重是错误', () => {
    const out = deriveBondRecord(spec({ weight: 0 }));
    const issues = validateBondRecord(out.bond, { id: 'testShip', officialIds: OFFICIAL_IDS });
    assert.equal(issues.some((i) => i.code === 'NEVER_BANNED'), true);
    assert.deepEqual(bondErrors(issues), [], 'weight 0 合法，只是要说明');
    assert.equal(deriveBondRecord(spec({ weight: -1 })).ok, false);
  });

  test('activeCount 与第一个阈值不一致时报 MISMATCH', () => {
    const out = deriveBondRecord(spec());
    const issues = validateBondRecord({ ...out.bond, activeCount: 5 }, { id: 'testShip', officialIds: OFFICIAL_IDS });
    assert.equal(issues.some((i) => i.code === 'MISMATCH' && i.field === 'activeCount'), true);
  });

  test('非对象、坏 id 都不抛异常', () => {
    assert.equal(deriveBondRecord(null).ok, false);
    assert.equal(deriveBondRecord('x').ok, false);
    assert.equal(validateBondRecord(null)[0].code, 'NOT_AN_OBJECT');
    assert.equal(looksLikeBondId('1x'), false);
    assert.equal(looksLikeBondId('myShip'), true);
    assert.equal(looksLikeBondId('yan-ship.2'), true);
  });
});

describe('盟约创作层：派生的记录形状正确（引擎真的会读它）', () => {
  test('thresholds[0] 变成 activeCount，buffs 与顶层 bb 同步', () => {
    const out = deriveBondRecord(spec({ thresholds: [3, 6], bb: { base_atk: 0.2, atk_per_stack: 0.03 } }));
    assert.equal(out.bond.activeCount, 3);
    assert.deepEqual(out.bond.thresholds, [3, 6]);
    assert.deepEqual(out.bond.buffs, [{ key: 'env_gbuff_new', bb: { base_atk: 0.2, atk_per_stack: 0.03 }, bbStr: {} }]);
    assert.equal(out.bond.genericBuffs, true);
    assert.equal(out.bond.descRaw, out.bond.desc, 'descRaw 与 desc 同步（界面读的是 desc）');
  });

  test('没有黑板数值时不写空的 buffs（官方形状：没有就没有）', () => {
    const out = deriveBondRecord(spec({ bb: {}, genericBuffs: false }));
    assert.deepEqual(out.bond.buffs, []);
  });

  test('members 去重并排序（官方记录的写法）', () => {
    const out = deriveBondRecord(spec(), { memberIds: ['b', 'a', 'b', null, 'c'] });
    assert.deepEqual(out.bond.members, ['a', 'b', 'c']);
    assert.deepEqual(out.bond.visibleMembers, ['a', 'b', 'c']);
  });

  test('枚举常量与数据里的取值一致（数据长大时这条会失败，提醒更新）', () => {
    const modes = new Set(Object.values(BONDS).map((b) => b.countMode));
    const templates = new Set(Object.values(BONDS).map((b) => b.thresholdTemplate));
    const actives = new Set(Object.values(BONDS).map((b) => b.activeType));
    for (const m of modes) assert.ok(BOND_COUNT_MODES.includes(m), `数据里出现了新的 countMode: ${m}`);
    for (const t of templates) assert.ok(BOND_THRESHOLD_TEMPLATES.includes(t), `新的 thresholdTemplate: ${t}`);
    for (const a of actives) assert.ok(BOND_ACTIVE_TYPES.includes(a), `新的 activeType: ${a}`);
    assert.equal(GENERIC_BB_KEYS.length, 6);
  });

  test('界面文案：阈值阶梯 / 通用加成 / 战斗判定', () => {
    assert.equal(thresholdLine([2, 4, 6]), '2 名 / 4 名 / 6 名');
    assert.equal(thresholdLine([]), '');
    assert.equal(genericBonusLine({ base_atk: 0.1, atk_per_stack: 0.01 }), '攻击力 +10% +1%/层');
    assert.equal(genericBonusLine({}), '');
    assert.equal(battleEffectVerdict(BONDS.yanShip, { isOfficialId: true }).kind, 'official');
    assert.equal(battleEffectVerdict({ bb: { base_atk: 1 } }).kind, 'none');
    assert.equal(battleEffectVerdict({ bb: { base_atk: 1 }, genericBuffs: true }).kind, 'generic');
    assert.equal(battleEffectVerdict(null).kind, 'none');
  });
});
