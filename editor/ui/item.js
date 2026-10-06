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
  if (allowEmpty) { const o = document.createElement('option'); o.value = ''; o.textContent = '（无）'; s.append(o); }
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
    const ki = document.createElement('input'); ki.value = k; ki.placeholder = '键';
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
  const add = document.createElement('button'); add.className = 'ghost'; add.textContent = '＋ 加一个键';
  add.addEventListener('click', () => { set({ ...(get() || {}), '': asString ? '' : 0 }); renderForm(); });
  wrap.append(add);
  return wrap;
}

function renderForm() {
  const box = $('#form');
  box.replaceChildren();
  const spec = state.spec;
  if (!spec) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '左边选一件装备，或点「新建装备」。' }));
    return;
  }
  const v = state.data.vocab;
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  const ids = pairIds(spec.id);

  box.append(h('身份'));
  const idBox = document.createElement('div'); idBox.className = 'panel';
  const idGrid = document.createElement('div'); idGrid.className = 'grid wide';
  idGrid.append(
    field('id（slug）', textInput(() => spec.id, (x) => { spec.id = x; renderSide(); }), '写入 chess_item_ws_<id>_a 与 _b'),
    field('名称', textInput(() => spec.name, (x) => { spec.name = x; })),
    field('类型 itemType', selectInput(() => spec.itemType, (x) => { spec.itemType = x; }, v.types)),
    field('分类 category', selectInput(() => spec.category, (x) => { spec.category = x; }, v.categories, { allowEmpty: true })),
    field('阶级 tier（1-6）', numInput(() => spec.tier, (x) => { spec.tier = x; }, { min: 1, max: 6 })),
    field('价格 price', numInput(() => spec.price, (x) => { spec.price = x; }, { min: 0 })),
    field('持续 duration', selectInput(() => spec.duration, (x) => { spec.duration = x; }, v.durations,
      { labels: { '-1': '-1 整场有效', 0: '0 立即结算' } })),
    // upgradeNum is the author's choice; it decides whether a golden twin exists at all
    field('合成数 upgradeNum', selectInput(() => spec.upgradeNum, (x) => { spec.upgradeNum = x; }, v.upgradeNums,
      { labels: { 0: '0 独立（不可合成）', 2: '2 可合成（需要 _b）', 100: '100 特殊（不可合成）' } })),
  );
  idBox.append(idGrid);

  // trapId: a pack ships no art, so borrowing an existing equip icon is the only way to get a real picture
  const iconInput = document.createElement('input');
  iconInput.setAttribute('list', 'iconChoices');
  iconInput.value = spec.trapId ?? '';
  iconInput.placeholder = '例如 trap_1013_lhp';
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
    field('图标 trapId（复用现有装备图标，否则用兜底图）', iconInput),
    field('identifier（数值表 id，可留空）', textInput(() => spec.identifier ?? '', (x) => { spec.identifier = x === '' ? null : Number(x); })),
  );
  idBox.append(artGrid);
  const flags = document.createElement('div'); flags.className = 'row'; flags.style.marginTop = '8px';
  flags.append(
    checkInput(() => spec.hideInShop, (x) => { spec.hideInShop = x; }, '商店不显示 hideInShop'),
    checkInput(() => spec.canGiveBond, (x) => { spec.canGiveBond = x; }, '可授予羁绊 canGiveBond'),
  );
  idBox.append(flags);
  idBox.append(field('卡面描述 desc', areaInput(() => spec.desc, (x) => { spec.desc = x; })));
  box.append(idBox);

  box.append(h('效果 buffs（引擎真正读的是它们摊平出来的 params）'));
  const buffBox = document.createElement('div'); buffBox.className = 'panel';
  buffBox.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: 'buff 的 key 是技能/触发器的模板键；bb 是数值黑板，bbStr 是字符串黑板。同名键先出现的先赢。',
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
    bbCol.append(Object.assign(document.createElement('label'), { textContent: 'bb（数值）' }));
    bbCol.append(kvEditor(() => b.bb, (x) => { b.bb = x; }));
    const strCol = document.createElement('div');
    strCol.append(Object.assign(document.createElement('label'), { textContent: 'bbStr（字符串）' }));
    strCol.append(kvEditor(() => b.bbStr, (x) => { b.bbStr = x; }, { asString: true }));
    bbWrap.append(bbCol, strCol);
    card.append(bbWrap);
    buffBox.append(card);
  });
  const addBuff = document.createElement('button'); addBuff.className = 'ghost'; addBuff.textContent = '＋ 加一个 buff';
  addBuff.addEventListener('click', () => { spec.buffs = [...(spec.buffs || []), { key: '', countType: 'NONE', bb: {}, bbStr: {} }]; renderForm(); schedule(); });
  buffBox.append(addBuff);
  box.append(buffBox);

  box.append(h('其余文案与联动'));
  const textBox = document.createElement('div'); textBox.className = 'panel';
  const tGrid = document.createElement('div'); tGrid.className = 'grid wide';
  tGrid.append(
    field('effectId（留空则自动生成 eff_ws_<id>）', textInput(() => spec.effectId, (x) => { spec.effectId = x; })),
    field('effectName（留空则用名称）', textInput(() => spec.effectName, (x) => { spec.effectName = x; })),
    field('requiresBondId（需要哪个羁绊）', textInput(() => spec.requiresBondId, (x) => { spec.requiresBondId = x || null; })),
    field('giveBondId（授予哪个羁绊）', textInput(() => spec.giveBondId, (x) => { spec.giveBondId = x || null; })),
    field('shopExcludedBy（填了就等于商店排除）', textInput(() => spec.shopExcludedBy, (x) => { spec.shopExcludedBy = x || null; })),
    field('family', textInput(() => spec.family, (x) => { spec.family = x || null; })),
  );
  textBox.append(tGrid);
  textBox.append(
    field('note（备注）', textInput(() => spec.note, (x) => { spec.note = x || null; })),
    field('implFormula（实现公式，给人看的）', textInput(() => spec.implFormula, (x) => { spec.implFormula = x || null; })),
    field('flavor（风味文本）', textInput(() => spec.flavor, (x) => { spec.flavor = x || null; })),
  );
  box.append(textBox);

  box.append(h('覆盖范围 rangeGrid'));
  const rgBox = document.createElement('div'); rgBox.className = 'panel';
  rgBox.append(field('rangeGrid（JSON，[[行,列],…]）', areaInput(
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
  box.append(mk('＋ 新建装备', 'item', () => {
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
      + `${it.mergeable ? ' <span class="tag gold">可合成</span>' : ''}</div>`
      + `<div class="m">${it.pack} · ${slug}</div>`
      + `<div class="m">${it.itemType} · ${it.tier ?? '?'} 阶 · ${it.price ?? '?'} 金 · ${it.managed ? '可编辑' : '非编辑器管理'}</div>`;
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

  box.append(h('会写出的两个记录'));
  const idBox = document.createElement('div'); idBox.className = 'panel derived';
  const ids = pairIds(state.spec.id);
  idBox.textContent = ids ? `${ids.base}\n${ids.golden}` : '（先填 id）';
  box.append(idBox);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '一件装备 = 一个 spec = 普通记录 + 精英记录。没有 _b 就不能合成，所以可合成项必须成对写出。',
  }));

  box.append(h('派生量（只读，服务端算）'));
  const dbox = document.createElement('div'); dbox.className = 'panel derived';
  const rec = state.preview?.record;
  dbox.textContent = rec
    ? `params ${JSON.stringify(rec.params)}\nmergeable ${rec.mergeable}\nshopExcluded ${rec.shopExcluded}  (shopExcludedBy ${JSON.stringify(rec.shopExcludedBy)})\nupgradeChessId ${JSON.stringify(rec.upgradeChessId)}`
    : '（改动后自动推导）';
  box.append(dbox);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '引擎读的是 params，不是 buffs。手写 params 只会让卡面说谎，所以它每次都由 buffs 重算。',
  }));

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.margin = '12px 0';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = state.busy ? '保存中…' : '保存';
  save.disabled = state.busy || !state.spec.id;
  save.addEventListener('click', saveItem);
  actions.append(save);
  if (state.id) {
    const del = document.createElement('button'); del.textContent = '删除';
    del.addEventListener('click', deleteItem);
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
  if (state.spec._rangeBad) pv.append(Object.assign(document.createElement('div'), { className: 'err', textContent: 'rangeGrid 不是合法 JSON，暂不校验' }));
  box.append(pv);
}

