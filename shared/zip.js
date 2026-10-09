// shared/zip.js — 极简依赖为零的 ZIP 读写（docs/WORKSHOP.md §1「分享与安装一个包」）。
//
// 为什么自己写：一个工坊包必须能**交给别人**，而项目的 dependencies 刻意保持很小（整合包用
// `npm ci --omit=dev` 重装）。为了一个「打包成 zip」的按钮引一个解压库不值得，而且 ZIP 的读取面是
// **不可信输入**：作者会把别人给的 .zip 拖进编辑器。所以这里只用 node:zlib（deflateRawSync /
// inflateRawSync）加自己的一份 CRC-32，并把「拒绝」写成显式清单 —— 猜一个畸形归档的结构，
// 比拒绝它更危险。
//
// 确定性（写侧）：条目按名字排序、用**固定的 DOS 时间戳**、deflate level 9。同样的输入永远得到同样的
// 字节（test/zip.test.js 钉住了这条）—— 否则同一个包每次导出的哈希都不同，作者无法核对、也没有可复现的
// 分发物。
//
// 防御（读侧）：每个长度/偏移都当作敌意数据处理 —— 先对剩余缓冲区做边界检查再读，绝不用头里的
// 尺寸字段直接分配内存（一个 42 字节的归档可以声称解开有 4 GB）。declared size 超上限、条目数超上限、
// 归档总量超上限、CRC 不符、压缩方法不是 0/8、ZIP64、加密、多卷、名字是绝对路径/含反斜杠/含 `.` 或
// `..` 段/为空/超过 255 字节、重名 —— 全部拒绝，绝不猜测。目录条目（名字以 `/` 结尾）跳过并在
// `skippedDirs` 里报告。

import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ---- 上限（每一条都说明：真实包需要多少 vs 攻击者会发什么） ------------------------------------------------------

/** 条目数上限。真实包：内容文件 + kits + 素材，几百个顶天了；攻击者：一个只有中央目录的归档能声称上万条。 */
export const ZIP_MAX_ENTRIES = 4096;
/** 解开后的总字节上限。真实包：几十 MB 的语音/图集已经很大；攻击者：deflate 可以把 1 KB 放大成 GB（解压炸弹）。 */
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 单个条目解开后的上限。真实包：最大的语音或图集也就几 MB；攻击者：单独一条就撑爆内存。 */
export const ZIP_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** 名字（UTF-8 字节）上限。真实包：路径再长也就一两百字节；攻击者：用超长名字撑爆中央目录的解析。 */
export const ZIP_MAX_NAME_BYTES = 255;

/** defaultZipLimits: 调用方可以不传任何 cap，得到的就是上面那三个（写成一个对象，避免三处默认值漂移）。 */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: ZIP_MAX_ENTRIES,
  maxTotalBytes: ZIP_MAX_TOTAL_BYTES,
  maxFileBytes: ZIP_MAX_FILE_BYTES,
});

// ---- 常量 ---------------------------------------------------------------------------------------------------------

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** EOCD 是 22 字节 + 可选的注释，注释最长 65535。 */
const EOCD_MIN = 22;
const EOCD_MAX = EOCD_MIN + 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 固定的 DOS 时间戳：1980-01-01 00:00:00（DOS 时间戳的零点，`date = ((1980-1980)<<9)|(1<<5)|1 = 0x0021`）。 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** 压缩等级 9：确定性优先于速度，一个包也就几 MB。 */
const DEFLATE_LEVEL = 9;

// ---- CRC-32 -------------------------------------------------------------------------------------------------------

/** CRC-32（IEEE 802.3）查表：ZIP 的每条本地头与中央目录项都带它，读侧靠它判断字节有没有被动过。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 无符号 32 位 CRC-32
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 写 -----------------------------------------------------------------------------------------------------------

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(data));

/** 名字的 UTF-8 字节与 general purpose bit 11（「这个文件名是 UTF-8」）：非 ASCII 才置位，至少能自解释。 */
function nameFor(name) {
  if (typeof name !== 'string' || !name) throw new Error('zipWrite: every entry needs a non-empty string name');
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > ZIP_MAX_NAME_BYTES) throw new Error(`zipWrite: name is longer than ${ZIP_MAX_NAME_BYTES} bytes: ${name.slice(0, 40)}…`);
  return { bytes, utf8: /[^\x20-\x7e]/.test(name) };
}

