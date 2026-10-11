// The transport capabilities of tools/fetch-assets.mjs: resumable single-file downloads, index cache freshness and an
// alternative download base (a CDN). Everything here is proven against a local `http.createServer` source, so the suite
// needs no network; `http://127.0.0.1/` is the one host a base URL may name over plain HTTP (tools/assets/sources.mjs
// normalizeAssetBase). docs/ASSETS.md documents the flags.
//
// The first test is the guard the whole change hangs on: a run that passes none of the new flags must behave byte for
// byte as it did before, including the ledger entry shape of an existing library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Downloader, MIN_RESUMABLE_BYTES, PART_SUFFIX, isSafeRel, jobPath } from '../tools/assets/downloader.mjs';
import { cachedJson, indexUrls, loadIndexes } from '../tools/assets/cache.mjs';
import { baseIsUntrusted, baseWarnings, downloadUrls, normalizeAssetBase, withAssetBase } from '../tools/assets/sources.mjs';
import { resolveTemplate } from '../tools/assets/manifest.mjs';
import { parseArgs, parseTtl, resolveCacheDir, orphanFiles } from '../tools/fetch-assets.mjs';

const quiet = () => {};
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sp-transfer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A local source. `bytes` is the payload; `range: false` makes it ignore `Range` (it answers the whole file, status 200).
 * `cutAfter` sends that many bytes, waits for the socket to flush them, then destroys the connection — so the client
 * receives them and the response ends early. `truncate` promises the whole payload in `content-length` but sends less,
 * which is what a resumed-but-short answer looks like.
 * @returns {Promise<{base:string, requests:{range:string|null,method:string}[], url:(rel:string)=>string}>}
 */
async function sourceServer(t, bytes, { range = true, truncate = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ range: req.headers.range ?? null, method: req.method });
    const from = (() => {
      const raw = req.headers.range ?? '';
      if (!range || !raw) return 0;
      // `bytes=-1` (the suffix probe) is the last byte; `bytes=N-` starts at N.
      const suffix = /^bytes=-(\d+)$/.exec(raw);
      if (suffix) return Math.max(0, bytes.length - Number(suffix[1]));
      const m = /^bytes=(\d+)-(\d*)$/.exec(raw);
      return m ? Math.min(Number(m[1]), bytes.length) : 0;
    })();
    const rest = bytes.subarray(from);
    // `truncate`: a 206 whose content-range promises the whole tail while the body (and its content-length) is 5 000
    // bytes short — a resumed-but-short answer.
    const chunk = truncate && from > 0 ? rest.subarray(0, Math.max(0, rest.length - 5000)) : rest;
    const head = { 'content-type': 'application/octet-stream', 'accept-ranges': range ? 'bytes' : 'none', 'content-length': String(chunk.length) };
    if (from > 0) res.writeHead(206, { ...head, 'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}` });
    else res.writeHead(200, head);
    res.end(chunk);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { base: origin + '/', origin, requests, url: (rel = 'a.bin') => `${origin}/${rel}` };
}

/** A deterministic pseudo-random payload (incompressible enough, no real randomness). */
function payload(n) {
  const b = Buffer.alloc(n);
  let x = 123456789;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = (x >>> 16) & 0xff; }
  return b;
}

/**
 * The real fetch, with the body of a whole-file answer stopping after `after` bytes (the interrupted download). Exact
 * and deterministic, unlike cutting a socket: the headers, the content-length the source declared and the `.part` the
 * downloader keeps are all the real ones. The one-byte Range probe passes through untouched.
 * @param {string} origin the source's `http://127.0.0.1:PORT`
 * @param {number} after bytes of the body to deliver
 */
function cutBodyFetch(origin, after) {
  return async (url, opts) => {
    const res = await fetch(url, opts);
    const range = opts?.headers?.range ?? null;
    if (String(url).startsWith(origin) && range === null) {
      const reader = res.body.getReader();
      let sent = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (sent >= after) { controller.error(new Error('other side closed')); return; }
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          sent += value.length;
          controller.enqueue(value);
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    }
    return res;
  };
}

