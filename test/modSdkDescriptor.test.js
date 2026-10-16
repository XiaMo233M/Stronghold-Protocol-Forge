// test/modSdkDescriptor.test.js — shared/sdk 的 SDK 边界与归一化描述符。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SDK_UPSTREAM, SDK_FORGE_EXT, profileAllowedFor, sdkForOrigin, defaultProfileFor,
} from '../shared/sdk/sdkConstants.js';
import { fromForgeManifest, fromOfficialManifest, normalizeDescriptor, capabilityUnion } from '../shared/sdk/descriptor.js';

const H = (c) => c.repeat(64).slice(0, 64);

test('sdk 标识由 origin 决定，跨域 profile 被拒', () => {
  assert.equal(sdkForOrigin('official'), SDK_UPSTREAM);
  assert.equal(sdkForOrigin('forge'), SDK_FORGE_EXT);
  assert.equal(sdkForOrigin('nope'), null);
  assert.equal(defaultProfileFor('official'), 'module');
  assert.equal(defaultProfileFor('forge'), 'legacy');

  assert.equal(profileAllowedFor('official', 'module'), true);
  assert.equal(profileAllowedFor('official', 'sandbox'), true);
  assert.equal(profileAllowedFor('official', 'legacy'), false);
  assert.equal(profileAllowedFor('forge', 'host'), true);
  assert.equal(profileAllowedFor('forge', 'legacy'), true);
  assert.equal(profileAllowedFor('forge', 'sandbox'), false);
});

test('Forge 适配器：声明了宿主进程内代码的包 → profile host + 权限', () => {
  const pack = {
    id: 'demo', version: '1.0.0', hash: H('a'), combat: true, layer: 'B',
    server: { modules: [{ id: 'm1', entry: 'server/m1.mjs', uses: ['boot', 'healthz', 'metrics'], write: true, channels: ['c'] }] },
    content: { chess: {} },
  };
  const { descriptor, issues } = fromForgeManifest(pack);
  assert.deepEqual(issues, []);
  assert.equal(descriptor.origin, 'forge');
  assert.equal(descriptor.sdk, SDK_FORGE_EXT);
  assert.equal(descriptor.profile, 'host');
  assert.ok(descriptor.capabilities.includes('modules'));
  assert.ok(descriptor.capabilities.includes('health'));
  assert.ok(descriptor.capabilities.includes('metrics'));
  assert.ok(descriptor.capabilities.includes('storage') === false, 'storage 只在显式能力里；modules 带的是 host.process');
  assert.ok(descriptor.permissions.includes('host.process'));
  assert.ok(descriptor.permissions.includes('host.storage.write'));
  assert.equal(descriptor.contentDigest, H('a'));
  assert.equal(descriptor.activationPolicy.requiresConsent, true);
});

test('Forge 适配器：纯数据包 → profile legacy、无权限、无需同意', () => {
  const { descriptor, issues } = fromForgeManifest({ id: 'dataonly', version: '0.1.0', hash: H('b'), content: { items: {} }, i18n: { en: {} } });
  assert.deepEqual(issues, []);
  assert.equal(descriptor.profile, 'legacy');
  assert.deepEqual(descriptor.permissions, []);
  assert.equal(descriptor.activationPolicy.requiresConsent, false);
  assert.ok(descriptor.capabilities.includes('content'));
  assert.ok(descriptor.capabilities.includes('i18n'));
});

test('Forge 适配器：combat-only 能力缺 combat:true → 具名 issue', () => {
  const { descriptor, issues } = fromForgeManifest({ id: 'x', hash: H('c'), server: { battle: { module: 'b.mjs' } } });
  assert.equal(descriptor, null);
  assert.equal(issues[0].code, 'SDK_COMBAT_REQUIRED');
});

test('Forge 适配器：`content` 是文件名数组（loader 的归一化形状）也能识别', () => {
  const { descriptor } = fromForgeManifest({ id: 'arr', hash: H('d'), content: ['chess', 'items'] });
  assert.ok(descriptor.capabilities.includes('content'));
  assert.deepEqual(descriptor.content, ['chess', 'items']);
});

test('官方适配器：缺 sdk / 带 Forge 私有字段 / 未知名 → 具名拒绝', () => {
  assert.equal(fromOfficialManifest({ id: 'x' }).descriptor, null, '缺 sdk ⇒ 拒');
  const forgeField = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, server: {} });
  assert.ok(forgeField.issues.some((i) => i.code === 'SDK_UNKNOWN_FIELD' && /Forge-only/.test(i.reason)));
  const unknown = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, bogus: 1 });
  assert.ok(unknown.issues.some((i) => i.code === 'SDK_UNKNOWN_FIELD'));
});

test('normalizeDescriptor：未知字段点名拒绝、跨域 profile 拒绝、sdk 必须与 origin 一致', () => {
  const bad = normalizeDescriptor({ id: 'p', origin: 'official', sdk: SDK_UPSTREAM, profile: 'legacy', bogus: 1 });
  assert.equal(bad.descriptor, null);
  const codes = bad.issues.map((i) => i.code);
  assert.ok(codes.includes('SDK_UNKNOWN_FIELD'));
  assert.ok(codes.includes('SDK_PROFILE_NOT_FOR_ORIGIN'));

  const okOfficial = normalizeDescriptor({ id: 'p', origin: 'official', sdk: SDK_UPSTREAM, profile: 'module', capabilities: ['modules'] });
  assert.equal(okOfficial.descriptor.profile, 'module');
  assert.equal(okOfficial.descriptor.sdk, SDK_UPSTREAM);

  const badSdk = normalizeDescriptor({ id: 'p', origin: 'forge', sdk: SDK_UPSTREAM, profile: 'legacy' });
  assert.equal(badSdk.descriptor, null);
  assert.equal(badSdk.issues[0].code, 'SDK_BAD_ORIGIN');
});

test('capabilityUnion 合并去重排序', () => {
  const u = capabilityUnion([{ capabilities: ['b', 'a'] }, { capabilities: ['a', 'c'] }]);
  assert.deepEqual(u, ['a', 'b', 'c']);
});
