// public/js/resources/common.js — 引擎自带的**客户端资源流程**的公共件（DESIGN §28.13.5，docs/WORKSHOP.md §1.9.4）。
//
// 这是本仓第一处使用 Cache Storage / Service Worker 的代码（移植自参考实现 `public/js/resources/common.js`，
// 见 `_up/mod4-resource-pack-recon.md` §一），所以先把「谁拥有什么」写清楚：
//
//   * **SW 属引擎，包只声明**（业主裁决 2026-10-10）。`/resource-sw.js` 与 `public/js/resources/**` 全部由本仓维护，
//     包**不能**提供 `.js` 去注册根作用域 SW —— 根 SW 能拦截该站点**所有**请求，那是交出客户端控制权。
//     包能做的只有 `pack.json.assets = { container, manifest, serverPolicy?, verify? }` 这一句声明。
//   * **不声明 ⇒ 一切照旧**。没有包声明 `assets` 时：`welcome` 里没有 `modAssets` 字段、浏览器不注册 SW、
//     `/resource-sw.js` 不被请求、没有 DOM、没有 `globalThis` 上的新名字。这条不变量与 B2/B3a 同口径。
//   * **SW 只从「校验过的本地导入」应答**。它不代理、不缓存网络响应、不回源：命中的字节必须是 `bundle.js`
//     逐文件核对过 SHA-1[0:12] 之后写进 Cache Storage 的那些，且索引仍为它们作保；否则一律 412（`service.js`）。
//
// 本文件的定位是「页面、SW 与 Node 测试都能 import 的纯逻辑」：**没有 DOM、没有 Preact**，只有 URL / MIME / 清单
// 形状 / 字节格式这几件事。Node 侧测试（`test/modAssets.test.js`）真的 import 它并跑完整条流程。
//
// 与参考实现的差异（逐条有意为之，报告里也写了）：
//   1. 缓存名、索引与收据的**形状**按本仓的多包模型重写：一份索引挂在 SW 上（URL → sha1[0:12]），一份收据按**包**
//      记录「这份缓存是为哪份容器（sha256）导入的」。参考实现只有一个全局清单与 `pack-config.js` 里的编译期常量，
//      因为我们这边可以有多个包同时声明 `assets`。
//   2. 音频扩展名表**不再抄一份**：直接 import `shared/media.js`（两侧共用的那一个真相）。
//   3. 清单形状校验**更严**：`size` 与 `hash` 都要有（没有指纹的清单无法校验，参考实现把 hash 当可选项，
//      那是给「先前的无哈希布局」留的兼容口，本仓没有那个布局）。

import { MEDIA_PREFIX, AUDIO_EXTS } from '../../../shared/media.js';

/** 本引擎拥有的 Cache Storage 名。一个缓存装所有包的所有文件：条目按 URL 覆盖写，换包只重下变了的文件。 */
export const CACHE_PREFIX = 'sp-workshop-resources-v1-';
/** 文件与索引共用的那一个缓存（索引也在里面：它描述的东西与它同生共死）。 */
export const CACHE_NAME = CACHE_PREFIX + 'all';
/** 那条合成条目：绝对 URL → 已校验的 `sha1[0:12]`。SW 的**白名单 + 期望指纹**就是它。 */
export const INDEX_PATH = '/__sp-resource-index__';
/** 导入收据（按包）：这份缓存是为哪份容器导入的、装着第几版清单、几个文件。 */
export const RECEIPT_PATH = '/__sp-imported-resource-pack__';
/** SW 脚本的站点路径（引擎文件，见文件头：包**不能**提供它）。 */
export const SW_URL = '/resource-sw.js';
/** 清单格式（`manifest.format`：容器格式自己的常量，别与容器版本混）。 */
export const RESOURCES_FORMAT = 1;
/** 一个资源文件的指纹：**SHA-1 十六进制前 12 位**（48 bit）—— 容器格式的一部分（`resource_pack.py` / `spresources.mjs`）。 */
export const CONTENT_HASH_RE = /^[0-9a-f]{12}$/;
/** 容器格式的单文件上限（24 MiB）。比这更大的条目不是这份缓存能装的东西，所以清单里出现它就是清单的问题。 */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;
/** 清单条目的分层：1 = 首屏必需（字体/音频/头像/图标），2 = 后台慢慢拉（立绘/模型/本机棋盘）。 */
export const TIER_ESSENTIAL = 1;
export const TIER_REST = 2;
export const TIERS = Object.freeze([TIER_ESSENTIAL, TIER_REST]);
/** 清单文件上限（容器格式的常量，`spresources.mjs MAX_FILES`）。 */
export const MAX_FILES = 50000;

