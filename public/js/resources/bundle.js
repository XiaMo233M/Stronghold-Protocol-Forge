// public/js/resources/bundle.js — 容器导入：解析 → 逐文件核对指纹 → 写进 Cache Storage（DESIGN §28.13.5）。
//
// 一条导入就是一次**顺序读**：包本体（`.spresources`）可能几百 MB，所以这里绝不把整个文件读进内存 —— 按
// `READ_AHEAD_BYTES` 开窗、最多 `MAX_PENDING_BYTES` 字节 / 3 个并发写、按 120 ms 节流报进度。参考实现
// （`_up/mod4-pack/integration/client/public/js/resources/bundle.js`）的这一套分块逻辑**逐条照搬**：那是它在移动端
// 真的跑得住的原因。
//
// 格式知识不在这里重写：容器的字节布局（`SPRES001` + uint32LE 头长 + 压紧 JSON 头 + 按清单顺序原样拼接的文件体）
// 由 `tools/spresources.mjs` 定义（Node 侧的读写核心），本文件是它的**浏览器孪生**，两侧用同一份规格、同一份
// 清单，`test/modAssets.test.js` 让它们在**同一批字节**上给出同一个解析结果。
//
// 写进缓存的每个条目都带两个头，SW 与校验靠它们工作：
//   `X-SP-Resource: 1`            这个字节是「本地导入且逐文件核对过」的，不是网络抓来的
//   `X-SP-Resource-Hash: <sha1[0:12]>` 它的指纹（索引里那一份必须与它逐字相同）
//
// 收据（`RECEIPT_PATH`）是**按包**记的：这份缓存是为哪份容器（`decl.digest`，装载期服务端已与字节核对过）导入
// 的、装着第几版清单、几个文件。它是「换容器 = 换身份 = 必须重新导入」这条对齐在客户端的那一半。

import { CACHE_NAME, MAX_FILE_BYTES, RESOURCE_MIME, RESOURCES_FORMAT, absoluteUrl, indexUrl, receiptUrl, checkAbort, validateManifest } from './common.js';

/** 容器的魔数（`tools/spresources.mjs MAGIC`，两个实现必须一致）。 */
export const MAGIC = 'SPRES001';
/** 头 JSON 的上限（容器格式的常量，`spresources.mjs MAX_HEADER_BYTES`）。 */
export const MAX_HEADER = 16 * 1024 * 1024;
/** 一次读多少字节（参考实现的值：4 MiB 预读，8 MiB 在写队列里）。 */
const READ_AHEAD_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

const hex = (bits) => [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
/** 整块字节的 SHA-256（十六进制，全量）—— 容器的分发指纹。 */
export const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

/** `Blob.arrayBuffer()` 在旧的移动端文件提供者上不存在，`FileReader` 兜底（参考实现的原话）。 */
const readBlob = (blob) => (typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error || new Error('无法读取资源包，请先保存到系统下载文件夹'));
  // i18n-ignore: an abort reason, never page UI
  reader.onabort = () => reject(new DOMException('读取已取消', 'AbortError')); // i18n-ignore: abort reason
  reader.readAsArrayBuffer(blob);
}));

/**
 * 清单版本号：`sha256(压紧的 files JSON)[0:12]` —— 容器格式的算法（`spresources.mjs computeVersion` /
 * `resource_pack.py:27`）。`JSON.stringify` 不加空格、不转义非 ASCII、保对象键序，与 Python 的
 * `separators=(',',':')` + `ensure_ascii=False` 逐字相同，所以两侧算出来的是同一个值。
 * @param {Array<object>} files
 * @returns {Promise<string>}
 */
export async function computeManifestVersion(files) {
  return (await sha256(new TextEncoder().encode(JSON.stringify(files)))).slice(0, 12);
}

/** 读收据文档（不存在 / 坏掉 = 什么都没导入过）。 */
async function readReceipt({ caches, origin }) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const doc = await (await cache.match(receiptUrl(origin)))?.json();
    if (!doc || doc.format !== 1 || doc.source !== 'local-file' || !doc.packs || typeof doc.packs !== 'object') return null;
    return doc;
  } catch { return null; }
}

/** 读一份按包的收据，或 `null`。 */
export async function importedReceipt(decl, { caches = globalThis.caches, origin = location.origin } = {}) {
  const id = decl && decl.pack;
  if (!id || !caches) return null;
  const doc = await readReceipt({ caches, origin });
  const rec = doc && doc.packs ? doc.packs[id] : null;
  return rec && typeof rec === 'object' ? rec : null;
}

