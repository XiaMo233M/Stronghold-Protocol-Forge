// `room.appearance`（皮肤层）：**别人看到的你长什么样** —— 换装与头像的跨客户端可见性。
//
// 业主裁决是「皮肤与头像按明日方舟本家『时装』口径做、纯外观」，所以这一条消息有三条与
// `room.diy` / `room.ownership` **刻意不同**的性质，每一条都在这里测：
//   1. **服务端不判定内容**（形状由 `validateC2S` 卡死，但「这个 skinId 存不存在」要看包声明的 `assets.skins`，
//      而服务端看不见包内容）⇒ 只转发，不认识的项由画的一方回落原版；
//   2. **比赛中也接受**（纯展示、不碰战果，没有理由等下一局）；
//   3. **变更即广播**（外观是给别人看的，必须立刻到达同房的人）。
//
// Run: node --test test/lobby-appearance.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { isAppearancePicks, APPEARANCE_LIMITS, validateC2S } from '../shared/protocol.js';
import { TestClient } from './helpers/wsClient.js';

// ---------------------------------------------------------------------------------------------------
// 一、形状（纯函数，不起服务器）
// ---------------------------------------------------------------------------------------------------

describe('room.appearance：形状判据（服务端与客户端共用同一份）', () => {
  test('接受 { skinId } 与 { avatar }，以及空表', () => {
    assert.equal(isAppearancePicks({}), true);
    assert.equal(isAppearancePicks({ char_1_01: { skinId: 'summer' } }), true);
    assert.equal(isAppearancePicks({ char_2_02: { avatar: 'char_2_02' } }), true);
    assert.equal(isAppearancePicks({ a: { skinId: 'x' }, b: { avatar: 'y' } }), true);
  });

  test('拒绝：两个都给 / 都不给 / 空 id / 非字符串 id / 坏干员键', () => {
    const bad = [
      { char_1_01: { skinId: 'a', avatar: 'b' } },   // 恰好一个，不是「取其一」
      { char_1_01: {} },
      { char_1_01: { skinId: '' } },
      { char_1_01: { skinId: 5 } },
      { 'bad id': { skinId: 'x' } },
      { char_1_01: null },
    ];
    for (const v of bad) assert.equal(isAppearancePicks(v), false, `${JSON.stringify(v)} 应当被拒`);
    assert.equal(isAppearancePicks(null), false);
    assert.equal(isAppearancePicks([]), false, '数组不是表');
  });

  test('上限 64 项（多出来的是坏数据，不是「更多的时装」）', () => {
    const n = (k) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`char_${i}`, { skinId: 's' }]));
    assert.equal(isAppearancePicks(n(APPEARANCE_LIMITS.picks)), true);
    assert.equal(isAppearancePicks(n(APPEARANCE_LIMITS.picks + 1)), false);
  });

  test('validateC2S 认得这条消息（进了 C2S 表，而不是走 default 分支）', () => {
    assert.equal(validateC2S({ t: 'room.appearance', picks: { char_1_01: { skinId: 'summer' } } }), null);
    assert.ok(validateC2S({ t: 'room.appearance', picks: { char_1_01: {} } }), '坏形状要被 C2S 层拒掉');
    assert.ok(validateC2S({ t: 'room.appearance' }), '缺 picks 要被拒');
  });
});

// ---------------------------------------------------------------------------------------------------
// 二、真服务器端到端（两个真人同房：外观必须**跨客户端**可见，这是它存在的理由）
// ---------------------------------------------------------------------------------------------------

let srv;
/** 每个用例自己连自己的客户端，收尾统一关掉。 */
const open = new Set();

const player = async (name) => {
  const c = await TestClient.connect(`${srv.url.replace(/^http/, 'ws')}/ws`);
  open.add(c);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  /** 已经消费过的 `room.state` 里最新的那一份（`refresh` 更新它）。 */
  c.roomState = null;
  c.stops = [];
  return c;
};

/**
 * 取这一帧 `room.state`：优先吃 inbox 里已经到的那一份（可能有多份，取最新），否则等下一份。
 *
 * 为什么不是「后台轮询一直更新」：那会和 `request()` 自己那次 `waitFor` 抢同一批消息（两边都想消费），
 * 断言就会随机地看到旧的一帧。这里改成**要的时候才取**，每一次都拿到当时最新的一份。
 */
const refresh = async (c, ms = 2000) => {
  // 先把 inbox 里所有 room.state 都吃掉，最后一份就是最新的
  let latest = null;
  for (;;) {
    try { latest = await c.waitFor('room.state', () => true, 0); } catch { break; }
  }
  if (latest) c.roomState = latest;
  if (latest) return latest;
  c.roomState = await c.waitFor('room.state', () => true, ms);
  return c.roomState;
};

/** 等到 `pred(viewer.roomState)` 为真（每次重新取一帧），最多 `ms`。 */
const until = async (viewer, pred, ms = 2000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { await refresh(viewer, Math.max(0, Math.min(150, end - Date.now()))); } catch { /* 超时 */ }
    if (pred(viewer.roomState)) return true;
    if (Date.now() >= end) return false;
  }
};

