// server/match/match/phases.js — Match methods: the round flow up to the prep — INFO_CHECK, the strategy draft
// (BAND_DRAFT: one countdown of BAND_TURN_SECONDS per turn, 队友已选, the highlighted strategy on a timeout, skips),
// BATTLE_CHECK and ROUND_START (the round's enemies — a normal wave or the boss pairing — planned before the players'
// round start).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { buildNormalWave, buildBossWave } from '../waves.js';
import { pairPlayers } from '../finalAssault.js';
import { botPickBand } from '../bot.js';
import { OK, fail, DELAYS, BAND_TURN_SECONDS } from './common.js';

/**
 * 「试玩时直接发到手上」—— 哪些干员要在第一回合进手牌（业主 2026-10-08 提的开关）。
 *
 * 为什么只在试玩里生效：工坊/助战干员的正规来路是**商店**（0.5.0 起「不白送」，见 docs/WORKSHOP.md §2.3），
 * 直接把牌塞进手里会让正式对局的规则变形。作者真正要的是「试玩时立刻拿它开一局」，所以这里读的是编辑器
 * spawn 出来的那个一次性服务器进程的环境变量（`SP_PLAYTEST=1`，editor/playtest.mjs 设的）：
 * **正式服务器一个都不发** —— 即使装了一个声明了这个开关的包，`SP_PLAYTEST` 也不是 `1`。
 *
 * 名单是**两个来源的并集**：
 *   ① 记录里自带 `directToHand: true` 的（非覆盖的工坊件；今天的写法，向后兼容，一个字都没改）；
 *   ② `pack.json.playtest.directToHand` 声明的（覆盖模式靠这条 —— 覆盖时记录必须与官方同形，
 *      `directToHand` 那个键写不进去，见 editor/server.mjs 的 `stripEditorOnlyKeys`）。
 * ②由编辑器在 `/api/playtest/start` 算出来，经 `SP_DIRECT_TO_HAND=<逗号分隔 id>` 交给子进程（与 `SP_STAGE` 同一条路）。
 *
 * 名单里一个 `visibleChess` 里没有的 id 只是**不出现在结果里**，不抛错：那是声明侧该拦的事
 * （`PLAYTEST_UNKNOWN_CHESS`），引擎不该为了一个坏 id 把一局打不开。
 *
 * 取牌走的是共享池（`pool.take`），所以「池里那一份」是真的被拿走的 —— 与开局礼包不同，这里不会凭空多出一份拷贝。
 * @param {object} gd 这一局的 GameData
 * @param {Record<string, string|undefined>} [env] 默认 `process.env`（单测直接喂一个假环境）
 * @returns {string[]} 可见、非精锐、且被两个来源之一点名的干员 id
 */
