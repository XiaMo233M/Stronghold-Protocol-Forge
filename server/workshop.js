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
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  normalizePackManifest, normalizeContentFile, byPackId, playtestUnknownIds, WORKSHOP_PANEL_PREFIX,
  ASSETS_FILE_CODES,
  // i18n（fanpack G-04）：**形状**在 shared/workshop.js 判（`parseI18nDecl`），**值**用同一个 `mergeWorkshopI18n` 判
  // —— 校验与合并是同一个函数，所以不可能出现「校验器放行的值，合并时被丢掉」。
  mergeWorkshopI18n, parsePackI18n,
} from '../shared/workshop.js';
import { sha256Hex, canonicalJson, modManifestDigest } from '../shared/modIdentity.js';
// `intercepts` 的运行时判据就是**真的装在这个服务器上的那份协议**（DESIGN §28.13）：A 段在形状层判过一次，这里再判
// 一次 —— 一份包声明可以比协议活得久（协议收窄了、包还是老写法），那时要在加载期点名拒绝，而不是「装了但拦不住」。
import { C2S } from '../shared/protocol.js';
// the kit import whitelist + the narrow rewrite (DESIGN §28.12). shared/ because the VALIDATOR reads the same table —
// the loader must reach the same verdict the editor did.
import { kitImportDeclarations, kitImportIssues, packRelativePath, rewriteKitImports } from '../shared/kitImports.js';
// 公告 / 鸣谢的装载期判据（DESIGN §28.15）：声明的 `.json` 在不在、是不是 JSON。合并体在 `server/index.js` 里经
// 既有的合并数据通道送出 —— 形状与判据只有一份，这个 import 就是那一份。
import { noticesIssues } from './notices.js';

/** Default pack root: `<repo>/workshop`. */
export const WORKSHOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workshop');

/** Repository root — the base a whitelisted specifier's workspace-relative file is resolved against. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `identifyPack` 的哈希清单里那一条**合成**路径：容器的 sha256（`pack.json.assets` 的容器，装载期已与字节核对）。
 * 它不可能与真实文件同名（见 `identifyPack` 里那一段），所以「有没有声明 `assets`」在身份哈希里是可判定的一件事。
 */
export const ASSETS_DIGEST_PATH = 'assets.container.sha256';

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
 * 读一份官方语言文件（`public/i18n/<code>.json`）—— 装载期与 HTTP 合并体共用的那一处读盘。
 * 读不出来一律 `null`（`mergeWorkshopI18n` 把 null base 当作「什么都还没有」，于是包的键全部算新增；
 * 这只会让冲突少报一条，不会让包被拒 —— 官方文件读不出来是这台机器的事，不是这个包的错）。
 * @param {string} lang
 * @returns {Record<string, any>|null}
 */
export function readUiLangFile(lang) {
  if (typeof lang !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,15}$/.test(lang)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'i18n', `${lang}.json`), 'utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Load every pack under `dir`.
 * @param {string} [dir] pack root (default WORKSHOP_DIR)
 * @param {{ log?: { warn?: Function, info?: Function } | null, c2s?: Record<string, any> }} [opts]
 *   `c2s` defaults to the loaded protocol and only decides whether a declared `server.preDispatch.intercepts`
 *   entry exists (tests inject a narrower catalogue to prove the load-time judgement is against the protocol
 *   actually installed, not against a copied list — the same injection `loadWorkshopHooks` takes).
 * @returns {{ dir: string, present: boolean, packs: Array<{ id: string, name: string, version: string, dir: string,
 *   overrides: string[], files: Record<string, Record<string, object>> }>, errors: Array<{ pack: string, reason: string }> }}
 */
export function loadWorkshop(dir = WORKSHOP_DIR, { log = null, c2s = C2S } = {}) {
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
      || !!manifest.pack.assets || !!manifest.pack.client || !!manifest.pack.server || !!manifest.pack.routes
      || !!manifest.pack.i18n || !!manifest.pack.notices) {
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
      // C 层面板（`pack.json.client.panels`, DESIGN §28.8/§28.13, docs/WORKSHOP.md §1.9.3）：声明的模块必须**真的
      // 在包里**、是 `.js`、解析得到包目录里面。这就是本刀的纪律裁决 —— **声明了却不可用的声明拒绝整个包**，
      // 而不是「包照旧加载、只是那个面板不出现」。后者会让作者与服务端都以为自己有客户端界面，而浏览器里什么都
      // 没有；B1 段的 `server.preDispatch` 只拒那个钩子，C 层这条线走得比它远，理由写在 DESIGN §28.13.3。
      const panelIssues = panelModuleIssues(manifest.pack, packDir);
      if (panelIssues.length) {
        errors.push({ pack: name, reason: `${panelIssues[0].code}: ${panelIssues[0].reason}` });
        continue;
      }
      // B3a 段把同一条纪律铺到另外两组声明上（DESIGN §28.13.3「一条声明一个不可用的声明拒绝整个包」）：
      //   * `assets` —— 容器 / 清单 / 声明的摘要必须真的在包里、且容器的字节必须**就是**那份摘要；
      //   * `server.preDispatch` —— 模块 / 策略文件必须真的在包里、策略必须是 JSON 对象、`intercepts` 必须是
      //     本服务器真的装着的协议里的类型。
      // 这一改就是本刀要补的那个口子：B1 的钩子以前只拒钩子、包照旧加载 —— 于是服务器以为自己被准入闸门保护着，
      // 而实际上一条消息都没拦（「加载了但能力没生效」是最坏的失败形态）。
      const assetIssues = assetsIssues(manifest.pack, packDir);
      const hookIssues = preDispatchIssues(manifest.pack, packDir, { c2s });
      // i18n（fanpack G-04）：声明的译文文件必须真的在包里、是 JSON 对象、每个值都是字符串。
      // 与上面两组同一个口径：一条用不了的声明拒绝整个包 —— 否则作者看到的是「包加载了、词条没生效」。
      const langIssues = i18nIssues(manifest.pack, packDir, readUiLangFile);
      // `server.meta`（DESIGN §29）：声明的模块必须真的在包里、可读、是 `.mjs`。同一条口径 —— 一个声明了自己
      // 要改对局结果却没有模块文件的包，会让服务器以为这一局有它的效果而实际上没有。
      const metaFileIssues = metaIssues(manifest.pack, packDir);
      // `server.battle`（DESIGN §28.17）：声明的战斗逻辑模块必须真的在包里、可读、是 `.mjs` —— 同一条纪律。
      const battleFileIssues = battleIssues(manifest.pack, packDir);
      // `server.modules`（DESIGN §28.14）：声明的 `.mjs` 必须真的在包里 —— 同一条纪律，同一个裁剪点。
      const moduleFileIssues = serverModuleIssues(manifest.pack, packDir);
      // `server.room`（DESIGN §28.20）：声明的房间级钩子 `.mjs` 必须真的在包里 —— 同一条纪律，同一个裁剪点。
      const roomFileIssues = roomIssues(manifest.pack, packDir);
      // `notices`（DESIGN §28.15）：声明的公告 / 鸣谢 `.json` 必须真的在包里、可读、是 JSON —— 同一条纪律。
      const noticeIssues = noticesIssues(manifest.pack, packDir);
      const gateIssues = [...assetIssues.issues, ...hookIssues, ...langIssues, ...metaFileIssues, ...battleFileIssues, ...moduleFileIssues, ...roomFileIssues, ...noticeIssues];
      if (gateIssues.length) {
        errors.push({ pack: name, reason: `${gateIssues[0].code}: ${gateIssues[0].reason}` });
        continue;
      }
      // 容器的 sha256 在这里已经算过（`assetsIssues` 流式读过一遍），所以把它随包带出去：服务面（HTTP 头
      // `X-SP-Resource-Sha256`、`welcome.modAssets[].digest`）要用同一个值，重启时不该为几百 MB 再算第二遍。
      // 没声明 `assets` 的包这个键缺席，与 B2 一样「声明了才有」；同时它进**身份哈希**（见 `identifyPack`）：
      // 「同一个房间摘要 ⇒ 同一份容器」这条对齐就是靠那一步成立的。
      packs.push({
        ...manifest.pack, dir: packDir, files,
        ...identifyPack(packDir, manifest.pack, files, { assetsDigest: assetIssues.digest }),
        ...(assetIssues.digest ? { assetsDigest: assetIssues.digest } : {}),
      });
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] ${e.pack}: ${e.reason}`);
  return { dir, present: true, packs, errors };
}

/**
 * The **C-layer panels** a pack declares, judged against the pack on disk (`pack.json.client.panels`, DESIGN §28.8).
 *
 * This is the load-time half of *"a declaration that cannot be used refuses the whole pack"* (§28.13.3). A panel whose
 * `module` is missing, is not a `.js`, or resolves outside its own pack is not "a panel that did not show up": it is a
 * pack whose author believes the client has an interface it does not have. `shared/workshop.js parseClientDecl` judged
 * the SHAPE (relative, no URL, `.js`); this judges the BYTES on disk, and the two readers must agree — the same
 * "the editor cannot pass what the loader then refuses" rule §28.12 states for kit imports.
 *
 * `packDir` is the second argument (not read from `pack.dir`) so the check runs inside `loadWorkshop` BEFORE the pack is
 * listed, and so a test can point it at a hand-built pack object.
 * @param {{ client?: { panels?: Array<{ id: string, module: string }> } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @returns {Array<{ id: string, code: 'CLIENT_BAD_PANEL_MODULE', reason: string }>} one entry per unusable panel
 */
export function panelModuleIssues(pack, packDir) {
  /** @type {Array<{ id: string, code: string, reason: string }>} */
  const out = [];
  const panels = pack && pack.client && Array.isArray(pack.client.panels) ? pack.client.panels : [];
  if (!panels.length || typeof packDir !== 'string' || !packDir) return out;
  const dir = path.resolve(packDir);
  /** 一个声明的包内相对文件是否真的在包里（模块与样式表走同一条判据，只有扩展名不同）。 */
  const fileIssue = (panelId, field, rel, ext, what) => {
    const segments = String(rel).split('/');
    const abs = path.join(dir, ...segments);
    // `..` cannot build a path outside the pack that is also inside it: the join is re-checked, the same way
    // server/http/workshop.js re-checks a declared route's file.
    const bad = !rel || path.isAbsolute(rel) || !String(rel).endsWith(ext)
      || segments.some((s) => !s || s === '..' || s === '.' || s.startsWith('.'))
      || (abs !== dir && !abs.startsWith(dir + path.sep));
    if (bad) {
      return {
        id: panelId, code: field === 'module' ? 'CLIENT_BAD_PANEL_MODULE' : 'CLIENT_BAD_PANEL_STYLE',
        reason: `client.panels["${panelId}"].${field} "${rel}" is not a pack-relative ${ext} file inside the pack (this channel serves ${what}, and only the pack's own)`,
      };
    }
    let isFile = false;
    try { isFile = fs.statSync(abs).isFile(); } catch { /* stays false: no such file */ }
    if (!isFile) {
      return {
        id: panelId, code: field === 'module' ? 'CLIENT_BAD_PANEL_MODULE' : 'CLIENT_BAD_PANEL_STYLE',
        reason: `client.panels["${panelId}"].${field} "${rel}" is declared in pack.json but is not a readable file inside the pack`,
      };
    }
    return null;
  };
  for (const panel of panels) {
    const id = panel && typeof panel.id === 'string' ? panel.id : '';
    const issue = fileIssue(id, 'module', panel && typeof panel.module === 'string' ? panel.module : '', '.js', 'code');
    if (issue) { out.push(issue); continue; }
    // 面板自带的样式表（业主裁决 2026-10-10）：同一个口径 —— 声明了一份读不到/不在包里的样式表，就是**签了名却
    // 拿不出东西**，那一份样式会静默不生效、界面看着像「包没装对」。所以它也是整包被拒，而不是少注入一份。
    const styles = panel && Array.isArray(panel.styles) ? panel.styles : [];
    for (const style of styles) {
      const styleIssue = fileIssue(id, 'styles', typeof style === 'string' ? style : '', '.css', 'a stylesheet');
      if (styleIssue) { out.push(styleIssue); break; }
    }
  }
  return out;
}

