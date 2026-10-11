// The mod manager's dependency/conflict half (docs/WORKSHOP.md「mod registry」, plan §1.1): the manifest shape
// (`dependencies` / `conflicts` in shared/workshop.js) and the load-time adjudication (`adjudicatePackGraph`).
//
// Covered: the manifest shape (accepted/refused entries, dedupe, conflicting ranges), the adjudication rules
// (missing dependency / version mismatch / conflict with the larger-id loser / cascade / cycle, all named), and
// that an already-refused dependency cascades to its dependents with the full reason chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest, adjudicatePackGraph } from '../shared/workshop.js';

/** A pack shape the normalizer accepts, with the dependency/conflict fields of the mod registry contract. */
function pack(id, fields = {}) {
  return normalizePackManifest({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', content: ['items'], ...fields,
  }, id, { hasAssets: false });
}

test('manifest shape: dependencies/conflicts are { id, range? } lists, deduped, sorted, ranges validated', () => {
  const ok = pack('a', {
    dependencies: [{ id: 'b' }, { id: 'c', range: '>=1.0.0' }, { id: 'b' }],
    conflicts: [{ id: 'd', range: '<2.0.0' }],
  });
  assert.equal(ok.ok, true, ok.ok ? '' : `${ok.error}: ${ok.detail}`);
  assert.deepEqual(ok.pack.dependencies, [{ id: 'b' }, { id: 'c', range: '>=1.0.0' }], '逐字重复的去重');
  assert.deepEqual(ok.pack.conflicts, [{ id: 'd', range: '<2.0.0' }]);
});

test('manifest shape: unknown fields / bad ids / bad ranges / 不同 range 同一个 id，逐条点名拒绝', () => {
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

test('adjudication: a satisfied dependency keeps both packs; a missing one refuses the dependent', () => {
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

test('adjudication: version ranges — satisfied keeps, mismatch refuses the dependent', () => {
  const packs = [
    pack('app', { dependencies: [{ id: 'lib', range: '>=2.0.0' }] }).pack,
    pack('lib', { version: '2.1.0' }).pack,
  ];
  console.log('DEBUG versions:', JSON.stringify(packs.map((p) => [p.id, p.version, p.dependencies])));
  assert.deepEqual(adjudicatePackGraph(packs).refused, []);

  const old = [
    pack('app', { dependencies: [{ id: 'lib', range: '>=2.0.0' }] }).pack,
    pack('lib', { version: '1.0.0' }).pack,
  ];
  const r = adjudicatePackGraph(old);
  assert.deepEqual(r.refused.map((x) => x.id), ['app']);
  assert.match(r.refused[0].reason, /dependency "lib" version 1\.0\.0 does not satisfy ">=2\.0\.0"/);
  // 依赖包自己没写 version：归一化后是 0.0.0（与「未声明版本」同义），>=2.0.0 的依赖如实拒绝
  const noVersion = adjudicatePackGraph([
    pack('app', { dependencies: [{ id: 'lib', range: '>=2.0.0' }] }).pack,
    pack('lib', { version: undefined }).pack,
  ]);
  assert.deepEqual(noVersion.refused.map((x) => x.id), ['app']);
  assert.match(noVersion.refused[0].reason, /version 0\.0\.0 does not satisfy ">=2\.0\.0"/);
});

test('adjudication: conflicts refuse the larger id, both directions, only when the range matches', () => {
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

test('adjudication: a refused dependency cascades to its dependents with the reason chain', () => {
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
});

test('adjudication: a dependency cycle refuses every member, named as a chain', () => {
  const packs = [
    pack('a', { dependencies: [{ id: 'b' }] }).pack,
    pack('b', { dependencies: [{ id: 'c' }] }).pack,
    pack('c', { dependencies: [{ id: 'a' }] }).pack,
    pack('standalone').pack,
  ];
  const r = adjudicatePackGraph(packs);
  assert.deepEqual(r.refused.map((x) => x.id).sort(), ['a', 'b', 'c'], 'standalone 不受牵连');
  assert.match(r.refused[0].reason, /dependency cycle: a → b → c → a/);
});
