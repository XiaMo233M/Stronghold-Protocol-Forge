// test/operatorWizard.test.js — 首页「新建干员」的纯逻辑（editor/ui/operatorWizard.js）。
//
// 新建这一步错了，后果不是页面难看，而是包里多出一份不该存在的记录（改 id 保存会留旧记录、id 撞了会被引擎丢弃）。
// 所以这些判断全部做成不碰 DOM 的纯函数，在这里逐条钉住；界面只负责画。
// 顺带钉住一件事：这个模块 import 的 `../../shared/statReference.js` 在浏览器与 node 下必须是同一个文件
// （编辑器服务端把 /shared/ 也挂给了界面，这条路径两边都解析得到）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchOperators, idConflict, renameNotice,
  subProfessionChoices, subProfessionOptions, bondChoicesOf, rangePresets, gridKey, sameGrid, gridMatrix,
} from '../editor/ui/operatorWizard.js';

const OFFICIAL = [
  { id: 'chess_char_1_1_a', name: '阿米娅', appellation: 'Amiya', profession: 'CASTER', subProfessionId: 'caster', rangeGrid: [[1, 0], [1, 1], [0, 0], [0, 1], [0, 2]] },
  { id: 'chess_char_2_1_a', name: '能天使', appellation: 'Exusiai', profession: 'SNIPER', subProfessionId: 'fastshot', rangeGrid: [[1, 0], [1, 1], [0, 0], [0, 1], [0, 2], [0, 3], [-1, 0], [-1, 1], [-1, 2]] },
  { id: 'chess_char_3_1_a', name: '克洛丝', appellation: 'Kroos', profession: 'SNIPER', subProfessionId: 'fastshot', rangeGrid: [[1, 1], [1, 0], [0, 0], [0, 1], [0, 2], [0, 3], [-1, 0], [-1, 1], [-1, 2]] },
  { id: 'chess_char_4_1_a', name: '玫兰莎', appellation: 'Melantha', profession: 'WARRIOR', subProfessionId: '', rangeGrid: [[0, 0], [0, 1]] },
];

describe('新建干员：模板挑选与 id 检查', () => {
  test('matchOperators 按名称/代号/id 匹配，大小写不敏感', () => {
    assert.equal(matchOperators(OFFICIAL, '').length, 4);
    assert.deepEqual(matchOperators(OFFICIAL, '能天使').map((o) => o.id), ['chess_char_2_1_a']);
    assert.deepEqual(matchOperators(OFFICIAL, 'exus').map((o) => o.id), ['chess_char_2_1_a']);
    assert.deepEqual(matchOperators(OFFICIAL, 'CHAR_3_1').map((o) => o.id), ['chess_char_3_1_a']);
    assert.deepEqual(matchOperators(OFFICIAL, '  阿米娅  ').map((o) => o.id), ['chess_char_1_1_a']);
    assert.deepEqual(matchOperators(OFFICIAL, '不存在的干员'), []);
    assert.deepEqual(matchOperators(null, 'x'), []);
    // 不改动输入顺序（服务端已按阶与 id 排好），也不返回同一个数组
    const out = matchOperators(OFFICIAL, '');
    assert.notEqual(out, OFFICIAL);
    assert.deepEqual(out.map((o) => o.id), OFFICIAL.map((o) => o.id));
  });

  test('idConflict 分开报「撞本包」与「撞官方」', () => {
    assert.equal(idConflict('', { packSlugs: ['a'] }), null);
    assert.equal(idConflict('fresh', { packSlugs: ['a'], officialIds: ['chess_char_1_1_a'] }), null);
    assert.deepEqual(idConflict('a', { packSlugs: ['a'] }), { kind: 'pack', slug: 'a', id: 'chess_ws_a_a' });
    // 官方数据里真出现同名 workshop id 时才算撞（记录会被引擎丢弃，除非声明 overrides）
    assert.deepEqual(idConflict('a', { officialIds: new Set(['chess_ws_a_a']) }), { kind: 'official', slug: 'a', id: 'chess_ws_a_a' });
    assert.deepEqual(idConflict('a', { officialIds: new Set(['chess_ws_a_b']) }), { kind: 'official', slug: 'a', id: 'chess_ws_a_a' });
    assert.equal(idConflict('a', {}), null);
  });

  test('renameNotice 只在真的改了 id 时提醒', () => {
    assert.deepEqual(renameNotice('old', 'new'), { from: 'old', to: 'new' });
    assert.equal(renameNotice('same', 'same'), null);
    assert.equal(renameNotice(null, 'new'), null, '新建时没有「原记录」可提醒');
    assert.equal(renameNotice('old', ''), null, 'id 被清空时不该说「改了 id」');
    assert.deepEqual(renameNotice(' old ', ' new '), { from: 'old', to: 'new' });
  });
});

