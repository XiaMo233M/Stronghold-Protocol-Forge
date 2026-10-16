// Concurrent, idempotent, verifying downloader for the asset pipeline.
//
// - Bounded concurrency (default 16) over a job list; each job writes exactly one
//   file under the output root, atomically (temp file + rename), so a partial
//   download never appears at the final path.
// - Per source: up to `retries` attempts with exponential backoff on network
//   errors, timeouts, 403/429/5xx and payloads that fail format validation;
//   a 404/410 moves on immediately. Each candidate uses its opt-in prefix proxy
//   first (when enabled), then the original URL and jsDelivr fallback. The proxy gets one short attempt
//   per file and shares a run-wide circuit breaker with the index/font fetchers.
// - HTTP(S)_PROXY: the default fetch uses it only when this process was started
//   with NODE_USE_ENV_PROXY=1 (Node >=22.21 or >=24); on such a Node started
//   without it, it fails closed; an older Node warns and connects directly
//   (tools/assets/env-proxy.mjs). Pass fetchImpl to bypass that, as tests do.
// - Idempotent: an existing file is kept when its size matches the ledger entry
//   of a previous download or the expected byte count from research, or (when
//   neither is known) when it passes format validation. When the ledger entry also
//   carries a `sha256` (written by this version), the kept file's content must
//   match it as well — an entry without one keeps today's size-only decision, so
//   upgrading never re-downloads a library that is already on disk. The ledger
//   lives in .cache/assets-ledger.json. `keepExisting` (fetch-assets --add-only)
//   keeps every existing file as it is; `written` = the files this run wrote.
// - Resumable: a body is streamed to a stable `<file>.part` (never `<file>.part<pid>`),
//   so an interrupted download leaves the bytes it got. The next run sends
//   `Range: bytes=<part size>-` for a file of at least MIN_RESUMABLE_BYTES once the
//   source is proven to honour Range (a one-byte probe, and every resumed response
//   must be a 206); a source that ignores Range is re-downloaded whole, and the
//   assembled length and hash are checked before the file is renamed into place.
//   `.part` files are never orphans and are never pruned.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MirrorPolicy } from './network.mjs';
import { validate, isCompletePng } from './formats.mjs';
import { guardDefaultFetch } from './env-proxy.mjs';

/**
 * @typedef {{ rel: string, urls: string[], kind: string, bytes?: number, mutable?: boolean }} Job
 * @typedef {{ status: 'ok'|'skip'|'miss'|'error', bytes: number, url?: string, error?: string, sizeChanged?: boolean }} JobResult
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Below this, a resumed download saves less than a request costs: a fresh whole download is simpler and safer. */
export const MIN_RESUMABLE_BYTES = 1048576;

/** Stable suffix of the in-progress file (no pid: the next run must find the same path to resume from). */
export const PART_SUFFIX = '.part';

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} ${url}`); this.status = status; }
}

function fmtMB(n) { return (n / 1048576).toFixed(1) + ' MB'; }

/**
 * Is this a job path this downloader may write? `rel` decides where a downloaded byte lands, and it comes from the plan
 * (which reads upstream indexes): a segment of `..`, an absolute path or a Windows drive there would write outside the
 * output root. Nothing in the plan does that today — this is the guard that keeps it impossible, whatever an index says.
 * @param {string} rel
 * @returns {boolean}
 */
export function isSafeRel(rel) {
  const r = String(rel ?? '');
  if (!r || r.includes('\0')) return false;
  if (r.startsWith('/') || r.startsWith('\\') || /^[A-Za-z]:/.test(r)) return false;
  // A `.` segment is not a way out, `..` is; a UNC-ish `//` is caught by the leading-slash test of each segment.
  return !r.split(/[\\/]/).includes('..');
}

/** Absolute path of a job under the download root, or null when the job's `rel` would escape it. */
export function jobPath(root, rel) {
  return isSafeRel(rel) ? join(root, String(rel)) : null;
}

