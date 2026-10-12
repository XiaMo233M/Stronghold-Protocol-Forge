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
//   3. **工作区必须干净**（与 scripts/make-windows-bundle.mjs 同一条纪律，同一份判据）：`--bundle` 目录里
//      的文件是打包脚本从**工作区磁盘**拷出来的，而更新包的「从哪来、到哪去」靠包内 `app/package.json` 的
//      `release` 与 MANIFEST.json 认。脏工作区打出的更新包会把工作区那份内容当成「这一版」，与 tag 对不上。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// compareVersions 用在**排序**上（更新包只往上走），身份判断不用它：它只认恰好 `x.y.z[-pre]`，
// 而发行标识是 `0.15.0-0.2.4` 这种两段串，喂给它只会抛 not a version。
import { compareVersions, diffBases, readZip, updateText } from '../tools/package-update.mjs';
import { MANIFEST_FILE, UPDATE_FILE, digestFile, parseManifest, parseUpdate, removalProblem } from '../server/update.js';
// 工作区守卫与本仓库的打包脚本**共用同一份实现**（`worktreeStatus` / `assertCleanWorktree` /
// `worktreeGuardExit`）：两个脚本说的是同一条纪律（清单来自 git、内容来自磁盘），判据分家就会漂。
// import 那个模块只会定义常量与函数 —— 它的 `main()` 由 `isMain()` 挡着，import 时不会跑。
import { worktreeGuardExit } from './make-windows-bundle.mjs';

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
 * 读一个基准包（上一版的完整发行 zip，或它解压出来的目录）
 * → `{ version, release, files: Map<包相对路径, {size, sha256}> }`。
 * 我们的 zip 里所有条目都在**唯一一个顶层文件夹**下，这里把那一层剥掉，得到「包相对」的路径。
 *
 * `release` 是 `app/package.json` 的 `release` —— **发行标识**（`0.14.0-0.2.4`，tag `v` 后面那一串）。
 * `version` 只是本仓库那一半（`0.14.0`）：两个只差上游的发行在它眼里一模一样，所以身份判断不能用它。
 * 0.14.0-0.2.3 及更早的包没有这个字段，那时 `release` 是 null（见 candidateIdentity）。
 */
function readBase(source) {
  const abs = path.resolve(source);
  const st = fs.statSync(abs);
  const files = new Map();
  let version = null;
  let release = null;
  const learn = (text) => {
    const j = JSON.parse(text);
    version = j.version;
    if (typeof j.release === 'string' && j.release) release = j.release;
  };
  const manifestRel = `app/${MANIFEST_FILE}`;
  if (st.isDirectory()) {
    for (const rel of walk(abs)) {
      files.set(rel, digestFile(path.join(abs, ...rel.split('/'))));
      if (rel === 'app/package.json') { try { learn(fs.readFileSync(path.join(abs, rel), 'utf8')); } catch { /* 下面统一报错 */ } }
    }
  } else {
    readZip(abs, (name, data) => {
      const slash = name.indexOf('/');
      if (slash < 0) throw new Error(`${name}：包根直接有文件（发行 zip 里所有条目都应在唯一一个顶层文件夹下）`);
      const rel = name.slice(slash + 1);
      files.set(rel, { size: data.length, sha256: sha(data) });
      if (rel === 'app/package.json') { try { learn(data.toString('utf8')); } catch { /* 下面统一报错 */ } }
    });
  }
  if (typeof version !== 'string') throw new Error(`${source} 里找不到 app/package.json 的版本号（不是我们的发行包？）`);
  // 构建指纹 = 基准包自己那份 MANIFEST.json 的 sha256：它把「程序文件 + 大小 + sha256」整张表钉死，
  // 两份字节完全相同当且仅当是同一个包 —— 「自己更新自己」由此判定，不靠版本号里有没有 release。
  const fingerprint = files.get(manifestRel)?.sha256 ?? null;
  return { source: abs, version, release, fingerprint, files };
}

