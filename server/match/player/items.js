// server/match/player/items.js — PlayerState methods: items — g.equip (max 2, a 3rd replaces the one the player picks;
// consume-on-equip items), g.art (Arts on a tile, rotated by the facing) and g.destroy (hand / temp items; equipped
// ones are locked).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR } from '../../../shared/constants.js';
import { behaviourIsDefault } from '../../../shared/behaviour.js';
import { tileKey, inField, parseDir } from '../board.js';
import { offsetTile } from '../../sim/dir.js';
import { itemKey } from '../gamedata.js';
import { OK, fail } from './common.js';

/**
 * **行为开关 `unequip` 的读取点**（DESIGN §28.43.1）：这一局允不允许卸下已装备的装备。
 * 判据只有一份（`shared/behaviour.js` 的 `behaviourIsDefault`）：没声明这一格 / 声明成 `official`（缺省）⇒ `false`
 * = 引擎今天的行为（装上就只能靠精英化 / 合成 / 卖出离开）；`allow` ⇒ `true`。
 *
 * 写成模块层的**纯**函数：一是 `PlayerState.unequip` 只读它、不写死，二是它是 `shared/modSurface.js` 里
 * `behaviour` 那一格可锚的导出名（改名 / 挪走 = 打断所有声明这一格的包）。
 * @param {Array<{ switch: string, option: string }>|null|undefined} decl 本局合成后的行为声明
 * @returns {boolean}
 */
export function unequipAllowed(decl) {
  return !behaviourIsDefault(decl, 'unequip');
}

export class PlayerItems {
  /**
   * g.equip {itemUid, targetUid, replaceUid?}. A third item on a carrier with both slots used replaces the equipped item
   * the player picked in the replace dialog (`replaceUid`, research 09 §1.2 UseEquipUp.unloadInstId; absent ⇒ the
   * oldest); the replaced item is destroyed. A `replaceUid` that is not one of the target's equipped items is refused.
   * A consume-on-equip item replaces the same way before it resolves (GitHub #263): the carrier keeps a free slot, and a
   * target its effect refuses (博士投影 on an elite) gets the picked item back — nothing is destroyed.
   */
  equip(itemUid, targetUid, replaceUid = null) {
    const g = this._gate(); if (g) return g;
    const iloc = this.find(itemUid);
    if (!iloc || iloc.piece.kind !== 'item' || (iloc.area !== 'hand' && iloc.area !== 'temp')) return fail(ERR.BAD_TARGET);
    const rec = this.gd.item(iloc.piece.id);
    if (!rec || rec.itemType !== 'EQUIP') return fail(ERR.BAD_TARGET, 'not equipment');
    const tloc = this.find(targetUid);
    if (!tloc || tloc.piece.kind !== 'chess' || tloc.area === 'equipped') return fail(ERR.BAD_TARGET);
    const item = iloc.piece;
    const target = tloc.piece;
    if (replaceUid != null && !(Number.isInteger(replaceUid) && (target.items || []).some((x) => x.uid === replaceUid))) return fail(ERR.BAD_TARGET, 'replace: not equipped on the target');
    const consume = typeof rec.kind === 'string' && rec.kind.startsWith('consume_on_equip');
    if (consume) {
      const key = 'item:' + itemKey(item.id);
      if (!this.m.registry.has(key)) return fail(ERR.BAD_TARGET, 'effect not available');
      // a full carrier replaces first, consumables included (PRTS 卫戍协议/帮助 "达到上限强行佩戴会改为替换装备：指定一件已佩戴
      // 装备替换为将要佩戴的装备，并销毁被指定的装备"; GitHub #263): the pick (else the oldest) comes off before the effect —
      // which so sees the carrier without it (its bonds) — and is destroyed once the effect went through, leaving the slot
      // free (the normal 博士投影 then takes it: ev.keep, so it no longer pushes the oldest item out). A refusal puts it back.
      const off = this._takeReplaced(target, replaceUid);
      const ev = { item, target, golden: !!rec.isGolden, keep: false, error: null, consumed: true };
      this.m.dispatchItem(this, item, target, 'onEquip', ev);
      if (ev.error) {
        if (off) target.items.splice(Math.min(off.idx, target.items.length), 0, off.piece);
        return fail(ERR[ev.error] ? ev.error : ERR.BAD_TARGET, typeof ev.detail === 'string' ? ev.detail : undefined);
      }
      if (off) this.m.dispatchItem(this, off.piece, target, 'onDestroy', { item: off.piece, holder: target, reason: 'replace' });
      // the handler may have destroyed the target (信标) — resolve the item again
      const again = this.find(item.uid);
      if (again && again.area !== 'equipped') this._detach(again);
      if (ev.keep) {
        const holder = this.find(target.uid);
        if (holder && holder.piece.kind === 'chess') this._attach(holder.piece, item);
      }
      this.stats.itemsEquipped++;
      this.checkItemMerges();
      this.recompute();
      return OK;
    }
    this._detach(iloc);
    if (this.completesItemMerge(item.id)) {
      // an identical normal copy is already owned (equipped somewhere): merge instead of equipping — the golden
      // item goes to the hand (research 04 §2 "copies in hand and on operators both count")
      if (this._mergeItem(item.id, item)) { this.recompute(); return OK; }
      if (!this.find(item.uid)) this.stow(item, { allowTemp: true });
    }
    this._attach(target, item, replaceUid);
    this.stats.itemsEquipped++;
    this.m.dispatchItem(this, item, target, 'onEquip', { item, target, golden: !!rec.isGolden, consumed: false });
    this.checkItemMerges();
    this.recompute();
    return OK;
  }

