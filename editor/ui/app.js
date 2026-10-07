// editor/ui/app.js — the workshop editor's front end. Plain DOM, native ES modules, no build step, no dependency on
// the game client (which never loads this file). It talks to editor/server.mjs and, through it, to the SAME
// shared/chessAuthoring.js the CLIs and an AI use — so the editor cannot drift from the validator.
//
// 界面文案走 i18n：t('中文原文') 查英文词典，查不到就原样返回中文（editor/ui/i18n.js 说明了这个取舍）。

import { t, mountI18n, currentLang } from './i18n.js';
// 服务端把 /shared/ 也挂给了编辑器界面，所以这几个模块在浏览器与 node 下是同一个文件：
// 范围与伤害分类的推导规则只有一份（shared/chessAuthoring.js），界面显示的就是引擎真正会用的那份。
import {
  classify, DEFAULT_MELEE_RANGE, DEFAULT_RANGED_RANGE,
  PROFESSION_NAMES, POSITION_NAMES, DMG_TYPES, ATTACK_KINDS, PROJECTILES, MODULE_ATTR_KEYS,
} from '../../shared/chessAuthoring.js';
// 精锐数值 = 不带模组的数值 + 默认模组的 attr —— 这句算术也只有一份（shared/loadoutRecord.js），
// 所以界面上「加了模组之后是多少」的提示与引擎算出来的必然一致。
import { composeStats } from '../../shared/loadoutRecord.js';
import {
  matchOperators, idConflict, renameNotice,
  subProfessionChoices, subProfessionOptions, subProfessionOptionsFor, professionsOfSub, bondChoicesOf,
  rangePresets, gridKey, gridMatrix, gridKeySet, sortGrid, toggleGridCell, outsidePainterCount,
  PAINTER_COLS, PAINTER_ROWS, painterCellAt,
} from './operatorWizard.js';
import { fmtNum, makeStatBar } from './statScale.js';
import { renderKeepingFocus } from './focusKeep.js';
// spine 判定的同一条规则：出怪页与干员页共用一个纯函数（填错不会报错的字段，两页都要当场说话）
import { spineIsKnown } from './enemyWizard.js';

const $ = (sel) => document.querySelector(sel);

/** Tiny DOM helper: h('div', {class:'x', onclick:fn}, child, child…) */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** 服务端的报错文案是中文，命中词典就翻（带插值的原文命中不了，原样显示）。 */
const errText = (e) => t(e?.message ?? String(e));

/** 数值尺子（干员与怪物共用同一份实现，见 statScale.js）。 */
const statBar = makeStatBar(h, t);

const state = {
  data: null, packId: null, slug: null, spec: null, preview: null, message: null, busy: false,
  // 「以模板新建」的选择器是否打开，以及搜索串
  picking: false, pickQuery: '',
  // 盟约清单的搜索串（只重画清单那一块，别整页重画）
  bondQuery: '',
  // 哪些「自己画范围」的画板是打开的（key → true）。它是界面状态，不进 spec，但必须留在重画之外 ——
  // 否则每 250ms 一次自动校验就会把刚展开的画板收回去。
  painters: {},
  // 折叠的分段（见 section()）：只记「作者手动改过」的那些，没记过的用该分段的默认值。
  sections: {},
};

// ---- the spec model ----------------------------------------------------------------------------------------------

// The professions the DATA uses: 重装 TANK / 先锋 PIONEER / 特种 SPECIAL — NOT the global Arknights names.
// Mirrors shared/chessAuthoring.js PROFESSIONS, which test/chessAuthoring.test.js pins to data/chess.json.
const PROFESSIONS = ['WARRIOR', 'SNIPER', 'CASTER', 'MEDIC', 'SUPPORT', 'TANK', 'SPECIAL', 'PIONEER'];
const SKILL_TYPES = ['MANUAL', 'AUTO', 'PASSIVE'];
const DURATION_TYPES = ['NONE', 'AMMO'];
const SP_TYPES = ['INCREASE_WITH_TIME', 'INCREASE_WHEN_ATTACK', 'INCREASE_WHEN_TAKEN_DAMAGE', 'ON_DEPLOY'];
// 必须与 shared/chessAuthoring.js 的 TRIGGER_RULES 一致：少一个枚举，打开已有该值的 spec 时下拉会显示成
// DEFAULT，用户随手一改就把人家的 CUSTOM_RANGE 覆盖掉了（静默改数据）。test/editorI18n.test.js 之外的
// test/editor.test.js 会核对这份清单与 shared 的导出。
const TRIGGERS = ['DEFAULT', 'TAKE_DAMAGE', 'SKILL_RANGE', 'SP_FULL', 'SEARCH', 'CUSTOM_RANGE'];

/** A fresh spec, optionally seeded from an official operator (same tier/profession/numbers as a starting point). */
function blankSpec(seed) {
  const stats = (mul) => ({
    maxHp: Math.round((seed?.maxHp ?? 1400) * mul), atk: Math.round((seed?.atk ?? 450) * mul), def: seed?.def ?? 140,
    res: seed?.res ?? 0, cost: seed?.cost ?? 18, blockCnt: seed?.blockCnt ?? 1, bat: seed?.bat ?? 1.2,
  });
  return {
    id: '', name: '', appellation: '', tier: seed?.tier ?? 5,
    profession: seed?.profession ?? 'SNIPER', subProfessionId: seed?.subProfessionId ?? '', position: seed?.position ?? 'RANGED',
    traitDesc: '', assetsSpine: seed?.spine ?? '',
    stats: { normal: stats(1), golden: stats(1.3) },
    skill: {
      name: '', desc: '', skillType: 'MANUAL', durationType: 'AMMO', spType: 'INCREASE_WITH_TIME',
      spCost: 30, initSp: 10, maxChargeTime: 1, duration: 0, triggerRule: 'DEFAULT', bb: { atk: 0.5, atk_scale: 1.5, trigger_time: 8 },
    },
    talents: [],
  };
}

// ---- rendering ---------------------------------------------------------------------------------------------------

function renderShell() {
  $('#rootPath').textContent = state.data?.workshopRoot ?? '';
  renderPacks();
  renderOps();
  renderEditor();
}

function renderPacks() {
  const box = $('#packList');
  box.replaceChildren();
  if (!state.data) return;
  if (!state.data.packs.length) box.append(h('div', { class: 'item' }, h('div', { class: 'm' }, t('（还没有工坊包）'))));
  for (const pack of state.data.packs) {
    box.append(h('div', {
      class: `item${pack.id === state.packId ? ' on' : ''}`,
      onclick: () => { state.packId = pack.id; state.slug = null; state.spec = null; state.preview = null; state.message = null; renderShell(); },
    },
    h('div', { class: 'n' }, pack.manifest?.name || pack.id),
    h('div', { class: 'm' }, t('{0} 条记录 · {1} 个可编辑', pack.operators.length, pack.specs.length),
      pack.operators.some((o) => o.issues.some((i) => i.severity === 'error')) ? h('span', { class: 'tag err' }, t('有错误')) : null)));
  }
}

function renderOps() {
  const box = $('#opList');
  box.replaceChildren();
  const pack = state.data?.packs.find((p) => p.id === state.packId);
  if (!pack) { box.append(h('div', { class: 'item' }, h('div', { class: 'm' }, t('先在左边选一个工坊包')))); return; }
  box.append(h('div', {
    class: 'item',
    onclick: () => { state.slug = null; state.spec = blankSpec(); state.preview = null; state.picking = false; renderShell(); },
  }, h('div', { class: 'n ok' }, t('＋ 新建干员')), h('div', { class: 'm' }, t('从空白表单开始'))));
  // 「以模板新建」是省事的那条路：官方的数值、分支、攻击范围、技能、天赋与外观一次填好，改个 id 与名字就能用。
  box.append(h('div', {
    class: `item${state.picking ? ' on' : ''}`,
    onclick: () => { state.slug = null; state.spec = null; state.preview = null; state.picking = true; state.pickQuery = ''; renderShell(); },
  }, h('div', { class: 'n ok' }, t('⧉ 以模板新建')), h('div', { class: 'm' }, t('复制一个现成干员的数值、范围、技能与外观'))));
  for (const spec of pack.specs) {
    const base = pack.operators.find((o) => o.name && !o.isGolden && o.chessId.endsWith('_a') && o.chessId.includes(spec.id));
    const errs = pack.operators.filter((o) => o.chessId.includes(spec.id)).reduce((n, o) => n + o.issues.filter((i) => i.severity === 'error').length, 0);
    box.append(h('div', {
      class: `item${spec.id === state.slug ? ' on' : ''}`,
      onclick: () => { state.slug = spec.id; state.spec = JSON.parse(JSON.stringify(spec)); state.preview = null; state.message = null; renderShell(); previewSoon(); },
    },
    h('div', { class: 'n' }, spec.name || spec.id),
    h('div', { class: 'm' }, t('id {0} · {1} 阶 · {2}', spec.id, spec.tier, spec.profession),
      errs ? h('span', { class: 'tag err' }, t('{0} 个错误', errs)) : h('span', { class: 'tag ok' }, t('可编辑')))));
  }
  for (const op of pack.operators.filter((o) => !o.managed && !o.isGolden)) {
    box.append(h('div', { class: 'item', title: t('由 CLI 或手工写入，没有 spec，编辑器不会改动它') },
      h('div', { class: 'n dim' }, op.name || op.chessId),
      h('div', { class: 'm' }, t('非编辑器管理（保留原样）'))));
  }
}

