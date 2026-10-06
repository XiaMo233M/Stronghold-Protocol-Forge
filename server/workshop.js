// server/workshop.js — discover and load 创意工坊 packs from the `workshop/` directory (docs/WORKSHOP.md).
//
// Filesystem side of the feature; the format and the merge rule live in shared/workshop.js, and server/data.js applies
// the overlay. A missing `workshop/` directory is the NORMAL case for a plain install, so it is not an error: no packs
// means no overlay and the game behaves exactly as before. Anything that IS present but broken is reported (and
// skipped) rather than thrown — one bad pack must never stop a server from starting.
//
// This module only loads DATA. A pack's behaviour layer (`kits/<chessId>.js`) is JavaScript and is loaded separately
// and only by the server; it is out of scope for the data overlay (see the header of shared/workshop.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePackManifest, normalizeContentFile } from '../shared/workshop.js';

/** Default pack root: `<repo>/workshop`. */
export const WORKSHOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workshop');

/**
 * Load every pack under `dir`.
 * @param {string} [dir] pack root (default WORKSHOP_DIR)
 * @param {{ log?: { warn?: Function, info?: Function } | null }} [opts]
 * @returns {{ dir: string, present: boolean, packs: Array<{ id: string, name: string, version: string, dir: string,
 *   overrides: string[], files: Record<string, Record<string, object>> }>, errors: Array<{ pack: string, reason: string }> }}
 */
