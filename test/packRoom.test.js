// test/packRoom.test.js — 包声明的**房间级钩子**（`pack.json.server.room`, DESIGN §28.20）。
//
// 这个文件钉五件事：
//   1. **形状与分类**：`server.room = { module }`（包内 `.mjs`）、点名拒绝码、`EMPTY_PACK` 认得它，以及**闸门分类
//      规则** —— 房间钩子是观察面，所以**不**要求 `combat: true`（与 `server.meta` / `server.battle` 相反），
//      推导出来的层是 B、`combat` 照旧 false；
//   2. **装载期**：模块必须真的在包里（`ROOM_BAD_MODULE` 整包被拒）；没有 `install` 导出 ⇒ `ROOM_NO_INSTALL`；
//   3. **静态扫描与 import 白名单**：`Math.random` / `Date.now` / `process` 与非 `@sim/` 的 import 一律让整包移出
//      已加载集合（白名单比 kit 与 `server.battle` 都窄：房间钩子拿不到战场辅助函数）；
//   4. **身份**：模块字节进内容哈希 —— 换一段房间行为就是换一个包摘要（房间摘要闸门靠的就是这一步）；
//   5. **真服务器 + 真房间**：`install(room)` 真的在大厅里跑，事件按**引擎的调用顺序**到达（create → join →
//      matchStart → matchEnd → dispose），抛异常的钩子不破坏房间，W-B 下只有房间声明过的包的钩子参与。
//
// 观察手段是**包自己 `console.log`**（真包想「播报」就是这么写的），所以不需要给测试开后门 —— 加载器与钩子面的接口
// 里没有任何一件是「为了测试」而存在的。
import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { loadRoomInstallers, roomSourceIssues, createRoomHooks, ROOM_HOOK_EVENTS } from '../server/roomPack.js';
import { normalizePackManifest } from '../shared/workshop.js';
import { TestClient } from './helpers/wsClient.js';
import { StubMatch } from '../server/match/StubMatch.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 一个最小包：一条自己的盟约记录（这样它不是空包）+ 一段房间钩子。
 * `combat` 默认**不写** —— 房间钩子不需要它，而「不写也合法」正是这一刀的分类规则要钉的那一件事。
 */
function writePack(root, id, moduleSource, { module = 'room/hooks.mjs', combat = undefined, bonds = true } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, path.dirname(module)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
    content: bonds ? ['bonds'] : [],
    ...(combat === undefined ? {} : { combat }),
    server: { room: { module } },
  }));
  if (bonds) {
    fs.writeFileSync(path.join(dir, 'bonds.json'), JSON.stringify({
      [`${id}Ship`]: { bondId: `${id}Ship`, name: '测试盟约', isCore: false, thresholds: [3, 6], buffs: [] },
    }));
  }
  fs.writeFileSync(path.join(dir, module), moduleSource);
  return dir;
}

/**
 * 一段把每个事件写成一行 JSON 的**真**房间钩子。`console.log` 是它唯一的对外通道（真包的「播报」就是这个），
 * 所以测试不需要任何后门；行首的标记让测试能从别的日志里挑出自己那几行。
 */
const TRACE_MODULE = (id) => `
const MARK = ${JSON.stringify(`ROOM-TRACE:${id}`)};
export function install(room) {
  const emit = (event, extra) => console.log(MARK + ' ' + JSON.stringify({
    event, id: room.id, modIds: room.modIds, phase: room.phase(), nowType: typeof room.now(), extra: extra || null,
  }));
  emit('install');
  for (const event of ['create', 'join', 'spectate', 'leave', 'matchStart', 'matchEnd', 'matchFailed', 'dispose']) {
    room.on(event, (payload) => emit(event, {
      by: payload.by ? payload.by.playerId : null,
      matchNo: payload.matchNo === undefined ? null : payload.matchNo,
      reason: payload.reason === undefined ? null : payload.reason,
      players: payload.players ? payload.players.length : null,
      spectators: payload.spectators ? payload.spectators.length : null,
    }));
  }
}
`;

/**
 * 把 stdout 上的 `ROOM-TRACE:` 行收集起来的**全局**拦截器。测试期间一直装着（不是只围着一段代码），因为
 * `dispose` 可能落在下一拍宏任务上 —— 只围一段代码的话那一行会漏进测试输出。
 */
