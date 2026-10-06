// editor/ui/enemy.js — the monster editor page (docs/EDITOR.md). Plain DOM, no build step, no game-client import.
//
// The form edits the SPEC only; `attrPower` and `be` are DERIVED server-side on every keystroke (debounced) through
// /api/enemies/preview, and shown as read-only readouts. They are not cosmetic: `be` drives the per-faction enemy
// replacement count, so a hand-typed value silently swaps the wrong number of enemies.
//
// 界面文案走 i18n.js：t('中文原文') 查 editor/ui/i18n.en.enemy.js 的英文词典，查不到就原样退回中文。

import { t, mountI18n } from './i18n.js';
// 新建更容易的三样：模板挑选与 spine 校验（纯逻辑，单测在 test/enemyWizard.test.js）、数值尺子（与干员页共用）。
import { matchEnemies, sortTemplates, spineIsKnown } from './enemyWizard.js';
import { makeStatBar } from './statScale.js';
import { renderKeepingFocus } from './focusKeep.js';
import { packSelect } from './packPicker.js';

const $ = (s) => document.querySelector(s);

/** 最简元素构造助手：数值尺子是干员页与怪物页共用的，它按 h(tag, attrs, …kids) 的形式要元素。 */
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
};

/** 数值尺子：按档位（NORMAL/ELITE/BOSS）给官方区间。 */
const statBar = makeStatBar(h, t);

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = {
  data: null, packId: null, key: null, spec: null, preview: null, message: null, busy: false,
  // 「以模板新建」的选择器：是否打开、搜索串
  picking: false, pickQuery: '',
};

/** The stat fields, with the label and the unit the form shows. Order matters: it is the order on screen.
 *  A function rather than a constant: the labels are translated per render, so they follow the language switch. */
const STAT_FIELDS = () => [
  ['maxHp', t('生命上限')], ['atk', t('攻击')], ['def', t('防御')], ['res', t('法抗')],
  ['moveSpeed', t('移动速度')], ['bat', t('攻击间隔(秒)')], ['aspd', t('攻速')], ['rangeRadius', t('射程(格)')],
  ['blockCnt', t('阻挡数')], ['massLevel', t('重量等级')], ['lpr', t('生命恢复比例')], ['hpRecoveryPerSec', t('每秒回血')],
  ['elementRes', t('元素抗性')], ['elementDmgRes', t('元素伤害抗性')], ['hitRatePhys', t('物理命中率')], ['hitRateArts', t('法术命中率')],
  ['tauntLevel', t('嘲讽等级')],
];

function blankSpec() {
  const stats = {};
  for (const [k] of STAT_FIELDS()) stats[k] = state.data?.vocab?.statDefaults?.[k] ?? 0;
  stats.maxHp = 1000; stats.atk = 100; stats.moveSpeed = 1; stats.bat = 1.2;
  return {
    id: '', name: '', rank: 'NORMAL', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys', desc: '',
    stats, abilities: [], talents: { bb: {} }, skills: [], tags: [], immunities: {}, otherImmunities: [],
    acTypes: [], acType: null, spine: '', modelScale: null, hitArea: null, attackAnim: null,
    beFactor: 1, notCountInTotal: false, isFlyEnemy: undefined,
  };
}

/** The spec sent to the server, built from the spec object (numeric fields already numbers). */
const currentSpec = () => Object.fromEntries(Object.entries(state.spec || {}).filter(([k]) => !k.startsWith('_')));

// ---- form -------------------------------------------------------------------------------------------------------

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
  i.value = get() ?? 0;
  Object.assign(i, attrs);
  i.addEventListener('input', () => { set(i.value === '' ? null : Number(i.value)); schedule(); });
  return i;
}
function selectInput(get, set, values, { labels = {}, allowEmpty = false } = {}) {
  const s = document.createElement('select');
  if (allowEmpty) { const o = document.createElement('option'); o.value = ''; o.textContent = t('（无）'); s.append(o); }
  for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = labels[v] || v; s.append(o); }
  s.value = get() ?? (allowEmpty ? '' : values[0]);
  s.addEventListener('change', () => { set(s.value === '' ? null : s.value); schedule(); });
  return s;
}
function checkInput(get, set, label) {
  const lab = document.createElement('label'); lab.className = 'chk';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = get() === true;
  cb.addEventListener('change', () => { set(cb.checked); schedule(); });
  lab.append(cb, document.createTextNode(label));
  return lab;
}

