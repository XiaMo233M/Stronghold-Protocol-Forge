// 工坊包覆盖 `publicView()` × `m.public` 增量帧（DESIGN §28.14 matchClass 包装器）：这条耦合面此前没有测试 ——
// 既有验收（test/match/public-delta.test.js、test/match/public-delta-match.test.js）量的是**引擎自己的**视图，
// 而工坊包可以写 `matchClass` 子类、在 `super.publicView()` 的返回值上**再加键、再改行**（真实例子：
// _up/mod-rewrites/促融共竞经济玩法/mod-xie/server/mod.mjs 的 `publicView()`：顶层加 `econ` / `revival` 两个探针
// 键，每行加 `pendingDeath` / `revivalReason`）。包的返回值现在要**进 diff**，本套件判它安全不安全。
//
// 结论（本文件同时是证据）：**包改的行是安全的，包加的顶层键是不安全的。**
//   * 行：`diffPlayers` 逐 `Object.keys(row)` 比较，包加的行字段照常进 patch / 照常用 null 表示「离开」。
//   * 顶层：`publicDelta` 只遍历 `server/viewsDelta.js` 的 `SCALAR_KEYS`（32 个引擎键的**硬编码白名单**），
//     不在名单里的键**既不进 patch 也不进基线**（`next` 是 `{...prev}`，包键保留旧值）。于是：
//       - 首帧全量之后，包键在客户端上**冻结**，直到下一次全量帧；
//       - 全量帧的间隔 = PUBLIC_FULL_EVERY = 32 帧（`server/match/match/common.js:40`），且有真实时间/脏标记条件；
//       - 基线里那个旧值还可能把包键的**首次变化**当成「没有变化」而整帧丢弃（probe：值 0 → 5 时帧里只剩 players）。
//
// 三块：
//   A. 真包（mod-xie，仓库外；缺包时退化为逐字等价的等价最小包）· 真 Match · 真帧流，用**客户端自己的**
//      public/js/matchDelta.js 物化，与服务器同一时刻的 `publicView()` 比。
//   B. 纯函数极端形状：直接用 publicDelta/publicBaseline/isEmptyDelta 过一遍点名的怪形状，patch 做一次 **JSON
//      往返**（模拟真上线序列化）再物化。
//   C. 包的返回值不是 JSON 纯值时的行为（原地改缓存行、循环引用 / BigInt、Map / Set / 函数值）。
//
// 纪律：本文件只读生产代码，不改任何生产文件。所有断言都是新增的（不放松任何既有断言）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { FakeBattle } from './match/fakeBattle.js';
import { PHASE } from '../shared/constants.js';
import { PUBLIC_FULL_EVERY } from '../server/match/match/common.js';
import { applyPublic } from '../public/js/matchDelta.js';
import { publicDelta, publicBaseline, isEmptyDelta } from '../server/viewsDelta.js';

const STUB_LOG = { info() {}, debug() {}, warn() {}, error() {} };
const DATA = getData({ log: STUB_LOG });

/**
 * The REAL workshop pack this coupling face is about: mod-xie (促融共竞), which overrides `publicView()` and adds the
 * top-level `econ` / `revival` probes plus the row fields `pendingDeath` / `revivalReason`. It lives outside the
 * repository (rewritten packs stay out of the tree), so it is loaded by absolute path; the suite says plainly when the
 * pack is not on this machine instead of pretending to have checked it.
 */
const PACK_ROOT = 'E:\\destop\\harness_1\\_up\\mod-rewrites\\促融共竞经济玩法\\mod-xie';
const PACK_ID = 'mod-xie';
let pack = null;
let packWhy = '';
try {
  accessSync(path.join(PACK_ROOT, 'server', 'mod.mjs'));
  pack = await import(pathToFileURL(path.join(PACK_ROOT, 'server', 'mod.mjs')).href);
} catch (e) {
  packWhy = e && e.message ? e.message : String(e);
}
const packAvailable = !!(pack && typeof pack.registerServer === 'function');
if (!packAvailable) console.error(`[pack] real mod-xie not loadable from this checkout (${packWhy})`);
const packOpts = () => (packAvailable ? {} : { minimal: true });
const packModes = () => (packAvailable ? ['real'] : ['minimal']);
const withPack = (name, fn) => test(name, { skip: packAvailable ? false : `real mod-xie not on this machine (${packWhy})` }, fn);

/**
 * A minimal pack that overrides `publicView()` **word for word** like the real one does (the same two top-level probe
 * keys with the same shapes, the same two row fields, appended to the array `super.publicView()` returned — the same
 * aliasing the real pack has: it mutates the returned rows, never a cached object). It exists so blocks A and C can run
 * anywhere; the real pack's own behaviour is reproduced by the two builders below.
 */
function minimalPackClass() {
  class MinimalPackMatch extends Match {
    constructor(opts) {
      super(opts);
      this.__mp = !!(this.mods && Array.isArray(this.mods.packs) && this.mods.packs.some((p) => p && p.id === PACK_ID));
    }
    start() {
      if (this.__mp) {
        this.__mpRound = 1;
        this.__mpProjects = { storehouse: 0, logistics: 0 };
        this.__mpSpent = 0;
      }
      return super.start();
    }
    econPublicView() {
      return {
        reserve: this.__mpRound * 2,
        transferLeft: Math.max(0, 8 - this.__mpSpent),
        projects: Object.keys(this.__mpProjects).map((id) => ({ id, level: this.__mpProjects[id], cost: [4, 8, 12][this.__mpProjects[id]] ?? null })),
        relief: { amount: 1, threshold: 10, left: Math.max(0, 4 - this.__mpRound) },
      };
    }
    revivalView() {
      const targets = this.order.filter((ps) => ps.pendingDeath).map((ps) => ({ playerId: ps.playerId, name: ps.name }));
      if (!targets.length) return null;
      return { open: true, round: this.round, cost: 10, minDonorLp: 11, donors: [], targets };
    }
    publicView() {
      const view = super.publicView();
      if (!this.__mp || !view || typeof view !== 'object') return view;
      view.econ = this.econPublicView();
      view.revival = this.revivalView();
      for (const row of view.players) {
        const ps = this.players.get(row.playerId);
        if (!ps) continue;
        row.pendingDeath = !!ps.pendingDeath;
        row.revivalReason = ps.revivalUnavailableReason || null;
      }
      return view;
    }
  }
  return MinimalPackMatch;
}

/** The real pack's `matchClass` wrapper, exactly as server/index.js applies it (by pack id, wrapping Match). */
function packClass() {
  let cls = null;
  pack.registerServer({ matchClass: (fn) => { cls = fn(Match); } });
  assert.equal(typeof cls, 'function', 'the pack registered a matchClass wrapper');
  return cls;
}

