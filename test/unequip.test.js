// 行为开关 `unequip` + 意图 `g.unequip`（DESIGN §28.43.1，投稿 `79de9ff03518`「装备拆卸mod」）。
//
// 投稿把它做成了**安装器**（`files.json.copy` 整份覆盖 `shared/protocol.js`、`server/match/match/intents.js`、
// `server/match/player/items.js` 与六个客户端文件，并自加 `g.unequip {itemUid}` 意图 + `PlayerState.unequip()`）。
// 本刀把那件事收成**引擎里一格实现好的开关**：`official`（缺省）= 引擎今天的行为（装上的装备只能靠精英化 /
// 合成 / 卖出离开），`allow` = 休整期可以把一件已装备的装备退回手牌（满则临时整备区）。
//
// 四件事在这里被钉住：
//   1. **缺省档逐字不变**：`g.destroy` 与 `g.unequip` 对已装备品回**同一句** `'equipped items are locked'`，
//      且一个字节都没落地。
//   2. **`allow` 档的分支**：手牌有位置 ⇒ 进手牌；手牌满 ⇒ 进临时整备区（0.3.0 起**无界**：
//      五个显示格满了就排队追加，见分支三的注释与上游 `docs/PLAYING.md` §位置上限）。
//   3. **池不变式**：装备只是从装备位移到手牌 / 临时，`piece` 与 `uid` 不变 ⇒ `held` / `cap` / `left` 全不变
//      （没有「归还」这回事）。
//   4. **协议面**：C2S 登记 `g.unequip`、**不新增 S2C**、`PROTOCOL_VERSION` 不动、客户端映射表与发送点接上，
//      而**缺省档不画那个按钮**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEHAVIOUR_SWITCHES, parseBehaviourDecl, behaviourActions, behaviourIsDefault, behaviourValue } from '../shared/behaviour.js';
import { unequipAllowed } from '../server/match/player/items.js';
import { C2S, validateC2S } from '../shared/protocol.js';
import { ERR } from '../shared/constants.js';
import { TEMP_SIZE } from '../server/match/player/common.js';
import { makeMatch, DATA, give, giveItem, legalTileFor, checkInvariants } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = 'unequip';
const declOf = (option) => parseBehaviourDecl([{ switch: SW, option }]).decl;
const LOCKED = { error: ERR.BAD_TARGET, detail: 'equipped items are locked' };

const HAMMER = 'chess_item_1_01_e_a';   // 维式重锤 → victoriaShip（giveBondId 已核）
const ISO = 'chess_item_6_09_e_a';      // 变形同构体（缪尔赛思 garrison_76 发的那个）
const CARRIER = 'chess_char_6_11_a';    // 缪尔赛思：买下它，变形同构体进手牌（照 test/match/morph-bonds.test.js）
const WEARER = Object.values(DATA.chess)
  .find((c) => c.visible && !c.isGolden && c.tier <= 2 && !c.bonds.includes('victoriaShip') && !c.bonds.includes('maniShip')).chessId;
/** 一件件**互不相同**的装备 id：填手牌要用它们 —— 同名两件会触发合成（`owns 2 copies … merges at 2`），
 *  那是**测试自己**造出来的非法状态，与要验的东西无关。已上身的 / 用在对局里的那几件也排除掉。 */
const DISTINCT = Object.keys(DATA.items).filter((id) => DATA.items[id].itemType === 'EQUIP' && id !== HAMMER && id !== ISO);

/** 往 `area`（hand / temp）里塞满**互不相同**的装备。 */
function fill(m, ps, area, howMany) {
  const used = new Set([...ps.hand, ...ps.temp].filter(Boolean).map((p) => p.id));
  let n = 0;
  for (const id of DISTINCT) {
    if (n >= howMany) break;
    if (used.has(id)) continue;
    used.add(id);
    giveItem(m, ps, id, area);
    n++;
  }
  return n;
}

/** R1 的 prep（照 test/match/morph-bonds.test.js）。 */
function prep(o = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, fake: true, seed: o.seed ?? 21 }).start();
  h.toPrep(1);
  return h;
}

