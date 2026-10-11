// server/match/unite100.mjs — the 100-seat 联防 (unite) rule layer (design-level item C of 百卫补丁 v0.3,
// docs/PS100-MIGRATION.md §10-C, docs/FINDINGS-100.md). Pure functions over the match's PlayerStates — no phase state
// is touched here, so every rule below is unit-testable on synthetic results.
//
// The design (owner's rules):
//   阶段 1 队内兜底: within a squad of 4, the members that did NOT leak ("完美作战") cover their OWN squad's leaked
//     enemies. At most 2 helpers per squad (the escaped map has two lanes), ranked by the upstream order
//     `unitsOnField > activeBond > standingUnits > seat`. "状态良好" (standing units) is a RANKING term, not a gate.
//   阶段 2 跨队兜底: whatever phase 1 did not stop is handed to ONE other squad picked by remaining strength; if that
//     squad fails too, the leaked enemies settle as LP loss and are NOT relayed again.
//
// WHY this module exists at all: upstream 联防 is ONE room-wide plan on ONE battlefield (unite.js planUnite, taken by
// `MatchUnite.startUnite(plan)`), which cannot hold 25 squads. The variant keeps that implementation untouched for
// ≤ MAX_SEATS PARTICIPANTS and layers this per-squad planning on top (unite.js planUnite → planUniteBySquad under
// `Match.variant` = 参与人数 > 4; 闸门读的是在场参与者数，不是房间容量).
//
// The squad structure (shared/squads.js of the patch) is inlined here rather than added to shared/: this delivery is
// scoped to server/match/** and must not open a second consumer for a 40-line module (see the delivery report).

import { helperOrder, uniteSurvivors } from './unite.js';

/** Players per squad. */
export const SQUAD_SIZE = 4;

/** Squad count for `seats` seats (ceil: a partial last squad still exists). @param {number} seats */
export const squadCount = (seats) => Math.max(0, Math.ceil((Number(seats) || 0) / SQUAD_SIZE));

/**
 * Squad index of a seat. `-1` for anything that is not a non-negative integer seat.
 * @param {number} seat
 */
export function squadIndexOf(seat) {
  return Number.isInteger(seat) && seat >= 0 ? Math.floor(seat / SQUAD_SIZE) : -1;
}

/**
 * The seat numbers of the squad that holds `seat`, in ascending order. Empty for an invalid seat.
 * @param {number} seat
 * @returns {number[]}
 */
export function squadMembersOf(seat) {
  const k = squadIndexOf(seat);
  if (k < 0) return [];
  const base = k * SQUAD_SIZE;
  return Array.from({ length: SQUAD_SIZE }, (_, i) => base + i);
}

/** Whether two seats are in the same squad (false when either is invalid). */
export function sameSquadOf(a, b) {
  const k = squadIndexOf(a);
  return k >= 0 && k === squadIndexOf(b);
}

/**
 * The player states of the squad that holds `seat`, in seat order (PlayerRules.squadPeers).
 * @param {import('./Match.js').Match} m
 * @param {number} seat
 */
export function squadPeersOf(m, seat) {
  const ids = new Set(squadMembersOf(seat));
  return (m.order || []).filter((ps) => ids.has(ps.seat));
}

/**
 * Group the alive players by squad.
 * @param {import('./Match.js').Match} m
 * @returns {Map<number, any[]>} squad index → its alive players (seat order)
 */
export function squadsOf(m) {
  /** @type {Map<number, any[]>} */
  const out = new Map();
  for (const ps of m.alivePlayers()) {
    const k = squadIndexOf(ps.seat);
    if (k < 0) continue;
    const list = out.get(k);
    if (list) list.push(ps); else out.set(k, [ps]);
  }
  for (const list of out.values()) list.sort((a, b) => a.seat - b.seat);
  return out;
}

