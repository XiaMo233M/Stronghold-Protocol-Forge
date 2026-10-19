// server/match/player/economy.js — PlayerState methods: the economy — funds, spending (onSpend), prep-side bond layer
// gains (clamped by layerGainRoom), the shop (onPrice prices, copy-weighted rolls from the shared pool plus the player's
// own 自选 stock — player/diy.js —, freeze) and its intents: g.buy, g.refresh, g.freeze, g.levelUp, g.sell.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR, PHASE, layerGainRoom } from '../../../shared/constants.js';
import { behaviourIsDefault } from '../../../shared/behaviour.js';
import { ruleOption } from '../../../shared/plugins/rules.js';
import { freeSlot } from '../board.js';
import { computeBonds } from '../bondsMeta.js';
import { OK, fail } from './common.js';

/**
 * **行为开关 `shopBias` 的读取点**（DESIGN §28.43.1）：这一局的声明要不要偏向，要偏就给出「偏向哪些盟约」。
 *
 * 返回 `null` = **引擎今天的行为**，也就是两条路：没声明这一格 / 声明成 `official`（缺省档），或声明了
 * `bondBias` 但此刻一个盟约都没激活（空集合 ⇒ 抽出来的商店会变成空的装备槽，那不是「偏向」，是「停发」）。
 * 返回非空 `Set` = 只在「`giveBondId` 落在这个集合里」的装备里抽，**只偏置、不授予**。
 *
 * `behaviourIsDefault` 是这一格唯一的判据来源（`shared/behaviour.js`）：与 `variants` 的 `variantIsDefault`
 * 同一个分工 —— `behaviourActions` 里那条 `{ kind: 'shop.biasActiveBonds', value: true }` 是这一格的**声明**，
 * 读取点问的是「哪一档」。写成模块层的**纯**函数，是为了让它能被单测（`test/shopBias.test.js`）也为了它是
 * `shared/modSurface.js` 里 `behaviour` 那一格可锚的一个导出名（改名 / 挪走 = 打断所有声明这一格的包）。
 *
 * @param {{ m: { behaviour: any }, _activeBondIds: () => Set<string> }} ps
 * @returns {Set<string>|null}
 */
export function bondBiasBonds(ps) {
  if (behaviourIsDefault(ps.m.behaviour, 'shopBias')) return null;
  const active = ps._activeBondIds();
  return active.size ? active : null;
}

export class PlayerEconomy {
  addFunds(n, { reason = '' } = {}) {
    if (!Number.isFinite(n) || n === 0) return 0;
    const v = Math.trunc(n);
    const before = this.funds;
    this.funds = Math.max(0, this.funds + v);
    if (v > 0) this.stats.fundsGained += v;
    this.dirty();
    return this.funds - before;
  }

  spend(n) {
    const v = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    if (v > this.funds) return false;
    this.funds -= v;
    this.stats.gold += v;
    this.round.spent += v;
    this.dirty();
    return true;
  }

  /** onSpend, dispatched once a payment's action is complete (buy / refresh / levelUp / reward / effect). */
  _afterSpend(amount, reason) {
    if (!(amount > 0)) return;
    this.m.dispatch(this, 'onSpend', { amount, reason, total: this.stats.gold });
  }

  /**
   * Bond layer gain (prep-side). `requireActive` = "使已激活的【X】层数+N". Returns layers added: at most the room left
   * under BOND_LAYER_CAP (999, shared/constants.js) — a gain at the cap adds 0 and dispatches nothing.
   */
  addLayers(bondId, n, { requireActive = false, reason = '' } = {}) {
    if (!this.gd.bond(bondId) || !Number.isFinite(n) || n <= 0) return 0;
    if (requireActive && !(this.bonds[bondId] && this.bonds[bondId].active)) return 0;
    const before = this.layers[bondId] || 0;
    const add = layerGainRoom(before, Math.floor(n));
    if (add <= 0) return 0;
    this.layers[bondId] = before + add;
    this.recompute();
    // A live prep gain, not a view delta: reconnects and combat-result backfill must not replay the cue.
    if ([PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP].includes(this.m.phase)) {
      this.m.sendTo(this.playerId, { t: 'm.layer', playerId: this.playerId, bondId, add });
    }
    this.m.dispatch(this, 'onLayers', { bondId, from: before, to: before + add, reason });
    return add;
  }

