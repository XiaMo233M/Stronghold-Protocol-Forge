// shared/callBudget.js — 每局每插件的**调用预算**（`pack.json.callBudget`，DESIGN §28.52，沙箱档的运行时保护）。
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明，不是客户端界面文案)
//
// 为什么要有这一格：我们只有 `combat: true` 这一道**闸门** —— 它回答的是「这个包能不能改对局结果」（一个**意图
// 声明**），而不是「它能跑多久、能跑多少次」（一个**执行上限**）。于是一个诚实地声明了 `combat: true` 的包，或者
// 一个每 tick 触发一次、每次又挂一批计时器的回调，可以把整局拖住：闸门放行的是**能力**，不是**预算**。上游的做法
// 是每局每插件一个次数上限（缺省 8000），耗尽即回滚该回调、撤掉它的计时器与标记 buff、记一笔点名到插件 id 的错。
// 本文件是那件事的**唯一一份判据**。
//
// 与 module 档的关系（业主口径 §4b 的「并存沙箱档」）：**module 档保留现状**（内容文件 + kit 白名单 +
// `server.meta` / `server.battle` 全能力），沙箱档**新增运行时保护**。所以预算**按档启用** —— **只有声明了
// `pack.json.callBudget` 的包才建账**（`server/battlePack.js` 在装载期把它挂到 installer 上，见 §28.52 的
// 「怎么启用」）。没声明的包一行都不多跑，与今天逐字节相同。哪几个包进沙箱档由**声明**决定，本刀只把机制做出来。
//
// 三条工程硬约束（业主已定，写在这里免得下一刀忘掉）：
//
//   1. **两端确定性、只有一份实现**。这一格的读者有三个，而且必须读同一份：
//        * 形状层 `shared/workshop.js`（判声明、知道缺省值）；
//        * 运行层 `server/sim/battle/hooks.js`（计数与回滚 —— 它在 Node 与浏览器里是**同一段字节**）；
//        * 装载层 `server/battlePack.js`（装载期解析一次，把生效值同时交给两端）。
//      所以常量和规则住在这里，而**不住** `server/sim/constants.js`：`server/sim/constants.js:5` 已经在 import
//      `shared/constants.js`，把常量放 sim 会让底座反向依赖上层。放 `shared/` 三方都读同一份，`tools/check-imports.mjs`
//      的两条边界（sim 不许 import match/lobby/http/net/public/node）一条都不碰。
//      预算这条路径里**不许有任何端特有分支**（`typeof window` / `process.` / …）—— 两端若在不同的调用计数上回滚，
//      之后的状态就分叉了，而「同一份摘要 ⇒ 同一份行为」正是这个中间层存在的理由。判据：
//      `test/callBudget.test.js` 的「预算这条路径里没有端特有分支（源码级）」。
//
//   2. **凡影响对局结果的必须进内容摘要**（照既有口径：与 `combat` 同一级、进摘要）。`callBudget` 是 `pack.json`
//      的**顶层键**（`PACK_FIELDS`），**只在声明过时才进**归一化清单（`shared/workshop.js` 的
//      `...(callBudgetParsed ? { callBudget: … } : {})`，与 `variants` / `behaviour` 逐字同形）—— 于是
//      `identifyPack` 哈希的 `canonicalJson(pack)` 覆盖它：**两份只差预算的包是两个身份**（一个会截断回调、一个不截，
//      房间的摘要闸门若把它们当成同一个包，就会放行两种不同的玩法）。反过来，**没声明 ⇒ 不长键**是硬性的：
//      给每个包补一个 `callBudget: {}` 会让**所有已发布包的内容哈希全变**，而哈希是房间身份与 W-D 对齐的依据。
//
//   3. **探测不得进入建房路径**。判决「这个包用不用得上预算」发生在**装载期**（`server/battlePack.js`
//      `loadBattleInstallers`，启动一次，用包自己的身份 —— 那条 `[id, hash]` 口径就是 `modDigest` 的那一条：
//      同 hash ⇒ 同字节 ⇒ 同预算，所以建房时不需要再探一次）。`server/lobby.js` 里出现 `callBudget` 就是错的：
//      上游实测过「探测期大厅暂停」（在 `room.create` / 房间建立流程里跑一次探测会把大厅堵住）。判据：
//      `test/callBudget.test.js` 的「server/lobby.js 里没有预算这件事」。
//
// 记账规则（**只有这一份**，`server/sim/battle/hooks.js` 调它）：
//   * `max` 是**可用次数**：第 `max` 次仍然放行，第 `max + 1` 次**不放行**并触发回滚（`packCallAllowed`）。
//   * 计数**按插件聚合**：这个包的 hook、它 `after` / `every` 排的计时器、它标的 buff 的 `onTick` / `onExpire`
//     都记在同一本账上 —— 「每局每插件次数上限」说的就是这个包这一局一共能被调多少次。
//   * 回滚 = 撤掉它全部 hook 与计时器 + 撤掉它标的 buff + 记一笔 `plugin:<包id>` 的错（`callBudgetOwner`）。
//     名字就叫 `plugin:<id>`：作者一眼看得出被停的是哪个插件，日志里也能直接 grep。

