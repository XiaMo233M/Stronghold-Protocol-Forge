// test/render/bigmap-client.test.js — 大图支持的**客户端渲染层**（业主 2026-10-08：「你能稍微把地图做的更大些吗，加入
// 对大图的支持怎么样，这样图会更多样化」）。
//
// 服务端那一半由 test/layout.test.js 守（授权 → 引擎 → 部署图）。这里守客户端那一半：
//   1. **官方零变化**：不带 `size`/`layout` 的官方记录走每一个客户端辅助函数，解出来的都是历史数字（19×21、三块 GEO
//      矩形、官方相机、官方笔区 14–18 / 锚点 (15,7)(18,7)）；
//   2. **大图真的画自己的窗口**：一张 23×27 的图只解析自己的窗口、只画自己的行带、取景用 `fitCamera` 而不是官方相机、
//      笔（等待区）与棋盘↔地图映射都跟着它自己的分区走。
//
// 取景器（render/projection.js）与棋盘几何（render/board3d/layout.js）也各有自己的测试；这里断言的是**新的取景/分带
// 入口**：render/layout.js、render/app/view.js、render/tiles.js parseStage、render/pen.js、render/pick.js。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO } from '../../shared/constants.js';
import { layoutForSize, OFFICIAL_LAYOUT, isOfficialLayout } from '../../shared/layout.js';
import { sampleStageSpec } from '../../shared/stageAuthoring.js';
import { deriveStage } from '../../server/stageAuthoring.js';
import {
  layoutOf, layoutOfStage, mapSize, mapRectOf, rectForKind, normMapRect, fieldTile, boardTile, mirrorColOf,
} from '../../public/js/render/layout.js';
import { bandFor, fieldRows, boardArea, viewKind } from '../../public/js/render/app/view.js';
import { parseStage } from '../../public/js/render/tiles.js';
import { penRect, penZones, layoutPen, inPen, MAX_PREVIEW } from '../../public/js/render/pen.js';
import { hitTiles } from '../../public/js/render/pick.js';
import { presetCamera, fitCamera, pickTile } from '../../public/js/render/projection.js';
import { bossPrepField, tilesToDisp, bossDispMaxRow } from '../../public/js/render/prepfield.js';import { penZoneTiles, penPlacement } from '../../public/js/ui/gameLogic/enemies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stages = JSON.parse(readFileSync(path.join(ROOT, 'data/stages.json'), 'utf8'));
const OFFICIAL_STAGE_ID = 'act2autochess_m01';
const VP = { width: 1920, height: 1080 };

/** 一张合法的 23×27 大图（与 test/layout.test.js 的样板同一形状），带自己的 tile_start 门与 target 目标。 */
function bigMap() {
  const R = 23, C = 27;
  const rows = [];
  for (let r = 0; r < R; r++) rows.push(r === 0 || r === R - 1 ? '-'.repeat(C) : 'r'.repeat(C));
  const put = (r, c, g) => { rows[r] = `${rows[r].slice(0, c)}${g}${rows[r].slice(c + 1)}`; };
  for (const c of [8, 12, 16, 20]) put(10, c, 'b');       // 中间战场的管栏（可部署）
  put(17, 0, 'S');                                        // 普通带的门
  put(18, 7, 'S'); put(22, 7, 'S');                       // 这张图自己的笔：两个门锚点
  put(13, 4, 'E');                                        // 普通带里的目标
  const rec = deriveStage({ ...sampleStageSpec(), id: 'ws_big_client', name: '大图', size: [R, C], rows,
    routes: [{ motion: 'WALK', start: [13, 0], end: [13, 26], checkpoints: [] }] }, { paths: true });
  assert.ok(rec.ok, JSON.stringify(rec.errors));
  return rec.stage;
}
const BIG = bigMap();
const BIG_L = layoutOf(BIG);

