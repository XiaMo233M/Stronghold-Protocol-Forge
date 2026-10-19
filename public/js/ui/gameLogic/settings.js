// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';
import { VOICE_LANGS, DEFAULT_VOICE_LANG } from '../../../../shared/constants.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/**
 * keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键).
 * voiceLang: the 配音语言 every operator speaks unless it has its own (VOICE_LANGS).
 * voiceLangByChar: charId → dub, the per-operator override of 干员详情 / 干员调配 → 配音 (absent = follow voiceLang).
 * ammoCount: 设置「弹药数量」 — the rounds left / the magazine under an ammo skill's bar (render/units.js; PR #552),
 *   off by default: the official HUD has no such number (the maintainer's decision of 2026-10-13).
 * textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js applyTextSize).
 * officialFx: 设置「官方特效」 (0.3.0, render/vfx) —— OFFICIAL_FX_MODES：`auto` 按设备取档，其余三档由玩家点选
 *   (ui/settings.js 的「官方特效」分段控件；render/app.js 交给 render/vfx/tier.js resolveOfficialFx)。
 * workshopSkins: 工坊时装（`pack.json.skins` + 一个注册了的外观提供者）要不要生效 —— 见
 *   `public/js/ui/portraitChain.js` 的步骤 0。默认 **true**：装了一套时装却什么都不发生，比「能关掉」
 *   更让人困惑。关掉时解析链与「这一版之前」逐字相同（那条不变量由 `test/ui/portraitChain.test.js` 钉住）。
 * workshopSources: 工坊素材加载源（`pack.json.assets.mirrors[]` + 一个注册了的 `sources(ctx)` 提供者）要不要生效
 *   —— 见 `public/js/resources/sources.js`。默认 **true**：作者声明了镜像却一条都不用，比「能关掉」更让人困惑。
 *   关掉时导入路径与「没有这一格」逐字相同（走包内那条 `/workshop-resources/…` URL），也就是这一格的**一键回退**：
 *   一个包把加载源改坏了，玩家关掉这一格就回到原样（不变量由 `test/modAssetsMirrors.test.js` 钉住）。
 */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, officialDamageNumbers: false, ammoEnergyCount: false, combatMetrics: false, prepDeployFold: true, otherSkins: true, workshopSkins: true, workshopSources: true, quality: 'high', officialFx: 'auto', textSize: 'sm', keys: DEFAULT_HOTKEYS, voiceLang: DEFAULT_VOICE_LANG, voiceLangByChar: Object.freeze({}) });
/**
 * 设置「显示弹药与能量数量」的取值（上游 0.3.1 把「弹药数量」与「秘术师能量」两个开关合并成一个）：
 * 新键是布尔就用它；否则读旧键 —— 任一为 true 即为 true。旧键只在这里被读，**永不写回**。
 * @param {Record<string, any>} r
 */
function ammoEnergyCountOf(r) {
  if (typeof r.ammoEnergyCount === 'boolean') return r.ammoEnergyCount;
  return r.ammoCount === true || r.mysticEnergy === true;
}


/**
 * The 配音语言 vocabulary (settings 语音语言) under upstream 0.2.2's name: the canonical list is shared/constants.js
 * (cn / jp / en / kr, imported above), which the workshop validator, the editor's voice page and the CLI all read.
 * Upstream's own export was its two dubs ('cn' 中文 / 'jp' 日本語 through `audio.voiceJp`); `availableVoiceLangs`
 * below still narrows the choice to the dubs the loaded manifest really ships.
 *
 * 上游 0.2.3 在 public/js/voicePrefs.js 里另开了一套逐干员语音（`voiceOverrides` + 只有 cn / jp 的词表）。
 * 不并存两套：那套的词表现在也指向 shared/constants.js 这一份，存储键仍是下面的 `voiceLangByChar`。
 */
export { VOICE_LANGS };
const QUALITIES = ['high', 'medium', 'low'];
/**
 * 设置「官方特效」(0.3.0, render/vfx) 的取值。`auto` 是自动档：桌面取 `full`、触屏取 `lite`
 * (render/vfx/tier.js resolveOfficialFx)，所以界面只有 关 / 精简 / 完整 三个按钮，没有 `auto` 那一格。
 * sanitizeSettings 必须收下 `off` —— 否则玩家点「关」会被丢掉、控件立刻弹回（与 lastBgmKey 同型）。
 */
