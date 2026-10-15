// test/roomConsent.test.js — 房间同意 + 服主 pin（W7, DESIGN §28.53）。
//
// 我们今天的信任压在「审查 + 作者自觉」上：客户端回一个摘要（`checkModSet`）就算表态，而**房间自己声明的那一份**
// 连一句话都没有 —— 一位博士可以在一句提示都没看到的情况下进到一个跑别人写的战斗逻辑的房间里。上游的做法是
// **每名真人必须明确同意**，加上**服主按 SHA-256 把字节钉住**（变了就按既有守卫拒）。本文件钉那四件事：
//
//   ① **真人未同意 ⇒ 进不去 / 不能开始**：进房（`room.join`）与开局（`room.start`）各有一道，都点名到
//      `MOD_CONSENT_REQUIRED`，而且 detail 里点出这一房声明了哪几个包。
//   ② **同意后照常**：带 `consent: true` 进得去，重新表态之后开得了局；房主不受这条约束（他钉下这一份字节就是
//      他的表态）。
//   ③ **pin 的字节指纹变了 ⇒ 按既有守卫拒**：包被换了（同一 id、另一个 hash）走 `MOD_SET_LOCKED`；包没了走
//      `MOD_UNKNOWN` —— 两个码都是这台机器上**早就存在**的那两道，没有造第二套。
//   ④ **不声明模组的房间逐字节等于今天**：`room.state` 不带 `mods`，`room.join` 只发 `{ code }`，开局不加任何
//      字段。
//
// 另外单独一节钉**客户端那条链路**（业主加严：不许只留 UI 手工步骤）：「服务端拒绝 ⇒ 照 detail 问一次 ⇒ 带
// `consent: true` 重发」。它跑的是**真的浏览器客户端**（`public/js/net.js` + `public/js/roomMods.js`，只把 socket
// 换成假的），打的是**真的服务器** —— 所以「重发什么」这件事是被判过的代码，不是一句注释。
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { modSetOf, modSetDrift } from '../shared/modIdentity.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR, ERR_TEXT } from '../shared/constants.js';
import { Net } from '../public/js/net.js';
import * as roomMods from '../public/js/roomMods.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const MODDED = 'alpha-pack';

/** A minimal layer-A pack: one new operator record, no code. */
function writePack(root, id, name) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name, version: '0.1.0', content: ['chess'], overrides: [] }));
  const chessId = `chess_ws_${id.replace(/-/g, '_')}_a`;
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({
    [chessId]: {
      chessId, baseId: chessId, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE',
      rangeGrid: [[0, 0]], stats: { maxHp: 2000, atk: 500, def: 200, res: 0, cost: 18, blockCnt: 2, bat: 1.2 }, talents: [], bonds: [],
    },
  }));
  return chessId;
}

/** A layer-B pack (declares a kit ⇒ `combat: true`): a second id, so a set can be CHANGED, not just emptied. */
function writeCombatPack(root, id, name) {
  const chessId = writePack(root, id, name);
  fs.mkdirSync(path.join(root, id, 'kits'), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'kits', `${chessId}.js`), 'export default () => ({});\n');
  return chessId;
}

const wsUrl = (srv) => `ws://127.0.0.1:${srv.port}/ws`;

/** Connect + hello, keeping the playerId on the client (test/helpers/wsClient.js leaves that to the caller). */
async function player(server, name) {
  const c = await TestClient.connect(wsUrl(server));
  const welcome = await c.hello(name);
  c.id = welcome.playerId;
  c.welcome = welcome;
  return c;
}

/** A WebSocket stand-in: records what the client sends, and delivers frames the test hands it. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    /** frames waiting to be pumped upstream */
    this.outbox = [];
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(text) { const msg = JSON.parse(text); this.outbox.push(msg); }
  /** Deliver a server frame to the client. */
  deliver(msg) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(msg) })); }
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000, reason: 'test' })); }
}

