// editor/ui/item.js — the equipment (装备) editor page (docs/EDITOR.md). Plain DOM, no build step, no game-client import.
//
// The form edits the SPEC only. Everything the engine actually reads is DERIVED server-side on every keystroke
// (debounced) through /api/items/preview and shown read-only:
//
//   params        the flattening of the buffs' blackboards — the engine reads params, NOT the buffs, so a stale one is
//                 an item whose card promises an effect that never happens
//   mergeable     isGolden / upgradeNum / whether a twin exists
//   shopExcluded  exactly "shopExcludedBy is set"
//
// One spec is TWO records: `_a` (normal) and `_b` (golden twin). The pair is what makes an item mergeable, so the form
// always shows both ids it will write and never lets the author think in terms of a single record.

import { t, mountI18n } from './i18n.js';
import { packSelect } from './packPicker.js';

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = { data: null, packId: null, id: null, spec: null, preview: null, message: null, busy: false };

/**
 * The spec as it should be SENT: without the form's own scratch flags. `_rangeBad` marks a half-typed JSON textarea; it
 * must never reach the stored spec file, or a later reader sees a field that means nothing.
 */
const cleanSpec = () => Object.fromEntries(Object.entries(state.spec || {}).filter(([k]) => !k.startsWith('_')));

/** `chess_item_ws_<slug>_a` / `_b` — the same shape shared/itemAuthoring.js computes, shown so the author can see the pair. */
function pairIds(idOrSlug) {
  const raw = String(idOrSlug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  let slug = raw;
  if (slug.startsWith('chess_item_ws_')) slug = slug.slice('chess_item_ws_'.length);
  else if (slug.startsWith('chess_item_')) slug = slug.slice('chess_item_'.length);
  slug = slug.replace(/_[ab]$/, '');
  return slug ? { slug, base: `chess_item_ws_${slug}_a`, golden: `chess_item_ws_${slug}_b` } : null;
}

function blankSpec() {
  return {
    id: '', name: '', desc: '', itemType: 'EQUIP', category: null, tier: 3, price: 10,
    upgradeNum: 2, duration: -1, trapId: '', hideInShop: false, shopExcludedBy: null,
    effectId: '', effectName: '', giveBondId: null, requiresBondId: null, canGiveBond: false,
    buffs: [{ key: '', countType: 'NONE', bb: {}, bbStr: {} }],
    rangeGrid: [[0, 0]], note: '', implFormula: '', flavor: '',
  };
}

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
function areaInput(get, set) {
  const t = document.createElement('textarea');
  t.value = get() ?? '';
  t.addEventListener('input', () => { set(t.value); schedule(); });
  return t;
}

/** A tiny key → value editor over a plain object (a buff blackboard). Mutates a COPY, so the preview always sees a clean spec. */
function kvEditor(get, set, { asString = false } = {}) {
  const wrap = document.createElement('div');
  for (const [k, v] of Object.entries(get() || {})) {
    const row = document.createElement('div'); row.className = 'kv';
    const ki = document.createElement('input'); ki.value = k; ki.placeholder = t('键');
    const vi = document.createElement('input'); vi.value = v ?? '';
    if (!asString) { vi.type = 'number'; vi.step = 'any'; }
    ki.addEventListener('change', () => {
      const cur = { ...(get() || {}) }; const val = cur[k]; delete cur[k]; cur[ki.value] = val;
      set(cur); renderForm(); schedule();
    });
    vi.addEventListener('change', () => { set({ ...(get() || {}), [k]: asString ? vi.value : Number(vi.value) }); schedule(); });
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    del.addEventListener('click', () => { const cur = { ...(get() || {}) }; delete cur[k]; set(cur); renderForm(); schedule(); });
    row.append(ki, vi, del);
    wrap.append(row);
  }
  const add = document.createElement('button'); add.className = 'ghost'; add.textContent = t('＋ 加一个键');
  add.addEventListener('click', () => { set({ ...(get() || {}), '': asString ? '' : 0 }); renderForm(); });
  wrap.append(add);
  return wrap;
}

function renderForm() {
  const box = $('#form');
  box.replaceChildren();
  const spec = state.spec;
  if (!spec) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一件装备，或点「新建装备」。') }));
    return;
  }
  const v = state.data.vocab;
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  const ids = pairIds(spec.id);

  box.append(h(t('身份')));
  const idBox = document.createElement('div'); idBox.className = 'panel';
  const idGrid = document.createElement('div'); idGrid.className = 'grid wide';
  idGrid.append(
    field(t('id（slug）'), textInput(() => spec.id, (x) => { spec.id = x; renderSide(); }), t('写入 chess_item_ws_<id>_a 与 _b')),
    field(t('名称'), textInput(() => spec.name, (x) => { spec.name = x; })),
    field(t('类型 itemType'), selectInput(() => spec.itemType, (x) => { spec.itemType = x; }, v.types)),
    field(t('分类 category'), selectInput(() => spec.category, (x) => { spec.category = x; }, v.categories, { allowEmpty: true })),
    field(t('阶级 tier（1-6）'), numInput(() => spec.tier, (x) => { spec.tier = x; }, { min: 1, max: 6 })),
    field(t('价格 price'), numInput(() => spec.price, (x) => { spec.price = x; }, { min: 0 })),
    field(t('持续 duration'), selectInput(() => spec.duration, (x) => { spec.duration = x; }, v.durations,
      { labels: { '-1': t('-1 整场有效'), 0: t('0 立即结算') } })),
    // upgradeNum is the author's choice; it decides whether a golden twin exists at all
    field(t('合成数 upgradeNum'), selectInput(() => spec.upgradeNum, (x) => { spec.upgradeNum = x; }, v.upgradeNums,
      { labels: { 0: t('0 独立（不可合成）'), 2: t('2 可合成（需要 _b）'), 100: t('100 特殊（不可合成）') } })),
  );
  idBox.append(idGrid);

  // trapId: a pack ships no art, so borrowing an existing equip icon is the only way to get a real picture
  const iconInput = document.createElement('input');
  iconInput.setAttribute('list', 'iconChoices');
  iconInput.value = spec.trapId ?? '';
  iconInput.placeholder = t('例如 trap_1013_lhp');
  iconInput.addEventListener('input', () => { spec.trapId = iconInput.value; schedule(); });
  const dl = document.createElement('datalist'); dl.id = 'iconChoices';
  for (const o of state.data.icons ?? []) {
    const opt = document.createElement('option');
    opt.value = o.trapId; opt.label = `${o.name}（${o.from}）`;
    dl.append(opt);
  }
  idBox.append(dl);
  const artGrid = document.createElement('div'); artGrid.className = 'grid wide';
  artGrid.append(
    field(t('图标 trapId（复用现有装备图标，否则用兜底图）'), iconInput),
    field(t('identifier（数值表 id，可留空）'), textInput(() => spec.identifier ?? '', (x) => { spec.identifier = x === '' ? null : Number(x); })),
  );
  idBox.append(artGrid);
  const flags = document.createElement('div'); flags.className = 'row'; flags.style.marginTop = '8px';
  flags.append(
    checkInput(() => spec.hideInShop, (x) => { spec.hideInShop = x; }, t('商店不显示 hideInShop')),
    checkInput(() => spec.canGiveBond, (x) => { spec.canGiveBond = x; }, t('可授予羁绊 canGiveBond')),
  );
  idBox.append(flags);
  idBox.append(field(t('卡面描述 desc'), areaInput(() => spec.desc, (x) => { spec.desc = x; })));
  box.append(idBox);

  // ---- 本包自带的图标 ---------------------------------------------------------------------------------------------
  // pack.json 的 `itemIcons` 一个字段（与盟约图标、语音同一套写法）。客户端按**道具的图标 id** 从
  // `data/assets.json` 的 `assets.items` 取图（public/js/assets.js itemIconUrl：先看 `item.iconId`、再看
  // `item.trapId`，然后查 `m.items[id]`），而一个包没法给 assets.json 加条目 —— 于是包新增的装备在界面上没有图标。
  // 这里把包自带的图接上：装载时叠加层把它写进 `assets.items`，URL 走 /workshop-assets 那条唯一路由 —— 客户端
  // 因此零改动（它读的还是同一份合并后的 assets.json）。图片要自己先放进包里的 assets/，编辑器不上传素材。
  const packIcons = (state.data?.packItemIcons ?? []).find((p) => p.id === state.packId);
  const iconKey = String(spec.trapId ?? '').trim();
  const iconFiles = packIcons?.iconFiles ?? [];
  const currentIcon = (packIcons?.itemIcons ?? {})[iconKey] ?? '';
  const officialIcon = iconKey ? (state.data?.icons ?? []).some((o) => o.trapId === iconKey) : false;
  const iconBox = document.createElement('div'); iconBox.className = 'panel';
  iconBox.append(h(t('本包自带的图标（可选）')));
  iconBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('客户端按**道具的图标 id** 取图：`itemIconUrl` 先看 `item.iconId`、再看 `item.trapId`，都从 `data/assets.json` 的 `items` 里查。配了本包这张图（走 /workshop-assets）就显示它；没配就看官方清单有没有这个 id，都没有就是兜底图。图片要自己先放进 `{0}/assets/`，编辑器不上传素材。', state.packId ?? '（工坊包）'),
  }));
  if (!iconKey) {
    iconBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('这件装备还没有图标 id：先在「图标 trapId」里填一个（如 trap_ws_my_item）并保存，再回来给它配图。') }));
  } else {
    const sel = selectInput(() => currentIcon, async (v) => {
      try {
        await api(`/api/packs/${encodeURIComponent(state.packId)}/item-icons`, { method: 'POST', body: { itemId: iconKey, path: v ?? '' } });
        state.message = { kind: 'ok', text: v
          ? t('已把 {0} 的图标设为本包的 {1}', iconKey, v)
          : t('已取消 {0} 的自带图标', iconKey) };
        await load();
      } catch (e) { state.message = { kind: 'error', text: t(e?.message ?? String(e)) }; renderForm(); }
    }, ['', ...iconFiles], { labels: { '': t('（不用本包图标）') } });
    iconBox.append(field(t('图标文件（本包 assets/ 下的图片）'), sel));
    if (!iconFiles.length) {
      iconBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('本包的 `assets/` 里还没有图片：把图标文件放进去（如 assets/item/{0}.png），再回到这一页挑。', iconKey) }));
    }
  }
  iconBox.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: officialIcon
    ? t('官方清单里有 `{0}` 这张图：不配本包图标时，客户端会用它。', iconKey)
    : t('官方清单里没有 `{0}` 这张图：不配本包图标时，这件装备显示兜底图。', iconKey || t('（空）')) }));
  box.append(iconBox);

  box.append(h(t('效果 buffs（引擎真正读的是它们摊平出来的 params）')));
  const buffBox = document.createElement('div'); buffBox.className = 'panel';
  buffBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('buff 的 key 是技能/触发器的模板键；bb 是数值黑板，bbStr 是字符串黑板。同名键先出现的先赢。'),
  }));
  (spec.buffs || []).forEach((b, i) => {
    const card = document.createElement('div'); card.className = 'buff';
    const head = document.createElement('div'); head.className = 'head';
    head.append(
      field(`buff[${i}] key`, textInput(() => b.key, (x) => { b.key = x; })),
      field('countType', selectInput(() => b.countType, (x) => { b.countType = x; }, v.countTypes)),
    );
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = '×';
    del.addEventListener('click', () => { spec.buffs.splice(i, 1); renderForm(); schedule(); });
    const delWrap = document.createElement('div'); delWrap.append(del);
    head.append(delWrap);
    card.append(head);
    const bbWrap = document.createElement('div'); bbWrap.className = 'bb';
    const bbCol = document.createElement('div');
    bbCol.append(Object.assign(document.createElement('label'), { textContent: t('bb（数值）') }));
    bbCol.append(kvEditor(() => b.bb, (x) => { b.bb = x; }));
    const strCol = document.createElement('div');
    strCol.append(Object.assign(document.createElement('label'), { textContent: t('bbStr（字符串）') }));
    strCol.append(kvEditor(() => b.bbStr, (x) => { b.bbStr = x; }, { asString: true }));
    bbWrap.append(bbCol, strCol);
    card.append(bbWrap);
    buffBox.append(card);
  });
  const addBuff = document.createElement('button'); addBuff.className = 'ghost'; addBuff.textContent = t('＋ 加一个 buff');
  addBuff.addEventListener('click', () => { spec.buffs = [...(spec.buffs || []), { key: '', countType: 'NONE', bb: {}, bbStr: {} }]; renderForm(); schedule(); });
  buffBox.append(addBuff);
  box.append(buffBox);

  box.append(h(t('其余文案与联动')));
  const textBox = document.createElement('div'); textBox.className = 'panel';
  const tGrid = document.createElement('div'); tGrid.className = 'grid wide';
  tGrid.append(
    field(t('effectId（留空则自动生成 eff_ws_<id>）'), textInput(() => spec.effectId, (x) => { spec.effectId = x; })),
    field(t('effectName（留空则用名称）'), textInput(() => spec.effectName, (x) => { spec.effectName = x; })),
    field(t('requiresBondId（需要哪个羁绊）'), textInput(() => spec.requiresBondId, (x) => { spec.requiresBondId = x || null; })),
    field(t('giveBondId（授予哪个羁绊）'), textInput(() => spec.giveBondId, (x) => { spec.giveBondId = x || null; })),
    field(t('shopExcludedBy（填了就等于商店排除）'), textInput(() => spec.shopExcludedBy, (x) => { spec.shopExcludedBy = x || null; })),
    field('family', textInput(() => spec.family, (x) => { spec.family = x || null; })),
  );
  textBox.append(tGrid);
  textBox.append(
    field(t('note（备注）'), textInput(() => spec.note, (x) => { spec.note = x || null; })),
    field(t('implFormula（实现公式，给人看的）'), textInput(() => spec.implFormula, (x) => { spec.implFormula = x || null; })),
    field(t('flavor（风味文本）'), textInput(() => spec.flavor, (x) => { spec.flavor = x || null; })),
  );
  box.append(textBox);

  box.append(h(t('覆盖范围 rangeGrid')));
  const rgBox = document.createElement('div'); rgBox.className = 'panel';
  rgBox.append(field(t('rangeGrid（JSON，[[行,列],…]）'), areaInput(
    () => JSON.stringify(spec.rangeGrid ?? [[0, 0]]),
    (x) => { try { const p = JSON.parse(x); if (Array.isArray(p)) { spec.rangeGrid = p; spec._rangeBad = false; } else spec._rangeBad = true; } catch { spec._rangeBad = true; } renderSide(); },
  )));
  box.append(rgBox);
}

