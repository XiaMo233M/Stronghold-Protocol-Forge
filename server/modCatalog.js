// server/modCatalog.js — the CLIENT-FACING catalogue of the installed 创意工坊 packs (GET /mods/catalog.json).
//
// Why this exists: a browser cannot read the server's `workshop/` directory, so "which packs does this server have, and
// which files do I still need?" has to be published as data. The catalogue is the LIST; the bytes come from the routes
// in server/http/mods.js.
//
// THE ONE RULE of this module: a pack's identity and hash come from the `loadWorkshop()` result the server already
// computed — the very same object that feeds `welcome.mods` (server/index.js). Nothing here re-scans a pack directory to
// work out what a pack IS, so the catalogue and the wire identity cannot drift apart. What this module adds is the
// per-FILE inventory (`path` / `bytes` / `sha256`) and the contribution hash a client needs to rebuild the pack hash:
//
//   * `sha256`    sha256 of the file AS IT SITS ON DISK — what the client downloads and verifies, byte for byte;
//   * `canonical` the hash of that same file's CONTRIBUTION to the pack hash, taken from the loader's own manifest
//                 (server/workshop.js identifyPack): for `pack.json` and every declared content file that is
//                 sha256(canonicalJson(normalized records)), NOT the bytes on disk (the loader hashes the normalized
//                 form, so two spellings of one pack hash the same); for `kits/*.js` and `assets/**` it is the raw
//                 sha256, because that is what the loader hashed.
//
// With both, a client rebuilds the pack hash from its own local bytes using the SAME algorithm (shared/modIdentity.js
// modManifestDigest) without holding the loader's normalization code:
//
//     modManifestDigest(files.map((f) => ({ path: f.path, hash: f.canonical })))
//
// which is exactly what public/js/mods/sync.js localPackHash() does — and acceptance #1/#5 keep the two equal.
//
// The INVENTORY is the loader's manifest: those are the files that went into the hash, and nothing else is offered.
// A stray `README.md` or a `pack.json.bak` next to the manifest is not part of the pack, is not hashed by the loader, and
// is therefore neither listed here nor fetchable from the route — which also keeps this route from becoming a way to
// read arbitrary files an author happened to leave in the folder.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, modManifestDigest } from '../shared/modIdentity.js';
import { normalizePackManifest } from '../shared/workshop.js';

/**
 * Whether `rel` is a safe path INSIDE a pack directory: relative, no `..`, no absolute path, no backslash, no NUL.
 *
 * The loader's own rule (`shared/workshop.js` voice paths: no leading `/`, no `\`, no `.`/`..` segment, no drive letter)
 * is restated here rather than loosened: every path in the catalogue is later turned into a filesystem path, so it has
 * to survive the strictest reading. A leading `.` is NOT refused — the loader's own `assets/**` walk keeps dotfiles
 * (`server/workshop.js` listFiles), and `..` / `.` as whole segments are what actually escapes.
 * @param {unknown} rel
 * @returns {boolean}
 */
export function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel.length || rel.length > 1024) return false;
  if (rel.includes('\0') || rel.includes('\\')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split('/').some((seg) => seg === '' || seg === '..' || seg === '.');
}

/**
 * `sort()` is lexicographic on UTF-16 code units; the hash needs one fixed order that every machine agrees on.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The fields `normalizePackManifest` returns — i.e. exactly what `identifyPack` hashes as `pack.json`.
 *
 * `loadWorkshop` FLATTENS that object onto the pack entry (`{...manifest.pack, dir, files, ...identifyPack(...)}`,
 * server/workshop.js:92), so the normalized manifest is not reachable as a nested property, and two of its fields are
 * not even recoverable from the flattened form: `identifyPack` hashes the manifest BEFORE it derives `layer` / `combat`
 * (server/workshop.js:127 vs :145-146) and its result — the DERIVED value — is what the spread puts on the entry,
 * overwriting whatever the author declared. So `normalizedManifest` re-normalizes the raw `pack.json` instead of picking
 * fields off the entry; this list only exists to say what that normalization must produce, and the tests assert it.
 */
