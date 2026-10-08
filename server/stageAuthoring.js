// server/stageAuthoring.js — authoring a workshop STAGE: the half that needs the sim's pathing.
//
// `groundPaths` / `groundPathsWithDevices` cannot be hand-written. data/stages.json derives them from the sim's OWN flow
// field over the whole 19×21 grid for 12 fixed route pairs (tools/build-data.mjs:2311-2327), so a hand-written table
// would disagree with how enemies actually walk. This module runs the same computation on a workshop stage by
// constructing server/sim/grid.js Grid exactly as build-data does — one implementation, no drift.
//
// Everything here is Node-only (it imports the sim); the pure parts live in shared/stageAuthoring.js so the browser can
// share the deploy-tile rule and the validator without importing the sim.

import { Grid, normalizeLegendEntry } from './sim/grid.js';
import {
  GATE_PAIRS, GRID_RECT, BLOCKING_ROLES, STAGE_ROWS, STAGE_COLS,
  deriveDeployTiles, groundRuleOf, validateStage, stageErrors, normalizeRows,
  gridRectOf, gatePairsFor, deployRectsOf,
} from '../shared/stageAuthoring.js';
import { normalizeLayout, layoutForSize, sizeOf, OFFICIAL_SIZE } from '../shared/layout.js';

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One ground route: the sim's flow field over the whole grid, returned as the tiles it crosses.
 * Mirrors tools/build-data.mjs officialPath (2113-2137). `rect` is the grid the field runs over — the official
 * 0–18/0–20 window for an official record, the map's own window for a bigger one.
 */
function officialPath(rows, legend, devices, start, end, rect = GRID_RECT) {
  const g = new Grid({ rows, legend }, rect);
  for (const d of devices) {
    if (!d.pos) continue;
    if (d.role === 'crate') g.setObstacle(d.pos[0], d.pos[1], true, 'crate');
    else g.setObstacle(d.pos[0], d.pos[1], true);
  }
  return g.findPath(start[0], start[1], end[0], end[1]);
}

/** Whether a tile is fully ground-passable (`passableMask === 'ALL'` in build-data terms). */
function passableAll(rows, legend, r, c) {
  const line = rows[r];
  if (typeof line !== 'string' || c < 0 || c >= line.length) return false;
  const e = legend[line[c]];
  if (!e) return false;
  return normalizeLegendEntry(line[c], e).pass === 'ALL';
}

/**
 * The two derived path tables of a stage, exactly as data/stages.json stores them.
 *
 * The pairs walked are the map's own (`gatePairsFor`): the 12 official gate pairs at the official size, so an official
 * record re-derives byte for byte, and a big map's own 敌方入口 → 保护目标 pairs otherwise.
 * @param {{rows: string[]|string, tiles: object, devices?: object[], size?: number[], layout?: object}} stage
 * @returns {{ groundPaths: Record<string, number[][]>, groundPathsWithDevices: Record<string, number[][]> }}
 */
export function deriveGroundPaths(stage) {
  const rows = normalizeRows(stage && stage.rows) || [];
  const legend = isPlain(stage && stage.tiles) ? stage.tiles : {};
  const devices = Array.isArray(stage && stage.devices) ? stage.devices : [];
  const size = sizeOf(stage);
  const rect = size[0] === OFFICIAL_SIZE[0] && size[1] === OFFICIAL_SIZE[1] ? GRID_RECT : gridRectOf(size);
  // only ACTIVE blocking devices reroute the path (build-data:2290) — a hidden crate does not exist yet
  const activeBlocking = devices.filter((d) => d && d.active && BLOCKING_ROLES.includes(d.role));
  const groundPaths = {};
  const groundPathsWithDevices = {};
  for (const [a, b] of gatePairsFor(rows, legend, size)) {
    const k = `${a.join(',')}->${b.join(',')}`;
    if (!passableAll(rows, legend, a[0], a[1]) || !passableAll(rows, legend, b[0], b[1])) continue;
    const p1 = officialPath(rows, legend, [], a, b, rect);
    if (p1) groundPaths[k] = p1;
    const p2 = officialPath(rows, legend, activeBlocking, a, b, rect);
    if (p2) groundPathsWithDevices[k] = p2;
  }
  return { groundPaths, groundPathsWithDevices };
}

