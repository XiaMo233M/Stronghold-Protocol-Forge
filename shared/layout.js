// shared/layout.js — 一张地图自己的「尺寸 + 分区」。
//
// 业主 2026-10-08：「你能稍微把地图做的更大些吗，加入对大图的支持怎么样，这样图会更多样化」。
//
// 在这之前，地图尺寸是**六层各自钉死**的：引擎世界 (sim/constants ROWS×COLS)、战斗矩形 (GEO.NORMAL_RECT 一族)、
// 三块部署矩形 (stageAuthoring DEPLOY_RECTS)、客户端渲染 (render/tiles ROWS/COLS)、官方相机 (projection 按
// 「格心 = 列−10 / 行−9」拟合)、授权校验 (恰好 19 行 21 格)。所以「把图做大」不是改一个数字，而是**让地图自己带
// 尺寸和分区**，其余五层改读地图：这个模块就是那份布局，以及「官方布局」的定义。
//
// 记录里本来就有 `size: [19, 21]`（tools/build-data.mjs:2942 从官方 dump 读出来的），只是一直没有代码读它 ——
// 它就是天然的挂点。`layout` 是新字段，官方记录**没有**它，于是 `layoutOf()` 从 `size` 推出来；
// `layoutForSize([19, 21])` 解出来的每一个数字都等于今天的常量（有测试逐字段钉住），所以 11 张官方图与素材
// 逐字节、逐像素不变。
//
// 两套坐标系，别混：
//   * 画布 (canvas) = 引擎世界 GEO.ROWS×GEO.COLS，格子的键就是 r*COLS+c。它取**最大的档位**，不随地图变 ——
//     让 COLS 随地图变会把 sim 里 250 处 `r*COLS+c` 全部变成动态步长，那是另一场重写。地图在自己的窗口里活动。
//   * 地图窗口 (window) = 这张图的 size，永远贴在画布左下角（行 r、列 c 从 0 起，行 0 = 最底）。
//
// 三块 band 的锚法（放大时多出来的行全部落进「中间战场」，见 docs/DESIGN.md §3）：
//   等待区   贴顶 5 行              (R−5 … R−1)
//   普通带   离顶第 7–10 行         (R−10 … R−7)
//   中间战场 普通带与 boss 带之间    (6 … R−11)
//   boss 带  贴底第 1–5 行          (1 … 5)，行 0 留作边缘
// 列不缩：普通部署矩形与 boss 左半场都锚在 2–10，右侧多出来的列（21 … C−1）是加宽的地形与绕路空间，在联防/boss
// 的满宽战场里能走能看。R=19, C=21 时上述锚法逐条等于今天的数字。

import { GEO } from './constants.js';

/** 官方尺寸：11 张官方图都是它，也是所有历史数据的尺寸。 */
export const OFFICIAL_SIZE = Object.freeze([19, 21]);

/**
 * 编辑器给的三个档位。「稍微大一点」是业主的原话，所以标准档仍是最小档，向下不缩（缩了分区就放不下）。
 * 任何 [MIN_ROWS..MAX_ROWS] × [MIN_COLS..MAX_COLS] 内的尺寸都合法，档位只是界面上的快捷方式。
 * 只带 `id` 与 `size`：界面上的名字（标准 / 大 / 特大）是编辑器自己的词条，那边唯一一份。
 */
export const SIZE_PRESETS = Object.freeze([
  Object.freeze({ id: 'standard', size: OFFICIAL_SIZE }),
  Object.freeze({ id: 'large', size: Object.freeze([23, 27]) }),
  Object.freeze({ id: 'huge', size: Object.freeze([27, 33]) }),
]);

export const MIN_ROWS = OFFICIAL_SIZE[0];
export const MIN_COLS = OFFICIAL_SIZE[1];
/** 画布上限 = 最大的档位（= GEO.ROWS/COLS，见 shared/constants.js）。 */
export const MAX_ROWS = SIZE_PRESETS[SIZE_PRESETS.length - 1].size[0];
export const MAX_COLS = SIZE_PRESETS[SIZE_PRESETS.length - 1].size[1];

