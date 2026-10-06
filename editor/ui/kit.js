// editor/ui/kit.js — the behaviour-layer (行为层 kit) editor page (docs/EDITOR.md). Plain DOM, no build step, no bundler.
//
// Unlike the other four pages this one is not a form. A kit is the only content kind that is CODE: there is no spec to
// derive a record from, so the textarea holds the WHOLE file — the notice header included — and the page's job is to
// (a) keep the text in sync with the file and (b) answer with the validation that can be answered without running it.
//
// Everything the right-hand panel says comes from /api/kits/preview, which is STATIC ONLY (shared/kitAuthoring.js): it
// parses the text and never imports it. The real "does this module load, and does it default-export a function" check
// lives in tools/workshop-validate.mjs, off the request path — an endpoint that imports posted text is a code-execution
// surface, and this page must not become one by accident.
//
// The `// @forge …` file header is written by the SERVER on save, never here: the page has to be able to send exactly
// the bytes the author sees, and a second stamp implementation would be one more thing to keep in sync.

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = { data: null, packId: null, id: null, source: null, onDisk: false, preview: null, message: null, busy: false };

/** What the pack's own data says a kit in it may target (the loader's rule, reported by /api/kits). */
const currentPack = () => (state.data?.packs ?? []).find((p) => p.id === state.packId) ?? null;

/** 新建 kit 的骨架：三条硬规则就是注释里的那三行，作者不必去别处找。 */
const blankSource = () => [
  '// 行为层 kit（<pack>/kits/<chessId>.js）。三条硬规则都会在游戏里**静默**失败：',
  '//  1. 返回了 kit 就必须自己给出 skill —— 引擎用 `u.kit.skill || null` 取技能，缺省技能不会回退到通用 kit。',
  '//  2. 必须自包含，不能 import —— 同一份文件服务端按真实路径、浏览器按 URL 各加载一次，相对路径不可能同时对。',
  '//  3. 它会跑在玩家浏览器里，服务端用同一份文件复算这场战斗 —— 随机请用 battle.rng，不要碰 DOM / 网络 / 墙钟时间。',
  '',
  'export default function kit(bb, chess, def) {',
  '  return {',
  '    // 例：8 发弹药、攻击力 +60% 的射手技能（也可以整段省略，但那样这名干员就没有技能）',
  '    skill: { kind: \'ammo\', ammo: 8, mods: { atkPct: bb.atk || 0 } },',
  '    talents: [],',
  '  };',
  '}',
  '',
].join('\n');

// ---- list -------------------------------------------------------------------------------------------------------

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const mk = (text, cls, onClick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; d.addEventListener('click', onClick); return d; };
  box.append(mk('＋ 新建 kit', 'item', newKit));
  for (const kit of state.data?.kits ?? []) {
    const errs = (kit.issues ?? []).filter((i) => i.severity === 'error').length;
    const warns = (kit.issues ?? []).filter((i) => i.severity === 'warning').length;
    const on = kit.id === state.id && kit.pack === state.packId;
    const el = document.createElement('div');
    el.className = `item${on ? ' on' : ''}`;
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = kit.id;
    if (errs) n.append(Object.assign(document.createElement('span'), { className: 'tag err', textContent: ` ${errs} 错误` }));
    else if (warns) n.append(Object.assign(document.createElement('span'), { className: 'tag warn', textContent: ` ${warns} 警告` }));
    if (!kit.hasNotice) n.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: ' 无署名头' }));
    const m1 = document.createElement('div'); m1.className = 'm';
    m1.textContent = `${kit.pack} · ${kit.bytes} 字节 · ${kit.hooks?.length ? `钩子 ${kit.hooks.join(', ')}` : '无钩子'}`;
    const m2 = document.createElement('div'); m2.className = 'm';
    m2.textContent = kit.managed ? '可编辑（文件即源）' : '非编辑器管理';
    el.append(n, m1, m2);
    el.addEventListener('click', () => openKit(kit.pack, kit.id));
    box.append(el);
  }
  if (!(state.data?.kits ?? []).length) {
    box.append(Object.assign(document.createElement('div'), { className: 'item', style: 'cursor:default', textContent: '（还没有 kit：点「＋ 新建 kit」）' }));
  }
}

// ---- the editor (pack + id + the file itself) ---------------------------------------------------------------------

