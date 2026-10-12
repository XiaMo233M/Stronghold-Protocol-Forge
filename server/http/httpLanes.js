// server/http/httpLanes.js — the request-path table a host registers next to the game's own HTTP space (DESIGN §28.45).
//
// Why this exists: `server/http/routes.js` answered two things and nothing else — `/healthz`, the mods catalogue — and
// handed every other GET/HEAD to the static files, while any other method was a flat 405. A self-contained game mode
// does not fit that shape: it needs a page of its own under a namespace, its own assets, and often a POST endpoint
// (a report, a webhook). There was no place to say so, so every fork that wanted a mode edited the same four lines of
// the request listener — and owned the conflict forever.
//
// Same split as the upgrade table (§28.44), same reason: the *decision* is pure data and testable without a socket;
// the *wiring* stays in routes.js, so exactly one listener still owns the order of parse → engine paths → lane →
// 405 → static.
//
// The two rules that make a prefix table safe:
//   * a lane never overlaps what the engine already owns — neither its URL space (`/packs/`, `/media/`, the
//     `/workshop-*` family, `/room-data/`, `/mods/…`, `/healthz`, `/ws`) nor a real folder inside `publicDir`
//     (registering `/assets/` would silently steal art the client loads from disk);
//   * a lane is matched **before** the method gate but **after** the engine's own exact paths, so the engine cannot be
//     shadowed and a POST intended for a lane is not swallowed by the 405.
//
// What this is NOT: not a pack surface. A pack's declared `routes` stay `.json`-only (§28.13) and packs still get no
// network, no timers and no child processes (shared/kitAuthoring.js). A lane is code the operator installed.

import { MODS_CATALOG_URL, MOD_FILE_PREFIX } from './mods.js';
import { ROOM_DATA_PREFIX, WORKSHOP_BATTLE_PREFIX } from './static.js';
import { RESERVED_ROUTE_PREFIXES, DYNAMIC_ROUTE_PREFIX } from './routeMount.js';
import { PACKS_URL } from '../../shared/packs.js';
import { MEDIA_PREFIX } from '../../shared/media.js';
import { WORKSHOP_MEDIA_PREFIX, WORKSHOP_PANEL_PREFIX, WORKSHOP_RESOURCE_PREFIX } from '../../shared/workshop.js';

/** How many request lanes one server registers. */
export const MAX_HTTP_LANES = 8;
/** Methods a lane may claim. Anything else stays the engine's flat 405, as it has always been. */
export const LANE_METHODS = Object.freeze(['GET', 'HEAD', 'POST']);

/**
 * What the engine already owns, so a collision is a boot error instead of a silent steal.
 *
 * Two sources, both **imported** on purpose — a hand-copied list drifts the moment either side adds a mount:
 *   * `RESERVED_ROUTE_PREFIXES` / `DYNAMIC_ROUTE_PREFIX` (server/http/routeMount.js) — the engine's own top-level
 *     namespaces, which that file already keeps as one reusable truth (it needs the same set to refuse a pack's
 *     `host.route()` claims, DESIGN §28.35). `/mod/` lives there, and a lane stealing the pack route namespace would
 *     be the nastiest kind of steal: invisible until a pack's endpoint 404s.
 *   * the constants the handlers actually serve — `/mods/catalog.json` and `/mods/file/` (mods.js), `/packs/`
 *     (shared/packs.js), `/media/` (shared/media.js), `/room-data/` and the `/workshop-*` family (static.js,
 *     shared/workshop.js).
 * The literals the static handler holds without exporting a name: `/` is the SPA fallback and the public tree itself
 * (server/http/static.js:4, `index.html` for directories at `:518`), `/data/<file>.json` is served MERGED when a pack
 * touches that file (`:291`), and `/workshop-kits/` is the kit route (`:351`). `/assets/`, `/fonts/` and `/sim/` are
 * not literals here — they come from the mount table (`coreMounts`, server/http/routeMount.js).
 * `/ws` is not a request path at all, but a client that names it must never be handed here.
 */
export const ENGINE_HTTP_RESERVED = Object.freeze([...new Set([
  '/', ...RESERVED_ROUTE_PREFIXES, DYNAMIC_ROUTE_PREFIX,
  MODS_CATALOG_URL, MOD_FILE_PREFIX, PACKS_URL, MEDIA_PREFIX, ROOM_DATA_PREFIX,
  WORKSHOP_MEDIA_PREFIX, WORKSHOP_PANEL_PREFIX, WORKSHOP_RESOURCE_PREFIX, WORKSHOP_BATTLE_PREFIX,
  '/workshop-kits/', '/data/', '/sim/', '/assets/', '/fonts/',
])]);

/**
 * A lane prefix: rooted, ends with `/` (it owns a subtree — that is the whole point of this cell), plain characters,
 * no dot segments, at most 64.
 * @param {unknown} p
 * @returns {boolean}
 */
