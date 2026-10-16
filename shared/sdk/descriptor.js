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

/** 官方 manifest 的字段闭集 —— **逐字对齐上游 0.3.0**（`schemas/plugin.schema.json` + `shared/plugins/manifest.js:172`）。 */
export const OFFICIAL_MANIFEST_FIELDS = Object.freeze([
  '$schema', 'manifest', 'id', 'name', 'englishName', 'description', 'version', 'app', 'api', 'class', 'scope',
  'authors', 'credits', 'license', 'homepage', 'sourceLang', 'requires', 'optional', 'conflicts',
  'loadAfter', 'loadBefore', 'priority', 'settings', 'permissions', 'entry', 'slots', 'files', 'overrides',
  'assets', 'theme', 'data', 'operators', 'enemies', 'modes', 'stages', 'dsl', 'i18n', 'lang', 'base',
  'fallback', 'complete', 'machineTranslated', 'numberUnits',
]);

/** `class` 闭集（上游 `shared/plugins/manifest.js:102-109`）。 */
export const OFFICIAL_CLASSES = Object.freeze(['lang', 'cosmetic', 'content', 'script', 'ui', 'trusted']);

/** `permissions` 闭集（上游 `manifest.js:130-143`）—— 与 Forge 自己的 capability 词表**不是**一套。 */
export const OFFICIAL_PERMISSIONS = Object.freeze([
  'assets.override', 'assets.add', 'theme', 'data.patch', 'data.add', 'dsl',
  'sim.code', 'meta.code', 'mode.code', 'ui.frame', 'trusted.page', 'trusted.server',
]);

/** `entry` 的键闭集（上游 `entry: { sim, meta, client, server }`）。 */
export const OFFICIAL_ENTRY_KEYS = Object.freeze(['sim', 'meta', 'client', 'server']);

/** 官方 API 等级（上游 `PLUGIN_API = { current: 1, min: 1 }`，越界**拒载**）。 */
export const OFFICIAL_API = Object.freeze({ current: 1, min: 1 });

/** manifest 判别值（上游自称 "manifest 2"）。 */
export const OFFICIAL_MANIFEST_VERSION = 2;

/** `class` → 我们内部的能力名（下游 plan/host/catalog 读的是这一层）。 */
export const CAPABILITIES_BY_CLASS = Object.freeze({
  lang: ['i18n'], cosmetic: ['assets'], content: ['content'], script: ['modules', 'sim'], ui: ['panels'], trusted: ['modules', 'health', 'routes', 'room'],
});

/** 官方 `permissions` → 内部能力名。 */
export const CAPABILITIES_BY_PERMISSION = Object.freeze({
  'assets.override': 'assets', 'assets.add': 'assets', theme: 'assets',
  'data.patch': 'content', 'data.add': 'content', dsl: 'content',
  'sim.code': 'sim', 'meta.code': 'meta', 'mode.code': 'content',
  'ui.frame': 'panels', 'trusted.page': 'panels', 'trusted.server': 'modules',
});

/** 官方 manifest 里**不许出现**的 Forge 私有字段（出现即拒）：Forge 包走 origin "forge"，不冒充官方档。 */
export const FORGE_ONLY_FIELDS = Object.freeze([
  'server', 'client', 'variants', 'behaviour', 'forms', 'fx', 'bonds', 'garrisons', 'kits', 'playtest',
]);

/**
 * 官方档的内部缺省预算。**注意**：上游 manifest **没有** `budget` 字段（那是它文档里的 `[ASSUMED]` 数字），
 * 所以它只是我们内部给官方档的缺省记账上限，不从 manifest 读。
 */
export const OFFICIAL_DEFAULT_BUDGET = Object.freeze({
  maxCalls: 8000, maxBytesIn: 0, maxBytesOut: 0, maxWallTimeMs: 0, maxCpuMs: 0, maxConcurrentCalls: 1,
});

