// test/playtestDirectToHand.test.js — 「试玩时直接发到手上」这个开关从**记录**搬到**行为层**（`pack.json.playtest`）。
//
// 缺口（有取证）：开关今天写在 chess 记录里（`deriveChessRecord` 的 `directToHand`），而覆盖模式下记录必须与官方
// **同形**（`test/overrideMode.test.js` 钉着 44 字段不许变 46），于是 `editor/server.mjs` 的 `stripEditorOnlyKeys`
// 在写补丁之前把它摘掉 ⇒ 覆盖一条官方干员时这个开关**静默失效**。包存的是记录，没有第二个地方能记住它。
//
// 选定口径（本文件逐条钉住）：
//   ① 新增 `pack.json.playtest.directToHand`（行为层声明，不进记录）；名单元素必须是**本包自己的** chess 记录 id，
//      或（覆盖模式）本包在 `overrides` 里声明过的官方 id —— 不认识的 id 拒绝并**点名**（`PLAYTEST_UNKNOWN_CHESS`），
//      形状错拒绝并点名（`PLAYTEST_BAD_SHAPE`）。静默无效正是这个缺口的老毛病。
//   ② 两个包声明同一个 id 时沿用 §1.2 的谁赢规则：包 id 字典序最小者赢，输的一方拿到点名报告；与传入顺序无关。
//   ③ 试玩发牌名单 = 记录里自带 `directToHand: true` 的 ∪ `pack.json` 声明的。**正式服务器一个都不发**（不变量）。
//   ④ 传递路径照 `SP_STAGE`：编辑器算名单 → `SP_DIRECT_TO_HAND` → `phases.js` 读它。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, playtestUnknownIds, workshopPlaytestIndex, applyWorkshop } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { directToHandIds } from '../server/match/match/phases.js';
import { createEditorServer } from '../editor/server.mjs';
import { createPlaytest } from '../editor/playtest.mjs';
import { loadData } from '../server/data.js';
import { readPackMeta, writePackPlaytest, readPackSupport } from '../tools/workshop-pack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 官方那一条（覆盖的对象）：`data/chess.json` 里真实存在的一对。 */
const OFFICIAL = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));
const OFFICIAL_BASE_ID = 'chess_char_1_01_a';
const OFFICIAL_GOLD_ID = 'chess_char_1_01_b';

/** 一个 GameData 的替身：`directToHandIds` 只读这两个东西（`visibleChess` 与 `chess(id)`）。 */
const fakeGd = (records, visible = Object.keys(records)) => ({
  visibleChess: [...visible],
  chess: (id) => records[id],
});

/**
 * 一个「注入过的官方 data 目录」：只带 chess.json（照原样拷贝），**没有 assets.json**。
 *
 * 为什么注入：编辑器会把「没有模型」判成阻断性错误（`assetSpineIssues`，`NO_MODEL`），而这台机器上装了模型清单
 * 时，一条只有数值的新干员会被拒。这份测试要验的是**开关的落点**，不是外观，所以用与
 * `test/overrideMode.test.js` 同样的手法给一个没有清单的 data 目录（清单缺失时编辑器不判定，见那里的注释）。
 */