function field(label, input) { return h('div', {}, h('label', { text: label }), input); }
function textInput(get, set, attrs = {}) {
  return h('input', { value: get() ?? '', oninput: (e) => { set(e.target.value); schedulePreview(); }, ...attrs });
}
function numInput(get, set) {
  return h('input', { type: 'number', step: 'any', value: get() ?? 0, oninput: (e) => { const v = Number(e.target.value); set(Number.isFinite(v) ? v : 0); schedulePreview(); } });
}
function select(list, get, set, labelOf) {
  const el = h('select', { onchange: (e) => { set(e.target.value); schedulePreview(); } });
  for (const v of list) el.append(h('option', { value: v, selected: get() === v }, labelOf ? labelOf(v) : v));
  return el;
}

/** 职业与位置名：界面上显示「近卫 WARRIOR」/「Guard WARRIOR」，记录里写的永远是后面那个大写枚举。 */
function nameLabel(table, v) {
  const n = table && table[v];
  return n ? `${currentLang() === 'en' ? n.en : n.zh} ${v}` : v;
}

/**
 * 覆盖型下拉：第一项永远是「用推导值」，其余才是显式覆盖。
 *
 * 攻击分类平时是按职业与分支推出来的，覆盖只是给「同分支但就是不一样」的特殊情况留的接口。所以默认项要在，
 * 而且必须写清推导成了什么 —— 否则作者只会看到一个空下拉，不知道自己放弃了什么。
 */
function overrideSelect(list, get, set, derived, labelOf) {
  const lab = labelOf || ((v) => v);
  const cur = get();
  const el = h('select', { onchange: (e) => { set(e.target.value || null); schedulePreview(); } });
  el.append(h('option', { value: '', selected: cur === undefined || cur === null }, t('（推导：{0}）', lab(derived))));
  for (const v of list) el.append(h('option', { value: v, selected: cur === v }, lab(v)));
  return el;
}

/** `canHitFly` 是布尔：空串与 false 分不开，所以三态用字符串 value 表示。 */
function overrideBoolSelect(get, set, derived) {
  const cur = get();
  const val = cur === undefined || cur === null ? '' : (cur ? 'true' : 'false');
  const el = h('select', { onchange: (e) => { const v = e.target.value; set(v === '' ? null : v === 'true'); schedulePreview(); } });
  el.append(
    h('option', { value: '', selected: val === '' }, t('（推导：{0}）', derived ? t('是') : t('否'))),
    h('option', { value: 'true', selected: val === 'true' }, t('能打空中')),
    h('option', { value: 'false', selected: val === 'false' }, t('不能打空中')));
  return el;
}

/**
 * 改纯文本字段时，把同一个对象上的富文本原文（`descRaw`）一起改掉。
 *
 * 官方记录的 `descRaw` 与 `desc` 常常不同（`<$ba.stun>晕眩</>` 这类标记：数据里 199 条天赋有 56 条不一样），
 * 而派生层**优先读 `descRaw`** —— 只改 `desc` 的话，作者在界面上改了字，记录里一个字都没变（静默失败）。
 * 代价是官方那点富文本标记会被纯文本顶掉，这与「我就是要改这句话」本来就是同一个意思。
 */
function setText(obj, key, value) {
  obj[key] = value;
  const rawKey = `${key}Raw`;
  if (rawKey in obj) obj[rawKey] = value;
}

/** 一个复选框（勾选框的样式在两处都要写成 width:auto，否则会被表单的 input 规则拉满行）。 */
function checkInput(checked, onchange) {
  return h('input', { type: 'checkbox', checked: !!checked, style: 'width:auto', onchange: (e) => onchange(!!e.target.checked) });
}

/**
 * 范围形状下拉：写 `setGrid(grid)`，或 `setGrid(null)` 表示「回到推导」。
 * 普通范围与精锐范围（`rangeGridGolden`）共用这一份实现，只是默认项的文字不同。
 * @param {() => number[][]|undefined} getGrid
 * @param {(grid: number[][]|null) => void} setGrid
 * @param {string} [defaultLabel] 空选项的文字（普通那份是「按职业与分支推导」）
 */
function rangeShapeSelect(getGrid, setGrid, defaultLabel) {
  const presets = rangePresets(state.data.officialChess);
  const cur = getGrid();
  const curKey = Array.isArray(cur) ? gridKey(cur) : '';
  const el = h('select', {
    onchange: (e) => {
      const p = presets.find((x) => x.key === e.target.value);
      setGrid(p ? p.grid.map((c) => [...c]) : null);
      schedulePreview(); renderEditorKeepingFocus();
    },
  }, h('option', { value: '', selected: !curKey }, defaultLabel || t('（默认：按职业与分支推导）')));
  for (const p of presets) el.append(h('option', { value: p.key, selected: curKey === p.key }, t('{0} 格 · 例：{1}', p.count, p.sample.name)));
  return el;
}

/**
 * 黑板书式的键值行：键名可改、值是数字、`×` 删掉、最后一行按钮加一个。
 * 技能 bb、天赋 bb、模组特性覆盖 bb、模组天赋改写 bb 四处都是同一个东西，所以只写一遍。
 * 给了 `keys` 就把键名做成下拉（模组的 `attr` 只认那 8 个键：写错不报错，但数值一点不加）。
 */
function bbRows(holder, obj, redraw, { keys = null, addLabel } = {}) {
  holder.replaceChildren();
  const known = keys ? [...new Set([...keys, ...Object.keys(obj)])] : null;
  for (const [key, val] of Object.entries(obj)) {
    const rename = (to) => { const v = obj[key]; delete obj[key]; obj[to] = v; schedulePreview(); redraw(); };
    // 下拉里不列「别的行已经占了的键」：选重了会把那一行的数值直接顶掉，而界面上看不出发生过什么
    const options = known ? known.filter((k) => k === key || !(k in obj)) : null;
    holder.append(h('div', { class: 'kv' },
      options
        ? h('select', { onchange: (e) => rename(e.target.value) }, options.map((k) => h('option', { value: k, selected: k === key }, k)))
        : h('input', { value: key, onchange: (e) => rename(e.target.value) }),
      h('input', { type: 'number', step: 'any', value: val, oninput: (e) => { obj[key] = Number(e.target.value); schedulePreview(); } }),
      h('button', { class: 'ghost', onclick: () => { delete obj[key]; schedulePreview(); redraw(); } }, '×')));
  }
  const fresh = known ? (known.find((k) => !(k in obj)) ?? known[0]) : 'new_key';
  holder.append(h('button', { class: 'ghost', onclick: () => { obj[fresh] = 0; schedulePreview(); redraw(); } }, addLabel || t('＋ 加一个键')));
}

/** 一个现成的键值行编辑器（返回元素；内部重画只换自己的内容）。 */
function bbEditor(obj, opts) {
  const holder = h('div', {});
  const redraw = () => bbRows(holder, obj, redraw, opts);
  redraw();
  return holder;
}

/**
 * 一个可折叠的分段（`<details>`）。
 *
 * 干员表单已经长到十段，**「找不到」是它的第一号可用性问题**。做法是标准的那两条：把不常改的段落默认收起
 * （渐进披露，https://webaim.org/techniques/disclosures/），再给每段一个 id 供顶部的「跳到」条使用。
 * 折叠状态记在 `state.sections` 里 —— 表单每 250ms 自动校验重画一次，状态放在 DOM 上会被抹掉。
 *
 * 注意 `open` 不能传 `false`：`h()` 会把 false 当「不设置这个属性」跳过（那正好是 HTML 默认的「展开」）。
 */
function section(id, title, kids, { open = true, note = null } = {}) {
  const isOpen = Object.hasOwn(state.sections, id) ? state.sections[id] : open;
  return h('details', {
    class: 'panel sec', id: `sec-${id}`,
    ...(isOpen ? { open: true } : {}),
    ontoggle: (e) => { state.sections[id] = !!e.target.open; },
  },
  h('summary', {}, h('span', { class: 'sec-title' }, title), note ? h('span', { class: 'hint sec-note' }, note) : null),
  h('div', { class: 'sec-body' }, kids));
}

