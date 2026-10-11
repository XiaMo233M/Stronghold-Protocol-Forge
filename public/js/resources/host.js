// public/js/resources/host.js — 引擎侧的资源宿主：声明登记 + 一站式流程（DESIGN §28.13.5，docs/WORKSHOP.md §1.9.4）。
//
// 这个模块**只在一份 `welcome.modAssets` 真的带来声明时才被加载**：`public/js/main.js` 在 `welcome` 帧里看到这个
// 字段才 `import('./resources/host.js')`。于是「不声明 ⇒ 无字段、无新请求、无新 DOM、无新全局」这条不变量在
// 客户端也是**结构性**的，而不是靠几个 `if`：没有声明，这个文件根本不进浏览器。
//
// 它做三件事，一件也不多做：
//   1. **登记**服务器的声明（`installModAssets`），并按需在后台注册引擎自带的 SW（`worker.js`）；
//   2. 把声明按包交给需要它的人：包的 C 层面板（B2 段，`ctx.pack` 就是包 id）调 `modAssetsFor` 拿自己那一条；
//   3. 提供**整条客户端流程**（`importAndVerify`）：取清单 → 容器导入 → 逐文件校验 → 写缓存 → 深浅校验，
//      最后把结果如实交出去。
//
// **入口放行（`session.preloadReady`）不在本文件里**，这是刻意的：什么时候算「装好了」是**包的策略**（浅度还是
// 深度、允许跳过还是必须完整），不是引擎能替它决定的。B2 段已经把唯一那支笔交给面板 ——
// `ctx.session.setPreload({ required, ready })`（`public/js/ui/extensions.js`，`store.session.preloadRequired` /
// `preloadReady` 由 `selectRoute` 读取）。所以引擎只**报告**校验结果，面板按自己的策略动那支笔。谁也不能绕过它：
// 引擎不写这两个标志，包也拿不到 store。

import { MEDIA_PREFIX, absoluteUrl as absoluteUrlFor } from './common.js';
import { fetchManifest, fetchContainer, importResourcePack, importedReceipt, revokeImport } from './bundle.js';
import { verifyImportedResources, verifyContainerBytes } from './verify.js';
import { activateResourceWorker } from './worker.js';
// 镜像的**排序面**（DESIGN §28.40）：主机名从 `pack.json` 来，这里只回答「先试哪一条」。见 sources.js 文件头。
import { orderDeclared, sourcesEnabled } from './sources.js';

/** `/workshop-resources/<pack>/<声明路径>` —— 服务端注册容器与清单的那条路由（`shared/workshop.js`）。 */
export const WORKSHOP_RESOURCE_PREFIX = '/workshop-resources/';
/** `assets.serverPolicy` 的两个取值（`shared/workshop.js ASSETS_SERVER_POLICIES`）。 */
export const ASSETS_SERVER_POLICIES = Object.freeze(['serve', 'cache-only']);
/** `assets.verify` 的算法（`shared/workshop.js ASSETS_VERIFY_ALGORITHMS`）。 */
export const ASSETS_VERIFY_ALGORITHMS = Object.freeze(['sha256']);
/** `assets.mirrors[]` 的字段闭集（`shared/workshop.js ASSETS_MIRROR_FIELDS`，DESIGN §28.40）。 */
export const ASSETS_MIRROR_FIELDS = Object.freeze(['id', 'base', 'sha256']);
/** 一个包最多几条镜像（`shared/workshop.js ASSETS_MIRROR_MAX`）。 */
export const ASSETS_MIRROR_MAX = 4;
/** 镜像 id 的形态（`shared/workshop.js ASSETS_MIRROR_ID_RE`）。 */
const MIRROR_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 包 id 与目录名同一个字符集（`shared/workshop.js PACK_ID_RE`）。 */
const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** @type {ReadonlyArray<any>} */
let declarations = Object.freeze([]);
/** 后台注册那一次（同一页只做一次；失败过一次也不再重试 —— 一条失败的重试链只会刷日志）。 */
let workerAttempt = null;

/**
 * 重判服务器的声明（客户端是同一个声明的第二个读者，与 `extensions.js` 对面板同一条姿态）：形状不对的条目被
 * **具名拒绝并丢掉**，绝不半信半疑地用。
 * @param {unknown} raw `welcome.modAssets` 的一条
 * @returns {{ ok: true, decl: any } | { ok: false, code: string, detail: string }}
 */
