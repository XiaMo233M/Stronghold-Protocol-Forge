// tools/check-fanpack-kits.mjs — 「一干员一文件」拆包的自检工具（业主侧交付包专用）。
//
// 交付包住在 `_up/mod-compat/deliver/packs/fanpack-kazdel-rhodes/`，**不在本仓库里**（社区 mod 的内容按业主裁定
// 永不进仓库、不进发行版）。所以这个脚本对**绝对路径**工作，路径不存在时以非 0 退出并说清"为什么不适用"，
// 而不是假装通过。它把 `test/packFanpackKits.test.js` 里那几条判据 + 真战场等效性一起跑一遍，
// 给出一份可以直接贴进交付说明的报告。
//
// 用法：
//   node tools/check-fanpack-kits.mjs                          # 只做装载 + 形状 + import 判据
//   node tools/check-fanpack-kits.mjs --pack <包目录>           # 换一个交付包
//   node tools/check-fanpack-kits.mjs --equiv                   # 追加真战场等效性（需要原件 custom.js）
//   node tools/check-fanpack-kits.mjs --equiv --original <原件>
//
// 等效性为什么需要"原件"：验收标准是"拆完之后每个干员的战斗行为与原件一致"，所以对照组必须是**原件自己**
// （业主侧第三方 mod 原文），不是本仓库里的任何东西。原件不在时这一项**跳过并明确报出**，不静默略过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { kitImportIssues, kitImportDeclarations, isPackRelativeSpecifier } from '../shared/kitImports.js';
import { COLS, ROWS } from '../server/sim/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PACK_DIR = argOf('--pack', 'E:\\destop\\harness_1\\_up\\mod-compat\\deliver\\packs\\fanpack-kazdel-rhodes');
const ORIGINAL = argOf('--original', 'E:\\destop\\卫戍协议罗德岛卡兹戴尔盟约mod\\fanpack-mod\\payload\\server\\sim\\content\\kits\\custom.js');
const WANT_EQUIV = argv.includes('--equiv');

const EXPECTED = ['chess_char_9_01_a', 'chess_char_9_02_a', 'chess_char_9_04_a', 'chess_char_9_06_a', 'chess_char_9_09_a',
  'chess_char_9_10_a', 'chess_char_9_11_a', 'chess_char_9_13_a', 'chess_char_9_14_a', 'chess_char_9_16_a',
  'chess_char_9_18_a', 'chess_char_9_21_a', 'chess_char_9_22_a'];
const EXPECTED_LIB = ['bb.js', 'constants.js', 'engine.js', 'unit.js'];
const SYMBOLS = ['num', 'mods', 'talentBb', 'batPct', 'on', 'whileOn', 'neighbors', 'inRangeOf', 'tokenOf',
  'hasHp', 'periodicDamage', 'bodyInKeys', 'PRIO_REVIVE', 'configure'];

const fail = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { fail.push(m); console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`  --    ${m}`);

const KITS_DIR = path.join(PACK_DIR, 'kits');
const LIB_DIR = path.join(KITS_DIR, 'lib');

console.log(`交付包：${PACK_DIR}`);
if (!fs.existsSync(KITS_DIR)) {
  console.error(`\n不适用：交付包不在本机（${KITS_DIR}）。`);
  console.error('这个包是业主侧交付物，不进仓库、不进发行版 —— 没有它就没有可检查的对象。');
  console.error('要检查时把 --pack 指到真实的包目录（或把包放到默认位置）。');
  process.exit(2);
}

// ---------------------------------------------------------------- 1. 形状
console.log('\n=== 1. 形状（kits/ 顶层 = 干员文件；lib/ = 共享代码） ===');
const entries = fs.readdirSync(KITS_DIR, { withFileTypes: true });
const jsFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name).sort();
const libFiles = fs.existsSync(LIB_DIR) ? fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.js')).sort() : [];
console.log(`  kits/*.js   : ${jsFiles.length} → ${jsFiles.join(', ')}`);
console.log(`  kits/lib/   : ${libFiles.length} → ${libFiles.join(', ')}`);
const expectFiles = EXPECTED.map((id) => `${id}.js`).sort();
if (JSON.stringify(jsFiles) === JSON.stringify(expectFiles)) ok(`顶层恰好 ${EXPECTED.length} 个干员文件`);
else bad(`顶层文件与期望不符\n        期望 ${expectFiles.join(', ')}\n        实际 ${jsFiles.join(', ')}`);
if (JSON.stringify(libFiles) === JSON.stringify([...EXPECTED_LIB].sort())) ok(`lib/ 恰好 ${EXPECTED_LIB.length} 个辅助文件`);
else bad(`lib/ 文件与期望不符：${libFiles.join(', ')}`);

