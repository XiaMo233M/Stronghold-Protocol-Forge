// 行为开关 `diyPoolOverlap`（DESIGN §28.43 第 5 格，投稿 `stripDiyOverlaps`）—— 「自选池重叠」。
//
// 这一格要解决的那件事：一个包把一名**官方干员**做成自己的棋子，而这位干员**本来就在自选池**
// （`data/backups.json` 的 `diy.ownedPool`）里 ⇒ 他**能被上两次**，而且**自选槽绕过棋子自己的盟约**。
// 唯一对应物是 `shared/workshop.js` 的 `stripPackOperators`（fanpack G-16）。
//
// 摘除因此有**两条通道**，落到同一个动作上：
//   ① **维护者总开关** `{ apply: true }` —— 今天的口径，语义一字未动，**只**由维护者调用；
//   ② **包级声明** `behaviour: [{ switch: 'diyPoolOverlap', option: 'strip' }]` —— 作者自己说
//      「把**本包**做成棋子的那几名干员从自选池摘掉」。装载路径（`applyWorkshop`）走的就是这一条。
//   `report`（缺省）= **引擎今天的行为**：逐条点名、池子一个字节不动。
//
// 这一格还是**全表第一格「按包读取」的开关**：读取点（`stripPackOperators`）逐个包读**它自己**的
// `pack.behaviour`，**刻意不走** `mergeBehaviourDecls`。理由是一条硬语义 —— 这一格说的是「**本包**做成的
// 棋子」，不是一条全局口径；若先合并成一个值，那么「A 包声明 `strip`」会连 **B 包**的重叠一起摘掉，而 B
// 从没声明过这件事。判据③与⑤把这条钉住（③ 是行为，⑤ 是源码级「不许在这里补 merge」）。
//
// 判据走**真装载器**（临时工坊目录 → `loadWorkshop` → `applyWorkshop`），不依赖仓库里任何包的现状；
// ④ 用本机那份真投稿（`_up/newtriage2/_rw/`），没有就打印跳过。
//
// Run: node --test test/diyPoolOverlap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BEHAVIOUR_SWITCHES, BEHAVIOUR_SWITCH_NAMES, parseBehaviourDecl, behaviourActions,
  behaviourIsDefault, behaviourValue, behaviourSwitchIssues, mergeBehaviourDecls,
} from '../shared/behaviour.js';
import { stripPackOperators, applyWorkshop } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { loadData } from '../server/data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const SW = 'diyPoolOverlap';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 今天那份官方自选池（生成器产物）。`72` 是它的规模 —— 下面每一条都拿它当基准。 */
const OFFICIAL_POOL = Object.freeze([...loadData(DATA_DIR, { log: quiet, workshopDir: null }).backups.diy.ownedPool]);
const OFFICIAL_POOL_SIZE = 72;
/** 拿池里前 4 名当「被这个包做成棋子的官方干员」—— 不写死具体 id，所以数据换了这一条也不脆。 */
const FOUR = Object.freeze(OFFICIAL_POOL.slice(0, 4));

/** 一个新读的合并数据（每次都用新的一份，避免测试之间互相污染）。 */
const freshData = () => loadData(DATA_DIR, { log: quiet, workshopDir: null });
/** 一条最小的棋子记录：新 chessId + `charId` 指向一名**官方**干员（这就是"把他做成棋子"）。 */
const chessFor = (prefix, charIds) => Object.fromEntries(charIds.map((charId, i) => {
  const chessId = `chess_${prefix}_${i}_a`;
  return [chessId, { chessId, charId, name: `夹具${i}`, tier: 3 }];
}));
/** 一份最小的包清单。`combat: true` 是 `BEHAVIOUR_NEEDS_COMBAT` 那条硬闸门要求的（声明行为开关必须标）。 */
const manifestFor = (id, behaviour) => ({
  id, name: `夹具 ${id}`, version: '1.0.0', content: ['chess'], combat: true,
  ...(behaviour ? { behaviour } : {}),
});
/** 临时工坊根：`<根>/<包 id>/{pack.json,chess.json}`（加载器就是按这个布局找包的）。 */
function makeRoot(specs) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sp-ws-diypool-'));
  for (const s of specs) {
    const pd = join(dir, s.id);
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(join(pd, 'pack.json'), JSON.stringify(manifestFor(s.id, s.behaviour), null, 2), 'utf8');
    fs.writeFileSync(join(pd, 'chess.json'), JSON.stringify(chessFor(s.prefix, s.charIds), null, 2), 'utf8');
  }
  return dir;
}
/** 装载 + 叠加一条链走完；返回 `{ loaded, data, report }`。 */
function loadAndApply(root) {
  const loaded = loadWorkshop(root, { log: quiet });
  assert.deepEqual(loaded.errors, [], `夹具包必须能装载（真装载器）：${JSON.stringify(loaded.errors)}`);
  const { data, report } = applyWorkshop(freshData(), loaded.packs);
  assert.deepEqual(report.errors, [], '记录重叠不是判罚：`errors` 一条都不该加');
  return { loaded, data, report };
}

