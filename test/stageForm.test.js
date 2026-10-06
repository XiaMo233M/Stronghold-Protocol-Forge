// test/stageForm.test.js — 地图设计器页真跑一遍：最小 DOM 桩把 stage.js 载进来，喂一份假的 /api/stages，
// 打开一张地图，然后真的去改「回合绑定」的下拉，断言这次改动**真的进了要保存的 spec**。
//
// 为什么值得：这一页是编辑器里最复杂的（canvas + 3D + 路线），此前一条运行时测试都没有；而这一轮刚给它加了
// 回合绑定面板 —— 它写的是引擎真正读的 `stage.rounds`，写错了就是「作者以为绑上了、实际打的是官方模板」。
// 断言方式特意选了「看 /api/stages/preview 的请求体」：那正是保存时会发出去的东西（currentSpec()）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TILE_PALETTE, DEPLOY_RECTS, STAGE_ROWS, STAGE_COLS } from '../shared/stageAuthoring.js';

/** 2D 上下文桩：用 Proxy 兜住任何方法（canvas 的方法太多，一个个列举只会漏），属性赋值照常记下。 */
function makeCtx() {
  const calls = [];
  const store = { calls };
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (...args) => { calls.push([String(prop), ...args]); };
    },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1, id: '', className: '', style: {}, attrs: {},
    children: [], listeners: {}, value: '', checked: false, hidden: false, textContent: '', innerHTML: '', title: '',
    width: 400, height: 440,
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...kids) { for (const k of kids) el.children.push(typeof k === 'string' ? { nodeType: 3, text: k } : k); },
    replaceChildren(...kids) { el.children = [...kids]; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 440 }),
    focus() { doc.activeElement = el; },
    setSelectionRange() {},
    querySelectorAll: () => [],
    removeEventListener() {},
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
  // 叶子节点可能是用 innerHTML 建的（这一页的地图条目就是），那部分文字也要算进来
  const own = (node.children || []).length ? '' : String(node.innerHTML ?? '');
  return [node.textContent || '', own, ...(node.children || []).map(textOf)].join(' ');
};
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.nodeType === 1 && pred(node)) out.push(node);
  for (const k of node.children || []) findAll(k, pred, out);
  return out;
};
/** 列表项有的是用 textContent 建的、有的用 innerHTML（这一页的地图条目就是后者），找的时候两边都要看。 */
const shownText = (n) => `${textOf(n)} ${n.innerHTML ?? ''}`;
const clickableWith = (root, needle) => findAll(root, (n) => String(n.className).split(/\s+/).includes('item') && shownText(n).includes(needle))[0]
  || findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n).includes(needle))[0];

const doc = makeEl('html');
doc.documentElement = makeEl('html');
doc.title = '卫戍协议 · 工坊地图设计器';
doc.activeElement = null;
doc.createElement = (tag) => makeEl(tag);
doc.createTextNode = (text) => ({ nodeType: 3, text: String(text) });
doc.getElementById = (id) => findAll(doc, (n) => n.id === id)[0] ?? null;

const IDS = ['board', 'board3d', 'cursor', 'palette', 'list', 'side', 'toolBrush', 'toolDevice', 'toolErase', 'toolRoute',
  'ovDeploy', 'ovPaths', 'ovRoutes', 'ov3d', 'hint3d', 'presets3d', 'rootPath', 'btnReload', 'btnNew'];
const els = {};
for (const id of IDS) { els[id] = makeEl(id === 'board' || id === 'board3d' ? 'canvas' : 'div'); els[id].id = id; }
const header = makeEl('header');
const headerRow = makeEl('div'); headerRow.className = 'row'; header.append(headerRow);
doc.append(...Object.values(els), header);
doc.querySelector = (sel) => (sel === 'header .row' ? headerRow : (sel === 'header' ? header : (els[sel.replace('#', '')] ?? null)));
doc.querySelectorAll = () => [];

globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// 这一页在模块里挂了 window 的 mouseup（结束拖拽画笔）：桩里给一个只记监听的 window 就够
globalThis.window = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); } };
// 用 2D 模式载入：这一页默认会自动进 3D，而 3D 要真 three.js，桩里没有
globalThis.location = { search: '?board=2d' };