// ---- preview ----------------------------------------------------------------------------------------------------

let timer = null;
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(preview, now ? 0 : 300);
}
async function preview() {
  if (!state.spec) return;
  if (state.spec._rangeBad) return;   // mid-typing JSON: do not spam the server with an unparseable spec
  try {
    state.preview = await api('/api/items/preview', { method: 'POST', body: { spec: cleanSpec() } });
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
  box.append(mk(t('＋ 新建装备'), 'item', () => {
    state.id = null; state.spec = blankSpec(); state.preview = null; renderList(); renderForm(); renderSide(); schedule(true);
  }));
  // pairs collapse into ONE row: the author thinks in items, not in `_a`/`_b` records
  const seen = new Set();
  for (const it of state.data?.items ?? []) {
    const ids = pairIds(it.id);
    const slug = ids ? ids.slug : it.id;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const errs = (it.issues ?? []).filter((i) => i.severity === 'error').length;
    const el = document.createElement('div');
    el.className = `item${slug === state.id ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${it.name}${errs ? ` <span class="tag err">${errs}</span>` : ''}`
      + `${it.mergeable ? ` <span class="tag gold">${t('可合成')}</span>` : ''}</div>`
      + `<div class="m">${it.pack} · ${slug}</div>`
      + `<div class="m">${it.itemType} · ${t('{0} 阶', it.tier ?? '?')} · ${t('{0} 金', it.price ?? '?')} · ${it.managed ? t('可编辑') : t('非编辑器管理')}</div>`;
    el.addEventListener('click', () => openItem(it));
    box.append(el);
  }
}

async function openItem(it) {
  const ids = pairIds(it.id);
  state.packId = it.pack;
  state.id = ids ? ids.slug : it.id;
  state.message = null;
  try {
    const r = await api(`/api/items/${encodeURIComponent(it.pack)}/${encodeURIComponent(ids ? ids.base : it.id)}`);
    state.spec = r.spec ?? specFromRecord(r.record);
    renderList(); renderForm(); renderSide(); schedule(true);
  } catch (err) { state.message = { kind: 'error', text: err.message }; renderSide(); }
}

/** Read a generated record back into a spec (for a pair the editor did not author). */
function specFromRecord(rec) {
  const base = blankSpec();
  if (!rec) return base;
  return {
    ...base,
    id: String(rec.id || rec.baseId || '').replace(/^chess_item_ws_/, '').replace(/_[ab]$/, ''),
    name: rec.name ?? '', desc: rec.desc ?? '', itemType: rec.itemType ?? 'EQUIP', category: rec.category ?? null,
    tier: rec.tier ?? 3, price: rec.price ?? 0, upgradeNum: rec.upgradeNum ?? 0, duration: rec.duration ?? -1,
    trapId: rec.trapId ?? '', hideInShop: rec.hideInShop === true, shopExcludedBy: rec.shopExcludedBy ?? null,
    effectId: rec.effectId ?? '', effectName: rec.effectName ?? '',
    giveBondId: rec.giveBondId ?? null, requiresBondId: rec.requiresBondId ?? null, canGiveBond: rec.canGiveBond === true,
    buffs: Array.isArray(rec.buffs) ? rec.buffs.map((b) => ({ key: b.key ?? '', countType: b.countType ?? 'NONE', bb: b.bb ?? {}, bbStr: b.bbStr ?? {} })) : [],
    rangeGrid: rec.rangeGrid ?? [[0, 0]], note: rec.note ?? '', implFormula: rec.implFormula ?? '', flavor: rec.flavor ?? '',
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

  box.append(h(t('会写出的两个记录')));
  const idBox = document.createElement('div'); idBox.className = 'panel derived';
  const ids = pairIds(state.spec.id);
  idBox.textContent = ids ? `${ids.base}\n${ids.golden}` : t('（先填 id）');
  box.append(idBox);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('一件装备 = 一个 spec = 普通记录 + 精英记录。没有 _b 就不能合成，所以可合成项必须成对写出。'),
  }));

  box.append(h(t('派生量（只读，服务端算）')));
  const dbox = document.createElement('div'); dbox.className = 'panel derived';
  const rec = state.preview?.record;
  dbox.textContent = rec
    ? `params ${JSON.stringify(rec.params)}\nmergeable ${rec.mergeable}\nshopExcluded ${rec.shopExcluded}  (shopExcludedBy ${JSON.stringify(rec.shopExcludedBy)})\nupgradeChessId ${JSON.stringify(rec.upgradeChessId)}`
    : t('（改动后自动推导）');
  box.append(dbox);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('引擎读的是 params，不是 buffs。手写 params 只会让卡面说谎，所以它每次都由 buffs 重算。'),
  }));

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? t('保存中…') : t('保存');
  save.disabled = state.busy || !state.spec.id;
  save.addEventListener('click', saveItem);
  actions.append(save);
  if (state.id) {
    const del = document.createElement('button'); del.textContent = t('删除');
    del.addEventListener('click', deleteItem);
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
    askNewId: () => prompt(t('新工坊包的 id（字母数字下划线短横线，≤32）：'), 'my-item-pack'),
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
  if (state.spec._rangeBad) pv.append(Object.assign(document.createElement('div'), { className: 'err', textContent: t('rangeGrid 不是合法 JSON，暂不校验') }));
  box.append(pv);
}

