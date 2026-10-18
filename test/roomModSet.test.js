// test/roomModSet.test.js — a room's own mod set (W-A, DESIGN §28.9): what the CLIENT actually puts on the wire, what
// the server does with `room.create.modIds`, and the fact that the entry gate still judges the PROCESS set.
//
// Two rules this file exists to keep honest:
//
//   * A source-text assertion ("the client sends `mods`") proves nothing — the file could be broken and the string still
//     there. So the client half drives the REAL client module (`public/js/roomMods.js`) and the REAL transport
//     (`public/js/net.js`, with only its socket replaced by a fake that forwards to a real server) and asserts on the
//     message objects that came out of the socket.
//   * W-A does NOT make a room's declared set decide what the simulation runs. That is W-B. The last describe block pins
//     today's behaviour so the change cannot happen accidentally: when W-B lands, those assertions MUST be rewritten on
//     purpose.
//
// ▸ W7（DESIGN §28.53）**故意改写了本文件里的 join**：进一个**声明了集合**的房间要**每名真人明确同意**，所以这些
//   夹具里「客人进房」的那几处都显式带上 `consent: true`。这不是把判据放松 —— 新的一格由 `test/roomConsent.test.js`
//   正面钉住（未同意 ⇒ `MOD_CONSENT_REQUIRED`，未必同意先占座位），这里只是让既有夹具表达「这个人同意了」。
//   `room.create` 那几处一个字没动：房主 `modIds` 就是他钉下的这一份字节，他的座位在 create 那一刻就已经表态。
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { modSetOf } from '../shared/modIdentity.js';
import { validateC2S, C2S, MAX_ROOM_MODS } from '../shared/protocol.js';
import { ERR, ERR_TEXT } from '../shared/constants.js';
import { Net } from '../public/js/net.js';
import * as roomMods from '../public/js/roomMods.js';
import { runSoloPlaytest } from '../public/js/playtestLink.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A minimal layer-A pack: one new operator record, no code. */
function writePack(root, id, name) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name, version: '0.1.0', content: ['chess'], overrides: [] }));
  const chessId = `chess_ws_${id.replace(/-/g, '_')}_a`;
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({ [chessId]: { chessId, baseId: chessId, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 2000, atk: 500, def: 200, res: 0, cost: 18, blockCnt: 2, bat: 1.2 }, talents: [], bonds: [] } }));
  return chessId;
}

/** A layer-B pack (declares a kit ⇒ `combat: true`): its entry must carry that flag to the client. */
function writeCombatPack(root, id, name) {
  const chessId = writePack(root, id, name);
  fs.mkdirSync(path.join(root, id, 'kits'), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'kits', `${chessId}.js`), 'export default () => ({});\n');
  return chessId;
}

// ---------------------------------------------------------------------------------------------------
// The client transport, driven for real: the real Net + the real roomMods, one fake socket.
// ---------------------------------------------------------------------------------------------------

/** A WebSocket stand-in: records what the client sends, and delivers frames the test hands it. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    /** frames waiting to be pumped upstream */
    this.outbox = [];
    /** every frame the client ever sent (never consumed — what the assertions read) */
    this.sent = [];
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(text) {
    const msg = JSON.parse(text);
    this.sent.push(msg);
    this.outbox.push(msg);
  }
  /** Deliver a server frame to the client. */
  deliver(msg) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(msg) })); }
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000, reason: 'test' })); }
}

/**
 * The real browser client on a real server, with only its socket faked. Resolves once it is `online` (after the real
 * `hello` → `welcome` exchange), and gives back the socket plus the welcome frame it received.
 *
 * The pump is deliberately dumb: every frame the client sends goes upstream on a fresh rid, and every frame that comes
 * back down (a reply to one of those rids, or a push like `room.state`) is delivered to the client. The client's own
 * rid is never reused, because the test transport assigns its own (test/helpers/wsClient.js).
 * @param {any} server a started server
 * @param {string} name
 * @returns {Promise<{ net: Net, ws: FakeSocket, welcome: any, close: () => Promise<void> }>}
 */
