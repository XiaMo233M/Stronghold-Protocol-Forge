// test/match/runnerDataBase.test.js — 这一局在哪个数据面上模拟（W-D, DESIGN §28.16）。
//
// W-B 让一个声明了集合的房间送**它自己那一份**游戏数据（`/room-data/<摘要>/<文件>.json`），所以客户端的战斗模拟也必须
// 按房间取数据：套用进程那一份会让「子集房间」在浏览器里跑出一个服务器不认的结果。这一条钉的就是那个开关：
//
//   * 没声明集合的房间 / 干净安装 ⇒ `/data/`（加载器与从前逐字节相同）；
//   * 声明了子集 ⇒ `/room-data/<房间摘要>/`；
//   * 同一个数据面只加载一次（换房间回到同一个面时不再抓一次），两个面各自缓存。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { roomDataBase } from '../../public/js/mods/align.js';
import { DATA } from './harness.js';

const DS = new DataSource(DATA, null);
const ROOM_SET = { digest: 'a'.repeat(64), packs: [{ id: 'alpha-pack', hash: 'b'.repeat(64), layer: 'A', combat: false }] };
const PROCESS_SET = { digest: 'c'.repeat(64), packs: [{ id: 'alpha-pack', hash: 'b'.repeat(64), layer: 'A', combat: false }, { id: 'beta-pack', hash: 'd'.repeat(64), layer: 'A', combat: false }] };
const ROOM_BASE = `/room-data/${ROOM_SET.digest}/`;

function fakeNet() {
  const handlers = new Map();
  return {
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of [...(handlers.get(t) || [])]) fn({ t, ...msg }); },
    send() { return true; },
    request() { return Promise.resolve({ t: 'ok' }); },
  };
}

/** A runner whose sim loader records the data face it was asked for (the browser one picks it from the spec). */
function rig() {
  const loaded = [];
  const net = fakeNet();
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} },
    now: () => 1000,
    raf: () => 0,
    caf: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    dataBaseFor: (spec) => roomDataBase(spec && spec.mods, PROCESS_SET),
    loadSim: async (base) => { loaded.push(base); return { spec: specMod, ds: DS }; },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  return { runner, net, store, loaded };
}

/** A b.start whose spec carries `mods` (the identity the server put on the wire). */
function start(battleId, mods) {
  const spec = specMod.buildBattleSpec({ battleId, fieldId: 'test', kind: 'normal', seed: 7, timeLimit: 5, players: [], spawns: [], routes: [], mods });
  return { t: 'b.start', battleId, kind: 'normal', speed: 2, elapsed: 0, authoritative: true, spec };
}

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((res) => setImmediate(res)); };

test('房间声明了子集 ⇒ 这一局从房间自己的数据面加载；进程集合 / 没有集合 ⇒ /data/', async () => {
  const r = rig();
  r.net.emit('b.start', start('b-room', ROOM_SET));
  await settle();
  assert.deepEqual(r.loaded, [ROOM_BASE], '声明了子集的房间必须在它自己的数据面上模拟');

  r.net.emit('b.start', start('b-process', PROCESS_SET));
  await settle();
  assert.deepEqual(r.loaded, [ROOM_BASE, '/data/'], '房间集合就是进程集合 ⇒ 还是那一份 /data/');

  r.net.emit('b.start', start('b-none', null));
  await settle();
  assert.deepEqual(r.loaded, [ROOM_BASE, '/data/'], 'spec 上没有 mods（干净安装 / 没声明集合）也走 /data/');
});

test('同一个数据面只加载一次；换回已经加载过的面不再抓一次', async () => {
  const r = rig();
  for (const [id, mods] of [['b1', ROOM_SET], ['b2', null], ['b3', ROOM_SET], ['b4', PROCESS_SET], ['b5', null]]) {
    r.net.emit('b.start', start(id, mods));
    await settle();
  }
  assert.deepEqual(r.loaded, [ROOM_BASE, '/data/'], '两个面各加载一次，之后都命中缓存');
  r.runner.dispose();
});
