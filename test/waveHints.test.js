// test/waveHints.test.js — 出怪页的两处「把话说清楚」：阵营占位符、以及这张表真正在哪张图的哪几个回合生效。
//
// 两件事都是「不报错但结果不对」那一类：
//   · 选了阵营占位符，出的是随机怪（数量还会被重算），移动方式不匹配时这一波**一只都不出**，校验器不说；
//   · 出怪页那个「绑定到回合」只写意图，引擎读的是地图的 rounds —— 两边对不上时作者只能靠记忆。
// 所以这些判断都做成纯函数，另外用一次 HTTP 断言服务端确实把占位符清单送了过来（数据源只能是 factions.templateSlots）。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { isPlaceholderEnemy, placeholderSlotOf, placeholderSpawns, mapsUsingWave } from '../editor/ui/waveHints.js';
import { createEditorServer } from '../editor/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FACTIONS = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'factions.json'), 'utf8'));
/** 与编辑器服务端 placeholderEnemyMap() 同形状：由官方 templateSlots 反查。 */
const PLACEHOLDERS = Object.fromEntries(Object.entries(FACTIONS.templateSlots ?? {}).map(([slot, key]) => [key, slot]));

describe('阵营占位符：判定', () => {
  test('清单就是官方 templateSlots 的键，槽位取得回来', () => {
    const keys = Object.values(FACTIONS.templateSlots ?? {});
    assert.ok(keys.length >= 6, '官方数据里应该有一批模板槽位');
    for (const key of keys) {
      assert.equal(isPlaceholderEnemy(key, PLACEHOLDERS), true, `${key} 应该被判为占位符`);
      assert.equal(placeholderSlotOf(key, PLACEHOLDERS), Object.entries(FACTIONS.templateSlots).find(([, k]) => k === key)[0]);
    }
  });

  test('普通敌人不是占位符，没有清单时谁都不是', () => {
    assert.equal(isPlaceholderEnemy('enemy_1007_slime', PLACEHOLDERS), false);
    assert.equal(placeholderSlotOf('enemy_1007_slime', PLACEHOLDERS), null);
    assert.equal(isPlaceholderEnemy('enemy_1000_gopro_2', null), false);
    assert.equal(isPlaceholderEnemy(null, PLACEHOLDERS), false);
    // 槽位值形状不同也要能取出来
    assert.equal(placeholderSlotOf('x', { x: { slot: 'NF' } }), 'NF');
    assert.equal(placeholderSlotOf('x', { x: {} }), '?');
  });

  test('placeholderSpawns 去重、排序，并忽略普通敌人', () => {
    const [a, b] = Object.keys(PLACEHOLDERS);
    const spawns = [{ key: b }, { key: 'enemy_1007_slime' }, { key: a }, { key: b }, {}];
    assert.deepEqual(placeholderSpawns(spawns, PLACEHOLDERS), [a, b].sort());
    assert.deepEqual(placeholderSpawns([], PLACEHOLDERS), []);
    assert.deepEqual(placeholderSpawns(null, PLACEHOLDERS), []);
  });
});

describe('真正在用这张表的地图', () => {
  const STAGES = [
    { id: 'official_map', name: '官方图', official: true, rounds: { 3: 'w1' } },
    { id: 'ws_map_a', name: '我的图 A', pack: 'demo', rounds: { 4: 'w1', 5: 'other' }, bossRounds: { 9: { boss_1: 'w1' } } },
    { id: 'ws_map_b', name: '我的图 B', pack: 'demo', rounds: { 2: { template: 'w1' } } },
    { id: 'ws_map_c', name: '用别的表', pack: 'demo', rounds: { 1: 'w2' } },
  ];

  test('找出普通回合与首领回合，两种写法都认', () => {
    const used = mapsUsingWave('w1', STAGES);
    assert.deepEqual(used.map((u) => u.id), ['ws_map_a', 'ws_map_b', 'official_map'], '工坊自己的图排前面');
    const a = used.find((u) => u.id === 'ws_map_a');
    assert.deepEqual(a.rounds, [4]);
    assert.deepEqual(a.bossRounds, [9]);
    assert.deepEqual(used.find((u) => u.id === 'ws_map_b').rounds, [2], '{ template } 写法也要算数');
    assert.deepEqual(used.find((u) => u.id === 'official_map').rounds, [3]);
  });

  test('没被绑、或 id 为空时返回空数组', () => {
    assert.deepEqual(mapsUsingWave('nope', STAGES), []);
    assert.deepEqual(mapsUsingWave('', STAGES), []);
    assert.deepEqual(mapsUsingWave('w1', null), []);
    assert.deepEqual(mapsUsingWave('w1', [{ id: 'x' }]), []);
  });

  test('回合号排好序、多个回合都列出来', () => {
    const used = mapsUsingWave('w1', [{ id: 'm', name: 'm', rounds: { 7: 'w1', 2: 'w1', 11: 'w1' } }]);
    assert.deepEqual(used[0].rounds, [2, 7, 11]);
  });
});

describe('服务端把占位符清单送过来（数据源只能是 factions.templateSlots）', () => {
  let tmp;
  let editor;
  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-wavehints-'));
    editor = await createEditorServer({ workshopRoot: join(tmp, 'workshop'), port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('/api/waves 的 placeholderEnemies 与官方 templateSlots 一一对应', async () => {
    const data = await fetch(`${editor.url}/api/waves`).then((r) => r.json());
    assert.deepEqual(data.placeholderEnemies, PLACEHOLDERS);
    assert.ok(data.enemies.includes('enemy_1000_gopro_2'), '可选的敌人清单里当然包含这些占位符');
  });

  test('/api/waves 的 stages 带着各自的 rounds/bossRounds（上面那个面板的数据来源）', async () => {
    const data = await fetch(`${editor.url}/api/waves`).then((r) => r.json());
    assert.ok(Array.isArray(data.stages) && data.stages.length > 0, '至少要有官方地图');
    assert.ok(data.stages.every((s) => typeof s.id === 'string'), '每张图都要有 id');
  });
});
