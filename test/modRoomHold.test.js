// test/modRoomHold.test.js — DESIGN §28.57 的空席回收裁决：形状层两条判据 + 裁决聚合的语义。
// 判的东西很窄但很要紧：默认必须与从前逐字相同（没人申请就照旧销毁），申请了才有票，且时限被宿主夹住。
//
// 节号：本格吸收自下游 fork（在那里是 §28.55），我方按能力归一到 §28.57。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest } from '../shared/workshop.js';
import { createRoomHooks, holdDecision, releaseRoomHolds, clearRoomHolds, ROOM_HOLD_MAX_MS } from '../server/roomPack.js';

const T0 = 1_800_000_000_000;
const mk = (server) => normalizePackManifest({ id: 'p', name: 'p', content: ['chess'], server }, 'p');

describe('形状层：hold 是声明面，且要认 combat', () => {
  test('不声明 hold 的包，归一化结果逐字节不变', () => {
    const bare = mk({ room: { module: 'server/r.mjs' } });
    assert.equal(bare.ok, true, JSON.stringify(bare.detail));
    assert.deepEqual(bare.pack.server.room, { module: 'server/r.mjs' });
  });
  test('hold: true 要认 combat：缺它整条声明被拒', () => {
    const noCombat = mk({ room: { module: 'server/r.mjs', hold: true } });
    assert.equal(noCombat.ok, false);
    assert.equal(noCombat.error, 'ROOM_HOLD_NEEDS_COMBAT');
  });
  test('hold: true 合法且进清单（配 combat: true）', () => {
    const withCombat = normalizePackManifest({ id: 'p', name: 'p', content: ['chess'], combat: true, server: { room: { module: 'server/r.mjs', hold: true } } }, 'p');
    assert.equal(withCombat.ok, true, JSON.stringify(withCombat.detail));
    assert.deepEqual(withCombat.pack.server.room, { module: 'server/r.mjs', hold: true });
  });
  test('hold 只认布尔；未知字段照旧点名', () => {
    const bad = mk({ room: { module: 'server/r.mjs', hold: 'yes' } });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'ROOM_BAD_HOLD');
    const typo = mk({ room: { module: 'server/r.mjs', holt: true } });
    assert.equal(typo.ok, false);
    assert.equal(typo.error, 'ROOM_UNKNOWN_FIELD');
  });
});

describe('裁决聚合：OR + 夹时限 + 抛错只失这一票', () => {
  const room = () => ({
    code: 'HOLD1', disposed: false,
    seats: [], spectators: [],
    modSet: { packs: [{ id: 'a' }, { id: 'b' }] },
    hookSnapshot() { return { id: 'HOLD1' }; },
    activeHumans() { return []; },
  });

  beforeEach(() => clearRoomHolds());

  test('没人登记 ⇒ hold:false（默认路径与从前相同）', () => {
    const want = holdDecision(room(), { now: () => T0, log: null });
    assert.deepEqual({ hold: want.hold, until: want.until }, { hold: false, until: 0 });
  });

  test('两包都申请 ⇒ OR，时限取最早的，并夹到宿主上限内', () => {
    const r = room();
    const hooks = createRoomHooks({
      now: () => T0,
      installers: [
        { id: 'a', pack: 'a', hold: true, install: (roomObj) => { roomObj.canHold(() => ({ hold: true, until: T0 + 60_000 })); } },
        { id: 'b', pack: 'b', hold: true, install: (roomObj) => { roomObj.canHold(() => ({ hold: true, until: T0 + 10 * 60_000 })); } },
      ],
    });
    hooks.install(r);
    const want = holdDecision(r, { now: () => T0 });
    assert.equal(want.hold, true);
    assert.equal(want.until, T0 + 60_000, '最早到点的那一票赢');
    assert.deepEqual(want.packs, ['a', 'b']);
    const far = createRoomHooks({ now: () => T0, installers: [{ id: 'a', pack: 'a', hold: true, install: (ro) => { ro.canHold(() => ({ hold: true, until: T0 + 9 * 60 * 60_000 })); } }] });
    const r2 = room(); r2.code = 'HOLD2';
    far.install(r2);
    const clamped = holdDecision(r2, { now: () => T0 });
    assert.equal(clamped.until, T0 + ROOM_HOLD_MAX_MS, '包不许自己决定留多久');
  });

  test('没声明 hold 的包调 canHold ⇒ 点名拒，且拿不到票', () => {
    const r = room();
    let refused = null;
    const logs = { warn: (...a) => { refused = a.join(' '); }, info() {}, error() {} };
    const strict = createRoomHooks({ now: () => T0, log: logs, installers: [{ id: 'a', pack: 'a', install: (ro) => { ro.canHold(() => ({ hold: true })); } }] });
    strict.install(r);
    assert.match(String(refused), /ROOM_HOLD_UNDECLARED/);
    assert.equal(holdDecision(r, { now: () => T0 }).hold, false);
  });

  test('谓词抛异常 = 这一票作废并点名，别的包照算', () => {
    const r = room();
    const lines = [];
    const log = { warn: (...a) => lines.push(a.join(' ')), info() {}, error() {} };
    const hooks = createRoomHooks({
      now: () => T0,
      log,
      installers: [
        { id: 'a', pack: 'a', hold: true, install: (ro) => { ro.canHold(() => { throw new Error('boom'); }); } },
        { id: 'b', pack: 'b', hold: true, install: (ro) => { ro.canHold(() => ({ hold: true, until: T0 + 30_000 })); } },
      ],
    });
    hooks.install(r);
    const want = holdDecision(r, { now: () => T0, log });
    assert.equal(want.hold, true);
    assert.deepEqual(want.packs, ['b']);
    assert.match(lines.join(' '), /ROOM_HOOK_THREW[\s\S]*"a"/);
  });

  test('房间销毁后裁决表收回（房间码会被复用，不能留给下一个房间）', () => {
    const r = room();
    createRoomHooks({ now: () => T0, installers: [{ id: 'a', pack: 'a', hold: true, install: (ro) => { ro.canHold(() => ({ hold: true, until: T0 + 5_000 })); } }] }).install(r);
    assert.equal(holdDecision(r, { now: () => T0 }).hold, true);
    releaseRoomHolds('HOLD1');
    assert.equal(holdDecision(r, { now: () => T0 }).hold, false);
  });
});
