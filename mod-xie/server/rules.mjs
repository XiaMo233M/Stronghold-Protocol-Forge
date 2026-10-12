// server/rules.js — the MOD's rule-set resolver, owned by the MOD.
//
// In the fork these two resolutions were getters on GameData (`get teamEconomy` / `get revival`), added to
// server/match/gamedata.js — a file the MOD must not edit. They live here instead, ported verbatim (same clamps, same
// defaults, same "a mode overrides the whole block" pick pattern), and boot.mjs installs them back onto
// `GameData.prototype` as getters. The defaults below are the MOD's own numbers: the fork carried them in gamedata.js.
//
// `teamEconomy` resolves null unless the resolved block says `enabled` and the match is not solo; `revival` likewise.
// Every number is clamped here so the match code reads plain ints and never has to defend itself.

// 包化的规则覆盖块（每难度一组；由 v1 modes.json 提取，官方模式字段不复制）。见文件末尾的 `rulesForDifficulty`。
import { XIE_RULES } from '../data/rules.mjs';

/** The framework defaults both resolvers fall back to (the fork's DEFAULTS.teamEconomy / DEFAULTS.revival). */
export const RULE_DEFAULTS = {
  teamEconomy: {
    transfer: { maxPerRequest: 5, requestsPerRound: 1, teamCapPerRound: 8, ttlSec: 30, repayInterest: 0 },
    deathDividend: { enabled: false, dice: 6 },
    coverInterest: { enabled: false, capPct: 100, lagPremium: 1 },
    botLend: { enabled: false, basePct: 10, weakPct: 20, solventPct: 10, coverPct: 10, maxPct: 50, tightFactorPct: 50, delayMsMin: 600, delayMsMax: 2200 },
    botAsk: { enabled: false, basePct: 8, brokePct: 40, keyPct: 60, maxPct: 50, keyMaxPct: 80 },
    reserve: { convertPerPlayerMax: 2, perfectReward: 1, perfectRewardCapPerRound: 2 },
    relief: { enabled: false, amount: 1, lpThreshold: 10, perPlayerPerRound: 2, teamPerRound: 4 },
    projects: {
      procure: { costs: [4, 8, 12, 16] },
      storehouse: { costs: [4, 8, 12, 16] },
      logistics: { costs: [4, 8, 12, 16], teamCapBonus: [4, 8, 12, 16], extraRequestsAtL3: 1 },
    },
  },
  revival: { enabled: false, costPer: 5, step: 5 },
};

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * 协同经济: the resolved rule set, or null while it is off. Off unless the mode's block (or, with no mode block, the
 * config's `economy.team`) says `enabled` — and never in solo.
 */
