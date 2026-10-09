// test/overrideMode.test.js — 覆盖模式的 A 段（只增不改：平行 id 函数 + 只读端点 + spec 标记）。
//
// A 段为什么可以单独落地：它**不碰保存路径、不碰 UI**，全部是纯新增。三件事各有自己的护身符：
//   ① `overrideChessIds` / `overrideEnemyKey` —— 护身符是「默认路径一字不变」：`chessIds` / `enemyKey` 对一组
//      输入必须与加这两个函数之前逐字相同（下面第一条）。
//   ② `spec.override` 标记 —— 护身符是「它不许漏进记录」：`chess.json` / `enemies.json` 的每一条都要过
//      `applyWorkshop` 的**闭合世界**检查（A2），多一个未知键整条会被拒。所以标记只活在 spec 层，
//      `deriveChessRecord` / `deriveEnemy` 只从它们认识的字段取值（下面第 2、3 条）。
//   ③ 两个只读端点 —— 护身符是「不写盘 + 挡路径穿越」。
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
  });

  test('GET /api/official/enemies/<key> 同形（一个 key）', async () => {
    const [key, rec] = OFFICIAL_ENEMY;
    const r = await fetch(`${editor.url}/api/official/enemies/${encodeURIComponent(key)}`).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.spec.override, true);
    assert.equal(r.ids.key, key);
    assert.equal(r.official.key, key);
    assert.equal(typeof rec.name === 'string', true);
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
