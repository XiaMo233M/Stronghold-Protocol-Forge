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
//   * room.create {mode, difficulty?, test?}: ▸ without a difficulty the room starts at DEFAULT_DIFFICULTY (标准) and the
//     host changes it in the room — the event's 联合模拟 creates the room first (research 06 §3.2), the starting
//     difficulty is not recorded [ASSUMED: 标准, the first one unlocked; the event room research 06 §3.2 describes shows
//     ♜ 标准模拟 in its footer pill]. The game's own lobby always sends the remembered one.
//   * Host-only: room.setDifficulty, room.setAiPicksLast, room.setSoloUnlimited, room.addBot, room.removeBot, room.kick,
//     room.start.
//     ▸ Changing the difficulty or the AI-picks-last option (co-op only) un-readies the other humans.
//     ▸ 「不限时」 (room.setSoloUnlimited { on }, DESIGN §37.23.10): a solo room of a version whose rules.soloTimed is
//       true, off by default. On, the match is built with opts.soloUnlimited (preparation and 机变 untimed — the existing
//       Match opt-out). room.state carries `soloUnlimited: true` only while it is on, so a default room.state stays
//       identical. A switch to a version whose solo is not timed clears it. A create that sends the key on a co-op room
//       or an untimed version is ignored.
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
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window (net.js
//     session.resumeWindowMs, set at every disconnect). 第一期's constData has no singleReconnectTime, so that solo
//     uses the same 24 h figure as a carried-over convenience [ASSUMED] — not because the run is untimed (a 第一期 solo
//     is timed unless the room's 「不限时」 is on, §37.23.10). Only after that does expiry turn into
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
//   * 干员皮肤 (docs/SKINS.md): room.skins { skins } — `{ [charId]: skinId }`, the appearance each operator wears — is
//     a plain map of charIds to skinIds, at most SKIN_LIMITS.entries (256 [ASSUMED]); a bad shape is BAD_MSG and does
//     not clear the stored choice. A charId the room's content does not have is dropped (shared/protocol.js
//     checkSkinSelection). An unknown skinId can do nothing worse than fail to resolve in the client's spineEntry.
//     Stored on the session and the seat. Unlike
//     the settings above there is NO phase gate: a match receives seats[].skins when it starts AND takes a later change
//     at once (match.setSkins, any phase), because the choice is public — a teammate sees your model — and cosmetic.
//     The room's members see a seat's map as room.state seats[].skins (human seats with a non-empty map only, so a room
//     without skins sends what it sent before): the waiting room's 名片干员 seat cards wear the outfit of the operator
//     they show (the maintainer's decision 4 of 2026-10-21; the client picks that operator's entry — ui/seatArt.js
//     seatCardSkin — exactly as a match card reads Match.publicView().players[].skins). A changed map is broadcast while
//     the room waits; during a match its m.public carries it, and the room.state at the match's end. [ASSUMED] The whole
//     map rides in room.state, not one skinId per card: a seat without a pick shows an operator its clients choose by
//     player id (ui/seatArt.js seatOperator), which the server does not compute.
//   * 名片干员 (PR #643 split 6): room.card { charId } — the operator whose portrait fills the player's seat card in the
//     waiting room, '' for none — is kept only when it is a visible charId of the room's chess.json (another id, a hidden
//     preset, a stand-in body or a 自选-only operator: BAD_MSG, the stored one stays). Stored on the session (it follows the player into
//     the next room) and the seat; the room's members see it as room.state seats[].card (human seats with a card only,
//     so a room without one sends what it sent before). Checked again when the player takes a seat (humanSeat): a card
//     the room's content does not have (a plugin operator picked in a room with gameplay plugins) is left off that seat
//     — the session keeps it, and the player's page sends the card it can show for the room (ui/loadoutSync.js
//     installCardSync). Cosmetic: no phase gate, never handed to a match. [ASSUMED] A card picked in this browser stands
//     in for the event's account assistant (名片形象, display_meta_table avatarTypeData ASSISTANT); the client's default
//     for a seat without one is ui/seatArt.js'.
//   * Content identity (DESIGN §32, the plugin system's first step): the lobby is given the server's vanilla content
//     (server/plugins/identity.js; none in unit tests that build a Lobby without it). Every `welcome` carries
//     `content: { vanilla: <cs> }` — and `plugins: <n>` when this server has n > 0 unofficial plugins (every class but a
//     language: the title screen's 「本服务器安装了 N 个插件」; a page fetches the catalogue only when n > 0 and something
//     needs it, so a server without plugins sends exactly what it sent before) —, every room's `room.state.content` is
//     `{ cs, vanilla: true, plugins: [] }` while it has
//     no plugin, and the match receives `cs`, which it copies into every BattleSpec (the sim never reads it;
//     diagnostics and replays name the content with it).
//   * The room's plugins (DESIGN §32 P1a — cosmetic plugins only): room.setPlugins { plugins: [{ id }] } — host-only,
//     before the match, and ▸ like a difficulty change it un-readies the other humans. The lobby asks the server's
//     visual sets (server/plugins/visualSet.js resolve: loaded cosmetic plugins of scope `room`, their requirements
//     switched on, in load order, within the size limit — PLUGIN_UNKNOWN / PLUGIN_BLOCKED / PLUGIN_DEPENDENCY /
//     PLUGIN_CONFLICT / PLUGIN_LIMIT otherwise; none given to the Lobby → PLUGIN_UNKNOWN) and the room's content becomes
//     `{ cs, vanilla: true, vs, plugins: [{ id, version, class, hash, auto? }], warnings, bytes }`: `cs` stays the vanilla
//     one — art never changes a battle, so the match, its BattleSpecs and the golden results are those of the original
//     content and ▸ such a match counts as the original game in the statistics overview (the owner's decision of
//     2026-10-13: gameplay and numbers unchanged) —, `vs` names the
//     art every member's page draws with (/vs/<vs16>/overlay.json, composed by public/js/content.js on the page's own
//     manifest). An empty list brings back
//     exactly the vanilla shape above. The set is the room's: kept across its matches and a host change, held in the
//     visual sets while the room uses it (hold / release) and gone with the room. The same set again (the same `vs`)
//     un-readies nobody; ▸ when only its 「自动」 marks changed (a plugin first switched on automatically is now chosen, or
//     the other way round) the new state is broadcast without un-readying. A request that changes nothing (the same `vs`
//     and the same marks) — or a refused one — leaves the host's result replay (a settlement screen still open:
//     dropReplay; a change is the host moving on). ▸ When a plugin of the room's set changes on disk while the room holds
//     it (the visual sets' onStale, after the registry read the folders again), the host is told once (an m.toast: apply
//     the room's plugins again — the panel's 「重新应用」 sends the same list, which resolves to the set of the files as
//     they are now) — during a match, once the room is back in its lobby (onMatchEnd), when it can be done; nothing
//     changes by itself — ▸ but in a room the plugin studio names (DESIGN §32.9: `autoApplyPlugins`, set by
//     server/studio/index.js — a room whose host is the plugin's author or whose host is its only player) the same choice
//     is applied again at once, during a match too (refreshPlugins: art never changes a battle, the `cs` stays the vanilla
//     one; nobody is un-readied), and the host is told only when that fails.
//   * Gameplay plugins (DESIGN §32.6, P1c): room.setPlugins also takes the server's content plugins (data: numbers,
//     records, modes). The lobby's `plugins` (server/plugins/roomSets.js) closes the list over its requirements, refuses
//     conflicts, other classes and scopes, what the server owner's plugins/config.json does not allow and — unless it
//     allows them — gameplay plugins made for other game versions (PLUGIN_INCOMPATIBLE), and builds the room's content set:
//     a `cs` of its own (server/plugins/contentSets.js; at most limits.maxSets such sets held by rooms at once, else
//     PLUGIN_BUSY). The room's content is then `{ cs, vanilla: false, plugins: [{ id, version, class, hash, auto? }],
//     warnings, bytes, dataBytes, vs?, modes?, modeId? }` and ▸ the room is held to it like to a visual set (holdContent /
//     releaseContent). Its members' pages load and check that set (/cs/<cs16>/…, public/js/content.js) and say so with
//     room.contentReady { cs } — `seats[].content` (and `spectators[].content`) is 'loading' | 'ready' | 'failed' in such a
//     room only, reset to 'loading' when the set changes and when the member's socket drops (a reloaded page loads it
//     again); room.ready { ready: true } and room.start wait for every player's 'ready' (CONTENT_NOT_READY). A new room
//     starts with the policy's `default` plugins (none: the original game).
//     room.setMode { modeId } (host, before the match): an official mode of the room's type sets the difficulty; a mode
//     of the room's content set (content.modes, same room type) becomes content.modeId — the match's modeId — until the
//     host picks a difficulty or the set no longer has it; ▸ like a difficulty change it un-readies the other humans.
//     The match of such a room runs in that set's match host (server/match/host/ — a child process, a worker thread with
//     SP_MATCH_HOST=worker: hosts.create — the match is a MatchProxy whose answers are Promises), with opts.cs = the set's cs, opts.requireCs (a b.result naming another
//     content is refused) and opts.vs; ▸ every message and event of such a room is handled in order, one at a time, on
//     the room's own queue (serial): a request waits for the previous one's answer. A vanilla room never queues — its
//     match is in this process and answers at once, exactly as before. A loadout, 干员持有 list or 自选 roster stored while
//     the player was in a room of another content is filtered to the room's data when its match starts (an id the set
//     does not know is dropped, the rest kept — design study §8.9), and room.loadout / room.ownership / room.diy are
//     checked against the room's own data (and its 自选 list). When the worker stops (a crash, the watchdog), the match
//     ends with summary.reason 'plugin-crash' | 'plugin-hang' | 'plugin-start' and the room is back in its lobby.
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
//     code. Before a match a player may switch to a free spectator seat if another connected human remains (a
//     disconnected seat does not count — NOT_READY 'at least one player must remain seated', so the host is never handed
//     to a seat that cannot start, kick or open a version vote). A full strip is ROOM_FULL 'no free spectator seat'; a
//     solo room stays ROOM_FULL 'solo room'. The spectator record keeps that seat's content and contentGen, so a
//     needsContent room (the lobby default, 规程) still stamps a loadout sent while watching with the room's cs. The
//     host migrates, a version vote is cancelled, and the session keeps its preferences (#76). Readiness and plugin
//     consent reset on the new seat. Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).
//   * Official versions (DESIGN §37.23, M1; shared/versions.js, server/versions.js): a room plays one official version,
//     `room.version` — room.create { version? } (omitted: the server's default version; refused VERSION_UNKNOWN when this
//     server does not enable it, VERSION_UNSUPPORTED when it does not offer the room mode, its data failed to load
//     (server/versions.js available; welcome then omits it) or the server owner's fixed plugins (plugins/config.json
//     rooms: fixed) cannot play it; a difficulty the version lacks is lowered — the highest it
//     offers below, else its lowest: 终极 → 绝境). A room of 第二期下半 (act2autochess, the code constant DEFAULT_VERSION)
//     is exactly the room of before: no new key in its room.state, its match in this process. Another version's room:
//     room.state.version, its content `{ cs: <the version's cs>, vanilla: true, version, plugins }` (official — never
//     unofficial without gameplay plugins; supported gameplay plugins compose over this base), every member's page
//     loads and checks that version's data like a gameplay plugin's set (room.needsContent: seats[].content, contentReady,
//     CONTENT_NOT_READY), room.setDifficulty / room.setMode accept only the version's modes (BAD_TARGET), settings are
//     checked against its data, and its match runs in that version's match host (server/match/host/, kind 'version':
//     opts.version, opts.requireCs) — never in this process, whose module singletons hold 第二期下半's data (INTERNAL
//     without one, unless a test gave its own MatchClass).
//     The version switch, before the match, modelled on 重刷 (server/match/match/setupVote.js): the host proposes
//     (room.proposeVersion { version }: refused NOT_IN_ROOM, SPECTATOR, NOT_HOST, ROOM_STARTED, VERSION_UNKNOWN,
//     VERSION_UNSUPPORTED — the room mode —, ALREADY, VERSION_VOTE,
//     RATE — `versionProposeGapMs` (300 ms) since the last proposal, `versionRetryMs` (5 s) after a declined or expired
//     vote [ASSUMED] —, NOT_READY — a seated human offline —, VERSION_UNSUPPORTED when the target's data failed to load,
//     and VERSION_UNSUPPORTED again when the room's plugins do not support or resolve on the target, checked last);
//     ▸ a lone active human switches at once; otherwise a vote opens: voters = the seated humans then (seat order; AI and
//     spectators never vote), the host counted as agreed, `versionVoteMs` (60 s [ASSUMED]: a room has no clock to pause,
//     unlike 重刷) to answer. room.versionVote { voteId, agree }: a decline cancels (toast to every member), the last
//     agreement switches. room.cancelVersionVote { voteId } (host). A seat taken by a human (a join, a spectator sitting
//     down), a player seat freed (leave, kick, grace timeout, expiry), a host change, a voter's socket dropping and a
//     match start void it (toast); spectators coming or going and AI seats do not. While it is open room.start,
//     room.setPlugins and room.setMode answer VERSION_VOTE. room.state.versionVote { id, proposerId, version, voters,
//     agreed, remainingMs } while open (remainingMs: a duration by the lobby's clock, never a wall clock).
//     The switch (applyVersion): room.version, the difficulty lowered as at create, the content the version's base with
//     the room's cosmetic plugins applied again (none when they do not resolve there), every member's page loading it
//     again, the other humans un-readied, the WHOLE result replay dropped (its frames name the old version's chess ids),
//     every human seat's loadout / 潜能 / 干员持有 / 自选 cleared (the pages send them again) and a seat card the version
//     lacks dropped. ▸ A setting sent in such a room before its page reported the room's content ready is kept unverified
//     (the version's chess ids are reused with other operators: chess_char_1_02 is 角峰 in 第二期, 讯使 in 第一期) — a
//     version room's match then drops that loadout's skill / module choices and that 干员持有 list whole, while 潜能 /
//     练度 and 自选 (keyed by charId) are checked again against the version's data (seatSettings); a setting checked for
//     another content keeps only the ids whose operator (charId) is the same in both data sets.

import { aiTakeover, resetAiTakeover, reconcileAiTakeover, afterReconcile } from './aiTakeover.js';
import { randomBytes, randomInt } from 'node:crypto';
import { DIFFICULTIES, ERR, MAX_SEATS, MIN_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor, maxSeatsFrom, clampSeats } from '../shared/constants.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds, checkNotOwned, checkDiyPicks, charPotentialChanges, checkSkinSelection, operatorCharIds, PACK_MSG_LIMITS, CHAT_LIMITS } from '../shared/protocol.js';
import { modSetOf, isModId, modSetDrift } from '../shared/modIdentity.js';
import { normalizeSupportConfig, checkSupport, supportPicker, supportCapacity, supportTiers } from '../shared/support.js';
import { createRoomHooks, holdDecision } from './roomPack.js';
import { encode, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { MatchmakeQueue } from './matchmaking.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { PeerRelay } from './peerRelay.js';

const VANILLA_KITTED = new Set(KITTED_CHARS);
import { isContentHash } from '../shared/plugins/identity.js';
import { ruleOption } from '../shared/plugins/rules.js';
import { msg, wireMessage } from '../shared/i18n.js';
import { DEFAULT_VERSION } from '../shared/versions.js';
import { parseTestModeEnv, testModeGate, unrecognizedTestMode } from './testMode.js';

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
  // 座位上限 (业主裁令 2026-10-12): **缺省 20 座**（`DEFAULT_MAX_SEATS`），`SP_MAX_SEATS` 可加大。
  maxSeats: maxSeatsFrom(process.env),
  queue: null,            // 野排匹配 (server/matchmaking.js MATCHMAKE_DEFAULTS): size / max / waitMs / sweepMs / difficulty
  // 房内聊天（引擎特性）允许的快捷短语 id。**唯一真源**：文案在客户端（`public/i18n/*`），服务端只认 id。
  quickPhrases: null,
  versionVoteMs: 60_000,  // an open version vote is cancelled after this long (header "Official versions") [ASSUMED]
  versionRetryMs: 5_000,  // no new version proposal this long after a declined or expired vote [ASSUMED]
  versionProposeGapMs: 300, // nor this soon after the last proposal (重刷's debounce)
  roomCode: null,         // --room-code / roomCode: a fixed alliance key for every new room (null = random per room)
});

/** The stamp of a setting a version room's page sent before it reported the room's content ready (header). */
const UNVERIFIED_CS = 'unverified';

/**
 * The difficulty of a room created without one (room.create's `difficulty` left out; see the header) [ASSUMED: 标准 —
 * the event's room is changed by its creator after 创建同盟, its starting difficulty is not recorded; the event room of
 * research 06 §3.2 shows ♜ 标准模拟 in its footer pill].
 */
export const DEFAULT_DIFFICULTY = 'FUNNY';
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
/** A match's answer to a request as the platform replies it: OK, or its error (an unknown code: INTERNAL). */
const matchAnswer = (res) => (res && typeof res === 'object' && res.error
  ? fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined)
  : OK);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             ops?: Readonly<Record<string, { potential: number, cultivate: number }>> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null,
 *             skins?: Readonly<Record<string, string>> | null,
 *             card?: string | null,
 *             content?: 'ready' | 'failed' | null, contentGen?: number, loadoutCs?: string | null, notOwnedCs?: string | null,
 *             diyCs?: string | null, consentCs?: string | null }} Seat
 *   content: a room with gameplay plugins — whether the player's page loaded and checked its content (header "Gameplay
 *   plugins"; null = still loading); contentGen: counts the seat's disconnects (a queued room.contentReady of an earlier
 *   page no longer counts); loadoutCs / notOwnedCs / diyCs: the content its settings were checked for
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

/** The operator charIds a seat card may show (room.card's whitelist, the client's picker list): the visible, non-自选
 * chess records (no hidden preset) plus the 自选编队 pool (`backups.diy.ownedPool` — operators outside the chess pool with
 * no chess record of their own; a seat card shows their portrait like any other, the roster rules of the room unchanged). */
