// test/packPicker.test.js — 「保存到哪个工坊包」的下拉与「新工坊包 id」的内联表单（editor/ui/packPicker.js）。
//
// 它替掉的是七个调用点里同一句 `window.prompt`：每次保存都在对话框里手打包 id，打错就存进别的包（或新建一个空包）。
// 这里钉住三件容易出错的小事：
//   1. **当前值必须出现在选项里**（哪怕它还没落盘），以及**取消新建时要退回原来的选择** —— 否则 select 会停在一个
//      并不存在的值上，作者以为选好了、实际保存去别处。
//   2. 输入框的校验就是原来靠 prompt 之后的运气兜住的那三条：空值、形状（字母数字下划线短横线，1–32 位）、重名。
//      错误要在**表单里就地**说，不能弹 alert（弹窗会把错误和输入框割开，而且不受界面语言控制）。
//   3. 整条路**一次也不碰 window.prompt**：下面有一条测试把 global.prompt 换成一个会抛错的桩来证明这一点。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { packOptions, packSelect, packIdCheck, packIdForm } from '../editor/ui/packPicker.js';

/** 够这两个控件用的最小 DOM。
 *  注意：真 DOM 的 append 会把字符串变成文本节点，这里用不到字符串，但 `listeners` 必须真的记住回调。
 *  真实页面上展开/收起走 renderKeepingFocus，所以这里也得支持 replaceChildren / querySelector / focus。 */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    value: '',
    textContent: '',
    type: '',
    placeholder: '',
    title: '',
    children: [],
    parent: null,
    listeners: {},
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    append(...kids) { for (const k of kids) { if (k && typeof k === 'object') k.parent = this; this.children.push(k); } },
    replaceChildren(...kids) { this.children = []; this.append(...kids); },
    insertBefore(node, ref) { const i = this.children.indexOf(ref); if (i < 0) this.append(node); else { node.parent = this; this.children.splice(i, 0, node); } },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ target: this, preventDefault() {}, ...extra }); },
    focus() { focused = this; },
    select() {},
    /** 只认 `.class` 与 `tag` 两种选择器：够这两个控件用，也不至于把桩写成一个真 DOM。 */
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const want = sel.startsWith('.') ? sel.slice(1) : null;
      const walk = (n) => {
        for (const c of n.children) {
          if (!c || typeof c !== 'object') continue;
          const hit = want ? String(c.className).split(/\s+/).includes(want) : c.tagName === sel.toUpperCase();
          if (hit) out.push(c);
          walk(c);
        }
        return out;
      };
      return walk(this);
    },
  };
  return el;
}

/** 「当前焦点」：真页面上 renderKeepingFocus 靠 document.activeElement 找回光标，桩里也要有这么一回事。 */
let focused = null;
/** 让 packIdForm 那个「点击后再聚焦」的微任务跑完（真浏览器里它是 queueMicrotask，桩里也要等一次）。 */
const settle = () => new Promise((r) => setTimeout(r, 0));
const withDoc = (fn) => {
  const savedDoc = globalThis.document;
  const savedPrompt = globalThis.prompt;
  focused = null;
  globalThis.document = { createElement: (tag) => makeEl(tag), get activeElement() { return focused; } };
  globalThis.prompt = () => { throw new Error('这条路上不该出现原生 prompt()'); };
  try { return fn(); } finally {
    globalThis.document = savedDoc;
    globalThis.prompt = savedPrompt;
  }
};
/** 同 withDoc，但等微任务跑完再断言（展开表单之后要看焦点就得走这条）。 */
const withDocAsync = async (fn) => {
  const savedDoc = globalThis.document;
  const savedPrompt = globalThis.prompt;
  focused = null;
  globalThis.document = { createElement: (tag) => makeEl(tag), get activeElement() { return focused; } };
  globalThis.prompt = () => { throw new Error('这条路上不该出现原生 prompt()'); };
  try { return await fn(); } finally {
    globalThis.document = savedDoc;
    globalThis.prompt = savedPrompt;
  }
};

const PACKS = [
  { id: 'b_pack', name: '乙包' },
  { id: 'a_pack', name: '甲包' },
  { id: 'c_pack' },                      // 没有名字：标签就用 id
];

