// test/ui/voice-prefs-branches.test.js — `public/js/voicePrefs.js` 的 `voiceLangFor` 现在有**两条路**（D27）：
//
//   · **没有 `opts.audio`**（上游 0.2.3 的调用形状，也是本仓库既有的调用）⇒ 走本仓库那**一个真相**
//     （`ui/gameLogic/settings.js`）：覆盖 → 全局 → 默认；词表是共用的四语种 ⇒ **en / kr 的逐干员覆盖照样生效**。
//   · **给了 `opts.audio`**（清单本体）⇒ 上游 0.3.0 的规则：自己的选择**且本机真有那棵树**才生效 →
//     `opts.native` → 全局语言（中文永远有）→ `'cn'`。
//
// 为什么这条判据必须存在：第①条是**本仓库自己的行为**（上游那版在这条路上只认 cn / jp，会丢掉 en / kr 覆盖，
// 见 `voice-prefs-023.test.js:101`），第②条是**上游 0.3.0 的能力**。两条路**不能悄悄并成一条** ——
// 并掉任一条，下面第 1 组或第 2 组就红（把 `voiceLangFor` 里 `if (audio == null)` 那个分支删掉试试）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { voiceLangFor, VOICE_PICKS, VOICE_TREES } from '../../public/js/voicePrefs.js';
import { DEFAULT_VOICE_LANG } from '../../shared/constants.js';

/** 一份「本机装了哪些树」的清单：只给 jp 与 en，kr / native 没有。 */
const audio = {
  voice: { char_a: { start: ['cn.mp3'] } },
  voiceJp: { char_a: { start: ['jp.mp3'] } },
  voiceEn: { char_a: { start: ['en.mp3'] } },
};

describe('第①条路：没有 opts.audio ⇒ 本仓库那一个真相（四语种，含 en / kr 覆盖）', () => {
  test('逐干员的 en / kr 覆盖生效（上游那版会丢掉它们 —— 这正是本仓库保留自己那条的理由）', () => {
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'kr' }), 'kr');
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'en' }), 'en');
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'cn' }), 'cn');
  });

  test('没有覆盖 ⇒ 跟随全局；全局是坏值 ⇒ 默认', () => {
    assert.equal(voiceLangFor('char_b', 'jp', {}), 'jp');
    assert.equal(voiceLangFor('char_b', 'en', {}), 'en');
    assert.equal(voiceLangFor('char_a', 'nope', {}), DEFAULT_VOICE_LANG);
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'nope' }), 'jp', '坏覆盖不生效，退回全局');
  });

  test('这条路上**不看**清单：本机没有那棵树也照覆盖走（旧行为逐字不变）', () => {
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'kr' }, null), 'kr');
    // ⚠️ `opts` 里**没有 `audio` 键**（{}）与 `audio` 显式为 null/undefined 是同一条路；要进第②条必须给 `{ audio: … }`
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'kr' }, {}), 'kr', '空的 opts ⇒ 还是第①条');
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'kr' }, { audio: {} }), 'cn', '空清单 ⇒ 第②条（本机什么都没有）');
  });
});

describe('第②条路：给了 opts.audio ⇒ 上游 0.3.0 的树规则（本机没有的树不选）', () => {
  test('自己的选择本机真有那棵树 ⇒ 用它；没有那棵树 ⇒ 不用它', () => {
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'en' }, { audio }), 'en', 'voiceEn 有这一句');
    assert.equal(voiceLangFor('char_a', 'jp', { char_a: 'kr' }, { audio }), 'jp', 'kr 那棵树不在本机 ⇒ 退回全局 jp（本机有）');
  });

  test('opts.native ⇒ 母语树（本机没有就跳过这一条）', () => {
    const withNative = { ...audio, voiceNative: { char_a: { start: ['native.mp3'] } } };
    assert.equal(voiceLangFor('char_a', 'jp', {}, { audio: withNative, native: true }), 'native');
    assert.equal(voiceLangFor('char_a', 'jp', {}, { audio, native: true }), 'jp', '本机没有母语配音 ⇒ 全局');
  });

  test('全局语言本机没有那棵树 ⇒ 退到中文；中文永远有', () => {
    assert.equal(voiceLangFor('char_a', 'en', {}, { audio }), 'en');
    assert.equal(voiceLangFor('char_a', 'kr', {}, { audio }), 'cn', '本机没有 voiceKr');
    assert.equal(voiceLangFor('char_b', 'kr', {}, { audio }), 'cn', '连中文那一句都没有也返回 cn（不是空）');
    assert.equal(voiceLangFor('char_a', 'nope', {}, { audio }), 'cn', '全局是坏值');
  });

  test('空对象 / 非对象都不算"有这一句"', () => {
    assert.equal(voiceLangFor('char_a', 'jp', {}, { audio: { voiceJp: { char_a: {} } } }), 'cn');
    assert.equal(voiceLangFor('char_a', 'jp', {}, { audio: { voiceJp: { char_a: [] } } }), 'cn');
  });
});

describe('⭐ 两条路的分界本身（并成一条就会红）', () => {
  test('同一份输入，没有 audio 时是 kr；给一个空清单时是 cn（两条路的结论必须不同）', () => {
    const overrides = { char_a: 'kr' };
    assert.equal(voiceLangFor('char_a', 'jp', overrides), 'kr', '第①条：覆盖说了算（四语种）');
    assert.equal(voiceLangFor('char_a', 'jp', overrides, { audio: {} }), 'cn', '第②条：本机没有 voiceKr ⇒ 不选它');
    // 若有人把 if (audio == null) 那条路删掉/并进第②条，上面第一行会变成 'cn' ⇒ 红；
    // 若有人把第②条并进第①条，第二行会变成 'kr' ⇒ 红。
  });

  test('两张派生表就是上游 0.3.0 的那两张（语言表仍是 shared/constants.js 那一份）', () => {
    assert.deepEqual({ ...VOICE_TREES }, { jp: 'voiceJp', en: 'voiceEn', kr: 'voiceKr', native: 'voiceNative' });
    assert.deepEqual([...VOICE_PICKS], ['cn', 'jp', 'en', 'kr', 'native']);
  });
});
