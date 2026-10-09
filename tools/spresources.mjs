// tools/spresources.mjs — SPRES001 资源包容器格式的读写核心（Node，零依赖）。
//
// 来源：`_up/mod4-pack/tools/spresources.mjs`（逐字节验证过的复刻件，见 `_up/mod4-resource-pack-recon.md` §三）。
// 本次搬迁**正文一字未改** —— 只加了这段来源说明。改动的诱因只有一个：本仓也要读写这个格式，重新推导一遍
// 就等于有了第二个会漂移的真相。
//
// 本仓与参考实现的**产物布局不同**（所以 `buildPack` 下面的四件套是按参考项目的布局写的）：
//   * 参考项目：一个全局资源集，四个产物（包 + `.sha256` + `/data/resource-manifest.json` +
//     `public/js/resources/pack-config.js` + `server/admission-files.json`），客户端把版本号**编译进**页面；
//   * 本仓：每个工坊包自带容器（`pack.json.assets.container`），清单也由包提供（`assets.manifest`），版本锚点是
//     装载期算出的**容器 sha256**（`assetsIssues` → `assetsDigest` → 包的内容哈希 → `welcome.modAssets[].digest`）。
//     所以本仓产包用的是 `tools/make-spresources.mjs`（它只用本文件的格式原语：`validateManifest` /
//     `computeVersion` / `buildHeader` / `sha1_12` / `fileFor`）。
// `buildPack` 因此保留下来当**字节保真的参照实现**：`test/modAssets.test.js` 用同一个清单、同一批源文件跑
// 两个写入器，要求产出的容器**逐字节相同**。这样一来「别重写格式」不是一句承诺，而是一条会红的断言。

// _up/mod4-pack/tools/spresources.mjs
//
// SPRES001 资源包容器格式的读写核心（Node，零依赖）。
//
// 格式规格来自原件 `tools/resource_pack.py`（Python 3，标准库）与实测演示包（6,836 字节）。
// 本文件是**逐字复刻**，不是「参照实现」：
//
//   magic       8 字节 ASCII "SPRES001"（无 NUL 结尾）
//   headerLen   4 字节 uint32 **小端** = 头 JSON 的字节长度 H
//   header      UTF-8 JSON，**压紧**（无空格、无换行、无 BOM），Python 侧 `separators=(',',':')` + `ensure_ascii=False`
//   body        按 manifest.files 的顺序**原样拼接**，无对齐、无填充、无分隔、无长度前缀
//
//   总长必须恰好 12 + H + Σsize（多一个字节即「Unexpected trailing bytes」）
//
// 三个**跨语言必须逐字一致**的点（原件侦察报告 §3.8 坑②，任何一处不同 version 就变）：
//   1. 条目内 key 顺序：url, size, hash, tier —— 我们按这个顺序构造对象，JSON.stringify 保序；
//   2. `ensure_ascii=False` —— JS 的 JSON.stringify 本来就不转义非 ASCII，与之一致；
//   3. 分隔符 (',',':') —— JSON.stringify 默认无空格，与 Python 的 separators 一致。
//
// 有意比 Python 工具**更严**的地方（写进 README-改写说明.md，不是悄悄改）：
//   * 逐条校验 `hash` 必须是 12 位小写十六进制、`tier ∈ {1,2}`、`size ∈ [0, 24 MiB]`；
//   * `--manifest` 模式下默认要求 `sha256(压紧 files)[0:12] === manifest.version`（可用 --trust-version 关掉）。
// 两者都只会**拒收**，不会产出与 Python 不同的字节。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAGIC = 'SPRES001';
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 50000;
export const DEFAULT_QQ_GROUP = '1074985123';
/** 准入持有证明只收这个区间的文件（resource_pack.py:45）。 */
export const PROOF_MIN_BYTES = 1024;
export const PROOF_MAX_BYTES = 256 * 1024;

/** 扩展名 → MIME（与 resource_pack.py:3 的 MIME 字典逐项相同；只用于「枚举模式」的扩展名白名单）。 */
export const RESOURCE_MIME = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  mp4: 'video/mp4', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', atlas: 'text/plain; charset=utf-8',
  obj: 'text/plain; charset=utf-8', skel: 'application/octet-stream', bin: 'application/octet-stream',
});

/** 清单格式版本（manifest.format）与容器版本（header.version）是两个常量，别混。 */
export const MANIFEST_FORMAT = 1;
export const CONTAINER_VERSION = 1;
/** 清单里只允许这两个分层（common.js:23-25 / resource_pack.py 的客户端校验）。 */
export const TIERS = Object.freeze([1, 2]);

export const sha1_12 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
export const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Python `json.dumps(v, ensure_ascii=False, separators=(',',':'))` 的等价物。
 * `JSON.stringify(v)` 不转义非 ASCII、不加空格，与之一致（key 顺序 = 对象插入顺序，两边都是）。
 */
