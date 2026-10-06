// test/support.test.js — 助战 (support operators, remake extension; shared/support.js, docs/WORKSHOP.md).
//
// The feature in one sentence: every player may bring n supports of a tier, and the pool of what qualifies is declared
// and enforced by the SERVER (data/support.json) — an operator the pool does not list is DISABLED, so a request naming
// it is rejected outright (there is deliberately no fallback: falling back would grant a disabled operator).
//
// Covered here: the pure config/selection logic (incl. every "fails closed" path), the GameData view, the selection's
// journey session → seat → PlayerState → a granted piece in the 整備区 at round 1 (with the shared pool's accounting
// invariant intact), the re-check that makes a stale selection harmless, and the lobby message over a real WebSocket
// (a client cannot smuggle an operator past the pool).
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeSupportConfig, checkSupport, isSupportChess, supportTierOf, supportPicker,
  supportSlotsFor, supportCapacity, supportTiers, isSupportEntries, SUPPORT_LIMITS, supportPriceOf, supportPrices,
} from '../shared/support.js';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, PHASE } from '../shared/constants.js';
import { makeMatch, chessOfTier } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const RAW_SUPPORT = JSON.parse(readFileSync(join(ROOT, 'data/support.json'), 'utf8'));
const CFG = normalizeSupportConfig(RAW_SUPPORT);
const getChess = (id) => DATA.chess[id] || null;

// Ids derived from the shipped config, so the suite follows data/support.json instead of hard-coding it.
const TIER5 = supportTiers(CFG).includes(5) ? CFG.pool[5] : [];
const TIER6 = supportTiers(CFG).includes(6) ? CFG.pool[6] : [];
const S5 = TIER5[0];
const S5B = TIER5[1];
const S6 = TIER6[0];
const SLOTS5 = supportSlotsFor(CFG, 5);
const SLOTS6 = supportSlotsFor(CFG, 6);
/** A visible, shop-eligible operator of `tier` that the pool does NOT list (the "disabled" case). */
const outsidePool = (tier) => chessOfTier(tier).find((id) => !CFG.pool[tier].includes(id));

/** Assert a request succeeded / failed with `code`, mirroring test/lobby-loadout.test.js. */
const okReq = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const errReq = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', JSON.stringify(r));
  assert.equal(r.code, code, JSON.stringify(r));
  return r;
};