export function normalizeModAsset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'MOD_ASSETS_BAD_ENTRY', detail: 'declaration is not an object' };
  const pack = raw.pack;
  if (typeof pack !== 'string' || !PACK_ID_RE.test(pack)) return { ok: false, code: 'MOD_ASSETS_BAD_PACK', detail: `pack id ${JSON.stringify(pack)} is not a usable id` };
  const base = `${WORKSHOP_RESOURCE_PREFIX}${pack}/`;
  for (const [field, suffix] of [['container', '.spresources'], ['manifest', '.json']]) {
    const url = raw[field];
    if (typeof url !== 'string' || !url.startsWith(base) || !url.split('?')[0].endsWith(suffix)) {
      return { ok: false, code: 'MOD_ASSETS_BAD_URL', detail: `"${pack}".${field} is ${JSON.stringify(url)} — only ${base}<path>${suffix} is servable` };
    }
  }
  if (typeof raw.digest !== 'string' || !DIGEST_RE.test(raw.digest)) {
    return { ok: false, code: 'MOD_ASSETS_BAD_DIGEST', detail: `"${pack}".digest is not a sha256 digest — without it the imported bytes cannot be tied to the container the server verified` };
  }
  const serverPolicy = raw.serverPolicy === undefined ? 'serve' : raw.serverPolicy;
  if (!ASSETS_SERVER_POLICIES.includes(serverPolicy)) {
    return { ok: false, code: 'MOD_ASSETS_BAD_SERVER_POLICY', detail: `"${pack}".serverPolicy is ${JSON.stringify(raw.serverPolicy)} — not one of ${ASSETS_SERVER_POLICIES.join(', ')}` };
  }
  const verify = raw.verify === undefined ? 'sha256' : raw.verify;
  if (!ASSETS_VERIFY_ALGORITHMS.includes(verify)) {
    return { ok: false, code: 'MOD_ASSETS_BAD_VERIFY', detail: `"${pack}".verify is ${JSON.stringify(raw.verify)} — not one of ${ASSETS_VERIFY_ALGORITHMS.join(', ')}` };
  }
  const mirrorsParsed = raw.mirrors === undefined ? null : normalizeMirrors(raw.mirrors);
  if (mirrorsParsed && !mirrorsParsed.ok) return mirrorsParsed;
  return {
    ok: true,
    decl: Object.freeze({
      pack,
      container: raw.container,
      manifest: raw.manifest,
      digest: raw.digest.toLowerCase(),
      serverPolicy,
      verify,
      // 作者自备 CDN 的镜像（DESIGN §28.40）：**只在声明过时才存在** —— 没声明 `mirrors` 的包，这一份声明对象与
      // 从前逐字段相同（`welcome` 帧也因此逐字节相同）。
      ...(mirrorsParsed ? { mirrors: Object.freeze(mirrorsParsed.mirrors.map((m) => Object.freeze({ ...m }))) } : {}),
      /** 无扩展名音频路由的前缀：面板要判断「这个包管不管音频」时不用自己再拼一遍。 */
      mediaPrefix: MEDIA_PREFIX,
    }),
  };
}

/**
 * `assets.mirrors[]` 的**客户端重判**（DESIGN §28.40）。服务端已经判过一遍，这里是**第二个读者** —— 同一个理由，
 * 与 `normalizeModAsset` 对其余字段的姿态逐字相同：读到的可能是手搓对象，或者一帧被改过的 `welcome`。
 *
 * 判据与形状层**逐条一致**（少判一条的方向就是「形状层放行、客户端拒收」，那是作者最难看懂的一种失败），码名按
 * 本文件的既有前缀写作 `MOD_ASSETS_BAD_MIRROR*`。数值那一半（`sha256` 是否等于包内容器的摘要）不在这里判：
 * 那是装载期的活（`server/workshop.js assetsMirrorIssues`），客户端只重判**形态**。
 * @param {unknown} raw
 * @returns {{ ok: true, mirrors: Array<{ id: string, base: string, sha256: string }> } | { ok: false, code: string, detail: string }}
 */
