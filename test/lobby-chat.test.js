// 房内聊天（引擎特性）：打字聊天与快捷短语。
//
// 这两样**不是包能力** —— 包要用自己的消息走 `client.panels[].messages` + `pack.msg`（docs/WORKSHOP.md §1.9.6）。
// 因此它们必须作为引擎特性被完整钉住：形状（shared/protocol.js）、裁决（server/lobby.js 的 chat / quickMsg）、
// 广播与回放（sayInRoom / addChat / runResync）、以及三条硬边界：
//
//   * **旁观者收得到、说不了**（与既有 `g.*` 同一条口径：`ERR.SPECTATOR`）；
//   * **超长是截断，不是拒绝**（按 Unicode 码点，一个 emoji 算 1 个 —— 昵称 `sanitizeName` 的同一条思路）；
//   * **聊天永不落盘**（内存环形缓冲；用一个哨兵字符串钉住）。
//
// 真服务器 + 真 WebSocket，脚手架与 test/lobby.test.js 同一套（`startServer({ port: 0 })` + TestClient）。
//
// Run: node --test test/lobby-chat.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { CHAT_LIMITS, QUICK_MSG_LIMITS, isQuickId, isQuickArg, isChatMode } from '../shared/protocol.js';
import { DEFAULT_QUICK_PHRASES, chatText } from '../server/lobby.js';
import { ERR } from '../shared/constants.js';

let srv;
/** 每个用例自己连自己的客户端，收尾统一关掉。 */
const open = new Set();

const connect = async () => {
  const c = await TestClient.connect(`${srv.url.replace(/^http/, 'ws')}/ws`);
  open.add(c);
  return c;
};
/** 连上并 hello，返回带 `.id` / `.token` 的客户端。 */
const player = async (name, token) => {
  const c = await connect();
  const w = await c.hello(name, token);
  c.id = w.playerId;
  c.token = w.token;
  return c;
};
/** 开一个合作房，返回房间码。**先挂等待再发请求**，避免被「离开旧房」那一帧先吃掉。 */
const createRoom = async (c, extra = {}) => {
  const pending = c.waitFor('room.state', (s) => s.hostId === c.id && s.code);
  const r = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', ...extra });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const state = await pending;
  // 把模式确认也吃掉：调用方常常紧接着断言 chatMode，别让它去等下一次广播
  return state.code;
};
/** 加入房间并**返回那一帧 room.state**（调用方常常要断言它，别让 state 被 helper 吃掉）。 */
const joinRoom = async (c, code) => {
  const pending = c.waitFor('room.state', (s) => s.code === code && s.seats.some((x) => x && x.playerId === c.id));
  const r = await c.request({ t: 'room.join', code });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  return pending;
};
/** 发一条消息并等它的直接回复。 */
const reply = (c, msg) => c.request(msg);

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true }); });
after(async () => {
  await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
  open.clear();
  await srv?.close();
});

// ---------------------------------------------------------------------------------------------------
// 一、形状（纯函数，不起服务器）
// ---------------------------------------------------------------------------------------------------

test('协议形状：text 有入站上限，ids 是逗号分隔的短列表，arg 是可选短参，mode 是三态', () => {
  assert.ok(CHAT_LIMITS.inbound >= CHAT_LIMITS.text, '入站守卫必须比截断上限宽（否则截断路径到不了）');
  assert.ok(CHAT_LIMITS.history > 0);
  assert.equal(isQuickId('niceOne'), true);
  assert.equal(isQuickId('niceOne,myBad'), true);
  assert.equal(isQuickId(''), false);
  assert.equal(isQuickId('a,b,c,d'), false, `最多 ${QUICK_MSG_LIMITS.ids} 个`);
  assert.equal(isQuickId('has space'), false);
  assert.equal(isQuickId('a'.repeat(QUICK_MSG_LIMITS.idLen + 1)), false);
  assert.equal(isQuickArg('上路'), true);
  assert.equal(isQuickArg('a'.repeat(25)), false);
  assert.equal(isQuickArg('a\nb'), false);
  assert.equal(isChatMode('open') && isChatMode('quick') && isChatMode('off'), true);
  assert.equal(isChatMode('nope'), false);
});