const CARD_IDS = new WeakMap();
function cardCharIds(data) {
  if (!data || typeof data !== 'object') return new Set();
  let ids = CARD_IDS.get(data);
  if (ids) return ids;
  ids = new Set();
  const chess = data.chess && typeof data.chess === 'object' ? data.chess : null;
  if (chess) for (const c of Object.values(chess)) if (c && !c.isDiy && c.visible !== false && typeof c.charId === 'string') ids.add(c.charId);
  const pool = data.backups && typeof data.backups === 'object' && data.backups.diy && typeof data.backups.diy === 'object'
    ? data.backups.diy.ownedPool : null;
  if (Array.isArray(pool)) for (const id of pool) if (typeof id === 'string' && id) ids.add(id);
  CARD_IDS.set(data, ids);
  return ids;
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/**
 * Frozen copy of a skin selection (docs/SKINS.md), keyed by operator charId.
 *
 * A non-plain object, a key that is not a charId, a value that is not a skinId, or a map over the wire cap is refused
 * (`null` — the caller answers BAD_MSG and does not clear what is already stored). A charId `hasOperator` rejects is
 * dropped. The stored copy is then at most the operator count of the room's content, and ≤ 256 [ASSUMED].
 * @param {Record<string, string>} skins `{ [charId]: skinId }`
 * @param {(charId: string) => boolean} hasOperator
 * @returns {Readonly<Record<string, string>>|null}
 */
function freezeSkins(skins, hasOperator) {
  const res = checkSkinSelection(skins, hasOperator);
  if (!res.ok) return null;
  return Object.freeze({ ...res.skins });
}

/** Do two skin selections hold the same pairs (a resend of the same map is not broadcast again)? */
/**
 * Broadcast deliveries that did not reach every connected member: the frame object → `{ sent, dropped }`
 * (server/lobby.js broadcastRoom). A frame that missed a socket leaves that client behind the engine's incremental
 * `m.public` baseline, so the match answers with a full frame next time (`Match._notePublicDelivery`) — the reader is
 * `publicDeliveryGap` below, and nothing else in this module looks at it.
 * @type {WeakMap<object, { sent: number, dropped: number }>}
 */
const PUBLIC_DELIVERY = new WeakMap();

/** Whether a broadcast frame failed to reach at least one connected member (see PUBLIC_DELIVERY). */
export const publicDeliveryGap = (msg) => PUBLIC_DELIVERY.has(msg);

/** Deep-frozen copy of a checked 助战 selection (shared by the session, the seat and the match's PlayerState). */
function freezeSupport(entries) {
  return Object.freeze([...(entries || [])]);
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

/**
 * 两份「房间声明的模组 id 列表」是不是**同一份**（`null` = 不声明）。`resolveRoomModSet` 交给房间的列表已经排序
 * 去重，所以逐位比较就够。
 *
 * 为什么需要它：`room.mods` 要能认出「你发的就是我现在的这一份」——那不是一个变更，不该广播、不该把别人的就绪
 * 状态清掉。判的是**同一份集合**，不是同一批字节（后者是摘要的事，`modSetOf` 已经保证一致）。
 */
function sameModIds(a, b) {
  if (!a || !b) return !a && !b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameSkins(a, b) {
  const ka = a ? Object.keys(a) : [], kb = b ? Object.keys(b) : [];
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /**
   * @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now
   * @param {string} [version] the official version the room plays (header "Official versions")
   */
  constructor(code, mode, difficulty, now, seatCap = MAX_SEATS, version = DEFAULT_VERSION) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /** the official version the room plays (shared/versions.js id; header "Official versions") */
    this.version = version;
    /** 本房座位上限 (业主裁决 B5)：`MAX_SEATS` 是官方 4 座，服务器的缺省上限 20 由 Lobby 传进来 */
    this.seatCap = seatCap;
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

    /** 本房声明的模组 id 列表（已排序去重；null = 没声明集合 = 跑服务器加载的全部） */
    this.modIds = null;
    /** @type {{ digest: string, packs: Array<object> } | null} */
    this.modSet = null;
    /**
     * the open version vote, else null: `{ id, proposerId, version, voters, agreed, expiresAt, timer }`
     * @type {{ id: number, proposerId: string, version: string, voters: string[], agreed: Set<string>, expiresAt: number, timer: any } | null}
     */
    this.versionVote = null;
    /** the last vote id (room.state.versionVote.id: 1, 2, …) */
    this.versionVoteSeq = 0;
    /** the lobby clock of the last proposal, and the time before which no proposal is taken (a declined / expired vote) */
    this.versionProposeAt = -Infinity;
    this.versionRetryAt = -Infinity;
    /**
     * 「AI 队友最后选择」 (room.setAiPicksLast, GitHub #338; co-op only, off by default): the match's strategy and 机变 drafts
     * put every human seat before every AI seat (Match opts.aiPicksLast). Kept across the room's matches.
     */
    this.aiPicksLast = false;
    // [ASSUMED] Remake cooperation option, approved 2026-10-24; host opt-in before the match.
    this.aiTakeoverEnabled = false;
    /**
     * 「不限时」 (room.setSoloUnlimited, DESIGN §37.23.10; a timed solo only, off by default): the match is built with
     * opts.soloUnlimited. room.state omits the key unless this is true.
     */
    this.soloUnlimited = false;
    /**
     * The official mode of a laddered room (header "Official versions": 规程's solo plays 规程等级 1–20 and 极速模拟, more
     * modes than one per difficulty — versions.laddered); null elsewhere, where the difficulty names the mode. room.state
     * omits the key while null.
     * @type {string | null}
     */
    this.modeId = null;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(this.seatCap).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean, content?: 'ready' | 'failed' | null, contentGen?: number }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
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
    /** @type {string[] | null} plugins of the room's set that changed on disk — the host not told yet (Lobby.pluginsChanged) */
    this.pluginsChanged = null;
    this.pluginNoticeKeys = {};
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    this.disposed = false;
    /**
     * The content set the room plays (DESIGN §32): `{ cs, vanilla, plugins }` — the server's vanilla set, or with the
     * cosmetic plugins its host switched on (header "The room's plugins": `vs`, `warnings`, `bytes` beside them), or a
     * content set with gameplay plugins (header "Gameplay plugins": `vanilla: false`, its own cs, `dataBytes`, `modes`,
     * `modeId`); null when the lobby has no content identity (room.state then carries none).
     * @type {Readonly<{ cs: string, vanilla: boolean, plugins: readonly object[], vs?: string, warnings?: readonly object[],
     *   bytes?: number, dataBytes?: number, modes?: readonly object[], modeId?: string }> | null}
     */
    this.content = null;
    /** Test room (DESIGN §34.8). Set only at create, and only when the process switch is on. Never flipped later. */
    this.test = false;
    /** the room's queue (header "Gameplay plugins": Lobby.serial): what is still waiting or running, and its tail */
    this.queue = { pending: 0, tail: Promise.resolve() };
  }

  /** Does the room play a content set with gameplay plugins (its own cs; header "Gameplay plugins")? */
  /**
   * 往环形缓冲里放一条（超出上限就丢最旧的）。
   * @param {object} frame 已塑形的 `chat.msg` 帧
   */
  addChat(frame) {
    this.chat.push(frame);
    if (this.chat.length > CHAT_LIMITS.history) this.chat.splice(0, this.chat.length - CHAT_LIMITS.history);
    return this.chat.length;
  }

  get modded() { return !!this.content && this.content.vanilla === false; }

  /**
   * Must every member's page load and check the room's content before ready / start (header "Gameplay plugins",
   * "Official versions")? A set with gameplay plugins, or another official version than 第二期下半.
   */
  get needsContent() { return this.modded || this.version !== DEFAULT_VERSION; }

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

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean, content?: 'ready' | 'failed' | null, contentGen?: number } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /**
   * `room.state` frame (DESIGN §8.1) plus `inMatch`.
   * @param {number} [now] the lobby's clock (an open version vote's remainingMs)
   */
  /** Every seat that holds somebody, AI included, in seat order (`left` seats are still IN the room). @returns {Seat[]} */
  occupiedSeats() { return this.seats.filter(Boolean); }

  /**
   * 本房座位上限 (业主裁决 B5, docs/META.md §1.9): resize this room's seat array — the ONLY way `seats` ever changes
   * length (`Room` deliberately never resizes it anywhere else, and a running match holds its own copy of the seats, so
   * this never touches a match in progress).
   *
   * 不变量：**绝不挤掉任何人**。调用方（`Lobby.setSeatCap`）已经证明没有任何**非空**座位落在新上限之外，这里再自己
   * 校一遍 —— 因为「缩容丢人」这种错误一旦发生就是静默的（数组短了，人不见了，谁也不报错），而这次的防线只有几行
   * 代码，值得重复一次。任何非空座位会被丢掉时**整个调用什么都不做**（数组、`seatCap` 都不变），调用方的前置校验
   * 保证这条分支不可达。
   *
   * @param {number} cap the new seat count (an integer ≥ 1)
   * @returns {number} the room's seat cap after the call (unchanged when nothing was done)
   */
  seatCapTo(cap) {
    if (!Number.isInteger(cap) || cap < 1 || cap === this.seatCap) return this.seatCap;
    const next = this.seats.slice(0, cap);
    while (next.length < cap) next.push(null);
    if (next.filter(Boolean).length !== this.occupiedSeats().length) return this.seatCap; // would evict someone
    this.seats = next;
    this.seatCap = cap;
    return this.seatCap;
  }

  toState(support = null, now = Date.now()) {
    return {
      t: 'room.state',
      ...(this.aiTakeoverEnabled ? { aiTakeoverEnabled: true, aiTakeoverVotes: this.aiTakeoverVotes || [] } : {}),
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      aiPicksLast: this.aiPicksLast,
      // 房内聊天模式：客户端据此决定要不要显示输入框。**服务端强制**（`chat` / `quickMsg` 各自再判一次）。
      chatMode: this.chatMode,
      // 本房声明的模组集合（W-A, DESIGN §28.9）：形状与 `welcome.mods` 相同；没声明就**不带这个键**
      ...(this.modSet ? { mods: this.modSet } : {}),
      /**
       * 座位容量 (100 人版移植)：**只在容量 ≠ `MAX_SEATS` 时出现**，所以一个官方 4 座房的帧逐字节不变。
       * 客户端按它补齐座位卡（`public/js/screens/room.js normalizeSeats`）。
       */
      ...(this.seatCap !== MAX_SEATS ? { seatCap: this.seatCap } : {}),
      // 服务器声明的助战目录（客户端推不出来，所以只有服务端能给）
      ...(support && typeof support === 'object' ? { support } : {}),
      inMatch: !!this.match,
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left,
          // a room with gameplay plugins (header "Gameplay plugins"): has this player's page loaded and checked its content?
          ...(this.needsContent && !s.isBot ? { content: s.content || 'loading' } : {}),
          // 名片干员 (room.card): only a human seat with a card carries the key
          ...(!s.isBot && s.card ? { card: s.card } : {}),
          // 干员皮肤 (room.skins, PUBLIC like Match.publicView().players[].skins): the seat card's outfit (header);
          // only a human seat with a non-empty map carries the key
          ...(!s.isBot && s.skins && Object.keys(s.skins).length ? { skins: s.skins } : {}),
          // 外观选择（皮肤层，docs/SKINS.md）：**别人看到的你** —— `{ picks?, avatar? }`（见 `appearance()`）；
          // 不带这个键的座位逐字节不变（干净安装 / 没选过的玩家都不带）。
          ...(s.appearance && Object.keys(s.appearance).length ? { appearance: s.appearance } : {}) }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected, ...(this.needsContent ? { content: /** @type {any} */ (s).content || 'loading' } : {}) })),
      ...(this.content ? { content: this.content.trusted ? {...this.content, trusted:{...this.content.trusted, consent:Object.fromEntries(this.seats.filter(x => x && !x.isBot).map(x => [x.seat,x.consentCs === this.content.cs]))}} : this.content } : {}),
      // another official version than 第二期下半, and its open vote (header "Official versions"): omitted otherwise, so a
      // default room's room.state stays identical
      ...(this.version !== DEFAULT_VERSION ? { version: this.version } : {}),
      ...(this.versionVote ? { versionVote: { id: this.versionVote.id, proposerId: this.versionVote.proposerId, version: this.versionVote.version,
        voters: [...this.versionVote.voters], agreed: this.versionVote.voters.filter((id) => this.versionVote?.agreed.has(id)),
        remainingMs: Math.max(0, Math.round(this.versionVote.expiresAt - now)) } } : {}),
      // omitted when false so a normal room.state stays identical
      ...(this.test ? { test: true } : {}),
      // 「不限时」 (header): omitted unless on, so a default room.state stays identical
      ...(this.soloUnlimited === true ? { soloUnlimited: true } : {}),
      // a laddered room's official mode (规程's solo): omitted elsewhere, so a default room.state stays identical
      ...(this.modeId ? { modeId: this.modeId } : {}),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
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

