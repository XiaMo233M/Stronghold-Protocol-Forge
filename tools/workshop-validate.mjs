#!/usr/bin/env node
// tools/workshop-validate.mjs — validate 创意工坊 packs against the format AND against the real engine
// (docs/WORKSHOP.md). This is the check an author runs, and the one an AI calls in a self-correction loop.
//
// Usage:
//   node tools/workshop-validate.mjs                      # every pack under workshop/
//   node tools/workshop-validate.mjs <dir>                # one pack directory, or a workshop root
//   node tools/workshop-validate.mjs --workshop <root>    # explicit pack root
//   node tools/workshop-validate.mjs --json               # machine-readable report
//
// It checks the layers cheapest-first: pack format → record semantics → the real engine → then one layer per content
// kind (kits, stages/maps, enemies/monsters, waves, items, a pack's voice lines, its item icons, its 外观素材
// (avatars / portraits / spine models) and its 助战 declarations), each
// re-deriving what the engine derives. Layer 3 is what catches a record that is syntactically valid but silently
// unplayable.
//
// Exit codes: 0 = no errors (warnings allowed), 1 = errors found, 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChessRecord, formatIssues } from '../shared/chessAuthoring.js';
import { loadWorkshop, loadWorkshopKits, WORKSHOP_DIR } from '../server/workshop.js';
import { validateStageRecord } from '../server/stageAuthoring.js';
import { validateEnemy } from '../shared/enemyAuthoring.js';
import { validateWave } from '../shared/waveAuthoring.js';
import { validateItem } from '../shared/itemAuthoring.js';
import { validateKit } from '../shared/kitAuthoring.js';
import { loadData } from '../server/data.js';
import { WORKSHOP_ASSET_TYPES } from '../server/index.js';
import { workshopSupportEntries, ART_TABLES } from '../shared/workshop.js';
import { atlasInfo } from './assets/atlas.mjs';
import { parseSkel } from './assets/skel.mjs';
import { roleAnimationNames } from './assets/anim-roles.mjs';
import { GameData } from '../server/match/gamedata.js';
import { toDataSource, isShopItem } from '../server/sim/simdata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const USAGE = `usage: node tools/workshop-validate.mjs [dir] [--workshop <root>] [--json]`;

function parseArgs(argv) {
  const out = { dir: null, workshop: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--workshop') { out.workshop = argv[++i]; if (out.workshop === undefined) throw new Error('--workshop needs a path'); }
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (out.dir === null) out.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

/** A pack directory carries pack.json; anything else is treated as a workshop root. */
function resolveRoots(dir) {
  if (dir === null) return { root: WORKSHOP_DIR, only: null };
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  return fs.existsSync(path.join(abs, 'pack.json')) ? { root: path.dirname(abs), only: path.basename(abs) } : { root: abs, only: null };
}

const officialChess = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'chess.json'), 'utf8'));
const OFFICIAL_IDS = new Set(Object.keys(officialChess));

/**
 * 「官方已有的装备图标 id」= 官方道具记录自己的 `iconId` / `trapId`。
 *
 * 为什么是这两个字段而不是 `data/items.json` 的键：客户端**不看**道具记录 id，它是拿
 * `public/js/assets.js itemIconUrl` 的 `item.iconId || item.trapId` 去查 `data/assets.json` 的 `items` 的
 * （shared/itemAuthoring.js 的 deriveItem 把 `iconId` 写成 `trapId`）。所以 `assets.items` 的键就是这批图标 id ——
 * 本仓库这份安装里两边逐条相同（59 个），而 `data/items.json` 的键（`chess_item_…`）一个都不在 `assets.items` 里，
 * 拿它当官方集合会把每一个合法的覆盖都误报成 warning。
 */
const OFFICIAL_ITEM_ICON_IDS = new Set(
  Object.values(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'items.json'), 'utf8')))
    .flatMap((rec) => (rec ? [rec.iconId, rec.trapId] : []))
    .filter((id) => typeof id === 'string' && id),
);

/**
 * 「官方已有的外观条目 id」= 官方素材清单 `data/assets.json` 那三张表的键（chars / enemies / tokens）。
 *
 * 与装备图标那条同一种做法：客户端是**按 id 查表**的 —— 干员读 `chars[chess 记录的 assets.spine]`，怪物与召唤物
 * 读 `enemies[key]` / `tokens[key]`。所以一个两边都没有的 id 不会报错，那张头像/模型只会永远不被用到。
 * assets.json 不存在（没跑过素材管线）时三张表都是空的：这一层只检查包自己写下的东西，不因此报错。
 */
const OFFICIAL_ASSETS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'assets.json'), 'utf8')); }
  catch { return {}; }
})();
const artTableIds = (table) => new Set(Object.keys((OFFICIAL_ASSETS && OFFICIAL_ASSETS[table]) || {}));
const OFFICIAL_ART_IDS = { chars: artTableIds('chars'), enemies: artTableIds('enemies'), tokens: artTableIds('tokens') };

/**
 * 一个 art 条目上**直接是路径**的字段，与 spine 在哪一层 —— 两者都直接读 `shared/workshop.js` 导出的 `ART_TABLES`，
 * 不在这里抄第二份（抄一份的下场是两处漂移：加载器开始收的字段校验器不查，或者反过来）。
 * `enemies.spineAliasOf` 与 `tokens.owner` 是原样抄的 id，不是路径，所以只取 `urls`。
 */
