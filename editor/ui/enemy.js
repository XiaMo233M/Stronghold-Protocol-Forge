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
// 记录键的推导只有一份（`enemy_ws_<slug>`，shared/enemyAuthoring.js 的 enemyKey）：外观声明的 id 必须与它一致，
// 否则客户端按记录键查 `assets.enemies` 时查不到这套素材。
import { enemyKey } from '../../shared/enemyAuthoring.js';

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
  // 本包自带的外观素材那一块：草稿、它的目标 key、上一次保存/删除的回话，以及现场问来的骨架/图谱解析结论
  artDraft: null, artDraftKey: '', artMessage: null, artParsed: null,
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

// ---- 本包自带的外观素材（pack.json 的 art）------------------------------------------------------------------------
//
// 第四条素材通道（前三条：语音、盟约图标、装备图标）：包自带的图标/模型由叠加层并进合并后的 `data/assets.json`，
// 客户端零改动。与干员页那块是同一套，只有两处不同：表是 `enemies`（id 就是怪物的记录键 `enemy_ws_<id>`），
// 而 spine 是**扁平**的（直接挂在条目上，没有 front/back 两层）。为什么正文是**整条条目**、以及保存前服务端会逐条
// 查的三条硬约束（`.atlas` 必须与 `.skel` 同目录同名、图谱里每一页 png 必须与它同目录且存在、`.skel` 只收 3.8.x
// 且 `anims` 的动画名必须真在骨架里），见 editor/ui/app.js 里同一段的注释。

/** 外观角色名：就是 `assets.json` 的 `anims` 里那几个键（客户端 render/spine.js 逐个读），不要自己发明。 */
const ART_ROLES = ['idle', 'deploy', 'attack', 'attackDown', 'skill', 'die', 'move', 'stun'];
/** 其中哪几个是「剪辑」（`{ begin, loop, end }`）；其余的是一个名字（idle / deploy / die）。 */
const ART_CLIP_ROLES = ['attack', 'attackDown', 'skill', 'move', 'stun'];
const isRec = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** 包内相对路径的目录 / 拼接（清单里的路径一律是 `/` 分隔的 POSIX 相对路径）。 */
const relDirOf = (p) => { const s = String(p ?? ''); const i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); };
const relJoin = (dir, name) => (dir ? `${dir}/${name}` : name);

/** 本包的外观状态：art 原文 + assets/ 里真的有的文件 + 每条已声明 spine 的解析结论。 */
const packArtState = () => (state.data?.packArt ?? []).find((p) => p.id === state.packId)
  ?? { id: state.packId, art: {}, files: [], skels: {}, atlases: {} };

/** 现场解析结果的缓存（刚挑好、还没写进 pack.json 的文件得问一次服务端）；换包就整份丢掉（键是包内相对路径）。 */
function artParsedStore() {
  if (state.artParsed?.packId !== state.packId) state.artParsed = { packId: state.packId, skels: {}, atlases: {} };
  return state.artParsed;
}
const skelParse = (rel) => (rel ? (artParsedStore().skels[rel] ?? packArtState().skels?.[rel] ?? null) : null);
const atlasParse = (rel) => (rel ? (artParsedStore().atlases[rel] ?? packArtState().atlases?.[rel] ?? null) : null);
/** 重画表单（怪物页的重画约定：见 editor/ui/focusKeep.js）。 */
const redrawForm = () => renderKeepingFocus($('#form'), renderForm);

/**
 * id 变了就把表单重画一次（防抖）。这一页平时只重画右栏，而「本包自带的外观素材」那一段是按**记录键**
 * `enemy_ws_<id>` 渲染的 —— 不重画的话，作者敲完 id 会看到那句「先填 id」一直留在原地。
 * 用 renderKeepingFocus，所以光标与选区留在原处（与干员页每次校验重画同一条路）。
 */
let formRedrawTimer = null;
function scheduleFormRedraw() { clearTimeout(formRedrawTimer); formRedrawTimer = setTimeout(redrawForm, 250); }

