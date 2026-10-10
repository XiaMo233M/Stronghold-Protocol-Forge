// test/modMatchChannels.test.mjs — 包通道进对局（DESIGN §28.23）：声明、装载、投放三层各测一半。
//
// 为什么这个文件存在：在 §28.23 之前，一个包**没有任何**把玩家的自定义操作变成对局状态变更的入口 —— `pack.msg`
// 死在转发（server/lobby.js 的 `packMsg`），`server.preDispatch` 的注入面被设计钉死成「改不了对局」
// （§28.13.1 决策 3），`server.room` 没有 `send`。`server.modules[].channels` + `Match.handlePackMsg` 就是补上的
// 那一格；这个文件把它的判据逐条变成断言：
//   形状层 —— 五条拒绝各自点名、合法时进清单（排序、**只在声明时**出现，哈希稳定）；
//   装载层 —— 模块记录把 `channels` 带出来，`matchClass` 包装链真的能把消息送进 `handlePackMsg`；
//   投放层 —— 四条判据（声明过 / 房间集合点名了 / 有进行中的对局 / 对局有那个方法）缺一不投，而**转发一字不动**。
//
// 三层都不需要起服务：形状层是纯函数，装载层用临时目录 + 真 `loadServerModules`，投放层用真 `Lobby` + 假会话
// （与 test/manager.test.mjs 同一条「在仓库里就地跑」的纪律；唯一的写入落在 os.tmpdir()）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizePackManifest, PACK_CHANNEL_RE, MAX_SERVER_MODULE_CHANNELS } from '../shared/workshop.js';
import { loadServerModules, mountServerModules } from '../server/modModules.js';
import { Lobby } from '../server/lobby.js';

const HASH_A = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);

/** 一个合法到形状层能过的最小清单：一个面板声明通道，一个服务端模块（**不含** channels —— 那是逐案加的）。 */
function manifest(over = {}) {
  const base = {
    id: 'probe',
    name: 'Probe',
    version: '1.0.0',
    combat: true,
    client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'client/p.js', messages: ['ping'] }] },
    server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'] }] },
  };
  return { ...base, ...over };
}

const norm = (raw) => normalizePackManifest(raw, 'probe');

test('形状层：通道名与面板共用一份判据；channels 合法时进清单（排序、只在声明时出现）', () => {
  assert.ok(PACK_CHANNEL_RE.test('ping') && PACK_CHANNEL_RE.test('borrow-2') && !PACK_CHANNEL_RE.test('Ping'), '包通道名一份判据，两半共用');

  const withCh = norm(manifest({
    client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'client/p.js', messages: ['ping', 'pong'] }] },
    server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['pong', 'ping'] }] },
  }));
  assert.equal(withCh.ok, true, withCh.detail);
  assert.deepEqual(withCh.pack.server.modules[0].channels, ['ping', 'pong'], '按字母序归一化：两个书写顺序是同一个包');

  const without = norm(manifest());
  assert.equal(without.ok, true, without.detail);
  assert.ok(!Object.hasOwn(without.pack.server.modules[0], 'channels'), '没声明的包一个字节都不变（哈希稳定）');
});

test('形状层：五条拒绝各自点名，combat 闸门照旧', () => {
  const tooMany = Array.from({ length: MAX_SERVER_MODULE_CHANNELS + 1 }, (_, i) => `c${i}`);
  const cases = [
    ['MODULES_UNKNOWN_CHANNEL', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['pong'] }] } })],
    ['MODULES_CHANNELS_NEED_MATCH', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'], channels: ['ping'] }] } })],
    ['MODULES_BAD_CHANNEL', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['Ping'] }] } })],
    ['MODULES_DUPLICATE_CHANNEL', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['ping', 'ping'] }] } })],
    ['MODULES_TOO_MANY_CHANNELS', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: tooMany }] } })],
  ];
  for (const [code, raw] of cases) {
    const r = norm(raw);
    assert.equal(r.ok, false, `${code}: 这种写法应该被拒`);
    assert.equal(r.error, code, `${code}: 点名的是这一条`);
  }
  // channels 挂在 matchClass 上 ⇒ 模块已经能碰对局 ⇒ 整包仍须 combat: true（既有的 MODULES_NEED_COMBAT）
  const noCombat = norm(manifest({ combat: undefined }));
  assert.equal(noCombat.ok, false);
  assert.equal(noCombat.error, 'MODULES_NEED_COMBAT');
});

