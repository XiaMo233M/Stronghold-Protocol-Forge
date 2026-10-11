// server/voiceCdn.js — **作者自备 CDN 的语音素材**：装载期取回来、核对作者声明的 sha256、落本地缓存。
// (i18n-ignore-file: 这里的文案是给作者/加载器的错误说明，不是客户端界面文案)
//
// 业主口径（2026-10-11）：**分发官方语音不行，但要留出「下载作者语音素材」的 CDN 链接支持**。所以这一层做的
// 永远只有一件事：按**作者在 pack.json 里写下的地址**把字节取回来。三条红线写在 `shared/workshop.js`
// `VOICE_CDN_FIELDS` 的注释里，这里逐条对应到实现：
//
//   1. **绝不内置任何官方语音地址** —— 这个文件里没有一个主机名常量，也没有任何「已知素材站」白名单。主机名只
//      来自 `pack.json`，引擎对它是**不认识**的：它只是一个 `https://` URL。要写一份白名单就得把官方域名写进
//      引擎，那正是红线本身。
//   2. **绝不新增下载路由** —— 取回来的字节落在 `<状态目录>/voice-cdn/<sha256>`，然后由**既有**的
//      `/workshop-assets/<包>/...` 那一条路由送出去（`server/http/static.js` 的 assets 分支查这张覆盖表）。
//      客户端看见的 URL 与「素材本来就在包里」时**逐字相同**，所以播放侧一个字节都不用改。
//   3. **不放宽 `VOICE_LANG_*` / 不加任何便于拿官方语音的通道** —— 这一层只认已经通过形状层的声明；语种闭枚举与
//      槽位闭枚举住在 `shared/constants.js`，这里一行都没碰。
//
// 四条性质：
//   * **内容哈希是唯一判据**：取回来的字节要先过 sha256，对不上就**不落盘、不进覆盖表**（一个被换掉的音频绝不上线）；
//   * **缓存键就是 sha256**：同一份字节被两个包声明也只会存一份，且第二次不需要联网；
//   * **失败要响亮**：每一条失败都回一条 `{ pack, file, url, code, reason }`，调用方（`server/index.js`）**逐条
//     warn 点名**；同时那条素材**不进覆盖表**，于是它也不会出现在客户端的数据里（调用方按 `failed` 把它从语音表里
//     摘掉 —— 具体见 index.js 那一段：宁可让那个语种回落到默认配音，也不要留一条永远 404 的静音台词）；
//   * **绝不因为一条 CDN 素材就让服务器起不来**：失败只让**那一条素材**不生效，包本身照旧加载（一条外部依赖
//     不该是可用性的单点）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 缓存目录名（在状态目录下）。 */
export const VOICE_CDN_CACHE_DIRNAME = 'voice-cdn';
/** 单条素材的下载超时（毫秒）。取不回来就是取不回来 —— 卡住启动比少一条台词更糟。 */
export const VOICE_CDN_TIMEOUT_MS = 20000;
/** 一条素材的大小上限（字节）。24 MB 足够任何一条语音；有上限才不会有「一个包把磁盘写满」。 */
export const VOICE_CDN_MAX_BYTES = 24 * 1024 * 1024;

/** 缓存路径：`<状态目录>/voice-cdn/<sha256>`。键是摘要，所以同一份字节只有一份。 */
export function voiceCdnCachePath(stateRoot, sha256) {
  return path.join(stateRoot, VOICE_CDN_CACHE_DIRNAME, sha256);
}

