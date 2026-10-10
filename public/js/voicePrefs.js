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
 * 上游 0.2.3 的形状：校验一份 `charId → dub` 的覆盖表（丢弃坏 id、原型链上的条目与不在词表里的语言）。
 * 实现就是本仓库那一个校验器，所以这里与设置里的存储不会给出不同结论。
 * @param {any} raw
 * @returns {Record<string, string>}
 */
export const sanitizeVoiceOverrides = sanitizeVoiceLangByChar;

/**
 * 上游 0.2.3 的形状：某个干员播哪种配音（它自己的覆盖 → 全局 → 默认）。
 * @param {string} charId
 * @param {string} globalLang
 * @param {Record<string, string>} [overrides]
 * @returns {string}
 */
export function voiceLangFor(charId, globalLang, overrides) {
  return voiceLangForSettings({ voiceLang: globalLang, voiceLangByChar: overrides }, charId);
}

/**
 * 本仓库的形状：该干员**自己的**覆盖，没有则 `''`（界面用空串表示「跟随全局」）。
 * @param {any} settings 设置对象（或它的快照）
 * @param {string} charId
 * @returns {string}
 */
export function voiceLangOverrideOf(settings, charId) {
  const v = typeof charId === 'string' ? settings?.voiceLangByChar?.[charId] : null;
  return VOICE_LANGS.includes(v) ? v : '';
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
