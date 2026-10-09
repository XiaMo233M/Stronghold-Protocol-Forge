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
import { WORKSHOP_MEDIA_PREFIX, WORKSHOP_RESOURCE_PREFIX, byPackId } from '../../shared/workshop.js';
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
 * Map each **C-layer panel module URL** to the file on disk that serves it (`pack.json.client.panels[].module`,
 * DESIGN §28.8). Built from the LOADED panel list only, exactly like `workshopKitFilesFor`: a request can never name a
 * path this map does not already hold, so the registration point does not turn the game server into a file server.
 *
 * The map key is the DECODED path (the loader percent-encodes each module segment, `server/http/static.js` compares
 * against `decodeURIComponent(rawPath)`), and a module whose bytes are not a `.js` file never enters it — the same line
 * `/workshop-assets` draws from the other side (that route serves media and refuses `.js`; this one serves code and
 * serves nothing else).
 * @param {Array<{ pack: string, module: string, url: string }>} panels the list `loadWorkshopPanels` built
 * @param {string} workshopDir
 * @returns {Map<string, string>}
 */
export function workshopPanelFilesFor(panels, workshopDir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  // `workshopDir: null` switches the whole feature off (tests, a clean server): never resolve a path from a missing root.
  if (typeof workshopDir !== 'string' || workshopDir === '') return out;
  const root = path.resolve(workshopDir);
  for (const p of Array.isArray(panels) ? panels : []) {
    if (!p || typeof p.url !== 'string' || typeof p.pack !== 'string' || typeof p.module !== 'string') continue;
    const raw = p.url.split('?')[0];
    if (!raw.endsWith('.js')) continue;
    let key = raw;
    try { key = decodeURIComponent(raw); } catch { /* an unencoded "%" in the declaration: key on the raw text */ }
    const rel = p.module.split('/');
    const bad = !rel.length || rel.some((s) => !s || s === '..' || s === '.' || s.startsWith('.'))
      || rel[rel.length - 1].length <= '.js'.length;
    if (bad) continue;
    const dir = path.join(root, p.pack);
    const abs = path.join(dir, ...rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) continue;
    out.set(key, abs);
  }
  return out;
}

/**
 * `routes[*].cache` 声明 → 真正的 `Cache-Control` 头。三种语义就是三种，一个不多一个不少（`shared/workshop.js`
 * `ROUTE_CACHE_POLICIES` 是那份闭枚举的唯一来源）：
 *   * `no-cache`（缺省）—— 可以存，但每次都要回来问（`/data/*.json` 那一类「随时会变」的东西）；
 *   * `no-store` —— 根本不存（清单里带凭据 / 一次性数据）；
 *   * `public` —— 公开可缓存一天，与包自己的素材（`/workshop-assets`）同一条策略：一次重新打包才会换内容。
 */
export const ROUTE_CACHE_HEADERS = Object.freeze({
  'no-cache': 'no-cache',
  'no-store': 'no-store',
  'public': 'public, max-age=86400',
});

/**
 * The read-only HTTP routes the installed packs declare (`pack.json.routes`, DESIGN §28.13,
 * docs/WORKSHOP.md §1.9): the declared absolute path → the file inside the pack that serves it.
 *
 * The shape layer (`shared/workshop.js parseRoutesDecl`) already refused everything that is not "an absolute path, a
 * pack-relative `.json`", but this is the **serving** side and it re-judges: the declaration it reads may come from a
 * hand-built loader object or from a pack written against an older schema. Nothing here ever writes, and traversal is
 * structurally impossible — only an exact declared path is answered, and the file is resolved by joining the pack
 * directory with the declared segments and then refusing anything that escapes it. `.js` / `.html` are refused here for
 * the same reason `/workshop-assets` refuses them: this channel is data, not code.
 *
 * Refusals are reported (`errors`) rather than thrown, and a route whose file is missing stays in the map **on
 * purpose**: serving it answers 404 instead of silently falling through to whatever the core static mount happens to
 * have at that path. Two packs declaring the same path: the smaller pack id wins (DESIGN §28.3's rule), and the loser
 * is reported — the same ordering rule the data overlay and the kit loader use.
 *
 * @param {{ packs?: Array<{ id: string, dir?: string, routes?: Array<{ path: string, file: string, cache?: string }> }> }} loaded
 * @param {string|null} workshopDir
 * @param {{ log?: object|null }} [opts]
 * @returns {{ routes: Map<string, { file: string, cache: string, pack: string }>, errors: Array<{ pack: string, path: string, reason: string }> }}
 */
