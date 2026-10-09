// test/modIdentity.test.js — the identity of a mod set (shared/modIdentity.js, DESIGN §27.2).
//
// Two things must hold, or the identity is worse than none:
//   * the pure sha256 must equal node:crypto's, byte for byte (the browser recomputes the digest of a list, and a
//     disagreement between the two implementations would be silent);
//   * a content hash must depend on the CONTENT and on nothing else — not on key order, not on the pack order, not on
//     whitespace inside a normalized record.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MOD_LIMITS, MOD_LAYERS, isModId, isModEntry, isModList, isModDigest, sha256Hex, canonicalJson, modManifestDigest, modDigest, modSetOf,
} from '../shared/modIdentity.js';

const H = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const entry = (id, hash = H(id), extra = {}) => ({ id, hash, layer: 'A', combat: false, ...extra });

describe('mod identity: the pure sha256 is the real one', () => {
  test('it matches node:crypto over the awkward lengths and non-ASCII text', () => {
    const samples = [
      '', 'a', 'abc', 'message digest',
      'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      '1234567890'.repeat(8),                       // 80 bytes: two blocks
      'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(57), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65),
      '工坊 mod layer：身份与哈希', 'a'.repeat(1000), '🙂'.repeat(40),   // multi-byte UTF-8 and a surrogate pair
    ];
    for (const s of samples) {
      assert.equal(sha256Hex(s), H(s), `sha256(${JSON.stringify(s.slice(0, 24))}…)`);
    }
    // and it takes bytes as well as text (the loader hashes file bytes)
    assert.equal(sha256Hex(Uint8Array.from([0x61, 0x62, 0x63])), H('abc'));
  });

  test('the digest helpers produce digests of the declared shape', () => {
    const d = modDigest([entry('alpha'), entry('beta')]);
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.ok(isModDigest(d));
    assert.ok(!isModDigest('nope'), 'a non-hex string is not a digest');
    assert.ok(!isModDigest('ab'), 'a two-character digest is not one of ours');
  });
});

describe('mod identity: a hash depends on the content, and on nothing else', () => {
  test('canonicalJson sorts keys and drops undefined, so key order cannot move a hash', () => {
    const a = { b: 1, a: [2, { d: 4, c: 3 }], keep: true, drop: undefined };
    const b = { drop: undefined, keep: true, a: [2, { c: 3, d: 4 }], b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalJson(a), '{"a":[2,{"c":3,"d":4}],"b":1,"keep":true}');
    assert.equal(canonicalJson(undefined), 'null');
    assert.equal(canonicalJson([1, 'x', null]), '[1,"x",null]');
  });

  test('the manifest digest is stable across entry order and changes when one byte changes', () => {
    const m = [{ path: 'pack.json', hash: H('1') }, { path: 'kits/a.js', hash: H('2') }, { path: 'chess.json', hash: H('3') }];
    const shuffled = [m[2], m[0], m[1]];
    assert.equal(modManifestDigest(m), modManifestDigest(shuffled), 'the list is sorted before hashing');
    const changed = [{ ...m[0], hash: H('1!') }, m[1], m[2]];
    assert.notEqual(modManifestDigest(m), modManifestDigest(changed), 'a changed byte must change the hash');
    const renamed = [{ ...m[0], path: 'pack2.json' }, m[1], m[2]];
    assert.notEqual(modManifestDigest(m), modManifestDigest(renamed), 'a renamed file must change the hash (the path is part of the pair)');
  });

  test('the set digest is order-independent and ignores entries that are not well-formed', () => {
    const list = [entry('zeta'), entry('alpha'), entry('mid')];
    assert.equal(modDigest(list), modDigest([...list].reverse()));
    assert.equal(modDigest(list), modDigest([...list, { id: 'broken' }]), 'an entry without a hash is not part of the identity');
    assert.notEqual(modDigest(list), modDigest([entry('alpha'), entry('mid')]), 'dropping a pack must change the digest');
    assert.notEqual(modDigest(list), modDigest([entry('zeta', H('other')), ...list.slice(1)]), 'a pack that changed must change the digest');
  });
});

