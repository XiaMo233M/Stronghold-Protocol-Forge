// 管理器合同的依赖 / 冲突那一半（DESIGN §28.48）：清单**形状**（`shared/workshop.js` 的 `parseModRefsDecl`）
// 与**装载期裁决**（`adjudicatePackGraph`）。
//
// 覆盖：形状（收下的 / 逐条点名拒的、去重、同 id 不同 range）、五条裁决（缺失 / 版本不合 / 互斥按 id 大者败 /
// 级联带完整理由链 / 循环环上全体），以及**归一化纪律**（没写这两个键的包，结果里就没有这两个键 —— 哈希
// 逐字节不变，DESIGN §28.2）。
//
// ⚠️ 与 PR 自带那条测试的**唯一**差别，正是「依赖包没写 version」那一条：PR 的测试断言「未声明 ⇒ 0.0.0 ⇒
// `>=2.0.0` 不合 ⇒ 拒」，而 PR 自己的文档规则（以及业主裁决）是「没写 version ⇒ 视为满足」。本移植按**规则**
// 实现，这条测试按规则写。冲突记在 commit 消息的差异清单里。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest, adjudicatePackGraph } from '../shared/workshop.js';

/** 一份归一化器收得下的包，带上管理器合同的依赖 / 冲突字段。 */
function pack(id, fields = {}) {
  return normalizePackManifest({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', content: ['items'], ...fields,
  }, id, { hasAssets: false });
}

test('形状：dependencies / conflicts 是 { id, range? } 列表，逐字重复去重、排序、range 过语法判据', () => {
  const ok = pack('a', {
    dependencies: [{ id: 'b' }, { id: 'c', range: '>=1.0.0' }, { id: 'b' }],
    conflicts: [{ id: 'd', range: '<2.0.0' }],
  });
  assert.equal(ok.ok, true, ok.ok ? '' : `${ok.error}: ${ok.detail}`);
  assert.deepEqual(ok.pack.dependencies, [{ id: 'b' }, { id: 'c', range: '>=1.0.0' }], '逐字重复的去重');
  assert.deepEqual(ok.pack.conflicts, [{ id: 'd', range: '<2.0.0' }]);
});

test('形状：未知字段 / 坏 id / 坏 range / 同一个 id 两个 range，逐条点名拒绝', () => {
  const cases = [
    [{ id: 'b', version: '^1' }, 'DEPENDENCIES_UNKNOWN_FIELD', /"version" is not a declared field \(id, range\)/],
    [{ id: '../escape' }, 'DEPENDENCIES_BAD_ID', /is not a pack id/],
    [{ id: 'b', range: 'soon' }, 'DEPENDENCIES_BAD_RANGE', /is not a version range/],
  ];
  for (const [entry, code, detail] of cases) {
    const r = pack('a', { dependencies: [entry] });
    assert.equal(r.ok, false, JSON.stringify(entry));
    assert.equal(r.error, code, JSON.stringify(entry));
    assert.match(r.detail, detail);
  }
  const conflicting = pack('a', { dependencies: [{ id: 'b', range: '>=1' }, { id: 'b', range: '>=2' }] });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, 'DEPENDENCIES_CONFLICTING_RANGES');
  assert.match(conflicting.detail, /"b" is listed with different ranges/);
  const conflictsSide = pack('a', { conflicts: [{ id: 'b', nope: 1 }] });
  assert.equal(conflictsSide.ok, false);
  assert.equal(conflictsSide.error, 'CONFLICTS_UNKNOWN_FIELD');
});

test('归一化纪律：没写这两个键的包，结果里就没有这两个键（哈希逐字节不变）', () => {
  const plain = pack('plain').pack;
  assert.equal('dependencies' in plain, false);
  assert.equal('conflicts' in plain, false);
  assert.equal(JSON.stringify(plain).includes('dependencies'), false);
  // 写了的才进结果（与 notices / declared 同一条纪律）
  const declared = pack('a', { dependencies: [{ id: 'b' }] }).pack;
  assert.deepEqual(declared.dependencies, [{ id: 'b' }]);
  assert.equal('conflicts' in declared, false, '只写了 dependencies，conflicts 不该凭空出现');
});

test('裁决：依赖满足 ⇒ 两个都留；依赖缺失 ⇒ 依赖方被拒（具名）', () => {
  const packs = [
    pack('app', { dependencies: [{ id: 'lib' }] }).pack,
    pack('lib').pack,
  ];
  const r = adjudicatePackGraph(packs);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.kept.map((p) => p.id).sort(), ['app', 'lib']);

  const missing = adjudicatePackGraph([pack('app', { dependencies: [{ id: 'lib' }] }).pack]);
  assert.equal(missing.kept.length, 0);
  assert.match(missing.refused[0].reason, /missing dependency "lib"/);
});

