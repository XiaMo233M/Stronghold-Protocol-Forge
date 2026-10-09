// test/overridePotential.test.js — 覆盖合并与 0.2.2 潜能注解的交叉：**作者改一个字段，不许顺手抹掉他没写的潜能链**。
//
// 背景（2026-10-09 实测发现）：0.2.2 给官方记录加了潜能注解 —— 记录层 `potDown`、天赋层 `potMin` + `potBelow`
// （`shared/potential.js` 的链式天赋）。而编辑器派生出来的记录**故意不带**这些注解（引擎约定：`stripPotential`
// 是「某一档建出来的记录长什么样」）。于是 A2 的「按字段合并」有一个静默缺口：
//   * `potDown` 活下来，只因为补丁从不提它（照抄官方）；
//   * `talents` 被整块替换 ⇒ **官方的潜能天赋链当场消失**，而 applyWorkshop 一句错都不报；
//     `potDown` 里指向天赋的那些叶子随即指向空气。
// 两条线不合流就永远测不到：合并函数在 feat/mod-layer，带注解的数据在 0.2.2 移植线上。
//
// 所以这条测试用的夹具是**手写的 0.2.2 形状**（不依赖任何一棵树的 data/，两边都能跑）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeRecord, OVERRIDE_KEYED_LISTS, OVERRIDE_REPLACE_KEYS } from '../shared/workshop.js';

/** 一条 0.2.2 形状的官方记录：44 字段的缩样 + 潜能注解（`potDown` 记录层、`potMin`/`potBelow` 天赋层）。 */
const official = () => ({
  chessId: 'chess_char_9_01_a', baseId: 'chess_char_9_01', goldenId: 'chess_char_9_01_b',
  name: '样例干员', rarity: 5, stats: { atk: 500, def: 200, maxHp: 3000, cost: 20 },
  statsBase: { atk: 480, def: 200, maxHp: 3000, cost: 20 },
  skill: { skillId: 'sk_1', bb: { atk: 1.5 } },
  talents: [
    { index: 0, name: '通流无阻', desc: '攻击未被阻挡的敌人时攻击力提升至 120%', potMin: 4, potBelow: { desc: '…至 110%' } },
    { index: 2, name: '第二个天赋', desc: '不随潜能变化', potMin: 1 },
  ],
  bonds: ['kazimierzShip'],
  immunities: ['stun'],
  // 记录层的潜能差分：低档相对满档改了什么
  potDown: { 0: { 'stats.cost': 30 }, 2: { 'stats.atk': 420 } },
});

/** 编辑器派生出来的记录：**不带**任何潜能注解（引擎约定），作者只改了一处。 */
const derived = (over = {}) => {
  const rec = official();
  delete rec.potDown;
  for (const t of rec.talents) { delete t.potMin; delete t.potBelow; }
  return { ...rec, ...over };
};

describe('覆盖 × 潜能注解：作者没写的潜能数据必须留下', () => {
  test('只改一个数值：`potDown` 原样保留（补丁不提它）', () => {
    const m = mergeRecord(official(), derived({ stats: { ...official().stats, atk: 999 } }));
    assert.equal(m.stats.atk, 999, '作者改的数值要生效');
    assert.deepEqual(m.potDown, official().potDown, '`potDown` 必须原样留下，否则整张潜能差分表消失');
    assert.equal(m.stats.def, 200, '没写的数值回退官方');
  });

  test('天赋按 `index` 合并：改文案不会抹掉 `potMin` / `potBelow`（这条就是本次修的那个缺口）', () => {
    const patch = derived();
    patch.talents[0] = { ...patch.talents[0], desc: '作者重写的说明' };
    const m = mergeRecord(official(), patch);
    const t0 = m.talents.find((t) => t.index === 0);
    assert.equal(t0.desc, '作者重写的说明', '作者的文案要生效');
    assert.equal(t0.potMin, 4, '`potMin` 是官方数据，作者没写 ⇒ 必须留下');
    assert.deepEqual(t0.potBelow, { desc: '…至 110%' }, '`potBelow` 链同样要留下');
    assert.equal(t0.name, '通流无阻', '没写的字段回退官方');
    // 第二个天赋（作者一字未动）应逐字节等于官方那一条
    assert.deepEqual(m.talents.find((t) => t.index === 2), official().talents[1]);
  });

  test('作者新增的天赋（`index` 不在官方里）被追加，不打乱官方那两条', () => {
    const patch = derived();
    patch.talents = [...patch.talents, { index: 9, name: '作者加的', desc: 'x' }];
    const m = mergeRecord(official(), patch);
    assert.equal(m.talents.length, 3);
    assert.deepEqual(m.talents.slice(0, 2).map((t) => t.index), [0, 2], '官方顺序不变');
    assert.equal(m.talents[2].name, '作者加的');
    assert.equal(m.talents[0].potMin, 4, '追加不能顺手重置别的条目');
  });

  test('只有**带身份键**的列表按条目合并；其余列表仍然整块替换（不许发明没人写过的记录）', () => {
    // 断言随规则更新（2026-10-09 第二轮审计）：`talentChanges`（模组内部的天赋改写）也带身份键
    // （`talentIndex`），它 0.2.2 里同样挂 `potMin`/`potBelow`，所以与 `talents` 是同一个缺口、同一条修法。
    // **不是为让测试变绿而放宽**：这一条仍然钉住「键控名单只有这三个」「裸列表整块替换」两件事。
    assert.deepEqual(OVERRIDE_KEYED_LISTS, { talents: 'index', talentsBase: 'index', talentChanges: 'talentIndex' });
    assert.ok(!OVERRIDE_REPLACE_KEYS.includes('talents'),
      '`talents` 不该再出现在「整块替换」名单里，否则上面那条修复就等于没做');
    assert.ok(!OVERRIDE_REPLACE_KEYS.includes('talentsBase'), '`talentsBase` 同理');
    assert.ok(OVERRIDE_REPLACE_KEYS.includes('modules'),
      '`modules` 自己仍然整块替换（它是有序列表，载入界面整体读它）—— 键控的是它**内部**的 `talentChanges`');
    const patch = derived({ bonds: ['sargonShip'], immunities: [] });
    const m = mergeRecord(official(), patch);
    assert.deepEqual(m.bonds, ['sargonShip'], '`bonds` 是裸列表 ⇒ 整块替换');
    assert.deepEqual(m.immunities, [], '空数组也是「作者这么写」⇒ 替换成空');
  });

  test('不改写输入（调用方可能拿着冻结的官方数据）', () => {
    const base = official();
    const before = structuredClone(base);
    const patch = derived({ stats: { ...official().stats, atk: 999 } });
    const patchBefore = structuredClone(patch);
    mergeRecord(base, patch);
    assert.deepEqual(base, before, '官方记录不得被改写');
    assert.deepEqual(patch, patchBefore, '补丁不得被改写');
  });
});
