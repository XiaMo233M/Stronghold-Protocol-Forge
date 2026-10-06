// test/packManager.test.js — 编辑器的第八页（包管理）的路由，端到端。
//
// 这一页把两件互相牵连的事放到了一起：**导出/导入一个包**（让包能被交给别人），以及 **`pack.json.support`**
// （让助战声明有图形入口）。两条都必须与 CLI、与加载器一致，所以这里断言的是同一批性质：
//
//   * 导出的响应必须是**能被 shared/zip.js 读回来的 zip**，而不是「看起来像 zip 的字节」；
//   * 导入走的必须是和 CLI 完全相同的安装路径（临时目录 → 校验 → 搬），所以拒绝时 workshop/ 里不会多任何东西；
//   * support 的 POST 只改那一个字段：其余字段、键序、两空格缩进都不变，而且**绝不**补一条 content；
//   * 官方干员 id（不是这个包新增的）必须被拒 —— 卡池是安装方的规则，包只能声明自己的干员；
//   * 写进去的包要能被 `loadWorkshop()` 读到，并让 `applyWorkshop` 把干员按记录推导的阶放进卡池。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { loadWorkshop } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { applyWorkshop } from '../shared/workshop.js';
import { zipRead, zipWrite } from '../shared/zip.js';
import { normalizePackManifest } from '../shared/workshop.js';

/** The manifest validator the loader uses: a written `pack.json` must still pass it (no boolean is trusted here). */
const normalizeCheck = (raw) => normalizePackManifest(raw, raw && raw.id, { hasAssets: true }).ok === true;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** 每个拒绝都必须是一句中文界面能用的话，而不是英文调试串。 */
const isChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s));

let tmp;
let wsRoot;
let supportFile;
let editor;

const packDir = (id) => join(wsRoot, id);
const manifestText = (id) => {
  try { return fs.readFileSync(join(packDir(id), 'pack.json'), 'utf8'); } catch { return null; }
};
const writePack = (id, manifest, files = {}) => {
  fs.mkdirSync(packDir(id), { recursive: true });
  fs.writeFileSync(join(packDir(id), 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(packDir(id), ...rel.split('/'));
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'string' ? body : Buffer.from(body));
  }
};

