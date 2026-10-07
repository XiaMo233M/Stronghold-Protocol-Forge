#!/usr/bin/env node
// scripts/make-windows-bundle.mjs — 打一份「开箱即用」的 Windows 便携包（docs/WINDOWS.md）。
//
//   node scripts/make-windows-bundle.mjs [--out <dir>] [--no-node] [--force]
//
// 产物目录（默认 <仓库的上一级>\Stronghold-Protocol-Windows）：
//   node\node.exe            官方 Windows x64 便携版 Node（版本与 sha256 钉在下面的 NODE_PIN）
//   node\LICENSE-node.txt    Node 自己的许可证（和 node.exe 一起从官方 zip 里取出来）
//   app\                     游戏本体：**只收 git 跟踪的文件** + 生产依赖 + 素材，离线可玩
//   启动游戏.bat             app\scripts\launch.mjs --no-setup
//   启动编辑器.bat           app\tools\workshop-editor.mjs --open（工坊编辑器 = 本仓库存在的理由）
//   README-开箱即用.md       给玩家看的说明（含非官方 / 严禁盈利 / 素材版权声明）
//   LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
//
// 目标机器什么都不用装：解压 → 双击 启动游戏.bat（或 启动编辑器.bat）。素材约 330 MB 是硬成本，包因此较大。
//
// 三条硬规则（都是踩过的坑）：
//   1. app\ 的文件清单来自 `git ls-files`，不是手写的跳过表 —— `.env` / `.venv` / `.claude` /
//      `scripts/service.env.cmd` 这些本机文件被 .gitignore 挡在版本库外，因此天然进不了发行包。
//      旧实现用一张窄表整树复制，漏一项就是把密钥打进别人下载的压缩包。
//   2. node_modules 用 `npm ci --omit=dev` 重新装一遍，不带 devDependency（puppeteer-core 之类）。
//   3. node.exe **每次都从校验过的官方 zip 重新解压**：下载的 zip 缓存进仓库的 .cache\，解压目录是
//      新建的临时目录、用完即删。旧实现「临时目录里那个 node.exe 还在就直接用」，和校验过的 zip 没有
//      对应关系 —— 上次解压中断留下的残缺文件会被打进包，共享的 /tmp 也不安全。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** 官方 Node zip 的下载缓存（不进版本库）。放仓库下而不是系统临时目录：后者是共享的，中断留下的残片会混进来。 */
const NODE_CACHE_DIR = path.join(ROOT, '.cache');

/**
 * 便携版 Node：版本与 sha256 **钉死在仓库里**，运行时只认这个常量。
 *
 * 不用 `latest-v22.x`：那样今天打的包和上个月打的包内容不同，出了问题也无从复现；而且校验哈希是运行时
 * 现去 nodejs.org 抓的，等于把「发出去的二进制是什么」交给当时的网络应答决定。换版本请改这里
 * （并在 `--node-version` 的同时用 `--sha256` 显式覆盖）。
 */
const NODE_PIN = Object.freeze({
  version: 'v22.23.3',
  file: 'node-v22.23.3-win-x64.zip',
  sha256: '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71',
});

/** 这几份不进版本库（npm / tools/setup.mjs 生成），但必须进包，否则游戏缺素材或缺前端库。 */
const ASSET_DIRS = ['public/assets', 'public/fonts', 'public/vendor'];

/**
 * 版本库里有、但便携包不要的。
 *
 * `test/` 是测试代码（省体积，玩家用不到）。
 *
 * `editor/` **要带上**：在本仓库（Stronghold-Protocol-Forge）里，工坊编辑器就是产品本身 —— 一个把编辑器
 * 排除在外的发行包，等于发了游戏却把仓库存在的理由留下了。它仍然只是本机工具：默认只绑 127.0.0.1，
 * 而且 `editor/` 不在 `public/` 下，所以游戏服务器结构上无法把它发给网页端（docs/EDITOR.md）。
 * （上游那个「只给玩家的整合包」除外，那种包确实不需要它。）
 */
const SKIP_TRACKED = ['test/'];

/** 包根要带的许可证 / 声明。 */
const LEGAL_FILES = ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md'];

/**
 * 本机从游戏文件里提取出来的 3D 棋盘贴图清单（不进版本库）。
 *
 * `public/assets/local`（约 68 MB）会随 `public/assets` 一起进包，但游戏是**靠这份 JSON** 才知道哪些贴图
 * 可用 —— 只带贴图不带清单，玩家拿到的是 68 MB 用不上的文件。它存在时就一起收。
 */
const LOCAL_ASSET_MANIFEST = path.join('data', 'local-assets.json');

/** The 配音 folders present on this machine (`public/assets/audio/voice/<lang>`), sorted. */
function listVoiceDubs(root = ROOT) {
  const dir = path.join(root, 'public', 'assets', 'audio', 'voice');
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
}

