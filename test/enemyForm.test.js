// test/enemyForm.test.js — 怪物编辑器页真跑一遍：用最小 DOM 桩把 enemy.js 载进来，喂一份假的 /api/enemies，
// 然后真的去点「新建怪物」「以模板新建」，检查数值尺子、spine 候选与校验提示、模板预填都到位。
//
// 和 operatorForm.test.js 同一套路。加这一条的理由也一样：这一页在仓库里没有浏览器测试，
// 语法或运行期错误只会让用户看到一片空白，而新建与 spine 恰好是最容易静默出错的两件事。
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
    innerHTML: '',
    title: '',
    type: '',
    step: '',
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    // 真 DOM 的 append 会把字符串变成文本节点；这里照做，否则 textOf 看不到这些文字
    append(...kids) { for (const k of kids) el.children.push(typeof k === 'string' ? { nodeType: 3, text: k } : k); },
    replaceChildren(...kids) { el.children = [...kids]; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    focus() { doc.activeElement = el; },
    setSelectionRange() {},
    querySelectorAll(sel) {
      const want = String(sel).split(',').map((s) => s.trim().toUpperCase());
      return findAll(el, (n) => want.includes(n.tagName));
    },
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
/** 第一个「文字里含某串」的可点元素。注意：本页的左栏条目与选择器条目是用 textContent 建的（没有子元素），
 *  另一些是用 innerHTML 建的，所以这里不能要求「有子元素」，只按文字找。 */
const clickableWith = (root, needle) => findAll(root, (n) => String(n.className).split(/\s+/).includes('item') && textOf(n).includes(needle))[0]
  || findAll(root, (n) => n.tagName === 'BUTTON' && textOf(n).includes(needle))[0];
const inputsOf = (root) => findAll(root, (n) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName));

const doc = makeEl('html');
doc.documentElement = makeEl('html');
doc.title = '卫戍协议 · 工坊怪物编辑器';
doc.activeElement = null;
doc.createElement = (tag) => makeEl(tag);
doc.createTextNode = (text) => ({ nodeType: 3, text: String(text) });
doc.getElementById = (id) => findAll(doc, (n) => n.id === id)[0] ?? null;

const rootPath = makeEl('span'); rootPath.id = 'rootPath';
const listBox = makeEl('div'); listBox.id = 'list';
const formBox = makeEl('div'); formBox.id = 'form';
const sideBox = makeEl('div'); sideBox.id = 'side';
const header = makeEl('header');
const headerRow = makeEl('div'); headerRow.className = 'row'; header.append(headerRow);
const btnReload = makeEl('button'); btnReload.id = 'btnReload';
const btnNew = makeEl('button'); btnNew.id = 'btnNew';
headerRow.append(btnReload, btnNew);
doc.append(rootPath, listBox, formBox, sideBox, header);
doc.querySelector = (sel) => ({
  '#rootPath': rootPath, '#list': listBox, '#form': formBox, '#side': sideBox,
  'header .row': headerRow, header, '#btnReload': btnReload, '#btnNew': btnNew,
}[sel] ?? null);
doc.querySelectorAll = () => [];

globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const VOCAB = {
  ranks: ['NORMAL', 'ELITE', 'BOSS'],
  applyWays: ['MELEE', 'RANGED', 'NONE', 'ALL'],
  dmgTypes: ['phys', 'arts', 'none'],
  motions: ['WALK', 'FLY'],
  acTypes: ['SPECIAL', 'ELEMENT'],
  immunities: ['stun', 'silence'],
  statDefaults: { maxHp: 1000, atk: 0, def: 0, res: 0, moveSpeed: 1, bat: 1, aspd: 100, rangeRadius: 0, blockCnt: 1, massLevel: 0, lpr: 1, hpRecoveryPerSec: 0, elementRes: 0, elementDmgRes: 0, hitRatePhys: 0, hitRateArts: 0, tauntLevel: 0 },
};