/** Header value as a number, or null when absent/unparsable (`Number(null)` is 0, which is not a length). */
function headerNumber(res, name) {
  const raw = res.headers.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Total size of `content-range: bytes 0-0/<total>`, or null. */
function contentRangeTotal(res) {
  const m = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(String(res.headers.get('content-range') || ''));
  if (!m || m[1] === '*') return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** sha256 of a file on disk, or null when it cannot be read (the caller then falls back to the size decision). */
async function fileSha256(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return null; }
}

/** sha256 of an in-memory payload. */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** How much of a large file is read back to check its format (`pngSize` needs 24 bytes, `isMp3` up to 128). */
const VALIDATE_HEAD_BYTES = 65536;
/** A PNG's IEND chunk is its last 12 bytes. */
const VALIDATE_TAIL_BYTES = 16;

/**
 * The in-memory `validate(kind, buf)` decision for a file too large to read whole: the same check on the head (and, for a
 * PNG, the trailing IEND chunk a whole-buffer validation would look at). Anything the buffer rules decide from the middle
 * of a file does not exist — every rule of `formats.mjs` reads the head or the tail.
 * @param {string} kind
 * @param {string} path
 * @param {number} size
 * @returns {Promise<boolean>}
 */
async function validFile(kind, path, size) {
  if (!(size > 0)) return false;
  let fh;
  try {
    fh = await open(path, 'r');
    const headLen = Math.min(size, VALIDATE_HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    if (kind !== 'png') return validate(kind, head);
    // `isCompletePng` reads the signature/IHDR from the head and the trailing IEND from the last bytes. A file short
    // enough to be one head is checked as it is (the head is the whole file, so the tail is part of it).
    if (size <= headLen) return isCompletePng(head);
    const tailLen = Math.min(size, VALIDATE_TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    return isCompletePng(Buffer.concat([head, tail]));
  } catch { return false; } finally {
    try { await fh?.close(); } catch { /* ignore */ }
  }
}

/**
 * Write a whole buffer at `position`. `FileHandle.write` returns the number of bytes it actually wrote, which may be
 * fewer than the buffer holds, so a single call is not enough: a short write would leave the rest of the chunk in the
 * `.part` as earlier bytes from a previous attempt (a resumed assembly would then look complete while its tail is wrong).
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {Buffer} buf
 * @param {number} position
 */
async function writeAll(fh, buf, position) {
  let at = position;
  const end = position + buf.length;
  while (at < end) {
    const { bytesWritten } = await fh.write(buf, at - position, end - at, at);
    if (!(bytesWritten > 0)) throw new Error(`short write at ${at}`);
    at += bytesWritten;
  }
}

/**
 * One body read, or a rejection when nothing arrives within `timeoutMs` (0 = wait forever). A streamed download must
 * fail on a stalled body the way the in-memory path's request deadline does.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} timeoutMs
 * @returns {Promise<{value?:Uint8Array, done:boolean}>}
 */
function readWithDeadline(reader, timeoutMs) {
  if (!(timeoutMs > 0)) return reader.read();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`response body idle for ${timeoutMs} ms`)), timeoutMs);
    reader.read().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class Downloader {
  /**
   * @param {object} o
   * @param {string} o.root absolute output directory (public/assets)
   * @param {string} o.ledgerPath absolute path of the ledger JSON
   * @param {number} [o.concurrency]
   * @param {number} [o.retries]
   * @param {number} [o.timeoutMs]
   * @param {boolean} [o.force] re-download even when files exist
   * @param {boolean} [o.keepExisting] never re-download or rewrite an existing file (a checkout sharing public/assets)
   * @param {(msg:string)=>void} [o.log]
   * @param {typeof fetch} [o.fetchImpl]
   * @param {number} [o.backoffMs] base retry delay (doubles per attempt)
   * @param {'direct'|'mirror'} [o.source] preferred download source
   * @param {string} [o.proxyPrefix] HTTPS prefix for GitHub downloads
   * @param {string} [o.assetBase] alternative download base (--asset-base / SP_ASSET_BASE); '' = today's URLs
   * @param {MirrorPolicy} [o.mirrorPolicy] invocation-wide policy and mirror circuit breaker
   * @param {import('./source-verifier.mjs').SourceVerifier} [o.verifier] verify every accepted raw byte against the
   *   pinned Git blob of a source snapshot (fetch-assets --source-snapshot). A verified run trusts the snapshot for both
   *   index and file bytes: an existing file is kept only when its bytes match the pinned blob, so `keepExisting`
   *   (--add-only), which keeps files as they are, cannot be combined with it.
   */
  constructor({ root, ledgerPath, concurrency = 16, retries = 3, timeoutMs = 120000, force = false, keepExisting = false, log = console.log, fetchImpl = globalThis.fetch, backoffMs = 400, source = 'direct', proxyPrefix, assetBase = '', mirrorPolicy, verifier }) {
    // `keepExisting` never re-reads an existing file, so a verified run could not reject bytes that differ from the
    // snapshot: the two modes contradict each other rather than merely interacting.
    if (verifier && keepExisting) throw new Error('source verification is incompatible with keepExisting');
    this.verifier = verifier;
    this.root = root;
    this.ledgerPath = ledgerPath;
    this.concurrency = Math.max(1, Math.min(64, Number(concurrency) || 16));
    this.retries = Math.max(1, Number(retries) || 3);
    this.timeoutMs = timeoutMs;
    this.force = force && !keepExisting;
    this.keepExisting = !!keepExisting;
    /** @type {Set<string>} the files (paths under root) this run wrote */
    this.written = new Set();
    /** @type {Set<string>} failed replacements protected from pruning, even without blob provenance */
    this.preserved = new Set();
    /** @type {Set<string>} the files (paths under root) this run's bytes were accepted for */
    this.accepted = new Set();
    this.log = log;
    this.fetch = guardDefaultFetch(fetchImpl);
    // The policy owns the normalized base; a bare assetBase is only used when no shared policy was passed.
    this.network = mirrorPolicy ?? new MirrorPolicy({ source, proxyPrefix, assetBase, log });
    this.backoffMs = Math.max(0, Number(backoffMs) || 0);
    this.ledger = { files: {} };
    this.totals = { ok: 0, skip: 0, miss: 0, error: 0, bytesDownloaded: 0, sizeChanged: 0 };
    this.dirty = 0;
    this.saving = false;
    /** @type {{url:string, bytes:number}|null} ledger entry of the stat-ed file (its recorded hash, when it has one) */
    this.lastLedgerHint = null;
  }

  /** Load the ledger (missing or corrupt ledger → empty). */
  async loadLedger() {
    try {
      const j = JSON.parse(await readFile(this.ledgerPath, 'utf8'));
      if (j && typeof j === 'object' && j.files && typeof j.files === 'object') this.ledger = j;
    } catch { /* first run */ }
  }

  /** Persist the ledger. */
  async saveLedger() {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    const tmp = this.ledgerPath + '.tmp';
    await writeFile(tmp, JSON.stringify(this.ledger));
    await rename(tmp, this.ledgerPath);
    this.dirty = 0;
  }

  /**
   * Decide whether an existing file can be kept.
   *
   * `sha256` is verified only when the ledger entry carries one (entries written by an earlier version hold `{url, bytes}`
   * only, and those keep the exact pre-existing size decision — otherwise this change would re-download every file that
   * is already on disk). `--force` keeps its meaning: bypass the decision and re-download.
   * @param {Job} job
   * @returns {Promise<number>} size of the kept file, or -1 to (re)download
   */
  async existingSize(job) {
    this.lastLedgerHint = null;
    if (this.force) return -1;
    const abs = join(this.root, job.rel);
    let st;
    try { st = await stat(abs); } catch { return -1; }
    if (!st.isFile() || st.size <= 0) return -1;
    if (this.keepExisting) return st.size;
    const led = this.ledger.files[job.rel];
    if (job.mutable) {
      // Post-processed files (atlases) change size; validate content instead.
      try { return validate(job.kind, await readFile(abs)) ? st.size : -1; } catch { return -1; }
    }
    if (led && led.bytes === st.size) {
      if (led.sha256) {
        const got = await fileSha256(abs);
        // A null (unreadable) hash is not evidence of corruption: fall back to the size decision.
        if (got && got !== led.sha256) {
          this.log(`[dl] ${job.rel}: content differs from the ledger sha256 (${got.slice(0, 12)}≠${led.sha256.slice(0, 12)}— re-downloaded`);
          return -1;
        }
      }
      this.lastLedgerHint = led;
      return st.size;
    }
    if (job.bytes && job.bytes === st.size) return st.size;
    if (led && led.bytes !== st.size) return -1; // changed since we wrote it
    // Unknown provenance (e.g. ledger deleted): keep it only if it validates.
    try { return validate(job.kind, await readFile(abs)) ? st.size : -1; } catch { return -1; }
  }

  /**
   * One HTTP request for a download job, its body parsed and (for a whole-file response) validated.
   * `resume` selects a ranged request; the caller owns assembly and validation of the combined payload.
   * @param {string} url
   * @param {string} kind
   * @param {{start:number, total:number|null}|null} resume
   * @param {{blob:string, commit:string, url:string}|null} [verifiedSource] pinned Git blob this body must match
   * @returns {Promise<{buf:Buffer, status:number, total:number|null}|{notFound:true}|{skipped:true}|{error:string}>}
   */
  async fetchParsed(url, kind, resume, verifiedSource = null) {
    if (this.network.skip(url)) return { skipped: true };
    let lastErr = 'unknown error';
    const attempts = this.network.isProxy(url) ? 1 : this.retries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const headers = { 'user-agent': 'stronghold-protocol-fetch-assets/1.0' };
        if (resume) headers.range = `bytes=${resume.start}-`;
        const res = await this.network.request(url, this.fetch, { headers, redirect: 'follow' }, this.timeoutMs);
        if (res.status === 404 || res.status === 410) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          this.network.succeeded(url); // a missing asset is not a proxy outage
          return { notFound: true };
        }
        if (!res.ok) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          throw new HttpError(res.status, url);
        }
        if (resume) {
          if (res.status !== 206) {
            // Range was ignored (or is unsupported): the body is the whole file, not the tail. Safe fallback: keep it as
            // one whole-file response and let the caller write it as usual.
            try { await res.body?.cancel(); } catch { /* ignore */ }
            return { rangeIgnored: true };
          }
          const total = contentRangeTotal(res);
          if (resume.total !== null && total !== null && total !== resume.total) {
            try { await res.body?.cancel(); } catch { /* ignore */ }
            throw new Error(`changed upstream during the download (${total} ≠ ${resume.total} B) ${url}`);
          }
        }
        const buf = await this.network.readBody(url, res);
        const len = headerNumber(res, 'content-length');
        const enc = res.headers.get('content-encoding');
        if (resume) {
          // `content-length` of a 206 is the size of this part, and the part must be exactly the bytes that are missing.
          if (!enc && len !== null && len > 0 && len !== buf.length) throw new Error(`truncated body ${buf.length}/${len} ${url}`);
          const total = contentRangeTotal(res);
          const expect = total !== null ? total - resume.start : (resume.total !== null ? resume.total - resume.start : null);
          if (expect !== null && buf.length !== expect) throw new Error(`truncated range ${buf.length}/${expect} ${url}`);
          this.network.succeeded(url);
          return { buf, status: res.status, total };
        }
        if (!enc && len !== null && len > 0 && len !== buf.length) {
          throw new Error(`truncated body ${buf.length}/${len} ${url}`);
        }
        if (!validate(kind, buf)) throw new Error(`invalid ${kind} payload (${buf.length} B) ${url}`);
        // Format validity is not provenance: with a source snapshot the bytes must also be the pinned Git blob. The
        // check sits inside the attempt loop (like every other rejection), so a mirror that serves stale bytes is
        // retried and then falls through to the next candidate instead of being written.
        if (verifiedSource) this.verifier.verify(buf, verifiedSource);
        this.network.succeeded(url);
        return { buf, status: res.status, total: null };
      } catch (e) {
        lastErr = e?.message || String(e);
        this.network.failed(url);
        if (attempt < attempts && this.backoffMs) await sleep(this.backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.backoffMs));
      }
    }
    return { error: lastErr };
  }

  /**
   * Fetch one URL with retries.
   * @param {string} url
   * @param {string} kind
   * @param {{blob:string, commit:string, url:string}|null} [verifiedSource] pinned Git blob this body must match
   * @returns {Promise<{buf:Buffer}|{notFound:true}|{skipped:true}|{error:string}>}
   */
  async fetchWithRetries(url, kind, verifiedSource = null) {
    const r = await this.fetchParsed(url, kind, null, verifiedSource);
    if (r.buf) return { buf: r.buf };
    if (r.notFound) return { notFound: true };
    if (r.skipped) return { skipped: true };
    return { error: r.rangeIgnored ? 'Range not honoured on a whole-file request' : r.error };
  }

  /**
   * Does this source honour `Range`? A one-byte probe at the END of the file (`bytes=-1`, which a whole-file answer
   * cannot be mistaken for — a `bytes=0-0` probe is indistinguishable from a plain request) is the only reliable test:
   * a server may ignore the header and answer 200, and some advertise nothing useful in `accept-ranges`. The probe also
   * yields the total size (`content-range: bytes N-N/total`).
   * @param {string} url
   * @returns {Promise<number|null>} total size, or null when Range is not usable (the caller re-downloads whole)
   */
  async probeRange(url) {
    try {
      const res = await this.network.request(url, this.fetch, {
        headers: { 'user-agent': 'stronghold-protocol-fetch-assets/1.0', range: 'bytes=-1' },
        redirect: 'follow',
      }, this.timeoutMs);
      const ok = res.status === 206;
      const total = ok ? contentRangeTotal(res) : null;
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return total;
    } catch { return null; }
  }

  /**
   * Stream a response body into an open file handle at `position`. Returns the byte count; a body that ends without a
   * byte is an error, so a stalled or empty response cannot look like a finished download. Every read has an inactivity
   * deadline (`timeoutMs`), which is the streamed equivalent of the request deadline the in-memory path gets from
   * `fetch` — a server that sends headers and then stops must fail this run, not hang it. A body that reaches its own
   * `content-length` stops there: a source that promised N bytes and sends fewer without closing would otherwise hold
   * the run open until the idle deadline.
   * @param {Response} res
   * @param {import('node:fs/promises').FileHandle} fh
   * @param {number} position
   * @param {number} [timeoutMs] idle deadline per read
   */
  async writeBody(res, fh, position, timeoutMs = this.timeoutMs) {
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeAll(fh, buf, position);
      return buf.length;
    }
    const declared = headerNumber(res, 'content-length');
    const reader = res.body.getReader();
    let at = position;
    try {
      while (true) {
        // The declared length is reached: stop reading (`reader.cancel()` would make `releaseLock()` below throw, and the
        // stream is released anyway). A source that promised N bytes and sent fewer without closing would otherwise hold
        // the run open until the idle deadline.
        if (declared !== null && at - position >= declared) break;
        const { value, done } = await readWithDeadline(reader, timeoutMs);
        if (done) break;
        if (!value?.length) continue;
        const chunk = Buffer.from(value);
        await writeAll(fh, chunk, at);
        at += chunk.length;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return at - position;
  }

  /**
   * Stream a body to the stable `.part` path, then rename it into place. The body is written at `startAt`: 0 for a whole
   * download (the `.part` is replaced), or the size of the part already there for a resumed tail, which appends to it
   * instead of overwriting the bytes that are the point of resuming.
   * @param {Response} res
   * @param {string} abs final path
   * @param {string} part stable temp path
   * @param {{expectSize?:number|null, expectHash?:string|null, expectTotal?:number|null, startAt?:number, kind?:string,
   *   verifiedSource?:{blob:string, commit:string, url:string}|null}} [o] what the
   *   finished payload must be: `expectSize` the bytes written, `expectTotal` the size of the assembled file (a resumed
   *   body is only the tail), `expectHash` the content hash, `startAt` the offset that tail begins at, `kind` the asset
   *   kind whose format the file must still pass, `verifiedSource` the pinned Git blob the assembled file must match.
   * @returns {Promise<{ok:true, bytes:number, sha256:string}|{ok:false, error:string}>}
   */
  async writeStreamed(res, abs, part, { expectSize = null, expectHash = null, expectTotal = null, startAt = 0, kind = null, verifiedSource = null } = {}) {
    await mkdir(dirname(abs), { recursive: true });
    if (startAt > 0) {
      // Resume: keep what the earlier run already wrote.
      const have = await stat(part).then((st) => st.size).catch(() => 0);
      if (have < startAt) return { ok: false, error: `resume point ${startAt} is beyond the ${have} B on disk` };
    } else {
      await unlink(part).catch(() => {});
    }
    const fh = await open(part, startAt > 0 ? 'r+' : 'w');
    let bytes;
    try {
      bytes = await this.writeBody(res, fh, startAt);
      await fh.close();
    } catch (e) {
      try { await fh.close(); } catch { /* ignore */ }
      return { ok: false, error: `body read failed: ${e.message}` };
    }
    if (bytes === 0) return { ok: false, error: 'empty response body' };
    if (expectSize !== null && bytes !== expectSize) return { ok: false, error: `truncated body ${bytes}/${expectSize}` };
    // The response's own content-length is the other half of the contract: a body cut short by a source that declares
    // more is a truncated download, whatever the research size field says.
    const declared = headerNumber(res, 'content-length');
    if (declared !== null && declared !== bytes) return { ok: false, error: `truncated body ${bytes}/${declared}` };
    // The assembled file must be the size the source declared for it, or a short tail would be renamed into place as if
    // the download had finished.
    if (expectTotal !== null && startAt + bytes !== expectTotal) return { ok: false, error: `truncated file ${startAt + bytes}/${expectTotal}` };
    // The same payload check the in-memory path runs, on the parts of the file that decide its format: a big body is not
    // written just because it is big (an HTML error page or a truncated PNG is rejected here as well).
    if (kind && !await validFile(kind, part, startAt + bytes)) return { ok: false, error: `invalid ${kind} payload (${startAt + bytes} B)` };
    // A streamed body gets the same provenance check as the in-memory one: a large file is not accepted just because its
    // size and format fit. This is the whole assembled file, so a resumed tail is verified together with the bytes it
    // was appended to (`startAt + bytes` is that whole length). The read is the same one `fileSha256` below already
    // performs, so the check adds no new memory profile. It comes before the hash so a rejected body is never renamed.
    if (verifiedSource) {
      try { this.verifier.verify(await readFile(part), verifiedSource); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    const sha256 = await fileSha256(part);
    if (sha256 === null) return { ok: false, error: 'cannot hash the downloaded file' };
    if (expectHash && expectHash !== sha256) return { ok: false, error: `content differs from the ledger sha256 (${sha256.slice(0, 12)}≠${expectHash.slice(0, 12)}—` };
    await rename(part, abs);
    // `bytes` is the size of the finished file, not just the tail this call wrote: a resumed download reports the file
    // it assembled, exactly like a whole one.
    return { ok: true, bytes: startAt + bytes, sha256 };
  }

  /**
   * Download one job (all candidate URLs and mirrors), resuming from a `<file>.part` an earlier run left behind.
   *
   * Two transports per candidate. A job of at least `MIN_RESUMABLE_BYTES` (or one of unknown size) streams: the body
   * goes straight to the stable `.part`, so an interruption leaves the bytes it got and the next run sends
   * `Range: bytes=<part size>-`. Everything else stays on the proven in-memory path of one whole-file fetch.
   * @param {Job} job
   * @returns {Promise<JobResult>}
   */
  async runJob(job) {
    // The one place a downloaded byte is placed: refuse a path that would leave the output root before any file is
    // touched (an index-supplied `rel` with `..`, an absolute path or a drive letter).
    if (!isSafeRel(job.rel)) {
      return { status: 'error', bytes: 0, error: `unsafe asset path outside ${this.root}: ${job.rel}` };
    }
    // A verified run decides from the pinned snapshot, never from the ledger of an earlier run: `verifiedCandidate`
    // below proves the bytes on disk against the blob this source revision pins, and any other bytes are re-fetched.
    // The {url, bytes} → sha256 ledger healing just below therefore belongs to the unverified path only.
    const kept = this.verifier ? -1 : await this.existingSize(job);
    if (kept >= 0) {
      const led = this.lastLedgerHint;
      // Extending an old {url, bytes} entry with the hash heals the library one file per run without ever forcing a
      // re-download (the file was just proven good). A fresh ledger entry already carries it.
      if (led && !led.sha256) {
        led.sha256 = await fileSha256(join(this.root, job.rel));
        if (led.sha256) this.dirty++;
      }
      return { status: 'skip', bytes: kept };
    }
    const abs = join(this.root, job.rel);
    const part = abs + PART_SUFFIX;
    // A leftover `.part` is the resume point; a job below MIN_RESUMABLE_BYTES is cheaper to fetch whole than to resume.
    let start;
    try { start = (await stat(part)).size; } catch { start = 0; }
    if (start <= 0) start = 0;
    // A memory bound, never a correctness one: a payload that may be large is streamed to disk, whatever its size field
    // claims (the field is only the research expectation and may be absent). A prefix-proxy URL keeps the in-memory path:
    // its body read owns the mirror's idle deadline and its abort signal, which a direct fetch does not have.
    const mayStream = (job.bytes ?? Infinity) >= MIN_RESUMABLE_BYTES;
    let lastError = null;
    for (const url of job.urls) {
      // The snapshot turns the logical URL into the blob this revision pins, and the transport URL into the pinned one:
      // a branch that moved since the snapshot can then never serve other bytes. A URL the snapshot does not list is
      // not downloadable in a verified run, so the next alternative is tried instead.
      let verifiedSource = null;
      if (this.verifier) {
        const candidate = await this.verifiedCandidate(job, url);
        if (candidate.result) return candidate.result;
        verifiedSource = candidate.source;
        if (!verifiedSource) continue;
      }
      const sources = this.network.urls(verifiedSource?.pinnedUrl ?? url);
      for (const src of sources) {
        if (this.network.skip(src)) continue;
        if (mayStream && !this.network.isProxy(src)) {
          // Ranged when there is something to resume from and the source proves it honours Range: the one-byte probe
          // (a job with no `.part` has nothing to resume, so it is not asked) must answer 206.
          const ledHash = this.ledger.files[job.rel]?.sha256 || null;
          let resumeFrom = 0;
          let totalSize = null;
          if (start > 0) {
            totalSize = await this.probeRange(src);
            if (totalSize !== null && totalSize > start) resumeFrom = start;
          }
          const streamed = await this.fetchStream(src, job, resumeFrom, totalSize);
          // A definitive 404/410 moves on to the next candidate (the next alternative is a fallback file, not a retry of
          // a missing one); a transient failure stops this job, exactly as the in-memory path does.
          if (streamed.notFound) continue;
          if (streamed.error) { lastError = streamed.error; continue; }
          const done = await this.writeStreamed(streamed.res, abs, part, {
            // A resumed body is only the tail: its length is checked by `fetchParsed`'s range rules instead. A whole
            // body must be exactly the size the source or the research expects.
            expectSize: resumeFrom > 0 ? null : (totalSize ?? job.bytes ?? null),
            expectTotal: totalSize,
            startAt: resumeFrom,
            expectHash: resumeFrom > 0 ? ledHash : null,
            kind: job.kind,
            verifiedSource,
          });
          try { await streamed.res.body?.cancel(); } catch { /* ignore */ }
          if (done.ok) return this.done(job, src, done.bytes, done.sha256, verifiedSource);
          // A payload that fails its length or hash check is not a file: the `.part` stays for the next attempt when
          // resuming (that is how a half-written body turns into a resume instead of a corrupt asset), but a body that
          // contradicts what the source promised is thrown away rather than resumed against forever. A failed source
          // verification is that same class — the bytes are provably not the pinned ones, so resuming them would only
          // extend the wrong file.
          if (resumeFrom > 0) {
            if (/sha256|blob mismatch/.test(done.error)) { try { await unlink(part); } catch { /* ignore */ } }
          } else if (/truncated|sha256|invalid|empty response|blob mismatch/.test(done.error)) {
            try { await unlink(part); } catch { /* ignore */ }
          }
          lastError = done.error;
          continue;
        }
        const whole = await this.fetchParsed(src, job.kind, null, verifiedSource);
        if (whole.notFound || whole.skipped) continue;
        if (whole.error) { lastError = whole.error; continue; }
        // The proven in-memory path, plus the content hash the ledger records so the next run can verify the file.
        await mkdir(dirname(abs), { recursive: true });
        try {
          await writeFile(part, whole.buf);
          await rename(part, abs);
        } catch (e) {
          try { await unlink(part); } catch { /* ignore */ }
          return { status: 'error', bytes: 0, error: `write failed: ${e.message}` };
        }
        return this.done(job, src, whole.buf.length, sha256(whole.buf), verifiedSource);
      }
    }
    if (lastError) this.network.directFailureHint();
    return lastError ? { status: 'error', bytes: 0, error: lastError } : { status: 'miss', bytes: 0, error: 'not found (404) on all sources' };
  }

  /**
   * Resolve today's candidate before considering old bytes or ledger provenance.
   *
   * Two outcomes. A file already on disk that *is* the pinned blob is kept, and its ledger entry is re-anchored on the
   * snapshot (logical URL, pinned blob/commit and the local sha256 in one write), which is what makes a re-run after
   * moving between revisions cheap without trusting the previous ledger. Any other bytes — missing, rejected, or simply
   * a different revision — return the resolved source so the caller fetches *this* candidate instead of an old URL.
   * An `--force` run skips the inspection and refetches, exactly as the unverified path does.
   *
   * A resolution that fails is an error result, not a miss: an unreachable snapshot API means "unknown", and treating it
   * as "absent upstream" would silently drop assets.
   * @param {Job} job
   * @param {string} url logical branch URL of the candidate
   * @returns {Promise<{result?: JobResult, source?: {blob:string, commit:string, url:string, pinnedUrl:string}}>}
   */
  async verifiedCandidate(job, url) {
    let source;
    try { source = await this.verifier.resolve(url); } catch (e) {
      return { result: { status: 'error', bytes: 0, error: e.message } };
    }
    if (!source) return {};
    if (!this.force && !job.mutable) {
      try {
        const buf = await readFile(join(this.root, job.rel));
        this.verifier.verify(buf, source);
        if (validate(job.kind, buf)) {
          this.ledger.files[job.rel] = { url, bytes: buf.length, sha256: sha256(buf), blob: source.blob, commit: source.commit };
          this.dirty++;
          return { result: { status: 'skip', bytes: buf.length, url } };
        }
      } catch { /* Missing or rejected bytes: fetch this candidate, not an old ledger URL. */ }
    }
    return { source };
  }

  /**
   * Claim an existing file for pruning protection after a failed fetch, and report whether it may still be *published*
   * (used by the manifest). Protection is unconditional: source absence does not invalidate the bytes on disk, and
   * deleting them because the network failed would replace "retry next run" with data loss. Publication is stricter —
   * only a file whose bytes prove to be the ledger's pinned blob (and that still passes its format check) is accepted,
   * so a stale or corrupt leftover is protected from pruning but never served to the client.
   * @param {Job} job
   * @returns {Promise<boolean>} true when the file is verified and usable
   */
  async retainExisting(job) {
    this.preserved.add(job.rel);
    const led = this.ledger.files[job.rel];
    if (!led?.blob) return false;
    try {
      const buf = await readFile(join(this.root, job.rel));
      this.verifier.verify(buf, { blob: led.blob, url: led.url || job.rel });
      return validate(job.kind, buf);
    } catch { /* No verified fallback is available. */ }
    return false;
  }

  /**
   * A streamed response for one job, retried like `fetchWithRetries`. A ranged request that is answered with something
   * other than 206 is retried once as a whole-file request (the source does not honour Range).
   * @param {string} src
   * @param {Job} job
   * @param {number} resumeFrom 0 = whole file
   * @param {number|null} totalSize total size the probe reported (null = unknown)
   * @returns {Promise<{res:Response, ranged:boolean}|{notFound:true}|{error:string}>}
   */
  async fetchStream(src, job, resumeFrom, totalSize) {
    if (this.network.skip(src)) return { error: 'mirror disabled for this run' };
    let lastErr = 'unknown error';
    const attempts = this.network.isProxy(src) ? 1 : this.retries;
    let range = resumeFrom > 0 ? { start: resumeFrom, total: totalSize } : null;
    let triedWhole = resumeFrom <= 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const headers = { 'user-agent': 'stronghold-protocol-fetch-assets/1.0' };
        if (range) headers.range = `bytes=${range.start}-`;
        // A streamed body is read by this class, not by `fetch`: give it the same inactivity deadline the in-memory path
        // gets from `AbortSignal.timeout` (the proxy branch of `network.request` keeps its own short deadline).
        const res = await this.network.request(src, this.fetch, {
          headers,
          redirect: 'follow',
          signal: this.network.isProxy(src) ? undefined : AbortSignal.timeout(this.timeoutMs),
        }, this.timeoutMs);
        if (res.status === 404 || res.status === 410) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          this.network.succeeded(src);
          return { notFound: true };
        }
        if (!res.ok) {
          try { await res.body?.cancel(); } catch { /* ignore */ }
          throw new HttpError(res.status, src);
        }
        if (range && res.status !== 206) {
          // The source ignored Range (200 = whole body). It is still a valid download: use it as a whole-file response.
          this.network.succeeded(src);
          return { res, ranged: false };
        }
        if (range) {
          // The part this response promises must be exactly the bytes that are missing, or the assembled file would be
          // short: `content-length` of a 206 is the part's own size, and `content-range` names the total.
          const len = headerNumber(res, 'content-length');
          const total = contentRangeTotal(res);
          const expect = total !== null ? total - range.start : (range.total !== null ? range.total - range.start : null);
          if (expect !== null && len !== null && len !== expect) {
            try { await res.body?.cancel(); } catch { /* ignore */ }
            throw new Error(`short range ${len}/${expect} ${src}`);
          }
        }
        this.network.succeeded(src);
        return { res, ranged: !!range };
      } catch (e) {
        lastErr = e?.message || String(e);
        this.network.failed(src);
        if (range && !triedWhole) {
          // The ranged attempt itself failed (a proxy or a CDN edge that rejects Range with 4xx/5xx): fall back to a
          // whole-file download rather than give up on a source that works without Range.
          range = null;
          triedWhole = true;
          continue;
        }
        if (attempt < attempts && this.backoffMs) await sleep(this.backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.backoffMs));
      }
    }
    return { error: lastErr };
  }

  /**
   * Record a finished file in the ledger and the run totals.
   *
   * A verified run records the pinned `blob`/`commit` beside the local `sha256`, and records the *logical* branch URL
   * rather than the pinned transport URL that served it: later steps derive their requests from the ledger URL (a Spine
   * atlas' `page.png`, an optional font original) and must keep deriving from the branch, never from one commit. The
   * `sha256` stays too, so a later unverified run keeps the hash-hardened `existingSize` fast path.
   */
  done(job, src, bytes, sha256 = null, verifiedSource = null) {
    const prev = this.ledger.files[job.rel];
    const hash = sha256 ?? prev?.sha256 ?? null;
    const url = verifiedSource ? verifiedSource.url : src;
    const entry = hash ? { url, bytes, sha256: hash } : { url, bytes };
    if (verifiedSource) { entry.blob = verifiedSource.blob; entry.commit = verifiedSource.commit; }
    this.ledger.files[job.rel] = entry;
    this.written.add(job.rel);
    this.dirty++;
    const sizeChanged = !!(job.bytes && job.bytes !== bytes && !job.mutable);
    return { status: 'ok', bytes, url: src, sizeChanged };
  }

  /**
   * Run a list of jobs with bounded concurrency. Duplicate `rel`s are run once.
   * @param {Job[]} jobs
   * @param {string} label progress label
   * @returns {Promise<Map<string, JobResult>>}
   */
  async run(jobs, label = 'download') {
    const unique = [];
    const seen = new Set();
    for (const j of jobs) { if (!seen.has(j.rel)) { seen.add(j.rel); unique.push(j); } }
    const results = new Map();
    const t0 = Date.now();
    let done = 0; let bytes = 0; let lastLog = 0;
    const counts = { ok: 0, skip: 0, miss: 0, error: 0 };
    const progress = (force) => {
      const now = Date.now();
      if (!force && now - lastLog < 2000) return;
      lastLog = now;
      const secs = Math.max(0.001, (now - t0) / 1000);
      this.log(`[${label}] ${done}/${unique.length} ok=${counts.ok} skip=${counts.skip} miss=${counts.miss} err=${counts.error} ` +
        `${fmtMB(bytes)} ${(bytes / 1048576 / secs).toFixed(2)} MB/s`);
    };
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const job = unique[next++];
        let r;
        try { r = await this.runJob(job); } catch (e) { r = { status: 'error', bytes: 0, error: e?.message || String(e) }; }
        results.set(job.rel, r);
        // Source absence does not invalidate local bytes. Keep them on disk even
        // without provenance, but publish only a revalidated fallback.
        const succeeded = r.status === 'ok' || r.status === 'skip';
        if (succeeded) this.preserved.delete(job.rel);
        if (succeeded || (this.verifier && await this.retainExisting(job))) this.accepted.add(job.rel);
        else this.accepted.delete(job.rel);
        counts[r.status]++;
        this.totals[r.status]++;
        if (r.status === 'ok') { bytes += r.bytes; this.totals.bytesDownloaded += r.bytes; }
        if (r.sizeChanged) this.totals.sizeChanged++;
        done++;
        if (this.dirty >= 200 && !this.saving) {
          this.saving = true;
          try { await this.saveLedger(); } catch { /* retried at the end */ } finally { this.saving = false; }
        }
        progress(false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, unique.length) }, worker));
    if (unique.length) progress(true);
    await this.saveLedger();
    return results;
  }
}