const MODE = 'mode_single_funny';
const MAP = {
  pack: 'demo-pack', id: 'ws_map', name: '我的图', managed: true, weight: 50, modes: [MODE],
  groundPaths: 1, deployMelee: 0, routes: 1, issues: [],
};
const ROWS = Array.from({ length: STAGE_ROWS }, (_, r) => (r === 9 ? `S${'r'.repeat(STAGE_COLS - 2)}E` : 'r'.repeat(STAGE_COLS)));
const SPEC = {
  id: 'ws_map', name: '我的图', weight: 50, modes: [MODE], rows: ROWS,
  tiles: Object.fromEntries(TILE_PALETTE.map((t) => [t.glyph, { tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable, groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE', special: null, bb: {} }])),
  devices: [], options: { characterLimit: 8, moveMultiplier: 0.5 },
  routes: [{ motion: 'WALK', start: [9, 0], end: [9, STAGE_COLS - 1], checkpoints: [] }],
  // 故意留一个**不存在**的出怪表：面板必须把这件事说出来（引擎遇到它只会静默回落）
  rounds: { 3: 'typo_wave_id' },
};
const OFFICIAL_WAVE = 'act1autochess_01';
const DATA = {
  stages: [MAP], palette: TILE_PALETTE, rects: DEPLOY_RECTS, size: [STAGE_ROWS, STAGE_COLS],
  officialStages: ['act1autochess_m01'], modes: [{ id: MODE, name: '单人·欢乐' }],
  packs: [{ id: 'demo-pack', name: '演示包' }],
  roundBind: {
    waves: [{ id: OFFICIAL_WAVE, name: null, pack: null }, { id: 'wave_ws_mine', name: '我的表', pack: 'demo-pack' }],
    modes: {
      [MODE]: {
        name: '单人·欢乐',
        rounds: Array.from({ length: 9 }, (_, i) => ({ round: i + 1, template: OFFICIAL_WAVE, isBoss: i + 1 === 9 })),
        bosses: ['boss_1', 'boss_2'],
      },
    },
  },
};

const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: String(url), body });
  if (String(url) === '/api/stages') return { ok: true, json: async () => DATA };
  if (String(url) === '/api/stages/demo-pack/ws_map') return { ok: true, json: async () => ({ spec: JSON.parse(JSON.stringify(SPEC)), record: { id: 'ws_map' } }) };
  if (String(url) === '/api/stages/preview') {
    // 真服务端总会带一份推导结果（寻路 + 四类部署区），draw() 与 renderSide 都要读它
    const record = {
      id: 'ws_map',
      groundPaths: { 0: [[9, 0], [9, 1]] },
      groundPathsWithDevices: { 0: [[9, 0], [9, 1]] },
      deployTiles: {
        normal: { melee: [[9, 2]], rangedOnly: [] },
        bossLeft: { melee: [], rangedOnly: [] },
        bossRight: { melee: [], rangedOnly: [] },
      },
    };
    return { ok: true, json: async () => ({ ok: true, errors: [], warnings: [], record, routePaths: [] }) };
  }
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 右栏里「绑定用」的那些下拉：只有它们的选项里带得出怪表 id（右栏还有别的下拉，例如保存目标包）。 */
const bindingSelects = () => findAll(els.side, (n) => n.tagName === 'SELECT' && n.children.some((o) => o.value === 'wave_ws_mine'));

await import('../editor/ui/stage.js');
await tick();
await tick();

describe('地图设计器：真跑一遍（最小 DOM 桩）', () => {
  test('载入后列出地图，并说明有几张工坊地图', () => {
    assert.equal(calls[0].url, '/api/stages');
    assert.match(shownText(els.list), /我的图/);
    assert.equal(els.rootPath.textContent, '1 张工坊地图');
  });

  test('打开地图后右栏出现「回合绑定」面板，逐回合给下拉并显示默认模板', async () => {
    fire(clickableWith(els.list, '我的图'), 'click');
    await tick(); await tick();
    const sideText = textOf(els.side);
    assert.match(sideText, /回合绑定（这张图自己的出怪表）/);
    assert.match(sideText, /第 1 回合/);
    assert.match(sideText, /默认 act1autochess_01/, '要显示不指定的话本来会打哪张表');
    assert.match(sideText, /第 9 回合/, '回合数按模式的回合表来');
    assert.match(sideText, /首领回合/, '首领回合要单独标出来');
    assert.equal(bindingSelects().length, 10, '9 个普通回合 + 1 个首领回合');
  });

  test('绑了不存在的出怪表：当场列出来，并把那一项摆在下拉里', () => {
    assert.match(textOf(els.side), /这些绑定的出怪表不存在，引擎会静默回落到模式的模板：第 3 回合 → typo_wave_id/);
    const stale = findAll(els.side, (n) => n.tagName === 'SELECT')
      .flatMap((s) => s.children)
      .find((o) => o.value === 'typo_wave_id');
    assert.ok(stale, '失效的那一项不能直接从下拉里消失，否则作者以为自己没绑过');
    assert.match(String(stale.textContent), /这张表不存在/);
  });

  test('改一个回合的下拉：改动真的进了要保存的 spec（看预览请求体）', async () => {
    const round1 = bindingSelects()[0];
    assert.equal(round1.value, '', '第 1 回合本来没绑');
    fire(round1, 'change', 'wave_ws_mine');
    await wait(450); // 校验是防抖的
    const preview = calls.filter((c) => c.url === '/api/stages/preview').pop();
    assert.ok(preview, '改完应该会去问一次校验');
    assert.equal(preview.body.spec.rounds['1'], 'wave_ws_mine', '绑定的回合要进 spec');
    assert.equal(preview.body.spec.rounds['3'], 'typo_wave_id', '别的绑定不能被顺手删掉');
  });

  test('首领回合的下拉写进 bossRounds，并带上该模式的首领 id', async () => {
    // 绑定下拉的最后一个就是首领回合那一行（它紧跟在第 9 回合之后）
    const bossSel = bindingSelects()[9];
    assert.ok(bossSel, '首领回合应该有单独一个下拉');
    fire(bossSel, 'change', OFFICIAL_WAVE);
    await wait(450);
    const preview = calls.filter((c) => c.url === '/api/stages/preview').pop();
    assert.deepEqual(preview.body.spec.bossRounds['9'], { boss_1: OFFICIAL_WAVE, boss_2: OFFICIAL_WAVE });
  });

  test('切到英文界面后，这一页新增的文案也跟着变', () => {
    fire(findAll(headerRow, (n) => n.id === 'btnLang')[0], 'click');
    const sideText = textOf(els.side);
    assert.match(sideText, /Round bindings \(this map’s own wave tables\)/);
    assert.match(sideText, /Round 1/);
    assert.doesNotMatch(sideText, /回合绑定/);
  });
});