test('chatText：按码点截断、控制字符变空格、全是空白 ⇒ 空串', () => {
  assert.equal(chatText('  hi  '), 'hi');
  assert.equal(chatText('a\nb\tc'), 'a b c', '控制字符不能给消息排版的能力');
  assert.equal(chatText('   \n\t '), '');
  assert.equal(chatText(null), '');
  assert.equal(chatText(42), '');
  const emoji = '🙂'.repeat(CHAT_LIMITS.text + 5);
  const cut = chatText(emoji);
  assert.equal([...cut].length, CHAT_LIMITS.text, '截断按码点计');
  assert.equal(cut.includes('\uFFFD'), false, '不许出现替换字符（那就是把一个 emoji 劈开了）');
});

test('默认快捷短语表非空、id 合法且不重复（客户端按同一批 id 渲染文案）', () => {
  assert.ok(DEFAULT_QUICK_PHRASES.length > 0);
  for (const id of DEFAULT_QUICK_PHRASES) assert.equal(isQuickId(id), true, `"${id}" 必须是合法 id`);
  assert.equal(new Set(DEFAULT_QUICK_PHRASES).size, DEFAULT_QUICK_PHRASES.length);
});

// ---------------------------------------------------------------------------------------------------
// 二、真服务器：广播、裁决、边界
// ---------------------------------------------------------------------------------------------------

test('真服务器：同房间的人互相收得到，不在房间里的人收不到', async () => {
  const a = await player('A');
  const b = await player('B');
  const code = await createRoom(a);
  await joinRoom(b, code);
  const gotB = b.waitFor('chat.msg');
  await reply(a, { t: 'room.chat', text: '你好' });
  const m = await gotB;
  assert.equal(m.text, '你好');
  assert.equal(m.name, 'A', '消息带发信人名字（客户端不必自己查表）');
  assert.equal(typeof m.at, 'number', '带时间戳');
  // 第三个连接不在房间里：什么都收不到
  const c = await player('C');
  await c.expectNone('chat.msg', null, 250);
});

test('真服务器：旁观者收得到、说不了（SPECTATOR）', async () => {
  const a = await player('A');
  const b = await player('B');
  const code = await createRoom(a);
  const r = await reply(b, { t: 'room.spectate', code });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const got = b.waitFor('chat.msg');
  await reply(a, { t: 'room.chat', text: '看得见吗' });
  assert.equal((await got).text, '看得见吗', '旁观者收得到');
  const err = await reply(b, { t: 'room.chat', text: '我要说话' });
  assert.equal(err.t, 'error');
  assert.equal(err.code, ERR.SPECTATOR, '旁观者说不了');
});

test('真服务器：不在房间里回 NOT_IN_ROOM', async () => {
  const a = await player('A');
  const err = await reply(a, { t: 'room.chat', text: '有人吗' });
  assert.equal(err.t, 'error');
  assert.equal(err.code, ERR.NOT_IN_ROOM);
});

test('真服务器：chatMode 由服务端强制（quick 只放短语、off 全禁）', async () => {
  const a = await player('A');
  const b = await player('B');
  const code = await createRoom(a, { chatMode: 'quick' });
  await joinRoom(b, code);
  const typed = await reply(b, { t: 'room.chat', text: '打字' });
  assert.equal(typed.code, ERR.CHAT_MODE, 'quick 模式不许打字');
  const got = b.waitFor('chat.msg');
  await reply(a, { t: 'room.quickMsg', ids: 'niceOne' });
  assert.deepEqual((await got).quick, ['niceOne'], '短语照常');
  // off：连短语也不许。**另开一个房**（房主换人，免得旧房的 state 混淆）。
  const code2 = await createRoom(b, { chatMode: 'off' });
  const st2 = await joinRoom(a, code2);
  assert.equal(st2.chatMode, 'off', 'room.state 要把模式报给客户端（界面照着它摆样子）');
  const q = await reply(a, { t: 'room.quickMsg', ids: 'niceOne' });
  assert.equal(q.code, ERR.CHAT_MODE, 'off 模式连短语也禁');
});

test('真服务器：短语 id 必须在服务端白名单里（不认识就点名拒绝）', async () => {
  const a = await player('A');
  await createRoom(a);
  const err = await reply(a, { t: 'room.quickMsg', ids: 'notARealPhrase' });
  assert.equal(err.t, 'error');
  assert.equal(err.code, ERR.BAD_MSG, '未声明的短语 id 必须响亮拒绝，不能静默转发');
});

