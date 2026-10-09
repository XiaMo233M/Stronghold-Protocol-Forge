// test/roomAssets.test.js — 按房间物化（W-B, DESIGN §28.16）：声明了集合的房间**真的**只跑它声明的那几个包。
//
// W-A 把「房间自己的集合」存下来并发给成员；这一刀让那个集合**决定这一局跑什么**（数据 / kit / kit 模块 / meta），
// 并且把这一局的数据面按房间摘要送出去（`/room-data/<摘要>/<文件>.json`），因为 `/data/*.json` 送的是「官方 +
// 全部已装包」。三件事分开钉：
//
//   1. **纯物化**（`server/roomAssets.js`）：没声明集合 / 声明了全部 ⇒ 返回进程级那一份**本体**（对象身份），
//      子集 ⇒ 只有那几个包的记录与 kit，同一份摘要只物化一次；
//   2. **真服务器**：声明子集的房间，它的 `/room-data/<摘要>/chess.json` 里没有另一个包的干员，`/data/chess.json` 里有；
//      未登记摘要 / 未登记文件名一律 404（客户端编不出一个组合让服务器去合并）；
//   3. **真对局**：`room.start` 之后，这一局的 `Match.data` 就是那个物化结果（对象身份），`Match.mods.digest` 是
//      房间的摘要而不是进程的，kit 映射同理。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { createRoomAssets } from '../server/roomAssets.js';
import { deepFreeze } from '../server/data.js';
import { loadWorkshop } from '../server/workshop.js';
import { applyWorkshop } from '../shared/workshop.js';
import { modSetOf } from '../shared/modIdentity.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// 1. 纯物化
// ---------------------------------------------------------------------------------------------------

/** 一个最小包（一条干员记录 + 一个 kit 模块）。包贡献记录的形状是 `files`（与 `loadWorkshop` 给的一模一样）。 */
function fakePack(id, chessId) {
  return {
    id,
    hash: id.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
    layer: 'B',
    combat: true,
    api: null,
    content: ['chess'],
    overrides: [],
    files: { chess: { [chessId]: { chessId, baseId: chessId, visible: true, tier: 1 } } },
  };
}

