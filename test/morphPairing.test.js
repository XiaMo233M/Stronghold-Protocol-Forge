// 行为开关 `morphPairing`（DESIGN §28.43.1，投稿 `19ea65909cf6`「变形同构体加强」）。
//
// 投稿把它做成了**安装器**：它的 `files.json.copy` 整份覆盖 `shared/morph.js` 与**三处读取点**
// （`server/match/bondsMeta.js` · `server/sim/content/support/index.js` · `public/js/ui/gameLogic/bonds.js`）。
// 本刀把那三处各自写的一份循环收成**一个纯函数**（`shared/morph.js` 的 `grantedBondsByMorph`），三处都调它 ——
// 三处各写一份正是这条规则历史上最容易分叉的地方（一份改了、另两份没改，卡片与服务端计数就打架）。
//
// 两档：
//   * `official`（缺省，**引擎今天的行为**）：变形同构体**占一个装备位**（少于两件装备就不配对），并与**每一件**
//     `giveBondId` 装备配对（全部授予）。
//   * `plus`（投稿那一套）：**不占装备位**（一件也能配对）、只取装备行里**最左边**能授予盟约的那一件。
//
// **第 7 段把槽位那半也补上了**（第三格落地时它被如实记成「未做」）：`plus` 档下变形同构体**不占装备位**、每名
// 干员**最多一件**、第三件装备**永远顶掉真正占格的那一件**。判据收在 `shared/morph.js` 的 `morphSlotPolicy`：
// `official` ⇒ `OFFICIAL_SLOT_POLICY`（**共享的冻结单例**，每一个方法都逐字是引擎今天那条算术），`plus` ⇒
// `PLUS_SLOT_POLICY`。四处服务端读取点（`player/items.js` · `player/acquire.js` · `bot.js` · `invariants.js`）与
// 两处客户端读取点（`ui/detailPanel.js` 的 `EQUIP n/2` 与标签 · `ui/gameLogic/placement.js` 的替换对话框）都走它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEHAVIOUR_SWITCHES, parseBehaviourDecl, behaviourActions, behaviourIsDefault, behaviourValue } from '../shared/behaviour.js';
import {
  MORPH_PAIRING_OPTIONS, isMorphCarrier, grantsBond, morphPairingOf, grantedBondsByMorph, morphCarrierIndexes,
  morphSlotPolicy, matchSlotPolicy, equipSlotsUsed, OFFICIAL_SLOT_POLICY, PLUS_SLOT_POLICY,
} from '../shared/morph.js';
import { pieceBonds } from '../server/match/bondsMeta.js';
import { unitBonds, withMorphPairing } from '../server/sim/content/support/index.js';
import { makeMatch, DATA } from './match/harness.js';
import { makeBattle, chessRec } from './helpers/battleHarness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = 'morphPairing';
const declOf = (option) => parseBehaviourDecl([{ switch: SW, option }]).decl;

const ISO = 'chess_item_6_09_e_a';       // 变形同构体（`canGiveBond`）
const HAMMER = 'chess_item_1_01_e_a';    // 维式重锤 → victoriaShip
const YAN = 'chess_item_3_04_e_a';       // → yanShip
const rec = (id) => DATA.items[id];

/** 一名**自己的盟约**里既没有 victoriaShip 也没有 yanShip 的低阶干员（授来的盟约一眼看得出来）。 */
const WEARER = Object.values(DATA.chess)
  .find((c) => c.visible && !c.isGolden && c.tier <= 2 && !c.bonds.includes('victoriaShip') && !c.bonds.includes('yanShip') && !c.bonds.includes('maniShip')).chessId;

// ---------------------------------------------------------------------------------------------------------------
test('真表里的那一格：形状、两档、缺省是引擎今天的行为', () => {
  const spec = BEHAVIOUR_SWITCHES[SW];
  assert.ok(spec, `真表里必须有这一格：${SW}`);
  assert.deepEqual([...spec.options], ['official', 'plus']);
  assert.equal(spec.default, 'official');
  assert.equal(behaviourIsDefault(null, SW), true, '没声明 = 今天的行为');
  for (const option of spec.options) {
    const decl = parseBehaviourDecl([{ switch: SW, option }]).decl;
    assert.equal(behaviourValue(decl, SW), option);
    assert.equal(behaviourIsDefault(decl, SW), option === 'official');
  }
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'official' }]).decl), { ok: true, actions: [] });
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'plus' }]).decl),
    { ok: true, actions: [{ kind: 'morph.pairingPlus', value: true }] });
});