export function isLanePrefix(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || !p.endsWith('/') || p.length < 3 || p.length > 64) return false;
  if (p.includes('//')) return false;
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*\/$/.test(p)) return false;
  return p.split('/').every((s) => s !== '.' && s !== '..');
}

/**
 * Does this prefix sit on, inside, or around something the engine already owns? `/` is the exception that proves the
 * rule: every path starts with it, so the public root collides only when a lane claims the root itself.
 */
const claimsReserved = (prefix) => ENGINE_HTTP_RESERVED.some(
  (r) => prefix === r || (r !== '/' && (prefix.startsWith(r) || r.startsWith(prefix))),
);

/**
 * Decide a request-lane table before the server boots. Bad configuration fails here, named — the same rule the
 * upgrade table follows (§28.44) and for the same reason: a lane that quietly never answers is worse than no boot.
 * @param {readonly HttpLane[]} lanes raw table
 * @param {{ publicDir?: string, existsSync?: (p: string) => boolean }} [fs] injectable so the pure layer is testable
 * @returns {{ lanes: readonly HttpLane[], problems: string[] }}
 */
export function validateHttpLanes(lanes, { publicDir = null, existsSync = null } = {}) {
  const list = Array.isArray(lanes) ? lanes : [];
  const problems = [];
  if (list.length > MAX_HTTP_LANES) problems.push(`LANE_LIMIT: ${list.length} lanes, at most ${MAX_HTTP_LANES}`);
  const seen = new Map();
  const root = typeof publicDir === 'string' ? publicDir.replace(/\/+$/, '') : '';
  for (const [i, lane] of list.entries()) {
    const name = lane && typeof lane.id === 'string' && lane.id ? lane.id : `lane #${i}`;
    const prefix = lane ? lane.prefix : undefined;
    if (!isLanePrefix(prefix)) problems.push(`LANE_BAD_PREFIX: ${name} prefix ${JSON.stringify(prefix)} is not a rooted subtree like /duel/`);
    else if (claimsReserved(prefix)) problems.push(`LANE_RESERVED: ${name} claims ${prefix}, which the engine already serves`);
    else if (root && prefix && typeof existsSync === 'function' && existsSync(root + prefix.replace(/\/+$/, ''))) {
      problems.push(`LANE_SHADOWS_PUBLIC: ${name} claims ${prefix}, but ${root}${prefix.replace(/\/+$/, '')} is a real folder the static handler serves`);
    }
    const methods = lane ? lane.methods : null;
    if (!Array.isArray(methods) || !methods.length) problems.push(`LANE_NO_METHODS: ${name} declares no methods`);
    else if (methods.some((m) => !LANE_METHODS.includes(m))) problems.push(`LANE_BAD_METHOD: ${name} claims ${JSON.stringify(methods.filter((m) => !LANE_METHODS.includes(m)))}, only ${LANE_METHODS.join('/')} exist`);
    if (typeof (lane && lane.onRequest) !== 'function') problems.push(`LANE_NO_HANDLER: ${name} has no onRequest(req, res, ctx)`);
    if (typeof prefix === 'string') {
      if (seen.has(prefix)) problems.push(`LANE_DUPLICATE: ${name} and ${seen.get(prefix)} both claim ${prefix}`);
      else seen.set(prefix, name);
    }
  }
  if (problems.length) return { lanes: [], problems };
  return { lanes: Object.freeze([...list].sort((a, b) => (a.prefix < b.prefix ? -1 : 1))), problems };
}

/**
 * Which lane answers this request — longest prefix wins, and only for a method that lane claimed.
 * @param {string} method `req.method`
 * @param {string} rawPath path portion of the URL
 * @param {readonly HttpLane[]} lanes a table that already passed validateHttpLanes
 * @returns {HttpLane | null}
 */
export function resolveHttpLane(method, rawPath, lanes) {
  if (!rawPath.startsWith('/')) return null;
  let best = null;
  for (const lane of lanes) {
    if (!lane.methods.includes(method)) continue;
    if (rawPath.startsWith(lane.prefix) && (!best || lane.prefix.length > best.prefix.length)) best = lane;
  }
  return best;
}

/**
 * One row of the request table.
 * @typedef {object} HttpLane
 * @property {string} id names this lane in the boot log and in every refusal
 * @property {string} prefix the subtree it owns, e.g. `/duel/`
 * @property {readonly string[]} methods subset of `LANE_METHODS`
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *   ctx: { rawPath: string, query: string, log: object, lane: HttpLane }) => void | Promise<void>} onRequest
 *   owns the response from here, including reading any body. Throwing is caught by the listener and answers a named
 *   500 — the request never falls through into the game's static space.
 * @property {string} [summary] what runs behind this lane, for the boot log
 */
