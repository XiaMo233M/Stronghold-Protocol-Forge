// test/recordDiff.test.js — 覆盖模式的差异预览（shared/recordDiff.js）。
//
// 它是纯函数，所以这一条不需要起服务器、也不需要浏览器：喂两条记录，看它列出的路径对不对。
// 界面那一段只是把结果画出来，判断逻辑全在这里。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { flattenRecord, diffRecords, shortValue } from '../shared/recordDiff.js';

describe('差异预览：摊平', () => {
  test('对象递归、数组按下标、空对象与空数组各算一条叶子', () => {
    const flat = flattenRecord({ a: 1, b: { c: 'x' }, list: [{ n: 2 }], empty: {}, none: [] });
    assert.deepEqual([...flat.keys()].sort(), ['a', 'b.c', 'empty', 'list[0].n', 'none']);
    assert.equal(flat.get('list[0].n'), 2);
    assert.deepEqual(flat.get('none'), []);
  });

  test('标量与 null 也是叶子（null 与「没有这个键」由调用方区分）', () => {
    const flat = flattenRecord({ x: null, y: false, z: 0, s: '' });
    assert.deepEqual([...flat.keys()].sort(), ['s', 'x', 'y', 'z']);
    assert.equal(flat.get('x'), null);
  });
});

describe('差异预览：官方 → 将要写出的记录', () => {
  const official = () => ({
    chessId: 'x_a', tier: 5,
    stats: { atk: 500, def: 200, maxHp: 3000 },
    talents: [{ index: 0, name: '甲', desc: '原本', potMin: 4, potBelow: { desc: '弱' } }],
    bonds: ['a'],
  });

  test('未改动时 changed=false，且一条差异都不列', () => {
    const r = diffRecords(official(), official());
    assert.equal(r.changed, false);
    assert.deepEqual(r.changes, []);
    assert.equal(r.total, 0);
    assert.equal(r.truncated, false);
  });

  test('只列叶子路径：改一个数只报一行，不报整块 `stats`', () => {
    const written = official();
    written.stats.atk = 511;
    const r = diffRecords(official(), written);
    assert.equal(r.total, 1);
    assert.deepEqual(r.changes, [{ path: 'stats.atk', from: 500, to: 511 }]);
  });

  test('嵌套数组里的改动报到下标路径上（天赋文案与注解各一行）', () => {
    const written = official();
    written.talents[0].desc = '作者改的';
    const r = diffRecords(official(), written);
    assert.deepEqual(r.changes, [{ path: 'talents[0].desc', from: '原本', to: '作者改的' }]);
    // 注解要是被抹掉了，这里必须看见 —— 这正是差异预览存在的理由
    const lost = official();
    delete lost.talents[0].potMin;
    delete lost.talents[0].potBelow;
    const r2 = diffRecords(official(), lost);
    // `potBelow` 本身是普通对象 ⇒ 摊平到它自己的叶子上（`potBelow.desc`），而不是报整块
    assert.deepEqual(r2.changes.map((c) => c.path).sort(), ['talents[0].potBelow.desc', 'talents[0].potMin']);
    assert.equal(r2.changes.find((c) => c.path === 'talents[0].potMin').from, 4);
    assert.equal(r2.changes.find((c) => c.path === 'talents[0].potMin').to, undefined);
  });

  test('新增字段与删除字段都被看见（两个方向，不是只比「写进去的」）', () => {
    const written = official();
    written.directToHand = true;
    delete written.bonds;
    const r = diffRecords(official(), written);
    // 删掉一个非空数组 ⇒ 变的是它里面那条（`bonds[0]`）；空数组本身才是一条叶子（见上一条用例）
    assert.deepEqual(r.changes.map((c) => c.path).sort(), ['bonds[0]', 'directToHand']);
    assert.equal(r.changes.find((c) => c.path === 'bonds[0]').to, undefined);
    assert.equal(r.changes.find((c) => c.path === 'directToHand').from, undefined);
  });

  test('超过上限时截短，但 total 说的是真话（界面靠它说「还有 N 条」）', () => {
    const written = official();
    for (let i = 0; i < 50; i++) written[`field${i}`] = i;
    const r = diffRecords(official(), written, { limit: 10 });
    assert.equal(r.changes.length, 10);
    assert.equal(r.total, 50);
    assert.equal(r.truncated, true);
    assert.equal(r.changed, true);
  });

  test('对象与数组按内容比，不是按引用比', () => {
    const written = official();
    written.stats = { ...official().stats };
    written.bonds = ['a'];
    assert.equal(diffRecords(official(), written).changed, false, '同内容的新对象不算改动');
  });

  test('不改写输入', () => {
    const a = official();
    const b = official();
    const before = JSON.stringify(a);
    diffRecords(a, b);
    b.stats.atk = 1;
    assert.equal(JSON.stringify(a), before);
  });
});

describe('差异预览：值怎么画', () => {
  test('长字符串截断、对象转 JSON，`undefined` 返回 null 交给界面（这一层不写中文）', () => {
    assert.equal(shortValue('x'.repeat(100), 20).length, 20);
    assert.equal(shortValue({ a: 1 }), '{"a":1}');
    assert.equal(shortValue(undefined), null);
    assert.equal(shortValue(null), 'null');
    assert.equal(shortValue(0), '0');
  });
});