function injectedDataDir(tmp) {
  const dir = join(tmp, 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(join(DATA_DIR, 'chess.json'), join(dir, 'chess.json'));
  for (const f of ['enemies.json', 'tokens.json', 'backups.json']) {
    const src = join(DATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, join(dir, f));
  }
  return dir;
}

// ---- ① 纯函数：名单的收集与不变量 ---------------------------------------------------------------------------------

describe('试玩直接发牌: directToHandIds 纯函数', () => {
  const records = {
    chess_ws_marked_a: { directToHand: true, visible: true, tier: 1 },
    chess_ws_env_a: { visible: true, tier: 2 },
    chess_ws_plain_a: { visible: true, tier: 3 },
    chess_ws_marked_b: { directToHand: true, isGolden: true, visible: true, tier: 1 },
  };
  const gd = fakeGd(records, ['chess_ws_marked_a', 'chess_ws_env_a', 'chess_ws_plain_a', 'chess_ws_marked_b']);

  test('不变量：SP_PLAYTEST 不是 1 ⇒ 一个都不发（正式服务器）', () => {
    // 这条是整套开关的地基：正式对局即使装了一个声明了开关的包，也不会有任何东西被塞进手牌
    for (const env of [{}, { SP_PLAYTEST: '' }, { SP_PLAYTEST: '0' }, { SP_PLAYTEST: 'true' }, { SP_PLAYTEST: '1 ' }]) {
      assert.deepEqual(directToHandIds(gd, { ...env, SP_DIRECT_TO_HAND: 'chess_ws_env_a' }), [],
        `${JSON.stringify(env)} 下不许发牌（SP_PLAYTEST 必须严格等于 "1"）`);
    }
  });

  test('SP_PLAYTEST=1 + 记录标了 ⇒ 含该 id（向后兼容，今天的写法）', () => {
    assert.deepEqual(directToHandIds(gd, { SP_PLAYTEST: '1' }), ['chess_ws_marked_a'],
      '精锐那条（isGolden）被排除，普通那条留下');
  });

  test('SP_PLAYTEST=1 + 环境变量名单（覆盖模式那条路）⇒ 含该 id', () => {
    const only = fakeGd({ chess_ws_env_a: {}, chess_ws_plain_a: {} }, ['chess_ws_env_a', 'chess_ws_plain_a']);
    assert.deepEqual(directToHandIds(only, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'chess_ws_env_a' }), ['chess_ws_env_a'],
      '记录里没有标记时，名单完全由环境变量决定');
    assert.deepEqual(directToHandIds(only, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'chess_ws_env_a,chess_ws_plain_a' }).sort(),
      ['chess_ws_env_a', 'chess_ws_plain_a']);
  });

  test('两个来源是并集：记录里标过的那条不会被环境变量名单挤掉', () => {
    assert.deepEqual(directToHandIds(gd, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'chess_ws_env_a' }).sort(),
      ['chess_ws_env_a', 'chess_ws_marked_a']);
  });

  test('记录标记 ∪ 环境变量名单 = 并集（两个来源同时命中）', () => {
    const both = fakeGd({ chess_ws_a_a: { directToHand: true }, chess_ws_b_a: {} }, ['chess_ws_a_a', 'chess_ws_b_a']);
    assert.deepEqual(directToHandIds(both, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'chess_ws_b_a' }), ['chess_ws_a_a', 'chess_ws_b_a']);
  });

  test('isGolden 被排除（两条来源都是）', () => {
    const g = fakeGd({ chess_ws_g_b: { isGolden: true }, chess_ws_e_b: { isGolden: true } }, ['chess_ws_g_b', 'chess_ws_e_b']);
    assert.deepEqual(directToHandIds(g, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'chess_ws_e_b' }), []);
  });

  test('名单里的 id 不在 visibleChess 里 ⇒ 不出现在结果里，也不抛', () => {
    const only = fakeGd({ chess_ws_known_a: {} }, ['chess_ws_known_a']);
    const env = { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'chess_ws_known_a,chess_ws_不存在,chess_char_9_99_a' };
    assert.deepEqual(directToHandIds(only, env), ['chess_ws_known_a'], '坏 id 只是不出现在结果里（声明侧才该拦它）');
    // 全都不认识：空数组，不抛
    assert.deepEqual(directToHandIds(only, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: 'nope' }), []);
    // 没有 visibleChess（坏数据）也不抛
    assert.deepEqual(directToHandIds({}, { SP_PLAYTEST: '1' }), []);
  });

  test('环境变量名单的空格与空段被忽略', () => {
    const only = fakeGd({ chess_ws_env_a: {} }, ['chess_ws_env_a']);
    assert.deepEqual(directToHandIds(only, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: ' chess_ws_env_a , ,' }), ['chess_ws_env_a']);
    assert.deepEqual(directToHandIds(only, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: '' }), []);
  });
});

// ---- ② pack.json.playtest 的形状与成员资格 ------------------------------------------------------------------------

