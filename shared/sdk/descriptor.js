// shared/sdk/descriptor.js — the NormalizedModDescriptor: 一份**归一化**的包描述，官方档与 Forge 旧档
// 各自解析之后收敛到它（DESIGN 重构计划 §二.2）。
//
// 为什么要有它：官方 manifest 与 Forge 的 `pack.json` 不是同一套字段。直接把 Forge 的 `MOD_API_VERSION`
// 当 `sp:sdk@1` 用，等于把「Forge 私有规范」冒充「上游标准」，下一次上游升级就没法对齐。正确做法是先**分别解析**
// （OfficialManifestAdapter / ForgeLegacyAdapter），再归一化到同一个形状；上游以后加字段时只动官方解析器，
// 不会冲击 Forge 的所有旧加载器。
//
// 这一层是**纯函数**：输入 loadWorkshop 产出的包对象（或一份官方 manifest 对象），输出一个只读描述符。
// 它不做 IO、不装载代码、不判 consent/pin（那是 `server/mod-manager/` 的事）。

import {
  CAPABILITIES, COMBAT_CAPABILITIES, SDK_ERROR_CODES, SDK_FORGE_LEGACY, SDK_OFFICIAL, sdkError,
  isOrigin, profileAllowedFor, sdkForOrigin, defaultProfileFor,
} from './sdkConstants.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/** 一个描述符的缺省预算。`0` = 不限（缺省继承运行时策略；官方档应由管理器收紧）。 */
export const DEFAULT_BUDGET = Object.freeze({
  maxCalls: 0, maxBytesIn: 0, maxBytesOut: 0, maxWallTimeMs: 0, maxCpuMs: 0, maxConcurrentCalls: 0,
});

/**
 * 从一枚 Forge 包（loadWorkshop 的 `packs[]` 元素）解析出归一化描述符。
 *
 * 这是 **ForgeLegacyAdapter**：它只读 Forge `pack.json` 归一化清单里**确实存在**的字段，绝不猜官方字段。
 * @param {any} pack loadWorkshop 的包对象
 * @returns {{ descriptor: object|null, issues: Array<{code:string,reason:string}> }}
 */
