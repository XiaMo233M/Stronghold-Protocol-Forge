// test/httpLanes.test.js — 请求路径表（DESIGN §28.45）：形状层 + 真 http.Server 各测一半。
//
// 为什么这个文件存在：`server/http/routes.js` 的分发只有「405 / /healthz / 目录」三种命运，一个自带页面、自带资源、
// 还常常带一个 POST 端点（战报、回执）的独立玩法在里没有落点 —— 想要就只能改那四行，于是每个 fork 各自保管冲突。
// 现在路径来自一张表，这个文件把表的判据逐条变成断言：
//   形状层 —— 前缀形状、引擎自有 URL、public 目录真存在、方法闭集、重复、超限，各自点名且**整张表一起拒绝**；
//   分发层 —— 真请求：lane 拿它声明过的方法，其余命运与从前逐字节相同（`/healthz` 仍是引擎的，POST 到它仍是 405），
//             lane 抛错只 500 并点名，**不会**落回游戏的静态空间。
// 与 test/wsLanes.test.js（§28.44）同一条纪律：路由这一格的判据是「请求落到谁手里」，不起服务就证不了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { isLanePrefix, validateHttpLanes, resolveHttpLane, MAX_HTTP_LANES, ENGINE_HTTP_RESERVED } from '../server/http/httpLanes.js';
import { createRequestHandler, healthReport } from '../server/http/routes.js';

const onRequest = () => {};
const lane = (id, prefix, methods = ['GET', 'HEAD', 'POST']) => ({ id, prefix, methods, onRequest });

// ---- 形状层 -----------------------------------------------------------------------------------------------

test('isLanePrefix: 一条 lane 拥有的是一个子树，所以必须带尾斜杠', () => {
  for (const ok of ['/duel/', '/m/duel-2/', '/a/b/']) assert.equal(isLanePrefix(ok), true, ok);
  for (const bad of ['', '/', '/duel', 'duel/', '/duel//', '/duel/../', '/duel/?x=1', '/duel x/', '/д/lobby/',
    `/${'x'.repeat(70)}/`, null, 7]) assert.equal(isLanePrefix(bad), false, JSON.stringify(bad));
});

test('validateHttpLanes: 引擎自有的每一条 URL 都不许被认领', () => {
  for (const reserved of ENGINE_HTTP_RESERVED) {
    const prefix = reserved === '/' || !reserved.endsWith('/') ? `${reserved.replace(/\/$/, '')}/` : reserved;
    // the public root is refused by the shape rule (a lane owns a subtree, never the root); everything else by the
    // reservation itself — either way it cannot be claimed, which is the property this test guards.
    const r = validateHttpLanes([lane('x', prefix)]);
    assert.match(r.problems.join(';'), /LANE_RESERVED|LANE_BAD_PREFIX/, `${prefix} must not be claimable`);
    assert.equal(r.lanes.length, 0);
  }
  assert.equal(validateHttpLanes([lane('x', '/ws/')]).problems[0], 'LANE_RESERVED: x claims /ws/, which the engine already serves');
  assert.equal(validateHttpLanes([lane('x', '/packs/')]).problems[0], 'LANE_RESERVED: x claims /packs/, which the engine already serves');
  // 反向也算：认领一个会把引擎路径包进去的子树同样越界（`/mods/` 罩住 `/mods/catalog.json`）
  assert.match(validateHttpLanes([lane('x', '/mods/')]).problems.join(';'), /LANE_RESERVED/);
  assert.deepEqual(validateHttpLanes([lane('x', '/work/')]).problems, [], '/work/ 不罩任何东西，可以认领');
  // 残留断言：这张表现在**继承** routeMount.js 那一份真相 —— 包的动态端点命名空间 `/mod/`（DESIGN §28.35）与
  // `/i18n`、`/data.js`、`/shared` 都在里面。少了这个 import，这几条会悄悄变成可认领的，比不钉住更糟。
  for (const inherited of ['/mod/', '/i18n', '/data.js', '/shared']) {
    assert.ok(ENGINE_HTTP_RESERVED.includes(inherited), `保留表必须从 routeMount.js 继承 ${inherited}`);
  }
  assert.match(validateHttpLanes([lane('x', '/mod/')]).problems.join(';'), /LANE_RESERVED/,
    '/mod/ 是包动态端点的地盘，宿主不能认领');
});

test('validateHttpLanes: 认领了 public 里真实存在的目录就是抢静态资源', () => {
  const exists = (p) => p === 'C:/pub/duel';
  assert.equal(validateHttpLanes([lane('x', '/duel/')], { publicDir: 'C:/pub', existsSync: exists }).problems[0],
    'LANE_SHADOWS_PUBLIC: x claims /duel/, but C:/pub/duel is a real folder the static handler serves');
  assert.deepEqual(validateHttpLanes([lane('x', '/mode/'), lane('y', '/duel/')], { publicDir: 'C:/pub', existsSync: exists }).problems,
    ['LANE_SHADOWS_PUBLIC: y claims /duel/, but C:/pub/duel is a real folder the static handler serves']);
});

