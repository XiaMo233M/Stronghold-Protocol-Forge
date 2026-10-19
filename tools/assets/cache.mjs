// Cached upstream JSON indexes needed by the asset pipeline:
//   .cache/gamedata/excel/audio_data.json     (Kengxxiao/ArknightsGameData, zh_CN)
//   .cache/gamedata/excel/charword_table.json (same repo: the operators' voice slots and voice assets)
//   .cache/ark-models/models_data.json        (isHarryh/Ark-Models enemy Spine index)
// Downloaded once when missing (or with --refresh-index), then reused — forever, unless --index-ttl names an age.
// See docs/ASSETS.md ("Index cache freshness").

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { RAW, withAssetBase } from './sources.mjs';
import { MirrorPolicy } from './network.mjs';
import { guardDefaultFetch } from './env-proxy.mjs';

/**
 * Index cache files older than `ttlHours` are re-downloaded. `0` (the default) means never, so a run without
 * `--index-ttl` / `SP_INDEX_TTL` behaves exactly as before: a parsable cache is used whatever its timestamp.
 * @param {number} ttlHours
 * @returns {boolean}
 */
export function ttlEnabled(ttlHours) {
  return Number.isFinite(ttlHours) && ttlHours > 0;
}

/**
 * Is the cached index stale? A missing/unreadable file is always stale (it gets downloaded anyway); without a TTL
 * nothing is ever stale.
 * @param {string} cacheFile
 * @param {number} ttlHours
 * @returns {Promise<boolean>}
 */
export async function cacheExpired(cacheFile, ttlHours) {
  if (!ttlEnabled(ttlHours)) return false;
  try {
    const st = await stat(cacheFile);
    return Date.now() - st.mtimeMs > ttlHours * 3600000;
  } catch { return true; }
}

/**
 * Read a cached JSON file, downloading it first when missing, unparsable, or older than `ttlHours`.
 * @param {object} o
 * @param {string} o.cacheFile absolute cache path
 * @param {string} o.url raw GitHub URL (already rewritten onto --index-base by the caller)
 * @param {boolean} [o.refresh] force re-download
 * @param {number} [o.ttlHours] re-download when the cache is older than this many hours (0 = never)
 * @param {boolean} [o.offline] never download (throw when the cache is missing)
 * @param {(m:string)=>void} [o.log]
 * @param {'direct'|'mirror'} [o.source]
 * @param {string} [o.proxyPrefix]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {MirrorPolicy} [o.mirrorPolicy] shared invocation-wide mirror circuit breaker
 * @param {number} [o.timeoutMs]
 * @param {number} [o.backoffMs]
 * @param {import('./source-verifier.mjs').SourceVerifier} [o.verifier] verify raw bytes against pinned Git trees
 * @returns {Promise<any>} parsed JSON
 */
