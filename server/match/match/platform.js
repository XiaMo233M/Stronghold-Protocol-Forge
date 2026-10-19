// server/match/match/platform.js — Match methods: the platform interface of the server/match/Match.js header
// (server/lobby.js ⇄ Match) — start, handle (validation, error isolation, flush; the intents themselves: intents.js
// _handle), setLoadout (INFO_CHECK; rule-enabled PREP), onDisconnect / onReconnect and the full resync of one human, onLeave and 中途退出
// = elimination (_quit), dispose.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { C2S } from '../../../shared/protocol.js';
import { PHASE, ERR } from '../../../shared/constants.js';
import { behaviourIsDefault } from '../../../shared/behaviour.js';
import { syntheticResult } from '../fields.js';
import { FLOW_TICKER_PRIORITY, OK, fail } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { ruleOption } from '../../../shared/plugins/rules.js';

const GAME_TYPES = new Set(Object.keys(C2S).filter((t) => Object.hasOwn(C2S, t) && (t.startsWith('g.') || t.startsWith('b.'))));

/**
 * 行为开关 `prepLoadout` 的两个档位各收哪些相位（`Match.setLoadout`）—— 这一格的**引擎侧读取点**：
 * `locked`（缺省）只有 `INFO_CHECK`，与从前逐字相同；`prep` 另加 `PREP`（休整期）。
 *
 * 写成模块层的**不可变表 + 一个纯函数**：一是 `Match.setLoadout` 只查表、不写死相位，二是它是
 * `shared/modSurface.js` 里 `behaviour` 那一格可锚的一个导出名（改名 / 挪走 = 打断所有声明这一格的包）。
 */
export const LOADOUT_PHASES = Object.freeze({ locked: Object.freeze([PHASE.INFO_CHECK]), prep: Object.freeze([PHASE.INFO_CHECK, PHASE.PREP]) });

/**
 * 这一局的声明允许在哪些相位收 `room.loadout`。**两条来源**：上游 0.3.1 的房间规则
 * `rules.prepLoadout === 'prep'` 优先；否则读我们自有的模块层 `behaviour.prepLoadout`
 * （没声明 / 声明成 `locked` ⇒ `LOADOUT_PHASES.locked`，即引擎今天的行为；`prep` ⇒ 另加休整期）。
 * **只读**，不改任何东西。
 * @param {Array<{ switch: string, option: string }>|null|undefined} decl 本局合成后的行为声明
 * @param {Record<string, string>|null|undefined} [rules] 本局的内容插件规则
 * @returns {readonly string[]}
 */
export function loadoutPhasesFor(decl, rules = null) {
  if (ruleOption(rules, 'prepLoadout') === 'prep') return LOADOUT_PHASES.prep;
  // 判据只有一份（`shared/behaviour.js`）：与 `variants` 的 `variantValue` 同一个分工 —— 读取点问的是「哪一档」。
  return behaviourIsDefault(decl, 'prepLoadout') ? LOADOUT_PHASES.locked : LOADOUT_PHASES.prep;
}

/**
 * 休整期那一次提交的**合并**语义（行为开关 `prepLoadout: "prep"` 才有的一步）：在**当前配发**之上只覆盖这次
 * 写了的那些干员，没写的保留。
 *
 * 为什么不是整份替换：`room.loadout` 的 `entries` 是「本浏览器的干员调配」，而休整期的面板只会提交它**改过**的
 * 那几个座位 —— 整份替换会把其余干员默默打回默认（那是一个静默的规则改动，正是这一层要消灭的失败方向）。
 *
 * 形状上只做**浅**合并：**只**接受「对象、且每个值都是对象」的条目（其余原样交给
 * `PlayerState.setLoadout` 去拒 —— 这里不替它判合法性，判据只有那一份）。
 * @param {Record<string, any>|null|undefined} current 当前配发（`PlayerState.loadout`，已冻结的那一份）
 * @param {any} incoming 这一次提交的条目（原始形状）
 * @returns {Record<string, any>}
 */
export function mergeLoadoutEntries(current, incoming) {
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const [id, entry] of Object.entries(incoming)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[id] = entry;
    }
  }
  return out;
}

export class MatchPlatform {
  start() {
    if (this.disposed || this.ended || this.phase !== PHASE.LOBBY) return;
    this.guard(() => {
      if (!this.gd.visibleChess.length || this.pool.entries.size === 0) {
        this.log.error?.(`[match ${this.roomCode}] game data unusable (no chess pool) — ending the match`);
        this.phase = PHASE.INFO_CHECK;
        this.markPublic();
        this.flush(true);
        this.finish({ victory: false, reason: 'error' });
        return;
      }
      this.enterInfoCheck();
    });
  }

