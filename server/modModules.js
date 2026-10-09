// server/modModules.js — 包的**服务端模块**载荷（DESIGN §28.14）。
//
// 为什么要有这一类：社区插件包要做的事（停机播报与快照留档、匿名对局统计落盘、给 `/healthz` 加几个字段）**每一条**
// 都与 kit 相反 —— kit 是战斗里的代码，契约明写「不碰文件系统、不碰网络」；这三件件件要写盘、要挂启动钩子、要给一个
// 既有 HTTP 端点加字段。今天它们只能靠**手改引擎文件**（那三个 `.js` 原件就是这么发的）。这一类载荷就是那条不手改的
// 通道。
//
// 与 `server.meta` 的分工：meta 在**对局里**执行（改对局逻辑，必须 `combat: true`），这里的东西**不在对局里**——
// 它挂在启动/停机、`/healthz` 与 `MatchClass` 这三处（`matchClass` 是唯一能碰到对局的那一个，所以只有它要求
// `combat: true`）。
//
// 安全性不来自「禁掉什么」，而来自**只给声明过的那几样**：
//   * `uses` 里的每个挂载点各对应宿主对象上的一个函数；没声明的那个一碰就抛 `MODULE_USE_UNDECLARED`（不是 undefined，
//     一个 undefined 只会变成一行 `TypeError: not a function`，作者看不出是「没声明」还是「拼错了」）；
//   * `write: true` 才拿到 `host.io`，而它被限定在 `<状态目录>/mod/<包id>/`：包自己的目录只读，引擎的目录根本不在
//     门面里（`..` 与绝对路径在这里就被拒）；
//   * 模块的**字节进包的内容哈希**（与 kits / panels / meta 同一条），所以「同一个房间摘要 ⇒ 同一份服务端代码」。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SERVER_MODULE_USES } from '../shared/workshop.js';

/** 静默的日志替身（装载期不需要日志时用）。 */
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** 状态目录的根：`SP_STATE_DIR` 优先，否则 `<仓库>/var` —— 与那三件原件的 `var/state`、`var/stats` 同一棵树。 */
export function stateRootFor(repoRoot) {
  return process.env.SP_STATE_DIR ? path.resolve(process.env.SP_STATE_DIR) : path.join(repoRoot, 'var');
}

/** 声明过 `write` 的模块拿到的目录：`<状态目录>/mod/<包id>/`（一个包一个，永不与别的包共享）。 */
export function moduleStateDir(stateRoot, packId) {
  return path.join(stateRoot, 'mod', packId);
}

/** 挂载点拒绝：带错误码，装配层据此点名而不是打一句堆栈。 */
export class ModuleRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModuleRefused';
    this.code = code;
  }
}

/**
 * **被限定在模块自己的状态目录里**的文件门面。三条性质：
 *   * 路径以状态目录为根解析，`..` / 绝对路径 / 空段一律拒（包不能借它读引擎的文件）；
 *   * 目录**按需创建**（第一次写才 mkdir，一个声明了 write 却从没写过的包不在磁盘上留东西）；
 *   * 只暴露少数几个动作，不做通配（没有 `exec`、没有流、没有目录遍历之外的读取）。
 * @param {string} dir 绝对路径（`moduleStateDir`）
 */