// docs/ASSETS.md "Nothing changes without the new flags" — the guard the whole change hangs on.
test('a run with none of the new flags is unchanged: ledger entry, skip decision and plan paths are byte for byte those of today', async (t) => {
  const dir = await fixture(t);
  const body = JSON.stringify({ ok: true });
  const ledgerPath = join(dir, 'assets-ledger.json');
  // The ledger shape of every version up to now: { url, bytes }, no hash.
  const legacy = { files: { 'a.json': { url: 'https://raw.githubusercontent.com/o/r/main/a.json', bytes: Buffer.byteLength(body) } } };
  await writeFile(ledgerPath, JSON.stringify(legacy));
  await writeFile(join(dir, 'a.json'), body);
  const before = await readFile(ledgerPath, 'utf8');
  const dl = new Downloader({ root: dir, ledgerPath, log: quiet, fetchImpl: async () => { throw new Error('no request may be made'); } });
  await dl.loadLedger();
  const job = { rel: 'a.json', urls: ['https://raw.githubusercontent.com/o/r/main/a.json'], kind: 'json' };
  const r = (await dl.run([job])).get(job.rel);
  assert.equal(r.status, 'skip', 'the existing file is still kept by size alone');
  assert.equal(r.bytes, Buffer.byteLength(body));
  // The healing write is a sha256 added to the entry: url and bytes are untouched, so a diff of the ledger shows only
  // the added key (nothing re-downloaded, no path or decision changed).
  const after = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.deepEqual(Object.keys(after.files['a.json']).sort(), ['bytes', 'sha256', 'url']);
  assert.equal(after.files['a.json'].url, legacy.files['a.json'].url);
  assert.equal(after.files['a.json'].bytes, legacy.files['a.json'].bytes);
  assert.equal(after.files['a.json'].sha256, sha(Buffer.from(body)));
  assert.equal(before, JSON.stringify(legacy), 'the fixture is the old shape');
  // day two: with the hash recorded, the same file is still skipped (not re-downloaded) and the ledger stops changing
  const dl2 = new Downloader({ root: dir, ledgerPath, log: quiet, fetchImpl: async () => { throw new Error('no request may be made'); } });
  await dl2.loadLedger();
  assert.equal((await dl2.run([job])).get(job.rel).status, 'skip');
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, 'utf8')), after, 'a verified keep writes nothing');
  // and the plan paths of a run without the new flags are the defaults
  const o = parseArgs([]);
  assert.equal(o.assetBase, '');
  assert.equal(o.indexBase, '');
  assert.equal(o.indexTtl, 0);
  assert.equal(o.cacheDir, '.cache');
  assert.equal(resolveCacheDir(o.cacheDir), join(resolveCacheDir('.'), '.cache'));
});