export function directToHandIds(gd, env = process.env) {
  if (String((env && env.SP_PLAYTEST) || '') !== '1') return [];
  const fromEnv = new Set(
    String((env && env.SP_DIRECT_TO_HAND) || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  return ((gd && gd.visibleChess) || []).filter((id) => {
    const rec = gd.chess(id);
    if (!rec || rec.isGolden) return false;
    return rec.directToHand === true || fromEnv.has(id);
  });
}

export class MatchPhases {
  enterInfoCheck() {
    this.phase = PHASE.INFO_CHECK;
    for (const ps of this.order) if (ps.botControlled) ps.infoReady = true;
    // solo: no time limit (the player confirms); co-op: the official 25 s guard
    this.setDeadline(this.soloUntimed ? 0 : this.gd.timer('infoCheck'), () => this.enterBandDraft());
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
    this.maybeEndInfo();
  }

  maybeEndInfo() {
    if (this.phase !== PHASE.INFO_CHECK) return;
    if (this.order.every((p) => p.isBot || p.left || p.infoReady)) {
      this.setDeadline(0);
      this.later(0, () => { if (this.phase === PHASE.INFO_CHECK) this.enterBandDraft(); });
    }
  }

  /**
   * The strategy draft (user playtest #4 item 4): ONE countdown — every turn has the same clock, BAND_TURN_SECONDS, and
   * m.public.deadline is the current turn's end (= draft.turnDeadline; the step header and the turn indicator show the
   * same number). No separate step cap: the turns bound the step (≤ (seats + skips) × turn). AI seats pick at once. A
   * turn that runs out takes the strategy the player has highlighted (g.bandFocus) while it is free, else the default
   * (timeoutBand). Solo, and any single-human match (soloUntimed): untimed. Solo also keeps seat order and has no skip.
   */
  enterBandDraft() {
    if (this.phase !== PHASE.INFO_CHECK) return;
    this.phase = PHASE.BAND_DRAFT;
    let order = this.order.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order = this.humansFirst(order);
    const skips = this.isSolo ? 0 : this.gd.bandDraft.skipsPerPlayer;
    const untimed = this.soloUntimed;
    this.draft = {
      order, idx: 0, picks: {}, skipsLeft: Object.fromEntries(order.map((pid) => [pid, skips])), untimed, turnDeadline: 0,
      /** playerId → the strategy highlighted in the draft screen (g.bandFocus) */
      focus: new Map(),
    };
    this.setDeadline(0);
    this.startDraftTurn();
    this.markPublic();
  }

  /**
   * The co-op room option 「AI 队友最后选择」 (this.aiPicksLast, GitHub #338): every human seat before every AI seat, each
   * group in the order the draft drew (a stable partition applied AFTER the shuffle — no extra random draw: the order
   * with the option off is unchanged, and with it on every random stream stands where it would without it; only the
   * picks made in the new order can differ). A human is any seat that is not an AI seat (room.addBot): under AI 托管,
   * disconnected or departed it still counts as a human. Used by the strategy draft and the 机变 draft
   * (MatchSpDraft.enterSpDraft).
   * @param {string[]} order playerIds in drawn order
   * @returns {string[]}
   */
  humansFirst(order) {
    if (!this.aiPicksLast) return order;
    const bot = (pid) => !!this.players.get(pid)?.isBot;
    return [...order.filter((pid) => !bot(pid)), ...order.filter(bot)];
  }

  draftTurn() {
    const d = this.draft;
    if (!d) return null;
    return d.order[d.idx] ?? null;
  }

  /** Real ms of one strategy-draft turn (BAND_TURN_SECONDS × timerScale). */
  bandTurnMs() { return this.scaled(BAND_TURN_SECONDS * 1000); }

  startDraftTurn() {
    const d = this.draft;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    while (d.idx < d.order.length && d.picks[d.order[d.idx]]) d.idx++;
    if (d.idx >= d.order.length) {
      d.turnDeadline = 0;
      this.deadline = 0;
      this.later(0, () => this.finishBandDraft(false));
      return;
    }
    const token = ++this._turnToken;
    if (!d.untimed) {
      const ms = this.bandTurnMs();
      d.turnDeadline = this.sched.now() + ms;
      // the step's countdown IS the turn's (one number everywhere)
      this.deadline = d.turnDeadline;
      this._turnTimer = this.later(ms, () => {
        if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
        const pid = this.draftTurn();
        if (pid) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
      });
    } else {
      d.turnDeadline = 0;
      this.deadline = 0;
    }
    const cur = this.players.get(this.draftTurn());
    if (cur && cur.botControlled) this.scheduleBandBot();
    this.markPublic();
  }

  /** An AI seat's (or an AI 托管 seat's) turn: it picks at once (user playtest #4 item 4 — nobody waits on the AI). */
  scheduleBandBot() {
    const token = this._turnToken;
    this.later(0, () => {
      if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
      const ps = this.players.get(this.draftTurn());
      if (!ps || !ps.botControlled) return;
      // a strategy a teammate already took is not selectable (队友已选): the bot re-draws, else the first free one
      let id = botPickBand(this, ps);
      for (let k = 0; k < 8 && this.bandTaken(id, ps.playerId); k++) id = botPickBand(this, ps);
      if (this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
      this._applyBand(ps, id, { dedupe: true });
    });
  }

  /**
   * Whether `bandId` was already picked by another player of this draft. Research 09 §5 / DESIGN §14 corrections:
   * the strategy draft marks a teammate's pick as 队友已选 and it cannot be chosen again (co-op). The automatic
   * assignments — a turn that runs out and a departing seat — obey the same rule: see timeoutBand / defaultBand.
   */
  bandTaken(bandId, playerId) {
    const picks = this.draft?.picks || {};
    for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
    return false;
  }

  /**
   * The strategy an automatic assignment gives `playerId` (a departing seat; a timed-out turn without a usable
   * highlight, timeoutBand): the official default 「华法琳」 (bandDraft.timeoutBandId) while no teammate holds it, else the
   * first strategy of the mode (sortId order, gd.bandIds) that nobody else picked — never a duplicate (队友已选; the
   * client shows the same choice: public/js/screens/bandDraft.js timeoutBand). Solo drafts have no teammates, so it is
   * always the default.
   * @param {string} playerId
   */
  defaultBand(playerId) {
    const def = this.gd.bandDraft.timeoutBandId;
    if (!this.bandTaken(def, playerId)) return def;
    return this.gd.bandIds().find((b) => !this.bandTaken(b, playerId)) || def;
  }

  /**
   * What a turn that runs out assigns (user playtest #4 item 4): the strategy the player has highlighted in the draft
   * screen (g.bandFocus — the detail pane's band, the one 确认选择 would take) while it is allowed and no teammate holds
   * it, else defaultBand.
   * @param {string} playerId
   */
  timeoutBand(playerId) {
    const f = this.draft && this.draft.focus instanceof Map ? this.draft.focus.get(playerId) : null;
    if (typeof f === 'string' && this.gd.bandAllowed(f) && !this.bandTaken(f, playerId)) return f;
    return this.defaultBand(playerId);
  }

  /**
   * g.bandFocus { bandId? }: the strategy the player highlights in the draft screen (any time before its pick; also
   * while waiting for its turn). A missing / null bandId clears it. Only a timed-out turn reads it (timeoutBand).
   */
  bandFocus(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (!(d.focus instanceof Map)) d.focus = new Map();
    if (bandId == null) { d.focus.delete(ps.playerId); return OK; }
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    d.focus.set(ps.playerId, bandId);
    return OK;
  }

  pickBand(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    if (this.draft.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    if (this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选'); // i18n-ignore: developer detail (players see ERR_TEXT)
    this._applyBand(ps, bandId);
    return OK;
  }

  _applyBand(ps, bandId, { dedupe = false } = {}) {
    const d = this.draft;
    if (!d || !ps || d.picks[ps.playerId]) return;
    let id = this.gd.bandAllowed(bandId) ? bandId : this.defaultBand(ps.playerId);
    if (dedupe && this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
    d.picks[ps.playerId] = id;
    ps.bandId = id;
    ps.lp = this.gd.startLp(id);
    this.markPrivate(ps);
    this.markPublic();
    this.startDraftTurn();
  }

  skipBand(ps) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (this.isSolo) return fail(ERR.WRONG_PHASE, 'no skip in solo');
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!(d.skipsLeft[ps.playerId] > 0)) return fail(ERR.ALREADY, 'no skip left');
    if (d.order.length - d.idx <= 1) return fail(ERR.BAD_TARGET, 'nobody to pass to');
    d.skipsLeft[ps.playerId]--;
    d.order.splice(d.idx, 1);
    // the skipper goes to the end; with 「AI 队友最后选择」 to the end of the humans still to pick — behind them, ahead of
    // the AI seats — and to the very end only when no other human is left to pass to [ASSUMED: the option's intent,
    // humans before AI, kept through a skip; no source, a remake option]
    let at = d.order.length;
    if (this.aiPicksLast) {
      for (let j = d.order.length - 1; j >= d.idx; j--) {
        if (!this.players.get(d.order[j])?.isBot) { at = j + 1; break; }
      }
    }
    d.order.splice(at, 0, ps.playerId);
    this.startDraftTurn();
    return OK;
  }

  finishBandDraft(timeout) {
    if (this.phase !== PHASE.BAND_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    for (const ps of this.order) {
      if (!this.draft.picks[ps.playerId]) {
        // one after another in seat order, so each default sees the ones assigned before it (no duplicates)
        const id = this.defaultBand(ps.playerId);
        this.draft.picks[ps.playerId] = id;
        ps.bandId = id;
        ps.lp = this.gd.startLp(id);
      }
      this.markPrivate(ps);
    }
    void timeout;
    this.enterBattleCheck();
  }

  enterBattleCheck() {
    this.phase = PHASE.BATTLE_CHECK;
    this.setDeadline(this.gd.timer('battleCheck'), () => this.startRound(1), { silent: this.soloUntimed });
    this.markPublic();
  }

  startRound(r) {
    this.phase = PHASE.ROUND_START;
    this.round = r;
    this.fields = [];
    this.watchers.clear();
    this.unitePlan = null;
    this.uniteResultView = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    const alive = this.alivePlayers();
    // the round's enemies (shared composition, generated now so the prep preview is exact). Planned BEFORE the players'
    // round start: its recompute() checks the board on the field the player deploys on this round (deployFieldOf reads
    // the boss pairing), so R14 → R15 never re-checks a boss-field board against the normal field (user playtest #5
    // item 7). rngWaves is used only here, so the order leaves every random stream unchanged.
    const isBoss = r === this.gd.bossRound || r === this.gd.hiddenRound;
    if (isBoss) {
      this._planBossWaves();
    } else {
      // stageId: a workshop stage may bind its own wave table to a round (shared/waveAuthoring.js; waves.js buildNormalWave)
      this.wave = buildNormalWave(this.gd, this.rngWaves, this.factions, r, this.stageId);
    }
    for (const ps of alive) ps.startRound(r);
    // 助战 (shared/support.js): re-check what each player brought against the pool ONE more time at the first round's
    // start and record what it really got (data/support.json can change between the lobby check and here). Nothing is
    // handed out: the operators are in the shop (Match.supportSupply puts them in the pool), priced like any other
    // piece — `granted` is what the player can actually buy, which is what the client echoes back.
    if (r === 1) for (const ps of alive) ps.prepareSupports();
    // 「试玩时直接发到手上」（记录里的 `directToHand`，或 `pack.json.playtest.directToHand`，业主 2026-10-08）：
    // 只有编辑器 spawn 的试玩服务器会发牌（见 directToHandIds）
    if (r === 1) this.grantDirectToHand(alive);
    for (const ps of alive) this.dispatch(ps, 'onRoundStart', { round: r });
    // an eliminated player's pending 信标 gift still goes to its teammate (effects flagged afterElimination; GitHub #86)
    for (const ps of this.order) {
      if (ps.alive) continue;
      try { this.dispatcher.dispatchEliminated(ps, 'onRoundStart', { round: r }); } catch (e) { this.reportError('dispatch onRoundStart (eliminated)', e); }
    }
    for (const ps of alive) ps.recompute();
    this.setDeadline(DELAYS.ROUND_START / 1000, () => this.afterRoundStart(), { silent: this.soloUntimed });
    this.markPublic();
    // eliminated humans and spectator seats scout the board of the player they follow through the round's prep, not
    // their own empty board (community report of 2026-10-06, item 56; MatchWatch._followScout)
    for (const ps of this._viewers()) this._followScout(ps);
  }

  /**
   * @param {Array<object>} players 这一局的人类席位
   */
  grantDirectToHand(players) {
    const ids = directToHandIds(this.gd, process.env);
    if (!ids.length) return;
    for (const ps of players) {
      if (!ps || ps.isBot) continue;
      const got = [];
      for (const id of ids) {
        const slot = ps.hand.findIndex((x) => x == null);
        if (slot < 0) break;
        try {
          const rec = this.gd.chess(id);
          const base = this.gd.baseIdOf(id);
          const taken = this.pool.take(base, rec && rec.isGolden ? this.gd.goldenCopies : 1);
          ps.hand[slot] = ps.newPiece('chess', id, { poolCopies: taken });
          got.push(id);
        } catch (e) {
          this.reportError?.(`directToHand ${id}`, e);
        }
      }
      if (got.length) {
        // 让作者一眼看到「试玩直接发牌」生效了（试玩服务器是编辑器起的，不会有人误解成正式对局）
        this.toast(ps, 'ok', msg('试玩：标了「直接发到手上」的 {0} 名干员已进手牌', { 0: got.length }));
      }
      ps.recompute?.();
      ps.dirty?.();
    }
  }

  /** The boss round's fields (seat pairs of the alive players) and their templates, generated for the prep preview. */
  _planBossWaves() {    const r = this.round;
    const bossId = r === this.gd.hiddenRound && r !== this.gd.bossRound ? this.hiddenBossId : this.bossId;
    this.bossWaves = pairPlayers(this.alivePlayers()).map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, r, { bossId, solo: this.isSolo || g.length === 1 }, this.stageId),
    }));
  }

  afterRoundStart() {
    if (this.gd.spRounds().includes(this.round)) this.enterSpDraft();
    else this.enterPrep();
  }
}
