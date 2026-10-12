// server/botEcon.js — the 协同经济 bot policy, owned by the MOD.
//
// The rule set is the MOD's, so upstream's bot.js cannot know anything about it: in the fork these two functions were
// imported from `server/match/bot.js`, which pristine upstream does not export (and which must never be edited). They
// live here instead, self-contained — the only upstream symbols they use are the ones every 0.2.x tree has
// (`ps.shop`, `ps.priceOf`, `ps.funds`, `gd.isGolden`, `gd.leftoverKeptBands`, `m.sched.now`, `m.order`).
//
// Both policies go through the same Match.econ* entry points a human's intents use (no backdoor), and both are inert
// until `this.teamEcon` exists.
//
// Wiring (boot.mjs): upstream's bot prep generator calls no economy hook, so the MOD hangs its policy on the two seams
// a bot seat's prep passes through anyway:
//   Match.prototype.scheduleBotPrep  — the prep starts: answer anything pending, then maybe ask for help
//   PlayerState.prototype.setReady   — the prep is over (a bot readies only once it is done spending): ask again
// Each is one wrapper, so an upstream that keeps those two methods keeps the policy working; `matchBotEconWiring`
// reports which ones landed.

import { PHASE } from './common.mjs';

/** 兜底分红 / 借款 request marks live on the player state; both are per round, so a seat never rolls a branch twice. */
const MARK_KEY = '_econKeyRolled';
const MARK_ASK = '_econAskRolled';

/**
 * Funds a band that keeps its leftover (gd.leftoverKeptBands: 坎诺特 利滚利 "每回合剩余的资金可以继承，剩余至少5资金时，
 * 每回合额外获得1资金") holds back from discretionary spending — the interest capital (coin_carry_over bb.capital, 5).
 * 0 for every other band (their leftover is lost at the prep end, so spending it all is free value).
 */
export function fundsReserve(m, ps) {
  const gd = ps?.gd || m.gd;
  if (!gd || !Array.isArray(gd.leftoverKeptBands) || !gd.leftoverKeptBands.includes(ps.bandId)) return 0;
  const band = gd.band(ps.bandId);
  const buff = band && Array.isArray(band.buffs) ? band.buffs.find((b) => b && b.key === 'coin_carry_over') : null;
  const cap = Number(buff && buff.bb && buff.bb.capital);
  return Number.isFinite(cap) && cap > 0 ? cap : 5;
}

/** The cheapest thing the bot could still buy right now (0 when nothing in the shop fits its funds). */
export function cheapestAffordable(ps) {
  let best = 0;
  for (const s of ps.shop.slots) {
    if (!s || s.sold) continue;
    const price = ps.priceOf(s);
    if (!Number.isFinite(price) || price > ps.funds) continue;
    if (!best || price < best) best = price;
  }
  return best;
}

/**
 * The 关键节点 the asking side cares about: an elite chess in the shop it cannot buy — a golden piece, or the copy that
 * completes a merge — or a 调度中心 level-up it is about to be able to afford. Returns how many funds the bot is short
 * of the cheapest such moment (0 = no key moment right now).
 *
 * The fork read its level-up condition from bot.js' internal `wantsLevelUp` (not exported); the MOD uses the same
 * intent expressed with public state: the shop has levels left and the bot's board is already as full as it can get
 * (so the next level is the only progress left), and it cannot pay for it now.
 */
export function botEconKeyMoment(m, ps) {
  const gd = ps?.gd || m.gd;
  let gap = 0;
  if (ps.shop.level < gd.maxShopLevel) {
    const boardReady = ps.allChess().length >= ps.deployCap;
    const price = Math.max(0, ps.shop.upgradePrice);
    if (boardReady && price > ps.funds) gap = Math.max(gap, price - ps.funds);
  }
  for (const s of ps.shop.slots) {
    if (!s || s.sold || s.kind !== 'chess') continue;
    if (!gd.isGolden(s.id) && !ps.completesChessMerge(s.id)) continue;
    gap = Math.max(gap, ps.priceOf(s) - ps.funds);
  }
  return gap;
}

