// Local listening preference, shared by roster and DIY details; deliberately absent from room.loadout.
//
// 与「干员详情 → 配音」共用同一份存储与同一个词表，两者都通过 ../voicePrefs.js 这一层（客户端接口）：
// 上游 0.2.3 这个文件原本只列 cn / jp 并把语言名写死在文件里 —— 本仓库随语音包一起发 en / kr，
// 所以词表与语言名走共用那一份，否则同一个设置在两处界面里能选的语言不一样。
import { html } from './components.js';
import { useSettings, updateSettings } from './settings.js';
import { t } from '../../../shared/i18n.js';
import { VOICE_LANGS, VOICE_LANG_NAMES } from '../../../shared/constants.js';
import { voiceLangOverrideOf, withVoiceLang } from '../voicePrefs.js';

export function OperatorVoice({ charId }) {
  const settings = useSettings();
  if (!charId) return null;
  const value = voiceLangOverrideOf(settings, charId);
  const change = (lang) => updateSettings({ voiceLangByChar: withVoiceLang(settings.voiceLangByChar, charId, lang) });
  return html`<label class="lo-voice" data-voice-char=${charId}>
    <span>${t('此干员语音')}</span>
    <span class="lo-select"><select aria-label=${t('此干员语音')} value=${value} onChange=${(e) => change(e.currentTarget.value)}>
      <option value="">${t('跟随全局')}</option>${VOICE_LANGS.map((l) => html`<option value=${l}>${VOICE_LANG_NAMES[l]}</option>`)}
    </select></span>
    <small>${t('仅保存在此浏览器，缺失的日语语音会回退到中文。')}</small>
  </label>`;
}