/**
 * A real Match wearing the pack wrapper, wired the way test/match/harness.js wires it (markPublic / flush / end capture),
 * minus the browser battle clients this suite does not need. Every `m.public` broadcast also asks the server for its
 * OWN current view (`__testView`, the pack's full form) so the two can be compared.
 */
function makePackedMatch(o = {}) {
  const sched = new VirtualScheduler({ instantCombat: true });
  const h = { bc: [], frames: [], counts: {}, snapshots: [] };
  const Base = o.minimal ? minimalPackClass() : packClass();
  class TestMatch extends Base {
    constructor(opts) { super(opts); this.__testView = () => this.publicView(); }
  }
  h.m = new TestMatch({
    roomCode: 'TEST', mode: o.mode ?? 'coop', difficulty: o.difficulty ?? 'NORMAL', seats: o.seats, seed: o.seed ?? 11,
    data: DATA, log: STUB_LOG, scheduler: sched,
    send: () => true,
    broadcast: (msg) => {
      h.bc.push(msg);
      h.counts[msg.t] = (h.counts[msg.t] || 0) + 1;
      if (msg.t === 'm.public') { h.frames.push(msg); h.snapshots.push(h.m.__testView()); }
    },
    onEnd: () => {},
    BattleClass: FakeBattle,
    timerScale: o.timerScale ?? 0.02,
    botRehearsal: 0,
    mods: o.mods ?? { digest: 'a'.repeat(64), packs: [{ id: PACK_ID }] },
  });
  h.start = () => { h.m.start(); return h; };
  h.flushAll = () => { sched.advance(200); h.m.flush(true); };
  h.autoHumans = () => { for (const ps of h.m.players.values()) if (!ps.isBot) ps.autoplay = true; return h; };
  h.drive = (pred, maxSteps = 3e6) => {
    for (let i = 0; i < maxSteps; i++) {
      if (pred()) return true;
      if (h.m.ended) return !!pred();
      for (const ps of h.m.players.values()) {
        if (ps.isBot || ps.left) continue;
        if (h.m.phase === 'INFO_CHECK' && !ps.infoReady) h.m.handle(ps.playerId, { t: 'g.infoReady' });
        if (h.m.phase === 'BAND_DRAFT' && h.m.draftTurn() === ps.playerId) h.m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
        if (h.m.phase === 'PREP' && ps.alive && !ps.ready) {
          if (ps.personalChoice) h.m.handle(ps.playerId, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
          if (!ps.tempEmpty) ps.resolveTemp();
          h.m.handle(ps.playerId, { t: 'g.ready', ready: true });
        }
      }
      if (pred()) return true;
      if (!sched.runNext()) return !!pred();
    }
    return !!pred();
  };
  return h;
}

const seatsOf = (n, bots = 0) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true });
  for (let i = 0; i < bots; i++) out.push({ seat: out.length, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true });
  return out;
};

/** The row as the CLIENT materializes a FULL frame: a null-valued key leaves the row (matchDelta normalizeRow). */
const canonRow = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
  return out;
};

/** A view as a client holds it after a full frame: `t` stripped, rows normalized (matchDelta clonePublic + M). */
function canonFull(view) {
  const out = {};
  for (const [k, v] of Object.entries(view)) {
    if (k === 't') continue;
    if (k === 'players' && Array.isArray(v)) { out[k] = v.map(canonRow); continue; }
    out[k] = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? { ...x } : x)) : v;
  }
  return out;
}