function normalizeMirrors(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR', detail: 'assets.mirrors must be a non-empty array (drop the key instead of sending [])' };
  }
  if (raw.length > ASSETS_MIRROR_MAX) {
    return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR', detail: `assets.mirrors declares ${raw.length} entries; at most ${ASSETS_MIRROR_MAX}` };
  }
  /** @type {Array<{ id: string, base: string, sha256: string }>} */
  const out = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const at = `assets.mirrors[${i}]`;
    const entry = raw[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR', detail: `${at} is not an object` };
    for (const key of Object.keys(entry)) {
      if (!ASSETS_MIRROR_FIELDS.includes(key)) return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR', detail: `${at}: "${key}" is not a mirror field (${ASSETS_MIRROR_FIELDS.join(', ')})` };
    }
    if (typeof entry.id !== 'string' || !MIRROR_ID_RE.test(entry.id)) {
      return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR_ID', detail: `${at}.id ${JSON.stringify(entry.id)} is not a mirror id (a letter first, then a-z 0-9 _ -, at most 32)` };
    }
    if (seen.has(entry.id)) return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR_ID', detail: `${at}.id "${entry.id}" is declared twice` };
    seen.add(entry.id);
    if (typeof entry.base !== 'string' || !entry.base.endsWith('/')) {
      return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR_BASE', detail: `${at}.base must be a string ending in "/" — the container is fetched as <base><its file name inside the pack>` };
    }
    let parsed = null;
    try { parsed = new URL(entry.base); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR_BASE', detail: `${at}.base must be an absolute "https://" URL with a host, no credentials, no query and no fragment (http: / data: / file: / protocol-relative all refuse)` };
    }
    if (typeof entry.sha256 !== 'string' || !DIGEST_RE.test(entry.sha256)) {
      return { ok: false, code: 'MOD_ASSETS_BAD_MIRROR_DIGEST', detail: `${at}.sha256 is not a 64-character lowercase hex digest` };
    }
    out.push({ id: entry.id, base: entry.base, sha256: entry.sha256 });
  }
  return { ok: true, mirrors: out };
}

/**
 * 登记一次 `welcome.modAssets`，并在有声明时于**后台**注册引擎自带的 SW。
 *
 * 注册**不 await**、失败只记日志：一个还没被 SW 接管的页面用不了本地缓存，但它照样能进游戏（这也是参考实现
 * 的姿态 —— 「已校验的入口从不等待这个 promise」）。
 * @param {unknown} list
 * @param {{ nav?: any, log?: object|null, timeoutMs?: number }} [opts]
 * @returns {{ accepted: number, refused: Array<{ code: string, detail: string }> }}
 */
export function installModAssets(list, { nav = globalThis.navigator?.serviceWorker, log = null, timeoutMs = 15000 } = {}) {
  const accepted = [];
  const refused = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = normalizeModAsset(raw);
    if (r.ok) accepted.push(r.decl);
    else { refused.push({ code: r.code, detail: r.detail }); log?.error?.(`[mod-assets] ${r.code}: ${r.detail}`); }
  }
  // 同一页收到第二个 `welcome`（重连）时整份替换：声明是服务器当前状态的快照，不做增量合并。
  declarations = Object.freeze(accepted);
  if (accepted.length && !workerAttempt) {
    workerAttempt = activateResourceWorker(undefined, nav, timeoutMs)
      .then((controlled) => { log?.info?.(`[mod-assets] resource worker ${controlled ? 'controlling this page' : 'registered'}`); return true; })
      .catch((err) => { log?.warn?.(`[mod-assets] resource worker unavailable: ${err && err.message ? err.message : String(err)}`); return false; });
  }
  return { accepted: accepted.length, refused };
}

/** 本页当前的声明（冻结的副本）。 */
export function modAssetDeclarations() {
  return declarations;
}

/** 某个包那条声明，或 `null`（这个包没声明 `assets`）。 */
export function modAssetsFor(packId) {
  for (const d of declarations) if (d.pack === packId) return d;
  return null;
}

/**
 * 这个包在本机的导入状态：声明、收据、以及「收据说的容器是不是服务器这次宣告的那一份」。
 *
 * `stale: true` 是**结论**而不是提示：换了容器就是换了身份（`assetsDigest` 进了包的内容哈希，DESIGN §28.2），
 * 旧缓存里的字节一张都不许再用。面板据此要求重新导入。
 * @param {string} packId
 * @param {{ caches?: CacheStorage, origin?: string }} [opts]
 */
export async function importStateFor(packId, { caches = globalThis.caches, origin = globalThis.location?.origin } = {}) {
  const decl = modAssetsFor(packId);
  if (!decl) return { decl: null, receipt: null, stale: false };
  const receipt = caches ? await importedReceipt(decl, { caches, origin }) : null;
  return { decl, receipt, stale: !!receipt && receipt.digest !== decl.digest };
}

