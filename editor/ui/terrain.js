// editor/ui/terrain.js — 把一张地图的「地形」变成两个页面都能画的东西。
//
// 出怪页此前只画一张空网格，作者要靠肉眼对着地图页抄坐标；而路线定义在地图页、引用在出怪页，
// 抄错一个格子就是「怪从墙里出来」这种很难查的问题。地图数据里本来就带着地形（`rows` + `tiles` 图例），
// 把它画成底图，路线的起点/终点落在哪一格就一目了然了。
//
// 这里只做两件纯事：把 rows 归一化成固定行列的网格，以及从调色板取一个字的颜色。

/**
 * 某个字符的颜色。
 *
 * 两档：调色板认识就直接用它；不认识的按**这张图自己的图例**里的高度给个近似色。
 * 为什么需要第二档：官方地图会用到调色板之外的地形（例如 `A` = `tile_achand`，11 张图里共 165 格），
 * 只按调色板取色的话画布上会出现一片黑洞 —— 看不出那是高台还是墙。实测官方地图的每一格都能被这两档覆盖。
 *
 * @param {Array<{glyph:string,color:string}>} palette
 * @param {string} glyph
 * @param {Record<string,{height?:string}>} [legend] 地图自己的 `tiles` 图例
 */
export function colorOfGlyph(palette, glyph, legend) {
  const hit = (Array.isArray(palette) ? palette : []).find((t) => t.glyph === glyph);
  if (hit && hit.color) return hit.color;
  const height = legend && typeof legend === 'object' ? legend[glyph]?.height : null;
  if (height === 'HIGH') return '#3a3f47';
  if (height === 'LOW') return '#4a4f57';
  return '#2a2d33';
}

/**
 * 地图的 `rows` 归一化成 rows×cols 的字符网格。
 *
 * 归一化是必要的：官方数据里每行长度与 `size` 一致，但工坊地图可能只有几行、或者某行短一截
 * （手写或导入的包），直接按下标取值会画出半张图。
 *
 * @param {{rows?: string[]}} stage
 * @param {{rows:number, cols:number}} size
 * @param {string} [filler] 缺的格子用什么字符（默认空格，画出来是兜底色）
 * @returns {string[][]|null} 没有 rows 时返回 null（调用方就退回「只画网格」）
 */
export function terrainGrid(stage, size, filler = ' ') {
  const rows = Array.isArray(stage?.rows) ? stage.rows : null;
  if (!rows || !rows.length) return null;
  const R = Math.max(0, Number(size?.rows) || 0);
  const C = Math.max(0, Number(size?.cols) || 0);
  const out = [];
  for (let r = 0; r < R; r++) {
    const line = String(rows[r] ?? '');
    const cells = [];
    for (let c = 0; c < C; c++) cells.push(line[c] ?? filler);
    out.push(cells);
  }
  // 空网格（尺寸为 0）等同于「没有地形」：调用方只认一个信号，不必区分 null 与 []
  return out.length && out[0].length ? out : null;
}

/**
 * 一格地形的**部署结论**（「能放近战 / 只能远程 / 不能部署 / 空气」）。
 *
 * 为什么需要它：调色板给的是三个机器字段（height / buildable / passable），作者要自己把它们翻译成
 * 「这格能不能站人」—— 而引擎的规则是分层看这三个字段的（server/sim/grid.js + shared/stageAuthoring.js
 * 的 deriveDeployTiles）。把推导放在一处，地图页的图例面板与即时预览就永远不会各说各话。
 *
 * 规则（业主口径）：道路与普通地面默认放**地面干员**；高台默认放**远程位**；`buildable: 'NONE'` 不可部署；
 * `passable: 'NONE'` 就是地图外的空气，连站都站不了。勾上「地面也能放远程位」之后，LOW 且 buildable 不是 NONE
 * 的地面也接受远程位（高台干员），这正是地图作者要自己定开关的那一条。
 * 唯一的反直觉一格：`height: 'HIGH'` + `buildable: 'MELEE'` 两边都不收（引擎的 deriveDeployTiles 里
 * MELEE 只认 LOW、高台只认 RANGED），所以这里如实报「不可部署」，不编一个引擎不会给的结论。
 *
 * @param {{height?:string, buildable?:string, passable?:string}} tile
 * @param {{groundHighGround?:boolean}} [options] 这张图自己的 spec.options
 * @returns {'air'|'melee'|'rangedOnly'|'none'}
 */
export function deployRuleOf(tile, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const height = tile?.height;
  const buildable = tile?.buildable ?? 'NONE';
  // 空气（地图外）：不可走也不可部署，所以先判它——否则 'NONE' 那支会把空气说成普通阻隔
  if (tile?.passable === 'NONE') return 'air';
  if (buildable === 'NONE') return 'none';
  if (buildable === 'RANGED') return 'rangedOnly';
  // MELEE 只在低地成立（引擎的 melee 分支带 height === 'LOW'）
  if (buildable === 'MELEE') return height === 'HIGH' ? 'none' : 'melee';
  // buildable 'ALL'：高台给远程位，低地给地面干员（勾了开关后低地也给远程位）
  return height === 'HIGH' ? 'rangedOnly' : (opts.groundHighGround ? 'rangedOnly' : 'melee');
}

/**
 * 从地图列表里找一张（出怪页按 id 选地图）。找不到返回 null。
 * @param {Array<{id:string}>} stages
 * @param {string|null} id
 */
export function stageById(stages, id) {
  if (!id) return null;
  return (Array.isArray(stages) ? stages : []).find((s) => s && s.id === id) ?? null;
}