/**
 * 发行包的身份：**发行标识**（`0.14.0-0.2.4`，tag `v` 后面那一串，来自包内 `app/package.json` 的 `release`）
 * 加**构建指纹**（包内 `app/MANIFEST.json` 的 sha256）。
 *
 * 两者分工，是踩过一次坑之后定下来的：
 *   * `release` 说「这是哪一次发行」——「只抬上游」的下一版就靠它和上一版区分开（`version` 那一半相同，说不清）；
 *   * `fingerprint` 说「这是不是同一个包」——旧包（0.14.0-0.2.3 及更早）没有 `release`，
 *     但两份 MANIFEST.json 字节完全相同就等于同一个包，「自己更新自己」照样拒绝。
 *     所以这里**绝不退回比 `version` 相等**：那会把「旧 → 旧」这一对合法的升级误杀。
 *   * 排序（更新包只往上走）用 `version`（纯三段 semver）——`release` 是两段串，比较器不认它。
 * @param {{ version: string, release: string|null, fingerprint: string|null }} b
 */
export function candidateIdentity(b) {
  return { release: b.release, fingerprint: b.fingerprint };
}

/**
 * 两个身份是不是同一个包：**构建指纹相同**（字节级同一份），或**发行标识相同**（同一次发行的重复打包）。 */
export function samePackage(a, b) {
  if (a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) return true;
  return !!a.release && a.release === b.release;
}

/** 身份的显示形式：有 `release` 用它（说得清是哪一次发行），否则退回 `version`。 */
export function identityLabel(b) {
  return b.release || b.version;
}

