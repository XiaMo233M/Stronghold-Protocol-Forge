// test/battleOpts.test.js — ONE Battle assembly for the two paths that build a battle (B8, DESIGN §28.12.1).
//
// A Match assembles a Battle in exactly two places, and both must hand the Battle class the SAME fields:
//   * 真跑 — `MatchCombat.newBattle` (server/match/match/combat.js);
//   * 复算 — `MatchClientCombat._specBattle` (server/match/match/clientCombat.js) — the headless run, a takeover and the
//     `SP_VERIFY` re-computation of a client's result.
// The optional keys that accumulated twice (`kits`, `tokenKits`, `battleInstallers`, `bossHitLimit` — and whatever a
// sixth one will be) now live in server/match/match/battleOpts.js, and both paths call it. The A-fix (a `tokenKits`
// added to one path and not the other) is what a split assembly costs: the server re-computed a kit-carrying room
// against the built-in registry, so a correct client result was replaced and a wrong one could pass.
// `test/workshopKits.test.js` (复算与真跑) pins the RESULT of that. This file pins the single assembly both paths read:
//   1. the helper's truth table — a key appears only when the match really has it, an empty map is a no-op, and an
//      explicit per-battle option always wins (the precedence both original call sites had);
//   2. `specBattleOpts` (the 复算 note) is the same assembly plus the one deliberate per-path difference;
//   3. at COMBAT both paths are driven on a real match and their `Battle opts` are compared field by field — and each
//      path's `Battle opts` IS what the helper returned for that match.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { baseBattleOpts, battleOptsFromMatch, specBattleOpts } from '../server/match/match/battleOpts.js';
import { buildBattleSpec } from '../server/sim/spec.js';
import { Battle } from '../server/sim/Battle.js';
import { PHASE } from '../shared/constants.js';
import { loadData } from '../server/data.js';
import { makeMatch, give, legalTileFor } from './match/harness.js';

const DATA_DIR = new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** The two kit key spaces of docs/WORKSHOP.md §4.7, keyed exactly like a loaded pack. */
const KIT_ID = 'chess_ws_kitprobe_a';
const TOKEN_ID = 'token_ws_kitprobe';
const kitFn = () => ({ talents: [] });
const tokenKitFn = () => ({ skill: null });

/**
 * Player/unit entries as the two paths carry them: `buildBattleSpec` writes the DEFAULTED loadout
 * (`skillIndex: null` / `moduleId: null`, server/sim/spec.js sanitizeUnitLoadout) while the live `opts.players` of a
 * real run omits an absent one — the sim reads both as the same default (`battle/players.js:165` `?? null`), which is
 * why `test/workshopKits.test.js` compares them through the same normalization. Everything else is compared verbatim.
 */
const loadouts = (players) => (players || []).map((p) => ({
  ...p,
  units: (p.units || []).map((u) => ({ ...u, skillIndex: u.skillIndex ?? null, moduleId: u.moduleId ?? null })),
}));

/** A Match-shaped owner: only the fields the assembly reads (`Match.js` constructor). */
const owner = (over = {}) => ({
  ds: { marker: 'ds' },
  battleContent: 'generic',
  log: quiet,
  BattleClass: Battle,
  workshopKits: { [KIT_ID]: kitFn },
  workshopTokenKits: { [TOKEN_ID]: tokenKitFn },
  battleInstallers: [function installBattle() {}],
  bossHitLimit: 12345,
  ...over,
});

