// test/roomModIndependence.test.js — 「服务器上两个不同 mod 集合的房间，同时在线时各自独立」（W-A/W-B 收口验证）。
//
// 这个文件**只读**生产代码，全部结论都用 `===`（对象身份）与逐 id 比较得出，而不是读注释：
//
//   1. 缓存结构与键（`server/roomAssets.js` `forRoom`）：键是什么、有没有全局可变状态；
//   2. 两个不同集合的房间**交错**调用 `forRoom`：各自是同一个实例、逐 id 无交叉污染；
//   3. 同集合的两个房间 ⇒ 同一个实例（缓存共享是设计意图）；
//   4. 没声明集合的房间 ⇒ 进程级那一份**本体**（`===`），并逐字节钉住「与今天相同」；
//   5. 决定性的一步：两个房间各自开一局，`Match` 上注入的工坊表就是**各自房间那一份**（真跑 + 复算两条组装路径）；
//   6. 每房间数据面 `/room-data/<摘要>/…`：两份内容不同，A 的摘要拿不到 B 的东西；
//   7. `alignRoom` / `planAlignment`：只装了 A 的客户端看 B 的房间 ⇒ `ok:false` 且**按名字**指出缺哪个包。
//
// 夹具是**真包**（`_up/pv/workshop-demo` 下三个包，只读复制到临时目录；其中两个包各带一个真 kit），
// 真包不覆盖到的维度（召唤物 kit —— 这三个真包都没有 `kits/<tokenId>.js`）用最小合成包补测，并在测试名里写明。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { createRoomAssets } from '../server/roomAssets.js';
import { loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { loadData, deepFreeze } from '../server/data.js';
import { applyWorkshop } from '../shared/workshop.js';
import { modSetOf } from '../shared/modIdentity.js';
import {
  battleOptsFromMatch, specBattleOpts,
} from '../server/match/match/battleOpts.js';
import { createMemoryBackend, createStore, modKey } from '../public/js/mods/store.js';
import {
  DATA_PREFIX, ROOM_DATA_PREFIX, alignRoom, missingPackIds, planAlignment, roomDataBase,
} from '../public/js/mods/align.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 真包来源（只读；`harness_1/_up/pv/workshop-demo`：forge_demo + slime_ops + my-workshop-pack）。 */
const REAL_PACKS = path.resolve(ROOT, '..', '_up', 'pv', 'workshop-demo');
const REAL_IDS = ['forge_demo', 'slime_ops', 'my-workshop-pack'];

/** `[evidence]` 行：原始输出，报告直接抄它。 */
const say = (...a) => console.log('[evidence]', ...a);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------------------------------
// 夹具：真包（只读复制）+ 合成回退；以及两个 `createRoomAssets` 实例（服务器那一个 / 手工那一个）
// ---------------------------------------------------------------------------------------------------
let tmp;
let wsRoot;
let fixture = 'unknown';
let srv;
let loaded;               // loadWorkshop(wsRoot)
let processKits;          // loadWorkshopKits 的进程级表
let localAssets;          // 手工 createRoomAssets（只用于判定 1 的缓存结构探针，不污染服务器实例的计数）
/** 房间：{ c: TestClient, room: Room, state: room.state, welcome } */
let roomForge; let roomSlime; let roomForge2; let roomPlus; let roomAll; let roomPlain;
let setForge; let setSlime; let setPlus; let setAll; let processSet;

/** 真包不可用时的等价最小包（形状与真包一致：forge 带 kit + enemies，slime 带 kit，pv 无 kit）。 */
function writeSynthetic(root) {
  const pack = (id, content, files, kits) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name: id, version: '0.1.0', license: 'CC0-1.0', content, overrides: [] }));
    for (const [file, recs] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(recs));
    if (kits) {
      fs.mkdirSync(path.join(dir, 'kits'), { recursive: true });
      for (const k of kits) fs.writeFileSync(path.join(dir, 'kits', `${k}.js`), 'export default () => ({});\n');
    }
  };
  pack('forge_demo', ['chess', 'enemies'],
    { chess: { chess_ws_red_glaive_a: { name: 'red glaive' } }, enemies: { enemy_ws_frost_hound: { name: 'hound' } } },
    ['chess_ws_red_glaive_a']);
  pack('slime_ops', ['chess'], { chess: { chess_ws_slime_slinger_a: { name: 'slime slinger' } } }, ['chess_ws_slime_slinger_a']);
  pack('my-workshop-pack', ['chess'], { chess: { chess_ws_pv_ace_a: { name: 'pv ace' } } }, null);
}