/** 普通带的深度（行）与部署矩形的宽度（列）—— 它们就是棋盘本身，不随尺寸变。 */
export const BAND_ROWS = 4;
export const BOARD_COLS = 9;
/**
 * 三块部署矩形**定死的列**。棋盘 9 列、两个 boss 半场在 col 10 相接、镜像轴 20 —— 这三件事互相咬着：镜像
 * `c → mirrorCol − c` 把 2..10 映到 10..18，右半场因此只能从 col 10 起；普通矩形要 9 列又要在 col 10 收边，
 * 左边界就只能是 2。`server/match/waves.js` 的左右半场分界（col 10）、`content/bands/meta.js` 的同一条、
 * 以及客户端画 boss 棋盘的换算都按这套来。所以**放开的是行**（大图真正的自由度），列一律归一化回这里。
 */
export const FIXED_DEPLOY_COLS = Object.freeze({ normal: Object.freeze([2, 10]), bossLeft: Object.freeze([2, 10]), bossRight: Object.freeze([10, 18]) });
/** 等待区深度、boss 带深度、boss 带下的边缘行数。 */
const PEN_ROWS = 5;
const BOSS_ROWS = 5;
/** 最底那一行留作边缘（官方布局的 boss 带是 1–5，行 0 空着）。 */
const BOSS_BASE_ROW = 1;

const isInt = (v) => Number.isInteger(v);
const isRectArr = (v) => Array.isArray(v) && v.length === 4 && v.every(isInt);
const isRectObj = (v) => !!v && typeof v === 'object' && [v.r0, v.r1, v.c0, v.c1].every(isInt);

/** A `{r0,r1,c0,c1}` copy of a rect in either shape (array or object), or null. */
export function toRectObj(v) {
  if (isRectArr(v)) return { r0: v[0], r1: v[1], c0: v[2], c1: v[3] };
  if (isRectObj(v)) return { r0: v.r0, r1: v.r1, c0: v.c0, c1: v.c1 };
  return null;
}
/** The `[r0,r1,c0,c1]` array shape of a rect (the authoring shape, `DEPLOY_RECTS`). */
export const toRectArr = (v) => {
  const r = toRectObj(v);
  return r ? [r.r0, r.r1, r.c0, r.c1] : null;
};

/** Whether `v` is a usable `[rows, cols]` for a map (ints inside the canvas, at least the official size). */
export function isSize(v) {
  return Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1])
    && v[0] >= MIN_ROWS && v[0] <= MAX_ROWS && v[1] >= MIN_COLS && v[1] <= MAX_COLS;
}

/** `v` as a valid size, falling back to the official one (a stamp of a stale UI is not an error). */
export function clampSize(v) {
  if (!isSize(v)) return [...OFFICIAL_SIZE];
  return [v[0], v[1]];
}

/** The size a stage record declares (official when it declares nothing). */
export function sizeOf(stage) {
  return clampSize(stage && stage.size);
}

/** The preset id of a size, or null when it is a custom one. */
export function sizePresetOf(size) {
  const s = clampSize(size);
  const hit = SIZE_PRESETS.find((p) => p.size[0] === s[0] && p.size[1] === s[1]);
  return hit ? hit.id : null;
}

/** The size preset after `id` (the editor's 放大 / 缩小 buttons), clamped at both ends. */
export function presetStep(id, delta) {
  const i = SIZE_PRESETS.findIndex((p) => p.id === id);
  const j = Math.max(0, Math.min(SIZE_PRESETS.length - 1, (i < 0 ? 0 : i) + delta));
  return SIZE_PRESETS[j].id;
}

const rectIn = (r, size) => {
  const R = size[0], C = size[1];
  return r.r0 >= 0 && r.r1 < R && r.c0 >= 0 && r.c1 < C && r.r0 <= r.r1 && r.c0 <= r.c1;
};