/** 顶部的「跳到」条：让长表单可以一眼定位（每一段都对应一个 section id）。 */
function sectionJumpBar(items) {
  const bar = h('div', { class: 'jumpbar' }, h('span', { class: 'hint' }, t('跳到：')));
  for (const [id, label] of items) {
    bar.append(h('button', {
      class: 'ghost',
      onclick: () => {
        // 收起的分段先展开再滚过去（不然滚到的是一个标题条）。重画后 DOM 才存在，所以滚动放在下一帧。
        state.sections[id] = true;
        renderEditorKeepingFocus();
        const el = document.getElementById(`sec-${id}`);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, label));
  }
  return bar;
}

/**
 * 「自己画攻击范围」的画板。
 *
 * 为什么需要它：范围预设只列官方出现过的形状（能覆盖大多数情况），但**特殊情况**（同分支却不一样、
 * 官方没有的形状）以前只能去手改 JSON。画板让作者直接点亮/点灭格子，画出来的就是记录里那个
 * `rangeGrid`（相对坐标，原点是自己那一格）。
 *
 * 画板用 `<button>` 而不是 `<div>`：键盘可达、点得到、读屏读得出来（63 个格子，键盘走一遍也就几秒）。
 * 底纹显示「推导出来的形状」，所以作者一眼看得见自己改动了哪几格。
 */
function rangePainterBox(key, getGrid, setGrid, derived) {
  const box = h('div', {});
  const draw = () => {
    box.replaceChildren();
    const grid = Array.isArray(getGrid()) ? getGrid() : [];
    const have = gridKeySet(grid);
    const base = gridKeySet(derived);
    const cells = h('div', { class: 'painter', style: `grid-template-columns:repeat(${PAINTER_COLS},22px)` });
    for (let row = 0; row < PAINTER_ROWS; row++) {
      for (let col = 0; col < PAINTER_COLS; col++) {
        const at = painterCellAt(col, row);
        const on = have.has(`${at.x},${at.y}`);
        const origin = at.x === 0 && at.y === 0;
        cells.append(h('button', {
          type: 'button',
          class: `pcell${on ? ' on' : ''}${base.has(`${at.x},${at.y}`) && !on ? ' base' : ''}${origin ? ' origin' : ''}`,
          title: t('{0} 行 · {1} 列（相对干员自己那一格）', at.y, at.x),
          onclick: () => {
            setGrid(toggleGridCell(getGrid(), at.x, at.y));
            schedulePreview(); draw();
          },
        }));
      }
    }
    const outside = outsidePainterCount(grid);
    box.append(cells);
    box.append(h('div', { class: 'row', style: 'align-items:center;gap:8px;margin-top:6px' },
      h('span', { class: 'hint' }, t('已点亮 {0} 格（原点那一格去不掉：干员必须站在自己的范围内）', sortGrid(grid).length)),
      h('button', { class: 'ghost', onclick: () => { setGrid(sortGrid(derived && derived.length ? derived : grid)); schedulePreview(); draw(); } }, t('用上面的形状起手')),
      h('button', { class: 'ghost', onclick: () => { setGrid([[0, 0]]); schedulePreview(); draw(); } }, t('清空（只留自己那一格）'))));
    if (outside) box.append(h('p', { class: 'hint warn' }, t('还有 {0} 格在画板之外（模板带来或手写的超大范围）：它们照原样保留，画板只画得出 x∈[-3,3]、y∈[-2,6]。', outside)));
  };
  draw();
  return box;
}

/**
 * 一个范围字段：预设下拉 + 小格阵预览 + 「自己画」。
 * 干员范围、干员特性范围、精锐特性范围、模组特性范围、天赋改写范围五处共用同一份实现 ——
 * 所以「特殊形状」在哪儿都能自己画，而不是只有主范围能改。
 */
function rangeField(key, getGrid, setGrid, { defaultLabel, derived = null } = {}) {
  const box = h('div', {});
  const draw = () => {
    box.replaceChildren();
    const cur = getGrid();
    const explicit = Array.isArray(cur);
    const effective = explicit ? cur : (derived ?? null);
    box.append(rangeShapeSelect(getGrid, setGrid, defaultLabel));
    box.append(h('div', { class: 'row', style: 'align-items:center;gap:8px;margin-top:6px' },
      h('button', {
        class: 'ghost',
        onclick: () => { state.painters[key] = !state.painters[key]; draw(); },
      }, state.painters[key] ? t('收起画板') : t('✎ 自己画')),
      explicit
        ? h('button', { class: 'ghost', onclick: () => { setGrid(null); schedulePreview(); renderEditorKeepingFocus(); } }, t('回到推导'))
        : null,
      h('span', { class: 'hint' }, explicit
        ? t('当前是**自定义**范围 · {0} 格', sortGrid(cur).length)
        : t('当前是推导/预设 · {0} 格', sortGrid(effective ?? []).length))));
    if (state.painters[key]) box.append(rangePainterBox(key, getGrid, setGrid, derived));
    else {
      const pv = gridPreview(effective);
      if (pv) box.append(pv);
    }
  };
  draw();
  return box;
}

/** 小格阵预览：亮格 = 能打到，深色那一格 = 干员自己站的位置。 */
function gridPreview(grid) {
  const m = gridMatrix(grid);
  if (!m) return null;
  const wrap = h('div', { style: `display:grid;grid-template-columns:repeat(${m.cols},14px);gap:2px` });
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const on = m.cells[r][c];
      const here = r === m.origin.y && c === m.origin.x;
      const bg = here ? '#5b9dff' : (on ? '#2b4a7a' : 'transparent');
      wrap.append(h('div', { style: `width:14px;height:14px;border-radius:2px;border:1px solid var(--line);background:${bg}` }));
    }
  }
  return wrap;
}

/** 表单没给 rangeGrid 时引擎实际会用的形状（规则与 shared/chessAuthoring.js 完全一致：看**生效的**攻击方式）。 */
function defaultGrid(attackKind) {
  return (attackKind === 'melee' || attackKind === 'none') ? DEFAULT_MELEE_RANGE : DEFAULT_RANGED_RANGE;
}

const dmgLabel = (v) => (v === 'arts' ? t('法术') : (v === 'heal' ? t('治疗') : (v === 'true' ? t('真实') : (v === 'element' ? t('元素') : t('物理')))));
const kindLabel = (v) => (v === 'ranged' ? t('远程') : (v === 'none' ? t('不攻击') : (v === 'heal' ? t('治疗') : t('近战'))));

