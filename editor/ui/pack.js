// editor/ui/pack.js — 第八页：包管理 (docs/EDITOR.md, docs/WORKSHOP.md §1「分享与安装一个包」)。
//
// 这一页补上工坊一直缺的两块：
//   1. 一个包**没法交给别人** —— 只能手抄目录。这里导出成 `<包id>.zip`（内容就是那个包），
//      也能把别人给的 .zip 装回 workshop/；
//   2. `pack.json.support`（助战声明）**没有图形入口** —— 只能手写 JSON。这里勾选本包自己新增的干员。
//
// 两条规则来自服务端，页面不复制第二份：
//   * 归档的读/写与「只动 support 一个字段」的写盘都在 tools/workshop-pack.mjs（CLI 与这页共用同一批函数），
//     所以图形界面与 `node tools/workshop-pack.mjs …` 不可能给出不同结论；
//   * **阶由记录推导**（/api/packs/support 给的 derived），页面上没有任何可以手输阶的地方 ——
//     手写的阶一旦与记录不一致，`isSupportChess` 会让该干员静默不可选。
//
// 卡池的最终归属地是服务端的 `data/support.json`：`"workshop": false` 会让所有包的助战声明失效，
// 页面必须把这件事说清楚，否则作者会以为勾选没生效是编辑器的 bug。

// 界面文案走 i18n：t('中文原文') 查英文词典，查不到就原样返回中文（editor/ui/i18n.js 说明了这个取舍）。
import { t, mountI18n } from './i18n.js';

const $ = (s) => document.querySelector(s);

/** 服务端经 data.error 回传的中文（第二战场）：命中词典才翻，带插值的原文原样显示。 */
const errText = (e) => t(e?.message ?? String(e));

/** 只有两项以上才插分隔符：一项时不留一个孤零零的顿号（英文那边也一样）。 */
const listJoin = (items) => (items.length > 1 ? items.join(t('、')) : (items[0] ?? ''));

async function api(path, opts) {
  const res = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const state = { data: null, packs: [], packId: null, message: null, busy: false, picked: new Set(), playtest: null, playtestDifficulty: null };

const packOf = (id = state.packId) => state.packs.find((p) => p.id === id) ?? null;
const isChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s));

function setMessage(kind, text) {
  state.message = { kind, text };
  renderSide();
}

/** 一行「标签 值」，用于包的元信息面板。 */
function kv(k, v) {
  const row = document.createElement('div');
  row.style.display = 'contents';
  row.append(Object.assign(document.createElement('div'), { className: 'k', textContent: k }));
  row.append(Object.assign(document.createElement('div'), { className: 'v', textContent: v }));
  return row;
}

// ---- 左栏：包列表 -------------------------------------------------------------------------------------------------

function renderPackList() {
  const box = $('#packList');
  box.replaceChildren();
  if (!state.packs.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'item dim', textContent: t('还没有工坊包（先用干员编辑器建一个，或导入一个 .zip）') }));
    return;
  }
  for (const p of state.packs) {
    const el = document.createElement('div');
    el.className = `item${p.id === state.packId ? ' on' : ''}`;
    const bits = [`v${p.version}`];
    if (p.license) bits.push(p.license);
    bits.push(p.content.length ? t('内容 {0}', p.content.join('/')) : t('内容（无）'));
    if (p.voiceLines) bits.push(t('语音 {0}', t('{0} 条', p.voiceLines)));
    if (p.support.length) bits.push(t('助战 {0}', t('{0} 个', p.support.length)));
    const name = document.createElement('div'); name.className = 'n'; name.textContent = p.name || p.id;
    const meta = document.createElement('div'); meta.className = 'm'; meta.textContent = `${p.id} · ${bits.join(' · ')}`;
    const verdict = document.createElement('div'); verdict.className = 'm';
    const tag = document.createElement('span');
    if (p.status === 'loaded') { tag.className = 'tag ok'; tag.textContent = t('加载器接受'); }
    else { tag.className = 'tag err'; tag.textContent = p.syntaxError?.code ?? p.reason?.split(':')[0] ?? 'REFUSED'; }
    verdict.append(tag);
    el.append(name, meta, verdict);
    el.addEventListener('click', () => selectPack(p.id));
    box.append(el);
  }
}

/** 选中一个包：勾选状态按它自己声明的 support 初始化（未保存的改动会被丢弃，和别的页面一样）。 */
function selectPack(id) {
  state.packId = id;
  state.message = null;
  state.picked = new Set(packOf(id)?.support ?? []);
  renderAll();
}

