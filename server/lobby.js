// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.setAiPicksLast, room.addBot, room.removeBot, room.kick, room.start.
//     ▸ Changing the difficulty or the AI-picks-last option (co-op only) un-readies the other humans.
//     ▸ room.start requires every other human to be connected and ready; the host's start counts as the host's
//     ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, the
//     AI-picks-last option, AI seats, start), leave it, or a new match starts. A human removed by the lobby grace
//     gets them right after `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the
//     lobby drops the match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//     ▸ Its `ops` (0.2.2: the per-operator 潜能 / 练度, shared/protocol.js checkLoadoutOps — an operator of the 干员调配
//     roster or the 自选 owned pool, strict like the entries) travel with it: session.ops / seat.ops / seats[].ops and
//     match.setLoadout(playerId, loadout, ops); a message without `ops` sets none (every operator 潜能 6, 精英2 Lv.60).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).
//   * 野排匹配 quick match (a PRODUCT feature, not a pack surface — server/matchmaking.js, docs/META.md §1.6):
//     `room.queue` enters its queue and `room.dequeue` cancels. The queue is PLACEMENT ONLY — when `queue.size` (default
//     MAX_SEATS) players wait, `lobby.matchmake` forms one ORDINARY room by calling this file's own `create` (the
//     longest-waiting player hosts it) and `join` (the rest take the lowest free seat, in arrival order), so every rule
//     above applies to a quick-matched room unchanged. It never declares `modIds`: a quick-matched room runs the
//     server's DEFAULT set, while a room that already declared one keeps it (W-B). The wait is bounded (`queue.waitMs`),
//     a waiting player who drops stops counting but keeps the slot for a resume, `room.queued` is the only new frame,
//     and nothing at all runs while the queue is empty (one Map, no timer).
//   * 房间保留 room retention (a PRODUCT feature of the same ruling): when a match ends the room is NOT torn down — it
//     stays in `this.rooms` in its LOBBY state with its members, its `modIds` / `modSet` (W-B), its difficulty and its
//     AI-picks-last option intact, so the group starts another match without re-inviting (`onMatchEnd` below frees only
//     the seats of humans who departed, un-readies the rest and drops the match). It is reclaimed exactly as any other
//     room is: `removeMember` disposes it once no active human remains ('empty'), and a disconnected human's seat is
//     released by the lobby grace ('timeout'). A retained room holds no timer of its own — the only timers that outlive
//     the match are the grace timers already running for its disconnected seats.

import { randomBytes, randomInt } from 'node:crypto';
import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor } from '../shared/constants.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds, checkNotOwned, checkDiyPicks, PACK_MSG_LIMITS, CHAT_LIMITS, CHAT_MODES } from '../shared/protocol.js';
import { modSetOf, isModId } from '../shared/modIdentity.js';
import { normalizeSupportConfig, checkSupport, supportPicker, supportCapacity, supportTiers } from '../shared/support.js';
import { encode, isDroppable, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { buildRoomRegistry } from './match/metaPack.js';
// 包声明的**房间级钩子**（`pack.json.server.room`, DESIGN §28.20）：装载路径在 `server/roomPack.js`（启动时一次），
// 这里只做**装配** —— 房间建起来时装一次、每个生命周期点触发一次。没有包声明 `server.room` 时 `install` 与 `fire`
// 都是一次早退（`byRoom` 里没有条目），所以干净安装与从前逐字节相同。
import { createRoomHooks } from './roomPack.js';
import { getDefaultRegistry } from './match/effectsMeta.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { MatchmakeQueue } from './matchmaking.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  queue: null,            // 野排匹配 (server/matchmaking.js MATCHMAKE_DEFAULTS): size / max / waitMs / sweepMs / difficulty
  // 房内聊天（引擎特性）允许的快捷短语 id。**唯一真源**：文案在客户端（`public/i18n/*`），服务端只认 id，
  // 所以未在此列出的 id 一律点名拒绝（`request === 'room.quickMsg'` 的 `BAD_MSG`）。
  // 默认这一组与官方「快捷交流」的常用句式对应；部署方可以通过 startServer({ quickPhrases: [...] }) 换掉。
  quickPhrases: null,
});

/**
 * 默认快捷短语 id（`niceOne` / `myBad` 这类 camelCase 就是 id 本身，不是显示文案）。
 * 客户端把它们渲染成本地化句子（`public/i18n/*` 的 `quick.*` 词条）；服务端只做「是不是我认识的 id」这一件事。
 */
export const DEFAULT_QUICK_PHRASES = Object.freeze([
  'niceOne', 'myBad', 'wellPlayed', 'thanks', 'wait', 'ready', 'help', 'focus', 'goodLuck',
]);

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             ops?: Readonly<Record<string, { potential: number, cultivate: number }>> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null }} Seat
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked operator settings (0.2.2 潜能 / 练度; shared by the session, the seat and the match). */
function freezeOps(ops) {
  const out = {};
  for (const [id, e] of Object.entries(ops || {})) out[id] = Object.freeze({ potential: e.potential, cultivate: e.cultivate });
  return Object.freeze(out);
}

/** The charIds a player may set a potential / 练度 for, per data object (shared/protocol.js cultivationCharIds). */
const OPS_IDS = new WeakMap();
function opsCharIds(data) {
  if (!data || typeof data !== 'object') return new Set();
  let ids = OPS_IDS.get(data);
  if (!ids) { ids = cultivationCharIds(data.chess, data.backups); OPS_IDS.set(data, ids); }
  return ids;
}