/** 三个真包目录里的 `kits/<id>.js` id（真包与合成包都从盘上读，不硬编码）。 */
const kitIdsOf = (packId) => {
  const dir = path.join(wsRoot, packId, 'kits');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_')).map((n) => n.slice(0, -3)).sort();
};
const tablesOf = (pack) => Object.keys(pack.files).sort();
/** 一张表里属于某个包的 id（逐 id 比较的原料）。 */
const idsIn = (pack, table) => Object.keys((pack.files && pack.files[table]) || {});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-roommodindep-'));
  wsRoot = path.join(tmp, 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });
  if (REAL_IDS.every((id) => fs.existsSync(path.join(REAL_PACKS, id, 'pack.json')))) {
    for (const id of REAL_IDS) fs.cpSync(path.join(REAL_PACKS, id), path.join(wsRoot, id), { recursive: true });
    fixture = `real(${REAL_PACKS})`;
  } else {
    writeSynthetic(wsRoot);
    fixture = `synthetic(real packs missing at ${REAL_PACKS})`;
  }
  say('fixture =', fixture);

  loaded = loadWorkshop(wsRoot, { log: quiet });
  assert.deepEqual(loaded.errors, [], '夹具必须干净装载（没有任何包被拒）');
  assert.deepEqual(loaded.packs.map((p) => p.id).sort(), [...REAL_IDS].sort());
  for (const p of loaded.packs) {
    say(`pack ${p.id}: hash=${p.hash.slice(0, 12)} layer=${p.layer} combat=${p.combat} tables=[${tablesOf(p)}] kits=[${kitIdsOf(p.id)}]`);
  }

  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
  // 服务器装载的包必须与我盘上读到的**逐字节同一批**（id + hash）——否则下面的逐 id 断言就说的不是同一批包
  const serverMods = srv.lobby.workshop.mods.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(serverMods.map((p) => `${p.id}:${p.hash}`), loaded.packs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => `${p.id}:${p.hash}`));

  // 进程级表（真跑与复算两条路径的对照物）
  const localKits = await loadWorkshopKits({ ...loaded }, {
    log: quiet,
    knownIds: new Set([...Object.keys(loadData(path.join(ROOT, 'data'), { log: quiet, workshopDir: null }).chess || {}), ...loaded.packs.flatMap((p) => Object.keys(p.operators || {}))]),
    knownTokenIds: new Set(Object.keys(loadData(path.join(ROOT, 'data'), { log: quiet, workshopDir: null }).tokens || {})),
  });
  processKits = localKits.kits;
  say('process kits =', Object.keys(processKits), 'kit errors =', JSON.stringify(localKits.errors));
  assert.deepEqual(localKits.errors, [], '真包里的 kit 必须全部被接受（否则「按包裁 kit」这条线测不到）');

  // 手工那一个实例（判定 1：缓存结构探针；与服务器那一个同源同字节）
  const dataDir = path.join(ROOT, 'data');
  const official = loadData(dataDir, { log: quiet, workshopDir: null });
  const processData = loadData(dataDir, { log: quiet, workshopDir: wsRoot });
  localAssets = createRoomAssets({
    official, processData, packs: loaded.packs,
    kits: localKits.kits, kitOwners: localKits.owners,
    tokenKits: localKits.tokenKits, tokenKitOwners: localKits.tokenOwners,
    modules: localKits.modules, log: quiet,
  });

  const entries = srv.lobby.workshop.mods;
  setForge = modSetOf(entries.filter((e) => e.id === 'forge_demo'));
  setSlime = modSetOf(entries.filter((e) => e.id === 'slime_ops'));
  setPlus = modSetOf(entries.filter((e) => e.id === 'slime_ops' || e.id === 'my-workshop-pack'));
  setAll = modSetOf(entries);
  processSet = srv.lobby.workshop.roomAssets.forRoom(null);

  // 六个房间同时活着：forge / slime / forge(第二个) / slime+pv / 全部 / 没声明
  const ws = `ws://127.0.0.1:${srv.port}/ws`;
  const open = async (name, modIds) => {
    const c = await TestClient.connect(ws);
    const welcome = await c.hello(name);
    const reply = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: welcome.mods.digest, ...(modIds ? { modIds } : {}) });
    assert.equal(reply.t, 'ok', `${name} room.create: ${JSON.stringify(reply)}`);
    const state = await c.waitFor('room.state', (s) => !!s.code && Array.isArray(s.seats));
    const room = srv.lobby.rooms.get(state.code);
    assert.ok(room, `${name}: 房间必须在会话栈里`);
    return { c, room, state, welcome };
  };
  roomForge = await open('IndepForge', ['forge_demo']);
  roomSlime = await open('IndepSlime', ['slime_ops']);
  roomForge2 = await open('IndepForge2', ['forge_demo']);
  roomPlus = await open('IndepPlus', ['slime_ops', 'my-workshop-pack']);
  roomAll = await open('IndepAll', REAL_IDS);
  roomPlain = await open('IndepPlain');
  for (const [tag, r] of [['forge', roomForge], ['slime', roomSlime], ['forge2', roomForge2], ['plus', roomPlus], ['all', roomAll], ['plain', roomPlain]]) {
    say(`room ${tag}: code=${r.room.code} modIds=${JSON.stringify(r.room.modIds)} digest=${r.room.modSet ? r.room.modSet.digest.slice(0, 16) : 'null'} state.mods=${r.state.mods ? r.state.mods.digest.slice(0, 16) : 'none'}`);
  }
  assert.equal(roomForge.room.modSet.digest, setForge.digest, '房间声明出来的摘要必须等于我用服务器自己的 catalogue 算出来的那一个');
  assert.equal(roomPlus.room.modSet.digest, setPlus.digest);
  assert.equal(roomSlime.room.modSet.digest, setSlime.digest);
  assert.equal(roomPlain.room.modSet, null, '没声明集合的房间 `modSet` 必须是 null');
  assert.equal(roomAll.room.modSet.digest, setAll.digest);
  assert.equal(setAll.digest, modSetOf(entries).digest, '「声明全部」的摘要就是进程摘要');
});

