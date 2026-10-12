// 行为开关 `shopBias`（DESIGN §28.43 第二格，投稿 `b293e061b38f`）—— 「商店刷新盟约装备几率提升」。
//
// 这一格要的是**商店装备槽的出货偏向**，而投稿把它做成了**安装器**（`files.json.copy` 整份覆盖
// `data/items.json` + `server/match/{bondsMeta,pool}.js` + `server/match/player/economy.js`）。本刀把它收成引擎里
// **一格实现好的开关**：引擎给两档，包只能声明「要哪一档」，数值与动作全由引擎给。
//
// 三件事在这里被钉住：
//   1. **缺省档逐字节不变**：不声明 / 声明成 `official` ⇒ 抽签的每一步都走官方那条路径（`restrict` 是 null）。
//   2. **`bondBias` 只偏置、不授予**：候选集缩到「`giveBondId` 落在该玩家已激活盟约里」的装备，但**不问、不改**
//      授予盟约这件事本身；一次都没激活盟约时它**什么也不做**（否则商店会被抽空 —— 那不是偏向，是停发）。
//   3. **未实现的两条 + 未读取的两个字段**（业主裁决：缺源件就不做假实现）—— 用源码级断言钉住，别让后来人以为漏了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEHAVIOUR_SWITCHES, parseBehaviourDecl, behaviourActions, behaviourIsDefault, behaviourValue } from '../shared/behaviour.js';
import { SharedPool, SharedItemPool, bondBiasPreference } from '../server/match/pool.js';
import { GameData } from '../server/match/gamedata.js';
import { makeMatch, DATA, give, legalTileFor } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = 'shopBias';

/** 一份最小的 GameData 替身：`bondBiasPreference` 只读 `item(id)`。 */
const fakeGd = (items) => ({ item: (id) => items[id] || null });

/**
 * 抽 n 次并回传每次的结果。`rngShop` 是**这一局的随机流**（`createRng`，`sim/rng.js`）—— 给它一个种子就完全可复现。
 */
function rolls(pool, ps, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(ps._rollItemSlot());
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
test('真表里的那一格：形状、两档、缺省是引擎今天的行为', () => {
  const spec = BEHAVIOUR_SWITCHES[SW];
  assert.ok(spec, `真表里必须有这一格：${SW}`);
  assert.deepEqual([...spec.options], ['official', 'bondBias']);
  assert.equal(spec.default, 'official');
  assert.equal(behaviourIsDefault(null, SW), true, '没声明 = 今天的行为');
  for (const option of spec.options) {
    const decl = parseBehaviourDecl([{ switch: SW, option }]).decl;
    assert.equal(behaviourValue(decl, SW), option);
    assert.equal(behaviourIsDefault(decl, SW), option === 'official');
  }
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'official' }]).decl), { ok: true, actions: [] });
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'bondBias' }]).decl),
    { ok: true, actions: [{ kind: 'shop.biasActiveBonds', value: true }] });
});

test('`bondBiasPreference` 只认 `giveBondId`，而且一个盟约都没激活时它一件都不放行', () => {
  const gd = fakeGd({
    a: { id: 'a', giveBondId: 'victoriaShip' },
    b: { id: 'b', giveBondId: 'yanShip' },
    c: { id: 'c', tier: 1 },
  });
  const open = bondBiasPreference(gd, new Set(['victoriaShip']));
  assert.equal(open('a'), true, 'giveBondId 落在已激活盟约里');
  assert.equal(open('b'), false, '另一个盟约的装备不在偏向里');
  assert.equal(open('c'), false, '没有 giveBondId 的装备不在偏向里');
  assert.equal(open('nope'), false, '不认识的 id 不能抛');
  const none = bondBiasPreference(gd, new Set());
  assert.equal([...['a', 'b', 'c']].some((id) => none(id)), false, '空集合 ⇒ 一件都不放行（调用方据此回落官方路径）');
});

