// test/voiceEditor.test.js — the 语音 (voice line) page of the standalone workshop editor, end to end.
//
// This page is unlike the other five: `voices` is not a file of its own but a FIELD of `pack.json`
// (`{ <干员id>: { <槽位>: ["<assets/ 内的相对路径>", …] } }`, docs/WORKSHOP.md §1.4), and the manifest IS the artifact —
// shared/workshop.js merges it into `assets.audio.voice` at load time, so there is nothing to derive and no spec to keep
// apart from a generated record.
//
// What that makes worth pinning:
//   * a line must name a file that really exists under the pack's `assets/`, with an extension the pack-media route
//     serves — otherwise the client 404s and NOTHING in the game reports it;
//   * a write must preserve the rest of the manifest exactly (key order and indentation included), because `pack.json`
//     also carries `content`, `overrides` and the metadata — and a lost `content` entry means a pack that stops loading;
//   * every refusal must leave the file byte-for-byte untouched;
//   * and the whole point of the feature: a line saved through the EDITOR API must reach the manifest the GAME CLIENT
//     reads (`/workshop-assets/<pack>/<path>` in the merged `assets.json`).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { applyWorkshop, workshopVoiceIndex } from '../shared/workshop.js';
import { VOICE_SLOTS } from '../shared/constants.js';
import { WORKSHOP_ASSET_TYPES } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** A 16-byte stand-in for an mp3: the route decides the type by extension, the body must be the file's bytes. */
const MP3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00MP3-STANDIN', 'latin1');
const OGG = Buffer.from('OggS\x00\x02\x00\x00STAND-IN-OGG', 'latin1');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** Every refusal must be a message a Chinese UI can show, not an English debug string. */
const isChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s));

let tmp;
let wsRoot;
let editor;

