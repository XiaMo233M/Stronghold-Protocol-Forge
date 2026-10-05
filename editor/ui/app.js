// editor/ui/app.js — the workshop editor's front end. Plain DOM, native ES modules, no build step, no dependency on
// the game client (which never loads this file). It talks to editor/server.mjs and, through it, to the SAME
// shared/chessAuthoring.js the CLIs and an AI use — so the editor cannot drift from the validator.

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

const state = { data: null, packId: null, slug: null, spec: null, preview: null, message: null, busy: false };

// ---- the spec model ----------------------------------------------------------------------------------------------

// The professions the DATA uses: 重装 TANK / 先锋 PIONEER / 特种 SPECIAL — NOT the global Arknights names.
// Mirrors shared/chessAuthoring.js PROFESSIONS, which test/chessAuthoring.test.js pins to data/chess.json.
const PROFESSIONS = ['WARRIOR', 'SNIPER', 'CASTER', 'MEDIC', 'SUPPORT', 'TANK', 'SPECIAL', 'PIONEER'];
const SKILL_TYPES = ['MANUAL', 'AUTO', 'PASSIVE'];
const DURATION_TYPES = ['NONE', 'AMMO'];
const SP_TYPES = ['INCREASE_WITH_TIME', 'INCREASE_WHEN_ATTACK', 'INCREASE_WHEN_TAKEN_DAMAGE', 'ON_DEPLOY'];
const TRIGGERS = ['DEFAULT', 'TAKE_DAMAGE', 'SKILL_RANGE', 'SP_FULL', 'SEARCH'];

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
  if (!state.data.packs.length) box.append(h('div', { class: 'item' }, h('div', { class: 'm' }, '（还没有工坊包）')));
  for (const pack of state.data.packs) {
    box.append(h('div', {
      class: `item${pack.id === state.packId ? ' on' : ''}`,
      onclick: () => { state.packId = pack.id; state.slug = null; state.spec = null; state.preview = null; state.message = null; renderShell(); },
    },
    h('div', { class: 'n' }, pack.manifest?.name || pack.id),
    h('div', { class: 'm' }, `${pack.id} · ${pack.operators.length} 条记录 · ${pack.specs.length} 个可编辑`,
      pack.operators.some((o) => o.issues.some((i) => i.severity === 'error')) ? h('span', { class: 'tag err' }, '有错误') : null)));
  }
}