function renderForm() {
  const box = $('#form');
  box.replaceChildren();
  if (state.picking) { renderPicker(box); return; }
  const spec = state.spec;
  if (!spec) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一只怪物，或点「新建怪物」。') }));
    return;
  }
  const h = (text) => { const e = document.createElement('h2'); e.textContent = text; return e; };
  const desc = () => Object.assign(document.createElement('p'), { className: 'hint', textContent: t('这些字段下面是推导量，不要手写。') });

  box.append(h(t('身份')));
  const idBox = document.createElement('div'); idBox.className = 'panel';
  const idGrid = document.createElement('div'); idGrid.className = 'grid wide';
  idGrid.append(
    field(t('id（slug）'), textInput(() => spec.id, (v) => { spec.id = v; }), t('会生成 enemy_ws_<id>，例如 frost_hound')),
    field(t('名称'), textInput(() => spec.name, (v) => { spec.name = v; })),
    field(t('等级 rank'), selectInput(() => spec.rank, (v) => { spec.rank = v; }, state.data.vocab.ranks,
      { labels: { NORMAL: t('NORMAL 普通'), ELITE: t('ELITE 精英'), BOSS: t('BOSS 领袖') } })),
    field(t('攻击方式'), selectInput(() => spec.applyWay, (v) => { spec.applyWay = v; }, state.data.vocab.applyWays)),
    field(t('伤害类型'), selectInput(() => spec.dmgType, (v) => { spec.dmgType = v; }, state.data.vocab.dmgTypes,
      { labels: { phys: t('phys 物理'), arts: t('arts 法术'), none: t('none 无攻击') } })),
    field(t('移动方式'), selectInput(() => spec.motion, (v) => { spec.motion = v; }, state.data.vocab.motions,
      { labels: { WALK: t('WALK 地面'), FLY: t('FLY 飞行') } })),
  );
  idBox.append(idGrid);
  idBox.append(field(t('描述'), textInput(() => spec.desc, (v) => { spec.desc = v; })));
  const flags = document.createElement('div'); flags.className = 'row'; flags.style.marginTop = '8px';
  flags.append(
    checkInput(() => spec.isFlyEnemy, (v) => { spec.isFlyEnemy = v; }, t('飞行单位（不填则跟随移动方式）')),
    checkInput(() => spec.notCountInTotal, (v) => { spec.notCountInTotal = v; }, t('不计入总数')),
  );
  idBox.append(flags);
  box.append(idBox);

  box.append(h(t('数值 stats')));
  const statBox = document.createElement('div'); statBox.className = 'panel';
  const grid = document.createElement('div'); grid.className = 'grid';
  // 每个数值下面一根尺子：官方同档位（普通/精英/领袖）的区间。以前这些数字全是拍出来的。
  const refs = state.data?.statRanges?.[spec.rank] ?? {};
  for (const [k, label] of STAT_FIELDS()) {
    const cell = document.createElement('div');
    cell.append(numInput(() => spec.stats[k], (v) => { spec.stats[k] = v; }));
    const bar = statBar(spec.stats[k], refs[k]);
    if (bar) cell.append(bar);
    grid.append(field(label, cell));
  }
  statBox.append(grid);
  if (refs.maxHp) statBox.append(Object.assign(document.createElement('p'), {
    className: 'hint', textContent: t('细线上的刻度是官方同档位怪物的区间（共 {0} 只），只作参照，不是上限。', refs.maxHp.count),
  }));
  statBox.append(desc());
  box.append(statBox);

  box.append(h(t('特殊机制')));
  const mechBox = document.createElement('div'); mechBox.className = 'panel';
  mechBox.append(field(t('能力说明（abilities，一行一条，游戏里显示的那几行）'),
    areaInput(() => (spec.abilities || []).map((a) => a.text).join('\n'), (v) => { spec.abilities = v.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => ({ text: line })); })));
  // talents.bb: the blackboard the engine reads
  const bbWrap = document.createElement('div');
  bbWrap.append(Object.assign(document.createElement('label'), { textContent: t('天赋黑板 talents.bb（键 → 数值）') }));
  const bbList = document.createElement('div'); bbList.id = 'bbList';
  const bbEntries = Object.entries(spec.talents?.bb || {});
  bbEntries.forEach(([k, v], i) => {
    const row = document.createElement('div'); row.className = 'kv';
    const ki = document.createElement('input'); ki.value = k;
    const vi = document.createElement('input'); vi.type = 'number'; vi.step = 'any'; vi.value = v;
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    const commit = () => {
      const out = {};
      for (const [kk, vv] of Object.entries(spec.talents.bb)) out[kk === k ? ki.value : kk] = vv;
      out[ki.value] = Number(vi.value);
      delete out[k];
      spec.talents.bb = out;
      schedule();
    };
    ki.addEventListener('change', commit);
    vi.addEventListener('change', commit);
    del.addEventListener('click', () => { delete spec.talents.bb[k]; renderForm(); schedule(); });
    row.append(ki, vi, del);
    bbList.append(row);
  });
  bbWrap.append(bbList);
  const addBb = document.createElement('button'); addBb.className = 'ghost'; addBb.textContent = t('＋ 加一个键');
  addBb.addEventListener('click', () => { spec.talents.bb = { ...(spec.talents.bb || {}), '': 0 }; renderForm(); });
  bbWrap.append(addBb);
  mechBox.append(bbWrap);
  mechBox.append(field(t('技能 skills（JSON 数组；每项形如 { prefabKey, priority, cooldown, bb }）'),
    areaInput(() => JSON.stringify(spec.skills || [], null, 2), (v) => {
      try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) { spec.skills = parsed; spec._skillsBad = false; } else spec._skillsBad = true; }
      catch { spec._skillsBad = true; }
      renderSide();
    })));
  const acRow = document.createElement('div'); acRow.className = 'grid wide';
  acRow.append(
    field(t('能力分类 acType'), selectInput(() => spec.acType, (v) => { spec.acType = v; }, state.data.vocab.acTypes, { allowEmpty: true })),
    field(t('标记 tags（逗号分隔）'), textInput(() => (spec.tags || []).join(','), (v) => { spec.tags = v.split(',').map((s) => s.trim()).filter(Boolean); })),
  );
  mechBox.append(acRow);
  const imm = document.createElement('div'); imm.className = 'row';
  for (const k of state.data.vocab.immunities) {
    imm.append(checkInput(() => spec.immunities?.[k], (v) => { spec.immunities = { ...(spec.immunities || {}), [k]: v }; }, t('免疫 {0}', k)));
  }
  mechBox.append(imm);
  box.append(mechBox);

  box.append(h(t('美术与非数据表字段')));
  const artBox = document.createElement('div'); artBox.className = 'panel';
  artBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('这些字段不在游戏数据表里（来自客户端清单），所以必须手填。spine 复用现有怪物的 prefab 键才有真美术。') }));
  const artGrid = document.createElement('div'); artGrid.className = 'grid wide';
  artGrid.append(
    field(t('spine（复用现有 prefab，如 enemy_1007_slime）'), spineField()),
    field(t('模型缩放 modelScale'), numInput(() => spec.modelScale, (v) => { spec.modelScale = v; })),
    field(t('beFactor（战力系数，默认 1）'), numInput(() => spec.beFactor, (v) => { spec.beFactor = v; })),
  );
  artBox.append(artGrid);
  const hit = document.createElement('div'); hit.className = 'grid';
  hit.append(
    field(t('受击框 w'), numInput(() => spec.hitArea?.w, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), w: v }; })),
    field(t('受击框 h'), numInput(() => spec.hitArea?.h, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), h: v }; })),
    field(t('偏移 dx'), numInput(() => spec.hitArea?.dx ?? 0, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), dx: v }; })),
    field(t('偏移 dy'), numInput(() => spec.hitArea?.dy ?? 0, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), dy: v }; })),
  );
  artBox.append(hit);
  box.append(artBox);
}