function ioFacade(dir) {
  /** 把一个包内相对路径解析到这个目录里。 */
  const resolve = (rel, { forWrite = false } = {}) => {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\')) {
      throw new ModuleRefused('MODULE_IO_BAD_PATH', `"${String(rel)}" must be a relative path with forward slashes`);
    }
    const segments = rel.split('/');
    if (segments.some((s) => !s || s === '.' || s === '..')) {
      throw new ModuleRefused('MODULE_IO_BAD_PATH', `"${rel}" may not contain empty, "." or ".." segments (the facade stays inside this pack's own state directory)`);
    }
    const abs = path.join(dir, ...segments);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      throw new ModuleRefused('MODULE_IO_BAD_PATH', `"${rel}" resolves outside this pack's state directory`);
    }
    if (forWrite) fs.mkdirSync(path.dirname(abs), { recursive: true });
    return abs;
  };
  return Object.freeze({
    /** 这个包自己的状态目录（绝对路径；仅用于日志与诊断）。 */
    dir,
    write(rel, data) { fs.writeFileSync(resolve(rel, { forWrite: true }), data); return true; },
    append(rel, data) { fs.appendFileSync(resolve(rel, { forWrite: true }), data); return true; },
    read(rel) { try { return fs.readFileSync(resolve(rel), 'utf8'); } catch { return null; } },
    exists(rel) { try { return fs.existsSync(resolve(rel)); } catch { return false; } },
    remove(rel) { try { fs.rmSync(resolve(rel)); return true; } catch { return false; } },
    /** 这个目录里的条目名（排序；目录尚不存在时是空数组）。 */
    list() { try { return fs.readdirSync(dir).sort(); } catch { return []; } },
  });
}

/**
 * 一个模块拿到的**宿主对象**。它把「声明了什么」变成「能用什么」，其余的键一律抛。
 *
 * 为什么要抛而不是给 `undefined`：`host.healthz?.(...)` 与 `host.healthz(...)` 的区别只对写代码的人有意义，
 * 而作者看到的是「没生效」；带码的异常会直接说出「你没在 uses 里声明它」。
 */
export function moduleHost({ packId, moduleId, hash, dir, uses, write, stateRoot, log = noopLog, registry = null }) {
  const declared = (use) => Array.isArray(uses) && uses.includes(use);
  const say = (use) => {
    throw new ModuleRefused('MODULE_USE_UNDECLARED',
      `server.modules["${moduleId}"].uses does not include "${use}" — a module gets exactly the mount points it declared (declared: ${(uses || []).join(', ') || 'none'})`);
  };
  const scoped = Object.freeze({
    info: (...a) => log.info?.(`[mod ${packId}/${moduleId}]`, ...a),
    warn: (...a) => log.warn?.(`[mod ${packId}/${moduleId}]`, ...a),
    error: (...a) => log.error?.(`[mod ${packId}/${moduleId}]`, ...a),
  });
  const io = write && stateRoot
    ? ioFacade(moduleStateDir(stateRoot, packId))
    : Object.freeze({
      get dir() { return say('write'); },
      write() { return say('write'); }, append() { return say('write'); }, read() { return say('write'); },
      exists() { return say('write'); }, remove() { return say('write'); }, list() { return say('write'); },
    });
  /** 挂载点的登记处：装载器把这里收到的函数按用途收走（`boot` / `shutdown` / `healthz` / `matchClass`）。 */
  const mount = (use) => (fn) => {
    if (!declared(use)) say(use);
    if (typeof fn !== 'function') {
      throw new ModuleRefused('MODULE_BAD_HOOK', `server.modules["${moduleId}"].${use}(...) needs a function, got ${typeof fn}`);
    }
    return registry ? registry(use, fn) : true;
  };
  return Object.freeze({
    pack: packId,
    module: moduleId,
    hash: hash || '',
    /** 包的目录（只读；要读包内文件用 `io.read` 才走得到，`dir` 只用于诊断）。 */
    dir,
    log: scoped,
    io,
    /** 服务起来之后跑一次（`server/index.js` 在 listen 之后调用）。 */
    onBoot: mount('boot'),
    /** 服务停机时跑一次（关闭流程里，失败只记日志，不阻塞停机）。 */
    onShutdown: mount('shutdown'),
    /** 贡献 `/healthz` 的字段：回调返回一个**扁平**的 JSON 对象（值只能是字符串/数字/布尔/null），带大小上限。 */
    healthz: mount('healthz'),
    /** 用一层包装器包住 `MatchClass`（`fn(Base) => Subclass`）；只有这一项要求包声明 `combat: true`。 */
    matchClass: mount('matchClass'),
  });
}

/** `/healthz` 上一个包最多贡献多少个字段 / 多少字节（端点是给运维看的，不是数据通道）。 */
export const HEALTHZ_LIMITS = Object.freeze({ fields: 12, bytes: 2048 });

