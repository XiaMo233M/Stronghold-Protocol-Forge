// test/content/workshopBond.test.js — 通用盟约加成（server/sim/content/bonds/dataDriven.js）。
//
// 这条通路存在的理由：官方 23 个盟约的效果按 id 写死在 core.js / addon/battle.js 里，所以工坊**新增**的盟约
// 原本只有数据面（阈值、计数、层数、禁用、界面），战斗里什么也不加。记录上写 `"genericBuffs": true` 的盟约
// 走这里：按它自己的黑板数值给成员加属性，与官方盟约同一个「直接乘算」桶。
//
// 两条最要紧的性质：
//   * 没有那个开关的盟约**一定**不会被这条通路碰到 —— 否则覆盖官方盟约的黑板会被叠加两次，平衡悄悄歪掉；
//   * 层数变化要立刻重算（与 炎 一样）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { gainLayers, setGameData, gameData } from '../../server/sim/content/support/index.js';
import { genericMods, usesGenericBuffs, buffKeyOf } from '../../server/sim/content/bonds/dataDriven.js';

const close = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`);
const DATA = gameData();

/** 一条「数据驱动」的盟约记录：只有通用加成需要的字段（官方记录的写法：`bb` + `buffs[env_gbuff_new]`）。 */
const genericBond = (o = {}) => {
  const bb = o.bb ?? { base_atk: 0.10, atk_per_stack: 0.01 };
  return {
    bondId: o.bondId ?? 'ws_generic',
    name: o.name ?? '工坊盟约',
    isCore: o.isCore ?? false,
    weight: o.weight ?? 5,
    thresholds: o.thresholds ?? [2, 4, 6],
    activeCount: 2,
    countMode: 'BOARD',
    bb,
    ...(o.flatBb ? {} : { buffs: [{ key: 'env_gbuff_new', bb }] }),
    genericBuffs: o.genericBuffs === undefined ? true : o.genericBuffs,
  };
};

/** 把数据里的盟约表换成一份带测试盟约的副本（测试进程独占，结束后还原）。 */
function withBonds(extra) {
  setGameData({ ...DATA, bonds: { ...DATA.bonds, ...extra } });
}

after(() => setGameData(null));

test('genericMods: 基线 + 每层，只写一边也合法，什么都不写就是 {}', () => {
  assert.deepEqual(genericMods({ buffs: [{ key: 'env_gbuff_new', bb: { base_atk: 0.1, atk_per_stack: 0.02 } }] }, 5), { atk: 0.2 });
  assert.deepEqual(genericMods({ buffs: [{ key: 'env_gbuff_new', bb: { atk_per_stack: 0.02 } }] }, 3), { atk: 0.06 });
  assert.deepEqual(genericMods({ buffs: [{ key: 'env_gbuff_new', bb: { base_def: 0.3, base_max_hp: 0.5 } }] }, 99), { def: 0.3, hp: 0.5 });
  assert.deepEqual(genericMods({ buffs: [{ key: 'env_gbuff_new', bb: { base_atk: 0, atk_per_stack: 0 } }] }, 3), {});
  assert.deepEqual(genericMods({ buffs: [] }, 3), {});
  assert.deepEqual(genericMods(null, 3), {});
  // 负值合法（可以做成「减益盟约」），引擎那边会在 0 处夹住
  assert.deepEqual(genericMods({ buffs: [{ key: 'env_gbuff_new', bb: { base_atk: -0.2 } }] }, 0), { atk: -0.2 });
});

test('usesGenericBuffs: 只有明确写 true 才算（缺字段 / 别的值都不算）', () => {
  assert.equal(usesGenericBuffs({ genericBuffs: true }), true);
  assert.equal(usesGenericBuffs({}), false);
  assert.equal(usesGenericBuffs({ genericBuffs: 'yes' }), false);
  assert.equal(usesGenericBuffs({ genericBuffs: 1 }), false);
  assert.equal(usesGenericBuffs(null), false);
  // 官方盟约记录里没有这个字段 —— 这是「不会被叠加两次」的依据
  assert.equal(usesGenericBuffs(DATA.bonds.yanShip), false);
});

test('战斗里：成员按层数拿到 ATK 加成，非成员不受影响', () => {
  withBonds({ ws_generic: genericBond() });
  const defs = { chess: { m1: chessRec({ id: 'm1', bonds: ['ws_generic'], skill: null }), n1: chessRec({ id: 'n1', bonds: [], skill: null }) } };
  const units = [{ chessId: 'm1', row: 10, col: 3 }, { chessId: 'n1', row: 11, col: 3 }];
  const h = makeBattle({ defs, units, bonds: { ws_generic: { count: 2, active: true, tier: 1, layers: 5 } } });
  h.step();
  close(h.unit('m1').s.atk, 500 * (1 + 0.10 + 0.01 * 5), '成员：基线 + 每层');
  close(h.unit('n1').s.atk, 500, '非成员');
  assert.ok(h.unit('m1').buffs.some((b) => b.key === buffKeyOf('ws_generic')), '挂的是通用盟约那个 key');

  // 层数变化 → 立刻重算（晚一个 tick，与官方盟约一致）
  gainLayers(h.b, { playerId: 'p1', bonds: 'ws_generic', n: 10 });
  h.step(2);
  close(h.unit('m1').s.atk, 500 * (1 + 0.10 + 0.01 * 15), '层数变化后重算');
  h.invariants();
});

test('防御与生命上限也走同一条路（直接乘算桶）', () => {
  withBonds({ ws_generic: genericBond({ bb: { base_def: 0.5, base_max_hp: 0.25 } }) });
  const defs = { chess: { m1: chessRec({ id: 'm1', bonds: ['ws_generic'], skill: null }) } };
  const h = makeBattle({ defs, units: [{ chessId: 'm1', row: 10, col: 3 }], bonds: { ws_generic: { count: 2, active: true, tier: 1, layers: 0 } } });
  h.step();
  close(h.unit('m1').s.def, 200 * 1.5, 'DEF +50%');
  close(h.unit('m1').s.maxHp, 2000 * 1.25, 'maxHP +25%');
  close(h.unit('m1').s.atk, 500, '没写 atk 就不动 ATK');
  h.invariants();
});

test('没有开关的盟约：这条通路一定不碰它（覆盖官方盟约不会被叠加两次）', () => {
  // 一条「长得像通用盟约」但没有开关的记录：数值在那儿，但引擎不该用它
  withBonds({ ws_noflag: genericBond({ bondId: 'ws_noflag', genericBuffs: false }) });
  const defs = { chess: { m1: chessRec({ id: 'm1', bonds: ['ws_noflag'], skill: null }) } };
  const h = makeBattle({ defs, units: [{ chessId: 'm1', row: 10, col: 3 }], bonds: { ws_noflag: { count: 2, active: true, tier: 1, layers: 5 } } });
  h.step();
  close(h.unit('m1').s.atk, 500, '没有 genericBuffs: true 就不加成');
  assert.equal(h.unit('m1').buffs.some((b) => String(b.key).startsWith('bond:generic:')), false);
  h.invariants();
});

test('未激活（tier 0）的通用盟约不加成 —— 与官方盟约一致，只有激活才生效', () => {
  withBonds({ ws_generic: genericBond() });
  const defs = { chess: { m1: chessRec({ id: 'm1', bonds: ['ws_generic'], skill: null }) } };
  const h = makeBattle({ defs, units: [{ chessId: 'm1', row: 10, col: 3 }], bonds: { ws_generic: { count: 1, active: false, tier: 0, layers: 9 } } });
  h.step();
  close(h.unit('m1').s.atk, 500, '没激活就没有加成');
  h.invariants();
});

test('手写包只写记录顶层的 bb 也能生效（官方写法之外的省事写法）', () => {
  withBonds({ ws_flat: genericBond({ bondId: 'ws_flat', flatBb: true, bb: { base_atk: 0.4 } }) });
  const defs = { chess: { m1: chessRec({ id: 'm1', bonds: ['ws_flat'], skill: null }) } };
  const h = makeBattle({ defs, units: [{ chessId: 'm1', row: 10, col: 3 }], bonds: { ws_flat: { count: 2, active: true, tier: 1, layers: 3 } } });
  h.step();
  close(h.unit('m1').s.atk, 500 * 1.4, '顶层 bb 也读');
  h.invariants();
});

test('所有配置了开关的盟约一起生效（互不覆盖：各自的 buff key）', () => {
  withBonds({
    ws_a: genericBond({ bondId: 'ws_a', bb: { base_atk: 0.10 } }),
    ws_b: genericBond({ bondId: 'ws_b', bb: { base_atk: 0.20 } }),
  });
  const defs = { chess: { m1: chessRec({ id: 'm1', bonds: ['ws_a', 'ws_b'], skill: null }) } };
  const h = makeBattle({
    defs, units: [{ chessId: 'm1', row: 10, col: 3 }],
    bonds: { ws_a: { count: 2, active: true, tier: 1, layers: 0 }, ws_b: { count: 3, active: true, tier: 1, layers: 0 } },
  });
  h.step();
  // 同一个桶里相加（DIRECT_BONUS_STACKING 'add'）
  close(h.unit('m1').s.atk, 500 * (1 + 0.10 + 0.20), '两个盟约的百分比相加');
  h.invariants();
});

test('官方盟约记录原样不受影响：炎 的加成仍然只来自官方处理器', () => {
  const defs = { chess: { y1: chessRec({ id: 'y1', bonds: ['yanShip'], skill: null }) } };
  const h = makeBattle({ defs, units: [{ chessId: 'y1', row: 10, col: 3 }], bonds: { yanShip: { count: 3, active: true, tier: 1, layers: 10 } } });
  h.step();
  const bb = DATA.bonds.yanShip.buffs[0].bb;
  close(h.unit('y1').s.atk, 500 * (1 + bb.base_atk + bb.atk_per_stack * 10), '官方数值，一次');
  assert.equal(h.unit('y1').buffs.some((b) => String(b.key).startsWith('bond:generic:')), false, '官方盟约不走通用通路');
  h.invariants();
});

test('敌人记录不会被当成通用盟约（只认数据里的 bonds 表）', () => {
  withBonds({ ws_generic: genericBond() });
  const defs = {
    chess: { m1: chessRec({ id: 'm1', bonds: ['ws_generic'], skill: null }) },
    enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e6, speed: 0 }) },
  };
  const h = makeBattle({ defs, units: [{ chessId: 'm1', row: 10, col: 3 }], enemies: [{ key: 'enemy_dummy', time: 0, route: 0 }], bonds: { ws_generic: { count: 2, active: true, tier: 1, layers: 4 } } });
  h.step();
  const e = h.enemy('enemy_dummy');
  assert.equal(e.buffs.some((b) => String(b.key).startsWith('bond:generic:')), false, '敌人不该拿到盟约加成');
  close(h.unit('m1').s.atk, 500 * (1 + 0.10 + 0.01 * 4));
  h.invariants();
});
