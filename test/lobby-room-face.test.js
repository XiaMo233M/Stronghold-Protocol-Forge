// test/lobby-room-face.test.js — 「大厅的校验面必须与对局面读**同一份**数据」(W-B 收口：修一个已实测的静默丢失)。
//
// 病灶（修前，实测）：`server/lobby.js` 的四处房间消息校验读的是**进程级单例** `this.safeData()`（`server/data.js`
// 的 `getData()` —— 官方 + **所有**已装包），而对局侧读的是**房间裁剪面**（`lobby.js` 起局处
// `roomAssets.forRoom(room.modSet)` → `Match opts.data` → `GameData(this.data)`）。两份数据不同源，于是：
//
//   * `room.loadout` 在大厅被**放行**（进程面认得那个干员），技能选择存进 seat；
//   * 进房后 `PlayerState.setLoadout`（`server/match/player/basics.js:98`）拿**房间面**复检 ⇒ 整条拒绝；
//   * `ps.loadout` 变成 `{}`，日志只留一行 warn —— **玩家的选择被静默丢掉**（不报错、无声）。
//
// 这个文件钉住五件事：
//   1. **子集房间的四个校验面读的是房间自己那一份**（对象身份 `===`，并逐条对比「大厅的判定」与「房间面判定的
//      独立复算」）—— 外来干员在大厅就被**点名拒绝**（`BAD_TARGET`），本房自己的干员照常放行；
//   2. **未声明集合 / 无房间 / 声明全集**：拿到的必须是**同一个对象**（`===`，不是「内容相同」）⇒ 4 座逐字节不变；
//   3. **端到端**：大厅放行 → seat 存下 → 进房后 `ps.loadout` **不再为空**（修前这里是 `{}`，也就是那个静默丢失）；
//   4. **第二处（已修）**：`supportView()`（助战**可见面**）原也读进程面 ⇒ 「看得见却选不了」（界面列出本房没声明的
//      助战位，`room.support` 却整条拒绝）。今天它与四个校验面同源（`room = null` 形参 ⇒ 缺省仍是进程面本体）；
//   5. 夹具与断言都不依赖浏览器：真服务器 + 真房间 + 真对局（WS）。
//
// 夹具用**合成最小包**（两个包各带一个干员，其中一个只被进程装载、不被这个房间声明），因为要考的就是
// 「进程面有、房间面没有」这条差值；真包（`_up/pv/workshop-demo`）不具备「同一台服务器上 A 有 B 没有」的形态。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { checkLoadout, checkNotOwned, checkDiyPicks } from '../shared/protocol.js';
import { normalizeSupportConfig } from '../shared/support.js';
import { lookup } from '../server/data.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

/** `[evidence]` 行：原始输出，报告直接抄它。 */
const say = (...a) => console.log('[evidence]', ...a);

/** 每个包一个干员：`lr-alpha` 会被子集房间声明，`lr-beta` 只被进程装载（这就是「外来干员」）。 */
const OP_A = 'chess_ws_lr_alpha_a';
const OP_B = 'chess_ws_lr_beta_a';
const PACKS = { A: 'lr-alpha', B: 'lr-beta' };