/**
 * 写一个 ZIP 归档。条目按名字排序、时间戳固定、deflate（方法 8）—— 只有当 deflate 真的更小才用它，
 * 否则退回 store（方法 0）：对一段随机字节或一个已经很小的文件，deflate 反而更大，而「压缩」不该让包变大。
 *
 * @param {Array<{ name: string, data: Buffer|Uint8Array|string }>} entries
 * @returns {Buffer}
 */
export function zipWrite(entries) {
  if (!Array.isArray(entries)) throw new Error('zipWrite: entries must be an array of { name, data }');
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  /** @type {Array<{ name: Buffer, utf8: boolean, method: number, crc: number, compSize: Buffer, rawSize: number, payload: Buffer, offset: number }>} */
  const prepared = [];
  for (const entry of sorted) {
    const raw = toBuffer(entry.data ?? Buffer.alloc(0));
    const named = nameFor(entry.name);
    // deflateRawSync（不是 deflateSync）：ZIP 的本地记录自己就是容器，再套一层 zlib 头尾会让所有解压器认不出
    const deflated = deflateRawSync(raw, { level: DEFLATE_LEVEL });
    const useDeflate = deflated.length < raw.length;
    prepared.push({
      name: named.bytes,
      utf8: named.utf8,
      method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
      crc: crc32(raw),
      compSize: useDeflate ? deflated.length : raw.length,
      rawSize: raw.length,
      payload: useDeflate ? deflated : raw,
      offset: 0,
    });
  }

  // 先算本地记录 + 数据的偏移，再算中央目录的大小，最后写 EOCD：任何一处长度算错都会让归档无法读取
  let localSize = 0;
  for (const e of prepared) {
    e.offset = localSize;
    localSize += 30 + e.name.length + e.compSize;
  }
  const centralSize = prepared.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = Buffer.alloc(localSize + centralSize + EOCD_MIN);
  let at = 0;

  for (const e of prepared) {
    out.writeUInt32LE(LOCAL_SIG, at);
    out.writeUInt16LE(20, at + 4);                      // version needed: 2.0（deflate 的最低要求）
    out.writeUInt16LE(e.utf8 ? 0x0800 : 0, at + 6);     // bit 11 = 文件名是 UTF-8
    out.writeUInt16LE(e.method, at + 8);
    out.writeUInt16LE(DOS_TIME, at + 10);
    out.writeUInt16LE(DOS_DATE, at + 12);
    out.writeUInt32LE(e.crc, at + 14);
    out.writeUInt32LE(e.compSize, at + 18);
    out.writeUInt32LE(e.rawSize, at + 22);
    out.writeUInt16LE(e.name.length, at + 26);
    out.writeUInt16LE(0, at + 28);                      // extra len：不写 extra field，字节就完全由内容决定
    e.name.copy(out, at + 30);
    e.payload.copy(out, at + 30 + e.name.length);
    at += 30 + e.name.length + e.compSize;
  }

  const centralStart = at;
  for (const e of prepared) {
    out.writeUInt32LE(CENTRAL_SIG, at);
    out.writeUInt16LE(20, at + 4);                      // version made by
    out.writeUInt16LE(20, at + 6);                      // version needed
    out.writeUInt16LE(e.utf8 ? 0x0800 : 0, at + 8);
    out.writeUInt16LE(e.method, at + 10);
    out.writeUInt16LE(DOS_TIME, at + 12);
    out.writeUInt16LE(DOS_DATE, at + 14);
    out.writeUInt32LE(e.crc, at + 16);
    out.writeUInt32LE(e.compSize, at + 20);
    out.writeUInt32LE(e.rawSize, at + 24);
    out.writeUInt16LE(e.name.length, at + 28);
    out.writeUInt16LE(0, at + 30);                      // extra
    out.writeUInt16LE(0, at + 32);                      // comment
    out.writeUInt16LE(0, at + 34);                      // disk number
    out.writeUInt16LE(0, at + 36);                      // internal attrs
    out.writeUInt32LE(0, at + 38);                      // external attrs
    out.writeUInt32LE(e.offset, at + 42);
    e.name.copy(out, at + 46);
    at += 46 + e.name.length;
  }
  const centralActual = at - centralStart;

  out.writeUInt32LE(EOCD_SIG, at);
  out.writeUInt16LE(0, at + 4);                         // this disk
  out.writeUInt16LE(0, at + 6);                         // disk with the central directory
  out.writeUInt16LE(prepared.length, at + 8);           // entries on this disk
  out.writeUInt16LE(prepared.length, at + 10);          // entries total
  out.writeUInt32LE(centralActual, at + 12);
  out.writeUInt32LE(centralStart, at + 16);
  out.writeUInt16LE(0, at + 20);                        // comment length
  return out;
}