/** 具名失败的统一形状（`ok: false` 是**字面量**，好让下面那条 `@returns` 联合类型收得住 —— 与
 *  `shared/enabled.js` 的 `fail` 逐字同一条注解，漏了它 `tsc` 会报 `boolean` 收不进 `false`）。
 *  @type {(error: string, detail: string) => { ok: false, error: string, detail: string }} */
const fail = (error, detail) => ({ ok: false, error, detail });

/** 一个已经过了 `isPlainObj` 的值（`isPlainObj` 只回 boolean，不是类型守卫，所以这里显式收窄一次）。 */
const asRecord = (v) => /** @type {Record<string, unknown>} */ (v);

/**
 * 一个插件**每局**可用的调用次数缺省值 —— **只有这一份**（上游 8000）。
 *
 * 为什么是 8000 而不是别的：这是上游实测后定下来的口径，而「同一个数字」本身就是这一格的价值 —— 两端、装载器与
 * 形状层读的必须是同一个符号。改它要同时想清楚：`test/callBudget.test.js` 的「8000 在 shared/callBudget.js 里
 * 只出现一次」会红，那是有意的闸门。
 */
export const PACK_CALL_BUDGET_DEFAULT = 8000;

/** 这一格里的键：闭集。加一格要同时进 `shared/modSurface.js` 与 `docs/MOD-SURFACE.md`（并且不抬 `MOD_API_VERSION`）。 */
export const CALL_BUDGET_FIELDS = Object.freeze(['max']);

/**
 * 一个包**生效**的每局调用上限（`pack.json.callBudget.max`），没声明就是 `null`。
 *
 * **只有这一份**：装载期读它的地方有两处 —— `server/battlePack.js`（`server.battle` 模块那一半）与
 * `server/workshop.js loadWorkshopKits`（`kits/` 那一半）—— 「包 → 生效 max」这个问题在两条装载线上必须只有一个
 * 答案，两处各写一次比较就是两处会漂的判断。传进来的是 `normalizePackManifest` 之后那份清单（形状层已经判过：
 * 只有 `{ max }`、只许收紧），所以这里只做「声明过没有」这一步。
 * @param {{ callBudget?: { max?: number } }|null|undefined} pack
 * @returns {number|null}
 */
export function effectivePackCallBudget(pack) {
  const decl = pack && pack.callBudget;
  return decl && Number.isInteger(decl.max) ? decl.max : null;
}

/** 这一格在 `pack.json` 里的键名（`PACK_FIELDS` 与 `shared/modSurface.js` 的锚点都用它）。 */
export const CALL_BUDGET_FIELD = 'callBudget';

/** 声明形状不是对象（`true` / `[]` / `"8000"` / `null`）。 */
export const CALL_BUDGET_BAD_SHAPE = 'CALL_BUDGET_BAD_SHAPE';
/** 闭集外的键（`{ max: 3, minCalls: 1 }`）—— 一个我们不认识的键**点名拒绝**，绝不读过去。 */
export const CALL_BUDGET_UNKNOWN_FIELD = 'CALL_BUDGET_UNKNOWN_FIELD';
/** `max` 不是一个 ≥ 1 的整数（`0` / `2.5` / `"8000"` / `NaN`）。 */
export const CALL_BUDGET_BAD_MAX = 'CALL_BUDGET_BAD_MAX';
/** `max` 比缺省值**大** —— 预算只能收紧，不能放宽。 */
export const CALL_BUDGET_TOO_HIGH = 'CALL_BUDGET_TOO_HIGH';

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 读 `pack.json.callBudget`。
 *
 * **只许收不许放**（`max ≤ PACK_CALL_BUDGET_DEFAULT`）是这一格的核心：一个能把自己上限调高的声明，等于没有上限
 * —— 「预算」二字就是这个意思。作者想写 20000 说明他想要的是**没有上限**，那件事在这一格里不存在（他应该不写
 * `callBudget`，也就是留在 module 档）。拒绝文案把这句话说出来，而不是丢一个 `BAD_MAX` 让作者猜。
 *
 * @param {unknown} raw 作者写的那一格（调用方负责先判 `undefined`，见 `shared/workshop.js`）
 * @returns {{ ok: true, decl: { max: number } } | { ok: false, error: string, detail: string }}
 */