/** 一名干员（在盘上）身上装一件装备，返回 { piece, host, itemUid }。 */
function wearer(h, itemId = HAMMER) {
  const { m } = h; const ps = h.ps('p_0');
  const p = give(m, ps, WEARER, 'hand');
  const at = legalTileFor(m, ps, WEARER);
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: p.uid, to: { area: 'board', row: at[0], col: at[1] } }), { ok: true });
  const item = giveItem(m, ps, itemId);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: item.uid, targetUid: p.uid }), { ok: true });
  assert.equal(p.items.some((x) => x.uid === item.uid), true, '装备真的上身了');
  return { piece: p, itemUid: item.uid };
}

// ---------------------------------------------------------------------------------------------------------------
test('真表里的那一格：形状、两档、缺省是引擎今天的行为', () => {
  const spec = BEHAVIOUR_SWITCHES[SW];
  assert.ok(spec, `真表里必须有这一格：${SW}`);
  assert.deepEqual([...spec.options], ['official', 'allow']);
  assert.equal(spec.default, 'official');
  assert.equal(behaviourIsDefault(null, SW), true, '没声明 = 今天的行为');
  assert.equal(unequipAllowed(null), false);
  assert.equal(unequipAllowed([]), false);
  assert.equal(unequipAllowed(declOf('official')), false);
  assert.equal(unequipAllowed(declOf('allow')), true);
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'official' }]).decl), { ok: true, actions: [] });
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'allow' }]).decl),
    { ok: true, actions: [{ kind: 'items.allowUnequip', value: true }] });
  assert.equal(behaviourValue(declOf('allow'), SW), 'allow');
});

test('协议面：C2S 登记 `g.unequip { itemUid }`，形状只有一个字段，且**不新增** `g.loadout` 之类别的东西', () => {
  assert.ok(Object.hasOwn(C2S, 'g.unequip'), 'g.unequip 必须在 C2S 表里（否则 platform 的 GAME_TYPES 不认它）');
  const shape = C2S['g.unequip'];
  assert.deepEqual(Object.keys(shape), ['itemUid'], '只有一个字段');
  assert.equal(typeof shape.itemUid, 'function', 'itemUid 走协议层的校验子');
  // 同一个 isUid 子：g.equip 的 itemUid 与它认同一批值
  for (const v of [1, 2, 999, 2 ** 31 - 1]) {
    assert.equal(!!shape.itemUid(v), !!C2S['g.equip'].itemUid(v), String(v));
  }
  for (const v of [0, -1, 1.5, '1', null, undefined, 2 ** 31 + 1]) {
    assert.equal(!!shape.itemUid(v), false, String(v));
  }
  assert.equal(!!shape.itemUid(2 ** 31), true, 'isInt 的上界是**含**的（与 g.equip 同一个子）');
  // 只新增这一个类型
  assert.equal(Object.hasOwn(C2S, 'g.loadout'), false, '第二格复用的是 room.loadout，不新增 g.loadout');
});

// ---------------------------------------------------------------------------------------------------------------
test('缺省档：`g.destroy` 与 `g.unequip` 对已装备品回**同一句**，且一个字节都不落地', () => {
  const h = prep();
  const { m } = h; const ps = h.ps('p_0');
  const { piece, itemUid } = wearer(h);
  const before = { items: piece.items.map((x) => x.uid), hand: ps.hand.map((x) => x && x.uid), temp: ps.temp.map((x) => x && x.uid) };

  assert.deepEqual(m.handle('p_0', { t: 'g.destroy', uid: itemUid }), LOCKED, 'g.destroy 今天那句');
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid }), LOCKED, '缺省档下 g.unequip 必须逐字同一句');
  assert.deepEqual(piece.items.map((x) => x.uid), before.items, '装备还在干员身上');
  assert.deepEqual(ps.hand.map((x) => x && x.uid), before.hand);
  assert.deepEqual(ps.temp.map((x) => x && x.uid), before.temp);
  // 显式选缺省档 = 没声明
  m.behaviour = declOf('official');
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid }), LOCKED);
  h.invariants();
});