/** 容器里的那个 <select>。 */
const selOf = (box) => box.querySelector('.packSelectSel');
/** 展开中的内联表单（没展开时 null）。 */
const formOf = (box) => box.querySelector('.packNewForm');
const inputOf = (form) => form.querySelector('.packNewId');
/** 按按钮文案找按钮：确认/取消/创建都只有一行字，够用了。 */
const btnOf = (root, label) => root.querySelectorAll('button').find((b) => b.textContent === label);
const errOf = (root) => root.querySelectorAll('.err').map((e) => e.textContent);

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
      const box = packSelect({
        packs: PACKS, current: 'b_pack', newLabel: '新建',
        onPick: (id) => picked.push(id),
      });
      const sel = selOf(box);
      assert.equal(sel.value, 'b_pack');
      sel.value = 'c_pack'; sel.fire('change');
      assert.deepEqual(picked, ['c_pack']);
      assert.deepEqual(errOf(box), [], '选一个已有的包不该出现任何表单');
    });
  });

  test('没有当前值时默认落在第一个包上', () => {
    withDoc(() => {
      const box = packSelect({ packs: PACKS, current: null, newLabel: '新建', onPick: () => {} });
      assert.equal(selOf(box).value, 'a_pack');
    });
  });

  test('没有任何包时默认停在「新建」，而不是一个空值', () => {
    withDoc(() => {
      const box = packSelect({ packs: [], current: null, newLabel: '新建', onPick: () => {} });
      assert.equal(selOf(box).value, '__new__');
    });
  });

  test('选「新建」展开内联输入框：原地出现、且自动获得焦点', async () => {
    await withDocAsync(async () => {
      const box = packSelect({ packs: PACKS, current: 'a_pack', newLabel: '新建', newDefault: 'my-item-pack', onPick: () => {} });
      assert.equal(formOf(box), null, '选之前没有表单');
      assert.equal(box.children.length, 1, '没展开时容器里只有那个 select');
      selOf(box).value = '__new__'; selOf(box).fire('change');
      const form = formOf(box);
      assert.ok(form, '选「新建」就该在原地出现输入框');
      assert.equal(inputOf(form).value, 'my-item-pack', '预填值沿用各页原来 prompt 里的默认值');
      await settle();
      assert.equal(focused, inputOf(form), '展开后光标就在输入框里，不用先点一下');
      assert.equal(box.children[0], selOf(box), '选择框是容器的第一项，展开不会让它跳位');
      assert.equal(box.children[1], form, '输入框就展开在它下面');
    });
  });

  test('输入合法 id 后确认：回调去空白后的结果，并把新包留在下拉里', () => {
    withDoc(() => {
      const picked = [];
      const box = packSelect({ packs: PACKS, current: 'a_pack', newLabel: '新建', onPick: (id) => picked.push(id) });
      selOf(box).value = '__new__'; selOf(box).fire('change');
      const input = inputOf(formOf(box));
      input.value = '  my_new_pack  ';
      input.fire('input');
      btnOf(formOf(box), '确认').fire('click');
      assert.deepEqual(picked, ['my_new_pack']);
      assert.equal(formOf(box), null, '确认之后表单收起');
      const sel = selOf(box);
      assert.equal(sel.value, 'my_new_pack', '选择框停在新包上，不能跳回第一个包');
      assert.ok(sel.children.some((o) => o.value === 'my_new_pack'), '这个 id 还没落盘，也必须能在选项里看见');
      assert.equal(sel.children[sel.children.length - 1].value, '__new__', '「新建」仍然是最后一项');
    });
  });

  test('输入非法 id：就地报错、不回调、表单还在', () => {
    withDoc(() => {
      const picked = [];
      const box = packSelect({ packs: PACKS, current: 'a_pack', newLabel: '新建', onPick: (id) => picked.push(id) });
      selOf(box).value = '__new__'; selOf(box).fire('change');
      const type = (v) => { const i = inputOf(formOf(box)); i.value = v; i.fire('input'); btnOf(formOf(box), '确认').fire('click'); };

      type('有中文的 id');
      assert.deepEqual(picked, []);
      assert.match(errOf(formOf(box))[0] ?? '', /只能是字母、数字、下划线、短横线/, '形状不对要当场说清规则');
      assert.equal(inputOf(formOf(box)).value, '有中文的 id', '报错不能把用户打的字擦掉');

      type('   ');
      assert.deepEqual(picked, [], '空值不算一个 id');
      assert.match(errOf(formOf(box))[0] ?? '', /不能为空/);

      type('a_pack');
      assert.deepEqual(picked, [], '重名不算新建');
      assert.match(errOf(formOf(box))[0] ?? '', /a_pack/, '重名时得说清是撞上了哪一个');
      assert.equal(inputOf(formOf(box)).value, 'a_pack');
    });
  });

  test('重名之后再改一个合法值：错误收掉，确认能过', () => {
    withDoc(() => {
      const picked = [];
      const box = packSelect({ packs: PACKS, current: 'a_pack', newLabel: '新建', onPick: (id) => picked.push(id) });
      selOf(box).value = '__new__'; selOf(box).fire('change');
      let input = inputOf(formOf(box));
      input.value = 'a_pack'; input.fire('input');
      btnOf(formOf(box), '确认').fire('click');
      assert.equal(errOf(formOf(box)).length, 1);
      input = inputOf(formOf(box));
      input.value = 'my_new_pack'; input.fire('input');
      assert.deepEqual(errOf(formOf(box)), [], '改了字就把上一条错误收掉');
      btnOf(formOf(box), '确认').fire('click');
      assert.deepEqual(picked, ['my_new_pack']);
    });
  });

  test('取消：退回原来的选择，不回调', () => {
    withDoc(() => {
      const picked = [];
      const box = packSelect({ packs: PACKS, current: 'b_pack', newLabel: '新建', onPick: (id) => picked.push(id) });
      selOf(box).value = '__new__'; selOf(box).fire('change');
      btnOf(formOf(box), '取消').fire('click');
      assert.deepEqual(picked, []);
      assert.equal(formOf(box), null, '取消之后表单收起');
      assert.equal(selOf(box).value, 'b_pack', '取消之后选择框不能停在一个并不存在的值上');
    });
  });

  test('Enter 确认、Escape 取消（键盘不用去点按钮）', () => {
    withDoc(() => {
      const picked = [];
      const box = packSelect({ packs: PACKS, current: 'b_pack', newLabel: '新建', onPick: (id) => picked.push(id) });
      selOf(box).value = '__new__'; selOf(box).fire('change');
      let input = inputOf(formOf(box));
      input.value = 'k_pop'; input.fire('input');
      input.fire('keydown', { key: 'Enter' });
      assert.deepEqual(picked, ['k_pop']);

      selOf(box).value = '__new__'; selOf(box).fire('change');
      input = inputOf(formOf(box));
      input.value = 'never_mind'; input.fire('input');
      input.fire('keydown', { key: 'Escape' });
      assert.deepEqual(picked, ['k_pop'], 'Escape 只是取消，不该多一次回调');
      assert.equal(formOf(box), null);
    });
  });

  test('整条路一次也不碰原生 prompt（桩会抛错）', () => {
    withDoc(() => {
      const box = packSelect({ packs: PACKS, current: 'b_pack', newLabel: '新建', onPick: () => {} });
      selOf(box).value = '__new__'; selOf(box).fire('change');
      const input = inputOf(formOf(box));
      input.value = 'no_prompt_here'; input.fire('input');
      btnOf(formOf(box), '确认').fire('click');
      // 到这里为止都没抛错，就说明没有一行代码去调 globalThis.prompt
      assert.equal(selOf(box).value, 'no_prompt_here');
    });
  });
});

