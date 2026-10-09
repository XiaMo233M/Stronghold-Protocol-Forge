// test/modAlign.test.js — 对齐到房间自己那套 (W-D, DESIGN §28.16): public/js/mods/align.js.
//
// W-B made a room's declared set decide what the room runs and put that room's data face on the wire. W-D is the client
// half: does THIS client really hold those packs, can it fetch exactly them, and which data face must a battle of that
// room be simulated on. What this file pins:
//
//   1. `roomDataBase` — the process face on a plain install / a room that declared nothing, the room's own otherwise,
//      and never a path built from something that is not a digest;
//   2. `planAlignment` — 「就绪」 only when the BYTES rebuild every pack the room declared (a missing file, a corrupted
//      file, or a server that does not carry one of them all answer no, and the last one is named);
//   3. `alignRoom` — downloads exactly the room's packs (never the others the server carries), then the answer flips to
//      yes; progress events reach the caller.
//
// The download half runs against a REAL server (the /mods routes) with the memory backend and a fetch that reads the
// fixture files, so the hashes are the server's own.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { buildModCatalog } from '../server/modCatalog.js';
import { modSetOf } from '../shared/modIdentity.js';
import { createMemoryBackend, createStore, modKey } from '../public/js/mods/store.js';
import {
  DATA_PREFIX, ROOM_DATA_PREFIX, alignRoom, loadCatalog, missingPackIds, planAlignment, resetCatalog, roomDataBase,
  setStore, storeFor,
} from '../public/js/mods/align.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A `fetch` that serves the fixture files for a `/mods/file/...` URL (the same shape test/modStore.test.js uses). */
function fixtureFetch(root, { onCall = null } = {}) {
  return async (url) => {
    onCall?.(String(url));
    const rel = String(url).replace(/^\/mods\/file\//, '');
    const slash = rel.indexOf('/');
    const id = decodeURIComponent(rel.slice(0, slash));
    const p = rel.slice(slash + 1).split('/').map(decodeURIComponent).join('/');
    const abs = path.join(root, id, ...p.split('/'));
    if (!fs.existsSync(abs)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = fs.readFileSync(abs);
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(buf).buffer };
  };
}

let tmp;
let wsRoot;
let loaded;
let catalog;
let srv;
let roomSet;   // alpha-pack only
let bothSet;   // alpha + beta

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modalign-'));
  wsRoot = path.join(tmp, 'ws');
  const alpha = path.join(wsRoot, 'alpha-pack');
  fs.mkdirSync(joinSafe(alpha, 'kits'), { recursive: true });
  fs.writeFileSync(path.join(alpha, 'pack.json'), JSON.stringify({ id: 'alpha-pack', name: 'Alpha', version: '1.0.0', license: 'CC0-1.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(path.join(alpha, 'chess.json'), JSON.stringify({ chess_ws_alpha: { name: 'alpha' } }));
  fs.writeFileSync(path.join(alpha, 'kits', 'chess_ws_alpha.js'), 'export default () => ({});\n');
  const beta = path.join(wsRoot, 'beta-pack');
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(path.join(beta, 'pack.json'), JSON.stringify({ id: 'beta-pack', name: 'Beta', version: '1.0.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(path.join(beta, 'chess.json'), JSON.stringify({ chess_ws_beta: { name: 'beta' } }));

  loaded = loadWorkshop(wsRoot, { log: quiet });
  assert.deepEqual(loaded.errors, []);
  catalog = buildModCatalog(loaded);
  const entries = loaded.packs.map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }));
  roomSet = modSetOf(entries.filter((e) => e.id === 'alpha-pack'));
  bothSet = modSetOf(entries);
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
});

/** Windows-safe join alias, so the fixture block above reads like the store test's. */
function joinSafe(...parts) { return path.join(...parts); }

after(async () => {
  await srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { resetCatalog(); setStore(null); });

describe('房间该在哪个数据面上模拟（roomDataBase）', () => {
  test('没声明集合、空集合、声明了全部：都是进程那一份 /data/', () => {
    assert.equal(roomDataBase(null, bothSet), DATA_PREFIX);
    assert.equal(roomDataBase(undefined, null), DATA_PREFIX);
    assert.equal(roomDataBase({ digest: bothSet.digest, packs: bothSet.packs }, bothSet), DATA_PREFIX, '房间集合与进程集合相同 ⇒ 还是那一份');
    assert.equal(roomDataBase(null, null), DATA_PREFIX, '干净安装上 welcome 里没有 mods');
  });

  test('声明了子集：走房间自己的 /room-data/<摘要>/', () => {
    assert.equal(roomDataBase(roomSet, bothSet), `${ROOM_DATA_PREFIX}${roomSet.digest}/`);
    assert.equal(roomDataBase(roomSet, null), `${ROOM_DATA_PREFIX}${roomSet.digest}/`, 'welcome 没给集合时也认这个房间自己的');
  });

  test('形状不对的摘要一律回到 /data/，绝不拼进 URL', () => {
    for (const digest of ['', 'deadbeef', '../etc', 'x'.repeat(64), roomSet.digest.toUpperCase()]) {
      assert.equal(roomDataBase({ digest }, null), DATA_PREFIX, JSON.stringify(digest));
    }
  });
});

describe('对齐状态（planAlignment）：就绪要凭本地字节，不凭「我在 welcome 里见过」', () => {
  test('空缓存：未就绪，缺的是这个房间那几个包的文件，未知名单为空', async () => {
    const store = createStore(createMemoryBackend());
    const plan = await planAlignment({ catalog, mods: roomSet, store });
    assert.equal(plan.needed, true);
    assert.equal(plan.ok, false);
    assert.equal(plan.held, null);
    assert.deepEqual(plan.packs, [{ id: 'alpha-pack', ok: false, known: true }]);
    assert.deepEqual(plan.unknown, []);
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    assert.equal(plan.missingFiles, alpha.files.length);
  });

  test('房间没声明集合：needed=false，不做任何检查（干净安装的路径）', async () => {
    const store = createStore(createMemoryBackend());
    for (const mods of [null, { digest: 'x', packs: [] }]) {
      const plan = await planAlignment({ catalog, mods, store });
      assert.equal(plan.needed, false);
      assert.equal(plan.ok, true);
      assert.deepEqual(plan.packs, []);
    }
  });

  test('房间点名了服务器没有的包：点名 unknown、判定未就绪（客户端没法下载它）', async () => {
    const store = createStore(createMemoryBackend());
    const mods = { digest: 'a'.repeat(64), packs: [{ id: 'ghost-pack', hash: 'b'.repeat(64) }] };
    const plan = await planAlignment({ catalog, mods, store });
    assert.deepEqual(plan.unknown, ['ghost-pack']);
    assert.deepEqual(plan.packs, [{ id: 'ghost-pack', ok: false, known: false }]);
    assert.equal(plan.ok, false);
    assert.deepEqual(missingPackIds(plan), ['ghost-pack']);
  });

  test('字节被改坏：文件都在也不算就绪（包哈希复算对不上）', async () => {
    const store = createStore(createMemoryBackend());
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    for (const f of alpha.files) await store.write(modKey('alpha-pack', f.path), new TextEncoder().encode('wrong'));
    const plan = await planAlignment({ catalog, mods: roomSet, store });
    assert.equal(plan.missingFiles, 0, '存在性上什么都不缺');
    assert.equal(plan.ok, false, '但哈希对不上 ⇒ 未就绪');
    assert.deepEqual(plan.packs, [{ id: 'alpha-pack', ok: false, known: true }]);
  });
});

describe('补齐（alignRoom）：只下这个房间的那几个包，下完就变就绪', () => {
  test('声明 alpha 的房间只抓 alpha-pack 的文件，下完 plan.ok 为真且摘要一致', async () => {
    const store = createStore(createMemoryBackend());
    const seen = [];
    const doFetch = fixtureFetch(wsRoot, { onCall: (u) => seen.push(u) });
    const before = await planAlignment({ catalog, mods: roomSet, store });
    assert.equal(before.ok, false);
    const events = [];
    const after = await alignRoom({ catalog, mods: roomSet, store, fetch: doFetch, onProgress: (e) => events.push(e.type) });
    assert.equal(after.ok, true);
    assert.equal(after.held, roomSet.digest, '本地复算的集合摘要与房间声明的一致');
    assert.deepEqual(after.packs, [{ id: 'alpha-pack', ok: true, known: true }]);
    assert.equal(seen.every((u) => u.includes('/alpha-pack/')), true, `只该抓这个房间的包：${JSON.stringify(seen)}`);
    assert.equal(seen.some((u) => u.includes('beta-pack')), false, '服务器上另外那个包一个字节都不抓');
    assert.ok(events.includes('done'), `进度事件要发出来：${events.join(',')}`);
    assert.equal(events.filter((t) => t === 'file-done').length, catalog.packs.find((p) => p.id === 'alpha-pack').files.length);
  });

  test('已经就绪时再点一次：一个请求都不发（不是「每次都重下」）', async () => {
    const store = createStore(createMemoryBackend());
    await alignRoom({ catalog, mods: roomSet, store, fetch: fixtureFetch(wsRoot) });
    let calls = 0;
    const after = await alignRoom({ catalog, mods: roomSet, store, fetch: fixtureFetch(wsRoot, { onCall: () => { calls += 1; } }) });
    assert.equal(after.ok, true);
    assert.equal(calls, 0);
  });

  test('房间一个包都没声明：alignRoom 直接回答「不需要」，不发请求', async () => {
    const store = createStore(createMemoryBackend());
    let calls = 0;
    const plan = await alignRoom({ catalog, mods: null, store, fetch: fixtureFetch(wsRoot, { onCall: () => { calls += 1; } }) });
    assert.equal(plan.needed, false);
    assert.equal(calls, 0);
  });

  test('下载失败（服务器 404）：照实报未就绪，不假装拿到', async () => {
    const store = createStore(createMemoryBackend());
    const doFetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const plan = await alignRoom({ catalog, mods: roomSet, store, fetch: doFetch, retries: 0 });
    assert.equal(plan.ok, false);
    assert.equal(plan.held, null);
  });
});

describe('目录与存储的接线', () => {
  test('loadCatalog 走服务器的 /mods/catalog.json，失败不缓存（下一次还会再试）', async () => {
    let calls = 0;
    let fail = true;
    const doFetch = async (url) => {
      calls += 1;
      assert.equal(url, '/mods/catalog.json');
      if (fail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ packs: [{ id: 'x' }] }) };
    };
    assert.equal(await loadCatalog({ fetch: doFetch }), null);
    assert.equal(await loadCatalog({ fetch: doFetch }), null, '失败的那次没有被记住');
    assert.equal(calls, 2);
    fail = false;
    const cat = await loadCatalog({ fetch: doFetch });
    assert.deepEqual(cat.packs, [{ id: 'x' }]);
    await loadCatalog({ fetch: doFetch });
    assert.equal(calls, 3, '成功的那次被缓存了');
  });

  test('storeFor() 在没有 OPFS / IndexedDB 的环境里给出内存后端，setStore 能换掉它', () => {
    assert.equal(storeFor().backend, 'memory');
    const mine = createStore(createMemoryBackend());
    setStore(mine);
    assert.equal(storeFor(), mine);
    setStore(null);
    assert.notEqual(storeFor(), mine);
  });
});

// ---------------------------------------------------------------------------------------------------
// 两处接线：房间界面的对齐门，与战斗模拟的数据面
// ---------------------------------------------------------------------------------------------------
describe('接线（源码级；界面本身没有 DOM 测试，这里钉的是两处「必须接上」的调用）', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  test('房间界面：面板用 planAlignment / alignRoom，准备就绪按钮带对齐门', () => {
    const src = read('public/js/screens/room.js');
    assert.match(src, /from '\.\.\/mods\/align\.js'/, '面板必须从 W-D 那个模块拿对齐逻辑');
    assert.match(src, /planAlignment\(/, '进房间时要问一次「本机有没有这个房间的包」');
    assert.match(src, /alignRoom\(/, '缺件要能补齐（进度由 sync 的事件驱动）');
    assert.ok(src.includes('<${RoomModsPanel} room=${room} onAlignment=${setAlign}'), '面板要把结论交回房间界面');
    assert.ok(src.includes('align && align.needed && !align.ok'), '未就绪时不给准备就绪这个按钮');
  });

  test('战斗模拟：浏览器那一份 runner 按 spec 选数据面，且按数据面缓存', () => {
    const src = read('public/js/battle/runner.js');
    assert.match(src, /import \{ roomDataBase \} from '\.\.\/mods\/align\.js'/, 'runner 必须用 W-D 那个判据');
    assert.match(src, /import \{ currentModSet \} from '\.\.\/roomMods\.js'/, '进程集合来自 welcome（roomMods）');
    assert.match(src, /createBattleRunner\(\{ net: appNet, store: appStore, dataBaseFor: dataBaseForBattle \}\)/, '浏览器那一份要接上它');
    assert.match(src, /const sims = new Map\(\)/, 'sim 按数据面缓存，不混用两个面');
  });
});
