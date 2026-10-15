// shared/sdk/digest.js — the THREE digests (DESIGN 重构计划 §二.3)。
//
// 现有 Forge 只有两类摘要，而它们在语义上是分开的（`shared/modIdentity.js`）：
//   * `modManifestDigest` = **一个包**的内容摘要（`[path, sha256]` 对按 path 排序）
//   * `modDigest`         = **一个包集合**的摘要（`[id, hash]` 对按 id 排序）
//
// 重构要的是**三类**，第三类是本文件新增的：
//   * `contentDigest`     —— 包本身内容（== modManifestDigest，这里给一个语义化入口）
//   * `setDigest`         —— 房间选中的包集合（== modDigest，联机准入/资源匹配用）
//   * `activationDigest`  —— **实际执行配置**：contentDigest + sdk + profile + capabilities + permissions
//                            + budget + consent + pin + 生效策略。用于审计/运行时证明/回放/安全日志。
//
// 为什么必须分开：把 consent / profile / budget 塞进 `modDigest`，会让「同一批包字节」在两种运行策略下
// 产生两个不同的 wire 摘要 —— 客户端资源匹配与联机准入会被无关的运行策略污染。所以**集合摘要保持原语义**，
// 执行配置另立一个只进日志与审计的摘要。

import { canonicalJson, sha256Hex, modDigest, modManifestDigest } from '../modIdentity.js';

export { modDigest, modManifestDigest };

/**
 * 一个包的**内容摘要**（语义化入口，等于 `modManifestDigest`）。
 * @param {Array<{ path: string, hash: string }>} files loadWorkshop 里该包的 `files`
 * @returns {string} lowercase hex
 */
export function contentDigest(files) {
  return modManifestDigest(files);
}

/**
 * 一个包集合的**集合摘要**（语义化入口，等于 `modDigest`）。**顺序无关**。
 * @param {Array<{ id: string, hash: string }>} list
 * @returns {string} lowercase hex
 */
export function setDigest(list) {
  return modDigest(list);
}

/**
 * **执行配置摘要**。输入是一批**已归一化的描述符**加一份执行策略；输出一个 sha256。
 *
 * 参与哈希的每一项都是**会影响这次运行实际行为**的东西：
 *   id, contentDigest, sdk, profile, capabilities, permissions, budget, consent(boolean), pin(string|null), policy
 * 刻意**不**进哈希的：display name、author、description、目录路径、装载顺序 —— 它们不改变运行语义，
 * 进去只会让「同一份配置」在不同机器上得到不同摘要（那正是摘要最没用的失败方式）。
 *
 * @param {Array<object>} descriptors 归一化描述符（`shared/sdk/descriptor.js`）
 * @param {{ consent?: (d: object) => boolean, pin?: (d: object) => string|null, policy?: object }} [opts]
 * @returns {{ digest: string, entries: Array<object> }}
 */
export function activationDigest(descriptors, opts = {}) {
  const consentOf = typeof opts.consent === 'function' ? opts.consent : () => false;
  const pinOf = typeof opts.pin === 'function' ? opts.pin : () => null;
  const entries = (Array.isArray(descriptors) ? descriptors : [])
    .filter((d) => d && typeof d.id === 'string')
    .map((d) => ({
      id: d.id,
      contentDigest: d.contentDigest || null,
      sdk: d.sdk || null,
      profile: d.profile || null,
      capabilities: [...(d.capabilities || [])].sort(),
      permissions: [...(d.permissions || [])].sort(),
      budget: normalizeBudgetForDigest(d.budget),
      consent: !!consentOf(d),
      pin: pinOf(d) || null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const body = { version: 1, policy: normalizePolicyForDigest(opts.policy), entries };
  return { digest: sha256Hex(canonicalJson(body)), entries };
}

const BUDGET_KEYS = Object.freeze(['maxCalls', 'maxBytesIn', 'maxBytesOut', 'maxWallTimeMs', 'maxCpuMs', 'maxConcurrentCalls']);

function normalizeBudgetForDigest(b) {
  const src = b && typeof b === 'object' ? b : {};
  const out = {};
  for (const k of BUDGET_KEYS) out[k] = Number.isFinite(Number(src[k])) ? Number(src[k]) : 0;
  return out;
}

function normalizePolicyForDigest(p) {
  if (!p || typeof p !== 'object') return {};
  const out = {};
  for (const k of Object.keys(p).sort()) {
    const v = p[k];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) out[k] = [...v].sort();
  }
  return out;
}
