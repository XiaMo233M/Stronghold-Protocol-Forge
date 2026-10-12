// test/traitGrants.test.js — 特质授予盟约（`trait.grantsBonds`，DESIGN §28.49）。
//
// 业主原话：「我们的 forge 能不能做出游戏内的『特质』效果，即一般是用来**叠加盟约层数**的固有天赋」。
// 这一刀给它补上**纯数据声明面**：一条 chess 记录写 `trait.grantsBonds: ["<bondId>", …]` ⇔「带这条特质的棋子
// 视为那些盟约的成员」⇒ 进 `bondsMeta.rawCount` 的去重成员集合 ⇒ count +1 ⇒ `tierFor` 层数自然上去。
//
// 五条要钉住的东西（缺一条这一格就不成立）：
//   1. **缺省逐字节不变**：不写这一格时，成员资格 / count / tier 与从前一字不差（官方 266 条记录一条都没有它）；
//   2. **真生效**：写上它就真的 count +1、tier 真升 —— 走引擎自己的装载链（`loadWorkshop` + `applyWorkshop` +
//      `GameData` + `computeBonds`），不是拿一个手搓对象去骗判据；
//   3. **三处同源**：prep 的 `pieceBonds`、战斗的 `unitBonds`、客户端的 `pieceBondIds` / `bondMembers` 读的是
//      **同一个纯函数**（`shared/morph.js` 的 `grantedBondsByTrait`），成员资格的**合并**也只有一份
//      （`memberBonds`）—— 行为级对照 + 源码级断言各一半；
//   4. **不存在的盟约 id 与写歪的形状一律响亮**：读取点按 `hasBond` 丢弃（永远进不了计数）、装载期
//      `report.traitGrants` 逐条点名、作者侧 `npm run workshop:validate` 同一份判据点名，而**都不拒包**；
//   5. **有牙**：判据被拿掉 / 被写坏时，本文件的断言必须红（不是「今天恰好是绿的」）。
//
// 判据本体：`shared/morph.js` 的 `grantedBondsByTrait` / `traitGrantIssues` / `memberBonds`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { traitGrantList, grantedBondsByTrait, traitGrantIssues, memberBonds, TRAIT_GRANT_KEY } from '../shared/morph.js';
import { loadWorkshop } from '../server/workshop.js';
import { applyWorkshop } from '../shared/workshop.js';
import { GameData } from '../server/match/gamedata.js';
import { computeBonds, pieceBonds, thresholdsOf } from '../server/match/bondsMeta.js';
import { unitBonds } from '../server/sim/content/support/index.js';
import { pieceBondIds } from '../public/js/ui/gameLogic.js';
import { makeBattle } from './helpers/battleHarness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'workshop-validate.mjs');
const MODE = 'mode_multi_hard';

/** 官方数据（`data/*.json` 原样读盘：不走 `getData()`，免得本仓自己的 `workshop/` 混进来）。 */
const official = {};
for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
  if (f.endsWith('.json')) official[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
}
const CHESS = official.chess;
const BONDS = official.bonds;

/** 靶子盟约：`egirShip`（阈值 3/5，官方 9 名成员）。选它是因为「差一个就到 3」与「差一个就到 5」都能摆出来。 */
const BOND = 'egirShip';
const MEMBERS = Object.values(CHESS).filter((c) => c.visible && !c.isGolden && c.bonds.includes(BOND)).map((c) => c.chessId).sort();
/** 探针棋子：**自己不是** `egirShip` 成员（所以那个 +1 只能是特质带来的）。 */
const PROBE = 'chess_char_1_02_a';
/** 客户端那两处读的是棋子的 `trait` 对象（`def.raw.trait`），不是 `def.trait`（文本）。 */
const withGrants = (id, grantsBonds) => ({ ...CHESS[id], trait: { ...CHESS[id].trait, [TRAIT_GRANT_KEY]: grantsBonds } });

const boardOf = (ids) => new Map(ids.map((id, i) => [id, { id, uid: i + 1, kind: 'chess' }]));
const gdOf = (data) => new GameData(data, MODE);
const countOf = (gd, ids, bond = BOND) => computeBonds(gd, { board: boardOf(ids), hand: [], layers: {} })[bond];

