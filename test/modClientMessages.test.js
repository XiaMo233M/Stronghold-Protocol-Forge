// test/modClientMessages.test.js — C 层的**包通道**：`client.panels[].messages` + `pack.msg`（docs/WORKSHOP.md §1.9.6）。
//
// 插件包要的聊天 / 皮肤这类通道，引擎里**没有**，而引擎也不该替它发明语义。所以这一格的形状是：
//   * **类型名由引擎定**（`pack.msg`，进 `shared/protocol.js`）—— 包**不能**定义新的协议类型，`b.*` 那条边界没动；
//   * **通道名由包定**（作者的 `client.panels[].messages` 里只写后半段，线上的 `<包id>.<名字>` 由引擎拼）；
//   * 引擎只做三件事：校验（包装着 + 通道声明过）、限流（每会话令牌桶）、转发（同一个房间的成员与旁观者）；
//   * `data` 是**不透明**的（引擎不解释），但**有界**（大小 + 频率）。
//
// 四组断言：声明层 · 协议层 · 服务端（真服务器、真房间、两个客户端）· 客户端注册表（门面只认自家通道）。
//
// Run: node --test test/modClientMessages.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, WORKSHOP_PANEL_PREFIX } from '../shared/workshop.js';
import { validateC2S, PACK_MSG_LIMITS } from '../shared/protocol.js';
import { loadWorkshop, loadWorkshopPanels } from '../server/workshop.js';
import { startServer } from '../server/index.js';
import { createPanelRegistry } from '../public/js/ui/extensions.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const settle = () => new Promise((r) => setTimeout(r, 0));
const PACK = 'chat-pack';

