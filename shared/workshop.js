// shared/workshop.js — 创意工坊 (community workshop) pack format and the overlay merge, pure ESM shared by the server
// (the loader, the match data) and the browser (which reads the same merged /data/*.json).
//
// A workshop pack is DATA ONLY at this layer. It never edits `data/*.json` — the loader applies an additive overlay on
// top of the generated official data just before that object is frozen (server/data.js loadData). Two consequences are
// load-bearing for the whole feature:
//
//   1. `data/*.json` stays byte-identical, so the official integrity suite (test/data.test.js, incl. the offline
//      rebuild that must reproduce data/ byte-for-byte) keeps passing and the official content is a clean baseline.
//   2. The overlay runs BEFORE deepFreeze, so every consumer (match engine, sim, client) sees one ordinary merged
//      object and no downstream code needs to know workshop content exists.
//
// Overlay rule: **an id the official data already has is NOT replaced** unless the pack lists it in
// `pack.json.overrides` as `"<file>:<id>"`. Additive by default, explicit to override — a pack that silently redefines
// an official operator would otherwise corrupt every match on the server.
//
// Pack layout (`workshop/<packId>/`):
//   pack.json        { id, name, version, author, license, description, gameVersion, content: [file…], overrides: [] }
//   chess.json       { [chessId]:  record }   ← same shape as data/chess.json
//   items.json enemies.json stages.json waves.json tokens.json bosses.json factions.json   (any file in `content`)
//
// The behaviour layer (a pack's `kits/*.js`, wired to the battle.on(...) hook bus) is deliberately NOT part of this
// module: it is code, it is loaded by the server only, and it is documented in docs/WORKSHOP.md.

/** Data files a pack may contribute to. Deliberately a conservative subset of data/: `config` is excluded because a
 * pack that rewrote the economy or the round schedule would change the rules rather than the content. */
export const WORKSHOP_CONTENT_FILES = Object.freeze([
  'chess', 'items', 'enemies', 'stages', 'waves', 'tokens', 'bosses', 'factions', 'garrisons', 'bands', 'bonds', 'effects', 'choices',
]);

/** Files whose records are keyed by an id field that must equal the map key (catches copy-paste mistakes in a pack). */
const ID_FIELD_BY_FILE = Object.freeze({
  chess: 'chessId', items: 'id', enemies: 'key', stages: 'stageId', waves: 'templateId',
  tokens: 'tokenId', bosses: 'bossId', factions: 'factionId', garrisons: 'garrisonId',
  bands: 'bandId', bonds: 'bondId', effects: 'effectId', choices: 'id',
});

