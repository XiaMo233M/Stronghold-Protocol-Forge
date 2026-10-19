// server/match/Match.js — the match & meta engine: state machine, timers, round loop, co-op orchestration,
// broadcasting views (DESIGN §6, §8). Rules are documented in the module headers of ./PlayerState.js, ./pool.js,
// ./board.js, ./bondsMeta.js, ./effectsMeta.js, ./choices.js, ./waves.js, ./unite.js, ./finalAssault.js,
// ./results.js, ./bot.js and in docs/META.md.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// MATCH INTERFACE (platform contract: server/lobby.js ⇄ server/match/Match.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// new Match(opts)
//   opts.roomCode    string                     4-letter room code (logging only)
//   opts.mode        'solo' | 'coop'
//   opts.difficulty  'FUNNY'|'NORMAL'|'HARD'|'ABYSS'
//   opts.modeId      string                     modeIdFor(mode, difficulty), e.g. 'mode_multi_hard'
//   opts.aiPicksLast boolean (optional)         the co-op room option 「AI 队友最后选择」 (room.setAiPicksLast, GitHub #338):
//                                              the strategy and 机变 drafts put every human seat before every AI seat
//                                              (MatchPhases.humansFirst); only `true` turns it on; ignored in solo
//   opts.seats       Array<{ seat: 0..3, playerId: string, name: string, isBot: boolean, connected: boolean,
//                            loadout?: { [baseChessId]: { skill: index, module: uniEquipId|'none'|null } } | null,
//                            ops?: { [charId]: { potential: 1–6, cultivate: 0–3 } } | null,
//                            notOwned?: string[] | null,
//                            diy?: { [slotBaseId]: { charId, skillIndex, uniEquipId } } | null }>
//                    sorted by seat, 1–4 entries, ≥ 1 human; solo ⇒ exactly 1 human and no bots.
//                    Bot playerIds start with 'ai_'. Seat indexes may have gaps (e.g. seats 0 and 2).
//                    `loadout` (DESIGN §16, optional): the human's operator loadout, already checked by the lobby
//                    (shared/protocol.js checkLoadout); PlayerState re-checks it against opts.data and ignores it for bots.
//                    `ops` (0.2.2, optional): the human's per-operator 潜能 / 练度 (checkLoadoutOps; missing = 潜能 6, 精英2
//                    Lv.60 — the owner's decision of 2026-10-08), re-checked and changed like the loadout (INFO_CHECK);
//                    bots fight with the defaults.
//                    `notOwned` (0.2.0 补位, optional): the base chess ids the human marked as not owned (干员持有) — fixed
//                    for the match; those chess fight as their stand-ins (PlayerState setNotOwned; bots own everything).
//                    `diy` (0.2.0 自选编队, optional): the human's 自选 picks (shared/protocol.js checkDiyPicks) — fixed for
//                    the match; the slotted operators join the human's own shop (PlayerState setDiy / initDiyStock).
//   opts.kitted      string[] (optional)        the operators a 自选 slot may field in this room (the content set's
//                                              list, lobby.kittedFor). Absent on a vanilla match, so setDiy keeps
//                                              KITTED_CHARS and a normal match stays byte-identical. A modded room
//                                              always passes it (local match, match host, test journal / replay).
//   opts.spectators  string[] (optional)        the room's spectator seats (remake feature, community report #26;
//                                              server/lobby.js): never players — see addSpectator below
//   opts.hostId      string (optional)          the room's current host (server/lobby.js room.hostId): the executor a
//                                              bot layout rehearsal is delegated to (DESIGN §14, botRehearsalDelegate);
//                                              setHost follows a migration while the match runs
//   opts.seed        uint32                     master seed for all match randomness
//   opts.matchNo     integer ≥ 1 (optional)     the room's match number (lobby: room.matchCount + 1); with the seed it
//                                              makes this match's battleIds unique within the room (DESIGN §14)
//   opts.cs          string (optional)          the content hash of the room's content set (DESIGN §34,
//                                              server/plugins/identity.js; 64 hex digits): copied into every BattleSpec
//                                              as `cs` — the sim never reads it; absent (or malformed) ⇒ specs carry none
//   opts.vs          string (optional)          the room's visual set of cosmetic plugins (DESIGN §34.6; 64 hex digits):
//                                              copied into every BattleSpec as `vs` (replays name the art) — never read
//   opts.requireCs   boolean (optional)         a room with gameplay plugins (DESIGN §34.6; the lobby sets it, the match
//                                              then runs in a match host, server/match/host/): a b.result whose
//                                              `cs` is missing or not opts.cs is refused like an implausible one — the
//                                              server simulates that battle itself
//   opts.data        frozen game data (server/data.js getData()); may lack keys while data is generated
//   opts.log         { info, warn, error, debug }
//   opts.now         () => ms epoch             injectable clock (Date.now in production)
//   opts.send(playerId, msg) → boolean          unicast; never throws; silently drops for bots, disconnected
//                                              or departed players (they get a full resync on reconnect).
//                                              `b.snap` frames may be dropped under backpressure.
//   opts.broadcast(msg) → void                  to every connected, non-departed human of the room.
//   opts.onEnd(summary) → void                  call EXACTLY ONCE when the match is over, after m.result was
//                                              sent. The platform then (synchronously) returns the room to
//                                              LOBBY and (asynchronously, next macrotask) calls dispose().
//                                              `summary` is free-form JSON (kept as room.lastSummary).
//
// start()                   Called once, right after construction. Must broadcast the first m.public and send
//                           each human its m.private. May call onEnd synchronously (the platform copes).
// handle(playerId, msg)     A validated 'g.*' intent or client-side combat report 'b.progress' / 'b.result'
//                           (msg passed validateC2S; never 'g.leave', which the
//   → { ok: true }          platform turns into onLeave). Return { error: ERR code (shared/constants.js),
//   | { error, detail? }    detail?: string } to reject. Must not throw (if it does, the platform logs and
//                           replies ERR.INTERNAL). Replies ('ok'/'error' with rid) are sent by the platform.
// onDisconnect(playerId)    A human's socket dropped. The seat is kept; apply the auto-play policy.
// onReconnect(playerId)     The human is back (new socket with its token) or re-sent hello on a live socket
//                           (a resync request). May be called without a preceding onDisconnect. Resend full
//                           state: m.public, m.private and, if a battle is on (client-side combat), the
//                           b.start of the field the player is on / watching (server-run mode: m.field + b.snap).
// setLoadout(playerId, loadout, ops?) → { ok } | { error, detail? }   (DESIGN §16; optional for the platform) a new
//                           checked operator loadout (and its 潜能 / 练度 `ops`, 0.2.2) from room.loadout. Accepted only
//                           during INFO_CHECK (the briefing's 干员调配 entry); afterwards the match's loadout is locked
//                           (WRONG_PHASE). A room whose prepLoadout rule is prep also accepts one merge during PREP
//                           while that seat has not pressed 准备 (DESIGN §36.15).
// onLeave(playerId)         The human quit permanently (g.leave, room.leave, or the 10-minute reconnect
//                           window expired). They will never return under this playerId in this match;
//                           treat as quit (AI takes over / eliminated per DESIGN). No onDisconnect follows.
// dispose()                 Stop every timer/interval and release resources. Idempotent. After dispose the
//                           platform ignores send/broadcast/onEnd from this instance.
// addSpectator(id)          (optional for the platform) A spectator seat joined during the match, came back or asked
//                           for a resync: register it (idempotent) and resend what an ELIMINATED player watching sees —
//                           m.public and, while a battle runs, the b.start (watch) of the field it watches (default: the
//                           field of the player it follows — the one it last watched, else the first player still in;
//                           server-run mode: m.field + b.snap), in a prep phase that player's board (m.field prep), or
//                           m.result once ended. A spectator gets
//                           every broadcast through the platform, never an m.private / m.toast / m.unitStats, is never
//                           a field's player or authority, and is shown fields like an eliminated player in every phase.
//                           handle(id, msg) answers only its 'g.watch' (anything else → SPECTATOR; the platform routes
//                           nothing else of it).
// removeSpectator(id)       The spectator left (room.leave / g.leave, removed by the host, reconnect window expired).
// setHost(playerId)         The room's host changed (server/lobby.js migrateHost; optional for the platform): the
//                           current executor of a delegated bot rehearsal (opts.hostId / opts.botRehearsalDelegate) —
//                           a running task of the previous host falls back to the server, later ones ask the new host.
//
// Bot seats never produce intents or hooks: the match drives bots itself (server/match/bot.js).
// Messages the match emits are the S2C 'm.*' / 'b.*' frames of DESIGN §8.2 (room.* frames are platform-owned).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Client-side combat (DESIGN §14; the default): every battle is described by a JSON BattleSpec (server/sim/spec.js).
// A normal field's owner (a connected human) simulates it in the browser and reports b.progress / b.result; a 联防 or
// boss pair field is simulated by its lowest-seat connected human (the other humans run display-only replicas).
// Bots, departed / disconnected players and fields without a connected human are simulated by the server: normal and
// 联防 fields headlessly at once (the result is released at the battle's natural end for the teammates' progress UI),
// boss fields in real time without snapshots (they share the pool). A silent authority (deadline = time limit + 15 s)
// or a disconnected one loses the field to the server, which re-simulates the spec; an implausible b.result is
// replaced by the server's own simulation (fields.js validateClientResult). The shared boss pool, the team LP and the
// overtime drain live here (b.pool ≤ 4 Hz, b.end; m.public follows a boss fight at ~1 Hz); the first end condition the
// server registers decides the Final Assault (pool 0 → victory, team LP 0 → defeat; nothing reported after a defeat is
// credited — _finalEnding, user playtest #6 item 5). No b.snap / b.ev is sent in
// this mode; g.watch hands out specs. battleIds are `<seed36>[-<matchNo36>].<round>.<seq>[.<fieldId>]` (≤ 64 chars):
// unique across the matches of a room, so a report that crossed into the next match is ignored like any stale one; a
// duplicate b.result (a browser re-sending one it believes lost) is answered ok and changes nothing.
// Bot layout rehearsals (opts.botRehearsalDelegate, off by default): a bot prep's candidate layouts go to the current
// host's browser as one b.rehearsal frame — its module Worker simulates them off the page's main thread with the same
// sim, seeds and scoring and answers b.rehearsalResult with the index of its pick (server/sim/rehearsal.js). A timeout,
// a host that changed / disconnected / left or a task this client cannot run makes the server simulate the very same
// candidates itself; the task is dropped either way, so a late answer is ignored (server/match/match/rehearsal.js).
// Solo pause (g.pause { on }, setPause): freezes the field clocks, result deadlines, server release timers, the boss
// clock and the server pacers; m.public.paused; resume shifts every clock / deadline by the pause.
// Live LP (user playtest #3 item 2): during COMBAT / 联防 m.public players[].pendingLp = min(lpCapPerRound, the counted
// leaks of the player's own battle so far) (_pendingLpView; omitted when 0) — the teammates' rows of the team panel
// show lp − pendingLp; the settlement lands with the SETTLE view, where it is gone. 联防 (user playtest #6 item 7): a
// leaker's players[].uniteLeft = its enemies still standing on the 联防 field (not spawned yet, alive, or through again;
// uncapped, live: the authority's b.progress `left`, the server-run timeline or battle; exact once the field has its
// result — _uniteLeft) and pendingLp = min(lpCapPerRound, uniteLeft): the counter falls as the helpers kill them (and
// rises when one of them splits or summons — the children are billed to the same leaker).
// User playtest #4: a match with a single human (独立模拟, or a 同盟 room started alone / with AI teammates) times no
// phase outside its battles (soloUntimed); the co-op strategy draft has ONE countdown — BAND_TURN_SECONDS per turn,
// published as m.public.deadline — AI seats pick at once and a turn that runs out takes the highlighted strategy
// (g.bandFocus → timeoutBand); g.unitStats answers m.unitStats: the stats the board's units start their next battle with.
//   opts.clientCombat  default true (env SP_COMBAT=server → false: the legacy server-run + snapshot streaming mode)
//   opts.verify        'off' | 'sample' | 'all' (env SP_VERIFY, default 'off'): re-simulate accepted client results
//                      ('sample': ~1 in 8, in later slices, mismatches logged; 'all': before accepting — the
//                      server's result wins on a mismatch)
//
// Engine-only extra options (tests / tools; the lobby never passes them):
//   opts.scheduler     RealScheduler (default, uses opts.now) | VirtualScheduler (./scheduler.js)
//   opts.registry      MetaRegistry (default: built-ins + content, ./effectsMeta.js getDefaultRegistry())
//   opts.BattleClass   Battle implementation (default server/sim/Battle.js; tests inject test/match/fakeBattle.js)
//   opts.battleContent 'full' | 'generic' | 'none' (sim content mode, default 'full')
//   opts.timerScale    multiplier on every real-time phase timer (default 1)
//   opts.combatSpeed   game seconds per real second while battles run in real time (default 2, the forced 2×)
//   opts.botRehearsal  candidate layouts a bot simulates per prep before placing (default 3, 0 = heuristic only;
//                      a whole battle per candidate: ~20–300 ms of CPU each, see server/match/bot.js createRehearsal)
//   opts.botSliceMs    wall-clock ms of rehearsal per scheduler callback (default 8 with a real scheduler, unbounded
//                      with a virtual one); the rest runs in later callbacks (scheduleBotPrep)
//   opts.botRehearsalDelegate  offer each bot prep's layout rehearsal to the current host's browser instead (DESIGN §14;
//                      default off, env SP_BOT_REHEARSAL=host; MatchRehearsal — the server simulates a rehearsal the
//                      host did not answer with the same candidates, seeds and scoring)
//   opts.botRehearsalDelegateMs  wall-clock ms the host has to answer a delegated rehearsal (default 3000) — never an
//                      extension of the phase: the prep deadline stays the phase's own (MatchPrep.endPrep)
//   opts.headlessSliceMs  wall-clock ms per callback of a server-run normal / 联防 field (client-side combat: bots,
//                      takeovers, result verification; default 8 with a real scheduler, at once with a virtual one)
// Seats may be all bots (tools/matchrun.mjs); the lobby always has ≥ 1 human.
//
// Diagnostics: m.errors / m.errorCount (engine), m.dispatcher.errors / .errorsByKey (meta handlers), m.simErrors
// (count reported by battle results) and m.simErrorLog (Map key → { label, who, message, stack, battles, count }
// of the unique errors each finished battle recorded in battle.errors). tools/matchrun.mjs --errors prints them.
//
// Disconnect / leave policy (research 06 §10.3 + DESIGN §6.6):
//   * disconnected human: the seat keeps playing its last lineup; draft turns and prep auto-resolve at their
//     deadlines (band → 华法琳, 机变 → a random remaining card, prep → auto-ready with temp auto-resolved). Nothing is
//     bought for them unless they toggled "AI 托管" (g.autoplay { on: true }), which lets the bot play the seat.
//   * departed human (onLeave): 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3) — every
//     copy the seat holds returns to the shared pool at once, the seat leaves the round loop, the Final Assault
//     pairing and the boss pool; its own running normal battle is force-ended. The seat shows status 'left'. When no
//     human is left at all the match ends ('abandoned'); when nobody alive is left it ends as 'eliminated'.
//
// Code layout: this file keeps the constructor (options, seats, the per-match setup, the state fields); the methods
// live in server/match/match/, one module per concern, and are installed on Match.prototype below in a fixed order,
// with the descriptors of class methods (non-enumerable; `this` is the match, subclasses and `super` calls work as
// before):
//   platform.js      the interface above: start, handle, setLoadout, disconnect / reconnect / resync, leave, dispose
//   infra.js         error isolation, timers and the phase deadline, player lists, bonds in the pool, deploy field,
//                    meta dispatch
//   messaging.js     send / broadcast / toasts / tickers, dirty marks, flush (m.private per player, m.public throttled)
//   views.js         m.public (statuses, field progress, pendingLp / uniteLeft), the nextEnemies preview, the prep
//                    scout's m.field
//   watch.js         spectator seats, g.watch, who is shown which field, resend on reconnect, prep-scout pushes
//   intents.js       the g.* / b.* router, emotes, AI 托管, g.unitStats
//   pause.js         the solo pause
//   phases.js        INFO_CHECK, BAND_DRAFT (the strategy draft), BATTLE_CHECK, ROUND_START
//   spDraft.js       SP_DRAFT (机变) and the rolls the meta effects ask for (bounties, item ids, pools)
//   prep.js          PREP: its start, the AI seats' sliced preps, Ready, the deadline, its end
//   combat.js        battle construction, COMBAT (both modes), the per-field results, then 联防 or SETTLE
//   clientCombat.js  client-side combat bookkeeping: field records, the field clock, authority, b.start, result
//                    deadlines and releases, server runs, field completion
//   rehearsal.js     the bot layout rehearsal delegated to the current host's browser: the b.rehearsal task, its answer,
//                    its timeout and the server takeover (DESIGN §14)
//   reports.js       b.progress / b.result (validation, held boss results), SP_VERIFY
//   unitePhase.js    联防 (UNITE) in both modes and the leakers' live counts
//   bossRounds.js    FINAL_ASSAULT / HIDDEN_CORE: boss fields, the shared pool, plausibility budgets, the boss clock,
//                    b.pool, the merged team LP, overtime, bounties after a boss field
//   settle.js        SETTLE and RESULT
//   common.js        what the modules share (FLOW_TICKER_PRIORITY, DELAYS, BAND_TURN_SECONDS — re-exported here, OK,
//                    fail, BOSS_CLOCK_MS)

