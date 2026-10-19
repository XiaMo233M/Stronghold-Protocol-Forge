#!/usr/bin/env node
// Minimal server distribution: core game runtime and Mod API, without local game art or bundled content packs.
// Usage: node tools/package-server.mjs [--dry-run] [--list] [--out <directory>] [--force]
//        [--no-install] [--allow-dirty] [--keep-stage] [--root <checkout>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FOLDER, PLAYER_MARKDOWN, selectTracked, trackedFiles, isRefused, isJunk, dirtyFiles,
  importProblems, entryProblems, playerPackageJson, playerPackageProblems, packageOutIsUnsafe,
  zipFolder, stageProblems, scanNames, scanFiles, listTree, rewritePlayerDoc,
} from './package.mjs';
import { MANIFEST_FILE, digestFile, inManifest, parseManifest } from '../server/update.js';
import { manifestText } from './package-update.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_GUIDE = 'docs/DEPLOY-SERVER.md';
const SAMPLE_PREFIXES = ['packs/', 'docs/my-first-pack/', 'docs/examples/'];
const isExcluded = (p) => SAMPLE_PREFIXES.some((prefix) => p.startsWith(prefix));

/** A deterministic source allowlist, derived from the maintained player package allowlist. */
export function selectServerFiles(root, paths = trackedFiles(root)) {
  // 玩家包故意带一个作者测试辅助（AUTHOR_TEST_FILES: test/helpers/battleHarness.js），但**服务端版不带 test/**：
  // 它是纯 mod 管理器，作者工具链那一套发给玩家包就够了。test/package-server-profile.test.js 逐条钉这个。
  const selected = selectTracked(paths).keep.filter((p) => !isExcluded(p) && !p.startsWith('test/'));
  // Server-specific installation instructions are deliberately shipped with this profile only.
  if (paths.includes(SERVER_GUIDE) && !selected.includes(SERVER_GUIDE)) selected.push(SERVER_GUIDE);
  return [...new Set(selected)].sort();
}

