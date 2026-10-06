// server/sim/content/bonds/dataDriven.js — 「通用盟约加成」：给引擎没有逐条实现的盟约一条数据驱动的通路。
//
// 为什么需要它：官方 23 个盟约的效果都在 `bonds/core.js` 与 `bonds/addon/battle.js` 里**按 id 写死**，所以一个
// 新增的盟约原本只有数据面 —— 阈值、计数、层数、禁用抽签、干员详情、盟约条都正常，但战斗里什么也不加。
// 这个模块补上那一半：记录里写了 `"genericBuffs": true` 的盟约，按它自己的黑板数值给成员加属性，
// 走的是与官方盟约**同一个**「直接乘算」桶（support/index.js `directMods`），因此与技能/装备/其它盟约的 +X%
// 是相加关系（constant DIRECT_BONUS_STACKING 'add'，PRTS 盟约记录）。
//
// 黑板键（全部来自 `data/bonds.json` 的 `env_gbuff_new`，编辑器改一个数字立刻生效）：
//   base_atk    + atk_per_stack    × 层数   → 攻击力 +X%
//   base_def    + def_per_stack    × 层数   → 防御力 +X%
//   base_max_hp + max_hp_per_stack × 层数   → 生命上限 +X%
// 只写 `*_per_stack`（基线按 0 算）或只写 `base_*`（不看层数）都合法；三个都没有时这个盟约只有数据面。
//
// 为什么用记录上的开关，而不是「不在官方那 23 条里就自动生效」：那样一份**覆盖**了官方盟约的黑板会被叠加两次
// （官方处理器一次、这里一次），而双倍加成不会报错，只会让平衡悄悄歪掉 —— 这类错误最难发现。开关必须由作者明确
// 写出来；编辑器为新建的盟约自动勾上，并提醒「覆盖官方盟约时不要勾」。
//
// 谁受影响：`bondMembers`（自己携带该盟约的干员；核心盟约在 调和 生效时也含 调和 干员，support/index.js isMember）。
// 何时重算：战斗开始时一次，之后每次该盟约的层数变化再算一次（与 炎 的处理方式一致：层数变化要立刻反映）。

import {
  num, bondRecord, buffParams, bondTier, bondLayers, bondMembers, playerOps, passiveBuff, directMods,
} from '../support/index.js';

/** `[mods key, base bb key, per-layer bb key]`：三段都在 directMods 的量纲里（+0.3 = +30%）。 */
const RATIO_KEYS = Object.freeze([
  ['atk', 'base_atk', 'atk_per_stack'],
  ['def', 'base_def', 'def_per_stack'],
  ['hp', 'base_max_hp', 'max_hp_per_stack'],
]);

/** 一个通用盟约的 buff key：与官方处理器用的 `bond:<id>` 分开，免得两个来源互相覆盖。 */
export const buffKeyOf = (bondId) => `bond:generic:${bondId}`;

/**
 * 这个盟约的通用加成（`directMods` 的入参），没写任何数值时是 `{}`。纯函数，测试直接用。
 *
 * 黑板来源有两处，顺序是「官方记录的写法优先」：`buffs[].key === 'env_gbuff_new'` 的 `bb`（官方每条盟约都这么写），
 * 其次记录顶层的 `bb`（手写包最省事的写法）。两处都没有就是 `{}` —— 这个盟约只有数据面。
 */
export function genericMods(rec, layers = 0) {
  const bb = buffParams(rec, 'env_gbuff_new') ?? (rec && typeof rec.bb === 'object' && rec.bb ? rec.bb : null);
  if (!bb) return {};
  const out = {};
  for (const [key, baseKey, perKey] of RATIO_KEYS) {
    const v = num(bb[baseKey]) + num(bb[perKey]) * num(layers);
    if (Number.isFinite(v) && v !== 0) out[key] = v;
  }
  return out;
}

/** 这个盟约吃不吃通用加成（`genericBuffs: true`，且记录真的在数据里）。 */
export function usesGenericBuffs(rec) {
  return !!(rec && typeof rec === 'object' && rec.genericBuffs === true);
}

function applyBond(battle, pid, bondId) {
  const rec = bondRecord(bondId);
  if (!rec) return;
  const mods = directMods(genericMods(rec, bondLayers(battle, pid, bondId)));
  const key = buffKeyOf(bondId);
  for (const u of bondMembers(battle, pid, bondId)) passiveBuff(battle, u, key, mods);
}

function apply(battle, st, onlyId = null) {
  for (const id of st.ids) {
    if (onlyId && id !== onlyId) continue;
    applyBond(battle, st.pid, id);
  }
}

export function install(battle) {
  if (!battle || !Array.isArray(battle.players) || !battle.players.length) return;
  const states = [];
  for (const p of battle.players) {
    const live = p && p.bonds && typeof p.bonds === 'object' ? p.bonds : null;
    if (!live) continue;
    const ids = [];
    for (const id of Object.keys(live)) {
      if (!usesGenericBuffs(bondRecord(id))) continue;
      if (bondTier(battle, p.playerId, id) <= 0) continue; // 只有激活的盟约给加成（与官方盟约一致）
      ids.push(id);
    }
    if (ids.length) states.push({ pid: p.playerId, ids, pending: new Set() });
  }
  if (!states.length) return;
  const byPid = Object.create(null);
  for (const st of states) { byPid[st.pid] = st; apply(battle, st); }
  // 层数变化：晚一个 tick 再读（gainLayers 在本 hook 之后才写进 live 状态；与 core.js 的处理方式一致）
  battle.on('layerGain', (c) => {
    const st = byPid[c.playerId];
    if (!st || !st.ids.includes(c.bondId) || st.pending.has(c.bondId)) return;
    st.pending.add(c.bondId);
    battle.after(0, () => { st.pending.delete(c.bondId); apply(battle, st, c.bondId); });
  });
}

/** 让测试与校验工具能问「这个玩家现在有哪些通用盟约在生效」。未被 install 时返回 []。 */
export function genericBondIds(battle) {
  const out = [];
  for (const p of Array.isArray(battle && battle.players) ? battle.players : []) {
    const live = p && p.bonds && typeof p.bonds === 'object' ? p.bonds : {};
    for (const id of Object.keys(live)) {
      if (usesGenericBuffs(bondRecord(id)) && bondTier(battle, p.playerId, id) > 0) out.push(id);
    }
  }
  return out;
}

/** 操作者列表（导出给测试断言「谁吃到了加成」用）。 */
export const genericMembers = (battle, pid, bondId) => bondMembers(battle, pid, bondId);
/** 该玩家的全部干员（测试用：确认加成的范围）。 */
export const opsOf = (battle, pid) => playerOps(battle, pid);