test('`morphPairingOf`：声明数组 / 字符串 / 不认识的档位 ⇒ 缺省都是 `official`（引擎今天的行为）', () => {
  assert.deepEqual([...MORPH_PAIRING_OPTIONS], ['official', 'plus']);
  assert.equal(morphPairingOf(null), 'official');
  assert.equal(morphPairingOf([]), 'official');
  assert.equal(morphPairingOf('plus'), 'plus');
  assert.equal(morphPairingOf('official'), 'official');
  assert.equal(morphPairingOf('nope'), 'official', '不认识的档位不许变成第三种行为');
  assert.equal(morphPairingOf(declOf('plus')), 'plus');
  assert.equal(morphPairingOf(declOf('official')), 'official');
  assert.equal(morphPairingOf([{ switch: 'shopBias', option: 'bondBias' }]), 'official', '别的格不影响这一格');
});

test('判据本体：`official` 占位 + 全部授予；`plus` 不占位 + 只取最左边那一件', () => {
  const official = (ids) => grantedBondsByMorph(ids.map(rec));
  const plus = (ids) => grantedBondsByMorph(ids.map(rec), { morphed: 'plus' });
  // 官方：少于两件 ⇒ 什么都不授予（它占一个装备位）
  assert.deepEqual(official([ISO]), []);
  assert.deepEqual(official([HAMMER]), []);
  assert.deepEqual(official([]), []);
  // 官方：两件以上且身上有变形同构体 ⇒ 每一件 giveBondId 都授予（按装备行顺序）
  assert.deepEqual(official([YAN, HAMMER, ISO]), ['yanShip', 'victoriaShip']);
  assert.deepEqual(official([HAMMER, YAN, ISO]), ['victoriaShip', 'yanShip']);
  assert.deepEqual(official([ISO, YAN]), ['yanShip']);
  assert.deepEqual(official([ISO, ISO]), [], '两件变形同构体没有配对的另一半');
  // plus：一件就够（它不占装备位），只取最左边那一件
  assert.deepEqual(plus([ISO, HAMMER]), ['victoriaShip']);
  assert.deepEqual(plus([ISO, YAN, HAMMER]), ['yanShip'], '最左边那一件说了算');
  assert.deepEqual(plus([YAN, HAMMER, ISO]), ['yanShip']);
  assert.deepEqual(plus([ISO]), [], '只有它自己：没有可配对的另一半');
  assert.deepEqual(plus([HAMMER, YAN]), [], '身上没有变形同构体 ⇒ 装备之间不互相配对');
  // 数据谓词：给 `hasBond` 时数据里不存在的盟约 id 被挡掉
  assert.deepEqual(grantedBondsByMorph([YAN, ISO].map(rec), { hasBond: () => false }), []);
  assert.deepEqual(grantedBondsByMorph([YAN, ISO].map(rec), { hasBond: (id) => id === 'yanShip' }), ['yanShip']);
  // 两个小工具与上面同源
  assert.equal(isMorphCarrier(rec(ISO)), true);
  assert.equal(isMorphCarrier(rec(HAMMER)), false);
  assert.equal(grantsBond(rec(HAMMER)), true);
  assert.equal(grantsBond(rec(ISO)), false, '变形同构体自己不授予盟约');
  assert.deepEqual(morphCarrierIndexes([YAN, ISO].map(rec)), [1]);
});

