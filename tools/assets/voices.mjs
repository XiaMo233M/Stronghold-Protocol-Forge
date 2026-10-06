// Voice lines (角色语音台词) — the opt-in half of the audio pipeline.
//
// The game itself does not need these: they are the operator's spoken lines, ~1 MB per operator. This module is the
// INTERFACE, not the feature: it turns the official index into
//
//     audio.voice[charId][slot] = [url, …]        (data/assets.json; docs/ASSETS.md "Voice lines")
//
// and the file list that `tools/fetch-assets.mjs --voices` downloads. Nothing else in the project changes: without the
// flag the manifest has no `audio.voice` key at all and `public/assets/audio/voice/` stays empty.
//
// Where the mapping comes from (verified 2026-10-06 against the real index, not assumed):
//   * `charword_table.json` (Kengxxiao/ArknightsGameData, zh_CN) — 18 237 entries; every entry has
//     `charId`, `voiceId` (CN_001…), `voiceTitle` (the Chinese name of the moment), `voiceAsset`
//     (`<owner>/CN_017`) and `voiceText`.
//   * `voiceType` is `ONLY_TEXT` for ALL 18 237 entries, so it carries no grouping: the slot mapping below is keyed by
//     `voiceTitle` (and pinned to the `CN_0NN` ids, which are stable). This also settles the research 07 §6.4 note that
//     was marked [ASSUMED]: cn_021/022 选中干员, cn_023/024 部署, cn_025–028 作战中 — all confirmed.
//   * URL: `{RAW.aa2voice}/sound_beta_2/voice_cn/<voiceAsset lowercased>.mp3`, e.g.
//     `…/voice/assets/dyn/audio/sound_beta_2/voice_cn/char_002_amiya/cn_021.mp3` (HTTP 200, checked).
//     NOTE the nesting: NOT `…/audio/voice_cn/…` (404) and not the `voice/` folder (404).
//     The path is percent-encoded, and the LOCAL name is sanitised — 673 assets carry a `#` (skin variants such as
//     `char_113_cqbw_epoque#7`); see voiceRelPath / voiceUrl below.

import { safeName, encodePath } from './sources.mjs';
import { VOICE_SLOTS } from '../../shared/constants.js';

export { VOICE_SLOTS };
//
// One (charId, voiceId) pair can appear several times with different `voiceAsset` (阿米娅's lines are also filed under
// her other forms, e.g. `char_1037_amiya3/CN_007`). The file name therefore follows the ASSET path, and a slot collects
// every distinct URL — the client picks one at random.

// The slot vocabulary lives in `shared/constants.js` (the client, this pipeline and the workshop validator share it);
// in the game's own words: start = 行动出发/行动开始, select = 选中干员, deploy = 部署, battle = 作战中,
// win = 完成高难行动/3星结束行动, lose = 行动失败.

/**
 * Official `voiceTitle` → slot. The ids in brackets are what the titles sit on (they are stable across the dump; the
 * titles are what makes them readable). Kept as data so a future index change is a one-line edit with a guiding test.
 */
export const VOICE_TITLE_SLOTS = Object.freeze({
  '行动出发': 'start',        // CN_019
  '行动开始': 'start',        // CN_020
  '选中干员1': 'select',      // CN_021
  '选中干员2': 'select',      // CN_022
  '部署1': 'deploy',          // CN_023
  '部署2': 'deploy',          // CN_024
  '作战中1': 'battle',        // CN_025
  '作战中2': 'battle',        // CN_026
  '作战中3': 'battle',        // CN_027
  '作战中4': 'battle',        // CN_028
  '完成高难行动': 'win',      // CN_029
  '3星结束行动': 'win',       // CN_030
  '非3星结束行动': 'win',     // CN_031
  '行动失败': 'lose',         // CN_032
});

/**
 * Voice line entries of `charword_table.json`, tolerating the dump's wrapper shapes.
 * @param {any} charword parsed charword_table.json
 * @returns {Array<{charId:string, voiceId:string, voiceTitle:string, voiceAsset:string}>}
 */
export function voiceEntries(charword) {
  const src = charword?.charWords || charword?.charword || charword;
  if (!src || typeof src !== 'object') return [];
  const out = [];
  for (const w of Object.values(src)) {
    if (!w || typeof w !== 'object') continue;
    const { charId, voiceId, voiceTitle, voiceAsset } = w;
    if (typeof charId !== 'string' || !charId) continue;
    if (typeof voiceId !== 'string' || !voiceId) continue;
    if (typeof voiceAsset !== 'string' || !voiceAsset) continue;
    out.push({ charId, voiceId, voiceTitle: typeof voiceTitle === 'string' ? voiceTitle : '', voiceAsset });
  }
  return out;
}