// ---------------------------------------------------------------------------------------------------------------
// ① 缺省档 = 引擎今天的行为：不声明 / 只声明 `report` ⇒ 重叠仍在，池子逐字节等于今天
// ---------------------------------------------------------------------------------------------------------------
for (const [label, behaviour] of [
  ['不声明 behaviour', null],
  ['只声明 report', [{ switch: SW, option: 'report' }]],
]) {
  test(`① ${label} ⇒ 4 条重叠逐条点名、池子一个字节不改（${OFFICIAL_POOL_SIZE} 不变）`, () => {
    const root = makeRoot([{ id: 'quiet-pack', prefix: 'quiet', charIds: FOUR, behaviour }]);
    try {
      const { data, report } = loadAndApply(root);
      assert.equal(report.overlaps.length, FOUR.length, `4 条重叠都要被点名，实际 ${report.overlaps.length}`);
      for (const o of report.overlaps) {
        assert.equal(o.inPoolBefore, true, '他是官方池里本来就有的那一位');
        assert.equal(o.poolEntry, false, '不是这个包声明进池的');
        assert.equal(o.strip, false, '缺省档下**这一条**不摘');
      }
      assert.deepEqual(report.overlaps.map((o) => o.charId).sort(), [...FOUR].sort(), '点名的就是那 4 名');
      // `strippedPool` 仍是「如果按维护者开关摘会是哪些」（语义与从前逐字相同），但 `strippedByPack` 是空的
      assert.deepEqual([...report.strippedPool].sort(), [...FOUR].sort(), '候选名单照旧列出来');
      assert.deepEqual(report.strippedByPack, [], '没有任何包声明过 strip');
      assert.equal(report.poolStripped, false, '这一次没改数据');
      assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL_SIZE);
      assert.deepEqual(data.backups.diy.ownedPool, [...OFFICIAL_POOL], '逐字节等于今天那份池子');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// ② 声明 strip ⇒ 那 4 名**被摘出**、点名到 char id、池 72→68、`operators` 记录保留
// ---------------------------------------------------------------------------------------------------------------
test('② 声明 strip ⇒ 4 名被摘出池、点名到 char id、池 72→68，而 operators 记录留着', () => {
  const root = makeRoot([{ id: 'decl-pack', prefix: 'decl', charIds: FOUR, behaviour: [{ switch: SW, option: 'strip' }] }]);
  try {
    const { data, report } = loadAndApply(root);
    assert.equal(report.overlaps.length, FOUR.length);
    for (const o of report.overlaps) assert.equal(o.strip, true, '声明了 strip ⇒ 这一条真的摘了');
    assert.deepEqual(report.strippedByPack, [...FOUR], '`strippedByPack` 逐字等于那 4 个 charId');
    assert.equal(report.poolStripped, true, '这一次真的改了数据');
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL_SIZE - FOUR.length, `池子 72 → ${OFFICIAL_POOL_SIZE - FOUR.length}`);
    for (const charId of FOUR) {
      assert.equal(data.backups.diy.ownedPool.includes(charId), false, `${charId} 不该还在池里`);
      // 摘的是**名单**（`diy.ownedPool`），不是 `diy.operators` 那条记录：界面在池外仍按 id 读它
      assert.ok(data.backups.diy.operators[charId], `${charId} 的 operators 记录必须留着`);
    }
    assert.equal(Object.keys(data.backups.diy.operators).length, Object.keys(freshData().backups.diy.operators).length,
      'operators 记录的条数不变（只动名单）');
    // 摘了谁必须能被点名：note 要说清这是**包自己**声明的
    assert.match(report.overlaps[0].note, /OWN "diyPoolOverlap": "strip" declaration/, report.overlaps[0].note);
    // 池里其余那些一位不少
    const rest = OFFICIAL_POOL.filter((id) => !FOUR.includes(id));
    assert.deepEqual(data.backups.diy.ownedPool, rest, '摘掉的就是那 4 位，别的顺序与内容都不动');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// ③ 两份包 A/B，**只有 A 声明** ⇒ 只摘 A 的、B 的重叠一条不动（这就是「按包读取、不走 merge」的理由）
// ---------------------------------------------------------------------------------------------------------------
test('③ 只有 A 声明 strip ⇒ 只摘 A 的 4 名；B 的 4 名一条不动（按包读取，不是全局口径）', () => {
  const A = OFFICIAL_POOL.slice(0, 4);
  const B = OFFICIAL_POOL.slice(4, 8);
  // 包 id 字典序：`aaa-pack` < `bbb-pack` ⇒ 若走 `mergeBehaviourDecls`，`aaa-pack` 的 strip 会赢下这一格，
  // 于是 **B 的重叠会被一起摘掉** —— 而 B 从没声明过这件事。这一条就是要挡住那个读法。
  const root = makeRoot([
    { id: 'aaa-pack', prefix: 'aa', charIds: A, behaviour: [{ switch: SW, option: 'strip' }] },
    { id: 'bbb-pack', prefix: 'bb', charIds: B, behaviour: null },
  ]);
  try {
    const { loaded, data, report } = loadAndApply(root);
    assert.equal(report.overlaps.length, A.length + B.length, '两份包的重叠都要被点名');
    assert.deepEqual(report.strippedByPack, [...A], '只摘 A 声明过的那 4 名');
    for (const charId of A) assert.equal(data.backups.diy.ownedPool.includes(charId), false, `A 的 ${charId} 该摘`);
    for (const charId of B) assert.equal(data.backups.diy.ownedPool.includes(charId), true, `B 的 ${charId} 一条不动（B 没声明过）`);
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL_SIZE - A.length, '只少 A 那 4 位');
    // 把「不走 merge」这件事说透：合并规则**确实**会给出一个全局的 strip（by aaa-pack），
    // 而读取点刻意没有用它 —— 否则 B 会被连坐。
    const merged = mergeBehaviourDecls(loaded.packs);
    assert.deepEqual(merged.decl, [{ switch: SW, option: 'strip', by: 'aaa-pack' }],
      '合并规则本身照旧会合成一个全局值（这正是**不能**在读取点用它当判据的理由）');
    assert.equal(behaviourValue(merged.decl, SW), 'strip', '合并后的值是 strip —— 若读取点读它，B 就没了');
    // B 那条重叠的 note 必须说「这是维护者的决定」，而不是「被包声明摘了」
    const bNote = report.overlaps.find((o) => o.charId === B[0]).note;
    assert.equal(/OWN "diyPoolOverlap"/.test(bNote), false, 'B 的那条不许声称是包自己声明的');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// ④ 真投稿对照（本机有那份数据就真跑，没有就打印跳过）—— 只读原件，复制到临时根再改 pack.json
// ---------------------------------------------------------------------------------------------------------------
describe_real_submissions();

function describe_real_submissions() {
  const REAL_RW = 'E:\\destop\\harness_1\\_up\\newtriage2\\_rw';
  /** 把 `<REAL_RW>/<id>/<id>` 复制进一个临时工坊根，并把第 5 格声明写进它的 `pack.json`。 */
  const realRoot = (id) => {
    const from = join(REAL_RW, id, id);
    const dir = fs.mkdtempSync(join(tmpdir(), `sp-ws-real-${id}-`));
    fs.cpSync(from, join(dir, id), { recursive: true });
    const pj = join(dir, id, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(pj, 'utf8'));
    manifest.behaviour = [{ switch: SW, option: 'strip' }];
    fs.writeFileSync(pj, JSON.stringify(manifest, null, 2), 'utf8');
    return dir;
  };

  test('④ rimbilliton（真投稿）：声明后那 4 个 ops kit 对应的干员被摘，池 72→68', (t) => {
    if (!fs.existsSync(join(REAL_RW, 'rimbilliton', 'rimbilliton', 'pack.json'))) {
      t.diagnostic(`核不到：本机没有 ${join(REAL_RW, 'rimbilliton')} —— 跳过这一条`);
      return;
    }
    // 实测（本机那份投稿）：`rimbilliton` 把 11 名官方干员做成棋子，其中 4 名本来就在自选池里 ——
    // 而那 4 名正是它复用的 4 个官方 ops kit 的干员（`@ops/op-aglna2|op-shwaz|op-ray|op-thumpy`）。
    const EXPECTED = ['char_1015_aglna2', 'char_340_shwaz', 'char_4117_ray', 'char_4235_thumpy'];
    const root = realRoot('rimbilliton');
    try {
      const { loaded, data, report } = loadAndApply(root);
      assert.deepEqual(loaded.packs.map((p) => p.id), ['rimbilliton'], '真投稿必须真的装载进来');
      assert.deepEqual(report.strippedByPack, EXPECTED, '声明 strip ⇒ 这 4 名被点名摘出');
      assert.equal(report.overlaps.length, 4, '它一共就这 4 条重叠');
      assert.equal(report.poolStripped, true);
      assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL_SIZE - 4, '池 72 → 68');
      for (const charId of EXPECTED) {
        assert.equal(data.backups.diy.ownedPool.includes(charId), false, `${charId} 该被摘`);
        assert.ok(data.backups.diy.operators[charId], `${charId} 的 operators 记录留着`);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('④ rainbow-squad（真投稿）：声明了但 0 重叠 ⇒ applied:false、池子一位不动', (t) => {
    if (!fs.existsSync(join(REAL_RW, 'rainbow-squad', 'rainbow-squad', 'pack.json'))) {
      t.diagnostic(`核不到：本机没有 ${join(REAL_RW, 'rainbow-squad')} —— 跳过这一条`);
      return;
    }
    const root = realRoot('rainbow-squad');
    try {
      const { loaded, data, report } = loadAndApply(root);
      assert.deepEqual(loaded.packs.map((p) => p.id), ['rainbow-squad'], '真投稿必须真的装载进来');
      assert.equal(report.overlaps.length, 0, '它做成的棋子一名都不在自选池里');
      assert.deepEqual(report.strippedByPack, [], '声明了 strip，但没有一条重叠可摘');
      assert.equal(report.poolStripped, false, '没有重叠 ⇒ applied:false');
      assert.deepEqual(data.backups.diy.ownedPool, [...OFFICIAL_POOL], '池子逐字节不变');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// ⑤ 真表完整性 + 「不许在读取点补 merge」的源码级断言
// ---------------------------------------------------------------------------------------------------------------
test('⑤ 真表：`behaviourSwitchIssues` 空、缺省档 `behaviourActions` 空、第 5 格形状与既有 4 格同形', () => {
  // 既有 4 格一起过：加了第 5 格之后，整张表的守卫仍然一条问题都不报（`test/packBehaviour.test.js` 的同一条判据）
  assert.deepEqual(behaviourSwitchIssues(BEHAVIOUR_SWITCHES), []);
  assert.ok(BEHAVIOUR_SWITCH_NAMES.includes(SW), `${SW} 必须在开关名清单里`);
  const spec = BEHAVIOUR_SWITCHES[SW];
  assert.ok(spec, `真表里必须有这一格：${SW}`);
  assert.deepEqual([...spec.options], ['report', 'strip']);
  assert.equal(spec.default, 'report', '缺省 = 引擎今天的行为（只报不摘）');
  assert.equal(behaviourIsDefault(null, SW), true, '没声明 = 今天的行为');
  for (const option of spec.options) {
    const decl = parseBehaviourDecl([{ switch: SW, option }]).decl;
    assert.equal(behaviourValue(decl, SW), option);
    assert.equal(behaviourIsDefault(decl, SW), option === 'report');
  }
  // 缺省档**不产生任何动作**（与另外四格的 `official` / `locked` 逐字同形）
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW }]).decl), { ok: true, actions: [] });
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'report' }]).decl), { ok: true, actions: [] });
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'strip' }]).decl),
    { ok: true, actions: [{ kind: 'diy.stripPackOverlaps', value: true }] });
});