test('缺省档：不是已装备的装备（手牌里的）也不能“卸下”', () => {
  const h = prep();
  const { m } = h; const ps = h.ps('p_0');
  const loose = giveItem(m, ps, HAMMER);
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid: loose.uid }), LOCKED, '缺省档先被开关挡住（同一句）');
  m.behaviour = declOf('allow');
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid: loose.uid }),
    { error: ERR.BAD_TARGET, detail: 'not equipped on an operator' }, 'allow 档下它仍然不是“已装备”');
  assert.equal(ps.hand.some((x) => x && x.uid === loose.uid), true, '手牌里那件没被动过');
  h.invariants();
});

// ---------------------------------------------------------------------------------------------------------------
test('`allow` 档 · 分支一：手牌有位置 ⇒ 退回手牌，且盟约人数跟着重算', () => {
  const h = prep();
  const { m } = h; const ps = h.ps('p_0');
  // 照 test/match/morph-bonds.test.js 的配方：「变形同构体 + 一件授予盟约的装备」同时在一名干员身上 ⇒
  // 该干员被视为那个盟约的成员。（对局里变形同构体由缪尔赛思的 garrison_76 发出；测试里直接发一件等价。）
  const iso = giveItem(m, ps, ISO);
  const t = give(m, ps, WEARER, 'hand');
  const at = legalTileFor(m, ps, WEARER);
  assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: t.uid, to: { area: 'board', row: at[0], col: at[1] } }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: iso.uid, targetUid: t.uid }), { ok: true });
  const hammer = giveItem(m, ps, HAMMER);
  assert.deepEqual(m.handle('p_0', { t: 'g.equip', itemUid: hammer.uid, targetUid: t.uid }), { ok: true });
  const bond = 'victoriaShip';
  assert.equal(ps.bonds[bond].count, 1, '配对成立 ⇒ 人数 1');
  const poolBefore = m.pool.snapshot();
  const heldBefore = m.itemPool.held(HAMMER);

  m.behaviour = declOf('allow');
  const handBefore = ps.hand.filter(Boolean).length;
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid: hammer.uid }), { ok: true });
  assert.equal(t.items.some((x) => x.uid === hammer.uid), false, '装备离开了干员');
  const back = ps.hand.find((x) => x && x.uid === hammer.uid);
  assert.ok(back, '退回手牌');
  assert.equal(back.id, HAMMER, '还是同一件（piece 对象与 uid 都不变）');
  assert.equal(ps.hand.filter(Boolean).length, handBefore + 1);
  assert.equal(ps.bonds[bond].count, 0, '配对断了 ⇒ 人数回到 0（recompute 真的跑了）');
  // 池不变式：没有任何一件“归还”
  assert.deepEqual(m.pool.snapshot(), poolBefore, '棋子池快照不变');
  assert.equal(m.itemPool.held(HAMMER), heldBefore, '装备占用不变（只是从装备位移到手牌）');
  h.invariants();
});

test('`allow` 档 · 分支二：手牌满 ⇒ 进临时整备区', () => {
  const h = prep();
  const { m } = h; const ps = h.ps('p_0');
  const { itemUid } = wearer(h);
  const need = ps.hand.filter((x) => x == null).length;
  const got = fill(m, ps, 'hand', need);
  assert.equal(got, need, `手牌要填满（需要 ${need} 件互不相同的装备）`);
  assert.equal(ps.hand.some((x) => x == null), false, '手牌已满');
  assert.equal(ps.temp.some((x) => x != null), false, '临时区还空着');

  m.behaviour = declOf('allow');
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid }), { ok: true });
  assert.equal(ps.temp.some((x) => x && x.uid === itemUid), true, '进了临时整备区');
  h.invariants();
});