/**
 * The sim's own path for each AUTHORED route, so the map editor draws exactly where a wave that uses the route walks.
 *
 * A route is the 出生点 → 防守点 path of 卫戍协议, stored the way `data/waves.json` stores it. WALK legs run on the
 * sim's flow field (leg by leg through the checkpoints); FLY legs go straight between their points — that is what
 * server/sim/ai.js does ("FLY legs fly straight between checkpoints").
 *
 * @param {{rows: string[]|string, tiles: object, devices?: object[]}} stage
 * @param {Array<{motion:string, start:number[], end:number[], checkpoints?:any[]}>} routes
 * @returns {Array<{ index: number, motion: string, path: number[][]|null, reason: string|null }>}
 */
export function deriveRoutePaths(stage, routes) {
  const rows = normalizeRows(stage && stage.rows) || [];
  const legend = isPlain(stage && stage.tiles) ? stage.tiles : {};
  const devices = Array.isArray(stage && stage.devices) ? stage.devices : [];
  const activeBlocking = devices.filter((d) => d && d.active && BLOCKING_ROLES.includes(d.role));
  const size = sizeOf(stage);
  const rect = size[0] === OFFICIAL_SIZE[0] && size[1] === OFFICIAL_SIZE[1] ? GRID_RECT : gridRectOf(size);
  const out = [];
  for (const [index, route] of (Array.isArray(routes) ? routes : []).entries()) {
    const motion = route && route.motion === 'FLY' ? 'FLY' : 'WALK';
    const pts = [];
    const push = (p) => { if (Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1])) pts.push([p[0], p[1]]); };
    push(route && route.start);
    for (const cp of (route && route.checkpoints) || []) push(cp && typeof cp === 'object' && !Array.isArray(cp) ? cp.pos : cp);
    push(route && route.end);
    if (pts.length < 2) { out.push({ index, motion, path: null, reason: 'a route needs at least a start and an end' }); continue; }
    if (motion === 'FLY') { out.push({ index, motion, path: pts, reason: null }); continue; }
    // a ground route follows the flow field leg by leg, with the active blocking devices applied — the same rule the
    // official ground paths use, so the preview cannot disagree with what the enemies will do
    let path = null;
    let failed = false;
    for (let k = 0; k + 1 < pts.length; k++) {
      const seg = officialPath(rows, legend, activeBlocking, pts[k], pts[k + 1], rect);
      if (!seg || !seg.length) { failed = true; break; }
      path = path && path.length ? path.concat(seg.slice(1)) : seg;
    }
    out.push({ index, motion, path: failed ? null : path, reason: failed ? 'no ground route between two of its points' : null });
  }
  return out;
}

/**
 * Build a complete, engine-valid stage record from an authoring spec. The author supplies only what can be drawn:
 * `id`, `name`, `rows`, `tiles`, `devices`, and optionally `modes`/`weight`/`options`/`config`/`routes`/`kind`/`helpers`.
 *
 * `modes` matters for more than metadata: a stage enters a match only when the mode's `stages` list names it, and the
 * loader appends a workshop stage's id to those entries (shared/workshop.js linkStages) — so a stage with no `modes`
 * would be valid yet never selected.
 *
 * `opts.paths` decides whether the map's gate pairs are walked to produce `groundPaths` /
 * `groundPathsWithDevices` — see the default below. The record ALWAYS carries both keys; a map with no derived route
 * gets an empty table rather than a missing field, so every reader can keep iterating it.
 *
 * The record also carries the map's own `size` and `layout` (shared/layout.js): the engine reads both, so a big map
 * plays on the zones its author drew. `spec.layout` is optional — omitted, the layout is the one `size` implies, and
 * for 19×21 that is exactly the official one.
 *
 * @param {object} spec
 * @param {{ paths?: boolean }} [opts]
 * @returns {{ ok: true, stage: object, routePaths: object[], warnings: string[] } | { ok: false, errors: object[] }}
 */