  /**
   * @param {string} playerId
   * @param {{ t: string }} msg validated intent
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  handle(playerId, msg) {
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    // a spectator seat only watches (the platform routes nothing else of it) — resyncing its own view of the public
    // state is part of watching, so it may ask for that too (DESIGN §8.2, incremental frame).
    // 测试房间的 g.test 必须**先**交给 applyTestCommand：那一条要写审计（testLog）并占限流格子，
    // 在这里直接拒会让它既不进日志也不占格子（test/test-mode 的 host/spectator 那条正是钉这个）。
    if (ps.spectator && (!msg || (msg.t !== 'g.watch' && msg.t !== 'g.publicFull'))) {
      if (ps.spectator && this.test && msg?.t === 'g.test') {
        let res;
        try { res = this.applyTestCommand(ps, msg); }
        catch (e) { this.reportError('handle g.test', e); res = fail(ERR.INTERNAL); }
        try { this.flush(); } catch (e) { this.reportError('flush', e); }
        return res && res.error ? res : OK;
      }
      return fail(ERR.SPECTATOR);
    }
    if (this.disposed || this.ended) {
      // A report that crossed the match end (the last b.progress of a field, a delegated rehearsal's answer) is stale:
      // ignored, never an error (DESIGN §14 — an error frame without a rid would surface as a toast in the browser).
      if (msg && msg.t === 'b.rehearsalResult') return OK;
      return this.clientCombat && msg && (msg.t === 'b.progress' || msg.t === 'b.result') ? OK : fail(ERR.WRONG_PHASE);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !GAME_TYPES.has(msg.t)) return fail(ERR.BAD_MSG);
    let res;
    try {
      res = this._handle(ps, msg);
    } catch (e) {
      this.reportError(`handle ${msg.t}`, e);
      res = fail(ERR.INTERNAL);
    }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
    if (res && typeof res === 'object' && res.error) return res;
    return OK;
  }

  /**
   * room.loadout during the match (DESIGN §16): only while INFO_CHECK runs (the briefing's 干员调配 entry) — 行为开关
   * `prepLoadout: "prep"`（DESIGN §28.43.1）在休整期也收一次；the lobby already checked it against the data
   * (PlayerState.setLoadout re-checks it). `ops` (0.2.2): the per-operator 潜能 / 练度 that come with it
   * (undefined = unchanged).
   *
   * **缺省档（`locked`）走的是从前那一条路**：相位不是这一格允许的那几个就 `WRONG_PHASE`，`loadout` 原样交给
   * `PlayerState.setLoadout`（整份替换）。只有 `prep` 档在 `PREP` 上多走一步 `mergeLoadoutEntries`（见那里的注释）。
   * room.loadout during the match (DESIGN §16): only while INFO_CHECK runs (the briefing's 干员调配 entry); the lobby
   * already checked it against the data (PlayerState.setLoadout re-checks it). `ops` (0.2.2): the per-operator 潜能 /
   * 练度 that come with it (undefined = unchanged). A room whose prepLoadout rule is prep also accepts one merge
   * during PREP while that seat has not pressed 准备 (DESIGN §36.15). INFO_CHECK stays a full replace.
   * @param {string} playerId
   * @param {Record<string, { skill: number, module: string|null }> | null} loadout
   * @param {Record<string, { potential: number, cultivate: number }> | null} [ops]
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setLoadout(playerId, loadout, ops = undefined) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    const phases = loadoutPhasesFor(this.behaviour, this.rules);
    const prep = this.phase === PHASE.PREP && phases.includes(PHASE.PREP);
    if (this.disposed || this.ended || !phases.includes(this.phase)) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    // 休整期里「准备就绪」等于把这一轮的配发定下来（`g.ready` 之后不再收）—— 缺省档根本走不到这里。
    if (prep && ps.ready) return fail(ERR.WRONG_PHASE, 'loadout locked for this match (this seat has readied up)');
    let res = OK;
    this.guard(() => {
      // 休整期这一次是**合并**（`{ merge: true }`，由 PlayerState.setLoadout 只覆盖这次写了的干员），
      // 并只对**这一件换装影响到的主人**重算召唤（上游 0.3.1 §36.15）：技能 / 模组 / 潜能 / 练度变了才重算。
      const before = prep ? ps.allChess().map((owner) => ({ owner, loadout: ps.loadoutFor(ps.gd.chess(owner.id)) })) : [];
      if (!ps.setLoadout(loadout, ops, prep ? { merge: true } : undefined)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      if (prep) {
        for (const { owner, loadout: previous } of before) {
          const next = ps.loadoutFor(ps.gd.chess(owner.id));
          if (['skillIndex', 'moduleId', 'potential', 'cultivate'].some((key) => previous[key] !== next[key])) ps._reconcileTokensFor(owner);
        }
        ps.recompute();
      } else this.markPrivate(ps);
    });
    return res;
  }

  /**
   * room.support during the match (助战, shared/support.js): only while INFO_CHECK runs, exactly like the loadout. The
   * lobby already checked it against the server's pool; PlayerState.setSupport re-checks it, because the pool is the
   * authority and a stale selection (the operator left data/support.json between the check and now) must not grant.
   * @param {string} playerId
   * @param {string[] | null} entries checked support ids
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setSupport(playerId, entries) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE, 'support locked for this match');
    let res = OK;
    this.guard(() => {
      if (!ps.setSupport(entries)) { res = fail(ERR.BAD_TARGET, 'support does not match the server pool'); return; }
      this.markPrivate(ps);
    });
    return res;
  }

  /**
   * room.skins during the match (docs/SKINS.md): accepted in ANY phase, unlike the loadout just above. The loadout is
   * locked at INFO_CHECK because it changes what a unit does; a skin changes only what it looks like, and it is public —
   * a teammate picking a different model mid-match is harmless, so `markPublic` carries it to everyone on the next
   * broadcast. The lobby already filtered the shape (freezeSkins); PlayerState.setSkins re-checks it and refuses a
   * bad map without clearing the choice already stored.
   * @param {string} playerId
   * @param {Record<string, string> | null} skins
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setSkins(playerId, skins) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    let res = OK;
    this.guard(() => {
      // an empty selection is a valid one: it clears every skin. A bad map leaves the stored choice alone.
      if (!ps.setSkins(skins)) { res = fail(ERR.BAD_MSG, 'bad skin selection'); return; }
      // [ASSUMED] Live cosmetic changes refresh every existing prep view, using the same dirty path as a move.
      // The public choice also reaches current battle renderers; no running sim or BattleSpec is changed.
      this.markPrivate(ps);
      this.markPublic();
    });
    return res;
  }

  onDisconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || this.disposed) return;
    this.guard(() => {
      ps.connected = false;
      // A disconnected human's silence is never consent to a new setup.
      this.cancelSetupVote();
      // a paused solo battle resumes (the server takes the field over; nobody is left to resume it)
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'disconnect');
      // a rehearsal this host was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      // the member set the next m.public is built for changed: the frame goes out full, so every remaining client's
      // baseline is one frame the whole room shares again (DESIGN §8.2, incremental frame)
      this.markMembershipChanged();
    });
  }

  onReconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      const was = ps.connected;
      ps.connected = true;
      this._resync(ps);
      // a returning member's own state is freshly full, but the ROOM's baseline has to stay one every client shares:
      // the next frame is full for everybody, which costs one frame per reconnect and no per-client bookkeeping
      if (!was) this.markMembershipChanged();
    });
  }

  /**
   * `g.publicFull` — the client could not merge a delta (it has no materialized state, or a patch named a seat it does
   * not know) and asks for the full frame again (DESIGN §8.2, incremental frame: the self-healing path). Answered
   * immediately as a unicast, and, like every resync, the ROOM's next frame is full so all clients share one baseline.
   */
  resendPublic(playerId) {
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return fail(ERR.NOT_IN_ROOM);
    this.guard(() => {
      // the answer is a unicast full frame; a send that does not reach the socket is not an error to report (sendTo
      // already logs it), and the room-wide full frame below is the same answer for everybody anyway
      this._sendFullPublic(ps);
      this.markMembershipChanged();
    });
    this.flush();
    return OK;
  }