describe('助战: configuration (shared/support.js)', () => {
  test('the shipped data/support.json is a usable, frozen config', () => {
    assert.equal(CFG.enabled, true);
    assert.deepEqual(supportTiers(CFG), [5, 6]);
    assert.equal(supportCapacity(CFG), SLOTS5 + SLOTS6);
    assert.equal(Object.isFrozen(CFG), true);
    assert.equal(Object.isFrozen(CFG.slots), true);
    assert.equal(Object.isFrozen(CFG.pool), true);
    assert.ok(SLOTS5 >= 1 && SLOTS6 >= 1, 'the default config offers both tiers');
    assert.equal(supportSlotsFor(CFG, 3), 0, 'a tier with no entry is off');
  });

  test('every unusable config shape fails CLOSED (disabled, never a permissive default)', () => {
    const off = [
      undefined, null, 'nope', [],
      { enabled: false, slots: { 5: 1 }, pool: { 5: ['x'] } },
      { enabled: true, slots: { 5: 2 }, pool: { 5: [] } },          // empty pool
      { enabled: true, slots: { 5: 0 }, pool: { 5: ['x'] } },        // zero slots
      { enabled: true, slots: 'x', pool: 5 },                        // junk types
      { slots: { 5: 1 }, pool: { 5: ['x'] } },                        // enabled flag absent
    ];
    for (const raw of off) {
      const cfg = normalizeSupportConfig(raw);
      assert.equal(cfg.enabled, false, `expected disabled for ${JSON.stringify(raw)}`);
      // still refuses anything non-empty, and still accepts "no support"
      assert.equal(checkSupport(['chess_char_5_01_a'], cfg, getChess).error, 'BAD_TARGET');
      assert.equal(checkSupport([], cfg, getChess).ok, true);
    }
  });

  test('the pool lists ids under their own tier: a mis-filed id is disabled, not promoted', () => {
    const misfiled = normalizeSupportConfig({ enabled: true, slots: { 5: 1 }, pool: { 5: [S6] } });
    assert.equal(isSupportChess(misfiled, S6, getChess), false);
    assert.equal(checkSupport([S6], misfiled, getChess).error, 'BAD_TARGET');
    assert.equal(supportTierOf(misfiled, S6, getChess), null);
  });

  test('structural check: array of distinct wire-safe ids within the cap', () => {
    assert.equal(isSupportEntries([]), true);
    assert.equal(isSupportEntries('x'), false);
    assert.equal(isSupportEntries([S5, S5]), false);
    assert.equal(isSupportEntries([`${S5} `]), false);
    assert.equal(isSupportEntries(Array.from({ length: SUPPORT_LIMITS.entries + 1 }, (_, i) => `id${i}`)), false);
  });

  test('slots are enforced per tier, independently', () => {
    assert.equal(checkSupport(TIER5.slice(0, SLOTS5), CFG, getChess).ok, true);
    if (TIER5.length > SLOTS5) {
      assert.equal(checkSupport(TIER5.slice(0, SLOTS5 + 1), CFG, getChess).error, 'BAD_TARGET');
    }
    if (TIER6.length > SLOTS6) {
      assert.equal(checkSupport(TIER6.slice(0, SLOTS6 + 1), CFG, getChess).error, 'BAD_TARGET');
    }
    const mixed = [...TIER5.slice(0, SLOTS5), ...TIER6.slice(0, SLOTS6)];
    const r = checkSupport(mixed, CFG, getChess);
    assert.equal(r.ok, true);
    assert.equal(r.byTier[5].length, SLOTS5);
    assert.equal(r.byTier[6].length, SLOTS6);
  });

  test('an operator outside the pool, an unknown id and an elite id are all refused', () => {
    const out = outsidePool(5);
    assert.ok(out, 'the shipped pool must not contain every operator (otherwise "disabled" is untested)');
    const r = checkSupport([out], CFG, getChess);
    assert.equal(r.error, 'BAD_TARGET');
    assert.match(r.detail, /not in the server pool/);
    assert.equal(checkSupport(['chess_char_9_99_a'], CFG, getChess).error, 'BAD_TARGET');
    assert.equal(isSupportChess(CFG, DATA.chess[S5].goldenId, getChess), false, 'an elite is never a support');
    assert.equal(checkSupport([DATA.chess[S5].goldenId], CFG, getChess).error, 'BAD_TARGET');
  });

  test('the picker is the only list a client may show, and it is deterministic', () => {
    const p = supportPicker(CFG);
    assert.deepEqual(p.map((x) => x.tier), [5, 6]);
    assert.equal(p[0].slots, SLOTS5);
    assert.deepEqual(p[0].ids, [...CFG.pool[5]]);
    assert.deepEqual(p[0].prices, {}, '没有配 prices 时，每个干员都用它自己的阶级价');
    assert.deepEqual(supportPicker(normalizeSupportConfig(undefined)), []);
  });

  // 「助战干员的商店售价能否修改」：能，写 data/support.json 的 prices 即可；没写的仍然是阶级价。
  test('prices 只接受卡池里真有的 id，且只接受 0–99 的整数', () => {
    const cfg = normalizeSupportConfig({
      enabled: true, slots: { 5: 1 }, pool: { 5: [S5] },
      prices: { [S5]: 1, chess_not_in_pool: 3, [S6]: -1, some_other: 2.5, chess_char_5_02_a: 200 },
    });
    assert.deepEqual(supportPrices(cfg), { [S5]: 1 }, '卡池外的 id、负数、小数、超上限一律丢掉');
    assert.equal(supportPriceOf(cfg, S5), 1);
    assert.equal(supportPriceOf(cfg, S6), null, '没配 = null（调用方用阶级价）');
    assert.equal(supportPriceOf(normalizeSupportConfig(undefined), S5), null);
    assert.deepEqual(supportPicker(cfg)[0].prices, { [S5]: 1 });
    assert.equal(new GameData({ ...DATA, support: { enabled: true, slots: { 5: 1 }, pool: { 5: [S5] }, prices: { [S5]: 1 } } }, 'mode_multi_hard').supportPrice(S5), 1);
  });

  test('prices 为 0 是合法的（0 金买一个助战），不是「没配」', () => {
    const cfg = normalizeSupportConfig({ enabled: true, slots: { 5: 1 }, pool: { 5: [S5] }, prices: { [S5]: 0 } });
    assert.equal(supportPriceOf(cfg, S5), 0);
  });
});

