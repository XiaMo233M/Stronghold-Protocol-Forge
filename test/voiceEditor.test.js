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
import { VOICE_SLOTS, VOICE_LANGS, DEFAULT_VOICE_LANG } from '../shared/constants.js';
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

/**
 * 一个已经声明了默认配音 + 两种非默认配音（jp / kr）的包，给「按语种声明」那一段用。
 * 写回它自己那份清单：那一段会改 voiceLangs，别的用例不该被上一个用例写下的状态影响。
 */
function writeMultiLang() {
  fs.mkdirSync(packDir('multi-lang'), { recursive: true });
  writeManifest('multi-lang', {
    id: 'multi-lang', name: '多语言配音', version: '0.2.0', license: 'CC0-1.0',
    content: ['chess'], support: ['char_ws_ml'],
    voices: { char_ws_ml: { select: ['voice/cn1.mp3'] } },
    voiceLangs: {
      jp: { char_ws_ml: { select: ['voice/jp1.mp3'], place: ['voice/jp2.mp3'] } },
      kr: { char_ws_ml: { start: ['voice/kr1.mp3'] } },
    },
  });
  writeAsset('multi-lang', 'voice/cn1.mp3', MP3);
  writeAsset('multi-lang', 'voice/jp1.mp3', MP3);
  writeAsset('multi-lang', 'voice/jp2.mp3', OGG);
  writeAsset('multi-lang', 'voice/kr1.mp3', MP3);
}

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

  // 7) 包内按语种声明的配音（`voiceLangs`）：默认配音 cn + jp / kr 两份
  writeMultiLang();

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
    // 配音语言也只有一份：语言选择里能出现的语种就是加载器认的那些，默认配音也一起给（页面对比着看）
    assert.deepEqual(r.langs, [...VOICE_LANGS]);
    assert.equal(r.defaultLang, DEFAULT_VOICE_LANG);
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