/** 两个真人进同一间房（host 建房、guest 加入），两人都拿到含 2 个座位的状态。 */
const pair = async () => {
  const host = await player('房主');
  const created = host.waitFor('room.state', (s) => s.hostId === host.id && s.code);
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const st = await created;
  host.roomState = st;

  const guest = await player('客人');
  const joined = guest.waitFor('room.state', (s) => s.code === st.code && s.seats.some((x) => x && x.playerId === guest.id));
  assert.equal((await guest.request({ t: 'room.join', code: st.code })).t, 'ok');
  guest.roomState = await joined;
  // 建房者也该看到第二位进来（拿一份最新的）
  host.roomState = await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
  return { host, guest };
};

/** 「我看别人」：viewer 看到的 owner 那一席。 */
const seatOf = (viewer, ownerId) => (viewer.roomState?.seats || []).find((s) => s && s.playerId === ownerId);
const appOf = (viewer, ownerId, charId) => seatOf(viewer, ownerId)?.appearance?.[charId];

before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true }); });
after(async () => {
  await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
  open.clear();
  await srv?.close();
});

describe('room.appearance：真服务器端到端', () => {
  test('换装后**同房的人都看得到**（变更即广播），且只在该座位带 appearance 键', async () => {
    const { host, guest } = await pair();
    assert.equal((host.roomState.seats || []).every((s) => !s || s.appearance === undefined), true,
      '没换装时座位不带这个键');

    assert.equal((await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'summer' } } })).t, 'ok');
    // 广播要到达**另一个人**（这正是这条消息存在的理由）
    assert.ok(await until(guest, () => seatOf(guest, host.id)?.appearance), '客人等到了房主的外观');
    const mine = seatOf(guest, host.id);
    assert.deepEqual({ ...mine.appearance['char_1_01'] }, { skinId: 'summer' });
    assert.deepEqual(Object.keys(mine.appearance), ['char_1_01'], '只带选过的那一条');
    // 客人自己没选 ⇒ 他那一席不带这个键（两台客户端看到的是同一份状态）
    assert.equal(seatOf(host, guest.id).appearance, undefined);
  });

  test('{ avatar } 同样可见；后续变更覆盖前一次', async () => {
    const { host, guest } = await pair();
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_2_02: { avatar: 'char_2_02' } } })).t, 'ok');
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_2_02')));
    assert.deepEqual({ ...seatOf(guest, host.id).appearance['char_2_02'] }, { avatar: 'char_2_02' });

    assert.equal((await host.request({ t: 'room.appearance', picks: { char_2_02: { skinId: 'winter' } } })).t, 'ok');
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_2_02')?.skinId === 'winter'), '后一次覆盖前一次');
  });

  test('服务端**不判定内容**：一个不存在的 skinId 也照转（由画的一方回落原版）', async () => {
    const { host, guest } = await pair();
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'no_such_skin_at_all' } } })).t, 'ok');
    assert.ok(await until(guest, () => seatOf(guest, host.id)?.appearance));
    assert.equal(seatOf(guest, host.id).appearance['char_1_01'].skinId, 'no_such_skin_at_all',
      '服务端看不见包内容，所以它只转发 —— 判定不属于这一层');
  });

  test('坏形状被 C2S 层拒掉，且不改动已有选择', async () => {
    const { host, guest } = await pair();
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'summer' } } })).t, 'ok');
    assert.ok(await until(guest, () => seatOf(guest, host.id)?.appearance));

    // 「两个都给」是坏消息（不是「取其一」）
    const bad = await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'a', avatar: 'b' } } });
    assert.equal(bad.t, 'error');
    assert.equal(bad.code, 'BAD_MSG');
    // 先前的选择仍在（一个坏消息不该把已经选好的清掉）
    assert.equal(seatOf(guest, host.id).appearance['char_1_01'].skinId, 'summer');
  });

  test('不在房间里发 ⇒ 不崩（安静地什么都没发生）', async () => {
    const c = await player('路人');
    const r = await c.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'summer' } } });
    // 大厅层允许它先存在（会话上的偏好），但房间里没人受到影响；关键是**不是 INTERNAL**
    assert.notEqual(r.code, 'INTERNAL', `不该是内部错误：${JSON.stringify(r)}`);
  });
});

describe('room.appearance：与 room.diy 的两处刻意差别（读源码钉住设计）', () => {
  test('比赛中也接受：处理器里没有 ROOM_STARTED 那条闸门', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../server/lobby.js', import.meta.url), 'utf8');
    const i = src.indexOf('appearance(session, { picks })');
    assert.ok(i > 0, '处理器在');
    const body = src.slice(i, i + 1000);
    assert.ok(!/ ROOM_STARTED/.test(body), '外观不因对局进行中而被拒 —— 它只改显示，不碰战果');
    // 对照：diy 有那条闸门（所以这条差别是真的，不是我记错了）
    const d = src.indexOf('diy(session, { picks })');
    assert.ok(/ROOM_STARTED/.test(src.slice(d, d + 900)), 'room.diy 确实有那条闸门');
  });
});
