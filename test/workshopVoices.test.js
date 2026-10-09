// The WORKSHOP half of the voice interface (docs/ASSETS.md "Voice lines", docs/WORKSHOP.md §1.4): a pack may declare
// voice lines for its own — or its 助战 — operators, as `voices: { <charId>: { <slot>: ["<path inside assets/>", …] } }`.
// This file pins the RESERVATION and its DELIVERY: what a pack is allowed to say, every way the manifest validator
// refuses it, and how those lines reach the client's lookup.
//
// The files live under the pack's `assets/` subtree, so the existing licence gate covers them (a pack with art must
// declare `license`) and the client reads them from `/workshop-assets/<pack>/<path>` — the only route that serves pack
// media. Delivery is deliberately indirect: the overlay merges the lines into `assets.audio.voice`
// (shared/workshop.js mergeWorkshopVoices), the game server serves that file MERGED, and public/js/audio.js already
// reads it through `getManifest()`. No new client channel, and no client change at all.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { normalizePackManifest, applyWorkshop, workshopVoiceIndex, workshopVoiceLangIndex, workshopSummary } from '../shared/workshop.js';
import { VOICE_SLOTS, VOICE_LANGS, DEFAULT_VOICE_LANG } from '../shared/constants.js';
import { voiceLinesFor } from '../public/js/audio.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';

const norm = (extra = {}, opts = { hasAssets: true }) => normalizePackManifest(
  { id: 'my-pack', content: ['chess'], license: 'CC0-1.0', ...extra }, 'my-pack', opts);
/** Refusal assertions read the module's own shape ({ ok: false, error, detail }). */
const refused = (extra, opts, error) => {
  const r = norm(extra, opts);
  assert.equal(r.ok, false, `${error}: expected a refusal`);
  assert.equal(r.error, error, `${error}: got ${r.error} (${r.detail})`);
  return r;
};

