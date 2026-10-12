// test/laneDefaults.test.js — 「缺省逐字节不变」的钉子：不给任何 lane 表时，服务器还是原来那一个。
//
// 为什么单独一个文件：§28.44（升级路径表）把一条写死的 `/ws` 比较换成一张表，这是**加法** —— 表为空
// （= 缺省，也是 `npm start` 唯一的那一种）时行为必须与改动前逐字节相同，而这件事没有任何别的测试在守：
// `test/wsLanes.test.js` 测的全是「给了表之后」。
//
// 判据分两层：
//   ① 真 socket：**根本不传** `lanes` 这个键（不是传 `[]` —— 缺省就是没有这个键），看服务器是不是还只认
//      `/ws`（升级并进 `Network.handleConnection`），其余路径一律 404 且谁都不接管。
//   ② 源码级：`/ws` 永远不查 lane 表；缺省表由 `validateLanes(lanes ?? [])` 造出，不是任何一张有内容的表。
// Run: node --test test/laneDefaults.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';

import { WebSocket } from 'ws';

import { attachWebSocket } from '../server/http/websocket.js';
import { validateLanes } from '../server/http/wsLanes.js';

// ---- ① 真 socket：缺省（连 `lanes` 键都没有）-------------------------------------------------------------

const captureLog = () => { const lines = []; return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };

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

// ---- ② 源码级：缺省那条路的形状 --------------------------------------------------------------------------

test('源码级：/ws 永远不查 lane 表，缺省表由 validateLanes(lanes ?? []) 造出', () => {
  const src = readFileSync(new URL('../server/http/websocket.js', import.meta.url), 'utf8');
  assert.match(src, /const table = validateLanes\(lanes \?\? \[\]\)/,
    '缺省必须是「没有表」⇒ 空表；把缺省换成任何一张有内容的表，§28.44 就从加法变成了行为改动');
  assert.match(src, /const lane = parts\.rawPath === '\/ws' \? null : resolveLane\(parts\.rawPath, table\.lanes\)/,
    '/ws 是游戏自己的端点，永远不许走 lane 表（否则一张表就能把它顶掉）');
  assert.deepEqual(validateLanes(undefined).lanes, [], '没声明 ⇒ 空表');
});