/** 是否一个摘要形态的字符串（形状层已经判过；这一层是服务侧，自己再判一次 —— 同一个理由：这里读的可能是手搓对象）。 */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * 把每一个包声明的 CDN 语音素材取到本地缓存，返回**服务侧的覆盖表**与**逐条失败**。
 *
 * @param {Array<{ id: string, voiceCdn?: Array<{ lang: string|null, charId: string, slot: string, file: string, url: string, sha256: string }> }>} packs
 * @param {{ stateRoot: string, log?: object|null, fetchImpl?: Function, timeoutMs?: number, maxBytes?: number }} opts
 * @returns {Promise<{
 *   overrides: Map<string, string>,
 *   errors: Array<{ pack: string, file: string, url: string, code: string, reason: string }>,
 *   failed: Set<string>,
 * }>}
 *   `overrides` 的键是 `/workshop-assets/` 那条路由里的 `"<包id>/<assets 内的相对路径>"`（`static.js` 的 assets
 *   分支在拼接包目录**之前**查它）；`failed` 的键是 `"<包id>\u0000<file>"`（调用方据此把那条台词从语音表里摘掉）。
 */
export async function materializeVoiceCdn(packs, {
  stateRoot, log = null, fetchImpl = globalThis.fetch, timeoutMs = VOICE_CDN_TIMEOUT_MS, maxBytes = VOICE_CDN_MAX_BYTES,
} = {}) {
  /** @type {Map<string, string>} */
  const overrides = new Map();
  /** @type {Array<{ pack: string, file: string, url: string, code: string, reason: string }>} */
  const errors = [];
  /** @type {Set<string>} */
  const failed = new Set();
  const list = (Array.isArray(packs) ? packs : [])
    .filter((p) => p && typeof p.id === 'string' && p.id && Array.isArray(p.voiceCdn) && p.voiceCdn.length)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!list.length) return { overrides, errors, failed };
  if (typeof stateRoot !== 'string' || !stateRoot) {
    // 没有状态目录就**没有**缓存位置 —— 这是「取回来也没地方放」，必须点名，不能静默跳过。
    for (const p of list) {
      for (const entry of p.voiceCdn) {
        errors.push({ pack: p.id, file: entry.file, url: entry.url, code: 'VOICE_CDN_NO_STATE_DIR', reason: 'this server has no state directory, so there is nowhere to cache a CDN voice line' });
        failed.add(`${p.id}\u0000${entry.file}`);
      }
    }
    return { overrides, errors, failed };
  }
  for (const p of list) {
    for (const entry of p.voiceCdn) {
      const at = { pack: p.id, file: entry.file, url: entry.url };
      if (!SHA256_RE.test(String(entry.sha256 || ''))) {
        errors.push({ ...at, code: 'VOICE_CDN_BAD_DIGEST', reason: `sha256 "${String(entry.sha256)}" is not a 64-character lowercase hex digest` });
        failed.add(`${p.id}\u0000${entry.file}`);
        continue;
      }
      const cached = voiceCdnCachePath(stateRoot, entry.sha256);
      // 缓存命中：**不联网**，也不重新算一遍摘要（文件名就是摘要，且装载期只有我们自己会写它）。
      if (fs.existsSync(cached)) {
        overrides.set(`${p.id}/${entry.file}`, cached);
        continue;
      }
      let buf;
      try {
        const res = await fetchImpl(entry.url, {
          redirect: 'follow',
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
        });
        if (!res || !res.ok) {
          errors.push({ ...at, code: 'VOICE_CDN_FETCH_FAILED', reason: `the author's URL answered ${res ? `${res.status} ${res.statusText || ''}`.trim() : 'nothing'}` });
          failed.add(`${p.id}\u0000${entry.file}`);
          continue;
        }
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        errors.push({ ...at, code: 'VOICE_CDN_FETCH_FAILED', reason: `could not fetch the author's URL: ${e && e.message ? e.message : e}` });
        failed.add(`${p.id}\u0000${entry.file}`);
        continue;
      }
      if (buf.length > maxBytes) {
        errors.push({ ...at, code: 'VOICE_CDN_TOO_LARGE', reason: `the bytes are ${buf.length} bytes (at most ${maxBytes})` });
        failed.add(`${p.id}\u0000${entry.file}`);
        continue;
      }
      const digest = createHash('sha256').update(buf).digest('hex');
      if (digest !== entry.sha256) {
        // 形状层的判据已经保证 `entry.sha256` 是小写 hex；这里只可能是**字节对不上**（被换掉 / 作者改了文件没改声明）。
        errors.push({ ...at, code: 'VOICE_CDN_DIGEST_MISMATCH', reason: `the bytes hash to ${digest}, but pack.json declares ${entry.sha256} — nothing was cached and nothing will be served` });
        failed.add(`${p.id}\u0000${entry.file}`);
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(cached), { recursive: true });
        // 先写临时名再 rename：一个半截的下载不该在缓存里留下一个「看起来命中」的文件。
        const tmp = `${cached}.part-${process.pid}`;
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, cached);
      } catch (e) {
        errors.push({ ...at, code: 'VOICE_CDN_CACHE_FAILED', reason: `could not write the cache file: ${e && e.message ? e.message : e}` });
        failed.add(`${p.id}\u0000${entry.file}`);
        continue;
      }
      overrides.set(`${p.id}/${entry.file}`, cached);
    }
  }
  for (const e of errors) log?.warn?.(`[voiceCdn] ${e.code} ${e.pack} ${e.file} (${e.url}): ${e.reason}`);
  if (overrides.size) log?.info?.(`[voiceCdn] ${overrides.size} CDN voice file(s) materialised into <state>/${VOICE_CDN_CACHE_DIRNAME}/ (served through the existing /workshop-assets route; the engine ships no voice asset address and no download route of its own)`);
  return { overrides, errors, failed };
}