// ---------------------------------------------------------------------------------------------------------------
test('判据本身：授予名单的形状（非对象 / 缺项 / 字符串 / 去重 / 顺序）', () => {
  assert.equal(TRAIT_GRANT_KEY, 'grantsBonds', '键名是这一格的契约，写进 shared/modSurface.js 的锚点');
  const t = (grantsBonds) => ({ desc: 'x', grantTrait: true, ...(grantsBonds === undefined ? {} : { [TRAIT_GRANT_KEY]: grantsBonds }) });
  assert.deepEqual(grantedBondsByTrait(t(['yanShip', 'egirShip'])), ['yanShip', 'egirShip'], '按声明顺序');
  assert.deepEqual(grantedBondsByTrait(t(['yanShip', 'yanShip'])), ['yanShip'], '去重');
  assert.deepEqual(grantedBondsByTrait(t(['yanShip', 7, '', null, 'egirShip'])), ['yanShip', 'egirShip'], '非空字符串以外的一律不算数');
  // 缺省：这一格不存在 / trait 根本不是一个对象 ⇒ 空表（= 引擎今天的行为）
  for (const bad of [undefined, null, {}, '一个字符串特质', 42, ['yanShip'], { [TRAIT_GRANT_KEY]: 'yanShip' }, { [TRAIT_GRANT_KEY]: {} }, { [TRAIT_GRANT_KEY]: [] }]) {
    assert.deepEqual(grantedBondsByTrait(bad), [], `${JSON.stringify(bad)} ⇒ 什么都不授予`);
  }
  assert.deepEqual(traitGrantList({ [TRAIT_GRANT_KEY]: ['a', 'a', ''] }), ['a']);
  // `hasBond` 是那一条可选的护栏：服务端/战斗传它，客户端拿不到权威名单时不传
  assert.deepEqual(grantedBondsByTrait(t(['yanShip', 'egirShip']), { hasBond: (id) => id === BOND }), [BOND]);
  assert.deepEqual(grantedBondsByTrait(t(['yanShip']), { hasBond: () => false }), []);
});

test('缺省逐字节不变：官方 266 条棋子的 `trait` 一条都没有这一格，成员资格一个字都不多', () => {
  const ids = Object.keys(CHESS);
  assert.equal(ids.length, 266, '夹具前提：官方棋子记录条数');
  const gd = gdOf(official);
  let checked = 0;
  for (const id of ids) {
    const c = CHESS[id];
    assert.deepEqual(grantedBondsByTrait(c.trait), [], `${id}: 官方数据不该有这一格`);
    // `memberBonds` 在缺省输入下必须**逐字**等于从前那条算式（自己的 bonds）。这也就是三处读取点今天写的
    // `out = [...c.bonds]` + 装备授予：没有这一格时，新加的腿一条都不加。
    assert.deepEqual(memberBonds(c.bonds, { trait: c.trait, recs: [], hasBond: (b) => !!BONDS[b] }), c.bonds.slice(), `${id}: 缺省成员资格`);
    assert.deepEqual(pieceBonds(gd, { id }), c.bonds.slice(), `${id}: prep 侧一条不多`);
    checked++;
  }
  assert.equal(checked, 266);
  // 同一条记录带上装备行也一样（装备那条腿今天已经存在，本刀不能碰它）
  const wearer = ids.find((id) => CHESS[id].visible && !CHESS[id].isGolden);
  assert.deepEqual(pieceBonds(gd, { id: wearer, items: [{ id: 'chess_item_6_09_e_a' }] }), CHESS[wearer].bonds.slice(),
    '只有一件装备 ⇒ 变形同构体那条腿不授予（与 §28.43.1 的缺省档一致）');
});

