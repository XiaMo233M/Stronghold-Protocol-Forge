// test/modClientData.test.js — C 层的**数据口**：`client.panels[].data` + `ctx.data.get('<表>')`（业主裁决 2026-10-10）。
//
// 这一格存在的唯一理由是一个具体的东西：`cardMarks.js` 要在商店卡上按 `data/chess.json` 的 `visible` / `isHidden`
// 画标记。DESIGN §28.8 明确**不给** store（给了就能改对局），而这几张表不在 store 里 —— 所以缺口是「面板读不到
// 本来就发给浏览器的数据」，不是「面板拿不到状态」。
//
// 三条纪律，本文件逐条钉：
//   1. **读什么要声明**：`data: ['chess']` 进清单、进形状层判据；名字拼错 = 点名拒绝（`CLIENT_BAD_PANEL_DATA`），
//      与 `registers` / `intercepts` 同一条口径；
//   2. **给的是快照，不是引擎的家当**：`get()` 返回冻结的深拷贝 —— 包改自己那份，`public/js/data.js` 缓存里那份
//      一个字节不动（直接把引擎的对象冻上会让一个包把引擎的缓存变成只读）；
//   3. **没声明就点名**：读一张没声明的表返回 `null` + `CLIENT_DATA_UNDECLARED`（不抛异常：多读一行不该让整个界面
//      消失，但这件事必须看得见）。
//
// Run: node --test test/modClientData.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { normalizePackManifest, CLIENT_PANEL_DATA_TABLES } from '../shared/workshop.js';
import { DATA_FILES } from '../public/js/data.js';
import { loadWorkshop, loadWorkshopPanels } from '../server/workshop.js';
import { createPanelRegistry, readonlySnapshot } from '../public/js/ui/extensions.js';
import fs from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------------------------------------
describe('声明层：读哪几张表要写出来', () => {
  const base = (panel) => ({ id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x', client: { panels: [panel] } });
  const norm = (panel) => normalizePackManifest(base(panel), 'p', { hasAssets: false });
  const P = { id: 'marks', slot: 'screen.game.shopCard', module: 'ui/marks.js' };

  test('合法声明按闭枚举次序归一化（清单字节要稳定）', () => {
    const r = norm({ ...P, data: ['items', 'chess'] });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
    assert.deepEqual(r.pack.client.panels[0].data, ['chess', 'items'], '按枚举次序，不按书写次序');
  });

  test('每一种写错都点名拒绝', () => {
    const bad = (data, code, note) => {
      const r = norm({ ...P, data });
      assert.equal(r.ok, false, `${note}: 应当被拒`);
      assert.equal(r.error, code, `${note}: 期待 ${code}，实际 ${r.error} — ${r.detail}`);
    };
    bad('chess', 'CLIENT_BAD_PANEL_DATA', '不是数组');
    bad([], 'CLIENT_BAD_PANEL_DATA', '空数组');
    bad(['chess.json'], 'CLIENT_BAD_PANEL_DATA', '带扩展名');
    bad(['unit'], 'CLIENT_BAD_PANEL_DATA', '不存在的表');
    bad(['chess', 'chess'], 'CLIENT_DUPLICATE_PANEL_DATA', '重复');
    bad(Array.from({ length: 14 }, (_, i) => `t${i}`), 'CLIENT_BAD_PANEL_DATA', '超过上限');
  });

  test('两份名单钉在一起：可以读的表 == 浏览器真的抓得到的那几张', () => {
    assert.deepEqual([...CLIENT_PANEL_DATA_TABLES].sort(), Object.keys(DATA_FILES).sort(),
      '少一个 = 一个合法声明被拒；多一个 = 一条浏览器拿不到的承诺');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('客户端：只读快照、没声明就点名', () => {
  const el = (tag) => ({ tag, attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, getAttribute: () => null, appendChild(c) { this.children.push(c); }, remove() {} });

  /** 引擎那份数据（模拟 `public/js/data.js` 的缓存对象）。 */
  function engineData() {
    const raw = { chess_ws_a: { chessId: 'chess_ws_a', name: 'A', visible: true, isHidden: false, tags: ['x'] } };
    return { raw, get: (name) => (name === 'chess' ? raw : null) };
  }

  async function mountPanel(decl) {
    const seen = [];
    const store = { get: () => ({}), subscribe: () => () => {}, patch: () => {} };
    const registry = createPanelRegistry({
      store,
      net: null,
      notify: () => {},
      data: engineData(),
      importModule: async () => ({ mount: (ctx) => { seen.push(ctx); return {}; } }),
      createElement: el,
      slotHost: () => el('div'),
      slotHosts: () => [el('div')],
      styleHost: () => el('head'),
      themeHost: () => el('html'),
      env: {},
    });
    registry.apply([{ id: 'marks', pack: 'p', slot: 'root.overlays', url: '/workshop-panels/p/ui/marks.js', ...decl }]);
    await settle();
    // 拒绝是**读的时候**才发生的（`ctx.data.get`），所以列表要在断言处现取 —— 这里返回注册点本身。
    return { ctx: seen[0], registry };
  }

  test('声明过的表：拿到冻结快照，字段读得到', async () => {
    const { ctx, registry } = await mountPanel({ data: ['chess'] });
    assert.deepEqual(registry.refusals(), []);
    const chess = ctx.data.get('chess');
    assert.equal(chess.chess_ws_a.visible, true);
    assert.equal(chess.chess_ws_a.isHidden, false);
    assert.ok(Object.isFrozen(chess), '整张表冻结');
    assert.ok(Object.isFrozen(chess.chess_ws_a), '里面每条记录也冻结（深拷，不是浅冻）');
    assert.ok(Object.isFrozen(chess.chess_ws_a.tags), '数组同样');
    assert.deepEqual(ctx.data.tables(), ['chess']);
    assert.deepEqual(registry.refusals(), [], '声明过就不该有拒绝');
  });

  test('包改不动引擎那份：快照是深拷贝，写进去抛在严格模式，引擎的对象一个字节不变', async () => {
    const { ctx } = await mountPanel({ data: ['chess'] });
    const snap = ctx.data.get('chess');
    assert.throws(() => { snap.chess_ws_a.name = 'hacked'; }, TypeError, '冻结对象在严格模式（ESM）下写入即抛');
    assert.throws(() => { snap.chess_ws_a.tags.push('y'); }, TypeError);
    assert.throws(() => { snap.newKey = 1; }, TypeError);
    // 同一个包多次调用拿到同一份快照（不是每次都深拷一遍）
    assert.equal(ctx.data.get('chess'), snap);
  });

  test('没声明过的表：返回 null 并**点名**（不抛，界面不因为多读一行就消失）', async () => {
    const { ctx, registry } = await mountPanel({ data: ['chess'] });
    assert.equal(ctx.data.get('items'), null);
    const hit = registry.refusals().find((r) => r.code === 'CLIENT_DATA_UNDECLARED');
    assert.ok(hit, `应当点名，实际 ${JSON.stringify(registry.refusals())}`);
    assert.match(hit.detail, /"items"/);
    assert.equal(ctx.data.get(''), null);
    assert.equal(ctx.data.get(7), null);
  });

  test('一张表都没声明：读什么都点名（声明是唯一入口）', async () => {
    const { ctx, registry } = await mountPanel({});
    assert.deepEqual(ctx.data.tables(), []);
    assert.equal(ctx.data.get('chess'), null);
    assert.equal(registry.refusals().filter((r) => r.code === 'CLIENT_DATA_UNDECLARED').length, 1);
  });

  test('引擎哪天给不出那张表（还没抓到 / 名字不认识）⇒ null，不抛', async () => {
    const { ctx } = await mountPanel({ data: ['bonds'] });
    assert.equal(ctx.data.get('bonds'), null);
  });

  test('readonlySnapshot 直接可用：标量原样、对象深冻、共享子树只造一份', () => {
    const shared = { a: 1 };
    const root = { x: shared, y: shared, list: [1, { b: 2 }] };
    const snap = readonlySnapshot(root);
    assert.notEqual(snap, root);
    assert.equal(snap.x, snap.y, '同一个子树只造一份');
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.x) && Object.isFrozen(snap.list[1]));
    assert.equal(readonlySnapshot(7), 7);
    assert.equal(readonlySnapshot(null), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('服务面：声明原样送到浏览器（服务端不判数据口）', () => {
  test('loadWorkshopPanels 把 `data` 带进清单；没声明的面板没有这个键', () => {
    const tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-moddata-'));
    try {
      const dir = path.join(tmp, 'marks-pack');
      fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'marks-pack', name: 'Marks', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
        client: { panels: [
          { id: 'marks', slot: 'screen.game.shopCard', module: 'ui/marks.js', data: ['chess', 'items'] },
          { id: 'plain', slot: 'root.overlays', module: 'ui/plain.js' },
        ] },
      }));
      fs.writeFileSync(path.join(dir, 'ui', 'marks.js'), 'export function mount() { return {}; }\n');
      fs.writeFileSync(path.join(dir, 'ui', 'plain.js'), 'export function mount() { return {}; }\n');
      const loaded = loadWorkshop(tmp, { log: quiet });
      assert.deepEqual(loaded.errors, []);
      const { panels, errors } = loadWorkshopPanels(loaded, { log: quiet });
      assert.deepEqual(errors, []);
      const marks = panels.find((p) => p.id === 'marks');
      assert.deepEqual(marks.data, ['chess', 'items']);
      assert.equal('data' in panels.find((p) => p.id === 'plain'), false, '没声明就没有这个键（字节不多个字段）');
      assert.equal(ROOT.length > 0, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
