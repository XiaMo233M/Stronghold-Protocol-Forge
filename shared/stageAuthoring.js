// shared/stageAuthoring.js — authoring a workshop STAGE (map): the pure half.
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
//
// A stage record (data/stages.json) is NOT hand-writable, because three of its fields are DERIVED from the grid and
// getting them wrong breaks movement silently. The reference implementation is tools/build-data.mjs:2294-2327; this
// module mirrors the pure parts and server/stageAuthoring.js mirrors the parts that need the sim.
//
//   deployTiles             derived from the legend's buildable/height over 3 rects   → here (pure)
//   groundPaths             the sim's own flow field over 12 fixed route pairs         → server/stageAuthoring.js
//   groundPathsWithDevices  the same, with the active blocking devices applied         → server/stageAuthoring.js
//
// The author supplies only what a person can actually draw:
//   rows     19 strings of 21 glyphs; **row 0 is the BOTTOM row** (the engine's convention, docs/DATA.md §0)
//   tiles    the glyph legend (glyph → tile properties)
//   devices  stage devices with pos/dir/role; `active` decides whether it blocks at match start

/** Stage grid size (docs/DESIGN.md §3: every stage is 19 rows × 21 cols). */
export const STAGE_ROWS = 19;
export const STAGE_COLS = 21;
/** The full-grid rect the ground paths are computed over (tools/build-data.mjs:2130). */
export const GRID_RECT = Object.freeze({ r0: 0, r1: 18, c0: 0, c1: 20 });

/**
 * The 12 route pairs whose paths data/stages.json stores, verbatim from tools/build-data.mjs:2314-2317.
 * [start, end] as [row, col]; a pair is skipped when either end is not fully ground-passable.
 */
export const GATE_PAIRS = Object.freeze([
  [[9, 10], [9, 2]], [[12, 10], [9, 2]], [[9, 18], [9, 2]], [[12, 18], [9, 2]],
  [[2, 10], [2, 2]], [[5, 10], [2, 2]], [[2, 10], [1, 3]], [[5, 10], [1, 3]],
  [[2, 10], [2, 18]], [[5, 10], [2, 18]], [[2, 10], [1, 17]], [[5, 10], [1, 17]],
]);

/** The three deployment rects, as [r0, r1, c0, c1] (tools/build-data.mjs:2334). */
export const DEPLOY_RECTS = Object.freeze({
  normal: Object.freeze([9, 12, 2, 10]),
  bossLeft: Object.freeze([1, 5, 2, 10]),
  bossRight: Object.freeze([1, 5, 10, 18]),
});

/** Device roles that block ground movement while active (tools/build-data.mjs:2147). */
export const BLOCKING_ROLES = Object.freeze(['crate', 'platform', 'mound']);

/**
 * Glyphs the editor offers, with a label and a display colour. Not a validation whitelist (a pack may define its own
 * legend), but the canonical set a stage is usually built from — mirroring server/sim/grid.js DEFAULT_LEGEND.
 */
