// test/stageRounds.test.js — 地图页「回合绑定」的纯逻辑（editor/ui/stageRounds.js）与那条最容易漏的接线。
//
// 背景：真正决定「这一回合出什么怪」的是**地图自己的 rounds**（引擎先看这张图、再看模式的模板）。此前作者能做出
// 出怪表，却只能手改地图 JSON 才能让它生效。补这条界面时有两个坑，都在这里钉住：
//   1. 绑了一个不存在的 id 时引擎**静默回落**到模式的模板 —— 界面必须能查出来并说话；
//   2. 地图页拼 spec 是显式列字段的，漏掉 rounds 就等于「打开一张绑好回合的地图、随手保存一下，绑定全没了」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boundWaveOf, modeIdsOf, roundRows, missingBindings, setRoundBinding, setBossRoundBinding, waveOptions,
} from '../editor/ui/stageRounds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'data', 'config.json'), 'utf8'));
const WAVES = JSON.parse(readFileSync(join(ROOT, 'data', 'waves.json'), 'utf8'));

/** 与编辑器服务端 roundBindData() 同形状的数据，直接由官方数据生成（这样测试跟着真数据走）。 */
const ROUND_BIND = {
  waves: Object.keys(WAVES).sort().map((id) => ({ id, name: null, pack: null })),
  modes: Object.fromEntries(Object.entries(CONFIG.modes).map(([id, m]) => [id, {
    name: m.name ?? id,
    rounds: Object.keys(m.rounds ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b)
      .map((n) => ({ round: n, template: m.rounds[n]?.template ?? null, isBoss: m.rounds[n]?.isBoss === true })),
    bosses: Object.keys(m.bossWeights ?? {}).sort(),
  }])),
};
const OFFICIAL_WAVE = Object.keys(WAVES)[0];

describe('回合绑定：读取与归一化', () => {
  test('boundWaveOf 认字符串与 { template } 两种写法（引擎两者都认）', () => {
    assert.equal(boundWaveOf('w1'), 'w1');
    assert.equal(boundWaveOf({ template: 'w2' }), 'w2');
    assert.equal(boundWaveOf(''), null);
    assert.equal(boundWaveOf({}), null);
    assert.equal(boundWaveOf(null), null);
    assert.equal(boundWaveOf({ template: 123 }), null);
  });

  test('modeIdsOf 优先用这张图勾选的模式，没勾就给全部（否则新建地图时面板是空的）', () => {
    assert.deepEqual(modeIdsOf({ modes: ['mode_single_funny'] }, ROUND_BIND), ['mode_single_funny']);
    assert.deepEqual(modeIdsOf({ modes: ['不存在的模式'] }, ROUND_BIND), Object.keys(ROUND_BIND.modes));
    assert.deepEqual(modeIdsOf({ modes: [] }, ROUND_BIND).length, Object.keys(ROUND_BIND.modes).length);
  });
});

describe('回合绑定：按真实模式数据列回合', () => {
  test('单模式：回合数与默认模板来自该模式，首领回合被标出来', () => {
    const rows = roundRows({ modes: ['mode_single_funny'] }, ROUND_BIND);
    const own = ROUND_BIND.modes.mode_single_funny;
    assert.equal(rows.length, own.rounds.length, '回合数应与模式一致');
    assert.deepEqual(rows.map((r) => r.round), own.rounds.map((r) => r.round));
    assert.equal(rows[0].defaults[0].template, own.rounds[0].template, '默认模板要显示出来，作者才知道该不该覆盖');
    const boss = rows.filter((r) => r.isBoss);
    assert.ok(boss.length >= 1, '总该有首领回合');
    assert.ok(boss[0].bossKeys.length >= 1, '首领回合要带上该模式会抽的首领 id');
  });

  test('多模式：按回合数最多的那个列，短的模式没有的回合仍列出来', () => {
    const short = ROUND_BIND.modes.mode_single_funny.rounds.length;
    const long = ROUND_BIND.modes.mode_single_abyss.rounds.length;
    assert.ok(long > short, '两个模式的回合数应该不同，否则这条测试没有意义');
    const rows = roundRows({ modes: ['mode_single_funny', 'mode_single_abyss'] }, ROUND_BIND);
    assert.equal(rows.length, long);
    const last = rows[rows.length - 1];
    assert.equal(last.defaults.length, 1, '超出短模式回合数的那一行只有长模式给默认值');
    assert.equal(last.defaults[0].modeId, 'mode_single_abyss');
  });

  test('已绑定的值读得回来，两种写法都认', () => {
    const rows = roundRows({ modes: ['mode_single_funny'], rounds: { 1: OFFICIAL_WAVE, 2: { template: OFFICIAL_WAVE } } }, ROUND_BIND);
    assert.equal(rows[0].bound, OFFICIAL_WAVE);
    assert.equal(rows[1].bound, OFFICIAL_WAVE);
    assert.equal(rows[2].bound, null);
  });

  test('服务端没给回合表时不炸，只是没有行', () => {
    assert.deepEqual(roundRows({ modes: [] }, null), []);
    assert.deepEqual(roundRows({}, {}), []);
  });
});