// ---------------------------------------------------------------------------------------------------------------
test('读取点 1（prep / `bondsMeta.pieceBonds`）：两档给出不同的盟约集合，缺省档与从前一字不差', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, fake: true, seed: 31 }).start();
  h.toPrep(1);
  const gd = h.m.gd;
  const piece = (ids) => ({ id: WEARER, items: ids.map((id) => ({ id })) });
  const own = DATA.chess[WEARER].bonds.slice();

  // 缺省（没声明）：与从前那份 `items.length >= 2` + 全部授予逐字相同
  assert.deepEqual(pieceBonds(gd, piece([YAN, HAMMER, ISO])).slice(own.length), ['yanShip', 'victoriaShip']);
  assert.deepEqual(pieceBonds(gd, piece([ISO])), own, '一件装备 ⇒ 不配对');
  // 声明 `official` 与没声明一致
  gd.morphPairing = morphPairingOf(declOf('official'));
  assert.deepEqual(pieceBonds(gd, piece([YAN, HAMMER, ISO])).slice(own.length), ['yanShip', 'victoriaShip']);
  // `plus`：只取最左边那一件
  gd.morphPairing = morphPairingOf(declOf('plus'));
  assert.deepEqual(pieceBonds(gd, piece([YAN, HAMMER, ISO])).slice(own.length), ['yanShip']);
  assert.deepEqual(pieceBonds(gd, piece([HAMMER, YAN, ISO])).slice(own.length), ['victoriaShip']);
  assert.deepEqual(pieceBonds(gd, piece([ISO])), own, '只有它自己 ⇒ 没有可配对的另一半');
});

test('读取点 2（战斗 / `support.unitBonds`）：档位由 `withMorphPairing` 的作用域给，缓存按档位失效', () => {
  const unitOf = (ids) => {
    const h = makeBattle({
      defs: { chess: { t_op: chessRec({ id: 't_op', profession: 'WARRIOR', bonds: [], tier: 1 }) }, enemies: {} },
      units: [{ chessId: 't_op', row: 10, col: 4 }],
      timeLimit: 10, autoFinish: false,
    });
    const u = h.unit('t_op');
    u.items = ids.map((id) => id); // the sim reads the ids off the unit (itemsOf)
    return u;
  };
  // 同一个 unit 对象上先官方后加强：缓存必须按档位失效（否则第二次读到的是第一次的结论）
  const u = unitOf([HAMMER, YAN, ISO]);
  assert.deepEqual([...unitBonds(u)].slice(-2), ['victoriaShip', 'yanShip'], '缺省 = 官方读数');
  assert.deepEqual([...withMorphPairing('plus', () => unitBonds(u))].slice(-1), ['victoriaShip'], '加强：只取最左边');
  assert.deepEqual([...unitBonds(u)].slice(-2), ['victoriaShip', 'yanShip'], '弹掉作用域后又回到官方读数');
  // 另一名干员：加强档下只取最左边那一件（`[YAN, HAMMER, ISO]` ⇒ 炎）
  const u2 = unitOf([YAN, HAMMER, ISO]);
  assert.deepEqual([...withMorphPairing('plus', () => unitBonds(u2))].slice(-1), ['yanShip']);
});

test('三个读取点**同判**：同一份装备行、同一个档位，三处给出同一组盟约', async () => {
  const { grantedBonds, setMorphPairing } = await import('../public/js/ui/gameLogic.js');
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, fake: true, seed: 31 }).start();
  h.toPrep(1);
  const gd = h.m.gd;
  const rows = [[YAN, HAMMER, ISO], [HAMMER, YAN, ISO], [ISO], [ISO, YAN], [HAMMER, YAN]];
  const getItem = (id) => DATA.items[id] || null;
  for (const option of ['official', 'plus']) {
    gd.morphPairing = morphPairingOf(declOf(option));
    setMorphPairing(option);
    for (const row of rows) {
      const prep = pieceBonds(gd, { id: WEARER, items: row.map((id) => ({ id })) }).filter((b) => !DATA.chess[WEARER].bonds.includes(b));
      const client = grantedBonds(row, getItem);
      assert.deepEqual(client, prep, `${option} ${row.join('+')}：客户端与 prep 侧必须同判`);
      const battle = withMorphPairing(option, () => grantedBondsByMorph(row.map(getItem), { morphed: option, hasBond: (id) => !!DATA.bonds[id] }));
      assert.deepEqual(battle, prep, `${option} ${row.join('+')}：战斗侧与 prep 侧必须同判`);
    }
  }
  setMorphPairing(null);
  assert.deepEqual(grantedBonds([YAN, HAMMER, ISO], getItem), ['yanShip', 'victoriaShip'], '复位后缺省档照旧');
});

