// 第 7 段（`morphPairing` 的**装备位语义**那一半，投稿 `19ea65909cf6`）的行为级测试。
//
// 这一条是「缺省逐字节不变」的**行为级**钉法：同一个装备行、同一串操作，`official` 档（不声明 / 声明成 official）
// 与从前逐字相同；`plus` 档才出现「不占位 / 每名干员一件 / 第三件顶掉真正占格的那一件」。
//
// 为什么不在 `test/morphPairing.test.js` 里：那一个文件钉的是**盟约授予**那条判据（三处读取点同判），本文件钉的是
// **槽位**那条判据（服务端四处：`player/items.js` / `player/acquire.js` / `bot.js` / `invariants.js`；客户端两处：
// `ui/detailPanel.js` / `ui/gameLogic/placement.js`）。两半同属一格开关，但读的人不同。
//
// 「缺省逐字节不变」的三条钉法在本刀是这样分工的：**单元级**在 `test/morphPairing.test.js`（缺省输入必须 `===`
// `OFFICIAL_SLOT_POLICY`）、**源码级**在本文件末尾两条（两处客户端读取点不许再写死「2」）、**行为级**在本文件
// 前八条（同一个装备行、同一串操作，官方档与从前逐字相同）。
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseBehaviourDecl } from '../shared/behaviour.js';
import { OFFICIAL_SLOT_POLICY, PLUS_SLOT_POLICY, matchSlotPolicy } from '../shared/morph.js';
import { collectViolations } from '../server/match/invariants.js';
import { makeMatch, DATA } from './match/harness.js';

const SW = 'morphPairing';
const declOf = (option) => parseBehaviourDecl([{ switch: SW, option }]).decl;

const ISO = 'chess_item_6_09_e_a';     // 变形同构体（`canGiveBond`）
const HAMMER = 'chess_item_1_01_e_a';  // 维式重锤 → victoriaShip
const YAN = 'chess_item_3_04_e_a';     // 炎国短刀 → yanShip
const COIN = 'chess_item_1_05_e_a';    // 源石溶剂（普通装备，不带盟约；用来当「第四件」—— 重复同一件会先走合成）
/** 一名自己盟约里既没有 victoriaShip 也没有 yanShip 的低阶干员。 */
const WEARER = 'chess_char_1_01_a';

/** 一局 `solo` 的 PREP，加上可选的 `morphPairing` 档位（`undefined` = 一个包都没声明 ⇒ 缺省路径）。 */
function prep(option = undefined) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, fake: true, seed: 23 }).start();
  h.toPrep(1);
  const m = h.m;
  if (option !== undefined) {
    m.behaviour = declOf(option);
    m.gd.morphPairing = option;
    m.gd.morphSlots = option === 'plus' ? PLUS_SLOT_POLICY : OFFICIAL_SLOT_POLICY;
  }
  return { h, m, ps: h.ps('p_0') };
}

/** 一名手牌里的干员 + 一个「把装备发到手牌再装上」的小工具。 */
function carrier(ps) {
  const p = ps.newPiece('chess', WEARER);
  assert.ok(ps.stow(p, { allowTemp: true }), '手牌有位置');
  return p;
}
function give(m, ps, id) {
  const it = ps.newPiece('item', id);
  assert.ok(ps.stow(it, { allowTemp: true }), '手牌有位置');
  return it.uid;
}
const equip = (m, uid, target, replaceUid = null) => m.handle('p_0', {
  t: 'g.equip', itemUid: uid, targetUid: target.uid, ...(replaceUid == null ? {} : { replaceUid }),
});
const row = (p) => (p.items || []).map((it) => it.id);

test('缺省档：策略就是那个共享的官方单例（行为级 — 一处读点读到的就是它）', () => {
  const { m, ps } = prep();
  assert.equal(matchSlotPolicy(m), OFFICIAL_SLOT_POLICY);
  assert.equal(m.gd.morphSlots, OFFICIAL_SLOT_POLICY);
  assert.equal(m.gd.equipPerChess, 2, '装备位数是官方的，策略不动它');
  const p = carrier(ps);
  assert.deepEqual(row(p), []);
  assert.equal(matchSlotPolicy(m).slotCap(m.gd.equipPerChess), 2);
});

test('缺省档：变形同构体**占一个装备位**（第三件顶掉最旧的那一件，包括它自己）', () => {
  const { m, ps } = prep();
  const p = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, HAMMER), p), { ok: true });
  assert.deepEqual(row(p), [ISO, HAMMER], '两件就满了（它占一位）');
  // 第三件 ⇒ 顶掉最旧的那一件（变形同构体）
  assert.deepEqual(equip(m, give(m, ps, YAN), p), { ok: true });
  assert.deepEqual(row(p), [HAMMER, YAN], '官方档：它自己也会被顶掉');
  assert.deepEqual(collectViolations(m), []);
});

