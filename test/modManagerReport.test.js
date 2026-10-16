// test/modManagerReport.test.js — CLI 级集成：从真实工坊目录到三摘要，走**生产装载器**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { SDK_UPSTREAM } from '../shared/sdk/sdkConstants.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'mod-manager-report.mjs');
const EXAMPLES = path.join(ROOT, 'docs', 'examples');

const runTool = (args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });

test('真实示例工坊：JSON 报告里 3 包全激活、三摘要齐全、退出码 0', () => {
  const r = runTool(['--workshop', EXAMPLES, '--json', '--state', path.join(tmpdir(), `sp-report-${process.pid}`)]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, 'legacy-compatible');
  assert.equal(report.sources.workshop.present, true);
  const forge = report.plans.forge;
  assert.equal(forge.counts.activated, 3);
  assert.equal(forge.counts.excluded, 0);
  assert.deepEqual(forge.packages.map((p) => p.id).sort(), ['clementia', 'demo-workshop', 'kit-demo']);
  assert.ok(forge.packages.every((p) => p.status === 'activated' && p.sdk === 'forge-ext@1'));
  assert.match(forge.digest.modDigest, /^[0-9a-f]{64}$/);
  assert.match(forge.digest.activationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(forge.capabilities, ['assets', 'content']);
  // 没有 plugins/ 目录时不报错，只是 present=false、零包
  assert.equal(report.sources.plugins.present, false);
  assert.equal(report.plans.official.counts.activated, 0);
  assert.match(report.plans.official.digest.activationDigest, /^[0-9a-f]{64}$/);
});

test('official-only 模式：同一批 Forge 包被**具名**拒（报告里看得见为什么）', () => {
  const r = runTool(['--workshop', EXAMPLES, '--mode', 'official-only', '--json', '--state', path.join(tmpdir(), `sp-report-mode-${process.pid}`)]);
  assert.equal(r.status, 0, r.stderr);
  const forge = JSON.parse(r.stdout).plans.forge;
  assert.equal(forge.counts.activated, 0);
  assert.equal(forge.counts.excluded, 3);
  assert.ok(forge.packages.every((p) => p.status === 'excluded' && p.code === 'SDK_ORIGIN_NOT_ALLOWED'));
});

test('官方插件目录：一个插件被装成候选包并激活（同一份计划接口）', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-report-plugins-'));
  try {
    const p = path.join(dir, 'hello');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({ id: 'hello', name: 'Hello', version: '1.0.0', sdk: SDK_UPSTREAM, apis: ['health'] }));

    const r = runTool(['--workshop', EXAMPLES, '--plugins', dir, '--json', '--state', path.join(tmpdir(), `sp-report-plug-${process.pid}`)]);
    assert.equal(r.status, 0, r.stderr);
    const off = JSON.parse(r.stdout).plans.official;
    assert.equal(off.counts.activated, 1);
    assert.equal(off.packages[0].id, 'hello');
    assert.equal(off.packages[0].sdk, 'sp:sdk@1');
    assert.equal(off.packages[0].profile, 'module');
    assert.ok(off.packages[0].capabilities.includes('health'));
    assert.match(off.packages[0].contentDigest, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('用法错误 ⇒ 退出码 2（绝不印一份看着正常的报告）', () => {
  const r = runTool(['--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument/);
});

test('人类可读模式：非 JSON 输出点名包与两个摘要', () => {
  const r = runTool(['--workshop', EXAMPLES, '--state', path.join(tmpdir(), `sp-report-human-${process.pid}`)]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[forge\] 3 activated \/ 0 excluded/);
  assert.match(r.stdout, /\+ clementia/);
  assert.match(r.stdout, /modDigest=[0-9a-f]{64}/);
  assert.match(r.stdout, /activationDigest=[0-9a-f]{64}/);
});
