// test/workshopVariantsData.test.js — 口径数据通道（DESIGN §28.51）：`variants.json` = 「已有记录的另一套口径数值」。
//
// 这一层要消掉的那面墙：投稿 `c26a6ed4c1e7`（卡兹戴尔多功能）的 `payload/packs/fanpack/variants.json` ——
// `training.chess` 28 条 + `training.tokens` 4 条，是它**自带**的那些记录在满练度口径下的数值。引擎的
// `data/chess.json` 只有官方 266 条能靠 `potDown` 反推（`shared/potential.js`），包自己带来的新棋子/新召唤物
// **结构上**没有任何数值来源 —— 所以在 0.18.6 之前，这份口径只能被丢掉（`docs/WORKSHOP.md` §1.1 那张表）。
//
// 本文件钉住的判据按「闭枚举 → 三条守卫 → 真生效 → 缺省逐字节不变 → 进哈希」排：
//
//   1. **形状与闭枚举只有一份**（`shared/workshop.js` 的 `normalizeVariantDataFile`）：轴名不认识 / 数据文件名
//      不认识 / 记录 id / 补丁形状 ⇒ 各自的**拒绝码**，不是「失败了就行」。
//   2. **三条守卫，每一条都点名**：不能发明记录（`VARIANTS_TARGET_MISSING`）、不能发明字段
//      （`VARIANTS_UNKNOWN_KEY`，与 `overrides` 的闭合世界**同一条判据**）、不能发明轴
//      （`VARIANTS_UNDECLARED_AXIS` —— 「写了等于没写」正是这一层要消灭的失败方向）。
//   3. **字段级，不是整块替换**：补丁只动它写的那个叶子，目标的其余字段、同层的兄弟记录一个字节不动；
//      `data/` 的冻结对象**绝不就地改**（对象身份断言）。
//   4. **缺省逐字节不变**：不声明 `variants` 的包（或根本没装包）⇒ 数据逐字节相同、对象身份相同。
//   5. **进内容哈希**：带了 `variants.json` 的包摘要必须与「没带」不同（DESIGN §28.2 —— 同一个摘要下两种对局
//      行为是不允许的）。
//
// Run: node --test test/workshopVariantsData.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  WORKSHOP_CONTENT_FILES, normalizeContentFile,
  normalizePackManifest, applyWorkshop, workshopSummary,
} from '../shared/workshop.js';
import { VARIANT_AXIS_NAMES } from '../shared/variants.js';
import { loadWorkshop } from '../server/workshop.js';
import { loadData } from '../server/data.js';

