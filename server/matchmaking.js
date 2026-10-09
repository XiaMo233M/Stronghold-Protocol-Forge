// server/matchmaking.js — 野排匹配 (quick match): a queue of strangers that becomes an ordinary room.
//
// A PRODUCT feature of the engine (the owner's ruling of 2026-10: 房间保留 and 野排 are product features unrelated to
// the mod layer — the reference community pack hand-patched server/lobby.js +687/-14 for them, and that is where they
// must NOT live). This module therefore has no pack-facing surface at all: no `pack.json` field, no C-layer host, no
// channel, no `welcome` field, nothing a pack can declare or read. A quick-matched room runs the server's DEFAULT set
// (a pack never chooses the content of a room it did not create); a room that already declared a set keeps it
// (server/lobby.js, W-B).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE RULES (all of them testable, test/quickmatch.test.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   * `room.queue` enters, `room.dequeue` leaves. A player in a room is refused with QUEUED (a quick match places
//     people INTO rooms — it never pulls them out of one). Queueing twice from the same live session is idempotent
//     (it re-answers `ok`); two sockets of one identity are the same player and cannot take two slots.
//
//   * THE PLACEMENT RULE. When the number of WAITING players reaches `queue.size` (default 4 = MAX_SEATS), the engine
//     takes the `queue.size` longest-waiting of them — strict arrival order, the order of accepted `room.queue`
//     messages — and seats them through the ordinary lobby flow (`lobby.create` for the first, `lobby.join` for the
//     rest), i.e. into the lowest free seat index in that same order. Nothing here re-implements seats, host, mods or
//     the match wiring: the room it produces is exactly the room `room.create` + 3 × `room.join` would have produced.
//     "Waiting" means queued AND connected: a player who dropped does not count towards the threshold and is not
//     placed (they are skipped, the next in line takes the slot).
//
//   * The wait is BOUNDED: `queue.waitMs` (default 120 s — the official `matchTimeMax`, research 06 §3.3) after a
//     player entered, they leave the queue and are told `room.queued { status:'timeout' }`. A queue nobody can fill
//     therefore cannot park sockets forever.
//
//   * NAMED ANSWERS. The queue already holds `queue.max` waiting players ⇒ QUEUE_FULL. `room.dequeue` from someone who
//     is not queued ⇒ QUEUE_EMPTY. The queue empties (everyone cancelled / dropped) ⇒ the engine does nothing special,
//     it simply waits for the next arrival: there is no room, and the players who left were answered when they left.
//
//   * A connection drop does not decide anything by itself: the player stays in the queue (they may resume with their
//     token) but stops counting as waiting, and the bounded wait still applies to the slot they kept. Leaving on
//     purpose (`room.leave`, `g.leave`, the reconnect window expiring, `room.dequeue`) removes the entry at once.
//
//   * Nothing runs when the queue is empty: the sweep timer is armed on the first entry and cleared with the last, so
//     a server whose players never press the button has one Map and no timer.
//
//   * ORTHOGONALITY. `Room`/`Lobby` learn nothing new about content: a quick-matched room is created with
//     `modIds: []` (= the server's default set) and the queue never carries a room's declared `modIds`. The queue's
//     own memory is the players waiting, their declared mode/difficulty/mods digest, and when they arrived.
//
// [ASSUMED] (no source settles them; docs/META.md §1.6 names each one):
//   * the queue size = MAX_SEATS (4) and the wait = the official `matchTimeMax` (120 s);
//   * a quick-matched room is NOT retained for a second match more eagerly than any other room (it is an ordinary
//     room: server/lobby.js keeps it while a human remains, and reclaims it when the last one leaves);
//   * a room that is only partly filled is never started by the engine, not even with AI seats: the threshold is the
//     queue size, and "start with whoever is here" is an owner decision (reported, not implemented).

import { DIFFICULTIES, MAX_SEATS, ERR } from '../shared/constants.js';
import { sendSession } from './net.js';

