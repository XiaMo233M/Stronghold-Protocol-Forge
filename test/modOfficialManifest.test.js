// test/modOfficialManifest.test.js — 官方档 `sp:sdk@1` 的 manifest 适配器（provisional）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fromOfficialManifest, describePacks, OFFICIAL_DEFAULT_BUDGET, OFFICIAL_API_MAP,
} from '../shared/sdk/descriptor.js';
import { SDK_OFFICIAL, SDK_FORGE_LEGACY } from '../shared/sdk/sdkConstants.js';

const base = { id: 'hello', name: 'Hello', version: '1.0.0', sdk: SDK_OFFICIAL };

test('合法 module 档：apis → capabilities，权限与缺省预算（8000 次）派生正确', () => {
  const { descriptor, issues } = fromOfficialManifest({
    ...base, apis: ['content', 'storage', 'health', 'http.route', 'lobby.on'],
  });
  assert.deepEqual(issues, []);
  assert.equal(descriptor.origin, 'official');
  assert.equal(descriptor.sdk, SDK_OFFICIAL);
  assert.equal(descriptor.profile, 'module');
  assert.deepEqual(descriptor.capabilities, ['content', 'health', 'lobby', 'routes', 'storage']);
  assert.deepEqual(descriptor.permissions, ['host.http', 'host.storage', 'lobby.observe']);
  assert.equal(descriptor.budget.maxCalls, 8000, '文档里的「8000 次插件预算」是官方档缺省');
  assert.equal(descriptor.activationPolicy.requiresConsent, true, 'module 档跑在宿主进程 ⇒ 默认要求同意');
  assert.equal(descriptor.contentDigest, null, '字节摘要由官方装载器回填');
});

test('sandbox 档：必须有 entry；且 sandbox 不默认要求同意（隔离运行时）', () => {
  const noEntry = fromOfficialManifest({ ...base, profile: 'sandbox' });
  assert.equal(noEntry.descriptor, null);
  assert.ok(noEntry.issues.some((i) => i.code === 'SDK_BAD_DESCRIPTOR' && /entry/.test(i.reason)));

  const ok = fromOfficialManifest({ ...base, profile: 'sandbox', entry: 'plugin.mjs', apis: ['health'] });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.descriptor.profile, 'sandbox');
  assert.equal(ok.descriptor.activationPolicy.requiresConsent, false);
  assert.equal(ok.descriptor.entrypoints[0].kind, 'sandboxModule');
});

test('未知名 / 未知 api 都点名拒绝（不猜）', () => {
  const a = fromOfficialManifest({ ...base, bogus: 1 });
  assert.equal(a.descriptor, null);
  assert.ok(a.issues.some((i) => i.code === 'SDK_UNKNOWN_FIELD' && /bogus/.test(i.reason)));

  const b = fromOfficialManifest({ ...base, apis: ['notify'] });
  assert.equal(b.descriptor, null);
  assert.ok(b.issues.some((i) => i.code === 'SDK_UNKNOWN_CAPABILITY' && /notify/.test(i.reason)));
});

test('硬边界：官方 manifest 不许带 Forge 私有字段，Forge 档不许自称 sp:sdk@1', () => {
  for (const field of ['server', 'client', 'variants', 'behaviour', 'bonds', 'garrisons', 'kits']) {
    const r = fromOfficialManifest({ ...base, [field]: {} });
    assert.equal(r.descriptor, null, `${field} 必须被拒`);
    assert.ok(r.issues.some((i) => i.code === 'SDK_UNKNOWN_FIELD' && /Forge-only/.test(i.reason)), `${field}: 理由要点名 Forge-only`);
  }
  // 官方档的 profile 只能是 module/sandbox
  const legacyProfile = fromOfficialManifest({ ...base, profile: 'legacy' });
  assert.equal(legacyProfile.descriptor, null);
  assert.ok(legacyProfile.issues.some((i) => i.code === 'SDK_PROFILE_NOT_FOR_ORIGIN'));
  // 官方标识不可冒充（sdk 与 origin 必须一致）
  assert.equal(SDK_FORGE_LEGACY === SDK_OFFICIAL, false);
});

test('combat-only 能力缺 combat:true ⇒ 拒', () => {
  const r = fromOfficialManifest({ ...base, apis: ['meta.register'] });
  assert.equal(r.descriptor, null);
  assert.ok(r.issues.some((i) => i.code === 'SDK_COMBAT_REQUIRED'));
  const ok = fromOfficialManifest({ ...base, combat: true, apis: ['meta.register'] });
  assert.equal(ok.descriptor.combat, true);
  assert.ok(ok.descriptor.permissions.includes('host.process'));
});

test('显式 budget 覆盖缺省，只覆盖给出的字段', () => {
  const { descriptor } = fromOfficialManifest({ ...base, budget: { maxCalls: 100 } });
  assert.equal(descriptor.budget.maxCalls, 100);
  assert.equal(descriptor.budget.maxConcurrentCalls, OFFICIAL_DEFAULT_BUDGET.maxConcurrentCalls);
});

test('describePacks 走 official 适配器；官方包与 Forge 包分域', () => {
  const official = describePacks([{ ...base, apis: ['content'] }], { origin: 'official' });
  assert.equal(official.descriptors.length, 1);
  assert.equal(official.descriptors[0].origin, 'official');
  // Forge 档描述符永远不会带 sp:sdk@1
  const forge = describePacks([{ id: 'f', hash: 'a'.repeat(64) }], { origin: 'forge' });
  assert.equal(forge.descriptors[0].sdk, SDK_FORGE_LEGACY);
  // api 表是闭集，键都是能力名
  assert.ok(Object.values(OFFICIAL_API_MAP).every((v) => typeof v === 'string' && v.length));
});
