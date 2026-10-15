// server/mod-manager/consent.js — 同意(consent)与钉版(pin)的**纯模型**（DESIGN 重构计划 §四 高风险 4）。
//
// 现状：登记册（`server/modRegistry.js`）只有一个 enable/disable 开关，而「安装 / 启用 / 同意 / 钉版」是四件
// 不同的事，语义不能混：
//   * installed  ≠ consented —— 装上不等于运维同意了它可以跑宿主进程内代码
//   * enabled    ≠ 拥有全部权限 —— 启用不等于批准了它声明的每一个 capability
//   * hash 变了，pin 默认失效 —— 钉的是**字节**，不是包 id
//   * SDK / profile 变了要重新解析 —— 换了执行档位就是另一次授权
//
// 本文件只做形状与判据（纯函数）；写盘仍走 `modRegistry.js` 的 `mutate`（唯一事实源，不新增第二份状态文件）。

/** 登记项里 consent / pin 这一格的版本；形状变化时抬它，读侧按名字丢坏条目。 */
export const CONSENT_VERSION = 1;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isHex = (v) => typeof v === 'string' && /^[0-9a-f]{16,64}$/.test(v);
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * 归一化一条 consent 记录：`{ digest, at }`。digest 必填（同意是**对某一版字节**的同意）。
 * @returns {{ record: { digest: string, at: string|null } | null, issues: string[] }}
 */
export function normalizeConsent(raw) {
  const issues = [];
  if (raw === undefined || raw === null) return { record: null, issues };
  if (!isObj(raw)) return { record: null, issues: ['"consent": must be an object { digest, at? } (dropped)'] };
  if (!isHex(raw.digest)) return { record: null, issues: [`"consent.digest": ${JSON.stringify(raw.digest)} is not a content digest (dropped)`] };
  const at = raw.at === undefined ? null : raw.at;
  if (at !== null && !isIso(at)) issues.push('"consent.at": not a date (dropped the date, kept the consent)');
  return { record: { digest: raw.digest, at: at !== null && isIso(at) ? at : null }, issues };
}

/**
 * 归一化一条 pin 记录：`{ digest, at }`。钉的是**字节摘要**——内容一变，`pinMatches` 直接为假。
 * @returns {{ record: { digest: string, at: string|null } | null, issues: string[] }}
 */
export function normalizePin(raw) {
  const issues = [];
  if (raw === undefined || raw === null) return { record: null, issues };
  if (!isObj(raw)) return { record: null, issues: ['"pin": must be an object { digest, at? } (dropped)'] };
  if (!isHex(raw.digest)) return { record: null, issues: [`"pin.digest": ${JSON.stringify(raw.digest)} is not a content digest (dropped)`] };
  const at = raw.at === undefined ? null : raw.at;
  if (at !== null && !isIso(at)) issues.push('"pin.at": not a date (dropped the date, kept the pin)');
  return { record: { digest: raw.digest, at: at !== null && isIso(at) ? at : null }, issues };
}

/** 操作者是否已对这一版字节表示同意。 */
export function isConsented(entry, contentDigest) {
  const c = entry && entry.consent;
  return !!(c && c.digest && contentDigest && c.digest === contentDigest);
}

/** 钉版是否仍然有效（字节没变 ⇒ 有效；变了 ⇒ 失效，需重新确认）。 */
export function pinMatches(entry, contentDigest) {
  const p = entry && entry.pin;
  if (!p) return true;                 // 没钉 = 不约束
  if (!contentDigest) return false;    // 钉了却算不出内容摘要 ⇒ 视为失效（宁可拦）
  return p.digest === contentDigest;
}

/**
 * 综合判据：一个描述符 + 它的登记项，在当前策略下是否被允许激活。
 *
 * @param {{ id: string, profile: string, contentDigest: string|null, activationPolicy?: { requiresConsent?: boolean } }} descriptor
 * @param {object|null} entry 登记项（`normalizePackEntry` 的产物，可能带 consent / pin）
 * @param {{ requireConsent?: boolean }} [policy] 运行时策略（缺省取描述符自带的 activationPolicy）
 * @returns {{ ok: boolean, code: string|null, reason: string|null }}
 */
export function evaluateConsentPin(descriptor, entry, policy = {}) {
  const d = descriptor || {};
  const requiresConsent = policy.requireConsent !== undefined
    ? !!policy.requireConsent
    : !!(d.activationPolicy && d.activationPolicy.requiresConsent);
  if (!pinMatches(entry, d.contentDigest)) {
    return { ok: false, code: 'SDK_PIN_STALE', reason: `pack "${d.id}" is pinned to another byte version — the pin must be re-confirmed after a content change` };
  }
  if (requiresConsent && !isConsented(entry, d.contentDigest)) {
    return { ok: false, code: 'SDK_NOT_CONSENTED', reason: `pack "${d.id}" runs host-process code and has not been consented to at this version` };
  }
  return { ok: true, code: null, reason: null };
}
