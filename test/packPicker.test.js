// test/packPicker.test.js — 「保存到哪个工坊包」的下拉（editor/ui/packPicker.js）。
//
// 它替掉的是五个页面里同一句 `window.prompt`：每次保存都在对话框里手打包 id，打错就存进别的包（或新建一个空包）。
// 这里钉住两件容易出错的小事：**当前值必须出现在选项里**（哪怕它还没落盘），以及**取消新建时要退回原来的选择**
// —— 否则 select 会停在一个并不存在的值上，作者以为选好了、实际保存去别处。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { packOptions, packSelect } from '../editor/ui/packPicker.js';

/** 够 packSelect 用的最小 DOM。
 *  注意：真 DOM 的 append 会把字符串变成文本节点，这里用不到字符串，但 `listeners` 必须真的记住回调。 */
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    value: '',
    textContent: '',
    children: [],
    listeners: {},
    append(...kids) { for (const k of kids) this.children.push(k); },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] ?? []) fn({ target: this }); },
  };
}
const withDoc = (fn) => {
  const saved = globalThis.document;
  globalThis.document = { createElement: (tag) => makeEl(tag) };
  try { return fn(); } finally { globalThis.document = saved; }
};

const PACKS = [
  { id: 'b_pack', name: '乙包' },
  { id: 'a_pack', name: '甲包' },
  { id: 'c_pack' },                      // 没有名字：标签就用 id
];

describe('保存目标下拉：选项', () => {
  test('按 id 排序，有名字就把名字带上', () => {
    const opts = packOptions(PACKS, 'b_pack', { newLabel: '＋ 新建一个包…' });
    assert.deepEqual(opts.map((o) => o.value), ['a_pack', 'b_pack', 'c_pack', '__new__']);
    assert.equal(opts[0].label, '甲包 (a_pack)');
    assert.equal(opts[2].label, 'c_pack', '没有名字时标签就是 id，不要出现 "undefined (c_pack)"');
    assert.equal(opts[3].label, '＋ 新建一个包…');
  });

  test('当前值不在清单里（还没落盘的新包）也要补进去', () => {
    const opts = packOptions(PACKS, 'brand_new', { newLabel: '新建' });
    assert.deepEqual(opts.map((o) => o.value), ['a_pack', 'b_pack', 'c_pack', 'brand_new', '__new__']);
  });

  test('清单为空、当前值也没有时不炸', () => {
    assert.deepEqual(packOptions([], null, { newLabel: '新建' }).map((o) => o.value), ['__new__']);
    assert.deepEqual(packOptions(null, '', { newLabel: '新建' }).map((o) => o.value), ['__new__']);
  });
});

describe('保存目标下拉：选中行为', () => {
  test('默认选中当前值；选已有包时回调收到它的 id', () => {
    withDoc(() => {
      const picked = [];
      const sel = packSelect({
        packs: PACKS, current: 'b_pack', newLabel: '新建',
        onPick: (id) => picked.push(id), askNewId: () => null,
      });
      assert.equal(sel.value, 'b_pack');
      sel.value = 'c_pack'; sel.fire('change');
      assert.deepEqual(picked, ['c_pack']);
    });
  });

  test('没有当前值时默认落在第一个包上', () => {
    withDoc(() => {
      const sel = packSelect({ packs: PACKS, current: null, newLabel: '新建', onPick: () => {}, askNewId: () => null });
      assert.equal(sel.value, 'a_pack');
    });
  });

  test('没有任何包时默认停在「新建」，而不是一个空值', () => {
    withDoc(() => {
      const sel = packSelect({ packs: [], current: null, newLabel: '新建', onPick: () => {}, askNewId: () => null });
      assert.equal(sel.value, '__new__');
    });
  });

  test('选「新建」会问一次 id，并把去空白后的结果回调出去', () => {
    withDoc(() => {
      const picked = [];
      const sel = packSelect({
        packs: PACKS, current: 'a_pack', newLabel: '新建',
        onPick: (id) => picked.push(id), askNewId: () => '  my_new_pack  ',
      });
      sel.value = '__new__'; sel.fire('change');
      assert.deepEqual(picked, ['my_new_pack']);
    });
  });

  test('新建时取消：退回原来的选择，不回调', () => {
    withDoc(() => {
      const picked = [];
      const sel = packSelect({
        packs: PACKS, current: 'b_pack', newLabel: '新建',
        onPick: (id) => picked.push(id), askNewId: () => null,
      });
      sel.value = '__new__'; sel.fire('change');
      assert.deepEqual(picked, []);
      assert.equal(sel.value, 'b_pack', '取消之后选择框不能停在一个并不存在的值上');
    });
  });
});