export function workshopRoutesFor(loaded, workshopDir, { log = null } = {}) {
  /** @type {Map<string, { file: string, cache: string, pack: string }>} */
  const routes = new Map();
  /** @type {Array<{ pack: string, path: string, reason: string }>} */
  const errors = [];
  if (typeof workshopDir !== 'string' || workshopDir === '') return { routes, errors };
  const root = path.resolve(workshopDir);
  // 包 id 次序（DESIGN §28.3 的同一条规则）：一条路径被两个包声明时，谁赢不随装载器 / 调用方给的数组顺序变。
  for (const p of ((loaded && Array.isArray(loaded.packs)) ? loaded.packs : []).slice().sort(byPackId)) {
    if (!p || typeof p.id !== 'string' || !p.id || !Array.isArray(p.routes)) continue;
    const dir = p.dir ? path.resolve(p.dir) : path.join(root, p.id);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    for (const route of p.routes) {
      const rel = route && typeof route.file === 'string' ? route.file : '';
      const at = route && typeof route.path === 'string' ? route.path : String(route && route.path);
      const segments = rel.split('/');
      const bad = !route || typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.length < 2
        || route.path.includes('\\') || route.path.split('/').some((s) => s === '..' || s === '.')
        || path.isAbsolute(rel) || !rel.endsWith('.json') || segments.some((s) => s === '..' || s === '.');
      if (bad) {
        errors.push({ pack: p.id, path: at, reason: 'not a servable route: an absolute HTTP path and a pack-relative .json file (this channel never serves code or markup)' });
        continue;
      }
      const abs = path.join(dir, ...segments);
      if (abs !== dir && !abs.startsWith(dir + path.sep)) {
        errors.push({ pack: p.id, path: at, reason: `"${rel}" resolves outside the pack` });
        continue;
      }
      if (routes.has(route.path)) {
        errors.push({ pack: p.id, path: at, reason: `already declared by pack "${routes.get(route.path).pack}" (the smaller pack id wins, DESIGN §28.3)` });
        continue;
      }
      let exists = false;
      try { if (fs.statSync(abs).isFile()) exists = true; } catch { /* stays false: the route is kept, serving answers 404 */ }
      if (!exists) errors.push({ pack: p.id, path: at, reason: `"${rel}" is declared in pack.json but missing (the path is still served, as a 404)` });
      routes.set(route.path, {
        file: abs,
        cache: Object.hasOwn(ROUTE_CACHE_HEADERS, route.cache) ? route.cache : 'no-cache',
        pack: p.id,
      });
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] route ${e.pack} ${e.path}: ${e.reason}`);
  return { routes, errors };
}

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

/**
 * The **registered URLs** of a pack's declared resource container and manifest (`pack.json.assets`, DESIGN §28.13,
 * docs/WORKSHOP.md §1.9.4): `WORKSHOP_RESOURCE_PREFIX + <pack id> + <declared path>`, built from the LOADED packs only
 * — exactly the stance `workshopPanelFilesFor` and `workshopKitFilesFor` take, and the reason none of these routes can
 * be walked into a file server.
 *
 * Why a map and not a check: a declared path is compared to the request path **as a string**, so `..` cannot build a key
 * that is not in it. Traversal is not a boundary that can be got wrong here, it is a goal that does not exist.
 *
 * Both files are served from the same map and the entry says which is which (`kind`), because the difference matters on
 * the wire: the container is streamed and carries `X-SP-Resource-Sha256` (the digest the loader verified), the manifest
 * is an ordinary small `.json` table.
 *
 * The digest is NOT recomputed here: `assetsIssues` already hashed the container while gating the pack, and hashing a
 * few hundred megabytes twice at boot would be the one cost this feature cannot hide.
 * @param {Array<object>|{ packs?: Array<object> }} packs the loaded packs (`loadWorkshop(...)`) or the array itself
 * @param {string|null} workshopDir
 * @param {{ digests?: Map<string, string>|Record<string, string>|null }} [opts] pack id → verified container digest
 * @returns {Map<string, { kind: 'container'|'manifest', pack: string, file: string, url: string, sha256: string|null }>}
 */
export function workshopResourceFilesFor(packs, workshopDir, { digests = null } = {}) {
  /** @type {Map<string, { kind: 'container'|'manifest', pack: string, file: string, url: string, sha256: string|null }>} */
  const out = new Map();
  // `workshopDir: null` switches the whole workshop off (tests, a clean server): never resolve a path from a missing
  // root — the same rule workshopKitFilesFor / workshopPanelFilesFor / workshopRoutesFor follow.
  if (typeof workshopDir !== 'string' || workshopDir === '') return out;
  const root = path.resolve(workshopDir);
  const list = (packs && Array.isArray(packs.packs)) ? packs.packs : (Array.isArray(packs) ? packs : []);
  const digestOf = (id) => {
    if (!digests) return null;
    return (typeof digests.get === 'function' ? digests.get(id) : digests[id]) || null;
  };
  for (const p of list.slice().sort(byPackId)) {
    if (!p || typeof p.id !== 'string' || !p.id || !p.assets) continue;
    const dir = p.dir ? path.resolve(p.dir) : path.join(root, p.id);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    const hash = typeof p.hash === 'string' ? p.hash : '';
    for (const [kind, rel] of [['container', p.assets.container], ['manifest', p.assets.manifest]]) {
      if (typeof rel !== 'string' || !rel) continue;
      const segments = rel.split('/');
      // The shape layer refused everything else, but this is the SERVING side and it re-judges (it may read a
      // hand-built loader object or a pack written against an older schema) — the same second look every pack-scoped
      // route in this file takes.
      if (segments.some((s) => !s || s === '..' || s === '.' || s.startsWith('.')) || path.isAbsolute(rel)) continue;
      const abs = path.join(dir, ...segments);
      if (abs === dir || !abs.startsWith(dir + path.sep)) continue;
      const url = `${WORKSHOP_RESOURCE_PREFIX}${encodeURIComponent(p.id)}/${segments.map(encodeURIComponent).join('/')}?v=${hash.slice(0, 12)}`;
      out.set(url.split('?')[0], { kind, pack: p.id, file: abs, url, sha256: kind === 'container' ? digestOf(p.id) : null });
    }
  }
  return out;
}

/** `/assets/` 与 `/fonts/` —— `cache-only` 只对这两棵树短路：它们正是 `tools/fetch-assets.mjs` 落到
 *  `public/assets/**` 与 `public/fonts/**` 的那两个 git-ignored 目录（`.gitignore` 里点名的那两行）。 */
const CACHE_ONLY_PREFIXES = Object.freeze(['/assets', '/fonts']);

/** 一个请求路径是否落在 `cache-only` 覆盖的两棵树里（`/assets` 与 `/assets/…` 都算，缺尾斜杠的裸挂载也拦）。 */
export function isCacheOnlyPath(pathname) {
  const p = typeof pathname === 'string' ? pathname : '';
  return CACHE_ONLY_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/**
 * The process-wide **`serverPolicy` verdict**, derived from the load-time `assetsIssues` results.
 *
 * Two rules, and both are the whole point of the switch:
 *   * **`cache-only` only when a pack explicitly declares it.** `serve` — the default, and what every pack in this
 *     repository declares — leaves the server byte-for-byte unchanged. There is no environment variable and no global
 *     toggle: the one thing that can turn a deployment into cache-only is a pack's own `pack.json`.
 *   * **Any single `cache-only` declaration wins process-wide, and it is reported loudly.** The policy is a property of
 *     `/assets` and `/fonts` — two trees shared by every pack — not of one pack, so it cannot be scoped to the pack that
 *     asked for it. One pack declaring it therefore changes what every other pack and the core game sees, which is
 *     exactly the kind of surprise that has to appear in the boot log instead of in a bug report.
 * @param {Map<string, string>|Record<string, string>|null} policies pack id → declared `serverPolicy`
 * @param {{ log?: object|null }} [opts]
 * @returns {'serve'|'cache-only'}
 */
export function resourceServerPolicy(policies, { log = null } = {}) {
  const entries = policies && typeof policies.entries === 'function'
    ? [...policies.entries()]
    : Object.entries(policies || {});
  const cacheOnly = entries.filter(([, policy]) => policy === 'cache-only').map(([id]) => id).sort();
  if (!cacheOnly.length) return 'serve';
  log?.info?.(`[workshop] serverPolicy "cache-only" declared by ${cacheOnly.map((id) => `"${id}"`).join(', ')} — /assets/ and /fonts/ now answer 412 for the whole server, and the packs no longer serve them`);
  return 'cache-only';
}