describe('客户端渲染层的窗口：官方记录 = 历史数字，大图 = 自己的分区', () => {
  test('layoutOf / mapSize：官方 19×21，大图 23×27', () => {
    for (const st of Object.values(stages)) {
      assert.deepEqual(mapSize(layoutOf(st)), [GEO.ROWS, GEO.COLS], st.id);
    }
    assert.deepEqual(mapSize(BIG_L), [23, 27]);
    assert.deepEqual(mapSize(layoutOfStage(undefined)), [19, 21], '没有 stage 就是官方窗口');
    assert.ok(isOfficialLayout(layoutOfStage(undefined)), '没有 stage 就是官方布局');
  });

  test('mapRectOf：官方的每个 kind 都等于历史常量，大图是它自己的带位', () => {
    assert.deepEqual(mapRectOf(null, 'normal'), GEO.NORMAL_RECT);
    assert.deepEqual(mapRectOf(null, 'unite'), GEO.UNITE_RECT);
    assert.deepEqual(mapRectOf(null, 'boss'), GEO.BOSS_RECT);
    assert.deepEqual(mapRectOf(null, 'prep'), { r0: 7, r1: 12, c0: 0, c1: 10 });
    assert.deepEqual(mapRectOf(null, 'bossPrep'), { r0: 0, r1: 5, c0: 0, c1: 10 });
    assert.deepEqual(mapRectOf(null, 'pen'), { r0: 14, r1: 18, c0: 7, c1: 13 });
    assert.deepEqual(mapRectOf(null, 'bossL'), GEO.BOSS_RECT, '部署场名 → 它的战斗矩形');
    // 23×27：等待区贴顶 18–22，普通带 13–16（整备区一行 → prep 12–16），boss 带仍是 0–5
    assert.deepEqual(mapRectOf(BIG_L, 'pen'), { r0: 18, r1: 22, c0: 7, c1: 13 });
    assert.deepEqual(mapRectOf(BIG_L, 'prep'), { r0: 11, r1: 16, c0: 0, c1: 10 }, '整备区 + 普通带（battle.prep）');
    assert.deepEqual(mapRectOf(BIG_L, 'normal'), { r0: 13, r1: 16, c0: 0, c1: 10 });
    assert.deepEqual(mapRectOf(BIG_L, 'unite'), { r0: 13, r1: 16, c0: 0, c1: 26 }, '联防满宽 = 这张图的宽度');
    assert.deepEqual(mapRectOf(BIG_L, 'boss'), { r0: 0, r1: 5, c0: 0, c1: 26 });
  });

  test('rectForKind：服务器给的 rect 优先，归一化到这张图自己的窗口', () => {
    const srv = { r0: 13, r1: 16, c0: 0, c1: 10 };
    assert.deepEqual(rectForKind('normal', BIG_L, srv), srv);
    assert.deepEqual(rectForKind('normal', BIG_L, { r0: 40, r1: 90, c0: 0, c1: 99 }), { r0: 22, r1: 22, c0: 0, c1: 26 }, '夹到 23×27');
    assert.deepEqual(rectForKind('normal', null, null), GEO.NORMAL_RECT, '没有 rect 也没有布局 = 官方常量');
    assert.deepEqual(rectForKind('prep', null, null), { r0: 7, r1: 12, c0: 0, c1: 10 });
    // 官方布局 + 服务器 rect 原样返回（官方 19×21 的窗口）
    assert.deepEqual(normMapRect(null, { r0: 9, r1: 12, c0: 0, c1: 10 }), GEO.NORMAL_RECT);
    assert.deepEqual(normMapRect(null, { r0: 9, r1: 30, c0: 0, c1: 10 }), { r0: 9, r1: 18, c0: 0, c1: 10 });
    assert.deepEqual(normMapRect(BIG_L, { r0: 9, r1: 30, c0: 0, c1: 99 }), { r0: 9, r1: 22, c0: 0, c1: 26 });
  });

  test('viewKind：大图的 boss 准备阶段也认出来（矩形 r1 ≤ 6 是地图坐标）', () => {
    assert.equal(viewKind('prep', { rect: mapRectOf(BIG_L, 'bossPrep') }, BIG_L), 'bossPrep');
    assert.equal(viewKind('prep', { rect: mapRectOf(BIG_L, 'prep') }, BIG_L), 'prep');
    assert.equal(viewKind('prep', { rect: { r0: 0, r1: 5, c0: 0, c1: 26 } }, BIG_L), 'bossPrep');
    assert.equal(viewKind('bogus', null, BIG_L), 'normal');
    assert.equal(viewKind('hidden', null, BIG_L), 'boss');
  });

  test('带位（bandFor / fieldRows）：官方与历史一致，大图跟着自己的分区上移', () => {
    for (const kind of ['prep', 'normal', 'unite']) {
      assert.deepEqual(bandFor(kind), [6, 13], kind);
      assert.deepEqual(fieldRows(kind), [6, 13], kind);
    }
    assert.deepEqual(bandFor('boss'), [0, 13]);
    assert.deepEqual(fieldRows('bossPrep'), [0, 13], 'boss 准备区的行带到板凳下的墙');
    assert.deepEqual(bandFor('pen'), [6, 18]);
    assert.deepEqual(fieldRows('pen'), [6, 18]);
    // 行带的下界是板凳下那堵墙（官方第 6 行 = boss 带 0–5 上方一行），上界跟着这张图的等待区 / 普通带
    assert.equal(bandFor('prep')[0], OFFICIAL_LAYOUT.battle.boss.r1 + 1);
    assert.equal(fieldRows('prep')[0], OFFICIAL_LAYOUT.battle.boss.r1 + 1);
    assert.equal(bandFor('prep', BIG_L)[0], BIG_L.battle.boss.r1 + 1, '大图的墙仍是第 6 行（boss 带没有动）');
    assert.equal(bandFor('pen', BIG_L)[1], BIG_L.pen.r1, '笔带的底 = 这张图等待区的底');
    // 23×27：普通带 13–16（上隔墙 17），等待区 18–22，boss 带 0–5 + 墙 6
    assert.deepEqual(bandFor('prep', BIG_L), [6, 17]);
    assert.deepEqual(fieldRows('prep', BIG_L), [6, 17]);
    assert.deepEqual(bandFor('boss', BIG_L), [0, 17]);
    assert.deepEqual(fieldRows('boss', BIG_L), [0, 17]);
    assert.deepEqual(bandFor('pen', BIG_L), [6, 22]);
    assert.deepEqual(fieldRows('pen', BIG_L), [6, 22]);
  });

  test('boardArea：官方返回历史矩形，大图平移出它自己的场与笔', () => {
    assert.deepEqual(boardArea('prep'), [{ r0: 6, r1: 13, c0: 0, c1: 10 }]);
    assert.deepEqual(boardArea('boss'), [{ r0: 0, r1: 6, c0: 0, c1: 20 }]);
    assert.deepEqual(boardArea('pen'), [
      { r0: 6, r1: 13, c0: 0, c1: 10 }, { r0: 13, r1: 18, c0: 6, c1: 14 },
    ]);
    assert.deepEqual(boardArea('unite'), [{ r0: 6, r1: 13, c0: 0, c1: 20 }]);
    // 大图：行上移 4，列加宽 6
    assert.deepEqual(boardArea('prep', BIG_L), [{ r0: 10, r1: 17, c0: 0, c1: 16 }]);
    assert.deepEqual(boardArea('boss', BIG_L), [{ r0: 4, r1: 10, c0: 0, c1: 26 }]);
    assert.deepEqual(boardArea('pen', BIG_L), [
      { r0: 10, r1: 17, c0: 0, c1: 16 }, { r0: 17, r1: 22, c0: 6, c1: 20 },
    ]);
  });
});

