// editor/ui/bond.js — 盟约（羁绊）编辑器（docs/EDITOR.md §盟约）。纯 DOM、无构建步骤、不依赖游戏客户端。
//
// 表单只编辑 **spec**；引擎真正读的那条记录由服务端每次保存时派生（shared/bondAuthoring.js）。
//
// 这一页最要紧的一件事：盟约在引擎里分成三层，作者最容易以为「改了就生效」而其实没有 ——
//   1. 计数与激活（阈值 / 计数模式）：改了立刻影响商店里能不能凑出这个盟约；
//   2. 数据面（权重 / 核心 / 说明 / 成员）：本局禁用抽签、界面显示、盟约弹窗的成员列表；
//   3. 战斗加成：官方 23 条的效果在引擎里**按 id 写死**，数值从记录读 —— 覆盖官方 = 改数值立刻生效；
//      **新增**的盟约没有处理器，必须打开「通用加成」（记录上的 genericBuffs）才会有属性百分比。
// 页面把这三层分开画，并在预览里直接说出「战斗里会 / 不会加东西」。

import { t, mountI18n } from './i18n.js';
import { packSelect } from './packPicker.js';

const $ = (s) => document.querySelector(s);

/** 最简元素构造助手：`h('div', { className, textContent }, …kids)`（与其它页同一套写法）。 */
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  if (kids.length) el.append(...kids);
  return el;
};

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = {
  data: null, packId: null, bondId: null, spec: null, preview: null, message: null, busy: false,
  picking: false, pickQuery: '', members: null, memberQuery: '',
};

/** 常用黑板键（通用加成读的就是这六个）；其余键作者可以自己加。 */
const BB_KEYS = ['base_atk', 'atk_per_stack', 'base_def', 'def_per_stack', 'base_max_hp', 'max_hp_per_stack'];

function blankSpec() {
  return {
    id: '', name: '', isCore: false, bondType: 'REGULAR', bondOrder: 50, identifier: 50, weight: 10,
    iconId: '', countMode: 'BOARD', thresholdTemplate: 'count_threshold_upward', thresholds: [2, 4, 6],
    maxCount: null, countsHand: false, countsGoldenOnly: false, activeType: 'BATTLE',
    isActiveInDeck: false, noStack: false, maxInactiveBondCount: -1,
    desc: '', effectId: '', effectName: '', effectDesc: '',
    bb: { base_atk: 0.1, atk_per_stack: 0.01 }, genericBuffs: true,
  };
}

// ---- 表单小件（与其它页同一套写法） -----------------------------------------------------------------------------

function field(label, input, hint) {
  const d = document.createElement('div');
  const l = document.createElement('label'); l.textContent = label; d.append(l, input);
  if (hint) d.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: hint }));
  return d;
}
function textInput(get, set, attrs = {}) {
  const i = document.createElement('input');
  i.value = get() ?? '';
  Object.assign(i, attrs);
  i.addEventListener('input', () => { set(i.value); schedule(); });
  return i;
}
function numInput(get, set, attrs = {}) {
  const i = document.createElement('input');
  i.type = 'number'; i.step = 'any';
  i.value = get() ?? '';
  Object.assign(i, attrs);
  i.addEventListener('input', () => { set(i.value === '' ? null : Number(i.value)); schedule(); });
  return i;
}
function selectInput(get, set, values, { labels = {}, allowEmpty = false } = {}) {
  const s = document.createElement('select');
  if (allowEmpty) { const o = document.createElement('option'); o.value = ''; o.textContent = t('（无）'); s.append(o); }
  for (const v of values) { const o = document.createElement('option'); o.value = String(v); o.textContent = labels[v] || String(v); s.append(o); }
  s.value = get() == null ? (allowEmpty ? '' : String(values[0])) : String(get());
  s.addEventListener('change', () => { set(s.value === '' ? null : (values.includes(Number(s.value)) ? Number(s.value) : s.value)); schedule(); });
  return s;
}
function checkInput(get, set, label) {
  const lab = document.createElement('label'); lab.className = 'chk';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = get() === true;
  cb.addEventListener('change', () => { set(cb.checked); schedule(); });
  lab.append(cb, document.createTextNode(label));
  return lab;
}
function areaInput(get, set, attrs = {}) {
  const a = document.createElement('textarea');
  a.value = get() ?? '';
  Object.assign(a, attrs);
  a.addEventListener('input', () => { set(a.value); schedule(); });
  return a;
}
/** 阈值：一行「2, 4, 6」就够了，解析时把非正整数丢掉（与 shared/bondAuthoring 同一条规则）。 */
function thresholdsInput(get, set) {
  const i = document.createElement('input');
  i.value = (get() ?? []).join(', ');
  i.addEventListener('input', () => {
    const list = i.value.split(/[,，\s]+/).map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
    set(list);
    schedule();
  });
  return i;
}

