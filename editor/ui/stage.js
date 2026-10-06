// editor/ui/stage.js — the 2D map placer (docs/EDITOR.md). Plain DOM + Canvas, no build step.
//
// The placer only edits the SPEC (rows / tiles / devices); every mechanical field — the two path tables and the deploy
// tiles — is DERIVED server-side by the sim (server/stageAuthoring.js) and shown back through /api/stages/preview, so
// what you see on the overlays is what the engine will actually compute. Painting never invents those tables.
//
// It also offers a 3D preview (stage3d.js) built on the GAME's own renderer; when the local board art, WebGL2 or
// three.js is missing it says why and stays on this 2D canvas — the same fallback the game client uses.

import { createStageView3d } from './stage3d.js';

const $ = (s) => document.querySelector(s);
const CELL = 32;                 // 21 × 32 = 672 wide, 19 × 32 = 608 tall (the canvas size)
const ROWS = 19;
const COLS = 21;

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = {
  data: null, packId: null, stageId: null,
  cells: null, spec: null, preview: null,
  brush: 'r', tool: 'brush', deviceRole: 'crate',
  showDeploy: true, showPaths: true, showRoutes: true,
  routeMotion: 'WALK', draft: [],
  message: null, busy: false,
  // 3D 预览: the game's own renderer over this map, or a documented reason to stay 2D (no local art / no WebGL2 / …)
  mode3d: false, view3d: null, reason3d: null,
  // `?board=3d` (the game client's convention) opens the first map straight into the 3D preview
  auto3d: typeof location !== 'undefined' && new URLSearchParams(location.search).get('board') === '3d',
};

const canvas = $('#board');
const ctx = canvas.getContext('2d');

// ---- spec helpers ------------------------------------------------------------------------------------------------

/** The default legend covers the whole palette, so any palette glyph can be painted immediately. */
function defaultLegend() {
  const out = {};
  for (const t of state.data?.palette ?? []) {
    out[t.glyph] = {
      tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable,
      groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE',
      special: t.special ?? null, ...(t.terrain ? { terrain: t.terrain } : {}), bb: {},
    };
  }
  return out;
}

function blankSpec() {
  const cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'f'));
  cells[9][0] = 'S';
  cells[9][COLS - 1] = 'E';
  return {
    id: '', name: '', weight: 50, modes: [],
    rows: cells.map((r) => r.join('')),
    tiles: defaultLegend(),
    devices: [],
    options: { characterLimit: 8, moveMultiplier: 0.5 },
  };
}

const rowsFromCells = () => state.cells.map((r) => r.join(''));

/** The spec sent to the server: rows come from the painting, everything else from the form. */
function currentSpec() {
  return {
    id: state.spec.id, name: state.spec.name, weight: state.spec.weight, modes: [...state.spec.modes],
    rows: rowsFromCells(), tiles: state.spec.tiles, devices: state.spec.devices, options: state.spec.options,
    // the authored ROUTES (出生点 → 防守点). They live in the spec, not in the stage record: the engine reads routes
    // from the wave template, and the wave layer binds the map's routes to rounds.
    routes: Array.isArray(state.spec.routes) ? state.spec.routes : [],
  };
}

function loadSpec(spec) {
  state.spec = spec;
  const legend = spec.tiles && Object.keys(spec.tiles).length ? spec.tiles : defaultLegend();
  state.spec.tiles = legend;
  if (!Array.isArray(state.spec.routes)) state.spec.routes = [];
  state.draft = [];
  state.cells = Array.from({ length: ROWS }, (_, r) => {
    const line = String((spec.rows ?? [])[r] ?? '');
    return Array.from({ length: COLS }, (_, c) => line[c] ?? 'f');
  });
  state.preview = null;
  schedulePreview(true);
}

// ---- drawing -----------------------------------------------------------------------------------------------------

