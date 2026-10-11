// test/modClientNetReads.test.js — C 层注入面的**两格只读读面**：`ctx.net.status()` 与 `ctx.net.welcome()`（DESIGN §28.24 / §28.25）。
//
// 为什么单开一个文件：这两格不是「又一个面板字段」，而是这一层**唯一的只读网络读数**，它们的全部价值就是三条性质，
// 而三条都要能被证伪：
//
//   1. **返回快照，不返回内部对象** —— 每次调用一份新的、冻结的副本；
//   2. **改动内部状态不污染已发出的快照** —— 先读一份，再让引擎变，那一份一个字都不许变；
//   3. **拿不到就是 `null`** —— 不抛、不编造、不补默认值（本项目铁律：面板可以画错、但不能算错）。
//
// 外加一条**形状与来源**的断言：`status()` 的口径与 `public/js/net.js Net.snapshot()`（`'status'` 事件携带的那一份）
// 逐字段相同，`welcome()` 的口径是客户端真收到的那一帧（`shared/protocol.js S2C` 的 `welcome`）。
//
// 还有一条容易写假的断言：**这两格不新增协议消息**。它不是「全仓没有新协议」那种口号，而是一个可执行的判据 ——
// 把真 `Net` 的每一个出口（`send` / `request` / `sendResourceMessage` / `_sendRaw`）都套上计数器，读这两格，
// 然后要求**一次调用都发生不了**。这样以后谁把读面偷偷写成「先发一帧问服务器」，这条断言当场红。
//
// Run: node --test test/modClientNetReads.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Net, NetError } from '../public/js/net.js';
import { S2C, C2S } from '../shared/protocol.js';
import { createStore, initialState } from '../public/js/store.js';
import { createPanelRegistry } from '../public/js/ui/extensions.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** 一帧 `welcome` 的**真形状**（`server/net.js:713` 组装：内建字段 + `welcomeInfo()` 那一份）。 */
const WELCOME_1 = {
  t: 'welcome',
  playerId: 'p1',
  token: 'tok-1',
  name: '甲',
  serverNow: 1_000_000,
  version: '0.2.4',
  resumed: false,
  diyKitted: ['char_1'],
  mods: { digest: 'a1b2c3d4e5f6'.repeat(5) + 'abcd', packs: [{ id: 'net-panel', layer: 'C', combat: false }] },
};
const WELCOME_2 = { ...WELCOME_1, playerId: 'p2', name: '乙', mods: { digest: 'ffffffff', packs: [] } };

/** 一个能被手动驱动的 WebSocket（`test/client-identity-handshake.test.js` 同一套最小面）。 */
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}

/**
 * 注入的定时器：**一个真定时器都不排**。
 * 真 `Net` 一连上就 `setInterval` 心跳（4 s），在 Node 用例里会把这个进程一直吊住（`node --test` 就不退出）。
 * 这些用例要的是「状态怎么读」，不是「心跳怎么走」——需要心跳时直接调 `net._heartbeat()`（既有内部入口，
 * `test/modClientPanels.test.js` 用的是同一条路）。
 */
const noTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };

/** 一个**真 `Net`**，外加手动「连上 / 收帧」的入口。 */
function liveNet() {
  const net = new Net({ url: 'ws://test/ws', WebSocket: FakeWS, getToken: () => null, now: () => 1_000_000, timers: noTimers });
  const open = () => { net.connect(); net.ws.readyState = 1; net.ws.onopen?.(); };
  const rx = (msg) => net._onMessage(JSON.stringify(msg));
  return { net, open, rx };
}

/** 一个有 `get` / `subscribe` / `patch` 的最小 store（够 `createPanelRegistry` 用）。 */
const makeStore = () => createStore({ ...initialState });

