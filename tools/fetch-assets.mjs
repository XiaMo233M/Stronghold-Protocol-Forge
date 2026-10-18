#!/usr/bin/env node
// Downloads, post-processes and indexes every art/audio/font asset the game
// needs, from community dumps of the official client (research 07):
//   public/assets/**   images, Spine models, audio   (git-ignored)
//   public/fonts/**    Bender / Novecento (.otf/.ttf + .woff2) and fonts.css
//   data/assets.json   manifest used by the client (schema: docs/ASSETS.md)
//
// Enemy models no dump carries get another enemy's model (ASSETS.md "Enemy
// aliases"); the official ones the local client has (tools/local-extract/
// extract.py ENEMY_SPINES, optional) are added as `spineLocal` from the
// committed tools/assets/local-enemy-spines.json — never from the disk, so the
// manifest is the same with or without the extraction. The token (summon)
// models no dump carries (extract.py TOKEN_SPINES) likewise, from
// tools/assets/local-token-spines.json (ASSETS.md "Token models from the local
// client"). --local-spines rewrites both files from the extracted models (after
// a game update).
//
// Idempotent: existing files with the right size are skipped, so re-running is
// cheap. Downloads use ~16 parallel connections, 3 retries per direct source,
// a jsDelivr fallback and an opt-in GitHub proxy (one short attempt per URL).
// HTTP(S)_PROXY is picked up by restarting once with NODE_USE_ENV_PROXY=1
// (Node >=22.21 or >=24). An older Node warns and fetches directly, as before.
// Spine atlases get `size:` (and `pma: true` for enemies); every skeleton is
// parsed to resolve animation roles.
//
// The committed data/assets.json never shrinks by accident: an entry whose files
// are missing here is left out of a rebuilt manifest, so a run on a machine where
// some downloads failed (or whose upstream index lost them) would drop entries
// every other install still has. The run then keeps the current manifest, lists
// the entries it would drop and exits 1; --allow-shrink (or --prune) writes the
// smaller manifest.
//
// Every leaf the plan had resolved but no alternative of which is on disk is also
// reported on its own line — `[assets] N leaves dropped: no alternative on disk
// (…, audio.sfx.units.some_char.attack, …)` — and kept as `droppedLeaves` in the
// report, whether or not it shrinks the committed manifest: such a leaf is an
// entry the client loses (a sound that never plays), not a URL it falls back
// from. --strict (or SP_ASSETS_STRICT=1) turns those drops into exit code 1 for
// CI and packaging runs; by default the run only warns. No file is downloaded,
// dropped or kept differently either way, and a run whose files are all present
// produces the same manifest byte for byte.
//
// Beyond research 07's ids the plan covers what data/*.json adds: spawnable
// enemies / tokens (data/enemies.json, data/tokens.json), the 自选 owned-6★ picks
// of data/backups.json `units` (art from 07's URL patterns) and their summons
// (`tokens`), and the module type icons of every module in data/chess.json /
// data/backups.json (manifest `modules`).
//
// --add-only: for a checkout whose public/assets / public/fonts are shared with
// another one (a git worktree): download only the files missing on disk, never
// re-download, rewrite or delete an existing file (atlases already on disk are
// left as they are; fonts are not rebuilt — the manifest keeps its current
// `fonts`).
//
// Three transport knobs, all opt-in (a run without them behaves exactly as
// before, byte for byte):
//   --asset-base=<url>  download the files from another host that mirrors the
//                       raw.githubusercontent.com layout (a CDN). --index-base
//                       does the same for the three upstream indexes; the two are
//                       independent. A malformed URL is refused by name, never
//                       silently ignored.
//   --index-ttl=<hours> treat a cached index older than this as stale and
//                       re-download it; without it a parsable cache is used
//                       however old it is.
//   --cache-dir=<dir>   where .cache lives (the ledger, the report, the spine
//                       cache, the indexes); default .cache.
// An interrupted download resumes: the body streams into a stable `<file>.part`
// that the next run continues from with `Range` (when the source honours it), and
// the ledger records a sha256 that an existing file is checked against.
//
// Usage: node tools/fetch-assets.mjs [--concurrency=16] [--force] [--offline]
//                                    [--dry-run] [--refresh-index] [--prune]
//                                    [--allow-shrink] [--add-only] [--strict]
//                                    [--local-spines] [--no-optional-voice] [--help]

import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Downloader, PART_SUFFIX } from './assets/downloader.mjs';
import { restartForEnvProxy } from './assets/env-proxy.mjs';
import { MirrorPolicy, selectDownloadSource, validateSource } from './assets/network.mjs';
import { normalizeProxyPrefix, normalizeAssetBase, baseIsUntrusted, baseWarnings } from './assets/sources.mjs';
import { loadIndexes } from './assets/cache.mjs';
import { indexAudio, VOICE_DIRS } from './assets/audio.mjs';
import { buildPlan, charModesFromIndex, VOICE_OPTIONAL_TREES } from './assets/plan.mjs';
import {
  processModels, findLocalEnemyModels, findLocalTokenModels, localSpineMeta, loadLocalSpines, LOCAL_ENEMY_SPINES_FILE,
  LOCAL_TOKEN_SPINES_FILE, LOCAL_ENEMY_SPINE_DIR, LOCAL_TOKEN_SPINE_DIR,
} from './assets/spine.mjs';
import { collectLeaves, downloadLeaves, resolveTemplate, totalBytes, contentHash, droppedEntries, MANIFEST_VERSION } from './assets/manifest.mjs';
import { fontJobs, buildFonts } from './assets/fonts.mjs';
import { skelParserAvailable } from './assets/skel.mjs';
import { statsTemplateJobs } from './assets/stats-template.mjs';
import { SourceVerifier } from './assets/source-verifier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'public', 'assets');
const FONTS = join(ROOT, 'public', 'fonts');
const DEFAULT_CACHE_DIR = '.cache';
const MANIFEST = join(ROOT, 'data', 'assets.json');
/** Where the run's cache lives; `` main() `` replaces it from --cache-dir / SP_CACHE_DIR (default: `.cache`). */
let CACHE = join(ROOT, DEFAULT_CACHE_DIR);
/** The last run's report; `` main() `` replaces it together with CACHE. */
let REPORT = join(CACHE, 'assets-report.json');
/**
 * The local-client model overlays (spineLocal): the committed metadata file, where extract.py writes the models (under
 * public/assets), how to find them, and the file's `about` line.
 */
