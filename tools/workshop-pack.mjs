#!/usr/bin/env node
// tools/workshop-pack.mjs — 把工坊包导出成一个 .zip、从 .zip 装回来、以及列出所有包。
//
// 为什么需要它：在此之前，一个包**只能靠手抄目录**交给别人（docs/WORKSHOP.md §1 的包结构是一堆文件），
// 而 `pack.json.support`（§2.1 的助战声明）只能手写 JSON。这个工具和编辑器的「包管理」页共用同一批函数
// —— 导入的路径、校验的规则、写入的字节全都只有一份实现，所以 CLI 与图形界面不可能给出不同结论。
//
// 用法：
//   node tools/workshop-pack.mjs export <packId> [--workshop <root>] [--out <file.zip>]
//   node tools/workshop-pack.mjs import <file.zip> [--workshop <root>] [--force] [--json]
//   node tools/workshop-pack.mjs list   [--workshop <root>] [--json]
//
// 归档布局：`pack.json` 与包内其它文件（含 `assets/**`）都在 **zip 根**，所以「这个 zip 就是这个包」。
// 本模块导出的函数同时被 editor/server.mjs 使用（详见各函数上的注释）。
//
// 退出码：0 成功，1 拒绝（坏归档 / 包已存在 / 校验不过），2 用法错误。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { normalizePackManifest, normalizeContentFile, workshopSupportEntries, WORKSHOP_CONTENT_FILES } from '../shared/workshop.js';
import { loadWorkshop, WORKSHOP_DIR } from '../server/workshop.js';
import { normalizeSupportConfig } from '../shared/support.js';
import { zipWrite, zipRead, ZIP_LIMITS } from '../shared/zip.js';

export { WORKSHOP_DIR, ZIP_LIMITS };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
/** 默认的服务端助战配置：卡池的最终归属地（docs/WORKSHOP.md §2.1）。 */
export const SUPPORT_FILE = path.join(DATA_DIR, 'support.json');

/** 包 id 的字符集与 shared/workshop.js 的 PACK_ID_RE 一致（它必须等于目录名，也是 URL 的一段）。 */
const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** `pack.json.support` 里 id 的字符集：与 shared/workshop.js 的 RECORD_ID_RE 相同，不另立一份。 */
const SUPPORT_ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;
/** 一个包目录里最多读多少个文件（`assets/**` 一起算）。真实包：几百个；失控的目录：不再往下走。 */
const MAX_PACK_FILES = 20000;

// ---- 错误：CLI 与编辑器共用的 status 约定 ---------------------------------------------------------------------------
//
// `status` 就是 HTTP 状态码的语义，也是 CLI 的退出码来源：400 系列 = 拒绝（exit 1），其余 = 内部错误。

/** 拒绝：归档坏了、包已存在、清单校验不过 —— CLI 退出码 1，编辑器 4xx。 */
export const refuse = (message, status = 400) => Object.assign(new Error(message), { status, refused: true });
/** 用法/请求本身不成立：CLI 退出码 2，编辑器 400。 */
export const usageError = (message) => Object.assign(new Error(message), { status: 400, usage: true });
/** 找不到：编辑器 404，CLI 也算拒绝（exit 1）。 */
export const notFound = (message) => Object.assign(new Error(message), { status: 404, refused: true });

/** 字节 → 人类可读（错误信息里说「几 MB」比说「67108864 字节」有用得多）。 */
export const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** 路径是否就位于 `parent` 之内（不是 `parent` 本身）。第二道防线：zipReader 已经拒过一次遍历名。 */
function inside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 一个条目的名字能否落到磁盘上。`zipRead` 已经拒绝过一遍（它要决定整个归档读不读），这里是**第二道防线**：
 * 解压路径自己再拒绝一次，因为「只靠上游的检查」正是遍历漏洞的成因。
 */
