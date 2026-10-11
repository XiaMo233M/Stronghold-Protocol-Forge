// test/lobby-support-face.test.js — 助战的**可见面**（`supportView`）必须与**校验面**（`support()`）同源。
//
// 这是「大厅的校验面必须与对局面读同一份数据」那批修复的**第二处**。第一处改的是四个**校验**面
// （`room.loadout` / `room.support` / `room.ownership` / `room.diy`，见 test/lobby-room-face.test.js）。
// 剩下的这一处不是校验面，而是**可见面**：
//
//   * 修前 `Lobby.supportView()` 读 `this.safeData()`（进程级单例 = 官方 + **所有**已装包）；
//   * 而 `Lobby.support()`（同一个助战池的**判据**）在上一批修复后读 `this.roomData(room)`（房间自己那一份）；
//   * 两个面于是可以说不一致的话：一间没声明 `lr-beta` 的房间，界面上**列着** beta 的助战位（进程面有它），
//     玩家真去点、真发 `room.support`，却被 `checkSupport` 整条拒绝（房间面的池子里没有它）。
//     客户端**看得见却选不了** —— 这正是「一个数据两个面不同源」的第二种症状（第一种是上一批的静默丢失）。
//
// 这个文件钉住四件事：
//   1. §1 **子集房间**：`supportView(room)` 的池子**逐 id 等于房间面**（`roomData(room).support`）——
//      不再列出本房未声明那个包的助战位；本房自己的**照常列出**；两个面在这里**确实不同**（否则测不到东西）；
//      再加一条**行为**断言：可见面不列的 id，`room.support` 也真的拒绝（「看得见就能选」在两个面上同时成立）。
//   2. §2 **最硬的不变量**：未声明集合 / 无房间 / 全集 ⇒ `roomData(room)` 拿到的**就是** `safeData()` 那个对象
//      （`===`，不是「内容相同」），且 `supportView(room)` 与不带参数的输出**逐字节相同** ⇒ 4 座不变。
//   3. §3 **调用点**：`supportView` 真的按房间算（传房间 = 房间面，不传 = 进程面），且 `broadcastState` /
//      `sendState` 两个调用点都写成了 `this.supportView(room)` —— 「两个调用点都传对房间」这句话的落点。
//   4. §4 **wire 面**：真服务器 + 真房间，`broadcastState` / `sendState` 发出去的 `room.state.support`
//      里没有外来干员 —— 这是玩家真正看见的那一份，不是内部对象的影子。
//
// 夹具用**合成最小包**（两个包各带一个助战干员），因为要考的就是「进程面有、房间面没有」这条差值：
// 一间只声明 alpha 的房间，进程面的池子里有 beta、房间面的池子里没有 —— 修前 `supportView()` 读进程面 ⇒
// 界面上看得见 beta。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { normalizeSupportConfig, supportPicker } from '../shared/support.js';
import { TestClient } from './helpers/wsClient.js';

/** `[evidence]` 行：原始输出，报告直接抄它。 */
const say = (...a) => console.log('[evidence]', ...a);

/** 每个包一个干员：`sr-alpha` 会被子集房间声明，`sr-beta` 只被进程装载（这个就是「看得见却选不了」那个）。 */
const OP_A = 'chess_ws_sr_alpha_a';
const OP_B = 'chess_ws_sr_beta_a';
const PACKS = { A: 'sr-alpha', B: 'sr-beta' };
/**
 * 两个干员的阶级都取 **5**：`data/support.json` 只给 **5 / 6** 阶配了 `slots > 0`，而
 * `shared/support.js supportTiers` 只列出 `slots[tier] > 0` 且卡池非空的阶 —— 一个 4 阶的干员即使
 * 已经发布进了 `pool["4"]`，也**不会出现在任何 picker 阶里**（那样这条差值就测不到）。
 * 用官方本来就有 slots 的阶级，测的才是「谁进的池子」而不是「装了没有」。
 */
const SUPPORT_TIER = 5;