describe('workshop voice packs (预留的助战语音包)', () => {
  test('an operator declares lines per slot; the paths stay relative to assets/', () => {
    const r = norm({ voices: { char_ws_a: { select: ['voice/char_ws_a/select1.mp3'], place: ['voice/char_ws_a/place1.mp3', 'voice/char_ws_a/place2.mp3'] } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.voices, {
      char_ws_a: { select: ['voice/char_ws_a/select1.mp3'], place: ['voice/char_ws_a/place1.mp3', 'voice/char_ws_a/place2.mp3'] },
    });
  });

  test('no declaration → an empty map (never undefined), and the pack still loads', () => {
    assert.deepEqual(norm().pack.voices, {});
    assert.equal(norm().ok, true);
  });

  test('the slot vocabulary is the ONE shared list (client, asset pipeline and this validator read it)', () => {
    assert.deepEqual([...VOICE_SLOTS], ['start', 'faceEnemy', 'select', 'place', 'skill1', 'skill2', 'skill3', 'skill4', 'resultFour', 'resultThree', 'resultTwo', 'resultLose']);
    for (const slot of VOICE_SLOTS) {
      assert.equal(norm({ voices: { c: { [slot]: ['v.mp3'] } } }).ok, true, slot);
    }
    const bad = refused({ voices: { c: { chat: ['v.mp3'] } } }, { hasAssets: true }, 'VOICE_SLOT_UNKNOWN');
    assert.match(bad.detail, /select/, 'the refusal names the slots that would have worked');
  });

  test('a single path may be written as a string; duplicates collapse', () => {
    const r = norm({ voices: { c: { place: 'v.mp3' } } });
    assert.deepEqual(r.pack.voices, { c: { place: ['v.mp3'] } });
    assert.deepEqual(norm({ voices: { c: { place: ['a.mp3', 'a.mp3', 'b.mp3'] } } }).pack.voices.c.place, ['a.mp3', 'b.mp3']);
  });

  test('every way a declaration is refused', () => {
    const cases = [
      [{ voices: { c: { place: ['../secret.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { place: ['/abs.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { place: ['a\\b.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { place: ['C:/abs.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { place: [] } } }, { hasAssets: true }, 'VOICE_EMPTY'],
      [{ voices: { c: { place: ['./ok.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { place: ['ok.mp3'] } } }, { hasAssets: false }, 'VOICE_NEEDS_ASSETS'],
      [{ voices: [] }, { hasAssets: true }, 'VOICE_BAD_SHAPE'],
      [{ voices: { 'bad id!': { place: ['ok.mp3'] } } }, { hasAssets: true }, 'VOICE_BAD_CHAR_ID'],
      [{ voices: { c: 'place.mp3' } }, { hasAssets: true }, 'VOICE_BAD_SHAPE'],
    ];
    for (const [extra, opts, error] of cases) refused(extra, opts, error);
  });

  test('the licence gate comes first: a pack with art and no licence never reaches the voice check', () => {
    const r = normalizePackManifest({ id: 'my-pack', content: ['chess'], voices: { c: { place: ['ok.mp3'] } } }, 'my-pack', { hasAssets: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ASSETS_NEED_LICENSE', 'pack media — audio included — is the pack author to license');
  });

  test('a pack whose ONLY contribution is voice lines is a pack (content may be empty)', () => {
    const r = normalizePackManifest(
      { id: 'char-voice', content: [], license: 'CC0-1.0', voices: { char_ws_v: { select: ['voice/v/1.mp3'], resultThree: ['voice/v/w.mp3'] } } },
      'char-voice', { hasAssets: true });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.content, []);
    assert.deepEqual(Object.keys(r.pack.voices), ['char_ws_v']);
    // ...but a pack that brings NOTHING is still refused, whichever way it is empty
    assert.equal(normalizePackManifest({ id: 'x', content: [] }, 'x').error, 'EMPTY_PACK');
    assert.equal(normalizePackManifest({ id: 'x', content: [], voices: {} }, 'x').error, 'EMPTY_PACK');
  });
});

/** A loaded-pack stand-in: only the fields the voice index and the overlay read. */
const pack = (id, voices) => ({ id, name: id, voices, files: {} });

// ── 包内多语言配音 (v0.7.3) ───────────────────────────────────────────────────────────────────────────────────────
// `voices` is the pack's lines in the install's DEFAULT dub (Japanese, shared/constants.js DEFAULT_VOICE_LANG);
// `voiceLangs` is the same table once per OTHER dub, so an author can ship, say, a Chinese take on an operator the
// install plays in Japanese. The shape, the path rules
// and the slot vocabulary are `voices`' own (one parseVoiceTable, one set of error codes) — the delivery differs in
// exactly one place, and it is the place the player's 配音语言 setting reads: the default table is `audio.voice`, an
// extra dub is `audio.voiceLangs[lang]` (public/js/audio.js voiceLinesFor picks between them at play time).
describe('工坊语音: 多语言配音 (pack.json.voiceLangs)', () => {
  test('一个非默认语种一张表，形状、去重与排序与 voices 逐字相同', () => {
    const r = norm({
      voices: { char_ws_a: { select: ['voice/a/jp_select.mp3'] } },
      voiceLangs: { cn: { char_ws_a: { select: 'voice/a/cn_select.mp3', place: ['voice/a/cn_p2.mp3', 'voice/a/cn_p1.mp3', 'voice/a/cn_p1.mp3'] } } },
    });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.voices, { char_ws_a: { select: ['voice/a/jp_select.mp3'] } });
    assert.deepEqual(r.pack.voiceLangs, {
      cn: { char_ws_a: { select: ['voice/a/cn_select.mp3'], place: ['voice/a/cn_p1.mp3', 'voice/a/cn_p2.mp3'] } },
    }, 'a single path may be a bare string here too, and the file list is deduped and sorted');
  });

  test('没有声明 → 空表（绝不留 undefined），包照常加载', () => {
    assert.deepEqual(norm().pack.voiceLangs, {});
  });

  test('默认语种键被拒：那批台词属于 voices', () => {
    const r = refused({ voiceLangs: { [DEFAULT_VOICE_LANG]: { c: { place: ['v.mp3'] } } } }, { hasAssets: true }, 'VOICE_LANG_DEFAULT');
    assert.match(r.detail, /voices/, 'the refusal says where the default dub belongs');
  });

  test('语种表按 VOICE_LANGS 归位，与作者书写顺序无关', () => {
    const r = norm({ content: [], voiceLangs: { kr: { c: { place: ['k.mp3'] } }, cn: { c: { place: ['c.mp3'] } } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(Object.keys(r.pack.voiceLangs), VOICE_LANGS.filter((l) => l === 'cn' || l === 'kr'));
  });

  test('语种表里每一条拒绝都与 voices 同一套错误码，且提示指到具体那张表', () => {
    const cases = [
      [{ voiceLangs: [] }, 'VOICE_LANG_BAD_SHAPE'],
      [{ voiceLangs: { cn: [] } }, 'VOICE_BAD_SHAPE'],
      [{ voiceLangs: { xx: { c: { place: ['v.mp3'] } } } }, 'VOICE_LANG_UNKNOWN'],
      [{ voiceLangs: { cn: {} } }, 'VOICE_LANG_EMPTY'],
      [{ voiceLangs: { cn: { c: { place: ['../x.mp3'] } } } }, 'VOICE_PATH_UNSAFE'],
      [{ voiceLangs: { cn: { c: { place: ['a\\b.mp3'] } } } }, 'VOICE_PATH_UNSAFE'],
      [{ voiceLangs: { cn: { c: { place: [] } } } }, 'VOICE_EMPTY'],
      [{ voiceLangs: { cn: { c: { chat: ['v.mp3'] } } } }, 'VOICE_SLOT_UNKNOWN'],
      [{ voiceLangs: { cn: { 'bad id!': { place: ['v.mp3'] } } } }, 'VOICE_BAD_CHAR_ID'],
    ];
    for (const [extra, error] of cases) {
      const r = refused(extra, { hasAssets: true }, error);
      if (!/LANG/.test(error)) assert.match(r.detail, /voiceLangs\["cn"\]/, `${error} 的提示要指到具体那张表`);
    }
    refused({ voiceLangs: { cn: { c: { place: ['v.mp3'] } } } }, { hasAssets: false }, 'VOICE_NEEDS_ASSETS');
  });

  test('授权闸门同样在前面：有 assets/ 却没 license 的包先被拒', () => {
    const r = normalizePackManifest({ id: 'my-pack', content: [], voiceLangs: { cn: { c: { place: ['ok.mp3'] } } } }, 'my-pack', { hasAssets: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ASSETS_NEED_LICENSE', 'pack media — audio included — is the pack author to license');
  });

  test('只带其它语种的包也是包（content 可以为空）', () => {
    const r = norm({ content: [], voiceLangs: { en: { char_ws_v: { resultThree: ['voice/v/en.mp3'] } } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.content, []);
    assert.deepEqual(r.pack.voices, {}, 'default-dub table stays empty — this pack has no jp line');
    // ...but an EMPTY language table is not a contribution
    assert.equal(norm({ content: [], voiceLangs: {} }).error, 'EMPTY_PACK');
  });
});

describe('工坊语音: 汇总与并表 (the index and the overlay merge)', () => {
  const BASE = {
    assets: {
      ui: { 'emoticon/basic': { x: '/assets/ui/x.png' } },
      audio: {
        sfx: { ui: { click: '/assets/sfx/click.mp3' } },
        voice: { char_1012_skadi2: { select: ['/assets/voice/skadi2/select1.mp3'] } },
      },
    },
  };

  test('the index holds exactly the URLs the media route answers, percent-encoded', () => {
    const index = workshopVoiceIndex([pack('a-pack', { char_ws_a: { place: ['voice/a#b c.mp3', 'voice/plain.mp3'] } })]);
    assert.deepEqual(index, {
      char_ws_a: { place: ['/workshop-assets/a-pack/voice/a%23b%20c.mp3', '/workshop-assets/a-pack/voice/plain.mp3'] },
    });
    // no packs / a pack with no voices → an empty map, never null
    assert.deepEqual(workshopVoiceIndex([]), {});
    assert.deepEqual(workshopVoiceIndex([pack('x', {})]), {});
  });

  test('several packs merge in pack-id order, whatever order they were loaded in', () => {
    const b = pack('b-pack', { c: { select: ['b.mp3'] } });
    const a = pack('a-pack', { c: { select: ['a.mp3'] } });
    assert.deepEqual(workshopVoiceIndex([b, a]).c.select, ['/workshop-assets/a-pack/a.mp3', '/workshop-assets/b-pack/b.mp3']);
    assert.deepEqual(workshopVoiceIndex([b, a]), workshopVoiceIndex([a, b]));
  });

  test('the overlay APPENDS pack lines to the manifest the client reads, and reports them', () => {
    const { data, report } = applyWorkshop(BASE, [pack('v-pack', {
      char_1012_skadi2: { select: ['voice/alt.mp3'] },
      char_ws_new: { resultThree: ['voice/w.mp3'], resultLose: ['voice/l.mp3'] },
    })]);
    assert.deepEqual(data.assets.audio.voice.char_1012_skadi2.select,
      ['/assets/voice/skadi2/select1.mp3', '/workshop-assets/v-pack/voice/alt.mp3'],
      'an operator the official data already has keeps its own lines and gains the pack\'s');
    assert.deepEqual(data.assets.audio.voice.char_ws_new, {
      resultThree: ['/workshop-assets/v-pack/voice/w.mp3'],
      resultLose: ['/workshop-assets/v-pack/voice/l.mp3'],
    }, 'a 助战 operator the pack adds has no official lines to keep');
    // nothing else of assets.json is touched, and the input is never mutated
    assert.deepEqual(data.assets.ui, BASE.assets.ui);
    assert.deepEqual(data.assets.audio.sfx, BASE.assets.audio.sfx);
    assert.deepEqual(BASE.assets.audio.voice.char_1012_skadi2.select, ['/assets/voice/skadi2/select1.mp3']);
    assert.deepEqual(report.voices, { 'v-pack': 3 });
    assert.match(workshopSummary(report), /3 voice lines/);
  });

  test('语种索引：一个语种一张表，键序跟着 VOICE_LANGS 而不是包加载顺序', () => {
    const a = { id: 'a-pack', name: 'a', files: {}, voiceLangs: { cn: { c: { select: ['a-cn.mp3'] } } } };
    const b = { id: 'b-pack', name: 'b', files: {}, voiceLangs: { kr: { c: { select: ['b-kr.mp3'] } }, cn: { c: { select: ['b-cn.mp3'] } } } };
    assert.deepEqual(workshopVoiceLangIndex([b, a]), {
      cn: { c: { select: ['/workshop-assets/a-pack/a-cn.mp3', '/workshop-assets/b-pack/b-cn.mp3'] } },
      kr: { c: { select: ['/workshop-assets/b-pack/b-kr.mp3'] } },
    });
    assert.deepEqual(workshopVoiceLangIndex([b, a]), workshopVoiceLangIndex([a, b]));
    // 默认配音不在里面（它就是 voices 本身）；没有任何语种声明时也不给空表
    assert.deepEqual(workshopVoiceLangIndex([pack('x', { c: { select: ['x.mp3'] } })]), {});
    assert.deepEqual(workshopVoiceLangIndex([]), {});
  });

  test('语种索引只挑那一张表，不混入默认配音', () => {
    const p = { id: 'p', name: 'p', files: {}, voices: { c: { select: ['jp.mp3'] } }, voiceLangs: { cn: { c: { select: ['cn.mp3'] } } } };
    assert.deepEqual(workshopVoiceIndex([p], { lang: 'cn' }), { c: { select: ['/workshop-assets/p/cn.mp3'] } });
    assert.deepEqual(workshopVoiceIndex([p], { lang: 'en' }), {}, '没有这一档就是空');
    assert.deepEqual(workshopVoiceIndex([p]), { c: { select: ['/workshop-assets/p/jp.mp3'] } }, '不传 lang 就是默认配音');
  });

  test('并表：默认配音进 audio.voice，其它语种进 audio.voiceLangs[lang]', () => {
    const { data, report } = applyWorkshop(BASE, [{
      id: 'v-pack', name: 'v', files: {},
      voices: { char_1012_skadi2: { select: ['voice/jp.mp3'] } },
      voiceLangs: { cn: { char_1012_skadi2: { select: ['voice/cn.mp3'] } }, kr: { char_ws_new: { resultLose: ['voice/kr.mp3'] } } },
    }]);
    assert.deepEqual(data.assets.audio.voice.char_1012_skadi2.select,
      ['/assets/voice/skadi2/select1.mp3', '/workshop-assets/v-pack/voice/jp.mp3']);
    assert.deepEqual(data.assets.audio.voiceLangs, {
      cn: { char_1012_skadi2: { select: ['/workshop-assets/v-pack/voice/cn.mp3'] } },
      kr: { char_ws_new: { resultLose: ['/workshop-assets/v-pack/voice/kr.mp3'] } },
    });
    assert.deepEqual(report.voices, { 'v-pack': 1 });
    assert.deepEqual(report.voiceLangs, { 'v-pack': { cn: 1, kr: 1 } });
    assert.match(workshopSummary(report), /1 voice line \(cn 1, kr 1\)/);
    assert.equal(BASE.assets.audio.voiceLangs, undefined, 'the input is never mutated');
  });

  test('官方已有的 voiceLangs 条目被追加而不是替换；没有包声明语种时绝不写出空表', () => {
    const base = { assets: { audio: { voiceLang: 'jp', voice: {}, voiceLangs: { cn: { char_1012_skadi2: { select: '/assets/voice/cn/s1.mp3' } } } } } };
    const { data } = applyWorkshop(base, [{ id: 'v-pack', name: 'v', files: {}, voiceLangs: { cn: { char_1012_skadi2: { select: ['voice/cn.mp3'] } } } }]);
    assert.deepEqual(data.assets.audio.voiceLangs.cn.char_1012_skadi2.select,
      ['/assets/voice/cn/s1.mp3', '/workshop-assets/v-pack/voice/cn.mp3'],
      '官方那句是字符串：必须先归一化成数组再追加');
    assert.equal(base.assets.audio.voiceLangs.cn.char_1012_skadi2.select, '/assets/voice/cn/s1.mp3', 'the input is never mutated');
    // ...and a pack that declares only `voices` must not make the manifest grow an empty voiceLangs
    const only = applyWorkshop(BASE, [pack('v-pack', { c: { place: ['v.mp3'] } })]);
    assert.equal('voiceLangs' in only.data.assets.audio, false);
  });

  test('只带其它语种的包在缺 audio 清单时也会被报告（不是静默丢弃）', () => {
    const { report } = applyWorkshop({}, [{ id: 'v-pack', name: 'v', files: {}, voiceLangs: { cn: { c: { place: ['v.mp3'] } } } }]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].pack, 'v-pack');
    assert.match(report.errors[0].reason, /assets\.json/);
  });

  test('an install without an audio manifest is REPORTED, not silently dropped', () => {
    const { data, report } = applyWorkshop({}, [pack('v-pack', { c: { place: ['v.mp3'] } })]);
    assert.equal(data.assets, undefined, 'there is nowhere to publish to');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].pack, 'v-pack');
    assert.equal(report.errors[0].file, 'assets');
    assert.match(report.errors[0].reason, /assets\.json/);
  });

  test('a pack with no voices changes neither the data nor the summary wording', () => {
    const { data, report } = applyWorkshop(BASE, [{ id: 'x', name: 'X', files: {} }]);
    assert.equal(report.voices, undefined);
    assert.deepEqual(data.assets, BASE.assets);
    assert.match(workshopSummary(report), /X\(x\): nothing/);
  });
});

describe('工坊语音: the loader and the touched-file map', () => {
  let tmp;
  let ws;
  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-ws-voice-'));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'voice-pack');
    fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'voice-pack', name: '助战语音', version: '1.0.0', license: 'CC0-1.0', content: [],
      voices: { char_ws_v: { select: ['voice/a.mp3'] } },
    }));
    fs.writeFileSync(join(dir, 'assets', 'voice', 'a.mp3'), 'ID3');
    // a pack that brings nothing at all must still be refused
    const empty = join(ws, 'empty-pack');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(join(empty, 'pack.json'), JSON.stringify({ id: 'empty-pack', version: '1.0.0', content: [] }));
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('a pack with no data file at all loads, and marks `assets` as touched', () => {
    const loaded = loadWorkshop(ws, { log: { info() {}, warn() {}, error() {}, debug() {} } });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['voice-pack']);
    assert.deepEqual(loaded.packs[0].files, {}, 'it ships no data file');
    assert.deepEqual(loaded.packs[0].voices, { char_ws_v: { select: ['voice/a.mp3'] } });
    // the merge lands in assets.json, so THAT is the file the browser must receive merged
    assert.deepEqual([...workshopTouchedFiles(loaded)], ['assets']);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0].reason, /EMPTY_PACK/);
    assert.equal(loaded.errors[0].pack, 'empty-pack');
  });
});

describe('工坊语音: 只带其它语种的包 (loader + touched files)', () => {
  let tmp;
  let ws;
  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-ws-vlang-'));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'cn-pack');
    fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'cn-pack', name: '中文语音', version: '1.0.0', license: 'CC0-1.0', content: [],
      voiceLangs: { cn: { char_ws_v: { select: ['voice/cn.mp3'] } } },
    }));
    fs.writeFileSync(join(dir, 'assets', 'voice', 'cn.mp3'), 'ID3');
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('加载成功、没有数据文件、把 assets 标成被触及', () => {
    const loaded = loadWorkshop(ws, { log: { info() {}, warn() {}, error() {}, debug() {} } });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['cn-pack'], 'a pack with no data file is still a loaded pack');
    assert.deepEqual(loaded.packs[0].files, {}, 'it ships no data file');
    assert.deepEqual(loaded.packs[0].voices, {});
    assert.deepEqual(loaded.packs[0].voiceLangs, { cn: { char_ws_v: { select: ['voice/cn.mp3'] } } });
    assert.deepEqual([...workshopTouchedFiles(loaded)], ['assets'], 'the merge lands in assets.json');
    assert.equal(loaded.errors.length, 0);
  });
});

describe('工坊语音: 到达客户端 (end to end over HTTP)', () => {
  /** A 16-byte stand-in for an mp3: the route decides the content type by extension, the body must be the file. */
  const MP3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00MP3-STANDIN', 'latin1');
  let tmp;
  let dataDir;
  let ws;
  let srv;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-voice-e2e-'));
    dataDir = join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(join(dataDir, 'assets.json'), JSON.stringify({
      audio: { voice: { char_1012_skadi2: { select: ['/assets/voice/skadi2/select1.mp3'] } } },
    }));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'voice-pack');
    fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'voice-pack', name: '助战语音', version: '1.0.0', license: 'CC0-1.0', content: [],
      // a filename with a `#` and a space: legal on disk, and only survivable in a URL if it is percent-encoded
      voices: { char_ws_v: { select: ['voice/a#b c.mp3'], start: ['voice/a#b c.mp3'] } },
      voiceLangs: { cn: { char_ws_v: { select: ['voice/a#b c.mp3'] } } },
    }));
    fs.writeFileSync(join(dir, 'assets', 'voice', 'a#b c.mp3'), MP3);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws, dataDir });
  });
  after(async () => {
    await srv?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the browser gets the pack lines in the manifest it already reads', async () => {
    const manifest = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    assert.deepEqual(manifest.audio.voice.char_1012_skadi2.select, ['/assets/voice/skadi2/select1.mp3']);
    assert.deepEqual(manifest.audio.voice.char_ws_v.select, ['/workshop-assets/voice-pack/voice/a%23b%20c.mp3']);
    // the same file for two slots: the client picks per moment, the index does not dedupe ACROSS slots
    assert.deepEqual(Object.keys(manifest.audio.voice.char_ws_v).sort(), ['select', 'start']);
  });

  test('the URL in that manifest is one the pack-media route really serves', async () => {
    const manifest = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    const url = manifest.audio.voice.char_ws_v.select[0];
    const res = await fetch(srv.url + url);
    assert.equal(res.status, 200, `${url} must be servable — this is the whole wiring`);
    assert.match(res.headers.get('content-type') || '', /audio\/mpeg/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
  });

  test('a voice-only pack makes `assets` the one data file served merged', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    const data = loadData(dataDir, { log: quiet, workshopDir: ws });
    assert.deepEqual([...buildWorkshopDataFiles(data, loaded).keys()], ['assets']);
  });

  test('选了另一个语种的玩家拿到的就是包内那条，且 URL 真的能播', async () => {
    const manifest = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    assert.deepEqual(manifest.audio.voiceLangs.cn.char_ws_v.select, ['/workshop-assets/voice-pack/voice/a%23b%20c.mp3']);
    const res = await fetch(srv.url + manifest.audio.voiceLangs.cn.char_ws_v.select[0]);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
    // the CLIENT's own lookup decides by dub — this is the whole point of the feature, so it is asserted here and not
    // only in test/ui/audio.test.js: a cn-preferring unit gets the pack line, a jp one gets the pack's default table.
    assert.deepEqual(voiceLinesFor(manifest, 'char_ws_v', 'select', 'cn'), ['/workshop-assets/voice-pack/voice/a%23b%20c.mp3']);
    assert.deepEqual(voiceLinesFor(manifest, 'char_ws_v', 'select', 'jp'), ['/workshop-assets/voice-pack/voice/a%23b%20c.mp3']);
    // a dub the pack does not declare falls back to the default table rather than going silent
    assert.deepEqual(voiceLinesFor(manifest, 'char_ws_v', 'select', 'kr'), ['/workshop-assets/voice-pack/voice/a%23b%20c.mp3']);
    // ...and an operator the pack never touched keeps speaking: a dub with no entry for it falls back to the DEFAULT
    // table rather than going silent (public/js/audio.js voiceLinesFor), which here is the official default-dub line.
    assert.deepEqual(voiceLinesFor(manifest, 'char_1012_skadi2', 'select', 'cn'), ['/assets/voice/skadi2/select1.mp3']);
  });
});
