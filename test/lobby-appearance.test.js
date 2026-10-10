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
import { isAppearanceMsg, APPEARANCE_LIMITS, validateC2S } from '../shared/protocol.js';
import { TestClient } from './helpers/wsClient.js';

// ---------------------------------------------------------------------------------------------------
// 一、形状（纯函数，不起服务器）
//
// 两个字段**刻意分开**：`picks` 是**按干员**的换装、`avatar` 是**玩家自己**那张头像。
// 混成一个（原来那样把头像塞进 `picks` 需要一个假的 charId 当键）是把「人的选择」硬塞进「干员的选择」。
// ---------------------------------------------------------------------------------------------------

describe('room.appearance：形状判据（服务端与客户端共用同一份）', () => {
  test('接受：只给 picks / 只给 avatar / 两个都给', () => {
    assert.equal(isAppearanceMsg({ picks: { char_1_01: { skinId: 'summer' } } }), true);
    assert.equal(isAppearanceMsg({ avatar: { avatar: 'a_1' } }), true);
    assert.equal(isAppearanceMsg({ picks: { char_1_01: { avatar: 'char_1_01' } }, avatar: { avatar: 'a_1' } }), true);
    assert.equal(isAppearanceMsg({ picks: {} }), true, '空 picks 是合法的（只是什么都没改）');
  });

  test('拒绝：两个都不给 / 未知字段 / 一项里 skinId 与 avatar 都给或都不给', () => {
    const bad = [
      {},                                                             // 什么都没说
      { picks: { char_1_01: { skinId: 'a', avatar: 'b' } } },         // 恰好一个，不是「取其一」
      { picks: { char_1_01: {} } },
      { picks: { char_1_01: { skinId: '' } } },
      { avatar: {} },
      { avatar: { skinId: 'x' } },                                    // avatar 那一项只能是 { avatar }
      { picks: {}, nope: 1 },                                         // 未知字段
    ];
    for (const v of bad) assert.equal(isAppearanceMsg(v), false, `${JSON.stringify(v)} 应当被拒`);
    assert.equal(isAppearanceMsg(null), false);
    assert.equal(isAppearanceMsg([]), false, '数组不是对象');
  });

  test('$check 拿到的是整条消息：信封字段（t / rid）不算载荷，不该把它判成坏形状', () => {
    // 这一条是踩过的坑：`$check` 收到 `{ t, rid, ... }`，判据若不忽略 `t`/`rid`，
    // **每一条**都会被判成坏形状（这一版第一次跑就是全红）。
    assert.equal(isAppearanceMsg({ t: 'room.appearance', rid: 3, avatar: { avatar: 'a_1' } }), true);
    assert.equal(validateC2S({ t: 'room.appearance', rid: 3, avatar: { avatar: 'a_1' } }), null);
  });

  test('上限 64 项（多出来的是坏数据，不是「更多的时装」）', () => {
    const n = (k) => ({ picks: Object.fromEntries(Array.from({ length: k }, (_, i) => [`char_${i}`, { skinId: 's' }])) });
    assert.equal(isAppearanceMsg(n(APPEARANCE_LIMITS.picks)), true);
    assert.equal(isAppearanceMsg(n(APPEARANCE_LIMITS.picks + 1)), false);
  });

  test('validateC2S 认得这条消息（进了 C2S 表，而不是走 default 分支）', () => {
    assert.equal(validateC2S({ t: 'room.appearance', picks: { char_1_01: { skinId: 'summer' } } }), null);
    assert.ok(validateC2S({ t: 'room.appearance' }), '都不给要被拒');
    assert.ok(validateC2S({ t: 'room.appearance', picks: { char_1_01: {} } }), '坏形状要被 C2S 层拒掉');
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
const appOf = (viewer, ownerId, charId) => seatOf(viewer, ownerId)?.appearance?.picks?.[charId];
/** 玩家自己那张头像（`appearance.avatar`）。 */
const ownAvatarOf = (viewer, ownerId) => seatOf(viewer, ownerId)?.appearance?.avatar;

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
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_1_01')), '客人等到了房主的换装');
    assert.deepEqual({ ...appOf(guest, host.id, 'char_1_01') }, { skinId: 'summer' });
    assert.deepEqual(Object.keys(seatOf(guest, host.id).appearance.picks), ['char_1_01'], '只带选过的那一条');
    // 客人自己没选 ⇒ 他那一席不带这个键（两台客户端看到的是同一份状态）
    assert.equal(seatOf(host, guest.id).appearance, undefined);
  });

  test('玩家自己的头像（`avatar`）同样可见，且与 `picks` **互不干扰**', async () => {
    const { host, guest } = await pair();
    // 先换装
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_2_02: { skinId: 'winter' } } })).t, 'ok');
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_2_02')));
    // 再只换头像 —— 浅合并：**换头像不该把皮肤清空**（两个字段说的是两件事）
    assert.equal((await host.request({ t: 'room.appearance', avatar: { avatar: 'a_7' } })).t, 'ok');
    assert.ok(await until(guest, () => ownAvatarOf(guest, host.id)));
    assert.deepEqual({ ...ownAvatarOf(guest, host.id) }, { avatar: 'a_7' });
    assert.deepEqual({ ...appOf(guest, host.id, 'char_2_02') }, { skinId: 'winter' }, '换头像没动已经选好的皮肤');
    // 反向：只换装也不该动头像
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_2_02: { skinId: 'summer' } } })).t, 'ok');
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_2_02')?.skinId === 'summer'), '后一次覆盖前一次');
    assert.deepEqual({ ...ownAvatarOf(guest, host.id) }, { avatar: 'a_7' }, '换装没动头像');
  });

  test('服务端**不判定内容**：一个不存在的 skinId 也照转（由画的一方回落原版）', async () => {
    const { host, guest } = await pair();
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'no_such_skin_at_all' } } })).t, 'ok');
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_1_01')));
    assert.equal(appOf(guest, host.id, 'char_1_01').skinId, 'no_such_skin_at_all',
      '服务端看不见包内容，所以它只转发 —— 判定不属于这一层');
  });

  test('坏形状被 C2S 层拒掉，且不改动已有选择', async () => {
    const { host, guest } = await pair();
    assert.equal((await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'summer' } } })).t, 'ok');
    assert.ok(await until(guest, () => appOf(guest, host.id, 'char_1_01')));

    // 「两个都给」是坏消息（不是「取其一」）
    const bad = await host.request({ t: 'room.appearance', picks: { char_1_01: { skinId: 'a', avatar: 'b' } } });
    assert.equal(bad.t, 'error');
    assert.equal(bad.code, 'BAD_MSG');
    // 先前的选择仍在（一个坏消息不该把已经选好的清掉）
    assert.equal(appOf(guest, host.id, 'char_1_01').skinId, 'summer');
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
    const i = src.indexOf('appearance(session, msg)');
    assert.ok(i > 0, '处理器在');
    const body = src.slice(i, i + 1400);
    assert.ok(!/ ROOM_STARTED/.test(body), '外观不因对局进行中而被拒 —— 它只改显示，不碰战果');
    // 对照：diy 有那条闸门（所以这条差别是真的，不是我记错了）
    const d = src.indexOf('diy(session, { picks })');
    assert.ok(/ROOM_STARTED/.test(src.slice(d, d + 900)), 'room.diy 确实有那条闸门');
  });
});
