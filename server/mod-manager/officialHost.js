// server/mod-manager/officialHost.js — 官方档的**进程内 module 运行时**（`sp:sdk@1`, profile `module`）。
//
// 与 Forge 档 `server.modules` 的三条硬差别（DESIGN 重构计划 §四 高风险 2 的分档处置）：
//   1. **只注入声明过的 capability**：`host` 上**只有** `apis` 里声明过的那几个面；碰没声明的那个**抛**
//      `PLUGIN_USE_UNDECLARED`（不是 undefined —— 一个 undefined 只会变成一行 `TypeError: not a function`，
//      作者看不出是「没声明」还是「拼错了」）。**没有 `globalThis` 豁免，没有 `process` / `require`**。
//   2. **严格档源码扫描**：import 之前先过 `serverModuleSourceIssues(src, id, 'entry', { profile: 'module' })`
//      —— 也就是含 `globalThis` 的那张表（GAP-1 修复的严格档）。扫描**必须**在 import 前跑：
//      模块的顶层副作用在 import 那一刻就已经发生。
//   3. **战斗类能力不进这一层**：`meta` / `battle` / `room` 改对局结果，要等确定性运行时那条线，这里**具名拒**。
//
// 预算复用 `mod-manager/budget.js` 的 `guarded`（与 Forge 档同一份记账，不另立一套）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { serverModuleSourceIssues, checkHealthzFields } from '../modModules.js';
// 房间事件闭集（与 Forge 档 `server.room` 同一张表、同一份语义：**只读观察**，返回值一律丢弃）。
import { ROOM_HOOK_EVENTS } from '../roomPack.js';

/** 需要**运行时面**的能力（其余是纯声明，数据走 manifest）。 */
export const HOST_CAPABILITIES = Object.freeze(['modules', 'storage', 'health', 'routes', 'metrics', 'lane', 'room']);
/**
 * 这一层**不接**的能力：`meta` / `battle` 改对局结果，要等确定性运行时那条线。
 * `room` **不在**这里 —— 它的契约是只读观察（DESIGN §28.20），能改结果的只有它的 `hold` 子字段，
 * 而官方档目前没有那一格。
 */
export const COMBAT_HOST_CAPABILITIES = Object.freeze(['meta', 'battle']);

/** 一个插件的 `registerPlugin(host)` 抛出这个（与 `ModuleRefused` 同形，带 `code`）。 */
export class PluginRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginRefused';
    this.code = code;
  }
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 一个官方插件的宿主对象。**深冻结**、**只含声明过的 capability**：没声明的那一格**抛**，不返回 undefined。
 *
 * @param {{
 *   pluginId: string, capabilities?: string[], stateRoot?: string|null, log?: any,
 *   mounted: { boot: Function[], shutdown: Function[], healthz: Function[], route: Array<{path:string,handler:Function,cache:string}> },
 *   metrics?: any, graph?: any,
 * }} opts
 */
