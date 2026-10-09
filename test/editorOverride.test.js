// test/editorOverride.test.js — 编辑器里的「官方 id 覆盖」(A3)。
//
// 为什么这一件不能只做一半：`OFFICIAL_ID_COLLISION` 在五个校验器里都是 error，而编辑器把它当阻断（400），
// **即使 `pack.json.overrides` 已经声明过也照样拒**。只把 `officialIds` 里的 id 过滤掉（放行）而不认声明，
// 会让编辑器放行、加载器随后因为「没声明」而**丢掉这条记录** —— 比 400 更坏，因为它是静默的。
// 所以放行（blockers 同时看 id 与 declared）与记住声明（withOverrideDeclarations）是同一件活的两半。
//
// **一条实测出来的边界（重要）**：编辑器的 spec → 记录映射**无条件加前缀** —— `chessIds` 产出
// `chess_ws_<slug>_a/_b`（shared/chessAuthoring.js:204-206）、`enemyKey` 产出 `enemy_ws_<slug>`
// （shared/enemyAuthoring.js:77-78）。所以**今天没有任何一次表单保存能指向官方 id**：
//   * 官方 id 的记录只能来自**手写 / CLI**（tools/workshop-scaffold.mjs、手改 chess.json）；
//   * `OFFICIAL_ID_COLLISION` 因此只在**列表 / 预览 / 复校验**这些读路径上出现（下面第 2、3 条测的就是它们）；
//   * 保存路径上的「自动补声明」是为**覆盖模式**（在编辑器里以官方 id 打开一条记录）准备的，那条路今天还不存在。
// 这三句都写进了测试，免得下一个人以为「能存官方覆盖了」。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer, overrideBlockers, withOverrideDeclarations } from '../editor/server.mjs';
import { chessIds } from '../shared/chessAuthoring.js';
import { enemyKey } from '../shared/enemyAuthoring.js';
import { loadData } from '../server/data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const OFFICIAL_ID = 'chess_char_1_01_a';
const OFFICIAL = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'))[OFFICIAL_ID];

/** 一个真的存在于本机模型清单里的 spine id（干员没有外观会被编辑器拒绝保存）。 */
const SOME_SPINE = (() => {
  try { return Object.keys(JSON.parse(fs.readFileSync(join(DATA_DIR, 'assets.json'), 'utf8')).chars || {})[0] ?? ''; } catch { return ''; }
})();

/** 一条新干员的 spec（编辑器的正常用法：派生出来的 id 一定带 `chess_ws_`）。 */
const NEW_SPEC = {
  id: 'ws_extra', name: '新干员', tier: 3, profession: 'WARRIOR', position: 'MELEE', assetsSpine: SOME_SPINE,
  stats: {
    normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
    golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
  },
};

describe('A3: 两个纯函数（不起服务器）', () => {
  test('overrideBlockers 同时看 id 与声明，和盟约页同一个先例', () => {
    const official = new Set(['chess_a', 'chess_b', 'chess_c']);
    // 既要被保存、又要被声明 ⇒ 不再算冲突；其它官方 id 照旧
    assert.deepEqual([...overrideBlockers(official, ['chess_a'], ['chess:chess_a'], 'chess')].sort(), ['chess_b', 'chess_c']);
    // 正在保存但**没声明** ⇒ 仍然算冲突（这一条正是挡住「静默丢记录」的那一半）
    assert.deepEqual([...overrideBlockers(official, ['chess_a'], [], 'chess')].sort(), ['chess_a', 'chess_b', 'chess_c']);
    // 声明了但**不是**本次保存的 id ⇒ 与本次无关，照旧算冲突
    assert.deepEqual([...overrideBlockers(official, ['chess_a'], ['chess:chess_b'], 'chess')].sort(), ['chess_a', 'chess_b', 'chess_c']);
    // 文件那一段必须对得上：`enemies:chess_a` 授权不了 chess
    assert.ok(overrideBlockers(official, ['chess_a'], ['enemies:chess_a'], 'chess').has('chess_a'));
  });

  test('withOverrideDeclarations 只增不改：进去的数组不动、结果排序去重', () => {
    const manifest = { overrides: ['stages:s1'] };
    assert.deepEqual(withOverrideDeclarations(manifest, ['chess:b', 'chess:a']), ['chess:a', 'chess:b', 'stages:s1']);
    assert.deepEqual(manifest.overrides, ['stages:s1'], '输入对象不被改写');
    assert.deepEqual(withOverrideDeclarations(null, ['chess:a']), ['chess:a']);
    assert.deepEqual(withOverrideDeclarations({ overrides: ['chess:a'] }, ['chess:a']), ['chess:a'], '不重复');
    assert.deepEqual(withOverrideDeclarations(undefined, [null, '', undefined]), []);
  });
});

