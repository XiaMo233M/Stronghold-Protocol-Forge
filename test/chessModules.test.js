// test/chessModules.test.js — 干员创作层的三件新东西：职业/位置名称表、攻击分类的显式覆盖、以及**模组**。
//
// 模组这一段是重点，因为它是「不报错但游戏里表现不对」的高危区：官方数据把精锐记录分成两套 ——
// `statsBase/traitBase/talentsBase` 是**不带模组**的原样，`stats/trait/talents` 是**带默认模组**的样子。
// 派生时少烘一半，玩家选「不装备」就会得到带模组的数值；多烘一半，默认模组就会被算两次。
// 所以这里的核心断言是：**官方 110 位带模组的干员，spec → 记录 的往返逐字节一致**（含富文本与 bbStr）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveChessRecord, specFromChessRecord, validateChessRecord, authoringErrors, classify,
  PROFESSIONS, PROFESSION_NAMES, POSITION_NAMES, DMG_TYPES, ATTACK_KINDS, PROJECTILES,
  TRIGGER_RULES, KNOWN_CUSTOM_TRIGGER_RULES,
} from '../shared/chessAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHESS = JSON.parse(readFileSync(join(ROOT, 'data/chess.json'), 'utf8'));
const SPINE = Object.keys(JSON.parse(readFileSync(join(ROOT, 'data/assets.json'), 'utf8')).chars || {})[0] ?? '';

const base = (o = {}) => ({
  id: 'modprobe', name: '模组测试', tier: 4, profession: 'SNIPER', subProfessionId: 'fastshot',
  position: 'RANGED', assetsSpine: SPINE,
  stats: {
    normal: { maxHp: 1000, atk: 300, def: 100, res: 0, cost: 15, blockCnt: 1, bat: 1 },
    golden: { maxHp: 1300, atk: 400, def: 130, res: 0, cost: 15, blockCnt: 1, bat: 1 },
  },
  ...o,
});
const noErr = (rec, id) => assert.deepEqual(
  authoringErrors(validateChessRecord(rec, { id, officialIds: new Set() })).filter((e) => e.code !== 'CLASS_OVERRIDE'),
  [], `${id}: ${JSON.stringify(authoringErrors(validateChessRecord(rec, { id, officialIds: new Set() })))}`,
);

describe('干员创作层：职业与位置的名称表', () => {
  test('每个职业都有中文与英文名，且与 PROFESSIONS 一一对应', () => {
    assert.deepEqual(Object.keys(PROFESSION_NAMES).sort(), [...PROFESSIONS].sort());
    for (const [id, n] of Object.entries(PROFESSION_NAMES)) {
      assert.ok(n.zh && n.en, id);
      assert.match(n.zh, /[\u4e00-\u9fff]/, `${id} 的中文名`);
      assert.doesNotMatch(n.en, /[\u4e00-\u9fff]/, `${id} 的英文名不该有中文`);
    }
    // 中文名必须是官方职业名（这份表是界面显示的来源，写错就等于给作者指错路）
    assert.equal(PROFESSION_NAMES.TANK.zh, '重装');
    assert.equal(PROFESSION_NAMES.PIONEER.zh, '先锋');
    assert.equal(PROFESSION_NAMES.SPECIAL.zh, '特种');
  });

  test('位置表覆盖 MELEE / RANGED 两个取值', () => {
    assert.deepEqual(Object.keys(POSITION_NAMES).sort(), ['MELEE', 'RANGED']);
    assert.equal(POSITION_NAMES.MELEE.zh, '近战');
    assert.equal(POSITION_NAMES.RANGED.zh, '远程');
  });

  test('职业名表与官方数据实际用到的职业集合一致（漂移守卫）', () => {
    const used = new Set();
    for (const r of Object.values(CHESS)) if (r && r.profession) used.add(r.profession);
    assert.deepEqual([...used].sort(), [...PROFESSIONS].sort(), '官方数据里出现了 PROFESSIONS 之外的职业');
  });

  test('官方每个分支 id 都有中文名（编辑器显示它，不该出现空白）', () => {
    const missing = [];
    for (const r of Object.values(CHESS)) {
      if (!r || !r.subProfessionId) continue;
      if (typeof r.subProfessionName !== 'string' || !r.subProfessionName) missing.push(r.subProfessionId);
    }
    assert.deepEqual([...new Set(missing)], [], '这些分支在 data/chess.json 里没有 subProfessionName');
  });
});

