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
import { normalizePackManifest, normalizeContentFile, byPackId, playtestUnknownIds } from '../shared/workshop.js';
import { sha256Hex, canonicalJson, modManifestDigest } from '../shared/modIdentity.js';
// `intercepts` 的运行时判据就是**真的装在这个服务器上的那份协议**（DESIGN §28.13）：A 段在形状层判过一次，这里再判
// 一次 —— 一份包声明可以比协议活得久（协议收窄了、包还是老写法），那时要在加载期点名拒绝，而不是「装了但拦不住」。
import { C2S } from '../shared/protocol.js';
// the kit import whitelist + the narrow rewrite (DESIGN §28.12). shared/ because the VALIDATOR reads the same table —
// the loader must reach the same verdict the editor did.
import { kitImportDeclarations, kitImportIssues, rewriteKitImports } from '../shared/kitImports.js';

/** Default pack root: `<repo>/workshop`. */
export const WORKSHOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workshop');

/** Repository root — the base a whitelisted specifier's workspace-relative file is resolved against. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A rewritten kit source as an importable module. `data:` and not a temp file: nothing is written to disk, and the
 * module still has a readable identity in a stack trace. `v` (the file's mtime) is appended as a `//#` comment so two
 * revisions of the same kit are two different URLs — the same cache-buster the real-path import carries as `?v=`.
 * @param {string} source rewritten source (every whitelisted specifier already a real `file:` URL)
 * @param {number} v the kit file's mtime, in ms
 */
const kitDataUrl = (source, v) =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(`${source}\n//# sourceURL=workshop-kit.js?v=${v}\n`)}`;

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
    // file at all is a different thing and IS loaded: the reserved 助战 voice pack carries only `voices` (or only
    // `voiceLangs`, for a dub other than the default one), and a pack may also bring only 盟约/装备图标 (`bondIcons` /
    // `itemIcons`) or only 外观素材 (`art`: avatars, portraits, spine models) or only 自选池声明 (`operators`) — all of
    // them are published through assets.json / backups.json by the overlay (shared/workshop.js mergeWorkshopVoices /
    // mergeWorkshopBondIcons / mergeWorkshopItemIcons / mergeWorkshopArt / mergeWorkshopOperators). Forgetting one of
    // them here would make that kind of pack load "successfully" and contribute nothing.
    //
    // The four middle-layer declarations (DESIGN §28.13) belong on this list for exactly that reason: a pack that
    // declares only `assets` / `client` / `server.preDispatch` / `routes` is a loaded pack whose identity the room
    // digest must carry, and `normalizePackManifest` has already refused it as EMPTY_PACK when the declaration is
    // empty. No behaviour reads them yet (A 段) — this only decides whether the pack EXISTS.
    if (Object.keys(files).length
      || Object.keys(manifest.pack.voices || {}).length
      || Object.keys(manifest.pack.voiceLangs || {}).length
      || Object.keys(manifest.pack.bondIcons || {}).length
      || Object.keys(manifest.pack.itemIcons || {}).length
      || Object.keys(manifest.pack.art || {}).length
      || Object.keys(manifest.pack.operators || {}).length
      || !!manifest.pack.assets || !!manifest.pack.client || !!manifest.pack.server || !!manifest.pack.routes) {
      // 试玩开关的名单必须点名本包真的有的 id：`normalizePackManifest` 只能查形状，成员资格要等 chess.json 读完。
      // 不查这一条，名单里一个写错的 id 就是**静默无效** —— 作者勾了、试玩里什么都没发生（这个缺口的老毛病）。
      const unknown = playtestUnknownIds(manifest.pack.playtest?.directToHand, manifest.pack.overrides, Object.keys(files.chess || {}));
      if (unknown.length) {
        errors.push({
          pack: name,
          reason: `PLAYTEST_UNKNOWN_CHESS: ${unknown.map((id) => `"${id}"`).join(', ')} — playtest.directToHand may only name a chess record THIS pack ships (or an official id this pack declares in overrides)`,
        });
        continue;
      }
      packs.push({ ...manifest.pack, dir: packDir, files, ...identifyPack(packDir, manifest.pack, files) });
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] ${e.pack}: ${e.reason}`);
  return { dir, present: true, packs, errors };
}