export function fromForgeManifest(pack) {
  const issues = [];
  if (!isObj(pack) || !str(pack.id)) {
    return { descriptor: null, issues: [sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'a Forge pack must be an object with a non-empty "id"')] };
  }
  const server = isObj(pack.server) ? pack.server : {};
  const client = isObj(pack.client) ? pack.client : {};

  const entrypoints = [];
  for (const m of Array.isArray(server.modules) ? server.modules : []) {
    if (isObj(m) && str(m.entry)) entrypoints.push({ kind: 'serverModule', id: str(m.id) || str(m.entry), entry: str(m.entry) });
  }
  for (const k of ['meta', 'battle', 'room', 'preDispatch']) {
    const block = server[k];
    if (isObj(block) && str(block.module)) entrypoints.push({ kind: k, id: k, entry: str(block.module) });
  }
  for (const p of Array.isArray(client.panels) ? client.panels : []) {
    if (isObj(p) && str(p.module)) entrypoints.push({ kind: 'panel', id: str(p.id) || str(p.slot), entry: str(p.module) });
  }

  const capabilities = [];
  const add = (c) => { if (CAPABILITIES.includes(c) && !capabilities.includes(c)) capabilities.push(c); };
  // `pack.json.content` 在归一化清单里是**文件名数组**（loader 已归一化），但编辑器里也可能写成对象——
  // 两种都接受，归一化成一张表名清单。
  const contentList = Array.isArray(pack.content) ? pack.content.slice()
    : (isObj(pack.content) ? Object.keys(pack.content) : []);
  if (contentList.length) add('content');
  if (isObj(pack.overrides) && Object.keys(pack.overrides).length) add('overrides');
  if (pack.assets || pack.skins || pack.art || pack.support || pack.operators) add('assets');
  if (pack.i18n) add('i18n');
  if (pack.notices) add('notices');
  if (pack.variants) add('variants');
  if (pack.behaviour) add('behaviour');
  if (pack.forms || pack.fx) add('forms');
  if (Array.isArray(pack.kits) || isObj(pack.kits)) add('kits');
  if (entrypoints.some((e) => e.kind === 'panel')) add('panels');
  if (Array.isArray(server.modules) && server.modules.length) add('modules');
  if (isObj(server.meta)) add('meta');
  if (isObj(server.battle)) add('battle');
  if (isObj(server.room)) add('room');
  if (isObj(server.preDispatch)) add('preDispatch');
  if (Array.isArray(pack.routes) && pack.routes.length) add('routes');
  if (pack.matchKinds) add('matchKinds');
  const uses = new Set((Array.isArray(server.modules) ? server.modules : []).flatMap((m) => (isObj(m) && Array.isArray(m.uses) ? m.uses : [])));
  if (uses.has('healthz')) add('health');
  if (uses.has('metrics')) add('metrics');
  if (uses.has('route')) add('routes');
  if (uses.has('lane')) add('lane');
  if (uses.has('matchClass')) add('matchClass');

  const permissions = [];
  const push = (p) => { if (!permissions.includes(p)) permissions.push(p); };
  if (capabilities.includes('modules')) push('host.process');
  if ((Array.isArray(server.modules) ? server.modules : []).some((m) => isObj(m) && m.write)) push('host.storage.write');
  if (capabilities.includes('storage')) push('host.storage');

  // profile：Forge 档里，声明了宿主进程内代码的 = 'host'，纯数据/客户端 = 'legacy'。
  const hostPayload = capabilities.some((c) => ['modules', 'meta', 'battle', 'room', 'preDispatch'].includes(c));
  const profile = hostPayload ? 'host' : 'legacy';

  const combat = !!pack.combat;
  if (!combat && capabilities.some((c) => COMBAT_CAPABILITIES.includes(c))) {
    issues.push(sdkError(SDK_ERROR_CODES.COMBAT_REQUIRED, `pack "${pack.id}" declares combat-only capabilities (${capabilities.filter((c) => COMBAT_CAPABILITIES.includes(c)).join(', ')}) without "combat: true"`));
  }

  // 一条用不了的声明 = 整包拒（与 `normalizeDescriptor`、与仓库既有「具名拒绝」的裁剪点同一条纪律）。
  if (issues.length) return { descriptor: null, issues };

  const descriptor = Object.freeze({
    id: pack.id,
    version: str(pack.version) || null,
    origin: 'forge',
    sdk: sdkForOrigin('forge'),
    profile,
    layer: str(pack.layer) || null,
    combat,
    api: str(pack.api) || null,
    entrypoints: Object.freeze(entrypoints),
    content: Object.freeze(contentList.map(String)),
    assets: Object.freeze([]),
    capabilities: Object.freeze([...capabilities].sort()),
    permissions: Object.freeze([...permissions].sort()),
    dependencies: Object.freeze(Array.isArray(pack.dependencies) ? pack.dependencies.slice() : []),
    conflicts: Object.freeze(Array.isArray(pack.conflicts) ? pack.conflicts.slice() : []),
    budget: DEFAULT_BUDGET,
    contentDigest: str(pack.hash) || null,
    activationPolicy: Object.freeze({ requiresConsent: profile === 'host', pinnable: true }),
    compatibility: Object.freeze({ origin: 'forge', sdk: SDK_FORGE_LEGACY }),
  });
  return { descriptor, issues };
}

/**
 * **OfficialManifestAdapter**（**provisional**）。
 *
 * 官方 `sp:sdk@1` 的 manifest 规范（PLUGINS.md / server/plugins / shared/plugins）在落地时**并不存在**——
 * 只有一份目标架构描述，业主裁决「不等 3.0，按文档开做，偏差可忽略」。所以这里把文档能确定的部分**固化成一份
 * 明确、封闭、可测的形状**，并**逐条写明它是 provisional**：上游真规范到达时，只改这一个函数与下面四张表。
 *
 * 与 Forge 档的**硬边界**（DESIGN 重构计划 §一 原则 1）：官方 manifest **不许**出现 Forge 私有字段
 * （`server` / `client` / `variants` / `behaviour` / `forms` / `fx` / `bonds` / `garrisons` / `kits` / `playtest`）——
 * 出现了就**具名拒绝**，而不是静默当官方能力。反过来，Forge 档也不许声明 `sp:sdk@1`。
 */

