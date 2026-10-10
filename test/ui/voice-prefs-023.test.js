// 0.2.3 的「逐干员配音」在本仓库的落地形态。
//
// 上游 0.2.3 为这件事另开了一套调用（`public/js/voicePrefs.js`：`VOICE_LANGS` + `sanitizeVoiceOverrides` +
// `voiceLangFor(charId, globalLang, overrides)`，词表只有 cn / jp）。本仓库在此之前已经有同一件事的**实现**
// （存储键 `voiceLangByChar`，词表是共用的 shared/constants.js VOICE_LANGS = cn / jp / en / kr，编辑器、CLI 与
// 工坊校验器都读这一份，播放时由宿主注入的 `voiceLangOf(charId)` 解析）。
//
// 处理方式（业主裁决）：**实现用我们的、上游那套调用形状保留为接口**。于是 public/js/voicePrefs.js 是一个
// **接口层**：对外同时给出上游同名同签名的三个导出与本仓库形状的便利函数，内部一律委托给我们的存储与校验器，
// 自己一份状态都不存。这份测试把两种形状都钉住，并保留上游那份测试里独有的两条覆盖（原型链污染、按槽位中文回退）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, sanitizeVoiceLangByChar, voiceLangFor, DEFAULT_SETTINGS } from '../../public/js/ui/gameLogic/settings.js';
import { VOICE_LANGS, DEFAULT_VOICE_LANG } from '../../shared/constants.js';
import { AudioManager, voiceLine } from '../../public/js/audio.js';
import {
  VOICE_LANGS as IFACE_LANGS, DEFAULT_VOICE_LANG as IFACE_DEFAULT,
  sanitizeVoiceOverrides, voiceLangFor as ifaceVoiceLangFor,
  voiceLangOverrideOf, voiceLangOf, withVoiceLang,
} from '../../public/js/voicePrefs.js';

const a = 'char_263_skadi', b = 'char_103_angel';

test('旧设置迁移为「跟随全局」；畸形、坏 id 与原型链上的条目一律丢弃', () => {
  // 只有全局设置的老存档 ⇒ 没有任何逐干员覆盖
  assert.deepEqual(sanitizeSettings({ voiceLang: 'jp' }).voiceLangByChar, {});
  assert.deepEqual(DEFAULT_SETTINGS.voiceLangByChar, {});

  // 原型链上的属性不是自有属性：一份被污染的 localStorage 不能借它把覆盖注进来。
  // 注意这一条里的 `char_1_no` 用的是 **fr** 而不是上游原文的 `en` —— 本仓库的词表含 en / kr（我们发这两种语音包），
  // 拿 en 当「非法语言」在那边成立、在这里不成立；要测「语言不在词表里」就得用一个真的不在词表里的值。
  const polluted = Object.assign(Object.create({ [b]: 'jp' }), { [a]: 'jp', bad: 'cn', char_1_no: 'fr' });
  assert.deepEqual(sanitizeVoiceLangByChar(polluted), { [a]: 'jp' }, '原型链上的丢掉、坏 id 丢掉、非法语言丢掉');

  // 非对象一律得到空表
  for (const raw of [null, undefined, [], 1, 'jp']) {
    assert.deepEqual(sanitizeVoiceLangByChar(raw), {}, `输入 ${JSON.stringify(raw) ?? 'undefined'}`);
  }
  // 坏干员 id / 不在词表里的语言：逐条丢掉，合法的留下
  assert.deepEqual(sanitizeVoiceLangByChar({ 'not a char': 'jp' }), {}, '字段名不是干员 id');
  assert.deepEqual(sanitizeVoiceLangByChar({ [a]: 'nope' }), {}, '语言不在词表里');
  assert.deepEqual(sanitizeVoiceLangByChar({ [a]: 'cn' }), { [a]: 'cn' }, '合法的留下');
});

test('逐干员覆盖能存活一次持久化往返；删掉它则回到当前全局设置', () => {
  const settings = sanitizeSettings(JSON.parse(JSON.stringify({ voiceLang: 'jp', voiceLangByChar: { [a]: 'cn', [b]: 'en' } })));
  assert.equal(voiceLangFor(settings, a), 'cn', 'a 自己的覆盖生效');
  assert.equal(voiceLangFor(settings, b), 'en', 'b 自己的覆盖生效');
  assert.equal(voiceLangFor(settings, 'char_999_none'), 'jp', '没有覆盖的干员跟随全局');

  delete settings.voiceLangByChar[a];
  assert.equal(voiceLangFor(settings, a), 'jp', '删掉覆盖 ⇒ 回到全局 jp');

  // 坏值永远不会赢
  assert.equal(voiceLangFor({ voiceLang: 'nope', voiceLangByChar: { [a]: 'nope' } }, a), DEFAULT_VOICE_LANG);
  assert.equal(voiceLangFor({}, a), DEFAULT_VOICE_LANG);
});