export { MEDIA_PREFIX, AUDIO_EXTS };

/** 扩展名 → MIME（与容器格式的 MIME 字典逐项相同；只用于校验 URL 与给缓存条目一个 Content-Type）。 */
export const RESOURCE_MIME = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  mp4: 'video/mp4', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', atlas: 'text/plain; charset=utf-8',
  obj: 'text/plain; charset=utf-8', skel: 'application/octet-stream', bin: 'application/octet-stream',
});

/** 一个 URL 的 MIME，或 `null`（扩展名不是资源类型）。 */
export function resourceType(url) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(url || ''));
  return m ? RESOURCE_MIME[m[1].toLowerCase()] || null : null;
}

/**
 * 一个请求路径是否属于 SW 应答的那两棵树 + 那条无扩展名音频路由。
 *
 * `/build/` 被排除在外：那是 Vite 自己的输出目录，bundles 走 HTTP 缓存，必须完全绕过这个 SW。
 */
export function isResourcePath(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/build/')) return false;
  return /\/(?:assets|fonts)\//.test(p) || p.startsWith(MEDIA_PREFIX);
}

/**
 * 一条 `/media/…` 请求可能命中的**规范文件**（站点路径）：`/media/bgm/act1` → `/assets/audio/bgm/act1.mp3`
 * （然后 `.m4a`…）……规则与 `server/http/media.js` 的 `serveMedia()` 一致：它同样拒绝点目录段、以及以点开头/
 * 结尾的名字，所以那些路径在这里也必须什么都不返回。
 * @param {string} pathname
 * @returns {string[]} 不是那条路由时是空数组
 */
export function mediaCandidates(pathname) {
  const p = String(pathname || '');
  if (!p.startsWith(MEDIA_PREFIX)) return [];
  const rest = p.slice(MEDIA_PREFIX.length);
  if (!rest || rest.endsWith('/')) return [];
  const segments = rest.split('/').filter((s) => s.length > 0);
  if (!segments.length || segments.some((s) => s === '.' || s === '..' || s.startsWith('.') || s.endsWith('.'))) return [];
  const last = segments[segments.length - 1];
  const given = AUDIO_EXTS.find((e) => last.toLowerCase().endsWith(e)) || '';
  const stem = given ? last.slice(0, -given.length) : last;
  if (!stem) return [];
  const name = [...segments.slice(0, -1), stem].join('/');
  const order = given ? [given, ...AUDIO_EXTS.filter((e) => e !== given)] : AUDIO_EXTS;
  return order.map((ext) => `/assets/audio/${name}${ext}`);
}

/**
 * 一个**这份缓存可以拥有的**文件 URL：站点路径或绝对 http(s) URL，扩展名在表里。
 *
 * 清单里不许出现 `/media/…`：它不指向任何静态主机能提供的文件（那是无扩展名路由的入口），一条这样的条目会让
 * 客户端追着 4000 个永远取不到的名字跑。SW 负责把 `/media/…` 请求映回它**真的**存下来的那个条目。
 */