test('validateHttpLanes: 方法闭集、缺处理器、重复、超限各自点名；一条坏声明拒绝整张表', () => {
  assert.equal(validateHttpLanes([{ id: 'x', prefix: '/duel/', methods: [], onRequest }]).problems[0], 'LANE_NO_METHODS: x declares no methods');
  assert.equal(validateHttpLanes([{ id: 'x', prefix: '/duel/', methods: ['PUT'], onRequest }]).problems[0],
    'LANE_BAD_METHOD: x claims ["PUT"], only GET/HEAD/POST exist');
  assert.equal(validateHttpLanes([{ id: 'x', prefix: '/duel/', methods: ['GET'] }]).problems[0], 'LANE_NO_HANDLER: x has no onRequest(req, res, ctx)');
  assert.equal(validateHttpLanes([lane('a', '/duel/'), lane('b', '/duel/')]).problems[0], 'LANE_DUPLICATE: b and a both claim /duel/');
  const many = Array.from({ length: MAX_HTTP_LANES + 1 }, (_, i) => lane(`l${i}`, `/m${i}/`));
  assert.equal(validateHttpLanes(many).problems[0], `LANE_LIMIT: ${MAX_HTTP_LANES + 1} lanes, at most ${MAX_HTTP_LANES}`);
  const mixed = validateHttpLanes([lane('good', '/duel/'), lane('bad', '/duel')]);
  assert.deepEqual(mixed.problems, ['LANE_BAD_PREFIX: bad prefix "/duel" is not a rooted subtree like /duel/']);
  assert.equal(mixed.lanes.length, 0, 'not half-installed');
  for (const empty of [undefined, null, []]) {
    const r = validateHttpLanes(empty ?? []);
    assert.deepEqual(r.problems, []);
    assert.equal(r.lanes.length, 0);
  }
});

test('resolveHttpLane: 最长前缀胜出，且只认 lane 自己声明过的方法', () => {
  const table = validateHttpLanes([lane('broad', '/duel/', ['GET', 'HEAD']), lane('narrow', '/duel/api/', ['GET', 'POST'])]).lanes;
  assert.equal(resolveHttpLane('GET', '/duel/api/report', table).id, 'narrow');
  assert.equal(resolveHttpLane('POST', '/duel/api/report', table).id, 'narrow');
  assert.equal(resolveHttpLane('POST', '/duel/page', table), null, 'broad never claimed POST');
  assert.equal(resolveHttpLane('GET', '/duelx/a', table), null, 'a prefix is not a substring match');
  assert.equal(resolveHttpLane('GET', 'duel/api/report', table), null);
});

// ---- 分发层：真请求 ---------------------------------------------------------------------------------------

const health = { startedAt: Date.now(), network: /** @type {any} */ ({ connectionCount: 0 }),
  registry: /** @type {any} */ ({ size: 0 }), lobby: /** @type {any} */ ({ stats: () => ({}) }) };

/** A server whose static handler only records what it was asked for; lanes answer with the path they saw. */
const boot = async ({ lanes = [], throwInLane = false, publicDir = 'C:/nowhere' } = {}) => {
  const staticSeen = [];
  const laneSeen = [];
  const lines = [];
  const log = { info: (/** @type {string} */ m) => lines.push(m), warn: (/** @type {string} */ m) => lines.push(m), error: (/** @type {string} */ m) => lines.push(m) };
  const serveStatic = async (/** @type {any} */ _req, /** @type {any} */ res, /** @type {string} */ rawPath) => {
    staticSeen.push(rawPath); res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('static');
  };
  const handler = createRequestHandler({ serveStatic, health, log, publicDir, httpLanes: lanes.map((l) => ({
    ...l,
    onRequest: async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ ctx) => {
      laneSeen.push(`${req.method} ${ctx.rawPath}`);
      if (throwInLane) throw new Error('lane exploded');
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`lane ${ctx.lane.id}`);
    },
  })) });
  const server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {{ port: number }} */ (server.address());
  const ask = async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: res.status, body: await res.text(), allow: res.headers.get('allow') };
  };
  return { port, ask, laneSeen, staticSeen, lines, close: () => new Promise((r) => server.close(r)) };
};

test('a lane answers its own subtree; every other request keeps the fate it always had', async () => {
  const t = await boot({ lanes: [{ id: 'duel', prefix: '/duel/', methods: ['GET', 'HEAD', 'POST'] }] });
  try {
    assert.deepEqual(await t.ask('GET', '/duel/'), { status: 200, body: 'lane duel', allow: null });
    assert.deepEqual((await t.ask('POST', '/duel/report')).body, 'lane duel', 'POST reaches the lane instead of the flat 405');
    assert.deepEqual(t.laneSeen, ['GET /duel/', 'POST /duel/report']);
    assert.equal((await t.ask('GET', '/index.html')).status, 404, 'unknown paths still go to the static handler');
    assert.deepEqual(t.staticSeen, ['/index.html']);
    const postElsewhere = await t.ask('POST', '/healthz');
    assert.equal(postElsewhere.status, 405, 'a POST the lane does not claim is still the engine 405');
    assert.equal(postElsewhere.allow, 'GET, HEAD');
    assert.match((await t.ask('GET', '/healthz')).body, /"ok":true/, '/healthz stays the engine — a lane cannot shadow it');
  } finally { await t.close(); }
});

test('a lane that throws answers a named 500 and never falls through into the static space', async () => {
  const t = await boot({ lanes: [{ id: 'duel', prefix: '/duel/', methods: ['GET'] }], throwInLane: true });
  try {
    assert.equal((await t.ask('GET', '/duel/lobby')).status, 500);
    assert.deepEqual(t.staticSeen, [], 'the request must not be handed to the game');
    assert.match(t.lines.join('\n'), /lane duel failed/);
  } finally { await t.close(); }
});

test('createRequestHandler refuses a bad table at boot, naming every problem (no silent lane-less start)', () => {
  assert.throws(() => createRequestHandler({
    serveStatic: async () => {}, health, log: { info() {}, warn() {}, error() {} }, httpLanes: [lane('x', '/packs/')],
  }), /bad http lane table: LANE_RESERVED/);
});

test('healthReport is untouched by this cell', () => {
  const r = healthReport(health);
  assert.equal(r.ok, true);
  assert.equal(r.sockets, 0);
});
