// test/layout.test.js — 大图支持：一张地图自己的尺寸与分区（shared/layout.js）。
//
// 业主 2026-10-08：「你能稍微把地图做的更大些吗，加入对大图的支持怎么样，这样图会更多样化」。
//
// 这个文件守两件互相拉扯的事：
//   1. **官方零变化**：`layoutForSize(19×21)` 解出来的每一个数字都必须与历史常量逐字段相等，棋盘↔地图的映射也必须
//      与旧公式（普通恒等、boss 减 7、bossR 过 20 列镜像）逐格相等 —— 11 张官方图与素材靠这条不动。
//   2. **大图真的能玩**：三档尺寸的带位、部署矩形的形状、越界声明回落、以及一张 23×27 的图从授权到引擎到部署图全链。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GEO } from '../shared/constants.js';
import {
  OFFICIAL_LAYOUT, OFFICIAL_SIZE, SIZE_PRESETS, MIN_ROWS, MIN_COLS, MAX_ROWS, MAX_COLS,
  layoutForSize, normalizeLayout, layoutOf, isOfficialLayout, sizeOf, clampSize, isSize, sizePresetOf, presetStep,
  deployRectOf, deployRectName, stageRowOfBoard, stageColOfBoard, fieldTileOf, boardTileOf, viewRectOf,
} from '../shared/layout.js';
import {
  DEPLOY_RECTS, STAGE_ZONES, GATE_PAIRS, STAGE_ROWS, STAGE_COLS, zonesOf, deployRectsOf, gatePairsFor,
  deployRectsAt, roadsOutsideDeployRects, sampleStageSpec, validateStage, stageErrors,
} from '../shared/stageAuthoring.js';
import { deriveStage, validateStageRecord, deriveGroundPaths } from '../server/stageAuthoring.js';
import { buildDeployMap, fieldTile } from '../server/match/board.js';
import { ROWS, COLS } from '../server/sim/constants.js';
import { makeBattle, chessRec, enemyRec, checkInvariants } from './helpers/battleHarness.js';

const deep = (a, b, m) => assert.deepEqual(a, b, m);

describe('官方零变化：19×21 解出来的就是今天那一套', () => {
  test('画布 = 最大档位，官方尺寸 = 最小档位', () => {
    assert.equal(MAX_ROWS, GEO.CANVAS_ROWS, '画布行数就是最大档');
    assert.equal(MAX_COLS, GEO.CANVAS_COLS, '画布列数就是最大档');
    assert.equal(MIN_ROWS, GEO.ROWS, '最小档就是官方尺寸');
    assert.equal(MIN_COLS, GEO.COLS);
    assert.equal(ROWS, GEO.CANVAS_ROWS, 'sim 的步长是画布，不是地图窗口');
    assert.equal(COLS, GEO.CANVAS_COLS);
    deep(SIZE_PRESETS.map((p) => p.size), [[19, 21], [23, 27], [27, 33]]);
  });

  test('三块部署矩形与 stageAuthoring 的官方常量逐条相等（数组形状也一样）', () => {
    deep(OFFICIAL_LAYOUT.deployRects, DEPLOY_RECTS);
    deep(deployRectsOf(OFFICIAL_SIZE), DEPLOY_RECTS);
    deep(OFFICIAL_LAYOUT.deployRects.normal, [9, 12, 2, 10]);
    deep(OFFICIAL_LAYOUT.deployRects.bossLeft, [1, 5, 2, 10]);
    deep(OFFICIAL_LAYOUT.deployRects.bossRight, [1, 5, 10, 18]);
  });

  test('三个战斗矩形与 GEO 的官方常量相等，等待区与镜像轴也一致', () => {
    deep(OFFICIAL_LAYOUT.battle.normal, GEO.NORMAL_RECT);
    deep(OFFICIAL_LAYOUT.battle.unite, GEO.UNITE_RECT);
    deep(OFFICIAL_LAYOUT.battle.boss, GEO.BOSS_RECT);
    deep(OFFICIAL_LAYOUT.pen, { r0: 14, r1: 18, c0: 7, c1: 13 });
    assert.equal(OFFICIAL_LAYOUT.mirrorCol, 20, 'boss 右半场的镜像轴');
    deep(OFFICIAL_LAYOUT.size, [STAGE_ROWS, STAGE_COLS]);
    assert.ok(isOfficialLayout(OFFICIAL_LAYOUT));
    assert.ok(isOfficialLayout(undefined), '没有布局 = 官方');
  });

  test('棋盘↔地图的映射：普通恒等、boss 减 7、bossR 过 20 列镜像', () => {
    const L = OFFICIAL_LAYOUT;
    for (const field of ['normal', 'bossL', 'bossR']) {
      for (const [r, c] of [[9, 2], [10, 8], [12, 10], [7, 0], [8, 4]]) {
        const legacy = field === 'normal' ? [r, c] : [r - 7, field === 'bossR' ? 20 - c : c];
        deep(fieldTileOf(L, field, r, c), legacy, `${field} ${r},${c}`);
        deep(boardTileOf(L, field, legacy[0], legacy[1]), [r, c], `${field} 逆映射 ${r},${c}`);
      }
    }
    // 两个 boss 半场读同一块矩形（左右差别只在镜像）
    assert.equal(deployRectName('bossL'), deployRectName('bossR'));
    deep(deployRectOf(L, 'bossR'), deployRectOf(L, 'bossLeft'));
  });

  test('zonesOf 与官方的 STAGE_ZONES、GATE_PAIRS 与官方 12 对，都是同一份', () => {
    deep(zonesOf(OFFICIAL_SIZE), STAGE_ZONES.map((z) => ({ id: z.id, rows: [...z.rows], deployRects: [...z.deployRects] })));
    deep(zonesOf(OFFICIAL_SIZE).map((z) => z.rows), [[14, 18], [9, 12], [1, 5], [0, 18]]);
    assert.equal(gatePairsFor([], {}, OFFICIAL_SIZE), GATE_PAIRS, '官方尺寸下就是那 12 对');
  });

  test('取景矩形按 kind 取，官方与 GEO/相机预设同值', () => {
    deep(viewRectOf(OFFICIAL_LAYOUT, 'normal'), GEO.NORMAL_RECT);
    deep(viewRectOf(OFFICIAL_LAYOUT, 'unite'), GEO.UNITE_RECT);
    deep(viewRectOf(OFFICIAL_LAYOUT, 'boss'), GEO.BOSS_RECT);
    deep(viewRectOf(OFFICIAL_LAYOUT, 'prep'), { r0: 7, r1: 12, c0: 0, c1: 10 });
    deep(viewRectOf(OFFICIAL_LAYOUT, 'bossPrep'), { r0: 0, r1: 5, c0: 0, c1: 10 });
    deep(viewRectOf(OFFICIAL_LAYOUT, 'pen'), { r0: 14, r1: 18, c0: 7, c1: 13 });
  });
});