describe('助战: the GameData view', () => {
  const gd = new GameData(DATA, 'mode_multi_hard');

  test('exposes the pool, the slots and the picker', () => {
    assert.equal(gd.supportEnabled(), true);
    assert.equal(gd.supportCapacity(), SLOTS5 + SLOTS6);
    assert.deepEqual(gd.supportPicker().map((x) => x.tier), [5, 6]);
    assert.equal(gd.isSupportChess(S5), true);
    assert.equal(gd.supportTierOf(S5), 5);
  });

  test('a data set without support.json is disabled', () => {
    const bare = new GameData({ chess: DATA.chess, config: DATA.config }, 'mode_multi_hard');
    assert.equal(bare.supportEnabled(), false);
    assert.equal(bare.checkSupport([S5]).error, 'BAD_TARGET');
    assert.deepEqual(bare.supportPicker(), []);
  });
});

// 助战的定义（业主 2026-10-07 定下）：「助战干员就应该加入商店，按阶级像普通棋子一样购买出售」。
// 所以这里断言的不再是「开局白送进整备区」，而是**商店通道**：带上的干员一定在这次对局的池子里（连本局随机禁用
// 也盖过去），可以像普通棋子一样摇到、按阶级价买到、按普通价卖掉。
describe('助战: 进商店，按阶级像普通棋子一样买与卖 (match engine)', () => {
  const seatsWith = (support) => [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, support }];
  const T5 = 5;
  const priceOfTier = (h, id) => h.m.gd.chessPrice(id);

  test('带上的助战进池并多一份拷贝，但**不白送**任何棋子', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 5, fake: true, seats: seatsWith([S5, S6]) });
    h.start();
    const ps = h.ps('p_0');
    assert.deepEqual([...ps.support], [S5, S6]);
    assert.deepEqual(h.m.supportSupply, [S5, S6].sort(), '对局的助战供给要能从 Match 上看出来');
    const base = h.m.gd.poolCopies(S5);
    assert.equal(h.m.pool.cap(S5), base + 1, '助战那份拷贝加在 cap 上（恒等式因此仍然成立）');
    assert.equal(h.m.pool.left(S5), base + 1);
    assert.equal(h.m.pool.isSupport(S5), true);
    assert.equal(h.m.pool.isSupport(h.m.gd.visibleChess.find((id) => id !== S5 && id !== S6)), false, '别人不带就不是助战供给');
    // 关键的一条：没有任何东西被送进手里 —— 想要就得在商店里买
    assert.equal(ps.hand.filter(Boolean).length, 0, 'nothing may be handed out');
    h.toPrep(1);
    assert.equal(ps.hand.filter(Boolean).length, 0, '休整期开始后手里依然是空的（旧版在这里白送两个）');
    assert.deepEqual(ps.supportGranted, [S5, S6], 'granted = 本局商店里真的买得到的那几个');
    h.invariants();
  });

  test('商店摇得到它，买它花的是阶级价，卖掉按普通棋子结算', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 5, fake: true, seats: seatsWith([S5]) });
    h.start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    ps.shop.level = T5;                       // 五阶干员只在店铺五级才摇得到（阶级门没有为助战破例）
    ps.funds = 100;
    let slot = -1;
    for (let i = 0; i < 400 && slot < 0; i++) {
      ps.rollShop();
      slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.id === S5);
    }
    assert.ok(slot >= 0, `商店摇了 400 次都没摇到带上的助战 ${S5}`);
    assert.equal(ps.shop.slots[slot].support, true, '助战摇出来的格子要标出来（客户端可以给它加个标）');
    assert.equal(ps.priceOf(ps.shop.slots[slot]), priceOfTier(h, S5), '没配 prices 时就是它的阶级价');
    const before = ps.funds;
    assert.deepEqual(h.m.handle('p_0', { t: 'g.buy', slot }), { ok: true });
    assert.equal(ps.funds, before - priceOfTier(h, S5));
    const piece = ps.hand.filter(Boolean).find((p) => p.id === S5);
    assert.ok(piece, '买到的就是普通棋子');
    assert.equal(piece.poolCopies, 1);
    // 卖掉：回到普通规则（sellPrice），拷贝还回共享池
    const left = h.m.pool.left(S5);
    assert.deepEqual(h.m.handle('p_0', { t: 'g.sell', uid: piece.uid }), { ok: true });
    assert.equal(h.m.pool.left(S5), Math.min(h.m.pool.cap(S5), left + 1));
    h.invariants();
  });

  test('prices 能改助战的标价（没配的仍用阶级价）', () => {
    const data = structuredClone(DATA);
    data.support = { ...data.support, prices: { [S5]: 1 } };
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 5, fake: true, seats: seatsWith([S5]), data });
    assert.equal(h.m.gd.supportPrice(S5), 1);
    assert.equal(h.m.gd.supportPrice(S6), null, '没配的没有专属价 → 用阶级价');
    h.start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    ps.shop.level = T5;
    ps.funds = 100;
    let slot = -1;
    for (let i = 0; i < 400 && slot < 0; i++) {
      ps.rollShop();
      slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.id === S5);
    }
    assert.ok(slot >= 0);
    assert.equal(ps.priceOf(ps.shop.slots[slot]), 1, 'prices 覆盖了阶级价');
    const before = ps.funds;
    h.m.handle('p_0', { t: 'g.buy', slot });
    assert.equal(before - ps.funds, 1, '实付 1');
    h.invariants();
  });

  test('本局被随机禁用的干员，作为助战照样进池（禁用抽卡 ≠ 禁用助战）', () => {
    // A visible chess is banned iff every one of its bonds is in the match's disabled set (server/match/pool.js:25-43),
    // and a banned chess simply has no pool copies. Forcing that statically (through the mode's inactiveBondIds) makes
    // this deterministic instead of hunting for a seed that happens to ban the support.
    const banned = TIER5.find((id) => Array.isArray(DATA.chess[id]?.bonds) && DATA.chess[id].bonds.length > 0);
    assert.ok(banned, 'the shipped support pool must contain a tier-5 operator with bonds for this test to mean anything');
    const probe = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seed: 5, fake: true, seats: seatsWith([banned]) });
    probe.start();
    const modeId = probe.m.gd.modeId;
    const data = structuredClone(DATA);
    const mode = data.config.modes[modeId];
    assert.ok(mode, `mode ${modeId} must be in config.modes`);
    mode.inactiveBondIds = [...new Set([...(mode.inactiveBondIds || []), ...data.chess[banned].bonds])];

    // 不带它：它真的被禁掉了，商店永远摇不到
    const without = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seed: 5, fake: true, data });
    without.start();
    assert.ok(without.m.bannedChess.includes(banned), `expected ${banned} to be banned`);
    assert.equal(without.m.pool.has(banned), false);

    // 带上它：池子里有且只有那份助战拷贝，摇得到、买得起
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seed: 5, fake: true, seats: seatsWith([banned]), data });
    h.start();
    assert.ok(h.m.bannedChess.includes(banned), '本局的禁用名单不变（它仍然不算普通抽卡内容）');
    assert.equal(h.m.pool.has(banned), true, '助战必须能买到');
    assert.equal(h.m.pool.left(banned), 1, '禁用之后只剩助战那一份拷贝');
    assert.equal(h.m.pool.isSupport(banned), true);
    h.toPrep(1);
    const ps = h.ps('p_0');
    ps.shop.level = T5;
    let slot = -1;
    for (let i = 0; i < 400 && slot < 0; i++) {
      ps.rollShop();
      slot = ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.id === banned);
    }
    assert.ok(slot >= 0, '被禁用但带上的助战必须能从商店摇到');
    assert.deepEqual(ps.supportGranted, [banned]);
    h.invariants();
  });

  test('m.private echoes the support: selected vs really in the shop', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 5, fake: true, seats: seatsWith([S5, S6]) });
    h.start();
    const ps = h.ps('p_0');
    assert.deepEqual(ps.privateView().support, { selected: [S5, S6], granted: [] }, 'nothing is decided before the first round');
    h.toPrep(1);
    assert.deepEqual(ps.privateView().support, { selected: [S5, S6], granted: [S5, S6] });
    // a support the pool drops between the lobby and the round start shows up as selected-but-not-granted, which is what
    // lets the client explain it instead of leaving the player wondering why it never shows up in the shop
    const h2 = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 5, fake: true, seats: seatsWith([S5]) });
    h2.start();
    const ps2 = h2.ps('p_0');
    h2.m.gd.support = normalizeSupportConfig({ enabled: false });
    h2.toPrep(1);
    const view = ps2.privateView().support;
    assert.deepEqual(view.selected, [S5]);
    assert.deepEqual(view.granted, []);
    h2.invariants();
  });

  test('a selection the pool no longer allows is dropped at round 1, with a warning', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 8, fake: true, seats: seatsWith([S5]) });
    h.start();
    const ps = h.ps('p_0');
    // the server switched the operator off between the lobby check and the round start
    h.m.gd.support = normalizeSupportConfig({ enabled: false });
    assert.deepEqual(ps.prepareSupports(), []);
    assert.ok(h.sent.some(([, msg]) => msg.t === 'm.toast'), 'the player must be told');
  });

  test('bots never carry supports (and get no support copy)', () => {
    const h = makeMatch({
      mode: 'coop', difficulty: 'NORMAL', seed: 9, fake: true,
      seats: [
        { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, support: [S5] },
        { seat: 1, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true, support: [S6] },
      ],
    });
    h.start();
    h.toPrep(1);
    assert.deepEqual([...h.ps('ai_0').support], []);
    assert.equal(h.ps('ai_0').hand.filter(Boolean).length, 0);
    assert.deepEqual(h.m.supportSupply, [S5], '机器人的助战不进供给（席位上的 support 也不该被当真）');
    assert.equal(h.m.pool.isSupport(S6), false);
    h.invariants();
  });

  test('setSupport is re-checked against the pool (loadout-style accept/reject)', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, seed: 6, fake: true });
    h.start();
    h.runToPhase(PHASE.INFO_CHECK);
    assert.deepEqual(h.m.setSupport('p_0', [S5]), { ok: true });
    assert.deepEqual([...h.ps('p_0').support], [S5]);
    assert.equal(h.m.setSupport('p_0', [outsidePool(5)]).error, ERR.BAD_TARGET);
    assert.deepEqual([...h.ps('p_0').support], [S5], 'a refusal leaves the previous selection intact');
    assert.equal(h.m.setSupport('p_0', TIER6.slice(0, SLOTS6 + 1)).error, ERR.BAD_TARGET);
    assert.deepEqual(h.m.setSupport('p_0', []), { ok: true });
    assert.deepEqual([...h.ps('p_0').support], []);
  });
});