describe('客户端只画这张图自己的窗口', () => {
  test('parseStage：官方 19×21、11 张官方图逐格不变', () => {
    for (const [id, st] of Object.entries(stages)) {
      const g = parseStage(st);
      assert.equal(g.length, 19, id);
      assert.equal(g[0].length, 21, id);
      assert.deepEqual(mapSize(g.layout), [19, 21], id);
    }
  });

  test('parseStage：23×27 的图解析成 23×27（不是画布 27×33，也不是官方 19×21）', () => {
    const g = parseStage(BIG);
    assert.equal(g.length, 23);
    assert.equal(g[0].length, 27);
    assert.deepEqual(mapSize(g.layout), [23, 27]);
    // 井字的门落在它自己的行上（普通带 17，笔的锚点 18 / 22）
    assert.equal(g[17][0].glyph, 'S');
    assert.equal(g[18][7].glyph, 'S');
    assert.equal(g[22][7].glyph, 'S');
    assert.equal(g[13][4].glyph, 'E');
    // 行带之外不画
    const field = parseStage(BIG, [6, 17], [6, 17]);
    for (let c = 0; c < 27; c++) assert.equal(field[22][c].drawn, false, `笔行 22,${c} 不在带里`);
    const pen = parseStage(BIG, [6, 22], [6, 22]);
    assert.ok(pen[20][10].drawn, '笔里的地形画出来了');
  });

  test('penRect / penZones：官方 (14,7)–(18,13) 不变，大图用自己的笔与自己的两格门', () => {
    const off = penRect(stages[OFFICIAL_STAGE_ID]);
    assert.deepEqual(off, { r0: 14, r1: 18, c0: 7, c1: 13 });
    assert.deepEqual(penRect(null), { r0: 14, r1: 18, c0: 7, c1: 13 });
    const z = penZones(stages[OFFICIAL_STAGE_ID]);
    assert.equal(z.lower.tiles.length, 13);
    assert.equal(z.upper.tiles.length, 13);
    assert.deepEqual(z.lower.anchor, [15, 7]);
    assert.deepEqual(z.upper.anchor, [18, 7]);
    assert.deepEqual(z.rect, off);
    // 大图：笔在 18–22（它自己声明的两个 tile_start 门），两区按曼哈顿最近锚点分（引擎与兜底视图同一套）
    assert.deepEqual(penRect(BIG), { r0: 18, r1: 22, c0: 7, c1: 13 });
    const zb = penZones(BIG);
    assert.deepEqual(zb.rect, { r0: 18, r1: 22, c0: 7, c1: 13 });
    assert.deepEqual(zb.lower.anchor, [18, 7]);
    assert.deepEqual(zb.upper.anchor, [22, 7]);
    const all = [...zb.lower.tiles, ...zb.upper.tiles];
    assert.ok(all.length > 0, '大图的笔里有站位');
    assert.ok(zb.lower.tiles.every(([r]) => r >= 18 && r <= 20), JSON.stringify(zb.lower.tiles));
    assert.ok(zb.upper.tiles.every(([r]) => r >= 21 && r <= 22), JSON.stringify(zb.upper.tiles));
    assert.ok(!all.some(([r, c]) => (r === 18 && c === 7) || (r === 22 && c === 7)), '门格不是站位');
    // 每一格都被分进了一个区，且是按曼哈顿距离分给最近的那个锚点的
    for (const [r, c] of all) {
      const mine = Math.abs(r - 18) + Math.abs(c - 7), other = Math.abs(r - 22) + Math.abs(c - 7);
      const zone = mine <= other ? 'lower' : 'upper';
      assert.ok((zone === 'lower' ? zb.lower : zb.upper).tiles.some(([rr, cc]) => rr === r && cc === c), `${r},${c} 应属 ${zone}`);
    }
    assert.equal(new Set(all.map(([r, c]) => `${r},${c}`)).size, all.length, '没有一格被分进两个区');
    assert.deepEqual(zb.zones.map((x) => x.anchor), [[18, 7], [22, 7]]);
  });

  test('penZoneTiles / penPlacement（DOM 兜底视图）：官方历史值，大图跟自己的笔', () => {
    assert.equal(penZoneTiles('lower').length, 13);
    assert.equal(penZoneTiles('upper').length, 13);
    assert.deepEqual(penZoneTiles('lower')[0], [14, 7]);
    assert.ok(penZoneTiles('lower').every(([r]) => r === 14 || r === 15));
    assert.ok(penZoneTiles('upper').every(([r]) => r === 17 || r === 18));
    assert.deepEqual(penZoneTiles('upper', { stage: BIG })[0], [21, 7], '大图的上区从它的第 21 行起');
    assert.ok(penZoneTiles('upper', { stage: BIG }).every(([r]) => r >= 21 && r <= 22));
    assert.ok(penZoneTiles('lower', { stage: BIG }).every(([r]) => r >= 18 && r <= 20), JSON.stringify(penZoneTiles('lower', { stage: BIG })));
    // 兜底视图的两区 = 引擎的两区（同一套锚点，无重叠、合起来正好是笔里的每一格站位）
    const bigZones = penZones(BIG);
    const engTiles = [...bigZones.lower.tiles, ...bigZones.upper.tiles].map(([r, c]) => `${r},${c}`);
    const domTiles = [...penZoneTiles('lower', { stage: BIG }), ...penZoneTiles('upper', { stage: BIG })].map(([r, c]) => `${r},${c}`);
    assert.deepEqual(domTiles.sort(), engTiles.sort(), 'DOM 兜底的两区与引擎一致');
    // 引擎与兜底视图摆在同一格上（大图也一样）
    const list = [
      { enemyKey: 'a', count: 30, gate: 'lower', t: 1 },
      { enemyKey: 'b', count: 20, gate: 'upper', t: 2 },
      { enemyKey: 'c', count: 4, gate: 'lower', t: 3, elite: true },
    ];
    const dom = penPlacement(list, { stage: BIG });
    const eng = layoutPen(list, { stage: BIG }).figures;
    assert.deepEqual(dom.map((m) => [m.enemyKey, m.row, m.col]), eng.map((f) => [f.enemyKey, f.row, f.col]));
    assert.ok(dom.every((m) => inPen(m.row, m.col, penRect(BIG))));
    assert.ok(dom.filter((m) => m.gate === 'lower').every((m) => m.row <= 20), JSON.stringify(dom));
    assert.ok(dom.filter((m) => m.gate === 'upper').every((m) => m.row >= 21), JSON.stringify(dom));
    assert.ok(dom.length <= MAX_PREVIEW);
  });

  test('hitTiles：夹到这张图自己的窗口（官方 19×21 是默认，大图不被裁在 19 行）', () => {
    const area = { w: 3, h: 3, dx: 0, dy: 0 };
    assert.deepEqual(hitTiles(10, 12, null), [[12, 10]], '点单位 = 它自己那一格');
    assert.deepEqual(hitTiles(10, 22, null), [], '官方窗口外');
    assert.deepEqual(hitTiles(10, 22, null, 23, 27), [[22, 10]], '大图的第 22 行是合法的');
    assert.deepEqual(hitTiles(10, 12, area), [[11, 9], [11, 10], [11, 11], [12, 9], [12, 10], [12, 11], [13, 9], [13, 10], [13, 11]]);
    assert.deepEqual(hitTiles(10, 20, area, 23, 27), [[19, 9], [19, 10], [19, 11], [20, 9], [20, 10], [20, 11], [21, 9], [21, 10], [21, 11]]);
    assert.deepEqual(hitTiles(25, 20, area, 23, 27), [[19, 24], [19, 25], [19, 26], [20, 24], [20, 25], [20, 26], [21, 24], [21, 25], [21, 26]], '行与列都夹到 23×27');
  });
});

