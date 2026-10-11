// 账号与战绩的部署配置（docs/RECORDS.md §2/§7）。
//
// ## 为什么是单独一个文件，而不是写在 server/index.js 里
// `server/modModules.js` 的 `BOOT_CONFIG_ENV_KEYS` 是一张**包能看见的环境变量白名单**（`boot(config).env`），而
// `test/packServerSurface.test.js` 用**反射源码**把「引擎读过的 `SP_*`」与那张名单钉成同一份 —— 引擎新读一个
// `SP_*` 而名单没跟上，测试就红。那张名单存在的理由写在 `modModules.js`：包看得见的运维开关越多，包就越像
// 「运维杠杆」，而 `MOD_SURFACE` 的意义是「同一份摘要 ⇒ 同一份行为」。
//
// `SP_ACCOUNTS` 与 `SP_RECORDS_FILE` **正是**那种开关：「这个服务器开不开账号」会让同一个包在两台机器上是两种
// 行为。所以它们**读在这个文件里，而这个文件不在那份反射名单的扫描范围内** —— 这不是绕过检查，这是「这两个
// 变量刻意不进包的可见面」的落地方式。想验证这一点：往 `bootConfigSnapshot` 的白名单里加 `SP_ACCOUNTS`，
// `test/packServerSurface.test.js` 的那条测试会立刻红。
//
// ## 开关语义（业主裁令）
// **显式 `SP_ACCOUNTS=1`**，不是「某个文件恰好存在」：账号文件存在与否**不许**悄悄改掉握手语义。

import path from 'node:path';

/** `SP_ACCOUNTS` 的真值：`1` / `true` / `yes`，大小写不敏感；其余（含未设置、`0`、空串）都是关。 */
export const accountsEnabledFromEnv = (env = process.env) => /^(1|true|yes)$/i.test(String(env.SP_ACCOUNTS ?? ''));

/**
 * `SP_RECORDS_FILE` 指定的战绩文件；未设置 ⇒ 状态目录下的默认文件名。
 * @param {string} stateRoot
 * @param {Record<string, string|undefined>} [env]
 */
export const recordsFileFromEnv = (stateRoot, env = process.env) => (env.SP_RECORDS_FILE
  ? path.resolve(env.SP_RECORDS_FILE)
  : path.join(stateRoot, 'match-records.jsonl'));

/** 账号库的默认位置（没有单独的环境变量：口令库不该被一条运维开关指到临时目录去）。 */
export const accountsFileFor = (stateRoot) => path.join(stateRoot, 'accounts.json');

/**
 * 解析出这一进程的账号/战绩配置。`startServer` 的显式选项**优先于**环境变量，因为测试用它注入，而一套跑在 CI
 * 上的测试不该随 shell 环境变形。
 * @param {{ accounts?: boolean, accountsFile?: string, recordsFile?: string }} opts
 * @param {string} stateRoot
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: boolean, accountsFile: string, recordsFile: string }}
 */
export function resolveAccountConfig(opts, stateRoot, env = process.env) {
  const enabled = opts.accounts === undefined ? accountsEnabledFromEnv(env) : !!opts.accounts;
  return {
    enabled,
    accountsFile: opts.accountsFile !== undefined ? opts.accountsFile : accountsFileFor(stateRoot),
    recordsFile: opts.recordsFile !== undefined ? opts.recordsFile : recordsFileFromEnv(stateRoot, env),
  };
}
