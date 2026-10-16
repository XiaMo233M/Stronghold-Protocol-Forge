#!/usr/bin/env node
// tools/workshop-validate.mjs — validate 创意工坊 packs against the format AND against the real engine
// (docs/WORKSHOP.md). This is the check an author runs, and the one an AI calls in a self-correction loop.
//
// Usage:
//   node tools/workshop-validate.mjs                      # every pack under workshop/
//   node tools/workshop-validate.mjs <dir>                # one pack directory, or a workshop root
//   node tools/workshop-validate.mjs --workshop <root>    # explicit pack root
//   node tools/workshop-validate.mjs --json               # machine-readable report
//
// It checks the layers cheapest-first: pack format → record semantics → the real engine → then one layer per content
// kind (kits, stages/maps, enemies/monsters, waves, items, a pack's voice lines, its item icons, its 外观素材
// (avatars / portraits / spine models), its 助战 declarations and its static routes), each
// re-deriving what the engine derives. Layer 3 is what catches a record that is syntactically valid but silently
// unplayable.
//
// Exit codes: 0 = no errors (warnings allowed), 1 = errors found, 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { formatIssues } from '../shared/chessAuthoring.js';
import { WORKSHOP_DIR } from '../server/workshop.js';
// 判据本体在 shared/workshopValidate.mjs —— **CLI 与编辑器界面的「校验这个包」是同一个函数**。
// 2026-10-13 之前判据全在这个文件里，而它是维护者工具（不在 tools/package.mjs 的 PLAYER_TOOLS 里、不随玩家包
// 发出），所以编辑器服务端 import 它会当场崩 ⇒ 界面拿不到第 3 层（真引擎装载）。搬进 shared/ 之后，
// `node tools/workshop-validate.mjs` 与界面上那个按钮**结构上不可能**给出不同结论。
import { validateWorkshop } from '../shared/workshopValidate.mjs';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const USAGE = `usage: node tools/workshop-validate.mjs [dir] [--workshop <root>] [--json]`;