/**
 * 把**取不到**的那几条台词从包的语音表里摘掉，返回一个**新的** packs 数组（原对象一个字节不动）。
 *
 * 为什么必须摘：那几条素材在客户端是从 `/workshop-assets/` 取音频的，取不到就是一次 404 + 一段静音 —— 正是
 * 「不许静默空白」要消灭的形态。摘掉之后客户端在那条台词上**回落到默认配音**（`public/js/audio.js` 本来就有
 * 这条回落），同时装载期那一条 warn 已经点名说了为什么。语种整档空了就连那一档一起摘掉（与
 * `VOICE_LANG_EMPTY` 同一条语义：一档里一条台词都没有，等于没有这一档）。
 * @param {Array<object>} packs
 * @param {Set<string>} failed `"<包id>\u0000<file>"`
 * @returns {Array<object>} 同一个长度与次序；没有需要摘的包时**逐字**返回原对象
 */
export function dropFailedVoiceCdnFiles(packs, failed) {
  if (!failed || !failed.size) return Array.isArray(packs) ? packs : [];
  return (Array.isArray(packs) ? packs : []).map((p) => {
    if (!p || !Array.isArray(p.voiceCdn) || !p.voiceCdn.length) return p;
    const drop = new Set(p.voiceCdn.filter((e) => failed.has(`${p.id}\u0000${e.file}`)).map((e) => e.file));
    if (!drop.size) return p;
    /** 摘掉 `drop` 里任意一条**出现在任意槽位**里的表（同一个 `file` 被两个槽位声明是很奇怪的写法，但按位置摘是对的）。 */
    const filterTable = (table) => {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [charId, slots] of Object.entries(table || {})) {
        /** @type {Record<string, string[]>} */
        const kept = {};
        for (const [slot, files] of Object.entries(slots || {})) {
          const next = (Array.isArray(files) ? files : []).filter((f) => !drop.has(f));
          if (next.length) kept[slot] = next;
        }
        if (Object.keys(kept).length) out[charId] = kept;
      }
      return out;
    };
    /** @type {Record<string, any>} */
    const voiceLangs = {};
    for (const [lang, table] of Object.entries(p.voiceLangs || {})) {
      const next = filterTable(table);
      if (Object.keys(next).length) voiceLangs[lang] = next;
    }
    return { ...p, voices: filterTable(p.voices), voiceLangs, voiceCdn: p.voiceCdn.filter((e) => !failed.has(`${p.id}\u0000${e.file}`)) };
  });
}
