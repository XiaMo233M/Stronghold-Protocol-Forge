// editor/ui/focusKeep.js — 重画一段表单，但把焦点与光标留在原处。
//
// 为什么需要它：表单的校验是「防抖自动跑」的，每跑一次就重画一次 DOM。重画会把用户正在打字的输入框
// 换成新元素，光标随之消失——表现就是「打一半停下来看一眼，再打字就得重新点一下」。
// 干员页（每 250ms 校验一次）与怪物页（搜索框每敲一个字重画列表）都需要这条。

/**
 * @param {ParentNode} container 要重画的那块容器
 * @param {() => void} render 真正重画的函数
 */
export function renderKeepingFocus(container, render) {
  if (!container || typeof container.querySelectorAll !== 'function') { render(); return; }
  const before = [...container.querySelectorAll('input, select, textarea')];
  const active = globalThis.document?.activeElement ?? null;
  const idx = before.indexOf(active);
  const start = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const end = active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
  render();
  if (idx < 0) return;
  const after = [...container.querySelectorAll('input, select, textarea')];
  const next = after[idx];
  if (!next || typeof next.focus !== 'function') return;
  next.focus();
  if (start !== null && typeof next.setSelectionRange === 'function') {
    try { next.setSelectionRange(start, end); } catch { /* number 输入框不支持选区，忽略 */ }
  }
}