/** Pack ids: a short filesystem- and URL-safe slug (it names the directory under workshop/). */
export const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * The URL prefix a pack's own media is served under: `<prefix><packId>/<path inside that pack's assets/>`
 * (server/index.js serves the route, docs/WORKSHOP.md §5). One source of truth, because the voice URLs this module
 * writes into the data must be exactly the ones that route answers.
 */
export const WORKSHOP_MEDIA_PREFIX = '/workshop-assets/';
/** Record ids follow the wire-id charset (shared/protocol.js isId) so an id can travel in a message. */
const RECORD_ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

import { VOICE_SLOTS } from './constants.js';
import { isSupportTier } from './support.js';

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (error, detail) => ({ ok: false, error, detail });

/**
 * Validate and normalise one pack's `pack.json`.
 * @param {any} raw parsed pack.json
 * @param {string} [dirName] the pack's directory name (authoritative when the manifest omits / contradicts `id`)
 * @returns {{ ok: true, pack: { id: string, name: string, version: string, author: string|null, license: string|null,
 *   description: string|null, gameVersion: string|null, content: string[], overrides: string[] } }
 *   | { ok: false, error: string, detail: string }}
 */
export function normalizePackManifest(raw, dirName = '', opts = {}) {
  if (!isPlainObj(raw)) return fail('BAD_MANIFEST', 'pack.json must be a JSON object');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : dirName;
  if (!PACK_ID_RE.test(id)) return fail('BAD_PACK_ID', `"${id}" is not a valid pack id (letters, digits, _ and - only)`);
  if (dirName && typeof raw.id === 'string' && raw.id && raw.id !== dirName) {
    return fail('PACK_ID_MISMATCH', `pack.json id "${raw.id}" does not match its directory "${dirName}"`);
  }
  const content = Array.isArray(raw.content)
    ? [...new Set(raw.content.filter((f) => typeof f === 'string' && WORKSHOP_CONTENT_FILES.includes(f)))].sort()
    : [];
  // (EMPTY_PACK is checked after `voices` below: a pack whose whole contribution is a 助战 operator's voice lines has no
  // data file at all, and refusing it here would make the reserved voice pack impossible to write.)
  const overrides = Array.isArray(raw.overrides)
    ? [...new Set(raw.overrides.filter((o) => typeof o === 'string' && /^[a-z]+:[A-Za-z0-9_\-.:]{1,64}$/.test(o)))].sort()
    : [];
  const license = typeof raw.license === 'string' && raw.license ? raw.license : null;
  // A pack that SHIPS ITS OWN ART must say under what terms (`hasAssets` = it has an assets/ folder; the loader passes
  // it, since this function only sees the manifest). The repo ships no game assets, so a pack's art is the pack author's
  // to license — and the redistributor carries the risk, which is why the manifest has to name the licence rather than
  // leave it to a README nobody reads (docs/WORKSHOP.md §5).
  if (opts.hasAssets === true && !license) {
    return fail('ASSETS_NEED_LICENSE',
      'this pack has an assets/ folder, so pack.json must declare a license (e.g. "CC0-1.0", "CC-BY-4.0", or "see assets/LICENSE.txt")');
  }
  // Voice lines of a pack's own (or its 助战) operators — the RESERVED workshop half of the voice interface
  // (docs/WORKSHOP.md §1.4, docs/ASSETS.md "Voice lines"): `voices: { <charId>: { <slot>: ["<path inside assets/>", …] } }`.
  // The files live under the pack's assets/, so the licence gate above already applies to them, and the client reads
  // them from /workshop-assets/<pack>/<path> — the one route that serves pack media. Only the fixed slot vocabulary is
  // accepted, so a typo cannot silently produce a line that never plays.
  const voices = raw.voices === undefined ? {} : raw.voices;
  if (!isPlainObj(voices)) return fail('VOICE_BAD_SHAPE', 'voices must be an object: { "<charId>": { "<slot>": ["<path>"] } }');
  if (Object.keys(voices).length && opts.hasAssets !== true) {
    return fail('VOICE_NEEDS_ASSETS', 'a pack that declares voices must put the files in its assets/ folder (e.g. assets/voice/…)');
  }
  /** @type {Record<string, Record<string, string[]>>} */
  const voiceLines = {};
  for (const [charId, slots] of Object.entries(voices)) {
    if (!/^[A-Za-z0-9_\-]{1,64}$/.test(charId)) return fail('VOICE_BAD_CHAR_ID', `"${charId}" is not a valid operator id`);
    if (!isPlainObj(slots)) return fail('VOICE_BAD_SHAPE', `voices["${charId}"] must map slots to file lists`);
    const clean = {};
    for (const [slot, files] of Object.entries(slots)) {
      if (!VOICE_SLOTS.includes(slot)) {
        return fail('VOICE_SLOT_UNKNOWN', `"${slot}" is not a voice slot (one of: ${VOICE_SLOTS.join(', ')})`);
      }
      const list = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === 'string' && f);
      if (!list.length) return fail('VOICE_EMPTY', `voices["${charId}"]["${slot}"] names no file`);
      for (const f of list) {
        // relative, inside assets/, no traversal — the same rule the /workshop-assets route enforces (that route refuses
        // `.` and `..` segments, so a `.` here would only ever produce a URL that 404s)
        if (f.startsWith('/') || f.includes('\\') || f.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(f)) {
          return fail('VOICE_PATH_UNSAFE', `"${f}" must be a relative path inside assets/ (no absolute paths, no "..")`);
        }
      }
      clean[slot] = [...new Set(list)].sort();
    }
    if (Object.keys(clean).length) voiceLines[charId] = clean;
  }
  // A pack may bring data files, voice lines, or both — never neither (docs/WORKSHOP.md §1.4).
  if (!content.length && !Object.keys(voiceLines).length) {
    return fail('EMPTY_PACK', `content must name at least one of: ${WORKSHOP_CONTENT_FILES.join(', ')} — or the pack must declare voices`);
  }
  // 助战卡池贡献 (docs/WORKSHOP.md §2): the operators of THIS pack that should be selectable as 助战. The tier is NOT
  // written here — it is derived from the pack's own chess record, exactly like every other derived field, so a tier can
  // never disagree with the record (a mismatch would silently disable the operator: shared/support.js isSupportChess
  // requires the id to sit under its own tier).
  const support = raw.support === undefined ? [] : raw.support;
  if (!Array.isArray(support)) {
    return fail('SUPPORT_BAD_SHAPE', 'support must be an array of operator ids this pack adds, e.g. ["chess_char_ws_my_op_a"]');
  }
  const supportIds = [];
  for (const id of support) {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
      return fail('SUPPORT_BAD_ID', `"${String(id)}" is not a valid operator id`);
    }
    if (!supportIds.includes(id)) supportIds.push(id);
  }
  return {
    ok: true,
    pack: {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      version: typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0',
      author: typeof raw.author === 'string' && raw.author ? raw.author : null,
      license,
      hasAssets: opts.hasAssets === true,
      description: typeof raw.description === 'string' && raw.description ? raw.description : null,
      gameVersion: typeof raw.gameVersion === 'string' && raw.gameVersion ? raw.gameVersion : null,
      content,
      overrides,
      voices: voiceLines,
      support: supportIds,
    },
  };
}

/**
 * Validate one content file of a pack: a `{ [id]: record }` map, every key a safe id, every value a JSON object, and —
 * when the record carries its own id field — that field equal to the key.
 * @param {string} file data file basename, e.g. 'chess'
 * @param {any} json parsed file
 * @returns {{ ok: true, records: Record<string, object> } | { ok: false, error: string, detail: string }}
 */
export function normalizeContentFile(file, json) {
  if (!isPlainObj(json)) return fail('BAD_CONTENT', `${file}.json must be a JSON object of { id: record }`);
  const field = ID_FIELD_BY_FILE[file] || null;
  /** @type {Record<string, object>} */
  const records = {};
  for (const [id, rec] of Object.entries(json)) {
    if (!RECORD_ID_RE.test(id)) return fail('BAD_RECORD_ID', `${file}.json key "${id}" is not a valid id`);
    if (!isPlainObj(rec)) return fail('BAD_RECORD', `${file}.json["${id}"] must be a JSON object`);
    if (field && rec[field] !== undefined && rec[field] !== id) {
      return fail('ID_MISMATCH', `${file}.json["${id}"].${field} is "${rec[field]}" — it must equal the key`);
    }
    records[id] = rec;
  }
  if (!Object.keys(records).length) return fail('EMPTY_CONTENT', `${file}.json has no records`);
  return { ok: true, records };
}

/**
 * The voice lines every pack contributes, keyed exactly like the manifest the client looks them up in:
 * `{ <charId>: { <slot>: [url, …] } }` (docs/ASSETS.md "Voice lines").
 *
 * The URLs point into the pack media route (`WORKSHOP_MEDIA_PREFIX`), so the client needs no new channel: the overlay
 * merges this map into `assets.audio.voice` and the game server serves `/data/assets.json` merged, which is the object
 * public/js/audio.js already reads (`installAudio({ getManifest: () => data.get('assets') })`).
 *
 * Every path segment is percent-encoded: a pack filename may legitimately hold a `#`, a space or a `+`, and the route
 * decodes the path before it resolves it (`/workshop-assets/<pack>/voice/a%23b.mp3`).
 *
 * @param {Array<{ id: string, voices?: Record<string, Record<string, string[]>> }>} packs loaded packs (server/workshop.js)
 * @param {{ prefix?: string }} [opts]
 * @returns {Record<string, Record<string, string[]>>}
 */