test('`rollItem` 的偏向：只缩候选集、不加权，且**一个候选都没有时回落官方那一份**', () => {
  // 抽到哪个阶级由**棋子**份额决定（单机版这里只看得到 1 级：`tierShares` 的 `maxTier` 传 1），所以这一条钉的
  // 是候选集本身。用真 `GameData`：`shopItemsByTier` 是引擎从 `data/items.json` 烘出来的那一份，合成表会造假。
  const gd = new GameData(DATA, 'mode_multi_hard');
  const tier1 = gd.shopItemsByTier[1] || [];
  const bondItem = tier1.find((id) => gd.item(id)?.giveBondId === 'victoriaShip');
  const plainItem = tier1.find((id) => !gd.item(id)?.giveBondId);
  assert.ok(bondItem && plainItem, '1 级里要同时有 victoriaShip 的装备与不带盟约的装备（这条测试的前提）');
  const pool = new SharedPool(gd, []);
  const rng = () => 0; // 均匀抽签取第一个 —— 于是「候选集是什么」直接读得出来
  assert.equal(pool.rollItem(rng, 1), tier1[0], '不给谓词 ⇒ 官方那一份（第一个候选）');
  assert.equal(pool.rollItem(rng, 1, null, bondBiasPreference(gd, new Set(['victoriaShip']))), bondItem,
    '给了谓词 ⇒ 偏向那一份（第一个候选就是 victoriaShip 的装备）');
  assert.equal(pool.rollItem(rng, 1, null, bondBiasPreference(gd, new Set(['victoriaShip']))), bondItem);
  // 偏向的盟约在这一级的商店里一件装备都没有 ⇒ 回落官方那一份（**不是**抽空）
  const inTier1 = new Set(tier1.map((id) => gd.item(id)?.giveBondId).filter(Boolean));
  const absent = Object.keys(DATA.bonds).find((id) => !inTier1.has(id));
  assert.ok(absent, '这条测试的前提：数据里有一个盟约在 1 级没有装备');
  assert.equal(pool.rollItem(rng, 1, null, bondBiasPreference(gd, new Set([absent]))), tier1[0],
    `${absent} 在 1 级没有装备 ⇒ 回落官方那一份`);
});

test('`rollItem` 的偏向**不改抽到哪个阶级**：同一颗种子下，逐次的阶级与官方那一份一致', () => {
  const gd = new GameData(DATA, 'mode_multi_hard');
  const pool = new SharedPool(gd, []);
  const tierOf = (id) => gd.item(id)?.tier ?? 0;
  const restrict = bondBiasPreference(gd, new Set(['victoriaShip']));
  let sawBias = false;
  for (let seed = 1; seed <= 8; seed++) {
    const official = Array.from({ length: 12 }, (() => { const r = mulberry32(seed); return () => pool.rollItem(r, 6); })());
    const biased = Array.from({ length: 12 }, (() => { const r = mulberry32(seed); return () => pool.rollItem(r, 6, null, restrict); })());
    assert.deepEqual(biased.map(tierOf), official.map(tierOf), `seed ${seed}：阶级序列必须逐位相同`);
    if (biased.some((id) => gd.item(id)?.giveBondId === 'victoriaShip')) sawBias = true;
  }
  assert.equal(sawBias, true, '12 次 × 8 颗种子至少命中过一次偏向（否则这一条什么也没验）');
});

/** 一颗可复现的 32 位线性同余流（与本仓库 `sim/rng.js` 无关：这里只要可复现）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------
/** 一局真实的 solo 对局，R1 的 prep（照 test/match/morph-bonds.test.js 的 `prep`）。 */
function prep(o = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, fake: true, seed: o.seed ?? 21 }).start();
  h.toPrep(1);
  return h;
}
const declOf = (option) => parseBehaviourDecl([{ switch: SW, option }]).decl;

