// server/mod-manager/plan.js — the ActivationPlan: **唯一一份**「这一版到底装了哪些包、它们能做什么」的事实
// （DESIGN 重构计划 §一 原则 2 / §二.1）。
//
// 为什么必须有它：现在的装配是**分散判断**的——`server/index.js` 用 `survivors` 裁一遍，`server/lobby.js`
// 又从 `workshop.panels` / `workshop.serverChannels` 重新构两张表、每个房间再过滤一遍，`roomPack`、`routeMount`、
// `resourceServerPolicy`、`transportPolicy` 各自收敛。同一个「这个包在不在」要被回答五遍，任何一处漏了就是
// 「包照旧加载、只是它的效果不在」——本仓库反复判过死刑的那个形状。
//
// 这里把那些判据**收成一份**：`discover → parse(归一化描述符) → resolve(依赖/冲突) → registry(启用/禁用)
// → consent/pin → activate`，产出一个冻结的 ActivationPlan。运行时只读它，不再各自判断。
//
// 本文件是**纯函数**：不读盘、不 import 任何 loader、不装代码。装载（动态 import）仍由既有 loader 完成，
// 它们的错误数组作为输入喂进来（`refused` / `unavailable`），这样「装载顺序与失败语义」逐字节不变，
// 变的只是**派生的判定与摘要在哪里算**。

import { describePacks, capabilityUnion, DEFAULT_BUDGET } from '../../shared/sdk/descriptor.js';
import { activationDigest, modDigest } from '../../shared/sdk/digest.js';
import { DEFAULT_RUN_MODE, isRunMode } from '../../shared/sdk/sdkConstants.js';
import { evaluateConsentPin } from './consent.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const idOf = (x) => (isObj(x) ? x.id ?? x.pack ?? null : null);

/**
 * 构建一份 ActivationPlan。
 *
 * @param {{
 *   packs?: Array<any>,        // loadWorkshop(...).packs —— 全部**已发现**的包
 *   registry?: any,            // readModRegistry(...) —— { version, packs: { <id>: { state, consent?, pin?, ... } } }
 *   refused?: Array<any>,      // adjudicatePackGraph(...).refused —— [{ id, reason }]
 *   unavailable?: Array<any>,  // dropUnavailablePreDispatchPacks(...).removed —— [{ pack, code }]
 *   options?: {
 *     origin?: 'official'|'forge',
 *     requireConsentForHost?: boolean,   // 缺省：用描述符自带的 activationPolicy.requiresConsent
 *     budgetByPack?: Record<string, object>,
 *   },
 * }} input
 * @returns {object} 冻结的 ActivationPlan
 */
