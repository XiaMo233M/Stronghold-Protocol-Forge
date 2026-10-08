// ui/gameLogic/enemies.js — enemy groups, factions, the preview pen. Re-exported from ../gameLogic.js.

import { layoutPen, penZones } from '../../render/pen.js';
import { isObj } from './shared.js';


// ---- enemies ------------------------------------------------------------------------------------------------

const TAG_ORDER = { boss: 0, bounty: 1, escort: 2 };
const RANK_ORDER = { BOSS: 0, ELITE: 1, NORMAL: 2 };

/**
 * Next-round enemy preview rows: merged by (enemyKey, tag), sorted boss → bounty → elite → normal → count.
 * @param {Array<{enemyKey:string, count?:number, tag?:string}>} list
 * @param {(key:string)=>any} [getEnemy]
 */
export function groupEnemies(list, getEnemy = () => null) {
  const map = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e) || typeof e.enemyKey !== 'string') continue;
    const tag = typeof e.tag === 'string' ? e.tag : null;
    const k = `${e.enemyKey}|${tag}`;
    const cur = map.get(k) || { enemyKey: e.enemyKey, tag, count: 0 };
    cur.count += Number.isFinite(e.count) && e.count > 0 ? e.count : 1;
    map.set(k, cur);
  }
  return [...map.values()].map((row) => {
    const en = getEnemy(row.enemyKey);
    return { ...row, name: en?.name || row.enemyKey, rank: en?.rank || 'NORMAL', acTypes: Array.isArray(en?.acTypes) ? en.acTypes : (en?.acType ? [en.acType] : []), fly: en?.stats?.motion === 'FLY' || !!en?.isFlyEnemy };
  }).sort((a, b) => (TAG_ORDER[a.tag] ?? 9) - (TAG_ORDER[b.tag] ?? 9)
    || (RANK_ORDER[a.rank] ?? 9) - (RANK_ORDER[b.rank] ?? 9)
    || b.count - a.count || (a.enemyKey < b.enemyKey ? -1 : 1));
}

// ---- enemy preview pen (research 09 §2, research 08 §4.2) ---------------------------------------------------

/**
 * The OFFICIAL pen (rows 14–18 × cols 7–13, row 16 unused; lower-gate zone rows 14–15, upper-gate rows 17–18). It is
 * the fallback constant: the pen a stage actually uses is `penRect(stage)` (render/pen.js — the map's own band,
 * shared/layout.js), and the zone rows follow that rect's shape.
 */
export const PEN = Object.freeze({ r0: 14, r1: 18, c0: 7, c1: 13, emptyRow: 16, cap: 50, anchors: Object.freeze({ lower: [15, 7], upper: [18, 7] }) });

/**
 * Zone tiles in row-major order (low row first, left column → right), without the zone's own gate tile.
 *
 * It is the engine's OWN answer (`render/pen.js penZones`), so the DOM fallback view and the render engine can never
 * drift: with a stage it is that stage's pen (its `tile_start` anchors, its `previewNotAlloed` row); without one it is
 * the pen's shape — 2 rows per gate around the two anchors, the pen's one unused row between them (the official
 * `(14,7)–(18,13)` → rows 14–15 / 17–18, 13 tiles each).
 * @param {'upper'|'lower'} gate
 * @param {{ stage?: any }} [opts] the stage (its own pen rect / anchors)
 */
export function penZoneTiles(gate, opts = {}) {
  const stage = isObj(opts) ? opts.stage : null;
  if (stage) {
    const z = penZones(stage);
    return (gate === 'upper' ? z.upper : z.lower).tiles;
  }
  const rect = { ...PEN };
  const lower = gate !== 'upper';
  const anchors = [PEN.anchors.lower, PEN.anchors.upper];
  const mine = lower ? anchors[0] : anchors[1];
  const rows = lower ? [rect.r0, rect.r0 + 1] : [rect.r1 - 1, rect.r1];
  const out = [];
  for (const r of rows) for (let c = rect.c0; c <= rect.c1; c++) if (!(r === mine[0] && c === mine[1])) out.push([r, c]);
  return out;
}

/**
 * Placement of the preview models in the pen for the DOM fallback view — the SAME layout as the render engine
 * (render/pen.js layoutPen: research 08 §4.2, client AutoChessEnemyPreviewManager — spawn-time order; > 50 enemies
 * thinned per entry to max(1, round(count·50/total)), elites / leaders always all of theirs; each gate's models in its
 * zone, the k-th model of a zone at zoneTiles[round(k/totalShowCnt·len) − jitter]; ≤ 3 per tile; seeded, so a re-sent
 * m.private never reshuffles it). Both views show one teammate's pen identically (review regression: the fallback used
 * its own variant — global k, no per-tile cap — and placed the same enemies elsewhere). `slot` numbers the models
 * sharing a tile.
 * @param {Array<{ enemyKey: string, count?: number, gate?: string, t?: number, fly?: boolean, elite?: boolean, boss?: boolean }>} entries m.private.nextEnemies
 * @param {{ cap?: number, stage?: any }} [opts] cap = MAX_PREVIEW_CNT (50); stage = the stage (its pen rect / tiles)
 * @returns {Array<{ enemyKey: string, gate: 'upper'|'lower', row: number, col: number, slot: number, fly: boolean, elite: boolean, boss: boolean, k: number }>}
 */
export function penPlacement(entries, opts = {}) {
  const max = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : PEN.cap;
  const { figures } = layoutPen(Array.isArray(entries) ? entries : [], { stage: opts.stage || null, max });
  const perTile = new Map();
  return figures.map((f, k) => {
    const key = `${f.row},${f.col}`;
    const slot = perTile.get(key) || 0;
    perTile.set(key, slot + 1);
    return { enemyKey: f.enemyKey, gate: f.zone === 'upper' ? 'upper' : 'lower', row: f.row, col: f.col, slot, fly: !!f.fly, elite: !!f.elite, boss: !!f.boss, k };
  });
}

/**
 * The enemy a view `pieceClick` points at in the preview pen, or null: `{ enemyKey }` or a `preview` enemy unit
 * (`{ preview: true, unit: { side: 'enemy', defId } }`). Battle units (live fights) are not pen enemies.
 * @param {any} e
 */
export function previewEnemyKey(e) {
  if (!isObj(e)) return null;
  if (typeof e.enemyKey === 'string' && e.enemyKey) return e.enemyKey;
  const u = isObj(e.unit) ? e.unit : null;
  if (!u || !(e.preview || u.preview)) return null;
  if (u.side !== 'enemy' && u.kind !== 'enemy') return null;
  const k = typeof u.enemyKey === 'string' && u.enemyKey ? u.enemyKey : u.defId;
  return typeof k === 'string' && k ? k : null;
}

/** Normalise m.public.factions (type strings or objects) to type ids. */
export function factionTypes(factions) {
  const out = [];
  for (const f of Array.isArray(factions) ? factions : []) {
    const t = typeof f === 'string' ? f : isObj(f) ? (f.type || f.id || f.key) : null;
    if (typeof t === 'string' && t && !out.includes(t)) out.push(t);
  }
  return out;
}