describe('相机：官方图用官方预设，大图用 fitCamera 取自己的矩形', () => {
  test('官方 19×21 的取景与不带布局参数时逐位一致', () => {
    for (const kind of ['prep', 'normal', 'unite', 'boss', 'bossPrep', 'pen']) {
      const a = presetCamera(kind, VP, { side: 'L', hud: { top: 216, bottom: 267 } });
      const b = presetCamera(kind, VP, { side: 'L', hud: { top: 216, bottom: 267 }, layout: OFFICIAL_LAYOUT });
      assert.deepEqual(b.params(), a.params(), kind);
    }
    const off = presetCamera('prep', VP, { hud: { top: 216, bottom: 267 } });
    const off2 = presetCamera('prep', VP, { hud: { top: 216, bottom: 267 }, layout: layoutOf(stages[OFFICIAL_STAGE_ID]) });
    assert.deepEqual(off2.params(), off.params(), '官方记录的布局 = 官方布局');
  });

  test('大图的每个 kind 都用 fitCamera：矩形完整落在视口里，且不是官方相机', () => {
    for (const kind of ['prep', 'normal', 'unite', 'boss', 'bossPrep', 'pen']) {
      const rect = rectForKind(kind, BIG_L, null);
      const cam = presetCamera(kind, VP, { rect, layout: BIG_L });
      assert.notDeepEqual(cam.params(), presetCamera(kind, VP).params(), `${kind}: 大图不走官方预设`);
      // 取景中心就是这张图那个矩形的中心
      assert.equal(cam.tx, (rect.c0 + rect.c1) / 2, `${kind}: tx`);
      assert.equal(cam.ty, (rect.r0 + rect.r1) / 2, `${kind}: ty`);
      // 矩形的四角都在视口里
      for (const x of [rect.c0 - 0.5, rect.c1 + 0.5]) for (const y of [rect.r0 - 0.5, rect.r1 + 0.5]) {
        const p = cam.project(x, y, 0);
        assert.ok(p.x > 0 && p.x < VP.width && p.y > 0 && p.y < VP.height, `${kind} (${x},${y}) → ${p.x},${p.y}`);
      }
      assert.ok(Number.isFinite(cam.scale) && cam.scale > 0, `${kind}: 有效焦距`);
      // 同一个请求重复问两次是同一个相机（取景是纯函数）
      assert.deepEqual(presetCamera(kind, VP, { rect, layout: BIG_L }).params(), cam.params(), kind);
    }
  });

  test('大图的取景走 fitCamera 的那条路（isOfficialLayout 为假）：同一个矩形给出同一个相机', () => {
    const rect = rectForKind('normal', BIG_L, null);
    const viaPreset = presetCamera('normal', VP, { rect, layout: BIG_L });
    const direct = fitCamera(rect, VP, { tilt: 30, dist: 13, margin: 0.45, headroom: 1.35, rows: 23, cols: 27 });
    assert.deepEqual(direct.params(), viaPreset.params(), 'presetCamera 的大图路径就是 fitCamera');
    const off = fitCamera(GEO.NORMAL_RECT, { width: 1600, height: 900 }, {});
    const off2 = fitCamera(GEO.NORMAL_RECT, { width: 1600, height: 900 }, { rows: 19, cols: 21 });
    assert.deepEqual(off2.params(), off.params(), '官方窗口下 fitCamera 的默认不变');
  });

  test('pickTile：大图的指针落在窗口里（默认仍是官方 19×21）', () => {
    const cam = presetCamera('prep', VP, { rect: rectForKind('prep', BIG_L, null), layout: BIG_L });
    const heights = () => 0;
    const inside = pickTile(cam, cam.cx, cam.cy, heights, [0], 23, 27);
    assert.ok(inside && inside.row >= 0 && inside.row < 23 && inside.col >= 0 && inside.col < 27, JSON.stringify(inside));
    const off = presetCamera('prep', VP);
    const hit = pickTile(off, off.cx, off.cy, heights, [0]);
    assert.ok(hit && hit.row >= 0 && hit.row < 19 && hit.col >= 0 && hit.col < 21);
  });
});

