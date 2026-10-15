// server/mod-manager/sandbox.js — 官方 **sandbox** 档的**父进程**那一半：起子进程、看门狗、记账、崩溃处置。
//
// 为什么必须另起一个进程：进程内的 `server.modules` / official module 档能做的只有**静态**约束
// （源码扫描 + 只注入声明过的东西）。一个 `while (true) {}` 的 `onBoot`，或一个永远不返回的 handler，
// 在那两档里会把**整个服务器**的事件循环堵死 —— 这是 2026-10-15 审计里 GAP-3 的另一半，也是计划 Phase 6
// 要的那一刀。子进程边界让父进程能**超时并杀掉它**：宿主不受影响，代价只由这一个插件承担。
//
// 纪律：
//   * **严格档源码扫描在 fork 之前**（profile `sandbox`，含 `globalThis`）——被拒的插件**连子进程都不会起**；
//   * 每一次 request / health 都有**墙钟超时**，超时 ⇒ 杀进程 + 具名 `SANDBOX_TIMEOUT`；
//   * 子进程崩溃/退出 ⇒ 所有在飞的调用具名 `SANDBOX_CRASH`，**不**把异常抛进宿主调用栈；
//   * 记账复用 `mod-manager/budget.js`（与另外两档同一份预算语义）。
//
// 这是「最小可用 sandbox 垂直切片」：health + 一个 request/response + boot/shutdown + 预算 + 崩溃/超时。
// 还没做的：跨进程的 storage 回写、lane/WSS 隧道、多插件共享一个子进程。

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { serverModuleSourceIssues } from '../modModules.js';
import { createBudgetTracker, UNLIMITED_BUDGET } from './budget.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandboxRuntime.js');

/** 父侧对子进程做的每一件事都可能失败，且都必须**具名**。 */
export class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/**
 * 起一个插件的 sandbox 子进程。
 *
 * @param {{
 *   pluginId: string, entry: string, dir: string, stateRoot?: string|null, log?: any,
 *   timeoutMs?: number, budget?: object, execPath?: string,
 *   forkImpl?: typeof fork,
 * }} opts
 * @returns {Promise<{ ok: true, runner: object } | { ok: false, errors: Array<{code:string,reason:string}> }>}
 */