export function assertEntryName(name) {
  if (typeof name !== 'string' || !name) throw refuse(`归档里有一个空文件名`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw refuse(`归档里的 "${name}" 是绝对路径`);
  if (name.includes('\\')) throw refuse(`归档里的 "${name}" 含反斜杠`);
  if (name.split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) {
    throw refuse(`归档里的 "${name}" 含 . / .. / 空路径段`);
  }
}

// ---- 读一个包目录 -------------------------------------------------------------------------------------------------

/**
 * Files a pack directory holds, as zip entries would name them. Recursive, sorted by name (so the archive is
 * reproducible byte for byte), bounded by MAX_PACK_FILES so a runaway directory cannot eat memory.
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function packFilesRecursive(packDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) { walk(abs, relPath); continue; }
      if (!st.isFile()) continue;
      if (out.length >= MAX_PACK_FILES) throw refuse(`这个包的文件太多了（超过 ${MAX_PACK_FILES} 个），拒绝导出`);
      out.push({ name: relPath, data: fs.readFileSync(abs) });
    }
  };
  walk(packDir, '');
  return out;
}

/**
 * 读一个包目录，**不看 pack.json 的 content**：磁盘上有什么就读什么。
 *
 * 为什么这样读：一个刚被导入的包，如果它的 `pack.json.content` 漏写了一个数据文件，`loadWorkshop()`
 * （严格按 content 读）就看不到那个文件 —— 于是一个本该合法的包会被判成「这个包没有这个干员」，
 * 而用户什么都没做错。磁盘才是事实来源；`content` 的严格性由 `tools/workshop-validate.mjs` 负责报告。
 *
 * @returns {{ id: string, dir: string, manifest: any|null, files: Record<string, Record<string, object>>, hasAssets: boolean,
 *   checked: ReturnType<typeof normalizePackManifest>|null, loadErrors: Array<{ file: string, reason: string }> }}
 */
export function readPackDir(packDir, id = path.basename(packDir)) {
  const manifestPath = path.join(packDir, 'pack.json');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }
  const hasAssets = fs.existsSync(path.join(packDir, 'assets'));
  const checked = manifest === null ? null : normalizePackManifest(manifest, id, { hasAssets });
  /** @type {Record<string, Record<string, object>>} */
  const files = {};
  const loadErrors = [];
  for (const file of WORKSHOP_CONTENT_FILES) {
    const filePath = path.join(packDir, `${file}.json`);
    if (!fs.existsSync(filePath)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      loadErrors.push({ file, reason: e.message });
      continue;
    }
    const content = normalizeContentFile(file, json);
    if (!content.ok) { loadErrors.push({ file, reason: content.detail }); continue; }
    files[file] = content.records;
  }
  return { id, dir: packDir, manifest, files, hasAssets, checked, loadErrors };
}

/** 一个包目录是否存在（含可读的 pack.json 这个最低要求）。 */
export function findPackDir(root, packId) {
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) throw usageError(`工坊包 id 不合法："${String(packId)}"（字母／数字开头，只能是字母、数字、下划线和短横线，≤32）`);
  const dir = path.join(root, packId);
  if (!fs.existsSync(path.join(dir, 'pack.json'))) throw notFound(`工坊包 "${packId}" 不存在（${dir} 下没有可读的 pack.json）`);
  return dir;
}

// ---- 导出 ---------------------------------------------------------------------------------------------------------

/**
 * 导出一个包：`pack.json` 与包内每个文件（含 `assets/**`）都在 zip 根，条目按名字排序、时间戳固定，
 * 所以同样的输入得到同样的字节。
 * @param {string} root 工坊根目录
 * @param {string} packId
 * @returns {{ id: string, entries: number, bytes: number, buffer: Buffer }}
 */