/** Audit the source selection without writing files or installing dependencies. */
export function planServer(root = REPO, { allowDirty = false, env = process.env, scan = true } = {}) {
  const files = selectServerFiles(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const problems = [];
  if (!files.includes(SERVER_GUIDE)) problems.push(`missing tracked server guide: ${SERVER_GUIDE}`);
  for (const rel of files) {
    if (isRefused(rel) || isJunk(rel)) problems.push(`refused: ${rel}`);
    try { if (!fs.statSync(path.join(root, rel)).isFile()) problems.push(`not a file: ${rel}`); }
    catch { problems.push(`missing tracked file: ${rel}`); }
  }
  for (const message of importProblems(root, files)) problems.push(message);
  for (const message of entryProblems(pkg, files)) problems.push(message);
  for (const message of playerPackageProblems(pkg, files)) problems.push(message);
  if (!allowDirty) for (const rel of dirtyFiles(root, files)) problems.push(`uncommitted change: ${rel} (commit it, or --allow-dirty)`);
  const names = scanNames(env);
  let scanned = 0;
  if (scan) {
    for (const message of scanFiles(root, files, { home: true, names })) problems.push(`personal info: ${message}`);
    scanned = files.length;
  }
  return { version: pkg.version || '0.0.0', files, problems, scanned, names: names.length };
}

function bytesOf(root, files) {
  return files.reduce((sum, rel) => {
    try { return sum + fs.statSync(path.join(root, rel)).size; } catch { return sum; }
  }, 0);
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };

function copyInto(from, to, rel) {
  const source = path.join(from, rel);
  const dest = path.join(to, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(dest, fs.statSync(source).mode & 0o777);
}

function cleanTargets(targets, force) {
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    if (!force) throw new Error(`${target} already exists (pass --force to replace it)`);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function rewriteStage(stage, files, version) {
  const shipped = new Set(files);
  const packagePath = path.join(stage, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  fs.writeFileSync(packagePath, `${JSON.stringify(playerPackageJson(pkg, shipped), null, 2)}\n`);
  for (const rel of [...PLAYER_MARKDOWN, SERVER_GUIDE]) {
    if (!shipped.has(rel)) continue;
    const abs = path.join(stage, rel);
    if (!isFile(abs)) continue;
    const before = fs.readFileSync(abs, 'utf8');
    const after = rewritePlayerDoc(before, rel, shipped, version);
    if (after !== before) fs.writeFileSync(abs, after);
  }
}

/** Build a checked server ZIP. --no-install is for selection checks, not a production installable artifact. */
export function buildServer(root, plan, {
  out = path.join(os.tmpdir(), 'stronghold-server-release'),
  install = true, force = false, keepStage = false, env = process.env, log = console.log,
} = {}) {
  if (plan.problems.length) throw new Error('refusing to build: plan has problems (see the dry-run summary)');
  if (packageOutIsUnsafe(out, root)) throw new Error(`refusing to write into the repository or a parent of it: ${path.resolve(out)}`);
  const name = `${FOLDER}-v${plan.version}-server`;
  const dest = path.resolve(out);
  const work = path.join(dest, name);
  const stage = path.join(work, FOLDER);
  const zipPath = path.join(dest, `${name}.zip`);
  cleanTargets([work, zipPath], force);
  fs.mkdirSync(stage, { recursive: true });
  log(`copying ${plan.files.length} server files → ${stage}`);
  for (const rel of plan.files) copyInto(root, stage, rel);
  rewriteStage(stage, plan.files, plan.version);

  if (install) {
    log('npm ci --omit=dev …');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: stage, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (result.error || result.status !== 0) throw new Error('npm ci --omit=dev failed in the server staging directory');
    fs.rmSync(path.join(stage, 'node_modules', '.cache'), { recursive: true, force: true });
    if (!isFile(path.join(stage, 'public', 'vendor', 'pixi.min.js'))) {
      throw new Error('public/vendor/pixi.min.js missing after npm ci (postinstall tools/vendor.mjs)');
    }
  }

  const manifestEntries = new Map();
  for (const rel of listTree(stage, '', { junk: true })) {
    if (!inManifest(rel)) continue;
    const digest = digestFile(path.join(stage, rel));
    if (!digest) throw new Error(`cannot hash staged file: ${rel}`);
    manifestEntries.set(rel, digest);
  }
  fs.writeFileSync(path.join(stage, MANIFEST_FILE), manifestText({ app: plan.version, files: manifestEntries }));
  parseManifest(fs.readFileSync(path.join(stage, MANIFEST_FILE), 'utf8'));

  const { staged, problems } = stageProblems(stage, new Set([...plan.files, MANIFEST_FILE]), { env });
  if (problems.length) throw new Error(`refusing to zip server stage:\n${problems.map((x) => `  ${x}`).join('\n')}`);
  log(`zipping ${staged.length} files (${mb(bytesOf(stage, staged))}) → ${zipPath}`);
  zipFolder(work, zipPath);
  if (!keepStage) fs.rmSync(work, { recursive: true, force: true });
  return { zipPath, zipBytes: fs.statSync(zipPath).size, files: staged.length, stage: keepStage ? stage : null };
}

function parseArgs(argv) {
  const opts = { root: REPO, out: path.join(os.tmpdir(), 'stronghold-server-release'), dryRun: false, list: false, force: false, install: true, allowDirty: false, keepStage: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--list') { opts.list = true; opts.dryRun = true; }
    else if (a === '--force') opts.force = true;
    else if (a === '--no-install') opts.install = false;
    else if (a === '--allow-dirty') opts.allowDirty = true;
    else if (a === '--keep-stage') opts.keepStage = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--out' || a === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${a} needs a directory`);
      opts[a.slice(2)] = path.resolve(value);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(`server package: ${error.message}`); return 2; }
  if (opts.help) {
    console.log('usage: node tools/package-server.mjs [--dry-run] [--list] [--out <dir>] [--force] [--no-install] [--allow-dirty] [--keep-stage] [--root <checkout>]');
    return 0;
  }
  let plan;
  try { plan = planServer(opts.root, { allowDirty: opts.allowDirty }); }
  catch (error) { console.error(`server package: ${error.message}`); return 1; }
  console.log(`server profile: v${plan.version}; ${plan.files.length} tracked files; ${mb(bytesOf(opts.root, plan.files))} before npm dependencies; no art, fonts, packs, or sample payloads`);
  console.log(`core client and Mod ABI retained; personal scan: ${plan.scanned} files / ${plan.names ? 'home paths + account names' : 'home paths'}`);
  if (opts.list) for (const rel of plan.files) console.log(`file ${rel}`);
  if (plan.problems.length) {
    console.error(`PROBLEMS (${plan.problems.length}):\n${plan.problems.map((x) => `  ${x}`).join('\n')}`);
    return 1;
  }
  if (opts.dryRun) { console.log('checks: ok (dry-run; nothing copied or installed)'); return 0; }
  try {
    const result = buildServer(opts.root, plan, opts);
    console.log(`zip: ${result.zipPath} (${mb(result.zipBytes)}, ${result.files} files)${result.stage ? ` · stage kept: ${result.stage}` : ''}`);
    return 0;
  } catch (error) {
    console.error(`server package: ${error.message}`);
    return 1;
  }
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) process.exitCode = main(process.argv.slice(2));
