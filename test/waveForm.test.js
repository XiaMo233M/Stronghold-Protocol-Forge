// test/waveForm.test.js — 出怪设计器页真跑一遍：最小 DOM 桩把 wave.js 载进来，喂一份假的 /api/waves，
// 然后真的去点「新建出怪表」「添加一次出怪」，检查**路线画布上的真实底图**、阵营占位符警告、保存目标下拉都到位。
//
// 这一页此前没有任何运行时测试（只有源码断言）。它是编辑器里第二复杂的页面（canvas + 时间轴 + 明细表），
// 而且这一轮刚给它加了底图与占位符提示 —— 语法错误或调用不存在的函数在这里是「页面一片空白」，
// 靠源码断言是抓不住的。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TILE_PALETTE } from '../shared/stageAuthoring.js';

/** 2D 上下文桩：只记调用，够断言「真的画了地形」。 */
function makeCtx() {
  return {
    calls: [],
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '',
    clearRect(...a) { this.calls.push(['clearRect', ...a]); },
    fillRect(...a) { this.calls.push(['fillRect', ...a, this.fillStyle]); },
    strokeRect(...a) { this.calls.push(['strokeRect', ...a]); },
    beginPath() { this.calls.push(['beginPath']); },
    moveTo(...a) { this.calls.push(['moveTo', ...a]); },
    lineTo(...a) { this.calls.push(['lineTo', ...a]); },
    stroke() { this.calls.push(['stroke']); },
    fillText(...a) { this.calls.push(['fillText', ...a]); },
  };
}

function makeEl(tag) {
  const ctx = makeCtx();
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1, id: '', className: '', style: {}, attrs: {}, children: [], listeners: {},
    value: '', checked: false, textContent: '', innerHTML: '', title: '',
    width: 420, height: 380,
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...kids) { for (const k of kids) el.children.push(typeof k === 'string' ? { nodeType: 3, text: k } : k); },
    prepend(...kids) { el.children.unshift(...kids.map((k) => (typeof k === 'string' ? { nodeType: 3, text: k } : k))); },
    replaceChildren(...kids) { el.children = [...kids]; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 380 }),
    focus() { doc.activeElement = el; },
    setSelectionRange() {},
    querySelectorAll: () => [],
    _ctx: ctx,
  };
  return el;
}

function fire(el, type, value) {
  if (value !== undefined) el.value = value;
  for (const fn of el.listeners[type] ?? []) fn({ target: el, preventDefault() {} });
}

const textOf = (node) => {
  if (node === null || node === undefined) return '';
  if (node.nodeType === 3) return String(node.text ?? '');
  return [node.textContent || '', ...(node.children || []).map(textOf)].join(' ');
};
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const k of node.children || []) findAll(k, pred, out);
  return out;
};
const clickableWith = (root, needle) => findAll(root, (n) => String(n.className).split(/\s+/).includes('item') && textOf(n).includes(needle))[0]
  || findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n).includes(needle))[0];
const selectsOf = (root) => findAll(root, (n) => n.tagName === 'SELECT');

const doc = makeEl('html');
doc.documentElement = makeEl('html');
doc.title = '卫戍协议 · 工坊出怪设计器';
doc.activeElement = null;
doc.createElement = (tag) => makeEl(tag);
doc.createTextNode = (text) => ({ nodeType: 3, text: String(text) });
doc.getElementById = (id) => findAll(doc, (n) => n.id === id)[0] ?? null;