/**
 * **整条客户端流程**：取清单 → 容器导入（逐文件校验 + 写缓存）→ 深浅校验。任何一步失败都如实抛出/返回，
 * 并且**不留下一份「半导入」的收据**（`bundle.js` 在开头就撤掉旧收据，SW 于是继续回 412）。
 * @param {{ slice: Function, size: number }} file 用户选中的 `.spresources`
 * @param {string} packId
 * @param {{ caches?: CacheStorage, origin?: string, signal?: AbortSignal, deep?: boolean,
 *   fetchImpl?: Function, onProgress?: Function }} [opts] `deep` 走深度校验（重读每个文件的字节）
 * @returns {Promise<{ pack: string, version: string, digest: string, count: number, bytes: number,
 *   deep: boolean, valid: boolean, missing: string[], checked: number }>}
 */
export async function importAndVerify(file, packId, {
  caches = globalThis.caches, origin = globalThis.location?.origin, signal, deep = false, fetchImpl = globalThis.fetch, onProgress,
  manifest: givenManifest = null,
} = {}) {
  const decl = modAssetsFor(packId);
  if (!decl) throw new Error(`包 "${packId}" 没有声明 assets`);
  // `manifest` 只在**镜像**那条路上被传进来（已经从作者的主机取过一份，并且与容器头里的那份逐条比对过），
  // 默认路径一字未改：还是从服务端那条 `decl.manifest` 取。
  const manifest = givenManifest || await fetchManifest(decl, { fetchImpl });
  const imported = await importResourcePack(file, decl, manifest, { caches, origin, signal, onProgress });
  const verdict = await verifyImportedResources(decl, manifest, { caches, origin, deep, signal, onProgress });
  if (!verdict.valid) {
    // 导入之后立刻校验失败 = 这份缓存不可信。**收据与索引一起摘**：只撤收据的话，SW 还会拿那批字节回答
    // （响应头没变，它自己的两道检查都会通过）—— 宁可回 412 让玩家重导，也不许发已知是坏的字节。
    await revokeImport(packId, { caches, origin, urls: manifest.files.map((f) => absoluteUrlFor(f.url, origin)) });
  }
  return { ...imported, deep, valid: verdict.valid, missing: verdict.missing, checked: verdict.checked };
}

/** 一条镜像上一对取数地址：`<base><包内文件名>`（形状层要求 `base` 以 `/` 结尾，所以这里不做任何拼接判断）。 */
function mirrorUrls(decl, mirror) {
  const name = (p) => String(p).split('/').pop();
  return { container: `${mirror.base}${name(decl.container)}`, manifest: `${mirror.base}${name(decl.manifest)}` };
}

/**
 * **从服务端导入**：取容器（`decl.container`）→ 走与本地文件导入**同一条**流程。
 *
 * 声明了 `assets.mirrors` 的包（DESIGN §28.40）在这里多一步**选源**，次序是硬性的一条线：
 *
 *   1. `sources.orderDeclared()` 给出「先试哪一条」（没有提供者 / 关掉门控 ⇒ 作者声明的顺序）；
 *   2. 逐条镜像：取清单 → 取容器 → **先核整包 sha256**（必须 `checked && ok`）→ 过了才走既有的逐文件
 *      SHA-1[0:12] 导入。**任何一步不过 ⇒ 那条镜像作废、换下一条**（次序不许改：先整包、再逐文件）；
 *   3. 全都不行 ⇒ **回落包内那条 `/workshop-resources/…` URL**，并且**响亮**：`log.warn` 一行 + 返回值里的
 *      `via: 'pack'` 与 `refusals`（面板据此把降级显示出来）。**绝不静默**，也**绝不空白**。
 *
 * 没声明 mirrors 的包走的还是从前那**一条**路径：同一条 URL、同一串调用、返回值的形状都逐字相同（这一支里
 * `orderDeclared` 一次都不会被问到）。
 * @param {string} packId
 * @param {{ caches?: CacheStorage, origin?: string, signal?: AbortSignal, deep?: boolean,
 *   fetchImpl?: Function, onProgress?: Function, log?: object|null,
 *   order?: { ids: string[], refusals: Array<{ code: string, detail: string }> }, verifyBytes?: Function }} [opts]
 *   `order` 让调用方（或测试）预先定好顺序；省略时按 `sources.orderDeclared()` 算。
 *   `verifyBytes` 默认就是 `verify.js verifyContainerBytes`（整包摘要），做成可注入的只为测试能钉住
 *   「没核过就换下一条」那一条支路 —— 真实的那条支路要一个 >256 MiB 的容器才够得着。
 * @returns {Promise<object>} `importAndVerify` 的结果；**声明了镜像的包**另外带 `via`（镜像 id 或 `'pack'`）与
 *   `refusals`（逐条具名，面板可见）
 */