// ---- 读 -----------------------------------------------------------------------------------------------------------

/** 一个拒绝：`code` 给测试与调用方判断，`detail` 给人看。`zipRead` 从不抛异常，只返回这个。 */
const refusal = (code, detail) => ({ ok: false, error: code, detail });

const has = (buf, at, n) => at >= 0 && n >= 0 && at + n <= buf.length;

/** 归档在 EOCD 之前就断了：单独一个 code，因为「文件没下完」和「文件被改过」要分开说。 */
const truncated = (detail) => refusal('ZIP_TRUNCATED', detail);

/** General-purpose bit 11:「这个文件名是 UTF-8」(APPNOTE 4.4.4)。 */
const UTF8_FLAG = 0x0800;
/** Info-ZIP Unicode Path extra field (0x7075, APPNOTE 4.6.9)：`version(1) + nameCRC32(4) + utf8Name`。 */
const UNICODE_PATH_ID = 0x7075;

/**
 * 解出一个条目的名字。**「有中文文件夹就不让导入」是错的**，所以这里不是「UTF-8 失败就拒」，而是按 ZIP 自己的
 * 规矩分三种情况（这套逻辑原来只长在 `tools/package-update.mjs` 的 `entryName` 里，包导入这条路没有 —— 现在
 * 两处共用这一份，见 `test/zip.test.js` 与 `test/update-package.test.js`）：
 *
 *   1. **bit 11 置位** ⇒ 头自己承诺了 UTF-8。承诺坏了（字节不是合法 UTF-8）就是**坏归档**，照旧拒（`fatal: true`）。
 *      这一条必须留着：用替换字符「猜」出来的名字会让名字检查放行一个其实不同的文件。
 *   2. **bit 11 未置位 + 有 0x7075 extra field** ⇒ 用它的 UTF-8 名字（CRC 与头里的名字对上才认，否则那是被改过的
 *      字段）。Info-ZIP 的 zip 在 Windows 上就把真名只放在这里。
 *   3. **bit 11 未置位、没有那个字段** ⇒ 先按严格 UTF-8 试（不少工具写 UTF-8 却不置位），再按 **Windows 中文
 *      codepage（GBK）** 试 —— `tar` / 资源管理器造的中文名 zip 就是这一种，而玩家的解压器也是这么解的。
 *      两种都解不出来才拒（那才是真的坏字节，例如 0xFF）。
 *
 * 为什么**没有** CP437 兜底：ZIP 的规范默认码页是 CP437，但 WHATWG 的 `TextDecoder` 根本不提供它 —— 加一个
 * 「每个字节都能解出东西」的兜底等于**永远不再拒绝坏名字**，那不是宽松，是把这一层判据删掉。GBK 覆盖了我们
 * 真正会遇到的那一类（Windows 中文工具），其余情况如实拒绝并说明试过哪些编码。
 *
 * 安全性不变：解出来的名字照样过 `nameProblem`（穿越 / 绝对路径 / 反斜杠 / 空段），所以「解码宽松」不会变成
 * 「写文件跑到包目录外面」。
 * @param {Buffer|Uint8Array} nameBuf
 * @param {Buffer|Uint8Array} extraBuf 中央目录条目里那段 extra field（可能是空的）
 * @param {number} flags general purpose bit flag
 * @returns {{ ok: true, name: string } | { ok: false, detail: string }}
 */
