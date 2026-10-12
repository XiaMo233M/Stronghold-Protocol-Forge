// test/wsLanes.test.js — 升级路径表（DESIGN §28.44）：形状层与真 socket 层各测一半。
//
// 为什么这个文件存在：`attachWebSocket` 过去把 `/ws` 写死在比较里，其余路径一律 404 —— 想在同端口上跑第二种协议
// （自带房间、自带消息形状）只能改宿主文件，而宿主文件一改就和上游冲突。现在路径来自一张表，这张文件的判据就是
// 那张表的规则：合法形状、保留字、重复、超限、没有处理器，以及**表坏了就在启动时点名失败**（不静默退回只剩 /ws）。
//
// 与只做字符串判定的形状层测试不同，这里第二部分**真起 http.Server 与真 WebSocket 客户端**：形状层不需要服务，
// 而这一格的判据恰恰是 socket 落到谁手里 —— 不起服务就只能证明字符串相等，证明不了 /ws 没被抢走、
// 也证明不了 admission（每地址上限）对 lane 同样生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { isLanePath, validateLanes, resolveLane, MAX_WS_LANES, LANE_RESERVED } from '../server/http/wsLanes.js';
import { attachWebSocket } from '../server/http/websocket.js';

const handler = () => {};
const lane = (id, path) => ({ id, path, onUpgrade: handler });

// ---- 形状层：纯函数，不摸 socket ------------------------------------------------------------------------

test('isLanePath: 根路径、纯字符、精确匹配的形状才算一条路径', () => {
  for (const ok of ['/duel/lobby', '/m/duel-2/lobby', '/a', '/duel.match/lobby']) assert.equal(isLanePath(ok), true, ok);
  for (const bad of ['', '/', 'duel/lobby', '/duel/', '/duel//lobby', '/duel/lobby?x=1', '/duel/lobby#f',
    '/duel/../etc', '/duel/./lobby', '/duel lobby', '/duel%20lobby', '/д/lobby', `/${'x'.repeat(129)}`, null, 7]) {
    assert.equal(isLanePath(bad), false, JSON.stringify(bad));
  }
});

test('validateLanes: 保留字、重复、缺处理器、超限各自点名；合法时排序并冻结', () => {
  assert.deepEqual(validateLanes([lane('g', '/ws')]).problems, ['LANE_RESERVED: g claims /ws, which the game already serves']);
  assert.deepEqual(validateLanes([lane('a', '/duel/a'), lane('b', '/duel/a')]).problems,
    ['LANE_DUPLICATE: b and a both claim /duel/a']);
  assert.deepEqual(validateLanes([{ id: 'a', path: '/duel/a' }]).problems,
    ['LANE_NO_HANDLER: a has no onUpgrade(req, socket, head, ctx)']);
  assert.deepEqual(validateLanes([lane('a', 'duel/a')]).problems,
    ['LANE_BAD_PATH: a path "duel/a" is not a rooted, plain, exact path']);
  const tooMany = Array.from({ length: MAX_WS_LANES + 1 }, (_, i) => lane(`l${i}`, `/duel/l${i}`));
  assert.equal(validateLanes(tooMany).problems[0], `LANE_LIMIT: ${MAX_WS_LANES + 1} lanes, at most ${MAX_WS_LANES}`);
  // 一条坏声明拒绝整张表：不半装（与 docs/MOD-SURFACE.md 的包判据同一条纪律）
  const mixed = validateLanes([lane('good', '/duel/good'), lane('bad', '/duel/')]);
  assert.equal(mixed.lanes.length, 0);
  assert.equal(mixed.problems.length, 1);
  const ok = validateLanes([lane('b', '/duel/b'), lane('a', '/duel/a')]);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.lanes.map((l) => l.path), ['/duel/a', '/duel/b']);
  assert.equal(Object.isFrozen(ok.lanes), true);
  assert.deepEqual(LANE_RESERVED, ['/ws']);
});

test('validateLanes: 没声明就没有表 —— 默认配置与空表同形（行为逐字节不变的那半依据）', () => {
  for (const empty of [undefined, null, []]) {
    const r = validateLanes(empty ?? []);
    assert.deepEqual(r.problems, []);
    assert.equal(r.lanes.length, 0);
    assert.equal(resolveLane('/duel/lobby', r.lanes), null);
  }
});

test('resolveLane: 精确匹配，前缀不算命中（/duel 不能顺手接管 /duelx）', () => {
  const table = validateLanes([lane('lobby', '/duel/lobby')]).lanes;
  assert.equal(resolveLane('/duel/lobby', table).id, 'lobby');
  for (const miss of ['/duel/lobbyx', '/duel', '/Duel/lobby', '/duel/lobby/']) assert.equal(resolveLane(miss, table), null, miss);
});