/** 一个 `healthz` 回调的返回值判据：扁平、标量、有界。`null` 表示「这次没有要说的」（合法，不加字段）。 */
export function checkHealthzFields(value, moduleId) {
  if (value === null || value === undefined) return { ok: true, fields: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: `server.modules["${moduleId}"].healthz(...) must return a flat object of scalars (or null)` };
  }
  const keys = Object.keys(value);
  if (keys.length > HEALTHZ_LIMITS.fields) {
    return { ok: false, reason: `server.modules["${moduleId}"].healthz(...) returned ${keys.length} fields (at most ${HEALTHZ_LIMITS.fields})` };
  }
  const out = {};
  for (const key of keys) {
    const v = value[key];
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      return { ok: false, reason: `server.modules["${moduleId}"].healthz(...)["${key}"] must be a string, number, boolean or null (nested values make /healthz unbounded)` };
    }
    if (typeof v === 'number' && !Number.isFinite(v)) {
      return { ok: false, reason: `server.modules["${moduleId}"].healthz(...)["${key}"] is not a finite number` };
    }
    out[key] = v;
  }
  if (JSON.stringify(out).length > HEALTHZ_LIMITS.bytes) {
    return { ok: false, reason: `server.modules["${moduleId}"].healthz(...) is larger than ${HEALTHZ_LIMITS.bytes} characters` };
  }
  return { ok: true, fields: out };
}

/** 一个声明的服务端模块的绝对路径（形状层已经判过「包内相对 + .mjs」）。 */
function entryAbs(pack, mod) {
  return path.join(pack.dir, ...String(mod.entry).split('/'));
}

/**
 * 启动时一次：把每个声明了 `server.modules` 的包读出来、import，收下它挂上去的东西。
 *
 * 失败**不抛**：一条 `{ pack, code, reason }` 回到调用方，由它按「一条用不了的声明拒绝整个包」把包裁掉
 * （`server/index.js` 与 `server.preDispatch` / `server.meta` 走**同一个裁剪点**）。
 *
 * @param {{ packs?: Array<any> }} loaded `loadWorkshop(...)`
 * @param {{ log?: any, stateRoot?: string, importModule?: (url: string) => Promise<any> }} [opts]
 * @returns {Promise<{ modules: Array<any>, errors: Array<{ pack: string, code: string, reason: string }> }>}
 */
export async function loadServerModules(loaded, { log = noopLog, stateRoot = null, importModule = (url) => import(url) } = {}) {
  const modules = [];
  const errors = [];
  const packs = (loaded && Array.isArray(loaded.packs) ? loaded.packs : [])
    .filter((p) => p && p.server && Array.isArray(p.server.modules) && p.server.modules.length)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const pack of packs) {
    for (const mod of pack.server.modules) {
      const abs = entryAbs(pack, mod);
      const inPack = abs === pack.dir || abs.startsWith(pack.dir + path.sep);
      let readable = false;
      try { readable = inPack && fs.statSync(abs).isFile(); } catch { /* stays false: no such file */ }
      if (!readable) {
        errors.push({ pack: pack.id, code: 'MODULES_BAD_ENTRY', reason: `server.modules["${mod.id}"].entry "${mod.entry}" is not a readable file inside the pack` });
        continue;
      }
      // 模块 URL 带包摘要：包换了一版（目录里的字节变了）就是另一条 URL，动态 import 缓存不会把旧模块交回来。
      const url = `${pathToFileURL(abs).href}?v=${encodeURIComponent(pack.hash || '')}&m=${encodeURIComponent(mod.id)}`;
      let ns;
      try {
        ns = await importModule(url);
      } catch (e) {
        errors.push({ pack: pack.id, code: 'MODULES_IMPORT_FAILED', reason: `server.modules["${mod.id}"].entry "${mod.entry}" failed to load: ${e && e.message ? e.message : e}` });
        continue;
      }
      if (!ns || typeof ns.registerServer !== 'function') {
        errors.push({ pack: pack.id, code: 'MODULES_NO_REGISTER', reason: `server.modules["${mod.id}"].entry "${mod.entry}" does not export a registerServer(host) function` });
        continue;
      }
      /** @type {{ boot: Function[], shutdown: Function[], healthz: Function[], matchClass: Function[] }} */
      const mounted = { boot: [], shutdown: [], healthz: [], matchClass: [] };
      const host = moduleHost({
        packId: pack.id, moduleId: mod.id, hash: pack.hash, dir: pack.dir,
        uses: mod.uses, write: mod.write, stateRoot, log,
        registry: (use, fn) => { mounted[use].push(fn); return true; },
      });
      try {
        // 同步调用：与官方内容模块同形（`registerMeta(registry)` 也是同步的），所以「注册没注册上」不需要等一个 Promise。
        ns.registerServer(host);
      } catch (e) {
        const code = e instanceof ModuleRefused ? e.code : 'MODULES_REGISTER_THREW';
        errors.push({ pack: pack.id, code, reason: `server.modules["${mod.id}"]: ${e && e.message ? e.message : e}` });
        log.warn?.(`[workshop] ${code}: ${pack.id}/${mod.id}: ${e && e.message ? e.message : e}`);
        continue;
      }
      mounted.uses = mod.uses;
      modules.push({ pack: pack.id, id: mod.id, entry: mod.entry, hash: pack.hash || '', dir: pack.dir, uses: mod.uses, write: mod.write, mounted });
    }
  }
  return { modules, errors };
}