// ---------------------------------------------------------------- 2. 共享逻辑只有一份
console.log('\n=== 2. 共享逻辑只定义一次（同一段辅助不得复制进多个干员文件） ===');
const allJs = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) allJs.push(p);
  }
}(KITS_DIR));
let dup = 0;
for (const sym of SYMBOLS) {
  const holders = allJs.filter((f) => new RegExp(`^export\\s+(?:const|function|let)\\s+${sym}\\b`, 'm').test(fs.readFileSync(f, 'utf8')));
  if (holders.length !== 1) {
    dup++;
    bad(`${sym} 定义在 ${holders.length} 处：${holders.map((f) => path.relative(KITS_DIR, f)).join(', ')}`);
  }
}
if (!dup) ok(`${SYMBOLS.length} 个辅助 symbol 各自只定义一处（全部落在 lib/）`);

// ---------------------------------------------------------------- 3. import 判据
console.log('\n=== 3. import 判据（白名单 + 包内向下 ./…；没有偷偷扩大白名单） ===');
let importCount = 0;
for (const f of allJs) {
  const rel = path.relative(KITS_DIR, f);
  const src = fs.readFileSync(f, 'utf8');
  const decls = kitImportDeclarations(src);
  importCount += decls.length;
  const issues = kitImportIssues(src, decls);
  if (issues.length) bad(`${rel}: ${issues.map((i) => `${i.code} ${i.reason}`).join(' | ')}`);
  // lib/ 里的辅助文件**不得**出现 @ 前缀（实测的引擎限制）。
  if (path.dirname(f) === LIB_DIR) {
    for (const d of decls) {
      if (d.specifier.startsWith('@')) bad(`kits/lib/${path.basename(f)} 写了 "${d.specifier}"：辅助文件够不到白名单`);
      else if (!isPackRelativeSpecifier(d.specifier)) bad(`kits/lib/${path.basename(f)} 的 "${d.specifier}" 不是包相对路径`);
    }
  }
  for (const d of decls) if (d.specifier.includes('..')) bad(`${rel}: "${d.specifier}" 含 ".."（§28.18 两端不可能一致）`);
}
if (!fail.length) ok(`${allJs.length} 个文件、${importCount} 条 import 全部过判据`);

// ---------------------------------------------------------------- 4. 引擎常量守卫
console.log('\n=== 4. 引擎常量守卫（COLS / ROWS 是副本，漂了就静默错位） ===');
const constSrc = fs.readFileSync(path.join(LIB_DIR, 'constants.js'), 'utf8');
const mCols = /export let COLS = (\d+);/.exec(constSrc);
const mRows = /export let ROWS = (\d+);/.exec(constSrc);
if (!mCols || !mRows) bad('lib/constants.js 要导出 let COLS / let ROWS');
else {
  console.log(`  lib/constants.js 默认: COLS=${mCols[1]} ROWS=${mRows[1]}  引擎当前: COLS=${COLS} ROWS=${ROWS}`);
  if (Number(mCols[1]) !== COLS) bad(`COLS 默认值 ${mCols[1]} ≠ 引擎 ${COLS}`);
  if (Number(mRows[1]) !== ROWS) bad(`ROWS 默认值 ${mRows[1]} ≠ 引擎 ${ROWS}`);
  if (Number(mCols[1]) === COLS && Number(mRows[1]) === ROWS) ok('默认值与引擎一致');
}