describe('试玩直接发牌: pack.json.playtest 的形状', () => {
  const norm = (extra) => normalizePackManifest({ id: 'p', content: ['chess'], ...extra }, 'p', {});

  test('合法声明通过，去重且排序（清单的字节不许取决于作者怎么写）', () => {
    const r = norm({ playtest: { directToHand: ['b', 'a', 'b'] } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.playtest.directToHand, ['a', 'b']);
  });

  test('缺省 ⇒ 空名单（不是 undefined）', () => {
    assert.deepEqual(norm({}).pack.playtest.directToHand, []);
    assert.deepEqual(norm({ playtest: {} }).pack.playtest.directToHand, []);
  });

  test('PLAYTEST_BAD_SHAPE：不是对象、值不是字符串数组、元素不是合法 id', () => {
    const cases = [
      [{ playtest: ['a'] }, 'playtest 本身不是对象'],
      [{ playtest: 'directToHand' }, 'playtest 是字符串'],
      [{ playtest: { directToHand: 'chess_ws_a' } }, '值是字符串而不是数组'],
      [{ playtest: { directToHand: { a: true } } }, '值是对象'],
      [{ playtest: { directToHand: ['chess_ws_a', 42] } }, '元素里有数字'],
      [{ playtest: { directToHand: ['../evil'] } }, '元素里有路径穿越'],
      [{ playtest: { directToHand: [''] } }, '元素是空串'],
    ];
    for (const [extra, why] of cases) {
      const r = norm(extra);
      assert.equal(r.ok, false, `${why} 必须被拒`);
      assert.equal(r.error, 'PLAYTEST_BAD_SHAPE', why);
    }
  });

  test('playtest 不是「贡献项」：只有它、没有内容文件与素材的包照旧被 EMPTY_PACK 拒', () => {
    const r = normalizePackManifest({ id: 'p', content: [], playtest: { directToHand: ['a'] } }, 'p', {});
    assert.equal(r.error, 'EMPTY_PACK');
  });
});

describe('试玩直接发牌: 名单必须点名本包真的有的 id（PLAYTEST_UNKNOWN_CHESS）', () => {
  test('playtestUnknownIds 只认本包记录 id 与 overrides 声明过的官方 id', () => {
    const own = ['chess_ws_mine_a'];
    const overrides = [`chess:${OFFICIAL_BASE_ID}`];
    assert.deepEqual(playtestUnknownIds(own, overrides, own), []);
    assert.deepEqual(playtestUnknownIds([OFFICIAL_BASE_ID], overrides, own), []);
    assert.deepEqual(playtestUnknownIds([OFFICIAL_GOLD_ID], overrides, own), [OFFICIAL_GOLD_ID],
      '没声明过的官方 id 也算不认识（声明是一对一对补的，精锐那条也要在）');
    assert.deepEqual(playtestUnknownIds(['nope'], [], own), ['nope']);
    assert.deepEqual(playtestUnknownIds(['nope', 'nope'], [], own), ['nope'], '去重');
  });

  test('加载器：声明了不认识的 id ⇒ 整包被拒，报告点名那个 id', () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-unknown-'));
    try {
      const dir = join(tmp, 'p');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
        id: 'p', content: ['chess'], playtest: { directToHand: ['chess_ws_missing_a'] },
      }));
      fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({ chess_ws_mine_a: { chessId: 'chess_ws_mine_a', tier: 1 } }));
      const loaded = loadWorkshop(tmp, { log: quiet });
      assert.equal(loaded.packs.length, 0, '名单里有不认识的 id 的包不许被加载');
      assert.equal(loaded.errors.length, 1);
      assert.match(loaded.errors[0].reason, /PLAYTEST_UNKNOWN_CHESS/);
      assert.match(loaded.errors[0].reason, /chess_ws_missing_a/, '报告必须点名那个 id —— 静默无效正是这个缺口的老毛病');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('加载器：本包自己的记录 id 与声明过的官方 id 都放行', () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-ok-'));
    try {
      const dir = join(tmp, 'p');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
        id: 'p', content: ['chess'], overrides: [`chess:${OFFICIAL_BASE_ID}`],
        playtest: { directToHand: ['chess_ws_mine_a', OFFICIAL_BASE_ID] },
      }));
      fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({
        chess_ws_mine_a: { chessId: 'chess_ws_mine_a', tier: 1 },
        [OFFICIAL_BASE_ID]: { stats: { atk: 1 } },
      }));
      const loaded = loadWorkshop(tmp, { log: quiet });
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.packs.length, 1);
      assert.deepEqual(loaded.packs[0].playtest.directToHand, ['chess_ws_mine_a', OFFICIAL_BASE_ID].sort());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- ③ 谁赢：包 id 字典序最小者，与传入顺序无关 --------------------------------------------------------------------