export function loadWorkshop(dir = WORKSHOP_DIR, { log = null } = {}) {
  /** @type {any[]} */
  const packs = [];
  /** @type {Array<{ pack: string, reason: string }>} */
  const errors = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    // no workshop directory: the normal, supported case
    return { dir, present: false, packs, errors };
  }
  for (const name of names) {
    const packDir = path.join(dir, name);
    let rawManifest;
    try {
      rawManifest = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
    } catch (e) {
      errors.push({ pack: name, reason: e && e.code === 'ENOENT' ? 'pack.json is missing' : `pack.json is unreadable: ${e.message}` });
      continue;
    }
    // a pack that ships its own art must declare a licence (shared/workshop.js ASSETS_NEED_LICENSE)
    const hasAssets = fs.existsSync(path.join(packDir, 'assets'));
    const manifest = normalizePackManifest(rawManifest, name, { hasAssets });
    if (!manifest.ok) {
      errors.push({ pack: name, reason: `${manifest.error}: ${manifest.detail}` });
      continue;
    }
    /** @type {Record<string, Record<string, object>>} */
    const files = {};
    for (const file of manifest.pack.content) {
      let json;
      try {
        json = JSON.parse(fs.readFileSync(path.join(packDir, `${file}.json`), 'utf8'));
      } catch (e) {
        errors.push({
          pack: name,
          reason: e && e.code === 'ENOENT' ? `${file}.json is declared in pack.json but missing` : `${file}.json is unreadable: ${e.message}`,
        });
        continue;
      }
      const content = normalizeContentFile(file, json);
      if (!content.ok) {
        errors.push({ pack: name, reason: `${file}.json: ${content.detail}` });
        continue;
      }
      files[file] = content.records;
    }
    // A pack whose every declared file failed to load contributes nothing: its errors are already reported, so it is
    // not listed as a loaded pack (an empty pack in the boot summary would only be noise). A pack that ships NO data
    // file at all is a different thing and IS loaded: the reserved 助战 voice pack carries only `voices`, which the
    // overlay publishes through assets.json (shared/workshop.js mergeWorkshopVoices).
    if (Object.keys(files).length || Object.keys(manifest.pack.voices || {}).length) {
      packs.push({ ...manifest.pack, dir: packDir, files });
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] ${e.pack}: ${e.reason}`);
  return { dir, present: true, packs, errors };
}

/**
 * The data files any loaded pack touches — the union of the files the packs ship. The HTTP layer must serve THOSE files
 * merged (official + packs); every other data file keeps the plain on-disk path.
 * @param {ReturnType<typeof loadWorkshop>} loaded
 * @returns {Set<string>}
 */
export function workshopTouchedFiles(loaded) {
  const out = new Set();
  for (const p of (loaded && loaded.packs) || []) {
    for (const f of Object.keys(p.files || {})) out.add(f);
    // Voice lines are merged into `assets` (shared/workshop.js mergeWorkshopVoices), so that file must be served merged
    // as well — a pack that only brings voices touches nothing else, and without this the browser would fetch the
    // on-disk assets.json and never hear the pack.
    if (p.voices && Object.keys(p.voices).length) out.add('assets');
  }
  return out;
}

/**
 * Load the BEHAVIOUR layer of every pack: `workshop/<pack>/kits/<chessId>.js` (docs/WORKSHOP.md §4).
 *
 * A kit module's default export is the function the sim calls — `(bb, chess, def) => Kit` — the contract
 * server/sim/content/kits/tierN.js already uses. It is injected per battle through `Battle opts.kits`, which takes
 * precedence over the built-in registry (server/sim/content/index.js setupUnitKit), so nothing global is mutated.
 *
 * TWO consumers, and they must agree:
 *   * the SERVER passes `kits` to the battles it runs itself (verification, takeover, SP_COMBAT=server);
 *   * the BROWSER cannot receive a function over the wire, so `modules` is a JSON-safe list of URLs that travels in the
 *     battle spec; public/js/battle/runner.js imports them and builds the same map. Shipping only the server half would
 *     make a client-simulated battle disagree with the server's re-computation and get its result rejected.
 *
 * Never throws: a kit that fails to import is reported and skipped.
 * @param {ReturnType<typeof loadWorkshop>} loaded
 * @param {{ log?: object|null, baseUrl?: string, knownIds?: Set<string>|null }} [opts] `knownIds` warns about a kit for
 *   an operator that does not exist (dead code) — pass the merged chess ids.
 * @returns {{ kits: Record<string, Function>, modules: Array<{ id: string, pack: string, url: string }>, errors: Array<{ pack: string, id: string, reason: string }> }}
 */
export async function loadWorkshopKits(loaded, { log = null, baseUrl = '/workshop-kits', knownIds = null } = {}) {
  /** @type {Record<string, Function>} */
  const kits = {};
  /** @type {Array<{ id: string, pack: string, url: string }>} */
  const modules = [];
  /** @type {Array<{ pack: string, id: string, reason: string }>} */
  const errors = [];
  for (const pack of (loaded && loaded.packs) || []) {
    const kitDir = path.join(pack.dir, 'kits');
    if (!fs.existsSync(kitDir)) continue;
    /** Chess ids this pack itself contributes, and the official ids it declared it may replace. */
    const ownChess = new Set(Object.keys((pack.files && pack.files.chess) || {}));
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    for (const name of fs.readdirSync(kitDir).sort()) {
      if (!name.endsWith('.js')) continue;
      const id = name.slice(0, -'.js'.length);
      const file = path.join(kitDir, name);
      if (Object.hasOwn(kits, id)) { errors.push({ pack: pack.id, id, reason: 'another pack already defines this kit id' }); continue; }
      if (knownIds && !knownIds.has(id)) {
        errors.push({ pack: pack.id, id, reason: 'no chess record carries this id, so the kit would never be used' });
        continue;
      }
      // The behaviour layer obeys the same rule as the data layer: replacing an OFFICIAL operator's kit is a declared
      // act. Without this, a pack could rewrite official combat behaviour server-wide with no `overrides` entry.
      if (!ownChess.has(id) && !declared.has(`chess:${id}`)) {
        errors.push({
          pack: pack.id, id,
          reason: `this pack ships no chess record with this id — replacing an official operator's kit requires "chess:${id}" in pack.json overrides`,
        });
        continue;
      }
      try {
        // the mtime both defeats the server-side ESM cache AND versions the URL, so a browser that already loaded the
        // module imports the new one instead of running a stale kit against a server that verifies with the new code
        const v = Math.round(fs.statSync(file).mtimeMs);
        const mod = await import(`${pathToFileURL(file).href}?v=${v}`);
        const fn = typeof mod.default === 'function' ? mod.default : (typeof mod.kit === 'function' ? mod.kit : null);
        if (!fn) {
          errors.push({ pack: pack.id, id, reason: 'the module must default-export the kit function (bb, chess, def) => Kit' });
          continue;
        }
        kits[id] = fn;
        modules.push({ id, pack: pack.id, url: `${baseUrl}/${pack.id}/${name}?v=${v}` });
      } catch (e) {
        errors.push({ pack: pack.id, id, reason: `import failed: ${String(e && e.message ? e.message : e)}` });
      }
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] kit ${e.pack}/${e.id}: ${e.reason}`);
  return { kits, modules, errors };
}