function renderAll() { renderPackList(); renderDetail(); renderSide(); }

// ---- 中栏：包的详情 + 助战声明 -----------------------------------------------------------------------------------

function renderDetail() {
  const box = $('#detail');
  box.replaceChildren();
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  const p = packOf();
  if (!p) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('左边选一个工坊包，或在右边导入一个 .zip。') }));
    return;
  }

  box.append(h(t('「{0}」', p.name)));
  const info = document.createElement('div'); info.className = 'panel kv';
  info.append(kv(t('包 id'), p.id));
  info.append(kv(t('版本'), p.version));
  info.append(kv(t('作者'), p.author ?? t('（未声明）')));
  info.append(kv(t('授权 license'), p.license ?? t('（未声明）')));
  info.append(kv(t('内容文件'), p.content.length ? p.content.join(t('、')) : t('（无 —— 只带语音/助战也是合法的包）')));
  info.append(kv(t('语音'), p.voiceLines ? t('{0} 条', p.voiceLines) : t('（无）')));
  info.append(kv(t('自带素材'), p.hasAssets ? t('有 assets/（必须有 license）') : t('没有 assets/')));
  box.append(info);

  // 校验结论：加载器自己的答案（/api/packs/support 的 status/reason 来自 loadWorkshop）
  const verdict = document.createElement('div');
  if (p.status === 'loaded') {
    verdict.className = 'banner good';
    verdict.textContent = t('✔ 加载器接受这个包（格式与 content 声明都对得上）。改完要重启游戏服务器才会生效。');
  } else {
    verdict.className = 'banner bad';
    verdict.textContent = t('✘ 加载器不会使用这个包：{0}', p.reason ?? t('（未知原因）'))
      + (p.syntaxError ? t('；pack.json 本身：{0} — {1}', p.syntaxError.code, p.syntaxError.detail) : '');
  }
  box.append(verdict);

  // ---- 助战声明 ----
  box.append(h(t('助战声明（pack.json 的 support）')));
  const note = document.createElement('div'); note.className = 'panel';
  note.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('只勾选**这个包自己新增**的干员：卡池是安装方的规则，包不能把官方干员塞进或移出卡池（违反会被加载器记 SUPPORT_FOREIGN_OPERATOR 并整条丢掉）。阶由记录推导，这里不接受手输的阶 —— 手写的阶一旦与记录不一致，该干员会静默不可选（isSupportChess 要求 id 出现在它自己那一阶的池子里）。'),
  }));

  if (!p.operators.length) {
    note.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: t('这个包还没有自己的 chess.json —— 先在干员编辑器里保存一个干员，助战声明才有对象。'),
    }));
  } else {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const th of ['', t('干员 id'), t('名称'), t('阶（推导）'), t('会不会进卡池')]) head.append(Object.assign(document.createElement('th'), { textContent: th }));
    table.append(head);
    for (const op of p.operators) {
      const tr = document.createElement('tr');
      const pick = document.createElement('td'); pick.className = 'pick';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      // 记录没有 1–6 的整数阶时（SUPPORT_TIER_UNKNOWN）不给勾：勾了也进不了池，那是「看起来配好了但没生效」
      cb.disabled = !op.tier;
      if (!op.tier) cb.title = t('这条记录没有 1–6 的整数 tier，进不了卡池');
      cb.checked = op.selected;
      cb.addEventListener('change', () => {
        if (cb.checked) state.picked.add(op.id); else state.picked.delete(op.id);
        renderDetail();
      });
      pick.append(cb);
      tr.append(pick);
      tr.append(Object.assign(document.createElement('td'), { className: 'id', textContent: op.id }));
      tr.append(Object.assign(document.createElement('td'), { textContent: op.name }));
      tr.append(Object.assign(document.createElement('td'), { textContent: op.tier ? String(op.tier) : t('（无整数 tier）') }));
      const why = document.createElement('td');
      if (op.selected && op.entry) why.append(Object.assign(document.createElement('span'), { className: 'tag ok', textContent: t('会进 {0} 阶卡池', op.entry.tier) }));
      else if (op.selected) why.append(Object.assign(document.createElement('span'), { className: 'tag err', textContent: t('阶梯未知，进不了池') }));
      else why.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: t('未声明') }));
      tr.append(why);
      table.append(tr);
    }
    note.append(table);
    const actions = document.createElement('div'); actions.className = 'row'; actions.style.marginTop = '10px';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = state.busy ? t('保存中…') : t('保存助战声明');
    save.disabled = state.busy;
    save.addEventListener('click', saveSupport);
    const reset = document.createElement('button');
    reset.className = 'ghost';
    reset.textContent = t('还原');
    reset.addEventListener('click', () => { state.picked = new Set(p.support); renderDetail(); });
    actions.append(save, reset);
    note.append(actions);
    note.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: t('保存只改 pack.json 的 support 字段：其余字段、键序与两空格缩进原样保留，也不会给包补一条它没声明过的 content。'),
    }));
  }

  // 已经写着的声明里，哪些是加载器会拒绝的（别人的干员 id、坏 id）
  if (p.errors?.length) {
    const box2 = document.createElement('div'); box2.className = 'panel';
    box2.append(Object.assign(document.createElement('div'), { className: 'err', textContent: t('{0} 条声明会被拒绝', p.errors.length) }));
    const ul = document.createElement('ul'); ul.className = 'issues';
    for (const e of p.errors) ul.append(Object.assign(document.createElement('li'), { className: 'err', textContent: t('[{0}] {1}：{2}', e.code, e.id, t(e.reason)) }));
    box2.append(ul);
    note.append(box2);
  }
  box.append(note);

  // 卡池的归属地：说清楚 support 只是「建议」，真正的池子在服务端
  box.append(h(t('卡池在哪里')));
  const pool = document.createElement('div'); pool.className = 'panel';
  if (p.workshop && Object.keys(p.workshop).length) {
    const lines = Object.entries(p.workshop).map(([tier, ids]) => t('{0} 阶：{1}', tier, t('{0} 个', ids.length))).join(' · ');
    pool.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('当前 data/support.json 的卡池：{0}', lines) }));
  } else {
    pool.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('data/support.json 里没有可用的卡池（没有这个文件，或没有「名额 + 卡池」的组合）。') }));
  }
  pool.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('助战卡池本身由服务端的 data/support.json 决定：这个页面只写包的「建议」。安装方在那里写 "workshop": false 就会忽略所有包的助战声明（启动日志会写出来）。')
      + (state.data?.enabled === false ? ' ' + t('⚠ 这个安装现在没有开启助战，保存后这些声明不会进卡池。') : ''),
  }));
  box.append(pool);
}

