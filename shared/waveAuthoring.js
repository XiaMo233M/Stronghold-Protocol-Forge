// shared/waveAuthoring.js — authoring a workshop WAVE (每关出怪): order, time, count, interval and route.
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
//
// A waves.json record is what a round actually spawns. Two of its fields are DERIVED from `spawns`
// (tools/build-data.mjs:2043-2049) and they are NOT symmetric — reproducing that exactly is the point:
//
//   for (const sp of spawns) {
//     if (sp.action) continue;
//     if (sp.slot) slotCounts[sp.slot] = (slotCounts[sp.slot] || 0) + sp.count;   // includes `unharmful`
//     if (!sp.unharmful) total += sp.count;                                        // excludes `unharmful`
//   }
//
// `unharmful` marks a spawn that does not count toward the round's total (an escort that is there for show);
// `slot` is the 15-slot type schedule's key (N/NF/E/EF/S/SF/T/TF) that the faction replacement machinery addresses.
//
// The ROUTES of a wave are the map paths it walks (`{motion, start, end, checkpoints}`, selected per spawn by
// `routeIndex`) — the same shape the map editor authors. A wave's routes must match the geometry of the stage it runs
// on: the engine picks the stage and the round's template independently (server/match/waves.js setupMatchWaves vs
// buildNormalWave), which is why a workshop map needs its own round templates rather than inheriting official ones.

import { validateRoutes } from './stageAuthoring.js';

/** The kinds build-data assigns (tools/build-data.mjs:2038-2042). */
export const WAVE_KINDS = Object.freeze(['normal', 'boss', 'hidden', 'escaped', 'training']);
/** Every `slot` value the shipped data uses; null is the common case (no schedule slot). */
export const SPAWN_SLOTS = Object.freeze(['N', 'NF', 'E', 'EF', 'S', 'SF', 'T', 'TF']);
/** The spawn fields the shipped data uses. */
export const SPAWN_FIELDS = Object.freeze(['time', 'key', 'count', 'interval', 'routeIndex', 'slot', 'tag', 'group', 'pack', 'weight', 'unharmful', 'action']);
/** Rounds a mode has (config.modes[*].rounds keys). */
export const ROUNDS_PER_MODE = 15;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v, d) => (Number.isInteger(v) ? v : d);

/**
 * The two derived counters, exactly as tools/build-data.mjs:2043-2049 computes them.
 * `spawns` must already be normalised (numeric `count`), which `deriveWave` guarantees.
 * @param {object[]} spawns
 * @returns {{ totalCount: number, slotCounts: Record<string, number> }}
 */
export function deriveCounts(spawns) {
  const slotCounts = {};
  let total = 0;
  for (const sp of Array.isArray(spawns) ? spawns : []) {
    if (!isPlain(sp) || sp.action) continue;
    if (sp.slot) slotCounts[sp.slot] = (slotCounts[sp.slot] || 0) + sp.count;
    if (!sp.unharmful) total += sp.count;
  }
  return { totalCount: total, slotCounts };
}

