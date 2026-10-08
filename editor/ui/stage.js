// editor/ui/stage.js — the 2D map placer (docs/EDITOR.md). Plain DOM + Canvas, no build step.
//
// The placer only edits the SPEC (rows / tiles / devices); every mechanical field — the two path tables and the deploy
// tiles — is DERIVED server-side by the sim (server/stageAuthoring.js) and shown back through /api/stages/preview, so
// what you see on the overlays is what the engine will actually compute. Painting never invents those tables.
//
// 3D 预览是**默认视图**（`?board=2d` 强制 2D，按钮可随时切回）：它用 GAME 自己的渲染器（stage3d.js），
// 没有本机棋盘素材 / WebGL2 / three.js 时写明原因并留在上面这块 2D 画布 —— 与游戏客户端同一套回退。

// 界面文案走 i18n：t('中文原文') 查英文词典，查不到就原样返回中文（editor/ui/i18n.js 说明了这个取舍）。
import { t, mountI18n } from './i18n.js';
// 回合绑定：引擎真正读的是这张图自己的 rounds（先看它、再看模式的模板），逻辑在 stageRounds.js（纯函数，单独测）。
import { roundRows, waveOptions, missingBindings, setRoundBinding, setBossRoundBinding } from './stageRounds.js';
import { packSelect } from './packPicker.js';
import { colorOfGlyph, deployRuleOf } from './terrain.js';
import { createStageView3d } from './stage3d.js';

const $ = (s) => document.querySelector(s);
const CELL = 32;                 // 世界坐标里一格 32 单位：19 行 × 32 = 608 高，21 列 × 32 = 672 宽
const ROWS = 19;
const COLS = 21;
const WORLD_W = COLS * CELL;
const WORLD_H = ROWS * CELL;
const VIEW_MARGIN = 8;           // fit-to-view 时四周最少留的边距（业主说「只看见左上角一点」，所以留白要小但要有）

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
  // showPaths 默认 false：业主口径是「不许默认新建地图就有寻路」。它画的是引擎的流场寻路表，
  // 而那张表在没点过「自动寻路」之前根本不该被当成这张图的属性来展示。
  showDeploy: true, showPaths: false, showRoutes: true,
  routeMotion: 'WALK', draft: [],
  message: null, busy: false, autorouting: false, playtesting: false,
  // 「以模板新建」的模板清单：点开才去拉（GET /api/stages/templates），失败就地报错。
  templates: null, templatePick: false, templatesError: null,
  // 视图：zoom 是**相对 fit-to-view 的倍数**（1 = 整张图正好塞进容器），panX/panY 是世界坐标的平移量。
  // 这样「缩放百分比」对作者是有意义的数字，而不是一个跟容器大小绑死的比例。
  zoom: 1, panX: 0, panY: 0, panning: false, space: false, boardW: 0, boardH: 0,
  // 3D 预览: the game's own renderer over this map, or a documented reason to stay 2D (no local art / no WebGL2 / …)
  mode3d: false, view3d: null, reason3d: null,
  // `?board=`（游戏客户端自己的约定，public/js/render/app.js）：`2d` 强制 2D 画布，`3d` 立刻打开 3D。
  // **不带参数时也打开 3D** —— 官方棋盘贴图才是让作者看懂一张地图的东西，而任何失败都留在 2D 并写明原因
  // （没有本机素材 / 没有 WebGL2 / 渲染器抛错），所以「默认 3D」不会让谁卡在一块空白画布上。
  board: (() => {
    try { return new URLSearchParams(location.search).get('board'); } catch { return null; }
  })(),
  // 还能不能「自动打开」：作者手动切回 2D 之后就不该再被自动流程扳回 3D（按钮会跟它打架）。
  auto3d: true,
};

const canvas = $('#board');
// 测试与「?board=3d」之外的极端环境都可能拿不到这张画布；没有它就不做任何 2D 绘制，
// 而不是在第一次 mousemove 上抛 TypeError 把整页带停。
const ctx = canvas ? canvas.getContext('2d') : null;

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

/**
 * 这一格是不是「空气」（地图外）。
 *
 * 两档判断，缺一不可：调色板/图例标了 `air: true`（服务端正在加的那条呈现标记），或者字符是 '-'（更早的约定）。
 * 只有真的认出来才把它画成透明斜纹 —— 认不出来的字符照旧按高度上色，绝不因为一个猜测把作者的地形画成空气。
 */
function isAirTile(glyph, entry) {
  return entry?.air === true || glyph === '-';
}

function blankSpec() {
  const cells = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 'f'));
  // 出生点与目标放**下角**（row 0 是引擎的最下面一行，row 2 是贴近底边的第三行）：
  // 空图上第一眼看过去就该知道「S 在这头、E 在那头」，摆在正中间只会让人以为整张图只有一行是路。
  cells[2][0] = 'S';
  cells[2][COLS - 1] = 'E';
  return {
    id: '', name: '', weight: 50, modes: [],
    rows: cells.map((r) => r.join('')),
    tiles: defaultLegend(),
    devices: [],
    // groundHighGround: 普通地面能不能放高台（远程位）干员。默认 false —— 业主口径是
    // 「道路放地面干员、高台放远程位，地面能不能放高台必须由作者自己定」。
    options: { characterLimit: 8, moveMultiplier: 0.5, groundHighGround: false },
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
    // 回合绑定：这张图自己的出怪表（引擎真正读的那份，server/match/waves.js 的 stageTemplateId）。
    // 这里是显式拼字段的，**必须原样带上** —— 漏掉就等于「打开一张绑好回合的地图、随手保存一下，绑定全没了」。
    ...(state.spec.rounds ? { rounds: state.spec.rounds } : {}),
    ...(state.spec.bossRounds ? { bossRounds: state.spec.bossRounds } : {}),
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
  // 新建 / 换图之后**立刻**推导一次（now=true 不防抖）：3D 预览（默认视图）画的就是这次推导回来的 record，
  // 否则新建一张空图会先看到一块什么都没有的棋盘 —— 业主问的「为什么要先填 id 才能看 3D」正是这个。
  schedulePreview(true);
  resetView();
}

// ---- viewport（整图适应视野 + 缩放平移） ---------------------------------------------------------------------------

/**
 * 画布按容器自适应：CSS 由 .stage-view 定成铺满，这里只把**备位图**的大小跟上它的实测尺寸。
 *
 * 为什么必须跟 transform 一起做：业主看到的是「地图只显示左上角那一点点区域」—— 根因是画布写死 672×608、
 * 容器一小就 overflow:auto 只露出左上角。现在画布永远等于容器，再由 zoom/pan 决定画哪一块。
 * devicePixelRatio 也在这里吸收：备位图多几倍像素，缩放的插值才不会糊。
 */
