// test/modOfficialLoader.test.js — 官方档装载器：目录 → (描述符, 内容摘要) → ActivationPlan。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadOfficialPlugins, listPluginFiles, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { buildActivationPlan } from '../server/mod-manager/plan.js';
import { modDigest, modManifestDigest } from '../shared/sdk/digest.js';
import { SDK_OFFICIAL } from '../shared/sdk/sdkConstants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeRoot(plugins) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-official-'));
  for (const p of plugins) {
    const dir = path.join(root, p.name);
    fs.mkdirSync(dir, { recursive: true });
    // `manifest: undefined` = 故意不放 plugin.json（缺清单那条用例）
    if (p.manifest !== undefined) fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify(p.manifest));
    for (const [rel, body] of Object.entries(p.files || {})) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  }
  return root;
}

test('装载两个合法插件：描述符 + 64 位内容摘要 + 文件清单', () => {
  const root = makeRoot([
    { name: 'hello', manifest: { id: 'hello', name: 'Hello', version: '1.0.0', sdk: SDK_OFFICIAL, apis: ['content', 'health'] }, files: { 'data/chess.json': '{"a":1}' } },
    { name: 'world', manifest: { id: 'world', name: 'World', version: '2.0.0', sdk: SDK_OFFICIAL, profile: 'sandbox', entry: 'plugin.mjs' }, files: { 'plugin.mjs': 'export default {};' } },
  ]);
  try {
    const { present, plugins, errors } = loadOfficialPlugins(root, { log: quiet });
    assert.equal(present, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(plugins.map((p) => p.id), ['hello', 'world']);

    const hello = plugins[0];
    assert.equal(hello.descriptor.sdk, SDK_OFFICIAL);
    assert.equal(hello.descriptor.profile, 'module');
    assert.deepEqual(hello.descriptor.capabilities, ['content', 'health']);
    assert.match(hello.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(hello.files.map((f) => f.path), ['data/chess.json', OFFICIAL_PLUGIN_MANIFEST]);
    // 摘要就是「插件全部文件」的归一化哈希（同一份字节 ⇒ 同一份摘要）
    assert.equal(hello.hash, modManifestDigest(hello.files));
    assert.equal(hello.descriptor.contentDigest, hello.hash, '内容摘要必须回填进描述符');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('官方插件进同一份 ActivationPlan：两个都激活，集合摘要与独立重算一致', () => {
  const root = makeRoot([
    { name: 'hello', manifest: { id: 'hello', name: 'Hello', version: '1.0.0', sdk: SDK_OFFICIAL, apis: ['content'] }, files: {} },
    { name: 'world', manifest: { id: 'world', name: 'World', version: '1.0.0', sdk: SDK_OFFICIAL, apis: ['health'] }, files: {} },
  ]);
  try {
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const plan = buildActivationPlan({ packs: plugins, options: { origin: 'official' } });
    assert.deepEqual(plan.activated, ['hello', 'world']);
    assert.equal(plan.excluded.length, 0);
    assert.ok(plan.descriptors.every((d) => d.origin === 'official'));
    assert.equal(plan.digest.modDigest, modDigest(plugins.map((p) => ({ id: p.id, hash: p.hash }))));
    assert.equal(plan.digest.contentDigestOf.hello, plugins[0].hash);
    assert.match(plan.digest.activationDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(plan.warnings, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('一条用不了的声明：具名拒整包，且**不进**计划', () => {
  const root = makeRoot([
    { name: 'good', manifest: { id: 'good', name: 'G', version: '1.0.0', sdk: SDK_OFFICIAL, apis: ['health'] }, files: {} },
    { name: 'forgey', manifest: { id: 'forgey', name: 'F', version: '1.0.0', sdk: SDK_OFFICIAL, server: { modules: [] } }, files: {} },
    { name: 'mismatch', manifest: { id: 'not-the-dirname', name: 'M', version: '1.0.0', sdk: SDK_OFFICIAL }, files: {} },
    { name: 'broken' }, // 没有 plugin.json
  ]);
  try {
    const { plugins, errors } = loadOfficialPlugins(root, { log: quiet });
    assert.deepEqual(plugins.map((p) => p.id), ['good']);
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));
    assert.equal(byPack.forgey.code, 'SDK_UNKNOWN_FIELD');
    assert.match(byPack.forgey.reason, /Forge-only/);
    assert.equal(byPack.mismatch.code, 'OFFICIAL_ID_MISMATCH');
    assert.equal(byPack.broken.code, 'OFFICIAL_BAD_MANIFEST');

    const plan = buildActivationPlan({ packs: plugins, options: { origin: 'official' } });
    assert.deepEqual(plan.activated, ['good'], '被拒的插件不在计划里');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('目录不存在 ⇒ present=false、零包零错；listPluginFiles 不跟随符号链接', () => {
  const missing = path.join(tmpdir(), `sp-official-missing-${Date.now()}`);
  const r = loadOfficialPlugins(missing, { log: quiet });
  assert.equal(r.present, false);
  assert.deepEqual(r.plugins, []);
  assert.deepEqual(r.errors, []);

  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-official-link-'));
  try {
    fs.mkdirSync(path.join(root, 'p'), { recursive: true });
    fs.writeFileSync(path.join(root, 'p', 'real.txt'), 'x');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'y');
    try { fs.symlinkSync(path.join(root, 'outside.txt'), path.join(root, 'p', 'link.txt')); } catch { /* Windows 无权限时跳过 */ }
    assert.deepEqual(listPluginFiles(path.join(root, 'p')), ['real.txt'], '符号链接既不跟随也不列出');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