/**
 * Slot of one voice line, or null when the line is not an in-battle moment (交谈 / 闲置 / 干员报到 …).
 * @param {{voiceTitle?:string, voiceId?:string}} entry
 * @returns {string|null}
 */
export function voiceSlotOf(entry) {
  return VOICE_TITLE_SLOTS[entry?.voiceTitle] ?? null;
}

/** AA2 path of a voice line, relative to `sound_beta_2/`: `<voiceAsset lowercased>.mp3` — LOCAL file name.
 *
 * Sanitised per path segment (`safeName`): 673 of the index's assets carry a skin-variant marker in the folder name
 * (`char_113_cqbw_epoque#7`), and `#` in a path is a URL fragment delimiter — the local name drops it
 * (`…_epoque_7`) so the manifest's `/assets/…` URL needs no escaping at all. */
export function voiceRelPath(voiceAsset) {
  const a = String(voiceAsset).replace(/^\/+/, '').replace(/\.mp3$/i, '').toLowerCase();
  return `voice_cn/${a.split('/').map((s) => safeName(s)).join('/')}.mp3`;
}

/**
 * URL of a voice line (no mirror: jsDelivr 404s on the ArknightsAssets2 `voice` branch, sources.mjs).
 *
 * The path is percent-ENCODED (`encodePath`), not sanitised: upstream really does have the `#`, and a raw `#` makes the
 * request stop at the fragment — measured: `…/char_113_cqbw_epoque%237/cn_019.mp3` → 200,
 * `…/char_113_cqbw_epoque#7/cn_019.mp3` → 404. The local name above is the sanitised one, so the two differ for those
 * 673 assets; that is intended (the manifest URL is built from the local path).
 * @param {string} voiceAsset e.g. `char_002_amiya/CN_021`
 * @param {string} aa2voice base URL (RAW.aa2voice)
 */
export function voiceUrl(voiceAsset, aa2voice) {
  const a = String(voiceAsset).replace(/^\/+/, '').replace(/\.mp3$/i, '').toLowerCase();
  return `${String(aa2voice).replace(/\/+$/, '')}/sound_beta_2/voice_cn/${encodePath(a)}.mp3`;
}

/**
 * Build the voice half of the manifest for the given operators.
 *
 * @param {object} o
 * @param {string[]} o.charIds operator ids to cover (the pool — research 07 §1)
 * @param {any} o.charword parsed charword_table.json
 * @param {string} o.aa2voice base URL of the audio branch
 * @returns {{ voice: Record<string, Record<string, Array<{rel:string,url:string}>>>, files: Array<{rel:string, url:string}>, lines: number, chars: number, notes: string[] }}
 *   `voice[charId][slot]` is a list of `{ rel, url }` pairs: the caller turns each into a manifest leaf
 *   (`leaf(alt(rel, url))`), which resolves to the `/assets/<rel>` URL the client plays. `files` is the flat
 *   download list. Slots and their files are sorted so the manifest does not depend on the index's key order.
 */
export function planVoices({ charIds, charword, aa2voice }) {
  const wanted = new Set((charIds || []).filter((c) => typeof c === 'string' && c));
  /** @type {Record<string, Record<string, Array<{rel:string,url:string}>>>} */
  const voice = {};
  /** @type {Map<string, {rel:string, url:string}>} */
  const files = new Map();
  const notes = [];
  let lines = 0;
  for (const e of voiceEntries(charword)) {
    if (!wanted.has(e.charId)) continue;
    const slot = voiceSlotOf(e);
    if (!slot) continue;
    const rel = `audio/${voiceRelPath(e.voiceAsset)}`;
    const url = voiceUrl(e.voiceAsset, aa2voice);
    files.set(rel, { rel, url });
    const perChar = (voice[e.charId] ??= {});
    const list = (perChar[slot] ??= []);
    if (!list.some((x) => x.rel === rel)) list.push({ rel, url });
    lines++;
  }
  // Stable order so the manifest (and its content hash) does not depend on the index's key order.
  for (const slot of VOICE_SLOTS) {
    for (const charId of Object.keys(voice).sort()) {
      const list = voice[charId][slot];
      if (list) list.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    }
  }
  const slots = new Set();
  for (const perChar of Object.values(voice)) for (const s of Object.keys(perChar)) slots.add(s);
  if (!Object.keys(voice).length) notes.push('voice: the index has no in-battle line for any requested operator');
  else notes.push(`voice: ${files.size} files for ${Object.keys(voice).length} operators (slots: ${[...slots].sort().join(', ')})`);
  return { voice, files: [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1)), lines, chars: Object.keys(voice).length, notes };
}
