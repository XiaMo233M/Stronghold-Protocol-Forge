// test/overrideMode.test.js — 覆盖模式的 **B 段**（保存路径分支 + 入口 + 端到端硬证据）。
//
// A 段的东西（平行 id 函数 / `spec.override` 标记 / 两个只读端点）在同一个文件的上半部分，护身符是
// 「默认路径一字不变」。B 段做的是**唯一**一个换 id 函数的地方：保存路径上 `spec.override === true` 那一条分支。
// 这一节的三条硬证据按「作者真能用」的顺序排：
//
//   ① **卸掉包 ⇒ 回原版**：不抽查字段，而是把加载器读出来的**整条记录**与磁盘上 `data/chess.json` 的那一条
//      `deepEqual`。抽查字段会在「字段合并悄悄多写/少写了别的键」时放行，整条比对不会。
//   ② **装着包 ⇒ 覆盖生效**：`atk` 是包里的值，而且 `Object.keys(rec).length === 44` —— 挡住
//      「44 字段被压成 2」那类（A2 修的那个缺口，这里从保存路径再钉一次）。
//   ③ **潜能链不许丢**（0.2.2 的注解）：覆盖一条带 `potDown` / 链式天赋的官方记录之后，那些注解**仍在**。
//      ②③ 用的官方记录是**注入**的：本工作树的 `data/chess.json` 是 0.1 口径，没有潜能注解，而带注解的数据在
//      0.2.2 移植线上 —— 两条线不合流就永远测不到（`test/overridePotential.test.js` 测的是 `mergeRecord` 单元，
//      这里走**编辑器保存 → 加载器应用**整条路）。注入方式是「同一份官方数据 + 一层 0.2.2 形状的注解」，
//      不依赖任何一棵树的 data/ 内容，也不动 `data/`。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { chessIds, overrideChessIds, deriveChessRecord } from '../shared/chessAuthoring.js';
import { enemyKey, overrideEnemyKey } from '../shared/enemyAuthoring.js';
import { createEditorServer } from '../editor/server.mjs';
import { applyWorkshop } from '../shared/workshop.js';
import { loadData } from '../server/data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const OFFICIAL = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));
const OFFICIAL_BASE = OFFICIAL.chess_char_1_01_a;
const OFFICIAL_GOLD = OFFICIAL.chess_char_1_01_b;
const OFFICIAL_ENEMY = Object.entries(JSON.parse(fs.readFileSync(join(DATA_DIR, 'enemies.json'), 'utf8')))
  .find(([, rec]) => rec && typeof rec === 'object' && typeof rec.key === 'string');

describe('覆盖模式 A 段: 默认路径一字不变（护身符）', () => {
  test('chessIds / enemyKey 对一组输入与加平行函数之前逐字相同', () => {
    // 这一组是「改动前实测出来」的字面量：任何一位不同都说明默认路径被动了
    assert.deepEqual(chessIds('Abyss Hunter!'), { slug: 'abyss_hunter', base: 'chess_ws_abyss_hunter_a', golden: 'chess_ws_abyss_hunter_b' });
    assert.deepEqual(chessIds('chess_ws_x_b'), { slug: 'x', base: 'chess_ws_x_a', golden: 'chess_ws_x_b' });
    assert.deepEqual(chessIds('chess_char_1_01'), { slug: 'chess_char_1_01', base: 'chess_ws_chess_char_1_01_a', golden: 'chess_ws_chess_char_1_01_b' });
    assert.equal(chessIds('!!!'), null);
    assert.equal(chessIds(''), null);
    assert.equal(chessIds(undefined), null);
    assert.deepEqual(enemyKey('enemy_1'), { slug: 'enemy_1', key: 'enemy_ws_enemy_1' });
    assert.deepEqual(enemyKey('enemy_ws_x'), { slug: 'x', key: 'enemy_ws_x' });
    assert.equal(enemyKey(''), null);
  });
});

