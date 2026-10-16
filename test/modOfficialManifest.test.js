// test/modOfficialManifest.test.js — 官方档 manifest 适配器，**按上游 0.3.0 的真词表**。
//
// 身份仍是 `sp:sdk@1`（业主口径：以官方身份出现、同时兼容 Forge），但**声明面**逐字对齐上游：
// `manifest:2` / `class` / `api` / `app` / `permissions`(闭集) / `entry{sim,meta,client,server}` / `slots` /
// `requires` / `overrides`。能力**由它们派生**（下游只认派生出来的那一层）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fromOfficialManifest, describePacks, OFFICIAL_DEFAULT_BUDGET,
  OFFICIAL_CLASSES, OFFICIAL_PERMISSIONS, CAPABILITIES_BY_PERMISSION,
} from '../shared/sdk/descriptor.js';
import { SDK_OFFICIAL, SDK_FORGE_LEGACY } from '../shared/sdk/sdkConstants.js';

const base = { manifest: 2, id: 'hello', name: 'Hello', version: '1.0.0', api: 1 };

test('content 档：能力由 class + permissions + parts **派生**（不再由调用方声明）', () => {
  const { descriptor, issues } = fromOfficialManifest({
    ...base, class: 'content', permissions: ['data.patch', 'dsl'], data: ['items.json'],
  });
  assert.deepEqual(issues, []);
  assert.equal(descriptor.origin, 'official');
  assert.equal(descriptor.sdk, SDK_OFFICIAL, '身份仍是 sp:sdk@1（业主口径）');
  assert.equal(descriptor.klass, 'content');
  assert.equal(descriptor.api, 1);
  assert.deepEqual(descriptor.capabilities, ['content'], 'class/permission/part 三条路都指向 content，去重');
  assert.deepEqual(descriptor.officialPermissions, ['data.patch', 'dsl'], '官方权限原样留一份');
  assert.deepEqual(descriptor.permissions, ['host.content'], '内部权限是派生出来的另一层');
  assert.equal(descriptor.layer, 'A', '没有任何服务端载荷 ⇒ A 档');
  assert.equal(descriptor.combat, false);
  assert.equal(descriptor.profile, 'module');
});

test('script 档：profile=sandbox、combat 由 sim.code 派生、entry 对象进 entrypoints', () => {
  const { descriptor, issues } = fromOfficialManifest({
    ...base, class: 'script', permissions: ['sim.code'], entry: { sim: 'sim/index.js' },
  });
  assert.deepEqual(issues, []);
  assert.equal(descriptor.profile, 'sandbox', 'script 走隔离沙箱（上游 SES Compartment）');
  assert.equal(descriptor.combat, true, 'sim.code 能改对局结果 —— 上游没有 combat 标志，判据是能力');
  assert.equal(descriptor.layer, 'B');
  assert.deepEqual(descriptor.capabilities, ['kits', 'modules', 'sim'], 'script 档 = 宿主进程壳 + 战斗内代码(+kits)');
  assert.deepEqual(descriptor.entrypoints, [{ kind: 'module', id: 'sim', entry: 'sim/index.js' }]);
  assert.equal(descriptor.activationPolicy.requiresConsent, false, '沙箱档不需要逐玩家同意（与上游一致）');
});

test('trusted 档：进宿主进程 ⇒ 默认要求同意', () => {
  const { descriptor, issues } = fromOfficialManifest({
    ...base, class: 'trusted', permissions: ['trusted.server'], entry: { server: 'server.js' },
  });
  assert.deepEqual(issues, []);
  assert.equal(descriptor.profile, 'module');
  assert.equal(descriptor.activationPolicy.requiresConsent, true);
  assert.ok(descriptor.permissions.includes('host.process'));
});

test('ui 档：panels 由 `entry.client` + `slots` 派生（槽位合法性留给装载桥判）', () => {
  const { descriptor, issues } = fromOfficialManifest({
    ...base, class: 'ui', permissions: ['ui.frame'], entry: { client: 'ui/index.html' }, slots: ['screen.game.hud'],
  });
  assert.deepEqual(issues, []);
  assert.equal(descriptor.layer, 'C');
  assert.deepEqual(descriptor.capabilities, ['panels']);
  assert.deepEqual(descriptor.slots, ['screen.game.hud']);
  assert.deepEqual(descriptor.panels, [{ id: 'hello:0', slot: 'screen.game.hud', module: 'ui/index.html' }]);
  assert.deepEqual(descriptor.permissions, ['client.frame']);
});

