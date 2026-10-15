// test/callBudget.test.js — 每局每插件的**调用预算**（沙箱档的运行时保护，W6；DESIGN §28.52）。
//
// 这一格补的缺口：我们只有 `combat: true` 这一道**闸门**（「这个包能不能改对局结果」），没有任何**运行时长或
// 次数上限** —— 一个 `while (true)`，或者一个每 tick 触发一次、每次又注册一批计时器的回调，能把整局拖住。上游的
// 做法是每局每插件一个次数上限（缺省 8000），耗尽即**回滚该回调**、撤掉它的计时器与标记 buff、记一笔点名到
// 插件 id 的错。
//
// 这个文件钉四条（与业主给的四条判据一一对应）：
//   ① **不声明 / 不超预算 ⇒ 一切照旧**：不声明 `pack.json.callBudget` 的包，归一化清单里**不长出这个键**，
//      内容哈希与这一刀之前**逐字同一个字面量**（下面 `LEGACY_PACK_HASH` —— 这是「没打破今天」的证明，不是
//      一句承诺）；装载器交出来的 installer / module 上也**没有** `callBudget` 这个键。
//   ② **超预算 ⇒ 该回调被回滚**：它的 hook 不再被调用、它排的计时器从 `battle._sched` 上消失、它标的 buff 从
//      全场单位上撤掉、`battle.errors` 里出现一条 `plugin:<包id>` 的错。
//   ③ **两端同规则、只有一份实现**：预算在**装载期**由 `server/battlePack.js` 解析一次，同一个数字同时上
//      `installers[]`（服务端真函数）与 `modules[]`（送到浏览器的那份 URL 清单）；两条路各自喂给**同一个**
//      `BattleHooks`，在**同一个计数**上回滚。计数与回滚的那份代码里**不许有任何端特有分支**（这一条本文件
//      用源码反射钉死：`isBrowser` / `typeof window` / `process.` / `globalThis` 一个都不许出现）。
//   ④ **探测不进建房路径**：判决「这个包用不用得上预算」发生在**装载期**（`loadBattleInstallers`，房间还不
//      存在时 installer 上就已经有生效值），`server/lobby.js` 里出现 `callBudget` 三个字就是错的。
//
// 判据跟代码一起搬：这个文件先红后绿（红的那次输出贴在交付说明里）。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PACK_CALL_BUDGET_DEFAULT, CALL_BUDGET_FIELDS, CALL_BUDGET_BAD_SHAPE, CALL_BUDGET_BAD_MAX,
  CALL_BUDGET_TOO_HIGH, CALL_BUDGET_UNKNOWN_FIELD, callBudgetOwner, packCallAllowed, parseCallBudgetDecl,
} from '../shared/callBudget.js';
import { normalizePackManifest } from '../shared/workshop.js';
import { stripComments } from '../shared/kitAuthoring.js';
import { loadWorkshop } from '../server/workshop.js';
import { loadBattleInstallers } from '../server/battlePack.js';
import { loadSpecBattleInstallers } from '../public/js/battle/runner.js';
import { makeBattle, chessRec } from './helpers/battleHarness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这一刀**之前**就存在的那个包（`pack.json` 里没有 `callBudget`）的内容哈希，改动前跑出来贴在这里的字面量。
 * 它红了就是「没打破今天」这句话被打破：归一化清单里多长了一个键、或哈希输入变了。
 */
const LEGACY_PACK_HASH = 'a947f26c0fc15b324faf803fde16ac6b194d13cbf9db63a2a5a208e9413472a0';

/**
 * 一段最小的战斗逻辑模块：注册一个 `tick` hook 与一个 `every` 计时器，两个都把调用次数记在 `battle` 上，并在
 * 安装那一刻给每个友军单位标一个 buff。
 *
 * 为什么记在 `battle` 上而不是模块自己的变量里：`install(battle)` 每次装载都会跑一遍，模块级变量会在两次战斗
 * 之间串味 —— 而这个文件要断言的正是「这一场里被调了几次」。
 */
const BUDGET_MODULE = `
export function install(battle) {
  const bump = () => { battle.__testCalls = (battle.__testCalls || 0) + 1; };
  battle.on('tick', bump);
  battle.every(0.05, bump);
  for (const u of battle.allyUnits) battle.addBuff(u, { key: 'cb:test', duration: 999, mods: { atkFlat: 1 } });
}
`;