describe('覆盖模式 A 段: 平行函数的取值只来自记录自己的字段', () => {
  test('干员：保留官方 id，兄弟 id 从记录里读出来（不做字符串手术）', () => {
    assert.deepEqual(overrideChessIds(OFFICIAL_BASE), { slug: 'chess_char_1_01_a', base: 'chess_char_1_01_a', golden: 'chess_char_1_01_b' });
    // 精锐那条记录给出同一对（baseId 指回普通）
    assert.deepEqual(overrideChessIds(OFFICIAL_GOLD), { slug: 'chess_char_1_01_a', base: 'chess_char_1_01_a', golden: 'chess_char_1_01_b' });
    // 官方 id 的 `_a` 后缀不是本仓库定的：没有 goldenId 就老老实实 null，不猜
    assert.deepEqual(overrideChessIds({ chessId: 'x_a', baseId: 'x_a' }), { slug: 'x_a', base: 'x_a', golden: null });
    assert.equal(overrideChessIds({}), null);
    assert.equal(overrideChessIds(null), null);
  });

  test('怪物：一个 key，没有 golden 兄弟（与干员那边的差异）', () => {
    const [key, rec] = OFFICIAL_ENEMY;
    assert.deepEqual(overrideEnemyKey(rec), { slug: key, key });
    assert.equal(overrideEnemyKey({}), null);
    assert.equal(overrideEnemyKey(null), null);
  });
});

describe('覆盖模式 A 段: spec.override 只活在 spec 层，不许漏进记录', () => {
  test('deriveChessRecord 认得这个标记、但不把它写进记录', () => {
    const spec = {
      id: 'ws_marker', name: '标记探针', tier: 3, profession: 'WARRIOR', position: 'MELEE', override: true,
      stats: {
        normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
        golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
      },
    };
    const d = deriveChessRecord(spec);
    assert.equal(d.ok, true, JSON.stringify(d.errors));
    assert.equal('override' in d.base, false, '标记不许出现在记录里（A2 的闭合世界会整条拒掉）');
    assert.equal('override' in d.golden, false);
  });

  test('万一它真的漏进记录，加载器的闭合世界会拒（把这条前提钉住）', () => {
    const officialId = 'chess_char_1_01_a';
    const official = { chessId: officialId, baseId: officialId, stats: { maxHp: 1 } };
    const { report } = applyWorkshop({ chess: { [officialId]: official } }, [{
      id: 'p', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: { stats: { maxHp: 2 }, override: true } } },
    }]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'UNKNOWN_OVERRIDE_FIELD', JSON.stringify(report.errors));
  });
});

describe('覆盖模式 A 段: 两个只读端点', () => {
  let tmp;
  let editor;
  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-override-a-'));
    fs.mkdirSync(join(tmp, 'workshop'), { recursive: true });
    editor = await createEditorServer({ workshopRoot: join(tmp, 'workshop'), port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('GET /api/official/chess/<id> 给出 spec（带 override 标记）、ids 与官方原文', async () => {
    const r = await fetch(`${editor.url}/api/official/chess/${OFFICIAL_BASE.chessId}`).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.spec.override, true, '标记只在这份 spec 上');
    assert.deepEqual(r.ids, { slug: 'chess_char_1_01_a', base: 'chess_char_1_01_a', golden: 'chess_char_1_01_b' });
    assert.equal(r.official.chessId, 'chess_char_1_01_a', '官方原文一起给，UI 才能做差异预览');
    assert.equal(r.official.name, OFFICIAL_BASE.name);
    // B 段加的 `slug`：服务端算出来的那个 spec 文件名，不是 `spec.id`
    assert.equal(r.spec.slug, 'chess_char_1_01_a', '保存时要写 specs/<slug>.json，删了再存不多出孤儿 spec');
  });

  test('GET /api/official/enemies/<key> 同形（一个 key）', async () => {
    const [key, rec] = OFFICIAL_ENEMY;
    const r = await fetch(`${editor.url}/api/official/enemies/${encodeURIComponent(key)}`).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.spec.override, true);
    assert.equal(r.ids.key, key);
    assert.equal(r.official.key, key);
    assert.equal(typeof rec.name === 'string', true);
    assert.equal(r.spec.slug, key);
  });

  test('不存在的 id 是 404、坏形状是 400（挡路径穿越），且这两个端点不写盘', async () => {
    assert.equal((await fetch(`${editor.url}/api/official/chess/chess_nope_a`)).status, 404);
    assert.equal((await fetch(`${editor.url}/api/official/chess/${encodeURIComponent('../etc')}`)).status, 400);
    // `..` 只由点组成，字符集**允许**点（真 id 里有它，例如 `enemy_ws.a:b`），所以它过得了形状检查 ——
    // 安全来自「这一层只查表、从不把 id 拼进路径」，落到 404。
    assert.equal((await fetch(`${editor.url}/api/official/enemies/${encodeURIComponent('..')}`)).status, 404);
    // 只读端点：workshop 根下仍然一个包都没有
    assert.deepEqual(fs.readdirSync(join(tmp, 'workshop')), []);
  });
});

