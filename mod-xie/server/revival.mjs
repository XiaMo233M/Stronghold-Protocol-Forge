// 促融共竞 v2.1 救援层：三人（全体存活队友）同意 + 共享池按人头扣 5/10/15…
//
// 业主 2026-10-12 口径：
//   · 复活需要**其余全体存活队友都同意**（4 人局 = 3 人）；
//   · 费用从**共享池**扣，**每人各 5**（pool 付 costPer × 同意人数）；第 2 次复活每人 10，依次叠加（+5）；
//   · bot 自动同意（延迟一小段，像在思考）；池子不够则复活不成立（窗口照旧关闭 → 真淘汰）。
//
// 与 v2 的差别只在「谁出钱、怎么算同意」：v2 是单人捐 LP（minDonorLp 门槛），这里改成全票 + 池子。

import { PHASE, ERR, FLOW_TICKER_PRIORITY, OK, fail, msg } from './common.mjs';

export const REVIVAL_COST_PER = 5;
export const REVIVAL_COST_STEP = 5;
export const REVIVAL_UNAVAILABLE_REASONS = Object.freeze([
  'left', 'already-used', 'disabled', 'match-ended', 'no-voter', 'pool', 'window-closed', 'window-expired',
]);

export class MatchRevival {
  /** Called from the Match constructor once the seed and GameData exist (like econInit). */
  revivalInit() {
    this.revivalRule = this.revivalRuleInit ?? null;   // { costPer, step } 由 mod.mjs 先派生
    this.revivalEnabled = !!this.revivalRule;
    this.revivalCostPer = this.revivalRule && Number.isInteger(this.revivalRule.costPer) ? this.revivalRule.costPer : REVIVAL_COST_PER;
    this.revivalStep = this.revivalRule && Number.isInteger(this.revivalRule.step) ? this.revivalRule.step : REVIVAL_COST_STEP;
    /** 已经成功复活过几次：费用 = costPer + step × 次数（5 / 10 / 15…，依次叠加）。 */
    this.reviveCount = 0;
    /** @type {{ round: number, windowOpen: boolean, consents: Map<string, Set<string>> } | null} */
    this.revival = null;
  }

  /** 本次复活**每人**要付多少（从共享池扣）。 */
  revivalCostFor() {
    return this.revivalCostPer + this.revivalStep * this.reviveCount;
  }

  /** Opened for the round a death was deferred in, and only while the settle phase (and the match) is still going. */
  revivalWindowOpen() {
    const state = this.revival;
    return !!(this.revivalEnabled && !this.ended && !this.disposed && this.phase === PHASE.SETTLE
      && this.teamLp == null && state && state.windowOpen && state.round === this.round);
  }

  /** 需要同意的人：除被救者以外的**全体存活席位**（bot 也算；由服务器代它们自动同意）。 */
  revivalVoters(target) {
    return this.order.filter((p) => p !== target && p.alive && !p.left && this.players.get(p.playerId) === p);
  }

  /** A downed player still in the window: LP spent, not yet eliminated, and not rescued before. */
  revivalTargetEligible(ps) {
    return !!(ps && !ps.left && !ps.alive && ps.pendingDeath && !ps.revived);
  }

  /** Why this downed player cannot be rescued right now (one of REVIVAL_UNAVAILABLE_REASONS). */
  revivalDeathReason(ps) {
    if (ps.left) return 'left';
    if (ps.revived) return 'already-used';
    if (!this.revivalEnabled) return 'disabled';
    if (this.teamLp != null || this.ended || this.disposed) return 'match-ended';
    if (!this.revivalVoters(ps).length) return 'no-voter';
    return 'window-closed';
  }

  /**
   * LP ran out while 救援 is on: hold the player at 0 instead of eliminating them, and open the window. The settle
   * loop calls this; `afterSettle` finalises whatever is still pending.
   */
  revivalDefer(ps) {
    ps.revivalUnavailableReason = null;
    ps.lp = 0;
    ps.alive = false;
    ps.pendingDeath = true;
    ps.dirty();
    this.toast(ps, 'warn', '你的目标生命值耗尽，等待救援（需要全体队友同意）');
    if (!this.revival) this.revival = { round: this.round, windowOpen: true, consents: new Map() };
    this.revival.round = this.round;
    this.revival.windowOpen = true;
    if (!this.revival.consents.has(ps.playerId)) this.revival.consents.set(ps.playerId, new Set());
    this._scheduleBotConsents(ps);
  }

  /** bot 席位像在思考：延迟一小段后自动同意（业主：「ai 自动同意」）。 */
  _scheduleBotConsents(target) {
    const rng = this.rngEcon || null;
    for (const bot of this.revivalVoters(target)) {
      if (!bot.isBot) continue;
      const delay = 500 + (rng ? rng.int(700) : 0);
      const targetId = target.playerId;
      this.later(delay, () => {
        if (!this.revivalWindowOpen()) return;
        if (this.players.get(bot.playerId) !== bot || !bot.alive) return;
        this.reviveConsent(bot, targetId, { byServer: true });
      });
    }
  }

