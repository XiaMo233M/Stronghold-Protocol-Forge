// test/modPreDispatch.test.js — 包声明的**分发前钩子**（`pack.json.server.preDispatch`，DESIGN §28.13，
// docs/WORKSHOP.md §1.9；A 段只认下声明，B1 段把行为落地）。
//
// 这份文件钉住 B1 段的四条载重：
//   1. **没有包声明 = 与今天逐字节相同**：`createModDispatch` 返回 null，Network 拿不到 `preDispatch` / `onConnection`
//      两个选项。这里用**真实夹具**（docs/examples 的三份示例包，一份都没声明 `server`）对照：装载器给的钩子（空的）
//      装出来的 Network 与一个完全没有钩子的 Network，喂同一批消息必须吐出逐帧相同的回复。
//   2. **声明合法 = 钩子被挂上**：`intercepts` 命中且被否决时消息不进大厅；钩子放行时（含它自己 `intercepts` 里的类型）
//      照常分发；钩子总线自己的 `resource.*` 三个类型不在任何 `intercepts` 里，但**每一条**通过协议校验的消息都会
//      到达钩子。
//   3. **否决的回执保留 `rid`**：没有 rid 的错误帧在客户端会走 `unhandledError` 弹红条（public/js/main.js），所以这
//      一条既在单元层（假 socket）也在端到端层（真 ws）断言。
//   4. **隔离与确定性**：工厂**每个连接调用一次**（状态只挂在那条连接上，多局并发不串味）、依赖对象冻结且只有那八个
//      键（没有 data / lobby / Match —— 注入改不了对局结果）、包 id 次序决定调用次序、不注册第二个 message 监听器。
//   5. **坏声明拒的是整个包**（B3a 段对齐，DESIGN §28.13.3）：模块/策略文件不在、策略不是 JSON 对象、`intercepts`
//      里有协议不认识的名字 —— 以前只拒那个钩子、包照旧加载（服务器以为自己被准入闸门保护着），现在整包不进
//      `loaded.packs`。B4 段把最后剩下的一格也补上：只有 import 才知道的两种（模块装不上 / 没有工厂导出）由**启动
//      装配路径**上的 `dropUnavailablePreDispatchPacks` 裁剪，于是「声明了闸门却没有闸门」不再是一个能通过的结局。
//
// Run: node --test test/modPreDispatch.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { C2S, validateC2S } from '../shared/protocol.js';
import { loadWorkshop, loadWorkshopHooks, dropUnavailablePreDispatchPacks } from '../server/workshop.js';
import { createModDispatch, PRE_DISPATCH_DEPS } from '../server/modDispatch.js';
import { Network, SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, 'docs/examples');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = 1_700_000_000_000;
/** 一份合法的 `resource.proof`（48 / 12 / 3×64 位十六进制 —— 与客户端的证明算法逐字对应）。 */
const PROOF = {
  nonce: 'a'.repeat(48),
  version: 'b'.repeat(12),
  proofs: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)],
};

// ---------------------------------------------------------------------------------------------------
// 假 socket / 组网：钩子这一层先在**框架内部**验证（真 ws 留给端到端那两条）
// ---------------------------------------------------------------------------------------------------

/** `ws` 的最小替身：EventEmitter + 框架真正用到的那几个成员（readyState / send / bufferedAmount / close）。 */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    /** @type {any[]} */
    this.sent = [];
  }

  send(data) { this.sent.push(JSON.parse(String(data))); }

  close() { this.readyState = 3; this.emit('close'); }

  terminate() { this.readyState = 3; }
}

/**
 * 组一个 Network，装配方式与 server/http/websocket.js 一致（`send` 晚绑定到 `network.reply`）。
 * `hooks` 为空 / null 时 Network **不会**拿到那两个选项 —— 那就是「没有包声明」的形状。
 */
function stack({ hooks = null, handler = null } = {}) {
  const registry = new SessionRegistry();
  const h = handler || { onMessage: () => undefined };
  let network;
  const dispatch = createModDispatch({ hooks, send: (conn, msg) => network.reply(conn, msg), log: quiet, now: () => NOW });
  network = new Network({ registry, handler: h, log: quiet, now: () => NOW, options: dispatch ? { preDispatch: dispatch.preDispatch, onConnection: dispatch.onConnection } : {} });
  return { network, registry, handler: h, dispatch };
}

/** 连一条假 socket，返回它的 Connection 与那个 socket。 */
function connect(network) {
  const sock = new FakeSocket();
  network.handleConnection(sock, undefined);
  return { sock, conn: network.conns.get(sock) };
}

/** 喂一帧（走真的 onFrame 流水线：限速 → JSON → C2S 白名单 → validateC2S → 钩子 → 大厅）。 */
function frame(network, conn, msg) {
  network.onFrame(conn, Buffer.from(JSON.stringify(msg), 'utf8'), false);
}