describe('大图：带位锚法、形状约束与回落', () => {
  test('三档尺寸的带位：等待区贴顶、普通带离顶第 7–10 行、boss 贴底第 1–5 行', () => {
    for (const { size } of SIZE_PRESETS) {
      const [R, C] = size;
      const L = layoutForSize(size);
      deep(L.size, size);
      deep(L.pen, { r0: R - 5, r1: R - 1, c0: 7, c1: 13 }, `${R}×${C} 等待区`);
      deep([L.deployRects.normal[0], L.deployRects.normal[1]], [R - 10, R - 7], `${R}×${C} 普通带`);
      deep([L.deployRects.bossLeft[0], L.deployRects.bossLeft[1]], [1, 5], `${R}×${C} boss 带`);
      deep(L.battle.unite, { r0: R - 10, r1: R - 7, c0: 0, c1: C - 1 }, `${R}×${C} 联防满宽`);
      deep(L.battle.boss, { r0: 0, r1: 5, c0: 0, c1: C - 1 }, `${R}×${C} boss 满宽`);
      // 三块矩形永远在窗口里，且之间的先后关系不变（中间战场在 boss 与普通之间）
      for (const [name, [r0, r1, c0, c1]] of Object.entries(L.deployRects)) {
        assert.ok(r0 >= 0 && r1 < R && c0 >= 0 && c1 < C, `${R}×${C} ${name} 在窗口里`);
      }
      assert.ok(L.battle.boss.r1 < L.deployRects.normal[0], `${R}×${C}: boss 带在普通带下方`);
      assert.ok(L.pen.r0 > L.deployRects.normal[1], `${R}×${C}: 等待区在普通带上方`);
      assert.ok(L.pen.r1 <= R - 1 && L.pen.r0 >= 0);
      assert.deepEqual(zonesOf(size).map((z) => z.rows), [[L.pen.r0, L.pen.r1], [R - 10, R - 7], [1, 5], [0, R - 1]]);
    }
  });

  test('部署矩形是棋盘本身的形状，且列被镜像几何定死：普通 4×9、boss 半场 5×9，只有行能动', () => {
    const L = layoutForSize([23, 27]);
    const bad = normalizeLayout({ deployRects: { normal: [0, 0, 0, 0], bossLeft: [1, 5, 2, 10] } }, [23, 27]);
    deep(bad.deployRects.normal, L.deployRects.normal, '形状不对 → 默认');
    deep(bad.deployRects.bossLeft, L.deployRects.bossLeft, '形状对、位置合法 → 保留');
    const outside = normalizeLayout({ deployRects: { normal: [20, 30, 2, 10] } }, [23, 27]);
    deep(outside.deployRects.normal, L.deployRects.normal, '越界 → 默认');
    // 挪行是允许的：整块上移 2 行
    const moved = normalizeLayout({ deployRects: { normal: [11, 14, 2, 10] } }, [23, 27]);
    deep(moved.deployRects.normal, [11, 14, 2, 10]);
    deep(fieldTileOf(moved, 'normal', 9, 2), [11, 2], '棋盘左上角跟着矩形走');
    // 挪列一律拉回定死的那两列：棋盘 9 列、两个半场在 col 10 相接，挪了列对战镜像就对不上了
    const colsMoved = normalizeLayout({ deployRects: { normal: [11, 14, 4, 12] } }, [23, 27]);
    deep(colsMoved.deployRects.normal, [11, 14, 2, 10], '列被归一化回 2..10');
  });

  test('镜像轴由那两列定死（20），声明的值说了不算', () => {
    assert.equal(normalizeLayout({ mirrorCol: 26 }, [23, 27]).mirrorCol, 20, '镜像轴不是可挑的参数');
    deep(deployRectOf(layoutForSize([27, 33]), 'bossRight'), [1, 5, 10, 18], '大图上 boss 半场列不变');
  });

  test('尺寸工具：合法区间、档位来回、脏值回落', () => {
    assert.ok(isSize([19, 21]) && isSize([27, 33]) && isSize([23, 25]));
    for (const bad of [[18, 21], [28, 33], [19, 20], [19], 'x', null, [19, 21, 1]]) assert.ok(!isSize(bad), JSON.stringify(bad));
    deep(clampSize([23, 27]), [23, 27]);
    deep(clampSize('nope'), [19, 21]);
    assert.equal(sizePresetOf([23, 27]), 'large');
    assert.equal(sizePresetOf([23, 25]), null, '自定尺寸没有档位名');
    assert.equal(presetStep('large', 1), 'huge');
    assert.equal(presetStep('huge', 1), 'huge', '到头就停');
    assert.equal(presetStep('standard', -1), 'standard');
    assert.equal(presetStep('nope', 1), 'large', '脏 id 当作第一档');
  });

  test('地图记录：没写 size/layout 的官方记录当作官方布局', () => {
    deep(sizeOf({}), [19, 21]);
    deep(sizeOf({ size: [23, 27] }), [23, 27]);
    deep(sizeOf({ size: [0, 0] }), [19, 21], '坏尺寸回落，不抛');
    assert.equal(isOfficialLayout(layoutOf({ id: 'x', rows: [] })), true);
    assert.equal(isOfficialLayout(layoutOf({ size: [23, 27] })), false);
    deep(layoutOf({ size: [23, 27] }).deployRects.normal, [13, 16, 2, 10]);
  });
});