// ---- 列表（左栏） -----------------------------------------------------------------------------------------------

/** 左栏的分组：本包的盟约（可编辑）在最上，然后是官方 23 条（点开就是「以它为准新建/覆盖」）。 */
function renderList() {
  const box = $('#list');
  const rows = [];
  const head = (text) => { const d = document.createElement('div'); d.className = 'item'; d.style.cursor = 'default'; d.append(Object.assign(document.createElement('div'), { className: 'm', textContent: text })); return d; };

  const packs = state.data?.packs ?? [];
  const perPack = state.data?.packBonds ?? [];
  rows.push(head(t('本包的盟约（可编辑）')));
  let own = 0;
  for (const pb of perPack) {
    for (const b of pb.bonds) {
      own++;
      const el = document.createElement('div');
      el.className = 'item' + (state.bondId === b.bondId && pb.id === state.packId ? ' on' : '');
      el.append(Object.assign(document.createElement('div'), { className: 'n', textContent: b.name }));
      const meta = [
        pb.id,
        b.isCore ? t('核心') : t('附加'),
        Array.isArray(b.thresholds) && b.thresholds.length ? t('阈值 {0}', b.thresholds.join('/')) : t('（无阈值）'),
        b.official ? t('覆盖官方') : t('新增'),
        b.genericBuffs ? t('通用加成') : t('无通用加成'),
        b.managed ? t('可编辑') : t('手工记录'),
      ].join(' · ');
      el.append(Object.assign(document.createElement('div'), { className: 'm', textContent: meta }));
      if ((b.issues ?? []).some((i) => i.severity === 'error')) {
        el.append(h('span', { className: 'tag err', text: t('有错误') }));
      }
      el.addEventListener('click', () => openBond(pb.id, b.bondId));
      rows.push(el);
    }
  }
  if (!own) rows.push(head(t('这个工坊根下还没有盟约 —— 用「新建盟约」或「以模板新建」')));
  if (!packs.length) rows.push(head(t('还没有工坊包：先新建一个（保存时会创建）')));

  rows.push(head(t('官方盟约（以它为准修改 / 覆盖）')));
  for (const b of state.data?.officialBonds ?? []) {
    const el = document.createElement('div');
    el.className = 'item' + (state.picking && state.pickQuery === b.bondId ? ' on' : '');
    el.append(Object.assign(document.createElement('div'), { className: 'n', textContent: b.name }));
    el.append(Object.assign(document.createElement('div'), {
      className: 'm',
      textContent: [b.bondId, b.isCore ? t('核心') : t('附加'), t('阈值 {0}', (b.thresholds ?? []).join('/')), t('成员 {0}', b.memberCount), b.weight === 0 ? t('永不被禁') : t('权重 {0}', b.weight)].join(' · '),
    }));
    el.addEventListener('click', () => { state.bondId = b.bondId; state.spec = null; state.preview = null; renderList(); renderForm(); templateFrom(b.bondId); });
    rows.push(el);
  }
  box.replaceChildren(...rows);
}

// ---- 表单（中栏） -----------------------------------------------------------------------------------------------

