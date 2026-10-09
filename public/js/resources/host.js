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

/** `/workshop-resources/<pack>/<声明路径>` —— 服务端注册容器与清单的那条路由（`shared/workshop.js`）。 */
export const WORKSHOP_RESOURCE_PREFIX = '/workshop-resources/';
/** `assets.serverPolicy` 的两个取值（`shared/workshop.js ASSETS_SERVER_POLICIES`）。 */
export const ASSETS_SERVER_POLICIES = Object.freeze(['serve', 'cache-only']);
/** `assets.verify` 的算法（`shared/workshop.js ASSETS_VERIFY_ALGORITHMS`）。 */
export const ASSETS_VERIFY_ALGORITHMS = Object.freeze(['sha256']);

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
  return {
    ok: true,
    decl: Object.freeze({
      pack,
      container: raw.container,
      manifest: raw.manifest,
      digest: raw.digest.toLowerCase(),
      serverPolicy,
      verify,
      /** 无扩展名音频路由的前缀：面板要判断「这个包管不管音频」时不用自己再拼一遍。 */
      mediaPrefix: MEDIA_PREFIX,
    }),
  };
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
} = {}) {
  const decl = modAssetsFor(packId);
  if (!decl) throw new Error(`包 "${packId}" 没有声明 assets`);
  const manifest = await fetchManifest(decl, { fetchImpl });
  const imported = await importResourcePack(file, decl, manifest, { caches, origin, signal, onProgress });
  const verdict = await verifyImportedResources(decl, manifest, { caches, origin, deep, signal, onProgress });
  if (!verdict.valid) {
    // 导入之后立刻校验失败 = 这份缓存不可信。**收据与索引一起摘**：只撤收据的话，SW 还会拿那批字节回答
    // （响应头没变，它自己的两道检查都会通过）—— 宁可回 412 让玩家重导，也不许发已知是坏的字节。
    await revokeImport(packId, { caches, origin, urls: manifest.files.map((f) => absoluteUrlFor(f.url, origin)) });
  }
  return { ...imported, deep, valid: verdict.valid, missing: verdict.missing, checked: verdict.checked };
}

/**
 * **从服务端导入**：取容器（`decl.container`）→ 走与本地文件导入**同一条**流程。
 * @param {string} packId
 * @param {{ caches?: CacheStorage, origin?: string, signal?: AbortSignal, deep?: boolean,
 *   fetchImpl?: Function, onProgress?: Function }} [opts]
 */
export async function importFromServer(packId, {
  caches = globalThis.caches, origin = globalThis.location?.origin, signal, deep = false, fetchImpl = globalThis.fetch, onProgress,
} = {}) {
  const decl = modAssetsFor(packId);
  if (!decl) throw new Error(`包 "${packId}" 没有声明 assets`);
  const blob = await fetchContainer(decl, { fetchImpl });
  return importAndVerify(blob, packId, { caches, origin, signal, deep, fetchImpl, onProgress });
}

export { verifyContainerBytes };
