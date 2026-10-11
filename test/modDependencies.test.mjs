// The mod manager's dependency/conflict half (docs/WORKSHOP.md「mod registry」, plan §1.1): the manifest shape
// (`dependencies` / `conflicts` in shared/workshop.js) and the load-time adjudication (`adjudicatePackGraph`).
//
// Covered: the manifest shape (accepted/refused entries, dedupe, conflicting ranges), the adjudication rules
// (missing dependency / version mismatch / conflict with the larger-id loser / cascade / cycle, all named), and
// that an already-refused dependency cascades to its dependents with the full reason chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePackManifest, adjudicatePackGraph } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';

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

// ---- 目标引擎（`target`，docs/WORKSHOP.md「mod registry」1D）：同一份 pack.json 两端各自读得懂 ----------------

/** A Stardust-target manifest: declaration-only (no Forge contributions by design). */
const starPack = (over = {}) => ({
  id: 'sd-pack', name: 'sd-pack', version: '1.0.0', license: 'CC0-1.0',
  target: 'stardust', type: 'mod', capabilities: [], ...over,
});

test('target: stardust 的声明型包被接受（没有 Forge 贡献项也不是空包），profile 两格按 Stardust 规则校验', () => {
  const ok = normalizePackManifest(starPack({ capabilities: ['skins', 'skins'] }), 'sd-pack', { hasAssets: false });
  assert.equal(ok.ok, true, ok.ok ? '' : `${ok.error}: ${ok.detail}`);
  assert.equal(ok.pack.target, 'stardust');
  assert.equal(ok.pack.type, 'mod');
  assert.deepEqual(ok.pack.capabilities, ['skins'], '去重且排序');

  const noType = normalizePackManifest(starPack({ type: undefined }), 'sd-pack', { hasAssets: false });
  assert.equal(noType.ok, false);
  assert.equal(noType.error, 'STARDUST_TARGET_BAD_TYPE');
  const badCaps = normalizePackManifest(starPack({ capabilities: ['Skins'] }), 'sd-pack', { hasAssets: false });
  assert.equal(badCaps.ok, false);
  assert.equal(badCaps.error, 'STARDUST_TARGET_BAD_CAPABILITIES');
  // 未知 target：profile 的两格（type/capabilities）也要去掉 —— 它们只在 target:"stardust" 下合法
  const badTarget = normalizePackManifest(
    { id: 'sd-pack', name: 'sd-pack', version: '1.0.0', license: 'CC0-1.0', target: 'skyrim' }, 'sd-pack', { hasAssets: false });
  assert.equal(badTarget.ok, false);
  assert.equal(badTarget.error, 'PACK_TARGET_UNKNOWN');
});

test('target: forge（缺省）下 type/capabilities 仍是未知键（闭集一字未松）', () => {
  const r = normalizePackManifest({ id: 'f', name: 'f', version: '1.0.0', license: 'CC0-1.0', content: ['items'], type: 'mod' }, 'f', { hasAssets: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'PACK_UNKNOWN_FIELD');
  assert.match(r.detail, /is not a field of this pack format/);
});

test('stardust 目标：声明的能力认领它自己的字段（announcements）；没声明的同名键仍具名拒绝', () => {
  // 声明了 `announcements` 能力 ⇒ 它认领的 `announcements` 字段放行（本引擎只看形状：字段内部是 Stardust profile 要判的）
  const ok = normalizePackManifest(
    starPack({ capabilities: ['announcements'], announcements: [{ title: '本服公告', paragraphs: ['欢迎。'] }] }), 'sd-pack', { hasAssets: false });
  assert.equal(ok.ok, true, ok.ok ? '' : `${ok.error}: ${ok.detail}`);
  assert.deepEqual(ok.pack.capabilities, ['announcements']);

  // 没声明那个能力 ⇒ 同一个键还是未知键（闭集没有松，只是多了一条「能力认领」的例外）
  const noCap = normalizePackManifest(starPack({ announcements: [{ title: 'x', paragraphs: ['y'] }] }), 'sd-pack', { hasAssets: false });
  assert.equal(noCap.ok, false);
  assert.equal(noCap.error, 'PACK_UNKNOWN_FIELD');
  assert.match(noCap.detail, /"announcements"/);

  // `capabilities` 里写别的能力不会顺手放行 announcements（认领按能力逐条对表）
  const otherCap = normalizePackManifest(starPack({ capabilities: ['skins'], announcements: [] }), 'sd-pack', { hasAssets: false });
  assert.equal(otherCap.ok, false);
  assert.equal(otherCap.error, 'PACK_UNKNOWN_FIELD');

  // forge 目标下（连 capabilities 都不是本引擎的键）更不会放行
  const forge = normalizePackManifest({ id: 'f', name: 'f', version: '1.0.0', license: 'CC0-1.0', content: ['items'], announcements: [] }, 'f', { hasAssets: false });
  assert.equal(forge.error, 'PACK_UNKNOWN_FIELD');
  assert.doesNotMatch(forge.detail, /capability/, 'forge 目标的错误文案不提别的引擎的能力');

  // 同一件东西的两种拼法都放行（stardust 目标）：`englishName` / `authors` / `app` 是本引擎没有的拼法，
  // 一份自然的 Stardust 清单不该因为写了自己的名字而被本引擎拒。
  const spelled = normalizePackManifest(starPack({ englishName: 'Server notice', authors: ['jingjiangze'], app: '>=0.2.0' }), 'sd-pack', { hasAssets: false });
  assert.equal(spelled.ok, true, spelled.ok ? '' : `${spelled.error}: ${spelled.detail}`);

  // 名字撞车用例：本引擎自己的 `notices`（对象，DESIGN §28.15）在 stardust 包上仍按**本引擎**的形状判 ——
  // 这正是 Stardust 侧那个能力叫 `announcements` 的原因（同一个键不能对两个宿主说两种形状）。
  const collide = normalizePackManifest(starPack({ notices: [{ title: 'x' }] }), 'sd-pack', { hasAssets: false });
  assert.equal(collide.ok, false);
  assert.equal(collide.error, 'NOTICES_BAD_SHAPE');
});

test('装载器：workshop 里的 stardust 包不进 packs、记一行 foreign（具名），forge 包照常装载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-target-'));
  try {
    const sd = path.join(dir, 'sd-pack');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'pack.json'), `${JSON.stringify(starPack(), null, 2)}\n`);
    const forge = path.join(dir, 'forge-pack');
    fs.mkdirSync(forge, { recursive: true });
    fs.writeFileSync(path.join(forge, 'pack.json'), `${JSON.stringify({ id: 'forge-pack', name: 'f', version: '1.0.0', license: 'CC0-1.0', content: ['items'] }, null, 2)}\n`);
    fs.writeFileSync(path.join(forge, 'items.json'), `${JSON.stringify({ forge_item_a: { id: 'forge_item_a', name: 'x', tier: 1 } }, null, 2)}\n`);

    const loaded = loadWorkshop(dir, { log: null });
    assert.deepEqual(loaded.errors, [], '一条拒绝都不该有：stardust 包不是错误');
    assert.deepEqual(loaded.packs.map((p) => p.id), ['forge-pack'], '只有 forge 包进 packs');
    assert.deepEqual(loaded.foreign.map((f) => f.pack), ['sd-pack']);
    assert.match(loaded.foreign[0].reason, /declaration-only, loaded by the Stardust host/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
