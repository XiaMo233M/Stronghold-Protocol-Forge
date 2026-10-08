// public/js/render/layout.js — 客户端渲染层的「这张图自己的窗口与分区」入口。
//
// 一句话规则：**凡是「地图自己的坐标」，都从 `layoutOf(stage)` 读；`GEO.*` 只当官方兜底，以及当棋盘坐标（board
// coordinates，行 9–12 / 列 2–10 那一套，换图也不变）的语义。**
//
// 官方 19×21 的图不带 `size`/`layout`，`layoutOf()` 推出来的每一个数字都等于历史常量，所以官方地图走这条路口径与结果
// **完全不变**（shared/layout.js 的 `layoutForSize` 与 `GEO` 一族逐字段相等，test/layout.test.js 钉住这一点）。大图
// （23×27 / 27×33，或编辑器自定尺寸）在自己的窗口 0..R−1 × 0..C−1 里活动：渲染器只画这个窗口，相机用自己的矩形取景。
//
// 本模块只做「把 stage / layout / 相机 kind 翻译成矩形与尺寸」这一件事，不碰 PIXI / three / DOM，所以 Node 测试与
// DOM 兜底视图都能直接用（和 render/projection.js 一个定位）。`shared/layout.js` 是唯一的数据源，这里不复制任何数字。

import { OFFICIAL_LAYOUT, layoutOf, sizeOf, viewRectOf, fieldTileOf, boardTileOf } from '../../../shared/layout.js';
import { normRect } from './projection.js';

export { OFFICIAL_LAYOUT, layoutOf, sizeOf, viewRectOf } from '../../../shared/layout.js';

/** 部署场的三个名字（与 server/match/board.js DEPLOY_FIELDS 同口径）。 */
export const DEPLOY_FIELDS = Object.freeze(['normal', 'bossL', 'bossR']);

/** The map's own layout for a stage record (the official one when it declares nothing). */
export const layoutOfStage = (stage) => layoutOf(stage);

/** The map's own `[rows, cols]` window for a stage record. */
export const mapSizeOf = (stage) => sizeOf(stage);

/** The map's own `[rows, cols]` window of a layout object (a layout carries its own `size`). */
export const mapSize = (layout) => sizeOf(layout);

/**
 * 一张图自己的取景/战斗矩形，**地图窗口坐标**。`kind` 与 `GEO.NORMAL_RECT` 一族同名（`normal` / `unite` / `boss` /
 * `bossPrep` / `prep` / `pen`），另外接受部署场名（`bossL` / `bossR` → 它的战斗矩形）。
 *
 * `prep` 直接用布局里已经算好的 `battle.prep` —— 官方解出来正好是历史那个 `{ r0: 7, r1: 12, c0: 0, c1: 10 }`
 * （整备区一行 + 普通带 4 行），大图是 `{ r0: normalR1 − 5, r1: normalR1 }`。**不要**在这里用 `GEO.HAND_ROW` 去夹：
 * 它是**棋盘坐标**（行 9–12 那一套），官方图上两者恰好重合，大图上会把整备区钉在错误的地图行上。
 */
export function mapRectOf(layout, kind) {
  const L = layout || OFFICIAL_LAYOUT;
  return viewRectOf(L, kind);
}

/** `mapRectOf` 的归一化副本：整数化、交换写反的上下界、夹到这张图自己的窗口里。 */
export const normMapRect = (layout, rect) => {
  const L = layout || OFFICIAL_LAYOUT;
  return normRect(rect, L.size[0], L.size[1]);
};

/**
 * The rect a camera kind frames, with the priority the renderer uses everywhere:
 *   1. `opts.rect` — the server's own rect (m.field `meta.rect`) or the caller's;
 *   2. the map's own rect for that kind (`mapRectOf`);
 *   3. （`layout` 省略时就是官方布局，也就是历史常量。）
 * 归一化到这张图自己的窗口。**prep 的顶行不夹 `GEO.HAND_ROW`**：那是棋盘坐标，`battle.prep` 已经是对的（见 `mapRectOf`）。
 */
export function rectForKind(kind, layout, rect) {
  const L = layout || OFFICIAL_LAYOUT;
  const k = kind === 'hidden' ? 'boss' : kind;
  const r = rect && Number.isFinite(rect.r0) ? rect : mapRectOf(L, k);
  return normRect(r, L.size[0], L.size[1]);
}

/**
 * 棋盘格 (r, c) 落在部署场 `field` 的哪一格地图上，`[row, col]`。`layout` 省略 = 官方布局，所以
 * `fieldTile('bossR', 10, 8)` 的含义与以前完全一样（server/match/board.js 的同名函数出于同样的理由给了同样的默认）。
 */
export const fieldTile = (field, r, c, layout) => fieldTileOf(layout || OFFICIAL_LAYOUT, field, r, c);

/** `fieldTile` 的逆映射。 */
export const boardTile = (field, r, c, layout) => boardTileOf(layout || OFFICIAL_LAYOUT, field, r, c);

/**
 * The map's mirror column (`layout.mirrorCol`). It is always 20: the deploy rects' COLUMNS are pinned by the board's
 * mirror geometry (shared/stageAuthoring.js DEPLOY_RECTS 2–10 / 2–10 / 10–18, locked by shared/layout.js
 * `FIXED_DEPLOY_COLS`) and `normalizeLayout` pulls a declared column back — only the ROWS can move. Read it here so the
 * client never hard-codes `20 - c`; there is no per-map value to expect.
 */
export const mirrorColOf = (layout) => (layout || OFFICIAL_LAYOUT).mirrorCol;
