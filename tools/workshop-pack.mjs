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

import { normalizePackManifest, normalizeContentFile, workshopSupportEntries, WORKSHOP_CONTENT_FILES, OVERRIDE_ENTRY_RE, playtestUnknownIds } from '../shared/workshop.js';
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
  // 试玩开关的名单必须点名本包真的有的 id：形状由 `normalizePackManifest` 判，成员资格只有读完 chess.json 才知道
  // （与加载器 `server/workshop.js` 同一个 `playtestUnknownIds`）。不查这一条，一个写错的 id 就是静默无效。
  const playtestUnknown = checked && checked.ok
    ? playtestUnknownIds(checked.pack.playtest?.directToHand, checked.pack.overrides, Object.keys(files.chess ?? {}))
    : [];
  return { id, dir: packDir, manifest, files, hasAssets, checked, loadErrors, playtestUnknown };
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
      // 记录自己带的那个开关（非覆盖模式走这条路：`deriveChessRecord` 写 `directToHand: true`）。
      // 包页把它和 `pack.json.playtest.directToHand` 分开列 —— 两者在引擎里是并集（见 phases.js）。
      directToHand: pack.files.chess[id]?.directToHand === true,
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

// ---- 元数据 (pack.json 的标量字段 + overrides) --------------------------------------------------------------------
//
// 这一块补的是**唯一一处仍然要求作者手改 pack.json 的地方**。`license` 最要命：一个有 `assets/` 的包（语音、图标、
// 外观素材都要它）不声明 license 就会被加载器整包拒绝（ASSETS_NEED_LICENSE），而编辑器的三个素材端点都会拒绝写入
// —— 页面上却只能告诉作者「去 pack.json 里声明一个」。`overrides` 同理：它是覆盖官方记录的唯一开关（除盟约那页
// 会自动写 `bonds:`），作者想覆盖一个官方干员/装备/怪物时只能手写。业主的硬约束是**任何写进 pack.json 的东西都要
// 能在界面上增删改**，这一块就是那条约束的出口。

/** 界面上可以编辑的元数据字段。`id` **不在**里面：它必须等于目录名，改它等于换一个包。 */
export const PACK_META_FIELDS = Object.freeze(['name', 'version', 'author', 'license', 'description', 'gameVersion']);

/** license 的常见取值（输入框的候选）：加载器只要求非空字符串，所以作者也可以填任何别的东西。 */
export const LICENSE_CHOICES = Object.freeze(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'see assets/LICENSE.txt']);

/** 一个元数据字段的长度上限。没有这条规则，一个 10 万字的 name 能让整页包列表没法看。 */
const META_MAX_LEN = 200;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 一个包的元数据与 `overrides` 状态。**「在用」与「官方有没有这条」的判断只有这一份**：写入端写完就调它，
 * 所以回给页面的结论与页面上看到的永远是同一套。
 *
 * `inUse` = 本包真的带了一条同 id 的记录（`overrides` 声明**只在**包带了那条记录时才有作用：加载器是在
 * 「官方已有这个 id、包又带了一条同 id 记录」这一步才去查 `overrides`）。`official` = 官方数据里有这个 id。
 * 两者都不是「错误」：没人用的声明只是永远不生效，界面把它标出来并提供删除，从不阻止写入 —— 业主的规则是
 * **任何写进 pack.json 的条目都要能删掉**，而不是「只让你删在用的那条」。
 *
 * @param {string} root 工坊根
 * @param {string} packId
 * @param {{ isOfficial?: ((file: string, id: string) => boolean)|null }} [opts] `isOfficial` 由调用方给（编辑器有
 *   官方数据表；CLI 不判断官方那一半，`official` 就是 null）
 */
export function readPackMeta(root, packId, { isOfficial = null } = {}) {
  const dir = findPackDir(root, packId);
  const pack = readPackDir(dir, packId);
  const manifest = isPlainObject(pack.manifest) ? pack.manifest : {};
  /** @type {Record<string, string|null>} */
  const meta = {};
  for (const field of PACK_META_FIELDS) {
    meta[field] = typeof manifest[field] === 'string' && manifest[field] ? manifest[field] : null;
  }
  const declared = Array.isArray(manifest.overrides) ? manifest.overrides : [];
  const overrides = [];
  for (const raw of declared) {
    if (typeof raw !== 'string') continue;
    const m = OVERRIDE_ENTRY_RE.exec(raw);
    // 形状不合法的声明加载器直接丢掉（normalizePackManifest 的过滤）。这里也不把它当成一条能删的声明 ——
    // 删不掉的那条正是「只能手改」的老问题，所以写入端宁可拒绝写进去，也不留下它。
    if (!m) continue;
    const [, file, id] = m;
    overrides.push({
      entry: raw,
      file,
      id,
      isContentFile: WORKSHOP_CONTENT_FILES.includes(file),
      inUse: Object.hasOwn(pack.files[file] ?? {}, id),
      official: isOfficial ? !!isOfficial(file, id) : null,
    });
  }
  return {
    pack: packId,
    meta,
    hasAssets: pack.hasAssets,
    overrides,
    // 试玩开关（`pack.json.playtest`）：声明原样给出，加上「这些 id 认不认识」的判罚 —— 界面照 `overrides` 的做法
    // 把陈旧/写错的条目**显示出来**，而不是让它静默无效（`PLAYTEST_UNKNOWN_CHESS`）。
    playtest: {
      directToHand: pack.checked && pack.checked.ok ? [...(pack.checked.pack.playtest?.directToHand ?? [])] : [],
      unknown: [...(pack.playtestUnknown ?? [])],
    },
    // 加载器会不会接受这个包（页面的横幅用；`issue` 是它拒绝时的码与原因）
    ok: pack.checked ? pack.checked.ok === true : false,
    issue: pack.checked && !pack.checked.ok ? { code: pack.checked.error, detail: pack.checked.detail } : null,
  };
}