describe('room.support (lobby over WebSocket, stub match)', () => {
  /** Stub match that records its constructor options (the seats); it has no setSupport. */
  class RecordingStub extends StubMatch {
    static instances = [];
    constructor(opts) { super(opts); this.opts = opts; RecordingStub.instances.push(this); }
  }
  let srv;
  const open = new Set();
  const cap = { errors: [] };
  cap.log = { info() {}, warn() {}, debug() {}, error: (...a) => cap.errors.push(a.map(String).join(' ')) };
  const player = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    open.add(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  };

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingStub, heavyBurst: 6, heavyPerSec: 2 });
  });
  afterEach(async () => {
    RecordingStub.instances = [];
    await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
    open.clear();
  });
  after(async () => { await srv?.close(); });

  test('a client cannot smuggle an operator past the pool', async () => {
    const a = await player('Sup');
    // structure (BAD_MSG)
    await errReq(a, { t: 'room.support', entries: 'x' }, ERR.BAD_MSG);
    await errReq(a, { t: 'room.support', entries: [S5, S5] }, ERR.BAD_MSG);
    // data (BAD_TARGET): outside the pool / unknown / an elite / over a tier's slots
    await errReq(a, { t: 'room.support', entries: [outsidePool(5)] }, ERR.BAD_TARGET);
    await errReq(a, { t: 'room.support', entries: ['chess_char_9_99_a'] }, ERR.BAD_TARGET);
    await errReq(a, { t: 'room.support', entries: [DATA.chess[S5].goldenId] }, ERR.BAD_TARGET);
    if (TIER6.length > SLOTS6) await errReq(a, { t: 'room.support', entries: TIER6.slice(0, SLOTS6 + 1) }, ERR.BAD_TARGET);
    // outside a room it is accepted (kept on the session) …
    await okReq(a, { t: 'room.support', entries: [S5] });
    // … and a later refusal does not clear it
    await errReq(a, { t: 'room.support', entries: [outsidePool(5)] }, ERR.BAD_TARGET);
    assert.deepEqual(cap.errors, []);
  });

  test('the checked selection reaches the seats the match is built from, frozen', async () => {
    const host = await player('Host');
    await okReq(host, { t: 'room.support', entries: [S6] });
    await okReq(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await host.waitFor('room.state', (s) => s.hostId === host.id);
    await okReq(host, { t: 'room.addBot' });
    await okReq(host, { t: 'room.start' });
    await host.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    const seats = RecordingStub.instances.at(-1).opts.seats;
    const seat = seats.find((s) => s.playerId === host.id);
    assert.deepEqual(seat.support, [S6]);
    assert.ok(Object.isFrozen(seat.support), 'the seat holds the frozen checked copy');
    assert.equal(seats.find((s) => s.isBot).support, null, 'bots carry none');
    // the stub has no setSupport: refused, but stored for the next match (the loadout behaviour)
    await errReq(host, { t: 'room.support', entries: [] }, ERR.ROOM_STARTED);
    assert.deepEqual(cap.errors, []);
  });
});