const SPINE_OK = 'enemy_1007_slime';
const STATE = {
  enemies: [{
    pack: 'demo-pack', key: 'enemy_ws_mine', name: '我的怪', rank: 'NORMAL', applyWay: 'MELEE', motion: 'WALK',
    dmgType: 'phys', isFlyEnemy: false, tokenOnly: false, attrPower: 100, be: 100, abilities: 1, skills: 0,
    managed: true, issues: [],
  }],
  vocab: VOCAB,
  officialEnemies: [SPINE_OK, 'enemy_1045_hammer'],
  officialTemplates: [
    { key: SPINE_OK, name: '源石虫', rank: 'NORMAL', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys', spine: SPINE_OK, stats: { maxHp: 1000, atk: 100, def: 0, res: 0, moveSpeed: 1, bat: 1 } },
    { key: 'enemy_1045_hammer', name: '重装防御者', rank: 'ELITE', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys', spine: 'enemy_1045_hammer', stats: { maxHp: 4000, atk: 400, def: 300, res: 0, moveSpeed: 0.8, bat: 2 } },
  ],
  spineChoices: [{ id: SPINE_OK, name: '源石虫' }, { id: 'enemy_1045_hammer', name: '重装防御者' }],
  statRanges: {
    NORMAL: { maxHp: { min: 500, p50: 1200, max: 4000, count: 120 }, atk: { min: 0, p50: 200, max: 900, count: 120 } },
    ELITE: { maxHp: { min: 2000, p50: 6000, max: 20000, count: 80 }, atk: { min: 100, p50: 500, max: 1500, count: 80 } },
  },
};

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (String(url) === '/api/enemies') return { ok: true, json: async () => STATE };
  if (String(url).startsWith('/api/enemies/template')) {
    return {
      ok: true,
      json: async () => ({
        ok: true, key: 'enemy_1045_hammer',
        spec: {
          id: '', name: '重装防御者', rank: 'ELITE', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys',
          desc: '精英怪', stats: { maxHp: 4000, atk: 400, def: 300, res: 0, moveSpeed: 0.8, bat: 2, aspd: 100, rangeRadius: 0, blockCnt: 1, massLevel: 0, lpr: 1, hpRecoveryPerSec: 0, elementRes: 0, elementDmgRes: 0, hitRatePhys: 0, hitRateArts: 0, tauntLevel: 0 },
          abilities: [{ text: '受到攻击时反弹伤害' }], talents: { bb: {} }, skills: [], tags: ['elite'], immunities: {}, otherImmunities: [],
          acTypes: [], acType: null, spine: 'enemy_1045_hammer', modelScale: null, hitArea: null, attackAnim: null, beFactor: 1,
          notCountInTotal: false, isFlyEnemy: false,
        },
      }),
    };
  }
  if (String(url) === '/api/enemies/preview') {
    // 真实服务端一定回一份带派生量的 record（renderSide 会读它）；桩也照着给，不然测的是不存在的场景
    return {
      ok: true,
      json: async () => ({
        ok: true, errors: [], warnings: [],
        record: { stats: { dmgTypes: ['phys'] }, attrPower: 1200, be: 1200, beFactor: 1, isFlyEnemy: false },
      }),
    };
  }
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

await import('../editor/ui/enemy.js');
await tick();
await tick();

describe('怪物表单：真跑一遍（最小 DOM 桩）', () => {
  test('载入后画出左栏与提示', () => {
    assert.equal(calls[0].url, '/api/enemies');
    const mine = findAll(listBox, (n) => String(n.className).split(/\s+/).includes('item') && /我的怪/.test(n.innerHTML))[0];
    assert.ok(mine, '左栏应该列出包里的怪物');
    assert.match(mine.innerHTML, /enemy_ws_mine/);
    assert.match(textOf(formBox), /左边选一只怪物，或点「新建怪物」。/);
    assert.match(rootPath.textContent, /1 只工坊怪物/);
  });

  test('点「＋ 新建怪物」：数值下面有官方区间尺子，spine 有候选与提示', () => {
    fire(clickableWith(listBox, '＋ 新建怪物'), 'click');
    const form = textOf(formBox);
    assert.match(form, /数值 stats/);
    assert.match(form, /官方区间 500–4000（中位 1200）/, '普通档位应该显示普通怪的区间');
    assert.match(form, /细线上的刻度是官方同档位怪物的区间（共 120 只）/);
    assert.match(form, /留空则用占位模型/, 'spine 留空时要说清后果');
    // spine 的候选来自服务端，且挂在 datalist 上
    const spineInput = inputsOf(formBox).find((i) => i.getAttribute('list') === 'spineOptions');
    assert.ok(spineInput, 'spine 输入框要挂 datalist');
    const dl = findAll(formBox, (n) => n.tagName === 'DATALIST' && n.id === 'spineOptions')[0];
    assert.equal(dl.children.length, 2, 'datalist 里应该是服务端给的两个 prefab 候选');
    assert.equal(dl.children[0].value, SPINE_OK);
  });

  test('spine 填错时当场警告（这是本页唯一一个填错不报错的字段）', () => {
    const spineInput = inputsOf(formBox).find((i) => i.getAttribute('list') === 'spineOptions');
    fire(spineInput, 'input', 'enemy_0000_typo');
    assert.match(textOf(formBox), /这个 prefab 键不在官方清单里/);
    fire(spineInput, 'input', SPINE_OK);
    assert.match(textOf(formBox), /是官方 prefab 键/);
  });

  test('点「⧉ 以模板新建」→ 选一只官方怪：数值、能力文字与 spine 都被带过来', async () => {
    fire(clickableWith(listBox, '⧉ 以模板新建'), 'click');
    assert.match(textOf(formBox), /官方怪物（匹配 2 \/ 共 2）/);
    assert.match(textOf(formBox), /复制本包的怪物（1 只）/);

    const elite = findAll(formBox, (n) => n.className === 'item' && /重装防御者/.test(n.innerHTML))[0];
    assert.ok(elite, '官方模板列表里应该有重装防御者');
    fire(elite, 'click');
    await tick();
    await tick();
    assert.ok(calls.some((c) => c.url.includes('/api/enemies/template?key=enemy_1045_hammer')), '应该去要模板');
    const form = textOf(formBox);
    assert.match(form, /官方区间 2000–20000（中位 6000）/, '档位换成 ELITE 后尺子要跟着换');
    assert.match(form, /是官方 prefab 键/);
    // 名字与能力文字在输入框/文本域的 value 里，不在文本里
    const values = inputsOf(formBox).map((i) => i.value);
    assert.ok(values.includes('重装防御者'), '名字要带过来');
    assert.ok(values.some((v) => String(v).includes('受到攻击时反弹伤害')), '能力文字要带过来');
    // 模板的 id 必须是空的：否则一保存就覆盖原来那只
    const idInput = inputsOf(formBox)[0];
    assert.equal(idInput.value, '');
  });

  test('切到英文界面后页面的文案真的变了', () => {
    fire(findAll(headerRow, (n) => n.id === 'btnLang')[0], 'click');
    const form = textOf(formBox);
    assert.match(form, /Art and off-datatable fields/);
    assert.match(form, /A real official prefab key/);
    assert.doesNotMatch(form, /美术与非数据表字段/);
  });
});