export function exportPack(root, packId, { limits = ZIP_LIMITS } = {}) {
  const dir = findPackDir(root, packId);
  const files = packFilesRecursive(dir);
  if (!files.some((f) => f.name === 'pack.json')) throw refuse(`工坊包 "${packId}" 没有 pack.json，无法导出`);
  // 导出前用加载器的规则过一遍：导出一个加载器会整包丢掉的包，等于把一个坏包发给别人
  const pack = readPackDir(dir, packId);
  if (!pack.checked || !pack.checked.ok) {
    throw refuse(`工坊包 "${packId}" 的 pack.json 不合法（${pack.checked ? pack.checked.error : 'unreadable'}）：${pack.checked ? pack.checked.detail : '无法解析'}`);
  }
  const buffer = zipWrite(files);
  // 导出的唯一用途就是给别人装，所以要在这里就挡住「装不回去的包」：`zipRead` 对归档字节与解开后总量
  // 都有上限，一个超过它的包导出得出来、却**永远装不回去**（CLI 与编辑器都会拒），这台机器上看不出任何问题。
  const rawTotal = files.reduce((n, f) => n + f.data.length, 0);
  if (buffer.length > limits.maxTotalBytes) {
    throw refuse(`这个包导出后有 ${mb(buffer.length)}，超过 ${mb(limits.maxTotalBytes)} 的导入上限：装它的人会直接失败。`
      + '把包拆小（例如只留需要的语音），或者直接整目录拷贝 workshop/' + packId + ' 分发。');
  }
  if (rawTotal > limits.maxTotalBytes) {
    throw refuse(`这个包解开后有 ${mb(rawTotal)}，超过 ${mb(limits.maxTotalBytes)} 的导入上限：装它的人会直接失败。`
      + '把包拆小（例如只留需要的语音），或者直接整目录拷贝 workshop/' + packId + ' 分发。');
  }
  return { id: packId, entries: files.length, bytes: buffer.length, buffer };
}

// ---- 导入 ---------------------------------------------------------------------------------------------------------

/** 归档里清单所在的前缀：'' 表示 pack.json 就在根，否则是那唯一的顶层目录。 */
function manifestPrefix(names) {
  if (names.includes('pack.json')) return '';
  const tops = new Set();
  for (const name of names) tops.add(name.split('/')[0]);
  const dirs = [...tops].filter((t) => names.includes(`${t}/pack.json`));
  if (dirs.length === 1 && tops.size === 1) return `${dirs[0]}/`;
  if (dirs.length > 1) throw refuse(`归档里有多个顶层目录带 pack.json（${dirs.join('、')}）：无法判断哪个是包`);
  throw refuse('归档里没有 pack.json（既不在根目录，也没有唯一的顶层目录包含它）');
}

/**
 * 把一份 zip 装到 `<root>/<packId>/`。
 *
 * 三步，顺序是有意的：
 *   1. 解压到 `<root>/.pack-import-XXXX/`（**同一个卷**，所以第 3 步是原子 rename 而不是跨盘拷贝）；
 *   2. 在临时目录里校验清单（`normalizePackManifest`，与加载器同一个函数）；
 *   3. 只有前两步都过了，才把它移到最终位置。
 * 所以一个坏归档、一个恶意归档、一个校验不过的包，**永远不会在 workshop/ 里留下半个包**。
 *
 * @param {{ root: string, buffer: Buffer, force?: boolean }} opts
 * @returns {{ id: string, dir: string, files: number, bytes: number, content: string[], voiceLines: number,
 *   support: string[], skippedDirs: string[], manifest: object }}
 */