after(async () => {
  for (const r of [roomForge, roomSlime, roomForge2, roomPlus, roomAll, roomPlain]) await r?.c?.terminate();
  await srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------
// 判定 1 — 缓存结构与键（读源码 + 实测）
// ---------------------------------------------------------------------------------------------------
describe('判定 1：`forRoom` 的缓存结构与键（server/roomAssets.js:44-61）', () => {
  test('键 = `modSet.digest`（没有摘要时才回落到排序后的 id 串）；缓存是实例内的 Map，没有模块级可变状态', () => {
    // 源码（server/roomAssets.js）:
    //   :45  const cache = new Map();          ← 在 createRoomAssets 的闭包里 ⇒ 每个实例一份，模块级没有可变状态
    //   :47  const byDigest = new Map();       ← 同上（/room-data/<摘要>/ 那一面）
    //   :48  const sameAsProcess = (ids) => ids.length === allIds.size && ids.every((id) => allIds.has(id));
    //   :51  function isProcess(ids) { return ids.length === 0 || sameAsProcess(ids); }
    //   :60  if (isProcess(ids)) return processAssets;      ← 空集合 / 全集：**本体**，不进缓存
    //   :61  const key = modSet.digest || ids.slice().sort().join(',');
    //   :62  const hit = cache.get(key);
    const a1 = localAssets.forRoom(setForge);
    const a2 = localAssets.forRoom({ digest: setForge.digest, packs: [{ id: 'forge_demo' }] });
    const b1 = localAssets.forRoom(setSlime);
    assert.equal(a2, a1, '同一个摘要 ⇒ 命中同一个实例（键就是摘要，包对象只是重算一遍 id 列表）');
    assert.notEqual(b1, a1, '不同摘要 ⇒ 不同实例');
    say('缓存探针：size=', localAssets.size(), 'digests=', localAssets.digests(), 'A===A(再取)=', a2 === a1, 'A===B=', b1 === a1);

    // 无摘要时才用「排序后的 id 串」当键：同一个集合两次取到同一个实例
    const raw1 = localAssets.forRoom({ packs: [{ id: 'slime_ops' }] });
    const raw2 = localAssets.forRoom({ packs: [{ id: 'slime_ops' }] });
    assert.equal(raw2, raw1, '没有摘要时用 id 串当键，同一个集合仍然是同一个实例');
    assert.notEqual(raw1, b1, '但那是**另一个**缓存条目（键不同 ⇒ 同一集合被物化了第二遍）');
    assert.equal(localAssets.byDigest(setSlime.digest), b1, '按摘要那一面登记的是带摘要的那一次');
    say('无摘要的同集合：raw===b1 ?', raw1 === b1, '（false ⇒ 同一集合被物化两次；size=', localAssets.size(), '）');

    // 键只信摘要、不复核 packs：这是**观测到的**行为，不是从注释推的
    const forged = localAssets.forRoom({ digest: setSlime.digest, packs: [{ id: 'forge_demo' }] });
    assert.equal(forged, b1, '摘要说了算：digest 与 packs 不一致时返回的是那个摘要已经物化过的那一份');
    say('digest=slime 但 packs=[forge_demo] ⇒ 拿到的是 slime 那一份（键不复核 packs）:', Object.keys(forged.data.chess).some((k) => k.startsWith('chess_ws_slime')) ? 'slime 的表' : '不是 slime');
  });

  test('服务器那一个实例：只有真的建造过的集合进缓存，`size()`/`digests()` 与房间数对得上', () => {
    const assets = srv.lobby.workshop.roomAssets;
    // 六个房间：forge / slime / forge(第二个，命中) / slime+pv / 全部（= 进程级，**不进缓存**）/ 没声明
    say('服务器实例 size=', assets.size(), 'digests=', assets.digests(), '（期望 3 / 3：forge、slime、slime+pv；全集与不声明都走本体）');
    assert.equal(assets.size(), 3);
    assert.equal(assets.digests(), 3);
    assert.equal(assets.byDigest(setForge.digest), assets.forRoom(roomForge.room.modSet));
  });

  test('模块级没有可变状态：两个独立实例各有各的缓存，互不干扰', () => {
    const mine = localAssets.forRoom({ digest: 'f'.repeat(64), packs: [{ id: 'forge_demo' }] });
    const theirs = srv.lobby.workshop.roomAssets.byDigest('f'.repeat(64));
    assert.equal(theirs, null, '手工实例里登记的假摘要不会出现在服务器实例里');
    assert.notEqual(mine.data, srv.lobby.workshop.roomAssets.forRoom(setSlime).data, '两个实例物化出来的东西不是同一份（缓存是实例级的 Map）');
    say('两个实例：服务器 size=', srv.lobby.workshop.roomAssets.size(), '手工 size=', localAssets.size(), '（各算各的 ⇒ 没有全局可变状态）');
  });
});

// ---------------------------------------------------------------------------------------------------
// 判定 2 — 两个不同集合的房间，交错调用（并发是重点）
// ---------------------------------------------------------------------------------------------------
describe('判定 2：两个不同集合的房间 A=forge_demo / B=slime_ops，交错调用 forRoom', () => {
  const A_SET = () => roomForge.room.modSet;
  const B_SET = () => roomSlime.room.modSet;

  test('交错 4 轮 A,B,A,B…：每一轮 A 都是同一个实例、B 都是同一个实例，且 A!==B', () => {
    const assets = srv.lobby.workshop.roomAssets;
    const seenA = [];
    const seenB = [];
    for (let i = 0; i < 4; i++) {
      seenA.push(assets.forRoom(A_SET()));
      seenB.push(assets.forRoom(B_SET()));
    }
    for (const [i, s] of seenA.entries()) assert.equal(s, seenA[0], `第 ${i} 轮 A 必须还是同一个实例`);
    for (const [i, s] of seenB.entries()) assert.equal(s, seenB[0], `第 ${i} 轮 B 必须还是同一个实例`);
    assert.notEqual(seenA[0], seenB[0], '不同集合 ⇒ 不同实例');
    assert.notEqual(seenA[0].data, seenB[0].data);
    assert.notEqual(seenA[0].kits, seenB[0].kits);
    say('交错 4 轮：A 恒等 =', seenA.every((s) => s === seenA[0]), 'B 恒等 =', seenB.every((s) => s === seenB[0]), 'A!==B =', seenA[0] !== seenB[0]);
    say('A.data!==B.data =', seenA[0].data !== seenB[0].data, 'A.kits!==B.kits =', seenA[0].kits !== seenB[0].kits, 'A.tokenKits!==B.tokenKits =', seenA[0].tokenKits !== seenB[0].tokenKits);
  });

  test('逐 id 交叉污染检查（数据表）：A 那份里一条 B 的记录都没有，B 同样', () => {
    const assets = srv.lobby.workshop.roomAssets;
    const A = assets.forRoom(A_SET());
    const B = assets.forRoom(B_SET());
    const forge = loaded.packs.find((p) => p.id === 'forge_demo');
    const slime = loaded.packs.find((p) => p.id === 'slime_ops');
    let compared = 0;
    for (const table of [...new Set([...tablesOf(forge), ...tablesOf(slime)])]) {
      const mine = idsIn(forge, table);
      const theirs = idsIn(slime, table);
      for (const id of mine) { compared += 1; assert.ok(Object.hasOwn(A.data[table] || {}, id), `A 必须有自己包的 ${table}/${id}`); assert.equal(Object.hasOwn(B.data[table] || {}, id), false, `B 里不得出现 forge_demo 的 ${table}/${id}`); }
      for (const id of theirs) { compared += 1; assert.ok(Object.hasOwn(B.data[table] || {}, id), `B 必须有自己包的 ${table}/${id}`); assert.equal(Object.hasOwn(A.data[table] || {}, id), false, `A 里不得出现 slime_ops 的 ${table}/${id}`); }
      say(`table ${table}: forge=${mine.length} 条 [${mine.slice(0, 3)}…] slime=${theirs.length} 条 [${theirs.slice(0, 3)}…] ⇒ 各自在自己那一份里、在对方那一份里为 0`);
    }
    say('逐 id 比较次数 =', compared, '（每条都比了两边）');
    assert.ok(compared > 0, '至少要真的比到一些 id');
  });

  test('逐 id 交叉污染检查（行为层）：A.kits 只有 A 的 kit，B 只有 B 的；两张表没有共同键，且函数对象与进程级的是同一个', () => {
    const assets = srv.lobby.workshop.roomAssets;
    const A = assets.forRoom(A_SET());
    const B = assets.forRoom(B_SET());
    const forgeKits = kitIdsOf('forge_demo');
    const slimeKits = kitIdsOf('slime_ops');
    assert.ok(forgeKits.length && slimeKits.length, '夹具必须两个包各带一个 kit，否则这条线没得测');
    assert.deepEqual(Object.keys(A.kits).sort(), forgeKits);
    assert.deepEqual(Object.keys(B.kits).sort(), slimeKits);
    for (const k of forgeKits) { assert.equal(Object.hasOwn(B.kits, k), false, `B 的 kit 表里不得有 ${k}`); assert.equal(A.kits[k], srv.lobby.workshop.kits[k], '按包裁的是**表**，函数还是进程级那个函数（`kits/<id>.js` 同一个 data: URL ⇒ 同一个模块实例）'); }
    for (const k of slimeKits) { assert.equal(Object.hasOwn(A.kits, k), false, `A 的 kit 表里不得有 ${k}`); assert.equal(B.kits[k], srv.lobby.workshop.kits[k]); }
    assert.deepEqual(Object.keys(A.kits).filter((k) => Object.hasOwn(B.kits, k)), [], '两张 kit 表没有共同键');
    assert.deepEqual(A.modules.map((m) => m.pack), ['forge_demo']);
    assert.deepEqual(B.modules.map((m) => m.pack), ['slime_ops']);
    assert.deepEqual(Object.keys(srv.lobby.workshop.kits).sort(), [...forgeKits, ...slimeKits].sort(), '进程级那张表两个包的 kit 都在（没被裁剪过）');
    say('A.kits =', Object.keys(A.kits), 'B.kits =', Object.keys(B.kits), '交集 =', Object.keys(A.kits).filter((k) => Object.hasOwn(B.kits, k)));
    say('A.kits[forgeKit] === 进程级[forgeKit] ?', A.kits[forgeKits[0]] === srv.lobby.workshop.kits[forgeKits[0]], 'B.kits[slimeKit] === 进程级[slimeKit] ?', B.kits[slimeKits[0]] === srv.lobby.workshop.kits[slimeKits[0]]);
  });

  test('冻结 + 进程级那片表没被动过：一个房间改不到另一个房间看到的东西', () => {
    const assets = srv.lobby.workshop.roomAssets;
    const A = assets.forRoom(A_SET());
    const B = assets.forRoom(B_SET());
    assert.ok(Object.isFrozen(A.data) && Object.isFrozen(A.kits) && Object.isFrozen(A.tokenKits) && Object.isFrozen(A.modules));
    assert.throws(() => { A.kits.__injected = () => ({}); }, TypeError, '冻结的表改不动');
    assert.throws(() => { A.data.__injected = 1; }, TypeError, '冻结的数据改不动');
    assert.equal(Object.hasOwn(B.kits, '__injected'), false);
    assert.deepEqual(Object.keys(processKits).sort(), [...kitIdsOf('forge_demo'), ...kitIdsOf('slime_ops')].sort(), '交错 4 轮 + 裁剪之后「进程级那一份」的键一个都没多、没少');
    // 服务器自己那张进程级表（`Lobby.workshop.kits`）也没被动过，而且**裁剪出来的表与它共享同一批函数对象**
    // （两次 loadWorkshopKits 出来的**表对象**不同，但 `kits/<id>.js` 走的是同一个 `data:` URL ⇒ 同一个模块实例）
    assert.deepEqual(Object.keys(srv.lobby.workshop.kits).sort(), [...kitIdsOf('forge_demo'), ...kitIdsOf('slime_ops')].sort());
    assert.equal(A.kits[kitIdsOf('forge_demo')[0]], srv.lobby.workshop.kits[kitIdsOf('forge_demo')[0]], '裁剪只是换了一张表，函数还是那个函数');
    assert.notEqual(A.kits, srv.lobby.workshop.kits, '裁剪出来的是**新表**（不是把进程级那张改小）');
    say('冻结探针：A.kits/A.data 写入抛 TypeError；进程级 kits 键 =', Object.keys(srv.lobby.workshop.kits), '| A.kits 是新表 ?', A.kits !== srv.lobby.workshop.kits);
  });

  test('（真包没有召唤物 kit ⇒ 合成补测）tokenKits 与 kits 两个键空间各自按包裁', () => {
    // 三个真包都没有 `kits/<tokenId>.js`（探针：tokenKits = []），所以这一格用最小合成包补。
    const official = Object.freeze({ chess: { chess_official_a: { chessId: 'chess_official_a' } }, tokens: { token_official_a: { id: 'token_official_a' } } });
    const hash64 = (s) => s.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a');
    const pack = (id, chessId, tokenId) => ({
      id, hash: hash64(id.slice(0, 8)), layer: 'B', combat: true, api: null,
      content: ['chess', 'tokens'], overrides: [],
      files: { chess: { [chessId]: { chessId, baseId: chessId, visible: true, tier: 1 } }, tokens: { [tokenId]: { id: tokenId } } },
    });
    const packs = [pack('alpha-pack', 'chess_ws_alpha_a', 'token_ws_alpha'), pack('zeta-pack', 'chess_ws_zeta_a', 'token_ws_zeta')];
    const built = createRoomAssets({
      official,
      processData: deepFreeze(applyWorkshop(official, packs).data),
      packs,
      kits: { chess_ws_alpha_a: () => ({}), chess_ws_zeta_a: () => ({}) },
      kitOwners: new Map([['chess_ws_alpha_a', 'alpha-pack'], ['chess_ws_zeta_a', 'zeta-pack']]),
      tokenKits: { token_ws_alpha: () => ({}), token_ws_zeta: () => ({}) },
      tokenKitOwners: new Map([['token_ws_alpha', 'alpha-pack'], ['token_ws_zeta', 'zeta-pack']]),
      modules: [
        { id: 'chess_ws_alpha_a', pack: 'alpha-pack', url: '/a.js' }, { id: 'token_ws_alpha', pack: 'alpha-pack', url: '/at.js', kind: 'token' },
        { id: 'chess_ws_zeta_a', pack: 'zeta-pack', url: '/z.js' }, { id: 'token_ws_zeta', pack: 'zeta-pack', url: '/zt.js', kind: 'token' },
      ],
      log: quiet,
    });
    const setOf = (ids) => modSetOf(packs.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat })));
    const aSet = setOf(['alpha-pack']);
    const zSet = setOf(['zeta-pack']);
    const seenA = []; const seenZ = [];
    for (let i = 0; i < 4; i++) { seenA.push(built.forRoom(aSet)); seenZ.push(built.forRoom(zSet)); }
    assert.ok(seenA.every((s) => s === seenA[0]) && seenZ.every((s) => s === seenZ[0]));
    assert.notEqual(seenA[0], seenZ[0]);
    assert.deepEqual(Object.keys(seenA[0].kits), ['chess_ws_alpha_a']);
    assert.deepEqual(Object.keys(seenA[0].tokenKits), ['token_ws_alpha'], '另一个包的 summon kit 不该跟着过来');
    assert.deepEqual(Object.keys(seenZ[0].kits), ['chess_ws_zeta_a']);
    assert.deepEqual(Object.keys(seenZ[0].tokenKits), ['token_ws_zeta']);
    assert.equal(Object.hasOwn(seenA[0].tokenKits, 'token_ws_zeta'), false);
    assert.equal(Object.hasOwn(seenZ[0].tokenKits, 'token_ws_alpha'), false);
    assert.deepEqual(seenA[0].modules.map((m) => `${m.pack}:${m.kind || 'chess'}`), ['alpha-pack:chess', 'alpha-pack:token']);
    assert.equal(built.forRoom(null), built.forRoom({ digest: 'x'.repeat(64), packs: [] }), '空集合 ⇒ 同一个进程级本体');
    say('合成 tokenKits 探针：A.tokenKits =', Object.keys(seenA[0].tokenKits), 'Z.tokenKits =', Object.keys(seenZ[0].tokenKits));
  });
});

