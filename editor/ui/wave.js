// editor/ui/wave.js — the wave (出怪) designer: a time axis over the map's routes, plus an exact table.
//
// Two halves, because both matter:
//   * the TIMELINE (a lane per spawn, x = seconds) makes 顺序/时间/间隔/数量 legible at a glance;
//   * the TABLE is where the numbers are actually typed — a canvas drag is a nice-to-have, an exact field is not.
//
// The MAP panel draws the routes of whichever map is chosen, using the same `deriveRoutePaths` the map editor uses, so
// the author sees which route each spawn walks. Routes live in the wave (the engine reads them from there); the map is
// only a reference for their geometry.
//
// 界面文案走 i18n：t('中文原文') 查英文词典，查不到就原样返回中文（editor/ui/i18n.js 说明了这个取舍）。
//
// 本页的文案与游戏数据在同一段代码里：`${m.name} (${m.id})` 这类是数据（干员/怪物名字与 id），不进 t()；
// 表头、按钮、提示这些给作者看的才进。

import { t, mountI18n } from './i18n.js';
// 出怪页的两处「把话说清楚」：阵营占位符提示、以及这张表真正在哪张图的哪几个回合生效（纯逻辑，单独测）。
import { isPlaceholderEnemy, placeholderSpawns, mapsUsingWave } from './waveHints.js';
import { packSelect } from './packPicker.js';
// 底图：把选中地图的地形画到路线画布上（纯逻辑在 terrain.js，单独测）
import { terrainGrid, colorOfGlyph, stageById } from './terrain.js';

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
  // 底图：画选中的那张地图的真实地形。路线定义在地图页、引用在这里，没有底图就只能靠肉眼对着抄坐标，
  // 抄错一格就是「怪从墙里出来」这种极难查的问题。地图没有地形数据时退回空网格。
  const map = stageById(state.data?.stages, state.mapId);
  const terrain = terrainGrid(map, { rows: ROWS, cols: COLS });
  if (terrain) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = colorOfGlyph(state.data?.palette, terrain[r][c], map?.tiles);
        ctx.fillRect(px(c), py(r), CELL, CELL);
      }
    }
  }
  ctx.strokeStyle = terrain ? '#00000033' : '#ffffff0d';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) ctx.strokeRect(px(c) + .5, py(r) + .5, CELL, CELL);
  // 地图自己画的装置也标一下：路线会不会被装置挡住是作者要判断的事
  for (const d of (map?.devices ?? [])) {
    const [r, c] = Array.isArray(d?.pos) ? d.pos : [];
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    ctx.fillStyle = '#e0b357cc';
    ctx.fillRect(px(c) + 2, py(r) + 2, CELL - 4, CELL - 4);
  }
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
    box.append(Object.assign(document.createElement('p'), { className: 'hint', style: 'padding:10px 12px', textContent: t('还没有出怪。用下面的「添加一次出怪」开始。') }));
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
    blk.textContent = `${sp.key ?? '?'} ×${sp.count ?? 1}${sp.unharmful ? ' ' + t('（不计）') : ''}`;
    blk.title = t('{0} ×{1} @{2}s 间隔 {3}s · route #{4} · slot {5}',
      sp.key ?? '?', sp.count ?? 1, sp.time ?? 0, sp.interval ?? 0, sp.routeIndex ?? 0, sp.slot ?? '—');
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
  add.textContent = t('＋ 添加一次出怪');
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
  // 表头逐条查词典；本地变量不叫 t，免得把 i18n 的 t 遮住
  for (const label of ['#', t('时间(s)'), t('敌人'), t('数量'), t('间隔(s)'), t('路线'), t('槽位 slot'), t('不计入'), '']) {
    const th = document.createElement('th'); th.textContent = label; head.append(th);
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
      for (const k of state.data.enemies) {
        const o = document.createElement('option'); o.value = k;
        // 占位符在选项里就标出来：它出的不是这只怪，而是阵营随机怪
        o.textContent = isPlaceholderEnemy(k, state.data.placeholderEnemies) ? `${k} ${t('（阵营占位符）')}` : k;
        sel.append(o);
      }
      sel.value = sp.key;
      sel.addEventListener('change', () => { sp.key = sel.value; renderSide(); renderTimeline(); schedule(); });
      return sel;
    })()), td(num('count', 1)), td(num('interval')), td((() => {
      const sel = document.createElement('select');
      for (let r = 0; r < (state.spec.routes ?? []).length; r++) { const o = document.createElement('option'); o.value = String(r); o.textContent = `#${r}`; sel.append(o); }
      sel.value = String(sp.routeIndex ?? 0);
      sel.addEventListener('change', () => { sp.routeIndex = Number(sel.value); renderTimeline(); schedule(); });
      return sel;
    })()), td((() => {
      const sel = document.createElement('select');
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = t('（无）'); sel.append(o0);
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
  const h = (text) => { const e = document.createElement('h2'); e.textContent = text; return e; };
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }
  const spec = state.spec;
  if (!spec) { box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一张出怪表，或点「新建出怪表」。') })); return; }

  // 阵营占位符：选了它们，实际出的是阵营随机怪，移动方式不匹配时这一波可能一只都不出，而校验器不会说话
  const placeholders = placeholderSpawns(spec.spawns, state.data.placeholderEnemies);
  if (placeholders.length) {
    const warn = document.createElement('div');
    warn.className = 'banner bad';
    warn.textContent = t('这张表用了阵营占位符：{0}。实际出的是阵营随机怪、数量按战力重算；抽到的怪与它移动方式不同时，这一次会一只都不出。', placeholders.join('、'));
    box.append(warn);
  }

  box.append(h(t('出怪表')));
  const idBox = document.createElement('div'); idBox.className = 'panel';
  const field = (label, node) => { const d = document.createElement('div'); const l = document.createElement('label'); l.textContent = label; d.append(l, node); return d; };
  const idIn = document.createElement('input'); idIn.value = spec.id ?? '';
  idIn.addEventListener('input', () => { spec.id = idIn.value; schedule(); });
  idBox.append(field(t('id（slug）'), idIn));
  const kindSel = document.createElement('select');
  for (const k of state.data.vocab.kinds) { const o = document.createElement('option'); o.value = k; o.textContent = k; kindSel.append(o); }
  kindSel.value = spec.kind ?? 'normal';
  kindSel.addEventListener('change', () => { spec.kind = kindSel.value; schedule(); });
  idBox.append(field(t('类型 kind'), kindSel));
  box.append(idBox);

  box.append(h(t('路线（这张表自己带的）')));
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
  const addR = document.createElement('button'); addR.className = 'ghost'; addR.textContent = t('＋ 复制上一条路线');
  addR.addEventListener('click', () => {
    const last = spec.routes[spec.routes.length - 1] ?? { motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] };
    spec.routes.push(JSON.parse(JSON.stringify(last)));
    drawMap(); renderTimeline(); renderTable(); schedule();
  });
  rtBox.append(addR);
  rtBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('路线的起点/终点坐标请在「地图设计器」里画好，这里只引用。') }));
  box.append(rtBox);

  box.append(h(t('绑定到回合（方案 B）')));
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
  const addB = document.createElement('button'); addB.className = 'ghost'; addB.textContent = t('＋ 加一条绑定');
  addB.addEventListener('click', () => {
    spec.usedBy.push({ modeId: (state.data.modes[0] ?? {}).id ?? 'mode_multi_normal', round: 1 });
    renderSide(); schedule();
  });
  bindBox.append(addB);
  bindBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('绑定只记录意图：真正让这张表生效，是在「地图设计器」里给地图写 rounds 指向它（方案 B）。'),
  }));
  box.append(bindBox);

  // 真正生效的地方：地图自己的 rounds/bossRounds（引擎先看这张图、再看模式的模板）。
  // 上面那份是「意图」，这一份是从地图数据里读出来的「事实」—— 两边对不上时作者能当场看出来。
  box.append(h(t('真正在用这张表的地图')));
  const realBox = document.createElement('div'); realBox.className = 'panel';
  const used = mapsUsingWave(spec.id, state.data.stages);
  if (!state.waveId) {
    realBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（这张表还没保存过，保存后再看这里）') }));
  } else if (!used.length) {
    realBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（还没有地图把这张表绑到回合上：去「地图设计器」的回合绑定面板里选它）') }));
  } else {
    for (const u of used) {
      const line = document.createElement('div');
      line.className = 'hint';
      const parts = [];
      if (u.rounds.length) parts.push(t('第 {0} 回合', u.rounds.join('、')));
      if (u.bossRounds.length) parts.push(t('首领回合 {0}', u.bossRounds.join('、')));
      line.textContent = `${u.official ? t('官方地图') : t('工坊地图')} ${u.name} (${u.id}) · ${parts.join(' · ')}`;
      realBox.append(line);
    }
  }
  box.append(realBox);

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? t('保存中…') : t('保存');
  save.disabled = state.busy || !spec.id;
  save.addEventListener('click', saveWave);
  actions.append(save);
  if (state.waveId) {
    const del = document.createElement('button'); del.textContent = t('删除');
    del.addEventListener('click', deleteWave);
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
    askNewId: () => prompt(t('新工坊包的 id（字母数字下划线短横线，≤32）：'), 'my-wave-pack'),
  }));
  box.append(packBox);

  box.append(h(t('推导与校验')));
  const pv = document.createElement('div'); pv.className = 'panel';
  const rec = state.preview?.record;
  if (rec) {
    pv.append(Object.assign(document.createElement('div'), {
      className: 'dim',
      textContent: `totalCount ${rec.totalCount} · slotCounts ${JSON.stringify(rec.slotCounts)}`,
    }));
  }
  if (state.preview?.ok && !(state.preview.warnings ?? []).length) pv.append(Object.assign(document.createElement('div'), { className: 'ok', textContent: t('✔ 校验通过') }));
  for (const e of state.preview?.errors ?? []) {
    const d = document.createElement('div'); d.className = 'err';
    d.textContent = `${e.field || t('（记录）')} [${e.code}] ${e.message}${e.hint ? ` — ${e.hint}` : ''}`;
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
    state.message = { kind: 'error', text: t('先在右边选一个工坊包（或点「＋ 新建一个包…」）。') };
    renderSide();
    return;
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/waves`, { method: 'POST', body: { spec: currentSpec() } });
    state.waveId = r.id;
    state.message = { kind: 'ok', text: t('已保存 {0}，生成 {1}。', r.id, r.generated.join(', ')) };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteWave() {
  if (!state.waveId || !confirm(t('删除出怪表 {0}？', state.waveId))) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/waves/${encodeURIComponent(state.waveId)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: t('已删除 {0}', state.waveId) };
    state.waveId = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

// ---- list / load -------------------------------------------------------------------------------------------------

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk(t('＋ 新建出怪表'), 'item', () => { state.waveId = null; state.spec = blankSpec(); state.preview = null; state.sel = 0; renderList(); renderTimeline(); renderTable(); renderSide(); drawMap(); schedule(true); }));
  for (const w of state.data?.waves ?? []) {
    const errs = (w.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${w.id === state.waveId ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${w.id}${errs ? ` <span class="tag err">${errs}</span>` : ''}</div>`
      + `<div class="m">${w.pack} · ${w.kind ?? '?'}</div>`
      + `<div class="m">${t('{0} 次 · {1} 只 · 路线 {2}', w.spawns, w.totalCount, w.routes)}</div>`
      + `<div class="m">${w.modeRounds.length ? w.modeRounds.join(' ') : t('未绑定回合')}${w.managed ? ' · ' + t('可编辑') : ' · ' + t('非编辑器管理')}</div>`;
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
  if (!state.packId) state.packId = state.data.waves[0]?.pack ?? null;
  // the map picker: the routes a wave walks are shown over whichever map is chosen
  const pick = $('#mapPick');
  pick.replaceChildren();
  for (const s of state.data.stages) {
    const o = document.createElement('option'); o.value = s.id;
    o.textContent = `${s.official ? t('官方') : s.pack} · ${s.name}${s.rounds ? ' ' + t('（自带回合）') : ''}`;
    pick.append(o);
  }
  if (!state.mapId && state.data.stages.length) state.mapId = state.data.stages[0].id;
  pick.value = state.mapId ?? '';
  paintLabels();
  renderList();
  if (!state.spec) renderTimeline(), renderTable();
  renderSide();
  drawMap();
}

