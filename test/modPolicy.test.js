// test/modPolicy.test.js — 运行时策略开关（默认全关 ⇒ 行为不变）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { modPolicyFromEnv } from '../server/mod-manager/policy.js';
import { buildActivationPlan } from '../server/mod-manager/plan.js';

test('默认：三个开关全关、无预算、legacy 档', () => {
  const p = modPolicyFromEnv({});
  assert.equal(p.strictGlobals, false);
  assert.equal(p.requireConsentForHost, false);
  assert.equal(p.scanProfile, 'legacy');
  assert.equal(p.budget, null);
});

test('SP_MOD_STRICT_GLOBALS=1 → 严格档；SP_MOD_REQUIRE_CONSENT=yes → 要求同意', () => {
  const p = modPolicyFromEnv({ SP_MOD_STRICT_GLOBALS: '1', SP_MOD_REQUIRE_CONSENT: 'yes' });
  assert.equal(p.scanProfile, 'module');
  assert.equal(p.requireConsentForHost, true);
  assert.equal(modPolicyFromEnv({ SP_MOD_STRICT_GLOBALS: '0' }).scanProfile, 'legacy');
});

test('SP_MOD_BUDGET → 预算表（含 * fallback）；坏 JSON → 只关预算', () => {
  const ok = modPolicyFromEnv({ SP_MOD_BUDGET: '{"*":{"maxCalls":3}}' });
  assert.ok(ok.budget);
  assert.equal(ok.budget.trackerFor('anything').budget.maxCalls, 3);
  const bad = modPolicyFromEnv({ SP_MOD_BUDGET: 'nope', SP_MOD_STRICT_GLOBALS: '1' });
  assert.equal(bad.budget, null);
  assert.equal(bad.scanProfile, 'module', '坏预算不该连带关掉别的开关');
});

test('策略真的作用到 plan：打开 requireConsentForHost ⇒ 未同意的宿主档包被具名拒；关闭时行为不变', () => {
  const host = { id: 'h', hash: 'a'.repeat(64), combat: true, server: { modules: [{ id: 'm', entry: 'm.mjs', uses: ['boot'] }] } };
  const on = modPolicyFromEnv({ SP_MOD_REQUIRE_CONSENT: '1' });
  const planOn = buildActivationPlan({ packs: [host], options: { requireConsentForHost: on.requireConsentForHost } });
  assert.deepEqual(planOn.activated, []);
  assert.equal(planOn.warnings[0].code, 'SDK_NOT_CONSENTED');

  const off = modPolicyFromEnv({});
  const planOff = buildActivationPlan({ packs: [host], options: { requireConsentForHost: off.requireConsentForHost } });
  assert.deepEqual(planOff.activated, ['h'], '默认关闭时与旧行为一致');
});