/** 这个包的两个干员：一个助战候选（4 阶）和一个 6 阶的，用来证明「阶由记录推导」而不是猜。 */
const CHESS = {
  chess_ws_demo_a: { chessId: 'chess_ws_demo_a', name: '演示干员', tier: 4, profession: 'SNIPER', position: 'RANGED' },
  chess_ws_demo_b: { chessId: 'chess_ws_demo_b', name: '演示干员精锐', tier: 4, profession: 'SNIPER', position: 'RANGED', isGolden: true },
  chess_ws_demo_big: { chessId: 'chess_ws_demo_big', name: '六阶干员', tier: 6, profession: 'CASTER', position: 'RANGED' },
};

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-pack-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });
  // 助战是 ON，但 4 阶还没有名额：包的声明必须能被读出来，而 enabled 仍由 slots/pool 决定
  supportFile = join(tmp, 'support.json');
  fs.writeFileSync(supportFile, `${JSON.stringify({ enabled: true, label: '助战', slots: { 4: 1, 6: 1 }, pool: { 6: ['chess_char_6_01_a'] } }, null, 2)}\n`);

  writePack('demo', {
    id: 'demo', name: '演示包', version: '1.0.0', author: '水沫沐沐', license: 'CC0-1.0',
    description: '包管理页的测试包', gameVersion: '0.1.3', content: ['chess'],
  }, {
    'chess.json': `${JSON.stringify(CHESS, null, 2)}\n`,
    'assets/voice/select1.mp3': 'ID3\x03\x00\x00\x00MP3-STANDIN',
    'NOTES.txt': '作者的笔记\n',
  });

  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile, dataDir: DATA_DIR });
});
after(async () => {
  await editor?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 导出 ---------------------------------------------------------------------------------------------------------

describe('包管理：导出（GET /api/packs/<id>/export）', () => {
  test('the response is a zip the shared reader can read, with the pack at its root', async () => {
    const res = await fetch(`${editor.url}/api/packs/demo/export`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="demo\.zip"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), buf.length);

    const read = zipRead(buf);
    assert.equal(read.ok, true, JSON.stringify(read));
    const names = read.entries.map((e) => e.name);
    assert.ok(names.includes('pack.json'), 'the archive IS the pack');
    assert.ok(names.includes('chess.json'));
    assert.ok(names.includes('assets/voice/select1.mp3'), 'assets/ travels inside the zip');
    assert.deepEqual(names, [...names].sort());
    // the bytes are the pack's own, not a re-serialization of the parsed JSON
    assert.deepEqual(read.entries.find((e) => e.name === 'pack.json').data, fs.readFileSync(join(packDir('demo'), 'pack.json')));
  });

  test('a pack that does not exist is a 404, and a bad id is refused', async () => {
    const missing = await fetch(`${editor.url}/api/packs/nope/export`);
    assert.equal(missing.status, 404);
    assert.ok(isChinese((await missing.json()).error));
    assert.equal((await fetch(`${editor.url}/api/packs/bad%20id!/export`)).status, 400);
  });

  test('a pack the loader would drop is refused instead of shipped: an export is a share, not a dump', async () => {
    // EMPTY_PACK: no content and no voices. Handing that to someone else is not a share, it is a broken file
    fs.mkdirSync(join(wsRoot, 'broken'), { recursive: true });
    fs.writeFileSync(join(wsRoot, 'broken', 'pack.json'), '{ "id": "broken", "content": [] }\n');
    const res = await fetch(`${editor.url}/api/packs/broken/export`);
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.ok(isChinese(error), error);
    assert.match(error, /EMPTY_PACK|不合法/);
    fs.rmSync(join(wsRoot, 'broken'), { recursive: true, force: true });
  });
});

// ---- 导入 ---------------------------------------------------------------------------------------------------------

describe('包管理：导入（POST /api/packs/import）', () => {
  /** Import raw bytes into a SERVER (not the module), so the route's own reader and status codes are what is tested. */
  const importInto = async (server, buffer, query = '') => {
    const res = await fetch(`${server.url}/api/packs/import${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer,
    });
    return { status: res.status, body: await res.json() };
  };
  const exportOf = async (server, id) => Buffer.from(await (await fetch(`${server.url}/api/packs/${id}/export`)).arrayBuffer());
  /** A second editor over its own workshop root, so an install has somewhere clean to land. */
  const withServer = async (root, fn) => {
    const server = await createEditorServer({ workshopRoot: root, port: 0, host: '127.0.0.1', supportFile, dataDir: DATA_DIR });
    try { return await fn(server); } finally { await server.close(); }
  };

  test('a package exported from one install goes into another and the game loader accepts it', async () => {
    // give the source pack a 助战 declaration first, so the round trip also covers the field this page writes
    const original = manifestText('demo');
    fs.writeFileSync(join(packDir('demo'), 'pack.json'), `${JSON.stringify({ ...JSON.parse(original), support: ['chess_ws_demo_a'] }, null, 2)}\n`);
    const zip = await exportOf(editor, 'demo');
    fs.writeFileSync(join(packDir('demo'), 'pack.json'), original);

    const target = join(tmp, 'import-target');
    await withServer(target, async (server) => {
      const r = await importInto(server, zip);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(r.body.pack, 'demo');
      assert.equal(r.body.files, 4);
      assert.ok(r.body.bytes > 0);
      assert.deepEqual(r.body.content, ['chess']);
      assert.equal(r.body.voiceLines, 0, 'this pack ships no voice lines');
      assert.deepEqual(r.body.support, ['chess_ws_demo_a'], 'the 助战 declaration travels with the pack');
      assert.equal(r.body.summary.status, 'loaded', 'the freshly installed pack must be loaded by the game loader');
      assert.equal(r.body.summary.id, 'demo');
    });
    // every byte of the pack is there — compared against the ARCHIVE the export produced, not against the (now
    // restored) source directory, because the source was restored without the declaration the zip carries
    const inZip = new Map(zipRead(zip).entries.map((e) => [e.name, e.data]));
    for (const rel of ['pack.json', 'chess.json', 'NOTES.txt', 'assets/voice/select1.mp3']) {
      assert.deepEqual(fs.readFileSync(join(target, 'demo', ...rel.split('/'))), inZip.get(rel), rel);
    }
    assert.equal(fs.existsSync(join(target, 'demo', 'assets', 'voice', 'select1.mp3')), true);
    const installed = loadWorkshop(target, { log: quiet });
    assert.deepEqual(installed.errors, []);
    assert.deepEqual(installed.packs.map((p) => p.id), ['demo']);
    assert.deepEqual(installed.packs[0].support, ['chess_ws_demo_a'], 'the loader reads the declaration back');
    assert.deepEqual(fs.readdirSync(target).sort(), ['demo'], 'no temp directory is left behind');
  });

  test('a pack nested in one top-level directory installs too (both layouts are common in the wild)', async () => {
    const zip = await exportOf(editor, 'demo');
    const read = zipRead(zip);
    assert.equal(read.ok, true);
    const nested = zipWrite(read.entries.map((e) => ({ name: `demo-1.0.0/${e.name}`, data: e.data })));
    const target = join(tmp, 'import-nested');
    await withServer(target, async (server) => {
      const r = await importInto(server, nested);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.pack, 'demo');
    });
    assert.equal(fs.existsSync(join(target, 'demo', 'pack.json')), true, 'the wrapper directory is dropped');
    assert.deepEqual(fs.readdirSync(target).sort(), ['demo']);
  });

  test('an existing pack is refused without force=1, and the installed bytes stay untouched', async () => {
    const before = manifestText('demo');
    const r = await importInto(editor, await exportOf(editor, 'demo'));
    assert.equal(r.status, 400);
    assert.ok(isChinese(r.body.error), r.body.error);
    assert.match(r.body.error, /已经存在|force/);
    assert.equal(manifestText('demo'), before);
    assert.deepEqual(fs.readdirSync(wsRoot).sort(), ['demo'], 'no temp directory survives a refusal');
  });

  test('force=1 replaces the pack, and the replaced pack is replaced rather than merged into', async () => {
    // the main root's `demo` is the source of truth for the rest of this suite: import a DIFFERENT id by force into a
    // fresh root whose pack is replaced, so the shared fixture is not disturbed
    const target = join(tmp, 'import-force');
    await withServer(target, async (server) => {
      const first = await importInto(server, await exportOf(editor, 'demo'));
      assert.equal(first.status, 200);
      // a different pack under the SAME id: only force may overwrite, and the old files must not linger
      const replacement = zipWrite([
        { name: 'pack.json', data: Buffer.from(`${JSON.stringify({ id: 'demo', name: '替换后的包', version: '2.0.0', content: ['chess'] }, null, 2)}\n`) },
        { name: 'chess.json', data: Buffer.from(`${JSON.stringify({ chess_ws_demo_a: { chessId: 'chess_ws_demo_a', name: '甲', tier: 4 } }, null, 2)}\n`) },
      ]);
      const refused = await importInto(server, replacement);
      assert.equal(refused.status, 400);
      assert.equal(JSON.parse(fs.readFileSync(join(target, 'demo', 'pack.json'), 'utf8')).name, '演示包');

      const forced = await importInto(server, replacement, '?force=1');
      assert.equal(forced.status, 200, JSON.stringify(forced.body));
      assert.equal(JSON.parse(fs.readFileSync(join(target, 'demo', 'pack.json'), 'utf8')).name, '替换后的包');
      assert.equal(fs.existsSync(join(target, 'demo', 'assets')), false, 'a replaced pack is replaced, not merged');
    });
    assert.deepEqual(fs.readdirSync(target).sort(), ['demo']);
  });

  test('a hostile or broken archive is refused, and workshop/ is left exactly as it was', async () => {
    const before = fs.readdirSync(wsRoot).sort();
    const beforeManifest = manifestText('demo');
    const cases = [
      ['a traversal name', zipWrite([{ name: '../evil.txt', data: Buffer.from('x') }]), /ZIP_BAD_NAME|读不了/],
      ['an absolute name', zipWrite([{ name: '/etc/evil.txt', data: Buffer.from('x') }]), /ZIP_BAD_NAME|读不了/],
      ['a backslash name', zipWrite([{ name: 'a\\b.txt', data: Buffer.from('x') }]), /ZIP_BAD_NAME|读不了/],
      ['a dot segment', zipWrite([{ name: './x.txt', data: Buffer.from('x') }]), /ZIP_BAD_NAME|读不了/],
      ['no pack.json at all', zipWrite([{ name: 'readme.txt', data: Buffer.from('hi') }]), /pack\.json/],
      ['a manifest the loader rejects', zipWrite([{ name: 'pack.json', data: Buffer.from('{"id":"demo","content":[]}') }]), /EMPTY_PACK|不合法/],
      ['bytes that are not a zip', Buffer.from('not a zip, just words'), /ZIP_|读不了/],
    ];
    for (const [why, buffer, expect] of cases) {
      // force must not turn a bad archive into a good one
      const r = await importInto(editor, buffer, '?force=1');
      assert.equal(r.status, 400, why);
      assert.ok(isChinese(r.body.error), `${why}: ${r.body.error}`);
      assert.match(r.body.error, expect, why);
    }
    assert.deepEqual(fs.readdirSync(wsRoot).sort(), before, 'no pack and no temp directory was created');
    assert.equal(manifestText('demo'), beforeManifest, 'and the installed pack is byte-for-byte untouched');
    assert.equal(fs.existsSync(join(tmp, 'evil.txt')), false, 'nothing was written outside the workshop root');
    assert.equal(fs.existsSync(join(wsRoot, 'readme.txt')), false);
  });

  test('an empty body is refused with a message, not a crash', async () => {
    const r = await importInto(editor, Buffer.alloc(0));
    assert.equal(r.status, 400);
    assert.ok(isChinese(r.body.error));
  });
});

// ---- 助战声明 -----------------------------------------------------------------------------------------------------

describe('包管理：助战声明（GET /api/packs/support, POST /api/packs/<id>/support）', () => {
  test('GET lists every pack with its declared ids, the derived tier and the pool it lands in', async () => {
    writePack('demo', {
      id: 'demo', name: '演示包', version: '1.0.0', author: '水沫沐沐', license: 'CC0-1.0',
      description: '包管理页的测试包', gameVersion: '0.1.3', content: ['chess'],
      support: ['chess_ws_demo_a', 'chess_ws_demo_big'],
    }, { 'chess.json': `${JSON.stringify(CHESS, null, 2)}\n` });

    const r = await fetch(`${editor.url}/api/packs/support`).then((x) => x.json());
    assert.equal(r.enabled, true);
    assert.ok(r.pool['6'].includes('chess_char_6_01_a'), 'the pool belongs to the install (data/support.json)');
    assert.equal(r.packs.length, 1);
    const p = r.packs[0];
    assert.equal(p.id, 'demo');
    assert.equal(p.name, '演示包');
    assert.equal(p.version, '1.0.0');
    assert.equal(p.license, 'CC0-1.0');
    assert.deepEqual(p.content, ['chess']);
    assert.equal(p.status, 'loaded');
    assert.deepEqual(p.support, ['chess_ws_demo_a', 'chess_ws_demo_big']);
    // the tier is DERIVED from each record — never typed, never taken from the manifest
    assert.deepEqual(p.derived, [{ id: 'chess_ws_demo_a', tier: 4 }, { id: 'chess_ws_demo_big', tier: 6 }]);
    assert.deepEqual(p.errors, []);
    // only the pack's OWN, non-elite operators are offered as rows
    assert.deepEqual(p.operators.map((o) => o.id), ['chess_ws_demo_a', 'chess_ws_demo_big']);
    assert.deepEqual(p.operators.map((o) => o.selected), [true, true]);
  });

  test('POST writes support ONLY: the other fields, their order and the indentation survive', async () => {
    writePack('demo', {
      id: 'demo', name: '演示包', version: '1.0.0', author: '水沫沐沐', license: 'CC0-1.0',
      description: '包管理页的测试包', gameVersion: '0.1.3', content: ['chess'],
      voices: { chess_ws_demo_a: { select: ['voice/select1.mp3'] } },
      overrides: ['chess:chess_char_1_01_a'],
    }, {
      'chess.json': `${JSON.stringify(CHESS, null, 2)}\n`,
      // the voices above name this file, and a pack with voices MUST carry assets/ (VOICE_NEEDS_ASSETS)
      'assets/voice/select1.mp3': 'ID3\x03\x00\x00\x00MP3-STANDIN',
    });
    assert.equal(loadWorkshop(wsRoot, { log: quiet }).errors.length, 0, 'the fixture must be a loadable pack to start with');
    const beforeText = manifestText('demo');
    const beforeObj = JSON.parse(beforeText);
    const res = await post(`${editor.url}/api/packs/demo/support`, { ids: ['chess_ws_demo_big'] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.changed, true);
    assert.deepEqual(body.support, ['chess_ws_demo_big']);
    // the derived tier is the whole point of the route: it is the pack's own 6, not a guess
    assert.deepEqual(body.derived, [{ id: 'chess_ws_demo_big', tier: 6 }]);

    const afterText = manifestText('demo');
    const afterObj = JSON.parse(afterText);
    assert.deepEqual(afterObj.support, ['chess_ws_demo_big']);
    assert.deepEqual(Object.keys(afterObj).filter((k) => k !== 'support'), Object.keys(beforeObj), 'every other key keeps its place');
    assert.deepEqual({ ...afterObj, support: undefined }, { ...beforeObj, support: undefined }, 'and its value');
    assert.equal(Object.keys(afterObj).at(-1), 'support', 'the new key is appended');
    assert.match(afterText, /\n  "content": \[\n    "chess"\n  \],/, 'the 2-space indentation is kept');
    assert.equal(afterText.endsWith('}\n'), true, 'and the trailing newline');
    assert.deepEqual(afterObj.voices, { chess_ws_demo_a: { select: ['voice/select1.mp3'] } }, 'a field the page ignores is carried over');
    assert.deepEqual(afterObj.overrides, ['chess:chess_char_1_01_a']);
    assert.equal(normalizeCheck(afterObj), true, 'the written manifest is still one the loader accepts');
    // the pool file itself is never touched by this route
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(supportFile, 'utf8')).pool), ['6']);
  });

  test('a foreign operator id is refused, and nothing is written', async () => {
    const before = manifestText('demo');
    // an OFFICIAL operator: the pool is the install's decision, a pack may not add or remove official operators
    const official = Object.keys(JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8')))[0];
    for (const [why, ids, expect] of [
      ['an official operator', [official], /SUPPORT_FOREIGN_OPERATOR/],
      ['a malformed id', ['not an id!'], /SUPPORT_BAD_ID/],
      ['a non-array', 'chess_ws_demo_a', /数组/],
    ]) {
      const res = await post(`${editor.url}/api/packs/demo/support`, { ids });
      assert.equal(res.status, 400, why);
      const { error } = await res.json();
      assert.ok(isChinese(error), `${why}: ${error}`);
      assert.match(error, expect, why);
      assert.equal(manifestText('demo'), before, `${why}: a refusal must not write`);
    }
    // an unknown pack is a 404, and a bad pack id is a 400
    assert.equal((await post(`${editor.url}/api/packs/nope/support`, { ids: [] })).status, 404);
    assert.equal((await post(`${editor.url}/api/packs/bad%20id!/support`, { ids: [] })).status, 400);
  });

  test('clearing removes the key, and the manifest is only rewritten when it really changes', async () => {
    const cleared = await post(`${editor.url}/api/packs/demo/support`, { ids: [] });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).changed, true);
    assert.equal(Object.hasOwn(JSON.parse(manifestText('demo')), 'support'), false, 'an empty declaration drops the key');
    const again = await post(`${editor.url}/api/packs/demo/support`, { ids: [] });
    assert.equal((await again.json()).changed, false, 'nothing to change, nothing written');
  });

  test('the written pack loads through the game loader, and the operator enters the pool at its own tier', async () => {
    // 4 阶现在有名额：包的声明必须真的把干员放进卡池，否则「装包即可选」这句话是假的
    fs.writeFileSync(supportFile, `${JSON.stringify({ enabled: true, label: '助战', slots: { 4: 1 }, pool: {} }, null, 2)}\n`);
    const saved = await post(`${editor.url}/api/packs/demo/support`, { ids: ['chess_ws_demo_a'] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    assert.deepEqual((await saved.json()).derived, [{ id: 'chess_ws_demo_a', tier: 4 }]);

    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const pack = loaded.packs.find((p) => p.id === 'demo');
    assert.ok(pack, `the pack must load: ${JSON.stringify(loaded.errors)}`);
    assert.deepEqual(pack.support, ['chess_ws_demo_a']);

    // the overlay the server really applies, over the real data dir
    const merged = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.ok(merged.support.pool['4'].includes('chess_ws_demo_a'), 'the derived tier is where the operator lands');
    assert.ok(merged.support.pool['6'].includes('chess_ws_demo_a') === false, 'and nowhere else');

    // …and once by hand, on data with the overlay switched off, so this cannot be an accident of loadData
    const manual = applyWorkshop(loadData(DATA_DIR, { log: quiet, workshopDir: null }), loaded.packs);
    assert.ok(manual.data.support.pool['4'].includes('chess_ws_demo_a'));
    assert.deepEqual(manual.report.support, { demo: ['chess_ws_demo_a'] });

    // `"workshop": false` is the installer's off switch: every pack contribution is ignored. This runs over the REAL
    // data/support.json (loadData ignores the test's injected file), so the pool keeps its own 5/6 tiers and the pack's
    // 4-tier operator must NOT be added.
    const realSupport = JSON.parse(fs.readFileSync(join(DATA_DIR, 'support.json'), 'utf8'));
    realSupport.workshop = false;
    const offData = loadData(DATA_DIR, { log: quiet, workshopDir: null });
    const off = applyWorkshop({ ...offData, support: realSupport }, loaded.packs);
    assert.ok(!(off.data.support.pool['4'] || []).includes('chess_ws_demo_a'), 'the install keeps the last word');
    assert.deepEqual(off.data.support.pool['5'], realSupport.pool['5'], 'and the pool it declares is untouched');
    assert.equal(off.report.supportOff, true);
  });

  test('a directory that is not a pack is skipped instead of offering a row whose every action would fail', async () => {
    // a half-deleted pack, or a folder someone dropped into workshop/: no pack.json, so nothing can be exported or edited
    fs.mkdirSync(join(wsRoot, 'not-a-pack'), { recursive: true });
    fs.writeFileSync(join(wsRoot, 'not-a-pack', 'notes.txt'), 'hello\n');
    const res = await fetch(`${editor.url}/api/packs/support`);
    assert.equal(res.status, 200, 'a stray directory must not turn the list into a 500');
    const r = await res.json();
    assert.deepEqual(r.packs.map((p) => p.id), ['demo']);
    assert.equal((await fetch(`${editor.url}/api/packs/not-a-pack/export`)).status, 404, 'and it is not exportable either');
    fs.rmSync(join(wsRoot, 'not-a-pack'), { recursive: true, force: true });
  });

  test('a pack whose chess record has no integer tier is reported instead of silently doing nothing', async () => {
    writePack('no-tier', {
      id: 'no-tier', name: '无阶包', version: '1.0.0', content: ['chess'], support: ['chess_ws_notier_a'],
    }, { 'chess.json': `${JSON.stringify({ chess_ws_notier_a: { chessId: 'chess_ws_notier_a', name: '无阶', tier: 'x' } }, null, 2)}\n` });
    const r = await fetch(`${editor.url}/api/packs/support`).then((x) => x.json());
    const p = r.packs.find((x) => x.id === 'no-tier');
    assert.ok(p);
    assert.deepEqual(p.derived, []);
    assert.ok(p.errors.some((e) => e.code === 'SUPPORT_TIER_UNKNOWN'), JSON.stringify(p.errors));
    assert.equal(p.operators[0].tier, null, 'the page shows the missing tier instead of inventing one');
    fs.rmSync(packDir('no-tier'), { recursive: true, force: true });
  });
});

// ---- 页面本身 -----------------------------------------------------------------------------------------------------

describe('包管理：页面（第八页）', () => {
  test('pack.html and pack.js are served, and every page links to the new one', async () => {
    const html = await fetch(`${editor.url}/pack.html`).then((r) => r.text());
    assert.match(html, /工坊包管理/);
    assert.equal((await fetch(`${editor.url}/pack.js`)).status, 200);
    for (const page of ['index.html', 'stage.html', 'enemy.html', 'wave.html', 'item.html', 'kit.html', 'voice.html']) {
      const other = await fetch(`${editor.url}/${page}`).then((r) => r.text());
      assert.match(other, /pack\.html/, `${page} must link to the pack page`);
    }
    // …and the new page links back to all seven, so the nav is symmetric
    for (const page of ['index.html', 'stage.html', 'enemy.html', 'wave.html', 'item.html', 'kit.html', 'voice.html']) {
      assert.match(html, new RegExp(`\\./${page.replace('.', '\\.')}`), `pack.html must link to ${page}`);
    }
  });

  test('the page takes the tier from the API and never invents one, and it names data/support.json', async () => {
    const src = await fetch(`${editor.url}/pack.js`).then((r) => r.text());
    assert.match(src, /\/api\/packs\/support/, 'the list comes from the API');
    assert.match(src, /op\.tier/, 'the tier is displayed from the server-derived value');
    assert.doesNotMatch(src, /tier.*(input|numInput)/i, 'there is no field to type a tier into');
    assert.match(src, /data\/support\.json/, 'the page must say where the pool really lives');
    assert.match(src, /workshop.*false|"workshop": false/, 'and that the install can switch it off');
    // the export/import URLs the page uses are the routes this server really answers
    assert.match(src, /\/api\/packs\/import/);
    assert.match(src, /\.zip/);
  });
});