// ---------------------------------------------------------------- 5. 真实装载
console.log('\n=== 5. 真实 loadWorkshopKits（13 件 loaded / 0 error） ===');
const loaded = loadWorkshop(path.dirname(PACK_DIR), { log: quiet });
if (loaded.errors.length) bad(`包被 loadWorkshop 拒：${JSON.stringify(loaded.errors)}`);
const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
console.log(`  content=${JSON.stringify(manifest.content)}  combat=${JSON.stringify(manifest.combat)}`);
if (!manifest.content?.includes('chess')) bad('content 没声明 "chess" ⇒ 包内 chess.json 被静默不读（§1.1 那条坑）');
else ok('content 声明了 chess');
if (manifest.combat !== true) bad('没有声明 combat: true（带 kit 的包必须声明）'); else ok('combat: true');

const data = loadData(undefined, { log: quiet, workshopDir: path.dirname(PACK_DIR) });
const kitsInData = EXPECTED.filter((id) => data.chess?.[id]);
console.log(`  合并后 chess 里 9_x 记录：${kitsInData.length}/${EXPECTED.length}`);
if (kitsInData.length !== EXPECTED.length) bad(`合并后缺记录：${EXPECTED.filter((id) => !data.chess?.[id]).join(', ')}`);

const info = await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set(Object.keys(data.chess ?? {})) });
console.log(`  loaded=${Object.keys(info.kits).length} modules=${info.modules.length} errors=${info.errors.length}`);
for (const e of info.errors) console.log(`    ${e.id}: ${e.code} — ${String(e.reason).slice(0, 200)}`);
const got = Object.keys(info.kits).sort();
if (JSON.stringify(got) === JSON.stringify([...EXPECTED].sort()) && !info.errors.length) {
  ok(`${EXPECTED.length} 件全部 loaded、0 error、默认导出都是函数`);
} else bad(`装载结果不符：got=${got.join(', ')} errors=${info.errors.length}`);

// 每一件都真跑一次构造函数（缺 skill 就是 §4.1 第一条硬规则违规）。
let built = 0;
for (const id of EXPECTED) {
  const rec = data.chess?.[id];
  if (!rec || typeof info.kits[id] !== 'function') continue;
  try {
    const kit = info.kits[id](rec.skill?.bb ?? {}, rec, rec);
    if (kit && (kit.skill || kit.skills)) built++;
    else bad(`${id}: kit 没有给 skill / skills（§4.1 第一条硬规则）`);
  } catch (e) { bad(`${id}: 构造 Kit 抛异常 ${e && e.message}`); }
}
if (built === EXPECTED.length) ok(`${built} 件都能构造出带 skill 的 Kit`);

// ---------------------------------------------------------------- 6. 等效性（可选）
console.log('\n=== 6. 真战场等效性（需要原件 custom.js） ===');
if (!WANT_EQUIV) note('未要求（加 --equiv 打开）');
else if (!fs.existsSync(ORIGINAL)) {
  note(`跳过：原件不在本机（${ORIGINAL}）。`);
  note('这一项**没有通过**，只是无法执行 —— 需要在有原件的机器上跑。');
} else {
  note(`原件：${ORIGINAL}`);
  note('完整等效性（13 件逐一对 + 2 个深度场景）由 `_up/mod-compat/out/equiv-kits.mjs` 与 `equiv-all-kits.mjs` 承担；');
  note('那两个脚本要复刻一棵「原件够得着依赖」的树（原件所在的 payload 只是上游仓库的补丁子集），');
  note('逻辑在 `_up/mod-compat/out/build-orig-tree.mjs`，都不进仓库（它们是业主侧的验收脚手架）。');
  note(`这里只核一个必要条件：原件的 13 个 kit id 与拆出来的完全一致。`);
  const probe = path.join(ROOT, '_up', 'mod-compat', 'out', 'equiv-all-kits.mjs');
  if (fs.existsSync(probe)) note(`跑：node "${probe}" "${ROOT}" "${PACK_DIR}" "${ORIGINAL}"`);
}

console.log(`\n=== 结论：${fail.length ? `${fail.length} 项失败` : '全部通过'} ===`);
for (const f of fail) console.log(`  - ${f}`);
process.exit(fail.length ? 1 : 0);
