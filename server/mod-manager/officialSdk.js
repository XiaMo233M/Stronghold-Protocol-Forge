// server/mod-manager/officialSdk.js — 官方档 **`setup(sp)` SDK 表面**（`sp:sdk@1` 的那一半）。
//
// 上游 0.3.0 的插件入口契约（`docs/PLUGINS.md:756`）是
//   `export default function setup(sp) { ... }`
// 而 `sp` 由 `shared/plugins/sdk.js createSDK` 构造：
//   `sp = { kit, math, constants, settings, kits.register, enemies.register, content.register, meta.register, log }`
// 读到未声明的键 = `undefined`；**权限缺失才抛** `PLUGIN_PERMISSION_MISSING`（`sdk.js:35-37`）。
//
// 本文件按**同一份表面**构造 `sp`，注册动作落到 `server/sim/content/extensions.js`（0.3.0 同一份实现，
// 已 vendor 进本仓）。`kit` / `math` / `constants` 三个冻结数据面直接从上游 `sdk.js` 搬（它们是纯值，
// 不依赖任何运行时状态）。
//
// 与我方 `host.*` 面的关系：**两份面并存** —— 插件作者用哪份都行。`setup(sp)` 是上游契约；
// `registerPlugin(host)` 是我方扩展契约（给 Forge 独有的面：storage/lane/metrics/…）。入口检测顺序：
//   `setup`（上游契约）→ `registerPlugin`（我方契约）→ 都没有才拒。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { kit, math, constants } from '../sim/content/sdkData.js';
import { registerKit, registerEnemy, registerContent, registerMeta } from '../sim/content/extensions.js';

/** 装载上限（上游 `shared/plugins/sandbox.js:8` 同一份数字）。 */
export const SANDBOX_LIMITS = Object.freeze({ files: 64, bytes: 1024 * 1024 });

/**
 * 逐文件校验 + 合计（上游 sandbox 装载的同一条纪律：文件超出 64 个 / 1MiB ⇒ 拒）。
 * @param {Array<{ path: string, hash: string }>} files
 * @param {string} dir
 * @returns {{ ok: boolean, reason?: string, perFile?: Map<string, string> }}
 */
export function checkSandboxPayload(files, dir) {
  const list = Array.isArray(files) ? files : [];
  if (list.length > SANDBOX_LIMITS.files) return { ok: false, reason: `the plugin carries ${list.length} files (at most ${SANDBOX_LIMITS.files})` };
  let total = 0;
  const perFile = new Map();
  for (const f of list) {
    let bytes;
    try { bytes = fs.readFileSync(path.join(dir, ...String(f.path).split('/'))); } catch { return { ok: false, reason: `declared file "${f.path}" is not readable` }; }
    if (total + bytes.length > SANDBOX_LIMITS.bytes) return { ok: false, reason: `the plugin carries more than ${SANDBOX_LIMITS.bytes} bytes of code/data` };
    total += bytes.length;
    perFile.set(f.path, bytes);
  }
  return { ok: true, perFile };
}

/**
 * 构造一份 `setup(sp)` 的 `sp`（上游 `createSDK` 同形）。注册动作全部落到 extensions.js。
 *
 * @param {{ id: string, officialPermissions?: string[] }} plugin 描述符的最小投影
 * @param {{ settings?: object, log?: Function, budget?: number }} [opts]
 */
export function createSDK(plugin, { settings = {}, log = (..._args) => {}, budget = 0 } = {}) {
  let lines = 0;
  const permissions = Array.isArray(plugin.officialPermissions) ? plugin.officialPermissions : [];
  const need = (permission) => {
    if (!permissions.includes(permission)) {
      throw Object.assign(new Error(`${plugin.id}: ${permission} required`), { code: 'PLUGIN_PERMISSION_MISSING' });
    }
  };
  return Object.freeze({
    kit,
    math,
    constants,
    settings: Object.freeze(JSON.parse(JSON.stringify(settings))),
    kits: Object.freeze({ register: (id, fn) => { need('sim.code'); return registerKit(plugin, id, fn, budget); } }),
    enemies: Object.freeze({ register: (id, fn) => { need('sim.code'); return registerEnemy(plugin, id, fn, budget); } }),
    content: Object.freeze({ register: (mod) => { if (mod && mod.install) need('sim.code'); if (mod && mod.registerMeta) need('meta.code'); return registerContent(plugin, mod, budget); } }),
    meta: Object.freeze({ register: (id, h) => { need('meta.code'); return registerMeta(plugin, id, h); } }),
    log: (...args) => { if (lines++ < 20) log(`[plugin:${plugin.id}]`, ...args.map((x) => String(x).slice(0, 500))); },
  });
}

