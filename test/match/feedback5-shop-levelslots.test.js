// test/match/feedback5-shop-levelslots.test.js — 升级调度中心只多一个「空位」。
//
// Upstream 0.2.0 (§25.19.2, community report item 19) filled the new slot at once: 「升级商店获得新的商店位时用新卡补上，而不是
// 空着」. The owner reports that as wrong (2026-10-07): 「升级2本会刷新干员池和加入新干员，升级商店等级加槽位应该是只多一个空位
// 而不是直接多一个可购买干员」— an upgrade buys a PLACE for a card, not a card. So `_openLevelSlots` appends empty slots and
// the next roll fills them: a manual 刷新 (rollShop) or the round start's own roll (round.js startRound). The tutorial line
// the upstream change cited (「升级后将出现更多的商品栏位、可调度干员以及新装备」) only promises that more slots appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './harness.js';
import { GameData } from '../../server/match/gamedata.js';

const ids = (slots) => slots.map((s) => (s ? `${s.kind}:${s.id}${s.sold ? '(sold)' : ''}` : null));
const tierOf = (id) => DATA.chess[id]?.tier ?? 0;

test('a level-up opens the new level\'s operator slot EMPTY; the cards shown stay in place', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 7, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  assert.deepEqual(h.m.gd.shopSlots(1), { chess: 3, item: 1 });
  const s1 = ps.shop.slots.slice();
  assert.equal(s1.length, 4);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.levelUp' }), { ok: true });
  // level 2: 4 operator slots + the item slot — the three cards and the item kept (the same objects), the new one EMPTY
  assert.equal(ps.shop.level, 2);
  assert.deepEqual(ps.shop.layout, { chess: 4, item: 1 });
  assert.equal(ps.shop.slots.length, 5);
  for (let i = 0; i < 3; i++) assert.equal(ps.shop.slots[i], s1[i], `operator card ${i} kept`);
  assert.equal(ps.shop.slots[4], s1[3], 'the item card stays after the operator cards');
  assert.equal(ps.shop.slots[3], null, 'the new slot is empty — an upgrade buys a place, not a card');
  // the player sees the empty slot right away (m.private shop)
  assert.deepEqual(ids(ps.privateView().shop.slots), ids(ps.shop.slots));
  // a manual refresh fills it — drawn at the CURRENT level (tier ≤ 2)
  assert.deepEqual(h.m.handle('p_0', { t: 'g.refresh' }), { ok: true });
  const filled = ps.shop.slots[3];
  assert.ok(filled && filled.kind === 'chess' && !filled.sold, `a rolled operator card: ${JSON.stringify(filled)}`);
  assert.ok(tierOf(filled.id) >= 1 && tierOf(filled.id) <= 2, `drawn at the current level (tier ${tierOf(filled.id)})`);
  // 2 → 3 keeps 4 operator slots: nothing rerolled
  const s2 = ps.shop.slots.slice();
  h.m.handle('p_0', { t: 'g.levelUp' });
  assert.equal(ps.shop.level, 3);
  assert.deepEqual(ps.shop.slots, s2, 'no extra slot at level 3, no reroll');
  // 3 → 4: the fifth operator slot, again empty
  h.m.handle('p_0', { t: 'g.levelUp' });
  assert.equal(ps.shop.level, 4);
  assert.deepEqual(ps.shop.layout, { chess: 5, item: 1 });
  for (let i = 0; i < 4; i++) assert.equal(ps.shop.slots[i], s2[i]);
  assert.equal(ps.shop.slots[5], s2[4]);
  assert.equal(ps.shop.slots[4], null, 'the fifth operator slot opens empty too');
  h.invariants();
  h.m.dispose();
});

test('a bought card stays sold; the round start fills the empty slot and keeps the frozen cards in place', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 11, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 200;
  assert.deepEqual(h.m.handle('p_0', { t: 'g.buy', slot: 0 }), { ok: true });
  assert.equal(ps.shop.slots[0].sold, true);
  assert.deepEqual(h.m.handle('p_0', { t: 'g.freeze' }), { ok: true });
  h.m.handle('p_0', { t: 'g.levelUp' });
  assert.equal(ps.shop.slots[0].sold, true, 'the bought slot is not refilled');
  assert.equal(ps.shop.slots[3], null, 'nothing to freeze: an empty slot has no card');
  const keep = ps.shop.slots.filter((s) => s && !s.sold && s.frozen).map((s) => s.id);
  assert.equal(keep.length, 3, 'two operator cards and the item');
  // the next round start keeps every frozen card (in place) and rolls the sold + the empty slot
  h.drive(() => h.m.phase === 'PREP' && h.m.round === 2);
  assert.equal(ps.shop.slots[1].id, keep[0], 'frozen operator card 0 kept in place');
  assert.equal(ps.shop.slots[2].id, keep[1], 'frozen operator card 1 kept in place');
  assert.equal(ps.shop.slots[4].id, keep[2], 'the frozen item stays after the operator slots');
  assert.equal(ps.shop.slots.length, 5);
  assert.ok(ps.shop.slots[3], 'the slot the upgrade opened holds a card again after the round start');
  assert.ok(ps.shop.slots[0], 'and so does the sold one');
  h.invariants();
  h.m.dispose();
});

test('every mode\'s slot table: a level-up adds exactly the slots the new level has more of (标准: 3,4,4,4,4,5)', () => {
  for (const [mode, difficulty] of [['solo', 'FUNNY'], ['solo', 'NORMAL'], ['coop', 'FUNNY'], ['coop', 'ABYSS']]) {
    const h = makeMatch({ mode, difficulty, seed: 3, fake: true, humans: 1, bots: mode === 'coop' ? 1 : 0 }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    const gd = h.m.gd;
    ps.funds = 500;
    for (let lv = 2; lv <= gd.maxShopLevel; lv++) {
      const before = ps.shop.slots.slice();
      const wasChess = gd.shopSlots(lv - 1).chess;
      assert.deepEqual(h.m.handle('p_0', { t: 'g.levelUp' }), { ok: true });
      const { chess, item } = gd.shopSlots(lv);
      assert.equal(ps.shop.slots.length, chess + item, `${mode} ${difficulty} L${lv}`);
      const grew = chess - wasChess;
      const kept = ps.shop.slots.filter((s) => before.includes(s)).length;
      assert.equal(kept, before.length, `${mode} ${difficulty} L${lv}: every shown card kept`);
      assert.equal(ps.shop.slots.length - before.length, grew + (item - gd.shopSlots(lv - 1).item));
      // the added slots are empty, never a free card
      for (let i = wasChess; i < chess; i++) assert.equal(ps.shop.slots[i], null, `${mode} ${difficulty} L${lv}: operator slot ${i} empty`);
      // fill them for the next level's check (a refresh is the player's own roll)
      if (grew) assert.deepEqual(h.m.handle('p_0', { t: 'g.refresh' }), { ok: true });
    }
    h.invariants();
    h.m.dispose();
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((l) => new GameData(DATA, 'mode_single_funny').shopSlots(l).chess), [3, 4, 4, 4, 4, 5]);
});