export function fromOfficialManifest(raw) {
  const issues = [];
  if (!isObj(raw)) return { descriptor: null, issues: [sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'an official manifest must be a JSON object')] };
  for (const key of Object.keys(raw)) {
    if (FORGE_ONLY_FIELDS.includes(key)) {
      issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_FIELD, `official manifest must not carry the Forge-only field "${key}" — a Forge pack is loaded as origin "forge", it never claims to be an sp:sdk@1 plugin`));
      continue;
    }
    if (!OFFICIAL_MANIFEST_FIELDS.includes(key)) {
      issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_FIELD, `official manifest field "${key}" is not in the closed set (${OFFICIAL_MANIFEST_FIELDS.join(', ')})`));
    }
  }
  if (raw.manifest !== OFFICIAL_MANIFEST_VERSION) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, `official manifest field "manifest" must be ${OFFICIAL_MANIFEST_VERSION} (got ${JSON.stringify(raw.manifest)})`));
  }
  if (!str(raw.id)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'official manifest "id" must be a non-empty string'));
  if (!str(raw.version)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'official manifest "version" must be a non-empty string'));
  const klass = str(raw.class);
  if (!OFFICIAL_CLASSES.includes(klass)) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, `official manifest "class" must be one of ${OFFICIAL_CLASSES.join(' / ')} (got ${JSON.stringify(raw.class)})`));
  }
  if (raw.api === undefined) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, 'official manifest "api" must declare the plugin API level'));
  } else if (!Number.isInteger(raw.api) || raw.api < OFFICIAL_API.min || raw.api > OFFICIAL_API.current) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, `official manifest "api" must be an integer within [${OFFICIAL_API.min}, ${OFFICIAL_API.current}] (got ${JSON.stringify(raw.api)}) — outside that range a plugin is refused, not run unverified`));
  }
  if (raw.app !== undefined && !str(raw.app)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, '"app" must be a version-range string when present'));

  const permissionsRaw = raw.permissions === undefined ? [] : raw.permissions;
  if (!Array.isArray(permissionsRaw)) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, '"permissions" must be an array of declared permission names'));
  }
  for (const perm of Array.isArray(permissionsRaw) ? permissionsRaw : []) {
    if (!OFFICIAL_PERMISSIONS.includes(perm)) {
      issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_CAPABILITY, `permission ${JSON.stringify(perm)} is not in the closed set (${OFFICIAL_PERMISSIONS.join(', ')})`));
    }
  }

  const entryRaw = raw.entry === undefined ? {} : raw.entry;
  if (!isObj(entryRaw)) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, '"entry" must be an object { sim, meta, client, server }'));
  for (const [k, v] of Object.entries(isObj(entryRaw) ? entryRaw : {})) {
    if (!OFFICIAL_ENTRY_KEYS.includes(k)) { issues.push(sdkError(SDK_ERROR_CODES.UNKNOWN_FIELD, `entry.${k} is not one of ${OFFICIAL_ENTRY_KEYS.join(' / ')}`)); continue; }
    const rel = str(v);
    if (!rel || rel.startsWith('/') || rel.includes('..')) issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, `entry.${k} must be a plugin-relative path (got ${JSON.stringify(v)})`));
  }

  const slotsRaw = raw.slots === undefined ? [] : raw.slots;
  if (!Array.isArray(slotsRaw) || slotsRaw.some((s) => !str(s))) {
    issues.push(sdkError(SDK_ERROR_CODES.BAD_DESCRIPTOR, '"slots" must be an array of non-empty slot names (the closed slot list is checked when the plugin is loaded)'));
  }

  const permissions = (Array.isArray(permissionsRaw) ? permissionsRaw : []).filter((perm) => OFFICIAL_PERMISSIONS.includes(perm));
  const entry = isObj(entryRaw) ? entryRaw : {};
  const slots = Array.isArray(slotsRaw) ? slotsRaw.filter((s) => str(s)) : [];

  // ---- 能力：由 `class` + `permissions` + `entry` + parts **派生**（下游只认这一层）------------------------------
  const capabilities = [];
  const add = (c) => { if (CAPABILITIES.includes(c) && !capabilities.includes(c)) capabilities.push(c); };
  for (const c of CAPABILITIES_BY_CLASS[klass] || []) add(c);
  for (const perm of permissions) { const c = CAPABILITIES_BY_PERMISSION[perm]; if (c) add(c); }
  if (str(entry.sim)) { add('modules'); add('sim'); add('kits'); }
  if (str(entry.meta)) add('meta');
  if (str(entry.server)) add('modules');
  if (str(entry.client)) add('panels');
  for (const part of ['data', 'operators', 'enemies', 'modes', 'stages']) if (raw[part]) add('content');
  if (raw.i18n) add('i18n');
  if (raw.assets || raw.theme) add('assets');
  if (slots.length) add('panels');

  // `panels` 从 `entry.client` + `slots` **派生**（`server/mod-manager/officialPanels.js` 读的是它）；
  // 槽位是否合法由那个桥判（闭枚举住在 shared/workshop.js）。
  const panels = [];
  const clientEntry = str(entry.client);
  if (clientEntry && slots.length) {
    for (const [i, slot] of slots.entries()) panels.push({ id: `${raw.id}:${i}`, slot, module: clientEntry });
  }

  // 上游**没有** `combat` 标志：能改对局结果的是 `sim.code` / `meta.code` 这两个权限（判据是能力，不是意图）。
  const combat = permissions.includes('sim.code') || permissions.includes('meta.code');

  // 执行档位：`script` 走隔离沙箱（上游 SES Compartment），`trusted` 走宿主进程，其余类不执行代码。
  const profile = klass === 'script' ? 'sandbox' : 'module';

  // 声明式内容：上游用 parts（**文件路径**，`data: ['items.json']`）而不是表名清单 —— 这里记下
  // **哪些 part** 被声明（`contentParts`）与**展开后的文件清单**（`content`，路径）。
  const contentParts = ['data', 'operators', 'enemies', 'modes', 'stages', 'dsl']
    .filter((part) => raw[part] !== undefined);
  const contentFiles = [];
  for (const part of contentParts) {
    const v = raw[part];
    for (const rel of (Array.isArray(v) ? v : [v])) { const s = str(rel); if (s) contentFiles.push(s); }
  }

  const entrypoints = [];
  for (const k of OFFICIAL_ENTRY_KEYS) {
    if (str(entry[k])) entrypoints.push({ kind: k === 'client' ? 'panel' : (k === 'meta' ? 'meta' : 'module'), id: k, entry: str(entry[k]) });
  }

  const permissionsOut = [];
  const permOut = (p) => { if (!permissionsOut.includes(p)) permissionsOut.push(p); };
  if (['script', 'trusted'].includes(klass)) permOut('host.process');
  if (permissions.includes('data.patch') || permissions.includes('data.add')) permOut('host.content');
  if (permissions.includes('assets.override') || permissions.includes('assets.add')) permOut('host.assets');
  if (klass === 'ui') permOut('client.frame');

  const layering = ['modules', 'meta', 'battle', 'room'].some((c) => capabilities.includes(c)) ? 'B'
    : (capabilities.includes('panels') ? 'C' : 'A');

  if (issues.length) return { descriptor: null, issues };

  const descriptor = Object.freeze({
    id: raw.id,
    version: str(raw.version) || null,
    origin: 'official',
    sdk: SDK_OFFICIAL,
    profile,
    layer: layering,
    combat,
    api: Number.isInteger(raw.api) ? raw.api : null,
    app: str(raw.app) || null,
    klass: klass || null,
    scope: Object.freeze(Array.isArray(raw.scope) ? raw.scope.map(String) : []),
    entrypoints: Object.freeze(entrypoints),
    content: Object.freeze(contentFiles),
    contentParts: Object.freeze(contentParts),
    assets: Object.freeze([]),
    capabilities: Object.freeze([...capabilities].sort()),
    permissions: Object.freeze(permissionsOut.sort()),
    officialPermissions: Object.freeze([...permissions]),
    dependencies: Object.freeze(Array.isArray(raw.requires) ? raw.requires.slice() : []),
    conflicts: Object.freeze(Array.isArray(raw.conflicts) ? raw.conflicts.slice() : []),
    metaRegisters: Object.freeze(Array.isArray(raw.overrides) ? raw.overrides.map(String) : []),
    panels: Object.freeze(panels.map((p) => Object.freeze({ ...p }))),
    slots: Object.freeze([...slots]),
    budget: OFFICIAL_DEFAULT_BUDGET,
    // 官方包的字节摘要由装载器算出后回填（`officialLoader.js` 用插件全部文件的归一化哈希）。
    contentDigest: typeof raw.contentDigest === 'string' ? raw.contentDigest : null,
    // `script` 走沙箱 ⇒ 不要求逐玩家同意；`trusted` 进宿主进程 ⇒ 默认要求（与上游的信任档一致）。
    activationPolicy: Object.freeze({ requiresConsent: klass === 'trusted', pinnable: true }),
    compatibility: Object.freeze({ origin: 'official', sdk: SDK_OFFICIAL, manifest: OFFICIAL_MANIFEST_VERSION }),
  });
  return { descriptor, issues };
}

const DESCRIPTOR_FIELDS = Object.freeze([
  'id', 'version', 'origin', 'sdk', 'profile', 'layer', 'combat', 'api', 'entrypoints', 'content', 'assets',
  'capabilities', 'permissions', 'dependencies', 'conflicts', 'budget', 'contentDigest', 'activationPolicy', 'compatibility',
  'metaRegisters', 'contentParts', 'slots', 'klass', 'officialPermissions', 'app', 'scope', 'panels',
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
