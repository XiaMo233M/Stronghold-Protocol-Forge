#!/usr/bin/env node
// tools/mod-manager.mjs — **把 mod 的 zip 拖进 mod 目录就自动装上**，外加一个命令行前端页面。
//
// 为什么是这个形态（而不是浏览器里拖放 / 一个 HTTP 上传端点）：
//   * 「把文件拖进文件夹」是一次**本机文件系统操作** —— 能往这个目录写文件的人，本来就对这台机器有写权限。
//     所以它没有给远程攻击者新增任何入口，这在安全上严格优于「服务器收上传」。
//   * 游戏服务器**刻意没有任何写路由**（`server/http/routes.js:34` "There is deliberately no write route"），
//     这个工具也不改变那条设计：写盘只发生在本进程（运维自己启动的），游戏进程照旧只读。
//
// 落点（--dir 缺省的工坊根 `workshop/`）：
//   workshop/*.zip                 ← 直接把包拖进来
//   workshop/.mod-inbox/*.zip      ← 显式队列（这个目录不存在就自动建）
// 装好之后 zip 会被搬到（不是删）：
//   workshop/.mod-inbox/installed/<时间戳>-<文件名>
//   workshop/.mod-inbox/failed/<时间戳>-<文件名>          （附同名 .reason.txt）
// `.mod-inbox` 是点开头的，`loadWorkshop` 不扫描它 —— 所以这些留底不会变成"包"。
//
// 「装上 ≠ 启用」：带服务端代码的包（pack.json.server 的 modules/battle/meta/room）装完会被登记为 disabled
// —— 那些代码在游戏服务端进程里跑，所以启用必须是一次刻意的动作。纯数据包不写登记册（它没有需要同意的执行面）。
// 「应用」= 重启游戏服务器：装配是一次性的（server/modHotReload.js 头部注释），本工具不原地换包。
// 想让它顺手重启，用 `--serve`（它自己拉起并监督 `node server/index.js`，每次安装后优雅重启）。
//
// 用法：
//   node tools/mod-manager.mjs watch [--dir <工坊根>] [--once] [--serve] [--json]
//   node tools/mod-manager.mjs list  [--dir <工坊根>] [--json]
//   node tools/mod-manager.mjs status [--dir <工坊根>] [--json]
//   node tools/mod-manager.mjs enable <id> | disable <id> | uninstall <id> | rollback <id>
//   node tools/mod-manager.mjs pack <项目目录> [-o <zip>]      ← 转发给 mod-pack
//
// 退出码：0 成功；1 拒绝；2 用法错误。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installZip, findPackDir, listPackIds, WORKSHOP_DIR, mb } from './workshop-pack.mjs';
import { disablePack, readModRegistry } from '../server/modRegistry.js';
import { stateRootFor } from '../server/modModules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const INBOX_DIRNAME = '.mod-inbox';
const DEBOUNCE_MS = 250;
const INSTALL_ATTEMPTS = 3;          // 拖进来的瞬间文件可能还在复制：重试几次再判失败
const RETRY_DELAY_MS = 400;

const USAGE = [
  'usage:',
  '  node tools/mod-manager.mjs watch  [--dir <工坊根>] [--once] [--serve] [--json]',
  '  node tools/mod-manager.mjs list   [--dir <工坊根>] [--json]',
  '  node tools/mod-manager.mjs status [--dir <工坊根>] [--json]',
  '  node tools/mod-manager.mjs enable|disable|uninstall|rollback <id>',
  '  node tools/mod-manager.mjs pack <项目目录> [-o <zip>]',
  '',
  '把 .zip 拖进 <工坊根>/ 或 <工坊根>/.mod-inbox/ 即自动安装（装完默认禁用，重启游戏服务器后生效）。',
].join('\n');

const usageError = (m) => Object.assign(new Error(m), { usage: true });
const log = (line = '') => process.stdout.write(`${line}\n`);