function parseArgs(argv) {
  const out = { dir: null, workshop: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--workshop') { out.workshop = argv[++i]; if (out.workshop === undefined) throw new Error('--workshop needs a path'); }
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (out.dir === null) out.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

/** A pack directory carries pack.json; anything else is treated as a workshop root. */
function resolveRoots(dir) {
  if (dir === null) return { root: WORKSHOP_DIR, only: null };
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  return fs.existsSync(path.join(abs, 'pack.json')) ? { root: path.dirname(abs), only: path.basename(abs) } : { root: abs, only: null };
}

/** 分层打印的标题。键 = `report.checks[].kind`，顺序由 `validateWorkshop` 的推入顺序决定（与合并前一致）。 */
const KIND_TITLES = {
  voice: '\nvoice lines:',
  itemIcon: '\nitem icons:',
  art: '\nappearance assets (pack.json 的 art):',
  support: '\nsupport (助战):',
  kit: '\nbehaviour layer (kits/):',
  stage: '\nstages (maps):',
  enemy: '\nenemies (monsters):',
  wave: '\nwaves (每关出怪):',
  item: '\nitems (装备):',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // `--workshop <root>` used to be parsed and documented but never read, so it silently validated the default
  // workshop/ directory and could print a green VALID for the wrong tree. It now wins over the positional argument.
  const { root, only } = resolveRoots(args.workshop ?? args.dir);
  const report = await validateWorkshop({ root, only, log: quiet });
  // ⚠️ `missing` 有两种真相：「磁盘上没这个 id」与「这个包**装载期就被拒**」。从前两种都只喊一句
  // `no loadable pack`，作者看不到真因（2026-10-15 实测：真实原因是 `PACK_UNKNOWN_FIELD`）。
  // `validateWorkshop` 现在把装载器的错一并回在 `loadErrors` 里，这里把它接进那句话。
  if (report.missing) {
    // 装载器的错形状是 `{ pack, reason }`（码**嵌在 reason 前缀里**，例如 `PACK_UNKNOWN_FIELD: …`），
    // 与 `packVerdict` 读法一致 —— 所以这里只取 `reason`，别去假设一个不存在的 `code` 字段。
    const detail = (report.loadErrors ?? []).map((e) => e.reason ?? String(e)).join(' · ');
    throw new Error(`no loadable pack named "${only}" under ${root}${detail ? `（装载错误：${detail}）` : ''}`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    // 别用 process.exit() 收尾：POSIX 上 stdout 到管道是**异步写**，一次 240 KB 级的 JSON（184 条棋子的包）
    // 会在 flush 完成前被 exit 截断 —— 下游拿到的就是半截 JSON，看起来像「校验器崩溃」（Windows 的管道是
    // 同步写，所以本机不复现）。exitCode + 自然退出是 Node 文档针对这个坑的写法，退出码语义不变。
    // ⚠️ 这个 return 不能省：process.exit() 会**终止进程**，而设 exitCode 只是记下退出码；少了 return 会继续
    // 往下跑下面那段人类可读报告，同一份报告被打两遍。
    process.exitCode = report.errors ? 1 : 0;
    return;
  }

  console.log(`workshop root: ${root}`);
  if (!report.packs.length && !report.foreign.length) console.log('  no packs found');
  for (const p of report.packs) {
    // 包头的概述（与合并前逐字一致：`pack <id> (<名字>) — <内容文件> + <N voice line(s)> …`）——
    // 各层的计数由 `validateWorkshop` 挂在这一行上（`voices` / `voiceLangs` / `itemIcons` / `art` / `support`）。
    const bits = [];
    if (p.files && p.files.length) bits.push(p.files.join(', '));
    if (p.voices) bits.push(`${p.voices.lines} voice line(s) for ${p.voices.operators} operator(s)`);
    if (p.voiceLangs) bits.push(`${p.voiceLangs.lines} line(s) in ${p.voiceLangs.langs.join('/')}`);
    if (p.itemIcons) bits.push(`${p.itemIcons} item icon(s)`);
    if (p.art) bits.push(`${p.art} art entr${p.art === 1 ? 'y' : 'ies'}`);
    if (p.support) bits.push(`助战: ${p.support.join(', ')}`);
    console.log(`\npack ${p.pack}${p.name ? ` (${p.name})` : ''}${bits.length ? ` — ${bits.join(' + ')}` : ''}`);
    if (!p.issues.length) console.log('  OK');
    else console.log(formatIssues(p.issues).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  if (report.engine.length) {
    console.log('\nengine checks:');
    console.log(formatIssues(report.engine).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  // 静态路由那一条：问题同时写进了各包的 `issues`（`--json` 的既有形状），这里再按层单列一段。
  if (report.routes?.length) {
    console.log('\nstatic routes (pack.json 的 routes):');
    console.log(formatIssues(report.routes).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  // 按层归拢（合并前是十段各自 console.log；现在同一份 `checks[]` 按 `kind` 分组，标题与顺序保持不变）。
  // art / route / itemIcon 不在 `checks[]` 里（它们的文本形状印在包那一行），所以这里只剩这几层。
  const byKind = new Map();
  for (const c of report.checks) {
    if (!(c.views ?? ['checks']).includes('checks')) continue;
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }
  // 一层只带问题条目（`checks[]` 里没有它的条目就说明它一条都没报），所以按登记的分层数组补出「干净也要打印」
  // 的那几段 —— items 在 `validateWorkshop` 里**无条件**登记（与合并前一致）。
  for (const [key, kind] of [['items', 'item'], ['stages', 'stage'], ['enemies', 'enemy'], ['waves', 'wave']]) {
    if (Array.isArray(report[key]) && !byKind.has(kind)) byKind.set(kind, []);
  }
  for (const [kind, list] of byKind) {
    console.log(KIND_TITLES[kind] ?? `\n${kind}:`);
    console.log(list.length ? formatIssues(list).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
  }
  console.log(`\n${report.errors} error(s), ${report.warnings} warning(s)`);
  if (report.errors === 0) console.log('VALID: the engine accepts this content.');
  // 「接受」与「装载」是两件事（DESIGN §28.46）：收尾那一句不能让人以为报告里的每一个包都进游戏。
  if (report.foreign.length) {
    console.log(`NOTE: ${report.foreign.length} pack(s) target another host ("stardust") — this engine recognises them but does not load them (see the WARN lines above).`);
  }
  // 同 --json 分支：大份报告在 POSIX 管道上是异步写，process.exit() 会截断 —— 用 exitCode 自然退出。
  // 这里不需要 return：本行已是 main() 的最后一句。
  process.exitCode = report.errors ? 1 : 0;
}

main().catch((e) => {
  console.error(`workshop-validate: ${e.message}`);
  console.error(USAGE);
  process.exit(2);
});