const packDir = (id) => join(wsRoot, id);
/** null when the pack does not exist, so a refusal can be proven not to CREATE one either. */
const manifestText = (id) => {
  try { return fs.readFileSync(join(packDir(id), 'pack.json'), 'utf8'); } catch { return null; }
};
const manifestOf = (id) => JSON.parse(manifestText(id));
const writeManifest = (id, obj) => fs.writeFileSync(join(packDir(id), 'pack.json'), `${JSON.stringify(obj, null, 2)}\n`);
const writeAsset = (id, rel, bytes) => {
  const abs = join(packDir(id), 'assets', ...rel.split('/'));
  fs.mkdirSync(dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
};

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-voice-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });

  // 1) a normal pack: content + overrides + a separate assets/ folder holding the lines
  fs.mkdirSync(packDir('voice-pack'), { recursive: true });
  writeManifest('voice-pack', {
    id: 'voice-pack', name: '助战语音', version: '0.2.0', author: '水沫沐沐', license: 'CC0-1.0',
    description: '演示语音包', gameVersion: '0.1.3', content: ['chess'], overrides: ['chess:chess_char_1_01_a'],
    // a field that is none of the voice editor's business: whatever else a manifest carries must survive a voice save
    support: ['char_ws_vp'],
  });
  fs.writeFileSync(join(packDir('voice-pack'), 'chess.json'), JSON.stringify({
    char_ws_vp: { chessId: 'char_ws_vp', name: '测试助战', tier: 5 },
  }, null, 2));
  writeAsset('voice-pack', 'voice/select1.mp3', MP3);
  writeAsset('voice-pack', 'voice/select2.mp3', MP3);
  writeAsset('voice-pack', 'voice/deploy1.ogg', OGG);
  writeAsset('voice-pack', 'voice/cover.png', Buffer.from('89504e47', 'hex'));
  writeAsset('voice-pack', 'voice/.secret.mp3', MP3);      // hidden: the media route refuses dot-segments
  writeAsset('voice-pack', 'voice/script.js', Buffer.from('export default 1;'));
  writeAsset('voice-pack', 'notes.txt', Buffer.from('hello'));

  // 2) a 助战 voice pack: `content: []` and nothing but voice lines — still a legal pack
  fs.mkdirSync(packDir('voice-only'), { recursive: true });
  writeManifest('voice-only', {
    id: 'voice-only', name: '只带语音', version: '1.0.0', license: 'CC0-1.0', content: [],
    voices: { char_ws_vo: { select: ['voice/select1.mp3'] } },
  });
  writeAsset('voice-only', 'voice/select1.mp3', MP3);

  // 3) a pack with no assets/ folder at all: voices cannot be written (VOICE_NEEDS_ASSETS)
  fs.mkdirSync(packDir('no-assets'), { recursive: true });
  writeManifest('no-assets', { id: 'no-assets', name: '没有素材', version: '1.0.0', content: ['chess'] });

  // 4) a pack whose manifest the loader refuses for another reason: an append must not make that worse
  fs.mkdirSync(packDir('locked'), { recursive: true });
  writeManifest('locked', { id: 'locked', name: '缺 license', version: '1.0.0', content: ['chess'] });
  writeAsset('locked', 'voice/a.mp3', MP3);

  // 5) another pack with its own operator id, so `?pack=` can be shown to NARROW the picker
  fs.mkdirSync(packDir('spare-pack'), { recursive: true });
  writeManifest('spare-pack', { id: 'spare-pack', name: '备用包', version: '1.0.0', license: 'CC0-1.0', content: ['chess'] });
  fs.writeFileSync(join(packDir('spare-pack'), 'chess.json'), JSON.stringify({
    char_ws_spare: { chessId: 'char_ws_spare', name: '备用干员', tier: 4 },
  }, null, 2));
  writeAsset('spare-pack', 'voice/spare.mp3', MP3);

  // 6) a manifest with NO `content` key at all — writing voices must not invent one
  fs.mkdirSync(packDir('bare-voice'), { recursive: true });
  writeManifest('bare-voice', { id: 'bare-voice', license: 'CC0-1.0', voices: { char_ws_bare: { resultThree: ['voice/w.mp3'] } } });
  writeAsset('bare-voice', 'voice/w.mp3', MP3);

  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
});
after(async () => {
  await editor?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const setSlot = (pack, body) => post(`${editor.url}/api/packs/${pack}/voices`, body);

describe('workshop editor: 语音 (what the page is offered)', () => {
  test('GET /api/voices hands the page the slot vocabulary, the media allowlist and the operator ids', async () => {
    const r = await fetch(`${editor.url}/api/voices`).then((x) => x.json());
    // the slot list is VOICE_SLOTS, never a second copy the page or server could drift from
    assert.deepEqual(r.slots, [...VOICE_SLOTS]);
    assert.deepEqual(r.extensions, [...WORKSHOP_ASSET_TYPES.keys()], 'the allowlist is the one server/index.js serves with');
    assert.ok(r.audioExtensions.includes('.mp3') && r.audioExtensions.includes('.ogg'));
    assert.ok(!r.audioExtensions.includes('.png'), 'the editor preview route is audio-only');
    assert.equal(r.mediaPrefix, '/workshop-assets/', 'the page builds the same URL the game client will ask for');
    // operators: the official ones, plus the ids the packs themselves add — so an author never types an id from memory
    assert.ok(r.operators.length > 100, 'the official operators must be offered');
    assert.ok(r.operators.some((o) => o.from === 'official'));
    assert.ok(r.operators.some((o) => o.id === 'char_ws_vp' && o.from === 'voice-pack'), 'the pack\'s own operator is offered');
    assert.ok(r.operators.every((o) => o.id && o.name && Object.hasOwn(o, 'tier')));
  });

  test('GET /api/voices reports the packs\' lines and the files that really exist under each assets/', async () => {
    const r = await fetch(`${editor.url}/api/voices`).then((x) => x.json());
    const p = r.packs.find((x) => x.id === 'voice-pack');
    assert.ok(p, 'every pack is listed');
    assert.equal(p.hasAssets, true);
    assert.equal(p.ok, true, JSON.stringify(p.issue));
    assert.deepEqual(p.voices, {}, 'this pack declares no lines yet');
    const paths = p.files.map((f) => f.path);
    assert.ok(paths.includes('voice/select1.mp3') && paths.includes('notes.txt'), 'the picker offers what is on disk');
    assert.ok(!paths.some((x) => x.startsWith('.') || x.includes('/.')), 'a hidden file can never be played, so it is not offered');
    const mp3 = p.files.find((f) => f.path === 'voice/select1.mp3');
    assert.deepEqual({ audio: mp3.audio, serveable: mp3.serveable, ext: mp3.ext }, { audio: true, serveable: true, ext: '.mp3' });
    // a file that exists but that the pack-media route would refuse is offered as such, not silently: the author has to
    // be able to see WHY a line would never play
    assert.equal(p.files.find((f) => f.path === 'notes.txt').serveable, false);
    assert.equal(p.files.find((f) => f.path === 'voice/cover.png').audio, false);

    const only = r.packs.find((x) => x.id === 'voice-only');
    assert.deepEqual(only.voices, { char_ws_vo: { select: ['voice/select1.mp3'] } }, 'a declared line is echoed back');
    assert.deepEqual(only.content, [], 'and the pack stays a 助战 voice pack');
  });

  test('?pack= narrows the answer to one pack and to the operators that pack contributes', async () => {
    const all = await fetch(`${editor.url}/api/voices`).then((x) => x.json());
    assert.ok(all.operators.some((o) => o.id === 'char_ws_spare'), 'without ?pack every pack\'s ids are offered');

    const one = await fetch(`${editor.url}/api/voices?pack=voice-pack`).then((x) => x.json());
    assert.deepEqual(one.packs.map((p) => p.id), ['voice-pack']);
    assert.ok(one.operators.some((o) => o.from === 'official'));
    assert.ok(one.operators.some((o) => o.id === 'char_ws_vp'), 'the asked-for pack\'s own id is offered');
    assert.ok(!one.operators.some((o) => o.id === 'char_ws_spare'), '…and another pack\'s id is not');
  });

  test('a bad or unknown ?pack= is refused, and never with a 200 that says nothing', async () => {
    const bad = await fetch(`${editor.url}/api/voices?pack=bad%20id!`);
    assert.equal(bad.status, 400);
    assert.ok(isChinese((await bad.json()).error));
    const missing = await fetch(`${editor.url}/api/voices?pack=nope-pack`);
    assert.equal(missing.status, 404);
    assert.ok(isChinese((await missing.json()).error));
  });
});

describe('workshop editor: 语音 (add → list → remove)', () => {
  test('POST sets ONE slot, DELETE removes one, and the operator key disappears with its last slot', async () => {
    const added = await setSlot('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice/select2.mp3', 'voice/select1.mp3'] });
    assert.equal(added.status, 200, JSON.stringify(added));
    const addedBody = await added.json();
    assert.deepEqual(addedBody.paths, ['voice/select1.mp3', 'voice/select2.mp3'], 'the slot is stored sorted and deduplicated');
    assert.deepEqual(manifestOf('voice-pack').voices, { char_ws_vp: { select: ['voice/select1.mp3', 'voice/select2.mp3'] } });

    // a second slot on the same operator
    assert.equal((await setSlot('voice-pack', { charId: 'char_ws_vp', slot: 'place', paths: ['voice/deploy1.ogg'] })).status, 200);
    const listed = await fetch(`${editor.url}/api/voices?pack=voice-pack`).then((x) => x.json());
    assert.deepEqual(listed.packs[0].voices, {
      char_ws_vp: { place: ['voice/deploy1.ogg'], select: ['voice/select1.mp3', 'voice/select2.mp3'] },
    }, 'the page reads its list back from the API, not from what it sent');

    // one line of a two-line slot goes: the slot keeps the other, and the operator keys stay
    const partial = await setSlot('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice/select1.mp3'] });
    assert.equal(partial.status, 200);
    assert.deepEqual(manifestOf('voice-pack').voices.char_ws_vp.select, ['voice/select1.mp3']);

    // DELETE removes the rest of that slot
    const del = await fetch(`${editor.url}/api/packs/voice-pack/voices/char_ws_vp/select`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.removed, true);
    assert.deepEqual(manifestOf('voice-pack').voices, { char_ws_vp: { place: ['voice/deploy1.ogg'] } });

    // …and the LAST slot takes the operator key with it, because an empty operator key is not an answer to anything
    assert.equal((await setSlot('voice-pack', { charId: 'char_ws_vp', slot: 'place', paths: [] })).status, 200);
    const after = manifestOf('voice-pack');
    assert.equal(Object.hasOwn(after, 'voices'), false, 'the last line drops `voices` entirely rather than leaving {}');
    // an empty list on a slot that does not exist is a no-op, not a rewrite
    const noop = await fetch(`${editor.url}/api/packs/voice-pack/voices/char_ws_vp/skill2`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(noop.removed, false);
  });

  test('deleting a line that does not exist on disk is allowed — that is how a broken line is removed', async () => {
    writeManifest('voice-pack', {
      id: 'voice-pack', name: '助战语音', version: '0.2.0', author: '水沫沐沐', license: 'CC0-1.0',
      description: '演示语音包', gameVersion: '0.1.3', content: ['chess'], overrides: ['chess:chess_char_1_01_a'],
      support: ['char_ws_vp'],
      voices: { char_ws_vp: { select: ['voice/ghost.mp3'] } },
    });
    const del = await fetch(`${editor.url}/api/packs/voice-pack/voices/char_ws_vp/select`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.removed, true);
    assert.equal(Object.hasOwn(manifestOf('voice-pack'), 'voices'), false);
  });

  test('editing voices preserves content, overrides, the key order and the 2-space indentation', async () => {
    const before = manifestText('voice-pack');
    const beforeObj = JSON.parse(before);
    assert.equal((await setSlot('voice-pack', { charId: 'char_ws_vp', slot: 'skill1', paths: ['voice/select1.mp3'] })).status, 200);
    const after = manifestText('voice-pack');
    const afterObj = JSON.parse(after);
    const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== 'voices'));
    assert.deepEqual(strip(afterObj), strip(beforeObj), 'every other field is carried over untouched');
    const keys = (o) => Object.keys(o).filter((k) => k !== 'voices');
    assert.deepEqual(keys(afterObj), keys(beforeObj), 'including the order the author wrote them in');
    assert.deepEqual(Object.keys(afterObj).at(-1), 'voices', 'a new key is appended, never spliced into the middle');
    assert.match(after, /\n  "content": \[\n    "chess"\n  \],/, 'the file keeps its 2-space indentation');
    assert.equal(after.endsWith('}\n'), true, 'and its trailing newline');
    assert.deepEqual(afterObj.overrides, ['chess:chess_char_1_01_a']);
    assert.deepEqual(afterObj.support, ['char_ws_vp'], 'a field the editor knows nothing about is carried over too');
  });

  test('never adds a content entry the pack did not declare', async () => {
    // a pack with no `content` key at all
    assert.equal((await setSlot('bare-voice', { charId: 'char_ws_bare', slot: 'place', paths: ['voice/w.mp3'] })).status, 200);
    const bare = manifestOf('bare-voice');
    assert.equal(Object.hasOwn(bare, 'content'), false, 'the editor must not invent a data file for a voice-only pack');
    assert.deepEqual(bare.voices.char_ws_bare.place, ['voice/w.mp3']);

    // a pack with content keeps exactly what it declared
    assert.equal((await setSlot('spare-pack', { charId: 'char_ws_spare', slot: 'start', paths: ['voice/spare.mp3'] })).status, 200);
    assert.deepEqual(manifestOf('spare-pack').content, ['chess']);
  });
});

