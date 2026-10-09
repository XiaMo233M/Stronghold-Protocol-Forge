// 包声明的**对局元注册表模块**的装配路径（`pack.json.server.meta`, DESIGN §29）。
//
// 三层结构，与 `server.preDispatch` 的钩子路径同形：
//   * **形状**（`shared/workshop.js parseMetaDecl`）：`{ module, registers }`，键是 `<类>:<id>` 或一条结尾 `*` 的前缀；
//   * **装载**（本文件 `loadMetaModules`，启动时一次）：静态确定性扫描 → 动态 `import` → 有没有 `registerMeta` 导出；
//   * **装配**（本文件 `buildRoomRegistry`，每局一份）：`MetaRegistry.fork()` 出来的副本上，用**受限注册表**逐包注册。
//
// 两条不可动的纪律：
//   1. **禁止全局 set/restore**（DESIGN §29）：包的处理器只进**这一局**那一份 fork，绝不改进程级的
//      `getDefaultRegistry()`。多局并发时「开局前设全局、打完恢复」本来就是错的。
//   2. **没声明就等于不许**：`registers` 是白名单不是提示 —— 受限注册表对任何没列进去的键一注册就抛
//      （`META_UNDECLARED_KEY`），否则一个包可以**悄悄顶掉官方的**处理器（`register()` 是「后注册的赢」）。
//
// 多包共存按 DESIGN §28.3 的同一条规则：**包 id 升序**、**冲突点名**、**不静默覆盖**。两个包抢同一个键时，
// id 小的那个持有它，另一个包的那次装配**整个回滚**并点名报告 —— 与内容层 `PACK_ID_COLLISION` 同一个口径。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { KIT_FORBIDDEN_GLOBALS, stripComments, mentionsIdentifier } from '../../shared/kitAuthoring.js';
import { META_KEY_CLASSES } from '../../shared/workshop.js';
import { MOD_API_VERSION } from '../../shared/constants.js';
import { MetaRegistry } from './effectsMeta.js';
import { num, bondRecord, itemRecord, garrisonRecord, bandRecord, effectRecord, buffsOf, buffParams, itemKeyOf, isGoldenId } from '../sim/content/support/index.js';

/**
 * 除 kit 那套「不确定性 / 环境绑定」名单之外，**服务端**模块还要禁掉的东西。
 *
 * 为什么名单分两段而不是另起一份：`server.meta` 模块与 kit 是同一类东西（对局逻辑），共用同一份判据才不会漂 ——
 * 计划里那句「错误码与文案与 kit 那套一致」就是这个意思。kit 跑在浏览器里所以禁 `document` / `window`；
 * 而 meta 模块跑在**服务端对局进程**里，`process` / `require` / 动态 `import()` 这些是它比 kit 多出来的口子。
 */
const META_FORBIDDEN_EXTRA = Object.freeze([
  ['process', 'a meta module runs inside the match loop — reading the environment makes the same seed play out differently on another machine'],
  ['globalThis', 'a meta module must not reach outside its own registration: what it may do is exactly what the registry and ctx give it'],
  ['require', 'the engine loads this file as ESM — require() does not exist here, and a CommonJS escape hatch would bypass this scan'],
  ['eval', 'eval defeats the deterministic scan (the scan is what keeps the golden corpus meaningful)'],
  ['new Function', 'new Function defeats the deterministic scan, like eval'],
]);

/** 一个 meta 模块只许 import **包内相对文件**。引擎的辅助函数走 `registry.api`，不走 import —— 见下面的说明。 */
function importSpecifiers(code) {
  const out = [];
  const re = /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m[1]);
  const dyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dyn.exec(code); m; m = dyn.exec(code)) out.push(m[1]);
  return out;
}

/** 一条相对说明符爬了几层 `../`（`./x` → 0）。 */
function climbOf(spec) {
  let n = 0;
  let rest = spec;
  while (rest.startsWith('../')) { n++; rest = rest.slice(3); }
  return n;
}

/**
 * 静态判定一个 meta 模块的源码，**在 import 之前**。这是启发式，不是沙箱：真正兜底的是 golden 语料与房间摘要。
 * 但它必须挡在 import 前面 —— 一个 `Math.random` 的对局逻辑一旦被 import，副作用可能已经发生在模块顶层。
 *
 * `modulePath` 是声明的包内路径（`meta/m.mjs`）：用它算这个模块**最多能爬几层** `../` 而不出包。少了这一步，
 * 一条 `import '../../server/sim/content/support/index.js'` 会绕过「引擎辅助函数走 registry.api」这条线，
 * 把引擎的内部路径写进包 —— 那正是这一层要挡的东西。
 * @param {string} source
 * @param {string} packId
 * @param {string} [modulePath] 声明的 `server.meta.module`（包内相对）
 * @returns {Array<{ code: string, reason: string }>}
 */