// ---------------------------------------------------------------------------------------------------
// 判定 3 / 4 — 同集合共享；没声明集合是本体
// ---------------------------------------------------------------------------------------------------
describe('判定 3：同集合的两个房间拿到同一个实例（缓存共享是设计意图）', () => {
  test('两个都声明 forge_demo 的**活房间**，`forRoom` 返回同一个对象', () => {
    const assets = srv.lobby.workshop.roomAssets;
    assert.notEqual(roomForge.room, roomForge2.room, '是两个不同的房间');
    assert.equal(roomForge.room.code === roomForge2.room.code, false);
    assert.notEqual(roomForge.room.modSet, roomForge2.room.modSet, '两个房间各自在 room.create 里解析出来的 modSet 对象是两个');
    assert.equal(roomForge2.room.modSet.digest, roomForge.room.modSet.digest, '但摘要相同');
    const one = assets.forRoom(roomForge.room.modSet);
    const two = assets.forRoom(roomForge2.room.modSet);
    assert.equal(two, one, '同集合 ⇒ 同一个物化结果（===，不是 deepEqual）');
    assert.equal(two.kits, one.kits);
    assert.equal(two.data, one.data);
    say('roomForge.code =', roomForge.room.code, 'roomForge2.code =', roomForge2.room.code, 'forRoom 恒等 =', two === one);
  });

  test('第三个不同的集合（slime+pv）仍然是不同实例，而三个集合的实例两两不等', () => {
    const assets = srv.lobby.workshop.roomAssets;
    const f = assets.forRoom(roomForge.room.modSet);
    const s = assets.forRoom(roomSlime.room.modSet);
    const p = assets.forRoom(roomPlus.room.modSet);
    assert.notEqual(p, f); assert.notEqual(p, s); assert.notEqual(f, s);
    assert.deepEqual(Object.keys(p.kits).sort(), kitIdsOf('slime_ops'), 'slime+pv 那一份只有 slime 的 kit（pv 没有 kit）');
    assert.deepEqual(p.modules.map((m) => m.pack), ['slime_ops']);
    say('三个集合两两不等：f!==s', f !== s, 'f!==p', f !== p, 's!==p', s !== p, '| p.kits =', Object.keys(p.kits));
  });
});

