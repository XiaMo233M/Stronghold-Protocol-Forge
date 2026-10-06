// editor/ui/wave.js — the wave (出怪) designer: a time axis over the map's routes, plus an exact table.
//
// Two halves, because both matter:
//   * the TIMELINE (a lane per spawn, x = seconds) makes 顺序/时间/间隔/数量 legible at a glance;
//   * the TABLE is where the numbers are actually typed — a canvas drag is a nice-to-have, an exact field is not.
//
// The MAP panel draws the routes of whichever map is chosen, using the same `deriveRoutePaths` the map editor uses, so
// the author sees which route each spawn walks. Routes live in the wave (the engine reads them from there); the map is
// only a reference for their geometry.

const $ = (s) => document.querySelector(s);
const CELL = 32;
const ROWS = 19;
const COLS = 21;

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = {
  data: null, packId: null, waveId: null, spec: null, preview: null,
  message: null, busy: false, sel: 0, showPaths: true, mapId: null, routePaths: [],
};

const SLOT_COLORS = { N: '#5b9dff', NF: '#5b9dff', E: '#e0b357', EF: '#e0b357', S: '#c07bff', SF: '#c07bff', T: '#4ec98a', TF: '#4ec98a' };

function blankSpec() {
  return {
    id: '', kind: 'normal', solo: false, characterLimit: 8, moveMultiplier: 0.5,
    routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }],
    spawns: [], usedBy: [], branches: {}, overrides: {}, devices: [],
  };
}
// the form's own scratch flags (a `_`-prefixed key) must never reach the stored spec file
const currentSpec = () => Object.fromEntries(Object.entries(state.spec || {}).filter(([k]) => !k.startsWith('_')));

// ---- map panel --------------------------------------------------------------------------------------------------

const py = (r) => (ROWS - 1 - r) * CELL;
const px = (c) => c * CELL;

function drawMap() {
  const canvas = $('#board');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // a plain grid stands in for the map: the routes are what the author needs to see here
  ctx.strokeStyle = '#ffffff0d';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) ctx.strokeRect(px(c) + .5, py(r) + .5, CELL, CELL);
  if (state.showPaths) {
    ctx.lineWidth = 4;
    for (const [i, route] of (state.spec?.routes ?? []).entries()) {
      const pts = [route.start, ...(route.checkpoints ?? []).map((cp) => (cp && cp.pos) || cp), route.end].filter(Array.isArray);
      if (pts.length < 2) continue;
      ctx.strokeStyle = route.motion === 'FLY' ? '#a06bffcc' : '#ff8f3fcc';
      ctx.beginPath();
      pts.forEach(([r, c], k) => { const x = px(c) + CELL / 2; const y = py(r) + CELL / 2; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      // label the route with the index every spawn's routeIndex addresses
      const [r0, c0] = pts[0];
      ctx.fillStyle = '#e8eaf0'; ctx.font = '11px monospace';
      ctx.fillText(`#${i}`, px(c0) + CELL / 2 + 5, py(r0) + CELL / 2 - 4);
    }
  }
  ctx.fillStyle = '#9aa3b2'; ctx.font = '10px monospace';
  for (let r = 0; r < ROWS; r += 3) ctx.fillText(String(r), 2, py(r) + 11);
}

// ---- timeline ----------------------------------------------------------------------------------------------------

/** The time the last enemy of a spawn appears (start + (count-1) * interval). */
const endOf = (sp) => (Number(sp.time) || 0) + Math.max(0, (Number(sp.count) || 1) - 1) * (Number(sp.interval) || 0);

function renderTimeline() {
  const box = $('#tl');
  box.replaceChildren();
  const spawns = state.spec?.spawns ?? [];
  if (!spawns.length) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', style: 'padding:10px 12px', textContent: '还没有出怪。用下面的「添加一次出怪」开始。' }));
    return;
  }
  const maxT = Math.max(20, ...spawns.map(endOf)) * 1.08;
  const laneW = Math.max(360, box.clientWidth || 640);
  const scale = (t) => (t / maxT) * laneW;
  // second gridlines
  const step = maxT > 120 ? 30 : maxT > 60 ? 10 : 5;
  for (let t = 0; t <= maxT; t += step) {
    const line = document.createElement('div');
    line.className = 'tick';
    line.style.left = `${scale(t)}px`;
    line.innerHTML = `<span>${t}s</span>`;
    box.append(line);
  }
  spawns.forEach((sp, i) => {
    const lane = document.createElement('div');
    lane.className = 'lane';
    const left = scale(Number(sp.time) || 0);
    const width = Math.max(14, scale(endOf(sp)) - left);
    const blk = document.createElement('div');
    blk.className = `blk${i === state.sel ? ' sel' : ''}${sp.unharmful ? ' unharmful' : ''}`;
    blk.style.left = `${left}px`;
    blk.style.width = `${width}px`;
    const col = SLOT_COLORS[sp.slot] || '#5b9dff';
    blk.style.background = `${col}55`;
    blk.style.borderColor = col;
    blk.textContent = `${sp.key ?? '?'} ×${sp.count ?? 1}${sp.unharmful ? ' (不计)' : ''}`;
    blk.title = `${sp.key} ×${sp.count} @${sp.time}s 间隔 ${sp.interval}s · route #${sp.routeIndex ?? 0} · slot ${sp.slot ?? '—'}`;
    blk.addEventListener('click', () => { state.sel = i; renderTimeline(); renderTable(); });
    lane.append(blk);
    // the lane label sits above the block so the block stays clickable across its whole width
    const lab = document.createElement('div');
    lab.className = 'laneLabel';
    lab.textContent = `#${i} route ${sp.routeIndex ?? 0}${sp.slot ? ` · ${sp.slot}` : ''}`;
    lane.append(lab);
    box.append(lane);
  });
}

