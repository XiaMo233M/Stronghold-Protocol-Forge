// 创意工坊 (docs/WORKSHOP.md) — the HTTP half of the workshop overlay, moved here by the upstream 0.2.0 port that split
// server/index.js into server/http/*. server/index.js (startServer) builds these three things once per process and hands
// them to createStaticHandler (server/http/static.js), which serves:
//
//   * the /data/<file>.json bodies a pack touches, MERGED (official + packs) — so the browser's data (public/js/data.js)
//     and the server's (server/data.js) are the same object without data/*.json ever being rewritten;
//   * a pack's behaviour layer (kits/<operator id>.js) as an ES module, so the BROWSER runs the very code the server
//     runs — the server re-computes a client's battle with the same kits, so a browser that silently fell back to the
//     generic kit would produce a result the server rejects;
//   * a pack's OWN art under /workshop-assets/<pack>/<path>, read-only and allowlisted by extension.
//
// The repo ships no game assets (they are (c) Hypergryph / Yostar), so a pack that needs a custom sprite, icon or voice
// line carries it: the pack's author is the redistributor, which is why such a pack MUST declare a licence
// (shared/workshop.js ASSETS_NEED_LICENSE).

import fs from 'node:fs';
import path from 'node:path';
import { WORKSHOP_MEDIA_PREFIX } from '../../shared/workshop.js';
import { workshopTouchedFiles } from '../workshop.js';

/**
 * The `/data/<file>.json` bodies the HTTP layer must serve MERGED for a 创意工坊 pack (docs/WORKSHOP.md): one Buffer of
 * `JSON.stringify(merged)` per data file any pack touches — and an empty map when no pack is installed, which is the
 * normal case. Serving the merged object (rather than the file on disk) is what keeps the browser's data
 * (public/js/data.js) identical to the server's (server/data.js) without `data/*.json` ever being rewritten.
 * @param {Readonly<Record<string, any>>} data the loaded (already merged) game data
 * @param {ReturnType<import('../workshop.js').loadWorkshop>} workshop
 * @returns {Map<string, Buffer>}
 */
export function buildWorkshopDataFiles(data, workshop) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  if (!data || !workshop || !workshop.packs.length) return out;
  for (const file of workshopTouchedFiles(workshop)) {
    if (!Object.hasOwn(data, file) || data[file] == null) continue;
    out.set(file, Buffer.from(JSON.stringify(data[file]), 'utf8'));
  }
  return out;
}

/**
 * Map each kit module URL to the file on disk that serves it. Built from the LOADED modules only, so a request can
 * never name a path this map does not already hold — the game server must not become a general file server for the
 * sake of the behaviour layer.
 * @param {Array<{ id: string, pack: string, url: string }>} modules
 * @param {string} workshopDir
 * @returns {Map<string, string>}
 */
export function workshopKitFilesFor(modules, workshopDir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  // `workshopDir: null` is a documented way to switch the whole feature off (tests, a "clean" server): there are no
  // packs then, so there are no kit files either — never resolve a path from a missing directory.
  if (typeof workshopDir !== 'string' || workshopDir === '') return out;
  const root = path.resolve(workshopDir);
  for (const m of Array.isArray(modules) ? modules : []) {
    if (!m || typeof m.url !== 'string' || typeof m.pack !== 'string') continue;
    // The route matches the RAW path (the query is split off before serveStatic), so key on the path and drop the
    // `?v=` cache-buster the loader adds.
    const url = m.url.split('?')[0];
    out.set(url, path.join(root, m.pack, 'kits', path.basename(url)));
  }
  return out;
}

/** The URL prefix a pack's own art is served under (`<prefix><pack>/<path inside assets/>`). Shared with the overlay,
 * which writes the identical URLs for a pack's voice lines into the data the client reads. */
export const WORKSHOP_ASSET_PREFIX = WORKSHOP_MEDIA_PREFIX;

/**
 * The file types a pack's `assets/` folder may serve. Deliberately an allowlist: this route is reachable by any client,
 * and a `.js` or `.html` there would be code the page could be talked into executing (the kit route exists for code, and
 * it serves only modules the loader registered).
 */
export const WORKSHOP_ASSET_TYPES = Object.freeze(new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'], ['.ico', 'image/x-icon'],
  ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav'], ['.m4a', 'audio/mp4'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.json', 'application/json; charset=utf-8'], ['.atlas', 'text/plain; charset=utf-8'], ['.skel', 'application/octet-stream'],
]));

/**
 * The packs that have an `assets/` folder, keyed by pack id → the pack's directory.
 *
 * A pack's own art is the one thing the repo cannot ship (the game assets are (c) Hypergryph / Yostar and are never
 * committed), so a pack that needs a custom sprite carries it and the client fetches it from here. `license` is REQUIRED
 * for such a pack (shared/workshop.js): the redistributor of the art is the pack's author, and the manifest has to say
 * under what terms — the same stance as docs/WORKSHOP.md §5.
 *
 * @param {{ packs?: Array<{ id: string, dir?: string }> }} loaded `loadWorkshop(...)`
 * @param {string|null} workshopDir
 */
export function workshopAssetsFor(loaded, workshopDir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (typeof workshopDir !== 'string' || workshopDir === '') return out;
  const root = path.resolve(workshopDir);
  for (const p of (loaded && Array.isArray(loaded.packs)) ? loaded.packs : []) {
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    const dir = p.dir ? path.resolve(p.dir) : path.join(root, p.id);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    if (fs.existsSync(path.join(dir, 'assets'))) out.set(p.id, dir);
  }
  return out;
}
