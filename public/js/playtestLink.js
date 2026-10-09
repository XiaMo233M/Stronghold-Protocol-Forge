// The client's deep-link actions, as plain functions with their dependencies passed in.
//
// `?room=CODE` and `?playtest=1[&difficulty=KEY]` are both remembered at boot and run once the player has entered
// and the session is online (main.js drives the timing). They live here instead of in main.js for one reason: main.js
// boots the whole client on import (a socket, Preact, the DOM), so nothing in it can be unit-tested in Node — and
// "create the room, then start the match" is exactly the sequence that must not regress.
//
// The parser itself (parsePlaytestParam) sits beside parseRoomParam in screens/lobby.js, where the difficulty
// fallback the lobby already uses is defined.

import { parseRoomParam, parsePlaytestParam, DEFAULT_DIFFICULTY } from './screens/lobby.js';
import { DIFFICULTIES } from '../../shared/constants.js';
import { t } from '../../shared/i18n.js';

/** Query parameters a deep link owns; all of them are stripped once the action has been consumed. */
export const DEEP_LINK_PARAMS = ['room', 'playtest', 'difficulty'];

/**
 * The deep links one page load carries: what boot writes into the store (`ui.pendingJoin`, `ui.pendingPlaytest`).
 * With no query string both are null and the client boots exactly as it did before the playtest link existed.
 * @param {string} search e.g. location.search
 * @returns {{ pendingJoin: string|null, pendingPlaytest: { mode: 'solo', difficulty: string }|null }}
 */
export function deepLinkSeeds(search) {
  return { pendingJoin: parseRoomParam(search), pendingPlaytest: parsePlaytestParam(search) };
}

/**
 * Strip the deep-link parameters from a URL (the live call passes `location` and `history`). A deep link is
 * consumed exactly once, so a reload — or the link still sitting in the address bar — can never join the room or
 * start the match a second time. Never throws: a malformed href or a refusing history is not worth a boot failure.
 * @param {{ href?: string, search?: string }} loc
 * @param {{ state?: any, replaceState: Function }} hist
 * @returns {boolean} whether the URL was rewritten
 */
export function stripDeepLinkParams(loc, hist) {
  try {
    const href = loc.href || `http://localhost/${loc.search || ''}`;
    const url = new URL(href);
    let changed = false;
    for (const key of DEEP_LINK_PARAMS) {
      if (!url.searchParams.has(key)) continue;
      url.searchParams.delete(key);
      changed = true;
    }
    if (changed) hist.replaceState(hist.state ?? null, '', url.pathname + (url.search || '') + url.hash);
    return changed;
  } catch {
    return false;
  }
}

/** True while a solo quick start is running: the timer, the entry subscription and the welcome all re-schedule. */
let inFlight = false;

/**
 * Run a solo quick start, once: `room.create { mode: 'solo', difficulty }` and then `room.start`. Injected (net /
 * store / notify), so the sequence is testable as a plain unit.
 *
 * A solo room holds exactly one human and no AI, so `room.start` passes the readiness rule in server/lobby.js
 * start() — only the OTHER humans must be connected and ready — with nobody having to press 准备.
 *
 * Quiet and non-destructive on failure: every refusal is only reported, and the player stays in the lobby.
 * @param {{ request: (t: string, fields?: object) => Promise<any> }} netLike
 * @param {{ get: () => any }} storeLike
 * @param {{ difficulty?: string, roomFields?: () => object,
 *           notify?: (text: string, kind?: string) => void,
 *           notifyError?: (err: any) => void }} [opts]
 * @returns {Promise<boolean>} true when the match was started
 */
export async function runSoloPlaytest(netLike, storeLike, opts = {}) {
  const s = typeof storeLike?.get === 'function' ? storeLike.get() : null;
  const difficulty = DIFFICULTIES.includes(opts.difficulty) ? opts.difficulty : DEFAULT_DIFFICULTY;
  const notify = typeof opts.notify === 'function' ? opts.notify : () => {};
  // Extra `room.create` fields the caller owns (main.js passes the mod digest this server declared): absent ⇒ `{}`, so
  // a plain install sends exactly `{ mode, difficulty }` and this module keeps no opinion about mods (roomMods.js).
  const roomFields = typeof opts.roomFields === 'function' ? opts.roomFields() : null;
  if (inFlight) {
    notify(t('试玩正在启动，请稍候'), 'warn');
    return false;
  }
  // Already sat down (a restored session, or a room opened while the grace timer ran): create nothing.
  if (s && (s.room || s.match?.public)) {
    notify(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
    return false;
  }
  if (!s || !s.session?.entered || netLike.status !== 'online') {
    notify(t('尚未连接到服务器，请稍候'), 'warn');
    return false;
  }
  inFlight = true;
  try {
    // The two intents are independent server-side (the rate limiter counts room.create / room.start per socket —
    // server/lobby.js header), and the server handles them in arrival order: create first, then start.
    await netLike.request('room.create', { mode: 'solo', difficulty, ...(roomFields || {}) });
    await netLike.request('room.start');
    return true;
  } catch (err) {
    // The refusal text is the toast layer's job (ui/toasts.js describeError) — it is not part of this module.
    if (typeof opts.notifyError === 'function') opts.notifyError(err);
    else notify(String(err?.message || err || t('发生未知错误')), 'error');
    return false;
  } finally {
    inFlight = false;
  }
}