function renderEditor() {
  const box = $('#editor');
  box.replaceChildren();
  if (!state.data) { box.append(h('p', { class: 'hint' }, t('正在载入…'))); return; }
  if (state.message) box.append(h('div', { class: `banner ${state.message.kind === 'error' ? 'bad' : 'good'}` }, state.message.text));
  if (state.picking) { renderPicker(box); return; }
  if (!state.spec) { box.append(h('p', { class: 'hint' }, t('左边的列表中选一个工坊包，或新建一个干员。'))); return; }

  const s = state.spec;
  const packId = state.packId || t('（先选择工坊包）');
  box.append(h('h2', {}, t('干员 · {0} · 包 {1}', s.name || s.id || t('未命名'), packId)));
  // 十段的长表单：先给一条「跳到」，再让不常改的段落默认收起（见 section()）。
  box.append(sectionJumpBar([
    ['identity', t('身份')], ['look', t('外观')], ['range', t('范围/分类')], ['stats', t('数值')],
    ['skill', t('技能')], ['talents', t('天赋')], ['elite', t('精锐')], ['modules', t('模组')],
    ['bonds', t('盟约')], ['check', t('校验')],
  ]));

  // identity
  const pack = state.data.packs.find((p) => p.id === state.packId);
  const conflict = idConflict(s.id, { packSlugs: pack ? pack.specs.map((x) => x.id) : [], officialIds: state.officialIdSet });
  const rename = renameNotice(state.slug, s.id);
  // 分支按职业联动：官方 57 个分支各归一个职业，所以先选职业、再从这个职业允许的分支里挑。
  // 服务端给的 `subProfessions` 从**全部**记录算出（可见数据里少一个 `pusher`），旧服务端没这个字段时退回
  // 从 officialChess 现推一份（会少几个分支，但不会报错）。
  const branchIndex = Array.isArray(state.data.subProfessions) && state.data.subProfessions.length
    ? state.data.subProfessions
    : subProfessionOptions(state.data.officialChess).map((b) => ({ id: b.id, name: b.name, professions: [] }));
  const subOpts = subProfessionOptionsFor(branchIndex, s.profession);
  const subCur = String(s.subProfessionId ?? '').trim();
  // 当前值不属于这个职业时：**不静默清空**（那是一次无声的数据丢失），而是把它留在下拉里并当场说明。
  const subOwners = professionsOfSub(branchIndex, subCur);
  const subMismatch = !!subCur && subOwners.length > 0 && !!s.profession && !subOwners.includes(String(s.profession).toUpperCase());
  if (subCur && !subOpts.some((o) => o.id === subCur)) {
    subOpts.unshift({ id: subCur, name: (branchIndex.find((b) => b.id === subCur)?.name) ?? '' });
  }
  const subLabel = (o) => (currentLang() === 'en' || !o.name ? o.id : `${o.name} · ${o.id}`);
  const profLabel = (p) => PROFESSION_NAMES[p]?.[currentLang() === 'en' ? 'en' : 'zh'] ?? p;
  box.append(section('identity', t('身份'), h('div', { class: 'grid' },
    field(t('id（slug，决定 chess_ws_<id>_a/_b）'), h('div', {},
      textInput(() => s.id, (v) => { s.id = v; }),
      conflict ? h('div', { class: 'hint err' }, conflict.kind === 'pack'
        ? t('这个 id 已被本包占用：{0}', conflict.id)
        : t('这个 id 与官方记录相同，不进 overrides 的话会被丢弃：{0}', conflict.id)) : null,
      rename ? h('div', { class: 'hint warn' }, t('改了 id：保存会新建一份记录，原来的 {0} 仍留在包里（要自己删）', rename.from)) : null)),
    field(t('名称'), textInput(() => s.name, (v) => { s.name = v; })),
    field(t('英文代号'), textInput(() => s.appellation, (v) => { s.appellation = v; })),
    field(t('阶（tier）'), numInput(() => s.tier, (v) => { s.tier = v; })),
    field(t('职业'), select(PROFESSIONS, () => s.profession, (v) => { s.profession = v; renderEditorKeepingFocus(); }, (v) => nameLabel(PROFESSION_NAMES, v))),
    // 分支决定攻击方式、伤害类型与能否打空。它**只列当前职业允许的分支**（改职业会立刻重算这张清单），
    // 仍然留一条手填的路：作者要写一个官方没有的分支时不该被挡住。
    field(t('分支 subProfessionId'), h('div', {},
      h('select', { onchange: (e) => { s.subProfessionId = e.target.value; schedulePreview(); renderEditorKeepingFocus(); } },
        h('option', { value: '', selected: !subCur }, t('（不填：攻击方式与伤害类型只按职业推导）')),
        subOpts.map((o) => h('option', { value: o.id, selected: subCur === o.id }, subLabel(o)))),
      h('p', { class: 'hint' }, t('只列「{0}」这个职业的分支（共 {1} 个）。', profLabel(s.profession), subOpts.length)),
      subMismatch
        ? h('div', { class: 'hint warn' }, t('这个分支不属于「{0}」，它属于 {1}：能保存，但职业光环与分支行为可能对不上（改职业，或把分支改成这个职业的）。',
          profLabel(s.profession), subOwners.map(profLabel).join('、')))
        : null,
      h('div', { style: 'margin-top:4px' },
        textInput(() => s.subProfessionId, (v) => { s.subProfessionId = v; }, { placeholder: t('如 fastshot / fortress / bard'), list: 'subProfOptions' }),
        h('datalist', { id: 'subProfOptions' }, subProfessionChoices(state.data.officialChess).map((v) => h('option', { value: v }))),
        h('div', { class: 'hint' }, t('手填一个官方没有的分支 id 也可以（不填则按职业推导）。'))))),
    field(t('位置'), select(['MELEE', 'RANGED'], () => s.position, (v) => { s.position = v; }, (v) => nameLabel(POSITION_NAMES, v))),
    field(t('特性文字（只影响伤害类型推导）'), textInput(() => s.traitDesc, (v) => setText(s, 'traitDesc', v))),
    // 特性自带的那片范围（不是干员的攻击范围）：引擎里由特性自己定义（例：散射手用它定义正面那一圈，
    // server/sim/professions.js），官方 4 位干员的特性带它。留空＝这个干员的特性没有自带范围。
    field(t('特性自带范围'), rangeField('trait', () => s.traitRangeGrid, (g) => { if (g) s.traitRangeGrid = g; else delete s.traitRangeGrid; }, { defaultLabel: t('（没有自带范围）') })))));

  // appearance — the repo ships no assets, so reuse an existing spine.
  // 候选来自服务端的 `spineChoices`（本机已装好的干员模型清单），只有在旧服务端没给时才退回官方干员列表。
  const spineList = state.data.spineChoices?.length
    ? state.data.spineChoices.map((c) => c.id)
    : state.data.officialChess.map((c) => c.spine).filter(Boolean);
  const spines = [...new Set(spineList)].sort();
  const spineSel = h('select', { onchange: (e) => { s.assetsSpine = e.target.value; schedulePreview(); renderEditor(); } },
    h('option', { value: '', selected: !s.assetsSpine }, t('（不指定 → 试玩里是一张贴图，不是模型）')));
  for (const sp of spines) spineSel.append(h('option', { value: sp, selected: s.assetsSpine === sp }, sp));
  // **当场判定**：这是全表单第二贵的字段 —— 查不到就画一张头像菱形贴图，游戏照跑、没有任何报错，
  // 于是作者只会觉得「模型怎么没渲染出来」。这里直接说清会画成什么，而不是等他去试玩里发现。
  const spineVerdict = spineIsKnown(s.assetsSpine, spines);
  const spineHint = h('p', { class: spineVerdict === 'ok' ? 'hint' : 'hint warn' },
    spineVerdict === 'ok' ? t('✔ 会渲染成模型：复用 {0} 这套 Spine。', s.assetsSpine)
      : t('✘ 不会渲染成模型：试玩里这个干员是一张**头像贴图**（菱形底），不是会动的模型。这个仓库不携带干员美术，只能复用已装好的 Spine id —— 从上面下拉里挑一个，或按模板新建（模板会把外观一起带过来）。'));
  box.append(section('look', t('外观'), [
    h('p', { class: 'hint' }, t('仓库不含素材，只能复用已装好的 Spine id。')),
    h('div', { class: 'grid' }, field('assetsSpine', spineSel), field(t('或直接填 id'), textInput(() => s.assetsSpine, (v) => { s.assetsSpine = v; }))),
    spineHint,
  ], { note: t('能不能渲染成模型，看这一段的结论') }));

  // 攻击范围与伤害分类：表单以前完全没有范围的入口（连默认值是多少都看不到），现在能挑官方形状并直接看小格阵
  const derived = classify({ profession: s.profession, subProfessionId: s.subProfessionId, position: s.position, traitDesc: s.traitDesc });
  // 生效值 = 覆盖值（写了就用写的）或推导值。deriveChessRecord 的 pick() 就是这条规则，
  // 所以界面上的「记录里会写」与默认范围形状都必须按生效值算，否则作者会看到一个假的默认范围。
  const ov = (key, list) => (typeof s[key] === 'string' && list.includes(s[key].toLowerCase()) ? s[key].toLowerCase() : null);
  const eff = {
    dmgType: ov('dmgType', DMG_TYPES) || derived.dmgType,
    attackKind: ov('attackKind', ATTACK_KINDS) || derived.attackKind,
    projectile: ov('projectile', PROJECTILES) || derived.projectile,
    canHitFly: typeof s.canHitFly === 'boolean' ? s.canHitFly : derived.canHitFly,
  };
  const effGrid = Array.isArray(s.rangeGrid) ? s.rangeGrid : defaultGrid(eff.attackKind);
  // 覆盖下拉：留空写回的是「删掉这个键」，而不是写一个空串 —— 空串在 pick() 里等于没写，但留个空键会让记录变脏
  const setOverride = (key, v) => { if (v) s[key] = v; else delete s[key]; };
  box.append(section('range', t('攻击范围与伤害分类'), [
    h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
      h('div', { style: 'flex:0 0 250px' }, field(t('范围形状'), rangeField('op', () => s.rangeGrid, (g) => { if (g) s.rangeGrid = g; else delete s.rangeGrid; }, { derived: defaultGrid(eff.attackKind) }))),
      h('div', {}, Array.isArray(s.rangeGrid) ? null : h('div', { class: 'hint' }, t('（左边这份是推导出的默认形状）')),
        h('div', { class: 'hint' }, t('都是官方出现过的形状；没有你要的那一种就点「✎ 自己画」。'))),
      h('p', { class: 'hint', style: 'flex:1' },
        t('伤害类型 {0} · 攻击方式 {1} · 可打空中 {2}', dmgLabel(derived.dmgType), kindLabel(derived.attackKind), derived.canHitFly ? t('是') : t('否')),
        h('br'), t('（这一行是按职业与分支推导出来的）'))),
    // 「有特殊情况」时用的接口：攻击范围与伤害分类基本由职业与分支决定，但同分支的干员确实可能不一样，
    // 所以四个字段都能在这里钉住；钉住后校验会给一条「覆盖了推导值」的警告。
    h('h2', {}, t('攻击分类的覆盖（特殊情况才用）')),
    h('p', { class: 'hint' }, t('平时这四项由职业与分支推导（就是上面那一行）。同分支的干员因为天赋或官方特例而不同时，在这里钉住它；留空＝用推导值。下面每个下拉列的是**引擎认识的全部取值**。')),
    h('div', { class: 'grid' },
      field(t('伤害类型 dmgType'), overrideSelect(DMG_TYPES, () => s.dmgType, (v) => { setOverride('dmgType', v); renderEditorKeepingFocus(); }, derived.dmgType, dmgLabel)),
      field(t('攻击方式 attackKind'), overrideSelect(ATTACK_KINDS, () => s.attackKind, (v) => { setOverride('attackKind', v); renderEditorKeepingFocus(); }, derived.attackKind, kindLabel)),
      field(t('投射物 projectile'), overrideSelect(PROJECTILES, () => s.projectile, (v) => { setOverride('projectile', v); renderEditorKeepingFocus(); }, derived.projectile)),
      field(t('能否打空中 canHitFly'), overrideBoolSelect(() => s.canHitFly, (v) => { if (v === null) delete s.canHitFly; else s.canHitFly = v; }, derived.canHitFly))),
    h('p', { class: 'hint' }, t('记录里会写：伤害类型 {0} · 攻击方式 {1} · 投射物 {2} · 可打空中 {3}',
      dmgLabel(eff.dmgType), kindLabel(eff.attackKind), eff.projectile, eff.canHitFly ? t('是') : t('否'))),
  ], { note: t('范围形状 / 伤害类型 / 攻击方式 / 投射物 / 打不打空中') }));

  // the two states
  const refs = state.data.statRanges?.[s.profession] ?? {};
  const statField = (label, key, st) => field(label, h('div', {},
    numInput(() => st[key], (v) => { st[key] = v; }),
    statBar(st[key], refs[key])));
  const statBlock = (key, title) => {
    const st = s.stats[key];
    return h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, title),
      h('div', { class: 'grid' },
        statField(t('生命上限 maxHp'), 'maxHp', st),
        statField(t('攻击 atk'), 'atk', st),
        statField(t('防御 def'), 'def', st),
        statField(t('法抗 res'), 'res', st),
        statField(t('费用 cost'), 'cost', st),
        statField(t('阻挡 blockCnt'), 'blockCnt', st),
        statField(t('攻击间隔 bat（秒）'), 'bat', st),
        field(t('再部署 respawnTime'), numInput(() => st.respawnTime ?? 70, (v) => { st.respawnTime = v; }))),
      // 一张白纸最劝退的地方是「这八个数字该填多少」。尺子上有官方中位，那就让它一键落进去 ——
      // 起手就有一份官方量级的数值，改起来比从 1400/450/140 猜要容易得多。
      refs.maxHp
        ? h('button', {
          class: 'ghost', style: 'margin-top:8px',
          onclick: () => {
            for (const k of Object.keys(refs)) {
              const v = refs[k]?.p50;
              if (Number.isFinite(v)) st[k] = k === 'bat' ? Math.round(v * 100) / 100 : Math.round(v);
            }
            schedulePreview(); renderEditorKeepingFocus();
          },
        }, t('按官方中位填入（{0} 名同类干员）', refs.maxHp.count))
        : null);
  };
  box.append(section('stats', t('数值（普通 / 精锐两套）'), [
    h('div', { class: 'split' }, statBlock('normal', t('普通状态数值')), statBlock('golden', t('精锐状态数值'))),
    refs.maxHp ? h('p', { class: 'hint' }, t('细线上的刻度是官方同类干员的区间（按职业统计，共 {0} 名），不是硬性上限。', refs.maxHp.count)) : null,
  ], { note: t('两套数值 + 官方区间尺子 + 一键按中位填入') }));

  // skill
  const sk = s.skill ?? (s.skill = blankSpec().skill);
  if (!sk.bb) sk.bb = {};
  box.append(section('skill', t('技能'), [
    h('div', { class: 'grid' },
      field(t('技能名'), textInput(() => sk.name, (v) => { sk.name = v; })),
      field(t('类型'), select(SKILL_TYPES, () => sk.skillType, (v) => { sk.skillType = v; })),
      field(t('持续类型'), select(DURATION_TYPES, () => sk.durationType, (v) => { sk.durationType = v; })),
      field(t('技力消耗 spCost'), numInput(() => sk.spCost, (v) => { sk.spCost = v; })),
      field(t('初始技力 initSp'), numInput(() => sk.initSp, (v) => { sk.initSp = v; })),
      field(t('持续时间 duration（0 立即 / -1 无限）'), numInput(() => sk.duration, (v) => { sk.duration = v; })),
      field(t('技力回复 spType'), select(SP_TYPES, () => sk.spType, (v) => { sk.spType = v; })),
      field(t('自动释放 triggerRule'), select(TRIGGERS, () => sk.triggerRule, (v) => { sk.triggerRule = v; }))),
    field(t('技能描述（官方文字）'), h('textarea', { value: sk.desc ?? '', oninput: (e) => { sk.desc = e.target.value; schedulePreview(); } })),
    h('h2', {}, t('黑板书 bb')),
    h('p', { class: 'hint' }, t('键必须是通用 kit 认识的（见 docs/prompts/operator-pack.md 的表格）。写了不认的键不会报错，但也不会有任何效果——校验会警告。')),
    bbEditor(sk.bb)], { note: t('技能名 / 类型 / 技力 / 黑板键值') }));

  // talents (天赋): the authoring layer already turns spec.talents into the record's talents[] (name/desc/bb), so this
  // is purely the missing form. A talent with no desc is emitted `hidden: true` by the derive layer, which is why the
  // hint below insists on the description — a talent nothing can read is a talent that does nothing.
  s.talents = Array.isArray(s.talents) ? s.talents : [];
  box.append(section('talents', t('天赋（普通态）'), talentEditor(s.talents, '', { bare: true }),
    { note: t('0~2 条，每条含天赋名 / 说明 / 黑板键值') }));

  // ---- 精锐（精英 2）与普通不同的那一份 -----------------------------------------------------------------------------
  // 数值一直是两套；特性、天赋、攻击范围在 spec 里是**可选**的第二份，而官方数据里确实有差别：
  // 可见的 112 位干员中 33 位精锐天赋不同、2 位精锐特性不同、2 位精锐攻击范围不同（`specFromChessRecord` 的口径）。
  // 所以这里的原则是「不勾＝两态共用一份」：勾上时以普通那一份为起点，取消就把字段删掉。
  // 留一个与普通一模一样的副本会让 spec 变脏，也让「精锐到底改了什么」看不出来。
  // 位置在「天赋」之后：这一块里除了特性与范围，还有一整份精锐天赋列表。
  const goldenPanel = h('div', {});
  const drawGoldenParts = () => {
    goldenPanel.replaceChildren();
    goldenPanel.append(h('p', { class: 'hint' }, t('数值本来就是两套（上面）。特性、天赋、攻击范围这三样默认两态共用一份；要不一样就在这里勾出来，勾上时以普通那一份为起点，取消勾选＝回到共用。')));

    // 特性
    const traitOn = !!s.traitGolden;
    goldenPanel.append(h('div', { style: 'margin-top:8px' },
      h('label', { class: 'row', style: 'gap:8px;align-items:center;color:var(--fg)' },
        checkInput(traitOn, (on) => {
          if (on) s.traitGolden = { desc: typeof s.traitDesc === 'string' ? s.traitDesc : '' };
          else delete s.traitGolden;
          schedulePreview(); drawGoldenParts();
        }),
        t('精锐特性不同')),
      traitOn
        ? h('div', {},
          field(t('精锐特性文字'), textInput(() => s.traitGolden.desc, (v) => setText(s.traitGolden, 'desc', v))),
          h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
            field(t('精锐特性自带范围'), rangeShapeSelect(() => s.traitGolden.rangeGrid, (g) => { if (g) s.traitGolden.rangeGrid = g; else delete s.traitGolden.rangeGrid; }, t('（与普通那份特性同一个范围）'))),
            s.traitGolden.rangeGrid ? gridPreview(s.traitGolden.rangeGrid) : null),
          h('p', { class: 'hint' }, t('精锐特性的黑板（`bb` / `bbStr`）不在这一页编辑；以模板新建时它们会原样带过来。')))
        : h('p', { class: 'hint' }, t('（没勾：精锐沿用上面那份特性）'))));

    // 攻击范围
    const rangeOn = Array.isArray(s.rangeGridGolden);
    goldenPanel.append(h('div', { class: 'row', style: 'align-items:flex-start;gap:16px;margin-top:8px' },
      h('div', { style: 'flex:0 0 230px' },
        h('label', { class: 'row', style: 'gap:8px;align-items:center;color:var(--fg)' },
          checkInput(rangeOn, (on) => {
            if (on) s.rangeGridGolden = (Array.isArray(s.rangeGrid) ? s.rangeGrid : defaultGrid(eff.attackKind)).map((c) => [...c]);
            else delete s.rangeGridGolden;
            schedulePreview(); drawGoldenParts();
          }),
          t('精锐攻击范围不同')),
        rangeOn
          ? field(t('精锐范围形状'), rangeShapeSelect(() => s.rangeGridGolden, (g) => { if (g) s.rangeGridGolden = g; else delete s.rangeGridGolden; }, t('（与普通同一个范围）')))
          : h('p', { class: 'hint' }, t('（没勾：精锐沿用上面那个范围）'))),
      rangeOn ? h('div', {}, gridPreview(s.rangeGridGolden), h('div', { class: 'hint' }, t('（这是精锐自己的范围）'))) : null));

    // 天赋
    const talentsOn = Array.isArray(s.talentsGolden);
    goldenPanel.append(h('div', { style: 'margin-top:8px' },
      h('label', { class: 'row', style: 'gap:8px;align-items:center;color:var(--fg)' },
        checkInput(talentsOn, (on) => {
          if (on) s.talentsGolden = JSON.parse(JSON.stringify(s.talents ?? []));
          else delete s.talentsGolden;
          schedulePreview(); drawGoldenParts();
        }),
        t('精锐天赋不同（官方常见：弹药上限 +2 → +3）'))));
    if (talentsOn) goldenPanel.append(talentEditor(s.talentsGolden, t('精锐天赋（精英 2）')));
  };
  drawGoldenParts();
  box.append(section('elite', t('精锐（精英 2）与普通不同时'), goldenPanel,
    { open: false, note: t('不勾就是两态共用一份（官方 112 位里有 33 位精锐天赋不同）') }));

  // ---- 模组（只有精锐记录会读 `modules[]`）------------------------------------------------------------------------
  // 官方 184 个模组就是这个形状。要紧的一条：勾了 `isDefault` 的那一个会被**烘进**精锐记录 ——
  // `stats = 表单精锐数值 + attr`、`trait` 被它的特性覆盖换掉、`talents` 被它的天赋改写改掉
  // （shared/loadoutRecord.js 的 composeStats / composeTalents，与引擎同一份实现）。
  s.modules = Array.isArray(s.modules) ? s.modules : [];
  const modBox = h('div', {});
  const drawModules = () => {
    modBox.replaceChildren();
    if (!s.modules.length) modBox.append(h('p', { class: 'hint' }, t('（一个模组都没有：精锐记录不带模组，玩家在载入界面也挑不到任何模组）')));
    s.modules.forEach((m, i) => modBox.append(moduleCard(s, m, i, drawModules)));
  };
  drawModules();
  const defMod = s.modules.find((m) => m && m.isDefault) ?? null;
  const composed = defMod ? composeStats(s.stats.golden ?? {}, defMod.attr ?? {}) : null;
  box.append(section('modules', t('模组 modules'), [
    h('p', { class: 'hint' }, t('只有精锐记录会读它。勾了「默认」的那一个会被烘进精锐记录：数值＝上面的精锐数值＋它的数值加成，特性覆盖与天赋改写也一起生效。其它模组照样发给游戏，玩家在载入界面能选。')),
    defMod
      ? h('p', { class: 'hint' }, t('当前默认模组「{0}」→ 精锐记录里写下去的数值：{1}', defMod.name || defMod.id || t('未命名'), statDiff(s.stats.golden ?? {}, composed)))
      : (s.modules.length ? h('p', { class: 'hint warn' }, t('没有勾「默认」：精锐记录会按不带模组生成（校验会警告），玩家仍然能选这些模组。')) : null),
    modBox,
    h('button', {
      class: 'ghost',
      onclick: () => { s.modules.push(blankModule(s.modules.length, s.id)); schedulePreview(); drawModules(); },
    }, t('＋ 添加一个模组')),
  ], { open: false, note: t('数值加成 / 特性覆盖 / 天赋改写（官方 184 个模组的形状）') }));

  // ---- 盟约 bonds -------------------------------------------------------------------------------------------------
  // 干员算在哪些盟约里。记录里写的就是 id：官方那 23 条盟约由引擎按 id 实现（阈值/数值全从盟约记录读），
  // 工坊包的盟约由包自己声明 —— 两边都只是 id，所以这里给一份清单而不是自由输入框。
  // 模板带过来的官方盟约也在清单里（勾着），取消就能退出这个盟约。
  s.bonds = Array.isArray(s.bonds) ? s.bonds : [];
  const bondIndex = bondChoicesOf(state.data.officialBonds, pack?.bonds);
  const unknownBonds = s.bonds.filter((b) => !bondIndex.some((x) => x.id === b));
  const bondListBox = h('div', {});
  const drawBonds = () => {
    bondListBox.replaceChildren();
    const q = state.bondQuery.trim().toLowerCase();
    const shown = bondIndex.filter((x) => !q || x.id.toLowerCase().includes(q) || x.name.toLowerCase().includes(q));
    if (!shown.length) bondListBox.append(h('p', { class: 'hint' }, t('（没有匹配的盟约）')));
    for (const b of shown) {
      bondListBox.append(h('label', { style: 'display:flex;gap:6px;align-items:center;color:var(--fg)' },
        h('input', {
          type: 'checkbox', checked: s.bonds.includes(b.id), style: 'width:auto',
          onchange: (e) => {
            if (e.target.checked) { if (!s.bonds.includes(b.id)) s.bonds.push(b.id); }
            else s.bonds = s.bonds.filter((x) => x !== b.id);
            schedulePreview();
          },
        }),
        t('{0}（{1}）', b.name, b.id),
        b.from === 'pack' ? h('span', { class: 'tag' }, t('本包')) : null));
    }
  };
  drawBonds();
  box.append(section('bonds', t('盟约 bonds'), [
    h('p', { class: 'hint' }, t('官方盟约 {0} 条、本包 {1} 条。两边都有记录时，试玩里才会真的生效。', state.data.officialBonds?.length ?? 0, (pack?.bonds ?? []).length)),
    textInput(() => state.bondQuery, (v) => { state.bondQuery = v; drawBonds(); }, { placeholder: t('按名称或 id 搜索盟约') }),
    bondListBox,
    unknownBonds.length
      ? h('p', { class: 'hint warn' }, t('这些 id 查不到对应的盟约（保存没问题，但游戏里不会有任何效果）：{0}', unknownBonds.join('、')))
      : null,
  ], { open: false, note: t('这个干员算在哪些盟约里（模板带过来的默认已勾上）') }));

  // support switch (the 是否助战 toggle)
  if (state.slug) {
    const baseId = `chess_ws_${state.slug}_a`;
    const tier = s.tier;
    const pool = state.data.support.pool[tier] || [];
    const isSupport = pool.includes(baseId);
    box.append(section('support', t('助战'), [
      h('p', { class: 'hint' }, t('勾上＝把这份记录写进 data/support.json 的服务端卡池（重启游戏服务器后生效）。')),
      h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--fg)' },
        checkInput(isSupport, async (on) => {
          try {
            await api('/api/support/toggle', { method: 'POST', body: { chessId: baseId, tier, enabled: on } });
            state.message = { kind: 'ok', text: on
              ? t('{0} 已加入 {1} 阶助战卡池（重启游戏服务器后生效）', s.name || baseId, tier)
              : t('{0} 已移出 {1} 阶助战卡池（重启游戏服务器后生效）', s.name || baseId, tier) };
            await load();
          } catch (err) { state.message = { kind: 'error', text: errText(err) }; renderEditor(); }
        }),
        t('把 {0} 加入 {1} 阶助战卡池', baseId, tier)),
      h('p', { class: 'hint' }, t('当前 {0} 阶卡池：{1}', tier, pool.length ? pool.join(', ') : t('（空）'))),
    ], { note: t('可选：让这张卡出现在助战卡池里') }));
  }

  // actions + validation
  const actions = h('div', { class: 'row', style: 'margin:14px 0' },
    h('button', { class: 'primary', disabled: state.busy || !state.packId, onclick: save }, state.busy ? t('保存中…') : t('保存并生成')),
    state.slug ? h('button', { onclick: remove }, t('删除该干员')) : null,
    h('button', { class: 'ghost', onclick: () => { state.spec = blankSpec(); state.slug = null; schedulePreview(); renderShell(); } }, t('清空表单')),
    // 保存之后最想做的事是「看一眼它在游戏里长什么样」：这里直接起试玩，省掉「切到包管理页 → 点试玩」那两步。
    h('button', { class: 'ghost', onclick: (e) => playtest(e.target) }, t('▶ 试玩（起一局看它）')));
  box.append(actions);
  if (!state.packId) box.append(h('p', { class: 'hint' }, t('先在上方选择一个工坊包（或点「新建工坊包」），才能保存。')));

  const pv = state.preview;
  const panel = h('div', {});
  if (!pv) panel.append(h('p', { class: 'hint' }, t('（改动后会自动校验）')));
  else if (pv.ok && !pv.warnings.length) panel.append(h('div', { class: 'ok' }, t('✔ 校验通过：引擎接受这份记录')));
  else {
    if (pv.errors?.length) {
      panel.append(h('div', { class: 'err' }, t('{0} 个错误（必须修）', pv.errors.length)));
      panel.append(h('ul', { class: 'issues' }, pv.errors.map((e) => h('li', { class: 'err' }, `${e.field || t('（记录）')} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}`))));
    }
    if (pv.warnings?.length) {
      panel.append(h('div', { class: 'warn' }, t('{0} 条警告', pv.warnings.length)));
      panel.append(h('ul', { class: 'issues' }, pv.warnings.map((w) => h('li', { class: 'warn' }, String(w)))));
    }
  }
  if (pv?.base) {
    panel.append(h('h2', {}, t('将要生成的记录（普通 / 精锐由工具推导）')));
    panel.append(h('pre', { text: JSON.stringify({ base: pv.base, golden: pv.golden }, null, 1).slice(0, 4000) }));
  }
  box.append(section('check', t('校验结果'), panel,
    { note: pv && pv.ok && !pv.warnings?.length ? t('✔ 通过') : t('实时校验（与 CLI、AI 同一套规则）') }));
}