export function decodeEntryName(nameBuf, extraBuf = Buffer.alloc(0), flags = 0) {
  const raw = Buffer.isBuffer(nameBuf) ? nameBuf : Buffer.from(nameBuf);
  const extra = extraBuf && extraBuf.length ? (Buffer.isBuffer(extraBuf) ? extraBuf : Buffer.from(extraBuf)) : null;
  const utf8Strict = () => new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (flags & UTF8_FLAG) {
    try {
      return { ok: true, name: utf8Strict() };
    } catch {
      return { ok: false, detail: 'the entry sets the UTF-8 flag (bit 11) but its bytes are not valid UTF-8 — a broken archive, not a codepage difference' };
    }
  }
  if (extra) {
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra.readUInt16LE(q);
      const len = extra.readUInt16LE(q + 2);
      if (q + 4 + len > extra.length) break;
      if (id === UNICODE_PATH_ID && len >= 5 && extra[q + 4] === 1
        && (crc32(raw) >>> 0) === extra.readUInt32LE(q + 5)) {
        return { ok: true, name: extra.toString('utf8', q + 9, q + 4 + len) };
      }
      q += 4 + len;
    }
  }
  try {
    return { ok: true, name: utf8Strict() };
  } catch { /* 不是 UTF-8：往下试本地码页 */ }
  try {
    return { ok: true, name: new TextDecoder('gbk', { fatal: true }).decode(raw) };
  } catch { /* 也不是 GBK */ }
  return { ok: false, detail: 'its bytes are not valid UTF-8 and not valid GBK either (the two encodings we can read without guessing) — re-zip it with a tool that writes UTF-8 names' };
}

/**
 * 读一个 ZIP 归档，带三道帽子：条目数、单条解压后大小、解压后总量。
 *
 * 每个字段先边界检查再使用；解压用 zlib 的 `maxOutputLength`（头里的 uncompressed size）兜住压缩炸弹，
 * 再用「实际长度必须等于声明长度」二次确认头没有说谎 —— 只信头等于让攻击者自己申报大小。
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{ maxEntries?: number, maxTotalBytes?: number, maxFileBytes?: number }} [limits]
 * @returns {{ ok: true, entries: Array<{ name: string, data: Buffer }>, skippedDirs: string[] }
 *   | { ok: false, error: string, detail: string }}
 */