  /** Effective price of a shop slot after onPrice modifiers (never negative). */
  priceOf(slot) {
    if (!slot) return 0;
    const ev = { slot, kind: slot.kind, id: slot.id, price: slot.basePrice };
    this.m.dispatch(this, 'onPrice', ev, { quiet: true });
    const p = Number(ev.price);
    return Number.isFinite(p) ? Math.max(0, Math.round(p)) : slot.basePrice;
  }

  _rollChessSlot() {
    // the slotted 自选 pieces join the draw once the 调度中心 reaches their slot's level (player/diy.js diyRollEntries);
    // the DRAW SOURCE is the player's own pool in the 100-seat variant and the shared one today (player/rules.js
    // mainPool — the same object either way when the switch is off, docs/PS100-MIGRATION.md §10-A)
    const id = this.mainPool().roll(this.m.rngShop, { maxTier: this.shop.level, extra: this.diyRollEntries() });
    if (!id) return null;
    // 助战：自己带上场的干员在商店里按 `data/support.json` 的 prices 标价（没配就是它的阶级价），
    // 卖掉仍按普通棋子的 sellPrice —— 它就是普通棋子，只是「我的商店池里一定有它」（连本局禁用也盖过去）。
    // 阶级门照旧：六阶助战仍要商店等级 6 才摇得到。
    const support = this.support.includes(id);
    const price = support ? (this.gd.supportPrice(id) ?? this.gd.chessPrice(id)) : this.gd.chessPrice(id);
    return { kind: 'chess', id, basePrice: price, frozen: false, sold: false, ...(support ? { support: true } : {}) };
  }

  /**
   * 这个玩家**已激活**盟约的 id 集合（`recompute` 算出来的 `this.bonds`）—— `shopBias: "bondBias"` 的唯一输入。
   * 缓存按 `this.bonds` 的**对象身份**失效：每一次 `recompute()` 都换一个新对象（`player/round.js`），于是同一个
   * prep 里的多次刷新只付一次遍历，而变化之后一定重算。
   * @returns {Set<string>}
   */
  _activeBondIds() {
    if (this._biasBondsAt === this.bonds && this._biasBonds) return this._biasBonds;
    const out = new Set();
    for (const [id, state] of Object.entries(this.bonds || {})) if (state && state.active) out.add(id);
    this._biasBondsAt = this.bonds;
    this._biasBonds = out;
    return out;
  }

  /**
   * **执行点（`shopBias`）**：这一局的声明要不要偏向，要偏就给出「偏向哪些盟约」。
   *
   * 判据本体是模块层的 `bondBiasBonds`（纯函数，`shared/modSurface.js` 的 `behaviour` 那一格锚着它）；这里只把
   * 这一格的读取点挂到玩家状态上，`_rollItemSlot` 与本文件以外的调用方都走这一个名字。
   * @returns {Set<string>|null}
   */
  shopBiasBonds() {
    return bondBiasBonds(this);
  }

