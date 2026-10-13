// 大厅深链的解析（B 方案 · 2026-10-13）：从 screens/lobby.js 抽出来单独放。
//
// 为什么单独一个文件：`DEFAULT_DIFFICULTY` 与 `parsePlaytestParam` 有两个**外部**使用面 ——
// screens/playtestLink.js 与 test/playtestLink.test.js 都从 `screens/lobby.js` 导入它们（main.js 静态
// import playtestLink.js，链接一旦断掉整个客户端白屏）。lobby.js 正按 ui-hub 包的结构与观感逐段并进来，
// 把这两个符号放进自己的文件，等于给「链接面」上保险：改 lobby.js 的观感碰不到它。
//
// 反向约束：本文件不许 import screens/lobby.js —— 那会把环引回来（lobby.js 要 import 本文件）。
// 真正的依赖只有 shared/constants.js 的 DIFFICULTIES（`?difficulty=` 只接受协议认得的键）。
//
// 来源说明：包 `ui-hub-package-20261013` 的 payload/public/js/screens/lobby.js 里这两个符号是 **0 处**
// （整份装包会白屏的原因之一）。所以它们不是包版内容，是本仓库自己的判据，必须留在导出面上。
import { DIFFICULTIES } from '../../../shared/constants.js';

/** The lobby's normal default difficulty (no saved preference): what `?playtest=` without a usable key falls back to. */
export const DEFAULT_DIFFICULTY = 'FUNNY';

/**
 * One-click playtest from a deep link (`?playtest=1[&difficulty=KEY]`, the Forge 一键试玩 button).
 * Any non-empty value other than `0` / `false` turns it on, so `?playtest=1`, `?playtest=true` and a bare `?playtest=`
 * with no value never crash. The difficulty is validated against the shared DIFFICULTIES list: anything unknown
 * (a stale bookmark, a hand-edited URL) falls back to the lobby's own default — an invalid key must never reach the
 * server, where `room.create` answers with BAD_MSG instead of a match.
 * @param {string} search e.g. location.search
 * @returns {{ mode: 'solo', difficulty: string }|null} null = no playtest requested; `difficulty` is always valid
 */
export function parsePlaytestParam(search) {
  try {
    const p = new URLSearchParams(search || '');
    const raw = p.get('playtest');
    if (raw == null) return null;
    if (['', '0', 'false'].includes(String(raw).trim().toLowerCase())) return null;
    const want = String(p.get('difficulty') || '').trim().toUpperCase();
    return { mode: 'solo', difficulty: DIFFICULTIES.includes(want) ? want : DEFAULT_DIFFICULTY };
  } catch {
    return null;
  }
}