test('`plus` 档：它不占装备位 —— 两件真装备 + 一件变形同构体可以同时在身上', () => {
  const { m, ps } = prep('plus');
  const p = carrier(ps);
  // 先装它自己（那时是空的），再把两个真位填满：它**不占位**，所以第二件真装备也顶不掉它
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, HAMMER), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, YAN), p), { ok: true }, '它不占位 ⇒ 两件真装备都装得上');
  assert.deepEqual(row(p), [ISO, HAMMER, YAN], '三件，但它只占两个位');
  assert.deepEqual(collectViolations(m), [], '不变量按「占几格」判，不按件数');
  assert.equal(m.gd.equipPerChess, 2, '官方那两格一字未动');
});

test('`plus` 档：第三件真装备**永远顶掉真正占格的那一件**，不碰变形同构体', () => {
  const { m, ps } = prep('plus');
  const p = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, HAMMER), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, YAN), p), { ok: true });
  assert.deepEqual(row(p), [ISO, HAMMER, YAN]);
  // 第四件（一件**没带过**的普通装备 —— 同一件重复装备会先走合成，不是这一条要测的路径）：顶掉最旧的那一件
  // **真正占格**的（HAMMER），变形同构体留下。
  assert.deepEqual(equip(m, give(m, ps, COIN), p), { ok: true });
  assert.deepEqual(row(p), [ISO, YAN, COIN], '它留下，被顶掉的是真占格的那一件');
  assert.equal(p.items.some((it) => it.id === HAMMER), false, '被顶掉的那一件确实不在了');
  assert.deepEqual(collectViolations(m), []);
});

test('`plus` 档：点名变形同构体做 `replaceUid` 会被拒（它不是可顶替的对象）', () => {
  const { m, ps } = prep('plus');
  const p = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, HAMMER), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, YAN), p), { ok: true });
  const iso = p.items.find((it) => it.id === ISO);
  const res = equip(m, give(m, ps, COIN), p, iso.uid);
  // 约定：`m.handle` 的拒绝回 `{ error, detail? }`（没有 `ok: false` 这个键 —— 与 `test/match/playtest6-*.test.js` 同一写法）
  assert.equal(res.error, 'BAD_TARGET');
  assert.match(String(res.detail), /slotted item/);
  assert.deepEqual(row(p), [ISO, HAMMER, YAN], '整件事原子拒绝，装备行没动');
});

test('`plus` 档：每名干员**最多一件**变形同构体（第二件当场回 BAD_TARGET）', () => {
  const { m, ps } = prep('plus');
  const p = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  const res = equip(m, give(m, ps, ISO), p);
  assert.equal(res.error, 'BAD_TARGET');
  // 文案与上游 0.3.1 对齐（test/match/rules.test.js 精确钉住这句）：判据是「第二件被拒、行没动」，不是措辞。
  assert.match(String(res.detail), /morph already equipped/);
  assert.deepEqual(row(p), [ISO], '第二件没装上');
  // 而另一名干员照旧可以装一件（判据是**每名干员**，不是每局）
  const q = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), q), { ok: true });
});

test('`plus` 档：点名一件**真占格**的做 `replaceUid` 照旧有效', () => {
  const { m, ps } = prep('plus');
  const p = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, HAMMER), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, YAN), p), { ok: true });
  const hammer = p.items.find((it) => it.id === HAMMER);
  assert.deepEqual(equip(m, give(m, ps, COIN), p, hammer.uid), { ok: true });
  assert.deepEqual(row(p), [ISO, YAN, COIN], '顶掉点名的那一件，变形同构体留下');
  assert.equal(p.items.some((it) => it.id === HAMMER), false, '被点名的那一件确实被顶掉了');
});

test('缺省档：不变量与读取点都不认「槽位豁免」（`plus` 的那两条断言在官方档不成立）', () => {
  // 反向对照：同一条装备行，官方档下第二件变形同构体**装得上**（它会顶掉第一件），而 `plus` 档下被拒。
  // 这一条是「缺省逐字节不变」的行为级证据之一：官方档读到的策略是 `OFFICIAL_SLOT_POLICY`，`isSlotless` 恒假。
  const { m, ps } = prep();
  const p = carrier(ps);
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true });
  assert.deepEqual(equip(m, give(m, ps, ISO), p), { ok: true }, '官方档：两件变形同构体都装得上');
  assert.deepEqual(row(p), [ISO, ISO]);
  assert.deepEqual(collectViolations(m), []);
  assert.equal(OFFICIAL_SLOT_POLICY.isSlotless({ canGiveBond: true }), false);
});

