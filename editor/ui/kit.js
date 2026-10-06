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

// 界面文案的双语入口。**这一页不许出现 `import`**（test/kitEditor.test.js 钉着这条安全属性：本页直接编辑并展示
// 作者写的 kit 源码），所以接口由 kit.html 先加载的 ./i18n.global.js 挂到 globalThis.spI18n 上，这里只取用。
const { t, mountI18n } = globalThis.spI18n;

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
  box.append(mk(t('＋ 新建 kit'), 'item', newKit));
  for (const kit of state.data?.kits ?? []) {
    const errs = (kit.issues ?? []).filter((i) => i.severity === 'error').length;
    const warns = (kit.issues ?? []).filter((i) => i.severity === 'warning').length;
    const on = kit.id === state.id && kit.pack === state.packId;
    const el = document.createElement('div');
    el.className = `item${on ? ' on' : ''}`;
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = kit.id;
    if (errs) n.append(Object.assign(document.createElement('span'), { className: 'tag err', textContent: ` ${t('{0} 错误', errs)}` }));
    else if (warns) n.append(Object.assign(document.createElement('span'), { className: 'tag warn', textContent: ` ${t('{0} 警告', warns)}` }));
    if (!kit.hasNotice) n.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: ` ${t('无署名头')}` }));
    const m1 = document.createElement('div'); m1.className = 'm';
    m1.textContent = t('{0} · {1} 字节 · {2}', kit.pack, kit.bytes, kit.hooks?.length ? t('钩子 {0}', kit.hooks.join(', ')) : t('无钩子'));
    const m2 = document.createElement('div'); m2.className = 'm';
    m2.textContent = kit.managed ? t('可编辑（文件即源）') : t('非编辑器管理');
    el.append(n, m1, m2);
    el.addEventListener('click', () => openKit(kit.pack, kit.id));
    box.append(el);
  }
  if (!(state.data?.kits ?? []).length) {
    box.append(Object.assign(document.createElement('div'), { className: 'item', style: 'cursor:default', textContent: t('（还没有 kit：点「＋ 新建 kit」）') }));
  }
}

// ---- the editor (pack + id + the file itself) ---------------------------------------------------------------------

function renderEditor() {
  const box = $('#editor');
  box.replaceChildren();
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  if (state.source == null) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一个 kit，或点「新建 kit」。') }));
    box.append(h(t('这个页面编辑什么')));
    box.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: t('kit 是包里的 JavaScript（<pack>/kits/<干员 id>.js），不是数据表：默认导出的函数就是模拟器调用的 kit 实现。')
        + t('它既是可编辑的源、也是游戏真正加载的产物，所以这里编辑的是文件本体（左栏没有「非编辑器管理」的记录可区分）。'),
    }));
    return;
  }
  const packs = state.data?.packs ?? [];

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginBottom = '10px';

  const packWrap = document.createElement('div');
  packWrap.style.minWidth = '220px';
  packWrap.append(Object.assign(document.createElement('label'), { textContent: t('工坊包') }));
  const packSel = document.createElement('select');
  for (const p of packs) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = `${p.name}（${p.id}）`;
    packSel.append(o);
  }
  if (state.packId && !packs.some((p) => p.id === state.packId)) {
    const o = document.createElement('option'); o.value = state.packId; o.textContent = state.packId; packSel.append(o);
  }
  const other = document.createElement('option'); other.value = ''; other.textContent = t('＋ 新建 / 其它工坊包…');
  packSel.append(other);
  packSel.value = state.packId ?? '';
  packSel.addEventListener('change', () => {
    // the legal-id list is per pack, so the row is rebuilt (the textarea is rebuilt from `state.source`, so no edit is lost)
    if (packSel.value) { state.packId = packSel.value; renderEditor(); renderSide(); schedule(true); return; }
    const typed = prompt(t('工坊包 id（字母数字下划线短横线，≤32）：'), state.packId ?? 'my-kit-pack');
    if (!typed || !typed.trim()) { packSel.value = state.packId ?? ''; return; }
    state.packId = typed.trim();
    renderEditor(); renderSide(); schedule(true);
  });
  packWrap.append(packSel);

  const idWrap = document.createElement('div');
  idWrap.style.minWidth = '280px';
  idWrap.append(Object.assign(document.createElement('label'), { textContent: t('kit id（= 它服务的干员 id，文件名就是它）') }));
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
    textContent: t('文件内容（整份文件，含开头的署名注释）：保存时服务端只在缺少署名头时补写，已有的一行只更新 modified —— created 永远保留。'),
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