describe('新建干员：分支候选与攻击范围', () => {
  test('subProfessionOptions 给每个分支配上中文名（同一个分支取有名字的那一份）', () => {
    const list = [
      { subProfessionId: 'fastshot' },                                   // 没名字的先遇到
      { subProfessionId: 'fastshot', subProfessionName: '速射手' },       // 有名字的在后面：不能被前一条盖成空
      { subProfessionId: 'caster', subProfessionName: '术师' },
      { subProfessionId: 'bard', subProfessionName: '吟游者' },
      { subProfessionId: '  ' },                                          // 空 id 丢掉
      { subProfessionId: 'mystic' },                                      // 数据里没写名字：name 是空串，界面退回显示 id
    ];
    // 顺序按中文名（`localeCompare('zh')`，也就是拼音序）：作者在长长的分支清单里找的是「速射手」三个字，
    // 不是 `fastshot` 这个 id。没有中文名的排到最后（按 id 比）。
    assert.deepEqual(subProfessionOptions(list), [
      { id: 'caster', name: '术师' },
      { id: 'fastshot', name: '速射手' },
      { id: 'bard', name: '吟游者' },
      { id: 'mystic', name: '' },
    ]);
    assert.deepEqual(subProfessionOptions(null), []);
  });

  test('subProfessionChoices 去重、排序、丢掉空值', () => {
    assert.deepEqual(subProfessionChoices(OFFICIAL), ['caster', 'fastshot']);
    assert.deepEqual(subProfessionChoices(null), []);
    assert.deepEqual(subProfessionChoices([{ subProfessionId: '  ' }, { subProfessionId: 'bard' }]), ['bard']);
  });

  test('bondChoicesOf 合并官方与本包的盟约：同 id 用包里的名字，位置留在官方那一条', () => {
    const official = [
      { bondId: 'bond_apostle', name: '使徒', isCore: true },
      { bondId: 'bond_karlan', name: '卡西米尔' },
    ];
    const pack = [
      { id: 'bond_apostle', name: '使徒（本包改过）' },
      { id: 'bond_ws_demo', name: '演示盟约' },
    ];
    assert.deepEqual(bondChoicesOf(official, pack), [
      { id: 'bond_apostle', name: '使徒（本包改过）', from: 'pack' },
      { id: 'bond_karlan', name: '卡西米尔', from: 'official' },
      { id: 'bond_ws_demo', name: '演示盟约', from: 'pack' },
    ]);
    assert.deepEqual(bondChoicesOf(null, null), []);
    // 只有 id 没有名字时用 id 顶上（界面上不能出现空白的一行）
    assert.deepEqual(bondChoicesOf([{ bondId: 'bond_x' }], [{ id: 'bond_y' }]), [
      { id: 'bond_x', name: 'bond_x', from: 'official' },
      { id: 'bond_y', name: 'bond_y', from: 'pack' },
    ]);
  });

  test('rangePresets 按形状去重，并配一个用过它的干员当例子', () => {
    const presets = rangePresets(OFFICIAL);
    // 能天使与克洛丝的坐标顺序不同，但是同一片形状 —— 必须只算一种
    assert.equal(presets.length, 3);
    const sizes = presets.map((p) => p.count);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), '按格数从小到大排，便于辨认');
    const two = presets.find((p) => p.count === 2);
    assert.equal(two.sample.name, '玫兰莎');
    assert.equal(presets.find((p) => p.count === 9).sample.name, '能天使', '同形状取先遇到的样本');
    assert.deepEqual(rangePresets(null), []);
    assert.deepEqual(rangePresets([{ id: 'x', rangeGrid: [] }, { id: 'y' }]), []);
  });

  test('gridKey / sameGrid 与坐标顺序无关', () => {
    assert.equal(gridKey([[0, 0], [0, 1]]), gridKey([[0, 1], [0, 0]]));
    assert.equal(sameGrid([[0, 0], [0, 1]], [[0, 1], [0, 0]]), true);
    assert.equal(sameGrid([[0, 0]], [[0, 1]]), false);
    assert.equal(gridKey(null), '');
  });

  test('gridMatrix 排出能画的矩阵，并把 (0,0) 的位置标出来', () => {
    const m = gridMatrix([[0, 0], [0, 1]]);
    assert.equal(m.rows, 2);
    assert.equal(m.cols, 1);
    assert.deepEqual(m.cells, [[true], [true]]);
    assert.deepEqual(m.origin, { x: 0, y: 0 });

    // 负坐标也要装得下：x 从 -1 开始、y 从 -1 开始
    const wide = gridMatrix([[-1, -1], [0, 0], [1, 1]]);
    assert.equal(wide.rows, 3);
    assert.equal(wide.cols, 3);
    assert.deepEqual(wide.origin, { x: 1, y: 1 }, '(0,0) 落在矩阵中间');
    assert.deepEqual(wide.cells, [[true, false, false], [false, true, false], [false, false, true]]);

    assert.equal(gridMatrix([]), null);
    assert.equal(gridMatrix(null), null);
    assert.equal(gridMatrix([['a', 'b']]), null);
  });
});
