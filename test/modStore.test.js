// test/modStore.test.js — the CLIENT mod store: the backend seam, the downloader, and the local pack hash
// (public/js/mods/store.js, public/js/mods/sync.js).
//
// These modules run in a BROWSER, so the two things this file proves first are that importing them in Node does not
// throw (no `navigator` / `indexedDB` / `crypto.subtle` at import time) and that the whole download/verify path runs on
// the injectable MEMORY backend. What it then proves is the point of the feature: the client can tell what it is missing,
// can fetch it, and can rebuild the SERVER's pack hash from its own bytes with the server's own algorithm — and a file
// whose bytes are wrong is never written and never counted as complete.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { buildModCatalog } from '../server/modCatalog.js';
import { createMemoryBackend, createStore, modKey, safeModKey, openStore } from '../public/js/mods/store.js';
import { missing, sync, localPackHash, localSetDigest, hashBytes, fileUrl, CATALOG_URL } from '../public/js/mods/sync.js';
import { modDigest } from '../shared/modIdentity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const CHESS = { chess_ws_alpha: { name: 'alpha', hp: 100 } };
const KIT = 'export default function kit() { return {}; }\n';

let tmp;
let wsRoot;
let loaded;
let catalog;
let srv;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modstore-client-'));
  wsRoot = join(tmp, 'ws');
  const alpha = join(wsRoot, 'alpha-pack');
  fs.mkdirSync(join(alpha, 'kits'), { recursive: true });
  fs.mkdirSync(join(alpha, 'assets', 'sprites'), { recursive: true });
  fs.writeFileSync(join(alpha, 'pack.json'), JSON.stringify({ id: 'alpha-pack', name: 'Alpha Pack', version: '1.2.0', license: 'CC0-1.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(alpha, 'chess.json'), JSON.stringify(CHESS));
  fs.writeFileSync(join(alpha, 'kits', 'chess_ws_alpha.js'), KIT);
  fs.writeFileSync(join(alpha, 'assets', 'sprites', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
  const beta = join(wsRoot, 'beta-pack');
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(join(beta, 'pack.json'), JSON.stringify({ id: 'beta-pack', version: '1.0.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(beta, 'chess.json'), JSON.stringify(CHESS));

  loaded = loadWorkshop(wsRoot, { log: quiet });
  assert.deepEqual(loaded.errors, []);
  catalog = buildModCatalog(loaded);
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
});
after(async () => {
  await srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A `fetch` that serves the fixture bytes for a `/mods/file/...` URL, with a call counter. */
function fixtureFetch({ corrupt = false, failFirst = 0, status = 200 } = {}) {
  const state = { calls: 0, urls: [] };
  const impl = async (url) => {
    state.calls += 1;
    state.urls.push(String(url));
    if (state.calls <= failFirst) throw new Error('network down');
    if (corrupt) return { ok: true, status, arrayBuffer: async () => new TextEncoder().encode('wrong bytes').buffer };
    // the route prefix is a fixed string; deriving it from fileUrl('', '') would be one separator too long
    const rel = String(url).replace(/^\/mods\/file\//, '');
    const slash = rel.indexOf('/');
    const id = decodeURIComponent(rel.slice(0, slash));
    const path = rel.slice(slash + 1).split('/').map(decodeURIComponent).join('/');
    const abs = join(wsRoot, id, ...path.split('/'));
    if (!fs.existsSync(abs)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = fs.readFileSync(abs);
    // a COPY, not `buf.buffer.slice(...)`: Node reads small files out of a SHARED pool, so the slice would be a view
    // over the whole 8 KB pool and every "download" would hash the wrong bytes
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(buf).buffer };
  };
  return { state, impl };
}

describe('mod store: the backend seam', () => {
  test('the module imports in Node without a DOM, and no backend is touched at import time', () => {
    assert.equal(typeof globalThis.navigator?.storage, 'undefined', 'this runtime really has no OPFS');
    assert.equal(typeof createStore, 'function');
    assert.equal(typeof openStore, 'function');
    assert.equal(CATALOG_URL, '/mods/catalog.json');
  });

  test('openStore() falls through to memory in Node and never throws', async () => {
    const store = openStore();
    assert.equal(store.backend, 'memory');
    assert.deepEqual(await store.usage(), { bytes: 0, files: 0 });
    // an explicitly requested backend that is unavailable falls through rather than failing
    assert.equal(openStore('opfs').backend, 'memory');
  });

  test('the store API is has / read / write / remove / list / usage over byte values', async () => {
    const store = createStore(createMemoryBackend());
    const bytes = new Uint8Array([1, 2, 3, 250]);
    assert.equal(await store.has(modKey('a', 'chess.json')), false);
    assert.equal(await store.read(modKey('a', 'chess.json')), null);
    await store.write(modKey('a', 'chess.json'), bytes);
    await store.write(modKey('a', 'kits/x.js'), new Uint8Array([9]));
    assert.equal(await store.has(modKey('a', 'chess.json')), true);
    assert.deepEqual([...await store.read(modKey('a', 'chess.json'))], [1, 2, 3, 250]);
    assert.deepEqual(await store.list(), [modKey('a', 'chess.json'), modKey('a', 'kits/x.js')], 'sorted keys');
    assert.deepEqual(await store.list('mods/a/kits/'), [modKey('a', 'kits/x.js')], 'prefix filter');
    assert.deepEqual(await store.usage(), { bytes: 5, files: 2 });
    // a value handed back is a COPY: a caller cannot corrupt the cache by writing into what it read
    const read = await store.read(modKey('a', 'chess.json'));
    read[0] = 99;
    assert.equal((await store.read(modKey('a', 'chess.json')))[0], 1);
    await store.remove(modKey('a', 'chess.json'));
    assert.equal(await store.has(modKey('a', 'chess.json')), false);
    assert.deepEqual(await store.usage(), { bytes: 1, files: 1 });
  });

  test('a key that would leave the store prefix is refused, not stored', async () => {
    const store = createStore(createMemoryBackend());
    for (const bad of ['mods/../secret', '/etc/passwd', 'a\\b', 'mods/a//b', '', null]) {
      assert.equal(safeModKey(bad), false, JSON.stringify(bad));
      await assert.rejects(() => store.write(bad, new Uint8Array([1])), /unsafe mod key/);
      await assert.rejects(() => store.read(bad), /unsafe mod key/);
    }
    assert.equal(safeModKey('mods/a/chess.json'), true);
  });
});

describe('mod store: hashing', () => {
  test('hashBytes agrees with node:crypto and with the pure-JS sha256 the browser also uses', async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([0]), new TextEncoder().encode('工坊 mod layer'), new Uint8Array(200).fill(7)]) {
      const expected = sha(Buffer.from(bytes));
      assert.equal(await hashBytes(bytes), expected);
      // the same input as a plain ArrayBuffer must give the same digest (a store may hand either back)
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      assert.equal(await hashBytes(copy), expected);
    }
  });

  test('fileUrl percent-encodes per segment, so a subdirectory stays a path', () => {
    assert.equal(fileUrl('alpha-pack', 'chess.json'), '/mods/file/alpha-pack/chess.json');
    assert.equal(fileUrl('alpha-pack', 'assets/sprites/a b.png'), '/mods/file/alpha-pack/assets/sprites/a%20b.png');
  });
});

describe('mod store: what is missing', () => {
  test('an empty store is missing everything the room names — and nothing it does not name', async () => {
    const store = createStore(createMemoryBackend());
    const total = catalog.packs.reduce((n, p) => n + p.files.length, 0);
    assert.equal((await missing(catalog, null, store)).length, total, 'null packIds = the whole catalogue');
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    const onlyAlpha = await missing(catalog, ['alpha-pack'], store);
    assert.equal(onlyAlpha.length, alpha.files.length, 'the room\'s set decides what is considered');
    assert.deepEqual([...new Set(onlyAlpha.map((f) => f.packId))], ['alpha-pack']);
    assert.deepEqual(onlyAlpha.map((f) => f.path), alpha.files.map((f) => f.path), 'with the catalogue metadata');
    assert.equal((await missing(catalog, [], store)).length, 0, 'an empty room set asks for nothing');
    assert.equal((await missing(catalog, ['a-pack-this-server-lacks'], store)).length, 0, 'an unknown pack is skipped');
  });

  test('a full store is missing nothing; a pack with a changed byte is re-fetched by sync', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    const first = await sync({ catalog, packIds: null, store, fetch: net.impl });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await missing(catalog, null, store)).length, 0, 'nothing left missing');
    assert.equal((await missing(catalog, ['alpha-pack'], store)).length, 0);
    // corrupt one stored byte: `missing` is an EXISTENCE check (cheap), so it still says present…
    const key = modKey('beta-pack', 'chess.json');
    const bad = (await store.read(key)).slice();
    bad[bad.length - 2] ^= 0x01;
    await store.write(key, bad);
    assert.equal((await missing(catalog, ['beta-pack'], store)).length, 0);
    // …and sync notices the digest mismatch, re-fetches that one file and heals it
    const callsBefore = net.state.calls;
    const healed = await sync({ catalog, packIds: ['beta-pack'], store, fetch: net.impl });
    assert.equal(healed.ok, true, JSON.stringify(healed));
    assert.equal(net.state.calls - callsBefore, 1, 'exactly the corrupted file was re-downloaded');
    assert.equal((await store.read(key)).length, bad.length, 'and it is the real file again');
    assert.equal(await localPackHash('beta-pack', store, catalog), catalog.packs.find((p) => p.id === 'beta-pack').hash);
  });
});

describe('mod store: sync downloads, verifies and never trusts a bad byte', () => {
  test('a first sync fetches every file of the named packs and reports progress', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    const events = [];
    const summary = await sync({ catalog, packIds: ['alpha-pack', 'beta-pack'], store, fetch: net.impl, onProgress: (e) => events.push(e) });
    assert.equal(summary.ok, true);
    assert.equal(summary.downloaded, 6, 'alpha-pack: 4 files, beta-pack: 2');
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.packs.map((p) => [p.packId, p.ok]), [['alpha-pack', true], ['beta-pack', true]]);
    assert.equal(net.state.calls, 6);
    // the events a UI needs, in order: catalog → per pack → per file → done
    assert.deepEqual(events[0], { type: 'catalog', packs: ['alpha-pack', 'beta-pack'], total: 6 });
    assert.ok(events.some((e) => e.type === 'pack' && e.packId === 'alpha-pack' && e.files === 4));
    assert.equal(events.filter((e) => e.type === 'file-done').length, 6);
    assert.ok(events.some((e) => e.type === 'file-done' && e.path === 'chess.json' && e.bytes > 0 && e.total === 6));
    const last = events.at(-1);
    assert.equal(last.type, 'done');
    assert.equal(last.ok, true);
    assert.equal(last.downloaded, 6);
  });

  test('a second sync makes no request at all — every file already hashes to its catalogue value', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    await sync({ catalog, packIds: null, store, fetch: net.impl });
    const after1 = net.state.calls;
    const second = await sync({ catalog, packIds: null, store, fetch: net.impl });
    assert.equal(net.state.calls, after1, 'nothing was re-fetched');
    assert.equal(second.downloaded, 0);
    assert.equal(second.skipped, 6, 'five files of the fixture plus beta-pack\'s own pack.json');
    assert.equal(second.ok, true);
  });

  test('a server that serves the WRONG bytes fails the pack and stores nothing', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch({ corrupt: true });
    const events = [];
    const summary = await sync({ catalog, packIds: ['beta-pack'], store, fetch: net.impl, retries: 2, onProgress: (e) => events.push(e) });
    assert.equal(summary.ok, false);
    assert.equal(summary.downloaded, 0, 'a mismatched download is never written');
    assert.equal(summary.failed, 2, 'both files of the pack');
    assert.equal(summary.packs[0].ok, false, 'the pack is NOT marked complete');
    assert.equal(summary.packs[0].failed.length, 2);
    for (const f of summary.packs[0].failed) assert.match(f.reason, /sha256 mismatch/);
    assert.deepEqual(summary.packs[0].failed.map((f) => f.path).sort(), ['chess.json', 'pack.json']);
    assert.equal(await store.has(modKey('beta-pack', 'pack.json')), false, 'nothing reached the store');
    assert.equal(await store.has(modKey('beta-pack', 'chess.json')), false);
    assert.equal(await localPackHash('beta-pack', store, catalog), null, 'an incomplete pack has no hash');
    assert.equal(net.state.calls, 6, 'two files, one try plus two retries each');
    assert.equal(events.filter((e) => e.type === 'file-error').length, 2);
    assert.equal(events.filter((e) => e.type === 'file-retry').length, 4);
  });

  test('a transport failure is retried, and a later attempt that works completes the pack', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch({ failFirst: 1 });
    const summary = await sync({ catalog, packIds: ['beta-pack'], store, fetch: net.impl, retries: 2 });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.downloaded, 2);
    assert.equal(net.state.calls, 3, 'the first file failed once and succeeded on the retry');
  });

  test('a 404 is a failure, not an empty file', async () => {
    const store = createStore(createMemoryBackend());
    const doFetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const summary = await sync({ catalog, packIds: ['beta-pack'], store, fetch: doFetch, retries: 0 });
    assert.equal(summary.ok, false);
    assert.match(summary.packs[0].failed[0].reason, /HTTP 404/);
    assert.equal(await store.usage().then((u) => u.files), 0);
  });

  test('concurrency bounds how many files are in flight at once', async () => {
    const store = createStore(createMemoryBackend());
    let inFlight = 0;
    let peak = 0;
    const net = fixtureFetch();
    const doFetch = async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await net.impl(url);
      } finally { inFlight -= 1; }
    };
    const summary = await sync({ catalog, packIds: ['alpha-pack'], store, fetch: doFetch, concurrency: 2 });
    assert.equal(summary.ok, true);
    assert.ok(peak <= 2, `at most 2 files at once, saw ${peak}`);
    assert.ok(peak >= 2, 'and it really did run two at once');
  });

  test('a pack whose stored files no longer add up to the catalogue hash is not ok', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    await sync({ catalog, packIds: ['beta-pack'], store, fetch: net.impl });
    // swap in a DIFFERENT file that still hashes to its own listed sha256 — the per-file check passes, the pack hash
    // cannot, and the pack must not be called complete
    const doctored = {
      packs: [{ ...catalog.packs.find((p) => p.id === 'beta-pack'), hash: 'f'.repeat(64) }],
    };
    const summary = await sync({ catalog: doctored, packIds: ['beta-pack'], store, fetch: net.impl });
    assert.equal(summary.ok, false, 'a catalogue whose hash disagrees with its own file contributions must fail');
    assert.match(summary.packs[0].failed[0].reason, /pack hash/);
    assert.equal(summary.packs[0].failed[0].path, '*');
  });
});