/** Answer one incoming request of a bot seat (`id` = answer that one, null = whatever is pending). */
export function botEconRespond(m, ps, id = null) {
  if (!m.teamEcon) return false;
  const inbox0 = m.econPrivateFor(ps)?.requestIn;
  const inbox = Array.isArray(inbox0) ? inbox0 : (inbox0 ? [inbox0] : []);
  const req = (id != null ? inbox.find((r) => r.id === id) : inbox[0]) || null;
  if (!req) return false;
  const bl = m.teamEcon.botLend;
  // still thinking: this bot's own pause for THIS request (each recipient has its own clock)
  const raw = m.econRequests ? m.econRequests.get(req.id) : null;
  const decideAt = raw && raw.decideAtBy ? raw.decideAtBy.get(ps.playerId) : undefined;
  if (bl && bl.enabled && Number.isFinite(decideAt) && m.sched.now() < decideAt) return false;
  const keep = fundsReserve(m, ps);
  // cannot spare it at all: the server would refuse the transfer anyway (borrowOnly's keep is 0, bands' capital 5)
  if (ps.funds - req.amount < keep) return !!m.econRespond(ps, req.id, false)?.ok;
  let approve;
  if (bl && bl.enabled) {
    // 借款意愿: a seeded roll — the under-developed borrower, their repayment safety and this lender's own 兜底 rate
    // raise it (Match.econBotLendChance); a loan that would eat the bot's own shopping money scales it down.
    let p = m.econBotLendChance(ps, req.from);
    const want = cheapestAffordable(ps);
    if (want > 0 && ps.funds - req.amount - keep < want) p = Math.floor((p * bl.tightFactorPct) / 100);
    approve = m.rngEcon.int(100) < p;
  } else {
    approve = ps.funds - req.amount >= keep + 2; // the flat rule while 借款意愿 is off
  }
  return !!m.econRespond(ps, req.id, approve)?.ok;
}

/**
 * The bot's ask: either the legacy rule — broke with nothing affordable asks outright (no roll) — or, with 主动借钱 on,
 * a seeded roll. Two branches, each rolled at most once per round:
 *   ordinary  `min(maxPct, basePct + brokePct·broke)` — the normal-case random ask, capped at 50;
 *   关键节点  `min(keyMaxPct, basePct + keyPct)` — a level-up or an elite chess it cannot fund, capped at 80.
 * The roll is `rngEcon`, so a seed replays it; `retry` (after a refusal) skips the roll — the bot already decided it
 * wants a loan and only turns to the next teammate.
 */
export function botEconMaybeRequest(m, ps, { retry = false } = {}) {
  if (!m.teamEcon || !ps.alive || ps.ready) return false;
  const view = m.econPrivateFor(ps);
  if (!view || view.requestLeft <= 0 || (Array.isArray(view.myRequests) && view.myRequests.length)) return false;
  const ba = m.teamEcon.botAsk;
  const gap = ba && ba.enabled ? botEconKeyMoment(m, ps) : 0;
  if (!retry) {
    const affordable = ps.shop.slots.some((s) => s && !s.sold && ps.priceOf(s) <= ps.funds);
    const broke = ps.funds <= 2 && !affordable;
    // a 关键节点 is judged the moment it appears (after the bot has spent), the ordinary case once per prep
    const mark = gap > 0 ? MARK_KEY : MARK_ASK;
    if (ps[mark] === m.round) return false;
    ps[mark] = m.round;
    if (ba && ba.enabled) {
      const p = gap > 0
        ? Math.min(ba.keyMaxPct, ba.basePct + ba.keyPct)
        : Math.min(ba.maxPct, ba.basePct + (broke ? ba.brokePct : 0));
      if (m.rngEcon.int(100) >= p) return false;
    } else if (!broke) {
      return false; // 主动借钱 off: the old "flat broke and nothing affordable" trigger only
    }
  }
  // 广播（v2.1）：一次问遍其余队友；谁拒绝过、谁 ready 由 econRequest 自己筛
  const need = gap > 0 ? gap : Math.max(1, 4 - ps.funds);
  const amount = Math.min(m.teamEcon.transfer.maxPerRequest, Math.max(1, need));
  return !!m.econRequest(ps, null, amount)?.ok;
}

/** Which seams the wrapper managed to hang the policy on (read by boot.mjs' MOD_BOOT and the MOD's tests). */
export const matchBotEconWiring = { scheduleBotPrep: false, setReady: false };

/**
 * The prep-start seam: answer a pending request, then ask for help while broke. Called from the wrapper on
 * `Match.prototype.scheduleBotPrep`, i.e. once per bot seat per round, before the generator's first slice — the same
 * place the fork called them (bot.js botPrepBeginSteps step 0).
 */
export function modXieBotEconStart(m, ps) {
  if (!m.teamEcon || !ps || !ps.botControlled) return;
  botEconRespond(m, ps);
  botEconMaybeRequest(m, ps);
}

/**
 * The prep-end seam: the bot is about to Ready (it only does that once it is done spending and has placed its board),
 * so the "money is spent now" ask of the fork's mid-prep steps runs here. `ps.ready` is still false, which
 * botEconMaybeRequest requires.
 */
export function modXieBotEconEnd(m, ps) {
  if (!m || !m.teamEcon || !ps || !ps.botControlled) return;
  if (m.phase !== PHASE.PREP || !ps.alive || ps.left) return;
  botEconMaybeRequest(m, ps);
}
