// server/mod-manager/officialLoader.js — 官方档（`sp:sdk@1`）的**装载器**。
//
// 与 Forge 档的分工：`server/workshop.js` 装载 `workshop/<包>/pack.json`（Forge 契约）；这里装载
// `plugins/<插件>/plugin.json`（**provisional** 官方 manifest，形状见 `shared/sdk/descriptor.js`）。
// 两者产出同一种「候选包」形状，所以都能喂给同一份 `buildActivationPlan`——
// 这正是「官方档与 Forge 扩展档共用 Mod Manager Core」的落地方式。
//
// 纪律与 `server/packFiles.js` / `loadServerModules` 逐字同源：
//   * **一条用不了的声明具名拒绝整包**（不是「包照旧加载、只是它的效果不在」）；
//   * 插件 id 必须等于目录名（与 `shared/workshop.js PACK_ID_RE` 同一条：标识不由外部数据随便拼）；
//   * 内容摘要 = 插件**全部文件**的 `[path, sha256]` 归一化哈希（`shared/sdk/digest.js contentDigest`），
//     所以「同一份字节 ⇒ 同一份摘要」这条对官方档同样成立；
//   * **符号链接既不跟随也不列出**（`Dirent` 对链接 `isFile()`/`isDirectory()` 皆为假）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { fromOfficialManifest } from '../../shared/sdk/descriptor.js';
import { modManifestDigest } from '../../shared/sdk/digest.js';
import { alignFailure } from '../../shared/sdk/errorCodes.js';

/** 官方插件的清单文件名（provisional；与仓库自己的 `MANIFEST.json` 刻意不同名，避免混淆）。 */
export const OFFICIAL_PLUGIN_MANIFEST = 'plugin.json';
/** 官方插件的默认根目录名（相对仓库）。 */
export const OFFICIAL_PLUGINS_DIR = 'plugins';

const sha256File = (abs) => createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

/** 插件目录里的全部文件（相对路径，posix 分隔），不跟随也不列出符号链接。 */
export function listPluginFiles(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}

/**
 * 装载一个官方插件根目录。
 *
 * 失败**不抛**：一条 `{ pack, code, reason }`（与 `dropUnavailablePreDispatchPacks` 的输入同形），
 * 由调用方按同一条纪律把整包裁掉。
 * @param {string} root 插件根（每个子目录一个插件）
 * @param {{ log?: any }} [opts]
 * @returns {{ present: boolean, plugins: Array<{ id: string, dir: string, manifest: object, descriptor: object, hash: string, files: Array<{path:string,hash:string}> }>, errors: Array<{pack:string,code:string,reason:string}> }}
 */
export function loadOfficialPlugins(root, { log = null } = {}) {
  const plugins = [];
  const errors = [];
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code !== 'ENOENT') log?.warn?.(`[official] cannot read ${root}: ${e.message}`);
    return { present: false, plugins, errors: errors.map(alignFailure) };
  }
  for (const entry of dirents.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, OFFICIAL_PLUGIN_MANIFEST);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      errors.push({ pack: entry.name, code: 'OFFICIAL_BAD_MANIFEST', reason: `${OFFICIAL_PLUGIN_MANIFEST} is missing or not valid JSON (${e && e.message ? e.message : e})` });
      continue;
    }
    const { descriptor, issues } = fromOfficialManifest(raw);
    if (!descriptor) {
      errors.push({ pack: entry.name, code: issues[0].code, reason: issues[0].reason });
      log?.warn?.(`[official] ${entry.name}: ${issues[0].reason}`);
      continue;
    }
    if (descriptor.id !== entry.name) {
      errors.push({ pack: entry.name, code: 'OFFICIAL_ID_MISMATCH', reason: `manifest "id" (${JSON.stringify(descriptor.id)}) must equal the plugin directory name (${JSON.stringify(entry.name)})` });
      continue;
    }
    let files;
    try {
      files = listPluginFiles(dir).map((rel) => ({ path: rel, hash: sha256File(path.join(dir, rel)) }));
    } catch (e) {
      errors.push({ pack: entry.name, code: 'OFFICIAL_UNREADABLE', reason: `plugin files could not be read: ${e && e.message ? e.message : e}` });
      continue;
    }
    // 内容摘要回填进**装载器自己**的描述符（结构冻结 ⇒ 新对象）：装载器的输出必须自洽，
    // 不能依赖下游（`describePacks` 也会回填，但那只覆盖「程序化构造」那条路）。
    const hash = modManifestDigest(files);
    plugins.push({ id: descriptor.id, dir, manifest: raw, descriptor: Object.freeze({ ...descriptor, contentDigest: hash }), hash, files });
  }
  return { present: true, plugins, errors: errors.map(alignFailure) };
}