// =====================================================================================================================
// B 段
// =====================================================================================================================

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * 一条官方记录 + 一层 **0.2.2 形状的潜能注解**：记录层 `potDown`、天赋层 `potMin` + `potBelow`
 * （`shared/potential.js` 的链式天赋）、以及模组内部 `modules[].talentChanges` 的注解。
 *
 * 只往**真的存在**的那几条上注入（官方数据里天赋条数是稀疏的：这一条只有 index 0）。要验的是注解会不会
 * 在合并里活下来，不是「官方数据恰好有几个天赋」。1.0 的形状写死，不依赖 0.2.2 那棵树的数据。
 */
const withPotentialChain = (base, golden) => {
  const b = structuredClone(base);
  b.potDown = { 3: { 'stats.maxHp': b.stats.maxHp - 100 }, 4: { 'stats.cost': (b.stats.cost ?? 0) + 1 } };
  if (Array.isArray(b.talents) && b.talents[0]) {
    b.talents[0].potMin = 4;
    b.talents[0].potBelow = { desc: '（不满潜时这一条弱一些）', bb: { ...(b.talents[0].bb ?? {}) } };
  }
  const g = structuredClone(golden ?? base);
  g.potDown = { 3: { 'statsBase.atk': (g.statsBase?.atk ?? 0) - 5 } };
  for (const key of ['talents', 'talentsBase']) {
    if (Array.isArray(g[key]) && g[key][0]) {
      g[key][0].potMin = 4;
      g[key][0].potBelow = { desc: `（精锐 ${key}：不满潜时这一条弱一些）` };
    }
  }
  // 模组内部的天赋改写同样挂注解（0.2.2 的 `modules[].talentChanges`）。这一棵树里官方模组只带
  // `traitOverride` 与 `attr`，所以补一条 `talentChanges` 进去 —— 形状照 0.2.2（按 `talentIndex` 认条目）。
  if (Array.isArray(g.modules) && g.modules[0]) {
    const m = g.modules[0];
    m.talentChanges = Array.isArray(m.talentChanges) && m.talentChanges.length ? m.talentChanges : [];
    m.talentChanges[0] = {
      talentIndex: 0, name: '模组内的天赋改写', desc: '（模组改写的那一份）',
      bb: { ...(g.talentsBase?.[0]?.bb ?? {}) }, bbStr: {}, rangeGrid: null, tokenKey: null, hidden: false,
      potMin: 4, potBelow: { desc: '（模组：不满潜时这一条弱一些）' },
    };
  }
  return { base: b, golden: g };
};

/** 一个「注入过的官方 data 目录」：同一份官方数据 + 上面的注解。`data/` 一个字都不动。 */
function injectedDataDir(tmp) {
  const dir = join(tmp, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const chess = structuredClone(OFFICIAL);
  const gold = chess[OFFICIAL_BASE.chessId.replace(/_a$/, '_b')];
  const injected = withPotentialChain(OFFICIAL_BASE, gold);
  chess[injected.base.chessId] = injected.base;
  if (gold) chess[gold.chessId] = injected.golden;
  fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify(chess));
  // 加载器要的那几张表照原样拷过去（只有 chess 被注入过）
  for (const f of ['enemies.json', 'tokens.json', 'backups.json']) {
    const src = join(DATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, join(dir, f));
  }
  return dir;
}