function mkEl(tag) {
  return {
    tag, className: '', attributes: {}, children: [], style: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}

/** 造一个注册点，`apply()` 一个面板，然后把它拿到的 `ctx.net` 还给你。 */
async function ctxNetOf(net, extraDeps = {}) {
  const seen = [];
  const registry = createPanelRegistry({
    store: makeStore(), net, log: quiet,
    importModule: async () => ({ mount: (ctx) => { seen.push(ctx); } }),
    slotHost: () => mkEl('div'), createElement: mkEl,
    env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
    ...extraDeps,
  });
  registry.apply([wire()]);
  await settle();
  assert.equal(seen.length, 1, '面板挂上了');
  return { registry, ctx: seen[0], cell: seen[0].net };
}

const wire = (over = {}) => ({
  id: 'p1', pack: 'alpha', slot: 'root.overlays',
  url: '/workshop-panels/alpha/p1.js?v=0123456789ab', order: 0, gate: null, requires: [], ...over,
});

// ---------------------------------------------------------------------------------------------------------------
describe('§28.24 / §28.25 面板注入面：ctx.net.status() 与 ctx.net.welcome()', () => {
  test('三格都在，且与既有的 on / send / sendResourceMessage 同在一张冻结门面上', async () => {
    const { net } = liveNet();
    const { cell } = await ctxNetOf(net);
    assert.ok(Object.isFrozen(cell), '门面本身冻结');
    assert.deepEqual(Object.keys(cell).sort(),
      ['on', 'send', 'sendResourceMessage', 'status', 'transport', 'welcome'],
      'net 面：三个成员照旧 + 三格只读读数（不多不少；transport 是 §28.32 那一格）');
    assert.notEqual(cell, net, '给的是受控门面，不是 net 本身');
    assert.equal(cell.ws, undefined, '门面上没有 socket');
    assert.equal(cell.snapshot, undefined, '引擎的 snapshot() 也不直接外传（外传的是那两格读数）');
  });

  // ---- status() -----------------------------------------------------------------------------------------------
  test('status()：口径与 `Net.snapshot()`（`status` 事件那一份）逐字段相同，且不含引擎内部字段', async () => {
    const { net, open, rx } = liveNet();
    const { cell } = await ctxNetOf(net);

    // 还没连：idle + 零值（不是「假在线」）
    const idle = cell.status();
    assert.deepEqual({ ...idle }, { status: 'idle', attempt: 0, retryAt: 0, ping: null, lastError: null });
    assert.ok(Object.isFrozen(idle), '快照是冻结的');
    assert.equal(idle.playerId, undefined, '引擎内部字段（playerId）不外传');

    // 连上并走到 online：ping / attempt 跟着真状态走，且与引擎自己那份快照逐字段相同
    open();
    rx(WELCOME_1);
    net.ping = 42;
    const online = cell.status();
    assert.equal(online.status, 'online');
    assert.equal(online.ping, 42);
    const own = net.snapshot();
    for (const k of ['status', 'attempt', 'retryAt', 'ping']) assert.equal(online[k], own[k], `同一条事实：${k}`);
    assert.deepEqual({ ...online.lastError }, { ...own.lastError });

    // 被替代（4001）：lastError 是具名的 { code, text }
    net.lastError = new NetError('REPLACED');
    const closed = cell.status();
    assert.equal(closed.lastError.code, 'REPLACED');
    assert.equal(closed.lastError.text, '该身份已在其他页面登录');
    assert.ok(Object.isFrozen(closed.lastError), '错误那一格也是冻结的');

    // 重连中：次数与倒计时是引擎的真读数
    net.status = 'reconnecting';
    net.attempt = 3;
    net.retryAt = 1_008_000;
    const rc = cell.status();
    assert.equal(rc.attempt, 3);
    assert.equal(rc.retryAt, 1_008_000);
  });

  test('status()：已发出的快照**不可污染**（引擎变 / 面板改，两个方向都试）', async () => {
    const { net, open, rx } = liveNet();
    const { cell } = await ctxNetOf(net);
    open();
    rx(WELCOME_1);
    net.ping = 42;

    const first = cell.status();
    const frozenCopy = { ...first, lastError: first.lastError ? { ...first.lastError } : null };

    // ① 引擎变：已经发出去的那一份一个字都不许变
    net.ping = 999;
    net.status = 'reconnecting';
    net.attempt = 7;
    net.retryAt = 123_456;
    net.lastError = new NetError('TIMEOUT');
    assert.deepEqual({ ...first }, frozenCopy, '内部状态变了，已发出的快照不变');
    assert.equal(first.status, 'online');
    assert.equal(first.ping, 42);
    assert.equal(first.lastError, null, '后到的错误不许回溯进旧快照');

    // ② 面板改：写冻结对象当场 TypeError，引擎侧状态不受影响
    assert.throws(() => { first.ping = 1; }, TypeError);
    assert.throws(() => { first.status = 'closed'; }, TypeError);
    assert.equal(net.ping, 999, '面板改不动引擎的状态');

    // ③ 下一次读是新的一份，内容跟着引擎走
    const second = cell.status();
    assert.notEqual(second, first, '每次调用一份新的副本');
    assert.equal(second.status, 'reconnecting');
    assert.equal(second.ping, 999);
    assert.equal(second.lastError.code, 'TIMEOUT');
    assert.throws(() => { second.lastError.code = 'X'; }, TypeError);
  });

  test('status()：拿不到时返回 null 而不是抛错（没有 snapshot / 返回值不成形 / snapshot 自己炸）', async () => {
    const cases = [
      ['没有 net', null],
      ['空对象', {}],
      ['只有 on', { on: () => () => {} }],
      ['snapshot 不是函数', { snapshot: null }],
      ['snapshot 返回 null', { snapshot: () => null }],
      ['snapshot 返回 undefined', { snapshot: () => undefined }],
      ['没有 status', { snapshot: () => ({}) }],
      ['status 不是字符串', { snapshot: () => ({ status: 42 }) }],
      ['snapshot 自己炸', { snapshot: () => { throw new Error('boom'); } }],
    ];
    for (const [note, net] of cases) {
      const { cell } = await ctxNetOf(net);
      assert.equal(cell.status(), null, `拿不到就是 null：${note}`);
      assert.equal(cell.welcome(), null, `同一份宿主下 welcome 也是 null：${note}`);
    }
    // 数字格不成形 ⇒ 归零 / null，不是把 "NaN" 字符串交出去
    const { cell } = await ctxNetOf({ snapshot: () => ({ status: 'online', attempt: 'NaN', retryAt: null, ping: 'x' }) });
    const got = cell.status();
    assert.equal(got.status, 'online');
    assert.equal(got.attempt, 0, '不成形的数字归零');
    assert.equal(got.retryAt, 0);
    assert.equal(got.ping, null);
  });

  // ---- welcome() ----------------------------------------------------------------------------------------------
  test('welcome()：返回**已经收到的那一帧**的冻结深拷贝（字段原样，不裁剪、不补默认值）', async () => {
    const { net, rx } = liveNet();
    const { cell } = await ctxNetOf(net);

    // 还没收到任何一帧：null（标题屏 / 握手被拒 / 干净安装都算）
    assert.equal(cell.welcome(), null, '还没收到 ⇒ null，不编一帧出来');

    rx(WELCOME_1);
    const w = cell.welcome();
    assert.ok(w, '收到那一帧之后就有读数了');
    assert.equal(w.playerId, 'p1');
    assert.equal(w.name, '甲');
    assert.equal(w.version, '0.2.4');
    assert.equal(w.serverNow, 1_000_000);
    assert.equal(w.token, 'tok-1', '帧里的字段原样保留（引擎已经发给页面了，不在这里裁剪）');
    assert.deepEqual(w.mods.packs, [{ id: 'net-panel', layer: 'C', combat: false }]);
    assert.equal(w.mods.digest, WELCOME_1.mods.digest);
    assert.ok(Object.isFrozen(w), '冻结');
    assert.ok(Object.isFrozen(w.mods), '深拷贝：嵌套对象也冻结');
    assert.ok(Object.isFrozen(w.mods.packs), '深拷贝：数组也冻结');
    assert.ok(Object.isFrozen(w.mods.packs[0]), '深拷贝：数组元素也冻结');
    assert.notEqual(w.mods, WELCOME_1.mods, '不是把引擎那一份交出去，是副本');
  });

  test('welcome()：已发出的快照不可污染；后到的一帧不回溯改写旧快照', async () => {
    const { net, rx } = liveNet();
    const { cell } = await ctxNetOf(net);

    rx(WELCOME_1);
    const first = cell.welcome();
    const snapshotOfFirst = JSON.stringify(first);

    // ① 引擎收到新的一帧：旧快照逐字节不变
    rx(WELCOME_2);
    assert.equal(JSON.stringify(first), snapshotOfFirst, '新帧不污染已发出的那一份');
    assert.equal(first.playerId, 'p1', '旧快照还是旧的那一帧');
    // ② 面板改那一帧：当场 TypeError，且不影响后来的一帧
    assert.throws(() => { first.playerId = 'hacked'; }, TypeError);
    assert.throws(() => { first.mods.packs.push({ id: 'x' }); }, TypeError);
    // ③ 下一次读是新的一份
    const second = cell.welcome();
    assert.notEqual(second, first);
    assert.equal(second.playerId, 'p2');
    assert.deepEqual(second.mods.packs, []);
    // ④ 面板改不动引擎自己那份原始帧（副本的另一半）
    assert.equal(WELCOME_1.playerId, 'p1');
  });

  test('welcome()：没有 net / net 没有 on 时是 null（注册点不炸，面板照装）', async () => {
    for (const net of [null, undefined, {}, { snapshot: () => ({ status: 'online' }) }, { on: 'not a function' }]) {
      const { cell } = await ctxNetOf(net);
      assert.equal(typeof cell.welcome, 'function', '这一格永远在门上（值可以是 null）');
      assert.equal(cell.welcome(), null, `没有 welcome 来源 ⇒ null（net=${JSON.stringify(net && Object.keys(net))}）`);
    }
  });

  test('dispose()：引擎那一格 welcome 订阅退掉、快照清掉（注入过一次的东西必须能收回来）', async () => {
    let welcomeFn = null;
    let unsubscribed = 0;
    const net = {
      on(type, fn) { if (type === 'welcome') welcomeFn = fn; return () => { unsubscribed += 1; welcomeFn = null; }; },
      snapshot: () => ({ status: 'idle', attempt: 0, retryAt: 0, ping: null, lastError: null }),
    };
    const { registry, cell } = await ctxNetOf(net);
    assert.equal(typeof welcomeFn, 'function', '注册点自己订阅了 welcome（那一格读面的来源）');
    welcomeFn(WELCOME_1);
    assert.equal(cell.welcome().playerId, 'p1');

    registry.dispose();
    assert.equal(unsubscribed, 1, 'dispose 退订了一次');
    assert.equal(cell.welcome(), null, 'dispose 之后那一格回到空态');
    // status() 是直读引擎状态、不持有订阅：dispose 之后仍然读得到（它不是我们注入的东西）
    assert.equal(cell.status().status, 'idle');
  });

  // ---- 不新增协议消息 ------------------------------------------------------------------------------------------
  test('两格读数**不新增协议消息**：真 Net 的四个出口一次都不被调用', async () => {
    const { net, open, rx } = liveNet();
    open();
    rx(WELCOME_1);
    // 给真 Net 的每一个出口套计数器（留着原实现：别把断言写成「函数没被定义」）
    const calls = { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 };
    for (const name of Object.keys(calls)) {
      const orig = net[name].bind(net);
      net[name] = (...args) => { calls[name] += 1; return orig(...args); };
    }
    const before = net.ws.sent.length;
    const { cell } = await ctxNetOf(net);
    for (let i = 0; i < 5; i++) { cell.status(); cell.welcome(); }
    assert.deepEqual(calls, { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 }, '读面是纯读者：一个出口都没碰');
    assert.equal(net.ws.sent.length, before, 'socket 上一个字节都没多写');
  });

  test('协议面没被这两格改动：`welcome` 仍是 S2C 成员，读面用的 `status` 事件**不是**线上的消息类型', () => {
    assert.ok(S2C.includes('welcome'), 'welcome 是既有的 S2C 成员（客户端本来就收）');
    assert.equal('status' in C2S, false, '`status` 是引擎内部事件名，不是 C2S 消息');
    assert.equal(S2C.includes('status'), false, '`status` 也不是 S2C 消息类型');
    // 读面不顺手发心跳：引擎能发的还是那几条既有帧
    const { net, open } = liveNet();
    open();
    net.ws.sent.length = 0;
    net._heartbeat();
    assert.deepEqual(net.ws.sent.map((f) => f.t), ['ping'], '引擎能发的还是那些既有帧');
  });
});