// ---- 右栏：导出 / 导入 ---------------------------------------------------------------------------------------------

function renderSide() {
  const box = $('#side');
  box.replaceChildren();
  const h = (t) => { const e = document.createElement('h2'); e.textContent = t; return e; };
  if (state.message) {
    const b = document.createElement('div');
    b.className = `banner ${state.message.kind === 'error' ? 'bad' : state.message.kind === 'warn' ? 'warn' : 'good'}`;
    b.textContent = state.message.text;
    box.append(b);
  }

  const p = packOf();
  box.append(h(t('导出一个包')));
  const ex = document.createElement('div'); ex.className = 'panel';
  ex.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    // 词条里不能出现 assets 路径紧跟两个星号：注释剥离会把它当成块注释开头，整句就没法作为 key
    textContent: t('下载 <包id>.zip：pack.json 与包内所有文件（含 assets/ 整个目录）都在 zip 根，所以这个 zip 就是这个包。条目按名字排序、时间戳固定，同样的内容永远得到同样的字节。'),
  }));
  const dl = document.createElement('button');
  dl.className = 'primary';
  dl.textContent = state.busy ? t('导出中…') : t('导出 {0}.zip', p ? p.id : t('（先选一个包）'));
  dl.disabled = !p || state.busy;
  dl.addEventListener('click', exportPack);
  ex.append(dl);
  ex.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('命令行等价：node tools/workshop-pack.mjs export <包id>'),
  }));
  box.append(ex);

  box.append(h(t('导入一个包')));
  const im = document.createElement('div'); im.className = 'panel';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  const force = document.createElement('input');
  force.type = 'checkbox';
  force.id = 'forceChk';
  const forceLabel = document.createElement('label');
  forceLabel.className = 'chk';
  forceLabel.style.display = 'flex';
  forceLabel.style.gap = '6px';
  forceLabel.append(force, document.createTextNode(t('覆盖同名包（--force）')));
  const up = document.createElement('button');
  up.className = 'primary';
  up.textContent = state.busy ? t('导入中…') : t('导入这个 .zip');
  up.disabled = state.busy;
  up.addEventListener('click', () => importPack(file.files?.[0] ?? null, force.checked));
  im.append(Object.assign(document.createElement('label'), { textContent: t('.zip 文件') }), file, forceLabel);
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px';
  row.append(up);
  im.append(row);
  im.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('先解压到临时目录、校验 pack.json（用加载器自己的规则），再整个搬进 workshop/<包id>/。坏归档、恶意归档、校验不过的包都不会在 workshop/ 里留下半个包；同名包默认拒绝覆盖。'),
  }));
  im.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('命令行等价：node tools/workshop-pack.mjs import <文件.zip> [--force]'),
  }));
  box.append(im);

  box.append(h(t('试玩这一版')));
  const pt = document.createElement('div'); pt.className = 'panel';
  const running = !!(state.playtest && state.playtest.running);
  pt.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: running
      ? t('游戏服务器正在跑：{0}', state.playtest.url)
      : t('起一个游戏服务器（子进程，绑 127.0.0.1 的随机空闲端口），把当前工坊根交给它，然后打开浏览器直接进一局独立模拟。改完包再点一次「重启试玩」就能看到新内容 —— 编辑器自己不会重载数据。'),
  }));
  const dRow = document.createElement('div'); dRow.className = 'row'; dRow.style.margin = '6px 0';
  const dLab = document.createElement('label'); dLab.textContent = t('难度'); dLab.style.margin = '0';
  const dSel = document.createElement('select');
  dSel.style.width = 'auto';
  for (const d of state.playtest?.difficulties ?? []) {
    const o = document.createElement('option'); o.value = d; o.textContent = d;
    dSel.append(o);
  }
  if (state.playtestDifficulty) dSel.value = state.playtestDifficulty;
  dSel.addEventListener('change', () => { state.playtestDifficulty = dSel.value; });
  dRow.append(dLab, dSel);
  pt.append(dRow);
  const pRow = document.createElement('div'); pRow.className = 'row';
  const go = document.createElement('button');
  go.className = 'primary';
  go.textContent = state.busy ? t('启动中…') : (running ? t('重启试玩') : t('启动试玩'));
  go.disabled = state.busy;
  go.addEventListener('click', () => startPlaytest(running));
  pRow.append(go);
  if (running) {
    const stop = document.createElement('button');
    stop.textContent = t('停止');
    stop.disabled = state.busy;
    stop.addEventListener('click', stopPlaytest);
    pRow.append(stop);
  }
  pt.append(pRow);
  if (running) {
    const link = document.createElement('p');
    link.className = 'hint';
    const a = document.createElement('a');
    a.href = state.playtest.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = t('在新标签页打开这一局');
    link.append(a);
    pt.append(link);
  }
  pt.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('命令行等价：node scripts/launch.mjs（游戏服务器）；试玩用的是 SP_WORKSHOP，所以这里选的工坊目录就是它读的目录。'),
  }));
  box.append(pt);

  box.append(h(t('说明')));
  const help = document.createElement('div'); help.className = 'panel';
  help.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('导入的包必须自带 pack.json（在 zip 根，或包在一个唯一的顶层目录里 —— 两种归档都很常见）。校验用 shared/workshop.js 的 normalizePackManifest，与游戏加载器同一个函数，所以「装得上」就是「加载器会接受」。'),
  }));
  help.append(Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: t('装好的包要重启游戏服务器才会出现在游戏里。这里只写 workshop/<包id>/ 与 pack.json 的 support 字段。'),
  }));
  box.append(help);
}