describe('workshop editor: 语音 (every refusal leaves the file untouched)', () => {
  /** Run one refusal against one pack and prove pack.json did not change by a single byte. */
  const refused = async (pack, body, expect, detail) => {
    const before = manifestText(pack);
    const res = await post(`${editor.url}/api/packs/${pack}/voices`, body);
    assert.equal(res.status, 400, `${detail}: got ${res.status}`);
    const { error } = await res.json();
    assert.ok(isChinese(error), `${detail}: the message must be usable in a Chinese UI, got "${error}"`);
    if (expect) assert.match(error, expect, detail);
    assert.equal(manifestText(pack), before, `${detail}: a refusal must not write`);
    return error;
  };

  test('the pack id, the operator id, the slot and the shape of paths are all checked', async () => {
    const bad = await setSlot('bad%20id!', { charId: 'c', slot: 'select', paths: [] });
    assert.equal(bad.status, 400);
    assert.ok(isChinese((await bad.json()).error));
    await refused('nope-pack', { charId: 'c', slot: 'select', paths: [] }, /不存在/, 'unknown pack');
    await refused('voice-pack', { charId: 'bad id!', slot: 'select', paths: [] }, /干员 id/, 'operator id charset');
    await refused('voice-pack', { charId: 'a'.repeat(65), slot: 'select', paths: [] }, /干员 id/, 'operator id length');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'chat', paths: [] }, /槽位/, 'unknown slot');
    const slotMsg = await refused('voice-pack', { charId: 'char_ws_vp', slot: 'chat', paths: [] }, /select/, 'the refusal names the slots that work');
    assert.match(slotMsg, /place/);
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: 'voice/select1.mp3' }, /数组/, 'paths must be an array');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select' }, /数组/, 'a missing paths is not an empty slot');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: [42] }, /不能作为语音路径/, 'a path must be a string');
  });

  test('a path must be relative, inside assets/, and free of traversal', async () => {
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['/abs.mp3'] }, /不能作为语音路径/, 'absolute');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice\\a.mp3'] }, /反斜杠/, 'backslash');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['C:/a.mp3'] }, /不能作为语音路径/, 'drive letter');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['../secret.mp3'] }, /不能作为语音路径/, '.. segment');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['./a.mp3'] }, /不能作为语音路径/, '. segment');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice//a.mp3'] }, /不能作为语音路径/, 'empty segment');
    // the one the media route would 404 on even though the file is there: a dot-leading segment is never served
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice/.secret.mp3'] }, /隐藏/, 'hidden segment');
  });

  test('the file must exist AND its extension must be one the pack-media route serves', async () => {
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice/nope.mp3'] }, /不存在/, 'missing file');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['notes.txt'] }, /允许的类型/, 'a .txt is not pack media');
    await refused('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice/script.js'] }, /允许的类型/, 'and a .js never is');
  });

  test('a pack with no assets/ folder cannot declare voices, and a broken manifest is not made worse', async () => {
    assert.equal(fs.existsSync(join(packDir('no-assets'), 'assets')), false);
    await refused('no-assets', { charId: 'c', slot: 'select', paths: ['voice/a.mp3'] }, /assets/, 'VOICE_NEEDS_ASSETS is refused before writing');
    // `locked` has assets but no license: writing a line would produce a manifest the loader rejects, so nothing is written
    const msg = await refused('locked', { charId: 'c', slot: 'select', paths: ['voice/a.mp3'] }, /license|拒绝/, 'ASSETS_NEED_LICENSE');
    assert.match(msg, /ASSETS_NEED_LICENSE/);
  });

  test('DELETE checks its path, its operator id and its slot', async () => {
    const before = manifestText('voice-pack');
    const cases = [
      ['/api/packs/voice-pack/voices/char_ws_vp/chat', 400, /槽位/],
      ['/api/packs/voice-pack/voices/bad%20id!/select', 400, /干员 id/],
      ['/api/packs/nope-pack/voices/char_ws_vp/select', 400, /不存在/],
      ['/api/packs/voice-pack/voices/char_ws_vp', 400, /路径/],
    ];
    for (const [path, status, expect] of cases) {
      const res = await fetch(editor.url + path, { method: 'DELETE' });
      assert.equal(res.status, status, path);
      const { error } = await res.json();
      assert.ok(isChinese(error), path);
      assert.match(error, expect, path);
      assert.equal(manifestText('voice-pack'), before, `${path} must not write`);
    }
  });
});