const MANIFEST_FIELDS = Object.freeze([
  'id', 'name', 'version', 'author', 'license', 'hasAssets', 'description', 'gameVersion', 'api', 'game', 'layer',
  'combat', 'content', 'overrides', 'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art', 'support',
]);

/** The route prefix a pack's own JSON is fetched from (`<prefix><pack>/<path inside the pack>`). */
export const MOD_FILE_PREFIX = '/mods/file/';

/** `pack.json` itself, the one file no other route serves (the kits and the art have their own). */
const PACK_MANIFEST_FILE = 'pack.json';

/**
 * The normalized manifest of a loaded pack — the exact object `identifyPack` hashed as `pack.json`.
 *
 * RECONSTRUCTED BY RE-NORMALIZING THE FILE, not by copying fields off the pack entry. That is deliberate and it is the
 * only correct way: the entry carries `identifyPack`'s DERIVED `layer` / `combat`, so copying them would hash
 * `"layer":"B"` where the loader hashed `"layer":null` and every pack with kits would fail to rebuild. Re-running the
 * loader's own normalizer (`shared/workshop.js`, imported read-only) reproduces the manifest by definition, and stays
 * right when that normalizer grows a field — no field list to keep in sync.
 *
 * `hasAssets` is the one input that is not in the file: the loader passes `fs.existsSync(packDir/assets)`, and the
 * flattened entry preserves the result, so it is fed back in.
 * @param {any} pack one entry of `loadWorkshop(...).packs`
 * @returns {Record<string, unknown>|null} null when the manifest cannot be re-read or re-normalized (never publish a hash
 *   this module cannot derive)
 */
export function normalizedManifest(pack) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(pack.dir, PACK_MANIFEST_FILE), 'utf8'));
  } catch {
    return null;
  }
  const result = normalizePackManifest(raw, pack.id, { hasAssets: pack.hasAssets === true });
  return result && result.ok ? result.pack : null;
}

/**
 * The on-disk path of one pack file, or null when `rel` would leave the pack's own directory.
 *
 * Every request that reaches this function has already been checked against the pack's file list, so this is the second
 * lock on the same door (the loader's rule, applied to a filesystem path rather than to a URL).
 * @param {any} pack one entry of `loadWorkshop(...).packs`
 * @param {string} rel
 * @returns {string|null}
 */
export function modFileAbs(pack, rel) {
  if (!safeRelPath(rel)) return null;
  const abs = path.join(pack.dir, ...rel.split('/'));
  return abs.startsWith(pack.dir + path.sep) ? abs : null;
}

/**
 * The bytes one file CONTRIBUTES to the pack hash.
 *
 * `pack.json` contributes the NORMALIZED manifest and a declared content file contributes its NORMALIZED records — that
 * is what `identifyPack` hashed, and hashing the raw bytes instead would give a different number. A kit or an asset
 * contributes its own bytes. This is the only place that knows the difference.
 * @param {any} pack one entry of `loadWorkshop(...).packs`
 * @param {string} rel
 * @returns {Buffer|null} null when `rel` is neither the manifest nor a declared content file
 */
function contributionBytes(pack, rel) {
  if (rel === PACK_MANIFEST_FILE) {
    const manifest = normalizedManifest(pack);
    return manifest ? Buffer.from(canonicalJson(manifest), 'utf8') : null;
  }
  const file = rel.endsWith('.json') ? rel.slice(0, -'.json'.length) : null;
  if (file && pack.files && Object.hasOwn(pack.files, file)) {
    return Buffer.from(canonicalJson(pack.files[file]), 'utf8');
  }
  return null;
}

/**
 * The file inventory of ONE loaded pack: the loader's manifest, in path order.
 *
 * `bytes` / `sha256` are read from the file itself (that is what a client downloads). `canonical` is the loader's own
 * contribution number — but it is RECOMPUTED here from the normalized form and required to equal it, so the catalogue
 * never publishes a number it cannot derive. A disagreement means the field list this module rebuilds the manifest from
 * (MANIFEST_FIELDS) no longer matches what the loader hashed, and the file is dropped rather than mis-described; the
 * invariant test in test/modCatalog.test.js turns that into a failure.
 * @param {any} pack one entry of `loadWorkshop(...).packs`
 * @returns {Array<{ path: string, bytes: number, sha256: string, canonical: string }>}
 */
