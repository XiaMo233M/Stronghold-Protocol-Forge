// test/zip.test.js — shared/zip.js: 一个依赖都没有的 ZIP 读写（docs/WORKSHOP.md §1「分享与安装一个包」）。
//
// 这个套件要钉死两件性质，它们分属两侧：
//
//   写侧 **字节确定**：条目排序 + 固定 DOS 时间戳 + 固定压缩等级，所以同样的输入永远得到同样的字节。
//   作者据此可以核对哈希，分发物也可以复现；否则「导出两次、哈希不同」会让任何校验都无从下手。
//
//   读侧 **拒绝而不是猜**：一个 zip 是别人给作者的文件，作者的编辑器会把它的每个字节都当真。这里的每个用例
//   都对应一种「猜了就会写坏盘」的形态：遍历名（../x、/abs、a\b、./x）、重名（后一个静默获胜）、加密、ZIP64、
//   未知压缩方法、CRC 不符、被截断、以及一个 42 字节就能声称解开 4 GB 的声明尺寸。任何一处「尽量解析」，
//   最后都变成编辑器替攻击者做了决定。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  zipWrite, zipRead, crc32,
  ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES, ZIP_MAX_FILE_BYTES, ZIP_MAX_NAME_BYTES,
} from '../shared/zip.js';

// ---- helpers ------------------------------------------------------------------------------------------------------

/**
 * 4 KB 的不可压缩数据：deflate 只会让它更大。由 SHA-256 链生成，所以既**不可压缩**（哈希输出没有可利用的
 * 冗余）又**可复现**（同一个 seed 永远得到同样的字节，用例失败时不会变成「偶尔失败」）。
 */
