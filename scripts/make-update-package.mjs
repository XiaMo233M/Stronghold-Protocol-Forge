#!/usr/bin/env node
// scripts/make-update-package.mjs — 打一个「增量更新包」（上游 0.2.1 起的机制，见 docs/DEPLOY.md）。
//
// 为什么自己写这一层：上游的 tools/package.mjs 是照着**他们的**目录布局写的（zip 根只有一个
// `Stronghold-Protocol/` 文件夹，package.json 就在它下面），而我们的发行包是 `node/ + app/ + 三个 .bat`
// 的布局，`package.json` 在 `app/` 里。所以这里只补「读上一版发行包 → 与新的 bundle 目录比对 → 产出
// UPDATE.json + 只含改动文件的 zip」这一层，其余全部复用共享实现：
//   · readZip / diffBases / updateText（tools/package-update.mjs）
//   · MANIFEST_FILE / digestFile / parseUpdate / removalProblem（server/update.js —— 启动时校验用的同一份）
//
// 两条硬规则来自 server/update.js 的路径约定：
//   1. MANIFEST.json 与 UPDATE.json 里的路径都是 **app 相对的**（服务端在 app/ 里运行），所以更新包里的
//      UPDATE.json 放在 `app/UPDATE.json`，改动的文件放在 `app/<app 相对路径>`；
//   2. 包根与 `node/` 下的文件**不进** UPDATE.json（机制管不到它们），但它们会照常随包带出去覆盖同名文件；
//      如果新版本**删掉**了这类文件，这里会拒绝出包并点名 —— 那种情况只能换完整包。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { diffBases, readZip, updateText } from '../tools/package-update.mjs';
import { MANIFEST_FILE, UPDATE_FILE, digestFile, parseManifest, parseUpdate, removalProblem } from '../server/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 一个目录下所有文件的相对路径（POSIX 分隔符），按名字排序。 */
function walk(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(dir, child, out);
    else out.push(child);
  }
  return out.sort();
}

/**
 * 读一个基准包（上一版的完整发行 zip，或它解压出来的目录）→ `{ version, files: Map<包相对路径, {size, sha256}> }`。
 * 我们的 zip 里所有条目都在**唯一一个顶层文件夹**下，这里把那一层剥掉，得到「包相对」的路径。
 */
function readBase(source) {
  const abs = path.resolve(source);
  const st = fs.statSync(abs);
  const files = new Map();
  let version = null;
  if (st.isDirectory()) {
    for (const rel of walk(abs)) {
      files.set(rel, digestFile(path.join(abs, ...rel.split('/'))));
      if (rel === 'app/package.json') version = JSON.parse(fs.readFileSync(path.join(abs, rel), 'utf8')).version;
    }
  } else {
    readZip(abs, (name, data) => {
      const slash = name.indexOf('/');
      if (slash < 0) throw new Error(`${name}：包根直接有文件（发行 zip 里所有条目都应在唯一一个顶层文件夹下）`);
      const rel = name.slice(slash + 1);
      files.set(rel, { size: data.length, sha256: sha(data) });
      if (rel === 'app/package.json') { try { version = JSON.parse(data.toString('utf8')).version; } catch { /* 下面统一报错 */ } }
    });
  }
  if (typeof version !== 'string') throw new Error(`${source} 里找不到 app/package.json 的版本号（不是我们的发行包？）`);
  return { source: abs, version, files };
}