/**
 * 一张 `[rows, cols]` 地图的**默认**布局（锚法见文件头）。
 *
 * @param {readonly number[]} size
 * @returns {{ size: number[], deployRects: Record<string, number[]>, battle: Record<string, object>, pen: object, mirrorCol: number }}
 */
export function layoutForSize(size) {
  const [R, C] = clampSize(size);
  const penTop = R - PEN_ROWS;             // 19 → 14
  const normalR1 = R - 7;                  // 19 → 12
  const normalR0 = normalR1 - (BAND_ROWS - 1); // 19 → 9
  const bossR0 = BOSS_BASE_ROW;            // 1（行 0 是边缘）
  const bossR1 = bossR0 + BOSS_ROWS - 1;   // 5
  return {
    size: [R, C],
    // 授权形状（数组）：与 shared/stageAuthoring.js DEPLOY_RECTS 同一套，官方解出来逐条相等
    deployRects: {
      normal: [normalR0, normalR1, 2, 10],
      bossLeft: [bossR0, bossR1, 2, 10],
      bossRight: [bossR0, bossR1, 10, 18],
    },
    // 引擎/相机形状（对象）：sim 的战斗矩形与三个取景窗口
    battle: {
      normal: { r0: normalR0, r1: normalR1, c0: 0, c1: 10 },
      prep: { r0: normalR1 - 5, r1: normalR1, c0: 0, c1: 10 },
      unite: { r0: normalR0, r1: normalR1, c0: 0, c1: C - 1 },
      boss: { r0: 0, r1: bossR1, c0: 0, c1: C - 1 },
      bossPrep: { r0: 0, r1: bossR1, c0: 0, c1: 10 },
    },
    pen: { r0: penTop, r1: R - 1, c0: 7, c1: 13 },
    // boss 右半场的镜像轴：官方 20，也就是两个半场相接的那条列（bossLeft.c1 + bossRight.c0）
    mirrorCol: 20,
  };
}

/** 官方布局 —— 也是 `layoutForSize(OFFICIAL_SIZE)` 的结果（测试逐字段钉住这一点）。 */
export const OFFICIAL_LAYOUT = Object.freeze(layoutForSize(OFFICIAL_SIZE));

/**
 * 把作者声明（或记录里存下的）布局洗成完整的一份：**缺的键从默认布局取，越界的矩形退回默认**。
 * 洗不出来的一律当作「没声明」，因为一个越界的分区不是「另一种设计」，而是坏数据。
 * @param {object|null|undefined} v
 * @param {number[]} size
 */
export function normalizeLayout(v, size) {
  const base = layoutForSize(size);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
  const out = { size: base.size, deployRects: {}, battle: {}, pen: base.pen, mirrorCol: base.mirrorCol };
  const dr = v.deployRects && typeof v.deployRects === 'object' ? v.deployRects : {};
  for (const key of Object.keys(base.deployRects)) {
    const r = toRectObj(dr[key]);
    out.deployRects[key] = r && rectIn(r, base.size) ? toRectArr(r) : base.deployRects[key];
  }
  // 部署矩形是棋盘本身：行数必须是棋盘的深度（不对就不是棋盘 → 退回默认），列一律拉回定死的那两列
  // （见 FIXED_DEPLOY_COLS）：大图放开的是**行**，整块上下挪位。
  for (const key of Object.keys(out.deployRects)) {
    const [r0, r1] = out.deployRects[key];
    const wantRows = key === 'normal' ? BAND_ROWS : BOSS_ROWS;
    const cols = FIXED_DEPLOY_COLS[key];
    out.deployRects[key] = r1 - r0 + 1 === wantRows ? [r0, r1, cols[0], cols[1]] : base.deployRects[key];
  }
  // 镜像轴由那两列定死（2 + 18 = 20）：它是「两个半场相接的那条列」，不是一个可以随便挑的参数
  out.mirrorCol = FIXED_DEPLOY_COLS.bossLeft[0] + FIXED_DEPLOY_COLS.bossRight[1];
  const bt = v.battle && typeof v.battle === 'object' ? v.battle : {};
  for (const key of Object.keys(base.battle)) {
    const r = toRectObj(bt[key]);
    out.battle[key] = r && rectIn(r, base.size) ? r : base.battle[key];
  }
  const pen = toRectObj(v.pen);
  out.pen = pen && rectIn(pen, base.size) ? pen : base.pen;
  return out;
}