/**
 * Phase 1: one 联防 plan per squad that both leaked and still has a perfect member to send.
 *
 * Same trigger as upstream (unite.js planUnite) but scoped to the squad: a squad unites iff ≥ 1 of ITS members leaked
 * and ≥ 1 of its members was perfect. Helpers are ITS perfect members only (≤ gd.unite.maxHelpers), ranked by the
 * upstream order — so no squad ever defends another squad's leaks in this phase.
 *
 * @param {import('./Match.js').Match} m
 * @param {Map<string, object>} results playerId → BattleResult.perPlayer entry
 * @returns {Array<{ squad: number, helpers: any[], leakers: any[], leaked: object[], notReentered: Map<string, number> }>}
 */
export function planUniteBySquad(m, results) {
  if (m.isSolo) return [];
  const plans = [];
  for (const [squad, members] of squadsOf(m)) {
    const leakers = [];
    const perfects = [];
    for (const ps of members) {
      const r = results.get(ps.playerId);
      if (!r) continue;
      const counted = (r.leaked || []).filter((l) => l && l.counted !== false);
      if (counted.length > 0) leakers.push(ps);
      else if (r.perfect !== false) perfects.push(ps);
    }
    if (!leakers.length || !perfects.length) continue;
    const helpers = helperOrder(m, perfects, results);
    const leaked = [];
    const notReentered = new Map();
    for (const ps of leakers) {
      const r = results.get(ps.playerId);
      for (const l of r.leaked || []) {
        if (!l || l.counted === false) continue;
        if (!m.gd.enemy(l.enemyKey)) { notReentered.set(ps.playerId, (notReentered.get(ps.playerId) || 0) + 1); continue; }
        const bountyId = l.mods && l.mods.bountyId;
        const b = bountyId ? ps.bounties.find((x) => x.id === bountyId) : null;
        const card = b && b.card;
        let bounty = card && card.payout !== 'perfect' && Number(card.coin) > 0 && l.enemyKey === card.enemyKey
          ? { coins: Math.trunc(Number(card.coin)), ownerPlayerId: ps.playerId } : null;
        const extra = !bountyId && l.mods ? Math.trunc(Number(l.mods.bountyCoins) || 0) : 0;
        if (!bounty && extra > 0) bounty = { coins: extra, ownerPlayerId: ps.playerId };
        leaked.push({ enemyKey: l.enemyKey, mods: l.mods ? { ...l.mods } : null, lpr: l.lpr ?? 1, sourcePlayerId: ps.playerId, tag: l.tag ?? null, bounty });
      }
    }
    plans.push({ squad, helpers, leakers, leaked, notReentered });
  }
  return plans.sort((a, b) => a.squad - b.squad);
}

/** Whether a squad has anything to defend at all (used by the phase to decide whether it starts a field). */
export function squadHasLeaks(plan) {
  return !!plan && (plan.leaked.length > 0 || plan.notReentered.size > 0);
}

// ---------------------------------------------------------------------------------------------------
// 阶段 2 跨队兜底 (cross-squad relay)

/**
 * Remaining strength of a squad — the key for picking the squad that takes over another squad's unhandled leaks
 * ("按剩余实力挑一个队接手"). Upstream already computes a per-player strength triple for ranking 联防 helpers
 * (unite.js helperStats): board units, whether a bond is active, and the operators still standing at the end of the
 * round's own combat. A squad's strength sums that over its members; `standing` weighs most because a board that
 * survived the round is what can still hold a line.
 *
 * @param {import('./Match.js').Match} m
 * @param {any[]} members the squad's players
 * @param {Map<string, object>} results playerId → BattleResult.perPlayer entry
 * @returns {{ squad: number, units: number, standing: number, active: number, score: number }}
 */