test('装载层：模块记录带出 channels，包装链把消息送进 handlePackMsg', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-channels-'));
  try {
    const packDir = path.join(root, 'probe');
    fs.mkdirSync(path.join(packDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'server', 'm.mjs'), [
      'export function registerServer(host) {',
      '  host.matchClass((Base) => class ProbeMatch extends Base {',
      '    handlePackMsg(playerId, msg) { host.io.append("inbox.ndjson", `${playerId}|${msg.channel}\\n`); }',
      '  });',
      '}',
    ].join('\n'));
    const loaded = await loadServerModules({
      packs: [{
        id: 'probe', dir: packDir, hash: HASH_A,
        server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], write: true, channels: ['ping'] }] },
      }],
    }, { stateRoot: root, log: { info() {}, warn() {}, error() {} } });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.modules[0].channels, ['ping'], '装载结果把接收通道带出来');
    assert.deepEqual(loaded.modules[0].uses, ['matchClass']);

    let cls = class Base {};
    for (const w of mountServerModules(loaded.modules).matchClassWrappers()) cls = w.fn(cls);
    const inst = new cls();
    assert.equal(typeof inst.handlePackMsg, 'function', '包装链真的把方法套上了');
    inst.handlePackMsg('p1', { pack: 'probe', channel: 'ping' });
    assert.equal(fs.readFileSync(path.join(root, 'mod', 'probe', 'inbox.ndjson'), 'utf8'), 'p1|ping\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 投放层：真 Lobby + 真 packMsg + 假会话（registry / ws 只做「能收帧」这一件事）
// ---------------------------------------------------------------------------------------------------------------

function makeSession(playerId, name) {
  const got = [];
  return {
    playerId, name, roomCode: null, connected: true,
    ws: { readyState: 1, bufferedAmount: 0, send(data) { got.push(JSON.parse(data)); } },
    got,
  };
}

function makeLobby({ serverChannels = new Map([['probe', new Set(['ping'])], ['other', new Set(['hello'])]]) } = {}) {
  const logs = [];
  const sessions = new Map();
  const registry = { byId: (id) => sessions.get(id) || null };
  const log = { info() {}, warn: (m) => logs.push(String(m)), error: (...a) => logs.push(a.join(' ')), debug() {} };
  const workshop = {
    mods: [
      { id: 'probe', hash: HASH_A, layer: 'B', combat: true, api: '>=1 <2' },
      { id: 'other', hash: HASH_B, layer: 'B', combat: true, api: '>=1 <2' },
    ],
    // 客户端能说什么（面板清单）：probe 声明 ping + pong —— pong 只被面板声明，模块并不收它
    panels: [
      { pack: 'probe', messages: ['ping', 'pong'] },
      { pack: 'other', messages: ['hello'] },
    ],
    serverChannels,
  };
  const lobby = new Lobby({ registry, log, workshop, getData: () => ({}), now: () => 1000, seedFn: () => 7, MatchClass: class {} });
  return { lobby, logs, sessions, registry };
}

function createRoom(lobby, session, modIds) {
  const digest = lobby.modSet ? lobby.modSet.digest : null;
  const res = lobby.create(session, {
    mode: 'coop', difficulty: 'NORMAL',
    ...(digest ? { mods: digest } : {}),
    ...(modIds ? { modIds } : {}),
  });
  assert.equal(res.ok, true, `建房失败：${JSON.stringify(res)}`);
  return lobby.getRoom(session.roomCode);
}

const frames = (session) => session.got.filter((f) => f.t === 'pack.msg');

test('投放层：四条齐了才投 —— 声明 + 房间集合点名 + 有对局 + 有方法；转发口径一字未动', () => {
  const { lobby, sessions } = makeLobby();
  const s1 = makeSession('p1', 'A'); sessions.set('p1', s1);
  const s2 = makeSession('p2', 'B'); sessions.set('p2', s2);
  const room = createRoom(lobby, s1, ['probe']);
  assert.deepEqual(room.modIds, ['probe']);
  // 第二个座位（本测试只关心「同房的人收得到转发」；座位的完整形状不是这一格的契约）
  room.seats[1] = { seat: 1, playerId: 'p2', name: 'B', isBot: false, ready: false, connected: true, left: false };
  const got = [];
  room.match = { handlePackMsg(pid, msg) { got.push({ pid, msg }); } };

  const res = lobby.packMsg(s1, { t: 'pack.msg', pack: 'probe', channel: 'ping', data: { n: 1 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(got.length, 1, '投进了对局');
  assert.equal(got[0].pid, 'p1');
  assert.deepEqual(got[0].msg, { pack: 'probe', channel: 'ping', from: 'p1', seat: 0, data: { n: 1 } }, '载荷原样、席位与发送者点名');
  assert.equal(frames(s2).length, 1, '同房的人照旧收到转发');
  assert.equal(frames(s1).length, 1, '发送者自己也照旧收到（今天的转发口径不变）');

  // pong：面板声明过（客户端发得出），模块没声明 ⇒ 不投、只转发
  assert.equal(lobby.packMsg(s1, { t: 'pack.msg', pack: 'probe', channel: 'pong' }).ok, true);
  assert.equal(got.length, 1, '模块没声明的通道不投');
  assert.equal(frames(s2).length, 2, '但照旧转发');

  // 没有任何声明人：拒绝（§1.9.6 的既有判据，一字未动）
  const bad = lobby.packMsg(s1, { t: 'pack.msg', pack: 'probe', channel: 'nope' });
  assert.equal(bad.error, 'BAD_MSG');
  assert.match(bad.detail, /does not declare the channel/);
  assert.equal(frames(s2).length, 2, '被拒的消息一个字节都没转发');
});

test('投放层：房间集合没点名这个包 ⇒ 点名拒绝（W-B），转发与投递一起堵住', () => {
  const { lobby, sessions } = makeLobby();
  const s3 = makeSession('p3', 'C'); sessions.set('p3', s3);
  const room = createRoom(lobby, s3, ['other']);            // 声明的子集里没有 probe
  assert.deepEqual(room.modIds, ['other']);
  const got = [];
  room.match = { handlePackMsg(pid, msg) { got.push(msg); } };

  const res = lobby.packMsg(s3, { t: 'pack.msg', pack: 'probe', channel: 'ping' });
  assert.equal(res.error, 'BAD_MSG', '不在房间集合里的包被点名拒绝');
  assert.match(res.detail, /not enabled in this room/);
  assert.equal(got.length, 0, '不投');
  assert.equal(frames(s3).length, 0, '也不转发（第二轮审计 P1-1：转发同样受房间集合约束）');

  // 对照：这个房间点名的包照常（`other` 自己的通道）
  const gotOther = [];
  room.match = { handlePackMsg(pid, msg) { gotOther.push(msg); } };
  assert.equal(lobby.packMsg(s3, { t: 'pack.msg', pack: 'other', channel: 'hello' }).ok, true);
  assert.equal(gotOther.length, 1, '集合里的包照常投递');
});

test('投放层：对局返回 true = 消费 —— 命令不再广播；返回假值 = 纯客户端通道照旧转发', () => {
  const { lobby, sessions } = makeLobby();
  const s6 = makeSession('p6', 'F'); sessions.set('p6', s6);
  const room = createRoom(lobby, s6, ['probe']);
  let consumed = true;
  let got = 0;
  room.match = { handlePackMsg() { got++; return consumed ? true : undefined; } };

  const res = lobby.packMsg(s6, { t: 'pack.msg', pack: 'probe', channel: 'ping', data: { n: 1 } });
  assert.equal(res.ok, true);
  assert.equal(got, 1, '投进了对局');
  assert.equal(frames(s6).length, 0, '被消费的命令一个字节都不广播（私有债务 / 请求不会被默认公开）');

  consumed = false;
  assert.equal(lobby.packMsg(s6, { t: 'pack.msg', pack: 'probe', channel: 'ping' }).ok, true);
  assert.equal(got, 2);
  assert.equal(frames(s6).length, 1, '没消费 ⇒ 照旧转发');
});

test('投放层：发送者身份由平台解析 —— 载荷里自称的 from / seat / playerId 不作数', () => {
  const { lobby, sessions } = makeLobby();
  const s7 = makeSession('p7', 'G'); sessions.set('p7', s7);
  const room = createRoom(lobby, s7, ['probe']);
  const got = [];
  room.match = { handlePackMsg(pid, msg) { got.push({ pid, msg }); } };

  assert.equal(lobby.packMsg(s7, {
    t: 'pack.msg', pack: 'probe', channel: 'ping',
    data: { from: 'evil', playerId: 'evil', seat: 99 },
  }).ok, true);
  assert.equal(got[0].pid, 'p7', '传入 handler 的 playerId 是会话里的那个');
  assert.equal(got[0].msg.from, 'p7');
  assert.equal(got[0].msg.seat, 0, '席位由平台解析（伪造的 seat 不作数）');
  assert.deepEqual(got[0].msg.data, { from: 'evil', playerId: 'evil', seat: 99 }, '载荷原样交给对局 —— 但平台不替它相信其中任何自称的身份');
});

test('投放层：观战者可以说话，但席位是 null（对局自行忽略）', () => {
  const { lobby, sessions } = makeLobby();
  const s8 = makeSession('p8', 'H'); sessions.set('p8', s8);
  const room = createRoom(lobby, s8, ['probe']);
  // 一个观战席位（`roomOf` 认它；`seatOf` 不认它）
  const spec = makeSession('sp8', 'S'); sessions.set('sp8', spec);
  room.spectators.push({ playerId: 'sp8', name: 'S', connected: true });
  spec.roomCode = room.code;

  const got = [];
  room.match = { handlePackMsg(pid, msg) { got.push({ pid, msg }); } };
  assert.equal(lobby.packMsg(spec, { t: 'pack.msg', pack: 'probe', channel: 'ping' }).ok, true);
  assert.equal(got.length, 1, '观战者的消息也投（对局要有机会说「你不是玩家」）');
  assert.equal(got[0].pid, 'sp8');
  assert.equal(got[0].msg.seat, null, '观战者没有席位');
});

test('投放层：对局拿到的是**本房间的**集合（双房间、两种顺序；进程集合不是它看到的那个）', () => {
  const captured = [];
  const { lobby, sessions } = makeLobby();
  lobby.MatchClass = class ProbeMatch { constructor(opts) { captured.push(opts); } start() {} };
  const sA = makeSession('pa', 'A'); sessions.set('pa', sA);
  const sB = makeSession('pb', 'B'); sessions.set('pb', sB);
  const roomA = createRoom(lobby, sA, ['probe']);
  const roomB = createRoom(lobby, sB, ['other']);

  assert.equal(lobby.start(sA).ok, true);
  assert.equal(lobby.start(sB).ok, true);
  assert.deepEqual(captured[0].mods.packs.map((p) => p.id), ['probe'], 'A 房间的对局只看到 probe');
  assert.deepEqual(captured[1].mods.packs.map((p) => p.id), ['other'], 'B 房间的对局只看到 other');
  assert.equal(captured[0].mods.digest, roomA.modSet.digest);
  assert.equal(captured[1].mods.digest, roomB.modSet.digest);
  assert.notEqual(captured[0].mods.digest, captured[1].mods.digest, '两局拿到的集合不同（没有互相顶掉）');
  assert.ok(Object.isFrozen(captured[0].mods) && Object.isFrozen(captured[0].mods.packs), '交给对局的集合是冻结的（不可混淆、不可改写）');

  // 顺序反过来：新的 lobby，先 B 后 A —— 结论一致
  const second = makeLobby();
  const cap2 = [];
  second.lobby.MatchClass = class ProbeMatch2 { constructor(opts) { cap2.push(opts); } start() {} };
  const sB2 = makeSession('pb2', 'B'); second.sessions.set('pb2', sB2);
  const sA2 = makeSession('pa2', 'A'); second.sessions.set('pa2', sA2);
  createRoom(second.lobby, sB2, ['other']);
  createRoom(second.lobby, sA2, ['probe']);
  assert.equal(second.lobby.start(sB2).ok, true);
  assert.equal(second.lobby.start(sA2).ok, true);
  assert.deepEqual(cap2.map((o) => o.mods.packs.map((p) => p.id)), [['other'], ['probe']], '建房 / 开局顺序不影响各自拿到的集合');

  // 对照：没声明集合的房间（`modIds` 缺席）跑**进程集合** —— 它的对局看到两个包
  const third = makeLobby();
  const cap3 = [];
  third.lobby.MatchClass = class ProbeMatch3 { constructor(opts) { cap3.push(opts); } start() {} };
  const sC = makeSession('pc', 'C'); third.sessions.set('pc', sC);
  createRoom(third.lobby, sC, null);
  assert.equal(third.lobby.start(sC).ok, true);
  assert.deepEqual(cap3[0].mods.packs.map((p) => p.id), ['other', 'probe'], '没声明集合 ⇒ 服务端默认集合（全部在）');
});

test('投放层：没有对局 / 对局没有方法 / 方法抛异常 ⇒ 都不投，且都不影响转发', () => {
  const { lobby, sessions, logs } = makeLobby();
  const s4 = makeSession('p4', 'D'); sessions.set('p4', s4);
  const room = createRoom(lobby, s4, ['probe']);

  room.match = null;                                        // 房间停在 LOBBY
  assert.equal(lobby.packMsg(s4, { t: 'pack.msg', pack: 'probe', channel: 'ping' }).ok, true);
  assert.equal(frames(s4).length, 1);

  room.match = {};                                          // 纯观察实现：没有那个可选方法
  assert.equal(lobby.packMsg(s4, { t: 'pack.msg', pack: 'probe', channel: 'ping' }).ok, true);
  assert.equal(frames(s4).length, 2);

  room.match = { handlePackMsg() { throw new Error('boom'); } };
  assert.equal(lobby.packMsg(s4, { t: 'pack.msg', pack: 'probe', channel: 'ping' }).ok, true);
  assert.equal(frames(s4).length, 3, '包抛异常不吃掉转发');
  assert.ok(logs.some((l) => l.includes('handlePackMsg("ping") threw')), `抛异常要点名一条日志（实收：${logs.join(' | ')}）`);
});

test('投放层：一个包都没声明 channels ⇒ 与从前逐字节相同（有方法也不投）', () => {
  const { lobby, sessions } = makeLobby({ serverChannels: new Map() });
  const s5 = makeSession('p5', 'E'); sessions.set('p5', s5);
  const room = createRoom(lobby, s5, ['probe']);
  let called = 0;
  room.match = { handlePackMsg() { called++; } };

  assert.equal(lobby.packMsg(s5, { t: 'pack.msg', pack: 'probe', channel: 'ping' }).ok, true);
  assert.equal(called, 0, '没有声明就没有接收入口');
  assert.equal(frames(s5).length, 1, '转发照旧');
});
