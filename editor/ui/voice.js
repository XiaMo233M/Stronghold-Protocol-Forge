// editor/ui/voice.js — the 语音 (voice lines) editor page (docs/EDITOR.md). Plain DOM, no build step, no game-client import.
//
// This page owns no file of its own: `voices` is a FIELD of `pack.json`
// (`{ <干员id>: { <槽位>: ["<assets/ 内的相对路径>", …] } }`), and the manifest IS the artifact — shared/workshop.js merges
// it into `assets.audio.voice` when the game loads, so there is no spec to fill in and nothing to derive. The page shows
// what the pack declares, what is really on disk under the pack's `assets/`, and writes back through the two routes
// (POST sets ONE slot, DELETE removes one).
//
// Everything that would otherwise be a second copy of a server rule comes from /api/voices: the slot vocabulary
// (VOICE_SLOTS in shared/constants.js), the extension allowlist (WORKSHOP_ASSET_TYPES in server/index.js) and the preview
// URL prefix. A page-local list would drift — and a drifted list means a line that saves here and never plays in the game.
//
// 界面文案走 i18n.js 的 t()（键就是中文原文，词条在 i18n.en.voice.js）。**数据不翻**：干员 id 与文件名、路径、
// 扩展名、枚举值（start/select/…）与错误码，这些会写进用户的 pack.json，翻了就写错了。

import { t, mountI18n } from './i18n.js';

const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * The slot's Chinese name, translated at paint time so it follows the language switch.
 * Presentation only — the LIST of slots always comes from the server, and the enum value itself is data (never translated).
 */
function slotLabelText(slot) {
  switch (slot) {
    case 'start': return t('行动开始（行动出发）');
    case 'select': return t('选中干员');
    case 'deploy': return t('部署');
    case 'battle': return t('作战中');
    case 'win': return t('胜利结算');
    case 'lose': return t('失败结算');
    default: return '';
  }
}
const slotLabel = (s) => { const n = slotLabelText(s); return n ? `${s} — ${n}` : s; };

const state = { data: null, packId: null, charId: '', slot: '', file: '', message: null, busy: false };

/** One shared player: 试听 is a click on a line, so a second click replaces whatever was playing. */
const player = new Audio();

const packOf = (id = state.packId) => (state.data?.packs ?? []).find((p) => p.id === id) ?? null;
/** The URLs in this page are the game client's own: /workshop-assets/<pack>/<assets/ 内的路径>, each segment encoded. */
const mediaUrl = (packId, p) => `${state.data.mediaPrefix}${packId}/${String(p).split('/').map(encodeURIComponent).join('/')}`;
/** The declared lines of one slot, as an array — the exact list a save has to send back (POST sets the whole slot). */
const slotLines = (charId, slot) => (packOf()?.voices?.[charId]?.[slot] ?? []).slice();
const fileInfo = (p) => (packOf()?.files ?? []).find((f) => f.path === p) ?? null;

function setMessage(kind, text) {
  state.message = { kind, text };
  renderSide();
}

function playLine(path) {
  const url = mediaUrl(state.packId, path);
  player.src = url;
  player.play().catch((e) => setMessage('error', t('试听失败：{0}（{1}）', url, e.message)));
}

// ---- 左栏：包 -----------------------------------------------------------------------------------------------------

function renderPackList() {
  const box = $('#packList');
  box.replaceChildren();
  const packs = state.data?.packs ?? [];
  if (!packs.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'item dim', textContent: t('还没有工坊包（先用干员编辑器建一个）') }));
    return;
  }
  for (const p of packs) {
    const n = Object.values(p.voices ?? {}).reduce((a, slots) => a + Object.values(slots).reduce((b, l) => b + l.length, 0), 0);
    const el = document.createElement('div');
    el.className = `item${p.id === state.packId ? ' on' : ''}`;
    el.innerHTML = `<div class="n">${p.name}</div>`
      + `<div class="m">${p.id} · ${p.hasAssets ? t('{0} 条语音', n) : t('{0} 条语音 · 没有 assets/', n)}</div>`
      + `<div class="m">${p.ok ? `<span class="tag ok">${t('清单可加载')}</span>` : `<span class="tag err">${p.issue?.code ?? 'BAD_MANIFEST'}</span>`}`
      + `${p.hasAssets && !p.license ? ` <span class="tag err">${t('缺 license')}</span>` : ''}</div>`;
    el.addEventListener('click', () => {
      state.packId = p.id;
      state.message = null;
      renderAll();
    });
    box.append(el);
  }
}