/**
 * 一条最小但**合法**的干员记录：`shared/workshop.js` 的包级 chess 校验、`shared/support.js` 的
 * `isSupportChess`（要求 `visible !== false && !isHidden && !isDiy && !isGolden` 且有整数 tier，
 * 且 id 正好挂在自己的 tier 下）都要能吃下它。
 */
function chessRecord(id, tier, charId) {
  return {
    tier, isHidden: false, isDiy: false, visible: true, chessType: 'NORMAL', name: id, appellation: id,
    charId, profession: 'PIONEER', subProfessionId: 'pioneer', subProfessionName: 'pioneer', position: 'MELEE',
    nationId: null, bonds: [], garrisonIds: [], price: 3, sellPrice: 1,
    immunities: { stun: false, silence: false, sleep: false, frozen: false, levitate: false },
    rangeId: null, rangeGrid: [[0, 0]], dmgType: 'phys', attackKind: 'melee', projectile: 'none', canHitFly: false,
    targetPriority: null, trait: { desc: '', descRaw: '', bb: {}, bbStr: {}, rangeGrid: null }, tokens: [],
    assets: { avatar: null, portrait: null, spine: null, skillIcon: null, subProfIcon: null },
    workshop: { schema: 1, id },
    chessId: id, baseId: id, goldenId: null, isGolden: false, rarity: tier, upgradeNum: 0, upgradeChessId: null,
    status: { phase: 0, level: 1, skillLevel: 1, equipLevel: 0 },
    stats: {
      maxHp: 1000, atk: 100, def: 100, res: 0, cost: 10, blockCnt: 1, bat: 1, aspd: 100,
      respawnTime: 70, spRecovery: 1, hpRecoveryPerSec: 0, moveSpeed: 1, tauntLevel: 0, massLevel: 0, deployLimit: 1, deckStack: 0,
    },
    skill: { skillId: `skchr_${id}`, index: 0, isDefault: true },
    skills: [
      { skillId: `skchr_${id}`, index: 0, isDefault: true },
      { skillId: `skchr_${id}_2`, index: 2, isDefault: false },
    ],
    talents: [],
    module: { id: null, name: null, type: null, level: 1, active: false },
  };
}

/**
 * 一个声明了**助战**的包：`pack.json` 的 `support: [<自己那个干员>]` 会被 `shared/workshop.js`
 * `workshopSupportEntries` 解析成卡池条目 —— 它只认「**本包自己新增**的干员」（外来干员会被
 * `SUPPORT_FOREIGN_OPERATOR` 拒掉，那会让这条差值测不出来）。
 */
function writePack(root, id, chessId, tier, charId) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', content: ['chess'], overrides: [], support: [chessId],
  }));
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({ [chessId]: chessRecord(chessId, tier, charId) }));
}

/** 一个 `supportView` 输出 → 「tier → id 列表」的形状，方便与数据面逐 id 对比。 */
const viewPool = (view) => {
  const out = {};
  for (const t of view.tiers) out[String(t.tier)] = [...t.ids];
  return out;
};
/** 数据面的卡池：**照 `supportView` 的算法独立复算**（`normalizeSupportConfig` + `supportPicker` 都是纯函数）。 */
const facePool = (data) => {
  const cfg = normalizeSupportConfig(data && data.support);
  const out = {};
  for (const t of supportPicker(cfg)) out[String(t.tier)] = [...t.ids];
  return out;
};
/** 一个池子里的全部 id（跨 tier 展平、排序）—— 「列不列出某个干员」这句断言就用它。 */
const flatIds = (pool) => Object.values(pool).flat().sort();

let tmp;
let srv;
/** 三个房间：声明子集（只有 alpha）/ 声明全集 / 没声明。 */
let sub; let all; let plain;
/** 一个「无房间」的会话（用来钉住 §2 的第三条：没有房间时必须还是进程级本体）。 */
let lobby;