export function installZip({ root, buffer, force = false }) {
  const read = zipRead(buffer);
  if (!read.ok) throw refuse(`这个 zip 读不了：[${read.error}] ${read.detail}`);
  if (!read.entries.length) throw refuse('这个 zip 里没有任何文件');
  const prefix = manifestPrefix(read.entries.map((e) => e.name));

  fs.mkdirSync(root, { recursive: true });
  // 临时目录放在工坊根下（点开头，loadWorkshop 会忽略它）：同一个卷才能 rename，且失败时只需删一个目录
  const stagingRoot = fs.mkdtempSync(path.join(root, '.pack-import-'));
  const packDir = path.join(stagingRoot, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  try {
    let bytes = 0;
    for (const entry of read.entries) {
      if (prefix && !entry.name.startsWith(prefix)) continue; // 顶层目录之外的散文件不属于这个包
      assertEntryName(entry.name); // 第二道防线（zipRead 已拒过一次）
      const rel = prefix ? entry.name.slice(prefix.length) : entry.name;
      if (!rel) continue; // 前缀本身（一个目录条目）没有内容
      const abs = path.join(packDir, ...rel.split('/'));
      if (!inside(packDir, abs)) throw refuse(`归档里的 "${entry.name}" 会写到包目录之外`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.data);
      bytes += entry.data.length;
    }

    // 校验清单：与加载器同一个函数、同一个 hasAssets 判断，所以「能装上」就等于「加载器会接受它的格式」
    const manifestPath = path.join(packDir, 'pack.json');
    if (!fs.existsSync(manifestPath)) throw refuse('归档里没有 pack.json（解压后仍找不到）');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw refuse(`pack.json 不是合法 JSON：${e.message}`);
    }
    const hasAssets = fs.existsSync(path.join(packDir, 'assets'));
    const checked = normalizePackManifest(raw, '', { hasAssets });
    if (!checked.ok) throw refuse(`pack.json 校验不过（${checked.error}）：${checked.detail}`);
    const packId = checked.pack.id;
    if (!PACK_ID_RE.test(packId)) throw refuse(`pack.json 的 id "${packId}" 不是合法的工坊包 id`);

    const target = path.join(root, packId);
    if (fs.existsSync(target) && !force) {
      throw refuse(`工坊包 "${packId}" 已经存在：要覆盖请加 --force（编辑器里是 ?force=1）`);
    }
    commitDir(target, packDir, force);
    const pack = readPackDir(target, packId);
    return {
      id: packId,
      dir: target,
      files: read.entries.filter((e) => !e.name.endsWith('/')).length,
      bytes,
      content: checked.pack.content,
      voiceLines: countVoiceLines(checked.pack.voices),
      support: checked.pack.support,
      skippedDirs: read.skippedDirs,
      manifest: raw,
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/** 把一个已经校验过的目录搬到最终位置。force 时先把旧的挪开，**不删** —— 新包搬进去之后才清理。 */
function commitDir(target, source, force) {
  const parent = path.dirname(target);
  if (!fs.existsSync(target)) {
    fs.renameSync(source, target);
    return;
  }
  // 先把旧目录改名到一个点开头的同级目录（同一个卷 → 原子），失败时 rename 会抛，不会留下半个包
  const displaced = fs.mkdtempSync(path.join(parent, '.pack-replaced-'));
  const holder = path.join(displaced, 'old');
  fs.renameSync(target, holder);
  try {
    fs.renameSync(source, target);
  } catch (e) {
    // 新包没搬过去：把旧的放回去，workshop/ 回到操作之前的样子
    try { fs.renameSync(holder, target); } catch { /* 放不回去就只能报错，至少把原因说出来 */ }
    throw e;
  } finally {
    fs.rmSync(displaced, { recursive: true, force: true });
  }
}

const countVoiceLines = (voices) => Object.values(voices ?? {}).reduce((n, slots) => n + Object.values(slots ?? {}).reduce((m, files) => m + files.length, 0), 0);

// ---- 助战声明（pack.json.support） ---------------------------------------------------------------------------------

/**
 * 读一个包的助战状态。**阶永远从记录推导**（`workshopSupportEntries`，与加载器/校验器同一份规则），
 * 页面只显示它，不接受手输的阶 —— 手写阶的下场是「写错了但没人报错、该干员静默不可选」。
 *
 * @param {string} root 工坊根
 * @param {string} packId
 * @param {{ supportFile?: string|null }} [opts] 传 supportFile 才会去读 `data/support.json`（卡池归属）
 */
export function readPackSupport(root, packId, { supportFile = null } = {}) {
  const dir = findPackDir(root, packId);
  const pack = readPackDir(dir, packId);
  // 只有**本包自己新增**的干员能进池：别人的干员（官方或另一个包的）记 SUPPORT_FOREIGN_OPERATOR
  const owned = Object.keys(pack.files.chess ?? {});
  const raw = Array.isArray(pack.manifest?.support) ? pack.manifest.support : [];
  /** @type {string[]} */
  const declared = [];
  /** @type {Array<{ id: string, code: string, reason: string }>} */
  const problems = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !SUPPORT_ID_RE.test(id)) {
      problems.push({ id: String(id), code: 'SUPPORT_BAD_ID', reason: `"${String(id)}" 不是合法的干员 id（字母数字与 _ - . :，≤64）` });
      continue;
    }
    if (!declared.includes(id)) declared.push(id);
    if (!owned.includes(id)) {
      // shared/workshop.js 会以 SUPPORT_FOREIGN_OPERATOR 整条拒绝：卡池是安装方的规则，包不能改
      problems.push({ id, code: 'SUPPORT_FOREIGN_OPERATOR', reason: `"${id}" 不是这个包自己新增的干员，进不了助战卡池` });
    }
  }
  // 与加载器逐字一致：同一个函数、同一个 { chess } 视图，所以编辑器不可能与加载器给出不同结论
  const { entries, errors } = workshopSupportEntries({ chess: pack.files.chess ?? {} }, [{ id: packId, files: pack.files, support: declared }]);
  const operators = owned
    .filter((id) => !pack.files.chess[id]?.isGolden)
    .map((id) => ({
      id,
      name: pack.files.chess[id]?.name ?? id,
      tier: Number.isInteger(pack.files.chess[id]?.tier) ? pack.files.chess[id].tier : null,
      selected: declared.includes(id),
      entry: entries.find((e) => e.id === id) ?? null,
    }))
    .sort((a, b) => ((a.tier ?? 99) - (b.tier ?? 99)) || a.id.localeCompare(b.id));

  const cfg = supportFile && fs.existsSync(supportFile) ? normalizeSupportConfig(JSON.parse(fs.readFileSync(supportFile, 'utf8'))) : null;
  return {
    pack: packId,
    // 清单里写的顺序（去重）；页面按这个顺序勾选
    support: declared.sort(),
    // 加载器真正会放进卡池的（阶由记录推导，这里永远不接受手写的阶）
    derived: entries.filter((e) => e.pack === packId).map((e) => ({ id: e.id, tier: e.tier })),
    errors: [...problems, ...errors.map((e) => ({ code: e.code, id: e.id, reason: e.reason }))],
    operators,
    // 卡池的最终归属地：data/support.json。`"workshop": false` 会忽略所有包的助战声明
    workshop: cfg ? cfg.pool : null,
    enabled: cfg ? cfg.enabled : null,
  };
}

/**
 * 写一个包的 `pack.json.support` —— **只动这一个字段**。
 *
 * 与第七页（语音）写 `voices` 的规则完全一样：其余字段、它们的顺序、两空格缩进原样保留，新的 `support`
 * 追加在末尾，而且**绝不**给包补一条它没声明过的 `content`（写 support 不是声明数据文件）。
 * 只允许本包自己新增的干员（否则加载器会以 SUPPORT_FOREIGN_OPERATOR 整条丢掉，写了等于没写）。
 *
 * @param {string} root 工坊根
 * @param {string} packId
 * @param {unknown} ids
 * @returns {{ pack: string, support: string[], changed: boolean, derived: Array<{id: string, tier: number}>, errors: any[] }}
 */
export async function writePackSupport(root, packId, ids) {
  // 结构错误与 shared/workshop.js 的码字一一对应：SUPPORT_BAD_SHAPE / SUPPORT_BAD_ID / SUPPORT_FOREIGN_OPERATOR
  if (!Array.isArray(ids)) throw refuse(`support 必须是数组（这个包自己新增、应当进助战卡池的干员 id）`);
  const seen = new Set();
  /** @type {string[]} */
  const clean = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !SUPPORT_ID_RE.test(id)) {
      throw refuse(`SUPPORT_BAD_ID："${String(id)}" 不是合法的干员 id（字母数字与 _ - . :，≤64）`);
    }
    if (!seen.has(id)) { seen.add(id); clean.push(id); }
  }
  const dir = findPackDir(root, packId);
  const pack = readPackDir(dir, packId);
  const owned = new Set(Object.keys(pack.files.chess ?? {}));
  const foreign = clean.filter((id) => !owned.has(id));
  if (foreign.length) {
    throw refuse(`SUPPORT_FOREIGN_OPERATOR：${foreign.join('、')} 不是这个包自己新增的干员（卡池是安装方的规则，包只能声明自己的干员）`);
  }
  const manifest = pack.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw refuse(`工坊包 "${packId}" 的 pack.json 不可读`);

  const previous = Array.isArray(manifest.support) ? manifest.support : [];
  const next = { ...manifest };
  if (clean.length) next.support = clean; else delete next.support;
  // 内容没变就不写：写一次会按 2 空格重新排版，而作者可能有自己的排版（`support` 键是否存在也算变化）
  const sameKey = Object.hasOwn(manifest, 'support');
  const changed = clean.length !== previous.length || !clean.every((id, i) => previous[i] === id) || (clean.length > 0) !== sameKey;
  if (changed) await fsp.writeFile(path.join(dir, 'pack.json'), `${JSON.stringify(next, null, 2)}\n`);
  const state = readPackSupport(root, packId, { supportFile: null });
  return { pack: packId, support: state.support, changed, derived: state.derived, errors: state.errors };
}

