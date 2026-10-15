// server/mod-manager/officialCatalog.js — 官方插件的**客户端目录**（`/mods/catalog.json` 那半边）。
//
// 为什么必须有它：一个包只要**进进程级 mod 集合**（`welcome.mods` / `modDigest`），客户端就必须能拿到它的字节并
// **自己重算同一个摘要** —— 否则「联机准入」会要求一个客户端拿不到的东西。Forge 档这条链是
// `server/modCatalog.js`（目录）+ `server/http/mods.js`（`/mods/file/<包>/<路径>`）+ `public/js/mods/*`（下载与对齐）。
//
// 本文件做的事只有一件：**产出与 `buildModCatalog` 逐字同形的条目**，于是客户端与那两条路由**一行都不用改**。
// 逐文件那三列的口径：
//   * `sha256`  —— 磁盘上真实字节的 sha256（客户端下载后能复算的那一个）；
//   * `canonical` —— 这个文件对**包摘要**的贡献。官方装载器对每个文件都哈希**原始字节**
//     （`officialLoader.js` 的 `sha256File`），所以这里 `canonical === sha256 === loader 的 per-file hash`；
//   * `bytes`  —— 文件长度。
// 于是客户端用与服务器**同一个算法**（`shared/modIdentity.js modManifestDigest`）就能重建 `hash`，
// 而 `buildOfficialCatalog` 的这条不变量由 `test/modOfficialCatalog.test.js` 直接断言。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { modManifestDigest } from '../../shared/sdk/digest.js';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * 官方插件的目录（与 `buildModCatalog(loaded)` 同形）。
 *
 * 读不到某个文件 ⇒ **整条不进目录**（宁可客户端说「这个包不完整」，也不要给一行它复算不出来的哈希）；
 * 调用方由此看到 `files` 少一行，而摘要不变量会立刻暴露不一致。
 *
 * @param {Array<any>} plugins `loadOfficialPlugins(...)` 的 `plugins`
 * @param {{ readFile?: (abs: string) => Buffer|Uint8Array }} [opts]
 * @returns {{ packs: Array<{ id: string, name: string, version: string, hash: string, layer: string, combat: boolean, api: null,
 *   files: Array<{ path: string, bytes: number, sha256: string, canonical: string }> }> }}
 */
export function buildOfficialCatalog(plugins, { readFile = (abs) => fs.readFileSync(abs) } = {}) {
  const packs = (Array.isArray(plugins) ? plugins : [])
    .filter((p) => p && typeof p.id === 'string' && typeof p.hash === 'string' && p.descriptor)
    .slice()
    .sort(byId)
    .map((p) => {
      const files = [];
      for (const f of Array.isArray(p.files) ? p.files : []) {
        if (!f || typeof f.path !== 'string' || typeof f.hash !== 'string') continue;
        let bytes;
        try { bytes = readFile(path.join(p.dir, ...f.path.split('/'))); } catch { continue; }
        files.push({ path: f.path, bytes: bytes.length, sha256: sha256Bytes(bytes), canonical: f.hash });
      }
      return {
        id: p.id,
        name: typeof p.manifest?.name === 'string' && p.manifest.name ? p.manifest.name : p.id,
        version: typeof p.manifest?.version === 'string' ? p.manifest.version : '',
        hash: p.hash,
        layer: p.descriptor.layer,
        combat: p.descriptor.combat === true,
        api: null,
        files,
      };
    });
  return { packs };
}

/**
 * 客户端重建出来的摘要是否等于服务器发布的 `hash`（**这条不变量是整个目录存在的理由**）。
 * 客户端那侧跑的是同一个函数，所以这里对得上 = 客户端也对得上。
 * @param {{ hash: string, files: Array<{ path: string, canonical: string }> }} entry
 */
export function catalogHashHolds(entry) {
  if (!entry || typeof entry.hash !== 'string') return false;
  return modManifestDigest((entry.files || []).map((f) => ({ path: f.path, hash: f.canonical }))) === entry.hash;
}

/**
 * 把两份目录并成一份（Forge + 官方）。**键冲突不静默覆盖**：同一个包 id 在两边都有 ⇒ 官方那一条被丢掉并
 * 由调用方点名 —— 一个 id 指向两份字节是本仓库最恨的形状。
 * @param {{ packs: Array<any> }} forge
 * @param {{ packs: Array<any> }} official
 * @returns {{ catalog: { packs: Array<any> }, collisions: string[] }}
 */
export function mergeCatalog(forge, official) {
  const seen = new Set();
  const packs = [];
  for (const p of (Array.isArray(forge?.packs) ? forge.packs : [])) { if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue; seen.add(p.id); packs.push(p); }
  const collisions = [];
  for (const p of (Array.isArray(official?.packs) ? official.packs : [])) {
    if (!p || typeof p.id !== 'string') continue;
    if (seen.has(p.id)) { collisions.push(p.id); continue; }
    seen.add(p.id);
    packs.push(p);
  }
  return { catalog: { packs: packs.sort(byId) }, collisions };
}
