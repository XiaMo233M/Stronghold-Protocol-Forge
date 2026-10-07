// editor/ui/packPicker.js — 「保存到哪个工坊包」的下拉，以及「新工坊包的 id」那个内联输入框。
//
// 起因：五个页面此前都用同一个 `window.prompt` 问包 id（还带一个默认值 `my-item-pack` 之类）。问题不是难看，
// 而是**每次保存都在问一个它能自己知道的事**：包里已经有工坊包了，页面上却看不见，只能靠对话框里手打 id，
// 打错就是新建一个空包（或存到别的包去）。
//
// 现在：页面侧栏常驻一个下拉，列出所有包（id + 名字）；要新建就**在原地展开一个输入框**。
// 原生 prompt 在这里有三个硬伤，所以一条也不留：它不受编辑器语言控制（中文界面照样弹中文、切了英文也不变）、
// 它没法校验（id 打错、撞上已有的包都只能等保存时才报），而且它会冻结整页渲染 —— 输入框长在页面里就没有这三条。
//
// 三条容易踩的线：
//   · 选项里会把「当前值」补进去 —— 它可能是一个还没有落盘的 id（刚在下面输入框里新建的），
//     不补的话 select 会静默跳到第一项，作者以为存到新包、实际存进了旧包。
//   · 展开/收起会重画这一个容器，所以要用 renderKeepingFocus 包着画（否则刚敲一个字就丢焦点，见 focusKeep.js）。
//   · 表单只问 id、**不建包**：工坊包由第一次保存记录时服务端建，所以「选中一个还不存在的 id」是正常状态。
import { t } from './i18n.js';
import { renderKeepingFocus } from './focusKeep.js';

/** 与 editor/server.mjs 的 PACK_ID_RE 同一条规则（那里是唯一权威，这里只是提前说，不是第二套定义）。 */
const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * 校验一个工坊包 id。纯函数：界面拿它做即时提示，也让「什么算合法」只有一份。
 * @param {string} id 候选 id（函数自己会 trim）
 * @param {Array<{id:string}>} packs 已存在的包，用来挡重名
 * @returns {{ ok: true, id: string } | { ok: false, code: 'empty'|'shape'|'dup', error: string }}
 */
export function packIdCheck(id, packs) {
  const value = String(id ?? '').trim();
  if (!value) return { ok: false, code: 'empty', error: t('包 id 不能为空。') };
  if (!PACK_ID_RE.test(value)) return { ok: false, code: 'shape', error: t('包 id 只能是字母、数字、下划线、短横线，1–32 位，且以字母或数字开头。') };
  if ((Array.isArray(packs) ? packs : []).some((p) => p && p.id === value)) {
    return { ok: false, code: 'dup', error: t('已经有叫 {0} 的工坊包了：换一个 id，或者取消后在上面的下拉里直接选它。', value) };
  }
  return { ok: true, id: value };
}

/**
 * 原地展开的「新工坊包 id」输入框。
 *
 * @param {object} o
 * @param {Array<{id:string}>} o.packs 已存在的包（用来挡重名）
 * @param {string} [o.defaultValue] 打开时的预填值
 * @param {string} [o.confirmLabel] 确认按钮的文案（默认 t('确认')）
 * @param {(id:string) => void} o.onConfirm 通过校验后回调一次
 * @param {() => void} [o.onCancel] 取消时回调；不给就什么都不做（调用方通常自己把它从 DOM 里摘掉）
 * @param {() => void} [o.rerender] 调用方重画自己那一块的函数。给了它：校验失败与取消之后由调用方重画
 *   （即本表单被重建、输入框保留已输入的值）；不给就只重画本表单自己
 * @returns {HTMLElement}
 */
