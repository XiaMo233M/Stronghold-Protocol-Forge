// test/modClientBattleReads.test.js — C 层注入面的**战斗伤害读数**：`ctx.battle.damage()`（DESIGN §28.38）。
//
// 为什么单开一个文件：这一格不是「又一个面板字段」，它的全部价值是四条性质，而四条都要能被证伪：
//
//   1. **数字是真的** —— 读出来的逐单位 / 逐人伤害，必须与模拟自己那本账（`u.stats.dmg`、`battle._pp(pid).damageDealt`
//      / `bossDamage` / `healingDone` / `killed`）逐个相同。抄错一个单位、少算一个人、把 `uid` 串位，当场红。
//   2. **返回快照，不返回内部对象** —— 每次调用一份新的、冻结到第二层的副本；改了不影响引擎，引擎之后的新伤害
//      也不回溯进**已经发出去**的那一份。
//   3. **拿不到就是 `null`** —— 不抛、不编造（本项目铁律：面板可以画错、但不能算错），并且「门面没接上」「`damage()`
//      自己炸」「返回值不成形」三种原因**各记一行**，而「这一场没有战斗」是正常状态、**不记**。
//   4. **不新增协议消息** —— 把真 `Net` 的每一个出口（`send` / `request` / `sendResourceMessage` / `_sendRaw`）
//      都套上计数器，读这一格，然后要求**一次调用都发生不了**（`test/modClientNetReads.test.js` 的同一套判据）。
//
// 外加两条**结构性**断言，防止后来的人用「更省事」的方式把它做坏：
//   * `public/js/battle/runner.js` 对 `net` 仍然只有 `on` / `request` / `send` 三件事（伤害绝不进 `net`）；
//   * 面板那份 `ctx.net` 门面的键集**一个都没多**（这一格是 `ctx.battle`，不是挂在 `net` 上）。
//
// Run: node --test test/modClientBattleReads.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBattleRunner } from '../public/js/battle/runner.js';
import { createStore, initialState } from '../public/js/store.js';
import { createPanelRegistry } from '../public/js/ui/extensions.js';
import { Net } from '../public/js/net.js';
import { S2C, C2S, validateC2S } from '../shared/protocol.js';
import * as specMod from '../server/sim/spec.js';
import { DataSource } from '../server/sim/simdata.js';
import { PHASE } from '../shared/constants.js';
import { DATA, makeMatch } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DS = new DataSource(DATA, null);

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** 收集日志行的注册点 `log`（`noteBattleGap` 走的就是它，不走进面板自己的 `ctx.log`）。 */
function logSink() {
  const lines = [];
  return { lines, info() {}, debug() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
}

/** 一个**真** battle runner，接假 socket、手动时钟、手动帧 —— `test/match/runner.test.js` 的同一套最小面。 */
function rig() {
  let t = 1000;
  const frames = [];
  const net = {
    sent: [],
    handlers: new Map(),
    on(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); return () => this.handlers.get(type).delete(fn); },
    emit(type, msg) { for (const fn of [...(this.handlers.get(type) || [])]) fn({ t: type, ...msg }); },
    send(type, fields) { const msg = { ...fields, t: type }; assert.equal(validateC2S(msg), null, `invalid ${type}`); net.sent.push(msg); return true; },
    request(type, fields) { const msg = { ...fields, t: type, rid: 1 }; assert.equal(validateC2S(msg), null, `invalid ${type}`); net.sent.push(msg); return Promise.resolve({ t: 'ok' }); },
    sendResourceMessage() { return true; },
    _sendRaw() { return true; },
  };
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} },
    now: () => t,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    loadSim: async () => ({ spec: specMod, ds: DS }),
    logger: quiet,
  });
  return {
    runner, net, store,
    advance(ms, step = 1000 / 60) {
      const end = t + ms;
      while (t < end) { t = Math.min(end, t + step); for (const fn of frames.splice(0)) fn(t); }
    },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); for (const fn of frames.splice(0)) fn(t); } },
  };
}