export async function cachedJson({ cacheFile, url, refresh = false, offline = false, ttlHours = 0, log = console.log, source = 'direct', proxyPrefix, fetchImpl = globalThis.fetch, mirrorPolicy, timeoutMs = 180000, backoffMs = 500, verifier, maxBytes = Infinity, validate }) {
  if (verifier && offline) throw new Error('source verification is incompatible with --offline');
  let verifiedSource;
  if (verifier) {
    verifiedSource = await verifier.resolve(url);
    if (!verifiedSource) throw new Error(`source index missing ${url}`);
  }
  // Same rule as the file downloader: a configured proxy must not be skipped.
  const fetchFn = guardDefaultFetch(fetchImpl);
  // --index-ttl alone is what makes an old cache stale: without it `refresh` is the only trigger, as before.
  const expired = !refresh && !offline && await cacheExpired(cacheFile, ttlHours);
  if (expired) log(`[cache] ${cacheFile} is older than ${ttlHours} h (--index-ttl): re-downloading`);
  if (!refresh && !expired || offline) {
    try {
      const buf = await readFile(cacheFile);
      if (buf.length > maxBytes) throw new Error(`JSON exceeds ${maxBytes} bytes`);
      if (verifier) verifier.verify(buf, verifiedSource);
      const json = JSON.parse(buf.toString('utf8'));
      // 上游 0.3.1：缓存里的那一份也要过形状校验 —— 坏文件不能被当成「已经下过」继续用。
      validate?.(json);
      return json;
    } catch (e) {
      if (offline) throw new Error(`--offline: cached index ${cacheFile} is missing or corrupt (${e.message}); run once online`);
    }
  }
  const network = mirrorPolicy ?? new MirrorPolicy({ source, proxyPrefix, log });
  let lastErr = null;
  for (const src of network.urls(verifiedSource?.pinnedUrl ?? url)) {
    if (network.skip(src)) continue;
    const attempts = network.isProxy(src) ? 1 : 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let text, json;
      try {
        log(`[cache] downloading ${src}`);
        const res = await network.request(src, fetchFn, {}, timeoutMs);
        if (!res.ok) {
          await res.body?.cancel();
          if (res.status === 404 || res.status === 410) {
            network.succeeded(src); // missing index, not a proxy outage
            lastErr = new Error(`HTTP ${res.status}`);
            break;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const buf = await network.readBody(src, res, maxBytes);
        if (verifier) verifier.verify(buf, verifiedSource);
        text = buf.toString('utf8');
        json = JSON.parse(text);
        validate?.(json);
      } catch (e) {
        lastErr = e;
        network.failed(src);
        if (attempt < attempts && backoffMs) await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }
      network.succeeded(src);
      // A local disk failure is not evidence that the mirror is unhealthy.
      await mkdir(dirname(cacheFile), { recursive: true });
      const temp = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, text, { flag: 'wx' });
        await rename(temp, cacheFile);
      } finally { await rm(temp, { force: true }); }
      return json;
    }
  }
  if (lastErr) network.directFailureHint();
  throw new Error(`cannot fetch ${url}: ${lastErr?.message}`);
}

/**
 * The three index URLs, rewritten onto `--index-base` / `SP_INDEX_BASE` when given (`base` mirrors the
 * raw.githubusercontent.com layout: the repository path is kept, only the host/base is replaced).
 * @param {string} indexBase normalized override base ('' = the default RAW literals)
 * @returns {{ audioData: string, charword: string, modelsData: string }}
 */
export function indexUrls(indexBase = '') {
  return {
    audioData: withAssetBase(RAW.gamedata + 'excel/audio_data.json', indexBase),
    charword: withAssetBase(RAW.gamedata + 'excel/charword_table.json', indexBase),
    modelsData: withAssetBase(RAW.arkModels + 'models_data.json', indexBase),
  };
}

/**
 * Load audio_data.json (official), charword_table.json (official voice slots) and Ark-Models models_data.json.
 * @param {string} root project root
 * @param {{refresh?:boolean, offline?:boolean, ttlHours?:number, indexBase?:string, cacheDir?:string, log?:(m:string)=>void, source?:'direct'|'mirror', proxyPrefix?:string, fetchImpl?:typeof fetch, mirrorPolicy?:MirrorPolicy}} [opts]
 * @returns {Promise<{ audioData: any, modelsData: any, charword: any }>}
 */
export async function loadIndexes(root, opts = {}) {
  const mirrorPolicy = opts.mirrorPolicy ?? new MirrorPolicy(opts);
  // --index-base == the default literal → the exact URLs of today (withAssetBase returns the input unchanged).
  const urls = indexUrls(opts.indexBase || '');
  const cacheDir = opts.cacheDir || join(root, '.cache');
  const audioData = await cachedJson({
    ...opts,
    mirrorPolicy,
    cacheFile: join(cacheDir, 'gamedata', 'excel', 'audio_data.json'),
    url: urls.audioData,
    refresh: opts.refresh,
    offline: opts.offline,
    log: opts.log,
  });
  // 11 MB, and raw.githubusercontent stalls on it often: the jsDelivr mirror cachedJson() falls back to is the
  // reliable path (the operator battle voice needs it, plan.mjs indexVoice).
  const charword = await cachedJson({
    ...opts,
    mirrorPolicy,
    cacheFile: join(cacheDir, 'gamedata', 'excel', 'charword_table.json'),
    url: urls.charword,
    refresh: opts.refresh,
    offline: opts.offline,
    log: opts.log,
  });
  const modelsData = await cachedJson({
    ...opts,
    mirrorPolicy,
    cacheFile: join(cacheDir, 'ark-models', 'models_data.json'),
    url: urls.modelsData,
    refresh: opts.refresh,
    offline: opts.offline,
    log: opts.log,
  });
  return { audioData, modelsData, charword };
}