/** 官方 manifest 的字段闭集（provisional）。未列出的键**点名拒绝**。 */
export const OFFICIAL_MANIFEST_FIELDS = Object.freeze([
  'manifestVersion', 'id', 'name', 'version', 'author', 'license', 'description',
  'sdk', 'profile', 'entry', 'apis', 'capabilities', 'combat', 'content', 'assets', 'i18n', 'notices',
  'overrides', 'permissions', 'dependencies', 'conflicts', 'budget', 'target',
]);

/** 官方 manifest 里**不许出现**的 Forge 私有字段（出现即拒）。 */
export const FORGE_ONLY_FIELDS = Object.freeze([
  'server', 'client', 'variants', 'behaviour', 'forms', 'fx', 'bonds', 'garrisons', 'kits', 'playtest',
]);

/** `apis[]` → 归一化能力名。未列出的 api **具名拒绝**（不猜）。 */
export const OFFICIAL_API_MAP = Object.freeze({
  content: 'content', assets: 'assets', i18n: 'i18n', notices: 'notices', overrides: 'overrides',
  storage: 'storage', health: 'health', metrics: 'metrics',
  route: 'routes', 'http.route': 'routes',
  lane: 'lane', room: 'room',
  meta: 'meta', 'meta.register': 'meta',
  battle: 'battle', modules: 'modules',
  lobby: 'lobby', 'lobby.on': 'lobby',
  matchKinds: 'matchKinds',
});

/** 官方档缺省预算：即文档里的「8000 次插件预算」。 */
export const OFFICIAL_DEFAULT_BUDGET = Object.freeze({
  maxCalls: 8000, maxBytesIn: 0, maxBytesOut: 0, maxWallTimeMs: 0, maxCpuMs: 0, maxConcurrentCalls: 1,
});

/**
 * @param {unknown} raw
 * @returns {{ descriptor: object|null, issues: Array<{code:string,reason:string}> }}
 */