/** 一场真战斗的 `b.start`（客户端跑战斗、有真棋盘）：`runner.test.js` 的 `realStart()` 同一套。 */
function realStart(seed = 7301) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  h.m.start();
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 1);
  h.run(() => h.m.phase === PHASE.COMBAT && h.m.round === 2, { maxSteps: 3e6 });
  const msg = h.lastTo('p_0', 'b.start');
  h.m.dispose();
  return msg;
}

function mkEl(tag) {
  return {
    tag, className: '', attributes: {}, children: [], style: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}

/** 一个有 `get` / `subscribe` / `patch` 的最小 store（够 `createPanelRegistry` 用）。 */
function makeStore() { return createStore({ ...initialState }); }

/** 造一个注册点，`apply()` 一个面板，把它的 `ctx` 与门面还给你（`modClientNetReads.test.js` 同一套）。 */
async function ctxOf(deps = {}) {
  const seen = [];
  const notes = deps.notes || logSink();
  const registry = createPanelRegistry({
    store: makeStore(),
    importModule: async () => ({ mount: (ctx) => { seen.push(ctx); } }),
    slotHost: () => mkEl('div'), createElement: mkEl,
    env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
    ...deps,
    // `deps.log` 可以被调用方覆盖；默认走收集日志的那个 sink（`noteBattleGap` 的行要能被断言）
    log: notes,
  });
  registry.apply([{ id: 'p1', pack: 'alpha', slot: 'root.overlays', url: '/workshop-panels/alpha/p1.js?v=0123456789ab', order: 0, gate: null, requires: [] }]);
  await settle();
  assert.equal(seen.length, 1, '面板挂上了');
  return { registry, ctx: seen[0], notes };
}

const battleLines = (notes) => notes.lines.filter((l) => l.includes('CLIENT_BATTLE_UNAVAILABLE'));

// ---------------------------------------------------------------------------------------------------------------
describe('§28.38 面板注入面：ctx.battle.damage()', () => {
  test('门面是冻结的、只有 damage 一个成员；net 门面的键集一个都没多', async () => {
    const { ctx } = await ctxOf({ battle: { damage: () => null } });
    assert.ok(Object.isFrozen(ctx.battle), 'ctx.battle 本身冻结');
    assert.deepEqual(Object.keys(ctx.battle), ['damage'], '这一格只有 damage（不多不少）');
    assert.equal(typeof ctx.battle.damage, 'function');
    // 边界：没有 runner 句柄、没有 Battle、没有 stats()/on() 那种运行时可写面
    for (const k of ['runner', 'battle', 'stats', 'step', 'on', 'entries', '_entries']) {
      assert.equal(ctx.battle[k], undefined, `门面上没有 ${k}`);
    }
    // 这一格没有挂在 net 上：net 门面照旧六个键（§28.24 / §28.25 / §28.32）
    assert.deepEqual(Object.keys(ctx.net).sort(), ['on', 'send', 'sendResourceMessage', 'status', 'transport', 'welcome']);
    assert.equal(ctx.net.damage, undefined, 'ctx.net.damage 不存在（模拟事实不挂在 net 上）');
  });

  test('读出来的数字与模拟自己那本账逐个相同（逐单位 / 逐人 / uid 映射 / 取整）', async () => {
    const r = rig();
    const start = realStart();
    r.net.emit('b.start', start);
    await r.settle();
    const e = r.runner._entries.get(start.battleId);
    assert.ok(e && e.battle, '战斗建起来了');
    r.advance(4000);                                     // 跑 4 秒真时间：够打出一批伤害
    const b = e.battle;
    const dmgOf = (u) => Math.round(Number(u.stats.dmg) || 0);
    const total = b.allyUnits.reduce((s, u) => s + dmgOf(u), 0);
    assert.ok(total > 0, `这一场真的打出了伤害（累计 ${total}）`);

    const { ctx, notes } = await ctxOf({ battle: r.runner });
    const d = ctx.battle.damage();
    assert.ok(d, '有正在跑的战斗 ⇒ 有读数');
    assert.equal(d.battleId, start.battleId);
    assert.equal(d.fieldId, e.fieldId);
    assert.equal(d.kind, e.kind);
    assert.equal(d.authoritative, true);
    assert.equal(d.own, true);
    assert.equal(d.t0, 0, 't0 恒为 0（一局一场）');
    assert.equal(d.gt, Number(b.time), 'gt 就是战斗内秒（Battle.time）');

    // 逐单位：个数、顺序、每一格、以及**取整**口径
    assert.equal(d.units.length, b.allyUnits.length, '每个己方单位一行，不多不少');
    d.units.forEach((row, i) => {
      const u = b.allyUnits[i];
      const where = `units[${i}] (${u.defId})`;
      assert.equal(row.id, u.id, `${where}: id`);
      assert.equal(row.uid, u.uid, `${where}: uid 与棋盘的 uid 同一个号`);
      assert.equal(row.defId, u.defId, `${where}: defId`);
      assert.equal(row.ownerId, u.ownerId, `${where}: ownerId`);
      assert.equal(row.kind, u.kind, `${where}: kind`);
      assert.equal(row.dmg, dmgOf(u), `${where}: dmg 与 u.stats.dmg 取整后相同`);
      assert.equal(row.kills, Math.trunc(Number(u.stats.kills) || 0), `${where}: kills`);
      assert.equal(row.heal, Math.round(Number(u.stats.heal) || 0), `${where}: heal`);
      assert.ok(Number.isInteger(row.dmg), `${where}: dmg 是整数（对齐结果页 compactResult）`);
    });
    assert.equal(d.units.reduce((s, row) => s + row.dmg, 0), total, '逐单位那几行加起来就是总伤害');

    // 逐人：**必须**照 `Battle._buildResult()` 的口径（`battle._perPlayer[playerId]`），不是座位对象那一个
    // （`getPlayer(pid).damageDealt` 永远是 undefined —— 这一条就是为了钉住这个坑）
    assert.ok(d.players.length >= 1, '至少自己这一行');
    for (const row of d.players) {
      const pp = b._pp(row.playerId);
      assert.ok(pp, `players[] 里的 ${row.playerId} 是这一场真有的玩家`);
      assert.equal(row.dmg, Math.round(Number(pp.damageDealt) || 0), `${row.playerId}: dmg = _perPlayer 那本账的 damageDealt`);
      assert.equal(row.bossDmg, Math.round(Number(pp.bossDamage) || 0), `${row.playerId}: bossDmg`);
      assert.equal(row.kills, Math.trunc(Number(pp.killed) || 0), `${row.playerId}: kills`);
      assert.equal(row.heal, Math.round(Number(pp.healingDone) || 0), `${row.playerId}: heal`);
      assert.ok(row.dmg > 0, `${row.playerId}: 这一场真打出了伤害（0 就说明配错了对象）`);
    }
    assert.deepEqual(d.players.map((p) => p.playerId), b.players.map((p) => p.playerId), '逐人那几行的次序与这一场的玩家次序一致');
    assert.deepEqual(battleLines(notes), [], '正常读到读数，一行日志都不记');
  });

  test('只读：每次一份新的、冻结到第二层的副本；引擎变 / 面板改两个方向都污染不了', async () => {
    const r = rig();
    const start = realStart();
    r.net.emit('b.start', start);
    await r.settle();
    const e = r.runner._entries.get(start.battleId);
    r.advance(4000);
    const { ctx } = await ctxOf({ battle: r.runner });

    const first = ctx.battle.damage();
    const frozen = JSON.stringify(first);
    assert.ok(Object.isFrozen(first), '外层冻结');
    assert.ok(Object.isFrozen(first.units), 'units 数组冻结');
    assert.ok(Object.isFrozen(first.players), 'players 数组冻结');
    if (first.units.length) assert.ok(Object.isFrozen(first.units[0]), '嵌套的单位行也冻结');
    assert.ok(Object.isFrozen(first.players[0]), '嵌套的玩家行也冻结');

    // ① 面板改：当场 TypeError，引擎侧不受影响
    assert.throws(() => { first.gt = 1; }, TypeError);
    if (first.units.length) {
      assert.throws(() => { first.units[0].dmg = 1; }, TypeError);
      assert.throws(() => { first.units[0].defId = 'x'; }, TypeError);
    }
    assert.throws(() => { first.players[0].dmg = 1; }, TypeError);

    // ② 引擎变（继续打）：已经发出去的那一份一个字都不许变
    r.advance(4000);
    assert.equal(JSON.stringify(first), frozen, '新伤害不回溯改写旧快照');
    const engineTotal = e.battle.allyUnits.reduce((s, u) => s + Math.round(Number(u.stats.dmg) || 0), 0);
    if (engineTotal > first.units.reduce((s, row) => s + row.dmg, 0)) {
      assert.ok(first.units.reduce((s, row) => s + row.dmg, 0) < engineTotal, '旧快照还是旧数字');
    }

    // ③ 下一次读是新的一份（对象身份不同），内容跟着引擎走
    const second = ctx.battle.damage();
    assert.notEqual(second, first, '每次调用一份新的副本');
    assert.equal(second.gt, Number(e.battle.time));
    assert.equal(second.units.length, e.battle.allyUnits.length);
  });

  test('拿不到：没注入 / damage() 抛 / 返回值不成形 ⇒ null + 每种原因只记一行；没有战斗 ⇒ null 且不记', async () => {
    // ① 没注入 battle（Node 用例、极小的宿主）
    const a = await ctxOf({});
    for (let i = 0; i < 5; i++) assert.equal(a.ctx.battle.damage(), null, '没注入 ⇒ null（不抛、不编造）');
    assert.equal(battleLines(a.notes).length, 1, '每种原因只记一行');
    assert.match(battleLines(a.notes)[0], /CLIENT_BATTLE_UNAVAILABLE \(absent\)/);
    assert.match(battleLines(a.notes)[0], /no battle runtime is injected/);

    // ② damage() 自己炸
    const b = await ctxOf({ battle: { damage: () => { throw new Error('boom'); } } });
    assert.equal(b.ctx.battle.damage(), null);
    assert.equal(battleLines(b.notes).length, 1);
    assert.match(battleLines(b.notes)[0], /CLIENT_BATTLE_UNAVAILABLE \(threw\)/);
    assert.match(battleLines(b.notes)[0], /boom/, '记的原因是可读的');

    // ②b damage() 不是函数
    const b2 = await ctxOf({ battle: { damage: null } });
    assert.equal(b2.ctx.battle.damage(), null);
    assert.equal(battleLines(b2.notes).length, 1);
    assert.match(battleLines(b2.notes)[0], /\(absent\)/);

    // ③ 返回值不成形：数组 / 字符串 / 数字
    for (const [note, bad] of [['数组', []], ['字符串', 'dmg'], ['数字', 7]]) {
      const c = await ctxOf({ battle: { damage: () => bad } });
      assert.equal(c.ctx.battle.damage(), null, `返回${note} ⇒ null`);
      assert.equal(battleLines(c.notes).length, 1, `${note}：一行`);
      assert.match(battleLines(c.notes)[0], /\(bad-shape\)/);
    }

    // ④ 引擎说「这一场没有战斗」（null / undefined）：正常状态 ⇒ null 且**不记日志**
    for (const [note, empty] of [['null', null], ['undefined', undefined]]) {
      const d = await ctxOf({ battle: { damage: () => empty } });
      for (let i = 0; i < 5; i++) assert.equal(d.ctx.battle.damage(), null, `${note} ⇒ null`);
      assert.deepEqual(battleLines(d.notes), [], `${note}：没有正在跑的战斗不是缺件，不刷日志`);
    }

    // ⑤ 不成形的行被丢掉，成形的照旧（不整格作废：外层形状对了就照给）
    const e2 = await ctxOf({
      battle: {
        damage: () => ({
          battleId: 'b1', fieldId: 'f1', kind: 'normal', authoritative: true, own: false, gt: 12, t0: 0,
          units: [null, { id: 1, uid: 2, defId: 'chess_a', ownerId: 'p1', kind: 'op', dmg: 10.6, kills: 2, heal: 0 }, 'x'],
          players: [{ playerId: 'p1', dmg: 1, bossDmg: 2, kills: 3, heal: 4 }, { playerId: 9 }, null],
        }),
      },
    });
    const got = e2.ctx.battle.damage();
    assert.deepEqual(got.units.map((u) => u.uid), [2], '不成形的行被丢掉');
    assert.equal(got.units[0].dmg, 10.6, '数字原样（门面只做形状复判与冻结，不替引擎取整）');
    assert.deepEqual(got.players.map((p) => p.playerId), ['p1'], 'playerId 不是字符串的行丢掉');
    assert.equal(got.gt, 12);
    assert.deepEqual(battleLines(e2.notes), [], '形状对了就不记日志');
  });

  test('这一格不新增协议消息：真 Net 的四个出口一次都不被调用', async () => {
    class FakeWS {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
      send(s) { this.sent.push(JSON.parse(s)); }
      close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    }
    const noTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
    const net = new Net({ url: 'ws://test/ws', WebSocket: FakeWS, getToken: () => null, now: () => 1_000_000, timers: noTimers });
    net.connect();
    net.ws.readyState = 1;
    net.ws.onopen?.();

    const r = rig();
    const start = realStart();
    r.net.emit('b.start', start);
    await r.settle();
    r.advance(3000);

    const { ctx } = await ctxOf({ net, battle: r.runner });
    const calls = { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 };
    for (const name of Object.keys(calls)) {
      const orig = net[name].bind(net);
      net[name] = (...a) => { calls[name] += 1; return orig(...a); };
    }
    const bytes = net.ws.sent.length;
    const before = r.net.sent.length;
    let reads = 0;
    for (let i = 0; i < 5; i++) { const d = ctx.battle.damage(); if (d) reads++; ctx.net.status(); ctx.net.welcome(); }
    assert.equal(reads, 5, '这一格真的读到了东西（不是「什么都没发生」的假通过）');
    assert.deepEqual(calls, { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 }, '读面是纯读者：一个出口都没碰');
    assert.equal(net.ws.sent.length, bytes, 'socket 上一个字节都没多写');
    assert.equal(r.net.sent.length, before, '战斗侧也没有多发一帧');
    assert.equal(S2C.includes('damage'), false, '`damage` 不是 S2C 消息类型');
    assert.equal('damage' in C2S, false, '也不是 C2S');
  });

  test('结构判据：runner 对 net 仍然只有 on/request/send，且不把伤害元组塞进 net', () => {
    const src = readFileSync(join(ROOT, 'public/js/battle/runner.js'), 'utf8');
    const netUses = [...src.matchAll(/net\.([A-Za-z_]+)\(/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(netUses)].sort(), ['on', 'request', 'send'], `runner 只对 net 做这三件事（实际：${[...new Set(netUses)].join(', ')}）`);
    assert.equal(/\bnet\.emit\(/.test(src), false, 'runner 不把帧塞进 net 的事件口');
    assert.equal(/net\._emit\(/.test(src), false, '也没有 net._emit');
    // 这一格也不许在战斗循环里攒自己的账：它读的就是模拟已经算好的数字
    const body = src.slice(src.indexOf('    damage() {'), src.indexOf('    unitIdOf('));
    assert.ok(body.length > 0, '找得到 damage() 的实现');
    assert.match(body, /u\.stats\.dmg|s\.dmg/, '读的是模拟那本账（u.stats.dmg）');
    assert.equal(/\.step\(\)/.test(body), false, 'damage() 不推战斗');
    assert.equal(/drainEvents/.test(body), false, 'damage() 不动事件队列');
    assert.equal(/emit\(/.test(body), false, 'damage() 不发任何事件');
  });

  test('模拟侧零副作用：面板活着并消费这一格，战斗自己的结果摘要逐字节不变、不变量照旧', async () => {
    // 一场**真跑**的客户端战斗（真的打出伤害），全程有一个面板读这一格 —— 与 `modClientSettings.test.js`
    // 的「同 seed 逐字节相同」同一条判据，只是这里那一格换成了 `ctx.battle.damage()`。
    const r = rig();
    const start = realStart();
    r.net.emit('b.start', start);
    await r.settle();
    const e = r.runner._entries.get(start.battleId);
    const { ctx } = await ctxOf({ battle: r.runner });

    const board = { reads: 0, dps: {}, total: 0, boss: 0, units: 0 };
    r.advance(3000);
    for (let i = 0; i < 3; i++) {
      r.advance(1000);
      const d = ctx.battle.damage();
      if (!d) continue;
      board.reads++;
      board.units = Math.max(board.units, d.units.length);
      for (const row of d.units) board.dps[row.uid] = row.dmg / Math.max(1e-9, d.gt - d.t0);
      board.total = d.players.reduce((s, p) => s + p.dmg, 0);
      board.boss = d.players.reduce((s, p) => s + p.bossDmg, 0);
    }

    // ① 纯读者：同一时刻连读两次，那本账一个字节都不许变（读面自己不产生任何状态）
    const first = ctx.battle.damage();
    const second = ctx.battle.damage();
    assert.deepEqual(second, first, '连读两次，数字完全相同（读面不改战斗）');
    assert.notEqual(second, first, '但两份是两个对象（每次读一份新的）');

    // ② 面板真的在工作（不是「什么都没发生」的假通过）
    assert.ok(board.reads > 0, '面板真的读了这一格');
    assert.ok(board.total > 0, `面板算出的总伤非零（${board.total}）`);
    assert.ok(Object.keys(board.dps).length > 0, '面板算出了逐单位 DPS');
    assert.ok(board.units > 0, '逐单位那几行非空');

    // ③ 打完整场：战斗自己的不变量与结算账照旧
    r.advance(200000);
    assert.equal(e.battle.finished, true, '这一场打完了');
    assert.equal(e.resultSent, true, '权威战斗照常上报（这一格没有拦下任何一帧）');
    assert.deepEqual(r.runner.stats().errors, 0, '没有一步出错');
    const res = e.result;
    assert.ok(res && res.perPlayer, '结果里那份每人账还在');
    const fin = ctx.battle.damage();
    for (const p of fin.players) {
      assert.equal(p.dmg, Math.round(Number(e.battle._pp(p.playerId).damageDealt) || 0), `${p.playerId}: 终局读数与模拟那本账仍然相同`);
    }
    // 板上的数字与这一场的结算账一致（同一本账、同一取整口径）
    const b1 = e.battle;
    assert.equal(fin.players.reduce((s, p) => s + p.dmg, 0),
      b1.players.reduce((s, ps) => s + Math.round(Number(b1._pp(ps.playerId).damageDealt) || 0), 0),
      '面板算出的总伤 == 模拟自己那本账取整后相加');
    assert.equal(fin.units.reduce((s, u) => s + u.dmg, 0),
      b1.allyUnits.reduce((s, u) => s + Math.round(Number(u.stats.dmg) || 0), 0),
      '逐单位那几行加起来 == 场上单位的累计伤害');
    // 帧流没有被这一格改动：每个 b.result 都是合法协议帧（fakeNet 的 send 自己断言过）
    assert.ok(r.net.sent.some((m) => m.t === 'b.result'), '上报的还是那条 b.result');
  });
});