// ---- 列出 ---------------------------------------------------------------------------------------------------------

/** 一个包的摘要行：id / 名称 / 版本 / 内容文件 / 语音条数 / 助战条数，外加它的校验结论。 */
export function packSummary(root, packId, loaded = null, { supportFile = null } = {}) {
  const pack = readPackDir(path.join(root, packId), packId);
  const manifest = pack.manifest ?? {};
  const entry = loaded ? loaded.packs.find((p) => p.id === packId) ?? null : null;
  const err = loaded ? loaded.errors.find((e) => e.pack === packId) ?? null : null;
  const where = entry ? 'loaded' : 'refused';
  const content = Array.isArray(manifest.content) ? manifest.content : [];
  const voiceLines = countVoiceLines(manifest.voices);
  const support = Array.isArray(manifest.support) ? manifest.support : [];
  let supportDerived = [];
  if (support.length && pack.files.chess) {
    supportDerived = workshopSupportEntries({ chess: pack.files.chess }, [{ id: packId, files: pack.files, support }]).entries.map((e) => ({ id: e.id, tier: e.tier }));
  }
  const cfg = supportFile && fs.existsSync(supportFile) ? normalizeSupportConfig(JSON.parse(fs.readFileSync(supportFile, 'utf8'))) : null;
  // 磁盘上有、`content` 却没声明的数据文件：`loadWorkshop()` 严格按 `content` 读，所以这些文件会被**静默忽略**
  // —— 干员进不了商店、地图进不了轮换，而加载器还会说这个包「没问题」。`readPackDir` 故意读全盘（见它的注释），
  // 正是为了让这里能把这份差异报出来，而不是靠作者自己发现。
  const undeclared = Object.keys(pack.files).filter((f) => !content.includes(f)).sort();
  return {
    id: packId,
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : packId,
    version: typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0',
    author: typeof manifest.author === 'string' ? manifest.author : null,
    license: typeof manifest.license === 'string' ? manifest.license : null,
    hasAssets: pack.hasAssets,
    content,
    contentFiles: content.length,
    undeclared,
    voiceLines,
    support,
    supportDerived,
    // 校验结论：加载器自己的答案（loaded / refused + 原因），不是第二套判断
    status: where,
    reason: err ? err.reason : null,
    syntaxOk: pack.checked ? pack.checked.ok : false,
    syntaxError: pack.checked && !pack.checked.ok ? { code: pack.checked.error, detail: pack.checked.detail } : null,
    // 安装方的总开关：`data/support.json` 里 `"workshop": false` 时，所有包的助战声明都被忽略
    supportEnabled: cfg ? cfg.enabled : null,
  };
}