/** 一个只做「入口闸门」的钩子工厂：证明前否决 intercepts、证明后放行；`resource.*` 永远被它消费。 */
function guardFactory() {
  return (deps) => {
    const state = { allowed: false };
    const challenge = (conn) => deps.send(conn, { t: 'resource.challenge', nonce: PROOF.nonce, files: ['a', 'b', 'c'], expiresAt: deps.now() + 300_000 });
    return {
      onConnection(conn) { challenge(conn); },
      preDispatch(conn, msg) {
        if (msg.t === 'resource.challenge.request') { challenge(conn); return true; }
        if (msg.t === 'resource.reset') { state.allowed = false; return true; }
        if (msg.t === 'resource.proof') {
          state.allowed = msg.nonce === PROOF.nonce && msg.version === PROOF.version;
          deps.send(conn, { t: state.allowed ? 'resource.accepted' : 'resource.rejected', ...(msg.rid != null ? { rid: msg.rid } : {}) });
          return true;
        }
        if (!state.allowed && deps.intercepts.includes(msg.t)) {
          // 回执保留 rid（见文件头第 3 条）
          deps.send(conn, { t: 'error', ...(msg.rid != null ? { rid: msg.rid } : {}), code: 'RESOURCE_REQUIRED', msg: '必须先导入完整资源包' });
          return true;
        }
        return false;
      },
    };
  };
}

/** 装载器产物的形状（`loadWorkshopHooks` 的那几个键），用测试自己的工厂。 */
const hookOf = (pack, create, intercepts = ['room.create']) => ({ pack, create, intercepts, policy: { version: 'v1' }, policyFile: 'p.json' });

// ---------------------------------------------------------------------------------------------------
// 临时工坊根：一份合法声明 + 五种坏声明 + 一份普通数据包
// ---------------------------------------------------------------------------------------------------

let tmp;
let wsRoot;
/** 端到端用的工坊根：只放那一份声明了钩子的包（房间摘要闸门只管这一个包）。 */
let wsOnly;
/** 一份能用的准入模块（**不用 RNG、不读全局时钟**：nonce 固定、到期时间读注入的 `now()`）。 */
const GUARD_SOURCE = `
export function createPreDispatch(deps) {
  const state = { allowed: false };
  const challenge = (conn) => deps.send(conn, { t: 'resource.challenge', nonce: '${PROOF.nonce}', files: ['a', 'b', 'c'], expiresAt: deps.now() + 300000 });
  return {
    onConnection(conn) { challenge(conn); },
    preDispatch(conn, msg) {
      if (msg.t === 'resource.challenge.request') { challenge(conn); return true; }
      if (msg.t === 'resource.reset') { state.allowed = false; return true; }
      if (msg.t === 'resource.proof') {
        state.allowed = msg.nonce === '${PROOF.nonce}' && msg.version === '${PROOF.version}';
        deps.send(conn, { t: state.allowed ? 'resource.accepted' : 'resource.rejected', ...(msg.rid != null ? { rid: msg.rid } : {}) });
        return true;
      }
      if (!state.allowed && deps.intercepts.includes(msg.t)) {
        deps.send(conn, { t: 'error', ...(msg.rid != null ? { rid: msg.rid } : {}), code: 'RESOURCE_REQUIRED', msg: 'must import the resource pack first' });
        return true;
      }
      return false;
    },
  };
}
`;

const PACKS = {
  // 合法：只声明 server.preDispatch（A 段的语义：这就是一项贡献）
  guard: {
    pack: { name: 'Guard', server: { preDispatch: { module: 'server/guard.mjs', policy: 'admission.json', intercepts: ['room.create', 'room.join'] } } },
    files: { 'server/guard.mjs': GUARD_SOURCE, 'admission.json': JSON.stringify({ version: 'v1', files: ['a', 'b', 'c'] }) },
  },
  // 声明了 module，但文件不在包里
  moduleMissing: { pack: { name: 'ModuleMissing', server: { preDispatch: { module: 'server/gone.mjs', policy: 'admission.json', intercepts: ['room.create'] } } }, files: { 'admission.json': '{}' } },
  // 声明了 policy，但文件不在包里
  policyMissing: { pack: { name: 'PolicyMissing', server: { preDispatch: { module: 'server/guard.mjs', policy: 'gone.json', intercepts: ['room.create'] } } }, files: { 'server/guard.mjs': GUARD_SOURCE } },
  // policy 不是 JSON 对象
  policyBad: { pack: { name: 'PolicyBad', server: { preDispatch: { module: 'server/guard.mjs', policy: 'admission.json', intercepts: ['room.create'] } } }, files: { 'server/guard.mjs': GUARD_SOURCE, 'admission.json': '[1,2,3]' } },
  // 模块没有工厂导出
  moduleNoFactory: { pack: { name: 'ModuleNoFactory', server: { preDispatch: { module: 'server/guard.mjs', policy: 'admission.json', intercepts: ['room.create'] } } }, files: { 'server/guard.mjs': 'export const nothing = 1;\n', 'admission.json': '{}' } },
  // ---- 模块自己对**策略内部形状**的自检（B 段的可选导出 `validatePolicy`）-------------------------------
  // 接受自己的策略 ⇒ 照旧装上
  policyOk: selfCheck('PolicyOk', 'return policy.version === "v1" ? { ok: true } : "version must be v1";', { version: 'v1' }),
  // 拒绝自己的策略 ⇒ 与「策略不是 JSON 对象」同一个结局：整包被裁掉
  policyRefused: selfCheck('PolicyRefused', 'return "files must list at least three urls";', { version: 'v1' }),
  // 返回一个**不认识的**判定（写成 {valid:false} 这种手误）⇒ 必须响亮拒绝，而不是当它通过
  policyTypo: selfCheck('PolicyTypo', 'return { valid: false };', { version: 'v1' }),
  // 抛异常 ⇒ 也算拒绝（装载期正是响亮拒绝该在的地方）
  policyThrows: selfCheck('PolicyThrows', 'throw new Error("boom");', { version: 'v1' }),
  // 一份普通的数据包（对照组：没有声明，装载器不该为它做任何事）
  plain: { pack: { name: 'Plain', content: ['chess'] }, files: { 'chess.json': JSON.stringify({ chess_ws_mod_a: { chessId: 'chess_ws_mod_a', name: 'x' } }) } },
};