/** 地图的布局：记录里声明过就用声明，否则由 `size` 推出默认布局（官方记录走的就是这条路）。 */
export function layoutOf(stage) {
  return normalizeLayout(stage && stage.layout, sizeOf(stage));
}

/** Whether a layout is the official one — 决定用官方相机还是 `fitCamera`（render/projection.js）。 */
export function isOfficialLayout(layout) {
  return JSON.stringify(normalizeLayout(layout, sizeOf(layout))) === JSON.stringify(OFFICIAL_LAYOUT);
}

/** 部署矩形（授权形状 `[r0,r1,c0,c1]`）；未知名字给 normal，跟 board.js 的 fieldOf 一个口径。 */
export function deployRectOf(layout, name) {
  const l = layout || OFFICIAL_LAYOUT;
  return l.deployRects[deployRectName(name)] || l.deployRects.normal;
}

/**
 * 部署场名 → 它读哪一块矩形。两个 boss 半场（`bossL` / `bossR`，board.js DEPLOY_FIELDS 的拼法）共用 `bossLeft`：
 * 矩形说的只是「棋盘落在地图的哪一块」，左右半场的差别全在列上的镜像（`mirrorCol`）。
 */
export function deployRectName(field) {
  return field === 'bossL' || field === 'bossR' ? 'bossLeft' : (field || 'normal');
}

/**
 * 棋盘行 → 地图行：**部署矩形的第 r1 行就是棋盘第 12 行**（官方 normal [9,12] → 恒等；bossLeft [1,5] → 减 7）。
 * 这就是今天的 BOSS_ROW_OFFSET = −7 的一般式。
 */
export function stageRowOfBoard(layout, field, boardRow) {
  const rect = deployRectOf(layout, field);
  return rect[1] - (GEO.FIELD.r1 - boardRow);
}

/** 棋盘列 → 地图列：普通/左半场是同一侧，右半场过镜像轴。（官方：c ↔ c；bossR：c ↔ 20 − c。） */
export function stageColOfBoard(layout, field, boardCol) {
  if (field === 'bossR') return (layout || OFFICIAL_LAYOUT).mirrorCol - boardCol;
  return deployRectOf(layout, field)[2] + (boardCol - GEO.FIELD.c0);
}

/** 棋盘格 (r, c) 在部署场 `field` 里落在哪一格地图上。 */
export function fieldTileOf(layout, field, r, c) {
  return [stageRowOfBoard(layout, field, r), stageColOfBoard(layout, field, c)];
}

/** 上面那条映射的逆。 */
export function boardTileOf(layout, field, r, c) {
  const rect = deployRectOf(layout, field);
  const row = GEO.FIELD.r1 - (rect[1] - r);
  const col = field === 'bossR' ? (layout || OFFICIAL_LAYOUT).mirrorCol - c : GEO.FIELD.c0 + (c - rect[2]);
  return [row, col];
}

/** 部署矩形覆盖的地图行里，棋盘用不到的那一条（boss 场的整备区行：矩形顶行）。 */
export function benchRowOf(layout, field) {
  return deployRectOf(layout, field)[0];
}

/**
 * 取景/战斗矩形：`normal` `prep` `unite` `boss` `bossPrep` `pen`，或任意部署场名（→ 它的战斗矩形）。
 * 与 GEO.NORMAL_RECT 一族同名同形，所以调用方换过来时是「同一个东西，只是从地图读」。
 */
export function viewRectOf(layout, kind) {
  const l = layout || OFFICIAL_LAYOUT;
  if (kind === 'bossL' || kind === 'bossR') return { ...l.battle.boss };
  return { ...(l.battle[kind] || l.pen) };
}
