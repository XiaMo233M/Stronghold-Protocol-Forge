// test/ui/voiceDubs.test.js — 已安装配音的探测（v0.7.2）。
//
// The release bundle ships only the default dub (cn) and the others come as a separate voice pack, so the manifest alone
// cannot tell whether 日文 will be heard: public/js/voiceDubs.js probes one line per dub and the UI only offers what is
// there. A transport failure must NOT count as "missing" (an offline player keeps every dub offered).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { firstDubUrl, dubsInstalled, dubsMissing, dubMissing, probeDubs, resetDubProbe } from '../../public/js/voiceDubs.js';

const MANIFEST = {
  audio: {
    voiceLang: 'cn',
    voice: { char_a: { start: '/assets/audio/voice/cn/char_a/cn_019.mp3' } },
    voiceLangs: {
      jp: { char_a: { start: '/assets/audio/voice/jp/char_a/cn_019.mp3' }, char_b: { start: ['/assets/audio/voice/jp/char_b/cn_020.mp3'] } },
      en: { char_a: { start: '/assets/audio/voice/en/char_a/cn_019.mp3' } },
      kr: {},
    },
  },
};

describe('voiceDubs: which dubs this install really has', () => {
  beforeEach(() => resetDubProbe());

  test('firstDubUrl takes the first string of the first operator that has one', () => {
    assert.equal(firstDubUrl(MANIFEST, 'jp'), '/assets/audio/voice/jp/char_a/cn_019.mp3');
    assert.equal(firstDubUrl(MANIFEST, 'en'), '/assets/audio/voice/en/char_a/cn_019.mp3');
    assert.equal(firstDubUrl(MANIFEST, 'kr'), null, 'an empty table has no probe URL');
    assert.equal(firstDubUrl({ audio: {} }, 'jp'), null);
    assert.equal(firstDubUrl(null, 'jp'), null);
  });

  test('before a probe every dub is offered; dubsInstalled/dubsMissing are pure filters', () => {
    assert.deepEqual(dubsInstalled(['cn', 'jp']), ['cn', 'jp'], 'nothing is missing yet');
    assert.deepEqual(dubsMissing(['cn', 'jp']), []);
    assert.equal(dubMissing('jp'), false);
    assert.deepEqual(dubsInstalled(['cn', 'nope']), ['cn'], 'only real dubs');
    assert.deepEqual(dubsInstalled(null), []);
  });

  test('probeDubs marks the 404 dubs missing, keeps the audio ones and ignores transport failures', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.includes('/jp/')) return { ok: false, status: 404, headers: { get: () => 'text/html' } };
      if (url.includes('/en/')) return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' } };
      throw new Error('offline');
    };
    const missing = await probeDubs(MANIFEST, { fetchImpl });
    assert.deepEqual(missing, ['jp'], 'jp is missing; en is fine; kr had no probe URL (empty table → not in the list)');
    assert.equal(dubMissing('jp'), true);
    assert.equal(dubMissing('en'), false);
    assert.deepEqual(dubsInstalled(['cn', 'jp', 'en']), ['cn', 'en']);
    assert.deepEqual(dubsMissing(['cn', 'jp', 'en']), ['jp']);
    assert.equal(seen.length, 2, 'one HEAD per non-empty dub');
    assert.equal(seen[0], '/assets/audio/voice/jp/char_a/cn_019.mp3');

    // the probe is cached: a second call does not fetch again
    const again = await probeDubs(MANIFEST, { fetchImpl });
    assert.deepEqual(again, ['jp']);
    assert.equal(seen.length, 2);
  });

  test('an unusable response type counts as missing; no fetch implementation means "all offered"', async () => {
    const missing = await probeDubs(MANIFEST, {
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' } }),   // an SPA fallback page
    });
    assert.deepEqual(missing.includes('jp'), true, 'a 200 that is not audio is not a voice line');
    resetDubProbe();
    assert.deepEqual(await probeDubs(MANIFEST, { fetchImpl: null }), [], 'no fetch (a plain Node import): nothing is claimed missing');
  });
});