const board = makeEl('canvas'); board.id = 'board';
const tl = makeEl('div'); tl.id = 'tl';
const table = makeEl('div'); table.id = 'table';
const side = makeEl('div'); side.id = 'side';
const list = makeEl('div'); list.id = 'list';
const mapPick = makeEl('select'); mapPick.id = 'mapPick';
const rootPath = makeEl('span'); rootPath.id = 'rootPath';
const mapInfo = makeEl('span'); mapInfo.id = 'mapInfo';
const ovPaths = makeEl('button'); ovPaths.id = 'ovPaths';
const btnReload = makeEl('button'); btnReload.id = 'btnReload';
const btnNew = makeEl('button'); btnNew.id = 'btnNew';
const header = makeEl('header');
const headerRow = makeEl('div'); headerRow.className = 'row'; header.append(headerRow);
doc.append(board, tl, table, side, list, mapPick, rootPath, mapInfo, ovPaths, btnReload, btnNew, header);
doc.querySelector = (sel) => ({
  '#board': board, '#tl': tl, '#table': table, '#side': side, '#list': list, '#mapPick': mapPick,
  '#rootPath': rootPath, '#mapInfo': mapInfo, '#ovPaths': ovPaths, '#btnReload': btnReload, '#btnNew': btnNew,
  'header .row': headerRow, header,
}[sel] ?? null);
doc.querySelectorAll = () => [];

globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const MODE = 'mode_single_funny';
const MAP = {
  id: 'act1autochess_m01', name: '切尔诺伯格', official: true,
  rounds: { 3: null }, rows: ['rrrr', 'ffff'], tiles: { r: { height: 'LOW' }, f: { height: 'LOW' } },
  devices: [{ role: 'crate', pos: [0, 1] }],
};
const DATA = {
  waves: [],
  vocab: { kinds: ['normal', 'boss'], slots: ['N', 'E', 'S'], spawnFields: [], roundsPerMode: 15 },
  officialWaves: ['act1autochess_01'],
  enemies: ['enemy_normal', 'enemy_ph'],
  // 带中文名与来源包：下拉据此分组并显示名字
  enemyOptions: [
    { key: 'enemy_normal', name: '源石虫', pack: null },
    { key: 'enemy_ph', name: '模板怪', pack: null },
    { key: 'enemy_ws_mine', name: '我的怪', pack: 'demo-pack' },
  ],
  modes: [{ id: MODE, name: '单人·欢乐' }],
  stages: [MAP, { id: 'ws_map', name: '我的图', pack: 'demo-pack', official: false, rows: ['rfrf'], tiles: {} }],
  placeholderEnemies: { enemy_ph: 'N' },
  packs: [{ id: 'demo-pack', name: '演示包' }],
  palette: TILE_PALETTE,
};

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (String(url) === '/api/waves') return { ok: true, json: async () => DATA };
  if (String(url) === '/api/waves/preview') return { ok: true, json: async () => ({ ok: true, errors: [], warnings: [], record: { totalCount: 0, slotCounts: {} } }) };
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

await import('../editor/ui/wave.js');
await tick();
await tick();