test('⑤ 源码级：读取点读的是 `pack.behaviour`，`stripPackOperators` 里没有 `mergeBehaviourDecls`', () => {
  // 这一条钉的是**这一格唯一的读法**（判据③的行为在源码上的对应）：后人若「顺手补上 merge」，这里会红。
  const src = fs.readFileSync(join(ROOT, 'shared', 'workshop.js'), 'utf8');
  const at = src.indexOf('export function stripPackOperators');
  assert.ok(at > 0, 'stripPackOperators 必须还在（它是这一格唯一的执行点）');
  const body = src.slice(at, src.indexOf('\nexport ', at + 10));
  // 注释必须挖掉：这一格的说明里**当然**会提到 `mergeBehaviourDecls`（为了讲清「刻意不走它」）——
  // 把注释里的名字当成「真的用了它」，这条断言就会变成「不许解释自己的设计」。
  const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.match(code, /behaviourValue\(pack\.behaviour, 'diyPoolOverlap'\) === 'strip'/,
    '读取点必须逐个包读**它自己**的 pack.behaviour');
  assert.equal(/mergeBehaviourDecls\s*\(/.test(code), false,
    'stripPackOperators 里不许调用 mergeBehaviourDecls —— 合并后「A 声明」会连 B 的重叠一起摘（判据③）');
  // 而且它**只**读这一格：不许顺手读别的开关（那会让这一格的判据变成两份）
  const readSwitches = [...code.matchAll(/behaviourValue\([^,]+,\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(readSwitches, [SW], `stripPackOperators 只该读 ${SW}，实际读了 ${JSON.stringify(readSwitches)}`);
});

// ---------------------------------------------------------------------------------------------------------------
// ⑥ 返回值只增不改：维护者总开关 `{ apply: true }` 的语义一字未动
// ---------------------------------------------------------------------------------------------------------------
test('⑥ `{ apply: true }`（维护者总开关）照旧摘**全部候选**，与有没有包声明无关', () => {
  const packs = [
    { id: 'aaa-decl', behaviour: [{ switch: SW, option: 'strip' }], files: { chess: chessFor('m1', FOUR.slice(0, 2)) } },
    { id: 'bbb-quiet', files: { chess: chessFor('m2', FOUR.slice(2)) } },
  ];
  const data = structuredClone(freshData());   // `loadData` 的结果是 deepFreeze 的：摘除要在一份可写的拷贝上做
  const report = stripPackOperators(packs, data, { apply: true });
  // 从前的那三样一个不少、语义逐字相同：`stripped` 仍是「按维护者开关摘会是哪些」= 全部候选
  assert.deepEqual([...report.stripped].sort(), [...FOUR].sort(), '`stripped` 仍是全部候选');
  assert.equal(report.applied, true);
  // 新增的那一样只增不改：`declaredStripped` 只记**被包自己声明**摘掉的那些
  assert.deepEqual([...report.declaredStripped].sort(), [...FOUR.slice(0, 2)].sort(), '`declaredStripped` 只记声明过的');
  assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL_SIZE - FOUR.length, '总开关打开 ⇒ 4 名全摘');
  // 返回值形状：`overlaps` 每条都多了一个布尔 `strip`，其余字段名一字未动
  for (const o of report.overlaps) {
    assert.deepEqual(Object.keys(o).sort(),
      ['charId', 'entryFrom', 'inPoolBefore', 'note', 'pack', 'poolEntry', 'strip'],
      'overlaps 的字段集只增不改（多了 strip）');
  }
  // 没有包声明时：`declaredStripped` 空，但 `stripped` 照旧列全部候选
  const quietOnly = stripPackOperators([{ id: 'bbb-quiet', files: { chess: chessFor('m3', FOUR) } }], structuredClone(freshData()), { apply: true });
  assert.deepEqual(quietOnly.declaredStripped, [], '没人声明 ⇒ declaredStripped 空');
  assert.deepEqual([...quietOnly.stripped].sort(), [...FOUR].sort(), '但 stripped 仍是全部候选（维护者开关的语义）');
});