function renderForm() {
  const box = $('#form');
  box.replaceChildren(); // 重画前先清空：不然每次输入都会把整张表单再叠一份
  if (state.picking) return renderPicker(box);
  const s = state.spec;
  if (!s) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一条盟约：本包的可以直接改，官方的点一下就是「以它为准新建/覆盖」。也可以点右上角「新建盟约」。') }));
    return;
  }
  const official = (state.data?.officialBonds ?? []).some((b) => b.bondId === s.id);
  if (official) {
    box.append(h('div', { className: 'banner bad', text: t('你正在**覆盖官方盟约** {0}：保存时会自动写进 pack.json 的 overrides。官方那条效果（引擎里按 id 实现）会读你这里的数值 —— 所以改阈值、改黑板数值立刻生效；但不要打开「通用加成」，那会和官方处理器叠加两次。', s.id) }));
  }

  box.append(h('h2', { text: t('身份') }));
  const idBox = document.createElement('div'); idBox.className = 'panel grid';
  idBox.append(
    field('id', textInput(() => s.id, (v) => { s.id = v; }, { placeholder: t('如 myShip') }), t('引擎与界面都用它：官方 23 条的 id 就是覆盖，新 id 就是新增。')),
    field(t('名称'), textInput(() => s.name, (v) => { s.name = v; }), t('盟约条与详情面板上显示的名字。')),
    field(t('顺序 identifier'), numInput(() => s.identifier, (v) => { s.identifier = v; s.bondOrder = v; }), t('越小越靠前（官方按它排）。')),
    field(t('权重 weight'), numInput(() => s.weight, (v) => { s.weight = v; }), t('0 = 永不被抽进「本局禁用」；官方正式盟约用 10。')),
    field(t('图标 iconId（只是记录上的名字）'), textInput(() => s.iconId, (v) => { s.iconId = v; }, { placeholder: `icon_${s.id || 'myShip'}` }), t('图标是按**盟约 id** 从 `data/assets.json` 的 `bonds` 里取的：新增的盟约没有条目 → 盟约条与详情面板显示一个圆点；覆盖官方盟约则沿用官方图标。')),
  );
  idBox.append(field(t('类型'), selectInput(() => s.bondType, (v) => { s.bondType = v; }, state.data?.bondTypes ?? ['REGULAR'], { labels: { SEASON: t('赛季 SEASON'), REGULAR: t('常规 REGULAR') } })));
  const checks = document.createElement('div'); checks.className = 'row';
  checks.append(checkInput(() => s.isCore, (v) => { s.isCore = v; }, t('核心盟约（isCore：调和 +1 只加核心）')));
  checks.append(checkInput(() => s.isActiveInDeck, (v) => { s.isActiveInDeck = v; }, t('编队里就算生效（isActiveInDeck）')));
  checks.append(checkInput(() => s.noStack, (v) => { s.noStack = v; }, t('不可叠加（noStack）')));
  idBox.append(checks);
  box.append(idBox);

  // ---- 本包自带的图标 ---------------------------------------------------------------------------------------------
  // pack.json 的 `bondIcons` 一个字段（与语音同一套写法）。客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图
  // （public/js/assets.js bondIconUrl），一个包没法给 assets.json 加条目 —— 于是新增盟约在盟约条上只能是一个圆点。
  // 这里把包自带的图接上：装载时叠加层把它写进 `assets.bonds`，URL 走 /workshop-assets 那条唯一路由。
  const packState = (state.data?.packBonds ?? []).find((p) => p.id === state.packId);
  const inPack = !!packState?.bonds?.some((b) => b.bondId === s.id);
  const iconFiles = packState?.iconFiles ?? [];
  const currentIcon = (packState?.bondIcons ?? {})[s.id] ?? '';
  const hasOfficialIcon = (state.data?.iconChoices ?? []).includes(s.iconId);
  const iconBox = document.createElement('div'); iconBox.className = 'panel';
  iconBox.append(h('h2', { text: t('本包自带的图标（可选）') }));
  iconBox.append(h('p', { className: 'hint', text: t('客户端按**盟约 id** 取图：先用本包这张（走 /workshop-assets），没有就看官方清单里有没有这个 id 的图，都没有就是盟约条上的一个圆点。图片要自己先放进 `{0}/assets/`，编辑器不上传素材。', state.packId ?? '（工坊包）') }));
  if (!inPack) {
    iconBox.append(h('p', { className: 'hint', text: t('这个盟约还不在本包里：先保存一次（覆盖官方或新增），再回来给它配图。') }));
  } else {
    const sel = selectInput(() => currentIcon, async (v) => {
      try {
        const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/bond-icons`, { method: 'POST', body: { bondId: s.id, path: v ?? '' } });
        state.message = { kind: 'ok', text: v
          ? t('已把 {0} 的图标设为本包的 {1}', s.id, v)
          : t('已取消 {0} 的自带图标', s.id) };
        await load();
        void r;
      } catch (e) { state.message = { kind: 'error', text: t(e?.message ?? String(e)) }; renderForm(); }
    }, ['', ...iconFiles], { labels: { '': t('（不用本包图标）') } });
    iconBox.append(field(t('图标文件（本包 assets/ 下的图片）'), sel));
    if (!iconFiles.length) {
      iconBox.append(h('p', { className: 'hint', text: t('本包的 `assets/` 里还没有图片：把图标文件放进去（如 assets/bond/{0}.png），再回到这一页挑。', s.id || 'myShip') }));
    }
  }
  iconBox.append(h('p', { className: 'hint', text: hasOfficialIcon
    ? t('官方清单里有 `{0}` 这张图：不配本包图标时，客户端会用它。', s.iconId)
    : t('官方清单里没有 `{0}` 这张图，而客户端**不看** `iconId`、只看盟约 id —— 不配本包图标时这条盟约就是一个圆点。', s.iconId || t('（空）')) }));
  box.append(iconBox);

  box.append(h('h2', { text: t('计数与阈值（谁算成员、几个才算激活）') }));
  const cnt = document.createElement('div'); cnt.className = 'panel grid';
  cnt.append(
    field(t('阈值 thresholds'), thresholdsInput(() => s.thresholds, (v) => { s.thresholds = v; }), t('严格递增的正整数，逗号分隔；第一个就是「激活所需人数」。')),
    field(t('计数模式 countMode'), selectInput(() => s.countMode, (v) => { s.countMode = v; }, state.data?.countModes ?? ['BOARD'], {
      labels: { BOARD: t('BOARD：只数作战区（同名干员只算一次）'), BOARD_AND_DECK: t('BOARD_AND_DECK：作战区 + 整备区'), BOARD_ALL_CHESS: t('BOARD_ALL_CHESS：作战区所有棋子（含同名）') },
    })),
    field(t('阈值模板 thresholdTemplate'), selectInput(() => s.thresholdTemplate, (v) => { s.thresholdTemplate = v; }, state.data?.thresholdTemplates ?? ['count_threshold_upward'], {
      labels: {
        count_threshold_upward: t('count_threshold_upward：人数往上够'),
        count_threshold_downward: t('count_threshold_downward：人数往下算（独行那类）'),
        count_threshold_upward_golden: t('count_threshold_upward_golden：只数精锐'),
      },
    })),
    field(t('生效范围 activeType'), selectInput(() => s.activeType, (v) => { s.activeType = v; }, state.data?.activeTypes ?? ['BATTLE'], {
      labels: { BATTLE: t('BATTLE：只在战斗里'), ALL: t('ALL：全程（含休整期）'), MANI: t('MANI：调和那类特殊处理') },
    })),
    field(t('最大层数 maxCount'), numInput(() => s.maxCount, (v) => { s.maxCount = v; }, { placeholder: t('留空 = 不限') })),
    field(t('未激活时最多记几层'), numInput(() => s.maxInactiveBondCount, (v) => { s.maxInactiveBondCount = v; })),
  );
  const cntChecks = document.createElement('div'); cntChecks.className = 'row';
  cntChecks.append(checkInput(() => s.countsHand, (v) => { s.countsHand = v; }, t('整备区也计数（countsHand）')));
  cntChecks.append(checkInput(() => s.countsGoldenOnly, (v) => { s.countsGoldenOnly = v; }, t('只数精锐（countsGoldenOnly）')));
  cnt.append(cntChecks);
  box.append(cnt);

  box.append(h('h2', { text: t('说明与效果') }));
  const txt = document.createElement('div'); txt.className = 'panel';
  txt.append(field(t('说明 desc'), areaInput(() => s.desc, (v) => { s.desc = v; }, { style: 'min-height:90px' }), t('盟约条与详情面板显示的就是它；效果那一段建议单独写在下面。')));
  const effGrid = document.createElement('div'); effGrid.className = 'grid';
  effGrid.append(
    field(t('效果 id effectId'), textInput(() => s.effectId, (v) => { s.effectId = v; }, { list: 'effectOptions' }), t('只影响界面与效果记录；**战斗加成不看它**（看下面那一段）。')),
    field(t('效果名 effectName'), textInput(() => s.effectName, (v) => { s.effectName = v; })),
  );
  const dl = document.createElement('datalist'); dl.id = 'effectOptions';
  for (const id of state.data?.effectChoices ?? []) { const o = document.createElement('option'); o.value = id; dl.append(o); }
  effGrid.append(dl);
  txt.append(effGrid);
  txt.append(field(t('效果说明 effectDesc'), areaInput(() => s.effectDesc, (v) => { s.effectDesc = v; }, { style: 'min-height:80px' }), t('占位符 {0} 用服务端的数值格式，别在这里写死数字。')));
  box.append(txt);

  box.append(h('h2', { text: t('战斗数值（黑板 bb）') }));
  const bb = document.createElement('div'); bb.className = 'panel';
  bb.append(h('p', { className: 'hint', text: t('这六个键是**通用加成**读的：base_* 是基线、*_per_stack 是每层增量，量纲是比例（0.1 = +10%）。覆盖官方盟约时，官方处理器还会读它自己的那些键（如 炎佑 的 power_bond_char_cnt），照样一起生效。') }));
  bb.append(checkInput(() => s.genericBuffs, (v) => { s.genericBuffs = v; }, t('打开通用加成（genericBuffs）：引擎按上面的键给成员加属性 —— 新增盟约必须打开，否则战斗里什么也不加')));
  const grid = document.createElement('div'); grid.className = 'bbgrid';
  for (const key of BB_KEYS) {
    grid.append(field(key, numInput(() => s.bb?.[key], (v) => { s.bb = { ...(s.bb ?? {}) }; if (v === null) delete s.bb[key]; else s.bb[key] = v; })));
  }
  bb.append(grid);
  const extraKeys = Object.keys(s.bb ?? {}).filter((k) => !BB_KEYS.includes(k));
  if (extraKeys.length) {
    const extra = document.createElement('div'); extra.className = 'grid';
    for (const key of extraKeys) {
      const row = document.createElement('div');
      row.className = 'row';
      row.append(field(key, numInput(() => s.bb?.[key], (v) => { s.bb = { ...(s.bb ?? {}) }; if (v === null) delete s.bb[key]; else s.bb[key] = v; })));
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = t('删掉这个键');
      del.addEventListener('click', () => { const next = { ...(s.bb ?? {}) }; delete next[key]; s.bb = next; renderForm(); schedule(); });
      row.append(del);
      extra.append(row);
    }
    bb.append(h('p', { className: 'hint', text: t('其它黑板键（只有官方处理器会读，新盟约里写了没用）') }), extra);
  }
  const addKey = document.createElement('button'); addKey.className = 'ghost'; addKey.textContent = t('＋ 加一个黑板键');
  addKey.addEventListener('click', () => {
    const key = prompt(t('黑板键名（如 power_bond_char_cnt）：'), '');
    if (!key) return;
    s.bb = { ...(s.bb ?? {}), [key]: 0 };
    renderForm(); schedule();
  });
  bb.append(addKey);
  box.append(bb);

  renderMembers(box);
}

/** 成员：`members` 由干员记录的 `bonds` 推导 —— 这里改的就是那些干员的 spec（只限本包自有的）。 */
function renderMembers(box) {
  box.append(h('h2', { text: t('成员（谁携带这个盟约）') }));
  const panel = document.createElement('div'); panel.className = 'panel';
  const s = state.spec;
  const derived = new Set((state.members ?? []).filter(Boolean));
  panel.append(h('p', { className: 'hint', text: t('成员不是盟约自己说了算：它是**干员的 bonds 列表**推出来的（引擎按干员记录数人）。所以这里勾选等于去改那些干员的 spec —— 只有本包自有的干员能改。') }));
  const search = document.createElement('input');
  search.placeholder = t('搜索干员（名字或 id）');
  search.value = state.memberQuery ?? '';
  search.addEventListener('input', () => { state.memberQuery = search.value; renderForm(); });
  panel.append(search);
  const list = document.createElement('div'); list.className = 'memlist';
  const q = (state.memberQuery ?? '').trim().toLowerCase();
  const ops = (state.data?.operators ?? []).filter((o) => !q || String(o.name).toLowerCase().includes(q) || o.id.toLowerCase().includes(q)).slice(0, 300);
  const ownIds = new Set((state.data?.packBonds ?? []).find((p) => p.id === state.packId)?.specs?.map((x) => x.id) ?? []);
  for (const o of ops) {
    const row = document.createElement('label'); row.className = 'memrow' + (derived.has(o.id) ? ' sel' : '');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = derived.has(o.id);
    // 只有本包自有的干员能改：它的 spec 归本包管。官方干员要改盟约归属，得先把它覆盖进本包（那是另一个明确动作）。
    const own = o.from === state.packId;
    cb.disabled = !own;
    if (!own) cb.title = t('这只干员不归本包管：先把它新建/覆盖进本包，才能改它的盟约归属');
    cb.addEventListener('change', () => toggleMember(o.id, cb.checked));
    row.append(cb, h('span', { text: `${o.name}（${o.id}）` }), h('span', { className: 'dim', text: own ? (o.tier ? t('{0} 阶', o.tier) : '') : o.from }));
    list.append(row);
  }
  panel.append(list);
  if (!ownIds.size) panel.append(h('p', { className: 'hint', text: t('本包还没有自己的干员：先在干员编辑器里建一个（或把它覆盖进本包），再来勾盟约成员。') }));
  box.append(panel);
}

async function toggleMember(chessId, on) {
  if (!state.packId || !state.spec?.id) return;
  state.busy = true;
  try {
    // 先把这个盟约存下来（成员是靠它的 id 推导的），再改干员
    const saved = await api(`/api/packs/${encodeURIComponent(state.packId)}/bonds`, { method: 'POST', body: { spec: cleanSpec() } });
    state.message = { kind: 'ok', text: t('已保存盟约 {0}（生成 {1} 条记录）', saved.bondId, (saved.generated ?? []).length) };
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/bonds/${encodeURIComponent(state.spec.id)}/members`, {
      method: 'POST', body: on ? { add: [chessId] } : { remove: [chessId] },
    });
    state.message = { kind: 'ok', text: on ? t('已把 {0} 加入这个盟约', chessId) : t('已把 {0} 移出这个盟约', chessId) };
    state.members = r.members ?? [];
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
    renderSide();
  } finally {
    state.busy = false;
  }
}

function renderPicker(box) {
  box.append(h('h2', { text: t('以模板新建') }));
  const panel = document.createElement('div'); panel.className = 'panel';
  panel.append(h('p', { className: 'hint', text: t('挑一条现成的盟约当底子：阈值、计数模式、说明与黑板数值都会带过来，改个新 id 与名字就能保存。') }));
  const input = document.createElement('input');
  input.placeholder = t('搜索盟约（名字或 id）');
  input.value = state.pickQuery;
  input.addEventListener('input', () => { state.pickQuery = input.value; renderForm(); });
  panel.append(input);
  for (const b of state.data?.officialBonds ?? []) {
    const q = state.pickQuery.trim().toLowerCase();
    if (q && !String(b.name).toLowerCase().includes(q) && !b.bondId.toLowerCase().includes(q)) continue;
    const el = document.createElement('div'); el.className = 'item';
    el.append(h('div', { className: 'n', text: `${b.name}（${b.bondId}）` }));
    el.append(h('div', { className: 'm', text: t('阈值 {0} · 成员 {1} · {2}', (b.thresholds ?? []).join('/'), b.memberCount, b.isCore ? t('核心') : t('附加') ) }));
    el.addEventListener('click', () => templateFrom(b.bondId));
    panel.append(el);
  }
  box.append(panel);
}

async function templateFrom(bondId) {
  try {
    const r = await api(`/api/bonds/template?bondId=${encodeURIComponent(bondId)}`);
    const spec = { ...r.spec, id: '' };
    state.spec = spec;
    state.picking = false;
    state.preview = null;
    state.members = await membersOf(bondId);
    renderList(); renderForm(); renderSide();
    schedule(true);
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
    renderSide();
  }
}

async function membersOf(bondId) {
  // 成员列表来自 /api/bonds 的 operators（每个干员带自己的 bonds），所以不必再来一个接口
  return (state.data?.operators ?? []).filter((o) => (o.bonds ?? []).includes(bondId)).map((o) => o.id);
}

const cleanSpec = () => Object.fromEntries(Object.entries(state.spec || {}).filter(([k]) => !k.startsWith('_')));

// ---- 校验预览（防抖） -------------------------------------------------------------------------------------------

let timer = null;
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(preview, now ? 0 : 250);
}
async function preview() {
  if (!state.spec) return;
  try {
    state.preview = await api('/api/bonds/preview', { method: 'POST', body: { spec: cleanSpec(), packId: state.packId } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: e.message }], warnings: [] };
  }
  renderSide();
}