const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const OK = Object.freeze({ ok: true });

/** Tunables of the quick-match queue (Lobby options override the ones it forwards). */
export const MATCHMAKE_DEFAULTS = Object.freeze({
  /** Waiting players that form a room (`null` = the room's own MAX_SEATS). */
  size: null,
  /** Cap on waiting players (`null` = the queue size): above it `room.queue` is refused with QUEUE_FULL. */
  max: null,
  /** How long one player may wait (ms): the official `matchTimeMax`, research 06 §3.3. */
  waitMs: 120_000,
  /** Sweep interval (ms): expiry + a placement retry the arrival of a player could not do. */
  sweepMs: 5_000,
  /** Difficulty of a quick-matched room when the queueing player named none. */
  difficulty: 'NORMAL',
});

/** The one mode a queue of strangers can form (a solo room holds exactly one human and never bots). */
const QUEUE_MODE = 'coop';

/**
 * The quick-match queue of one Lobby. Built by the Lobby (`lobby.matchmake`); every method takes the lobby as its
 * subject because the queue deliberately owns NO room lifecycle of its own — it asks the lobby to create and join.
 *
 * @typedef {{ playerId: string, session: any, at: number, connected: boolean, mode: string, difficulty: string,
 *             mods?: string, member?: boolean, placed?: boolean }} QueueEntry
 */
export class MatchmakeQueue {
  /**
   * @param {object} lobby the Lobby (server/lobby.js) — duck-typed, never imported back (no cycle): `registry`,
   *   `log`, `now()`, `roomOf(session)`, `create(session, msg)`, `join(session, msg)`, `rooms`, `opts`
   * @param {Partial<typeof MATCHMAKE_DEFAULTS>} [options]
   */
  constructor(lobby, options = {}) {
    this.lobby = lobby;
    this.opts = { ...MATCHMAKE_DEFAULTS, ...(options || {}) };
    const size = Number.isInteger(this.opts.size) && this.opts.size > 1 ? Math.min(this.opts.size, MAX_SEATS) : MAX_SEATS;
    // `max` is a CAP, not a minimum: an explicit value below `size` is honoured (the queue then refuses a new arrival
    // instead of placing anybody, which is the state the cap exists for). The default is the queue size itself —
    // anything larger would make QUEUE_FULL unreachable and let a stuck queue grow without a bound.
    const cap = Number.isInteger(this.opts.max) && this.opts.max > 0 ? this.opts.max : size;
    this.size = size;
    this.max = cap;
    this.waitMs = Number.isFinite(this.opts.waitMs) && this.opts.waitMs > 0 ? this.opts.waitMs : MATCHMAKE_DEFAULTS.waitMs;
    this.sweepMs = Number.isFinite(this.opts.sweepMs) && this.opts.sweepMs > 0 ? this.opts.sweepMs : MATCHMAKE_DEFAULTS.sweepMs;
    /** @type {Map<string, QueueEntry>} waiting players, in arrival order (a Map keeps insertion order) */
    this.entries = new Map();
    /** @type {NodeJS.Timeout | null} armed while the queue is not empty */
    this.timer = null;
    /** Diagnostics only (tests read them): how many rooms this queue formed, and the last refusal detail. */
    this.formed = 0;
    this.lastError = null;
  }

  // -------------------------------------------------------------------------------------------------
  // the two client messages
  // -------------------------------------------------------------------------------------------------

