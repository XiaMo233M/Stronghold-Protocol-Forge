// test/modOfficialRoomBridge.test.js — 官方插件的房间钩子接上**既有**房间总线（Phase 7 第一项）。
//
// 这里用的是**真的** `createRoomHooks`（`server/roomPack.js` 不依赖 ws，本机就能跑），所以这不是「桥自己说自己对」，
// 而是「桥能不能被引擎那条总线吃下去」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { officialRoomInstallers } from '../server/mod-manager/officialHost.js';
import { createRoomHooks, ROOM_HOOK_EVENTS } from '../server/roomPack.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const room = { code: 'R1', seats: [], spectators: [], modIds: null };

const mod = (pack, room_ = []) => ({ pack, id: 'entry', hash: 'h', mounted: { room: room_ } });

test('桥产出的 installer 能被真总线装上，事件真的打到官方钩子', () => {
  const seen = [];
  const modules = [mod('alpha', [
    // 总线给钩子的**唯一**实参是冻结后的 payload（`fire` 的 `fn(data)`）
    { event: 'create', fn: (payload) => seen.push(['create', payload && payload.tag]) },
    { event: 'matchEnd', fn: () => seen.push(['matchEnd']) },
  ])];
  const hooks = createRoomHooks({ installers: officialRoomInstallers(modules), log: quiet });

  assert.deepEqual(hooks.install(room), [], 'install 不该失败');
  hooks.fire(room, 'create', { tag: 'R1' });
  hooks.fire(room, 'matchEnd', {});
  assert.deepEqual(seen, [['create', 'R1'], ['matchEnd']]);
});

test('没有官方房间钩子 ⇒ 空 installer 表（干净安装逐字节不变）', () => {
  assert.deepEqual(officialRoomInstallers([]), []);
  assert.deepEqual(officialRoomInstallers(null), []);
  assert.deepEqual(officialRoomInstallers([mod('x', [])]), [], '声明了 room 但一个钩子都没注册 ⇒ 不进表');
  const hooks = createRoomHooks({ installers: officialRoomInstallers([mod('x', [])]), log: quiet });
  hooks.install(room);
  hooks.fire(room, 'create', {}); // 不该炸，也不该有任何事发生
});

test('官方钩子抛异常：只记一行 ROOM_HOOK_THREW，**别的钩子照跑**（总线自带的隔离）', () => {
  const seen = [];
  const warnings = [];
  const log = { ...quiet, warn: (...a) => warnings.push(a.join(' ')) };
  const modules = [mod('alpha', [{ event: 'create', fn: () => { throw new Error('boom'); } }]), mod('beta', [{ event: 'create', fn: () => seen.push('beta') }])];
  const hooks = createRoomHooks({ installers: officialRoomInstallers(modules), log });
  hooks.install(room);
  hooks.fire(room, 'create', {});
  assert.deepEqual(seen, ['beta'], 'beta 照跑');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ROOM_HOOK_THREW/);
  assert.match(warnings[0], /"create"/);
});

test('事件名与 Forge 档同一张闭集；装了多个官方插件时按包 id 升序', () => {
  const order = [];
  const modules = [
    mod('zeta', [{ event: 'join', fn: () => order.push('zeta') }]),
    mod('alpha', [{ event: 'join', fn: () => order.push('alpha') }]),
  ];
  const hooks = createRoomHooks({ installers: officialRoomInstallers(modules), log: quiet });
  hooks.install(room);
  hooks.fire(room, 'join', {});
  assert.deepEqual(order, ['alpha', 'zeta'], '与 Forge 档同一条「包 id 升序」的触发顺序');
  assert.ok(ROOM_HOOK_EVENTS.includes('join'));
});

test('桥产出的条目形状就是 createRoomHooks 认的那种（id / pack / install）', () => {
  const [entry] = officialRoomInstallers([mod('alpha', [{ event: 'create', fn: () => {} }])]);
  assert.equal(entry.id, 'alpha');
  assert.equal(entry.pack, 'alpha');
  assert.equal(typeof entry.install, 'function');
  assert.equal(entry.hold, undefined, '官方档还没有 hold 那一格');
});
