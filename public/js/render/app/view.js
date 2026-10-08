// public/js/render/app/view.js — which field a camera shows, and the board box that follows it.

import { AREAS, areaFor } from '../board3d/layout.js';
import { layoutOf, mapSize } from '../layout.js';
import { normRect } from '../projection.js';

const VIEW_KINDS = new Set(['prep', 'normal', 'unite', 'boss', 'bossPrep', 'pen']);

/**
 * The field a camera request actually shows — what render/projection.js presetCamera frames: 'hidden' → 'boss';
 * a 'prep' camera asked for the boss rows (Final Assault prep: rect r1 ≤ 6) → 'bossPrep'; unknown kinds → 'normal'.
 * Drives the built 3D area, the drawn 2D rows and the lit rect, so they always match the camera. The rect is
 * normalised against the MAP's own window (`layout`), so a big map's boss band (rows 0–5, bottom-anchored) still reads
 * as the boss field.
 */
export function viewKind(kind, opts, layout = null) {
  let k = kind === 'hidden' ? 'boss' : kind;
  if (!VIEW_KINDS.has(k)) k = 'normal';
  const [R, C] = mapSize(layout || null);
  if (k === 'prep' && opts && opts.rect && normRect(opts.rect, R, C).r1 <= 6) k = 'bossPrep';
  return k;
}

/** 3D areas without the enemy preview pen block (the own field / both normal halves); see `boardArea`. */
const areaNoPen = (layout) => ({
  normal: areaFor('normal', layout).filter((a) => a.r1 <= layout.battle.normal.r1 + 1),
  unite: areaFor('unite', layout).filter((a) => a.r1 <= layout.battle.normal.r1 + 1),
});

/**
 * 3D area built for a view kind (viewKind): the enemy preview pen only for the 'pen' camera — the prep, battle and 联防
 * cameras show the field alone (user playtest #2 item 6) with its separator row above the normal field (the devices on
 * it blow into the field: act2 m01's blowers, user playtest #5 item 6; the boss field's devices are drawn with the boss
 * field only — board3d/layout.js stageDevices); the boss kinds build the boss field.
 *
 * `layout` (shared/layout.js) is the map's own: the official 19×21 rects are shifted onto its window, so a big map
 * builds its own field bands and pen block. Omitted → the official layout (the historical numbers).
 */
export function boardArea(vk, layout = null) {
  const L = layout || layoutOf(null);
  if (vk === 'pen') return areaFor('normal', L);
  if (vk === 'prep' || vk === 'normal') {
    const a = areaNoPen(L).normal;
    return a.length ? a : areaFor('normal', L);
  }
  if (vk === 'unite') {
    const a = areaNoPen(L).unite;
    return a.length ? a : areaFor('unite', L);
  }
  return areaFor(vk, L);
}

/**
 * 2D rows drawn for a view kind: the pen rows only for the 'pen' camera; the boss field with the separator and the
 * normal rows behind it as scenery. Rows are of the MAP's own window (0..R−1), so the bands move with it: the normal
 * field lives between the two separator walls (the wall under the bench is the boss field's top edge, `bossWallRow`),
 * the boss field plus that wall above it.
 */
export function bandFor(kind, layout = null) {
  const L = layout || layoutOf(null);
  const R = L.size[0];
  const wall = bossWallRow(L);
  if (kind === 'boss' || kind === 'hidden' || kind === 'bossPrep') return [0, L.battle.normal.r1 + 1];
  return kind === 'pen' ? [wall, R - 1] : [wall, L.battle.normal.r1 + 1];
}

/**
 * Active field rows [r0, r1] of a view kind for the 2D board (render/tiles.js `setView` field: drawn rows outside it
 * are dim scenery without devices): the normal / 联防 / prep fields live between the separator walls (the devices on
 * the wall above the field included; the wall under the bench belongs to the boss field — tiles.js _stageDevices); the
 * pen camera adds the pen; the boss field takes its own wall row above it.
 */
export function fieldRows(kind, layout = null) {
  const L = layout || layoutOf(null);
  if (kind === 'boss' || kind === 'hidden' || kind === 'bossPrep') return [L.battle.boss.r0, L.battle.normal.r1 + 1];
  const top = kind === 'pen' ? L.pen.r1 : L.battle.normal.r1 + 1;
  return [bossWallRow(L), top];
}

/** The wall row under the bench, above the boss field (official row 6): `bossDispMaxRow(layout)`. */
const bossWallRow = (L) => L.battle.boss.r1 + 1;

/** Are the pen's figures shown for a view kind (a camera flight shows them when either end is the pen)? */
export const penShown = (vk, prevVk = null) => vk === 'pen' || prevVk === 'pen';

/** Is the prep's leader on the boss field shown for a view kind (a flight shows it when either end is the boss-field prep)? */
export const leaderShown = (vk, prevVk = null) => vk === 'bossPrep' || prevVk === 'bossPrep';

/** '2d' | '3d' | 'auto' board preference: `?board=` in the page URL (dev), else the view option. */
export function boardPreference(opt) {
  let q = null;
  try { q = new URLSearchParams(globalThis.location?.search || '').get('board'); } catch { /* no location */ }
  const v = q || opt;
  return v === '2d' || v === '3d' ? v : 'auto';
}

/**
 * A battle device box (render/units.js DeviceView `ctx.createBox()` contract: `{ mesh, update(cam, b), destroy() }`)
 * that follows the board layer: the 3D scene's crate mesh while `board()` returns a BoardScene, else the Pixi box of
 * the 2D board. A board switch mid-battle (lost WebGL context → 2D, or back to 3D) swaps the inner box on the next
 * update instead of leaving the crate on a dead scene. `mesh` is the Pixi mesh (null in 3D: nothing to add to Pixi).
 */
export function switchableBox({ board, pixi }) {
  let inner = null, owner;
  const drop = () => { try { inner?.destroy(); } catch { /* ignore */ } inner = null; owner = undefined; };
  return {
    get mesh() { return inner ? inner.mesh || null : null; },
    get inner() { return inner; },
    update(cam, b) {
      const scene = board() || null;
      if (!inner || owner !== scene || inner.destroyed) {
        drop();
        inner = scene ? scene.createDevice() : pixi();
        owner = scene;
      }
      inner?.update(cam, b);
    },
    destroy: drop,
  };
}

export { AREAS };