export function workshopVoiceIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, Record<string, string[]>>} */
  const out = {};
  const list = (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id && isPlainObj(p.voices));
  // sorted by pack id: the merged line list must not depend on the order the filesystem handed the packs over
  for (const pack of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const [charId, slots] of Object.entries(pack.voices)) {
      if (!isPlainObj(slots)) continue;
      for (const [slot, files] of Object.entries(slots)) {
        if (!Array.isArray(files) || !files.length) continue;
        const bySlot = (out[charId] ||= {});
        const urls = (bySlot[slot] ||= []);
        for (const f of files) {
          if (typeof f !== 'string' || !f) continue;
          urls.push(prefix + pack.id + '/' + f.split('/').map(encodeURIComponent).join('/'));
        }
      }
    }
  }
  return out;
}

/** Pack ids are slugs, so a plain code-unit compare is a stable, locale-independent order. */
const byPackId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Resolve every pack's 助战 declaration (`pack.json.support`) into the pool entries it asks for, plus the reasons a
 * declaration is refused (docs/WORKSHOP.md §2).
 *
 * ONE rule, two callers: the overlay (`mergeWorkshopSupport`, which actually publishes them) and
 * `tools/workshop-validate.mjs` (which reports them to the author). Two restrictions, both deliberate:
 *   * only an operator THIS pack adds may enter the pool — a pack must not change which OFFICIAL operators are
 *     available as 助战 (that is a rules decision, and the pool belongs to the install);
 *   * the TIER is derived from the record, never written in the manifest, so it cannot disagree with it — a mismatch
 *     would silently disable the operator, because shared/support.js `isSupportChess` requires an id to sit under the
 *     tier its record declares.
 *
 * @param {Readonly<Record<string, any>>} data merged game data (the tier is read from the MERGED chess record)
 * @param {Array<{ id: string, support?: string[], files?: Record<string, Record<string, object>> }>} packs
 * @returns {{ entries: Array<{ pack: string, id: string, tier: number }>, errors: Array<{ pack: string, id: string, code: string, reason: string }> }}
 */