/**
 * The real browser client on a real server, with only its socket faked (the same harness `test/roomModSet.test.js`
 * uses — this file needs it too, because the chain it judges is exactly the one that runs in the browser).
 * @param {any} server @param {string} name
 * @returns {Promise<{ net: Net, ws: FakeSocket, welcome: any, close: () => Promise<void> }>}
 */
async function browserClient(server, name) {
  const upstream = await TestClient.connect(wsUrl(server));
  let socket = null;
  const net = new Net({
    url: wsUrl(server),
    WebSocket: function Fake(url) { return (socket = new FakeSocket(url)); },
    getToken: () => null,
  });
  let running = true;
  const own = new Set();
  const pump = (async () => {
    while (running) {
      const s = socket;
      if (s && s.outbox.length) {
        const msg = s.outbox.shift();
        const rid = upstream.send(msg);
        own.add(rid);
        const reply = await upstream.waitFor(null, (m) => m.rid === rid, 2000).catch(() => null);
        own.delete(rid);
        if (reply && s === socket) s.deliver(reply);
        continue;
      }
      const push = await upstream.waitFor(null, (m) => m.rid == null || !own.has(m.rid), 50).catch(() => null);
      if (push && socket) socket.deliver(push);
    }
  })();
  pump.catch(() => {});
  let welcome = null;
  net.on('welcome', (msg) => { welcome = msg; });
  net.setName(name);
  net.connect();
  const deadline = Date.now() + 4000;
  while (!welcome && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!welcome) throw new Error('browser client never got a welcome');
  const close = async () => {
    running = false;
    net.close();
    await upstream.terminate().catch(() => {});
    await pump.catch(() => {});
  };
  return { net, ws: socket, welcome, close };
}

/** The `room.state` push a `room.create` triggers, registered before the request so it cannot be missed. */
async function createRoom(c, payload) {
  const stateP = c.waitFor('room.state', (s) => s.code, 2000);
  const reply = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', ...payload });
  assert.equal(reply.t, 'ok', `room.create refused: ${JSON.stringify(reply)}`);
  return stateP;
}