function renderEditor() {
  const box = $('#editor');
  box.replaceChildren();
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  if (state.source == null) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '左边选一个 kit，或点「新建 kit」。' }));
    box.append(h('这个页面编辑什么'));
    box.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: 'kit 是包里的 JavaScript（<pack>/kits/<干员 id>.js），不是数据表：默认导出的函数就是模拟器调用的 kit 实现。'
        + '它既是可编辑的源、也是游戏真正加载的产物，所以这里编辑的是文件本体（左栏没有「非编辑器管理」的记录可区分）。',
    }));
    return;
  }
  const packs = state.data?.packs ?? [];

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginBottom = '10px';

  const packWrap = document.createElement('div');
  packWrap.style.minWidth = '220px';
  packWrap.append(Object.assign(document.createElement('label'), { textContent: '工坊包' }));
  const packSel = document.createElement('select');
  for (const p of packs) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = `${p.name}（${p.id}）`;
    packSel.append(o);
  }
  if (state.packId && !packs.some((p) => p.id === state.packId)) {
    const o = document.createElement('option'); o.value = state.packId; o.textContent = state.packId; packSel.append(o);
  }
  const other = document.createElement('option'); other.value = ''; other.textContent = '＋ 新建 / 其它工坊包…';
  packSel.append(other);
  packSel.value = state.packId ?? '';
  packSel.addEventListener('change', () => {
    // the legal-id list is per pack, so the row is rebuilt (the textarea is rebuilt from `state.source`, so no edit is lost)
    if (packSel.value) { state.packId = packSel.value; renderEditor(); renderSide(); schedule(true); return; }
    const typed = prompt('工坊包 id（字母数字下划线短横线，≤32）：', state.packId ?? 'my-kit-pack');
    if (!typed || !typed.trim()) { packSel.value = state.packId ?? ''; return; }
    state.packId = typed.trim();
    renderEditor(); renderSide(); schedule(true);
  });
  packWrap.append(packSel);

  const idWrap = document.createElement('div');
  idWrap.style.minWidth = '280px';
  idWrap.append(Object.assign(document.createElement('label'), { textContent: 'kit id（= 它服务的干员 id，文件名就是它）' }));
  const idInput = document.createElement('input');
  idInput.id = 'kitId';
  idInput.value = state.id ?? '';
  idInput.placeholder = 'chess_ws_xxx_a';
  idInput.setAttribute('list', 'kitIdChoices');
  idInput.addEventListener('input', () => { state.id = idInput.value.trim(); renderSide(); schedule(); });
  const dl = document.createElement('datalist'); dl.id = 'kitIdChoices';
  for (const id of currentPack()?.legalIds ?? []) {
    const o = document.createElement('option'); o.value = id; dl.append(o);
  }
  idWrap.append(idInput, dl);

  row.append(packWrap, idWrap);
  box.append(row);
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '文件内容（整份文件，含开头的署名注释）：保存时服务端只在缺少署名头时补写，已有的一行只更新 modified —— created 永远保留。',
  }));

  const ta = document.createElement('textarea');
  ta.id = 'src';
  ta.spellcheck = false;
  ta.value = state.source;
  ta.addEventListener('input', () => { state.source = ta.value; schedule(); });
  box.append(ta);
}

// ---- preview (debounced, static only) -----------------------------------------------------------------------------

let timer = null;
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(preview, now ? 0 : 350);
}
async function preview() {
  if (state.source == null) return;
  try {
    state.preview = await api('/api/kits/preview', { method: 'POST', body: { pack: state.packId, id: state.id, source: state.source } });
  } catch (e) {
    state.preview = { ok: false, errors: [{ field: '', code: 'REQUEST', message: e.message }], warnings: [], hooks: [], notice: null };
  }
  renderSide();
}

// ---- side --------------------------------------------------------------------------------------------------------

/** One issue as `field [CODE] message — hint`, the same readout the CLI gives. */
function issueLine(issue, cls) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = `${issue.field || '(源文件)'} [${issue.code}] ${issue.message}${issue.hint ? ` — ${issue.hint}` : ''}`;
  return d;
}