describe('mod identity: the wire shape', () => {
  test('an entry needs a pack id, a sha256, a layer and a declared intent', () => {
    assert.ok(isModId('alpha') && !isModId('no spaces') && !isModId('A'.repeat(33)), 'the id charset is the pack directory rule');
    assert.ok(isModEntry(entry('alpha')));
    assert.ok(isModEntry(entry('alpha', H('x'), { layer: 'B', combat: true, api: '>=1 <2' })));
    for (const bad of [
      null, [], 'alpha', { ...entry('alpha'), id: 'no spaces here' }, { ...entry('alpha'), id: 'A'.repeat(33) },
      { ...entry('alpha'), hash: 'not-a-hash' }, { ...entry('alpha'), hash: H('x').toUpperCase() },
      { ...entry('alpha'), layer: 'D' }, { ...entry('alpha'), layer: undefined },
      { ...entry('alpha'), combat: 'yes' }, { ...entry('alpha'), combat: undefined },
      { ...entry('alpha'), api: 'x'.repeat(MOD_LIMITS.api + 1) },
    ]) assert.equal(isModEntry(bad), false, JSON.stringify(bad));
    assert.deepEqual([...MOD_LAYERS], ['A', 'B', 'C']);
  });

  test('a list refuses duplicates and an oversized set, and accepts the empty one', () => {
    assert.ok(isModList([]));
    assert.ok(isModList([entry('a'), entry('b')]));
    assert.ok(!isModList(null));
    assert.ok(!isModList('nope'));
    assert.ok(!isModList([entry('a'), entry('a')]), 'the same pack twice is not a set');
    assert.ok(!isModList([entry('a'), { ...entry('b'), layer: 'Z' }]));
    assert.ok(!isModList(Array.from({ length: MOD_LIMITS.packs + 1 }, (_, i) => entry(`p${i}`))));
  });

  test('modSetOf sorts, digests and returns null when there is nothing to declare', () => {
    assert.equal(modSetOf([]), null);
    assert.equal(modSetOf(null), null);
    assert.equal(modSetOf([{ id: 'broken' }]), null, 'a malformed entry is not a mod set');
    const set = modSetOf([entry('zeta'), entry('alpha')]);
    assert.deepEqual(set.packs.map((p) => p.id), ['alpha', 'zeta']);
    assert.equal(set.digest, modDigest([entry('zeta'), entry('alpha')]));
    // the digest a client is handed can be checked against the list it is handed: that is the point of doing this in
    // pure JS (DESIGN §27.2, §27.9)
    assert.equal(set.digest, modDigest(set.packs));
  });
});

describe('mod identity: the loader hashes a pack from its own bytes', () => {
  test('the shipped example pack hashes to a stable value, and the hash covers data + kit + assets', async () => {
    const { loadWorkshop } = await import('../server/workshop.js');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };

    // docs/examples/ is a workshop ROOT: it holds one directory per pack
    const root = join(ROOT, 'docs/examples');
    const first = loadWorkshop(root, { log: quiet });
    const second = loadWorkshop(root, { log: quiet });
    assert.deepEqual(first.errors, []);
    const a = first.packs.find((p) => p.id === 'kit-demo');
    assert.ok(a, `the behaviour-layer example must load: ${first.packs.map((p) => p.id).join(', ')}`);
    assert.match(a.hash, /^[0-9a-f]{64}$/, 'the loader attaches a content hash');
    assert.equal(a.hash, second.packs.find((p) => p.id === 'kit-demo').hash, 'two loads of the same bytes agree');
    assert.equal(a.layer, 'B', 'a pack that ships kits is a behaviour-layer pack');
    assert.equal(a.combat, true, 'code that hooks the battle bus may change a battle result, so the derived intent is true');
    assert.ok(a.manifest.length >= 3, `the hash covers data + kit (got ${JSON.stringify(a.manifest)})`);
    assert.deepEqual(a.manifest.map((m) => m.path), [...a.manifest.map((m) => m.path)].sort(), 'the manifest list is sorted by path');
    assert.ok(a.manifest.some((m) => m.path === 'pack.json'));
    assert.ok(a.manifest.some((m) => m.path.startsWith('kits/')), 'the kit SOURCE is hashed, not just its existence');
    // the data-only example: layer A, no declaration, and a different hash
    const demo = first.packs.find((p) => p.id === 'demo-workshop');
    assert.equal(demo.layer, 'A');
    assert.equal(demo.combat, false, 'a data-only pack does not declare a battle-result change');
    assert.notEqual(demo.hash, a.hash);
    // the identity entry is exactly what the wire carries
    assert.ok(isModEntry({ id: a.id, hash: a.hash, layer: a.layer, combat: a.combat, api: a.api }));
  });
});
