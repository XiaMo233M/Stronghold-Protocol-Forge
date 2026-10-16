// server/mod-manager/budget.js — 统一调用预算 / 看门狗（DESIGN 重构计划 §四 高风险 3；审计 GAP-3）。
//
// 审计实测（2026-10-15）：Forge 现在**没有任何**统一的包执行预算——`boot` / `shutdown` / `healthz` /
// `matchClass` / `route` / `lane` 的回调全部裸 `try/catch`，没有墙钟、没有调用次数、没有字节上限
// （全树搜 `maxCalls`/`maxCpu`/`watchdog` 零命中）。一个恶意的 `onBoot` 死循环可以阻塞整个服务器事件循环。
//
// 诚实的一条（必须写在这里，否则这个文件就是一个说了不算的承诺）：
//   **JS 无法抢占式地打断一段同步代码。** 所以 `maxWallTimeMs` 在本层是**事后测量 + 记账 + 拒绝下一次**，
//   不是「到点掐断」。真正的隔离（子进程 / worker）是官方 sandbox 档的事（DESIGN §四 高风险 2 的分档）。
//   本文件给的是：可测试的记账、可预测的触发点、以及「超预算之后不再放行」这条硬边。
//
// 缺省全 0 = **不限**，所以接入本层不改变任何现有行为；收紧是显式配置的事（官方档应由管理器收紧）。

/** 预算字段的闭集与缺省（全 0 = 不限）。 */
export const BUDGET_FIELDS = Object.freeze(['maxCalls', 'maxBytesIn', 'maxBytesOut', 'maxWallTimeMs', 'maxCpuMs', 'maxConcurrentCalls']);

/** 一个包的缺省预算（不限）。`maxConcurrentCalls: 0` = 不限制并发。 */
export const UNLIMITED_BUDGET = Object.freeze({ maxCalls: 0, maxBytesIn: 0, maxBytesOut: 0, maxWallTimeMs: 0, maxCpuMs: 0, maxConcurrentCalls: 0 });