describe('覆盖模式 B 段: 保存路径分支（作者真能用的那条路）', () => {
  let tmp;
  let wsRoot;
  let dataDir;
  let editor;
  const packDir = () => join(wsRoot, 'ws-ovr');
  const manifest = () => JSON.parse(fs.readFileSync(join(packDir(), 'pack.json'), 'utf8'));
  const readPack = (file) => JSON.parse(fs.readFileSync(join(packDir(), file), 'utf8'));
  /** 磁盘上那条官方记录的**原始快照**（在测试动手之前取，用来做整条 deepEqual）。 */
  let pristine;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-override-b-'));
    wsRoot = join(tmp, 'workshop');
    dataDir = injectedDataDir(tmp);
    pristine = structuredClone(JSON.parse(fs.readFileSync(join(dataDir, 'chess.json'), 'utf8')));
    fs.mkdirSync(join(packDir(), 'specs'), { recursive: true });
    fs.writeFileSync(join(packDir(), 'pack.json'), JSON.stringify({
      id: 'ws-ovr', name: 'ws-ovr', version: '0.1.0', content: [], overrides: [],
    }));
    editor = await createEditorServer({
      workshopRoot: wsRoot, dataDir, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'),
    });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 以官方 id 打开一条记录 ⇒ 改一处数值 ⇒ 保存。返回服务端回话。 */
  const saveOverride = async (mutate) => {
    const r = await fetch(`${editor.url}/api/official/chess/${OFFICIAL_BASE.chessId}`).then((x) => x.json());
    const spec = mutate ? mutate(structuredClone(r.spec)) : r.spec;
    const res = await postJson(`${editor.url}/api/packs/ws-ovr/operators`, { spec });
    return { status: res.status, body: await res.json() };
  };

  test('① 卸掉包 ⇒ 回原版：整条记录 deepEqual 磁盘上的 data/chess.json', () => {
    // 没有任何包：加载器读出来的那条官方记录必须与磁盘上的**逐字节同值**
    const data = loadData(dataDir, { log: quiet, workshopDir: wsRoot });
    assert.deepEqual(data.chess[OFFICIAL_BASE.chessId], pristine[OFFICIAL_BASE.chessId],
      '没装包时不能有任何一处与 data/chess.json 不同（不抽查字段，整条比）');
    assert.deepEqual(data.chess[OFFICIAL_GOLD.chessId], pristine[OFFICIAL_GOLD.chessId]);
  });

  test('② 装着包 ⇒ 覆盖生效：atk 是包里的值，且字段数一个不多一个不少', async () => {
    const before = pristine[OFFICIAL_BASE.chessId];
    const { status, body } = await saveOverride((spec) => {
      spec.stats.normal = { ...spec.stats.normal, atk: before.stats.atk + 111 };
      return spec;
    });
    assert.equal(status, 200, JSON.stringify(body));
    // 保存路径必须写出**官方 id**，不是 `chess_ws_…`（这就是 B 段换的那个函数）
    assert.equal(body.slug, OFFICIAL_BASE.chessId, 'spec 文件名 = 官方 baseId（`overrideChessIds` 的 slug）');
    assert.equal(readPack('chess.json')[OFFICIAL_BASE.chessId].chessId, OFFICIAL_BASE.chessId, '写出来的记录 id 就是官方 id');
    // A3 的自动补声明必须照旧生效（放行 + 记住声明是同一件活的两半）
    assert.ok(manifest().overrides.includes(`chess:${OFFICIAL_BASE.chessId}`), JSON.stringify(manifest().overrides));
    assert.ok(manifest().overrides.includes(`chess:${OFFICIAL_GOLD.chessId}`), '精锐那条也要声明（一对两条）');
    assert.ok(manifest().content.includes('chess'));

    const data = loadData(dataDir, { log: quiet, workshopDir: wsRoot });
    const rec = data.chess[OFFICIAL_BASE.chessId];
    assert.equal(rec.stats.atk, before.stats.atk + 111, '包的数值赢');
    assert.equal(Object.keys(rec).length, Object.keys(before).length,
      `字段数必须与官方那条一致（${Object.keys(before).length}），挡住「44 字段被压成 2」`);
    assert.equal(Object.keys(rec.stats).length, Object.keys(before.stats).length, 'stats 也不能被压扁');
    assert.equal(rec.name, before.name, '没写的字段回退官方');
    assert.deepEqual(rec.talents, before.talents, '作者没碰天赋 ⇒ 官方那条原样');
    // 编辑器自己造的两个键（`workshop` / `directToHand`）不许写回官方记录 —— 上面那条字段数就是靠这个成立的
    assert.equal('workshop' in rec, false, '工厂戳不进官方记录');
    assert.equal('directToHand' in rec, false, '试玩开关不属于「覆盖官方数据」');
    // 精锐那条同样一个字段都不多
    const goldBefore = pristine[OFFICIAL_GOLD.chessId];
    assert.equal(Object.keys(data.chess[OFFICIAL_GOLD.chessId]).length, Object.keys(goldBefore).length,
      '精锐那条的字段数也要与官方一致');
  });

  test('③ 潜能链不许丢：编辑器保存 → 加载器应用 之后 potDown / potMin / potBelow 仍在', async () => {
    const before = pristine[OFFICIAL_BASE.chessId];
    assert.ok(before.potDown, '夹具前提：注入过的官方记录有 potDown');
    assert.ok(before.talents.some((t) => t.potMin !== undefined), '夹具前提：注入过的天赋链有 potMin');

    // 作者只改一条天赋的**基础态**文案（编辑器保存路径：spec → 派生记录 → 合并）
    const { status, body } = await saveOverride((spec) => {
      spec.talents = spec.talents.map((t, i) => (i === 0 ? { ...t, desc: '作者重写的说明' } : t));
      return spec;
    });
    assert.equal(status, 200, JSON.stringify(body));

    const data = loadData(dataDir, { log: quiet, workshopDir: wsRoot });
    const rec = data.chess[OFFICIAL_BASE.chessId];

    assert.equal(rec.talents[0].desc, '作者重写的说明', '作者的文案要生效');
    assert.equal(rec.talents[0].potMin, before.talents[0].potMin, '`potMin` 是官方数据，作者没写 ⇒ 必须留下');
    assert.deepEqual(rec.talents[0].potBelow, before.talents[0].potBelow, '`potBelow` 链同样要留下');
    assert.equal(rec.talents[0].name, before.talents[0].name, '没写的字段回退官方');
    assert.deepEqual(rec.potDown, before.potDown, '记录层的 `potDown` 原样保留');
    assert.equal(Object.keys(rec).length, Object.keys(before).length, '注解不是新增字段 ⇒ 字段数不变');
  });

  test('③续 精锐那条：`talentsBase` 与 `modules[].talentChanges` 的注解同样不许丢', async () => {
    const beforeGold = pristine[OFFICIAL_GOLD.chessId];
    assert.ok(Array.isArray(beforeGold.talentsBase) && beforeGold.talentsBase.some((t) => t.potMin !== undefined),
      '夹具前提：精锐的 `talentsBase` 有注解');
    assert.ok(beforeGold.modules?.[0]?.talentChanges?.[0]?.potMin !== undefined,
      '夹具前提：模组内部的天赋改写有注解');

    // 作者改一处精锐数值（其它一律不碰）
    const { status, body } = await saveOverride((spec) => {
      spec.stats.golden = { ...spec.stats.golden, def: (spec.stats.golden.def ?? 0) + 7 };
      return spec;
    });
    assert.equal(status, 200, JSON.stringify(body));

    const data = loadData(dataDir, { log: quiet, workshopDir: wsRoot });
    const gold = data.chess[OFFICIAL_GOLD.chessId];
    assert.equal(gold.stats.def, beforeGold.stats.def + 7, '作者改的精锐数值生效');
    assert.equal(gold.talentsBase[0].potMin, beforeGold.talentsBase[0].potMin, '`talentsBase` 的注解留下');
    assert.deepEqual(gold.talentsBase[0].potBelow, beforeGold.talentsBase[0].potBelow);
    assert.deepEqual(gold.potDown, beforeGold.potDown, '精锐记录层的 `potDown` 也留下');
    assert.equal(Object.keys(gold).length, Object.keys(beforeGold).length, '精锐那条字段数也不变');
  });

  test('加载器侧交叉验证：同样的包走 applyWorkshop，注解也在（不经 HTTP）', () => {
    const pack = {
      id: 'ws-ovr', name: 'ws-ovr', overrides: [`chess:${OFFICIAL_BASE.chessId}`],
      files: { chess: { [OFFICIAL_BASE.chessId]: { stats: { atk: 1 } } } },
    };
    const { data, report } = applyWorkshop({ chess: pristine }, [pack]);
    assert.deepEqual(report.errors, []);
    const rec = data.chess[OFFICIAL_BASE.chessId];
    assert.equal(rec.stats.atk, 1, '补丁生效');
    assert.ok(rec.potDown, '`potDown` 留下');
    assert.equal(rec.talents[0].potMin, pristine[OFFICIAL_BASE.chessId].talents[0].potMin, '天赋链的 `potMin` 留下');
    assert.deepEqual(rec.talents[0].potBelow, pristine[OFFICIAL_BASE.chessId].talents[0].potBelow);
  });

  test('默认路径一字不变：同一颗保存按钮存一条新干员，仍然产出 chess_ws_<slug>_a/_b', async () => {
    const spec = {
      id: 'ws_plain', name: '普通新干员', tier: 3, profession: 'WARRIOR', position: 'MELEE',
      stats: {
        normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
        golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
      },
    };
    const res = await postJson(`${editor.url}/api/packs/ws-ovr/operators`, { spec });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.slug, 'ws_plain', '没有 override 标记 ⇒ 走默认路径');
    const records = readPack('chess.json');
    assert.ok(records.chess_ws_ws_plain_a, '新干员照旧加前缀');
    assert.ok(records.chess_ws_ws_plain_b);
    // 上一条覆盖没被这次保存毁掉
    assert.ok(records[OFFICIAL_BASE.chessId], '覆盖那条还在（regeneratePack 不许顺手删别人的记录）');
    assert.deepEqual(records[OFFICIAL_BASE.chessId].talents[0].potBelow,
      pristine[OFFICIAL_BASE.chessId].talents[0].potBelow, '注解也还在');
  });
});