function incompressible(n, seed = 'a') {
  const out = Buffer.alloc(n);
  let block = createHash('sha256').update(String(seed)).digest();
  for (let at = 0; at < n; at += block.length) {
    block.copy(out, at, 0, Math.min(block.length, n - at));
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

/** EOCD 之前的中央目录，用来读出「这个条目到底用了什么方法」。 */
function centralEntries(buf) {
  const at = buf.length - 22;
  assert.equal(buf.readUInt32LE(at), 0x06054b50, 'a zip we wrote ends with an EOCD');
  const count = buf.readUInt16LE(at + 10);
  let pos = buf.readUInt32LE(at + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    out.push({
      name: buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(pos + 10),
      crc: buf.readUInt32LE(pos + 16),
      compSize: buf.readUInt32LE(pos + 20),
      rawSize: buf.readUInt32LE(pos + 24),
      localOffset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 把中央目录里某个字段改成另一个值（用于伪造 CRC / 尺寸，模拟「被改过的归档」）。 */
function patchCentral(buf, name, atOffset, value, size = 4) {
  let pos = buf.readUInt32LE(buf.length - 22 + 16);
  for (let i = 0; i < 64; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, 'walking the central directory');
    const nameLen = buf.readUInt16LE(pos + 28);
    const here = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (here === name) {
      if (size === 2) buf.writeUInt16LE(value, pos + atOffset); else buf.writeUInt32LE(value, pos + atOffset);
      return buf;
    }
    pos += 46 + nameLen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  throw new Error(`central entry ${name} not found`);
}

/** Every byte offset where `needle` starts (a name appears once in the local header and once in the central directory). */
function allOffsets(buf, needle) {
  const out = [];
  let at = buf.indexOf(needle);
  while (at >= 0) { out.push(at); at = buf.indexOf(needle, at + 1); }
  return out;
}

/**
 * Patch fields of several central-directory entries in one walk: `{ name: { 24: 4000 } }` sets the raw size of that
 * entry. Used to fake "a header that declares a size nothing on disk supports".
 */
function patchCentralMany(buf, changes) {
  const count = buf.readUInt16LE(buf.length - 22 + 10);
  let pos = buf.readUInt32LE(buf.length - 22 + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, 'walking the central directory');
    const nameLen = buf.readUInt16LE(pos + 28);
    const here = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    for (const [offset, value] of Object.entries(changes[here] ?? {})) buf.writeUInt32LE(value, pos + Number(offset));
    pos += 46 + nameLen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return buf;
}

/**
 * 手写一个 zip：本套件要测的正是「我们不能生成的东西」—— 加密、ZIP64、未知压缩方法、遍历名。
 * 结构上它仍然是合法归档，所以被拒绝只能是因为那一条规则，而不是因为解析器看不懂。
 * @param {Array<{ name: string, data?: Buffer|string, method?: number, flags?: number, crc?: number, rawSize?: number }>} entries
 * @param {{ count?: number, eocdCount?: number, extraEocdSize?: number }} [opts]
 */
function buildZip(entries, opts = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const crcData = method === 8 ? raw : raw; // the reader always checks the CRC against the DECODED bytes
    const crc = entry.crc ?? crc32(crcData);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.rawSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);
    central.push({ name, method, crc, compSize: payload.length, rawSize: entry.rawSize ?? raw.length, localOffset: offset });
    offset += local.length + payload.length;
  }
  const centralSize = central.reduce((n, e) => n + 46 + e.name.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.count ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocdCount ?? entries.length, 10);
  eocd.writeUInt32LE(opts.extraEocdSize ?? centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  const parts = [...locals];
  for (const e of central) {
    const rec = Buffer.alloc(46 + e.name.length);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(e.method, 10);
    rec.writeUInt32LE(e.crc, 16);
    rec.writeUInt32LE(e.compSize, 20);
    rec.writeUInt32LE(e.rawSize, 24);
    rec.writeUInt16LE(e.name.length, 28);
    rec.writeUInt32LE(e.localOffset, 42);
    e.name.copy(rec, 46);
    parts.push(rec);
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}

// ---- 往返与确定性 -------------------------------------------------------------------------------------------------

describe('shared/zip.js: 往返与字节确定性', () => {
  const samples = () => [
    { name: 'pack.json', data: Buffer.from('{\n  "id": "demo"\n}\n', 'utf8') },
    { name: 'chess.json', data: Buffer.from(JSON.stringify({ a: 1, b: '二' }), 'utf8') },
    { name: 'assets/voice/select 1.mp3', data: incompressible(2048, 'voice') },
    { name: 'kits/chess_ws_demo_a.js', data: Buffer.from('export default () => ({});\n', 'utf8') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];

  test('write → read gives back every entry, byte for byte, and skips a directory entry', () => {
    const zip = zipWrite([...samples(), { name: 'assets/', data: Buffer.alloc(0) }]);
    const read = zipRead(zip);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.skippedDirs, ['assets/'], 'a name ending in / is a directory, not a file');
    assert.deepEqual(read.entries.map((e) => e.name), samples().map((s) => s.name).sort(), 'entries come back sorted by name');
    for (const want of samples()) {
      const got = read.entries.find((e) => e.name === want.name);
      assert.ok(got, `${want.name} must survive the round trip`);
      assert.deepEqual(got.data, want.data, `${want.name} must come back byte for byte`);
    }
  });

  test('the same input always yields the same bytes — sorted, fixed timestamp, fixed level', () => {
    const a = zipWrite(samples());
    const b = zipWrite([...samples()].reverse());
    assert.deepEqual(a, b, 'the entry order of the caller must not change the archive');
    const again = zipWrite(samples());
    assert.deepEqual(a, again);
    // a FIXED DOS timestamp: 1980-01-01 00:00:00 → time 0x0000, date 0x0021 (see shared/zip.js)
    for (const e of centralEntries(a)) {
      const local = e.localOffset;
      assert.equal(a.readUInt16LE(local + 10), 0x0000, 'a fixed DOS time');
      assert.equal(a.readUInt16LE(local + 12), 0x0021, 'a fixed DOS date (1980-01-01)');
    }
    // …and no `extra` field, so nothing platform-specific leaks into the bytes
    for (const e of centralEntries(a)) assert.equal(a.readUInt16LE(e.localOffset + 28), 0, 'no local extra field');
  });

  test('a UTF-8 name round-trips (a pack directory may be written in Chinese)', () => {
    const zip = zipWrite([{ name: '素材/立绘.png', data: Buffer.from('png-ish') }]);
    const read = zipRead(zip);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.entries[0].name, '素材/立绘.png');
    assert.equal(read.entries[0].data.toString(), 'png-ish');
  });

  test('deflate is used when it helps and store when it does not (never make the pack bigger)', () => {
    const zip = zipWrite([
      { name: 'repetitive.txt', data: Buffer.from('a'.repeat(4096)) },
      { name: 'random.bin', data: incompressible(4096, 'random') },
    ]);
    const byName = Object.fromEntries(centralEntries(zip).map((e) => [e.name, e]));
    assert.equal(byName['repetitive.txt'].method, 8, 'a compressible entry is deflated');
    assert.ok(byName['repetitive.txt'].compSize < byName['repetitive.txt'].rawSize);
    assert.equal(byName['random.bin'].method, 0, 'an incompressible entry falls back to store');
    assert.equal(byName['random.bin'].compSize, byName['random.bin'].rawSize);
    // both still read back
    const read = zipRead(zip);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.entries.find((e) => e.name === 'random.bin').data, incompressible(4096, 'random'));
  });

  test('an empty archive is a valid archive (a pack always has pack.json, but the format must allow it)', () => {
    const zip = zipWrite([]);
    const read = zipRead(zip);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.entries, []);
  });

  test('read takes the name from the central directory, not from the (rewritable) local header', () => {
    const zip = zipWrite([{ name: 'safe.txt', data: Buffer.from('x') }]);
    // rewrite only the LOCAL header's name: a reader that trusted it would extract under the new name
    const at = zip.indexOf(Buffer.from('safe.txt'));
    Buffer.from('../up.txt').copy(zip, at);
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_NAME_MISMATCH', 'a local header that disagrees with the central directory is tampering');
  });
});

// ---- 拒绝 ---------------------------------------------------------------------------------------------------------

describe('shared/zip.js: 拒绝而不是猜（坏归档、恶意归档、超上限）', () => {
  test('a CRC mismatch is refused', () => {
    const zip = zipWrite([{ name: 'a.txt', data: Buffer.from('hello world') }]);
    patchCentral(zip, 'a.txt', 16, 0xdeadbeef);
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_CRC_MISMATCH');
  });

  test('a corrupted payload is caught by the CRC even when every size still matches', () => {
    const zip = zipWrite([{ name: 'a.txt', data: Buffer.from('hello world') }]);
    const at = zip.indexOf(Buffer.from('hello world'));
    zip[at] = 0x48; // 'H'
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_CRC_MISMATCH');
  });

  test('a truncated file is refused', () => {
    const zip = zipWrite([{ name: 'a.txt', data: Buffer.from('x'.repeat(64)) }]);
    for (const cut of [4, 22, 30, zip.length - 1, Math.floor(zip.length / 2)]) {
      const read = zipRead(zip.subarray(0, cut));
      assert.equal(read.ok, false, `a ${cut}-byte prefix must not read`);
      assert.ok(read.error.startsWith('ZIP_'), read.error);
    }
    assert.equal(zipRead(Buffer.alloc(0)).error, 'ZIP_TRUNCATED');
    assert.equal(zipRead(Buffer.from('not a zip at all, just text')).error, 'ZIP_BAD_EOCD');
  });

  test('a local header that runs past the end of the file is refused before anything is read', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello' }]);
    // a local name length that would push the payload past the end of the file: the read is bounds-checked against the
    // remaining buffer, so it refuses instead of trusting the header and slicing out of thin air
    zip.writeUInt16LE(1000, 0 + 26);
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_TRUNCATED');
  });

  test('an entry that declares more bytes than it encodes is refused', () => {
    const zip = zipWrite([{ name: 'a.txt', data: Buffer.from('hello') }]);
    patchCentral(zip, 'a.txt', 24, 4096); // raw size 4096, but only 5 bytes are there
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_TRUNCATED');
  });

  test('ZIP64 is refused by code, not by luck', () => {
    const eocd64 = buildZip([{ name: 'a.txt', data: 'x' }], { count: 0xffff });
    const r1 = zipRead(eocd64);
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'ZIP64_UNSUPPORTED');

    const zip = buildZip([{ name: 'a.txt', data: 'x' }]);
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16); // central directory offset
    assert.equal(zipRead(zip).error, 'ZIP64_UNSUPPORTED');
  });

  test('an encrypted entry is refused', () => {
    const zip = buildZip([{ name: 'secret.txt', data: 'x', flags: 0x0001 }]);
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_ENCRYPTED');
  });

  test('any compression method other than 0 (store) and 8 (deflate) is refused', () => {
    for (const method of [1, 9, 12, 14, 99]) {
      const zip = buildZip([{ name: 'a.txt', data: 'x', method }]);
      const read = zipRead(zip);
      assert.equal(read.ok, false, `method ${method} must be refused`);
      assert.equal(read.error, 'ZIP_BAD_METHOD', `method ${method}`);
    }
  });

  test('a multi-disk archive is refused', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'x' }]);
    zip.writeUInt16LE(1, zip.length - 22 + 4); // "this disk"
    assert.equal(zipRead(zip).error, 'ZIP_MULTI_DISK');

    const diskStart = buildZip([{ name: 'a.txt', data: 'x' }]);
    let pos = diskStart.readUInt32LE(diskStart.length - 22 + 16);
    diskStart.writeUInt16LE(3, pos + 34); // "disk number start"
    assert.equal(zipRead(diskStart).error, 'ZIP_MULTI_DISK');
  });

  test('a hostile name is refused: traversal, absolute, backslash, dot segments', () => {
    const names = ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/windows/evil.txt', 'a\\b.txt', './x.txt', 'a/./b.txt', 'a//b.txt'];
    for (const name of names) {
      const zip = buildZip([{ name, data: 'x' }]);
      const read = zipRead(zip);
      assert.equal(read.ok, false, `${name} must be refused`);
      assert.equal(read.error, 'ZIP_BAD_NAME', `${name}: got ${read.error}`);
    }
  });

  test('a duplicate name is refused — the second one would silently win', () => {
    const zip = zipWrite([
      { name: 'same.txt', data: Buffer.from('first') },
      { name: 'same.txt', data: Buffer.from('first') },
    ]);
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_DUPLICATE_NAME');
  });

  test('an empty or over-long name is refused', () => {
    const overLong = `${'a'.repeat(ZIP_MAX_NAME_BYTES)}.txt`;
    for (const name of ['', overLong]) {
      const zip = buildZip([{ name, data: 'x' }]);
      const read = zipRead(zip);
      assert.equal(read.ok, false, `"${name.slice(0, 20)}…" must be refused`);
      assert.equal(read.error, 'ZIP_BAD_NAME');
    }
    // exactly at the cap is still fine (255 bytes is the format's own limit)
    const ok = zipWrite([{ name: 'b'.repeat(ZIP_MAX_NAME_BYTES), data: Buffer.from('x') }]);
    assert.equal(zipRead(ok).ok, true);
  });

  test('the entry cap, the per-file cap and the total cap are enforced', () => {
    const zip = zipWrite([
      { name: 'a.bin', data: incompressible(512, 'a') },
      { name: 'b.bin', data: incompressible(512, 'b') },
      { name: 'c.bin', data: incompressible(512, 'c') },
    ]);
    assert.equal(zipRead(zip).ok, true, 'the default caps accept a normal pack');

    const tooMany = zipRead(zip, { maxEntries: 2 });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error, 'ZIP_TOO_MANY_ENTRIES');

    const tooBigFile = zipRead(zip, { maxFileBytes: 100 });
    assert.equal(tooBigFile.ok, false);
    assert.equal(tooBigFile.error, 'ZIP_ENTRY_TOO_LARGE');
    // a single entry may not be the whole budget: the cap is checked against the file, independently of the total
    assert.ok(ZIP_MAX_FILE_BYTES < ZIP_MAX_TOTAL_BYTES);
  });

  test('a declared size is checked BEFORE anything is allocated or inflated', () => {
    // 8 KB of zeros deflates to a few bytes; a header that claims 4 GB is a decompression bomb
    const zip = buildZip([{ name: 'bomb.bin', data: Buffer.alloc(8192), method: 8, rawSize: 0xfffffff0 }]);
    const read = zipRead(zip, { maxFileBytes: 1024 });
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_ENTRY_TOO_LARGE', 'the declared size is refused before inflation');
    // …and with room for the claim, the lie is caught after inflation (the real output is 8 KB, not 4 GB)
    const generous = zipRead(zip, { maxFileBytes: 0xffffffff, maxTotalBytes: 0xffffffff });
    assert.equal(generous.ok, false);
    assert.equal(generous.error, 'ZIP_TRUNCATED', 'the declared size must equal what the entry really decodes to');

    // a declared size SMALLER than the real output: zlib stops at maxOutputLength instead of inflating the whole bomb
    const stunted = buildZip([{ name: 'stunted.bin', data: Buffer.alloc(8192), method: 8, rawSize: 100 }]);
    const r2 = zipRead(stunted);
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'ZIP_INFLATE_FAILED', 'inflation is capped at the declared size');
  });

  test('the total cap counts declared sizes, and the archive-inside-the-cap case is refused up front', () => {
    // an entry that DECLARES more than the whole budget while encoding 4 bytes: the declared size alone must trip the
    // total cap, and it must trip it BEFORE the (lying) entry is inflated
    const zip = zipWrite([{ name: 'a.bin', data: Buffer.from('aaaa') }]);
    patchCentralMany(zip, { 'a.bin': { 24: 60000 } });
    const sum = zipRead(zip, { maxTotalBytes: 50000 });
    assert.equal(sum.ok, false);
    assert.equal(sum.error, 'ZIP_TOTAL_TOO_LARGE');

    // an archive that is itself bigger than the cap never gets as far as reading an entry
    const big = zipWrite([{ name: 'a.bin', data: incompressible(2048, 'big') }]);
    const read = zipRead(big, { maxTotalBytes: 64 });
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_TOO_LARGE');
  });

  test('the default caps themselves are the documented numbers', () => {
    // the numbers are part of the contract: a real pack needs far less, an attacker sends far more (shared/zip.js)
    assert.equal(ZIP_MAX_ENTRIES, 4096);
    assert.equal(ZIP_MAX_FILE_BYTES, 32 * 1024 * 1024);
    assert.equal(ZIP_MAX_TOTAL_BYTES, 64 * 1024 * 1024);
    assert.equal(ZIP_MAX_NAME_BYTES, 255);
  });

  test('a directory entry is skipped, and a directory entry with a hostile name is still refused', () => {
    const zip = buildZip([{ name: 'assets/', data: '' }, { name: 'assets/a.txt', data: 'x' }]);
    const read = zipRead(zip);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.skippedDirs, ['assets/']);
    assert.deepEqual(read.entries.map((e) => e.name), ['assets/a.txt']);

    const hostileDir = buildZip([{ name: '../', data: '' }]);
    const r2 = zipRead(hostileDir);
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'ZIP_BAD_NAME');
  });

  test('a name that is not valid UTF-8 is refused rather than decoded with replacement characters', () => {
    const zip = zipWrite([{ name: 'ok.txt', data: Buffer.from('x') }]);
    // patch the name in BOTH headers, so the only reason left to refuse is the encoding itself
    for (const at of allOffsets(zip, Buffer.from('ok.txt'))) zip[at] = 0xff; // invalid UTF-8 lead byte
    const read = zipRead(zip);
    assert.equal(read.ok, false);
    assert.equal(read.error, 'ZIP_BAD_NAME');
  });

  test('crc32 matches the reference vector for "123456789"', () => {
    assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });
});