describe('A3: 编辑器今天能不能指向官方 id（实测边界）', () => {
  test('不能：spec → 记录的映射无条件加前缀，官方 id 只能来自手写 / CLI', () => {
    assert.deepEqual(chessIds('chess_char_1_01'), { slug: 'chess_char_1_01', base: 'chess_ws_chess_char_1_01_a', golden: 'chess_ws_chess_char_1_01_b' });
    // 连把官方 id 原样填进 spec.id，派生出来的仍是一个 chess_ws_ 的新 id（后缀还会被再拼一次）
    assert.equal(chessIds(OFFICIAL_ID).base, 'chess_ws_chess_char_1_01_a_a');
    assert.equal(enemyKey('enemy_1').key, 'enemy_ws_enemy_1');
  });
});

describe('A3: 手写的官方 id 覆盖不再阻断这个包（读路径与复校验）', () => {
  let tmp;
  let wsRoot;
  let editor;
  const packDir = () => join(wsRoot, 'ws-pack');
  const writeManifest = (overrides) => fs.writeFileSync(join(packDir(), 'pack.json'), JSON.stringify({
    id: 'ws-pack', name: 'ws-pack', version: '0.1.0', content: ['chess'], overrides,
  }));
  /** 一条手写的官方 id 覆盖（只改一个数 —— A2 的字段合并会保住其余 43 个字段）。 */
  const writeHandWrittenOverride = () => fs.writeFileSync(join(packDir(), 'chess.json'), JSON.stringify({
    [OFFICIAL_ID]: { ...OFFICIAL, stats: { ...OFFICIAL.stats, maxHp: 1123 } },
  }));

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-override-editor-'));
    wsRoot = join(tmp, 'workshop');
    fs.mkdirSync(packDir(), { recursive: true });
    writeManifest([]);
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('没声明时：加载器拒绝这条覆盖、官方记录原样保留（声明是唯一入口）', async () => {
    writeHandWrittenOverride();
    writeManifest([]);
    const save = await post(`${editor.url}/api/packs/ws-pack/operators`, { spec: NEW_SPEC });
    assert.equal(save.status, 200, await save.text());
    // 编辑器这一侧不阻断（这条记录没有 spec 拥有它，regeneratePack 不会重校验它），
    // 真正把关的是加载器：没声明 ⇒ 整条被拒并保留官方记录（这才是「覆盖必须显式声明」的执法点）。
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.equal(data.chess[OFFICIAL_ID].stats.maxHp, OFFICIAL.stats.maxHp, '官方数值仍在');
    assert.equal(data.chess[OFFICIAL_ID].name, OFFICIAL.name);
  });

  test('声明之后：同一次保存放行（放行 + 记住声明是同一件活的两半）', async () => {
    writeManifest([`chess:${OFFICIAL_ID}`]);
    // 声明也要真的写回清单：这里用 withOverrideDeclarations 的半边来模拟保存时的自动补
    const before = JSON.parse(fs.readFileSync(join(packDir(), 'pack.json'), 'utf8'));
    assert.deepEqual(before.overrides, [`chess:${OFFICIAL_ID}`]);
    const save = await post(`${editor.url}/api/packs/ws-pack/operators`, { spec: NEW_SPEC });
    assert.equal(save.status, 200, await save.text());
  });

  test('加载器按新规则应用这条覆盖：包的数值赢、其它字段来自官方（A2）', () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.equal(data.chess[OFFICIAL_ID].stats.maxHp, 1123, '官方记录里包的数值生效');
    assert.equal(data.chess[OFFICIAL_ID].tier, OFFICIAL.tier, '没写的字段仍是官方值（字段合并）');
    assert.deepEqual(data.chess[OFFICIAL_ID].skill, OFFICIAL.skill, '行为字段整块来自覆盖 / 官方，不是半合并');
    assert.equal(Object.keys(data.chess[OFFICIAL_ID]).length, Object.keys(OFFICIAL).length, '44 字段还是 44 字段');
  });

  test('预览与保存同一个判罚：带 pack 看得到声明，不带 pack 等于今天的行为', async () => {
    const spec = { ...NEW_SPEC, id: 'ws_extra2' };
    const withPack = await post(`${editor.url}/api/preview`, { spec, pack: 'ws-pack' }).then((x) => x.json());
    assert.equal(withPack.ok, true, JSON.stringify(withPack.errors));
    const withoutPack = await post(`${editor.url}/api/preview`, { spec }).then((x) => x.json());
    assert.equal(withoutPack.ok, true, '新 id 在没有声明的上下文里也照样合法');
    // 坏 pack id 要被挡住（路径穿越）
    const bad = await post(`${editor.url}/api/preview`, { spec, pack: '../etc' });
    assert.equal(bad.status, 400);
  });
});