  /**
   * The full state of one human (a reconnect, a resync, a spectator seat): m.public, its m.private (players only), the
   * field it is on / watches — a spectator, like an eliminated player, the field of the player it follows (item 56),
   * else the first; in a prep phase that player's board — or the result once ended.
   */
  _resync(ps) {
    const playerId = ps.playerId;
    // a full frame, never a delta: a (re)connected client has no baseline (DESIGN §8.2, incremental frame — "a joiner
    // always gets one full frame first")
    this._sendFullPublic(ps);
    if (!this.ended) {
      if (!ps.spectator) {
        ps._lastPriv = null;
        this._sendPrivate(ps, true);
      }
      if (this.clientCombat) this._resendBattle(ps);
      else if (!this.fields.length && this._follows(ps)) this._followScout(ps, { keep: true });
      else {
        let fid = this.watchers.get(playerId);
        if (!fid && ps.spectator && this.fields.length) { fid = (this._watchTargetField(ps, this.fields) || this.fields[0]).fieldId; this.watchers.set(playerId, fid); }
        if (fid) this._sendField(playerId, fid);
      }
    } else if (this.lastResultMsg) {
      this.sendTo(playerId, { ...this.lastResultMsg, playerId });
    }
  }

  onLeave(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      ps.left = true;
      this.cancelSetupVote();
      ps.connected = false;
      ps.autoplay = false;
      this.watchers.delete(playerId);
      if (this.ended) return;
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'left');
      // a rehearsal the departed seat was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      this.markMembershipChanged();
      if (!this.order.some((p) => !p.isBot && !p.left)) {
        this.finish({ victory: false, reason: 'abandoned' });
        return;
      }
      this._quit(ps);
    });
  }

  /**
   * 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3): every copy the player holds goes back
   * to the shared pool at once, and the seat has no place in later rounds, the Final Assault pairing or the boss pool
   * (bloodPoint per player alive at the fight's start, DESIGN §25.13.4). Rounds passed = the rounds the player had
   * survived when leaving.
   */
  _quit(ps) {
    this.maybeEndInfo();
    if (!ps.alive) return;
    const phase = this.phase;
    const d = this.draft;
    if (phase === PHASE.BAND_DRAFT && d && !d.picks[ps.playerId]) {
      // the departed seat passes its turn with the default band (never one a teammate holds — defaultBand)
      const turn = this.draftTurn() === ps.playerId;
      d.picks[ps.playerId] = this.defaultBand(ps.playerId);
      ps.bandId = d.picks[ps.playerId];
      if (turn) this.startDraftTurn();
    }
    const passedRound = phase === PHASE.SETTLE ? this.round + 1 : Math.max(1, this.round);
    // its own normal battle has nobody left to fight for
    for (const f of this.fields) {
      if (f.live && f.kind === 'normal' && f.players.length === 1 && f.players[0] === ps.playerId) {
        if (this.clientCombat && f.cc) {
          if (!f.result) f.result = syntheticResult(f.players);
          this._fieldDone(f);
          continue;
        }
        try { f.battle.forceEnd('left'); } catch (e) { this.reportError('quit forceEnd', e); }
      }
    }
    ps.lp = 0;
    ps.eliminate(passedRound);
    this.offersChanged();
    this.tickerText(msg('{name}博士中途退出了模拟', { name: ps.name }), FLOW_TICKER_PRIORITY);
    if (this.bossWaves && (phase === PHASE.ROUND_START || phase === PHASE.SP_DRAFT || phase === PHASE.PREP)) {
      // before the boss fight: pair the players left again (the prep preview shows the new partner / template); a
      // player moved to the other half re-checks its board there at once (recompute → deployMap, marks it private)
      this._planBossWaves();
      for (const p of this.alivePlayers()) p.recompute();
    }
    // whoever scouted the departed player's board follows the next player still in (item 56)
    for (const v of this._viewers()) if (this.watchers.get(v.playerId) === `n:${ps.playerId}`) this._followScout(v);
    this.markPublic();
    if (this.teamLp != null) this._syncTeamLp();
    if (!this.alivePlayers().length) {
      // only eliminated spectators are left
      this.finish({ victory: false, reason: 'eliminated' });
      return;
    }
    if (phase === PHASE.SP_DRAFT && this.sp && this.spTurn() === ps.playerId) this.startSpTurn();
    else if (phase === PHASE.PREP) this.maybeEndPrep();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } }
    this._stopClientCombat();
    this._cancelRehearsal();
    // a plugin interaction window's own deadline timer (MatchOffers); the tracked timers below cover the rest
    if (typeof this.offersDispose === 'function') { try { this.offersDispose(); } catch { /* ignore */ } }
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    if (this._pubTimer) { try { this.sched.clearTimeout(this._pubTimer); } catch { /* ignore */ } this._pubTimer = null; }
    if (this.ownsScheduler) this.sched.dispose();
  }
}
