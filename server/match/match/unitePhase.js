// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
//
// TWO SHAPES, ONE SWITCH (design-level item C of 百卫补丁 v0.3, docs/PS100-MIGRATION.md §10-C):
//   * ≤ MAX_SEATS PARTICIPANTS (every existing deployment, and a 20-seat room with only 4 players in it):
//     `startUnite(plan)` — ONE room-wide plan, ONE battlefield 'u'. That code
//     is the `Array.isArray` else-branch below, statement for statement, and it never touches `unitePlans` /
//     `uniteRound` / `_uniteToken` / `_uniteHandoff` / `_phase1Driven` / `_relay*` (Match.js initializes them and
//     leaves them at rest; test/ps100-variant-ac.test.js pins that).
//   * more than `MAX_SEATS` participants: `planUnite` returns the per-squad list (unite100.mjs planUniteBySquad) and
//     `startUnite(plans)` takes the Array branch — one battlefield per squad (`u<squad>` for 阶段 1, `r<squad>` for
//     阶段 2), all stepping in lockstep in one FieldRunner, and `_afterUniteRound` runs 阶段 2 (跨队兜底) as a REAL
//     second battlefield round (config.unite.relayBattlefield, default true; the atomic strength check stays as the
//     documented fallback).
//
// ONE SQUAD IS STILL ONE FIELD 'u' — the field id, the seed and every battle option of a single-squad round are
// byte-identical to the single-plan round, which is why test/golden/fields.json's `unite-1` / `unite-2` scenarios (1–2
// helpers ⇒ a single squad) cannot move in either mode.
//
// `unitePlan` stays a SINGLE object in both shapes: in the variant it is the room-wide UNION of the round's plans
// (`combineUniteResults`). views.js (statusOf / m.public.unite) and settle() therefore need no change at all — a union
// helper reads 'helping' and the settlement bills the union's leakers. `unitePlans` is the per-field list, and
// `_uniteLeft` picks the plan and the field that actually carry the queried leaker (the patch's known defect was
// reading `unitePlan` + `fields[0]` under multiple plans, which reported another squad's count).
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, combineUniteResults } from '../unite.js';
import { takeUnhandled, planRelayBySquad, relayPlanFor, squadStrength } from '../unite100.mjs';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onStartUnite } from '../botEmotes.js';