/** Deep-frozen copy of a checked 助战 selection (shared by the session, the seat and the match's PlayerState). */
function freezeSupport(entries) {
  return Object.freeze([...(entries || [])]);
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/**
 * Resolve a `room.create` `modIds` list into the room's own mod set (W-A, DESIGN §28.9).
 *
 * The ids are matched against the packs THIS PROCESS already loaded (`Lobby.workshop.mods`), because a room picks a
 * subset of the catalogue — the server owns every hash, so a client cannot name content the server does not have. The
 * digest is computed by `modSetOf` — the SAME function the process set, `welcome` and every BattleSpec go through — so
 * the room's digest can never be a second opinion about the same list.
 *
 * `modSetOf` sorts by id, so the room's `packs` are sorted whatever order the client sent.
 * @param {any[]} requested pack ids as they arrived (`isModId`-checked by shared/protocol.js)
 * @param {Array<{ id: string, hash: string, layer: string, combat: boolean, api?: string }>} catalogue loaded packs
 * @returns {{ ok: true, modIds: string[], modSet: { digest: string, packs: Array<object> } }
 *          | { ok: false, unknown: string[], available: string[] }}
 */
function resolveRoomModSet(requested, catalogue) {
  const available = (Array.isArray(catalogue) ? catalogue : []).filter((p) => p && isModId(p.id));
  const known = new Set(available.map((p) => p.id));
  const ids = [];
  const unknown = [];
  for (const raw of requested) {
    if (typeof raw !== 'string' || !isModId(raw)) continue;   // shared/protocol.js already refused these
    if (!known.has(raw)) { if (!unknown.includes(raw)) unknown.push(raw); continue; }
    if (!ids.includes(raw)) ids.push(raw);
  }
  if (unknown.length) {
    return { ok: false, unknown: unknown.sort(), available: [...known].sort() };
  }
  if (!ids.length) return { ok: true, modIds: [], modSet: null };
  // The catalogue entry is copied, never handed out by reference: the room must not be able to reach into the loader's
  // pack objects (and `api` is dropped when the pack declared none — the wire shape is what `isModEntry` accepts).
  const picked = ids.map((id) => {
    const p = available.find((e) => e.id === id);
    return p.api == null ? { id: p.id, hash: p.hash, layer: p.layer, combat: p.combat }
      : { id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api };
  });
  const modSet = modSetOf(picked);
  // A pack the loader identified but `modSetOf` will not accept (an empty hash, an unknown layer) is a server-side
  // inconsistency, not a client error: say so instead of quietly handing back a room with a different set than asked.
  if (!modSet) return { ok: false, unknown: [], available: [...known].sort() };
  return { ok: true, modIds: Object.freeze(ids.slice().sort()), modSet };
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /**
     * 「AI 队友最后选择」 (room.setAiPicksLast, GitHub #338; co-op only, off by default): the match's strategy and 机变 drafts
     * put every human seat before every AI seat (Match opts.aiPicksLast). Kept across the room's matches.
     */
    this.aiPicksLast = false;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    this.disposed = false;
    /**
     * The room's OWN mod set (W-A, DESIGN §28.9) — a subset of what the process loaded, named by `room.create`. Both
     * stay null for a room that declared nothing (the default: the room runs whatever the process runs). `modSet` is
     * `{ digest, packs }` of the same shape as `welcome.mods`, built by the same `modSetOf`.
     * @type {readonly string[] | null}
     */
    this.modIds = null;
    /** @type {{ digest: string, packs: Array<object> } | null} */
    this.modSet = null;
    /**
     * 房内聊天模式（`room.state.chatMode`，`room.create.chatMode` 设）：`'open'` 打字与短语都可以（默认）、
     * `'quick'` 只允许快捷短语、`'off'` 都禁。**服务端强制** —— 客户端的输入框只是照着这个值摆样子。
     * @type {'open'|'quick'|'off'}
     */
    this.chatMode = 'open';
    /**
     * 聊天**环形缓冲**（`CHAT_LIMITS.history` 条），重连的 resync 里回放给**这一个**会话。
     * **只在内存里**：这条路不碰任何持久化，房间没了它也就没了。
     * @type {object[]}
     */
    this.chat = [];
  }

  /**
   * 往环形缓冲里放一条（超出上限就丢最旧的）。
   * @param {object} frame 已塑形的 `chat.msg` 帧
   */
  addChat(frame) {
    this.chat.push(frame);
    if (this.chat.length > CHAT_LIMITS.history) this.chat.splice(0, this.chat.length - CHAT_LIMITS.history);
    return this.chat.length;
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /**
   * `room.state` frame (DESIGN §8.1) plus `inMatch`, plus the room's own `mods` when it declared a set (W-A,
   * DESIGN §28.9). `mods` has the SAME shape as `welcome.mods` (`{ digest, packs }`, packs sorted by id) and is
   * ABSENT — not null, not `{}` — for a room that declared nothing, so a vanilla install's frame is byte-identical to
   * what it was before this feature.
   * @param {object|null} [support] the SERVER's 助战 catalog (Lobby.supportView): the client cannot derive the pool, so
   *   the picker is only ever able to offer what the server declares.
   */
  toState(support = null) {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      aiPicksLast: this.aiPicksLast,
      // 房内聊天模式：客户端据此决定要不要显示输入框。**服务端强制**（`chat` / `quickMsg` 各自再判一次），
      // 这个字段只是让界面说实话。
      chatMode: this.chatMode,
      inMatch: !!this.match,
      seats: this.seats.map((s) => (s
        ? {
          seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left,
          // 外观选择（皮肤层）：**别人看到的你** —— `{ picks?, avatar? }`（见 `appearance()`）。
          // 只有选过才有这个键 —— 一个没换装的房间与从前逐字节相同。
          ...(s.appearance && Object.keys(s.appearance).length ? { appearance: s.appearance } : {}),
        }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected })),
      ...(this.modSet ? { mods: this.modSet } : {}),
      ...(support ? { support } : {}),
    };
  }

  /**
   * 包里**房间钩子**在事件那一刻看到的房间快照（DESIGN §28.20）：`toState()` 去掉 `t` 与 `support`（一个是
   * 线格式的帧类型，一个是服务端按需查的助战目录 —— 钩子不需要它，而信封里少一个键就少一份要维护的形状），
   * 并且**不带 `mods`**：房间自己的集合是**安装那一刻**就定死的（钩子的 `room.modIds` 就是它），事件里再带这一大坨
   * 只是把不变的静态数据复制 N 遍。
   *
   * 这份快照是给**钩子**的，不是给玩家的：它不经过 `encode`，所以它照 `room.state` 的字段形状走、不带 `t`。
   */
  hookSnapshot() {
    const state = this.toState();
    delete state.t;
    delete state.support;
    delete state.mods;
    return state;
  }

  /**
   * 一个玩家/观战者座位的**钩子侧快照**（`join` / `leave` / `spectate` 的 `by`）—— 与 `room.players` 里的条目同形，
   * 所以包读 `by.playerId` 与读 `room.players` 一样，不需要记住两套形状。
   * @param {string} playerId
   */
  hookPlayer(playerId) {
    for (const p of this.hookSnapshot().seats) if (p && p.playerId === playerId) return p;
    for (const s of this.hookSnapshot().spectators) if (s && s.playerId === playerId) return { ...s, seat: null, isBot: false, ready: false, left: false };
    return null;
  }
}

