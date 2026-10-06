// test/workshopPack.test.js — tools/workshop-pack.mjs: 导出 / 导入 / 列出，以及 pack.json.support 的读写。
//
// 这一层是「把包交给别人」的那一步，所以每条用例都对应一个会把事情做错的直觉：
//
//   * 导入必须**先落到临时目录、校验完再搬**：直接往 workshop/<id>/ 解压，一个坏归档会在作者的工作目录里
//     留下半个包，而作者甚至不知道哪一半是新的 —— 所以测试要证明失败之后 workshop/ 里**什么都没多**；
//   * 归档的两种布局都真实存在（pack.json 在根，或包在一个唯一的顶层目录里），两种都必须能装；
//   * 覆盖是显式行为（--force / ?force=1），默认拒绝，且拒绝时原来的包一个字节都不能变；
//   * 装出来的包要用**游戏自己的加载器**（loadWorkshop）再读一遍 —— 编辑器说「装好了」不算，加载器说才行；
//   * `support` 的写入只动那一个字段：其余字段、键序与缩进原样保留，卡池之外的 id（官方干员）必须被拒。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  exportPack, installZip, readPackSupport, writePackSupport, packSummary, listPackIds,
  packFilesRecursive, readPackDir, runCli, assertEntryName,
} from '../tools/workshop-pack.mjs';
import { zipWrite, zipRead } from '../shared/zip.js';
import { loadWorkshop } from '../server/workshop.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let tmp;
let ws;
let ws2;

/** The manifest text of a pack, or null when it is not there (so a refusal can be proven not to have created one). */
const manifestText = (root, id) => {
  try { return fs.readFileSync(join(root, id, 'pack.json'), 'utf8'); } catch { return null; }
};
/** Everything a failed install may not leave behind: pack dirs AND temp dirs. */
const entriesIn = (root) => (fs.existsSync(root) ? fs.readdirSync(root).sort() : []);

/**
 * A pack that exercises every axis at once: data files, a kit, a voice line inside assets/, a 助战 declaration, an
 * override and a field the editor knows nothing about. `support` names the pack's OWN base operator.
 */