let traceLines = [];
let traceOriginal = null;
function captureTrace() {
  traceLines = [];
  traceOriginal = console.log;
  console.log = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('ROOM-TRACE:')) traceLines.push(first);
    else traceOriginal(...args);
  };
}
function releaseTrace() {
  if (traceOriginal) console.log = traceOriginal;
  traceOriginal = null;
}

/** 清掉到目前为止的行，跑 `fn`，返回 `fn` 的结果与**这一段**里新来的行。 */
async function traceRun(fn) {
  traceLines = [];
  const value = await fn();
  return { value, lines: traceLines.slice() };
}

/** 等到事件循环把上一拍的 `dispose` / `leave` 收尾（它们活在 `setImmediate` / 定时器上）。 */
const settle = () => new Promise((res) => setTimeout(res, 25));

/** 一行 trace → `{ pack, event, … }`。 */
function parseTrace(line) {
  const [mark, json] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
  return { pack: mark.slice('ROOM-TRACE:'.length), ...JSON.parse(json) };
}

/** 一行的 `pack:event` 序列（断言顺序用）。 */
const order = (lines) => lines.map((l) => { const t = parseTrace(l); return `${t.pack}:${t.event}`; });

/**
 * `room.create` / `room.join` 一律带上**这个服务器在跑的那份摘要**（`checkModSet`）：装了工坊包时，客户端必须先
 * 说明它以为自己在加入什么内容 —— 这条闸门与房间钩子无关，但每个真服务器的房间测试都要过它。一个包都没装载时
 * `modSet` 是 null，闸门也就不存在，所以那时不加这个字段。
 */
const requestRoom = (client, srv, msg) => client.request(
  srv.lobby.modSet ? { mods: srv.lobby.modSet.digest, ...msg } : { ...msg },
);