async function browserClient(server, name) {
  const upstream = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
  let socket = null;
  const net = new Net({
    url: `ws://127.0.0.1:${server.port}/ws`,
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
  pump.catch((err) => { console.error('[roomModSet] pump failed', err); });
  let welcome = null;
  net.on('welcome', (msg) => { welcome = msg; });
  net.setName(name);
  net.connect();
  const deadline = Date.now() + 3000;
  while (net.status !== 'online' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(net.status, 'online', 'the fake-socket client reached online');
  const close = async () => {
    running = false;
    net.close();
    await upstream.terminate().catch(() => {});
    await pump.catch(() => {});
  };
  return { net, ws: socket, welcome, close };
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

/** The next frame of `type` matching `predicate` on a real client's push channel, or a rejection after `timeout`. */
function nextFrame(net, type, predicate = () => true, timeout = 2000) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${type}`)); }, timeout);
    off = net.on(type, (msg) => {
      if (!predicate(msg)) return;
      clearTimeout(timer);
      off();
      resolve(msg);
    });
  });
}

let tmp;
let modded;
let vanilla;
let digest;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-roommod-'));
  const root = path.join(tmp, 'workshop');
  fs.mkdirSync(root, { recursive: true });
  writePack(root, 'alpha-pack', 'Alpha');
  writeCombatPack(root, 'zeta-pack', 'Zeta');
  fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
  modded = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
  vanilla = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: path.join(tmp, 'empty') });
  digest = modSetOf(loadWorkshop(root, { log: quiet }).packs
    .map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }))).digest;
});
after(async () => {
  await modded?.close();
  await vanilla?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => { roomMods.reset(); });

describe('P0: the real client sends the mod digest (a browser could not enter a room on a modded server)', () => {
  test('on a modded server the client sends `mods` in room.create and room.join; the server accepts both', async () => {
    const c = await browserClient(modded, 'ModClient');
    try {
      assert.ok(c.welcome.mods, `welcome carried mods: ${JSON.stringify(c.welcome).slice(0, 200)}`);
      assert.equal(c.welcome.mods.digest, digest);
      roomMods.setWelcomeMods(c.welcome);           // exactly what main.js onWelcome does
      assert.equal(roomMods.currentModSet().digest, digest);

      const create = roomMods.buildCreatePayload('coop', 'NORMAL');
      assert.deepEqual(create, { mode: 'coop', difficulty: 'NORMAL', mods: digest });
      assert.equal(validateC2S({ t: 'room.create', ...create }), null, 'the payload the transport will send is valid C2S');

      // the room.state push the create triggers is registered for BEFORE the request, so it cannot be missed
      const stateP = nextFrame(c.net, 'room.state', (s) => s.code);
      assert.equal((await c.net.request('room.create', create)).t, 'ok');
      const state = await stateP;
      assert.equal(state.t, 'room.state');

      const join = roomMods.buildJoinPayload(state.code);
      assert.deepEqual(join, { code: state.code, mods: digest });
      assert.equal((await c.net.request('room.join', join)).t, 'ok', 'the host is already in it: idempotent for members');

      // …and both fields really were on the wire (the socket recorded the message objects, not the source text)
      const sentCreate = c.ws.sent.find((m) => m.t === 'room.create');
      const sentJoin = c.ws.sent.find((m) => m.t === 'room.join');
      assert.deepEqual({ ...sentCreate, rid: undefined }, { t: 'room.create', rid: undefined, mode: 'coop', difficulty: 'NORMAL', mods: digest });
      assert.deepEqual({ ...sentJoin, rid: undefined }, { t: 'room.join', rid: undefined, code: state.code, mods: digest });
      assert.equal(typeof sentCreate.rid, 'number', 'the real transport added a rid');
    } finally {
      await c.close();
    }
  });

  test('on a plain install the client sends NO mods field at all (the default must not change)', async () => {
    const c = await browserClient(vanilla, 'PlainClient');
    try {
      assert.equal(c.welcome.mods, undefined, 'a plain install has no `mods` key');
      roomMods.setWelcomeMods(c.welcome);
      assert.equal(roomMods.hasMods(), false);
      const create = roomMods.buildCreatePayload('solo', 'NORMAL');
      assert.deepEqual(create, { mode: 'solo', difficulty: 'NORMAL' }, 'no mods, no modIds, no empty object');
      assert.equal((await c.net.request('room.create', create)).t, 'ok');
      const sent = c.ws.sent.find((m) => m.t === 'room.create');
      assert.equal('mods' in sent, false);
      assert.equal('modIds' in sent, false);
      assert.deepEqual(Object.keys(sent).sort(), ['difficulty', 'mode', 'rid', 't']);
      const join = roomMods.buildJoinPayload('ABCD');
      assert.deepEqual(join, { code: 'ABCD' });
      assert.equal(validateC2S({ t: 'room.join', ...join }), null);
    } finally {
      await c.close();
    }
  });

  test('the host\'s picks ride along as modIds, and only ids the server declared survive', () => {
    roomMods.setWelcomeMods({ mods: { digest, packs: [
      { id: 'alpha-pack', hash: 'a'.repeat(64), layer: 'A', combat: false },
      { id: 'zeta-pack', hash: 'b'.repeat(64), layer: 'B', combat: true },
    ] } });
    assert.deepEqual(roomMods.availableMods().map((p) => p.id), ['alpha-pack', 'zeta-pack']);
    assert.deepEqual(roomMods.setSelectedModIds(['zeta-pack', 'alpha-pack']), ['alpha-pack', 'zeta-pack'], 'kept sorted');
    assert.deepEqual(roomMods.buildCreatePayload('coop', 'NORMAL'), { mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack', 'zeta-pack'] });
    // a stale pick (the server restarted with fewer packs) is dropped rather than sent to be refused
    assert.deepEqual(roomMods.setSelectedModIds(['alpha-pack', 'gone-pack']), ['alpha-pack']);
    assert.deepEqual(roomMods.buildCreatePayload('coop', 'NORMAL').modIds, ['alpha-pack']);
    // unticking everything is the same message as never ticking: no modIds
    assert.deepEqual(roomMods.setSelectedModIds([]), []);
    assert.deepEqual(roomMods.buildCreatePayload('coop', 'NORMAL'), { mode: 'coop', difficulty: 'NORMAL', mods: digest });
    // and a server that changed under us drops the picks
    roomMods.setSelectedModIds(['alpha-pack']);
    assert.equal(roomMods.setWelcomeMods({ mods: { digest: 'f'.repeat(64), packs: [{ id: 'other-pack', hash: 'c'.repeat(64), layer: 'A', combat: false }] } }), false);
    assert.deepEqual(roomMods.getSelectedModIds(), []);
    assert.deepEqual(roomMods.buildCreatePayload('coop', 'NORMAL'), { mode: 'coop', difficulty: 'NORMAL', mods: 'f'.repeat(64) });
  });
});

describe('room.create { modIds } declares the room set (W-A, DESIGN §28.9)', () => {
  test('room.state carries { digest, packs } — sorted by id, digest recomputable — for every member', async () => {
    const a = await player(modded, 'Host');
    const b = await player(modded, 'Guest');
    try {
      assert.equal(b.welcome.mods.digest, digest, 'the server runs the two packs');
      const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['zeta-pack', 'alpha-pack'] });
      assert.equal(created.t, 'ok', JSON.stringify(created));
      const hostState = await a.waitFor('room.state', (s) => s.code && s.mods);
      assert.deepEqual(hostState.mods.packs.map((p) => p.id), ['alpha-pack', 'zeta-pack'], 'sorted by id whatever order was sent');
      assert.equal(hostState.mods.digest, modSetOf(hostState.mods.packs).digest, 'the digest is what modSetOf computes from those packs');
      assert.equal(hostState.mods.packs.find((p) => p.id === 'zeta-pack').combat, true, 'the kit pack declares combat:true');
      assert.equal(hostState.mods.packs.find((p) => p.id === 'alpha-pack').combat, false);
      assert.equal(hostState.mods.packs.find((p) => p.id === 'alpha-pack').layer, 'A');
      assert.equal(hostState.mods.packs.find((p) => p.id === 'zeta-pack').layer, 'B');

      // the joiner is handed the ROOM's set (the state frame broadcast to the members, not `welcome`'s)
      const guestP = b.waitFor('room.state', (s) => s.code === hostState.code && s.seats.some((x) => x && x.playerId === b.id));
      const joined = await b.request({ t: 'room.join', code: hostState.code, mods: digest, consent: true });
      assert.equal(joined.t, 'ok', JSON.stringify(joined));
      const guestState = await guestP;
      assert.deepEqual(guestState.mods, hostState.mods, 'a joiner is told the ROOM set, not the server set');
    } finally {
      await a.terminate();
      await b.terminate();
    }
  });

  test('the same packs in any order are the same set (the digest is order-independent by construction)', async () => {
    const a = await TestClient.connect(wsUrl(modded));
    try {
      await a.hello('Host');
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack', 'zeta-pack'] })).t, 'ok');
      const first = await a.waitFor('room.state', (s) => s.mods);
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['zeta-pack', 'alpha-pack'] })).t, 'ok');
      const second = await a.waitFor('room.state', (s) => s.mods && s.code !== first.code);
      assert.equal(second.mods.digest, first.mods.digest, 'the order of modIds does not change the digest');
      assert.deepEqual(second.mods.packs.map((p) => p.id), first.mods.packs.map((p) => p.id));
      // a duplicate id in the list is the same set too
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack', 'alpha-pack'] })).t, 'ok');
      const dup = await a.waitFor('room.state', (s) => s.mods && s.code !== first.code && s.code !== second.code);
      assert.deepEqual(dup.mods.packs.map((p) => p.id), ['alpha-pack']);
    } finally {
      await a.terminate();
    }
  });

  test('a strict subset of the server set is a DIFFERENT digest from the whole set', async () => {
    const a = await TestClient.connect(wsUrl(modded));
    try {
      await a.hello('Host');
      // ONE of the two packs the server runs: the room's set is a strict subset, and the room's digest must not be the
      // process digest — otherwise `room.state.mods` would just be a copy of `welcome.mods` and mean nothing.
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const state = await a.waitFor('room.state', (s) => s.mods);
      assert.deepEqual(state.mods.packs.map((p) => p.id), ['alpha-pack']);
      assert.equal(state.mods.digest, modSetOf(state.mods.packs).digest);
      assert.notEqual(state.mods.digest, digest, 'a subset is a different identity from the whole server set');
      assert.equal(state.mods.packs.length, 1);
    } finally {
      await a.terminate();
    }
  });

  test('a spectator is told it too (room.spectate takes no digest, so room.state is the only carrier)', async () => {
    const a = await TestClient.connect(wsUrl(modded));
    const s = await TestClient.connect(wsUrl(modded));
    try {
      await a.hello('Host');
      await s.hello('Watcher');
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const code = (await a.waitFor('room.state', (st) => st.mods)).code;
      assert.equal((await s.request({ t: 'room.spectate', code })).t, 'ok');
      const state = await s.waitFor('room.state', (st) => st.code === code);
      assert.deepEqual(state.mods.packs.map((p) => p.id), ['alpha-pack']);
      assert.equal(state.mods.digest, modSetOf(state.mods.packs).digest);
    } finally {
      await a.terminate();
      await s.terminate();
    }
  });

  test('no modIds, an empty list, or a plain install ⇒ room.state has NO mods key (the default is unchanged)', async () => {
    const a = await TestClient.connect(wsUrl(modded));
    try {
      await a.hello('Host');
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest })).t, 'ok');
      const plain = await a.waitFor('room.state', (s) => s.code);
      assert.equal('mods' in plain, false, 'omitted modIds declares nothing');
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: [] })).t, 'ok');
      const empty = await a.waitFor('room.state', (s) => s.code && s.code !== plain.code);
      assert.equal('mods' in empty, false, 'an empty list declares nothing either');
    } finally {
      await a.terminate();
    }
    const v = await TestClient.connect(wsUrl(vanilla));
    try {
      await v.hello('Plain');
      assert.equal((await v.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
      const state = await v.waitFor('room.state', (s) => s.code);
      assert.equal('mods' in state, false, 'a plain install never grows the key');
    } finally {
      await v.terminate();
    }
  });

  test('an unknown pack id is refused by name, listing both the unknown and the available ids', async () => {
    const c = await TestClient.connect(wsUrl(modded));
    try {
      await c.hello('Host');
      const bad = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack', 'nope-pack'] });
      assert.equal(bad.t, 'error', JSON.stringify(bad));
      assert.equal(bad.code, ERR.MOD_UNKNOWN, JSON.stringify(bad));
      assert.match(String(bad.detail), /nope-pack/, 'the refusal names what was not found');
      assert.match(String(bad.detail), /alpha-pack/, 'and what is on offer');
      assert.match(String(bad.detail), /zeta-pack/);
      assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest })).t, 'ok', 'the refusal did not consume anything');
    } finally {
      await c.terminate();
    }
    const v = await TestClient.connect(wsUrl(vanilla));
    try {
      await v.hello('Plain');
      const none = await v.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', modIds: ['alpha-pack'] });
      assert.equal(none.t, 'error', JSON.stringify(none));
      assert.equal(none.code, ERR.MOD_UNKNOWN);
    } finally {
      await v.terminate();
    }
  });

  test('the protocol: modIds is optional, bounded, and every entry is a pack id', () => {
    const base = { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' };
    assert.equal(validateC2S(base), null, 'an old client that sends nothing is still valid');
    assert.equal(validateC2S({ ...base, modIds: [] }), null);
    assert.equal(validateC2S({ ...base, modIds: ['alpha-pack'] }), null);
    assert.equal(validateC2S({ ...base, modIds: ['..bad'] }), 'bad field modIds');
    assert.equal(validateC2S({ ...base, modIds: 'alpha-pack' }), 'bad field modIds');
    assert.equal(validateC2S({ ...base, modIds: [42] }), 'bad field modIds');
    assert.equal(validateC2S({ ...base, modIds: Array.from({ length: MAX_ROOM_MODS }, (_, i) => `p${i}`) }), null, 'at the limit');
    assert.equal(validateC2S({ ...base, modIds: Array.from({ length: MAX_ROOM_MODS + 1 }, (_, i) => `p${i}`) }), 'bad field modIds');
    // 本房座位上限 (业主裁决 B5, docs/META.md §1.9) 再加 `seatCap`: 房主建的这个房间开几张座位卡。
    // 上游 0.3.1 又加了 test（测试房间）：判据跟着事实走
    assert.deepEqual(C2S['room.create'].$optional, ['mods', 'modIds', 'chatMode', 'seatCap', 'test']);
    // W7（§28.53）多了一格**可选**的 `consent`：进一个声明了集合的房间要每名真人明确同意。它与 `mods` 是**两种
    // 表态**（`mods` = 「我读到了服务器装着哪些包」的握手回执，`consent` = 「我同意跑这一房声明的那一份字节」），
    // 所以两格并列而不是合成一格；形状见 shared/protocol.js 那一处。
    assert.deepEqual(C2S['room.join'].$optional, ['mods', 'consent', 'testAck'], 'room.join takes no modIds: the set is the host\'s to declare');
  });
});

describe('the ?playtest=1 quick start carries the digest too, and a plain install is byte-identical', () => {
  /** A fake `net` recording what was sent — the same shape test/playtestLink.test.js uses. */
  function fakeNet() {
    const sent = [];
    return { status: 'online', sent, async request(t, fields = {}) { sent.push([t, fields]); return { t: 'ok' }; } };
  }
  /** A fake store holding only the slices runSoloPlaytest reads. */
  function fakeStore() {
    const state = { ui: { pendingPlaytest: { mode: 'solo', difficulty: 'HARD' } }, session: { entered: true }, room: null, match: { public: null } };
    return { state, get: () => state, patch: (key, obj) => { state[key] = { ...state[key], ...obj }; } };
  }

  test('with no hook the payload is exactly what it always was (the default must not change)', async () => {
    const net = fakeNet();
    assert.equal(await runSoloPlaytest(net, fakeStore(), { difficulty: 'HARD' }), true);
    assert.deepEqual(net.sent, [['room.create', { mode: 'solo', difficulty: 'HARD' }], ['room.start', {}]]);
  });

  test('main.js\'s roomFields hook puts the digest on the wire, and only when there is one', async () => {
    // what main.js defines: the `mods` field, or nothing at all on a plain install
    const roomModFields = () => { const { mods } = roomMods.buildCreatePayload('solo', ''); return mods ? { mods } : {}; };

    roomMods.reset();
    roomMods.setWelcomeMods({ playerId: 'p1', name: 'Plain' });
    const plain = fakeNet();
    assert.equal(await runSoloPlaytest(plain, fakeStore(), { difficulty: 'HARD', roomFields: roomModFields }), true);
    assert.deepEqual(plain.sent[0], ['room.create', { mode: 'solo', difficulty: 'HARD' }], 'no mods key, no empty object');

    roomMods.reset();
    roomMods.setWelcomeMods({ mods: { digest, packs: [{ id: 'alpha-pack', hash: 'a'.repeat(64), layer: 'A', combat: false }] } });
    roomMods.setSelectedModIds(['alpha-pack']);
    const modded = fakeNet();
    assert.equal(await runSoloPlaytest(modded, fakeStore(), { difficulty: 'HARD', roomFields: roomModFields }), true);
    // The quick start carries the DIGEST (it has to — the entry gate is the process set, P0) but not the picks: it is a
    // solo room nobody joins, so the room's declared set would be decoration. `roomModFields` therefore returns `mods`
    // alone, and a lobby pick cannot leak into it.
    assert.deepEqual(modded.sent[0], ['room.create', { mode: 'solo', difficulty: 'HARD', mods: digest }]);
    assert.equal(validateC2S({ t: 'room.create', ...modded.sent[0][1] }), null, 'the quick start sends valid C2S');
  });

  test('a hook that is not a function is ignored, never called', async () => {
    const net = fakeNet();
    assert.equal(await runSoloPlaytest(net, fakeStore(), { difficulty: 'HARD', roomFields: { mods: 'nope' } }), true);
    assert.deepEqual(net.sent[0], ['room.create', { mode: 'solo', difficulty: 'HARD' }]);
  });
});

describe('入座门判的是**进程**集合（W-A 定的，W-B 也故意不改：入座前客户端还不知道房间的集合）', () => {
  test('a client that echoes the SERVER digest enters a room whose declared set is a strict subset', async () => {
    const a = await player(modded, 'Host');
    const b = await player(modded, 'Guest');
    try {
      // the room declares ONE of the two packs the server runs
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      assert.deepEqual(created.mods.packs.map((p) => p.id), ['alpha-pack']);
      assert.notEqual(created.mods.digest, digest, 'the room set and the process set are already two different strings');
      // A joiner that confirms the SERVER set is let in. W-B keeps this on purpose: a joiner cannot know the room's set
      // before it is in the room, so the gate proves "same catalogue, same pack bytes" and the ROOM set travels in
      // `room.state` — what the room really runs is decided per room (server/roomAssets.js) and alignment to it is the
      // client's job before it readies up (W-D).
      const stateP = b.waitFor('room.state', (s) => s.code === created.code && s.seats.some((x) => x && x.playerId === b.id));
      const joined = await b.request({ t: 'room.join', code: created.code, mods: digest, consent: true });
      assert.equal(joined.t, 'ok', JSON.stringify(joined));
      const state = await stateP;
      assert.deepEqual(state.mods, created.mods, 'the joiner sees the room set, and got in on the process digest');
    } finally {
      await a.terminate();
      await b.terminate();
    }
  });

  test('the gate still refuses a missing or wrong digest, with the same codes and detail as before', async () => {
    const c = await TestClient.connect(wsUrl(modded));
    try {
      await c.hello('ModGate');
      const missing = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
      assert.equal(missing.code, ERR.BAD_MSG);
      assert.match(String(missing.detail), /alpha-pack/);
      const wrong = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: 'deadbeefdeadbeef' });
      assert.equal(wrong.code, ERR.BAD_MSG);
      assert.match(String(wrong.detail), /different mod set/);
      // a room's own digest is not a key to the gate: it is not the process digest
      const roomDigest = modSetOf([{ id: 'alpha-pack', hash: 'a'.repeat(64), layer: 'A', combat: false }]).digest;
      const viaRoom = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: roomDigest });
      assert.equal(viaRoom.code, ERR.BAD_MSG, 'W-A: a room set does not open the gate');
    } finally {
      await c.terminate();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// room.mods: 房主在房间里改本房间的集合（G1）+ 守卫（G2）
// ---------------------------------------------------------------------------------------------------
describe('room.mods：房主在房间里改集合（G1），守卫与对齐（G2）', () => {
  test('房主改集合成功：room.state 广播新集合、digest 与 modSetOf 一致、其它真人被退回未就绪', async () => {
    const a = await player(modded, 'Host');
    const b = await player(modded, 'Guest');
    try {
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      assert.deepEqual(created.mods.packs.map((p) => p.id), ['alpha-pack']);
      const guestJoined = b.waitFor('room.state', (s) => s.code === created.code && s.seats.some((x) => x && x.playerId === b.id));
      assert.equal((await b.request({ t: 'room.join', code: created.code, mods: digest, consent: true })).t, 'ok');
      await guestJoined;

      // 客人先就绪、又自己取消（「有人 ready 后改被拒」另有用例）—— 这里要的是干净的一次变更
      assert.equal((await b.request({ t: 'room.ready', ready: true })).t, 'ok');
      assert.equal((await b.request({ t: 'room.ready', ready: false })).t, 'ok');

      const changedP = a.waitFor('room.state', (s) => s.mods && s.mods.packs.length === 2);
      const guestChangedP = b.waitFor('room.state', (s) => s.mods && s.mods.packs.length === 2);
      assert.equal((await a.request({ t: 'room.mods', modIds: ['zeta-pack', 'alpha-pack'] })).t, 'ok', '房主改集合成功');
      const changed = await changedP;
      assert.deepEqual(changed.mods.packs.map((p) => p.id), ['alpha-pack', 'zeta-pack'], '与 room.create 同一条口径：按 id 排序');
      assert.equal(changed.mods.digest, modSetOf(changed.mods.packs).digest, '摘要就是 modSetOf 算的那一个');
      assert.equal(changed.mods.packs.find((p) => p.id === 'zeta-pack').combat, true, '包的 combat 标志随集合一起走');

      // 另一位真人（另一条连接）真的收到了新集合 —— 集合是**广播**的，不是只回给改的人
      const guestState = await guestChangedP;
      assert.deepEqual(guestState.mods, changed.mods);
      assert.equal(guestState.seats.find((s) => s && s.playerId === b.id).ready, false, '集合变了 ⇒ 那位真人回到未就绪（要重新对齐）');
    } finally {
      await a.terminate();
      await b.terminate();
    }
  });

  test('非房主改被拒 NOT_HOST；不在房间里改被拒 NOT_IN_ROOM；两次都一字未动', async () => {
    const a = await player(modded, 'Host');
    const b = await player(modded, 'Guest');
    const c = await player(modded, 'Stranger');
    try {
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      const guestJoined = b.waitFor('room.state', (s) => s.code === created.code && s.seats.some((x) => x && x.playerId === b.id));
      assert.equal((await b.request({ t: 'room.join', code: created.code, mods: digest, consent: true })).t, 'ok');
      await guestJoined;
      const byGuest = await b.request({ t: 'room.mods', modIds: ['zeta-pack'] });
      assert.equal(byGuest.t, 'error', JSON.stringify(byGuest));
      assert.equal(byGuest.code, ERR.NOT_HOST, '集合只有房主能改');
      const byStranger = await c.request({ t: 'room.mods', modIds: ['zeta-pack'] });
      assert.equal(byStranger.code, ERR.NOT_IN_ROOM);
      // 「一字未动」的可观察判据：房主再发**现在这一份**会被当成幂等（不高广播）⇒ 说明那两次拒绝真的没改到东西
      const idem = await a.request({ t: 'room.mods', modIds: ['alpha-pack'] });
      assert.equal(idem.t, 'ok', JSON.stringify(idem));
      const probe = await a.request({ t: 'room.mods', modIds: ['zeta-pack'] });
      assert.equal(probe.t, 'ok');
      const state = await a.waitFor('room.state', (s) => s.mods && s.mods.packs.length === 1 && s.mods.packs[0].id === 'zeta-pack');
      assert.deepEqual(state.mods.packs.map((p) => p.id), ['zeta-pack'], '那两次拒绝之后集合仍是房主说的那一份');
    } finally {
      await a.terminate();
      await b.terminate();
      await c.terminate();
    }
  });

  test('已开局改被拒 MOD_SET_LOCKED（不是 NOT_READY），且正在跑的那一局不受影响', async () => {
    const a = await player(modded, 'SoloHost');
    try {
      assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      assert.equal((await a.request({ t: 'room.start', })).t, 'ok', 'solo 房直接开局');
      const running = await a.waitFor('room.state', (s) => s.code === created.code && s.inMatch === true);
      assert.equal(running.mods.packs.length, 1, '开局之后 room.state 里的集合还是开局那一刻那一份');
      const late = await a.request({ t: 'room.mods', modIds: ['zeta-pack'] });
      assert.equal(late.t, 'error', JSON.stringify(late));
      assert.equal(late.code, ERR.MOD_SET_LOCKED, '锁住的是这一格：对局已开始');
      assert.notEqual(late.code, ERR.NOT_READY, '不能复用一句与事实相反的话（NOT_READY 是「还有玩家没准备好」）');
      assert.match(String(late.detail), /match/i);
    } finally {
      await a.terminate();
    }
  });

  test('有人 ready 后改被拒 MOD_SET_LOCKED；那人取消就绪后又能改（同一条连接、同一个房间）', async () => {
    const a = await player(modded, 'Host');
    const b = await player(modded, 'Guest');
    try {
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      const guestJoined = b.waitFor('room.state', (s) => s.code === created.code && s.seats.some((x) => x && x.playerId === b.id));
      assert.equal((await b.request({ t: 'room.join', code: created.code, mods: digest, consent: true })).t, 'ok');
      await guestJoined;
      const guestReady = b.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === b.id && x.ready === true));
      assert.equal((await b.request({ t: 'room.ready', ready: true })).t, 'ok');
      await guestReady;

      const blocked = await a.request({ t: 'room.mods', modIds: ['zeta-pack'] });
      assert.equal(blocked.code, ERR.MOD_SET_LOCKED, '有人按旧集合对齐完并点了准备就绪 ⇒ 集合锁住');
      assert.notEqual(blocked.code, ERR.NOT_READY);
      assert.match(String(blocked.detail), /Guest/, '点名是谁还在就绪状态');

      // 他取消就绪 ⇒ 集合又改得动（守卫不是「一旦有人 ready 就永久锁死」）
      const guestBack = b.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === b.id && x.ready === false));
      assert.equal((await b.request({ t: 'room.ready', ready: false })).t, 'ok');
      await guestBack;
      const changedP = a.waitFor('room.state', (s) => s.mods && s.mods.packs.length === 1 && s.mods.packs[0].id === 'zeta-pack');
      assert.equal((await a.request({ t: 'room.mods', modIds: ['zeta-pack'] })).t, 'ok');
      const changed = await changedP;
      assert.deepEqual(changed.mods.packs.map((p) => p.id), ['zeta-pack']);
      assert.equal(changed.mods.digest, modSetOf(changed.mods.packs).digest);
    } finally {
      await a.terminate();
      await b.terminate();
    }
  });

  test('AI 队友不算「有人已就绪」：加过 AI 的房间照样改得动（否则房主一加 AI 就再也改不了）', async () => {
    const a = await player(modded, 'Host');
    try {
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      const botIn = a.waitFor('room.state', (s) => s.code === created.code && s.seats.some((x) => x && x.isBot));
      assert.equal((await a.request({ t: 'room.addBot' })).t, 'ok');
      const withBot = await botIn;
      assert.equal(withBot.seats.find((s) => s && s.isBot).ready, true, 'AI 座位在天生就绪（addBot 建出来的）');
      const changedP = a.waitFor('room.state', (s) => s.mods && s.mods.packs.length === 2);
      assert.equal((await a.request({ t: 'room.mods', modIds: ['alpha-pack', 'zeta-pack'] })).t, 'ok', 'addBot 的 ready 不是这条守卫要保护的对象');
      await changedP;
    } finally {
      await a.terminate();
    }
  });

  test('未知包名 ⇒ MOD_UNKNOWN（点名未知与可用），集合一字未动', async () => {
    const a = await player(modded, 'Host');
    try {
      assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const created = await a.waitFor('room.state', (s) => s.code && s.mods);
      const bad = await a.request({ t: 'room.mods', modIds: ['alpha-pack', 'nope-pack'] });
      assert.equal(bad.t, 'error', JSON.stringify(bad));
      assert.equal(bad.code, ERR.MOD_UNKNOWN);
      assert.match(String(bad.detail), /nope-pack/);
      assert.match(String(bad.detail), /zeta-pack/);
      // 一条干净的、可观察的「没有动过」：换成 []（= 不声明）会真的把 mods 键拿掉
      const clearedP = a.waitFor('room.state', (s) => s.code === created.code && !s.mods);
      assert.equal((await a.request({ t: 'room.mods', modIds: [] })).t, 'ok', '空列表 = 改回「不声明」（跑服务器加载的全部）');
      const cleared = await clearedP;
      assert.equal('mods' in cleared, false, '不声明就没有这个键（与 room.create 缺省逐字相同）');
    } finally {
      await a.terminate();
    }
  });

  test('同一份集合是幂等的：不广播、不重置别人的就绪状态', async () => {
    const c = await browserClient(modded, 'IdemHost');
    try {
      roomMods.setWelcomeMods(c.welcome);
      const createdP = nextFrame(c.net, 'room.state', (s) => s.code && s.mods);
      assert.equal((await c.net.request('room.create', { mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const state = await createdP;
      assert.deepEqual(state.mods.packs.map((p) => p.id), ['alpha-pack']);
      // 同一份集合（同序、乱序、重复都算同一份）：幂等 = 没有 room.state 广播
      assert.equal((await c.net.request('room.mods', { modIds: ['alpha-pack'] })).t, 'ok');
      await assert.rejects(nextFrame(c.net, 'room.state', () => true, 150), /timeout/, '同一份集合不是一个变更：没有广播');
      assert.equal((await c.net.request('room.mods', { modIds: ['alpha-pack', 'alpha-pack'] })).t, 'ok');
      await assert.rejects(nextFrame(c.net, 'room.state', () => true, 150), /timeout/, '重复的 id 还是同一份集合');
      // 反例：换一份就一定有广播（否则上面两条「没有广播」什么也没证明）
      const changedP = nextFrame(c.net, 'room.state', (s) => s.mods && s.mods.packs.length === 2);
      assert.equal((await c.net.request('room.mods', { modIds: ['alpha-pack', 'zeta-pack'] })).t, 'ok');
      assert.equal((await changedP).mods.packs.length, 2);
    } finally {
      await c.close();
    }
  });

  test('协议形状：modIds 必填、上限与条目形状与 room.create 那一格逐字相同', () => {
    assert.equal(validateC2S({ t: 'room.mods', modIds: [] }), null, '空列表合法 = 改回「不声明」');
    assert.equal(validateC2S({ t: 'room.mods', modIds: ['alpha-pack'] }), null);
    assert.equal(validateC2S({ t: 'room.mods' }), 'bad field modIds', '必填：缺了它，「不声明」与「坏了」就分不开');
    assert.equal(validateC2S({ t: 'room.mods', modIds: 'alpha-pack' }), 'bad field modIds');
    assert.equal(validateC2S({ t: 'room.mods', modIds: ['..bad'] }), 'bad field modIds');
    assert.equal(validateC2S({ t: 'room.mods', modIds: [42] }), 'bad field modIds');
    assert.equal(validateC2S({ t: 'room.mods', modIds: Array.from({ length: MAX_ROOM_MODS }, (_, i) => `p${i}`) }), null, '在上限');
    assert.equal(validateC2S({ t: 'room.mods', modIds: Array.from({ length: MAX_ROOM_MODS + 1 }, (_, i) => `p${i}`) }), 'bad field modIds');
    assert.equal(Object.hasOwn(C2S['room.mods'], '$optional'), false, '这一条没有可选字段：形状就是 { modIds }');
    // 与 room.create 那一格是**同一个判据**（不是抄一份）：上限同源、条目同源
    assert.deepEqual(C2S['room.mods'].modIds([]), C2S['room.create'].modIds([]));
    assert.deepEqual(C2S['room.mods'].modIds(['alpha-pack']), C2S['room.create'].modIds(['alpha-pack']));
  });

  test('MOD_SET_LOCKED 是一个真的错误码：ERR / ERR_TEXT 都有，且四个语言包都有它的文案', () => {
    assert.equal(ERR.MOD_SET_LOCKED, 'MOD_SET_LOCKED');
    assert.equal(ERR_TEXT[ERR.MOD_SET_LOCKED], '本房间的模组集合已锁定（模拟已开始，或已有博士准备就绪），要改请重开房间');
    const i18nDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'i18n');
    for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
      const pack = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
      assert.equal(typeof pack[ERR_TEXT[ERR.MOD_SET_LOCKED]], 'string', `${lang} 缺 MOD_SET_LOCKED 的文案`);
    }
  });
});