export async function importFromServer(packId, {
  caches = globalThis.caches, origin = globalThis.location?.origin, signal, deep = false, fetchImpl = globalThis.fetch, onProgress,
  log = globalThis.console, order = null, verifyBytes = verifyContainerBytes,
} = {}) {
  const decl = modAssetsFor(packId);
  if (!decl) throw new Error(`包 "${packId}" 没有声明 assets`);
  const mirrors = Array.isArray(decl.mirrors) ? decl.mirrors : [];
  // 门控关掉 ⇒ 走的与「这个包没声明 mirrors」**完全同一条**路径（连返回值的形状都一样，没有 `via` / `refusals`）：
  // 这就是那一格「一键回退」在代码里的形状 —— 一个包把加载源改坏了，玩家关掉设置就回到原样。
  if (!mirrors.length || !sourcesEnabled()) {
    const blob = await fetchContainer(decl, { fetchImpl });
    return importAndVerify(blob, packId, { caches, origin, signal, deep, fetchImpl, onProgress });
  }
  const picked = order || orderDeclared(mirrors);
  /** 逐条具名的降级说明：一条给日志，一条给面板（同一个字符串，免得两处说法漂）。 */
  const notices = [];
  for (const r of picked.refusals) {
    const line = `${r.code} (pack "${packId}"): ${r.detail}`;
    log?.warn?.(`[mod-assets] ${line}`);
    notices.push(line);
  }
  const byId = new Map(mirrors.map((m) => [m.id, m]));
  for (const id of picked.ids) {
    const mirror = byId.get(id);
    if (!mirror) continue;
    const from = mirrorUrls(decl, mirror);
    try {
      const manifest = await fetchManifest(decl, { fetchImpl, url: from.manifest });
      const blob = await fetchContainer({ container: from.container }, { fetchImpl });
      // **次序不许改**：先整包 sha256，再逐文件。`verifyContainerBytes` 只用一整块内存做摘要（`crypto.subtle`
      // 没有流式接口），所以超过它上限的容器会**如实报告没查**（`checked: false`）—— 而**没查过就等于不能用**：
      // 镜像是不受信的一方，包内那份才是。这与该函数自己的「可选」默认值相反，是刻意的（§28.40 第 3 条）。
      const verdict = await verifyBytes(blob, decl.digest);
      if (!verdict.checked) {
        throw Object.assign(new Error(`the container's sha256 was not checked (${verdict.reason || 'reason unknown'}) — an unverified mirror is never used`), { code: 'CLIENT_SOURCES_NOT_VERIFIED' });
      }
      if (!verdict.ok) {
        throw Object.assign(new Error(`the bytes hash to ${verdict.actual}, but this pack's container is ${decl.digest}`), { code: 'CLIENT_SOURCES_MIRROR_DIGEST_MISMATCH' });
      }
      const res = await importAndVerify(blob, packId, { caches, origin, signal, deep, fetchImpl, onProgress, manifest });
      log?.info?.(`[mod-assets] pack "${packId}" imported from mirror "${mirror.id}" (${mirror.base})`);
      return { ...res, via: mirror.id, refusals: notices };
    } catch (err) {
      const code = err && err.code ? err.code : 'CLIENT_SOURCES_MIRROR_FAILED';
      const line = `${code} (pack "${packId}", mirror "${mirror.id}" ${from.container}): ${err && err.message ? err.message : String(err)}`;
      log?.warn?.(`[mod-assets] ${line}`);
      notices.push(line);
    }
  }
  // 落到这里 = 声明过的镜像没有一条可用。回落包内那份**永远在**的字节，并且把这件事说出来（不静默、不空白）。
  const fallback = `CLIENT_SOURCES_FALLBACK (pack "${packId}"): none of the ${picked.ids.length} declared mirror(s) could be used, so the container is being taken from the pack's own ${decl.container} — the load source is NOT the one the author asked for`;
  log?.warn?.(`[mod-assets] ${fallback}`);
  notices.push(fallback);
  const blob = await fetchContainer(decl, { fetchImpl });
  const res = await importAndVerify(blob, packId, { caches, origin, signal, deep, fetchImpl, onProgress });
  return { ...res, via: 'pack', refusals: notices };
}

export { verifyContainerBytes };