test('hash hardening: verified only when the ledger records one, so an existing library is never re-downloaded', async (t) => {
  const dir = await fixture(t);
  const good = Buffer.from('the real payload');
  const corrupt = Buffer.from('the rEal payload'); // same length as `good`, different content
  await writeFile(join(dir, 'good.json'), good);
  await writeFile(join(dir, 'corrupt.json'), corrupt);
  await writeFile(join(dir, 'ledger.json'), JSON.stringify({ files: {
    'good.json': { url: 'u', bytes: good.length },
    'corrupt.json': { url: 'u', bytes: corrupt.length },
  } }));
  const url = 'https://raw.githubusercontent.com/o/r/main/x.json';
  const job = (rel) => ({ rel, urls: [url], kind: 'json' });
  // day one: an entry written before the hash existed — kept by size alone, whatever the content (the pre-existing
  // behaviour, which must not turn into 8268 re-downloads on upgrade)
  const dl = new Downloader({ root: dir, ledgerPath: join(dir, 'ledger.json'), log: quiet, fetchImpl: async () => Response.json({ ok: true }) });
  await dl.loadLedger();
  const ledger = await readFile(join(dir, 'ledger.json'), 'utf8');
  const r = (await dl.run([job('good.json'), job('corrupt.json')])).get('good.json');
  assert.equal(r.status, 'skip', 'no hash recorded: kept by size, not re-downloaded');
  assert.equal((await dl.run([job('good.json'), job('corrupt.json')])).get('corrupt.json').status, 'skip');
  // day two: the same entries now carry the hash of what is on disk (one healing write, no download)
  const healed = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'));
  assert.equal(healed.files['good.json'].sha256, sha(good));
  assert.equal(healed.files['corrupt.json'].sha256, sha(corrupt), 'the hash is of the file that was kept');
  assert.equal(healed.files['good.json'].bytes, good.length);
  assert.equal(JSON.parse(ledger).files['good.json'].sha256, undefined, 'the fixture started without a hash');
  // day three: with the hash recorded, a same-size file whose content changed is re-downloaded, a matching one is kept
  await writeFile(join(dir, 'corrupt.json'), good); // same length, still not what the ledger hashed
  const dl3 = new Downloader({ root: dir, ledgerPath: join(dir, 'ledger.json'), log: quiet, fetchImpl: async () => Response.json({ ok: true }) });
  await dl3.loadLedger();
  assert.equal((await dl3.run([job('good.json')])).get('good.json').status, 'skip', 'the recorded hash matches');
  assert.equal((await dl3.run([job('corrupt.json')])).get('corrupt.json').status, 'ok', 'the hash mismatch is re-downloaded');
  assert.equal(dl3.ledger.files['corrupt.json'].sha256, sha(Buffer.from(JSON.stringify({ ok: true }))));
  // --force keeps its meaning: bypass the decision and download again even with a matching hash
  const dlForce = new Downloader({ root: dir, ledgerPath: join(dir, 'ledger.json'), force: true, log: quiet, fetchImpl: async () => Response.json({ ok: true }) });
  await dlForce.loadLedger();
  assert.equal((await dlForce.run([job('good.json')])).get('good.json').status, 'ok');
});

