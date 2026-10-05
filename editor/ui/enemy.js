// editor/ui/enemy.js — the monster editor page (docs/EDITOR.md). Plain DOM, no build step, no game-client import.
//
// The form edits the SPEC only; `attrPower` and `be` are DERIVED server-side on every keystroke (debounced) through
// /api/enemies/preview, and shown as read-only readouts. They are not cosmetic: `be` drives the per-faction enemy
// replacement count, so a hand-typed value silently swaps the wrong number of enemies.

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = { data: null, packId: null, key: null, spec: null, preview: null, message: null, busy: false };

/** The stat fields, with the label and the unit the form shows. Order matters: it is the order on screen. */
const STAT_FIELDS = [
  ['maxHp', '生命上限'], ['atk', '攻击'], ['def', '防御'], ['res', '法抗'],
  ['moveSpeed', '移动速度'], ['bat', '攻击间隔(秒)'], ['aspd', '攻速'], ['rangeRadius', '射程(格)'],
  ['blockCnt', '阻挡数'], ['massLevel', '重量等级'], ['lpr', '生命恢复比例'], ['hpRecoveryPerSec', '每秒回血'],
  ['elementRes', '元素抗性'], ['elementDmgRes', '元素伤害抗性'], ['hitRatePhys', '物理命中率'], ['hitRateArts', '法术命中率'],
  ['tauntLevel', '嘲讽等级'],
];

function blankSpec() {
  const stats = {};
  for (const [k] of STAT_FIELDS) stats[k] = state.data?.vocab?.statDefaults?.[k] ?? 0;
  stats.maxHp = 1000; stats.atk = 100; stats.moveSpeed = 1; stats.bat = 1.2;
  return {
    id: '', name: '', rank: 'NORMAL', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys', desc: '',
    stats, abilities: [], talents: { bb: {} }, skills: [], tags: [], immunities: {}, otherImmunities: [],
    acTypes: [], acType: null, spine: '', modelScale: null, hitArea: null, attackAnim: null,
    beFactor: 1, notCountInTotal: false, isFlyEnemy: undefined,
  };
}

