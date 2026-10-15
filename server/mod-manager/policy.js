// server/mod-manager/policy.js — 运行时的**策略开关**（重构版）。
//
// 为什么单独一个文件：与 `server/accountConfig.js`、`budgetMapFromEnv` 同一条先例 ——
// `server/index.js` 与 `server/modModules.js` 在 `test/packServerSurface.test.js` 的 `SP_*` **反射名单**里，
// 而「这个服务器对包有多严」正是那种**不该让包看见**的运维杠杆（包据此分叉就成了「同一份摘要有两种行为」）。
// 所以这些 `SP_MOD_*` 一律读在这里，`index.js` 只调用函数。
//
// 三个开关（全部**默认关闭** ⇒ 逐字节保持既有行为）：
//   * `SP_MOD_REQUIRE_CONSENT=1` —— 宿主进程档的包必须有**对本版字节的同意**才激活（未同意具名拒：
//     `SDK_NOT_CONSENTED`）。钉版失效（`SDK_PIN_STALE`）**任何情况下都拦**，与本开关无关。
//   * `SP_MOD_STRICT_GLOBALS=1` —— `server.modules` 的源码扫描走**严格档**（含 `globalThis`）。
//   * `SP_MOD_BUDGET='{...}'` —— 统一调用预算（解析在 `budget.js`）。

import { budgetMapFromEnv } from './budget.js';

const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? ''));

/**
 * 读出这一进程的 mod 策略。`startServer` 的显式选项（若有）优先于环境变量 —— 测试用它注入，
 * 一套跑在 CI 上的测试不该随 shell 环境变形。
 * @param {Record<string, string|undefined>} [env]
 * @param {{ log?: any, now?: () => number }} [opts]
 * @returns {{ strictGlobals: boolean, requireConsentForHost: boolean, scanProfile: 'legacy'|'module',
 *             budget: ReturnType<typeof budgetMapFromEnv> }}
 */
export function modPolicyFromEnv(env = process.env, { log = null, now } = {}) {
  const strictGlobals = truthy(env.SP_MOD_STRICT_GLOBALS);
  const requireConsentForHost = truthy(env.SP_MOD_REQUIRE_CONSENT);
  return Object.freeze({
    strictGlobals,
    requireConsentForHost,
    // 严格档的档位名：官方进程内 module。legacy 是**缺省**（旧行为，`globalThis` 豁免保留）。
    scanProfile: strictGlobals ? 'module' : 'legacy',
    budget: budgetMapFromEnv(env, { log, ...(now ? { now } : {}) }),
  });
}