/**
 * 结果横幅的文字。存进 `state.message` 的是「原文 + 参数」而不是译好的字符串：换语言后重画一次就该跟着换，
 * 译一次存下来会永远停在旧语言。`key` 是中文原文（词典的键）；`raw: true` 的那条是服务端随 `data.error`
 * 回传的报错，它不经过词典 —— 那本来就是给人读的句子，再包一层只会把变量名当文案翻译。
 * @param {{key: string, raw?: boolean, args?: any[]}} m
 */
function messageText(m) {
  return m.raw ? String(m.key) : t(m.key, ...(m.args ?? []));
}

/** One issue as `field [CODE] message — hint`, the same readout the CLI gives. */
function issueLine(issue, cls) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = `${issue.field || t('(源文件)')} [${issue.code}] ${issue.message}${issue.hint ? ` — ${issue.hint}` : ''}`;
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
    // 存的是「原文 + 参数」而不是译好的字符串：换语言后重画一次就该跟着换，译一次存下来会永远停在旧语言。
    b.textContent = messageText(state.message);
    box.append(b);
  }

  if (state.source != null) {
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.style.margin = '10px 0';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = state.busy ? t('保存中…') : t('保存');
    save.disabled = state.busy || !state.id;
    save.addEventListener('click', saveKit);
    actions.append(save);
    if (state.onDisk) {
      const del = document.createElement('button');
      del.textContent = t('删除');
      del.addEventListener('click', deleteKit);
      actions.append(del);
    }
    box.append(actions);
    if (!state.id) box.append(hint(t('先填 id：kit 的文件名必须正好是一个这个包提供的干员 id。')));
  }

  box.append(h(t('静态校验（编辑器不会运行你的文件）')));
  const pv = document.createElement('div');
  pv.className = 'panel';
  if (state.source == null) pv.append(hint(t('（左边选一个 kit）')));
  else if (!state.preview) pv.append(hint(t('（改动后自动校验）')));
  else {
    const errors = state.preview.errors ?? [];
    const warnings = state.preview.warnings ?? [];
    if (!errors.length && !warnings.length) pv.append(Object.assign(document.createElement('div'), { className: 'ok', textContent: t('✔ 静态校验通过') }));
    else pv.append(Object.assign(document.createElement('div'), { textContent: t('错误 {0} · 警告 {1}', errors.length, warnings.length) }));
    for (const e of errors) pv.append(issueLine(e, 'err'));
    for (const w of warnings) pv.append(issueLine(w, 'warn'));
  }
  box.append(pv);
  box.append(hint(t('静态校验只读文本：不 import、不执行。真正导入一遍（能否加载、有没有默认导出）由 node tools/workshop-validate.mjs 做。')));

  box.append(h(t('注册的钩子')));
  const hb = document.createElement('div');
  const hooks = state.preview?.hooks ?? [];
  if (hooks.length) {
    hb.className = 'panel derived';
    hb.textContent = hooks.join('\n');
  } else {
    hb.className = 'panel';
    hb.append(hint(t('（没有注册任何钩子）')));
  }
  box.append(hb);
  box.append(hint(t('钩子名必须是引擎真正会 emit 的名字：battle.on() 接受任意字符串，写错不会报错，也永远不会触发。')));

  box.append(h(t('文件头（署名）')));
  const nb = document.createElement('div');
  const notice = state.preview?.notice ?? null;
  if (notice) {
    nb.className = 'panel derived';
    const [author, dates] = [notice.author ?? t('（未署名）'), t('创建 {0} · 最近修改 {1}', String(notice.created ?? '').slice(0, 10) || '?', String(notice.modified ?? '').slice(0, 10) || '?')];
    nb.textContent = `${author}\n${dates}\n${notice.source ?? ''}`;
  } else {
    nb.className = 'panel';
    nb.append(hint(t('这个文件还没有 Forge 署名头：保存时会写在文件开头（作者 / 创建时间 / 修改时间 / 来源 / 著作权与反打包转售声明），')
      + t('created 之后每次保存都不会被重置。')));
  }
  box.append(nb);

  box.append(h(t('这个包可以用的 kit id')));
  const lb = document.createElement('div');
  lb.className = 'panel';
  const pack = currentPack();
  const legal = pack?.legalIds ?? [];
  if (!pack) lb.append(hint(t('（先在中间选一个工坊包）')));
  else if (!legal.length) lb.append(hint(t('这个包还没有干员：先在这个包里保存一个干员（或在 pack.json 的 overrides 里声明 chess:<id>），否则这个 kit 不会被加载。')));
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
  if (pack?.overrides?.length) lb.append(hint(t('这个包的 overrides：{0}', pack.overrides.join('、'))));
  box.append(lb);
  lb.append(hint(t('文件名必须正好是这些 id 之一（或 overrides 声明的 chess:<id>）：对不上号的 kit 永远不会被使用。')));

  box.append(h(t('三条硬规则')));
  const rb = document.createElement('div');
  rb.className = 'panel';
  const rules = document.createElement('ol');
  rules.className = 'rules';
  for (const t of [
    t('返回了 kit 就必须自己给出 skill —— 引擎用 `u.kit.skill || null` 取技能，缺省技能不会回退到通用 kit。'),
    t('必须自包含，不能 import —— 同一份文件服务端按真实路径、浏览器按 URL 各加载一次，相对路径不可能同时对。'),
    t('它会跑在玩家浏览器里，服务端用同一份文件复算这场战斗 —— 随机用 battle.rng，不要碰 DOM / 网络 / 墙钟时间。'),
  ]) {
    const li = document.createElement('li');
    li.textContent = t;
    rules.append(li);
  }
  rb.append(rules);
  rb.append(hint(t('另外：kit 所在的包必须贡献至少一个数据文件（例如 chess）—— 空包不会被加载，它的 kit 也就不会被导入。')));
  const doc = document.createElement('p');
  doc.className = 'hint';
  const a = document.createElement('a');
  a.href = '/docs/prompts/README.md';
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = 'docs/prompts/README.md';
  doc.append(document.createTextNode(t('完整写法、词表与自检闭环：')), a);
  rb.append(doc);

  const events = state.data?.vocab?.events ?? [];
  const ev = document.createElement('details');
  ev.append(Object.assign(document.createElement('summary'), { textContent: t('引擎会 emit 的事件名（{0} 个，可钩）', events.length) }));
  ev.append(Object.assign(document.createElement('div'), { className: 'derived', textContent: events.join('  ') }));
  rb.append(ev);
  const forbidden = state.data?.vocab?.forbidden ?? [];
  const fb = document.createElement('details');
  fb.append(Object.assign(document.createElement('summary'), { textContent: t('禁用词（会静默破坏复算的 {0} 项）', forbidden.length) }));
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
    state.message = { kind: 'error', key: err.message, raw: true };
    renderSide();
  }
}