/**
 * 把装载结果变成三样东西：启动 / 停机钩子、`/healthz` 的字段、`MatchClass` 的包装器。
 *
 * 顺序按**包 id**（`loadServerModules` 已经排过），所以「多个包同时给 `/healthz` 加字段 / 包同一层 MatchClass」时
 * 结果不随目录读取顺序变（DESIGN §28.3 的同一条规则）。
 */
export function mountServerModules(modules, { log = noopLog } = {}) {
  const list = Array.isArray(modules) ? modules.slice() : [];
  return {
    /** 服务起来之后：每个挂了 `boot` 的模块跑一次；抛异常只记日志（一个包不该让服务起不来）。 */
    boot() {
      for (const m of list) {
        for (const fn of m.mounted.boot) {
          try { fn(); } catch (e) { log.error?.(`[workshop] ${m.pack}/${m.id} onBoot threw`, e); }
        }
      }
    },
    /** 停机：与 `boot` 同一条（失败只记日志，不阻塞停机流程）。 */
    shutdown() {
      for (const m of list) {
        for (const fn of m.mounted.shutdown) {
          try { fn(); } catch (e) { log.error?.(`[workshop] ${m.pack}/${m.id} onShutdown threw`, e); }
        }
      }
    },
    /**
     * `/healthz` 的 `modHealth`：`{ "<包id>": { "<字段>": 标量 } }`。按包 id 分组（两个包不能互相盖字段），
     * 返回**空对象**时调用方不加这个键（干净安装的 `/healthz` 字节不变）。
     */
    healthz() {
      /** @type {Record<string, Record<string, any>>} */
      const out = {};
      for (const m of list) {
        for (const fn of m.mounted.healthz) {
          let value;
          try { value = fn(); } catch (e) { log.warn?.(`[workshop] ${m.pack}/${m.id} healthz threw: ${e && e.message ? e.message : e}`); continue; }
          const checked = checkHealthzFields(value, `${m.pack}/${m.id}`);
          if (!checked.ok) { log.warn?.(`[workshop] ${checked.reason}`); continue; }
          if (!checked.fields) continue;
          out[m.pack] = { ...(out[m.pack] || {}), ...checked.fields };
        }
      }
      return out;
    },
    /** `MatchClass` 的包装器：按包 id 次序层层套上（第一个包的包装器在最里层）。 */
    matchClassWrappers() {
      const out = [];
      for (const m of list) for (const fn of m.mounted.matchClass) out.push({ pack: m.pack, id: m.id, fn });
      return out;
    },
  };
}

/** 被允许的挂载点（与形状层的闭枚举同一份；供文档与测试引用）。 */
export const MODULE_USES = SERVER_MODULE_USES;
