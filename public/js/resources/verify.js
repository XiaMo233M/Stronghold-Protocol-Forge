// public/js/resources/verify.js — 深度 / 浅度校验（DESIGN §28.13.5）。
//
// 一次导入之后，「这份缓存还算不算数」有两个不同强度的问题，它们必须分开回答：
//
//   * **浅度**（`deep: false`，默认）：每个清单条目在缓存里有一条响应，带着 `X-SP-Resource: 1`，且**它的指纹**
//     与索引、与清单三处一致。这回答的是「缓存里装着的还是我导入的那一份吗」（有条目、没被换掉、没被别名）。
//     它不需要读文件体，所以几百 MB 的包也能在秒级给答案 —— 这是**开机路径**上跑的那一种。
//   * **深度**（`deep: true`）：再读一遍字节、重算 SHA-1[0:12]，并要求字节数等于 `size`。这回答的是「磁盘上的
//     字节还是不是那些」——配额回收、浏览器清理、坏的存储层都会让浅度通过而深度不通过。它是**用户按下去**才
//     跑的那一种（每按一次要读完整个包）。
//
// 两条都**不猜**：清单里少一个文件、条目指纹与索引不一致、收据那版清单不是当前这版、收据的容器摘要与服务器这次
// 宣告的不是同一份 —— 全部落到 `missing` 里点名，并且 `valid: false`。

import { CACHE_NAME, absoluteUrl, indexUrl, checkAbort, validateManifest } from './common.js';
import { importedReceipt, sha256 } from './bundle.js';

/**
 * 校验一份已导入资源包的完整性。
 * @param {{ pack: string, digest?: string|null }} decl `welcome.modAssets` 里属于这个包的那一条
 * @param {any} manifest 服务端宣告的清单
 * @param {{ caches?: CacheStorage, origin?: string, deep?: boolean, signal?: AbortSignal,
 *   onProgress?: (p: { checked: number, total: number }) => void }} [opts]
 * @returns {Promise<{ valid: boolean, checked: number, missing: string[], deep: boolean }>}
 */
export async function verifyImportedResources(decl, manifest, {
  caches = globalThis.caches, origin = location.origin, deep = false, signal, onProgress = () => {},
} = {}) {
  validateManifest(manifest);
  const packId = decl && decl.pack;
  if (!packId || !caches) return { valid: false, checked: 0, missing: ['cache storage'], deep };
  // ① 收据：这个包**导入过**，而且导入的是**这一份**清单与**这一份**容器。
  const receipt = await importedReceipt(decl, { caches, origin });
  if (!receipt) return { valid: false, checked: 0, missing: ['import receipt'], deep };
  const missing = [];
  if (receipt.manifest !== manifest.version) missing.push('manifest version');
  if (receipt.count !== manifest.files.length) missing.push('file count');
  // 「同一个房间摘要 ⇒ 同一份容器」在客户端的那一半：服务器这次宣告的容器摘要，必须就是当初导入的那一份。
  // 不等 ⇒ 这个包换了容器（新身份），旧缓存一个字节都不许再用。
  if (typeof decl.digest === 'string' && receipt.digest !== decl.digest) missing.push('container digest');
  if (missing.length) return { valid: false, checked: 0, missing, deep };
  const cache = await caches.open(CACHE_NAME);
  const index = await (await cache.match(indexUrl(origin)))?.json();
  const known = index && index.format === 1 && index.files && typeof index.files === 'object' ? index.files : null;
  if (!known) return { valid: false, checked: 0, missing: ['resource index'], deep };
  let checked = 0;
  // 每批 8 个：文件可能很大，但校验本身不该把浏览器卡住。
  for (let i = 0; i < manifest.files.length; i += 8) {
    await Promise.all(manifest.files.slice(i, i + 8).map(async (f) => {
      const key = absoluteUrl(f.url, origin);
      const r = await cache.match(key);
      let valid = !!r && r.headers.get('X-SP-Resource') === '1'
        && r.headers.get('X-SP-Resource-Hash') === f.hash && known[key] === f.hash;
      if (valid && deep) {
        checkAbort(signal);
        const body = await r.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', body))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 12);
        valid = body.byteLength === f.size && hash === f.hash;
      }
      if (!valid) missing.push(f.url);
      checked++;
    }));
    onProgress({ checked, total: manifest.files.length });
  }
  return { valid: missing.length === 0, checked, missing, deep };
}

/**
 * 容器**整包摘要**的校验：`sha256(容器字节)` 是否等于声明的那一份（`assets.verify` 的旁挂摘要，服务端装载期
 * 已经与字节核对过一遍，并通过 `welcome.modAssets[].digest` 交到客户端手里）。
 *
 * 这是**可选**的一步，默认脚本不走它，理由写在返回值里而不是藏在注释里：`crypto.subtle.digest` 只能对一整块
 * 内存做摘要（没有流式接口），而一个完整资源包可达数百 MB —— 为了核对摘要去分配一整块同尺寸内存，正是导入路径
 * 刻意避开的事（`bundle.js` 的顺序开窗读）。所以：
 *   * `file.size <= maxBytes`（默认 256 MiB）⇒ 真的算一遍，`checked: true`；
 *   * 更大 ⇒ `checked: false`，`reason: 'too-large'` —— **如实报告「没查」**，而不是假装查过。
 * 逐文件的 SHA-1[0:12] 核对（`importResourcePack`）与它并不重复：那是「每个文件是不是它声称的那份」，这是
 * 「整包字节与声明的那份容器是不是同一件东西」。
 * @param {{ size: number, arrayBuffer: Function }} file
 * @param {string|null} digest 声明的容器摘要（64 位十六进制）
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ checked: boolean, ok: boolean, reason?: string, actual?: string }>}
 */
export async function verifyContainerBytes(file, digest, { maxBytes = 256 * 1024 * 1024, signal } = {}) {
  if (typeof digest !== 'string' || !/^[0-9a-fA-F]{64}$/.test(digest)) return { checked: false, ok: false, reason: 'no-digest' };
  if (!file || !Number.isSafeInteger(file.size)) return { checked: false, ok: false, reason: 'no-file' };
  if (file.size > maxBytes) return { checked: false, ok: false, reason: 'too-large' };
  checkAbort(signal);
  const actual = await sha256(await file.arrayBuffer());
  return { checked: true, ok: actual === digest.toLowerCase(), actual };
}
