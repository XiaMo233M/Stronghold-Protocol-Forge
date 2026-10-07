// test/operatorForm.test.js — 首页（干员编辑器）真跑一遍：用最小 DOM 桩把 app.js 载进来，喂一份假的 /api/state，
// 然后**真的去点**「新建干员」「以模板新建」，检查表单、数值参照尺子、攻击范围小格阵、id 冲突提示都画出来了。
//
// 为什么值得这么测：这个页面在仓库里没有任何浏览器测试，语法或运行期错误不会有任何东西拦得住——用户看到的是
// 一片空白。桩故意做得很笨（不做布局、不做选择器引擎），只保证「会不会抛异常」与「画出来的东西对不对」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { MODULE_ATTR_KEYS } from '../shared/chessAuthoring.js';

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
    append(...kids) { for (const k of kids) { if (k && typeof k === 'object') k.parent = el; el.children.push(k); } },
    replaceChildren(...kids) { for (const k of kids) if (k && typeof k === 'object') k.parent = el; el.children = [...kids]; },
    /** `ChildNode.after`（标准 DOM）：app.js 把「新建工坊包」面板插在 `header` 之后，桩 DOM 也得支持，否则一 import 就抛。 */
    after(...kids) {
      const p = el.parent;
      if (!p) return;
      const at = p.children.indexOf(el);
      for (const k of kids) if (k && typeof k === 'object') k.parent = p;
      p.children.splice(at < 0 ? p.children.length : at + 1, 0, ...kids);
    },
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
/** 同一行里的复选框（模组卡的「默认」那种：文字在行上，控件在行里）。 */
const checkboxInRow = (root, needle) => {
  const row = findAll(root, (n) => n.tagName === 'DIV' && String(n.className).includes('row') && textOf(n).includes(needle))[0];
  return row ? findAll(row, (n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox')[0] : null;
};
/** 更宽松的一版：文字与控件可以在 <label> 里（精锐三件套那三个开关），取最内层那个容器。 */
const checkboxNear = (root, needle) => {
  const holders = findAll(root, (n) => (n.children || []).some((c) => c.tagName === 'INPUT' && c.attrs && c.attrs.type === 'checkbox') && textOf(n).includes(needle));
  const holder = holders[holders.length - 1];
  return holder ? findAll(holder, (n) => n.tagName === 'INPUT' && n.attrs && n.attrs.type === 'checkbox')[0] : null;
};

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
    // 这个包自己写出来的盟约：干员页的盟约清单要把它一起列出来（并标上「本包」）
    bonds: [{ id: 'bond_ws_demo', name: '演示盟约' }],
  }],
  loadErrors: [],
  support: { pool: { 4: [] } },
  officialCount: 2,
  // 服务端的职业→分支联动表（`/api/state.subProfessions`）：干员页的分支下拉按它过滤
  subProfessions: [
    { id: 'caster', name: '术师', professions: ['CASTER'] },
    { id: 'fastshot', name: '速射手', professions: ['SNIPER'] },
    { id: 'bard', name: '吟游者', professions: ['SUPPORT'] },
  ],
  officialBonds: [
    { bondId: 'bond_apostle', name: '使徒', isCore: true },
    { bondId: 'bond_karlan', name: '卡西米尔', isCore: false },
  ],
  officialChess: [
    { id: 'chess_char_1_1_a', name: '阿米娅', appellation: 'Amiya', tier: 5, profession: 'CASTER', subProfessionId: 'caster', subProfessionName: '术师', position: 'RANGED', spine: 'char_002_amiya', rangeGrid: [[1, 0], [0, 0], [0, 1]], stats: { maxHp: 1500, atk: 480, def: 120, res: 10, cost: 18, blockCnt: 1, bat: 1.6 } },
    { id: 'chess_char_2_1_a', name: '能天使', appellation: 'Exusiai', tier: 6, profession: 'SNIPER', subProfessionId: 'fastshot', subProfessionName: '速射手', position: 'RANGED', spine: 'char_1035_wisdel', rangeGrid: [[1, 0], [0, 0], [0, 1], [0, 2]], stats: { maxHp: 1200, atk: 520, def: 100, res: 0, cost: 14, blockCnt: 1, bat: 1.0 } },
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
  // 试玩：GET 报「没在跑」，POST start 给一个 URL（真服务端就是这两个形状）
  if (String(url) === '/api/playtest') return { ok: true, json: async () => ({ running: false, url: null }) };
  if (String(url) === '/api/playtest/start') return { ok: true, json: async () => ({ running: true, port: 3312, url: 'http://127.0.0.1:3312/?sp_difficulty=normal' }) };
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
          // 模板带过来的盟约（官方记录里真的写着 bonds）：一条查得到，一条查不到（手写记录才会出现）
          bonds: ['bond_apostle', 'bond_missing'],
          stats: {
            normal: { maxHp: 1200, atk: 520, def: 100, res: 0, cost: 14, blockCnt: 1, bat: 1 },
            golden: { maxHp: 1560, atk: 676, def: 130, res: 0, cost: 14, blockCnt: 1, bat: 1 },
          },
          skill: { name: '扫射', desc: '', skillType: 'MANUAL', durationType: 'AMMO', duration: 0, spType: 'INCREASE_WITH_TIME', spCost: 30, initSp: 10, maxChargeTime: 1, triggerRule: 'DEFAULT', bb: { atk: 0.5 } },
          // descRaw 与 desc 不同：官方数据里 199 条天赋有 56 条是这样（富文本标记），
          // 记录里优先读 descRaw，所以「改了说明却没生效」这条陷阱必须靠界面同步两个字段来堵
          talents: [{ name: '快速弹匣', desc: '攻速提升', descRaw: '攻速<$ba.stun>提升</>', bb: {} }],
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

  // 上面一条把界面留在了英文。下面每条都以「点一下语言按钮」开头/结尾，把语言摆回它需要的那一侧。
  const langBtn = () => findAll(headerRow, (n) => n.id === 'btnLang')[0];
  const selectWith = (needle) => findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes(needle))[0];
  const waitPreview = () => new Promise((r) => setTimeout(r, 400));
  const lastPreviewSpec = () => calls.filter((c) => c.url === '/api/preview').pop().body.spec;

  test('职业 / 位置 / 分支都是中文下拉（英文界面换成英文名，分支退回 id）', () => {
    fire(langBtn(), 'click'); // 切回中文
    const prof = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('PIONEER') && textOf(n).includes('WARRIOR'))[0];
    assert.ok(prof, '职业下拉');
    assert.match(textOf(prof), /近卫 WARRIOR/);
    assert.match(textOf(prof), /重装 TANK/);
    assert.match(textOf(prof), /先锋 PIONEER/);
    const pos = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('MELEE') && textOf(n).includes('RANGED'))[0];
    assert.match(textOf(pos), /近战 MELEE/);
    assert.match(textOf(pos), /远程 RANGED/);
    // 分支下拉：中文名 · id —— 名字是给人看的，id 才是记录里写下去的那个值。
    // 模板是狙击职业，所以清单里**只有**狙击的分支（职业联动见后面那条用例）。
    const sub = selectWith('速射手 · fastshot');
    assert.ok(sub, '分支要有中文名下拉');
    assert.doesNotMatch(textOf(sub), /术师 · caster/, '别的职业的分支不该出现在清单里');
    assert.match(textOf(sub), /（不填：攻击方式与伤害类型只按职业推导）/);

    // 英文界面：数据里没有英文分支名，所以只列 id（猜一个英文名只会让人以为自己填错了）
    fire(langBtn(), 'click');
    const enSub = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('fastshot'))[0];
    assert.ok(enSub, '英文界面下分支下拉仍然在');
    assert.doesNotMatch(textOf(enSub), /速射手|术师/);
    assert.match(textOf(enSub), /empty: attack kind and damage type come from the profession alone/);
    fire(langBtn(), 'click'); // 后面按中文断言
    assert.ok(selectWith('速射手 · fastshot'), '切回中文后分支名也回来了');
  });

  test('攻击分类的覆盖：钉住一项会写进记录，清空就回到推导', async () => {
    const ovSel = selectWith('（推导：物理）');
    assert.ok(ovSel, '覆盖下拉的第一项要写明推导成了什么');
    calls.length = 0;
    fire(ovSel, 'change', 'arts');
    await waitPreview();
    assert.equal(lastPreviewSpec().dmgType, 'arts', '钉住的值要出现在发给服务端的 spec 里');
    assert.match(textOf(editorBox), /记录里会写：伤害类型 法术/, '要能看见真正会写进记录的值');
    // 清空＝把这个键从 spec 里删掉（留个空串会让记录变脏）
    calls.length = 0;
    fire(selectWith('（推导：物理）'), 'change', '');
    await waitPreview();
    assert.equal('dmgType' in lastPreviewSpec(), false);
    assert.match(textOf(editorBox), /记录里会写：伤害类型 物理/);
  });

  test('模组：加一个会默认勾上，attr 的键只能从真键里挑，数值提示按引擎的算术算', async () => {
    fire(findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('＋ 添加一个模组'))[0], 'click');
    await waitPreview(); // 「当前默认模组 → 写下去是多少」那一行是整页重画时算的（防抖 250ms）
    const form = textOf(editorBox);
    assert.match(form, /模组 modules/);
    assert.match(form, /当前默认模组/, '默认模组要有一行「精锐记录里写下去是多少」');
    // attr 的键是下拉：写错键名不会报错，但一个数值也不加，所以只能从真键里挑
    const attrSel = findAll(editorBox, (n) => n.tagName === 'SELECT' && MODULE_ATTR_KEYS.every((k) => textOf(n).includes(k)))[0];
    assert.ok(attrSel, 'attr 的键名要做成下拉');
    const attrRow = findAll(editorBox, (n) => String(n.className).includes('kv') && (n.children || []).some((c) => c === attrSel))[0];
    assert.ok(attrRow, 'attr 要有键值行');
    fire(attrRow.children[1], 'input', '100');
    await waitPreview();
    // 精锐 atk 676（模板值）+ 模组 100 = 776：这一行必须与引擎的 composeStats 一致
    assert.match(textOf(editorBox), /攻击 atk 676 → 776/);
    const spec = lastPreviewSpec();
    assert.equal(spec.modules.length, 1);
    assert.match(spec.modules[0].id, /^uniequip_ws_/);
    assert.equal(spec.modules[0].isDefault, true);
    assert.deepEqual(spec.modules[0].attr, { atk: 100 });
  });

  test('模组：取消默认会提示精锐按「不带模组」生成，删掉之后列表是空的', async () => {
    const cb = checkboxInRow(editorBox, '默认（精锐记录带的就是它）');
    assert.ok(cb, '默认模组的勾选框');
    assert.equal(cb.checked, true);
    cb.checked = false;
    fire(cb, 'change');
    await waitPreview();
    assert.match(textOf(editorBox), /没有勾「默认」/);
    assert.equal(lastPreviewSpec().modules[0].isDefault, false);

    const row = findAll(editorBox, (n) => n.tagName === 'DIV' && String(n.className).includes('row') && textOf(n).includes('默认（精锐记录带的就是它）'))[0];
    fire(findAll(row, (n) => n.tagName === 'BUTTON')[0], 'click');
    await waitPreview();
    assert.deepEqual(lastPreviewSpec().modules, []);
    assert.match(textOf(editorBox), /（一个模组都没有/);
  });

  test('改天赋说明会连 descRaw 一起改（否则记录里读的是原文，作者的修改静默无效）', async () => {
    const desc = inputsOf(editorBox).find((i) => i.value === '攻速提升');
    assert.ok(desc, '模板带过来的天赋说明');
    calls.length = 0;
    fire(desc, 'input', '攻速大幅提升');
    await waitPreview();
    const tal = lastPreviewSpec().talents[0];
    assert.equal(tal.desc, '攻速大幅提升');
    assert.equal(tal.descRaw, '攻速大幅提升', 'descRaw 必须跟着走：记录里优先读它');
  });

  test('盟约：模板带过来的是勾着的，勾选写进记录，查不到的 id 会警告', async () => {
    const cbOf = (needle) => {
      const label = findAll(editorBox, (n) => n.tagName === 'LABEL' && textOf(n).includes(needle))[0];
      return label ? findAll(label, (n) => n.tagName === 'INPUT')[0] : null;
    };
    assert.match(textOf(editorBox), /盟约 bonds/);
    assert.equal(cbOf('使徒（bond_apostle）').checked, true, '模板带过来的官方盟约要勾着');
    assert.equal(cbOf('卡西米尔（bond_karlan）').checked, false);
    assert.match(textOf(editorBox), /本包/, '本包的盟约要标出来');
    assert.match(textOf(editorBox), /这些 id 查不到对应的盟约/, '查不到的 id 要当场说，不能等试玩才发现');
    assert.match(textOf(editorBox), /bond_missing/);

    calls.length = 0;
    const packBond = cbOf('演示盟约（bond_ws_demo）');
    packBond.checked = true;
    fire(packBond, 'change');
    await waitPreview();
    assert.deepEqual([...lastPreviewSpec().bonds].sort(), ['bond_apostle', 'bond_missing', 'bond_ws_demo']);

    // 取消勾选会把它从记录里去掉（模板带来的官方盟约也是这么退出的）
    const official = cbOf('使徒（bond_apostle）');
    official.checked = false;
    fire(official, 'change');
    await waitPreview();
    assert.deepEqual([...lastPreviewSpec().bonds].sort(), ['bond_missing', 'bond_ws_demo']);
  });

  test('精锐三件套：不勾＝两态共用，勾上时以普通那份为起点、取消就删掉', async () => {
    // 面板在，三个开关默认都没勾（模板没带精锐那一份）
    assert.match(textOf(editorBox), /精锐（精英 2）与普通不同时/);
    const traitCb = checkboxNear(editorBox, '精锐特性不同');
    const rangeCb = checkboxNear(editorBox, '精锐攻击范围不同');
    const talentsCb = checkboxNear(editorBox, '精锐天赋不同');
    assert.ok(traitCb && rangeCb && talentsCb, '三个开关都要在');
    assert.equal(traitCb.checked, false);
    assert.equal(rangeCb.checked, false);
    assert.equal(talentsCb.checked, false);
    assert.match(textOf(editorBox), /（没勾：精锐沿用上面那份特性）/);

    // 特性：勾上 → spec 里出现 traitGolden，且起点是普通那份的文字
    calls.length = 0;
    traitCb.checked = true;
    fire(traitCb, 'change');
    await waitPreview();
    assert.equal(lastPreviewSpec().traitGolden.desc, '', '模板的普通特性文字是空的，精锐那份也就从空开始');
    // 改精锐特性文字：取「最内层那个含这个标签的容器」，否则会命中整页而拿到别的输入框
    const holders = findAll(editorBox, (n) => (n.children || []).length && textOf(n).includes('精锐特性文字'));
    const traitInput = findAll(holders[holders.length - 1], (n) => n.tagName === 'INPUT').pop();
    fire(traitInput, 'input', '精锐才有的一句话');
    await waitPreview();
    assert.equal(lastPreviewSpec().traitGolden.desc, '精锐才有的一句话');
    assert.notEqual(lastPreviewSpec().traitDesc, '精锐才有的一句话', '普通那份不能被动到');

    // 攻击范围：勾上 → rangeGridGolden 是普通范围的副本
    rangeCb.checked = true;
    fire(rangeCb, 'change');
    await waitPreview();
    assert.deepEqual(lastPreviewSpec().rangeGridGolden, [[1, 0], [0, 0], [0, 1], [0, 2]]);

    // 天赋：勾上 → talentsGolden 是天赋列表的深拷贝，改精锐那份不动普通那份
    talentsCb.checked = true;
    fire(talentsCb, 'change');
    await waitPreview();
    assert.equal(lastPreviewSpec().talentsGolden[0].name, '快速弹匣');
    const eliteTalents = inputsOf(editorBox).filter((i) => i.value === '快速弹匣');
    assert.equal(eliteTalents.length, 2, '普通与精锐各一个天赋名输入框');
    fire(eliteTalents[1], 'input', '精英弹匣');
    await waitPreview();
    assert.equal(lastPreviewSpec().talentsGolden[0].name, '精英弹匣');
    assert.equal(lastPreviewSpec().talents[0].name, '快速弹匣', '普通那份必须原样不动');

    // 取消勾选＝回到共用（字段删掉，而不是留一份与普通一样的数据）
    const off = (needle) => { const box = checkboxNear(editorBox, needle); box.checked = false; fire(box, 'change'); };
    off('精锐特性不同');
    await waitPreview();
    assert.equal('traitGolden' in lastPreviewSpec(), false);
    off('精锐攻击范围不同');
    await waitPreview();
    assert.equal('rangeGridGolden' in lastPreviewSpec(), false);
    off('精锐天赋不同');
    await waitPreview();
    assert.equal('talentsGolden' in lastPreviewSpec(), false);
  });

  test('干员自己的特性自带范围：普通与精锐各一个（精锐那个在「精锐特性不同」勾上之后）', async () => {
    // 普通那份：身份面板里的「特性自带范围」
    const plainSel = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（没有自带范围）'))[0];
    assert.ok(plainSel, '普通特性的自带范围下拉');
    const shape = plainSel.children.find((c) => c.value)?.value;
    fire(plainSel, 'change', shape);
    await waitPreview();
    assert.ok(Array.isArray(lastPreviewSpec().traitRangeGrid), '选中的形状写进 traitRangeGrid');
    assert.equal(lastPreviewSpec().traitRangeGrid.length > 0, true);

    // 精锐那份：勾上「精锐特性不同」之后才出现，默认继承普通（empty ＝ 与普通同一片）
    const traitCb = checkboxNear(editorBox, '精锐特性不同');
    traitCb.checked = true;
    fire(traitCb, 'change');
    await waitPreview();
    const eliteSel = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（与普通那份特性同一个范围）'))[0];
    assert.ok(eliteSel, '精锐特性的自带范围下拉');
    fire(eliteSel, 'change', eliteSel.children.find((c) => c.value)?.value);
    await waitPreview();
    assert.ok(Array.isArray(lastPreviewSpec().traitGolden.rangeGrid), '选中的形状写进 traitGolden.rangeGrid');
    fire(findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（与普通那份特性同一个范围）'))[0], 'change', '');
    await waitPreview();
    assert.equal('rangeGrid' in lastPreviewSpec().traitGolden, false, '清空＝精锐特性沿用普通那片范围');

    // 收尾：取消精锐特性、清掉普通那份的范围，别把状态留给后面的测试
    const cb = checkboxNear(editorBox, '精锐特性不同');
    cb.checked = false;
    fire(cb, 'change');
    await waitPreview();
    fire(findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（没有自带范围）'))[0], 'change', '');
    await waitPreview();
    assert.equal('traitRangeGrid' in lastPreviewSpec(), false);
  });

  test('模组的特性自带范围与天赋改写的范围都能编', async () => {
    fire(findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('＋ 添加一个模组'))[0], 'click');
    await waitPreview();
    // 特性自带范围：默认项写明「没有自带范围」，选一个真实形状后写进 modules[0].rangeGrid
    // （干员自己的特性也有一个同名下拉，且在它前面 —— 所以取最后一个，模组面板在页面最下面）
    const rangeSelects = () => findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（没有自带范围）'));
    assert.ok(rangeSelects().length >= 2, '干员特性与模组特性各有一个「自带范围」下拉');
    const traitRangeSel = rangeSelects().pop();
    const shape = traitRangeSel.children.find((c) => c.value)?.value;
    assert.ok(shape, '下拉里要有官方形状');
    fire(traitRangeSel, 'change', shape);
    await waitPreview();
    assert.ok(Array.isArray(lastPreviewSpec().modules[0].rangeGrid), '选中的形状要写进模组的 traitOverride');
    assert.ok(lastPreviewSpec().modules[0].rangeGrid.length > 0);
    // 清空＝删掉这个字段
    fire(rangeSelects().pop(), 'change', '');
    await waitPreview();
    assert.equal('rangeGrid' in lastPreviewSpec().modules[0], false);

    // 天赋改写那条自带的范围（官方「攻击范围扩大」模组靠它）
    fire(findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('＋ 添加一条天赋改写'))[0], 'click');
    await waitPreview();
    const chRangeSel = findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（不改范围）'))[0];
    assert.ok(chRangeSel, '天赋改写也要有自带范围的下拉');
    const shape2 = chRangeSel.children.find((c) => c.value)?.value;
    fire(chRangeSel, 'change', shape2);
    await waitPreview();
    assert.ok(Array.isArray(lastPreviewSpec().modules[0].talentChanges[0].rangeGrid));

    // 收尾：把这个模组删掉，别把状态留给后面的测试
    const row = findAll(editorBox, (n) => n.tagName === 'DIV' && String(n.className).includes('row') && textOf(n).includes('默认（精锐记录带的就是它）'))[0];
    fire(findAll(row, (n) => n.tagName === 'BUTTON')[0], 'click');
    await waitPreview();
    assert.deepEqual(lastPreviewSpec().modules, []);
  });

  test('分支按职业联动：换职业就换清单，值不属于新职业时当场说明（不静默清空）', async () => {
    const profSel = () => findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('NEAR') === false && textOf(n).includes('WARRIOR') && textOf(n).includes('PIONEER'))[0];
    const branchSel = () => findAll(editorBox, (n) => n.tagName === 'SELECT' && textOf(n).includes('（不填：攻击方式与伤害类型只按职业推导）'))[0];
    // 模板是狙击（fastshot）：清单里只有狙击的分支
    assert.match(textOf(branchSel()), /速射手 · fastshot/);
    assert.doesNotMatch(textOf(branchSel()), /术师 · caster/, '别的职业的分支不该出现在清单里');
    assert.match(textOf(editorBox), /只列「狙击」这个职业的分支（共 1 个）/);

    // 换成术师：清单立刻变成术师的分支，而旧值（fastshot）仍然留着并给出解释
    fire(profSel(), 'change', 'CASTER');
    await waitPreview();
    assert.match(textOf(branchSel()), /术师 · caster/);
    assert.doesNotMatch(textOf(branchSel()), /吟游者 · bard/, '别的职业的分支不该出现在清单里');
    assert.match(textOf(branchSel()), /速射手 · fastshot/, '但当前值要留在下拉里（不能静默清空）');
    assert.match(textOf(editorBox), /这个分支不属于「术师」，它属于 狙击/);
    // 「共 N 个」报的是**本职业真实的分支数**：留在清单里的旧值不算进去（旧值另有单独一句说明）；
    // 这条断言就是当初把 7 个分支写成「共 8 个」的那个错。
    assert.match(textOf(editorBox), /只列「术师」这个职业的分支（共 1 个）/);
    assert.match(textOf(editorBox), /它留在下拉里，不会被自动清掉/);
    assert.equal(findAll(branchSel(), (n) => n.tagName === 'OPTION').length, 3, '两个分支 + 「不填」那一项');
    assert.equal(lastPreviewSpec().subProfessionId, 'fastshot', '换职业不会动记录里的分支');

    // 手填一个官方分支表里没有的值：同一句「不静默清空」也要出现（这时没有「它属于谁」可说）
    const subInput = findAll(editorBox, (n) => n.tagName === 'INPUT' && n.attrs?.placeholder === '如 fastshot / fortress / bard')[0];
    fire(subInput, 'input', 'ghostbranch');
    await waitPreview();
    assert.match(textOf(branchSel()), /ghostbranch/, '手写的分支也要留在下拉里');
    assert.match(textOf(editorBox), /当前值「ghostbranch」不在官方分支表里，仍留在下拉里（不静默清空）/);
    assert.doesNotMatch(textOf(editorBox), /这个分支不属于/, '官方表里没有这个 id，就不该说它属于哪个职业');
    assert.equal(lastPreviewSpec().subProfessionId, 'ghostbranch');

    // 选一个属于本职业的分支 → 警告消失
    fire(branchSel(), 'change', 'caster');
    await waitPreview();
    assert.doesNotMatch(textOf(editorBox), /这个分支不属于/);
    assert.equal(lastPreviewSpec().subProfessionId, 'caster');

    // 回到模板的状态，别把状态留给后面的测试
    fire(profSel(), 'change', 'SNIPER');
    await waitPreview();
    fire(branchSel(), 'change', 'fastshot');
    await waitPreview();
    assert.equal(lastPreviewSpec().subProfessionId, 'fastshot');
  });

  test('自己画攻击范围：画板点格子写进记录，原点删不掉，「回到推导」清掉自定义', async () => {
    // 注意：特性自带范围那一段也有「✎ 自己画」，所以这里必须**限定在「范围/分类」这一段里**找
    const rangeSec = () => findAll(editorBox, (n) => n.tagName === 'DETAILS' && n.id === 'sec-range')[0];
    const openBtn = () => findAll(rangeSec(), (n) => n.tagName === 'BUTTON' && textOf(n).includes('✎ 自己画'))[0];
    assert.ok(openBtn(), '要有「自己画」的入口');
    fire(openBtn(), 'click');
    const cells = () => findAll(rangeSec(), (n) => String(n.className).includes('pcell'));
    assert.equal(cells().length, 7 * 9, '画板是 7×9 格（x∈[-3,3]、y∈[-2,6]）');
    assert.match(textOf(rangeSec()), /已点亮 4 格/, '模板带来的范围已经在板上');

    // 点一个当前不在范围里的格子：x=2,y=0 → 第 2 行第 6 列（0 基）
    calls.length = 0;
    fire(cells()[2 * 7 + 5], 'click');
    await waitPreview();
    const spec = lastPreviewSpec();
    assert.equal(spec.rangeGrid.length, 5);
    assert.ok(spec.rangeGrid.some((c) => c[0] === 2 && c[1] === 0), '点亮的格子要写进 rangeGrid');

    // 原点（自己那一格）去不掉：点了还是 5 格
    fire(cells()[2 * 7 + 3], 'click');
    await waitPreview();
    assert.equal(lastPreviewSpec().rangeGrid.length, 5);

    // 再点一次刚才那一格 → 取消，回到 4 格
    fire(cells()[2 * 7 + 5], 'click');
    await waitPreview();
    assert.equal(lastPreviewSpec().rangeGrid.length, 4);

    // 回到推导：字段删掉，界面回到「推导/预设」
    fire(findAll(rangeSec(), (n) => n.tagName === 'BUTTON' && textOf(n).includes('回到推导'))[0], 'click');
    await waitPreview();
    assert.equal('rangeGrid' in lastPreviewSpec(), false);
    assert.match(textOf(rangeSec()), /当前是推导\/预设/);
  });

  test('长表单：顶部有「跳到」，不常改的段落默认收起（身份是展开的）', () => {
    assert.match(textOf(editorBox), /跳到：/);
    const det = (id) => findAll(editorBox, (n) => n.tagName === 'DETAILS' && n.id === `sec-${id}`)[0];
    assert.equal(det('identity').attrs.open, true, '身份默认展开');
    assert.equal(det('range').attrs.open, true, '范围/分类默认展开');
    for (const id of ['elite', 'modules', 'bonds']) {
      assert.ok(det(id), `要有 ${id} 这一段`);
      assert.equal(det(id).attrs.open, undefined, `${id} 默认收起（渐进披露）`);
    }
    assert.ok(findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('模组')).length >= 1, '「跳到」条上要能点过去');
  });

  test('数值一键按官方中位填入（白纸起手时最省事的一步）', async () => {
    const btns = () => findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('按官方中位填入'));
    assert.equal(btns().length, 2, '普通与精锐各有自己的「按官方中位填入」');
    calls.length = 0;
    fire(btns()[0], 'click');
    await waitPreview();
    // 尺子里的中位：maxHp 1200 / atk 520 / def 100 / res 0 / cost 14 / blockCnt 1 / bat 1
    const pick = (st) => ({ maxHp: st.maxHp, atk: st.atk, def: st.def, res: st.res, cost: st.cost, blockCnt: st.blockCnt, bat: st.bat });
    assert.deepEqual(pick(lastPreviewSpec().stats.normal),
      { maxHp: 1200, atk: 520, def: 100, res: 0, cost: 14, blockCnt: 1, bat: 1 });
    assert.equal(lastPreviewSpec().stats.golden.maxHp, 1560, '第一颗按钮只填「普通状态数值」那一栏');
    // 精锐那一栏有它自己的按钮
    fire(findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('按官方中位填入'))[1], 'click');
    await waitPreview();
    assert.equal(lastPreviewSpec().stats.golden.atk, 520);
  });

  test('保存旁边就能起一局试玩（省掉「切到包管理页」那两步）', async () => {
    const opened = [];
    globalThis.window = { open: (u) => { opened.push(u); } };
    try {
      calls.length = 0;
      fire(findAll(editorBox, (n) => n.tagName === 'BUTTON' && textOf(n).includes('▶ 试玩'))[0], 'click');
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(calls.some((c) => c.url === '/api/playtest/start'), '要真的去起服务器');
      assert.deepEqual(opened, ['http://127.0.0.1:3312/?sp_difficulty=normal'], '在浏览器里打开它');
      assert.match(textOf(editorBox), /试玩服务器已就绪/);
    } finally {
      delete globalThis.window;
    }
  });
});