export async function createSandboxRunner({
  pluginId, entry, dir, stateRoot = null, log = noopLog,
  timeoutMs = 5000, budget = UNLIMITED_BUDGET, execPath = process.execPath, forkImpl = fork,
}) {
  const abs = path.join(dir, ...String(entry || '').split('/'));
  if (!(abs === dir || abs.startsWith(dir + path.sep))) {
    return { ok: false, errors: [{ code: 'PLUGIN_BAD_ENTRY', reason: `entry ${JSON.stringify(entry)} escapes the plugin directory` }] };
  }
  let source;
  try {
    source = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, errors: [{ code: 'PLUGIN_BAD_ENTRY', reason: `entry is not readable: ${e && e.message ? e.message : e}` }] };
  }
  // **严格档扫描在 fork 之前**：被拒的插件连子进程都不起。
  const issues = serverModuleSourceIssues(source, pluginId, 'entry', { profile: 'sandbox' });
  if (issues.length) return { ok: false, errors: [{ code: 'PLUGIN_BAD_SOURCE', reason: issues[0].reason }] };

  const tracker = createBudgetTracker(budget);
  const state = { status: 'starting', exits: 0, lastExit: null, calls: 0, timeouts: 0 };
  let child = null;
  let closing = false;
  let seq = 0;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
  const pending = new Map();

  const settleAll = (err) => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  };

  const kill = () => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } };

  const spawn = () => {
    child = forkImpl(RUNTIME, [abs], {
      execPath,
      // 不设 `cwd`：Windows 上把一个目录设成子进程的 CWD 会让该目录在子进程存活期间**无法删除**
      // （调用方清理临时工作区时会 EPERM）。入口是绝对 file URL，本来就不依赖 cwd。
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        SP_SANDBOX_ID: pluginId,
        ...(stateRoot ? { SP_SANDBOX_STATE: path.join(stateRoot, 'official', pluginId) } : {}),
      },
    });
    child.on('message', (msg) => {
      const m = msg && typeof msg === 'object' ? msg : {};
      if (m.type === 'ready') { state.status = 'ready'; state.routes = m.routes || []; return; }
      if (m.type === 'error') { state.status = 'error'; settleAll(new SandboxError(m.code || 'SANDBOX_ERROR', String(m.reason || ''))); return; }
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.type === 'bye') return p.resolve({ ok: true });
      if (m.type === 'booted') return p.resolve({ ok: true });
      if (m.type === 'response') {
        if (!m.ok) return p.resolve({ ok: false, status: m.status || 500, error: m.error });
        return p.resolve({ ok: true, status: m.status || 200, body: m.body });
      }
      if (m.type === 'health') return p.resolve({ ok: true, fields: m.fields || {} });
      p.resolve({ ok: false, error: `unexpected message ${m.type}` });
    });
    child.on('exit', (code, signal) => {
      state.exits += 1;
      state.lastExit = { code, signal };
      const wasClosing = closing;
      child = null;
      if (wasClosing) { state.status = 'closed'; settleAll(new SandboxError('SANDBOX_CLOSED', 'the sandbox was shut down')); return; }
      state.status = 'crashed';
      log?.warn?.(`[sandbox] "${pluginId}" exited unexpectedly (code=${code}, signal=${signal})`);
      settleAll(new SandboxError('SANDBOX_CRASH', `the sandbox for "${pluginId}" exited (code=${code}, signal=${signal})`));
    });
    child.on('error', (e) => { state.status = 'error'; settleAll(new SandboxError('SANDBOX_SPAWN_FAILED', String(e && e.message ? e.message : e))); });
  };

  const call = (msg, ms) => new Promise((resolve, reject) => {
    if (!child) return reject(new SandboxError('SANDBOX_CRASH', `the sandbox for "${pluginId}" is not running`));
    if (!tracker.allow()) return reject(new SandboxError('SDK_BUDGET_EXCEEDED', tracker.exceeded ? tracker.exceeded.reason : 'budget exhausted'));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      state.timeouts += 1;
      // 立即把状态挪出 `ready`（exit 事件是异步的，不能靠它来保证「已经不再是 ready」）
      state.status = 'timeout';
      kill();
      reject(new SandboxError('SANDBOX_TIMEOUT', `"${pluginId}" did not answer within ${ms}ms — the sandbox was killed`));
    }, ms);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    state.calls += 1;
    tracker.record(0);
    child.send({ ...msg, id });
  });

  spawn();
  // 握手：等 `ready`（或一条 error），带超时。子进程的顶层副作用在这一步就已经发生了。
  const ready = await new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (state.status === 'ready') { clearInterval(timer); resolve(true); }
      else if (state.status === 'error' || state.status === 'crashed') { clearInterval(timer); resolve(false); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); kill(); state.status = 'timeout'; resolve(false); }
    }, 5);
    timer.unref?.();
    child.once('error', () => { clearInterval(timer); resolve(false); });
  });
  if (!ready) {
    kill();
    return { ok: false, errors: [{ code: state.status === 'timeout' ? 'SANDBOX_TIMEOUT' : 'SANDBOX_START_FAILED', reason: `sandbox for "${pluginId}" did not become ready (${state.status})` }] };
  }

  const runner = {
    pluginId,
    get state() { return { ...state, budget: tracker.state }; },
    get routes() { return [...(state.routes || [])]; },
    /** 一次 request/response（官方档唯一的调用通道）。 */
    request: (routePath, body = null) => call({ type: 'request', path: routePath, body }, timeoutMs),
    /** 只读健康字段（合并后）。 */
    health: () => call({ type: 'health' }, timeoutMs),
    boot: () => call({ type: 'boot' }, timeoutMs),
    /** 停机：发 shutdown，等 `bye`，然后确保进程真的没了。 */
    async shutdown() {
      closing = true;
      const c = child;
      try { if (child) await call({ type: 'shutdown' }, Math.min(timeoutMs, 2000)); } catch { /* 下面兜底 */ }
      kill();
      if (c) await new Promise((resolve) => { if (c.exitCode !== null || c.signalCode) return resolve(); c.once('exit', () => resolve()); setTimeout(resolve, 1000).unref?.(); });
      state.status = 'closed';
      return { ok: true };
    },
    /** 崩溃/超时之后重新起来（同一份字节 ⇒ 同一份代码）。 */
    async restart() {
      if (state.status === 'ready') return { ok: true, already: true };
      kill();
      await new Promise((r) => setTimeout(r, 50).unref?.() ?? setTimeout(r, 50));
      closing = false;
      state.status = 'starting';
      spawn();
      const ok = await new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (state.status === 'ready') { clearInterval(timer); resolve(true); }
          else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); kill(); resolve(false); }
        }, 5);
        timer.unref?.();
      });
      return ok ? { ok: true } : { ok: false, code: 'SANDBOX_START_FAILED' };
    },
  };
  return { ok: true, runner };
}
