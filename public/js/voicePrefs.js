// 逐干员配音的**客户端接口层**。
//
// 单一真相只有一份：设置里的 `voiceLangByChar`（ui/gameLogic/settings.js）+ 共用词表
// shared/constants.js 的 VOICE_LANGS（cn / jp / en / kr —— 编辑器、CLI 与工坊校验器都读它）。
// 这一层不存任何东西，只提供两种调用形状：
//
//   ① **上游 0.2.3 的形状**：VOICE_LANGS / sanitizeVoiceOverrides(raw) / voiceLangFor(charId, globalLang, overrides)
//      —— 上游 0.2.3 为同一件事另开过这套调用（原本实现在这个文件里，词表只有 cn / jp）。
//      这里是**同名同签名的兼容实现**：语义一样，只是词表用本仓库那四个、默认配音用本仓库的
//      DEFAULT_VOICE_LANG（jp）。将来上游再动这块时，调用点不必跟着改。
//   ② **本仓库的形状**：voiceLangOverrideOf / voiceLangOf / withVoiceLang —— 直接对设置对象读写，
//      界面（干员详情、干员调配）走这三个。
//
// 为什么不让两套各存一份：那会出现「设置里选了 A、实际播的是 B」——同一个开关两个真相。
import { VOICE_LANGS, DEFAULT_VOICE_LANG } from '../../shared/constants.js';
import { sanitizeVoiceLangByChar, voiceLangFor as voiceLangForSettings } from './ui/gameLogic/settings.js';

export { VOICE_LANGS, DEFAULT_VOICE_LANG };

/**
 * 上游 0.3.0 加的那两张**派生表**（DESIGN §34 的多语种配音）：
 *  · `VOICE_TREES`：非中文各配音在清单里的树名（中文那一棵是 `audio.voice`）；
 *  · `VOICE_PICKS`：**逐干员覆盖**允许取的值 —— 四个全局语种，再加 `'native'`（该干员自己的母语配音；它不是全局语种）。
 * ⚠️ 语言表本身仍然只有 `shared/constants.js` 那一份（见文件头）：这里只加"树名"与"可取值"两张派生表，不另存一份词表。
 */
export const VOICE_TREES = Object.freeze({ jp: 'voiceJp', en: 'voiceEn', kr: 'voiceKr', native: 'voiceNative' });
export const VOICE_PICKS = Object.freeze([...VOICE_LANGS, 'native']);
/** 语种 → 清单树（中文也在内）：`hasTree` 读它；`audio.js` 的同名用途读 `VOICE_TREES`。 */
const TREE = Object.freeze({ cn: 'voice', ...VOICE_TREES });

/** 这份清单里 `charId` 在 `lang` 那棵树下**至少有一句**（空对象 / 非对象 / 数组都不算）。 */
function hasTree(audio, charId, lang) {
  const slots = audio?.[TREE[lang]]?.[charId];
  return !!slots && typeof slots === 'object' && !Array.isArray(slots) && Object.keys(slots).length > 0;
}

/**
 * 上游 0.2.3 的形状：校验一份 `charId → dub` 的覆盖表（丢弃坏 id、原型链上的条目与不在词表里的语言）。
 * 实现就是本仓库那一个校验器，所以这里与设置里的存储不会给出不同结论。
 * @param {any} raw
 * @returns {Record<string, string>}
 */
export const sanitizeVoiceOverrides = sanitizeVoiceLangByChar;

/**
 * 上游 0.2.3 的形状，**叠上上游 0.3.0 的扩展**：某个干员播哪种配音。
 *
 * ⚠️ 这里刻意**不是**照搬上游 0.3.0 的实现，而是「本仓库那条 + 上游新路」的叠加（业主 2026-10-16 裁：有我们自己的行为就保留为来源）：
 *  · **没有 `opts.audio`**（上游 0.2.3 的调用形状，也是本仓库既有的调用）⇒ 走本仓库那**一个真相**
 *    （`ui/gameLogic/settings.js voiceLangFor`：覆盖 → 全局 → 默认，词表是共用的四语种）⇒ **行为与从前逐字相同**，
 *    含 en / kr 的逐干员覆盖。上游 0.3.0 的实现在这条路上**只认 cn / jp**（`own === 'cn' || own === 'jp'`），
 *    照搬会丢掉 en / kr 的覆盖 —— 而 `test/ui/voice-prefs-023.test.js:101` 正钉着
 *    `voiceLangFor(a, 'jp', { [a]: 'kr' }) === 'kr'`，所以本仓库保留自己那条。
 *  · **给了 `opts.audio`**（清单本体）⇒ 走上游 0.3.0 的规则：自己的选择**且本机真有那棵树**才生效；否则
 *    `opts.native` 为真且该干员有母语配音时用 `'native'`；否则全局语言（中文永远有）；再否则 `'cn'`。
 *    本机没有的树不选 —— 「设置里选了 A、实际播的是 B」正是这条规则要消灭的。
 * @param {string} charId
 * @param {string} globalLang
 * @param {Record<string, string>} [overrides]
 * @param {{ native?: boolean, audio?: any }|null} [opts]
 * @returns {string}
 */
export function voiceLangFor(charId, globalLang, overrides, opts) {
  const audio = opts?.audio;
  if (audio == null) return voiceLangForSettings({ voiceLang: globalLang, voiceLangByChar: overrides }, charId);
  const own = Object.hasOwn(overrides || {}, charId) ? overrides[charId] : null;
  if (VOICE_PICKS.includes(own) && hasTree(audio, charId, own)) return own;
  if (opts.native === true && hasTree(audio, charId, 'native')) return 'native';
  const global = VOICE_LANGS.includes(globalLang) ? globalLang : 'cn';
  if (global === 'cn' || hasTree(audio, charId, global)) return global;
  return 'cn';
}

/**
 * 本仓库的形状：该干员**自己的**覆盖，没有则 `''`（界面用空串表示「跟随全局」）。
 * @param {any} settings 设置对象（或它的快照）
 * @param {string} charId
 * @returns {string}
 */
export function voiceLangOverrideOf(settings, charId) {
  const v = typeof charId === 'string' ? settings?.voiceLangByChar?.[charId] : null;
  return VOICE_PICKS.includes(v) ? v : '';
}

/**
 * 本仓库的形状：该干员最终播哪种配音（覆盖 → 全局 → 默认）。与 `voiceLangFor` 等价，只是吃设置对象。
 * @param {any} settings
 * @param {string} charId
 * @returns {string}
 */
export function voiceLangOf(settings, charId) {
  return voiceLangForSettings(settings, charId);
}

/**
 * 本仓库的形状：返回一份**新的**覆盖表（`lang` 为空即删掉这一条）。调用方拿去做 `updateSettings`，
 * 不在这一层碰存储 —— 于是「谁在何时写了设置」始终只有一个地方。
 * @param {Record<string, string>|undefined} overrides
 * @param {string} charId
 * @param {string|null} lang
 * @returns {Record<string, string>}
 */
export function withVoiceLang(overrides, charId, lang) {
  const next = { ...(overrides || {}) };
  if (lang) next[charId] = lang;
  else delete next[charId];
  return sanitizeVoiceLangByChar(next);
}