/** 入口模块的解析路径（必须在插件目录之内 —— 与 loader 同一条纪律）。 */
export function resolveEntry(plugin, rel) {
  const abs = path.join(plugin.dir, ...String(rel).split('/'));
  return (abs === plugin.dir || abs.startsWith(plugin.dir + path.sep)) ? abs : null;
}

/** 入口文件字节的 sha256（上游逐文件校验的口径由 loader 的 hash 表提供；这里只做可读性闸）。 */
export function readEntrySource(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** `import.meta.url` 的目录（供 `runSetup` 组装入口 URL）。 */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 跑一个插件的 `setup(sp)`：**严格档源码扫描已由 `officialHost.js` 在 import 之前做过**，
 * 这里负责动态 import 与同步调用的**包装**（上游契约：`setup(sp)` 是同步的，注册在返回后关闭）。
 *
 * 沙箱诚实声明：本实现是**进程内**执行（与上游 `trusted` 档同级，不是 SES `Compartment`）。
 * 所以它只给 `trusted` 档用 —— `script` 档（上游走 SES）**不在这一层跑**，避免把「进程内执行」冒充沙箱。
 *
 * @param {object} plugin `loadOfficialPlugins` 的产物（含 dir / descriptor / hash）
 * @param {{ log?: any, settings?: object, budget?: number }} [opts]
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string, sp?: object }>}
 */
export async function runSetup(plugin, { log = null, settings = {}, budget = 0 } = {}) {
  const descriptor = plugin.descriptor || {};
  const ep = (descriptor.entrypoints || []).find((e) => e.kind === 'module' && e.id === 'server');
  if (!ep) return { ok: false, code: 'PLUGIN_NO_SETUP', reason: `plugin "${plugin.id}" does not declare entry.server (a setup(sp) plugin must run on the server, class trusted)` };
  if (descriptor.klass !== 'trusted') {
    return { ok: false, code: 'PLUGIN_SANDBOX_UNAVAILABLE', reason: `class "${descriptor.klass}" is not the trusted runtime — script plugins need the SES sandbox, which this build does not provide` };
  }
  const abs = resolveEntry(plugin, ep.entry);
  if (!abs || !fs.existsSync(abs)) return { ok: false, code: 'PLUGIN_BAD_ENTRY', reason: `entry.server "${ep.entry}" is not a readable file inside the plugin` };

  const url = `${(await import('node:url')).pathToFileURL(abs).href}?v=${encodeURIComponent(plugin.hash || '')}`;
  let ns;
  try { ns = await import(url); } catch (e) { return { ok: false, code: 'PLUGIN_IMPORT_FAILED', reason: `entry failed to load: ${e && e.message ? e.message : e}` }; }
  const setup = typeof ns?.default === 'function' ? ns.default : (typeof ns?.setup === 'function' ? ns.setup : (typeof ns?.activate === 'function' ? ns.activate : null));
  if (!setup) return { ok: false, code: 'PLUGIN_NO_SETUP', reason: 'the entry exports neither a default setup(sp) nor setup/activate' };

  const sp = createSDK(plugin, { settings, log: (...a) => log?.info?.(...a), budget });
  try { setup(sp); } catch (e) {
    return { ok: false, code: e && e.code === 'PLUGIN_PERMISSION_MISSING' ? 'PLUGIN_PERMISSION_MISSING' : 'PLUGIN_REGISTER_THREW', reason: `setup(sp): ${e && e.message ? e.message : e}` };
  }
  return { ok: true, sp };
}

export { here };