export const compactJson = (v) => JSON.stringify(v);

/** Python `json.dumps(v, ensure_ascii=False, indent=2)` 的等价物（write_json 用的形状）。 */
export const prettyJson = (v) => JSON.stringify(v, null, 2);

/**
 * 资源版本号：`sha256(压紧 files JSON)[0:12]`（resource_pack.py:27）。
 * @param {Array<{url:string,size:number,hash:string,tier:number}>} files
 */
export function computeVersion(files) {
  return sha256hex(Buffer.from(compactJson(files), 'utf8')).slice(0, 12);
}

/** 头 JSON 的字节（resource_pack.py:36；key 顺序 format / version / manifest / qqGroup）。 */
export function buildHeader(manifest, qqGroup = DEFAULT_QQ_GROUP) {
  return Buffer.from(
    compactJson({ format: 'sp-resource-pack', version: CONTAINER_VERSION, manifest, qqGroup }),
    'utf8',
  );
}

const BAD_URL_CHARS = new Set([' ', '?', '#', '\\', '"', "'", '<', '>']);

/** URL 前缀与字符集校验（resource_pack.py:9、:22）。 */
export function assertResourceUrl(url) {
  if (typeof url !== 'string' || !(url.startsWith('/assets/') || url.startsWith('/fonts/'))) {
    throw new Error(`Unsupported resource path: ${String(url)}`);
  }
  for (const ch of url) {
    if (BAD_URL_CHARS.has(ch) || ch.codePointAt(0) < 32) throw new Error(`Unsupported filename: ${url}`);
  }
}

/**
 * URL → public 目录下的绝对路径（resource_pack.py:8-12 的 Node 等价物）。
 * 逐段 percent-decode：Python 的 `urllib.parse.unquote` 对畸形转义序列原样保留，我们也原样保留（不抛）。
 * @param {string} publicDir
 * @param {string} url
 */
export function fileFor(publicDir, url) {
  assertResourceUrl(url);
  const decoded = url.split('/')
    .map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } })
    .join('/');
  const root = path.resolve(publicDir);
  const abs = path.resolve(root, decoded.replace(/^\/+/, ''));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Resource outside public directory');
  return abs;
}