test('执行点 1：没声明 / `official` ⇒ `shopBiasBonds()` 是 null（今天的行为）；声明了但没有已激活盟约 ⇒ 也是 null', () => {
  const h = prep();
  const ps = h.ps('p_0');
  assert.equal(ps.shopBiasBonds(), null, '（无包）没声明这一格');
  h.m.behaviour = declOf('official');
  assert.equal(ps.shopBiasBonds(), null, '声明成缺省档 = 今天的行为');
  h.m.behaviour = declOf('bondBias');
  assert.equal(ps.shopBiasBonds(), null, '声明了但一个盟约都没激活 ⇒ 不偏（否则商店会被抽空）');
});

test('执行点 1 + 2：声明 `bondBias` 且盟约已激活 ⇒ 装备槽只出那些盟约的装备，且**不授予**任何盟约', () => {
  const h = prep({ seed: 31 });
  const { m } = h;
  const ps = h.ps('p_0');
  // 让一个核心盟约真的活跃：放两名成员上盘（BOARD 计数）。
  const bond = 'victoriaShip';
  const members = Object.values(DATA.chess)
    .filter((c) => c.visible && !c.isGolden && c.tier <= 2 && c.bonds.includes(bond) && !c.bonds.includes('maniShip'))
    .map((c) => c.chessId).sort();
  assert.ok(members.length >= 2, `${bond} 至少要有两个低阶成员`);
  const before = ps.bonds[bond]?.count ?? 0;
  for (const id of members) {
    const p = give(m, ps, id, 'hand');
    const at = legalTileFor(m, ps, id);
    assert.deepEqual(m.handle('p_0', { t: 'g.move', uid: p.uid, to: { area: 'board', row: at[0], col: at[1] } }), { ok: true });
  }
  assert.equal(ps.bonds[bond].active, true, `${bond} 现在活跃（${members.length} 名成员全部上盘）`);
  const countAfter = ps.bonds[bond].count;
  assert.ok(countAfter > before);

  m.behaviour = declOf('bondBias');
  assert.deepEqual([...ps.shopBiasBonds()], [bond], '偏向集合就是已激活盟约');

  // 装备槽的每一次抽签都在「这些盟约的装备」里；棋子槽一位都不动。
  const grants = Object.values(DATA.items).filter((r) => r.giveBondId === bond).map((r) => r.id).sort();
  assert.ok(grants.length, `${bond} 要有自己的装备`);
  const beforeSlots = ps.shop.slots.length;
  for (let i = 0; i < 20; i++) {
    ps.rollShop({ keepFrozen: false });
    const items = ps.shop.slots.filter((s) => s && s.kind === 'item');
    for (const s of items) assert.ok(grants.includes(s.id), `装备槽只出 ${bond} 的装备，得到 ${s.id}`);
  }
  assert.equal(ps.shop.slots.length, beforeSlots, '槽位数不因偏向改变');
  // **只偏置、不授予**：抽了这么多装备，盟约人数与状态一个字节都没动
  assert.equal(ps.bonds[bond].count, countAfter, '偏向不改盟约人数');
  assert.equal(ps.bonds[bond].active, true);
  h.invariants();
});

test('缺省档下装备槽的抽签序列**与从前同一份**（逐次逐位）', () => {
  const run = (behaviour) => {
    const h = prep({ seed: 77 });
    const ps = h.ps('p_0');
    if (behaviour) h.m.behaviour = behaviour;
    return rolls(null, ps, 40);
  };
  const plain = run(null);
  const official = run(declOf('official'));
  assert.deepEqual(official, plain, '声明成官方档 ⇒ 逐次结果与没声明**同一份**');
  assert.ok(plain.some((s, i) => s && plain.some((t, j) => j !== i && t && t.id !== s.id)), '这一串里确实换过货（不是每次同一件）');
});

