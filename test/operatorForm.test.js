// test/operatorForm.test.js — 首页（干员编辑器）真跑一遍：用最小 DOM 桩把 app.js 载进来，喂一份假的 /api/state，
// 然后**真的去点**「新建干员」「以模板新建」，检查表单、数值参照尺子、攻击范围小格阵、id 冲突提示都画出来了。
//
// 为什么值得这么测：这个页面在仓库里没有任何浏览器测试，语法或运行期错误不会有任何东西拦得住——用户看到的是
// 一片空白。桩故意做得很笨（不做布局、不做选择器引擎），只保证「会不会抛异常」与「画出来的东西对不对」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/** 一个够用的元素：记孩子、记属性、记文本，并真的记住事件监听（否则「点一下」这个测试就是假的）。 */
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

/** 触发事件；`value` 会先写进 target（模拟用户输入）。 */
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
/** 第一个「文字里含某串」的可点元素（左栏条目、按钮都是这种）。 */
const clickableWith = (root, needle) => findAll(root, (n) => (n.children || []).length && String(n.className).includes('item') && textOf(n).includes(needle))[0]
  || findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n).includes(needle))[0];
const inputsOf = (root) => findAll(root, (n) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName));

const doc = makeEl('html');
doc.documentElement = makeEl('html');
doc.title = '卫戍协议 · 创意工坊编辑器';
doc.activeElement = null;
doc.createElement = (tag) => makeEl(tag);
doc.createTextNode = (text) => ({ nodeType: 3, text: String(text) });
doc.getElementById = (id) => findAll(doc, (n) => n.id === id)[0] ?? null;

const rootPath = makeEl('span'); rootPath.id = 'rootPath';
const packList = makeEl('div'); packList.id = 'packList';
const opList = makeEl('div'); opList.id = 'opList';
const editorBox = makeEl('section'); editorBox.id = 'editor';
const header = makeEl('header');
const headerRow = makeEl('div'); headerRow.className = 'row'; header.append(headerRow);
// 顶栏两个按钮：app.js 在载入时就会给它们挂事件，桩里必须存在
const btnReload = makeEl('button'); btnReload.id = 'btnReload';
const btnNewPack = makeEl('button'); btnNewPack.id = 'btnNewPack';
headerRow.append(btnReload, btnNewPack);
doc.append(rootPath, packList, opList, editorBox, header);
doc.querySelector = (sel) => ({
  '#rootPath': rootPath, '#packList': packList, '#opList': opList, '#editor': editorBox, 'header .row': headerRow, header,
  '#btnReload': btnReload, '#btnNewPack': btnNewPack,
}[sel] ?? null);
doc.querySelectorAll = (sel) => (sel.startsWith('#editor ') ? inputsOf(editorBox) : []);

globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/** 一份假的 /api/state：两名官方干员、一个包（里面已有一个干员 my_op），外加一把数值尺子。 */
const STATE = {
  workshopRoot: 'E:\\tmp\\workshop',
  packs: [{
    id: 'demo-pack', manifest: { name: '演示包' },
    specs: [{ id: 'my_op', name: '我的干员', tier: 4, profession: 'SNIPER' }],
    operators: [{ chessId: 'chess_ws_my_op_a', name: '我的干员', isGolden: false, managed: true, issues: [] }],
  }],
  loadErrors: [],
  support: { pool: { 4: [] } },
  officialCount: 2,
  officialChess: [
    { id: 'chess_char_1_1_a', name: '阿米娅', appellation: 'Amiya', tier: 5, profession: 'CASTER', subProfessionId: 'caster', position: 'RANGED', spine: 'char_002_amiya', rangeGrid: [[1, 0], [0, 0], [0, 1]], stats: { maxHp: 1500, atk: 480, def: 120, res: 10, cost: 18, blockCnt: 1, bat: 1.6 } },
    { id: 'chess_char_2_1_a', name: '能天使', appellation: 'Exusiai', tier: 6, profession: 'SNIPER', subProfessionId: 'fastshot', position: 'RANGED', spine: 'char_1035_wisdel', rangeGrid: [[1, 0], [0, 0], [0, 1], [0, 2]], stats: { maxHp: 1200, atk: 520, def: 100, res: 0, cost: 14, blockCnt: 1, bat: 1.0 } },
  ],
  statRanges: {
    SNIPER: {
      maxHp: { min: 900, p50: 1200, max: 1800, count: 40 },
      atk: { min: 300, p50: 520, max: 900, count: 40 },
      def: { min: 60, p50: 100, max: 260, count: 40 },
      res: { min: 0, p50: 0, max: 20, count: 40 },
      cost: { min: 10, p50: 14, max: 24, count: 40 },
      blockCnt: { min: 1, p50: 1, max: 1, count: 40 },
      bat: { min: 0.85, p50: 1, max: 2.4, count: 40 },
    },
  },
};

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (String(url) === '/api/state') return { ok: true, json: async () => STATE };
  if (String(url).startsWith('/api/operators/template')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        chessId: 'chess_char_2_1_a',
        baseId: 'chess_char_2_1_a',
        goldenId: 'chess_char_2_1_b',
        spec: {
          id: '', name: '能天使', appellation: 'Exusiai', tier: 6, profession: 'SNIPER', subProfessionId: 'fastshot',
          position: 'RANGED', traitDesc: '', assetsSpine: 'char_1035_wisdel',
          rangeGrid: [[1, 0], [0, 0], [0, 1], [0, 2]],
          stats: {
            normal: { maxHp: 1200, atk: 520, def: 100, res: 0, cost: 14, blockCnt: 1, bat: 1 },
            golden: { maxHp: 1560, atk: 676, def: 130, res: 0, cost: 14, blockCnt: 1, bat: 1 },
          },
          skill: { name: '扫射', desc: '', skillType: 'MANUAL', durationType: 'AMMO', duration: 0, spType: 'INCREASE_WITH_TIME', spCost: 30, initSp: 10, maxChargeTime: 1, triggerRule: 'DEFAULT', bb: { atk: 0.5 } },
          talents: [{ name: '快速弹匣', desc: '攻速提升', bb: {} }],
        },
      }),
    };
  }
  if (String(url) === '/api/preview') return { ok: true, json: async () => ({ ok: true, warnings: [], errors: [], base: { chessId: 'chess_ws_x_a' }, golden: {} }) };
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