describe('mod store: the local pack hash is the server\'s', () => {
  test('localPackHash over the stored bytes equals the server\'s pack hash, for the same fixture', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    await sync({ catalog, packIds: null, store, fetch: net.impl });
    for (const pack of catalog.packs) {
      assert.equal(await localPackHash(pack.id, store, catalog), pack.hash, `${pack.id}: rebuilt from local bytes`);
      assert.match(pack.hash, /^[0-9a-f]{64}$/);
    }
  });

  test('a missing file, or no catalogue entry at all, means no hash — never a partial one', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    await sync({ catalog, packIds: ['alpha-pack'], store, fetch: net.impl });
    await store.remove(modKey('alpha-pack', 'kits/chess_ws_alpha.js'));
    assert.equal(await localPackHash('alpha-pack', store, catalog), null, 'a pack without its kit has no version');
    assert.equal(await localPackHash('nope-pack', store, catalog), null);
    assert.equal(await localPackHash('alpha-pack', store, null), null, 'without the catalogue there is nothing to check against');
  });

  test('the set digest of a room\'s packs is modDigest over the locally verified hashes', async () => {
    const store = createStore(createMemoryBackend());
    const net = fixtureFetch();
    await sync({ catalog, packIds: null, store, fetch: net.impl });
    const entries = catalog.packs.map((p) => ({ id: p.id, hash: p.hash }));
    const local = await localSetDigest(entries, store, catalog);
    assert.ok(local);
    assert.equal(local.digest, modDigest(entries), 'the same number the server computes for the same set');
    // an incomplete set has no digest: "I have some of it" must not look like "I have it"
    await store.remove(modKey('beta-pack', 'chess.json'));
    assert.equal(await localSetDigest(entries, store, catalog), null);
    assert.equal(await localSetDigest([], store, catalog), null, 'an empty set is not a digest (modSetOf returns null too)');
  });
});

