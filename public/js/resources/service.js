// public/js/resources/service.js — SW 的取数逻辑（DESIGN §28.13.5）。
//
// 它回答的**只有**一个问题：「这条 `/assets|/fonts|/media` 请求，能不能用本地已经校验过的字节回答？」
// 能就回答，不能就 **412**。三件事是刻意不做的：
//
//   * **不回源**（no network fallback）。回源一次就等于「本地导入」这条策略不存在：客户端会以为自己在用完整包，
//     而实际上每一张图都来自服务器。这与服务端 `serverPolicy: "cache-only"` 是**同一条口径的两半**
//     （`server/http/static.js` 对那两棵树回 412 且不 stat），两半合起来才是一份完整的「缓存优先」部署。
//   * **不记录网络响应**（不做 runtime caching）。缓存里只应有 `bundle.js` 逐文件核对过指纹之后写进去的字节。
//   * **不服务没有索引作保的条目**。索引（`common.js INDEX_PATH`）是「哪些 URL 被校验过、指纹是什么」的唯一
//     真相：一条缓存命中但索引里没有（或指纹对不上）的条目，是一个上一版清单的孤儿，必须当没有。
//
// 参考实现（`_up/mod4-pack/integration/client/public/js/resources/service.js`）里那三件**真的值钱**的事逐条照搬：
//   ① 无扩展名音频路由（`/media/bgm/act1` → `/assets/audio/bgm/act1.mp3`，按 `shared/media.js` 的扩展名次序）；
//   ② `%5B` 编码等价（棋盘贴图用 `encodeURI` 拼接，方括号会变成 `%5B`；同一个文件因此有两种拼写，两种都要认）；
//   ③ 未命中 **412**（而不是 200 空体 / 404 —— 两者都会被当成「这个文件本来就没有」）。

import { CACHE_NAME, isResourcePath, mediaCandidates, rangeResponse, indexUrl } from './common.js';

/** 412 的正文：一句给人看的话（真正起作用的只有状态码）。中英并列与 `server/http/common.js` 的错误页同一条约定，
 *  但这一句不经过 `t()` —— SW 里没有语言状态（也没有页面），它是给盯着网络面板的人看的。 */
// i18n-ignore: a worker response body, not page UI (the page shows its own localized message)
export const RESOURCE_MISSING_TEXT = '资源需先从客户端导入 · Import the resource pack first'; // i18n-ignore

/**
 * 一条**未命中**的回答：412，`no-store`（它描述的是一个会变的本地状态，绝不能进任何缓存）。
 * @returns {Response}
 */
function missingResponse() {
  return new Response(RESOURCE_MISSING_TEXT, {
    status: 412,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * 一条资源请求的答案，或 `null`（不是本 SW 管的请求 —— 调用方要放行给网络）。
 * @param {Request} request
 * @param {{ caches?: CacheStorage }} [deps] 依赖注入（测试给一个假的 `caches`，浏览器用真的）
 * @returns {Promise<Response|null>}
 */
export async function handleResourceRequest(request, { caches = globalThis.caches } = {}) {
  if (!request || request.method !== 'GET') return null;
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (!isResourcePath(url.pathname)) return null;
  // 没有 Cache Storage（隐私模式 / 老浏览器）= 没有本地导入这件事：明说，不偷偷回源。
  if (!caches) return missingResponse();
  try {
    const cache = await caches.open(CACHE_NAME);
    const index = await (await cache.match(indexUrl(url.origin)))?.json();
    const known = index && index.format === 1 && index.files && typeof index.files === 'object' ? index.files : null;
    if (!known) return missingResponse();
    // 无扩展名音频路由先映射到规范文件（候选按扩展名次序）；其它路径只有一个候选。
    url.search = '';
    const candidates = mediaCandidates(url.pathname);
    const direct = candidates.length ? candidates.map((p) => new URL(p, url).href) : [url.href];
    // `encodeURI`（棋盘素材加载器）会转义方括号，`URL`（导入器）保留它们 —— 同一个文件两种拼写都试，
    // 且只用**校验过的本地缓存**回答（参考实现的原话与做法）。
    const keys = [...new Set(direct.flatMap((key) => [key, key.replace(/%5B/gi, '[').replace(/%5D/gi, ']')]))];
    for (const key of keys) {
      const expected = known[key];
      if (typeof expected !== 'string') continue; // 索引没有作保：当没有（不是「命中就发」）
      const hit = await cache.match(key);
      if (!hit || hit.headers.get('X-SP-Resource') !== '1') continue;
      if (hit.headers.get('X-SP-Resource-Hash') !== expected) continue; // 索引说 A、条目写着 B = 孤儿
      const range = request.headers.get('Range');
      return range ? await rangeResponse(hit, range) : hit;
    }
    return missingResponse();
  } catch {
    // 缓存读失败（配额、隐私模式下的实现差异）也是「没有」：这条路径永远不许把请求放回网络。
    return missingResponse();
  }
}
