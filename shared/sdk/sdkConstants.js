// shared/sdk/sdkConstants.js — the vocabulary of the Mod Manager's SDK boundary.
//
// 这一层只定义**名字**，不做任何判断之外的 IO。它的存在理由（DESIGN 重构计划 §一 原则 1）：
// 官方能力与 Forge 能力必须**分域**——不能把 Forge 的 `MOD_API_VERSION` 直接冒充 `sp:sdk@1`。
// 所以一个包的身份里永远同时有两个正交的东西：
//
//   origin:  'official' | 'forge'             ← 这份包按谁家的规范写
//   sdk:     'sp:sdk@1'（**上游的**，本仓只用于识别）| 'forge-ext@1'（**我方扩展档**）
//   profile: 'module' | 'sandbox' | 'legacy' | 'host'  ← 它以什么方式被执行
//
// `profile` 必须属于 `PROFILE_BY_ORIGIN[origin]`——一个 official 包不许声称自己是 `legacy`，
// 一个 forge 包也不许声称自己是 `sandbox`（那是官方档的隔离运行时）。这条约束在这里只判形状，
// 真正的执行分派在 `server/mod-manager/` 与运行时层。

/**
 * **上游官方**的 SDK 标识（0.3.0 `docs/PLUGINS.md`，`shared/plugins/sdk.js#SDK_ID`）。
 * **本仓绝不声明它** —— 官方档由上游实现承担，这里只用它来**识别**一份上游插件（互操作边界）。
 * 常量名刻意叫 UPSTREAM 而不是 OFFICIAL：它是「别人的档」，不是「我这一档的另一个名字」。
 */
export const SDK_UPSTREAM = 'sp:sdk@1';
/**
 * **我方扩展档**的 SDK 标识（"类官方"的那一档）：声明面的**形状**按 0.3.0 的约定写，
 * **身份**是 Forge 自己的。这样上游的 manifest 校验会因为不认识这个值/键而拒收 ——
 * 「不冒充 `sp:sdk@1`」在机械上就成立，而不是靠自觉。
 */
export const SDK_FORGE_EXT = 'forge-ext@1';

/** 包规范来源。 */
export const ORIGINS = Object.freeze(['official', 'forge']);

/** 执行档位：官方两档（进程内 module / 隔离 sandbox），Forge 两档（进程内 host / 纯数据 legacy）。 */
export const PROFILES = Object.freeze(['module', 'sandbox', 'legacy', 'host']);

/** 每个 origin 允许的 profile 闭集——跨域声明在形状层就被拒。 */
export const PROFILE_BY_ORIGIN = Object.freeze({
  official: Object.freeze(['module', 'sandbox']),
  forge: Object.freeze(['legacy', 'host']),
});

/** origin → sdk 标识。 */
export const SDK_BY_ORIGIN = Object.freeze({ official: SDK_UPSTREAM, forge: SDK_FORGE_EXT });

/** origin → 未声明 profile 时的缺省档位。 */
export const DEFAULT_PROFILE_BY_ORIGIN = Object.freeze({ official: 'module', forge: 'legacy' });

/**
 * **运行模式**（DESIGN 重构计划 Phase 8）。决定这台服务器接受哪些 origin 的包：
 *   * `official-only`      —— 只跑 `sp:sdk@1`（安全联机 / 上游互通）；
 *   * `official-preferred` —— 官方档优先，Forge legacy 仍可跑但**逐包告警**、不提供跨上游兼容证明；
 *   * `legacy-compatible`  —— **缺省**，保留全部 Forge 能力（与重构前逐字节相同）。
 */
export const RUN_MODES = Object.freeze(['official-only', 'official-preferred', 'legacy-compatible']);
/** 缺省运行模式：行为不变。 */
export const DEFAULT_RUN_MODE = 'legacy-compatible';
/** @param {unknown} v */
export const isRunMode = (v) => typeof v === 'string' && RUN_MODES.includes(v);