export function metaSourceIssues(source, packId = '', modulePath = '') {
  const text = String(source ?? '');
  const code = stripComments(text);
  const out = [];
  for (const [needle, why] of [...KIT_FORBIDDEN_GLOBALS, ...META_FORBIDDEN_EXTRA]) {
    if (mentionsIdentifier(code, needle)) {
      out.push({ code: 'META_BAD_SOURCE', reason: `"${needle}" is not allowed in a server.meta module${packId ? ` ("${packId}")` : ''}: ${why}` });
    }
  }
  // `import` 只许指向包内，且不许爬出包：深度 = 声明路径的目录层数（`meta/m.mjs` → 1，`m.mjs` → 0）。
  const depth = String(modulePath || '').split('/').length - 1;
  for (const spec of importSpecifiers(code)) {
    if (spec.startsWith('./') && !spec.startsWith('../')) continue;
    if (spec.startsWith('../') && climbOf(spec) <= depth) continue;
    out.push({
      code: 'META_BAD_IMPORT',
      reason: `"${spec}" is not a file inside this pack: a server.meta module may import only its own pack's files (helpers come from registry.api — see docs/WORKSHOP.md §1.11)`,
    });
  }
  return out;
}

/**
 * 一条注册键是否落在声明里。声明项要么与键逐字相同，要么是一条结尾 `*` 的**前缀**（形状层已保证只有一个结尾 `*`）。
 * @param {string} key
 * @param {readonly string[]} registers
 */