export function zipRead(buffer, limits = {}) {
  const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  const maxFileBytes = limits.maxFileBytes ?? ZIP_MAX_FILE_BYTES;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);

  if (buf.length < EOCD_MIN) return truncated(`only ${buf.length} byte(s) — too short to be a zip archive`);
  if (buf.length > maxTotalBytes) {
    return refusal('ZIP_TOO_LARGE', `the archive itself is ${buf.length} bytes, over the ${maxTotalBytes} byte cap`);
  }

  // ---- EOCD：从尾部往前找。中央目录的偏移/大小/条数只信它，且每一条都要自洽 --------------------------------
  let eocd = -1;
  const from = Math.max(0, buf.length - EOCD_MAX);
  for (let i = buf.length - EOCD_MIN; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return refusal('ZIP_BAD_EOCD', 'no end-of-central-directory record found (not a zip archive, or truncated)');
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (eocd + EOCD_MIN + commentLen !== buf.length) {
    return refusal('ZIP_BAD_EOCD', 'the end-of-central-directory record does not end at the end of the file');
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  // 0 in these fields is how ZIP64 says "the real value is in the ZIP64 record" — we do not read that record, so refuse
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || buf.readUInt16LE(eocd + 8) === 0xffff) {
    return refusal('ZIP64_UNSUPPORTED', 'a ZIP64 archive (only zip64 for a >4 GB pack, which is not a thing here)');
  }
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== entryCount) {
    return refusal('ZIP_MULTI_DISK', 'a multi-disk archive (or an inconsistent entry count)');
  }
  if (!has(buf, centralOffset, centralSize)) return truncated('the central directory lies outside the file');
  if (entryCount > maxEntries) {
    return refusal('ZIP_TOO_MANY_ENTRIES', `${entryCount} entries, over the ${maxEntries} entry cap`);
  }

  /** @type {Array<{ name: string, data: Buffer }>} */
  const entries = [];
  /** @type {string[]} */
  const skippedDirs = [];
  const seen = new Set();
  let totalBytes = 0;
  let totalCompressed = 0;
  let at = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (!has(buf, at, 46)) return truncated(`central directory entry ${i} runs past the end of the file`);
    if (buf.readUInt32LE(at) !== CENTRAL_SIG) return refusal('ZIP_BAD_CENTRAL', `central directory entry ${i} has a bad signature`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const rawSize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentAt = buf.readUInt16LE(at + 32);
    const diskStart = buf.readUInt16LE(at + 34);
    const localOffset = buf.readUInt32LE(at + 42);

    if (flags & 0x0001) return refusal('ZIP_ENCRYPTED', `entry ${i} is encrypted`);
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      return refusal('ZIP_BAD_METHOD', `entry ${i} uses compression method ${method} (only 0 = store and 8 = deflate are read)`);
    }
    if (diskStart !== 0) return refusal('ZIP_MULTI_DISK', `entry ${i} starts on disk ${diskStart}`);
    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) {
      return refusal('ZIP64_UNSUPPORTED', `entry ${i} needs ZIP64`);
    }
    if (!has(buf, at, 46 + nameLen + extraLen + commentAt)) return truncated(`entry ${i}'s name/extra/comment field runs past the end of the file`);

    const nameBuf = buf.subarray(at + 46, at + 46 + nameLen);
    if (nameLen === 0) return refusal('ZIP_BAD_NAME', `entry ${i} has an empty name`);
    if (nameLen > ZIP_MAX_NAME_BYTES) return refusal('ZIP_BAD_NAME', `entry ${i}'s name is ${nameLen} bytes, over the ${ZIP_MAX_NAME_BYTES} byte cap`);
    const extraBuf = buf.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
    const decoded = decodeEntryName(nameBuf, extraBuf, flags);
    if (!decoded.ok) return refusal('ZIP_BAD_NAME', `entry ${i}'s name: ${decoded.detail}`);
    const name = decoded.name;
    if (name.endsWith('/')) {
      // 目录条目：跳过，但**名字规则照样过一遍** —— 删掉尾部斜杠之后 `../` 就是 `..`，
      // 跳过不等于免检。目录名里带一个空段（`a//b/`）在这里也会被拒。
      const badDir = nameProblem(name.slice(0, -1));
      if (badDir) return refusal('ZIP_BAD_NAME', `entry ${i} directory "${name}": ${badDir}`);
      skippedDirs.push(name);
      at += 46 + nameLen + extraLen + commentAt;
      continue;
    }
    const bad = nameProblem(name);
    if (bad) return refusal('ZIP_BAD_NAME', `entry ${i} "${name}": ${bad}`);
    if (seen.has(name)) return refusal('ZIP_DUPLICATE_NAME', `"${name}" appears twice — the second would silently win`);
    seen.add(name);

    // 先在**声明**的大小上把关：一个头声称解开有 4 GB 的条目不必真的去解压才知道该拒绝
    if (rawSize > maxFileBytes) return refusal('ZIP_ENTRY_TOO_LARGE', `"${name}" declares ${rawSize} bytes, over the ${maxFileBytes} byte per-file cap`);
    if (totalBytes + rawSize > maxTotalBytes) {
      return refusal('ZIP_TOTAL_TOO_LARGE', `"${name}" would take the archive past the ${maxTotalBytes} byte total cap`);
    }

    const data = readEntry(buf, localOffset, method, compSize, rawSize, name);
    if (!data.ok) return data;
    if (data.data.length !== rawSize) return truncated(`"${name}" decoded to ${data.data.length} byte(s) but declares ${rawSize}`);
    if (crc32(data.data) !== crc) return refusal('ZIP_CRC_MISMATCH', `"${name}" does not match its CRC-32 record (corrupted or tampered with)`);
    totalBytes += data.data.length;
    totalCompressed += compSize;
    if (totalBytes > maxTotalBytes) return refusal('ZIP_TOTAL_TOO_LARGE', `the archive expands past the ${maxTotalBytes} byte total cap`);
    entries.push({ name, data: data.data });
    at += 46 + nameLen + extraLen + commentAt;
  }
  // 走完申报的条目数之后，指针必须正好落在中央目录的末尾：多了说明 EOCD 的 size/count 与内容不符
  if (at !== centralOffset + centralSize) {
    return refusal('ZIP_BAD_CENTRAL', 'the central directory is not the size its end record declares');
  }
  // 压缩包本身的上限是另一件事：中央目录可能只声明了很小的条目，而本地记录里塞着巨大的数据块
  if (totalCompressed > maxTotalBytes) {
    return refusal('ZIP_TOO_LARGE', `the entries occupy ${totalCompressed} bytes, over the ${maxTotalBytes} byte cap`);
  }
  return { ok: true, entries, skippedDirs };
}