describe('Battle 组装：唯一一份助手 server/match/match/battleOpts.js（B8）', () => {
  test('baseBattleOpts：match 自己的 data / content / logger 在前，调用方显式传的在后（与两条原路径一致）', () => {
    const o = owner();
    assert.deepEqual(baseBattleOpts(o, { fieldId: 'n:p_0' }), { data: o.ds, content: 'generic', logger: quiet, fieldId: 'n:p_0' });
    // 显式 opts 胜出（两条原路径都是这个优先级：真跑是 `{ ...match, ...opts }`，复算只传它自己那批键）
    const explicit = { data: 'D', content: 'none', logger: null };
    const got = baseBattleOpts(o, explicit);
    assert.equal(got.data, 'D');
    assert.equal(got.content, 'none');
    assert.equal(got.logger, null);
  });

  test('有包：四个可选键都到，且是**同一个**映射 / 同一批函数（引用相等）；显式 opts.<key> 胜出', () => {
    const o = owner();
    const full = battleOptsFromMatch(o, { fieldId: 'n:p_0' });
    assert.equal(full.kits, o.workshopKits, 'kits 必须是这一局自己那一份表（引用相等，不是拷贝）');
    assert.equal(full.kits[KIT_ID], kitFn, '…并且是包的那一个函数对象');
    assert.equal(full.tokenKits, o.workshopTokenKits, '召唤物的表走第二个键空间');
    assert.equal(full.tokenKits[TOKEN_ID], tokenKitFn);
    assert.equal(full.battleInstallers, o.battleInstallers, '战斗 installers 是同一批函数（DESIGN §28.17）');
    assert.equal(full.bossHitLimit, 12345, '限伤 override（SP_BOSS_HIT_LIMIT）');
    assert.equal(full.data, o.ds);
    assert.equal(full.content, 'generic');
    assert.equal(full.logger, quiet);
    assert.equal(full.fieldId, 'n:p_0', '调用方自己的键照旧');
    // 显式传的键胜出（浏览器可以自带一张 kit 表）
    const own = { [KIT_ID]: tokenKitFn };
    const win = battleOptsFromMatch(o, { kits: own, battleInstallers: [], bossHitLimit: 7 });
    assert.equal(win.kits, own, '显式 opts.kits 胜出');
    assert.deepEqual(win.battleInstallers, [], '显式 opts.battleInstallers 胜出（空数组照样是显式的）');
    assert.equal(win.bossHitLimit, 7, '显式 opts.bossHitLimit 胜出');
  });

  test('无包：四个可选键一个都不出现（对象形状与从前逐字节相同）；空表是「有键但 no-op」的另一种写法', () => {
    const plain = battleOptsFromMatch(
      owner({ workshopKits: null, workshopTokenKits: null, battleInstallers: null, bossHitLimit: undefined }), { fieldId: 'n:p_0' });
    for (const k of ['kits', 'tokenKits', 'battleInstallers', 'bossHitLimit']) assert.equal(k in plain, false, `无包/${k} 不该出现`);
    assert.equal('fieldId' in plain, true);
    const empty = battleOptsFromMatch(
      owner({ workshopKits: {}, workshopTokenKits: {}, battleInstallers: null, bossHitLimit: undefined }), { fieldId: 'n:p_0' });
    assert.equal('kits' in empty, true, '空表照样设键（setupUnitKit 命中才读 ⇒ no-op）');
    assert.deepEqual(empty.kits, {});
    assert.deepEqual(empty.tokenKits, {});
    // 空表只能多出这两个空映射，其余字段逐字段相同
    const { kits: _k, tokenKits: _t, ...rest } = empty;
    assert.deepEqual(rest, plain);
    assert.equal('battleInstallers' in rest, false);
    assert.equal('bossHitLimit' in rest, false);
  });

  test('specBattleOpts（复算那条）：同一份助手 + 复算唯一的有意差异 recordEvents:false', () => {
    const o = owner();
    const spec = specBattleOpts(o);
    assert.equal(spec.BattleClass, o.BattleClass);
    assert.equal(spec.sharedBoss, null);
    assert.equal(specBattleOpts(o, { sharedBoss: 'POOL' }).sharedBoss, 'POOL', 'boss 场把自己的 CreditPool 交进去');
    assert.equal(spec.logger, quiet);
    assert.equal(spec.recordEvents, false, '复算不记事件（只影响事件记录，不进结果）');
    assert.equal('recordEvents' in battleOptsFromMatch(o, {}), false, '真跑那条不设 recordEvents ⇒ 引擎默认记事件');
    assert.equal(new Battle({ content: 'none' }).recordEvents, true, '引擎默认（Battle.js: opts.recordEvents !== false）');
    // 四个可选键与真跑那条走的是同一个助手 ⇒ 同源（引用相等）
    const real = battleOptsFromMatch(o, {});
    for (const k of ['data', 'content', 'logger', 'kits', 'tokenKits', 'battleInstallers', 'bossHitLimit']) {
      assert.deepEqual(spec[k], real[k], `复算与真跑共用助手的字段 ${k}`);
    }
    assert.equal(spec.kits, o.workshopKits, '复算用的是这一局自己那份表');
    assert.equal(spec.battleInstallers, o.battleInstallers);
  });
});