let tmp;
let modded;
let driftSrv;
let vanilla;
let digest;
let packs;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-consent-'));
  const root = path.join(tmp, 'workshop');
  fs.mkdirSync(root, { recursive: true });
  writePack(root, MODDED, 'Alpha');
  writeCombatPack(root, 'zeta-pack', 'Zeta');
  fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
  packs = loadWorkshop(root, { log: quiet }).packs;
  digest = modSetOf(packs.map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }))).digest;
  modded = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
  // 「包被换了一版」要用**另一台服务器**来模拟：`server/lobby.js modPinRefusal` 读的是这一进程装载的那份
  // `workshop.mods`，所以在这台机上换掉那个包自己的 hash，就是「同一 id、另一份字节」这件事本身。
  driftSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
  vanilla = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: path.join(tmp, 'empty') });
});
after(async () => {
  await modded?.close();
  await driftSrv?.close();
  await vanilla?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => { roomMods.reset(); });

// ---------------------------------------------------------------------------------------------------
// ① 真人未同意 ⇒ 进不去 / 不能开始
// ---------------------------------------------------------------------------------------------------
describe('判据①：真人未同意 ⇒ 进不去 / 不能开始', () => {
  test('进房：没带 consent 就是 MOD_CONSENT_REQUIRED，detail 点出这一房声明的包', async () => {
    const host = await player(modded, 'Host');
    const guest = await player(modded, 'Guest');
    try {
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });
      assert.ok(state.mods, '这一房必须真的声明了集合，否则这条判据什么也没验');
      const refused = await guest.request({ t: 'room.join', code: state.code, mods: digest });
      assert.equal(refused.t, 'error');
      assert.equal(refused.code, ERR.MOD_CONSENT_REQUIRED, `没同意必须被拒，实际：${JSON.stringify(refused)}`);
      assert.match(String(refused.detail || ''), new RegExp(MODDED),
        'detail 必须点出这一房声明的包 —— 客户端就是拿这串名字去问玩家的');
      // 拒绝**没有**占座位：再来一次带同意的必须成功（不是「拒了但人已经坐在里面」）
      const room = modded.lobby.rooms.get(state.code);
      assert.equal(room.seats.filter((s) => s && !s.isBot).length, 1, '没同意的人不许占座位');
      assert.equal(ERR_TEXT.MOD_CONSENT_REQUIRED.length > 0, true, '这个码必须有给玩家看的一句话');
    } finally { await host.terminate(); await guest.terminate(); }
  });

  test('不能开始：集合中途改过之后，已经在座的人必须重新表态', async () => {
    const host = await player(modded, 'Host');
    const guest = await player(modded, 'Guest');
    try {
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });
      assert.equal((await guest.request({ t: 'room.join', code: state.code, mods: digest, consent: true })).t, 'ok');
      // 房主改集合（G1 的窗口：没有真人已就绪）⇒ 所有人的同意作废（他们同意的是**旧的那一份字节**）
      assert.equal((await host.request({ t: 'room.mods', modIds: [MODDED, 'zeta-pack'] })).t, 'ok');
      // 客人重新就绪（他的客户端对齐过新文件），但他**还没对新集合表过态**
      assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
      const refused = await host.request({ t: 'room.start' });
      assert.equal(refused.t, 'error');
      assert.equal(refused.code, ERR.MOD_CONSENT_REQUIRED, `未同意就不许开局，实际：${JSON.stringify(refused)}`);
      assert.match(String(refused.detail || ''), /Guest/, '一句「还有人没同意」在 4 人房里等于没说，必须点名到人');
      // 重新表态（幂等 join 也是补同意的那条通道）⇒ 照常开得了局
      assert.equal((await guest.request({ t: 'room.join', code: state.code, mods: digest, consent: true })).t, 'ok');
      assert.equal((await host.request({ t: 'room.start' })).t, 'ok', '重新表态之后必须开得了局');
    } finally { await host.terminate(); await guest.terminate(); }
  });

  test('观战者不需要同意（他没有玩家座位，也不跑这一房的内容）', async () => {
    const host = await player(modded, 'Host');
    const watcher = await player(modded, 'Watcher');
    try {
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });
      const r = await watcher.request({ t: 'room.spectate', code: state.code });
      assert.equal(r.t, 'ok', `观战不该被同意这道判据挡住：${JSON.stringify(r)}`);
    } finally { await host.terminate(); await watcher.terminate(); }
  });
});

// ---------------------------------------------------------------------------------------------------
// ② 同意后照常
// ---------------------------------------------------------------------------------------------------
describe('判据②：同意后照常，房主不受这条约束', () => {
  test('带 consent: true 进得去；房主从没发过 consent 也能开局', async () => {
    const host = await player(modded, 'Host');
    const guest = await player(modded, 'Guest');
    try {
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });
      assert.equal((await guest.request({ t: 'room.join', code: state.code, mods: digest, consent: true })).t, 'ok');
      assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
      // 房主：`room.create` 报出的 modIds 就是他钉下的这一份字节 ⇒ 他的座位在 create 那一刻就已经「表态」过了
      assert.equal((await host.request({ t: 'room.start' })).t, 'ok', '房主对自己钉下的那份集合不必再点一次同意');
    } finally { await host.terminate(); await guest.terminate(); }
  });
});