  /**
   * Attach an item. With both slots used the item `replaceUid` names (the player's pick) is replaced, else the oldest;
   * the replaced item is destroyed.
   */
  _attach(target, item, replaceUid = null) {
    target.items = target.items || [];
    while (target.items.length >= this.gd.equipPerChess) {
      const i = replaceUid != null ? target.items.findIndex((x) => x.uid === replaceUid) : -1;
      const [old] = target.items.splice(i >= 0 ? i : 0, 1);
      replaceUid = null;
      this.m.dispatchItem(this, old, target, 'onDestroy', { item: old, holder: target, reason: 'replace' });
    }
    target.items.push(item);
  }

  /**
   * A consume-on-equip item on a full carrier: take the item `replaceUid` names (else the oldest) off `target` — not yet
   * destroyed — and return { piece, idx } (null while a slot is free).
   */
  _takeReplaced(target, replaceUid = null) {
    target.items = target.items || [];
    if (target.items.length < this.gd.equipPerChess) return null;
    const i = replaceUid != null ? target.items.findIndex((x) => x.uid === replaceUid) : -1;
    const idx = i >= 0 ? i : 0;
    const [piece] = target.items.splice(idx, 1);
    return { piece, idx };
  }

  /** g.art {itemUid, row, col, dir?}: the Art's range grid is rotated by `dir` (absent ⇒ RIGHT). */
  useArt(itemUid, row, col, dir) {
    const g = this._gate(); if (g) return g;
    const d = parseDir(dir);
    if (!d) return fail(ERR.BAD_TARGET, 'bad dir');
    const loc = this.find(itemUid);
    if (!loc || loc.piece.kind !== 'item' || (loc.area !== 'hand' && loc.area !== 'temp')) return fail(ERR.BAD_TARGET);
    const rec = this.gd.item(loc.piece.id);
    if (!rec || rec.itemType !== 'MAGIC') return fail(ERR.BAD_TARGET, 'not an art');
    if (!inField(row, col)) return fail(ERR.BAD_TILE);
    if (this.round.arts >= this.gd.maxArtsPerRound) return fail(ERR.BAD_TARGET, 'art limit');
    const key = 'item:' + itemKey(loc.piece.id);
    if (!this.m.registry.has(key)) return fail(ERR.BAD_TARGET, 'effect not available');
    const grid = Array.isArray(rec.rangeGrid) && rec.rangeGrid.length ? rec.rangeGrid : [[0, 0]];
    const targets = [];
    for (const [dr, dc] of grid) {
      const [tr, tc] = offsetTile(row, col, dr, dc, d);
      const p = this.board.get(tileKey(tr, tc));
      if (p) targets.push(p);
    }
    const ev = { item: loc.piece, row, col, dir: d, targets, error: null, used: true };
    this.m.dispatchItem(this, loc.piece, null, 'onArt', ev);
    if (ev.error) return fail(ERR[ev.error] ? ev.error : ERR.BAD_TARGET, typeof ev.detail === 'string' ? ev.detail : undefined);
    if (ev.used !== false) {
      const again = this.find(itemUid);
      if (again) this._detach(again);
      this.round.arts++;
    }
    this.recompute();
    return OK;
  }