export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   content?: { cs: string } | null,
   *   plugins?: { resolve: (ids: string[], opts?: { scope?: 'room' | 'personal', settings?: object, replacing?: object | null, version?: string }) => any,
   *     hold?: (vs: string) => void, release?: (vs: string) => void, holdContent?: (cs: string) => void,
   *     releaseContent?: (cs: string) => void, onContentStale?: (fn: (cs: string, ids: string[]) => void) => () => void, onStale?: (fn: (vs: string, ids: string[]) => void) => () => void,
   *     unofficial?: () => number, hasNotices?: () => boolean, defaults?: () => string[], defaultsFor?: (version: string) => { ids: string[], skipped: string[] }, dataOf?: (cs: string) => any, kittedOf?: (cs: string) => any,
   *     contentInUse?: () => number } | null,
   *   hosts?: { create: (cs: string, opts: object) => any, stats?: () => object } | null,
   *   versions?: ReturnType<typeof import('./versions.js').createVersionSets> | null,
   *   versionHosts?: { create: (cs: string, opts: object) => any, stats?: () => object } | null,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   *   content: the server's vanilla content (server/plugins/identity.js; header "Content identity"); plugins: what a host
   *   chooses from — the room's sets (server/plugins/roomSets.js: visual sets and content sets; header "The room's
   *   plugins", "Gameplay plugins"); hosts: the match hosts a room with gameplay plugins runs its match in
   *   (server/match/host/index.js; none: such a match runs here, unit tests); versions: the official versions this server
   *   offers (server/versions.js; none: 第二期下半 alone — header "Official versions"); versionHosts: the match hosts of
   *   the other versions (server/match/host/index.js, kind 'version')
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, content = null, plugins = null, hosts = null,
    versions = null, versionHosts = null, simPool = null, records = null, workshop = null, options = {} }) {
    this.registry = registry;
    /** the vanilla content set every room plays (header "Content identity"), or null */
    this.vanilla = content && isContentHash(content.cs) ? Object.freeze({ cs: content.cs, vanilla: true, plugins: Object.freeze([]) }) : null;
    /** the server's room sets — visual and content (header "The room's plugins", "Gameplay plugins"), or null */
    this.plugins = plugins;
    /** the match hosts (header "Gameplay plugins"), or null */
    this.hosts = hosts;
    /** the official versions this server offers and their match hosts (header "Official versions"), or null */
    this.versions = versions;
    this.versionHosts = versionHosts;
    /**
     * The server's own simulation pool for bot rehearsals (server/workers/roomPool.js), or null when the operator
     * started none — then every rehearsal stays on this thread, exactly as before.
     */
    this.simPool = simPool;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    const testModeOpt = options.testMode;
    const testHostOpt = options.testHost;
    if (Object.hasOwn(options, 'testMode') || Object.hasOwn(options, 'testHost')) {
      options = { ...options };
      delete options.testMode;
      delete options.testHost;
    }
    this.opts = { ...LOBBY_DEFAULTS, ...options };

    /**
     * 对局战绩（`SP_ACCOUNTS=1`, server/matchRecords.js）：每局**完整结算**时落一条。`null` ⇒ 结算点不落盘。
     * @type {import('./matchRecords.js').MatchRecords | null}
     */
    this.records = records;
    /**
     * 工坊行为层 (docs/WORKSHOP.md §4)：`{ kits, modules, panels, mods, roomAssets, ... }`。null = 干净安装。
     */
    this.workshop = workshop && typeof workshop === 'object' ? workshop : null;
    /**
     * 包声明的**房间级钩子**总线（`pack.json.server.room`, DESIGN §28.20）：`workshop.roomHooks` 是启动时
     * `server/roomPack.js loadRoomInstallers` 交出来的真函数（每个包一个 `install(room)`），这里包成一张
     * **按房间**留表的 bus（W-B：声明了集合的房间只装它点名的包）。一个包都没声明时是空数组 ⇒ `install` /
     * `fire` 都早退，房间的每一步与从前逐字节相同。
     */
    this.roomHooks = createRoomHooks({
      installers: this.workshop && Array.isArray(this.workshop.roomHooks) ? this.workshop.roomHooks : [],
      log: this.log,
      now: this.now,
    });

    /**
     * 包通道白名单（docs/WORKSHOP.md §1.9.6）：`<包id>` → 这个包声明过的通道名集合，由**面板清单**推出来。
     * @type {Map<string, Set<string>>}
     */
    this.packChannels = new Map();
    for (const panel of (this.workshop && Array.isArray(this.workshop.panels) ? this.workshop.panels : [])) {
      if (!panel || typeof panel.pack !== 'string' || !Array.isArray(panel.messages)) continue;
      if (!this.packChannels.has(panel.pack)) this.packChannels.set(panel.pack, new Set());
      for (const channel of panel.messages) this.packChannels.get(panel.pack).add(channel);
    }
    /**
     * 包通道的**投递面**（`server.modules[].channels`）：`<包id>` → 该包服务端模块声明过的接收通道集合。
     * @type {Map<string, Set<string>>}
     */
    this.serverChannels = new Map();
    const declaredServerChannels = this.workshop && this.workshop.serverChannels;
    if (declaredServerChannels instanceof Map) {
      for (const [packId, channels] of declaredServerChannels) {
        if (typeof packId === 'string' && channels) this.serverChannels.set(packId, new Set(channels));
      }
    }
    /**
     * 快捷短语的服务端白名单（`room.quickMsg`）：表里没有的 id 一律点名拒绝。
     * @type {Set<string>}
     */
    /**
     * What this server is running, as one identity (DESIGN §28.2): `{ digest, packs }`，null = 干净安装。
     * 摘要随 `welcome` 下发，且 `room.create` / `room.join` 在非原生房间里必须回它。
     * @type {{ digest: string, packs: Array<object> }|null}
     */
    this.modSet = modSetOf(Array.isArray(this.workshop?.mods) ? this.workshop.mods : []);
    /** 野排匹配（server/matchmaking.js）：`room.queue` / `room.dequeue` 的全部状态都在它里面 */
    this.matchmake = new MatchmakeQueue(this, this.opts.queue || undefined);
    this.quickPhrases = new Set(
      Array.isArray(this.opts.quickPhrases) ? this.opts.quickPhrases : DEFAULT_QUICK_PHRASES,
    );
    // A fixed alliance key (--room-code / roomCode): every room this process creates uses it. server/index.js parses
    // the argument once at startup; a test passes it directly. Nothing is read from the environment or persisted.
    if (this.opts.roomCode) {
      // The fixed key is an admission secret: ordinary room lifecycle logs must not expose it either.
      const key = this.opts.roomCode;
      this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level,
        (...args) => log[level]?.(...args.map(value => typeof value === 'string' ? value.split(key).join('[fixed room]') : value)),
      ]));
    }
    // Test rooms stay off until the bound address is known (setTestHost). An empty host fails closed, so a
    // server that is about to bind 0.0.0.0 does not briefly accept test rooms on the default. [ASSUMED] the
    // env words are parsed in server/testMode.js.
    const rawMode = testModeOpt != null ? testModeOpt : (typeof process !== 'undefined' && process.env ? process.env.SP_TEST_MODE : undefined);
    this.testMode = parseTestModeEnv(rawMode);
    this.testUnrecognized = unrecognizedTestMode(rawMode);
    this.testHost = '';
    this.testEnabled = false;
    this.testWarn = this.testUnrecognized;
    if (testHostOpt != null) this.setTestHost(testHostOpt);
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    this.peerRelay = new PeerRelay({ now, log });
    this.publicDeliveries = new WeakMap();
    /** log lines said once (warnOnce) */
    this.told = new Set();
    /** a held visual set whose plugins changed on disk: its rooms' hosts are told (header "The room's plugins") */
    this.offStale = typeof plugins?.onStale === 'function' ? plugins.onStale((vs, ids) => this.pluginsChanged(vs, ids)) : null;
    /**
     * Whether a room applies a change of its plugins on disk by itself (header "The room's plugins"): `({ code, hostId,
     * humans, inMatch }) => boolean`, set by the plugin studio (server/studio/index.js); null — every host is told.
     * @type {((room: { code: string, hostId: string, humans: number, inMatch: boolean }) => boolean) | null}
     */
    this.autoApplyPlugins = null;
    this.offContentStale = plugins?.onContentStale?.((cs, ids) => this.pluginsChanged(cs, ids, 'content')) || null;
  }

  /**
   * The address this process bound. Test rooms stay disabled until this runs. `host` empty fails closed.
   * @param {string} host
   * @returns {{ enabled: boolean, warn: string|null }}
   */
  setTestHost(host) {
    this.testHost = typeof host === 'string' ? host : '';
    const gate = testModeGate(this.testMode, this.testHost);
    this.testEnabled = gate.enabled === true;
    this.testWarn = this.testUnrecognized || gate.warn;
    return { enabled: this.testEnabled, warn: this.testWarn };
  }

  /**
   * The plugins `ids` of the visual set `vs` changed on disk: the host of every room using it is told to apply the room's
   * plugins again (header "The room's plugins") — a host offline now misses it; the panel's 「重新应用」 is always there.
   * @param {string} vs @param {string[]} ids
   */
  pluginsChanged(vs, ids, kind = 'visual') {
    for (const room of this.rooms.values()) {
      if (room.disposed || (kind === 'content' ? room.content?.cs : room.content?.vs) !== vs) continue;
      const noticeKey = `${room.content?.cs}|${room.content?.vs || ''}`;
      if (room.pluginNoticeKeys[kind] === noticeKey) continue;
      // the plugin studio's rooms (the author hosts, or plays alone): the same choice again at once (refreshPlugins)
      let auto;
      try { auto = !!this.autoApplyPlugins?.({ code: room.code, hostId: room.hostId, humans: room.activeHumans().length, inMatch: !!room.match }); } catch { auto = false; }
      if (kind === 'visual' && auto && this.refreshPlugins(room)) continue;
      room.pluginNoticeKeys[kind] = noticeKey;
      this.log.info(`[lobby] ${room.code} plugins changed on disk: ${ids.join(', ')} — the host is asked to apply them again`);
      // during a match the panel cannot change them: the host hears it once the room is back in its lobby (onMatchEnd)
      room.pluginsChanged = [...new Set([...(room.pluginsChanged || []), ...ids])];
      if (!room.match) this.tellPluginsChanged(room);
    }
  }

  /**
   * Apply a room's plugins again as they are on disk now (header "The room's plugins": the plugin studio's rooms) — the
   * plugins its host chose (not the 「自动」 ones), resolved again (resolveContent); the room's content becomes the new set,
   * held in its place, and every member hears it. Allowed during a match: a cosmetic set never changes a battle (the `cs`
   * stays the vanilla one) and nobody is un-readied. Only a room of cosmetic plugins: one with gameplay plugins (DESIGN
   * §32.6) would get another `cs` — every page loads and checks it again, the players are un-readied, a match keeps its
   * set — so its host is told instead, as is the host of a room whose plugins would now make one. Whether it worked
   * (false: the host is told).
   * @param {Room} room
   */
  refreshPlugins(room) {
    const before = room.content;
    if (!before?.vs || before.vanilla === false || !this.vanilla || !this.plugins) return false;
    const ids = before.plugins.filter((p) => !p.auto).map((p) => p.id);
    const r = this.resolveContent(room, ids);
    if (!('content' in r) || !r.content) { this.log.info(`[lobby] ${room.code} plugins changed on disk and no longer apply: ${'detail' in r && r.detail ? r.detail : ('error' in r ? r.error : '?')}`); return false; }
    const next = r.content;
    if (next.vanilla === false || !next.vs) return false;
    room.pluginsChanged = null;
    if (next.vs === before.vs) return true;
    room.content = next;
    this.holdContent(next);
    this.releaseContent(before);
    this.log.info(`[lobby] ${room.code} plugins applied again: ${next.plugins.map((p) => `${p.id}@${p.version}`).join(', ')}`);
    this.broadcastState(room);
    return true;
  }

  /** Tell the host of `room` that its plugins changed on disk (pluginsChanged), once. @param {Room} room */
  tellPluginsChanged(room) {
    const ids = room.pluginsChanged;
    room.pluginsChanged = null;
    // the room's set changed since (re-applied, switched off): nothing to tell
    if (!ids || !room.content?.plugins?.length) return;
    const names = ids.slice(0, 8).join('、');
    this.sendToPlayer(room, room.hostId, { t: 'm.toast', kind: 'warn', ...wireMessage(msg('房间插件「{names}」的文件在服务器上变了，请在插件面板中点「重新应用」', { names })) });
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Counters for /healthz. */
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
    // `/healthz` 要能被人拿去写报告：这一台服务器跑的是哪一份模组字节（`mods` = 摘要，`modPacks` = 包 id 清单）。
    // 干净安装（没有包）就不带这两个键 —— 与 `welcome.mods` 同一条「不声明就没有」的纪律。
    return { rooms: this.rooms.size, matches, humans, bots, spectators, ...this.matchmake.stats(),
      ...(this.modSet ? { mods: this.modSet.digest, modPacks: this.modSet.packs.length } : {}) };
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
   * Validated client message from an identified session. A room whose match runs in a match host handles its
   * messages one at a time, in order (serial; header "Gameplay plugins"): the answer is then a Promise (server/net.js
   * replies when it settles).
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string } | Promise<{ ok: true } | { error: string, detail?: string }>}
   */
  onMessage(session, msg) {
    // Transport handshakes/leases belong to the live socket, independently of a plugin match's IPC queue.
    // In particular, an old queued enable must never opt a replacement socket into peer delivery.
    if (msg?.t === 'p2p.enable' || msg?.t === 'p2p.signal' || msg?.t === 'p2p.ready') return this.handleMessage(session, msg);
    const room = this.queuedRoom(session);
    if (!room) return this.handleMessage(session, msg);
    // a queued room.contentReady speaks for the page that sent it: the seat and its generation now — a disconnect in
    // between bumps it, and the page that comes back checks the set again (contentReady)
    const ctx = msg && msg.t === 'room.contentReady' ? { from: this.seatGen(room, session.playerId) } : null;
    return this.serial(room, () => this.handleMessage(session, msg, ctx));
  }

  /** A seat (or spectator seat) of `room` and its content generation (header "Gameplay plugins"), or null. */
  seatGen(room, playerId) {
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    return seat ? { seat, gen: seat.contentGen || 0 } : null;
  }

  /**
   * The room of `session` when its messages go through the room's queue: its match runs in a match host
   * (MatchProxy `hosted`), or something of the room is still pending. Null for every vanilla room.
   * @param {import('./net.js').Session} session
   */
  queuedRoom(session) {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : null;
    return room && !room.disposed && (room.queue.pending > 0 || room.match?.hosted === true) ? room : null;
  }

  /**
   * Run `fn` on the room's queue (header "Gameplay plugins"): at once when nothing of the room is pending — a synchronous
   * answer stays synchronous —, else after everything before it has settled. An answer that is a Promise keeps the room's
   * queue busy until it settles.
   * @template T
   * @param {Room} room @param {() => T} fn
   * @returns {T | Promise<Awaited<T>>}
   */
  serial(room, fn) {
    const q = room.queue;
    if (q.pending === 0) {
      const r = fn();
      if (!r || typeof /** @type {any} */ (r).then !== 'function') return r;
      q.pending++;
      const done = Promise.resolve(r).finally(() => { q.pending--; });
      q.tail = done.then(() => {}, () => {});
      return /** @type {any} */ (done);
    }
    q.pending++;
    const done = q.tail.then(() => fn()).finally(() => { q.pending--; });
    q.tail = done.then(() => {}, () => {});
    return /** @type {any} */ (done);
  }

  /** An event of the room (a disconnect, a resync, an expiry) on its queue: nothing waits for it; a failure is logged. */
  queueEvent(room, fn) {
    let r;
    try { r = this.serial(room, fn); } catch (e) { this.log.error(`[lobby] ${room.code} a room event failed`, e); return; }
    if (r && typeof r.then === 'function') r.then(null, (e) => this.log.error(`[lobby] ${room.code} a room event failed`, e));
  }

  /**
   * One message (onMessage), now. `ctx`: what onMessage noted when it queued the message (a contentReady's seat
   * generation), else null.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  handleMessage(session, msg, ctx = null) {
    switch (msg.t) {
        // 上局战绩（server/matchRecords.js, docs/RECORDS.md）：空消息，回执是**只发给请求者**的
      // `records.latest`。没有 `records` 时照样回一条 `record: null` —— 客户端因此不需要「服务器有没有开这个
      // 功能」这件事，它只会看到「暂无完整对局战绩」。可见档位：请求者就是 playerId 的持有者 ⇒ `OWNER`。
      case 'records.mine':
        sendSession(session, { t: 'records.latest', record: this.records ? this.records.latestPlayer(session.playerId) : null });
        return OK;
      // 房间内改本房间的模组集合（G1/G2，docs/WORKSHOP.md §1.9.3）：房主、开局前、且没有真人已就绪
      case 'room.mods': return this.setRoomMods(session, msg);
      case 'room.support': return this.support(session, msg);
      // 外观选择（皮肤层）：别人看到的你长什么样 —— 纯展示，比赛中也接受，变更即广播
      case 'room.appearance': return this.appearance(session, msg);
      // 野排匹配 (quick match): the queue lives in server/matchmaking.js; these two cases are its only entry points
      case 'room.queue': return this.matchmake.join(session, msg);
      case 'room.dequeue': return this.matchmake.leave(session);
      // 房内聊天（引擎特性）：打字与快捷短语，形状由 shared/protocol.js 判死，能不能说由这里裁决
      case 'room.chat': return this.chat(session, msg);
      case 'room.quickMsg': return this.quickMsg(session, msg);
      case 'pack.msg': return this.packMsg(session, msg);

    case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setSeatCap': return this.setSeatCap(session, msg);
      case 'room.setAiPicksLast': return this.setAiPicksLast(session, msg);
      case 'room.setSoloUnlimited': return this.setSoloUnlimited(session, msg);
      case 'room.setAiTakeover': return this.setAiTakeover(session, msg);
      case 'room.aiRequest':
      case 'room.aiVote': return aiTakeover(this, session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.rerollSetup': return this.rerollSetup(session, msg);
      case 'room.cancelReroll': return this.rerollSetup(session, msg, true);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'room.skins': return this.skins(session, msg);
      case 'room.card': return this.card(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      case 'room.setPlugins': return this.setPlugins(session, msg);
      case 'room.setMode': return this.setMode(session, msg);
      case 'room.contentReady': return this.contentReady(session, msg, ctx);
      case 'room.consent': return this.consent(session,msg);
      case 'room.proposeVersion': return this.proposeVersion(session, msg);
      case 'room.versionVote': return this.versionVote(session, msg);
      case 'room.cancelVersionVote': return this.cancelVersionVote(session, msg);
      // A client that missed a state-delta frame asks for a full one (shared/stateDelta.js StateReceiver; server/net.js
      // throttles it like the other resend-heavy intents). This is the same heavy resync a repeated hello runs, so it
      // draws from the same per-session budget: the match resends its full state, or the lobby its room state.
      case 'state.resync': return this.resync(session, true) ?? { ok: true };
      case 'p2p.enable': {
        this.peerRelay.enable(session, msg.enabled);
        const room = this.roomOf(session);
        if (room) this.peerRelay.sync(room, [...this.memberSessions(room)], session);
        else sendSession(session, { t: 'p2p.config', enabled: false });
        return OK;
      }
      case 'p2p.signal':
      case 'p2p.ready': {
        const room = this.roomOf(session);
        if (!room) return fail(ERR.NOT_IN_ROOM);
        this.peerRelay.sync(room, [...this.memberSessions(room)]);
        return msg.t === 'p2p.signal' ? this.peerRelay.signal(room, session, msg) : this.peerRelay.ready(room, session, msg);
      }
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGameNow(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.matchmake.onDisconnect(session);
    this.peerRelay.disconnect(session);
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs(room) : null;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // the page may come back as a new one (a reload): it loads and checks the room's content again (header "Gameplay
    // plugins") — and a room.contentReady of the page that went, still on the room's queue, no longer counts (seatGen)
    if (room.needsContent) seat.content = null;
    seat.contentGen = (seat.contentGen || 0) + 1;
    // a voter's socket dropped: the version vote is void (header "Official versions")
    if (player && room.versionVote?.voters.includes(session.playerId)) this.voidVersionVote(room, 'members');
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) {
      if (player) {
        // a match in a match host hears it in order with the room's messages (header "Gameplay plugins") — not at
        // all when the player is back by then (the resync after the reconnect tells it onReconnect)
        if (this.queuedRoom(session)) this.queueEvent(room, () => { if (!session.connected) this.callMatch(room, 'onDisconnect', session.playerId); });
        else this.callMatch(room, 'onDisconnect', session.playerId);
      }
    } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    this.matchmake.onExpire(session.playerId);
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    const room = code ? this.rooms.get(code) : null;
    // in order with the room's messages when its match runs in a match host (header "Gameplay plugins")
    if (room && this.queuedRoom(session)) {
      this.queueEvent(room, () => { if (session.roomCode === code) session.roomCode = null; this.removeMember(room, session.playerId); });
      return;
    }
    session.roomCode = null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    this.matchmake.shutdown();
    this.offStale?.();
    this.offContentStale?.();
    this.offStale = null;
    this.offContentStale = null;
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
    this.peerRelay.dispose();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty: asked, test, version: askedVersion, soloUnlimited, modeId: askedMode,
    mods, modIds, chatMode, seatCap } = {}) {
    // A test room exists only when the process switch allowed it. The check runs before the room is built.
    if (test === true && this.testEnabled !== true) return fail(ERR.TEST_DISABLED);
    // 进程集合（W-A）：客户端报的摘要必须就是这台机器今天装载的那一份，否则 MOD_SET_LOCKED / MOD_UNKNOWN。
    const modGate = this.checkModSet({ mods });
    if (!modGate.ok) return modGate;
    // 本房自己声明的集合：每个 id 都必须指向**这台服务器装载过**的包，拒绝时同时说出「没找到什么」与「这里有什么」——
    // 客户端猜不出一个服务器跑不了的集合。不发 / `[]` = 今天的默认（房间不声明，`room.state` 不带 `mods`）。
    const roomMods = resolveRoomModSet(Array.isArray(modIds) ? modIds : [], this.workshop?.mods);
    if (!roomMods.ok) {
      const unknown = roomMods.unknown.length ? roomMods.unknown.join(', ') : '(none)';
      const available = roomMods.available.length ? roomMods.available.join(', ') : '(none)';
      return fail(ERR.MOD_UNKNOWN, `this server does not run the mod pack(s) (${unknown}); available: ${available}`);
    }
    // the official version (header "Official versions"): left out, the server's default
    const version = askedVersion ?? this.defaultVersion();
    if (!this.versionEnabled(version)) return fail(ERR.VERSION_UNKNOWN);
    if (!this.offered(version, mode).length) return fail(ERR.VERSION_UNSUPPORTED, `${version} has no ${mode} rooms`);
    if (!this.versionAvailable(version)) return fail(ERR.VERSION_UNSUPPORTED, 'the data of this version is not available');
    // left out: the default (header); the protocol refuses any other value that is not a difficulty; one the version
    // lacks is lowered (终极 → 绝境)
    const difficulty = this.fallbackDifficulty(version, mode, DIFFICULTIES.includes(asked) ? asked : DEFAULT_DIFFICULTY);
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    // The room being left disappears with this create when the creator is its only human (a spectator is none).
    const leaving = !!cur && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId);
    if (key && this.opts.maxRoomsPerAddr > 0) {
      if (this.countRooms((r) => r.ownerKey === key) - (leaving && cur.ownerKey === key ? 1 : 0) >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    // A fixed key (--room-code) can only belong to one room. This player's own room may hold it and can be left
    // below (then the key is free again); any other room — or a room this session only watches as a spectator —
    // keeps it, and the create is refused before anything is removed.
    const fixed = this.opts.roomCode || null;
    const fixedIsMine = !!fixed && !!cur && this.rooms.get(fixed) === cur;
    if (fixed) {
      const taken = this.rooms.get(fixed);
      const mine = cur && cur.seatOf(session.playerId);
      const onlyMe = mine && cur.activeHumans().length === 1;
      if (taken && !(taken === cur && onlyMe)) {
        return fail(ERR.ROOM_CODE_TAKEN, 'the fixed alliance key is in use');
      }
    }
    // Treat this sole-human room as yielding its key, but keep membership until all content/version checks pass.
    const code = this.genCode(fixedIsMine ? cur : null);
    if (!code) return fixed ? fail(ERR.ROOM_CODE_TAKEN, 'the fixed alliance key is in use')
      : fail(ERR.INTERNAL, 'no room code available');
    // the server owner's default plugins (plugins/config.json `default`; header "Gameplay plugins"): none — the original
    // game. Keep the defaults that support the room's official version; fixed rooms must support the entire list. Resolved
    // before the creator leaves the old room (a refusal keeps them there), so a set that room alone holds counts as freed
    // (limits.maxSets), as when the room went first before M1
    let initial = this.baseContent(version);
    const selected = this.plugins?.defaultsFor?.(version);
    const defaults = selected?.ids || this.plugins?.defaults?.() || [];
    if (selected?.skipped.length) this.warnOnce(`[lobby] default plugins (${selected.skipped.join(', ')}) do not support ${version}: skipped`);
    if (defaults.length) {
      const r = this.resolveContent(null, defaults, {}, version, leaving ? cur.content : null);
      if ('error' in r) {
        const fixed = (() => { try { return this.plugins?.fixed?.() || null; } catch { return null; } })();
        if (fixed && fixed.length && r.error === ERR.VERSION_UNSUPPORTED) return r;
        this.warnOnce(`[lobby] the default plugins (${defaults.join(', ')}) cannot be applied${version !== DEFAULT_VERSION ? ` to ${version}` : ''}: ${r.error}${r.detail ? ` (${r.detail})` : ''}`);
      } else initial = r.content;
    }
    if (cur) this.removeMember(cur, session.playerId);
    // 本房座位上限 (业主裁决 B5, docs/META.md §1.9)：房主建房时自己选这一个房间开几张座位卡。
    // 两层：① `shared/protocol.js` 已在线上判过 `seatCap ∈ [MIN_SEATS, SEAT_CAP]`；② 这里再钳一次，给不走协议
    // 的调用方（快速匹配、包钩子、测试）兜底 —— 房间建出来座位数就定死（`Room` 从不 resize）。
    // 只作用于 co-op：solo 房照旧按 `this.opts.maxSeats` 建数组，改掉它会移动每一个 solo 帧。
    const roomCap = mode === 'coop' && seatCap != null ? clampSeats(seatCap, this.opts.maxSeats) : this.opts.maxSeats;
    const room = new Room(code, mode, difficulty, this.now(), roomCap, version);
    // a laddered version (规程's solo): the asked official mode, else the first of the difficulty (标准 → 规程等级1); the
    // room's difficulty follows the mode (极速模拟's FAST counts as 标准)
    if (this.laddered(version, mode)) {
      room.modeId = this.ladderMode(version, mode, difficulty, askedMode ?? null);
      const m = this.versionModes(version, mode).find((x) => x.id === room.modeId);
      if (m) room.difficulty = DIFFICULTIES.includes(m.difficulty) ? m.difficulty : 'FUNNY';
    }
    room.test = test === true;
    // 「不限时」 only on a solo room of a version whose solo is timed (header). Anywhere else the key is ignored, so a
    // stray true cannot change a default or co-op create.
    if (mode === 'solo' && soloUnlimited === true && this.versionSoloTimed(version)) room.soloUnlimited = true;
    room.content = initial;
    if (initial !== this.baseContent(version)) this.holdContent(initial);
    room.ownerKey = key;
    // 本房声明的模组集合（W-A）：`modIds` 排序去重后存快照，`modSet` 是拿它算出来的身份；null = 不声明。
    room.modIds = roomMods.modIds.length ? roomMods.modIds : null;
    room.modSet = roomMods.modSet;
    if (room.modSet && this.workshop && this.workshop.roomAssets) this.workshop.roomAssets.forRoom(room.modSet);
    // 房内聊天模式由房主在建房时定（`room.create.chatMode`，默认 'open'）。**服务端强制**：这个值决定
    // `chat` / `quickMsg` 各自放不放行，客户端的输入框只是照着它摆样子。
    if (chatMode !== undefined) room.chatMode = chatMode;
    room.seats[0] = this.humanSeat(0, session, room);
    // 同意落在**座位**上：房主对自己钉下的那一份集合不必再点一次同意。
    room.seats[0].modConsent = room.modSet ? room.modSet.digest : null;
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    // 房间级钩子（§28.20）：房间**已经完全建好**（在 rooms 里、房主就位、集合已物化）之后才触发 —— 包看到的
    // 就是这个房间真正的样子。装不上的包在 `install` 里已经点名并退场，房间照旧。
    this.roomHooks.install(room);
    this.hookFire(room, 'create', { room: room.hookSnapshot(), by: room.hookPlayer(session.playerId) });
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}${version !== DEFAULT_VERSION ? `, ${version}` : ''}${room.test ? ', test' : ''}) by ${session.name}`);
    this.broadcastState(room);
    return OK;
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
   * `pack.msg`（docs/WORKSHOP.md §1.9.6，业主裁决 2026-10-10 的「消息额度」那一半）：**包自己的通道**，引擎只当
   * 不透明载荷转发。四道判据，全部落在「不认识的声明要响亮」那条线上：
   *   1. 必须**在房间里**（通道是房间内的，不在大厅里广播全网）；
   *   2. `pack` 必须是这个服务器真的装着的包，且它**声明过**这个通道（`this.packChannels`）—— 一个包说不出另一个
   *      包的通道，也说不出自己没写进 `client.panels[].messages` 的通道；
   *   3. 载荷大小由 `validateC2S` 卡过（`PACK_MSG_LIMITS.bytes`），这里再卡**频率**（每会话令牌桶，超了 `ERR.RATE`）；
   *   4. 送回**同一个房间**的成员与旁观者。引擎不解释 `data`，也不判断谁该收到 —— 客户端只把消息交给声明过这个
   *      通道的面板，那是「第二个读者」的判据（`extensions.js` 的 `net.on(channel, …)`）。
   *   5. 若房间里跑着对局、它的 `Match` 上有 `handlePackMsg(playerId, msg)`（这是 `server.modules` 的
   *      `matchClass` 包装器唯一能收到网络消息的地方，DESIGN §28.14），**且这个包的服务端模块声明过这个通道**
   *      （`server.modules[].channels`，§28.23）—— 三条齐了才**在限流之后、转发之前**调一次：
   *      返回 `true` 或 `{ consumed: true }` = **已消费**，不再转发给同房其它人；其余返回值（含 `false` /
   *      `undefined`）与**抛错**都当作未消费，照旧转发 —— 一条坏消息不能把整个转发打断。没声明过的通道**投都不投**
   *      （转发照旧）：`channels` 是接收入口，不是注释。
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
    // 对局子类的触发点（业主裁决 2026-10-10 的 A 方案，DESIGN §28.14）：`matchClass` 包装器本来就能碰到整个 Match，
    // 这里只补「消息到了」这一下。**投递收窄到本包服务端模块声明过的通道**（`server.modules[].channels`，§28.23）：
    // 没声明过的通道没有接收入口，投都不投 —— 这是本格的判据，不是注释，`test/packMatchMsg.test.js` 钉住它。
    // 转发口径一字未动：这仍然是**面板**那半边（§1.9.6）的事，收窄只影响「送不送进这一局」。复用 `callMatch` 已有的
    // try/catch 与点名日志 ⇒ 钩子抛错时返回 undefined，落进下面「未消费」那一条，转发照旧。`session.playerId`
    // **可能是观战者**（`pack.msg` 没有旁观者判据，与 `room.chat` 的 `ERR.SPECTATOR` 不同口径），判不判由包自己决定。
    const declaredInMatch = this.serverChannels.get(msg.pack);
    if (declaredInMatch && declaredInMatch.has(msg.channel)) {
      const hook = this.callMatch(room, 'handlePackMsg', session.playerId, msg);
      if (hook === true || (hook !== null && typeof hook === 'object' && hook.consumed === true)) return OK;
    }
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


  /**
   * **每名真人须同意**的判据（W7, DESIGN §28.53）。返回 `null` = 通过，否则是要回给客户端的 `fail(...)`。
   *
   * 同意的内容就是**这一份字节指纹**：`seat.modConsent === room.modSet.digest` 才算同意过。集合一变，两个摘要就
   * 不同 ⇒ 自动作废、必须重新表态（`setRoomMods` 里显式清空，下面那一句是第二层保险）。这比「同意过一次就永远算」
   * 诚实：他当初同意的是另一份字节。
   *
   * 三条边界都是**判断**，不是漏判：
   *   * **房主不受它约束**：他 `room.create` 报出的 `modIds` 就是在钉这一份字节（`create` 据此把他的座位写成
   *     `modConsent = digest`）—— 要求一个人对自己刚钉下的东西再点一次同意，不增加任何信息。
   *   * **AI 座位不算**：`addBot` 建出来的座位天生 `ready: true`，而 AI 从不对齐任何字节、也没有客户端 ——
   *     与 `roomModsRefusal` 只数 `!seat.isBot` **逐字同一条口径**。
   *   * **观战者不算**：他们不走 `join`、不占玩家座位、不参与开局门槛（`activeHumans`）—— 他们不跑这一房的内容。
   *
   * `detail` 点名到**人**与**包**：4 人房里一句「还有博士没同意」等于没说，而客户端正需要那串包名来告诉玩家他
   * 要同意的是什么。
   * @param {Room} room @param {Seat|null} seat
   * @returns {{ error: string, detail?: string }|null}
   */
  modConsentRefusal(room, seat) {
    if (!room || !room.modSet) return null;
    if (!seat || seat.isBot) return null;
    if (seat.modConsent === room.modSet.digest) return null;
    return fail(ERR.MOD_CONSENT_REQUIRED,
      `${seat.name || seat.playerId} has not agreed to this room's mod set (${room.modSet.packs.map((p) => p.id).join(', ') || 'none'} · ${room.modSet.digest.slice(0, 12)}…)`);
  }

  /**
   * **服主 pin 的字节指纹漂了没有**（W7, DESIGN §28.53）。
   *
   * pin 就是房间自己的字节指纹 `room.modSet.digest` —— `modSetOf` 算的那个（`[id, hash]` 排序对的 sha256），没有
   * 第二套「pin」对象：一个房间声明了集合，那份 `modSet` 就是它钉住的东西。所以「指纹变了」只有两种形态，两种都
   * **复用既有守卫**（业主口径：能复用就复用，别造第二套），本函数只负责点名到包：
   *
   *   * 包**没了** ⇒ `MOD_UNKNOWN`（既有那句「本服务器没有这个包」本来就是这件事）；
   *   * 包**被换了**（同一 id、另一个 hash）⇒ `MOD_SET_LOCKED` + 一句说真话的 detail：房间钉的是**字节**，字节
   *     变了就是另一份内容，已经在座 / 已经对齐过的人对不上，要重开房间让所有人重新对齐。
   *
   * 判据本身住在 `shared/modIdentity.js modSetDrift`（算摘要的同一个文件、同一条 `[id, hash]` 口径）。
   * 没声明集合的房间（`modSet === null`）走第一行早退 —— 那种房间与从前逐字节相同。
   * @param {Room} room
   * @returns {{ error: string, detail?: string }|null}
   */
  modPinRefusal(room) {
    if (!room || !room.modSet) return null;
    const loaded = this.workshop && Array.isArray(this.workshop.mods) ? this.workshop.mods : [];
    const drift = modSetDrift(room.modSet, loaded);
    if (drift.missing.length) {
      return fail(ERR.MOD_UNKNOWN, `this room pinned the mod pack(s) (${drift.missing.join(', ')}) and this server no longer runs them — reopen the room`);
    }
    if (drift.changed.length) {
      const shown = drift.changed.map((c) => `${c.id} (${c.was.slice(0, 12)}… → ${c.now.slice(0, 12)}…)`).join(', ');
      return fail(ERR.MOD_SET_LOCKED, `this room pinned the mod pack byte(s) of (${shown}) and those bytes changed on this server since — reopen the room so every client re-aligns`);
    }
    return null;
  }

  /**
   * 空席房间的回收裁决（DESIGN §28.57）。默认行为与从前逐字相同：**没有包申请留，就照旧销毁**。
   * 有包申请（`server.room.hold` + `room.canHold`）则把房间留到裁决给出的时限（宿主夹到
   * `ROOM_HOLD_MAX_MS` 之内），到点重新判一次：那时若还空着就销毁，有人回来了就什么都不做（加入路径本来就会
   * 广播状态）。房间留在 `this.rooms` 里、不广播新事件 —— 对成员而言它还是那个等着重连的房间。
   *
   * 为什么是「最小替换」：没有包申请时这一行**就是**原来那行 `disposeRoom(room, 'empty')`，逐字相同。
   * 定时器 `unref()`：一个等重连的房间不该把进程吊住（与 `startGrace` 同一个口径）。
   */
  reapEmptyRoom(room) {
    if (room.disposed) return;
    const want = holdDecision(room, { log: this.log });
    if (!want.hold) { this.disposeRoom(room, 'empty'); return; }
    if (room.holdTimer) clearTimeout(room.holdTimer);
    room.holdTimer = setTimeout(() => {
      room.holdTimer = null;
      if (room.disposed || room.activeHumans().length > 0) return;
      this.disposeRoom(room, 'empty');
    }, Math.max(0, want.until - Date.now()));
    room.holdTimer.unref?.();
    this.log.info(`[lobby] ${room.code} held for reconnect until ${new Date(want.until).toISOString()} (${want.packs.join('+')})`);
  }

  /**
   * 房间数（业主裁令：**只报数，不枚举**）。
   *
   * `publicRooms` 是公开面（`GET /api/rooms`）唯一的那个数，`total` 是运维面（`/healthz` 的 `rooms`）的那个数。
   *
   * **今天两者恒等**：引擎今天**没有「公开 / 私有」这个属性** —— `room.setInviteOnly` / `room.list` 都不存在
   * （那是投稿 7ca51de6f346 与别的刀的内容，本刀**不预埋** `inviteOnly` 字段）。所以「公开房间数」暂时就是
   * 「房间数」，这里如实返回同一个计数，而不是假装有一个筛选。**`inviteOnly` 落地后**，这个函数是**唯一**
   * 该改的地方：把 `publicRooms` 改成排除 `inviteOnly` 的房间即可。
   *
   * **solo 房算数**（业主裁令，与 `stats().rooms` 同口径、零歧义）：`this.rooms` 只装**在册**房间，
   * `disposeRoom` 会立刻 `delete`（`this.rooms.delete(room.code)`），所以它没有「已销毁但还在数里」的窗口。
   *
   * `out` 是给 `stats()` 复用的：**一次遍历，一件事一个真相** —— 两份「什么算房间」的口径是不允许的。
   * @param {{ matches?: number, humans?: number, bots?: number, spectators?: number }} [out]
   * @returns {{ publicRooms: number, total: number }}
   */
  roomCounts(out = {}) {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    out.matches = matches; out.humans = humans; out.bots = bots; out.spectators = spectators;
    // 今天 publicRooms === total（见上）。共用的这个 `rooms.size` 就是两者唯一的来源。
    return { publicRooms: this.rooms.size, total: this.rooms.size };
  }


  /**
   * `room.mods` 的两条「改不了」判据（G2）。返回 `null` = 通过，否则是要回给客户端的 `fail(...)` 结果。
   *
   * 单独一个函数是为了**双检**（见 `setRoomMods`）：同一个判据调两次，中间不许出现第二份写法 —— 两份写法就是
   * 两个会漂的真相，而漂的方向是「第一次放行、第二次放行、中间那一瞬的状态谁都没看」。
   * @param {Room} room
   * @returns {{ error: string, detail?: string }|null}
   */
  roomModsRefusal(room) {
    if (room.match) return fail(ERR.MOD_SET_LOCKED, 'the running match took this room\'s mod set when it started');
    for (const seat of room.seats) {
      if (seat && !seat.isBot && seat.ready === true) {
        return fail(ERR.MOD_SET_LOCKED, `${seat.name || seat.playerId} is ready — that client aligned to this room\'s current set`);
      }
    }
    return null;
  }

  /**
   * `room.mods { modIds }` —— **房主在房间里改本房间的模组集合**（G1；docs/WORKSHOP.md §1.9.3）。
   *
   * 为什么需要它：建房的 picker（`room.create.modIds`）是**一次性**的 —— 房主点错了、或者开好房才发现这一房要跑
   * 哪几个包，此前唯一的办法是解散重开，而重开会把已经坐进来的博士全赶出去。这一格让「改集合」不再等于「重开房」。
   *
   * 集合本身由 `resolveRoomModSet` 解析 —— **与 `room.create` 同一个函数**（W-A 起就是唯一真相）：ids 必须点名这台
   * 服务器**真的装着的**包（`MOD_UNKNOWN` 同时列出未知与可用的），摘要是 `modSetOf` 算的那一个（不是第二份口径）。
   * 改完**立刻物化**这一份（`roomAssets.forRoom`），所以新摘要的数据面在广播出去之前就已经有了。
   *
   * **三道守卫**（全部点名拒绝，一条都不静默）：
   *   1. 只有房主（`NOT_HOST`）—— 集合是这一房所有人的共同前提，不是谁都能改的；
   *   2. 对局已开 ⇒ `MOD_SET_LOCKED`：正在跑的那一局拿的是**开局那一刻**的集合（`startMatch` 已经把它交给
   *      Match / BattleSpec），现在改只会让「声明的」与「正在跑的」变成两个真相；
   *   3. **任一真人座位 `ready === true`** ⇒ `MOD_SET_LOCKED`：那个人是按**旧集合**对齐完才点的准备就绪
   *      （W-D 的客户端硬门），他的字节可能正好缺新集合里的包。**AI 座位不算**：`addBot` 建出来的座位天生
   *      `ready: true`，而 AI 从不对齐任何字节 —— 照字面把它收进这条判据，房主一加 AI 队友就再也改不了集合，
   *      而那条拒绝说的还是一句与事实无关的话。
   *
   * **双检**（借 Ave-Mujica 的设计：进 handler 先判一次，真正应用之前再判一次）。今天这个 handler 从头到尾是
   * **同步**的（没有 await、没有回调），所以第二次判**不可能**被别的会话插进来 —— 但「守卫」与「改动」之间的距离
   * 是这段代码唯一的脆弱点，而「另一个会话刚刚让某个座位就绪 / 开了局」在任何**未来**的异步化（读盘、物化、钩子）
   * 里会立刻变成真的。所以第二次判写在这里，并且紧挨着那两行赋值：谁把它挪远，谁就把这条不变量挪走了。
   *
   * **房间级钩子的边界**（DESIGN §28.20）：包声明的 `server.room` 钩子在 `install(room)` 那一刻拿到的
   * `ctx.room.modIds` 是**快照**。新集合里该装的那几个钩子包与**已经装上的**不一致时，改集合会让某个包的观察面
   * 与房间的真实集合对不上（它按旧集合装上，却继续看着一个不再声明它的房间）⇒ 点名拒绝，而不是让它偷偷漂。
   * 只改「不含房间钩子的那几个包」时这条判据不挡路（两边算出来的钩子包名单相同）。
   * @param {import('./net.js').Session} session
   * @param {{ modIds: string[] }} msg
   */
  setRoomMods(session, { modIds }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    const early = this.roomModsRefusal(room);
    if (early) return early;
    const resolved = resolveRoomModSet(Array.isArray(modIds) ? modIds : [], this.workshop?.mods);
    if (!resolved.ok) {
      const unknown = resolved.unknown.length ? resolved.unknown.join(', ') : '(none)';
      const available = resolved.available.length ? resolved.available.join(', ') : '(none)';
      return fail(ERR.MOD_UNKNOWN, `this server does not run the mod pack(s) (${unknown}); available: ${available}`);
    }
    const nextIds = resolved.modIds.length ? resolved.modIds : null;
    // 幂等：同一份集合（含「两边都不声明」）不是一个变更 —— 不广播、不重物化，也不动别人的就绪状态。
    if (sameModIds(room.modIds, nextIds)) return OK;
    const hookIds = (this.workshop && Array.isArray(this.workshop.roomHooks) ? this.workshop.roomHooks : [])
      .filter((h) => h && typeof h.id === 'string' && typeof h.install === 'function')
      .map((h) => h.id);
    if (hookIds.length) {
      const nextDeclared = resolved.modSet ? new Set(resolved.modSet.packs.map((p) => p.id)) : null;
      const wanted = hookIds.filter((id) => !nextDeclared || nextDeclared.has(id)).sort();
      const installed = this.roomHooks.packsFor(room).slice().sort();
      if (wanted.length !== installed.length || wanted.some((id, i) => id !== installed[i])) {
        return fail(ERR.BAD_MSG, `this room's server.room hooks are installed for (${installed.join(', ') || 'none'}), and this set needs (${wanted.join(', ') || 'none'}) — a hook sees the room's modIds as a snapshot taken at install, so which packs have hooks must be decided when the room is created`);
      }
    }
    // 第二次判（双检）：紧挨着下面两行赋值，见上面那段。
    const late = this.roomModsRefusal(room);
    if (late) return late;
    this.dropReplay(room, session.playerId);
    room.modIds = nextIds;
    room.modSet = resolved.modSet;
    if (room.modSet && this.workshop && this.workshop.roomAssets) this.workshop.roomAssets.forRoom(room.modSet);
    // 集合变了 ⇒ 所有**真人**座位（房主除外，他就是改的人）重新回到未就绪：他们可能缺新集合的文件。这是
    // 「集合变更后加入者如何重新对齐」的服务端那一半；客户端那一半是 W-D 的准备就绪硬门 ——
    // `public/js/screens/room.js` 的 RoomModsPanel 按 `room.state.mods.digest` 重跑 planAlignment，没对齐完
    // 就点不了准备就绪（客户端在这一刀里也补上了「摘要一变就先锁住，别拿旧结论放行」）。
    //
    // **同意也一起作废**（W7, DESIGN §28.53）：他们同意的是**旧的那一份字节**，而 pin 的是新的。不清空的话
    // 「同意过」会退化成「点过一次就一直算」，那正是这一格要消灭的那种谎话。房主的座位写上新摘要 —— 他刚用这条
    // 消息把新集合钉下来（`room.mods` 就是他的表态），除非他改回「不声明」（那时这一格整条不适用，写 `null`）。
    for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) { s.ready = false; s.modConsent = null; }
    const hostSeat = room.seatOf(room.hostId);
    if (hostSeat && !hostSeat.isBot) hostSeat.modConsent = room.modSet ? room.modSet.digest : null;
    this.log.info(`[lobby] ${room.code} mod set is now ${room.modSet ? room.modSet.packs.map((p) => p.id).join(', ') : '(none)'} by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  /**
   * 本房座位上限 (业主裁决 B5, docs/META.md §1.9): the HOST resizes the room it is already in.
   *
   * 三条守卫，一条都不许省：
   *   1. `code` 必须是**你现在所在的这个房间**。一条消息只能改一个明确点名的房间 —— 一个停在旧 `room.state` 上的
   *      标签页因此不会把房主刚换到的新房间改小。不匹配 ⇒ `NOT_IN_ROOM`（**不**是「默默改你现在待着的那个」）。
   *   2. 只有房主 ⇒ `NOT_HOST`；模拟进行中 ⇒ `ROOM_STARTED`（房间的 `seats` 数组是**大厅**的，正在跑的 Match 拿的是
   *      它自己那份副本，所以这里本来就改不了比赛 —— 但也不给一个正在打的人临时多开／少开座位）；solo 房没有可选的
   *      座位数（它的形状就是 1）⇒ `BAD_TARGET`。
   *   3. **新上限不许小于房间内现有的人数（真人 + AI）** ⇒ `SEAT_CAP_TOO_SMALL`。这一条就是「**永远不踢人**」的
   *      **全部**保证：只要它成立，缩容只会砍掉**空**座位。
   *
   * 「越界 / 垃圾值」与「低于现有人数」**两个错误码分得开**，因为它们要的是两个不同的动作：前者去改数字
   * （`BAD_MSG` + 点名的 `detail`，与 `room.create.seatCap` 同一套口径），后者去请人离开（`SEAT_CAP_TOO_SMALL`）。
   * **两者都不静默钳制** —— 一个被悄悄换成别的数字的上限，房主没有任何办法看出来。
   *
   * 上限本身（`this.opts.maxSeats` = `SP_MAX_SEATS`，缺省 20）是「**绝不信任客户端**」的那一条：协议已经
   * 判过 `[MIN_SEATS, SEAT_CAP]`，这里再按这台服务器真正的天花板判一次，好让不走协议的调用方也过不去。
   */
  setSeatCap(session, { code, seatCap }) {
    const room = this.roomOf(session);
    if (!room || room.code !== code) return fail(ERR.NOT_IN_ROOM, `you are not in room ${code}`);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'a solo room has exactly one seat');
    const ceiling = this.opts.maxSeats;
    if (!Number.isInteger(seatCap) || seatCap < MIN_SEATS || seatCap > ceiling) {
      return fail(ERR.BAD_MSG, `seatCap is not a seat count this server allows (an integer in [${MIN_SEATS}, ${ceiling}])`);
    }
    // 「不踢人」的守卫：`occupied` 是裁决书上的口径（人数），`highest` 是它的**充分**版本 —— 座位允许有空洞
    // （房主永久离开后 `seats[0]` 会是 null，而 `seats[2]` 还坐着人），只数人数会让 `seatCap = 2` 砍掉 2 号位。
    const occupied = room.occupiedSeats().length;
    const highest = room.seats.reduce((m, s, i) => (s ? i : m), -1);
    if (seatCap < occupied || seatCap <= highest) {
      return fail(ERR.SEAT_CAP_TOO_SMALL, `${occupied} player(s) are in ${room.code}; a smaller cap would evict somebody`);
    }
    if (room.seatCap === seatCap) return OK;   // idempotent: no state change, so no broadcast either
    this.dropReplay(room, session.playerId);
    room.seatCapTo(seatCap);
    this.log.info(`[lobby] ${room.code} seat cap set to ${seatCap} by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  /**
   * room.support (助战, shared/support.js): check the selection against the SERVER's pool (data/support.json), store it
   * on the session and the seat, and — while a match runs — hand it to the match (accepted until the match leaves
   * INFO_CHECK, exactly like the loadout). An operator the pool does not list rejects the whole message: unlike the
   * loadout there is deliberately no fallback, because falling back would silently grant a disabled operator.
   */
  support(session, { entries }) {
    const room = this.roomOf(session);
    // the room's own pool AND the room's own chess table: `checkSupport` reads one and looks the other up
    const data = this.roomData(room);
    const cfg = normalizeSupportConfig(data && data.support);
    const res = checkSupport(entries, cfg, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const support = freezeSupport(res.entries);
    session.support = support;
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
   * The 助战 catalog a client may show (`supportPicker` names this as its purpose), plus the player's own current picks.
   * An operator the pool does not list is DISABLED — the picker must not be able to offer it, and the server refuses a
   * request that names it (shared/support.js checkSupport) — so this is the only way the client learns the pool.
   *
   * **The same data the check runs on** (`roomData`, see its header): this is the VISIBLE face of the pool and
   * `support()` is the CHECKING face, so reading `safeData()` here while `support()` reads the room would list a
   * pickable-looking operator the very same server then refuses — "the client can see it but cannot pick it". A room
   * that declared nothing (or everything), and a session with no room, still resolve to the process singleton itself,
   * so 4 座 output is byte-for-byte unchanged.
   * @param {{ modSet: { digest: string, packs: Array<{ id: string }> }|null }|null} [room]
   */
  supportView(room = null) {
    const data = this.roomData(room);
    const cfg = normalizeSupportConfig(data && data.support);
    // 没启用助战就返回 null：`room.state` 里连这个键都不出现，干净安装的帧因此逐字节不变（与 `mods` 同一条纪律）。
    if (!cfg.enabled) return null;
    return {
      enabled: cfg.enabled,
      label: cfg.label,
      tiers: supportPicker(cfg),
      capacity: supportCapacity(cfg),
      slots: supportTiers(cfg).reduce((o, t) => ({ ...o, [t]: cfg.slots[t] }), {}),
    };
  }

  join(session, { code, testAck, consent }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    if (room.test && testAck !== true) return fail(ERR.TEST_CONFIRM);
    // 服主 pin（W7）：这个房间钉住的那几个包的**字节**还在不在机器上。判在「认不认得出这个房间」之后、
    // 「占座」之前 —— 一份已经不在的内容，占了座也是白占。没声明集合的房间在第一行早退。
    const pin = this.modPinRefusal(room);
    if (pin) return pin;
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    // 但**同意可以在这里补**：集合中途改过之后，已经在座的人不该被逼「退出再进」——而他们必须能表态，
    // 否则这一房永远开不了局（start 会拦下来）。所以这一处早退也要先判同意。
    if (cur === room && !room.spectatorOf(session.playerId)) {
      const seat = room.seatOf(session.playerId);
      if (room.modSet && seat && seat.modConsent !== room.modSet.digest) {
        if (consent !== true) return this.modConsentRefusal(room, seat);
        seat.modConsent = room.modSet.digest;
        this.log.info(`[lobby] ${room.code} ${session.name} agreed to the room's mod set (${room.modSet.digest.slice(0, 12)}…)`);
      }
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    // 每名真人须同意（W7, DESIGN §28.53）：占了玩家座位就要先对**这一份**字节表态。判在占座之前，
    // 所以没同意的人进不去（不是「进来了但只能看着」）。AI 与观战者不在这一条线上。
    if (room.modSet && consent !== true) {
      return fail(ERR.MOD_CONSENT_REQUIRED,
        `this room declares the mod set (${room.modSet.packs.map((p) => p.id).join(', ')} · ${room.modSet.digest.slice(0, 12)}…) — send "consent" to agree`);
    }
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    // a human takes a player seat: the version vote is void (header "Official versions") — before the seat is taken, so
    // its toast reaches the members who saw the vote (a spectator sitting down too), never a joiner who did not
    if (room.versionVote) this.voidVersionVote(room, 'members');
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session, room);
    room.seats[idx].modConsent = room.modSet ? room.modSet.digest : null;
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    // 房间级钩子（§28.20）：**新成员**加入（幂等的重复 join 在上面就返回了，走不到这里）。
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
  spectate(session, { code, testAck }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    if (room.test && testAck !== true) return fail(ERR.TEST_CONFIRM);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return this.becomeSpectator(room, session);
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
    // 房间级钩子（§28.20）：**新观战者**加入。观战者不是玩家、不占座位、不算开局门槛，但「谁在看」包也该知道。
    this.hookFire(room, 'spectate', { room: room.hookSnapshot(), by: room.hookPlayer(session.playerId) });
    return OK;
  }

  /** Change roles before a match without leaving the room or discarding the session's loadout. */
  becomeSpectator(room, session) {
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    const seat = room.seatOf(session.playerId);
    if (!seat || seat.left || seat.isBot) return fail(ERR.NOT_IN_ROOM);
    // A disconnected seat is not a successor: the room would have nobody online who can start or vote.
    if (!room.activeHumans().some((s) => s.playerId !== session.playerId && s.connected)) return fail(ERR.NOT_READY, 'at least one player must remain seated');
    this.clearGrace(session.playerId);
    this.dropReplay(room, session.playerId);
    room.seats[seat.seat] = null;
    room.spectators.push({
      playerId: session.playerId, name: session.name, connected: session.connected,
      // Keep the content report so settingsCs still stamps a needsContent room's cs while they watch.
      content: seat.content ?? null, contentGen: seat.contentGen || 0,
    });
    session.notice = null;
    session.pendingResult = null;
    // Freeing a player seat invalidates the version vote, including when its host stays as a spectator.
    if (room.versionVote) this.voidVersionVote(room, 'members');
    if (room.hostId === session.playerId) this.migrateHost(room);
    this.broadcastState(room);
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
    // a room with gameplay plugins: ready once the page has loaded and checked its content (header "Gameplay plugins")
    if (ready && room.needsContent && seat.content !== 'ready') return fail(ERR.CONTENT_NOT_READY);
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
    // the room's version offers it (header "Official versions": 第二期上半 / 第一期 have no 终极)
    if (!this.offered(room.version, room.mode).includes(difficulty)) return fail(ERR.BAD_TARGET, 'not a mode of this version');
    this.dropReplay(room, session.playerId);
    // a laddered room (规程's solo) moves to the first official mode of that difficulty
    const modeId = this.laddered(room.version, room.mode) ? this.ladderMode(room.version, room.mode, difficulty, null) : null;
    // a plugin mode chosen (header "Gameplay plugins") carries its own difficulty: picking one leaves it
    if (room.difficulty !== difficulty || room.content?.modeId || room.modeId !== modeId) {
      room.difficulty = difficulty;
      room.modeId = modeId;
      if (room.content?.modeId) { const rest = { ...room.content }; delete rest.modeId; room.content = Object.freeze(rest); }
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /** 「AI 队友最后选择」 (GitHub #338): host-only, before the match, co-op rooms only (a solo room has no AI seat). */
  /** Host-only opt-in, fixed before play; inherited seat metrics never become personal rewards (§37.100). */
  setAiTakeover(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo' || (on && room.modded)) return fail(ERR.BAD_TARGET);
    if (room.aiTakeoverEnabled !== on) {
      this.dropReplay(room, session.playerId);
      room.aiTakeoverEnabled = on;
      resetAiTakeover(room);
      for (const seat of room.seats) if (seat && !seat.isBot && seat.playerId !== room.hostId) seat.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

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

  /**
   * 「不限时」 (DESIGN §37.23.10): host-only, before the match, a solo room of a version whose solo is timed. `on: false`
   * clears the flag and drops the room.state key. A co-op room or a version whose solo is already untimed is BAD_TARGET.
   */
  setSoloUnlimited(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode !== 'solo' || !this.versionSoloTimed(room.version)) return fail(ERR.BAD_TARGET, 'this version\'s solo is not timed');
    this.dropReplay(room, session.playerId);
    const next = on === true;
    if (room.soloUnlimited !== next) {
      room.soloUnlimited = next;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * room.setPlugins (header "The room's plugins", "Gameplay plugins"): host-only, before the match; the set of the plugins
   * asked for becomes the room's content and the other humans are un-readied — nothing changes (and nobody is un-readied)
   * when it is the set the room already has. The host's result replay (a settlement screen still open) is dropped only
   * when the set did change: re-applying the same plugins, or a refused set, leaves it.
   */
  setPlugins(session, { plugins }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const ids = [...new Set(plugins.map((p) => p.id))];
    /** @type {Record<string, Record<string, unknown>>} */
    const settings = {};
    for (const p of plugins) if (p.settings) settings[p.id] = p.settings;
    const r = this.resolveContent(room, ids, settings);
    if ('error' in r) return r;
    let content = r.content;
    const before = room.content;
    const sameSet = (before?.vs ?? null) === (content?.vs ?? null) && (before?.cs ?? null) === (content?.cs ?? null);
    const marks = (c) => JSON.stringify((c?.plugins || []).map((p) => [p.id, !!p.auto, p.settings || null]));
    if (sameSet && marks(before) === marks(content)) return OK;
    this.dropReplay(room, session.playerId);
    // another set: a notice still waiting for the end of a match (pluginsChanged) is moot
    if (!sameSet) { room.pluginsChanged = null; room.pluginNoticeKeys = {}; }
    // the plugin mode chosen stays while the set still provides it (header "Gameplay plugins")
    if (before?.modeId && content?.modes?.some((m) => m.id === before.modeId)) content = Object.freeze({ ...content, modeId: before.modeId });
    room.content = content;
    if (!sameSet) {
      this.holdContent(content);
      this.releaseContent(before);
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      // another content set: every page loads and checks it again (room.contentReady)
      if ((before?.cs ?? null) !== (content?.cs ?? null)) for (const s of [...room.seats, ...room.spectators]) if (s && !s.isBot)  { s.content = null; s.consentCs = null; }
      this.log.info(`[lobby] ${room.code} plugins: ${content?.plugins?.length ? content.plugins.map((p) => `${p.id}@${p.version}`).join(', ') : 'none'}${room.modded ? ` (content ${content.cs.slice(0, 8)})` : ''}`);
    }
    this.broadcastState(room);
    return OK;
  }

  /**
   * The content a room gets for the plugins `ids` (header "The room's plugins", "Gameplay plugins"): the vanilla set for
   * none, else what the room sets resolve — cosmetic plugins only: the vanilla cs with their `vs`; content plugins: the
   * content set's own cs (`vanilla: false`). Nothing is held yet (holdContent). On another official version (header
   * "Official versions") the base is that version's content (its cs, `version`); every gameplay plugin must support it.
   * @param {Room | null} room @param {string[]} ids @param {Record<string, Record<string, unknown>>} [settings]
   * @param {string} [version] the version the content is for (default: the room's)
   * @param {Room['content'] | null} [replacing] the content this change frees (default: the room's — room.create passes
   *   the creator's old room's when it goes away with the create: its set counts as freed against limits.maxSets)
   * @returns {{ content: Room['content'] } | { error: string, detail?: string }}
   */
  resolveContent(room, ids, settings = {}, version = room ? room.version : DEFAULT_VERSION, replacing = room?.content ?? null) {
    const base = this.baseContent(version);
    if (!ids.length) {
      // the server owner may fix every room's plugins (plugins/config.json rooms: fixed): the original game is not one
      const fixed = (() => { try { return this.plugins?.fixed?.() || null; } catch { return null; } })();
      if (fixed && fixed.length) return fail(ERR.PLUGIN_BLOCKED, 'this server fixes every room\'s plugins (plugins/config.json rooms: fixed)');
      return { content: base };
    }
    if (!this.vanilla || !this.plugins || !base) return fail(ERR.PLUGIN_UNKNOWN, 'this server applies no plugins');
    let r;
    try { r = this.plugins.resolve(ids, { scope: 'room', settings, replacing, version }); } catch (e) {
      this.log.error(`[lobby] ${room?.code ?? '----'} plugin set failed`, e);
      return fail(ERR.INTERNAL);
    }
    if (!r || !r.ok) return fail(r && isErrCode(r.error) ? r.error : ERR.INTERNAL, r && typeof r.detail === 'string' ? r.detail.slice(0, 200) : undefined);
    const { cs, vs, plugins: list, warnings, bytes, dataBytes, modes, kitted, trusted, execution, rules } = r.set;
    const modded = isContentHash(cs) && cs !== base.cs;
    const frozen = (a) => Object.freeze((Array.isArray(a) ? a : []).map((p) => Object.freeze({ ...p })));
    // the operators its plugins add to a 自选 slot's list (welcome.diyKitted holds the server's own): the pages' pickers
    const extra = modded && Array.isArray(kitted) ? kitted.filter((id) => typeof id === 'string' && !VANILLA_KITTED.has(id)).slice(0, 200) : [];
    return {
      content: Object.freeze({
        cs: modded ? cs : base.cs,
        vanilla: !modded,
        ...(base.version ? { version: base.version } : {}),
        ...(vs ? { vs } : {}),
        plugins: frozen(list),
        ...(trusted ? {trusted} : {}),
        ...(execution ? {execution} : {}),
        warnings: Object.freeze([...(warnings || [])]),
        bytes: Number(bytes) || 0,
        ...(modded ? { dataBytes: Number(dataBytes) || 0, modes: frozen(modes), ...(extra.length ? { kittedExtra: Object.freeze(extra) } : {}) } : {}),
        ...(rules ? { rules } : {}),
      }),
    };
  }

  /** A room now uses `content`: its visual set and its content set are held (released by releaseContent). */
  holdContent(content) {
    if (content?.vs) this.plugins?.hold?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.holdContent?.(content.cs);
  }

  /** A room no longer uses `content`. */
  releaseContent(content) {
    if (content?.vs) this.plugins?.release?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.releaseContent?.(content.cs);
  }

  /**
   * room.setMode (header "Gameplay plugins"): host-only, before the match. An official mode of the room's type sets its
   * difficulty (and leaves a plugin mode); a mode of the room's content set (content.modes, the room's type) becomes
   * content.modeId — its difficulty the room's. Like a difficulty change it un-readies the other humans.
   */
  setMode(session, { modeId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    // a laddered room (规程's solo): any official mode of the version's room mode; the room's difficulty follows it
    // (极速模拟's FAST counts as 标准 FUNNY for the difficulty-keyed parts of the room)
    const laddered = this.laddered(room.version, room.mode);
    const ladder = laddered ? this.versionModes(room.version, room.mode).find((m) => m.id === modeId) : null;
    if (ladder) {
      const difficulty = DIFFICULTIES.includes(ladder.difficulty) ? ladder.difficulty : 'FUNNY';
      if (room.modeId === ladder.id && room.difficulty === difficulty && !room.content?.modeId) return OK;
      room.modeId = ladder.id;
      room.difficulty = difficulty;
      if (room.content?.modeId) { const rest = { ...room.content }; delete rest.modeId; room.content = Object.freeze(rest); }
      this.dropReplay(room, session.playerId);
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
      return OK;
    }
    // a laddered room's official modes are the ones above: mode_single_<difficulty> is no mode there (规程 has none)
    const official = laddered ? undefined : DIFFICULTIES.find((d) => modeIdFor(room.mode, d) === modeId);
    let difficulty = room.difficulty;
    let content = room.content;
    if (official) {
      // the room's version offers it (header "Official versions")
      if (!this.offered(room.version, room.mode).includes(official)) return fail(ERR.BAD_TARGET, 'not a mode of this version');
      difficulty = official;
      if (content?.modeId) { const rest = { ...content }; delete rest.modeId; content = Object.freeze(rest); }
    } else {
      const mode = Array.isArray(content?.modes) ? content.modes.find((m) => m && m.id === modeId) : null;
      if (!mode) return fail(ERR.BAD_TARGET, 'not a mode of this room');
      if (mode.roomMode !== room.mode) return fail(ERR.BAD_TARGET, `a mode of ${mode.roomMode} rooms`);
      if (DIFFICULTIES.includes(mode.difficulty)) difficulty = mode.difficulty;
      if (content.modeId !== modeId) content = Object.freeze({ ...content, modeId });
    }
    if (difficulty === room.difficulty && content === room.content) return OK;
    this.dropReplay(room, session.playerId);
    room.difficulty = difficulty;
    room.content = content;
    for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
    this.broadcastState(room);
    return OK;
  }

  /**
   * room.contentReady { cs, ok? } (header "Gameplay plugins"): the member's page has loaded and checked the room's content
   * set (`ok: false`: it could not). Recorded for the room's current set only — a page that checked an older one is
   * answered OK and changes nothing — and only for the page that is there: a session whose socket is gone, or a message
   * that waited on the room's queue across a disconnect of its seat (`ctx.from`: the seat's generation when it was
   * queued), is answered OK and writes nothing (the page that comes back checks the set again).
   * @param {import('./net.js').Session} session @param {{ cs: string, ok?: boolean }} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  contentReady(session, { cs, ok }, ctx = null) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.needsContent || room.content?.cs !== cs) return OK;
    if (!session.connected) return OK;
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    if (!seat) return OK;
    if (ctx && ctx.from && (ctx.from.seat !== seat || ctx.from.gen !== (seat.contentGen || 0))) return OK;
    if (ok !== false && room.content?.trusted && room.seatOf(session.playerId) && seat.consentCs !== cs) return fail(ERR.PLUGIN_CONSENT);
    const state = ok === false ? 'failed' : 'ready';
    if (seat.content === state) return OK;
    seat.content = state;
    if (state === 'failed') this.log.warn(`[lobby] ${room.code} ${session.name}: the room's content ${cs.slice(0, 8)} did not load or check on that page`);
    this.broadcastState(room);
    return OK;
  }

  /** Each live session consents only for its own seat and the current cs. Reconnect keeps the seat. */
  consent(session, {cs,accept}) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const seat = room.seatOf(session.playerId);
    if (!seat || seat.isBot) return fail(ERR.SPECTATOR);
    if (!session.connected || !room.content?.trusted || room.content.cs !== cs) return fail(ERR.PLUGIN_CONSENT);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const changed = (seat.consentCs === cs) !== accept;
    seat.consentCs = accept ? cs : null;
    if (changed) seat.content = null;
    if (!accept) { seat.ready = false; seat.content = null; }
    this.broadcastState(room);
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // Official versions (header "Official versions")
  // ---------------------------------------------------------------------------------------------------

  /**
   * The server's default version (a room created without one, the settings outside a room). When the configured one's
   * data failed to load: 第二期下半 if enabled, else the first enabled version that loads (server/versions.js welcome
   * marks the same one the default).
   */
  defaultVersion() {
    const v = this.versions;
    const id = v?.defaultId ?? DEFAULT_VERSION;
    if (!v || this.versionAvailable(id)) return id;
    if (v.isEnabled(DEFAULT_VERSION)) return DEFAULT_VERSION;
    return v.ids.find((x) => this.versionAvailable(x)) ?? id;
  }

  /** Does this server offer the version `id`? @param {unknown} id */
  versionEnabled(id) { return this.versions ? this.versions.isEnabled(id) : id === DEFAULT_VERSION; }

  /**
   * Can a room play the enabled version `id` now? Another version's data loads on first use (a room of it loads it
   * anyway); a failed load is remembered (server/versions.js available), and such a version is never offered again.
   * @param {string} id
   */
  versionAvailable(id) { return id === DEFAULT_VERSION || typeof this.versions?.available !== 'function' || this.versions.available(id); }

  /** A room's content base for a version: the vanilla content for 第二期下半, else the version's own. @param {string} v */
  baseContent(v) {
    if (v === DEFAULT_VERSION || !this.versions) return this.vanilla;
    return this.versions.content(v) || null;
  }

  /**
   * The difficulties a version offers a room mode (DIFFICULTIES for 第二期下半 / a server without versions).
   * @param {string} v @param {string} mode @returns {readonly string[]}
   */
  offered(v, mode) {
    if (!this.versions || v === DEFAULT_VERSION) return DIFFICULTIES;
    return this.versions.offered(v, /** @type {'solo' | 'coop'} */ (mode));
  }

  /** The official modes of a version's room mode (versions.modesOf), [] without the service. */
  versionModes(v, mode) { return this.versions?.modesOf?.(v, /** @type {'solo' | 'coop'} */ (mode)) ?? []; }

  /** Does a room of this version and mode keep its own mode id (规程's solo ladder; versions.laddered)? */
  laddered(v, mode) { return v !== DEFAULT_VERSION && !!this.versions?.laddered?.(v, /** @type {'solo' | 'coop'} */ (mode)); }

  /**
   * A laddered room's official mode: `asked` when the version offers it, else the first mode of `difficulty` (sortId
   * order: 标准 → 规程等级1, 险境 → 规程等级5 …), else the first mode.
   * @param {string} v @param {string} mode @param {string} difficulty @param {string | null} asked
   */
  ladderMode(v, mode, difficulty, asked) {
    const list = this.versionModes(v, mode);
    return list.find((m) => m.id === asked)?.id ?? list.find((m) => m.difficulty === difficulty)?.id ?? list[0]?.id ?? null;
  }

  /**
   * Does this version's solo use the official per-round timers (`config.version.rules.soloTimed`)? 第二期下半, a server
   * without the versions service, and a version whose data cannot be read: no.
   * @param {string} id
   */
  versionSoloTimed(id) {
    if (!id || id === DEFAULT_VERSION || !this.versions) return false;
    try {
      const data = this.versions.data(id);
      return data?.config?.version?.rules?.soloTimed === true;
    } catch (e) {
      this.log.error(`[lobby] the solo timer of ${id} failed`, e);
      return false;
    }
  }

  /**
   * `d`, or the difficulty the version offers instead: the highest below it, else its lowest (终极 → 绝境).
   * @param {string} v @param {string} mode @param {string} d
   */
  fallbackDifficulty(v, mode, d) {
    const offered = this.offered(v, mode);
    if (!offered.length || offered.includes(d)) return d;
    const below = DIFFICULTIES.slice(0, Math.max(0, DIFFICULTIES.indexOf(d))).reverse().find((x) => offered.includes(x));
    return below || offered[0];
  }

  /**
   * room.proposeVersion { version } (host, before the match): a lone active human switches at once, else the seated
   * humans vote (header "Official versions").
   */
  proposeVersion(session, { version }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (!this.versionEnabled(version)) return fail(ERR.VERSION_UNKNOWN);
    if (!this.offered(version, room.mode).length) return fail(ERR.VERSION_UNSUPPORTED, `${version} has no ${room.mode} rooms`);
    if (version === room.version) return fail(ERR.ALREADY);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const now = this.now();
    if (now - room.versionProposeAt < this.opts.versionProposeGapMs || now < room.versionRetryAt) return fail(ERR.RATE);
    const humans = room.activeHumans();
    if (humans.some((s) => !s.connected)) return fail(ERR.NOT_READY);
    if (!this.versionAvailable(version)) return fail(ERR.VERSION_UNSUPPORTED, 'the data of this version is not available');
    room.versionProposeAt = now;
    // the room's plugins must resolve on the target (the server owner's policy, a plugin refused there)
    const ids = (room.content?.plugins || []).filter((p) => !p.auto).map((p) => p.id);
    if (ids.length) {
      const r = this.resolveContent(room, ids, this.pluginSettings(room.content), version);
      if ('error' in r) return fail(ERR.VERSION_UNSUPPORTED, `the room's plugins do not apply to ${version}: ${r.detail || r.error}`);
    }
    this.dropReplay(room, session.playerId);
    if (humans.length === 1) return this.applyVersion(room, version, 'alone');
    room.versionVoteSeq = room.versionVoteSeq >= 2 ** 31 ? 1 : room.versionVoteSeq + 1;
    const id = room.versionVoteSeq;
    const ms = Math.max(0, Number(this.opts.versionVoteMs) || 0);
    const timer = setTimeout(() => {
      const run = () => { if (!room.disposed && room.versionVote?.id === id) this.voidVersionVote(room, 'expired'); };
      // in order with the room's messages when something of the room is still pending (header "Gameplay plugins")
      if (room.queue.pending > 0) this.queueEvent(room, run); else run();
    }, ms);
    timer.unref?.();
    room.versionVote = { id, proposerId: session.playerId, version, voters: humans.map((s) => s.playerId), agreed: new Set([session.playerId]), expiresAt: now + ms, timer };
    this.log.info(`[lobby] ${room.code} version vote #${id} → ${version} (${humans.length} voters)`);
    this.broadcastState(room);
    return OK;
  }

  /** room.versionVote { voteId, agree } (a voter): a decline cancels the vote, the last agreement switches. */
  versionVote(session, { voteId, agree }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    const vote = room.versionVote;
    if (!vote) return fail(ERR.WRONG_PHASE);
    if (vote.id !== voteId) return fail(ERR.BAD_TARGET, 'vote changed');
    if (!vote.voters.includes(session.playerId)) return fail(ERR.BAD_TARGET, 'not a voter');
    this.dropReplay(room, session.playerId);
    if (!agree) {
      this.voidVersionVote(room, 'declined', session.name);
      return OK;
    }
    if (vote.agreed.has(session.playerId)) return OK;
    vote.agreed.add(session.playerId);
    if (vote.voters.every((id) => vote.agreed.has(id))) return this.applyVersion(room, vote.version, 'vote');
    else this.broadcastState(room);
    return OK;
  }

  /** room.cancelVersionVote { voteId } (host): the vote ends, the room keeps its version. */
  cancelVersionVote(session, { voteId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.versionVote) return fail(ERR.WRONG_PHASE);
    if (room.versionVote.id !== voteId) return fail(ERR.BAD_TARGET, 'vote changed');
    this.dropReplay(room, session.playerId);
    this.voidVersionVote(room, 'cancelled');
    return OK;
  }

  /**
   * End the room's open version vote without a switch and tell its members (header "Official versions"): `declined`
   * (by `name`; every member), `expired` (every member), `members` (a seat or the host changed, a voter dropped, a match
   * started; every member), `cancelled` (by the host; everyone but the host). A declined or expired vote holds the next
   * proposal back versionRetryMs. room.state is broadcast — but for `members`: every such caller broadcasts it next.
   * @param {Room} room @param {'declined' | 'expired' | 'members' | 'cancelled'} reason @param {string} [name]
   */
  voidVersionVote(room, reason, name = '') {
    const vote = room.versionVote;
    if (!vote) return;
    clearTimeout(vote.timer);
    room.versionVote = null;
    if (reason === 'declined' || reason === 'expired') room.versionRetryAt = this.now() + this.opts.versionRetryMs;
    this.log.info(`[lobby] ${room.code} version vote #${vote.id} ended (${reason})`);
    if (room.disposed) return;
    if (reason !== 'members') this.broadcastState(room);
    const text = reason === 'declined' ? msg('{name}拒绝了切换版本', { name })
      : reason === 'expired' ? msg('切换版本投票已超时，房间版本未改变')
        : reason === 'cancelled' ? msg('创建者取消了切换版本投票')
          : msg('同盟成员有变动，切换版本投票已取消');
    const toast = { t: 'm.toast', kind: reason === 'cancelled' ? 'info' : 'warn', ...wireMessage(text) };
    if (reason !== 'cancelled') { this.broadcastRoom(room, toast); return; }
    for (const s of [...room.seats, ...room.spectators]) if (s && !/** @type {any} */ (s).isBot && s.playerId !== room.hostId) this.sendToPlayer(room, s.playerId, toast);
  }

  /** The per-plugin settings of a room content's plugins (to resolve the same choice again). */
  pluginSettings(content) {
    /** @type {Record<string, Record<string, unknown>>} */
    const out = {};
    for (const p of content?.plugins || []) if (p.settings && typeof p.settings === 'object') out[p.id] = { ...p.settings };
    return out;
  }

  /**
   * Switch the room to `version` (header "Official versions"): its difficulty, its content (the version's base with the
   * room's plugins composed again — a gameplay failure preserves the original room), every member's page loading it, the other humans
   * un-readied, the whole result replay and every human seat's stored settings dropped, a seat card the version lacks
   * dropped. Broadcast.
   * @param {Room} room @param {string} version @param {'vote' | 'alone'} how
   */
  applyVersion(room, version, how) {
    if (room.versionVote) { clearTimeout(room.versionVote.timer); room.versionVote = null; }
    const before = room.content;
    let next = this.baseContent(version);
    const ids = (before?.plugins || []).filter((p) => !p.auto).map((p) => p.id);
    if (ids.length) {
      const r = this.resolveContent(room, ids, this.pluginSettings(before), version);
      if ('content' in r && r.content) next = r.content;
      else if (room.modded) {
        // A changed plugin or a newly full pool during the vote must not silently turn the match vanilla.
        this.broadcastState(room);
        return 'error' in r ? r : fail(ERR.VERSION_UNSUPPORTED);
      } else this.warnOnce(`[lobby] ${room.code} plugins (${ids.join(', ')}) dropped on the switch to ${version}: ${'error' in r ? r.error : '?'}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`);
    }
    room.version = version;
    // 「不限时」 belongs to a timed solo only (header): a co-op room, or a version whose solo is not timed, drops it.
    // Switching between the two 第一期 versions keeps it.
    if (room.mode !== 'solo' || !this.versionSoloTimed(version)) room.soloUnlimited = false;
    room.difficulty = this.fallbackDifficulty(version, room.mode, room.difficulty);
    room.modeId = this.laddered(version, room.mode) ? this.ladderMode(version, room.mode, room.difficulty, room.modeId) : null;
    room.content = next;
    this.holdContent(next);
    this.releaseContent(before);
    room.pluginsChanged = null;
    room.pluginNoticeKeys = {};
    room.replay = null;
    const data = this.dataFor(room);
    const operators = cardCharIds(data);
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || /** @type {any} */ (s).isBot) continue;
      const seat = /** @type {Seat} */ (s);
      seat.content = null;
      seat.consentCs = null;
    }
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      if (s.playerId !== room.hostId) s.ready = false;
      s.loadout = null; s.ops = null; s.notOwned = null; s.diy = null;
      s.loadoutCs = null; s.notOwnedCs = null; s.diyCs = null;
      if (s.card && !operators.has(s.card)) s.card = null;
    }
    this.log.info(`[lobby] ${room.code} version → ${version} (${how})`);
    this.broadcastState(room);
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
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const humans = room.activeHumans();
    // 服主 pin 的字节漂了没有（W7）：判在开局这一刻，而不是只判 join —— 集合可以中途被房主改掉
    // （room.mods），改完所有真人的同意都会作废，而那时**没有任何人重新 join 过**。
    const drift = this.modPinRefusal(room);
    if (drift) return drift;
    for (const s of humans) {
      const refused = this.modConsentRefusal(room, s);
      if (refused) return refused;
    }
    if (room.content?.trusted && humans.some(s => s.consentCs !== room.content.cs)) return fail(ERR.PLUGIN_CONSENT);
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    // a room with gameplay plugins, or of another official version, starts once every player's page has loaded and checked
    // its content (the host's too)
    if (room.needsContent && humans.some((s) => s.content !== 'ready')) return fail(ERR.CONTENT_NOT_READY);
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
   * Any seated player may open or cancel the vote (issue #854); the match owns the vote, the per-seat cooldown and the
   * setup replacement itself. A spectator has no seat and therefore nothing to reroll.
   */
  rerollSetup(session, msg, cancel = false) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    const method = cancel ? 'cancelSetupReroll' : 'requestSetupReroll';
    if (!room.match || typeof room.match[method] !== 'function') return fail(ERR.WRONG_PHASE);
    return this.callMatch(room, method, session.playerId, cancel ? msg.voteId : msg.setupRevision) || fail(ERR.INTERNAL);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout — and its per-operator 潜能 / 练度 `ops` (0.2.2) — against the
   * game data, store both on the session and the seat, and — while a match runs — hand them to the match (accepted only
   * during INFO_CHECK, see the header). Either part refused: nothing is stored.
   */
  loadout(session, { entries, ops }) {
    const room = this.roomOf(session);
    // checked against the room's own data: a room with gameplay plugins knows its plugins' operators (header "Gameplay plugins")
    const data = this.dataFor(room);
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const ids = opsCharIds(data);
    const resOps = checkLoadoutOps(ops, (id) => ids.has(id), (id) => charPotentialChanges(data, id));
    if (!resOps || resOps.error) return fail(resOps && isErrCode(resOps.error) ? resOps.error : ERR.BAD_MSG, resOps && resOps.detail);
    const loadout = freezeLoadout(res.loadout);
    const opsSet = freezeOps(resOps.ops);
    const cs = this.settingsCs(room, session.playerId);
    session.loadout = loadout;
    session.ops = opsSet;
    session.loadoutCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.loadout = loadout; seat.ops = opsSet; seat.loadoutCs = cs; }
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      // Preserve named defaults for prep merging: normalisation drops them, but they mean reset this operator.
      r = ruleOption(room.content?.rules, 'prepLoadout') === 'prep'
        ? room.match.setLoadout(session.playerId, entries, ops)
        : room.match.setLoadout(session.playerId, loadout, opsSet);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    // a match in a match host answers later (header "Gameplay plugins")
    if (r && typeof r.then === 'function') return Promise.resolve(r).then(matchAnswer, () => fail(ERR.INTERNAL));
    return matchAnswer(r);
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const room = this.roomOf(session);
    const data = this.dataFor(room);
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    const cs = this.settingsCs(room, session.playerId);
    session.notOwned = list;
    session.notOwnedCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.notOwned = list; seat.notOwnedCs = cs; }
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS — the room's own in a
   * room with gameplay plugins), store them on the session and the seat (see the header). A running match never takes
   * them: it keeps the picks its seat had at its start.
   */
  diy(session, { picks }) {
    const room = this.roomOf(session);
    const res = checkDiyPicks(picks, { data: this.dataFor(room), kitted: this.kittedFor(room) });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    const cs = this.settingsCs(room, session.playerId);
    session.diy = kept;
    session.diyCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.diy = kept; seat.diyCs = cs; }
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.skins (docs/SKINS.md): store the appearances this player chose for their operators, on the session and the
   * seat, and hand them to a running match. A waiting room is shown a changed map (room.state seats[].skins: its seat
   * cards wear them — header 干员皮肤).
   *
   * Unlike room.loadout there is no phase gate. The loadout is frozen at INFO_CHECK because it changes what a unit
   * *does*; a skin changes only what it looks like, and it is public — a teammate switching model mid-match is
   * harmless, and the next `m.public` broadcast carries it to everyone.
   */
  skins(session, { skins }) {
    const room = this.roomOf(session);
    const ids = operatorCharIds(this.dataFor(room));
    const kept = freezeSkins(skins, (id) => ids.has(id));
    if (!kept) return fail(ERR.BAD_MSG, 'bad skin selection');
    session.skins = kept;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) {
      const changed = !sameSkins(seat.skins, kept);
      seat.skins = kept;
      // the waiting room's seat cards wear them (room.state seats[].skins, header); a match shows them in its m.public
      if (changed && !room.match) this.broadcastState(room);
    }
    if (!room.match || !seat) return OK;
    if (typeof room.match.setSkins !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return matchAnswer(this.callMatch(room, 'setSkins', session.playerId, kept));
  }

  /**
   * 名片干员 (room.card): the operator whose portrait fills the player's seat card — a visible charId of the room's
   * chess.json (the server's outside a room), '' for none. Kept on the session and the seat; a change is broadcast to the room.
   * Cosmetic: accepted in any phase, never touches a match.
   */
  card(session, { charId }) {
    const room = this.roomOf(session);
    if (charId && !cardCharIds(this.dataFor(room)).has(charId)) return fail(ERR.BAD_MSG, 'unknown operator');
    session.card = charId || null;
    const seat = room ? room.seatOf(session.playerId) : null;
    if (seat && seat.card !== session.card) {
      seat.card = session.card;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * The game data of a room's content (header "Gameplay plugins", "Official versions"): its content set's, else its
   * version's — outside a room, the server's default version's —, else the server's. Another version's data that cannot
   * be read is logged and nothing (every check then refuses), never 第二期下半's.
   * @param {Room | null} room
   */
  dataFor(room) {
    if (room?.modded) {
      try {
        const d = this.plugins?.dataOf?.(room.content.cs);
        if (d) return d;
      } catch (e) { this.log.error(`[lobby] ${room.code} content data failed`, e); }
    }
    // 房间自己声明的模组集合（W-B，DESIGN §28.10）：`room.modSet` 物化出来的那一份就是这间房的数据面；
    // 没声明集合 / 声明了全集 ⇒ `forRoom` 交回**进程面本体**（同一个对象，`===`），所以那些房逐字节不变。
    // 只有**真的声明了集合**的房间才走这条（`forRoom(null)` 交回的是进程面本体，truthy —— 拿它当判据会把
    // 下面「官方版本」那一支永远挡掉，版本房于是拿到进程面的数据，spec 的 version 与数据对不上）。
    const roomAssets = room && room.modSet && this.workshop && this.workshop.roomAssets
      ? this.workshop.roomAssets.forRoom(room.modSet) : null;
    if (roomAssets) return roomAssets.data;
    // **没有房间**的会话（或做过房间的机制还没选版本）：数据面就是进程本体 `safeData()` —— 它带着工坊叠加，
    // 是「进程面复算」的那一份。房间真的选了别的版本时才读版本数据；拿 defaultVersion() 去顶替会让
    // 无房间会话拿到版本数据、把工坊干员判成未知（test/lobby-room-face.test.js §2 钉着这一条）。
    const v = room ? room.version : null;
    if (v && v !== DEFAULT_VERSION) {
      try {
        const d = this.versions?.data(v);
        if (d) return d;
        this.warnOnce(`[lobby] the data of ${v} is not available`);
      } catch (e) { this.log.error(`[lobby] ${room?.code ?? '----'} the data of ${v} failed`, e); }
      return Object.freeze({});
    }
    return this.safeData();
  }

  /**
   * A room's data face, the ONE place it is chosen (W-B): the room's declared mod set (`roomAssets.forRoom`),
   * else the process singleton — `forRoom(null)` returns the process data itself, so an ordinary room is
   * byte-for-byte today's behaviour.
   * @param {Room | null} room
   */
  roomData(room) {
    const assets = room && this.workshop && this.workshop.roomAssets ? this.workshop.roomAssets.forRoom(room.modSet) : null;
    return assets ? assets.data : this.safeData();
  }

  /** The operators a 自选 slot may field in a room (its content set's list, else the vanilla one). @param {Room | null} room */
  kittedFor(room) {
    if (room?.modded) {
      try {
        const k = this.plugins?.kittedOf?.(room.content.cs);
        if (Array.isArray(k)) return k;
      } catch (e) { this.log.error(`[lobby] ${room.code} content 自选 list failed`, e); }
    }
    return KITTED_CHARS;
  }

  /**
   * The content a setting stored now is checked for: the room's cs, else (outside a room) the server's default version's
   * — the vanilla one unless the server's default is another version. @param {Room | null} room
   */
  csOf(room) { return room?.content?.cs ?? this.baseContent(this.defaultVersion())?.cs ?? this.vanilla?.cs ?? null; }

  /**
   * The stamp of a setting a player sends now (loadout / ownership / diy): csOf(room) — but in a room whose pages must
   * load its content (needsContent) only once the sender's page reported that content ready; before, UNVERIFIED_CS: the
   * page may still show another version's data, whose chess ids name other operators (header "Official versions").
   * A player who switches to a spectator seat keeps that report on the spectator record (becomeSpectator), so a setting
   * sent while watching stays on the room's cs. The seat they take again starts without one.
   * @param {Room | null} room @param {string} playerId
   */
  settingsCs(room, playerId) {
    if (!room || !room.needsContent) return this.csOf(room);
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    return seat && /** @type {any} */ (seat).content === 'ready' ? this.csOf(room) : UNVERIFIED_CS;
  }

  /**
   * The data a setting stamped with `cs` was checked against: the vanilla data, a version's, a content set's — null when
   * none is known (an unverified stamp, a set no longer kept). @param {string | null} cs
   */
  dataOfCs(cs) {
    if (!cs || cs === UNVERIFIED_CS) return null;
    if (this.vanilla && cs === this.vanilla.cs) return this.safeData();
    try {
      const v = this.versions?.dataOfCs?.(cs);
      if (v) return v;
      const p = this.plugins?.dataOf?.(cs);
      if (p) return p;
    } catch (e) { this.log.error(`[lobby] the data of content ${String(cs).slice(0, 8)} failed`, e); }
    return null;
  }

  /**
   * A human seat's stored settings for a match of `room` (header "Gameplay plugins", the design study's §8.9): kept as
   * they are when they were checked for the room's content; filtered to its data otherwise — an id it does not know is
   * dropped, the rest kept (never the whole setting refused). A loadout or 干员持有 list checked for another data set also
   * loses every chess id whose operator (charId) differs between the two (header "Official versions": chess ids are
   * reused across versions); in a room of another version than 第二期下半, one whose data is unknown (an unverified
   * stamp) is dropped whole.
   * @param {Room} room @param {Seat} s @param {Readonly<Record<string, any>>} data
   */
  seatSettings(room, s, data) {
    const cs = this.csOf(room);
    const vanillaCs = this.vanilla?.cs ?? null;
    const other = (checked) => !!cs && (checked ?? vanillaCs) !== cs;
    const versioned = room.version !== DEFAULT_VERSION;
    let loadout = s.loadout || null;
    let ops = s.ops || null;
    let notOwned = s.notOwned || null;
    let diy = s.diy || null;
    const chess = (id) => lookup('chess', id, data);
    /** the chess ids of `from` whose operator is the room data's too (null `from`: every id) */
    const sameOperator = (from, id) => !from || (lookup('chess', id, from)?.charId ?? null) === (chess(id)?.charId ?? undefined);
    if (loadout && other(s.loadoutCs)) {
      const from = this.dataOfCs(s.loadoutCs ?? vanillaCs);
      const keep = {};
      if (from || !versioned) {
        for (const [id, e] of Object.entries(loadout)) {
          if (!sameOperator(from, id)) continue;
          const r = checkLoadout({ [id]: { skill: e.skill, ...(e.module != null ? { module: e.module } : {}) } }, chess);
          if (r && !r.error && r.loadout[id]) keep[id] = r.loadout[id];
        }
      }
      loadout = freezeLoadout(keep);
      const ids = opsCharIds(data);
      const changes = (x) => charPotentialChanges(data, x);
      const keepOps = {};
      for (const [id, e] of Object.entries(ops || {})) {
        // a 潜能 that changes nothing on this content's operator (a plugin's char_x_ without a curve) is dropped, its 练度
        // kept — as the page's sanitizeOps does (public/js/ui/loadoutModel.js)
        const one = changes(id) === false ? { cultivate: e.cultivate } : { potential: e.potential, cultivate: e.cultivate };
        const r = checkLoadoutOps({ [id]: one }, (x) => ids.has(x), changes);
        if (r && !r.error && r.ops[id]) keepOps[id] = r.ops[id];
      }
      ops = freezeOps(keepOps);
    }
    if (notOwned && other(s.notOwnedCs)) {
      const from = this.dataOfCs(s.notOwnedCs ?? vanillaCs);
      const r = from || !versioned ? checkNotOwned(notOwned.filter((id) => sameOperator(from, id)), chess) : null;
      notOwned = r && !r.error ? Object.freeze(r.notOwned.slice()) : null;
    }
    if (diy && other(s.diyCs)) {
      const r = checkDiyPicks({ ...diy }, { data, kitted: this.kittedFor(room) });
      diy = r && 'ok' in r ? freezeDiy(r.picks) : null;
    }
    // 干员皮肤 (docs/SKINS.md): the skinId lives in a cosmetic overlay, not the content set, but the KEY is an operator
    // of this room. A charId the content does not have is dropped; a map that is no longer a plain charId→skinId
    // selection is left off the seat rather than handed to the match.
    let skins = null;
    if (s.skins && typeof s.skins === 'object') {
      const ids = operatorCharIds(data);
      const res = checkSkinSelection(s.skins, (id) => ids.has(id));
      if (res.ok) skins = Object.freeze({ ...res.skins });
    }
    return { loadout, ops, notOwned, diy, skins };
  }

  /**
   * Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`) and the
   * server's content identity (header "Content identity").
   */
  welcomeInfo() {
    let info;
    if (!this.vanilla) info = { diyKitted: KITTED_CHARS };
    else {
      let n;
      try { n = Number(this.plugins?.unofficial?.()) || 0; } catch { n = 0; }
      info = { diyKitted: KITTED_CHARS, content: n > 0 ? { vanilla: this.vanilla.cs, plugins: n } : { vanilla: this.vanilla.cs } };
      // Catalogue metadata, never part of a room or match; omitted when no loaded plugin publishes a notice.
      if (this.plugins?.hasNotices?.()) info.content.notices = true;
    }
    // the official versions (header "Official versions"): only when the server offers more than 第二期下半, so a
    // welcome from a server narrowed to that version alone stays without `versions`
    let versions = null;
    try { versions = this.versions?.welcome?.() || null; } catch (e) { this.log.error('[lobby] the versions list failed', e); }
    if (versions) info.versions = versions;
    // 本房座位上限 (业主裁令 2026-10-12): **总是发** —— 缺省上限已经是 20（不是官方 `MAX_SEATS`）。
    // ⚠️ `this.opts` 在单元测试里可能没有（测试直接调 `welcomeInfo.call({ vanilla, plugins })`）⇒ 那时不发。
    if (this.opts) info.maxSeats = this.opts.maxSeats;
    // 创意工坊：集合 / 面板清单 / 素材清单 / 主题 / 传输档 —— 没有包声明时**一个键都不多**
    if (this.modSet) info.mods = this.modSet;
    {
      const panels = this.workshop && Array.isArray(this.workshop.panels) ? this.workshop.panels : [];
      const assets = this.workshop && Array.isArray(this.workshop.assets) ? this.workshop.assets : [];
      const theme = this.workshop && this.workshop.theme && typeof this.workshop.theme === 'object' ? this.workshop.theme : null;
      const transport = this.workshop && this.workshop.transport && typeof this.workshop.transport === 'object' ? this.workshop.transport : null;
      if (panels.length) info.modPanels = panels;
      if (assets.length) info.modAssets = assets;
      if (theme && theme.vars && Object.keys(theme.vars).length) info.modTheme = theme;
      if (transport) info.transport = transport;
    }
    // Omitted when the switch is off, so a welcome from a normal server stays identical.
    if (this.testEnabled === true) info.testMode = true;
    return info;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    if (room.test && !this.testEnabled) return fail(ERR.TEST_DISABLED);
    // another official version's match runs in that version's match host — never here, where every module singleton
    // holds 第二期下半's data (header "Official versions"); a test that gave its own MatchClass runs it in place
    const versioned = room.version !== DEFAULT_VERSION;
    if (versioned && !(room.modded ? this.hosts : this.versionHosts) && this.MatchClass === DefaultMatch) {
      this.log.error(`[lobby] ${room.code} has no match host for ${room.version}`);
      return fail(ERR.INTERNAL, 'no match host for this version');
    }
    // (room.start refuses during a vote; a start from elsewhere voids it)
    if (room.versionVote) this.voidVersionVote(room, 'members');
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    // the room's data: its content set's in a room with gameplay plugins (header "Gameplay plugins")
    const data = this.dataFor(room);
    const seats = room.seats.filter(Boolean).map((s) => {
      // a setting checked for another content is filtered to this room's data (header "Gameplay plugins")
      const own = s.isBot ? null : this.seatSettings(room, s, data);
      return {
        seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
        // DESIGN §16: the human's checked operator loadout and (0.2.2) per-operator 潜能 / 练度 (bots fight with the defaults)
        loadout: own ? own.loadout : null,
        ops: own ? own.ops : null,
        // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
        notOwned: own ? own.notOwned : null,
        // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
        diy: own ? own.diy : null,
        // 干员皮肤 (docs/SKINS.md): the appearances the human wears, keyed by operator charId (bots always default)
        skins: own ? own.skins : null,
        // 助战 (DESIGN §28.31): the support chess this seat ticked. It lives on the **seat** (`room.support` writes
        // it), not in seatSettings —— 少了这一个键，Match 的 supportSupply 永远是空的（棋盘上就不再出现助战棋子）。
        support: Array.isArray(s.support) ? s.support : null,
      };
    });
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    const modded = room.modded;
    // 这一房的物化结果（W-B）：数据 / kit / 模块清单都来自 `roomAssets.forRoom(room.modSet)`。没声明集合（或
    // 声明了全部）时它返回的正是进程级那一份**本体**，那种房间与从前逐字节相同；一个包都没装时 `roomAssets`
    // 根本不存在，走 `this.workshop` 那三个字段 —— 干净安装的 opts 因此不多一个键。
    const assets = this.workshop && this.workshop.roomAssets ? this.workshop.roomAssets.forRoom(room.modSet) : null;
    try {
      const opts = {
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        // a plugin mode the host chose (header "Gameplay plugins"), a laddered room's official mode (规程's solo), else the
        // official mode of the difficulty
        modeId: room.content?.modeId || room.modeId || modeIdFor(room.mode, room.difficulty),
        // 「AI 队友最后选择」 (GitHub #338): fixed for the match
        aiPicksLast: room.mode !== 'solo' && room.aiPicksLast === true,
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        // the room's host: the current executor of a delegated bot layout rehearsal (DESIGN §14; setHost follows a
        // migration while the match runs)
        hostId: room.hostId,
        // only a room created as a test room; a normal match opts object does not grow a test key
        ...(room.test === true ? { test: true } : {}),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        // the room's content hash (header "Content identity"): copied into every BattleSpec; its visual set too (a
        // replay names the art), and with gameplay plugins a b.result must name the room's cs (header "Gameplay plugins")
        ...(room.content ? { cs: room.content.cs } : {}),
        ...(room.content?.vs ? { vs: room.content.vs } : {}),
        ...(modded || versioned ? { requireCs: true } : {}),
        // another official version (header "Official versions"): its registry id; a default room's opts keep their keys
        ...(versioned ? { version: room.version } : {}),
        // 「不限时」 (header): only while the room's flag is on, so a default match's opts keep their keys
        ...(room.mode === 'solo' && room.soloUnlimited === true ? { soloUnlimited: true } : {}),
        // The list the lobby just checked the picks with (kittedFor). Vanilla rooms omit it: setDiy stays on
        // KITTED_CHARS, and the worker payload / test journal of a normal match do not grow a key.
        ...(modded ? { kitted: this.kittedFor(room) } : {}),
        ...(room.content?.rules ? { rules: room.content.rules } : {}),
        // 工坊行为层：同一份 kits 必须同时到达服务端跑的这一局与浏览器跑的那一份。
        // 干净安装（没有 roomAssets、也没有装包）时这三个键都不出现 —— 默认房间的 opts 与从前逐字节相同。
        ...(assets || this.workshop ? {
          workshopKits: assets ? assets.kits : (this.workshop && this.workshop.kits ? this.workshop.kits : null),
          workshopKitModules: assets ? assets.modules : (this.workshop && Array.isArray(this.workshop.modules) ? this.workshop.modules : []),
          workshopTokenKits: assets ? assets.tokenKits : (this.workshop && this.workshop.tokenKits ? this.workshop.tokenKits : null),
        } : {}),
        // 「谁的 kit 账上算一次」正是靠这两张表 —— 与 workshopKits 同一条纪律：只在真的装了包时才有值。
        ...(this.workshop && this.workshop.kitOwners ? { workshopKitOwners: this.workshop.kitOwners } : {}),
        ...(this.workshop && this.workshop.tokenKitOwners ? { workshopTokenKitOwners: this.workshop.tokenKitOwners } : {}),
        ...(this.workshop && this.workshop.kitBudgets ? { workshopKitBudgets: this.workshop.kitBudgets } : {}),
        // 这一局跑的是**房间**声明的字节（W-A/W-B），不是进程那一份。干净安装（两边都没有集合）时
        // 这个键根本不出现 —— 默认房间的 opts 因此与从前逐字节相同（test/lobby-versions 钉着）。
        ...(room.modSet || this.modSet ? { mods: room.modSet || this.modSet } : {}),
        data,
        log: this.log,
        now: this.now,
        // the server's own simulation pool (server/workers/roomPool.js) for bot rehearsals, when the operator started
        // one: null keeps every rehearsal on this thread, exactly as before (Match.simPool / MatchRehearsal.poolRehearsal)
        ...(!modded && !versioned && this.simPool ? { simPool: this.simPool } : {}),
        send: (playerId, msg, encoded) => (ctx.live ? this.matchSend(room, ctx, playerId, msg, encoded) : false),
        broadcast: (msg, encoded) => { if (ctx.live) this.matchBroadcast(room, ctx, msg, encoded); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      };
      // a room with gameplay plugins plays in its content set's match host, a room of another official version in that
      // version's; every other room here, as always
      const match = modded && this.hosts ? this.hosts.create(room.content.cs, opts)
        : versioned && this.versionHosts ? this.versionHosts.create(room.content.cs, opts)
          : new this.MatchClass(opts);
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed}${room.test ? ', test' : ''}${modded ? `, content ${room.content.cs.slice(0, 8)}${match.hosted ? ' in its match host' : ''}` : ''}${versioned ? `, version ${room.version}${match.hosted ? ' in its match host' : ''}` : ''})`);
      this.broadcastState(room);
      match.start();
      // 房间级钩子（§28.20）：**一局真的起来了**（`match.start()` 已经跑完、没有抛）。
      this.hookFire(room, 'matchStart', {
        matchNo: room.matchCount, mode: room.mode, difficulty: room.difficulty, seed,
        players: room.seats.filter(Boolean).map((s) => s.playerId),
        spectators: room.spectators.map((s) => s.playerId),
      });
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) {
        resetAiTakeover(room);
        room.match = null; room.matchCtx = null; room.matchKey = null;
      }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      // 房间级钩子（§28.20）：这一局**没起来**。包在 `matchStart` 里挂过的一次性东西有这一条可以收回；
      // 它不是 `matchEnd` —— 那个事件说的是「打过的一局结束了」，与一个从没开始的对局是两件事。
      this.hookFire(room, 'matchFailed', { matchNo: room.matchCount + 1, error: e && e.message ? e.message : String(e) });
      // the match hosts refuse one content set more than they run (PLUGIN_BUSY: server/match/host/index.js)
      return fail(e && isErrCode(e.code) ? e.code : ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    resetAiTakeover(room);
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    // 房间级钩子（§28.20）：**这一局结束了**。位置在两处清理之前 —— 座位还没被腾空、断线的人还没进宽限，
    // 所以包拿到的还是「刚打完」的那张座位表；`disposed` 若跟着来（房间空了），包看到的是 matchEnd → dispose。
    this.hookFire(room, 'matchEnd', {
      matchNo: room.matchCount,
      summary: room.lastSummary,
      victory: !!(room.lastSummary && room.lastSummary.victory),
      players: room.seats.filter(Boolean).map((s) => s.playerId),
      spectators: room.spectators.map((s) => s.playerId),
    });
    // a match of gameplay plugins, or of an official version, whose match host stopped (header "Gameplay plugins",
    // "Official versions"; its members were told: proxy.js)
    const why = summary && typeof summary.reason === 'string' && /^(?:plugin|version)-/.test(summary.reason) ? ` (${summary.reason}${summary.detail ? `: ${summary.detail}` : ''})` : '';
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended${why}`);
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
    else {
      this.broadcastState(room);
      // its plugins changed on disk during the match: the host can apply them again now
      if (room.pluginsChanged) this.tellPluginsChanged(room);
    }
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg, encoded = null) {
    if (msg && msg.t === 'm.result') {
      const data = encoded ?? encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg, encoded);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg, encoded = null) {
    if (msg.t === 'm.public') afterReconcile(this, room, reconcileAiTakeover(this, room));
    const data = this.broadcastRoom(room, msg, encoded);
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
    // in order with the room's messages when its match runs in a match host (header "Gameplay plugins")
    if (this.queuedRoom(session)) { this.queueEvent(room, () => this.resyncNow(session)); return; }
    this.resyncNow(session);
  }

  /** runResync, now. @param {import('./net.js').Session} session */
  resyncNow(session) {
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

  /** A warning logged once per text (the default plugins that cannot be applied …). @param {string} line */
  warnOnce(line) {
    if (this.told.has(line)) return;
    if (this.told.size < 256) this.told.add(line);
    this.log.warn(line);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /**
   * Route a 'g.*' intent or a 'b.*' report (server/net.js) to the running match — on the room's queue when its match runs
   * in a match host (header "Gameplay plugins").
   */
  routeGame(session, msg) {
    const room = this.queuedRoom(session);
    return room ? this.serial(room, () => this.routeGameNow(session, msg)) : this.routeGameNow(session, msg);
  }

  /** routeGame, now. */
  routeGameNow(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (msg.t === 'g.test') {
      if (!this.testEnabled) return fail(ERR.TEST_DISABLED);
      if (room.test !== true) return fail(ERR.TEST_FORBIDDEN);
    }
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && !(room.test && msg.t === 'g.test') && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
      afterReconcile(this, room, reconcileAiTakeover(this, room));
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // a match in a match host answers later (header "Gameplay plugins"): the reply waits for it
      if (room.match?.hosted === true) {
        return Promise.resolve(res).then((r) => matchAnswer(r), (e) => {
          this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e);
          return fail(ERR.INTERNAL);
        });
      }
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    return matchAnswer(res);
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

  /**
   * How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime — the room's version's
   * (header "Official versions": 第一期 has none, so the 24 h figure below) —, else 24 h. The 24 h fallback is a
   * carried-over convenience [ASSUMED]: 第一期's constData never gained singleReconnectTime, and M2 did not add it.
   * The code path is unchanged (§37.23.10). It is not official 第一期 data, and it is not "because the solo is untimed"
   * — a 第一期 solo is timed unless the room's 「不限时」 is on.
   * @param {Room | null} [room]
   */
  soloResumeWindowMs(room = null) {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const data = room && room.version !== DEFAULT_VERSION ? this.dataFor(room) : this.safeData();
    const sec = data?.config?.constants?.singleReconnectTime;
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

  /**
   * A human seat for `session` in `room`. The card is checked against the room's operators (header 名片干员): one the
   * room's content lacks is left off the seat, never cleared from the session.
   * @param {number} idx @param {any} session @param {Room} room
   * @returns {Seat}
   */
  humanSeat(idx, session, room) {
    const card = session.card && cardCharIds(this.dataFor(room)).has(session.card) ? session.card : null;
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
      ops: session.ops || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
      // 干员皮肤 (docs/SKINS.md): the appearances this player wears, keyed by operator charId (PUBLIC: the match
      // publishes them to teammates)
      skins: session.skins || null,
      // 助战 (DESIGN §28.31): 勾选的助战棋子。选择可以在**建房之前**就发生（`room.support` 在没房时只写 session），
      // 所以座位创建时要把 session 上那一份带过来 —— 否则开局建构 Match 时 supportSupply 永远是空的。
      support: Array.isArray(session.support) ? session.support : null,
      // 名片干员 (room.card): the operator on this player's seat card (PUBLIC: room.state seats[].card)
      card,
      // the content each was checked for (header "Gameplay plugins": filtered at the match start when it is another)
      loadoutCs: session.loadoutCs ?? null,
      notOwnedCs: session.notOwnedCs ?? null,
      diyCs: session.diyCs ?? null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    // 房间级钩子（§28.20）：**离开**在座位真的被释放**之前**触发 —— 此刻 `by` 还是这个人的那个座位，
    // 所以包看到的是「谁走了」而不是「少了一个人」。离开、踢人、观战者被移除、大厅宽限超时都走这里。
    const leaving = room.hookPlayer(playerId);
    if (leaving) this.hookFire(room, 'leave', { by: leaving });
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
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
      // a player seat freed: the version vote is void (header "Official versions")
      if (room.versionVote) this.voidVersionVote(room, 'members');
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
    // a host change voids the version vote (header "Official versions") — defensive: while a vote is open (no match) the
    // host only changes by leaving, kick or grace timeout, whose freed seat voided it already (removeMember)
    if (room.hostId !== prev && room.versionVote) this.voidVersionVote(room, 'members');
    // a running match follows the host change: its delegated bot rehearsals fall back to the server and later ones ask
    // the new host (DESIGN §14, Match.setHost)
    if (room.match && room.hostId !== prev) this.callMatch(room, 'setHost', room.hostId);
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
    this.peerRelay.clear(room);
    room.disposed = true;
    if (this.rooms.get(room.code) === room) { this.trustedRuntime?.event('roomClosed',{room:room.toState(null, this.now())}); this.rooms.delete(room.code); }
    // an open version vote ends with the room (its timer)
    if (room.versionVote) { clearTimeout(room.versionVote.timer); room.versionVote = null; }
    const ctx = room.matchCtx;
    resetAiTakeover(room);
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
    // the room's visual set and content set are no longer held by it (server/plugins/visualSet.js, contentSets.js)
    this.releaseContent(room.content);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
    // 房间级钩子（§28.20）：**最后一个事件**，放在这里而不是函数开头 —— `room.closed` 已经发给还连着的成员，
    // 而这时包仍然读得到那张座位表（座位还在数组里、只是会话已经脱离了房间）。这是唯一在
    // `room.disposed === true` 之后触发的事件：它的意思正是「这个房间没了」。
    this.hookFire(room, 'dispose', { reason, room: room.hookSnapshot() });
    // 这个房间的钩子表随房间一起消失：一张按房间码索引的表不能留住已经没了的房间（码会被 genCode 用掉，
    // 留下旧条目就是让下一个同码的房间继承上一个的钩子）。
    this.roomHooks.forget(room);
  }

  genCode(yieldingRoom = null) {
    // create() may reuse its caller's sole-human room only after validation; no membership changes here.
    const fixed = this.opts.roomCode || null;
    if (fixed) return this.rooms.has(fixed) && this.rooms.get(fixed) !== yieldingRoom ? null : fixed;
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
    const rec = reconcileAiTakeover(this, room);
    // A version host answers the eligibility read later. Publish once that read has cancelled what it should.
    // An in-process match returns a boolean, so this send stays synchronous.
    if (rec && typeof rec.then === 'function') {
      rec.then(() => { if (!room.disposed) this.emitRoomState(room); }, (e) => {
        this.log.error(`[lobby] ${room.code} AI handover reconcile failed`, e);
        if (!room.disposed) this.emitRoomState(room);
      });
      return;
    }
    this.emitRoomState(room);
  }

  /** room.state after AI-handover votes have been reconciled. */
  emitRoomState(room) {
    if (room.disposed) return;
    if (this.trustedRuntime) {
      const state = room.toState(null, this.now()), prev = room.trustedPrevious;
      const event = (name,extra={}) => this.trustedRuntime.event(name,{room:state,...extra});
      if (!prev) event('roomCreated');
      const before = new Set((prev?.seats || []).filter(Boolean).map(s => s.playerId));
      const after = new Set(state.seats.filter(Boolean).map(s => s.playerId));
      for (const id of after) if (!before.has(id)) event('playerJoined',{playerId:id});
      for (const id of before) if (!after.has(id)) event('playerLeft',{playerId:id});
      if (state.inMatch && !prev?.inMatch) event('matchStarted');
      room.trustedPrevious = state;
    }
    this.peerRelay.sync(room, [...this.memberSessions(room)]);
    const data = encode(room.toState(this.supportView(room), this.now()));
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  sendState(room, session) {
    this.peerRelay.sync(room, [...this.memberSessions(room)], session);
    sendSession(session, room.toState(this.supportView(room), this.now()));
  }

  /** The room's delivery stream: one order shared by the WebSocket and the peer path. */
  publicStream(room) {
    let stream = this.publicDeliveries.get(room);
    if (!stream) {
      stream = { epoch: randomBytes(16).toString('hex'), seq: 0 };
      this.publicDeliveries.set(room, stream);
    }
    return stream;
  }

  /**
   * Append the room's delivery stamps to bytes a caller already produced (a lane Worker's m.public). Splicing them
   * into the finished JSON keeps the pass-through: the public view is still serialized exactly once per broadcast.
   * Bytes that are not a JSON object come back unchanged — that frame carries no cross-transport order to honour.
   * @param {string} bytes @param {string} epoch @param {number} seq
   * @returns {string}
   */
  stampPublicBytes(bytes, epoch, seq) {
    const end = bytes.lastIndexOf('}');
    if (end < 0) return bytes;
    let view;
    try { view = JSON.parse(bytes); } catch { return bytes; }
    if (!view || typeof view !== 'object' || Array.isArray(view)) return bytes;
    return `${bytes.slice(0, end)},"deliveryEpoch":${JSON.stringify(epoch)},"deliverySeq":${seq}}`;
  }

  /**
   * A public view joins the room's delivery stream: the peer route signs and forwards these stamped bytes, so a
   * delayed copy from either transport can never overwrite newer state. Inert while `SP_P2P` is not enabled, which
   * leaves the wire byte-identical with the merged state-delta transport (it owns its own per-connection baseline).
   * @param {object} room @param {object} msg @param {string | null} [encoded] bytes a caller already produced
   * @returns {{ msg: object, bytes: string }}
   */
  stampPublic(room, msg, encoded = null) {
    if (!this.peerRelay.enabled || msg?.t !== 'm.public') return { msg, bytes: encoded ?? encode(msg) };
    const stream = this.publicStream(room);
    const deliverySeq = ++stream.seq;
    const bytes = this.stampPublicBytes(encoded ?? encode(msg), stream.epoch, deliverySeq);
    return { msg: { ...msg, deliveryEpoch: stream.epoch, deliverySeq }, bytes };
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg, encoded = null) {
    if (room.disposed) return null;
    let data = encoded ?? encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const stamped = this.stampPublic(room, msg, data);
    msg = stamped.msg;
    data = stamped.bytes;
    const members = [...this.memberSessions(room)];
    // Peer delivery (server/peerRelay.js) takes the relay and its ready receivers out of the loop below: the relay
    // gets the signed frame over its own socket (never compressed into a delta — it forwards these exact bytes) and
    // each ready receiver is served by the channel, with the lobby's watchdog re-sending over WebSocket on timeout.
    const routed = this.peerRelay.enabled && msg.t === 'm.public' ? this.peerRelay.broadcast(room, members, data) : null;
    // per connection: sendSession runs the state transport, which owns each socket's delta baseline (and the
    // droppable/backpressure rules) - one shared byte string in, one frame per member out
    for (const session of members) {
      if (routed?.has(session)) continue;
      sendSession(session, msg, data);
    }
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg, encoded = null) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    // A unicast m.public joins the room's delivery stream too (its stamps order it against peer frames).
    const stamped = this.stampPublic(room, msg, encoded ?? encode(msg));
    return sendSession(session, stamped.msg, stamped.bytes);
  }
}