describe('workshop editor: 语音 到达客户端 (the editor API → the game client manifest)', () => {
  test('a line saved through the editor is in the merged assets.json the client reads', async () => {
    // leave the pack with exactly one line, so the assertion cannot pass on a stale file
    writeManifest('voice-pack', {
      id: 'voice-pack', name: '助战语音', version: '0.2.0', author: '水沫沐沐', license: 'CC0-1.0',
      description: '演示语音包', gameVersion: '0.1.3', content: ['chess'], overrides: ['chess:chess_char_1_01_a'],
    });
    const saved = await setSlot('voice-pack', { charId: 'char_ws_vp', slot: 'select', paths: ['voice/select1.mp3'] });
    assert.equal(saved.status, 200);

    // the game's OWN loader, over the same directory
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const pack = loaded.packs.find((p) => p.id === 'voice-pack');
    assert.ok(pack, `the pack must load: ${JSON.stringify(loaded.errors)}`);
    assert.deepEqual(pack.voices, { char_ws_vp: { select: ['voice/select1.mp3'] } });
    const URL = '/workshop-assets/voice-pack/voice/select1.mp3';

    // the index the overlay publishes into `assets.audio.voice`
    assert.deepEqual(workshopVoiceIndex(loaded.packs).char_ws_vp.select, [URL]);

    // and the merged manifest — once through loadData (what the server really does)…
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.ok(data.assets.audio.voice.char_ws_vp, 'the operator must appear in the client lookup');
    assert.deepEqual(data.assets.audio.voice.char_ws_vp.select, [URL]);
    // …and once by hand, on data with the overlay switched off, so this cannot be an accident of loadData
    const manual = applyWorkshop(loadData(DATA_DIR, { log: quiet, workshopDir: null }), loaded.packs);
    assert.deepEqual(manual.data.assets.audio.voice.char_ws_vp.select, [URL]);
    assert.equal(manual.report.voices['voice-pack'], 1, 'the pack is credited with exactly the line it declares');
    // the pack only brings audio: `assets` is the ONE data file the game server must serve merged for it
    assert.ok(workshopTouchedFiles(loaded).has('assets'));

    // and the URL is one the editor's own preview route really answers, with these very bytes
    const res = await fetch(editor.url + URL);
    assert.equal(res.status, 200, `${URL} must be playable on the page that wrote it`);
    assert.match(res.headers.get('content-type') || '', /audio\/mpeg/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
  });

  test('a voice-only pack (content: []) edited this way still loads and still reaches the client', async () => {
    assert.equal((await setSlot('voice-only', { charId: 'char_ws_vo', slot: 'resultThree', paths: ['voice/select1.mp3'] })).status, 200);
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const pack = loaded.packs.find((p) => p.id === 'voice-only');
    assert.ok(pack);
    assert.deepEqual(pack.files, {}, 'it still ships no data file at all');
    assert.deepEqual(pack.voices, { char_ws_vo: { select: ['voice/select1.mp3'], resultThree: ['voice/select1.mp3'] } });
    assert.deepEqual(loaded.errors.filter((e) => e.pack === 'voice-only'), [], 'editing must not break the pack');
    assert.deepEqual(manifestOf('voice-only').content, [], 'and must not hand it a content entry');
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.deepEqual(data.assets.audio.voice.char_ws_vo.resultThree, ['/workshop-assets/voice-only/voice/select1.mp3']);
  });
});

describe('workshop editor: 语音 (the preview route is narrow)', () => {
  test('it serves an audio file from a pack\'s assets/ — and nothing else', async () => {
    const base = `${editor.url}/workshop-assets/voice-pack`;
    const ok = await fetch(`${base}/voice/select1.mp3`);
    assert.equal(ok.status, 200);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), MP3);

    const head = await fetch(`${base}/voice/deploy1.ogg`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type') || '', /audio\/ogg/);

    const notFound = [
      `${base}/voice/cover.png`,            // real file, but not audio: the game serves it, the editor does not need to
      `${base}/voice/script.js`,            // never servable, here or in the game
      `${base}/notes.txt`,                  // not pack media at all
      `${base}/voice/.secret.mp3`,          // dot-segment: refused before the path is built
      `${base}/voice`,                      // a directory is not a listing
      `${base}/voice/`,                     // …not even with a trailing slash
      `${editor.url}/workshop-assets/nope-pack/voice/select1.mp3`,
      `${editor.url}/workshop-assets/voice-pack/voice/nope.mp3`,
      `${editor.url}/workshop-assets/voice-pack/voice/%2e%2e%2f%2e%2e%2fpack.json`,
    ];
    for (const url of notFound) {
      const res = await fetch(url);
      assert.equal(res.status, 404, `${url} must not be served`);
    }
    // pack.json itself is never on this route
    assert.equal((await fetch(editor.url + '/workshop-assets/voice-pack/pack.json')).status, 404);
  });

  test('the old mounts still behave — the voice route did not shadow the editor or the game art', async () => {
    assert.equal((await fetch(`${editor.url}/voice.html`)).status, 200);
    assert.equal((await fetch(`${editor.url}/voice.js`)).status, 200);
    assert.equal((await fetch(`${editor.url}/api/voices`)).status, 200);
  });
});