export const TILE_PALETTE = Object.freeze([
  { glyph: 'r', label: '道路', tileKey: 'tile_road', height: 'LOW', buildable: 'ALL', passable: 'ALL', color: '#6b5a45' },
  { glyph: 'f', label: '地面', tileKey: 'tile_floor', height: 'LOW', buildable: 'NONE', passable: 'ALL', color: '#4a4f57' },
  { glyph: 'p', label: '地面(可部署)', tileKey: 'tile_floor', height: 'LOW', buildable: 'MELEE', passable: 'ALL', color: '#566070' },
  { glyph: '#', label: '高台', tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'RANGED', passable: 'FLY', color: '#3a3f47' },
  { glyph: 'X', label: '阻隔', tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE', color: '#23262b' },
  { glyph: 'a', label: '高台(不可部署)', tileKey: 'tile_achand', height: 'HIGH', buildable: 'NONE', passable: 'FLY', color: '#31363d' },
  { glyph: 'b', label: '围栏', tileKey: 'tile_fence_bound', height: 'LOW', buildable: 'ALL', passable: 'FLY', color: '#5d5140' },
  { glyph: 'S', label: '敌方入口', tileKey: 'tile_start', height: 'LOW', buildable: 'NONE', passable: 'ALL', color: '#8c3b3b', special: 'start' },
  { glyph: 'E', label: '保护目标', tileKey: 'tile_end', height: 'LOW', buildable: 'NONE', passable: 'ALL', color: '#2f6b52', special: 'end' },
  { glyph: 'I', label: '传送入口', tileKey: 'tile_telin', height: 'LOW', buildable: 'NONE', passable: 'ALL', color: '#5a4a7a', special: 'telin' },
  { glyph: 'O', label: '传送出口', tileKey: 'tile_telout', height: 'LOW', buildable: 'NONE', passable: 'ALL', color: '#4a6a7a', special: 'telout' },
  { glyph: 'm', label: '沼泽', tileKey: 'tile_mire', height: 'LOW', buildable: 'ALL', passable: 'ALL', color: '#4d5a3a', terrain: 'mire' },
  { glyph: 'g', label: '毒雾', tileKey: 'tile_smog', height: 'LOW', buildable: 'ALL', passable: 'ALL', color: '#5a4d5a', terrain: 'smog' },
  { glyph: 'd', label: '深水区', tileKey: 'tile_deepsea', height: 'LOW', buildable: 'NONE', passable: 'ALL', color: '#2b3f5c', terrain: 'deepsea' },
  { glyph: 'i', label: '源石污染', tileKey: 'tile_infection', height: 'LOW', buildable: 'ALL', passable: 'ALL', color: '#5c3f2b', terrain: 'infection' },
  // 空气 (the world OUTSIDE the map). Mechanically it IS 阻隔 (`X`): tile_forbidden is neither walkable nor deployable, so
  // the engine needs no new concept. The difference is presentation only — `air: true` tells the engine-agnostic editor
  // and the renderer to draw EMPTY space instead of a wall. normalizeLegendEntry ignores unknown fields, so a legend
  // entry carrying `air` reaches the engine as a plain forbidden tile.
  { glyph: '-', label: '空气', tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE', passable: 'NONE', color: '#15171a', air: true },
]);

/**
 * Tile keys whose mechanism refuses deployment however buildable the level says they are. This is 深水区 `tile_deepsea`
 * alone: PRTS 深水区 "地形机制 拒绝部署（待补充）" and the engine's own server/sim/grid.js DEPLOY_REFUSED_TILES, which
 * this set is pinned equal to by test/stageRules.test.js.
 *
 * 阻隔 / 空气 (tile_forbidden) are deliberately NOT in the set. They are never deployable because their `buildable` is
 * 'NONE' — the ordinary rule — and a map whose data says otherwise is deployable there, exactly as the engine's
 * buildDeployMap treats it (`tile_forbidden` is used for 高台 too, and official stages deploy on it).
 */
export const DEPLOY_REFUSED_TILES = Object.freeze(new Set(['tile_deepsea']));

/**
 * Rule 3 of the tile rules — may a GROUND tile of this map host a 高台 operator?
 *
 * A stage's `options.groundHighGround` (boolean, default false) is the option; this function is the pure read of it, so
 * the editor and the forms can ask "这张图的地面能不能放高台" without importing the sim. What it changes on the deploy
 * side is in deriveDeployTiles (`opts.groundHighGround`).
 * @param {object} spec an authoring spec or a derived stage record (both carry `options`)
 * @returns {boolean}
 */
export function groundRuleOf(spec) {
  return !!(isPlain(spec) && isPlain(spec.options) && spec.options.groundHighGround === true);
}

/**
 * The vocabularies a legend entry may use. These are pinned to the OFFICIAL data by a drift guard in
 * test/stageAuthoring.test.js — the same technique that keeps PROFESSIONS honest, and whose absence once let an
 * invented vocabulary reject 88 official records.
 *
 * `passable` keeps the raw `passableMask`: its fly-only spelling is **`FLY_ONLY`** (the engine's grid.js normPass
 * accepts any `*FLY*`, so both `FLY` and `FLY_ONLY` are understood).
 */
export const HEIGHT_VALUES = Object.freeze(['LOW', 'HIGH']);
export const BUILDABLE_VALUES = Object.freeze(['ALL', 'MELEE', 'RANGED', 'NONE']);
export const PASSABLE_VALUES = Object.freeze(['ALL', 'FLY', 'FLY_ONLY', 'NONE']);
/** Route motion classes (server/sim/simdata.js normalizeRoute). */
export const ROUTE_MOTIONS = Object.freeze(['WALK', 'FLY']);

const isPair = (p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1]);
const inGrid = (p) => isPair(p) && p[0] >= 0 && p[0] < STAGE_ROWS && p[1] >= 0 && p[1] < STAGE_COLS;

/**
 * Validate the map's authored ROUTES — the 出生点 → 防守点 path that IS the 卫戍协议 flow.
 *
 * A route is `{ motion, start: [r,c], end: [r,c], checkpoints: [[r,c], …] }`: the SAME shape `data/waves.json` stores,
 * because that is where the engine reads routes from (`Battle` normaliseRoute; each spawn picks one by `routeIndex`).
 * The map editor authors them because they are spatial; the wave layer binds them to rounds.
 *
 * `start` should sit on the enemy gate ('S' / a `special: 'start'` tile) and `end` on the protected objective
 * ('E' / `special: 'end'`) — that mismatch is reported as a WARNING, not an error, because teleporters ('I'/'O') and
 * boss spawns legitimately route between other tiles.
 */
export function validateRoutes(routes, rows, legend) {
  const out = [];
  if (routes === undefined) return out;
  if (!Array.isArray(routes)) {
    out.push({ field: 'routes', code: 'BAD_ROUTES', severity: 'error', message: 'routes must be an array' });
    return out;
  }
  const leg = isPlain(legend) ? legend : {};
  // `rows` is optional: a WAVE's routes are validated on their own (a wave is not tied to one grid here), and the
  // gate/objective warnings only make sense when the stage's grid is known. The wave editor passes it when it has it.
  const hasGrid = Array.isArray(rows) && rows.length > 0;
  const specialAt = (p) => {
    const line = Array.isArray(rows) ? rows[p[0]] : undefined;
    if (typeof line !== 'string') return null;
    const entry = leg[line[p[1]]];
    return entry && typeof entry.special === 'string' ? entry.special : null;
  };
  routes.forEach((route, i) => {
    const at = `routes[${i}]`;
    if (!isPlain(route)) { out.push({ field: at, code: 'BAD_ROUTE', severity: 'error', message: 'a route must be an object' }); return; }
    if (!ROUTE_MOTIONS.includes(route.motion)) {
      out.push({ field: `${at}.motion`, code: 'BAD_ENUM', severity: 'error', message: `motion must be one of ${ROUTE_MOTIONS.join(', ')}`, hint: 'WALK follows the ground flow field; FLY goes straight between its points' });
    }
    for (const key of ['start', 'end']) {
      if (!inGrid(route[key])) {
        out.push({ field: `${at}.${key}`, code: 'BAD_POS', severity: 'error', message: `${key} must be [row, col] inside the ${STAGE_ROWS}×${STAGE_COLS} grid` });
      }
    }
    const cps = route.checkpoints === undefined ? [] : route.checkpoints;
    if (!Array.isArray(cps)) out.push({ field: `${at}.checkpoints`, code: 'BAD_CHECKPOINTS', severity: 'error', message: 'checkpoints must be an array of [row, col]' });
    else cps.forEach((cp, k) => {
      // a checkpoint may also be { type: 'MOVE'|'WAIT'|'APPEAR', pos: [r,c] } — the engine accepts both shapes
      const pos = isPlain(cp) ? cp.pos : cp;
      if (!inGrid(pos)) out.push({ field: `${at}.checkpoints[${k}]`, code: 'BAD_POS', severity: 'error', message: 'a checkpoint must be [row, col] inside the grid' });
    });
    if (hasGrid && inGrid(route.start) && specialAt(route.start) !== 'start') {
      out.push({ field: `${at}.start`, code: 'START_NOT_ON_GATE', severity: 'warning', message: `the route starts at ${JSON.stringify(route.start)}, which is not an enemy gate tile`, hint: "paint an 'S' tile there, or accept that enemies appear mid-map" });
    }
    if (hasGrid && inGrid(route.end) && specialAt(route.end) !== 'end') {
      out.push({ field: `${at}.end`, code: 'END_NOT_ON_GOAL', severity: 'warning', message: `the route ends at ${JSON.stringify(route.end)}, which is not a protection-objective tile`, hint: "paint an 'E' tile there (the tile enemies leak to)" });
    }
  });
  return out;
}
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accepts either 19 strings or one newline-separated string; returns the 19 rows or null. */
export function normalizeRows(rows) {
  if (typeof rows === 'string') {
    const lines = rows.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    return lines.length ? lines : null;
  }
  if (Array.isArray(rows) && rows.every((r) => typeof r === 'string')) return rows;
  return null;
}

/**
 * The three deployment maps, derived exactly as tools/build-data.mjs:2294-2308 does and aligned with the engine's own
 * server/match/board.js buildDeployMap (:104-107):
 *
 *   LOW  + buildable ALL or MELEE                 → melee
 *   LOW  + buildable RANGED                       → rangedOnly   (a 远程位 painted on the ground; board.js:106)
 *   HIGH (except tile_achand) + buildable ALL/RANGED → rangedOnly (a 高台)
 *   a DEPLOY_REFUSED_TILES key (深水区)            → never deployable, whatever the legend claims
 *
 * The active device overrides (射击台 platform, 阻隔工事 crate, 特制水上平台) are applied FIRST, exactly as build-data does.
 *
 * `opts.groundHighGround` (default false) is the per-map rule 3: when it is true, a **ground** tile that is simply NONE-
 * buildable (地面 / 沼泽 / 毒雾 / 围栏 / 源石污染 — `height: 'LOW'`, `buildable: 'NONE'`) also counts as a 远程位, i.e.
 * a 高台 operator may be deployed there. It is equivalent to reading that tile as LOW + RANGED. 阻隔 / 空气 and 深水区
 * stay undeployable even then — by their `buildable: 'NONE'` and by key respectively.
 *
 * @param {string[]} rows 19 glyph rows (row 0 = bottom)
 * @param {Record<string, object>} legend glyph → { tileKey, height, buildable, passable, … }
 * @param {Array<{pos:number[], role:string, active?:boolean}>} [devices]
 * @param {{ groundHighGround?: boolean }} [opts] the map's own tile rule (see groundRuleOf)
 * @returns {{ melee: number[][], rangedOnly: number[][], changedByDevices: number[][] }} per rect
 */
export function deriveDeployTiles(rows, legend, devices = [], opts = {}) {
  const groundHighGround = !!(isPlain(opts) && opts.groundHighGround === true);
  const active = (devices || []).filter((d) => d && d.active && Array.isArray(d.pos));
  const activeBlocking = active.filter((d) => BLOCKING_ROLES.includes(d.role));
  const blocked = new Set(activeBlocking.map((d) => d.pos.join(',')));
  const platformAt = new Set(activeBlocking.filter((d) => d.role === 'platform').map((d) => d.pos.join(',')));
  const waterPlatformAt = new Set(active.filter((d) => d.role === 'waterPlatform').map((d) => d.pos.join(',')));
  const leg = isPlain(legend) ? legend : {};
  const tileAt = (r, c) => {
    const line = Array.isArray(rows) ? rows[r] : undefined;
    if (typeof line !== 'string' || c < 0 || c >= line.length) return null;
    return leg[line[c]] || null;
  };
  const deployIn = (r0, r1, c0, c1) => {
    const melee = [];
    const rangedOnly = [];
    const changedByDevices = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = tileAt(r, c);
        if (!t) continue;
        const k = `${r},${c}`;
        const bt = t.buildable;
        const buildable = bt !== 'NONE';
        // Devices are applied FIRST, exactly as build-data does: a device lands ON the tile, so its override wins over
        // the tile's own rule. That is the only reason the official 深水区 + 特制水上平台 pair is deployable at all.
        if (platformAt.has(k)) { rangedOnly.push([r, c]); if (buildable) changedByDevices.push([r, c]); continue; }
        if (blocked.has(k)) { if (buildable) changedByDevices.push([r, c]); continue; }
        if (waterPlatformAt.has(k)) { melee.push([r, c]); if (!buildable) changedByDevices.push([r, c]); continue; }
        // With no device on it, a REFUSED tile key (深水区) refuses deployment however buildable the legend claims — the
        // engine normalises such a tile to NONE, so it can never be a deploy tile of its own.
        if (DEPLOY_REFUSED_TILES.has(t.tileKey)) continue;
        if (t.height === 'LOW' && (bt === 'ALL' || bt === 'MELEE')) melee.push([r, c]);
        else if (t.height === 'LOW' && (bt === 'RANGED' || (groundHighGround && bt === 'NONE'))) rangedOnly.push([r, c]);
        else if (bt === 'RANGED' || (t.height === 'HIGH' && bt === 'ALL' && t.tileKey !== 'tile_achand')) rangedOnly.push([r, c]);
      }
    }
    return { melee, rangedOnly, changedByDevices };
  };
  const out = {};
  for (const [name, [r0, r1, c0, c1]] of Object.entries(DEPLOY_RECTS)) out[name] = deployIn(r0, r1, c0, c1);
  return out;
}

