// test/modProtocolLayer.test.js — 协议适配层骨架：事件分流 + 准入判据（Phase 5）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEvent, createEventRouter, EVENT_KINDS, KIND_BY_TYPE } from '../server/mod-manager/eventRouter.js';
import { admitModSet, admitPack, roomSubset, ADMISSION_CODES } from '../server/mod-manager/admission.js';
import { buildActivationPlan } from '../server/mod-manager/plan.js';

const H = (c) => c.repeat(64).slice(0, 64);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('分流：C2S 类型 → 种类；不认识的一律 plain（保守）', () => {
  assert.deepEqual(classifyEvent({ type: 'room.create' }), { kind: 'room.mod.handshake', type: 'room.create' });
  assert.equal(classifyEvent({ type: 'room.join' }).kind, 'room.mod.handshake');
  assert.equal(classifyEvent({ type: 'room.queue' }).kind, 'room.mod.handshake');
  assert.equal(classifyEvent({ type: 'resource.proof' }).kind, 'resource.admission');
  assert.equal(classifyEvent({ type: 'pack.msg' }).kind, 'pack.msg');
  assert.deepEqual(classifyEvent({ type: 'g.move' }), { kind: 'plain', type: 'g.move' });
  // 不认识 / 形状坏 ⇒ plain，绝不猜成扩展事件
  assert.deepEqual(classifyEvent({}), { kind: 'plain', type: null });
  assert.deepEqual(classifyEvent(null), { kind: 'plain', type: null });
  assert.deepEqual(classifyEvent({ type: 42 }), { kind: 'plain', type: null });
  // 每个映射值都在闭集里
  assert.ok(Object.values(KIND_BY_TYPE).every((k) => EVENT_KINDS.includes(k)));
});

test('派发：按顺序、返回 true 即短路、只收自己声明过的种类', () => {
  const seen = [];
  const router = createEventRouter({
    interceptors: [
      { pack: 'a', id: 'm1', kinds: ['room.mod.handshake'], fn: () => { seen.push('a'); return false; } },
      { pack: 'b', id: 'm2', kinds: ['room.mod.handshake'], fn: () => { seen.push('b'); return true; } },
      { pack: 'c', id: 'm3', kinds: ['resource.admission'], fn: () => { seen.push('c'); } },
      { pack: 'd', id: 'm4', kinds: ['room.mod.handshake'], fn: () => { seen.push('d'); } },
    ],
  });
  const r = router.route({ type: 'room.create' }, {});
  assert.deepEqual(seen, ['a', 'b'], 'b 返回 true ⇒ 后面的 d 不再跑；c 不关心这一类');
  assert.equal(r.kind, 'room.mod.handshake');
  assert.equal(r.handled, true);
  assert.equal(r.results.length, 2);
});

test('隔离：一个钩子抛异常只记日志，后面的照跑（与 preDispatch 同一条纪律）', () => {
  const seen = [];
  const router = createEventRouter({
    log: quiet,
    interceptors: [
      { pack: 'boom', id: 'x', fn: () => { throw new Error('nope'); } },
      { pack: 'ok', id: 'y', fn: () => { seen.push('ok'); } },
    ],
  });
  const r = router.route({ type: 'pack.msg' }, {});
  assert.deepEqual(seen, ['ok'], '抛异常没有吃掉后面的钩子');
  assert.equal(r.handled, false);
  assert.equal(r.results[0].ok, false);
  assert.equal(String(r.results[0].error.message), 'nope');
  assert.equal(r.results[1].ok, true);
});

test('准入：集合摘要不一致即拒；没有包时不设门槛（干净安装不变）', () => {
  assert.deepEqual(admitModSet({ offered: null, expected: null }), { ok: true, code: null, reason: null });
  assert.equal(admitModSet({ offered: H('a'), expected: H('a') }).ok, true);
  const bad = admitModSet({ offered: H('b'), expected: H('a') });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, ADMISSION_CODES.SET_MISMATCH);
  const none = admitModSet({ offered: null, expected: H('a') });
  assert.equal(none.ok, false);
  assert.match(none.reason, /offered nothing/);
});

test('准入：不在计划里的包 / 未同意 / 钉失效 三种拒都具名', () => {
  const host = { id: 'h', hash: H('a'), combat: true, server: { modules: [{ id: 'm', entry: 'm.mjs', uses: ['boot'] }] } };
  const plan = buildActivationPlan({ packs: [host] });

  assert.equal(admitPack(plan, 'h').ok, true);
  const missing = admitPack(plan, 'ghost');
  assert.equal(missing.code, ADMISSION_CODES.NOT_ACTIVATED);

  const needConsent = admitPack(plan, 'h', { requireConsent: true });
  assert.equal(needConsent.code, ADMISSION_CODES.NOT_CONSENTED);

  const consented = admitPack(plan, 'h', { requireConsent: true, entry: { state: 'enabled', consent: { digest: H('a') } } });
  assert.equal(consented.ok, true);

  const stale = admitPack(plan, 'h', { entry: { state: 'enabled', pin: { digest: H('f') } } });
  assert.equal(stale.code, ADMISSION_CODES.PIN_STALE);

  const disabled = buildActivationPlan({ packs: [host], registry: { version: 1, packs: { h: { state: 'disabled' } } } });
  assert.equal(admitPack(disabled, 'h').code, ADMISSION_CODES.NOT_ACTIVATED);
});

test('房间子集：可跑的留下，不可跑的**具名**给出原因（绝不静默少给）', () => {
  const a = { id: 'a', hash: H('a') };
  const b = { id: 'b', hash: H('b') };
  const plan = buildActivationPlan({ packs: [a, b], registry: { version: 1, packs: { b: { state: 'disabled' } } } });
  const out = roomSubset(plan, ['a', 'b', 'ghost']);
  assert.deepEqual(out.allowed, ['a']);
  assert.deepEqual(out.refused.map((r) => r.id).sort(), ['b', 'ghost']);
  assert.equal(out.refused.find((r) => r.id === 'b').code, ADMISSION_CODES.NOT_ACTIVATED);
});