function resizeBoard() {
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  const host = $('#stageView')?.getBoundingClientRect();
  const w = Math.max(240, Math.round(box.width || host?.width || WORLD_W));
  const h = Math.max(160, Math.round(box.height || host?.height || WORLD_H));
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  if (state.boardW === w && state.boardH === h && canvas.width === Math.round(w * dpr)) return;
  state.boardW = w;
  state.boardH = h;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

/**
 * fit-to-view 的比例：整张 19×21 塞进画布，四边各留 VIEW_MARGIN。
 *
 * 下限 0.01：画布比网格还小时（或者被压缩到几十像素）不能算出负数比例 —— 那会把整张图推到视野之外，
 * 屏幕上看着就是「什么都没画」。真实页面里 .stage-view 有 min-height:200px，这条只是兜底。
 */
function fitScale() {
  const w = state.boardW || WORLD_W;
  const h = state.boardH || WORLD_H;
  return Math.max(0.01, Math.min((w - VIEW_MARGIN * 2) / WORLD_W, (h - VIEW_MARGIN * 2) / WORLD_H));
}

/** 当前每世界单位占多少 CSS 像素（fit 比例 × 作者的 zoom）。 */
const viewScale = () => fitScale() * state.zoom;

/** 复位成「整张图正好在视野里」：这是「适应」按钮，也是每次换图的起点。 */
function resetView() {
  state.zoom = 1;
  centerView();
}
function centerView() {
  const s = viewScale();
  state.panX = (state.boardW - WORLD_W * s) / 2;
  state.panY = (state.boardH - WORLD_H * s) / 2;
}

/** 把视图平移限制在「世界始终有一部分留在画布上」的范围内，免得作者把地图推出屏幕再也找不回来。 */
function clampView() {
  const s = viewScale();
  const overflowX = Math.max(0, WORLD_W * s - state.boardW);
  const overflowY = Math.max(0, WORLD_H * s - state.boardH);
  const loX = -overflowX - state.boardW * 0.5, hiX = state.boardW * 0.5;
  const loY = -overflowY - state.boardH * 0.5, hiY = state.boardH * 0.5;
  state.panX = Math.min(hiX, Math.max(loX, state.panX));
  state.panY = Math.min(hiY, Math.max(loY, state.panY));
}

/** 世界坐标 → 画布 CSS 像素。绘制与命中测试都走这两个函数，所以任何缩放平移下它们都不可能对不上。 */
const screenX = (wx) => wx * viewScale() + state.panX;
const screenY = (wy) => wy * viewScale() + state.panY;

/** 乘上当前的视图变换，并把绘制单位收敛到设备像素（这样 lineWidth / 字号仍然是「屏幕上的像素」）。 */
function applyWorld() {
  if (!ctx) return;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const s = viewScale() * dpr;
  ctx.setTransform(s, 0, 0, s, state.panX * dpr, state.panY * dpr);
}

/** 一格在屏幕上的边长（四舍五入到整像素）：整像素才会画出干净的网格线。 */
function cellScreen() {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  return Math.max(1, Math.round(CELL * viewScale() * dpr)) / dpr;
}

/**
 * 一格在屏幕上的标记尺寸（半径 / 线宽之类），带上下限。
 * 屏幕常量在半透明叠层上会显得比格子还大；世界常量在缩小时又会看不见 —— 所以按缩放走，但夹在 3…12 px。
 */
function marker(px) {
  const s = viewScale();
  return Math.min(px, Math.max(3, px * s)) / Math.max(0.35, s);
}

/** 线宽：画布已经被变换过，所以世界坐标里的线宽要除回缩放才是「屏幕上的 N px」。 */
const lineWorld = (px) => px / Math.max(0.05, viewScale());
/** 字号同理：行号在缩小时不能变成糊掉的一团，放大时也不能跟着长成一个格子那么大。 */
const textWorld = (px) => px / Math.max(0.05, viewScale());

// ---- drawing -----------------------------------------------------------------------------------------------------

// 取色实现与出怪页的底图共用一份（editor/ui/terrain.js）
const colorOf = (glyph) => colorOfGlyph(state.data?.palette, glyph, state.spec?.tiles);
let airPattern = null;           // 空气的斜纹：Path2D 只建一次，之后由视图变换统一缩放
// 世界坐标 → 网格左上角。row 0 在**最下面一行**（引擎的约定），所以行号要翻过来。
const py = (r) => (ROWS - 1 - r) * CELL;
/**
 * 屏幕坐标 → 格子。
 *
 * 必须走 getBoundingClientRect() + 当前缩放平移反算（不能再用 rect.width/COLS）：画布会跟着容器变尺寸、
 * 还会被 zoom/pan 变换，直接按比例除会在任何缩放平移下落错格 —— 画笔就会画到旁边一格去。
 * 0.5 是画布的 1px 边框（box-sizing:border-box，rect 含边框而内容区不含）。
 */
const cellAt = (ev) => {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const s = viewScale();
  if (!(s > 0)) return null;
  const x = ev.clientX - rect.left - 0.5;
  const y = ev.clientY - rect.top - 0.5;
  const wx = (x - state.panX) / s;
  const wy = (y - state.panY) / s;
  const c = Math.floor(wx / CELL);
  const rr = Math.floor(wy / CELL);
  const r = ROWS - 1 - rr;
  return r >= 0 && r < ROWS && c >= 0 && c < COLS ? { r, c } : null;
};

function draw() {
  if (!ctx || !canvas) return;
  // 先按设备像素清整块画布（内容可能被平移到画布之外，所以底色得覆盖整个视口）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.cells) return;
  const cs = cellScreen();
  applyWorld();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const g = state.cells[r][c];
      const entry = state.spec?.tiles?.[g];
      // 空气（地图外）：暗底色 + 斜纹，不画成实心墙 —— 画成墙会让作者以为那是地形
      const air = isAirTile(g, entry);
      const pal = (state.data?.palette ?? []).find((x) => x.glyph === g);
      ctx.fillStyle = air ? (pal?.color ?? '#171a20') : colorOf(g);
      ctx.fillRect(c * CELL, py(r), CELL, CELL);
      if (air) airStripe(c, r);
    }
  }
  // 网格线单独走一遍：一条路径比每格一次 strokeRect 快得多
  ctx.beginPath();
  for (let c = 0; c <= COLS; c++) { ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, WORLD_H); }
  for (let i = 0; i <= ROWS; i++) { ctx.moveTo(0, i * CELL); ctx.lineTo(WORLD_W, i * CELL); }
  ctx.strokeStyle = '#00000044';
  ctx.lineWidth = 1 / Math.max(0.35, viewScale());
  ctx.stroke();
  const rec = state.preview?.record;
  // deploy tiles: what the sim derives, not what the author typed
  if (state.showDeploy && rec?.deployTiles) {
    const paint = (list, color) => {
      ctx.fillStyle = color;
      for (const [r, c] of list) if (r >= 0 && r < ROWS && c >= 0 && c < COLS) ctx.fillRect(c * CELL + 4, py(r) + 4, CELL - 8, CELL - 8);
    };
    paint(rec.deployTiles.normal.melee, '#4ec98a55');
    paint(rec.deployTiles.normal.rangedOnly, '#5b9dff55');
    paint(rec.deployTiles.bossLeft.melee.concat(rec.deployTiles.bossRight.melee), '#4ec98a25');
  }
  // 「显示寻路」：叠的是引擎的流场寻路表。业主口径是**默认不画、不许自动生成**，所以
  // showPaths 默认 false，这里再兜一道：表是空的就什么都不画（开着也不会有假线）。
  if (state.showPaths && rec?.groundPaths) {
    const lw = lineWorld(2);
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#e0b35788';
    for (const path of Object.values(rec.groundPaths)) {
      if (!Array.isArray(path) || path.length < 2) continue;
      ctx.beginPath();
      path.forEach(([r, c], i) => {
        const x = c * CELL + CELL / 2;
        const y = py(r) + CELL / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
  // authored ROUTES (出生点 → 防守点): drawn from the sim's own walk when the preview has it, so what you see is what
  // the enemies will do; the raw points are the fallback while the map is still invalid.
  if (state.showRoutes) {
    ctx.lineWidth = lineWorld(4);
    for (const [i, route] of (state.spec?.routes ?? []).entries()) {
      const derived = state.preview?.routePaths?.[i];
      const pts = derived && Array.isArray(derived.path) ? derived.path : [route.start, ...(route.checkpoints ?? []), route.end].filter(Array.isArray);
      if (pts.length < 2) continue;
      ctx.strokeStyle = route.motion === 'FLY' ? '#a06bffcc' : '#ff8f3fcc';
      ctx.setLineDash(derived && !derived.path ? [4, 4] : []);
      ctx.beginPath();
      pts.forEach(([r, c], k) => { const x = c * CELL + CELL / 2; const y = py(r) + CELL / 2; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // where each route starts (gate) and ends (objective)
    for (const route of state.spec?.routes ?? []) {
      for (const [p, color] of [[route.start, '#ff5a5a'], [route.end, '#3fd07a']]) {
        if (!Array.isArray(p)) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p[1] * CELL + CELL / 2, py(p[0]) + CELL / 2, marker(6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // the route being drawn right now
    if (state.draft.length) {
      ctx.strokeStyle = '#ffffffcc';
      ctx.lineWidth = lineWorld(3);
      ctx.setLineDash([5, 4]);
      if (state.draft.length > 1) {
        ctx.beginPath();
        state.draft.forEach(([r, c], k) => { const x = c * CELL + CELL / 2; const y = py(r) + CELL / 2; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffffdd';
      for (const [r, c] of state.draft) { ctx.beginPath(); ctx.arc(c * CELL + CELL / 2, py(r) + CELL / 2, marker(4), 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // devices sit on top of the terrain
  for (const d of state.spec?.devices ?? []) {
    const [r, c] = d.pos ?? [];
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    ctx.fillStyle = d.active === false ? '#77777788' : '#f0736bcc';
    ctx.fillRect(c * CELL + 8, py(r) + 8, CELL - 16, CELL - 16);
  }
  // row labels: row 0 is the BOTTOM row, as the engine stores it
  ctx.fillStyle = '#9aa3b2';
  ctx.font = `${textWorld(10)}px monospace`;
  for (let r = 0; r < ROWS; r += 3) ctx.fillText(String(r), 2 * textWorld(1), py(r) + textWorld(11));
}

/**
 * 空气（地图外）的斜纹：一条 45° 的斜纹带，盖在暗底色上。
 *
 * 为什么不是实心墙或浅灰地面：地图外要能一眼看出「这里没有地形，是可以自定义的空气区域」，
 * 实心墙会被读成一种地形、浅灰地面会被读成能站人。斜纹用 Path2D 只建一次，
 * 缩放平移由画布变换统一处理，所以任何 zoom 下纹路的密度都跟着格子走。
 */
function airStripe(c, r) {
  if (!airPattern && ctx) {
    airPattern = new Path2D();
    for (let i = -CELL; i < CELL; i += 8) {
      airPattern.moveTo(i, CELL);
      airPattern.lineTo(i + CELL, 0);
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(c * CELL, py(r), CELL, CELL);
  ctx.clip();
  ctx.strokeStyle = '#ffffff12';
  ctx.lineWidth = lineWorld(2);
  ctx.stroke(airPattern);
  ctx.restore();
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
let panning = null;                // 正在平移：{ x, y } 是上一次的指针位置
if (canvas) canvas.addEventListener('mousedown', (ev) => {
  if (!state.spec) return;
  // 平移优先于一切：中键拖，或按住空格拖（左键画不画由这一条决定，所以它必须排在工具分支前面）。
  // 左键仍然留给「画笔 / 放装置 / 画路线」—— 平移换成左键会把这一页唯一的地图编辑动作挤掉。
  if (ev.button === 1 || state.space) { ev.preventDefault(); beginPan(ev.clientX, ev.clientY); return; }
  if (ev.button !== 0) return;
  const cell = cellAt(ev);
  if (!cell) return;
  // 放装置原来只能靠工具栏切换，结果「想放一个箱子」要来回点两次工具；Shift / Ctrl 点一下就放，切回去也容易。
  const wantsDevice = state.tool === 'device' || ev.shiftKey || ev.ctrlKey;
  if (wantsDevice) {
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
if (canvas) canvas.addEventListener('mousemove', (ev) => {
  if (panning) { movePan(ev.clientX, ev.clientY); return; }
  const cell = cellAt(ev);
  // 坐标提示与 HTML 里那句静态提示是同一条词条：鼠标离开网格时回到它，换语言时也由 applyI18n 重写。
  $('#cursor').textContent = cell
    ? t('row {0}, col {1} · 字符 {2}', cell.r, cell.c, state.cells?.[cell.r]?.[cell.c] ?? '?')
    : t('把鼠标移到网格上看坐标。row 0 在最下面一行（和引擎一致）。');
  if (painting && cell && paintAt(cell)) { draw(); schedulePreview(); }
});
window.addEventListener('mouseup', () => { painting = false; endPan(); });
if (canvas) canvas.addEventListener('mouseleave', () => { painting = false; endPan(); });

// ---- 缩放与平移 ---------------------------------------------------------------------------------------------------

/** 以某个屏幕点（画布内的 CSS 像素）为锚点缩放：那个点下面的世界点不动。 */
function zoomAt(px, pyy, factor) {
  const before = viewScale();
  const nx = Math.min(8, Math.max(0.25, state.zoom * factor));
  if (nx === state.zoom) return;
  const wx = (px - state.panX) / before;
  const wy = (pyy - state.panY) / before;
  state.zoom = nx;
  const s = viewScale();
  state.panX = px - wx * s;
  state.panY = pyy - wy * s;
  clampView(); draw(); syncTools();
}
/** 缩放按钮 / 键盘：绕画布中心缩放（没有鼠标锚点时用这个）。 */
const zoomCenter = (factor) => zoomAt(state.boardW / 2, state.boardH / 2, factor);

function beginPan(x, y) {
  panning = { x, y };
  state.panning = true;
  canvas.style.cursor = 'grabbing';
}
function movePan(x, y) {
  state.panX += x - panning.x;
  state.panY += y - panning.y;
  panning.x = x;
  panning.y = y;
  clampView(); draw();
}
function endPan() {
  if (!panning) return;
  panning = null;
  state.panning = false;
  if (canvas) canvas.style.cursor = '';
}

// 滚轮 / 触控板：纵向滚轮缩放（按住 ctrl 的双指捏合也走这一支，浏览器会带 ctrlKey 一起发过来）
if (canvas) canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY > 0 ? 0.9 : 1.1);
}, { passive: false });

// 空格是「临时拿起平移手」：按下期间左键拖平移，松开就还给画笔。输入框里按空格不该被吃掉。
window.addEventListener('keydown', (ev) => {
  const tag = ev.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (!state.space) { state.space = true; if (canvas) canvas.style.cursor = 'grab'; }
    return;
  }
  // 方向键平移：没有三键鼠标的设备也能挪视野
  const step = 48;
  if (ev.key === 'ArrowLeft') { state.panX += step; clampView(); draw(); }
  else if (ev.key === 'ArrowRight') { state.panX -= step; clampView(); draw(); }
  else if (ev.key === 'ArrowUp') { state.panY += step; clampView(); draw(); }
  else if (ev.key === 'ArrowDown') { state.panY -= step; clampView(); draw(); }
});
window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space') { state.space = false; endPan(); if (canvas) canvas.style.cursor = ''; }
});

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
  // the 3D preview follows every edit too (setStage no-ops when the grid is unchanged, so this is cheap).
  // 注意别再调 toggle3d()：那会弹「正在准备…」并把视图重建一遍，改一格地形不该重新加载 3D。
  if (state.mode3d && state.view3d) state.view3d.update();
  renderSide();
}

// ---- 3D 预览 (the game's own renderer) ---------------------------------------------------------------------------

/**
 * 交给 3D 渲染器的那份「记录」。
 *
 * 优先用服务端推导回来的 `preview.record`（那是引擎真正会算的东西）；没有它的时候**用本地 spec 现拼一个最小的**
 * `{ id, rows, devices }` —— 新建一张图、还没保存、第一次推导也还没回来时，3D 就是靠它画出第一帧的。
 * 业主问的「为什么要先填上 id 才能看 3D」，根因就是这里以前只认 record，拿不到就 return。
 */
function stageFor3d() {
  const rec = state.preview?.record;
  if (rec && Array.isArray(rec.rows)) return rec;
  if (!state.cells) return null;
  return { id: state.spec?.id || 'unsaved', rows: rowsFromCells(), devices: state.spec?.devices ?? [] };
}

/**
 * 首次渲染时棋盘可能还没建完（`scene.board.bounds` 要先有一次 build），而 stage3d 的帧循环到这里就停了。
 * 这里按帧轮询把它补上：最多约 1 秒，期间棋盘建好了就自己收敛到「全图」视角，作者不用碰任何东西。
 */
let refresh3dTimer = null;
function requestRefresh3d() {
  clearTimeout(refresh3dTimer);
  let tries = 0;
  const tick = () => {
    if (!state.mode3d || !state.view3d) return;
    state.view3d.update();
    const b = state.view3d.stats?.().board3d?.bounds ?? state.view3d.scene?.()?.board?.bounds;
    if (b && b.x1 > b.x0 && b.y1 > b.y0) return;
    if (++tries >= 16) return;
    refresh3dTimer = setTimeout(tick, 60);
  };
  refresh3dTimer = setTimeout(tick, 60);
}

/**
 * Turn the 3D preview on or off. The first switch lazily probes availability; ANY failure keeps the 2D canvas and
 * states the reason rather than breaking the placer.
 *
 * 切回 2D 时把 `auto3d` 关掉：这是**作者的明确选择**，之后的自动流程（换地图、重载）不该再把它扳回 3D。
 */
async function toggle3d() {
  if (state.mode3d) {
    state.mode3d = false;
    state.auto3d = false;
    clearTimeout(refresh3dTimer);
    if (canvas) canvas.hidden = false;
    const box = $('#board3d');
    if (box) box.hidden = true;
    syncTools();
    return;
  }
  if (!state.view3d) {
    state.reason3d = t('正在准备 3D 预览…');
    renderSide();
    const board3d = $('#board3d');
    if (!board3d) { state.reason3d = t('3D 预览不可用：{0}', t('（页面上没有 3D 画布）')); syncTools(); renderSide(); return; }
    const view = await createStageView3d({
      canvas: board3d,
      // 优先服务端推导回来的 record，没有就用本地 spec 现拼一个：新建地图第一帧不能是空的
      getStage: () => stageFor3d(),
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
  if (canvas) canvas.hidden = true;
  const box3d = $('#board3d');
  if (box3d) box3d.hidden = false;
  state.view3d.resize();
  state.view3d.update();
  // 第一帧时棋盘往往还没建完（bounds 为空 → 只能给个默认框），补几次刷新让它自己收敛到全图
  requestRefresh3d();
  syncTools();
  renderSide();
}

// ---- panels ------------------------------------------------------------------------------------------------------

function renderPalette() {
  const box = $('#palette');
  box.replaceChildren();
  // 循环变量**绝不能叫 t**：它是本页的翻译函数（import { t }），叫 t 就等于把整页文案的入口挡掉了。
  for (const tile of state.data?.palette ?? []) {
    const el = document.createElement('div');
    el.className = `sw${state.brush === tile.glyph && state.tool === 'brush' ? ' on' : ''}`;
    // 空气的提示词是工整的一句（业主点名要的），其余按调色板自带的机器字段写
    el.title = isAirTile(tile.glyph, tile)
      ? t('地图外 · 空气：不可走、不可部署')
      : `${tile.tileKey} · ${tile.height} · buildable ${tile.buildable} · passable ${tile.passable}`;
    // 空气那格：虚线框 + 暗底，明确「这不是一种地形」
    el.innerHTML = isAirTile(tile.glyph, tile)
      ? `<i style="background:${tile.color};border-style:dashed"></i><span>${tile.glyph} ${t('空')}</span>`
      : `<i style="background:${tile.color}"></i><span>${tile.glyph} ${tile.label}</span>`;
    el.addEventListener('click', () => { state.brush = tile.glyph; state.tool = 'brush'; syncTools(); renderPalette(); });
    box.append(el);
  }
}

/**
 * 这张图有没有「寻路」可谈。
 *
 * 业主口径是**不许默认就有寻路**：寻路表只有点过「自动寻路」（或这份 spec 自己带着 routes）之后才算存在。
 * 所以列表与摘要里的条数只在真的有东西时显示，否则明说「未生成」，不再把派生出来的 12 对门当成默认属性摆出来。
 */
function pathsState(stage) {
  if (!stage) return { known: false, count: 0 };
  const routes = Number(stage.routes ?? 0);
  const paths = Number(stage.groundPaths ?? 0);
  return { known: routes > 0 || paths > 0, count: paths || routes };
}

/** 图例面板里一行地块的结论文案（推导在 terrain.js 的 deployRuleOf，那里是唯一的规则来源）。 */
function deployOutcome(entry, options) {
  switch (deployRuleOf(entry, options ?? optionsOf())) {
    case 'air': return t('空气：不可走、不可部署');
    case 'melee': return t('可放地面干员（近战位）');
    case 'rangedOnly': return t('只能放远程位（高台干员）');
    default: return t('不可部署');
  }
}
function deployOutcomeClass(entry) {
  const rule = deployRuleOf(entry, optionsOf());
  if (rule === 'air') return 'dim';
  if (rule === 'none') return 'warn';
  return 'ok';
}

/** spec.options 的兜底：老 map 的 spec 可能没有这个字段（默认 false —— 普通地面不放高台干员）。 */
function optionsOf() {
  return state.spec?.options && typeof state.spec.options === 'object' ? state.spec.options : {};
}

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk(t('＋ 新建地图'), 'item', () => { state.stageId = null; loadSpec(blankSpec()); renderList(); renderSide(); draw(); }));
  box.append(mk(t('以模板新建…'), 'item', () => { void toggleTemplates(true); }));
  for (const s of state.data?.stages ?? []) {
    const errs = (s.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${s.id === state.stageId ? ' on' : ''}`;
    const ps = pathsState(s);
    const pathText = ps.known ? t('寻路 {0} 条', ps.count) : t('寻路：未生成');
    el.innerHTML = `<div class="n">${s.name}${errs ? ` <span class="tag err">${errs}</span>` : ''}</div>`
      + `<div class="m">${s.pack} · ${s.id}</div>`
      + `<div class="m">${pathText} · ${t('部署 {0} 格', s.deployMelee)} · ${s.managed ? t('可编辑') : t('非编辑器管理')}</div>`;
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
    // 先把这张地图的推导结果（寻路 / 部署位）拿到手：3D 预览第一帧画的就是 state.preview.record，
    // 否则默认打开 3D 时会先看到一块空棋盘、几十毫秒后才填上；loadSpec 里排的那次也就没意义了，取消掉。
    clearTimeout(previewTimer);
    await preview();
    // 3D 预览是**默认视图**（`?board=2d` 才强制 2D）：官方棋盘贴图才让一张地图看得懂，而 stage3d.js 的探测
    // 仍然说了算 —— 没有本机素材或没有 WebGL2 时留在 2D 并写明原因。作者手动切回 2D 后 `auto3d` 为 false，这里不再动手。
    if (state.auto3d && state.board !== '2d' && !state.mode3d) await toggle3d();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

// ---- 「以模板新建」（业主：最好再塞一个样板地图） -----------------------------------------------------------------

/** 展开 / 收起「以模板新建」的清单；模板清单只拉一次（官方样板与仓库自带的样板地图都不常变）。 */
async function toggleTemplates(open) {
  state.templatePick = open !== undefined ? !!open : !state.templatePick;
  if (state.templatePick && !state.templates && !state.templatesError) {
    try {
      const r = await api('/api/stages/templates');
      state.templates = Array.isArray(r.templates) ? r.templates : [];
      state.templatesError = null;
    } catch (e) { state.templates = []; state.templatesError = e.message; }
  }
  renderSide();
}

/**
 * 用一份模板 spec 开一张新图。
 *
 * 关键在「保留新 id 语义」：模板的 id 不能直接被占用（那样会把样板本身覆盖掉），
 * 所以这里清空 id 与名字，**同时清掉 routes 与回合绑定** —— 那些是样板那张图自己的东西，
 * 带着它们新建等于「新图一出生就绑着别人的出怪表和路线」，在编辑器里看不出来、进游戏才发现打的是别人的表。
 * 三样都清掉之后，寻路表也不会跟着来（业主：不许默认新建地图就有寻路）。
 */
async function loadTemplate(id) {
  try {
    const r = await api(`/api/stages/template?id=${encodeURIComponent(id)}`);
    const spec = r.spec && typeof r.spec === 'object' ? JSON.parse(JSON.stringify(r.spec)) : blankSpec();
    spec.id = '';
    spec.name = '';
    delete spec.routes;
    delete spec.rounds;
    delete spec.bossRounds;
    state.stageId = null;
    state.templatePick = false;
    loadSpec(spec);
    state.message = { kind: 'ok', text: t('已按「{0}」载入一份新图：请填一个新的 id 与名称。', r.spec?.name || id) };
    renderList(); renderSide(); draw();
    // 载入后马上推导一次：3D 预览（默认视图）拿到的第一帧就是它
    await preview();
    if (state.auto3d && state.board !== '2d' && !state.mode3d) await toggle3d();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

/**
 * 试玩这一张图。
 *
 * 与干员页 / 包管理页同一个接口，只是多带一个 `stage`：这一局**强制**打这张图，而不是随机抽一张。
 * 出怪表还没绑的时候先就地警告（不入库也不阻塞）：不绑回合的话，试玩里敌人会按官方模板的路线走，
 * 看起来就是「怪随便乱走」—— 那句话要先说清楚，作者才知道该去哪一页。
 */
async function playtestStage(btn) {
  if (state.playtesting) return;
  if (!state.spec?.id) { state.message = { kind: 'error', text: t('先填一个 id（并保存一次）才能试玩这张图。') }; renderSide(); return; }
  const bound = (state.spec.rounds && Object.keys(state.spec.rounds).length) || (state.spec.bossRounds && Object.keys(state.spec.bossRounds).length);
  if (!bound) {
    state.message = { kind: 'error', text: t('这张图还没有绑定出怪表：试玩里敌人会按官方模板的路线走，看起来会乱走。建议在出怪页建一张表并把它绑到回合上。') };
    renderSide();
  }
  state.playtesting = true;
  const label = btn?.textContent;
  if (btn) btn.textContent = t('正在起…');
  try {
    const r = await api('/api/playtest/start', { method: 'POST', body: { stage: state.spec.id } });
    if (!state.message || state.message.kind !== 'error') state.message = { kind: 'ok', text: t('试玩服务器已就绪（新标签页已打开）：{0}', r.url) };
    if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(r.url, '_blank', 'noopener');
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.playtesting = false; if (btn && label) btn.textContent = label; renderSide(); }
}

/**
 * 「自动寻路」——**唯一**会生成寻路表的地方。
 *
 * 业主口径：绝不自动生成；只有点这一下才算。服务端按「本图的每个 S → 最近的 E」配对求路
 * （没有 S/E 就回落到官方那 12 对门），返回的 routes 追加进这张图的路线里；已经有同 start/end 的不重复加。
 */
async function autoroute() {
  if (!state.spec || state.autorouting) return;
  state.autorouting = true;
  syncTools();
  try {
    const r = await api('/api/stages/autoroute', { method: 'POST', body: { spec: currentSpec() } });
    const routes = Array.isArray(r.routes) ? r.routes : [];
    if (!Array.isArray(state.spec.routes)) state.spec.routes = [];
    const key = (x) => `${x.motion}|${(x.start ?? []).join(',')}|${(x.end ?? []).join(',')}`;
    const seen = new Set(state.spec.routes.map(key));
    let added = 0;
    for (const route of routes) if (!seen.has(key(route))) { seen.add(key(route)); state.spec.routes.push(route); added++; }
    state.showPaths = added > 0 || state.spec.routes.length > 0;
    // 服务端求不出路时返回 ok:false + reason（HTTP 仍是 200）：那句话正是作者要照着做的下一步，
    // 所以要原样显示出来，而不是回一句「没有新的路线可加」把原因吞掉。
    if (!r.ok && !added) state.message = { kind: 'error', text: t('自动寻路失败：{0}', r.reason || t('这张图没有可配对的入口与保护目标')) };
    else if (added) state.message = { kind: 'ok', text: t('自动寻路：新增 {0} 条路线（共 {1} 条）。', added, state.spec.routes.length) };
    else state.message = { kind: 'ok', text: t('自动寻路：没有新的路线可加（这张图上同起终点的已经有了）。') };
    // 立刻推导一次并重画：路线是引擎真走的东西，作者要马上看到它落在哪
    clearTimeout(previewTimer);
    await preview();
  } catch (e) {
    state.message = { kind: 'error', text: t('自动寻路失败：{0}', e.message) };
  } finally {
    state.autorouting = false;
    syncTools(); renderSide();
  }
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
  if (!spec) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = t('左边选一张地图，或点「新建地图」。'); box.append(p); return; }

  const h = (text) => { const e = document.createElement('h2'); e.textContent = text; return e; };
  const field = (label, input) => { const d = document.createElement('div'); const l = document.createElement('label'); l.textContent = label; d.append(l, input); return d; };
  const text = (get, set, attrs = {}) => { const i = document.createElement('input'); i.value = get() ?? ''; Object.assign(i, attrs); i.addEventListener('input', () => { set(i.value); schedulePreview(); }); return i; };
  const num = (get, set) => { const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.value = get() ?? 0; i.addEventListener('input', () => { set(Number(i.value)); schedulePreview(); }); return i; };

  // ---- 「以模板新建」的选择器（业主：最好再塞一个样板地图） ----------------------------------------------
  //
  // 放在右栏最上面：它是一条「以另一张图为底」的入口，与下面的具体字段是两回事；
  // 列表只在点开时才拉（GET /api/stages/templates），服务端还没合并这个接口时就在原地说明失败原因。
  if (state.templatePick) {
    box.append(h(t('以模板新建')));
    const pick = document.createElement('div'); pick.className = 'panel';
    const head = document.createElement('div'); head.className = 'row';
    head.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: t('点一个模板就以它为底开一张新图（模板的 id 与名字不会被占用）。') }));
    const close = document.createElement('button'); close.className = 'ghost'; close.textContent = t('收起');
    close.addEventListener('click', () => { void toggleTemplates(false); });
    head.append(close);
    pick.append(head);
    if (state.templatesError) {
      pick.append(Object.assign(document.createElement('div'), { className: 'err', textContent: t('拉取模板清单失败：{0}', state.templatesError) }));
    } else if (!state.templates) {
      pick.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('正在载入模板…') }));
    } else if (!state.templates.length) {
      pick.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（这台机器上没有可用的模板）') }));
    }
    for (const tpl of state.templates ?? []) {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `<div class="n">${tpl.name || tpl.id}</div>`
        + `<div class="m">${[tpl.id, tpl.kind, tpl.note].filter(Boolean).join(' · ')}</div>`;
      el.addEventListener('click', () => { void loadTemplate(tpl.id); });
      pick.append(el);
    }
    box.append(pick);
  }

  box.append(h(t('地图')));
  const identity = document.createElement('div'); identity.className = 'panel';
  identity.append(
    field(t('id（slug）'), text(() => spec.id, (v) => { spec.id = v; })),
    field(t('名称'), text(() => spec.name, (v) => { spec.name = v; })),
    field(t('权重 weight'), num(() => spec.weight, (v) => { spec.weight = v; })),
  );
  box.append(identity);

  // ---- 地图种类（业主口径：初始化的地图就是单人视角，联防是另一个项目，不是同一张图的一个开关） -------------
  box.append(h(t('地图种类')));
  const kindBox = document.createElement('div'); kindBox.className = 'panel';
  const kindSel = document.createElement('select');
  // 单人 = **不写这两个键**（官方地图本来就没有），所以「单人」在选项里是空值而不是 'single'
  const KIND_CHOICES = [
    { value: '', label: t('单人（默认）') },
    { value: 'unite1', label: t('联防（1 人）') },
    { value: 'unite2', label: t('联防（2 人）') },
  ];
  for (const c of KIND_CHOICES) { const o = document.createElement('option'); o.value = c.value; o.textContent = c.label; kindSel.append(o); }
  kindSel.value = spec.kind === 'unite' ? `unite${Number(spec.helpers) === 2 ? 2 : 1}` : '';
  kindSel.addEventListener('change', () => {
    if (kindSel.value === '') { delete spec.kind; delete spec.helpers; }
    else { spec.kind = 'unite'; spec.helpers = kindSel.value === 'unite2' ? 2 : 1; }
    schedulePreview(); renderSide();
  });
  kindBox.append(field(t('这张图算什么地图'), kindSel));
  kindBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    // 首领战不是地图种类而是「回合」面板里给某回合绑首领 wave —— 这句话要写在页面上，不是只写在注释里
    textContent: t('首领战（boss）不是地图种类：在下面的「回合绑定」里给某一回合绑上首领出怪表，那一回合就是首领战。'),
  }));
  box.append(kindBox);

  box.append(h(t('可选中的模式（必须至少选一个）')));
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
  if (!(state.data?.modes ?? []).length) modesBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（没有可选模式）') }));
  box.append(modesBox);

  // ---- 地块图例 / 部署规则（业主口径：道路与部署位要合理，且必须让作者自己定） ------------------------------
  //
  // 这里列的是**调色板里每一个字符**，不是这张图已经用到的那些：作者要能在铺地形之前就把规则调好，
  // 每个下拉改的都是 state.spec.tiles[char]（保存进 spec 的图例），改完立刻 schedulePreview() 让引擎重算部署区。
  const details = document.createElement('details'); details.className = 'fold';
  const sum = document.createElement('summary'); sum.textContent = t('地块图例 / 部署规则');
  details.append(sum);
  const tilesBox = document.createElement('div'); tilesBox.className = 'panel'; tilesBox.style.margin = '8px 0 0';
  tilesBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('这里改的是这张图的图例：高度 / 可部署 / 通行三个字段直接决定引擎算出来的部署区。'),
  }));
  const legends = { ...(spec.tiles ?? {}) };
  const listGlyphs = [...(state.data?.palette ?? []).map((x) => x.glyph)];
  for (const g of Object.keys(legends)) if (!listGlyphs.includes(g)) listGlyphs.push(g);
  const ruleField = (labelText, value, values, onPick) => {
    const d = document.createElement('div'); d.className = 'lrow';
    const l = document.createElement('span'); l.textContent = labelText;
    const s = document.createElement('select');
    for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = v; s.append(o); }
    s.value = value;
    s.addEventListener('change', () => { onPick(s.value); schedulePreview(); renderSide(); });
    d.append(l, s);
    return d;
  };
  const legendRow = (glyph, entry) => {
    const row = document.createElement('div'); row.className = 'legend';
    const pal = (state.data?.palette ?? []).find((x) => x.glyph === glyph);
    const air = isAirTile(glyph, entry);
    const badge = document.createElement('div'); badge.className = `lg${air ? ' air' : ''}`;
    badge.textContent = glyph;
    badge.title = air ? t('地图外 · 空气：不可走、不可部署') : (pal?.label ?? glyph);
    const body = document.createElement('div');
    const key = document.createElement('div'); key.className = 'key';
    key.textContent = `${entry.tileKey ?? t('（没有 tileKey）')} · ${t('字符 {0}', glyph)}`;
    body.append(key);
    body.append(ruleField(t('高度'), entry.height, ['LOW', 'HIGH'], (v) => { entry.height = v; }));
    body.append(ruleField(t('可部署'), entry.buildable, ['ALL', 'MELEE', 'RANGED', 'NONE'], (v) => { entry.buildable = v; }));
    body.append(ruleField(t('通行'), entry.passable ?? 'ALL', ['ALL', 'FLY', 'FLY_ONLY', 'NONE'], (v) => {
      entry.passable = v;
      // groundPassable / flyPassable 是派生出来给引擎看的那两个布尔，必须跟着 passable 一起改 ——
      // 只改 passable 会在保存时留下互相矛盾的记录（图例说能走、派生字段说不能）。
      entry.groundPassable = v === 'ALL';
      entry.flyPassable = v !== 'NONE';
    }));
    row.append(badge, body);
    // 结论：从三个字段推出来的「能不能站人」，也是作者真正关心的那一句
    const verdict = document.createElement('div'); verdict.className = `concl ${deployOutcomeClass(entry)}`;
    verdict.textContent = deployOutcome(entry, spec.options);
    row.append(verdict);
    return row;
  };
  for (const g of listGlyphs) {
    if (!legends[g]) continue;
    tilesBox.append(legendRow(g, legends[g]));
  }
  details.append(tilesBox);
  box.append(details);

  // ---- 地面能不能放高台：默认 false（业主口径里最容易被误解的一条） ----------------------------------------
  box.append(h(t('部署规则')));
  const ruleBox = document.createElement('div'); ruleBox.className = 'panel';
  const ground = document.createElement('label');
  ground.style.color = 'var(--fg)';
  ground.style.display = 'flex'; ground.style.gap = '6px'; ground.style.alignItems = 'center';
  const groundCb = document.createElement('input');
  groundCb.type = 'checkbox'; groundCb.style.width = 'auto';
  groundCb.checked = spec.options?.groundHighGround === true;
  groundCb.addEventListener('change', () => {
    spec.options = { ...(spec.options ?? {}), groundHighGround: groundCb.checked };
    schedulePreview(); renderSide();
  });
  ground.append(groundCb, document.createTextNode(t('地面也能放远程位（高台干员）')));
  ruleBox.append(ground);
  const groundHint = document.createElement('p'); groundHint.className = 'hint';
  groundHint.textContent = spec.options?.groundHighGround === true
    ? t('已勾上：普通地面也接受远程位（高台干员），近战位不变。')
    : t('默认不勾：只有道路放地面干员、高台放远程位；普通地面不接受高台干员。这个开关是这张图自己的。');
  ruleBox.append(groundHint);
  box.append(ruleBox);

  // ---- 回合绑定：把出怪表绑到这张图的回合上（引擎真正读的那份） --------------------------------------------
  box.append(h(t('回合绑定（这张图自己的出怪表）')));
  const roundsBox = document.createElement('div'); roundsBox.className = 'panel';
  const bind = state.data?.roundBind;
  roundsBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('不指定就用模式的默认出怪表。引擎先看这张图、再看模式的模板，所以这里绑过的回合会走你自己的表。'),
  }));
  const rows = roundRows(spec, bind);
  const options = waveOptions(bind);
  if (!rows.length) {
    roundsBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（服务端没有给出回合表）') }));
  }
  const waveSelect = (current, onPick, emptyLabel) => {
    const s = document.createElement('select');
    const none = document.createElement('option'); none.value = ''; none.textContent = emptyLabel; s.append(none);
    // 绑了一个不存在的 id 时，把它作为一个带警告的选项摆出来 —— 直接消失会让作者以为自己没绑过
    if (current && !options.some((o) => o.id === current)) {
      const stale = document.createElement('option'); stale.value = current; stale.textContent = t('{0}（这张表不存在）', current); s.append(stale);
    }
    for (const o of options) { const el = document.createElement('option'); el.value = o.id; el.textContent = o.label; s.append(el); }
    s.value = current ?? '';
    s.addEventListener('change', () => { onPick(s.value); schedulePreview(); renderSide(); });
    return s;
  };
  for (const row of rows) {
    const line = document.createElement('div');
    line.style.marginBottom = '8px';
    const title = document.createElement('div');
    title.className = 'hint';
    const defaults = row.defaults.map((d) => d.template ?? t('首领模板')).join(' / ');
    title.textContent = `${t('第 {0} 回合', row.round)} · ${t('默认 {0}', defaults)}${row.isBoss ? ` · ${t('首领回合')}` : ''}`;
    line.append(title);
    line.append(waveSelect(row.bound, (v) => { spec.rounds = setRoundBinding(spec.rounds, row.round, v); }, t('（用模式的模板）')));
    if (row.isBoss) {
      const sub = document.createElement('div');
      sub.className = 'hint';
      sub.textContent = t('首领回合的出怪表（该模式的首领都会用它）');
      line.append(sub);
      line.append(waveSelect(row.bossBound, (v) => { spec.bossRounds = setBossRoundBinding(spec.bossRounds, row.round, v, row.bossKeys); }, t('（用模式的首领模板）')));
    }
    roundsBox.append(line);
  }
  const missing = missingBindings(spec, bind);
  if (missing.length) {
    const bad = document.createElement('div');
    bad.className = 'err';
    bad.textContent = t('这些绑定的出怪表不存在，引擎会静默回落到模式的模板：{0}', missing.map((m) => `${t('第 {0} 回合', m.round)} → ${m.id}`).join('、'));
    roundsBox.append(bad);
  }
  box.append(roundsBox);

  box.append(h(t('装置')));
  const devBox = document.createElement('div'); devBox.className = 'panel';
  if (spec.devices.length) {
    spec.devices.forEach((d, i) => {
      const row = document.createElement('div'); row.className = 'dev';
      const label = document.createElement('span'); label.textContent = `${d.role ?? '?'} @ [${(d.pos ?? []).join(', ')}]`;
      const hidden = document.createElement('button'); hidden.className = 'ghost'; hidden.textContent = d.active === false ? t('隐藏') : t('激活');
      hidden.title = t('隐藏的装置在对局开始时不存在（由效果打开）');
      hidden.addEventListener('click', () => { d.active = d.active === false; schedulePreview(); });
      const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
      del.addEventListener('click', () => { spec.devices.splice(i, 1); schedulePreview(); });
      row.append(label, hidden, del);
      devBox.append(row);
    });
  } else devBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（还没有装置）') }));
  const roleSel = document.createElement('select');
  for (const r of ['crate', 'platform', 'mound', 'blower', 'mireController', 'turret']) {
    const o = document.createElement('option'); o.value = r; o.textContent = r; roleSel.append(o);
  }
  roleSel.value = state.deviceRole;
  roleSel.addEventListener('change', () => { state.deviceRole = roleSel.value; state.tool = 'device'; syncTools(); });
  devBox.append(field(t('要摆放的装置类型'), roleSel));
  devBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('选「放装置」工具后点网格放置。') }));
  box.append(devBox);

  box.append(h(t('路线（出生点 → 防守点）')));
  const routeBox = document.createElement('div'); routeBox.className = 'panel';
  const draftInfo = document.createElement('p'); draftInfo.className = 'hint';
  draftInfo.textContent = state.draft.length
    ? t('正在画：{0} 个点，起点 {1}。继续点网格加检查点，然后按「完成路线」。', state.draft.length, state.draft[0].join(','))
    : t('选「画路线」工具后依次点击：第一下是起点（城门 S），中间是检查点，最后按「完成路线」收尾。WALK 走地面寻路，FLY 直线飞。');
  routeBox.append(draftInfo);
  const motionSel = document.createElement('select');
  for (const m of ['WALK', 'FLY']) {
    const o = document.createElement('option'); o.value = m;
    o.textContent = m === 'WALK' ? t('WALK（地面，按寻路走）') : t('FLY（飞行，直线）');
    motionSel.append(o);
  }
  motionSel.value = state.routeMotion;
  motionSel.addEventListener('change', () => { state.routeMotion = motionSel.value; });
  routeBox.append(field(t('新路线的运动方式'), motionSel));
  const rrow = document.createElement('div'); rrow.className = 'row';
  const finish = document.createElement('button'); finish.className = 'primary'; finish.textContent = t('完成路线');
  finish.disabled = state.draft.length < 2;
  finish.addEventListener('click', () => {
    const d = state.draft;
    state.spec.routes.push({ motion: state.routeMotion, start: d[0], end: d[d.length - 1], checkpoints: d.slice(1, -1) });
    state.draft = [];
    schedulePreview(true);
  });
  const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = t('取消当前路线');
  cancel.disabled = !state.draft.length;
  cancel.addEventListener('click', () => { state.draft = []; draw(); renderSide(); });
  rrow.append(finish, cancel);
  routeBox.append(rrow);
  if (!(state.spec.routes ?? []).length) {
    routeBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（还没有路线：这张图上的敌人目前没有从出生点到防守点的走法）') }));
  }
  (state.spec.routes ?? []).forEach((route, i) => {
    const row = document.createElement('div'); row.className = 'dev';
    const label = document.createElement('span');
    const rp = state.preview?.routePaths?.[i];
    const bad = rp && !rp.path;
    label.textContent = `${route.motion} ${(route.start ?? []).join(',')} → ${(route.end ?? []).join(',')}${(route.checkpoints ?? []).length ? ` (+${route.checkpoints.length})` : ''}${bad ? ` ⚠ ${t('无路可走')}` : ''}`;
    if (bad) label.className = 'err';
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    del.addEventListener('click', () => { state.spec.routes.splice(i, 1); schedulePreview(true); });
    row.append(label, document.createElement('span'), del);
    routeBox.append(row);
  });
  routeBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('路线存在工坊包的 spec 里（引擎的 routes 属于出怪表，由下一步的出怪编辑器绑定到回合）。'),
  }));
  box.append(routeBox);

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? t('保存中…') : t('保存并推导');
  save.disabled = state.busy || !spec.id;
  save.addEventListener('click', saveStage);
  actions.append(save);
  // 试玩这张图：与干员页同一个接口，但带上 stage —— 这一局强制打这张图（业主的「需要加一个试玩地图功能」）
  const play = document.createElement('button');
  play.textContent = state.playtesting ? t('正在起…') : t('▶ 试玩这张图');
  play.disabled = state.playtesting;
  play.addEventListener('click', () => { void playtestStage(play); });
  actions.append(play);
  if (state.stageId) {
    const del = document.createElement('button'); del.textContent = t('删除该地图');
    del.addEventListener('click', deleteStage);
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
    newDefault: 'my-map-pack',
    onPick: (id) => { state.packId = id; renderSide(); },
  }));
  box.append(packBox);
  if (!spec.id) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('先填一个 id 才能保存。') }));

  box.append(h(t('校验与推导结果')));
  const pv = document.createElement('div'); pv.className = 'panel';
  const rec = state.preview?.record;
  if (!state.preview) pv.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('（改动后会自动推导）') }));
  else {
    if (rec) {
      const info = document.createElement('p');
      info.className = 'hint';
      // 「寻路 N 条」只在真的有寻路时显示（业主：不许默认就有寻路）。
      // 而 routes 非空时那份派生表其实是服务端算得出来的，所以也照实显示条数 —— 但绝不在空图上摆一个数字。
      const ps = pathsState({ routes: spec.routes?.length ?? 0, groundPaths: Object.keys(rec.groundPaths ?? {}).length });
      const pathPart = ps.known ? t('寻路 {0} 条（含装置 {1} 条）', ps.count, Object.keys(rec.groundPathsWithDevices ?? {}).length) : t('寻路：未生成');
      info.textContent = `${pathPart} · ${t('部署 {0} 近战 / {1} 远程', rec.deployTiles.normal.melee.length, rec.deployTiles.normal.rangedOnly.length)}`;
      pv.append(info);
    }
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
  // 缩放百分比：zoom 是相对 fit-to-view 的倍数，所以 100% 就等于「整张图正好在视野里」
  const pct = $('#zoomPct');
  if (pct) pct.textContent = `${Math.round(state.zoom * 100)}%`;
  const auto = $('#btnAutoRoute');
  if (auto) {
    auto.disabled = state.autorouting || !state.spec;
    auto.className = state.autorouting ? 'on' : '';
    // 提示语在这里设而不是写成 HTML 静态属性：换语言时 mountI18n 只会重写 data-i18n 那三种标记，
    // 由 JS 设的 title 得跟着 syncTools() 一起换 —— 否则英文界面下这两个按钮的提示还是中文。
    auto.title = t('业主口径：绝不自动生成；只有点这一下才算。按本图的 S（出生点）配最近的 E（防守点）求一条寻路，追加进路线里');
  }
  const fit = $('#viewFit');
  if (fit) fit.title = t('把整张 19×21 缩放回视野里（最少留 8px 边距）');
  const b3 = $('#ov3d');
  if (b3) {
    b3.className = state.mode3d ? 'on' : '';
    b3.textContent = state.mode3d ? t('3D 预览（点回 2D）') : t('3D 预览');
  }
  const hint = $('#hint3d');
  if (hint) {
    hint.textContent = state.reason3d ?? (state.mode3d
      ? t('左键拖动调俯角 · 滚轮缩放 · 按住空格拖（或中键拖）平移。这一层是游戏自己的 3D 渲染器跑你这张地图。')
      : '');
    hint.className = state.reason3d ? 'hint warn' : 'hint';
  }
  // View presets for the 3D preview. The button set is built from the view itself (`presets()`), so it can never list a
  // framing the view does not implement. Deliberately no "active" highlight: once the author drags or zooms, the framing
  // is no longer the preset, and marking one would be a lie.
  const row = $('#presets3d');
  if (row) {
    const view = state.mode3d ? state.view3d : null;
    row.hidden = !view;
    row.replaceChildren();
    for (const p of view ? view.presets() : []) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = p.label;
      b.addEventListener('click', () => view.preset(p.id));
      row.append(b);
    }
  }
}

async function saveStage() {
  if (!state.packId) {
    state.message = { kind: 'error', text: t('先在右边选一个工坊包（或点「＋ 新建一个包…」）。') };
    renderSide();
    return;
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/stages`, { method: 'POST', body: { spec: currentSpec() } });
    state.stageId = r.id;
    state.message = { kind: 'ok', text: t('已保存 {0}，生成 {1}。重启游戏服务器后生效。', r.id, r.generated.join(', ')) };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteStage() {
  if (!state.stageId || !confirm(t('删除地图 {0}？', state.stageId))) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/stages/${encodeURIComponent(state.stageId)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: t('已删除 {0}', state.stageId) };
    state.stageId = null; state.spec = null; state.cells = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

async function load() {
  state.data = await api('/api/stages');
  renderRootPath();
  if (!state.packId) state.packId = state.data.stages[0]?.pack ?? null;
  renderList();
  renderPalette();
  renderSide();
  draw();
}

// ---- 画布的尺寸与视图 ---------------------------------------------------------------------------------------------

/**
 * 画布尺寸变了（窗口缩放 / 侧栏折起来 / 第一次布局）就重新取景。
 * 只在**作者还没自己缩放过**（zoom 仍是 1）时重新居中：他手动缩放平移之后再去动他的视野就是抢方向盘。
 */
let viewResizeTimer = null;
function handleViewportResize() {
  clearTimeout(viewResizeTimer);
  viewResizeTimer = setTimeout(() => {
    const before = { w: state.boardW, h: state.boardH };
    resizeBoard();
    const sizeChanged = state.boardW !== before.w || state.boardH !== before.h;
    // 第一次量到尺寸（before 全是 0）也必须居中，否则整张图会挤在左上角 —— 那正是业主看到的那个问题
    if (state.zoom === 1 && (sizeChanged || !before.w || !before.h)) centerView();
    draw();
    // 3D 那边有自己的 ResizeObserver，这里只需要它把新尺寸读进去
    state.view3d?.onResize?.();
  }, 60);
}
if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('resize', handleViewportResize);
if (typeof ResizeObserver === 'function' && canvas?.parentElement) {
  new ResizeObserver(() => handleViewportResize()).observe(canvas.parentElement);
}

// ---- 语言 --------------------------------------------------------------------------------------------------------

/** 左栏顶部的「N 张工坊地图」。地图列表还没到（首屏 load 之前）时不动它，免得闪一句错的。 */
function renderRootPath() {
  if (!state.data) return;
  $('#rootPath').textContent = state.data.stages.length ? t('{0} 张工坊地图', state.data.stages.length) : t('还没有工坊地图');
}

/** 换语言后重画由 JS 生成的那些文案（HTML 里的静态文案由 mountI18n 自己换）。 */
function renderAll() {
  renderList();
  renderPalette();
  renderRootPath();
  syncTools();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.stageId = null; state.message = null; loadSpec(blankSpec()); renderList(); renderSide(); draw(); });
$('#toolBrush').addEventListener('click', () => { state.tool = 'brush'; syncTools(); renderPalette(); });
$('#toolDevice').addEventListener('click', () => { state.tool = 'device'; syncTools(); });
$('#toolErase').addEventListener('click', () => { state.tool = 'erase'; syncTools(); });
$('#toolRoute').addEventListener('click', () => { state.tool = 'route'; syncTools(); renderSide(); });
$('#ovRoutes').addEventListener('click', () => { state.showRoutes = !state.showRoutes; syncTools(); draw(); });
$('#ov3d').addEventListener('click', () => { void toggle3d(); });
$('#ovDeploy').addEventListener('click', () => { state.showDeploy = !state.showDeploy; syncTools(); draw(); });
$('#ovPaths').addEventListener('click', () => { state.showPaths = !state.showPaths; syncTools(); draw(); });
// 视图工具条：「适应」= 复位 fit-to-view，± 绕画布中心缩放（百分比在 syncTools 里跟）
$('#viewFit')?.addEventListener('click', () => { resetView(); draw(); syncTools(); });
$('#viewIn')?.addEventListener('click', () => zoomCenter(1.25));
$('#viewOut')?.addEventListener('click', () => zoomCenter(0.8));
// 「自动寻路」：唯一会生成寻路表的地方（业主口径写在 autoroute() 的注释里）
$('#btnAutoRoute')?.addEventListener('click', () => { void autoroute(); });

// 第一次布局：画布还是 0×0（高度由 .stage-view 的 flex 决定），所以先量一次再取景。
resizeBoard();
if (!state.boardW) centerView();
syncTools();
// 界面语言：换掉 HTML 里的静态文案、插入右上角语言按钮，换语言后连 JS 生成的那些文案一起重画。
mountI18n(renderAll);
load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: t('载入失败：{0}', e.message) })); });