  /**
   * `room.queue` (server/lobby.js onMessage). Enters the queue, or re-answers a player who is already in it.
   * @param {import('./net.js').Session} session
   * @param {{ mode?: string, difficulty?: string, mods?: string }} [msg]
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  join(session, msg = {}) {
    const playerId = session.playerId;
    const queued = this.entries.get(playerId);
    if (queued) {
      // One player, one slot: a repeated `room.queue` re-answers the same way instead of taking a second place.
      this.send(queued);
      return OK;
    }
    if (this.lobby.roomOf(session)) return fail(ERR.QUEUED, 'leave your room first');
    // `roomOf` only answers for a room that still EXISTS and whose seat is this session's. A player whose room was
    // disposed from under them (the host left, everyone left) may still carry its code, and a player whose MATCH is
    // running carries one too — a queue must never hand either to `lobby.create`/`lobby.join`, which would move them
    // out of the room or the match they are in.
    if (this.roomOfSession(session)) return fail(ERR.QUEUED, 'leave your running match first');
    if (!session.connected) return fail(ERR.QUEUED, 'not connected');
    if (msg.mode != null && msg.mode !== QUEUE_MODE) return fail(ERR.BAD_MSG, 'a quick match forms a co-op room');
    if (this.waiting().length >= this.max) return fail(ERR.QUEUE_FULL, `the queue holds ${this.max} waiting players`);
    const entry = {
      playerId,
      session,
      at: this.lobby.now(),
      connected: true,
      mode: QUEUE_MODE,
      difficulty: DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : this.opts.difficulty,
      mods: typeof msg.mods === 'string' ? msg.mods : undefined,
    };
    this.entries.set(playerId, entry);
    this.arm();
    this.lobby.log.info(`[matchmake] ${session.name || playerId} queued (${this.entries.size} in the queue)`);
    this.publish();
    this.tryPlace();
    return OK;
  }

  /**
   * `room.dequeue` — the cancel path. The player is out of the queue and is told (`status:'cancelled'`).
   * @param {import('./net.js').Session} session
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  leave(session) {
    const entry = this.entries.get(session.playerId);
    if (!entry) return fail(ERR.QUEUE_EMPTY, 'not in the quick-match queue');
    this.drop(session.playerId);
    if (entry.connected) this.send(entry, { status: 'cancelled' });
    return OK;
  }

  // -------------------------------------------------------------------------------------------------
  // placement
  // -------------------------------------------------------------------------------------------------

  /**
   * The placement rule: the `size` longest-waiting CONNECTED players become one ordinary room. Does nothing while
   * fewer than `size` wait. Returns whether a room was formed (tests read it; the sweeper ignores it).
   * @returns {boolean}
   */
  tryPlace() {
    const order = this.waiting();
    if (order.length < this.size) return false;
    const picked = order.slice(0, this.size);
    for (const e of picked) e.member = true;   // reserved: nothing may form a second room out of these
    let room = null;
    let failure = null;
    try {
      // The room itself is the ordinary one `room.create` builds (host = the longest-waiting player, seat 0) and every
      // later player takes the lowest free seat through the ordinary `room.join` — this module owns no seat logic.
      // A quick-matched room runs the server's DEFAULT set: no `modIds`, and `mods` was already judged when the player
      // entered the queue (`room.queue.mods`). W-B stays in the lobby.
      const res = this.lobby.create(picked[0].session, { mode: QUEUE_MODE, difficulty: picked[0].difficulty });
      if (!res || !res.ok) failure = res;
      else {
        room = this.lobby.rooms.get(picked[0].session.roomCode) || null;
        if (!room) failure = fail(ERR.INTERNAL, 'the quick-matched room vanished');
        else {
          picked[0].placed = true;
          for (const e of picked.slice(1)) {
            if (room.freeSeat() < 0) { failure = fail(ERR.ROOM_FULL, 'the quick-matched room lost its free seats'); break; }
            const joined = this.lobby.join(e.session, { code: room.code });
            if (joined && joined.ok) { e.placed = true; continue; }
            // Refused (they entered a room or a match between the sweep and this loop): they are out of the queue, and
            // the door is closed — the queue never retries a player the lobby already refused, because it cannot tell
            // "they left" from "they are busy". The rest keep their turn.
            this.lobby.log.warn(`[matchmake] ${e.session.name || e.playerId} could not join ${room.code}: ${joined && joined.error}`);
            this.drop(e.playerId);
          }
        }
      }
    } catch (e) {
      this.lobby.log.error('[matchmake] forming a room threw', e);
      failure = fail(ERR.INTERNAL, 'quick match failed to form a room');
    }
    const placed = picked.filter((e) => e.placed);
    if (!placed.length && failure) {
      // Nobody got in: the room was never built (or the host could not be created). Whoever is still queued keeps the
      // wait and the next sweep tries again — a queue that cannot form a room is not a reason to drop its players.
      if (room) this.lobby.log.warn(`[matchmake] ${room.code} was not filled (${failure.error})`);
      return this.sync(picked, failure);
    }
    if (room && placed.length < this.size) {
      // The room holds whoever got in; it is an ordinary room from here on (its host may add AI seats or invite).
      // A partly filled quick match is not torn down: the room exists, and it is exactly what the lobby built.
      this.lobby.log.warn(`[matchmake] ${room.code} formed with ${placed.length}/${this.size} players`);
    }
    for (const e of picked) {
      // tells a placed player where it went (the room's own room.state follows), and takes the rest out of the wait —
      // a player the lobby refused is already out (drop above), and `drop` is idempotent
      if (e.placed && room) this.send(e, { status: 'placed', code: room.code }, true);
      this.drop(e.playerId);
    }
    this.formed++;
    this.lobby.log.info(`[matchmake] ${room ? `${room.code} formed from ` : ''}${placed.length} queued player(s)`);
    this.lastError = failure ? failure.error : null;
    return placed.length > 0;
  }

