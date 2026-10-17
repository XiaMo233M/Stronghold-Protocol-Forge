#!/usr/bin/env node
// tools/mod-pack.mjs — **作者侧**的打包与校验：把一个「项目目录」变成能拖进 mod 目录的 `.zip`，
// 以及在不安装的前提下校验一个别人发来的 `.zip`。
//
// 与 `tools/workshop-pack.mjs` 的分工（这一条必须写清楚，否则会出现两份互相漂移的规则）：
//   * `workshop-pack.mjs export <id>` —— **已安装**的包（`workshop/<id>/`）导出，目录名必须等于 id；
//   * `mod-pack.mjs pack <dir>` —— 作者手上的**项目目录**，目录名**不必**等于 `pack.json.id`，
//     校验与打包规则全部复用同一批函数（`normalizePackManifest` / `zipWrite` / `ZIP_LIMITS`），
//     所以「这里打出来的包」与「编辑器导出的包」在同一个输入下是同一份字节。
//
// 三种形态（docs/MOD-PROJECT.md）：
//   项目形态  my-mod/{pack.json, chess.json, kits/, assets/, README.md}   ← 你写东西的地方
//   交付形态  my-mod.zip（pack.json 在根，或唯一顶层目录）                ← 发给别人的东西
//   安装形态  workshop/<pack.json.id>/…                                   ← 引擎读的东西
//
// 用法：
//   node tools/mod-pack.mjs pack <项目目录> [-o <输出.zip>] [--json]
//   node tools/mod-pack.mjs check <项目目录|zip 文件> [--json]
//
// 退出码：0 = 成功；1 = 内容不合法（拒绝）；2 = 用法错误。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { zipWrite, zipRead, ZIP_LIMITS } from '../shared/zip.js';
import { normalizePackManifest, PACK_ID_RE } from '../shared/workshop.js';
import { packFilesRecursive, manifestPrefix, refuse, usageError, mb } from './workshop-pack.mjs';

const USAGE = [
  'usage:',
  '  node tools/mod-pack.mjs pack <项目目录> [-o <输出.zip>] [--json]',
  '  node tools/mod-pack.mjs check <项目目录|某个.zip> [--json]',
  '',
  '  pack   读 <项目目录>/pack.json，校验后打出一个确定性 zip（同输入 ⇒ 同字节）',
  '  check  只校验、不安装：目录走清单校验；zip 走「读归档 + 内存里校验清单」，不落盘',
  '',
  '  -o      输出路径（缺省 <项目目录>/dist/<id>.zip）',
  '  --json  机器可读输出',
].join('\n');

// 项目目录里**不进包**的三类东西。这是一处**刻意**的偏离：`server/packFiles.js listPackFiles`
// 对已安装的包「没有任何排除项」（README/*.bak 都进哈希），因为那时候包已经是要被精确识别的东西。
// 但项目目录是作者的**工作树**：`.git` 与 `node_modules` 进去会让同一份内容每次都得到不同字节（体积也爆），
// 输出的 zip 自己在里面则会让第二次打包把第一次的产物装进去。这三条写进 docs/MOD-PROJECT.md。
const PROJECT_EXCLUDES = Object.freeze(['.git', 'node_modules']);

