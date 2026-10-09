// shared/recordDiff.js — 覆盖模式的「差异预览」：拿官方原文与将要写出的记录比，列出真正会变的那些路径。
//
// 为什么这件事值得有自己一份实现（而不是在界面里顺手 JSON.stringify 两次）：
//   * 覆盖模式要在**保存之前**回答「我到底改了什么」。官方记录 40+ 字段，作者改了其中两个 —— 一眼看不出是哪两个，
//     而看漏一个的代价可能是「官方的一整条潜能链没了」。
//   * 它必须与加载器的判罚**同一套口径**：比的是「官方原文 vs 将要写出去的那条记录」，不是「表单 vs 默认值」。
//     两边口径不同的差异预览会撒谎。
//   * 它是纯函数（不碰 DOM、不碰网络），所以可以在 node 里直接测 —— 界面上那段只是把它画出来。
//
// 只列**叶子路径**（`stats.atk` 而不是 `stats`）：官方 44 字段里绝大多数是嵌套的普通对象，报顶层名字等于什么都没说。
// 整条替换的键（`skill` / `talents` …）仍然按叶子展开 —— 作者想看的是「哪个数变了」，不是「哪一块被换了」。

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 把一条记录摊平成 `路径 → 值`。数组按下标展开（`talents[0].desc`），普通对象递归，其余是叶子。
 * 空对象 / 空数组本身也是一条叶子（`bonds: []` 与「没有这个键」是两件不同的事）。
 * @param {unknown} value
 * @param {string} [prefix]
 * @param {Map<string, unknown>} [out]
 * @returns {Map<string, unknown>}
 */
export function flattenRecord(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (!value.length) out.set(prefix, value);
    else value.forEach((v, i) => flattenRecord(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (isPlainObj(value)) {
    const keys = Object.keys(value);
    if (!keys.length) out.set(prefix, value);
    else for (const k of keys) flattenRecord(value[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.set(prefix, value);
  return out;
}

/**
 * 一个值画成一行短文本（对象 / 数组用 JSON；字符串截断，免得一条长文案占满屏幕）。
 *
 * `undefined`（「官方 / 作者那一边根本没有这个字段」）返回 `null`，**由调用方决定怎么显示** ——
 * 这一层不写中文：`shared/` 是公共层（`test/i18n.test.js` 要求其中的中文都走 `t()`，而这里没有 `t`）。
 * 界面那一边把它画成「（没有这个字段）」并顺手翻译。
 * @param {unknown} v @param {number} [limit]
 * @returns {string|null}
 */
export function shortValue(v, limit = 60) {
  if (v === undefined) return null;
  let text;
  if (typeof v === 'string') text = JSON.stringify(v);
  else if (v === null) text = 'null';
  else if (typeof v === 'object') text = JSON.stringify(v);
  else text = String(v);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * 官方原文 → 将要写出的记录：逐条列出会变的叶子路径。
 *
 * `changed: false` 表示两者一模一样（作者还没改任何东西）。`truncated` 表示变化条数超过 `limit`（列表被截短，
 * 不是「只有这些」）—— 界面必须把这件事说出来，否则作者会以为它看全了。
 *
 * @param {object} official 官方原文（只读端点回的 `official`，或任何「现在长这样」的记录）
 * @param {object} written 将要写出去的记录
 * @param {{ limit?: number }} [opts]
 * @returns {{ changes: Array<{ path: string, from: unknown, to: unknown }>, changed: boolean, total: number, truncated: boolean }}
 */
export function diffRecords(official, written, { limit = 200 } = {}) {
  const a = flattenRecord(official);
  const b = flattenRecord(written);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const changes = [];
  for (const path of paths) {
    const from = a.get(path);
    const to = b.get(path);
    // `JSON.stringify` 比 `===` 诚实：对象 / 数组即使内容相同也不是同一个引用。
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ path, from, to });
  }
  const total = changes.length;
  return { changes: changes.slice(0, limit), changed: total > 0, total, truncated: total > limit };
}