async function openBond(packId, bondId) {
  state.packId = packId;
  state.bondId = bondId;
  state.picking = false;
  const pb = (state.data?.packBonds ?? []).find((p) => p.id === packId);
  const spec = (pb?.specs ?? []).find((s) => s.id === bondId);
  if (spec) {
    state.spec = JSON.parse(JSON.stringify(spec));
    state.members = await membersOf(bondId);
    renderList(); renderForm(); renderSide(); schedule(true);
    return;
  }
  // 没有 spec 的记录（手工写的）：以它的记录内容为底子转一份 spec，保存时会成为这个包里可编辑的那一条
  try {
    const r = await api(`/api/bonds/template?bondId=${encodeURIComponent(bondId)}`);
    state.spec = { ...r.spec, id: bondId };
    state.members = await membersOf(bondId);
    state.message = { kind: 'warn', text: t('这条记录没有 spec（手写或 CLI 写的）：下面显示的是从记录转回来的内容，保存后它就成为这个包可编辑的盟约。') };
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
  }
  renderList(); renderForm(); renderSide(); schedule(true);
}

// ---- 右侧：预览 + 保存 -----------------------------------------------------------------------------------------

function renderSide() {
  const box = $('#side');
  const rows = [];
  const s = state.spec;
  if (state.message) {
    const cls = state.message.kind === 'error' ? 'banner bad' : state.message.kind === 'warn' ? 'banner' : 'banner good';
    rows.push(h('div', { className: cls, text: state.message.text }));
  }
  if (!s) { rows.push(h('p', { className: 'hint', text: t('左边选一条盟约，或点右上角「新建盟约」。') })); box.replaceChildren(...rows); return; }

  rows.push(h('h2', { text: t('预览') }));
  const pv = document.createElement('div'); pv.className = 'panel';
  const official = (state.data?.officialBonds ?? []).some((b) => b.bondId === s.id);
  pv.append(h('p', { className: 'hint', text: official ? t('这是**覆盖官方盟约**：引擎里那条效果会读你这里的数值。') : t('这是**新增盟约**：计数、阈值、禁用抽签、界面都会生效；战斗加成看下面那行。') }));
  const ladder = document.createElement('div'); ladder.className = 'ladder';
  (s.thresholds ?? []).forEach((n, i) => {
    ladder.append(h('div', { class: 'step' }, h('b', { text: `${n}` }), document.createTextNode(t('{0} 名 → 第 {1} 档', n, i + 1))));
  });
  if (!(s.thresholds ?? []).length) ladder.append(h('span', { className: 'warn', text: t('没有阈值：它永远不会激活') }));
  pv.append(ladder);
  pv.append(h('p', { className: 'hint', text: t('计数模式：{0} · 生效范围：{1} · 成员 {2} 名', s.countMode ?? '', s.activeType ?? '', (state.members ?? []).length) }));
  pv.append(h('p', {
    className: 'hint',
    text: s.weight === 0 ? t('权重 0：它永远不会被抽进「本局禁用」。') : t('权重 {0}：会和其它正式盟约一起被抽进「本局禁用」。', s.weight),
  }));
  const generic = Object.entries(s.bb ?? {}).filter(([k]) => BB_KEYS.includes(k) && k.startsWith('base_'));
  const line = generic.length
    ? generic.map(([k]) => {
      const per = s.bb[`${k.slice('base_'.length)}_per_stack`] ?? 0;
      return `${k.slice('base_'.length)} ${Math.round((s.bb[k] ?? 0) * 1000) / 10}%${per ? ` +${Math.round(per * 1000) / 10}%/层` : ''}`;
    }).join(' · ')
    : '';
  if (s.genericBuffs) {
    pv.append(h('p', { className: line ? 'ok' : 'warn', text: line ? t('✔ 战斗里会加：{0}', line) : t('⚠ 打开了通用加成，但六个键一个都没写 —— 战斗里不会有任何加成') }));
  } else if (!official) {
    pv.append(h('p', { className: 'warn', text: t('⚠ 新盟约且没打开通用加成：战斗里不会加任何东西（只有计数 / 阈值 / 禁用抽签 / 界面）') }));
  } else {
    pv.append(h('p', { className: 'ok', text: t('✔ 战斗加成由官方那条效果负责（数值就是你这里的 bb）') }));
  }
  rows.push(pv);

  rows.push(h('h2', { text: t('校验') }));
  const check = document.createElement('div'); check.className = 'panel';
  if (!state.preview) check.append(h('p', { className: 'hint', text: t('（改动后自动校验）') }));
  else {
    if (state.preview.ok && !(state.preview.warnings ?? []).length) check.append(h('div', { className: 'ok', text: t('✔ 校验通过') }));
    for (const e of state.preview.errors ?? []) {
      check.append(h('div', { className: 'err', text: `${e.field || t('（记录）')} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}` }));
    }
    for (const w of state.preview.warnings ?? []) check.append(h('div', { className: 'warn', text: String(w) }));
  }
  rows.push(check);

  rows.push(h('h2', { text: t('保存') }));
  const actions = document.createElement('div'); actions.className = 'row';
  const save = document.createElement('button'); save.className = 'primary';
  save.textContent = state.busy ? t('保存中…') : (official ? t('保存为覆盖官方') : t('保存盟约'));
  save.disabled = state.busy || !s.id || !s.name;
  save.addEventListener('click', saveBond);
  actions.append(save);
  if (state.bondId) {
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = t('删除这条盟约');
    del.disabled = state.busy;
    del.addEventListener('click', deleteBond);
    actions.append(del);
  }
  rows.push(actions);
  rows.push(h('p', { className: 'hint', text: t('保存写两处：`bond-specs/<id>.json`（可编辑的源）与 `bonds.json`（游戏读的产物），并保证 pack.json 的 content 声明了 bonds、覆盖官方时声明了 overrides。') }));

  rows.push(h('h2', { text: t('保存到') }));
  const packBox = document.createElement('div'); packBox.className = 'panel';
  packBox.append(packSelect({
    packs: state.data?.packs ?? [],
    current: state.packId,
    newLabel: t('＋ 新建一个包…'),
    onPick: (id) => { state.packId = id; renderSide(); },
    askNewId: () => prompt(t('新工坊包的 id（字母数字下划线短横线，≤32）：'), 'my-bond-pack'),
  }));
  rows.push(packBox);

  box.replaceChildren(...rows);
}