describe('workshop editor: 语音 按语种声明 (voiceLangs)', () => {
  /** 这个包自己的清单：这一段会改它，所以每个用例开测先写回已知状态。 */
  const manifestOfMulti = () => JSON.parse(fs.readFileSync(join(packDir('multi-lang'), 'pack.json'), 'utf8'));
  const setSlotLang = (body) => post(`${editor.url}/api/packs/multi-lang/voices`, body);
  /** 都是这一个干员、这几个槽位，免得每条断言里重复一遍。 */
  const ML = 'char_ws_ml';

  test('GET /api/voices 把已有的 voiceLangs 交回给页面（?pack= 也一样）', async () => {
    writeMultiLang();
    const r = await fetch(`${editor.url}/api/voices?pack=multi-lang`).then((x) => x.json());
    const p = r.packs[0];
    assert.equal(p.ok, true, JSON.stringify(p.issue));
    assert.deepEqual(p.voices, { [ML]: { select: ['voice/cn1.mp3'] } }, '默认配音照旧在 voices 里');
    assert.deepEqual(p.voiceLangs, {
      jp: { [ML]: { place: ['voice/jp2.mp3'], select: ['voice/jp1.mp3'] } },
      kr: { [ML]: { start: ['voice/kr1.mp3'] } },
    }, '打开一个已经有 voiceLangs 的包，这些语种就要显示出来');
    assert.equal(Object.hasOwn(p.voiceLangs, DEFAULT_VOICE_LANG), false, '默认配音不是 voiceLangs 的一个语种');
  });

  test('语言选择：非默认语种写进 voiceLangs，默认配音那一路一个字节都不碰', async () => {
    writeMultiLang();
    const jp = await setSlotLang({ charId: ML, slot: 'skill1', paths: ['voice/jp1.mp3', 'voice/jp1.mp3'], lang: 'jp' });
    assert.equal(jp.status, 200, JSON.stringify(await jp.clone().json()));
    const body = await jp.json();
    assert.equal(body.lang, 'jp');
    assert.deepEqual(body.paths, ['voice/jp1.mp3'], '跟默认配音一样：同一个槽位存起来是排序去重的');
    const doc = manifestOfMulti();
    assert.deepEqual(doc.voiceLangs.jp[ML].skill1, ['voice/jp1.mp3'], '写进的是选中的那份语种表');
    assert.deepEqual(doc.voiceLangs.kr, { [ML]: { start: ['voice/kr1.mp3'] } }, '别的语种原样不动');
    assert.deepEqual(doc.voices, { [ML]: { select: ['voice/cn1.mp3'] } }, '默认配音（voices）没被这条改动碰到');
    assert.deepEqual(body.voices, doc.voices, '回话里两份表都带回来，页面不必再猜');

    // 默认配音那一路（lang 省略、或显式给默认配音）写的还是 voices
    assert.equal((await setSlotLang({ charId: ML, slot: 'place', paths: ['voice/cn1.mp3'] })).status, 200);
    assert.equal((await setSlotLang({ charId: ML, slot: 'place', paths: ['voice/kr1.mp3'], lang: DEFAULT_VOICE_LANG })).status, 200);
    const after = manifestOfMulti();
    assert.deepEqual(after.voices[ML].place, ['voice/kr1.mp3']);
    assert.deepEqual(after.voiceLangs.jp[ML].place, ['voice/jp2.mp3'], '默认那一路不许改动 jp 的 place');
  });

  test('一份语种表空了就整块消失：不留空的 voiceLangs[lang]，也不留空的 voiceLangs', async () => {
    writeMultiLang();
    // 删掉 jp 的一个槽位：jp 还有别的槽位，所以只掉那一条
    const one = await fetch(`${editor.url}/api/packs/multi-lang/voices/${ML}/select?lang=jp`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(one.removed, true);
    assert.equal(one.lang, 'jp');
    assert.equal(Object.hasOwn(manifestOfMulti().voiceLangs.jp[ML], 'select'), false);
    assert.deepEqual(manifestOfMulti().voiceLangs.jp[ML].place, ['voice/jp2.mp3'], '同一语种别的槽位还在');

    // 空清单同样只删那一个槽位，然后整块 kr 消失
    assert.equal((await setSlotLang({ charId: ML, slot: 'start', paths: [], lang: 'kr' })).status, 200);
    assert.equal(Object.hasOwn(manifestOfMulti().voiceLangs, 'kr'), false, '语种表空了就不该留下空对象');
    assert.equal(Object.hasOwn(manifestOfMulti().voiceLangs, 'jp'), true, '只剩一个语种时 voiceLangs 还在');

    // 最后一个语种也没了就整块删掉 voiceLangs
    assert.equal((await setSlotLang({ charId: ML, slot: 'place', paths: [], lang: 'jp' })).status, 200);
    const doc = manifestOfMulti();
    assert.equal(Object.hasOwn(doc, 'voiceLangs'), false, '没有任何语种表了就连 voiceLangs 一起删掉');
    assert.deepEqual(doc.voices, { [ML]: { select: ['voice/cn1.mp3'] } }, '默认配音完好');

    // 幂等：再删一次不写文件、也不报错
    const again = await fetch(`${editor.url}/api/packs/multi-lang/voices/${ML}/place?lang=jp`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(again.removed, false);
  });

  test('同一个干员在两种语种里各有一条，互不影响；增删只动选中的那一份', async () => {
    writeMultiLang();
    assert.equal((await setSlotLang({ charId: ML, slot: 'skill2', paths: ['voice/jp1.mp3'], lang: 'jp' })).status, 200);
    const doc = manifestOfMulti();
    assert.deepEqual(doc.voiceLangs.jp[ML].skill2, ['voice/jp1.mp3']);
    assert.deepEqual(doc.voiceLangs.kr, { [ML]: { start: ['voice/kr1.mp3'] } });
    assert.deepEqual(doc.voices, { [ML]: { select: ['voice/cn1.mp3'] } });
    assert.deepEqual(Object.keys(doc.voiceLangs.jp[ML]).sort(), ['place', 'select', 'skill2'], '同一语种里的槽位各自独立');
  });

  test('语种必须是 VOICE_LANGS 里的一员，而且拒绝时一个字节都不写', async () => {
    writeMultiLang();
    const before = manifestText('multi-lang');
    // 客户端的语言选择里只有合法语种，但接口自己也得挡住：非法语种写出去就是加载器拒绝的包
    const res = await post(`${editor.url}/api/packs/multi-lang/voices`, { charId: ML, slot: 'select', paths: ['voice/jp1.mp3'], lang: 'ko' });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.ok(isChinese(error), `拒绝信息要给中文界面看，得到 "${error}"`);
    assert.match(error, /VOICE_LANG_UNKNOWN/);
    for (const l of VOICE_LANGS) assert.match(error, new RegExp(l), `拒绝时要列出可用的配音（缺 ${l}）`);
    assert.equal(manifestText('multi-lang'), before, '拒绝必须什么都不写');
  });

  test('默认配音是 voices 那一份，不是 voiceLangs 的一个键', async () => {
    writeMultiLang();
    // ?lang=cn 与不带 ?lang= 是同一件事：删的、写的是 voices 里那一份，绝不是 voiceLangs["cn"]（加载器会报 VOICE_LANG_DEFAULT）
    const del = await fetch(`${editor.url}/api/packs/multi-lang/voices/${ML}/place?lang=${DEFAULT_VOICE_LANG}`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.removed, false, 'voices 里本来就没有这个槽位');
    assert.equal(del.lang, DEFAULT_VOICE_LANG);
    assert.equal(Object.hasOwn(manifestOfMulti().voiceLangs, DEFAULT_VOICE_LANG), false, '默认配音永远不会长出一个 voiceLangs 键');

    // 与加载器同一条规则：清单里真写了 voiceLangs["cn"]，界面必须看得出来这个包会被拒（VOICE_LANG_DEFAULT）
    writeMultiLang();
    const doc = manifestOfMulti();
    doc.voiceLangs[DEFAULT_VOICE_LANG] = { [ML]: { start: ['voice/cn1.mp3'] } };
    writeManifest('multi-lang', doc);
    const r = await fetch(`${editor.url}/api/voices?pack=multi-lang`).then((x) => x.json());
    assert.equal(r.packs[0].ok, false);
    assert.equal(r.packs[0].issue.code, 'VOICE_LANG_DEFAULT');
    assert.equal(Object.hasOwn(r.packs[0].voiceLangs, DEFAULT_VOICE_LANG), false, '页面只把默认配音显示为 voices 那一份');
    writeMultiLang();
  });

  test('语种表里的路径与槽位跟默认配音守同一套规则', async () => {
    writeMultiLang();
    const before = manifestText('multi-lang');
    const refused = async (paths, expect, detail) => {
      const res = await post(`${editor.url}/api/packs/multi-lang/voices`, { charId: ML, slot: 'select', paths, lang: 'jp' });
      assert.equal(res.status, 400, `${detail}: got ${res.status}`);
      const { error } = await res.json();
      assert.ok(isChinese(error), detail);
      assert.match(error, expect, detail);
      assert.equal(manifestText('multi-lang'), before, `${detail}: 拒绝必须什么都不写`);
    };
    await refused(['../secret.mp3'], /不能作为语音路径/, '穿越');
    await refused(['voice/nope.mp3'], /不存在/, '文件必须真的存在');
    await refused(['notes.txt'], /允许的类型/, '扩展名要在包内媒体允许的类型里');
    await refused([42], /不能作为语音路径/, '路径必须是字符串');
    // 空数组不是「空语种表」而是「删掉这个槽位」：jp 里本来没有这个槽位，等于无操作
    const empty = await setSlotLang({ charId: ML, slot: 'skill3', paths: [], lang: 'jp' });
    assert.equal(empty.status, 200);
    assert.equal(manifestOfMulti().voiceLangs.jp[ML].skill3, undefined, '空清单不会凭空造出一个槽位');
    // 非法槽位在哪一份语种表里都被拒
    const badSlot = await post(`${editor.url}/api/packs/multi-lang/voices`, { charId: ML, slot: 'chat', paths: ['voice/jp1.mp3'], lang: 'jp' });
    assert.equal(badSlot.status, 400);
    assert.match((await badSlot.json()).error, /槽位/);
  });

  test('无损往返：只写作者真正声明过的语种，清单里其它字段与缩进原样保留', async () => {
    writeMultiLang();
    const before = manifestText('multi-lang');
    const beforeObj = JSON.parse(before);
    assert.equal((await setSlotLang({ charId: ML, slot: 'resultThree', paths: ['voice/jp2.mp3'], lang: 'jp' })).status, 200);
    const after = manifestText('multi-lang');
    const afterObj = JSON.parse(after);
    const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'voiceLangs'));
    assert.deepEqual(strip(afterObj), strip(beforeObj), 'voiceLangs 之外的字段一个都不许动');
    assert.deepEqual(Object.keys(afterObj).filter((k) => k !== 'voiceLangs'), Object.keys(beforeObj).filter((k) => k !== 'voiceLangs'), '包括作者写下的键顺序');
    assert.equal(after.endsWith('}\n'), true, '还有结尾换行');
    assert.deepEqual(afterObj.voiceLangs.kr, { [ML]: { start: ['voice/kr1.mp3'] } }, '没被编辑的语种逐字没变');
    assert.deepEqual(afterObj.voices, beforeObj.voices, '默认配音逐字没变');

    // 再打开一次：页面上看到的就是刚写下的东西（打开 → 保存 → 再打开是同一份表）
    const r = await fetch(`${editor.url}/api/voices?pack=multi-lang`).then((x) => x.json());
    assert.deepEqual(r.packs[0].voiceLangs, afterObj.voiceLangs);
    assert.equal(Object.hasOwn(r.packs[0].voiceLangs, DEFAULT_VOICE_LANG), false);
  });

  test('一个包只声明自己那几条：三种表各读各的，谁也不串到谁', async () => {
    writeMultiLang();
    const r = await fetch(`${editor.url}/api/voices?pack=multi-lang`).then((x) => x.json());
    const p = r.packs[0];
    assert.deepEqual(Object.keys(p.voiceLangs.jp[ML]).sort(), ['place', 'select']);
    assert.deepEqual(Object.keys(p.voices[ML]), ['select']);
    assert.deepEqual(Object.keys(p.voiceLangs.kr[ML]), ['start']);
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

  test('一条按语种保存的台词，走进客户端读的那份合并清单的 audio.voiceLangs[lang]', async () => {
    // 这个包只有一份非默认配音：语言选择里选它，加一条，然后交给游戏自己的加载器
    writeManifest('multi-lang', {
      id: 'multi-lang', name: '多语言配音', version: '0.2.0', license: 'CC0-1.0',
      content: ['chess'], support: ['char_ws_ml'],
      voiceLangs: { jp: { char_ws_ml: { select: ['voice/jp1.mp3'] } } },
    });
    assert.equal((await post(`${editor.url}/api/packs/multi-lang/voices`, { charId: 'char_ws_ml', slot: 'place', paths: ['voice/jp2.mp3'], lang: 'jp' })).status, 200);

    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const pack = loaded.packs.find((p) => p.id === 'multi-lang');
    assert.ok(pack, `the pack must load: ${JSON.stringify(loaded.errors)}`);
    assert.deepEqual(pack.voiceLangs, { jp: { char_ws_ml: { place: ['voice/jp2.mp3'], select: ['voice/jp1.mp3'] } } }, '加载器读到的就是编辑器写下的那份表');
    // 这个包没有默认配音，所以它只碰 voiceLangs 那一半，`voices` 不该凭空长出来
    assert.deepEqual(pack.voices, {});

    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    const jpUrl = '/workshop-assets/multi-lang/voice/jp2.mp3';
    assert.deepEqual(data.assets.audio.voiceLangs.jp.char_ws_ml.place, [jpUrl], '客户端按语种取台词的那张表里有它');
    assert.equal(Object.hasOwn(data.assets.audio.voice, 'char_ws_ml'), false, '默认配音那份表没被污染');

    // 试听 URL 与客户端读的是同一条通路，而且这些字节真的取得回来
    const res = await fetch(editor.url + jpUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), OGG);
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
    // 语种也一样：候选来自 shared/constants.js（页面 import 它），页面上不再留一份自己抄的清单
    assert.match(src, /VOICE_LANGS/, 'the language list comes from the shared constants');
    assert.match(src, /DEFAULT_VOICE_LANG/, 'and so does the default dub');
  });
});