export function workshopSupportEntries(data, packs) {
  const entries = [];
  const errors = [];
  const chess = isPlainObj(data) && isPlainObj(data.chess) ? data.chess : {};
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId)) {
    const own = isPlainObj(pack.files) && isPlainObj(pack.files.chess) ? pack.files.chess : {};
    for (const id of Array.isArray(pack.support) ? pack.support : []) {
      if (!Object.hasOwn(own, id)) {
        errors.push({
          pack: pack.id, id, code: 'SUPPORT_FOREIGN_OPERATOR',
          reason: `"${id}" is not an operator this pack adds — only a pack's OWN operators may enter the 助战 pool`,
        });
        continue;
      }
      const rec = isPlainObj(chess[id]) ? chess[id] : own[id];
      const tier = rec ? rec.tier : null;
      if (!isSupportTier(tier)) {
        errors.push({
          pack: pack.id, id, code: 'SUPPORT_TIER_UNKNOWN',
          reason: `"${id}" has no integer tier 1–6 (got ${JSON.stringify(tier)}), so it can never be a 助战`,
        });
        continue;
      }
      entries.push({ pack: pack.id, id, tier });
    }
  }
  return { entries, errors };
}

/**
 * Publish the 助战 pool entries the packs ask for into `data/support.json` (docs/WORKSHOP.md §2) — this is what makes a
 * distributed pack SELF-CONTAINED: without it, a player who installs a pack that adds a 助战 operator would also have to
 * hand-edit `data/support.json` before the operator could be picked.
 *
 * The installer keeps the last word: `"workshop": false` in `data/support.json` turns every pack contribution off.
 */