// --asset-base / --index-base: the alternative download base (docs/ASSETS.md "Download from another host (a CDN)").
test('base URL validation: http and https, refused by name, and an untrusted base never shrinks the manifest', () => {
  assert.equal(normalizeAssetBase(undefined), '');
  assert.equal(normalizeAssetBase(''), '');
  assert.equal(normalizeAssetBase('   '), '');
  assert.equal(normalizeAssetBase('https://cdn.example.com'), 'https://cdn.example.com/');
  assert.equal(normalizeAssetBase('https://cdn.example.com/mirror/'), 'https://cdn.example.com/mirror/');
  // a LAN / loopback mirror is often plain HTTP: allowed, normalized, and only the non-loopback one warns
  assert.equal(normalizeAssetBase('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/');
  assert.equal(normalizeAssetBase('http://localhost:1234'), 'http://localhost:1234/');
  assert.equal(normalizeAssetBase('http://[::1]:9/'), 'http://[::1]:9/');
  assert.equal(normalizeAssetBase('http://192.168.1.10:8080/mirror'), 'http://192.168.1.10:8080/mirror/');
  assert.equal(normalizeAssetBase('http://cdn.example.com/'), 'http://cdn.example.com/');
  assert.deepEqual(baseWarnings('http://127.0.0.1:8080/', '--asset-base'), [], 'loopback is a local source: no warning');
  assert.deepEqual(baseWarnings('https://cdn.example.com/', '--asset-base'), [], 'HTTPS warns about nothing');
  assert.deepEqual(baseWarnings('', '--asset-base'), []);
  const warn = baseWarnings('http://192.168.1.10:8080/', '--asset-base');
  assert.equal(warn.length, 1);
  assert.match(warn[0], /明文 HTTP/);
  assert.match(warn[0], /中间人替换/);
  assert.match(warn[0], /public\/assets\//);
  assert.equal(baseIsUntrusted('http://192.168.1.10:8080/'), true);
  assert.equal(baseIsUntrusted('http://cdn.example.com/'), true);
  assert.equal(baseIsUntrusted('https://cdn.example.com/'), false);
  assert.equal(baseIsUntrusted('http://127.0.0.1:9/'), false, 'loopback is trusted');
  assert.equal(baseIsUntrusted(''), false, 'no base, nothing to distrust');
  for (const bad of ['ftp://x/', 'cdn.example.com/', 'https://', '://x', 'https://user:secret@cdn.example.com/', 'https://cdn.example.com/?q=1', 'https://cdn.example.com/#f']) {
    assert.throws(() => normalizeAssetBase(bad), /invalid --asset-base URL|invalid --index-base URL/, bad);
  }
  assert.throws(() => normalizeAssetBase('ftp://x/', '--index-base'), /invalid --index-base URL/);
  assert.throws(() => parseArgs(['--index-base=not a url']), /invalid --index-base URL/);
  assert.throws(() => parseArgs(['--index-ttl=-1']), /non-negative number of hours/);
  assert.throws(() => parseArgs(['--index-ttl=soon']), /non-negative number of hours/);
  assert.throws(() => parseArgs(['--cache-dir=']), /--cache-dir needs a directory/);
  // an untrusted base may not be combined with a flag that shrinks the committed manifest
  assert.equal(parseArgs(['--asset-base=http://192.168.1.10:8080/']).assetBase, 'http://192.168.1.10:8080/');
  assert.throws(() => parseArgs(['--asset-base=http://192.168.1.10:8080/', '--prune']), /untrusted --asset-base .* never prunes/);
  assert.throws(() => parseArgs(['--asset-base=http://192.168.1.10:8080/', '--allow-shrink']), /never shrinks the manifest/);
  assert.throws(() => parseArgs(['--index-base=http://cdn.example.com/', '--prune']), /untrusted --index-base .* never prunes/);
  assert.throws(() => parseArgs(['--index-base=http://cdn.example.com/', '--allow-shrink']), /never shrinks the manifest/);
  // a trusted base (HTTPS or loopback) keeps both flags, and neither flag complains without a base
  assert.equal(parseArgs(['--asset-base=https://cdn.example.com/', '--prune']).prune, true);
  assert.equal(parseArgs(['--asset-base=http://127.0.0.1:9/', '--allow-shrink']).allowShrink, true);
  assert.equal(parseArgs(['--prune']).prune, true);
  // the two bases are independent, and each is normalized
  const o = parseArgs(['--asset-base=https://cdn.example.com', '--index-base=http://127.0.0.1:9']);
  assert.equal(o.assetBase, 'https://cdn.example.com/');
  assert.equal(o.indexBase, 'http://127.0.0.1:9/');
  assert.equal(parseArgs(['--asset-base=https://cdn.example.com/']).indexBase, '');
  // and the same for the environment variables (an invalid one fails the parse, never a silent fallback)
  const saved = { a: process.env.SP_ASSET_BASE, i: process.env.SP_INDEX_BASE, t: process.env.SP_INDEX_TTL, c: process.env.SP_CACHE_DIR };
  try {
    process.env.SP_ASSET_BASE = 'https://env.example.com';
    process.env.SP_INDEX_BASE = 'http://127.0.0.1:7/base';
    process.env.SP_INDEX_TTL = '12';
    process.env.SP_CACHE_DIR = 'tmp/envcache';
    const e = parseArgs([]);
    assert.equal(e.assetBase, 'https://env.example.com/');
    assert.equal(e.indexBase, 'http://127.0.0.1:7/base/');
    assert.equal(e.indexTtl, 12);
    assert.equal(e.cacheDir, 'tmp/envcache');
    process.env.SP_ASSET_BASE = 'not a url';
    assert.throws(() => parseArgs([]), /invalid SP_ASSET_BASE URL/);
    delete process.env.SP_ASSET_BASE;
    process.env.SP_INDEX_TTL = '-3';
    assert.throws(() => parseArgs([]), /non-negative number of hours/);
    assert.equal(parseTtl(undefined), 0);
    assert.equal(parseTtl('0'), 0);
  } finally {
    for (const [k, v] of [['SP_ASSET_BASE', saved.a], ['SP_INDEX_BASE', saved.i], ['SP_INDEX_TTL', saved.t], ['SP_CACHE_DIR', saved.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a job path may not leave the download root (an index-supplied .. or absolute rel is refused)', async (t) => {
  assert.equal(isSafeRel('char/avatar/a.png'), true);
  assert.equal(isSafeRel('a.bin'), true);
  assert.equal(isSafeRel('a/./b.png'), true);
  assert.equal(isSafeRel('../outside.png'), false);
  assert.equal(isSafeRel('a/../../outside.png'), false);
  assert.equal(isSafeRel('a\\..\\..\\outside.png'), false, 'Windows separators too');
  assert.equal(isSafeRel('/etc/passwd'), false);
  assert.equal(isSafeRel('C:/Windows/x'), false);
  assert.equal(isSafeRel('C:\\Windows\\x'), false);
  assert.equal(isSafeRel(''), false);
  assert.equal(jobPath('E:/root', 'a/../../x.png'), null);
  assert.equal(jobPath('E:/root', '../x.png'), null);
  assert.notEqual(jobPath('E:/root', 'ok/a.png'), null);
  // and the downloader refuses such a job instead of writing the file
  const dir = await fixture(t);
  const dl = new Downloader({ root: join(dir, 'assets'), ledgerPath: join(dir, 'ledger.json'), log: quiet, fetchImpl: async () => { throw new Error('no request may be made'); } });
  await dl.loadLedger();
  const r = (await dl.run([{ rel: '../outside.png', urls: ['https://raw.githubusercontent.com/o/r/main/a.png'], kind: 'png' }])).get('../outside.png');
  assert.equal(r.status, 'error');
  assert.match(r.error, /unsafe asset path outside/);
  await assert.rejects(stat(join(dir, 'outside.png')), 'nothing was written outside the root');
});

test('the base rewrites the raw.githubusercontent.com candidates and keeps every other URL as it is', () => {
  const raw = 'https://raw.githubusercontent.com/o/r/main/a.png';
  assert.deepEqual(downloadUrls(raw), [raw, 'https://cdn.jsdelivr.net/gh/o/r@main/a.png'], 'no base: today');
  assert.deepEqual(downloadUrls(raw, { assetBase: 'https://cdn.example.com/' }), [
    'https://cdn.example.com/o/r/main/a.png',
    'https://cdn.jsdelivr.net/gh/o/r@main/a.png',
  ], 'the repository path is kept, the jsDelivr fallback is not a raw URL and stays');
  assert.equal(withAssetBase('https://cdn.example.com/o/r/main/a.png', 'https://cdn.example.com/'), 'https://cdn.example.com/o/r/main/a.png', 'never prefixed twice');
  assert.equal(withAssetBase('file:///x', 'https://cdn.example.com/'), 'file:///x', 'only raw GitHub URLs are rewritten');
  // the three index URLs, and the default literals unchanged
  assert.deepEqual(indexUrls(), {
    audioData: 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/audio_data.json',
    charword: 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/charword_table.json',
    modelsData: 'https://raw.githubusercontent.com/isHarryh/Ark-Models/main/models_data.json',
  });
  assert.match(indexUrls('https://cdn.example.com/').audioData, /^https:\/\/cdn\.example\.com\/Kengxxiao\/ArknightsGameData\/master\/zh_CN\/gamedata\/excel\/audio_data\.json$/);
  assert.match(indexUrls('https://cdn.example.com/').modelsData, /^https:\/\/cdn\.example\.com\/isHarryh\/Ark-Models\/main\/models_data\.json$/);
});

// The bug the CDN base introduced: the ledger holds the URL that succeeded, so the rewritten primary must be the
// comparison, or every file fetched through the base is misreported as a fallback.
test('--asset-base: a file fetched through the base is not a fallback in the report, another file still is', async (t) => {
  const dir = await fixture(t);
  const server = await sourceServer(t, Buffer.from('{ "ok": true }'));
  const primary = 'https://raw.githubusercontent.com/o/r/main/a.json';
  const other = 'https://raw.githubusercontent.com/o/r/main/other.json';
  const dl = new Downloader({ root: dir, ledgerPath: join(dir, 'ledger.json'), assetBase: server.base, log: quiet });
  const job = { rel: 'a.json', urls: [primary], kind: 'json' };
  assert.equal((await dl.run([job])).get(job.rel).status, 'ok');
  assert.equal(dl.ledger.files['a.json'].url, server.url('o/r/main/a.json'), 'the successful URL is the rewritten one');
  const template = { icon: { alts: [{ rel: 'a.json', urls: [primary], kind: 'json' }] } };
  const sourceOf = (rel) => dl.ledger.files[rel]?.url;
  const withBase = resolveTemplate(template, { root: dir, spine: new Map(), sourceOf, assetBase: server.base });
  assert.deepEqual(withBase.fallbacks, [], 'the base is the primary, not a fallback');
  assert.deepEqual(withBase.misses, []);
  // a real fallback (the second alternative is the one on disk) is still reported
  await rm(join(dir, 'a.json'));
  await writeFile(join(dir, 'b.json'), '{ "ok": true }');
  dl.ledger.files['b.json'] = { url: server.url('o/r/main/other.json'), bytes: 13 };
  const viaFallback = { icon: { alts: [{ rel: 'a.json', urls: [primary], kind: 'json' }, { rel: 'b.json', urls: [other], kind: 'json' }] } };
  const r = resolveTemplate(viaFallback, { root: dir, spine: new Map(), sourceOf, assetBase: server.base });
  assert.equal(r.fallbacks.length, 1);
  assert.match(r.fallbacks[0], /^icon ← /);
});

// Resumable single-file downloads: a stable `.part` the next run continues from (docs/ASSETS.md "Resuming a download").
test('resume: a source that honours Range continues from a half-downloaded .part and the file ends up correct', async (t) => {
  const dir = await fixture(t);
  const big = payload(MIN_RESUMABLE_BYTES + 4000000);
  const server = await sourceServer(t, big);
  const ledgerPath = join(dir, 'ledger.json');
  const job = { rel: 'big.bin', urls: [server.url('big.bin')], kind: 'bin' };
  // first run: the body stops after 400 000 bytes, so nothing reaches the final path
  const dl1 = new Downloader({ root: dir, ledgerPath, log: quiet, retries: 1, backoffMs: 0, fetchImpl: cutBodyFetch(server.base, 400000) });
  await dl1.loadLedger();
  const r1 = (await dl1.run([job])).get(job.rel);
  assert.equal(r1.status, 'error', r1.error);
  await assert.rejects(stat(join(dir, 'big.bin')), 'no partial file at the final path');
  const cut = (await stat(join(dir, 'big.bin') + PART_SUFFIX)).size;
  assert.ok(cut > 0 && cut < big.length, `the .part holds some of what arrived (${cut}/${big.length})`);
  // second run: the same stable .part is the resume point
  server.requests.length = 0;
  const dl2 = new Downloader({ root: dir, ledgerPath, log: quiet, backoffMs: 0 });
  await dl2.loadLedger();
  const r2 = (await dl2.run([job])).get(job.rel);
  assert.equal(r2.status, 'ok', r2.error);
  assert.equal(r2.bytes, big.length);
  assert.deepEqual(await readFile(join(dir, 'big.bin')), big, 'the assembled file is byte for byte the payload');
  assert.ok(server.requests.some((q) => q.range === `bytes=${cut}-`), `asked for the missing tail (${JSON.stringify(server.requests)})`);
  await assert.rejects(stat(join(dir, 'big.bin') + PART_SUFFIX), 'the .part is gone after the rename');
  assert.equal(dl2.ledger.files['big.bin'].bytes, big.length);
  assert.equal(dl2.ledger.files['big.bin'].sha256, sha(big), 'and its hash is recorded');
});

test('resume: a source that does not honour Range is safely re-downloaded whole', async (t) => {
  const dir = await fixture(t);
  const big = payload(MIN_RESUMABLE_BYTES + 300000);
  const server = await sourceServer(t, big, { range: false });
  const ledgerPath = join(dir, 'ledger.json');
  // a `.part` left by an interrupted run against a source that ignores Range
  const stale = big.length - 100000;
  await writeFile(join(dir, 'big.bin') + PART_SUFFIX, big.subarray(0, stale));
  const dl = new Downloader({ root: dir, ledgerPath, log: quiet, backoffMs: 0 });
  await dl.loadLedger();
  const job = { rel: 'big.bin', urls: [server.url('big.bin')], kind: 'bin' };
  const r = (await dl.run([job])).get(job.rel);
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.bytes, big.length, 'the whole file, not part + tail');
  assert.deepEqual(await readFile(join(dir, 'big.bin')), big);
  assert.ok(server.requests.every((q) => q.range === null || q.range === 'bytes=-1'), `a plain request or the suffix probe only (${JSON.stringify(server.requests)})`);
});

test('resume: a truncated or half-sent body is never accepted as a finished file, and the next run still resumes', async (t) => {
  const dir = await fixture(t);
  const big = payload(MIN_RESUMABLE_BYTES + 4000000);
  const server = await sourceServer(t, big);
  const ledgerPath = join(dir, 'ledger.json');
  const job = { rel: 'big.bin', urls: [server.url('big.bin')], kind: 'bin' };
  const dl1 = new Downloader({ root: dir, ledgerPath, log: quiet, retries: 1, backoffMs: 0, fetchImpl: cutBodyFetch(server.base, 400000) });
  await dl1.loadLedger();
  assert.equal((await dl1.run([job])).get(job.rel).status, 'error');
  const cut = (await stat(join(dir, 'big.bin') + PART_SUFFIX)).size;
  assert.ok(cut > 0 && cut < big.length, `there is something to resume from (${cut})`);
  // a source that answers the Range request with 206 and then sends less than its own content-range promised
  const cutServer = await sourceServer(t, big, { truncate: true });
  const dl2 = new Downloader({ root: dir, ledgerPath, log: quiet, retries: 1, backoffMs: 0 });
  await dl2.loadLedger();
  const r2 = (await dl2.run([{ rel: 'big.bin', urls: [cutServer.url('big.bin')], kind: 'bin' }])).get('big.bin');
  assert.equal(r2.status, 'error', `a short resumed body fails (${r2.error})`);
  await assert.rejects(stat(join(dir, 'big.bin')), 'a truncated resume never reaches the final path');
  assert.ok((await stat(join(dir, 'big.bin') + PART_SUFFIX)).size >= cut, 'the .part is still the resume point');
  // a healthy source then finishes, and the payload is right
  const dl3 = new Downloader({ root: dir, ledgerPath, log: quiet, backoffMs: 0 });
  await dl3.loadLedger();
  const r3 = (await dl3.run([job])).get(job.rel);
  assert.equal(r3.status, 'ok', r3.error);
  assert.deepEqual(await readFile(join(dir, 'big.bin')), big);
});

test('resume: a small file is always fetched whole, and a .part is never an orphan (never pruned)', async (t) => {
  const dir = await fixture(t);
  const small = payload(MIN_RESUMABLE_BYTES + 2048); // above the threshold, but the job declares a smaller size below
  const server = await sourceServer(t, small);
  const ledgerPath = join(dir, 'ledger.json');
  await writeFile(join(dir, 'small.bin') + PART_SUFFIX, small.subarray(0, 1000));
  const dl = new Downloader({ root: dir, ledgerPath, log: quiet, backoffMs: 0 });
  await dl.loadLedger();
  // a job whose expected size is below the threshold is never streamed, whatever `.part` is lying around
  const job = { rel: 'small.bin', urls: [server.url('small.bin')], kind: 'bin', bytes: 10 };
  const r = (await dl.run([job])).get(job.rel);
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.bytes, small.length);
  assert.deepEqual(await readFile(join(dir, 'small.bin')), small);
  assert.equal(server.requests.length, 1, 'one whole-file request: no probe, no Range');
  assert.equal(server.requests[0].range, null);
  await assert.rejects(stat(join(dir, 'small.bin') + PART_SUFFIX), 'the leftover .part did not survive a whole download');
  // --prune must not delete the bytes the next run resumes from
  const keep = orphanFiles(['big.bin.part', 'orphan.png', 'local/spine/enemy/x/x.skel', 'a.png'], ['a.png']);
  assert.deepEqual(keep, ['orphan.png']);
});

// Index cache freshness: --index-ttl / SP_INDEX_TTL (docs/ASSETS.md "Index cache freshness").
test('index TTL: a cached index is used forever without --index-ttl, and re-downloaded only when it is older', async (t) => {
  const dir = await fixture(t);
  let body = { v: 1 };
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/index.json`;
  const cacheFile = join(dir, 'index.json');
  const fetchImpl = globalThis.fetch;
  assert.deepEqual(await cachedJson({ cacheFile, url, log: quiet, fetchImpl }), { v: 1 });
  assert.equal(requests, 1);
  body = { v: 2 };
  // no TTL: the parsable cache wins whatever its timestamp (today's behaviour)
  await utimes(cacheFile, new Date(Date.now() - 100 * 3600000), new Date(Date.now() - 100 * 3600000));
  assert.deepEqual(await cachedJson({ cacheFile, url, log: quiet, fetchImpl }), { v: 1 }, 'never expires');
  assert.equal(requests, 1);
  // TTL: 100 h old and a 24 h limit → downloaded again
  assert.deepEqual(await cachedJson({ cacheFile, url, ttlHours: 24, log: quiet, fetchImpl }), { v: 2 });
  assert.equal(requests, 2);
  // fresh again: within the TTL the refreshed cache is reused
  assert.deepEqual(await cachedJson({ cacheFile, url, ttlHours: 24, log: quiet, fetchImpl }), { v: 2 });
  assert.equal(requests, 2, 'a fresh cache is not re-downloaded');
  // the refresh flag still wins over a fresh cache
  assert.deepEqual(await cachedJson({ cacheFile, url, ttlHours: 24, refresh: true, log: quiet, fetchImpl }), { v: 2 });
  assert.equal(requests, 3);
});

test('--index-base moves the three index requests onto the base host; the paths are the repository paths', async (t) => {
  const dir = await fixture(t);
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ index: req.url }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const out = await loadIndexes(dir, { indexBase: base, cacheDir: join(dir, 'cache'), log: quiet, fetchImpl: globalThis.fetch });
  assert.deepEqual(asked.sort(), [
    '/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/audio_data.json',
    '/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/charword_table.json',
    '/isHarryh/Ark-Models/main/models_data.json',
  ]);
  assert.deepEqual(out.audioData, { index: '/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/audio_data.json' });
  // and they landed in the cache directory the caller named
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'cache', 'gamedata', 'excel', 'audio_data.json'), 'utf8')), out.audioData);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'cache', 'ark-models', 'models_data.json'), 'utf8')), out.modelsData);
});

test('--cache-dir / SP_CACHE_DIR: relative is from the repository root, absolute is used as it is, default is .cache', () => {
  assert.equal(resolveCacheDir(undefined), join(resolveCacheDir('.'), '.cache'));
  assert.equal(resolveCacheDir('.cache'), join(resolveCacheDir('.'), '.cache'));
  assert.equal(resolveCacheDir('tmp/c1'), join(resolveCacheDir('.'), 'tmp', 'c1'));
  assert.equal(resolveCacheDir('E:\\sp-cache'), 'E:\\sp-cache');
  assert.equal(parseArgs(['--cache-dir=C:\\sp-cache']).cacheDir, 'C:\\sp-cache', 'the = form is the one the parser supports');
});
