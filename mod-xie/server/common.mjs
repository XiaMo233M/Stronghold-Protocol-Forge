// mod-xie/server/common.js — 包自带的最小公共件。
//
// v1（自研安装器版）从引擎 import 了四样：`shared/constants.js` 的 PHASE / ERR、`shared/i18n.js` 的 msg、
// `server/sim/rng.js` 的 createRng / deriveSeed。**工坊包不能 import 引擎内部**（那会让「装到别人树上」这件事
// 依赖引擎的文件布局，也正是本层存在的理由所反对的形态）—— 所以这四样随包走：
//   * PHASE / ERR 是**协议与判据的字面量**，值与引擎逐字相同（ERR 码只出现在答复里，PHASE 只用于比较）；
//   * msg 是本 MOD 自己的文案函数（文案随包走，界面上的面板读同一批字符串）；
//   * createRng / deriveSeed 是**确定性**替身（mulberry32 + 一次字符串混合），替掉引擎的 rng 只是为了不依赖它，
//     用途不变（bot 的借贷意愿、阵亡分红的掷骰）—— 同一 seed 在同一对局里得到同一串结果。
//
// 三个 v1 的导出（FLOW_TICKER_PRIORITY / OK / fail）原样保留：它们是 fork 从上游 match/match/common.js 抄来的
// 三行，抄比 import 更稳（上游可以自由搬它）。

export const FLOW_TICKER_PRIORITY = 25;
export const OK = Object.freeze({ ok: true });
export const fail = (error, detail) => (detail ? { error, detail } : { error });

/** 只用到的两个阶段名（与引擎的 PHASE 值逐字相同；这里只做比较，不上线）。 */
export const PHASE = Object.freeze({ PREP: 'PREP', SETTLE: 'SETTLE' });

/** 只用到的错误码（值即引擎的 ERR 码字面量 —— 它们会出现在答复里，客户端认识）。 */
export const ERR = Object.freeze({
  WRONG_PHASE: 'WRONG_PHASE',
  BAD_TARGET: 'BAD_TARGET',
  ALREADY: 'ALREADY',
  NO_FUNDS: 'NO_FUNDS',
  ELIMINATED: 'ELIMINATED',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  MAX_LEVEL: 'MAX_LEVEL',
  BAD_MSG: 'BAD_MSG',
});

/** MOD 自己的文案函数：`{name}` 占位替换（v1 用引擎的 i18n；包化后字符串随包走）。 */
export function msg(text, params = null) {
  let out = String(text);
  if (params) for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** 一个确定性的 32 位种子：`<match seed>:<salt>` 的 FNV-1a。 */
export function deriveSeed(seed, salt) {
  const s = `${seed >>> 0}:${salt}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 确定性随机流（mulberry32）：`int(n)` 给 `[0, n)` 的整数。没有 `Math.random`、没有时钟 —— 与引擎对战斗代码的
 * 确定性要求同一条纪律（同一 seed、同一调用序列 ⇒ 同一结果）。
 */
export function createRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.freeze({
    next,
    int(n) {
      const m = Math.max(1, Math.floor(Number(n) || 1));
      return Math.floor(next() * m);
    },
  });
}