// 动态取 `normalizeVariantDataFile`：0.18.6 之前这个导出**根本不存在**。静态 import 会让整个文件在加载期
// 就 SyntaxError，红灯落在「模块加载失败」而不是**行为**上 —— 那会连本文件其余每一条判据一起盖掉，
// 「改前红」就只剩一句「文件没加载」。这里让红灯逐条落在被测行为上（通道不存在 ⇒ 声明被拒 / 表读不出来）。
const wsMod = await import('../shared/workshop.js');
const normalizeVariantDataFile = (json) => wsMod.normalizeVariantDataFile(json);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let tmp;
before(() => { tmp = fs.mkdtempSync(join(tmpdir(), 'sp-variants-data-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 残留临时目录不算失败 */ } });

/** 一份**最小但成型**的底盘：两条官方记录（`chess` 一条、`tokens` 一条，带 variants 子表）。 */
const baseData = () => ({
  chess: {
    chess_a: { chessId: 'chess_a', name: '甲', tier: 1, status: { phase: 1, level: 55 }, stats: { atk: 482, def: 281, maxHp: 1267 } },
    chess_b: { chessId: 'chess_b', name: '乙', tier: 2, status: { phase: 2, level: 1 }, stats: { atk: 616, def: 200, maxHp: 1477 } },
  },
  tokens: {
    token_x: { tokenId: 'token_x', name: '召唤物', variants: { chess_a: { phase: 1, level: 55, stats: { atk: 82 } } } },
  },
});

/** 一份声明了口径的数据包：`files.variants` 就是 `content: ["variants"]` 读出来的那张表。 */
const packWith = (variantsTable, extra = {}) => ({
  id: 'p', overrides: [], files: { variants: variantsTable }, ...extra,
});

// ---------------------------------------------------------------------------------------------------------------
describe('形状层：闭枚举只有一份，每个码点名', () => {
  test('合法形状原样收下（三层：轴 → 数据文件 → 记录 id）', () => {
    const r = normalizeVariantDataFile({ training: { chess: { chess_a: { stats: { atk: 900 } } } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.records, { training: { chess: { chess_a: { stats: { atk: 900 } } } } });
  });

  test('拒绝路径逐条：码 + 一句人能读的理由（越界必须点名）', () => {
    const cases = [
      [null, 'VARIANTS_BAD_SHAPE'],                                    // 不是对象
      [[], 'VARIANTS_BAD_SHAPE'],                                      // 数组
      [{}, 'EMPTY_CONTENT'],                                           // 一条都不补 = 这条通道要消灭的失败方向
      [{ nope: { chess: { chess_a: { atk: 1 } } } }, 'VARIANTS_UNKNOWN_AXIS'],
      [{ training: {} }, 'VARIANTS_BAD_SHAPE'],                        // 轴下一层是空的
      [{ training: 'chess' }, 'VARIANTS_BAD_SHAPE'],
      [{ training: { nope: { chess_a: { atk: 1 } } } }, 'VARIANTS_UNKNOWN_FILE'],
      [{ training: { variants: { chess_a: { atk: 1 } } } }, 'VARIANTS_UNKNOWN_FILE'], // 不许补自己
      [{ training: { chess: {} } }, 'VARIANTS_BAD_SHAPE'],             // 一条记录都没有
      [{ training: { chess: { 'bad id!': { atk: 1 } } } }, 'VARIANTS_BAD_SHAPE'],
      [{ training: { chess: { chess_a: 5 } } }, 'VARIANTS_BAD_SHAPE'], // 补丁不是对象
      [{ training: { chess: { chess_a: {} } } }, 'VARIANTS_BAD_SHAPE'],// 空补丁
    ];
    for (const [input, code] of cases) {
      const r = normalizeVariantDataFile(input);
      assert.equal(r.ok, false, `${code} 应当被拒：${JSON.stringify(input)}`);
      assert.equal(r.error, code, `期望 ${code}，实际 ${r.error} / ${r.detail}`);
      assert.ok(r.detail.length > 0, '拒绝必须带一句人能读的理由');
    }
    // 文案里必须列出全部合法轴（作者从错误里要能看出该写哪个）
    const bad = normalizeVariantDataFile({ nope: { chess: { chess_a: { atk: 1 } } } });
    for (const axis of VARIANT_AXIS_NAMES) assert.match(bad.detail, new RegExp(`"${axis}"`), `轴名 "${axis}" 必须出现在文案里`);
  });

  test('**改前红的那一条**：`variants` 已是 `WORKSHOP_CONTENT_FILES` 的一员，`content:["variants"]` 被接受', () => {
    // 0.18.6 之前这里是 `UNKNOWN_CONTENT_FILE`（文案写着「"variants" 没有 content 通道」），旧断言逐字见
    // `test/workshopVariants.test.js` 的同名反向断言 —— 本刀把它建成正通道，那条断言就地翻转。
    assert.ok(WORKSHOP_CONTENT_FILES.includes('variants'), 'variants 必须能出现在 pack.json 的 content 里');
    const good = normalizePackManifest({ id: 'p', name: 'p', content: ['chess', 'variants'] }, 'p');
    assert.equal(good.ok, true, good.detail);
    assert.deepEqual(good.pack.content, ['chess', 'variants']);
    // `config` 依旧**没有**通道（它改的是规则，不是内容）
    assert.equal(normalizePackManifest({ id: 'p', name: 'p', content: ['config'] }, 'p').error, 'UNKNOWN_CONTENT_FILE');
    // 经 `normalizeContentFile` 转发到同一份形状判据（不出现第二份实现）
    const viaEntry = normalizeContentFile('variants', { nope: { chess: { chess_a: { atk: 1 } } } });
    assert.equal(viaEntry.error, 'VARIANTS_UNKNOWN_AXIS');
  });

  test('口径数据是**贡献项**：`content:["variants"]` 不再是 `EMPTY_PACK`；但只声明口径不写表仍然是', () => {
    // 带一张表 ⇒ 真的往对局里带了东西（记录的数值）⇒ 不是空包。
    const withTable = normalizePackManifest({
      id: 'p', name: 'p', combat: true, content: ['variants'], variants: [{ axis: 'training', default: 'full' }],
    }, 'p');
    assert.equal(withTable.ok, true, withTable.detail);
    // 只声明轴、连表都没有 ⇒ 与 `playtest` / `support` 同一条语义：什么都没带来。
    const declOnly = normalizePackManifest({
      id: 'p', name: 'p', combat: true, content: [], variants: [{ axis: 'training', default: 'full' }],
    }, 'p');
    assert.equal(declOnly.ok, false);
    assert.equal(declOnly.error, 'EMPTY_PACK');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('三条守卫：不能发明记录 / 不能发明字段 / 不能发明轴', () => {
  test('真生效：字段级补丁写进目标记录，其余字段与同层兄弟一个字节不动', () => {
    const base = baseData();
    const patch = { training: { chess: { chess_a: { stats: { atk: 900 } } } } };
    const pack = normalizePackManifest({
      id: 'p', name: 'p', combat: true, content: ['variants'], variants: [{ axis: 'training', default: 'full' }],
    }, 'p').pack;
    const { data, report } = applyWorkshop(base, [{ ...pack, files: { variants: patch } }]);
    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.equal(data.chess.chess_a.stats.atk, 900, '补丁生效');
    assert.equal(data.chess.chess_a.stats.def, 281, '没写的字段必须留着（字段级，不是整块替换）');
    assert.equal(data.chess.chess_a.stats.maxHp, 1267);
    assert.equal(data.chess.chess_a.name, '甲');
    assert.equal(data.chess.chess_b.stats.atk, 616, '同层兄弟记录一个字节不动');
    // `data/` 是冻结的：原对象绝不被就地改，而且新记录是**新对象**
    assert.equal(base.chess.chess_a.stats.atk, 482, '底盘对象不许被改');
    assert.notEqual(data.chess.chess_a, base.chess.chess_a);
    assert.notEqual(data.chess.chess_a.stats, base.chess.chess_a.stats);
    // 报告：写进去的那一条具名（启动日志据此说「口径数值 N 条」）
    assert.deepEqual(report.variantPatches, [
      { pack: 'p', axis: 'training', option: 'full', status: 'applied', file: 'chess', id: 'chess_a', keys: ['stats'] },
    ]);
    assert.match(workshopSummary(report), /口径数值 training 1 条/);
  });

  test('`tokens` 的 owner 变体同一条路（嵌套对象也是字段级）', () => {
    const base = baseData();
    const pack = normalizePackManifest({
      id: 'p', name: 'p', combat: true, content: ['variants'], variants: [{ axis: 'training', default: 'full' }],
    }, 'p').pack;
    const table = { training: { tokens: { token_x: { variants: { chess_a: { level: 90 } } } } } };
    const { data, report } = applyWorkshop(base, [{ ...pack, files: { variants: table } }]);
    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.equal(data.tokens.token_x.variants.chess_a.level, 90);
    assert.equal(data.tokens.token_x.variants.chess_a.stats.atk, 82, '同一条变体里没写的字段留着');
    assert.equal(data.tokens.token_x.name, '召唤物');
    assert.equal(base.tokens.token_x.variants.chess_a.level, 55, '底盘不许被改');
  });

  test('守卫①：目标记录不存在 ⇒ `VARIANTS_TARGET_MISSING`（这条通道不能发明记录）', () => {
    const { data, report } = applyWorkshop(baseData(), [packWith({ training: { chess: { chess_zzz: { tier: 3 } } } }, {
      id: 'p', variants: [{ axis: 'training', default: 'full' }],
    })]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'VARIANTS_TARGET_MISSING');
    assert.match(report.errors[0].reason, /"chess:chess_zzz"/);
    assert.deepEqual(data.chess.chess_zzz, undefined, '不许被发明出来');
  });

  test('守卫②：补丁写了目标没有的键 ⇒ `VARIANTS_UNKNOWN_KEY`（与 overrides 同一个闭合世界）', () => {
    const { report } = applyWorkshop(baseData(), [packWith({ training: { chess: { chess_a: { nope: 1, stats: { atk: 1 } } } } }, {
      id: 'p', variants: [{ axis: 'training', default: 'full' }],
    })]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'VARIANTS_UNKNOWN_KEY');
    assert.match(report.errors[0].reason, /"nope"/);
    // 整条补丁被拒（不是「把认识的键写进去、把不认识的丢掉」）
    assert.deepEqual(report.variantPatches, []);
  });

  test('守卫③：表写了轴却没在 `pack.json.variants` 声明 ⇒ `VARIANTS_UNDECLARED_AXIS`（不许静默）', () => {
    const base = baseData();
    const { data, report } = applyWorkshop(base, [packWith({ training: { chess: { chess_a: { stats: { atk: 900 } } } } }, { id: 'p' })]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'VARIANTS_UNDECLARED_AXIS');
    assert.match(report.errors[0].reason, /"training"/);
    // 一个字都没写进去：这条轴没人声明 ⇒ 整张表不应用，而且记录保持**同一个对象**
    assert.deepEqual(report.variantPatches, []);
    assert.equal(data.chess.chess_a, base.chess.chess_a, '一个字都没写进去');
    assert.equal(data.chess.chess_a.stats.atk, 482);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('多包抢同一个轴：小 id 赢，输的一方具名（不是静默）', () => {
  test('赢得那一个的表生效，输的那一个被点名（`status: overridden`）', () => {
    const base = baseData();
    const decl = [{ axis: 'training', default: 'full' }];
    const { data, report } = applyWorkshop(base, [
      { id: 'b-pack', variants: decl, files: { variants: { training: { chess: { chess_a: { stats: { atk: 111 } } } } } } },
      { id: 'a-pack', variants: decl, files: { variants: { training: { chess: { chess_a: { stats: { atk: 222 } } } } } } },
    ]);
    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.equal(data.chess.chess_a.stats.atk, 222, 'a-pack 的 id 字典序更小，它的表生效');
    const byPack = Object.fromEntries(report.variantPatches.map((v) => [v.pack, v]));
    assert.equal(byPack['a-pack'].status, 'applied');
    assert.equal(byPack['b-pack'].status, 'overridden');
    assert.equal(byPack['b-pack'].lostTo, 'a-pack');
    assert.match(byPack['b-pack'].reason, /smaller pack id wins/);
    // 与调用方传进来的顺序无关（与 `applyWorkshop` 的既有确定性来源同一条）
    const other = applyWorkshop(base, [
      { id: 'a-pack', variants: decl, files: { variants: { training: { chess: { chess_a: { stats: { atk: 222 } } } } } } },
      { id: 'b-pack', variants: decl, files: { variants: { training: { chess: { chess_a: { stats: { atk: 111 } } } } } } },
    ]);
    assert.equal(other.data.chess.chess_a.stats.atk, 222);
  });

  test('目标可以是**另一个包**贡献的记录（所以这一步必须在所有包并完之后）', () => {
    const base = { chess: {} };
    const { data, report } = applyWorkshop(base, [
      { id: 'a-pack', overrides: [], variants: [{ axis: 'training', default: 'full' }], files: { chess: { chess_new: { chessId: 'chess_new', stats: { atk: 10, def: 20 } } }, variants: { training: { chess: { chess_new: { stats: { atk: 30 } } } } } } },
    ]);
    assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
    assert.equal(data.chess.chess_new.stats.atk, 30);
    assert.equal(data.chess.chess_new.stats.def, 20);
    assert.equal(data.chess.chess_new.chessId, 'chess_new');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('缺省逐字节不变（承诺落在对象身份上）', () => {
  test('没有包 / 包没有 `variants.json` ⇒ 顶层逐字节相同、记录是同一个对象', () => {
    const base = baseData();
    const none = applyWorkshop(base, []);
    assert.equal(JSON.stringify(none.data), JSON.stringify(base));
    assert.deepEqual(none.report.variantPatches, []);
    // 一个声明了口径、但**不带** `variants.json` 的包：数据同样不动（口径声明自己不改数据）
    const declOnly = applyWorkshop(base, [{ id: 'p', overrides: [], variants: [{ axis: 'deploy', default: 'max' }], files: {} }]);
    assert.equal(JSON.stringify(declOnly.data), JSON.stringify(base));
    assert.deepEqual(declOnly.report.variantPatches, []);
  });

  test('`data/` 在磁盘上一个字节都没被动过（这条通道只在内存里并）', () => {
    const before = fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8');
    applyWorkshop({}, [{ id: 'p', overrides: [], variants: [{ axis: 'training', default: 'full' }], files: { variants: {} } }]);
    assert.equal(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'), before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('真装载（落盘 → loadWorkshop → loadData）与内容哈希（DESIGN §28.2）', () => {
  const writePack = (root, id, pack, files) => {
    fs.mkdirSync(join(root, id), { recursive: true });
    fs.writeFileSync(join(root, id, 'pack.json'), JSON.stringify(pack, null, 2));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(join(root, id, `${name}.json`), JSON.stringify(body, null, 2));
  };

  test('`content:["variants"]` 的包真装得进 `loadWorkshop`，表被读出来（走的是既有 `normalizeContentFile` 入口）', () => {
    const root = join(tmp, 'load');
    writePack(root, 'vd', {
      id: 'vd', name: 'Vd', combat: true, content: ['chess', 'variants'],
      variants: [{ axis: 'training', default: 'full' }],
    }, {
      chess: { chess_vd_a: { chessId: 'chess_vd_a', name: '包自带', stats: { atk: 5, def: 6 } } },
      variants: { training: { chess: { chess_vd_a: { stats: { atk: 77 } } } } },
    });
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const pack = loaded.packs.find((p) => p.id === 'vd');
    assert.ok(pack, '包必须被装载');
    assert.deepEqual(pack.files.variants, { training: { chess: { chess_vd_a: { stats: { atk: 77 } } } } });
    // 坏表在装载期点名（不是静默丢）
    const badRoot = join(tmp, 'bad');
    writePack(badRoot, 'bad', { id: 'bad', name: 'Bad', combat: true, content: ['variants'], variants: [{ axis: 'training', default: 'full' }] }, {
      variants: { nope: { chess: { chess_vd_a: { atk: 1 } } } },
    });
    const bad = loadWorkshop(badRoot, { log: quiet });
    assert.equal(bad.errors.length, 1);
    // 装载器的内容文件错误文案是既有的 `${file}.json: ${detail}` 形状（与本刀无关），所以这里断的是
    // **那句人能读的拒绝理由**本身 —— 它点名了合法轴，作者照着改就能过。
    assert.match(bad.errors[0].reason, /variants\.json\["nope"\] is not an axis of this 口径 format/);
    assert.match(bad.errors[0].reason, /"training", "form", "deploy"/);
  });

  test('带了 `variants.json` 的包摘要**必须**与「没带」不同（同一个摘要下两种行为是不允许的）', () => {
    const root = join(tmp, 'hash');
    const decl = [{ axis: 'training', default: 'full' }];
    writePack(root, 'with', { id: 'with', name: 'With', combat: true, content: ['chess', 'variants'], variants: decl }, {
      chess: { chess_h_a: { chessId: 'chess_h_a', stats: { atk: 5 } } },
      variants: { training: { chess: { chess_h_a: { stats: { atk: 77 } } } } },
    });
    writePack(root, 'without', { id: 'without', name: 'Without', combat: true, content: ['chess'], variants: decl }, {
      chess: { chess_h_a: { chessId: 'chess_h_a', stats: { atk: 5 } } },
    });
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const withT = loaded.packs.find((p) => p.id === 'with');
    const withoutT = loaded.packs.find((p) => p.id === 'without');
    assert.notEqual(withT.hash, withoutT.hash, '口径数值必须进内容哈希');
    assert.equal(loadWorkshop(root, { log: quiet }).packs.find((p) => p.id === 'with').hash, withT.hash, '摘要稳定');
  });

  test('端到端：`loadData` + 一个真装的包 ⇒ 引擎读到的就是包写的那个数', () => {
    const root = join(tmp, 'e2e');
    writePack(root, 'e2e', {
      id: 'e2e', name: 'E2E', combat: true, content: ['chess', 'variants'],
      variants: [{ axis: 'training', default: 'full' }],
    }, {
      // 覆盖一条**官方**记录的一个叶子（`overrides` 才授权改官方条目；这里连 `overrides` 一起测）
      chess: { chess_char_6_12_a: { chessId: 'chess_char_6_12_a', stats: { atk: 676 } } },
      variants: { training: { chess: { chess_char_6_12_a: { stats: { atk: 676 } } } } },
    });
    const plain = loadData(DATA_DIR, { log: quiet });
    const withPack = loadData(DATA_DIR, { log: quiet, workshopDir: root });
    // 缺省路径：官方那条记录的数值一个字节不动
    assert.equal(plain.chess.chess_char_6_12_a.stats.atk, 616);
    assert.equal(plain.chess.chess_char_6_12_a.stats.def, 200);
    // 装了包：补丁生效，没写的字段留着
    assert.equal(withPack.chess.chess_char_6_12_a.stats.atk, 676);
    assert.equal(withPack.chess.chess_char_6_12_a.stats.def, 200, '字段级：没写的字段留着');
    assert.equal(withPack.chess.chess_char_6_12_a.name, plain.chess.chess_char_6_12_a.name);
  });
});
