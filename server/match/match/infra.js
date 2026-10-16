// server/match/match/infra.js — Match methods: infrastructure — error isolation (guard, reportError), timers tracked
// for dispose (later, cancel, scaled) and the phase deadline (setDeadline), soloUntimed, uids, the player lists
// (alivePlayers, humans), the bonds this match's pool holds (bondInPool, bondLive), a player's boss-round group, deploy
// field and deploy map, and the guarded meta dispatch (dispatch, dispatchItem → effectsMeta.js EffectDispatcher).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { buildDeployMap } from '../board.js';

export class MatchInfra {
  /** Run a callback with error isolation, then flush the views. */
  guard(fn) {
    if (this.disposed) return;
    try { fn(); } catch (e) { this.reportError('guard', e); }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
  }

  reportError(label, e) {
    this.errorCount++;
    const msg = `${label}: ${e && e.message ? e.message : e}`;
    if (this.errors.length < 50) this.errors.push({ label, message: String(e && e.message ? e.message : e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null });
    this.log.error?.(`[match ${this.roomCode}] ${msg}`, e && e.stack ? String(e.stack).split('\n').slice(1, 4).join(' | ') : '');
  }

  /** Schedule a guarded callback (tracked for dispose). */
  later(ms, fn) {
    if (this.disposed) return null;
    let h = null;
    h = this.sched.setTimeout(() => {
      this._timers.delete(h);
      if (this.disposed) return;
      this.guard(fn);
    }, ms);
    if (h) this._timers.add(h);
    return h;
  }

  cancel(h) {
    if (!h) return;
    this.sched.clearTimeout(h);
    this._timers.delete(h);
  }

  scaled(ms) { return Math.max(0, Math.round(ms * this.timerScale)); }

  /**
   * Set the phase deadline (seconds; null/0 ⇒ untimed) and its timeout callback. `silent`: the timer runs but no
   * deadline is published (m.public.deadline 0 ⇒ no countdown) — the fixed presentation steps of a solo match.
   */
  setDeadline(seconds, fn, { silent = false } = {}) {
    this.cancel(this._phaseTimer);
    this._phaseTimer = null;
    if (!(seconds > 0) || typeof fn !== 'function') { this.deadline = 0; return; }
    const ms = this.scaled(seconds * 1000);
    this.deadline = silent ? 0 : this.sched.now() + ms;
    this._phaseTimer = this.later(ms, () => { this._phaseTimer = null; fn(); });
  }

  /**
   * Solo timers (research 01 §843 / 06 §3: 下半 独立模拟 has no time limit on 休整期 / 机变 — "休整期及机变阶段没有时间
   * 限制"; the strategy draft is free too): a solo match publishes a deadline ONLY for its battles. INFO_CHECK waits
   * for 准备就绪 (co-op keeps the official 25 s guard), BAND_DRAFT / SP_DRAFT / PREP are untimed, and the fixed
   * presentation steps (BATTLE_CHECK, ROUND_START, SETTLE) run silently (no countdown). The same holds for any match
   * with a single human (loneHuman: a 同盟 room started alone or with AI teammates only — user playtest #4 item 3):
   * the timers only ever made humans wait on each other; AI seats act at once.
   */
  get soloUntimed() { return this.isSolo || this.loneHuman; }

  /**
   * Is there a seat whose Ready can actually be waited for? A bot readies itself, so it never gates the prep; a
   * departed or disconnected (AI 托管) human is driven like a bot. Only a connected human really has to press Ready.
   *
   * This is the guard against the prep deadlock (百卫补丁 v0.3, docs/PS100-MIGRATION.md §5): `maybeEndPrep` ends
   * the prep as soon as every alive seat is ready (prep.js `allReady`), so a room that has a human able to Ready MUST
   * arm a deadline — with none, that human's silence stalls the match forever. The shape that fired in practice is
   * 「1 个真人 + N 个 AI」 (a 同盟 room started alone / with AI teammates only), which is exactly the room where
   * `soloUntimed` is true while the run is NOT solo.
   *
   * @returns {boolean}
   */
  get hasReadyableHuman() {
    for (const p of this.order) if (!p.isBot && p.alive && !p.left) return true;
    return false;
  }

  /**
   * Does the PREP phase of this match have to be timed? It is UNTIMED when the run is solo (nobody waits on
   * anybody and there is no Ready gate to stall on) or when no seat can press Ready at all (an all-AI room). A co-op
   * room with a seat that can — see `hasReadyableHuman` — is timed.
   *
   * This is the predicate behind the prep deadline (docs/PS100-MIGRATION.md §5); `MatchPrep.enterPrep` and the
   * `attachAudit` prep check read the same rule, and the round's own `prepTime` still decides whether that deadline
   * exists at all (a round the data leaves untimed must stay untimed — its zero-delay ordering is load-bearing).
   * Everything ELSE `soloUntimed` governs: INFO_CHECK, BAND_DRAFT, SP_DRAFT and the silent presentation steps.
   */
  get prepUntimed() { return this.isSolo || !this.hasReadyableHuman; }

  /**
   * Is this THE lone-human co-op room — the only shape whose prep could stall? `soloUntimed` true (so no timer was
   * ever armed) while the run is not solo, i.e. exactly the 「1 个真人 + N 个 AI」 同盟 room. Only such a match may
   * fall back to the official `timers.infoCheck` guard when its round declares no prep timer; every other match keeps
   * the data's own 0 / timer decision byte-for-byte (a room the data leaves untimed stays untimed, which is what
   * `verification-slices.test.js` pins at `timerScale: 0`).
   */
  get prepFallbackGuard() { return !this.isSolo && this.loneHuman; }

  nextUid() { return ++this.uidSeq; }

  alivePlayers() { return this.order.filter((p) => p.alive); }

  /** Whether any chess of a bond is in this match's pool (a 驰援 card of a fully banned bond is never offered). */
  bondInPool(bondId) {
    for (const id of this.pool.entries.keys()) {
      const c = this.gd.chess(id);
      if (c && Array.isArray(c.bonds) && c.bonds.includes(bondId)) return true;
    }
    return false;
  }

  /**
   * Whether a bond can matter in this match: not in the mode's static inactive list (标准: 拉特兰 / 阿戈尔 / 卡西米尔 /
   * 奥术 … never activate, research 02 §2.1) and still with chess in the pool. 机变 tactic cards whose every target bond
   * is dead are not offered (choices.js).
   */
  bondLive(bondId) {
    return !this.gd.modeInactiveBonds.has(bondId) && this.bondInPool(bondId);
  }
  humans() { return this.order.filter((p) => !p.isBot && !p.left); }

  /** [ASSUMED] Touch's initial, match-long team grant survives its holder's elimination/quit; focus alone grants none. */
  teamMedicGranted() { return this.order.some(p => (this.gd.band(p.bandId)?.effectRef ?? p.bandId) === 'band_amedic'); }

  /**
   * The boss-round group of a player (`bossWaves`: the per-match random pairs, planned in startRound
   * before the players' round start) and its side — 'L', or 'R' for the second player of a pair (the mirrored right
   * half) — or null outside a boss round / for a player without a field.
   * @returns {{ wave: object, players: string[], side: 'L'|'R' } | null}
   */
  bossGroupOf(ps) {
    if (!ps || !Array.isArray(this.bossWaves)) return null;
    const g = this.bossWaves.find((x) => Array.isArray(x.players) && x.players.includes(ps.playerId));
    return g ? { wave: g.wave, players: g.players, side: g.players.indexOf(ps.playerId) === 1 ? 'R' : 'L' } : null;
  }

  /**
   * The field a player deploys on (server/match/board.js DEPLOY_FIELDS): in a boss round (最终攻势 / 隐秘核心, from its
   * ROUND_START on — the pairing exists before PlayerState.startRound's recompute) the player's half of the boss field,
   * 'bossL' or 'bossR' (bossGroupOf); otherwise its own normal board. User playtest #5 item 7.
   * @returns {'normal'|'bossL'|'bossR'}
   */
  deployFieldOf(ps) {
    const g = this.bossGroupOf(ps);
    return !g ? 'normal' : g.side === 'R' ? 'bossR' : 'bossL';
  }

  /**
   * A fresh deploy map of a player on `field` (default: the field it deploys on now) under its device / tile overrides.
   * Pure — no PlayerState cache is touched (the read-only checker invariants.js uses it; PlayerState.deployMap caches).
   */
  deployMapFor(ps, field = this.deployFieldOf(ps)) {
    return buildDeployMap(this.stage, { deviceOverrides: ps.deviceOverrides, tileOverrides: ps.tileOverrides, field });
  }

  dispatch(ps, hook, ev = {}, opts = {}) {
    try { return this.dispatcher.dispatch(ps, hook, ev, opts); } catch (e) { this.reportError(`dispatch ${hook}`, e); return ev; }
  }

  dispatchItem(ps, item, holder, hook, ev) {
    try { return this.dispatcher.dispatchItem(ps, item, holder, hook, ev); } catch (e) { this.reportError(`dispatchItem ${hook}`, e); return ev; }
  }
}
