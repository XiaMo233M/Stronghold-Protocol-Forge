// test/modCatalog.test.js — the CLIENT-facing mod catalogue and its routes (server/modCatalog.js, server/http/mods.js).
//
// What is asserted here is the part a browser cannot check for itself: that the catalogue and the server's own identity
// agree BYTE FOR BYTE. The acceptance rules behind it (W-C):
//   1. every file's `sha256` and the pack's `hash` equal what `loadWorkshop` / `identifyPack` computed — compared, not
//      eyeballed;
//   2. a path traversal, an absolute path, or a file the pack does not list is refused;
//   3. the pack hash can be rebuilt from the catalogue's per-file contributions alone (`catalogPackHash`), which is the
//      same call public/js/mods/sync.js localPackHash() makes from local bytes — if that ever stops holding, a client
//      would reject a pack it fully holds;
//   4. a server with no packs serves `{ packs: [] }` and behaves exactly as before.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { WORKSHOP_ASSET_TYPES } from '../server/http/workshop.js';
import { buildModCatalog, catalogPackHash, safeRelPath, modFileAbs, normalizedManifest, MOD_FILE_PREFIX } from '../server/modCatalog.js';
import { createModsRoute, serveMods, MODS_CATALOG_URL } from '../server/http/mods.js';
// the REAL canonicalizer, not a copy: this test claims the rebuilt manifest hashes to the loader's number, so it must
// use the same serialization the loader used
import { canonicalJson } from '../shared/modIdentity.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** A 1×1 PNG — real bytes, so "the client gets what is on disk" is a claim about an actual image. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6e0000000049454e44ae426082', 'hex');
/** The same records with their keys in a different order: `identifyPack` hashes the NORMALIZED form, so the two packs
 *  must hash the same — and the catalogue's per-file contribution must reflect that, not the bytes on disk. */
const CHESS = { chess_ws_alpha: { name: 'alpha', hp: 100 }, chess_ws_beta: { name: 'beta', hp: 200 } };
const REORDERED = { chess_ws_beta: { hp: 200, name: 'beta' }, chess_ws_alpha: { hp: 100, name: 'alpha' } };
const KIT = 'export default function kit() { return {}; }\n';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** `canonicalJson` with object keys sorted (arrays keep their order) — what a normalized record's contribution is. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}
const readBytes = (id, rel) => fs.readFileSync(join(wsRoot, id, ...rel.split('/')));

/** A `node:http` response double: records the status, the headers and the body. A FRESH object per request (never a
 *  spread copy — the methods write through `this`, so a shared field would leak between requests). */
const fakeRes = () => ({
  status: 0, headers: null, body: null, headersSent: false,
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
  end(body) { this.body = body; },
});
const fakeReq = (method = 'GET') => ({ method, headers: {} });
/** Run one request through the mods route and return the recorded response. */
function serve(path, routes) {
  const res = fakeRes();
  const handled = serveMods(fakeReq(), res, path, '', routes);
  return { res, handled };
}
/**
 * Wait for the async half of a handled request (the pack-file read) to have answered. Polls the response instead of
 * sleeping a fixed time: the read is a real filesystem call, so a fixed delay is a flaky test under load.
 * @param {{ headersSent: boolean, status: number }} res
 */