const ART_ENTRY_PATH_FIELDS = Object.fromEntries(Object.entries(ART_TABLES).map(([table, shape]) => [table, shape.urls]));
/** spine 在哪一层：chars 是 `spine.front` / `spine.back`，enemies / tokens 是扁平的 `spine`。 */
const ART_SPINE_NESTED_TABLES = new Set(Object.entries(ART_TABLES).filter(([, shape]) => shape.spine === 'sides').map(([table]) => table));

/** 一个包自己新增的干员 char id：本包 chess 记录自己的 `assets.spine` / `charId`（客户端就是按这个查 chars 的）。 */
function ownCharIds(pack) {
  const out = new Set();
  for (const rec of Object.values(pack.files.chess || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const spine = rec.assets && typeof rec.assets === 'object' ? rec.assets.spine : null;
    if (typeof spine === 'string' && spine) out.add(spine);
    if (typeof rec.charId === 'string' && rec.charId) out.add(rec.charId);
  }
  return out;
}

/** 一个包自己新增的召唤物 token id：本包 chess 记录里的 `tokens` 数组，以及本包 tokens.json 的键。 */
function ownTokenIds(pack) {
  const out = new Set(Object.keys(pack.files.tokens || {}));
  for (const rec of Object.values(pack.files.chess || {})) {
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.tokens)) continue;
    for (const t of rec.tokens) if (typeof t === 'string' && t) out.add(t);
  }
  return out;
}

/**
 * 一条记录该按**哪一份**判。
 *
 * 包自己的记录就是它本身。**声明过覆盖的官方 id 不是**：覆盖模式写的是一份**差量补丁**（DESIGN §28.3「逐字段
 * 补丁」——记录里只写要改的字段，其余字段仍是官方的），拿补丁当一条完整记录喂逐记录校验器，会得到几十条
 * `MISSING` / `BAD_*` 与 `OFFICIAL_ID_COLLISION`，而引擎实际看到的那一条是完全正常的。判错方向的代价是双向的：
 * 一份合法的覆盖包被 184 个 error 淹没（作者只能去猜哪些是真的），而真正的 `params` 过期（下面 items 层的那类）
 * 就混在这片噪声里没人看得见。
 *
 * 判据不是偏好，是仓库自己写下的契约 —— `docs/EDITOR.md`：「编辑器里能保存的内容，`tools/workshop-validate.mjs`
 * 一定也接受，反之亦然」。编辑器正是按**合并后**的记录判的（`editor/server.mjs` 的 `overrideBlockers()` 把已声明的
 * 覆盖从 officialIds 里去掉，再用 `loadData` 出来的那一份校验），所以这里照同一份判。
 *
 * @param {string} file 内容文件名（`chess` / `items` / `stages` / `enemies` / `waves`）
 * @param {string} id 记录 id
 * @param {object} rec 包里的那一条（覆盖模式下是差量补丁）
 * @param {{ declared: Set<string>, merged: Record<string, any>|null, officialIds: Set<string> }} ctx
 *   `declared` = 本包 `pack.json.overrides`；`merged` = `loadData(DATA_DIR, { workshopDir: root })`；`officialIds` =
 *   这一张表在官方数据里的 id 集合
 * @returns {{ rec: object, officialIds: Set<string> }} `officialIds` 已去掉「本包声明要覆盖」的那一条
 */
function judgeRecord(file, id, rec, { declared, merged, officialIds }) {
  if (!declared.has(`${file}:${id}`)) return { rec, officialIds };
  const table = merged && merged[file] ? merged[file] : null;
  const ids = new Set(officialIds);
  ids.delete(id);
  return { rec: table && table[id] ? table[id] : rec, officialIds: ids };
}

/**
 * Cross-record checks the per-record validator cannot see (the base/elite pair). Runs on the **judged** records (see
 * `judgeRecord`), so an override pair is judged as the merged pair the engine sees.
 */