  _rollItemSlot() {
    // 装备槽的盟约偏向（`shopBias: 'bondBias'`），两条来源并存：
    //   ① 上游 0.3.1 的房间规则：内容插件声明 `rules.shopBias = 'bondBias'` ⇒ 按本局**生效盟约**偏。
    //      startRound 在 recompute 之前就抽商店，所以缓存的 this.bonds 可能差一轮 ⇒ 这里现算 computeBonds（不吃 rng）。
    //   ② 我们自有的模块层 behaviour.shopBias（DESIGN §28.43.1）⇒ `shopBiasBonds()` 给出同一个 Set。
    // 两者都产出 Set，`rollItem` 只认 Set；缺省档两者都为 null ⇒ 与从前**同一份结果**、同一条 rng 消耗。
    let bias = null;
    if (ruleOption(this.m?.rules, 'shopBias') === 'bondBias') {
      const bonds = computeBonds(this.gd, this);
      bias = new Set();
      for (const [id, st] of Object.entries(bonds)) if (st && st.active) bias.add(id);
    } else {
      bias = this.shopBiasBonds();
    }
    const id = this.m.pool.rollItem(this.m.rngShop, this.shop.level, this.m.itemPool, bias);
    return id ? { kind: 'item', id, basePrice: this.gd.itemPrice(id), frozen: false, sold: false } : null;
  }

  /**
   * 测试房间排队的下一份商店（`g.test shop`）：替换这一次摇号一次，**不抽 rng**。队列由命令侧校验；
   * 消费之前升级一直被挡（见 levelUp）。防御性回退只处理内部状态被弄坏的情形。
   * [ASSUMED] 队列连冻结位一起替换。普通对局里这个键不存在，所以这里立刻返回 false。
   * @returns {boolean} 队列被应用时为 true
   */
  _consumeTestShop() {
    const queued = this._testShopNext;
    if (this.m.test !== true || !queued) return false;
    this._testShopNext = null;
    const { chess: nChess, item: nItem } = this.gd.shopSlots(this.shop.level);
    const ok = Array.isArray(queued) && queued.length === nChess + nItem && queued.every((s, i) => {
      const kind = i < nChess ? 'chess' : 'item';
      return !!s && s.kind === kind && (kind === 'chess' ? !!this.gd.chess(s.id) : !!this.gd.item(s.id));
    });
    if (!ok) return false;
    const slots = queued.map((s) => ({
      kind: s.kind, id: s.id,
      basePrice: s.kind === 'chess' ? this.gd.chessPrice(s.id) : this.gd.itemPrice(s.id),
      frozen: false, sold: false,
    }));
    this.shop.slots = slots;
    this.shop.layout = { chess: nChess, item: nItem };
    for (const s of slots) if (s) s.frozen = this.shop.frozen;
    this.dirty();
    return true;
  }

  /**
   * Reroll the shop. keepFrozen → frozen unsold slots survive (round start); otherwise everything is rerolled
   * (manual refresh). Slot counts follow the current level.
   */
  rollShop({ keepFrozen = false } = {}) {
    // 测试房间排队的商店（g.test shop）替换这一次摇号，且不抽 rng；升级在它被消费前一直被挡
    if (this._consumeTestShop()) return;
    const { chess: nChess, item: nItem } = this.gd.shopSlots(this.shop.level);
    const old = this.shop.slots;
    const layout = this.shop.layout || { chess: old.length, item: 0 };
    const oldChess = old.slice(0, layout.chess);
    const oldItems = old.slice(layout.chess);
    const keep = (s, kind) => (keepFrozen && s && s.kind === kind && !s.sold && s.frozen ? { ...s } : null);
    // frozen slots keep their position; sold / empty / unfrozen positions are rerolled
    const slots = [];
    for (let i = 0; i < nChess; i++) slots.push(keep(oldChess[i], 'chess') ?? this._rollChessSlot());
    for (let i = 0; i < nItem; i++) slots.push(keep(oldItems[i], 'item') ?? this._rollItemSlot());
    this.shop.slots = slots;
    this.shop.layout = { chess: nChess, item: nItem };
    for (const s of slots) if (s) s.frozen = this.shop.frozen;
    this.dirty();
  }