/** 问一次服务端：这个 `.skel` / `.atlas` 里有什么（候选要真的来自骨架与图谱，不然作者只能猜）。 */
async function askArtParse(rel, kind) {
  const known = kind === 'skel' ? skelParse(rel) : atlasParse(rel);
  if (!rel || !state.packId || known) return;
  try {
    const q = kind === 'skel' ? `skel=${encodeURIComponent(rel)}` : `atlas=${encodeURIComponent(rel)}`;
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/art/inspect?${q}`);
    if (kind === 'skel' && r.skel) artParsedStore().skels[rel] = r.skel;
    if (kind === 'atlas' && r.atlas) artParsedStore().atlases[rel] = r.atlas;
  } catch { /* 问不到就不给候选：手输那条路还在，保存时服务端仍会核对 */ }
}

/** 一条外观条目里的全部 spine 对象（怪物是扁平的 `spine`，干员是 front/back 两层）。 */
function artSpineObjectsUi(entry) {
  const spine = isRec(entry) ? entry.spine : null;
  if (!isRec(spine)) return [];
  if (typeof spine.skel === 'string') return [spine];
  return Object.values(spine).filter(isRec);
}

/** 正编辑的那一条外观（草稿）：表单每次重画都要能拿回同一份，换目标时才从 pack.json 重新起一份。 */
function artDraftFor(table, id) {
  const key = `${table}.${id}`;
  if (state.artDraftKey !== key) {
    const prev = state.artDraftKey;
    state.artDraftKey = key;
    const declared = packArtState().art?.[table]?.[id];
    state.artDraft = isRec(declared) ? JSON.parse(JSON.stringify(declared)) : {};
    if (prev) state.artMessage = null;
  }
  return state.artDraft;
}

/**
 * 「只列本包真的有的文件」的下拉；当前值不在清单里也留着并标出来（不静默改掉草稿）。
 * `extraClass` 是给测试/样式用的一个稳定的钩子（DOM 结构会变，这个类不会）。
 */
function artFileSelect(files, get, set, emptyLabel, extraClass = '') {
  const cur = String(get() ?? '');
  const sel = document.createElement('select');
  if (extraClass) sel.className = extraClass;
  const add = (value, text, on) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; o.selected = on;
    sel.append(o);
  };
  add('', emptyLabel, !cur);
  for (const f of (!cur || files.includes(cur) ? files : [cur, ...files])) {
    add(f, files.includes(f) ? f : t('{0}（本包没有这个文件）', f), f === cur);
  }
  sel.addEventListener('change', () => { set(sel.value); redrawForm(); });
  return sel;
}

/** 动画名下拉：候选只来自服务端从**这个骨架**里解析出的名字；解析不到时退回可手输 + 提示。 */
function artAnimInput(names, get, set, emptyLabel) {
  const cur = String(get() ?? '');
  if (!names.length) {
    const box = document.createElement('div');
    const i = document.createElement('input');
    i.value = cur;
    i.placeholder = t('骨架没解析出来，可以手填动画名');
    i.addEventListener('input', () => set(i.value));
    box.append(i, Object.assign(document.createElement('div'), {
      className: 'hint warn',
      textContent: t('这个骨架的动画名没解析出来（文件不在、太大或不是 3.8 骨架）：手填的名字保存时服务端仍会去骨架里核对。'),
    }));
    return box;
  }
  const sel = document.createElement('select');
  const add = (value, text, on) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; o.selected = on;
    sel.append(o);
  };
  add('', emptyLabel, !cur);
  for (const n of (!cur || names.includes(cur) ? names : [cur, ...names])) {
    add(n, names.includes(n) ? n : t('{0}（骨架里没有这个名字）', n), n === cur);
  }
  sel.addEventListener('change', () => { set(sel.value); redrawForm(); });
  return sel;
}

/** 显示用：一条声明引用到的字符串（图片/图标字段、spine 的 skel/atlas/textures，以及原样抄过去的 id）。 */
function artEntryStrings(entry) {
  const out = [];
  if (!isRec(entry)) return out;
  for (const [k, v] of Object.entries(entry)) if (k !== 'spine' && typeof v === 'string') out.push(`${k}=${v}`);
  for (const spine of artSpineObjectsUi(entry)) {
    if (typeof spine.skel === 'string') out.push(spine.skel);
    if (typeof spine.atlas === 'string') out.push(spine.atlas);
    if (Array.isArray(spine.textures)) out.push(...spine.textures.filter((x) => typeof x === 'string'));
  }
  return out;
}

/**
 * 「本包已声明的外观」：`pack.json.art` 里的**全部**声明（包括这只怪物用不到的、陈旧的），每条都能删 ——
 * 任何写进 pack.json 的东西都必须能在这里删掉，包括一条**会被加载器拒绝**的陈年声明。
 */
function artDeclaredList() {
  const box = document.createElement('div'); box.className = 'panel artDeclared';
  const title = document.createElement('h2'); title.textContent = t('本包已声明的外观');
  box.append(title);
  const rows = [];
  const art = packArtState().art;
  if (art !== undefined && !isRec(art)) {
    // `art` 整个不是一个对象（加载器会拒绝的形状）：也要有一个能去掉它的入口。清任何一条都会把这份坏值整个丢掉，
    // 所以这里借本页自己的表名发一次删除（服务端那条路只认「删」这个意图，不看 id 存不存在）。
    rows.push({ table: 'enemies', id: 'x', label: t('art（不是一个对象）'), refs: [JSON.stringify(art)] });
  } else {
    for (const [table, entries] of Object.entries(art ?? {})) {
      if (!isRec(entries)) { rows.push({ table, id: null, label: t('{0}（不是一个对象）', table), refs: [JSON.stringify(entries)] }); continue; }
      for (const [id, entry] of Object.entries(entries)) rows.push({ table, id, label: `${table}.${id}`, refs: artEntryStrings(entry) });
    }
  }
  if (!rows.length) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('这个包的 pack.json 里还没有 art 声明。') }));
    return box;
  }
  for (const row of rows) {
    const line = document.createElement('div'); line.className = 'row';
    line.style.cssText = 'align-items:flex-start;justify-content:space-between;border-bottom:1px solid var(--line);padding:4px 0';
    const text = document.createElement('div'); text.style.flex = '1';
    const n = document.createElement('div'); n.className = 'n'; n.textContent = row.label;
    const m = document.createElement('div'); m.className = 'hint';
    m.textContent = row.refs.length ? row.refs.join(' · ') : t('（没有引用任何文件）');
    text.append(n, m);
    const del = document.createElement('button'); del.className = 'ghost artDel'; del.textContent = t('删除');
    del.addEventListener('click', () => { deleteArtDeclaration(row.table, row.id); });
    line.append(text, del);
    box.append(line);
  }
  return box;
}

/** 保存 / 删除的回话（带 warnings）：表单每次重画都要还在，所以存在 state 里而不是 DOM 上。 */
function artMessageBox() {
  if (!state.artMessage) return null;
  const box = document.createElement('div');
  box.className = `banner ${state.artMessage.kind === 'error' ? 'bad' : 'good'}`;
  box.textContent = state.artMessage.text;
  for (const w of state.artMessage.warnings ?? []) {
    box.append(Object.assign(document.createElement('div'), { className: 'hint warn', textContent: String(w) }));
  }
  return box;
}

/**
 * 怪物页「美术与非数据表字段」里那块「本包自带的外观素材」：`icon` + 扁平的 spine（skel / atlas / textures / pma /
 * anims）+ 原样抄的 `spineAliasOf`，以及全部声明的清单。
 * @param {string|null} key 这只怪物的记录键（客户端就是拿它去 `enemies` 表查外观）
 */
function enemyArtBox(key) {
  const box = document.createElement('div'); box.className = 'panel artPanel';
  const title = document.createElement('h2'); title.textContent = t('本包自带的外观素材（可选）');
  box.append(title);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('客户端画一只怪物时读的是合并后的 `data/assets.json` 的 `enemies`：这里声明的东西会被并进那一条（素材走 /workshop-assets），客户端零改动。路径都相对包的 `assets/`，文件要自己先放进去 —— 编辑器不上传素材。'),
  }));
  if (!state.packId) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('先在右边选一个工坊包。') }));
    return box;
  }
  if (!key) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('先填 id（记录键是 enemy_ws_<id>，客户端就是拿它去 `enemies` 表查外观），再回来给它配素材。') }));
    box.append(artDeclaredList());
    return box;
  }
  const draft = artDraftFor('enemies', key);
  const art = packArtState();
  const images = art.files.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  const skelFiles = art.files.filter((f) => /\.skel$/i.test(f));
  const atlasFiles = art.files.filter((f) => /\.atlas$/i.test(f));
  const setField = (k, v) => { if (v) draft[k] = v; else delete draft[k]; };
  const iconRow = document.createElement('div'); iconRow.className = 'grid wide';
  iconRow.append(
    field(t('图标 icon'), artFileSelect(images, () => draft.icon, (v) => setField('icon', v), t('（不声明）'))),
    // spineAliasOf 是原样抄的 id（指向另一只怪物的模型），不是文件路径，所以候选用官方 prefab 键
    field(t('别人的模型 spineAliasOf（可留空）'), spineAliasField(draft)),
  );
  box.append(iconRow);

  const spine = isRec(draft.spine) ? draft.spine : {};
  const commitSpine = () => { if (Object.keys(spine).length) draft.spine = spine; else delete draft.spine; };
  const skelInfo = skelParse(spine.skel);
  const atlasInfo = atlasParse(spine.atlas);
  // 硬约束 1：atlas 必须与 skel 同目录同名 —— 选完 skel 自动填上，别让作者手打（手打必错，而且错了不报错）
  const setSkel = (v) => {
    if (v) {
      spine.skel = v;
      spine.atlas = v.replace(/\.skel$/i, '.atlas');
      // atlas 也要问一次：textures 与 pma 的默认值都从图谱里读（清单里没声明时它们根本不在 /api/state 里）
      askArtParse(v, 'skel').then(() => askArtParse(spine.atlas, 'atlas')).then(redrawForm);
    } else { delete spine.skel; delete spine.atlas; }
    commitSpine();
  };
  const setAtlas = (v) => {
    if (v) { spine.atlas = v; askArtParse(v, 'atlas').then(redrawForm); } else delete spine.atlas;
    commitSpine();
  };
  const modelRow = document.createElement('div'); modelRow.className = 'grid wide';
  modelRow.append(
    field(t('骨架 skel'), artFileSelect(skelFiles, () => spine.skel, setSkel, t('（不用本包模型）'), 'artSkel')),
    field(t('图谱 atlas（选完 skel 自动填同名，别手打）'), artFileSelect(atlasFiles, () => spine.atlas, setAtlas, t('（随 skel 自动填）'), 'artAtlas')),
  );
  box.append(modelRow);
  if (spine.atlas && !atlasFiles.includes(spine.atlas)) {
    box.append(Object.assign(document.createElement('div'), { className: 'hint warn', textContent: t('按同名推出来的 {0} 不在本包的 assets/ 里：把这个文件放进去 —— 加载器只读同目录同名的那个 .atlas，找不到就画不出来，而且不报错。', spine.atlas) }));
  }
  if (skelInfo?.note) box.append(Object.assign(document.createElement('div'), { className: 'hint warn', textContent: skelInfo.note }));
  if (atlasInfo?.note) box.append(Object.assign(document.createElement('div'), { className: 'hint warn', textContent: atlasInfo.note }));
  // textures：默认按图谱页名自动填（客户端只在清单里没有 textures 时才退回 `<skel>.png`，而图谱那一页可能叫别的名字）
  const derivedTextures = () => {
    const pages = atlasInfo?.pages ?? [];
    if (!pages.length) return [];
    const dir = relDirOf(spine.atlas);
    return pages.map((p) => relJoin(dir, p));
  };
  const textures = Array.isArray(spine.textures) && spine.textures.length ? spine.textures : derivedTextures();
  const texInput = document.createElement('input');
  texInput.className = 'artTextures';
  texInput.value = textures.join(', ');
  texInput.placeholder = t('默认按图谱页名自动填');
  texInput.addEventListener('input', () => {
    const list = texInput.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    if (list.length) spine.textures = [...new Set(list)]; else delete spine.textures;
    commitSpine();
  });
  const pmaValue = typeof spine.pma === 'boolean' ? spine.pma : (atlasInfo?.hasPma ?? false);
  const pmaRow = document.createElement('div'); pmaRow.className = 'grid wide';
  pmaRow.append(
    field(t('贴图 textures（留空＝按 atlas 里的页名自动填）'), texInput),
    field(t('预乘 alpha pma'), checkInput(() => pmaValue, (v) => { spine.pma = v; commitSpine(); }, '')),
  );
  box.append(pmaRow);
  if (atlasInfo && atlasInfo.hasPma !== pmaValue) {
    box.append(Object.assign(document.createElement('div'), { className: 'hint warn', textContent: t('图谱里写的是 pma: {0}，与这里不一致 —— 客户端信清单这一份，画出来就是错的。', String(atlasInfo.hasPma)) }));
  }
  if (!spine.skel) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('还没选骨架：这一条就不会带模型（只换图标/头像也可以）。') }));
  } else {
    const names = skelInfo?.animations ?? [];
    if (!skelInfo || skelInfo.note) {
      box.append(Object.assign(document.createElement('p'), { className: 'hint warn', textContent: t('这个骨架的动画名还没解析出来：下面是手输框，填的名字保存时服务端会去骨架里核对。') }));
    }
    const roleTitle = document.createElement('h2'); roleTitle.textContent = t('动画 anims（角色名就是客户端读的那几个）');
    box.append(roleTitle);
    const roles = document.createElement('div'); roles.className = 'grid wide';
    const animsOf = () => (isRec(spine.anims) ? spine.anims : {});
    const writeAnims = (next) => { if (Object.keys(next).length) spine.anims = next; else delete spine.anims; commitSpine(); };
    const setName = (role, v) => { const next = { ...animsOf() }; if (v) next[role] = v; else delete next[role]; writeAnims(next); };
    const setClip = (role, field2, v) => {
      const next = { ...animsOf() };
      const clip = { ...(isRec(next[role]) ? next[role] : {}) };
      if (field2 === 'loop' && !v) delete next[role];
      else { if (v) clip[field2] = v; else delete clip[field2]; next[role] = clip; }
      writeAnims(next);
    };
    for (const role of ART_ROLES) {
      if (ART_CLIP_ROLES.includes(role)) {
        const clip = isRec(animsOf()[role]) ? animsOf()[role] : null;
        roles.append(field(`${role} · loop`, artAnimInput(names, () => clip?.loop ?? '', (v) => setClip(role, 'loop', v), t('（不声明这个角色）'))));
      } else {
        const value = animsOf()[role];
        roles.append(field(role, artAnimInput(names, () => (typeof value === 'string' ? value : ''), (v) => setName(role, v), t('（不声明这个角色）'))));
      }
    }
    box.append(roles);
    const advanced = document.createElement('details');
    const sum = document.createElement('summary'); sum.className = 'hint'; sum.textContent = t('进阶：起手 / 收尾（可选）');
    advanced.append(sum);
    for (const role of ART_CLIP_ROLES) {
      const clip = isRec(animsOf()[role]) ? animsOf()[role] : null;
      if (!clip) continue;
      const row = document.createElement('div'); row.className = 'grid wide';
      row.append(
        field(`${role} · begin`, artAnimInput(names, () => clip.begin ?? '', (v) => setClip(role, 'begin', v), t('（不要起手）'))),
        field(`${role} · end`, artAnimInput(names, () => clip.end ?? '', (v) => setClip(role, 'end', v), t('（不要收尾）'))),
      );
      advanced.append(row);
    }
    if (advanced.children.length > 1) box.append(advanced);
  }
  const actions = document.createElement('div'); actions.className = 'row'; actions.style.marginTop = '10px';
  const saveBtn = document.createElement('button'); saveBtn.className = 'primary artSave'; saveBtn.textContent = t('保存这条外观');
  saveBtn.addEventListener('click', () => { saveEnemyArt(key); });
  const delBtn = document.createElement('button'); delBtn.className = 'ghost artDel'; delBtn.textContent = t('删除这条声明');
  delBtn.addEventListener('click', () => { deleteArtDeclaration('enemies', key); });
  actions.append(saveBtn, delBtn);
  if (!art.files.length) {
    actions.append(Object.assign(document.createElement('span'), { className: 'hint warn', textContent: t('本包的 `assets/` 里还没有素材：把文件放进去，再回到这一页挑。') }));
  }
  box.append(actions);
  const msg = artMessageBox();
  if (msg) box.append(msg);
  box.append(artDeclaredList());
  return box;
}

/** `spineAliasOf`：原样抄过去的 id（指向另一只怪物的模型），所以候选是官方 prefab 键 + 手填。 */
function spineAliasField(draft) {
  const wrap = document.createElement('div');
  const i = document.createElement('input');
  i.value = typeof draft.spineAliasOf === 'string' ? draft.spineAliasOf : '';
  i.setAttribute('list', 'spineAliasOptions');
  i.addEventListener('input', () => { if (i.value) draft.spineAliasOf = i.value; else delete draft.spineAliasOf; });
  const dl = document.createElement('datalist'); dl.id = 'spineAliasOptions';
  for (const c of state.data?.spineChoices ?? []) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    dl.append(o);
  }
  wrap.append(i, dl);
  return wrap;
}

/** 保存「这条外观」：整条条目一次性 POST（服务端会把三条硬约束逐条查一遍再写）。 */
async function saveEnemyArt(key) {
  if (!state.packId || !key) return;
  const draft = JSON.parse(JSON.stringify(state.artDraft ?? {}));
  for (const spine of artSpineObjectsUi(draft)) {
    const atlas = typeof spine.atlas === 'string' ? atlasParse(spine.atlas) : null;
    if (!atlas || atlas.note || !atlas.pages?.length) continue;
    const dir = relDirOf(spine.atlas);
    if (!Array.isArray(spine.textures) || !spine.textures.length) spine.textures = atlas.pages.map((p) => relJoin(dir, p));
    if (typeof spine.pma !== 'boolean') spine.pma = atlas.hasPma;
  }
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/art`, { method: 'POST', body: { table: 'enemies', id: key, art: draft } });
    state.artDraftKey = '';
    state.artMessage = { kind: 'ok', text: t('已保存 {0} 的外观', `enemies.${key}`), warnings: r.warnings ?? [] };
    await load();
  } catch (e) {
    state.artMessage = { kind: 'error', text: e.message, warnings: [] };
    redrawForm();
  }
}