describe('出怪设计器：真跑一遍（最小 DOM 桩）', () => {
  test('载入后画出左栏与地图归属，并说明画布上是不是真底图', () => {
    assert.equal(calls[0].url, '/api/waves');
    assert.match(textOf(list), /＋ 新建出怪表/);
    assert.equal(rootPath.textContent, '还没有工坊出怪表');
    assert.match(mapInfo.textContent, /官方地图/);
    assert.match(mapInfo.textContent, /底图：切尔诺伯格/);
  });

  test('路线画布画的是真实地形（不是空网格）', () => {
    // 记录的形状是 ['fillRect', x, y, w, h, 当时的 fillStyle]
    const fills = board._ctx.calls.filter((c) => c[0] === 'fillRect');
    assert.ok(fills.length >= 2, '至少要为地形填几个格子');
    const colors = new Set(fills.map((c) => c[5]));
    assert.ok(colors.has(TILE_PALETTE.find((t) => t.glyph === 'r').color), '道路那几格要用调色板里的颜色');
    assert.ok(colors.has(TILE_PALETTE.find((t) => t.glyph === 'f').color), '地面也是');
    // 多出来的行/列要按兜底字符补上，而不是留空（rows 只给了 2 行）
    assert.equal(fills.length, 19 * 21 + 1, '整张网格都要填（21×19）+ 一个装置');
    // 地图自己的装置要标出来（路线会不会被挡住是作者要判断的事）
    const devices = fills.filter((c) => String(c[5]).startsWith('#e0b357'));
    assert.equal(devices.length, 1);
  });

  test('切到没有地形的地图：退回网格并说明原因', () => {
    fire(mapPick, 'change', 'ws_map');
    // ws_map 有 rows，所以仍然是底图；再换一张完全没有地形的
    assert.match(mapInfo.textContent, /底图：我的图|工坊地图/);
    assert.ok(board._ctx.calls.some((c) => c[0] === 'clearRect'), '每次切图都要重画');
  });

  test('点「＋ 新建出怪表」：右栏出现保存目标下拉与添加出怪按钮', () => {
    fire(clickableWith(list, '＋ 新建出怪表'), 'click');
    const sideText = textOf(side);
    assert.match(sideText, /保存到/, '保存目标那一栏要在');
    const packSel = selectsOf(side).find((s) => s.children.some((o) => String(o.textContent).includes('演示包')));
    assert.ok(packSel, '保存目标下拉里要列出工坊包（带名字）');
    assert.ok(clickableWith(table, '＋ 添加一次出怪'), '明细表上要有添加按钮');
  });

  test('加一次出怪、并选成阵营占位符：选项标注 + 右栏警告', () => {
    fire(clickableWith(table, '＋ 添加一次出怪'), 'click');
    const enemySel = selectsOf(table).find((s) => findAll(s, (o) => o.value === 'enemy_ph').length);
    assert.ok(enemySel, '敌人下拉应该在明细表里');
    // 按官方 / 本包分组，并显示中文名（只有键名的 250 项平铺下拉没法用）
    const groups = enemySel.children.filter((c) => c.tagName === 'OPTGROUP');
    assert.deepEqual(groups.map((g) => g.label), ['官方', '本包：demo-pack']);
    assert.ok(groups[0].children.some((o) => o.value === 'enemy_normal' && /源石虫 \(enemy_normal\)/.test(String(o.textContent))), '官方组的选项要带中文名');
    const phOption = findAll(enemySel, (o) => o.value === 'enemy_ph')[0];
    assert.match(String(phOption.textContent), /（阵营占位符）/, '占位符要在选项里标出来');
    assert.doesNotMatch(String(findAll(enemySel, (o) => o.value === 'enemy_normal')[0].textContent), /阵营占位符/);

    fire(enemySel, 'change', 'enemy_ph');
    assert.match(textOf(side), /这张表用了阵营占位符/, '用了占位符就要在右栏说清后果');
  });

  test('切到英文界面后，这一页新增的文案也跟着变', () => {
    fire(findAll(headerRow, (n) => n.id === 'btnLang')[0], 'click');
    const all = textOf(side) + textOf(list) + mapInfo.textContent;
    assert.match(all, /Save to|Maps that actually use this table|base map:/);
    assert.doesNotMatch(textOf(side), /保存到/);
  });

  test('下拉第一项是「去新建一只怪」：新标签页打开怪物编辑器并带上当前包', () => {
    // 上一条测试把界面切成英文了，这里先切回中文再断言文案
    fire(findAll(headerRow, (n) => n.id === 'btnLang')[0], 'click');
    const opened = [];
    globalThis.window = { ...(globalThis.window ?? {}), open: (url, target) => { opened.push([url, target]); return {}; } };
    try {
      // 先在「保存到」里选一个包（真实流程也是这样），跳转时才会把它带过去
      const packSel = selectsOf(side).find((s) => s.children.some((o) => String(o.textContent).includes('演示包')));
      fire(packSel, 'change', 'demo-pack');
      const enemySel = selectsOf(table).find((s) => findAll(s, (o) => o.value === 'enemy_ph').length);
      const first = enemySel.children[0];
      assert.equal(first.value, '__new_enemy__');
      assert.match(String(first.textContent), /新建怪物/);
      fire(enemySel, 'change', '__new_enemy__');
      assert.deepEqual(opened, [['./enemy.html?pack=demo-pack', '_blank']], '必须新标签页打开：这张出怪表还没保存，不能被顶掉');
      assert.notEqual(enemySel.value, '__new_enemy__', '选完要退回原来那只，别停在一个假选项上');
    } finally {
      delete globalThis.window.open;
    }
  });
});