// ---- table -------------------------------------------------------------------------------------------------------

function renderTable() {
  const box = $('#table');
  box.replaceChildren();
  const spawns = state.spec?.spawns ?? [];
  const add = document.createElement('button');
  add.className = 'ghost';
  add.textContent = '＋ 添加一次出怪';
  add.addEventListener('click', () => {
    const last = spawns[spawns.length - 1];
    spawns.push({
      time: last ? endOf(last) + 5 : 0, key: state.data.enemies[0] ?? 'enemy_1007_slime',
      count: 1, interval: 0, routeIndex: 0, slot: 'N',
    });
    state.sel = spawns.length - 1;
    renderTimeline(); renderTable(); schedule();
  });
  box.append(add);
  if (!spawns.length) return;
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const t of ['#', '时间(s)', '敌人', '数量', '间隔(s)', '路线', '槽位 slot', '不计入', '']) {
    const th = document.createElement('th'); th.textContent = t; head.append(th);
  }
  table.append(head);
  spawns.forEach((sp, i) => {
    const tr = document.createElement('tr');
    if (i === state.sel) tr.style.background = '#22304a';
    const td = (node) => { const c = document.createElement('td'); c.append(node); return c; };
    const idx = document.createElement('td'); idx.textContent = String(i); idx.style.cursor = 'pointer';
    idx.addEventListener('click', () => { state.sel = i; renderTimeline(); renderTable(); });
    tr.append(idx);
    const num = (key, min = 0) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = 'any'; inp.min = String(min); inp.value = sp[key] ?? 0;
      inp.addEventListener('input', () => { sp[key] = Number(inp.value); renderTimeline(); schedule(); });
      return inp;
    };
    tr.append(td(num('time')), td((() => {
      const sel = document.createElement('select');
      for (const k of state.data.enemies) { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.append(o); }
      sel.value = sp.key;
      sel.addEventListener('change', () => { sp.key = sel.value; renderTimeline(); schedule(); });
      return sel;
    })()), td(num('count', 1)), td(num('interval')), td((() => {
      const sel = document.createElement('select');
      for (let r = 0; r < (state.spec.routes ?? []).length; r++) { const o = document.createElement('option'); o.value = String(r); o.textContent = `#${r}`; sel.append(o); }
      sel.value = String(sp.routeIndex ?? 0);
      sel.addEventListener('change', () => { sp.routeIndex = Number(sel.value); renderTimeline(); schedule(); });
      return sel;
    })()), td((() => {
      const sel = document.createElement('select');
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '（无）'; sel.append(o0);
      for (const s of state.data.vocab.slots) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.append(o); }
      sel.value = sp.slot ?? '';
      sel.addEventListener('change', () => { if (sel.value) sp.slot = sel.value; else delete sp.slot; renderTimeline(); schedule(); });
      return sel;
    })()), td((() => {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sp.unharmful === true;
      cb.addEventListener('change', () => { if (cb.checked) sp.unharmful = true; else delete sp.unharmful; renderTimeline(); schedule(); });
      return cb;
    })()), td((() => {
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
      del.addEventListener('click', () => { spawns.splice(i, 1); state.sel = 0; renderTimeline(); renderTable(); schedule(); });
      return del;
    })()));
    table.append(tr);
  });
  box.append(table);
}