/** 一个最小包：一段战斗逻辑 + 可选的 `pack.json.callBudget`。 */
function writePack(root, id, { callBudget, module = 'battle/main.mjs', source = BUDGET_MODULE } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, path.dirname(module)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
    combat: true, content: ['bonds'], server: { battle: { module } },
    ...(callBudget === undefined ? {} : { callBudget }),
  }));
  fs.writeFileSync(path.join(dir, 'bonds.json'), JSON.stringify({
    victoriaShip: { id: 'victoriaShip', name: 'x', desc: '', members: [], count: [1], tier: [1], buffs: [] },
  }));
  fs.writeFileSync(path.join(dir, module), source);
  return dir;
}

function tmpRoot(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `sp-callbudget-${tag}-`)); }

/** 一个能被 installer 跑起来的真战场：一名友军干员，足够跑几十个 tick。 */
function makeBudgetBattle(installers, { seconds = 2 } = {}) {
  const h = makeBattle({
    units: [{ chessId: 'chess_char_1_01_a', row: 10, col: 5 }],
    defs: { chess: { chess_char_1_01_a: chessRec({ chessId: 'chess_char_1_01_a' }) } },
    timeLimit: seconds, autoFinish: false, seed: 11, flags: { dpPerSec: 0, dpMax: 999 },
    battleInstallers: installers,
  });
  return h;
}

// ---------------------------------------------------------------------------------------------------
// 一、形状与常量：**只有一份**实现、**只有一个**缺省值
// ---------------------------------------------------------------------------------------------------
describe('调用预算：形状与常量', () => {
  test('缺省就是上游那个 8000，且只有这一份常量', () => {
    assert.equal(PACK_CALL_BUDGET_DEFAULT, 8000, '缺省预算必须与上游同一口径（每局每插件 8000 次）');
    assert.deepEqual([...CALL_BUDGET_FIELDS], ['max'], '这一格的键是闭集，今天只有 max');
    // 「只有一份常量」的判据：声明层与运行层读的是同一个符号，而不是两处各写一次 8000。注释里当然可以写这个
    // 数字（那是解释），所以先去掉注释再数 —— 判的是**代码里的字面量**只有一处。
    const declSrc = stripComments(fs.readFileSync(path.join(ROOT, 'shared/callBudget.js'), 'utf8'));
    assert.equal((declSrc.match(/\b8000\b/g) || []).length, 1,
      'shared/callBudget.js 的**代码**里 8000 只许出现一次（第二处就是第二份真相；文案里要用 ${PACK_CALL_BUDGET_DEFAULT}）');
    const hooksSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server/sim/battle/hooks.js'), 'utf8'));
    assert.ok(!/\b8000\b/.test(hooksSrc),
      '运行层的代码里不许自己写一个 8000：它必须读共享常量（否则改一处、漏一处就是两端分叉）');
  });

  test('声明：缺省 max、只许调低、闭集与形状都点名拒', () => {
    assert.deepEqual(parseCallBudgetDecl({}), { ok: true, decl: { max: PACK_CALL_BUDGET_DEFAULT } },
      '写了这一格但没写 max ⇒ 用缺省 8000');
    assert.deepEqual(parseCallBudgetDecl({ max: 12 }), { ok: true, decl: { max: 12 } }, '可以调低');
    assert.equal(parseCallBudgetDecl({ max: PACK_CALL_BUDGET_DEFAULT }).ok, true, '等于缺省也收（写清楚是允许的）');

    assert.equal(parseCallBudgetDecl(true).error, CALL_BUDGET_BAD_SHAPE, '不是一个对象 ⇒ 点名');
    assert.equal(parseCallBudgetDecl({ max: 3, minCalls: 1 }).error, CALL_BUDGET_UNKNOWN_FIELD, '闭集外的键 ⇒ 点名');
    assert.equal(parseCallBudgetDecl({ max: 0 }).error, CALL_BUDGET_BAD_MAX, '0 不是一个预算');
    assert.equal(parseCallBudgetDecl({ max: 2.5 }).error, CALL_BUDGET_BAD_MAX, '非整数 ⇒ 点名');
    assert.equal(parseCallBudgetDecl({ max: '8000' }).error, CALL_BUDGET_BAD_MAX, '字符串不是数字（真值表放行 = 静默失效）');
    // **只许收不许放**：预算二字就是这个意思 —— 一个能把上限调高的声明等于没有上限。
    const high = parseCallBudgetDecl({ max: PACK_CALL_BUDGET_DEFAULT + 1 });
    assert.equal(high.error, CALL_BUDGET_TOO_HIGH, '调高必须点名拒绝');
    assert.match(high.detail, /tighten|lower|never raise|只能收紧/i, '拒绝文案必须说清「预算只能收紧、不能放宽」');
  });

  test('被判据钉住的记账规则：只有一份，纯函数', () => {
    assert.equal(packCallAllowed(0, 8000), true);
    assert.equal(packCallAllowed(7999, 8000), true, '第 8000 次仍然放行');
    assert.equal(packCallAllowed(8000, 8000), false, '第 8001 次不放行 —— 8000 次是「可用次数」，不是「第 8000 次就砍」');
    assert.equal(callBudgetOwner('my-pack'), 'plugin:my-pack', '错要记在点名到插件 id 的那一格上');
  });
});

