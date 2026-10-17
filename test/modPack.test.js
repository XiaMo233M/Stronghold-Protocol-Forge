// test/modPack.test.js — 作者侧打包/校验（`tools/mod-pack.mjs`）：同一棵树两次打包必须**逐字节相同**，
// 拒绝必须说人话，以及「默认产物不能把自己打进包」这条回归（改之前实测会把 dist/<id>.zip 装进去）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { zipRead } from '../shared/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'mod-pack.mjs');

/** 跑 CLI，返回 `{ code, out, err }`（不抛：拒绝是这条工具的正常输出）。 */
function run(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

function project(files, id = 'pack-demo') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modpack-'));
  const manifest = { id, name: 'Demo', version: '1.0.0', content: ['chess'], overrides: [] };
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files || { 'chess.json': JSON.stringify({ chess_ws_demo_a: { id: 'chess_ws_demo_a', name: 'D', charId: 'chess_ws_demo_a' } }) })) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

test('同一棵树打两次 ⇒ 逐字节相同（确定性）', () => {
  const dir = project({ 'chess.json': '{}', 'README.md': 'hello\n' });
  const a = path.join(os.tmpdir(), `sp-modpack-a-${process.pid}.zip`);
  const b = path.join(os.tmpdir(), `sp-modpack-b-${process.pid}.zip`);
  try {
    assert.equal(run(['pack', dir, '-o', a]).code, 0);
    assert.equal(run(['pack', dir, '-o', b]).code, 0);
    assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), '同一份输入的两个 zip 必须逐字节相同');
    const entries = zipRead(fs.readFileSync(a)).entries.map((e) => e.name).sort();
    assert.deepEqual(entries, ['README.md', 'chess.json', 'pack.json'], 'README 也进包（与已安装包的 listPackFiles 同一条口径）');
  } finally {
    for (const p of [a, b]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('默认产物不会被装进下一个包（dist/<id>.zip 自指回归）', () => {
  const dir = project({ 'chess.json': '{}' });
  const out = path.join(os.tmpdir(), `sp-modpack-c-${process.pid}.zip`);
  try {
    // 第一次：落在默认 dist/
    assert.equal(run(['pack', dir]).code, 0);
    assert.ok(fs.existsSync(path.join(dir, 'dist', 'pack-demo.zip')), '默认输出在 dist/<id>.zip');
    // 第二次：产物已经存在，不能再被打进来
    assert.equal(run(['pack', dir, '-o', out]).code, 0);
    const entries = zipRead(fs.readFileSync(out)).entries.map((e) => e.name).sort();
    assert.deepEqual(entries, ['chess.json', 'pack.json'], 'dist/ 里的上一次产物绝不能进包');
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('项目目录必须显式写 id（不从文件夹名猜）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modpack-noid-'));
  try {
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ name: 'x', content: ['chess'] }));
    fs.writeFileSync(path.join(dir, 'chess.json'), '{}');
    const r = run(['pack', dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /必须显式写 "id"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('闭集外的键 ⇒ 拒绝并点名（与加载器同一个校验函数）', () => {
  const dir = project({ 'chess.json': '{}' });
  try {
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id: 'pack-demo', content: ['chess'], bogus: 1 }));
    const r = run(['pack', dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /bogus|未知|闭集|not a known/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('声明了内容却没给文件 ⇒ 打包前就拒（否则装得上、加载时被丢）', () => {
  const dir = project();
  try {
    fs.rmSync(path.join(dir, 'chess.json'));
    const r = run(['pack', dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /chess\.json/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('check：目录与 zip 都能验，且在内存里验（不解压到盘）', () => {
  const dir = project({ 'chess.json': '{}' });
  const out = path.join(os.tmpdir(), `sp-modpack-d-${process.pid}.zip`);
  try {
    const d = run(['check', dir, '--json']);
    assert.equal(d.code, 0);
    assert.equal(JSON.parse(d.out).id, 'pack-demo');

    assert.equal(run(['pack', dir, '-o', out]).code, 0);
    const z = run(['check', out, '--json']);
    assert.equal(z.code, 0);
    const report = JSON.parse(z.out);
    assert.equal(report.kind, 'zip');
    assert.equal(report.id, 'pack-demo');
    assert.equal(report.prefix, '', '清单在 zip 根');
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('check：坏 zip 被具名拒绝（读侧的上限/结构判据直接复用）', () => {
  const bad = path.join(os.tmpdir(), `sp-modpack-bad-${process.pid}.zip`);
  try {
    fs.writeFileSync(bad, 'not a zip at all');
    const r = run(['check', bad]);
    assert.equal(r.code, 1);
    assert.match(r.err, /zip/i);
  } finally { try { fs.rmSync(bad, { force: true }); } catch { /* ignore */ } }
});

test('check：唯一顶层目录的布局也认（站点"打包下载"的形状）', async () => {
  const dir = project();
  const out = path.join(os.tmpdir(), `sp-modpack-nest-${process.pid}.zip`);
  const outer = path.join(os.tmpdir(), `sp-modpack-outer-${process.pid}.zip`);
  try {
    assert.equal(run(['pack', dir, '-o', out]).code, 0);
    // 手工造一个「多一层顶层目录」的归档
    const { zipRead, zipWrite } = await import('../shared/zip.js');
    const inner = zipRead(fs.readFileSync(out));
    assert.ok(inner.ok);
    fs.writeFileSync(outer, zipWrite(inner.entries.map((e) => ({ name: `pack-demo/${e.name}`, data: e.data }))));
    const r = run(['check', outer, '--json']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).prefix, 'pack-demo/');
  } finally {
    for (const p of [out, outer]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