/** 清单形状校验（比 Python 工具更严，见文件头）。返回 {ok, error} 而不是抛，便于 CLI 汇总。 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, error: 'manifest must be a JSON object' };
  if (manifest.format !== MANIFEST_FORMAT) return { ok: false, error: `manifest.format must be ${MANIFEST_FORMAT}` };
  if (typeof manifest.version !== 'string' || !manifest.version) return { ok: false, error: 'manifest.version must be a non-empty string' };
  if (!Array.isArray(manifest.files)) return { ok: false, error: 'manifest.files must be an array' };
  if (manifest.files.length > MAX_FILES) return { ok: false, error: `manifest.files exceeds ${MAX_FILES}` };
  for (let i = 0; i < manifest.files.length; i++) {
    const f = manifest.files[i];
    const at = `manifest.files[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: `${at} must be an object` };
    try { assertResourceUrl(f.url); } catch (err) { return { ok: false, error: `${at}: ${err.message}` }; }
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return { ok: false, error: `${at}.size out of range: ${String(f.size)}` };
    if (typeof f.hash !== 'string' || !/^[0-9a-f]{12}$/.test(f.hash)) return { ok: false, error: `${at}.hash must be 12 lowercase hex digits` };
    if (!TIERS.includes(f.tier)) return { ok: false, error: `${at}.tier must be 1 or 2` };
  }
  return { ok: true };
}

/** 写包的打开模式：`'wx'` = 只写新文件，已存在即失败（resource_pack.py 用 `'xb'`）；`--force` 才降级为 `'w'`。 */
function openTarget(file, force) {
  return fs.openSync(file, force ? 'w' : 'wx');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 三个 JSON/JS 旁挂产物的行尾。
 *
 * 原件的 Python 用 `Path.write_text(...)`，那是**文本模式**：Windows 上 Python 把 `\n` 翻成 `\r\n`。
 * 包本体走的是 `open('xb')`（二进制），所以**包字节不受影响**；但三个旁挂文件的字节在 Windows 上就是 CRLF 的。
 * 这不是格式属性，是原工具的平台行为 —— 要逐字节对齐就得照做，所以默认跟随当前平台（与 Python 语义相同）。
 * @returns {'\r\n'|'\n'}
 */
export function platformEol() {
  return process.platform === 'win32' ? '\r\n' : '\n';
}

/** 按给定行尾写文本（`\n` → eol）。 */
function writeText(file, text, eol) {
  fs.writeFileSync(file, eol === '\n' ? text : text.replace(/\n/g, eol), 'utf8');
}

/**
 * 产出一个容器包与四件套（资源包 + .sha256 + resource-manifest.json + pack-config.js + admission-files.json）。
 *
 * @param {{manifest:any, publicDir:string, outDir:string, qqGroup?:string, force?:boolean,
 *   trustVersion?:boolean, log?:(line:string)=>void}} opts
 * @returns {{pack:string, version:string, files:number, headerLen:number, bytes:number, sha256:string, proofEligibleFiles:number}}
 */
export function buildPack(opts) {
  const { manifest, publicDir, outDir, qqGroup = DEFAULT_QQ_GROUP, force = false, trustVersion = false } = opts;
  const eol = opts.eol === 'lf' ? '\n' : opts.eol === 'crlf' ? '\r\n' : platformEol();
  const log = opts.log || (() => {});

  const shape = validateManifest(manifest);
  if (!shape.ok) throw new Error(`清单不合法：${shape.error}`);

  // ① 版本号自洽（Python 工具在 --manifest 模式下不算版本，我们默认算一遍并比对）
  const recomputed = computeVersion(manifest.files);
  if (!trustVersion && recomputed !== manifest.version) {
    throw new Error(
      `manifest.version (${manifest.version}) 与 sha256(压紧 files)[0:12] (${recomputed}) 不一致；` +
      '若这份清单是别的生产者按别的 key 顺序生成的，用 --trust-version 显式接受');
  }
  if (trustVersion && recomputed !== manifest.version) {
    log(`[warn] --trust-version：manifest.version=${manifest.version}，本机重算=${recomputed}（key 顺序/转义不同会这样）`);
  }

  // ② 先把**全部源字节**读一遍并核对（resource_pack.py:31-33：写可分发文件之前先查源）
  for (const entry of manifest.files) {
    const body = fs.readFileSync(fileFor(publicDir, entry.url));
    if (body.length !== entry.size || body.length > MAX_FILE_BYTES || sha1_12(body) !== entry.hash) {
      throw new Error(`Source/manifest mismatch: ${entry.url}`);
    }
  }

  const header = buildHeader(manifest, qqGroup);
  if (header.length > MAX_HEADER_BYTES) throw new Error('Header exceeds browser limit');
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  const expectBytes = 12 + header.length + total;

  // ③ 输出冲突：默认拒绝覆盖任何一个同名产物
  const packDir = path.join(outDir, 'packs');
  const target = path.join(packDir, `resources-${manifest.version}.spresources`);
  const outputs = [
    target,
    `${target}.sha256`,
    path.join(outDir, 'public', 'data', 'resource-manifest.json'),
    path.join(outDir, 'public', 'js', 'resources', 'pack-config.js'),
    path.join(outDir, 'server', 'admission-files.json'),
  ];
  const existing = outputs.filter((f) => fs.existsSync(f));
  if (existing.length && !force) {
    throw new Error(`拒绝覆盖已存在的输出（${existing.length} 个）：\n  ${existing.join('\n  ')}\n（要覆盖请显式加 --force）`);
  }
  for (const dir of new Set(outputs.map((f) => path.dirname(f)))) ensureDir(dir);

  // ④ 写包：magic + uint32LE 头长 + 头 + 按清单顺序原样拼接的文件体；同步累加整包 SHA-256
  const whole = crypto.createHash('sha256');
  const proof = [];
  let fd = openTarget(target, force);
  try {
    const prefix = Buffer.alloc(12);
    prefix.write(MAGIC, 0, 'ascii');
    prefix.writeUInt32LE(header.length, 8);
    fs.writeSync(fd, prefix);
    whole.update(prefix);
    fs.writeSync(fd, header);
    whole.update(header);
    for (const entry of manifest.files) {
      const body = fs.readFileSync(fileFor(publicDir, entry.url));
      // 写包期间源又被改了：与 Python :43 一样当场拒绝，而不是产出一个坏包
      if (body.length !== entry.size || sha1_12(body) !== entry.hash) {
        throw new Error(`Resource changed during packaging: ${entry.url}`);
      }
      fs.writeSync(fd, body);
      whole.update(body);
      if (body.length >= PROOF_MIN_BYTES && body.length <= PROOF_MAX_BYTES) {
        proof.push({ url: entry.url, sha256: sha256hex(body) });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const stat = fs.statSync(target);
  if (stat.size !== expectBytes) {
    throw new Error(`内部错误：写出 ${stat.size} 字节，应为 12 + ${header.length} + ${total} = ${expectBytes}`);
  }
  const digest = whole.digest('hex');

  // ⑤ 四件套的其余三件（write_json 是 indent=2 + ensure_ascii=False；行尾跟随平台，见 platformEol）
  writeText(path.join(outDir, 'public', 'data', 'resource-manifest.json'), prettyJson(manifest), eol);
  writeText(path.join(outDir, 'server', 'admission-files.json'),
    prettyJson({ version: manifest.version, files: proof }), eol);
  writeText(path.join(outDir, 'public', 'js', 'resources', 'pack-config.js'),
    `export const RESOURCE_VERSION = ${JSON.stringify(manifest.version)};\n`
    + `export const RESOURCE_COUNT = ${manifest.files.length};\n`, eol);
  // ⑥ 旁挂摘要：`<digest>  <filename>\n`（与 Python :50 逐字节同形，含平台行尾）
  writeText(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`, eol);

  if (proof.length < 3) {
    log('Browser import is available; server admission needs at least 3 files of 1 KiB..256 KiB.');
  }
  return {
    pack: target, version: manifest.version, files: manifest.files.length,
    headerLen: header.length, bytes: stat.size, sha256: digest, proofEligibleFiles: proof.length,
  };
}

/**
 * 解析一个容器包（校验端，resource_pack.py:53-72 的等价物）。
 * 返回头、清单、逐文件字节与整包 SHA-256。
 * @param {Buffer} buf
 * @param {{expectSha256?:string, strict?:boolean}} [opts]
 */
export function parsePack(buf, opts = {}) {
  const strict = opts.strict !== false;
  if (buf.length < 12) throw new Error('Invalid magic');
  const magic = buf.toString('ascii', 0, 8);
  if (magic !== MAGIC) throw new Error('Invalid magic');
  const headerLen = buf.readUInt32LE(8);
  if (!(headerLen > 0) || headerLen > MAX_HEADER_BYTES) throw new Error('Invalid header length');
  if (12 + headerLen > buf.length) throw new Error('Truncated header');
  const headerText = buf.toString('utf8', 12, 12 + headerLen);
  const header = JSON.parse(headerText);
  if (header?.format !== 'sp-resource-pack' || header.version !== CONTAINER_VERSION) throw new Error('Unsupported pack format');
  const manifest = header.manifest;
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('Pack has no manifest');

  let offset = 12 + headerLen;
  const entries = [];
  for (const entry of manifest.files) {
    const size = entry.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error('Invalid resource size');
    if (offset + size > buf.length) throw new Error(`Corrupted/missing file: ${entry.url}`);
    const body = buf.subarray(offset, offset + size);
    offset += size;
    if (strict && sha1_12(body) !== entry.hash) throw new Error(`Corrupted/missing file: ${entry.url}`);
    entries.push({ ...entry, body });
  }
  if (strict && offset !== buf.length) throw new Error('Unexpected trailing bytes');
  const digest = sha256hex(buf);
  if (opts.expectSha256 && digest.toLowerCase() !== String(opts.expectSha256).toLowerCase()) {
    throw new Error('Whole-pack SHA256 mismatch');
  }
  return { header, headerLen, headerText, manifest, files: entries, sha256: digest, totalBytes: offset };
}

/**
 * 枚举模式的文件顺序：Python 用 `sorted(Path.rglob('*'))`，Path 之间按 **parts 元组**比较，
 * 也就是「目录里按名字排序、遇到目录就地递归」。这与「按完整路径字符串排序」在
 * `a/x` vs `a-x.png` 这类同名前缀上**结果不同**，所以这里显式按 parts 元组排。
 * @param {string[]} relPaths POSIX 相对路径
 */
export function sortByParts(relPaths) {
  const key = (p) => p.split('/');
  return [...relPaths].sort((a, b) => {
    const ka = key(a); const kb = key(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return ka.length - kb.length;
  });
}

/**
 * 从磁盘枚举（resource_pack.py:17-25 的等价物）。**不推荐**用于正式产出：
 * 它的 tier 规则退化成「fonts=1，其余全 2」（侦察报告 §3.8 坑①），且是按磁盘 glob 而不是按清单。
 * @param {string} publicDir
 */
export function enumerateFromDisk(publicDir) {
  const files = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) { walk(abs, childRel); continue; }
      if (!st.isFile()) continue;
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (!Object.prototype.hasOwnProperty.call(RESOURCE_MIME, ext)) continue;
      const url = `/${childRel}`;
      assertResourceUrl(url);
      const body = fs.readFileSync(abs);
      if (body.length > MAX_FILE_BYTES) throw new Error(`Resource exceeds 24 MiB: ${url}`);
      files.push({ url, size: body.length, hash: sha1_12(body), tier: rel.startsWith('fonts') ? 1 : 2 });
    }
  };
  for (const tree of ['assets', 'fonts']) {
    const abs = path.join(publicDir, tree);
    if (fs.existsSync(abs)) walk(abs, tree);
  }
  if (!files.length) throw new Error('No resource files found');
  // 与 Python 的 sorted() 同一顺序
  const byUrl = new Map(files.map((f) => [f.url, f]));
  return sortByParts(files.map((f) => f.url)).map((u) => byUrl.get(u));
}