const open = async (name, modIds) => {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  const welcome = await c.hello(name);
  const reply = await c.request({
    t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: welcome.mods.digest, ...(modIds ? { modIds } : {}),
  });
  assert.equal(reply.t, 'ok', `${name} room.create: ${JSON.stringify(reply)}`);
  const state = await c.waitFor('room.state', (s) => !!s.code && Array.isArray(s.seats));
  const room = srv.lobby.rooms.get(state.code);
  assert.ok(room, `${name}: 房间必须在会话栈里`);
  return { c, welcome, room, state };
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobbysupportface-'));
  const wsRoot = path.join(tmp, 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });
  writePack(wsRoot, PACKS.A, OP_A, SUPPORT_TIER, 'char_sr_alpha');
  writePack(wsRoot, PACKS.B, OP_B, SUPPORT_TIER, 'char_sr_beta');

  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
  const mods = srv.lobby.workshop.mods;
  assert.deepEqual(mods.map((m) => m.id).sort(), [PACKS.A, PACKS.B].sort(), '夹具的两个包必须都装载了');

  sub = await open('Sub', [PACKS.A]);
  all = await open('All', [PACKS.A, PACKS.B]);
  plain = await open('Plain');
  lobby = { c: await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`) };
  await lobby.c.hello('NoRoom');

  // —— 夹具前提（否则下面的断言说的不是同一件事）——
  assert.equal(sub.room.modSet.digest === all.room.modSet.digest, false, '子集房间与全集房间必须是两条不同的路');
  assert.equal(plain.room.modSet, null, '没声明集合的房间 `modSet` 必须是 null');
  // 两个包自己的声明确实进了**进程面**的卡池（`shared/workshop.js` 的助战叠加就是这样发布的）
  const procPool = pool();
  assert.ok(flatIds(procPool).includes(OP_A), `进程面卡池里必须有 ${OP_A}`);
  assert.ok(flatIds(procPool).includes(OP_B), `进程面卡池里必须有 ${OP_B}`);
  // 而**子集房间**那一份里只有自己那个：这就是差值本身
  const subPool = pool(sub.room);
  assert.ok(flatIds(subPool).includes(OP_A), `房间面卡池里必须有 ${OP_A}`);
  assert.equal(flatIds(subPool).includes(OP_B), false, `房间面卡池里不该有 ${OP_B}`);
  say('夹具：装载的包 =', mods.map((m) => m.id), '| 进程面卡池 =', JSON.stringify(flatIds(procPool)),
    '| 子集房间面卡池 =', JSON.stringify(flatIds(subPool)));
});

after(async () => {
  for (const x of [sub, all, plain, lobby]) await x?.c?.terminate();
  await srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------
// 两个面的取值口（探针只走公开入口）
// ---------------------------------------------------------------------------------------------------
/** 房间裁剪面（这一局真正会跑的那一份）。`room=null` ⇒ 进程级本体。 */
const roomData = (room) => srv.lobby.roomData(room);
/** 数据面卡池。省略房间 ⇒ 进程面本体。 */
const pool = (room = null) => facePool(roomData(room));

// ---------------------------------------------------------------------------------------------------
// §1 — 子集房间：可见面 = 房间面（外来助战位不再列出来；本房自己的照常列出）
// ---------------------------------------------------------------------------------------------------
describe('§1 子集房间（只声明 sr-alpha）：`supportView(room)` 列的就是房间面那一份', () => {
  test('可见面的池子逐 id 等于房间面；外来干员不在里面，本房干员还在里面', () => {
    const view = srv.lobby.supportView(sub.room);
    const fromView = viewPool(view);
    const fromRoomFace = pool(sub.room);
    const fromProcessFace = pool();

    // (1) 逐 id 相等：可见面**就是**房间那面自己算出来的（不是「看起来差不多」）
    assert.deepEqual(fromView, fromRoomFace, '可见面必须逐 id 等于房间面');
    // (2) 差值是**真的**：进程面与房间面在这里确实不同 —— 否则这条测试测不到东西
    assert.notDeepEqual(fromProcessFace, fromRoomFace, '两个面的卡池必须真的不同（否则测不到东西）');
    // (3) 外来干员（只有进程声明了 sr-beta）：修前会列出来，现在不列
    assert.equal(flatIds(fromView).includes(OP_B), false, `未声明包的助战位不该出现在可见面：${OP_B}`);
    assert.equal(flatIds(fromProcessFace).includes(OP_B), true, `进程面确实有 ${OP_B}（这就是修前的「看得见」）`);
    // (4) 本房自己的那个：照常列出
    assert.equal(flatIds(fromView).includes(OP_A), true, `本房声明的助战位必须照常列出：${OP_A}`);
    say('§1 子集房间：supportView(room) 卡池 =', JSON.stringify(flatIds(fromView)),
      '| 房间面卡池 =', JSON.stringify(flatIds(fromRoomFace)),
      '| 进程面卡池 =', JSON.stringify(flatIds(fromProcessFace)));
    say('§1 逐 id 相等 ?', JSON.stringify(fromView) === JSON.stringify(fromRoomFace),
      '| 可见面含', OP_B, '?', flatIds(fromView).includes(OP_B),
      '| 可见面含', OP_A, '?', flatIds(fromView).includes(OP_A));
  });

  test('可见面的**其余每一个字段**也来自房间面（enabled/label/slots/capacity）', () => {
    const view = srv.lobby.supportView(sub.room);
    const cfg = normalizeSupportConfig(roomData(sub.room).support);
    assert.equal(view.enabled, cfg.enabled);
    assert.equal(view.label, cfg.label);
    assert.equal(view.capacity, Object.values(view.slots).reduce((n, v) => n + v, 0), 'capacity 必须等于 slots 之和');
    assert.deepEqual(view.slots, { ...cfg.slots }, 'slots 必须来自房间面那一份');
    assert.deepEqual(view.tiers.map((t) => t.tier), Object.keys(cfg.slots).map(Number)
      .filter((t) => cfg.slots[t] > 0 && Array.isArray(cfg.pool[t]) && cfg.pool[t].length > 0).sort((a, b) => a - b));
    say('§1 其余字段：enabled =', view.enabled, '| slots =', JSON.stringify(view.slots), '| capacity =', view.capacity,
      '| tiers =', JSON.stringify(view.tiers.map((t) => t.tier)));
  });

  test('两个面说同一句话：可见面**不列**的 id，`room.support` 也真的拒绝（看得见就能选）', async () => {
    const view = srv.lobby.supportView(sub.room);
    const listed = flatIds(viewPool(view));
    assert.equal(listed.includes(OP_B), false, '前提：可见面今天不列外来干员');
    const reply = await sub.c.request({ t: 'room.support', entries: [OP_B] });
    assert.equal(reply.t, 'error', `可见面不列它 ⇒ 校验面也必须拒绝：${JSON.stringify(reply)}`);
    assert.equal(reply.code, 'BAD_TARGET');
    // 而可见面**列**的那个：校验面放行 —— 两个面对同一个 id 给出同一个答案
    const okReply = await sub.c.request({ t: 'room.support', entries: [OP_A] });
    assert.equal(okReply.t, 'ok', `可见面列它 ⇒ 校验面必须放行：${JSON.stringify(okReply)}`);
    say('§1 两个面：可见面含', OP_B, '?', listed.includes(OP_B), '⇒ room.support(', OP_B, ') =', JSON.stringify(reply),
      '| room.support(', OP_A, ') =', okReply.t);
  });
});

// ---------------------------------------------------------------------------------------------------
// §2 — 最硬的不变量：未声明集合 / 无房间 / 全集 ⇒ **同一个对象** ⇒ 4 座逐字节不变
// ---------------------------------------------------------------------------------------------------
describe('§2 未声明集合 / 无房间 / 全集 ⇒ 同一个对象（`===`），输出逐字节相同（4 座不变）', () => {
  test('`roomData(房间)` 与 `safeData()` 恒等：未声明 / 全集 / 无房间 三条路都是**本体**', () => {
    const proc = srv.lobby.safeData();
    // 未声明集合（`modSet === null`）
    assert.equal(roomData(plain.room), proc, '没声明集合的房间：进程级本体');
    // 无房间（`roomOf` ⇒ null：不在房里、或房间已经没了）
    assert.equal(roomData(null), proc, '无房间：进程级本体');
    assert.equal(roomData(undefined), proc, '无房间（undefined）：进程级本体');
    assert.equal(roomData(lobby.c ? null : null), proc, '无房间的会话：进程级本体');
    // 声明了**全部**包
    assert.equal(roomData(all.room), proc, '声明了全部包：还是进程级本体');
    // 反复取：还是同一个（不是「每次都返回一份内容相同的拷贝」）
    for (let i = 0; i < 4; i += 1) assert.equal(roomData(plain.room), proc, `第 ${i} 次取仍是同一个对象`);
    // 而子集房间**不是**本体（否则 §1 那条断言是空的）
    assert.notEqual(roomData(sub.room), proc, '声明子集 ⇒ 房间面是物化出来的另一份');
    say('§2 恒等：roomData(plain) === safeData() ?', roomData(plain.room) === proc,
      '| roomData(null) === safeData() ?', roomData(null) === proc,
      '| roomData(all) === safeData() ?', roomData(all.room) === proc,
      '| roomData(sub) === safeData() ?', roomData(sub.room) === proc);
  });

  test('`supportView(房间)` 与不带参数的输出**逐字节相同**（4 座那一档）', () => {
    const baseline = srv.lobby.supportView();
    // 未声明集合的房间
    assert.deepEqual(srv.lobby.supportView(plain.room), baseline, '没声明集合 ⇒ 与不带参数逐字节相同');
    assert.equal(JSON.stringify(srv.lobby.supportView(plain.room)), JSON.stringify(baseline));
    // 声明全集
    assert.deepEqual(srv.lobby.supportView(all.room), baseline, '声明全集 ⇒ 与不带参数逐字节相同');
    // 无房间 / null / undefined
    assert.deepEqual(srv.lobby.supportView(null), baseline);
    assert.deepEqual(srv.lobby.supportView(), baseline);
    // 输出本身与「进程面数据自己算一遍」也一致 —— 钉住「读的还是同一份」
    assert.deepEqual(viewPool(baseline), pool(), '不带参数的可见面 = 进程面自己算一遍');
    assert.equal(JSON.stringify(viewPool(srv.lobby.supportView(plain.room))), JSON.stringify(viewPool(baseline)));
    say('§2 逐字节：supportView(plain) === supportView() ?',
      JSON.stringify(srv.lobby.supportView(plain.room)) === JSON.stringify(baseline),
      '| supportView(all) === supportView() ?',
      JSON.stringify(srv.lobby.supportView(all.room)) === JSON.stringify(baseline),
      '| 序列化长度 =', JSON.stringify(baseline).length);
  });

  test('`supportView` 的缺省参数就是「无房间」：`supportView()` 与 `supportView(null)` 同一条路', () => {
    assert.equal(JSON.stringify(srv.lobby.supportView()), JSON.stringify(srv.lobby.supportView(null)));
    assert.equal(roomData(null), srv.lobby.safeData(), '缺省的房间 ⇒ 进程级本体');
    say('§2 缺省参数：supportView() === supportView(null) ?',
      JSON.stringify(srv.lobby.supportView()) === JSON.stringify(srv.lobby.supportView(null)));
  });
});

// ---------------------------------------------------------------------------------------------------
// §3 — 调用点：`supportView` 真的接受房间（两个调用点才可能「传对房间」）
// ---------------------------------------------------------------------------------------------------
describe('§3 调用点：`supportView` 接受房间参数', () => {
  test('传房间就按房间那一份算、不传就按进程面算（`Function.length` 对带缺省值的形参是 0，不能用它当探针）', () => {
    // 注意：`Function.length` **不算**带缺省值的形参，所以 `supportView(room = null).length === 0`
    // ——「接不接受房间」只能靠**行为**断言，不能靠元数据。
    const withRoom = srv.lobby.supportView(sub.room);
    const withoutRoom = srv.lobby.supportView();
    assert.deepEqual(viewPool(withRoom), pool(sub.room), '传房间 ⇒ 按房间面算');
    assert.deepEqual(viewPool(withoutRoom), pool(), '不传 ⇒ 按进程面算');
    assert.notDeepEqual(viewPool(withRoom), viewPool(withoutRoom), '两者必须真的不同（否则「接受房间」是空话）');
    assert.equal(flatIds(viewPool(withRoom)).includes(OP_B), false, '传房间时外来干员不列出');
    assert.equal(flatIds(viewPool(withoutRoom)).includes(OP_B), true, '不传时它照旧在（老调用点的行为没变）');
    say('§3 行为：supportView.length =', srv.lobby.supportView.length,
      '| supportView(sub) 含', OP_B, '?', flatIds(viewPool(withRoom)).includes(OP_B),
      '| supportView() 含', OP_B, '?', flatIds(viewPool(withoutRoom)).includes(OP_B));
  });

  test('`Lobby.prototype` 上 `broadcastState` / `sendState` 两个调用点都传了房间', () => {
    // 源码级断言：两个调用点今天都是 `this.supportView(room)`（改前是 `this.supportView()` —— 房间那一份
    // 根本没传进去，这就是「可见面读错面」在调用点那一侧的形状）。
    const src = fs.readFileSync(new URL('../server/lobby.js', import.meta.url), 'utf8');
    const hits = src.match(/this\.supportView\([^)]*\)/g) || [];
    assert.deepEqual(hits.sort(), ['this.supportView(room)', 'this.supportView(room)'], `两个调用点都必须传房间，实际 = ${JSON.stringify(hits)}`);
    assert.equal(/this\.supportView\(\)/.test(src), false, '不该再有裸的 this.supportView() 调用点');
    say('§3 调用点：', JSON.stringify(hits));
  });
});

// ---------------------------------------------------------------------------------------------------
// §4 — wire 面：玩家真正看见的那一份（`room.state.support`）里没有外来干员
// ---------------------------------------------------------------------------------------------------
describe('§4 wire 面：`room.state.support` 与房间面一致', () => {
  test('子集房间的 `room.state`：卡的池子里没有外来干员（真帧，不是内部对象）', async () => {
    // `room.ready` 会走到 `broadcastState`（`server/lobby.js` 的 `ready()`），所以它后面那一帧 `room.state`
    // 就是这一间房**此刻真的会发出去**的帧。
    assert.equal((await sub.c.request({ t: 'room.ready', ready: true })).t, 'ok');
    let frame = await sub.c.waitFor('room.state', (s) => !!s.support);
    if (frame.support.tiers.length === 0) {
      // 防御：万一那一帧在 `ready` 之前就进了 inbox，再等一帧
      frame = await sub.c.waitFor('room.state', (s) => !!s.support);
    }
    assert.ok(frame.support, 'room.state 必须带 support 目录（`toState(support)` 那一半）');
    const wirePool = viewPool(frame.support);
    assert.deepEqual(wirePool, pool(sub.room), 'wire 上的卡池必须等于房间面');
    assert.equal(flatIds(wirePool).includes(OP_B), false, `wire 上不该有外来干员：${OP_B}`);
    assert.equal(flatIds(wirePool).includes(OP_A), true, `wire 上必须有本房干员：${OP_A}`);
    say('§4 wire：room.state.support 卡池 =', JSON.stringify(flatIds(wirePool)),
      '| 房间面 =', JSON.stringify(flatIds(pool(sub.room))), '| 含', OP_B, '?', flatIds(wirePool).includes(OP_B));
  });
});