describe('棋盘↔地图（客户端与服务器同一套布局）', () => {
  test('官方布局：普通恒等、boss 减 7、bossR 过 20 列镜像', () => {
    for (const [field, r, c] of [['normal', 9, 2], ['normal', 12, 10], ['bossL', 10, 8], ['bossR', 11, 4]]) {
      const legacy = field === 'normal' ? [r, c] : [r - 7, field === 'bossR' ? 20 - c : c];
      assert.deepEqual(fieldTile(field, r, c), legacy, `${field} ${r},${c}`);
      assert.deepEqual(boardTile(field, legacy[0], legacy[1]), [r, c], `${field} 逆映射`);
    }
    assert.equal(mirrorColOf(null), 20);
  });

  test('大图：棋盘跟着部署矩形走，bossR 过它自己的镜像轴（仍是 20）', () => {
    assert.deepEqual(fieldTile('normal', 9, 2, BIG_L), [13, 2], '棋盘左上角 → 普通矩形左上角');
    assert.deepEqual(fieldTile('normal', 12, 10, BIG_L), [16, 10]);
    assert.deepEqual(fieldTile('bossL', 10, 8, BIG_L), [3, 8], 'boss 带没动');
    assert.deepEqual(fieldTile('bossR', 10, 8, BIG_L), [3, 12]);
    assert.deepEqual(boardTile('bossR', 3, 12, BIG_L), [10, 8]);
    assert.equal(mirrorColOf(BIG_L), 20);
  });

  test('大图的布局带着它自己的 23×27 窗口与三块部署矩形（layoutForSize）', () => {
    const L = layoutForSize([23, 27]);
    assert.deepEqual(L.size, [23, 27]);
    assert.deepEqual(L.deployRects.normal, [13, 16, 2, 10]);
    assert.deepEqual(L.deployRects.bossLeft, [1, 5, 2, 10]);
    assert.deepEqual(penRect({ size: [23, 27] }), { r0: 18, r1: 22, c0: 7, c1: 13 });
    assert.deepEqual(fieldTile('normal', 9, 2, L), [13, 2]);
  });

  test('bossPrepField(side, layout)：官方与历史变换逐格相等，大图带自己的布局', () => {
    for (const side of ['L', 'R']) {
      const xf = bossPrepField(side);
      const legacy = bossPrepField(side, OFFICIAL_LAYOUT);
      for (const [r, c] of [[9, 2], [10, 8], [12, 10], [7, 0], [8, 4]]) {
        assert.deepEqual(xf.toDisp(r, c), legacy.toDisp(r, c), `${side} ${r},${c}`);
        assert.deepEqual(legacy.toDisp(r, c), { row: r - 7, col: side === 'R' ? 20 - c : c });
      }
      assert.deepEqual(xf.toBoard(2, 2), legacy.toBoard(2, 2));
      assert.equal(xf.kind, 'bossPrep');
      assert.equal(xf.mirror, side === 'R');
      assert.equal(bossDispMaxRow(OFFICIAL_LAYOUT), 6, 'boss 带 0–5 + 上方一堵墙');
    }
    // 大图：同一个变换，行位移由它自己的 boss 矩形给出（服务器 match/board.js fieldTile 的同一套 layout）
    const big = bossPrepField('L', BIG_L);
    assert.equal(big.layout, BIG_L);
    assert.deepEqual(big.toDisp(13, 2), { row: fieldTile('bossL', 13, 2, BIG_L)[0], col: fieldTile('bossL', 13, 2, BIG_L)[1] }, '大图与 fieldTile 同一个变换');
    // 棋盘自己的行（7–12，也就是 prep 的 11–16 里落在 boss 带内的那一段）来回一致
    for (let r = 9; r <= 12; r++) for (let c = 2; c <= 10; c++) {
      const d = big.toDisp(r, c);
      assert.deepEqual(big.toBoard(d.row, d.col), { row: r, col: c }, `大图来回 ${r},${c}`);
    }
    assert.equal(bossDispMaxRow(BIG_L), 6);
    assert.deepEqual(tilesToDisp(big, [[12, 2]]), [[5, 2]], '棋盘第 12 行 → boss 第 5 行（这张图 boss 带的顶行）');
    assert.equal(big.toBoard(6, 8), null, '不在 boss 带（第 6 行是带上方的墙）');
    assert.equal(big.toBoard(2, 11), null, '左半场不含第 11 列');
    for (const [r, c] of [[6, 2], [6, 8], [2, 11], [0, 11], [5, 11], [0, 20]]) {
      assert.equal(big.toBoard(r, c), null, `左半场的窗口外 ${r},${c}`);
    }
    // 服务器 fieldTile 的行位移是按**普通带**定的（shared/layout.js stageRowOfBoard：rect[1] − (GEO.FIELD.r1 − boardRow)），
    // 所以只有棋盘 7–12 落在这张图的 boss 带里；棋盘 13 会落到带外的第 6 行（这是服务器侧的既有语义，客户端照搬）
    assert.deepEqual(big.toDisp(13, 2), { row: 6, col: 2 });
    assert.equal(big.toBoard(6, 2), null, '带外的行不当作棋盘格');
    assert.equal(bossPrepField('R', BIG_L).toBoard(2, 9), null, '右半场不含第 9 列');
    assert.equal(bossPrepField('R', BIG_L).toBoard(6, 18), null, '右半场也在 boss 带之内');
    assert.deepEqual(bossPrepField('R', BIG_L).toBoard(5, 10), { row: 12, col: 10 }, '右半场与左半场相接的那条列');
  });
});