  /** Release the reservation after a partly failed placement: the reserved entries stay queued for the next sweep. */
  sync(picked, res) {
    for (const e of picked) if (this.entries.get(e.playerId) === e) e.member = false;
    const detail = res && res.error ? res.error : ERR.INTERNAL;
    this.lastError = detail;
    this.lobby.log.warn(`[matchmake] could not form a room (${detail})`);
    this.publish();
    return false;
  }

  // -------------------------------------------------------------------------------------------------
  // the queue's own bookkeeping
  // -------------------------------------------------------------------------------------------------

  /**
   * The room a queued player's session still points at, or null. The lobby disposes a room when its last human leaves
   * but does NOT rewrite every session's `roomCode` (only the members it can find), so a queued player can be left
   * holding the code of a room that no longer exists — treated exactly like no room at all, or that stale string would
   * keep them out of the queue forever.
   * @param {any} session @returns {any | null}
   */
  roomOfSession(session) {
    if (!session || session.roomCode == null) return null;
    return this.lobby.rooms.get(session.roomCode) || null;
  }

  /** **Waiting** entries in arrival order: connected, not reserved, and with no room (and no match) by now. */
  /** @returns {QueueEntry[]} */
  waiting() {
    const out = [];
    for (const e of this.entries.values()) {
      if (!e.connected || e.member) continue;
      if (this.roomOfSession(e.session) || this.lobby.roomOf(e.session)) continue;
      out.push(e);
    }
    return out;
  }

  /** @param {string} playerId */
  drop(playerId) {
    this.entries.delete(playerId);
    if (this.entries.size === 0) this.disarm();
  }

  /**
   * A queued player's socket is gone: the entry is KEPT (they may resume with their token and be placed then) but it
   * stops counting as waiting. The bounded wait still applies to it, so a slot can never be parked forever — the sweep
   * expires it like any other.
   */
  onDisconnect(session) {
    const entry = this.entries.get(session.playerId);
    if (!entry) return;
    entry.connected = false;
    this.lobby.log.info(`[matchmake] ${session.name || session.playerId} dropped while queued (${this.waiting().length} waiting)`);
    if (this.tryPlace()) return;
    this.publish();
  }