describe('大图从授权到引擎：一张 23×27 的图真的能存、能画、能部署', () => {
  /** 一张合法的 23×27 图：上下留空气，中间整条道路，入口在左、目标在右。 */
  const bigRows = (R, C) => {
    const rows = [];
    for (let r = 0; r < R; r++) rows.push(r === 0 || r === R - 1 ? '-'.repeat(C) : 'r'.repeat(C));
    const put = (r, c, g) => { rows[r] = `${rows[r].slice(0, c)}${g}${rows[r].slice(c + 1)}`; };
    put(13, 0, 'S');
    put(13, C - 1, 'E');
    return rows;
  };
  const spec = () => ({
    ...sampleStageSpec(),
    id: 'ws_big_map',
    name: '大图样板',
    size: [23, 27],
    rows: bigRows(23, 27),
    routes: [{ motion: 'WALK', start: [13, 0], end: [13, 26], checkpoints: [] }],
  });

  test('校验：尺寸与行数逐条对得上，越界位置与变形分区都会报出来', () => {
    const ok = spec();
    assert.deepEqual(stageErrors(validateStage(ok)), []);
    const short = { ...ok, rows: ok.rows.slice(0, 19) };
    assert.ok(stageErrors(validateStage(short)).some((e) => e.code === 'BAD_SIZE'), '行数不对');
    const narrow = { ...ok, rows: ok.rows.map((l) => l.slice(0, 21)) };
    assert.ok(stageErrors(validateStage(narrow)).some((e) => e.code === 'BAD_SIZE'), '每行格数不对');
    const badSize = { ...ok, size: [18, 21] };
    assert.ok(stageErrors(validateStage(badSize)).some((e) => e.code === 'BAD_SIZE'), '比官方还小');
    const badRect = { ...ok, layout: { deployRects: { normal: [1, 3, 1, 9] } } };
    assert.ok(stageErrors(validateStage(badRect)).some((e) => e.code === 'BAD_LAYOUT'), '普通矩形不是 4×9');
    const outRect = { ...ok, layout: { deployRects: { normal: [21, 24, 2, 10] } } };
    assert.ok(stageErrors(validateStage(outRect)).some((e) => e.code === 'OUT_OF_BOUNDS'), '普通矩形越界');
    const badRoute = { ...ok, routes: [{ motion: 'WALK', start: [30, 0], end: [13, 26], checkpoints: [] }] };
    assert.ok(stageErrors(validateStage(badRoute)).some((e) => e.code === 'BAD_POS'), '路线起点越界');
  });

  test('派生：记录带上尺寸，deployTiles 按布局的矩形算，寻路走整张图', () => {
    const r = deriveStage(spec(), { paths: true });
    assert.ok(r.ok, JSON.stringify(r.errors));
    const rec = r.stage;
    deep(rec.size, [23, 27]);
    // 布局与这张 size 的默认布局相同 ⇒ 记录里不写 layout（老样子的小图记录因此与今天逐字节一样）
    assert.equal(rec.layout, undefined, '默认布局不写进记录');
    const L = layoutOf(rec);
    deep(L.deployRects.normal, [13, 16, 2, 10]);
    deep(L.pen, { r0: 18, r1: 22, c0: 7, c1: 13 });
    // 挪过分区才写 layout，而且写的是归一化后的那一份
    const moved = deriveStage({ ...spec(), layout: { deployRects: { normal: [11, 14, 2, 10] } } }, { paths: true });
    assert.ok(moved.ok, JSON.stringify(moved.errors));
    deep(moved.stage.layout.deployRects.normal, [11, 14, 2, 10]);
    deep(layoutOf(moved.stage).deployRects.normal, [11, 14, 2, 10]);
    // 整条路都是可部署的近战位，普通带 4×9 = 36 格全在里面
    assert.equal(rec.deployTiles.normal.melee.length, 36, '普通带整块可部署');
    assert.ok(rec.deployTiles.normal.melee.every(([rr]) => rr >= 13 && rr <= 16), '都落在普通带里');
    // 这张图的门是它自己的 S→E，不是官方那 12 对
    deep(Object.keys(rec.groundPaths), ['13,0->13,26']);
    assert.ok(rec.groundPaths['13,0->13,26'].length > 20, '路线横穿整张图');
    assert.deepEqual(validateStageRecord(rec, { id: rec.id }), []);
    // 官方那张 19×21 的样板图不受影响
    const small = deriveStage({ ...sampleStageSpec(), size: [19, 21] }, { paths: true });
    assert.ok(small.ok, JSON.stringify(small.errors));
    deep(small.stage.size, [19, 21]);
    assert.equal(small.stage.layout, undefined);
    assert.equal(gatePairsFor(small.stage.rows, small.stage.tiles, small.stage.size), GATE_PAIRS);
    deep(deriveGroundPaths({ ...small.stage, layout: undefined, size: undefined }), deriveGroundPaths(small.stage),
      '官方尺寸下有没有布局，派生出来的寻路表一样');
  });

  test('引擎：棋盘坐标经布局落到大图上，部署图与地图矩形一致', () => {
    const rec = deriveStage(spec(), { paths: true }).stage;
    const L = layoutOf(rec);
    assert.deepEqual(fieldTile('normal', 9, 2, L), [13, 2]);
    assert.deepEqual(fieldTile('bossL', 10, 8, L), [3, 8], 'boss 带没动');
    const normal = buildDeployMap(rec, { field: 'normal' });
    assert.equal(normal.get('9,2'), 'melee', '棋盘左上角 → 普通矩形左上角');
    assert.equal(normal.get('12,10'), 'melee');
    assert.equal(normal.size, 36, '普通带 4×9');
    const bossL = buildDeployMap(rec, { field: 'bossL' });
    assert.equal(bossL.get('10,8'), 'melee');
    const bossR = buildDeployMap(rec, { field: 'bossR' });
    assert.equal(bossR.get('10,8'), 'melee', '右半场过镜像轴，落在同一块矩形里');
  });

  test('一张 23×27 的图上真的能打：单位落在布局给的格子上，敌人沿路线走进战场', () => {
    const rec = deriveStage(spec(), { paths: true }).stage;
    const guard = chessRec({ id: 't_guard', profession: 'TANK', stats: { atk: 0, maxHp: 1e6, blockCnt: 3 }, skill: null });
    const walker = enemyRec({ key: 'enemy_walker', hp: 1e5, speed: 1 });
    const h = makeBattle({
      stage: rec, kind: 'normal', content: 'none',
      defs: { chess: { t_guard: guard }, enemies: { enemy_walker: walker } },
      units: [{ chessId: 't_guard', row: 10, col: 5 }],
      // 普通战场的竞技场是**玩家那一半**（cols 0–10），所以路线要走场内：官方门位那一行
      enemies: [{ key: 'enemy_walker', route: { motion: 'WALK', start: [13, 10], end: [13, 2], checkpoints: [] } }],
      autoFinish: false, timeLimit: 60,
    });
    const u = h.unit('t_guard');
    assert.equal(u.tileR, 14, '棋盘第 10 行 → 地图第 14 行（普通带 13–16）');
    assert.equal(u.tileC, 5);
    assert.deepEqual(h.b.rect, { r0: 13, r1: 16, c0: 0, c1: 10 }, '战斗矩形来自这张图的布局');
    h.step();
    const e = h.enemies()[0];
    assert.ok(e, '敌人出场');
    const x0 = e.x;
    h.run(6);
    assert.ok(e.x < x0, `敌人朝目标走（${x0.toFixed(2)} → ${e.x.toFixed(2)}）`);
    checkInvariants(h.b);
  });

  test('映射的往返性质：整备行 7 到棋盘底行 12，三档尺寸 × 三个部署场逐格回得来', () => {
    for (const { size } of SIZE_PRESETS) {
      const L = layoutForSize(size);
      for (const field of ['normal', 'bossL', 'bossR']) {
        for (let r = GEO.HAND_ROW; r <= GEO.FIELD.r1; r++) {
          // 行位移就是这条式子的全部：部署矩形的 r1 行 = 棋盘第 12 行（官方 normal → 恒等，bossLeft → 减 7）
          const expectRow = deployRectOf(L, field)[1] - (GEO.FIELD.r1 - r);
          assert.equal(stageRowOfBoard(L, field, r), expectRow, `${size} ${field} 行位移 ${r}`);
          for (const c of [0, 2, 6, 10, 12, 18]) {
            const [sr, sc] = fieldTileOf(L, field, r, c);
            assert.ok(sr >= 0 && sr < size[0] && sc >= 0 && sc < size[1], `${size} ${field} ${r},${c} → ${sr},${sc} 在窗口里`);
            assert.equal(sr, expectRow, `${size} ${field} ${r},${c} 落在位移后的那一行`);
            assert.equal(sc, stageColOfBoard(L, field, c), `${size} ${field} ${r},${c} 列`);
            deep(boardTileOf(L, field, sr, sc), [r, c], `${size} ${field} ${r},${c} 往返`);
          }
        }
      }
    }
  });

  test('编辑器视图：分区与部署矩形读数都按这张图的布局走', () => {
    const rec = deriveStage(spec(), { paths: true }).stage;
    const L = layoutOf(rec);
    const zones = zonesOf(rec.size);
    deep(zones.map((z) => z.id), ['pen', 'normal', 'boss', 'all']);
    deep(zones[0].rows, [18, 22]);
    deep(deployRectsAt(13, 2, L.deployRects), ['normal']);
    deep(deployRectsAt(1, 10, L.deployRects), ['bossLeft', 'bossRight'], '两个半场在中间那一列相接');
    deep(deployRectsAt(1, 12, L.deployRects), ['bossRight']);
    deep(deployRectsAt(9, 2, L.deployRects), [], '中间战场不在任何部署矩形里');
    // 中间战场上的道路：在部署行之外，编辑器要提示（这份图整条都是路，所以中间战场会被报出来）
    const roads = roadsOutsideDeployRects(rec.rows, rec.tiles, L.deployRects);
    assert.ok(roads.length > 0, '部署行里落在矩形外的道路会被提示');
    assert.ok(roads.every(([r, c]) => rec.rows[r][c] === 'r'), '报出来的都是道路');
    assert.ok(roads.every(([r, c]) => deployRectsAt(r, c, L.deployRects).length === 0), '报出来的一律不在部署矩形里');
  });
});
