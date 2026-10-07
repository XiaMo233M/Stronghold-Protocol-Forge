import { t } from '../../../shared/i18n.js';
// 助战 (support operators) — the remake extension the match carries on top of upstream 0.2.0's player split.
//
// The pool belongs to the INSTALL (data/support.json → Gamedata.support, shared/support.js), never to a pack: a pack
// may only declare which of its OWN operators should enter the pool (shared/workshop.js workshopSupportEntries).
// Nothing is handed out here — the operators a player brings sit in the SHARED pool with one extra copy each
// (Match.supportSupply), so they can be rolled and bought at their tier price like any other piece; the one thing a
// support copy does is survive this match's random bans (invariants.js checks that exception, PlayerState._rollChessSlot
// prices it, privateView marks it).
//
// Mixed into PlayerState (server/match/PlayerState.js); methods here must not collide with another player/* module.

export class PlayerSupport {
  /**
   * Replace the 助战 selection (shared/support.js) after re-checking it against this match's SERVER pool. Accepts the
   * checked array or a raw `room.support` selection. Returns false (selection unchanged) when the pool does not allow it
   * — the pool is the authority, so a selection the server has since switched off is dropped rather than honoured. Bots
   * never carry supports.
   * @param {any} entries
   * @returns {boolean}
   */
  setSupport(entries) {
    if (this.isBot) return false;
    const res = this.gd.checkSupport(Array.isArray(entries) ? entries : null);
    if (!res || !res.ok) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] support of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    this.support = Object.freeze([...res.entries]);
    return true;
  }

  /**
   * Record what this player's 助战 selection really gets in this match (remake extension; Match.startRound calls it once,
   * at round 1). **Nothing is handed out**: the operators a player brings are in the SHARED POOL (Match.supportSupply
   * gives each one an extra copy, even when the random bans removed it), so they can be rolled and bought in the shop at
   * their tier price and sold like any other piece — the owner's call 2026-10-07. `supportGranted` therefore means
   * 「本局商店里真的能买到这些」, which is what `m.private` echoes back so the client can explain a selection that the
   * server dropped.
   *
   * The pool is re-checked here because data/support.json may have changed between the lobby's check and the match's
   * start: an operator the server no longer allows is skipped with a warning.
   * @returns {string[]} the ids the shop really has for this player
   */
  prepareSupports() {
    if (this.isBot || !Array.isArray(this.support) || this.support.length === 0) { this.supportGranted = []; return []; }
    const granted = [];
    for (const id of this.support) {
      if (!this.gd.isSupportChess(id)) {
        const rec = this.gd.chess(id);
        this.m.toast(this, 'warn', t('{0} 已不在服务端助战卡池中，本次禁用', { 0: (rec && rec.name) || id }));
        continue;
      }
      granted.push(id);
    }
    this.supportGranted = granted;
    return granted;
  }
}