  /**
   * The 调度中心's upgrade opens the new level's extra slots — as EMPTY slots.
   *
   * The owner's decision of 2026-10-07, report 「升级2本会刷新干员池和加入新干员，升级商店等级加槽位应该是只多一个空位而不是直接多
   * 一个可购买干员」: an upgrade buys a PLACE for a card, not a card. The extra slots appear empty and the next roll fills
   * them — a manual 刷新 (rollShop) or the round start's own roll (round.js startRound).
   *
   * Upstream 0.2.0 drew a card in at once (§25.19.2, community report item 19 「升级商店获得新的商店位时用新卡补上，而不是空着」,
   * citing the tutorial's 「升级：…升级后将出现更多的商品栏位、可调度干员以及新装备」). That hands the player a free card the
   * shop never rolled — from level 2 on, a NEW operator to buy on the spot — which is exactly what the owner reports as
   * wrong; the tutorial line only promises that more slots appear. 0.2.2 reached the same conclusion on its own: the
   * footage of a 1→2 upgrade (bilibili BV1AXwuzdEys 1:39, GitHub #332 / PR #333 by @2321Robin) shows the new slot appear
   * and stay empty, and the texts only name the slots — the tutorial's 休整期 page 「升级后将出现更多的商品栏位」, PRTS 帮助
   * 「增加刷新栏位」 — never a card that comes with them. The cards already shown stay where they are (chess slots keep
   * their index, the item slot stays after them).
   */
  _openLevelSlots() {
    const { chess: nChess, item: nItem } = this.gd.shopSlots(this.shop.level);
    const old = this.shop.slots;
    const layout = this.shop.layout || { chess: old.length, item: 0 };
    if (nChess <= layout.chess && nItem <= layout.item) return;
    const chess = old.slice(0, layout.chess);
    const items = old.slice(layout.chess);
    while (chess.length < nChess) chess.push(null); // loop-cap: shopSlots chess max 8   // empty: the next roll draws into it
    while (items.length < nItem) items.push(null);
    this.shop.slots = [...chess, ...items];
    this.shop.layout = { chess: chess.length, item: items.length };
  }

  /** Combat start: unfrozen slots are emptied (research 01 A1). */
  clearUnfrozenShop() {
    this.shop.slots = this.shop.slots.map((s) => (s && s.frozen && !s.sold ? s : null));
    this.dirty();
  }

