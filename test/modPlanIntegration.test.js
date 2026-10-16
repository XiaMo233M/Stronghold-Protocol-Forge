// test/modPlanIntegration.test.js — ActivationPlan × **真实 loadWorkshop 输出**。
//
// 这是收敛正确性的证据：计划不是「另一套算法」，它必须与既有流水线（applyModRegistry / 装载裁剪）对同一份输入
// 得出**同一个**激活集合与同一个集合摘要。否则「所有运行时消费同一份计划」只是在换一个更容易错的答案。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadWorkshop } from '../server/workshop.js';
import { buildActivationPlan } from '../server/mod-manager/plan.js';
import { applyModRegistry } from '../server/modRegistry.js';
import { modDigest } from '../shared/sdk/digest.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 仓库里既有的**真实**示例工坊（三份示例包；`test/modAssets.test.js` 用同一个夹具）。 */
const EXAMPLES = path.join(ROOT, 'docs', 'examples');
const EXAMPLE_IDS = ['clementia', 'demo-workshop', 'kit-demo'];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('真实示例工坊：plan.activated == loadWorkshop 的包集合，集合摘要与独立重算一致', () => {
  const loaded = loadWorkshop(EXAMPLES, { log: quiet });
  assert.deepEqual(loaded.errors, [], '三份示例包必须都加载成功');
  assert.deepEqual(loaded.packs.map((p) => p.id).sort(), EXAMPLE_IDS);

  const plan = buildActivationPlan({ packs: loaded.packs, registry: null });
  assert.deepEqual(plan.activated.slice().sort(), EXAMPLE_IDS);
  assert.deepEqual(plan.excluded, []);
  assert.equal(plan.digest.modDigest, modDigest(loaded.packs.map((p) => ({ id: p.id, hash: p.hash }))),
    '计划里的集合摘要必须等于对真实装载结果重算的值');
  for (const p of loaded.packs) assert.equal(plan.digest.contentDigestOf[p.id], p.hash);
  assert.match(plan.digest.activationDigest, /^[0-9a-f]{64}$/);
  assert.equal(plan.descriptorById.size, loaded.packs.length);
});

test('登记册禁用：plan 与既有 applyModRegistry 得出同一个 disabled 集合（两条路同答案）', () => {
  const loaded = loadWorkshop(EXAMPLES, { log: quiet });
  const registry = { version: 1, packs: { clementia: { state: 'disabled' } } };

  const legacy = applyModRegistry(loaded.packs, registry);
  const plan = buildActivationPlan({ packs: loaded.packs, registry });

  assert.deepEqual(plan.disabled.map((d) => d.id), legacy.disabled.map((d) => d.id));
  assert.deepEqual(plan.activated.slice().sort(), ['demo-workshop', 'kit-demo']);
  assert.ok(plan.excluded.includes('clementia'));
  assert.ok(!plan.activatedSet.has('clementia'));
  assert.ok(plan.excludedSet.has('clementia'));
});

test('宿主档包（真实 server.modules）：描述符判为 host 档；默认不因同意机制被裁', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-plan-'));
  try {
    const dir = path.join(root, 'ops');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'ops', name: 'OPS', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      layer: 'B', combat: true,
      server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'], write: true }] },
    }));
    fs.writeFileSync(path.join(dir, 'server', 'm.mjs'), 'export function registerServer(host) { host.onBoot(() => {}); }\n');

    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    const plan = buildActivationPlan({ packs: loaded.packs });
    assert.deepEqual(plan.activated, ['ops'], '默认（consent 关）不裁掉宿主档包 —— 行为不变');

    const d = plan.descriptorById.get('ops');
    assert.equal(d.profile, 'host');
    assert.ok(d.permissions.includes('host.process'));
    assert.ok(d.capabilities.includes('modules'));

    const strict = buildActivationPlan({ packs: loaded.packs, options: { requireConsentForHost: true } });
    assert.deepEqual(strict.activated, [], '打开同意要求后未同意 ⇒ 被裁');
    assert.equal(strict.warnings.find((w) => w.id === 'ops').code, 'SDK_NOT_CONSENTED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('干净安装（空工坊目录）：无包、无摘要、不报错', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-plan-empty-'));
  try {
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.packs, []);
    const plan = buildActivationPlan({ packs: loaded.packs, registry: null });
    assert.deepEqual(plan.activated, []);
    assert.equal(plan.digest.modDigest, null);
    assert.deepEqual(plan.errors, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