export function isResourceUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) return false;
  if (/[\s?#\\"'<>\u0000-\u001f]/.test(url)) return false;
  let pathname = url;
  if (!url.startsWith('/') || url.startsWith('//')) {
    if (!/^https?:\/\//i.test(url)) return false;
    try { pathname = new URL(url).pathname; } catch { return false; }
  }
  if (pathname.startsWith(MEDIA_PREFIX)) return false;
  return isResourcePath(pathname) && !!resourceType(pathname);
}

/** 清单条目的绝对 URL（缓存键）：`/assets/x.png` → `https://site/assets/x.png`。 */
export function absoluteUrl(url, origin = globalThis.location?.origin || 'http://localhost') {
  try { return new URL(String(url), origin).href; } catch { return null; }
}

/** 索引条目的绝对 URL（与它描述的文件同一个缓存）。 */
export function indexUrl(origin = globalThis.location?.origin || 'http://localhost') {
  return absoluteUrl(INDEX_PATH, origin) || INDEX_PATH;
}

/** 导入收据的绝对 URL。 */
export function receiptUrl(origin = globalThis.location?.origin || 'http://localhost') {
  return absoluteUrl(RECEIPT_PATH, origin) || RECEIPT_PATH;
}

/** `1.5 GiB` / `820 KiB` / `900 B` —— 进度文案（二进制单位，浏览器报配额时用的也是这个）。 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 校验服务端给的那份清单（容器头里那份的副本，由包自己的 `assets.manifest` 指向）。
 *
 * **抛**而不是返回 `{ok:false}`：一份坏清单要立刻关掉整条流程（它驱动上千个请求与缓存写入），而不是让调用方
 * 决定要不要继续。判据比参考实现严：`size` 与 `hash` 都要有 —— 没有指纹的条目无法校验，把它当可选就是允许
 * 「写进缓存但没人核对过」。
 * @param {any} m
 * @returns {any} 同一份清单
 */
export function validateManifest(m) {
  if (!m || typeof m !== 'object' || m.format !== RESOURCES_FORMAT) throw new Error('资源清单格式不受支持');
  if (typeof m.version !== 'string' || !m.version) throw new Error('资源清单缺少版本号');
  if (!Array.isArray(m.files)) throw new Error('资源清单缺少文件列表');
  if (m.files.length > MAX_FILES) throw new Error('资源清单过大');
  for (const f of m.files) {
    if (!f || typeof f !== 'object' || !isResourceUrl(f.url)) throw new Error(`资源清单条目无效：${String(f && f.url).slice(0, 80)}`);
    if (f.tier !== TIER_ESSENTIAL && f.tier !== TIER_REST) throw new Error(`资源清单条目缺少分层：${String(f.url).slice(0, 80)}`);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw new Error(`资源大小无效：${String(f.url).slice(0, 80)}`);
    if (typeof f.hash !== 'string' || !CONTENT_HASH_RE.test(f.hash)) throw new Error(`资源指纹无效：${String(f.url).slice(0, 80)}`);
  }
  return m;
}

/** 一个错误是不是「浏览器存不下了」（配额失败必须停下整条流程，而不是重试 4000 次）。 */
export function isQuotaError(err) {
  if (!err) return false;
  if (err.name === 'QuotaExceededError') return true;
  return /quota|disk|storage.*(?:full|exceed)/i.test(String(err.message || ''));
}

/** 一个 AbortError（用一个理由停下一轮导入，而不是抛一个裸 DOMException）。 */
export function abortError(reason = 'aborted') {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

/** 信号已中止就抛（两个文件之间快速失败）。 */
export function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(String(signal.reason ?? 'aborted'));
}

/**
 * 用一份已缓存**完整响应**回答一条 `Range` 请求：媒体元素靠字节区间探测/拖动进度，200 能播但 Safari 拒绝在没有
 * 206 的情况下 seek。
 * @param {Response} response 完整的缓存响应
 * @param {string} range 请求的 Range 头
 */
export async function rangeResponse(response, range) {
  const data = await response.arrayBuffer();
  const length = data.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || '').trim());
  let start;
  let end;
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, length - Number(m[2]));
    end = m[1] && m[2] ? Math.min(length - 1, Number(m[2])) : length - 1;
  }
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= length) {
    headers.set('Content-Range', `bytes */${length}`);
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${length}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(data.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}
