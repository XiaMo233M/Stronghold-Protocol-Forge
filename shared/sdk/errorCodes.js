// shared/sdk/errorCodes.js — 我方错误码 ↔ **上游 0.3.0 码表**的对齐层。
//
// 上游的权威码表是 `shared/plugins/errors.js#PLUGIN_ERRORS`（167 条，`docs/PLUGIN-API.md` 的 error.* 表
// 就是从它生成的）。我方（Forge 扩展层）历史上自造了一批 `SDK_*` / `PLUGIN_BAD_*` / `SANDBOX_*` ——
// 上游工具与客户端**读不懂**它们。本文件把对齐关系收成**一张表**：
//
//   * `UPSTREAM_ALIGNED`：我方码 → **上游同义码**。发出的日志/报告里两个都带
//     （`{ code: 'PLUGIN_SCRIPT_CONFLICT', upstream: 'PLUGIN_CONFLICT' }` 形态不引入 —— 改为：
//     对齐后的码**直接用上游码**，我方原名留作 `detail.forge`，这样上游消费者只看到认识的码）。
//   * `FORGE_ONLY_CODES`：上游没有对应物的 Forge 扩展码（管理器自己的判定，不是插件契约的一部分）。
//     它们**保留原名** —— 冒充上游码反而会让上游消费者把「管理器自己的拒绝」误当「插件体系拒绝」。
//
// 判定来源（2026-10-16 对照）：`UP/up/shared/plugins/errors.js` 的 `\bPLUGIN_[A-Z_]+\b` 全集（167）。

/** 我方码 → 上游同义码。值为 `null` = 上游没有对应物（保留 Forge 原名）。 */
export const CODE_ALIGNMENT = Object.freeze({
  // —— 清单/装载（上游 refusal/problem 族的同义）——
  SDK_BAD_DESCRIPTOR: 'PLUGIN_MANIFEST_SHAPE',
  SDK_UNKNOWN_FIELD: 'PLUGIN_FIELD_UNKNOWN',
  SDK_UNKNOWN_CAPABILITY: 'PLUGIN_PERMISSION_MISSING',
  SDK_BAD_ORIGIN: 'PLUGIN_MANIFEST_SHAPE',
  SDK_BAD_PROFILE: 'PLUGIN_MANIFEST_SHAPE',
  SDK_PROFILE_NOT_FOR_ORIGIN: 'PLUGIN_MANIFEST_SHAPE',
  SDK_COMBAT_REQUIRED: 'PLUGIN_PERMISSION_MISSING',
  OFFICIAL_BAD_MANIFEST: 'PLUGIN_NO_MANIFEST',
  OFFICIAL_ID_MISMATCH: 'PLUGIN_ID_MISMATCH',
  OFFICIAL_UNREADABLE: 'PLUGIN_FILE_MISSING',
  PLUGIN_BAD_ENTRY: 'PLUGIN_ENTRY',
  PLUGIN_IMPORT_FAILED: 'PLUGIN_SCRIPT_CHECK',
  PLUGIN_NO_REGISTER: 'PLUGIN_ENTRY',
  PLUGIN_NO_SETUP: 'PLUGIN_ENTRY',
  PLUGIN_REGISTER_THREW: 'PLUGIN_SCRIPT_CONFLICT',
  PLUGIN_BAD_SOURCE: 'PLUGIN_SCRIPT_CHECK',
  PLUGIN_USE_UNDECLARED: 'PLUGIN_PERMISSION_MISSING',
  PLUGIN_BAD_META_KEY: 'PLUGIN_MANIFEST_SHAPE',
  PLUGIN_BAD_ROOM_EVENT: 'PLUGIN_MANIFEST_SHAPE',
  PLUGIN_BAD_ROUTE: 'PLUGIN_MANIFEST_SHAPE',
  PLUGIN_BAD_HEALTHZ: 'PLUGIN_MANIFEST_SHAPE',
  PLUGIN_BAD_CALLBACK: 'PLUGIN_MANIFEST_SHAPE',
  PLUGIN_BAD_PATH: 'PLUGIN_FILE_MISSING',
  PLUGIN_BAD_BATTLE_INSTALL: 'PLUGIN_MANIFEST_SHAPE',
  PLUGIN_NO_STATE_DIR: 'PLUGIN_STORAGE',
  PLUGIN_CRASH: 'PLUGIN_WORKER_FAILED',
  PLUGIN_SANDBOX_UNAVAILABLE: 'PLUGIN_SANDBOX_UNAVAILABLE',
  // —— 准入/信任（上游 refusal 族）——
  SDK_NOT_CONSENTED: 'PLUGIN_CONSENT',
  SDK_PIN_STALE: 'PLUGIN_TRUST_PIN',
  ADMISSION_NOT_CONSENTED: 'PLUGIN_CONSENT',
  ADMISSION_PIN_STALE: 'PLUGIN_TRUST_PIN',
  ADMISSION_SET_MISMATCH: 'PLUGIN_INVALID',
  ADMISSION_NOT_ACTIVATED: 'PLUGIN_UNKNOWN',
  // —— 预算/沙箱运行时（上游 problem 族）——
  SDK_BUDGET_EXCEEDED: 'PLUGIN_DSL_BUDGET',
  SANDBOX_TIMEOUT: 'PLUGIN_WORKER_TIMEOUT',
  SANDBOX_CRASH: 'PLUGIN_WORKER_FAILED',
  SANDBOX_CLOSED: 'PLUGIN_WORKER_STOPPED',
  SANDBOX_SPAWN_FAILED: 'PLUGIN_WORKER_FAILED',
  SANDBOX_START_FAILED: 'PLUGIN_WORKER_FAILED',
  SANDBOX_ERROR: 'PLUGIN_WORKER_FAILED',
  SANDBOX_BAD_MESSAGE: 'PLUGIN_INVALID',
  SANDBOX_NO_ENTRY: 'PLUGIN_ENTRY',
});

/**
 * 对齐一个码：上游有同义码 ⇒ **返回上游码**（上游消费者能读懂）；
 * 上游没有 ⇒ 原样返回（Forge 扩展码，`isForgeOnlyCode` 会认它）。
 * @param {string} code
 * @returns {string}
 */
export function alignErrorCode(code) {
  return (code && CODE_ALIGNMENT[code]) || code;
}

/** 对齐一个 `{ code, reason }` 形状的失败对象（原码保留进 `forge`，不丢信息）。 */
export function alignFailure(failure) {
  if (!failure || typeof failure.code !== 'string') return failure;
  const aligned = alignErrorCode(failure.code);
  if (aligned === failure.code) return failure;
  return { ...failure, code: aligned, forge: failure.code };
}

/**
 * Forge 扩展层的**自造码**全集：映射表的键（都有上游同义码，出口时会被换掉）+ 没有上游对应物、
 * 原样保留的那一小撮。判定看「是不是我们发明的名字」，所以已对齐的上游码（如 `PLUGIN_CONSENT`）不是。
 */
const FORGE_NATIVE = Object.freeze(new Set([
  ...Object.keys(CODE_ALIGNMENT),
  // 运行模式与 Forge 独有面板装载（上游没有这两个概念）
  'SDK_ORIGIN_NOT_ALLOWED', 'SDK_LEGACY_IN_OFFICIAL_PREFERRED',
  'PANEL_UNKNOWN_SLOT', 'PANEL_BAD_MODULE',
]));

/** 我方**自造**的码（上游没有对应物，或对齐前被换掉的原名）。 */
export function isForgeOnlyCode(code) {
  return typeof code === 'string' && code.length > 0 && FORGE_NATIVE.has(code);
}