describe('判定 4：没声明集合的房间 ⇒ 进程级那一份**本体**', () => {
  test('`===` 恒等（不是 deepEqual）：room.modSet 为 null，拿到的是同一个对象', () => {
    const assets = srv.lobby.workshop.roomAssets;
    const process = assets.forRoom(null);
    assert.equal(roomPlain.room.modSet, null);
    assert.equal(roomPlain.room.modIds, null);
    assert.equal(assets.forRoom(roomPlain.room.modSet), process, '没声明集合的房间拿到的是本体');
    assert.equal(assets.forRoom(null), processSet, '本体在 before 里就取过一次，现在还是同一个对象（进程级唯一）');
    assert.equal(process, processSet);
    assert.equal(assets.byDigest('0'.repeat(64)), null, '本体不进按摘要那一面');
    // 「声明了全部」也走同一条：返回**同一个**对象，而且摘要与进程摘要相同（客户端因此走 /data/）
    const all = assets.forRoom(roomAll.room.modSet);
    assert.equal(all, process, '声明了全部包同样是本体（同一个对象）');
    assert.equal(roomAll.room.modSet.digest, modSetOf(srv.lobby.workshop.mods).digest);
    // 「本体」这个说法要落到 Lobby 自己那几张表上：交给没声明集合的房间的 kits，就是 `Lobby.workshop.kits` 本身
    assert.equal(process.kits, srv.lobby.workshop.kits, '没声明集合拿到的 kits 就是 Lobby 自己那张进程级表（===）');
    assert.equal(process.data, srv.lobby.workshop.roomAssets.forRoom(null).data);
    say('forRoom(null) === forRoom(全集) ?', all === process, '| 全集摘要 === 进程摘要 ?', roomAll.room.modSet.digest === modSetOf(srv.lobby.workshop.mods).digest);
    say('本体 kits === Lobby.workshop.kits ?', process.kits === srv.lobby.workshop.kits, '| 本体 data === forRoom(null).data ?', process.data === srv.lobby.workshop.roomAssets.forRoom(null).data);
  });

  test('逐字节：拿到的那一份序列化后与 `/data/<表>.json` 送出的字节完全一致（与今天相同）', async () => {
    const assets = srv.lobby.workshop.roomAssets;
    const face = assets.forRoom(roomPlain.room.modSet);
    const base = `http://127.0.0.1:${srv.port}`;
    let checked = 0;
    for (const table of ['chess', 'bonds', 'stages', 'tokens']) {
      if (!face.data[table]) continue;
      const res = await fetch(`${base}/data/${table}.json`);
      assert.equal(res.status, 200, `/data/${table}.json 必须 200`);
      const body = Buffer.from(await res.arrayBuffer());
      const mine = Buffer.from(JSON.stringify(face.data[table]), 'utf8');
      assert.equal(sha(body), sha(mine), `/data/${table}.json 的字节必须与「没声明集合的房间」那一份序列化后逐字节相同`);
      checked += 1;
      say(`逐字节 /data/${table}.json: len=${body.length} sha=${sha(body).slice(0, 16)} === forRoom(null).data.${table} 序列化`);
    }
    assert.ok(checked >= 2, '至少要真的比到几张表');
    // 声明了全部包的那个房间：同样逐字节相同
    const allFace = assets.forRoom(roomAll.room.modSet);
    assert.equal(sha(Buffer.from(JSON.stringify(allFace.data.chess), 'utf8')), sha(Buffer.from(JSON.stringify(face.data.chess), 'utf8')));
    say('「声明全部」与「不声明」的 chess 序列化 sha 相同：', sha(Buffer.from(JSON.stringify(allFace.data.chess), 'utf8')).slice(0, 16));
  });
});