/**
 * 能力名闭集。**一个包声明它要用的能力，运行时按名字注入**——这与「模块自己去摸 globalThis」是对立的
 * （DESIGN 重构计划 §四 高风险 2）。官方 module 运行时只认这张表；Forge legacy 档可以更宽松。
 */
export const CAPABILITIES = Object.freeze([
  'content',    // 声明式内容表（shared/workshop.js 的 15 张）
  'assets',     // 素材 / 皮肤 / 立绘 / 图标
  'i18n',       // 译文
  'notices',    // 公告
  'overrides',  // 字段级覆盖
  'variants',   // 口径轴（Forge 扩展）
  'behaviour',  // 行为开关（Forge 扩展）
  'forms',      // 形态通道（Forge 扩展）
  'kits',       // 行为层 kits（Forge 扩展）
  'panels',     // 客户端面板槽（Forge 扩展）
  'modules',    // server.modules（宿主进程内代码）
  'meta',       // server.meta（改对局结果）
  'battle',     // server.battle（确定性战斗逻辑）
  'room',       // server.room（房间级钩子）
  'preDispatch',// server.preDispatch（分发前准入）
  'storage',    // host.io 的 scoped 状态目录
  'health',     // /healthz 只读字段
  'routes',     // 只读 HTTP JSON 端点
  'metrics',    // host.metrics 只读快照
  'lane',       // 包自带 WebSocket 通道
  'matchClass', // MatchClass 包装器（改对局）
  'matchKinds', // 声明自己参与哪些对局种类
  'lobby',      // 房间生命周期事件（官方档 api.lobby.on）
]);

/** 需要 `combat: true` 才允许声明的能力（能改对局结果的载荷）。 */
export const COMBAT_CAPABILITIES = Object.freeze(['meta', 'battle', 'kits', 'matchClass', 'variants', 'behaviour']);

/** SDK 层的错误码（与既有 `MODULES_*` / `PACK_*` 命名同族）。 */
export const SDK_ERROR_CODES = Object.freeze({
  BAD_DESCRIPTOR: 'SDK_BAD_DESCRIPTOR',
  BAD_ORIGIN: 'SDK_BAD_ORIGIN',
  BAD_PROFILE: 'SDK_BAD_PROFILE',
  PROFILE_NOT_FOR_ORIGIN: 'SDK_PROFILE_NOT_FOR_ORIGIN',
  UNKNOWN_CAPABILITY: 'SDK_UNKNOWN_CAPABILITY',
  COMBAT_REQUIRED: 'SDK_COMBAT_REQUIRED',
  UNKNOWN_FIELD: 'SDK_UNKNOWN_FIELD',
  NOT_CONSENTED: 'SDK_NOT_CONSENTED',
  PIN_STALE: 'SDK_PIN_STALE',
});

/** 一个 `{ code, reason }` 的 SDK 失败对象（与仓库其它拒绝形状一致）。 */
export function sdkError(code, reason, extra = null) {
  return extra ? { code, reason, ...extra } : { code, reason };
}

/** @param {unknown} v */
export const isOrigin = (v) => typeof v === 'string' && ORIGINS.includes(v);
/** @param {unknown} v */
export const isProfile = (v) => typeof v === 'string' && PROFILES.includes(v);
/** @param {unknown} v */
export const isSdkId = (v) => v === SDK_UPSTREAM || v === SDK_FORGE_EXT;

/** origin 与 profile 是否相容（跨域声明＝拒）。 */
export function profileAllowedFor(origin, profile) {
  if (!isOrigin(origin) || !isProfile(profile)) return false;
  return PROFILE_BY_ORIGIN[origin].includes(profile);
}

/** 由 origin 推出 sdk 标识（未知名返回 null）。 */
export function sdkForOrigin(origin) {
  return isOrigin(origin) ? SDK_BY_ORIGIN[origin] : null;
}

/** 由 origin 推出缺省 profile（未知名返回 null）。 */
export function defaultProfileFor(origin) {
  return isOrigin(origin) ? DEFAULT_PROFILE_BY_ORIGIN[origin] : null;
}
