// server/mod-manager/officialSdk.js — 官方档 **`setup(sp)` SDK 表面**（`sp:sdk@1` 的上游契约）。
//
// 上游 0.3.0 的插件入口契约（`docs/PLUGINS.md:756`）是
//   `export default function setup(sp) { ... }`
// 而 `sp` 由 `shared/plugins/sdk.js createSDK` 构造：
//   `sp = { kit, math, constants, settings, kits.register, enemies.register, content.register, meta.register, log }`
// 读到未声明的键 = `undefined`；**权限缺失才抛** `PLUGIN_PERMISSION_MISSING`（`sdk.js:35-37`）。
//
// 本文件按**同一份表面**构造 `sp`，注册动作落到 `server/sim/content/extensions.js`（0.3.0 同一份实现，
// 已 vendor 进本仓并接进 Forge 的 `installContent` / `registerAllMeta`）。
// `kit` / `math` / `constants` 三个冻结数据面见 `server/sim/content/sdkData.js`（纯值，无运行时状态）。
//
// 与我方 `host.*` 面的关系：**两份面并存** —— 插件作者用哪份都行。入口检测顺序（`officialHost.loadOfficialModules`）：
//   `setup(sp)`（上游契约）→ `registerPlugin(host)`（我方契约）→ 都没有才拒。
//
// 诚实边界：本实现是**进程内**执行 —— 与上游 `trusted` 档同级，**不是** `script` 档的 SES `Compartment` 沙箱
// （SES 需要 `ses`/`acorn` 依赖与子进程隔离，未在本仓引入）。`script` 档（描述符 profile = `sandbox`）由
// `loadOfficialModules` 的**装载门**具名拒载（`PLUGIN_SANDBOX_UNAVAILABLE`，见 `officialHost.js` 的
// `UNWIRED_PROFILES`）—— 绝不把「声明隔离」的插件放进宿主进程跑。

import { kit, math, constants } from '../sim/content/sdkData.js';
import { registerKit, registerEnemy, registerContent, registerMeta } from '../sim/content/extensions.js';

/** 装载上限（上游 `shared/plugins/sandbox.js:8` 同一份数字；tests 引用）。 */
export const SANDBOX_LIMITS = Object.freeze({ files: 64, bytes: 1024 * 1024 });

/**
 * 构造一份 `setup(sp)` 的 `sp`（上游 `createSDK` 同形）。注册动作全部落到 extensions.js。
 *
 * @param {{ id: string, officialPermissions?: string[] }} plugin 描述符的最小投影
 * @param {{ settings?: object, log?: Function }} [opts]
 */
export function createSDK(plugin, { settings = {}, log = (..._args) => {} } = {}) {
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
    kits: Object.freeze({ register: (id, fn) => { need('sim.code'); return registerKit(plugin, id, fn); } }),
    enemies: Object.freeze({ register: (id, fn) => { need('sim.code'); return registerEnemy(plugin, id, fn); } }),
    content: Object.freeze({ register: (mod) => { if (mod && mod.install) need('sim.code'); if (mod && mod.registerMeta) need('meta.code'); return registerContent(plugin, mod); } }),
    meta: Object.freeze({ register: (id, h) => { need('meta.code'); return registerMeta(plugin, id, h); } }),
    log: (...args) => { if (lines++ < 20) log(`[plugin:${plugin.id}]`, ...args.map((x) => String(x).slice(0, 500))); },
  });
}