describe('createRoomAssets：没声明集合就是进程级那一份本体，子集才物化', () => {
  const official = Object.freeze({ chess: { chess_official_a: { chessId: 'chess_official_a' } }, bonds: {} });
  const packs = [fakePack('alpha-pack', 'chess_ws_alpha_a'), fakePack('zeta-pack', 'chess_ws_zeta_a')];
  const processData = deepFreeze(applyWorkshop(official, packs).data);
  const kits = { chess_ws_alpha_a: () => ({}), chess_ws_zeta_a: () => ({}) };
  const kitOwners = new Map([['chess_ws_alpha_a', 'alpha-pack'], ['chess_ws_zeta_a', 'zeta-pack']]);
  const modules = [{ id: 'alpha-pack/chess_ws_alpha_a', pack: 'alpha-pack', url: '/workshop-kits/a.js' }, { id: 'zeta-pack/chess_ws_zeta_a', pack: 'zeta-pack', url: '/workshop-kits/z.js' }];
  const make = () => createRoomAssets({ official, processData, packs, kits, kitOwners, modules, log: quiet });

  const ids = (modSet) => modSet.packs.map((p) => p.id);
  const setOf = (list) => modSetOf(packs.filter((p) => list.includes(p.id)).map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat })));

  test('没有声明集合 / 空集合 / 全部包 ⇒ 对象身份（不是一份拷贝）', () => {
    const assets = make();
    for (const modSet of [null, { digest: 'x'.repeat(64), packs: [] }, setOf(['alpha-pack', 'zeta-pack'])]) {
      const got = assets.forRoom(modSet);
      assert.equal(got.data, processData, '没声明集合的房间必须拿到进程级那一份本体');
      assert.equal(got.kits, kits);
      assert.equal(got.modules, modules);
    }
    assert.equal(assets.size(), 0, '一条都不该物化');
    assert.equal(assets.digests(), 0);
  });

  test('子集：只有那几个包的记录、kit 与模块，且结果是冻结的', () => {
    const assets = make();
    const modSet = setOf(['alpha-pack']);
    const got = assets.forRoom(modSet);
    assert.notEqual(got.data, processData);
    assert.deepEqual(Object.keys(got.data.chess).sort(), ['chess_official_a', 'chess_ws_alpha_a']);
    assert.equal('chess_ws_zeta_a' in got.data.chess, false, '没声明的包一条记录都不该在');
    assert.deepEqual(Object.keys(got.kits), ['chess_ws_alpha_a'], '另一个包的 kit 不该在这个房间里存在');
    assert.deepEqual(got.modules.map((m) => m.pack), ['alpha-pack']);
    assert.ok(Object.isFrozen(got.data) && Object.isFrozen(got.kits) && Object.isFrozen(got.modules));
    assert.equal(Object.isFrozen(processData), true, '进程级那一份本来就冻结（server/data.js 同一条）');
  });

  test('同一份摘要只物化一次：两个房间声明同一套包，共享同一份数据与 kit', () => {
    const assets = make();
    const one = assets.forRoom(setOf(['alpha-pack']));
    const two = assets.forRoom({ digest: setOf(['alpha-pack']).digest, packs: [{ id: 'alpha-pack' }] });
    assert.equal(two, one, '第二个房间必须拿到同一个物化结果');
    assert.equal(assets.size(), 1);
    assert.equal(assets.digests(), 1, '登记的摘要数只算真的声明过的那一个');
    assets.forRoom(setOf(['zeta-pack']));
    assert.equal(assets.size(), 2);
    assert.equal(assets.digests(), 2);
  });

  test('byDigest：只有真的声明过的摘要取得回物化结果；空集合那条路不进按摘要这一面', () => {
    const assets = make();
    const modSet = setOf(['alpha-pack']);
    assert.equal(assets.byDigest(modSet.digest), null, '还没物化过就取不到');
    const got = assets.forRoom(modSet);
    assert.equal(assets.byDigest(modSet.digest), got);
    assert.equal(assets.byDigest('f'.repeat(64)), null);
    assert.equal(assets.byDigest(null), null);
    // 一个没有 digest 的集合（理论上只出现在测试里）不会被登记，免得按 URL 取到一份没人声明过的东西
    assets.forRoom({ packs: [{ id: 'zeta-pack' }] });
    assert.equal(assets.digests(), 1);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 真服务器：按房间的数据面
// ---------------------------------------------------------------------------------------------------

/** 一个 layer-A 包：一条新干员记录，没有代码。 */
function writePack(root, id, name) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name, version: '0.1.0', content: ['chess'], overrides: [] }));
  const chessId = `chess_ws_${id.replace(/-/g, '_')}_a`;
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({ [chessId]: { chessId, baseId: chessId, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 2000, atk: 500, def: 200, res: 0, cost: 18, blockCnt: 2, bat: 1.2 }, talents: [], bonds: [] } }));
  return chessId;
}

const wsUrl = (srv) => `ws://127.0.0.1:${srv.port}/ws`;

