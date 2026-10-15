// server/mod-manager/admission.js — 准入判据（DESIGN 重构计划 Phase 5 的 `admission.js`）。
//
// 「准入」在这里被拆成三个**纯**判据，三个都只读 `ActivationPlan` 与对方报来的摘要：
//   1. `admitModSet`  —— 房间/进程声明的**集合摘要**对不对（客户端必须回声同一个 digest，DESIGN §28.2）；
//   2. `admitPack`    —— 某一个包此刻**到底能不能跑**（不在计划里 / 钉失效 / 该同意没同意）；
//   3. `roomSubset`   —— 房间点名的子集里，哪些真的可跑（其余**具名**给出原因，绝不静默少给）。
//
// 为什么不写在 `server/lobby.js` 里：那正是审计抓到的「同一个问题被回答五遍」的形状。判据只有一份。

import { evaluateConsentPin } from './consent.js';

/** 准入失败码（与 SDK 错误码同族）。 */
export const ADMISSION_CODES = Object.freeze({
  OK: null,
  SET_MISMATCH: 'ADMISSION_SET_MISMATCH',
  NOT_ACTIVATED: 'ADMISSION_NOT_ACTIVATED',
  NOT_CONSENTED: 'ADMISSION_NOT_CONSENTED',
  PIN_STALE: 'ADMISSION_PIN_STALE',
});

/**
 * 集合摘要准入：对方声明的 digest 必须与本地这一份**逐字相同**。
 * 没有包（`expected` 为 null/undefined）时不设门槛 —— 与「干净安装逐字节不变」同一条纪律。
 * @param {{ offered?: string|null, expected?: string|null }} input
 */
export function admitModSet({ offered = null, expected = null } = {}) {
  if (!expected) return { ok: true, code: ADMISSION_CODES.OK, reason: null };
  if (offered === expected) return { ok: true, code: ADMISSION_CODES.OK, reason: null };
  return {
    ok: false,
    code: ADMISSION_CODES.SET_MISMATCH,
    reason: `mod set mismatch: the room declares "${expected}" but the caller offered ${offered === null || offered === undefined ? 'nothing' : `"${offered}"`}`,
  };
}

/**
 * 单包准入：它必须**在计划里被激活**，且同意/钉版判据通过。
 * @param {object} plan `buildActivationPlan(...)` 的产物
 * @param {string} packId
 * @param {{ requireConsent?: boolean, entry?: object|null }} [opts]
 */
export function admitPack(plan, packId, { requireConsent = false, entry = null } = {}) {
  if (!plan || !plan.activatedSet || !plan.activatedSet.has(packId)) {
    return { ok: false, code: ADMISSION_CODES.NOT_ACTIVATED, reason: `pack "${packId}" is not activated on this server (disabled / refused / unavailable)` };
  }
  const descriptor = plan.descriptorById ? plan.descriptorById.get(packId) : null;
  const verdict = evaluateConsentPin(descriptor || { id: packId, contentDigest: null }, entry, { requireConsent });
  if (!verdict.ok) {
    const code = verdict.code === 'SDK_NOT_CONSENTED' ? ADMISSION_CODES.NOT_CONSENTED : ADMISSION_CODES.PIN_STALE;
    return { ok: false, code, reason: verdict.reason };
  }
  return { ok: true, code: ADMISSION_CODES.OK, reason: null };
}

/**
 * 房间点名的子集：分出「可跑」与「被拒（具名）」两摞。
 * @param {object} plan
 * @param {string[]} roomPackIds
 * @param {{ requireConsent?: boolean, registry?: any }} [opts]
 */
export function roomSubset(plan, roomPackIds, { requireConsent = false, registry = null } = {}) {
  const allowed = [];
  const refused = [];
  for (const id of Array.isArray(roomPackIds) ? roomPackIds : []) {
    const entry = registry && registry.packs ? (registry.packs[id] || null) : null;
    const v = admitPack(plan, id, { requireConsent, entry });
    if (v.ok) allowed.push(id);
    else refused.push({ id, code: v.code, reason: v.reason });
  }
  return { allowed, refused };
}
