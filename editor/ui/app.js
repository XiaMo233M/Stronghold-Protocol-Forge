// editor/ui/app.js — the workshop editor's front end. Plain DOM, native ES modules, no build step, no dependency on
// the game client (which never loads this file). It talks to editor/server.mjs and, through it, to the SAME
// shared/chessAuthoring.js the CLIs and an AI use — so the editor cannot drift from the validator.
//
// 界面文案走 i18n：t('中文原文') 查英文词典，查不到就原样返回中文（editor/ui/i18n.js 说明了这个取舍）。

import { t, mountI18n } from './i18n.js';
// 服务端把 /shared/ 也挂给了编辑器界面，所以这几个模块在浏览器与 node 下是同一个文件：
// 范围与伤害分类的推导规则只有一份（shared/chessAuthoring.js），界面显示的就是引擎真正会用的那份。
import { classify, DEFAULT_MELEE_RANGE, DEFAULT_RANGED_RANGE } from '../../shared/chessAuthoring.js';
import {
  matchOperators, idConflict, renameNotice,
  subProfessionChoices, rangePresets, gridKey, gridMatrix,
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
function select(list, get, set) {
  const el = h('select', { onchange: (e) => { set(e.target.value); schedulePreview(); } });
  for (const v of list) el.append(h('option', { value: v, selected: get() === v }, v));
  return el;
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

/** 表单没给 rangeGrid 时引擎实际会用的形状（规则与 shared/chessAuthoring.js 完全一致）。 */
function defaultGrid(s) {
  const cls = classify({ profession: s.profession, subProfessionId: s.subProfessionId, position: s.position, traitDesc: s.traitDesc });
  return (cls.attackKind === 'melee' || cls.attackKind === 'none') ? DEFAULT_MELEE_RANGE : DEFAULT_RANGED_RANGE;
}

const dmgLabel = (v) => (v === 'arts' ? t('法术') : (v === 'heal' ? t('治疗') : t('物理')));
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

  // identity
  const pack = state.data.packs.find((p) => p.id === state.packId);
  const conflict = idConflict(s.id, { packSlugs: pack ? pack.specs.map((x) => x.id) : [], officialIds: state.officialIdSet });
  const rename = renameNotice(state.slug, s.id);
  box.append(h('div', { class: 'panel' }, h('div', { class: 'grid' },
    field(t('id（slug，决定 chess_ws_<id>_a/_b）'), h('div', {},
      textInput(() => s.id, (v) => { s.id = v; }),
      conflict ? h('div', { class: 'hint err' }, conflict.kind === 'pack'
        ? t('这个 id 已被本包占用：{0}', conflict.id)
        : t('这个 id 与官方记录相同，不进 overrides 的话会被丢弃：{0}', conflict.id)) : null,
      rename ? h('div', { class: 'hint warn' }, t('改了 id：保存会新建一份记录，原来的 {0} 仍留在包里（要自己删）', rename.from)) : null)),
    field(t('名称'), textInput(() => s.name, (v) => { s.name = v; })),
    field(t('英文代号'), textInput(() => s.appellation, (v) => { s.appellation = v; })),
    field(t('阶（tier）'), numInput(() => s.tier, (v) => { s.tier = v; })),
    field(t('职业'), select(PROFESSIONS, () => s.profession, (v) => { s.profession = v; })),
    // 分支决定攻击方式、伤害类型与能否打空 —— 以前只能手打英文，还给不出候选
    field(t('分支 subProfessionId'), h('div', {},
      textInput(() => s.subProfessionId, (v) => { s.subProfessionId = v; }, { placeholder: t('如 fastshot / fortress / bard'), list: 'subProfOptions' }),
      h('datalist', { id: 'subProfOptions' }, subProfessionChoices(state.data.officialChess).map((v) => h('option', { value: v }))))),
    field(t('位置'), select(['MELEE', 'RANGED'], () => s.position, (v) => { s.position = v; })),
    field(t('特性文字（只影响伤害类型推导）'), textInput(() => s.traitDesc, (v) => { s.traitDesc = v; })))));

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
  box.append(h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, t('外观（仓库不含素材，只能复用已有 Spine id）')),
    h('div', { class: 'grid' }, field('assetsSpine', spineSel), field(t('或直接填 id'), textInput(() => s.assetsSpine, (v) => { s.assetsSpine = v; }))),
    spineHint));

  // 攻击范围与伤害分类：表单以前完全没有范围的入口（连默认值是多少都看不到），现在能挑官方形状并直接看小格阵
  const cls = classify({ profession: s.profession, subProfessionId: s.subProfessionId, position: s.position, traitDesc: s.traitDesc });
  const effGrid = Array.isArray(s.rangeGrid) ? s.rangeGrid : defaultGrid(s);
  const presets = rangePresets(state.data.officialChess);
  const curKey = Array.isArray(s.rangeGrid) ? gridKey(s.rangeGrid) : '';
  const rangeSel = h('select', {
    onchange: (e) => {
      const p = presets.find((x) => x.key === e.target.value);
      if (p) s.rangeGrid = p.grid.map((c) => [...c]);
      else delete s.rangeGrid;
      schedulePreview(); renderEditorKeepingFocus();
    },
  }, h('option', { value: '', selected: !curKey }, t('（默认：按职业与分支推导）')));
  for (const p of presets) rangeSel.append(h('option', { value: p.key, selected: curKey === p.key }, t('{0} 格 · 例：{1}', p.count, p.sample.name)));
  box.append(h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, t('攻击范围与伤害分类')),
    h('div', { class: 'row', style: 'align-items:flex-start;gap:16px' },
      h('div', { style: 'flex:0 0 230px' }, field(t('范围形状'), rangeSel)),
      h('div', {}, gridPreview(effGrid), Array.isArray(s.rangeGrid) ? null : h('div', { class: 'hint' }, t('（这是推导出的默认形状）'))),
      h('p', { class: 'hint', style: 'flex:1' }, t('伤害类型 {0} · 攻击方式 {1} · 可打空中 {2}', dmgLabel(cls.dmgType), kindLabel(cls.attackKind), cls.canHitFly ? t('是') : t('否'))))));

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
        field(t('再部署 respawnTime'), numInput(() => st.respawnTime ?? 70, (v) => { st.respawnTime = v; }))));
  };
  box.append(h('div', { class: 'split' }, statBlock('normal', t('普通状态数值')), statBlock('golden', t('精锐状态数值'))));
  if (refs.maxHp) box.append(h('p', { class: 'hint' }, t('细线上的刻度是官方同类干员的区间（按职业统计，共 {0} 名），不是硬性上限。', refs.maxHp.count)));

  // skill
  const sk = s.skill ?? (s.skill = blankSpec().skill);
  const bbBox = h('div', {});
  const drawBb = () => {
    bbBox.replaceChildren();
    for (const [key, val] of Object.entries(sk.bb || {})) {
      bbBox.append(h('div', { class: 'kv' },
        h('input', { value: key, onchange: (e) => { const old = key; const v = sk.bb[old]; delete sk.bb[old]; sk.bb[e.target.value] = v; schedulePreview(); drawBb(); } }),
        h('input', { type: 'number', step: 'any', value: val, oninput: (e) => { sk.bb[key] = Number(e.target.value); schedulePreview(); } }),
        h('button', { class: 'ghost', onclick: () => { delete sk.bb[key]; schedulePreview(); drawBb(); } }, '×')));
    }
  };
  drawBb();
  box.append(h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, t('技能（黑板书键不需要写 JavaScript）')),
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
    bbBox,
    h('button', { class: 'ghost', onclick: () => { sk.bb = sk.bb || {}; sk.bb.new_key = 0; drawBb(); } }, t('＋ 加一个键'))));

  // talents (天赋): the authoring layer already turns spec.talents into the record's talents[] (name/desc/bb), so this
  // is purely the missing form. A talent with no desc is emitted `hidden: true` by the derive layer, which is why the
  // hint below insists on the description — a talent nothing can read is a talent that does nothing.
  s.talents = Array.isArray(s.talents) ? s.talents : [];
  const talBox = h('div', {});
  const drawTalents = () => {
    talBox.replaceChildren();
    s.talents.forEach((t_, i) => {
      const bbBox2 = h('div', {});
      const drawTb = () => {
        bbBox2.replaceChildren();
        for (const [key, val] of Object.entries(t_.bb || {})) {
          bbBox2.append(h('div', { class: 'kv' },
            h('input', { value: key, onchange: (e) => { const old = key; const v = t_.bb[old]; delete t_.bb[old]; t_.bb[e.target.value] = v; schedulePreview(); drawTb(); } }),
            h('input', { type: 'number', step: 'any', value: val, oninput: (e) => { t_.bb[key] = Number(e.target.value); schedulePreview(); } }),
            h('button', { class: 'ghost', onclick: () => { delete t_.bb[key]; schedulePreview(); drawTb(); } }, '×')));
        }
        bbBox2.append(h('button', { class: 'ghost', onclick: () => { t_.bb = t_.bb || {}; t_.bb.new_key = 0; drawTb(); } }, t('＋ 加一个键')));
      };
      drawTb();
      talBox.append(h('div', { class: 'panel' },
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('strong', {}, t('天赋 {0}', i + 1)),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'ghost', onclick: () => { s.talents.splice(i, 1); schedulePreview(); drawTalents(); } }, t('× 删除'))),
        h('div', { class: 'grid' },
          field(t('天赋名'), textInput(() => t_.name, (v) => { t_.name = v; })),
          field(t('说明（必填，否则该天赋被视为隐藏）'), textInput(() => t_.desc, (v) => { t_.desc = v; }))),
        h('h2', {}, t('天赋黑板 bb')),
        bbBox2));
    });
  };
  drawTalents();
  box.append(h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, t('天赋 tactics（0~2 条，建议 2 条：普通/精锐共用）')),
    h('p', { class: 'hint' }, t('说明（desc）是必须的：没有说明的天赋在记录里会被标记为 hidden。黑板键同样是通用 kit 认识的键，写错只会警告、不会有任何效果。')),
    talBox,
    h('button', {
      class: 'ghost',
      onclick: () => {
        s.talents.push({ name: t('天赋 {0}', s.talents.length + 1), desc: '', bb: {} });
        schedulePreview(); drawTalents();
      },
    }, t('＋ 添加一条天赋'))));

  // support switch (the 是否助战 toggle)
  if (state.slug) {
    const baseId = `chess_ws_${state.slug}_a`;
    const tier = s.tier;
    const pool = state.data.support.pool[tier] || [];
    const isSupport = pool.includes(baseId);
    box.append(h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, t('助战（写入 data/support.json 的服务端卡池）')),
      h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--fg)' },
        h('input', {
          type: 'checkbox', checked: isSupport, style: 'width:auto',
          onchange: async (e) => {
            try {
              await api('/api/support/toggle', { method: 'POST', body: { chessId: baseId, tier, enabled: e.target.checked } });
              state.message = { kind: 'ok', text: e.target.checked
                ? t('{0} 已加入 {1} 阶助战卡池（重启游戏服务器后生效）', s.name || baseId, tier)
                : t('{0} 已移出 {1} 阶助战卡池（重启游戏服务器后生效）', s.name || baseId, tier) };
              await load();
            } catch (err) { state.message = { kind: 'error', text: errText(err) }; renderEditor(); }
          },
        }),
        t('把 {0} 加入 {1} 阶助战卡池', baseId, tier)),
      h('p', { class: 'hint' }, t('当前 {0} 阶卡池：{1}', tier, pool.length ? pool.join(', ') : t('（空）')))));
  }

  // actions + validation
  const actions = h('div', { class: 'row', style: 'margin:14px 0' },
    h('button', { class: 'primary', disabled: state.busy || !state.packId, onclick: save }, state.busy ? t('保存中…') : t('保存并生成')),
    state.slug ? h('button', { onclick: remove }, t('删除该干员')) : null,
    h('button', { class: 'ghost', onclick: () => { state.spec = blankSpec(); state.slug = null; schedulePreview(); renderShell(); } }, t('清空表单')));
  box.append(actions);
  if (!state.packId) box.append(h('p', { class: 'hint' }, t('先在上方选择一个工坊包（或点「新建工坊包」），才能保存。')));

  const pv = state.preview;
  const panel = h('div', { class: 'panel' });
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
  box.append(h('h2', {}, t('校验结果')), panel);
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