// ---- 中栏：这个包已经配了哪些语音 ---------------------------------------------------------------------------------

function renderLines() {
  const box = $('#lines');
  box.replaceChildren();
  const h = (text) => { const e = document.createElement('h2'); e.textContent = text; return e; };
  const p = packOf();
  if (!p) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一个工坊包，或先用干员编辑器建一个。') }));
    return;
  }
  box.append(h(t('「{0}」的语音', p.name)));

  if (!p.hasAssets) {
    const b = document.createElement('div');
    b.className = 'banner bad';
    b.textContent = t('这个包还没有 assets/ 文件夹，所以还不能写 voices：先建 workshop/{0}/assets/ 并把音频文件放进去。', p.id);
    box.append(b);
  }
  if (!p.license && p.hasAssets) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'banner bad',
      textContent: t('有 assets/ 就必须在 pack.json 里声明 license，否则整个包会被加载器拒绝（ASSETS_NEED_LICENSE）。'),
    }));
  }
  if (p.issue) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'banner bad',
      textContent: t('pack.json 现在会被加载器拒绝：[{0}] {1}', p.issue.code, p.issue.detail),
    }));
  }

  const charIds = Object.keys(p.voices ?? {});
  if (!charIds.length) {
    box.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: t('这个包还没有语音。右边选干员、槽位和文件，就能加一条。'),
    }));
  }
  const known = new Set((state.data.operators ?? []).map((o) => o.id));
  for (const charId of charIds) {
    const card = document.createElement('div'); card.className = 'card';
    const head = document.createElement('div'); head.className = 'head';
    head.append(Object.assign(document.createElement('span'), { className: 'who', textContent: charId }));
    if (!known.has(charId)) {
      head.append(Object.assign(document.createElement('span'), { className: 'tag warn', textContent: t('不是已知干员 id') }));
    }
    card.append(head);
    for (const [slot, lines] of Object.entries(p.voices[charId])) {
      const s = document.createElement('div'); s.className = 'slot';
      const sh = document.createElement('div'); sh.className = 'slothead';
      const bad = !(state.data.slots ?? []).includes(slot);
      sh.append(Object.assign(document.createElement('span'), { className: `slotname${bad ? ' err' : ''}`, textContent: slotLabel(slot) }));
      sh.append(Object.assign(document.createElement('span'), { className: 'dim', textContent: t('{0} 条', lines.length) }));
      if (bad) sh.append(Object.assign(document.createElement('span'), { className: 'tag err', textContent: t('不是合法槽位') }));
      const clear = document.createElement('button'); clear.className = 'ghost tiny'; clear.textContent = t('清空本槽位');
      // an unknown slot cannot be addressed by either route (both refuse a non-VOICE_SLOTS slot), so the only honest
      // thing to do is say so instead of offering a button that must fail
      clear.disabled = bad;
      if (bad) clear.title = t('这个槽位不在 VOICE_SLOTS 里，只能手工改 pack.json');
      clear.addEventListener('click', () => clearSlot(charId, slot));
      sh.append(clear);
      s.append(sh);
      for (const line of lines) {
        const info = fileInfo(line);
        const row = document.createElement('div'); row.className = 'line';
        const code = document.createElement('code'); code.textContent = line;
        const tags = document.createElement('span');
        if (!info) tags.append(Object.assign(document.createElement('span'), { className: 'tag err', textContent: t('文件不存在') }));
        else {
          if (!info.serveable) tags.append(Object.assign(document.createElement('span'), { className: 'tag err', textContent: t('类型不允许') }));
          else if (!info.audio) tags.append(Object.assign(document.createElement('span'), { className: 'tag warn', textContent: t('不是音频') }));
        }
        const actions = document.createElement('span'); actions.className = 'row';
        const play = document.createElement('button'); play.className = 'ghost tiny'; play.textContent = t('试听');
        play.disabled = !info?.audio;
        play.addEventListener('click', () => playLine(line));
        const del = document.createElement('button'); del.className = 'ghost tiny'; del.textContent = t('删除本行');
        del.disabled = bad;
        if (bad) del.title = t('这个槽位不在 VOICE_SLOTS 里，只能手工改 pack.json');
        del.addEventListener('click', () => removeLine(charId, slot, line));
        actions.append(play, del);
        row.append(code, tags, actions);
        s.append(row);
      }
      card.append(s);
    }
    box.append(card);
  }

  // 注意：下面这条文案里有一个「斜杠 + 星号」组合（assets 目录的通配写法）。test/editorI18n.test.js 的
  // stripComments 会把那个斜杠星号读成块注释的开头，所以从这个位置到文件末尾都不要再写块注释
  // （星号 + 斜杠收尾）—— 否则中间整段代码会被当成注释忽略，里面的 t() 会被判成没用到（死键）。这一段之后用行注释。
  box.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('文件放这里：workshop/{0}/assets/**（编辑器不上传素材，请自己把文件拷进去）。试听播放的就是 /workshop-assets/<包>/<路径>，和游戏客户端读的是同一条通路。', p.id),
  }));
}