function renderSide() {
  const box = $('#side');
  box.replaceChildren();
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  const hint = (t) => Object.assign(document.createElement('p'), { className: 'hint', textContent: t });
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }

  if (state.source != null) {
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.style.margin = '10px 0';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = state.busy ? '保存中…' : '保存';
    save.disabled = state.busy || !state.id;
    save.addEventListener('click', saveKit);
    actions.append(save);
    if (state.onDisk) {
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', deleteKit);
      actions.append(del);
    }
    box.append(actions);
    if (!state.id) box.append(hint('先填 id：kit 的文件名必须正好是一个这个包提供的干员 id。'));
  }

  box.append(h('静态校验（编辑器不会运行你的文件）'));
  const pv = document.createElement('div');
  pv.className = 'panel';
  if (state.source == null) pv.append(hint('（左边选一个 kit）'));
  else if (!state.preview) pv.append(hint('（改动后自动校验）'));
  else {
    const errors = state.preview.errors ?? [];
    const warnings = state.preview.warnings ?? [];
    if (!errors.length && !warnings.length) pv.append(Object.assign(document.createElement('div'), { className: 'ok', textContent: '✔ 静态校验通过' }));
    else pv.append(Object.assign(document.createElement('div'), { textContent: `错误 ${errors.length} · 警告 ${warnings.length}` }));
    for (const e of errors) pv.append(issueLine(e, 'err'));
    for (const w of warnings) pv.append(issueLine(w, 'warn'));
  }
  box.append(pv);
  box.append(hint('静态校验只读文本：不 import、不执行。真正导入一遍（能否加载、有没有默认导出）由 node tools/workshop-validate.mjs 做。'));

  box.append(h('注册的钩子'));
  const hb = document.createElement('div');
  const hooks = state.preview?.hooks ?? [];
  if (hooks.length) {
    hb.className = 'panel derived';
    hb.textContent = hooks.join('\n');
  } else {
    hb.className = 'panel';
    hb.append(hint('（没有注册任何钩子）'));
  }
  box.append(hb);
  box.append(hint('钩子名必须是引擎真正会 emit 的名字：battle.on() 接受任意字符串，写错不会报错，也永远不会触发。'));

  box.append(h('文件头（署名）'));
  const nb = document.createElement('div');
  const notice = state.preview?.notice ?? null;
  if (notice) {
    nb.className = 'panel derived';
    nb.textContent = `${notice.author ?? '（未署名）'}\n创建 ${String(notice.created ?? '').slice(0, 10) || '?'} · 最近修改 ${String(notice.modified ?? '').slice(0, 10) || '?'}\n${notice.source ?? ''}`;
  } else {
    nb.className = 'panel';
    nb.append(hint('这个文件还没有 Forge 署名头：保存时会写在文件开头（作者 / 创建时间 / 修改时间 / 来源 / 著作权与反打包转售声明），'
      + 'created 之后每次保存都不会被重置。'));
  }
  box.append(nb);

  box.append(h('这个包可以用的 kit id'));
  const lb = document.createElement('div');
  lb.className = 'panel';
  const pack = currentPack();
  const legal = pack?.legalIds ?? [];
  if (!pack) lb.append(hint('（先在中间选一个工坊包）'));
  else if (!legal.length) lb.append(hint('这个包还没有干员：先在这个包里保存一个干员（或在 pack.json 的 overrides 里声明 chess:<id>），否则这个 kit 不会被加载。'));
  else {
    for (const id of legal) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = id;
      chip.addEventListener('click', () => {
        state.id = id;
        const input = $('#kitId');
        if (input) input.value = id;
        renderSide(); schedule(true);
      });
      lb.append(chip);
    }
  }
  if (pack?.overrides?.length) lb.append(hint(`这个包的 overrides：${pack.overrides.join('、')}`));
  box.append(lb);
  lb.append(hint('文件名必须正好是这些 id 之一（或 overrides 声明的 chess:<id>）：对不上号的 kit 永远不会被使用。'));

  box.append(h('三条硬规则'));
  const rb = document.createElement('div');
  rb.className = 'panel';
  const rules = document.createElement('ol');
  rules.className = 'rules';
  for (const t of [
    '返回了 kit 就必须自己给出 skill —— 引擎用 `u.kit.skill || null` 取技能，缺省技能不会回退到通用 kit。',
    '必须自包含，不能 import —— 同一份文件服务端按真实路径、浏览器按 URL 各加载一次，相对路径不可能同时对。',
    '它会跑在玩家浏览器里，服务端用同一份文件复算这场战斗 —— 随机用 battle.rng，不要碰 DOM / 网络 / 墙钟时间。',
  ]) {
    const li = document.createElement('li');
    li.textContent = t;
    rules.append(li);
  }
  rb.append(rules);
  rb.append(hint('另外：kit 所在的包必须贡献至少一个数据文件（例如 chess）—— 空包不会被加载，它的 kit 也就不会被导入。'));
  const doc = document.createElement('p');
  doc.className = 'hint';
  const a = document.createElement('a');
  a.href = '/docs/prompts/README.md';
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = 'docs/prompts/README.md';
  doc.append(document.createTextNode('完整写法、词表与自检闭环：'), a);
  rb.append(doc);

  const events = state.data?.vocab?.events ?? [];
  const ev = document.createElement('details');
  ev.append(Object.assign(document.createElement('summary'), { textContent: `引擎会 emit 的事件名（${events.length} 个，可钩）` }));
  ev.append(Object.assign(document.createElement('div'), { className: 'derived', textContent: events.join('  ') }));
  rb.append(ev);
  const forbidden = state.data?.vocab?.forbidden ?? [];
  const fb = document.createElement('details');
  fb.append(Object.assign(document.createElement('summary'), { textContent: `禁用词（会静默破坏复算的 ${forbidden.length} 项）` }));
  fb.append(Object.assign(document.createElement('div'), { className: 'derived', textContent: forbidden.map(([name, why]) => `${name} — ${why}`).join('\n') }));
  rb.append(fb);
  box.append(rb);
}