/** 页头的「N 张工坊出怪表」与地图归属：换语言时要跟着重画，所以从 load() 里抽出来。 */
function paintLabels() {
  if (!state.data) return;
  $('#rootPath').textContent = state.data.waves.length ? t('{0} 张工坊出怪表', state.data.waves.length) : t('还没有工坊出怪表');
  const map = stageById(state.data.stages, state.mapId);
  // 连底图状态一起说清楚：画布上看到的到底是真地形，还是「这张图没有地形数据」的兜底网格
  const kind = map?.official ? t('官方地图') : t('工坊地图');
  const terrain = terrainGrid(map, { rows: ROWS, cols: COLS }) ? t('底图：{0}', map.name ?? map.id) : t('这张地图没有地形数据，只画网格');
  $('#mapInfo').textContent = `${kind} · ${terrain}`;
}

$('#mapPick').addEventListener('change', () => { state.mapId = $('#mapPick').value; paintLabels(); drawMap(); });
$('#ovPaths').addEventListener('click', () => { state.showPaths = !state.showPaths; drawMap(); });
$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.waveId = null; state.spec = blankSpec(); state.preview = null; state.sel = 0; renderList(); renderTimeline(); renderTable(); renderSide(); drawMap(); schedule(true); });

// 换语言时把本页动态生成的文案重画一遍（HTML 里的静态文案由 mountI18n 换掉）；要在初次 load 之前挂上。
mountI18n(() => { paintLabels(); renderList(); renderTimeline(); renderTable(); renderSide(); });

// 载入失败也走 state.message：换语言会重画右栏，错误得留在页面上而不是被重画抹掉。
load().catch((e) => { state.message = { kind: 'error', text: t('载入失败：{0}', e.message) }; renderSide(); });