// ---------------------------------------------------------------------------------------------------
// ③ pin 的字节指纹变了 ⇒ 按既有守卫拒
// ---------------------------------------------------------------------------------------------------
describe('判据③：服主 pin 的字节指纹变了', () => {
  test('包被换了一版 ⇒ MOD_SET_LOCKED，且点出是哪个包', async () => {
    const host = await player(driftSrv, 'Host');
    const guest = await player(driftSrv, 'Guest');
    const before = driftSrv.lobby.workshop.mods;
    try {
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });
      // 「同一 id、另一份字节」：装载器从不产出空 hash，所以这一格就是换包这件事本身。
      driftSrv.lobby.workshop.mods = before.map((p) => (p.id === MODDED ? { ...p, hash: 'f'.repeat(64) } : p));
      const refused = await guest.request({ t: 'room.join', code: state.code, mods: digest, consent: true });
      assert.equal(refused.t, 'error');
      assert.equal(refused.code, ERR.MOD_SET_LOCKED, `字节变了必须按既有守卫拒，实际：${JSON.stringify(refused)}`);
      assert.match(String(refused.detail || ''), new RegExp(MODDED), '必须点出是哪个包的字节变了');
      // 开局那一道也拦（不是只有 join）
      const hostRefused = await host.request({ t: 'room.start' });
      assert.equal(hostRefused.t, 'error');
      assert.equal(hostRefused.code, ERR.MOD_SET_LOCKED, `开局那一道也要拦，实际：${JSON.stringify(hostRefused)}`);
    } finally {
      driftSrv.lobby.workshop.mods = before;
      await host.terminate(); await guest.terminate();
    }
  });

  test('包没了 ⇒ MOD_UNKNOWN（那句「本服务器没有这个包」本来就是这件事）', async () => {
    const host = await player(driftSrv, 'Host2');
    const guest = await player(driftSrv, 'Guest2');
    const before = driftSrv.lobby.workshop.mods;
    try {
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });
      driftSrv.lobby.workshop.mods = before.filter((p) => p.id !== MODDED);
      const refused = await guest.request({ t: 'room.join', code: state.code, mods: digest, consent: true });
      assert.equal(refused.t, 'error');
      assert.equal(refused.code, ERR.MOD_UNKNOWN, `包没了走既有的 MOD_UNKNOWN，实际：${JSON.stringify(refused)}`);
      assert.match(String(refused.detail || ''), new RegExp(MODDED));
    } finally {
      driftSrv.lobby.workshop.mods = before;
      await host.terminate(); await guest.terminate();
    }
  });

  test('判据本身只有一份（shared/modIdentity.js modSetDrift），两种漂移各报各的', () => {
    const pinned = { digest, packs: packs.map((p) => ({ id: p.id, hash: p.hash })) };
    assert.deepEqual(modSetDrift(pinned, packs), { ok: true, missing: [], changed: [] }, '一致时什么都不报');
    const swapped = packs.map((p) => (p.id === MODDED ? { ...p, hash: 'a'.repeat(64) } : p));
    const d = modSetDrift(pinned, swapped);
    assert.equal(d.ok, false);
    assert.deepEqual(d.missing, []);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].id, MODDED);
    assert.equal(d.changed[0].now, 'a'.repeat(64));
    const gone = modSetDrift(pinned, packs.filter((p) => p.id !== MODDED));
    assert.deepEqual(gone.missing, [MODDED]);
    assert.deepEqual(gone.changed, []);
    assert.equal(modSetDrift(null, []).ok, true, '没声明集合的房间这一格整条不适用');
  });
});