/** 枚举工坊根下的包（跳过点开头的目录，与 loadWorkshop 一致）。 */
export function listPackIds(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

// ---- CLI ----------------------------------------------------------------------------------------------------------

/** CLI 的中文行；与 tools/workshop-validate.mjs 的语气一致（直接说结论与下一步）。 */
const line = (...parts) => console.log(parts.filter((p) => p !== null && p !== undefined && p !== '').join(' '));

function cliList(root, { json }) {
  const loaded = loadWorkshop(root, { log: { info() {}, warn() {}, error() {}, debug() {} } });
  const packs = listPackIds(root).map((id) => packSummary(root, id, loaded, { supportFile: SUPPORT_FILE }));
  if (json) { console.log(JSON.stringify({ workshop: root, packs }, null, 2)); return; }
  line(`workshop root: ${root}`);
  if (!loaded.present) line('  （目录不存在 —— 没有包）');
  if (!packs.length) line('  no packs found');
  for (const p of packs) {
    const bits = [`内容 ${p.content.length ? p.content.join('/') : '（无）'}`];
    if (p.voiceLines) bits.push(`语音 ${p.voiceLines} 条`);
    if (p.support.length) {
      const derived = p.supportDerived.map((e) => `${e.id}→阶${e.tier}`).join(' ');
      bits.push(`助战 ${p.support.length} 个${derived ? `（${derived}）` : ''}`);
    }
    line(`pack ${p.id}`, `"${p.name}"`, `v${p.version}`, `·`, bits.join(' · '), `·`, p.status === 'loaded' ? 'VALID' : `REFUSED（${p.reason}）`);
    if (p.undeclared.length) {
      line(`  ! 盘上有 ${p.undeclared.map((f) => `${f}.json`).join('、')}，但 pack.json 的 content 没声明 —— 加载器会忽略这些文件`);
      line(`    修法：在 pack.json 的 content 里补上 ${p.undeclared.join('、')}（编辑器里重新保存一次对应内容也会自动补）`);
    }
  }
  line(`\n${packs.length} 个包`);
}

function cliExport(root, packId, { out }) {
  const r = exportPack(root, packId);
  const file = path.resolve(out ?? path.join(process.cwd(), `${packId}.zip`));
  fs.writeFileSync(file, r.buffer);
  line(`已导出 ${r.id}：${file}`);
  line(`  ${r.entries} 个文件，${r.bytes} 字节`);
}

function cliImport(root, file, { force, json }) {
  const target = path.resolve(file);
  let buffer;
  try {
    buffer = fs.readFileSync(target);
  } catch {
    throw refuse(`读不到文件：${target}`);
  }
  const r = installZip({ root, buffer, force });
  if (json) { console.log(JSON.stringify(r, null, 2)); return; }
  line(`已安装 ${r.id} → ${r.dir}`);
  line(`  ${r.files} 个文件，${r.bytes} 字节；内容 ${r.content.length ? r.content.join('/') : '（无）'}`
    + `${r.voiceLines ? `，语音 ${r.voiceLines} 条` : ''}${r.support.length ? `，助战 ${r.support.join('、')}` : ''}`);
  if (r.skippedDirs.length) line(`  （跳过了 ${r.skippedDirs.length} 个目录条目）`);
}

const USAGE = `用法：
  node tools/workshop-pack.mjs export <packId> [--workshop <root>] [--out <file.zip>]
  node tools/workshop-pack.mjs import <file.zip> [--workshop <root>] [--force] [--json]
  node tools/workshop-pack.mjs list   [--workshop <root>] [--json]`;

/**
 * 跑 CLI。导出成函数是为了测试可以直接调用（不必 spawn 一个进程）。
 * @param {string[]} argv
 */
export function runCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') { console.log(USAGE); return 0; }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        workshop: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
  } catch (e) {
    throw usageError(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const root = path.resolve(values.workshop ?? WORKSHOP_DIR);
  const quiet = !values.json;

  if (command === 'list') {
    if (positionals.length) throw usageError(`list 不接受额外参数：${positionals.join(' ')}\n${USAGE}`);
    cliList(root, { json: values.json === true });
    return 0;
  }
  if (command === 'export') {
    if (positionals.length !== 1) throw usageError(`export 需要一个包 id\n${USAGE}`);
    cliExport(root, positionals[0], { out: values.out });
    return 0;
  }
  if (command === 'import') {
    if (positionals.length !== 1) throw usageError(`import 需要一个 .zip 文件\n${USAGE}`);
    cliImport(root, positionals[0], { force: values.force === true, json: values.json === true });
    return 0;
  }
  void quiet;
  throw usageError(`未知子命令 "${command}"\n${USAGE}`);
}

// 只在作为脚本运行时才跑 CLI（被 editor/server.mjs import 时不能执行）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (e) {
    // 拒绝（坏归档 / 包已存在 / 校验不过 / 没有这个包）= 1，用法错误 = 2；两种都必须留下人话，而不是堆栈
    const code = e && e.usage ? 2 : e && e.refused ? 1 : 2;
    console.error(`workshop-pack: ${e && e.message ? e.message : e}`);
    if (code === 2 && !(e && e.usage)) console.error(USAGE);
    process.exitCode = code;
  }
}