// ---------------------------------------------------------------------------------------------------------------
// 客户端那半（第 7 段）：`roomMods.js` 把档位写进 `bonds.setMorphSlotPolicy`，两处读 `slotPolicy()`。
// 这一条钉的是**契约**：`equipReplaces` 只消费策略（它不自己数件数），而解析器是客户端既有的
// `(id) => data.lookup('items', id)` 形状 —— 第 7 段第一版在这里踩过一次真 bug（判据假设解析器收棋子，
// 客户端收的是 id ⇒ `plus` 档下客户端会把变形同构体当成占位的普通装备）。
test('客户端（第 7 段）：替换对话框的判据两档同判 —— 它只消费 `slotPolicy()`，解析器收 id', async () => {
  const { setMorphSlotPolicy, slotPolicy, equipReplaces } = await import('../public/js/ui/gameLogic.js');
  const getItem = (id) => DATA.items[id] || null;
  /** 一条最小的 ctx：`equipReplaces` / `equipMerges` 只读 `pieces` 与 `getItem`（与客户端那份 `(id) => …` 同形）。 */
  const ctxOf = (itemId) => ({ getItem, pieces: new Map([[1, { piece: { uid: 1, kind: 'item', id: itemId } }]]) });
  const carrier = (ids) => ({ kind: 'chess', id: WEARER, items: ids.map((id, i) => ({ uid: 100 + i, id })) });

  // 缺省（没声明这一格）：策略就是那个共享的官方单例 —— 两格满了才开对话框，变形同构体**占位**
  // 拖进来的那一件用 `COIN`（一件**不在**装备行里的普通装备）：同一件重复装备会先走合成，不是这一条要测的路径。
  setMorphSlotPolicy(null);
  assert.equal(slotPolicy(), OFFICIAL_SLOT_POLICY);
  assert.equal(equipReplaces(ctxOf(COIN), 1, carrier([ISO])), false, '一件 ⇒ 没满');
  assert.equal(equipReplaces(ctxOf(COIN), 1, carrier([ISO, HAMMER])), true, '官方档：两件就满了');
  assert.equal(equipReplaces(ctxOf(COIN), 1, carrier([HAMMER, YAN])), true);

  // `plus`：它不占位 ⇒ 「它 + 一件真装备」**还没满**；两件真装备满了才开对话框，而它自己从不打开
  setMorphSlotPolicy('plus');
  assert.equal(slotPolicy(), PLUS_SLOT_POLICY);
  assert.equal(equipReplaces(ctxOf(COIN), 1, carrier([ISO, HAMMER])), false, '它不占位 ⇒ 还有一格');
  assert.equal(equipReplaces(ctxOf(COIN), 1, carrier([ISO, HAMMER, YAN])), true, '两格真装备满了');
  assert.equal(equipReplaces(ctxOf(ISO), 1, carrier([ISO, HAMMER, YAN])), false, '它自己永远不开替换对话框');

  // 复位：缺省档照旧（这一页的状态是全局的，测试之间不许互相污染）
  setMorphSlotPolicy(null);
  assert.equal(slotPolicy(), OFFICIAL_SLOT_POLICY);
});

test('客户端（第 7 段）：两处读取点的源码级断言 —— 都不许再自己写死「2」', () => {
  const detail = readFileSync(new URL('../public/js/ui/detailPanel.js', import.meta.url), 'utf8');
  assert.match(detail, /slotPolicy\(\)/, '详情卡的 `EQUIP n/2` 与标签必须读这一页的策略');
  assert.match(detail, /slot\.slotsUsed\(/, '分子必须是「占了几格」而不是件数');
  assert.match(detail, /slot\.slotCap\(/, '分母必须是真正占格的上限');
  assert.equal(/EQUIP \$\{items\.length\}\/2/.test(detail), false, '旧的写死分子必须消失');
  const place = readFileSync(new URL('../public/js/ui/gameLogic/placement.js', import.meta.url), 'utf8');
  assert.match(place, /slotPolicy\(\)/, '`equipReplaces` 必须读这一页的策略');
  assert.equal(/targetPiece\.items\.length < 2/.test(place), false, '旧的写死判据必须消失');
  // `roomMods.js` 是那个投影点（与 `setMorphPairing` 同一处）
  const mods = readFileSync(new URL('../public/js/roomMods.js', import.meta.url), 'utf8');
  assert.match(mods, /setMorphSlotPolicy\(behaviourValue\(decl, 'morphPairing'\)\)/);
});

test('`plus` 档：带 AI 队友跑几轮不变量不炸（bot 的选人 / 选装备路径也读同一份策略）', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, fake: true, seed: 41 }).start();
  h.toPrep(1);
  const m = h.m;
  m.behaviour = declOf('plus');
  m.gd.morphPairing = 'plus';
  m.gd.morphSlots = PLUS_SLOT_POLICY;
  h.run(() => m.round >= 3 || h.ended != null, { maxSteps: 2e6 });
  assert.ok(m.round >= 2, `跑到了 R${m.round}`);
  assert.deepEqual(collectViolations(m), [], 'AI 队友的装备行也必须守住这一局的不变量');
  m.dispose();
});