/** Every glyph the rows actually use, with how many times. */
export function glyphUsage(rows) {
  const out = new Map();
  for (const line of Array.isArray(rows) ? rows : []) {
    for (const ch of String(line)) out.set(ch, (out.get(ch) || 0) + 1);
  }
  return out;
}

/**
 * Validate a stage record at this layer. Like validateChessRecord: reports everything it can see, in a machine-readable
 * shape, and `[]` is not a proof of correctness (the derived fields are checked by server/stageAuthoring.js).
 * @param {object} stage
 * @param {{ officialIds?: Set<string>|string[], id?: string }} [opts]
 * @returns {Array<{ field: string, code: string, message: string, hint?: string, severity: 'error'|'warning' }>}
 */
export function validateStage(stage, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  if (!isPlain(stage)) { err('', 'NOT_AN_OBJECT', 'stage must be a JSON object'); return out; }
  const id = opts.id ?? stage.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.:]{1,64}$/.test(id)) err('id', 'BAD_ID', `"${id}" is not a usable stage id`);
  const official = opts.officialIds instanceof Set ? opts.officialIds : new Set(opts.officialIds || []);
  if (official.has(id)) {
    err('id', 'OFFICIAL_ID_COLLISION', `"${id}" already exists in the official data`,
      `replace it only on purpose: add "stages:${id}" to the pack's overrides`);
  }
  const rows = normalizeRows(stage.rows);
  if (!rows) err('rows', 'BAD_ROWS', 'rows must be 19 strings of glyphs (or one newline-separated string)');
  else {
    if (rows.length !== STAGE_ROWS) err('rows', 'BAD_SIZE', `rows must have exactly ${STAGE_ROWS} lines, got ${rows.length}`);
    rows.forEach((line, r) => {
      if (line.length !== STAGE_COLS) err(`rows[${r}]`, 'BAD_SIZE', `row ${r} must be exactly ${STAGE_COLS} glyphs, got ${line.length}`);
    });
    const legend = isPlain(stage.tiles) ? stage.tiles : {};
    for (const [glyph, count] of glyphUsage(rows)) {
      if (glyph === ' ') continue;
      if (!isPlain(legend[glyph])) {
        err(`tiles["${glyph}"]`, 'GLYPH_UNDEFINED', `the rows use "${glyph}" ${count} time(s) but the tiles legend does not define it`,
          'every glyph in the map must have a legend entry, or that tile cannot be placed');
      }
    }
    // a playable stage needs an enemy gate and a protected objective
    if (!glyphUsage(rows).has('S')) warn('rows', 'NO_GATE', 'no "S" (enemy gate) tile: nothing can spawn');
    if (!glyphUsage(rows).has('E')) warn('rows', 'NO_GOAL', 'no "E" (protection objective) tile: nothing can leak');
  }
  const legend = isPlain(stage.tiles) ? stage.tiles : {};
  for (const [glyph, t] of Object.entries(legend)) {
    if (glyph.length !== 1) err(`tiles["${glyph}"]`, 'BAD_GLYPH', 'a legend key must be a single character');
    if (!isPlain(t)) { err(`tiles["${glyph}"]`, 'BAD_TILE', 'a legend entry must be an object'); continue; }
    if (typeof t.tileKey !== 'string' || !t.tileKey) err(`tiles["${glyph}"].tileKey`, 'MISSING', 'tileKey is required');
    if (!HEIGHT_VALUES.includes(t.height)) err(`tiles["${glyph}"].height`, 'BAD_ENUM', `height must be one of ${HEIGHT_VALUES.join(', ')}`);
    if (!BUILDABLE_VALUES.includes(t.buildable)) err(`tiles["${glyph}"].buildable`, 'BAD_ENUM', `buildable must be one of ${BUILDABLE_VALUES.join(', ')}`);
    if (t.passable !== undefined && !PASSABLE_VALUES.includes(t.passable)) {
      err(`tiles["${glyph}"].passable`, 'BAD_ENUM', `passable must be one of ${PASSABLE_VALUES.join(', ')}`);
    }
  }
  for (const [i, d] of (Array.isArray(stage.devices) ? stage.devices : []).entries()) {
    if (!isPlain(d)) { err(`devices[${i}]`, 'BAD_DEVICE', 'a device must be an object'); continue; }
    if (typeof d.key !== 'string' || !d.key) err(`devices[${i}].key`, 'MISSING', 'device key is required');
    if (!Array.isArray(d.pos) || d.pos.length !== 2 || !d.pos.every((n) => Number.isInteger(n))) {
      err(`devices[${i}].pos`, 'BAD_POS', 'pos must be [row, col] integers');
    } else if (d.pos[0] < 0 || d.pos[0] >= STAGE_ROWS || d.pos[1] < 0 || d.pos[1] >= STAGE_COLS) {
      err(`devices[${i}].pos`, 'OUT_OF_BOUNDS', `pos ${JSON.stringify(d.pos)} is outside the ${STAGE_ROWS}×${STAGE_COLS} grid`);
    }
  }
  if (!isPlain(stage.options)) warn('options', 'MISSING', 'options is missing: characterLimit and moveMultiplier fall back to the engine defaults');
  if (!isPlain(stage.tiles)) err('tiles', 'MISSING', 'the tiles legend is required');
  // 联防图 (kind 'unite'): the map declares how many players it defends with. helpers exists ONLY there — on any other
  // map it would be metadata nothing reads, which is the kind of silent drift this validator exists to prevent.
  if (stage.kind !== undefined && stage.kind !== 'unite') {
    err('kind', 'BAD_KIND', `kind must be 'unite' or omitted, got ${JSON.stringify(stage.kind)}`, "the only kind a stage declares is 'unite' (联防图)");
  }
  const wantedHelpers = stage.kind === 'unite' ? (stage.helpers === undefined ? 2 : stage.helpers) : undefined;
  if (stage.kind === 'unite' && !(Number.isInteger(wantedHelpers) && wantedHelpers >= 1 && wantedHelpers <= 2)) {
    err('helpers', 'BAD_HELPERS', `a unite map needs helpers 1..2 (it is how many players defend it), got ${JSON.stringify(stage.helpers)}`);
  }
  if (stage.kind !== 'unite' && stage.helpers !== undefined) {
    err('helpers', 'HELPERS_WITHOUT_KIND', "helpers is only allowed on kind: 'unite'", "a solo map has no 联防 count to declare");
  }
  // 空气 (`-`) and 阻隔 (`X`) are the SAME rule (tile_forbidden): the difference is how the editor DRAWS them. Nothing
  // mechanically separates them, and this validator must not pretend otherwise — so no rule here keys off `air`.
  // authored routes live in the SPEC (the stage RECORD has no routes field — the engine reads them from the wave)
  for (const issue of validateRoutes(stage.routes, rows || [], stage.tiles)) out.push(issue);
  // The stage's OWN per-round templates (workshop maps only; official stages have neither field). The engine reads them
  // before the mode's, because the stage and the round's template are otherwise chosen independently — see
  // server/match/waves.js stageTemplateId.
  for (const field of ['rounds', 'bossRounds']) {
    const map = stage[field];
    if (map === undefined) continue;
    if (!isPlain(map)) { err(field, 'BAD_ROUNDS', `${field} must be an object keyed by round number`); continue; }
    for (const [key, value] of Object.entries(map)) {
      const r = Number(key);
      if (!Number.isInteger(r) || r < 1 || r > 15) err(`${field}[${key}]`, 'BAD_ROUND', `${field} keys must be round numbers 1..15`);
      const isId = (v) => typeof v === 'string' && v.length > 0;
      if (field === 'rounds') {
        if (!isId(value) && !(isPlain(value) && isId(value.template))) {
          err(`${field}[${key}]`, 'BAD_TEMPLATE', 'a round must name a wave id (or { template: id })', 'the id is a waves.json key from this pack, or an official one');
        }
      } else if (!isPlain(value)) {
        err(`${field}[${key}]`, 'BAD_TEMPLATE', 'bossRounds[round] must map a boss id to a wave id');
      } else {
        for (const [bossId, waveId] of Object.entries(value)) {
          if (!isId(waveId)) err(`${field}[${key}].${bossId}`, 'BAD_TEMPLATE', 'a boss round must name a wave id');
        }
      }
    }
  }
  return out;
}