  /**
   * Eliminate a held player for real (window closed, match over, or they left) — same path as a normal elimination:
   * the board goes back, the seat's economy closes and the death dividend is diced out.
   */
  eliminatePlayer(ps, { notify = true } = {}) {
    ps.lp = 0;
    ps.pendingDeath = false;
    // The instance-level hold in mod.mjs answers PlayerState.eliminate — including THIS call. `_modXieRealElim` tells
    // it this elimination is the real one, not the settle-time LP charge it holds for.
    this._modXieRealElim = true;
    try {
      ps.eliminate(this.round);
    } finally {
      this._modXieRealElim = false;
    }
    if (this.teamEcon) this.econCloseAllFor(ps.playerId, 'eliminated');
    this.econOnEliminated(ps, this.round);
    if (notify) {
      this.toast(ps, 'error', '你的目标生命值耗尽，已被淘汰');
      this.tickerText(msg('{name}博士的目标生命值已耗尽', { name: ps.name }), FLOW_TICKER_PRIORITY);
    }
  }

  /** Eliminate a held player for real (window closed, match over, or they left). */
  revivalFinalize(ps, { notify = true, reason = null } = {}) {
    if (ps.alive || !ps.pendingDeath) return false;
    const why = reason || this.revivalDeathReason(ps);
    if (ps.revivalUnavailableReason == null) {
      ps.revivalUnavailableReason = REVIVAL_UNAVAILABLE_REASONS.includes(why) ? why : 'window-closed';
    }
    ps.lp = 0;
    ps.pendingDeath = false;
    this.eliminatePlayer(ps, { notify });
    return true;
  }

  /** The window is over: everyone still pending is eliminated, with the reason recorded for the UI. */
  revivalFinalizeAll({ notify = true, reason = null } = {}) {
    if (this.revival) this.revival.windowOpen = false;
    const why = reason || (this.ended || this.disposed ? 'match-ended'
      : this.teamLp != null ? 'match-ended' : 'window-expired');
    let n = 0;
    for (const ps of this.order) if (ps.pendingDeath) n += this.revivalFinalize(ps, { notify, reason: why }) ? 1 : 0;
    if (n) this.markPublic();
    return n;
  }

  /**
   * 一个队友的同意（包通道 `revive`）。**全票到齐才结算**：钱在最后一张同意落地时一次性从共享池扣
   * （`costPer + step × 已复活次数` × 同意人数），在此之前不落账、也就不需要退款。
   */
  reviveConsent(ps, targetId, { byServer = false } = {}) {
    if (!this.revivalEnabled) return fail(ERR.WRONG_PHASE, 'revival-disabled');
    if (!this.revivalWindowOpen()) return fail(ERR.WRONG_PHASE, 'revival-window-closed');
    if (!ps || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (ps.isBot && !byServer) return fail(ERR.NOT_IN_ROOM);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    const target = this.players.get(targetId);
    if (!target || target === ps || !this.revivalTargetEligible(target)) return fail(ERR.BAD_TARGET, 'revival-target-ineligible');
    const voters = this.revivalVoters(target);
    if (!voters.some((v) => v.playerId === ps.playerId)) return fail(ERR.BAD_TARGET, 'revival-not-voter');
    const set = this.revival.consents.get(target.playerId) || new Set();
    if (set.has(ps.playerId)) return fail(ERR.ALREADY, 'revival-already-consented');
    const missing = voters.filter((v) => v.playerId !== ps.playerId && !set.has(v.playerId));
    if (missing.length) {
      set.add(ps.playerId);
      this.revival.consents.set(target.playerId, set);
      this.markPublic();
      this.markPrivate(ps);
      this.toast(ps, 'info', msg('已同意救援 {name}（还差 {n} 人）', { name: target.name, n: missing.length }));
      return OK;
    }
    // 最后一张同意：现在结算
    const per = this.revivalCostFor();
    const total = per * voters.length;
    const pool = Number.isFinite(this.teamReserve) ? this.teamReserve : 0;
    if (pool < total) return fail(ERR.NO_FUNDS, 'revival-pool-insufficient');
    this.teamReserve -= total;
    set.add(ps.playerId);
    this.revival.consents.set(target.playerId, set);
    this.reviveCount += 1;
    target.revived = true;
    target.alive = true;
    target.pendingDeath = false;
    target.revivalUnavailableReason = null;
    target.lp = 1;
    target.dirty();
    this.markPublic();
    for (const v of voters) this.markPrivate(v);
    this.toast(target, 'ok', msg('全体队友同意：你被救了回来（共享池支付 {total}）', { total }));
    this.tickerText(msg('{n} 人同意，救援了 {target}', { n: voters.length, target: target.name }), FLOW_TICKER_PRIORITY);
    return OK;
  }

  /** The 救援 block of the public view, or null while the mode has no 救援 or nothing is pending. */
  revivalView() {
    if (!this.revivalEnabled) return null;
    const state = this.revival;
    const targets = this.order.filter((ps) => ps.pendingDeath).map((ps) => {
      const voters = this.revivalVoters(ps);
      const agreed = state && state.consents.get(ps.playerId) ? [...state.consents.get(ps.playerId)] : [];
      return { playerId: ps.playerId, name: ps.name, need: voters.map((v) => v.playerId), agreed };
    });
    if (!state && !targets.length) return null;
    return {
      open: this.revivalWindowOpen(),
      round: state ? state.round : this.round,
      costPer: this.revivalCostFor(),
      costNext: this.revivalCostPer + this.revivalStep * (this.reviveCount + 1),
      revives: this.reviveCount,
      pool: Number.isFinite(this.teamReserve) ? this.teamReserve : 0,
      targets,
    };
  }
}