function renderOps() {
  const box = $('#opList');
  box.replaceChildren();
  const pack = state.data?.packs.find((p) => p.id === state.packId);
  if (!pack) { box.append(h('div', { class: 'item' }, h('div', { class: 'm' }, '先在左边选一个工坊包'))); return; }
  box.append(h('div', { class: 'item', onclick: () => { state.slug = null; state.spec = blankSpec(); state.preview = null; renderShell(); } },
    h('div', { class: 'n ok' }, '＋ 新建干员')));
  for (const spec of pack.specs) {
    const base = pack.operators.find((o) => o.name && !o.isGolden && o.chessId.endsWith('_a') && o.chessId.includes(spec.id));
    const errs = pack.operators.filter((o) => o.chessId.includes(spec.id)).reduce((n, o) => n + o.issues.filter((i) => i.severity === 'error').length, 0);
    box.append(h('div', {
      class: `item${spec.id === state.slug ? ' on' : ''}`,
      onclick: () => { state.slug = spec.id; state.spec = JSON.parse(JSON.stringify(spec)); state.preview = null; state.message = null; renderShell(); previewSoon(); },
    },
    h('div', { class: 'n' }, spec.name || spec.id),
    h('div', { class: 'm' }, `id ${spec.id} · ${spec.tier} 阶 · ${spec.profession}`,
      errs ? h('span', { class: 'tag err' }, `${errs} 个错误`) : h('span', { class: 'tag ok' }, '可编辑'))));
  }
  for (const op of pack.operators.filter((o) => !o.managed && !o.isGolden)) {
    box.append(h('div', { class: 'item', title: '由 CLI 或手工写入，没有 spec，编辑器不会改动它' },
      h('div', { class: 'n dim' }, op.name || op.chessId),
      h('div', { class: 'm' }, '非编辑器管理（保留原样）')));
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

function renderEditor() {
  const box = $('#editor');
  box.replaceChildren();
  if (!state.data) { box.append(h('p', { class: 'hint' }, '正在载入…')); return; }
  if (state.message) box.append(h('div', { class: `banner ${state.message.kind === 'error' ? 'bad' : 'good'}` }, state.message.text));
  if (!state.spec) { box.append(h('p', { class: 'hint' }, '左边的列表中选一个工坊包，或新建一个干员。')); return; }

  const s = state.spec;
  const packId = state.packId || '(先选择工坊包)';
  box.append(h('h2', {}, `干员 · ${s.name || s.id || '未命名'} · 包 ${packId}`));

  // identity
  box.append(h('div', { class: 'panel' }, h('div', { class: 'grid' },
    field('id（slug，决定 chess_ws_<id>_a/_b）', textInput(() => s.id, (v) => { s.id = v; })),
    field('名称', textInput(() => s.name, (v) => { s.name = v; })),
    field('英文代号', textInput(() => s.appellation, (v) => { s.appellation = v; })),
    field('阶（tier）', numInput(() => s.tier, (v) => { s.tier = v; })),
    field('职业', select(PROFESSIONS, () => s.profession, (v) => { s.profession = v; })),
    field('分支 subProfessionId', textInput(() => s.subProfessionId, (v) => { s.subProfessionId = v; }, { placeholder: '如 fastshot / fortress / bard' })),
    field('位置', select(['MELEE', 'RANGED'], () => s.position, (v) => { s.position = v; })),
    field('特性文字（只影响伤害类型推导）', textInput(() => s.traitDesc, (v) => { s.traitDesc = v; })))));

  // appearance — the repo ships no assets, so reuse an existing spine
  const spineList = state.data.officialChess.map((c) => c.spine).filter(Boolean);
  const spines = [...new Set(spineList)].sort();
  const spineSel = h('select', { onchange: (e) => { s.assetsSpine = e.target.value; schedulePreview(); renderEditor(); } },
    h('option', { value: '', selected: !s.assetsSpine }, '（不指定 → 替代外观）'));
  for (const sp of spines) spineSel.append(h('option', { value: sp, selected: s.assetsSpine === sp }, sp));
  box.append(h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, '外观（仓库不含素材，只能复用已有 Spine id）'),
    h('div', { class: 'grid' }, field('assetsSpine', spineSel), field('或直接填 id', textInput(() => s.assetsSpine, (v) => { s.assetsSpine = v; })))));

  // the two states
  const statBlock = (key, title) => {
    const st = s.stats[key];
    return h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, title),
      h('div', { class: 'grid' },
        field('生命上限 maxHp', numInput(() => st.maxHp, (v) => { st.maxHp = v; })),
        field('攻击 atk', numInput(() => st.atk, (v) => { st.atk = v; })),
        field('防御 def', numInput(() => st.def, (v) => { st.def = v; })),
        field('法抗 res', numInput(() => st.res, (v) => { st.res = v; })),
        field('费用 cost', numInput(() => st.cost, (v) => { st.cost = v; })),
        field('阻挡 blockCnt', numInput(() => st.blockCnt, (v) => { st.blockCnt = v; })),
        field('攻击间隔 bat（秒）', numInput(() => st.bat, (v) => { st.bat = v; })),
        field('再部署 respawnTime', numInput(() => st.respawnTime ?? 70, (v) => { st.respawnTime = v; }))));
  };
  box.append(h('div', { class: 'split' }, statBlock('normal', '普通状态数值'), statBlock('golden', '精锐状态数值')));

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
    h('h2', { style: 'margin-top:0' }, '技能（黑板书键不需要写 JavaScript）'),
    h('div', { class: 'grid' },
      field('技能名', textInput(() => sk.name, (v) => { sk.name = v; })),
      field('类型', select(SKILL_TYPES, () => sk.skillType, (v) => { sk.skillType = v; })),
      field('持续类型', select(DURATION_TYPES, () => sk.durationType, (v) => { sk.durationType = v; })),
      field('技力消耗 spCost', numInput(() => sk.spCost, (v) => { sk.spCost = v; })),
      field('初始技力 initSp', numInput(() => sk.initSp, (v) => { sk.initSp = v; })),
      field('持续时间 duration（0 立即 / -1 无限）', numInput(() => sk.duration, (v) => { sk.duration = v; })),
      field('技力回复 spType', select(SP_TYPES, () => sk.spType, (v) => { sk.spType = v; })),
      field('自动释放 triggerRule', select(TRIGGERS, () => sk.triggerRule, (v) => { sk.triggerRule = v; }))),
    field('技能描述（官方文字）', h('textarea', { value: sk.desc ?? '', oninput: (e) => { sk.desc = e.target.value; schedulePreview(); } })),
    h('h2', {}, '黑板书 bb'),
    h('p', { class: 'hint' }, '键必须是通用 kit 认识的（见 docs/prompts/operator-pack.md 的表格）。写了不认的键不会报错，但也不会有任何效果——校验会警告。'),
    bbBox,
    h('button', { class: 'ghost', onclick: () => { sk.bb = sk.bb || {}; sk.bb.new_key = 0; drawBb(); } }, '＋ 加一个键')));

  // talents (天赋): the authoring layer already turns spec.talents into the record's talents[] (name/desc/bb), so this
  // is purely the missing form. A talent with no desc is emitted `hidden: true` by the derive layer, which is why the
  // hint below insists on the description — a talent nothing can read is a talent that does nothing.
  s.talents = Array.isArray(s.talents) ? s.talents : [];
  const talBox = h('div', {});
  const drawTalents = () => {
    talBox.replaceChildren();
    s.talents.forEach((t, i) => {
      const bbBox2 = h('div', {});
      const drawTb = () => {
        bbBox2.replaceChildren();
        for (const [key, val] of Object.entries(t.bb || {})) {
          bbBox2.append(h('div', { class: 'kv' },
            h('input', { value: key, onchange: (e) => { const old = key; const v = t.bb[old]; delete t.bb[old]; t.bb[e.target.value] = v; schedulePreview(); drawTb(); } }),
            h('input', { type: 'number', step: 'any', value: val, oninput: (e) => { t.bb[key] = Number(e.target.value); schedulePreview(); } }),
            h('button', { class: 'ghost', onclick: () => { delete t.bb[key]; schedulePreview(); drawTb(); } }, '×')));
        }
        bbBox2.append(h('button', { class: 'ghost', onclick: () => { t.bb = t.bb || {}; t.bb.new_key = 0; drawTb(); } }, '＋ 加一个键'));
      };
      drawTb();
      talBox.append(h('div', { class: 'panel' },
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('strong', {}, `天赋 ${i + 1}`),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'ghost', onclick: () => { s.talents.splice(i, 1); schedulePreview(); drawTalents(); } }, '× 删除')),
        h('div', { class: 'grid' },
          field('天赋名', textInput(() => t.name, (v) => { t.name = v; })),
          field('说明（必填，否则该天赋被视为隐藏）', textInput(() => t.desc, (v) => { t.desc = v; }))),
        h('h2', {}, '天赋黑板 bb'),
        bbBox2));
    });
  };
  drawTalents();
  box.append(h('div', { class: 'panel' },
    h('h2', { style: 'margin-top:0' }, '天赋 tactics（0~2 条，建议 2 条：普通/精锐共用）'),
    h('p', { class: 'hint' }, '说明（desc）是必须的：没有说明的天赋在记录里会被标记为 hidden。黑板键同样是通用 kit 认识的键，写错只会警告、不会有任何效果。'),
    talBox,
    h('button', {
      class: 'ghost',
      onclick: () => {
        s.talents.push({ name: `天赋${s.talents.length + 1}`, desc: '', bb: {} });
        schedulePreview(); drawTalents();
      },
    }, '＋ 添加一条天赋')));

  // support switch (the 是否助战 toggle)
  if (state.slug) {
    const baseId = `chess_ws_${state.slug}_a`;
    const tier = s.tier;
    const pool = state.data.support.pool[tier] || [];
    const isSupport = pool.includes(baseId);
    box.append(h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, '助战（写入 data/support.json 的服务端卡池）'),
      h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--fg)' },
        h('input', {
          type: 'checkbox', checked: isSupport, style: 'width:auto',
          onchange: async (e) => {
            try {
              await api('/api/support/toggle', { method: 'POST', body: { chessId: baseId, tier, enabled: e.target.checked } });
              state.message = { kind: 'ok', text: `${s.name || baseId} ${e.target.checked ? '已加入' : '已移出'} ${tier} 阶助战卡池（重启游戏服务器后生效）` };
              await load();
            } catch (err) { state.message = { kind: 'error', text: err.message }; renderEditor(); }
          },
        }),
        `把 ${baseId} 加入 ${tier} 阶助战卡池`),
      h('p', { class: 'hint' }, `当前 ${tier} 阶卡池：${pool.length ? pool.join(', ') : '（空）'}`)));
  }

  // actions + validation
  const actions = h('div', { class: 'row', style: 'margin:14px 0' },
    h('button', { class: 'primary', disabled: state.busy || !state.packId, onclick: save }, state.busy ? '保存中…' : '保存并生成'),
    state.slug ? h('button', { onclick: remove }, '删除该干员') : null,
    h('button', { class: 'ghost', onclick: () => { state.spec = blankSpec(); state.slug = null; schedulePreview(); renderShell(); } }, '清空表单'));
  box.append(actions);
  if (!state.packId) box.append(h('p', { class: 'hint' }, '先在上方选择一个工坊包（或点「新建工坊包」），才能保存。'));

  const pv = state.preview;
  const panel = h('div', { class: 'panel' });
  if (!pv) panel.append(h('p', { class: 'hint' }, '（改动后会自动校验）'));
  else if (pv.ok && !pv.warnings.length) panel.append(h('div', { class: 'ok' }, '✔ 校验通过：引擎接受这份记录'));
  else {
    if (pv.errors?.length) {
      panel.append(h('div', { class: 'err' }, `${pv.errors.length} 个错误（必须修）`));
      panel.append(h('ul', { class: 'issues' }, pv.errors.map((e) => h('li', { class: 'err' }, `${e.field || '(记录)'} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}`))));
    }
    if (pv.warnings?.length) {
      panel.append(h('div', { class: 'warn' }, `${pv.warnings.length} 条警告`));
      panel.append(h('ul', { class: 'issues' }, pv.warnings.map((w) => h('li', { class: 'warn' }, String(w)))));
    }
  }
  if (pv?.base) {
    panel.append(h('h2', {}, '将要生成的记录（普通 / 精锐由工具推导）'));
    panel.append(h('pre', { text: JSON.stringify({ base: pv.base, golden: pv.golden }, null, 1).slice(0, 4000) }));
  }
  box.append(h('h2', {}, '校验结果'), panel);
}