/**
 * 一份「带 `validatePolicy` 自检」的准入包：模块 = 能用的准入模块 + 那段自检函数体。
 * @param {string} name @param {string} body `validatePolicy` 的函数体 @param {object} policy 包内那份策略文件的内容
 */
function selfCheck(name, body, policy) {
  return {
    pack: { name, server: { preDispatch: { module: 'server/guard.mjs', policy: 'admission.json', intercepts: ['room.create'] } } },
    files: {
      'server/guard.mjs': `${GUARD_SOURCE}\nexport function validatePolicy(policy) {\n  ${body}\n}\n`,
      'admission.json': JSON.stringify(policy),
    },
  };
}

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modpredispatch-'));
  wsRoot = join(tmp, 'ws');
  for (const [id, pack] of Object.entries(PACKS)) {
    const dir = join(wsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id, version: '0.1.0', license: 'CC0-1.0', ...pack.pack }));
    for (const [rel, body] of Object.entries(pack.files)) {
      const abs = join(dir, ...rel.split('/'));
      fs.mkdirSync(dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  }
  wsOnly = join(tmp, 'ws-only');
  fs.mkdirSync(wsOnly, { recursive: true });
  fs.cpSync(join(wsRoot, 'guard'), join(wsOnly, 'guard'), { recursive: true });
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const loadedOf = (dir = wsRoot, c2s = null) =>
  loadWorkshopHooks(loadWorkshop(dir, { log: quiet }), { log: quiet, ...(c2s ? { c2s } : {}) });
const hookFor = (hooks, pack) => hooks.find((h) => h.pack === pack);

// ---------------------------------------------------------------------------------------------------
// 1. 没有包声明 ⇒ 没有钩子
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch: 没有包声明 ⇒ 没有钩子、行为与基线逐字节相同', () => {
  test('createModDispatch 在没有任何钩子时返回 null（调用方据此不传那两个选项）', () => {
    const send = () => {};
    assert.equal(createModDispatch({ hooks: [], send, log: quiet }), null);
    assert.equal(createModDispatch({ hooks: null, send, log: quiet }), null);
    assert.equal(createModDispatch({ send, log: quiet }), null);
    assert.equal(createModDispatch(), null, '不传任何东西也不该抛');
    // 没有工厂函数的条目不算钩子（装载器不会产生这种条目，但装配层不该因此崩）
    assert.equal(createModDispatch({ hooks: [{ pack: 'a' }, null, {}], send, log: quiet }), null);
  });

  test('真实夹具：docs/examples 的三份示例包一份都没声明 server —— 装出来的 Network 与「完全没有这段代码」逐帧相同', async () => {
    const loaded = await loadedOf(EXAMPLES);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.hooks, [], '三份示例包都不声明 server.preDispatch');
    const messages = [
      { t: 'ping', c: 1, rid: 1 },
      { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', rid: 2 },
      { t: 'resource.proof', ...PROOF, rid: 3 },
      { t: 'resource.challenge.request', rid: 4 },
      { t: 'g.buy', slot: 0, rid: 5 },
      { t: 'nope', rid: 6 },
      { t: 'room.create', mode: 'nope', difficulty: 'NORMAL', rid: 7 },
    ];
    for (const msg of messages) {
      // 一份按装载器给的钩子（空）装配，一份完全不传选项：两条流水线必须吐出逐帧相同的回复
      const withLoader = stack({ hooks: loaded.hooks, handler: { onMessage: () => ({ ok: true }) } });
      const baseline = stack({ handler: { onMessage: () => ({ ok: true }) } });
      assert.equal(withLoader.dispatch, null);
      assert.equal(baseline.dispatch, null);
      const a = connect(withLoader.network);
      const b = connect(baseline.network);
      frame(withLoader.network, a.conn, msg);
      frame(baseline.network, b.conn, msg);
      assert.ok(a.sock.sent.length, `${msg.t} 应当有回复（否则这条对照没有意义）`);
      assert.deepEqual(a.sock.sent, b.sock.sent, `帧必须逐字节相同：${msg.t}`);
      withLoader.network.close();
      baseline.network.close();
    }
  });

  test('没有钩子时 resource.* 仍然过协议、照旧落到「hello required」（不是静默吞掉）', () => {
    let called = 0;
    const { network } = stack({ handler: { onMessage: () => { called += 1; } } });
    const { sock, conn } = connect(network);
    frame(network, conn, { t: 'resource.proof', ...PROOF, rid: 9 });
    assert.deepEqual(sock.sent, [{ t: 'error', code: 'BAD_MSG', msg: '无效的请求', rid: 9, detail: 'hello required' }]);
    assert.equal(called, 0);
    network.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 注入面：钩子能碰到什么、状态在哪里
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch: 注入面（隔离 / 确定性 / 改不了对局结果）', () => {
  test('依赖对象冻结，键**恰好**是那八个（没有 data / lobby / Match：注入改不了对局结果）', () => {
    const seen = [];
    const dispatch = createModDispatch({ hooks: [hookOf('p', (d) => { seen.push(d); return { preDispatch: () => false }; })], send: () => {}, log: quiet, now: () => 42 });
    dispatch.onConnection(new FakeSocket());
    assert.equal(seen.length, 1);
    const deps = seen[0];
    assert.deepEqual(Object.keys(deps).sort(), [...PRE_DISPATCH_DEPS].sort());
    for (const forbidden of ['data', 'lobby', 'registry', 'network', 'match', 'Match', 'sessions', 'rooms', 'battle', 'getData']) {
      assert.equal(forbidden in deps, false, `注入面里不得有 ${forbidden}`);
    }
    assert.equal(Object.isFrozen(deps), true);
    assert.equal(Object.isFrozen(deps.intercepts), true);
    assert.equal(Object.isFrozen(deps.policy), true);
    assert.equal(Object.isFrozen(deps.c2s), true, '协议目录是冻结副本：一个包改不动别的包看到的 C2S');
    assert.equal(deps.now(), 42, '时钟是注入的（包的逻辑不读全局时钟）');
    // 包改不动协议目录本身（改副本不影响真 C2S）
    const before = Object.keys(C2S).length;
    try { deps.c2s['evil.type'] = {}; } catch { /* 严格模式下给冻结对象赋值会抛 —— 两种结果都算过 */ }
    assert.equal(Object.keys(C2S).length, before);
    assert.equal(Object.hasOwn(C2S, 'evil.type'), false);
  });

  test('工厂**每个连接调用一次**（状态按连接隔离，多局并发不串味）', () => {
    let built = 0;
    const dispatch = createModDispatch({ hooks: [hookOf('p', () => { built += 1; return { preDispatch: () => false }; })], send: () => {}, log: quiet });
    const a = new FakeSocket();
    const b = new FakeSocket();
    dispatch.onConnection(a);
    dispatch.onConnection(a);
    dispatch.preDispatch(a, { t: 'ping', c: 1 });
    assert.equal(built, 1, '同一条连接只建一次');
    dispatch.onConnection(b);
    assert.equal(built, 2, '第二条连接各自一个实例');
  });

  test('调用次序按包 id 排序，与传入数组的顺序无关（确定性）', () => {
    const order = [];
    const mk = (pack) => hookOf(pack, () => ({ preDispatch: () => { order.push(pack); return false; } }));
    const dispatch = createModDispatch({ hooks: [mk('zeta'), mk('alpha'), mk('mid')], send: () => {}, log: quiet });
    assert.deepEqual(dispatch.packs, ['alpha', 'mid', 'zeta']);
    dispatch.preDispatch(new FakeSocket(), { t: 'ping', c: 1 });
    assert.deepEqual(order, ['alpha', 'mid', 'zeta']);
  });

  test('报告面：intercepts 是全部钩子的并集（去重排序，与 A 段的归一化同一口径）', () => {
    const dispatch = createModDispatch({
      hooks: [hookOf('a', () => ({ preDispatch: () => false }), ['room.join', 'room.create']), hookOf('b', () => ({ preDispatch: () => false }), ['room.create'])],
      send: () => {}, log: quiet,
    });
    assert.deepEqual(dispatch.intercepts, ['room.create', 'room.join']);
  });

  test('不注册第二个 socket.on("message")（那会双重分发：room.create / g.buy 是实打实的双执行）', () => {
    const { network } = stack({ hooks: [hookOf('guard', guardFactory(), ['room.create'])] });
    const sock = new FakeSocket();
    assert.equal(sock.listenerCount('message'), 0);
    network.handleConnection(sock, undefined);
    assert.equal(sock.listenerCount('message'), 1, '框架只注册自己那一个监听器 —— 钩子是被调用的，不抢帧');
    // 而且连接钩子确实跑了：挑战在连接建立时就发出去了
    assert.equal(sock.sent.filter((m) => m.t === 'resource.challenge').length, 1);
    network.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. 否决 / 放行 / rid
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch: 否决不进大厅、放行照常分发、回执带 rid', () => {
  test('否决：钩子消费掉消息，大厅一次都没被调用，回执带 rid', () => {
    const calls = [];
    const { network } = stack({ hooks: [hookOf('guard', guardFactory(), ['room.create'])], handler: { onMessage: (_s, msg) => { calls.push(msg.t); return { ok: true }; } } });
    const { sock, conn } = connect(network);
    frame(network, conn, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', rid: 7 });
    assert.deepEqual(calls, [], '被否决的 room.create 不得进大厅');
    const veto = sock.sent.find((m) => m.t === 'error');
    assert.ok(veto, JSON.stringify(sock.sent));
    assert.equal(veto.code, 'RESOURCE_REQUIRED');
    assert.equal(veto.rid, 7, '回执必须保留 rid（无 rid 的错误帧在客户端会弹红条）');
    network.close();
  });

  test('未命中 intercepts 的类型照常分发（钩子返回 false）', () => {
    const calls = [];
    const { network } = stack({ hooks: [hookOf('guard', guardFactory(), ['room.create'])], handler: { onMessage: (_s, msg) => { calls.push(msg.t); } } });
    const { sock, conn } = connect(network);
    // 先 hello（钩子对 hello 返回 false ⇒ 照常进入会话建立）
    frame(network, conn, { t: 'hello', name: 'Fake', version: 1, rid: 1 });
    assert.ok(sock.sent.some((m) => m.t === 'welcome'), JSON.stringify(sock.sent));
    frame(network, conn, { t: 'g.buy', slot: 0, rid: 8 });
    assert.deepEqual(calls, ['g.buy']);
    assert.deepEqual(sock.sent.filter((m) => m.t === 'error'), []);
    assert.deepEqual(sock.sent.filter((m) => m.t === 'ok'), [{ t: 'ok', rid: 8 }], '框架照旧回 ok（带 rid）');
    network.close();
  });

  test('intercepts 里的类型**放行**时也照常分发（闸门不是「声明了就永远不进大厅」）', () => {
    const calls = [];
    const { network } = stack({ hooks: [hookOf('guard', guardFactory(), ['room.create'])], handler: { onMessage: (_s, msg) => { calls.push(msg.t); return { ok: true }; } } });
    const { sock, conn } = connect(network);
    // 先按钩子自己的协议证明（resource.proof 不在 intercepts 里，但仍然到达钩子 —— 而且是在 hello 之前）
    frame(network, conn, { t: 'resource.proof', ...PROOF, rid: 1 });
    assert.ok(sock.sent.some((m) => m.t === 'resource.accepted' && m.rid === 1), JSON.stringify(sock.sent));
    frame(network, conn, { t: 'hello', name: 'Fake', version: 1, rid: 2 });
    frame(network, conn, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', rid: 3 });
    assert.deepEqual(calls, ['room.create'], '证明之后的 room.create 必须进大厅');
    network.close();
  });

  test('resource.challenge.request / resource.reset 也被钩子接住（三个类型都在总线上）', () => {
    const calls = [];
    const { network } = stack({ hooks: [hookOf('guard', guardFactory(), ['room.create'])], handler: { onMessage: (_s, msg) => { calls.push(msg.t); return { ok: true }; } } });
    const { sock, conn } = connect(network);
    frame(network, conn, { t: 'resource.challenge.request', rid: 1 });
    assert.equal(sock.sent.filter((m) => m.t === 'resource.challenge').length, 2, '连接时一次 + 请求时一次');
    frame(network, conn, { t: 'resource.reset', rid: 2 });
    assert.deepEqual(calls, []);
    network.close();
  });

  test('钩子抛异常：记一条 error、消息**不消费**（一个坏钩子不该把所有人的连接挡在门外）', () => {
    const errors = [];
    const log = { info() {}, warn() {}, error: (...a) => errors.push(a[0]), debug() {} };
    const dispatch = createModDispatch({ hooks: [hookOf('boom', () => ({ preDispatch: () => { throw new Error('boom'); } }), ['room.create'])], send: () => {}, log });
    const taken = dispatch.preDispatch(new FakeSocket(), { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(taken, false);
    assert.match(errors.join('\n'), /preDispatch\(room\.create\) crashed/);
  });

  test('工厂抛异常：那条连接上的这个钩子不存在，框架照常工作', () => {
    const errors = [];
    const log = { info() {}, warn() {}, error: (...a) => errors.push(a[0]), debug() {} };
    const dispatch = createModDispatch({ hooks: [hookOf('boom', () => { throw new Error('factory'); })], send: () => {}, log });
    dispatch.onConnection(new FakeSocket());
    assert.match(errors.join('\n'), /factory threw/);
    assert.equal(dispatch.preDispatch(new FakeSocket(), { t: 'ping', c: 1 }), false);
  });

  test('两条连接各自证明：一条放行不改另一条的闸门（按连接隔离）', () => {
    const calls = [];
    const { network } = stack({ hooks: [hookOf('guard', guardFactory(), ['room.create'])], handler: { onMessage: (_s, msg) => { calls.push(msg.t); return { ok: true }; } } });
    const a = connect(network);
    const b = connect(network);
    frame(network, a.conn, { t: 'resource.proof', ...PROOF, rid: 1 });
    assert.ok(a.sock.sent.some((m) => m.t === 'resource.accepted'));
    frame(network, a.conn, { t: 'hello', name: 'Fake', version: 1, rid: 4 });
    // A 证明过了，B 没有：B 的 room.create 被否决，A 的照进大厅
    frame(network, b.conn, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', rid: 2 });
    const veto = b.sock.sent.find((m) => m.t === 'error');
    assert.ok(veto && veto.rid === 2, JSON.stringify(b.sock.sent));
    frame(network, a.conn, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', rid: 3 });
    assert.deepEqual(a.sock.sent.filter((m) => m.t === 'error'), [], 'A 不该被 B 的未证明状态影响');
    assert.deepEqual(calls, ['room.create']);
    network.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. 协议面：三个 resource.* 类型
// ---------------------------------------------------------------------------------------------------
describe('resource.* 协议面（三个 C2S 类型 + 形状校验）', () => {
  test('三个类型都在 C2S 里，且形状按客户端证明算法判死', () => {
    for (const t of ['resource.proof', 'resource.challenge.request', 'resource.reset']) {
      assert.ok(Object.hasOwn(C2S, t), `${t} 必须在 C2S 里（否则消息在 :599 就被当非法类型拒了）`);
    }
    assert.equal(validateC2S({ t: 'resource.challenge.request' }), null);
    assert.equal(validateC2S({ t: 'resource.reset' }), null);
    assert.equal(validateC2S({ t: 'resource.proof', ...PROOF }), null);
    assert.equal(validateC2S({ t: 'resource.proof', ...PROOF, rid: 12 }), null);
  });

  test('形状不对的证明被点名拒绝（nonce / version / proofs 各一条）', () => {
    assert.match(validateC2S({ t: 'resource.proof', ...PROOF, nonce: 'a'.repeat(47) }) || '', /bad field nonce/);
    assert.match(validateC2S({ t: 'resource.proof', ...PROOF, nonce: 'A'.repeat(48) }) || '', /bad field nonce/);
    assert.match(validateC2S({ t: 'resource.proof', ...PROOF, version: 'b'.repeat(11) }) || '', /bad field version/);
    assert.match(validateC2S({ t: 'resource.proof', ...PROOF, proofs: ['c'.repeat(64)] }) || '', /bad field proofs/);
    assert.match(validateC2S({ t: 'resource.proof', ...PROOF, proofs: ['c'.repeat(64), 'd'.repeat(64), 'not-hex'] }) || '', /bad field proofs/);
    assert.match(validateC2S({ t: 'resource.proof', nonce: PROOF.nonce, version: PROOF.version }) || '', /bad field proofs/);
    // 额外字段被忽略（与其它类型同一条规则）
    assert.equal(validateC2S({ t: 'resource.proof', ...PROOF, extra: 1 }), null);
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. 装载期：坏声明点名拒绝（拒绝码沿用 A 段）
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch: 坏声明 ⇒ 整包被拒（B3a 段对齐，DESIGN §28.13.3）', () => {
  test('合法声明：模块与策略都被读到，intercepts 原样带来', async () => {
    const { hooks, errors } = await loadedOf();
    assert.deepEqual(errors.filter((e) => e.pack === 'guard'), [], '合法的那份声明不该出现在错误里');
    const guard = hookFor(hooks, 'guard');
    assert.ok(guard, hooks.map((h) => h.pack).join(','));
    assert.equal(guard.module, 'server/guard.mjs');
    assert.equal(guard.policyFile, 'admission.json');
    assert.deepEqual(guard.policy, { version: 'v1', files: ['a', 'b', 'c'] });
    assert.deepEqual(guard.intercepts, ['room.create', 'room.join']);
    assert.equal(typeof guard.create, 'function');
    // 没有声明的包不产生任何东西（对照组）
    assert.equal(hookFor(hooks, 'plain'), undefined);
  });

  test('三种**可同步判定**的坏声明让整个包不出现，理由里点名拒绝码（B3a 段：不再只拒那个钩子）', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const listed = loaded.packs.map((p) => p.id);
    assert.ok(listed.includes('guard'), listed.join(','));
    assert.ok(listed.includes('plain'), listed.join(','));
    // 以前这三种是「包照旧加载、只是钩子被拒」，现在整包不进 loaded.packs ——
    // 「加载了但能力没生效」是最坏的失败形态：服务器以为自己被准入闸门保护着，其实一条消息都没拦。
    for (const [pack, code] of [
      ['moduleMissing', 'PREDISPATCH_BAD_MODULE'],
      ['policyMissing', 'PREDISPATCH_BAD_POLICY'],
      ['policyBad', 'PREDISPATCH_BAD_POLICY'],
    ]) {
      assert.equal(listed.includes(pack), false, `${pack} 不得进 loaded.packs`);
      const err = loaded.errors.find((e) => e.pack === pack);
      assert.ok(err, `${pack}: 必须有具名错误（静默丢弃比报错坏得多）`);
      assert.match(err.reason, new RegExp(`^${code}: `), err.reason);
    }
  });

  test('`moduleNoFactory`（文件在、内容没有工厂导出）是**装载期看不出来**的那一条，装配路径把它裁掉', async () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    // 装载期的判据是「module / policy 是不是可读文件、policy 是不是 JSON 对象、intercepts 认不认识」。模块**内容**
    // 有没有 `createPreDispatch` 导出必须 import 才知道，而 `loadWorkshop` 是同步的（server/data.js 在叠数据时
    // 也调它），所以这一条留在 `loadWorkshopHooks`：**文件层面它合法**，装载器照旧列出它。
    // B4 段把最后这一格补上：`server/index.js` 在装配路径上（`loadWorkshopHooks` 之后、其余一切读者之前）用
    // `dropUnavailablePreDispatchPacks` 把这类包移出已加载集合并点名。这里同时钉住两半 —— 装载器照旧列出它
    // （文件合法），装配路径照旧裁掉它（能力不合法）——「声明了闸门却没有闸门」于是不再是一个能通过的结局。
    assert.ok(loaded.packs.some((p) => p.id === 'moduleNoFactory'), '文件层面它合法，所以装载器照旧列出它');
    assert.equal(loaded.errors.some((e) => e.pack === 'moduleNoFactory'), false);
    const { hooks, errors } = await loadWorkshopHooks(loaded, { log: quiet });
    assert.equal(hookFor(hooks, 'moduleNoFactory'), undefined);
    const err = errors.find((e) => e.pack === 'moduleNoFactory');
    assert.equal(err?.code, 'PREDISPATCH_BAD_MODULE');
    assert.match(err.reason, /createPreDispatch/);
    assert.match(err.reason, /the startup assembly path drops this pack/, '这条拒绝要说明自己为什么在这层、以及接下来会发生什么');
    const pruned = dropUnavailablePreDispatchPacks(loaded, errors);
    assert.deepEqual(pruned.removed.map((r) => r.pack).sort(),
      ['moduleNoFactory', 'policyRefused', 'policyThrows', 'policyTypo'],
      '装配路径要裁掉**每一个**装不上的包：没有工厂导出的那一个，加上三条被模块自己的 validatePolicy 拒掉的');
    assert.equal(pruned.packs.some((p) => p.id === 'moduleNoFactory'), false, '装配路径不得让它留在已加载集合里');
    assert.ok(pruned.errors.some((e) => e.pack === 'moduleNoFactory' && /^PREDISPATCH_BAD_MODULE: /.test(e.reason)),
      '裁剪必须是**点名**的：追加进 errors 的那一条带拒绝码');
    // 好的那几个照旧装上，也照旧留在集合里
    assert.deepEqual(hooks.map((h) => h.pack), ['guard', 'policyOk']);
    assert.deepEqual(pruned.packs.map((p) => p.id).sort(), ['guard', 'plain', 'policyOk']);
  });

  test('模块可选的 validatePolicy：接受 ⇒ 通过；拒绝 / 返回不认识的判定 / 抛异常 ⇒ 整包被裁掉', async () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    // 四种夹具在**文件层面**都合法 —— 这一格只有 `import` 之后才判得出来，所以装载期照旧列出它们
    for (const id of ['policyOk', 'policyRefused', 'policyTypo', 'policyThrows']) {
      assert.ok(loaded.packs.some((p) => p.id === id), `${id}: 文件层面合法，装载器照旧列出它`);
      assert.equal(loaded.errors.some((e) => e.pack === id), false, `${id}: 装载期不该有它的错误`);
    }
    const { hooks, errors } = await loadWorkshopHooks(loaded, { log: quiet });
    assert.ok(hookFor(hooks, 'policyOk'), 'validatePolicy 接受 ⇒ 钩子照旧装上');
    for (const id of ['policyRefused', 'policyTypo', 'policyThrows']) {
      assert.equal(hookFor(hooks, id), undefined, `${id} 不得装上`);
      const err = errors.find((e) => e.pack === id);
      assert.equal(err?.code, 'PREDISPATCH_BAD_POLICY', `${id}: ${JSON.stringify(errors)}`);
      assert.match(err.reason, /refused its own policy/);
      assert.match(err.reason, /the startup assembly path drops this pack/, '这条拒绝也要说明接下来会发生什么');
    }
    // 三种拒绝各自的理由都要**如实带出来**：作者看到的不是一句「策略不行」
    assert.match(errors.find((e) => e.pack === 'policyRefused').reason, /at least three urls/);
    assert.match(errors.find((e) => e.pack === 'policyTypo').reason, /unrecognised verdict/);
    assert.match(errors.find((e) => e.pack === 'policyThrows').reason, /validatePolicy threw: boom/);
  });

  test('没有导出 validatePolicy 的模块一个字节都不受影响（可选导出的 A 段口径：声明了才生效）', async () => {
    const { hooks, errors } = await loadedOf();
    const guard = hookFor(hooks, 'guard');
    assert.ok(guard, 'guard 没有导出 validatePolicy，照旧装上');
    assert.deepEqual(guard.policy, { version: 'v1', files: ['a', 'b', 'c'] });
    assert.equal(errors.some((e) => e.pack === 'guard'), false);
  });

  test('intercepts 按**运行时真的装着的协议**再判一次（声明可以比协议活得久）', async () => {
    // 注入一份少掉 room.create 的目录：包声明的 room.create 就是「协议不认识的名字」——装载期就整包拒绝
    const narrow = { ...C2S };
    delete narrow['room.create'];
    const rejected = loadWorkshop(wsRoot, { log: quiet, c2s: narrow });
    assert.equal(rejected.packs.some((p) => p.id === 'guard'), false, '一个拦不住的名字 = 整个包被拒（不静默丢掉那一条）');
    const err = rejected.errors.find((e) => e.pack === 'guard');
    assert.ok(err, JSON.stringify(rejected.errors));
    assert.match(err.reason, /^PREDISPATCH_UNKNOWN_TYPE: /);
    assert.match(err.reason, /room\.create/);
    // 对照：完整协议下同一个包是合法的
    assert.ok(loadWorkshop(wsRoot, { log: quiet }).packs.some((p) => p.id === 'guard'));
  });

  test('没有包 / 目录不存在时是空结果，不是错误（普通安装的正常情形）', async () => {
    const empty = await loadWorkshopHooks(loadWorkshop(join(tmp, 'nope'), { log: quiet }), { log: quiet });
    assert.deepEqual(empty, { hooks: [], errors: [] });
    assert.deepEqual(await loadWorkshopHooks(null, { log: quiet }), { hooks: [], errors: [] });
  });

  test('坏声明只报告、不抛（一个坏钩子不该让服务器起不来）', () => {
    const warned = [];
    const log = { info() {}, warn: (...a) => warned.push(a[0]), error() {}, debug() {} };
    loadWorkshop(wsRoot, { log });
    assert.ok(warned.some((w) => /PREDISPATCH_BAD_MODULE/.test(w)), warned.join('\n'));
    assert.ok(warned.some((w) => /PREDISPATCH_BAD_POLICY/.test(w)), warned.join('\n'));
  });
});

// ---------------------------------------------------------------------------------------------------
// 6. 端到端：真服务器 + 真 ws
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch 端到端（真 HTTP + 真 WebSocket）', () => {
  test('连接时收到挑战 → 证明前 room.create 被否决（带 rid）→ 证明后可进房间；另一条连接仍被拦', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsOnly });
    const url = `ws://127.0.0.1:${srv.port}`;
    const proven = await TestClient.connect(`${url}/ws`);
    const unproven = await TestClient.connect(`${url}/ws`);
    try {
      // 连接建立时（hello 之前）就发挑战：onConnection 那一半
      const challenge = await proven.waitFor('resource.challenge');
      assert.equal(challenge.nonce, PROOF.nonce);
      assert.deepEqual(challenge.files, ['a', 'b', 'c']);
      await unproven.waitFor('resource.challenge');

      // 未证明 ⇒ 否决，且回执带 rid（client.request 靠这个 rid 才能等到回复）
      const veto = await unproven.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
      assert.equal(veto.t, 'error');
      assert.equal(veto.code, 'RESOURCE_REQUIRED');
      assert.equal(typeof veto.rid, 'number');

      // 证明（hello 之前到达 —— 这正是钩子必须在会话检查之前的原因）
      const proofRid = proven.send({ t: 'resource.proof', ...PROOF });
      const accepted = await proven.waitFor('resource.accepted', (m) => m.rid === proofRid);
      assert.equal(accepted.rid, proofRid);

      // 证明之后进门：hello → room.create → 大厅（modded 房间要客户端回话摘要，DESIGN §28.2）
      const welcome = await proven.hello('Proven');
      const digest = welcome.mods?.digest;
      assert.equal(typeof digest, 'string', '装了包就应当有摘要，客户端要回话它');
      const opened = await proven.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest });
      assert.equal(opened.t, 'ok', JSON.stringify(opened));
      const state = await proven.waitFor('room.state');
      assert.equal(typeof state.code, 'string', '房间确实开出来了');

      // 另一条连接（未证明）仍然被拦：连接之间不共享闸门状态
      const again = await unproven.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest });
      assert.equal(again.code, 'RESOURCE_REQUIRED');

      // 坏形状的证明在协议层就被拒（不会到钩子）
      const bad = await proven.request({ t: 'resource.proof', nonce: 'x', version: PROOF.version, proofs: PROOF.proofs });
      assert.equal(bad.code, 'BAD_MSG');
      assert.match(String(bad.detail), /bad field nonce/);
    } finally {
      await proven.close();
      await unproven.close();
      await srv.close();
    }
  });

  test('没有包声明钩子时，同一个服务器上 resource.proof 落到「hello required」（协议认识它，但没人处理）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: null });
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    try {
      const reply = await client.request({ t: 'resource.proof', ...PROOF });
      assert.equal(reply.t, 'error');
      assert.equal(reply.code, 'BAD_MSG');
      assert.equal(reply.detail, 'hello required');
    } finally {
      await client.close();
      await srv.close();
    }
  });
});
