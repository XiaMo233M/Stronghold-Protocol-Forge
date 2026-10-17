// test/editorWriteGate.test.js — 编辑器的**写请求来源闸**（CSRF / DNS rebinding）与导入端点的形态闸。
//
// 为什么必须钉住：编辑器是仓库里唯一会往 `workshop/` 写盘的东西，而它默认绑在**固定端口** 127.0.0.1:3311。
// 一个包可以声明 `server.modules`（在游戏服务端进程里执行的代码），所以「任何网页都能往这个端口 POST 一个 zip」
// 等于「任何网页都能往服务器进程里装代码」。两道互相独立的闸：
//   * `writeRefusal`：带 Origin/Sec-Fetch-Site 的写请求必须与 Host 同源；Host 必须是本机地址；
//   * 导入端点只收 octet-stream / zip（浏览器 no-cors 只能发 CORS-safelisted 的 Content-Type）。
//
// ⚠ 这个文件需要 `ws`（`editor/server.mjs` 会 import 游戏服务器，后者 import websocket）。本机没装
// node_modules 时跑不了 —— 与 `test/packManager.test.js` 同一类，属于 CI 腿。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createEditorServer, DATA_DIR } from '../editor/server.mjs';
import { zipWrite } from '../shared/zip.js';
import { readModRegistry } from '../server/modRegistry.js';

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

/** 用 node:http 发请求：**必须能控制 Host / Origin / Content-Type**（fetch 不允许改 Host）。 */
function request(server, { method = 'POST', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: server.host === '0.0.0.0' ? '127.0.0.1' : server.host,
      port: server.port,
      method,
      path: p,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withEditor(fn) {
  const workshopRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gate-ws-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gate-state-'));
  const server = await createEditorServer({
    workshopRoot, port: 0, host: '127.0.0.1',
    dataDir: DATA_DIR, supportFile: path.join(workshopRoot, 'support.json'), stateDir,
  });
  try {
    return await fn({ server, workshopRoot, stateDir, origin: server.url });
  } finally {
    await server.close();
    for (const d of [workshopRoot, stateDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } }
  }
}

test('非浏览器写请求（无 Origin / 无 Sec-Fetch-Site）照旧放行 —— CLI 与测试不该被误杀', async () => {
  await withEditor(async ({ server }) => {
    const r = await request(server, {
      path: '/api/packs/import',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': packZip('gate-plain').length },
      body: packZip('gate-plain'),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.pack, 'gate-plain');
  });
});

test('同源 Origin 放行；并且带服务端代码的包被登记为 disabled', async () => {
  await withEditor(async ({ server, origin, stateDir }) => {
    const zip = packZip('gate-code', { server: { modules: [{ id: 'm1', entry: 'server/m.mjs', uses: ['boot'] }] } });
    const r = await request(server, {
      path: '/api/packs/import',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': zip.length, Origin: origin },
      body: zip,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, false, '装上 ≠ 启用');
    assert.equal(readModRegistry(stateDir).packs['gate-code'].state, 'disabled');
  });
});

test('跨源 Origin ⇒ 403（这正是"任意网页装包"那条路）', async () => {
  await withEditor(async ({ server }) => {
    const zip = packZip('gate-evil');
    const r = await request(server, {
      path: '/api/packs/import',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': zip.length, Origin: 'https://evil.example' },
      body: zip,
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /cross-origin/i);
  });
});

test('Sec-Fetch-Site: cross-site ⇒ 403（即使没有 Origin）', async () => {
  await withEditor(async ({ server }) => {
    const r = await request(server, {
      path: '/api/packs/import',
      headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': 4,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: Buffer.from('junk'),
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /cross-site/i);
  });
});

test('Host 不是本机地址 ⇒ 403（DNS rebinding：攻击者域名解析到 127.0.0.1）', async () => {
  await withEditor(async ({ server }) => {
    const r = await request(server, {
      path: '/api/packs/import',
      headers: { Host: 'evil.example', 'Content-Type': 'application/octet-stream', 'Content-Length': 4 },
      body: Buffer.from('junk'),
    });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Host/i);
  });
});

test('导入端点只收 octet-stream / zip：text/plain ⇒ 415（掐掉 no-cors 那条路）', async () => {
  await withEditor(async ({ server }) => {
    const zip = packZip('gate-text');
    const r = await request(server, {
      path: '/api/packs/import',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': zip.length },
      body: zip,
    });
    assert.equal(r.status, 415);
    assert.match(r.json.error, /Content-Type/i);
  });
});

test('普通 JSON 写接口不受影响（同源 + application/json 照旧通过）', async () => {
  await withEditor(async ({ server, origin }) => {
    const body = Buffer.from(JSON.stringify({ id: 'json-demo', name: 'J', version: '1.0.0', content: ['chess'] }));
    const r = await request(server, {
      path: '/api/packs',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Origin: origin },
      body,
    });
    // 200 = 建好了；409/400 = 已存在/校验不过 —— 都不是 403/415，说明写闸没有误伤 JSON 接口
    assert.ok(![403, 415].includes(r.status), `JSON 写接口不该被来源闸拦下（实际 ${r.status}: ${r.text.slice(0, 120)}）`);
  });
});