  /**
   * g.buy {slot}. A full regular hand refuses every purchase, also one whose copy would complete a merge at once (PRTS
   * 卫戍协议/帮助 §手牌区 "当常规手牌区全满无空位时，玩家将无法执行使手牌溢出的操作" — "例如招募/购入等通常情况下会增加手牌的
   * 操作"; BWIKI 盟约 "当整备区达到上限后将无法进行涉及到整备区的操作（购买、撤回等）"; GitHub #82: the reporter's first-hand
   * check in the official game, "哪怕是已经有了两个相同干员情况"). Until 0.1.3 such a purchase was let through.
   */
  buy(slotIdx) {
    const g = this._gate(); if (g) return g;
    if (!Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= this.shop.slots.length) return fail(ERR.BAD_TARGET);
    const slot = this.shop.slots[slotIdx];
    if (!slot) return fail(ERR.BAD_TARGET);
    if (slot.sold) return fail(ERR.SOLD_OUT);
    const price = this.priceOf(slot);
    if (this.funds < price) return fail(ERR.NO_FUNDS);
    const handFull = freeSlot(this.hand) < 0;
    let piece;
    if (slot.kind === 'chess') {
      const rec = this.gd.chess(slot.id);
      // a DIY slot sells only as this player's own 自选 piece (a slotted slot's record carries `diyFor`)
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET);
      // Already displayed operators stay purchasable after stock runs out (#498; 路标月报#2,
      // BV1eLXXBqEgF 2:50–2:57: nine owned + four shop offers => thirteen owned).
      // acquireChess records every copy, including the deficit; future rolls still exclude empty stock.
      if (handFull) return fail(ERR.HAND_FULL);
      this.spend(price);
      slot.sold = true;
      piece = this.acquireChess(slot.id, { source: 'buy' });
    } else {
      if (!this.gd.item(slot.id)) return fail(ERR.BAD_TARGET);
      // Already displayed equipment stays purchasable after stock runs out (#624, maintainer 2026-10-14).
      // acquireItem records the debt. Future rolls still exclude empty stock. SOLD_OUT is only this slot, already sold.
      if (handFull) return fail(ERR.HAND_FULL);
      this.spend(price);
      slot.sold = true;
      piece = this.acquireItem(slot.id, { source: 'buy', displayed: true });
    }
    this.stats.buys++;
    this.round.buys++;
    this.m.dispatch(this, 'onBuy', { piece, slot, price, kind: slot.kind });
    this._afterSpend(price, 'buy');
    this.recompute();
    return OK;
  }

  refresh() {
    const g = this._gate(); if (g) return g;
    const free = this.shop.freeRefreshes > 0;
    const price = free ? 0 : this.gd.refreshPrice;
    if (!free && this.funds < price) return fail(ERR.NO_FUNDS);
    if (free) this.shop.freeRefreshes--;
    else this.spend(price);
    // A manual refresh cancels the freeze: the new cards are not frozen (official, the owner's play of 2026-10-14;
    // GitHub #584, DESIGN §34.14.7). A refresh that fails (funds, phase) returns above and leaves the freeze on.
    this.shop.frozen = false;
    this.rollShop({ keepFrozen: false });
    this.stats.refreshes++;
    this.round.refreshes++;
    this.m.dispatch(this, 'onRefresh', { slots: this.shop.slots, free, price });
    this._afterSpend(price, 'refresh');
    this.dirty();
    return OK;
  }

  freeze() {
    const g = this._gate(); if (g) return g;
    this.shop.frozen = !this.shop.frozen;
    for (const s of this.shop.slots) if (s && !s.sold) s.frozen = this.shop.frozen;
    this.dirty();
    return OK;
  }

  levelUp() {
    // 测试房间：排队中的商店（`shop` 命令排的那一份）还没被消费时，升级被挡住（上游 0.3.1 §36.8）
    if (this.m.test === true && this._testShopNext) return fail(ERR.WRONG_PHASE);
    const g = this._gate(); if (g) return g;
    if (this.shop.level >= this.gd.maxShopLevel) return fail(ERR.MAX_LEVEL);
    const price = Math.max(0, this.shop.upgradePrice);
    if (this.funds < price) return fail(ERR.NO_FUNDS);
    this.spend(price);
    this.shop.level++;
    this.shop.upgradePrice = this.gd.upgradeBase(this.shop.level) ?? 0;
    this._openLevelSlots();
    this.m.tickerFor('SHOP_LEVEL', [this.name, String(this.shop.level)], { playerId: this.playerId, param: String(this.shop.level) });
    this.m.dispatch(this, 'onLevelUp', { level: this.shop.level, price });
    this._afterSpend(price, 'levelUp');
    this.dirty();
    return OK;
  }

  sell(uid) {
    const g = this._gate(); if (g) return g;
    const loc = this.find(uid);
    if (!loc) return fail(ERR.BAD_TARGET);
    if (loc.piece.kind !== 'chess') return fail(ERR.BAD_TARGET, loc.piece.kind === 'item' ? 'items cannot be sold' : 'tokens cannot be sold');
    const piece = loc.piece;
    // Returned equipment can always wait in the overflow queue, even when all fifteen visible slots are occupied.
    this._detach(loc);
    this.removeTokensOf(piece.uid);
    for (const it of piece.items || []) this.stow(it, { allowTemp: true });
    piece.items = [];
    this.returnCopies(piece);
    const ev = { piece, gain: this.gd.sellPrice(piece.id) };
    this.m.dispatch(this, 'onSold', ev);
    const gain = Number.isFinite(ev.gain) ? Math.max(0, Math.trunc(ev.gain)) : 1;
    this.addFunds(gain, { reason: 'sell' });
    this.stats.sells++;
    this.round.sells++;
    this.checkItemMerges();
    this.recompute();
    return OK;
  }
}