function parseArgs(argv) {
  const out = { command: null, dir: null, stateRoot: null, once: false, serve: false, json: false, rest: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--state') out.stateRoot = argv[++i];
    else if (a === '--once') out.once = true;
    else if (a === '--serve') out.serve = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  out.command = rest[0] ?? null;
  out.rest = rest.slice(1);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这个包声明了在游戏服务端进程里执行的代码吗？（与编辑器导入端点同一条判据） */
function declaresServerCode(manifest) {
  const s = manifest && typeof manifest === 'object' ? manifest.server : null;
  if (!s || typeof s !== 'object') return false;
  for (const key of ['modules', 'battle', 'meta', 'room']) {
    const v = s[key];
    if (Array.isArray(v) ? v.length > 0 : !!v) return true;
  }
  return false;
}

function inboxDirs(root) {
  return [path.join(root, INBOX_DIRNAME), root];
}

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 把处理完的 zip 搬进 `installed/` 或 `failed/`（搬，不删 —— 留底比"干净"重要）。
 *  源文件可能已经不在了（上一轮搬走过 / 被别的进程删掉）：那种情况返回 null，**绝不外抛** ——
 *  一次搬运失败不该让整个监听循环停掉。 */
function stash(root, kind, filePath, reason = null) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(root, INBOX_DIRNAME, kind);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, `${uniqueStamp()}-${path.basename(filePath)}`);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, `${uniqueStamp()}-${n++}-${path.basename(filePath)}`);
  try {
    fs.renameSync(filePath, dest);
  } catch {
    // 跨卷/被占用：退化成复制+删除；复制也失败就保留原地（下一轮还会看到它，比丢掉好）
    try {
      fs.copyFileSync(filePath, dest);
      try { fs.unlinkSync(filePath); } catch { /* 留在原地 */ }
    } catch {
      return null;
    }
  }
  if (reason) {
    try { fs.writeFileSync(`${dest}.reason.txt`, `${reason}\n`, 'utf8'); } catch { /* 留底失败不影响主流程 */ }
  }
  return dest;
}

/**
 * 处理一个 zip：安装 → 需要时落 disabled。
 * **不搬文件**（搬由调用方在"最终结论"之后做）：重试期间文件必须还在原地。
 * @returns {{ ok: boolean, id?: string, enabled?: boolean|null, bytes?: number, files?: number, reason?: string, warning?: string }}
 */
function processZip(root, filePath, { stateRoot } = {}) {
  let installed;
  try {
    installed = installZip({ root, buffer: fs.readFileSync(filePath), force: false, backup: true });
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  // 装上 ≠ 启用：只有带服务端代码的包才需要一次显式启用
  if (!declaresServerCode(installed.manifest)) {
    return { ok: true, id: installed.id, enabled: null, bytes: installed.bytes, files: installed.files };
  }
  try {
    disablePack(stateRoot, installed.id);
    return { ok: true, id: installed.id, enabled: false, bytes: installed.bytes, files: installed.files };
  } catch (e) {
    // 登记册写失败不能抹掉"已经装上"这个事实：如实报出来，让操作者知道它现在是**缺省启用**的
    return {
      ok: true, id: installed.id, enabled: true, bytes: installed.bytes, files: installed.files,
      warning: `装好了，但没能写进登记册（${e && e.message ? e.message : e}）—— 它现在按缺省是**启用**的，请手动核对`,
    };
  }
}

function pendingZips(root) {
  const out = [];
  for (const dir of inboxDirs(root)) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.zip') && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort();
    } catch { continue; }
    for (const name of names) if (!out.some((p) => path.basename(p) === name)) out.push(path.join(dir, name));
  }
  return out;
}

/** 串行处理当前队列（一次只装一个，避免同 id 互踩）。 */
async function drain(root, { stateRoot, report, json }) {
  const files = pendingZips(root);
  if (!files.length) return [];
  const results = [];
  for (const file of files) {
    let r = null;
    // 拖进来的瞬间文件可能还在被复制（读到半截 zip）。只有"读不了/截断/占用"值得重试；
    // 校验不过的（布局错、清单错）重试一万次也一样，直接判失败。
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt++) {
      r = processZip(root, file, { stateRoot });
      if (r.ok) break;
      const retryable = /读不了|ZIP_TRUNCATED|ENOENT|EBUSY|EBUSY|EACCES/i.test(r.reason || '');
      if (!retryable || attempt === INSTALL_ATTEMPTS) break;
      await sleep(RETRY_DELAY_MS);
    }
    // **结论定了才搬文件**：重试期间源文件必须还在原地（上一版在这里踩过：第一次失败就搬走，
    // 重试读到 ENOENT，再搬一次时源已不存在 → 整个循环被打断）。
    const movedTo = r.ok ? stash(root, 'installed', file) : stash(root, 'failed', file, r.reason);
    const out = { file: path.basename(file), ...r, movedTo };
    results.push(out);
    report(out);
  }
  if (json) log(JSON.stringify(results));
  return results;
}