import { PHASE, modeIdFor, bossHitLimitFrom, MAX_SEATS } from '../../shared/constants.js';
// 变体 / 口径层（DESIGN §28.39）：本局的轴表由各包的归一化声明合成，规则就是既有的「包 id 字典序小的赢」。
import { mergeVariantDecls, variantValue } from '../../shared/variants.js';
// 行为开关层（DESIGN §28.43）：同一张合成规则（包 id 小的赢），另一张表。空数组 ⇒ 每一格的读取点走缺省路径。
import { mergeBehaviourDecls } from '../../shared/behaviour.js';
// 行为开关 `morphPairing` 的档位（DESIGN §28.43.1）：判据本体在 `shared/morph.js`，这一行只把这一局的档位算出来，
// 往下交给 `GameData`（prep）、`battleOpts`（战斗）与 BattleSpec（客户端）。
import { morphPairingOf } from '../../shared/morph.js';
import { formView, isEliteForm } from '../../shared/formProjection.js';
import { layoutOf } from '../../shared/layout.js';
import { Battle } from '../sim/Battle.js';
import { DataSource } from '../sim/simdata.js';
import { createRng, deriveSeed } from '../sim/rng.js';
import { GameData } from './gamedata.js';
import { RealScheduler } from './scheduler.js';
import { SharedPool, SharedItemPool, drawDisabledBonds } from './pool.js';
import { PlayerState } from './PlayerState.js';
import { EffectDispatcher, getDefaultRegistry } from './effectsMeta.js';
import { setupMatchWaves } from './waves.js';
import { GAME_SPEED, HEADLESS_SLICE_MS } from './fields.js';
import { MatchPlatform } from './match/platform.js';
import { MatchInfra } from './match/infra.js';
import { MatchMessaging } from './match/messaging.js';
import { MatchViews } from './match/views.js';
import { MatchWatch } from './match/watch.js';
import { MatchIntents } from './match/intents.js';
import { MatchPause } from './match/pause.js';
import { MatchPhases } from './match/phases.js';
import { MatchSetupVote } from './match/setupVote.js';
import { MatchSpDraft } from './match/spDraft.js';
import { MatchPrep } from './match/prep.js';
import { MatchCombat } from './match/combat.js';
import { MatchClientCombat } from './match/clientCombat.js';
import { MatchRehearsal, REHEARSAL_ANSWER_MS } from './match/rehearsal.js';
import { isContentHash } from '../../shared/plugins/identity.js';
import { MatchReports } from './match/reports.js';
import { MatchUnite } from './match/unitePhase.js';
import { MatchBoss } from './match/bossRounds.js';
import { MatchSettle } from './match/settle.js';
import { installTestTrace } from './testTrace.js';
import { MatchTestCommands } from './match/testCommands.js';
import { MatchOffers } from './match/offers.js';