function mergeWorkshopSupport(data, packs, report) {
  const { entries, errors } = workshopSupportEntries(data, packs);
  for (const e of errors) report.errors.push({ pack: e.pack, file: 'support', id: e.id, reason: e.reason });
  if (!entries.length) return;
  const support = isPlainObj(data.support) ? data.support : null;
  if (!support) {
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.pack)) continue;
      seen.add(e.pack);
      report.errors.push({
        pack: e.pack, file: 'support', id: e.id,
        reason: 'this pack declares 助战 operators, but data/support.json is missing — 助战 is off for this install',
      });
    }
    return;
  }
  if (support.workshop === false) { report.supportOff = true; return; }
  const pool = { ...(isPlainObj(support.pool) ? support.pool : {}) };
  /** @type {Record<string, string[]>} */
  const added = {};
  for (const { pack, id, tier } of entries) {
    const key = String(tier);
    const list = Array.isArray(pool[key]) ? pool[key].slice() : [];
    if (!list.includes(id)) list.push(id);
    list.sort();
    pool[key] = list;
    (added[pack] ||= []).push(id);
  }
  data.support = { ...support, pool };
  report.support = added;
}

/**
 * Apply every pack's content on top of the official data and return a NEW top-level object (the input is never
 * mutated; the caller freezes the result). Official ids are only replaced when the pack declared them in `overrides`;
 * a collision that was not declared is a reported error and the official record is kept.
 *
 * @param {Readonly<Record<string, any>>} base the loaded official data (server/data.js)
 * @param {Array<{ id: string, name?: string, overrides?: string[], files: Record<string, Record<string, object>> }>} packs
 * @returns {{ data: Record<string, any>, report: { packs: object[], added: Record<string, string[]>, overridden: Record<string, string[]>, errors: object[] } }}
 */
export function applyWorkshop(base, packs) {
  const out = { ...(isPlainObj(base) ? base : {}) };
  const report = { packs: [], added: {}, overridden: {}, errors: [] };
  const push = (bag, file, id) => { (bag[file] ||= []).push(id); };

  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!pack || typeof pack !== 'object' || !pack.id) continue;
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    const entry = { id: pack.id, name: pack.name || pack.id, files: {} };
    for (const [file, records] of Object.entries(pack.files || {})) {
      const official = isPlainObj(out[file]) ? out[file] : {};
      const merged = { ...official };
      let added = 0;
      let overridden = 0;
      for (const [id, rec] of Object.entries(records || {})) {
        const exists = Object.hasOwn(official, id);
        if (exists && !declared.has(`${file}:${id}`)) {
          report.errors.push({
            pack: pack.id, file, id,
            reason: `"${id}" already exists in the official data — add "${file}:${id}" to pack.json overrides to replace it`,
          });
          continue;
        }
        merged[id] = rec;
        if (exists) { overridden++; push(report.overridden, file, id); } else { added++; push(report.added, file, id); }
      }
      out[file] = merged;
      entry.files[file] = { added, overridden };
    }
    report.packs.push(entry);
  }
  linkWorkshopStages(out, report);
  mergeWorkshopVoices(out, packs, report);
  mergeWorkshopSupport(out, packs, report);
  for (const list of Object.values(report.added)) list.sort();
  for (const list of Object.values(report.overridden)) list.sort();
  return { data: out, report };
}

/**
 * Publish every pack's voice lines to the client by extending `assets.audio.voice` — the manifest the client looks an
 * operator's line up in (public/js/audio.js `voice()`), which the HTTP layer then serves merged
 * (server/index.js `buildWorkshopDataFiles` + `workshopTouchedFiles`).
 *
 * APPEND, never replace: a pack that adds lines to an operator the official data already has keeps both, and
 * `pickVoiceLine` picks among them. Mutates `data` (a fresh copy) and records the counts in `report.voices`.
 *
 * An install without `data/assets.json` (the asset pipeline was never run) has no audio at all, so there is nowhere to
 * publish to: that is reported rather than silently dropped.
 */