export function keyDeclared(key, registers) {
  if (!Array.isArray(registers)) return false;
  for (const entry of registers) {
    if (typeof entry !== 'string') continue;
    if (entry === key) return true;
    if (entry.endsWith('*') && entry.length > 1 && key.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

/** 受限注册表拒绝一次注册时抛这个 —— 带错误码，好让装配层点名而不是打一句堆栈。 */
export class MetaRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MetaRefused';
    this.code = code;
  }
}

/**
 * **受限注册表**：包拿到的就是这一个对象，它只放行声明过的键。
 *
 * 为什么用 `#target` 私有字段而不是一个 `this.raw = registry`：后者让 `registry.raw.register('bond:yanShip', …)`
 * 一行就绕过白名单 —— 白名单能绕就等于没有。私有字段在语言层面拿不到，这条口子是关着的。
 *
 * 只读面（`get` / `has` / `keys` / `globals`）**照旧开放**：合作是有意义的（一个包完全可以「官方有 bond:x 我就让路」），
 * 而读不改行为。写面只有 `register` 与 `unregister` 两个入口，两个都过白名单。
 */
export class GuardedMetaRegistry {
  #target;
  #registers;
  #packId;
  #mine = new Set();
  #owners;

  /**
   * @param {MetaRegistry} target 这一局的注册表副本（装配层逐包推进的那一份）
   * @param {{ id?: string, registers?: readonly string[] }} pack
   * @param {Map<string, string>} [owners] 本局已被哪个包持有的键（多包冲突点名用）
   */
  constructor(target, pack, owners = new Map()) {
    this.#target = target;
    this.#registers = Array.isArray(pack && pack.registers) ? pack.registers : [];
    this.#packId = (pack && pack.id) || '';
    this.#owners = owners;
  }

  /**
   * 撤销**这次装配**留下的持有登记（装配层在包失败时调）。
   *
   * 少了它，一个注册到一半抛掉的包会把自己的键**留在持有表里** —— 后一个合法声明同一个键的包会被一个
   * 「根本没装上」的包判成冲突（`META_KEY_TAKEN`），而它的理由里点的是那个包的名字。这是真的发生过的一次失败
   * （`test/packMetaAssembly.test.js` 的「声明之外的键」那一组钉着它）。
   */
  rollback() {
    for (const key of this.#mine) this.#owners.delete(key);
    this.#mine.clear();
  }

  /** 引擎允许包用的辅助函数。**冻结**，且是这一层唯一的「引擎内部」入口 —— 版本号随 `MOD_API_VERSION`。 */
  get api() { return META_API; }
  get packId() { return this.#packId; }
  get registers() { return [...this.#registers]; }

  #allow(key) {
    if (typeof key !== 'string' || !key) throw new MetaRefused('META_UNDECLARED_KEY', `a meta module must register a "<class>:<id>" key, got ${JSON.stringify(key)}`);
    if (!keyDeclared(key, this.#registers)) {
      throw new MetaRefused('META_UNDECLARED_KEY',
        `"${key}" is not in this pack's server.meta.registers — a pack may register only the keys it declared (${this.#registers.join(', ') || 'none'}); declaring it is what puts it into the room digest gate (DESIGN §29)`);
    }
    const holder = this.#owners.get(key);
    if (holder && holder !== this.#packId) {
      throw new MetaRefused('META_KEY_TAKEN',
        `"${key}" is already registered by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3), and an "overrides" entry does not win against another pack`);
    }
  }

  register(key, handler) {
    this.#allow(key);
    this.#target.register(key, handler);
    this.#mine.add(key);
    this.#owners.set(key, this.#packId);
    return this;
  }

  /**
   * 只许撤掉**自己这次注册过的**键。撤掉一个官方处理器（或另一个包的）与覆盖它是同一件事 ——
   * 而且更难发现：日志里只会少一条效果。
   */
  unregister(key) {
    if (!this.#mine.has(key)) {
      throw new MetaRefused('META_NOT_OWNED',
        `unregister("${key}") refused: a meta module may only remove a key it registered itself in this same call (removing an official or another pack's handler is a silent behaviour change)`);
    }
    this.#mine.delete(key);
    this.#owners.delete(key);
    return this.#target.unregister(key);
  }

  // 下面这些是同一件写操作的糖（与 `MetaRegistry` 的七个方法逐字同名 —— `test/packMeta.test.js` 用反射把两份名单钉在一起）
  garrison(effectKey, h) { return this.register(`garrison:${effectKey}`, h); }
  band(bandId, h) { return this.register(`band:${bandId}`, h); }
  bond(bondId, h) { return this.register(`bond:${bondId}`, h); }
  item(key, h) { return this.register(`item:${itemKeyOf(key)}`, h); }
  choice(effectId, h) { return this.register(`choice:${effectId}`, h); }
  effect(id, h) { return this.register(`effect:${id}`, h); }
  global(name, h) { return this.register(`global:${name}`, h); }

  // 只读面：原样透传（读不改行为，而且合作要靠它）
  get(key) { return this.#target.get(key); }
  has(key) { return this.#target.has(key); }
  keys() { return this.#target.keys(); }
  globals() { return this.#target.globals(); }
}

/**
 * `registry.api` —— 包在 meta 模块里唯一能拿到的引擎辅助函数。
 *
 * 为什么不是 `import`：Node 的 ESM 没有 import map，一条 `import { num } from '../support/index.js'` 在包里
 * 解不出来，而把引擎路径硬编码进包等于把「包写在哪个目录」写进内容。所以这一层是**显式**的接口面：
 * 名单就是这里这些，版本号 `MOD_API_VERSION`，写进 `docs/WORKSHOP.md` §1.11。
 *
 * 这一批是本文件里唯一 import 引擎内部的地方 —— 想加一个函数，改这里一处、文档一处、测试一处。
 */
export const META_API = Object.freeze({
  version: MOD_API_VERSION,
  /** 数值兜底读法（`bb` 里的值可能是字符串）——与官方内容模块读黑板用的是同一个。 */
  num,
  /** 读记录：`bondRecord(id)` / `itemRecord(id)` / `garrisonRecord(effectKey)` / `bandRecord(id)` / `effectRecord(id)`。 */
  bondRecord, itemRecord, garrisonRecord, bandRecord, effectRecord,
  /** 一条记录的 buff 表与按 `bbStr.key` 取参数（`buffsOf(rec)` / `buffParams(rec, key)`）。 */
  buffsOf, buffParams,
  /** 装备「同一族」的键（`chess_item_c_01_e_a` → `chess_item_c_01_e`）与金制品判定。 */
  itemKeyOf, isGoldenId,
});

/** 一个包声明的 meta 模块的绝对路径（形状层已经判过「包内相对 + .mjs」）。 */
function moduleAbs(pack) {
  return path.join(pack.dir, ...String(pack.server.meta.module).split('/'));
}

/**
 * 启动时一次：把每个**声明了 `server.meta`** 的包读出来、扫一遍、import，收下它的 `registerMeta`。
 *
 * 顺序是包 id 升序（DESIGN §28.3），因为装配时谁先注册决定了冲突里谁赢，而这个顺序不能随目录读取顺序变。
 * 失败**不抛**：一条 `{ pack, code, reason }` 回到调用方，由它按「一条用不了的声明拒绝整个包」把包裁掉
 * （`server/index.js` 与 `server.preDispatch` 走同一个裁剪点）。
 *
 * @param {{ packs?: Array<any> }} loaded `loadWorkshop(...)`
 * @param {{ log?: any, importModule?: (url: string) => Promise<any> }} [opts]
 * @returns {Promise<{ modules: Array<{ id: string, hash: string, registers: string[], dir: string, registerMeta: Function }>, errors: Array<{ pack: string, code: string, reason: string }> }>}
 */
export async function loadMetaModules(loaded, { log = null, importModule = (url) => import(url) } = {}) {
  const modules = [];
  const errors = [];
  const packs = (loaded && Array.isArray(loaded.packs) ? loaded.packs : [])
    .filter((p) => p && p.server && p.server.meta)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const pack of packs) {
    const abs = moduleAbs(pack);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      errors.push({ pack: pack.id, code: 'META_BAD_MODULE', reason: `server.meta.module "${pack.server.meta.module}" is not readable: ${e && e.message ? e.message : e}` });
      continue;
    }
    const issues = metaSourceIssues(source, pack.id, pack.server.meta.module);
    if (issues.length) {
      errors.push({ pack: pack.id, code: issues[0].code, reason: issues[0].reason });
      log?.warn?.(`[workshop] ${pack.id}: ${issues[0].code}: ${issues[0].reason}`);
      continue;
    }
    // 带包摘要的查询串：包换了一版（目录里的字节变了）就是另一条 URL，动态 import 的模块缓存不会把旧模块交回来。
    const url = `${pathToFileURL(abs).href}?v=${encodeURIComponent(pack.hash || '')}`;
    let mod;
    try {
      mod = await importModule(url);
    } catch (e) {
      errors.push({ pack: pack.id, code: 'META_IMPORT_FAILED', reason: `server.meta.module "${pack.server.meta.module}" failed to load: ${e && e.message ? e.message : e}` });
      continue;
    }
    if (!mod || typeof mod.registerMeta !== 'function') {
      errors.push({ pack: pack.id, code: 'META_NO_REGISTER', reason: `server.meta.module "${pack.server.meta.module}" does not export a registerMeta(registry) function — the same shape the official content modules use` });
      continue;
    }
    modules.push({ id: pack.id, hash: pack.hash || '', registers: [...pack.server.meta.registers], dir: pack.dir, registerMeta: mod.registerMeta });
  }
  return { modules, errors };
}

/**
 * 每局一次：在**这一局的副本**上按包 id 升序逐包注册。
 *
 * 逐包推进而不是「一次性全装上再回滚」：每个包在自己的试用副本上跑（`reg.fork()`），成功后那份**才**成为当前
 * 注册表。于是一个包中途抛异常（少声明一个键、自己代码有错）时，它已经注册的那几个键**一并消失** ——
 * 「装了一半的包」比「这个包没装上」难查得多，而 §28.13.3 的口径是前者不许存在。
 *
 * @param {{ packs: Array<{ id: string, registers: string[], registerMeta: Function }>, base: MetaRegistry, log?: any }} opts
 * @returns {{ registry: MetaRegistry|null, errors: Array<{ pack: string, code: string, reason: string }> }}
 */
export function buildRoomRegistry({ packs, base, log = null } = {}) {
  const list = (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.registerMeta === 'function')
    .slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!list.length) return { registry: null, errors: [] };
  let reg = base && typeof base.fork === 'function' ? base.fork() : new MetaRegistry();
  const owners = new Map();
  const errors = [];
  let committed = 0;
  for (const pack of list) {
    const trial = reg.fork();
    const guard = new GuardedMetaRegistry(trial, pack, owners);
    try {
      pack.registerMeta(guard);
    } catch (e) {
      guard.rollback(); // 这个包一个键都不留 —— 包括它留在持有表里的那几条登记
      const code = e instanceof MetaRefused ? e.code : 'META_REGISTER_THREW';
      const reason = `${pack.id}: ${e && e.message ? e.message : e}`;
      errors.push({ pack: pack.id, code, reason });
      log?.warn?.(`[workshop] ${code}: ${reason}`);
      continue; // 试用副本丢掉 = 这个包这一个键都不生效
    }
    if (trial.warnings.length) {
      log?.warn?.(`[workshop] ${pack.id}: ${trial.warnings.length} handler method(s) are not hooks and will never run, e.g. ${trial.warnings.slice(0, 2).join('; ')}`);
    }
    reg = trial;
    committed++;
  }
  // 一个包都没装上（全部回滚）时不留一份空副本：调用方据此照旧走进程级那一份，行为与没有 meta 的安装逐字节相同。
  if (!committed) return { registry: null, errors };
  return { registry: reg, errors };
}

/** 七个键类别（供文档与测试引用；名单本身只有 `shared/workshop.js META_KEY_CLASSES` 一份）。 */
export const META_CLASSES = META_KEY_CLASSES;