export function parseCallBudgetDecl(raw) {
  if (!isPlainObj(raw)) {
    const shown = raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw;
    return fail(CALL_BUDGET_BAD_SHAPE,
      `"callBudget" must be an object with at most one key (${CALL_BUDGET_FIELDS.join(', ')}) — got ${shown}. `
      + 'Write `"callBudget": {}` to take the default, or `"callBudget": { "max": <n> }` to tighten it; a bare boolean carries no budget and would be read as one');
  }
  for (const key of Object.keys(raw)) {
    if (CALL_BUDGET_FIELDS.includes(key)) continue;
    return fail(CALL_BUDGET_UNKNOWN_FIELD,
      `"callBudget.${key}" is not a field of this declaration (${CALL_BUDGET_FIELDS.join(', ')}). A key this loader does not know is never read: `
      + 'a declaration that is ignored is worse than a refusal');
  }
  const declared = asRecord(raw).max;
  const max = declared === undefined ? PACK_CALL_BUDGET_DEFAULT : declared;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    const shown = typeof max === 'string' ? JSON.stringify(max) : String(max);
    return fail(CALL_BUDGET_BAD_MAX,
      `"callBudget.max" must be an integer of at least 1 (calls this pack may make per match) — got ${shown}. `
      + 'A fractional or string value would be a silent disagreement between what the author wrote and what the engine counts');
  }
  if (max > PACK_CALL_BUDGET_DEFAULT) {
    return fail(CALL_BUDGET_TOO_HIGH,
      `"callBudget.max" may only TIGHTEN the budget: ${max} is above the engine default of ${PACK_CALL_BUDGET_DEFAULT} calls per match per pack. `
      + 'A budget that can be raised is not a budget — a pack that needs more than the default must not declare "callBudget" at all (that keeps it in the module tier, byte for byte as before)');
  }
  return { ok: true, decl: { max } };
}

/**
 * 一次调用该不该放行。**纯函数**，因为它是这一格里唯一一条会被两端各跑一遍的规则 —— 它自己必须可以被直接测。
 *
 * `used` 是这次之前**已经记账**的次数：第 `max` 次放行（`used === max - 1`），第 `max + 1` 次不放行并触发回滚。
 * 「8000 次」是**可用次数**，不是「第 8000 次就砍」—— 差一位就是给每个诚实包少一次调用。
 *
 * @param {number} used @param {number} max
 */
export function packCallAllowed(used, max) {
  return used < max;
}

/**
 * 一本账的键，也就是回滚与日志里那个名字：`plugin:<包id>`。
 *
 * 为什么错要记在这个名字上而不是包 id 或模块 id：作者在日志里 grep `plugin:` 就能看到「哪个插件被预算停掉了」，
 * 而 `battle.errors` 的 `label` 一栏本来就承载「是谁的问题」（`hook:<事件名>` / `content:pack:<id>` 同一族）。
 * @param {string} packId
 */
export function callBudgetOwner(packId) {
  return `plugin:${String(packId)}`;
}

/** 这个 owner 是不是一本预算账（而不是一个单位 / `lpMeter` 之类的既有 owner）。 @param {unknown} owner */
export const isCallBudgetOwner = (owner) => typeof owner === 'string' && owner.startsWith('plugin:');

/** 账的键 → 包 id（不是一本预算账时返回 `null`）。 @param {unknown} owner */
export function callBudgetPackId(owner) {
  return isCallBudgetOwner(owner) ? String(owner).slice('plugin:'.length) : null;
}

/**
 * 回滚时记的那一笔错（`battle._handlerError(label = plugin:<id>, …)` 的 `message`）。
 *
 * 三件事都要说出来，否则作者只会看到「我的包没生效」：用完了多少、什么被撤了、这一局接下来怎么走。
 * @param {string} packId @param {number} max
 */
export function callBudgetExhaustedReason(packId, max) {
  return `pack "${packId}" exhausted its per-match call budget of ${max} call(s) (pack.json.callBudget.max): `
    + 'its hooks and timers were rolled back and the buffs it marked were removed — the match continues without this pack. '
    // 这一句过去写成「Raise the cap by tightening nothing …」，与同一份文件上面那条口径（只许收紧；`max` 高于缺省就是
    // `CALL_BUDGET_TOO_HIGH`）自相矛盾：照着它去改的作者会撞一个「不许抬高」的拒绝。**名不副实比不说更坏** —— 所以
    // 文案只说这条路怎么走：要更多就不写 `callBudget`，留在 module 档。
    + `The cap can only be lowered, never raised (the engine default is ${PACK_CALL_BUDGET_DEFAULT}): a pack that needs more must drop "callBudget" and stay in the module tier. `
    + 'Look for a callback that runs every tick or one that schedules more work inside itself';
}
