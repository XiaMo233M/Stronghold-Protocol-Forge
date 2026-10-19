// test/modClientScreens.test.js — DESIGN §28.55 的 `client.screens`：形状层的每条拒绝码 + 两份路由名单同源。
//
// 与 test/modClientPanels.test.js 同一套打法：合成 pack.json 喂 `normalizePackManifest`，逐个失败分支走一遍。
// 路由名单那条是这一格最容易出事的地方：形状层的 `CLIENT_SCREEN_ROUTES` 与客户端的 `MOD_SCREEN_ROUTES`
// 一旦各说各话，作者就会写出「声明了合法路由、客户端永远不调用」的死格子 —— 判据只许有一份真相。
//
// 节号：本格吸收自下游 fork（在那里是 §28.53），我方按能力归一到 §28.55。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePackManifest, CLIENT_SCREEN_ROUTES } from '../shared/workshop.js';

/** 一份只声明了屏的最小合法包（`content` 让它不是空包）。 */
const mk = (client) => normalizePackManifest({ id: 'p', name: 'p', content: ['chess'], client }, 'p');
const screen = (extra = {}) => ({ screens: [{ id: 'lobby_v2', route: 'lobby', module: 'screens/lobby.js', ...extra }] });

test('路由闭枚举 = 引擎真的有的那四个（结算与干员调配是路由内部的视图，不是路由）', () => {
  assert.deepEqual([...CLIENT_SCREEN_ROUTES], ['title', 'lobby', 'room', 'game']);
});

test('客户端那份名单与形状层逐字相同（两处真相钉在一起）', () => {
  const src = readFileSync(new URL('../public/js/ui/extensions.js', import.meta.url), 'utf8');
  const hit = src.match(/MOD_SCREEN_ROUTES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(hit, 'extensions.js 里必须有 MOD_SCREEN_ROUTES 这张表');
  const client = hit[1].split(',').map((s) => s.trim().replace(/^['`"]|['`"]$/g, '')).filter(Boolean);
  assert.deepEqual(client, [...CLIENT_SCREEN_ROUTES]);
});

test('合法声明：id / route / module 三格进清单，书写顺序不影响字节', () => {
  const ok = mk(screen());
  assert.equal(ok.ok, true, JSON.stringify(ok.detail));
  assert.deepEqual(ok.pack.client.screens, [{ id: 'lobby_v2', route: 'lobby', module: 'screens/lobby.js' }]);
});

test('`styles` / `data` / `messages` 与面板共用判据：非法值点名拒，合法值排序进清单', () => {
  const good = mk({ screens: [{ id: 's1', route: 'room', module: 'a.js', styles: ['x.css', 'y.css'] }] });
  assert.equal(good.ok, true, JSON.stringify(good.detail));
  assert.deepEqual(good.pack.client.screens[0].styles, ['x.css', 'y.css']);
  const bad = mk({ screens: [{ id: 's1', route: 'room', module: 'a.js', styles: ['x.txt'] }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'CLIENT_BAD_SCREEN_STYLE');
});

test('每条失败分支都点名，不静默丢一整格', () => {
  const cases = [
    [{ screens: 'nope' }, 'CLIENT_BAD_SCREENS'],
    [{ screens: [] }, 'CLIENT_BAD_SCREENS'],
    [{ screens: [{ id: 'a', route: 'lobby' }] }, 'CLIENT_BAD_SCREEN_MODULE'],
    [{ screens: [{ id: 'a', route: 'result', module: 'a.js' }] }, 'CLIENT_BAD_SCREEN_ROUTE'],
    [{ screens: [{ id: 'a', route: 'lobby', module: '../a.js' }] }, 'CLIENT_BAD_SCREEN_MODULE'],
    [{ screens: [{ id: 'a', route: 'lobby', module: 'a.js' }, { id: 'a', route: 'game', module: 'b.js' }] }, 'CLIENT_SCREEN_DUPLICATE_ID'],
    [{ screens: [{ id: 'a', route: 'lobby', module: 'a.js' }, { id: 'b', route: 'lobby', module: 'b.js' }] }, 'CLIENT_SCREEN_DUPLICATE_ROUTE'],
    [{ panels: [{ id: 'a', slot: 'root.overlays', module: 'a.js' }], screens: [{ id: 'a', route: 'lobby', module: 'b.js' }] }, 'CLIENT_SCREEN_DUPLICATE_ID'],
    [{ screens: [{ id: 'a', route: 'lobby', module: 'a.js', waves: 3 }] }, 'CLIENT_SCREEN_UNKNOWN_FIELD'],
    [{ screens: [{ id: 'a', route: 'lobby', module: 'a.js', order: 1.5 }] }, 'CLIENT_BAD_SCREEN_ORDER'],
  ];
  for (const [client, code] of cases) {
    const bad = mk(client);
    assert.equal(bad.ok, false, `${code} must be refused`);
    assert.equal(bad.error, code);
  }
});

test('没有声明 screens 的包，归一化结果里不长这个键（身份摘要逐字节不变的那条纪律）', () => {
  const panelsOnly = mk({ panels: [{ id: 'a', slot: 'root.overlays', module: 'a.js' }] });
  assert.equal(panelsOnly.ok, true, JSON.stringify(panelsOnly.detail));
  assert.ok(!Object.hasOwn(panelsOnly.pack.client, 'screens') || panelsOnly.pack.client.screens.length === 0);
});

test('老包（不写 screens）的归一化结果**逐字不变**：client 这个对象的键集与值一个都不许多', () => {
  // 这是「新引入一个闭枚举」那条纪律的可执行判据，比上面那条强：上面只问 `screens` 在不在，这一条把整个
  // `client` 对象钉成一份**完整的期望值** —— 多一个键、少一个键、键序变了都当场红。
  // 为什么必须这么严：`identifyPack` 哈希的就是这份归一化清单的 canonicalJson，给每个包都补一个
  // `screens: []` 会让**所有已发布包**的摘要全部改变（DESIGN §28.2 的摘要闸门会被绕过）。
  const panelsOnly = mk({ panels: [{ id: 'a', slot: 'root.overlays', module: 'a.js' }] });
  assert.equal(panelsOnly.ok, true, JSON.stringify(panelsOnly.detail));
  assert.deepEqual(panelsOnly.pack.client, {
    panels: [{ id: 'a', slot: 'root.overlays', module: 'a.js' }],
    requires: [],
  });
});

test('一个 client 块至少要说出一件能用的事：panels / screens / theme 三者都没有就拒', () => {
  const empty = mk({ requires: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'CLIENT_BAD_PANELS');
});