async function saveItem() {
  if (!state.packId) {
    state.message = { kind: 'error', text: t('先在右边选一个工坊包（或点「＋ 新建一个包…」）。') };
    renderSide();
    return;
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/items`, { method: 'POST', body: { spec: cleanSpec() } });
    state.id = pairIds(r.id)?.slug ?? state.id;
    state.message = { kind: 'ok', text: t('已保存 {0}，生成 {1}。', r.id + (r.goldenId ? ` + ${r.goldenId}` : ''), r.generated.join(', ')) };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteItem() {
  if (!state.id || !confirm(t('删除装备 {0}（连同它的精英记录）？', state.id))) return;
  const ids = pairIds(state.id);
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/items/${encodeURIComponent(ids ? ids.base : state.id)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: t('已删除 {0}', state.id) };
    state.id = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

async function load() {
  state.data = await api('/api/items');
  const n = new Set((state.data.items ?? []).map((i) => pairIds(i.id)?.slug ?? i.id)).size;
  $('#rootPath').textContent = n ? t('{0} 件工坊装备（{1} 条记录）', n, state.data.items.length) : t('还没有工坊装备');
  if (!state.packId) state.packId = state.data.items[0]?.pack ?? null;
  renderList();
  if (!state.spec) renderForm();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.id = null; state.spec = blankSpec(); state.preview = null; renderList(); renderForm(); renderSide(); schedule(true); });

// 语言切换后要重画：列表、表单与右侧面板的文案都是 JS 生成的，只换静态 HTML 不够。
mountI18n(() => { renderList(); renderForm(); renderSide(); });

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: t('载入失败：{0}', e.message) })); });