export function squadStrength(m, members, results) {
  let units = 0;
  let standing = 0;
  let active = 0;
  for (const ps of members) {
    const r = results.get(ps.playerId);
    const board = ps.board ? ps.board.size : 0;
    units += board;
    const opUids = new Set();
    if (ps.board) for (const p of ps.board.values()) if (p && p.kind === 'chess') opUids.add(p.uid);
    if (r && Array.isArray(r.unitsEnd) && r.unitsEnd.length) {
      for (const u of r.unitsEnd) if (u && opUids.has(u.uid) && u.alive) standing++;
    } else {
      standing += board;      // no end state recorded: fall back to the board as it stands
    }
    if (Object.keys(ps.layers || {}).length) active++;
  }
  const score = standing * 1e6 + units * 1e3 + active;   // standing dominates, then the full board, then an active bond
  return { squad: members.length ? squadIndexOf(members[0].seat) : -1, units, standing, active, score };
}

/**
 * Whether an enemy instance can be RELAYED to another squad's 联防. Relaying re-spawns it on another field, so it needs
 * an enemy record and a spawn spec; whatever `planUnite` refused to route (an unknown enemy key — its `notReentered`
 * bucket) cannot be relayed either and settles directly.
 * @param {import('./gamedata.js').GameData} gd
 * @param {object} leak a plan's `leaked[]` entry
 */
export function canRelay(gd, leak) {
  return !!(leak && typeof leak.enemyKey === 'string' && gd.enemy(leak.enemyKey));
}

/** A fresh leak entry for `enemyKey` from `sourcePlayerId`, in the shape buildUniteWave consumes. */
export function relayLeak(enemyKey, sourcePlayerId, { mods = null, lpr = 1, tag = null, squad = null, bounty = null } = {}) {
  return { enemyKey, mods: mods ? { ...mods } : null, lpr, sourcePlayerId, tag, bounty, squad };
}

/**
 * Carve the UNHANDLED part out of phase 1's outcome: the enemies that squad's own 联防 did not stop.
 *
 * `uniteSurvivors(plan, result)` counts, per leaker, exactly what settlement would charge — survivors still on the
 * field plus the leaks that never re-entered. Those are the enemies that got through, i.e. what 阶段 2 hands to another
 * squad. They are re-created as fresh leak entries (buildUniteWave only reads `enemyKey`, `mods`, `sourcePlayerId`,
 * `lpr`, `tag`), keeping `sourcePlayerId` so settlement still bills the player who originally let them through.
 *
 * @param {import('./gamedata.js').GameData} gd
 * @param {object} plan the squad's phase-1 plan (unite.js shape)
 * @param {object|null} result its battle result
 * @returns {{ plan: object, relayable: number, settled: number, leakers: string[] }}
 */
export function takeUnhandled(gd, plan, result) {
  const unhandled = uniteSurvivors(plan, result);
  const leaked = [];
  // The relaying set is the players that ACTUALLY have unhandled enemies left — not the squad's whole leaker list.
  // Settlement charges a plan's `leakers` against `uniteSurvivors`, so a leaker wrongly listed here would be charged
  // another player's survivors.
  const relayLeakers = new Set();
  let settled = 0;
  for (const [pid, n] of unhandled) {
    const got = Math.max(0, Math.floor(Number(n) || 0));
    if (!(got > 0)) continue;
    relayLeakers.add(pid);
    const templates = (plan.leaked || []).filter((l) => l.sourcePlayerId === pid && canRelay(gd, l));
    if (!templates.length) { settled += got; continue; }   // nothing relayable (unknown keys): settle directly
    for (let i = 0; i < got; i++) {
      const t = templates[i % templates.length];
      leaked.push(relayLeak(t.enemyKey, pid, { mods: t.mods, lpr: t.lpr ?? 1, tag: t.tag ?? null, bounty: t.bounty ?? null, squad: plan.squad }));
    }
  }
  // The relayed enemies are built from each player's OWN template (a leak of that player), never by cycling over
  // another player's entries: an enemy must be attributed to the player that actually let it through.
  const leakers = [...relayLeakers]
    .map((pid) => (plan.leakers || []).find((p) => p.playerId === pid))
    .filter(Boolean);
  return {
    plan: { squad: plan.squad, helpers: plan.helpers, leakers, leaked, notReentered: new Map(), relayFrom: plan.squad },
    relayable: leaked.length,
    settled,
    leakers: [...relayLeakers],
  };
}

