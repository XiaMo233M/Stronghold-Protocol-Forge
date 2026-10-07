// Which 配音语言 this install really has (v0.7.2).
//
// The manifest lists every dub the project knows (`audio.voiceLangs`), because that is what the game can play — but a
// release bundle ships only the DEFAULT dub and the others come as a separate voice pack (an extra release asset that is
// unzipped into `public/assets/audio/voice/`, see scripts/make-voice-pack.mjs). The manifest therefore cannot answer
// "will 日文 be heard here?": one HEAD request per dub answers it, and the settings row / 干员详情 only offer what is
// there, with a hint pointing at the voice pack. `public/js/audio.js` additionally falls back to the default dub when a
// line is missing, so a player who picked a dub that is not installed hears the operator instead of nothing.
//
// No DOM and no store: `probeDubs` runs once at boot (main.js, after the manifest is loaded), the UI reads the Set.

import { VOICE_LANGS } from '../../shared/constants.js';

/** Dubs a probe has proven missing (a 404 / unusable response). Session-scoped, never persisted. */
const missing = new Set();
/** The shared probe (one run per manifest). */
let probe = null;

/** Whether `lang` was proven missing on this machine (false before the probe finished — never hide a dub that may work). */
export const dubMissing = (lang) => missing.has(lang);

/**
 * The dubs of `langs` that are installed (or not yet known to be missing).
 * @param {string[]} langs e.g. the result of ui/gameLogic/settings.js availableVoiceLangs
 * @returns {string[]}
 */
export function dubsInstalled(langs) {
  return (Array.isArray(langs) ? langs : []).filter((l) => VOICE_LANGS.includes(l) && !missing.has(l));
}

/**
 * The dubs of `langs` proven missing — what the settings row tells the player to install.
 * @param {string[]} langs
 * @returns {string[]}
 */
export function dubsMissing(langs) {
  return (Array.isArray(langs) ? langs : []).filter((l) => missing.has(l));
}

/** The first URL of one dub's table (any operator that has it), or null. */
export function firstDubUrl(manifest, lang) {
  const table = manifest?.audio?.voiceLangs?.[lang];
  if (!table || typeof table !== 'object') return null;
  for (const charId of Object.keys(table)) {
    const slots = table[charId];
    if (!slots || typeof slots !== 'object') continue;
    for (const slot of Object.keys(slots)) {
      const line = slots[slot];
      const url = Array.isArray(line) ? line.find((u) => typeof u === 'string' && u) : line;
      if (typeof url === 'string' && url) return url;
    }
  }
  return null;
}

/**
 * Probe every dub of the manifest once (HEAD on one line per dub). A dub whose probe file is missing or not audio is
 * marked missing; a network hiccup is NOT (an offline player must not lose every dub from the UI). Never throws.
 * @param {any} manifest data/assets.json
 * @param {{ fetchImpl?: Function, force?: boolean }} [o]
 * @returns {Promise<string[]>} the dubs proven missing
 */
export function probeDubs(manifest, { fetchImpl = typeof fetch !== 'undefined' ? fetch : null, force = false } = {}) {
  if (!fetchImpl) return Promise.resolve([...missing]);
  if (probe && !force) return probe;
  const langs = Object.keys(manifest?.audio?.voiceLangs || {}).filter((l) => VOICE_LANGS.includes(l));
  probe = Promise.all(langs.map(async (lang) => {
    const url = firstDubUrl(manifest, lang);
    // A dub the manifest itself has no line for is not "missing here" — availableVoiceLangs already hides an empty table.
    if (!url) return lang;
    try {
      const res = await fetchImpl(url, { method: 'HEAD' });
      const type = res?.headers?.get?.('content-type') || '';
      if (!res || res.ok === false || (type && !/^\s*audio\//i.test(type))) missing.add(lang);
    } catch { /* a transport failure: leave the dub offered */ }
    return lang;
  })).then(() => [...missing]);
  return probe;
}

/** Test seam: forget the probe (never used by the app). */
export function resetDubProbe() {
  missing.clear();
  probe = null;
}