export function fromOfficialManifest(raw) {
  const issues = [];
  if (!isObj(raw)) return { descriptor: null, issues: [sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'an official manifest must be a JSON object')] };
  for (const key of Object.keys(raw)) {
    if (FORGE_ONLY_FIELDS.includes(key)) {
      issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_FIELD, `official manifest must not carry the Forge-only field "${key}" — the official SDK and the Forge extension layer are separate domains`));
      continue;
    }
    if (!OFFICIAL_MANIFEST_FIELDS.includes(key)) {
      issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_FIELD, `official manifest field "${key}" is not in the closed set (${OFFICIAL_MANIFEST_FIELDS.join(', ')})`));
    }
  }
  if (!str(raw.id)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'official manifest "id" must be a non-empty string'));
  if (raw.sdk !== SDK_OFFICIAL) issues.push(sdkError(SDK_ERROR_CODES.BAD_ORIGIN, `official manifest "sdk" must be "${SDK_OFFICIAL}" (got ${JSON.stringify(raw.sdk)})`));
  const profile = raw.profile === undefined ? 'module' : raw.profile;
  if (!profileAllowedFor('official', profile)) {
    issues.push(sdkError(SDK_ERROR_CODES.PROFILE_NOT_FOR_ORIGIN, `profile ${JSON.stringify(raw.profile)} is not allowed for an official manifest (module / sandbox)`));
  }
  const entry = str(raw.entry);
  const apis = raw.apis === undefined ? [] : raw.apis;
  if (!Array.isArray(apis)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, '"apis" must be an array of declared host API names'));

  const capabilities = [];
  const add = (c) => { if (CAPABILITIES.includes(c) && !capabilities.includes(c)) capabilities.push(c); };
  for (const name of (Array.isArray(apis) ? apis : [])) {
    const c = OFFICIAL_API_MAP[name];
    if (!c) { issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_CAPABILITY, `api ${JSON.stringify(name)} is not a known sp:sdk@1 host API (${Object.keys(OFFICIAL_API_MAP).join(', ')})`)); continue; }
    add(c);
  }
  for (const c of Array.isArray(raw.capabilities) ? raw.capabilities : []) {
    if (!CAPABILITIES.includes(c)) issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_CAPABILITY, `capability ${JSON.stringify(c)} is not in the closed set`));
    else add(c);
  }
  if (Array.isArray(raw.content) && raw.content.length) add('content');
  if (raw.notices) add('notices');
  if (raw.i18n) add('i18n');
  if (isObj(raw.overrides) && Object.keys(raw.overrides).length) add('overrides');
  if (raw.assets) add('assets');
  if (entry && profile === 'module') add('modules');
  if (profile === 'sandbox' && !entry) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'a sandbox-profile manifest needs an "entry" module to run in the isolated runtime'));
  }

  const combat = !!raw.combat;
  const combatOnly = capabilities.filter((c) => COMBAT_CAPABILITIES.includes(c));
  if (!combat && combatOnly.length) {
    issues.push(sdkError(SDK_ERROR_CODES.COMBAT_REQUIRED, `official manifest declares combat-only capabilities (${combatOnly.join(', ')}) without "combat: true"`));
  }

  const permissions = [];
  const perm = (p) => { if (!permissions.includes(p)) permissions.push(p); };
  if (['modules', 'meta', 'battle', 'room'].some((c) => capabilities.includes(c))) perm('host.process');
  if (capabilities.includes('storage')) perm('host.storage');
  if (capabilities.includes('routes')) perm('host.http');
  if (capabilities.includes('lane')) perm('host.ws');
  if (capabilities.includes('lobby')) perm('lobby.observe');
  for (const p of Array.isArray(raw.permissions) ? raw.permissions : []) perm(p);

  if (issues.length) return { descriptor: null, issues };

  const descriptor = Object.freeze({
    id: raw.id,
    version: str(raw.version) || null,
    origin: 'official',
    sdk: SDK_OFFICIAL,
    profile,
    layer: null,
    combat,
    api: null,
    entrypoints: Object.freeze(entry ? [{ kind: profile === 'sandbox' ? 'sandboxModule' : 'module', id: String(raw.id), entry }] : []),
    content: Object.freeze(Array.isArray(raw.content) ? raw.content.map(String) : []),
    assets: Object.freeze(Array.isArray(raw.assets) ? raw.assets.map(String) : []),
    capabilities: Object.freeze([...capabilities].sort()),
    permissions: Object.freeze([...permissions].sort()),
    dependencies: Object.freeze(Array.isArray(raw.dependencies) ? raw.dependencies.slice() : []),
    conflicts: Object.freeze(Array.isArray(raw.conflicts) ? raw.conflicts.slice() : []),
    budget: Object.freeze({ ...OFFICIAL_DEFAULT_BUDGET, ...(isObj(raw.budget) ? raw.budget : {}) }),
    // 官方包的字节摘要由官方装载器算出后回填；本适配器只描述。
    contentDigest: typeof raw.contentDigest === 'string' ? raw.contentDigest : null,
    // 非隔离档（module）跑在宿主进程里 ⇒ 默认要求**逐包同意**（文档里的「房间逐玩家同意 / 服主 SHA-256 pin」）。
    activationPolicy: Object.freeze({ requiresConsent: profile === 'module', pinnable: true }),
    compatibility: Object.freeze({ origin: 'official', sdk: SDK_OFFICIAL }),
  });
  return { descriptor, issues };
}

/**
 * 校验并冻结一份**已经归一化**的描述符（适配器产出的、或调用方手工构造的）。
 * 未知字段被**点名拒绝**（与 `pack.json` 的 41 键闭集同一条纪律）。
 * @param {any} raw
 * @returns {{ descriptor: object|null, issues: Array<{code:string,reason:string}> }}
 */
const DESCRIPTOR_FIELDS = Object.freeze([
  'id', 'version', 'origin', 'sdk', 'profile', 'layer', 'combat', 'api', 'entrypoints', 'content', 'assets',
  'capabilities', 'permissions', 'dependencies', 'conflicts', 'budget', 'contentDigest', 'activationPolicy', 'compatibility',
]);