async function settled(res) {
  const deadline = Date.now() + 5000;
  while (!res.headersSent && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
  return res.status;
}

let tmp;
let wsRoot;
let loaded;
let catalog;
let routes;
let emptySrv;
let emptyRoot;
let srv;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modstore-'));
  wsRoot = join(tmp, 'ws');
  // a behaviour-layer pack: a manifest, a data file, a kit (code) and two assets (one of them outside the MIME
  // allowlist of /workshop-assets, so the new route is the ONLY way a client could ever cache it)
  const alpha = join(wsRoot, 'alpha-pack');
  fs.mkdirSync(join(alpha, 'kits'), { recursive: true });
  fs.mkdirSync(join(alpha, 'assets', 'sprites'), { recursive: true });
  fs.writeFileSync(join(alpha, 'pack.json'), JSON.stringify({ id: 'alpha-pack', name: 'Alpha Pack', version: '1.2.0', license: 'CC0-1.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(alpha, 'chess.json'), JSON.stringify(CHESS));
  fs.writeFileSync(join(alpha, 'kits', 'chess_ws_alpha.js'), KIT);
  fs.writeFileSync(join(alpha, 'assets', 'sprites', 'a.png'), PNG);
  fs.writeFileSync(join(alpha, 'assets', 'notes.txt'), 'a note the pack ships but the loader does not hash\n');
  // a pack that DECLARES layer/combat while shipping a kit: the declared values are what identifyPack hashed, and the
  // flattened entry overwrites them with the derived ones — the one shape a catalogue can get wrong
  const gamma = join(wsRoot, 'gamma-pack');
  fs.mkdirSync(join(gamma, 'kits'), { recursive: true });
  fs.writeFileSync(join(gamma, 'pack.json'), JSON.stringify({ id: 'gamma-pack', version: '2.0.0', layer: 'C', combat: false, content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(gamma, 'chess.json'), JSON.stringify({ chess_ws_gamma: { name: 'gamma', hp: 300 } }));
  fs.writeFileSync(join(gamma, 'kits', 'chess_ws_gamma.js'), KIT);
  // a data-only pack whose records are the same object with the keys in another order
  const beta = join(wsRoot, 'beta-pack');
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(join(beta, 'pack.json'), JSON.stringify({ id: 'beta-pack', version: '1.0.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(beta, 'chess.json'), JSON.stringify(REORDERED));
  // something the pack routes must NEVER serve, under the same pack
  fs.writeFileSync(join(alpha, 'assets', 'evil.js'), 'export default 1;');
  fs.writeFileSync(join(alpha, 'pack.json.bak'), 'TOP-SECRET-MANIFEST-BACKUP');
  fs.writeFileSync(join(wsRoot, 'secret.txt'), 'TOP-SECRET-WORKSHOP-ROOT');

  loaded = loadWorkshop(wsRoot, { log: quiet });
  assert.deepEqual(loaded.errors, [], 'the fixture must load without errors');
  catalog = buildModCatalog(loaded);
  routes = createModsRoute(loaded, catalog);

  // a SECOND server whose workshop root holds no packs at all: the plain install this feature must not disturb
  emptyRoot = join(tmp, 'empty-ws');
  fs.mkdirSync(emptyRoot, { recursive: true });
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
  emptySrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: emptyRoot });
});
after(async () => {
  await srv?.close();
  await emptySrv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mod catalogue: the shape, and the hashes it claims', () => {
  test('every pack carries the identity the loader computed, in a catalogue a client can read', () => {
    assert.deepEqual(catalog.packs.map((p) => p.id), ['alpha-pack', 'beta-pack', 'gamma-pack'], 'sorted by pack id');
    for (const entry of catalog.packs) {
      const pack = loaded.packs.find((p) => p.id === entry.id);
      assert.ok(pack, `${entry.id} must be a loaded pack`);
      // identity comes off the loader, it is not recomputed here
      assert.equal(entry.hash, pack.hash, `${entry.id}.hash`);
      assert.equal(entry.layer, pack.layer, `${entry.id}.layer`);
      assert.equal(entry.combat, pack.combat, `${entry.id}.combat`);
      assert.equal(entry.api, pack.api ?? null, `${entry.id}.api`);
      assert.ok(entry.name, `${entry.id}.name`);
      assert.match(entry.hash, /^[0-9a-f]{64}$/);
      for (const f of entry.files) {
        assert.equal(typeof f.path, 'string');
        assert.ok(Number.isInteger(f.bytes) && f.bytes >= 0, `${entry.id}/${f.path}.bytes`);
        assert.match(f.sha256, /^[0-9a-f]{64}$/, `${entry.id}/${f.path}.sha256`);
        assert.match(f.canonical, /^[0-9a-f]{64}$/, `${entry.id}/${f.path}.canonical`);
      }
    }
    // the behaviour-layer pack: its code and its art are in the inventory, not only its data
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    assert.equal(alpha.layer, 'B');
    assert.equal(alpha.combat, true);
    assert.deepEqual(alpha.files.map((f) => f.path), [
      // `assets/evil.js` IS part of the pack: identifyPack walks assets/** with no extension filter, so the loader
      // hashed it and a client must be able to fetch it to rebuild the pack hash. What must NOT happen is that this
      // route hands it over as `text/javascript` — see the Content-Type test below.
      'assets/evil.js', 'assets/notes.txt', 'assets/sprites/a.png', 'chess.json', 'kits/chess_ws_alpha.js', 'pack.json',
    ], 'exactly the loader\'s manifest: the files that went into the pack hash');
    assert.deepEqual(alpha.files.map((f) => f.path), [...alpha.files.map((f) => f.path)].sort(), 'sorted by path');
    // and NOTHING the loader did not hash — a manifest backup and the workshop root's own file are not offered
    for (const stray of ['pack.json.bak', 'secret.txt', '../secret.txt', 'README.md']) {
      assert.equal(alpha.files.some((f) => f.path === stray), false, `${stray} must not be listed`);
    }
  });

  test('each file\'s sha256 equals node:crypto over the bytes really on disk', () => {
    for (const entry of catalog.packs) {
      for (const f of entry.files) {
        assert.equal(f.sha256, sha(readBytes(entry.id, f.path)), `${entry.id}/${f.path}`);
        assert.equal(f.bytes, readBytes(entry.id, f.path).length, `${entry.id}/${f.path} byte count`);
      }
    }
  });

  test('the pack hash is rebuildable from the catalogue alone, and equals the loader\'s', () => {
    for (const entry of catalog.packs) {
      assert.equal(catalogPackHash(entry.files), entry.hash, `${entry.id}: modManifestDigest over the per-file contributions`);
    }
    // and it is NOT simply "hash of the raw bytes of every file" — the declared records are hashed normalized
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    const chess = alpha.files.find((f) => f.path === 'chess.json');
    assert.notEqual(chess.canonical, chess.sha256, 'chess.json contributes its NORMALIZED records, not its on-disk bytes');
    assert.equal(chess.canonical, sha(Buffer.from(JSON.stringify(sortKeys(CHESS)))), 'canonicalJson(records) — sorted keys, no whitespace');
    // pack.json contributes the normalized MANIFEST, so a spelling difference cannot hide behind the hash
    const manifest = alpha.files.find((f) => f.path === 'pack.json');
    assert.notEqual(manifest.canonical, manifest.sha256, 'pack.json contributes the normalized manifest');
  });

  test('every contribution is DERIVED, not copied: the catalogue rebuilds each file\'s hash from its own rules', () => {
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    const pack = loaded.packs.find((p) => p.id === 'alpha-pack');
    // `pack.json` → sha256(canonicalJson(the normalized manifest)). Rebuilding that manifest is what keeps this honest:
    // if normalizePackManifest grows a field and MANIFEST_FIELDS does not, this number stops matching the loader's.
    const manifestFile = alpha.files.find((f) => f.path === 'pack.json');
    assert.equal(manifestFile.canonical, sha(Buffer.from(JSON.stringify(sortKeys(normalizedManifest(pack))))),
      'pack.json contributes the normalized manifest, and we can rebuild it');
    // a declared content file → sha256(canonicalJson(normalized records)); the loader's `files` map is the source
    const chessFile = alpha.files.find((f) => f.path === 'chess.json');
    assert.equal(chessFile.canonical, sha(Buffer.from(JSON.stringify(sortKeys(pack.files.chess)))));
    // a kit and an asset → sha256 of the bytes themselves
    for (const rel of ['kits/chess_ws_alpha.js', 'assets/sprites/a.png']) {
      const f = alpha.files.find((x) => x.path === rel);
      assert.equal(f.canonical, f.sha256, `${rel} contributes its own bytes`);
      assert.equal(f.canonical, sha(readBytes('alpha-pack', rel)));
    }
  });

  test('a pack that DECLARES layer/combat is hashed with the declared values, not the derived ones', () => {
    const gamma = loaded.packs.find((p) => p.id === 'gamma-pack');
    const entry = catalog.packs.find((p) => p.id === 'gamma-pack');
    // `layer` is not overwritten by the derivation (identifyPack lets a declared layer win), so the flattened entry and
    // the hashed manifest agree on it — and the catalogue's `layer` is the author's C, not the kit-implied B
    assert.equal(gamma.layer, 'C', 'a declared layer wins, and the catalogue reports it');
    // `combat` is an explicit boolean, so it is preserved rather than re-derived from the kit — the derivation only
    // fills in an ABSENT value (server/workshop.js:146). So the two fields behave differently, and the rebuild has to
    // re-normalize the file rather than trust either shape on the entry.
    assert.equal(gamma.combat, false, 'an explicit false survives; the derivation only fills an absent value');
    const manifest = normalizedManifest(gamma);
    assert.equal(manifest.layer, 'C', 'the declared layer');
    assert.equal(manifest.combat, false, 'the declared combat flag');
    assert.equal(manifest.id, 'gamma-pack');
    assert.equal(sha(Buffer.from(canonicalJson(manifest))),
      gamma.manifest.find((m) => m.path === 'pack.json').hash, 'the rebuild IS the hashed manifest');
    assert.equal(catalogPackHash(entry.files), entry.hash, 'so the whole pack hash rebuilds');
    // the catalogue reports the loader's identity — the same values welcome.mods carries
    assert.equal(entry.layer, 'C');
    assert.equal(entry.combat, false);
    // and an ABSENT layer really is the derived one on the entry (that is the case the rebuild must not copy)
    const alpha = loaded.packs.find((p) => p.id === 'alpha-pack');
    assert.equal(alpha.layer, 'B', 'derived from the kit');
    assert.equal(normalizedManifest(alpha).layer, null, 'but the hashed manifest had no declaration');
  });

  test('two packs whose records differ only in key order still hash the same, and so does the rebuild', () => {
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    const beta = catalog.packs.find((p) => p.id === 'beta-pack');
    // alpha's chess.json is the same RECORD SET as beta's, written in another key order: the normalized contribution
    // is identical, so the difference in pack hash can only come from the other files (pack.json, the kit, the assets)
    const a = alpha.files.find((f) => f.path === 'chess.json').canonical;
    const b = beta.files.find((f) => f.path === 'chess.json').canonical;
    assert.equal(a, b, 'normalized records do not depend on key order');
    assert.equal(catalogPackHash(beta.files), beta.hash, 'a data-only pack rebuilds to its own hash');
  });
});

describe('mod routes: what may be fetched, and what may not', () => {
  test('the catalogue route answers the exact URL and reports itself as handled', () => {
    const { res, handled } = serve(MODS_CATALOG_URL, routes);
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(String(res.body)).packs.map((p) => p.id), ['alpha-pack', 'beta-pack', 'gamma-pack']);
  });

  test('a path this route does not own is NOT handled (the static mounts keep it)', () => {
    for (const path of ['/index.html', '/data/chess.json', '/mods', '/mods/catalog.json.bak']) {
      const { handled } = serve(path, routes);
      assert.equal(handled, false, `${path} must fall through to the static mounts`);
    }
  });

  test('a listed pack file is served with its real bytes', async () => {
    const { res, handled } = serve(`${MOD_FILE_PREFIX}alpha-pack/pack.json`, routes);
    assert.equal(handled, true);
    await settled(res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(Buffer.compare(res.body, readBytes('alpha-pack', 'pack.json')), 0, 'byte for byte');
    assert.equal(res.headers['Content-Length'], readBytes('alpha-pack', 'pack.json').length);
  });

  test('a pack\'s .js asset is downloadable but is never served as executable code', async () => {
    // it has to be downloadable: the loader hashed it, so a client needs the bytes to rebuild the pack hash
    const { res, handled } = serve(`${MOD_FILE_PREFIX}alpha-pack/assets/evil.js`, routes);
    assert.equal(handled, true);
    await settled(res);
    assert.equal(res.status, 200);
    assert.equal(Buffer.compare(res.body, readBytes('alpha-pack', 'assets/evil.js')), 0);
    // …and it must not come back as a script a page could be talked into importing
    assert.equal(res.headers['Content-Type'], 'application/octet-stream', 'no script content type for a pack asset');
    assert.notEqual(res.headers['Content-Type'], 'text/javascript; charset=utf-8');
    // the kit route is the ONE place pack code is served as a module, and it only serves modules the loader registered
    assert.equal(WORKSHOP_ASSET_TYPES.has('.js'), false, 'the asset allowlist excludes .js, and this route reuses it');
  });

  test('traversal, absolute paths and unlisted files are refused — and so is a pack this server lacks', async () => {
    const refused = [
      `${MOD_FILE_PREFIX}alpha-pack/../pack.json`,
      `${MOD_FILE_PREFIX}alpha-pack/kits/../../pack.json`,
      `${MOD_FILE_PREFIX}alpha-pack//etc/passwd`,
      `${MOD_FILE_PREFIX}alpha-pack/pack.json.bak`,
      `${MOD_FILE_PREFIX}alpha-pack/secret.txt`,
      `${MOD_FILE_PREFIX}alpha-pack`,
      `${MOD_FILE_PREFIX}alpha-pack/`,
      `${MOD_FILE_PREFIX}nope-pack/pack.json`,
      `${MOD_FILE_PREFIX}/pack.json`,
    ];
    for (const path of refused) {
      const { res, handled } = serve(path, routes);
      assert.equal(handled, true, `${path} is this route's URL space`);
      assert.equal(res.status, 404, `${path} must be refused`);
      // the 404 page must not be the file: assert on the CONTENT, not on "a body is absent" (an error page has one)
      const body = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '');
      assert.equal(body.includes('TOP-SECRET'), false, `${path} must not leak the file's bytes`);
      assert.equal(body.includes('export default 1;'), false, `${path} must not leak a pack script`);
    }
    // an `assets/evil.js` IS part of the pack (the loader hashed it) and IS served — but never as a script
    const script = serve(`${MOD_FILE_PREFIX}alpha-pack/assets/evil.js`, routes);
    await settled(script.res);
    assert.equal(script.res.status, 200);
    assert.notEqual(script.res.headers['Content-Type'], 'text/javascript; charset=utf-8');
    // the files refused above really exist, so a refusal is not "the file was missing anyway"
    assert.ok(fs.existsSync(join(wsRoot, 'secret.txt')));
    assert.ok(fs.existsSync(join(wsRoot, 'alpha-pack', 'assets', 'evil.js')));
    assert.ok(fs.existsSync(join(wsRoot, 'alpha-pack', 'pack.json.bak')));
    // …and the folder's leftovers are not in the catalogue either: the route serves the loader's inventory, not the dir
    const alpha = catalog.packs.find((p) => p.id === 'alpha-pack');
    for (const stray of ['pack.json.bak', 'secret.txt']) {
      assert.equal(alpha.files.some((f) => f.path === stray), false, `${stray} is not part of the pack`);
    }
  });

  test('the loader\'s path rule is the one this route applies', () => {
    for (const good of ['chess.json', 'kits/chess_ws_alpha.js', 'assets/sprites/a.png', 'assets/notes.txt', '.hidden']) {
      assert.equal(safeRelPath(good), true, `${good} is a legal pack-relative path`);
    }
    for (const bad of ['', '/etc/passwd', '../pack.json', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:/windows', 'a\0b', null, 42]) {
      assert.equal(safeRelPath(bad), false, `${JSON.stringify(bad)} must be refused`);
    }
    const alpha = loaded.packs.find((p) => p.id === 'alpha-pack');
    assert.equal(modFileAbs(alpha, '../pack.json'), null, 'the filesystem path builder refuses the same shape');
    assert.ok(modFileAbs(alpha, 'pack.json').startsWith(alpha.dir), 'and resolves a legal one inside the pack');
  });
});

describe('mod catalogue: a server with no packs', () => {
  test('the catalogue is empty and the pack route serves nothing', async () => {
    const res = await fetch(`${emptySrv.url}${MODS_CATALOG_URL}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { packs: [] }, 'the documented "no mods" body');
    const missingPack = await fetch(`${emptySrv.url}${MOD_FILE_PREFIX}nope/pack.json`);
    assert.equal(missingPack.status, 404);
  });

  test('the rest of the server answers byte for byte the same as the modded one', async () => {
    for (const path of ['/', '/index.html']) {
      const a = Buffer.from(await (await fetch(`${emptySrv.url}${path}`)).arrayBuffer());
      const b = Buffer.from(await (await fetch(`${srv.url}${path}`)).arrayBuffer());
      assert.ok(a.length > 0, `${path} must have a body`);
      assert.equal(Buffer.compare(a, b), 0, `${path} is unchanged by this feature`);
    }
  });
});