/**
 * Why a name may not be extracted, or null when it is acceptable. Two lines of defence live here and in the
 * extractor (tools/workshop-pack.mjs `assertEntryName`); this is the one that decides whether the ARCHIVE is read
 * at all. A name that survives this can still be extracted with `path.join(root, ...name.split('/'))` safely.
 */
function nameProblem(name) {
  if (!name) return 'empty name';
  if (name.startsWith('/')) return 'absolute path';
  if (name.includes('\\')) return 'backslash separator';
  if (/^[A-Za-z]:/.test(name)) return 'drive-letter path';
  if (name.split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) return 'a "." or ".." path segment (or an empty one)';
  return null;
}

/**
 * 读一条本地记录并解压 payload。偏移与长度都在这里对着缓冲区做边界检查。
 *
 * `expectedName` 是中央目录里的名字：本地记录**也**写着这个名字，两者必须一致。不一致说明归档被改过
 * （只改本地头就能让正文与中央目录指向的东西不同），而接下来要解压的正是本地头说的那些字节 —— 所以这不是
 * 形式检查，是「你要解压的东西到底是谁」。
 */
function readEntry(buf, localOffset, method, compSize, rawSize, expectedName) {
  if (!has(buf, localOffset, 30)) return truncated(`a local header at offset ${localOffset} lies outside the file`);
  if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) return refusal('ZIP_BAD_LOCAL', `no local file header at offset ${localOffset}`);
  if (buf.readUInt16LE(localOffset + 6) & 0x0001) return refusal('ZIP_ENCRYPTED', 'a local header is marked encrypted');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  if (!has(buf, localOffset + 30, nameLen)) return truncated('a local header\'s name runs past the end of the file');
  // 两边都要**按同一套编码规则解出来**再比（中央目录那份已经解好了）：中文名在本地头里同样是 GBK，
  // 直接 `toString('utf8')` 比会把一份完全正常的归档判成「两个头名字不同」（实测过）。
  // 用 extra field 时的 CRC 校验发生在 `decodeEntryName` 里，所以「只改本地头」照样拦得住。
  const localName = decodeEntryName(
    buf.subarray(localOffset + 30, localOffset + 30 + nameLen),
    buf.subarray(localOffset + 30 + nameLen, localOffset + 30 + nameLen + extraLen),
    buf.readUInt16LE(localOffset + 6),
  );
  if (!localName.ok || localName.name !== expectedName) {
    return refusal('ZIP_NAME_MISMATCH', `the local header for "${expectedName}" carries a different name`);
  }
  const dataStart = localOffset + 30 + nameLen + extraLen;
  if (!has(buf, dataStart, compSize)) return truncated('an entry\'s compressed data runs past the end of the file');
  const raw = buf.subarray(dataStart, dataStart + compSize);
  if (method === METHOD_STORE) return { ok: true, data: Buffer.from(raw) };
  try {
    // maxOutputLength：头里申报的 rawSize 是解压的硬上限，所以「1 KB 声称解开 100 MB」在 zlib 里就失败了
    return { ok: true, data: inflateRawSync(raw, { maxOutputLength: rawSize }) };
  } catch (e) {
    return refusal('ZIP_INFLATE_FAILED', `an entry could not be inflated: ${e && e.message ? e.message : String(e)}`);
  }
}