test('0.3.0 的版本闸门：manifest 必须是 2、api 必须在 [1,1]、越界**拒载**', () => {
  assert.ok(fromOfficialManifest({ ...base, class: 'content', manifest: 1 }).issues.some((i) => /manifest/.test(i.reason)));
  assert.equal(fromOfficialManifest({ ...base, class: 'content', manifest: 1 }).descriptor, null);
  const badApi = fromOfficialManifest({ ...base, class: 'content', api: 2 });
  assert.equal(badApi.descriptor, null);
  assert.ok(badApi.issues.some((i) => /api/.test(i.reason)));
  const noApi = fromOfficialManifest({ manifest: 2, id: 'x', version: '1.0.0', class: 'content' });
  assert.equal(noApi.descriptor, null);
  assert.ok(noApi.issues.some((i) => /"api"/.test(i.reason)));
});

test('点名拒绝：未知字段 / 未知 class / 未知 permission / 未知 entry 键', () => {
  assert.ok(fromOfficialManifest({ ...base, class: 'content', bogus: 1 }).issues.some((i) => i.code === 'SDK_UNKNOWN_FIELD' && /bogus/.test(i.reason)));
  assert.ok(fromOfficialManifest({ ...base, class: 'nope' }).issues.some((i) => /"class"/.test(i.reason)));
  assert.ok(fromOfficialManifest({ ...base, class: 'content', permissions: ['notify'] }).issues.some((i) => i.code === 'SDK_UNKNOWN_CAPABILITY' && /notify/.test(i.reason)));
  assert.ok(fromOfficialManifest({ ...base, class: 'ui', entry: { wrong: 'x.js' } }).issues.some((i) => /entry\.wrong/.test(i.reason)));
  // `budget` 不是官方字段（上游没有它）⇒ 同样点名拒
  assert.ok(fromOfficialManifest({ ...base, class: 'content', budget: { maxCalls: 100 } }).issues.some((i) => /budget/.test(i.reason)));
});

test('硬边界：官方 manifest 不许带 Forge 私有字段（Forge 包走 origin "forge"）', () => {
  for (const field of ['server', 'client', 'variants', 'behaviour', 'bonds', 'garrisons', 'kits']) {
    const r = fromOfficialManifest({ ...base, class: 'content', [field]: {} });
    assert.equal(r.descriptor, null, `${field} 必须被拒`);
    assert.ok(r.issues.some((i) => i.code === 'SDK_UNKNOWN_FIELD' && /Forge-only/.test(i.reason)), `${field}: 理由要点名 Forge-only`);
  }
  assert.equal(SDK_FORGE_LEGACY === SDK_OFFICIAL, false, '两个身份不相等');
});

test('overrides → metaRegisters（上游用 overrides 表达「能覆盖哪些官方 id」）', () => {
  const { descriptor } = fromOfficialManifest({
    ...base, class: 'script', permissions: ['sim.code', 'meta.code'], entry: { sim: 's.js', meta: 'm.js' }, overrides: ['item:x'],
  });
  assert.deepEqual(descriptor.metaRegisters, ['item:x']);
  assert.equal(descriptor.combat, true);
});

test('闭集常量本身就是契约；describePacks 分域；缺省预算只在内部', () => {
  assert.deepEqual([...OFFICIAL_CLASSES], ['lang', 'cosmetic', 'content', 'script', 'ui', 'trusted']);
  assert.deepEqual([...OFFICIAL_PERMISSIONS].sort(), ['assets.add', 'assets.override', 'data.add', 'data.patch', 'dsl', 'meta.code', 'mode.code', 'sim.code', 'theme', 'trusted.page', 'trusted.server', 'ui.frame']);
  assert.ok(Object.values(CAPABILITIES_BY_PERMISSION).every((v) => typeof v === 'string' && v.length));
  assert.equal(OFFICIAL_DEFAULT_BUDGET.maxCalls, 8000, '内部缺省（上游 manifest 没有 budget 字段）');

  const official = describePacks([{ ...base, class: 'content' }], { origin: 'official' });
  assert.equal(official.descriptors.length, 1);
  assert.equal(official.descriptors[0].origin, 'official');
  const forge = describePacks([{ id: 'f', hash: 'a'.repeat(64) }], { origin: 'forge' });
  assert.equal(forge.descriptors[0].sdk, SDK_FORGE_LEGACY, 'Forge 档描述符永远不会带 sp:sdk@1');
});