// ---------------------------------------------------------------------------------------------------------------
describe('server.room：声明形状、点名拒绝与闸门分类（DESIGN §28.20）', () => {
  /** 一份最小的合法清单（`content: ['bonds']`，所以不会撞上 EMPTY_PACK）。 */
  const manifest = (extra) => normalizePackManifest({
    id: 'p', name: 'p', version: '1.0.0', content: ['bonds'], ...extra,
  }, 'p');

  test('形状：{ module } 一个字段，包内相对、必须是 .mjs', () => {
    const ok = manifest({ server: { room: { module: 'room/hooks.mjs' } } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.pack.server.room, { module: 'room/hooks.mjs' });
    const cases = [
      [{ room: 'room/hooks.mjs' }, 'ROOM_BAD_SHAPE'],
      [{ room: { module: 'room/hooks.js' } }, 'ROOM_BAD_MODULE'],
      [{ room: { module: 'room/hooks' } }, 'ROOM_BAD_MODULE'],
      [{ room: { module: '../outside.mjs' } }, 'ROOM_BAD_PATH'],
      [{ room: { module: '/abs/hooks.mjs' } }, 'ROOM_BAD_PATH'],
      [{ room: { module: 'room/hooks.mjs', registers: [] } }, 'ROOM_UNKNOWN_FIELD'],
    ];
    for (const [server, code] of cases) {
      const r = manifest({ server });
      assert.equal(r.ok, false, `${JSON.stringify(server)} 不该被收下`);
      assert.equal(r.error, code, `${JSON.stringify(server)}: ${r.detail}`);
    }
  });

  test('`server` 的成员闭集认得 room；写错的名字一律点名（SERVER_UNKNOWN_FIELD）', () => {
    const bad = manifest({ server: { rooms: { module: 'room/hooks.mjs' } } });
    assert.equal(bad.error, 'SERVER_UNKNOWN_FIELD');
    assert.match(bad.detail, /room/, '拒绝文案要列出认识的成员（含 room）');
    // 与既有的成员并存：一个包可以同时声明 room 与 battle（两份互不影响）
    const both = manifest({ combat: true, server: { battle: { module: 'battle/main.mjs' }, room: { module: 'room/hooks.mjs' } } });
    assert.equal(both.ok, true, JSON.stringify(both));
    assert.deepEqual(both.pack.server.room, { module: 'room/hooks.mjs' });
    assert.deepEqual(both.pack.server.battle, { module: 'battle/main.mjs' });
    // `server: {}` 照旧被拒（空对象什么都不说）
    assert.equal(manifest({ server: {} }).error, 'SERVER_EMPTY_MEMBER');
  });

  test('`server.room` 是**贡献项**：一个只声明它的包不是 EMPTY_PACK', () => {
    const r = manifest({ content: [], server: { room: { module: 'room/hooks.mjs' } } });
    assert.equal(r.ok, true, JSON.stringify(r));
    // 反例：一个什么都不带的包照旧 EMPTY_PACK，而文案里点得到 server.room
    const empty = manifest({ content: [] });
    assert.equal(empty.error, 'EMPTY_PACK');
    assert.match(empty.detail, /server\.room/);
  });

  test('闸门分类：房间钩子**不**要求 combat: true，包照旧合法（层推导成 B、combat 仍 false）', () => {
    // 不写 combat ⇒ 合法。这是与 server.meta / server.battle 的**唯一**差别，也就是这一刀分类规则的落点。
    const r = manifest({ server: { room: { module: 'room/hooks.mjs' } } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pack.combat, null);
    for (const code of ['ROOM_NEEDS_COMBAT', 'BATTLE_NEEDS_COMBAT', 'META_NEEDS_COMBAT', 'MODULES_NEED_COMBAT']) {
      assert.equal(r.error, undefined, `${code} 不该出现在房间钩子上`);
    }
    // 反过来：一个**同时**声明 server.battle 的包，硬闸门照旧（既有规则一字未动）
    const both = manifest({ server: { battle: { module: 'battle/main.mjs' }, room: { module: 'room/hooks.mjs' } } });
    assert.equal(both.error, 'BATTLE_NEEDS_COMBAT');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('server.room：静态扫描与 import 白名单', () => {
  test('非确定性 / 环境绑定一律点名（在 import 之前）', () => {
    for (const needle of ['Math.random()', 'Date.now()', 'process.env.X', 'setTimeout(f, 1)', 'globalThis.x', 'localStorage.x']) {
      const issues = roomSourceIssues(`export function install() { return ${needle}; }`, 'p');
      assert.equal(issues.length >= 1, true, `${needle} 必须被扫出来`);
      assert.equal(issues[0].code, 'ROOM_BAD_SOURCE');
      assert.match(issues[0].reason, /server\.room module/, '文案要说清是 server.room 模块');
    }
    assert.deepEqual(roomSourceIssues('export function install(room) { room.on("create", () => {}); }', 'p'), []);
  });

  test('import 白名单：只有 @sim/（@kit/ 与 @battle/ 都不开放）', () => {
    const bad = (spec) => roomSourceIssues(`import { x } from '${spec}';\nexport function install() {}`, 'p');
    for (const spec of ['../shared/tier1.js', 'node:fs', 'fs', '/sim/constants.js']) {
      const issues = bad(spec);
      assert.equal(issues.length >= 1, true, `${spec} 必须被拒`);
      assert.equal(issues[0].code, 'ROOM_BAD_IMPORT');
    }
    // 前缀合法但**这一层**没开放的文件：文案要说「前缀合法但这个文件不在白名单里」，并列出这一份白名单
    for (const spec of ['@kit/tier1.js', '@battle/index.js']) {
      const issues = bad(spec);
      assert.equal(issues[0].code, 'ROOM_BAD_IMPORT');
      assert.match(issues[0].reason, /未开放/);
      assert.match(issues[0].reason, /@sim\//, '拒绝文案要给出这一层的白名单');
    }
    // `@room/` **不存在**（这一层刻意复用 @sim/，见 §28.20）：照样被拒，理由里给出真正的白名单
    const unknown = bad('@room/helpers.js');
    assert.equal(unknown[0].code, 'ROOM_BAD_IMPORT');
    assert.match(unknown[0].reason, /@sim\//);
    assert.match(unknown[0].reason, /白名单/);
    // 放行的三个纯函数模块
    for (const spec of ['@sim/constants.js', '@sim/dir.js', '@sim/targeting.js']) {
      assert.deepEqual(roomSourceIssues(`import { x } from '${spec}';\nexport function install() {}`, 'p'), [], spec);
    }
  });

  test('闭枚举的事件名：`room.on` 只认 8 个生命周期事件（拼错的名字点名，不静默）', () => {
    assert.deepEqual([...ROOM_HOOK_EVENTS], ['create', 'join', 'spectate', 'leave', 'matchStart', 'matchEnd', 'matchFailed', 'dispose']);
    const lines = [];
    const hub = createRoomHooks({
      installers: [{ id: 'p', install: (room) => { room.on('creat', () => {}); room.on('create', () => {}); } }],
      log: { warn: (l) => lines.push(String(l)) },
    });
    hub.install({ code: 'AAAA', seats: [], spectators: [], modIds: null, modSet: null, match: null });
    hub.fire({ code: 'AAAA', seats: [], spectators: [], modIds: null, modSet: null, match: null }, 'create');
    assert.equal(lines.length, 1, `一个错名字应当只报一行：${lines.join(' | ')}`);
    assert.match(lines[0], /ROOM_HOOK_THREW/);
    assert.match(lines[0], /ROOM_UNKNOWN_EVENT/);
    assert.match(lines[0], /"creat"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('server.room：装载期判据与身份', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-room-load-')); });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('模块不在 ⇒ 整包被拒（ROOM_BAD_MODULE），它不在已加载集合里', () => {
    const root = path.join(tmp, 'missing');
    const dir = writePack(root, 'missing-module', TRACE_MODULE('missing-module'));
    fs.rmSync(path.join(dir, 'room', 'hooks.mjs'));
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.packs, []);
    assert.match(loaded.errors[0].reason, /ROOM_BAD_MODULE/);
  });

  test('装载器交出 install 函数；没有 install 导出 ⇒ ROOM_NO_INSTALL', async () => {
    const root = path.join(tmp, 'load');
    writePack(root, 'good-room', TRACE_MODULE('good-room'));
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs.map((p) => `${p.id}:${p.layer}:${p.combat}`), ['good-room:B:false']);
    const r = await loadRoomInstallers(loaded, { log: quiet });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.installers.map((i) => i.id), ['good-room']);
    assert.equal(typeof r.installers[0].install, 'function');

    const root2 = path.join(tmp, 'noinstall');
    writePack(root2, 'no-install', 'export function notInstall() {}\n');
    const noInstall = await loadRoomInstallers(loadWorkshop(root2, { log: quiet }), { log: quiet });
    assert.deepEqual(noInstall.installers, []);
    assert.equal(noInstall.errors[0].code, 'ROOM_NO_INSTALL');
  });

  test('源码里带非确定性 ⇒ 装载器点名（ROOM_BAD_SOURCE），调用方据此裁掉整包', async () => {
    const root = path.join(tmp, 'bad');
    writePack(root, 'bad-room', 'export function install() { return Math.random(); }\n');
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], '形状/文件都在，所以 loadWorkshop 收下它（判据在源码扫描那一层）');
    const r = await loadRoomInstallers(loaded, { log: quiet });
    assert.deepEqual(r.installers, []);
    assert.equal(r.errors[0].code, 'ROOM_BAD_SOURCE');
  });

  test('身份：房间钩子模块的字节进内容哈希（换一段行为 = 换一个摘要）', () => {
    const root = path.join(tmp, 'hash');
    writePack(root, 'hash-a', TRACE_MODULE('hash-a'));
    const first = loadWorkshop(root, { log: quiet });
    assert.deepEqual(first.errors, []);
    const before = first.packs[0].hash;
    assert.ok(first.packs[0].manifest.some((m) => m.path === 'room/hooks.mjs'), '清单里必须列出模块路径');
    // 只改模块字节，别的都不动
    fs.writeFileSync(path.join(root, 'hash-a', 'room', 'hooks.mjs'), `${TRACE_MODULE('hash-a')}\n// one more line\n`);
    const second = loadWorkshop(root, { log: quiet });
    assert.notEqual(second.packs[0].hash, before, '换了模块字节，包摘要必须变');
    // 反向：**没有**声明 `server.room` 的同一个包，摘要与声明了的那一份不同 —— 「声明本身」也在身份里
    const root2 = path.join(tmp, 'hash-noroom');
    writePack(root2, 'hash-a', TRACE_MODULE('hash-a'));
    const manifestPath = path.join(root2, 'hash-a', 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.server;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const noRoom = loadWorkshop(root2, { log: quiet });
    assert.deepEqual(noRoom.errors, []);
    assert.equal(noRoom.packs[0].layer, 'A', '没有 room 声明时它只是一个数据包');
    assert.notEqual(noRoom.packs[0].hash, second.packs[0].hash, '有没有这条声明必须体现在摘要里');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('server.room：真服务器 + 真房间（观察顺序、隔离、W-B）', () => {
  let tmp;
  let clients;

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-room-live-')); clients = []; captureTrace(); });
  afterEach(async () => {
    for (const c of clients) await c.terminate().catch(() => {});
    releaseTrace();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 起一个真服务器 + 两个客户端；返回 `{ srv, url, a, b }`。 */
  async function boot(ws, opts = {}) {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws, MatchClass: StubMatch, ...opts });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const open = async (name) => {
      const c = await TestClient.connect(url);
      clients.push(c);
      const w = await c.hello(name);
      c.id = w.playerId;
      return c;
    };
    return { srv, url, a: await open('甲'), b: await open('乙') };
  }

  test('install(room) 在真房间里跑，事件按引擎的调用顺序到达（create → join → matchStart → matchEnd → dispose）', async () => {
    const ws = path.join(tmp, 'ws');
    writePack(ws, 'roompack', TRACE_MODULE('roompack'));
    const { srv, a, b } = await boot(ws);
    try {
      assert.deepEqual(srv.lobby.workshop.roomHooks.map((i) => i.id), ['roompack'], '装载器交出来的 installer 进了 Lobby');
      const { lines } = await traceRun(async () => {
        // 1) 房主建房（coop：一个人不动手不会开局）—— 另一个人加入
        const r = await requestRoom(a, srv, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
        assert.equal(r.t, 'ok', JSON.stringify(r));
        const state = await a.waitFor('room.state');
        const code = state.code;
        const joined = await requestRoom(b, srv, { t: 'room.join', code });
        assert.equal(joined.t, 'ok', JSON.stringify(joined));
        await b.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === b.id));
        // 2) 开一局，然后让 STUB 对局自己结算：co-op 的房主开局前别的人类必须就绪，结算前**每个**人类都要确认
        assert.equal((await b.request({ t: 'room.ready', ready: true })).t, 'ok');
        await a.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === b.id && x.ready === true));
        const started = await a.request({ t: 'room.start' });
        assert.equal(started.t, 'ok', JSON.stringify(started));
        await a.waitFor('m.public');
        assert.equal((await a.request({ t: 'g.infoReady' })).t, 'ok');
        assert.equal((await b.request({ t: 'g.infoReady' })).t, 'ok');
        await a.waitFor('m.result');
        // 3) 对局结束后回 Lobby；两个人先后离开 ⇒ 房间空了 ⇒ dispose
        assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
        assert.equal((await b.request({ t: 'room.leave' })).t, 'ok');
        await settle();
        return code;
      });
      assert.deepEqual(order(lines), [
        'roompack:install',
        'roompack:create',
        'roompack:join',
        'roompack:matchStart',
        'roompack:matchEnd',
        'roompack:leave',
        'roompack:leave',
        'roompack:dispose',
      ]);
      const create = parseTrace(lines[1]);
      assert.equal(create.id.length, 4, `room.id 是那个 4 字母房间码（got ${create.id}）`);
      assert.equal(create.modIds, null, '没声明集合的房间 modIds 是 null（进程级那一份）');
      assert.equal(create.nowType, 'number');
      const join = parseTrace(lines[2]);
      assert.equal(typeof join.extra.by, 'string', 'join 的载荷点名是谁进来了');
      const start = parseTrace(lines[3]);
      assert.equal(start.phase, 'match', 'matchStart 时 room.phase() 已经是 match');
      assert.equal(start.extra.matchNo, 1);
      assert.equal(start.extra.players, 2, 'matchStart 的载荷列出这一局的玩家');
      const end = parseTrace(lines[4]);
      assert.equal(end.extra.matchNo, 1);
      assert.equal(end.phase, 'lobby', 'matchEnd 时对局已经不在房间上了');
      const dispose = parseTrace(lines[7]);
      assert.equal(dispose.extra.reason, 'empty', '两个人都走了 ⇒ empty');
      assert.equal(srv.lobby.roomHooks.stats().rooms, 0, 'dispose 之后那个房间的钩子表要清掉');
    } finally {
      await srv.close();
    }
  });

  test('抛异常的钩子不破坏房间：建房、加入、对局结束照旧，只多三条 ROOM_HOOK_THREW', async () => {
    const ws = path.join(tmp, 'ws');
    writePack(ws, 'boom', `
export function install(room) {
  room.on('create', () => { throw new Error('pack boom'); });
  room.on('join', () => { throw new Error('pack boom'); });
  room.on('matchEnd', () => { throw new Error('pack boom'); });
  console.log('ROOM-TRACE:boom ' + JSON.stringify({ event: 'install' }));
}
`);
    const warns = [];
    const { srv, a, b } = await boot(ws, { log: { info() {}, debug() {}, error() {}, warn: (l) => warns.push(String(l)) } });
    try {
      // 建房照旧成功，并且房间真的能用（另一个人进得来）
      const r = await requestRoom(a, srv, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      assert.equal(r.t, 'ok', JSON.stringify(r));
      const state = await a.waitFor('room.state');
      const joined = await requestRoom(b, srv, { t: 'room.join', code: state.code });
      assert.equal(joined.t, 'ok', JSON.stringify(joined));
      await b.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === b.id));
      // 开一局并让它结算 —— matchEnd 的钩子也会抛，房间照旧回到 Lobby
      assert.equal((await b.request({ t: 'room.ready', ready: true })).t, 'ok');
      await a.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === b.id && x.ready === true));
      assert.equal((await a.request({ t: 'room.start' })).t, 'ok');
      await a.waitFor('m.public');
      assert.equal((await a.request({ t: 'g.infoReady' })).t, 'ok');
      assert.equal((await b.request({ t: 'g.infoReady' })).t, 'ok');
      await a.waitFor('m.result');
      const back = await a.waitFor('room.state', (s) => s.inMatch === false);
      assert.equal(back.inMatch, false);
      // 三条命名日志（create / join / matchEnd），每条点名包与钩子，并且带上原始错误
      const thrown = warns.filter((l) => l.includes('ROOM_HOOK_THREW'));
      assert.equal(thrown.length, 3, `应当恰好三条：${JSON.stringify(warns)}`);
      assert.deepEqual(thrown.map((l) => /hook "([a-zA-Z]+)"/.exec(l)[1]), ['create', 'join', 'matchEnd']);
      for (const line of thrown) {
        assert.match(line, /"boom"/, '每条都要点名是哪个包');
        assert.match(line, /pack boom/, '每条都要带上原始错误');
      }
    } finally {
      await srv.close();
    }
  });

  test('W-B：房间声明了集合时，只有它点名的包的房间钩子参与', async () => {
    const ws = path.join(tmp, 'ws');
    writePack(ws, 'aa-pack', TRACE_MODULE('aa-pack'));
    writePack(ws, 'zz-pack', TRACE_MODULE('zz-pack'));
    const { srv, a } = await boot(ws);
    try {
      assert.deepEqual(srv.lobby.workshop.roomHooks.map((i) => i.id).sort(), ['aa-pack', 'zz-pack']);
      // 只点 `zz-pack`：它的钩子要在，`aa-pack` 的一条都不能触发
      const packHash = srv.lobby.workshop.mods.find((m) => m.id === 'zz-pack').hash;
      const { lines } = await traceRun(async () => {
        const r = await requestRoom(a, srv, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', modIds: ['zz-pack'] });
        assert.equal(r.t, 'ok', JSON.stringify(r));
        const state = await a.waitFor('room.state');
        assert.deepEqual(state.mods.packs.map((p) => p.id), ['zz-pack'], '房间的集合就是它点名的那一个');
        assert.equal(state.mods.packs[0].hash, packHash);
        assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
        await settle();
        return state.code;
      });
      assert.deepEqual(order(lines), ['zz-pack:install', 'zz-pack:create', 'zz-pack:leave', 'zz-pack:dispose'], `只该有 zz-pack`);
      const create = parseTrace(lines[1]);
      assert.deepEqual(create.modIds, ['zz-pack'], 'W-B：钩子的 modIds 就是房间声明的那一份');
      assert.equal(order(lines).filter((s) => s.endsWith(':install')).length, 1, '每个包的钩子只装一次');
      assert.equal(srv.lobby.roomHooks.stats().rooms, 0, '房间没了，钩子表也清掉');
    } finally {
      await srv.close();
    }
  });

  test('观战者：room.spectate 触发 spectate（观战不是玩家，但「有人来看」也看得见）', async () => {
    const ws = path.join(tmp, 'ws');
    writePack(ws, 'roompack', TRACE_MODULE('roompack'));
    const { srv, a, b } = await boot(ws);
    try {
      const { lines } = await traceRun(async () => {
        assert.equal((await requestRoom(a, srv, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
        const state = await a.waitFor('room.state');
        const sp = await requestRoom(b, srv, { t: 'room.spectate', code: state.code });
        assert.equal(sp.t, 'ok', JSON.stringify(sp));
        await a.waitFor('room.state', (s) => s.spectators.length === 1);
        assert.equal((await b.request({ t: 'room.leave' })).t, 'ok');
        assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
        await settle();
      });
      assert.deepEqual(order(lines), [
        'roompack:install', 'roompack:create', 'roompack:spectate', 'roompack:leave', 'roompack:leave', 'roompack:dispose',
      ]);
      const sp = parseTrace(lines[2]);
      assert.equal(sp.event, 'spectate');
      assert.equal(typeof sp.extra.by, 'string', 'spectate 的载荷点名是谁来看的');
    } finally {
      await srv.close();
    }
  });

  test('一个包都没声明 server.room：大厅多一次函数调用都不做（roomHooks 是空的）', async () => {
    const ws = path.join(tmp, 'ws-noroom');
    // 一个普通的包（没有 server.room），外加一条自己的盟约记录
    fs.mkdirSync(path.join(ws, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'plain', 'pack.json'), JSON.stringify({
      id: 'plain', name: 'plain', version: '1.0.0', license: 'CC0-1.0', description: 'x', content: ['bonds'],
    }));
    fs.writeFileSync(path.join(ws, 'plain', 'bonds.json'), JSON.stringify({
      plainShip: { bondId: 'plainShip', name: '普通盟约', isCore: false, thresholds: [3, 6], buffs: [] },
    }));
    const { srv, a } = await boot(ws);
    try {
      assert.deepEqual(srv.lobby.workshop.roomHooks, []);
      assert.deepEqual(srv.lobby.roomHooks.stats(), { installers: 0, rooms: 0 });
      assert.equal((await requestRoom(a, srv, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
      const state = await a.waitFor('room.state');
      assert.equal(state.mods, undefined, '没声明集合的房间照旧不带 mods（与从前逐字节相同的不变量）');
      assert.equal(srv.lobby.roomHooks.stats().rooms, 0, '没有包声明房间钩子 ⇒ 一张表都不建');
      assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
    } finally {
      await srv.close();
    }
  });

  test('装不上的房间钩子 ⇒ 整包移出已加载集合（与 server.battle 同一个裁剪点）', async () => {
    const ws = path.join(tmp, 'ws-drop');
    writePack(ws, 'dropped', 'export function install() { return Date.now(); }\n');
    const { srv, a } = await boot(ws);
    try {
      const packs = (srv.lobby.welcomeInfo().mods || { packs: [] }).packs.map((p) => p.id);
      assert.equal(packs.includes('dropped'), false, `被裁的包不该出现在线上摘要里：${JSON.stringify(packs)}`);
      assert.deepEqual(srv.lobby.workshop.roomHooks, []);
      assert.deepEqual(srv.lobby.roomHooks.stats(), { installers: 0, rooms: 0 });
      // 而且它也不是「装了但没生效」：房间照旧能建（此时服务器一个包都没装载，所以摘要闸门也不存在）
      assert.equal((await requestRoom(a, srv, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
      await a.waitFor('room.state');
    } finally {
      await srv.close();
    }
  });
});
