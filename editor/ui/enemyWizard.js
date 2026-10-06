// editor/ui/enemyWizard.js — 怪物页「新建更容易」的纯逻辑：模板挑选与 spine 校验。
//
// 与干员页的 operatorWizard.js 同一条思路：判断留在纯函数里，界面只负责画，出错也测得住。
// 这里最要紧的一条是 spineIsKnown：spine 是**唯一一个填错不会报错、只在游戏里静默变成占位模型**的字段
// （官方 249 只怪共用 200 多个 prefab 键，作者基本不可能背下来）。

/** 档位从弱到强的顺序：模板列表按它分组，作者找「精英怪长什么样」时不用翻。 */
export const RANK_ORDER = Object.freeze(['NORMAL', 'ELITE', 'BOSS']);

/**
 * 按查询串挑怪物模板。名字与 key 任一命中即可（大小写不敏感；中文按原样匹配）。
 * @param {Array<{key:string,name?:string}>} list
 * @param {string} query
 */
export function matchEnemies(list, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = Array.isArray(list) ? list : [];
  if (!q) return [...all];
  return all.filter((e) => e && [e.name, e.key].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)));
}

/**
 * 模板列表排序：先按档位（普通 → 精英 → 领袖），同档按名字。
 * @param {Array<{key:string,name?:string,rank?:string}>} list
 */
export function sortTemplates(list) {
  const rankIdx = (r) => {
    const i = RANK_ORDER.indexOf(r);
    return i < 0 ? RANK_ORDER.length : i;
  };
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const d = rankIdx(a?.rank) - rankIdx(b?.rank);
    if (d) return d;
    return String(a?.name ?? a?.key ?? '').localeCompare(String(b?.name ?? b?.key ?? ''), 'zh-Hans-CN');
  });
}

/**
 * 填的 spine 是不是一个真的官方 prefab 键。
 *
 * 填错（或留空）时游戏不会报错：`assets.spineEntry()` 查不到就画一个占位菱形。所以界面要在这里主动说话。
 * 清单来自服务端（`/api/enemies` 的 spineChoices），为空时不判断（没数据就别乱警告）。
 *
 * @param {string} spine
 * @param {Array<{id:string}>|Set<string>} choices
 * @returns {'ok'|'unknown'|'empty'|'no-data'}
 */
export function spineIsKnown(spine, choices) {
  const ids = choices instanceof Set ? choices : new Set((Array.isArray(choices) ? choices : []).map((c) => (typeof c === 'string' ? c : c?.id)));
  if (!ids.size) return 'no-data';
  const v = String(spine ?? '').trim();
  if (!v) return 'empty';
  return ids.has(v) ? 'ok' : 'unknown';
}