export function normalizeDescriptor(raw) {
  const issues = [];
  if (!isObj(raw)) return { descriptor: null, issues: [sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'a descriptor must be an object')] };
  for (const key of Object.keys(raw)) {
    if (!DESCRIPTOR_FIELDS.includes(key)) issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_FIELD, `descriptor field "${key}" is not part of the normalized shape (${DESCRIPTOR_FIELDS.join(', ')})`));
  }
  if (!str(raw.id)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'descriptor "id" must be a non-empty string'));
  if (!isOrigin(raw.origin)) issues.push(sdkError(SDK_ERROR_CODES.BAD_ORIGIN, `descriptor "origin" must be one of official / forge (got ${JSON.stringify(raw.origin)})`));
  const sdk = sdkForOrigin(raw.origin);
  if (sdk && raw.sdk !== sdk) issues.push(sdkError(SDK_ERROR_CODES.BAD_ORIGIN, `descriptor "sdk" must be "${sdk}" for origin "${raw.origin}"`));
  const profile = raw.profile === undefined ? defaultProfileFor(raw.origin) : raw.profile;
  if (!profileAllowedFor(raw.origin, profile)) {
    issues.push(sdkError(SDK_ERROR_CODES.PROFILE_NOT_FOR_ORIGIN, `profile ${JSON.stringify(profile)} is not allowed for origin ${JSON.stringify(raw.origin)}`));
  }
  for (const c of Array.isArray(raw.capabilities) ? raw.capabilities : []) {
    if (!CAPABILITIES.includes(c)) issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_CAPABILITY, `capability "${c}" is not in the closed set`));
  }
  if (!raw.combat && (Array.isArray(raw.capabilities) ? raw.capabilities : []).some((c) => COMBAT_CAPABILITIES.includes(c))) {
    issues.push(sdkError(SDK_ERROR_CODES.COMBAT_REQUIRED, 'combat-only capabilities require "combat: true"'));
  }
  if (issues.length) return { descriptor: null, issues };
  return {
    descriptor: Object.freeze({
      ...raw,
      profile,
      sdk,
      entrypoints: Object.freeze(Array.isArray(raw.entrypoints) ? raw.entrypoints.slice() : []),
      content: Object.freeze(Array.isArray(raw.content) ? raw.content.slice() : []),
      assets: Object.freeze(Array.isArray(raw.assets) ? raw.assets.slice() : []),
      capabilities: Object.freeze([...(raw.capabilities || [])].sort()),
      permissions: Object.freeze([...(raw.permissions || [])].sort()),
      dependencies: Object.freeze(Array.isArray(raw.dependencies) ? raw.dependencies.slice() : []),
      conflicts: Object.freeze(Array.isArray(raw.conflicts) ? raw.conflicts.slice() : []),
      budget: Object.freeze({ ...DEFAULT_BUDGET, ...(isObj(raw.budget) ? raw.budget : {}) }),
    }),
    issues,
  };
}

/**
 * 一批包 → 一批描述符（每个包按 origin 选适配器）。返回里同时带**逐包 issues**，让调用方按
 * 「一条用不了的声明具名拒绝」处理，而不是静默丢。
 * @param {Array<any>} packs
 * @param {{ origin?: 'official'|'forge' }} [opts]
 */
export function describePacks(packs, opts = {}) {
  const origin = isOrigin(opts.origin) ? opts.origin : 'forge';
  const descriptors = [];
  const issues = [];
  for (const p of Array.isArray(packs) ? packs : []) {
    // 官方档的「候选包」是装载器给的 `{ id, manifest, hash, dir, files }`（见 server/mod-manager/officialLoader.js）；
    // 也接受直接给一份裸 manifest（测试/程序化构造）。Forge 档则直接给 loadWorkshop 的包对象。
    const raw = origin === 'official' && isObj(p) && isObj(p.manifest) ? p.manifest : p;
    const parsed = origin === 'official' ? fromOfficialManifest(raw) : fromForgeManifest(raw);
    let descriptor = parsed.descriptor;
    // 装载器算出的内容摘要回填（结构冻结，所以是新对象）。
    if (descriptor && !descriptor.contentDigest && isObj(p) && typeof p.hash === 'string') {
      descriptor = Object.freeze({ ...descriptor, contentDigest: p.hash });
    }
    if (descriptor) descriptors.push(descriptor);
    for (const i of parsed.issues) issues.push({ id: (isObj(p) && (p.id || (isObj(p.manifest) && p.manifest.id))) || null, ...i });
  }
  return { descriptors, issues };
}

/** 所有描述符能力的并集（按名字去重、排序）。 */
export function capabilityUnion(descriptors) {
  const set = new Set();
  for (const d of Array.isArray(descriptors) ? descriptors : []) for (const c of d.capabilities || []) set.add(c);
  return [...set].sort();
}