/** The errors of a validation result. */
export const stageErrors = (issues) => (Array.isArray(issues) ? issues.filter((i) => i.severity === 'error') : []);

// ---- 样板地图 (the sample map the editor's 「以模板新建」 starts from) -------------------------------------------
//
// A complete, LEGAL single-player map an author can open and edit instead of an empty grid: a 敌方入口 ('S'), a 保护目标
// ('E'), road, plain ground, 高台, 阻隔 and 围栏, all wrapped in a ring of 空气 ('-') so the map visibly ends. It also
// carries ONE hand-drawn WALK route from the gate to the objective — which is what makes the paths derivation run under
// the default `opts.paths` (see server/stageAuthoring.js deriveStage).
//
// The map is intentionally 单人视角 (one deployment field, the normal 9–12 × 2–10 rect) so it can be derived and played
// without any 联防 bookkeeping; a 联防图 is made by declaring `kind: 'unite'` (see validateStage).

/** The 19 rows of the sample map, bottom row first (row 6 = the gate lane, row 12 = the objective lane). */
const SAMPLE_GRID_ROWS = Object.freeze([
  '---------------------',
  '---------------------',
  '---fffffffffffffff---',
  '---f###########fff---',
  '---f#fffffffff#fff---',
  '---f#fffffffff#fff---',
  '--Sf#fffffffff#fff---',
  '---fffXfffffffffffff-',
  '---ffffffffffffff#f--',
  '---###ffffrrrrrrrf---',
  '---###ffffrrrrrrrf---',
  '---aaffffrrrrrrrrr---',
  '---fffffffff###fEf---',
  '---fffffffffffffff---',
  '---fffffffffffffff---',
  '---------------------',
  '---------------------',
  '---------------------',
  '---------------------',
]);

