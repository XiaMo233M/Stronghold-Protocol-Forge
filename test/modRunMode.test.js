// test/modRunMode.test.js — 运行模式（Phase 8）：official-only / official-preferred / legacy-compatible。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildActivationPlan } from '../server/mod-manager/plan.js';
import { RUN_MODES, DEFAULT_RUN_MODE, isRunMode } from '../shared/sdk/sdkConstants.js';

const H = (c) => c.repeat(64).slice(0, 64);
const forgePack = (id) => ({ id, hash: H('a') });
// 官方档的 manifest 用 0.3.0 词表（`class` + `permissions` + `entry`），能力由它们派生
const officialPlugin = (id) => ({ id, hash: H('b'), manifest: { manifest: 2, api: 1, id, name: id, version: '1.0.0', class: 'trusted', permissions: ['trusted.server'], entry: { server: 'plugin.mjs' } } });

test('缺省 = legacy-compatible：两种 origin 都放行，且不产生任何 mode 判定（行为不变）', () => {
  assert.equal(DEFAULT_RUN_MODE, 'legacy-compatible');
  const plan = buildActivationPlan({ packs: [forgePack('f')], options: { origin: 'forge' } });
  assert.equal(plan.mode, 'legacy-compatible');
  assert.deepEqual(plan.modeRefused, []);
  assert.deepEqual(plan.activated, ['f']);
  // 非法的 mode 字符串 ⇒ 回落缺省（绝不因为一个拼错的开关改变行为）
  const bad = buildActivationPlan({ packs: [forgePack('f')], options: { mode: 'OFFICIAL_ONLY' } });
  assert.equal(bad.mode, DEFAULT_RUN_MODE);
  assert.deepEqual(bad.activated, ['f']);
  assert.ok(RUN_MODES.every(isRunMode));
  assert.equal(isRunMode('nope'), false);
});

test('official-only：Forge 档被**具名**拒；官方档的一个都不拒', () => {
  // 一份计划只有一个 origin（混 origin 需要按包判定，那是「官方插件接线」那一步的事）。
  const forge = buildActivationPlan({ packs: [forgePack('f1'), forgePack('f2')], options: { origin: 'forge', mode: 'official-only' } });
  assert.deepEqual(forge.activated, []);
  assert.deepEqual(forge.modeRefused.map((r) => r.id).sort(), ['f1', 'f2']);
  assert.equal(forge.modeRefused[0].code, 'SDK_ORIGIN_NOT_ALLOWED');
  assert.match(forge.modeRefused[0].reason, /official-only/);
  assert.ok(forge.excluded.includes('f1'));

  const official = buildActivationPlan({ packs: [officialPlugin('o')], options: { origin: 'official', mode: 'official-only' } });
  assert.deepEqual(official.activated, ['o']);
  assert.deepEqual(official.modeRefused, []);
});

test('official-preferred：仍然放行，但 Forge 档**逐包告警**；官方档不告警', () => {
  const forge = buildActivationPlan({ packs: [forgePack('f')], options: { origin: 'forge', mode: 'official-preferred' } });
  assert.deepEqual(forge.modeRefused, []);
  assert.deepEqual(forge.activated, ['f']);
  assert.equal(forge.warnings.find((x) => x.id === 'f').code, 'SDK_LEGACY_IN_OFFICIAL_PREFERRED');

  const official = buildActivationPlan({ packs: [officialPlugin('o')], options: { origin: 'official', mode: 'official-preferred' } });
  assert.deepEqual(official.activated, ['o']);
  assert.equal(official.warnings.some((x) => x.code === 'SDK_LEGACY_IN_OFFICIAL_PREFERRED'), false, '官方档不被告警');
});

test('模式进激活摘要：换模式 ⇒ 摘要变（执行配置确实不同）', () => {
  const packs = [officialPlugin('o')];
  const a = buildActivationPlan({ packs, options: { origin: 'official' } });
  const b = buildActivationPlan({ packs, options: { origin: 'official', mode: 'official-only' } });
  assert.notEqual(a.digest.activationDigest, b.digest.activationDigest);
  // 但集合摘要（wire 语义）不受影响
  assert.equal(a.digest.modDigest, b.digest.modDigest);
});
