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
import { normalizePackManifest, applyWorkshop, workshopVoiceIndex, workshopSummary } from '../shared/workshop.js';
import { VOICE_SLOTS } from '../shared/constants.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';

const norm = (extra = {}, opts = { hasAssets: true }) => normalizePackManifest(
  { id: 'my-pack', content: ['chess'], hasAssets: true, license: 'CC0-1.0', ...extra }, 'my-pack', opts);
/** Refusal assertions read the module's own shape ({ ok: false, error, detail }). */
const refused = (extra, opts, error) => {
  const r = norm(extra, opts);
  assert.equal(r.ok, false, `${error}: expected a refusal`);
  assert.equal(r.error, error, `${error}: got ${r.error} (${r.detail})`);
  return r;
};

describe('workshop voice packs (预留的助战语音包)', () => {
  test('an operator declares lines per slot; the paths stay relative to assets/', () => {
    const r = norm({ voices: { char_ws_a: { select: ['voice/char_ws_a/select1.mp3'], deploy: ['voice/char_ws_a/deploy1.mp3', 'voice/char_ws_a/deploy2.mp3'] } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.voices, {
      char_ws_a: { select: ['voice/char_ws_a/select1.mp3'], deploy: ['voice/char_ws_a/deploy1.mp3', 'voice/char_ws_a/deploy2.mp3'] },
    });
  });

  test('no declaration → an empty map (never undefined), and the pack still loads', () => {
    assert.deepEqual(norm().pack.voices, {});
    assert.equal(norm().ok, true);
  });

  test('the slot vocabulary is the ONE shared list (client, asset pipeline and this validator read it)', () => {
    assert.deepEqual([...VOICE_SLOTS], ['start', 'select', 'deploy', 'battle', 'win', 'lose']);
    for (const slot of VOICE_SLOTS) {
      assert.equal(norm({ voices: { c: { [slot]: ['v.mp3'] } } }).ok, true, slot);
    }
    const bad = refused({ voices: { c: { chat: ['v.mp3'] } } }, { hasAssets: true }, 'VOICE_SLOT_UNKNOWN');
    assert.match(bad.detail, /select/, 'the refusal names the slots that would have worked');
  });

  test('a single path may be written as a string; duplicates collapse', () => {
    const r = norm({ voices: { c: { deploy: 'v.mp3' } } });
    assert.deepEqual(r.pack.voices, { c: { deploy: ['v.mp3'] } });
    assert.deepEqual(norm({ voices: { c: { deploy: ['a.mp3', 'a.mp3', 'b.mp3'] } } }).pack.voices.c.deploy, ['a.mp3', 'b.mp3']);
  });

  test('every way a declaration is refused', () => {
    const cases = [
      [{ voices: { c: { deploy: ['../secret.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { deploy: ['/abs.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { deploy: ['a\\b.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { deploy: ['C:/abs.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { deploy: [] } } }, { hasAssets: true }, 'VOICE_EMPTY'],
      [{ voices: { c: { deploy: ['./ok.mp3'] } } }, { hasAssets: true }, 'VOICE_PATH_UNSAFE'],
      [{ voices: { c: { deploy: ['ok.mp3'] } } }, { hasAssets: false }, 'VOICE_NEEDS_ASSETS'],
      [{ voices: [] }, { hasAssets: true }, 'VOICE_BAD_SHAPE'],
      [{ voices: { 'bad id!': { deploy: ['ok.mp3'] } } }, { hasAssets: true }, 'VOICE_BAD_CHAR_ID'],
      [{ voices: { c: 'deploy.mp3' } }, { hasAssets: true }, 'VOICE_BAD_SHAPE'],
    ];
    for (const [extra, opts, error] of cases) refused(extra, opts, error);
  });

  test('the licence gate comes first: a pack with art and no licence never reaches the voice check', () => {
    const r = normalizePackManifest({ id: 'my-pack', content: ['chess'], voices: { c: { deploy: ['ok.mp3'] } } }, 'my-pack', { hasAssets: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ASSETS_NEED_LICENSE', 'pack media — audio included — is the pack author to license');
  });

  test('a pack whose ONLY contribution is voice lines is a pack (content may be empty)', () => {
    const r = normalizePackManifest(
      { id: 'char-voice', content: [], license: 'CC0-1.0', voices: { char_ws_v: { select: ['voice/v/1.mp3'], win: ['voice/v/w.mp3'] } } },
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
    const index = workshopVoiceIndex([pack('a-pack', { char_ws_a: { deploy: ['voice/a#b c.mp3', 'voice/plain.mp3'] } })]);
    assert.deepEqual(index, {
      char_ws_a: { deploy: ['/workshop-assets/a-pack/voice/a%23b%20c.mp3', '/workshop-assets/a-pack/voice/plain.mp3'] },
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
      char_ws_new: { win: ['voice/w.mp3'], lose: ['voice/l.mp3'] },
    })]);
    assert.deepEqual(data.assets.audio.voice.char_1012_skadi2.select,
      ['/assets/voice/skadi2/select1.mp3', '/workshop-assets/v-pack/voice/alt.mp3'],
      'an operator the official data already has keeps its own lines and gains the pack\'s');
    assert.deepEqual(data.assets.audio.voice.char_ws_new, {
      win: ['/workshop-assets/v-pack/voice/w.mp3'],
      lose: ['/workshop-assets/v-pack/voice/l.mp3'],
    }, 'a 助战 operator the pack adds has no official lines to keep');
    // nothing else of assets.json is touched, and the input is never mutated
    assert.deepEqual(data.assets.ui, BASE.assets.ui);
    assert.deepEqual(data.assets.audio.sfx, BASE.assets.audio.sfx);
    assert.deepEqual(BASE.assets.audio.voice.char_1012_skadi2.select, ['/assets/voice/skadi2/select1.mp3']);
    assert.deepEqual(report.voices, { 'v-pack': 3 });
    assert.match(workshopSummary(report), /3 voice lines/);
  });

  test('an install without an audio manifest is REPORTED, not silently dropped', () => {
    const { data, report } = applyWorkshop({}, [pack('v-pack', { c: { deploy: ['v.mp3'] } })]);
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
});
