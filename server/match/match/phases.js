// server/match/match/phases.js — Match methods: the round flow up to the prep — INFO_CHECK, the strategy draft
// (BAND_DRAFT: one countdown of BAND_TURN_SECONDS per turn, 队友已选, the highlighted strategy on a timeout, skips),
// CUSTOM_CHECK (选择自编, only when the data has diyBringLimits), BATTLE_CHECK and ROUND_START (the round's enemies —
// a normal wave or the boss pairing — planned before the players' round start).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { buildNormalWave, buildBossWave } from '../waves.js';
import { pairPlayers, bossPairSalt } from '../finalAssault.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { OK, fail, DELAYS, BAND_TURN_SECONDS } from './common.js';
import { SharedPool, bannedChessForBonds } from '../pool.js';
import { botPickBondGroup } from '../botBondGroups.js';
import { LEGACY_BOT } from '../botStrategyContract.js';
import { diySlot, diySlotIds } from '../../../shared/diy.js';
import { botPickDiy, checkDiyBring, defaultDiyBring } from '../../../shared/diyBring.js';

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
 * 取牌走 `PlayerState.poolOf` —— 唯一分派点（design-level A, docs/PS100-MIGRATION.md §10-A）：`≤ MAX_SEATS` 时它就是共享池
 * （同一个 `m.pool` 对象），座位变体打开时是本玩家自己的池。两种情况下「池里那一份」都是真的被拿走的 —— 与开局礼包不同，
 * 这里不会凭空多出一份拷贝。
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
    for (const ps of this.order) if (ps.botControlled) {
      this.pickBotBondGroup(ps);
      ps.infoReady = true;
    }
    // solo: no time limit (the player confirms); co-op: the official 25 s guard
    this.setDeadline(this.soloUntimed ? 0 : this.gd.timer('infoCheck'), () => this.enterBandDraft());
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
    this.maybeEndInfo();
  }

  pickBotBondGroup(ps) {
    if (this.bondChoice?.picked === null) this.pickBondGroup(ps, botPickBondGroup(this, ps), this.setupRevision);
  }

  pickBondGroup(ps, idx, revision) {
    if (this.phase !== PHASE.INFO_CHECK || this.setupVote || !this.bondChoice || this.bondChoice.picked !== null) return fail(ERR.WRONG_PHASE);
    if (ps.left || !this.players.has(ps.playerId)) return fail(ERR.NOT_IN_ROOM);
    if (revision !== this.setupRevision || !Number.isInteger(idx) || idx < 0 || idx > 1) return fail(ERR.BAD_TARGET);
    // INFO_CHECK has no shop roll or opening grants. Rebuild its provisional stock before the strategy draft.
    const drawn = [...this.disabledBonds, ...this.bondChoice.groups[1 - idx]].sort();
    const banned = bannedChessForBonds(this.gd, drawn, this.staticInactiveBonds);
    const pool = new SharedPool(this.gd, { banned });
    const off = new Set([...drawn, ...this.staticInactiveBonds]);
    const stocks = this.order.map(p => p.buildDiyStock(off));
    this.disabledBonds = drawn;
    this.bannedChess = banned;
    this.pool = pool;
    this.bondChoice.picked = idx;
    for (const [i, p] of this.order.entries()) {
      p.diyStock = stocks[i].stock;
      p.diyBanned = stocks[i].banned;
      this.markPrivate(p);
    }
    this.markPublic();
    return OK;
  }

  maybeEndInfo() {
    if (this.phase !== PHASE.INFO_CHECK || this.setupVote || this._infoAdvanceTimer) return;
    if (this.order.every((p) => p.isBot || p.left || p.infoReady)) {
      this.setDeadline(0);
      this._infoAdvanceTimer = this.later(0, () => {
        this._infoAdvanceTimer = null;
        if (this.phase === PHASE.INFO_CHECK && !this.setupVote) this.enterBandDraft();
      });
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
    // [ASSUMED] A human who confirms or times out without choosing keeps the seeded first group.
    if (this.bondChoice?.picked === null) this.pickBondGroup(this.order[0], 0, this.setupRevision);
    this.phase = PHASE.BAND_DRAFT;
    // The opening is settled, so no reroll cooldown outlives this phase.
    this._rerollStartAt.clear();
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
    if (this.test) this.setDeadline(0);
    while (d.idx < d.order.length && d.picks[d.order[d.idx]]) d.idx++; // loop-cap: draft order
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
      const expire = () => {
        if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
        const pid = this.draftTurn();
        if (pid) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
      };
      if (this.test) { this.setDeadline(ms / 1000 / (this.timerScale || 1), expire); d.turnDeadline = this.deadline; }
      else this._turnTimer = this.later(ms, expire);
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
      // a co-op seat gone before its pick has no game of its own to play: whatever strategy plays the AI seats, it drafts
      // by the team's rule (botPickBand's departedWeight: Touch while nobody else holds it, never 歌利亚; §37.65)
      const bot = !this.isSolo && ps.alive === false ? LEGACY_BOT : this.botFor(ps);
      const fallback = () => {
        // a strategy a teammate already took is not selectable (队友已选): the bot re-draws, else the first free one
        let id = bot.pickBand(this, ps);
        for (let k = 0; k < 8 && this.bandTaken(id, ps.playerId); k++) id = bot.pickBand(this, ps);
        if (this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
        this._applyBand(ps, id, { dedupe: true });
      };
      if (bot.decide?.(this, ps, { kind: 'band',
        valid: () => this.phase === PHASE.BAND_DRAFT && token === this._turnToken,
        complete: () => token !== this._turnToken || !!this.draft?.picks[ps.playerId], fallback })) return;
      fallback();
    });
  }

  /**
   * Whether `bandId` was already picked by another player of this draft. Research 09 §5 / DESIGN §14 corrections:
   * the strategy draft marks a teammate's pick as 队友已选 and it cannot be chosen again (co-op). The automatic
   * assignments — a turn that runs out, the AI's pick (also for a departed seat, scheduleBandBot) — obey the same rule:
   * see timeoutBand / defaultBand.
   */
  bandTaken(bandId, playerId) {
    const picks = this.draft?.picks || {};
    for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
    return false;
  }

  /**
   * The strategy an automatic assignment gives `playerId` (a timed-out turn without a usable highlight, timeoutBand; a
   * seat still to pick when finishBandDraft ends the draft): the official default 「华法琳」 (bandDraft.timeoutBandId)
   * while no teammate holds it, else the first strategy of the mode (sortId order, gd.bandIds) that nobody else picked —
   * never a duplicate (队友已选; the client shows the same choice: public/js/screens/bandDraft.js timeoutBand). Solo drafts
   * have no teammates, so it is always the default.
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
    // the strategy's starting LP is a living seat's: one gone before its pick (its turn is the AI's) keeps the 0 it left
    // with (_quit), in m.public and the result as well (§37.65)
    if (ps.alive) ps.lp = this.gd.startLp(id);
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
        if (ps.alive) ps.lp = this.gd.startLp(id); // a seat gone before its pick keeps its 0 (_applyBand)
      }
      this.markPrivate(ps);
    }
    void timeout;
    if (this.gd.diyBringLimits) this.enterCustomCheck();
    else this.enterBattleCheck();
  }

  _diyOff() { return new Set([...this.disabledBonds, ...this.staticInactiveBonds]); }

  /** Bond-excluded slot ids of this player's current roster (the cards 选择自编 greys out). */
  _diyBannedSlots(ps) {
    const off = this._diyOff();
    const banned = [];
    for (const slotId of Object.keys(ps?.diy || {})) {
      const rec = ps._diyRecords.get(slotId);
      if (rec && this.gd.bondsExclude(rec, off)) banned.push(slotId);
    }
    return banned;
  }

  /**
   * The bring a seat gets when it does not choose: a bot's ranked picks, otherwise the first legal slots per tier
   * [ASSUMED]. An empty bot roster is synthesized first.
   * @param {any} ps
   * @returns {string[]}
   */
  _diyChoice(ps) {
    const limits = this.gd.diyBringLimits;
    const off = this._diyOff();
    if (ps.isBot && Object.keys(ps.diy || {}).length === 0) ps.synthesizeBotRoster(off, limits);
    const data = this.gd.raw;
    const tierOf = (id) => diySlot(id, data)?.tier ?? null;
    const order = diySlotIds(data);
    const ctx = { roster: ps.diy || {}, banned: this._diyBannedSlots(ps), limits, tierOf };
    if (ps.isBot) {
      return botPickDiy(order, {
        ...ctx,
        rank: (id) => {
          const rec = ps._diyRecords.get(id);
          const bonds = Array.isArray(rec?.bonds) ? rec.bonds : [];
          return { count: bonds.filter((b) => !off.has(b)).length, charId: ps.diy[id]?.charId || '' };
        },
      });
    }
    return defaultDiyBring(order, ctx);
  }

  _applyDiyBring(ps, slots) {
    if (!ps || ps.diyBring != null) return;
    ps.diyBring = Object.freeze([...slots]);
    const built = ps.buildDiyStock(this._diyOff());
    ps.diyStock = built.stock;
    ps.diyBanned = built.banned;
    this.markPrivate(ps);
  }

  /**
   * 选择自编. Bot-controlled seats confirm immediately.
   * [ASSUMED] Solo and a lone human are untimed, like the other decision steps. Co-op with two or more humans uses
   * the enter-step seconds (30 on 规程).
   */
  enterCustomCheck() {
    if (!this.gd.diyBringLimits) { this.enterBattleCheck(); return; }
    this.phase = PHASE.CUSTOM_CHECK;
    for (const ps of this.order) {
      if (ps.botControlled) this._applyDiyBring(ps, this._diyChoice(ps));
    }
    this.setDeadline(this.soloUntimed ? 0 : this.gd.customCheckSeconds(), () => this.finishCustomCheck(true));
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
    this.maybeEndCustom();
  }

  /**
   * g.diyBring { slots }: confirm the slots this match brings. Any illegal slot refuses the whole list.
   * An empty list is 禁用自选.
   * @param {any} ps
   * @param {string[]} slots
   */
  confirmDiyBring(ps, slots) {
    if (this.phase !== PHASE.CUSTOM_CHECK || !this.gd.diyBringLimits) return fail(ERR.WRONG_PHASE);
    if (!ps || ps.left || ps.spectator || !this.players.has(ps.playerId)) return fail(ERR.NOT_IN_ROOM);
    if (ps.diyBring != null) return fail(ERR.ALREADY);
    const data = this.gd.raw;
    const res = checkDiyBring(slots, {
      roster: ps.diy || {},
      banned: this._diyBannedSlots(ps),
      limits: this.gd.diyBringLimits,
      tierOf: (id) => diySlot(id, data)?.tier ?? null,
    });
    if (!res.ok) return fail(res.error === 'BAD_MSG' ? ERR.BAD_MSG : ERR.BAD_TARGET, res.detail);
    this._applyDiyBring(ps, res.slots);
    this.markPublic();
    this.maybeEndCustom();
    return OK;
  }

  maybeEndCustom() {
    if (this.phase !== PHASE.CUSTOM_CHECK || this._diyAdvanceTimer) return;
    if (!this.order.every((p) => p.diyBring != null || p.left)) return;
    this.setDeadline(0);
    this._diyAdvanceTimer = this.later(0, () => {
      this._diyAdvanceTimer = null;
      if (this.phase === PHASE.CUSTOM_CHECK) this.finishCustomCheck(false);
    });
  }

  finishCustomCheck(timeout) {
    if (this.phase !== PHASE.CUSTOM_CHECK) return;
    this.cancel(this._diyAdvanceTimer);
    this._diyAdvanceTimer = null;
    void timeout;
    for (const ps of this.order) {
      if (ps.diyBring == null) this._applyDiyBring(ps, this._diyChoice(ps));
    }
    this.enterBattleCheck();
  }

  enterBattleCheck() {
    this.phase = PHASE.BATTLE_CHECK;
    this.setDeadline(this.gd.timer('battleCheck'), () => this.afterBattleCheck(), { silent: this.soloUntimed });
    this.markPublic();
  }

  /**
   * BATTLE_CHECK is over: R1 is about to begin. A plugin window declared at `battleCheck` for this round opens here —
   * "before the round begins", the host's own step first (docs/PLUGINS.md §10b) — and holds R1 back until it closes; a
   * content set without a window continues exactly as before (`openOfferWindow` returns before it touches anything).
   */
  afterBattleCheck() {
    this.startRound(1);
  }

  startRound(r, afterStart = null) {
    // Every round, including boss rounds. [ASSUMED] Expire nonblocking windows at the next round.
    for (const w of this.offerWin) this._closeOffer(w);
    this.offersDispose(); // A test-console round jump must discard the older continuation too.
    const step = () => { this._startRoundAfterOffers(r); afterStart?.(); };
    if (this.openOfferWindow('battleCheck', r) !== 'open') { step(); return; }
    this._offerResume = step;
  }

  _startRoundAfterOffers(r) {
    this.phase = PHASE.ROUND_START;
    this.round = r;
    this.fields = [];
    this.watchers.clear();
    this.unitePlan = null;
    this.uniteResultView = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.bossPairsRound = null;
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
          // 份数走 `PlayerState.poolOf` —— 唯一分派点（design-level A, docs/PS100-MIGRATION.md §10-A）：自选槽走本人 stock、
          // 100 座变体走本玩家自己的池，≤ MAX_SEATS 时它就是 `this.pool` 本身（同一个对象上的同一条语句）。
          // 从共享目录直接 take 会让变体下的目录 `left < cap`，正是变体要消灭的东西。
          const taken = ps.poolOf(base).take(base, rec && rec.isGolden ? this.gd.goldenCopies : 1);
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

  /** The round's pairs and their templates, generated before the prep preview / board validation. */
  _planBossWaves() {
    const r = this.round;
    const hidden = r === this.gd.hiddenRound && r !== this.gd.bossRound;
    const bossId = hidden ? this.hiddenBossId : this.bossId;
    // Pairing uses an independent seeded draw, consuming no shop, wave, draft or battle randomness. The Hidden Core
    // draws its pairs and sides anew (GitHub #845: the official R15 of BV1VCXyBjEN1 p1 pairs 1-2 / 3-4 after an R14 of
    // 1-4 / 2-3; DESIGN §37.27, superseding §32.12's kept partners) from a stream of its own, so the Final Assault's
    // draw is unchanged; a player who changes half keeps the board (bossFieldPlacement mirrors it, the halves' deploy
    // maps are identical). Only the round's first plan draws anew: a re-plan after a departure in its round start, 机变
    // draft or prep (platform.js _quit) keeps the intact pairs and re-pairs the orphan, as the Final Assault does.
    const fresh = hidden && this.bossPairsRound !== r;
    const groups = pairPlayers(this.alivePlayers(), createRng(deriveSeed(this.seed, bossPairSalt(this.gd, r))), fresh ? null : this.bossPairs);
    this.bossPairs = groups.map(g => g.map(p => p.playerId));
    this.bossPairsRound = r;
    this.bossWaves = groups.map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, r, { bossId, solo: this.isSolo || g.length === 1 }, this.stageId),
    }));
  }

  afterRoundStart() {
    if (this.gd.spRounds().includes(this.round)) this.enterSpDraft();
    else this.beforePrepOffers();
  }

  beforePrepOffers() {
    // The official round start and its draw/draft finish first; only entering prep waits.
    this.sp = null;
    const step = () => this.enterPrep();
    if (this.openOfferWindow('prep', this.round) !== 'open') { step(); return; }
    this._offerResume = step;
  }
}