export function deriveStage(spec, opts = {}) {
  const errors = stageErrors(validateStage(spec));
  if (errors.length) return { ok: false, errors };
  const warnings = [];
  const size = sizeOf(spec);
  const layout = normalizeLayout(spec.layout, size);
  const rows = normalizeRows(spec.rows);
  const tiles = spec.tiles;
  const devices = (Array.isArray(spec.devices) ? spec.devices : []).map((d) => {
    const out = { ...d };
    // build-data's deviceActiveAtStart: exactly the non-hidden devices are active at match start
    if (out.active === undefined) out.active = out.hidden !== true;
    return out;
  });
  const weight = Number.isFinite(spec.weight) ? spec.weight : 50;
  const modes = Array.isArray(spec.modes) ? [...spec.modes] : [];
  if (!modes.length) {
    warnings.push('no `modes` given: the stage is valid but no mode will ever select it (the loader appends it to the modes it names).');
  }
  const options = isPlain(spec.options) ? spec.options : {};
  // 寻路表默认不派生：自动寻路只能由作者点按钮要（`opts.paths: true`，编辑器把它传进来），或者这张图自己画了
  // 路线（spec.routes 非空）—— 一条路都没画的新图不该带一堆猜出来的门到门路线。老行为（官方数据、CLI 脚手架）
  // 靠显式传 { paths: true } 或 spec.routes 保持原样。
  const derivePaths = opts && opts.paths !== undefined
    ? opts.paths === true
    : (Array.isArray(spec.routes) && spec.routes.length > 0);
  const paths = derivePaths ? deriveGroundPaths({ rows, tiles, devices, size, layout }) : { groundPaths: {}, groundPathsWithDevices: {} };
  const stage = {
    id: spec.id,
    name: typeof spec.name === 'string' && spec.name ? spec.name : spec.id,
    weight,
    active: weight > 0,
    modes,
    size: [size[0], size[1]],
    // 布局只在**与这张 size 的默认布局不同**时才写进记录：官方尺寸下默认布局就是历史常量，于是老样子的小图记录
    // 与今天逐字节一样，只有真挪过分区（或尺寸大于官方）的图才多出这一项。
    ...(JSON.stringify(layout) === JSON.stringify(layoutForSize(size)) ? {} : { layout }),
    rows,
    tiles,
    devices,
    mapChars: Array.isArray(spec.mapChars) ? spec.mapChars : [],
    special: isPlain(spec.special) ? spec.special : {},
    runes: Array.isArray(spec.runes) ? spec.runes : [],
    globalBuffs: Array.isArray(spec.globalBuffs) ? spec.globalBuffs : [],
    deployTiles: deriveDeployTiles(rows, tiles, devices, { groundHighGround: groundRuleOf(spec), rects: layout.deployRects }),
    groundPaths: paths.groundPaths,
    groundPathsWithDevices: paths.groundPathsWithDevices,
    // 联防图 (kind 'unite'): validateStage already enforced helpers ∈ 1..2 and rejected kind on anything else
    ...(spec.kind === 'unite' ? { kind: 'unite' } : {}),
    ...(spec.kind === 'unite' ? { helpers: spec.helpers === undefined ? 2 : spec.helpers } : {}),
    // a workshop map may name the wave template EACH round runs (server/match/waves.js stageTemplateId), because the
    // engine otherwise picks the stage and the round's template independently. Omitted when not declared, so an
    // official-shaped record stays exactly as it was.
    ...(isPlain(spec.rounds) ? { rounds: { ...spec.rounds } } : {}),
    ...(isPlain(spec.bossRounds) ? { bossRounds: { ...spec.bossRounds } } : {}),
    options: {
      characterLimit: Number.isFinite(options.characterLimit) ? options.characterLimit : 8,
      moveMultiplier: Number.isFinite(options.moveMultiplier) ? options.moveMultiplier : 0.5,
      // the per-map tile rule 3 (shared/stageAuthoring.js groundRuleOf) travels in the record, because the record is
      // what the editor reads back and what validateStageRecord re-derives deployTiles from
      ...(options.groundHighGround === true ? { groundHighGround: true } : {}),
    },
    config: isPlain(spec.config) ? spec.config : {},
  };
  // Only warn when the derivation was actually ASKED for: a map that simply has none of the 12 official gate pairs (or
  // was deliberately derived without 寻路) is not a broken map.
  if (derivePaths && !Object.keys(stage.groundPaths).length) {
    warnings.push('no ground route could be derived: check that the "S"/"E" tiles are ground-passable and reachable.');
  }
  // The authored ROUTES (the 出生点 → 防守点 path) are validated by running them through the sim: a route nothing can
  // walk is a broken map, and the author must hear about it here rather than watch enemies stand still in game.
  const routePaths = deriveRoutePaths({ rows, tiles, devices, size, layout }, spec.routes);
  const broken = routePaths.filter((r) => !r.path);
  if (broken.length) {
    return {
      ok: false,
      errors: broken.map((r) => ({ field: `routes[${r.index}]`, code: 'ROUTE_NOPATH', message: r.reason || 'no path between its points' })),
    };
  }
  if (Array.isArray(spec.routes) && spec.routes.length && !routePaths.some((r) => r.motion === 'WALK')) {
    warnings.push('every authored route is FLY: ground enemies have no route of their own and will fall back to route 0.');
  }
  return { ok: true, stage, routePaths, warnings };
}

