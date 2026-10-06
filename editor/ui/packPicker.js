// editor/ui/packPicker.js — 「保存到哪个工坊包」的下拉。
//
// 起因：五个页面此前都用同一个 `window.prompt` 问包 id（还带一个默认值 `my-item-pack` 之类）。问题不是难看，
// 而是**每次保存都在问一个它能自己知道的事**：包里已经有工坊包了，页面上却看不见，只能靠对话框里手打 id，
// 打错就是新建一个空包（或存到别的包去）。
//
// 现在：页面侧栏常驻一个下拉，列出所有包（id + 名字）；要新建才走一次 prompt（那一步确实只能问）。
// 选项里会把「当前值」补进去 —— 它可能是一个还没有落盘的 id（刚点了「新建一个包」），
// 不补的话 select 会静默跳到第一项，作者以为存到新包、实际存进了旧包。

/**
 * 下拉的选项。纯逻辑：给定包清单与当前值，返回 `[{ value, label }]`（最后一项是「新建」）。
 * @param {Array<{id:string,name?:string}>} packs
 * @param {string|null} current
 * @param {{ newLabel?: string, newValue?: string }} [opts]
 */
export function packOptions(packs, current, opts = {}) {
  const newValue = opts.newValue ?? '__new__';
  const list = (Array.isArray(packs) ? packs : [])
    .filter((p) => p && typeof p.id === 'string' && p.id)
    .map((p) => ({ value: p.id, label: p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id }))
    .sort((a, b) => a.value.localeCompare(b.value));
  const cur = typeof current === 'string' && current ? current : null;
  if (cur && !list.some((o) => o.value === cur)) list.push({ value: cur, label: cur });
  list.push({ value: newValue, label: opts.newLabel ?? '＋ 新建一个包…' });
  return list;
}

/**
 * 建一个下拉元素。
 * @param {object} o
 * @param {Array<{id:string,name?:string}>} o.packs
 * @param {string|null} o.current
 * @param {string} o.newLabel
 * @param {(id:string|null) => void} o.onPick 选中已有包时回调（新建走 askNewId）
 * @param {() => string|null} o.askNewId 需要新建时问一次；返回 null 表示取消
 */
export function packSelect({ packs, current, newLabel, onPick, askNewId }) {
  const sel = document.createElement('select');
  const NEW = '__new__';
  const opts = packOptions(packs, current, { newLabel, newValue: NEW });
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    sel.append(opt);
  }
  // 兜底落在**显示出来的**第一个包上（选项是按 id 排过序的，不能拿原始清单的首项，否则默认值与眼睛看到的第一项不一致）
  const firstReal = opts.find((o) => o.value !== NEW)?.value ?? NEW;
  sel.value = current && current !== '' ? current : firstReal;
  sel.addEventListener('change', () => {
    if (sel.value === NEW) {
      const id = askNewId?.();
      if (!id) { sel.value = current ?? firstReal; return; }
      onPick(String(id).trim());
      return;
    }
    onPick(sel.value);
  });
  return sel;
}
