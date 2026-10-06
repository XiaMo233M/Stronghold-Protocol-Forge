// editor/ui/operatorWizard.js — 首页「新建干员」的纯逻辑：模板挑选、id 冲突、分支候选、范围格。
//
// 刻意不碰 DOM：这些判断都要能单独测（新建是最容易出错的一步——错了就是保存出一份不该存在的记录）。
// 界面部分留在 app.js 里，只负责把这里的结果画出来。
// 数值尺子（干员与怪物共用）在 editor/ui/statScale.js。

/**
 * 按查询串挑官方干员。名称、英文代号、id 三者任一命中即算（大小写不敏感；中文按原样匹配）。
 * 空查询返回全部；不改变输入顺序（服务端已按阶与 id 排好）。
 * @param {Array<{id:string,name?:string,appellation?:string}>} list
 * @param {string} query
 */
export function matchOperators(list, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = Array.isArray(list) ? list : [];
  if (!q) return [...all];
  return all.filter((o) => {
    if (!o) return false;
    return [o.name, o.appellation, o.id].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
  });
}

/**
 * 新干员的 id 会不会撞上已有的东西。
 *
 * 两种撞法要分开报：与本包已有 spec 撞（保存会覆盖别人的干员），与官方 id 撞（记录会被引擎丢弃，
 * 除非在 pack.json 里声明 overrides）。返回 null 表示没冲突。
 * @param {string} slug 用户填的 id（不含 chess_ws_ 前缀）
 * @param {{ packSlugs?: string[], officialIds?: Iterable<string> }} [ctx]
 * @returns {{kind:'pack'|'official', id:string, slug:string}|null}
 */
export function idConflict(slug, ctx = {}) {
  const s = String(slug ?? '').trim();
  if (!s) return null;
  const packSlugs = (ctx.packSlugs ?? []).map((x) => String(x));
  if (packSlugs.includes(s)) return { kind: 'pack', slug: s, id: `chess_ws_${s}_a` };
  const official = ctx.officialIds instanceof Set ? ctx.officialIds : new Set(ctx.officialIds ?? []);
  const base = `chess_ws_${s}_a`;
  if (official.has(base) || official.has(`chess_ws_${s}_b`)) return { kind: 'official', slug: s, id: base };
  return null;
}

/**
 * 改 id 的提醒。已有干员改了 id 再保存，只会**新建**一份记录，原来那份仍留在包里（既不会自动删，
 * 也不会提示）——所以界面要主动说一句。
 * @param {string|null} currentSlug 当前正在编辑的 slug
 * @param {string} typedSlug 表单里现在的 id
 * @returns {{from:string, to:string}|null}
 */
export function renameNotice(currentSlug, typedSlug) {
  const from = String(currentSlug ?? '').trim();
  const to = String(typedSlug ?? '').trim();
  if (!from || !to || from === to) return null;
  return { from, to };
}

/** 官方数据里出现过的分支 id（去重、排序），给输入框当候选。 */
export function subProfessionChoices(officialChess) {
  const seen = new Set();
  for (const o of Array.isArray(officialChess) ? officialChess : []) {
    const v = o && typeof o.subProfessionId === 'string' ? o.subProfessionId.trim() : '';
    if (v) seen.add(v);
  }
  return [...seen].sort();
}

/**
 * 攻击范围预设：官方数据里出现过的 rangeGrid 去重，每种形状配一个「用过它的干员」当例子。
 *
 * 表单此前完全没有范围的入口，作者只能吃默认的近战 2 格 / 远程 10 格。识别形状最省事的办法不是画坐标，
 * 而是告诉他「这是速射手那一片」——所以每种形状带一个样本干员。
 * @param {Array<{id:string,name?:string,rangeGrid?:number[][]}>} officialChess
 * @returns {Array<{key:string, grid:number[][], count:number, sample:{id:string,name:string,profession?:string}}>}
 */
export function rangePresets(officialChess) {
  const byKey = new Map();
  for (const o of Array.isArray(officialChess) ? officialChess : []) {
    const grid = o && Array.isArray(o.rangeGrid) ? o.rangeGrid : null;
    if (!grid || !grid.length || !grid.every((c) => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]))) continue;
    const key = gridKey(grid);
    if (byKey.has(key)) continue;
    byKey.set(key, { key, grid: grid.map((c) => [...c]), count: grid.length, sample: { id: o.id, name: o.name || o.id, profession: o.profession ?? null } });
  }
  return [...byKey.values()].sort((a, b) => (a.count - b.count) || a.key.localeCompare(b.key));
}

/** 一组范围格的稳定键（顺序无关，便于去重与比较）。 */
export function gridKey(grid) {
  return (Array.isArray(grid) ? grid : [])
    .filter((c) => Array.isArray(c) && c.length === 2)
    .map((c) => `${c[0]},${c[1]}`)
    .sort()
    .join(';');
}

/** 两份范围格是否相同。 */
export function sameGrid(a, b) {
  return gridKey(a) === gridKey(b);
}

/**
 * 把范围格排成矩阵，供界面画小格阵。以攻击者所在格 (0,0) 为原点，x 增大向右、y 增大向下（屏幕坐标）。
 * @param {number[][]} grid
 * @returns {{cols:number, rows:number, cells:boolean[][], origin:{x:number,y:number}}|null}
 */
export function gridMatrix(grid) {
  const cellsIn = (Array.isArray(grid) ? grid : []).filter((c) => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (!cellsIn.length) return null;
  const xs = cellsIn.map((c) => c[0]);
  const ys = cellsIn.map((c) => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cols = maxX - minX + 1, rows = maxY - minY + 1;
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  for (const [x, y] of cellsIn) cells[y - minY][x - minX] = true;
  // `-0 || 0`：minX 为 0 时 -0 也是「0」，但 -0 会污染深比较与序列化，这里直接归一
  return { cols, rows, cells, origin: { x: -minX || 0, y: -minY || 0 } };
}