describe('room.support (lobby + real match)', () => {
  let srv;
  const open = new Set();
  const cap = { errors: [] };
  cap.log = { info() {}, warn() {}, debug() {}, error: (...a) => cap.errors.push(a.map(String).join(' ')) };
  const player = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    open.add(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.token = w.token;
    return c;
  };

  before(async () => { srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, seedFn: () => 4242 }); });
  afterEach(async () => { await Promise.all([...open].map((c) => c.terminate().catch(() => {}))); open.clear(); });
  after(async () => { await srv?.close(); });

  test('accepted during INFO_CHECK, locked once the briefing ends', async () => {
    const a = await player('Solo');
    await okReq(a, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    await a.waitFor('room.state', (s) => s.hostId === a.id);
    await okReq(a, { t: 'room.start' });
    await a.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK, 5000);
    await okReq(a, { t: 'room.support', entries: [S5] });       // accepted in the briefing
    await okReq(a, { t: 'g.infoReady' });
    await a.waitFor('m.public', (p) => p.phase === PHASE.BAND_DRAFT, 5000);
    const r = await errReq(a, { t: 'room.support', entries: [S6] }, ERR.WRONG_PHASE);
    assert.match(r.detail || '', /locked/);
    assert.deepEqual(cap.errors, []);
  });
});