export function createOfficialModuleHost({ pluginId, capabilities = [], stateRoot = null, log = noopLog, mounted, metrics = null }) {
  const has = (c) => capabilities.includes(c);
  const deny = (c) => { throw new PluginRefused('PLUGIN_USE_UNDECLARED', `plugin "${pluginId}" did not declare the "${c}" capability (declared: ${capabilities.join(', ') || 'none'})`); };

  // 声明了却不在这一层的面 ⇒ 明确说「等确定性运行时」，而不是给一个半成品
  for (const c of COMBAT_HOST_CAPABILITIES) {
    if (has(c)) throw new PluginRefused('PLUGIN_CAPABILITY_NOT_IN_THIS_LAYER', `plugin "${pluginId}" declares "${c}", which changes match results and is not provided by the in-process module runtime yet`);
  }

  const host = {};
  Object.defineProperty(host, 'id', { value: pluginId, enumerable: true });

  // 生命周期：boot / shutdown（声明 `modules` 才有）
  for (const hook of ['boot', 'shutdown']) {
    Object.defineProperty(host, hook === 'boot' ? 'onBoot' : 'onShutdown', {
      enumerable: true,
      value: has('modules') ? (fn) => { if (typeof fn !== 'function') throw new PluginRefused('PLUGIN_BAD_CALLBACK', `${hook} needs a function`); mounted[hook].push(fn); return true; } : () => deny('modules'),
    });
  }

  // /healthz 字段（声明 `health`）
  Object.defineProperty(host, 'health', {
    enumerable: true,
    value: Object.freeze({
      add: has('health')
        ? (fields) => {
          const checked = checkHealthzFields(fields, pluginId);
          if (!checked.ok) throw new PluginRefused('PLUGIN_BAD_HEALTHZ', checked.reason);
          if (checked.fields) mounted.healthz.push(() => checked.fields);
          return true;
        }
        : () => deny('health'),
    }),
  });

  // 只读标量快照（声明 `metrics`）
  Object.defineProperty(host, 'metrics', { enumerable: true, get: () => (has('metrics') ? metrics : deny('metrics')) });

  // 只读 HTTP 端点（声明 `routes`）：路径必须落在**本插件自己的**命名空间里
  Object.defineProperty(host, 'routes', {
    enumerable: true,
    value: Object.freeze({
      add: has('routes')
        ? (entry) => {
          const ee = entry && typeof entry === 'object' ? entry : {};
          const p = String(ee.path || '');
          const prefix = `/mod/${pluginId}/`;
          if (!p.startsWith(prefix)) throw new PluginRefused('PLUGIN_BAD_ROUTE', `route "${p}" must live under "${prefix}" (one plugin, one namespace)`);
          if (p.split('/').some((seg) => seg === '.' || seg === '..')) throw new PluginRefused('PLUGIN_BAD_ROUTE', `route "${p}" has a "." or ".." segment`);
          if (typeof ee.handler !== 'function') throw new PluginRefused('PLUGIN_BAD_ROUTE', `route "${p}" needs a handler function`);
          const cache = ee.cache === undefined ? 'no-store' : ee.cache;
          if (!['no-store', 'no-cache'].includes(cache)) throw new PluginRefused('PLUGIN_BAD_ROUTE', `route "${p}" cache must be no-store / no-cache (got ${JSON.stringify(ee.cache)})`);
          mounted.route.push({ path: p, handler: ee.handler, cache });
          return true;
        }
        : () => deny('routes'),
    }),
  });

  // 包私有状态目录（声明 `storage`）：`<stateRoot>/official/<插件id>/`，`..` 与绝对路径在这里就被拒
  const storageDir = stateRoot ? path.join(stateRoot, 'official', pluginId) : null;
  const resolve = (rel) => {
    const s = String(rel ?? '');
    const segs = s.split('/');
    if (!s || path.isAbsolute(s) || s.includes('\\') || segs.some((x) => !x || x === '.' || x === '..')) {
      throw new PluginRefused('PLUGIN_BAD_PATH', `storage path ${JSON.stringify(rel)} must be a relative path inside the plugin's own directory`);
    }
    const abs = path.join(storageDir, ...segs);
    if (!abs.startsWith(storageDir + path.sep)) throw new PluginRefused('PLUGIN_BAD_PATH', `storage path ${JSON.stringify(rel)} escapes the plugin directory`);
    return abs;
  };
  Object.defineProperty(host, 'storage', {
    enumerable: true,
    value: Object.freeze({
      read: has('storage')
        ? (rel) => {
          if (!storageDir) throw new PluginRefused('PLUGIN_NO_STATE_DIR', `plugin "${pluginId}" asked for storage but no state directory was provided`);
          try { return fs.readFileSync(resolve(rel), 'utf8'); } catch (e) { if (e instanceof PluginRefused) throw e; if (e.code === 'ENOENT') return null; throw e; }
        }
        : () => deny('storage'),
      write: has('storage')
        ? (rel, text) => {
          if (!storageDir) throw new PluginRefused('PLUGIN_NO_STATE_DIR', `plugin "${pluginId}" asked for storage but no state directory was provided`);
          const abs = resolve(rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, String(text));
          return abs;
        }
        : () => deny('storage'),
    }),
  });

  // lane（自带 WebSocket 通道）：本层尚未接传输，声明了就明说
  Object.defineProperty(host, 'lane', {
    enumerable: true, value: Object.freeze({ open: has('lane') ? () => { throw new PluginRefused('PLUGIN_CAPABILITY_NOT_IN_THIS_LAYER', `plugin "${pluginId}": lanes are not wired into the transport yet`); } : () => deny('lane') }),
  });

  // 房间生命周期事件（声明 `room`，Phase 7 的第一项）：**只读观察** —— 注册面与 Forge 档同一张事件闭集，
  // 返回值一律丢弃（能改结果的 `hold` 是另一格，官方档还没有）。注册结果落在 `mounted.room`，由接线方交给
  // `server/roomPack.js` 的 `createRoomHooks`（`fire(room, event)`）。
  Object.defineProperty(host, 'room', {
    enumerable: true,
    value: Object.freeze({
      on: has('room')
        ? (event, fn) => {
          if (!ROOM_HOOK_EVENTS.includes(event)) {
            throw new PluginRefused('PLUGIN_BAD_ROOM_EVENT', `room event ${JSON.stringify(event)} is not one of ${ROOM_HOOK_EVENTS.join(', ')}`);
          }
          if (typeof fn !== 'function') {
            throw new PluginRefused('PLUGIN_BAD_ROOM_EVENT', `room.on(${JSON.stringify(event)}, …) needs a function — room hooks are observation-only, their return value is discarded`);
          }
          mounted.room.push({ event, fn });
          return true;
        }
        : () => deny('room'),
    }),
  });

  // 声明了但没有**运行时面**的那些（content / assets / i18n / notices / overrides / matchKinds…）：
  // 数据走 manifest，宿主上**不长这些键**——包拿不到多余的面。
  return Object.freeze(host);
}