// ---- 天赋列表编辑器（普通态与精锐态共用一个实现） -------------------------------------------------------------------

/**
 * 一个完整的天赋列表编辑器。传进来的是**数组本身**，增删都改它 —— 所以 `s.talents` 与 `s.talentsGolden` 都能用。
 * @param {Array} list @param {string} title
 */
function talentEditor(list, title, { bare = false } = {}) {
  const box = h('div', {});
  const draw = () => {
    box.replaceChildren();
    list.forEach((t_, i) => {
      if (!t_.bb) t_.bb = {};
      box.append(h('div', { class: 'panel' },
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('strong', {}, t('天赋 {0}', i + 1)),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'ghost', onclick: () => { list.splice(i, 1); schedulePreview(); draw(); } }, t('× 删除'))),
        h('div', { class: 'grid' },
          field(t('天赋名'), textInput(() => t_.name, (v) => { t_.name = v; })),
          // 说明走 setText：记录里优先读 descRaw（官方的富文本原文），只改 desc 会静默无效
          field(t('说明（必填，否则该天赋被视为隐藏）'), textInput(() => t_.desc, (v) => setText(t_, 'desc', v)))),
        h('h2', {}, t('天赋黑板 bb')),
        bbEditor(t_.bb)));
    });
  };
  draw();
  const inner = [
    title ? h('h2', { style: 'margin-top:0' }, title) : null,
    h('p', { class: 'hint' }, t('说明（desc）是必须的：没有说明的天赋在记录里会被标记为 hidden。黑板键同样是通用 kit 认识的键，写错只会警告、不会有任何效果。')),
    box,
    h('button', {
      class: 'ghost',
      onclick: () => { list.push({ name: t('天赋 {0}', list.length + 1), desc: '', bb: {} }); schedulePreview(); draw(); },
    }, t('＋ 添加一条天赋')),
  ];
  return bare ? h('div', {}, inner) : h('div', { class: 'panel' }, inner);
}