const LOCAL_SPINE_KINDS = {
  enemy: {
    file: LOCAL_ENEMY_SPINES_FILE, dir: LOCAL_ENEMY_SPINE_DIR, find: findLocalEnemyModels, what: 'enemy',
    about: 'Spine metadata of the enemy models only the local client has (tools/local-extract/extract.py ENEMY_SPINES); '
      + 'data/assets.json enemies[id].spineLocal. Written by node tools/fetch-assets.mjs --local-spines (docs/ASSETS.md "Enemy aliases").',
  },
  token: {
    file: LOCAL_TOKEN_SPINES_FILE, dir: LOCAL_TOKEN_SPINE_DIR, find: findLocalTokenModels, what: 'token',
    about: 'Spine metadata of the token (summon) models only the local client has (tools/local-extract/extract.py TOKEN_SPINES); '
      + 'data/assets.json tokens[id].spineLocal. Written by node tools/fetch-assets.mjs --local-spines (docs/ASSETS.md "Token models from the local client").',
  },
};

const HELP = `Usage: node tools/fetch-assets.mjs [options]
  --concurrency=N   parallel downloads (default 16)
  --asset-source=M  direct (default) or mirror (opt-in; no public-IP lookup)
  --force           re-download files even when present
  --source-snapshot=PATH verify raw bytes against pinned Git trees in a JSON snapshot
                    (incompatible with --offline / --add-only / --local-spines)
  --offline         no network: post-process what is on disk and rebuild data/assets.json
  --dry-run         print the plan and exit
  --refresh-index   re-download the audio_data.json / charword_table.json / models_data.json indexes
  --voice-lang=jp   the manifest's default operator battle voice dub: jp (default) | cn | en | kr
  --voice-langs=cn,jp,en,kr
                    download MORE dubs beside the default one (comma separated, cn | jp | en | kr). They land in
                    audio.voiceLangs[lang][charId][slot] and the game's 干员语音 setting lets each operator pick one.
                    Every dub is the same file names under its own folder: ≈ 2674 files / 66 MB per dub.
                    audio.voiceJp (upstream 0.2.2's 日本語 tree) is planned as well and is always the JP dub.
  --voice-all       plan every official voice slot, including the prep-only lines no battle plays
                    (干员报到 / 编入队伍 / 任命队长; 360 files / 19.3 MB more per run — off by default)
  --optional-voice  also plan upstream 0.3.0's extra dub trees beside audio.voiceLangs: audio.voiceEn / voiceKr /
                    voiceNative (the operator's own-language dub) and audio.voiceNativeLangType. Off by default
                    (--no-optional-voice is accepted for an upstream command line and means the same "off")
  --prune           delete files under public/assets that the manifest no longer references
                    (public/assets/local/** of tools/local-extract is never deleted); implies --allow-shrink
  --allow-shrink    write data/assets.json even when it loses entries the current one has
                    (without it such a run keeps the current manifest, lists the entries and exits 1)
  --strict          exit 1 when a leaf was dropped for having no file on disk (the report's
                    droppedLeaves: an entry the plan resolved and the client would lose, e.g. a
                    sound that never plays); by default such a drop is only reported
  --add-only        download only files missing on disk; never re-download, rewrite or delete an existing
                    file, no font rebuild (a worktree sharing public/assets and public/fonts)
  --local-spines    rewrite ${LOCAL_ENEMY_SPINES_FILE} and ${LOCAL_TOKEN_SPINES_FILE} from the
                    enemy and token models extracted by tools/local-extract/extract.py
                    (public/assets/local/spine/enemy/, public/assets/local/spine/token/)
  --asset-base=URL  download the files from another host that mirrors the
                    raw.githubusercontent.com layout (a CDN): the host/base is replaced, the
                    repository path is kept. Unset = the default sources, exactly as before
                    (SP_ASSET_BASE)
  --index-base=URL  the same for the three upstream indexes only (audio_data.json,
                    charword_table.json, models_data.json); independent of --asset-base
                    (SP_INDEX_BASE)
  --index-ttl=H     re-download a cached index older than H hours. Unset = never: a parsable
                    cache is used however old it is (SP_INDEX_TTL)
  --cache-dir=DIR   where the cache lives (ledger, report, spine cache, indexes). Relative paths
                    are from the repository root; default ${DEFAULT_CACHE_DIR} (SP_CACHE_DIR)
  --help            this text
Environment: SP_ASSET_SOURCE sets the default source; SP_GITHUB_PROXY sets the
HTTPS mirror prefix (default https://gh-proxy.com/; empty disables the proxy);
SP_ASSETS_STRICT=1 is the same as --strict (CI / packaging builds).
Mirror attempts have an 8 s response header timeout; response body has a separate idle timeout. Stops for this run after 3 consecutive
failures. Only explicitly enabled GitHub downloads use the third-party proxy.
An interrupted download resumes from its <file>.part (a source that does not honour
Range is safely re-downloaded whole); .part files are never pruned.`;

/**
 * True for the usual truthy spellings of a boolean environment variable (`1`, `true`, `yes`, `on`); empty, `0`,
 * `false`, `no` and `off` are false, and so is anything absent.
 * @param {string|undefined} value
 * @returns {boolean}
 */
