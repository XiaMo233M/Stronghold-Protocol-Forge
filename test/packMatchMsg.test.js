// test/packMatchMsg.test.js — **对局子类收到包通道消息**（DESIGN §28.14 的那**唯一**一条网络触发点，业主裁决
// 2026-10-10 的 A 方案）。
//
// `pack.msg` 仍然由大厅校验 / 限流 / 转发；多出来的只有一步：**转发之前**问一次房间里的对局。六件事各有一条断言：
//   1. **投递收窄**（DESIGN §28.23，docs/WORKSHOP.md §1.12）：`channels` 是**接收入口** —— 本包的 `server.modules[]`
//      **声明过**这个通道，消息才投给对局；只被面板声明（`client.panels[].messages`）、模块没声明的通道**投都不投**
//      （转发照旧：那是面板那半边 §1.9.6 的判据，收窄没有动它）。一个通道都没声明的包 = 没有接收入口；
//   2. `server.modules` 里声明了 `uses: ['matchClass']`（所以这个包必须同时写 `combat: true`）的包，其 MatchClass
//      子类上的 `handlePackMsg(playerId, msg)` 被调到一次，参数就是 `session.playerId` 与那条 `pack.msg` 原样；
//   3. 返回 `true`（或 `{ consumed: true }`）= **已消费**：一个字节都不再转发（发送者也收不到今天的那个回显）；
//   4. `false` / `undefined` / 根本没有这个方法 = **照旧转发**，帧与今天逐字相同；
//   5. 钩子**抛错** = `callMatch` 记一条**点名**日志，并**按未消费继续转发**（一条坏消息不能把转发打断）；
//   6. 没声明 `matchClass` 的包拿不到这个钩子 —— MatchClass 上就没有这个方法，行为与今天一致。
//
// 另外钉住**既有判据的顺序**：面板没声明的通道、不在房间这两条在钩子之前就拒掉了（钩子一次都不会被调到），
// 而「被 `RATE` 拒掉的那条到不了对局」用「回 `ok` 的条数 === 钩子被调到的次数」来钉 —— 不依赖计时。
//
// Run: node --test test/packMatchMsg.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { startServer } from '../server/index.js';
import { moduleStateDir } from '../server/modModules.js';
import { TestClient } from './helpers/wsClient.js';

const HOOK_PACK = 'hook-pack';
const PLAIN_PACK = 'channels-pack';
/** 每个通道一个返回值分支（见下面的模块源码）；它们同时也是**模块声明**的接收通道。 */
const CHANNELS = ['chat', 'skins', 'obj', 'boom', 'no'];
/**
 * 只被**面板**声明、模块**没有**声明的通道（§28.23 收窄的那一条）：客户端发得出来（面板声明过），但对局
 * 收不到（不是接收入口）。去掉 `packMsg` 里那道收窄的接线，这条通道就会投进对局 —— 钉住它的断言因此有牙。
 */
const PANEL_ONLY = 'watch';

/**
 * 包的服务端模块：把每一次调用**追加成一行 JSON** 到自己包的状态目录里（`host.io`，包声明 `write: true`）。
 *
 * 这里从前用 `globalThis.__packMsgCalls` 与同进程的测试通信 —— 那正是「服务端模块源码不许碰 `globalThis`」
 * 这道扫描的**唯一**合法用例，也是那一格当初被拿掉的理由。现在这条观察点走**引擎显式注入**的宿主对象
 * （`server/modModules.js` 的 `ioFacade`：目录被限定在 `<状态目录>/mod/<包id>/`，包爬不出去），
 * 所以 `globalThis` 回到禁止名单里也不会裁掉任何合法包：包要留下观察点，用引擎交给它的东西，别去够全局。
 */
const HOOK_SRC = [
  'export function registerServer(host) {',
  "  const note = (o) => host.io.append('calls.jsonl', JSON.stringify(o) + \"\\n\");",
  '  host.matchClass((Base) => class extends Base {',
  '    handlePackMsg(playerId, msg) {',
  '      note({ playerId, t: msg.t, pack: msg.pack, channel: msg.channel, data: msg.data });',
  "      if (msg.channel === 'skins') return true;",                    // 已消费
  "      if (msg.channel === 'obj') return { consumed: true };",        // 已消费（另一种写法）
  "      if (msg.channel === 'boom') throw new Error('hook boom');",    // 抛错 ⇒ 未消费
  "      if (msg.channel === 'no') return false;",                      // 明确未消费
  '      return undefined;',                                            // 没返回值 ⇒ 未消费
  '    }',
  '  });',
  '}',
  '',
].join('\n');

