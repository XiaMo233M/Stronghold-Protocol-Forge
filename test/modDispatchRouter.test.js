// test/modDispatchRouter.test.js — 钩子总线改由 `eventRouter` 派发之后，**语义必须与旧的内联循环逐条相同**。
//
// 这条测试是这个接线唯一的证据来源（`modDispatch.js` 只依赖 `shared/protocol.js`，本机就能跑）：
// 旧的循环语义是「按包 id 次序 → 逐个调 `inst.preDispatch(conn, msg)` → **只有 `=== true`** 算消费 →
// 第一个消费即返回 true → 抛异常只记日志、当作没消费、后面的继续」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createModDispatch } from '../server/modDispatch.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 造一个钩子：`calls` 记下它见过哪些包，`ret` 决定它返回什么（可为函数）。 */
function hook(pack, ret, calls) {
  return {
    pack,
    intercepts: [],
    create: () => ({
      preDispatch: () => { calls.push(pack); return typeof ret === 'function' ? ret() : ret; },
    }),
  };
}

const conn = { id: 'c1' };
const MSG = { t: 'room.create', type: 'room.create' };

test('按**包 id 次序**调用，与传入顺序无关', () => {
  const calls = [];
  const d = createModDispatch({ hooks: [hook('zeta', false, calls), hook('alpha', false, calls), hook('mid', false, calls)], send: () => {}, log: quiet, now: () => 0 });
  assert.equal(d.preDispatch(conn, MSG), false);
  assert.deepEqual(calls, ['alpha', 'mid', 'zeta']);
});

test('第一个返回 `true` 即短接，后面的钩子**完全不被调用**', () => {
  const calls = [];
  const d = createModDispatch({ hooks: [hook('a', false, calls), hook('b', true, calls), hook('c', false, calls)], send: () => {}, log: quiet, now: () => 0 });
  assert.equal(d.preDispatch(conn, MSG), true);
  assert.deepEqual(calls, ['a', 'b'], 'c 不该被调用');
});

test('只有 `=== true` 算消费：truthy 的非 true 值（1 / "yes" / {}）都不消费', () => {
  for (const truthy of [1, 'yes', {}, []]) {
    const calls = [];
    const d = createModDispatch({ hooks: [hook('a', truthy, calls), hook('b', false, calls)], send: () => {}, log: quiet, now: () => 0 });
    assert.equal(d.preDispatch(conn, MSG), false, `truthy=${JSON.stringify(truthy)} 不该算消费`);
    assert.deepEqual(calls, ['a', 'b']);
  }
});

test('抛异常的钩子被隔离：只记日志、当作没消费、**后面的照跑**', () => {
  const calls = [];
  const errors = [];
  const log = { ...quiet, error: (...a) => errors.push(a) };
  const d = createModDispatch({
    hooks: [hook('boom', () => { throw new Error('nope'); }, calls), hook('ok', true, calls)],
    send: () => {}, log, now: () => 0,
  });
  assert.equal(d.preDispatch(conn, MSG), true, '后面的钩子仍然消费了这条消息');
  assert.deepEqual(calls, ['boom', 'ok']);
  assert.equal(errors.length, 1);
  // 错误文案与旧循环**逐字**相同（有测试钉着它）
  assert.equal(errors[0][0], '[mod] boom: preDispatch(room.create) crashed — the message is not consumed');
  assert.equal(String(errors[0][1].message), 'nope');
});

test('工厂抛异常的钩子在这条连接上不存在（不消费、不炸、别的钩子照常）', () => {
  const calls = [];
  const errors = [];
  const log = { ...quiet, error: (...a) => errors.push(a) };
  const broken = { pack: 'bad', intercepts: [], create: () => { throw new Error('factory boom'); } };
  const d = createModDispatch({ hooks: [broken, hook('good', true, calls)], send: () => {}, log, now: () => 0 });
  assert.equal(d.preDispatch(conn, MSG), true);
  assert.deepEqual(calls, ['good']);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /factory threw/);
});

test('每个连接的钩子实例各自创建（跨连接不共享实例）', () => {
  const made = [];
  const h = { pack: 'p', intercepts: [], create: () => { made.push(1); return { preDispatch: () => false }; } };
  const d = createModDispatch({ hooks: [h], send: () => {}, log: quiet, now: () => 0 });
  const c1 = { id: '1' };
  const c2 = { id: '2' };
  d.preDispatch(c1, MSG);
  d.preDispatch(c1, MSG);
  d.preDispatch(c2, MSG);
  assert.equal(made.length, 2, '每连接一次；同一连接的第二帧复用同一个实例/路由器');
});

test('没有钩子 ⇒ 返回 null（干净安装逐字节不变）', () => {
  assert.equal(createModDispatch({ hooks: [], send: () => {}, log: quiet }), null);
  assert.equal(createModDispatch({ hooks: null, send: () => {}, log: quiet }), null);
});

test('报告面不变：packs 按包 id 排序、intercepts 是并集', () => {
  const hooks = [
    { pack: 'b', intercepts: ['z', 'a'], create: () => ({ preDispatch: () => false }) },
    { pack: 'a', intercepts: ['a'], create: () => ({ preDispatch: () => false }) },
  ];
  const d = createModDispatch({ hooks, send: () => {}, log: quiet, now: () => 0 });
  assert.deepEqual(d.packs, ['a', 'b']);
  assert.deepEqual(d.intercepts, ['a', 'z']);
});