/** The manifest's default 配音 (`data/assets.json` audio.voiceLang), `cn` when it names none. */
function readDefaultDub(root = ROOT) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'data', 'assets.json'), 'utf8'));
    const l = m?.audio?.voiceLang;
    return typeof l === 'string' && l ? l : 'cn';
  } catch { return 'cn'; }
}

function parseArgs(argv) {
  const o = { out: '', node: true, force: false, nodeSpec: '', sha256: '', allDubs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--out') o.out = String(val() || '');
    else if (k === '--node-version') o.nodeSpec = String(val() || '');
    else if (k === '--sha256') o.sha256 = String(val() || '').toLowerCase();
    else if (a === '--no-node') o.node = false;
    else if (a === '--force') o.force = true;
    else if (a === '--all-dubs') o.allDubs = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `node scripts/make-windows-bundle.mjs — 生成 Windows 开箱即用便携包

  --out <dir>        产物目录（默认 <仓库上一级>/Stronghold-Protocol-Windows）
  --no-node          不下载便携版 Node（目标机器需自备 Node 22+）
  --all-dubs         把 public/assets/audio/voice/ 下的**全部**配音都打进包（默认只带清单里的默认配音，
                     其余走 release 的语音包，见 scripts/make-voice-pack.mjs）
  --force            目录已存在时先删掉（只肯删空目录，或上一次打的便携包；其余情况拒绝）
  --node-version X   换一个 Node 版本（默认 ${NODE_PIN.version}）；换版本必须同时给 --sha256
  --sha256 <hash>    该版本 win-x64.zip 的 sha256（取自官方 SHASUMS256.txt）

  app\\ 里只放 git 跟踪的文件 + 生产依赖（npm ci --omit=dev）+ public/{assets,fonts,vendor}；
  因此 .env / .venv / .claude / scripts/service.env.cmd 这些本机文件不会被打进去。
  data/local-assets.json 存在时（本机提取过 3D 棋盘贴图）会一起收，否则贴图进了包也用不上。

  不压缩、不改 index.html、不装开始界面：包里的 启动游戏.bat 就是
  \`app\\scripts\\launch.mjs --no-setup\`（素材已在包里，不需要联网准备）。
`;

/**
 * 路径的规范形式：把符号链接、macOS 的 `/tmp`、Windows 的 8.3 短名与大小写都归一。
 *
 * 产物目录通常还不存在，`fs.realpathSync.native` 会 ENOENT，所以只对**已存在的最深祖先**做归一，
 * 剩下的段原样接回去。Windows / macOS 的文件系统默认不区分大小写，比较前统一转小写 —— 不然
 * `--out c:\users\…\stronghold-protocol` 这种写法会绕过检查，而它指向的就是仓库本身。
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      head = fs.realpathSync.native(head);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) break;                 // 到根都还不存在：只能按字面量比
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
  const joined = tail.length ? path.join(head, ...tail) : head;
  // 只有 Linux 的默认文件系统区分大小写；darwin 上按不区分处理是偏保守的一侧（宁可拒绝也不误删）。
  return process.platform === 'linux' ? joined : joined.toLowerCase();
}

/**
 * `--out` 指到仓库本身或它的**上级**目录时，`--force` 会先 `rm -rf` 那个目录 —— 也就是把仓库整个删掉。
 * 这种路径直接拒绝（指向仓库内部是允许的，只是产物会出现在 git status 里）。
 *
 * 注意这只是第一道防线：真正的保险是下面 `forceDeleteVerdict()` 那条「不确定就不删」的规则，
 * 因为再小心的路径比较也挡不住 8.3 短名之类的花样。
 * @param {string} out
 * @param {string} [root]
 */
export function outDirIsUnsafe(out, root = ROOT) {
  const r = canonical(root);
  const o = canonical(out);
  if (o === r) return true;
  const rel = path.relative(o, r);          // 从 out 看 root 的相对位置
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 上一次打的便携包长这样：包根有这份说明，还有一个 app\ 目录。 */
const BUNDLE_MARKERS = Object.freeze(['README-开箱即用.md', 'app']);

/**
 * `--force` 允不允许删掉这个目录？
 *
 * 只认三种情况：目录还不存在；目录是空的；目录**看起来就是上次打的便携包**。
 * 其余一律拒绝 —— 路径比较挡不住大小写、符号链接、8.3 短名的花招，所以规则反过来写：
 * 只有能确认「这就是上次的产物」才动手删，认不出来就什么都不删。
 * @param {string} dir
 * @returns {'missing' | 'empty' | 'bundle' | 'refuse'}
 */
export function forceDeleteVerdict(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'refuse';   // 读不出来（权限 / 不是目录）就别删
  }
  if (entries.length === 0) return 'empty';
  const app = entries.find((e) => e.name === 'app');
  const looksLikeBundle = BUNDLE_MARKERS.every((n) => entries.some((e) => e.name === n))
    && !!app && (app.isDirectory() || app.isSymbolicLink());
  return looksLikeBundle ? 'bundle' : 'refuse';
}

/**
 * 版本库里跟踪的文件（仓库相对路径，posix 分隔符）。
 *
 * 这是 app\ 文件清单的唯一来源。用 NUL 分隔读，避免中文 / 空格文件名被 git 转义或截断。
 * @returns {string[]}
 */
function trackedFiles() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error('git ls-files 失败：打包只收版本库里跟踪的文件，请在完整的 git 仓库里运行');
  }
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

/** 按相对路径清单逐个复制（自动建目录）；源文件不存在就跳过（例如素材还没下载）。 */
export async function copyFiles(relPaths, dst, root = ROOT) {
  let files = 0; let bytes = 0;
  for (const rel of relPaths) {
    const from = path.join(root, rel);
    const to = path.join(dst, rel);
    let st;
    try {
      // eslint-disable-next-line no-await-in-loop
      st = await fsp.stat(from);
    } catch { continue; }
    if (!st.isFile()) continue;
    // eslint-disable-next-line no-await-in-loop
    await fsp.mkdir(path.dirname(to), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await fsp.copyFile(from, to);
    files++; bytes += st.size;
  }
  return { files, bytes };
}

/**
 * 整目录复制（素材 / 依赖），跳过符号链接与点开头的条目。
 *
 * 点开头的条目一律不要：`public/assets` 里可能躺着打包机器自己的 `.DS_Store`，它既不属于项目也不该发出去。
 */
export async function copyDir(src, dst, { skipDir = null } = {}) {
  let files = 0; let bytes = 0;
  const walk = async (d, out, rel) => {
    await fsp.mkdir(out, { recursive: true });
    const entries = await fsp.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (skipDir && rel !== '' && skipDir(rel, e.name)) continue;
      const from = path.join(d, e.name);
      const to = path.join(out, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(from, to, rel ? `${rel}/${e.name}` : e.name);
        continue;
      }
      if (!e.isFile()) continue;
      // eslint-disable-next-line no-await-in-loop
      await fsp.copyFile(from, to);
      files++;
      try {
        // eslint-disable-next-line no-await-in-loop
        bytes += (await fsp.stat(to)).size;
      } catch { /* ignore */ }
    }
  };
  await walk(src, dst, '');
  return { files, bytes };
}

async function dirSize(dir) {
  let bytes = 0; let files = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; try { bytes += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/**
 * 只装生产依赖，装到 app\node_modules。
 *
 * 在临时目录里 `npm ci --omit=dev` 再搬过来：既拿到干净的生产依赖（不带 puppeteer-core 这类
 * devDependency），又不会动本仓库自己的 node_modules。
 */
async function installProductionDeps(appDir) {
  const stage = path.join(appDir, '.deps-stage');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) throw new Error(`缺少 ${f}：无法安装生产依赖`);
    await fsp.copyFile(src, path.join(stage, f));
  }
  console.log('  · 安装生产依赖 npm ci --omit=dev（稍等）…');
  // --ignore-scripts：本仓库的 postinstall 是 `node tools/vendor.mjs`（把 npm 里的前端库拷进
  // public/vendor）。这个暂存目录里只有一份 package.json，脚本根本不存在，npm ci 会在 postinstall
  // 阶段 MODULE_NOT_FOUND；而 public/vendor 本来就是整目录进包（见 ASSET_DIRS），不需要再跑一次。
  // 依赖里也没有需要编译的原生模块（htm / pixi / preact / three / ws 都是纯 JS）。
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  // Windows 上 npm 是 npm.cmd（批处理），不能直接 spawn；显式走 cmd.exe，避免 shell:true 的参数转义告警。
  const r = IS_WIN
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd: stage, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: stage, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error('npm ci --omit=dev 失败（便携包需要生产依赖，请先联网）');
  await fsp.rm(path.join(appDir, 'node_modules'), { recursive: true, force: true });
  await fsp.rename(path.join(stage, 'node_modules'), path.join(appDir, 'node_modules'));
  await fsp.rm(stage, { recursive: true, force: true });
}

/**
 * PowerShell 单引号字符串的字面量，内部 `'` 要写成 `''`。
 *
 * 路径是拼进 `-Command` 的，合法路径里带 `'`（中文输入法很容易打出来）时直接拼接会截断命令，
 * 解压那一档就整条失效。
 * @param {string} s
 */
export function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 把 zip 解到 dir（必须是已存在的空目录）。
 *
 * 三种解压器按平台兜底：`tar`（Windows 10+ 的 bsdtar、macOS 的 bsdtar 都认得 zip）、`unzip`（GNU tar
 * 解不了 zip，Linux 上是这一档）、Windows 自带的 `Expand-Archive`。全试过才报错。
 * @returns {string} 实际成功的命令名
 */
function extractZip(zipPath, dir) {
  const attempts = [
    ['tar', ['-xf', zipPath, '-C', dir]],
    ['unzip', ['-q', zipPath, '-d', dir]],
  ];
  if (IS_WIN) attempts.push(['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${psSingleQuote(zipPath)} -DestinationPath ${psSingleQuote(dir)} -Force`]]);
  let last = '';
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (!r.error && r.status === 0) return cmd;
    last = `${cmd}: ${r.error ? r.error.message : `退出码 ${r.status}`}`;
  }
  throw new Error(`解压 ${path.basename(zipPath)} 失败（需要 tar / unzip，Windows 上也可以是 Expand-Archive）：${last}`);
}

/**
 * 确保官方 zip 在仓库的 .cache\ 里，且 sha256 与仓库里钉死的一致。
 * @returns {Promise<string>} zip 的绝对路径
 */
async function ensureNodeZip(version, wantHash) {
  const zipName = `node-${version}-win-x64.zip`;
  const zipPath = path.join(NODE_CACHE_DIR, zipName);

  if (fs.existsSync(zipPath)) {
    const h = crypto.createHash('sha256').update(await fsp.readFile(zipPath)).digest('hex');
    if (h === wantHash) return zipPath;
    console.log(`  · ${path.relative(ROOT, zipPath)} 校验失败，重新下载`);
  }

  const url = `https://nodejs.org/dist/${version}/${zipName}`;
  console.log(`  · 下载 ${url}（约 30 MB）`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== wantHash) throw new Error(`${zipName} sha256 不匹配：\n    期望 ${wantHash}\n    实际 ${got}`);
  await fsp.mkdir(NODE_CACHE_DIR, { recursive: true });
  await fsp.writeFile(zipPath, buf);
  return zipPath;
}

/**
 * 便携版 Node：从**校验过的** zip 解出 node.exe 与 LICENSE。
 *
 * 每次都新建一个临时目录重新解压，绝不复用上一次解压出来的文件 —— 缓存的是 zip，不是解压结果：
 * 解压中断留下的残缺 node.exe 与 zip 没有任何对应关系，直接复制就会把坏文件发出去。
 * @param {string} bundleNodeDir
 * @param {string} version 形如 v22.23.3
 * @param {string} zipPath 已校验 sha256 的官方 win-x64 zip
 */
async function extractPortableNode(bundleNodeDir, version, zipPath) {
  const zipName = `node-${version}-win-x64.zip`;
  const rootName = zipName.replace(/\.zip$/, '');   // win-x64 zip 的固定布局：<zip 名>/node.exe
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-node-'));
  try {
    const tool = extractZip(zipPath, tmp);
    const nodeExe = path.join(tmp, rootName, 'node.exe');
    const license = path.join(tmp, rootName, 'LICENSE');
    if (!fs.existsSync(nodeExe)) throw new Error(`解压后没找到 node.exe：${nodeExe}`);
    // 发出去的二进制必须带它自己的许可证 —— 官方 zip 里就有，取出来放旁边。
    if (!fs.existsSync(license)) throw new Error(`官方 zip 里没有 LICENSE：${license}（不能就这样打包发出去）`);
    await fsp.mkdir(bundleNodeDir, { recursive: true });
    await fsp.copyFile(nodeExe, path.join(bundleNodeDir, 'node.exe'));
    await fsp.copyFile(license, path.join(bundleNodeDir, 'LICENSE-node.txt'));
    console.log(`    解压器：${tool}`);
    return {
      version,
      bytes: (await fsp.stat(path.join(bundleNodeDir, 'node.exe'))).size,
      licenseBytes: (await fsp.stat(path.join(bundleNodeDir, 'LICENSE-node.txt'))).size,
    };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** 启动 .bat（内容保持纯 ASCII，中文只出现在文件名里）。导出是为了让测试盯住 `%NODE%` 的解析。 */
export function bat(body) {
  return `@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\nset "HERE=%~dp0"\r\nset "NODE="\r\nif exist "%HERE%node\\node.exe" set "NODE=%HERE%node\\node.exe"\r\nif not defined NODE set "NODE=node"\r\n${body}\r\nset "CODE=%ERRORLEVEL%"\r\nif not "%CODE%"=="0" pause\r\nexit /b %CODE%\r\n`;
}

/**
 * 包根那几个双击入口：文件名 → `bat()` 里的命令体。
 *
 * **游戏与编辑器都要有，因为本仓库是 Forge**：编辑器就是产品，只给 `启动游戏.bat` 等于把仓库存在的理由留在包里没人看得见。
 * 游戏那份带 `--no-setup`（素材已经在包里，不需要联网准备）；编辑器那份带 `--open`（双击就该看见界面），
 * 它不碰素材，所以没有 setup 这一步。三份都用包内便携 Node（`%NODE%` 由 `bat()` 解析）。
 *
 * `安装工坊包.bat` 是给**没有编辑器**的玩家用的：把一个包 `.zip` 拖到这个 .bat 上即装好
 * （`tools/workshop-pack.mjs import`）。作者那边用编辑器的「包管理」页，两条路走的是同一批函数，
 * 所以「装完之后包长什么样」不可能不一样。没拖文件时透传空参数，CLI 自己会用中文说明用法并以 2 退出，
 * 于是 `bat()` 的「非 0 就暂停」把窗口停住 —— 不用在这里塞中文，命令体保持纯 ASCII。
 * @returns {Record<string, string>}
 */
export function bundleLaunchers() {
  return {
    '启动游戏.bat': '"%NODE%" "%HERE%app\\scripts\\launch.mjs" --no-setup %*',
    '启动编辑器.bat': '"%NODE%" "%HERE%app\\tools\\workshop-editor.mjs" --open %*',
    '安装工坊包.bat': '"%NODE%" "%HERE%app\\tools\\workshop-pack.mjs" import %*',
  };
}

/**
 * 包内说明。带不带便携版 Node 会影响三处措辞（是否需要预装 Node、许可证在哪、目录结构），
 * 所以先算好片段再拼，别在模板里嵌套引号。
 */
export function bundleReadme({ version, withNode, withVoices = false, voiceLangs = [], voicePackLangs = [] }) {
  const nodeNeed = withNode
    ? `目标机器**不需要安装 Node**：包内的 \`node\\node.exe\` 就是便携版 Node ${version}。`
    : '这个包**没有带便携版 Node**，请先在这台机器上安装 Node 22 或 24（LTS）。';
  const nodeLicence = withNode ? ' 与 `node\\LICENSE-node.txt`（Node 自己的 MIT 许可证）' : '';
  // The voice lines ship with the assets (`public/assets/audio/voice/**`), so whether this bundle carries them is a
  // build-time fact — a README that promises them from a checkout without them would be a lie. `voiceLangs` (shipped)
  // and `voicePackLangs` (available as a separate release asset, v0.7.2) are the same kind of fact for 多语言配音.
  const shipped = Array.isArray(voiceLangs) ? voiceLangs : [];
  const pack = Array.isArray(voicePackLangs) ? voicePackLangs : [];
  const dubLine = shipped.length > 1
    ? `
**${shipped.length} 种配音都在包里**（${shipped.join(' / ')}）：**设置 → 配音语言** 选全局默认，任何干员的
**干员详情 → 配音** 还能单独换一种（例如中文界面配日文语音），试听就在按钮上。
`
    : (pack.length
      ? `
**包里只有一种配音**（${shipped.join(' / ') || '默认'}）。其余配音（${pack.join(' / ')}）在同一个 release 的
\`…-voices-*.zip\` 里：解压后把 \`voice\\\` 覆盖到 \`app\\public\\assets\\audio\\voice\\\` 就装好了，**不用改配置**。
装好后 **设置 → 配音语言** 选全局默认，任何干员的 **干员详情 → 配音** 还能单独换一种。
没装也能玩：选了没装的配音时会自动用默认配音那一句，设置里也会标明哪几种没装。
`
      : '');
  const voiceNote = withVoices
    ? `
**角色语音台词已经在包里**（行动出发 / 行动开始 / 选中 / 部署 / 作战中 1-4，以及结算时各自队伍 MVP 的那一句）。
**默认就能听见**：音量在 **设置 → 干员语音（VOICE）**（默认 0.8）—— 音效与语音是两条独立通道，调一个不会影响另一个。
工坊包也能自带语音（助战干员的配音），装包后走同一条链路，见 \`app\\docs\\WORKSHOP.md\`。
${dubLine}`
    : '';
  const tree = withNode
    ? `node\\node.exe            便携版 Node ${version}（官方 x64，已经 sha256 校验）
node\\LICENSE-node.txt    Node 自己的许可证（MIT）
app\\                    游戏本体：server / shared / public（全部素材）/ data / editor / scripts / tools
启动游戏.bat             app\\scripts\\launch.mjs --no-setup（开服，浏览器自动打开）
启动编辑器.bat           app\\tools\\workshop-editor.mjs --open（工坊编辑器，127.0.0.1:3311）
安装工坊包.bat           把一个工坊包 .zip 拖到这个文件上即装好
README-开箱即用.md       本文件
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md`
    : `app\\                    游戏本体：server / shared / public（全部素材）/ data / editor / scripts / tools
启动游戏.bat             app\\scripts\\launch.mjs --no-setup（开服，浏览器自动打开）
启动编辑器.bat           app\\tools\\workshop-editor.mjs --open（工坊编辑器，127.0.0.1:3311）
安装工坊包.bat           把一个工坊包 .zip 拖到这个文件上即装好
README-开箱即用.md       本文件
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md

（没有 node\\ 这一层：本包不带便携版 Node，请自行安装 Node 22/24 LTS）`;

  return `# 卫戍协议：盟约 · Windows 开箱即用包

解压后**双击 \`启动游戏.bat\`** 即可开服（素材与依赖都在包里，不需要再下载任何东西）；
双击 **\`启动编辑器.bat\`** 打开工坊编辑器（本仓库的主角）；
拿到别人做的工坊包就把那个 \`.zip\` **拖到 \`安装工坊包.bat\`** 上松开（装进 \`app\\workshop\\\`，重启游戏服务器后生效）。
${nodeNeed}

**不联网也能玩**：美术 / 音频 / 依赖 / 字体全部在包内，断网时用自带的 \`app\\public\\fonts\`
（Bender / Novecento Wide）和系统黑体，玩法不受影响。**联网时**页面还会去 Google Fonts 加载
Noto Sans SC 这类网页字体（\`index.html\` 里那条外链这次没有改，它也不阻塞渲染），
只是让中文更接近原版观感 —— 断网不会因此卡住或报错。
${voiceNote}
## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有。这些素材**不适用**本项目的 GPL-3.0 许可证；GPL 只覆盖本项目自己编写的代码。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括但不限于：售卖本项目或整合包、付费下载或付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现方式，以及其他任何商业用途。
> - 本包为了方便玩家附带了游戏的美术与音频素材，下载即视为同意本声明。请勿将素材用于本项目以外的用途或**单独再分发**。完整条款见 [NOTICE.md](NOTICE.md)。
> - 权利人如认为本项目侵犯其权益，请通过 Issue 联系，我们会**立即删除**相关内容。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。

包内 [LICENSE](LICENSE) 里的 GPL-3.0-or-later 覆盖的是**本项目自己编写的代码**；内置 Node.js（MIT）以及其它
第三方组件的许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)${nodeLicence}。

## 怎么玩

\`\`\`
本机当服务器   双击 启动游戏.bat：在这台电脑开服，浏览器自动打开；
               控制台会打印「发给朋友」的局域网地址（形如 http://192.168.1.23:3000）
连别人的服务器 不需要这个包，直接用浏览器打开对方的网址就行
\`\`\`

第一次开服时 Windows 防火墙可能弹窗，勾选**允许专用网络**（否则朋友连不上）。
建房后把 4 位「同盟密钥」或「复制链接」（\`…/?room=密钥\`）发给朋友即可。

## 工坊编辑器（本仓库的主角）

双击 **\`启动编辑器.bat\`**：打开工坊编辑器 <http://127.0.0.1:3311>，在里面新建 / 编辑工坊包 ——
干员、地图、怪物、出怪、装备、行为层 kit 六个页面。给 AI 用的官方 prompt 在 \`app\\docs\\prompts\\\`。

- **默认只绑本机**（编辑器可以写文件，没有登录与权限控制），端口 3311；换端口：\`启动编辑器.bat --port 3400\`。
- 它只写两处：\`app\\workshop\\**\`（工坊源文件与生成产物）与 \`app\\data\\support.json\`（只在你动「是否助战」开关时）；
  \`tools/build-data.mjs\` 生成的其它 \`data\\*.json\` 永不改动。
- **保存后要重启游戏服务器**（关掉 \`启动游戏.bat\` 的窗口，再双击一次）才会出现在游戏里。
- **不用开游戏服务器也能用编辑器**，它不需要素材也不需要联网。
- 编辑器不在 \`public\\\` 下，游戏服务器结构上无法把它发给网页端 —— 它纯粹是你本机的工具。

## 目录结构

\`\`\`
${tree}
\`\`\`

卸载＝直接删掉整个文件夹（不写注册表、不放系统目录）。存档/昵称在该电脑的浏览器 localStorage 里。
`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }
  const out = path.resolve(o.out || path.join(path.dirname(ROOT), 'Stronghold-Protocol-Windows'));
  const appDir = path.join(out, 'app');
  const nodeDir = path.join(out, 'node');

  // 版本与哈希：默认用仓库里钉死的那一份；换版本必须同时给 --sha256，否则拒绝。
  let nodeVersion = NODE_PIN.version;
  let nodeHash = NODE_PIN.sha256;
  if (o.nodeSpec) {
    if (!/^v?\d+\.\d+\.\d+$/.test(o.nodeSpec)) {
      console.error(`✖ --node-version 要写成 v22.23.3 这样的具体版本，收到的是 ${o.nodeSpec}（latest-22.x 这类浮动版本不行，那样两次打包内容会不一样）。`);
      return 1;
    }
    nodeVersion = o.nodeSpec.startsWith('v') ? o.nodeSpec : `v${o.nodeSpec}`;
    if (nodeVersion !== NODE_PIN.version) {
      if (!/^[0-9a-f]{64}$/.test(o.sha256)) {
        console.error(`✖ --node-version ${nodeVersion} 与仓库里钉死的 ${NODE_PIN.version} 不同，必须同时给 --sha256 <64 位十六进制>（取自官方 SHASUMS256.txt）。`);
        return 1;
      }
      nodeHash = o.sha256;
    }
  }

  console.log(`\n卫戍协议 · Windows 开箱即用包\n  源仓库：${ROOT}\n  产物：  ${out}\n`);

  // --out 指到仓库本身 / 上级目录时直接拒绝；--force 另外只肯删「空目录」或「上一次打的包」。
  if (outDirIsUnsafe(out)) {
    console.error(`✖ --out 指向仓库本身或它的上级目录：${out}\n  加 --force 会把仓库删掉，请换一个仓库之外的目录（例如 D:\\Game\\Stronghold-Protocol-Windows）。`);
    return 1;
  }
  const verdict = forceDeleteVerdict(out);
  if (verdict !== 'missing') {
    if (!o.force) {
      console.error(`✖ ${out} 已存在。要覆盖请加 --force —— 它只会删掉空目录，或上一次打的便携包，其余情况一律拒绝。`);
      return 1;
    }
    if (verdict === 'refuse') {
      console.error(`✖ ${out} 已存在，但它既不是空目录，也不像上一次打的便携包（包根要有 README-开箱即用.md 和 app\\）。`
        + '\n  为免误删，这里不会动它：请自己确认后删掉，或换一个 --out（例如 D:\\Game\\Stronghold-Protocol-Windows）。');
      return 1;
    }
    await fsp.rm(out, { recursive: true, force: true });
    console.log(`  · 清掉 ${out}（${verdict === 'empty' ? '空目录' : '上一次的便携包'}）`);
  }
  await fsp.mkdir(out, { recursive: true });

  // 1) 游戏代码：只收 git 跟踪的文件
  const all = trackedFiles();
  const wanted = all.filter((rel) => !SKIP_TRACKED.some((p) => rel === p || rel.startsWith(p)));
  console.log(`  · 复制游戏本体（git 跟踪的 ${wanted.length} 个文件，略过 ${all.length - wanted.length} 个 test/ 文件）…`);
  const copied = await copyFiles(wanted, appDir);
  console.log(`    完成：${copied.files} 个文件 / ${MB(copied.bytes)}`);

  // 2) 素材与前端库（不进版本库，必须存在）
  for (const d of ASSET_DIRS) {
    if (!fs.existsSync(path.join(ROOT, d))) {
      throw new Error(`缺少 ${d} —— 先运行 node tools/setup.mjs 把素材 / 前端库准备好`);
    }
  }
  console.log(`  · 复制素材与前端库（${ASSET_DIRS.join('、')}）…`);
  // 多语言配音 (v0.7.2): the bundle carries the manifest's DEFAULT dub only (≈66 MB); the other dubs are published as a
  // separate voice pack (scripts/make-voice-pack.mjs, attached to the same release) because four dubs are ≈262 MB.
  // 一个都不带的情况不存在：清单里 voice 那套必须与文件同进同出（见 2b）。
  const voiceDir = path.join(ROOT, 'public', 'assets', 'audio', 'voice');
  const allDubs = !!o.allDubs;
  const withVoices = fs.existsSync(voiceDir);
  const defaultDub = readDefaultDub();
  const extraDubs = listVoiceDubs().filter((l) => l !== defaultDub);
  const skipDir = allDubs || !extraDubs.length
    ? null
    // `rel` is relative to the copied root (public/assets), so the voice folders are `audio/voice/<lang>`
    : (rel, name) => (/(^|\/)audio\/voice$/.test(rel) && extraDubs.includes(name));
  let assetFiles = 0; let assetBytes = 0;
  for (const d of ASSET_DIRS) {
    // eslint-disable-next-line no-await-in-loop
    const s = await copyDir(path.join(ROOT, d), path.join(appDir, d), { skipDir });
    assetFiles += s.files; assetBytes += s.bytes;
  }
  console.log(`    完成：${assetFiles} 个文件 / ${MB(assetBytes)}`);

  // 2b) 角色语音台词：0.2.0 的布局是 public/assets/audio/voice/<语言>/<干员>/*.mp3（上游 0.1.x 那套 voice_cn/
  // 目录已经废弃）。靠 data/assets.json 的 audio.voice / audio.voiceLangs 映射才会被客户端采用 —— 两者要么一起进包，
  // 要么都不进。多语言配音：这里报出包里真有哪几种语言，免得说明书吹了包里没有的东西。
  const voiceDubs = withVoices ? listVoiceDubs().filter((l) => allDubs || !extraDubs.includes(l)) : [];
  console.log(withVoices
    ? `    带上角色语音台词（public/assets/audio/voice/{{${voiceDubs.join(',')}}}；游戏里「设置 → 干员语音」默认 0.8 = 开，「配音语言」逐干员可换）`
    : '    未包含角色语音台词（想打进包里先运行 node tools/fetch-assets.mjs）');
  if (withVoices && !allDubs && extraDubs.length) {
    console.log(`    其余配音（${extraDubs.join(' / ')}）走 release 的语音包：node scripts/make-voice-pack.mjs（客户端在选中未安装的配音时回退到默认配音）`);
  }

  // 2c) 3D 棋盘贴图的清单（本机提取过才有）：贴图在 public/assets/local 里，靠这份 JSON 才会被游戏采用。
  const localManifest = path.join(ROOT, LOCAL_ASSET_MANIFEST);
  const localTextures = path.join(ROOT, 'public', 'assets', 'local');
  if (fs.existsSync(localManifest)) {
    await fsp.copyFile(localManifest, path.join(appDir, LOCAL_ASSET_MANIFEST));
    console.log(`    带上 ${LOCAL_ASSET_MANIFEST}（3D 棋盘贴图的清单，贴图本体在 public/assets/local）`);
  } else if (fs.existsSync(localTextures)) {
    console.log(`    ! 有 public/assets/local 但没有 ${LOCAL_ASSET_MANIFEST}：贴图进了包也用不上，`
      + '先跑 node tools/setup.mjs --local 生成清单（或删掉该目录）');
  }

  // 3) 生产依赖
  await installProductionDeps(appDir);
  const deps = await dirSize(path.join(appDir, 'node_modules'));
  console.log(`    完成：${deps.files} 个文件 / ${MB(deps.bytes)}（只含生产依赖）`);

  // 4) 便携版 Node（每次都从校验过的 zip 重新解压）
  let nodeInfo = { version: '（未打包，目标机器需自备 Node 22+）', bytes: 0 };
  if (o.node) {
    console.log(`  · 准备便携版 Node ${nodeVersion}…`);
    await fsp.mkdir(nodeDir, { recursive: true });
    const zipPath = await ensureNodeZip(nodeVersion, nodeHash);
    nodeInfo = await extractPortableNode(nodeDir, nodeVersion, zipPath);
    console.log(`    完成：Node ${nodeInfo.version} / ${MB(nodeInfo.bytes)} + LICENSE`);
  }

  // 5) 包根的法律文件（本项目的 LICENSE / NOTICE / 第三方声明）
  for (const f of LEGAL_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      console.log(`    ! 版本库里没有 ${f}，包根将缺少这份声明`);
      continue;
    }
    await fsp.copyFile(src, path.join(out, f));
  }

  for (const [name, body] of Object.entries(bundleLaunchers())) {
    await fsp.writeFile(path.join(out, name), bat(body), 'latin1');
  }
  // The voice lines are copied as part of `public/assets` above; the README says so only when they are really there
  // (v0.3.0 ships them — see docs/WINDOWS.md), so a checkout without them produces an honest bundle.
  await fsp.writeFile(path.join(out, 'README-开箱即用.md'), bundleReadme({
  version: nodeVersion,
  withNode: !!o.node,
  withVoices,
  voiceLangs: voiceDubs,
  voicePackLangs: withVoices && !allDubs ? listVoiceDubs().filter((l) => !voiceDubs.includes(l)) : [],
}), 'utf8');

  const total = await dirSize(out);
  console.log(`\n✔ 便携包已生成：${out}\n  ${total.files} 个文件 / ${MB(total.bytes)}`);
  console.log('  双击「启动游戏.bat」开服；双击「启动编辑器.bat」开工坊编辑器。');
  return 0;
}

// 作为脚本运行时才打包（被 import 时只导出纯函数，方便测试）。
// 用 realpath 比较：路径经过符号链接（macOS 的 /tmp、Windows 的 8.3 短名）时 argv[1] 与 import.meta.url
// 的字面量不同，直接比 URL 会让脚本什么都不做就退出。
function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