function envFlag(value) {
  return typeof value === 'string' && value !== '' && !/^(0|false|no|off)$/i.test(value);
}

/**
 * Parse CLI flags.
 *
 * The four transport knobs (`--asset-base`, `--index-base`, `--index-ttl`, `--cache-dir`) are opt-in and default to
 * today's behaviour; a supplied base URL is validated here, so `--asset-base=https:/cdn` is refused by name instead of
 * being ignored silently. `parseArgs` never touches the network (tests import it).
 * @param {string[]} argv
 * @returns {{concurrency:number, force:boolean, offline:boolean, dryRun:boolean, refreshIndex:boolean, prune:boolean, allowShrink:boolean, strict:boolean, addOnly:boolean, localSpines:boolean, voiceLang:string, voiceLangs:string[], voiceAll:boolean, optionalVoice:boolean, help:boolean, source:string, assetBase:string, indexBase:string, indexTtl:number, cacheDir:string}}
 */
export function parseArgs(argv) {
  // `jp` is the default dub since 0.9.0 (the released bundle ships Japanese; shared/constants.js DEFAULT_VOICE_LANG):
  // a plain `npm run setup` must plan the same default the committed manifest names, or the two disagree.
  // `strict` 是上游 0.2.3 新增的（PR #421）：把「清单里有、磁盘上没有」的条目从警告升成退出码 1。
  const o = { concurrency: 16, force: false, offline: false, dryRun: false, refreshIndex: false, prune: false, allowShrink: false, strict: envFlag(process.env.SP_ASSETS_STRICT), addOnly: false, localSpines: false, voiceLang: 'jp', voiceLangs: [], voiceAll: false, optionalVoice: false, help: false, source: process.env.SP_ASSET_SOURCE || 'direct', assetBase: normalizeAssetBase(process.env.SP_ASSET_BASE, 'SP_ASSET_BASE'), indexBase: normalizeAssetBase(process.env.SP_INDEX_BASE, 'SP_INDEX_BASE'), indexTtl: parseTtl(process.env.SP_INDEX_TTL, 'SP_INDEX_TTL'), cacheDir: process.env.SP_CACHE_DIR || DEFAULT_CACHE_DIR, sourceSnapshot: '' };
  for (const a of argv) {
    const [k, v] = a.split('=');
    if (k === '--concurrency') o.concurrency = Math.max(1, Math.min(64, parseInt(v, 10) || 16));
    else if (k === '--asset-source') o.source = v;
    else if (k === '--source-snapshot') { if (!v) throw new Error('--source-snapshot requires a path'); o.sourceSnapshot = a.slice(k.length + 1); }
    else if (k === '--force') o.force = true;
    else if (k === '--offline') o.offline = true;
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--refresh-index') o.refreshIndex = true;
    else if (k === '--prune') o.prune = true;
    else if (k === '--allow-shrink') o.allowShrink = true;
    else if (k === '--strict') o.strict = true;
    else if (k === '--add-only') o.addOnly = true;
    else if (k === '--local-spines') o.localSpines = true;
    else if (k === '--asset-base') o.assetBase = normalizeAssetBase(v, '--asset-base');
    else if (k === '--index-base') o.indexBase = normalizeAssetBase(v, '--index-base');
    else if (k === '--index-ttl') o.indexTtl = parseTtl(v, '--index-ttl');
    else if (k === '--cache-dir') {
      if (!v) throw new Error(`--cache-dir needs a directory (default ${DEFAULT_CACHE_DIR})`);
      o.cacheDir = v;
    }
    else if (k === '--voice-lang') { if (!VOICE_DIRS[v]) throw new Error(`unknown --voice-lang ${v} (cn | jp | en | kr)`); o.voiceLang = v; }
    else if (k === '--voice-langs') {
      const list = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!list.length) throw new Error('--voice-langs needs a comma separated list (cn | jp | en | kr)');
      for (const l of list) if (!VOICE_DIRS[l]) throw new Error(`unknown --voice-langs entry ${l} (cn | jp | en | kr)`);
      o.voiceLangs = [...new Set(list)];
    }
    else if (k === '--voice-all') o.voiceAll = true;
    // upstream 0.3.0's extra dub trees (plan.mjs optionalVoice → audio.voiceEn / voiceKr / voiceNative). Off by default:
    // our manifest is the `voiceLangs` one, and turning these on adds the four dub trees to it (~180 MB on disk). The
    // upstream spelling is accepted too, so a command line written against upstream reads the same and means "off".
    else if (k === '--optional-voice') o.optionalVoice = true;
    else if (k === '--no-optional-voice') o.optionalVoice = false;
    else if (k === '--help' || k === '-h') o.help = true;
    else throw new Error(`unknown option ${a}\n${HELP}`);
  }
  if (o.addOnly && (o.prune || o.force)) throw new Error(`--add-only never deletes or rewrites files: not with --prune / --force\n${HELP}`);
  if (o.sourceSnapshot && (o.offline || o.addOnly || o.localSpines)) throw new Error('--source-snapshot is incompatible with --offline / --add-only / --local-spines');
  // An untrusted base (a plaintext mirror on the network) must not combine with a flag that shrinks the committed
  // manifest: --prune deletes files and implies --allow-shrink, so untrusted bytes would be allowed to cost every other
  // install the entries of data/assets.json. HTTPS or a loopback source keeps both flags available.
  if (!o.help) {
    for (const [flag, base] of [['--asset-base', o.assetBase], ['--index-base', o.indexBase]]) {
      if (!base || !baseIsUntrusted(base)) continue;
      if (o.prune) throw new Error(`untrusted ${flag} ${base} never prunes: --prune deletes files and rewrites data/assets.json from an unverified source`);
      if (o.allowShrink) throw new Error(`untrusted ${flag} ${base} never shrinks the manifest: an unverified source must not drop entries every other install has`);
    }
  }
  if (!o.help) validateSource(o.source);
  return o;
}

