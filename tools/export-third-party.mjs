#!/usr/bin/env node
// tools/export-third-party.mjs — assemble everything that is NOT part of this project's GPL-covered work into one
// folder, so it can be published SEPARATELY from the repository.
//
// Why this exists (NOTICE.md §2): the game's art, fonts and the data generated from the official tables belong to
// Hypergryph / Yostar and their licensors. They are not covered by this project's GPL licence, and this project has no
// right to license them to anyone. Keeping them in their own folder means:
//
//   * the repository stays clean — a takedown is one folder removal, not an archaeology exercise;
//   * the code's licence story stays simple: everything outside `third-party/` is GPL-3.0-or-later;
//   * a player can still get a working install, because `third-party/bundle/` is uploadable as its own archive or repo.
//
// It never deletes or moves anything: it READS the tree and writes `third-party/bundle/`.
//
// Usage:
//   node tools/export-third-party.mjs                 # → third-party/bundle/
//   node tools/export-third-party.mjs --out <dir>     # elsewhere
//   node tools/export-third-party.mjs --dry-run       # list what would be written
//   node tools/export-third-party.mjs --copy          # real copies (default: hardlink when possible)
//   node tools/export-third-party.mjs --json          # machine-readable report
//
// Exit codes: 0 = written (missing sources are reported, not fatal), 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What belongs to `third-party/`, and why. Directory entries are walked recursively; file entries are taken as-is.
 * `why` is quoted straight into the generated README/NOTICE, so the bundle explains itself.
 */
export const THIRD_PARTY_SOURCES = Object.freeze([
  { path: 'public/assets', kind: 'dir', why: '《明日方舟》美术、Spine 模型与音效（tools/fetch-assets.mjs 下载，或从本机客户端提取）' },
  { path: 'public/fonts', kind: 'dir', why: '字体（各字体归其作者；不适用本项目的 GPL）' },
  { path: 'data', kind: 'glob', match: /\.json$/, exclude: /^(support|local-assets)\.json$/, why: '由官方数据表生成（tools/build-data.mjs）—— 内容是官方数据，不是本项目代码。support.json 是本项目手写的服务端配置，local-assets.json 是每台机器自己的提取清单，两者都不导出' },
  { path: 'docs/research', kind: 'dir', why: '规则与数据调研记录（含官方数据摘录）' },
  { path: 'docs/img', kind: 'dir', why: '游戏截图（官方界面，按 NOTICE.md §2 不属于本项目、不适用 GPL）' },
  { path: 'public/dev/recordings', kind: 'dir', why: '开发用的对局录像（含官方数据）' },
  { path: 'test/fixtures', kind: 'glob', match: /^official-.*\.json$/, why: '从官方数据里摘出来的测试夹具（例如官方出怪表），只有 official-* 属于这一类' },
]);

const NON_GPL_NOTICE = `# 第三方内容（不属于本项目的 GPL 覆盖范围）

本目录下的全部内容**不是** Stronghold-Protocol-Forge 作者的作品，也**不在**本项目的 GPL-3.0-or-later
授权范围内：

- 《明日方舟》及「卫戍协议」相关的名称、角色、美术、Spine 模型、界面图、音乐音效、文本与游戏数据，
  版权归上海鹰角网络科技有限公司（Hypergryph）及其授权方（Yostar 等）所有；
- 字体归各字体作者所有；
- 社区调研文本仍按其来源的许可（例如维基文本为 CC BY-NC-SA）。

这些内容**仅供学习、研究与个人非商业使用**：不得出售或付费分发、不得收费开服、不得植入广告或以本项目名义
接受打赏赞助。权利人如认为不妥，请在本仓库提交 Issue，我们会立即删除。

Everything under this directory is third-party content, is **not** covered by this project's GPL-3.0-or-later
licence, and may be used for study and personal non-commercial purposes only.
`;

const isPlainFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Every file a source contributes, as { abs, rel } — deterministic order. */
export function collectFiles(root = ROOT, sources = THIRD_PARTY_SOURCES) {
  const out = [];
  for (const src of sources) {
    const abs = path.join(root, src.path);
    if (!fs.existsSync(abs)) continue;
    if (src.kind === 'dir') {
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) out.push({ abs: p, rel: path.relative(root, p).split(path.sep).join('/'), why: src.why, src: src.path });
        }
      };
      walk(abs);
    } else if (src.kind === 'glob') {
      for (const name of fs.readdirSync(abs).sort()) {
        if (!src.match.test(name)) continue;
        if (src.exclude && src.exclude.test(name)) continue;
        const p = path.join(abs, name);
        if (isPlainFile(p)) out.push({ abs: p, rel: path.relative(root, p).split(path.sep).join('/'), why: src.why, src: src.path });
      }
    }
  }
  return out;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Hardlink when we can (same volume), so exporting a 270 MB asset tree does not double the disk usage. Falls back to a
 * real copy across volumes or when the filesystem refuses the link.
 */
function place(from, to, { copy = false } = {}) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) fs.rmSync(to, { force: true });
  if (!copy) {
    try { fs.linkSync(from, to); return 'link'; } catch { /* cross-volume or unsupported: copy */ }
  }
  fs.copyFileSync(from, to);
  return 'copy';
}

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'third-party', 'bundle'), dryRun: false, copy: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { const v = argv[++i]; if (v === undefined) throw new Error('--out needs a path'); out.out = path.resolve(v); }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--copy') out.copy = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { console.log('usage: node tools/export-third-party.mjs [--out <dir>] [--dry-run] [--copy] [--json]'); process.exit(0); }
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = collectFiles(ROOT);
  const bySource = {};
  let bytes = 0;
  const entries = [];
  for (const f of files) {
    const size = fs.statSync(f.abs).size;
    bytes += size;
    // group by the DECLARED source, not by the file's own path, so `data` reads as one row instead of one per file
    const top = f.src;
    bySource[top] = bySource[top] || { files: 0, bytes: 0 };
    bySource[top].files++;
    bySource[top].bytes += size;
    entries.push({ path: f.rel, bytes: size, sha256: sha256(f.abs), why: f.why });
  }

  const report = { out: args.out, dryRun: args.dryRun, files: entries.length, bytes, bySource, entries };
  // The console report is a SUMMARY: the full per-file list is thousands of entries (megabytes of JSON) and belongs in
  // MANIFEST.json, not on stdout — printing it here overflows a caller's pipe and makes the output unparseable.
  const summary = { out: args.out, dryRun: args.dryRun, files: entries.length, bytes, bySource, sample: entries.slice(0, 3) };
  if (args.dryRun) {
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`would export ${entries.length} file(s), ${(bytes / 1048576).toFixed(1)} MB → ${args.out}`);
      for (const [k, v] of Object.entries(bySource)) console.log(`  ${k.padEnd(28)} ${String(v.files).padStart(5)} files  ${(v.bytes / 1048576).toFixed(1)} MB`);
    }
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });
  let linked = 0;
  for (const f of files) if (place(f.abs, path.join(args.out, f.rel), { copy: args.copy }) === 'link') linked++;
  fs.writeFileSync(path.join(args.out, 'NOTICE.md'), NON_GPL_NOTICE);
  fs.writeFileSync(path.join(args.out, 'MANIFEST.json'), `${JSON.stringify({
    generatedBy: 'tools/export-third-party.mjs',
    note: 'Third-party content. NOT covered by this project\'s GPL-3.0-or-later licence. See NOTICE.md.',
    files: entries,
  }, null, 2)}\n`);

  if (args.json) console.log(JSON.stringify({ ...summary, written: true, linked }, null, 2));
  else {
    console.log(`exported ${entries.length} file(s), ${(bytes / 1048576).toFixed(1)} MB → ${args.out}`);
    console.log(`  ${linked} hardlinked, ${entries.length - linked} copied — the bundle also carries NOTICE.md + MANIFEST.json`);
    console.log('  upload this folder on its own (archive or separate repository); it is gitignored here on purpose');
  }
}

// only run when invoked directly, so the test can import collectFiles without side effects
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`export-third-party: ${e.message}`); process.exit(2); });
}
