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
// **未实现、也不假装实现的一条（如实披露）**：投稿还要求「每名干员只能装一件变形同构体」与「第三件装备永远顶掉
// 真正占格的那两件」里的**装备位语义**部分。本刀**没做**那些：它们落在装备位/替换的既有实现
// （`server/match/player/items.js` 与 `gamedata.equipPerChess` 的槽位判定）上，而本环境**跑不了 golden**
// （纪律：不跑 `golden:update`）⇒ 那是下一刀的事。这一格今天**只**改「配对授予哪些盟约」这一条，测试把这条边界钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEHAVIOUR_SWITCHES, parseBehaviourDecl, behaviourActions, behaviourIsDefault, behaviourValue } from '../shared/behaviour.js';
import { MORPH_PAIRING_OPTIONS, isMorphCarrier, grantsBond, morphPairingOf, grantedBondsByMorph, morphCarrierIndexes } from '../shared/morph.js';
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
  const files = ['server/match/bondsMeta.js', 'server/sim/content/support/index.js', 'public/js/ui/gameLogic/bonds.js'];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /grantedBondsByMorph/, `${rel} 必须调那一份共用的判据`);
    assert.equal(/r\.canGiveBond\s*\)\s*\{\s*for|some\(\(r\)\s*=>\s*r\.canGiveBond\)/.test(src), false,
      `${rel} 不许再留着那份自己写的配对循环`);
  }
  // 判据本体只在一个文件里
  assert.match(readFileSync(join(ROOT, 'shared/morph.js'), 'utf8'), /export function grantedBondsByMorph/);
});

test('未实现的那一条写在测试里（装备位语义：不占格 / 顶掉真占格那两件）', () => {
  // 投稿还要求「不占装备位」与「每名干员只能装一件」的**槽位**语义。本刀没做（见文件头）：它落在
  // `server/match/player/items.js` 的槽位判定与 `gamedata.equipPerChess` 上，而本环境跑不了 golden。
  // 这一条把边界钉住：那一格的 `effect` 不许声称做了它，`shared/morph.js` 也不许偷偷实现它。
  // 边界只钉「槽位语义」这件事：那一格的 effect **可以**提到它占一个装备位（那是**官方**读数的事实），
  // 但不许声称**改掉了**槽位语义（`plus` 那一行才是要求，而那一条本刀没做）。判据用「改槽位」的措辞。
  const effect = Object.values(BEHAVIOUR_SWITCHES[SW].effect).join(' ');
  assert.equal(/no slot|does not occupy|takes no equipment slot|不占装备位|顶掉/.test(effect), false,
    '这一格的 effect 不许声称改了槽位语义（未实现）');
  const itemsSrc = readFileSync(join(ROOT, 'server/match/player/items.js'), 'utf8');
  assert.equal(itemsSrc.includes('morphPairing'), false, '槽位判定今天不读这一格（未实现，别假装读了）');
  // 而 `gamedata.equipPerChess` 的槽位数也一字未动（两件装备位是官方的）
  const gdSrc = readFileSync(join(ROOT, 'server/match/gamedata.js'), 'utf8');
  assert.match(gdSrc, /equipPerChess/);
  assert.equal(/equipPerChess[\s\S]{0,80}morphPairing/.test(gdSrc), false);
});