test('真生效：走上这一格 ⇒ count +1、tier 真升（loadWorkshop → applyWorkshop → GameData → computeBonds）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-trait-grant-'));
  try {
    const root = path.join(tmp, 'workshop');
    const packDir = path.join(root, 'trait-grant-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), `${JSON.stringify({
      id: 'trait-grant-pack', name: '特质授予盟约（test/traitGrants.test.js）', version: '1.0.0',
      license: 'CC0-1.0', description: '特质 ⇒ 盟约成员 ⇒ count/tier', gameVersion: '0.2.x',
      content: ['chess'], combat: true, overrides: [`chess:${PROBE}`],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(packDir, 'chess.json'), `${JSON.stringify({ [PROBE]: { trait: withGrants(PROBE, [BOND]).trait } }, null, 2)}\n`);

    const loaded = await loadWorkshop(root, { log: { warn() {}, info() {} } });
    assert.deepEqual(loaded.errors, [], '这份包本身必须干净（否则下面量到的就不是特质那一条腿）');
    const { data: merged, report } = applyWorkshop(official, loaded.packs);
    assert.deepEqual(report.traitGrants, [], '合法的盟约 id 不许被点名');
    const gd = gdOf(merged);
    assert.deepEqual(merged[PROBE] ?? merged.chess[PROBE].trait[TRAIT_GRANT_KEY], [BOND], '这一格真的并进了合并后的记录');
    assert.deepEqual(pieceBonds(gd, { id: PROBE }), [...CHESS[PROBE].bonds, BOND], '成员资格里多了那一条');

    // ① 差一个到 3（阈值 3/5）：2 名原生成员 ⇒ tier 0；探针棋子补上第 3 名 ⇒ tier 1
    const b1 = [MEMBERS[0], MEMBERS[1], PROBE];
    const before1 = countOf(gdOf(official), b1);
    const after1 = countOf(gd, b1);
    assert.deepEqual([before1.count, before1.tier, before1.active], [2, 0, false], '装配前：2 名 ⇒ tier 0');
    assert.deepEqual([after1.count, after1.tier, after1.active], [3, 1, true], '装配后：3 名 ⇒ tier 1（层数真的上去了）');

    // ② 差一个到 5（第二档）：4 名原生成员 ⇒ tier 1；探针棋子补上第 5 名 ⇒ tier 2
    const b2 = [MEMBERS[0], MEMBERS[1], MEMBERS[2], MEMBERS[3], PROBE];
    const before2 = countOf(gdOf(official), b2);
    const after2 = countOf(gd, b2);
    assert.deepEqual([before2.count, before2.tier], [4, 1], '装配前：4 名 ⇒ tier 1');
    assert.deepEqual([after2.count, after2.tier], [5, 2], '装配后：5 名 ⇒ tier 2');
    // 探针棋子自己那两条盟约不许被动到（+1 只发生在声明过的那一条上）
    assert.deepEqual([before1.layers, after1.layers], [0, 0], '层数那条持久通道（layers）不由这一格写入');
    assert.deepEqual(thresholdsOf(BONDS[BOND]), [3, 5], `夹具前提：${BOND} 的阈值`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('三处同源（行为）：prep / 战斗 / 客户端对同一条记录给出同一个成员资格', () => {
  const rec = withGrants(PROBE, [BOND]);
  const hasBond = (id) => !!BONDS[id];
  // 1) prep 侧（`bondsMeta.pieceBonds`）
  const prep = pieceBonds(gdOf({ ...official, chess: { ...CHESS, [PROBE]: rec } }), { id: PROBE });
  assert.ok(prep.includes(BOND), 'prep 侧必须算他');
  // 2) 战斗侧（`support/index.unitBonds`）：sim 读的是 `def.raw.trait`，所以夹具直接改记录
  const h = makeBattle({ defs: { chess: { [PROBE]: rec } }, units: [{ chessId: PROBE, row: 10, col: 4 }], timeLimit: 999, autoFinish: false });
  h.step(1);
  const battle = [...unitBonds(h.unit(PROBE))];
  assert.deepEqual(battle, prep, '战斗侧与 prep 侧必须同判');
  // 3) 客户端（`gameLogic pieceBondIds`）
  const client = pieceBondIds(rec, [], () => null, hasBond);
  assert.deepEqual(client, prep, '客户端与 prep 侧必须同判');
  // 客户端另一处读者：盟约弹窗的成员行判据 `bondMembers` 的 `grants(p)` 走的是同一份
  const recNoBond = { ...CHESS[PROBE], bonds: ['kjeragShip', 'steadShip'], trait: rec.trait };
  assert.deepEqual(pieceBondIds(recNoBond, [], () => null, hasBond), [...recNoBond.bonds, BOND], '自己的盟约 + 特质授予');
});

test('三处同源（源码）：不许再各写一份合并循环，判据只在一个文件里', () => {
  const files = ['server/match/bondsMeta.js', 'server/sim/content/support/index.js', 'public/js/ui/gameLogic/bonds.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /memberBonds/, `${rel} 必须调那一份共用的成员资格出口`);
    assert.match(src, /morph\.js/, `${rel} 的判据必须来自 shared/morph.js`);
  }
  const morph = fs.readFileSync(path.join(ROOT, 'shared/morph.js'), 'utf8');
  assert.match(morph, /export function grantedBondsByTrait/, '特质那条腿的判据本体');
  assert.match(morph, /export function memberBonds/, '成员资格的合并本体');
  // 读取点不许自己再写一遍 `grantsBonds` 的循环（判据只在 shared/morph.js 里）
  for (const rel of [...files, 'server/sim/content/support/meta.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(/for\s*\([^)]*\)\s*\{[^}]*grantsBonds/.test(src), false, `${rel} 自己写了一份 grantsBonds 的循环`);
  }
});

test('坏 id / 坏形状：逐种点名（装载期与作者侧同一份判据），读取点永远不进计数', async () => {
  const t = (grantsBonds) => ({ [TRAIT_GRANT_KEY]: grantsBonds });
  const codes = (trait, bondIds) => traitGrantIssues(trait, { bondIds }).map((i) => i.code);
  const known = new Set(Object.keys(BONDS));
  // ① 形状：不是数组（字符串 / 数字 / 对象 / null），以及数组里有非空字符串以外的东西
  for (const raw of ['yanShip', 42, {}, null, true]) {
    assert.deepEqual(codes(t(raw), known), ['TRAIT_GRANT_BAD_SHAPE'], `${JSON.stringify(raw)} 必须被点名`);
  }
  for (const raw of [[1, 2], [''], [null], [{ id: 'yanShip' }], ['yanShip', '']]) {
    assert.deepEqual(codes(t(raw), known), ['TRAIT_GRANT_BAD_SHAPE'], `${JSON.stringify(raw)} 必须被点名`);
  }
  // ② 空表：声明了个寂寞
  assert.deepEqual(codes(t([]), known), ['TRAIT_GRANT_EMPTY'], '空数组必须被点名');
  // ③ 不存在的盟约 id（空表之外的每一种坏形状都已经在上面的用例里）
  assert.deepEqual(codes(t(['nopeShip']), known), ['TRAIT_GRANT_UNKNOWN_BOND']);
  assert.deepEqual(codes(t(['yanShip', 'nopeShip', 'yanShip']), known), ['TRAIT_GRANT_UNKNOWN_BOND'], '去重之后只报一次');
  // ④ 成立的那一格不报：合法的 id、以及「没有盟约表时不判存在性」（宁可不说，也不要乱说）
  assert.deepEqual(codes(t(['yanShip']), known), []);
  assert.deepEqual(codes(t(['nopeShip']), null), [], '没有盟约表 ⇒ 只判形状');
  assert.deepEqual(codes({ desc: 'x' }, known), [], '没写这一格 ⇒ 一个字都不说');
  assert.deepEqual(codes('一个字符串特质', known), []);

  // 装载期：一份把三种毛病写在同一张记录表里的包 ⇒ 逐条点名，但**不拒包**、也不进计数
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-trait-bad-'));
  try {
    const root = path.join(tmp, 'workshop');
    const packDir = path.join(root, 'trait-bad-pack');
    fs.mkdirSync(packDir, { recursive: true });
    const unknown = 'chess_char_1_02_a';
    const empty = 'chess_char_1_06_a';
    const badShape = 'chess_char_1_03_a';
    fs.writeFileSync(path.join(packDir, 'pack.json'), `${JSON.stringify({
      id: 'trait-bad-pack', name: '写歪的特质授予（test/traitGrants.test.js）', version: '1.0.0',
      license: 'CC0-1.0', description: '坏 id / 空表 / 坏形状', gameVersion: '0.2.x',
      content: ['chess'], combat: true, overrides: [unknown, empty, badShape].map((id) => `chess:${id}`),
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(packDir, 'chess.json'), `${JSON.stringify({
      [unknown]: { trait: withGrants(unknown, ['nopeShip']).trait },
      [empty]: { trait: withGrants(empty, []).trait },
      [badShape]: { trait: withGrants(badShape, 'yanShip').trait },
    }, null, 2)}\n`);

    const loaded = await loadWorkshop(root, { log: { warn() {}, info() {} } });
    assert.deepEqual(loaded.errors, [], '写歪这一格不该让包装载失败（「不拒包」是口径）');
    const { data: merged, report } = applyWorkshop(official, loaded.packs);
    const found = (report.traitGrants || []).map((g) => `${g.id}/${g.code}`).sort();
    assert.deepEqual(found, [
      `${badShape}/TRAIT_GRANT_BAD_SHAPE`, `${empty}/TRAIT_GRANT_EMPTY`, `${unknown}/TRAIT_GRANT_UNKNOWN_BOND`,
    ].sort(), '三条毛病必须逐条点名（这正是「不许静默半可用」）');
    for (const g of report.traitGrants) {
      assert.equal(g.pack, 'trait-bad-pack', '点名必须带上包');
      assert.match(g.reason, /trait\.grantsBonds/, '理由里必须写出是哪一格');
    }
    // 读取点丢弃 ⇒ 计数一个都不动（三条记录都并进去了，但那三条「授予」都不算数）
    const gd = gdOf(merged);
    for (const bond of Object.keys(BONDS)) {
      assert.deepEqual(countOf(gd, [unknown, empty, badShape], bond), countOf(gdOf(official), [unknown, empty, badShape], bond),
        `${bond}: 坏声明不许改变计数`);
    }
    assert.deepEqual(pieceBonds(gd, { id: unknown }), CHESS[unknown].bonds.slice(), 'prep 侧：坏 id 不进成员资格');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('作者侧同一份判据：`npm run workshop:validate` 在装之前就点名（warning，不是 error）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-trait-validate-'));
  try {
    const root = path.join(tmp, 'workshop');
    const packDir = path.join(root, 'trait-validate-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), `${JSON.stringify({
      id: 'trait-validate-pack', name: '校验器对照夹具', version: '1.0.0', license: 'CC0-1.0',
      description: 'trait.grantsBonds 的作者侧点名（test/traitGrants.test.js）', gameVersion: '0.2.x',
      content: ['chess'], overrides: [`chess:${PROBE}`],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(packDir, 'chess.json'), `${JSON.stringify({ [PROBE]: { trait: withGrants(PROBE, ['nopeShip']).trait } }, null, 2)}\n`);
    const r = spawnSync(process.execPath, [TOOL, root, '--json'], { encoding: 'utf8', timeout: 120_000 });
    const report = JSON.parse(r.stdout);
    const issues = report.packs.flatMap((p) => p.issues);
    const mine = issues.filter((i) => i.code === 'TRAIT_GRANT_UNKNOWN_BOND');
    assert.equal(mine.length, 1, `必须正好点名一条，实际：${JSON.stringify(issues)}`);
    assert.equal(mine[0].severity, 'warning', '它与 ART_UNKNOWN_ID / VOICE_UNKNOWN_OPERATOR 同类：点名的 warning');
    assert.equal(mine[0].field, 'trait.grantsBonds');
    assert.match(mine[0].message, /nopeShip/);
    assert.equal(r.status, 0, `一条 warning 不该让校验器红（引擎照样装得上）\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(issues.filter((i) => i.severity === 'error'), [], '这份差量补丁本身是干净的');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