test('三个读取点**共用同一个判据**：源码级断言（三处都不许再各写一份循环）', () => {
  // 这一条钉的是本刀真正的价值：规则只有一份。三处若是各写一份 `for … canGiveBond … giveBondId`，
  // 下一次改档位时漏掉一处就是「卡片与服务端计数打架」。
  // §28.49（`trait.grantsBonds`）之后这条判据**收紧了一格**：成员资格的**合并**也收进了同一个文件
  // （`shared/morph.js` 的 `memberBonds`，它内部调 `grantedBondsByMorph`），所以三处读取点现在锚的是
  // `memberBonds`。断言换了个名字，钉的是同一件事，而且比从前更严：三处连「合并」都不许自己写。
  const files = ['server/match/bondsMeta.js', 'server/sim/content/support/index.js', 'public/js/ui/gameLogic/bonds.js'];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /memberBonds/, `${rel} 必须调那一份共用的成员资格出口`);
    assert.equal(/r\.canGiveBond\s*\)\s*\{\s*for|some\(\(r\)\s*=>\s*r\.canGiveBond\)/.test(src), false,
      `${rel} 不许再留着那份自己写的配对循环`);
  }
  // 判据本体只在一个文件里
  const morph = readFileSync(join(ROOT, 'shared/morph.js'), 'utf8');
  assert.match(morph, /export function grantedBondsByMorph/);
  assert.match(morph, /export function grantedBondsByTrait/, '特质那条腿的判据也在同一个文件里');
  assert.match(morph, /export function memberBonds/, '成员资格的合并本体');
});

test('装备位语义（第 7 段）：缺省档走**共享的官方策略单例**，那一档的每一个方法都是引擎今天那条算术', () => {
  // 三条「缺省逐字节不变」的钉法之一（**单元级**）：`morphSlotPolicy` 在缺省 / `official` / 不认识的档位下
  // **必须**返回 `OFFICIAL_SLOT_POLICY` 这个对象本身（`===`），而它的每一个方法都逐字是引擎今天那条算术 ——
  // 所以缺省路径上「同一批数字、同一次比较、同一个 splice 下标」不是一句承诺，是一条断言。
  for (const decl of [null, undefined, [], declOf('official'), 'official', 'nope', [{ switch: 'shopBias', option: 'bondBias' }]]) {
    assert.equal(morphSlotPolicy(decl), OFFICIAL_SLOT_POLICY, `${JSON.stringify(decl)} ⇒ 官方策略单例`);
    assert.equal(matchSlotPolicy(null), OFFICIAL_SLOT_POLICY);
    assert.equal(matchSlotPolicy({}), OFFICIAL_SLOT_POLICY);
    assert.equal(matchSlotPolicy({ behaviour: decl }), OFFICIAL_SLOT_POLICY);
  }
  assert.equal(matchSlotPolicy({ behaviour: declOf('plus') }), PLUS_SLOT_POLICY);
  assert.equal(morphSlotPolicy('plus'), PLUS_SLOT_POLICY);
  assert.ok(Object.isFrozen(OFFICIAL_SLOT_POLICY) && Object.isFrozen(PLUS_SLOT_POLICY), '两个策略都是冻结单例');
  assert.equal(OFFICIAL_SLOT_POLICY.active, false);
  assert.equal(PLUS_SLOT_POLICY.active, true);
  // 官方策略：`slotsUsed` = 件数、`slotCap` = 装备位数、`isSlotless` 恒假、`replacedIndex` = 今天那个「找不到 ⇒ 0」
  const row = [{ uid: 7, id: ISO }, { uid: 8, id: HAMMER }, { uid: 9, id: YAN }];
  assert.equal(OFFICIAL_SLOT_POLICY.isSlotless(rec(ISO)), false, '官方档：变形同构体是普通装备，占一个位');
  assert.equal(OFFICIAL_SLOT_POLICY.slotsUsed(row), 3);
  assert.equal(OFFICIAL_SLOT_POLICY.slotsUsed([]), 0);
  assert.equal(OFFICIAL_SLOT_POLICY.slotCap(2), 2);
  assert.equal(OFFICIAL_SLOT_POLICY.maxItems(2), 2, '官方档：一行最多两件');
  assert.equal(OFFICIAL_SLOT_POLICY.canHold([], null, 2), true);
  assert.equal(OFFICIAL_SLOT_POLICY.canHold(row, null, 2), false);
  assert.equal(OFFICIAL_SLOT_POLICY.replacedIndex(row, 8), 1, '点名的那一件');
  assert.equal(OFFICIAL_SLOT_POLICY.replacedIndex(row, null), 0, '没点名 ⇒ 最旧的那一件');
  assert.equal(OFFICIAL_SLOT_POLICY.replacedIndex(row, 999), 0, '点名一个不在身上的 uid ⇒ 最旧的那一件');
  // 加强策略：变形同构体不占位、上限 +1、它自己永远不是被顶掉的那一件
  // `getItem` 的契约（`MorphSlotPolicy` 的一格）：收**一件棋子**（`{ id }`）或一个 id 字符串，回 items 记录。
  const getItem = (id) => rec(id);
  const P3 = [ISO, HAMMER, YAN].map((id) => ({ id }));
  const P2 = [ISO, HAMMER].map((id) => ({ id }));
  assert.equal(PLUS_SLOT_POLICY.isSlotless(rec(ISO)), true);
  assert.equal(PLUS_SLOT_POLICY.isSlotless(rec(HAMMER)), false);
  assert.equal(PLUS_SLOT_POLICY.slotsUsed(P3, getItem), 2);
  assert.equal(PLUS_SLOT_POLICY.slotCap(2), 2);
  assert.equal(PLUS_SLOT_POLICY.maxItems(2), 3, '加强档：两格 + 一件不占位的');
  assert.equal(PLUS_SLOT_POLICY.canHold(P3, rec(HAMMER), 2, getItem), false, '两格满了');
  assert.equal(PLUS_SLOT_POLICY.canHold(P2, rec(YAN), 2, getItem), true, '变形同构体不占位');
  assert.equal(PLUS_SLOT_POLICY.canHold(P3, rec(ISO), 2, getItem), false, '每名干员最多一件');
  assert.equal(PLUS_SLOT_POLICY.replacedIndex(P3, null, getItem), 1, '跳过它自己');
  assert.equal(PLUS_SLOT_POLICY.replacedIndex(P3, 9, getItem), 1, '点名它自己 ⇒ 落到真正占格的那一件');
});