describe('mod store: the server\'s own catalogue is the source of truth', () => {
  test('the fixture packs are downloadable from the real HTTP route, and verify against it', async () => {
    const res = await fetch(`${srv.url}${CATALOG_URL}`);
    assert.equal(res.status, 200);
    const served = await res.json();
    assert.deepEqual(served.packs.map((p) => p.id), catalog.packs.map((p) => p.id), 'the route serves the built catalogue');
    const store = createStore(createMemoryBackend());
    // the real server IS the fetch: absolute URL, real bytes, real 404s
    const summary = await sync({ catalog: served, packIds: null, store, fetch: (url) => fetch(`${srv.url}${url}`) });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    for (const pack of served.packs) {
      assert.equal(await localPackHash(pack.id, store, served), pack.hash, `${pack.id} verified against the live server`);
    }
    // and a file the catalogue does not list cannot be fetched even with a hand-written URL
    const denied = await fetch(`${srv.url}/mods/file/alpha-pack/../pack.json`);
    assert.equal(denied.status, 404);
  });

  test('a server with no mods makes the client issue NO request', async () => {
    const emptyRoot = join(tmp, 'empty-ws');
    fs.mkdirSync(emptyRoot, { recursive: true });
    const empty = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: emptyRoot });
    try {
      const served = await (await fetch(`${empty.url}${CATALOG_URL}`)).json();
      assert.deepEqual(served, { packs: [] });
      const net = fixtureFetch();
      const store = createStore(createMemoryBackend());
      // the room's set drives everything: with no packs to name there is nothing to ask for
      assert.deepEqual(await missing(served, null, store), []);
      assert.deepEqual(await missing(served, [], store), []);
      const summary = await sync({ catalog: served, packIds: null, store, fetch: net.impl });
      assert.equal(net.state.calls, 0, 'not one request');
      assert.deepEqual(summary, { ok: true, packs: [], downloaded: 0, skipped: 0, failed: 0 });
    } finally {
      await empty.close();
    }
  });
});