// ---- 模组卡（干员页的模组块） ---------------------------------------------------------------------------------------

/** 模组 `attr` 的显示名（「加了模组之后变成多少」那一行用它）。 */
function attrLabels() {
  return {
    maxHp: t('生命上限 maxHp'), atk: t('攻击 atk'), def: t('防御 def'), res: t('法抗 res'),
    aspd: t('攻速 aspd'), cost: t('费用 cost'), blockCnt: t('阻挡 blockCnt'), respawnTime: t('再部署 respawnTime'),
  };
}

/** 引擎把 attr 加进基础数值时保留 6 位小数（shared/loadoutRecord.js 的 clean6）。 */
const round6 = (v) => Math.round(Number(v || 0) * 1e6) / 1e6;

/** 「表单里的精锐数值 → 加上默认模组之后的数值」：只列真的变了的字段，没变就不占地方。 */
function statDiff(base, composed) {
  const lab = attrLabels();
  const parts = [];
  for (const k of MODULE_ATTR_KEYS) {
    const from = round6(base[k]), to = round6(composed[k]);
    if (from === to) continue;
    parts.push(`${lab[k] ?? k} ${from} → ${to}`);
  }
  return parts.length ? parts.join(' · ') : t('（数值没有变化：这个默认模组只改特性或天赋）');
}