/** 删掉一条外观声明（`art` 为 null = 删；空对象逐级清理在服务端做）。任何声明都必须能在这里删掉。 */
async function deleteArtDeclaration(table, id) {
  if (!state.packId) return;
  const label = id ? `${table}.${id}` : table;
  if (!confirm(t('删除 {0} 这条外观声明？（只删 pack.json 里的这一条，素材文件不动）', label))) return;
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/art`, { method: 'POST', body: { table, id: id ?? 'x', art: null } });
    if (state.artDraftKey === `${table}.${id}`) state.artDraftKey = '';
    state.artMessage = { kind: 'ok', text: t('已删掉 {0} 的外观声明', label), warnings: r.warnings ?? [] };
    await load();
  } catch (e) {
    state.artMessage = { kind: 'error', text: e.message, warnings: [] };
    redrawForm();
  }
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
    field(t('id（slug）'), textInput(() => spec.id, (v) => { spec.id = v; scheduleFormRedraw(); }), t('会生成 enemy_ws_<id>，例如 frost_hound')),
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
  // 本包自带的外观素材（图标 + 扁平的 spine）：id 就是这一只会生成/已保存的记录键（客户端按它查 enemies 表）
  artBox.append(enemyArtBox(enemyKey(spec.id)?.key ?? null));
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
    newDefault: 'my-monster-pack',
    // 换包要把表单也重画一次：表单里的「本包自带的外观素材」列的是**这个包** assets/ 里真的有的文件
    onPick: (id) => { state.packId = id; renderSide(); redrawForm(); },
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
  // 别的页面可能带 ?pack=<包> 跳过来（例如出怪页的「＋ 新建怪物…」），优先用它
  const asked = readPackParam();
  if (asked && state.data.packs?.some((p) => p.id === asked)) state.packId = asked;
  if (!state.packId) state.packId = state.data.enemies[0]?.pack ?? null;
  renderList();
  // 每次都重画表单：这一页的表单里有一块依赖**包**与**pack.json 本身**（本包自带的外观素材，见 enemyArtBox），
  // 而 spec 才是唯一的数据源 —— 重画不丢任何东西（保存/删除/换包之后那一段也要跟着更新）。
  renderForm();
  renderSide();
}

/** `?pack=<包 id>`：从别的页面跳过来时先选中那个包（只认确实存在的包）。 */
function readPackParam() {
  try {
    return new URLSearchParams(location.search).get('pack');
  } catch {
    return null;
  }
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