function reportLine(r) {
  if (!r) return;
  if (!r.ok) { log(`✖ ${r.file}：${r.reason}`); log(`  已移到 ${r.movedTo}`); return; }
  const bits = [`${r.files} 个文件`, mb(r.bytes)];
  const state = r.enabled === false ? '已安装 · **已禁用**（启用后重启服务器生效）' : '已安装 · 纯数据包（重启服务器生效）';
  log(`✔ ${r.id}：${bits.join('，')} —— ${state}`);
  if (r.warning) log(`  ⚠ ${r.warning}`);
  log(`  原 zip 已留底在 ${r.movedTo}`);
}

function dashboard(root, stateRoot) {
  const registry = readModRegistry(stateRoot, { log: { warn() {}, info() {} } });
  const ids = (() => { try { return listPackIds(root); } catch { return []; } })();
  const rows = ids.map((id) => {
    let version = null; let serverCode = false;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(findPackDir(root, id), 'pack.json'), 'utf8'));
      version = typeof raw.version === 'string' ? raw.version : null;
      serverCode = declaresServerCode(raw);
    } catch { /* 坏包也列出来：它本身就是一条需要看到的信息 */ }
    const state = registry.packs && registry.packs[id] ? registry.packs[id].state : 'enabled (default)';
    return { id, version, state, serverCode };
  });
  return { root, stateRoot, inbox: pendingZips(root).map((p) => path.basename(p)), packs: rows };
}

function printDashboard(d) {
  log(`工坊根：${d.root}`);
  log(`登记册：${d.stateRoot}`);
  if (!d.packs.length) { log('（还没有装任何包）'); return; }
  const w = Math.max(...d.packs.map((p) => p.id.length), 2);
  const ws = Math.max(...d.packs.map((p) => p.state.length), 5);
  log(`${'id'.padEnd(w)}  ${'版本'.padEnd(8)}  ${'状态'.padEnd(ws)}  服务端代码`);
  for (const p of d.packs) {
    log(`${p.id.padEnd(w)}  ${String(p.version ?? '-').padEnd(8)}  ${p.state.padEnd(ws)}  ${p.serverCode ? 'yes' : '-'}`);
  }
  if (d.inbox.length) log(`\n待安装：${d.inbox.join('、')}`);
}

// ---- 子命令 -----------------------------------------------------------------------------------------------

/**
 * `--serve`：自己拉起并监督 `node server/index.js`，每次安装成功后**优雅重启**它。
 *
 * 为什么需要重启而不是"热替换"：装配是一次性的（`server/modHotReload.js` 头部注释），现有的热装载只能报告
 * 或"退出让 supervisor 拉起"。这里就是那个 supervisor —— 只做一件额外的事：装完包之后主动重启一次，
 * 于是「拖进去 → 生效」中间不需要人工敲命令。SIGTERM 走的是 `server/http/boot.js` 的优雅关闭（房间收到
 * `room.closed{reason:'shutdown'}`、socket 1001），10 秒还没退才强杀。
 */
function createSupervisor({ print }) {
  let child = null;
  let stopping = false;
  let restarting = false;
  const entry = path.join(REPO_ROOT, 'server', 'index.js');
  const start = () => {
    child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
    print(`[mod-manager] 游戏服务器已启动（pid ${child.pid}）`);
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      if (restarting) { restarting = false; start(); return; }
      print(`[mod-manager] 游戏服务器退出（code=${code ?? '-'} signal=${signal ?? '-'}）—— 不再自动拉起`);
    });
  };
  return {
    start,
    restart() {
      return new Promise((resolve) => {
        if (!child) { start(); resolve(); return; }
        restarting = true;
        const hard = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* 已经没了 */ } }, 10000);
        child.once('exit', () => { clearTimeout(hard); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(hard); resolve(); }
      });
    },
    stop() { stopping = true; try { child?.kill('SIGTERM'); } catch { /* 已经没了 */ } },
  };
}