export function buildActivationPlan({ packs = [], registry = null, refused = [], unavailable = [], options = {} } = {}) {
  const list = Array.isArray(packs) ? packs.filter((p) => isObj(p) && typeof p.id === 'string') : [];
  const errors = [];
  const warnings = [];

  // --- 1. discover ---------------------------------------------------------
  const discovered = list.map((p) => ({ id: p.id, version: p.version ?? null, origin: options.origin || 'forge' }));

  // --- 2. parse（归一化描述符） -------------------------------------------
  const { descriptors: allDescriptors, issues: parseIssues } = describePacks(list, { origin: options.origin });
  const descriptorById = new Map(allDescriptors.map((d) => [d.id, d]));
  for (const issue of parseIssues) warnings.push({ id: issue.id, code: issue.code, reason: issue.reason });

  // --- 3. registry（启用 / 禁用）+ consent / pin ---------------------------
  const regPacks = isObj(registry) && isObj(registry.packs) ? registry.packs : {};
  const disabled = [];
  const consentVerdicts = [];
  for (const p of list) {
    const entry = regPacks[p.id];
    if (entry && entry.state === 'disabled') {
      disabled.push({ id: p.id, where: p.where || p.dir || `workshop/${p.id}/`, reason: 'disabled by the operator (mod-registry)' });
      continue;
    }
    const d = descriptorById.get(p.id);
    if (!d) continue;
    // **consent 默认关闭**：只有显式 `options.requireConsentForHost === true` 才把「宿主进程档未同意」当作拒绝。
    // 这样默认路径下现装的 Forge 包（含 server.modules 的）**一个都不会**因为新增的同意机制被裁掉——运行行为
    // 逐字节不变；要收紧时开这个开关（或在部署策略里开），拒绝会按 `SDK_NOT_CONSENTED` 具名出现在 warnings 里。
    const verdict = evaluateConsentPin(d, entry || null, { requireConsent: options.requireConsentForHost === true });
    consentVerdicts.push({ id: p.id, ...verdict });
  }

  // --- 4. resolve（依赖/冲突的裁决结果作为输入） ---------------------------
  const refusedList = (Array.isArray(refused) ? refused : []).filter(isObj).map((r) => ({ id: idOf(r), reason: r.reason || 'refused by the pack graph adjudication' })).filter((r) => r.id);
  const unavailableList = (Array.isArray(unavailable) ? unavailable : []).filter(isObj)
    .map((r) => ({ id: idOf(r) || r.pack, code: r.code || 'UNAVAILABLE', reason: r.reason || `declared server-side payload could not be installed (${r.code || 'unknown'})` }))
    .filter((r) => r.id);

  // --- 5. 单一裁剪：excluded / activated -----------------------------------
  // 运行模式（Phase 8）：`official-only` 只放行官方档；`official-preferred` 放行但逐包告警；
  // **缺省 `legacy-compatible`** ⇒ 不产生任何一条 mode 判定，行为与重构前逐字节相同。
  const mode = isRunMode(options.mode) ? options.mode : DEFAULT_RUN_MODE;
  const modeRefused = [];
  if (mode === 'official-only') {
    for (const p of list) {
      const d = descriptorById.get(p.id);
      const origin = d ? d.origin : (options.origin || 'forge');
      if (origin !== 'official') modeRefused.push({ id: p.id, code: 'SDK_ORIGIN_NOT_ALLOWED', reason: `run mode "official-only" does not load ${origin}-origin packs` });
    }
  } else if (mode === 'official-preferred') {
    for (const p of list) {
      const d = descriptorById.get(p.id);
      const origin = d ? d.origin : (options.origin || 'forge');
      if (origin !== 'official') warnings.push({ id: p.id, code: 'SDK_LEGACY_IN_OFFICIAL_PREFERRED', reason: 'this server prefers the official SDK; a Forge-legacy pack is running without a cross-upstream compatibility claim' });
    }
  }

  const disabledIds = new Set(disabled.map((d) => d.id));
  const refusedIds = new Set(refusedList.map((r) => r.id));
  const unavailableIds = new Set(unavailableList.map((u) => u.id));
  const notConsentedIds = new Set(consentVerdicts.filter((c) => !c.ok && c.code === 'SDK_NOT_CONSENTED').map((c) => c.id));
  const stalePinIds = new Set(consentVerdicts.filter((c) => !c.ok && c.code === 'SDK_PIN_STALE').map((c) => c.id));
  const excludedIds = new Set([...disabledIds, ...refusedIds, ...unavailableIds, ...notConsentedIds, ...stalePinIds, ...modeRefused.map((r) => r.id)]);

  const activated = list.filter((p) => !excludedIds.has(p.id));
  const activatedIds = activated.map((p) => p.id);
  const activatedDescriptors = activatedIds.map((id) => descriptorById.get(id)).filter(Boolean);

  // --- 6. 派生：capabilities / 三重 digest ---------------------------------
  const capabilities = capabilityUnion(activatedDescriptors);

  /** @type {Record<string, string|null>} */
  const contentDigestOf = {};
  for (const p of activated) contentDigestOf[p.id] = typeof p.hash === 'string' ? p.hash : null;

  const modEntries = activated
    .filter((p) => typeof p.hash === 'string')
    .map((p) => ({ id: p.id, hash: p.hash }));
  const modDigestValue = modEntries.length ? modDigest(modEntries) : null;

  const entryById = new Map((list || []).map((p) => [p.id, regPacks[p.id] || null]));
  const activation = activationDigest(activatedDescriptors, {
    consent: (d) => {
      const v = consentVerdicts.find((c) => c.id === d.id);
      return !!v && v.ok;
    },
    pin: (d) => {
      const e = entryById.get(d.id);
      return e && e.pin && e.pin.digest ? e.pin.digest : null;
    },
    policy: { requireConsentForHost: options.requireConsentForHost === true, mode },
  });

  for (const v of consentVerdicts) if (!v.ok) warnings.push({ id: v.id, code: v.code, reason: v.reason });

  const plan = {
    discovered,
    parsed: allDescriptors,
    descriptors: activatedDescriptors,
    resolved: { kept: activatedIds.slice(), refused: refusedList.slice(), unavailable: unavailableList.slice() },
    enabled: activatedIds.slice(),
    disabled: disabled.slice(),
    refused: refusedList.slice(),
    excluded: [...excludedIds].sort(),
    activated: activatedIds.slice(),
    capabilities,
    consent: consentVerdicts,
    /** 运行模式（Phase 8）与它拒绝掉的包（`official-only` 才非空）。 */
    mode,
    modeRefused: modeRefused.slice(),
    digest: {
      contentDigestOf,
      modDigest: modDigestValue,
      activationDigest: activation.digest,
      activationEntries: activation.entries,
    },
    errors,
    warnings,
  };
  plan.activatedSet = new Set(activatedIds);
  plan.disabledSet = disabledIds;
  plan.excludedSet = excludedIds;
  plan.descriptorById = descriptorById;
  plan.budgetFor = (packId) => (isObj(options.budgetByPack) && isObj(options.budgetByPack[packId]))
    ? options.budgetByPack[packId]
    : DEFAULT_BUDGET;
  return Object.freeze(plan);
}

/**
 * 一个包是否在这份计划里被激活（运行时组件统一问这一句，而不是各自重算）。
 * @param {object} plan
 * @param {string} packId
 */
export function isActivated(plan, packId) {
  return !!(plan && plan.activatedSet && plan.activatedSet.has(packId));
}

/** 计划里激活集合的 `Set`（给 `filter` 用）。 */
export function activatedSetOf(plan) {
  return (plan && plan.activatedSet) || new Set();
}