/**
 * The IDENTITY of one loaded pack (DESIGN §28.2): its content hash, its layer and its declared intent.
 *
 * The hash is computed from the pack's OWN bytes, as a sorted list of `[path, sha256]` pairs (the list itself is kept
 * as `manifest`, so a mismatch can be explained without re-hashing):
 *   * `pack.json` — the NORMALIZED manifest (`normalizePackManifest`'s output), so two spellings of the same pack hash
 *     the same and a declaration the loader silently dropped cannot hide behind the hash;
 *   * every declared content file — its NORMALIZED records (`normalizeContentFile`), the same thing the overlay merges;
 *   * every `kits/*.js` — the SOURCE TEXT, byte for byte: this is the code the server imports and the browser fetches,
 *     and a content hash that ignored it would say nothing about the one file that can change a battle;
 *   * every file under `assets/**` — the media the `/workshop-assets` route serves.
 * What is NOT in it: the pack's path on this machine, the mtime "version" that currently versions kit URLs, and any
 * engine code — the engine half of the identity is the declared `api` range (DESIGN §28.5).
 *
 * `layer` and `combat` are derived only when the pack did not declare them, and the derivations are deliberately
 * conservative: shipping `kits/` is layer B and may change a battle result (a kit is code on the battle bus), anything
 * else that only shapes the client (icons / art / voices) is C, and a plain data pack is A.
 * @param {string} packDir
 * @param {object} pack the normalized manifest
 * @param {Record<string, Record<string, object>>} files the normalized content files
 * @returns {{ hash: string, manifest: Array<{ path: string, hash: string }>, layer: string, combat: boolean, api: string|null, game: string|null }}
 */
export function identifyPack(packDir, pack, files) {
  /** @type {Array<{ path: string, hash: string }>} */
  const manifest = [];
  const addText = (rel, text) => manifest.push({ path: rel, hash: sha256Hex(text) });
  const addBytes = (rel, buf) => manifest.push({ path: rel, hash: sha256Hex(buf) });
  // 1. the normalized manifest
  addText('pack.json', canonicalJson(pack));
  // 2. the normalized content records
  for (const [file, records] of Object.entries(files || {})) addText(`${file}.json`, canonicalJson(records));
  // 3. the kit sources, 4. the pack's own media
  let kits = 0;
  const kitDir = path.join(packDir, 'kits');
  try {
    for (const name of fs.readdirSync(kitDir).sort()) {
      if (!name.endsWith('.js')) continue;
      const buf = fs.readFileSync(path.join(kitDir, name));
      addBytes(`kits/${name}`, buf);
      kits++;
    }
  } catch { /* no kits/ directory: an ordinary data pack */ }
  const assetsDir = path.join(packDir, 'assets');
  for (const rel of listFiles(assetsDir)) addBytes(`assets/${rel}`, fs.readFileSync(path.join(assetsDir, rel)));
  // the declared layer wins; the derivation is the fallback, and `combat` follows the artifact kind
  const hasMedia = ['voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art'].some((k) => Object.keys(pack[k] || {}).length > 0);
  const layer = pack.layer || (kits ? 'B' : hasMedia ? 'C' : 'A');
  const combat = pack.combat === null || pack.combat === undefined ? kits > 0 : pack.combat;
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { hash: modManifestDigest(manifest), manifest, layer, combat, api: pack.api || null, game: pack.game || pack.gameVersion || null };
}