function cmdWatch(args) {
  if (args.serve && args.once) throw usageError('--serve 与 --once 不能同时用（--once 处理完就退出，没有进程可监督）');
  const root = path.resolve(args.dir ?? WORKSHOP_DIR);
  const stateRoot = path.resolve(args.stateRoot ?? stateRootFor(REPO_ROOT));
  fs.mkdirSync(path.join(root, INBOX_DIRNAME), { recursive: true });
  const print = (line) => process.stdout.write(`${line}\n`);
  const report = args.json ? () => {} : reportLine;
  const supervisor = args.serve ? createSupervisor({ print }) : null;

  print(`mod 管理器：盯着 ${root}（以及 ${path.join(root, INBOX_DIRNAME)}）`);
  print('把 .zip 拖进去即安装；Ctrl+C 退出。');
  if (!args.json) printDashboard(dashboard(root, stateRoot));
  if (supervisor) supervisor.start();

  if (args.once) {
    const results = pendingZips(root);
    if (!results.length) { print('\n没有待安装的文件。'); return 0; }
    // drain 是异步的，但 --once 要同步语义 ⇒ 这里用 then 挂接并让它自然结束
    drain(root, { stateRoot, report, json: args.json }).then(() => {
      if (!args.json) { print(''); printDashboard(dashboard(root, stateRoot)); }
    }).catch((e) => { print(`处理失败：${e && e.message ? e.message : e}`); process.exitCode = 1; });
    return 0;
  }

  let timer = null;
  let running = false;
  let dirty = false;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  };
  async function run() {
    timer = null;
    if (running) { dirty = true; return; }   // 串行化：正在装就记一笔，装完再扫一次
    running = true;
    try {
      const results = await drain(root, { stateRoot, report, json: args.json });
      if (results.length && !args.json) { print(''); printDashboard(dashboard(root, stateRoot)); print(''); }
      // 真的装上了东西才重启：一次失败的拖入不该把在线的人踢出房间
      if (supervisor && results.some((r) => r && r.ok)) {
        print('[mod-manager] 已安装新包 —— 重启游戏服务器使其生效…');
        await supervisor.restart();
      }
    } catch (e) {
      print(`[mod-manager] 处理失败（服务继续）：${e && e.message ? e.message : e}`);
    } finally {
      running = false;
      if (dirty) { dirty = false; schedule(); }
    }
  }
  const watchers = [];
  for (const dir of inboxDirs(root)) {
    try {
      const w = fs.watch(dir, { persistent: true }, () => schedule());
      w.on?.('error', (e) => print(`[mod-manager] watcher error: ${e && e.message ? e.message : e}`));
      watchers.push(w);
    } catch (e) {
      print(`[mod-manager] 没法监听 ${dir}：${e && e.message ? e.message : e}`);
    }
  }
  // 启动时先扫一遍：拖在启动之前的文件也要装上
  schedule();
  const stop = () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    if (supervisor) supervisor.stop();
    print('\n已停止监听。');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

async function cmdList(args) {
  const root = path.resolve(args.dir ?? WORKSHOP_DIR);
  const stateRoot = path.resolve(args.stateRoot ?? stateRootFor(REPO_ROOT));
  const d = dashboard(root, stateRoot);
  if (args.json) { log(JSON.stringify(d, null, 2)); return 0; }
  printDashboard(d);
  return 0;
}

// enable / disable / uninstall / rollback / pack：**不在本文件重写一遍**。
// 它们的语义（留底、ownership 闸、force、回滚目标）全在 `tools/workshop-pack.mjs` 与 `tools/mod-pack.mjs` 里，
// 这里只做转发 —— 两份实现必然漂移，而"禁用"这种操作的漂移代价是某个包在你以为关掉的时候还在跑。
function forward(script, argv) {
  const abs = path.join(HERE, script);
  const child = spawn(process.execPath, [abs, ...argv], { stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) { log(USAGE); return args.help ? 0 : 2; }
  switch (args.command) {
    case 'watch': return cmdWatch(args);
    case 'list': return cmdList(args);
    case 'status': { const r = cmdList(args); return r; }
    case 'enable':
    case 'disable':
    case 'uninstall':
    case 'rollback': {
      if (args.rest.length !== 1) throw usageError(`${args.command} 需要一个包 id\n${USAGE}`);
      return forward('workshop-pack.mjs', [args.command, args.rest[0]]);
    }
    case 'pack': return forward('mod-pack.mjs', ['pack', ...args.rest]);
    case 'check': return forward('mod-pack.mjs', ['check', ...args.rest]);
    case 'export':
    case 'import': {
      if (args.rest.length !== 1) throw usageError(`${args.command} 需要参数\n${USAGE}`);
      return forward('workshop-pack.mjs', [args.command, args.rest[0]]);
    }
    default: throw usageError(`未知子命令 "${args.command}"\n${USAGE}`);
  }
}

// 只在**作为脚本运行**时跑 CLI（被测试 import 时不能执行）：与 `tools/workshop-pack.mjs` 同一个写法。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const code = main();
    // 异步子命令（watch --once / 转发的子进程）自己设置退出码；同步路径在这里落定
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  } catch (e) {
    const code = e && e.usage ? 2 : e && e.refused ? 1 : 2;
    console.error(`mod-manager: ${e && e.message ? e.message : e}`);
    process.exitCode = code;
  }
}

// 测试入口：这几个函数不打印、不读 process.argv，只做「一个 zip → 一个结论」。
export { processZip, drain, pendingZips, declaresServerCode };