// ---- 动作 ---------------------------------------------------------------------------------------------------------

async function saveSupport() {
  const p = packOf();
  if (!p) return;
  state.busy = true; renderDetail(); renderSide();
  try {
    const r = await api(`/api/packs/${encodeURIComponent(p.id)}/support`, { method: 'POST', body: { ids: [...state.picked] } });
    const derived = r.derived.map((e) => t('{0}→{1} 阶', e.id, e.tier)).join(t('、'));
    const warn = Array.isArray(r.warnings) && r.warnings.length ? ' ' + t('；⚠ {0}', r.warnings.join(' ' + t('；') + ' ')) : '';
    const detail = derived ? ' ' + t('（{0}）', derived) : '';
    state.message = {
      kind: r.changed ? 'ok' : 'warn',
      text: r.changed
        ? t('已写入 {0} 的 support：{1} 个{2}{3}', r.pack, r.support.length, detail, warn)
        : t('{0} 的 support 没有变化，文件未被改写{1}', r.pack, warn),
    };
    await load(p.id);
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
  } finally {
    state.busy = false; renderAll();
  }
}

async function exportPack() {
  const p = packOf();
  if (!p) return;
  state.busy = true; renderSide();
  try {
    const res = await fetch(`/api/packs/${encodeURIComponent(p.id)}/export`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.id}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    // 立刻 revoke 在部分浏览器里会取消下载：留一拍再释放
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    state.message = { kind: 'ok', text: t('已导出 {0}.zip（{1} 字节）', p.id, blob.size) };
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
  } finally {
    state.busy = false; renderSide();
  }
}

