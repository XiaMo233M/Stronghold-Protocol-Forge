// test/bondForm.test.js — 盟约页（bond.html）真跑一遍：最小 DOM 桩把 bond.js 载进来，喂一份假的 /api/bonds，
// 检查左栏、表单、预览与「以模板新建」都画得出来。
//
// 为什么值得这么测：这个页面在仓库里没有任何浏览器测试，语法或运行期错误不会有任何东西拦得住 —— 用户看到的是一片空白。
// 桩故意做得很笨（不做布局、不做选择器引擎），只保证「会不会抛异常」与「画出来的东西对不对」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    style: {},
    attrs: {},
    children: [],
    listeners: {},
    value: '',
    checked: false,
    textContent: '',
    title: '',
    disabled: false,
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...kids) { for (const k of kids) el.children.push(k); },
    replaceChildren(...kids) { el.children = [...kids]; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    focus() { doc.activeElement = el; },
    setSelectionRange() {},
    querySelectorAll: () => [],
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
const clickableWith = (root, needle) => findAll(root, (n) => (n.children || []).length && String(n.className).includes('item') && textOf(n).includes(needle))[0]
  || findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n).includes(needle))[0];

const doc = makeEl('html');
doc.documentElement = makeEl('html');
doc.title = '卫戍协议 · 工坊盟约编辑器';
doc.activeElement = null;
doc.createElement = (tag) => makeEl(tag);
doc.createTextNode = (text) => ({ nodeType: 3, text: String(text) });
doc.getElementById = (id) => findAll(doc, (n) => n.id === id)[0] ?? null;

const rootPath = makeEl('span'); rootPath.id = 'rootPath';
const list = makeEl('div'); list.id = 'list';
const form = makeEl('div'); form.id = 'form';
const side = makeEl('div'); side.id = 'side';
const header = makeEl('header');
const headerRow = makeEl('div'); headerRow.className = 'row'; header.append(headerRow);
const btnReload = makeEl('button'); btnReload.id = 'btnReload';
const btnNew = makeEl('button'); btnNew.id = 'btnNew';
const btnTemplate = makeEl('button'); btnTemplate.id = 'btnTemplate';
headerRow.append(btnReload, btnNew, btnTemplate);
doc.append(rootPath, list, form, side, header);
doc.querySelector = (sel) => ({
  '#rootPath': rootPath, '#list': list, '#form': form, '#side': side, 'header .row': headerRow, header,
  '#btnReload': btnReload, '#btnNew': btnNew, '#btnTemplate': btnTemplate,
}[sel] ?? null);
doc.querySelectorAll = () => [];

globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.confirm = () => true;
globalThis.prompt = () => 'new-pack';

/** 一份假的 /api/bonds：两条官方盟约、一个包（里面有一条新增 + 一条覆盖官方）。 */
const DATA = {
  workshopRoot: 'E:\\tmp\\workshop',
  packs: [{ id: 'demo', name: '演示包' }],
  officialCount: 2,
  officialBonds: [
    { bondId: 'yanShip', name: '炎', isCore: true, identifier: 1, weight: 10, countMode: 'BOARD', thresholds: [3, 6, 9], genericBuffs: false, memberCount: 11, desc: '炎' },
    { bondId: 'preciShip', name: '精准', isCore: false, identifier: 2, weight: 10, countMode: 'BOARD', thresholds: [2, 4], genericBuffs: false, memberCount: 21, desc: '精准' },
  ],
  packBonds: [{
    id: 'demo',
    manifest: { id: 'demo', content: ['bonds'] },
    specs: [{ id: 'wsBondShip', name: '工坊盟约', thresholds: [2, 4], countMode: 'BOARD', genericBuffs: true, bb: { base_atk: 0.2 } }],
    bonds: [
      { bondId: 'wsBondShip', name: '工坊盟约', isCore: false, weight: 10, thresholds: [2, 4], genericBuffs: true, memberCount: 0, official: false, declared: false, managed: true, issues: [] },
      { bondId: 'yanShip', name: '炎', isCore: true, weight: 10, thresholds: [2, 3], genericBuffs: false, memberCount: 11, official: true, declared: true, managed: true, issues: [] },
    ],
    content: ['bonds'],
    declaredOverrides: ['yanShip'],
  }],
  countModes: ['BOARD', 'BOARD_AND_DECK', 'BOARD_ALL_CHESS'],
  thresholdTemplates: ['count_threshold_upward', 'count_threshold_downward', 'count_threshold_upward_golden'],
  activeTypes: ['BATTLE', 'ALL', 'MANI'],
  bondTypes: ['SEASON', 'REGULAR'],
  genericKeys: ['base_atk', 'atk_per_stack', 'base_def', 'def_per_stack', 'base_max_hp', 'max_hp_per_stack'],
  iconChoices: ['yanShip', 'preciShip'],
  effectChoices: ['bondeffect_yan'],
  operators: [
    { id: 'chess_char_1_01_a', name: '红豆', tier: 1, from: 'official', bonds: ['yanShip'] },
    { id: 'chess_ws_demo_a', name: '我的干员', tier: 4, from: 'demo', bonds: [] },
  ],
};