export class MatchUnite {
  /**
   * Start the 联防. `plan` is the upstream single room-wide plan (the `≤ MAX_SEATS` shape, below) OR — in the 100-seat
   * variant — the per-squad list `planUniteBySquad` returned. The SHAPE is the switch: an array can only come out of
   * the gated `planUnite`, so a ≤ 4-seat match never reaches the variant methods.
   *
   * @param {object|Array<object>} plan one plan, or the per-squad list (100-seat variant)
   * @param {number} [round] 1 (阶段 1 队内兜底) or 2 (阶段 2 跨队兜底 relay); ignored by the single-plan shape
   */
  startUnite(plan, round = 1) {
    if (Array.isArray(plan)) { this._startUniteVariant(plan, round); return; }
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const battle = this.newBattle(this._uniteOpts(plan, limit));
    this.fields = [{ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, plan); // an AI helper says "合作愉快" once on the open of a 联防 (enabled by default; SP_BOT_EMOTES=0 silences it)
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        const res = runner.resultOf(this.fields[0]);
        this._collectSimErrors(this.fields[0], res);
        this.fields[0].live = false;
        this.deadline = 0;
        this.markPublic();
        this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, res));
      },
    });
    this.runner.start();
  }

  // -----------------------------------------------------------------------------------------------------------------
  // 100-seat variant (seatCap > MAX_SEATS): one battlefield per squad, 阶段 1 then 阶段 2 (docs/PS100-MIGRATION.md §10-C)

  /**
   * 阶段 1 (`round === 1`) or 阶段 2 (`round === 2`): one field per squad plan, all in one FieldRunner so they step in
   * lockstep and the phase ends when the LAST of them is done ("队内等待完毕后等待其他小队" — FieldRunner fires onDone
   * only once every field is not live).
   *
   * The field id is `u<squad>` (阶段 1) / `r<squad>` (阶段 2), and plain `'u'` when a single plan is left — that is
   * what keeps a 1–2 helper round byte-identical to the single-plan implementation.
   * @param {Array<object>} plans the per-squad plans
   * @param {number} [round]
   */
  _startUniteVariant(plans, round = 1) {
    const list = (Array.isArray(plans) ? plans : [plans]).filter(Boolean);
    if (!list.length) { this.settle(null, null); return; }
    this.uniteRound = Number.isInteger(round) && round > 0 ? round : 1;
    this._uniteToken = (this._uniteToken || 0) + 1;
    this._uniteHandoff = list;
    this.unitePlans = list;
    // the room-wide union the single-plan consumers read (MatchViews.statusOf / m.public.unite / settle's leaker bill)
    this.unitePlan = combineUniteResults(list, []).plan;
    if (this.clientCombat) { this._startUniteVariantClient(list); return; }
    this.phase = PHASE.UNITE;
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.fields = list.map((p, i) => {
      const fieldId = this._uniteFieldId(p, i, list.length);
      return { fieldId, kind: 'unite', players: p.helpers.map((x) => x.playerId), battle: this.newBattle(this._uniteOpts(p, limit, fieldId)), live: true };
    });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: list.flatMap((p) => p.helpers.map((h) => h.name)) }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, this.unitePlan);
    this._uniteLeftKey = null;
    const token = this._uniteToken;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE || token !== this._uniteToken) return;
        const results = this.fields.map((f) => {
          const res = runner.resultOf(f);
          this._collectSimErrors(f, res);
          f.live = false;
          return res;
        });
        // pair each RESULT with the plan that produced it; a plan may have had no field at all (a bare relay case)
        const byPlan = new Map(list.map((p, i) => [p, results[i] || null]));
        this.deadline = 0;
        this.markPublic();
        this._laterUniteRoundEnd(list, results, byPlan);
      },
    });
    this.runner.start();
  }

  /** The field id of a squad plan: `u<squad>` / `r<squad>`, plain `u` when it is the only field (see the header). */
  _uniteFieldId(plan, index, count) {
    if (count === 1) return this.uniteRound > 1 ? 'r' : 'u';
    const prefix = this.uniteRound > 1 ? 'r' : 'u';
    return `${prefix}${plan && plan.squad != null ? plan.squad : index}`;
  }

  /** After the 联防 round's COMBAT_END pause: settle (阶段 2) or plan 阶段 2 (阶段 1). */
  _laterUniteRoundEnd(list, results, byPlan) {
    const round = this.uniteRound;
    const combined = combineUniteResults(list, results);
    this.later(this.scaled(DELAYS.COMBAT_END), () => {
      if (round > 1) { this._finishRelayRound(combined.plan, combined.result); return; }
      this._afterUniteRound(combined.plan, combined.result, list, byPlan);
    });
  }

  /**
   * After one 联防 round of the variant — 阶段 2 (跨队兜底) or settlement.
   *
   * 阶段 1: carve the UNHANDLED enemies out of every squad's outcome (unite100.takeUnhandled) — those are what got
   * through — pick a receiving squad per relaying squad by remaining strength (planRelayBySquad) and run a SECOND 联防
   * round with those receivers. A relaying squad whose enemies have no relayable form (unknown enemy keys) settles
   * them directly, as does every relay that found no receiver.
   *
   * 阶段 2 (`uniteRound !== 1`, or the re-entry guard): settlement happens once — "第二波也没兜住时，漏怪就此结算扣 LP".
   *
   * RE-ENTRANCY (the patch's known corruption): this hook can fire more than once for the same round. Two independent
   * guards stop it — `uniteRound !== 1` settles and never plans again, and `_phase1Driven` lets a round number be
   * planned exactly once, however often the hook fires.
   */
  _afterUniteRound(plan, result, plans, byPlan = null) {
    if (this.uniteRound !== 1) { this._finishRelayRound(plan, result); return; }
    if (this._phase1Driven === this.round) return;
    this._phase1Driven = this.round;
    const phase1 = plans.map((p) => {
      const res = (byPlan && byPlan.has(p)) ? byPlan.get(p) : null;
      return { plan: p, result: res, unhandled: takeUnhandled(this.gd, p, res) };
    });
    if (!phase1.some((x) => x.unhandled.relayable > 0)) { this.settle(plan, result); return; }
    const relays = planRelayBySquad(this, phase1, this.lastResults);
    if (!relays.length) { this.settle(plan, result); return; }
    // 阶段 2 as a REAL second battlefield round (config.unite.relayBattlefield, default true): each receiver defends
    // the relayed enemies on its own field. `sourcePlayerId` travels with every relayed enemy, so a leak that gets
    // through again is still billed to the player who originally let it past — exactly as the atomic path does.
    if (this.gd.unite && this.gd.unite.relayBattlefield === false) { this._relayAtomic(plan, result, relays); return; }
    this._enterRelayBattlefield(plan, result, relays);
  }

  /**
   * 阶段 2 without a battlefield (`config.unite.relayBattlefield === false`): the receiving squad is credited with
   * holding `standing + units` enemies without a field, and whatever it cannot hold is added to the source players'
   * charge. The merged plan from `planRelayBySquad` already carries every squad's leftovers.
   */
  _relayAtomic(plan, result, relays) {
    const extraLeaked = [];
    const extraLeakers = new Set();
    for (const r of relays) {
      const rp = (r && r.plan) || null;
      if (!rp || !rp.helpers.length) continue;            // nobody left to send: the enemies settle
      const unhandled = rp.leaked.slice(this._relayHeld(rp));
      for (const l of unhandled) { extraLeaked.push(l); extraLeakers.add(l.sourcePlayerId); }
    }
    if (extraLeaked.length) {
      const sources = this.order.filter((ps) => extraLeakers.has(ps.playerId));
      this.settle(
        { helpers: plan.helpers, leakers: [...plan.leakers, ...sources], leaked: [...plan.leaked, ...extraLeaked], notReentered: plan.notReentered },
        result,
      );
      return;
    }
    this.settle(plan, result);
  }

  /**
   * How many of a relay plan's enemies the receiving squad's helpers stop, from their remaining strength
   * (unite100.squadStrength): `standing` operators hold one enemy each, plus one per board unit.
   */
  _relayHeld(rp) {
    const helpers = (rp && rp.helpers) || [];
    const s = squadStrength(this, helpers, this.lastResults);
    return Math.max(0, Math.min(rp.leaked.length, s.standing + s.units));
  }

  /**
   * 阶段 2: start the relay battlefield round — one field per receiving squad. The plans come from relayPlanFor (each
   * receiver's own perfect members, the relaying squads' enemies, their `sourcePlayerId` kept), and `uniteRound = 2`
   * makes the round-end hook settle instead of planning another round.
   */
  _enterRelayBattlefield(plan, result, relays) {
    const list = [];
    for (const r of relays) {
      const rp = relayPlanFor(this, r.to, r.plan, this.lastResults);
      if (!rp || !rp.helpers || !rp.helpers.length) continue;
      list.push(rp);
    }
    if (!list.length) { this.settle(plan, result); return; }
    // Remember phase 1's outcome: if the relay cannot be fought (or the round is interrupted) settlement still has to
    // bill phase 1's leaks rather than lose them.
    this._phase1Settle = { plan, result };
    this._relayToken = (this._relayToken || 0) + 1;
    const token = this._relayToken;
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: list.flatMap((p) => p.helpers.map((h) => h.name)) }), FLOW_TICKER_PRIORITY);
    // `later(0)` defers the launch out of this finish hook; starting fields inside it is what let the old
    // implementation fire the round-end hook again mid-round.
    this.later(0, () => {
      if (token !== this._relayToken) return;             // superseded (a newer round started)
      if (this.phase !== PHASE.UNITE || this.uniteRound !== 1) return;
      this.startUnite(list, 2);
    });
  }

  /** 阶段 2 is over: settle. The relay fields' own result is what the receivers stopped; phase 1 is merged back in. */
  _finishRelayRound(plan, result) {
    const p1 = this._phase1Settle || null;
    if (!p1) { this.settle(plan, result); return; }
    const merged = combineUniteResults([p1.plan, plan], [p1.result, result]);
    this.settle(merged.plan, merged.result);
  }

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   *
   * `fieldId` defaults to 'u' and only widens the derived seed when a squad field needs its own stream — with a single
   * field the seed, the field id and every option are the pre-existing ones, byte for byte.
   */
  _uniteOpts(plan, limit, fieldId = 'u') {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, fieldId === 'u' ? `u:${this.round}` : `u:${this.round}:${fieldId}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...this.layout.battle.unite },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId,
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
      // 限伤 override for the CLIENT-run spec (shared/constants.js bossHitLimitFrom): present only when a deployment
      // set it, so an unconfigured server sends byte-for-byte the old spec.
      ...(this.bossHitLimit === undefined ? {} : { bossHitLimit: this.bossHitLimit }),
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const f = this._ccField({ fieldId: 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts: this._uniteOpts(plan, limit) });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, 'u');
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  /**
   * The variant's client-run 联防: one field per squad, each viewer watching its own squad's field (a helper) or the
   * first field it does not fight on (an observer, spectator seats included). `this.fields` is cleared before the
   * launch: clientCombat ends a phase as soon as every field is done, so a stale done field would let the round-end
   * hook fire a second time — which re-carved the relay plans and mixed the squads' charges.
   */
  _startUniteVariantClient(list) {
    this.phase = PHASE.UNITE;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const fields = list.map((p, i) => {
      const fieldId = this._uniteFieldId(p, i, list.length);
      return this._ccField({ fieldId, kind: 'unite', players: p.helpers.map((x) => x.playerId), opts: this._uniteOpts(p, limit, fieldId) });
    });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this.fields = [];
    this._launch(fields);
    const viewers = [...this._viewers()];
    for (const f of fields) {
      for (const ps of viewers) {
        const mine = f.players.includes(ps.playerId);
        if (mine || !this.watchers.has(ps.playerId)) this.watchers.set(ps.playerId, f.fieldId);
        this._sendStart(ps.playerId, f, { watch: !mine });
      }
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: list.flatMap((p) => p.helpers.map((h) => h.name)) }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    if (Array.isArray(this.unitePlans) && this.unitePlans.length) { this._finishUniteVariantClient(); return; }
    const f = this.fields[0];
    const res = f.result;
    this._collectSimErrors(f, res);
    this._stopClientCombat();
    f.live = false;
    this.deadline = 0;
    this.markPublic();
    const plan = this.unitePlan;
    this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, res));
  }

  /** All squad fields are done (clientCombat calls this once every cc field has finished): see _laterUniteRoundEnd. */
  _finishUniteVariantClient() {
    const list = this.unitePlans.slice();
    const results = this.fields.map((f) => {
      this._collectSimErrors(f, f.result);
      return f.result;
    });
    this._stopClientCombat();
    for (const f of this.fields) f.live = false;
    this.deadline = 0;
    this.markPublic();
    const byPlan = new Map(list.map((p, i) => [p, results[i] || null]));
    this._laterUniteRoundEnd(list, results, byPlan);
  }

  /**
   * The plan that carries `ps` as a leaker. In the variant that is the squad plan it belongs to — NOT `unitePlan`,
   * which is the room-wide union and would report the room's total instead of one squad's (the patch's known defect).
   * ≤ MAX_SEATS: `unitePlan`, unchanged.
   */
  _unitePlanFor(ps) {
    const list = this.unitePlans;
    if (Array.isArray(list) && list.length) return list.find((p) => p && p.leakers.includes(ps)) || null;
    return this.unitePlan;
  }

  /** The field that runs `plan` (by index into `unitePlans`/`this.fields`, which are built together). */
  _uniteFieldFor(plan) {
    const list = this.unitePlans;
    if (Array.isArray(list) && list.length) {
      const i = list.indexOf(plan);
      const f = i >= 0 ? this.fields[i] : null;
      if (f) return f;
    }
    return this.fields.find((x) => x && x.kind === 'unite') || null;
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down; a split or a summon raises nothing (a 联防 field tags its runtime spawns
   * `uniteRuntime`, spawns.js — they never crossed the leaker's own goal, so they are neither billed nor shown here).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what the escaped wave sent that leaker (fields.js uniteBillBounds:
   * keySourceCounts only — the same set settlement bills); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防 — and in the variant, of the running squad's 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this._unitePlanFor(ps);
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this._uniteFieldFor(plan);
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        // the sample is [gt, killed, total, resolved(, left)]: a 联防 sample's `left` is its 5th element
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    if (!runner || !runner.fields) return;
    // The variant runs several fields at once (see _uniteTickMany); one field — the single-plan shape, and a
    // single-squad variant round — keeps the pre-existing read below, statement for statement.
    if (Array.isArray(this.unitePlans) && this.unitePlans.length > 1) { this._uniteTickMany(runner); return; }
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }

  /** The variant's tick: the published counts are the ROOM's, summed over every live unite field. */
  _uniteTickMany(runner) {
    if (runner.ticks % 30 !== 0) return;
    let key;
    try {
      const merged = {};
      for (const x of runner.fields) {
        if (!x || !x.battle) continue;
        for (const [pid, n] of Object.entries(uniteLeft(x.battle) || {})) merged[pid] = (merged[pid] || 0) + (Number(n) || 0);
      }
      key = JSON.stringify(merged);
    } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
