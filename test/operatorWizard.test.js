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
  subProfessionChoices, subProfessionOptions, subProfessionOptionsFor, professionsOfSub, bondChoicesOf,
  rangePresets, gridKey, sameGrid, gridMatrix,
  PAINTER_COLS, PAINTER_ROWS, PAINTER_ORIGIN, painterCellAt, painterPositionOf, gridKeySet, sortGrid,
  toggleGridCell, outsidePainterCount,
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

describe('新建干员：分支按职业联动（服务端的 subProfessions 形状）', () => {
  // 服务端 /api/state.subProfessions 的形状：从**全部**记录算出来，所以可见数据里没出现过的
  // `pusher`（推击手，只在一条不可见记录上）也在里面。
  const LIST = [
    { id: 'fastshot', name: '速射手', professions: ['SNIPER'] },
    { id: 'closerange', name: '重射手', professions: ['SNIPER'] },
    { id: 'bard', name: '吟游者', professions: ['SUPPORT'] },
    { id: 'pusher', name: '推击手', professions: ['SPECIAL'] },
    { id: 'caster', name: '术师', professions: ['CASTER'] },
    { id: 'weird', name: '', professions: [] },
  ];

  test('subProfessionOptionsFor 只留这个职业的分支，顺序照抄服务端（按中文名）', () => {
    // `weird` 的 professions 是空的（数据里没有它）—— 它**不**因为过滤而消失，所以断言时先把它摘掉
    const idsFor = (prof) => subProfessionOptionsFor(LIST, prof).map((o) => o.id).filter((id) => id !== 'weird');
    assert.deepEqual(idsFor('SNIPER'), ['fastshot', 'closerange']);
    assert.deepEqual(idsFor('SUPPORT'), ['bard']);
    assert.deepEqual(idsFor('SPECIAL'), ['pusher'], '可见数据里没有的分支（推击手）也要能选到');
    assert.deepEqual(idsFor('CASTER'), ['caster']);
    assert.deepEqual(idsFor('WARRIOR'), [], '这个职业没有分支时给空清单，而不是把别人的分支端上来');
    assert.deepEqual(subProfessionOptionsFor(LIST, 'SNIPER').find((o) => o.id === 'weird'), { id: 'weird', name: '' });
    // 不给职业 = 全部（职业还没填时）
    assert.equal(subProfessionOptionsFor(LIST, '').length, 6);
    assert.equal(subProfessionOptionsFor(LIST, undefined).length, 6);
    // 大小写与空白照旧容忍（记录里是大写枚举）
    assert.deepEqual(idsFor(' sniper '), ['fastshot', 'closerange']);
    assert.deepEqual(subProfessionOptionsFor(null, 'SNIPER'), []);
  });

  test('professionsOfSub 说明「这个分支属于哪个职业」（用来解释职业与分支对不上）', () => {
    assert.deepEqual(professionsOfSub(LIST, 'bard'), ['SUPPORT']);
    assert.deepEqual(professionsOfSub(LIST, 'pusher'), ['SPECIAL']);
    assert.deepEqual(professionsOfSub(LIST, 'nope'), [], '未知分支不做判断');
    assert.deepEqual(professionsOfSub(LIST, ''), []);
    assert.deepEqual(professionsOfSub(null, 'bard'), []);
  });
});

describe('新建干员：自己画攻击范围（画板坐标）', () => {
  test('画板尺寸与原点：x∈[-3,3]、y∈[-2,6]，(0,0) 在 (3,2)', () => {
    assert.equal(PAINTER_COLS, 7);
    assert.equal(PAINTER_ROWS, 9);
    assert.deepEqual(PAINTER_ORIGIN, { col: 3, row: 2 });
    assert.deepEqual(painterCellAt(3, 2), { x: 0, y: 0 });
    assert.deepEqual(painterCellAt(0, 0), { x: -3, y: -2 });
    assert.deepEqual(painterCellAt(6, 8), { x: 3, y: 6 });
    assert.equal(painterCellAt(7, 0), null, '越界不给坐标');
    assert.equal(painterCellAt(-1, 0), null);
    assert.equal(painterCellAt(1.5, 0), null);
    // 反查：坐标 → 格子
    assert.deepEqual(painterPositionOf(0, 0), { col: 3, row: 2 });
    assert.deepEqual(painterPositionOf(-3, -2), { col: 0, row: 0 });
    assert.equal(painterPositionOf(4, 0), null, '画板外（手写的超大范围）');
    assert.equal(painterPositionOf(NaN, 0), null);
    // 官方数据里的范围都画得下：x∈[-2,2]、y∈[-2,5] 落在板内
    for (const [x, y] of [[-2, -2], [2, 5], [0, 5], [-2, 5]]) assert.ok(painterPositionOf(x, y), `${x},${y} 应该在画板内`);
  });

  test('toggleGridCell 点亮/点灭，并保持排序去重', () => {
    assert.deepEqual(toggleGridCell([], 0, 0), [[0, 0]]);
    assert.deepEqual(toggleGridCell([[0, 0]], 0, 1), [[0, 0], [0, 1]]);
    assert.deepEqual(toggleGridCell([[0, 0], [0, 1]], 0, 1), [[0, 0]]);
    // 原点删不掉：干员必须站在自己的范围内（空范围谁都打不到，而引擎不会为此报错）
    assert.deepEqual(toggleGridCell([[0, 0]], 0, 0), [[0, 0]]);
    // 乱序输入 → 稳定输出，且重复格不会变成两条
    assert.deepEqual(toggleGridCell([[0, 2], [-1, 0], [0, 2]], 0, 2), [[-1, 0]]);
    assert.deepEqual(sortGrid([[1, 0], [-1, 2], [1, 0]]), [[1, 0], [-1, 2]]);
    assert.deepEqual(sortGrid(null), []);
    // 非法格子被丢掉，而不是写进记录
    assert.deepEqual(sortGrid([[0, 0], ['a', 1], [1]]), [[0, 0]]);
  });

  test('gridKeySet / outsidePainterCount 认得画板外的格子', () => {
    const set = gridKeySet([[0, 0], [1, 2]]);
    assert.equal(set.has('0,0'), true);
    assert.equal(set.has('2,1'), false, '键是 x,y（不是 y,x）');
    assert.equal(outsidePainterCount([[0, 0], [1, 1]]), 0);
    assert.equal(outsidePainterCount([[0, 0], [9, 9], [-9, 0]]), 2);
    assert.equal(outsidePainterCount(null), 0);
  });
});