/**
 * Validate a stored stage record INCLUDING the derived tables: are they present, and do they still match what the sim
 * computes now? A pack whose rows were edited by hand while groundPaths were left behind is the exact failure this
 * catches — the game would walk enemies along a route the map no longer has.
 *
 * "Do they still match" is judged per route key. A stored EMPTY table agrees with the grid producing nothing — that is
 * a map derived with 寻路 off (`opts.paths: false`), or one that has none of the 12 official gate pairs, not a stale
 * table. Comparing the tables wholesale would report every such map as stale, i.e. the check would call the new default
 * a defect.
 * @param {object} stage a full stage record
 * @param {{id?: string, officialIds?: Set<string>|string[]}} [opts]
 */
export function validateStageRecord(stage, opts = {}) {
  const issues = validateStage(stage, opts);
  if (!stage || typeof stage !== 'object' || !Array.isArray(stage.rows)) return issues;
  const expect = deriveGroundPaths(stage);
  for (const key of ['groundPaths', 'groundPathsWithDevices']) {
    const has = isPlain(stage[key]) ? stage[key] : null;
    if (!has) {
      issues.push({ field: key, code: 'MISSING_DERIVED', severity: 'error', message: `${key} is missing: it is derived, not authored`, hint: 'run the stage through deriveStage (tools/workshop-validate.mjs reports it)' });
      continue;
    }
    const want = expect[key];
    const absent = (v) => v === undefined || (Array.isArray(v) && v.length === 0);
    const stale = [];
    let missing = 0;
    for (const k of new Set([...Object.keys(has), ...Object.keys(want)])) {
      // both sides empty → the sim and the stored table agree that the map has no such route
      if (absent(has[k]) && absent(want[k])) continue;
      if (absent(has[k])) { missing++; continue; }
      if (JSON.stringify(has[k]) !== JSON.stringify(want[k])) stale.push(k);
    }
    if (stale.length) {
      issues.push({
        field: key, code: 'STALE_DERIVED', severity: 'error',
        message: `${stale.length} route(s) no longer match the grid`,
        hint: 're-derive it: the rows/tiles/devices were edited after the paths were computed',
      });
    }
    if (missing) {
      issues.push({ field: key, code: 'INCOMPLETE_DERIVED', severity: 'warning', message: `${missing} route(s) the sim can compute are absent` });
    }
  }
  const wantDeploy = deriveDeployTiles(normalizeRows(stage.rows), stage.tiles, stage.devices,
    { groundHighGround: groundRuleOf(stage), rects: normalizeLayout(stage.layout, sizeOf(stage)).deployRects });
  if (isPlain(stage.deployTiles) && JSON.stringify(stage.deployTiles) !== JSON.stringify(wantDeploy)) {
    issues.push({ field: 'deployTiles', code: 'STALE_DERIVED', severity: 'error', message: 'deployTiles no longer match the legend/devices', hint: 're-derive it' });
  }
  return issues;
}