/** 写一份按包的收据（读-改-写同一份文档：多个包各有一条，互不覆盖）。 */
async function writeReceiptPack(packId, record, { caches, origin }) {
  const cache = await caches.open(CACHE_NAME);
  const doc = (await readReceipt({ caches, origin })) || { format: 1, source: 'local-file', packs: {} };
  const packs = { ...doc.packs, [packId]: record };
  await cache.put(receiptUrl(origin), new Response(JSON.stringify({ format: 1, source: 'local-file', packs }), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

/**
 * 撤掉一个包的收据（导入失败 / 校验失败 / 换容器），并可选地把它的 URL 一起**从索引里摘掉**。
 *
 * 两件事分开，是因为它们回答不同的问题：
 *   * **收据**是「这个包导入过、而且导入的是这一份容器与这一版清单」——撤掉它，面板与 `verify` 立刻知道要重新
 *     导入（`importStateFor` / `verifyImportedResources` 的第一条判据就是它）。
 *   * **索引**是 SW 的白名单：它说「这些 URL 的字节被校验过，指纹是这些」。所以**字节被判定为坏**的时候
 *     （`importAndVerify` 的校验失败），必须连着索引一起摘 —— 只撤收据的话 SW 还会拿那批坏字节回答（响应头没变，
 *     SW 自己的那两道检查都会通过）。传 `urls` 就是把这件事做全；不传就只撤收据。
 * @param {string} packId
 * @param {{ caches?: CacheStorage, origin?: string, urls?: Iterable<string>|null }} [opts]
 * @returns {Promise<boolean>} 是否真的撤掉了什么
 */
export async function revokeImport(packId, { caches = globalThis.caches, origin = location.origin, urls = null } = {}) {
  if (!packId || !caches) return false;
  const cache = await caches.open(CACHE_NAME);
  let touched = false;
  if (urls) {
    const index = await (await cache.match(indexUrl(origin)))?.json();
    if (index && index.format === 1 && index.files && typeof index.files === 'object') {
      const files = { ...index.files };
      for (const url of urls) if (url && Object.hasOwn(files, url)) { delete files[url]; touched = true; }
      if (touched) {
        await cache.put(indexUrl(origin), new Response(JSON.stringify({ format: RESOURCES_FORMAT, files }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
    }
  }
  const doc = await readReceipt({ caches, origin });
  if (!doc || !doc.packs || !Object.hasOwn(doc.packs, packId)) return touched;
  const packs = { ...doc.packs };
  delete packs[packId];
  await cache.put(receiptUrl(origin), new Response(JSON.stringify({ format: 1, source: 'local-file', packs }), {
    headers: { 'Content-Type': 'application/json' },
  }));
  return true;
}

/**
 * 取回并校验服务端宣告的那份清单（`decl.manifest`，包内 `.json`，由 `/workshop-resources/` 服务）。
 *
 * 两步都要过：**形状**（`validateManifest`）与**自洽**（`manifest.version` 必须真的等于
 * `sha256(压紧 files)[0:12]`）。第二步是白拿的：一份版本号与文件表对不上的清单，说明作者手工改过它 —— 那正是
 * 「包内清单」与「容器头里的清单」会开始不一致的地方，而后者才是字节的真正描述。
 * @param {{ pack: string, manifest: string }} decl
 * @param {{ fetchImpl?: Function }} [opts]
 */
export async function fetchManifest(decl, { fetchImpl = globalThis.fetch } = {}) {
  const url = decl && decl.manifest;
  if (!url) throw new Error('这个包没有声明资源清单');
  const res = await fetchImpl(url, { cache: 'no-cache' });
  if (!res || !res.ok) throw new Error(`资源清单取不到（HTTP ${res ? res.status : '?'}）`);
  let body;
  try { body = await res.json(); } catch { throw new Error('资源清单不是 JSON'); }
  validateManifest(body);
  const recomputed = await computeManifestVersion(body.files);
  if (recomputed !== body.version) {
    throw new Error(`资源清单自相矛盾：version=${body.version}，按 files 重算=${recomputed}`);
  }
  return body;
}

/**
 * 从**服务端**取容器（`decl.container`，装载器注册过的那条 `/workshop-resources/…` URL）。
 *
 * 这是本仓与参考实现的一条**有意的差异**：参考项目的容器是玩家从 QQ 群下载、再用 `<input type=file>` 导进来的，
 * 服务端**从不**发它。我们的服务端本来就在服务这个包（B3a），所以同一份字节有两条来路：
 *   * 服务端 —— 这条；`serverPolicy: "cache-only"` 的部署里这是**玩家唯一需要的一次网络传输**：容器进来、
 *     校验、进 Cache Storage，此后 `/assets` 与 `/fonts` 都由 SW 本地回答（服务器的 412 因此不再是死路）；
 *   * 本地文件 —— 离线分发 / 别人给的文件，`importResourcePack` 直接吃一个 `File`（两条路喂的是同一个函数）。
 *
 * 返回值是 `Blob`（不是 `ArrayBuffer`）：它照样有 `slice` / `size`，所以 `importResourcePack` 的顺序开窗读一字不改，
 * 而字节由浏览器自己留在磁盘上 —— 没有一个几百 MB 的 ArrayBuffer 落在 JS 堆里。
 * `Content-Length` 与 `decl` 无关（那是**文件大小**，不是容器摘要），所以这里只做「传输没被截断」这一条检查：
 * 真正的判据是逐文件 SHA-1[0:12]（导入时）与整包 sha256（`verify.js verifyContainerBytes`，可选）。
 * @param {{ container: string }} decl
 * @param {{ fetchImpl?: Function }} [opts]
 * @returns {Promise<Blob>}
 */
export async function fetchContainer(decl, { fetchImpl = globalThis.fetch } = {}) {
  const url = decl && decl.container;
  if (!url) throw new Error('这个包没有声明资源容器');
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res || !res.ok) throw new Error(`资源容器取不到（HTTP ${res ? res.status : '?'}）`);
  const blob = await res.blob();
  const declared = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isSafeInteger(declared) && declared > 0 && blob.size !== declared) {
    throw new Error(`资源容器传输不完整（收到 ${blob.size} 字节，应为 ${declared}）`);
  }
  return blob;
}

/** 两份清单必须逐条相同（url / size / hash / tier，且**顺序**相同 —— 顺序就是文件体的顺序）。 */function sameManifest(bundled, served) {
  if (!bundled || !Array.isArray(bundled.files)) return false;
  if (bundled.version !== served.version) return false;
  if (bundled.files.length !== served.files.length) return false;
  for (let i = 0; i < served.files.length; i++) {
    const a = bundled.files[i];
    const b = served.files[i];
    if (!a || a.url !== b.url || a.size !== b.size || a.hash !== b.hash || a.tier !== b.tier) return false;
  }
  return true;
}

/**
 * 导入一个容器：解析 → 逐文件核对指纹 → 写入 Cache Storage → 写索引与收据。
 *
 * 顺序是刻意的：**先撤掉旧收据**（半途而废的导入绝不能被当成已经导入过），再校验，再写。任何一步抛错，收据都
 * 保持缺席 —— 于是 SW 继续回 412，玩家看到的是「要重新导入」，而不是一堆裂图。
 * @param {{ slice: Function, size: number }} file 用户在页面上选中的 `.spresources`
 * @param {{ pack: string, digest: string, manifest: string }} decl `welcome.modAssets` 里属于这个包的那一条
 * @param {any} manifest 服务端宣告的清单（`fetchManifest` 的产物）
 * @param {{ caches?: CacheStorage, origin?: string, signal?: AbortSignal,
 *   onProgress?: (p: { count: number, bytes: number, current: string, speedBps: number }) => void }} [opts]
 * @returns {Promise<{ pack: string, version: string, digest: string, count: number, bytes: number }>}
 */
export async function importResourcePack(file, decl, manifest, {
  caches = globalThis.caches, origin = location.origin, signal, onProgress = () => {},
} = {}) {
  const packId = decl && decl.pack;
  if (!packId) throw new Error('导入需要一个已声明的包');
  if (!caches) throw new Error('当前浏览器不支持本地资源缓存（Cache Storage），无法导入');
  validateManifest(manifest);
  if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < 12) {
    throw new Error('请选择完整资源包（.spresources）');
  }
  const first = new Uint8Array(await readBlob(file.slice(0, 12)));
  if (new TextDecoder().decode(first.subarray(0, 8)) !== MAGIC) {
    throw new Error('资源包格式不正确：请导入 .spresources 本体，无需解压');
  }
  const length = new DataView(first.buffer, first.byteOffset, 12).getUint32(8, true);
  if (!length || length > MAX_HEADER || 12 + length > file.size) throw new Error('资源包头损坏');
  let header;
  try { header = JSON.parse(new TextDecoder().decode(await readBlob(file.slice(12, 12 + length)))); } catch { throw new Error('资源包清单损坏'); }
  const bundled = header && header.manifest;
  if (!header || header.format !== 'sp-resource-pack' || header.version !== 1) {
    throw new Error('资源包容器格式不受支持');
  }
  if (!sameManifest(bundled, manifest)) {
    throw new Error('资源包清单与服务器不一致：请重新获取当前版本的完整资源包');
  }
  let total = 0;
  for (const f of manifest.files) {
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw new Error(`资源大小无效：${String(f.url).slice(0, 80)}`);
    total += f.size;
  }
  if (file.size !== 12 + length + total) throw new Error('资源包不完整，请重新下载');

  checkAbort(signal);
  // ① 旧收据先撤：从这一刻起「已导入」是假的，直到这次导入真的完成。
  await revokeImport(packId, { caches, origin });
  const cache = await caches.open(CACHE_NAME);
  /** @type {Record<string, string>} */
  const hashes = {};
  const pending = new Set();
  let offset = 12 + length;
  let bytes = 0;
  let count = 0;
  let lastReport = 0;
  let windowStart = 0;
  let window = new Uint8Array();
  let pendingBytes = 0;
  let writeError;
  const started = performance.now();
  const report = (current) => {
    if (performance.now() - lastReport > 120 || count === manifest.files.length) {
      lastReport = performance.now();
      onProgress({ count, bytes, current, speedBps: bytes / Math.max(0.001, (lastReport - started) / 1000) });
    }
  };
  try {
    for (const f of manifest.files) {
      // ② 有界写入：最多 3 个在飞、最多 8 MiB 未落盘 —— 绝不为了速度把整包留在内存里。
      while (pending.size && (pending.size >= 3 || pendingBytes + f.size > MAX_PENDING_BYTES)) await Promise.race(pending);
      if (writeError) throw writeError;
      checkAbort(signal);
      if (offset < windowStart || offset + f.size > windowStart + window.byteLength) {
        windowStart = offset;
        window = new Uint8Array(await readBlob(file.slice(offset, Math.min(file.size, offset + Math.max(READ_AHEAD_BYTES, f.size)))));
      }
      const body = window.subarray(offset - windowStart, offset - windowStart + f.size);
      offset += f.size;
      // ③ 逐文件指纹：容器格式的判据是 SHA-1 前 12 位。对不上就是坏包，一个字节都不写。
      const hash = hex(await crypto.subtle.digest('SHA-1', body)).slice(0, 12);
      if (hash !== f.hash) throw new Error(`资源包文件损坏：${f.url.split('/').pop()}，请重新下载完整包`);
      if (writeError) throw writeError;
      checkAbort(signal);
      const key = absoluteUrl(f.url, origin);
      const ext = f.url.split('.').pop().toLowerCase();
      const response = new Response(body, {
        headers: {
          'Content-Type': RESOURCE_MIME[ext] || 'application/octet-stream',
          'Content-Length': String(f.size),
          'Accept-Ranges': 'bytes',
          'X-SP-Resource': '1',
          'X-SP-Resource-Hash': f.hash,
        },
      });
      pendingBytes += f.size;
      const write = Promise.resolve().then(() => cache.put(key, response)).then(() => {
        hashes[key] = f.hash; bytes += f.size; count++; report(f.url);
      }).catch((err) => { writeError ||= err; }).finally(() => { pending.delete(write); pendingBytes -= f.size; });
      pending.add(write);
    }
  } finally {
    await Promise.all([...pending]);
  }
  if (writeError) throw writeError;
  checkAbort(signal);
  // ④ 索引（URL → 指纹）与收据。索引是读-改-写的：多个包共用一份，谁都不许把别人的条目冲掉。
  const old = await (await cache.match(indexUrl(origin)))?.json();
  const files = old && old.format === 1 && old.files && typeof old.files === 'object' ? { ...old.files, ...hashes } : { ...hashes };
  await cache.put(indexUrl(origin), new Response(JSON.stringify({ format: RESOURCES_FORMAT, files }), {
    headers: { 'Content-Type': 'application/json' },
  }));
  await writeReceiptPack(packId, {
    manifest: manifest.version,
    count: manifest.files.length,
    digest: typeof decl.digest === 'string' ? decl.digest : null,
    importedAt: Date.now(),
  }, { caches, origin });
  return { pack: packId, version: manifest.version, digest: typeof decl.digest === 'string' ? decl.digest : null, count: count, bytes };
}