/** 把任意输入收敛成一份规范预算（负数/NaN → 0；未知字段丢掉）。 */
export function normalizeBudget(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of BUDGET_FIELDS) {
    const n = Number(src[k]);
    out[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return Object.freeze(out);
}

/** 一份预算是否是「无限」。 */
export const isUnlimited = (b) => BUDGET_FIELDS.every((k) => !b || !b[k]);

/**
 * 建一个预算记账器。`now` 可注入（测试要确定性）。
 *
 * 记账维度：调用次数、进出字节、墙钟（累计与单次最长）。**第一次越界**会记在 `exceeded` 上并从此不放行
 * （`allow()` 返回 false）——「先超一次再收紧」比「每次都放行」更接近看门狗该有的形状。
 * @param {object} [budget]
 * @param {{ now?: () => number }} [opts]
 */
export function createBudgetTracker(budget = UNLIMITED_BUDGET, { now = () => Date.now() } = {}) {
  const b = normalizeBudget(budget);
  const state = { calls: 0, bytesIn: 0, bytesOut: 0, wallTimeMs: 0, longestCallMs: 0, exceeded: /** @type {null|{code:string,reason:string}} */ (null) };

  const trip = (reason) => {
    if (!state.exceeded) state.exceeded = { code: 'SDK_BUDGET_EXCEEDED', reason };
    return false;
  };

  return {
    budget: b,
    get state() { return { ...state, ...(state.exceeded ? { exceeded: state.exceeded } : {}) }; },
    get exceeded() { return state.exceeded; },
    /** 现在还能不能放行一次调用。 */
    allow() {
      if (state.exceeded) return false;
      if (b.maxCalls && state.calls >= b.maxCalls) return trip(`call count ${state.calls} reached the budget (maxCalls ${b.maxCalls})`);
      if (b.maxWallTimeMs && state.wallTimeMs >= b.maxWallTimeMs) return trip(`wall time ${state.wallTimeMs}ms reached the budget (maxWallTimeMs ${b.maxWallTimeMs})`);
      return true;
    },
    /** 记一次已发生的调用。 */
    record(durationMs = 0) {
      state.calls += 1;
      const d = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
      state.wallTimeMs += d;
      if (d > state.longestCallMs) state.longestCallMs = d;
      if (b.maxWallTimeMs && state.wallTimeMs > b.maxWallTimeMs) trip(`wall time ${state.wallTimeMs}ms exceeds the budget (maxWallTimeMs ${b.maxWallTimeMs})`);
    },
    /** 记进出字节（超上限即 trip）。 */
    bytes(dir, n) {
      const v = Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0;
      if (dir === 'in') { state.bytesIn += v; if (b.maxBytesIn && state.bytesIn > b.maxBytesIn) trip(`bytes in ${state.bytesIn} exceeds the budget (maxBytesIn ${b.maxBytesIn})`); }
      else { state.bytesOut += v; if (b.maxBytesOut && state.bytesOut > b.maxBytesOut) trip(`bytes out ${state.bytesOut} exceeds the budget (maxBytesOut ${b.maxBytesOut})`); }
      return state.exceeded ? false : true;
    },
    /** 由外部触发的越界（例如模块自己报告一次超时）。 */
    trip(reason) { return trip(reason); },
  };
}

/**
 * 把一段同步回调包成**受预算约束**的一跳。
 *
 * 返回一个 `{ ok, value, error, budgetExceeded }`：调用方（`mountServerModules`）据此决定记日志 / 跳过，
 * 而不是让一个包的回调把宿主拖死。函数**不抛**——与仓库里 `try/catch` 只记日志的既有纪律一致。
 *
 * @template {(...a: any[]) => any} F
 * @param {F} fn
 * @param {{ tracker: ReturnType<typeof createBudgetTracker>, label?: string, log?: any, now?: () => number }} ctx
 * @returns {(...a: Parameters<F>) => { ok: boolean, value?: ReturnType<F>, error?: any, budgetExceeded: boolean }}
 */
export function guarded(fn, { tracker, label = '', log = null, now = () => Date.now() } = {}) {
  return (...args) => {
    if (!tracker.allow()) {
      log?.warn?.(`[mod-budget] ${label} refused: ${tracker.exceeded ? tracker.exceeded.reason : 'budget exhausted'}`);
      return { ok: false, error: tracker.exceeded, budgetExceeded: true };
    }
    const t0 = now();
    try {
      const value = fn(...args);
      tracker.record(now() - t0);
      if (tracker.exceeded) {
        log?.warn?.(`[mod-budget] ${label} tripped the budget: ${tracker.exceeded.reason}`);
        return { ok: false, value, budgetExceeded: true };
      }
      return { ok: true, value, budgetExceeded: false };
    } catch (e) {
      tracker.record(now() - t0);
      return { ok: false, error: e, budgetExceeded: false };
    }
  };
}

/**
 * 把一份「包 id → 预算」的表变成「包 id → tracker」的表；没列出的包拿到 `fallback`（缺省不限）。
 * 这样 `mountServerModules` 只要拿到一个 `Map` 就能给每个模块套上它自己的预算。
 * @param {Record<string, object>} table
 * @param {{ fallback?: object, now?: () => number }} [opts]
 */
export function createBudgetMap(table = {}, { fallback = UNLIMITED_BUDGET, now = () => Date.now() } = {}) {
  const src = table && typeof table === 'object' ? table : {};
  const map = new Map();
  const trackerFor = (packId) => {
    if (!map.has(packId)) map.set(packId, createBudgetTracker(src[packId] || fallback, { now }));
    return map.get(packId);
  };
  return { trackerFor, size: () => map.size };
}

/**
 * `SP_MOD_BUDGET` 的解析（审计 GAP-3 的开关）。**刻意读在这个文件里**，与 `server/accountConfig.js` 同一条先例：
 * `server/index.js` 与 `server/modModules.js` 在 `test/packServerSurface.test.js` 的 `SP_*` 反射名单里，而
 * 「这个服务器给包多少调用预算」正是那种**不该让包看见**的运维杠杆（同一个包在两台机器上两种行为）。
 * 未设置 / 非法 JSON ⇒ `null`（统一预算保持关闭，行为逐字节不变）。
 *
 * 形如 `'{"*":{"maxCalls":1000,"maxWallTimeMs":500}}'`（所有包同一份），或 `'{"<包id>":{...}}'`（逐包）。
 * @param {Record<string, string|undefined>} [env]
 * @param {{ log?: any, now?: () => number }} [opts]
 */
export function budgetMapFromEnv(env = process.env, { log = null, now = () => Date.now() } = {}) {
  const raw = env.SP_MOD_BUDGET;
  if (!raw) return null;
  let table;
  try {
    table = JSON.parse(raw);
  } catch {
    log?.warn?.('[mod-budget] SP_MOD_BUDGET is not valid JSON — the unified call budget stays off');
    return null;
  }
  if (!table || typeof table !== 'object') return null;
  const fallback = table['*'];
  return createBudgetMap(table, { ...(fallback ? { fallback } : {}), now });
}
