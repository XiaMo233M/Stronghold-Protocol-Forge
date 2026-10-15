// server/mod-manager/sandboxRuntime.js — 官方 **sandbox** 档的**子进程**那一半。
//
// 这个文件**只在一个 fork 出来的子进程里跑**（父侧是 `sandbox.js`）。它存在的唯一理由：
// 进程内 module 档挡不住的东西 —— 死循环、无限同步 IO、顶层副作用 —— 在这里被**进程边界**挡住：
// 父进程可以超时并**杀掉整个子进程**，宿主不受影响。
//
// 极小的能力面（DESIGN 重构计划 Phase 6 的「最小可用 sandbox」）：
//   `registerPlugin(host)` → `host.health.add(fields)` / `host.routes.add({path, handler})` /
//   `host.onBoot` / `host.onShutdown` / `host.storage`（限本插件状态目录）。
// 战斗类能力（meta/battle/room）**不在这一层**。
//
// 与父进程的消息协议（request/response，带 id）：
//   子 → 父：`{type:'ready', routes}` / `{type:'health', id, ok, fields}` / `{type:'response', id, ok, status, body, error}` /
//            `{type:'error', code, reason}` / `{type:'bye'}`
//   父 → 子：`{type:'health', id}` / `{type:'request', id, path, body}` / `{type:'shutdown', id}` / `{type:'boot', id}`

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const send = (m) => { try { process.send?.(m); } catch { /* 父进程已经走了 */ } };
const die = (code, reason) => { send({ type: 'error', code, reason }); process.exit(1); };

const entry = process.argv[2];
const pluginId = process.env.SP_SANDBOX_ID || 'plugin';
const stateDir = process.env.SP_SANDBOX_STATE || '';

/** @type {Record<string, any>[]} */ const healthFields = [];
/** @type {Map<string, Function>} */ const routes = new Map();
/** @type {Function[]} */ const boot = [];
/** @type {Function[]} */ const shutdown = [];

function resolveState(rel) {
  const s = String(rel ?? '');
  const segs = s.split('/');
  if (!stateDir || !s || path.isAbsolute(s) || s.includes('\\') || segs.some((x) => !x || x === '.' || x === '..')) {
    throw new Error(`storage path ${JSON.stringify(rel)} must be a relative path inside the plugin's own directory`);
  }
  const abs = path.join(stateDir, ...segs);
  if (!abs.startsWith(stateDir + path.sep)) throw new Error(`storage path ${JSON.stringify(rel)} escapes the plugin directory`);
  return abs;
}

const host = Object.freeze({
  id: pluginId,
  onBoot: (fn) => { if (typeof fn !== 'function') throw new Error('onBoot needs a function'); boot.push(fn); return true; },
  onShutdown: (fn) => { if (typeof fn !== 'function') throw new Error('onShutdown needs a function'); shutdown.push(fn); return true; },
  health: Object.freeze({ add: (fields) => { if (fields && typeof fields === 'object') healthFields.push(fields); return true; } }),
  routes: Object.freeze({
    add: (e) => {
      const ee = e && typeof e === 'object' ? e : {};
      const p = String(ee.path || '');
      if (!p.startsWith(`/mod/${pluginId}/`)) throw new Error(`route "${p}" must live under "/mod/${pluginId}/"`);
      if (typeof ee.handler !== 'function') throw new Error(`route "${p}" needs a handler function`);
      routes.set(p, ee.handler);
      return true;
    },
  }),
  storage: Object.freeze({
    read: (rel) => { try { return fs.readFileSync(resolveState(rel), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    write: (rel, text) => { const abs = resolveState(rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, String(text)); return abs; },
  }),
});

process.on('uncaughtException', (e) => die('PLUGIN_CRASH', String(e && e.message ? e.message : e)));
process.on('unhandledRejection', (e) => die('PLUGIN_CRASH', String(e && e.message ? e.message : e)));

process.on('message', async (msg) => {
  const m = msg && typeof msg === 'object' ? msg : {};
  try {
    if (m.type === 'health') {
      const fields = healthFields.reduce((acc, f) => ({ ...acc, ...f }), {});
      return send({ type: 'health', id: m.id, ok: true, fields });
    }
    if (m.type === 'boot') {
      for (const fn of boot) await fn();
      return send({ type: 'booted', id: m.id, ok: true });
    }
    if (m.type === 'shutdown') {
      for (const fn of shutdown) await fn();
      send({ type: 'bye', id: m.id });
      return process.exit(0);
    }
    if (m.type === 'request') {
      const handler = routes.get(String(m.path || ''));
      if (!handler) return send({ type: 'response', id: m.id, ok: false, status: 404, error: `no route "${m.path}"` });
      const out = await handler(m.body, { pluginId });
      const status = out && typeof out === 'object' && Number.isInteger(out.status) ? out.status : 200;
      const body = out && typeof out === 'object' && 'body' in out ? out.body : out;
      return send({ type: 'response', id: m.id, ok: true, status, body });
    }
    return send({ type: 'error', code: 'SANDBOX_BAD_MESSAGE', reason: `unknown message type ${JSON.stringify(m.type)}` });
  } catch (e) {
    return send({ type: 'response', id: m.id, ok: false, status: 500, error: String(e && e.message ? e.message : e) });
  }
});

// 装载：**在 import 之前**由父进程扫过源码（严格档）；子进程只负责跑起来。
(async () => {
  if (!entry) die('SANDBOX_NO_ENTRY', 'the sandbox runtime needs the plugin entry path as argv[2]');
  let ns;
  try {
    ns = await import(pathToFileURL(entry).href);
  } catch (e) {
    return die('PLUGIN_IMPORT_FAILED', String(e && e.message ? e.message : e));
  }
  if (typeof ns.registerPlugin !== 'function') return die('PLUGIN_NO_REGISTER', 'the entry does not export a registerPlugin(host) function');
  try {
    ns.registerPlugin(host);
  } catch (e) {
    return die('PLUGIN_REGISTER_THREW', String(e && e.message ? e.message : e));
  }
  send({ type: 'ready', routes: [...routes.keys()] });
})();
