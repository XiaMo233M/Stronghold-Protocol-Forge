// The WORKSHOP half of the voice interface (docs/ASSETS.md "Voice lines", docs/WORKSHOP.md §1.4): a pack may declare
// voice lines for its own — or its 助战 — operators, as `voices: { <charId>: { <slot>: ["<path inside assets/>", …] } }`.
// This file pins the RESERVATION: what a pack is allowed to say, and every way the manifest validator refuses it.
//
// The files live under the pack's `assets/` subtree, so the existing licence gate covers them (a pack with art must
// declare `license`) and the client reads them from `/workshop-assets/<pack>/<path>` — the only route that serves pack
// media. Wiring that merge into the client's voice lookup is the next step; the format and its validation are here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest } from '../shared/workshop.js';
import { VOICE_SLOTS } from '../shared/constants.js';

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
});
