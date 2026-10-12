// server/match/match/economy.js — Match methods: the co-op team economy (DESIGN §28) and the 协同共竞 borrow layer
// (§29) — the team reserve and its conversion, the 全员无伤 perfect reward, the logistics projects a mode ships, the
// 救济 draw on the reserve, the transfer requests (TTL, caps, the ready lock), the debt ledger the requests leave behind
// (方案 B: repaid out of the next income), the PvE 兜底 interest (holding teammates' leaked enemies) and the death
// dividend.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).
//
// Everything here is gated by `this.teamEcon` (GameData.teamEconomy, null unless the mode or config.economy.team turns
// the rule set on and the match is not solo), so the whole layer is inert — and every protocol addition optional —
// while it is off. State lives on the Match: `econRequests`, `econRound`, `econDebts`, `econCover*`, `teamReserve`,
// `teamProjects` (personal funds stay on PlayerState).

import { PHASE, ERR, OK, fail, msg, createRng, deriveSeed } from './common.mjs';
import { botEconRespond, botEconMaybeRequest } from './botEcon.mjs';

/** 后勤项目 level-up toasts, one msgid per project so the name travels with it (the client has its own labels). */
const PROJECT_UP = {
  procure: (lv) => msg('联合采购 已升至 Lv{lv}', { lv }),
  storehouse: (lv) => msg('应急仓储 已升至 Lv{lv}', { lv }),
  logistics: (lv) => msg('后勤调度 已升至 Lv{lv}', { lv }),
};

/** 借钱喊话（业主：「随机几句借钱的话」）。服务端从这张表里选一句挂在那条广播上。 */
export const ECON_PHRASES = Object.freeze([
  '谁借我一块钱，下回合就还！',
  '救急！差一块钱买不起牌了…',
  '兄弟们，支援一块，回头双倍奉还',
  '就差这一块钱！借我，我记着你的好',
  '谁行行好，借我一块翻本',
  '断粮了，借一块续命',
  '一块钱，救我一命',
  '有钱的捧个钱场，一块就行',
]);

export class MatchEconomy {
  /** The econ state (called from the Match constructor once the seed and GameData exist). */
  econInit() {
    // 包化（`mod.mjs`）：官方 mode 记录里没有 MOD 的规则块，`teamEcon` 由 `mod.mjs` 在调用本方法**之前**派生
    // （`rules.js` 的 `teamEconomyFor`）；没派生出来就整层不武装（null ⇒ 下面立即 return）。
    this.teamEcon = this.teamEcon ?? null;
    this.teamReserve = 0;
    /** @type {Map<string, { id: string, from: string, to: string, amount: number, round: number, deadline: number, timer: any }>} */
    this.econRequests = new Map();
    /** 进行中的升级提案（同一时刻至多一条）：{ id, project, level, cost, by, agree:Set, reject:Set } | null */
    this.projectVote = null;
    this.econRound = { round: 0, spent: 0, byPlayer: new Map(), perfectGranted: 0 };
    /** The ids this player has already been refused by this round (被拒后可换人再借, user decision 2026-10-08). */
    this.econDeniedBy = new Map();
    /**
     * 方案 B: what each borrower owes, paid out of the income of the next round — Map<borrowerId, { to, amount, round }[]>.
     * Funds still clear every round; only the debt rides on income. A borrower who is eliminated before paying voids
     * it, and the survivors dice out what they would have earned (deathDividend).
     */
    this.econDebts = new Map();
    /**
     * 兜底利息 (PvE): holding teammates' leaked enemies earns interest on a repaid loan. `econCover` counts the kills a
     * 联防 helper made, `econCoverTotal` is the match's planned enemy total, and the rate is
     * `min(capPct, floor(100 × kills / total))` percent — a rate the first nine rounds cannot fill, because they can
     * only spawn ~50% of the match's enemies at all (calibrated 2026-10-07: 125 of 251 in 标准).
     * 兜底分红 (user decision 2026-10-09): one repayment mints ONE interest pool that every teammate who has covered
     * shares in proportion to its own rate — the old rule paid it all to the lender. Interest is paid in whole funds;
     * the fraction that does not make one rides `econCoverCarry` to the next repayment.
     */
    this.econCover = new Map();
    /**
     * The sub-1 fraction of the interest pool that the last repayment(s) could not pay out in whole funds. It is one
     * number, not one per player: the pool is shared, so the remainder is shared too — the next repayment's pool adds
     * to it and the whole funds it crosses are handed out by largest remainder.
     */
    this.econCoverCarry = 0;
    /** Whole funds each teammate has collected as 兜底利息 this match, and the funds of the last repayment that paid. */
    this.econCoverEarned = new Map();
    this.econCoverLastBonus = new Map();
    /**
     * Σ of the principals repaid through a 兜底 dividend and Σ of the interest minted out of them. The pool is capped
     * at its principal, so the second can never pass the first — the difference is the accrual still waiting to be paid.
     */
    this.econCoverRepaid = 0;
    this.econCoverPaid = 0;
    this.econCoverTotal = 0;
    /**
     * The levels of the projects this mode ships (GameData.teamEconomy.projects): 协同共竞 lists 应急仓储 and 后勤调度
     * only, so 联合采购 has no entry here and `econBuyProject` cannot sell it (user decision 2026-10-09).
     */
    this.teamProjects = {};
    /**
     * 救济 (DESIGN §28, user decision 2026-10-09): how much the team has taken out of the reserve this round, and how
     * many times each player has taken. Both are re-armed by `econNewRound` — they are per round, like every other
     * economy counter.
     */
    this.econReliefSpent = 0;
    this.econReliefByPlayer = new Map();
    if (!this.teamEcon) return;
    for (const id of Object.keys(this.teamEcon.projects)) this.teamProjects[id] = 0;
    this.rngEcon = createRng(deriveSeed(this.seed, 'econ'));
    if (this.teamEcon.coverInterest.enabled) this.econCoverTotal = this._econCoverTotal();
  }