// app.js 被 import 时会自己载入并画一遍（load() + mountI18n()），下面直接用它的结果做断言。
await import('../editor/ui/app.js');
await tick();
await tick();

describe('干员表单：真跑一遍（最小 DOM 桩）', () => {
  test('载入后画出左栏与提示，不是一片空白', () => {
    assert.equal(calls[0].url, '/api/state');
    assert.match(textOf(packList), /演示包/);
    assert.match(textOf(opList), /我的干员/);
    assert.match(textOf(editorBox), /左边的列表中选一个工坊包/);
    assert.equal(rootPath.textContent, STATE.workshopRoot);
  });

  test('语言切换按钮被插进顶栏，且只有一个', () => {
    assert.equal(findAll(headerRow, (n) => n.id === 'btnLang').length, 1);
  });

  test('点「＋ 新建干员」：表单出来，带数值参照尺子与攻击范围小格阵', () => {
    fire(clickableWith(opList, '＋ 新建干员'), 'click');
    const form = textOf(editorBox);
    assert.match(form, /普通状态数值/);
    assert.match(form, /精锐状态数值/);
    assert.match(form, /攻击范围与伤害分类/);
    assert.match(form, /官方区间 900–1800（中位 1200）/, '生命值那一行要带官方区间');
    assert.match(form, /伤害类型 物理 · 攻击方式 远程 · 可打空中 是/, '伤害分类要按当前职业与分支推出来');
    // 攻击范围下拉里有官方形状（带一个用过它的干员当例子）
    const rangeSelect = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('格 · 例：'))[0];
    assert.ok(rangeSelect, '范围下拉里应该有带例子的官方形状');
    assert.match(textOf(rangeSelect), /3 格 · 例：阿米娅/);
    // 小格阵画出来了：画的是整个包围盒（含打不到的空格），干员自己那一格用亮色标出
    const squares = findAll(editorBox, (n) => String(n.attrs.style || '').includes('width:14px'));
    assert.equal(squares.length, 12, '默认远程范围是 x∈{-1,0,1} × y∈{0..3} = 3×4 的格子');
    assert.ok(squares.some((s) => String(s.attrs.style).includes('background:#5b9dff')), '干员自己那一格要标出来');
  });

  test('id 撞本包已有干员时立刻提示', async () => {
    const idInput = inputsOf(editorBox)[0];
    assert.equal(idInput.tagName, 'INPUT');
    fire(idInput, 'input', 'my_op');
    await new Promise((r) => setTimeout(r, 400)); // 校验是 250ms 防抖
    assert.match(textOf(editorBox), /这个 id 已被本包占用：chess_ws_my_op_a/);
    assert.ok(calls.some((c) => c.url === '/api/preview'), '防抖后应该真的去问了服务端');
  });

  test('点「⧉ 以模板新建」→ 选一个官方干员：spec 被填好，技能与天赋也带过来', async () => {
    fire(clickableWith(opList, '⧉ 以模板新建'), 'click');
    assert.match(textOf(editorBox), /官方干员（匹配 2 \/ 共 2）/);
    assert.match(textOf(editorBox), /复制本包的干员（1 个）/, '本包已有干员要能直接复制');

    fire(clickableWith(editorBox, '能天使'), 'click');
    await tick();
    await tick();
    assert.ok(calls.some((c) => c.url.includes('/api/operators/template?chessId=chess_char_2_1_a')), '应该去要模板');
    const form = textOf(editorBox);
    assert.match(form, /能天使/);
    // 技能名与天赋名是输入框的 value，不在文本里
    const values = inputsOf(editorBox).map((i) => i.value);
    assert.ok(values.includes('扫射'), '技能名要带过来');
    assert.ok(values.includes('快速弹匣'), '天赋名要带过来');
    assert.ok(values.includes('攻速提升'), '天赋说明也要带过来');
    assert.match(form, /char_1035_wisdel/, '外观（spine）要带过来');
    // 模板的 id 必须是空的：否则一保存就撞官方 id
    assert.equal(inputsOf(editorBox)[0].value, '');
  });

  test('切到英文界面后，新加的文案也真的变了', () => {
    fire(findAll(headerRow, (n) => n.id === 'btnLang')[0], 'click');
    const form = textOf(editorBox);
    assert.match(form, /Attack range and damage class/);
    assert.match(form, /Official 900–1800 \(median 1200\)/);
    assert.doesNotMatch(form, /攻击范围与伤害分类/);
  });
});