async function importPack(file, force) {
  if (!file) return setMessage('error', t('先选一个 .zip 文件。'));
  state.busy = true; renderSide();
  try {
    // 上传的是原始字节（application/octet-stream）：zip 不该被 JSON 包一层
    const res = await fetch(`/api/packs/import${force ? '?force=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const bits = [t('{0} 个文件', data.files), t('{0} 字节', data.bytes)];
    if (data.content.length) bits.push(t('内容 {0}', data.content.join('/')));
    if (data.voiceLines) bits.push(t('语音 {0}', t('{0} 条', data.voiceLines)));
    if (data.support.length) bits.push(t('助战 {0}', t('{0} 个', data.support.length)));
    state.message = { kind: 'ok', text: t('已安装 {0}：{1}。重启游戏服务器后生效。', data.pack, listJoin(bits)) };
    state.packId = data.pack;
    await load(data.pack);
  } catch (e) {
    // 拒绝要原样显示原因（哪一条规则、哪一个字段），否则作者只能瞎猜
    state.message = { kind: 'error', text: t('导入被拒绝：{0}', errText(e)) };
  } finally {
    state.busy = false; renderAll();
  }
}

// ---- 试玩 ---------------------------------------------------------------------------------------------------------

/** 起（或重启）试玩：先停掉旧的，再起新的 —— 作者点这个按钮的意图就是「加载我刚写的内容」。 */
async function startPlaytest(wasRunning) {
  state.busy = true; renderSide();
  try {
    if (wasRunning) await api('/api/playtest/stop', { method: 'POST' });
    const r = await api('/api/playtest/start', { method: 'POST', body: { difficulty: state.playtestDifficulty } });
    state.message = { kind: 'ok', text: t('试玩服务器已就绪：{0}', r.url) };
    // 不在编辑器里嵌游戏：用一个新标签页打开（编辑器是工具，游戏是另一个窗口）
    window.open(r.url, '_blank', 'noopener');
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
  } finally {
    state.busy = false;
    await loadPlaytest();
  }
}

async function stopPlaytest() {
  state.busy = true; renderSide();
  try {
    const r = await api('/api/playtest/stop', { method: 'POST' });
    state.message = { kind: r.stopped ? 'ok' : 'warn', text: r.stopped ? t('试玩服务器已停止。') : t('试玩服务器本来就没在跑。') };
  } catch (e) {
    state.message = { kind: 'error', text: errText(e) };
  } finally {
    state.busy = false;
    await loadPlaytest();
  }
}

/** 试玩状态是另一条查询（与包列表无关），失败也不该让整页崩掉 —— 它只是一个附加功能。 */
async function loadPlaytest() {
  try {
    state.playtest = await api('/api/playtest');
  } catch {
    state.playtest = { running: false, url: null, difficulties: [] };
  }
  renderSide();
}

// ---- 载入 ---------------------------------------------------------------------------------------------------------

async function load(keepId = null) {
  state.data = await api('/api/packs/support');
  state.packs = state.data.packs ?? [];
  await loadPlaytest();
  const wanted = keepId ?? state.packId;
  if (!state.packs.some((p) => p.id === wanted)) {
    state.packId = state.packs[0]?.id ?? null;
  } else {
    state.packId = wanted;
  }
  state.picked = new Set(packOf()?.support ?? []);
  $('#rootPath').textContent = state.packs.length
    ? `${state.data.workshopRoot} · ${t('{0} 个包', state.packs.length)}`
    : `${state.data.workshopRoot} · ${t('还没有包')}`;
  renderAll();
}

$('#btnReload').addEventListener('click', () => {
  load().catch((e) => setMessage('error', t('载入失败：{0}', errText(e))));
});

// 界面语言：换掉 HTML 里的静态文案、插入右上角切换按钮，换语言后重画一遍（动态文案也要跟着换）。
mountI18n(renderAll);

load().catch((e) => {
  $('#detail').replaceChildren(Object.assign(document.createElement('p'), { className: 'err', textContent: t('载入失败：{0}', errText(e)) }));
});