function writeDemoPack(root, id = 'demo', { support = ['chess_ws_demo_a'] } = {}) {
  const dir = join(root, id);
  fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
  fs.mkdirSync(join(dir, 'kits'), { recursive: true });
  fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
    id, name: '演示包', version: '1.2.0', author: '水沫沐沐', license: 'CC0-1.0',
    description: '测试分享与安装', gameVersion: '0.1.3',
    content: ['chess', 'items'], overrides: ['chess:chess_char_1_01_a'],
    voices: { chess_ws_demo_a: { select: ['voice/select1.mp3'] } },
    support,
  }, null, 2)}\n`);
  fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({
    chess_ws_demo_a: {
      chessId: 'chess_ws_demo_a', name: '演示干员', tier: 5, profession: 'SNIPER', position: 'RANGED',
      isGolden: false, visible: true, isHidden: false, isDiy: false,
      goldenId: 'chess_ws_demo_b', baseId: 'chess_ws_demo_a',
    },
    chess_ws_demo_b: {
      chessId: 'chess_ws_demo_b', name: '演示干员精锐', tier: 5, profession: 'SNIPER', position: 'RANGED',
      isGolden: true, visible: true, isHidden: false, isDiy: false,
      goldenId: null, baseId: 'chess_ws_demo_a',
    },
  }, null, 2)}\n`);
  fs.writeFileSync(join(dir, 'items.json'), `${JSON.stringify({ chess_item_ws_demo_a: { id: 'chess_item_ws_demo_a', name: '演示装备', tier: 2 } }, null, 2)}\n`);
  fs.writeFileSync(join(dir, 'kits', 'chess_ws_demo_a.js'), `export default function kit() { return { skill: { name: 'x' } }; }\n`);
  fs.writeFileSync(join(dir, 'assets', 'voice', 'select1.mp3'), Buffer.from('ID3\x03\x00\x00\x00\x00MP3-STANDIN', 'latin1'));
  fs.writeFileSync(join(dir, 'assets', 'other.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(join(dir, 'NOTES.txt'), '作者自己的笔记\n');
  return dir;
}

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-pack-'));
  ws = join(tmp, 'workshop');
  ws2 = join(tmp, 'installed');
  fs.mkdirSync(ws, { recursive: true });
  writeDemoPack(ws);
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- 导出 ---------------------------------------------------------------------------------------------------------

describe('workshop-pack: 导出', () => {
  test('export writes pack.json and every file under the pack, at the ZIP ROOT, sorted', () => {
    const r = exportPack(ws, 'demo');
    assert.equal(r.id, 'demo');
    assert.equal(r.bytes, r.buffer.length);
    const read = zipRead(r.buffer);
    assert.equal(read.ok, true, JSON.stringify(read));
    const names = read.entries.map((e) => e.name);
    assert.deepEqual(names, [...names].sort(), 'the entries are sorted, so the bytes are reproducible');
    assert.ok(names.includes('pack.json'), 'the archive IS the pack: the manifest sits at the root');
    assert.ok(names.includes('chess.json'));
    assert.ok(names.includes('assets/voice/select1.mp3'), 'assets/ travels inside the zip');
    assert.ok(names.includes('assets/other.bin'));
    assert.ok(names.includes('kits/chess_ws_demo_a.js'));
    assert.equal(r.entries, names.length);
    // the pack's own bytes, not a re-serialization
    assert.deepEqual(read.entries.find((e) => e.name === 'chess.json').data, fs.readFileSync(join(ws, 'demo', 'chess.json')));
    assert.deepEqual(read.entries.find((e) => e.name === 'NOTES.txt').data, fs.readFileSync(join(ws, 'demo', 'NOTES.txt')));
  });

  test('the same pack exports byte-identically twice', () => {
    const a = exportPack(ws, 'demo');
    const b = exportPack(ws, 'demo');
    assert.deepEqual(a.buffer, b.buffer, 'a distributed pack must be reproducible');
  });

  test('an unknown pack id, or a pack with no readable pack.json, is refused', () => {
    assert.throws(() => exportPack(ws, 'nope'), /不存在|pack\.json/);
    assert.throws(() => exportPack(ws, 'bad id!'), /不合法/);
    fs.mkdirSync(join(ws, 'empty'), { recursive: true });
    assert.throws(() => exportPack(ws, 'empty'), /不存在/);
    fs.rmSync(join(ws, 'empty'), { recursive: true, force: true });
    // a manifest the LOADER would reject must not be shipped as if it were fine
    fs.mkdirSync(join(ws, 'broken'), { recursive: true });
    fs.writeFileSync(join(ws, 'broken', 'pack.json'), '{ "id": "broken", "content": [] }\n');
    assert.throws(() => exportPack(ws, 'broken'), /不合法|EMPTY_PACK/);
    fs.rmSync(join(ws, 'broken'), { recursive: true, force: true });
  });

  test('a pack too big to be IMPORTED is refused at export, not silently produced', () => {
    // 导出唯一的用途就是给别人装，而 zipRead 对归档字节与解开后总量都有上限。先在这里挡住，
    // 否则作者会得到一个「自己这边一切正常、别人一装就失败」的包 —— 这台机器上看不出任何问题。
    assert.throws(() => exportPack(ws, 'demo', { limits: { maxTotalBytes: 8, maxEntries: 4096, maxFileBytes: 4096 } }),
      /超过 .* 的导入上限|导入上限/, '导出侧必须与导入侧同一个上限');
  });

  test('packFilesRecursive and readPackDir walk the directory itself', () => {
    const files = packFilesRecursive(join(ws, 'demo'));
    assert.deepEqual(files.map((f) => f.name), [...files.map((f) => f.name)].sort());
    const pack = readPackDir(join(ws, 'demo'), 'demo');
    assert.equal(pack.checked.ok, true);
    // every data file on disk is read, regardless of `content` (the loader's stricter view is the validator's job)
    assert.deepEqual(Object.keys(pack.files).sort(), ['chess', 'items']);
    assert.equal(pack.hasAssets, true);
  });
});

// ---- 导入 ---------------------------------------------------------------------------------------------------------

describe('workshop-pack: 导入', () => {
  test('export → import round-trips the pack and the GAME LOADER accepts it', () => {
    const zip = exportPack(ws, 'demo').buffer;
    const installed = installZip({ root: ws2, buffer: zip });
    assert.equal(installed.id, 'demo');
    assert.deepEqual(installed.content, ['chess', 'items'], 'the content list survives the round trip');
    assert.deepEqual(installed.support, ['chess_ws_demo_a']);
    assert.equal(installed.voiceLines, 1);
    assert.equal(entriesIn(ws2).length, 1, 'nothing else is left in the workshop root');

    // every byte survived, including the ones the editor never looks at
    for (const rel of ['pack.json', 'chess.json', 'items.json', 'kits/chess_ws_demo_a.js', 'assets/voice/select1.mp3', 'NOTES.txt']) {
      assert.deepEqual(fs.readFileSync(join(ws2, 'demo', ...rel.split('/'))), fs.readFileSync(join(ws, 'demo', ...rel.split('/'))), rel);
    }

    // the game's own loader, over the installed tree
    const loaded = loadWorkshop(ws2, { log: quiet });
    assert.deepEqual(loaded.errors, [], `the installed pack must load: ${JSON.stringify(loaded.errors)}`);
    assert.deepEqual(loaded.packs.map((p) => p.id), ['demo']);
    assert.deepEqual(Object.keys(loaded.packs[0].files).sort(), ['chess', 'items']);
    assert.deepEqual(loaded.packs[0].support, ['chess_ws_demo_a']);
    assert.deepEqual(loaded.packs[0].voices, { chess_ws_demo_a: { select: ['voice/select1.mp3'] } });
    assert.deepEqual(loaded.packs[0].overrides, ['chess:chess_char_1_01_a']);
  });

  test('a pack nested in ONE top-level directory is installed too (both layouts are common)', () => {
    const inner = packFilesRecursive(join(ws, 'demo')).map((f) => ({ name: `demo-1.2.0/${f.name}`, data: f.data }));
    const nested = zipWrite(inner);
    const root = join(tmp, 'nested');
    const installed = installZip({ root, buffer: nested });
    assert.equal(installed.id, 'demo');
    assert.equal(fs.existsSync(join(root, 'demo', 'pack.json')), true, 'the directory wrapper is dropped');
    assert.equal(fs.existsSync(join(root, 'demo', 'assets', 'voice', 'select1.mp3')), true);
    assert.equal(entriesIn(root).length, 1);
    assert.deepEqual(loadWorkshop(root, { log: quiet }).errors, []);
  });

  test('an archive with no pack.json, or with two, is refused', () => {
    const none = zipWrite([{ name: 'readme.txt', data: Buffer.from('hi') }]);
    assert.throws(() => installZip({ root: join(tmp, 'x1'), buffer: none }), /pack\.json/);
    const two = zipWrite([
      { name: 'a/pack.json', data: Buffer.from('{"id":"a","name":"a","content":["chess"]}') },
      { name: 'b/pack.json', data: Buffer.from('{"id":"b","name":"b","content":["chess"]}') },
    ]);
    assert.throws(() => installZip({ root: join(tmp, 'x2'), buffer: two }), /多个顶层目录/);
    assert.equal(fs.existsSync(join(tmp, 'x2')), false, 'a refusal must not create the workshop root either');
  });

  test('an existing pack is refused without force, and the refusal changes nothing', () => {
    const root = join(tmp, 'overwrite');
    const zip = exportPack(ws, 'demo').buffer;
    installZip({ root, buffer: zip });
    const before = manifestText(root, 'demo');
    const again = zipWrite([{ name: 'pack.json', data: Buffer.from('{"id":"demo","name":"另一个包","content":["chess"]}') }]);
    assert.throws(() => installZip({ root, buffer: again }), /已经存在|--force/);
    assert.equal(manifestText(root, 'demo'), before, 'the installed pack is untouched');
    assert.deepEqual(entriesIn(root), ['demo'], 'and no temp directory is left behind');

    // …and force REPLACES it
    const forced = installZip({ root, buffer: again, force: true });
    assert.equal(forced.id, 'demo');
    assert.equal(JSON.parse(manifestText(root, 'demo')).name, '另一个包');
    assert.deepEqual(entriesIn(root), ['demo']);
    // the replaced pack's old files are gone: it was replaced, not merged into
    assert.equal(fs.existsSync(join(root, 'demo', 'assets')), false);
  });

  test('a failed install leaves no pack and no temp directory (extract to a temp dir, then move)', () => {
    const root = join(tmp, 'clean');
    fs.mkdirSync(root, { recursive: true });
    const cases = [
      ['a manifest the loader rejects', zipWrite([{ name: 'pack.json', data: Buffer.from('{"id":"demo","content":[]}') }])],
      ['a manifest that is not JSON', zipWrite([{ name: 'pack.json', data: Buffer.from('{ oops') }])],
      ['a pack id that is not a slug', zipWrite([{ name: 'pack.json', data: Buffer.from('{"id":"../escape","content":["chess"]}') }])],
      ['an archive with no files', zipWrite([])],
      ['bytes that are not a zip', Buffer.from('definitely not a zip archive')],
    ];
    for (const [why, buffer] of cases) {
      assert.throws(() => installZip({ root, buffer }), (e) => e && e.refused === true, why);
      assert.deepEqual(entriesIn(root), [], `${why}: nothing may be left behind`);
    }
    // a pack whose id is a valid slug but whose manifest cannot load still must not appear
    assert.throws(() => installZip({ root, buffer: zipWrite([{ name: 'pack.json', data: Buffer.from('{"id":"half","content":[]}') }]) }), (e) => e.refused === true);
    assert.deepEqual(entriesIn(root), []);
  });

  test('a hostile archive is refused and leaves no file outside the pack directory', () => {
    const root = join(tmp, 'hostile');
    fs.mkdirSync(root, { recursive: true });
    const before = entriesIn(root);
    // a name that escapes upwards is refused by the READER (the archive is not read at all)…
    assert.throws(() => installZip({ root, buffer: zipWrite([{ name: '../escape.txt', data: Buffer.from('x') }]) }), (e) => e.refused === true);
    // …and an absolute name, a backslash name and a dot segment likewise
    for (const name of ['/abs.txt', 'C:/abs.txt', 'a\\b.txt', './x.txt', 'a/../../b.txt']) {
      assert.throws(() => installZip({ root, buffer: zipWrite([{ name, data: Buffer.from('x') }]) }), (e) => e.refused === true, name);
    }
    assert.deepEqual(entriesIn(root), before, 'a hostile archive writes nothing at all');
    assert.equal(fs.existsSync(join(tmp, 'escape.txt')), false, 'and above all not outside the pack directory');
    assert.equal(fs.existsSync(join(tmp, 'installed', 'escape.txt')), false);
  });

  test('the extractor refuses an escaping name on its own (the second line of defence)', () => {
    // zipRead already refuses these; assertEntryName is what protects a caller that reads entries from anywhere else
    for (const name of ['../x', 'a/../../x', '/abs', 'C:/abs', 'a\\b', './x', 'a/./b', '']) {
      assert.throws(() => assertEntryName(name), (e) => e.refused === true, name);
    }
    for (const name of ['pack.json', 'assets/a.png', 'kits/chess_ws_x_a.js', '素材/立绘.png']) {
      assert.equal(assertEntryName(name), undefined, `${name} must be accepted`);
    }
  });
});

// ---- 助战声明 -----------------------------------------------------------------------------------------------------

describe('workshop-pack: pack.json.support', () => {
  test('reading derives the tier from the record and lists the pack OWN operators', () => {
    const state = readPackSupport(ws, 'demo', { supportFile: null });
    assert.deepEqual(state.support, ['chess_ws_demo_a']);
    assert.deepEqual(state.derived, [{ id: 'chess_ws_demo_a', tier: 5 }], 'the tier comes from the record, never the manifest');
    assert.deepEqual(state.errors, []);
    // the elite twin is offered as a row but not as a separate pool entry
    assert.deepEqual(state.operators.map((o) => o.id), ['chess_ws_demo_a']);
    assert.equal(state.operators[0].selected, true);
    assert.equal(state.operators[0].tier, 5);
  });

  test('a declaration naming an operator this pack does not add is reported, and refused on write', async () => {
    const dirty = join(tmp, 'dirty');
    fs.mkdirSync(dirty, { recursive: true });
    writeDemoPack(dirty, 'demo', { support: ['chess_ws_demo_a', 'chess_char_1_01_a'] });
    const state = readPackSupport(dirty, 'demo', { supportFile: null });
    assert.ok(state.errors.some((e) => e.code === 'SUPPORT_FOREIGN_OPERATOR' && e.id === 'chess_char_1_01_a'), JSON.stringify(state.errors));
    assert.deepEqual(state.derived, [{ id: 'chess_ws_demo_a', tier: 5 }], 'the foreign id contributes nothing');
    await assert.rejects(() => writePackSupport(dirty, 'demo', ['chess_char_1_01_a']), /SUPPORT_FOREIGN_OPERATOR/);
    // the same shape of refusal the loader's own code names
    await assert.rejects(() => writePackSupport(dirty, 'demo', 'chess_ws_demo_a'), /数组/);
    await assert.rejects(() => writePackSupport(dirty, 'demo', ['bad id!']), /SUPPORT_BAD_ID/);
    fs.rmSync(dirty, { recursive: true, force: true });
  });

  test('a write changes the support field ONLY, and appends it last', async () => {
    const root = join(tmp, 'support-edit');
    fs.mkdirSync(root, { recursive: true });
    const dir = writeDemoPack(root, 'demo');
    // remove the key first, so the write has to ADD it — and put the author's own key order to the test
    const manifest = JSON.parse(fs.readFileSync(join(dir, 'pack.json'), 'utf8'));
    delete manifest.support;
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const beforeObj = JSON.parse(fs.readFileSync(join(dir, 'pack.json'), 'utf8'));

    const r = await writePackSupport(root, 'demo', ['chess_ws_demo_a']);
    assert.equal(r.changed, true);
    assert.deepEqual(r.support, ['chess_ws_demo_a']);
    const after = fs.readFileSync(join(dir, 'pack.json'), 'utf8');
    const afterObj = JSON.parse(after);
    assert.deepEqual(afterObj.support, ['chess_ws_demo_a']);
    assert.deepEqual(Object.keys(afterObj).filter((k) => k !== 'support'), Object.keys(beforeObj), 'every other field keeps its place');
    assert.equal(Object.keys(afterObj).at(-1), 'support', 'a new key is appended, never spliced into the middle');
    assert.match(after, /\n  "content": \[\n    "chess",\n    "items"\n  \],/, 'the 2-space indentation survives');
    assert.equal(after.endsWith('}\n'), true, 'and so does the trailing newline');
    assert.deepEqual(afterObj.content, ['chess', 'items'], 'writing support must never add a content entry');
    assert.deepEqual(afterObj.voices, beforeObj.voices, 'and never touch voices');

    // writing the same list again is a no-op on disk
    const again = await writePackSupport(root, 'demo', ['chess_ws_demo_a']);
    assert.equal(again.changed, false);
    assert.equal(fs.readFileSync(join(dir, 'pack.json'), 'utf8'), after);

    // clearing removes the key entirely, not leaving an empty array behind
    const cleared = await writePackSupport(root, 'demo', []);
    assert.equal(cleared.changed, true);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(join(dir, 'pack.json'), 'utf8')), 'support'), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an operator with no integer tier can never enter the pool, and the state says so', () => {
    const root = join(tmp, 'no-tier');
    fs.mkdirSync(root, { recursive: true });
    const dir = writeDemoPack(root, 'demo', { support: ['chess_ws_demo_a'] });
    fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({ chess_ws_demo_a: { chessId: 'chess_ws_demo_a', name: '无阶干员', tier: 'high' } }, null, 2)}\n`);
    const state = readPackSupport(root, 'demo', { supportFile: null });
    assert.deepEqual(state.derived, [], 'no tier means no pool entry');
    assert.ok(state.errors.some((e) => e.code === 'SUPPORT_TIER_UNKNOWN'), JSON.stringify(state.errors));
    assert.equal(state.operators[0].tier, null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the summary carries the numbers the list shows', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    const s = packSummary(ws, 'demo', loaded, { supportFile: null });
    assert.equal(s.id, 'demo');
    assert.equal(s.name, '演示包');
    assert.equal(s.version, '1.2.0');
    assert.equal(s.license, 'CC0-1.0');
    assert.deepEqual(s.content, ['chess', 'items']);
    assert.equal(s.voiceLines, 1);
    assert.deepEqual(s.support, ['chess_ws_demo_a']);
    assert.deepEqual(s.supportDerived, [{ id: 'chess_ws_demo_a', tier: 5 }]);
    assert.equal(s.status, 'loaded', 'the loader is the judge');
    assert.equal(s.reason, null);
    assert.deepEqual(listPackIds(ws), ['demo'], 'a hidden directory (a leftover temp dir) is not a pack');
  });
});

// ---- CLI ----------------------------------------------------------------------------------------------------------

describe('workshop-pack: 命令行', () => {
  test('list prints one line per pack with its numbers, and --json is machine readable', () => {
    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      assert.equal(runCli(['list', '--workshop', ws]), 0);
    } finally {
      console.log = log;
    }
    const text = lines.join('\n');
    assert.match(text, /pack demo "演示包" v1\.2\.0/);
    assert.match(text, /内容 chess/);
    assert.match(text, /语音 1 条/);
    assert.match(text, /助战 1 个（chess_ws_demo_a→阶5）/);
    assert.match(text, /VALID/);
    assert.match(text, /1 个包/);
  });

  test('export then import through the CLI functions (no process needed)', () => {
    const out = join(tmp, 'cli-demo.zip');
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(runCli(['export', 'demo', '--workshop', ws, '--out', out]), 0);
      assert.equal(runCli(['import', out, '--workshop', join(tmp, 'cli-ws')]), 0);
    } finally {
      console.log = log;
    }
    assert.equal(zipRead(fs.readFileSync(out)).ok, true);
    assert.deepEqual(loadWorkshop(join(tmp, 'cli-ws'), { log: quiet }).errors, []);
  });

  test('bad usage exits 2, a refusal exits 1 (the real process, because exit codes are the contract)', () => {
    const cli = (args) => spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-pack.mjs'), ...args], { encoding: 'utf8', timeout: 60_000 });
    const usage = cli(['bogus']);
    assert.equal(usage.status, 2, usage.stdout + usage.stderr);
    assert.match(usage.stderr, /未知子命令/);
    assert.match(usage.stderr, /用法/, 'a usage error prints the usage');
    assert.equal(cli([]).status, 0, 'no subcommand prints the usage and succeeds');
    assert.equal(cli(['export']).status, 2, 'export needs a pack id');

    const refused = cli(['export', 'nope', '--workshop', ws]);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /不存在/);
    assert.ok(!/at .*\.mjs:\d+/.test(refused.stderr), `a refusal must not print a stack trace: ${refused.stderr}`);

    // a missing file and a hostile archive are refusals, not usage errors
    assert.equal(cli(['import', join(tmp, 'nope.zip')]).status, 1);
    const hostile = join(tmp, 'hostile.zip');
    fs.writeFileSync(hostile, zipWrite([{ name: '../escape.txt', data: Buffer.from('x') }]));
    const hostileRun = cli(['import', hostile, '--workshop', join(tmp, 'cli-hostile')]);
    assert.equal(hostileRun.status, 1, hostileRun.stdout + hostileRun.stderr);
    assert.equal(fs.existsSync(join(tmp, 'escape.txt')), false);
    assert.equal(fs.existsSync(join(tmp, 'cli-hostile')), false, 'nothing is created for a hostile archive');

    // the exit code of a successful run is 0 and the file is really there
    const out = join(tmp, 'cli-exit.zip');
    assert.equal(cli(['export', 'demo', '--workshop', ws, '--out', out]).status, 0);
    assert.equal(fs.existsSync(out), true);
  });
});
