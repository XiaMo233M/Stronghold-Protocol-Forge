// test/modMatchKinds.test.mjs — DESIGN §28.52 的 `pack.json.matchKinds`：形状、两条硬闸门、字节稳定性，
// 以及 `host.matchKinds()` 那半边「没声明 matchClass 就没有能力」。
//
// 与 test/packBehaviour.test.js 同一套打法：合成 raw manifest 直接喂 `normalizePackManifest`，逐个拒绝分支
// 走一遍。判据不是「代码写了」，而是「作者写错时听到的是哪一句话」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest, PACK_FIELDS, MATCH_KIND_FIELDS, MAX_PACK_MATCH_KINDS, MATCH_KIND_SEATS_MAX } from '../shared/workshop.js';
import { moduleHost } from '../server/modModules.js';

/** 一份最小合法包（`operators` 让它不是空包，与 packBehaviour.test.js 同一条）。 */
const mk = (extra = {}) => normalizePackManifest({
  id: 'p', name: 'p', content: [], operators: { char_x: { powers: [], bonds: [] } }, ...extra,
}, 'p');

/** 声明了 matchClass 包装器的那半边（种类声明的接收人）。 */
const WRAP = [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'] }];
const KIND = [{ id: 'football_3v3', seats: { min: 6, max: 6 }, label: '阵地足球' }];
const legal = (kinds = KIND) => mk({ combat: true, server: { modules: WRAP }, matchKinds: kinds });

describe('合法形状与字节稳定性', () => {
  test('matchKinds 是 pack.json 的已登记顶层键', () => {
    assert.ok(PACK_FIELDS.includes('matchKinds'), 'PACK_FIELDS must accept matchKinds');
    assert.deepEqual([...MATCH_KIND_FIELDS], ['id', 'seats', 'label']);
  });

  test('种类按 id 排序进归一化结果，书写顺序不影响字节', () => {
    const a = legal([{ id: 'b_kind' }, { id: 'a_kind', seats: { min: 2, max: 4 } }]);
    const b = legal([{ id: 'a_kind', seats: { min: 2, max: 4 } }, { id: 'b_kind' }]);
    assert.equal(a.ok, true, JSON.stringify(a.detail));
    assert.deepEqual(a.pack.matchKinds.map((k) => k.id), ['a_kind', 'b_kind']);
    assert.equal(JSON.stringify(a.pack.matchKinds), JSON.stringify(b.pack.matchKinds));
  });

  test('没声明的包一个字节都不变（与 variants / behaviour 同一条纪律）', () => {
    const bare = mk({ combat: true, server: { modules: WRAP } });
    assert.equal(bare.ok, true, JSON.stringify(bare.detail));
    assert.ok(!Object.hasOwn(bare.pack, 'matchKinds'), 'an undeclared matchKinds must not appear in the manifest');
  });
});

describe('两条硬闸门：没有接收人 / 不肯认 combat', () => {
  test('只有种类声明、没有 matchClass 包装器 ⇒ 点名拒', () => {
    const bad = mk({ combat: true, server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['healthz'] }] }, matchKinds: KIND });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'MATCHKINDS_NEED_MATCH_CLASS');
  });

  test('连 server.modules 都没有 ⇒ 同一条拒（而不是静默通过）', () => {
    const bad = mk({ combat: true, matchKinds: KIND });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'MATCHKINDS_NEED_MATCH_CLASS');
  });

  test('有包装器但不声明 combat ⇒ 由 §28.14 那条先拦（这一格不重复判，写了也永远不会命中）', () => {
    const bad = mk({ server: { modules: WRAP }, matchKinds: KIND });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'MODULES_NEED_COMBAT');
  });
});

describe('形状判据逐条响亮', () => {
  const cases = [
    ['不是数组', 'MATCHKINDS_BAD_SHAPE', 'football'],
    ['空数组（该删键而不是发 []）', 'MATCHKINDS_EMPTY', []],
    ['超过上界', 'MATCHKINDS_TOO_MANY', Array.from({ length: MAX_PACK_MATCH_KINDS + 1 }, (_, i) => ({ id: `k${i}` }))],
    ['未知字段', 'MATCHKINDS_UNKNOWN_FIELD', [{ id: 'k', waves: 3 }]],
    ['坏 id（大写 / 空格 / 空）', 'MATCHKINDS_BAD_ID', [{ id: 'Bad Id' }]],
    ['重复 id', 'MATCHKINDS_DUPLICATE_ID', [{ id: 'k' }, { id: 'k' }]],
    ['seats 不是对象', 'MATCHKINDS_BAD_SEATS', [{ id: 'k', seats: 6 }]],
    ['seats 越界', 'MATCHKINDS_BAD_SEATS', [{ id: 'k', seats: { min: 0, max: 4 } }]],
    ['seats 超过最大座位', 'MATCHKINDS_BAD_SEATS', [{ id: 'k', seats: { min: 1, max: MATCH_KIND_SEATS_MAX + 1 } }]],
    ['min 大于 max', 'MATCHKINDS_BAD_SEATS', [{ id: 'k', seats: { min: 6, max: 4 } }]],
    ['label 是空串', 'MATCHKINDS_BAD_LABEL', [{ id: 'k', label: '   ' }]],
  ];
  for (const [what, code, value] of cases) {
    test(`${what} ⇒ ${code}`, () => {
      const bad = legal(value);
      assert.equal(bad.ok, false, `${what} must be refused`);
      assert.equal(bad.error, code);
    });
  }
});

describe('只声明种类不算贡献（EMPTY_PACK 必须点名它）', () => {
  test('只写种类、什么都没带来 ⇒ EMPTY_PACK，文案点名 matchKinds', () => {
    const only = normalizePackManifest({ id: 'p', name: 'p', content: [], matchKinds: KIND }, 'p');
    assert.equal(only.ok, false);
    assert.equal(only.error, 'EMPTY_PACK');
    assert.match(only.detail, /"matchKinds" is NOT a contribution/);
  });
});

describe('host.matchKinds()：没声明 matchClass 就没有这个能力', () => {
  const kinds = [{ id: 'football_3v3', seats: { min: 6, max: 6 } }];

  test('声明了 matchClass ⇒ 拿到冻结的只读数据', () => {
    const host = moduleHost({ packId: 'p', moduleId: 'm', uses: ['matchClass'], matchKinds: kinds });
    const got = host.matchKinds();
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 'football_3v3');
    assert.ok(Object.isFrozen(got) && Object.isFrozen(got[0]) && Object.isFrozen(got[0].seats), 'kinds must be deeply frozen');
    assert.throws(() => { got[0].seats.min = 1; }, TypeError, 'a module must not be able to rewrite its own declaration');
  });

  test('没声明那个挂载点就点名，而不是交出 undefined', () => {
    assert.throws(() => moduleHost({ packId: 'p', moduleId: 'm', uses: ['healthz'], matchKinds: kinds }).matchKinds(),
      (e) => e.code === 'MODULE_USE_UNDECLARED' && /matchClass/.test(e.message));
    assert.throws(() => moduleHost({ packId: 'p', moduleId: 'm', uses: [], matchKinds: kinds }).matchKinds(),
      (e) => e.code === 'MODULE_USE_UNDECLARED');
  });

  test('声明了 matchClass 但包没写种类 ⇒ 空数组（不是 null：调用方不必再判一次）', () => {
    assert.deepEqual(moduleHost({ packId: 'p', moduleId: 'm', uses: ['matchClass'] }).matchKinds(), []);
  });
});