async function saveBond() {
  if (!state.packId) { state.message = { kind: 'error', text: t('先在下面选一个工坊包（或点「＋ 新建一个包…」）。') }; renderSide(); return; }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/bonds`, { method: 'POST', body: { spec: cleanSpec() } });
    state.bondId = r.bondId;
    state.message = {
      kind: 'ok',
      text: r.overriding
        ? t('已覆盖官方盟约 {0}（生成 {1} 条记录）', r.bondId, (r.generated ?? []).length)
        : t('已保存盟约 {0}（生成 {1} 条记录）', r.bondId, (r.generated ?? []).length),
    };
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
  } finally {
    state.busy = false; renderSide();
  }
}

async function deleteBond() {
  if (!state.bondId || !state.packId) return;
  if (!confirm(t('删除盟约 {0}（连同它的 spec）？覆盖官方的记录会被删掉，官方那条会回来。', state.bondId))) return;
  state.busy = true; renderSide();
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/bonds/${encodeURIComponent(state.bondId)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: t('已删除 {0}', state.bondId) };
    state.bondId = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
  } finally {
    state.busy = false; renderSide();
  }
}

async function load() {
  state.data = await api('/api/bonds');
  const own = (state.data.packBonds ?? []).reduce((n, p) => n + p.bonds.length, 0);
  $('#rootPath').textContent = own
    ? t('{0} 条工坊盟约 · 官方 {1} 条', own, state.data.officialCount)
    : t('还没有工坊盟约 · 官方 {0} 条', state.data.officialCount);
  if (!state.packId) state.packId = state.data.packs?.[0]?.id ?? null;
  renderList();
  if (!state.spec) renderForm();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().then(() => { if (state.spec) schedule(true); }).catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => {
  state.bondId = null; state.spec = blankSpec(); state.preview = null; state.picking = false; state.members = [];
  renderList(); renderForm(); renderSide(); schedule(true);
});
$('#btnTemplate').addEventListener('click', () => {
  state.picking = true; state.pickQuery = ''; state.spec = null; state.bondId = null; state.preview = null;
  renderList(); renderForm(); renderSide();
});

mountI18n(() => { renderList(); renderForm(); renderSide(); });

load().then(() => { if (state.spec) schedule(true); }).catch((e) => {
  $('#side').replaceChildren(h('p', { className: 'err', text: t('载入失败：{0}', e.message) }));
});