export const OFFICIAL_FX_MODES = Object.freeze(['auto', 'off', 'lite', 'full']);
/** A charId an override may name (the same shape the workshop validator accepts for a voice line). */
const CHAR_ID = /^char_[A-Za-z0-9_]{1,64}$/;
/** Overrides kept at most: a full roster is ~200 operators — a file that grew past this was not written by this UI. */
const VOICE_OVERRIDE_MAX = 400;

/**
 * The dubs a player may choose from: the ones this manifest actually carries. `audio.voice` is the manifest's default
 * dub and `audio.voiceLangs` the others (`tools/assets/plan.mjs`), so a checkout that downloaded only Chinese does not
 * offer a button that could never make a sound.
 * @param {any} manifest data/assets.json
 * @returns {string[]} e.g. ['cn'] or ['cn','jp','en','kr']
 */
export function availableVoiceLangs(manifest) {
  const a = manifest?.audio;
  const def = VOICE_LANGS.includes(a?.voiceLang) ? a.voiceLang : DEFAULT_VOICE_LANG;
  const out = Object.keys(a?.voiceLangs || {}).filter((l) => VOICE_LANGS.includes(l) && a.voiceLangs[l] && Object.keys(a.voiceLangs[l]).length);
  return [...new Set([def, ...out])].sort((x, y) => VOICE_LANGS.indexOf(x) - VOICE_LANGS.indexOf(y));
}

/**
 * Sanitize the per-operator 配音 overrides: charId → one of VOICE_LANGS, capped, everything else dropped (a hand-edited
 * localStorage must never make the game request a dub that does not exist).
 */
export function sanitizeVoiceLangByChar(raw) {
  if (!isObj(raw)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= VOICE_OVERRIDE_MAX) break;
    if (typeof k !== 'string' || !CHAR_ID.test(k) || !VOICE_LANGS.includes(v)) continue;
    out[k] = v;
    n++;
  }
  return out;
}

/**
 * The dub `charId` speaks: its own override, else the global one, else the default. Pure — the client and the tests
 * read it through this one function, so the detail panel and the audio manager can never disagree.
 * @param {any} s the settings store's value (or a snapshot of it)
 * @param {string} charId
 * @returns {'cn'|'jp'|'en'|'kr'}
 */
export function voiceLangFor(s, charId) {
  const per = typeof charId === 'string' ? s?.voiceLangByChar?.[charId] : null;
  if (VOICE_LANGS.includes(per)) return per;
  return VOICE_LANGS.includes(s?.voiceLang) ? s.voiceLang : DEFAULT_VOICE_LANG;
}

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, workshopSkins: boolean,
 *   workshopSources: boolean, ammoCount: boolean,
 *   quality: 'high'|'medium'|'low',
 *   textSize: 'sm'|'md'|'lg'|'xl', keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string>,
 *   voiceLang: 'cn'|'jp'|'en'|'kr', voiceLangByChar: Record<string, 'cn'|'jp'|'en'|'kr'> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoEnergyCount: ammoEnergyCountOf(r),
    prepDeployFold: typeof r.prepDeployFold === 'boolean' ? r.prepDeployFold : DEFAULT_SETTINGS.prepDeployFold,
    otherSkins: typeof r.otherSkins === 'boolean' ? r.otherSkins : DEFAULT_SETTINGS.otherSkins,
    combatMetrics: typeof r.combatMetrics === 'boolean' ? r.combatMetrics : DEFAULT_SETTINGS.combatMetrics,
    workshopSkins: typeof r.workshopSkins === 'boolean' ? r.workshopSkins : DEFAULT_SETTINGS.workshopSkins,
    workshopSources: typeof r.workshopSources === 'boolean' ? r.workshopSources : DEFAULT_SETTINGS.workshopSources,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    officialFx: OFFICIAL_FX_MODES.includes(r.officialFx) ? r.officialFx : DEFAULT_SETTINGS.officialFx,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    keys: sanitizeHotkeys(r.keys),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceLangByChar: sanitizeVoiceLangByChar(r.voiceLangByChar),
  };
}
