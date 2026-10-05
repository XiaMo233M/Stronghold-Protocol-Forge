// test/workshopAssets.test.js — 工坊素材 (a pack's OWN art): the licence rule and the read-only route.
//
// Why this exists at all: the repo ships no game assets (they are (c) Hypergryph / Yostar and are gitignored), so a pack
// that needs a custom sprite carries it in its own `assets/` folder. The CLIENT then has to be able to fetch it, or the
// content cannot render — that is the half of "包内容由客户端下载" that /data/ and /workshop-kits/ do not cover.
//
// Two properties matter and both are asserted here:
//   1. the redistributor of the art is the pack's AUTHOR, so a pack with an `assets/` folder must declare a `license`;
//   2. the route is reachable by any client, so it must be narrow — only the registered packs, only their `assets/`
//      subtree, only media extensions, and never a path that escapes the folder.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { startServer, workshopAssetsFor, WORKSHOP_ASSET_PREFIX, WORKSHOP_ASSET_TYPES } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { normalizePackManifest } from '../shared/workshop.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** A 1×1 PNG — real bytes, so the route's content-type claim is about an actual image. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6e0000000049454e44ae426082', 'hex');

let tmp;
let wsRoot;
let srv;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-assets-'));
  wsRoot = join(tmp, 'ws');
  // a licensed pack with art, an UNLICENSED pack with art (must be refused), and a licensed pack with no art.
  // Every pack needs at least one non-empty content file, or the loader refuses it for an unrelated reason.
  const REC = JSON.stringify({ chess_ws_art_a: { name: 'art' } });
  const lic = join(wsRoot, 'art-pack');
  fs.mkdirSync(join(lic, 'assets', 'sprites'), { recursive: true });
  fs.writeFileSync(join(lic, 'pack.json'), JSON.stringify({ id: 'art-pack', name: 'Art', version: '1.0.0', license: 'CC0-1.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(lic, 'assets', 'sprites', 'hound.png'), PNG);
  fs.writeFileSync(join(lic, 'assets', 'LICENSE.txt'), 'CC0-1.0 — the pack author released these files into the public domain.');
  fs.writeFileSync(join(lic, 'chess.json'), REC);
  // something the route must NEVER serve, under the same pack
  fs.writeFileSync(join(lic, 'assets', 'evil.js'), 'export default 1;');
  fs.writeFileSync(join(lic, 'assets', 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(join(lic, 'pack.json.bak'), 'TOP-SECRET-MANIFEST-BACKUP');
  fs.writeFileSync(join(wsRoot, 'secret.txt'), 'TOP-SECRET-WORKSHOP-ROOT');

  const noLic = join(wsRoot, 'nolicence-pack');
  fs.mkdirSync(join(noLic, 'assets'), { recursive: true });
  fs.writeFileSync(join(noLic, 'pack.json'), JSON.stringify({ id: 'nolicence-pack', version: '1.0.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(noLic, 'assets', 'x.png'), PNG);
  fs.writeFileSync(join(noLic, 'chess.json'), REC);

  const plain = join(wsRoot, 'plain-pack');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(join(plain, 'pack.json'), JSON.stringify({ id: 'plain-pack', version: '1.0.0', content: ['chess'], overrides: [] }));
  fs.writeFileSync(join(plain, 'chess.json'), REC);

  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
});
after(async () => {
  await srv?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('工坊素材: the licence rule', () => {
  test('a pack with an assets/ folder MUST declare a license', () => {
    const withAssets = normalizePackManifest({ id: 'p', content: ['chess'] }, 'p', { hasAssets: true });
    assert.equal(withAssets.ok, false);
    assert.equal(withAssets.error, 'ASSETS_NEED_LICENSE');
    assert.match(withAssets.detail, /license/);
    // declaring one fixes it
    const licensed = normalizePackManifest({ id: 'p', content: ['chess'], license: 'CC-BY-4.0' }, 'p', { hasAssets: true });
    assert.equal(licensed.ok, true);
    assert.equal(licensed.pack.license, 'CC-BY-4.0');
    assert.equal(licensed.pack.hasAssets, true);
    // and a pack with NO art still needs none (an operator pack is just JSON, which the project's own licence covers)
    const plain = normalizePackManifest({ id: 'p', content: ['chess'] }, 'p', { hasAssets: false });
    assert.equal(plain.ok, true);
    assert.equal(plain.pack.license, null);
    assert.equal(plain.pack.hasAssets, false);
  });

  test('the loader refuses an unlicensed art pack and keeps the licensed one', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const ids = loaded.packs.map((p) => p.id).sort();
    assert.ok(ids.includes('art-pack'), 'the licensed art pack must load');
    assert.ok(ids.includes('plain-pack'), 'a pack with no art must still load without a licence');
    assert.equal(ids.includes('nolicence-pack'), false, 'an unlicensed art pack must be refused');
    const err = loaded.errors.find((e) => e.pack === 'nolicence-pack');
    assert.ok(err, 'the refusal must be reported, not silent');
    assert.match(err.reason, /ASSETS_NEED_LICENSE/);
    assert.equal(loaded.packs.find((p) => p.id === 'art-pack').hasAssets, true);
  });
});

describe('工坊素材: the read-only route', () => {
  test('a pack\'s own art is served, with a real image content type', async () => {
    const res = await fetch(`${srv.url}${WORKSHOP_ASSET_PREFIX}art-pack/sprites/hound.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /image\/png/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, PNG, 'the bytes must be the file, unmodified');
    // a non-media extension allowlist entry still works (a Spine atlas is text)
    const lic = await fetch(`${srv.url}${WORKSHOP_ASSET_PREFIX}art-pack/LICENSE.txt`);
    assert.equal(lic.status, 404, 'only the allowlisted media types are servable (a .txt is not)');
  });

  test('a pack WITHOUT an assets/ folder serves nothing, and an unknown pack 404s', async () => {
    for (const p of [
      `${WORKSHOP_ASSET_PREFIX}plain-pack/x.png`,
      `${WORKSHOP_ASSET_PREFIX}nolicence-pack/x.png`,   // refused at load: not a registered pack
      `${WORKSHOP_ASSET_PREFIX}no-such-pack/x.png`,
      WORKSHOP_ASSET_PREFIX,
      `${WORKSHOP_ASSET_PREFIX}art-pack`,
    ]) {
      assert.equal((await fetch(srv.url + p)).status, 404, p);
    }
  });

  test('it is not a file server: no traversal, no escaping assets/, no scripts', async () => {
    const attempts = [
      `${WORKSHOP_ASSET_PREFIX}art-pack/../pack.json`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/..%2fpack.json`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/../../secret.txt`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/../plain-pack/chess.json`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/sprites/../../pack.json`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/sprites/../../secret.txt`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/evil.js`,      // code: the kit route exists for code, not this one
      `${WORKSHOP_ASSET_PREFIX}art-pack/page.html`,    // markup the page could be talked into loading
      `${WORKSHOP_ASSET_PREFIX}art-pack/.hidden.png`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/sprites/.hidden.png`,
      `${WORKSHOP_ASSET_PREFIX}art-pack/pack.json.bak`,
    ];
    for (const p of attempts) {
      const res = await fetch(srv.url + p);
      assert.ok(res.status === 404 || res.status === 403, `${p} -> ${res.status}`);
      // the assertion is about the CONTENT that must never come back, not about words a 404 page may legitimately contain
      const body = await res.text();
      assert.doesNotMatch(body, /TOP-SECRET|alert\(1\)|export default 1/, `${p} leaked content: ${body.slice(0, 80)}`);
      assert.equal(body.startsWith('<!doctype html>'), true, `${p} must be an error page, got: ${body.slice(0, 40)}`);
    }
  });

  test('the URL → directory map holds only the packs that actually have art', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const map = workshopAssetsFor(loaded, wsRoot);
    assert.deepEqual([...map.keys()].sort(), ['art-pack']);
    assert.equal(map.get('art-pack'), join(wsRoot, 'art-pack'));
    // and the whole feature switches off with the same switch as the rest of the workshop layer
    assert.equal(workshopAssetsFor(loaded, null).size, 0);
    assert.equal(workshopAssetsFor({ packs: [] }, wsRoot).size, 0);
    // the allowlist is media only: nothing executable, nothing that could be a page
    for (const ext of ['.js', '.mjs', '.html', '.htm', '.cjs']) {
      assert.equal(WORKSHOP_ASSET_TYPES.has(ext), false, `${ext} must not be servable`);
    }
    for (const ext of ['.png', '.jpg', '.webp', '.svg', '.mp3', '.woff2', '.atlas', '.skel']) {
      assert.ok(WORKSHOP_ASSET_TYPES.has(ext), `${ext} must be servable`);
    }
  });
});