/** The same JSON means the same materialized value here (key ORDER is not part of the contract, values are). */
function canonJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${v[k] === undefined ? '"__undef__"' : canonJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const sameJson = (a, b) => canonJson(a) === canonJson(b);

/** The keys a delta frame carries besides its markers. */
const payloadKeys = (frame) => Object.keys(frame).filter((k) => k !== 't' && k !== 'delta');

/**
 * Replay the recorded stream the way a browser does (the production merge) and judge it with the server's own FULL view
 * of the same moment. Returns the frame statistics plus every place the two disagreed (never thrown, always reported).
 */
function replayAgainstPack(h) {
  let state = null;
  let fullCount = 0;
  let deltaCount = 0;
  let deltaBytes = 0;
  let sawPackKey = false;
  let sawPackRowField = false;
  const mismatches = [];
  const droppedKeys = new Set();
  for (let i = 0; i < h.frames.length; i++) {
    const frame = h.frames[i];
    const full = h.snapshots[i];
    const res = applyPublic(state, frame);
    assert.equal(res.ok, true, `every frame must be applicable: ${JSON.stringify(frame).slice(0, 200)}`);
    state = res.state;
    if (frame.delta === true) { deltaCount++; deltaBytes += Buffer.byteLength(JSON.stringify(frame), 'utf8'); } else fullCount++;
    assert.ok(Number.isFinite(frame.serverNow), `serverNow rides every frame (${frame.delta ? 'delta' : 'full'})`);
    if (full && ('econ' in full || 'revival' in full)) sawPackKey = true;
    if (frame.players && frame.players.some((p) => 'pendingDeath' in p || 'revivalReason' in p)) sawPackRowField = true;
    // the strict form: the client's materialized state must BE the server's view at this frame, field for field
    // (rows compared through the same normalization a full frame gets: a row null means "unset" on both paths)
    if (!full) continue;
    const want = canonFull(full);
    const got = { ...state, players: Array.isArray(state.players) ? state.players.map(canonRow) : state.players };
    if (!sameJson(got, want)) {
      const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((k) => !sameJson(got[k], want[k]));
      mismatches.push({ i, kind: 'state-differs', keys, isDelta: frame.delta === true });
    }
    for (const k of Object.keys(full)) if (k !== 't' && !(k in state)) droppedKeys.add(k);
  }
  return { state, fullCount, deltaCount, deltaBytes, sawPackKey, sawPackRowField, mismatches, droppedKeys };
}

// ---------------------------------------------------------------------------------------------------------------
// A. the real pack, end to end
// ---------------------------------------------------------------------------------------------------------------

describe('工坊包覆盖 publicView() × 增量帧（真包 mod-xie，缺包时退化到等价最小包）', () => {
  for (const variant of packModes()) {
    const opts = variant === 'minimal' ? { minimal: true } : {};
    const runner = variant === 'real' ? withPack : test;

    runner(`[${variant}] 包装上真 Match：包自门控生效，它加的顶层键与行字段进了视图`, () => {
      const h = makePackedMatch({ seats: seatsOf(3, 1), ...opts });
      h.autoHumans();
      h.start();
      if (variant === 'real') {
        assert.equal(pack.isXieRoom(h.m.mods), true, 'the room names the pack');
        assert.equal(h.m.__xieReady, true, 'the pack armed itself in start()');
        assert.ok(h.m.teamEcon, 'the pack built its rule set on a real Match');
        assert.equal(typeof h.m.econPublicView, 'function', 'and installed its view builders');
      }
      assert.deepEqual(h.m.errors, [], 'no engine errors');
      h.flushAll();
      const first = h.frames[0];
      assert.equal(first.delta, undefined, 'the first frame is the full one');
      assert.ok('econ' in first, 'm.public.econ — the pack-added top-level key');
      assert.ok('revival' in first, 'm.public.revival — the second probe key');
      h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
      h.flushAll();
      const view = h.m.publicView();
      assert.equal(view.players.length, 4);
      for (const row of view.players) {
        assert.ok('pendingDeath' in row, 'the pack adds pendingDeath to every row');
        assert.ok('revivalReason' in row, 'and revivalReason');
      }
      console.error(`[pack ${variant}] first frame keys ${Object.keys(first).length} · counts ${JSON.stringify(h.counts)}`);
    });

    runner(`[${variant}] 真对局帧流：包改的**行字段**如实增量送达（逐帧与服务器同一时刻的全量视图比对）`, () => {
      const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 5, ...opts });
      h.autoHumans();
      h.start();
      h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
      h.flushAll();
      const before = h.frames.length;
      const ps = h.m.players.get('p_2');
      ps.pendingDeath = true;
      ps.revivalUnavailableReason = 'no-donor';
      h.m.markPublic();
      h.flushAll();
      const added = h.frames.slice(before);
      assert.ok(added.length >= 1, 'a frame went out for the change');
      const delta = added[added.length - 1];
      assert.equal(delta.delta, true, 'and it is a delta');
      const patch = (delta.players || []).find((p) => p.playerId === 'p_2');
      assert.ok(patch, 'the pack-changed row is in the patch');
      assert.equal(patch.pendingDeath, true, 'the pack-set row field rides the patch');
      assert.equal(patch.revivalReason, 'no-donor');
      const r = replayAgainstPack(h);
      const row = r.state.players.find((p) => p.playerId === 'p_2');
      assert.equal(row.pendingDeath, true, 'and the client materializes it');
      assert.equal(row.revivalReason, 'no-donor');
      assert.equal(r.sawPackRowField, true, 'a pack row field really rode a patch');
      // ...and back: the pack writes null when the seat is no longer pending (the row-null rule)
      ps.pendingDeath = false;
      ps.revivalUnavailableReason = null;
      h.m.markPublic();
      h.flushAll();
      const back = h.frames[h.frames.length - 1];
      const backPatch = (back.players || []).find((p) => p.playerId === 'p_2');
      assert.equal(backPatch.pendingDeath, false);
      assert.equal(backPatch.revivalReason, null, 'a vanished row field is sent as null');
      const r2 = replayAgainstPack(h);
      const row2 = r2.state.players.find((p) => p.playerId === 'p_2');
      assert.equal(row2.pendingDeath, false);
      assert.equal('revivalReason' in row2, false, 'the client drops the key (one state, not two)');
      assert.deepEqual(r2.mismatches.filter((x) => x.kind === 'diff-threw'), [], 'no frame made the differ throw');
    });

    runner(`[${variant}] 包加的**顶层键**照常进增量帧：客户端上的 econ / revival 不再冻结（缺陷①的翻面）`, () => {
      // FLIPPED (2026-10-11) — the defect was: `publicDelta` walked a hard-coded whitelist (viewsDelta SCALAR_KEYS), a
      // key the pack added was not in it, so it was never diffed, never patched, and never even updated in the baseline.
      // The fix walks every own key of the view: the key appears in the FULL frame, joins the baseline there, and from
      // then on diffs like any engine key (viewsDelta.js rules 1; the regression suite is publicDeltaPackKeys A1–A3).
      const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 5, ...opts });
      h.autoHumans();
      h.start();
      h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
      h.flushAll();
      const r = replayAgainstPack(h);
      assert.equal(r.sawPackKey, true, 'the pack keys were in the full frames');
      // 1. a pack key that CHANGED while the room was already on the delta path rides a DELTA — the frame the pack's HUD
      //    needs, instead of waiting for the 32-frame full keepalive. The pack's own state is moved through its PUBLIC
      //    view (the value in the full view really differs), so this holds for the real pack and the minimal one alike.
      assert.ok(h.frames.some((f) => f.delta === true), 'the stream used deltas');
      const econBefore = JSON.parse(JSON.stringify(h.m.publicView().econ));   // what the pack said BEFORE the move
      h.m.__mpRound = 15;                       // the minimal pack's own probe: reserve 2 → 30
      h.m.teamReserve = 12;                     // the real pack's own probe: reserve → 12
      h.m.markPublic();
      h.flushAll();
      const wrapped = h.m.publicView();
      const wantEcon = JSON.parse(JSON.stringify(wrapped.econ));
      assert.notDeepEqual(wantEcon, econBefore, 'the pack view really moved (else there is nothing to send)');
      const packed = h.frames.filter((f) => f.delta === true && Object.hasOwn(f, 'econ'));
      assert.ok(packed.length >= 1, 'THE FIX: a DELTA carrying the pack key went out (the old code sent nothing at all)');
      const lastEcon = packed[packed.length - 1].econ;
      assert.deepEqual(lastEcon, wantEcon, 'and it is the pack key’s own current value');
      // every pack key the frame does carry must be that moment's value (revival is null for both packs while no revival
      // is pending — then it is unchanged and simply not in the patch, hence the conditional instead of a claim on it)
      for (const k of ['revival']) if (Object.hasOwn(packed[packed.length - 1], k)) assert.deepEqual(packed[packed.length - 1][k], wrapped[k], `${k} rides the same frame as its own current value`);
      // ...and the client materializes it on that very frame: replay the whole stream the browser way
      let state = null;
      for (const f of h.frames) { const res = applyPublic(state, f); assert.equal(res.ok, true, 'every frame applies'); state = res.state; }
      assert.equal(state.econ.reserve, wantEcon.reserve, 'the client reads the pack’s current reserve after ONE delta (was: frozen at the last full frame)');
      assert.deepEqual(state.econ, wantEcon, 'the whole pack key materializes as the server’s view says');
      // 2. the pack's own row fields DO ride the deltas (the contrast that makes the finding specific)
      assert.equal(r.sawPackRowField, true, 'the pack row fields did ride deltas');
      // 3. every key that IS diffed agrees with the server's view at every frame
      assert.deepEqual(r.mismatches, [], 'no key that the differ tracks ever diverges');
      // 4. was: THE STALENESS — a pack key's value changes on the server, no frame carries it, and the client drifts
      //    until the next FULL frame (PUBLIC_FULL_EVERY deltas away). After the fix the change IS the frame, and the
      //    baseline moves with it, so the next diff compares against the value the client really holds:
      const v1 = { t: 'm.public', phase: 'PREP', econ: { reserve: 0 }, players: [{ playerId: 'p_0', lp: 10 }] };
      const v2 = { t: 'm.public', phase: 'PREP', econ: { reserve: 99 }, players: [{ playerId: 'p_0', lp: 10 }] };
      const d = publicDelta(publicBaseline(v1), v2);
      // was: isEmptyDelta(d.frame) === true (the defect: a pack-key-only change yielded NO frame at all)
      assert.equal(isEmptyDelta(d.frame), false, 'a pack-key-only change yields a frame');
      assert.deepEqual(d.frame.econ, { reserve: 99 }, 'and the changed pack key is what it carries');
      // was: deepEqual(d.next.econ, { reserve: 0 }) (the defect: the baseline kept the stale value and compared against it)
      assert.deepEqual(d.next.econ, { reserve: 99 }, 'and the baseline holds the value it just sent, never a stale one');
      console.error(`[pack keys ${variant}] ${r.fullCount} full / ${r.deltaCount} delta · a pack-key-only change sends a delta · PUBLIC_FULL_EVERY ${PUBLIC_FULL_EVERY}`);
    });

    runner(`[${variant}] 影响面：包的 HUD 读的就是 m.public.econ，它在下一帧就拿到新值（缺陷①的 HUD 验收）`, () => {
      // The pack's own client HUD (mod-xie/client/econ.js:33 `state.pub.econ`, then `pub.reserve` at line 39) renders
      // from the materialized `m.public`. The defect: a client that received the delta stream showed whatever the last
      // FULL frame said until the keepalive. The fix: the pack-key-only change IS a delta, and the next baseline is
      // current. Deterministic replay of exactly that:
      const firstFull = { t: 'm.public', phase: 'PREP', econ: { reserve: 0, transferLeft: 8 }, players: [{ playerId: 'p_0', lp: 10 }] };
      const laterFull = { ...firstFull, econ: { reserve: 30, transferLeft: 3 }, players: [{ playerId: 'p_0', lp: 9 }] };
      const client = applyPublic(null, JSON.parse(JSON.stringify(firstFull))).state;
      const { frame, next } = publicDelta(publicBaseline(firstFull), laterFull);
      const merged = applyPublic(client, JSON.parse(JSON.stringify(frame))).state;
      // was: merged.econ.reserve === 0 ('the HUD reads reserve 0 while the pack says 30')
      assert.equal(merged.econ.reserve, 30, 'the HUD reads the pack’s own 30 on the very next frame');
      assert.equal(merged.players[0].lp, 9, 'and the engine rows advance in the same frame (the delta carried them)');
      // was: notEqual(merged.econ.reserve, laterFull.econ.reserve) ('so the pack key on screen is stale')
      assert.equal(merged.econ.reserve, laterFull.econ.reserve, 'so the pack key on screen is current, not stale');
      // was: next.econ.reserve === 0 ('the baseline that the NEXT frame diffs against is stale too')
      assert.equal(next.econ.reserve, 30, 'and the baseline the NEXT frame diffs against carries the value just sent');
      // the keepalive is still what bounds a lost frame: `markPublicFull` every PUBLIC_FULL_EVERY deltas
      assert.ok(Number.isInteger(PUBLIC_FULL_EVERY) && PUBLIC_FULL_EVERY > 1, `PUBLIC_FULL_EVERY = ${PUBLIC_FULL_EVERY}`);
      console.error(`[pack keys ${variant}] HUD reserve: client ${merged.econ.reserve} vs pack ${laterFull.econ.reserve} · delivered on the next delta (full keepalive every ${PUBLIC_FULL_EVERY} frames)`);
    });

    runner(`[${variant}] 纯函数复现：不在 SCALAR_KEYS 里的键值与基线都跟着动（缺陷①的翻面）`, () => {
      // was: "不在 SCALAR_KEYS 里的键值与基线都不动" (the defect: the pack key was neither patched nor kept in the baseline)
      const v1 = { t: 'm.public', phase: 'PREP', econ: { reserve: 0 }, players: [{ playerId: 'p_0', lp: 10 }] };
      const v2 = { t: 'm.public', phase: 'PREP', econ: { reserve: 5 }, players: [{ playerId: 'p_0', lp: 9 }] };
      const { frame, next } = publicDelta(publicBaseline(v1), v2);
      // was: Object.hasOwn(frame, 'econ') === false ('the pack key never rides the patch')
      assert.equal(Object.hasOwn(frame, 'econ'), true, 'the pack key rides the patch');
      assert.deepEqual(frame.econ, { reserve: 5 }, 'with the value the view really has');
      assert.deepEqual(frame.players, [{ playerId: 'p_0', lp: 9 }], 'while the engine rows do');
      // was: deepEqual(next.econ, { reserve: 0 }) ('the baseline keeps the STALE value')
      assert.deepEqual(next.econ, { reserve: 5 }, 'and the baseline carries the new value, so the next diff compares against it');
      // was: a pack-only change produced an EMPTY frame, so no frame went out at all
      const still = publicDelta(publicBaseline(v1), { ...v1, econ: { reserve: 5 } });
      assert.equal(isEmptyDelta(still.frame), false, 'a pack-only change is NOT an empty frame → a frame goes out');
      assert.deepEqual(still.frame.econ, { reserve: 5 }, 'and it carries the pack key alone');
      // a SCALAR_KEYS member behaves exactly the same (the whitelist is no longer what decides)
      const scalar = publicDelta(publicBaseline({ t: 'm.public', round: 1 }), { t: 'm.public', round: 2 });
      assert.equal(scalar.frame.round, 2, 'an engine key is patched');
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// B. pure-function extreme shapes (the diff itself, plus a JSON round-trip as the wire would do)
// ---------------------------------------------------------------------------------------------------------------

/** One baseline view to bend: a real packed view, taken from a driven match (so every shape is the real one). */
function realBaseline() {
  const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 9, ...packOpts() });
  h.autoHumans();
  h.start();
  h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
  return h.m.publicView();
}

