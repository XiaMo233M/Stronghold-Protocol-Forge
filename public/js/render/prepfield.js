// render/prepfield.js — where the prep board is shown (research 09 §1.2, DESIGN §3 / §15): normally the own board
// (rows 7–12, the stage grid as is); in the Final Assault / Hidden Core prep the player's pieces stand on THEIR half of
// the boss field — the sim's mapping (server/match/finalAssault.js bossFieldPlacement, sim Battle.mapTile / mapDir):
// board rows ≥ 7 → row − 7 (board 9–12 → boss 2–5, the bench row 7 → 0, the temp row 8 → 1); the right-hand player
// (side 'R') is mirrored col c → 20 − c with RIGHT ↔ LEFT (UP / DOWN unchanged, ConvertChessPositionInfoToBossMap).
// Pieces only ever stand on rows ≥ 7; other board rows (range tiles reaching past the field) shift the same way, so a
// DOWN range below the bench falls off the grid (row < 0) instead of landing on the boss rows, and `tilesToDisp` drops
// every tile that is not on the boss field — e.g. an UP range past the top wall onto the normal board.
//
// The view keeps every public coordinate in BOARD space (the server's, g.move targets, canPlace, highlightTiles,
// tileScreen, holdPiece, setPieceDir): only what is drawn and picked goes through this transform. Pure functions.
//
// A **big map** (shared/layout.js) carries its own boss half: `bossPrepField(side, layout)` reads the row shift and the
// mirror column from the map (shared/layout.js `fieldTileOf` / `boardTileOf` are exactly this transform), so the numbers
// below (`BOSS_ROW_SHIFT`, `MAX_COL`, `BOSS_DISP_MAX_ROW`) are the OFFICIAL layout's and stay the fallback a missing
// layout argument means.
//
// The round's leader (community report #12, owner's decision 2026-10-04: research 09 §2.2's "the leader stands by its
// spawn point" over research 08 §4.1's pen): `leaderStand` finds it in m.private.nextEnemies (an entry with `start`, the
// leader's spawn tile on the boss field, server/match/waves.js previewOf) — the Final Assault prep shows it standing
// there instead of in the pen, and lights its hit tiles in red beside an operator's orange range preview (render/app.js).

import { GEO } from '../../../shared/constants.js';
import { OFFICIAL_LAYOUT, fieldTile, boardTile, mirrorColOf } from './layout.js';

/** Board row → display (boss-field) row of the OFFICIAL layout: row − 7 (server/match/board.js BOARD_ROWS_ABOVE_BOSS
 * is +7, the inverse). A map that moves its boss half carries its own — read it through `bossPrepField(side, layout)`. */
export const BOSS_ROW_SHIFT = -7;
/** The OFFICIAL mirror column (`OFFICIAL_LAYOUT.mirrorCol`): the boss halves' axis. Per map, use `mirrorColOf(layout)`. */
export const MAX_COL = OFFICIAL_LAYOUT.mirrorCol;

const MIRROR = Object.freeze({ RIGHT: 'LEFT', LEFT: 'RIGHT', UP: 'UP', DOWN: 'DOWN' });

/**
 * A piece's own board window in the prep: rows 7 (`GEO.HAND_ROW`, the bench) … 12 (`GEO.FIELD.r1`, the back row) and
 * columns 0 … 10 (the board rect's deploy columns; the bench slots 0–9 and the temp slots 4–8 both sit inside). BOARD
 * coordinates — they do not move with the map (shared/layout.js `FIXED_DEPLOY_COLS` pins the deploy rects' columns).
 */
const BOARD_ROW_MIN = GEO.HAND_ROW, BOARD_ROW_MAX = GEO.FIELD.r1;
const BOARD_COL_MIN = 0, BOARD_COL_MAX = 10;

/** RIGHT ↔ LEFT (UP / DOWN unchanged); unknown values pass through. */
export function mirrorDir(d) {
  return typeof d === 'string' && MIRROR[d.toUpperCase()] ? MIRROR[d.toUpperCase()] : d;
}

/** The identity transform (normal prep). */export const IDENTITY = Object.freeze({
  kind: 'board', side: 'L', mirror: false,
  toDisp: (row, col) => ({ row, col }),
  toBoard: (row, col) => ({ row, col }),
  dirToDisp: (d) => d,
  dirToBoard: (d) => d,
});

/**
 * Transform of the Final Assault prep on side 'L' | 'R' of the boss field. `toBoard` returns null for display tiles
 * that are not on the player's half of the boss rows (official 0–5) — nothing of the board is there.
 *
 * `layout` is the map's own (shared/layout.js): the row shift and the mirror column come from it, so a map that moves
 * its boss half shows it where that map put it. Omitted → the official layout, which reproduces the historical
 * `−7` / `20 − c` exactly — a missing layout keeps meaning "official".
 */