/**
 * 写一个包的元数据（`PACK_META_FIELDS` 那几个）—— **只动传进来的键**。与 `writePackSupport` 同一条规则：其余字段、
 * 键序与两空格缩进原样保留，新键追加在末尾；`null` 或空串 = **删掉这个键**（加载器对这几个字段各有默认值，
 * 所以删掉是合法的，不是「清空成一个空字符串」）。
 *
 * 唯一被提前拒绝的是**清空一个有 `assets/` 的包的 license**：那会让加载器整包拒绝，而作者多半只是想把输入框清空
 * 再重填。与其写下一个坏包，不如当场说清为什么不行。（默认值缺失不是问题：`name`/`version` 删掉会退回 id 与
 * `0.0.0`，`author`/`license`/`description`/`gameVersion` 删掉就是「没声明」。）
 *
 * @returns {Promise<ReturnType<typeof readPackMeta> & { changed: boolean, applied: Record<string, string|null> }>}
 */
export async function writePackMeta(root, packId, patch, { isOfficial = null } = {}) {
  if (!isPlainObject(patch)) throw refuse('元数据必须是一个对象：{ name?, version?, author?, license?, description?, gameVersion? }');
  const keys = Object.keys(patch);
  if (!keys.length) throw refuse('没有要改的元数据字段');
  const unknown = keys.filter((k) => !PACK_META_FIELDS.includes(k));
  if (unknown.length) {
    throw refuse(`PACK_META_UNKNOWN_FIELD：${unknown.join('、')} 不是可编辑的元数据字段（可改的是 ${PACK_META_FIELDS.join('、')}）`);
  }
  const dir = findPackDir(root, packId);
  const pack = readPackDir(dir, packId);
  const manifest = pack.manifest;
  if (!isPlainObject(manifest)) throw refuse(`工坊包 "${packId}" 的 pack.json 不可读`);

  const next = { ...manifest };
  /** @type {Record<string, string|null>} */
  const applied = {};
  for (const key of keys) {
    const raw = patch[key];
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
      delete next[key];
      applied[key] = null;
      continue;
    }
    if (typeof raw !== 'string') throw refuse(`META_BAD_VALUE：${key} 必须是字符串（或留空以删掉这个字段）`);
    const value = raw.trim();
    if (value.length > META_MAX_LEN) throw refuse(`META_BAD_VALUE：${key} 太长了（上限 ${META_MAX_LEN} 字符）`);
    next[key] = value;
    applied[key] = value;
  }
  // 只有「这一次改动把一个有 assets/ 的包的 license 清空」才拒绝：那是加载器的硬规则（ASSETS_NEED_LICENSE），
  // 而作者多半只是想把输入框清空再重填。**别的字段照写** —— 一个还没填 license 的包不该连名字都改不了。
  if (Object.hasOwn(patch, 'license') && !next.license && pack.hasAssets) {
    throw refuse('ASSETS_NEED_LICENSE：这个包有 assets/（语音/图标/外观素材），必须声明一个 license —— 不能清空它');
  }
  const changed = keys.some((k) => (typeof manifest[k] === 'string' && manifest[k] ? manifest[k] : null) !== (applied[k] ?? null));
  if (changed) await fsp.writeFile(path.join(dir, 'pack.json'), `${JSON.stringify(next, null, 2)}\n`);
  return { ...readPackMeta(root, packId, { isOfficial }), changed, applied };
}

/**
 * 写一个包的 `pack.json.overrides`（**整表替换**）—— 只动这一个字段，其余字段、键序与缩进原样保留。
 *
 * 允许任何形状合法的 `<文件>:<id>`，包括官方根本没有的 id、以及本包没有那条记录的 id：它们只是**不生效**，
 * 不是错误，而界面必须能删掉它们（否则作者又被自己写坏的一行锁在门外 —— 与图标清单同一条规矩）。
 * 真正会被拒绝的只有形状：正则与加载器同一份（`OVERRIDE_ENTRY_RE`），文件那一段必须是包能声明的数据文件。
 *
 * @param {unknown} list `"<文件>:<id>"` 的数组
 */