describe('覆盖模式 B 段: 怪物也走同一条路（一个 key，不是一对）', () => {
  let tmp;
  let wsRoot;
  let dataDir;
  let editor;
  const packDir = () => join(wsRoot, 'ws-enemy');

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-override-b-enemy-'));
    wsRoot = join(tmp, 'workshop');
    dataDir = injectedDataDir(tmp);
    fs.mkdirSync(join(packDir(), 'enemy-specs'), { recursive: true });
    fs.writeFileSync(join(packDir(), 'pack.json'), JSON.stringify({
      id: 'ws-enemy', name: 'ws-enemy', version: '0.1.0', content: [], overrides: [],
    }));
    editor = await createEditorServer({
      workshopRoot: wsRoot, dataDir, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'),
    });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('以官方 key 打开一只怪 ⇒ 保存 ⇒ 记录 key 就是官方 key，且声明只补一条', async () => {
    const [key] = OFFICIAL_ENEMY;
    const r = await fetch(`${editor.url}/api/official/enemies/${encodeURIComponent(key)}`).then((x) => x.json());
    assert.equal(r.ok, true);
    const spec = structuredClone(r.spec);
    spec.stats = { ...spec.stats, maxHp: 4242 };
    const res = await postJson(`${editor.url}/api/packs/ws-enemy/enemies`, { spec });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.key, key, '写出来的就是官方 key（不加 enemy_ws_ 前缀）');

    const records = JSON.parse(fs.readFileSync(join(packDir(), 'enemies.json'), 'utf8'));
    assert.deepEqual(Object.keys(records), [key]);
    assert.equal(records[key].key, key);
    assert.equal(records[key].stats.maxHp, 4242);
    const man = JSON.parse(fs.readFileSync(join(packDir(), 'pack.json'), 'utf8'));
    assert.deepEqual(man.overrides, [`enemies:${key}`], '怪物只有一条记录 ⇒ 只声明一条（干员那边是一对两条）');
    assert.ok(man.content.includes('enemies'));
  });
});