export function teamEconomyOf(gd) {
  const mode = obj(gd.mode.teamEconomy);
  // `GameData.economy` is a fork getter (config.economy); on a pristine tree neither it nor config.economy exists, so the
  // fallback resolves to {} and the rule set is on only when the mode record says so — which is how the MOD ships it.
  const conf = obj(obj(gd.economy ?? gd.config?.economy).team);
  const src = Object.keys(mode).length ? mode : conf;
  if (src.enabled !== true || gd.isSolo) return null;
  const d = RULE_DEFAULTS.teamEconomy;
  const nn = (v, dflt) => (Number.isInteger(v) && v >= 0 ? v : dflt);
  const pi = (v, dflt) => (Number.isInteger(v) && v > 0 ? v : dflt);
  const costs = (v, dflt) => (Array.isArray(v) && v.length ? v.slice(0, 4) : dflt).map((x) => (Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0));
  const tr = obj(src.transfer);
  const rv = obj(src.reserve);
  const rl = obj(src.relief);
  const pj = obj(src.projects);
  const project = (id) => {
    const cur = obj(pj[id]);
    const def = d.projects[id];
    const out = { costs: costs(cur.costs, def.costs) };
    if (def.teamCapBonus) out.teamCapBonus = costs(cur.teamCapBonus, def.teamCapBonus);
    if (Number.isInteger(def.extraRequestsAtL3)) out.extraRequestsAtL3 = nn(cur.extraRequestsAtL3, def.extraRequestsAtL3);
    return out;
  };
  return {
    // `borrowOnly` is the fork's variant flag for a 协同共竞 room that ships ONLY the ask/transfer layer (no reserve,
    // no projects, no relief). No mode record ships it today — every `mode_xie_*` carries the full rule set — but the
    // flag and every reader below stay, because it is a mode-authoring option, not a MOD option.
    borrowOnly: src.borrowOnly === true,
    transfer: {
      maxPerRequest: pi(tr.maxPerRequest, d.transfer.maxPerRequest),
      requestsPerRound: pi(tr.requestsPerRound, d.transfer.requestsPerRound),
      teamCapPerRound: pi(tr.teamCapPerRound, d.transfer.teamCapPerRound),
      ttlSec: pi(tr.ttlSec, d.transfer.ttlSec),
      repayInterest: nn(tr.repayInterest, d.transfer.repayInterest),
    },
    deathDividend: (() => {
      const dd = obj(src.deathDividend);
      return { enabled: dd.enabled === true, dice: Math.max(2, Math.min(100, pi(dd.dice, d.deathDividend.dice))) };
    })(),
    coverInterest: (() => {
      const ci = obj(src.coverInterest);
      return {
        enabled: ci.enabled === true,
        capPct: Math.max(0, Math.min(100, nn(ci.capPct, d.coverInterest.capPct))),
        // 兜底率分红: what a debt owed by a borrower who was behind the team's median earns on top (1 = off)
        lagPremium: Math.max(1, Math.min(4, pi(ci.lagPremium, d.coverInterest.lagPremium))),
      };
    })(),
    botAsk: (() => {
      const ba = obj(src.botAsk);
      const pct = (v, dflt) => Math.max(0, Math.min(100, Math.trunc(Number.isFinite(v) ? v : dflt)));
      const maxPct = pct(ba.maxPct, d.botAsk.maxPct);
      return {
        enabled: ba.enabled === true,
        basePct: Math.min(maxPct, pct(ba.basePct, d.botAsk.basePct)),
        brokePct: pct(ba.brokePct, d.botAsk.brokePct),
        keyPct: pct(ba.keyPct, d.botAsk.keyPct),
        maxPct,
        // a 关键节点 may reach higher than the ordinary ask, never lower
        keyMaxPct: Math.max(maxPct, pct(ba.keyMaxPct, d.botAsk.keyMaxPct)),
      };
    })(),
    botLend: (() => {
      const bl = obj(src.botLend);
      const pct = (v, dflt) => Math.max(0, Math.min(100, Math.trunc(Number.isFinite(v) ? v : dflt)));
      const ms = (v, dflt) => Math.max(0, Math.min(10000, Math.trunc(Number.isFinite(v) ? v : dflt)));
      const maxPct = pct(bl.maxPct, d.botLend.maxPct);
      const lo = ms(bl.delayMsMin, d.botLend.delayMsMin);
      return {
        enabled: bl.enabled === true,
        basePct: Math.min(maxPct, pct(bl.basePct, d.botLend.basePct)),
        weakPct: pct(bl.weakPct, d.botLend.weakPct),
        solventPct: pct(bl.solventPct, d.botLend.solventPct),
        coverPct: pct(bl.coverPct, d.botLend.coverPct),
        maxPct,
        tightFactorPct: pct(bl.tightFactorPct, d.botLend.tightFactorPct),
        delayMsMin: lo,
        delayMsMax: Math.max(lo, ms(bl.delayMsMax, d.botLend.delayMsMax)),
      };
    })(),
    reserve: {
      convertPerPlayerMax: nn(rv.convertPerPlayerMax, d.reserve.convertPerPlayerMax),
      perfectReward: nn(rv.perfectReward, d.reserve.perfectReward),
      perfectRewardCapPerRound: nn(rv.perfectRewardCapPerRound, d.reserve.perfectRewardCapPerRound),
    },
    relief: {
      enabled: rl.enabled === true,
      // one fund at a time (user decision 2026-10-09: 「每次取1」)
      amount: Math.max(1, Math.min(9, pi(rl.amount, d.relief.amount))),
      lpThreshold: nn(rl.lpThreshold, d.relief.lpThreshold),
      perPlayerPerRound: nn(rl.perPlayerPerRound, d.relief.perPlayerPerRound),
      teamPerRound: nn(rl.teamPerRound, d.relief.teamPerRound),
    },
    // The projects a mode ships: exactly the keys its `projects` block names — a mode that drops 联合采购 simply does
    // not list it, and `econBuyProject`/the view follow this set. With no block at all, the framework's default set.
    //
    // audit P2（本轮修）：显式写出的 `projects: {}` 表示「这个模式一个项目都不开」；只有**整个键缺席**时才回落到
    // 默认集。原判据是「过滤后数组是否非空」，于是空块与缺席被混为一谈（写空对象反而得到全部项目）。
    projects: Object.fromEntries((() => {
      const named = Object.hasOwn(mode, 'projects')
        ? Object.keys(pj).filter((id) => Object.hasOwn(d.projects, id))
        : Object.keys(d.projects);
      return named;
    })().map((id) => [id, project(id)])),
  };
}

/**
 * 救援: the resolved rule set, or null while it is off. A mode turns it on with `mode.revival = { enabled: true }`; it
 * never applies to solo. Numbers are clamped here so the match code reads plain ints.
 */
export function revivalOf(gd) {
  const mode = obj(gd && gd.mode && gd.mode.revival);
  if (mode.enabled !== true || (gd && gd.isSolo)) return null;
  const d = RULE_DEFAULTS.revival;
  const pi = (v, dflt) => (Number.isInteger(v) && v > 0 ? v : dflt);
  // 每人每次从共享池扣 costPer + step × 已复活次数（5 / 10 / 15…，依次叠加）
  return { costPer: pi(mode.costPer, d.costPer), step: (Number.isInteger(mode.step) && mode.step >= 0 ? mode.step : d.step) };
}

/**
 * 促融共竞 · 包化：难度 → 这个 MOD 的规则覆盖块（`data/rules.mjs`，由 v1 的 modes.json 提取）。
 *
 * 官方模式记录（`data/config.json` 的 `mode_multi_*`）**不在包里复制**：回合表 / 敌人倍率 / 商店一律由引擎的官方
 * 记录提供，MOD 只叠加 `teamEconomy` / `revival` 两个块。v1 曾整份复制模式记录，那会在上游改数值后永远落后
 * （审计 P1）—— 这里改成运行时合成。
 */
export function rulesForDifficulty(difficulty) {
  const key = String(difficulty || '').toUpperCase();
  return XIE_RULES[key] || XIE_RULES.NORMAL;
}

/** 这个难度的经济规则集（`teamEconomyOf` 吃 `gd.mode.teamEconomy`，这里喂一个合成的 mode 壳）。 */
export function teamEconomyFor(difficulty) {
  return teamEconomyOf({ mode: { teamEconomy: rulesForDifficulty(difficulty).teamEconomy } });
}

/** 这个难度的救援规则集。 */
export function revivalFor(difficulty) {
  return revivalOf({ mode: { revival: rulesForDifficulty(difficulty).revival } });
}
