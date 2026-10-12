// test/laneDefaults.test.js — 「缺省逐字节不变」的钉子：不给任何 lane 表时，服务器还是原来那一个。
//
// 为什么单独一个文件：§28.44（升级路径表）与 §28.45（请求路径表）都是**加法** —— 它们各把一条写死的路由规则
// 换成一张表。表为空（= 缺省，也是 `npm start` 唯一的那一种）时行为必须与改动前**逐字节相同**，而这件事
// 没有任何别的测试在守：`test/wsLanes.test.js` / `test/httpLanes.test.js` 测的全是「给了表之后」。
//
// 判据分两层，每层各钉一条路：
//   ① 真 socket / 真请求：**根本不传** `lanes` / `httpLanes` 这两个键（不是传 `[]` —— 缺省就是没有这个键），
//      看服务器是不是还只认 `/ws`（其余 404），以及 `POST /healthz` 是不是还 405、未知路径是不是还落静态。
//   ② 源码级：两个分派点都必须以「空表 ⇒ 不接管」为出口；lane 必须在方法闸**之前**被问到。
// Run: node --test test/laneDefaults.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';

import { WebSocket } from 'ws';

import { attachWebSocket } from '../server/http/websocket.js';
import { validateLanes } from '../server/http/wsLanes.js';
import { createRequestHandler } from '../server/http/routes.js';
import { validateHttpLanes } from '../server/http/httpLanes.js';

const captureLog = () => { const lines = []; return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };

// ---- ① 真 socket：缺省（连 `lanes` 键都没有）-------------------------------------------------------------

/** Boot the real upgrade listener with **no** `lanes` key at all — the shape a plain `npm start` has. */
const bootDefault = async () => {
  const server = http.createServer();
  const gameSeen = [];
  const log = captureLog();
  const wss = attachWebSocket(server, {
    network: /** @type {any} */ ({ admission: () => null, handleConnection: (_ws, req) => gameSeen.push(req.url) }),
    log,
  });
  wss.on('connection', (ws) => { ws.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {{ port: number }} */ (server.address());
  return { port, gameSeen, log, close: async () => {
    wss.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
  } };
};

/** One upgrade attempt; resolves with the first thing that happens. */
const probe = (port, path) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { ws.terminate(); } catch { /* gone */ } resolve(v); };
  const timer = setTimeout(() => finish({ error: `no answer from ${path} in 4000ms` }), 4000);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.on('error', (e) => finish({ error: e.message }));
  ws.on('close', () => finish({ closed: true }));
  ws.on('open', () => finish({ opened: true }));
});

test('不给 lanes ⇒ /ws 照旧升级并进 Network.handleConnection，别的路径一律 404', async () => {
  const t = await bootDefault();
  try {
    await probe(t.port, '/ws');
    assert.deepEqual(t.gameSeen, ['/ws'], '/ws 必须还是落到 Network.handleConnection');
    for (const p of ['/duel/lobby', '/duel', '/wsx', '/ws/']) {
      const r = await probe(t.port, p);
      assert.match(r.error ?? '', /404/, `${p} 在缺省下必须是 404 —— 一条 lane 只要答了（任何码、哪怕是 418）就不算「缺省」`);
    }
    assert.deepEqual(t.gameSeen, ['/ws'], '非 /ws 的路径一个都不许漏进游戏');
    assert.deepEqual(t.log.lines.filter((l) => l.includes('[ws] lanes')), [], '没有表就不许报 lanes 那一行');
  } finally { await t.close(); }
});

test('源码级：/ws 永远不查 lane 表，缺省表由 validateLanes(lanes ?? []) 造出', () => {
  const src = readFileSync(new URL('../server/http/websocket.js', import.meta.url), 'utf8');
  assert.match(src, /const table = validateLanes\(lanes \?\? \[\]\)/,
    '缺省必须是「没有表」⇒ 空表；把缺省换成任何一张有内容的表，§28.44 就从加法变成了行为改动');
  assert.match(src, /const lane = parts\.rawPath === '\/ws' \? null : resolveLane\(parts\.rawPath, table\.lanes\)/,
    '/ws 是游戏自己的端点，永远不许走 lane 表（否则一张表就能把它顶掉）');
  assert.deepEqual(validateLanes(undefined).lanes, [], '没声明 ⇒ 空表');
});

// ---- ①′ 真请求：缺省（连 `httpLanes` 键都没有）-----------------------------------------------------------

const HEALTH = { startedAt: Date.now(), network: /** @type {any} */ ({ connectionCount: 0 }),
  registry: /** @type {any} */ ({ size: 0 }), lobby: /** @type {any} */ ({ stats: () => ({}) }) };

/** Boot the real request listener with **no** `httpLanes` key at all; the static handler only records. */
const bootHttpDefault = async () => {
  const staticSeen = [];
  const log = captureLog();
  const handler = createRequestHandler({
    serveStatic: async (/** @type {any} */ _req, /** @type {any} */ res, /** @type {string} */ rawPath) => {
      staticSeen.push(rawPath); res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('static');
    },
    health: HEALTH, log,
  });
  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {{ port: number }} */ (server.address());
  const ask = async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: res.status, body: await res.text(), allow: res.headers.get('allow') };
  };
  return { ask, staticSeen, log, close: () => new Promise((r) => server.close(r)) };
};

test('不给 httpLanes ⇒ 三条命运与从前逐字节相同：POST /healthz 仍 405、/healthz 仍是引擎的、未知路径仍落静态', async () => {
  const t = await bootHttpDefault();
  try {
    const post = await t.ask('POST', '/healthz');
    assert.equal(post.status, 405, 'POST /healthz 必须还是那一个 405');
    assert.equal(post.allow, 'GET, HEAD');
    assert.equal((await t.ask('PUT', '/duel/')).status, 405, '别的动词还是平铺 405');
    assert.equal((await t.ask('DELETE', '/index.html')).status, 405, '静态面也还是只认 GET / HEAD');
    assert.match((await t.ask('GET', '/healthz')).body, /"ok":true/, '/healthz 仍是引擎自己的');
    assert.equal((await t.ask('GET', '/index.html')).status, 404, '未知路径仍交给静态处理器');
    assert.deepEqual(t.staticSeen, ['/index.html'], '未命中的 GET 仍落静态处理器');
    assert.deepEqual(t.log.lines.filter((l) => l.includes('[http] lanes')), [], '没有表就不许报 lanes 那一行');
  } finally { await t.close(); }
});

test('源码级：lane 在方法闸之前被问到，缺省表由 validateHttpLanes(httpLanes ?? [], …) 造出', () => {
  const src = readFileSync(new URL('../server/http/routes.js', import.meta.url), 'utf8');
  assert.match(src, /const table = validateHttpLanes\(httpLanes \?\? \[\], \{ publicDir, existsSync \}\)/,
    '缺省必须是「没有表」⇒ 空表；换成任何一张有内容的表，§28.45 就从加法变成了行为改动');
  const laneAt = src.indexOf("const lane = resolveHttpLane(req.method || 'GET', parts.rawPath, table.lanes);");
  const gateAt = src.indexOf("if (req.method !== 'GET' && req.method !== 'HEAD') {");
  assert.ok(laneAt > 0, 'lane 分派必须真的在 handleRequest 里');
  assert.ok(gateAt > 0, '方法闸必须还在');
  assert.ok(laneAt < gateAt, 'lane 必须在方法闸**之前**被问到，否则一条 POST 声明会被那面平铺的 405 吞掉');
  assert.deepEqual(validateHttpLanes(undefined).lanes, [], '没声明 ⇒ 空表');
});