// ---------------------------------------------------------------------------------------------------
// 判定 5 — 进到 Match 层（决定性的一步）
// ---------------------------------------------------------------------------------------------------
describe('判定 5：两个房间各自开一局，注入 Match 的工坊表分别是各自房间那一份', () => {
  const startMatch = async (r) => {
    assert.equal((await r.c.request({ t: 'room.ready', ready: true })).t, 'ok');
    const reply = await r.c.request({ t: 'room.start' });
    assert.equal(reply.t, 'ok', `${r.room.code} room.start: ${JSON.stringify(reply)}`);
    assert.ok(r.room.match, `${r.room.code} 必须建起对局`);
    return r.room.match;
  };

  test('两局同时活着：`workshopKits` / `workshopTokenKits` 就是各自 `forRoom(room.modSet)` 的那一份（===）', async () => {
    const mForge = await startMatch(roomForge);
    const mSlime = await startMatch(roomSlime);
    const assets = srv.lobby.workshop.roomAssets;
    const expectA = assets.forRoom(roomForge.room.modSet);
    const expectB = assets.forRoom(roomSlime.room.modSet);
    assert.ok(roomForge.room.match && roomSlime.room.match, '两局必须同时活着');
    assert.notEqual(roomForge.room.match, roomSlime.room.match);
    // 真跑这一条（`lobby.js:1423` → Match opts）
    assert.equal(mForge.data, expectA.data, '这一局的数据就是本房间那一份（=== 而不是 deepEqual）');
    assert.equal(mForge.workshopKits, expectA.kits, '注入的 kit 表就是本房间那一份（===）');
    assert.equal(mForge.workshopTokenKits, expectA.tokenKits);
    assert.equal(mSlime.data, expectB.data);
    assert.equal(mSlime.workshopKits, expectB.kits);
    assert.equal(mSlime.workshopTokenKits, expectB.tokenKits);
    // 两局之间
    assert.notEqual(mForge.workshopKits, mSlime.workshopKits, '两局的 kits 引用必须不相等');
    assert.notEqual(mForge.data, mSlime.data);
    assert.deepEqual(Object.keys(mForge.workshopKits), kitIdsOf('forge_demo'));
    assert.deepEqual(Object.keys(mSlime.workshopKits), kitIdsOf('slime_ops'));
    assert.equal(mForge.mods.digest, roomForge.room.modSet.digest, 'spec 上的 mods 是房间摘要');
    assert.equal(mSlime.mods.digest, roomSlime.room.modSet.digest);
    assert.notEqual(mForge.mods.digest, mSlime.mods.digest);
    // 逐 id：A 那局不得有 B 的包里的记录与 kit
    for (const id of idsIn(loaded.packs.find((p) => p.id === 'slime_ops'), 'chess')) assert.equal(Object.hasOwn(mForge.data.chess, id), false, `forge 那一局不得有 ${id}`);
    for (const id of idsIn(loaded.packs.find((p) => p.id === 'forge_demo'), 'chess')) assert.equal(Object.hasOwn(mSlime.data.chess, id), false, `slime 那一局不得有 ${id}`);
    say('matchForge.kits =', Object.keys(mForge.workshopKits), '=== forRoom(forge) =', mForge.workshopKits === expectA.kits);
    say('matchSlime.kits =', Object.keys(mSlime.workshopKits), '=== forRoom(slime) =', mSlime.workshopKits === expectB.kits);
    say('两局 kits 引用相等 ?', mForge.workshopKits === mSlime.workshopKits, '| data 引用相等 ?', mForge.data === mSlime.data, '| mods.digest', mForge.mods.digest.slice(0, 16), mSlime.mods.digest.slice(0, 16));
  });

  test('真跑（newBattle）与复算（specBattleOpts）两条组装路径拿到的是**本房间那一份**', async () => {
    const mForge = roomForge.room.match;
    const mSlime = roomSlime.room.match;
    const assets = srv.lobby.workshop.roomAssets;
    const expectA = assets.forRoom(roomForge.room.modSet);
    const expectB = assets.forRoom(roomSlime.room.modSet);
    // 复算那条路（server/match/match/battleOpts.js specBattleOpts ← clientCombat._specBattle）
    assert.equal(specBattleOpts(mForge, {}).kits, expectA.kits);
    assert.equal(specBattleOpts(mSlime, {}).kits, expectB.kits);
    assert.equal(specBattleOpts(mForge, {}).tokenKits, expectA.tokenKits);
    assert.notEqual(specBattleOpts(mForge, {}).kits, specBattleOpts(mSlime, {}).kits);
    // 真跑那条路：不猜 `newBattle` 传了什么，把 BattleClass 包一层把这个 battle 真正的 opts 抓下来
    const capture = (match) => {
      const Real = match.BattleClass;
      let seen = null;
      match.BattleClass = class extends Real { constructor(opts) { seen = opts; super(opts); } };
      try { match.newBattle({ fieldId: 'indep-probe', kind: 'normal', seed: 7 }); } catch { /* newBattle 自己有兜底 */ }
      match.BattleClass = Real;
      return seen;
    };
    const optsForge = capture(mForge);
    const optsSlime = capture(mSlime);
    assert.ok(optsForge && optsSlime, '两条路都必须真的把 opts 交出去了');
    assert.equal(optsForge.kits, expectA.kits, 'forge 那一局的 Battle 拿到的 kits 就是本房间那一份（===）');
    assert.equal(optsSlime.kits, expectB.kits, 'slime 那一局的 Battle 拿到的 kits 就是本房间那一份（===）');
    assert.notEqual(optsForge.kits, optsSlime.kits);
    assert.equal(Object.hasOwn(optsForge.kits, kitIdsOf('slime_ops')[0]), false);
    assert.equal(Object.hasOwn(optsSlime.kits, kitIdsOf('forge_demo')[0]), false);
    // battleOptsFromMatch 是这两条路共用的那一处（`===` 直接钉住）
    assert.equal(battleOptsFromMatch(mForge, {}).kits, expectA.kits);
    say('specBattleOpts 复算路径：forge ===', specBattleOpts(mForge, {}).kits === expectA.kits, 'slime ===', specBattleOpts(mSlime, {}).kits === expectB.kits);
    say('真实 newBattle 抓到的 opts.kits：forge ===', optsForge.kits === expectA.kits, 'slime ===', optsSlime.kits === expectB.kits, '| 两者相等 ?', optsForge.kits === optsSlime.kits);
  });

  test('没声明集合的房间开一局：拿到的同样是进程级本体（含两个包的 kit，这是设计而不是污染）', async () => {
    assert.equal((await roomPlain.c.request({ t: 'room.ready', ready: true })).t, 'ok');
    assert.equal((await roomPlain.c.request({ t: 'room.start' })).t, 'ok');
    const m = roomPlain.room.match;
    const process = srv.lobby.workshop.roomAssets.forRoom(null);
    assert.equal(m.data, process.data);
    assert.equal(m.workshopKits, process.kits, '没声明集合 ⇒ 进程级那张表的本体（两个包的 kit 都在）');
    assert.equal(m.workshopKits, srv.lobby.workshop.kits, '而且就是 Lobby 自己那张表（===）');
    assert.deepEqual(Object.keys(m.workshopKits).sort(), [...kitIdsOf('forge_demo'), ...kitIdsOf('slime_ops')].sort());
    assert.equal(m.mods.digest, modSetOf(srv.lobby.workshop.mods).digest);
    say('未声明房间那一局 kits =', Object.keys(m.workshopKits), '=== Lobby.workshop.kits ?', m.workshopKits === srv.lobby.workshop.kits, '| mods.digest', m.mods.digest.slice(0, 16));
  });
});