// ---------------------------------------------------------------------------------------------------
// ④ 不声明模组的房间逐字节等于今天
// ---------------------------------------------------------------------------------------------------
describe('判据④：不声明模组的房间逐字节等于今天', () => {
  test('modded 服务器上「不声明集合」的房：state 不带 mods，join 不需要同意', async () => {
    const host = await player(modded, 'Host');
    const guest = await player(modded, 'Guest');
    try {
      const state = await createRoom(host, { mods: digest });     // 没有 modIds ⇒ 不声明集合
      assert.equal(Object.hasOwn(state, 'mods'), false, 'room.state 不带 mods（今天的形状）');
      const r = await guest.request({ t: 'room.join', code: state.code, mods: digest });
      assert.equal(r.t, 'ok', `没有声明集合的房间不该要同意：${JSON.stringify(r)}`);
      assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
      assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    } finally { await host.terminate(); await guest.terminate(); }
  });

  test('纯安装：join 载荷与开局帧都没有新字段', async () => {
    roomMods.reset();
    assert.deepEqual(roomMods.buildJoinPayload('ABCD'), { code: 'ABCD' }, '没有模组的服务器上 join 就是 { code }');
    assert.deepEqual(roomMods.buildJoinPayload('ABCD', { consent: true }), { code: 'ABCD' },
      '同意这条通道在纯安装上根本不存在 —— 它不许凭空长出一个字段');
    const c = await player(vanilla, 'Plain');
    try {
      assert.equal(c.welcome.mods, undefined, '纯安装的 welcome 没有 mods 键');
      const state = await createRoom(c, {});
      assert.equal(Object.hasOwn(state, 'mods'), false);
      assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
    } finally { await c.terminate(); }
  });

  test('线上形状：consent 只认 true（形状层就是那一份判据）', () => {
    const code = 'ABCDEF';
    assert.equal(validateC2S({ t: 'room.join', code }), null, '老客户端不发这一格 ⇒ 仍然合法');
    assert.equal(validateC2S({ t: 'room.join', code, consent: true }), null);
    assert.equal(validateC2S({ t: 'room.join', code, consent: null }), null, '显式 null = 没同意（形状层收，语义层拦）');
    assert.ok(validateC2S({ t: 'room.join', code, consent: 'yes' }), '字符串不是表态 ⇒ 点名拒');
    assert.ok(validateC2S({ t: 'room.join', code, consent: false }), 'false 不是这一格的取值：不发就是没同意');
  });
});

// ---------------------------------------------------------------------------------------------------
// 客户端那条链路：拒绝 ⇒ 照 detail 问一次 ⇒ 带 consent 重发（真 Net + 真 roomMods + 真服务器）
// ---------------------------------------------------------------------------------------------------
describe('客户端链路：拒绝 ⇒ 问一次 ⇒ 带 consent 重发', () => {
  test('同一个房间：第一次被拒、同意之后进得去；不是那条拒绝就不重发', async () => {
    const host = await player(modded, 'Host');
    const c = await browserClient(modded, 'ChainClient');
    try {
      roomMods.setWelcomeMods(c.welcome);                        // exactly what main.js onWelcome does
      const state = await createRoom(host, { mods: digest, modIds: [MODDED] });

      const payload = roomMods.buildJoinPayload(state.code);
      assert.equal(Object.hasOwn(payload, 'consent'), false, '第一次必须**不带**同意（旧客户端就是这一条）');
      assert.equal(validateC2S({ t: 'room.join', ...payload }), null);

      let refusal = null;
      try { await c.net.request('room.join', payload); } catch (err) { refusal = err; }
      assert.ok(refusal, '没同意必须被服务端拒');
      assert.equal(refusal.code, ERR.MOD_CONSENT_REQUIRED);
      assert.match(String(refusal.detail || ''), new RegExp(MODDED), 'detail 里带着玩家要同意的那串包名');

      // 「重发什么」由这一处决定（三个屏幕共用），所以它必须真的被判：链路的判据就是它。
      const retry = roomMods.consentRetryPayload(refusal, state.code);
      assert.deepEqual(retry, { code: state.code, mods: digest, consent: true });
      assert.equal(validateC2S({ t: 'room.join', ...retry }), null, '重发的载荷本身必须过协议校验');
      assert.equal((await c.net.request('room.join', retry)).t, 'ok', '同意之后必须进得去');

      // 不是那条拒绝 ⇒ 不重发（否则任何错误都会被一次静默重试吞掉）
      assert.equal(roomMods.consentRetryPayload({ code: ERR.NOT_READY }, state.code), null);
      assert.equal(roomMods.consentRetryPayload(null, state.code), null);
    } finally {
      await c.close();
      await host.terminate();
    }
  });
});