function areaInput(get, set) {
  const el = document.createElement('textarea');
  el.value = get() ?? '';
  el.addEventListener('input', () => { set(el.value); schedule(); });
  return el;
}

// ---- preview ----------------------------------------------------------------------------------------------------

let timer = null;
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(preview, now ? 0 : 300);
}
async function preview() {
  if (!state.spec) return;
  if (state.spec._skillsBad) return;   // mid-typing JSON: do not spam the server with an unparseable spec
  try {
    state.preview = await api('/api/enemies/preview', { method: 'POST', body: { spec: currentSpec() } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: e.message }], warnings: [] };
  }
  renderSide();
}

// ---- panels -----------------------------------------------------------------------------------------------------

/**
 * spine 输入框：带官方 prefab 候选，并**当场**说清填错会怎样。
 *
 * 这是全表单唯一一个「填错不报错」的字段：`assets.spineEntry()` 查不到就画个占位菱形，游戏照跑。
 * 官方 249 只怪共用 200 多个 prefab 键，作者不可能背下来，所以候选与校验都得给。
 */
function spineField() {
  const wrap = document.createElement('div');
  const i = document.createElement('input');
  i.value = state.spec?.spine ?? '';
  i.setAttribute('list', 'spineOptions');
  const hint = document.createElement('div');
  hint.className = 'hint';
  const paint = () => {
    const verdict = spineIsKnown(state.spec?.spine, state.data?.spineChoices);
    hint.className = verdict === 'unknown' ? 'hint warn' : 'hint';
    hint.textContent = verdict === 'unknown' ? t('这个 prefab 键不在官方清单里：游戏里会显示成占位模型（不会报错）。')
      : verdict === 'empty' ? t('留空则用占位模型；想要真美术就填一个官方 prefab 键。')
        : verdict === 'no-data' ? '' : t('是官方 prefab 键，游戏里用这套美术。');
  };
  paint();
  i.addEventListener('input', () => { state.spec.spine = i.value; paint(); schedule(); });
  wrap.append(i, hint);
  const dl = document.createElement('datalist');
  dl.id = 'spineOptions';
  for (const c of state.data?.spineChoices ?? []) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    dl.append(o);
  }
  wrap.append(dl);
  return wrap;
}

