// server/sim/content/sdkData.js — `sp:sdk@1` 的三个**冻结数据面**：`kit` / `math` / `constants`。
//
// 上游 `shared/plugins/sdk.js` 用动态 URL 组装它们（`kits/shared/tier1.js` + `detmath.js` + `constants.js`）；
// Forge 树这三样**同名存在**于同一条路径，所以这里静态 import、按上游同一份名单挑出 24 个 tier1 助手，
// 并用上游同一套冻结规则（records 深拷贝冻结、lists 浅冻结）。
//
// ⚠ 这里没有为插件准备 `Date` / `Math.random` / 任何 IO —— 与上游同一条纪律：
// "No ambient IO, storage, clocks or randomness is supplied"（`sdk.js:24`）。

import * as tier1 from './kits/shared/tier1.js';
import * as detmath from '../detmath.js';
import * as engineConstants from '../../../shared/constants.js';

const freeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

/** SDK-owned records 是不可变拷贝；Battle/Unit、hook 句柄与回调入参**绝不**递归冻结。 */
const recordHelpers = new Set(['talentBb', 'talentGrid', 'moduleBb', 'traitBb', 'skillRec', 'skillBbOf']);
const listHelpers = new Set(['enemiesInGrid', 'alliesInGridOf']);
const copyRecord = (v) => (v && typeof v === 'object'
  ? Object.freeze(Array.isArray(v) ? v.map(copyRecord) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copyRecord(x)])))
  : v);

/** Stable tier1 subset —— 与上游 `sdk.js:16-19` 逐字同一份 24 名单。 */
export const SDK_KIT_NAMES = Object.freeze([
  'num', 'talentBb', 'talentGrid', 'moduleBb', 'traitBb', 'moduleOn', 'up', 'cheb',
  'isMainHit', 'byEnemyAttack', 'skillBusy', 'giveSp', 'onHitBy', 'onHitOn', 'onDamagedOn', 'enemiesInGrid',
  'alliesInGridOf', 'enemyInRange', 'statBuff', 'toggleBuff', 'instantKind', 'skillRec', 'skillBbOf', 'batMod',
]);

const missing = SDK_KIT_NAMES.filter((k) => typeof tier1[k] !== 'function');
if (missing.length) throw new Error(`sdkData: tier1 is missing ${missing.join(', ')}`);

export const kit = Object.freeze(Object.fromEntries(SDK_KIT_NAMES.map((k) => [k,
  recordHelpers.has(k) ? (...args) => copyRecord(tier1[k](...args))
    : listHelpers.has(k) ? (...args) => Object.freeze([...tier1[k](...args)]) : tier1[k]])));

export const math = Object.freeze({ ...detmath });
export const constants = freeze({ ...engineConstants });