  /** The session came back (a resume / a repeated hello): its queue slot is waiting again. */
  onHello(session) {
    const entry = this.entries.get(session.playerId);
    if (!entry) return;
    if (this.lobby.roomOf(session) || session.roomCode) { this.drop(session.playerId); return; }
    const was = entry.connected;
    entry.connected = true;
    entry.session = session;
    if (!was) {
      this.armOneShot(this.sweepMs);
      this.publish();
      this.tryPlace();
    }
  }

  /** The reconnect window elapsed: the player is gone for good. */
  onExpire(playerId) { this.drop(playerId); }

  /** Server shutdown: forget every entry and stop the timer. */
  shutdown() {
    this.disarm();
    this.entries.clear();
  }

  /**
   * One sweep: expire what waited too long, then retry the placement. The timer is armed only while the queue is not
   * empty (a server nobody queues on has one empty Map and no timer at all).
   */
  sweep() {
    const now = this.lobby.now();
    for (const e of [...this.entries.values()]) {
      // an entry whose session is holding the code of a room that no longer exists is dead weight: the lobby disposed
      // that room without being able to tell this session, and the entry can never be placed while it keeps the string
      if (this.roomOfSession(e.session)) continue;
      if (now - e.at < this.waitMs) continue;
      this.drop(e.playerId);
      if (e.connected) this.send(e, { status: 'timeout' });
    }
    if (this.entries.size === 0) { this.disarm(); return; }
    this.tryPlace();
    if (this.entries.size === 0) { this.disarm(); return; }
    // The next timeout can be sooner than a full interval: arm for the earliest deadline still ahead.
    let next = Infinity;
    for (const e of this.entries.values()) next = Math.min(next, e.at + this.waitMs - now);
    this.armOneShot(Math.max(50, Math.min(this.sweepMs, Number.isFinite(next) ? next : this.sweepMs)));
  }

  /** Arm the sweep timer for `ms` (replacing an existing one). */
  armOneShot(ms) {
    this.disarm();
    const t = setTimeout(() => { this.timer = null; this.sweep(); }, ms);
    t.unref?.();
    this.timer = t;
  }

  /** Arm the sweep timer, keeping an existing one (it re-arms itself after each sweep). */
  arm() {
    if (this.timer) return;
    const t = setTimeout(() => { this.timer = null; this.sweep(); }, this.sweepMs);
    t.unref?.();
    this.timer = t;
  }

  disarm() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------------------------------
  // talking to the queue
  // -------------------------------------------------------------------------------------------------

  /** Every waiting player is told the queue's new shape (`room.queued`), in arrival order (position is 1-based). */
  publish() {
    const waiting = this.waiting();
    waiting.forEach((e, i) => this.send(e, {
      status: 'waiting',
      position: i + 1,
      size: waiting.length,
      need: this.size,
      deadline: e.at + this.waitMs,
    }));
  }

  /**
   * One `room.queued` frame to a queued player. Never to a bot or a departed session; a player who is already in a
   * room is only reached by the `placed` message (`force`), which is the one frame that tells them where they went.
   */
  send(entry, extra = {}, force = false) {
    const session = this.lobby.registry.byId(entry.playerId) || entry.session;
    if (!session || !session.connected || session.isBot) return false;
    if (!force && session.roomCode != null) return false;
    return sendSession(session, {
      t: 'room.queued',
      status: extra.status,
      position: extra.position ?? 0,
      size: extra.size ?? this.waiting().length,
      need: extra.need ?? this.size,
      waitedMs: Math.max(0, this.lobby.now() - entry.at),
      deadline: extra.deadline ?? entry.at + this.waitMs,
      ...(extra.code ? { code: extra.code } : {}),
    });
  }

  /** `/healthz` counters (Lobby.stats). */
  stats() {
    return { queued: this.entries.size, queuedWaiting: this.waiting().length, queueSize: this.size, queueFormed: this.formed };
  }
}
