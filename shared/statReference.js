// shared/statReference.js — 数值参照：把官方数据里「同类」内容的数值区间算出来，给编辑器当尺子。
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
//
// 要解决的问题很具体：作者新建一个干员/怪物时，表单里的 1400 生命、450 攻击是他自己拍的数，
// 没有任何参照。文档里有平衡说明，但没人一边填表一边翻文档。这里把官方 266 个干员 / 249 只怪物的
// 数值按「职业」/「档位」分组算成 min / 中位 / max，页面就能在输入框旁边直接告诉他：
// 「突击（WARRIOR）5 阶：生命 1200–2600，中位 1800；你填了 9000」。
//
// 只做纯计算：不读文件、不认识具体的记录结构——分组与取值都由调用方给，所以干员与怪物共用同一份实现，
// 也就能用假数据测全边界（空组、单元素、偶数元素的中位、非数字的脏值）。

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 一组数的 min / 中位 / max。非数字（含 undefined / null / NaN / 字符串）一律忽略。
 * @param {Array<number>} values
 * @returns {{min:number, p50:number, max:number, count:number}|null} 一个有效值都没有时返回 null
 */
export function statSummary(values) {
  const nums = (Array.isArray(values) ? values : []).filter(isFin).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  const p50 = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return { min: nums[0], p50, max: nums[nums.length - 1], count: nums.length };
}

/**
 * 按分组统计若干数值字段的区间。
 *
 * @param {Array<any>} items 官方记录列表
 * @param {object} o
 * @param {(item:any)=>string} o.groupOf 分组键（干员用职业，怪物用档位）
 * @param {(item:any, field:string)=>any} o.valueOf 取某个字段的数值
 * @param {string[]} o.fields 要统计的字段名
 * @param {string} [o.otherGroup] 分组键为空时的归属（默认不统计这一条）
 * @returns {Record<string, Record<string, {min:number,p50:number,max:number,count:number}>>}
 */
export function statReference(items, { groupOf, valueOf, fields, otherGroup }) {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    const group = groupOf(item) || otherGroup;
    if (!group) continue;
    const bucket = (out[group] ??= {});
    for (const field of fields) {
      const v = valueOf(item, field);
      if (!isFin(v)) continue;
      (bucket[field] ??= []).push(v);
    }
  }
  const done = {};
  for (const [group, bucket] of Object.entries(out)) {
    done[group] = {};
    for (const [field, values] of Object.entries(bucket)) {
      const s = statSummary(values);
      if (s) done[group][field] = s;
    }
  }
  return done;
}

/**
 * 一个数值落在参照区间里的位置，给页面画成一条刻度（0 = 最小，1 = 最大，超出则封顶并在文案里说明）。
 * @param {number} value
 * @param {{min:number,p50:number,max:number}} ref
 * @returns {{ratio:number, aboveMax:boolean, belowMin:boolean}|null}
 */
export function statPosition(value, ref) {
  if (!isFin(value) || !ref || !isFin(ref.min) || !isFin(ref.max)) return null;
  if (ref.max === ref.min) return { ratio: 0.5, aboveMax: value > ref.max, belowMin: value < ref.min };
  const ratio = Math.min(1, Math.max(0, (value - ref.min) / (ref.max - ref.min)));
  return { ratio, aboveMax: value > ref.max, belowMin: value < ref.min };
}