/** Every file under `dir`, as sorted `rel` paths (recursive, '/'-separated); `[]` when the directory is not there. */
function listFiles(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
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
    for (const f of Object.keys(p.files || {})) {
      // `units` 是一个**例外**：`data/` 里没有顶层 `units.json`，那条干员记录的家是 `data/backups.json` 的
      // `units[charId]`（shared/workshop.js OVERLAY_TARGET_BY_FILE）。所以浏览器要拿到的**合并后**文件是
      // `backups.json`，不是 `units.json` —— 后者根本不在磁盘上，加进去只会让 HTTP 层去找一个不存在的文件。
      out.add(f === 'units' ? 'backups' : f);
    }
    // Voice lines are merged into `assets` (shared/workshop.js mergeWorkshopVoices — the default dub into
    // `audio.voice`, every other dub into `audio.voiceLangs`), so that file must be served merged as well — a pack that
    // only brings voices touches nothing else, and without this the browser would fetch the on-disk assets.json and
    // never hear the pack.
    if (Object.keys(p.voices || {}).length || Object.keys(p.voiceLangs || {}).length) out.add('assets');
    // 盟约图标同样并进 `assets`（mergeWorkshopBondIcons）—— 漏了这一步，浏览器会拿到磁盘上那份 assets.json，
    // 这条盟约就永远是圆点（而作者在编辑器里看到的是「已设置」）。
    if (p.bondIcons && Object.keys(p.bondIcons).length) out.add('assets');
    // 装备图标同样并进 `assets`（mergeWorkshopItemIcons，写的是 `assets.items`）—— 漏了这一步，浏览器会拿到磁盘上
    // 那份 assets.json，这件装备就永远是兜底图（而作者在编辑器里看到的是「已设置」）。
    if (p.itemIcons && Object.keys(p.itemIcons).length) out.add('assets');
    // 外观素材（mergeWorkshopArt：`assets.chars` / `assets.enemies` / `assets.tokens`）理由逐字相同 —— 这一行漏掉，
    // 服务端会说「包已加载」，而浏览器永远拿不到模型与头像（画出来还是一张菱形贴图）。
    // 两张扁平图标表（`art.skills` / `art.profSub` → `assets.skills` / `assets.prof.sub`，mergeWorkshopFlatArt）
    // 落的是同一个文件，所以它们已经在这次判断里了。
    if (p.art && Object.keys(p.art).length) out.add('assets');
    // 助战 pool entries are merged into `support` (mergeWorkshopSupport) — the browser picks 助战 from that file.
    if (p.support && p.support.length) out.add('support');
    // 自选池（mergeWorkshopOperators：`backups.diy.ownedPool` / `backups.diy.operators`）写的是 `backups.json`，
    // 所以那个文件必须合并后发给浏览器 —— 漏掉这一行，作者在编辑器里看到「已声明」，而自选界面上没有这个干员。
    if (p.operators && Object.keys(p.operators).length) out.add('backups');
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
 * Never throws: a kit that fails to import is reported and skipped. A kit-id collision between two packs is decided by
 * `byPackId` (DESIGN §28.3, the same rule the data overlay uses) and the report names the pack that holds the id.
 * @param {ReturnType<typeof loadWorkshop>} loaded
 * @param {{ log?: object|null, baseUrl?: string, knownIds?: Set<string>|null }} [opts] `knownIds` warns about a kit for
 *   an operator that does not exist (dead code) — pass the merged chess ids.
 * @returns {{ kits: Record<string, Function>, modules: Array<{ id: string, pack: string, url: string }>, errors: Array<{ pack: string, id: string, code: string, definedBy?: string, reason: string }> }}
 */
export async function loadWorkshopKits(loaded, { log = null, baseUrl = '/workshop-kits', knownIds = null } = {}) {
  /** @type {Record<string, Function>} */
  const kits = {};
  /** @type {Array<{ id: string, pack: string, url: string }>} */
  const modules = [];
  /** @type {Array<{ pack: string, id: string, code: string, definedBy?: string, reason: string }>} */
  const errors = [];
  /** kit id → the pack that loaded it, so a collision can name the holder instead of "another pack" (DESIGN §28.3). */
  const kitOwner = new Map();
  // THE ordering rule (DESIGN §28.3), the same comparator the data overlay uses: the smaller pack id wins a collision,
  // so which pack's kit survives never depends on the order the packs were discovered in.
  for (const pack of ((loaded && loaded.packs) || []).slice().sort(byPackId)) {
    const kitDir = path.join(pack.dir, 'kits');
    if (!fs.existsSync(kitDir)) continue;
    /** Chess ids this pack itself contributes, and the official ids it declared it may replace. */
    const ownChess = new Set(Object.keys((pack.files && pack.files.chess) || {}));
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    for (const name of fs.readdirSync(kitDir).sort()) {
      if (!name.endsWith('.js')) continue;
      const id = name.slice(0, -'.js'.length);
      const file = path.join(kitDir, name);
      if (Object.hasOwn(kits, id)) {
        errors.push({
          pack: pack.id, id, code: 'KIT_ID_COLLISION', definedBy: kitOwner.get(id),
          reason: `kit "${id}" is already defined by pack "${kitOwner.get(id)}" — two packs must not ship the same kit id; rename this file, or drop one of the two packs`,
        });
        continue;
      }
      if (knownIds && !knownIds.has(id)) {
        errors.push({ pack: pack.id, id, code: 'KIT_NO_TARGET', reason: 'no chess record carries this id, so the kit would never be used' });
        continue;
      }
      // The behaviour layer obeys the same rule as the data layer: replacing an OFFICIAL operator's kit is a declared
      // act. Without this, a pack could rewrite official combat behaviour server-wide with no `overrides` entry.
      if (!ownChess.has(id) && !declared.has(`chess:${id}`)) {
        errors.push({
          pack: pack.id, id, code: 'KIT_OFFICIAL_OVERRIDE_UNDECLARED',
          reason: `this pack ships no chess record with this id — replacing an official operator's kit requires "chess:${id}" in pack.json overrides`,
        });
        continue;
      }
      try {
        // the mtime both defeats the server-side ESM cache AND versions the URL, so a browser that already loaded the
        // module imports the new one instead of running a stale kit against a server that verifies with the new code
        const v = Math.round(fs.statSync(file).mtimeMs);
        // IMPORT SURFACE (DESIGN §28.12): the loader reaches the SAME verdict as shared/kitAuthoring.js validateKit,
        // because both call kitImportIssues() — the editor must not pass something this loop then refuses.
        const source = fs.readFileSync(file, 'utf8');
        const decls = kitImportDeclarations(source);
        const imports = kitImportIssues(source, decls);
        if (imports.length) {
          errors.push({ pack: pack.id, id, code: imports[0].code, reason: imports[0].reason });
          continue;
        }
        // A kit with no import is loaded from its REAL PATH, exactly as before. A kit that imports is loaded from a
        // `data:` module: a relative specifier inside it could not resolve (`data:` has no directory), which is why the
        // whitelisted ones are rewritten to the real `file:` URLs first. Only whitelisted specifiers are touched, and
        // the rewrite never reaches the pack hash — identifyPack() hashes the bytes on disk (§28.2).
        const mod = decls.length === 0
          ? await import(`${pathToFileURL(file).href}?v=${v}`)
          : await import(kitDataUrl(rewriteKitImports(source, (rel) => pathToFileURL(path.join(ROOT, rel)).href), v));
        const fn = typeof mod.default === 'function' ? mod.default : (typeof mod.kit === 'function' ? mod.kit : null);
        if (!fn) {
          errors.push({ pack: pack.id, id, code: 'KIT_NO_DEFAULT_EXPORT', reason: 'the module must default-export the kit function (bb, chess, def) => Kit' });
          continue;
        }
        kits[id] = fn;
        kitOwner.set(id, pack.id);
        // `hash` is the pack's content hash (DESIGN §28.2): it rides along with the URL so the spec says WHICH bytes
        // the browser is supposed to be served, not just where to fetch them from.
        modules.push({ id, pack: pack.id, hash: pack.hash, url: `${baseUrl}/${pack.id}/${name}?v=${v}` });
      } catch (e) {
        errors.push({ pack: pack.id, id, code: 'KIT_IMPORT_FAILED', reason: `import failed: ${String(e && e.message ? e.message : e)}` });
      }
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] kit ${e.pack}/${e.id}: ${e.reason}`);
  return { kits, modules, errors };
}

/**
 * Load the **dispatch-time hook** of every pack that declares one: `pack.json.server.preDispatch`
 * (DESIGN §28.13, docs/WORKSHOP.md §1.9). This is the behaviour half of the declaration A 段 only parsed.
 *
 * What it does, per pack, in pack-id order (the DESIGN §28.3 rule, so which hook runs first never depends on the order
 * the packs were discovered in):
 *   * resolve `module` / `policy` **inside the pack** and require both files to exist — a declaration whose files are
 *     gone is a hook that silently does nothing, which is the failure mode this whole layer exists to remove;
 *   * parse `policy` as a JSON object (the hook's own data: the reference implementation's `admission-files.json`);
 *   * re-judge `intercepts` against the `C2S` of the protocol **actually loaded here** (A 段 judged the shape);
 *   * import the module and take its `createPreDispatch(deps)` factory (or a default export of the same shape).
 *
 * Every failure is **named** and reported, and that hook is not installed; the pack itself stays loaded (its data and its
 * identity are unaffected — `identifyPack` hashed the declaration whether or not the module runs). The refusal codes are
 * the ones A 段 fixed in `shared/workshop.js`, so an author sees the same name in the editor and on the server:
 * `PREDISPATCH_BAD_MODULE` / `PREDISPATCH_BAD_POLICY` / `PREDISPATCH_UNKNOWN_TYPE` (+ `PREDISPATCH_BAD_PATH` for a
 * declaration that resolves outside its own pack — defence in depth: the shape layer already refused those).
 *
 * Never throws: one unimportable hook must not stop a server from starting (the same stance as the data layer and
 * `loadWorkshopKits`).
 * @param {ReturnType<typeof loadWorkshop>} loaded
 * @param {{ log?: object|null, c2s?: Record<string, any> }} [opts] `c2s` defaults to the loaded protocol (tests inject a
 *   narrower catalogue to prove the runtime judgement is against the protocol, not against a copied list).
 * @returns {{ hooks: Array<{ pack: string, module: string, policyFile: string, policy: object, intercepts: string[], create: Function }>, errors: Array<{ pack: string, code: string, reason: string }> }}
 */
export async function loadWorkshopHooks(loaded, { log = null, c2s = C2S } = {}) {
  /** @type {Array<{ pack: string, module: string, policyFile: string, policy: object, intercepts: string[], create: Function }>} */
  const hooks = [];
  /** @type {Array<{ pack: string, code: string, reason: string }>} */
  const errors = [];
  const known = c2s && typeof c2s === 'object' ? c2s : {};
  for (const pack of ((loaded && loaded.packs) || []).slice().sort(byPackId)) {
    const decl = pack && pack.server && pack.server.preDispatch;
    if (!decl) continue;
    const dir = path.resolve(pack.dir || path.join(WORKSHOP_DIR, pack.id));
    const moduleAbs = path.join(dir, ...String(decl.module).split('/'));
    const policyAbs = path.join(dir, ...String(decl.policy).split('/'));
    const inside = (abs) => abs === dir || abs.startsWith(dir + path.sep);
    if (!inside(moduleAbs) || !inside(policyAbs)) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_PATH', reason: `server.preDispatch paths must resolve inside the pack (module "${decl.module}", policy "${decl.policy}")` });
      continue;
    }
    const readable = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
    if (!readable(moduleAbs)) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_MODULE', reason: `server.preDispatch.module "${decl.module}" is not a readable file inside the pack` });
      continue;
    }
    if (!readable(policyAbs)) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" is not a readable file inside the pack` });
      continue;
    }
    let policy;
    try {
      policy = JSON.parse(fs.readFileSync(policyAbs, 'utf8'));
    } catch (e) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" is not readable JSON: ${e && e.message ? e.message : String(e)}` });
      continue;
    }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" must be a JSON object (the hook's own data)` });
      continue;
    }
    // 运行时那一半：声明可以比协议活得久。名单里有协议不认识的名字 → 整个钩子被点名拒绝（不是静默丢掉那一条 ——
    // 静默丢掉就是一道只拦一部分入口的闸门，正是这个缺口要修的东西）。
    const unknown = (Array.isArray(decl.intercepts) ? decl.intercepts : []).filter((t) => typeof t !== 'string' || !Object.hasOwn(known, t));
    if (unknown.length) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_UNKNOWN_TYPE', reason: `server.preDispatch.intercepts: ${unknown.map((t) => `"${String(t)}"`).join(', ')} — not a message type of the protocol this server runs (shared/protocol.js C2S)` });
      continue;
    }
    let mod;
    try {
      // mtime 既打败服务端 ESM 缓存，又让两个版本的模块是两个 URL（与 loadWorkshopKits 同一条理由）。
      const v = Math.round(fs.statSync(moduleAbs).mtimeMs);
      mod = await import(`${pathToFileURL(moduleAbs).href}?v=${v}`);
    } catch (e) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_MODULE', reason: `server.preDispatch.module "${decl.module}" failed to import: ${e && e.message ? e.message : String(e)}` });
      continue;
    }
    const create = typeof mod.createPreDispatch === 'function' ? mod.createPreDispatch
      : (typeof mod.default === 'function' ? mod.default : null);
    if (!create) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_MODULE', reason: `server.preDispatch.module "${decl.module}" must export createPreDispatch(deps) (or default-export that function)` });
      continue;
    }
    hooks.push({ pack: pack.id, module: decl.module, policyFile: decl.policy, policy, intercepts: [...decl.intercepts], create });
  }
  for (const e of errors) log?.warn?.(`[workshop] hook ${e.pack}: ${e.code}: ${e.reason}`);
  return { hooks, errors };
}