export { FLOW_TICKER_PRIORITY, DELAYS, BAND_TURN_SECONDS } from './match/common.js';

const BOT_REHEARSAL_DEFAULT = 3;
/** Wall-clock ms of bot layout rehearsal per scheduler callback (real time; virtual time runs it in one go). */
const BOT_SLICE_MS = 8;
const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);
/** Default combat mode: client-side unless SP_COMBAT=server. */
const envClientCombat = () => String(env('SP_COMBAT') || '').toLowerCase() !== 'server';/** SP_VERIFY → 'off' | 'sample' | 'all'. */
export function parseVerify(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'all' || s === 'sample' ? s : 'off';
}
/** Default of the bot rehearsal delegation: off — SP_BOT_REHEARSAL=host offers it to the room's host (DESIGN §14). */
const envBotRehearsal = () => String(env('SP_BOT_REHEARSAL') || '').trim().toLowerCase() === 'host';
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const dsCache = new WeakMap();
/**
 * 这一局的 `DataSource`，按 `[口径, data]` 取。缓存键**必须并进 `form` 口径**（DESIGN §28.41）：同一份 data 的
 * 两个房间，一个声明 `form: "elite"`、一个不声明，共用一份 `DataSource` 会让面板与战斗对同一条 `_a` 给出两套
 * 数值 —— 那就是分叉。缺省那一格（`elite === false`）建出来的对象与从前**逐字相同**（`new DataSource(data, null)`，
 * 没有第三个参数），所以没声明这个轴的路径一个字节都没变，只是同一份 data 现在按口径各缓一格。
 */