/**
 * 一条最小但**合法**的自制干员记录（`shared/workshop.js` 的包级 chess 校验 + `shared/protocol.js` 的
 * `checkLoadout` 都要能吃下它）：两个技能——`0` 是默认（`isDefault: true`），`2` 不是默认，
 * 所以 `{ skill: 2 }` 是「玩家真的改过」的负载（默认值会被 `checkLoadout` 丢出 `loadout`，那会让端到端
 * 那一条测不出东西）。
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

/** 把一个包写到盘上（真加载器读的就是这四件事：`pack.json` + 一张 `chess.json`）。 */
function writePack(root, id, chessId, tier, charId, supportId = null, backupCharId = null) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', content: ['chess'], overrides: [],
    ...(supportId ? { support: [supportId] } : {}),
  }));
  const rec = chessRecord(chessId, tier, charId);
  // 补位（干员持有）只认**有 `backup`** 的棋子（`shared/standIn.js isDroppableChess`）：外来的这个包声明了它，
  // 所以「进程面留下一条、房间面一条都不留」这条差值才测得到。
  if (backupCharId) rec.backup = { charId: backupCharId, skillIndex: 0, uniEquipId: null };
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({ [chessId]: rec }));
}

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobbyroomface-'));
  const wsRoot = path.join(tmp, 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });
  writePack(wsRoot, PACKS.A, OP_A, 5, 'char_lr_alpha');
  writePack(wsRoot, PACKS.B, OP_B, 4, 'char_lr_beta', OP_B, 'char_lr_beta_backup');

  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
  const mods = srv.lobby.workshop.mods;
  assert.deepEqual(mods.map((m) => m.id).sort(), [PACKS.A, PACKS.B].sort(), '夹具的两个包必须都装载了');
  say('装载的包 =', mods.map((m) => m.id), '| 进程摘要 =', srv.lobby.modSet.digest.slice(0, 12));

  sub = await open('Sub', [PACKS.A]);
  all = await open('All', [PACKS.A, PACKS.B]);
  plain = await open('Plain');
  lobby = { c: await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`) };
  await lobby.c.hello('NoRoom');

  // 夹具前提：三间房确实落在三条不同的路上（否则下面的断言说的不是同一件事）
  assert.equal(sub.room.modSet.digest === all.room.modSet.digest, false);
  assert.equal(plain.room.modSet, null, '没声明集合的房间 `modSet` 必须是 null');
  for (const [tag, r] of [['sub', sub], ['all', all], ['plain', plain]]) {
    say(`room ${tag}: code=${r.room.code} modIds=${JSON.stringify(r.room.modIds)} digest=${r.room.modSet ? r.room.modSet.digest.slice(0, 12) : 'null'}`);
  }
});

after(async () => {
  for (const x of [sub, all, plain, lobby]) await x?.c?.terminate();
  await srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------
// 通用探针：大厅每一处校验「实际读的是哪一份数据」，与两个面各自独立复算的结果
// ---------------------------------------------------------------------------------------------------
const assets = () => srv.lobby.workshop.roomAssets;
/** 房间裁剪面（这一局真正会跑的那一份）。 */
const roomFace = (room) => assets().forRoom(room.modSet).data;
/** 进程级那一份（修前那四处读的就是它）。 */
const processFace = () => assets().forRoom(null).data;

/**
 * `room.loadout` 的**独立复算**：照 `server/lobby.js` 的 `loadout()` 前半段，对一个给定的数据面推出
 * 「大厅会回什么」。它不碰任何生产代码，只看 `shared/protocol.js` 的纯函数 —— 所以「大厅的判定」与
 * 「这一面的判定」两条路是分别算出来的。
 */
function decideLoadout(entries, data) {
  const res = checkLoadout(entries, (id) => lookup('chess', id, data));
  return res && res.ok ? { ok: true } : { ok: false, code: res && res.error };
}
function decideOwnership(notOwned, data) {
  const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
  return res && res.ok ? { ok: true, kept: res.notOwned } : { ok: false, code: res && res.error };
}
function decideDiy(picks, data) {
  const res = checkDiyPicks(picks, { data, kitted: null });
  return res && 'ok' in res ? { ok: true, kept: res.picks } : { ok: false, code: res && res.error };
}
/** 一条 wire 回复 → 与上面三个 `decide*` 可比的形状。 */
const verdict = (reply) => (reply.t === 'ok'
  ? { ok: true }
  : { ok: false, code: reply.code });
/** 只比「判定」那一半（`kept` 是各面自己的产物，形状不同，单独断言）。 */
const outcome = ({ ok, code }) => (ok ? { ok: true } : { ok: false, code });

// ---------------------------------------------------------------------------------------------------
// §1 — 子集房间：四个校验面读的是房间自己那一份，外来干员在大厅就被点名拒绝
// ---------------------------------------------------------------------------------------------------
describe('§1 子集房间（只声明 lr-alpha）：四个校验面读房间自己那一份', () => {
  test('数据面确实是两份不同的东西（夹具前提）', () => {
    const room = roomFace(sub.room);
    const proc = processFace();
    assert.notEqual(room, proc, '声明子集 ⇒ 房间面是物化出来的另一份对象');
    assert.notEqual(room, srv.lobby.safeData(), '房间面也不是进程级单例');
    assert.equal(proc, srv.lobby.safeData(), '进程面就是 `safeData()` 那一份（这正是修前四处读的东西）');
    assert.equal(Object.hasOwn(room.chess, OP_A), true, '本房自己的干员在房间面里');
    assert.equal(Object.hasOwn(room.chess, OP_B), false, '外来干员不在房间面里');
    assert.equal(Object.hasOwn(proc.chess, OP_B), true, '但它在进程面里（大厅因此曾放行）');
    say('子集房间：room === process ?', room === proc, '| room.hasOwn(B) =', Object.hasOwn(room.chess, OP_B), '| process.hasOwn(B) =', Object.hasOwn(proc.chess, OP_B));
    say('两个面的独立复算 checkLoadout(B): room =', JSON.stringify(decideLoadout({ [OP_B]: { skill: 2 } }, room)), '| process =', JSON.stringify(decideLoadout({ [OP_B]: { skill: 2 } }, proc)));
  });

  test('外部干员的 loadout 在大厅就被点名拒绝（BAD_TARGET），seat 上什么都没留下', async () => {
    const entries = { [OP_B]: { skill: 2 } };
    const before = sub.room.seatOf(sub.welcome.playerId).loadout;
    const reply = await sub.c.request({ t: 'room.loadout', entries });
    assert.equal(reply.t, 'error', `大厅必须拒绝：${JSON.stringify(reply)}`);
    assert.equal(reply.code, ERR.BAD_TARGET);
    assert.deepEqual(verdict(reply), outcome(decideLoadout(entries, roomFace(sub.room))), '大厅的判定必须等于「房间面自己判一遍」');
    assert.notDeepEqual(decideLoadout(entries, roomFace(sub.room)), decideLoadout(entries, processFace()), '而两个面的判定在这里**确实**不同（否则这条测不到东西）');
    assert.equal(sub.room.seatOf(sub.welcome.playerId).loadout, before, '被拒绝 ⇒ seat 上一个字节都没变');
    say('外部干员 loadout：大厅 =', JSON.stringify(reply), '| seat.loadout =', JSON.stringify(sub.room.seatOf(sub.welcome.playerId).loadout));
  });

  test('本房自己的干员照常放行，seat 记下它', async () => {
    const entries = { [OP_A]: { skill: 2 } };
    const reply = await sub.c.request({ t: 'room.loadout', entries });
    assert.equal(reply.t, 'ok', `本房干员必须放行：${JSON.stringify(reply)}`);
    assert.deepEqual(sub.room.seatOf(sub.welcome.playerId).loadout, { [OP_A]: { skill: 2, module: null } });
    say('本房干员 loadout：大厅 =', reply.t, '| seat.loadout =', JSON.stringify(sub.room.seatOf(sub.welcome.playerId).loadout));
  });

  test('外部干员的 support：大厅的判定 = 房间面判定的复算', async () => {
    const reply = await sub.c.request({ t: 'room.support', entries: [OP_B] });
    const room = roomFace(sub.room);
    const pool = room.support && room.support.pool ? room.support.pool : {};
    const inRoomPool = Object.values(pool).some((ids) => Array.isArray(ids) && ids.includes(OP_B));
    const inProcessPool = Object.values(processFace().support.pool).some((ids) => ids.includes(OP_B));
    assert.equal(inRoomPool, false, '房间自己那一份的卡池里不该有这个外来干员');
    assert.equal(inProcessPool, true, '进程面的卡池里有它（这就是「读错面」会放行的原因）');
    assert.equal(reply.t, 'error', `卡池外的助战必须被拒绝：${JSON.stringify(reply)}`);
    assert.equal(reply.code, ERR.BAD_TARGET);
    say('外部干员 support：大厅 =', JSON.stringify(reply), '| 房间面卡池含它 ?', inRoomPool, '| 进程面卡池含它 ?', inProcessPool);
  });

  test('外部干员的 ownership / diy：大厅的判定 = 房间面判定的复算', async () => {
    const room = roomFace(sub.room);
    const proc = processFace();
    // 补位（干员持有）：**宽松**判定 —— 两个面都「放行」，但放行后留下的列表不同（`[]` vs 一条 id）
    const ownReply = await sub.c.request({ t: 'room.ownership', notOwned: [OP_B] });
    assert.equal(ownReply.t, 'ok', `补位是宽松判定，回的是 ok：${JSON.stringify(ownReply)}`);
    assert.deepEqual(verdict(ownReply), outcome(decideOwnership([OP_B], room)));
    assert.equal(sub.room.seatOf(sub.welcome.playerId).notOwned.length, 0, '房间面不认识它 ⇒ 一条都不留');
    assert.equal(decideOwnership([OP_B], proc).kept.length, 1, '进程面认得它 ⇒ 会留下（这就是修前的差别）');
    // 自选编队：同样是宽松判定，非法/未知的槽位被丢掉而不是整条拒绝
    const diyReply = await sub.c.request({ t: 'room.diy', picks: { [OP_B]: { charId: 'char_lr_beta' } } });
    assert.equal(diyReply.t, 'ok', `自选是宽松判定，回的是 ok：${JSON.stringify(diyReply)}`);
    assert.deepEqual(verdict(diyReply), outcome(decideDiy({ [OP_B]: { charId: 'char_lr_beta' } }, room)));
    say('外部干员 ownership：大厅 =', ownReply.t, '| 房间面保留 =', JSON.stringify(decideOwnership([OP_B], room).kept), '| 进程面保留 =', JSON.stringify(decideOwnership([OP_B], proc).kept));
    say('外部干员 diy：大厅 =', diyReply.t, '| 房间面 =', JSON.stringify(decideDiy({ [OP_B]: { charId: 'char_lr_beta' } }, room)), '| 进程面 =', JSON.stringify(decideDiy({ [OP_B]: { charId: 'char_lr_beta' } }, proc)));
  });
});

// ---------------------------------------------------------------------------------------------------
// §2 — 最硬的不变量：没声明集合 / 无房间 / 声明全集 ⇒ **同一个对象**
// ---------------------------------------------------------------------------------------------------
describe('§2 没声明集合 / 无房间 / 声明全集 ⇒ 返回同一个对象（`===`，4 座逐字节不变）', () => {
  test('`forRoom(null)` / `forRoom(全集)` / `safeData()` 三者恒等，多次取还是同一个', () => {
    const proc = assets().forRoom(null);
    assert.equal(proc.data, srv.lobby.safeData(), '进程面就是大厅单例那一份本体');
    assert.equal(assets().forRoom(plain.room.modSet), proc, '没声明集合的房间：本体');
    assert.equal(assets().forRoom(all.room.modSet), proc, '声明了**全部**包：还是本体');
    for (let i = 0; i < 4; i += 1) assert.equal(assets().forRoom(plain.room.modSet), proc, `第 ${i} 次取仍是同一个对象`);
    assert.equal(assets().forRoom(lobby.c ? null : null), proc, '无房间（`roomOf` ⇒ null）拿到的是同一个对象');
    say('恒等探针：forRoom(null) === safeData() ?', proc.data === srv.lobby.safeData(),
      '| forRoom(plain) === forRoom(all) ?', assets().forRoom(plain.room.modSet) === assets().forRoom(all.room.modSet),
      '| 4 次取恒等 ?', [0, 1, 2, 3].every(() => assets().forRoom(plain.room.modSet) === proc));
  });

  test('无房间的会话：loadout 的判定与「进程面复算」逐条相同（今天的行为一个字节没变）', async () => {
    const entries = { [OP_B]: { skill: 2 } };
    const reply = await lobby.c.request({ t: 'room.loadout', entries });
    assert.equal(reply.t, 'ok', `没有房间时进程面认得它 ⇒ 照旧放行：${JSON.stringify(reply)}`);
    assert.deepEqual(verdict(reply), outcome(decideLoadout(entries, processFace())));
    assert.deepEqual(verdict(reply), outcome(decideLoadout(entries, srv.lobby.safeData())));
    say('无房间 loadout =', reply.t, '| 进程面复算 =', JSON.stringify(decideLoadout(entries, processFace())));
  });

  test('「4 座」这一档：没声明集合的房间拿到的 data 与今天逐字节相同（序列化 sha 相等）', () => {
    const proc = assets().forRoom(null).data;
    const face = assets().forRoom(plain.room.modSet).data;
    assert.equal(face, proc);
    const sha = (v) => JSON.stringify(v);
    assert.equal(sha(face.chess), sha(proc.chess));
    assert.equal(sha(face.support), sha(proc.support));
    assert.equal(sha(face.chess).length, sha(srv.lobby.safeData().chess).length);
    say('4 座那一档：face === process ?', face === proc, '| chess 序列化长度 =', sha(face.chess).length);
  });

  test('没声明集合的房间：校验行为与今天逐字节相同（放行同样放行）', async () => {
    const entries = { [OP_B]: { skill: 2 } };
    const reply = await plain.c.request({ t: 'room.loadout', entries });
    assert.equal(reply.t, 'ok', `没声明集合 ⇒ 进程面 ⇒ 照旧放行：${JSON.stringify(reply)}`);
    assert.deepEqual(verdict(reply), outcome(decideLoadout(entries, processFace())));
    assert.deepEqual(plain.room.seatOf(plain.welcome.playerId).loadout, { [OP_B]: { skill: 2, module: null } });
    say('没声明集合的房间 loadout =', reply.t, '| seat.loadout =', JSON.stringify(plain.room.seatOf(plain.welcome.playerId).loadout));
  });
});

// ---------------------------------------------------------------------------------------------------
// §3 — 端到端：大厅放行 → seat 存下 → 进房后 `ps.loadout` 不再为空
// ---------------------------------------------------------------------------------------------------
describe('§3 端到端：大厅放行 ⇒ seat 存下 ⇒ 进房后 `ps.loadout` 不再为空', () => {
  test('本房干员一路走到 `PlayerState.loadout`（修前这里是 `{}` —— 那个静默丢失）', async () => {
    const entries = { [OP_A]: { skill: 2 } };
    // 1) 大厅：房间面认得它，放行
    const sent = await sub.c.request({ t: 'room.loadout', entries });
    assert.equal(sent.t, 'ok', `大厅放行：${JSON.stringify(sent)}`);
    // 2) seat：存下了（进房前的最后一份真相）
    const seat = sub.room.seatOf(sub.welcome.playerId);
    assert.deepEqual(seat.loadout, { [OP_A]: { skill: 2, module: null } }, 'seat 上必须存住');
    // 3) 开局：这一局拿到的数据就是房间那一份（`lobby.js` 起局处那条既有口径）
    assert.equal((await sub.c.request({ t: 'room.ready', ready: true })).t, 'ok');
    assert.equal((await sub.c.request({ t: 'room.start' })).t, 'ok');
    const m = sub.room.match;
    assert.ok(m, '对局必须建起来');
    assert.equal(m.data, roomFace(sub.room), '这一局的数据就是房间面那一份（`===`）');
    // 4) 对局侧复检用的是**同一份**数据 ⇒ 不再整条拒绝
    const ps = m.players.get(sub.welcome.playerId);
    assert.ok(ps, '玩家状态必须在');
    assert.deepEqual(ps.loadout, { [OP_A]: { skill: 2, module: null } }, '`ps.loadout` 必须不再是空的（修前：{}）');
    say('端到端：大厅 =', sent.t, '| seat.loadout =', JSON.stringify(seat.loadout), '| match.data === roomFace ?', m.data === roomFace(sub.room), '| ps.loadout =', JSON.stringify(ps.loadout));
  });

  test('对照：修前那条路（大厅用进程面）在这里必然落到 `{}`', () => {
    // 这条不是「跑一遍旧代码」，而是把修前的**两根事实**并排钉住：大厅当时读的是进程面，而对局读房间面；
    // 两边对外来干员的判定不同 ⇒ 「大厅放行、进房丢光」是**可推导的必然**，不是偶发。
    const entries = { [OP_B]: { skill: 2 } };
    const room = roomFace(sub.room);
    assert.deepEqual(decideLoadout(entries, processFace()), { ok: true }, '进程面（修前大厅读的）放行');
    assert.deepEqual(decideLoadout(entries, room), { ok: false, code: ERR.BAD_TARGET }, '房间面（对局读的）拒绝 ⇒ 进房后 `setLoadout` 返回 false ⇒ `ps.loadout = {}`');
    // 上面那条「拒绝」就是 `server/match/player/basics.js:98` 那一步：`setLoadout` 整条返回 false，
    // `PlayerState.loadout` 留在构造时的 `{}`。修后大厅与对局同源 ⇒ 这条差值在大厅那一步就被拦下。
    assert.equal(Object.hasOwn(sub.room.seatOf(sub.welcome.playerId).loadout, OP_B), false, '大厅已经拒绝过 ⇒ seat 上从来没有它');
    say('对照：进程面对外来干员的判定 =', JSON.stringify(decideLoadout(entries, processFace())), '| 房间面 =', JSON.stringify(decideLoadout(entries, room)), '⇒ 修前必然静默丢光');
  });
});

// ---------------------------------------------------------------------------------------------------
// §4 — 第二处（**已修**）：`supportView()` 曾读进程面，今天与四个校验面同源
// ---------------------------------------------------------------------------------------------------
describe('§4 第二处（已修）：`supportView()`（助战可见面）与校验面同源', () => {
  test('今天的实测：它按房间取面；`room` 是第一个形参（缺省 ⇒ 进程面本体）', () => {
    // 修前：`server/lobby.js` 的 `supportView()` 没有形参，`broadcastState` / `sendState` 两个调用点都只写
    // `room.toState(this.supportView())` —— 房间那一份根本没有传进去。今天 `supportView(room = null)` 收房间，
    // 两个调用点都写 `this.supportView(room)`。
    // 形状断言到这里为止：`supportView(room = null)` 的 `room` **带缺省值**，而 `Function.length` **不算带缺省值的
    // 形参** ⇒ 它今天恒为 0，既不能证明房间没进形参表、也不能证明进了。**行为才是事实**（见本测试末尾那几条）。
    assert.equal(srv.lobby.supportView.length, 0, '`Function.length` 对带缺省值的形参计数为 0（形状代理，不作判据）');
    const view = srv.lobby.supportView();
    const roomPool = roomFace(sub.room).support.pool;
    const keys = (cfg) => Object.keys(cfg.pool).sort().join(',');
    say('supportView() 卡池 tier =', keys({ pool: view.tiers.reduce((o, t) => ({ ...o, [t.tier]: t.ids }), {}) }),
      '| 房间面卡池 tier =', keys(roomFace(sub.room).support),
      '| 进程面卡池 tier =', keys(processFace().support));
    // **缺省（不传房间）= 进程面那一份**：与「进程面数据自己算一遍」的结果逐字段相同 —— 4 座那一档一个字节没动。
    assert.deepEqual(view, srv.lobby.supportView(null), '不传房间 = 显式传 null（缺省参数）');
    assert.deepEqual(view.slots, { ...normalizeSupportConfig(processFace().support).slots }, '缺省时 slots 来自进程面');
    assert.ok(roomPool, '房间面确实带着自己那一份 support.json');
    // **行为**：`room` 真的进了数据源的选择 —— 传房间就落在**房间面本体**上，不传就落在**进程面本体**上（`===`）。
    // 「这两个面是两份不同的东西」见 §1 第一条（`roomFace(sub) !== processFace()`）。
    assert.equal(srv.lobby.roomData(sub.room), roomFace(sub.room), '传子集房间 ⇒ 读的是房间面本体（`===`）');
    assert.equal(srv.lobby.roomData(null), processFace(), '不传房间 ⇒ 读的是进程面本体（`===`）');
    // 注意：**这个夹具测不出 picker 输出的差别** —— 它的外来干员 `lr-beta` 是 4 阶，而 `supportPicker` 只列
    // `slots > 0` 的阶（官方只给 5/6 阶配了 slots），所以两个面的 tiers 在这里逐字相同，「传与不传的输出必须不同」
    // 在本夹具**恒不成立**，写下来就是一句假话。要断言「可见面不再列出外来助战位」得用 5 阶的夹具 —— 那里才是这个
    // bug 的行为面，mutation 也在那里变红：`test/lobby-support-face.test.js`（§1 / §3 / §4-wire）。
    const viewOf = (room) => srv.lobby.supportView(room).tiers.map((t) => `${t.tier}:${t.ids.join('|')}`).join(';');
    assert.equal(viewOf(), viewOf(null), '不传 = 缺省 = 无房间（同一条路）');
    assert.equal(viewOf(null), viewOf(srv.lobby.roomOf({ roomCode: null })), '无房间的会话（`roomOf` ⇒ null）= 进程面那一份');
    assert.equal(viewOf(plain.room), viewOf(), '没声明集合的房间 = 进程面那一份');
    assert.equal(viewOf(all.room), viewOf(), '声明全集 = 进程面那一份（4 座逐字节不变）');
  });
});