// ---------------------------------------------------------------------------------------------------
// 判定 6 — 每房间数据面
// ---------------------------------------------------------------------------------------------------
describe('判定 6：/room-data/<摘要>/ 两个面内容不同，A 的摘要拿不到 B 的东西', () => {
  const base = () => `http://127.0.0.1:${srv.port}`;
  const get = async (p) => { const r = await fetch(base() + p); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; };

  test('两个摘要的 chess.json 字节不同，各自只有自己的包；A 的摘要 + 未登记文件名 / 未登记摘要 / 形状不对的摘要一律 404', async () => {
    const dA = roomForge.room.modSet.digest;
    const dB = roomSlime.room.modSet.digest;
    assert.notEqual(dA, dB);
    const a = await get(`/room-data/${dA}/chess.json`);
    const b = await get(`/room-data/${dB}/chess.json`);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.notEqual(sha(a.body), sha(b.body), '两个房间的数据面字节不同');
    const aChess = JSON.parse(a.body.toString());
    const bChess = JSON.parse(b.body.toString());
    const forgeIds = idsIn(loaded.packs.find((p) => p.id === 'forge_demo'), 'chess');
    const slimeIds = idsIn(loaded.packs.find((p) => p.id === 'slime_ops'), 'chess');
    for (const id of forgeIds) { assert.ok(Object.hasOwn(aChess, id), `A 面必须有 ${id}`); assert.equal(Object.hasOwn(bChess, id), false, `B 面不得有 ${id}`); }
    for (const id of slimeIds) { assert.ok(Object.hasOwn(bChess, id), `B 面必须有 ${id}`); assert.equal(Object.hasOwn(aChess, id), false, `A 面不得有 ${id}`); }
    say(`A 面 chess: len=${a.body.length} sha=${sha(a.body).slice(0, 16)} forge ids 全在、slime ids 全不在`);
    say(`B 面 chess: len=${b.body.length} sha=${sha(b.body).slice(0, 16)} slime ids 全在、forge ids 全不在`);
    say('两面字节相同 ?', sha(a.body) === sha(b.body));
    // 未登记的文件名 / 未登记的摘要 / 形状不对的摘要
    for (const p of [`/room-data/${dA}/nope.json`, `/room-data/${'0'.repeat(64)}/chess.json`, `/room-data/nope/chess.json`]) {
      const r = await get(p);
      assert.equal(r.status, 404, `${p} 必须 404`);
      say(`404 ${p}`);
    }
  });

  test('只有 A 声明的表：A 面有它的记录，B 面同样的文件名只能是官方那部分（没有 A 的记录）', async () => {
    const forge = loaded.packs.find((p) => p.id === 'forge_demo');
    const slime = loaded.packs.find((p) => p.id === 'slime_ops');
    const onlyForge = tablesOf(forge).filter((t) => !tablesOf(slime).includes(t));
    say('只有 forge_demo 声明的表 =', onlyForge);
    for (const table of onlyForge) {
      const ids = idsIn(forge, table);
      if (!ids.length) continue;
      const a = await get(`/room-data/${roomForge.room.modSet.digest}/${table}.json`);
      const b = await get(`/room-data/${roomSlime.room.modSet.digest}/${table}.json`);
      assert.equal(a.status, 200, `A 面 ${table}.json 必须 200`);
      const aRec = JSON.parse(a.body.toString());
      for (const id of ids) assert.ok(Object.hasOwn(aRec, id), `A 面 ${table}.json 必须有 ${id}`);
      if (b.status === 200) {
        const bRec = JSON.parse(b.body.toString());
        for (const id of ids) assert.equal(Object.hasOwn(bRec, id), false, `B 面 ${table}.json 不得有 forge 的 ${id}`);
      } else {
        assert.equal(b.status, 404, `B 面 ${table}.json 要么是官方那份 200、要么 404，不能是别的`);
      }
      say(`${table}.json: A face 200（含 ${ids.length} 条 forge 记录），B face ${b.status}`);
    }
  });

  test('越界 / 穿越探针：`..`、`%2e%2e`、跨摘要拼路径一律不吐别人的东西', async () => {
    const dA = roomForge.room.modSet.digest;
    const dB = roomSlime.room.modSet.digest;
    const legit = {
      a: sha((await get(`/room-data/${dA}/chess.json`)).body),
      b: sha((await get(`/room-data/${dB}/chess.json`)).body),
      process: sha((await get('/data/chess.json')).body),
    };
    const probes = [
      `/room-data/${dA}/../data/chess.json`,
      `/room-data/${dA}/%2e%2e/data/chess.json`,
      `/room-data/${dA}/..%2fdata%2fchess.json`,
      `/room-data/${dB}/../room-data/${dA}/chess.json`,
      `/room-data/${dA}/chess.json/../../data/chess.json`,
    ];
    for (const p of probes) {
      const r = await get(p);
      const got = sha(r.body);
      const isLeak = r.status === 200 && ![legit.a, legit.b, legit.process].includes(got);
      assert.equal(isLeak, false, `${p} 吐出了一个不该有的体（status=${r.status} sha=${got.slice(0, 16)}）`);
      // 逐条说清它到底落在哪一面：404，或者落到一个**合法**的面（A / B / 进程级），绝不是「A 的摘要 + B 的内容」这种混合
      const face = got === legit.a ? 'legit:A' : got === legit.b ? 'legit:B' : got === legit.process ? 'legit:process' : 'denied';
      say(`${String(r.status).padEnd(3)} ${face.padEnd(13)} ${p}`);
      assert.equal(face === 'denied' && r.status !== 404, false, `${p} 的拒绝必须是 404`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 判定 7 — 客户端闸门（纯函数级）
// ---------------------------------------------------------------------------------------------------
describe('判定 7：只装了 A 的客户端看 B 的房间 ⇒ ok:false 并按名字指出缺哪个包', () => {
  test('planAlignment：本地只有 forge_demo 的字节，看 slime 的房间 ⇒ 未就绪、点名 slime_ops；看自己那个房间 ⇒ 就绪', async () => {
    const catalog = await (await fetch(`http://127.0.0.1:${srv.port}/mods/catalog.json`)).json();
    say('catalog packs =', catalog.packs.map((p) => `${p.id}(${p.files.length} files)`).join(' '));
    const store = createStore(createMemoryBackend());
    const forgeEntry = catalog.packs.find((p) => p.id === 'forge_demo');
    for (const f of forgeEntry.files) {
      await store.write(modKey('forge_demo', f.path), new Uint8Array(fs.readFileSync(path.join(wsRoot, 'forge_demo', ...f.path.split('/')))));
    }
    // 对照：这个 store 看 A 的房间是**就绪**的（所以下面的 false 说的是 B，不是 store 坏了）
    const ownRoom = await planAlignment({ catalog, mods: roomForge.room.modSet, store });
    assert.equal(ownRoom.ok, true, '本地装好了 A ⇒ 看 A 的房间必须就绪');
    assert.deepEqual(missingPackIds(ownRoom), []);
    // 正题：同一个客户端去看 B 的房间
    const other = await planAlignment({ catalog, mods: roomSlime.room.modSet, store });
    assert.equal(other.needed, true);
    assert.equal(other.ok, false, '缺件 ⇒ 未就绪（进得了房、开不了局）');
    assert.equal(other.held, null);
    assert.deepEqual(other.packs, [{ id: 'slime_ops', ok: false, known: true }]);
    assert.deepEqual(missingPackIds(other), ['slime_ops'], '按名字指出缺的是哪个包');
    assert.ok(other.missingFiles > 0);
    say('本机只装 forge_demo：看 forge 房间 ok=', ownRoom.ok, '；看 slime 房间 ok=', other.ok, '缺=', JSON.stringify(missingPackIds(other)), 'missingFiles=', other.missingFiles);
  });

  test('服务器根本不带的包：planAlignment 与 alignRoom 都点名 unknown，且不需要下载任何东西', async () => {
    const catalog = await (await fetch(`http://127.0.0.1:${srv.port}/mods/catalog.json`)).json();
    const store = createStore(createMemoryBackend());
    const ghost = { digest: 'a'.repeat(64), packs: [{ id: 'ghost-pack', hash: 'b'.repeat(64) }] };
    const plan = await planAlignment({ catalog, mods: ghost, store });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.unknown, ['ghost-pack']);
    assert.deepEqual(missingPackIds(plan), ['ghost-pack']);
    let calls = 0;
    const aligned = await alignRoom({ catalog, mods: ghost, store, fetch: async () => { calls += 1; return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; } });
    assert.equal(aligned.ok, false);
    assert.equal(calls, 0, '服务器没有的包一个请求都不发（下载也救不了）');
    say('ghost 包：plan.ok=', plan.ok, 'unknown=', JSON.stringify(plan.unknown), 'alignRoom 请求数=', calls);
  });

  test('roomDataBase：声明了子集的房间走自己那个面，没声明 / 声明全部走 /data/', async () => {
    const welcome = roomForge.welcome.mods;
    assert.equal(roomDataBase(roomSlime.room.modSet, welcome), `${ROOM_DATA_PREFIX}${roomSlime.room.modSet.digest}/`);
    assert.equal(roomDataBase(roomForge.room.modSet, welcome), `${ROOM_DATA_PREFIX}${roomForge.room.modSet.digest}/`);
    assert.equal(roomDataBase(roomPlain.room.modSet, welcome), DATA_PREFIX, '没声明集合 ⇒ 进程面');
    assert.equal(roomDataBase(roomAll.room.modSet, welcome), DATA_PREFIX, '声明了全部 ⇒ 摘要等于进程摘要 ⇒ 进程面（所以那个房间没有 /room-data/ 面也没关系）');
    const allFace = await fetch(`http://127.0.0.1:${srv.port}/room-data/${roomAll.room.modSet.digest}/chess.json`);
    assert.equal(allFace.status, 404, '全集不进按摘要那一面（客户端也不会去要）');
    say('roomDataBase：subset ⇒', roomDataBase(roomSlime.room.modSet, welcome), '| plain ⇒', DATA_PREFIX, '| all ⇒', DATA_PREFIX, '| 全集 /room-data/ ⇒', allFace.status);
  });
});