/**
 * A real match driven to COMBAT in client-combat mode, where BOTH paths can be driven on the same round:
 *   * 真跑 — `_normalBattle(ps)` → `newBattle(_normalOpts(ps))` → `new FakeBattle(full)`;
 *   * 复算 — `_specBattle(f.spec)` → `createBattleFromSpec(spec, ds, specBattleOpts(...))` → `new FakeBattle(opts)`.
 * `fake: true` keeps the opts comparable field by field (no DataSource / Pool objects in the constructor argument's
 * own fields beyond what both paths carry).
 */
function driveBothPaths(extra = {}, seed = 98) {
  const h = makeMatch({
    mode: 'solo', difficulty: 'FUNNY', humans: 1, seed, fake: true, clientCombat: true, clients: false, captureFrames: false,
    data: loadData(DATA_DIR, { log: quiet }), ...extra,
  });
  h.start();
  const ps = h.ps('p_0');
  const tile = legalTileFor(h.m, ps, 'chess_char_1_01_a');
  if (tile) give(h.m, ps, 'chess_char_1_01_a', 'board', tile);
  assert.ok(h.drive(() => h.m.phase === PHASE.COMBAT), `did not reach COMBAT (${h.m.phase} R${h.m.round})`);
  const f = h.m.fields.find((x) => x.spec && x.spec.kind === 'normal');
  assert.ok(f, 'COMBAT 的正常场记录');
  const realRun = h.m._normalBattle(ps);
  const recomputed = h.m._specBattle(f.spec);
  return { h, m: h.m, ps, f, realRun, recomputed };
}