describe('试玩直接发牌: 两个包撞同一个 id（谁赢）', () => {
  const packOf = (id, ids) => ({ id, playtest: { directToHand: ids } });

  test('最小的包 id 赢，输的一方拿到点名报告（definedBy）', () => {
    const { ids, errors } = workshopPlaytestIndex([packOf('zeta', ['chess_ws_tie_a']), packOf('alpha', ['chess_ws_tie_a'])]);
    assert.deepEqual(ids, ['chess_ws_tie_a'], '名单里只出现一次');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].pack, 'zeta');
    assert.equal(errors[0].definedBy, 'alpha');
    assert.equal(errors[0].code, 'PLAYTEST_ID_COLLISION');
    assert.match(errors[0].reason, /pack "alpha"/);
  });

  test('与传入顺序无关：倒过来是同一份名单、同一条报告', () => {
    const a = workshopPlaytestIndex([packOf('zeta', ['x']), packOf('alpha', ['x'])]);
    const b = workshopPlaytestIndex([packOf('alpha', ['x']), packOf('zeta', ['x'])]);
    assert.deepEqual(a.ids, b.ids);
    assert.deepEqual(a.errors, b.errors);
  });

  test('同一个包重复声明同一个 id 不算撞车（自己跟自己）', () => {
    const { ids, errors } = workshopPlaytestIndex([packOf('alpha', ['x', 'x'])]);
    assert.deepEqual(ids, ['x']);
    assert.deepEqual(errors, []);
  });

  test('applyWorkshop 把撞车报告出来（与其它面同一条规则）', () => {
    const { report } = applyWorkshop({ chess: {} }, [
      packOf('zeta', ['x']), packOf('alpha', ['x']),
    ]);
    const hit = report.errors.filter((e) => e.code === 'PLAYTEST_ID_COLLISION');
    assert.equal(hit.length, 1, JSON.stringify(report.errors));
    assert.equal(hit[0].pack, 'zeta');
    assert.equal(hit[0].definedBy, 'alpha');
  });
});

// ---- ④ 端到端：编辑器算名单 → SP_DIRECT_TO_HAND → 试玩服务器里的记录仍与官方同形 --------------------------------