export async function writePackOverrides(root, packId, list, { isOfficial = null } = {}) {
  if (!Array.isArray(list)) throw refuse('overrides 必须是数组，每一项形如 "chess:chess_char_1_01_a"');
  /** @type {string[]} */
  const clean = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw refuse(`OVERRIDE_BAD_SHAPE：${JSON.stringify(raw)} 不是字符串`);
    const entry = raw.trim();
    const m = OVERRIDE_ENTRY_RE.exec(entry);
    if (!m) throw refuse(`OVERRIDE_BAD_SHAPE："${entry}" 不是 "<文件>:<id>" 的形状（例：chess:chess_char_1_01_a）`);
    if (!WORKSHOP_CONTENT_FILES.includes(m[1])) {
      throw refuse(`OVERRIDE_BAD_FILE："${m[1]}" 不是包能声明的数据文件（可用的是 ${WORKSHOP_CONTENT_FILES.join('、')}）`);
    }
    if (!clean.includes(entry)) clean.push(entry);
  }
  clean.sort();
  const dir = findPackDir(root, packId);
  const pack = readPackDir(dir, packId);
  const manifest = pack.manifest;
  if (!isPlainObject(manifest)) throw refuse(`工坊包 "${packId}" 的 pack.json 不可读`);
  const previous = Array.isArray(manifest.overrides) ? manifest.overrides : [];
  const next = { ...manifest };
  if (clean.length) next.overrides = clean; else delete next.overrides;
  // 与 writePackSupport 同一条：内容没变就不写盘（写一次会按 2 空格重新排版，作者可能有自己的排版）
  const sameKey = Object.hasOwn(manifest, 'overrides');
  const changed = clean.length !== previous.length || !clean.every((e, i) => previous[i] === e) || (clean.length > 0) !== sameKey;
  if (changed) await fsp.writeFile(path.join(dir, 'pack.json'), `${JSON.stringify(next, null, 2)}\n`);
  return { ...readPackMeta(root, packId, { isOfficial }), changed };
}

/**
 * 写一个包的 `pack.json.playtest.directToHand`（**整表替换**）—— 只动这一个字段，其余字段、键序与缩进原样保留。
 *
 * 与 `writePackOverrides` 同一条规矩：**形状**错了才拒（元素必须是合法 id、去重后排序），
 * 「这个 id 是不是真的属于这个包」**不在这里判** —— 那是加载器的事（`PLAYTEST_UNKNOWN_CHESS`）。
 * 理由是界面必须能把作者写坏/已经陈旧的条目**删掉**：写进 `pack.json` 的东西都要能在界面上删掉，
 * 否则一个手写的错 id 会让整个包起不来，而作者在界面里找不到任何能改的地方。
 *
 * 空名单 = 删掉 `playtest.directToHand` 这个键（与「没声明」同一件事，不留空壳）。
 *
 * @param {unknown} list chess 记录 id 的数组
 */
export async function writePackPlaytest(root, packId, list) {
  if (!Array.isArray(list)) throw refuse('playtest.directToHand 必须是数组，每一项是一个 chess 记录 id');
  /** @type {string[]} */
  const clean = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !SUPPORT_ID_RE.test(raw)) {
      throw refuse(`PLAYTEST_BAD_SHAPE：${JSON.stringify(raw)} 不是合法的 chess 记录 id`);
    }
    if (!clean.includes(raw)) clean.push(raw);
  }
  clean.sort();
  const dir = findPackDir(root, packId);
  const pack = readPackDir(dir, packId);
  const manifest = pack.manifest;
  if (!isPlainObject(manifest)) throw refuse(`工坊包 "${packId}" 的 pack.json 不可读`);
  const current = isPlainObject(manifest.playtest) ? manifest.playtest : {};
  const previous = Array.isArray(current.directToHand) ? current.directToHand : [];
  const next = { ...manifest };
  if (clean.length) next.playtest = { ...current, directToHand: clean };
  else if (Object.keys(current).length > 1) next.playtest = { ...current, directToHand: [] };
  else delete next.playtest;
  // 与 writePackSupport 同一条：内容没变就不写盘（写一次会按 2 空格重新排版，作者可能有自己的排版）
  const malformed = Object.hasOwn(manifest, 'playtest') && !isPlainObject(manifest.playtest);
  const changed = malformed || clean.length !== previous.length || !clean.every((e, i) => previous[i] === e);
  if (changed) await fsp.writeFile(path.join(dir, 'pack.json'), `${JSON.stringify(next, null, 2)}\n`);
  return { ...readPackMeta(root, packId), changed };
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