/**
 * Hours for `--index-ttl` / `SP_INDEX_TTL`. `0` and an unset variable both mean "never re-download on age" (today's
 * behaviour); a negative or non-numeric value is refused by name rather than silently treated as 0.
 * @param {string|undefined} value
 * @param {string} flag
 * @returns {number}
 */
export function parseTtl(value, flag = '--index-ttl') {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number of hours: ${value}`);
  return n;
}

/**
 * The cache directory of this run: `--cache-dir` / `SP_CACHE_DIR`, relative to the repository root (an absolute path is
 * used as it is), `.cache` by default.
 * @param {string} dir
 * @returns {string} absolute path
 */
export function resolveCacheDir(dir) {
  const d = String(dir || DEFAULT_CACHE_DIR);
  return isAbsolute(d) ? resolve(d) : resolve(ROOT, d);
}

export function resolveProxyPrefix(source, offline = false, value = process.env.SP_GITHUB_PROXY) {
  return offline || source !== 'mirror' ? '' : normalizeProxyPrefix(value);
}

/**
 * What data/backups.json and data/chess.json add to the asset plan: `extraOperators` — every unit of backups.json
 * (`{ name, subProfessionId, nationId, skills: [{ index, skillId, iconId }] }`; buildPlan plans those research 07 lacks,
 * the 自选 owned-6★ picks), `tokenIds` — the summons of the 自选 picks (backups.json `tokens`), `moduleTypes` — the type
 * icon of every module a chess or a unit form offers.
 * @param {any} backups data/backups.json (or null)
 * @param {any} chess data/chess.json (or null)
 */
export function dataExtras(backups, chess) {
  const extraOperators = {};
  const moduleTypes = new Set();
  for (const [id, u] of Object.entries(backups?.units || {})) {
    const skills = new Map();
    for (const f of Object.values(u.forms || {})) {
      for (const sk of f.skills || []) if (!skills.has(sk.index)) skills.set(sk.index, { index: sk.index, skillId: sk.skillId, iconId: sk.iconId || sk.skillId });
      for (const m of f.modules || []) if (m.typeIcon) moduleTypes.add(m.typeIcon);
    }
    extraOperators[id] = { name: u.name, subProfessionId: u.subProfessionId, nationId: u.nationId, skills: [...skills.values()].sort((a, b) => a.index - b.index) };
  }
  for (const c of Object.values(chess || {})) for (const m of c?.modules || []) if (m.typeIcon) moduleTypes.add(m.typeIcon);
  return { extraOperators, tokenIds: Object.keys(backups?.tokens || {}).sort(), moduleTypes: [...moduleTypes].sort() };
}

/**
 * The shrink guard of data/assets.json (header): the entries of the current manifest `prev` that `next` would drop,
 * and whether `next` may be written — always when nothing is dropped (or there is no current manifest), otherwise
 * only with --allow-shrink or --prune.
 * @param {object|null} prev
 * @param {object} next
 * @param {{allowShrink?:boolean, prune?:boolean}} opts
 * @returns {{dropped:string[], write:boolean}}
 */
export function shrinkGuard(prev, next, { allowShrink = false, prune = false } = {}) {
  const dropped = prev ? droppedEntries(prev, next) : [];
  return { dropped, write: dropped.length === 0 || !!allowShrink || !!prune };
}

/**
 * The one summary line for the leaves the plan had resolved but whose every alternative file is missing on disk
 * (resolveTemplate `droppedLeaves`). Each of them disappears from data/assets.json, so the client has no entry at all —
 * for a sound, silence that no "the client uses fallbacks" wording explains. Printed on every run, empty or not: a
 * green line is the check that nothing was dropped.
 * @param {string[]} droppedLeaves dotted template paths
 * @param {number} [max] how many paths the line names before "…"
 * @returns {string}
 */
export function leafDropSummary(droppedLeaves, max = 8) {
  const n = droppedLeaves.length;
  if (!n) return '[assets] no leaf dropped: every planned leaf has a file on disk';
  return `[assets] ${n} ${n === 1 ? 'leaf' : 'leaves'} dropped: no alternative on disk ` +
    `(${droppedLeaves.slice(0, max).join(', ')}${n > max ? ', …' : ''})`;
}

/**
 * The error line of a --strict / SP_ASSETS_STRICT run that dropped at least one leaf for having no alternative on
 * disk. CI and packaging runs pass --strict so a manifest with such holes cannot ship (the entry is gone from the
 * client's manifest; nothing retries it later, the next plain run only warns again).
 * @param {string[]} droppedLeaves dotted template paths
 * @param {number} [max] how many paths the line names before pointing at the report
 * @returns {string}
 */
export function strictLeafDropError(droppedLeaves, max = 10) {
  const n = droppedLeaves.length;
  return `ERROR: ${n} ${n === 1 ? 'leaf' : 'leaves'} dropped for having no alternative on disk ` +
    `(--strict / SP_ASSETS_STRICT=1): ${droppedLeaves.slice(0, max).join(', ')}` +
    `${n > max ? `, … (all ${n} in ${relative(ROOT, REPORT)})` : ''}`;
}

/**
 * Exit code of a finished run: 0 only when nothing failed — every required asset is present, no leaf was dropped
 * while --strict / SP_ASSETS_STRICT is on, and the manifest was written (the shrink guard keeps the current one when
 * the rebuild would lose entries).
 * @param {{requiredMisses?:number, droppedLeaves?:number, strict?:boolean, manifestWritten?:boolean}} o
 * @returns {number} 0 or 1
 */
export function runExitCode({ requiredMisses = 0, droppedLeaves = 0, strict = false, manifestWritten = true } = {}) {
  if (requiredMisses) return 1;
  if (strict && droppedLeaves) return 1;
  return manifestWritten ? 0 : 1;
}

/**
 * Files under public/assets the manifest does not reference (`--prune` deletes them). public/assets/local/** belongs to
 * tools/local-extract (data/local-assets.json) and is never an orphan: --prune used to delete all of it. An in-progress
 * download (`<file>.part`, the resume point of an interrupted run) is never an orphan either: --prune would otherwise
 * delete the bytes the next run continues from. Compared without
 * case: on Windows / macOS a listed path and a file whose name differs only in case are one file (module/WAH-Y.png on
 * disk serves the listed module/wah-y.png), which --prune must not delete.
 * @param {string[]} onDisk forward-slash paths relative to public/assets
 * @param {Iterable<string>} referenced the manifest's files, same form
 */
export function orphanFiles(onDisk, referenced) {
  const listed = new Set([...referenced].map((r) => r.toLowerCase()));
  return onDisk.filter((r) => !listed.has(r.toLowerCase()) && !r.startsWith('local/') && !r.endsWith(PART_SUFFIX));
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const log = (m) => console.log(m);

async function readJson(rel) {
  const p = join(ROOT, rel);
  try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { throw new Error(`cannot read ${rel}: ${e.message}`); }
}

async function writeJsonAtomic(path, value, indent) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(value, null, indent) + '\n');
  await rename(path + '.tmp', path);
}

/** All files under a directory, as forward-slash paths relative to it. */
async function listFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await listFiles(p, base, out);
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Remove fields that only make sense next to a resolved spine. */
function tidyManifest(m) {
  for (const e of Object.values(m.enemies || {})) if (!e.spine) delete e.spineAliasOf;
  for (const t of Object.values(m.tokens || {})) if (!t.spine) delete t.spineVariant;
  if (m.skillsById) {
    for (const [sid, iconId] of Object.entries(m.skillsById)) if (!m.skills?.[iconId]) delete m.skillsById[sid];
  }
  for (const c of Object.values(m.chars || {})) if (c.spine && !Object.keys(c.spine).length) delete c.spine;
}

/**
 * The extra dub trees (plan.mjs VOICE_OPTIONAL_TREES), resolved against the disk: a tree with no line on disk is
 * dropped, and `audio.voiceNativeLangType` keeps only the operators whose own-language dub landed.
 * @param {any} m resolved manifest body (mutated)
 */
export function tidyVoiceTrees(m) {
  const a = m?.audio;
  if (!a || typeof a !== 'object') return;
  for (const key of Object.keys(VOICE_OPTIONAL_TREES)) if (a[key] && !Object.keys(a[key]).length) delete a[key];
  if (a.voiceNativeLangType) {
    for (const id of Object.keys(a.voiceNativeLangType)) if (!a.voiceNative?.[id]) delete a.voiceNativeLangType[id];
    if (!Object.keys(a.voiceNativeLangType).length) delete a.voiceNativeLangType;
  }
}

function countStats(m, bytes, files) {
  const vals = (o) => Object.values(o || {});
  const spines = new Set();
  for (const c of vals(m.chars)) for (const s of vals(c.spine)) spines.add(s.skel);
  for (const e of vals(m.enemies)) if (e.spine) spines.add(e.spine.skel);
  for (const t of vals(m.tokens)) if (t.spine) spines.add(t.spine.skel);
  return {
    files,
    bytes,
    chars: Object.keys(m.chars || {}).length,
    charsWithBack: vals(m.chars).filter((c) => c.spine?.back).length,
    enemies: Object.keys(m.enemies || {}).length,
    enemiesWithSpine: vals(m.enemies).filter((e) => e.spine).length,
    tokens: Object.keys(m.tokens || {}).length,
    tokensWithSpine: vals(m.tokens).filter((t) => t.spine).length,
    spineModels: spines.size,
    bonds: Object.keys(m.bonds || {}).length,
    items: Object.keys(m.items || {}).length,
    bands: Object.keys(m.bands || {}).length,
    skills: Object.keys(m.skills || {}).length,
    modules: Object.keys(m.modules || {}).length,
    ui: Object.keys(m.ui || {}).length,
    sfxUnits: Object.keys(m.audio?.sfx?.units || {}).length,
    voiceChars: Object.keys(m.audio?.voice || {}).length,
    voiceLangs: Object.fromEntries(Object.entries(m.audio?.voiceLangs || {}).map(([l, t]) => [l, Object.keys(t || {}).length])),
    voiceJpChars: Object.keys(m.audio?.voiceJp || {}).length,
  };
}

/** Required assets whose absence makes the run fail (exit code 1). */
function requiredMisses(m, charIds) {
  const out = [];
  for (const id of charIds) {
    const c = m.chars?.[id];
    if (!c?.avatar) out.push(`${id}.avatar`);
    if (!c?.portrait) out.push(`${id}.portrait`);
    if (!c?.spine?.front) out.push(`${id}.spine.front`);
  }
  return out;
}

/**
 * Metadata of the local-client models of one kind (LOCAL_SPINE_KINDS: the committed file). With --local-spines it is
 * rewritten from the models extracted under public/assets/local/spine/<kind>/ (read only); otherwise extracted models
 * whose metadata differs from the committed one only get a warning — the manifest never depends on what this machine
 * extracted.
 * @param {{ localSpines: boolean, dryRun: boolean }} opts
 * @param {'enemy'|'token'} kind
 */
async function syncLocalSpines(opts, kind) {
  const k = LOCAL_SPINE_KINDS[kind];
  const committed = await loadLocalSpines(join(ROOT, k.file));
  const found = await k.find(ASSETS);
  if (!Object.keys(found).length) {
    if (opts.localSpines) log(`[local-spines] no extracted ${k.what} model under public/assets/${k.dir} — ${k.file} kept`);
    return committed;
  }
  const { meta, problems } = await localSpineMeta(ASSETS, found);
  for (const p of problems) log(`[local-spines] ${p}`);
  if (opts.localSpines && !opts.dryRun) {
    const models = { ...committed, ...meta };
    const sorted = Object.fromEntries(Object.keys(models).sort().map((id) => [id, models[id]]));
    await writeJsonAtomic(join(ROOT, k.file), { about: k.about, models: sorted }, 2);
    log(`[local-spines] ${Object.keys(meta).length} ${k.what} model(s) → ${k.file}`);
    return sorted;
  }
  for (const [id, m] of Object.entries(meta)) {
    if (JSON.stringify(m) !== JSON.stringify(committed[id])) log(`[local-spines] ${id}: the extracted model differs from ${k.file} (re-run with --local-spines to update it)`);
  }
  return committed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { log(HELP); return 0; }
  const t0 = Date.now();
  // --cache-dir / SP_CACHE_DIR: the ledger, the report, the spine cache and the indexes all move together.
  CACHE = resolveCacheDir(opts.cacheDir);
  REPORT = join(CACHE, 'assets-report.json');
  log(`[assets] root ${ROOT}`);
  if (CACHE !== join(ROOT, DEFAULT_CACHE_DIR)) log(`[cache] dir ${CACHE}`);
  if (opts.assetBase) log(`[network] 文件下载地址改用 ${opts.assetBase}（--asset-base）`);
  if (opts.indexBase) log(`[cache] 索引下载地址改用 ${opts.indexBase}（--index-base）`);
  // A plaintext base on a real network host says what it means; a loopback one is a local test source and stays quiet.
  for (const w of [...baseWarnings(opts.assetBase, '--asset-base'), ...baseWarnings(opts.indexBase, '--index-base')]) log(w);
  if (opts.indexTtl > 0) log(`[cache] 索引新鲜度 ${opts.indexTtl} h（--index-ttl）：更旧的缓存会重新下载`);
  if (!skelParserAvailable()) throw new Error('@pixi-spine/runtime-3.8 not found — run `npm install` first');

  const [assets07, ops03, enemies05, maps05] = await Promise.all([
    readJson('docs/research/07-assets.json'),
    readJson('docs/research/03-operators.json'),
    readJson('docs/research/05-enemies.json'),
    readJson('docs/research/05-maps.json'),
  ]);
  const proxyPrefix = resolveProxyPrefix(opts.source, opts.offline);
  const verifier = opts.sourceSnapshot ? new SourceVerifier(JSON.parse(await readFile(opts.sourceSnapshot, 'utf8'))) : undefined;
  const source = await selectDownloadSource({ mode: opts.source, offline: opts.offline, proxyPrefix, log, verified: !!verifier });
  const mirrorPolicy = new MirrorPolicy({ source, proxyPrefix, assetBase: opts.assetBase, log });
  const network = { source, proxyPrefix, mirrorPolicy, verifier };
  const { audioData, modelsData, charword } = await loadIndexes(ROOT, { refresh: opts.refreshIndex && !opts.offline, offline: opts.offline, ttlHours: opts.indexTtl, indexBase: opts.indexBase, cacheDir: CACHE, log, ...network });
  const audio = indexAudio(audioData);
  // Skill attack slots follow each operator's mode list when the local fx index is on disk (#679). It is a client
  // extract (public/assets is not in git); without it the plan keeps the filename-letter fallback.
  const fxIndexPath = join(ROOT, 'public', 'assets', 'local', 'fx', 'index.json');
  let charModes = null;
  if (existsSync(fxIndexPath)) {
    const fxIndex = JSON.parse(await readFile(fxIndexPath, 'utf8'));
    charModes = charModesFromIndex(fxIndex);
    log(`[fx] skill modes for ${charModes.size} operators`);
  } else {
    log('[fx] no local fx index — skill attack slots stay on the filename letter');
  }
  // The game data built by tools/build-data.mjs (when present) may reference more
  // spawnable enemies/tokens than research lists (e.g. 机变 enemy swaps): cover them too.
  const [dataEnemies, dataTokens, dataBosses, dataBackups, dataChess] = await Promise.all(
    ['data/enemies.json', 'data/tokens.json', 'data/bosses.json', 'data/backups.json', 'data/chess.json'].map((f) => readJson(f).catch(() => null)));
  const extras = dataExtras(dataBackups, dataChess);
  const extraHandbook = {};
  for (const b of Object.values(dataBosses || {})) if (b?.enemyKey && typeof b.handbookId === 'string') extraHandbook[b.enemyKey] = b.handbookId;
  const localEnemySpines = await syncLocalSpines(opts, 'enemy');
  const localTokenSpines = await syncLocalSpines(opts, 'token');
  const statsTemplate = await statsTemplateJobs(ROOT, { offline: opts.offline || opts.dryRun, log });
  const plan = buildPlan({
    assets07, ops03, enemies05, maps05, audio, modelsData, charword, voiceLang: opts.voiceLang,
    voiceLangs: opts.voiceLangs,
    // default: only the slots a battle can play (plan.mjs VOICE_BATTLE_SLOTS); --voice-all takes the whole official set
    voiceSlots: opts.voiceAll ? null : undefined,
    // --optional-voice: plan upstream's extra dub trees beside our `voiceLangs` model (off by default: see parseArgs)
    optionalVoice: opts.optionalVoice,
    extraEnemyIds: Object.keys(dataEnemies || {}),
    extraTokenIds: [...Object.keys(dataTokens || {}), ...extras.tokenIds],
    extraHandbook,
    localEnemySpines,
    localTokenSpines,
    extraOperators: extras.extraOperators,
    moduleTypes: extras.moduleTypes,
    statsTemplate,
    charModes,
  });
  const leaves = collectLeaves(plan.template);
  log(`[plan] ${leaves.length} files + ${plan.models.size} Spine models ` +
    `(${Object.keys(plan.template.chars).length} chars, ${Object.keys(plan.template.enemies).length} enemies, ` +
    `${Object.keys(plan.template.tokens).length} tokens, ${Object.keys(plan.template.ui).length} UI sprites, ` +
    `${Object.keys(plan.template.audio.sfx.units).length} units with SFX, ` +
    `${Object.keys(plan.template.audio.voice).length} operators with ${opts.voiceLang.toUpperCase()} voice` +
    `${opts.voiceLangs.length ? ` + dubs ${opts.voiceLangs.filter((l) => l !== opts.voiceLang).map((l) => l.toUpperCase()).join('/')}` : ''}, ` +
    `${Object.keys(plan.template.audio.voiceJp || {}).length} with JP voice)`);
  if (opts.dryRun) {
    for (const n of plan.notes) log(`  note: ${n}`);
    return 0;
  }

  const dl = new Downloader({
    root: ASSETS, ledgerPath: join(CACHE, 'assets-ledger.json'),
    concurrency: opts.concurrency, force: opts.force, keepExisting: opts.addOnly, log, ...network,
  });
  await dl.loadLedger();
  const downloadErrors = opts.offline ? [] : await downloadLeaves(leaves, dl, ASSETS, 'files');

  let current = null;
  if (existsSync(MANIFEST)) {
    try { current = JSON.parse(await readFile(MANIFEST, 'utf8')); } catch (e) { log(`[manifest] the current ${relative(ROOT, MANIFEST)} is unreadable (${e.message}): replaced`); }
  }

  // Fonts (--add-only: not rebuilt — public/fonts may be another checkout's; the manifest keeps its current entry)
  let fontErrors = [];
  let acceptedFonts;
  if (!opts.offline && !opts.addOnly) {
    const fdl = new Downloader({ root: FONTS, ledgerPath: join(CACHE, 'fonts-ledger.json'), concurrency: 4, force: opts.force, log, ...network });
    await fdl.loadLedger();
    await fdl.run(fontJobs(), 'fonts');
    acceptedFonts = fdl.accepted;
    dl.totals.bytesDownloaded += fdl.totals.bytesDownloaded;
    for (const k of ['ok', 'skip', 'miss', 'error']) dl.totals[k] += fdl.totals[k];
  }
  const fonts = opts.addOnly ? { files: {}, errors: [] } : await buildFonts(FONTS, log, {
    verified: !!verifier,
    ...(verifier ? { available: (rel) => acceptedFonts.has(rel) } : null),
  });
  fontErrors = fonts.errors;

  // Spine
  const spine = await processModels(plan.models, {
    root: ASSETS, dl, cachePath: join(CACHE, 'spine-info.json'), download: !opts.offline, log,
    ...(opts.addOnly ? { writable: (rel) => dl.written.has(rel) } : null),
  });

  // Manifest
  const resolved = resolveTemplate(plan.template, {
    root: ASSETS, spine: spine.entries, assetBase: opts.assetBase, sourceOf: (rel) => dl.ledger.files[rel]?.url,
    // A verified run publishes only what it verified. Bytes kept on disk from an earlier revision — or kept because the
    // snapshot API was down — stay as a retry, never as a URL the client is served (manifest.mjs `available`). Without a
    // snapshot every file on disk is published, exactly as before: `dl.accepted` is only consulted under a verifier.
    ...(verifier ? { available: (rel) => dl.accepted.has(rel) } : null),
  });
  const body = resolved.value;
  tidyManifest(body);
  // --optional-voice: drop a dub tree that resolved to nothing, and a voiceNativeLangType whose operator lost its tree
  // (a no-op without the flag: the keys are absent, so there is nothing to tidy).
  tidyVoiceTrees(body);
  const fontFaces = {};
  for (const [name, f] of Object.entries(fonts.files)) fontFaces[name] = f;
  body.fonts = opts.addOnly && current?.fonts ? current.fonts
    // A verified run publishes the stylesheet only when it just built one out of verified originals (`fonts.css` is the
    // content buildFonts returned above); unverified keeps today's rule exactly — the file on disk decides.
    : (verifier ? fonts.css : existsSync(join(FONTS, 'fonts.css'))) ? { css: '/fonts/fonts.css', faces: fontFaces } : { faces: fontFaces };
  const bytes = totalBytes(ASSETS, resolved.files);
  const manifest = {
    version: MANIFEST_VERSION,
    hash: contentHash(body),
    generator: 'tools/fetch-assets.mjs',
    stats: countStats(body, bytes, resolved.files.size),
    ...body,
  };
  const guard = shrinkGuard(current, manifest, opts);
  if (guard.write) await writeJsonAtomic(MANIFEST, manifest);

  // Orphans: files on disk that the manifest does not reference (e.g. after a mapping change).
  const orphans = orphanFiles(await listFiles(ASSETS), new Set([...resolved.files, ...dl.preserved]));
  if (opts.prune) for (const r of orphans) { try { await unlink(join(ASSETS, r)); } catch { /* ignore */ } }

  const charIds = Object.keys(assets07.operators || {});
  const required = requiredMisses(manifest, charIds);
  // Leaves the plan had resolved and the manifest loses here (no alternative of theirs on disk): reported on their own
  // line below and kept in the report, whether or not they shrink the committed manifest.
  const droppedLeaves = resolved.droppedLeaves;
  const report = {
    downloadedBytes: dl.totals.bytesDownloaded,
    totals: dl.totals,
    stats: manifest.stats,
    requiredMisses: required,
    droppedLeaves,
    misses: resolved.misses,
    downloadErrors, // leaves whose primary failed transiently (fallbacks not tried; re-run to retry)
    fallbacks: resolved.fallbacks,
    spineProblems: spine.problems,
    fontErrors,
    orphans: opts.prune ? [] : orphans,
    pruned: opts.prune ? orphans : [],
    manifestWritten: guard.write,
    droppedEntries: guard.dropped, // entries of the previous data/assets.json the rebuilt one lacks
    notes: plan.notes,
    // Where this run actually read from: a CDN base must be visible in the report, so a later reader can tell what a
    // public/assets tree was built from (empty strings = the default sources).
    sources: { assetBase: opts.assetBase, indexBase: opts.indexBase, cacheDir: relative(ROOT, CACHE), indexTtlHours: opts.indexTtl, untrustedBase: baseIsUntrusted(opts.assetBase) || baseIsUntrusted(opts.indexBase) },
  };
  await writeJsonAtomic(REPORT, report, 1);

  // Summary
  const s = manifest.stats;
  log('');
  log('=== fetch-assets summary ===');
  log(`downloaded this run : ${mb(dl.totals.bytesDownloaded)} (ok ${dl.totals.ok}, skipped ${dl.totals.skip}, missing ${dl.totals.miss}, errors ${dl.totals.error}` +
    `${dl.totals.sizeChanged ? `, ${dl.totals.sizeChanged} changed upstream` : ''})`);
  log(`on disk (manifest)  : ${mb(s.bytes)} in ${s.files} files`);
  log(`chars ${s.chars} (Back model ${s.charsWithBack}) · enemies ${s.enemies} (Spine ${s.enemiesWithSpine}) · tokens ${s.tokens} (Spine ${s.tokensWithSpine}) · Spine models ${s.spineModels}`);
  log(`bonds ${s.bonds} · items ${s.items} · bands ${s.bands} · skill icons ${s.skills} · UI ${s.ui} · units with SFX ${s.sfxUnits}`);
  const overlays = (o) => Object.values(o || {}).filter((e) => e?.spineLocal).length;
  log(`local-client models (spineLocal, drawn when extracted): enemies ${overlays(manifest.enemies)} · tokens ${overlays(manifest.tokens)}`);
  log(`operator battle voice: ${s.voiceChars} charIds, dub ${opts.voiceLang}` +
    `${Object.keys(s.voiceLangs || {}).length ? ` (+${Object.entries(s.voiceLangs).map(([l, n]) => `${l} ${n}`).join(', ')})` : ''}` +
    `${s.voiceJpChars ? ` · JP dub (audio.voiceJp): ${s.voiceJpChars} charIds` : ''}`);
  log(`fonts: ${Object.values(fonts.files).map((f) => f.woff2 || f.original).join(', ') || 'none'}`);
  if (opts.assetBase || opts.indexBase) {
    log(`sources             : files ${opts.assetBase || 'default'} · indexes ${opts.indexBase || 'default'} · cache ${relative(ROOT, CACHE)}`);
  }
  if (resolved.fallbacks.length) { log(`fallbacks used (${resolved.fallbacks.length}):`); for (const f of resolved.fallbacks.slice(0, 20)) log(`  ${f}`); }
  if (downloadErrors.length) log(`download errors (${downloadErrors.length}, re-run to retry): ${downloadErrors.slice(0, 10).join(', ')}`);
  log(leafDropSummary(droppedLeaves));
  if (resolved.misses.length) {
    log(`missing (${resolved.misses.length}, omitted from manifest; the client falls back only where the entry has another alternative):`);
    for (const m of resolved.misses.slice(0, 40)) log(`  ${m}`);
    if (resolved.misses.length > 40) log(`  … see ${REPORT}`);
  }
  if (spine.problems.length) { log(`spine notes (${spine.problems.length}):`); for (const p of spine.problems.slice(0, 20)) log(`  ${p}`); }
  for (const e of fontErrors) log(`font error: ${e}`);
  if (orphans.length) log(opts.prune ? `pruned ${orphans.length} unreferenced files` : `${orphans.length} unreferenced files on disk (run with --prune to delete)`);
  if (guard.dropped.length) {
    log(guard.write
      ? `data/assets.json lost ${guard.dropped.length} entries (${opts.prune ? '--prune' : '--allow-shrink'}):`
      : `ERROR: data/assets.json NOT written — it would lose ${guard.dropped.length} entries the current one has (their files are missing here):`);
    for (const k of guard.dropped) log(`  ${k}`);
    if (!guard.write) log('  re-run to retry the downloads (--refresh-index for the audio/model indexes), or pass --allow-shrink (or --prune) to write the smaller manifest');
  }
  log(`manifest: ${MANIFEST}${guard.write ? '' : ' (kept)'} · report: ${REPORT} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (required.length) log(`ERROR: ${required.length} required assets missing: ${required.slice(0, 10).join(', ')}`);
  if (opts.strict && droppedLeaves.length) {
    log(strictLeafDropError(droppedLeaves));
    log('  a plain run downloads them again (--refresh-index if the upstream index lost them); without --strict / SP_ASSETS_STRICT this is only a warning');
  }
  if (verifier && (dl.totals.error || fontErrors.length || downloadErrors.length)) return 1;
  return runExitCode({ requiredMisses: required.length, droppedLeaves: droppedLeaves.length, strict: opts.strict, manifestWritten: guard.write });
}

// run only as a script (tests import parseArgs / shrinkGuard)
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url && !restartForEnvProxy()) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[assets] FAILED: ${process.env.DEBUG ? e?.stack || e : e?.message || e}`);
    process.exitCode = 1;
  });
}
