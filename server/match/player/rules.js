// server/match/player/rules.js — PlayerState methods: the 100-seat variant (design-level item A of 百卫补丁 v0.3,
// docs/PS100-MIGRATION.md §10-A). ONE module, ONE switch, one code path per mode.
//
//   * INDEPENDENT POOL — the 100-seat rule. Upstream keeps ONE pool for the whole room: tier 6 ships 5 copies per base
//     chess and an elite merge eats 3, so a 100-seat room would see nearly every tier-5/6 slot SOLD_OUT (the patch
//     author measured 16/100 seats surviving). In this variant every player draws its shop from a pool of its own that
//     holds the FULL original copy count of every non-banned base chess (config.economy.poolCopies). `m.pool` stays the
//     match's canonical catalog — its `entries` / `has` / `cap` are the authoritative id set and copy ceilings, and
//     audit.js / invariants.js / platform.js keep reading them — but no copies are ever taken from it in this variant.
//
//   * THE SWITCH is 「MORE THAN THE OFFICIAL 4 PARTICIPANTS」 (`Match.variant`, computed once at construction from the
//     seat list — 闸门读的是在场参与者数，不是房间容量 —— 容量 20 只坐 4 人走原路径). It is read in exactly ONE place per
//     concern: `poolOf()` for copy accounting (below) and `mainPool()` for draws. With the switch OFF both return the
//     very same `this.m.pool` object the code returned before this file existed — not "new code with the same result",
//     but the same expression on the same object (docs/PS100-MIGRATION.md §10-A: 「关掉落回同一个 m.pool 对象」).
//     `PlayerRules` itself is installed unconditionally on the method chain (last), exactly as the patch does: it is
//     only ever *reached* when the switch is on.
//
//   * SQUAD — the 25-squad structure (shared with design-level item C, server/match/unite100.mjs): seats are grouped in
//     fours in seat order, so 100 seats are 25 squads. The rule layer groups by squad when 联防 runs (队内兜底 first,
//     then the cross-squad hand-off). The topology BETWEEN squads is deliberately not decided here: this module only
//     answers membership.
//
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { SharedPool } from '../pool.js';
import { squadIndexOf, squadPeersOf } from '../unite100.mjs';

export class PlayerRules {
  /**
   * Whether this match runs the 100-seat variant — MORE THAN THE OFFICIAL 4 PARTICIPANTS. The single switch behind the
   * independent pools (design-level A); the per-squad 联防 shape (design-level C) reads the same value through
   * `planUnite` (server/match/unite.js).
   *
   * 闸门读的是在场参与者数，不是房间容量 —— 容量 20 只坐 4 人走原路径 (业主裁令 2026-10-12). The value is computed
   * once by the Match constructor (`m.variant`) from the seat list it was handed, so it cannot flip mid-match.
   * @returns {boolean}
   */
  variantOn() { return this.m.variant === true; }

  /**
   * This player's own pool — the full original copy count of every non-banned base chess, built from the MATCH's
   * canonical catalog. Built lazily and kept for the match: taking copies from it must never leak into `m.pool`.
   * `support` is mirrored from the match's own pool so an operator this room brought as 助战 stays purchasable here too
   * (shared/support.js: banning a shop roll must not disable a support) — dropping it would delete a feature in the
   * variant.
   * @returns {SharedPool}
   */
  pool() {
    if (!this._ownPool) {
      this._ownPool = new SharedPool(this.m.gd, { banned: this.m.bannedChess || [], support: this.m.supportSupply || [] });
    }
    return this._ownPool;
  }

  /**
   * The pool this player's DRAWS read (shop rolls, choice rolls, effect grants): its own in the variant, the shared one
   * today. Returns the identical object (`m.pool`) when the switch is off, so every caller stays byte-for-byte the old
   * statement.
   * @returns {SharedPool}
   */
  mainPool() { return this.variantOn() ? this.pool() : this.m.pool; }

  /**
   * The copy accounting of base chess `baseId` for this player — the UNIQUE dispatch point (docs/PS100-MIGRATION.md
   * §10-A). A slotted 自选 slot goes to this player's own 自选 stock in BOTH modes (0.2.0, player/diy.js: that stock is
   * per player already, and a slotted slot is in no pool's `entries`); everything else goes to this player's own pool
   * in the variant and to the shared pool today. buy / sell / merge / promotion / temp / elimination all call this
   * rather than `m.pool`, so they agree by construction.
   * @param {string} baseId
   * @returns {SharedPool|import('./diy.js').DiyStock}
   */
  poolOf(baseId) {
    if (this.diyStock && this.diyStock.has(baseId)) return this.diyStock;
    return this.variantOn() ? this.pool() : this.m.pool;
  }

  /** This player's squad index (0..24 at 100 seats); -1 when the seat is out of range. */
  squad() { return squadIndexOf(this.seat); }

  /** The player states of this player's squad, in seat order (its own seat included while it is seated). */
  squadPeers() { return squadPeersOf(this.m, this.seat); }

  /** Whether `other` (a seat number or a player state) is in this player's squad. */
  inSameSquad(other) {
    const seat = typeof other === 'number' ? other : other && other.seat;
    return Number.isInteger(seat) && squadIndexOf(seat) > -1 && squadIndexOf(seat) === this.squad();
  }
}