/** The spec sent to the server, built from the spec object (numeric fields already numbers). */
const currentSpec = () => state.spec;

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
  if (allowEmpty) { const o = document.createElement('option'); o.value = ''; o.textContent = '（无）'; s.append(o); }
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
  const spec = state.spec;
  if (!spec) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '左边选一只怪物，或点「新建怪物」。' }));
    return;
  }
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  const desc = () => Object.assign(document.createElement('p'), { className: 'hint', textContent: '这些字段下面是推导量，不要手写。' });

  box.append(h('身份'));
  const idBox = document.createElement('div'); idBox.className = 'panel';
  const idGrid = document.createElement('div'); idGrid.className = 'grid wide';
  idGrid.append(
    field('id（slug）', textInput(() => spec.id, (v) => { spec.id = v; }), '会生成 enemy_ws_<id>，例如 frost_hound'),
    field('名称', textInput(() => spec.name, (v) => { spec.name = v; })),
    field('等级 rank', selectInput(() => spec.rank, (v) => { spec.rank = v; }, state.data.vocab.ranks,
      { labels: { NORMAL: 'NORMAL 普通', ELITE: 'ELITE 精英', BOSS: 'BOSS 领袖' } })),
    field('攻击方式', selectInput(() => spec.applyWay, (v) => { spec.applyWay = v; }, state.data.vocab.applyWays)),
    field('伤害类型', selectInput(() => spec.dmgType, (v) => { spec.dmgType = v; }, state.data.vocab.dmgTypes,
      { labels: { phys: 'phys 物理', arts: 'arts 法术', none: 'none 无攻击' } })),
    field('移动方式', selectInput(() => spec.motion, (v) => { spec.motion = v; }, state.data.vocab.motions,
      { labels: { WALK: 'WALK 地面', FLY: 'FLY 飞行' } })),
  );
  idBox.append(idGrid);
  idBox.append(field('描述', textInput(() => spec.desc, (v) => { spec.desc = v; })));
  const flags = document.createElement('div'); flags.className = 'row'; flags.style.marginTop = '8px';
  flags.append(
    checkInput(() => spec.isFlyEnemy, (v) => { spec.isFlyEnemy = v; }, '飞行单位（不填则跟随移动方式）'),
    checkInput(() => spec.notCountInTotal, (v) => { spec.notCountInTotal = v; }, '不计入总数'),
  );
  idBox.append(flags);
  box.append(idBox);

  box.append(h('数值 stats'));
  const statBox = document.createElement('div'); statBox.className = 'panel';
  const grid = document.createElement('div'); grid.className = 'grid';
  for (const [k, label] of STAT_FIELDS) grid.append(field(label, numInput(() => spec.stats[k], (v) => { spec.stats[k] = v; })));
  statBox.append(grid);
  statBox.append(desc());
  box.append(statBox);

  box.append(h('特殊机制'));
  const mechBox = document.createElement('div'); mechBox.className = 'panel';
  mechBox.append(field('能力说明（abilities，一行一条，游戏里显示的那几行）',
    areaInput(() => (spec.abilities || []).map((a) => a.text).join('\n'), (v) => { spec.abilities = v.split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ text: t })); })));
  // talents.bb: the blackboard the engine reads
  const bbWrap = document.createElement('div');
  bbWrap.append(Object.assign(document.createElement('label'), { textContent: '天赋黑板 talents.bb（键 → 数值）' }));
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
  const addBb = document.createElement('button'); addBb.className = 'ghost'; addBb.textContent = '＋ 加一个键';
  addBb.addEventListener('click', () => { spec.talents.bb = { ...(spec.talents.bb || {}), '': 0 }; renderForm(); });
  bbWrap.append(addBb);
  mechBox.append(bbWrap);
  mechBox.append(field('技能 skills（JSON 数组；每项形如 { prefabKey, priority, cooldown, bb }）',
    areaInput(() => JSON.stringify(spec.skills || [], null, 2), (v) => {
      try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) { spec.skills = parsed; spec._skillsBad = false; } else spec._skillsBad = true; }
      catch { spec._skillsBad = true; }
      renderSide();
    })));
  const acRow = document.createElement('div'); acRow.className = 'grid wide';
  acRow.append(
    field('能力分类 acType', selectInput(() => spec.acType, (v) => { spec.acType = v; }, state.data.vocab.acTypes, { allowEmpty: true })),
    field('标记 tags（逗号分隔）', textInput(() => (spec.tags || []).join(','), (v) => { spec.tags = v.split(',').map((s) => s.trim()).filter(Boolean); })),
  );
  mechBox.append(acRow);
  const imm = document.createElement('div'); imm.className = 'row';
  for (const k of state.data.vocab.immunities) {
    imm.append(checkInput(() => spec.immunities?.[k], (v) => { spec.immunities = { ...(spec.immunities || {}), [k]: v }; }, `免疫 ${k}`));
  }
  mechBox.append(imm);
  box.append(mechBox);

  box.append(h('美术与非数据表字段'));
  const artBox = document.createElement('div'); artBox.className = 'panel';
  artBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '这些字段不在游戏数据表里（来自客户端清单），所以必须手填。spine 复用现有怪物的 prefab 键才有真美术。' }));
  const artGrid = document.createElement('div'); artGrid.className = 'grid wide';
  artGrid.append(
    field('spine（复用现有 prefab，如 enemy_1007_slime）', textInput(() => spec.spine, (v) => { spec.spine = v; })),
    field('模型缩放 modelScale', numInput(() => spec.modelScale, (v) => { spec.modelScale = v; })),
    field('beFactor（战力系数，默认 1）', numInput(() => spec.beFactor, (v) => { spec.beFactor = v; })),
  );
  artBox.append(artGrid);
  const hit = document.createElement('div'); hit.className = 'grid';
  hit.append(
    field('受击框 w', numInput(() => spec.hitArea?.w, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), w: v }; })),
    field('受击框 h', numInput(() => spec.hitArea?.h, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), h: v }; })),
    field('偏移 dx', numInput(() => spec.hitArea?.dx ?? 0, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), dx: v }; })),
    field('偏移 dy', numInput(() => spec.hitArea?.dy ?? 0, (v) => { spec.hitArea = { ...(spec.hitArea || { w: 0, h: 0, dx: 0, dy: 0 }), dy: v }; })),
  );
  artBox.append(hit);
  box.append(artBox);
}