describe('workshop editor: 语音 (the page itself)', () => {
  test('the voice page is part of the editor, and every page links to every other one', async () => {
    const html = await fetch(`${editor.url}/voice.html`).then((r) => r.text());
    assert.match(html, /工坊语音编辑器/);
    assert.equal((await fetch(`${editor.url}/voice.js`)).status, 200);
    const pages = ['index.html', 'stage.html', 'enemy.html', 'wave.html', 'item.html', 'kit.html'];
    for (const page of pages) {
      const other = await fetch(`${editor.url}/${page}`).then((r) => r.text());
      assert.match(other, /voice\.html/, `${page} must link to the voice page`);
    }
    for (const page of pages) assert.match(html, new RegExp(`\\./${page.replace('.', '\\.')}`), `voice.html must link to ${page}`);
  });

  test('the page renders the slots and the extensions from the API instead of keeping its own list', async () => {
    const src = await fetch(`${editor.url}/voice.js`).then((r) => r.text());
    // the slot vocabulary and the media allowlist are SERVER rules: a second copy on the page is a line that saves here
    // and silently never plays in the game
    assert.match(src, /state\.data\.slots/, 'the slot list comes from the API');
    assert.match(src, /audioExtensions/, 'so does the extension list');
    assert.match(src, /mediaPrefix/, 'and the preview URL prefix — a preview URL is the production URL');
    assert.doesNotMatch(src, /\[\s*'start'/, 'no page-local slot list');
    assert.doesNotMatch(src, /'\.mp3'/, 'no page-local extension list');
  });
});