/**
 * The legend of the sample map: EVERY glyph the palette can draw plus 空气 (`-`), each built from TILE_PALETTE so the
 * template can never disagree with the palette. The entries carry `air` through for 空气, and the engine ignores it.
 */
function sampleLegend() {
  const out = {};
  for (const t of TILE_PALETTE) {
    out[t.glyph] = {
      tileKey: t.tileKey,
      height: t.height,
      buildable: t.buildable,
      passable: t.passable,
      groundPassable: t.passable === 'ALL',
      flyPassable: t.passable !== 'NONE',
      special: t.special ?? null,
      bb: {},
      ...(t.terrain ? { terrain: t.terrain } : {}),
      ...(t.air ? { air: true } : {}),
    };
  }
  return out;
}

/** The one drawn route: 出生点 → 防守点, the path the enemy walks and the path the editor can re-derive on demand. */
const SAMPLE_ROUTES = Object.freeze([
  Object.freeze({ motion: 'WALK', start: Object.freeze([6, 2]), end: Object.freeze([12, 16]), checkpoints: Object.freeze([]) }),
]);

/**
 * The sample map, in the shape the editor's 「以模板新建」 writes into its form: `{ id, name, spec }`.
 *
 * `spec` is a deep copy on every construction (`sampleStageSpec()`), so a form that edits it cannot corrupt the
 * template. It validates and derives as-is — `paths` both true and false — see test/stageRules.test.js.
 */
export const SAMPLE_STAGE_SPEC = Object.freeze({
  id: 'ws_sample_map',
  name: '样板地图·单人小道',
  spec: Object.freeze({
    id: 'ws_sample_map',
    name: '样板地图·单人小道',
    weight: 40,
    modes: [],
    rows: SAMPLE_GRID_ROWS,
    tiles: null,
    devices: [],
    routes: SAMPLE_ROUTES,
    options: Object.freeze({ characterLimit: 8, moveMultiplier: 0.5 }),
  }),
});

/** A fresh, editable copy of the sample map spec (a plain object; the caller owns it). */
export function sampleStageSpec() {
  return {
    ...SAMPLE_STAGE_SPEC.spec,
    rows: [...SAMPLE_GRID_ROWS],
    tiles: sampleLegend(),
    devices: [],
    routes: SAMPLE_ROUTES.map((r) => ({ ...r, start: [...r.start], end: [...r.end], checkpoints: [] })),
    options: { ...SAMPLE_STAGE_SPEC.spec.options },
  };
}