  /**
   * g.destroy {uid}: an item in the hand / temp (Arts included). Equipped items are locked (research 04 §2 / addendum:
   * they leave the operator only on promotion, merge or sale); replacing one is g.equip's `replaceUid`.
   */
  destroy(uid) {
    const g = this._gate(); if (g) return g;
    const loc = this.find(uid);
    if (!loc || loc.piece.kind !== 'item') return fail(ERR.BAD_TARGET, 'only items can be destroyed');
    if (loc.area === 'equipped') return fail(ERR.BAD_TARGET, 'equipped items are locked');
    this._detach(loc);
    this.m.dispatchItem(this, loc.piece, loc.holder || null, 'onDestroy', { item: loc.piece, holder: loc.holder || null, reason: 'player' });
    this.recompute();
    return OK;
  }

  /**
   * g.unequip {itemUid}（行为开关 `unequip: "allow"`，DESIGN §28.43.1）：把一件**已装备**的装备从干员身上取下，
   * 放回手牌（右→左优先），手牌满则进**临时整备区**（`stow`，pieces.js）。
   *
   * **缺省档（`official`）逐字不变**：`unequipAllowed` 为假 ⇒ 回 `destroy` 今天那句
   * `'equipped items are locked'`（`items.js` 的 destroy 用的就是它），于是一个不声明这一格的房间在这条意图上的
   * 行为与从前**一字不差**。
   *
   * **原子性**：`_detach` 之后 `stow` 可能返回 `null`（手牌与临时都满）。那时按**原下标**把它塞回 `holder.items`，
   * 并回 `HAND_FULL` —— 先摘后塞没有回滚的话，装备会**凭空消失**。「没地方放」是一件独立、可处理的事，所以用
   * `HAND_FULL` 而不是 `BAD_TARGET`。
   *
   * **池不变式**：装备只是从**装备位**移到**手牌 / 临时**，`piece` 与 `uid` 都不变 ⇒ `SharedItemPool.held()`
   * （遍历 hand / temp / board，以及 `p.items`）前后都数得到它 ⇒ `held` / `cap` / `left` 全不变，不变式
   * `raw left + Σ held == cap` 一字不动。**没有「归还」这回事**（这与 destroy / sell 不同：那两者才真让池子少一件）。
   *
   * **不发内容钩子**（刻意的第一版决定，DESIGN §28.43.2）：`HOOKS` 那 19 个是契约面（进 `META`），而「卸下」用
   * 哪一个都不贴切（不是 `onDestroy`、不是 `onEquip`），今天也没有任何包需要被通知。将来真有需要，另立一刀并
   * 按 `META` 契约面扩展。
   */
  unequip(itemUid) {
    const g = this._gate(); if (g) return g;
    if (!unequipAllowed(this.m && this.m.behaviour)) return fail(ERR.BAD_TARGET, 'equipped items are locked');
    const loc = this.find(itemUid);
    if (!loc || loc.piece.kind !== 'item' || loc.area !== 'equipped') return fail(ERR.BAD_TARGET, 'not equipped on an operator');
    const holder = loc.holder;
    const idx = holder && Array.isArray(holder.items) ? holder.items.indexOf(loc.piece) : -1;
    const piece = loc.piece;
    this._detach(loc);
    if (!this.stow(piece, { allowTemp: true })) {
      // 没地方放 ⇒ 原子回滚（原下标）并点名。装备不会消失。
      if (holder && Array.isArray(holder.items)) holder.items.splice(idx < 0 ? 0 : Math.min(idx, holder.items.length), 0, piece);
      return fail(ERR.HAND_FULL);
    }
    this.recompute();
    return OK;
  }
}