/**
 * 一条聊天文本的**塑形**：按 Unicode 码点截到 `CHAT_LIMITS.text`，去掉控制字符，两端空白抹平；全是空白 ⇒ `''`。
 *
 * 为什么按**码点**切而不是 `slice`：`'🙂'.length === 2`，按 UTF-16 单元切会把一个代理对劈成两半，接收端渲染出
 * 一个替换字符。`[...s]` 走的是码点迭代，这是 `sanitizeName`（昵称那条）的同一条思路。
 *
 * 控制字符（含 `\n` / `\t` / DEL）一律换成空格：聊天是**单行**展示，一条消息不该有能力自己排版。
 * @param {unknown} raw
 * @returns {string} 可直接广播的文本；无内容时是空串
 */
export function chatText(raw) {
  const s = typeof raw === 'string' ? raw : '';
  return [...s]
    .map((ch) => (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f ? ' ' : ch))
    .slice(0, CHAT_LIMITS.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, options = {}, workshop = null }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /**
     * 工坊行为层 (docs/WORKSHOP.md §4): `{ kits, modules }` from server/workshop.js loadWorkshopKits — the per-battle
     * kit map (server-run battles) and the JSON-safe module list a client-simulated battle needs. null for a plain
     * install, in which case nothing is injected at all.
     */
    this.workshop = workshop && typeof workshop === 'object' ? workshop : null;
    /**
     * 包通道白名单（docs/WORKSHOP.md §1.9.6）：`<包id>` → 这个包声明过的通道名集合。由**面板清单**推出来 ——
     * 面板就是通道的声明人（`client.panels[].messages`），所以这里不存在第二份真相：`welcome.modPanels` 与这一份
     * 是同一批数据的两个读者。没有包声明 `client` 时它是空表，`pack.msg` 一律回 `BAD_MSG`。
     * @type {Map<string, Set<string>>}
     */
    this.packChannels = new Map();
    for (const panel of (this.workshop && Array.isArray(this.workshop.panels) ? this.workshop.panels : [])) {
      if (!panel || typeof panel.pack !== 'string' || !Array.isArray(panel.messages)) continue;
      if (!this.packChannels.has(panel.pack)) this.packChannels.set(panel.pack, new Set());
      for (const channel of panel.messages) this.packChannels.get(panel.pack).add(channel);
    }
    /**
     * 快捷短语的服务端白名单（`room.quickMsg`）。与 `packChannels` 同一个形状的「不认识就点名」判据：**表里没有
     * 的 id 不会被转发**，接收端因此永远不必对着一堆不认识的 id 猜文案。默认 `DEFAULT_QUICK_PHRASES`。
     * 用 `options.quickPhrases` 换掉（部署方口径），显式传空数组即「这个服务器不做快捷消息」。
     * @type {Set<string>}
     */
    this.quickPhrases = new Set(
      Array.isArray(this.opts.quickPhrases) ? this.opts.quickPhrases : DEFAULT_QUICK_PHRASES,
    );
    /**
     * What this server is running, as one identity (DESIGN §28.2): `{ digest, packs }`, or null for a plain install.
     * The digest travels in `welcome` and must be echoed in `room.create` / `room.join` before a seat is given in a
     * room whose content is not vanilla — the client is told what it is joining, and a client too old to answer is
     * refused rather than let in silently (docs/PACKS.md:135-136).
     * @type {{ digest: string, packs: Array<object> }|null}
     */
    this.modSet = modSetOf(Array.isArray(this.workshop?.mods) ? this.workshop.mods : []);
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    /**
     * 包声明的**房间级钩子**总线（`pack.json.server.room`, DESIGN §28.20）。`workshop.roomHooks` 是启动时
     * `server/roomPack.js loadRoomInstallers` 交出来的真函数（每个包一个 `install(room)`）；这里把它包成一个
     * **按房间**留表的 bus（W-B：声明了集合的房间只装它点名的包）。一个包都没声明时 `roomHooks` 是空数组 ⇒
     * `install` / `fire` 都早退，房间的每一步与从前逐字节相同。
     */
    this.roomHooks = createRoomHooks({
      installers: this.workshop && Array.isArray(this.workshop.roomHooks) ? this.workshop.roomHooks : [],
      log: this.log,
      now: this.now,
    });
    /**
     * 野排匹配 (quick match; a PRODUCT feature of the engine — server/matchmaking.js, docs/META.md §1.6). The queue is
     * placement only: when enough players wait, it forms an ORDINARY room through `this.create` / `this.join` below, so
     * nothing about rooms, seats, mods or matches changes here. Nothing is created for a server nobody queues on, which
     * is why the queue is built here (one Map, no timer) and not in `server/index.js`.
     */
    this.matchmake = new MatchmakeQueue(this, this.opts.queue || undefined);
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Counters for /healthz, plus the mod-set digest when this server runs one (DESIGN §28.9: `welcome`, `/healthz` and
   * the BattleSpec must quote the SAME string, so a bug report can name the content it came from). */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators, ...this.matchmake.stats(), ...(this.modSet ? { mods: this.modSet.digest, modPacks: this.modSet.packs.length } : {}) };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    // the queue's own resume (a queued player has no room, so nothing below would reach them)
    this.matchmake.onHello(session);
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * The mod-set gate (DESIGN §28.2): on a server that runs workshop packs, entering a room means running THEIR content,
   * so the client must say which content it thinks it is joining. A client that does not answer (or answers with what
   * the server is not running) is refused with a reason it can act on — the alternative is a player silently playing
   * content the UI never told them about.
   *
   * ▸ W-A DOES NOT CHANGE THIS. It still judges `msg.mods` against the PROCESS-wide set (`this.modSet`), i.e. everything
   * the server loaded — NOT the set a room declared in `modIds`. A room's declared set is only DECLARED and handed out
   * (`Room.modSet` → `room.state.mods`) in this cut; it starts deciding what the simulation runs in W-B, when the room's
   * merged data reaches `Match` and the two bypass singletons (`server/sim/content/support/index.js`, `server/data.js`).
   * Until then a client is let into a room whose declared set is a strict subset of the server's — deliberately, because
   * the simulation is still running the server's whole set either way, and pretending otherwise would be the lie.
   * @param {any} msg the `room.create` / `room.join` message
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  checkModSet(msg) {
    if (!this.modSet) return OK;
    if (msg.mods === this.modSet.digest) return OK;
    return fail(ERR.BAD_MSG, msg.mods
      ? `this server runs a different mod set (${this.modSet.digest.slice(0, 12)}…) — reload the page`
      : `this server runs ${this.modSet.packs.length} workshop pack(s) (${this.modSet.packs.map((p) => p.id).join(', ')}); a client must confirm the mod set to enter — reload the page`);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setAiPicksLast': return this.setAiPicksLast(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.support': return this.support(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      // 外观选择（皮肤层）：别人看到的你长什么样 —— 纯展示，比赛中也接受，变更即广播
      case 'room.appearance': return this.appearance(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      // 野排匹配 (quick match): the queue lives in server/matchmaking.js; these two cases are its only entry points
      case 'room.queue': return this.matchmake.join(session, msg);
      case 'room.dequeue': return this.matchmake.leave(session);
      // 房内聊天（引擎特性）：打字与快捷短语，形状由 shared/protocol.js 判死，能不能说由这里裁决
      case 'room.chat': return this.chat(session, msg);
      case 'room.quickMsg': return this.quickMsg(session, msg);
      case 'pack.msg': return this.packMsg(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /**
   * `pack.msg`（docs/WORKSHOP.md §1.9.6，业主裁决 2026-10-10 的「消息额度」那一半）：**包自己的通道**，引擎只当
   * 不透明载荷转发。四道判据，全部落在「不认识的声明要响亮」那条线上：
   *   1. 必须**在房间里**（通道是房间内的，不在大厅里广播全网）；
   *   2. `pack` 必须是这个服务器真的装着的包，且它**声明过**这个通道（`this.packChannels`）—— 一个包说不出另一个
   *      包的通道，也说不出自己没写进 `client.panels[].messages` 的通道；
   *   3. 载荷大小由 `validateC2S` 卡过（`PACK_MSG_LIMITS.bytes`），这里再卡**频率**（每会话令牌桶，超了 `ERR.RATE`）；
   *   4. 送回**同一个房间**的成员与旁观者。引擎不解释 `data`，也不判断谁该收到 —— 客户端只把消息交给声明过这个
   *      通道的面板，那是「第二个读者」的判据（`extensions.js` 的 `net.on(channel, …)`）。
   * @param {import('./net.js').Session} session
   * @param {{ pack: string, channel: string, data?: any }} msg
   */
  packMsg(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const declared = this.packChannels.get(msg.pack);
    if (!declared || !declared.has(msg.channel)) {
      return fail(ERR.BAD_MSG, `pack "${String(msg.pack).slice(0, 32)}" does not declare the channel "${String(msg.channel).slice(0, 32)}"`);
    }
    if (!this.packMsgAllowed(session)) return fail(ERR.RATE);
    const out = {
      t: 'pack.msg', pack: msg.pack, channel: msg.channel, from: session.playerId,
      ...(msg.data === undefined ? {} : { data: msg.data }),
    };
    for (const seat of room.seats) {
      if (!seat || seat.isBot) continue;
      const target = this.registry.byId(seat.playerId);
      if (target && target.connected) sendSession(target, out);
    }
    for (const seat of room.spectators) {
      const target = this.registry.byId(seat.playerId);
      if (target && target.connected) sendSession(target, out);
    }
    return OK;
  }

  /**
   * `room.chat { text }` —— **房内打字聊天**（引擎特性，不是包能力；包要用自己的消息走 `pack.msg`）。
   *
   * 四道判据，全部落在「不认识的请求要响亮」那条线上，没有一道是静默丢弃：
   *   1. 必须**在房间里**（`ERR.NOT_IN_ROOM`）；
   *   2. **旁观者不可发言**（`ERR.SPECTATOR`）—— 他们收得到每一条，但说不出话，与既有的 `g.*` 同一条口径；
   *   3. 房间的 `chatMode` 允许打字（`ERR.CHAT_MODE`）：`'quick'` 只许快捷短语，`'off'` 全禁；
   *   4. 每会话令牌桶限流（`ERR.RATE`）。
   *
   * **超长是截断，不是拒绝**：按 Unicode 码点切到 `CHAT_LIMITS.text`（一个 emoji 算 1 个码点），与昵称
   * `sanitizeName` 同一条「显示用上限」的思路；到不了 `CHAT_LIMITS.inbound` 的消息在 `validateC2S` 就被拒了。
   *
   * 空白消息（全是空白的也算）**不广播**、也不报错 —— 它没有任何可观察效果，回一个错误只会让客户端为难。
   * @param {import('./net.js').Session} session
   * @param {{ text: string }} msg
   */
  chat(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.chatMode !== 'open') return fail(ERR.CHAT_MODE, `this room only allows ${room.chatMode === 'quick' ? 'quick messages' : 'no chat'}`);
    const seat = room.seatOf(session.playerId);
    if (!seat) return fail(ERR.NOT_IN_ROOM);
    if (!this.chatAllowed(session, 'chat')) return fail(ERR.RATE);
    const text = chatText(msg.text);
    if (!text) return OK;                                   // whitespace only: nothing to say, nothing to report
    this.sayInRoom(room, seat, { text });
    return OK;
  }

  /**
   * `room.quickMsg { ids, arg? }` —— **快捷短语**（引擎特性）。`ids` 是逗号分隔的短语 id，`arg` 是可选的短参。
   *
   * 为什么 id 要有服务端白名单：短语的**文案在客户端**（`public/i18n/*`），服务端只认 id。没有白名单的话，
   * 任何字符串都能当 id 送进来，接收端就得对着一堆不认识的 id 猜。所以 `this.quickPhrases` 是唯一真源：
   * 未声明的 id 点名拒绝（`ERR.BAD_MSG`）。
   *
   * 与打字聊天共用同一套房间判据（在房间 / 不是旁观者 / 限流），但**模式判据不同**：`'quick'` 模式放行的正是
   * 这一条，`'off'` 才一起禁掉。
   * @param {import('./net.js').Session} session
   * @param {{ ids: string, arg?: string }} msg
   */
  quickMsg(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.chatMode === 'off') return fail(ERR.CHAT_MODE, 'chat is off in this room');
    const seat = room.seatOf(session.playerId);
    if (!seat) return fail(ERR.NOT_IN_ROOM);
    for (const id of String(msg.ids).split(',')) {
      if (!this.quickPhrases.has(id)) return fail(ERR.BAD_MSG, `unknown quick phrase "${id.slice(0, 32)}"`);
    }
    if (!this.chatAllowed(session, 'quick')) return fail(ERR.RATE);
    this.sayInRoom(room, seat, {
      quick: String(msg.ids).split(','),
      ...(msg.arg === undefined ? {} : { arg: msg.arg }),
    });
    return OK;
  }

  /** 房内说话的**唯一出口**（打字与短语共用）：塑形 → 进环形缓冲（重连回放用）→ 广播。 */
  sayInRoom(room, seat, payload) {
    const out = { t: 'chat.msg', from: seat.playerId, name: seat.name, seat: seat.seat, at: this.now(), ...payload };
    room.addChat(out);
    this.broadcastRoom(room, out);
    return out;
  }

  /**
   * 聊天的**每会话**令牌桶，**打字与快捷短语各自一份**（`kind` 区分）：短语是「零成本的按一下」，打字要走
   * 输入框，两者的合理频率差得很远 —— 共用一只桶会让「连点几下短语」把人的打字额度吃掉，反过来也一样。
   * 与包通道（`packMsgAllowed`）同样各自一份。
   * @param {import('./net.js').Session} session
   * @param {'chat'|'quick'} kind
   */
  chatAllowed(session, kind, now = this.now()) {
    const key = kind === 'quick' ? 'quickBucket' : 'chatBucket';
    const bucket = session[key] || (session[key] = { tokens: CHAT_LIMITS.burst, at: now });
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.at = now;
    bucket.tokens = Math.min(CHAT_LIMITS.burst, bucket.tokens + elapsed * CHAT_LIMITS.perSec);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** 包通道的**每会话**令牌桶（`PACK_MSG_LIMITS`）：一个没有限流的聊天通道就是一个刷屏通道，
   *  而「引擎不解释载荷」不等于「引擎不管频率」。 */
  packMsgAllowed(session, now = this.now()) {
    const bucket = session.packMsgBucket || (session.packMsgBucket = { tokens: PACK_MSG_LIMITS.burst, at: now });
    const elapsed = Math.max(0, now - bucket.at) / 1000;
    bucket.at = now;
    bucket.tokens = Math.min(PACK_MSG_LIMITS.burst, bucket.tokens + elapsed * PACK_MSG_LIMITS.perSec);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    // 野排匹配: a queued player may have no room at all, so the queue is told before the `if (!room)` return below
    this.matchmake.onDisconnect(session);
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) { if (player) this.callMatch(room, 'onDisconnect', session.playerId); } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    this.matchmake.onExpire(session.playerId); // gone for good: also out of the quick-match queue
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    this.matchmake.shutdown();
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, mods, modIds, chatMode }) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    const gate = this.checkModSet({ mods });
    if (!gate.ok) return gate;
    // The room's own set (W-A, DESIGN §28.9): every id must name a pack THIS server loaded, and the refusal names both
    // what was not found and what is on offer — a client cannot guess its way into a set the server cannot run. Absent
    // or `[]` = today's behaviour (the room declares nothing and `room.state` gets no `mods`).
    const resolved = resolveRoomModSet(Array.isArray(modIds) ? modIds : [], this.workshop?.mods);
    if (!resolved.ok) {
      const unknown = resolved.unknown.length ? resolved.unknown.join(', ') : '(none)';
      const available = resolved.available.length ? resolved.available.join(', ') : '(none)';
      return fail(ERR.MOD_UNKNOWN, `this server does not run the mod pack(s) (${unknown}); available: ${available}`);
    }
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now());
    room.ownerKey = key;
    // 房内聊天模式由房主在建房时定（`room.create.chatMode`，默认 'open'）。**服务端强制**：这个值决定
    // `chat` / `quickMsg` 各自放不放行，客户端的输入框只是照着它摆样子。
    if (chatMode !== undefined) room.chatMode = chatMode;
    // the room's own mod set, resolved above (both stay null when it declared none — the default)
    room.modIds = resolved.modIds.length ? resolved.modIds : null;
    room.modSet = resolved.modSet;
    // W-B: 声明了就**现在**物化（`server/roomAssets.js`）—— 这一局要用的数据 / kit / 模块清单从此按摘要缓存在服务器上，
    // `/room-data/<摘要>/…` 那个面也才有东西可答（只有真的被房间声明过的摘要会被登记，所以客户端编不出来）。
    if (room.modSet && this.workshop && this.workshop.roomAssets) this.workshop.roomAssets.forRoom(room.modSet);
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    // 房间级钩子（§28.20）：房间**已经完全建好**（`rooms` 里有它、房主就位、集合已物化）之后才触发 —— 钩子看到的
    // 就是这个房间真正的样子。装不上的包在 `install` 里已经点名并退场，房间照旧。
    this.roomHooks.install(room);
    this.hookFire(room, 'create', { room: room.hookSnapshot(), by: room.hookPlayer(session.playerId) });
    return OK;
  }

  join(session, { code, mods }) {
    const gate = this.checkModSet({ mods });
    if (!gate.ok) return gate;
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    // 房间级钩子（§28.20）：**新成员**加入（幂等的重复 join 在上面就返回了，不会走到这里）。
    this.hookFire(room, 'join', { room: room.hookSnapshot(), by: room.hookPlayer(session.playerId) });
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, connected: session.connected });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    // 房间级钩子（§28.20）：**新观战者**加入。观战者不是玩家、不占座位、不算开局门槛 —— 但「有人来看」正是包想播报的。
    this.hookFire(room, 'spectate', { room: room.hookSnapshot(), by: room.hookPlayer(session.playerId) });
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /** 「AI 队友最后选择」 (GitHub #338): host-only, before the match, co-op rooms only (a solo room has no AI seat). */
  setAiPicksLast(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'solo rooms have no AI teammates');
    this.dropReplay(room, session.playerId);
    if (room.aiPicksLast !== on) {
      room.aiPicksLast = on;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout — and its per-operator 潜能 / 练度 `ops` (0.2.2) — against the
   * game data, store both on the session and the seat, and — while a match runs — hand them to the match (accepted only
   * during INFO_CHECK, see the header). Either part refused: nothing is stored.
   */
  loadout(session, { entries, ops }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const ids = opsCharIds(data);
    const resOps = checkLoadoutOps(ops, (id) => ids.has(id));
    if (!resOps || resOps.error) return fail(resOps && isErrCode(resOps.error) ? resOps.error : ERR.BAD_MSG, resOps && resOps.detail);
    const loadout = freezeLoadout(res.loadout);
    const opsSet = freezeOps(resOps.ops);
    session.loadout = loadout;
    session.ops = opsSet;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.loadout = loadout; seat.ops = opsSet; }
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout, opsSet);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.support (助战, shared/support.js): check the selection against the SERVER's pool (data/support.json), store it
   * on the session and the seat, and — while a match runs — hand it to the match (accepted until the match leaves
   * INFO_CHECK, exactly like the loadout). An operator the pool does not list rejects the whole message: unlike the
   * loadout there is deliberately no fallback, because falling back would silently grant a disabled operator.
   */
  support(session, { entries }) {
    const data = this.safeData();
    const cfg = normalizeSupportConfig(data && data.support);
    const res = checkSupport(entries, cfg, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const support = freezeSupport(res.entries);
    session.support = support;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.support = support;
    if (!room.match || !seat) return OK; // a spectator's selection stays on its session, never reaching the match
    if (typeof room.match.setSupport !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setSupport(session.playerId, support);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setSupport threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const data = this.safeData();
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    session.notOwned = list;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.notOwned = list;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS), store them on the
   * session and the seat (see the header). A running match never takes them: it keeps the picks its seat had at its
   * start.
   */
  diy(session, { picks }) {
    const res = checkDiyPicks(picks, { data: this.safeData(), kitted: KITTED_CHARS });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    session.diy = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.diy = kept;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * `room.appearance`（皮肤层）：把**别人看到的你长什么样**存到会话与座位上，并向全房广播。
   *
   * 两个字段：`picks`（按干员的换装）与 `avatar`（玩家自己那张头像）—— **合并进同一份**会话/座位状态，
   * 因为对别人来说它们就是同一件事（「他现在长这样」）。
   *
   * 与 `room.diy` / `room.ownership` 有三处刻意的不同：
   *   * **服务端不判定内容**。形状由 `validateC2S`（`isAppearanceMsg`）卡死，但「这个 skinId 存不存在」要看包
   *     声明的 `assets.skins`，而**服务端看不见包内容** —— 所以这一层只转发，不认识的那一项由画的一方回落原版
   *     （`portraitChain` 的回落：可见、可解释，不会串到别的干员身上）；
   *   * **比赛中也接受**（不像 diy / ownership 存起来等下一局）：它只改显示、**不碰战果**，没有理由等；
   *   * **变更即广播**（同房的人要立刻看到），而不是等下一次状态推送。
   *
   * 合并语义是**浅合并**：这一条只带 `avatar` 时，已经选过的 `picks` 原样保留（反之亦然）——
   * 「换头像把皮肤清空」是没人会报的错（两个字段说的是两件事）。
   * @param {any} session
   * @param {{ picks?: Record<string, { skinId?: string, avatar?: string }>, avatar?: { avatar?: string } }} msg
   */
  appearance(session, msg) {
    const prev = session.appearance && typeof session.appearance === 'object' ? session.appearance : null;
    const picks = msg.picks !== undefined
      ? Object.freeze(Object.fromEntries(Object.entries(msg.picks).map(([charId, pick]) => [charId, Object.freeze({ ...pick })])))
      : (prev ? prev.picks : null);
    const avatar = msg.avatar !== undefined
      ? Object.freeze({ ...msg.avatar })
      : (prev ? prev.avatar : null);
    const kept = Object.freeze({
      ...(picks && Object.keys(picks).length ? { picks } : {}),
      ...(avatar ? { avatar } : {}),
    });
    session.appearance = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.appearance = kept;
    // 广播：外观是**给别人看的**，所以它必须立刻到达同房的人（不像 loadout 那样只对本人生效）
    this.broadcastState(room);
    return OK;
  }

  /** Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`), and what
   * this server is running (`mods`, DESIGN §28.2) so the client can mark itself modded and echo the digest to enter.
   * Since B2 段 it also carries the C-layer panels the installed packs declared (`modPanels`, DESIGN §28.8): the
   * registration list travels in a frame the server already sends, so a server with no such pack is byte-identical.
   * Since B4 段 the same is true of `modAssets` (DESIGN §28.13.5): the packs that declared `assets` — their registered
   * container / manifest URLs, the container digest the loader verified against the bytes, and the two normalized
   * policy values. **Only readers add it**: no pack declaring `assets` means no field, no SW registration, no new
   * request, no new DOM, no new global on the client (main.js only imports the resource flow when the field arrives). */
  welcomeInfo() {
    const panels = this.workshop && Array.isArray(this.workshop.panels) ? this.workshop.panels : [];
    const assets = this.workshop && Array.isArray(this.workshop.assets) ? this.workshop.assets : [];
    // 包写的主题变量（业主裁决 2026-10-10）：合并好的那一份 `{ vars }`，与 `modPanels` 同构 —— **只有声明了才有**，
    // 没有包声明主题时 `welcome` 的字段集合一个都不多（`test/modClientPanels.test.js` 两侧对照钉着这条）。
    const theme = this.workshop && this.workshop.theme && typeof this.workshop.theme === 'object' ? this.workshop.theme : null;
    return {
      diyKitted: KITTED_CHARS,
      ...(this.modSet ? { mods: this.modSet } : {}),
      ...(panels.length ? { modPanels: panels } : {}),
      ...(assets.length ? { modAssets: assets } : {}),
      ...(theme && theme.vars && Object.keys(theme.vars).length ? { modTheme: theme } : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    const seats = room.seats.filter(Boolean).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
      // DESIGN §16: the human's checked operator loadout and (0.2.2) per-operator 潜能 / 练度 (bots fight with the defaults)
      loadout: s.isBot ? null : s.loadout || null,
      ops: s.isBot ? null : s.ops || null,
      // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
      notOwned: s.isBot ? null : s.notOwned || null,
      // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
      diy: s.isBot ? null : s.diy || null,
      // 助战 (shared/support.js): the human's checked support selection — only ids the server pool allows (bots: none).
      // Passed through as the frozen array the seat holds (the loadout's stance), never re-copied into a mutable one.
      support: s.isBot ? null : (Array.isArray(s.support) ? s.support : null),
    }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    // 包声明的对局元注册表（DESIGN §29，B 段）：**按房间装配** —— 每个包在自己的试用副本上注册，成功后那份才成为
    // 这一局的注册表，而进程级那一份（`getDefaultRegistry()`）一个键都不动（业主裁决的「禁止全局 set/restore」；
    // 多局并发时「开局前设全局、打完恢复」本来就是错的）。逐包失败**不抛**：失败的包整体回滚，其余包照旧生效。
    // W-B：房间声明了集合时，只有**它声明的那几个包**的 meta 模块参与装配（声明了才算数）。
    const roomIds = room.modSet && Array.isArray(room.modSet.packs) ? new Set(room.modSet.packs.map((p) => p && p.id)) : null;
    const metaModules = (this.workshop && Array.isArray(this.workshop.meta) ? this.workshop.meta : [])
      .filter((m) => !roomIds || (m && roomIds.has(m.pack)));
    // 包声明的**战斗逻辑**（`server.battle`, DESIGN §28.17）：与 meta 同一条口径 —— 房间声明了集合时只有它点名的包参与。
    // installer（真函数，服务端跑）与 modules（JSON 安全的 URL 清单，进 BattleSpec 让浏览器加载同一段代码）两份都过滤。
    const battleInstallers = (this.workshop && Array.isArray(this.workshop.battleInstallers) ? this.workshop.battleInstallers : [])
      .filter((m) => !roomIds || (m && roomIds.has(m.id)));
    const battleModules = (this.workshop && Array.isArray(this.workshop.battle) ? this.workshop.battle : [])
      .filter((m) => !roomIds || (m && roomIds.has(m.pack)));
    let roomRegistry = null;
    if (metaModules.length) {
      const built = buildRoomRegistry({ packs: metaModules, base: getDefaultRegistry(), log: this.log });
      roomRegistry = built.registry;
      for (const e of built.errors) this.log.warn?.(`[workshop] meta ${e.pack}: ${e.code}: ${e.reason}`);
    }
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    // 按房间物化（W-B, DESIGN §28.16）：房间声明的集合**真的决定这一局跑什么** —— 这一局拿到的游戏数据、kit 映射与
    // kit 模块清单都来自 `roomAssets.forRoom`。没声明集合（或声明了全部）时它返回的正是进程级那一份**本体**，所以
    // 那种房间与从前逐字节相同（`server/roomAssets.js`）；没有装包时 `roomAssets` 根本不存在，走原来的三个字段。
    const assets = this.workshop && this.workshop.roomAssets ? this.workshop.roomAssets.forRoom(room.modSet) : null;
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        // 「AI 队友最后选择」 (GitHub #338): fixed for the match
        aiPicksLast: room.mode !== 'solo' && room.aiPicksLast === true,
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        data: assets ? assets.data : this.safeData(),
        // 工坊行为层: the same kits must reach the battles the server runs AND the browser's (see the Lobby constructor)
        workshopKits: assets ? assets.kits : (this.workshop && this.workshop.kits ? this.workshop.kits : null),
        workshopKitModules: assets ? assets.modules : (this.workshop && Array.isArray(this.workshop.modules) ? this.workshop.modules : []),
        // …and the identity of that content, which every BattleSpec of this match carries (DESIGN §28.2). The room's own
        // set when it declared one — that IS what this match runs — else the process set, byte for byte as before.
        mods: room.modSet || this.modSet,
        // 包声明的**战斗逻辑**（`server.battle`, DESIGN §28.17）：两个字段都只在真的有包声明时出现 —— 干净安装
        // （或一个都没点名的房间）送进去的 opts 与从前逐字节相同，`Battle` 也拿不到 `battleInstallers` 这个键。
        ...(battleInstallers.length ? { battleInstallers } : {}),
        ...(battleModules.length ? { workshopBattleModules: battleModules } : {}),
        // 这一局自己的元注册表副本：**没有包声明 `server.meta` 时这个字段根本不出现**，Match 照旧用进程级那一份
        //（`opts.registry` 的缺省）—— 于是干净安装的行为与从前逐字节相同。
        ...(roomRegistry ? { registry: roomRegistry } : {}),
        log: this.log,
        now: this.now,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      // 房间级钩子（§28.20）：这一局没起来。包在 `matchStart` 里挂过一次性的东西时有这一条可以收回来 —— 而
      // 它不是 `matchEnd`：那个事件说的是「打过的一局结束了」，与一个从没开始的对局是两件事。
      this.hookFire(room, 'matchFailed', { matchNo: room.matchCount + 1, error: e && e.message ? e.message : String(e) });
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    // 房间级钩子（§28.20）：**一局真的起来了**（`match.start()` 已经跑完并且抛都没抛）。
    this.hookFire(room, 'matchStart', {
      matchNo: room.matchCount, mode: room.mode, difficulty: room.difficulty, seed,
      players: room.seats.filter(Boolean).map((s) => s.playerId),
      spectators: room.spectators.map((s) => s.playerId),
    });
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    // 房间级钩子（§28.20）：**这一局结束了**。位置在两处清理之前 —— 座位还没被腾空（`left` 的座位在下面才释放、
    // 断线的人还没进宽限），所以包拿到的还是「刚打完」的那张座位表；`disposed` 若跟着来（房间空了）是**下一个**
    // 事件，包看到的是 matchEnd → dispose 这个顺序。
    this.hookFire(room, 'matchEnd', {
      matchNo: room.matchCount,
      summary: room.lastSummary,
      victory: !!(room.lastSummary && room.lastSummary.victory),
      players: room.seats.filter(Boolean).map((s) => s.playerId),
      spectators: room.spectators.map((s) => s.playerId),
    });
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
    // 聊天回放（只给**这一个**会话）：重连的人该看到刚才房里说了什么，但别让所有人再看一遍。
    // 空房间不回放（没有内容就是没有帧，不是一条空 history）。
    if (room.chat.length) sendSession(session, { t: 'chat.history', messages: room.chat });
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
      support: session.support || null,
      ops: session.ops || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    // 房间级钩子（§28.20）：**离开**在座位真的被释放**之前**触发 —— 此刻 `by` 还是这个人的那个座位，包拿到的
    // 是「谁走了」而不是「少了一个人」。这条路径覆盖离开、踢人、观战者被移除、大厅宽限超时与连接过期（本函数
    // 是所有永久性离开的唯一出口，所以钩子也只有这一处）。`leave` 的载荷**不带房间快照**：房间正在变，快照会说谎。
    const leaving = room.hookPlayer(playerId);
    if (leaving) this.hookFire(room, 'leave', { by: leaving });
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
    // 房间级钩子（§28.20）：**最后一个事件**，放在这里而不是函数开头 —— `room.closed` 已经发给还连着的成员（他们
    // 该收的帧都收到了），而这时包仍然读得到那张座位表（座位还在数组里、只是会话已经脱离了房间）。这也是唯一一个
    // 在 `room.disposed === true` 之后触发的事件：它的意思正是「这个房间没了」。
    this.hookFire(room, 'dispose', { reason, room: room.hookSnapshot() });
    // 这个房间的钩子表随房间一起消失 —— 一张按房间码索引的表不能留住已经没了的房间（房间码会被 `genCode` 重新
    // 用掉，留下旧条目就是让下一个同码的房间继承上一个的钩子）。
    this.roomHooks.forget(room);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    const data = encode(room.toState(this.supportView()));
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  /**
   * The 助战 catalog a client may show (`supportPicker` names this as its purpose), plus the player's own current picks.
   * An operator the pool does not list is DISABLED — the picker must not be able to offer it, and the server refuses a
   * request that names it (shared/support.js checkSupport) — so this is the only way the client learns the pool.
   */
  supportView() {
    const cfg = normalizeSupportConfig(this.safeData() && this.safeData().support);
    return {
      enabled: cfg.enabled,
      label: cfg.label,
      tiers: supportPicker(cfg),
      capacity: supportCapacity(cfg),
      slots: supportTiers(cfg).reduce((o, t) => ({ ...o, [t]: cfg.slots[t] }), {}),
    };
  }

  sendState(room, session) {
    sendSession(session, room.toState(this.supportView()));
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }

  // ---------------------------------------------------------------------------------------------------
  // 包声明的**房间级钩子**（`pack.json.server.room`, DESIGN §28.20）
  //
  // 两条纪律，都写在 §28.20 里：
  //   * **观察与声明**：钩子拿到的是只读观察面，触发顺序是引擎的调用顺序，钩子的返回值一律忽略 —— 所以这一层
  //     没有任何一件能改「谁在玩 / 装了什么 / 这一局的结果」的能力（闸门分类规则见 §28.20）。
  //   * **隔离**：一个钩子抛异常只记一行 `ROOM_HOOK_THREW`（点名包 + 钩子），建房、加入、对局结束照旧完成。
  //     `dispose` 是唯一一个在房间已经 disposed 之后触发的事件 —— 它的意义正是「这个房间没了」。
  // ---------------------------------------------------------------------------------------------------

  /**
   * 触发一个房间级钩子事件。**本文件唯一的装配触点** —— 生命周期点各调它一次，怎么分发（闭枚举校验、逐钩子
   * try/catch、`ROOM_HOOK_THREW`）全在 `server/roomPack.js`。
   * @param {Room} room
   * @param {string} event
   * @param {object} [payload]
   */
  hookFire(room, event, payload = null) {
    this.roomHooks.fire(room, event, payload);
  }
}