function dataSourceFor(data, forms = null, elite = false) {
  if (!data || typeof data !== 'object' || !data.chess) return undefined;
  let byForm = dsCache.get(data);
  if (!byForm) { byForm = new Map(); dsCache.set(data, byForm); }
  const key = elite ? 'elite' : 'official';
  let ds = byForm.get(key);
  if (!ds) {
    ds = elite ? new DataSource(data, null, { forms }) : new DataSource(data, null);
    byForm.set(key, ds);
  }
  return ds;
}

export class Match {
  /** @param {object} opts see MATCH INTERFACE above */
  constructor(opts) {
    if (!opts || !Array.isArray(opts.seats) || opts.seats.length === 0) throw new TypeError('Match: seats required');
    if (typeof opts.send !== 'function' || typeof opts.broadcast !== 'function' || typeof opts.onEnd !== 'function') {
      throw new TypeError('Match: send/broadcast/onEnd callbacks required');
    }
    this.opts = opts;
    this.roomCode = opts.roomCode ?? '----';
    this.mode = opts.mode === 'solo' ? 'solo' : 'coop';
    this.difficulty = opts.difficulty;
    this.modeId = opts.modeId || modeIdFor(this.mode, opts.difficulty);
    this.seed = (Number(opts.seed) >>> 0) || 1;
    this.log = opts.log || noopLog;
    this.sendFn = opts.send;
    this.broadcastFn = opts.broadcast;
    this.onEndFn = opts.onEnd;
    this.data = opts.data && typeof opts.data === 'object' ? opts.data : {};
    /** the room's content hash (opts.cs, DESIGN **§34**，上游原文 `§32`): every BattleSpec carries it */
    this.cs = isContentHash(opts.cs) ? opts.cs : null;
    /** the room's visual set (opts.vs, DESIGN **§34.6**，上游原文 `§32.6`): every BattleSpec names it */
    this.vs = isContentHash(opts.vs) ? opts.vs : null;
    /** a room with gameplay plugins (opts.requireCs): a client result must name this match's cs (reports.js) */
    this.requireCs = opts.requireCs === true && !!this.cs;
    /**
     * The content this match runs with (DESIGN §28.2): `{ digest, packs }`, or null for a plain install. It goes into
     * every BattleSpec (`spec.mods`) so a field's result is always attributable to the content that produced it.
     *
     * 它同时是**口径**的来源（DESIGN §28.39）：`packs[].variants` 是每个包的归一化声明，`mergeVariantDecls`
     * 按既有的「包 id 字典序小的赢」（DESIGN §28.3）合成出这一局的轴表。没有包、或没有包声明口径 ⇒ `[]`，
     * 于是 `GameData` 的每一处读点都走今天那条缺省路径（逐字节不变）。
     * @type {{ digest: string, packs: Array<object> }|null}
     */
    this.mods = opts.mods && typeof opts.mods === 'object' && typeof opts.mods.digest === 'string' ? opts.mods : null;
    /** @type {Array<{ axis: string, default: string, by: string }>} */
    this.variants = mergeVariantDecls(this.mods && Array.isArray(this.mods.packs) ? this.mods.packs : []).decl;
    /**
     * 行为开关的来源（DESIGN §28.43），与 `variants` **同一个投影点、同一个合并规则**（包 id 字典序小的赢）：
     * `this.behaviour` 是这一局合成后的归一化声明。没有包、或没有包声明任何开关 ⇒ `[]`，于是每一格的读取点
     * （`shopBiasBonds` 与将来的那些）都走今天那条缺省路径。**漏掉这一行 = 引擎读到 `undefined`、开关静默不生效**
     * —— §28.39/§28.43 把这一处记成「这一层最容易做坏的地方」。
     * @type {Array<{ switch: string, option: string, by: string }>}
     */
    this.behaviour = mergeBehaviourDecls(this.mods && Array.isArray(this.mods.packs) ? this.mods.packs : []).decl;
    /**
     * 行为开关 `morphPairing` 的档位（DESIGN §28.43.1）：prep 侧由 `GameData`（下面建 `this.gd` 时传进去）读，
     * 战斗侧由 `battleOptsFromMatch` 递给每一场 Battle（`Battle` 再把它压进 `withMorphPairing` 的作用域），
     * 客户端由 BattleSpec 上那一个键读。**三处读的是同一个值**，判据本体只有一份（`shared/morph.js`）。
     * 没声明这一格 ⇒ `'official'` = 引擎今天的行为。
     * @type {'official'|'plus'}
     */
    this.morphPairing = morphPairingOf(this.behaviour);
    /**
     * Seat slots of this match (opts.seatCap, or how many seats the caller handed in). Only the boss-pool ceiling
     * reads it: a room bigger than the official 4 must not clamp its leader pool to the 4-seat `aliveFull`
     * (gamedata.js bossPoolShareOf; 百卫补丁 v0.3, docs/PS100-MIGRATION.md §2.4). It is NOT the variant switch — see
     * `variant` below.
     */
    this.seatCap = Number.isFinite(opts.seatCap) && opts.seatCap >= 1 ? Math.floor(opts.seatCap)
      : (Array.isArray(opts.seats) && opts.seats.length >= 1 ? opts.seats.length : undefined);
    /**
     * 形态投影（口径轴 `form`，DESIGN §28.41）：`form: "elite"` 时普通（`_a`）干员按精锐（`_b`）的战斗职能出战。
     * **一份视图、两个消费者**（`GameData.chess()` 与这一局的 `DataSource`）：两边分叉就是 bug，所以这里建一次，
     * 往下传。没声明这个轴时视图的 `chess(id)` 逐字返回 `data.chess[id]` 那个对象本身。
     */
    this.eliteForm = isEliteForm(variantValue(this.variants, 'form'));
    this.formView = formView(this.data && this.data.chess, this.eliteForm, { tokens: this.data && this.data.tokens });
    this.gd = new GameData(this.data, this.modeId, {
      ...(this.seatCap ? { seatCap: this.seatCap } : {}),
      // 本局的口径（DESIGN §28.39）。空数组 = 没有包声明口径 ⇒ `GameData` 一个字节都不动。
      variants: this.variants,
      // 本局的行为开关（DESIGN §28.43.1）：prep 侧的 `pieceBonds` 从这一份读取视图里读 `morphPairing`。
      behaviour: this.behaviour,
      // 形态投影的那一份视图（与 `this.ds` 共用）。
      forms: this.formView,
    });
    // [ASSUMED] Only an array is a content list. Omitting the key (every vanilla match) leaves setDiy on KITTED_CHARS.
    // A copy so a caller's freeze or later mutation cannot change the check, and so the key stays off public views.
    if (Array.isArray(opts.kitted)) this.diyKitted = Object.freeze(opts.kitted.filter((id) => typeof id === 'string'));
    // The room's rule switches (DESIGN §36.15). Omitted on a vanilla match, so its own keys stay the same.
    if (opts.rules && typeof opts.rules === 'object' && !Array.isArray(opts.rules)) this.rules = Object.freeze({ ...opts.rules });
    /**
     * The interaction windows this match's content set declares (PLUGIN API v2, docs/PLUGINS.md §10b): the normalized
     * `offers` of the plugins the host installed, handed in as `opts.offers` before construction so test journals
     * and both host transports capture the same declaration snapshot. `[]` for every match whose set declares none, and then
     * no window code ever runs (MatchOffers.openOfferWindow returns before it touches the phase).
     * @type {object[]}
     */
    this.offers = Array.isArray(opts.offers) ? opts.offers : [];
    /** @type {any[]} the windows open right now (MatchOffers) */
    this.offerWin = [];
    /** @type {Map<object, any>} window → its deadline timer (tracked so dispose cancels it) */
    this._offerTimers = new Map();
    /** what runs once the last open window closes (a held-back round start / prep) */
    this._offerResume = null;
    /** window sequence (diagnostics and messages) */
    this.offerSeq = 0;
    if (!this.difficulty) this.difficulty = this.gd.difficulty;
    this.isSolo = this.mode === 'solo' || this.gd.isSolo;
    /** 「AI 队友最后选择」 (opts.aiPicksLast, GitHub #338): humans draft before AI seats (MatchPhases.humansFirst) */
    this.aiPicksLast = !this.isSolo && opts.aiPicksLast === true;
    /**
     * 限伤 override for this match's battles (`SP_BOSS_HIT_LIMIT`, shared/constants.js bossHitLimitFrom; opts wins).
     * `undefined` = keep the official `BOSS_HIT_LIMIT` — the default of every existing deployment, in which case the
     * battles are built with no `bossHitLimit` key at all (byte-for-byte the old behaviour). A number (or Infinity for
     * "off") is passed to every field this match builds, server-run and client-side alike (the client reads it off the
     * battle spec, so both sides cancel the same hits).
     * @type {number|undefined}
     */
    this.bossHitLimit = opts.bossHitLimit !== undefined ? opts.bossHitLimit : bossHitLimitFrom(typeof process !== 'undefined' && process.env ? process.env : {});
    this.ownsScheduler = !opts.scheduler;
    this.sched = opts.scheduler || new RealScheduler({ now: opts.now || Date.now, onError: (e) => this.reportError('timer', e) });
    this.registry = opts.registry || getDefaultRegistry();
    this.dispatcher = new EffectDispatcher(this, this.registry);
    this.BattleClass = typeof opts.BattleClass === 'function' ? opts.BattleClass : Battle;
    this.battleContent = opts.battleContent || 'full';
    /**
     * 工坊行为层 (docs/WORKSHOP.md §4): the per-battle kit map loaded from `workshop/<pack>/kits/`, plus the JSON-safe
     * module list the browser needs to rebuild the same map. Both empty for a plain install.
     * @type {Record<string, Function>|null}
     */
    this.workshopKits = opts.workshopKits && typeof opts.workshopKits === 'object' ? opts.workshopKits : null;
    /**
     * 召唤物的行为层（docs/WORKSHOP.md §4.7）: the same two halves for the SECOND kit key space — a summon kit is keyed
     * by the token record id and is injected as `Battle opts.tokenKits`. `null` on a plain install, so the battle never
     * sees the key (behaviour byte-for-byte as before).
     * @type {Record<string, Function>|null}
     */
    this.workshopTokenKits = opts.workshopTokenKits && typeof opts.workshopTokenKits === 'object' ? opts.workshopTokenKits : null;
    /**
     * kit 的**归属**与**预算**（DESIGN §28.52 的 kit 那一半）：`kits` / `tokenKits` 只是 `id → 函数`，不带所属包，而
     * 「这个 kit 的逐单位回调归到哪本账上」正是靠这两张表。两张 owner 表与一张「包 id → 生效 max」表都在**装载期**
     * 由 `server/workshop.js loadWorkshopKits` 产出一次；干净安装时它们是 `null` ⇒ 战斗拿不到这几个键，行为逐字节同前。
     * @type {Map<string, string>|null}
     */
    this.workshopKitOwners = opts.workshopKitOwners instanceof Map ? opts.workshopKitOwners : null;
    /** @type {Map<string, string>|null} 召唤物那一半（第二个键空间，与 `tokenKits` 逐字对称）。 */
    this.workshopTokenKitOwners = opts.workshopTokenKitOwners instanceof Map ? opts.workshopTokenKitOwners : null;
    /** @type {Map<string, number>|null} 包 id → 生效的每局调用上限（只装带 kit 的包）。 */
    this.workshopKitBudgets = opts.workshopKitBudgets instanceof Map ? opts.workshopKitBudgets : null;
    /** @type {Array<{ id: string, pack: string, hash?: string, url: string }>} */
    this.workshopKitModules = Array.isArray(opts.workshopKitModules) ? opts.workshopKitModules : [];
    /**
     * 包声明的**战斗逻辑**（`pack.json.server.battle`, DESIGN §28.17）：这一场要跑的 `install(battle)` 真函数
     * （服务端跑的就是它们）与浏览器要加载的那份 `{ id, pack, hash, url }` 清单（进每一份 BattleSpec）。
     * 没有包声明时两者分别是 null / 空数组 —— 战斗拿不到这个键，行为与从前逐字节相同。
     * @type {Array<{ id: string, install: Function }>|null}
     */
    this.battleInstallers = Array.isArray(opts.battleInstallers) && opts.battleInstallers.length ? opts.battleInstallers : null;
    /** @type {Array<{ id: string, pack: string, hash?: string, url: string }>} */
    this.workshopBattleModules = Array.isArray(opts.workshopBattleModules) ? opts.workshopBattleModules : [];
    this.timerScale = Number.isFinite(opts.timerScale) && opts.timerScale >= 0 ? opts.timerScale : 1;
    this.gameSpeed = Number.isFinite(opts.combatSpeed) && opts.combatSpeed > 0 ? Math.min(opts.combatSpeed, 200) : GAME_SPEED;
    /** layouts a bot rehearses per prep with the real simulation (bot.js; 0 = heuristic placement only) */
    this.botRehearsal = Number.isInteger(opts.botRehearsal) && opts.botRehearsal >= 0 ? Math.min(opts.botRehearsal, 8) : BOT_REHEARSAL_DEFAULT;
    /** wall-clock budget of one rehearsal slice (scheduleBotPrep) */
    this.botSliceMs = Number.isFinite(opts.botSliceMs) && opts.botSliceMs > 0 ? opts.botSliceMs : this.sched.virtual ? Infinity : BOT_SLICE_MS;
    /**
     * Offer a bot's layout rehearsal to the current host's browser (DESIGN §14): `opts.botRehearsalDelegate`, default
     * off, env SP_BOT_REHEARSAL=host. The server simulates a rehearsal the host did not answer (see MatchRehearsal).
     */
    this.botRehearsalDelegate = opts.botRehearsalDelegate != null ? !!opts.botRehearsalDelegate : envBotRehearsal();
    /** wall-clock ms the host has to answer a delegated rehearsal (engine option: tests shorten it) */
    this.botRehearsalDelegateMs = Number.isFinite(opts.botRehearsalDelegateMs) && opts.botRehearsalDelegateMs > 0 ? opts.botRehearsalDelegateMs : REHEARSAL_ANSWER_MS;
    /** the room's current host (opts.hostId; server/lobby.js room.hostId — setHost follows a migration) */
    this.hostId = typeof opts.hostId === 'string' ? opts.hostId : null;
    /**
     * Match test mode (DESIGN §36.8 phase 2). opts.test is only forwarded for a room created with the flag.
     * The extra state exists only then, and public / result views omit the keys while this is false, so a
     * normal match stays byte-identical.
     */
    this.test = opts.test === true;
    if (this.test) {
      /** phase deadlines are armed. false holds the callback (g.test timers) instead of scaling time to 0. */
      this.testTimers = true;
      /** successful g.test commands this match (m.result.testActions) */
      this.testActions = 0;
      /** @type {{ seq: number, playerId: string, cmd: string, args: object, at: number, ok: boolean, code?: string }[]} */
      this.testLog = [];
      /** @type {Map<string, number[]>} command → scheduler timestamps inside the rate window */
      this._testRate = new Map();
      this._testSeq = 0;
      /** the phase callback held while testTimers is false */
      this._testHeld = null;
      /** the last callback setDeadline armed, so timers can be turned off mid-phase */
      this._testArmed = null;
      /** false once the input journal stops logging (the replay decoder's line cap) */
      this.testReplayable = true;
      /** replay: stop a sliced callback after this many steps; null while recording */
      this._testSliceBudget = null;
      /** steps taken by the timer callback now running (the journal's `steps`) */
      this._testSliceCount = 0;
    }
    /** @type {Map<string, { id: string, job: any, executor: string, timer: any }>} delegated rehearsals in flight */
    this._rehearsalTasks = new Map();
    this._rehearsalSeq = 0;
    /** how this match's delegated rehearsals ended (the log lines above; the tests read it) */
    this.rehearsalStats = { delegated: 0, answered: 0, takeovers: 0 };
    this.ds = dataSourceFor(this.data, this.formView, this.eliteForm);
    /** client-side combat (DESIGN §14) — see the header */
    this.clientCombat = opts.clientCombat != null ? !!opts.clientCombat : envClientCombat();
    this.verifyMode = parseVerify(opts.verify ?? env('SP_VERIFY'));
    /** wall-clock ms per slice of a server-run normal / 联防 field (virtual time: at once) */
    this.headlessSliceMs = Number.isFinite(opts.headlessSliceMs) && opts.headlessSliceMs > 0 ? opts.headlessSliceMs : this.sched.virtual ? Infinity : HEADLESS_SLICE_MS;
    this.verifyStats = { checked: 0, mismatches: 0, rejected: 0, takeovers: 0 };
    this._battleSeq = 0;
    /** solo pause (g.pause, DESIGN §14): the field clocks / deadlines are frozen while true (m.public.paused) */
    this.paused = false;
    this._pausedAt = 0;
    /** real ms spent paused this match (diagnostics) */
    this.pausedMs = 0;
    /** boss rounds (client-side combat): the throttled m.public refresh (_bossPublic) */
    this._bossPubTimer = null;
    this._bossPubAt = -Infinity;
    this._bossClockOn = false;
    /**
     * battleId prefix (DESIGN §14): the seed (+ the room's match number) — a b.progress / b.result that crossed into the
     * next match of the room (the same socket, the same field ids) never names a battle of this match.
     */
    this.battlePrefix = `${this.seed.toString(36)}${Number.isInteger(opts.matchNo) && opts.matchNo > 0 ? `-${opts.matchNo.toString(36)}` : ''}`;
    this._progressTimer = null;
    this._bossClock = null;
    this._lastPoolAt = -Infinity;
    this._poolTimer = null;
    this._lastPoolKey = '';
    this.pacer = null;

    const rng = (name) => createRng(deriveSeed(this.seed, name));
    this.rngSetup = rng('setup');
    this.rngShop = rng('shop');
    this.rngWaves = rng('waves');
    this.rngDraft = rng('draft');
    this.rngBots = rng('bots');
    this.rngMeta = rng('meta');

    /** @type {Map<string, PlayerState>} */
    this.players = new Map();
    const seen = new Set();
    for (const s of opts.seats) {
      if (!s || typeof s.playerId !== 'string' || seen.has(s.playerId)) continue;
      seen.add(s.playerId);
      this.players.set(s.playerId, new PlayerState(this, s));
    }
    if (!this.players.size) throw new TypeError('Match: seats required');
    this.order = [...this.players.values()].sort((a, b) => a.seat - b.seat);
    /**
     * Spectator seats (opts.spectators / addSpectator): playerId → a stand-in every watch path treats like an eliminated
     * human (alive false; no PlayerState, never a field's player or authority).
     * @type {Map<string, { playerId: string, isBot: false, left: false, alive: false, connected: true, spectator: true }>}
     */
    this.spectators = new Map();
    for (const id of Array.isArray(opts.spectators) ? opts.spectators : []) this._spectator(id);
    /**
     * Exactly one human seat at the start (独立模拟, or a 同盟 room started alone / with AI teammates only): nobody waits
     * on anybody, so no phase outside a battle is timed — soloUntimed (user playtest #4 item 3). The mode's own rules
     * (draft order and skip, 6 机变 cards, 联防 …) stay.
     */
    this.loneHuman = this.order.filter((p) => !p.isBot).length === 1;
    /**
     * 超容变体的闸门 (业主裁令 2026-10-12)。**闸门读的是在场参与者数，不是房间容量 —— 容量 20 只坐 4 人走原路径。**
     *
     * `participants` = the seats this match actually fields (humans + AI, `order.length`; spectators are NOT
     * participants — they are stored separately below and never take a seat). The default ceiling became 20, so a room's
     * CAPACITY no longer says anything about how many players are in it: the official 4-player game must keep the
     * room-wide code path (shared pool, one room-wide 联防 plan), and only a match with MORE than the official
     * `MAX_SEATS` participants needs a pool per player / per-squad planning (百卫补丁 v0.3, docs/PS100-MIGRATION.md §10).
     *
     * Computed ONCE, here, and read (never re-derived) by every gate: `PlayerState.variantOn` (server/match/player/
     * rules.js), `planUnite` (server/match/unite.js) and the invariant checker (server/match/invariants.js). Deriving it
     * per call from `seatCap` is what a mid-match path flip would look like — the seat list is fixed at start, so this
     * boolean is too.
     */
    this.participants = this.order.length;
    this.variant = this.participants > MAX_SEATS;

    // per-match setup (DESIGN §6.5)
    const setup = setupMatchWaves(this.gd, this.rngSetup);
    this.stageId = setup.stageId;
    this.stage = this.stageId ? this.gd.stage(this.stageId) : null;
    /** The stage's own layout (shared/layout.js): its battle rects, pen band and mirror axis — official for 19×21. */
    this.layout = layoutOf(this.stage);
    /**
     * 编辑器「▶ 试玩这张图」：让这一局**打指定的那张图**（业主 2026-10-08 的地图编辑器需求）。
     *
     * 为什么走环境变量而不是新的协议字段：试玩服务器是编辑器 spawn 的**一次性子进程**（editor/playtest.mjs，一个端口一个
     * 进程），`SP_STAGE` 只在那一个进程里存在；正式服务器不会带它，所以这条不会成为可以远程触发的玩法开关。
     * 覆盖发生在 setupMatchWaves 抽完图之后：抽卡本身照常消耗随机数，种子序列与不带 SP_STAGE 时一致。
     *
     * 注意这张图**未必绑过出怪表**：`buildNormalWave` 会退到模式模板（官方几何的路线），试玩里看起来就是「怪在乱走」——
     * 编辑器在点试玩之前会先提示这件事，这里只留一条日志当线索。
     */
    const forcedStage = String(process.env.SP_STAGE || '').trim();
    if (forcedStage && this.gd.stage(forcedStage)) {
      this.stageId = forcedStage;
      this.stage = this.gd.stage(forcedStage);
      this.layout = layoutOf(this.stage);
      // 部署图是按当时那张图算出来的：换了图必须让它重算，否则试玩里能放的位置还是上一张图的
      for (const ps of this.players.values()) ps.invalidateDeployMap?.();
      if (!this.stage.rounds || !Object.keys(this.stage.rounds).length) {
        this.log?.warn?.(`[match] SP_STAGE=${forcedStage}：这张图没有绑定任何出怪表，回合会退回模式模板的路线`);
      }
    }
    this.factions = setup.factions;
    this.bossId = setup.bossId;
    this.hiddenBossId = setup.hiddenBossId;
    const bans = drawDisabledBonds(this.gd, this.rngSetup);
    this.disabledBonds = bans.drawn;
    this.staticInactiveBonds = bans.staticOff;
    this.bannedChess = bans.banned;
    /**
     * 助战供给 (shared/support.js): the operators the HUMAN seats brought. Each gets one extra pool copy for this match
     * and is in the pool even when the random bans took it out — a brought operator must be purchasable, because that is
     * what borrowing it means here (the owner's call 2026-10-07: 助战干员进商店，按阶级像普通棋子一样购买出售).
     * Bots never bring supports (PlayerState.setSupport refuses them), so their seats are ignored. Read from the seats
     * because the pool is built before any player state exists; `PlayerState.setSupport` re-checks the same rule later.
     */
    this.supportSupply = [...new Set(opts.seats
      .filter((s) => s && !s.isBot && Array.isArray(s.support))
      .flatMap((s) => s.support.map((id) => String(id || ''))))]
      .filter((id) => id && this.gd.isSupportChess(id))
      .sort();
    // 上游 0.2.4（DESIGN §31.8 共享库存）与我们的助战供给落在同一行，两者互不相干，故并存：
    // 助战多一份拷贝走 SharedPool 的 support 选项；共享装备库存是另一个池，由 SharedItemPool 表达。
    this.pool = new SharedPool(this.gd, { banned: bans.banned, support: this.supportSupply });
    this.itemPool = new SharedItemPool(this.gd, () => this.order);
    // 自选编队 (0.2.0): each human's slotted DIY pieces get their own stock — none for one whose bonds are all off this
    // match (player/diy.js initDiyStock); no randomness is drawn here
    const off = new Set([...bans.drawn, ...bans.staticOff]);
    for (const ps of this.order) ps.initDiyStock(off);

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.deadline = 0;
    /** Final Assault / Hidden Core: ms epoch when the overtime drain starts (m.public.overtimeAt) */
    this.overtimeAt = 0;
    this.uidSeq = 0;
    this.ended = false;
    this.disposed = false;
    this.startedAt = this.sched.now();
    /** @type {Set<any>} */
    this._timers = new Set();
    this._phaseTimer = null;
    this._infoAdvanceTimer = null;
    this.setupRevision = 0;
    this.setupVote = null;
    this._setupVoteSeq = 0;
    this._lastSetupVoteAt = -Infinity;
    this._turnTimer = null;
    this._pubDirty = false;
    this._pubTimer = null;
    this._lastPubAt = -Infinity;
    this._lastPubJson = '';
    /**
     * The full m.public view the room's clients are believed to hold — the baseline of the incremental frame
     * (DESIGN §8.2, incremental frame; matchMessaging _maybeSendPublic, server/viewsDelta.js). null until the first
     * frame went out, which is what makes that first frame a full one.
     * @type {Record<string, any> | null}
     */
    this._pubPrev = null;
    /** The next m.public is sent in its full form (a membership change, a failed delivery, the keepalive). */
    this._pubFull = true;
    /** Consecutive delta frames since the last full one (the keepalive counter, PUBLIC_FULL_EVERY). */
    this._pubFrames = 0;
    /** @type {Set<PlayerState>} */
    this._privDirty = new Set();
    this.errors = [];
    this.errorCount = 0;
    this.simErrors = 0;
    /** @type {Map<string, { label: string, who: string, message: string, stack: string|null, battles: number, count: number }>} */
    this.simErrorLog = new Map();
    this._prepEndQueued = false;

    this.draft = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.bossPairs = null; // drawn once per match; the hidden round retains partners and sides
    this.fields = [];
    this.runner = null;
    /** playerId → fieldId */
    this.watchers = new Map();
    /**
     * Watch preference (community report of 2026-10-06, item 56; the idea of PR #189): viewer playerId → the player it
     * last chose to watch with a manual g.watch. Every phase reset starts an eliminated human or a spectator seat on that
     * player again (its prep board, its battle field) — else the first player still in — instead of its own empty board.
     */
    this.watchPref = new Map();
    this.lastResults = new Map();
    this.unitePlan = null;
    /**
     * 100-seat variant ONLY (design-level item C, docs/PS100-MIGRATION.md §10-C): the per-squad plans of the running
     * 联防 round (`unitePlans`), its round number (`uniteRound`: 1 阶段 1 队内兜底 / 2 阶段 2 跨队兜底) and the
     * re-entrancy tokens of the two-round hand-off. They stay AT REST (`null` / `1` / `0` / `null`) whenever the switch
     * is off — a match with ≤ MAX_SEATS PARTICIPANTS never reads or writes them, because `planUnite` only returns an array
     * `MAX_SEATS` and `MatchUnite.startUnite` branches on that shape (test/ps100-variant-ac.test.js pins the rest).
     */
    this.unitePlans = null;
    this.uniteRound = 1;
    this._uniteToken = 0;
    this._uniteHandoff = null;
    this._phase1Settle = null;
    this._phase1Driven = 0;
    this._relayToken = 0;
    /** 联防 outcome for the SETTLE view: { through, helpers, leakers, losses } (settle()), null when no 联防 resolved */
    this.uniteResultView = null;
    /** server-run 联防: the leakers' counts last published (_uniteTick) */
    this._uniteLeftKey = null;
    /** 联防: { plan, bounds } — per leaker the most survivors settlement can bill (_uniteLeft's clamp) */
    this._uniteBounds = null;
    this.teamLp = null;
    this.bossPool = null;
    this.hiddenLayerSum = 0;
    this.hiddenReached = false;
    this.outcome = null;
    this._turnToken = 0;
    // [ASSUMED] A real scheduler keeps the 8 ms bot and headless slices, including a test match,
    // so one callback cannot run to HARD_CAP_SECONDS. Virtual time stays unbounded (the defaults
    // above). The input journal records the steps that callback took; replay stops there.
    if (this.test && opts.journal !== false) installTestTrace(this, opts);
  }
}

// the method modules, in this order (a name defined twice is an error, never a silent override)
for (const part of [MatchPlatform, MatchInfra, MatchMessaging, MatchViews, MatchWatch, MatchIntents, MatchPause, MatchPhases, MatchSetupVote, MatchSpDraft, MatchPrep, MatchCombat, MatchClientCombat, MatchRehearsal, MatchReports, MatchUnite, MatchBoss, MatchSettle, MatchTestCommands, MatchOffers]) {
  for (const key of Reflect.ownKeys(part.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Match.prototype, key)) throw new Error(`Match.${String(key)} is defined twice`);
    Object.defineProperty(Match.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key));
  }
}