// ---- 外壳层：真服务、真握手，测的是 socket 落到谁手里 ------------------------------------------------------

/** @type {{ info: (m: string) => void, warn: (m: string) => void, error: (m: string, e?: unknown) => void }} */
const captureLog = () => { const lines = []; return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };

/** A Network stand-in with the two members the upgrade path actually calls. */
const stubNetwork = (refused = null, seen = []) => ({ admission: () => refused, handleConnection: (_ws, req) => seen.push(req.url) });

/** Boot a server whose /ws is the stub and whose lane completes a real 101 on its own WebSocketServer. */
const boot = async ({ lanes, refused = null, throwInLane = false } = {}) => {
  const server = http.createServer();
  const gameSeen = [];
  const laneSeen = [];
  const log = captureLog();
  const table = lanes.map((l) => ({
    ...l,
    onUpgrade: (req, socket, head, _ctx) => {
      if (l.path === '/duel/lobby') laneSeen.push(req.url);
      if (throwInLane) throw new Error('lane exploded');
      laneWss.handleUpgrade(req, socket, head, (ws) => { laneWss.emit('connection', ws, req); });
    },
  }));
  const laneWss = new WebSocketServer({ noServer: true });
  laneWss.on('connection', (ws) => { ws.send('hello from the lane'); ws.close(); });
  const wss = attachWebSocket(server, { network: /** @type {any} */ (stubNetwork(refused, gameSeen)), log, lanes: table });
  wss.on('connection', (ws) => { ws.close(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = /** @type {{ port: number }} */ (server.address());
  const port = addr.port;
  return { port, log, gameSeen, laneSeen, close: async () => {
    laneWss.close(); wss.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
  } };
};

/**
 * One upgrade attempt. Resolves with the first thing that happens: a frame (`message`), the handshake completing
 * with nothing said yet (`opened`, unless the caller came to read a message), or the refusal (`error`). A timer
 * answers instead of hanging the suite if none of those ever arrives.
 * @param {number} port @param {string} path @param {{ readMessage?: boolean }} [want]
 */
const probe = (port, path, want = {}) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { ws.terminate(); } catch { /* gone */ } resolve(v); };
  const timer = setTimeout(() => finish({ error: `no answer from ${path} in 4000ms` }), 4000);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.on('message', (buf) => finish({ message: buf.toString() }));
  ws.on('error', (e) => finish({ error: e.message }));
  ws.on('close', () => finish({ closed: true }));
  ws.on('open', () => { if (!want.readMessage) finish({ opened: true }); });
});

test('a registered lane answers its own path and the game keeps /ws', async () => {
  const t = await boot({ lanes: [{ id: 'lobby', path: '/duel/lobby' }] });
  try {
    assert.deepEqual(await probe(t.port, '/duel/lobby', { readMessage: true }), { message: 'hello from the lane' });
    assert.deepEqual(t.laneSeen, ['/duel/lobby']);
    assert.deepEqual(t.gameSeen, [], 'the lane did not leak into the game');
    await probe(t.port, '/ws');
    assert.deepEqual(t.gameSeen, ['/ws'], '/ws still reaches Network.handleConnection');
    const miss = await probe(t.port, '/duel/lobbyx');
    assert.match(miss.error ?? '', /404|Unexpected/i);
    assert.equal(t.laneSeen.length, 1, 'an unlisted path is not handed to the lane either');
  } finally { await t.close(); }
});

test('a lane shares the host caps: admission refusal answers the lane, before its handler runs', async () => {
  const t = await boot({ lanes: [{ id: 'lobby', path: '/duel/lobby' }], refused: 'per-address' });
  try {
    const r = await probe(t.port, '/duel/lobby');
    assert.match(r.error ?? '', /429|Too Many/i);
    assert.deepEqual(t.laneSeen, [], 'the lane never saw a socket the host refused');
  } finally { await t.close(); }
});

test('a lane that throws closes its own socket and is named — it never falls through to /ws', async () => {
  const t = await boot({ lanes: [{ id: 'lobby', path: '/duel/lobby' }], throwInLane: true });
  try {
    await probe(t.port, '/duel/lobby');
    assert.deepEqual(t.gameSeen, [], 'a failed lane must not become a game connection');
    assert.match(t.log.lines.filter((l) => l.includes('[ws]')).join('\n'), /lane lobby failed/);
  } finally { await t.close(); }
});

test('attachWebSocket fails at boot on a bad table, naming every problem (no silent /ws-only fallback)', () => {
  const server = http.createServer();
  assert.throws(() => attachWebSocket(server, {
    network: /** @type {any} */ (stubNetwork()), log: captureLog(), lanes: [{ id: 'g', path: '/ws', onUpgrade: handler }],
  }), /bad ws lane table: LANE_RESERVED/);
});