/**
 * Stream a file through SHA-256 without ever holding it in memory. A resource container reaches hundreds of megabytes
 * (the reference pack's own sample is ~791 MiB), so the one thing this module must never do is read one into a Buffer —
 * not to verify it and not to serve it. Node's streaming hash takes 64 KiB (the default high-water mark) at a time.
 * @param {string} abs
 * @returns {string} lowercase hex digest
 */
export function sha256FileSync(abs) {
  const hash = createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The digest a declared container's sidecar names (the reference pack's format: `<64 hex><whitespace><name>`, one
 *  line), or `null` when that file is not there / does not start with a hex digest — "declared a verification and
 *  shipped no digest" is a different refusal from "the digest does not match". */
export function readSha256Sidecar(containerAbs, verify) {
  let text;
  try {
    text = fs.readFileSync(`${containerAbs}.${verify}`, 'utf8');
  } catch {
    return null;
  }
  const m = /^\s*([0-9a-fA-F]{64})(\s|$)/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The **load-time half of the `assets` declaration** (`pack.json.assets`, DESIGN §28.13.3, docs/WORKSHOP.md §1.9.4).
 *
 * Same stance as `panelModuleIssues`, for the same reason: a declared container or manifest that is not on disk is not
 * "a resource pack that did not load", it is a server the operator believes is serving a resource pack while every
 * client gets a 404. So the pack does not enter `loaded.packs` at all.
 *
 * What is judged, in this order (the first failure is the one reported):
 *   1. both declared paths resolve inside the pack (defence in depth — the shape layer already refused `..` / absolute);
 *   2. `container` is a readable file, `manifest` is a readable file;
 *   3. the container's bytes ARE the declared digest: the digest is read from the sidecar `<container>.<verify>`, and
 *      the container is hashed with a streaming reader (never a whole-file Buffer). A missing/garbled sidecar is
 *      `ASSETS_VERIFY_UNAVAILABLE` and a mismatch is `ASSETS_VERIFY_FAILED` — **neither is a silent pass**.
 *
 * The digest is returned so the serving side does not hash the same hundred megabytes a second time at boot.
 * @param {{ assets?: { container: string, manifest: string, serverPolicy: string, verify: string } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @returns {{ issues: Array<{ code: string, reason: string }>, digest: string|null, containerAbs: string|null, manifestAbs: string|null }}
 */
export function assetsIssues(pack, packDir) {
  /** @type {Array<{ code: string, reason: string }>} */
  const issues = [];
  const decl = pack && pack.assets;
  if (!decl) return { issues, digest: null, containerAbs: null, manifestAbs: null };
  if (typeof packDir !== 'string' || !packDir) return { issues, digest: null, containerAbs: null, manifestAbs: null };
  const dir = path.resolve(packDir);
  /** A declared pack-relative path → its absolute path, or `null` when it resolves outside the pack. */
  const resolve = (rel) => {
    const abs = path.join(dir, ...String(rel).split('/'));
    // `..` cannot build a path that is outside the pack and still inside it: the join is re-checked, the same way
    // `panelModuleIssues` and `server/http/workshop.js workshopRoutesFor` re-check theirs.
    return abs === dir || !abs.startsWith(dir + path.sep) ? null : abs;
  };
  const containerAbs = resolve(decl.container);
  const manifestAbs = resolve(decl.manifest);
  const isFile = (abs) => { try { return !!abs && fs.statSync(abs).isFile(); } catch { return false; } };
  if (!isFile(containerAbs)) {
    issues.push({
      code: ASSETS_FILE_CODES.CONTAINER,
      reason: `assets.container "${decl.container}" is declared in pack.json but is not a readable file inside the pack`
        + (containerAbs ? '' : ' (or it resolves outside the pack)'),
    });
  }
  if (!isFile(manifestAbs)) {
    issues.push({
      code: ASSETS_FILE_CODES.MANIFEST,
      reason: `assets.manifest "${decl.manifest}" is declared in pack.json but is not a readable file inside the pack`
        + (manifestAbs ? '' : ' (or it resolves outside the pack)'),
    });
  }
  if (issues.length) return { issues, digest: null, containerAbs, manifestAbs };
  const algorithm = decl.verify || 'sha256';
  const declared = readSha256Sidecar(containerAbs, algorithm);
  if (!declared) {
    issues.push({
      code: ASSETS_FILE_CODES.VERIFY_UNAVAILABLE,
      reason: `assets.verify "${algorithm}" was declared but "${decl.container}.${algorithm}" is not a readable <${algorithm}> digest next to the container`,
    });
    return { issues, digest: null, containerAbs, manifestAbs };
  }
  let actual;
  try {
    actual = sha256FileSync(containerAbs);
  } catch (e) {
    issues.push({
      code: ASSETS_FILE_CODES.VERIFY_FAILED,
      reason: `assets.container "${decl.container}" could not be read for ${algorithm} verification: ${e && e.message ? e.message : String(e)}`,
    });
    return { issues, digest: null, containerAbs, manifestAbs };
  }
  if (actual !== declared) {
    issues.push({
      code: ASSETS_FILE_CODES.VERIFY_FAILED,
      reason: `assets.container "${decl.container}" does not match its declared ${algorithm}: "${decl.container}.${algorithm}" says ${declared}, the file hashes to ${actual}`,
    });
    return { issues, digest: null, containerAbs, manifestAbs };
  }
  return { issues, digest: declared, containerAbs, manifestAbs };
}

/**
 * The **load-time half of the `server.preDispatch` declaration** (DESIGN §28.13.3, docs/WORKSHOP.md §1.9.1).
 *
 * B1 段 judged the same things and refused **that hook**, letting the pack load. B3a 段 moved the judgement here, before
 * the pack is listed, because the two outcomes are not equally loud: a pack that declares an admission hook and loads
 * without one is a server whose operator believes a gate is shut while every entry message reaches the lobby. Every
 * failure below is a property of the FILES, so it is decidable at load time:
 *   * `module` / `policy` must resolve inside the pack and be readable files;
 *   * `policy` must parse as a JSON object (a hook with no data cannot judge who to let in);
 *   * `intercepts` must name types of the protocol **actually installed** (`shared/protocol.js C2S` — the same
 *     derivation the shape layer uses, re-judged here because a declaration can outlive a protocol revision).
 *
 * What is deliberately NOT here: importing the module and calling its factory. `loadWorkshop` is synchronous
 * (`server/data.js` calls it while building the overlay) and a dynamic import is not, so the import stays in
 * `loadWorkshopHooks` — which now runs on packs this function already cleared, so its own refusals are a backstop for
 * "the file changed between the two calls", never the first line of defence.
 * @param {{ server?: { preDispatch?: { module: string, policy: string, intercepts: string[] } } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @param {{ c2s?: Record<string, any> }} [opts] `c2s` defaults to the loaded protocol.
 * @returns {Array<{ code: string, reason: string }>}
 */
export function preDispatchIssues(pack, packDir, { c2s = C2S } = {}) {
  const decl = pack && pack.server && pack.server.preDispatch;
  if (!decl || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  const moduleAbs = path.join(dir, ...String(decl.module).split('/'));
  const policyAbs = path.join(dir, ...String(decl.policy).split('/'));
  const inside = (abs) => abs === dir || abs.startsWith(dir + path.sep);
  if (!inside(moduleAbs) || !inside(policyAbs)) {
    return [{
      code: 'PREDISPATCH_BAD_PATH',
      reason: `server.preDispatch paths must resolve inside the pack (module "${decl.module}", policy "${decl.policy}")`,
    }];
  }
  const readable = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };
  if (!readable(moduleAbs)) {
    return [{ code: 'PREDISPATCH_BAD_MODULE', reason: `server.preDispatch.module "${decl.module}" is not a readable file inside the pack` }];
  }
  if (!readable(policyAbs)) {
    return [{ code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" is not a readable file inside the pack` }];
  }
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyAbs, 'utf8'));
  } catch (e) {
    return [{ code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" is not readable JSON: ${e && e.message ? e.message : String(e)}` }];
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return [{ code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" must be a JSON object (the hook's own data)` }];
  }
  const known = c2s && typeof c2s === 'object' ? c2s : {};
  // 名单里有协议不认识的名字 → 整个包被点名拒绝（不是静默丢掉那一条 —— 静默丢掉就是一道只拦一部分入口的闸门）。
  const unknown = (Array.isArray(decl.intercepts) ? decl.intercepts : []).filter((t) => typeof t !== 'string' || !Object.hasOwn(known, t));
  if (unknown.length) {
    return [{
      code: 'PREDISPATCH_UNKNOWN_TYPE',
      reason: `server.preDispatch.intercepts: ${unknown.map((t) => `"${String(t)}"`).join(', ')} — not a message type of the protocol this server runs (shared/protocol.js C2S)`,
    }];
  }
  return [];
}

/**
 * 读一个钩子模块对**自己那份策略**的意见（`module.validatePolicy(policy)`，可选导出）。
 *
 * **为什么需要它。** 装载期（`preDispatchIssues`）只保证 `policy` 能解析成一个 JSON **对象** —— 它不认识包自己的
 * 数据格式（`version` / `files` 是钩子的方言）。所以「策略文件的**内部形状**是坏的」这一格，装载期判不出来。
 * 没有这道自检时，唯一的信号是工厂在**每个连接**上抛异常，而工厂抛异常的姿态是「这条连接上这个钩子不存在，
 * 消息照常分发」（`server/modDispatch.js` 文件头）—— 也就是「包看着装好了、闸门其实一条都没拦」，正是
 * DESIGN §28.13.3 要消灭的那一类失败。
 *
 * 有了它，一份用不了的策略与「策略不是 JSON 对象」得到**同一个结局**：点名拒绝（`PREDISPATCH_BAD_POLICY`）并把
 * 这个包移出已加载集合（`dropUnavailablePreDispatchPacks`）。
 *
 * **契约，一个都不含糊**（未列出的返回值一律**拒绝**并说明，而不是当它通过 —— 装载期是响亮拒绝该在的地方）：
 *
 * | 模块返回 | 判定 |
 * |---|---|
 * | `undefined` / `null` / `true` | 通过 |
 * | `{ ok: true }` | 通过 |
 * | `false` | 拒绝 |
 * | 非空字符串 | 拒绝，字符串就是理由（给作者看的话就写在这里） |
 * | `{ ok: false, detail? / reason? / error? }` | 拒绝，取其中第一个字符串当理由 |
 * | 其它任何值 | 拒绝，理由写「返回了一个不认识的判定」 |
 * | 抛异常 | 拒绝，理由取异常信息 |
 *
 * **没有导出 `validatePolicy` 的模块一个字节都不受影响**（返回 `null`，调用方什么都不做）—— 与 §28.13 的 A 段
 * 同一口径：声明了才生效。
 *
 * @param {any} mod `await import()` 出来的模块命名空间
 * @param {any} policy 已经解析好的策略对象（`JSON.parse` 过、来自包内声明的那个文件）
 * @returns {string|null} 拒绝的理由；`null` = 通过
 */
export function validateHookPolicy(mod, policy) {
  const fn = mod && typeof mod.validatePolicy === 'function' ? mod.validatePolicy : null;
  if (!fn) return null;
  let verdict;
  try {
    verdict = fn(policy);
  } catch (e) {
    return `validatePolicy threw: ${e && e.message ? e.message : String(e)}`;
  }
  if (verdict === undefined || verdict === null || verdict === true) return null;
  if (verdict === false) return 'validatePolicy returned false';
  if (typeof verdict === 'string') return verdict.trim() || 'validatePolicy returned an empty string';
  if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
    if (verdict.ok === true) return null;
    if (verdict.ok === false) {
      const why = [verdict.detail, verdict.reason, verdict.error].find((v) => typeof v === 'string' && v.trim());
      return why || 'validatePolicy refused the policy (ok: false)';
    }
  }
  return `validatePolicy returned an unrecognised verdict (${JSON.stringify(verdict) ?? String(verdict)}) — return true / a rejection string / { ok: false, detail }`;
}

/**
 * `pack.json.server.meta` 的**装载期**判据（DESIGN §29）：声明的 `module` 必须真的在包里、可读、是 `.mjs`。
 *
 * 与 B2/B3a/B4 同一条纪律（「一条用不了的声明拒绝整个包」）：一个声明了自己要改对局结果、却连模块文件都不在的包，
 * 会让服务器以为这一局有它的效果而实际上没有 —— 那正是本仓反复点名的最坏形态。所以这里与 `assetsIssues` /
 * `panelModuleIssues` 一样，在 `loadWorkshop` **列出这个包之前**判，失败就整包不出现。
 *
 * **这一层判不到的两件事**（都留到装配路径，理由与 `server.preDispatch` 逐字相同）：
 *   * 模块能不能 `import`、有没有 `registerMeta` 导出 —— 只有动态 `import` 才知道；
 *   * `registers` 里的键是不是运行时**真的**注册的那些 —— 那要模块跑一遍才知道（受限注册表在那一刻拒绝，
 *     见 `server/match/metaPack.js`）。
 * @param {{ server?: { meta?: { module: string, registers: string[] } } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @returns {Array<{ code: string, reason: string }>}
 */
export function metaIssues(pack, packDir) {
  const decl = pack && pack.server && pack.server.meta;
  if (!decl || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  const moduleAbs = path.join(dir, ...String(decl.module).split('/'));
  if (!(moduleAbs === dir || moduleAbs.startsWith(dir + path.sep))) {
    return [{ code: 'META_BAD_PATH', reason: `server.meta.module "${decl.module}" must resolve inside the pack` }];
  }
  let readable;
  try { readable = fs.statSync(moduleAbs).isFile(); } catch { readable = false; }
  if (!readable) {
    return [{ code: 'META_BAD_MODULE', reason: `server.meta.module "${decl.module}" is not a readable file inside the pack` }];
  }
  return [];
}

/**
 * `pack.json.server.battle` 的**装载期**判据（DESIGN §28.17）：声明的 `module` 必须真的在包里、可读、是 `.mjs`。
 *
 * 与 `metaIssues` / `serverModuleIssues` / `panelModuleIssues` 逐字同一条纪律（「一条用不了的声明拒绝整个包」）：
 * 一个声明了自己要在战场里改增伤 / 攻速、却拿不出模块文件的包，会让房主以为这一局有它的效果而实际上没有。
 *
 * 判不到的三件事留到装配路径：能不能 `import`（只有动态 import 知道）、有没有 `install` 导出、以及它跑起来会不会抛
 * —— 最后一件由 `server/sim/content/index.js` 逐包隔离（一个包抛异常不该让整个战场起不来）。
 * @param {{ server?: { battle?: { module: string } } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @returns {Array<{ code: string, reason: string }>}
 */
export function battleIssues(pack, packDir) {
  const decl = pack && pack.server && pack.server.battle;
  if (!decl || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  const moduleAbs = path.join(dir, ...String(decl.module).split('/'));
  if (!(moduleAbs === dir || moduleAbs.startsWith(dir + path.sep))) {
    return [{ code: 'BATTLE_BAD_PATH', reason: `server.battle.module "${decl.module}" must resolve inside the pack` }];
  }
  let readable;
  try { readable = fs.statSync(moduleAbs).isFile(); } catch { readable = false; }
  if (!readable) {
    return [{ code: 'BATTLE_BAD_MODULE', reason: `server.battle.module "${decl.module}" is not a readable file inside the pack` }];
  }
  return [];
}

/**
 * `pack.json.server.room` 的**装载期**判据（DESIGN §28.20）：声明的 `module` 必须真的在包里、可读、是 `.mjs`。
 *
 * 与 `metaIssues` / `battleIssues` / `serverModuleIssues` / `panelModuleIssues` 逐字同一条纪律（「一条用不了的
 * 声明拒绝整个包」）：一个声明了「房间建起来时我要做事」却拿不出模块文件的包，会让房主以为这个房间有它的行为
 * 而实际上没有 —— 那正是 §28.13.3 立这条规矩要消灭的那一类静默失效。
 *
 * 判不到的三件事留到装配路径（`server/roomPack.js`）：能不能 `import`（只有动态 import 知道）、有没有 `install`
 * 导出、以及它跑起来会不会抛 —— 最后一件由 `install(room)` 与每个事件**逐钩子** try/catch 隔离
 * （`ROOM_HOOK_THREW` 点名**哪个包的哪个钩子**，房间照旧工作）。
 * @param {{ server?: { room?: { module: string } } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @returns {Array<{ code: string, reason: string }>}
 */
export function roomIssues(pack, packDir) {
  const decl = pack && pack.server && pack.server.room;
  if (!decl || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  const moduleAbs = path.join(dir, ...String(decl.module).split('/'));
  if (!(moduleAbs === dir || moduleAbs.startsWith(dir + path.sep))) {
    return [{ code: 'ROOM_BAD_PATH', reason: `server.room.module "${decl.module}" must resolve inside the pack` }];
  }
  let readable;
  try { readable = fs.statSync(moduleAbs).isFile(); } catch { readable = false; }
  if (!readable) {
    return [{ code: 'ROOM_BAD_MODULE', reason: `server.room.module "${decl.module}" is not a readable file inside the pack` }];
  }
  return [];
}

/**
 * `pack.json.server.modules[*].entry` 的**装载期**判据（DESIGN §28.14）：声明的每一个 `.mjs` 必须真的在包里、可读。
 *
 * 与 `metaIssues` / `panelModuleIssues` 同一条纪律（「一条用不了的声明拒绝整个包」）：一个声明了服务端模块却拿不出
 * 文件的包，会让运维以为那件事（停机播报、统计落盘、`/healthz` 的字段）已经在做 —— 而它一件都没做。
 *
 * 判不到的两件事照旧留到装配路径：模块能不能 `import`、有没有 `registerServer` 导出（那只有动态 import 知道），
 * 以及它挂上去之后会不会抛。
 * @param {{ server?: { modules?: Array<{ id: string, entry: string }> } }|null} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @returns {Array<{ code: string, reason: string }>}
 */
export function serverModuleIssues(pack, packDir) {
  const list = pack && pack.server && Array.isArray(pack.server.modules) ? pack.server.modules : [];
  if (!list.length || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  for (const mod of list) {
    const rel = String(mod.entry);
    const abs = path.join(dir, ...rel.split('/'));
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return [{ code: 'MODULES_BAD_ENTRY', reason: `server.modules["${mod.id}"].entry "${rel}" must resolve inside the pack` }];
    }
    let readable;
    try { readable = fs.statSync(abs).isFile(); } catch { readable = false; }
    if (!readable) {
      return [{ code: 'MODULES_BAD_ENTRY', reason: `server.modules["${mod.id}"].entry "${rel}" is not a readable file inside the pack` }];
    }
  }
  return [];
}

/**
 * `pack.json.i18n` 的**装载期**判据（fanpack G-04 / plugin-pack G4，docs/WORKSHOP.md §1.10）：
 * 声明的每一个 `.json` 必须真的在包里、必须是 JSON 对象、每一个值必须是**字符串且键不是 `_meta`**。
 *
 * 与 B2/B3a 同一条纪律（DESIGN §28.13.3「一条用不了的声明拒绝整个包」）：一份读不出来的译文如果只是被跳过，
 * 作者看到的是「包加载了、我的界面词条没生效」—— 而 `t()` 会退回中文 msgid 或英文，页面上看不出任何异常。
 * 值这一层的判据**不是**在这里重写的：`mergeWorkshopI18n` 是合并与校验共用的那一个函数，所以服务面合并时
 * 不可能遇到「装载期放行、合并时丢掉」的值。
 *
 * `readBase` 只为「冲突报告」而读官方语言文件：一份读不出来的官方文件（不该发生）不会让包被拒，
 * 只会让那一份的冲突报不出来（`mergeWorkshopI18n` 把 null base 当作「什么都还没有」）。
 *
 * @param {{ i18n?: Record<string, string> }} pack normalized manifest
 * @param {string} packDir the pack's directory on disk
 * @param {(lang: string) => Record<string, any>|null} [readBase] reads `public/i18n/<lang>.json`
 * @returns {Array<{ code: string, reason: string }>}
 */
export function i18nIssues(pack, packDir, readBase = () => null) {
  const decl = pack && pack.i18n;
  if (!decl || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  const { langs } = parsePackI18n([{ id: pack.id, i18n: decl }]);
  for (const lang of [...langs.keys()].sort()) {
    const rel = langs.get(lang).file;
    const abs = path.join(dir, ...String(rel).split('/'));
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      return [{ code: 'I18N_BAD_FILE', reason: `i18n["${lang}"] must resolve inside the pack (got "${rel}")` }];
    }
    let json;
    try {
      json = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      return [{
        code: 'I18N_BAD_FILE',
        reason: e && e.code === 'ENOENT'
          ? `i18n["${lang}"] is declared in pack.json but "${rel}" is missing from the pack`
          : `i18n["${lang}"] ("${rel}") is not readable JSON: ${e && e.message ? e.message : String(e)}`,
      }];
    }
    const merged = mergeWorkshopI18n(readBase(lang), json, { pack: pack.id, lang });
    if (!merged.ok) return [{ code: merged.error, reason: merged.detail }];
  }
  return [];
}

/**
 * The **wire list of C-layer panels** (DESIGN §28.8/§28.13, docs/WORKSHOP.md §1.9.3): the JSON-safe module list the
 * browser turns into mounts. A function cannot cross the wire, and neither can a directory scan — so this list is built
 * from the LOADED packs only (the same stance `workshopKitFilesFor` takes for kits): a URL that is not in this list is
 * never servable, and a pack that declares nothing produces an empty list, i.e. a `welcome` without the field.
 *
 * Panels are ordered by `order`, then by pack id, then by panel id — DESIGN §28.3's "the smaller pack id wins" applied
 * to a list, so the mount order never depends on the order the packs were discovered in.
 *
 * `hash` rides along (the pack's content hash, §28.2): the URL carries it as `?v=`, so a repack invalidates a cached
 * module, and the spec says WHICH bytes the browser is supposed to be served.
 * @param {ReturnType<typeof loadWorkshop>} loaded
 * @param {{ log?: object|null, baseUrl?: string }} [opts]
 * @returns {{ panels: Array<{ id: string, pack: string, slot: string, module: string, order: number, gate: string|null, url: string, hash: string, requires: string[] }>, errors: Array<{ pack: string, id: string, code: string, reason: string }> }}
 */
export function loadWorkshopPanels(loaded, { log = null, baseUrl = WORKSHOP_PANEL_PREFIX } = {}) {
  /** @type {Array<any>} */
  const panels = [];
  /** @type {Array<{ pack: string, id: string, code: string, reason: string }>} */
  const errors = [];
  const base = String(baseUrl).replace(/\/+$/, '');
  for (const pack of ((loaded && loaded.packs) || []).slice().sort(byPackId)) {
    const decl = pack && pack.client;
    const list = decl && Array.isArray(decl.panels) ? decl.panels : [];
    if (!list.length) continue;
    const dir = path.resolve(pack.dir || path.join(WORKSHOP_DIR, pack.id));
    // Defence in depth: loadWorkshop already refused a pack with an unusable panel, but this reader may see a
    // hand-built loader object or a pack written against an older schema (the same reason workshopRoutesFor re-judges).
    const issues = panelModuleIssues(pack, dir);
    if (issues.length) {
      errors.push({ pack: pack.id, id: issues[0].id, code: issues[0].code, reason: issues[0].reason });
      continue;
    }
    const requires = Object.freeze(Array.isArray(decl.requires) ? [...decl.requires] : []);
    const hash = typeof pack.hash === 'string' ? pack.hash : '';
    for (const panel of list) {
      const fileUrl = (rel) => `${base}/${encodeURIComponent(pack.id)}/${rel.split('/').map(encodeURIComponent).join('/')}?v=${hash.slice(0, 12)}`;
      const url = fileUrl(panel.module);
      // 面板自带的样式表（业主裁决 2026-10-10）：`path` 是包内相对路径（服务表用它定位文件），`url` 是浏览器注入用的
      // 登记 URL（与模块同一条通道、同一份 `?v=`，所以「同一个房间摘要 ⇒ 同一份样式」这条对齐对样式同样成立）。
      const styles = (Array.isArray(panel.styles) ? panel.styles : [])
        .map((rel) => ({ path: rel, url: fileUrl(rel) }));
      panels.push({
        id: panel.id, pack: pack.id, slot: panel.slot, module: panel.module,
        order: Number.isInteger(panel.order) ? panel.order : 0,
        gate: typeof panel.gate === 'string' && panel.gate ? panel.gate : null,
        url, hash, requires,
        ...(styles.length ? { styles } : {}),
        // 数据口（`client.panels[].data`）：面板可以读哪几张表。**不进服务端任何判据** —— 快照是客户端造的
        //（`extensions.js` 的 `ctx.data.get`），这里只是把声明原样送到浏览器，客户端据此复判。
        ...(Array.isArray(panel.data) && panel.data.length ? { data: [...panel.data] } : {}),
        // 包通道（`client.panels[].messages`，§1.9.6）：服务端**要用**它 —— `pack.msg` 只放行这个包真的声明过的
        // 通道（`server/lobby.js` 的 `packChannels`），所以这一份也随清单送到浏览器（客户端是第二个读者）。
        ...(Array.isArray(panel.messages) && panel.messages.length ? { messages: [...panel.messages] } : {}),
      });
    }
  }
  panels.sort((a, b) => (a.order - b.order)
    || (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const e of errors) log?.warn?.(`[workshop] panel ${e.pack}/${e.id}: ${e.code}: ${e.reason}`);
  return { panels, errors };
}

/**
 * 包写的**主题变量**合并体（`pack.json.client.theme.vars`，业主裁决 2026-10-10）。
 *
 * 这是「两条路一起给」里的第一条：几个颜色/尺寸这类东西写成 **CSS 自定义属性**，是**加法**语义 —— 引擎只把这
 * 几个变量名写到页面上，它改不了任何规则、也替换不了任何样式表。要「一整份新组件的样式」走 `client.panels[].styles`
 * （面板自带 `.css`），那是同一条裁决的另一半。
 *
 * 冲突规则与内容层逐字相同（DESIGN §28.3）：**包 id 小的持有那个变量**，后面的包写同一个名字被**点名拒绝**并
 * 保留先到的那份值 —— 一个后到的包静默改掉别人的主题色，是这一版每个面都在拒绝的那类失败。返回值与
 * `loadWorkshopPanels` 同形：没有包声明主题时 `theme` 是 `null`，调用方据此**一个字段都不加**。
 * @param {{ packs?: Array<any> }} loaded `loadWorkshop(...)`
 * @param {{ log?: any }} [opts]
 * @returns {{ theme: { vars: Record<string, string> }|null, errors: Array<{ pack: string, name: string, code: string, reason: string }> }}
 */
export function workshopThemeFor(loaded, { log = null } = {}) {
  /** @type {Array<{ pack: string, name: string, code: string, reason: string }>} */
  const errors = [];
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const packs = (loaded && Array.isArray(loaded.packs) ? loaded.packs : [])
    .filter((p) => p && p.client && isPlain(p.client.theme) && isPlain(p.client.theme.vars))
    .slice()
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  /** @type {Map<string, string>} */
  const owners = new Map();
  /** @type {Record<string, string>} */
  const vars = {};
  for (const pack of packs) {
    const entries = Object.entries(pack.client.theme.vars).slice().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, value] of entries) {
      const holder = owners.get(name);
      if (holder) {
        errors.push({
          pack: pack.id, name, code: 'CLIENT_THEME_VAR_TAKEN',
          reason: `client.theme.vars["${name}"] is already written by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3); rename the variable, or let "${holder}" drop it`,
        });
        continue;
      }
      owners.set(name, pack.id);
      vars[name] = value;
    }
  }
  for (const e of errors) log?.warn?.(`[workshop] theme ${e.pack}: ${e.code}: ${e.reason}`);
  return { theme: Object.keys(vars).length ? { vars } : null, errors };
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
 * @param {{ assetsDigest?: string|null }} [opts] 装载期已与容器**字节**核对过的 sha256（`assetsIssues`）；只有声明了
 *   `assets` 的包才有值
 * @returns {{ hash: string, manifest: Array<{ path: string, hash: string }>, layer: string, combat: boolean, api: string|null, game: string|null }}
 */
export function identifyPack(packDir, pack, files, { assetsDigest = null } = {}) {
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
  // RECURSIVE, and that is the point (§28.18): a kit may now split its helper code into `kits/lib/*.js`, and those
  // bytes decide how a battle plays out exactly like the kit file does. Hashing only the top level would let two
  // clients whose helper bytes differ share one digest — and that digest is what W-D alignment compares (§28.16).
  // The manifest path keeps the `kits/` prefix, so a FLAT `kits/` directory produces the same `kits/<name>` entries it
  // always did and no existing pack's hash moves. `kits` (the count that decides layer B) counts the KITS only:
  // a subdirectory is not a kit and a `_`-prefixed helper is not a kit (the same two rules `loadWorkshopKits` scans by).
  try {
    for (const name of fs.readdirSync(kitDir).sort()) {
      if (!name.endsWith('.js')) continue;
      const st = fs.statSync(path.join(kitDir, name));
      if (!st.isFile()) continue;
      if (!name.startsWith('_')) kits++;
    }
  } catch { /* no kits/ directory: an ordinary data pack */ }
  for (const rel of listFiles(kitDir).filter((f) => f.endsWith('.js'))) {
    addBytes(`kits/${rel}`, fs.readFileSync(path.join(kitDir, rel)));
  }
  const assetsDir = path.join(packDir, 'assets');
  for (const rel of listFiles(assetsDir)) addBytes(`assets/${rel}`, fs.readFileSync(path.join(assetsDir, rel)));
  // 5. C 层面板的模块源码（`pack.json.client.panels[].module`, DESIGN §28.8）：一条声明能改变客户端行为，模块的
  //    字节同样能 —— 不把面板源码算进身份，两份不同的面板就会共用同一个摘要（那份摘要将不再描述浏览器真的会
  //    执行的代码）。两个面板共用同一个文件时只算一次（按声明路径去重），并且只有在包真的声明了面板时才加：
  //    没声明 `client` 的包（今天所有的包）哈希逐字节不变。
  const panelFiles = [...new Set(((pack.client && Array.isArray(pack.client.panels)) ? pack.client.panels : [])
    .map((p) => (p && typeof p.module === 'string' ? p.module : ''))
    .filter(Boolean))].sort();
  for (const rel of panelFiles) {
    // A panel module may live under `assets/` (or be a kit source): then that file is already in the manifest and
    // adding it twice would list the same bytes under the same path twice.
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
  // 5b. 面板自带样式表的源码（`client.panels[].styles[]`, 业主裁决 2026-10-10）：与模块逐字相同的理由 —— 一份样式表
  //     改变的是**界面长什么样**，不把它算进身份，两份不同的样式就会共用同一个摘要（而那份摘要声称「同一份界面」）。
  //     同样按声明路径去重、同样只在包真的声明了样式表时才加：没声明的包哈希逐字节不变。
  const styleFiles = [...new Set(((pack.client && Array.isArray(pack.client.panels)) ? pack.client.panels : [])
    .flatMap((p) => (p && Array.isArray(p.styles) ? p.styles : []))
    .filter((s) => typeof s === 'string' && s))].sort();
  for (const rel of styleFiles) {
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
  // 包的**对局元注册表**模块（`pack.json.server.meta`, DESIGN §29）：它是要在**对局里执行**的代码，所以它的字节
  // 必须进身份 —— 与面板模块逐字相同的一条理由（同一份摘要不能描述两段不同的行为）。它同时是**唯一**能让两个
  // 内容哈希相同的包在对局里跑出不同结果的声明，所以漏了它，房间的摘要闸门就在最该拦的地方漏掉。
  // 没声明 `server.meta` 的包（今天所有的包）哈希逐字节不变。
  const metaFiles = [...new Set([pack.server && pack.server.meta && typeof pack.server.meta.module === 'string'
    ? pack.server.meta.module : ''].filter(Boolean))];
  for (const rel of metaFiles) {
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
  // 包的**战斗逻辑**模块（`pack.json.server.battle`, DESIGN §28.17）：它比 meta 更直接 —— 每个战场建起来时都会跑，
  // 能改增伤 / 攻速 / 真实伤害。所以字节必须进身份，理由与 kits / panels / meta / server.modules 逐字相同。
  // 没声明 `server.battle` 的包（今天所有的包）哈希逐字节不变。
  const battleFiles = [...new Set([pack.server && pack.server.battle && typeof pack.server.battle.module === 'string'
    ? pack.server.battle.module : ''].filter(Boolean))];
  for (const rel of battleFiles) {
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
  // 包的**服务端模块**源码（`pack.json.server.modules[*].entry`, DESIGN §28.14）：它是会在服务器上执行的代码，
  // 所以它的字节必须进身份 —— 与 kits / panels / meta 逐字相同的一条理由（同一份摘要不能描述两段不同的行为）。
  // 没声明 `server.modules` 的包哈希逐字节不变。
  const moduleFiles = [...new Set(((pack.server && Array.isArray(pack.server.modules)) ? pack.server.modules : [])
    .map((m) => (m && typeof m.entry === 'string' ? m.entry : ''))
    .filter(Boolean))];
  // 包的**房间级钩子**模块（`pack.json.server.room`, DESIGN §28.20）：它会在**每一个**装上这个包的房间里执行，
  // 所以它的字节必须进身份 —— 与 kits / panels / meta / battle / server.modules 逐字相同的一条理由：能改变
  // 一端行为的声明不进哈希，同一个摘要下就有两种行为（§28.2），而房间的摘要闸门正是在这里对齐的。
  // 没声明 `server.room` 的包（今天所有的包）哈希逐字节不变。
  const roomFiles = [...new Set([pack.server && pack.server.room && typeof pack.server.room.module === 'string'
    ? pack.server.room.module : ''].filter(Boolean))];
  for (const rel of moduleFiles) {
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
  for (const rel of roomFiles) {
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
  // the declared layer wins; the derivation is the fallback, and `combat` follows the artifact kind. A pack that only
  // mounts a panel IS layer C (DESIGN §28.1: "C client UI") — §28.8's "the pack is marked in the UI like any other"
  // means the layer derivation counts the panels the way it counts media, and `combat` stays "kits only": a panel
  // cannot change a battle result.
  const hasMedia = ['voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art'].some((k) => Object.keys(pack[k] || {}).length > 0);
  // 只写主题变量的包同样是 C 层（一个颜色包改的就是界面），所以主题也算进这条推导。
  const hasTheme = !!(pack.client && pack.client.theme && Object.keys(pack.client.theme.vars || {}).length > 0);
  // 声明了**服务端模块**的包是 B 层（`server.modules`, DESIGN §28.14）：它会执行服务端代码（可能碰对局，若挂了
  // `matchClass`），所以按 §28.1 的三层表它属于 B，而不是 A/C 里任何一层。
  const hasServerModules = moduleFiles.length > 0;
  // 声明了 `server.meta` / `server.battle` / `server.room` 的包同样是 B 层：它们执行的都是引擎的**服务端**代码
  //（对局 / 战斗里的逻辑，或房间生命周期），按 §28.1 的三层表属于 B —— 那一层的名字是「B server logic」，
  // 不是「只进对局」。
  const hasServerLogic = metaFiles.length > 0 || battleFiles.length > 0 || roomFiles.length > 0;
  const layer = pack.layer || (kits || hasServerModules || hasServerLogic ? 'B' : (hasMedia || panelFiles.length || styleFiles.length || hasTheme) ? 'C' : 'A');
  // `combat` 的推导**不**把服务端模块算进来：只挂 `boot` / `shutdown` / `healthz` 的模块碰不到对局，而挂了
  // `matchClass` 的包由形状层要求它**显式**声明 `combat: true`（`MODULES_NEED_COMBAT`）—— 所以这里照旧只看 kits。
  // `server.room`（§28.20）同理**不**算：它没有一件能力能改对局结果，形状层因此不要求它声明 `combat: true`；
  // 把它算进来的话，一个只做「观战人数播报」的诚实包会被推成 `combat: true`、进 golden 语料与摘要闸门 ——
  // 那是把「改结果的包」这条线稀释掉。分类规则见 §28.20「闸门分类」那一段。
  const combat = pack.combat === null || pack.combat === undefined ? kits > 0 : pack.combat;
  // 6. 声明的资源容器的 sha256（`pack.json.assets`, DESIGN §28.13.5）。装载期已经拿它与容器的**字节**核对过
  //    （`assetsIssues` 流式读过一遍），所以它是这份包的一个真实属性，而不是一句声明 —— 这就是「同一个房间摘要
  //    ⇒ 同一份容器」这条对齐的落点：换了容器、字节不同、摘要不同、包的内容哈希就不同，房间的摘要闸门随之拦下。
  //    只有声明了 `assets` 的包才有这个条目：没声明的包哈希逐字节不变（`test/packAssets.test.js` 钉了三份真实包）。
  //
  //    合成路径 `assets.container.sha256` **不可能被真实文件占用**：进这份清单的路径只有 `pack.json`、
  //    `<内容文件>.json`（13 个固定名字，没有 `assets`）、`kits/*.js`、`assets/**` 与声明过的面板模块（必须
  //    `.js`）。这一条的 `hash` 直接就是容器的 sha256（它没有「另一份字节」可以哈希），路径名说的就是这件事。
  if (typeof assetsDigest === 'string' && assetsDigest) manifest.push({ path: ASSETS_DIGEST_PATH, hash: assetsDigest });
  // 7. 声明的 i18n 译文文件（`pack.json.i18n`, fanpack G-04）：**字节**进身份哈希。理由与面板模块逐字相同 ——
  //    一份译文能改变玩家看到的界面，两份不同的译文不该共用同一个摘要；而且这些文件是**声明过的路径**
  //    （`i18n["en"]: "i18n/en.json"`），不进清单的话「换了译文、包摘要不变」就会让房间的摘要闸门失效。
  //    没声明 `i18n` 的包（今天所有的包）哈希逐字节不变。文件与面板模块共用同一条去重与路径复核。
  const langFiles = [...new Set(Object.values(pack.i18n && typeof pack.i18n === 'object' ? pack.i18n : {})
    .filter((rel) => typeof rel === 'string' && rel))].sort();
  // 8. 声明的公告 / 鸣谢文件（`pack.json.notices`, DESIGN §28.15）：**字节**进身份哈希。理由与 i18n 逐字相同 ——
  //    一段展示给玩家看的正文改了、包摘要却不变，那「同一个房间摘要 ⇒ 同一份内容」这句话对它就失效了。
  const noticeFiles = [...new Set(Object.values(pack.notices && typeof pack.notices === 'object' ? pack.notices : {})
    .filter((rel) => typeof rel === 'string' && rel))].sort();
  const declaredTextFiles = [...new Set([...langFiles, ...noticeFiles])].sort();
  for (const rel of declaredTextFiles) {
    if (manifest.some((m) => m.path === rel)) continue;
    const abs = path.join(packDir, ...rel.split('/'));
    if (abs === packDir || !abs.startsWith(packDir + path.sep)) continue;
    try { addBytes(rel, fs.readFileSync(abs)); } catch { /* unreachable for a LOADED pack: loadWorkshop refuses it first */ }
  }
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
 * 一条**已被接受**的包相对 specifier（`./lib/util.js`）→ 服务端该 import 的 `file:` URL（DESIGN §28.18）。
 *
 * `baseDir` 是**出现这条 import 的那个文件**所在的目录（对 kit 与它的辅助文件都是 `kits/`），所以与浏览器的解析
 * 逐字同构：浏览器按模块自己的 URL 解，这里按模块自己的目录解。specifier 已经过 `isPackRelativeSpecifier`
 * （`./` 开头、`.js` 结尾、无 `..` / `\` / `%` / `?` / `#` / 空段），所以这里只做拼接 —— 判定只写一遍，写在
 * `shared/kitImports.js`，编辑器与加载器读的是同一份。带 mtime 的查询串与上面 `?v=` 同一条理由：改过的辅助文件
 * 必须让 Node 的 ESM 缓存交出新的模块。
 * @param {string} baseDir 绝对目录
 * @param {string} specifier
 * @returns {string}
 */
function relativeModuleUrl(baseDir, specifier) {
  const abs = path.join(baseDir, ...packRelativePath(specifier).split('/'));
  let v = 0;
  try { v = Math.round(fs.statSync(abs).mtimeMs); } catch { /* 文件不在：抛给下面那次 import 报出来 */ }
  return `${pathToFileURL(abs).href}?v=${v}`;
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
 *
 * **Which files are kits** (§28.18): a top-level `kits/<id>.js` whose name does not start with `_`. A subdirectory is
 * not a kit (its files are the ones a kit imports with `./…`), and `kits/_shared.js` is a shared helper, not an
 * operator called `_shared` — so one big kit file can be split into several without every fragment being read as a kit.
 * A kit's imports: the `@kit/` / `@sim/` whitelist (§28.12) plus its OWN siblings under `kits/` as `./…` (§28.18),
 * which the browser resolves against the kit's URL and this function rewrites against the kit file's directory.
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
      // Which files are kits (§28.18): a top-level `<id>.js` is a kit, and only that. A SUBDIRECTORY is not a kit (its
      // files are the ones a kit reaches with `./…`); a file whose basename starts with `_` is not a kit either, so a
      // shared helper may sit next to the kits (`kits/_shared.js`) without being read as an operator named "_shared".
      // A directory entry that is neither a file nor a directory (a socket, a broken symlink) is not a kit either.
      if (!name.endsWith('.js') || name.startsWith('_')) continue;
      const file = path.join(kitDir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const id = name.slice(0, -'.js'.length);
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
          : await import(kitDataUrl(rewriteKitImports(source, (rel) => pathToFileURL(path.join(ROOT, rel)).href, {
            // §28.18: an ACCEPTED pack-relative specifier (`./lib/util.js`) is resolved against THIS file's own
            // directory — `kits/<id>.js` and `kits/_shared.js` therefore get different answers for the same string,
            // which is what the browser does too (it resolves against the importing module's URL).
            resolveRelative: (spec) => relativeModuleUrl(kitDir, spec),
          }), v));
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
  // `owners`（kit id → 包 id）随结果一起交出去：**按房间物化**（W-B，DESIGN §28.16）要知道某个 kit 属于哪个包，
  // 才能给一个只声明了子集的房间只带它那几个包的 kit。没有它，唯一的选择是把进程级那一份整份发下去 ——
  // 那正是 W-B 要修的事。
  return { kits, modules, owners: kitOwner, errors };
}

/**
 * Load the **dispatch-time hook** of every pack that declares one: `pack.json.server.preDispatch`
 * (DESIGN §28.13, docs/WORKSHOP.md §1.9.1). This is the behaviour half of the declaration A 段 only parsed.
 *
 * **Its refusals are a backstop, not the gate.** Since B3a 段 the load-time judgement lives in
 * `preDispatchIssues`, called by `loadWorkshop` BEFORE the pack is listed: a declaration whose module or policy
 * file is missing / unparsable, or whose `intercepts` names a type the installed protocol does not know, refuses the
 * **whole pack** (§28.13.3). What is left for this function is the half that cannot be decided synchronously — the
 * dynamic import and the factory call:
 *   * resolve `module` / `policy` inside the pack (checked again: this reader may see a hand-built loader object);
 *   * parse `policy` as a JSON object (the hook's own data: the reference implementation's `admission-files.json`);
 *   * re-judge `intercepts` against the `C2S` of the protocol **actually loaded here**;
 *   * import the module and take its `createPreDispatch(deps)` factory (or a default export of the same shape).
 *
 * An import that fails, or a module without the factory, is reported under the same names
 * (`PREDISPATCH_BAD_MODULE` / `PREDISPATCH_BAD_POLICY` / `PREDISPATCH_UNKNOWN_TYPE` / `PREDISPATCH_BAD_PATH`) and that
 * hook is not installed. On a tree the loader already accepted the first three cannot fire — the only way in is a pack
 * that changed on disk between the two calls (or a hand-built `loaded` object in a test).
 *
 * The LAST two can only be decided here (a dynamic import is not synchronous), so they are the one remaining hole in
 * §28.13.3: `loadWorkshop` cannot refuse a module it has not imported yet. `server/index.js` therefore calls
 * `dropUnavailablePreDispatchPacks` with this function's `errors` on the **startup assembly path**, right after this
 * call and before anything derived from `loaded.packs` is built — so a pack whose declared gate cannot be installed
 * does not end up in the data overlay, in `welcome.mods`, in the kit list or in the resource tables either.
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
  // 装载期已经拒绝过这几种（`preDispatchIssues` 在 `loadWorkshop` 里跑过一遍）—— 走到这里说明包在两次调用之间
  // 变了，或者调用方手搓了一个 `loaded` 对象。措辞如实说明这一点，而不是把它说成一条新的判据。
  const LOADER_BACKSTOP = ' (the loader already refuses the whole pack for this; reaching here means the pack changed on disk after it was listed, or the loader object was hand-built)';
  for (const pack of ((loaded && loaded.packs) || []).slice().sort(byPackId)) {
    const decl = pack && pack.server && pack.server.preDispatch;
    if (!decl) continue;
    const dir = path.resolve(pack.dir || path.join(WORKSHOP_DIR, pack.id));
    // One judgement, two callers (DESIGN §28.13.3): the loader's gate and this reader ask the same question here, so a
    // pack that is rejected before it is listed and a pack this function refuses can never disagree about why.
    const issues = preDispatchIssues(pack, dir, { c2s: known });
    if (issues.length) {
      errors.push({ pack: pack.id, code: issues[0].code, reason: `${issues[0].reason}${LOADER_BACKSTOP}` });
      continue;
    }
    const moduleAbs = path.join(dir, ...String(decl.module).split('/'));
    const policyAbs = path.join(dir, ...String(decl.policy).split('/'));
    let policy;
    try {
      policy = JSON.parse(fs.readFileSync(policyAbs, 'utf8'));
    } catch (e) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.policy "${decl.policy}" is not readable JSON: ${e && e.message ? e.message : String(e)}` });
      continue;
    }
    let mod;
    // 这一层只剩「只有 import 才知道」的两件事：模块装了能不能 import、装了有没有工厂导出。它们与上面那些**装载期
    // 判据**不是一回事（那三种在装载期已经拒绝整个包了），所以这里的措辞说的是**调用方接下来会做什么**。
    const unavailable = ' (the declared hook cannot be installed, so the startup assembly path drops this pack from the loaded set — a pack that declares a gate it does not have must not look loaded)';
    try {
      // mtime 既打败服务端 ESM 缓存，又让两个版本的模块是两个 URL（与 loadWorkshopKits 同一条理由）。
      const v = Math.round(fs.statSync(moduleAbs).mtimeMs);
      mod = await import(`${pathToFileURL(moduleAbs).href}?v=${v}`);
    } catch (e) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_MODULE', reason: `server.preDispatch.module "${decl.module}" failed to import: ${e && e.message ? e.message : String(e)}${unavailable}` });
      continue;
    }
    const create = typeof mod.createPreDispatch === 'function' ? mod.createPreDispatch
      : (typeof mod.default === 'function' ? mod.default : null);
    if (!create) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_MODULE', reason: `server.preDispatch.module "${decl.module}" must export createPreDispatch(deps) (or default-export that function)${unavailable}` });
      continue;
    }
    // 模块对自己那份策略的自检（可选导出 `validatePolicy`，见上面那个函数的注释）：判不了内部形状的那一格由包
    // 自己回答，装载器只负责在它说「不能用」时**点名拒绝整个包**。没有导出的模块走不到这里就返回 null。
    const policyRefusal = validateHookPolicy(mod, policy);
    if (policyRefusal) {
      errors.push({ pack: pack.id, code: 'PREDISPATCH_BAD_POLICY', reason: `server.preDispatch.module "${decl.module}" refused its own policy "${decl.policy}": ${policyRefusal}${unavailable}` });
      continue;
    }
    hooks.push({ pack: pack.id, module: decl.module, policyFile: decl.policy, policy, intercepts: [...decl.intercepts], create });
  }
  for (const e of errors) log?.warn?.(`[workshop] hook ${e.pack}: ${e.code}: ${e.reason}`);
  return { hooks, errors };
}

/**
 * 把「声明了 `server.preDispatch` 却装不上」的包移出已加载集合 —— DESIGN §28.13.3 的**最后一格**。
 *
 * 为什么需要这一步：`loadWorkshop` 是同步的（`server/data.js` 在装叠加层时调它），而「模块能不能 import、有没有
 * 工厂导出、模块自己对策略的意见是什么」只有动态 import 之后才知道。于是在装载期这道闸门之外还剩三种结局：
 *   * `PREDISPATCH_BAD_MODULE`（import 失败 —— 语法错、模块不存在于导入图、依赖缺失）；
 *   * `PREDISPATCH_BAD_MODULE`（导出了，但没有 `createPreDispatch`）；
 *   * `PREDISPATCH_BAD_POLICY`（模块导出了 `validatePolicy`，而它对**自己那份策略的内部形状**说了「不能用」——
 *     装载期的 `preDispatchIssues` 只保证策略能解析成 JSON 对象，它不认识钩子的方言）；
 * 以及一种「两次调用之间包变了」的兜底（策略文件变得读不动 / `intercepts` 变得不在协议里）。
 *
 * 它在 B1 段是「**包照旧加载**，只是那个钩子没装上」—— 那正是本仓反复点名的最坏形态：运维以为自己有一道准入
 * 闸门，而实际上一条消息都没拦。所以这里与 B2 的 `client`、B3a 的 `assets` 同口径：**声明不可用 ⇒ 该包不进
 * 已加载集合**，并点名报告（返回的 `removed` 与追加进 `errors` 的那一条都带拒绝码）。
 *
 * 为什么放在**启动装配路径**而不是 `loadWorkshop` 里：那需要把 `loadWorkshop` 变成 async，而它的调用方
 * （`server/data.js` 的 `loadData`、`tools/workshop-validate.mjs`、`tools/workshop-pack.mjs`、十几份测试）全是同步的。
 * `server/index.js` 因此在装配的最前面（`loadWorkshopHooks` 之后、其余一切之前）调用本函数，**用一个被裁剪过的
 * `packs` 数组**喂给后面每一个读者（数据叠加层、身份清单、kits、面板、资源表、Lobby/Network），于是
 * 「不进已加载集合」是**一处裁剪、处处成立**，而不是各读各处地漏。
 *
 * 纯函数：不改入参，返回新的数组。
 * @param {{ packs?: Array<{ id: string }>, errors?: Array<{ pack: string, reason: string }> }} loaded
 * @param {Array<{ pack: string, code: string, reason: string }>} hookErrors `loadWorkshopHooks(...).errors`
 * @returns {{ packs: Array<any>, removed: Array<{ pack: string, code: string, reason: string }>,
 *   errors: Array<{ pack: string, reason: string }> }}
 */
export function dropUnavailablePreDispatchPacks(loaded, hookErrors) {
  /** @type {Map<string, { code: string, reason: string }>} */
  const failing = new Map();
  for (const e of Array.isArray(hookErrors) ? hookErrors : []) {
    if (e && typeof e.pack === 'string' && e.pack && !failing.has(e.pack)) failing.set(e.pack, { code: String(e.code || 'PREDISPATCH_UNAVAILABLE'), reason: String(e.reason || '') });
  }
  /** @type {Array<any>} */
  const packs = [];
  const removed = [];
  const errors = Array.isArray(loaded && loaded.errors) ? [...loaded.errors] : [];
  for (const p of ((loaded && loaded.packs) || [])) {
    const hit = p && typeof p.id === 'string' ? failing.get(p.id) : null;
    if (!hit) { packs.push(p); continue; }
    removed.push({ pack: p.id, code: hit.code, reason: hit.reason });
    errors.push({ pack: p.id, reason: `${hit.code}: ${hit.reason}` });
  }
  return { packs, removed, errors };
}