function areaInput(get, set) {
  const t = document.createElement('textarea');
  t.value = get() ?? '';
  t.addEventListener('input', () => { set(t.value); schedule(); });
  return t;
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

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk('＋ 新建怪物', 'item', () => { state.key = null; state.spec = blankSpec(); state.preview = null; renderList(); renderForm(); renderSide(); schedule(true); }));
  for (const e of state.data?.enemies ?? []) {
    const errs = (e.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${e.key === state.key ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${e.name}${errs ? ` <span class="tag err">${errs}</span>` : ''}</div>`
      + `<div class="m">${e.pack} · ${e.key}</div>`
      + `<div class="m">${e.rank ?? '?'} · ${e.motion ?? '?'} · 能力 ${e.abilities} · 技能 ${e.skills}${e.managed ? ' · 可编辑' : ' · 非编辑器管理'}</div>`;
    el.addEventListener('click', () => openEnemy(e));
    box.append(el);
  }
}

async function openEnemy(e) {
  state.packId = e.pack;
  state.key = e.key;
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
    stats: { ...base.stats, ...Object.fromEntries(STAT_FIELDS.map(([k]) => [k, rec.stats?.[k] ?? base.stats[k]])) },
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
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }
  if (!state.spec) return;

  box.append(h('派生量（只读，服务端算）'));
  const dbox = document.createElement('div'); dbox.className = 'panel derived';
  const rec = state.preview?.record;
  dbox.textContent = rec
    ? `attrPower ${rec.attrPower}\nbe ${rec.be}   (beFactor ${rec.beFactor})\ndmgTypes ${JSON.stringify(rec.stats.dmgTypes)}\nisFlyEnemy ${rec.isFlyEnemy}`
    : '（改动后自动推导）';
  dbox.style.whiteSpace = 'pre-wrap';
  box.append(dbox);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: 'be 决定阵营换怪时替换多少只，所以它必须由数值算出来，不能手填。',
  }));

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? '保存中…' : '保存';
  save.disabled = state.busy || !state.spec.id;
  save.addEventListener('click', saveEnemy);
  actions.append(save);
  if (state.key) {
    const del = document.createElement('button'); del.textContent = '删除';
    del.addEventListener('click', deleteEnemy);
    actions.append(del);
  }
  box.append(actions);
  if (!state.spec.id) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '先填 id 才能保存。' }));

  box.append(h('校验'));
  const pv = document.createElement('div'); pv.className = 'panel';
  if (!state.preview) pv.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '（改动后自动校验）' }));
  else {
    if (state.preview.ok && !(state.preview.warnings ?? []).length) pv.append(Object.assign(document.createElement('div'), { className: 'ok', textContent: '✔ 校验通过' }));
    for (const e of state.preview.errors ?? []) {
      const d = document.createElement('div'); d.className = 'err';
      d.textContent = `${e.field || '(记录)'} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}`;
      pv.append(d);
    }
    for (const w of state.preview.warnings ?? []) {
      const d = document.createElement('div'); d.className = 'warn'; d.textContent = String(w);
      pv.append(d);
    }
  }
  if (state.spec._skillsBad) pv.append(Object.assign(document.createElement('div'), { className: 'err', textContent: 'skills 不是合法 JSON，暂不校验' }));
  box.append(pv);
}

async function saveEnemy() {
  if (!state.packId) {
    const id = prompt('保存到哪个工坊包？（id：字母数字下划线短横线）', 'my-monster-pack');
    if (!id) return;
    state.packId = id.trim();
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/enemies`, { method: 'POST', body: { spec: currentSpec() } });
    state.key = r.key;
    state.message = { kind: 'ok', text: `已保存 ${r.key}，生成 ${r.generated.join(', ')}。` };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteEnemy() {
  if (!state.key || !confirm(`删除怪物 ${state.key}？`)) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/enemies/${encodeURIComponent(state.key)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: `已删除 ${state.key}` };
    state.key = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

async function load() {
  state.data = await api('/api/enemies');
  $('#rootPath').textContent = state.data.enemies.length ? `${state.data.enemies.length} 只工坊怪物` : '还没有工坊怪物';
  if (!state.packId) state.packId = state.data.enemies[0]?.pack ?? null;
  renderList();
  if (!state.spec) renderForm();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.key = null; state.spec = blankSpec(); state.preview = null; renderList(); renderForm(); renderSide(); schedule(true); });

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: `载入失败：${e.message}` })); });