const colorOf = (glyph) => (state.data?.palette ?? []).find((t) => t.glyph === glyph)?.color ?? '#2a2d33';
const cellAt = (ev) => {
  const rect = canvas.getBoundingClientRect();
  const c = Math.floor(((ev.clientX - rect.left) / rect.width) * COLS);
  const rr = Math.floor(((ev.clientY - rect.top) / rect.height) * ROWS);
  const r = ROWS - 1 - rr;
  return r >= 0 && r < ROWS && c >= 0 && c < COLS ? { r, c } : null;
};
const px = (c) => c * CELL;
const py = (r) => (ROWS - 1 - r) * CELL;

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.cells) return;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      ctx.fillStyle = colorOf(state.cells[r][c]);
      ctx.fillRect(px(c), py(r), CELL, CELL);
      ctx.strokeStyle = '#00000044';
      ctx.strokeRect(px(c) + 0.5, py(r) + 0.5, CELL - 1, CELL - 1);
    }
  }
  const rec = state.preview?.record;
  // deploy tiles: what the sim derives, not what the author typed
  if (state.showDeploy && rec?.deployTiles) {
    const paint = (list, color) => {
      ctx.fillStyle = color;
      for (const [r, c] of list) if (r >= 0 && r < ROWS && c >= 0 && c < COLS) ctx.fillRect(px(c) + 4, py(r) + 4, CELL - 8, CELL - 8);
    };
    paint(rec.deployTiles.normal.melee, '#4ec98a55');
    paint(rec.deployTiles.normal.rangedOnly, '#5b9dff55');
    paint(rec.deployTiles.bossLeft.melee.concat(rec.deployTiles.bossRight.melee), '#4ec98a25');
  }
  // ground routes: the sim's own flow field, so the painter sees what enemies will walk
  if (state.showPaths && rec?.groundPaths) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e0b35788';
    for (const path of Object.values(rec.groundPaths)) {
      if (!Array.isArray(path) || path.length < 2) continue;
      ctx.beginPath();
      path.forEach(([r, c], i) => {
        const x = px(c) + CELL / 2;
        const y = py(r) + CELL / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
  // authored ROUTES (出生点 → 防守点): drawn from the sim's own walk when the preview has it, so what you see is what
  // the enemies will do; the raw points are the fallback while the map is still invalid.
  if (state.showRoutes) {
    ctx.lineWidth = 4;
    for (const [i, route] of (state.spec?.routes ?? []).entries()) {
      const derived = state.preview?.routePaths?.[i];
      const pts = derived && Array.isArray(derived.path) ? derived.path : [route.start, ...(route.checkpoints ?? []), route.end].filter(Array.isArray);
      if (pts.length < 2) continue;
      ctx.strokeStyle = route.motion === 'FLY' ? '#a06bffcc' : '#ff8f3fcc';
      ctx.setLineDash(derived && !derived.path ? [4, 4] : []);
      ctx.beginPath();
      pts.forEach(([r, c], k) => { const x = px(c) + CELL / 2; const y = py(r) + CELL / 2; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // where each route starts (gate) and ends (objective)
    for (const route of state.spec?.routes ?? []) {
      for (const [p, color] of [[route.start, '#ff5a5a'], [route.end, '#3fd07a']]) {
        if (!Array.isArray(p)) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px(p[1]) + CELL / 2, py(p[0]) + CELL / 2, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // the route being drawn right now
    if (state.draft.length) {
      ctx.strokeStyle = '#ffffffcc';
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 4]);
      if (state.draft.length > 1) {
        ctx.beginPath();
        state.draft.forEach(([r, c], k) => { const x = px(c) + CELL / 2; const y = py(r) + CELL / 2; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffffdd';
      for (const [r, c] of state.draft) { ctx.beginPath(); ctx.arc(px(c) + CELL / 2, py(r) + CELL / 2, 4, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // devices sit on top of the terrain
  for (const d of state.spec?.devices ?? []) {
    const [r, c] = d.pos ?? [];
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    ctx.fillStyle = d.active === false ? '#77777788' : '#f0736bcc';
    ctx.fillRect(px(c) + 8, py(r) + 8, CELL - 16, CELL - 16);
  }
  // row labels: row 0 is the BOTTOM row, as the engine stores it
  ctx.fillStyle = '#9aa3b2';
  ctx.font = '10px monospace';
  for (let r = 0; r < ROWS; r += 3) ctx.fillText(String(r), 2, py(r) + 11);
}

// ---- interaction -------------------------------------------------------------------------------------------------

function paintAt(cell) {
  if (!cell || !state.cells) return false;
  if (state.tool === 'erase') { if (state.cells[cell.r][cell.c] === 'f') return false; state.cells[cell.r][cell.c] = 'f'; }
  else if (state.tool === 'brush') { if (state.cells[cell.r][cell.c] === state.brush) return false; state.cells[cell.r][cell.c] = state.brush; }
  else return false;
  return true;
}

let painting = false;
canvas.addEventListener('mousedown', (ev) => {
  const cell = cellAt(ev);
  if (!cell || !state.spec) return;
  if (state.tool === 'device') {
    state.spec.devices.push({ key: deviceKey(state.deviceRole), name: state.deviceRole, alias: null, pos: [cell.r, cell.c], dir: 'UP', hidden: false, role: state.deviceRole });
    draw(); renderSide(); schedulePreview();
    return;
  }
  if (state.tool === 'route') {
    state.draft.push([cell.r, cell.c]);
    draw(); renderSide();
    return;
  }
  painting = true;
  if (paintAt(cell)) { draw(); schedulePreview(); }
});
canvas.addEventListener('mousemove', (ev) => {
  const cell = cellAt(ev);
  $('#cursor').textContent = cell ? `row ${cell.r}, col ${cell.c} · 字符 ${state.cells?.[cell.r]?.[cell.c] ?? '?'}` : '把鼠标移到网格上看坐标。';
  if (painting && cell && paintAt(cell)) { draw(); schedulePreview(); }
});
window.addEventListener('mouseup', () => { painting = false; });
canvas.addEventListener('mouseleave', () => { painting = false; });

function deviceKey(role) {
  return { crate: 'trap_1105_accrate', platform: 'trap_1106_achplat', mound: 'trap_032_mound', blower: 'trap_013_blower', mireController: 'trap_098_mire', turret: 'trap_1104_aclasert' }[role] ?? 'trap_1105_accrate';
}

// ---- preview -----------------------------------------------------------------------------------------------------

let previewTimer = null;
function schedulePreview(now = false) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, now ? 0 : 320);
}
async function preview() {
  if (!state.spec) return;
  try {
    state.preview = await api('/api/stages/preview', { method: 'POST', body: { spec: currentSpec() } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: e.message }], warnings: [] };
  }
  draw();
  // the 3D preview follows every edit too (setStage no-ops when the grid is unchanged, so this is cheap)
  if (state.mode3d && state.view3d) state.view3d.update();
  renderSide();
}

// ---- 3D 预览 (the game's own renderer) ---------------------------------------------------------------------------

/**
 * Turn the 3D preview on or off. The first switch lazily probes availability; ANY failure keeps the 2D canvas and
 * states the reason rather than breaking the placer.
 */
async function toggle3d() {
  if (state.mode3d) {
    state.mode3d = false;
    $('#board').hidden = false;
    $('#board3d').hidden = true;
    syncTools();
    return;
  }
  if (!state.view3d) {
    state.reason3d = '正在准备 3D 预览…';
    renderSide();
    const view = await createStageView3d({
      canvas: $('#board3d'),
      getStage: () => state.preview?.record ?? null,
      onError: (e) => console.warn('[stage3d]', e),
    });
    if (!view.ok) {
      state.reason3d = view.reason;
      state.mode3d = false;
      syncTools();
      renderSide();
      return;
    }
    state.view3d = view;
    state.reason3d = null;
    // a small dev handle: `__spEditor3d.stats()` / `.snapshot()` from the devtools console
    globalThis.__spEditor3d = view;
  }
  state.mode3d = true;
  $('#board').hidden = true;
  $('#board3d').hidden = false;
  state.view3d.resize();
  state.view3d.update();
  syncTools();
  renderSide();
}

// ---- panels ------------------------------------------------------------------------------------------------------

function renderPalette() {
  const box = $('#palette');
  box.replaceChildren();
  for (const t of state.data?.palette ?? []) {
    const el = document.createElement('div');
    el.className = `sw${state.brush === t.glyph && state.tool === 'brush' ? ' on' : ''}`;
    el.title = `${t.tileKey} · ${t.height} · buildable ${t.buildable} · passable ${t.passable}`;
    el.innerHTML = `<i style="background:${t.color}"></i><span>${t.glyph} ${t.label}</span>`;
    el.addEventListener('click', () => { state.brush = t.glyph; state.tool = 'brush'; syncTools(); renderPalette(); });
    box.append(el);
  }
}

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk('＋ 新建地图', 'item', () => { state.stageId = null; loadSpec(blankSpec()); renderList(); renderSide(); draw(); }));
  for (const s of state.data?.stages ?? []) {
    const errs = (s.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${s.id === state.stageId ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${s.name}${errs ? ` <span class="tag err">${errs}</span>` : ''}</div>`
      + `<div class="m">${s.pack} · ${s.id}</div>`
      + `<div class="m">寻路 ${s.groundPaths} 条 · 部署 ${s.deployMelee} 格${s.managed ? ' · 可编辑' : ' · 非编辑器管理'}</div>`;
    el.addEventListener('click', () => openStage(s));
    box.append(el);
  }
}

async function openStage(s) {
  state.packId = s.pack;
  state.stageId = s.id;
  state.message = null;
  try {
    const r = await api(`/api/stages/${encodeURIComponent(s.pack)}/${encodeURIComponent(s.id)}`);
    loadSpec(r.spec ?? { ...blankSpec(), id: s.id, name: s.name });
    renderList(); renderSide();
    // `?board=3d` opens straight into the 3D preview (the game client's own convention, public/js/app.js); the probe
    // still decides — on a machine without the local art or WebGL2 this stays 2D and says why.
    if (state.auto3d && !state.mode3d) await toggle3d();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

function renderSide() {
  const box = $('#side');
  box.replaceChildren();
  const spec = state.spec;
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }
  if (!spec) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '左边选一张地图，或点「新建地图」。'; box.append(p); return; }

  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  const field = (label, input) => { const d = document.createElement('div'); const l = document.createElement('label'); l.textContent = label; d.append(l, input); return d; };
  const text = (get, set, attrs = {}) => { const i = document.createElement('input'); i.value = get() ?? ''; Object.assign(i, attrs); i.addEventListener('input', () => { set(i.value); schedulePreview(); }); return i; };
  const num = (get, set) => { const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.value = get() ?? 0; i.addEventListener('input', () => { set(Number(i.value)); schedulePreview(); }); return i; };

  box.append(h('地图'));
  const identity = document.createElement('div'); identity.className = 'panel';
  identity.append(
    field('id（slug）', text(() => spec.id, (v) => { spec.id = v; })),
    field('名称', text(() => spec.name, (v) => { spec.name = v; })),
    field('权重 weight', num(() => spec.weight, (v) => { spec.weight = v; })),
  );
  box.append(identity);

  box.append(h('可选中的模式（必须至少选一个）'));
  const modesBox = document.createElement('div'); modesBox.className = 'panel';
  for (const m of state.data?.modes ?? []) {
    const lab = document.createElement('label');
    lab.style.color = 'var(--fg)';
    lab.style.display = 'flex'; lab.style.gap = '6px'; lab.style.alignItems = 'center';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.style.width = 'auto'; cb.checked = spec.modes.includes(m.id);
    cb.addEventListener('change', () => {
      spec.modes = cb.checked ? [...spec.modes, m.id] : spec.modes.filter((x) => x !== m.id);
      schedulePreview();
    });
    lab.append(cb, document.createTextNode(`${m.name} (${m.id})`));
    modesBox.append(lab);
  }
  if (!(state.data?.modes ?? []).length) modesBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '（没有可选模式）' }));
  box.append(modesBox);

  box.append(h('装置'));
  const devBox = document.createElement('div'); devBox.className = 'panel';
  if (spec.devices.length) {
    spec.devices.forEach((d, i) => {
      const row = document.createElement('div'); row.className = 'dev';
      const label = document.createElement('span'); label.textContent = `${d.role ?? '?'} @ [${(d.pos ?? []).join(', ')}]`;
      const hidden = document.createElement('button'); hidden.className = 'ghost'; hidden.textContent = d.active === false ? '隐藏' : '激活';
      hidden.title = '隐藏的装置在对局开始时不存在（由效果打开）';
      hidden.addEventListener('click', () => { d.active = d.active === false; schedulePreview(); });
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
      del.addEventListener('click', () => { spec.devices.splice(i, 1); schedulePreview(); });
      row.append(label, hidden, del);
      devBox.append(row);
    });
  } else devBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '（还没有装置）' }));
  const roleSel = document.createElement('select');
  for (const r of ['crate', 'platform', 'mound', 'blower', 'mireController', 'turret']) {
    const o = document.createElement('option'); o.value = r; o.textContent = r; roleSel.append(o);
  }
  roleSel.value = state.deviceRole;
  roleSel.addEventListener('change', () => { state.deviceRole = roleSel.value; state.tool = 'device'; syncTools(); });
  devBox.append(field('要摆放的装置类型', roleSel));
  devBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '选「放装置」工具后点网格放置。' }));
  box.append(devBox);

  box.append(h('路线（出生点 → 防守点）'));
  const routeBox = document.createElement('div'); routeBox.className = 'panel';
  const draftInfo = document.createElement('p'); draftInfo.className = 'hint';
  draftInfo.textContent = state.draft.length
    ? `正在画：${state.draft.length} 个点，起点 ${state.draft[0].join(',')}。继续点网格加检查点，然后按「完成路线」。`
    : '选「画路线」工具后依次点击：第一下是起点（城门 S），中间是检查点，最后按「完成路线」收尾。WALK 走地面寻路，FLY 直线飞。';
  routeBox.append(draftInfo);
  const motionSel = document.createElement('select');
  for (const m of ['WALK', 'FLY']) { const o = document.createElement('option'); o.value = m; o.textContent = m === 'WALK' ? 'WALK（地面，按寻路走）' : 'FLY（飞行，直线）'; motionSel.append(o); }
  motionSel.value = state.routeMotion;
  motionSel.addEventListener('change', () => { state.routeMotion = motionSel.value; });
  routeBox.append(field('新路线的运动方式', motionSel));
  const rrow = document.createElement('div'); rrow.className = 'row';
  const finish = document.createElement('button'); finish.className = 'primary'; finish.textContent = '完成路线';
  finish.disabled = state.draft.length < 2;
  finish.addEventListener('click', () => {
    const d = state.draft;
    state.spec.routes.push({ motion: state.routeMotion, start: d[0], end: d[d.length - 1], checkpoints: d.slice(1, -1) });
    state.draft = [];
    schedulePreview(true);
  });
  const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = '取消当前路线';
  cancel.disabled = !state.draft.length;
  cancel.addEventListener('click', () => { state.draft = []; draw(); renderSide(); });
  rrow.append(finish, cancel);
  routeBox.append(rrow);
  if (!(state.spec.routes ?? []).length) {
    routeBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '（还没有路线：这张图上的敌人目前没有从出生点到防守点的走法）' }));
  }
  (state.spec.routes ?? []).forEach((route, i) => {
    const row = document.createElement('div'); row.className = 'dev';
    const label = document.createElement('span');
    const rp = state.preview?.routePaths?.[i];
    const bad = rp && !rp.path;
    label.textContent = `${route.motion} ${(route.start ?? []).join(',')} → ${(route.end ?? []).join(',')}${(route.checkpoints ?? []).length ? ` (+${route.checkpoints.length})` : ''}${bad ? ' ⚠ 无路可走' : ''}`;
    if (bad) label.className = 'err';
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    del.addEventListener('click', () => { state.spec.routes.splice(i, 1); schedulePreview(true); });
    row.append(label, document.createElement('span'), del);
    routeBox.append(row);
  });
  routeBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '路线存在工坊包的 spec 里（引擎的 routes 属于出怪表，由下一步的出怪编辑器绑定到回合）。',
  }));
  box.append(routeBox);

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? '保存中…' : '保存并推导';
  save.disabled = state.busy || !spec.id;
  save.addEventListener('click', saveStage);
  actions.append(save);
  if (state.stageId) {
    const del = document.createElement('button'); del.textContent = '删除该地图';
    del.addEventListener('click', deleteStage);
    actions.append(del);
  }
  box.append(actions);
  if (!spec.id) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '先填一个 id 才能保存。' }));

  box.append(h('校验与推导结果'));
  const pv = document.createElement('div'); pv.className = 'panel';
  const rec = state.preview?.record;
  if (!state.preview) pv.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '（改动后会自动推导）' }));
  else {
    if (rec) {
      const info = document.createElement('p');
      info.className = 'hint';
      info.textContent = `推导：寻路 ${Object.keys(rec.groundPaths).length} 条（含装置 ${Object.keys(rec.groundPathsWithDevices).length} 条）· 部署 ${rec.deployTiles.normal.melee.length} 近战 / ${rec.deployTiles.normal.rangedOnly.length} 远程`;
      pv.append(info);
    }
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
  box.append(pv);
}

function syncTools() {
  $('#toolBrush').className = state.tool === 'brush' ? 'on' : '';
  $('#toolDevice').className = state.tool === 'device' ? 'on' : '';
  $('#toolErase').className = state.tool === 'erase' ? 'on' : '';
  $('#toolRoute').className = state.tool === 'route' ? 'on' : '';
  $('#ovDeploy').className = state.showDeploy ? 'on' : '';
  $('#ovPaths').className = state.showPaths ? 'on' : '';
  $('#ovRoutes').className = state.showRoutes ? 'on' : '';
  const b3 = $('#ov3d');
  if (b3) {
    b3.className = state.mode3d ? 'on' : '';
    b3.textContent = state.mode3d ? '3D 预览（点回 2D）' : '3D 预览';
  }
  const hint = $('#hint3d');
  if (hint) {
    hint.textContent = state.reason3d ?? (state.mode3d
      ? '拖动平移 · 滚轮缩放 · Shift+拖动（或右键拖动）调俯角。这一层是游戏自己的 3D 渲染器跑你这张地图。'
      : '');
    hint.className = state.reason3d ? 'hint warn' : 'hint';
  }
}

async function saveStage() {
  if (!state.packId) {
    const id = prompt('保存到哪个工坊包？（id：字母数字下划线短横线）', state.packId ?? 'my-map-pack');
    if (!id) return;
    state.packId = id.trim();
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/stages`, { method: 'POST', body: { spec: currentSpec() } });
    state.stageId = r.id;
    state.message = { kind: 'ok', text: `已保存 ${r.id}，生成 ${r.generated.join(', ')}。重启游戏服务器后生效。` };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteStage() {
  if (!state.stageId || !confirm(`删除地图 ${state.stageId}？`)) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/stages/${encodeURIComponent(state.stageId)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: `已删除 ${state.stageId}` };
    state.stageId = null; state.spec = null; state.cells = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

async function load() {
  state.data = await api('/api/stages');
  $('#rootPath').textContent = state.data.stages.length ? `${state.data.stages.length} 张工坊地图` : '还没有工坊地图';
  if (!state.packId) state.packId = state.data.stages[0]?.pack ?? null;
  renderList();
  renderPalette();
  renderSide();
  draw();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.stageId = null; loadSpec(blankSpec()); renderList(); renderSide(); draw(); });
$('#toolBrush').addEventListener('click', () => { state.tool = 'brush'; syncTools(); renderPalette(); });
$('#toolDevice').addEventListener('click', () => { state.tool = 'device'; syncTools(); });
$('#toolErase').addEventListener('click', () => { state.tool = 'erase'; syncTools(); });
$('#toolRoute').addEventListener('click', () => { state.tool = 'route'; syncTools(); renderSide(); });
$('#ovRoutes').addEventListener('click', () => { state.showRoutes = !state.showRoutes; syncTools(); draw(); });
$('#ov3d').addEventListener('click', () => { void toggle3d(); });
$('#ovDeploy').addEventListener('click', () => { state.showDeploy = !state.showDeploy; syncTools(); draw(); });
$('#ovPaths').addEventListener('click', () => { state.showPaths = !state.showPaths; syncTools(); draw(); });

syncTools();
load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: `载入失败：${e.message}` })); });
