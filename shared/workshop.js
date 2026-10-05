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
/** Record ids follow the wire-id charset (shared/protocol.js isId) so an id can travel in a message. */
const RECORD_ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

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
export function normalizePackManifest(raw, dirName = '') {
  if (!isPlainObj(raw)) return fail('BAD_MANIFEST', 'pack.json must be a JSON object');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : dirName;
  if (!PACK_ID_RE.test(id)) return fail('BAD_PACK_ID', `"${id}" is not a valid pack id (letters, digits, _ and - only)`);
  if (dirName && typeof raw.id === 'string' && raw.id && raw.id !== dirName) {
    return fail('PACK_ID_MISMATCH', `pack.json id "${raw.id}" does not match its directory "${dirName}"`);
  }
  const content = Array.isArray(raw.content)
    ? [...new Set(raw.content.filter((f) => typeof f === 'string' && WORKSHOP_CONTENT_FILES.includes(f)))].sort()
    : [];
  if (!content.length) {
    return fail('EMPTY_PACK', `content must name at least one of: ${WORKSHOP_CONTENT_FILES.join(', ')}`);
  }
  const overrides = Array.isArray(raw.overrides)
    ? [...new Set(raw.overrides.filter((o) => typeof o === 'string' && /^[a-z]+:[A-Za-z0-9_\-.:]{1,64}$/.test(o)))].sort()
    : [];
  return {
    ok: true,
    pack: {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      version: typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0',
      author: typeof raw.author === 'string' && raw.author ? raw.author : null,
      license: typeof raw.license === 'string' && raw.license ? raw.license : null,
      description: typeof raw.description === 'string' && raw.description ? raw.description : null,
      gameVersion: typeof raw.gameVersion === 'string' && raw.gameVersion ? raw.gameVersion : null,
      content,
      overrides,
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
  for (const list of Object.values(report.added)) list.sort();
  for (const list of Object.values(report.overridden)) list.sort();
  return { data: out, report };
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
    const files = Object.entries(p.files).filter(([, n]) => n.added || n.overridden)
      .map(([f, n]) => `${f} +${n.added}${n.overridden ? ` ~${n.overridden}` : ''}`);
    return `${p.name}(${p.id}): ${files.length ? files.join(', ') : 'nothing'}`;
  });
  if (report.errors.length) parts.push(`${report.errors.length} rejected record(s)`);
  return parts.join('; ');
}