/**
 * Pick the squad that takes over `fromSquad`'s unhandled leaks: the ALIVE squad with the highest remaining strength
 * (squadStrength) that is neither the relaying squad nor already taking over someone else this round. Ties break by
 * squad order, so a fixed seed reproduces the same relay.
 *
 * @param {import('./Match.js').Match} m
 * @param {number} fromSquad
 * @param {Map<string, object>} results
 * @param {Set<number>} taken squads already assigned a relay this round
 * @returns {number|null}
 */
export function pickRelaySquad(m, fromSquad, results, taken = new Set()) {
  let best = null;
  let bestScore = -Infinity;
  for (const [squad, members] of squadsOf(m)) {
    if (squad === fromSquad || taken.has(squad) || !members.length) continue;
    const s = squadStrength(m, members, results);
    if (s.score > bestScore) { bestScore = s.score; best = squad; }
  }
  return best;
}

/**
 * 阶段 2: assign each squad's unhandled leaks to ONE other squad. At most one relay per receiving squad per round
 * (`taken`), and the relaying squads are processed strongest-first so the biggest hand-off gets the pick of receivers.
 *
 * @param {import('./Match.js').Match} m
 * @param {Array<{ plan: object, unhandled: { plan: object, relayable: number } }>} phase1 phase-1 outcomes
 * @param {Map<string, object>} results
 * @returns {Array<{ plan: object, from: number, to: number }>}
 */
export function planRelayBySquad(m, phase1, results) {
  const taken = new Set();
  const out = [];
  const squads = squadsOf(m);
  const ranked = phase1
    .filter((p) => p.unhandled && p.unhandled.relayable > 0)
    .map((p) => ({ p, strength: squadStrength(m, squads.get(p.plan.squad) || [], results).score }))
    .sort((a, b) => b.strength - a.strength || a.p.plan.squad - b.p.plan.squad);
  for (const { p } of ranked) {
    const to = pickRelaySquad(m, p.plan.squad, results, taken);
    if (to == null) continue;
    taken.add(to);
    out.push({ plan: p.unhandled.plan, from: p.plan.squad, to });
  }
  return out;
}

/** Build the relay (phase-2) plan of receiving squad `to`: its own perfect members against `relayPlan`'s enemies. */
export function relayPlanFor(m, to, relayPlan, results) {
  const members = (squadsOf(m).get(to) || []).filter((ps) => ps.alive);
  const perfect = members.filter((ps) => {
    const r = results.get(ps.playerId);
    if (!r) return false;
    const counted = (r.leaked || []).filter((l) => l && l.counted !== false);
    return counted.length === 0 && r.perfect !== false;
  });
  if (!perfect.length) return null;
  return {
    squad: to,
    helpers: helperOrder(m, perfect, results),
    // The receiving squad's members are NOT billed: these enemies belong to the RELAYING squad's players, and each
    // leak keeps its `sourcePlayerId`; `leakers` lists those source players so settle() charges them, not the receiver.
    // `leakers` is DERIVED from the enemies being relayed (their `sourcePlayerId`), never taken from the incoming plan:
    // settle() charges a plan's `leakers` against `uniteSurvivors`, so a list that disagrees with `leaked` would bill
    // the wrong players.
    leakers: [...new Set(relayPlan.leaked.map((l) => l.sourcePlayerId))]
      .map((pid) => m.players.get(pid) || m.order.find((ps) => ps.playerId === pid))
      .filter(Boolean),
    leaked: relayPlan.leaked.map((l) => ({ ...l, mods: l.mods ? { ...l.mods } : null })),
    notReentered: new Map(),
    relayFrom: relayPlan.squad,
  };
}