describe('两条 Battle 组装路径：逐字段相同的 opts（B8 验收点）', () => {
  test('有包：真跑与复算的 Battle opts 逐字段相同，且各自就是助手的输出', () => {
    const info = { kits: { [KIT_ID]: kitFn }, tokenKits: { [TOKEN_ID]: tokenKitFn } };
    const { h, m, realRun, recomputed } = driveBothPaths({ workshopKits: info.kits, workshopTokenKits: info.tokenKits });
    const a = realRun.opts;
    const b = recomputed.opts;
    // 关键五键 + 这一场的共同输入：逐字段相同（players 经默认化归一化，见 loadouts）
    const shared = ['data', 'content', 'logger', 'seed', 'kind', 'fieldId', 'round', 'stageId', 'modeId',
      'rect', 'timeLimit', 'spawns', 'routes', 'sharedBoss', 'flags', 'enemyOverrides', 'waveId',
      'kits', 'tokenKits', 'battleInstallers', 'bossHitLimit'];
    for (const k of shared) assert.deepEqual(b[k], a[k], `两条路径 opts.${k} 必须相同`);
    assert.deepEqual(loadouts(b.players), loadouts(a.players), '两条路径 opts.players 必须相同（默认化的技能/模组）');
    // 助手的输出就是这两场战斗的构造参数：同一个映射 / 同一批函数（引用相等 —— 不是空表、不是另一份拷贝）
    assert.equal(a.kits, m.workshopKits, '真跑用的是这一局自己那份表');
    assert.equal(b.kits, m.workshopKits, '复算用的是同一份');
    assert.equal(a.kits[KIT_ID], kitFn, '…同一个 kit 函数');
    assert.equal(b.kits[KIT_ID], kitFn);
    assert.equal(a.tokenKits, m.workshopTokenKits, '第二个键空间同源');
    assert.equal(b.tokenKits, m.workshopTokenKits);
    assert.equal(a.tokenKits[TOKEN_ID], tokenKitFn);
    assert.equal(b.data, m.ds, '真跑那一场的数据源就是 match 自己的');
    assert.deepEqual(h.logs.error, []);
    m.dispose();
  });

  test('battleInstallers / bossHitLimit 都在 match 上时：两侧取到同一批函数、同一个限伤值（引用相等）', () => {
    // battleInstallers / bossHitLimit 是 Match 上的字段（构造后由部署或 lobby 设置），这里直接设上再驱动。
    // 这一场的 spec 由 buildBattleSpec 从同一批 opts 重造（`_ccField` 干的就是这件事），于是两条路径都能被驱动：
    // 真跑 `newBattle(_normalOpts(ps))`、复算 `_specBattle(spec)`。
    const info = { kits: { [KIT_ID]: kitFn }, tokenKits: { [TOKEN_ID]: tokenKitFn } };
    const installers = [function installBattle() {}];
    const { h, m } = driveBothPaths({ workshopKits: info.kits, workshopTokenKits: info.tokenKits });
    const ps = h.ps('p_0');
    m.battleInstallers = installers;
    m.bossHitLimit = 987;
    const opts = m._normalOpts(ps);
    const spec = buildBattleSpec({ ...opts, battleId: 'b.1.n:p_0', content: m.battleContent });
    assert.equal(spec.bossHitLimit, 987, '真跑这条与 spec 都要写上限伤 override');
    const a = m.newBattle(opts).opts;
    const b = m._specBattle(spec).opts;
    assert.equal(a.battleInstallers, installers, '真跑拿到 installers');
    assert.equal(b.battleInstallers, installers, 'installers 必须到复算那条（DESIGN §28.17）');
    assert.equal(a.bossHitLimit, 987, '真跑拿到限伤 override');
    assert.equal(b.bossHitLimit, 987, '限伤 override 必须到复算那条（spec 由 buildBattleSpec 写入同一个值）');
    assert.equal(a.kits, b.kits);
    assert.equal(a.tokenKits, b.tokenKits);
    m.dispose();
  });

  test('同状态：真跑（newBattle）与复算（_specBattle）除三处有意差异外逐字段相同', () => {
    const { m, realRun, recomputed } = driveBothPaths({}, 99);
    const a = realRun.opts;
    const b = recomputed.opts;
    const shared = ['seed', 'kind', 'modeId', 'round', 'stageId', 'rect', 'timeLimit', 'spawns', 'routes', 'sharedBoss',
      'flags', 'fieldId', 'enemyOverrides', 'waveId', 'content', 'data', 'logger', 'kits', 'tokenKits'];
    for (const k of shared) assert.deepEqual(b[k], a[k], `opts.${k}`);
    assert.deepEqual(loadouts(b.players), loadouts(a.players), 'opts.players（默认化归一）');
    // 有意差异逐条断言（不是无视，而是钉住）：真跑记事件、复算不记；battleId 只有 spec 那条写
    assert.equal(a.recordEvents, undefined, '真跑不设 recordEvents（引擎默认 true）');
    assert.equal(b.recordEvents, false, '复算明确关掉事件记录');
    assert.equal(a.battleId, undefined, '真跑不写 battleId');
    assert.equal(b.battleId, undefined, 'battleId 写在这场战斗对象上（createBattleFromSpec），不在 Battle opts 里');
    assert.equal(a.content, m.battleContent, '真跑取 match.battleContent');
    assert.equal(b.content, m.battleContent, '复算取 spec.content —— buildBattleSpec 写入的是同一个 match.battleContent');
    assert.equal(specBattleOpts(m, {}).content, m.battleContent, 'specBattleOpts 不覆盖 content（由 spec 决定）');
    assert.equal(a.data, m.ds);
    m.dispose();
  });

  test('没有包的一局：真跑与复算都不设那四个键，形状与从前逐字段相同', () => {
    const { h, m, realRun, recomputed } = driveBothPaths({}, 100);
    for (const k of ['kits', 'tokenKits', 'battleInstallers', 'bossHitLimit']) {
      assert.equal(k in realRun.opts, false, `真跑无包时不该有 ${k}`);
      assert.equal(k in recomputed.opts, false, `复算无包时不该有 ${k}`);
      assert.equal(k in specBattleOpts(m, {}), false, `specBattleOpts 无包时不该有 ${k}`);
    }
    const shared = ['seed', 'kind', 'modeId', 'round', 'stageId', 'rect', 'timeLimit', 'spawns', 'routes', 'sharedBoss',
      'flags', 'fieldId', 'enemyOverrides', 'waveId', 'content', 'data', 'logger'];
    for (const k of shared) assert.deepEqual(recomputed.opts[k], realRun.opts[k], `opts.${k}`);
    assert.deepEqual(loadouts(recomputed.opts.players), loadouts(realRun.opts.players), 'opts.players（默认化归一）');
    assert.deepEqual(h.logs.error, []);
    m.dispose();
  });
});