// ---- 右栏：加一条 / 清空 -------------------------------------------------------------------------------------------

function renderSide() {
  const box = $('#form');
  box.replaceChildren();
  const h = (text) => { const e = document.createElement('h2'); e.textContent = text; return e; };
  const p = packOf();
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }
  if (!state.data) return;

  box.append(h(t('加一条语音')));
  const form = document.createElement('div'); form.className = 'panel';
  if (!p) {
    form.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('先选一个工坊包。') }));
    box.append(form);
    return;
  }
  if (!state.slot) state.slot = state.data.slots[0] ?? '';

  const opInput = document.createElement('input');
  opInput.setAttribute('list', 'opChoices');
  opInput.value = state.charId;
  // 示例值（干员 id、包内路径）保持原样，只翻「例如」这一层界面文字
  opInput.placeholder = t('例如 {0}', 'char_ws_my_op');
  opInput.addEventListener('input', () => { state.charId = opInput.value; });
  const opList = document.createElement('datalist'); opList.id = 'opChoices';
  for (const o of state.data.operators ?? []) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.label = `${o.name} · ${t('{0} 阶', o.tier ?? '?')} · ${o.from === 'official' ? t('官方') : t('本包({0})', o.from)}`;
    opList.append(opt);
  }
  form.append(Object.assign(document.createElement('label'), { textContent: t('干员 id') }), opInput, opList);

  const slotSelect = document.createElement('select');
  for (const s of state.data.slots ?? []) {
    const opt = document.createElement('option'); opt.value = s; opt.textContent = slotLabel(s); slotSelect.append(opt);
  }
  slotSelect.value = state.slot;
  slotSelect.addEventListener('change', () => { state.slot = slotSelect.value; });
  form.append(Object.assign(document.createElement('label'), { textContent: t('槽位') }), slotSelect);

  const fileInput = document.createElement('input');
  fileInput.setAttribute('list', 'fileChoices');
  fileInput.value = state.file;
  fileInput.placeholder = t('例如 {0}', 'voice/select1.mp3');
  fileInput.addEventListener('input', () => { state.file = fileInput.value; });
  const fileList = document.createElement('datalist'); fileList.id = 'fileChoices';
  for (const f of p.files) {
    const opt = document.createElement('option');
    opt.value = f.path; opt.label = f.serveable ? (f.audio ? t('音频') : t('非音频')) : t('服务端不会提供这个类型');
    fileList.append(opt);
  }
  form.append(Object.assign(document.createElement('label'), { textContent: t('文件（包内 assets/ 下的相对路径）') }), fileInput, fileList);

  const actions = document.createElement('div'); actions.className = 'row'; actions.style.marginTop = '10px';
  const add = document.createElement('button'); add.className = 'primary';
  add.textContent = state.busy ? t('保存中…') : t('加入该槽位');
  add.disabled = state.busy || !p.hasAssets;
  add.addEventListener('click', () => addLine());
  const clear = document.createElement('button'); clear.className = 'ghost'; clear.textContent = t('清空该槽位');
  clear.disabled = state.busy;
  clear.addEventListener('click', () => clearSlot(state.charId.trim(), state.slot));
  actions.append(add, clear);
  form.append(actions);
  form.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('一个槽位可以有任意多条，客户端每次随机挑一条并避免连续重复；同一个干员同一槽位，官方台词在前、包台词在后。'),
  }));
  box.append(form);

  box.append(h(t('该包 assets/ 下的文件（{0} 个）', p.files.length)));
  const picker = document.createElement('div'); picker.className = 'panel picker';
  if (!p.files.length) picker.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('没有找到文件（文件夹不存在，或还没放素材）。') }));
  for (const f of p.files) {
    const el = document.createElement('div');
    el.className = 'pick';
    el.innerHTML = `<span class="${f.audio ? 'ok' : f.serveable ? 'warn' : 'err'}">${f.path}</span>`
      + `<span class="dim"> · ${f.bytes} B${f.serveable ? '' : ` · ${t('类型不允许')}`}</span>`;
    el.addEventListener('click', () => { state.file = f.path; fileInput.value = f.path; });
    picker.append(el);
  }
  box.append(picker);

  box.append(h(t('槽位与位置')));
  const help = document.createElement('div'); help.className = 'panel';
  const ul = document.createElement('ul'); ul.className = 'slots';
  for (const s of state.data.slots ?? []) {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('code'), { textContent: s }));
    li.append(document.createTextNode(` — ${slotLabelText(s)}`));
    ul.append(li);
  }
  help.append(ul);
  help.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('路径相对 workshop/{0}/assets/；不能以 / 开头、不能含反斜杠、盘符或 . .. 段，文件必须真的存在，扩展名必须在包内媒体允许的类型里（{1} 是音频）。', p.id, (state.data.audioExtensions ?? []).join(' ')),
  }));
  box.append(help);
}