// ---- side panel --------------------------------------------------------------------------------------------------

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
  const spec = state.spec;
  if (!spec) { box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '左边选一张出怪表，或点「新建出怪表」。' })); return; }

  box.append(h('出怪表'));
  const idBox = document.createElement('div'); idBox.className = 'panel';
  const field = (label, node) => { const d = document.createElement('div'); const l = document.createElement('label'); l.textContent = label; d.append(l, node); return d; };
  const idIn = document.createElement('input'); idIn.value = spec.id ?? '';
  idIn.addEventListener('input', () => { spec.id = idIn.value; schedule(); });
  idBox.append(field('id（slug）', idIn));
  const kindSel = document.createElement('select');
  for (const k of state.data.vocab.kinds) { const o = document.createElement('option'); o.value = k; o.textContent = k; kindSel.append(o); }
  kindSel.value = spec.kind ?? 'normal';
  kindSel.addEventListener('change', () => { spec.kind = kindSel.value; schedule(); });
  idBox.append(field('类型 kind', kindSel));
  box.append(idBox);

  box.append(h('路线（这张表自己带的）'));
  const rtBox = document.createElement('div'); rtBox.className = 'panel';
  (spec.routes ?? []).forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'row';
    row.style.marginBottom = '4px';
    const lbl = document.createElement('span');
    lbl.textContent = `#${i} ${r.motion} ${(r.start ?? []).join(',')}→${(r.end ?? []).join(',')}`;
    lbl.style.flex = '1';
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    del.addEventListener('click', () => { spec.routes.splice(i, 1); drawMap(); renderTimeline(); renderTable(); schedule(); });
    row.append(lbl, del);
    rtBox.append(row);
  });
  const addR = document.createElement('button'); addR.className = 'ghost'; addR.textContent = '＋ 复制上一条路线';
  addR.addEventListener('click', () => {
    const last = spec.routes[spec.routes.length - 1] ?? { motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] };
    spec.routes.push(JSON.parse(JSON.stringify(last)));
    drawMap(); renderTimeline(); renderTable(); schedule();
  });
  rtBox.append(addR);
  rtBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '路线的起点/终点坐标请在「地图设计器」里画好，这里只引用。' }));
  box.append(rtBox);

  box.append(h('绑定到回合（方案 B）'));
  const bindBox = document.createElement('div'); bindBox.className = 'panel';
  (spec.usedBy ?? []).forEach((u, i) => {
    const row = document.createElement('div'); row.className = 'row'; row.style.marginBottom = '4px';
    const mode = document.createElement('select');
    for (const m of state.data.modes) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name} (${m.id})`; mode.append(o); }
    mode.value = u.modeId;
    mode.addEventListener('change', () => { u.modeId = mode.value; schedule(); });
    const round = document.createElement('input');
    round.type = 'number'; round.min = '1'; round.max = String(state.data.vocab.roundsPerMode); round.value = u.round;
    round.style.maxWidth = '70px';
    round.addEventListener('input', () => { u.round = Number(round.value); schedule(); });
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    del.addEventListener('click', () => { spec.usedBy.splice(i, 1); renderSide(); schedule(); });
    row.append(mode, round, del);
    bindBox.append(row);
  });
  const addB = document.createElement('button'); addB.className = 'ghost'; addB.textContent = '＋ 加一条绑定';
  addB.addEventListener('click', () => {
    spec.usedBy.push({ modeId: (state.data.modes[0] ?? {}).id ?? 'mode_multi_normal', round: 1 });
    renderSide(); schedule();
  });
  bindBox.append(addB);
  bindBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '绑定只记录意图：真正让这张表生效，是在「地图设计器」里给地图写 rounds 指向它（方案 B）。',
  }));
  box.append(bindBox);

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? '保存中…' : '保存';
  save.disabled = state.busy || !spec.id;
  save.addEventListener('click', saveWave);
  actions.append(save);
  if (state.waveId) {
    const del = document.createElement('button'); del.textContent = '删除';
    del.addEventListener('click', deleteWave);
    actions.append(del);
  }
  box.append(actions);

  box.append(h('推导与校验'));
  const pv = document.createElement('div'); pv.className = 'panel';
  const rec = state.preview?.record;
  if (rec) {
    pv.append(Object.assign(document.createElement('div'), {
      className: 'dim',
      textContent: `totalCount ${rec.totalCount} · slotCounts ${JSON.stringify(rec.slotCounts)}`,
    }));
  }
  if (state.preview?.ok && !(state.preview.warnings ?? []).length) pv.append(Object.assign(document.createElement('div'), { className: 'ok', textContent: '✔ 校验通过' }));
  for (const e of state.preview?.errors ?? []) {
    const d = document.createElement('div'); d.className = 'err';
    d.textContent = `${e.field || '(记录)'} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}`;
    pv.append(d);
  }
  for (const w of state.preview?.warnings ?? []) {
    const d = document.createElement('div'); d.className = 'warn'; d.textContent = String(w);
    pv.append(d);
  }
  box.append(pv);
}

// ---- preview / save ----------------------------------------------------------------------------------------------

let timer = null;
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(preview, now ? 0 : 320);
}
async function preview() {
  if (!state.spec) return;
  try {
    state.preview = await api('/api/waves/preview', { method: 'POST', body: { spec: currentSpec() } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: e.message }], warnings: [] };
  }
  renderSide();
}

async function saveWave() {
  if (!state.packId) {
    const id = prompt('保存到哪个工坊包？', 'my-wave-pack');
    if (!id) return;
    state.packId = id.trim();
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/waves`, { method: 'POST', body: { spec: currentSpec() } });
    state.waveId = r.id;
    state.message = { kind: 'ok', text: `已保存 ${r.id}，生成 ${r.generated.join(', ')}。` };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteWave() {
  if (!state.waveId || !confirm(`删除出怪表 ${state.waveId}？`)) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/waves/${encodeURIComponent(state.waveId)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: `已删除 ${state.waveId}` };
    state.waveId = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

// ---- list / load -------------------------------------------------------------------------------------------------

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk('＋ 新建出怪表', 'item', () => { state.waveId = null; state.spec = blankSpec(); state.preview = null; state.sel = 0; renderList(); renderTimeline(); renderTable(); renderSide(); drawMap(); schedule(true); }));
  for (const w of state.data?.waves ?? []) {
    const errs = (w.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${w.id === state.waveId ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${w.id}${errs ? ` <span class="tag err">${errs}</span>` : ''}</div>`
      + `<div class="m">${w.pack} · ${w.kind ?? '?'}</div>`
      + `<div class="m">${w.spawns} 次 · ${w.totalCount} 只 · 路线 ${w.routes}</div>`
      + `<div class="m">${w.modeRounds.length ? w.modeRounds.join(' ') : '未绑定回合'}${w.managed ? ' · 可编辑' : ' · 非编辑器管理'}</div>`;
    el.addEventListener('click', () => openWave(w));
    box.append(el);
  }
}

async function openWave(w) {
  state.packId = w.pack;
  state.waveId = w.id;
  state.message = null;
  try {
    const r = await api(`/api/waves/${encodeURIComponent(w.pack)}/${encodeURIComponent(w.id)}`);
    state.spec = r.spec ?? specFromRecord(r.record);
    state.sel = 0;
    renderList(); renderTimeline(); renderTable(); renderSide(); drawMap(); schedule(true);
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

/** Read a generated record back into a spec (for a wave the editor did not author). */
function specFromRecord(rec) {
  const base = blankSpec();
  if (!rec) return base;
  return {
    ...base,
    id: String(rec.id || '').replace(/^wave_ws_/, ''),
    kind: rec.kind ?? 'normal', solo: rec.solo === true,
    characterLimit: rec.characterLimit ?? 8, moveMultiplier: rec.moveMultiplier ?? 0.5,
    routes: rec.routes ?? base.routes,
    spawns: (rec.spawns ?? []).map((s) => ({ ...s })),
    usedBy: (rec.usedBy ?? []).map((u) => ({ modeId: u.modeId, round: u.round, bossId: u.bossId ?? null })),
    branches: rec.branches ?? {}, overrides: rec.overrides ?? {}, devices: rec.devices ?? [],
  };
}

async function load() {
  state.data = await api('/api/waves');
  $('#rootPath').textContent = state.data.waves.length ? `${state.data.waves.length} 张工坊出怪表` : '还没有工坊出怪表';
  if (!state.packId) state.packId = state.data.waves[0]?.pack ?? null;
  // the map picker: the routes a wave walks are shown over whichever map is chosen
  const pick = $('#mapPick');
  pick.replaceChildren();
  for (const s of state.data.stages) {
    const o = document.createElement('option'); o.value = s.id;
    o.textContent = `${s.official ? '官方' : s.pack} · ${s.name}${s.rounds ? ' （自带回合）' : ''}`;
    pick.append(o);
  }
  if (!state.mapId && state.data.stages.length) state.mapId = state.data.stages[0].id;
  pick.value = state.mapId ?? '';
  $('#mapInfo').textContent = (state.data.stages.find((s) => s.id === state.mapId)?.official ? '官方地图' : '工坊地图') ?? '';
  renderList();
  if (!state.spec) renderTimeline(), renderTable();
  renderSide();
  drawMap();
}

$('#mapPick').addEventListener('change', () => { state.mapId = $('#mapPick').value; drawMap(); });
$('#ovPaths').addEventListener('click', () => { state.showPaths = !state.showPaths; drawMap(); });
$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.waveId = null; state.spec = blankSpec(); state.preview = null; state.sel = 0; renderList(); renderTimeline(); renderTable(); renderSide(); drawMap(); schedule(true); });

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: `载入失败：${e.message}` })); });
