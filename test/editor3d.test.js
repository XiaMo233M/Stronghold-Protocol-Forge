// test/editor3d.test.js — 地图编辑器 3D 预览的相机：滚轮缩放必须**真的把棋盘放大**。
//
// 业主 2026-10-08：「为什么现在的编辑地图的 3d 视角缩放没有感觉到 3d 地图在放大」。
//
// 原因不是手感，是数学：public/js/render/projection.js 的相机是离轴针孔相机，焦距 k = scale·dist，
// 屏幕上 = 中心 + k·横向偏移/depth，所以在靶面（depth = dist）上比例正好是 `scale`。老写法只把 `dist` 拉大、
// `scale` 不动 ⇒ 相机后退的同时视场角等比放大，画面里的棋盘**一模一样大**（实测一格只差 0.3%，肉眼等于没动，
// 而预览又把雾推到 400/1000，连深度线索都没有）。所以缩放改 `scale`，`dist` 反向跟随，焦距不变。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Camera } from '../public/js/render/projection.js';
import { zoomCamera, ZOOM_STEP } from '../editor/ui/stage3d.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'editor/ui/stage3d.js'), 'utf8');

/** 与预览同一套初始光学：19×21 整图取景（scale ≈ cssH/(21+3)）、俯角 52°、dist 30。 */
const camera = () => {
  const c = new Camera({ tx: 10, ty: 9, tz: 0, tilt: 52, dist: 30, scale: 25, cx: 960, cy: 540 });
  c.update();
  return c;
};
/** 棋盘在屏幕上的纵向跨度（靶点上下各 5 格），px —— 「看得多大」的可测量代理。 */
const span = (c) => {
  const a = c.project(c.tx, c.ty - 5, 0);
  const b = c.project(c.tx, c.ty + 5, 0);
  return Math.hypot(b.x - a.x, b.y - a.y);
};

describe('3D 预览的滚轮缩放', () => {
  test('老写法（只改 dist）等于没动：一格只差 0.3%，这就是业主报的那条', () => {
    const base = camera();
    const before = span(base);
    const old = camera();
    old.dist = 30 * ZOOM_STEP;          // 曾经的做法：dist 拉远、scale 不动
    old.update();
    const ratio = span(old) / before;
    assert.ok(ratio > 0.99 && ratio < 1.003, `只改 dist 时画面几乎不变（实测 ${ratio.toFixed(4)}）`);
  });

  test('推近一格棋盘真的变大（+10%），且焦距 scale·dist 严格不变 ⇒ 是推近不是换镜头', () => {
    const c = camera();
    const before = span(c);
    const focal = c.scale * c.dist;
    const applied = zoomCamera(c, -1, { minScale: 1, maxScale: 400 });
    c.update();
    assert.ok(Math.abs(applied - ZOOM_STEP) < 1e-12, '一格正好一个倍率');
    assert.ok(span(c) / before > 1.08, `一格要肉眼看得出来（实测 ×${(span(c) / before).toFixed(3)}）`);
    assert.ok(c.dist < 30, '相机真的往里走了');
    assert.ok(Math.abs(c.scale * c.dist - focal) < 1e-9 * focal, '焦距不变 ⇒ 垂直视场角不变');
  });

  test('推近六格 ≈ 1.84 倍；一进一出精确回到原样', () => {
    const base = camera();
    const before = span(base);
    const c = camera();
    for (let i = 0; i < 6; i++) zoomCamera(c, -1, { minScale: 1, maxScale: 400 });
    c.update();
    assert.ok(span(c) / before > 1.8, `六格要有明显推进（实测 ×${(span(c) / before).toFixed(3)}）`);
    const back = camera();
    zoomCamera(back, -1, {});
    zoomCamera(back, 1, {});
    back.update();
    assert.ok(Math.abs(span(back) - before) < 1e-9, '上下一格互为逆运算');
  });

  test('上限：scale 夹在调用方给的区间里，dist 也留在可用范围内', () => {
    const c = camera();
    const limits = { minScale: 25 / 12, maxScale: 25 * 12, minDist: 3, maxDist: 400 };
    for (let i = 0; i < 80; i++) zoomCamera(c, -1, limits);
    assert.ok(Math.abs(c.scale - limits.maxScale) < 1e-9, '放到上限就停');
    assert.ok(c.dist >= limits.minDist, `dist 不越过下限（${c.dist}）`);
    for (let i = 0; i < 200; i++) zoomCamera(c, 1, limits);
    assert.ok(Math.abs(c.scale - limits.minScale) < 1e-9, '缩到下限就停');
    assert.ok(c.dist <= limits.maxDist, `dist 不越过上限（${c.dist}）`);
    assert.ok(Number.isFinite(c.scale) && c.scale > 0 && Number.isFinite(c.dist) && c.dist > 0);
  });

  test('滚轮处理器走 zoomCamera，且上下限按「整图取景」的比例给（老写法不许回来）', () => {
    assert.match(SRC, /zoomCamera\(cam, ev\.deltaY, \{/, 'onWheel 必须调 zoomCamera');
    assert.match(SRC, /minScale: home\.scale \/ 12, maxScale: home\.scale \* 12/,
      '上下限按整图取景的比例：最多缩到 1/12、放到 12 倍');
    assert.doesNotMatch(SRC, /cam\.dist = Math\.max\(8, Math\.min\(90, cam\.dist \* /,
      '只改 dist 的老写法必须消失（那等于没缩放）');
    // stats() 要把 scale 报出来，否则「缩放在不在工作」只能靠肉眼
    assert.match(SRC, /stats: \(\) => \(\{ frames, dist: Math\.round\(cam\.dist\), tilt: Math\.round\(cam\.tilt\), scale: Math\.round\(cam\.scale\)/);
  });
});