// ---------------------------------------------------------------------------------------------------
// 二、判据①：不声明 ⇒ 逐字节等于今天
// ---------------------------------------------------------------------------------------------------
describe('判据①：不声明预算的包，一切照旧', () => {
  let tmp = null;
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('归一化清单里不长出这个键，内容哈希仍是一刀之前那个字面量', () => {
    tmp = tmpRoot('legacy');
    // 这一段模块源码与改动**前**跑基线时用的**逐字相同** —— 不然比出来的差异就不是「这一刀有没有动哈希」，
    // 而是「夹具换了」。基线输出的 hash 见交付说明。
    writePack(tmp, 'battle-pack', { source: 'export function install() { return undefined; }\n' });
    const loaded = loadWorkshop(tmp, { log: quiet });
    assert.deepEqual(loaded.errors, [], '夹具本身必须是一个能装的包');
    assert.deepEqual(loaded.packs.map((p) => p.id), ['battle-pack']);
    assert.equal(Object.hasOwn(loaded.packs[0], 'callBudget'), false,
      '没写的包，归一化清单里不许长出 callBudget（长了 ⇒ 所有已发布包哈希全变）');
    assert.equal(loaded.packs[0].hash, LEGACY_PACK_HASH,
      '不声明 callBudget 的包，内容哈希必须与这一刀之前逐字相同（这就是「没打破今天」）');
    // 反向：声明过就**必须**进哈希 —— 两份只差预算的包是两种行为，共用一个摘要会让房间闸门放行两种玩法。
    const other = tmpRoot('declared');
    try {
      writePack(other, 'battle-pack', { callBudget: { max: 4 } });
      const l2 = loadWorkshop(other, { log: quiet });
      assert.deepEqual(l2.errors, []);
      assert.deepEqual(l2.packs[0].callBudget, { max: 4 }, '声明过就必须进归一化清单');
      assert.notEqual(l2.packs[0].hash, LEGACY_PACK_HASH, '声明了预算的包必须换一个内容哈希');
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  test('装载器交出来的 installer / module 上没有这个键', async () => {
    tmp = tmpRoot('legacy-wire');
    writePack(tmp, 'battle-pack', { source: 'export function install() { return undefined; }\n' });
    const r = await loadBattleInstallers(loadWorkshop(tmp, { log: quiet }), { log: quiet });
    assert.deepEqual(r.errors, []);
    assert.equal(r.installers.length, 1);
    assert.equal(Object.hasOwn(r.installers[0], 'callBudget'), false, '没声明 ⇒ 服务端 installer 不长这个键');
    assert.equal(Object.hasOwn(r.modules[0], 'callBudget'), false, '没声明 ⇒ 送到浏览器的清单也不长这个键');
  });

  test('没声明 ⇒ 回调照跑，没有任何回滚', () => {
    tmp = tmpRoot('legacy-run');
    writePack(tmp, 'battle-pack');
    const h = makeBudgetBattle([{ id: 'battle-pack', install: (b) => {
      const bump = () => { b.__testCalls = (b.__testCalls || 0) + 1; };
      b.on('tick', bump);
    } }]);
    h.run(1);
    assert.ok(h.battle.__testCalls >= 25, `没声明预算的包必须照常被调（1 秒 = 30 个 tick，实际 ${h.battle.__testCalls} 次）`);
    assert.equal(h.battle.errors.filter((e) => String(e.label).startsWith('plugin:')).length, 0,
      '没声明预算就永远不记 plugin: 错');
  });
});

// ---------------------------------------------------------------------------------------------------
// 三、判据②：超预算 ⇒ 回滚该回调 + 撤计时器 + 撤标记 buff + 点名错
// ---------------------------------------------------------------------------------------------------
describe('判据②：超预算 ⇒ 回滚', () => {
  let root = null;
  before(() => {
    root = tmpRoot('over');
    writePack(root, 'greedy-pack', { callBudget: { max: 3 } });
  });
  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('生效值上到 installer 与 module（装载期一次，房间还不存在）', async () => {
    const r = await loadBattleInstallers(loadWorkshop(root, { log: quiet }), { log: quiet });
    assert.deepEqual(r.errors, []);
    assert.equal(r.installers[0].callBudget, 3, '服务端 installer 带生效预算');
    assert.equal(r.modules[0].callBudget, 3, '送到浏览器的那份也必须带同一个数字');
    assert.equal(r.modules[0].id, 'greedy-pack');
  });

  test('回滚：hook 不再被调、计时器被撤、标记 buff 被撤、记一笔 plugin:<id>', () => {
    const h = makeBudgetBattle([{ id: 'greedy-pack', callBudget: 3, install: (b) => {
      const bump = () => { b.__testCalls = (b.__testCalls || 0) + 1; };
      // buff 只能挂在**活着的**单位上（`addBuff` 对 `!alive && !allowDead` 直接返回 null），而装机那一刻
      // 干员还没部署 —— 所以标记挂在第一个 tick 里做（那时它已经在场，而且这个回调本身也在包作用域里）。
      b.on('tick', () => {
        for (const u of b.allyUnits) if (u.alive && !u.findBuff('cb:test')) b.addBuff(u, { key: 'cb:test', duration: 999, mods: { atkFlat: 1 } });
        bump();
      });
      b.every(0.05, bump);
    } }], { seconds: 3 });
    const b = h.battle;
    const unit = h.allies()[0] ?? b.allyUnits[0];
    assert.ok(unit, '夹具必须有一个友军单位');
    // 第一个 tick 里那个包把 buff 标上（并花掉第 1 次预算），此刻还没到顶。
    h.step(1);
    assert.ok(unit.findBuff('cb:test'), '包标上的 buff 必须在场（预算还没用光）');

    h.run(1.5);
    assert.equal(b.__testCalls, 3, `预算 3 就只许被调 3 次（实际 ${b.__testCalls}）`);
    assert.equal(b._sched.filter((s) => s.pack === 'greedy-pack' && !s.cancelled).length, 0,
      '回滚必须撤掉它排的计时器（一个还在响的计时器就是一个还在跑的回调）');
    assert.equal(unit.findBuff('cb:test'), null, '回滚必须撤掉它标的 buff（标记 buff 是「这个包加上去的」）');
    const err = b.errors.find((e) => e.label === 'plugin:greedy-pack');
    assert.ok(err, `回滚必须记一笔点名到插件 id 的错，实际：${JSON.stringify(b.errors.map((e) => e.label))}`);
    assert.match(String(err.message), /budget/i, '错误文案要说清是预算耗尽');
    // 再跑一段：确实不再被调（否则「预算」只是一句日志）。
    const seen = b.__testCalls;
    h.run(1);
    assert.equal(b.__testCalls, seen, '回滚之后它的回调一次都不许再被调');
  });
});

// ---------------------------------------------------------------------------------------------------
// 四、判据③：两端同规则、只有一份实现
// ---------------------------------------------------------------------------------------------------
describe('判据③：服务端与浏览器同规则', () => {
  let root = null;
  before(() => {
    root = tmpRoot('both');
    writePack(root, 'greedy-pack', { callBudget: { max: 5 } });
  });
  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('同一个数字走两条路，在同一个计数上回滚', async () => {
    const r = await loadBattleInstallers(loadWorkshop(root, { log: quiet }), { log: quiet });
    assert.deepEqual(r.errors, []);
    const srv = r.installers[0];

    // 浏览器那一半：**真的**跑 `public/js/battle/runner.js` 的 `loadSpecBattleInstallers`，只把它的
    // `import(url)` 换成「按 URL 找到那个包里的真文件」（与 `server/battlePack.js` 的 `importModule`
    // 注入点是同一个形状 —— 两端唯一的差别就是「谁去 import」，预算不在这条差别里）。
    const specInstaller = await loadSpecBattleInstallers({ workshopBattle: r.modules }, {
      importModule: (url) => {
        const rel = url.replace(/^\/workshop-battle\//, '').split('?')[0];
        return import(pathToFileURL(path.join(root, decodeURIComponent(rel))).href);
      },
    });
    assert.equal(specInstaller.length, 1, '浏览器那条路必须真的加载出那个 installer');
    assert.equal(specInstaller[0].callBudget, srv.callBudget, '两端必须拿到同一个生效预算');
    assert.equal(srv.callBudget, 5);

    const run = (installers) => {
      const h = makeBudgetBattle(installers, { seconds: 3 });
      h.run(2);
      return h.battle;
    };
    const bs = run([srv]);
    const bc = run(specInstaller);
    assert.equal(bs.__testCalls, 5, `服务端必须在预算上停（实际 ${bs.__testCalls}）`);
    assert.equal(bc.__testCalls, 5, `浏览器那条路必须在**同一个**计数上停（实际 ${bc.__testCalls}）`);
    assert.equal(bs.__testCalls, bc.__testCalls, '两端在同一次调用上回滚 —— 不同就是状态分叉');
    assert.ok(bs.errors.some((e) => e.label === 'plugin:greedy-pack'), '服务端记了');
    assert.ok(bc.errors.some((e) => e.label === 'plugin:greedy-pack'), '浏览器那条路也记了');
  });

  test('预算这条路径里没有端特有分支（源码级）', () => {
    // 两端跑的是同一份 `server/sim` 字节。任何 `typeof window` / `process.` 之类的分支都会让「同一份摘要 ⇒
    // 同一份行为」在**计数**这一层破功：两端在**不同次数**上回滚，之后的状态就分叉了。
    // 扫的是**去掉注释**之后的源码（`shared/kitAuthoring.js` 的那个扫描器，引擎到处在用同一份）—— 上面那些
    // 注释正是为了说清这条规矩，让它们把判据自己判红是判据的毛病，不是代码的毛病。
    const files = ['shared/callBudget.js', 'server/sim/battle/hooks.js'];
    const banned = [/\bwindow\b/, /\bdocument\b/, /\bnavigator\b/, /\bprocess\s*\./, /\bglobalThis\b/, /\brequire\s*\(/, /\bisBrowser\b/, /\bself\s*\./];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const re of banned) {
        assert.ok(!re.test(src), `${f} 里出现了端特有分支 ${re}：预算的计数与回滚只能有一份实现`);
      }
    }
  });

  test('客户端那条路也必须把预算带走（漏了就等于浏览器用另一个上限）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/battle/runner.js'), 'utf8');
    assert.match(src, /callBudget/, 'runner.js 的 loadSpecBattleInstallers 必须把 spec 上的预算带进 installer');
  });
});