// ---- 「以模板新建」的选择器 ---------------------------------------------------------------------------------------

/** 模板来源：官方 249 只怪（全新记录）或本包已有怪物（复制一份，改 id 即可）。 */
function renderPicker(box) {
  const title = document.createElement('h2'); title.textContent = t('以模板新建');
  box.append(title);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('选一只怪物当底子：数值、档位、攻击方式、能力文字、技能、免疫与 spine 都会带过来，之后填一个新 id 与名字就能保存。'),
  }));

  const search = document.createElement('input');
  search.value = state.pickQuery;
  search.placeholder = t('搜索怪物（名称 / key）');
  search.addEventListener('input', () => {
    state.pickQuery = search.value;
    renderKeepingFocus($('#form'), renderForm);
  });
  const back = document.createElement('button');
  back.className = 'ghost'; back.textContent = t('返回');
  back.addEventListener('click', () => { state.picking = false; state.pickQuery = ''; renderList(); renderForm(); renderSide(); });
  const row = document.createElement('div'); row.className = 'row'; row.style.margin = '10px 0';
  row.append(search, back);
  box.append(row);

  // 本包已有怪物：同一份 spec 复制一份最省事
  const own = state.data?.enemies ?? [];
  if (own.length) {
    const t2 = document.createElement('h2'); t2.textContent = t('复制本包的怪物（{0} 只）', own.length);
    box.append(t2);
    for (const e of own) {
      const item = document.createElement('div'); item.className = 'item';
      item.innerHTML = `<div class="n">${e.name}</div><div class="m">${e.pack} · ${e.key}</div>`;
      item.addEventListener('click', () => openEnemy(e).then(() => duplicateCurrent()));
      box.append(item);
    }
  }

  // 官方怪物
  const matched = sortTemplates(matchEnemies(state.data?.officialTemplates ?? [], state.pickQuery));
  const head = document.createElement('h2');
  head.textContent = t('官方怪物（匹配 {0} / 共 {1}）', matched.length, (state.data?.officialTemplates ?? []).length);
  box.append(head);
  if (!matched.length) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（没有匹配的怪物）') }));
  const LIMIT = 60;
  for (const e of matched.slice(0, LIMIT)) {
    const item = document.createElement('div'); item.className = 'item'; item.title = e.key;
    item.innerHTML = `<div class="n">${e.name}</div>`
      + `<div class="m">${e.rank ?? '?'} · ${e.applyWay ?? '?'} · ${e.motion ?? '?'} · ${e.key}</div>`;
    item.addEventListener('click', () => loadEnemyTemplate(e.key));
    box.append(item);
  }
  if (matched.length > LIMIT) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('只显示了前 {0} 只，用上面的搜索框缩小范围。', LIMIT) }));
}