describe('干员创作层：攻击分类的显式覆盖', () => {
  test('不写覆盖时按职业与分支推导', () => {
    const out = deriveChessRecord(base());
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const d = classify({ profession: 'SNIPER', subProfessionId: 'fastshot', position: 'RANGED' });
    assert.equal(out.base.dmgType, d.dmgType);
    assert.equal(out.base.attackKind, d.attackKind);
    assert.equal(out.base.canHitFly, d.canHitFly);
    assert.equal(out.warnings.some((w) => /覆盖了/.test(w)), false);
  });

  test('写了覆盖就用写的，并说明覆盖了推导值', () => {
    // 同分支但打不到空中：要塞那类特例
    const out = deriveChessRecord(base({ subProfessionId: 'fortress', dmgType: 'arts', attackKind: 'ranged', canHitFly: true, projectile: 'bolt' }));
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    assert.equal(out.base.dmgType, 'arts');
    assert.equal(out.base.canHitFly, true, '显式覆盖优先于推导');
    assert.equal(out.base.projectile, 'bolt');
    assert.equal(out.warnings.some((w) => /dmgType 覆盖了/.test(w)), true, JSON.stringify(out.warnings));
    assert.equal(out.warnings.some((w) => /canHitFly 覆盖了/.test(w)), true);
  });

  test('覆盖值必须在枚举里，否则拒绝（引擎会拿它比对，错值等于永远不相等）', () => {
    assert.equal(deriveChessRecord(base({ dmgType: 'magic' })).ok, false);
    assert.equal(deriveChessRecord(base({ attackKind: 'splash' })).ok, false);
    assert.equal(deriveChessRecord(base({ projectile: 'laser' })).ok, false);
    const errs = validateChessRecord({ ...deriveChessRecord(base()).base, dmgType: 'nope' }, { id: 'x' });
    assert.equal(errs.some((e) => e.code === 'BAD_ENUM' && e.field === 'dmgType'), true);
    assert.deepEqual([...DMG_TYPES].slice(0, 3), ['phys', 'arts', 'heal']);
    assert.ok(ATTACK_KINDS.includes('none') && PROJECTILES.includes('orb'));
  });

  test('记录里的覆盖会被 validate 报成 CLASS_OVERRIDE（提醒，不是错误）', () => {
    const out = deriveChessRecord(base({ canHitFly: true, subProfessionId: 'fortress' }));
    const issues = validateChessRecord(out.base, { id: out.base.chessId });
    const warn = issues.find((i) => i.code === 'CLASS_OVERRIDE');
    assert.ok(warn, JSON.stringify(issues));
    assert.equal(warn.severity, 'warning');
  });

  test('模板只在「与推导不同」时才带上覆盖（否则改个职业还会留着旧分类）', () => {
    const official = Object.values(CHESS).find((r) => r && r.visible && !r.isGolden && !r.isHidden && !r.isDiy);
    const plain = specFromChessRecord(official);
    for (const k of ['dmgType', 'attackKind', 'projectile', 'canHitFly']) {
      assert.equal(k in plain, false, `${k} 不该出现在常规模板里`);
    }
    const odd = { ...official, canHitFly: official.canHitFly !== true };
    assert.equal(specFromChessRecord(odd).canHitFly, odd.canHitFly);
  });
});

