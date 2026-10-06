// test/enemyWizard.test.js — 怪物页「新建更容易」的纯逻辑（editor/ui/enemyWizard.js）。
//
// 最要紧的一条是 spineIsKnown：spine 是全表单唯一一个「填错不报错、只在游戏里静默变成占位模型」的字段，
// 而官方 249 只怪共用 200 多个 prefab 键，作者不可能背下来。这里把它判成四种情况，界面据此说话。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchEnemies, sortTemplates, spineIsKnown, RANK_ORDER } from '../editor/ui/enemyWizard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENEMIES = JSON.parse(readFileSync(join(ROOT, 'data', 'enemies.json'), 'utf8'));

const LIST = [
  { key: 'enemy_1007_slime', name: '源石虫', rank: 'NORMAL' },
  { key: 'enemy_1045_hammer', name: '重装防御者', rank: 'ELITE' },
  { key: 'enemy_1506_bigboss', name: '领袖', rank: 'BOSS' },
  { key: 'enemy_9999_odd', name: '怪东西', rank: null },
];

describe('怪物模板：挑选与排序', () => {
  test('matchEnemies 按名字或 key 匹配，大小写不敏感', () => {
    assert.equal(matchEnemies(LIST, '').length, 4);
    assert.deepEqual(matchEnemies(LIST, '源石虫').map((e) => e.key), ['enemy_1007_slime']);
    assert.deepEqual(matchEnemies(LIST, 'HAMMER').map((e) => e.key), ['enemy_1045_hammer']);
    assert.deepEqual(matchEnemies(LIST, '  enemy_9999  ').map((e) => e.key), ['enemy_9999_odd']);
    assert.deepEqual(matchEnemies(LIST, '不存在'), []);
    assert.deepEqual(matchEnemies(null, 'x'), []);
    const all = matchEnemies(LIST, '');
    assert.notEqual(all, LIST, '返回副本，不改动输入');
  });

  test('sortTemplates 先按档位（普通→精英→领袖），未知档位排最后', () => {
    assert.deepEqual(RANK_ORDER, ['NORMAL', 'ELITE', 'BOSS']);
    assert.deepEqual(sortTemplates(LIST).map((e) => e.rank), ['NORMAL', 'ELITE', 'BOSS', null]);
    // 同档按名字排
    const two = sortTemplates([{ key: 'b', name: '乙', rank: 'NORMAL' }, { key: 'a', name: '甲', rank: 'NORMAL' }]);
    assert.deepEqual(two.map((e) => e.key), ['a', 'b']);
    assert.deepEqual(sortTemplates(null), []);
  });

  test('对官方真实清单也排得动（每只都有 key）', () => {
    const list = Object.entries(ENEMIES).map(([key, r]) => ({ key, name: r.name, rank: r.rank }));
    const sorted = sortTemplates(list);
    assert.equal(sorted.length, list.length);
    const rankPos = (rank) => sorted.findIndex((e) => e.rank === rank);
    assert.ok(rankPos('NORMAL') < rankPos('ELITE'), '普通怪要排在精英前面');
    assert.ok(rankPos('ELITE') < rankPos('BOSS'), '精英要排在领袖前面');
  });
});

describe('怪物模板：spine 校验', () => {
  const choices = [{ id: 'enemy_1007_slime', name: '源石虫' }, { id: 'enemy_1045_hammer', name: '重装防御者' }];

  test('四种情况分得清', () => {
    assert.equal(spineIsKnown('enemy_1007_slime', choices), 'ok');
    assert.equal(spineIsKnown('  enemy_1045_hammer  ', choices), 'ok', '前后空格不影响判断');
    assert.equal(spineIsKnown('enemy_0000_nope', choices), 'unknown');
    assert.equal(spineIsKnown('', choices), 'empty');
    assert.equal(spineIsKnown(null, choices), 'empty');
    assert.equal(spineIsKnown('enemy_1007_slime', []), 'no-data', '没有清单时不要乱警告');
    assert.equal(spineIsKnown('enemy_1007_slime', null), 'no-data');
  });

  test('也接受 Set 形式的清单，并且大小写敏感（prefab 键本身是敏感的）', () => {
    assert.equal(spineIsKnown('enemy_1007_slime', new Set(['enemy_1007_slime'])), 'ok');
    assert.equal(spineIsKnown('ENEMY_1007_SLIME', new Set(['enemy_1007_slime'])), 'unknown');
  });

  test('官方数据里每只怪的 spine 都能被判成「已知」（否则这个校验会误报）', () => {
    const all = new Set(Object.values(ENEMIES).map((r) => r.spine).filter(Boolean));
    for (const r of Object.values(ENEMIES)) {
      assert.equal(spineIsKnown(r.spine, all), r.spine ? 'ok' : 'empty', `${r.key} 的 spine 判定不对`);
    }
  });
});
