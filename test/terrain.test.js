// test/terrain.test.js — 出怪页路线画布上的「真实底图」（editor/ui/terrain.js）。
//
// 为什么值得有它：路线定义在地图页、引用在出怪页，而画布此前只有一张空网格 —— 作者要对着另一页抄坐标，
// 抄错一格就是「怪从墙里出来」这种极难查的问题。这里钉住两件纯事：地形怎么归一化（缺行/短行不能画出半张图），
// 以及取色的兜底（不认识的字符必须有颜色，否则画布上是一片透明）。
// 另外用一次 HTTP 断言服务端确实把地形与调色板送了过来 —— 那是这层的地基。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { terrainGrid, colorOfGlyph, stageById } from '../editor/ui/terrain.js';
import { createEditorServer } from '../editor/server.mjs';
import { TILE_PALETTE, STAGE_ROWS, STAGE_COLS } from '../shared/stageAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'stages.json'), 'utf8'));

describe('底图：地形归一化', () => {
  test('官方真实地图能整张画出来（19×21）', () => {
    const id = Object.keys(OFFICIAL)[0];
    const g = terrainGrid(OFFICIAL[id], { rows: STAGE_ROWS, cols: STAGE_COLS });
    assert.equal(g.length, STAGE_ROWS);
    assert.equal(g[0].length, STAGE_COLS);
    assert.equal(g[0].join(''), OFFICIAL[id].rows[0], '已有内容不能被改动');
  });

  test('缺行、短行都补齐，不画出半张图', () => {
    const g = terrainGrid({ rows: ['rrr', 'r'] }, { rows: 4, cols: 5 }, 'f');
    assert.equal(g.length, 4);
    assert.ok(g.every((row) => row.length === 5));
    assert.equal(g[0].join(''), 'rrrff');
    assert.equal(g[1].join(''), 'rffff');
    assert.equal(g[3].join(''), 'fffff', '缺的行整行补兜底字符');
  });

  test('没有地形时返回 null（调用方退回只画网格）', () => {
    assert.equal(terrainGrid(null, { rows: 2, cols: 2 }), null);
    assert.equal(terrainGrid({}, { rows: 2, cols: 2 }), null);
    assert.equal(terrainGrid({ rows: [] }, { rows: 2, cols: 2 }), null);
    assert.equal(terrainGrid({ rows: ['rr'] }, { rows: 0, cols: 0 }), null, '尺寸为 0 等同于没地形');
  });
});

describe('底图：取色与找图', () => {
  test('调色板里的字符取到它的颜色；不认识的按该图图例的高度给近似色；都没有才是兜底色', () => {
    assert.equal(colorOfGlyph(TILE_PALETTE, 'r'), TILE_PALETTE.find((t) => t.glyph === 'r').color);
    // 官方地图的 `A`（tile_achand）不在调色板里，但它自己的图例说是 HIGH —— 不能画成黑洞
    assert.equal(colorOfGlyph(TILE_PALETTE, 'A', { A: { height: 'HIGH' } }), '#3a3f47');
    assert.equal(colorOfGlyph(TILE_PALETTE, 'z', { z: { height: 'LOW' } }), '#4a4f57');
    assert.equal(colorOfGlyph(TILE_PALETTE, '?'), '#2a2d33');
    assert.equal(colorOfGlyph(null, 'r'), '#2a2d33', '调色板没到之前也不能画出透明格');
    assert.equal(colorOfGlyph([], ' '), '#2a2d33');
    assert.equal(colorOfGlyph(TILE_PALETTE, 'r', null), TILE_PALETTE.find((t) => t.glyph === 'r').color);
  });

  test('官方 11 张地图的每一格都取得到颜色（调色板或图例，两档覆盖，零遗漏）', () => {
    let cells = 0;
    const blind = [];
    for (const [id, s] of Object.entries(OFFICIAL)) {
      for (const ch of (s.rows ?? []).join('')) {
        cells++;
        if (colorOfGlyph(TILE_PALETTE, ch, s.tiles ?? undefined) === '#2a2d33') blind.push(`${id}:${ch}`);
      }
    }
    assert.ok(cells > 4000, '官方地图总格数应该上万级（这里只数了字符）');
    assert.deepEqual([...new Set(blind)], [], '这些格子会画成兜底色，说明该补调色板或图例');
  });

  test('stageById 按 id 找图，找不到给 null', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    assert.equal(stageById(list, 'b').id, 'b');
    assert.equal(stageById(list, 'x'), null);
    assert.equal(stageById(list, null), null);
    assert.equal(stageById(null, 'a'), null);
  });
});

describe('底图：服务端把地形与调色板送过来', () => {
  let tmp;
  let editor;
  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-terrain-'));
    editor = await createEditorServer({ workshopRoot: join(tmp, 'workshop'), port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('/api/waves 的 stages 带着 rows/tiles，且带上了调色板', async () => {
    const data = await fetch(`${editor.url}/api/waves`).then((r) => r.json());
    const official = data.stages.filter((s) => s.official);
    assert.ok(official.length >= 11, '官方地图都在');
    for (const s of official) {
      assert.ok(Array.isArray(s.rows) && s.rows.length, `${s.id} 要带 rows`);
      assert.ok(s.tiles && typeof s.tiles === 'object', `${s.id} 要带 tiles 图例`);
      assert.ok(terrainGrid(s, { rows: STAGE_ROWS, cols: STAGE_COLS }), `${s.id} 的地形要画得出来`);
    }
    assert.deepEqual(data.palette, TILE_PALETTE, '调色板要原样送到，颜色由它决定');
  });
});