function mergeWorkshopVoices(data, packs, report) {
  const index = workshopVoiceIndex(packs);
  const chars = Object.keys(index);
  if (!chars.length) return;
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of Array.isArray(packs) ? packs : []) {
      if (!isPlainObj(pack?.voices) || !Object.keys(pack.voices).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'audio.voice',
        reason: 'this pack declares voice lines, but data/assets.json is missing — run `npm run assets` so the client has an audio manifest to extend',
      });
    }
    return;
  }
  const audio = isPlainObj(assets.audio) ? { ...assets.audio } : {};
  const voice = isPlainObj(audio.voice) ? { ...audio.voice } : {};
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [charId, slots] of Object.entries(index)) {
    const lines = isPlainObj(voice[charId]) ? { ...voice[charId] } : {};
    for (const [slot, urls] of Object.entries(slots)) {
      const official = Array.isArray(lines[slot]) ? lines[slot] : [];
      lines[slot] = [...new Set([...official, ...urls])];
    }
    voice[charId] = lines;
  }
  // per pack, so the boot log says WHICH pack brought lines (and a pack that adds none is not credited)
  for (const pack of Array.isArray(packs) ? packs : []) {
    let n = 0;
    for (const slots of Object.values(isPlainObj(pack?.voices) ? pack.voices : {})) {
      for (const files of Object.values(isPlainObj(slots) ? slots : {})) if (Array.isArray(files)) n += files.length;
    }
    if (n) counts[pack.id] = n;
  }
  data.assets = { ...assets, audio: { ...audio, voice } };
  report.voices = counts;
}

/**
 * Make newly added STAGES selectable.
 *
 * A stage only enters a match when the mode's `stages` list names it (server/match/waves.js picks among those by
 * `weight`) — and `config` is deliberately NOT a workshop-contributable file, because a pack that could rewrite config
 * could rewrite the economy and the round schedule. So instead of letting a pack ship a config overlay, the loader
 * honours the stage's OWN `modes` list by APPENDING its id to those mode entries. Nothing else in `config` is ever
 * written, and only stages the pack actually added are linked.
 *
 * Mutates `data.config` (a fresh copy) and records each link in `report.linkedStages` so the boot log can show it.
 */
function linkWorkshopStages(data, report) {
  const added = Array.isArray(report.added.stages) ? report.added.stages : [];
  if (!added.length || !isPlainObj(data.stages) || !isPlainObj(data.config) || !isPlainObj(data.config.modes)) return;
  const modes = { ...data.config.modes };
  let touched = false;
  for (const id of added) {
    const stage = data.stages[id];
    const declared = stage && Array.isArray(stage.modes) ? stage.modes : [];
    for (const modeId of declared) {
      const mode = modes[modeId];
      if (!isPlainObj(mode)) continue;
      const list = Array.isArray(mode.stages) ? mode.stages.slice() : [];
      if (list.includes(id)) continue;
      list.push(id);
      modes[modeId] = { ...mode, stages: list };
      touched = true;
      (report.linkedStages ||= []).push(`${id} -> ${modeId}`);
    }
  }
  if (touched) data.config = { ...data.config, modes };
}

/**
 * One-line summary of a merge report for the boot log / `--doctor`.
 * @param {ReturnType<typeof applyWorkshop>['report']} report
 */
export function workshopSummary(report) {
  if (!report || !Array.isArray(report.packs) || !report.packs.length) return 'no workshop packs';
  const parts = report.packs.map((p) => {
    const bits = [];
    const files = Object.entries(p.files).filter(([, n]) => n.added || n.overridden)
      .map(([f, n]) => `${f} +${n.added}${n.overridden ? ` ~${n.overridden}` : ''}`);
    if (files.length) bits.push(files.join(', '));
    const voices = report.voices && report.voices[p.id];
    if (voices) bits.push(`${voices} voice line${voices === 1 ? '' : 's'}`);
    const support = report.support && report.support[p.id];
    if (support) bits.push(`助战 +${support.length}`);
    return `${p.name}(${p.id}): ${bits.length ? bits.join(', ') : 'nothing'}`;
  });
  if (report.supportOff) parts.push('助战 pool contributions off (support.json "workshop": false)');
  if (report.errors.length) parts.push(`${report.errors.length} rejected record(s)`);
  return parts.join('; ');
}