// ⚠️ 0.3.0 起**临时整备区是无界队列**：`stow(..., { allowTemp: true })` 在五个显示格满了之后
// **追加到队列尾部**（`pieces.js` stow：「Five visible slots are a window, not a capacity limit」；上游
// `docs/PLAYING.md` §位置上限 逐字写明「进入**可扩容的**临时整备区，只显示前面的 5 格；超出的…**排队保留**…
// **不会因为超过 15 个而丢失**」）。所以在 0.3.0 之后「手牌与临时都满 ⇒ HAND_FULL」**不再可达** ——
// 这条在 0.3.0 合入前（合入前 `stow` 的 temp 分支是 `freeSlot(this.temp)`，满则 `return null`）是真的。
// 因此本用例改为**钉住新语义**：手牌满 ⇒ 进无界的临时整备区（追加在 5 个显示格之后），装备不丢、手牌一位不动。
test('`allow` 档 · 分支三（0.3.0 起）：手牌满且 5 个显示格也满 ⇒ 追加进**无界**的临时整备区', () => {
  const h = prep();
  const { m } = h; const ps = h.ps('p_0');
  const { piece, itemUid } = wearer(h);
  const needHand = ps.hand.filter((x) => x == null).length;
  assert.equal(fill(m, ps, 'hand', needHand), needHand, '手牌填满');
  const needTemp = ps.temp.filter((x) => x == null).length;
  assert.equal(fill(m, ps, 'temp', needTemp), needTemp, '临时区的显示格填满');
  assert.equal(ps.hand.some((x) => x == null), false, '手牌满了');
  assert.equal(ps.temp.slice(0, TEMP_SIZE).some((x) => x == null), false, '前 5 个显示格也满了');
  const idxBefore = piece.items.findIndex((x) => x.uid === itemUid);
  const hand = ps.hand.map((x) => x && x.uid);
  const tempBefore = ps.temp.length;

  m.behaviour = declOf('allow');
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid }), { ok: true }, '无界队列 ⇒ 绝不失败');
  assert.equal(piece.items.some((x) => x.uid === itemUid), false, '装备离开了干员');
  const at = ps.temp.findIndex((x) => x && x.uid === itemUid);
  assert.ok(at >= TEMP_SIZE, `装备排在 5 个显示格之后（下标 ${at} ≥ ${TEMP_SIZE}）`);
  assert.equal(ps.temp.length, tempBefore + 1, '队列增长了一格，五格窗口之外');
  assert.deepEqual(ps.hand.map((x) => x && x.uid), hand, '手牌一位都没动');
  assert.equal(piece.items.includes(undefined), false, '装备行没有留下空位');
  // 失败路径不再可达 ⇒ 装备的下标也不会因回滚而变（那里已无回滚可走）
  assert.equal(piece.items.findIndex((x) => x.uid === itemUid), -1, '装备已不在干员身上（不是失败后的原下标）');
  assert.equal(idxBefore >= 0, true, '夹具前提：它原本确实装在干员身上');
  h.invariants();
});

test('形状错在**协议层**就被挡（`validateC2S`），到了意图层也一定被拒、不静默', () => {
  const h = prep();
  const { m } = h;
  const { itemUid } = wearer(h);
  m.behaviour = declOf('allow');
  // ① 真正判形状的是 `validateC2S`（`server/net.js` 的 onFrame 在 ping/hello 之前调它，把非 null 的**原因串**
  //    折成 `ERR.BAD_MSG`）。`Match.handle` 只认已经过了它的消息 —— 所以「形状错 ⇒ BAD_MSG」这条在这一层钉。
  const why = (bad) => validateC2S({ t: 'g.unequip', ...bad });
  for (const bad of [{}, { itemUid: 0 }, { itemUid: -1 }, { itemUid: 'x' }, { itemUid: 1.5 }, { itemUid: null }, { uid: itemUid }]) {
    const r = why(bad);
    assert.equal(typeof r, 'string', `${JSON.stringify(bad)} 必须被 validateC2S 拒（拿到原因串）`);
    assert.match(r, /bad field itemUid/, `${JSON.stringify(bad)} 点名的必须是 itemUid`);
  }
  assert.equal(why({ itemUid }), null, '合法的过协议层（null = 通过）');
  assert.equal(why({ itemUid, extra: 1 }), null, '多余的未知字段被忽略 —— 这一层既定的行为（不是本刀的新政策）');
  assert.equal(validateC2S({ t: 'g.nopeNotAType', itemUid }), 'unknown type g.nopeNotAType', '没登记的 t 进不来');
  // ② 就算有人绕过传输层直接调意图（内部调用 / 自测），每一条也都被拒 —— 没有一条会被当成合法意图执行。
  for (const bad of [{}, { itemUid: 0 }, { itemUid: 'x' }, { itemUid: 1.5 }, { uid: itemUid }]) {
    const r = m.handle('p_0', { t: 'g.unequip', ...bad });
    assert.ok(r && r.error, `${JSON.stringify(bad)} 必须被拒（意图层不静默）`);
  }
  assert.deepEqual(m.handle('p_0', { t: 'g.unequip', itemUid }), { ok: true }, '合法的那一条照旧成功');
});