test('装备位语义（第 7 段）：`equipSlotsUsed` 是同一份判据的裸入口（缺省档 = 件数）', () => {
  const row = [{ id: ISO }, { id: HAMMER }, { id: YAN }];
  const getItem = (id) => rec(id);
  assert.equal(equipSlotsUsed(row, getItem), 3, '缺省 ⇒ 官方读数');
  assert.equal(equipSlotsUsed(row, getItem, { morphed: 'plus' }), 2, '加强 ⇒ 变形同构体不计数');
  assert.equal(equipSlotsUsed([], null), 0);
});

test('槽位那半**已经做了**：effect 必须写明它动了装备位，四处读取点都读这一局的策略', () => {
  // 这一条是上一版的**反面**：第三格落地时这里钉的是「effect 不许声称改了槽位语义」。第 7 段把那一半做完了，
  // 所以现在钉的是相反的方向 —— 它**必须**说清楚 `plus` 档动了槽位，而不是继续假装没做。
  const effect = Object.values(BEHAVIOUR_SWITCHES[SW].effect).join(' ');
  assert.match(effect, /slot/i, 'plus 档的 effect 必须写明它改了装备位语义');
  assert.equal(/NOT implemented in this build/.test(effect), false, '那一半已经做了，不许再留「未实现」的免责句');
  for (const rel of ['server/match/player/items.js', 'server/match/player/acquire.js', 'server/match/bot.js', 'server/match/invariants.js']) {
    assert.match(readFileSync(join(ROOT, rel), 'utf8'), /matchSlotPolicy/, `${rel} 的装备位判定必须读这一局的策略`);
  }
  // 而 `gamedata.equipPerChess` 的槽位数也一字未动（两件装备位是官方的，策略只回答「占几格」）
  const gdSrc = readFileSync(join(ROOT, 'server/match/gamedata.js'), 'utf8');
  assert.match(gdSrc, /equipPerChess/);
  assert.equal(/equipPerChess[\s\S]{0,80}morphPairing/.test(gdSrc), false);
  assert.match(gdSrc, /this\.morphSlots = morphSlotPolicy\(/);
});