describe('回合绑定：失效检测（引擎会静默回落的那种）', () => {
  test('绑了不存在的表要报出来，绑官方表不报', () => {
    const spec = { rounds: { 1: OFFICIAL_WAVE, 3: 'typo_wave_id' }, bossRounds: { 9: { boss_1: 'also_typo' } } };
    const missing = missingBindings(spec, ROUND_BIND);
    assert.deepEqual(missing, [
      { round: 3, kind: 'round', id: 'typo_wave_id' },
      { round: 9, kind: 'boss', id: 'also_typo' },
    ]);
  });

  test('全都存在时一条都不报', () => {
    assert.deepEqual(missingBindings({ rounds: { 1: OFFICIAL_WAVE } }, ROUND_BIND), []);
    assert.deepEqual(missingBindings({}, ROUND_BIND), []);
  });
});

describe('回合绑定：写入', () => {
  test('setRoundBinding 写进去、清空时把字段整个去掉', () => {
    assert.deepEqual(setRoundBinding(undefined, 3, OFFICIAL_WAVE), { 3: OFFICIAL_WAVE });
    assert.equal(setRoundBinding({ 3: OFFICIAL_WAVE }, 3, ''), undefined, '清空最后一处绑定后字段应该消失，而不是留下空对象');
    assert.deepEqual(setRoundBinding({ 3: OFFICIAL_WAVE, 4: OFFICIAL_WAVE }, 3, ''), { 4: OFFICIAL_WAVE });
    // 不改原对象（界面里 state.spec 是复用的，就地改容易让预览与保存不一致）
    const src = { 1: 'a' };
    setRoundBinding(src, 2, 'b');
    assert.deepEqual(src, { 1: 'a' });
  });

  test('setBossRoundBinding 给该模式的每个首领都写上同一个表', () => {
    const bosses = ROUND_BIND.modes.mode_single_funny.bosses;
    const out = setBossRoundBinding(undefined, 9, 'my_boss_wave', bosses);
    assert.deepEqual(Object.keys(out['9']).sort(), [...bosses].sort());
    assert.ok(Object.values(out['9']).every((v) => v === 'my_boss_wave'));
    // 引擎取不到具体首领时会取第一个字符串值，所以「每个首领都写上」= 抽到谁都用你的表
    assert.equal(setBossRoundBinding({ 9: { boss_1: 'x' } }, 9, '', bosses), undefined);
    // 没有首领清单时兜一个键，至少不是空对象
    assert.deepEqual(setBossRoundBinding(undefined, 9, 'w', []), { 9: { '*': 'w' } });
  });

  test('waveOptions：官方在前，本包在后，名字与 id 不同时两个都显示', () => {
    const opts = waveOptions({
      waves: [
        { id: 'p_wave', name: '我的表', pack: 'demo' },
        { id: 'b_wave', name: null, pack: null },
        { id: 'a_wave', name: '官方表', pack: null },
      ],
    });
    assert.deepEqual(opts.map((o) => o.id), ['a_wave', 'b_wave', 'p_wave']);
    assert.equal(opts[0].label, '官方表 (a_wave)');
    assert.equal(opts[1].label, 'b_wave');
    assert.deepEqual(waveOptions(null), []);
  });
});

describe('回合绑定：地图页的接线（spec 必须原样带上这两个字段）', () => {
  const src = readFileSync(join(ROOT, 'editor', 'ui', 'stage.js'), 'utf8');

  test('currentSpec 带上 rounds 与 bossRounds', () => {
    // 这一条只能用源码断言：要真跑 stage.js 得连 canvas 与 3D 一起桩掉，成本远大于收益。
    // 它守的是一个具体的回归：「打开一张绑好回合的地图、随手保存一下，绑定全没了」。
    const body = src.slice(src.indexOf('function currentSpec()'), src.indexOf('function loadSpec('));
    assert.match(body, /state\.spec\.rounds/, 'currentSpec 必须带上 rounds');
    assert.match(body, /state\.spec\.bossRounds/, 'currentSpec 必须带上 bossRounds');
  });

  test('侧栏有回合绑定面板，并且写入的是 rounds / bossRounds', () => {
    assert.match(src, /roundRows\(spec, bind\)/);
    assert.match(src, /spec\.rounds = setRoundBinding\(/);
    assert.match(src, /spec\.bossRounds = setBossRoundBinding\(/);
    assert.match(src, /missingBindings\(spec, bind\)/, '失效提示必须在页面里出现');
  });
});