// ---------------------------------------------------------------------------------------------------------------
test('客户端：发送点接上既有 `act()`、按钮**只在开关开时画**、官方档那句提示还在（源码级）', () => {
  const actions = readFileSync(join(ROOT, 'public/js/ui/gameActions.js'), 'utf8');
  assert.match(actions, /'g\.unequip':\s*'back'/, '成功音效表里要有它');
  assert.match(actions, /unequip:\s*\(itemUid\)\s*=>\s*act\('g\.unequip',\s*\{\s*itemUid\s*\}\)/, '发送点复用既有 act()');
  assert.match(actions, /let unequipOn = false/, '缺省必须是 false（官方：不画）');
  assert.match(actions, /export function setUnequipAllowed/, '写入点给 roomMods.js');
  const roomMods = readFileSync(join(ROOT, 'public/js/roomMods.js'), 'utf8');
  assert.match(roomMods, /setUnequipAllowed\(behaviourValue\(decl, 'unequip'\) === 'allow'\)/, 'roomMods 从 welcome.mods 派生');
  const panel = readFileSync(join(ROOT, 'public/js/ui/detailPanel.js'), 'utf8');
  assert.match(panel, /unequipAllowed\(\)/, 'ItemRow / ItemDetail 读它');
  assert.match(panel, /const canDetach = typeof onUnequip === 'function' && Number\.isInteger\(uid\) && unequipAllowed\(\)/,
    '「卸下」按钮的判据：有人传 onUnequip + 有 uid + 开关开');
  assert.match(panel, /拖拽至干员身上进行配发（每名干员最多 2 件，配发后无法取下）/, '官方档那句提示**还在**');
  assert.match(panel, /拖拽至干员身上进行配发（每名干员最多 2 件）/, 'allow 档另有一句（不带“无法取下”）');
  const game = readFileSync(join(ROOT, 'public/js/screens/game.js'), 'utf8');
  assert.match(game, /onUnequip=\$\{\(itemUid\) => actions\.unequip\(itemUid\)\}/, '游戏屏把它接到 DetailPanel');
});

test('客户端：四个 i18n 包都有新词条（`卸下` 与不带“无法取下”的那句）', () => {
  for (const pack of ['en', 'ja', 'ko', 'zh-TW']) {
    const json = JSON.parse(readFileSync(join(ROOT, `public/i18n/${pack}.json`), 'utf8'));
    assert.equal(typeof json['卸下'], 'string', `${pack}: 卸下`);
    assert.ok(json['卸下'].length > 0, `${pack}: 卸下 不能是空串`);
    assert.equal(typeof json['拖拽至干员身上进行配发（每名干员最多 2 件）'], 'string', `${pack}: 短提示`);
    assert.ok(json['拖拽至干员身上进行配发（每名干员最多 2 件）'].length > 0, `${pack}: 短提示 不能是空串`);
    assert.equal(typeof json['拖拽至干员身上进行配发（每名干员最多 2 件，配发后无法取下）'], 'string',
      `${pack}: 官方那句必须还在（allow 档才换成短的）`);
  }
});