function main(argv) {
  const o = { out: null, from: [], bundle: null, force: false, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') o.bundle = argv[++i];
    else if (a === '--from') o.from.push(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a === '--allow-dirty') o.allowDirty = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); return 0; }
    else { console.error(`不认识的参数：${a}`); return 2; }
  }
  if (!o.bundle || !o.from.length) { console.error(HELP); return 2; }

  const bundle = path.resolve(o.bundle);
  if (!fs.existsSync(path.join(bundle, 'app', 'package.json'))) { console.error(`✖ ${bundle} 里没有 app/package.json（--bundle 要指向打包脚本产出的那个目录）`); return 1; }
  const pkg = JSON.parse(fs.readFileSync(path.join(bundle, 'app', 'package.json'), 'utf8'));
  const version = pkg.version;
  const manifestPath = path.join(bundle, 'app', MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) { console.error(`✖ ${bundle}/app 里没有 ${MANIFEST_FILE}（打包脚本会写它；没有它启动校验与更新都无从谈起）`); return 1; }
  parseManifest(fs.readFileSync(manifestPath, 'utf8'));   // 形状不对就别往下走了

  const bases = o.from.map(readBase);
  // 这一版自己的身份：发行标识（包内 app/package.json 的 release）+ 构建指纹（包内 app/MANIFEST.json 的 sha256）。
  // 打包脚本（scripts/make-windows-bundle.mjs）把 release 写进包内，所以两种信息都随包走，不需要外部再传参数。
  const thisRelease = typeof pkg.release === 'string' && pkg.release ? pkg.release : null;
  const nextIdentity = candidateIdentity({ version, release: thisRelease, fingerprint: sha(fs.readFileSync(manifestPath)) });
  // ① 同一个包：指纹相同（字节级同一份），或发行标识相同（同一次发行的重复打包）。这一条必须先判，否则
  //    两个字节相同的旧包会先撞上下面「没有 release」那条，报出与事实不符的原因。
  const twin = bases.find((b) => samePackage(candidateIdentity(b), nextIdentity));
  if (twin) {
    console.error(`✖ 基准包就是这一版（${identityLabel({ release: twin.release, version: twin.version })}）：`
      + `自己更新自己只会把同样的文件重发一遍 —— 请直接用完整包，或换一个更早的版本当基准。`);
    return 1;
  }
  // ② 这一版没盖章（release 字段是后来才加的）：只抬上游时 version 那一半相同，身份就分不出来了。
  if (!thisRelease) {
    console.error(`✖ ${bundle}/app/package.json 没有 release（发行标识）：这个 bundle 是加该字段之前打的。`
      + ` 请用当前的 scripts/make-windows-bundle.mjs 重打（它会把 release=<本仓库版本>-<上游版本> 写进包内），`
      + ` 否则「只抬上游」的下一版与这一版分不开。`);
    return 1;
  }
  for (const b of bases) {
    if (![...b.files.keys()].some((f) => f.startsWith('app/'))) { console.error(`✖ ${b.source} 里没有 app/（不是我们的发行包）`); return 1; }
    // 排序只比 version（纯三段 semver）：release 是 `0.15.0-0.2.4` 这种两段串，比较器不认它。
    const baseVersion = String(b.version);
    if (compareVersions(baseVersion, version) > 0) {
      console.error(`✖ 基准包 v${baseVersion} 比这一版 v${version} 还新：更新包只往上走（拿错了 --from？玩家那种情况该用完整包）。`);
      return 1;
    }
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
    // `app` 保持 app/package.json 的 version（MANIFEST.json 里那一半，启动校验要两者相等）；
    // `from` 写发行标识，因为它只是给玩家看的那句话（server/update.js:284），而 0.14.0 说不清是 0.2.3 还是 0.2.4
    app: version, from: bases.map((b) => identityLabel({ release: b.release, version: b.version })), files: appShip, removed: diff.removed,
  }));
  // 新版本的 MANIFEST.json 必须随包带上：启动检查读的就是它（用新版本的清单校验整份安装有没有解压完整，
  // 并核对它属于哪个版本）。上游的 buildUpdate 同样会把 MANIFEST 放进更新包 —— 少了它，玩家一启动就被
  // 告知「更新包没有完整解压」，而文件其实都对。
  fs.copyFileSync(manifestPath, path.join(stage, 'app', MANIFEST_FILE));
  parseUpdate(fs.readFileSync(path.join(stage, 'app', UPDATE_FILE), 'utf8'));   // 自己的产物先按服务端的读法验一遍

  const zip = spawnSync('tar', ['-c', '--format', 'zip', '-f', out, '-C', stage, '.'], { stdio: 'inherit' });
  if (zip.error || zip.status !== 0) { console.error('✖ 打包失败（需要 bsdtar 的 tar）'); return 1; }
  fs.rmSync(stage, { recursive: true, force: true });

  const bytes = appShip.size ? [...appShip.values()].reduce((n, d) => n + d.size, 0) : 0;
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`\n✔ 更新包已生成：${out}`);
  console.log(`  适用于：${bases.map((b) => `v${identityLabel({ release: b.release, version: b.version })}`).join(' / ')} → v${identityLabel({ release: nextIdentity.release, version })}`);
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
  --out     输出路径（默认与 bundle 同级的 <bundle>-update.zip）
  --force   产物已存在时覆盖
  --allow-dirty
            **危险**：工作区有未提交改动也照旧出包。默认拒绝 —— bundle 里的文件来自**工作区磁盘**，
            而更新包的身份（release + MANIFEST 指纹）认的是「这一版」，脏工作区打出的包与它的 tag 对不上。
            只在本机验证时用；要发出去就先 commit 或 stash。`;

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // **工作区守卫是第一件事**，而且只在命令行这条路上：`main()` 也被测试当函数调（用临时目录里的假
  // bundle），把守卫塞进 `main()` 会让那些调用在开发者自己的脏工作区上莫名失败 —— 那测的不是它们。
  const argv = process.argv.slice(2);
  const guardCode = argv.includes('--help') || argv.includes('-h')
    ? 0
    : worktreeGuardExit({ allowDirty: argv.includes('--allow-dirty') });
  process.exit(guardCode !== 0 ? guardCode : main(argv));
}
export { main };