export function bossPrepField(side, layout = OFFICIAL_LAYOUT) {
  const L = layout || OFFICIAL_LAYOUT;
  const R = side === 'R';
  const field = R ? 'bossR' : 'bossL';
  const bossR1 = L.battle.boss.r1;
  // The display window of the player's half: every map tile the pieces' own board window (rows `GEO.HAND_ROW` 7 …
  // `GEO.FIELD.r1` 12, cols 0–10) maps onto. Those are BOARD coordinates and do not move with the map, so `toBoard`
  // accepts exactly what `toDisp` can produce — on the official 19×21 map and on a big one alike.
  const ownDisp = new Set();
  for (let r = BOARD_ROW_MIN; r <= BOARD_ROW_MAX; r++) {
    for (let c = BOARD_COL_MIN; c <= BOARD_COL_MAX; c++) {
      const t = fieldTile(field, r, c, L);
      ownDisp.add(`${t[0]},${t[1]}`);
    }
  }
  // the pieces' own board window stays the same on every map (shared/layout.js pins the deploy rects' columns)
  const onOwnBoard = (r, c) => r >= BOARD_ROW_MIN && r <= BOARD_ROW_MAX && c >= BOARD_COL_MIN && c <= BOARD_COL_MAX;
  return Object.freeze({
    kind: 'bossPrep', side: R ? 'R' : 'L', mirror: R,
    layout: L,
    toDisp: (row, col) => {
      const t = fieldTile(field, row, col, L);
      return { row: t[0], col: t[1] };
    },
    toBoard: (row, col) => {
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > bossR1) return null;
      if (!ownDisp.has(`${row},${col}`)) return null;
      const t = boardTile(field, row, col, L);
      if (!onOwnBoard(t[0], t[1])) return null;
      return { row: t[0], col: t[1] };
    },
    dirToDisp: (d) => (R ? mirrorDir(d) : d),
    dirToBoard: (d) => (R ? mirrorDir(d) : d),
  });
}

/** Last display row of the boss field band (the boss rows + the wall row above them) in the Final Assault prep. */
export const BOSS_DISP_MAX_ROW = OFFICIAL_LAYOUT.battle.boss.r1 + 1;

/** Last display row of a map's own boss field band (`BOSS_DISP_MAX_ROW` for the official layout). */
export const bossDispMaxRow = (layout) => (layout || OFFICIAL_LAYOUT).battle.boss.r1 + 1;

/**
 * Map a list of board tiles ([[r,c]] or [{row,col}]) to display tiles ([[r,c]]). In the Final Assault prep tiles that do
 * not land on the boss field (display rows 0 … the boss band, cols 0 … the mirror column) are dropped.
 */
export function tilesToDisp(xf, tiles) {
  const out = [];
  if (!Array.isArray(tiles)) return out;
  const L = (xf && xf.layout) || OFFICIAL_LAYOUT;
  const boss = xf && xf.kind === 'bossPrep';
  const maxRow = bossDispMaxRow(L), maxCol = mirrorColOf(L);
  for (const t of tiles) {
    const r = Array.isArray(t) ? t[0] : t?.row, c = Array.isArray(t) ? t[1] : t?.col;
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    const d = xf.toDisp(r, c);
    if (boss && (d.row < 0 || d.row > maxRow || d.col < 0 || d.col > maxCol)) continue;
    out.push([d.row, d.col]);
  }
  return out;
}

/**
 * The leader standing on the boss field in its prep (see the header): the first `nextEnemies` entry flagged `boss` with
 * a spawn tile `start` ([row, col], boss-field rows 0–5) → { entry, row, col, tiles } — `tiles` its hit tiles there
 * (render/pick.js hitTiles: the sim's hit rectangle, data/enemies.json `hitArea` through `hitAreaOf(enemyKey)`; a point
 * leader its own tile) — or null.
 * @param {Array<object>|null} list m.private.nextEnemies
 * @param {(enemyKey: string) => any} hitAreaOf
 * @param {(x: number, y: number, a: any) => number[][]} hitTilesOf render/pick.js hitTiles
 * @param {object} [layout] the map's own layout (shared/layout.js); omitted → the official one
 */
export function leaderStand(list, hitAreaOf, hitTilesOf, layout = OFFICIAL_LAYOUT) {
  if (!Array.isArray(list)) return null;
  const L = layout || OFFICIAL_LAYOUT;
  const maxRow = bossDispMaxRow(L) - 1, maxCol = mirrorColOf(L);
  const entry = list.find((e) => e && e.boss && typeof e.enemyKey === 'string' && Array.isArray(e.start)
    && Number.isInteger(e.start[0]) && Number.isInteger(e.start[1]) && e.start[0] >= 0 && e.start[0] <= maxRow
    && e.start[1] >= 0 && e.start[1] <= maxCol);
  if (!entry) return null;
  const [row, col] = entry.start;
  let area = null;
  try { area = hitAreaOf ? hitAreaOf(entry.enemyKey) : null; } catch { /* unknown enemy: a point leader */ }
  const tiles = (typeof hitTilesOf === 'function' ? hitTilesOf(col, row, area) : [[row, col]])
    .filter(([r, c]) => r >= 0 && r <= maxRow && c >= 0 && c <= maxCol);
  return { entry, row, col, tiles };
}