const calls = [];
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body });
  if (String(url) === '/api/bonds') return { ok: true, json: async () => DATA };
  if (String(url).startsWith('/api/bonds/template')) {
    return {
      ok: true,
      json: async () => ({
        ok: true, bondId: 'yanShip', official: true,
        spec: { id: '', name: '炎', isCore: true, thresholds: [3, 6, 9], countMode: 'BOARD', weight: 10, desc: '炎', bb: { base_atk: 0.23 }, effectId: 'bondeffect_yan' },
      }),
    };
  }
  if (String(url) === '/api/bonds/preview') return { ok: true, json: async () => ({ ok: true, errors: [], warnings: [], overriding: false }) };
  return { ok: true, json: async () => ({ ok: true, bondId: 'wsBondShip', generated: ['wsBondShip'], overriding: false }) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

await import('../editor/ui/bond.js');
await tick();
await tick();

describe('盟约页：真跑一遍（最小 DOM 桩）', () => {
  test('载入后左栏列出本包与官方盟约，不是一片空白', () => {
    assert.equal(calls[0].url, '/api/bonds');
    const left = textOf(list);
    assert.match(left, /本包的盟约/);
    assert.match(left, /工坊盟约/);
    assert.match(left, /官方盟约/);
    assert.match(left, /精准/);
    assert.equal(rootPath.textContent.includes('工坊盟约'), true);
  });

  test('点本包的一条盟约：表单出来，带阈值 / 计数模式 / 黑板 / 成员与预览', async () => {
    fire(clickableWith(list, '工坊盟约'), 'click');
    await tick(); await tick();
    const f = textOf(form);
    assert.match(f, /阈值 thresholds/);
    assert.match(f, /计数与阈值/);
    assert.match(f, /战斗数值（黑板 bb）/);
    assert.match(f, /成员（谁携带这个盟约）/);
    assert.match(f, /base_atk/);
    const s = textOf(side);
    assert.match(s, /预览/);
    assert.match(s, /✔ 战斗里会加/);
    assert.match(s, /校验/);
  });

  test('点官方盟约：走模板接口，并说清「这是覆盖官方」', async () => {
    fire(clickableWith(list, '炎'), 'click');
    await tick(); await tick();
    assert.ok(calls.some((c) => c.url.startsWith('/api/bonds/template?bondId=yanShip')), '应该去要模板');
    assert.match(textOf(form), /覆盖官方盟约/);
    assert.equal(findAll(form, (n) => n.tagName === 'INPUT').some((i) => i.value === '3, 6, 9'), true, '阈值带过来了');
  });

  test('点「新建盟约」：空白表单（含 id 的占位提示与默认阈值）', async () => {
    fire(btnNew, 'click');
    await tick(); await tick();
    const f = textOf(form);
    assert.match(f, /严格递增的正整数/);
    assert.match(f, /战斗数值（黑板 bb）/);
    const inputs = findAll(form, (n) => n.tagName === 'INPUT');
    assert.equal(inputs.some((i) => (i.placeholder || i.attrs.placeholder) === '如 myShip'), true, 'id 输入框要有占位提示');
    assert.equal(inputs.some((i) => i.value === '2, 4, 6'), true, '默认阈值');
    assert.match(textOf(side), /新增盟约|覆盖官方/);
  });

  test('点「以模板新建」：列出可挑的官方盟约，可搜索', async () => {
    fire(btnTemplate, 'click');
    await tick();
    assert.match(textOf(form), /以模板新建/);
    const search = findAll(form, (n) => n.tagName === 'INPUT').find((i) => String(i.placeholder || i.attrs.placeholder || '').includes('搜索盟约'));
    assert.ok(search, '要有一个搜索框');
    fire(search, 'input', '精准');
    const f = textOf(form);
    assert.match(f, /精准/);
    assert.doesNotMatch(f, /炎（yanShip）/);
  });

  test('切到英文界面后，新加的文案也真的变了', async () => {
    const { setLang } = await import('../editor/ui/i18n.js');
    setLang('en');
    fire(btnNew, 'click');
    await tick();
    const f = textOf(form);
    assert.match(f, /Counting and thresholds/);
    assert.doesNotMatch(f, /计数与阈值/);
    setLang('zh');
  });
});
