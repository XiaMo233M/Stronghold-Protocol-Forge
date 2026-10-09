// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';
import { VOICE_LANGS, DEFAULT_VOICE_LANG } from '../../../../shared/constants.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键).
 * voiceLang: the 配音语言 every operator speaks unless it has its own (VOICE_LANGS).
 * voiceLangByChar: charId → dub, the per-operator override of 干员详情 → 配音 (absent = follow voiceLang).
 */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, quality: 'high', keys: DEFAULT_HOTKEYS, voiceLang: DEFAULT_VOICE_LANG, voiceLangByChar: Object.freeze({}) });

/**
 * The 配音语言 vocabulary (settings 语音语言) under upstream 0.2.2's name: the canonical list is shared/constants.js
 * (cn / jp / en / kr, imported above), which the workshop validator, the editor's voice page and the CLI all read.
 * Upstream's own export was its two dubs ('cn' 中文 / 'jp' 日本語 through `audio.voiceJp`); `availableVoiceLangs`
 * below still narrows the choice to the dubs the loaded manifest really ships.
 */
export { VOICE_LANGS };
const QUALITIES = ['high', 'medium', 'low'];
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
 * @returns {{ bgm: number, sfx: number, voice: number, muted: boolean, damageNumbers: boolean, quality: 'high'|'medium'|'low',
 *   keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string>,
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
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    keys: sanitizeHotkeys(r.keys),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceLangByChar: sanitizeVoiceLangByChar(r.voiceLangByChar),
  };
}