  // ---- gates and caps ------------------------------------------------------------------------------

  /** The econ gate: alive and in PREP; humans also obey the ready lock, a bot seat answers any time (it has no UI). */
  econGate(ps) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.isBot && ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    return null;
  }

  /**
   * The per-player request budget of this round (后勤调度 L3 raises it), capped by **what the borrower will earn next
   * round** (user decision 2026-10-08): every loan is repaid out of that income, so a budget above it could not be
   * repaid — the debt is solvent by construction, and `econSettleDebts` never has to forgive.
   *
   * 协同共竞 ships `requestsPerRound: 4` and the L3 bonus takes it to 5 — both at or under the match's income floor
   * (`income(round + 1)` ≥ 5 from round 1 in 标准), so the clamp never swallows the bonus. That is what makes
   * `extraRequestsAtL3` live: a config of 12 used to sit above every income the clamp allows, so L3 changed nothing.
   */
  econRequestsPerRound(ps = null) {
    if (!this.teamEcon) return 0;
    const extra = this.teamProjects.logistics >= 3 ? this.teamEcon.projects.logistics.extraRequestsAtL3 || 0 : 0;
    const base = this.teamEcon.transfer.requestsPerRound + extra;
    if (!ps) return base;
    return Math.max(0, Math.min(base, Math.trunc(this.gd.income(this.round + 1))));
  }

  /**
   * The round start re-arms the per-round counters: how many asks each player may still open, how much the team may
   * still move, and who has already said no (被拒后可换人再借, user decision 2026-10-08).
   */
  econNewRound() {
    if (!this.teamEcon) return;
    this.econRound.round = this.round;
    this.econRound.spent = 0;
    this.econRound.perfectGranted = 0;
    this.econRound.byPlayer.clear();
    this.econDeniedBy.clear();
    // 救济 is per round like everything else here: the team allowance and every player's count re-arm together
    this.econReliefSpent = 0;
    this.econReliefByPlayer.clear();
  }

  /** Funds the team may still move this round (the base cap + 后勤调度). */
  teamTransferCap() {
    if (!this.teamEcon) return 0;
    const lv = this.teamProjects.logistics;
    const bonus = lv > 0 ? this.teamEcon.projects.logistics.teamCapBonus[lv - 1] || 0 : 0;
    return this.teamEcon.transfer.teamCapPerRound + bonus;
  }

  /** Leftover funds a player keeps at the prep end (应急仓储). 坎诺特 bands keep everything and skip this reading. */
  teamKeepFor(ps) {
    void ps;
    return this.teamEcon ? this.teamProjects.storehouse : 0;
  }

  /** Free refreshes the round start grants (联合采购) — 0 when the mode does not ship that project. */
  teamFreeRefreshes() {
    return this.teamEcon ? (this.teamProjects.procure || 0) : 0;
  }

  // ---- views ---------------------------------------------------------------------------------------

  /** m.public.econ — the key exists only while the rule set is on (the client's capability probe). */
  /** m.public.econ：共享池读数 + 进行中的广播（谁在喊借钱）+ 升级提案 + 项目表（含 maxed）。 */
  econPublicView() {
    if (!this.teamEcon) return null;
    const base = {
      reserve: Number.isFinite(this.teamReserve) ? this.teamReserve : 0,
      transferLeft: Math.max(0, this.teamTransferCap() - this.econRound.spent),
      requests: [...this.econRequests.values()].map((req) => ({
        id: req.id, from: req.from, amount: req.amount, phrase: req.phrase || '', lent: req.lent.length,
      })),
      vote: this.projectVote
        ? { id: this.projectVote.id, project: this.projectVote.project, level: this.projectVote.level, cost: this.projectVote.cost, by: this.projectVote.by, agree: [...this.projectVote.agree], reject: [...this.projectVote.reject] }
        : null,
    };
    if (this.teamEcon.borrowOnly) return { ...base, borrowOnly: true, reserve: 0, projects: [], relief: null };
    const relief = this.teamEcon.relief;
    return {
      ...base,
      projects: Object.keys(this.teamProjects).map((id) => {
        const level = this.teamProjects[id];
        const costs = this.teamEcon.projects[id].costs;
        return { id, level, max: costs.length, cost: level < costs.length ? costs[level] : null, maxed: level >= costs.length };
      }),
      relief: relief.enabled
        ? { amount: relief.amount, threshold: relief.lpThreshold, left: Math.max(0, relief.teamPerRound - this.econReliefSpent) }
        : null,
    };
  }

  /** m.private.econ for one player (null while the rule set is off). */
  /** m.private.econ：我的钱 / 别人向我借 / 我发出的广播 / 项目与提案 —— 与面板逐键对应。 */
  econPrivateFor(ps) {
    if (!this.teamEcon) return null;
    const nameOf = (id) => { const p = this.players.get(id); return p ? p.name : String(id); };
    const alive = this.order.filter((p) => p.alive && !p.left && this.players.get(p.playerId) === p);
    const voters = alive.map((p) => p.playerId);
    const inbound = [];
    const mine = [];
    for (const req of this.econRequests.values()) {
      if (req.from === ps.playerId) mine.push(req);
      else if (Array.isArray(req.targets) && req.targets.includes(ps.playerId) && !req.answers.has(ps.playerId)) inbound.push(req);
    }
    const v = this.projectVote;
    const myVote = v && voters.includes(ps.playerId) && !v.agree.has(ps.playerId) && !v.reject.has(ps.playerId)
      ? { id: v.id, project: v.project, level: v.level, cost: v.cost, byName: nameOf(v.by), agree: [...v.agree].map(nameOf), need: voters.filter((id) => !v.agree.has(id)).map(nameOf) }
      : null;
    const cover = this.teamEcon.coverInterest.enabled;
    return {
      funds: ps.funds,
      requestIn: inbound.map((r) => ({ id: r.id, from: r.from, fromName: nameOf(r.from), amount: r.amount, phrase: r.phrase || '' })),
      myRequests: mine.map((r) => ({
        id: r.id, amount: r.amount, phrase: r.phrase || '',
        lent: r.lent.map(nameOf), answered: r.answers.size, targets: r.targets.length,
      })),
      requestLeft: Math.max(0, this.econRequestsPerRound(ps) - (this.econRound.byPlayer.get(ps.playerId) || 0)),
      refused: [...(this.econDeniedBy.get(ps.playerId) || [])].map(nameOf),
      keep: this.teamKeepFor(ps),
      maxPerRequest: this.teamEcon.transfer.maxPerRequest,
      owe: this.econDebtSummary(ps.playerId, 'from'),
      due: this.econDebtSummary(ps.playerId, 'to'),
      cover: cover
        ? {
          kills: this.econCover.get(ps.playerId) || 0,
          total: this.econCoverTotal,
          ratePct: this.econCoverRate(ps.playerId),
          capPct: this.teamEcon.coverInterest.capPct,
          pending: Math.round(this.econCoverPending(ps.playerId) * 100) / 100,
          earned: this.econCoverEarned.get(ps.playerId) || 0,
          lastBonus: this.econCoverLastBonus.get(ps.playerId) || 0,
          lag: this.econDebtsOwedTo(ps.playerId, { lagOnly: true }).total,
          lagPremium: this.teamEcon.coverInterest.lagPremium,
        }
        : null,
      relief: this.teamEcon.relief.enabled
        ? {
          eligible: this.econReliefEligible(ps),
          amount: this.teamEcon.relief.amount,
          threshold: this.teamEcon.relief.lpThreshold,
          left: Math.max(0, this.teamEcon.relief.perPlayerPerRound - (this.econReliefByPlayer.get(ps.playerId) || 0)),
        }
        : null,
      projects: this.teamEcon.borrowOnly ? [] : Object.keys(this.teamProjects).map((id) => {
        const level = this.teamProjects[id];
        const costs = this.teamEcon.projects[id].costs;
        return { id, level, max: costs.length, cost: level < costs.length ? costs[level] : null, maxed: level >= costs.length, affordable: level < costs.length && this.teamReserve >= costs[level] };
      }),
      vote: myVote,
      canPropose: !this.projectVote,
    };
  }

  /** What teammates owe one player (`econDebtSummary` with the option of counting only the 兜底率分红 debts). */
  econDebtsOwedTo(playerId, { lagOnly = false } = {}) {
    let total = 0;
    for (const list of this.econDebts.values()) {
      for (const d of list) if (d.to === playerId && (!lagOnly || d.lag)) total += d.amount;
    }
    return { total };
  }

  /** `{ total, next }` for one side of the debt ledger (`from`: what I owe, `to`: what I am owed), null when clean. */
  econDebtSummary(playerId, side) {
    let total = 0;
    for (const [borrower, list] of this.econDebts) {
      for (const d of list) {
        if (side === 'from' ? borrower === playerId : d.to === playerId) total += d.amount;
      }
    }
    if (total <= 0) return null;
    return { total, next: Math.max(0, Math.trunc(this.gd.income(this.round + 1))) };
  }

  // ---- willingness (DESIGN §28) -------------------------------------------------------------------

  /** Median board size and LP of the alive team — the "behind the team" yardstick (upper median on an even count). */
  _econMedians() {
    const alive = [...this.players.values()].filter((p) => p.alive && !p.left);
    const pick = (vals) => {
      const s = vals.sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : 0;
    };
    return { units: pick(alive.map((p) => Math.max(0, Math.trunc(p.deployCount) || 0))), lp: pick(alive.map((p) => Number(p.lp) || 0)) };
  }

  /**
   * How far behind the team's median board a player is: 0 (at or above it, or nobody has units yet) .. 1 (half the
   * median or less — an empty board is 1). Used twice: the bot's willingness roll and the 兜底率分红 snapshot on a
   * debt (`lag` is simply "> 0", i.e. strictly below the team's median).
   */
  econBorrowerBehind(playerId) {
    const ps = this.players.get(playerId);
    if (!ps) return 0;
    const { units } = this._econMedians();
    if (units <= 0) return 0;
    return Math.max(0, Math.min(1, (2 * (units - Math.max(0, Math.trunc(ps.deployCount) || 0))) / units));
  }

  /**
   * 借款意愿 (DESIGN §28, user decision 2026-10-08): the percent chance a bot lender approves a request —
   * `basePct + weakPct · weak + solventPct · solvent + coverPct · cover`, capped at `maxPct` (50).
   *   weak    the borrower's board trails the team's median (the under-developed teammate this mode carries);
   *   solvent the borrower looks able to repay what the income ledger will charge (units on the board and LP at or
   *           above the median — the debt itself is always affordable, so death is the only way to default);
   *   cover   the lender's own 兜底 rate: the teammate who holds the leaks is the one who pays it forward.
   * Pure — the roll (`rngEcon.int(100) < p`) belongs to the caller.
   */
  econBotLendChance(lender, borrowerId) {
    const bl = this.teamEcon && this.teamEcon.botLend;
    if (!bl || !bl.enabled) return 0;
    const borrower = this.players.get(borrowerId);
    if (!borrower) return 0;
    const { lp } = this._econMedians();
    const mine = Math.max(0, Math.trunc(borrower.deployCount) || 0);
    const weak = this.econBorrowerBehind(borrowerId);
    const solvent = mine > 0 && (Number(borrower.lp) || 0) >= lp ? 1 : 0;
    const cover = this.econCoverRate(lender.playerId) / 100;
    const p = bl.basePct + Math.round(bl.weakPct * weak) + Math.round(bl.solventPct * solvent) + Math.round(bl.coverPct * cover);
    return Math.max(0, Math.min(bl.maxPct, p));
  }

  // ---- intents -------------------------------------------------------------------------------------

  /** g.econ.request (DESIGN §28): ask one teammate for funds — PREP only, and neither player may be ready. */
  /**
   * 借钱（广播，业主 2026-10-12：「借钱按钮改为默认广播到另外三个人」）：
   * 一次问遍其余存活队友；**每人各自可借 1 资金**，一人同意**不**关闭其他人的应答
   * （「其余的不自动关闭」）——全员应答、或 TTL 到期才关单。额度仍是每人每回合 4 次、单次 1。
   */
  econRequest(ps, to, amount) {
    void to; // 兼容旧签名：现在的语义永远是广播
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    const g = this.econGate(ps);
    if (g) return g;
    if (!Number.isInteger(amount) || amount < 1 || amount > this.teamEcon.transfer.maxPerRequest) return fail(ERR.BAD_TARGET, 'amount');
    for (const req of this.econRequests.values()) if (req.from === ps.playerId) return fail(ERR.ALREADY, 'pending');
    if ((this.econRound.byPlayer.get(ps.playerId) || 0) >= this.econRequestsPerRound(ps)) return fail(ERR.ALREADY, 'budget');
    if (this.econRound.spent + amount > this.teamTransferCap()) return fail(ERR.BAD_TARGET, 'team cap');
    const denied = this.econDeniedBy.get(ps.playerId) || new Set();
    const targets = this.order.filter((p) => p !== ps && p.alive && !p.left && !denied.has(p.playerId) && (p.isBot || !p.ready));
    if (!targets.length) return fail(ERR.BAD_TARGET, 'no target');
    const ttl = this.teamEcon.transfer.ttlSec * 1000;
    const req = {
      id: `req:${this.nextUid()}`, from: ps.playerId, amount, round: this.round,
      deadline: this.sched.now() + ttl, timer: null,
      targets: targets.map((p) => p.playerId), answers: new Map(), lent: [],
      phrase: ECON_PHRASES[this.rngEcon ? this.rngEcon.int(ECON_PHRASES.length) : 0],
      decideAtBy: new Map(),
    };
    req.timer = this.later(ttl, () => { if (this.econRequests.get(req.id) === req) this.econCloseRequest(req, 'expired'); });
    this.econRequests.set(req.id, req);
    this.econRound.byPlayer.set(ps.playerId, (this.econRound.byPlayer.get(ps.playerId) || 0) + 1);
    const bl = this.teamEcon.botLend;
    for (const t of targets) {
      this.markPrivate(t);
      if (!t.isBot) continue;
      const delay = bl && bl.enabled && bl.delayMsMax > 0 ? bl.delayMsMin + this.rngEcon.int(bl.delayMsMax - bl.delayMsMin + 1) : 0;
      if (delay > 0) req.decideAtBy.set(t.playerId, this.sched.now() + delay);
      this.later(delay, () => { if (this.econRequests.get(req.id) === req) botEconRespond(this, t, req.id); });
    }
    this.markPrivate(ps);
    this.markPublic();
    return OK;
  }

  /**
   * The MOD's half of the intent dispatcher: `g.econ.*` (the fork had these cases in match/intents.js, a file the MOD
   * must not edit — so boot.mjs' `handle` wrapper answers them here instead). Every branch delegates to the same
   * entry point a human's intent used in the fork; nothing is answered twice and nothing bypasses the state checks.
   */
  /** 包通道 → 经济入口（mod.mjs 的 handlePackMsg 调这里；v1 的 g.econ.* 名字一并兼容）。 */
  econIntent(ps, msg) {
    const t = msg && msg.t;
    switch (t) {
      case 'g.econ.request': case 'econ.borrow': return this.econRequest(ps, null, msg.amount);
      case 'g.econ.respond': case 'econ.answer': return this.econRespond(ps, msg.id, msg.approve);
      case 'g.econ.project': case 'econ.project': return this.econBuyProject(ps, msg.project);
      case 'econ.vote': return this.econVote(ps, msg.id, msg.approve);
      case 'g.econ.relief': case 'econ.relief': return this.econRelief(ps);
      default: return fail(ERR.BAD_MSG);
    }
  }

  /** g.econ.respond: approve (move the funds) or deny one incoming request — consumed exactly once, by id. */
  /**
   * 应答一条广播请求。同意 = 从自己资金借出 1（一条广播可由多人各借 1）；拒绝只记名，**不关单**。
   * 全员应答后关单：一条都没借到则退回这次请求的额度（保留「被拒不算花额度」的旧口径）。
   */
  econRespond(ps, id, approve) {
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    const req = typeof id === 'string' ? this.econRequests.get(id) : null;
    if (!req || req.round !== this.round || !Array.isArray(req.targets) || !req.targets.includes(ps.playerId)) return fail(ERR.BAD_TARGET);
    if (req.answers.has(ps.playerId)) return fail(ERR.ALREADY, 'answered');
    const g = this.econGate(ps);
    if (g) return g;
    const sender = this.players.get(req.from);
    if (!sender || !sender.alive || sender.left) {
      this.econCloseRequest(req, 'gone');
      return fail(ERR.BAD_TARGET, 'target');
    }
    req.answers.set(ps.playerId, approve ? 'yes' : 'no');
    if (!approve) {
      let denied = this.econDeniedBy.get(req.from);
      if (!denied) this.econDeniedBy.set(req.from, (denied = new Set()));
      denied.add(ps.playerId);
      this.toast(sender, 'warn', msg('{name} 拒绝了你的支援请求', { name: ps.name }));
      this.markPrivate(ps);
      this.markPrivate(sender);
      this._econMaybeCloseRequest(req);
      return OK;
    }
    if (this.econRound.spent + req.amount > this.teamTransferCap()) return fail(ERR.BAD_TARGET, 'team cap');
    if (ps.funds < req.amount) return fail(ERR.NO_FUNDS);
    ps.funds -= req.amount;
    sender.addFunds(req.amount, { reason: 'transfer' });
    this.econRound.spent += req.amount;
    req.lent.push(ps.playerId);
    const interest = this.teamEcon.transfer.repayInterest;
    if (interest > 0 || this.teamEcon.coverInterest.enabled) {
      const list = this.econDebts.get(sender.playerId) || [];
      list.push({ to: ps.playerId, amount: req.amount + interest, round: this.round, lag: this.econBorrowerBehind(sender.playerId) > 0 });
      this.econDebts.set(sender.playerId, list);
    }
    if (interest > 0) {
      this.toast(ps, 'info', msg('已向 {name} 提供 {amount} 资金（下回合归还 {total}）', { name: sender.name, amount: req.amount, total: req.amount + interest }));
      this.toast(sender, 'info', msg('{name} 提供了 {amount} 资金（下回合归还 {total}）', { name: ps.name, amount: req.amount, total: req.amount + interest }));
    } else {
      this.toast(ps, 'info', msg('已向 {name} 提供 {amount} 资金（下回合归还）', { name: sender.name, amount: req.amount }));
      this.toast(sender, 'info', msg('{name} 提供了 {amount} 资金（下回合归还）', { name: ps.name, amount: req.amount }));
    }
    ps.dirty();
    sender.dirty();
    this.markPrivate(ps);
    this.markPrivate(sender);
    this.markPublic();
    this._econMaybeCloseRequest(req);
    return OK;
  }

  /** 全员应答后关单；一个都没借到则退回额度。 */
  _econMaybeCloseRequest(req) {
    if (!req || !Array.isArray(req.targets)) return;
    if (req.answers.size < req.targets.length) return;
    if (!req.lent.length) this._econRefundAsk(req);
    this.econCloseRequest(req, req.lent.length ? 'settled' : 'refused');
    this.markPublic();
  }

  /**
   * 后勤项目升级（业主 2026-10-12：「满级 4 级；一个人点击后需要其他队友同意才能升级；ai 自动同意」）。
   * 点击 = 发起提案（不再直接扣款）；全体存活队友同意后从共享池扣款并升级。只剩自己时（无人可同意）直接升级。
   */
  econBuyProject(ps, project) {
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    if (this.teamEcon.borrowOnly) return fail(ERR.WRONG_PHASE, 'projects disabled');
    const g = this.econGate(ps);
    if (g) return g;
    if (!Object.hasOwn(this.teamProjects, project)) return fail(ERR.BAD_TARGET, 'project');
    const def = this.teamEcon.projects[project];
    const level = this.teamProjects[project];
    if (level >= def.costs.length) return fail(ERR.MAX_LEVEL);
    const cost = def.costs[level];
    if (this.teamReserve < cost) return fail(ERR.NO_FUNDS, 'reserve');
    if (this.projectVote) return fail(ERR.ALREADY, 'vote in progress');
    const voters = this.order.filter((p) => p.alive && !p.left && this.players.get(p.playerId) === p);
    if (voters.length < 2) {
      this.teamReserve -= cost;
      this.teamProjects[project] = level + 1;
      this.markPublic();
      this.toast(ps, 'info', msg(PROJECT_UP[project], { lv: level + 1 }));
      return OK;
    }
    this.projectVote = { id: `vote:${this.nextUid()}`, project, level, cost, by: ps.playerId, agree: new Set([ps.playerId]), reject: new Set() };
    for (const v of voters) {
      this.markPrivate(v);
      if (v.isBot && v.playerId !== ps.playerId) this._scheduleBotVote(v);
    }
    this.markPublic();
    this.toast(ps, 'info', msg('已发起升级提案，等队友同意：{project}', { project }));
    return OK;
  }

  /** 队友对升级提案表态：全票同意才升级；任一人拒绝即作废。 */
  econVote(ps, id, approve) {
    if (!this.teamEcon) return fail(ERR.WRONG_PHASE, 'team economy disabled');
    const v = this.projectVote;
    if (!v || (typeof id === 'string' && id !== v.id)) return fail(ERR.BAD_TARGET, 'no vote');
    const g = this.econGate(ps);
    if (g) return g;
    const voters = this.order.filter((p) => p.alive && !p.left && this.players.get(p.playerId) === p);
    if (!voters.some((p) => p.playerId === ps.playerId)) return fail(ERR.BAD_TARGET, 'not a voter');
    if (v.agree.has(ps.playerId) || v.reject.has(ps.playerId)) return fail(ERR.ALREADY, 'voted');
    if (!approve) {
      v.reject.add(ps.playerId);
      this.projectVote = null;
      const by = this.players.get(v.by);
      if (by) this.toast(by, 'warn', msg('{name} 拒绝了升级提案', { name: ps.name }));
      for (const p of voters) this.markPrivate(p);
      this.markPublic();
      return OK;
    }
    v.agree.add(ps.playerId);
    if (voters.every((p) => v.agree.has(p.playerId))) {
      const def = this.teamEcon.projects[v.project];
      if (this.teamProjects[v.project] !== v.level || v.level >= def.costs.length) { this.projectVote = null; return fail(ERR.ALREADY, 'stale'); }
      if (this.teamReserve < v.cost) { this.projectVote = null; return fail(ERR.NO_FUNDS, 'reserve'); }
      this.teamReserve -= v.cost;
      this.teamProjects[v.project] = v.level + 1;
      this.projectVote = null;
      const by = this.players.get(v.by);
      if (by) this.toast(by, 'info', msg(PROJECT_UP[v.project], { lv: v.level + 1 }));
    }
    for (const p of voters) this.markPrivate(p);
    this.markPublic();
    return OK;
  }

  /** bot 席位的自动同意（业主：「ai 自动同意」），延迟一小段像在思考。 */
  _scheduleBotVote(bot) {
    const delay = 400 + (this.rngEcon ? this.rngEcon.int(600) : 0);
    this.later(delay, () => {
      const v = this.projectVote;
      if (!v || !bot.alive || bot.left) return;
      this.econVote(bot, v.id, true);
    });
  }

  /**
   * 救济 (DESIGN §28, user decision 2026-10-09): whether this player may draw on the team reserve right now — alive,
   * in PREP, not ready, at or below `relief.lpThreshold` and (tied for) the team's lowest LP, with its own round
   * allowance left. A healthy team has nobody eligible: this is a lifeline for the player about to be eliminated, not
   * an income. Shared by the private view and the intent, so what the client shows and what the server accepts agree.
   * @param {any} ps
   * @returns {boolean}
   */
  econReliefEligible(ps) {
    const rl = this.teamEcon && this.teamEcon.relief;
    if (!rl || !rl.enabled || !ps || !ps.alive || ps.left) return false;
    if (this.phase !== PHASE.PREP || (!ps.isBot && ps.ready)) return false;
    if ((this.econReliefByPlayer.get(ps.playerId) || 0) >= rl.perPlayerPerRound) return false;
    const lp = Number(ps.lp) || 0;
    if (lp > rl.lpThreshold) return false;
    // the weakest: nobody alive sits strictly below this player (a tie lets both take)
    for (const p of this.players.values()) {
      if (!p.alive || p.left || p === ps) continue;
      if ((Number(p.lp) || 0) < lp) return false;
    }
    return true;
  }

  /**
   * g.econ.relief (DESIGN §28, user decision 2026-10-09): the weakest player takes funds straight out of the team
   * reserve — itself, not on anyone's behalf (「血最少的人自己选择取还是不取」), `relief.amount` at a time (「每次取1」).
   * Caps: `relief.perPlayerPerRound` per player and `relief.teamPerRound` for the team, both re-armed every round. It
   * is a grant, not a loan: nothing is owed back (the debt ledger belongs to the borrow protocol).
   */
  econRelief(ps) {
    const rl = this.teamEcon && this.teamEcon.relief;
    if (!rl || !rl.enabled) return fail(ERR.WRONG_PHASE, 'relief disabled');
    const g = this.econGate(ps);
    if (g) return g;
    if ((this.econReliefByPlayer.get(ps.playerId) || 0) >= rl.perPlayerPerRound) return fail(ERR.ALREADY, 'relief budget');
    if (!this.econReliefEligible(ps)) return fail(ERR.BAD_TARGET, 'not the weakest');
    if (this.econReliefSpent + rl.amount > rl.teamPerRound) return fail(ERR.ALREADY, 'team relief cap');
    if (this.teamReserve < rl.amount) return fail(ERR.NO_FUNDS, 'reserve');
    this.teamReserve -= rl.amount;
    this.econReliefSpent += rl.amount;
    this.econReliefByPlayer.set(ps.playerId, (this.econReliefByPlayer.get(ps.playerId) || 0) + 1);
    ps.addFunds(rl.amount, { reason: 'relief' });
    ps.dirty();
    this.toast(ps, 'info', msg('从协同资金领取了 {n} 资金', { n: rl.amount }));
    this.markPublic();
    this.markPrivate(ps);
    return OK;
  }

  // ---- closing -------------------------------------------------------------------------------------

  /**
   * A refusal that never reached the asker — its TTL ran out — also gives the budget back, the same way an explicit
   * 拒绝 does: the asker did not get the funds, so it may still turn to another teammate this round.
   */
  _econRefundAsk(req) {
    const used = this.econRound.byPlayer.get(req.from) || 0;
    if (used > 0) this.econRound.byPlayer.set(req.from, used - 1);
    let denied = this.econDeniedBy.get(req.from);
    if (!denied) this.econDeniedBy.set(req.from, (denied = new Set()));
    denied.add(req.to);
  }

  /** Close one request (its TTL, a deny/approve, the prep end, a leave, an elimination) — idempotent by identity. */
  econCloseRequest(req, reason) {
    if (!req) return;
    this.cancel(req.timer);
    req.timer = null;
    if (this.econRequests.get(req.id) !== req) return;
    this.econRequests.delete(req.id);
    const from = this.players.get(req.from);
    const to = this.players.get(req.to);
    if (from) this.markPrivate(from);
    if (to) this.markPrivate(to);
    if (reason === 'expired') {
      // nobody ever said yes: the budget comes back and the asker may still try another teammate this round
      this._econRefundAsk(req);
      if (from && from.alive && !from.isBot) this.toast(from, 'warn', '支援请求已超时');
    } else if (reason === 'prep-end' && from && from.alive && !from.isBot) {
      this.toast(from, 'warn', '休整期结束，支援请求已取消');
    }
  }

  /** Every pending request of one player (a leave, an elimination). */
  econCloseAllFor(playerId, reason) {
    for (const req of [...this.econRequests.values()]) if (req.from === playerId || req.to === playerId) this.econCloseRequest(req, reason);
  }

  /** The outgoing requests of one player (it readied up). */
  econCloseAllFrom(playerId, reason) {
    for (const req of [...this.econRequests.values()]) if (req.from === playerId) this.econCloseRequest(req, reason);
  }

  /** Every pending request (the prep end). */
  econCloseAll(reason) {
    for (const req of [...this.econRequests.values()]) this.econCloseRequest(req, reason);
  }

  // ---- prep end, debts and the two PvE rewards -----------------------------------------------------

  /** Prep end: leftover funds convert into the team reserve, capped (design §28). 坎诺特 bands keep everything. */
  econConvertLeftover(ps) {
    if (!this.teamEcon || this.teamEcon.borrowOnly) return;
    if (this.gd.leftoverKeptBands.includes(ps.bandId)) return;
    const conv = Math.min(Math.max(0, ps.funds - this.teamKeepFor(ps)), this.teamEcon.reserve.convertPerPlayerMax);
    if (conv <= 0) return;
    ps.funds -= conv;
    this.teamReserve += conv;
    ps.dirty();
    this.markPublic();
  }

  /**
   * 全员无伤 pays into the team reserve, capped per round (DESIGN §28, user decision 2026-10-09). settle.js calls this
   * once per settlement, and only when every alive player was charged nothing that round; it grants `perfectReward`
   * funds at a time, at most `perfectRewardCapPerRound` per round.
   */
  econPerfectReward() {
    if (!this.teamEcon || this.teamEcon.borrowOnly) return;
    const left = this.teamEcon.reserve.perfectRewardCapPerRound - this.econRound.perfectGranted;
    if (left <= 0) return;
    const n = Math.min(this.teamEcon.reserve.perfectReward, left);
    if (n <= 0) return;
    this.teamReserve += n;
    this.econRound.perfectGranted += n;
    this.markPublic();
  }

  /**
   * 方案 B (user decision 2026-10-07): every borrower pays what it owes out of the income it was just granted
   * (`PlayerState.startRound`), so the debt never touches the round-clearing funds rule. The round's budget is capped
   * by that very income, so a debt is always payable; whatever still cannot be paid is forgiven rather than rolled over.
   */
  econSettleDebts(alive) {
    if (!this.teamEcon || !this.econDebts.size) return;
    for (const ps of alive) {
      const list = this.econDebts.get(ps.playerId);
      if (!list || !list.length) continue;
      this.econDebts.delete(ps.playerId);
      let paid = 0;
      let due = 0;
      for (const d of list) {
        due += d.amount;
        const creditor = this.players.get(d.to);
        const pay = Math.max(0, Math.min(d.amount, ps.funds - paid));
        if (pay <= 0) continue;
        paid += pay;
        // a creditor who is gone takes nothing: the funds are not created anywhere else either
        if (creditor && creditor.alive && !creditor.left) {
          creditor.addFunds(pay, { reason: 'repay' });
          creditor.dirty();
          this.toast(creditor, 'info', msg('{name} 归还了 {pay} 资金', { name: ps.name, pay }));
        }
        // 兜底分红 (user decision 2026-10-09): the interest of a repayment is ONE pool, minted here and split between
        // every teammate who has covered — the borrower itself is never one of them (it is the one being helped), and
        // a helper that is gone takes nothing. The pool is capped at the principal, so a loan still never pays back
        // more than double however many teammates covered it.
        const ci = this.teamEcon.coverInterest;
        const lag = ci && d.lag ? ci.lagPremium : 1;
        for (const row of this.econCoverSplit(pay, lag, ps.playerId)) {
          if (row.bonus <= 0) continue;
          row.ps.addFunds(row.bonus, { reason: 'cover' });
          row.ps.dirty();
          this.toast(row.ps, 'info', msg('兜底利息 +{bonus}（覆盖率 {rate}%）', { bonus: row.bonus, rate: row.rate }));
        }
      }
      if (paid <= 0) continue;
      ps.funds -= paid;
      ps.dirty();
      this.toast(ps, 'warn', due > paid
        ? msg('归还借款 {paid} 资金（差额已免除）', { paid })
        : msg('归还借款 {paid} 资金', { paid }));
    }
  }

  /** The match's planned enemy total (every round's wave, boss rounds included), built on a scratch rng. */
  _econCoverTotal() {
    // 包化第一版：兜底利息的**分红**需要「这一局计划出多少敌人」这个引擎读数（v1 从这里 import 引擎的
    // `buildNormalWave` / `buildBossWave` 重算一遍），而工坊包不能 import 引擎内部。返回 0 ⇒
    // `econCoverRate` 的 `econCoverTotal <= 0` 守卫让利率恒为 0 ⇒ 分红永不发放。
    // **账本不受影响**：`econRespond` 那条「下回合收入里还本金」的判据是 `interest > 0 || coverInterest.enabled`，
    // 而 `data/rules.mjs` 保持 `coverInterest.enabled: true`（v1 原值）—— 所以还款照旧，只是分红暂缺。
    // 要恢复分红：先在设计稿里有一格「这一局计划出多少敌人」的表面（PENDING，见 README §完成度）。
    return 0;
  }

  /**
   * 兜底利息: how many of a teammate's leaked enemies this player's board held (the kills a 联防 field attributed to
   * it — the field's players are the helpers), and the integer percent that buys on a repaid loan.
   */
  econCoverTally(res, helpers) {
    if (!this.teamEcon || !this.teamEcon.coverInterest.enabled) return;
    for (const pid of helpers) {
      const k = Number(res && res.perPlayer && res.perPlayer[pid] && res.perPlayer[pid].killed) || 0;
      if (k > 0) {
        this.econCover.set(pid, (this.econCover.get(pid) || 0) + Math.trunc(k));
        // the rate lives in m.private.econ.cover — without this the chip only refreshed at the next event that
        // dirtied the seat (user report 2026-10-08: 兜底率没有变化)
        const ps = this.players.get(pid);
        if (ps) this.markPrivate(ps);
      }
    }
  }

  /** `min(capPct, floor(100 × 兜底 kills / the match's enemy total))` — an integer percent, 0 when the rule is off. */
  econCoverRate(playerId) {
    const ci = this.teamEcon && this.teamEcon.coverInterest;
    if (!ci || !ci.enabled || this.econCoverTotal <= 0) return 0;
    const kills = this.econCover.get(playerId) || 0;
    return Math.max(0, Math.min(ci.capPct, Math.floor((100 * kills) / this.econCoverTotal)));
  }

  /**
   * The teammates who draw on a repayment's 兜底利息: a cover rate above zero, alive and still in the match — and never
   * the borrower itself (audit P1-4, user decision 2026-10-09: covering for others is what pays, and the one repaying
   * is the one being helped, not a helper). A rate above zero already means "has a 兜底 record" (the rate floors to 0
   * without kills), so this is the whole payee rule.
   */
  econCoverPayees(borrowerId = null) {
    const ci = this.teamEcon && this.teamEcon.coverInterest;
    const out = [];
    if (!ci || !ci.enabled) return out;
    for (const ps of this.players.values()) {
      if (ps.playerId === borrowerId || !ps.alive || ps.left) continue;
      const rate = this.econCoverRate(ps.playerId);
      if (rate > 0) out.push({ ps, rate });
    }
    return out;
  }

  /**
   * 兜底分红 (user decision 2026-10-09): one repaid principal mints ONE interest pool — the payees' own credits
   * (`本金 × 覆盖率 × 溢价`) summed — and every payee takes a share of it in proportion to its own rate. The pool is
   * capped at that principal, a **per-loan** cap (not per-lender): two 100% helpers split one fund of interest instead
   * of minting two, so "借 1 永远不会收回 2" holds however many teammates covered (user decision 2026-10-07, audit
   * P0-1). Interest is paid in whole funds: the funds available this repayment are `floor(池 + 结转)`, handed out by
   * largest remainder (阵亡分红's convention — 余数给覆盖率最高的), and the sub-1 fraction rides `econCoverCarry` to
   * the next repayment, so no fraction is ever lost. Returns `{ ps, rate, share, bonus }` per payee — `share` is this
   * repayment's fractional credit, `bonus` the whole funds it was paid. The caller adds them.
   */
  econCoverSplit(principal, mult = 1, borrowerId = null) {
    const ci = this.teamEcon && this.teamEcon.coverInterest;
    if (!ci || !ci.enabled || !(principal > 0)) return [];
    const payees = this.econCoverPayees(borrowerId);
    if (!payees.length) return [];
    const sumRate = payees.reduce((n, p) => n + p.rate, 0);
    const m = Math.max(1, mult);
    let raw = 0;
    for (const p of payees) raw += (principal * p.rate * m) / 100;
    const pool = Math.min(principal, raw);
    const rows = payees.map((p) => ({ ps: p.ps, rate: p.rate, share: (pool * p.rate) / sumRate, bonus: 0 }));
    this.econCoverRepaid += principal;
    // whole funds only: the pool's carry joins this repayment's pool, everything under one fund stays for the next one
    const carried = this.econCoverCarry + pool;
    const whole = Math.floor(carried);
    this.econCoverCarry = Math.max(0, carried - whole);
    if (whole > 0) {
      // largest remainder: everybody takes its floor share of the whole funds, the leftovers go to the largest
      // fractions (ties → the higher rate, then whoever has earned least, then the lower seat: deterministic, and an
      // even split alternates instead of always paying the same teammate)
      const earned = (row) => this.econCoverEarned.get(row.ps.playerId) || 0;
      const order = rows.map((row, i) => ({ i, frac: ((whole * row.share) / pool) % 1 }))
        .sort((a, b) => (b.frac - a.frac) || (rows[b.i].rate - rows[a.i].rate) || (earned(rows[a.i]) - earned(rows[b.i])) || (a.i - b.i));
      for (const row of rows) row.bonus = Math.floor((whole * row.share) / pool);
      let left = whole - rows.reduce((n, row) => n + row.bonus, 0);
      for (let k = 0; left > 0; k++) { rows[order[k].i].bonus += 1; left -= 1; }
    }
    for (const row of rows) {
      this.econCoverLastBonus.set(row.ps.playerId, row.bonus);
      if (row.bonus <= 0) continue;
      this.econCoverPaid += row.bonus;
      this.econCoverEarned.set(row.ps.playerId, (this.econCoverEarned.get(row.ps.playerId) || 0) + row.bonus);
    }
    return rows;
  }

  /** One payee's slice of the pool fraction that has not crossed a whole fund yet — what its next repayments pay first. */
  econCoverPending(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || !ps.alive || ps.left || this.econCoverCarry <= 0) return 0;
    const rate = this.econCoverRate(playerId);
    if (rate <= 0) return 0;
    const payees = this.econCoverPayees(null);
    const sum = payees.reduce((n, p) => n + p.rate, 0);
    return sum > 0 ? (this.econCoverCarry * rate) / sum : 0;
  }

  /**
   * A teammate is out. Its outstanding debts are void (the lender gets a warning), and — when the mode turns the rule
   * on (`teamEconomy.deathDividend`) — the income it would have earned next round is diced out to the survivors: every
   * survivor rolls 1..dice, the shares follow the rolls, the remainder goes to the highest roll and the total never
   * exceeds that income (user decision 2026-10-07).
   */
  econOnEliminated(ps, round) {
    if (!this.teamEcon) return;
    const owed = this.econDebts.get(ps.playerId);
    if (owed && owed.length) {
      this.econDebts.delete(ps.playerId);
      for (const d of owed) {
        const creditor = this.players.get(d.to);
        if (creditor && creditor.alive && !creditor.left) this.toast(creditor, 'warn', msg('{name} 已阵亡：{amount} 借款无法归还', { name: ps.name, amount: d.amount }));
      }
    }
    const dd = this.teamEcon.deathDividend;
    if (!dd || !dd.enabled) return;
    const pool = Math.max(0, Math.trunc(this.gd.income(round + 1)) + Math.max(0, Math.trunc(ps.pendingFunds) || 0));
    const survivors = [...this.players.values()].filter((p) => p !== ps && p.alive && !p.left);
    if (pool <= 0 || !survivors.length) return;
    const rolls = survivors.map(() => this.rngEcon.int(dd.dice) + 1);
    const totalRoll = rolls.reduce((n, r) => n + r, 0) || 1;
    const shares = survivors.map((p, i) => ({ p, roll: rolls[i], share: Math.floor((pool * rolls[i]) / totalRoll) }));
    const given = shares.reduce((n, s) => n + s.share, 0);
    if (pool - given > 0) {
      let best = 0;
      for (let i = 1; i < shares.length; i++) if (shares[i].roll > shares[best].roll) best = i;
      shares[best].share += pool - given;
    }
    for (const s of shares) {
      if (s.share <= 0) continue;
      s.p.addFunds(s.share, { reason: 'dividend' });
      s.p.dirty();
      this.toast(s.p, 'info', msg('{name} 已阵亡：随机分得 {share} 资金（骰 {roll}）', { name: ps.name, share: s.share, roll: s.roll }));
    }
    this.tickerText(msg('{name}博士的资金由队友随机继承', { name: ps.name }), 0);
  }
}