export function packIdForm({ packs, defaultValue = '', confirmLabel, onConfirm, onCancel, rerender }) {
  const box = document.createElement('div');
  box.className = 'packNewForm';
  let value = String(defaultValue ?? '');
  let error = null;   // 只在「点了确认但没通过」时才有值：边打字边报红是在骂人，不是提示

  /** 展开后把光标放进输入框：不用先点一下就能打字。
   *  必须推迟到当前点击/change 处理完之后 —— 浏览器的默认行为是「点哪儿焦点就在哪儿」（按钮、select），
   *  同步调用会被它覆盖回去，表现就是「输入框出来了，但敲键盘没反应」。 */
  function focusInput() {
    queueMicrotask(() => {
      const el = box.querySelector?.('.packNewId');
      if (el && typeof el.focus === 'function') { el.focus(); if (typeof el.select === 'function') el.select(); }
    });
  }

  function draw() {
    box.replaceChildren();
    const row = document.createElement('div');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'packNewId';
    input.value = value;
    input.placeholder = 'my-workshop-pack';
    input.title = t('包 id 只能是字母、数字、下划线、短横线，1–32 位，且以字母或数字开头。');
    input.addEventListener('input', () => {
      value = input.value;
      if (error) { error = null; draw(); }   // 改了就先把上一条错误收掉，下一次确认再重新判
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = confirmLabel ?? t('确认');
    ok.addEventListener('click', confirm);

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'ghost';
    no.textContent = t('取消');
    no.addEventListener('click', cancel);

    row.append(input, ok, no);
    box.append(row);
    // 就地报错，不用 alert：错误属于这个输入框，弹窗会把它和页面上的其它信息割开
    if (error) box.append(Object.assign(document.createElement('div'), { className: 'err', textContent: error }));
  }

  function confirm() {
    const r = packIdCheck(value, packs);
    if (!r.ok) {
      error = r.error;
      if (rerender) rerender(); else { draw(); focusInput(); }
      return;
    }
    error = null;
    if (rerender) rerender();
    onConfirm(r.id);
  }

  function cancel() {
    if (onCancel) { onCancel(); return; }
    if (rerender) { rerender(); return; }
    // 没人负责收起它：把错误清掉重画一次，输入框留着（作者可能只是想改一下再确认）
    error = null; draw(); focusInput();
  }

  draw();
  focusInput();
  return box;
}

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
 * 建一个下拉容器：一个常驻的 <select>；选「新建」时在它下面展开 packIdForm，展开时才 append，选择框不会跳位。
 *
 * @param {object} o
 * @param {Array<{id:string,name?:string}>} o.packs
 * @param {string|null} o.current
 * @param {string} [o.newLabel] 「新建」那一项的文案
 * @param {string} [o.newDefault] 展开输入框时的预填值（各页原来 prompt 里的默认值，例如 'my-item-pack'）
 * @param {(id:string) => void} o.onPick 选中一个包 id（已有的、或刚在输入框里输入的）时回调一次。
 *   一个**还不存在的 id** 也会走到这里 —— 工坊包由第一次保存创建，「先选中它、保存时才建」是原本就有的行为。
 * @param {(id:string|null) => void} [o.askNewId] 旧接口，只为兼容：给了它又没有 onPick 时，新建走这条同步回调。
 * @returns {HTMLElement} 容器（不是裸 <select> —— 调用方 append 这个容器即可）
 */
export function packSelect({ packs, current, newLabel, newDefault = '', onPick, askNewId }) {
  const box = document.createElement('div');
  box.className = 'packSelect';
  const NEW = '__new__';
  const opts = packOptions(packs, current, { newLabel, newValue: NEW });
  // 在这次下拉里真的新建过的包：服务端清单里还没有它们，但选择框里得有，否则它停在一个看不见的值上
  const created = [];
  let form = null;   // 展开中的表单；null = 没展开

  /** 兜底落在**显示出来的**第一个包上（选项按 id 排过序，不能拿原始清单的首项，否则默认值与眼睛看到的第一项不一致） */
  function fallback() {
    return opts.find((o) => o.value !== NEW)?.value ?? NEW;
  }

  function draw() {
    box.replaceChildren();
    const sel = document.createElement('select');
    sel.className = 'packSelectSel';
    let newOpt = null;   // 「＋ 新建…」那一项：新建出来的包要插在它前面，所以得留着它的引用
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      sel.append(opt);
      if (o.value === NEW) newOpt = opt;
    }
    for (const c of created) {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id;
      if (newOpt) sel.insertBefore(opt, newOpt); else sel.append(opt);
    }
    sel.value = created.length ? created[created.length - 1].id : (current && current !== '' ? current : fallback());
    sel.addEventListener('change', () => {
      if (sel.value !== NEW) { onPick(sel.value); return; }
      // 选「新建」= 原地展开输入框；取消就退回原来的选择（不能停在一个并不存在的值上）
      form = packIdForm({
        packs: [...(Array.isArray(packs) ? packs : []), ...created],
        // 预填值先说「要新建的那类包」（各页原来 prompt 里的默认值），其次才是当前选中的包
        defaultValue: created.length ? created[created.length - 1].id : (newDefault || current || ''),
        onConfirm: (id) => {
          created.push({ id });
          form = null;
          renderKeepingFocus(box, draw);
          if (onPick) onPick(id);
          else askNewId?.(id);
        },
        onCancel: () => { form = null; renderKeepingFocus(box, draw); },
      });
      // 只重画这一个容器（不是整页），表单由 draw 接在选择框后面 —— 这里不能再 append 一次，否则会画出两个
      renderKeepingFocus(box, draw);
    });
    box.append(sel);
    // 表单接在选择框后面（原地展开在它下面，选择框本身不会因为展开而跳位）
    if (form) box.append(form);
  }

  renderKeepingFocus(box, draw);
  return box;
}