/**
 * 一个空模组。id 直接给一个合法值：空 id 会是**校验错误**，而作者刚点「添加」时还没想好名字，
 * 不该先被骂一句（id 可以让它一直是自动生成的那个，游戏的载入界面只把它当键用）。
 */
function blankModule(i, slug) {
  return {
    id: `uniequip_ws_${slug || 'mod'}_${i + 1}`,
    name: '', type: `WS-${'XYZ'[i] ?? 'Z'}`, isDefault: i === 0, level: 1,
    attr: { atk: 0 }, traitDesc: '', traitBb: {}, talentChanges: [],
  };
}

/**
 * 一个模组的编辑卡。字段与 `deriveChessRecord` 读的 spec 形状一一对应（见 shared/chessAuthoring.js 的 modules 段）。
 * 界面上不编辑的字段（特性自带的 rangeGrid、富文本原文、天赋改写的 skillIndex）一律**原样留着**：
 * 以模板新建时它们是官方的真实数据，界面看不见不等于可以丢掉。
 */
function moduleCard(s, m, i, redraw) {
  if (!m.attr) m.attr = {};
  if (!m.traitBb) m.traitBb = {};
  m.talentChanges = Array.isArray(m.talentChanges) ? m.talentChanges : [];

  const chBox = h('div', {});
  const drawChanges = () => {
    chBox.replaceChildren();
    if (!m.talentChanges.length) chBox.append(h('p', { class: 'hint' }, t('（不改编任何天赋）')));
    m.talentChanges.forEach((ch, ci) => {
      if (!ch.bb) ch.bb = {};
      // talentIndex 对的是记录里天赋的 `index`（官方是稀疏的：0、1、3 —— 中间那个位置没有天赋），不是数组下标
      const recIndexes = s.talents.map((t_, ti) => (Number.isInteger(t_.index) ? t_.index : ti));
      const idxSel = h('select', { onchange: (e) => { ch.talentIndex = Number(e.target.value); schedulePreview(); drawChanges(); } });
      idxSel.append(h('option', { value: '-1', selected: !(ch.talentIndex >= 0) }, t('（新加一条天赋，不覆盖已有的）')));
      recIndexes.forEach((idx, ti) => idxSel.append(h('option', {
        value: String(idx), selected: ch.talentIndex === idx,
      }, t('改写天赋 {0}：{1}', idx, s.talents[ti].name || t('（无名）')))));
      chBox.append(h('div', { class: 'panel' },
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('strong', {}, t('天赋改写 {0}', ci + 1)),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'ghost', onclick: () => { m.talentChanges.splice(ci, 1); schedulePreview(); drawChanges(); } }, t('× 删除'))),
        h('div', { class: 'grid' },
          field(t('改哪一条'), idxSel),
          field(t('天赋名（留空＝用原来那个）'), textInput(() => ch.name, (v) => { ch.name = v || null; })),
          field(t('说明（留空＝用原来那个）'), textInput(() => ch.desc, (v) => setText(ch, 'desc', v || null))),
          field(t('隐藏这条天赋'), checkInput(ch.hidden === true, (on) => { ch.hidden = on; schedulePreview(); }))),
        // 这条改写自带的范围：官方那些「攻击范围扩大」的模组就是靠它（`talentIndex: -1` 的那条 + rangeGrid，
        // 见 shared/loadoutRecord.js 的 attackRangeGrid）。不写＝这条天赋改写不带范围。
        h('h2', {}, t('这条改写自带的范围')),
        h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
          h('div', { style: 'flex:0 0 230px' }, rangeShapeSelect(() => ch.rangeGrid, (g) => { if (g) ch.rangeGrid = g; else delete ch.rangeGrid; }, t('（不改范围）'))),
          Array.isArray(ch.rangeGrid) ? h('div', {}, gridPreview(ch.rangeGrid), h('div', { class: 'hint' }, t('（这是这条改写自带的范围）'))) : null),
        h('h2', {}, t('改写的黑板 bb')),
        bbEditor(ch.bb)));
    });
    chBox.append(h('button', {
      class: 'ghost',
      onclick: () => { m.talentChanges.push({ talentIndex: -1, name: null, desc: null, bb: {}, hidden: false }); schedulePreview(); drawChanges(); },
    }, t('＋ 添加一条天赋改写')));
  };
  drawChanges();

  return h('div', { class: 'panel' },
    h('div', { class: 'row', style: 'margin-bottom:6px' },
      h('strong', {}, t('模组 {0}', i + 1)),
      h('label', { style: 'display:flex;gap:6px;align-items:center;color:var(--fg)' },
        // 默认模组只能有一个：勾上它就先把别人全部取消，免得撞 MULTIPLE_DEFAULTS 那条校验错误
        checkInput(!!m.isDefault, (on) => { s.modules.forEach((x) => { x.isDefault = false; }); m.isDefault = on; schedulePreview(); redraw(); }),
        t('默认（精锐记录带的就是它）')),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'ghost', onclick: () => { s.modules.splice(i, 1); schedulePreview(); redraw(); } }, t('× 删除'))),
    h('div', { class: 'grid' },
      field(t('模组 id uniEquipId'), textInput(() => m.id, (v) => { m.id = v; })),
      field(t('模组名（留空就显示 id）'), textInput(() => m.name, (v) => { m.name = v; })),
      field(t('类型 typeName（决定载入界面那个小图标）'), textInput(() => m.type, (v) => { m.type = v; })),
      field(t('图标 typeIcon（只有和类型名不一致时才填）'), textInput(() => m.typeIcon, (v) => { if (v) m.typeIcon = v; else delete m.typeIcon; }, { placeholder: t('如 DEC-X → dec-X') })),
      field(t('等级 level（1~3，官方是 1 或 3）'), numInput(() => m.level ?? 1, (v) => { m.level = v; }))),
    h('p', { class: 'hint' }, t('类型名不在官方清单里时，载入界面画的是字母牌而不是官方图标 —— 功能不受影响。')),
    h('h2', {}, t('数值加成 attr（精锐数值＝上面的精锐数值＋这里）')),
    h('p', { class: 'hint' }, t('只有这几个键会被读：{0}。写别的键不会报错，但一个数值也不加。', MODULE_ATTR_KEYS.join(' / '))),
    bbEditor(m.attr, { keys: MODULE_ATTR_KEYS, addLabel: t('＋ 加一条数值') }),
    h('h2', {}, t('特性覆盖（换掉这个干员原本的特性）')),
    h('div', { class: 'grid' },
      field(t('特性文字'), textInput(() => m.traitDesc, (v) => setText(m, 'traitDesc', v))),
      field(t('模组说明（官方那段「装备后…」）'), textInput(() => m.moduleDesc, (v) => setText(m, 'moduleDesc', v)))),
    // 特性自带范围：官方有 4 位干员的特性、6 个模组的特性覆盖带这个字段。引擎里它定义「特性自己那片范围」
    // （例：散射手 def.raw.trait.rangeGrid 就是它的正面加宽区，见 server/sim/professions.js），不写＝用干员原本的范围。
    h('h2', {}, t('特性自带范围 rangeGrid')),
    h('p', { class: 'hint' }, t('特性自己带的那片范围（不是干员的攻击范围）。留空＝这个模组不改范围。')),
    h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
      h('div', { style: 'flex:0 0 230px' }, rangeShapeSelect(() => m.rangeGrid, (g) => { if (g) m.rangeGrid = g; else delete m.rangeGrid; }, t('（没有自带范围）'))),
      Array.isArray(m.rangeGrid) ? h('div', {}, gridPreview(m.rangeGrid), h('div', { class: 'hint' }, t('（这是特性自带的范围）'))) : null),
    h('h2', {}, t('特性黑板 bb')),
    bbEditor(m.traitBb),
    h('h2', {}, t('天赋改写（模组带来的天赋变化）')),
    chBox);
}