// ---------------------------------------------------------------------------------------------------------------
test('未实现的两条 + 未读取的两个字段：源码级断言（缺源件就不做假实现）', () => {
  // 投稿的 `files.json._doc` 还提到两条：①「已激活**核心**盟约优先于已激活附加盟约」；②「骑士戒律也接入这套偏向」。
  // 两条的源件都不在我们手上 ⇒ **没做**，也不假装做（业主裁决）。这一条把它们钉在测试里，后来人一眼看到。
  const spec = BEHAVIOUR_SWITCHES[SW];
  const effect = Object.values(spec.effect).join(' ');
  for (const missing of [/(核心|core).*(优先|prefer)/i, /骑士戒律|knight/i]) {
    assert.equal(missing.test(effect), false, `这一格的 effect 不许声称实现了：${missing}`);
  }
  // 原件的 `payload/data/items.json` 带来两个我们引擎不认识的字段（`giveBondBiasOnly` 115 处 / `canGiveBond` 115 处；
  // 我们的 `data/items.json` 里两处都是 0）。这一格**只读 `giveBondId`** —— 读一个数据里不存在的字段就是一条永远
  // 为假的判据，也就是一个假实现。断言的是**成员访问**：注释里为了说明「不许读它」当然会提到这个名字，读它不行。
  // （`canGiveBond` 的成员访问在本仓库别处**是**存在的 —— `bondsMeta.js` / `support/index.js` 的官方规则读它，
  // 那是既有语义，不在这一格的范围内；这里只钉这一格自己的三个文件。）
  const sources = ['server/match/pool.js', 'server/match/player/economy.js', 'shared/behaviour.js'];
  for (const rel of sources) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const field of ['giveBondBiasOnly', 'canGiveBond']) {
      assert.equal(new RegExp(`\\.${field}\\b|\\[\\s*['"\`]${field}`).test(src), false,
        `${rel} 不许读 ${field}（我们数据里没有这个字段）`);
    }
  }
  // 单机证据：`giveBondId` 有 36 处；`canGiveBond` **这个键是存在的**（115 条记录，值 false/true 都有），
  // 但**这件数据不是我们读的那个字段**：偏向只认 `giveBondId`（`bondBiasPreference` 的源码级断言在上面）。
  // 而原件带来的 `giveBondBiasOnly` 在我们数据里**一处都没有**（`JSON.stringify` 连键名都找不到）。
  assert.equal(JSON.stringify(DATA.items).includes('giveBondBiasOnly'), false);
  assert.equal(Object.values(DATA.items).filter((r) => r && 'canGiveBond' in r).length, 115,
    'canGiveBond 是官方记录本来就有的键（变形同构体自己的标记），不是原件新增的那一个');
  assert.equal(Object.values(DATA.items).filter((r) => r && r.giveBondId).length, 36);
});

test('`SharedItemPool` 仍然是那一份库存闸门（偏向不许绕过它）', () => {
  // 偏向只缩候选集：`stock.canGain` 仍旧是候选的第一步（`rollItem` 的官方名单已经按它过滤过）。
  const gd = new GameData(DATA, 'mode_multi_hard');
  const tier1 = gd.shopItemsByTier[1] || [];
  const bondItems = tier1.filter((id) => gd.item(id)?.giveBondId === 'victoriaShip');
  assert.ok(bondItems.length >= 1, '这条测试的前提：1 级里至少一件 victoriaShip 的装备');
  const held = bondItems[0];
  const pool = new SharedPool(gd, []);
  const stock = { canGain: (id) => id !== held, pick: (rng, list) => list[Math.floor(rng() * list.length)] };
  assert.equal(typeof SharedItemPool, 'function');
  // 偏向那一份里唯一的一件拿不动 ⇒ 回落官方那一份；而**官方那一份自己的库存闸门照旧**
  // （`SharedItemPool.pick` 会再滤一次）：于是结果一定不是那件拿不动的，也一定拿得动。
  const got = pool.rollItem(() => 0, 1, stock, bondBiasPreference(gd, new Set(['victoriaShip'])));
  assert.notEqual(got, held, '拿不动的那件不许被发出来（偏向不得绕过库存闸门）');
  assert.equal(stock.canGain(got), true, '发出来的一定拿得动');
  const all = { canGain: () => false, pick: () => null };
  assert.equal(pool.rollItem(() => 0, 1, all, bondBiasPreference(gd, new Set(['victoriaShip']))), null,
    '整级都拿不动 ⇒ 与官方那一份一样是 null（不是「绕过库存发一件」）');
});