test('裁决：版本区间 —— 满足则留、写的版本不合则拒依赖方、**没写 version 视为满足**', () => {
  const satisfied = [
    pack('app', { dependencies: [{ id: 'lib', range: '>=2.0.0' }] }).pack,
    pack('lib', { version: '2.1.0' }).pack,
  ];
  assert.deepEqual(adjudicatePackGraph(satisfied).refused, []);

  // 写了 version 且不合：点名拒
  const old = [
    pack('app', { dependencies: [{ id: 'lib', range: '>=2.0.0' }] }).pack,
    pack('lib', { version: '1.0.0' }).pack,
  ];
  const r = adjudicatePackGraph(old);
  assert.deepEqual(r.refused.map((x) => x.id), ['app']);
  assert.match(r.refused[0].reason, /dependency "lib" version 1\.0\.0 does not satisfy ">=2\.0\.0"/);

  // 依赖包自己**没写** version：归一化后是 0.0.0，那在本仓库的口径里是「未声明」而不是「不匹配」⇒ 视为满足。
  // （这一条与 PR 自带测试相反，见文件头。）
  const noVersion = adjudicatePackGraph([
    pack('app', { dependencies: [{ id: 'lib', range: '>=2.0.0' }] }).pack,
    pack('lib', { version: undefined }).pack,
  ]);
  assert.deepEqual(noVersion.refused, [], '没写 version = 未声明 ⇒ 视为满足');
  assert.deepEqual(noVersion.kept.map((p) => p.id).sort(), ['app', 'lib']);

  // range 缺省 = 任意版本，与「未声明」是两回事，但结论一样：留
  const anyRange = adjudicatePackGraph([
    pack('app', { dependencies: [{ id: 'lib' }] }).pack,
    pack('lib', { version: '0.0.1' }).pack,
  ]);
  assert.deepEqual(anyRange.refused, []);
});

test('裁决：互斥按 **id 大者败**（两个方向同一结论），且只有区间匹配时才互斥', () => {
  const bothPresent = [
    pack('alpha', { conflicts: [{ id: 'beta' }] }).pack,
    pack('beta').pack,
  ];
  const r = adjudicatePackGraph(bothPresent);
  assert.deepEqual(r.refused.map((x) => x.id), ['beta'], 'id 大者败（与同 id 抢占同一条确定性来源）');
  assert.match(r.refused[0].reason, /conflicts with "alpha" \(declared by "alpha"\)/);

  // 反向声明：同一对、同一条裁决
  const reversed = [pack('alpha').pack, pack('beta', { conflicts: [{ id: 'alpha' }] }).pack];
  assert.deepEqual(adjudicatePackGraph(reversed).refused.map((x) => x.id), ['beta']);

  // 带区间：只有匹配才互斥
  const ranged = [
    pack('alpha', { version: '3.0.0', conflicts: [{ id: 'beta', range: '<2.0.0' }] }).pack,
    pack('beta', { version: '1.0.0' }).pack,
  ];
  assert.deepEqual(adjudicatePackGraph(ranged).refused.map((x) => x.id), ['beta']);
  const notMatching = [
    pack('alpha', { version: '3.0.0', conflicts: [{ id: 'beta', range: '<2.0.0' }] }).pack,
    pack('beta', { version: '2.5.0' }).pack,
  ];
  assert.deepEqual(adjudicatePackGraph(notMatching).refused, []);
});

test('裁决：被拒的依赖级联到依赖方，理由链完整（迭代到不动点）', () => {
  const packs = [
    pack('app', { dependencies: [{ id: 'lib' }] }).pack,
    pack('lib', { dependencies: [{ id: 'core', range: '>=5.0.0' }] }).pack,
    pack('core', { version: '1.0.0' }).pack,
  ];
  const r = adjudicatePackGraph(packs);
  // 被拒的只有坏声明的 lib 与依赖它的 app；core 自己什么都没声明，不受牵连
  assert.deepEqual(r.refused.map((x) => x.id).sort(), ['app', 'lib']);
  const lib = r.refused.find((x) => x.id === 'lib');
  assert.match(lib.reason, /dependency "core" version 1\.0\.0 does not satisfy ">=5\.0\.0"/);
  const app = r.refused.find((x) => x.id === 'app');
  assert.match(app.reason, /depends on "lib", which was refused/);

  // 三级链：一次迭代不够，必须迭代到不动点
  const chain = [
    pack('top', { dependencies: [{ id: 'mid' }] }).pack,
    pack('mid', { dependencies: [{ id: 'low' }] }).pack,
    pack('low', { dependencies: [{ id: 'gone' }] }).pack,
  ];
  const c = adjudicatePackGraph(chain);
  assert.deepEqual(c.refused.map((x) => x.id).sort(), ['low', 'mid', 'top']);
  assert.deepEqual(c.kept, []);
  assert.match(c.refused.find((x) => x.id === 'mid').reason, /depends on "low", which was refused/);
  assert.match(c.refused.find((x) => x.id === 'top').reason, /depends on "mid", which was refused/);
});

test('裁决：依赖成环 ⇒ 环上全体被拒，具名成链；环外的包不受牵连', () => {
  const packs = [
    pack('a', { dependencies: [{ id: 'b' }] }).pack,
    pack('b', { dependencies: [{ id: 'c' }] }).pack,
    pack('c', { dependencies: [{ id: 'a' }] }).pack,
    pack('standalone').pack,
  ];
  const r = adjudicatePackGraph(packs);
  assert.deepEqual(r.refused.map((x) => x.id).sort(), ['a', 'b', 'c'], 'standalone 不受牵连');
  assert.deepEqual(r.kept.map((p) => p.id), ['standalone']);
  assert.match(r.refused[0].reason, /dependency cycle: a → b → c → a/);
});

test('裁决：纯函数 —— 不改输入、同一输入同一输出（按 id 排序迭代）', () => {
  const packs = [
    pack('b', { dependencies: [{ id: 'nope' }] }).pack,
    pack('a', { conflicts: [{ id: 'c' }] }).pack,
    pack('c').pack,
  ];
  const snapshot = JSON.stringify(packs);
  const first = adjudicatePackGraph(packs);
  const second = adjudicatePackGraph(packs.slice().reverse());
  assert.equal(JSON.stringify(packs), snapshot, '输入没被改');
  assert.deepEqual(first, second, '输入顺序不影响结论');
  assert.deepEqual(first.refused.map((x) => x.id), ['b', 'c'], '拒绝表按 id 排序');
});