/**
 * **官方档房间钩子 → 既有房间总线**的桥（Phase 7 第一项）。
 *
 * 产出的是 `server/roomPack.js` `createRoomHooks({ installers })` 认的那种条目：`{ id, pack, hash, install }`，
 * 其中 `install(api)` 拿到的 `api` 与 Forge 档包拿到的是**同一个**（`api.on(event, fn)`、只读观察面）。
 * 于是官方插件的房间钩子与 Forge 包的房间钩子共用**同一条**总线 —— 同一份顺序（包 id 升序）、同一份
 * 「一个钩子抛异常只记一行、房间照旧工作」的隔离。
 *
 * 没有声明 `room`（或没有官方插件）⇒ **空数组**，调用方 `[...x, ...[]]` 与从前逐元素相同。
 *
 * 已知边界（诚实写下来）：`createRoomHooks` 对**声明了 `modSet` 的房间**只装集合里那几个包，而官方插件
 * （刻意的）不在进程级 mod 集合里 ⇒ 一个带 `modSet` 的房间不会装官方房间钩子。等官方插件进入运行时集合那条线
 * 打通，这条边界自然消失。
 * @param {Array<any>} modules `loadOfficialModules(...)` 的 `modules`
 */
export function officialRoomInstallers(modules) {
  return (Array.isArray(modules) ? modules : [])
    .filter((m) => m && typeof m.pack === 'string' && m.mounted && Array.isArray(m.mounted.room) && m.mounted.room.length)
    // **按包 id 升序**：`createRoomHooks` 自己**不排序**（Forge 档的 installers 在装载时已经排过），
    // 所以顺序保证必须由这一层给出 —— 与 `server/workshop.js` 的 `loadRoomInstallers` 同一条纪律。
    .slice()
    .sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0))
    .map((m) => ({
      id: m.pack,
      pack: m.pack,
      hash: m.hash || '',
      install(api) {
        for (const r of m.mounted.room) api.on(r.event, r.fn);
      },
    }));
}