// ---- 「以模板新建」的选择器 -----------------------------------------------------------------------------------------

/** 模板来源：官方干员（全新的一对记录）或本包已有干员（复制一份，改 id 即可）。 */
function renderPicker(box) {
  const pack = state.data.packs.find((p) => p.id === state.packId);
  box.append(h('h2', {}, t('以模板新建')));
  box.append(h('p', { class: 'hint' }, t('选一个干员当底子：数值、分支、攻击范围、技能、天赋与外观都会带过来，之后填一个新 id 与名字就能保存。')));
  box.append(h('div', { class: 'row', style: 'margin:10px 0' },
    textInput(() => state.pickQuery, (v) => { state.pickQuery = v; renderEditorKeepingFocus(); }, { placeholder: t('搜索干员（名称 / 代号 / id）') }),
    h('button', { class: 'ghost', onclick: () => { state.picking = false; state.pickQuery = ''; renderShell(); } }, t('返回'))));

  // 本包已有干员：同一份 spec 复制一份，最省事（分支、技能、天赋、外观全是自己刚调好的）
  const own = pack ? pack.specs : [];
  if (own.length) {
    box.append(h('h2', {}, t('复制本包的干员（{0} 个）', own.length)));
    for (const spec of own) {
      box.append(h('div', { class: 'item', onclick: () => duplicateSpec(spec) },
        h('div', { class: 'n' }, spec.name || spec.id),
        h('div', { class: 'm' }, t('id {0} · {1} 阶 · {2}', spec.id, spec.tier, spec.profession))));
    }
  }

  // 官方干员
  const matched = matchOperators(state.data.officialChess, state.pickQuery);
  const LIMIT = 60;
  box.append(h('h2', {}, t('官方干员（匹配 {0} / 共 {1}）', matched.length, state.data.officialChess.length)));
  if (!matched.length) box.append(h('p', { class: 'hint' }, t('（没有匹配的干员）')));
  for (const o of matched.slice(0, LIMIT)) {
    box.append(h('div', {
      class: 'item', title: `${o.id}${o.spine ? ` · ${o.spine}` : ''}`,
      onclick: () => { loadOperatorTemplate(o.id); },
    },
    h('div', { class: 'n' }, o.name || o.id),
    h('div', { class: 'm' }, t('{0} 阶 · {1}{2}', o.tier, o.profession, o.subProfessionId ? ` · ${o.subProfessionId}` : ''))));
  }
  if (matched.length > LIMIT) box.append(h('p', { class: 'hint' }, t('只显示了前 {0} 个，用上面的搜索框缩小范围。', LIMIT)));
}

/** 用官方干员当模板：服务端把一对记录转成 spec（shared/chessAuthoring.js 的 specFromChessRecord）。 */
async function loadOperatorTemplate(chessId) {
  try {
    const r = await api(`/api/operators/template?chessId=${encodeURIComponent(chessId)}`);
    state.spec = r.spec;
    state.slug = null;
    state.picking = false;
    state.preview = null;
    state.message = { kind: 'ok', text: t('已按「{0}」生成模板：请填一个新的 id 与名字（改完会自动校验）。', r.spec.name || chessId) };
    renderShell();
    preview();
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
    renderEditor();
  }
}

/** 复制本包的一个已有干员：只清空 id（那一个必须重填，否则会覆盖原来那份）。 */
function duplicateSpec(spec) {
  const copy = JSON.parse(JSON.stringify(spec));
  copy.id = '';
  state.spec = copy;
  state.slug = null;
  state.picking = false;
  state.preview = null;
  state.message = { kind: 'ok', text: t('已复制「{0}」：填一个新的 id 再保存（改完会自动校验）。', spec.id) };
  renderShell();
  preview();
}

// ---- behaviour ---------------------------------------------------------------------------------------------------

let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 250); }
function previewSoon() { schedulePreview(); }

/**
 * 重画表单但把焦点与光标留原处（实现见 editor/ui/focusKeep.js：怪物页的重画也要用同一条）。
 * 校验是防抖自动跑的，每跑一次就重画一次表单；不还原焦点的话，用户打一半停下来看一眼、再打字，
 * 光标已经不在输入框里了。
 */
function renderEditorKeepingFocus() {
  renderKeepingFocus($('#editor'), renderEditor);
}

async function preview() {
  try {
    state.preview = await api('/api/preview', { method: 'POST', body: { spec: state.spec } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: errText(e) }], warnings: [] };
  }
  renderEditorKeepingFocus();
}

async function save() {
  if (!state.packId) { state.message = { kind: 'error', text: t('先选择一个工坊包（或点「新建工坊包」）') }; renderEditor(); return; }
  state.busy = true; renderEditor();
  try {
    const r = await api(`/api/packs/${state.packId}/operators`, { method: 'POST', body: { spec: state.spec } });
    state.slug = r.slug;
    state.message = { kind: 'ok', text: t('已保存 {0}，生成 {1}。重启游戏服务器后生效。', r.slug, r.generated.join(', ')) };
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
  } finally {
    state.busy = false; renderShell();
  }
}

/**
 * 一键试玩（与包管理页同一个接口）。
 * 保存完最想做的事是「看它在游戏里长什么样」—— 放在干员页就地起一局，省掉「切到包管理页再点」那两步。
 * 已经在跑就先停掉：作者点这个按钮的意思就是「把我刚写的内容加载进去」。
 */
async function playtest(btn) {
  if (state.busy) return;
  state.busy = true;
  const label = btn?.textContent;
  if (btn) btn.textContent = t('正在起…');
  try {
    const cur = await api('/api/playtest').catch(() => null);
    if (cur?.running) await api('/api/playtest/stop', { method: 'POST' });
    const r = await api('/api/playtest/start', { method: 'POST', body: {} });
    state.message = { kind: 'ok', text: t('试玩服务器已就绪（新标签页已打开）：{0}', r.url) };
    if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(r.url, '_blank', 'noopener');
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
  } finally {
    state.busy = false;
    if (btn && label) btn.textContent = label;
    renderEditor();
  }
}

async function remove() {
  if (!state.slug || !confirm(t('删除 {0}？（同时删除它生成的普通与精锐记录）', state.slug))) return;
  try {
    await api(`/api/packs/${state.packId}/operators/${state.slug}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: t('已删除 {0}', state.slug) };
    state.slug = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: errText(e) }; renderShell(); }
}

async function load() {
  state.data = await api('/api/state');
  if (!state.packId && state.data.packs.length) state.packId = state.data.packs[0].id;
  // 官方 id 集合用于「id 撞官方」的即时提示，每次载入算一次就够
  state.officialIdSet = new Set((state.data.officialChess ?? []).map((o) => o.id));
  renderShell();
  if (state.spec) preview();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: errText(e) }; renderEditor(); }));
$('#btnNewPack').addEventListener('click', async () => {
  const id = prompt(t('新工坊包的 id（字母数字下划线短横线，≤32）：'));
  if (!id) return;
  try {
    // creating a pack happens on the first saved operator; remember the target and open a blank form
    state.packId = id.trim();
    state.slug = null;
    state.spec = blankSpec();
    state.preview = null;
    state.message = { kind: 'ok', text: t('保存第一个干员时会创建工坊包 {0}（目录名必须等于 pack.json 的 id）。', state.packId) };
    renderShell();
  } catch (e) { state.message = { kind: 'error', text: errText(e) }; renderEditor(); }
});

// 界面语言：换掉 HTML 里的静态文案、插入右上角切换按钮，换语言后重画一遍（动态文案也要跟着换）。
mountI18n(renderShell);

load().catch((e) => { $('#editor').replaceChildren(h('p', { class: 'err' }, t('载入失败：{0}', errText(e)))); });