// 整页重画：右上角的汇总 + 左中右三栏。换语言后 mountI18n 也走这里 —— 这些都是脚本生成的文案。
// 载入完成前 state.data 是空的：那时什么都不画，等 load() 画第一次。
function renderAll() {
  if (!state.data) return;
  const packs = state.data.packs ?? [];
  const lines = packs.reduce((a, p) => a + Object.values(p.voices ?? {}).reduce((b, slots) => b + Object.values(slots).reduce((c, l) => c + l.length, 0), 0), 0);
  $('#rootPath').textContent = packs.length ? t('{0} 个工坊包 · {1} 条语音', packs.length, lines) : t('还没有工坊包');
  renderPackList(); renderLines(); renderSide();
}

// ---- 动作 ---------------------------------------------------------------------------------------------------------

async function saveSlot(charId, slot, paths) {
  if (!state.packId) return;
  if (!charId) return setMessage('error', t('先填干员 id。'));
  if (!slot) return setMessage('error', t('先选一个槽位。'));
  state.busy = true; renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.packId)}/voices`, { method: 'POST', body: { charId, slot, paths } });
    state.message = {
      kind: 'ok',
      text: t('{0} · {1} · {2}：现在 {3} 条', r.pack, r.charId, r.slot, r.paths.length)
        + (Array.isArray(r.warnings) && r.warnings.length ? t('；⚠ {0}', r.warnings.join('；')) : ''),
    };
    await load();
  } catch (e) {
    state.message = { kind: 'error', text: e.message };
  } finally {
    state.busy = false;
    renderSide();
  }
}

function addLine() {
  const charId = state.charId.trim();
  const file = state.file.trim();
  if (!file) return setMessage('error', t('先选一个文件（assets/ 下的相对路径）。'));
  const lines = slotLines(charId, state.slot);
  if (lines.includes(file)) return setMessage('error', t('这个槽位已经有 "{0}" 了。', file));
  // POST sets the WHOLE slot, so the new line is appended to what is already declared there
  return saveSlot(charId, state.slot, [...lines, file]);
}

function removeLine(charId, slot, path) {
  const lines = slotLines(charId, slot).filter((l) => l !== path);
  // an empty list is how a slot is removed — including the file that does not exist on disk, which is exactly the line
  // the author most needs to be able to delete
  return saveSlot(charId, slot, lines);
}

function clearSlot(charId, slot) {
  if (!charId || !slot) return setMessage('error', t('先填干员 id 并选一个槽位。'));
  if (!confirm(t('清空 {0} 的 {1} 槽位？', charId, slot))) return;
  return saveSlot(charId, slot, []);
}

// ---- 载入 ---------------------------------------------------------------------------------------------------------

async function load() {
  const wanted = new URLSearchParams(location.search).get('pack');
  state.data = await api('/api/voices');
  const packs = state.data.packs ?? [];
  if (!packs.some((p) => p.id === state.packId)) {
    state.packId = (wanted && packs.some((p) => p.id === wanted) ? wanted : packs[0]?.id) ?? null;
  }
  renderAll();
}

// 界面语言：换掉 HTML 里的静态文案、插入右上角切换按钮，换语言后整页重画（动态文案也要跟着换）。
// renderAll 自己会跳过「还没载入完」的那一次，所以这里直接挂上就行。
mountI18n(renderAll);

$('#btnReload').addEventListener('click', () => {
  load().catch((e) => setMessage('error', t('载入失败：{0}', e.message)));
});

load().catch((e) => {
  $('#form').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: t('载入失败：{0}', e.message) }));
});
