// Local listening preference, shared by roster and DIY details; deliberately absent from room.loadout.
//
// 与「干员详情 → 配音」共用同一份存储与同一个词表，两者都通过 ../voicePrefs.js 这一层（客户端接口）：
// 上游 0.2.3 这个文件原本只列 cn / jp 并把语言名写死在文件里 —— 本仓库随语音包一起发 en / kr，
// 所以词表与语言名走共用那一份，否则同一个设置在两处界面里能选的语言不一样。
import { html } from './components.js';
import { useSettings, updateSettings } from './settings.js';
import { t, N_ } from '../../../shared/i18n.js';
import { VOICE_LANGS, VOICE_LANG_NAMES } from '../../../shared/constants.js';
import { voiceLangOverrideOf, withVoiceLang, VOICE_PICKS, VOICE_TREES } from '../voicePrefs.js';

/**
 * 官方 `voiceLangType` 的码 → 下拉里显示的名字（**自备配音**那一格，DESIGN §28.55 的语音面）。
 * 为什么是一张表而不是拼字符串：这几个码是官方数据里的枚举值，名字是给人读的；码认不出来时回落到
 * 「本土语言」而不是把码本身甩给作者（`OTHER` 这种占位值真出现过）。
 * `N_()` 是**不翻译标记**（`shared/i18n.js`）：这些名字是「语言自称」那一类，与 `VOICE_LANG_NAMES` 同一条口径。
 */
const NATIVE_NAMES = {
  ITA: N_('意大利语'),
  GER: N_('德文'),
  RUS: N_('俄文'),
  FRE: N_('法语'),
  SPA: N_('西班牙语'),
  CN_TOPOLECT: N_('中文-方言'),
};

/**
 * 这个服务器**真的**有这个干员的这一路配音吗。
 * 为什么要看树而不是看声明：`audio` 清单里可能留着一条空对象（资源没下全 / 被裁掉了），
 * 只看「键在不在」会让下拉里出现一个选了没声音的项 —— 那正是这一格要消灭的形态。
 */
function hasTree(audioManifest, charId, lang) {
  const key = lang === 'cn' ? 'voice' : VOICE_TREES[lang];
  const slots = audioManifest?.[key]?.[charId];
  return !!slots && typeof slots === 'object' && !Array.isArray(slots) && Object.keys(slots).length > 0;
}

function nativeLabel(audioManifest, charId) {
  const type = audioManifest?.voiceNativeLangType?.[charId];
  return NATIVE_NAMES[type] ? t(NATIVE_NAMES[type]) : t('本土语言');
}

/**
 * 一个干员的配音下拉行。`saved` 是存下来的覆盖值（`''` / 缺席 = 跟随全局）。
 *
 * 两条口径：
 *   * **只列这个服务器真的有的**（`hasTree`）—— 列一个选了没声音的项比不列更糟；
 *   * **存过但这一台没有的那一项仍然列出来**，标成 `unavailable` 并写清「此服务器没有」——
 *     否则用户换一台机器打开，会以为自己从没选过（静默丢掉一个选择 = 静默改掉一份设置）。
 * @param {any} audioManifest 清单里的 `audio`（资源没加载时是 `null`）
 * @param {string} charId
 * @param {string} [saved]
 * @returns {{ value: string, label: string, unavailable: boolean }[]}
 */
export function operatorVoiceOptions(audioManifest, charId, saved) {
  const options = [{ value: '', label: t('跟随全局'), unavailable: false }];
  for (const lang of VOICE_LANGS) {
    if (hasTree(audioManifest, charId, lang)) options.push({ value: lang, label: VOICE_LANG_NAMES[lang], unavailable: false });
  }
  if (hasTree(audioManifest, charId, 'native')) {
    options.push({ value: 'native', label: nativeLabel(audioManifest, charId), unavailable: false });
  }
  if (saved && VOICE_PICKS.includes(saved) && !options.some((o) => o.value === saved)) {
    const name = saved === 'native' ? t('本土语言') : (VOICE_LANG_NAMES[saved] || saved);
    options.push({ value: saved, label: `${name}${t('（此服务器没有）')}`, unavailable: true });
  }
  return options;
}

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