/** Materialize the way the browser does: a FULL frame is clonePublic, a delta is merged; both go through JSON first. */
function materialize(base, cur) {
  const wireFull = JSON.parse(JSON.stringify(cur));
  const { frame } = publicDelta(publicBaseline(base), cur);
  const wireDelta = JSON.parse(JSON.stringify(frame));
  const first = applyPublic(null, wireFull);
  assert.equal(first.ok, true, 'the full frame applies');
  const second = applyPublic(first.state, wireDelta);
  assert.equal(second.ok, true, `the delta applies (${JSON.stringify(wireDelta).slice(0, 200)})`);
  return { frame, wireDelta, state: second.state, empty: isEmptyDelta(frame) };
}

describe('publicDelta 的极端形状（纯函数 + JSON 往返物化）', () => {
  const base = realBaseline();

  test('顶层引擎键消失 → gone；重新出现 → 再作一次普通 patch', () => {
    const withKey = { ...base, round: 7 };
    const goneView = { ...base, round: undefined };
    const a = materialize(withKey, goneView);
    assert.deepEqual(a.frame.gone, ['round'], 'the vanished key is named in gone');
    assert.equal('round' in a.wireDelta, false, 'and never appears as a value');
    assert.equal('round' in a.state, false, 'the client deletes it');
    const b = materialize(goneView, withKey);
    assert.equal(b.frame.round, 7, 'a value that came back is a normal patch');
    assert.equal(b.state.round, 7, 'and materializes');
    assert.equal(a.empty, false);
  });

  test('顶层键新增：引擎白名单内的键可以照常 patch，包加的键 ⇒ 差集拒绝 → 全量（对照）', () => {
    // FLIPPED (2026-10-11). was: "顶层键新增：引擎白名单内的键可以，包加的键不行（对照）" — the defect was that the pack
    // key went into neither the patch nor the baseline, so the frame was silently empty and the change was lost.
    // The fix: an unknown top-level key makes `publicDelta` REFUSE (`ok: false`, frame ignored, `messaging.js` sends the
    // FULL frame), so a key the room's baseline never carried is never half-patched — the whole room resets onto it.
    // a whitelisted key can be added later in a match's life (teamLp appears when the mode has LP)
    const noLp = { ...base };
    delete noLp.teamLp;
    const withLp = { ...noLp, teamLp: 42 };
    const a = materialize(noLp, withLp);
    assert.equal(a.frame.teamLp, 42, 'a SCALAR_KEYS key that appears is patched');
    assert.equal(a.state.teamLp, 42);
    // a pack key that appears: the baseline has no such key ⇒ the delta is REFUSED, never a silent empty frame
    const noEcon = { ...base };
    delete noEcon.econ;
    const withEcon = { ...noEcon, econ: { reserve: 1, transferLeft: 2, projects: [{ id: 'storehouse', level: 0, cost: 4 }], relief: null } };
    const refused = publicDelta(publicBaseline(noEcon), withEcon);
    // was: assert.equal(Object.hasOwn(b.frame, 'econ'), false, 'THE FINDING: the pack key is not in the patch at all')
    assert.equal(Object.hasOwn(refused.frame, 'econ'), false, 'no half-patch is handed out');
    assert.equal(refused.ok, false, 'THE FIX: the shape change is refused, not silently dropped');
    assert.match(refused.why, /unknown top-level key "econ"/, `and the reason names the key (${refused.why})`);
    // was: assert.equal(payloadKeys(b.frame).length, 0, '… the frame is completely EMPTY → nothing is sent')
    assert.equal(payloadKeys(refused.frame).length, 0, 'the refused frame carries nothing — the caller sends the FULL frame');
    // the full frame is how a key the baseline never carried reaches a client (messaging.js: `sendFull = frame === full`)
    const bn = materialize(noEcon, withEcon);
    assert.equal(applyPublic(null, bn.wireDelta).reason, 'no-base', 'the refused delta has nothing to merge into on its own');
    assert.deepEqual(applyPublic(null, JSON.parse(JSON.stringify(withEcon))).state.econ, withEcon.econ, 'the FULL frame carries and materializes it');
    // an engine change in the SAME frame does not rescue the delta: the frame is refused whole, so both changes go out
    // in the full frame (never one of them as a patch)
    const withEconAndRow = { ...withEcon, players: withEcon.players.map((r, i) => (i === 0 ? { ...r, lp: r.lp - 1 } : r)) };
    const cRefused = publicDelta(publicBaseline(noEcon), withEconAndRow);
    assert.equal(cRefused.ok, false, 'the pack key appearing refuses the frame even when an engine row changed too');
    // was: assert.deepEqual(payloadKeys(c.frame), ['players'], 'only the engine rows are in the patch')
    assert.deepEqual(payloadKeys(cRefused.frame), [], 'so no partial patch rides the wire');
    const cFull = JSON.parse(JSON.stringify(withEconAndRow));
    assert.deepEqual(applyPublic(null, cFull).state.players.map((r) => r.lp), cFull.players.map((r) => r.lp), 'the FULL frame carries the row change as well');
    // the contrast: once the baseline HAS the pack key it diffs like any engine key — a later change is a normal patch
    const next = { ...withEcon, econ: { ...withEcon.econ, transferLeft: 1, reserve: 99 } };
    const d = publicDelta(publicBaseline(withEcon), next);
    // was: assert.equal(isEmptyDelta(d.frame), true, 'a later change to the pack key is dropped as "nothing changed"')
    assert.equal(isEmptyDelta(d.frame), false, 'a later change to the pack key is a real frame');
    assert.deepEqual(d.frame.econ, next.econ, 'and it carries the pack key');
    // was: the client kept the value of its last FULL frame (stale until the next full frame) — now it advances at once
    const held = applyPublic(applyPublic(null, JSON.parse(JSON.stringify(withEcon))).state, JSON.parse(JSON.stringify(d.frame)));
    assert.equal(held.ok, true, 'the delta merges into the client that got the full frame');
    assert.deepEqual(held.state.econ, JSON.parse(JSON.stringify(next)).econ, 'and the client holds the pack’s own new value');
  });

  test('players 行新增 / 消失 → 整行 / gone:true', () => {
    const added = { ...base, players: [...base.players.map((r) => ({ ...r })), { playerId: 'p_new', name: 'NEW', status: 'acting', lp: 10, boardCount: 0 }] };
    const a = materialize(base, added);
    const patch = a.frame.players.find((p) => p.playerId === 'p_new');
    assert.ok(patch, 'the new seat rides the frame');
    assert.equal(patch.gone, undefined, 'as a whole row, not a gone marker');
    assert.equal(a.state.players.length, base.players.length + 1, 'the client appends it');
    const b = materialize(added, base);
    const dropped = b.frame.players.find((p) => p.playerId === 'p_new');
    assert.deepEqual(dropped, { playerId: 'p_new', gone: true }, 'the seat that left is a gone patch');
    assert.equal(b.state.players.some((r) => r.playerId === 'p_new'), false, 'and is dropped');
  });

  test('行内字段从有到无（null vs 缺失）→ 一个状态', () => {
    const rows = base.players.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], bandId: 'band_bldsk', deployCount: 3 };
    const a = materialize(base, { ...base, players: rows });
    assert.equal(a.state.players[0].bandId, 'band_bldsk', 'the field arrives');
    const gone = rows.map((r) => ({ ...r }));
    delete gone[0].bandId;
    const b = materialize({ ...base, players: rows }, { ...base, players: gone });
    const p = b.frame.players.find((x) => x.playerId === rows[0].playerId);
    assert.equal(p.bandId, null, 'a row field that left the view is sent as null');
    assert.equal('bandId' in b.state.players[0], false, 'and the client drops the key (same state as a full frame)');
    assert.deepEqual(canonRow({ ...gone[0], bandId: null }), canonRow(b.state.players[0]), 'null row field ≡ absent after materializing');
  });

  test('包加的行字段从有到无：和引擎行字段同一条规则', () => {
    const rows = base.players.map((r) => ({ ...r }));
    rows[0] = { ...rows[0], packField: { level: 1 } };
    const a = materialize(base, { ...base, players: rows });
    assert.deepEqual(a.state.players[0].packField, { level: 1 }, 'a pack row field arrives');
    const gone = rows.map((r) => ({ ...r }));
    delete gone[0].packField;
    const b = materialize({ ...base, players: rows }, { ...base, players: gone });
    const p = b.frame.players.find((x) => x.playerId === rows[0].playerId);
    assert.equal(p.packField, null, 'its removal is spelled null, exactly like an engine field');
    assert.equal('packField' in b.state.players[0], false, 'and the client drops it');
  });

  test('数组顺序变化（factions / bannedChess / disabledBonds）', () => {
    const a = { ...base, factions: ['b', 'a', 'c'] };
    const b = { ...base, factions: ['a', 'b', 'c'] };
    const r = materialize(a, b);
    assert.deepEqual(r.frame.factions, ['a', 'b', 'c'], 'the reordered array is re-sent whole');
    assert.deepEqual(r.state.factions, ['a', 'b', 'c'], 'and materializes in the new order');
    const rebuilt = { ...base, factions: base.factions.slice(), bannedChess: base.bannedChess.slice() };
    assert.equal(isEmptyDelta(publicDelta(publicBaseline(base), rebuilt).frame), true, 'a rebuilt-but-equal array is not a change');
    const reversed = [...base.disabledBonds].reverse();
    if (JSON.stringify(reversed) !== JSON.stringify(base.disabledBonds)) {
      const r2 = materialize(base, { ...base, disabledBonds: reversed });
      assert.deepEqual(r2.frame.disabledBonds, reversed, 'a reorder of disabledBonds is a change and is re-sent whole');
      assert.deepEqual(r2.state.disabledBonds, reversed, 'and materializes in the new order');
    }
  });

  test('数组里的对象（引擎的 fields / 白名单键里的对象数组）：整数组重发，物化等价', () => {
    const before = { ...base, draft: { picks: { p_0: 'a' }, projects: [{ id: 'a', level: 0 }, { id: 'b', level: 0 }] } };
    const after = { ...base, draft: { picks: { p_0: 'a' }, projects: [{ id: 'a', level: 1 }, { id: 'b', level: 0 }] } };
    const r = materialize(before, after);
    assert.deepEqual(payloadKeys(r.frame), ['draft'], 'the parent key is re-sent');
    assert.deepEqual(r.frame.draft.projects, after.draft.projects, 'the array inside it is whole (the diff is field-level at depth 1)');
    assert.deepEqual(r.state.draft, after.draft, 'materializes equal');
    // the engine's own fields[] is diffed per ENTRY (a different mechanism) — unchanged entries keep their object
    const f = base.fields.map((x) => ({ ...x }));
    if (f.length) {
      f[0] = { ...f[0], progress: { ...(f[0].progress || {}), killed: 3 } };
      const rf = materialize(base, { ...base, fields: f });
      const patch = (rf.frame.fields || []).find((x) => x.fieldId === f[0].fieldId);
      assert.ok(patch, 'the changed field entry is patched');
      assert.deepEqual(patch.progress, f[0].progress, 'with its progress subtree whole');
      assert.deepEqual(rf.state.fields, canonFull({ fields: f }).fields, 'and materializes equal');
    }
  });

  test('undefined / null / NaN：差集判据与 JSON 线上的分歧', () => {
    const b = { ...base, round: 7 };
    const undef = { ...b, round: undefined };
    const r1 = materialize(b, undef);
    assert.deepEqual(r1.frame.gone, ['round'], 'undefined at the top level is the gone path');
    assert.equal('round' in r1.state, false);
    const nul = { ...b, round: null, bossId: null };
    const r2 = materialize(b, nul);
    assert.equal(r2.frame.round, null, 'null is sent as the value it is');
    assert.equal(r2.frame.gone, undefined, 'and never as a gone');
    assert.equal(r2.state.round, null, 'null materializes as null at the top level');
    // NaN: JSON turns it into null on the wire, so a NaN view is REFUSED at the door (caller sends the FULL frame)
    const nan = { ...b, round: NaN };
    const r3 = materialize(b, nan);
    // was: assert.equal(Object.hasOwn(r3.wireDelta, 'round'), true, 'the key is on the wire')
    assert.equal(Object.hasOwn(r3.wireDelta, 'round'), false, 'THE FIX: NaN is refused, so the key is NOT on the wire');
    const d3 = publicDelta(publicBaseline(b), nan);
    assert.equal(d3.ok, false, 'and the refusal is explicit (`ok: false`), never a silent patch');
    assert.match(d3.why, /not a JSON value \(NaN or Infinity\)/, `the reason names it (${d3.why})`);
    assert.equal(Object.hasOwn(d3.frame, 'round'), false, 'no half-built patch is handed out');
    // was: assert.equal(Number.isNaN(r3.state.round), false, 'so the client holds null, not NaN') — that wire lie is gone
    assert.equal(JSON.stringify({ round: NaN }), '{"round":null}', 'JSON.stringify would still turn NaN into null — why it is refused');
    const r4 = publicDelta(publicBaseline(nan), { ...nan });
    // was: assert.equal(Object.hasOwn(r4.frame, 'round'), true, 'a NaN baseline re-sends the field on every frame (never settles)')
    assert.equal(Object.hasOwn(r4.frame, 'round'), false, 'a NaN view on both sides is refused instead of re-sending forever');
    assert.equal(r4.ok, false, 'and it too falls back to the FULL frame');
    assert.match(r4.why, /not a JSON value \(NaN or Infinity\)/, 'for the same reason');
    assert.ok(Number.isNaN(publicBaseline(nan).round), 'the baseline does hold the NaN itself (it is the view’s own value)');
  });

  test('深层嵌套 / 同一对象两处引用 / 空数组 / 数组塞 null / 稀疏数组', () => {
    const deep = { a: { b: { c: { d: [1, 2, { e: null }] } } } };
    const shared = { k: 1 };
    const both = { ...base, packExtra: { left: shared, right: shared }, packDeep: deep };
    const r = materialize(base, both);
    assert.deepEqual(r.state.packExtra, { left: { k: 1 }, right: { k: 1 } }, 'a twice-referenced object serializes twice and materializes as two');
    assert.deepEqual(r.state.packDeep, deep, 'a deep chain rides whole');
    // (assigned into the white-listed names too, since a pack key's own change is not diffed at all — see block A)
    const deeper = { ...both, teamLp: 5 };
    const r2 = materialize(both, deeper);
    assert.equal(r2.frame.teamLp, 5, 'a whitelisted key change rides the frame');
    assert.equal(r2.state.teamLp, 5);
    // arrays of objects / nulls / holes
    const withArr = { ...base, packArr: [{ a: 1 }, null, { b: 2 }] };
    const r3 = materialize(base, withArr);
    assert.deepEqual(r3.state.packArr, [{ a: 1 }, null, { b: 2 }], 'objects and nulls in one array materialize as they are');
    const sparse = { ...base };
    sparse.packArr = new Array(3);
    sparse.packArr[0] = 'x';
    const r4 = materialize(base, sparse);
    assert.deepEqual(JSON.parse(JSON.stringify(r4.state.packArr)), ['x', null, null], 'holes become null on the wire (JSON), and that is what the client holds');
  });

  test('同一对象两处引用（whitelisted 键）：物化后仍是两个相等的副本', () => {
    const shared = { k: 1 };
    const r = materialize({ ...base, teamLp: 1 }, { ...base, teamLp: { left: shared, right: shared } });
    assert.deepEqual(r.state.teamLp, { left: { k: 1 }, right: { k: 1 } }, 'the JSON wire flattens the sharing into two copies');
    assert.notEqual(r.state.teamLp.left, r.state.teamLp.right, 'and the client holds two objects, not one aliased twice');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C. what a pack's return value must be for the diff to stay exact
// ---------------------------------------------------------------------------------------------------------------

describe('包的返回值不是 JSON 纯值时的行为（不动生产代码，只记录判据）', () => {
  test('安全：包每帧返回新对象（真 mod-xie 的写法）—— 白名单内外的变化分别被送达 / 漏掉', () => {
    // the pack's own view is rebuilt fresh every frame (the real pack: `super.publicView()` + appended keys)
    let n = 0;
    const packView = () => ({ t: 'm.public', round: 1, teamLp: 10, econ: { reserve: ++n, projects: [{ id: 'storehouse', level: 0 }] } });
    let prev = publicBaseline(packView());
    const engineSeen = [];
    const packSeen = [];
    for (let i = 0; i < 3; i++) {
      const cur = packView();
      const res = publicDelta(prev, cur);
      prev = res.next;
      engineSeen.push(res.frame.teamLp);
      packSeen.push(res.frame.econ?.reserve);
    }
    assert.deepEqual(engineSeen, [undefined, undefined, undefined], 'an unchanged engine key sends nothing (correct)');
    // was: assert.deepEqual(packSeen, [undefined, undefined, undefined], 'and the pack key never sends anything at all (the finding)')
    assert.deepEqual(packSeen, [2, 3, 4], 'THE FIX: the pack key sends its real new value on every frame it changes');
    // the pack key and an engine key ride the SAME frame — neither of them is special any more
    const a = { t: 'm.public', round: 1, econ: { reserve: 1 } };
    const b = { t: 'm.public', round: 2, econ: { reserve: 2 } };
    const res = publicDelta(publicBaseline(a), b);
    assert.equal(res.frame.round, 2, 'the engine key rides');
    // was: assert.equal(Object.hasOwn(res.frame, 'econ'), false, 'the pack key still does not, even in the same frame')
    assert.equal(Object.hasOwn(res.frame, 'econ'), true, 'and so does the pack key, in the same frame');
    assert.deepEqual(res.frame.econ, { reserve: 2 }, 'with the value the view has');
  });

  test('安全：包在原地改自己**缓存**的行对象 —— 基线不混叠，整行（含引擎字段）照常进差集', () => {
    // FLIPPED (2026-10-11) — the defect was: the pack caches the row objects it returns and mutates them in place.
    // `publicBaseline` used to copy only the view's top level and the players ARRAY and to keep the SAME row objects,
    // so the baseline and the new view aliased one object: `old[k] === row[k]` for EVERY field of that row — the diff
    // found nothing and no patch for that row ever rode the wire again (the pack's fields AND the engine's).
    // The fix: `publicBaseline` deep-copies (`plainCopy`), so the baseline is a snapshot no later in-place write can
    // move. The pack below is still a stand-in (no shipped pack does this, nothing stops one): its aliasing is real,
    // the baseline simply refuses to take part in it. The acceptance point is the same as test/publicDeltaPackKeys B1/B2.
    const h = makePackedMatch({ seats: seatsOf(3, 1), seed: 9, ...packOpts() });
    h.autoHumans();
    h.start();
    h.drive(() => h.m.round >= 1 && h.m.phase === PHASE.PREP);
    h.flushAll();
    const cache = new Map();                          // the pack's "same row object every frame" trick
    const packView = () => {
      const view = h.m.publicView();
      view.players = view.players.map((row) => {
        let cached = cache.get(row.playerId);
        if (!cached) { cached = { ...row, packField: { level: 0 } }; cache.set(row.playerId, cached); }
        return cached;
      });
      return view;
    };
    const prevFresh = publicBaseline(packView());     // the baseline the room is believed to hold
    const prevCached = publicBaseline(packView());    // a second baseline, built the aliasing way
    assert.equal(canonJson(prevFresh.players), canonJson(prevCached.players), 'two baselines of one unchanged view are the same snapshot');
    // was: assert.equal(cache.get('p_0') === prevCached.players[0], true, 'the baseline aliases the pack row (publicBaseline copies the array, not the rows)')
    assert.equal(cache.get('p_0') === prevCached.players[0], false, 'THE ACCEPTANCE POINT: the baseline never aliases the pack row');
    assert.equal(cache.get('p_0').packField === prevCached.players[0].packField, false, 'and nested objects are copies too (a deep copy)');
    const lpAtBaseline = prevCached.players[0].lp;
    cache.get('p_0').packField = { level: 7 };        // the pack's own field changes...
    cache.get('p_0').lp = cache.get('p_0').lp - 3;    // ...and so does an engine field in the same row
    assert.equal(prevCached.players[0].lp, lpAtBaseline, 'the in-place writes do not move the baseline (it is a snapshot)');
    assert.deepEqual(prevCached.players[0].packField, { level: 0 }, 'neither its pack fields');
    // the same instant, seen through a baseline that is NOT aliased: both changes are visible (the control)
    const prevClean = publicBaseline(h.m.publicView());
    const cur = packView();
    const resCached = publicDelta(prevCached, cur);
    const resFresh = publicDelta(prevClean, cur);
    const patchFresh = (resFresh.frame.players || []).find((p) => p.playerId === 'p_0');
    assert.ok(patchFresh, 'against a non-aliased baseline the row IS patched');
    assert.deepEqual(patchFresh.packField, { level: 7 }, 'the pack field is seen');
    assert.equal(Object.hasOwn(patchFresh, 'lp'), true, 'and so is the engine field in the same row');
    // was: isEmptyDelta(resCached.frame) === true ('THE FINDING: against the aliased baseline the frame carries nothing')
    assert.equal(isEmptyDelta(resCached.frame), false, 'the pack-cached baseline now diffs its rows like any other');
    const patchCached = (resCached.frame.players || []).find((p) => p.playerId === 'p_0');
    // was: resCached.frame.players === undefined ('not even the engine field that changed in the same row')
    assert.ok(patchCached, 'the changed row IS in the patch');
    assert.deepEqual(patchCached, { playerId: 'p_0', packField: { level: 7 }, lp: lpAtBaseline - 3 }, 'carrying exactly the two changes, as values');
    assert.deepEqual(patchCached.packField, { level: 7 }, 'the pack’s own field included');
    assert.equal(patchCached.lp, lpAtBaseline - 3, 'and the engine field, at the value the pack just wrote');
    // the client therefore learns both changes on that frame (was: it never learned either). A client sitting on the
    // room's baseline (the same aliasing shape) is the one this frame was built for.
    const clientFull = applyPublic(null, JSON.parse(JSON.stringify({ t: 'm.public', ...prevCached }))).state;
    assert.notEqual(clientFull.players.find((p) => p.playerId === 'p_0'), cache.get('p_0'), 'the client got its own rows, never the pack’s cached objects');
    const clientAfterDelta = applyPublic(clientFull, JSON.parse(JSON.stringify(resCached.frame))).state;
    const clientRow = clientAfterDelta.players.find((p) => p.playerId === 'p_0');
    assert.deepEqual(clientRow.packField, { level: 7 }, 'the pack field really arrived');
    assert.equal(clientRow.lp, lpAtBaseline - 3, 'and so did the engine field, in the same row, on the same frame');
    console.error('[aliasing] pack row cached + mutated in place → the baseline is a snapshot, the whole row still rides the diff');
  });

  test('不安全：包返回循环引用 / BigInt —— 差集抛，帧被 reportError 吞掉（既不增量也不全量）', () => {
    const cyc = () => { const o = {}; o.self = o; return o; };
    // an unknown key never reaches sameJson (not in the whitelist) — so a cycle there is silently ignored...
    const inc = publicDelta(publicBaseline({ t: 'm.public', round: 1 }), { t: 'm.public', round: 1, extra: cyc() });
    assert.equal(isEmptyDelta(inc.frame), true, 'a cyclic value in an unknown key is invisible (no throw, no frame)');
    // ...but a cycle under a WHITELISTED key (where a pack may put its own object) throws inside the differ. `draft` is
    // one of the SCALAR_KEYS and is an object at BAND_DRAFT — exactly the kind of slot a pack can reuse.
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', draft: { a: 1 } }), { t: 'm.public', draft: cyc() }), /circular/i, 'whitelisted key: sameJson → JSON.stringify throws');
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', draft: { a: 1 } }), { t: 'm.public', draft: { deep: [cyc()] } }), /circular/i, 'an array containing a cycle under the same key is the same');
    // a primitive baseline short-circuits the JSON compare (`typeof a !== 'object'`), so the value rides the patch as it
    // is — the throw only comes on the NEXT change, when the cyclic array is the baseline
    const prim = publicDelta(publicBaseline({ t: 'm.public', draft: 1 }), { t: 'm.public', draft: [cyc()] });
    assert.equal(Object.hasOwn(prim.frame, 'draft'), true, 'primitive → cyclic array is sent as-is (no compare)');
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', draft: [1] }), { t: 'm.public', draft: [cyc()] }), /circular/i, 'but array → cyclic array throws');
    assert.throws(() => publicDelta(publicBaseline({ t: 'm.public', sp: { n: 1 } }), { t: 'm.public', sp: { n: 1n } }), /BigInt/i, 'a BigInt under a whitelisted key throws the same way');
    // the same inside a player ROW (the pack adds row fields): the row diff has the same sameJson call
    assert.throws(() => publicDelta(
      publicBaseline({ t: 'm.public', players: [{ playerId: 'p_0', packField: { a: 1 } }] }),
      { t: 'm.public', players: [{ playerId: 'p_0', packField: cyc() }] },
    ), /circular/i, 'a cyclic pack row field throws too');
  });

  test('不安全：包加 Map / Set / 函数值 —— 差集认不出变化，物化后是两个不同的东西', () => {
    // under a whitelisted key, where the pack could hide its own object
    const before = { t: 'm.public', round: 1, teamLp: { m: new Map([['a', 1]]) } };
    const after = { t: 'm.public', round: 1, teamLp: { m: new Map([['b', 2]]) } };
    const same = { t: 'm.public', round: 1, teamLp: { m: new Map([['a', 1]]) } };
    assert.equal(isEmptyDelta(publicDelta(publicBaseline(before), after).frame), true, 'two different Maps compare equal through JSON ({}), so the change never rides the wire');
    assert.equal(isEmptyDelta(publicDelta(publicBaseline(same), { ...same }).frame), true, 'and two equal Maps are "no change" (as they should be)');
    assert.equal(isEmptyDelta(publicDelta(publicBaseline(before), before).frame), true, 'while the SAME Map object is caught by the identity check before the JSON compare');
    // a function value is not an own enumerable property: it never reaches the diff at all
    const r2 = publicDelta(publicBaseline({ t: 'm.public', round: 1 }), { t: 'm.public', round: 1, round2: () => 1 });
    assert.equal(Object.hasOwn(r2.frame, 'round2'), false, 'a function value never rides the patch');
    // a Set is the same story
    assert.equal(isEmptyDelta(publicDelta(publicBaseline({ t: 'm.public', teamLp: { s: new Set([1]) } }), { t: 'm.public', teamLp: { s: new Set([2]) } }).frame), true, 'a Set change is invisible too');
    // ...but plain objects / arrays of plain values are exact (the shapes every shipped pack returns)
    assert.equal(isEmptyDelta(publicDelta(publicBaseline({ t: 'm.public', teamLp: { o: 1 } }), { t: 'm.public', teamLp: { o: 2 } }).frame), false, 'a plain-object change is seen');
  });
});