// ---------------------------------------------------------------------------------------------------
// 五、判据④：探测不在建房路径上
// ---------------------------------------------------------------------------------------------------
describe('判据④：判决在装载期，建房期不判', () => {
  test('server/lobby.js 里没有预算这件事（建房路径不许有探测）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lobby.js'), 'utf8');
    assert.ok(!/callBudget/.test(src),
      'server/lobby.js 里出现了 callBudget：判决必须发生在装载期（loadBattleInstallers），不许塞进 room.create / 房间建立流程');
  });

  test('判决发生在装载期：房间还不存在时 installer 上就已经有生效值', async () => {
    const tmp = tmpRoot('loadtime');
    try {
      writePack(tmp, 'greedy-pack', { callBudget: { max: 7 } });
      const r = await loadBattleInstallers(loadWorkshop(tmp, { log: quiet }), { log: quiet });
      assert.deepEqual(r.errors, []);
      assert.equal(r.installers[0].callBudget, 7, '装载期一次解析完成');
      const src = fs.readFileSync(path.join(ROOT, 'server/battlePack.js'), 'utf8');
      assert.match(src, /callBudget/, '判决点（装载器）必须自己就是那个读它的地方');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('归一化那一层就是形状判据的唯一一份：声明层与运行层读同一个解析器', () => {
    const ok = normalizePackManifest({ id: 'p', name: 'p', content: ['bonds'], callBudget: { max: 9 } }, 'p', {});
    assert.equal(ok.ok, true, `夹具本身要合法：${JSON.stringify(ok)}`);
    assert.deepEqual(ok.pack.callBudget, { max: 9 });
    const bad = normalizePackManifest({ id: 'p', name: 'p', content: ['bonds'], callBudget: { max: 9001 } }, 'p', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.error, CALL_BUDGET_TOO_HIGH, '形状层必须用同一份解析器的同一个码');
    // 「不是贡献项」也要有判据：只带 `callBudget` 的包照旧 EMPTY_PACK（与 variants / behaviour 同一条）。
    const empty = normalizePackManifest({ id: 'p', name: 'p', callBudget: { max: 9 } }, 'p', {});
    assert.equal(empty.error, 'EMPTY_PACK', '只声明预算的包什么都没带来，照旧是空包');
    assert.match(empty.detail, /"callBudget"/, '空包文案必须点名它，否则作者只能对着 EMPTY_PACK 猜');
  });
});