describe('干员创作层：模组', () => {
  const MODULE = {
    id: 'uniequip_ws_probe', name: '测试模组', type: 'MOD-X', isDefault: true, level: 1,
    attr: { maxHp: 80, atk: 22 },
    traitDesc: '优先攻击空中单位', traitBb: { atk_scale: 1.1 }, moduleDesc: '攻击空中单位时攻击力提升至110%',
    talentChanges: [{ talentIndex: -1, bb: { move_speed: 0.2 }, hidden: true }],
  };

  test('默认模组会烘进精锐记录，同时留下不带模组的 Base 三件套', () => {
    const out = deriveChessRecord(base({ modules: [MODULE] }));
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const g = out.golden;
    assert.equal(g.statsBase.maxHp, 1300, 'statsBase 是 spec 里的精锐数值（不带模组）');
    assert.equal(g.stats.maxHp, 1380, 'stats 加了模组的 attr');
    assert.equal(g.stats.atk, 422);
    assert.equal(g.trait.moduleDesc, '攻击空中单位时攻击力提升至110%');
    assert.equal(g.trait.bb.atk_scale, 1.1);
    assert.equal(g.statsBase.atk, 400, 'Base 不该被模组改过');
    assert.deepEqual(g.modules.map((m) => m.uniEquipId), ['uniequip_ws_probe']);
    assert.equal(g.modules[0].icon, 'uniequip_ws_probe');
    assert.equal(g.modules[0].typeIcon, 'mod-x');
    assert.deepEqual(g.modules[0].attr, { maxHp: 80, atk: 22 });
    assert.equal(g.module.active, true, '精锐记录自己的默认模组是 active');
    assert.equal(g.module.id, 'uniequip_ws_probe');
    // 普通记录只有一个指针、不 active
    assert.equal(out.base.module.active, false);
    assert.equal(out.base.module.level, 0);
    assert.equal(out.base.modules, undefined, '普通记录不带 modules');
    noErr(out.golden, g.chessId);
    noErr(out.base, out.base.chessId);
  });

  test('没有模组时不写 modules，指针是官方那个「空」形状', () => {
    const out = deriveChessRecord(base());
    assert.equal('modules' in out.golden, false);
    assert.deepEqual(out.golden.module, { id: null, name: null, type: null, level: 1, active: false });
    assert.deepEqual(out.base.module, { id: null, name: null, type: null, level: 1, active: false });
    // 有默认模组时，普通记录的指针是 level 0（官方形状）
    const withMod = deriveChessRecord(base({ modules: [{ id: 'm', name: 'M', isDefault: true, attr: { atk: 5 } }] }));
    assert.equal(withMod.base.module.level, 0);
    assert.equal(withMod.golden.module.level, 1);
  });

  test('只写 attr 的模组（不改特性）不生成 traitOverride', () => {
    const out = deriveChessRecord(base({ modules: [{ id: 'm1', name: '只加数值', isDefault: true, attr: { atk: 10 } }] }));
    assert.equal(out.golden.modules[0].traitOverride, null);
    assert.equal(out.golden.stats.atk, 410);
    assert.equal(out.golden.trait.desc, '', '没有 traitOverride 就用基础特性');
  });

  test('模组的 traitOverride 与 talentChanges 会换成精锐的特性/天赋', () => {
    const out = deriveChessRecord(base({
      traitDesc: '基础特性文字', talents: [{ name: '天赋一', desc: '说明', bb: { atk: 0.1 } }],
      modules: [{ id: 'm1', name: 'M', isDefault: true, traitDesc: '模组特性', traitBb: { atk_scale: 1.2 },
        talentChanges: [{ talentIndex: 0, desc: '模组改过的天赋', bb: { atk: 0.2 } }] }],
    }));
    const g = out.golden;
    assert.equal(g.trait.desc, '模组特性');
    assert.equal(g.traitBase.desc, '基础特性文字', 'base 那一份保留原样');
    assert.equal(g.talents.find((t) => t.index === 0).desc, '模组改过的天赋');
    assert.equal(g.talents.find((t) => t.index === 0).bb.atk, 0.2);
    assert.equal(g.talentsBase.find((t) => t.index === 0).desc, '说明');
  });

  test('没有 isDefault 时警告，并说明精锐按「不带模组」生成', () => {
    const out = deriveChessRecord(base({ modules: [{ id: 'm1', name: 'A', attr: { atk: 5 } }] }));
    assert.equal(out.warnings.some((w) => /isDefault/.test(w)), true, JSON.stringify(out.warnings));
    assert.equal(out.golden.stats.atk, 400, '不烘任何模组');
    const issues = validateChessRecord(out.golden, { id: out.golden.chessId });
    assert.equal(issues.some((i) => i.code === 'NO_DEFAULT'), true);
  });

  test('两个默认模组是错误（载入界面只有一个默认）', () => {
    const out = deriveChessRecord(base({ modules: [{ id: 'a', name: 'A', isDefault: true }, { id: 'b', name: 'B', isDefault: true }] }));
    const issues = validateChessRecord(out.golden, { id: out.golden.chessId });
    assert.equal(issues.some((i) => i.code === 'MULTIPLE_DEFAULTS' && i.severity === 'error'), true);
  });

  test('坏模组（没 id / 重复 id / attr 不是数字 / talentIndex 不是整数）都报出来', () => {
    const bad = { ...deriveChessRecord(base()).golden, modules: [
      { uniEquipId: 'ok', name: 'A', attr: { atk: 5 } },
      { uniEquipId: 'ok', name: '重复' },
      { uniEquipId: 'ok2', name: 'B', attr: { atk: 'x' } },
      { uniEquipId: 'ok3', name: 'C', talentChanges: [{ talentIndex: 'zero' }] },
      { name: '没有 id' },
    ] };
    const codes = validateChessRecord(bad, { id: bad.chessId }).map((i) => i.code);
    for (const want of ['DUPLICATE', 'BAD_NUMBER', 'BAD_INDEX', 'BAD_ID']) assert.ok(codes.includes(want), `${want} 缺失：${codes}`);
  });

  test('普通记录上写 modules 只是警告（引擎只在精锐上读它）', () => {
    const out = deriveChessRecord(base({ modules: [MODULE] }));
    const issues = validateChessRecord({ ...out.base, modules: out.golden.modules }, { id: out.base.chessId });
    assert.equal(issues.some((i) => i.code === 'MODULES_ON_NORMAL' && i.severity === 'warning'), true);
  });

  test('官方 110 位带模组的干员：spec → 记录 逐字节往返一致（含富文本与 bbStr）', () => {
    let checked = 0;
    for (const [id, g] of Object.entries(CHESS)) {
      if (!g.isGolden || !Array.isArray(g.modules) || !g.modules.length) continue;
      const rec = CHESS[g.baseId];
      if (!rec || !rec.visible || rec.isHidden || rec.isDiy) continue;
      const spec = specFromChessRecord(rec, g);
      spec.id = `rt_${id.replace(/^chess_char_/, '').replace(/_b$/, '')}`;
      const out = deriveChessRecord(spec);
      assert.equal(out.ok, true, `${id}: ${JSON.stringify(out.errors)}`);
      assert.deepEqual(out.golden.modules, g.modules, `${id}: modules`);
      assert.deepEqual(out.golden.trait, g.trait, `${id}: trait`);
      assert.deepEqual(out.golden.stats, g.stats, `${id}: stats（含默认模组）`);
      assert.deepEqual(out.golden.statsBase, g.statsBase, `${id}: statsBase（不带模组）`);
      assert.deepEqual(out.golden.talents, g.talents, `${id}: talents`);
      assert.deepEqual(out.golden.module, g.module, `${id}: module 指针`);
      checked++;
    }
    assert.ok(checked >= 100, `只往返了 ${checked} 位，样本太少`);
  });

  // 完整覆盖：**每一位**可见干员都做一次模板往返。这份名单是已知的例外 —— 官方数据在它身上用了 spec 层
  // 没有表达方式的写法（集成战略专属的天赋数组），名单**固定**：出现新名字就说明派生层退化了。
  test('全量 112 位可见干员的模板往返：只允许 1 位已知例外', () => {
    const KNOWN = new Set(['chess_char_5_14_a']);
    const offenders = [];
    let checked = 0;
    for (const [id, rec] of Object.entries(CHESS)) {
      if (!rec.visible || rec.isGolden || rec.isHidden || rec.isDiy) continue;
      const g = CHESS[rec.goldenId];
      const spec = specFromChessRecord(rec, g);
      spec.id = `rt_${id.replace(/^chess_char_/, '').replace(/_a$/, '')}`;
      const out = deriveChessRecord(spec);
      if (!out.ok) { offenders.push(`${id}(derive)`); continue; }
      const diffs = [];
      for (const k of ['stats', 'statsBase', 'talents', 'talentsBase', 'trait', 'traitBase', 'modules', 'module', 'rangeGrid', 'dmgType', 'attackKind', 'projectile', 'canHitFly', 'bonds', 'price', 'rarity']) {
        if (g && JSON.stringify(out.golden[k]) !== JSON.stringify(g[k])) diffs.push(k);
      }
      for (const k of ['stats', 'talents', 'trait', 'rangeGrid']) {
        if (JSON.stringify(out.base[k]) !== JSON.stringify(rec[k])) diffs.push(`base.${k}`);
      }
      if (diffs.length) offenders.push(`${id}(${diffs.join('+')})`);
      checked++;
    }
    assert.ok(checked >= 112, `只查了 ${checked} 位`);
    const unexpected = offenders.filter((o) => !KNOWN.has(o.split('(')[0]));
    assert.deepEqual(unexpected, [], '这些干员的模板往返出现了新的差异（派生层退化了）');
    assert.equal(offenders.length, KNOWN.size, `已知例外数变了：${offenders.join(' ')}`);
  });

  test('官方数据里的两个自定义触发规则不再让那几位干员做不了模板', () => {
    const custom = Object.entries(CHESS).filter(([, r]) => r && r.skill && r.skill.trigger && !TRIGGER_RULES.includes(r.skill.trigger.rule));
    assert.ok(custom.length > 0, '官方数据里应该有自定义触发规则（否则这条测试没意义）');
    for (const [id, r] of custom) {
      assert.ok(KNOWN_CUSTOM_TRIGGER_RULES.includes(r.skill.trigger.rule), `${id}: ${r.skill.trigger.rule} 需要加进 KNOWN_CUSTOM_TRIGGER_RULES`);
      const baseRec = CHESS[r.baseId] ?? r;
      const spec = specFromChessRecord(baseRec, CHESS[baseRec.goldenId]);
      spec.id = `trig_${id.replace(/^chess_char_/, '')}`;
      const out = deriveChessRecord(spec);
      assert.equal(out.ok, true, `${id}: ${JSON.stringify(out.errors)}`);
      // 已知的自定义规则不报警（它们靠手写 kit 才动，这是官方本来的样子）……
      const known = validateChessRecord(out.base, { id: out.base.chessId });
      assert.equal(known.some((i) => i.code === 'TRIGGER_CUSTOM'), false, `${id} 是已知自定义规则，不该报警`);
    }
    // ……而一个引擎与官方都没用过的规则要提醒
    const odd = deriveChessRecord({
      ...specFromChessRecord(Object.values(CHESS).find((r) => r.visible && !r.isGolden && !r.isHidden && !r.isDiy)),
      id: 'trig_odd', skill: { name: 's', desc: 'd', spCost: 10, initSp: 0, bb: {}, triggerRule: 'SOME_NEW_RULE' },
    });
    assert.equal(odd.ok, true, JSON.stringify(odd.errors));
    assert.equal(validateChessRecord(odd.base, { id: odd.base.chessId }).some((i) => i.code === 'TRIGGER_CUSTOM'), true);
  });
});