describe('试玩直接发牌: 编辑器 → 环境变量 → 试玩服务器', () => {
  let tmp;
  let ws;
  let dataDir;
  let editor;
  /** 假 playtest：只记下编辑器交给 start() 的名单（真的子进程见下面那个用例）。 */
  let started = null;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-flag-'));
    ws = join(tmp, 'workshop');
    dataDir = injectedDataDir(tmp);
    // 一个**覆盖官方干员**的包：记录里只写一个数值补丁（与官方同形），开关只能落在 pack.json 的行为层
    const dir = join(ws, 'ovr-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
      id: 'ovr-pack', name: '覆盖包', version: '1.0.0', content: ['chess'],
      overrides: [`chess:${OFFICIAL_BASE_ID}`, `chess:${OFFICIAL_GOLD_ID}`],
      playtest: { directToHand: [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID] },
    }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({
      [OFFICIAL_BASE_ID]: { stats: { atk: 1 } },
    }, null, 2)}\n`);
    editor = await createEditorServer({
      workshopRoot: ws, dataDir, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), log: quiet,
      playtest: {
        status: () => ({ running: false, port: null, url: null, pid: null, since: null }),
        start: async (opts) => { started = opts; return { ok: true, url: 'http://127.0.0.1:1/?playtest=1', port: 1, pid: 2, reused: false, directToHand: opts.directToHand ?? [] }; },
        stop: async () => ({ ok: true, stopped: false }),
        killNow() {},
      },
    });
  });
  after(async () => {
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('GET /api/playtest 给出名单；POST /api/playtest/start 把它交给 playtest.start()', async () => {
    const status = await fetch(`${editor.url}/api/playtest`).then((r) => r.json());
    assert.deepEqual(status.directToHand, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort(),
      '状态里就能看见这一局会往手里塞谁（作者点之前不必猜）');

    const res = await fetch(`${editor.url}/api/playtest/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ difficulty: 'HARD' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.directToHand, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort());
    assert.deepEqual(started?.directToHand, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort(),
      '编辑器必须把名单交给 playtest.start()（它由 editor/playtest.mjs 变成 SP_DIRECT_TO_HAND）');
    assert.equal(started?.difficulty, 'HARD');
  });

  test('覆盖的记录仍然与官方**同形**（没有 directToHand 这个键），而名单里有它', async () => {
    const res = await fetch(`${editor.url}/api/playtest/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    const ids = (await res.json()).directToHand;
    assert.ok(ids.includes(OFFICIAL_BASE_ID), '覆盖模式下开关必须靠行为层这条声明活着');

    // 记录这一侧：加载器合并出来的那条与官方**字段集合**一致（这正是 stripEditorOnlyKeys 要守的契约）
    const data = loadData(dataDir, { log: quiet, workshopDir: ws });
    const rec = data.chess[OFFICIAL_BASE_ID];
    assert.equal('directToHand' in rec, false, '覆盖模式下记录里不许有 directToHand（与官方同形）');
    assert.equal(Object.keys(rec).length, Object.keys(OFFICIAL[OFFICIAL_BASE_ID]).length,
      `字段数必须与官方一致（${Object.keys(OFFICIAL[OFFICIAL_BASE_ID]).length}）`);
    assert.equal(rec.stats.atk, 1, '补丁本身要生效');

    // 引擎侧：真子进程里的那份数据 + 这份名单 ⇒ 发牌名单含它
    const gd = fakeGd(data.chess, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID]);
    assert.deepEqual(directToHandIds(gd, { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: ids.join(',') }), [OFFICIAL_BASE_ID],
      '精锐那条由 isGolden 排除');
    assert.deepEqual(directToHandIds(gd, { SP_DIRECT_TO_HAND: ids.join(',') }), [],
      '不变量：没有 SP_PLAYTEST=1 就一个都不发');
  });

  test('保存路径：覆盖模式下勾选写进 pack.json.playtest，取消就删掉（记录一个字都不多）', async () => {
    const open = await fetch(`${editor.url}/api/official/chess/${OFFICIAL_BASE_ID}?pack=ovr-pack`).then((r) => r.json());
    assert.deepEqual(open.playtest.declared, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort(), '只读端点要把这个包的声明一起给页面');
    assert.deepEqual(open.playtest.ids, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort());

    const manifest = () => JSON.parse(fs.readFileSync(join(ws, 'ovr-pack', 'pack.json'), 'utf8'));
    const spec = { ...open.spec, directToHand: true };
    const save = await fetch(`${editor.url}/api/packs/ovr-pack/operators`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }),
    });
    assert.equal(save.status, 200, JSON.stringify(await save.clone().json()));
    assert.deepEqual(manifest().playtest.directToHand, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort(), '勾上 ⇒ 声明留在 pack.json');
    const written = JSON.parse(fs.readFileSync(join(ws, 'ovr-pack', 'chess.json'), 'utf8'));
    assert.equal('directToHand' in written[OFFICIAL_BASE_ID], false, '记录里不许出现这个键（同形是覆盖模式的契约）');

    // 取消勾选：声明被删掉，而 `overrides` / `content` 一个字都不动
    const before = manifest();
    const off = await fetch(`${editor.url}/api/packs/ovr-pack/operators`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: { ...open.spec, directToHand: false } }),
    });
    assert.equal(off.status, 200);
    assert.equal('playtest' in manifest(), false, '空名单不留空壳');
    assert.deepEqual(manifest().overrides, before.overrides);
    assert.deepEqual(manifest().content, before.content);
  });

  test('非覆盖模式一字不改：勾选仍然写进记录（今天的行为）', async () => {
    const spec = {
      id: 'ws_plain_flag', name: '普通新干员', tier: 3, profession: 'WARRIOR', position: 'MELEE', directToHand: true,
      stats: {
        normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
        golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
      },
    };
    const res = await fetch(`${editor.url}/api/packs/ovr-pack/operators`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.equal(body.directToHand.where, 'record', '非覆盖模式的落点仍然是记录');
    const written = JSON.parse(fs.readFileSync(join(ws, 'ovr-pack', 'chess.json'), 'utf8'));
    assert.equal(written.chess_ws_ws_plain_flag_a.directToHand, true, '记录里写着 directToHand: true');
    const manifest = JSON.parse(fs.readFileSync(join(ws, 'ovr-pack', 'pack.json'), 'utf8'));
    assert.equal('playtest' in manifest, false, '非覆盖模式不动 pack.json 的 playtest');
  });
});

// ---- ⑤ 陈旧声明：记录没了，声明必须跟着没（否则整个包起不来） ----------------------------------------------------

describe('试玩直接发牌: 声明不会变成陈旧条目', () => {
  let tmp;
  let ws;
  let dataDir;
  let editor;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-stale-'));
    ws = join(tmp, 'workshop');
    dataDir = injectedDataDir(tmp);
    for (const id of ['del-pack']) fs.mkdirSync(join(ws, id, 'specs'), { recursive: true });
    fs.writeFileSync(join(ws, 'del-pack', 'pack.json'), `${JSON.stringify({
      id: 'del-pack', name: '删除包', version: '1.0.0', content: ['chess'],
      overrides: [`chess:${OFFICIAL_BASE_ID}`, `chess:${OFFICIAL_GOLD_ID}`],
      playtest: { directToHand: [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID] },
    }, null, 2)}\n`);
    fs.writeFileSync(join(ws, 'del-pack', 'chess.json'), `${JSON.stringify({
      [OFFICIAL_BASE_ID]: { stats: { atk: 3 } },
    }, null, 2)}\n`);
    editor = await createEditorServer({
      workshopRoot: ws, dataDir, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), log: quiet,
      playtest: { status: () => ({ running: false }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), killNow() {} },
    });
  });
  after(async () => {
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const manifestOf = (id) => JSON.parse(fs.readFileSync(join(ws, id, 'pack.json'), 'utf8'));

  test('删掉一条覆盖 ⇒ pack.json 里的声明一起收掉，包还能被加载器读进来', async () => {
    // 先把这条覆盖**真的存下来**（这一步会写出 `specs/<官方id>.json`，删除路径靠它认出「这是哪两个记录」）
    const open = await fetch(`${editor.url}/api/official/chess/${OFFICIAL_BASE_ID}?pack=del-pack`).then((r) => r.json());
    const save = await fetch(`${editor.url}/api/packs/del-pack/operators`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { ...open.spec, directToHand: true } }),
    });
    assert.equal(save.status, 200, JSON.stringify(await save.clone().json()));
    assert.ok(fs.existsSync(join(ws, 'del-pack', 'specs', `${OFFICIAL_BASE_ID}.json`)), 'spec 落盘（删除路径要读它）');
    assert.deepEqual(manifestOf('del-pack').playtest.directToHand, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort());
    // 删之前：这条声明是**有效**的（记录真的在包里）
    assert.deepEqual(loadWorkshop(ws, { log: quiet }).errors, []);

    const del = await fetch(`${editor.url}/api/packs/del-pack/operators/${OFFICIAL_BASE_ID}`, { method: 'DELETE' });
    assert.equal(del.status, 200, JSON.stringify(await del.clone().json()));
    assert.equal('playtest' in manifestOf('del-pack'), false, '声明跟着记录一起没了（不是留着一条点不到东西的条目）');
    assert.deepEqual(manifestOf('del-pack').overrides, [`chess:${OFFICIAL_BASE_ID}`, `chess:${OFFICIAL_GOLD_ID}`],
      'overrides 是另一件事，不许被顺手删掉');

    // 关键后果：如果声明留着，加载器会以 PLAYTEST_UNKNOWN_CHESS **整包拒绝**（作者找不到原因）
    const after = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(after.errors, [], JSON.stringify(after.errors));
    assert.deepEqual(after.packs.map((p) => p.id), ['del-pack'], '包还在（不是被拒掉）');
  });

  test('没有 pack.json 的包目录：覆盖保存写出**完整**清单，不是只有 playtest 的壳', async () => {
    // `bare-pack`：目录在、`pack.json` 不在（手工建的包 / 作者删过清单）。覆盖保存必须**把清单建全**，
    // 不能只写一个 playtest 键 —— 那样的清单没有 id/content，加载器整包拒绝。
    fs.mkdirSync(join(ws, 'bare-pack', 'specs'), { recursive: true });
    const open = await fetch(`${editor.url}/api/official/chess/${OFFICIAL_BASE_ID}`).then((r) => r.json());
    const res = await fetch(`${editor.url}/api/packs/bare-pack/operators`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { ...open.spec, directToHand: true } }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const m = manifestOf('bare-pack');
    assert.equal(m.id, 'bare-pack', '清单必须建全（少了 id 加载器整包拒绝）');
    assert.deepEqual(m.content, ['chess']);
    assert.ok(m.overrides.includes(`chess:${OFFICIAL_BASE_ID}`), JSON.stringify(m.overrides));
    assert.deepEqual(m.playtest.directToHand, [OFFICIAL_BASE_ID, OFFICIAL_GOLD_ID].sort());
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), ['bare-pack', 'del-pack']);
  });
});

// ---- ⑦ 包管理页：声明看得见、删得掉（否则一个手写的错 id 会把作者锁在门外） ----------------------------------------

describe('试玩直接发牌: 包管理页的声明与删除', () => {
  let tmp;
  let ws;
  let dataDir;
  let editor;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-pack-'));
    ws = join(tmp, 'workshop');
    dataDir = injectedDataDir(tmp);
    // 一个包：`playtest.directToHand` 里既有本包自己的记录（有效），也有一个认不出来的 id（加载器整包拒绝）
    const dir = join(ws, 'ui-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
      id: 'ui-pack', name: '界面包', version: '1.0.0', content: ['chess'],
      playtest: { directToHand: ['chess_ws_ws_ui_a', 'chess_nope_zzz'] },
    }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({
      chess_ws_ws_ui_a: { name: '甲', tier: 1, directToHand: true },
      chess_ws_ws_ui_b: { name: '甲·精锐', tier: 1, isGolden: true },
    }, null, 2)}\n`);
    editor = await createEditorServer({
      workshopRoot: ws, dataDir, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), log: quiet,
      playtest: { status: () => ({ running: false }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), killNow() {} },
    });
  });
  after(async () => {
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('readPackMeta 把声明原样给出，并把认不出来的 id 单独点出来', () => {
    const meta = readPackMeta(ws, 'ui-pack');
    assert.deepEqual(meta.playtest.directToHand, ['chess_nope_zzz', 'chess_ws_ws_ui_a'], '按 id 排序给出');
    assert.deepEqual(meta.playtest.unknown, ['chess_nope_zzz'], '认不出来的那个被点名（界面照它标红）');
    // 形状是合法的 ⇒ 清单本身「没问题」；判罚来自加载器（membership），界面靠 `unknown` 说话
    assert.equal(meta.ok, true);
  });

  test('readPackSupport 把「记录自带的开关」也报出来（与 pack.json 那份分开）', () => {
    const st = readPackSupport(ws, 'ui-pack', { supportFile: join(tmp, 'support.json') });
    // 精锐那两条不进这张表（`readPackSupport` 按记录自己的 isGolden 过滤），所以只有普通那条
    assert.deepEqual(st.operators.map((o) => o.id), ['chess_ws_ws_ui_a']);
    assert.equal(st.operators[0].directToHand, true, '记录自己带的开关，界面靠它说「另有 N 条」');
  });

  test('这个包现在会被加载器整包拒绝（PLAYTEST_UNKNOWN_CHESS）—— 正是界面必须能删掉它的理由', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.equal(loaded.packs.length, 0);
    assert.match(loaded.errors[0].reason, /PLAYTEST_UNKNOWN_CHESS/);
  });

  test('POST /api/packs/:id/playtest 删掉那条认不出来的 id ⇒ 包立刻又能加载', async () => {
    const r = await fetch(`${editor.url}/api/packs/ui-pack/playtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directToHand: ['chess_ws_ws_ui_a'] }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    const body = await r.json();
    assert.equal(body.changed, true);
    assert.deepEqual(body.playtest.directToHand, ['chess_ws_ws_ui_a']);
    assert.deepEqual(body.playtest.unknown, []);
    assert.deepEqual(loadWorkshop(ws, { log: quiet }).errors, [], '删掉之后包又起来了');
  });

  test('再发一次同样的清单：内容没变就不改写文件（保住作者的排版）', async () => {
    const before = fs.readFileSync(join(ws, 'ui-pack', 'pack.json'), 'utf8');
    const r = await fetch(`${editor.url}/api/packs/ui-pack/playtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directToHand: ['chess_ws_ws_ui_a'] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).changed, false);
    assert.equal(fs.readFileSync(join(ws, 'ui-pack', 'pack.json'), 'utf8'), before);
  });

  test('清空名单 = 删掉这个键（与「没声明」同一件事，不留空壳）', async () => {
    await fetch(`${editor.url}/api/packs/ui-pack/playtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directToHand: [] }),
    });
    const manifest = JSON.parse(fs.readFileSync(join(ws, 'ui-pack', 'pack.json'), 'utf8'));
    assert.equal('playtest' in manifest, false);
    assert.deepEqual(manifest.content, ['chess'], '别的字段原样保留');
  });

  test('形状错照旧拒绝并点名（写坏的一行不能进盘）', async () => {
    const bad = await fetch(`${editor.url}/api/packs/ui-pack/playtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directToHand: ['../etc'] }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /PLAYTEST_BAD_SHAPE/);
    const notArray = await fetch(`${editor.url}/api/packs/ui-pack/playtest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directToHand: 'chess_ws_ws_ui_a' }),
    });
    assert.equal(notArray.status, 400);
  });

  test('writePackPlaytest 是纯写盘函数：包不存在 ⇒ 404 语义的拒绝', async () => {
    await assert.rejects(() => writePackPlaytest(ws, 'nope-pack', []), /nope-pack/);
  });
});

// ---- ⑧ 真子进程：SP_DIRECT_TO_HAND 真的传到了试玩服务器里 ----------------------------------------------------------

describe('试玩直接发牌: 真试玩服务器里那条覆盖记录仍然同形', () => {
  let tmp;
  let ws;
  let editor;
  let started;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-real-'));
    ws = join(tmp, 'workshop');
    const dir = join(ws, 'ovr-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
      id: 'ovr-pack', name: '覆盖包', version: '1.0.0', content: ['chess'],
      overrides: [`chess:${OFFICIAL_BASE_ID}`, `chess:${OFFICIAL_GOLD_ID}`],
      playtest: { directToHand: [OFFICIAL_BASE_ID] },
    }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({ [OFFICIAL_BASE_ID]: { stats: { atk: 7 } } }, null, 2)}\n`);
    editor = await createEditorServer({
      workshopRoot: ws, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), log: quiet,
      playtest: createPlaytest({ root: ws, log: quiet, stdio: 'ignore' }),
    });
  });
  after(async () => {
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('起真服务器：/data/chess.json 里那条记录没有 directToHand，而名单里含它', async () => {
    const res = await fetch(`${editor.url}/api/playtest/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    started = await res.json();
    assert.deepEqual(started.directToHand, [OFFICIAL_BASE_ID]);

    const chess = await fetch(`http://127.0.0.1:${started.port}/data/chess.json`).then((r) => r.json());
    const rec = chess[OFFICIAL_BASE_ID];
    assert.ok(rec, '试玩服务器必须能看见这个包覆盖的那条官方记录');
    assert.equal(rec.stats.atk, 7, '覆盖生效');
    assert.equal('directToHand' in rec, false, '记录与官方同形 —— 覆盖模式下这个键不许被写进去');
    assert.equal(Object.keys(rec).length, Object.keys(OFFICIAL[OFFICIAL_BASE_ID]).length,
      `字段数必须与官方一致（${Object.keys(OFFICIAL[OFFICIAL_BASE_ID]).length}）`);
    // 名单里有它 ⇒ 引擎侧会把它发到手上（用**服务器真正服务的那份合并数据**验一次，不是另算一份）
    assert.deepEqual(directToHandIds(fakeGd(chess, [OFFICIAL_BASE_ID]), { SP_PLAYTEST: '1', SP_DIRECT_TO_HAND: started.directToHand.join(',') }),
      [OFFICIAL_BASE_ID]);
    assert.deepEqual(directToHandIds(fakeGd(chess, [OFFICIAL_BASE_ID]), { SP_DIRECT_TO_HAND: started.directToHand.join(',') }), [],
      '不变量：没有 SP_PLAYTEST=1 就一个都不发');
    assert.deepEqual((await fetch(`${editor.url}/api/playtest`).then((r) => r.json())).directToHand, [OFFICIAL_BASE_ID]);

    await fetch(`${editor.url}/api/playtest/stop`, { method: 'POST' });
  });
});