/** 用官方怪物当模板：服务端把记录转成 spec（shared/enemyAuthoring.js 的 specFromEnemyRecord）。 */
async function loadEnemyTemplate(key) {
  try {
    const r = await api(`/api/enemies/template?key=${encodeURIComponent(key)}`);
    state.spec = r.spec;
    state.key = null;
    state.picking = false;
    state.preview = null;
    state.message = { kind: 'ok', text: t('已按「{0}」生成模板：请填一个新的 id 与名字（改完会自动校验）。', r.spec.name || key) };
    renderList(); renderForm(); renderSide(); schedule(true);
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
    renderSide();
  }
}

/** 复制当前打开的怪物：只清空 id（那一个必须重填，否则会覆盖原来那只）。 */
function duplicateCurrent() {
  if (!state.spec) return;
  const name = state.spec.name;
  state.spec = { ...state.spec, id: '' };
  state.key = null;
  state.picking = false;
  state.preview = null;
  state.message = { kind: 'ok', text: t('已复制「{0}」：填一个新的 id 再保存（改完会自动校验）。', name) };
  renderList(); renderForm(); renderSide(); schedule(true);
}

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk(t('＋ 新建怪物'), 'item', () => { state.key = null; state.spec = blankSpec(); state.preview = null; state.picking = false; renderList(); renderForm(); renderSide(); schedule(true); }));
  // 「以模板新建」：官方 249 只怪随便挑一只当底子，spine 与数值都不用自己摸
  box.append(mk(t('⧉ 以模板新建'), `item${state.picking ? ' on' : ''}`, () => {
    state.key = null; state.spec = null; state.preview = null; state.picking = true; state.pickQuery = '';
    renderList(); renderForm(); renderSide();
  }));
  for (const e of state.data?.enemies ?? []) {
    const errs = (e.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${e.key === state.key ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${e.name}${errs ? ` <span class="tag err">${errs}</span>` : ''}</div>`
      + `<div class="m">${e.pack} · ${e.key}</div>`
      + `<div class="m">${e.rank ?? '?'} · ${e.motion ?? '?'} · ${t('能力 {0} · 技能 {1}', e.abilities, e.skills)} · ${e.managed ? t('可编辑') : t('非编辑器管理')}</div>`;
    el.addEventListener('click', () => openEnemy(e));
    box.append(el);
  }
}

async function openEnemy(e) {
  state.packId = e.pack;
  state.key = e.key;
  state.picking = false;
  state.message = null;
  try {
    const r = await api(`/api/enemies/${encodeURIComponent(e.pack)}/${encodeURIComponent(e.key)}`);
    state.spec = r.spec ?? specFromRecord(r.record);
    renderList(); renderForm(); renderSide(); schedule(true);
  } catch (err) { state.message = { kind: 'error', text: err.message }; renderSide(); }
}

/** Read a generated record back into a spec (for a record the editor did not author). */
function specFromRecord(rec) {
  const base = blankSpec();
  if (!rec) return base;
  return {
    ...base,
    id: String(rec.key || '').replace(/^enemy_ws_/, ''),
    name: rec.name ?? '', rank: rec.rank ?? 'NORMAL', applyWay: rec.applyWay ?? 'MELEE',
    motion: rec.stats?.motion ?? 'WALK', dmgType: rec.stats?.dmgType ?? 'phys', desc: rec.desc ?? '',
    stats: { ...base.stats, ...Object.fromEntries(STAT_FIELDS().map(([k]) => [k, rec.stats?.[k] ?? base.stats[k]])) },
    abilities: rec.abilities ?? [], talents: { bb: rec.talents?.bb ?? {} }, skills: rec.skills ?? [],
    tags: rec.tags ?? [], immunities: rec.stats?.immunities ?? {}, otherImmunities: rec.otherImmunities ?? [],
    acTypes: rec.acTypes ?? [], acType: rec.acType ?? null, spine: rec.spine ?? '',
    modelScale: rec.modelScale ?? null, hitArea: rec.hitArea ?? null, attackAnim: rec.attackAnim ?? null,
    beFactor: rec.beFactor ?? 1, notCountInTotal: rec.notCountInTotal === true, isFlyEnemy: rec.isFlyEnemy,
  };
}

function renderSide() {
  const box = $('#side');
  box.replaceChildren();
  const h = (text) => { const e = document.createElement('h2'); e.textContent = text; return e; };
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }
  if (!state.spec) return;

  box.append(h(t('派生量（只读，服务端算）')));
  const dbox = document.createElement('div'); dbox.className = 'panel derived';
  const rec = state.preview?.record;
  dbox.textContent = rec
    ? `attrPower ${rec.attrPower}\nbe ${rec.be}   (beFactor ${rec.beFactor})\ndmgTypes ${JSON.stringify(rec.stats.dmgTypes)}\nisFlyEnemy ${rec.isFlyEnemy}`
    : t('（改动后自动推导）');
  dbox.style.whiteSpace = 'pre-wrap';
  box.append(dbox);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('be 决定阵营换怪时替换多少只，所以它必须由数值算出来，不能手填。'),
  }));

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? t('保存中…') : t('保存');
  save.disabled = state.busy || !state.spec.id;
  save.addEventListener('click', saveEnemy);
  actions.append(save);
  if (state.key) {
    const del = document.createElement('button'); del.textContent = t('删除');
    del.addEventListener('click', deleteEnemy);
    actions.append(del);
  }
  box.append(actions);
  // 保存目标：以前每次保存都要在对话框里手打 id，打错就存进别的包
  box.append(h(t('保存到')));
  const packBox = document.createElement('div'); packBox.className = 'panel';
  packBox.append(packSelect({
    packs: state.data?.packs ?? [],
    current: state.packId,
    newLabel: t('＋ 新建一个包…'),
    onPick: (id) => { state.packId = id; renderSide(); },
    askNewId: () => prompt(t('新工坊包的 id（字母数字下划线短横线，≤32）：'), 'my-monster-pack'),
  }));
  box.append(packBox);
  if (!state.spec.id) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('先填 id 才能保存。') }));

  box.append(h(t('校验')));
  const pv = document.createElement('div'); pv.className = 'panel';
  if (!state.preview) pv.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（改动后自动校验）') }));
  else {
    if (state.preview.ok && !(state.preview.warnings ?? []).length) pv.append(Object.assign(document.createElement('div'), { className: 'ok', textContent: t('✔ 校验通过') }));
    for (const e of state.preview.errors ?? []) {
      const d = document.createElement('div'); d.className = 'err';
      d.textContent = `${e.field || t('（记录）')} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}`;
      pv.append(d);
    }
    for (const w of state.preview.warnings ?? []) {
      const d = document.createElement('div'); d.className = 'warn'; d.textContent = String(w);
      pv.append(d);
    }
  }
  if (state.spec._skillsBad) pv.append(Object.assign(document.createElement('div'), { className: 'err', textContent: t('skills 不是合法 JSON，暂不校验') }));
  box.append(pv);
}

async function saveEnemy() {
  if (!state.packId) {
    state.message = { kind: 'error', text: t('先在右边选一个工坊包（或点「＋ 新建一个包…」）。') };
    renderSide();
    return;
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/enemies`, { method: 'POST', body: { spec: currentSpec() } });
    state.key = r.key;
    state.message = { kind: 'ok', text: t('已保存 {0}，生成 {1}。', r.key, r.generated.join(', ')) };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteEnemy() {
  if (!state.key || !confirm(t('删除怪物 {0}？', state.key))) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/enemies/${encodeURIComponent(state.key)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: t('已删除 {0}', state.key) };
    state.key = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

/** The left column header: how many monsters the workshop root holds. */
function renderPath() {
  const n = state.data?.enemies?.length;
  $('#rootPath').textContent = n === undefined ? '' : n ? t('{0} 只工坊怪物', n) : t('还没有工坊怪物');
}

async function load() {
  state.data = await api('/api/enemies');
  renderPath();
  if (!state.packId) state.packId = state.data.enemies[0]?.pack ?? null;
  renderList();
  if (!state.spec) renderForm();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.key = null; state.spec = blankSpec(); state.preview = null; state.picking = false; renderList(); renderForm(); renderSide(); schedule(true); });

/** Redraw every part that carries text, so a language switch updates the whole page. */
function renderAll() {
  renderPath();
  renderList();
  renderForm();
  renderSide();
}

// 界面语言：换掉 HTML 里的静态文案、插入右上角切换按钮，换语言后重画一遍（动态文案也要跟着换）。
mountI18n(renderAll);

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: t('载入失败：{0}', e.message) })); });