test('四种配音都在词表里（上游那一版只有 cn / jp —— 本仓库随语音包发 en / kr）', () => {
  assert.deepEqual([...VOICE_LANGS], ['cn', 'jp', 'en', 'kr']);
  const s = sanitizeSettings({ voiceLang: 'kr', voiceLangByChar: { [a]: 'en' } });
  assert.equal(voiceLangFor(s, a), 'en');
  assert.equal(voiceLangFor(s, b), 'kr');
});

test('音频管理器只收全局那一个配音（逐干员由宿主注入 voiceLangOf 解析）', () => {
  const m = new AudioManager();
  // 未设置之前这个字段不可信：voice() 要让注入的 voiceLangOf / 清单自己的默认配音说了算
  assert.equal(m.voiceLangSet, false);
  m.setVoiceLang('jp');
  assert.equal(m.voiceLang, 'jp');
  assert.equal(m.voiceLangSet, true, '调用过 setVoiceLang ⇒ 这个字段从此可信');
  // 实例上不再有第二份覆盖存储（上游那套 voiceOverrides 映射没有并存）
  assert.equal(m.voiceOverrides, undefined, '不该再有 voiceOverrides 第二份存储');
});

test('逐干员的日语偏好仍然保留按槽位的中文回退（上游那份测试的独有覆盖）', () => {
  const tree = {
    voice: { [a]: { select: '/cn/select.mp3', skill1: '/cn/skill1.mp3' } },
    voiceJp: { [a]: { skill1: '/jp/skill1.mp3' } },
  };
  // 日语树缺这个槽位 ⇒ 用中文那一份
  assert.equal(voiceLine(tree, a, 'select', 'jp').url, '/cn/select.mp3');
  // 日语树有 ⇒ 用日语，并带上同名中文文件作为「本机没有日语文件」时的回退
  const jp = voiceLine(tree, a, 'skill1', 'jp');
  assert.equal(jp.url, '/jp/skill1.mp3');
  assert.equal(jp.fallback, '/cn/skill1.mp3', '同名中文文件就是回退');
  // 中文自己的那份没有回退可言
  assert.equal(voiceLine(tree, a, 'skill1', 'cn').fallback, null);
});

// ---- 接口层（public/js/voicePrefs.js）：两种调用形状都给，实现只有一份 -------------------------------

test('接口层：上游形状与本仓库形状对同一份存储给出同一结论', () => {
  // 词表就是共用那一份（不是上游原来的 cn / jp 两份）
  assert.deepEqual([...IFACE_LANGS], ['cn', 'jp', 'en', 'kr']);
  assert.equal(IFACE_DEFAULT, DEFAULT_VOICE_LANG);

  const overrides = { [a]: 'kr' };
  // 上游签名 voiceLangFor(charId, globalLang, overrides)
  assert.equal(ifaceVoiceLangFor(a, 'jp', overrides), 'kr', '自己的覆盖');
  assert.equal(ifaceVoiceLangFor(b, 'jp', overrides), 'jp', '没有覆盖 ⇒ 跟随全局');
  assert.equal(ifaceVoiceLangFor(a, 'nope', {}), DEFAULT_VOICE_LANG, '全局是坏值 ⇒ 默认');
  // 本仓库形状 voiceLangOf(settings, charId) —— 同一份数据必须同一答案
  const settings = { voiceLang: 'jp', voiceLangByChar: overrides };
  for (const id of [a, b, 'char_999_none']) {
    assert.equal(voiceLangOf(settings, id), ifaceVoiceLangFor(id, settings.voiceLang, overrides), `干员 ${id}`);
  }
});

test('接口层：sanitizeVoiceOverrides 与我们那一个校验器是同一个（不会给出不同结论）', () => {
  assert.equal(sanitizeVoiceOverrides, sanitizeVoiceLangByChar, '就是同一个函数，不是抄一份');
  const polluted = Object.assign(Object.create({ [b]: 'jp' }), { [a]: 'jp', bad: 'cn', char_1_no: 'fr' });
  assert.deepEqual(sanitizeVoiceOverrides(polluted), { [a]: 'jp' });
});

test('接口层：读自己的覆盖 / 写一份新表（不可变、空值即删、非法语言被拒）', () => {
  const s = { voiceLang: 'jp', voiceLangByChar: { [a]: 'en' } };
  assert.equal(voiceLangOverrideOf(s, a), 'en');
  assert.equal(voiceLangOverrideOf(s, b), '', '没有覆盖 ⇒ 空串（界面显示「跟随全局」）');
  assert.equal(voiceLangOverrideOf(s, null), '', '没有 charId 也不抛');

  const before = { ...s.voiceLangByChar };
  const next = withVoiceLang(s.voiceLangByChar, b, 'kr');
  assert.deepEqual(next, { [a]: 'en', [b]: 'kr' });
  assert.deepEqual(s.voiceLangByChar, before, '不改原对象（调用方自己 updateSettings）');
  assert.deepEqual(withVoiceLang(next, a, null), { [b]: 'kr' }, '传空即删掉这一条');
  assert.deepEqual(withVoiceLang(next, b, 'nope'), { [a]: 'en' }, '非法语言在写入前就被拒');
});