// ---- actions -----------------------------------------------------------------------------------------------------

function newKit() {
  state.id = null;
  state.packId = state.packId ?? state.data?.packs?.[0]?.id ?? null;
  state.source = blankSource();
  state.onDisk = false;
  state.preview = null;
  state.message = null;
  renderList(); renderEditor(); renderSide(); schedule(true);
}

async function openKit(packId, id) {
  state.packId = packId;
  state.id = id;
  state.message = null;
  try {
    const r = await api(`/api/kits/${encodeURIComponent(packId)}/${encodeURIComponent(id)}`);
    state.source = r.source ?? blankSource();
    state.onDisk = r.source != null;
    state.preview = null;
    renderList(); renderEditor(); renderSide(); schedule(true);
  } catch (err) {
    state.message = { kind: 'error', text: err.message };
    renderSide();
  }
}

async function saveKit() {
  if (!state.packId) {
    const id = prompt('保存到哪个工坊包？（id：字母数字下划线短横线）', 'my-kit-pack');
    if (!id) return;
    state.packId = id.trim();
  }
  if (!state.id) { state.message = { kind: 'error', text: '先填 id：kit 的文件名就是它服务的干员 id。' }; renderSide(); return; }
  state.busy = true;
  renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/kits`, { method: 'POST', body: { id: state.id, source: state.source } });
    const warned = (r.warnings ?? []).length;
    await load();
    await openKit(state.packId, state.id);
    state.message = { kind: 'ok', text: `已保存 ${state.packId}/kits/${r.id}.js${warned ? `（${warned} 条警告）` : ''}。` };
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
  } finally {
    state.busy = false;
    renderSide();
  }
}

async function deleteKit() {
  if (!state.id || !confirm(`删除 ${state.packId}/kits/${state.id}.js？`)) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/kits/${encodeURIComponent(state.id)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', text: `已删除 ${state.id}` };
    state.id = null; state.source = null; state.onDisk = false; state.preview = null;
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
    renderSide();
  }
}

async function load() {
  state.data = await api('/api/kits');
  const kits = state.data.kits ?? [];
  const packs = state.data.packs ?? [];
  $('#rootPath').textContent = kits.length
    ? `${kits.length} 个 kit（${packs.length} 个工坊包）`
    : (packs.length ? `${packs.length} 个工坊包，还没有 kit` : '还没有工坊包');
  if (!state.packId) state.packId = packs[0]?.id ?? null;
  renderList();
  if (state.source == null) renderEditor();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', text: e.message }; renderSide(); }));
$('#btnNew').addEventListener('click', newKit);

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: `载入失败：${e.message}` })); });
