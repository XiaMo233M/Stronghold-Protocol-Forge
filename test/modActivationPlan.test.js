// test/modActivationPlan.test.js — ActivationPlan 的单一裁剪与三重摘要。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActivationPlan, isActivated } from '../server/mod-manager/plan.js';
import { modDigest } from '../shared/sdk/digest.js';
import { evaluateConsentPin, isConsented, pinMatches } from '../server/mod-manager/consent.js';

const H = (c) => c.repeat(64).slice(0, 64);
const pack = (id, hash, extra = {}) => ({ id, version: '1.0.0', hash, layer: 'A', combat: false, ...extra });

test('单一裁剪：enabled / disabled / refused / unavailable 一路收敛到 activated 与 excluded', () => {
  const packs = [pack('a', H('a')), pack('b', H('b')), pack('c', H('c')), pack('d', H('d'))];
  const plan = buildActivationPlan({
    packs,
    registry: { version: 1, packs: { b: { state: 'disabled' } } },
    refused: [{ id: 'c', reason: 'missing dependency' }],
    unavailable: [{ pack: 'd', code: 'MODULES_IMPORT_FAILED', reason: 'boom' }],
    options: { origin: 'forge' },
  });
  assert.deepEqual(plan.discovered.map((x) => x.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(plan.activated, ['a']);
  assert.deepEqual(plan.excluded, ['b', 'c', 'd']);
  assert.deepEqual(plan.disabled.map((x) => x.id), ['b']);
  assert.deepEqual(plan.refused.map((x) => x.id), ['c']);
  assert.deepEqual(plan.resolved.unavailable.map((x) => x.id), ['d']);
  assert.equal(isActivated(plan, 'a'), true);
  assert.equal(isActivated(plan, 'b'), false);
});

test('集合摘要 == 对激活集合独立重算的 modDigest（与既有 wire 语义一致）', () => {
  const packs = [pack('a', H('a')), pack('b', H('b'))];
  const plan = buildActivationPlan({ packs, registry: null });
  const expected = modDigest([{ id: 'a', hash: H('a') }, { id: 'b', hash: H('b') }]);
  assert.equal(plan.digest.modDigest, expected);
  assert.deepEqual(plan.digest.contentDigestOf, { a: H('a'), b: H('b') });
  assert.match(plan.digest.activationDigest, /^[0-9a-f]{64}$/);
});

test('activationDigest 随执行配置变化，但不随无关字段变化', () => {
  const base = { id: 'a', hash: H('a'), combat: true, server: { modules: [{ id: 'm', entry: 'm.mjs', uses: ['boot'] }] } };
  const p1 = buildActivationPlan({ packs: [base] });
  const p2 = buildActivationPlan({ packs: [{ ...base, name: 'renamed', author: 'someone', description: 'x' }] });
  assert.equal(p1.digest.activationDigest, p2.digest.activationDigest, '无关字段不改激活摘要');
  const p3 = buildActivationPlan({ packs: [base], options: { requireConsentForHost: true } });
  const p4 = buildActivationPlan({ packs: [{ ...base, hash: H('f') }] });
  assert.notEqual(p1.digest.activationDigest, p3.digest.activationDigest);
  assert.notEqual(p1.digest.activationDigest, p4.digest.activationDigest);
});

test('requiresConsentForHost：宿主进程档未同意 → 被裁；同意到该版字节 → 激活', () => {
  const host = { id: 'h', hash: H('a'), combat: true, server: { modules: [{ id: 'm', entry: 'm.mjs', uses: ['boot'] }] } };
  const noConsent = buildActivationPlan({ packs: [host], options: { requireConsentForHost: true } });
  assert.deepEqual(noConsent.activated, []);
  assert.equal(noConsent.warnings[0].code, 'SDK_NOT_CONSENTED');

  const withConsent = buildActivationPlan({
    packs: [host],
    registry: { version: 1, packs: { h: { state: 'enabled', consent: { digest: H('a'), at: new Date().toISOString() } } } },
    options: { requireConsentForHost: true },
  });
  assert.deepEqual(withConsent.activated, ['h']);
});

test('pin：钉的字节变了 → 失效被裁；一致 → 通过', () => {
  const p = pack('a', H('a'));
  const stale = buildActivationPlan({ packs: [p], registry: { version: 1, packs: { a: { state: 'enabled', pin: { digest: H('f') } } } } });
  assert.deepEqual(stale.activated, []);
  assert.equal(stale.warnings[0].code, 'SDK_PIN_STALE');
  const fresh = buildActivationPlan({ packs: [p], registry: { version: 1, packs: { a: { state: 'enabled', pin: { digest: H('a') } } } } });
  assert.deepEqual(fresh.activated, ['a']);
});

test('consent/pin 纯判据', () => {
  assert.equal(isConsented({ consent: { digest: H('a') } }, H('a')), true);
  assert.equal(isConsented({ consent: { digest: H('a') } }, H('b')), false);
  assert.equal(pinMatches({ pin: null }, H('a')), true);
  assert.equal(pinMatches({ pin: { digest: H('a') } }, H('a')), true);
  assert.equal(pinMatches({ pin: { digest: H('a') } }, null), false);
  assert.equal(evaluateConsentPin({ id: 'x', profile: 'legacy', contentDigest: H('a') }, null).ok, true);
  const r = evaluateConsentPin({ id: 'x', profile: 'host', contentDigest: H('a'), activationPolicy: { requiresConsent: true } }, null);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SDK_NOT_CONSENTED');
});

test('干净安装（零包）：无摘要、无排除、无错误', () => {
  const plan = buildActivationPlan({ packs: [] });
  assert.deepEqual(plan.activated, []);
  assert.equal(plan.digest.modDigest, null);
  assert.match(plan.digest.activationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.errors, []);
});