function pairIssues(records, file) {
  const out = [];
  if (file !== 'chess') return out;
  for (const [id, rec] of Object.entries(records)) {
    const isGolden = rec.isGolden === true || /_b$/.test(id);
    const partner = isGolden ? rec.baseId : rec.goldenId;
    if (!partner) {
      out.push({ field: `${id}.${isGolden ? 'baseId' : 'goldenId'}`, code: 'NO_PARTNER', severity: 'error', message: `${isGolden ? 'elite' : 'normal'} record has no partner id` });
      continue;
    }
    if (!Object.hasOwn(records, partner) && !OFFICIAL_IDS.has(partner)) {
      out.push({
        field: `${id}.${isGolden ? 'baseId' : 'goldenId'}`, code: 'PARTNER_MISSING', severity: 'error',
        message: `partner "${partner}" is neither in this pack nor in the official data`,
        hint: isGolden ? 'the elite must point at its normal record' : 'add the elite record, or leave goldenId null',
      });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // `--workshop <root>` used to be parsed and documented but never read, so it silently validated the default
  // workshop/ directory and could print a green VALID for the wrong tree. It now wins over the positional argument.
  const { root, only } = resolveRoots(args.workshop ?? args.dir);
  const report = { workshop: root, packs: [], errors: 0, warnings: 0, engine: [] };

  const loaded = loadWorkshop(root, { log: quiet });
  for (const e of loaded.errors) {
    report.packs.push({ pack: e.pack, issues: [{ field: '', code: 'PACK_LOAD', severity: 'error', message: e.reason }] });
  }
  const packs = only ? loaded.packs.filter((p) => p.id === only) : loaded.packs;
  if (only && packs.length === 0) throw new Error(`no loadable pack named "${only}" under ${root}`);

  // 合并后的数据（引擎看到的那一份）只在真的需要时读一次：覆盖官方记录时逐记录校验必须判这一份，
  // 「谁读谁不读」见 judgeRecord 的注释（docs/EDITOR.md 的那条契约）。
  let mergedTables = null;
  const mergedData = () => (mergedTables ??= loadData(DATA_DIR, { log: quiet, workshopDir: root }));

  for (const pack of packs) {
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    const merged = declared.size ? mergedData() : null;
    const issues = [];
    for (const [file, records] of Object.entries(pack.files)) {
      /** @type {Record<string, object>} 判过之后的那一批：覆盖过的 id 是合并体，其余是包自己的记录。 */
      const judged = {};
      for (const [id, rec] of Object.entries(records)) {
        const j = judgeRecord(file, id, rec, { declared, merged, officialIds: OFFICIAL_IDS });
        judged[id] = j.rec;
        if (file === 'chess') issues.push(...validateChessRecord(j.rec, { id, officialIds: j.officialIds }));
      }
      issues.push(...pairIssues(judged, file));
    }
    report.packs.push({ pack: pack.id, name: pack.name, files: Object.keys(pack.files), issues });
  }

  // ---- the voice pack layer (docs/WORKSHOP.md §1.4). The shape is validated by the loader already (slots, char ids,
  // language keys, path shape); what only the FILESYSTEM can answer is whether the named files are really there and
  // servable — a typo'd name passes every shape check and would simply be a line that never plays. BOTH tables are
  // checked: `voices` (the default dub) and every `voiceLangs[<lang>]` (v0.7.3) — a language table with a missing file
  // is exactly as dead as a default one, and a validator that only looked at `voices` would wave it through.
  for (const pack of packs) {
    const voices = pack.voices || {};
    const voiceLangs = pack.voiceLangs || {};
    const langs = Object.keys(voiceLangs);
    if (!Object.keys(voices).length && !langs.length) continue;
    const entry = report.packs.find((p) => p.pack === pack.id);
    const checkTable = (table, lang) => {
      let n = 0;
      // `lang` is null for the default table: its field names stay `charId.slot` so every existing message is unchanged
      const at = (charId, slot) => (lang ? `${lang}:${charId}.${slot}` : `${charId}.${slot}`);
      for (const [charId, slots] of Object.entries(table)) {
        for (const [slot, files] of Object.entries(slots)) {
          n += files.length;
          for (const rel of files) {
            const abs = path.join(pack.dir, 'assets', rel);
            const ext = path.extname(rel).toLowerCase();
            if (!WORKSHOP_ASSET_TYPES.has(ext)) {
              entry.issues.push({
                field: at(charId, slot), code: 'VOICE_TYPE_UNSERVABLE', severity: 'error',
                message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`,
                hint: 'the route allowlists images / audio / fonts / atlas / skel — an .mp3, .ogg or .wav plays',
              });
            } else if (!fs.existsSync(abs)) {
              entry.issues.push({
                field: at(charId, slot), code: 'VOICE_FILE_MISSING', severity: 'error',
                message: `"${rel}" is declared in pack.json but not on disk at ${abs}`,
                hint: 'files must live inside the pack: <pack>/assets/<path>',
              });
            }
          }
        }
        // A line nobody can hear: the operator is neither official nor added by this pack (the client looks the id up in
        // the merged chess data, so an unknown id is silently dead content). Reported once per operator, not per table.
        const known = OFFICIAL_IDS.has(charId) || Object.keys(pack.files.chess || {}).includes(charId);
        if (!known) {
          entry.issues.push({
            field: lang ? `${lang}:${charId}` : charId, code: 'VOICE_UNKNOWN_OPERATOR', severity: 'warning',
            message: `${charId} is neither an official operator nor one this pack adds — these lines can never play`,
            hint: 'add the operator to this pack\'s chess.json, or ignore this if another installed pack adds it',
          });
        }
      }
      return n;
    };
    const lines = checkTable(voices, null);
    // `voices` stays absent for a pack that declares no default-dub line (a 只带其它语种的包), so its report reads the
    // same as before.
    if (Object.keys(voices).length) entry.voices = { operators: Object.keys(voices).length, lines };
    let langLines = 0;
    for (const lang of langs) langLines += checkTable(voiceLangs[lang], lang);
    if (langs.length) entry.voiceLangs = { langs, lines: langLines };
    report.voiceLines = (report.voiceLines || 0) + lines + langLines;
  }

  // ---- 包自带的装备图标（pack.json 的 itemIcons）。与语音那一层同一个做法：形状（id 字符集、路径形状、必须有
  // assets/）由加载器已经校验过，只有文件系统能回答「这张图真的在、而且这条路真发得出去」。再加一条加载器看不到
  // 的静默失败：客户端是拿**道具的图标 id** 去查 `assets.items` 的（itemIconUrl 先看 iconId、再看 trapId），
  // 所以一个任何道具都不用的 id 只会永远显示兜底图 —— 与 VOICE_UNKNOWN_OPERATOR 同一类（所以也只是 warning）。
  for (const pack of packs) {
    const icons = pack.itemIcons || {};
    const iconIds = Object.keys(icons);
    if (!iconIds.length) continue;
    const entry = report.packs.find((p) => p.pack === pack.id);
    // 本包新增的那部分图标 id：本包 items.json 里各条记录自己的 iconId / trapId
    const ownIconIds = new Set(Object.values(pack.files.items || {}).flatMap((rec) => (rec ? [rec.iconId, rec.trapId] : []))
      .filter((id) => typeof id === 'string' && id));
    for (const [id, rel] of Object.entries(icons)) {
      const abs = path.join(pack.dir, 'assets', rel);
      const ext = path.extname(rel).toLowerCase();
      if (!WORKSHOP_ASSET_TYPES.has(ext)) {
        entry.issues.push({
          field: `itemIcons.${id}`, code: 'ITEM_ICON_TYPE_UNSERVABLE', severity: 'error',
          message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`,
          hint: 'the route allowlists images / audio / fonts / atlas / skel — a .png, .jpg or .webp shows',
        });
      } else if (!fs.existsSync(abs)) {
        entry.issues.push({
          field: `itemIcons.${id}`, code: 'ITEM_ICON_FILE_MISSING', severity: 'error',
          message: `"${rel}" is declared in pack.json but not on disk at ${abs}`,
          hint: 'files must live inside the pack: <pack>/assets/<path>',
        });
      }
      if (!OFFICIAL_ITEM_ICON_IDS.has(id) && !ownIconIds.has(id)) {
        entry.issues.push({
          field: `itemIcons.${id}`, code: 'ITEM_ICON_UNKNOWN_ITEM', severity: 'warning',
          message: `${id} is neither an official item icon nor one this pack adds — this image can never be shown`,
          hint: 'give an item of this pack this iconId / trapId, or ignore this if another installed pack adds it',
        });
      }
    }
    entry.itemIcons = iconIds.length;
    report.itemIcons = (report.itemIcons || 0) + iconIds.length;
  }

  // ---- 包自带的外观素材（pack.json 的 art，docs/WORKSHOP.md §1.4「外观素材」）。这是这条通道最关键的一层：
  // 客户端在这些情况下**一条日志都不打** —— 退回一张菱形贴图，或者模型出来了但不动。形状（三张表、id 字符集、
  // 路径形状、skel/atlas 缺一不可）由加载器已经校验过；只有文件系统与骨架/图谱本身能回答的，全在这里逐条体检：
  //
  //   * 声明的文件真的在不在、扩展名能不能发（ART_FILE_MISSING / ART_TYPE_UNSERVABLE）；
  //   * `.atlas` 是否与 `.skel` **同目录同名**（ART_ATLAS_NAME_MISMATCH）—— 加载器是从 skel 路径推 atlas 的，
  //     清单里那个字段我方代码只用来做内存回收，写错在客户端毫无反应；
  //   * `.atlas` 里写的每一页 png 是否与它同目录、且真的存在（ART_ATLAS_PAGE_MISSING；712 个官方模型里有 2 个是双页，
  //     不能假设一页一 png），以及有没有 `size:` 行（ART_ATLAS_NO_SIZE，pixi-spine 可能除 0）；
  //   * `.skel` 的版本是不是 3.8.x（ART_SPINE_VERSION）—— vendor 是 uni 构建，3.7/4.0/4.1 理论上能跑，只放行 3.8 才稳；
  //   * `anims` 缺不缺（ART_SPINE_NO_ANIMS：客户端 validSpine 要求它是个对象），以及里面写的动画名在骨架里存不存在
  //     （ART_ANIM_UNKNOWN，把骨架真的有的名字列出来给作者对照）；
  //   * 清单的 `pma` 与 atlas 页声明的 `pma` 是否一致（ART_PMA_HINT：png 本身是不是预乘读不出来，所以只提示）；
  //   * id 两边都没有（ART_UNKNOWN_ID）：客户端按 id 查表，没人用的那条素材永远不会显示 —— 与
  //     ITEM_ICON_UNKNOWN_ITEM / VOICE_UNKNOWN_OPERATOR 同一类，所以也只是 warning。
  for (const pack of packs) {
    const art = pack.art || {};
    const tables = Object.keys(art);
    if (!tables.length) continue;
    const entry = report.packs.find((p) => p.pack === pack.id);
    const assetsDir = path.join(pack.dir, 'assets');
    const push = (issue) => entry.issues.push(issue);

    // 文件在不在、类型能不能发：与语音、装备图标两层同一套（只是错误码前缀不同）
    const checkFile = (field, rel) => {
      const abs = path.join(assetsDir, rel);
      const ext = path.extname(rel).toLowerCase();
      if (!WORKSHOP_ASSET_TYPES.has(ext)) {
        push({
          field, code: 'ART_TYPE_UNSERVABLE', severity: 'error',
          message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`,
          hint: 'the route allowlists images / audio / fonts / atlas / skel — 外观素材要的是 .png / .atlas / .skel',
        });
        return false;
      }
      if (!fs.existsSync(abs)) {
        push({
          field, code: 'ART_FILE_MISSING', severity: 'error',
          message: `"${rel}" is declared in pack.json but not on disk at ${abs}`,
          hint: 'files must live inside the pack: <pack>/assets/<path>',
        });
        return false;
      }
      return true;
    };

    /**
     * 一个 spine 对象要过的全部体检。`field` 是它在 pack.json 里的写法（如 art.chars["c"].spine.front）；
     * `inheritsAnims` 表示这个 id 在官方清单里已经有条目 —— 叠加层是**字段级合并**，官方那条的 `anims` 会留下来。
     */
    const checkSpine = (spine, field, inheritsAnims = false) => {
      const skelRel = spine.skel;
      const atlasRel = spine.atlas;
      const skelOk = checkFile(`${field}.skel`, skelRel);
      checkFile(`${field}.atlas`, atlasRel);
      // 加载器是从 skel 的路径**推出** atlas 的（dirname + basename + .atlas），清单里的 atlas 它不读
      const derivedAtlas = skelRel.replace(/\.skel$/i, '.atlas');
      if (atlasRel !== derivedAtlas) {
        push({
          field: `${field}.atlas`, code: 'ART_ATLAS_NAME_MISMATCH', severity: 'error',
          message: `the loader derives the atlas from the skeleton ("${derivedAtlas}") but pack.json names "${atlasRel}"`,
          hint: 'put the atlas beside the skeleton under the same name: <name>.skel + <name>.atlas',
        });
      }
      // atlas 的内容：页名以 .atlas 文本为准（清单里的 textures 只是内存回收用的清单，不参与加载）
      const atlasAbs = path.join(assetsDir, atlasRel);
      let atlasText = null;
      if (fs.existsSync(atlasAbs)) {
        try { atlasText = fs.readFileSync(atlasAbs, 'utf8'); } catch { atlasText = null; }
      }
      const info = atlasText === null ? null : atlasInfo(atlasText);
      if (info) {
        for (const page of info.pages) {
          if (!fs.existsSync(path.join(path.dirname(atlasAbs), page))) {
            push({
              field: `${field}.atlas`, code: 'ART_ATLAS_PAGE_MISSING', severity: 'error',
              message: `the atlas lists the page "${page}" but it is not beside it (${path.join(path.dirname(atlasAbs), page)})`,
              hint: 'every page name in the .atlas is a png in the same folder — one model may have more than one page',
            });
          }
        }
        if (!info.hasSize) {
          push({
            field: `${field}.atlas`, code: 'ART_ATLAS_NO_SIZE', severity: 'warning',
            message: 'at least one page of this atlas has no "size: W,H" line',
            hint: 'pixi-spine divides by the page size — add `size: <w>,<h>` under the page name (tools/assets/atlas.mjs writes it)',
          });
        }
        // pma：清单里的 pma 与 atlas 页声明的 pma 不一致 —— 客户端信清单那一份，画出来就是错的。
        // png 自己是不是预乘读不出来（那要解像素），所以这条只能提示，不能判死。
        if (typeof spine.pma === 'boolean' && spine.pma !== info.hasPma) {
          push({
            field: `${field}.pma`, code: 'ART_PMA_HINT', severity: 'warning',
            message: `the manifest says pma: ${spine.pma} but the atlas ${info.hasPma ? 'declares' : 'does not declare'} "pma: true"`,
            hint: 'the client premultiplies exactly when the manifest says pma: true — make both sides agree',
          });
        }
      }
      // anims 是清单自己的声明：缺了/空了报一次（与骨架能不能解析无关）
      const declaredAnims = roleAnimationNames(spine.anims);
      if (!declaredAnims.length) {
        push({
          field: `${field}.anims`, code: 'ART_SPINE_NO_ANIMS',
          // 官方已有这个 id 时字段级合并会把官方那条的 anims 留着，所以只是警告；**新 id 没有可继承的 anims** ——
          // 而客户端的 validSpine 要求 anims 是对象，缺了它这个模型根本不会被采用，只会画成一张贴图。
          severity: inheritsAnims ? 'warning' : 'error',
          message: inheritsAnims
            ? 'this spine declares no animation role (`anims`) — the official entry\'s own anims are kept, so the model will still animate'
            : 'this spine declares no animation role (`anims`), and there is no official entry to inherit one from',
          hint: 'the client\'s validSpine requires an anims object and plays the roles it names — without it the unit falls back to a flat portrait',
        });
      }
      // 骨架：版本 + 动画名（用客户端同一个解析器读，喂进去的必须是**从 0 开始的** Uint8Array）
      if (!skelOk) return;
      let skelInfo;
      try {
        skelInfo = parseSkel(new Uint8Array(fs.readFileSync(path.join(assetsDir, skelRel))));
      } catch (e) {
        push({
          field: `${field}.skel`, code: 'ART_SPINE_VERSION', severity: 'error',
          message: `this .skel cannot be read as a Spine 3.8 skeleton (${e && e.message ? e.message : e})`,
          hint: 'export the model as Spine 3.8.x binary — the client parses it with @pixi-spine/runtime-3.8 and stays silent on failure',
        });
        return;
      }
      if (!/^3\.8\./.test(skelInfo.version)) {
        push({
          field: `${field}.skel`, code: 'ART_SPINE_VERSION', severity: 'error',
          message: `the skeleton's version is "${skelInfo.version}" — only 3.8.x is accepted`,
          hint: 're-export as 3.8.x: the shipped parser may also read 3.7 / 4.0 / 4.1, but every official model is 3.8 (709 × 3.8.99 + 3 × 3.8.84)',
        });
      }
      if (declaredAnims.length) {
        const known = new Set(skelInfo.animations);
        const unknown = declaredAnims.filter((n) => !known.has(n));
        if (unknown.length) {
          const list = skelInfo.animations.length > 12 ? `${skelInfo.animations.slice(0, 12).join(', ')}, …` : skelInfo.animations.join(', ');
          push({
            field: `${field}.anims`, code: 'ART_ANIM_UNKNOWN', severity: 'error',
            message: `these animation names are not in the skeleton: ${unknown.join(', ')}`,
            hint: skelInfo.animations.length ? `the skeleton has ${skelInfo.animations.length}: ${list}` : 'the skeleton has no animations at all',
          });
        }
      }
    };

    let count = 0;
    for (const [table, entries] of Object.entries(art)) {
      for (const [id, a] of Object.entries(entries)) {
        count++;
        for (const f of ART_ENTRY_PATH_FIELDS[table] || []) {
          if (typeof a[f] === 'string') checkFile(`art.${table}.${id}.${f}`, a[f]);
        }
        if (!a.spine) continue;
        // 官方已有这个 id 时，叠加层是字段级合并：官方那条的 anims/events 会留下来（所以缺 anims 只是警告）
        const inherits = OFFICIAL_ART_IDS[table] ? OFFICIAL_ART_IDS[table].has(id) : false;
        if (ART_SPINE_NESTED_TABLES.has(table)) {
          for (const [side, spine] of Object.entries(a.spine)) checkSpine(spine, `art.${table}.${id}.spine.${side}`, inherits);
        } else {
          checkSpine(a.spine, `art.${table}.${id}.spine`, inherits);
        }
      }
    }

    // id 有没有人用：客户端按 id 查表（干员读 chess 记录的 assets.spine / charId，怪物读自己的键，召唤物读 tokens）。
    // 「本包的数据文件」指本包 chess.json / enemies.json / tokens.json 自己贡献的那些 id。
    const ownIds = {
      chars: ownCharIds(pack),
      enemies: new Set(Object.keys(pack.files.enemies || {})),
      tokens: ownTokenIds(pack),
    };
    const unknownHint = {
      chars: 'point a chess record of this pack at it (assets.spine = "<id>"), or ignore this if another installed pack adds that operator',
      enemies: 'name it in this pack\'s waves / enemies.json, or ignore this if another installed pack adds that monster',
      tokens: 'list it in a chess record of this pack (`tokens`), or ignore this if another installed pack adds that summon',
    };
    for (const [table, entries] of Object.entries(art)) {
      for (const id of Object.keys(entries)) {
        if (OFFICIAL_ART_IDS[table].has(id) || ownIds[table].has(id)) continue;
        push({
          field: `art.${table}.${id}`, code: 'ART_UNKNOWN_ID', severity: 'warning',
          message: `${id} is neither in the official assets.json "${table}" table nor contributed by this pack — nothing can ever use this art`,
          hint: unknownHint[table],
        });
      }
    }

    entry.art = count;
    report.art = (report.art || 0) + count;
  }

  // ---- the 助战 layer (docs/WORKSHOP.md §2). `pack.json.support` names the operators of THIS pack that should be
  // pickable as 助战; the overlay derives each one's tier from its record and adds it to data/support.json's pool. The
  // rule itself is shared with the overlay (`workshopSupportEntries`) so an author sees exactly what the loader does.
  for (const pack of packs) {
    if (!Array.isArray(pack.support) || !pack.support.length) continue;
    const entry = report.packs.find((p) => p.pack === pack.id);
    const { entries, errors } = workshopSupportEntries({ chess: pack.files.chess || {} }, [pack]);
    for (const e of errors) {
      entry.issues.push({ field: 'support', code: e.code, severity: 'error', message: e.reason });
    }
    if (entries.length) {
      entry.support = entries.map((e) => `${e.id} → 阶 ${e.tier}`);
      report.supportEntries = (report.supportEntries || 0) + entries.length;
    }
  }

  // ---- layer 3: the engine. Load the merged data exactly as the server does and interrogate it.
  if (loaded.packs.length) {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: root });
    const gd = new GameData(data, 'mode_multi_hard');
    const ds = toDataSource(data);
    for (const pack of packs) {
      for (const id of Object.keys(pack.files.chess || {})) {
        const rec = data.chess[id];
        if (!rec) { report.engine.push({ id, code: 'NOT_MERGED', severity: 'error', message: 'the record did not reach the merged data' }); continue; }
        if (rec.isGolden) continue;
        if (!gd.visibleChess.includes(id)) {
          report.engine.push({ id, code: 'NOT_SHOP_ELIGIBLE', severity: 'warning', message: 'not shop-eligible: the operator can never be recruited', hint: 'set visible true, isHidden false, isDiy false and an integer tier' });
        }
        if (gd.goldenIdOf(id) !== rec.goldenId) {
          report.engine.push({ id, code: 'ELITE_LINK', severity: 'error', message: `goldenIdOf resolved to ${gd.goldenIdOf(id)} but the record says ${rec.goldenId}` });
        }
        // does the sim actually build a unit def? (missing stats/ranges only show up here)
        try {
          if (!ds.getChess(id)) report.engine.push({ id, code: 'SIM_NO_DEF', severity: 'error', message: 'the sim could not build a def for this operator' });
        } catch (e) {
          report.engine.push({ id, code: 'SIM_THREW', severity: 'error', message: `the sim threw while building a def: ${e.message}` });
        }
      }
    }
  }

  for (const p of report.packs) for (const i of p.issues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  for (const i of report.engine) (i.severity === 'error' ? report.errors++ : report.warnings++);

  // ---- layer 4: the behaviour layer (a pack's kits/<chessId>.js). Loading it here means a broken kit is caught BEFORE
  // the server boots, and an AI gets the same field/code/hint shape it already uses for the data layer.
  //
  // The IMPORT is only half the check. Importing proves the file parses and default-exports a function; it says nothing
  // about the failures that are SILENT in play — a hook name nothing emits (so the handler never runs), a Math.random()
  // or Date.now() that makes the server's recomputation reject the player's result, or a relative import that resolves
  // for the server and not for the browser. Those are static, so they are scanned for here (shared/kitAuthoring.js).
  if (loaded.packs.length) {
    const kitInfo = await loadWorkshopKits(loaded, {
      log: quiet,
      knownIds: new Set(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: root }).chess || {})),
    });
    const staticIssues = [];
    // a kit the static layer already explained is not reported a second time by the loader, whose message is blunter
    const explained = new Set();
    for (const pack of loaded.packs) {
      const kitDir = path.join(pack.dir, 'kits');
      if (!fs.existsSync(kitDir)) continue;
      const ownChessIds = Object.keys((pack.files && pack.files.chess) || {});
      for (const name of fs.readdirSync(kitDir).sort()) {
        if (!name.endsWith('.js')) continue;
        const id = name.slice(0, -'.js'.length);
        const issues = validateKit(fs.readFileSync(path.join(kitDir, name), 'utf8'), { id, ownChessIds, overrides: pack.overrides })
          .map((i) => ({ ...i, field: `kits/${pack.id}/${name}${i.field && i.field !== 'source' ? ` · ${i.field}` : ''}` }));
        if (issues.some((i) => i.severity === 'error')) explained.add(`${pack.id}/${id}`);
        staticIssues.push(...issues);
      }
    }
    report.kits = {
      loaded: kitInfo.modules.map((m) => m.id),
      modules: kitInfo.modules,
      issues: staticIssues,
      errors: kitInfo.errors
        .filter((e) => !explained.has(`${e.pack}/${e.id}`))
        .map((e) => ({ field: `kits/${e.id}.js`, code: 'KIT', severity: 'error', message: `${e.pack}: ${e.reason}` })),
    };
    for (const e of report.kits.errors) report.errors++;
    for (const i of staticIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 5: stages (maps). groundPaths / groundPathsWithDevices / deployTiles are DERIVED from the grid, so they
  // are RE-derived and compared. A hand-edited grid whose tables were left behind still looks well-formed, yet would send
  // enemies along a route the map no longer has — exactly the failure this layer exists to catch.
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.stages || {}).length)) {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: root });
    const officialStages = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stages.json'), 'utf8'))));
    const listedIn = new Set();
    for (const m of Object.values((data.config && data.config.modes) || {})) {
      for (const s of (Array.isArray(m && m.stages) ? m.stages : [])) listedIn.add(s);
    }
    const stageIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      const merged = declared.size ? mergedData() : null;
      for (const [id, rec] of Object.entries(pack.files.stages || {})) {
        const j = judgeRecord('stages', id, rec, { declared, merged, officialIds: officialStages });
        stageIssues.push(...validateStageRecord(j.rec, { id, officialIds: j.officialIds }));
        if (!listedIn.has(id)) {
          stageIssues.push({
            field: id, code: 'NOT_SELECTABLE', severity: 'warning',
            message: 'no mode lists this stage, so no match can ever pick it',
            hint: 'give the stage a `modes` array naming the modes it belongs to — the loader appends it to those',
          });
        }
      }
    }
    report.stages = stageIssues;
    for (const i of stageIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 6: enemies (monsters). `be` and `attrPower` are DERIVED from the stats and drive the per-faction enemy
  // replacement count, so they are re-derived and compared: a hand-typed value swaps the wrong number of enemies.
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.enemies || {}).length)) {
    const officialEnemies = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'enemies.json'), 'utf8'))));
    const enemyIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      const merged = declared.size ? mergedData() : null;
      for (const [key, rec] of Object.entries(pack.files.enemies || {})) {
        const j = judgeRecord('enemies', key, rec, { declared, merged, officialIds: officialEnemies });
        enemyIssues.push(...validateEnemy(j.rec, { key, officialIds: j.officialIds }));
      }
    }
    report.enemies = enemyIssues;
    for (const i of enemyIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 7: waves (每关出怪). totalCount/slotCounts are DERIVED and re-derived here; the checks that matter most are
  // the cross-file ones — a spawn whose enemy nothing defines, or a routeIndex past the wave's own routes — because both
  // fail SILENTLY in game (the key spawns nothing; the sim falls back to route 0 and enemies walk a different path).
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.waves || {}).length)) {
    const officialWaves = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'waves.json'), 'utf8'))));
    // the merged enemy keys, so a pack may spawn its own monsters as well as official ones
    const knownEnemyKeys = new Set(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: root }).enemies || {}));
    const waveIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      const merged = declared.size ? mergedData() : null;
      for (const [id, rec] of Object.entries(pack.files.waves || {})) {
        const j = judgeRecord('waves', id, rec, { declared, merged, officialIds: officialWaves });
        waveIssues.push(...validateWave(j.rec, { id, officialIds: j.officialIds, knownEnemyKeys }));
      }
    }
    report.waves = waveIssues;
    for (const i of waveIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 8: items (装备). `params` is DERIVED from the buffs' blackboards, and `mergeable` / `shopExcluded` from the
  // merge pair and the exclusion field. The engine reads `params`, NOT the buffs — so a hand-typed params block leaves an
  // item that looks right on its card and does nothing in play. All three are re-derived and compared. The cross-record
  // checks are the other silent ones: a merge target nothing defines (the merge goes nowhere) and an item no shop slot
  // can ever offer.
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.items || {}).length)) {
    const officialItems = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'items.json'), 'utf8'))));
    const merged = mergedData();
    const itemIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      for (const [id, rec] of Object.entries(pack.files.items || {})) {
        const j = judgeRecord('items', id, rec, { declared, merged, officialIds: officialItems });
        itemIssues.push(...validateItem(j.rec, { id, officialIds: j.officialIds }));
        const m = (merged.items || {})[id];
        if (!m) {
          itemIssues.push({ field: id, code: 'NOT_MERGED', severity: 'error', message: 'the record did not reach the merged data' });
          continue;
        }
        if (!m.isGolden && m.goldenId && !(merged.items || {})[m.goldenId]) {
          itemIssues.push({
            field: `${id}.goldenId`, code: 'GOLDEN_MISSING', severity: 'error',
            message: `the merge target "${m.goldenId}" is neither in this pack nor in the official data`,
            hint: 'emit the elite record too, or set upgradeNum 0 for a standalone item',
          });
        }
        if (!m.isGolden && !isShopItem(m)) {
          itemIssues.push({
            field: id, code: 'NOT_SHOP_ELIGIBLE', severity: 'warning',
            message: 'not shop-eligible: no shop slot and no item card can ever offer it',
            hint: 'keep itemType EQUIP, hideInShop false, shopExcludedBy null and an integer tier — or accept it as effect-only',
          });
        }
      }
    }
    report.items = itemIssues;
    for (const i of itemIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`workshop root: ${root}`);
    if (!loaded.present) console.log('  (the directory does not exist — nothing to validate)');
    if (!loaded.packs.length && !report.packs.length) console.log('  no packs found');
    for (const p of report.packs) {
      const bits = [];
      if (p.files && p.files.length) bits.push(p.files.join(', '));
      if (p.voices) bits.push(`${p.voices.lines} voice line(s) for ${p.voices.operators} operator(s)`);
      if (p.voiceLangs) bits.push(`${p.voiceLangs.lines} line(s) in ${p.voiceLangs.langs.join('/')}`);
      if (p.itemIcons) bits.push(`${p.itemIcons} item icon(s)`);
      if (p.art) bits.push(`${p.art} art entr${p.art === 1 ? 'y' : 'ies'}`);
      if (p.support) bits.push(`助战: ${p.support.join(', ')}`);
      console.log(`\npack ${p.pack}${p.name ? ` (${p.name})` : ''}${bits.length ? ` — ${bits.join(' + ')}` : ''}`);
      if (!p.issues.length) console.log('  OK');
      else console.log(formatIssues(p.issues).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (report.engine.length) {
      console.log('\nengine checks:');
      console.log(formatIssues(report.engine).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (report.kits) {
      console.log(`\nbehaviour layer (kits/):`);
      console.log(report.kits.loaded.length ? `  loaded: ${report.kits.loaded.join(', ')}` : '  (no kits)');
      if (report.kits.errors.length) console.log(formatIssues(report.kits.errors).split('\n').map((l) => `  ${l}`).join('\n'));
      if (report.kits.issues && report.kits.issues.length) console.log(formatIssues(report.kits.issues).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (report.stages) {
      console.log('\nstages (maps):');
      console.log(report.stages.length ? formatIssues(report.stages).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    if (report.enemies) {
      console.log('\nenemies (monsters):');
      console.log(report.enemies.length ? formatIssues(report.enemies).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    if (report.waves) {
      console.log('\nwaves (每关出怪):');
      console.log(report.waves.length ? formatIssues(report.waves).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    if (report.items) {
      console.log('\nitems (装备):');
      console.log(report.items.length ? formatIssues(report.items).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    console.log(`\n${report.errors} error(s), ${report.warnings} warning(s)`);
    if (report.errors === 0) console.log('VALID: the engine accepts this content.');
  }
  process.exit(report.errors ? 1 : 0);
}

main().catch((e) => {
  console.error(`workshop-validate: ${e.message}`);
  console.error(USAGE);
  process.exit(2);
});