/** 一个插件的入口绝对路径（必须在插件目录之内）。 */
function entryAbs(plugin, entry) {
  const abs = path.join(plugin.dir, ...String(entry).split('/'));
  return (abs === plugin.dir || abs.startsWith(plugin.dir + path.sep)) ? abs : null;
}

/**
 * 装载官方插件里**声明了 `modules`** 的那些：严格档扫描 → 动态 import → `registerPlugin(host)`。
 * 失败**不抛**，一条 `{ pack, code, reason }` 回到调用方（与 Forge 档同一个裁剪点语义）。
 *
 * @param {Array<any>} plugins `loadOfficialPlugins(...)` 的产物
 * @param {{ log?: any, stateRoot?: string|null, metrics?: any, importModule?: (url: string) => Promise<any> }} [opts]
 */
export async function loadOfficialModules(plugins, { log = noopLog, stateRoot = null, metrics = null, importModule = (url) => import(url) } = {}) {
  const modules = [];
  const errors = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const caps = plugin?.descriptor?.capabilities || [];
    if (!caps.includes('modules')) continue;
    const ep = (plugin.descriptor.entrypoints || []).find((e) => e.kind === 'module');
    const abs = ep && entryAbs(plugin, ep.entry);
    if (!abs || !fs.existsSync(abs)) {
      errors.push({ pack: plugin.id, code: 'PLUGIN_BAD_ENTRY', reason: `declared "entry" (${ep ? ep.entry : 'none'}) is not a readable file inside the plugin` });
      continue;
    }
    let source;
    try { source = fs.readFileSync(abs, 'utf8'); } catch (e) { errors.push({ pack: plugin.id, code: 'PLUGIN_BAD_ENTRY', reason: `entry is not readable: ${e && e.message ? e.message : e}` }); continue; }
    // **严格档扫描必须在 import 之前**（含 `globalThis`）。
    const issues = serverModuleSourceIssues(source, plugin.id, 'entry', { profile: 'module' });
    if (issues.length) { errors.push({ pack: plugin.id, code: 'PLUGIN_BAD_SOURCE', reason: issues[0].reason }); log?.warn?.(`[official] ${plugin.id}: ${issues[0].reason}`); continue; }

    const mounted = { boot: [], shutdown: [], healthz: [], route: [], room: [] };
    const url = `${pathToFileURL(abs).href}?v=${encodeURIComponent(plugin.hash || '')}`;
    let ns;
    try { ns = await importModule(url); } catch (e) { errors.push({ pack: plugin.id, code: 'PLUGIN_IMPORT_FAILED', reason: `entry failed to load: ${e && e.message ? e.message : e}` }); continue; }
    if (!ns || typeof ns.registerPlugin !== 'function') {
      errors.push({ pack: plugin.id, code: 'PLUGIN_NO_REGISTER', reason: `entry does not export a registerPlugin(host) function` });
      continue;
    }
    try {
      ns.registerPlugin(createOfficialModuleHost({ pluginId: plugin.id, capabilities: caps, stateRoot, log, mounted, metrics }));
    } catch (e) {
      errors.push({ pack: plugin.id, code: e instanceof PluginRefused ? e.code : 'PLUGIN_REGISTER_THREW', reason: `registerPlugin(host): ${e && e.message ? e.message : e}` });
      continue;
    }
    modules.push({ pack: plugin.id, id: 'entry', entry: ep.entry, hash: plugin.hash || '', uses: caps.filter((c) => HOST_CAPABILITIES.includes(c)), mounted });
  }
  return { modules, errors };
}
