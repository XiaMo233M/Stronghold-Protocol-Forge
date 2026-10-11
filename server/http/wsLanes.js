// server/http/wsLanes.js — the upgrade-path table a server answers with (DESIGN §28.44).
//
// Why this exists: the server used to know exactly one WebSocket path. `/ws` and nothing else (server/http/
// websocket.js refused every other upgrade with 404), because one game meant one protocol. A second, self-contained
// game mode does not speak that protocol — it brings its own message shapes, its own rooms and often its own
// process — and there was no place to say so. Editing the pinned `!== '/ws'` comparison per host would give every
// fork its own copy of the rule, so the rule moves here: a table of paths, decided from data.
//
// Two halves, deliberately split:
//   * the pure half (`isLanePath`, `validateLanes`, `resolveLane`) takes data and returns data — it is the part a
//     test can pin without a socket, and the part that decides whether a configuration is legal at all;
//   * the imperative half lives in websocket.js, which keeps its single 'upgrade' listener and asks this table
//     where a request belongs. One listener means the order of admission and rejection stays in one place.
//
// What this is NOT: it is not a way for a content pack to open a port or run its own server. Packs still get no
// network, no timers and no child processes (shared/kitAuthoring.js). A lane is registered by the host process,
// from code the operator installed — see DESIGN §28.44 for that boundary and §28.13.1 for why the dispatch hook
// stays unable to change a battle.

/** Longest lane path accepted (a path is a route, not a payload). */
export const LANE_PATH_MAX = 128;
/** How many lanes one server may serve. Beyond this the table is a routing maze, not a seam. */
export const MAX_WS_LANES = 8;
/** Paths a lane may never claim: `/ws` is the game's own endpoint and the client's reconnect logic names it. */
export const LANE_RESERVED = Object.freeze(['/ws']);

/**
 * A lane path: rooted at `/`, plain characters only, no query, no fragment, no dot segments, no trailing slash.
 * Exact-match semantics (a lane answers its path, never a subtree) keep `/duel` from silently shadowing `/duelx`.
 * @param {unknown} p
 * @returns {boolean}
 */
export function isLanePath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length < 2 || p.length > LANE_PATH_MAX) return false;
  if (p.endsWith('/') || p.includes('//') || p.includes('?') || p.includes('#') || p.includes(' ')) return false;
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/.test(p)) return false;
  return p.split('/').every((s) => s !== '.' && s !== '..');
}

/**
 * Decide a lane table before the server boots. Bad configuration fails here, at start, never mid-request.
 * @param {readonly WsLane[]} lanes raw table (may be empty or undefined at the call site)
 * @returns {{ lanes: readonly WsLane[], problems: string[] }} `lanes` is frozen and sorted when `problems` is empty
 */
export function validateLanes(lanes) {
  const list = Array.isArray(lanes) ? lanes : [];
  const problems = [];
  if (list.length > MAX_WS_LANES) problems.push(`LANE_LIMIT: ${list.length} lanes, at most ${MAX_WS_LANES}`);
  const seen = new Map();
  for (const [i, lane] of list.entries()) {
    const name = lane && typeof lane.id === 'string' && lane.id ? lane.id : `lane #${i}`;
    const path = lane ? lane.path : undefined;
    if (!isLanePath(path)) problems.push(`LANE_BAD_PATH: ${name} path ${JSON.stringify(path)} is not a rooted, plain, exact path`);
    else if (LANE_RESERVED.includes(path)) problems.push(`LANE_RESERVED: ${name} claims ${path}, which the game already serves`);
    if (typeof (lane && lane.onUpgrade) !== 'function') problems.push(`LANE_NO_HANDLER: ${name} has no onUpgrade(req, socket, head, ctx)`);
    if (typeof path === 'string') {
      if (seen.has(path)) problems.push(`LANE_DUPLICATE: ${name} and ${seen.get(path)} both claim ${path}`);
      else seen.set(path, name);
    }
  }
  if (problems.length) return { lanes: [], problems };
  return { lanes: Object.freeze([...list].sort((a, b) => (a.path < b.path ? -1 : 1))), problems };
}

/**
 * Which lane answers this exact path — the only routing decision the upgrade path makes.
 * @param {string} rawPath path portion of the request URL (splitUrl's `rawPath`)
 * @param {readonly WsLane[]} lanes a table that already passed validateLanes
 * @returns {WsLane | null}
 */
export function resolveLane(rawPath, lanes) {
  for (const lane of lanes) if (lane.path === rawPath) return lane;
  return null;
}

/**
 * One row of the table: a path the host process serves with something other than the game's own protocol.
 * @typedef {object} WsLane
 * @property {string} id names this lane in the boot log and in every refusal (a lane is not anonymous)
 * @property {string} path the exact upgrade path it answers, e.g. `/duel/lobby`
 * @property {(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex,
 *   head: Buffer, ctx: { reject: (status: number, text: string) => void, log: object, lane: WsLane }) => void} onUpgrade
 *   takes over the socket: complete the 101 yourself or `ctx.reject(...)`. Throwing closes the socket and is logged
 *   by name — it never falls through to `/ws`, because a client must not be able to steer itself into the game.
 * @property {string} [summary] what runs behind this lane, for the boot log
 */