export function catalogFiles(pack) {
  /** @type {Array<{ path: string, bytes: number, sha256: string, canonical: string }>} */
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(pack.manifest) ? pack.manifest : []) {
    if (!entry || !safeRelPath(entry.path) || typeof entry.hash !== 'string' || seen.has(entry.path)) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(pack.dir, ...entry.path.split('/')));
    } catch {
      continue; // the file went away between the load and now: the pack hash already covers it, so it is not offered
    }
    // the loader's contribution, and ours — recomputing it is what keeps this list honest about the pack hash
    const source = contributionBytes(pack, entry.path);
    const canonical = source ? sha256Bytes(source) : sha256Bytes(bytes);
    if (canonical !== entry.hash) continue;
    seen.add(entry.path);
    out.push({ path: entry.path, bytes: bytes.length, sha256: sha256Bytes(bytes), canonical });
  }
  return out.sort((a, b) => byPath(a.path, b.path));
}

/**
 * sha256 of some bytes, lowercase hex.
 *
 * `node:crypto`, not `shared/modIdentity.js sha256Hex`: the loader hashed the kits and the assets with the shared
 * function (server/workshop.js identifyPack → sha256Hex(Buffer)), and this catalogue's `sha256` is a claim about the
 * BYTES ON DISK — the number a client will reproduce from what it downloaded. `node:crypto` is that number by
 * definition; the shared pure-JS function is the browser's copy of it, and a copy is not the reference.
 * @param {Buffer|Uint8Array} bytes
 * @returns {string}
 */
function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The catalogue of one loaded pack. `hash` / `layer` / `combat` / `api` are read straight off the `loadWorkshop()` entry
 * — never recomputed — so the catalogue says exactly what `welcome.mods` says.
 * @param {any} pack one entry of `loadWorkshop(...).packs`
 * @returns {{ id: string, name: string, version: string, hash: string, layer: string, combat: boolean, api: string|null,
 *   files: Array<{ path: string, bytes: number, sha256: string, canonical: string }> }}
 */
export function loadOnePack(pack) {
  return {
    id: pack.id,
    name: typeof pack.name === 'string' && pack.name ? pack.name : pack.id,
    version: typeof pack.version === 'string' ? pack.version : '',
    hash: pack.hash,
    layer: pack.layer,
    combat: pack.combat === true,
    api: pack.api ?? null,
    files: catalogFiles(pack),
  };
}

/**
 * Build the whole catalogue from the loaded workshop.
 *
 * Sorted by pack id, so two servers with the same packs serve byte-identical catalogues (and a client's bookkeeping does
 * not depend on directory-read order). No packs → `{ packs: [] }`, the shape a client uses to decide "this server has
 * no mods, do nothing at all".
 * @param {ReturnType<import('./workshop.js').loadWorkshop>|null|undefined} loaded
 * @returns {{ packs: Array<{ id: string, name: string, version: string, hash: string, layer: string, combat: boolean,
 *   api: string|null, files: Array<{ path: string, bytes: number, sha256: string, canonical: string }> }> }}
 */
export function buildModCatalog(loaded) {
  const packs = Array.isArray(loaded?.packs) ? [...loaded.packs].sort((a, b) => byPath(a.id, b.id)) : [];
  return { packs: packs.map(loadOnePack) };
}

/**
 * Re-derive a pack hash from the catalogue's per-file contributions. The SERVER's own use of it is the invariant check:
 * `modManifestDigest(files.map(→ {path, canonical}))` must equal the pack's `hash`, or the catalogue is lying about
 * bytes a client is about to verify. It is the same call public/js/mods/sync.js localPackHash() makes from local bytes.
 * @param {Array<{ path: string, canonical: string }>} files
 * @returns {string}
 */
export function catalogPackHash(files) {
  return modManifestDigest((Array.isArray(files) ? files : []).map((f) => ({ path: f.path, hash: f.canonical })));
}