// ---------------------------------------------------------------------------------------------------------------
describe('声明层：通道名写出来、闭形状', () => {
  const base = (panel) => ({ id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x', client: { panels: [panel] } });
  const norm = (panel) => normalizePackManifest(base(panel), 'p', { hasAssets: false });
  const P = { id: 'chat', slot: 'root.overlays', module: 'ui/chat.js' };

  test('合法声明归一化成**稳定序**清单', () => {
    const r = norm({ ...P, messages: ['skins', 'chat'] });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
    assert.deepEqual(r.pack.client.panels[0].messages, ['chat', 'skins']);
  });

  test('每一种写错的通道名都点名拒绝', () => {
    const bad = (messages, code, note) => {
      const r = norm({ ...P, messages });
      assert.equal(r.ok, false, `${note}: 应当被拒`);
      assert.equal(r.error, code, `${note}: 期待 ${code}，实际 ${r.error} — ${r.detail}`);
    };
    bad('chat', 'CLIENT_BAD_PANEL_MESSAGES', '不是数组');
    bad([], 'CLIENT_BAD_PANEL_MESSAGES', '空数组');
    bad(['Chat'], 'CLIENT_BAD_PANEL_CHANNEL', '大写开头');
    bad(['chat.msg'], 'CLIENT_BAD_PANEL_CHANNEL', '带点（线上有包 id 前缀）');
    bad(['-chat'], 'CLIENT_BAD_PANEL_CHANNEL', '以连字符开头');
    bad(['chat room'], 'CLIENT_BAD_PANEL_CHANNEL', '带空格');
    bad(['a'.repeat(65)], 'CLIENT_BAD_PANEL_CHANNEL', '太长');
    bad(['chat', 'chat'], 'CLIENT_DUPLICATE_PANEL_CHANNEL', '重复');
    bad(Array.from({ length: 9 }, (_, i) => `c${i}`), 'CLIENT_BAD_PANEL_MESSAGES', '超过 8 条');
  });

  test('服务面把 `messages` 送到客户端（没声明的面板没有这个键）', () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-modmsg-'));
    try {
      const dir = path.join(tmp, PACK);
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: PACK, name: 'Chat', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
        client: { panels: [
          { id: 'chat', slot: 'root.overlays', module: 'ui/chat.js', messages: ['chat'] },
          { id: 'plain', slot: 'root.guide', module: 'ui/plain.js' },
        ] },
      }));
      fs.writeFileSync(path.join(dir, 'ui', 'chat.js'), 'export function mount() { return {}; }\n');
      fs.writeFileSync(path.join(dir, 'ui', 'plain.js'), 'export function mount() { return {}; }\n');
      const { panels, errors } = loadWorkshopPanels(loadWorkshop(tmp, { log: quiet }), { log: quiet });
      assert.deepEqual(errors, []);
      assert.deepEqual(panels.find((p) => p.id === 'chat').messages, ['chat']);
      assert.equal('messages' in panels.find((p) => p.id === 'plain'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('协议层：`pack.msg` 的类型由引擎定，载荷有界', () => {
  test('合法形状', () => {
    assert.equal(validateC2S({ t: 'pack.msg', pack: PACK, channel: 'chat' }), null, 'data 可省');
    assert.equal(validateC2S({ t: 'pack.msg', pack: PACK, channel: 'chat', data: { text: 'hi' } }), null);
    assert.equal(validateC2S({ t: 'pack.msg', pack: PACK, channel: 'a-b_c9', data: [1, 2, 3] }), null);
  });

  test('坏形状逐条拒（包 id / 通道名 / 载荷大小 / 不可序列化）', () => {
    const bad = (msg, note) => assert.match(String(validateC2S(msg)), /^bad field /, note);
    bad({ t: 'pack.msg', channel: 'chat' }, '缺 pack');
    bad({ t: 'pack.msg', pack: 'has space', channel: 'chat' }, '包 id 非法');
    bad({ t: 'pack.msg', pack: PACK, channel: 'Chat' }, '通道名大写');
    bad({ t: 'pack.msg', pack: PACK, channel: 'chat', data: 'x'.repeat(PACK_MSG_LIMITS.bytes + 1) }, '载荷超过上限');
    const cyclic = {};
    cyclic.self = cyclic;
    bad({ t: 'pack.msg', pack: PACK, channel: 'chat', data: cyclic }, '载荷不可序列化');
  });

  test('上限本身是文档里写的那个数', () => {
    assert.deepEqual(PACK_MSG_LIMITS, { bytes: 4096, perSec: 5, burst: 20 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('服务端：真服务器、真房间、两个客户端', () => {
  let tmp;
  let wsRoot;
  let srv;
  let digest;
  const clients = [];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-packmsg-'));
    wsRoot = path.join(tmp, 'ws');
    const dir = path.join(wsRoot, PACK);
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: PACK, name: 'Chat', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      client: { panels: [{ id: 'chat', slot: 'root.overlays', module: 'ui/chat.js', messages: ['chat', 'skins'] }] },
    }));
    fs.writeFileSync(path.join(dir, 'ui', 'chat.js'), 'export function mount() { return {}; }\n');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    digest = srv.lobby.welcomeInfo().mods.digest;
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch { /* already closed */ } }
    if (srv) await srv.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 进一个房间（两个客户端）：返回 `{ a, b, code }`。 */
  async function twoInARoom(mode = 'coop') {
    const a = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
    clients.push(a);
    await a.hello(`A${clients.length}`);
    const created = await a.request({ t: 'room.create', mode, difficulty: 'NORMAL', mods: digest });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await a.waitFor('room.state');
    const b = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
    clients.push(b);
    await b.hello(`B${clients.length}`);
    if (mode === 'coop') {
      const joined = await b.request({ t: 'room.join', code: state.code, mods: digest });
      assert.equal(joined.t, 'ok', JSON.stringify(joined));
    }
    a.clearInbox();
    b.clearInbox();
    return { a, b, code: state.code };
  }

  test('一条通道消息从 A 到 B，载荷原样、发送者署名', async () => {
    const { a, b } = await twoInARoom();
    a.send({ t: 'pack.msg', pack: PACK, channel: 'chat', data: { text: '你好', n: 3 } });
    const got = await b.waitFor('pack.msg');
    assert.equal(got.pack, PACK);
    assert.equal(got.channel, 'chat');
    assert.deepEqual(got.data, { text: '你好', n: 3 }, '引擎不解释也不改写载荷');
    assert.equal(typeof got.from, 'string');
    assert.ok(got.from.length > 0, '收得到发送者');
  });

  test('回显给自己（发送者也在房间里）', async () => {
    const { a } = await twoInARoom();
    a.send({ t: 'pack.msg', pack: PACK, channel: 'skins', data: 1 });
    const own = await a.waitFor('pack.msg');
    assert.equal(own.channel, 'skins');
    assert.equal(own.data, 1);
  });

  test('没声明过的通道 = 点名拒绝（不是静默丢弃）', async () => {
    const { a } = await twoInARoom();
    const r = await a.request({ t: 'pack.msg', pack: PACK, channel: 'nope', data: {} });
    assert.equal(r.t, 'error');
    assert.equal(r.code, 'BAD_MSG');
    assert.match(r.detail || '', /does not declare the channel "nope"/, '理由要点名那个通道（错误帧的字段是 code / detail）');
  });

  test('不在房间里的会话发不出包消息', async () => {
    const solo = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
    clients.push(solo);
    await solo.hello(`S${clients.length}`);
    const r = await solo.request({ t: 'pack.msg', pack: PACK, channel: 'chat', data: {} });
    assert.equal(r.t, 'error');
    assert.equal(r.code, 'NOT_IN_ROOM');
  });

  test('限流：令牌桶按会话计（burst 20，之后 5/s 补充）', () => {
    const session = {};
    let allowed = 0;
    for (let i = 0; i < 25; i++) if (srv.lobby.packMsgAllowed(session, 1000)) allowed += 1;
    assert.equal(allowed, PACK_MSG_LIMITS.burst, '同一个时刻只放行 burst 条');
    assert.equal(srv.lobby.packMsgAllowed(session, 1000), false, '桶空了就是空');
    assert.equal(srv.lobby.packMsgAllowed(session, 1000 + 200), true, '200ms 之后补 1 条');
    assert.equal(srv.lobby.packMsgAllowed(session, 1000 + 200), false);
    assert.equal(srv.lobby.packMsgAllowed(session, 1000 + 20000), true, '放很久之后又满了');
  });

  test('`welcome.modPanels` 里就带着这个通道（客户端据此复判）', () => {
    const panel = srv.lobby.welcomeInfo().modPanels.find((p) => p.id === 'chat');
    assert.deepEqual(panel.messages, ['chat', 'skins']);
    assert.equal(panel.url.startsWith(WORKSHOP_PANEL_PREFIX), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('客户端注册表：门面只认自家通道', () => {
  /** 记录用法的假 net（`on` / `send`）。 */
  function fakeNet() {
    const handlers = new Map();
    const sent = [];
    return {
      handlers, sent,
      on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(fn);
        return () => handlers.get(type).delete(fn);
      },
      send(msg) { sent.push(msg); return true; },
      /** 引擎把一条帧推给页面。 */
      emit(type, msg) { for (const fn of handlers.get(type) || []) fn(msg); },
    };
  }
  const el = (tag) => ({ tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, getAttribute: () => null, appendChild(c) { this.children.push(c); }, remove() {} });

  async function mount(decl = {}) {
    const net = fakeNet();
    const seen = [];
    const registry = createPanelRegistry({
      store: { get: () => ({}), subscribe: () => () => {}, patch: () => {} },
      net,
      notify: () => {},
      importModule: async () => ({ mount: (ctx) => { seen.push(ctx); return {}; } }),
      createElement: el,
      slotHost: () => el('div'),
      slotHosts: () => [el('div')],
      styleHost: () => el('head'),
      themeHost: () => el('html'),
      env: {},
    });
    registry.apply([{ id: 'chat', pack: PACK, slot: 'root.overlays', url: '/workshop-panels/chat-pack/ui/chat.js', messages: ['chat', 'skins'], ...decl }]);
    await settle();
    return { ctx: seen[0], registry, net };
  }

  test('send：声明过的通道发出去，形状是 `pack.msg` + 自己的包 id', async () => {
    const { ctx, net } = await mount();
    assert.equal(ctx.net.send('chat', { text: 'hi' }), true);
    assert.deepEqual(net.sent[0], { t: 'pack.msg', pack: PACK, channel: 'chat', data: { text: 'hi' } });
    assert.equal(ctx.net.send('skins'), true);
    assert.deepEqual(net.sent[1], { t: 'pack.msg', pack: PACK, channel: 'skins' }, '没有 data 就不带这个字段');
  });

  test('send：没声明过的通道返回 false 并点名（不是静默发出去）', async () => {
    const { ctx, registry, net } = await mount();
    assert.equal(ctx.net.send('nope', {}), false);
    assert.equal(net.sent.length, 0);
    assert.equal(registry.refusals()[0].code, 'CLIENT_CHANNEL_UNDECLARED');
    assert.match(registry.refusals()[0].detail, /"nope"/);
  });

  test('on：引擎类型照旧透传，通道名收自己那一份', async () => {
    const { ctx, net } = await mount();
    const engine = [];
    ctx.net.on('b.start', (m) => engine.push(m));
    net.emit('b.start', { t: 'b.start', battleId: 1 });
    assert.equal(engine.length, 1, '引擎类型原样订阅');

    const mine = [];
    ctx.net.on('chat', (data, msg) => mine.push([data, msg.channel]));
    net.emit('pack.msg', { t: 'pack.msg', pack: PACK, channel: 'chat', data: 'a' });
    net.emit('pack.msg', { t: 'pack.msg', pack: 'other-pack', channel: 'chat', data: 'b' });
    net.emit('pack.msg', { t: 'pack.msg', pack: PACK, channel: 'skins', data: 'c' });
    assert.deepEqual(mine, [['a', 'chat']], '只收自己包的、自己声明的那个通道');
  });

  test('on：没声明的通道名点名拒绝，并且不会留下一个永远不响的订阅', async () => {
    const { ctx, registry, net } = await mount();
    const off = ctx.net.on('nope', () => {});
    assert.equal(typeof off, 'function');
    assert.equal(registry.refusals()[0].code, 'CLIENT_CHANNEL_UNDECLARED');
    assert.equal((net.handlers.get('pack.msg') || new Set()).size, 0, '没有挂上任何东西');
  });

  test('dispose 把通道订阅撤掉（注入过的东西必须能收回来）', async () => {
    const { ctx, registry, net } = await mount();
    ctx.net.on('chat', () => {});
    assert.equal(net.handlers.get('pack.msg').size, 1);
    registry.dispose();
    assert.equal(net.handlers.get('pack.msg').size, 0);
  });
});