/** 递归收集项目文件，跳过 PROJECT_EXCLUDES 与输出文件本身。 */
function collectProjectFiles(dir, { excludeAbs = [] } = {}) {
  const skip = new Set((Array.isArray(excludeAbs) ? excludeAbs : [excludeAbs]).filter(Boolean).map((p) => path.resolve(p)));
  const out = [];
  const walk = (absDir, rel) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (PROJECT_EXCLUDES.includes(entry.name)) continue;
        walk(abs, childRel);
      } else if (entry.isFile()) {
        if (skip.has(path.resolve(abs))) continue;   // 不要把自己（显式 -o 或默认 dist 产物）打进去
        out.push({ name: childRel, abs });
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 读项目目录的清单并校验。返回 `{ raw, pack, files }`。 */
function readProject(dir) {
  const manifestPath = path.join(dir, 'pack.json');
  if (!fs.existsSync(manifestPath)) {
    throw refuse(`${dir} 里没有 pack.json —— 项目目录的根必须有它（docs/MOD-PROJECT.md）`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw refuse(`pack.json 不是合法 JSON：${e.message}`);
  }
  // **项目形态必须显式写 `id`**：安装形态里 id 取自目录名（`loadWorkshop` 就是这么读的），但项目目录叫什么都行
  // （`my-mod`、`我的第一个包`…），拿目录名当 id 会得到一个既不可预测也不合法的身份。所以这里先要求它，
  // 而不是让 normalizePackManifest 用空名字兜底后报一个看不懂的 BAD_PACK_ID。
  if (typeof raw?.id !== 'string' || !raw.id.trim()) {
    throw refuse('项目目录的 pack.json 必须显式写 "id"（安装时目录名会由它决定，不能靠文件夹名猜）：'
      + '例如 "id": "my-first-pack"。它只能字母/数字开头，含字母数字下划线短横线，≤32。');
  }
  // 与安装器、与游戏加载器**同一个函数**：这里给绿，装进去就一定绿
  const checked = normalizePackManifest(raw, '', { hasAssets: fs.existsSync(path.join(dir, 'assets')) });
  if (!checked.ok) throw refuse(`pack.json 校验不过（${checked.error}）：${checked.detail}`);
  const id = checked.pack.id;
  if (!PACK_ID_RE.test(id)) throw refuse(`pack.json 的 id "${id}" 不是合法的包 id（字母/数字开头，只能字母数字下划线短横线，≤32）`);
  // 声明了内容却没给文件：安装后加载器会在这个包上记一条 `chess.json: …` 并整表丢掉，
  // 所以打包前就拒。映射口径与加载器一致：`content: ["chess"]` ⇒ 读 `<dir>/chess.json`（server/workshop.js:152）。
  const missing = [];
  for (const name of Array.isArray(checked.pack.content) ? checked.pack.content : []) {
    if (typeof name !== 'string' || !name) continue;
    const rel = name.endsWith('.json') ? name : `${name}.json`;
    if (!fs.existsSync(path.join(dir, rel))) missing.push(rel);
  }
  if (missing.length) throw refuse(`pack.json 的 content 声明了这些内容文件，但项目目录里没有：${missing.join('、')}`);
  return { raw, pack: checked.pack, id };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function checkLimits(files, buffer) {
  const rawTotal = files.reduce((n, f) => n + f.data.length, 0);
  if (buffer.length > ZIP_LIMITS.maxTotalBytes) {
    throw refuse(`打出来的 zip 有 ${mb(buffer.length)}，超过 ${mb(ZIP_LIMITS.maxTotalBytes)} 的导入上限：装它的人会直接失败`);
  }
  if (rawTotal > ZIP_LIMITS.maxTotalBytes) {
    throw refuse(`解开后有 ${mb(rawTotal)}，超过 ${mb(ZIP_LIMITS.maxTotalBytes)} 的导入上限：装它的人会直接失败`);
  }
  if (files.length > ZIP_LIMITS.maxEntries) {
    throw refuse(`有 ${files.length} 个文件，超过 ${ZIP_LIMITS.maxEntries} 个的上限`);
  }
  const tooBig = files.filter((f) => f.data.length > ZIP_LIMITS.maxFileBytes);
  if (tooBig.length) {
    throw refuse(`这些文件单个就超过 ${mb(ZIP_LIMITS.maxFileBytes)}：${tooBig.map((f) => f.name).join('、')}`);
  }
  return { rawTotal };
}

function cmdPack(dirArg, { out = null, json = false } = {}) {
  const dir = path.resolve(dirArg);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw usageError(`${dirArg} 不是一个目录`);
  const { pack, id } = readProject(dir);
  const defaultOut = path.join(dir, 'dist', `${id}.zip`);
  const outPath = path.resolve(out ?? defaultOut);
  // 排除**两个**产物路径：显式 `-o` 那个，以及默认的 `dist/<id>.zip`。只排除前者时，连续打包会把上一次的
  // 默认产物装进新包（实测：第二次打包的条目里多出 `dist/<id>.zip`），那样的包既是自指的、又会随次数膨胀。
  const entries = collectProjectFiles(dir, { excludeAbs: [outPath, defaultOut] });
  const files = entries.map((e) => ({ name: e.name, data: fs.readFileSync(e.abs) }));
  if (!files.some((f) => f.name === 'pack.json')) throw refuse('收集到的文件里没有 pack.json（不该发生，检查项目目录结构）');
  const buffer = zipWrite(files);
  const { rawTotal } = checkLimits(files, buffer);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  const report = {
    ok: true, id, out: outPath, entries: files.length,
    bytes: buffer.length, rawBytes: rawTotal, sha256: sha256(buffer),
    content: pack.content ?? [], name: pack.name ?? null, version: pack.version ?? null,
  };
  if (json) return report;
  console.log(`已打包 ${id}：${files.length} 个文件，${mb(buffer.length)}（解开 ${mb(rawTotal)}）`);
  console.log(`  ${outPath}`);
  console.log(`  sha256 ${report.sha256}`);
  console.log('把它拖进 workshop/（或 .mod-inbox/）即安装。包尚未启用。');
  return report;
}

function cmdCheck(targetArg, { json = false } = {}) {
  const target = path.resolve(targetArg);
  if (!fs.existsSync(target)) throw usageError(`${targetArg} 不存在`);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const { pack, id } = readProject(target);
    // 与 `pack` 同一套排除：不把默认产物算进"这个项目有几个文件"
    const entries = collectProjectFiles(target, { excludeAbs: path.join(target, 'dist', `${id}.zip`) });
    const files = entries.map((e) => ({ name: e.name, data: fs.readFileSync(e.abs) }));
    const buffer = zipWrite(files);
    const { rawTotal } = checkLimits(files, buffer);
    const report = { ok: true, kind: 'dir', id, entries: files.length, bytes: buffer.length, rawBytes: rawTotal, content: pack.content ?? [] };
    if (json) return report;
    console.log(`目录可用：${id}，${files.length} 个文件，打包后 ${mb(buffer.length)}（解开 ${mb(rawTotal)}）`);
    return report;
  }
  // zip：读归档（zipRead 已经把 zip-slip / 超限 / 加密 / ZIP64 / CRC 全判过一遍），再在**内存里**校验清单
  const read = zipRead(fs.readFileSync(target));
  if (!read.ok) throw refuse(`这个 zip 读不了：[${read.error}] ${read.detail}`);
  const names = read.entries.map((e) => e.name);
  const prefix = manifestPrefix(names);
  const manifestEntry = read.entries.find((e) => e.name === `${prefix}pack.json`);
  if (!manifestEntry) throw refuse('归档里没有 pack.json（既不在根，也没有唯一的顶层目录包含它）');
  let raw;
  try {
    raw = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (e) {
    throw refuse(`归档里的 pack.json 不是合法 JSON：${e.message}`);
  }
  const hasAssets = names.some((n) => n === `${prefix}assets/` || n.startsWith(`${prefix}assets/`));
  const checked = normalizePackManifest(raw, '', { hasAssets });
  if (!checked.ok) throw refuse(`归档里的 pack.json 校验不过（${checked.error}）：${checked.detail}`);
  const id = checked.pack.id;
  if (!PACK_ID_RE.test(id)) throw refuse(`归档里的 id "${id}" 不是合法的包 id`);
  const rawTotal = read.entries.reduce((n, e) => n + e.data.length, 0);
  const report = {
    ok: true, kind: 'zip', id, prefix, entries: read.entries.length,
    rawBytes: rawTotal, content: checked.pack.content ?? [], sha256: sha256(fs.readFileSync(target)),
  };
  if (json) return report;
  console.log(`zip 可用：${id}（顶层前缀 ${JSON.stringify(prefix)}），${read.entries.length} 个条目，解开 ${mb(rawTotal)}`);
  console.log('装上之前不需要解压 —— 这条检查就是在内存里做的。');
  return report;
}

function main(argv) {
  const args = [...argv];
  const json = args.includes('--json');
  const outIdx = args.indexOf('-o');
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const positional = args.filter((a) => !a.startsWith('-'));
  const command = positional[0];
  if (!command || args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === 'pack') {
    if (positional.length !== 2) throw usageError(`pack 需要一个项目目录\n${USAGE}`);
    const r = cmdPack(positional[1], { out, json });
    if (json) console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (command === 'check') {
    if (positional.length !== 2) throw usageError(`check 需要一个目录或 zip\n${USAGE}`);
    const r = cmdCheck(positional[1], { json });
    if (json) console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  throw usageError(`未知子命令 "${command}"\n${USAGE}`);
}

// 只在**作为脚本运行**时跑 CLI（被测试 import 时不能执行）：与 `tools/workshop-pack.mjs` 同一个写法。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // 拒绝＝1、用法错误＝2；两种都必须留下人话，而不是堆栈
    const code = e && e.usage ? 2 : e && e.refused ? 1 : 2;
    console.error(`mod-pack: ${e && e.message ? e.message : e}`);
    process.exitCode = code;
  }
}