/** 一个包：`pack.json` + 一个面板模块（有通道声明才有 `pack.msg` 可发）。 */
function writePack(root, id, declaration) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2', ...declaration,
  }));
  fs.writeFileSync(path.join(dir, 'ui', 'chat.js'), 'export function mount() { return {}; }\n');
  return dir;
}

describe('对局子类收到包通道消息（DESIGN §28.14 的唯一网络触发点；§28.23 把投递收窄到声明过的通道）', () => {
  let tmp;
  let srv;
  let bare;
  let digest;
  let bareDigest;
  /** 模块写盘的状态根（`SP_STATE_DIR`；`server/index.js` 用 `stateRootFor` 读它）。 */
  let stateRoot;
  /** 这个文件之前 `SP_STATE_DIR` 的值（跑完还原，别把这个进程的用法漏给别人）。 */
  let prevStateDir;
  /** 记一切的日志替身：`callMatch` 的点名日志落在这里。 */
  const lines = { info: [], warn: [], error: [] };
  const clients = [];
  /** 模块那一个包自己的状态目录里的记录文件（与 `moduleStateDir` 逐字同一份判据）。 */
  const callsFile = () => path.join(moduleStateDir(stateRoot, HOOK_PACK), 'calls.jsonl');
  /**
   * 模块记下来的每一次调用：一行一条 JSON（`host.io.append`）。
   *
   * 为什么读盘而不是读一个全局数组：这是那个合法用例改成**引擎显式注入**后的样子 —— 包只能用引擎交给它的
   * 东西（这里是有 `write: true` 才拿得到的 `host.io`），所以「同进程直接读」这件事没了，测试读的是它写下的文件。
   */
  const calls = () => {
    try { return fs.readFileSync(callsFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  /** 清空记录（每条用例开头重置；模块只管往后追加，删文件是测试这一侧的事）。 */
  const resetCalls = () => { fs.rmSync(callsFile(), { force: true }); };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-packmatchmsg-'));
    // 装了钩子的那台：声明 `uses: ['matchClass']` + `combat: true`（`MODULES_NEED_COMBAT` 的硬闸门），并且
    // **声明了接收通道**（§28.23）—— 收窄之后，没有这一格的消息投不进对局。面板比模块多声明一条 `PANEL_ONLY`。
    const hookRoot = path.join(tmp, 'hook');
    const hookDir = writePack(hookRoot, HOOK_PACK, {
      combat: true,
      // `write: true` 是那个观察点的**代价**：`host.io` 是有这一格才拿得到的门面（`MODULE_USE_UNDECLARED` 否则），
      // 而它被限定在 `<状态目录>/mod/<包id>/` 里 —— 这比「谁都能写的 globalThis」小得多。
      server: { modules: [{ id: 'hook', entry: 'server/hook.mjs', uses: ['matchClass'], channels: CHANNELS, write: true }] },
      client: { panels: [{ id: 'chat', slot: 'root.overlays', module: 'ui/chat.js', messages: [...CHANNELS, PANEL_ONLY] }] },
    });
    fs.mkdirSync(path.join(hookDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'server', 'hook.mjs'), HOOK_SRC);
    // 对照的那台：有包通道，但**没有任何** `server.modules` ⇒ 既没有 MatchClass 方法，也没有一条 `channels`
    // 声明（§28.23 的接收入口一个都不存在）：消息照旧转发，对局一次都收不到。
    const bareRoot = path.join(tmp, 'bare');
    writePack(bareRoot, PLAIN_PACK, {
      client: { panels: [{ id: 'chat', slot: 'root.overlays', module: 'ui/chat.js', messages: ['chat', 'skins'] }] },
    });
    // 状态根指到自己的临时目录：模块写的记录落在 tmp 里，跑完跟着 tmp 一起删（仓库里什么都不留）。
    // `stateRootFor`（server/modModules.js）读的就是这个变量，所以必须在 startServer **之前**设好。
    stateRoot = path.join(tmp, 'state');
    prevStateDir = process.env.SP_STATE_DIR;
    process.env.SP_STATE_DIR = stateRoot;
    const log = {
      info: (...a) => lines.info.push(a.map(String).join(' ')),
      warn: (...a) => lines.warn.push(a.map(String).join(' ')),
      error: (...a) => lines.error.push(a.map(String).join(' ')),
      debug: () => {},
    };
    srv = await startServer({ port: 0, host: '127.0.0.1', workshopDir: hookRoot, log });
    bare = await startServer({ port: 0, host: '127.0.0.1', workshopDir: bareRoot, log });
    digest = srv.lobby.welcomeInfo().mods.digest;
    bareDigest = bare.lobby.welcomeInfo().mods.digest;
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch { /* already closed */ } }
    if (srv) await srv.close();
    if (bare) await bare.close();
    if (prevStateDir === undefined) delete process.env.SP_STATE_DIR; else process.env.SP_STATE_DIR = prevStateDir;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 开一局 coop（两个真人）并等到对局起来 —— 钩子挂在 Match 上，所以**必须先开赛**。 */
  async function started(server = srv, dg = digest) {
    const wsUrl = `${server.url.replace('http', 'ws')}/ws`;
    const a = await TestClient.connect(wsUrl);
    clients.push(a);
    const wa = await a.hello(`A${clients.length}`);
    const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: dg });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await a.waitFor('room.state');
    const b = await TestClient.connect(wsUrl);
    clients.push(b);
    await b.hello(`B${clients.length}`);
    const joined = await b.request({ t: 'room.join', code: state.code, mods: dg });
    assert.equal(joined.t, 'ok', JSON.stringify(joined));
    const ready = await b.request({ t: 'room.ready', ready: true });
    assert.equal(ready.t, 'ok', JSON.stringify(ready));
    const start = await a.request({ t: 'room.start' });
    assert.equal(start.t, 'ok', JSON.stringify(start));
    await a.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    await b.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    a.clearInbox();
    b.clearInbox();
    return { a, b, code: state.code, playerId: wa.playerId };
  }

  test('闸门照旧：声明了 `matchClass` 的包进了已加载集合（它同时写了 `combat: true`）', () => {
    const packs = srv.lobby.welcomeInfo().mods.packs.map((p) => p.id);
    assert.deepEqual(packs, [HOOK_PACK], `装了 matchClass 的包必须在摘要里（没有它这一整组测试都是空转）：${JSON.stringify(packs)}`);
    assert.deepEqual(bare.lobby.welcomeInfo().mods.packs.map((p) => p.id), [PLAIN_PACK]);
  });

  test('钩子被调到一次，参数就是 `playerId` 与那条 `pack.msg` 原样；返回 undefined ⇒ 照旧转发', async () => {
    const { a, b, playerId } = await started();
    resetCalls();
    a.send({ t: 'pack.msg', pack: HOOK_PACK, channel: 'chat', data: { text: '你好', n: 3 } });
    const got = await b.waitFor('pack.msg');
    assert.equal(calls().length, 1, '钩子恰好被调到一次');
    const c = calls()[0];
    assert.equal(c.t, 'pack.msg', '拿到的就是那条消息本身（不是转发出去的帧）');
    assert.equal(c.pack, HOOK_PACK);
    assert.equal(c.channel, 'chat');
    assert.deepEqual(c.data, { text: '你好', n: 3 }, '载荷原样，引擎不改写');
    assert.equal(c.playerId, playerId, '第一个参数是发送者的 playerId');
    assert.deepEqual(got, { t: 'pack.msg', pack: HOOK_PACK, channel: 'chat', from: playerId, data: { text: '你好', n: 3 } },
      '未消费时转发出去的帧与今天逐字相同');
  });

  test('返回 `true` = 已消费：同房其它人收不到，发送者也收不到今天的那个回显', async () => {
    const { a, b } = await started();
    resetCalls();
    const r = await a.request({ t: 'pack.msg', pack: HOOK_PACK, channel: 'skins', data: 1 });
    assert.equal(r.t, 'ok', `已消费不是错误：${JSON.stringify(r)}`);
    assert.equal(calls().length, 1, '钩子跑过了');
    await b.expectNone('pack.msg', () => true, 300);
    await a.expectNone('pack.msg', () => true, 300);
  });

  test('返回 `{ consumed: true }` 同样算已消费', async () => {
    const { a, b } = await started();
    resetCalls();
    a.send({ t: 'pack.msg', pack: HOOK_PACK, channel: 'obj', data: { k: 2 } });
    await b.expectNone('pack.msg', () => true, 300);
    assert.equal(calls().length, 1, '钩子跑过了，只是这次它消费掉了');
  });

  test('返回 `false` = 未消费，转发照旧', async () => {
    const { a, b, playerId } = await started();
    resetCalls();
    a.send({ t: 'pack.msg', pack: HOOK_PACK, channel: 'no', data: 'x' });
    assert.deepEqual(await b.waitFor('pack.msg'),
      { t: 'pack.msg', pack: HOOK_PACK, channel: 'no', from: playerId, data: 'x' });
    assert.equal(calls().length, 1);
  });

  test('投递收窄：只被**面板**声明、模块没声明的通道投不进对局，但照旧转发', async () => {
    const { a, b, playerId } = await started();
    resetCalls();
    a.send({ t: 'pack.msg', pack: HOOK_PACK, channel: PANEL_ONLY, data: { panelOnly: true } });
    // 转发是**面板**那半边（§1.9.6）的判据：面板声明过，帧照旧送达同房的人（收窄没有动这一条）。
    assert.deepEqual(await b.waitFor('pack.msg'),
      { t: 'pack.msg', pack: HOOK_PACK, channel: PANEL_ONLY, from: playerId, data: { panelOnly: true } },
      '面板声明过的通道照旧转发');
    // 投递是**这一格**（§28.23）的判据：模块没把它写进 `channels` ⇒ 它不是接收入口，对局一次都不该被调到。
    // 钩子在转发之前跑，所以这一条不依赖计时：去掉 `packMsg` 里那道收窄的接线，这里就会是 1。
    assert.equal(calls().length, 0, '模块没声明的通道投不进对局（只被面板声明不够）');
  });

  test('钩子抛错：点名日志一条，转发照旧（坏消息不外溢）', async () => {
    const { a, b, code, playerId } = await started();
    resetCalls();
    const before = lines.error.length;
    a.send({ t: 'pack.msg', pack: HOOK_PACK, channel: 'boom', data: 7 });
    assert.deepEqual(await b.waitFor('pack.msg'),
      { t: 'pack.msg', pack: HOOK_PACK, channel: 'boom', from: playerId, data: 7 }, '抛错一律当作「未消费」继续转发');
    assert.equal(calls().length, 1, '抛错发生在钩子内部，钩子本身是被调到了的');
    const named = lines.error.slice(before);
    assert.equal(named.length, 1, `点名日志恰好一条，实际 ${JSON.stringify(named)}`);
    assert.match(named[0], /match\.handlePackMsg threw/, '日志必须点到那个方法名');
    assert.match(named[0], new RegExp(code), '日志必须带上房间号');
    assert.match(named[0], /hook boom/, '原始错误不能吞掉');
  });

  test('没声明 `matchClass` 的包拿不到这个钩子：MatchClass 上就没有它，行为与今天一致', async () => {
    const { a, b, code, playerId } = await started(bare, bareDigest);
    assert.equal(typeof bare.lobby.getRoom(code).match.handlePackMsg, 'undefined',
      '没有任何包声明 matchClass 时，MatchClass 不该多出这个方法');
    resetCalls();
    a.send({ t: 'pack.msg', pack: PLAIN_PACK, channel: 'chat', data: { hi: true } });
    assert.deepEqual(await b.waitFor('pack.msg'),
      { t: 'pack.msg', pack: PLAIN_PACK, channel: 'chat', from: playerId, data: { hi: true } });
    assert.equal(calls().length, 0, '没有这条钩子，自然一次都不该被调到');
  });

  test('既有判据排在钩子前面：面板没声明的通道、不在房间都到不了对局', async () => {
    const { a } = await started();
    resetCalls();
    const bad = await a.request({ t: 'pack.msg', pack: HOOK_PACK, channel: 'nope', data: {} });
    assert.equal(bad.t, 'error');
    assert.equal(bad.code, 'BAD_MSG');
    assert.match(bad.detail || '', /does not declare the channel "nope"/);
    assert.equal(calls().length, 0, '面板那半边的通道判据（§1.9.6）排在钩子之前');

    const solo = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
    clients.push(solo);
    await solo.hello(`S${clients.length}`);
    const notIn = await solo.request({ t: 'pack.msg', pack: HOOK_PACK, channel: 'chat', data: {} });
    assert.equal(notIn.t, 'error');
    assert.equal(notIn.code, 'NOT_IN_ROOM');
    assert.equal(calls().length, 0, '「在房间里」这条也排在钩子之前');
  });

  test('限流排在钩子前面：回 `ok` 的条数 === 钩子被调到的次数（不依赖计时）', async () => {
    const { a } = await started();
    resetCalls();
    let ok = 0;
    for (let i = 0; i < 23; i++) {
      const r = await a.request({ t: 'pack.msg', pack: HOOK_PACK, channel: 'chat', data: { i } });
      if (r.t === 'ok') { ok += 1; continue; }
      assert.equal(r.code, 'RATE', `第 ${i + 1} 条只可能是被限流拒掉：${JSON.stringify(r)}`);
      assert.equal(ok, 20, 'burst 用完之前不该有一条被拒（PACK_MSG_LIMITS.burst）');
    }
    assert.ok(ok >= 20, `burst 那 20 条必须全过，实际 ${ok}`);
    assert.equal(calls().length, ok, '每一条被接受的都到过对局，每一条被拒的都没到');
  });
});
