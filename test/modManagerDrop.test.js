// test/modManagerDrop.test.js — 「把 zip 拖进 mod 目录就自动装上」这条链路：
//   真实调用 `tools/mod-manager.mjs` 的 `processZip` / `drain`（不是重写一份逻辑）。
//
// 钉住四件事：
//   1. 拖进来的 zip 会被**安装**、原文件被搬到 `.mod-inbox/installed/`（搬而不是删）；
//   2. 带**服务端代码**的包装完落 `disabled`（装上 ≠ 启用）；纯数据包不写登记册；
//   3. 坏 zip 被搬到 `.mod-inbox/failed/` 并留下 `.reason.txt`，**并且不打断同一轮的其它文件**
//      （上一版在这里真断过：第一次失败就把文件搬走，重试读到 ENOENT，整轮循环被打断）；
//   4. 重试期间源文件必须还在原地（失败不立即搬）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { zipWrite } from '../shared/zip.js';
import { processZip, drain, pendingZips, declaresServerCode } from '../tools/mod-manager.mjs';
import { readModRegistry } from '../server/modRegistry.js';

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sp-drop-${tag}-`));
}

/** 造一个最小可安装的包 zip。`server` 块在场 ⇒ 它带服务端代码。 */
function packZip(id, { server = null } = {}) {
  const manifest = { id, name: id, version: '1.0.0', content: ['chess'], overrides: [] };
  if (server) manifest.server = server;
  const files = [
    { name: 'pack.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'chess.json', data: JSON.stringify({ [`chess_${id.replace(/-/g, '_')}_a`]: { id: `chess_${id.replace(/-/g, '_')}_a`, name: 'X' } }) },
  ];
  if (server) files.push({ name: 'server/m.mjs', data: 'export function registerServer(){}\n' });
  return zipWrite(files);
}

function cleanup(...dirs) {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } }
}

test('declaresServerCode：只认服务端执行面，routes 不算', () => {
  assert.equal(declaresServerCode({ server: { modules: [{ id: 'm' }] } }), true);
  assert.equal(declaresServerCode({ server: { battle: { module: 'b.mjs' } } }), true);
  assert.equal(declaresServerCode({ server: { meta: [{ id: 'm' }] } }), true);
  assert.equal(declaresServerCode({ server: { room: { module: 'r.mjs' } } }), true);
  assert.equal(declaresServerCode({ server: { routes: [{ path: '/mod/x/' }] } }), false, '只读端点不是"跑代码"');
  assert.equal(declaresServerCode({ content: ['chess'] }), false);
  assert.equal(declaresServerCode(null), false);
  assert.equal(declaresServerCode({ server: { modules: [] } }), false);
});

test('纯数据包：装上、原 zip 搬进 installed/、不写登记册（缺省即启用）', async () => {
  const root = tmpdir('data');
  const state = tmpdir('state');
  try {
    const zipPath = path.join(root, 'demo.zip');
    fs.writeFileSync(zipPath, packZip('data-demo'));
    const results = await drain(root, { stateRoot: state, report: () => {}, json: false });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].id, 'data-demo');
    assert.equal(results[0].enabled, null, '纯数据包不落登记册');
    assert.ok(fs.existsSync(path.join(root, 'data-demo', 'pack.json')), '装到了 workshop/<id>/');
    assert.equal(fs.existsSync(zipPath), false, '原 zip 被搬走（不是留在原地反复装）');
    assert.ok(results[0].movedTo && results[0].movedTo.includes('.mod-inbox'), '留底在 .mod-inbox 下');
    assert.ok(fs.existsSync(results[0].movedTo), '留底文件真的在');
    const registry = readModRegistry(state);
    assert.equal(registry.packs['data-demo'], undefined, '登记册里没有它 ⇒ 按缺省启用');
  } finally { cleanup(root, state); }
});

test('带服务端代码的包：装上但**登记为 disabled**（装上 ≠ 启用）', async () => {
  const root = tmpdir('code');
  const state = tmpdir('state');
  try {
    fs.writeFileSync(path.join(root, 'code.zip'), packZip('code-demo', { server: { modules: [{ id: 'm1', entry: 'server/m.mjs', uses: ['boot'] }] } }));
    const [r] = await drain(root, { stateRoot: state, report: () => {}, json: false });
    assert.equal(r.ok, true);
    assert.equal(r.enabled, false);
    const registry = readModRegistry(state);
    assert.equal(registry.packs['code-demo'].state, 'disabled', '必须在登记册里显式禁用');
  } finally { cleanup(root, state); }
});

test('坏 zip：搬进 failed/ + 留 .reason.txt，且不打断同一轮的其它文件', async () => {
  const root = tmpdir('mixed');
  const state = tmpdir('state');
  try {
    // 故意让坏文件排在前面（pendingZips 按名字排序：a-broken < b-good）
    fs.writeFileSync(path.join(root, 'a-broken.zip'), 'not a zip');
    fs.writeFileSync(path.join(root, 'b-good.zip'), packZip('good-demo'));
    const results = await drain(root, { stateRoot: state, report: () => {}, json: false });
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false, '第一个是坏包');
    assert.match(results[0].reason, /zip/i);
    assert.equal(results[1].ok, true, '坏包之后的文件照旧装上（上一版会在这里整轮中断）');
    assert.ok(fs.existsSync(path.join(root, 'good-demo', 'pack.json')));
    const failedDir = path.join(root, '.mod-inbox', 'failed');
    const failedFiles = fs.readdirSync(failedDir).filter((f) => f.endsWith('a-broken.zip'));
    assert.equal(failedFiles.length, 1, '坏 zip 被留底');
    const reasonFile = fs.readdirSync(failedDir).find((f) => f.endsWith('.reason.txt'));
    assert.ok(reasonFile, '失败原因落盘（不是只在终端滚过去）');
    assert.match(fs.readFileSync(path.join(failedDir, reasonFile), 'utf8'), /zip/i);
  } finally { cleanup(root, state); }
});

test('重试期间源文件留在原地：一次失败不立即搬走', () => {
  const root = tmpdir('retry');
  const state = tmpdir('state');
  try {
    const zipPath = path.join(root, 'half.zip');
    fs.writeFileSync(zipPath, 'truncated');
    const r = processZip(root, zipPath, { stateRoot: state });
    assert.equal(r.ok, false);
    assert.ok(fs.existsSync(zipPath), 'processZip 自己**不搬文件**（搬由 drain 在结论之后做）');
    assert.equal(fs.existsSync(path.join(root, '.mod-inbox')), false, '还没搬，就不该建 .mod-inbox');
  } finally { cleanup(root, state); }
});

test('.mod-inbox 下的包不会被当成待安装（避免自装循环）', async () => {
  const root = tmpdir('loop');
  const state = tmpdir('state');
  try {
    fs.mkdirSync(path.join(root, '.mod-inbox', 'installed'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mod-inbox', 'installed', 'x.zip'), packZip('loop-demo'));
    assert.deepEqual(pendingZips(root), [], 'installed/ 里的留底不算待安装');
  } finally { cleanup(root, state); }
});

test('两个文件同名 id：第二个被拒（不静默覆盖），但同一轮继续', async () => {
  const root = tmpdir('dup');
  const state = tmpdir('state');
  try {
    fs.writeFileSync(path.join(root, 'a.zip'), packZip('dup-demo'));
    fs.writeFileSync(path.join(root, 'b.zip'), packZip('dup-demo'));
    const results = await drain(root, { stateRoot: state, report: () => {}, json: false });
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false, '同 id 第二次安装必须拒绝（覆盖要显式 force）');
    assert.match(results[1].reason, /已经存在|force/i);
  } finally { cleanup(root, state); }
});
