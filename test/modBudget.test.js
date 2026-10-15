// test/modBudget.test.js — 统一调用预算 / 看门狗（审计 GAP-3）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBudget, createBudgetTracker, guarded, createBudgetMap, isUnlimited, UNLIMITED_BUDGET } from '../server/mod-manager/budget.js';

test('normalizeBudget：负/NaN/未知 → 0（不限）', () => {
  assert.deepEqual(normalizeBudget({ maxCalls: 5, maxWallTimeMs: -3, bogus: 9, maxBytesIn: 'abc' }), {
    maxCalls: 5, maxBytesIn: 0, maxBytesOut: 0, maxWallTimeMs: 0, maxCpuMs: 0, maxConcurrentCalls: 0,
  });
  assert.equal(isUnlimited(UNLIMITED_BUDGET), true);
  assert.equal(isUnlimited(normalizeBudget({ maxCalls: 1 })), false);
});

test('tracker：调用次数到顶后不再放行（allow 变 false 且记录 exceeded）', () => {
  const t = createBudgetTracker({ maxCalls: 2 });
  assert.equal(t.allow(), true); t.record(0);
  assert.equal(t.allow(), true); t.record(0);
  assert.equal(t.allow(), false);
  assert.equal(t.exceeded.code, 'SDK_BUDGET_EXCEEDED');
});

test('tracker：墙钟超预算 trip；字节方向分别记账', () => {
  const t = createBudgetTracker({ maxWallTimeMs: 10 });
  t.record(6); assert.equal(t.exceeded, null);
  t.record(6); assert.equal(t.exceeded.code, 'SDK_BUDGET_EXCEEDED');
  const b = createBudgetTracker({ maxBytesIn: 4 });
  assert.equal(b.bytes('in', 3), true);
  assert.equal(b.bytes('in', 3), false);
  b.bytes('out', 999) ;
  assert.equal(b.state.bytesOut, 999);
});

test('guarded：正常返回 / 抛异常 / 预算耗尽 三种结局都不外抛', () => {
  const t = createBudgetTracker({ maxCalls: 1 });
  const ok = guarded((x) => x + 1, { tracker: t, label: 'ok' });
  assert.deepEqual(ok(1), { ok: true, value: 2, budgetExceeded: false });

  const boom = guarded(() => { throw new Error('nope'); }, { tracker: createBudgetTracker({}), label: 'boom' });
  const r = boom();
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'nope');

  const capped = guarded(() => 1, { tracker: t, label: 'capped' });
  const second = capped(); // maxCalls 1 已用掉
  assert.equal(second.ok, false);
  assert.equal(second.budgetExceeded, true);
});

test('guarded：注入的 now 让墙钟可测（同步代码不可抢占，只事后记账）', () => {
  let clock = 0;
  const now = () => clock;
  const t = createBudgetTracker({ maxWallTimeMs: 100 }, { now });
  const fn = guarded(() => { clock += 250; return 'slow'; }, { tracker: t, now, label: 'slow' });
  const r = fn();
  assert.equal(r.ok, false);
  assert.equal(r.budgetExceeded, true);
  assert.equal(r.value, 'slow', 'value 仍然返回，只是标了越界');
});

test('createBudgetMap：逐包预算 + fallback', () => {
  const m = createBudgetMap({ a: { maxCalls: 1 } }, { fallback: { maxCalls: 9 } });
  assert.equal(m.trackerFor('a').budget.maxCalls, 1);
  assert.equal(m.trackerFor('zzz').budget.maxCalls, 9);
  assert.equal(m.trackerFor('a'), m.trackerFor('a'), '同一个包拿到同一个 tracker');
  assert.equal(m.size(), 2);
});