describe('新工坊包 id：校验规则', () => {
  test('空值 / 形状 / 重名各自有话说', () => {
    assert.equal(packIdCheck('', PACKS).code, 'empty');
    assert.equal(packIdCheck('   ', PACKS).code, 'empty');
    assert.equal(packIdCheck('有中文', PACKS).code, 'shape');
    assert.equal(packIdCheck('空格 id', PACKS).code, 'shape');
    assert.equal(packIdCheck('-leading', PACKS).code, 'shape', '与 PACK_ID_RE 一致：不能以短横线开头');
    assert.equal(packIdCheck('x'.repeat(33), PACKS).code, 'shape', '上限 32 位');
    assert.equal(packIdCheck('a_pack', PACKS).code, 'dup');
    assert.equal(packIdCheck('  good_id-1  ', PACKS).id, 'good_id-1', '合法时去空白后交出去');
    assert.equal(packIdCheck('x'.repeat(32), PACKS).ok, true);
  });
});

describe('新工坊包 id：文案走编辑器 i18n', () => {
  test('校验文案是 t() 查出来的，切到英文就跟着换', async () => {
    const { setLang } = await import('../editor/ui/i18n.js');
    try {
      setLang('en');
      assert.equal(packIdCheck('', PACKS).error, 'The pack id cannot be empty.');
      assert.match(packIdCheck('有中文', PACKS).error, /letters, digits, underscores and hyphens/);
      assert.match(packIdCheck('a_pack', PACKS).error, /a_pack/);
    } finally {
      setLang('zh');   // 这一层的语言是全局的，别留给下一个测试文件
    }
    assert.match(packIdCheck('', PACKS).error, /不能为空/);
  });
});

describe('新工坊包 id：内联表单本身（页面里「新建工坊包」那颗按钮用的就是它）', () => {
  test('只问 id、不建包：确认后回调一次，输入框与值被重建也留着', async () => {
    await withDocAsync(async () => {
      const got = [];
      const form = packIdForm({ packs: PACKS, defaultValue: 'first', confirmLabel: '创建', onConfirm: (id) => got.push(id) });
      assert.equal(inputOf(form).value, 'first');
      await settle();
      assert.equal(focused, inputOf(form));
      inputOf(form).value = 'second_pack'; inputOf(form).fire('input');
      btnOf(form, '创建').fire('click');
      assert.deepEqual(got, ['second_pack']);
    });
  });

  test('取消走 onCancel；错误就地显示、不用 alert', () => {
    withDoc(() => {
      let cancelled = 0;
      const form = packIdForm({ packs: PACKS, onCancel: () => { cancelled++; } });
      inputOf(form).value = 'bad id'; inputOf(form).fire('input');
      btnOf(form, '确认').fire('click');
      assert.equal(cancelled, 0, '校验没过就不该取消');
      assert.equal(errOf(form).length, 1);
      btnOf(form, '取消').fire('click');
      assert.equal(cancelled, 1);
    });
  });

  test('没有 onCancel 时取消只是重画自己，不会炸', () => {
    withDoc(() => {
      const form = packIdForm({ packs: PACKS, defaultValue: 'keep_me' });
      btnOf(form, '取消').fire('click');
      assert.equal(inputOf(form).value, 'keep_me', '输入框还在，作者可以改一下再确认');
      assert.deepEqual(errOf(form), []);
    });
  });
});