test('真服务器：超长被截断而不是被拒；全空白不广播也不报错', async () => {
  const a = await player('A');
  const b = await player('B');
  const code = await createRoom(a);
  await joinRoom(b, code);
  const got = b.waitFor('chat.msg');
  await reply(a, { t: 'room.chat', text: 'x'.repeat(CHAT_LIMITS.text + 50) });
  assert.equal((await got).text.length, CHAT_LIMITS.text, '超长截断，不是拒绝');
  const ok = await reply(a, { t: 'room.chat', text: '   \n  ' });
  assert.equal(ok.t, 'ok', '空白消息不是错误（它只是什么都没说）');
  await b.expectNone('chat.msg', null, 250);
});

test('真服务器：重连补发 chat.history，且只发给重连的那一个会话', async () => {
  const a = await player('A');
  const b = await player('B');
  const code = await createRoom(a);
  await joinRoom(b, code);
  await reply(a, { t: 'room.chat', text: '第一句' });
  await reply(a, { t: 'room.chat', text: '第二句' });
  // b 掉线重连：应收到 chat.history（只给他）
  const token = b.token;
  await b.terminate();
  const back = await player('B', token);
  const h = await back.waitFor('chat.history');
  assert.ok(Array.isArray(h.messages) && h.messages.length >= 2, '至少要带回刚才那两句');
  assert.deepEqual(h.messages.slice(-2).map((m) => m.text), ['第一句', '第二句']);
  a.clearInbox();
  await a.expectNone('chat.history', null, 250);
});

test('聊天永不落盘：/healthz 不带聊天内容（哨兵字符串钉住）', async () => {
  const a = await player('A');
  const b = await player('B');
  const code = await createRoom(a);
  await joinRoom(b, code);
  const SENTINEL = 'SENTINEL-CHAT-MUST-NOT-PERSIST-7f3a';
  await reply(a, { t: 'room.chat', text: SENTINEL });
  await new Promise((r) => setTimeout(r, 80));
  const room = srv.lobby.getRoom(code);
  assert.ok(room.chat.some((m) => m.text === SENTINEL), '房间内存里有它（回放要用）');
  const health = await fetch(`${srv.url}/healthz`).then((r) => r.text());
  assert.equal(health.includes(SENTINEL), false, 'healthz 不该带聊天内容');
});

test('上限：环形缓冲只留最近 CHAT_LIMITS.history 条', async () => {
  const a = await player('A');
  const code = await createRoom(a);
  const room = srv.lobby.getRoom(code);
  for (let i = 0; i < CHAT_LIMITS.history + 12; i++) {
    room.addChat({ t: 'chat.msg', from: 'a', name: 'A', seat: 0, at: i, text: `m${i}` });
  }
  assert.equal(room.chat.length, CHAT_LIMITS.history, '环形缓冲有上限');
  assert.equal(room.chat[room.chat.length - 1].text, `m${CHAT_LIMITS.history + 11}`, '留的是最近的');
  assert.equal(room.chat[0].text, 'm12', '最旧的被丢掉了');
});

test('限流：连发撞 RATE，桶按会话且打字与短语各自一份', async () => {
  const a = await player('A');
  await createRoom(a);
  let hit = false;
  for (let i = 0; i < 40 && !hit; i++) {
    const r = await reply(a, { t: 'room.chat', text: `spam ${i}` });
    if (r.t === 'error' && r.code === ERR.RATE) hit = true;
  }
  assert.ok(hit, '连发必须撞到 RATE');
  // 关键：**短语有自己的桶** —— 打字把额度用光不该让短语也说不出话（否则一次连点就能封住另一样）
  const quick = await reply(a, { t: 'room.quickMsg', ids: 'thanks' });
  assert.equal(quick.t, 'ok', '打字撞限流不该连带把短语封掉（两种消息各自一只桶）');
  // 连接仍然可用：再打一条打字消息应当还是 RATE（桶还没回满），而不是断线
  const again = await reply(a, { t: 'room.chat', text: 'still limited' });
  assert.equal(again.t, 'error');
  assert.equal(again.code, ERR.RATE, '桶还没回满 ⇒ 仍旧是 RATE（连接没被打死）');
  assert.equal(a.isOpen, true, '限流不该关掉连接');
});
