// editor/ui/statScale.js — 数值显示与「参照尺子」，干员页与怪物页共用。
//
// 刻度换算是 shared/statReference.js 里那一份（编辑器服务端把 /shared/ 也挂给了界面，浏览器与 node 解析到同一个文件），
// 这里只加两样界面相关的东西：数字的显示格式，以及把尺子画出来（DOM 由调用方传进来的 h 构造，所以这个模块不依赖任何页面）。

import { statPosition } from '../../shared/statReference.js';

/** 数值显示：整数不带小数点，小数最多一位（尺子上不需要更多精度）。 */
export const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/**
 * 当前值落在参照区间的哪里。
 * @param {number} value
 * @param {{min:number,p50:number,max:number}} [ref]
 * @returns {{ratio:number, where:'below'|'in'|'above', ref:{min:number,p50:number,max:number}}|null}
 */
export function statRefView(value, ref) {
  const pos = statPosition(value, ref);
  if (!pos) return null;
  return {
    ratio: pos.ratio,
    where: pos.belowMin ? 'below' : (pos.aboveMax ? 'above' : 'in'),
    ref: { min: ref.min, p50: ref.p50, max: ref.max },
  };
}

/**
 * 做一根尺子：官方同类的区间 + 当前值落点，越界时变色并写明。
 *
 * 作者填数值时本来毫无参照（干员页填 1400 生命、怪物页填 1000 生命都是拍出来的），这把尺子让他一眼看出
 * 自己是不是捏了个超模的东西。传 h 与 t 进来，是为了让这个模块不绑死任何一个页面的 DOM helper。
 *
 * @param {(tag:string, attrs?:object, ...kids:any[]) => any} h 页面自己的元素构造助手
 * @param {(zh:string, ...args:any[]) => string} t 页面的翻译函数
 * @returns {(value:number, ref:object|undefined) => any|null}
 */
export function makeStatBar(h, t) {
  return (value, ref) => {
    const view = statRefView(value, ref);
    if (!view) return null;
    const beyond = view.where !== 'in';
    return h('div', { style: 'margin-top:3px' },
      h('div', { style: 'position:relative;height:4px;background:#12141a;border:1px solid var(--line);border-radius:3px' },
        h('div', { style: `position:absolute;left:${(view.ratio * 100).toFixed(1)}%;top:-3px;width:2px;height:8px;background:${beyond ? 'var(--warn)' : 'var(--acc)'}` })),
      h('div', { class: `hint${beyond ? ' warn' : ''}`, style: 'font-size:11px' },
        t('官方区间 {0}–{1}（中位 {2}）', fmtNum(view.ref.min), fmtNum(view.ref.max), fmtNum(view.ref.p50)),
        view.where === 'above' ? ` · ${t('高于官方上限')}` : view.where === 'below' ? ` · ${t('低于官方下限')}` : ''));
  };
}