describe('真服务器：房间的数据面上只有它声明的包', () => {
  let tmp;
  let srv;
  let digest;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-roomassets-'));
    const root = path.join(tmp, 'workshop');
    fs.mkdirSync(root, { recursive: true });
    writePack(root, 'alpha-pack', 'Alpha');
    writePack(root, 'zeta-pack', 'Zeta');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
    digest = modSetOf(loadWorkshop(root, { log: quiet }).packs
      .map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }))).digest;
  });
  after(async () => {
    await srv?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('房间的模组集合：索引.js 把物化器交给了会话栈（没装包时它是 null）', () => {
    assert.ok(srv.lobby.workshop.roomAssets, '装了包的服务器必须有按房间物化器');
    assert.equal(typeof srv.lobby.workshop.roomAssets.forRoom, 'function');
  });

  test('声明子集的房间：/room-data/<摘要>/chess.json 里有 alpha、没有 zeta；/data/chess.json 两个都有', async () => {
    const c = await TestClient.connect(wsUrl(srv));
    try {
      await c.hello('RoomDataHost');
      assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] })).t, 'ok');
      const state = await c.waitFor('room.state', (s) => s.code && s.mods);
      const roomDigest = state.mods.digest;
      assert.notEqual(roomDigest, digest);

      const roomChess = await (await fetch(`http://127.0.0.1:${srv.port}/room-data/${roomDigest}/chess.json`)).json();
      assert.equal('chess_ws_alpha_pack_a' in roomChess, true, '声明了的包必须在');
      assert.equal('chess_ws_zeta_pack_a' in roomChess, false, '没声明的包一条都不该在');

      const processChess = await (await fetch(`http://127.0.0.1:${srv.port}/data/chess.json`)).json();
      assert.equal('chess_ws_alpha_pack_a' in processChess, true);
      assert.equal('chess_ws_zeta_pack_a' in processChess, true, '/data/ 那一份照旧是「官方 + 全部已装包」');

      // 房间自己那一份是冻结的、也是**另一个对象**：物化不是把进程级那份改一改
      const set = srv.lobby.workshop.roomAssets.byDigest(roomDigest);
      assert.ok(set && set.data !== srv.lobby.workshop.roomAssets.forRoom(null).data);
      assert.ok(Object.isFrozen(set.data));
    } finally {
      await c.terminate();
    }
  });

  test('未登记的摘要、未登记的文件名、形状不对的摘要：一律 404，绝不现场合并一份出来', async () => {
    const base = `http://127.0.0.1:${srv.port}`;
    const known = await (async () => {
      const c = await TestClient.connect(wsUrl(srv));
      try {
        await c.hello('RoomData404');
        await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] });
        return (await c.waitFor('room.state', (s) => s.code && s.mods)).mods.digest;
      } finally { await c.terminate(); }
    })();
    assert.equal((await fetch(`${base}/room-data/${'0'.repeat(64)}/chess.json`)).status, 404, '没房间声明过的摘要');
    assert.equal((await fetch(`${base}/room-data/${known}/not-a-data-file.json`)).status, 404, '白名单外的文件名');
    assert.equal((await fetch(`${base}/room-data/nope/chess.json`)).status, 404, '形状不对的摘要');
    assert.equal((await fetch(`${base}/room-data/${known}/chess.json`)).status, 200);
  });

  test('房间里的对局拿到的是物化结果本体，spec 上的 mods 是房间摘要（不是进程摘要）', async () => {
    const c = await TestClient.connect(wsUrl(srv));
    try {
      await c.hello('RoomMatch');
      await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest, modIds: ['alpha-pack'] });
      const state = await c.waitFor('room.state', (s) => s.code && s.mods);
      const room = srv.lobby.rooms.get(state.code);
      assert.ok(room, '房间必须在会话栈里');
      assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
      assert.equal((await c.request({ t: 'room.start' })).t, 'ok', 'solo 房间自己就能开');
      const match = room.match;
      assert.ok(match, '对局必须建起来');
      const expected = srv.lobby.workshop.roomAssets.forRoom(room.modSet);
      assert.equal(match.data, expected.data, '对局的数据就是那个房间的物化结果（对象身份）');
      assert.equal(match.workshopKits, expected.kits, 'kit 映射同理');
      assert.equal(match.mods.digest, room.modSet.digest, 'spec 上写的必须是这一局真的跑的那一套');
      assert.notEqual(match.mods.digest, digest);
      assert.equal('chess_ws_zeta_pack_a' in match.data.chess, false);
    } finally {
      await c.terminate();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. 对局的数据作用域：sim/content/support 的记录读取按这一局的数据走
// ---------------------------------------------------------------------------------------------------

describe('对局的数据作用域（sim/content/support/index.js）：按这一局走，且默认那一份一个字节不变', () => {
  test('作用域里读的是这一局的数据；表缺了就回落到默认那份（部分数据对象不会把别的表读没）', async () => {
    const { gameData, withGameData } = await import('../server/sim/content/support/index.js');
    const outside = gameData();
    assert.ok(outside.bonds && Object.keys(outside.bonds).length > 0, '默认那一份就是进程级的数据');
    assert.equal(outside, gameData(), '不在作用域里 ⇒ 永远是同一个对象（身份）');

    const scoped = { bonds: { onlyMine: { id: 'onlyMine', isCore: false } }, chess: { onlyMine_a: { chessId: 'onlyMine_a' } } };
    const seen = withGameData(scoped, () => {
      const d = gameData();
      assert.notEqual(d, outside);
      assert.deepEqual(Object.keys(d.bonds), ['onlyMine'], '同名的表按这一局的来');
      assert.equal(d.chess.onlyMine_a.chessId, 'onlyMine_a');
      assert.equal(Object.keys(d.items).length, Object.keys(outside.items).length, '没带的表回落到默认那份');
      assert.equal(d.items, outside.items);
      assert.equal(gameData(), d, '同一个作用域里同一个视图（缓存）');
      return d;
    });
    assert.equal(gameData(), outside, '出了作用域就回到默认那份');
    // 嵌套：内层赢，退出内层回到外层（同步区间内的一叠作用域）
    withGameData(scoped, () => {
      assert.equal(gameData().bonds, scoped.bonds);
      withGameData({ bonds: { inner: { id: 'inner' } } }, () => assert.deepEqual(Object.keys(gameData().bonds), ['inner']));
      assert.equal(gameData().bonds, scoped.bonds);
    });
    assert.equal(seen.items, outside.items);
  });

  test('真的对局：Battle 构造与每一步都在这一局的作用域里跑（用完即出，进程级那份一个键不动）', async () => {
    const { gameData, coreBondIds } = await import('../server/sim/content/support/index.js');
    const { makeBattle } = await import('./helpers/battleHarness.js');
    const processBonds = gameData().bonds;
    const processCore = [...coreBondIds()].sort();
    // 一个只有 chess 一张表的数据对象（`defs` 就是 makeBattle 那五张表）：对局里读盟约时必须**回落到默认那份**
    //（不是读成空 —— 那会让一局的盟约全失效），读干员时用这一局那张空表（不是官方那份）。
    let during = null;
    const h = makeBattle({ defs: { chess: {} }, setup: () => { during = gameData(); }, timeLimit: 1 });
    assert.ok(during, 'setup 在构造期跑，必须在作用域里');
    assert.equal(during.bonds, processBonds, '没带的表回落到默认那份');
    assert.deepEqual(Object.keys(during.chess), [], '带了的表按这一局的来');
    h.step();
    assert.equal(gameData().bonds, processBonds, '一步一步跑完，作用域必须已经退掉');
    assert.deepEqual([...coreBondIds()].sort(), processCore, '按作用域缓存的那一份不该污染默认那份');
    assert.equal(h.b.errors.length, 0, '对局本身没有内容报错');
  });

  test('数据源带着自己的数据对象：`DataSource.source` 就是那一局的数据（没给就是 null ⇒ 进程级）', async () => {
    const { DataSource } = await import('../server/sim/simdata.js');
    const mine = { chess: {}, bonds: {} };
    assert.equal(new DataSource(mine, null).source, mine);
    assert.equal(new DataSource({ chess: {} }).source.chess !== undefined, true, '默认参数是空对象，也算「带着一个数据对象」');
  });
});