async function saveItem() {
  if (!state.packId) {
    const id = prompt('保存到哪个工坊包？（id：字母数字下划线短横线）', 'my-item-pack');
    if (!id) return;
    state.packId = id.trim();
  }
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/items`, { method: 'POST', body: { spec: cleanSpec() } });
    state.id = pairIds(r.id)?.slug ?? state.id;
    state.message = { kind: 'ok', text: `已保存 ${r.id}${r.goldenId ? ` + ${r.goldenId}` : ''}，生成 ${r.generated.join(', ')}。` };
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; }
  finally { state.busy = false; renderSide(); }
}

async function deleteItem() {
  if (!state.id || !confirm(`删除装备 ${state.id}（连同它的精英记录）？`)) return;
  const ids = pairIds(state.id);
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/items/${encodeURIComponent(ids ? ids.base : state.id)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: `已删除 ${state.id}` };
    state.id = null; state.spec = null; state.preview = null;
    await load();
  } catch (e) { state.message = { kind: 'error', text: e.message }; renderSide(); }
}

async function load() {
  state.data = await api('/api/items');
  const n = new Set((state.data.items ?? []).map((i) => pairIds(i.id)?.slug ?? i.id)).size;
  $('#rootPath').textContent = n ? `${n} 件工坊装备（${state.data.items.length} 条记录）` : '还没有工坊装备';
  if (!state.packId) state.packId = state.data.items[0]?.pack ?? null;
  renderList();
  if (!state.spec) renderForm();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', () => { state.id = null; state.spec = blankSpec(); state.preview = null; renderList(); renderForm(); renderSide(); schedule(true); });

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: `载入失败：${e.message}` })); });