/** `wave_ws_<slug>` from a slug or id. */
export function waveId(idOrSlug) {
  const raw = String(idOrSlug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const slug = raw.startsWith('wave_ws_') ? raw.slice('wave_ws_'.length) : raw;
  return slug ? { slug, id: `wave_ws_${slug}` } : null;
}

/**
 * Build a complete wave record from a spec.
 *
 * Spec: { id, kind?, solo?, bossId?, maxPlayTime?, characterLimit?, moveMultiplier?, bgm?,
 *         routes: [{ motion, start, end, checkpoints }],
 *         extraRoutes?, spawns: [{ time, key, count, interval, routeIndex?, slot?, tag?, group?, pack?, weight?, unharmful? }],
 *         branches?, overrides?, devices?, usedBy?: [{ modeId, round, bossId? }] }
 *
 * @returns {{ ok: true, wave: object, warnings: string[] } | { ok: false, errors: object[] }}
 */
export function deriveWave(spec) {
  const errors = [];
  const warnings = [];
  if (!isPlain(spec)) return { ok: false, errors: [{ field: '', code: 'NOT_AN_OBJECT', message: 'spec must be a JSON object' }] };
  const ids = waveId(spec.id);
  const req = (cond, field, code, message, hint) => { if (!cond) errors.push({ field, code, message, ...(hint ? { hint } : {}) }); };
  req(ids, 'id', 'BAD_ID', 'id must contain at least one letter or digit', 'e.g. "round_two_hounds"');
  if (spec.kind !== undefined) req(WAVE_KINDS.includes(spec.kind), 'kind', 'BAD_ENUM', `kind must be one of ${WAVE_KINDS.join(', ')}`);
  req(Array.isArray(spec.spawns) && spec.spawns.length > 0, 'spawns', 'EMPTY', 'a wave needs at least one spawn');
  req(Array.isArray(spec.routes) && spec.routes.length > 0, 'routes', 'EMPTY', 'a wave needs at least one route (the map route its spawns walk)');
  if (errors.length) return { ok: false, errors };

  const routes = spec.routes.map((r) => ({ ...r, checkpoints: Array.isArray(r.checkpoints) ? r.checkpoints.map((cp) => (isPlain(cp) ? { ...cp } : cp)) : [] }));
  const spawns = spec.spawns.map((sp, i) => {
    // A spawn field the engine does not read must be LOUD, not dropped: a typo (`sleot: 'N'`) would otherwise vanish and
    // the spawn would silently lose its schedule slot.
    for (const k of Object.keys(sp)) {
      if (!SPAWN_FIELDS.includes(k)) {
        errors.push({ field: `spawns[${i}].${k}`, code: 'UNKNOWN_FIELD', message: `"${k}" is not a spawn field the engine reads`, hint: `known fields: ${SPAWN_FIELDS.join(', ')}` });
      }
    }
    const out = { time: isFin(sp.time) ? sp.time : 0, key: sp.key, count: int(sp.count, 1), interval: isFin(sp.interval) ? sp.interval : 0 };
    if (sp.routeIndex !== undefined) out.routeIndex = int(sp.routeIndex, 0);
    for (const k of ['slot', 'tag', 'group', 'pack']) if (sp[k] !== undefined && sp[k] !== null) out[k] = sp[k];
    if (isFin(sp.weight)) out.weight = sp.weight;
    if (sp.unharmful === true) out.unharmful = true;
    if (sp.action) out.action = sp.action;
    if (out.slot === null) delete out.slot;
    return out;
  });
  if (errors.length) return { ok: false, errors };
  const solo = spec.solo === undefined ? /_s$/.test(ids.id) : spec.solo === true;
  const { totalCount, slotCounts } = deriveCounts(spawns);
  if (spawns.length && totalCount === 0) warnings.push('every spawn is `unharmful`, so the round has a totalCount of 0');
  const wave = {
    id: ids.id,
    kind: spec.kind ?? 'normal',
    solo,
    bossId: spec.bossId ?? null,
    maxPlayTime: isFin(spec.maxPlayTime) ? spec.maxPlayTime : null,
    dp: isPlain(spec.dp) ? { init: int(spec.dp.init, 10), perSec: isFin(spec.dp.perSec) ? spec.dp.perSec : 1, max: int(spec.dp.max, 99) } : { init: 10, perSec: 1, max: 99 },
    characterLimit: int(spec.characterLimit, 8),
    moveMultiplier: isFin(spec.moveMultiplier) ? spec.moveMultiplier : 0.5,
    bgm: spec.bgm ?? null,
    routes,
    extraRoutes: Array.isArray(spec.extraRoutes) ? spec.extraRoutes.map((r) => ({ ...r })) : [],
    spawns,
    branches: isPlain(spec.branches) ? { ...spec.branches } : {},
    overrides: isPlain(spec.overrides) ? { ...spec.overrides } : {},
    devices: Array.isArray(spec.devices) ? spec.devices.map((d) => ({ ...d })) : [],
    totalCount,
    slotCounts,
    // where this wave is bound: a mode+round (or a mode+round+boss). Empty = nothing will ever spawn it.
    usedBy: (Array.isArray(spec.usedBy) ? spec.usedBy : []).map((u) => ({ modeId: u.modeId, round: int(u.round, 0), bossId: u.bossId ?? null })),
  };
  if (!wave.usedBy.length) warnings.push('no `usedBy`: the wave is valid but no mode and round will ever spawn it.');
  return { ok: true, wave, warnings };
}

/**
 * Validate one wave record. `be`-style stale checks for the two derived counters, plus the spawn and route contracts.
 * @param {object} rec
 * @param {{ id?: string, officialIds?: Set<string>|string[], knownEnemyKeys?: Set<string>|string[], stageRows?: string[], stageTiles?: object }} [opts]
 *   `knownEnemyKeys` is what makes a wave's spawn list meaningful: a key no enemy defines spawns nothing.
 */
export function validateWave(rec, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  if (!isPlain(rec)) { err('', 'NOT_AN_OBJECT', 'record must be a JSON object'); return out; }
  const id = opts.id ?? rec.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.:]{1,64}$/.test(id)) err('id', 'BAD_ID', `"${id}" is not a usable wave id`);
  if (rec.id !== undefined && rec.id !== id) err('id', 'ID_MISMATCH', `id "${rec.id}" does not equal its map key "${id}"`);
  const official = opts.officialIds instanceof Set ? opts.officialIds : new Set(opts.officialIds || []);
  if (official.has(id)) {
    err('id', 'OFFICIAL_ID_COLLISION', `"${id}" already exists in the official data`, `replace it only on purpose: add "waves:${id}" to the pack's overrides`);
  }
  if (!WAVE_KINDS.includes(rec.kind)) err('kind', 'BAD_ENUM', `kind must be one of ${WAVE_KINDS.join(', ')}`);

  const routes = Array.isArray(rec.routes) ? rec.routes : null;
  if (!routes || !routes.length) err('routes', 'EMPTY', 'a wave needs at least one route: spawns index into it');
  else for (const issue of validateRoutes(routes, opts.stageRows, opts.stageTiles)) out.push(issue);
  if (Array.isArray(rec.extraRoutes) && rec.extraRoutes.length && !routes?.length) warn('extraRoutes', 'NO_ROUTES', 'extraRoutes without routes: routeIndex still indexes `routes`');

  const spawns = Array.isArray(rec.spawns) ? rec.spawns : null;
  if (!spawns) err('spawns', 'BAD_SPAWNS', 'spawns must be an array of { time, key, count, interval }');
  else {
    const known = opts.knownEnemyKeys ? (opts.knownEnemyKeys instanceof Set ? opts.knownEnemyKeys : new Set(opts.knownEnemyKeys)) : null;
    let prev = -Infinity;
    let unsorted = false;
    spawns.forEach((sp, i) => {
      const at = `spawns[${i}]`;
      if (!isPlain(sp)) { err(at, 'BAD_SPAWN', 'a spawn must be an object'); return; }
      if (!(isFin(sp.time) && sp.time >= 0)) err(`${at}.time`, 'BAD_NUMBER', 'time must be a number >= 0 (seconds into the round)');
      else { if (sp.time < prev) unsorted = true; prev = sp.time; }
      if (typeof sp.key !== 'string' || !sp.key) err(`${at}.key`, 'MISSING', 'key is required (an enemy key)');
      else if (known && !known.has(sp.key)) {
        err(`${at}.key`, 'UNKNOWN_ENEMY', `no enemy is defined as "${sp.key}"`, 'add it to the pack enemies.json, or fix the key');
      }
      if (!(Number.isInteger(sp.count) && sp.count >= 1)) err(`${at}.count`, 'BAD_NUMBER', 'count must be an integer >= 1');
      if (!(isFin(sp.interval) && sp.interval >= 0)) err(`${at}.interval`, 'BAD_NUMBER', 'interval must be a number >= 0 (seconds between each of `count`)');
      if (sp.slot !== undefined && sp.slot !== null && !SPAWN_SLOTS.includes(sp.slot)) {
        err(`${at}.slot`, 'BAD_ENUM', `slot must be one of ${SPAWN_SLOTS.join(', ')} or omitted`);
      }
      if (sp.routeIndex !== undefined) {
        if (!Number.isInteger(sp.routeIndex)) err(`${at}.routeIndex`, 'BAD_NUMBER', 'routeIndex must be an integer');
        else if (routes && (sp.routeIndex < 0 || sp.routeIndex >= routes.length)) {
          err(`${at}.routeIndex`, 'ROUTE_MISSING', `routeIndex ${sp.routeIndex} but the wave has ${routes.length} route(s)`,
            'the sim falls back to route 0, so enemies would walk a different path than intended');
        }
      }
      const keys = Object.keys(sp);
      for (const k of keys) if (!SPAWN_FIELDS.includes(k)) warn(`${at}.${k}`, 'UNKNOWN_FIELD', `"${k}" is not a spawn field the engine reads`);
      if (sp.unharmful === true && sp.slot) warn(`${at}`, 'UNHARMFUL_SLOTTED', 'an unharmful spawn still counts into slotCounts but not into totalCount (that is how the official data does it)');
    });
    if (unsorted) warn('spawns', 'UNSORTED', 'spawns are not in time order (the engine sorts by time itself, but the file is easier to read sorted)');
    // the derived counters must match the spawns
    const want = deriveCounts(spawns.map((sp) => (isPlain(sp) ? { ...sp, count: int(sp.count, 0) } : sp)));
    if (rec.totalCount !== undefined && rec.totalCount !== want.totalCount) {
      err('totalCount', 'STALE_DERIVED', `totalCount is ${rec.totalCount} but the spawns give ${want.totalCount}`, 're-derive it');
    }
    if (rec.slotCounts !== undefined && JSON.stringify(rec.slotCounts) !== JSON.stringify(want.slotCounts)) {
      err('slotCounts', 'STALE_DERIVED', `slotCounts is ${JSON.stringify(rec.slotCounts)} but the spawns give ${JSON.stringify(want.slotCounts)}`, 're-derive it');
    }
    if (rec.totalCount === undefined) err('totalCount', 'MISSING_DERIVED', 'totalCount is missing: it is derived, not authored');
    if (rec.slotCounts === undefined) err('slotCounts', 'MISSING_DERIVED', 'slotCounts is missing: it is derived, not authored');
  }
  const usedBy = Array.isArray(rec.usedBy) ? rec.usedBy : null;
  if (!usedBy) err('usedBy', 'MISSING', 'usedBy must be an array (empty is allowed, but then nothing spawns this wave)');
  else if (!usedBy.length) warn('usedBy', 'UNUSED', 'no mode and round spawns this wave, so it will never appear in a match');
  else usedBy.forEach((u, i) => {
    if (!isPlain(u) || typeof u.modeId !== 'string' || !u.modeId) err(`usedBy[${i}]`, 'BAD_ENTRY', 'usedBy entries need a modeId');
    else if (Number.isInteger(u.round) && (u.round < 1 || u.round > ROUNDS_PER_MODE)) {
      err(`usedBy[${i}].round`, 'BAD_ROUND', `round ${u.round} is outside 1..${ROUNDS_PER_MODE}`);
    } else if (!Number.isInteger(u.round)) err(`usedBy[${i}].round`, 'BAD_ROUND', 'round must be an integer');
  });
  return out;
}

/** The errors of a validation result. */
export const waveErrors = (issues) => (Array.isArray(issues) ? issues.filter((i) => i.severity === 'error') : []);

/** A one-line readout for the editor / CLI. */
export const waveSummaryLine = (rec) => {
  const spawns = Array.isArray(rec && rec.spawns) ? rec.spawns : [];
  const first = spawns.length ? Math.min(...spawns.map((s) => (isFin(s.time) ? s.time : 0))) : 0;
  const last = spawns.length ? Math.max(...spawns.map((s) => (isFin(s.time) ? s.time : 0) + Math.max(0, (s.count || 1) - 1) * (s.interval || 0))) : 0;
  return `${spawns.length} spawn(s) · ${rec?.totalCount ?? 0} enemies · ${first}s..${Math.round(last)}s · slots ${JSON.stringify(rec?.slotCounts ?? {})}`;
};