async function saveKit() {
  if (!state.packId) {
    // 这一页本就有「保存到哪个包」的下拉（编辑器里第一处，后来才推广到其它页），所以这里只提示、不再弹对话框
    state.message = { kind: 'error', key: '先在右边选一个工坊包（或点「＋ 新建一个包…」）。' };
    renderSide();
    return;
  }
  if (!state.id) { state.message = { kind: 'error', key: '先填 id：kit 的文件名就是它服务的干员 id。' }; renderSide(); return; }
  state.busy = true;
  renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/kits`, { method: 'POST', body: { id: state.id, source: state.source } });
    const warned = (r.warnings ?? []).length;
    await load();
    await openKit(state.packId, state.id);
    if (warned) state.message = { kind: 'ok', key: t('已保存 {0}/kits/{1}.js（{2} 条警告）。', state.packId, r.id, warned) };
    else state.message = { kind: 'ok', key: t('已保存 {0}/kits/{1}.js。', state.packId, r.id) };
  } catch (e) {
    state.message = { kind: 'error', key: e.message, raw: true };
  } finally {
    state.busy = false;
    renderSide();
  }
}

async function deleteKit() {
  const id = state.id ?? '';
  if (!id || !confirm(t('删除 {0}/kits/{1}.js？', state.packId, id))) return;
  try {
    await api(`/api/packs/${encodeURIComponent(state.packId)}/kits/${encodeURIComponent(state.id)}`, { method: 'DELETE' });
    state.message = { kind: 'ok', key: t('已删除 {0}', id) };
    state.id = null; state.source = null; state.onDisk = false; state.preview = null;
    await load();
  } catch (e) {
    state.message = { kind: 'error', key: e.message, raw: true };
    renderSide();
  }
}

async function load() {
  state.data = await api('/api/kits');
  const kits = state.data.kits ?? [];
  const packs = state.data.packs ?? [];
  $('#rootPath').textContent = kits.length
    ? t('{0} 个 kit（{1} 个工坊包）', kits.length, packs.length)
    : packs.length
      ? t('{0} 个工坊包，还没有 kit', packs.length)
      : t('还没有工坊包');
  if (!state.packId) state.packId = packs[0]?.id ?? null;
  renderList();
  if (state.source == null) renderEditor();
  renderSide();
}

$('#btnReload').addEventListener('click', () => load().catch((e) => { state.message = { kind: 'error', key: e.message, raw: true }; renderSide(); }));
$('#btnNew').addEventListener('click', newKit);

// 页面底部（初始 load 之前）挂一次：静态文案 + 右上角语言切换 + 换语言后重画（这一页的文案几乎都在 JS 里生成，
// 所以重画函数要能把列表、编辑器与右栏一起重来一遍）。
mountI18n(() => { renderList(); renderEditor(); renderSide(); });

load().catch((e) => { $('#side').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: t('载入失败：{0}', e.message) })); });