// ---- behaviour ---------------------------------------------------------------------------------------------------

let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 250); }
function previewSoon() { schedulePreview(); }

async function preview() {
  try {
    state.preview = await api('/api/preview', { method: 'POST', body: { spec: state.spec } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: e.message }], warnings: [] };
  }
  renderEditor();
}

async function save() {
  if (!state.packId) { state.message = { kind: 'error', text: '先选择一个工坊包（或点「新建工坊包」）' }; renderEditor(); return; }
  state.busy = true; renderEditor();
  try {
    const r = await api(`/api/packs/${state.packId}/operators`, { method: 'POST', body: { spec: state.spec } });
    state.slug = r.slug;
    state.message = { kind: 'ok', text: `已保存 ${r.slug}，生成 ${r.generated.join(', ')}。重启游戏服务器后生效。` };
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
  } finally {
    state.busy = false; renderShell();
  }
}

async function remove() {
  if (!state.slug || !confirm(`删除 ${state.slug}？（同时删除它生成的普通与精锐记录）`)) return;
  try {
    await api(`/api/packs/${state.packId}/operators/${state.slug}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: `已删除 ${state.slug}` };
    state.slug = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderShell(); }
}

async function load() {
  state.data = await api('/api/state');
  if (!state.packId && state.data.packs.length) state.packId = state.data.packs[0].id;
  renderShell();
  if (state.spec) preview();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderEditor(); }));
$('#btnNewPack').addEventListener('click', async () => {
  const id = prompt('新工坊包的 id（字母数字下划线短横线，≤32）：');
  if (!id) return;
  try {
    // creating a pack happens on the first saved operator; remember the target and open a blank form
    state.packId = id.trim();
    state.slug = null;
    state.spec = blankSpec();
    state.preview = null;
    state.message = { kind: 'ok', text: `保存第一个干员时会创建工坊包 ${state.packId}（目录名必须等于 pack.json 的 id）。` };
    renderShell();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderEditor(); }
});

load().catch((e) => { $('#editor').replaceChildren(h('p', { class: 'err' }, `载入失败：${e.message}`)); });