function main(argv) {
  const o = { out: null, from: [], bundle: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') o.bundle = argv[++i];
    else if (a === '--from') o.from.push(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else { console.error(`不认识的参数：${a}`); return 2; }
  }
  if (!o.bundle || !o.from.length) { console.error(HELP); return 2; }

  const bundle = path.resolve(o.bundle);
  if (!fs.existsSync(path.join(bundle, 'app', 'package.json'))) { console.error(`✖ ${bundle} 里没有 app/package.json（--bundle 要指向打包脚本产出的那个目录）`); return 1; }
  const version = JSON.parse(fs.readFileSync(path.join(bundle, 'app', 'package.json'), 'utf8')).version;
  const manifestPath = path.join(bundle, 'app', MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) { console.error(`✖ ${bundle}/app 里没有 ${MANIFEST_FILE}（打包脚本会写它；没有它启动校验与更新都无从谈起）`); return 1; }
  parseManifest(fs.readFileSync(manifestPath, 'utf8'));   // 形状不对就别往下走了

  const bases = o.from.map(readBase);
  for (const b of bases) {
    if (b.version === version) { console.error(`✖ 基准包就是 ${version}（自己更新自己）`); return 1; }
    if (![...b.files.keys()].some((f) => f.startsWith('app/'))) { console.error(`✖ ${b.source} 里没有 app/（不是我们的发行包）`); return 1; }
  }

  // 新版本的完整文件表（包相对），MANIFEST 本身不进 update 的文件表
  const next = new Map();
  for (const rel of walk(bundle)) {
    if (rel === `app/${MANIFEST_FILE}`) continue;
    next.set(rel, digestFile(path.join(bundle, ...rel.split('/'))));
  }

  // 只有 app/ 下的路径能被 UPDATE.json 表达（服务端在 app/ 里跑），其余一律不删（进 left）
  const diff = diffBases(next, bases, { removable: (rel) => rel.startsWith('app/') && !removalProblem(rel) });

  const appShip = new Map();
  const otherShip = [];
  for (const rel of diff.ship) {
    if (rel.startsWith('app/')) appShip.set(rel.slice('app/'.length), next.get(rel));
    else otherShip.push(rel);
  }
  const goneNonApp = diff.left.filter((rel) => !rel.startsWith('app/'));
  if (goneNonApp.length) {
    console.error(`✖ 新版本不再包含这些**包根/node 下**的文件，而更新包机制删不掉它们（只能换完整包）：`);
    for (const rel of goneNonApp.slice(0, 12)) console.error(`    ${rel}`);
    return 1;
  }

  const out = path.resolve(o.out ?? path.join(path.dirname(bundle), `${path.basename(bundle)}-update.zip`));
  if (fs.existsSync(out) && !o.force) { console.error(`✖ ${out} 已存在（加 --force 覆盖）`); return 1; }
  const stage = `${out}.stage`;
  fs.rmSync(stage, { recursive: true, force: true });
  for (const [rel, d] of appShip) {
    const dst = path.join(stage, 'app', ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(bundle, 'app', ...rel.split('/')), dst);
    void d;
  }
  for (const rel of otherShip) {
    const dst = path.join(stage, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(bundle, ...rel.split('/')), dst);
  }
  fs.writeFileSync(path.join(stage, 'app', UPDATE_FILE), updateText({
    app: version, from: bases.map((b) => b.version), files: appShip, removed: diff.removed,
  }));
  parseUpdate(fs.readFileSync(path.join(stage, 'app', UPDATE_FILE), 'utf8'));   // 自己的产物先按服务端的读法验一遍

  const zip = spawnSync('tar', ['-c', '--format', 'zip', '-f', out, '-C', stage, '.'], { stdio: 'inherit' });
  if (zip.error || zip.status !== 0) { console.error('✖ 打包失败（需要 bsdtar 的 tar）'); return 1; }
  fs.rmSync(stage, { recursive: true, force: true });

  const bytes = appShip.size ? [...appShip.values()].reduce((n, d) => n + d.size, 0) : 0;
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`\n✔ 更新包已生成：${out}`);
  console.log(`  适用于：${bases.map((b) => `v${b.version}`).join(' / ')} → v${version}`);
  console.log(`  带上 ${appShip.size} 个 app 文件（${MB(bytes)}）${otherShip.length ? ` + ${otherShip.length} 个包根文件` : ''}`);
  console.log(`  删除清单：${diff.removed.length} 个（新版本不再需要的旧文件）`);
  for (const r of diff.removed.slice(0, 8)) console.log(`    - ${r.path}`);
  if (diff.removed.length > 8) console.log(`    …共 ${diff.removed.length}`);
  if (otherShip.length) { console.log('  包根/ node 下同时更新的文件（机制不校验、不删除，只覆盖）：'); for (const r of otherShip.slice(0, 8)) console.log(`    · ${r}`); }
  console.log(`  zip 大小：${mb(fs.statSync(out).size)} MB`);
  return 0;
}

const HELP = `用法：node scripts/make-update-package.mjs --bundle <新 bundle 目录> --from <上一版发行 zip> [--from …] [--out <update.zip>] [--force]

  --bundle  打包脚本（scripts/make-windows-bundle.mjs）产出的目录，里面必须有 app/MANIFEST.json
  --from    上一版的完整发行 zip（或它解压出来的目录）；可以给多个，一个更新包同时适用于它们
  --out     输出路径（默认与 bundle 同级的 <bundle>-update.zip）`;

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
export { };
