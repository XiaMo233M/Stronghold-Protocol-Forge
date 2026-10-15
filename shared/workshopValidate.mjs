// shared/workshopValidate.mjs — 工坊包的**分层校验器本体**（CLI 与编辑器界面共用这一份）。
//
// 为什么单独成文件（2026-10-13）：`tools/workshop-validate.mjs` 是**维护者工具**，`tools/package.mjs` 的
// `PLAYER_TOOLS` 不收它 —— 所以玩家包里没有这个文件，编辑器的服务端 import 它会**当场崩**。
// 而「按一下就知道这个包装不装得上」这件事（B1 的「校验这个包」）与 CLI 必须是**同一份判据**：
// 两处各写一遍，必然有一天只改了一处，于是界面给绿、命令行给红（或者反过来）。
// 所以判据搬到这里（`shared/` 是编辑器与游戏共用的一层，随包发出），CLI 只负责把报告打成文本。
//
// 层数（与 CLI 的文件头一致）：包格式 → 逐记录语义 → **真引擎装载** → 按内容种类各一层
// （kits / stages / enemies / waves / items / 语音 / 装备图标 / 外观素材 / 助战声明 / 静态路由）。
// 第 3 层是它存在的理由：一条记录可以语法完全合法、却**静默**不可玩。
//
// 纯只读：不写任何文件（`loadWorkshop` 与 `loadData` 都只读；`loadWorkshopKits` 只 import）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChessRecord, formatIssues } from './chessAuthoring.js';
import { validateEnemy } from './enemyAuthoring.js';
import { validateWave } from './waveAuthoring.js';
import { validateItem } from './itemAuthoring.js';
import { validateKit } from './kitAuthoring.js';
import { t } from './i18n.js';
import { workshopSupportEntries, ART_TABLES } from './workshop.js';
import { loadWorkshop, loadWorkshopKits, WORKSHOP_DIR } from '../server/workshop.js';
import { validateStageRecord } from '../server/stageAuthoring.js';
import { loadData } from '../server/data.js';
import { WORKSHOP_ASSET_TYPES } from '../server/index.js';
import { atlasInfo } from '../tools/assets/atlas.mjs';
import { parseSkel } from '../tools/assets/skel.mjs';
import { roleAnimationNames } from '../tools/assets/anim-roles.mjs';
import { coreMounts, coreRouteShadow } from '../server/http/routeMount.js';
import { serveDirs } from '../server/http/config.js';
import { toDataSource } from '../server/sim/simdata.js';

// 判据（`coreRouteShadow`）与挂载表（`coreMounts`）**只此一份**，来自服务器那一份实现，不在这里抄第二张表。
// 编辑器侧要复用它，测试也按名字读它（test/workshopValidateRoutes.test.js 的源码级断言）。
export { coreMounts, coreRouteShadow };

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 本仓库根（`shared/` 的上一级）。 */
export const REPO_ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 报告里一条问题在**哪个层**（界面上按这个分组、也按它翻成人话）。
 * 键与 `editor/ui/pack.js` 的 `checkKindLabel` 一对；加一层就两边一起加。
 *
 * 注：`checks[]` 的条目自带 `kind`；`packs[].issues` 那批里，逐记录的那几条由装载时按 `LAYER_KIND` 标好，
 * 路由 / 外观素材 / 装备图标那几条由 `kindOfCode()` 从错误码现推（同一条问题只存一份，见收尾自检的注释）。
 */
export const CHECK_KINDS = Object.freeze(['pack', 'operator', 'engine', 'art', 'voice', 'itemIcon', 'kit', 'stage', 'enemy', 'wave', 'item', 'route', 'support', 'variants']);

/**
 * 一张内容文件 → 它属于哪一层（`packs[].issues` 里逐记录那批的 `kind`）。
 * 界面按层分组用它；加一张数据表就在这里补一行。
 */
const LAYER_KIND = { chess: 'operator', items: 'item', stages: 'stage', enemies: 'enemy', waves: 'wave', kits: 'kit', bonds: 'operator', tokens: 'operator', units: 'operator', variants: 'variants' };

/**
 * 错误码 → 层名。**只有从码推得出来的那些**才在这里（`packs[].issues` 里没带 `kind` 的那几条用）。
 *
 * 为什么按前缀推而不是再存一份 `kind`：一条问题在两个数组里各存一份，代价是一个「数了两遍」的账；
 * 而码前缀是引擎自己定的命名约定（`ART_*` / `ROUTE_*` / `VOICE_*` / `ITEM_ICON*` / `VARIANTS_*` / …），本来就带这一层信息。
 * 推不出来的落在 `'operator'`（逐记录那批本来就都带 `kind`，这个分支只是兜底）。
 * @param {unknown} code
 * @param {{ kind?: string }} [issue] 带 `kind` 的条目直接用它（存在优先于推断）
 * @returns {string}
 */
export function kindOfCode(code, issue) {
  if (issue && typeof issue.kind === 'string' && issue.kind) return issue.kind;
  const c = typeof code === 'string' ? code : '';
  if (c.startsWith('ART_')) return 'art';
  if (c.startsWith('ROUTE_')) return 'route';
  if (c.startsWith('VOICE_')) return 'voice';
  if (c.startsWith('ITEM_ICON')) return 'itemIcon';
  // 口径数据通道（DESIGN §28.51）自己的一层：`variants.json` 的补丁问题归到这里，而不是兜底的 `'operator'`
  // ——「包的口径表坏了」与「干员记录坏了」是两件事，混在一格里作者会去改错文件。
  if (c.startsWith('VARIANTS_')) return 'variants';
  if (c.startsWith('PACK_') || c.startsWith('ASSETS_') || c === 'EMPTY_PACK' || c === 'BAD_API_TYPE'
    || c === 'BAD_GAME_TYPE' || c === 'PACK_LOAD' || c === 'PACK_FOREIGN') return 'pack';
  if (c === 'NOT_MERGED' || c === 'NOT_SHOP_ELIGIBLE' || c === 'ELITE_LINK' || c === 'SIM_NO_DEF' || c === 'SIM_THREW') return 'engine';
  return 'operator';
}

// ---- 官方 id 集合（只读一次）-------------------------------------------------------------------------------------

const readJsonOr = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

const OFFICIAL_CHESS = readJsonOr(path.join(DATA_DIR, 'chess.json'), {});
const OFFICIAL_IDS = new Set(Object.keys(OFFICIAL_CHESS));

/**
 * 「官方已有的装备图标 id」= 官方道具记录自己的 `iconId` / `trapId`。
 *
 * 为什么是这两个字段而不是 `data/items.json` 的键：客户端**不看**道具记录 id，它是拿
 * `public/js/assets.js itemIconUrl` 的 `item.iconId || item.trapId` 去查 `data/assets.json` 的 `items` 的。
 * 拿 `items.json` 的键当官方集合会把每一个合法的覆盖都误报成 warning。
 */
const OFFICIAL_ITEM_ICON_IDS = new Set(
  Object.values(readJsonOr(path.join(DATA_DIR, 'items.json'), {}))
    .flatMap((rec) => (rec ? [rec.iconId, rec.trapId] : []))
    .filter((id) => typeof id === 'string' && id),
);

/** 「官方已有的外观条目 id」= 官方素材清单 `data/assets.json` 那三张表的键（chars / enemies / tokens）。 */
const OFFICIAL_ASSETS = readJsonOr(path.join(DATA_DIR, 'assets.json'), {});
const artTableIds = (table) => new Set(Object.keys((OFFICIAL_ASSETS && OFFICIAL_ASSETS[table]) || {}));
const OFFICIAL_ART_IDS = { chars: artTableIds('chars'), enemies: artTableIds('enemies'), tokens: artTableIds('tokens') };

/** 一个 art 条目上**直接是路径**的字段，与 spine 在哪一层 —— 都读 `ART_TABLES`，不抄第二份。 */
const ART_ENTRY_PATH_FIELDS = Object.fromEntries(Object.entries(ART_TABLES).map(([table, shape]) => [table, shape.urls]));
const ART_SPINE_NESTED_TABLES = new Set(Object.entries(ART_TABLES).filter(([, shape]) => shape.spine === 'sides').map(([table]) => table));
const ART_FLAT_TABLES = new Set(Object.entries(ART_TABLES).filter(([, shape]) => shape.flat).map(([table]) => table));

// ---- 判据本体 ---------------------------------------------------------------------------------------------------

/** 一个包自己新增的干员 char id（客户端按这个查 chars）。 */
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

/** 一个包自己新增的召唤物 token id。 */
function ownTokenIds(pack) {
  const out = new Set(Object.keys(pack.files.tokens || {}));
  for (const rec of Object.values(pack.files.chess || {})) {
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.tokens)) continue;
    for (const t of rec.tokens) if (typeof t === 'string' && t) out.add(t);
  }
  return out;
}

/**
 * 一条记录该按**哪一份**判：包自己的记录就是它本身；声明过覆盖的官方 id 要判 `loadData` 合并出来的那一条
 * （覆盖写的是差量补丁，拿补丁当完整记录会得到几十条假 `MISSING` / `OFFICIAL_ID_COLLISION`）。
 */
function judgeRecord(file, id, rec, { declared, merged, officialIds }) {
  if (!declared.has(`${file}:${id}`)) return { rec, officialIds };
  const table = merged && merged[file] ? merged[file] : null;
  const ids = new Set(officialIds);
  ids.delete(id);
  return { rec: table && table[id] ? table[id] : rec, officialIds: ids };
}

/** 逐记录校验器看不到的跨记录检查（普通 / 精锐那一对）。跑在**判过之后**的记录上。 */
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

/**
 * 打平的一张问题卡片（界面按 `kind` 分组渲染的就是它）。
 *
 * `views` 说这一条在 **CLI 文本**里印在哪：`['checks']` = 只印在按层归拢那一段；`['packs']` = 只印在它
 * 所属的那个包那一行；`['packs','checks']` = 两边都印（`--json` 里它出现在处，但**文本只印一次**，
 * 否则同一行错误在一次运行里出现两遍）。这层簿记存在的理由：`art` 与 `route` 的**既有文本形状**是印在包
 * 那一行里的（`docs/WORKSHOP.md` 的那几段输出、以及 test/workshopValidateArtTables.test.js 读的
 * `packs[].issues`），而界面要的是按层分组 —— 两个消费者、一份数据。
 */
const push = (list, kind, issue, views, pack = null) => list.push({
  kind,
  // `pack` = 这一条是哪个包的问题。**必须带上**：按包查询（编辑器那条只读端点）要能把整根的
  // `checks[]` 剪成「只有这一个包的那几条」—— 一份不带归属的报告，界面要么多报别人的错，要么少报自己的。
  pack,
  views: views ?? ['checks'],
  field: issue.field ?? '',
  code: issue.code ?? '',
  severity: issue.severity ?? 'error',
  message: issue.message ?? '',
  hint: issue.hint ?? '',
});

/**
 * 报告里这个包的那一行（`packs[]` 里按 `pack` 找）。
 *
 * 为什么各层要回头找它：`--json` 的既有形状是「一个包的**所有**问题都在它自己那一行里」，而各层的
 * 计数器（`entry.voices` / `entry.itemIcons` / `entry.art` / `entry.support`）也挂在那一行上 ——
 * test/workshopValidateArtTables.test.js 直接读 `pack.art`，test/workshopItemIcons.test.js 读
 * `report.itemIcons`。分层计数与 `checks[]` 是**两种视图**，但一条问题只数一次（见收尾那段）。
 */
const rowFor = (report, id) => report.packs.find((x) => x.pack === id) ?? null;

/**
 * 装载期那条错误的**真码**：`loadWorkshop` 的 `reason` 是加载器自己写的一句话（多数形如 `CODE: detail`）。
 *
 * 为什么要拆：以前这里一律写成 `code: 'PACK_LOAD'` —— 那对**界面**是个损失，`PACK_UNKNOWN_FIELD` 这种
 * 进得了白话表的码被一个笼统的 `PACK_LOAD` 盖掉，于是作者拿不到那条人话与修法（测试里就撞到了）。
 * 拆不出来的（reason 里没有 `CODE:` 形状）保留 `PACK_LOAD`，`detail` 仍然是整句原文。
 * @param {unknown} reason
 * @returns {{ code: string, detail: string }}
 */
function loadIssueOf(reason) {
  const text = typeof reason === 'string' ? reason : String(reason ?? '');
  const m = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/.exec(text);
  return m ? { code: m[1], detail: m[2] } : { code: 'PACK_LOAD', detail: text };
}

/**
 * 校验一个工坊根（或其中一个包）—— CLI 与编辑器「校验这个包」的**同一个入口**。
 *
 * @param {{ root?: string, only?: string|null, log?: object }} [opts]
 *   `root` 默认 `<repo>/workshop`；`only` 只报告这一个包 id（`null` = 全部）。
 * @returns {Promise<{ workshop: string, only: string|null, packs: object[], checks: object[], errors: number, warnings: number, foreign: object[] }>}
 *   `packs[]` = 每包一行（`{ pack, name, files, issues }`，与 CLI 的报告同形）；
 *   `checks[]` = **打平并带层名**的那一份（界面按 `kind` 分组显示的就是它）。
 */
export async function validateWorkshop({ root = WORKSHOP_DIR, only = null, log = quiet } = {}) {
  const report = { workshop: root, only: only ?? null, packs: [], checks: [], errors: 0, warnings: 0, engine: [], routes: [], foreign: [] };
  const loaded = loadWorkshop(root, { log });
  for (const e of loaded.errors) {
    const issue = loadIssueOf(e.reason);
    report.packs.push({
      pack: e.pack,
      kind: 'pack',
      issues: [{ field: '', kind: 'pack', code: issue.code, severity: 'error', message: e.reason, detail: issue.detail }],
    });
  }
  // `target: "stardust"`：本引擎认识但不装载。它既不是错误（清单合法、没有错误码），也**绝不能从报告里消失**
  // —— 一个包从报告里消失，作者只能看到「我建的包不见了」（docs/WORKSHOP.md §1.1 那条教训）。所以一行具名 warning。
  for (const f of loaded.foreign ?? []) {
    report.packs.push({ pack: f.pack, issues: [{ field: 'target', code: 'PACK_FOREIGN', severity: 'warning', message: f.reason }] });
  }
  report.foreign = (loaded.foreign ?? []).map((f) => ({ pack: f.pack, reason: f.reason }));
  const packs = only ? loaded.packs.filter((p) => p.id === only) : loaded.packs;
  if (only && packs.length === 0) {
    // 「磁盘上没有这个包」与「这个包有错」是两件事，调用方靠 `missing` 区分（界面上是两句话）。
    // ⚠️ 但**装载期就被拒**的包也走这一条（`pack.json` 有闭集外的键、JSON 非法、目录名 ≠ 包 id …）——
    // 这时只回一句 `missing` 会把**真因**丢掉：2026-10-15 实测，作者看到「没有这个包」，
    // 而他真正的问题是 `PACK_UNKNOWN_FIELD`。所以把装载器记下的错**一并回显**（`loadErrors`）：
    // `missing` 保持原义（磁盘上找不到那个 id），真因另给一格，界面与 CLI 都能据它说话。
    const loadErrors = (loaded.errors ?? []).filter((e) => e.pack === only);
    return { ...report, missing: true, loadErrors };
  }

  // 合并后的数据只在真的需要时读一次（覆盖官方记录时逐记录校验必须判这一份）。
  let mergedTables = null;
  const mergedData = () => (mergedTables ??= loadData(DATA_DIR, { log, workshopDir: root }));
  const chessBondIds = () => new Set(Object.keys(mergedData().bonds || {}));

  for (const pack of packs) {
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    const merged = declared.size ? mergedData() : null;
    const issues = [];
    for (const [file, records] of Object.entries(pack.files)) {
      const judged = {};
      const fromFile = [];
      for (const [id, rec] of Object.entries(records)) {
        const j = judgeRecord(file, id, rec, { declared, merged, officialIds: OFFICIAL_IDS });
        judged[id] = j.rec;
        if (file === 'chess') fromFile.push(...validateChessRecord(j.rec, { id, officialIds: j.officialIds, bondIds: chessBondIds() }));
      }
      fromFile.push(...pairIssues(judged, file));
      // 逐记录那批带上**它来自哪张表**（`kind`）：`kindOfCode()` 靠它把 `BAD_TIER` / `STALE_DERIVED`
      // 这类「多个校验器都会报」的码分到正确的层（界面按层分组时不必猜）。
      const kind = LAYER_KIND[file] ?? 'operator';
      // `pack` = 这一条属于哪个包。按包查询（编辑器那条只读端点）靠它把整根报告剪成「只有这一个包的」。
      for (const i of fromFile) {
        if (!i.kind) i.kind = kind;
        if (!i.pack) i.pack = pack.id;
      }
      issues.push(...fromFile);
    }
    report.packs.push({ pack: pack.id, name: pack.name, files: Object.keys(pack.files), issues });
  }

  // ---- 第 3 层：真引擎。与服务器完全一样地装载合并数据，然后逐条问它。这是「语法合法却静默不可玩」的那一层。
  if (loaded.packs.length) {
    const data = loadData(DATA_DIR, { log, workshopDir: root });
    const { GameData } = await import('../server/match/gamedata.js');
    const gd = new GameData(data, 'mode_multi_hard');
    const ds = toDataSource(data);
    for (const pack of packs) {
      for (const id of Object.keys(pack.files.chess || {})) {
        const rec = data.chess[id];
        if (!rec) { report.engine.push({ id, pack: pack.id, code: 'NOT_MERGED', severity: 'error', message: 'the record did not reach the merged data' }); continue; }
        if (rec.isGolden) continue;
        if (!gd.visibleChess.includes(id)) {
          report.engine.push({ id, pack: pack.id, code: 'NOT_SHOP_ELIGIBLE', severity: 'warning', message: 'not shop-eligible: the operator can never be recruited', hint: 'set visible true, isHidden false, isDiy false and an integer tier' });
        }
        if (gd.goldenIdOf(id) !== rec.goldenId) {
          report.engine.push({ id, pack: pack.id, code: 'ELITE_LINK', severity: 'error', message: `goldenIdOf resolved to ${gd.goldenIdOf(id)} but the record says ${rec.goldenId}` });
        }
        try {
          if (!ds.getChess(id)) report.engine.push({ id, pack: pack.id, code: 'SIM_NO_DEF', severity: 'error', message: 'the sim could not build a def for this operator' });
        } catch (e) {
          report.engine.push({ id, pack: pack.id, code: 'SIM_THREW', severity: 'error', message: `the sim threw while building a def: ${e.message}` });
        }
      }
    }
  }

  // ---- 静态路由通道：形状层已经挡掉「不是绝对路径 / 不是包内 .json」；只有文件系统能回答
  // 「这条路径引擎自己是不是已经在发」。服务器启动时用 coreRouteShadow 决定，被挡的那条只是被丢掉，
  // 校验器在这里保持沉默就等于给了一条永远不响应的路由一个绿 VALID。
  if (packs.length) {
    const dirs = serveDirs({});
    const routeMounts = coreMounts({ ...dirs, simDir: path.join(REPO_ROOT, 'server', 'sim') });
    const routeIssues = [];
    for (const pack of packs) {
      const routes = Array.isArray(pack.routes) ? pack.routes : [];
      if (!routes.length) continue;
      for (const route of routes) {
        if (!route || typeof route.path !== 'string') continue;
        const shadow = coreRouteShadow(route.path, { mount: routeMounts });
        if (!shadow) continue;
        const issue = (shadow.kind === 'exact' || shadow.kind === 'file')
          ? {
            field: 'routes', code: 'ROUTE_CLASHES_CORE', severity: 'error',
            message: shadow.kind === 'exact'
              ? `path ${route.path} is an endpoint the engine serves itself — the server drops this declaration at boot`
              : `path ${route.path} is already served by the core mount "${shadow.mount}" (${shadow.file}) — the server drops this declaration at boot`,
            hint: 'pick a path nobody owns, ship the file through pack.json.assets, or compute it at runtime with host.route() under "/mod/<pack id>/…"',
          }
          : {
            field: 'routes', code: 'ROUTE_IN_ENGINE_NAMESPACE', severity: 'warning',
            message: `path ${route.path} sits inside the engine's "${shadow.prefix}" namespace — it serves today, and yields automatically if a core file with that name ever appears`,
          };
        // 路由问题进 `packs[].issues`：`--json` 的既有形状就是「一个包的问题都在它自己那一行里」，
        // 而 test/workshopValidateRoutes.test.js 正是按那个形状读的。界面要按层分组时自己推 kind
        // （`kindOfCode`）—— 所以这里**不**再往 `checks` 里放一份，免得同一件事被数两遍。
        const entry = report.packs.find((x) => x.pack === pack.id);
        if (entry) entry.issues.push(issue);
        routeIssues.push({ ...issue, pack: pack.id });
      }
    }
    if (routeIssues.length) report.routes = routeIssues;
  }
  // ---- 语音层：形状由加载器判；只有文件系统能回答「点名的文件真的在、而且这条路真发得出去」。
  for (const pack of packs) {
    const voices = pack.voices || {};
    const voiceLangs = pack.voiceLangs || {};
    const langs = Object.keys(voiceLangs);
    if (!Object.keys(voices).length && !langs.length) continue;
    const checkTable = (table, lang) => {
      let n = 0;
      for (const [charId, slots] of Object.entries(table)) {
        for (const [slot, files] of Object.entries(slots)) {
          n += files.length;
          for (const rel of files) {
            const abs = path.join(pack.dir, 'assets', rel);
            const ext = path.extname(rel).toLowerCase();
            const at = lang ? `${lang}:${charId}.${slot}` : `${charId}.${slot}`;
            if (!WORKSHOP_ASSET_TYPES.has(ext)) {
              push(report.checks, 'voice', { field: at, code: 'VOICE_TYPE_UNSERVABLE', severity: 'error', message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`, hint: 'the route allowlists images / audio / fonts / atlas / skel — an .mp3, .ogg or .wav plays' }, ['checks'], pack.id);
            } else if (!fs.existsSync(abs)) {
              push(report.checks, 'voice', { field: at, code: 'VOICE_FILE_MISSING', severity: 'error', message: `"${rel}" is declared in pack.json but not on disk at ${abs}`, hint: 'files must live inside the pack: <pack>/assets/<path>' }, ['checks'], pack.id);
            }
          }
        }
        const known = OFFICIAL_IDS.has(charId) || Object.keys(pack.files.chess || {}).includes(charId);
        if (!known) {
          push(report.checks, 'voice', { field: lang ? `${lang}:${charId}` : charId, code: 'VOICE_UNKNOWN_OPERATOR', severity: 'warning', message: `${charId} is neither an official operator nor one this pack adds — these lines can never play`, hint: 'add the operator to this pack\'s chess.json, or ignore this if another installed pack adds it' }, ['checks'], pack.id);
        }
      }
      return n;
    };
    const entry = rowFor(report, pack.id);
    const lines = checkTable(voices, null);
    // `voices` stays absent for a pack that declares no default-dub line (a 只带其它语种的包), so its report reads
    // the same as before.
    if (entry && Object.keys(voices).length) entry.voices = { operators: Object.keys(voices).length, lines };
    let langLines = 0;
    for (const lang of langs) langLines += checkTable(voiceLangs[lang], lang);
    if (entry && langs.length) entry.voiceLangs = { langs, lines: langLines };
    report.voiceLines = (report.voiceLines || 0) + lines + langLines;
  }

  // ---- 装备图标层：同上，外加「这个图标 id 有没有人用」（客户端按 id 查表，没人用的那张永远显示兜底图）。
  for (const pack of packs) {
    const icons = pack.itemIcons || {};
    if (!Object.keys(icons).length) continue;
    const entry = rowFor(report, pack.id);
    const ownIconIds = new Set(Object.values(pack.files.items || {}).flatMap((rec) => (rec ? [rec.iconId, rec.trapId] : [])).filter((id) => typeof id === 'string' && id));
    // 与 art / route 同一种归位：装备图标的问题进**这包那一行**（`--json` 的既有形状，
    // test/workshopItemIcons.test.js 读的就是 `packs[0].issues`），界面按层分组时用 `kindOfCode()` 现推。
    const add = (issue) => { if (entry) entry.issues.push(issue); };
    for (const [id, rel] of Object.entries(icons)) {
      const abs = path.join(pack.dir, 'assets', rel);
      const ext = path.extname(rel).toLowerCase();
      if (!WORKSHOP_ASSET_TYPES.has(ext)) {
        add({ field: `itemIcons.${id}`, code: 'ITEM_ICON_TYPE_UNSERVABLE', severity: 'error', message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`, hint: 'the route allowlists images / audio / fonts / atlas / skel — a .png, .jpg or .webp shows' });
      } else if (!fs.existsSync(abs)) {
        add({ field: `itemIcons.${id}`, code: 'ITEM_ICON_FILE_MISSING', severity: 'error', message: `"${rel}" is declared in pack.json but not on disk at ${abs}`, hint: 'files must live inside the pack: <pack>/assets/<path>' });
      }
      if (!OFFICIAL_ITEM_ICON_IDS.has(id) && !ownIconIds.has(id)) {
        add({ field: `itemIcons.${id}`, code: 'ITEM_ICON_UNKNOWN_ITEM', severity: 'warning', message: `${id} is neither an official item icon nor one this pack adds — this image can never be shown`, hint: 'give an item of this pack this iconId / trapId, or ignore this if another installed pack adds it' });
      }
    }
    if (entry) entry.itemIcons = Object.keys(icons).length;
    report.itemIcons = (report.itemIcons || 0) + Object.keys(icons).length;
  }

  // ---- 外观素材层（pack.json 的 art）：客户端在这些情况下**一条日志都不打**（退回菱形贴图，或模型出来但不动）。
  for (const pack of packs) {
    const art = pack.art || {};
    if (!Object.keys(art).length) continue;
    const assetsDir = path.join(pack.dir, 'assets');
    // art 的问题**只**进这包那一行（`--json` 与 CLI 文本的既有形状：test/workshopValidateArtTables.test.js
    // 正是按 `packs[].issues` 读 `ART_UNKNOWN_ID` 的）。界面要按层分组时用 `kindOfCode()` 现推 ——
    // 同一条问题在两个数组里各存一份，代价是一个「数了两遍」的账，那正是收尾那条自检在防的事。
    const entry = rowFor(report, pack.id);
    const add = (issue) => {
      if (entry) entry.issues.push(issue);
    };
    const checkFile = (field, rel) => {
      const abs = path.join(assetsDir, rel);
      const ext = path.extname(rel).toLowerCase();
      if (!WORKSHOP_ASSET_TYPES.has(ext)) {
        add({ field, code: 'ART_TYPE_UNSERVABLE', severity: 'error', message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`, hint: 'the route allowlists images / audio / fonts / atlas / skel — appearance art wants .png / .atlas / .skel' });
        return false;
      }
      if (!fs.existsSync(abs)) {
        add({ field, code: 'ART_FILE_MISSING', severity: 'error', message: `"${rel}" is declared in pack.json but not on disk at ${abs}`, hint: 'files must live inside the pack: <pack>/assets/<path>' });
        return false;
      }
      return true;
    };
    const checkSpine = (spine, field, inheritsAnims = false) => {
      const skelRel = spine.skel;
      const atlasRel = spine.atlas;
      const skelOk = checkFile(`${field}.skel`, skelRel);
      checkFile(`${field}.atlas`, atlasRel);
      const derivedAtlas = skelRel.replace(/\.skel$/i, '.atlas');
      if (atlasRel !== derivedAtlas) {
        add({ field: `${field}.atlas`, code: 'ART_ATLAS_NAME_MISMATCH', severity: 'error', message: `the loader derives the atlas from the skeleton ("${derivedAtlas}") but pack.json names "${atlasRel}"`, hint: 'put the atlas beside the skeleton under the same name: <name>.skel + <name>.atlas' });
      }
      const atlasAbs = path.join(assetsDir, atlasRel);
      let atlasText = null;
      if (fs.existsSync(atlasAbs)) { try { atlasText = fs.readFileSync(atlasAbs, 'utf8'); } catch { atlasText = null; } }
      const info = atlasText === null ? null : atlasInfo(atlasText);
      if (info) {
        for (const page of info.pages) {
          if (!fs.existsSync(path.join(path.dirname(atlasAbs), page))) {
            add({ field: `${field}.atlas`, code: 'ART_ATLAS_PAGE_MISSING', severity: 'error', message: `the atlas lists the page "${page}" but it is not beside it (${path.join(path.dirname(atlasAbs), page)})`, hint: 'every page name in the .atlas is a png in the same folder — one model may have more than one page' });
          }
        }
        if (!info.hasSize) {
          add({ field: `${field}.atlas`, code: 'ART_ATLAS_NO_SIZE', severity: 'warning', message: 'at least one page of this atlas has no "size: W,H" line', hint: 'pixi-spine divides by the page size — add `size: <w>,<h>` under the page name (tools/assets/atlas.mjs writes it)' });
        }
        if (typeof spine.pma === 'boolean' && spine.pma !== info.hasPma) {
          add({ field: `${field}.pma`, code: 'ART_PMA_HINT', severity: 'warning', message: `the manifest says pma: ${spine.pma} but the atlas ${info.hasPma ? 'declares' : 'does not declare'} "pma: true"`, hint: 'the client premultiplies exactly when the manifest says pma: true — make both sides agree' });
        }
      }
      const declaredAnims = roleAnimationNames(spine.anims);
      if (!declaredAnims.length) {
        add({
          field: `${field}.anims`, code: 'ART_SPINE_NO_ANIMS', severity: inheritsAnims ? 'warning' : 'error',
          message: inheritsAnims
            ? 'this spine declares no animation role (`anims`) — the official entry\'s own anims are kept, so the model will still animate'
            : 'this spine declares no animation role (`anims`), and there is no official entry to inherit one from',
          hint: 'the client\'s validSpine requires an anims object and plays the roles it names — without it the unit falls back to a flat portrait',
        });
      }
      if (!skelOk) return;
      let skelInfo;
      try { skelInfo = parseSkel(new Uint8Array(fs.readFileSync(path.join(assetsDir, skelRel)))); } catch (e) {
        add({ field: `${field}.skel`, code: 'ART_SPINE_VERSION', severity: 'error', message: `this .skel cannot be read as a Spine 3.8 skeleton (${e && e.message ? e.message : e})`, hint: 'export the model as Spine 3.8.x binary — the client parses it with @pixi-spine/runtime-3.8 and stays silent on failure' });
        return;
      }
      if (!/^3\.8\./.test(skelInfo.version)) {
        add({ field: `${field}.skel`, code: 'ART_SPINE_VERSION', severity: 'error', message: `the skeleton's version is "${skelInfo.version}" — only 3.8.x is accepted`, hint: 're-export as 3.8.x: the shipped parser may also read 3.7 / 4.0 / 4.1, but every official model is 3.8' });
      }
      if (declaredAnims.length) {
        const known = new Set(skelInfo.animations);
        const unknown = declaredAnims.filter((n) => !known.has(n));
        if (unknown.length) {
          const list = skelInfo.animations.length > 12 ? `${skelInfo.animations.slice(0, 12).join(', ')}, …` : skelInfo.animations.join(', ');
          add({ field: `${field}.anims`, code: 'ART_ANIM_UNKNOWN', severity: 'error', message: `these animation names are not in the skeleton: ${unknown.join(', ')}`, hint: skelInfo.animations.length ? `the skeleton has ${skelInfo.animations.length}: ${list}` : 'the skeleton has no animations at all' });
        }
      }
    };
    for (const [table, entries] of Object.entries(art)) {
      for (const [id, a] of Object.entries(entries)) {
        for (const f of ART_ENTRY_PATH_FIELDS[table] || []) {
          if (typeof a[f] === 'string') checkFile(`art.${table}.${id}.${f}`, a[f]);
        }
        if (!a.spine) continue;
        const inherits = OFFICIAL_ART_IDS[table] ? OFFICIAL_ART_IDS[table].has(id) : false;
        if (ART_SPINE_NESTED_TABLES.has(table)) {
          for (const [side, spine] of Object.entries(a.spine)) checkSpine(spine, `art.${table}.${id}.spine.${side}`, inherits);
        } else {
          checkSpine(a.spine, `art.${table}.${id}.spine`, inherits);
        }
      }
    }
    const ownIds = { chars: ownCharIds(pack), enemies: new Set(Object.keys(pack.files.enemies || {})), tokens: ownTokenIds(pack) };
    // `entry.art` 是**这个包自己声明的 art 条目数**（`--json` 的既有形状，test/workshopValidateArtTables.test.js
    // 直接读它来证明扁平表那一趟循环真的走过）。
    let artCount = 0;
    for (const entries of Object.values(art)) artCount += Object.keys(entries).length;
    if (entry) entry.art = artCount;
    report.art = (report.art || 0) + artCount;
    const unknownHint = {
      chars: 'point a chess record of this pack at it (assets.spine = "<id>"), or ignore this if another installed pack adds that operator',
      enemies: 'name it in this pack\'s waves / enemies.json, or ignore this if another installed pack adds that monster',
      tokens: 'list it in a chess record of this pack (`tokens`), or ignore this if another installed pack adds that summon',
    };
    for (const [table, entries] of Object.entries(art)) {
      // 两张**扁平图标表**（`art.skills` / `art.profSub`）不在这条判据里：它们没有 spine、没有 ownIds 那一栏。
      if (ART_FLAT_TABLES.has(table)) continue;
      const official = OFFICIAL_ART_IDS[table];
      const own = ownIds[table];
      if (!official || !own) continue;
      for (const id of Object.keys(entries)) {
        if (official.has(id) || own.has(id)) continue;
        add({ field: `art.${table}.${id}`, code: 'ART_UNKNOWN_ID', severity: 'warning', message: `${id} is neither in the official assets.json "${table}" table nor contributed by this pack — nothing can ever use this art`, hint: unknownHint[table] });
      }
    }
  }

  // ---- 助战声明层：判据与叠加层共用 `workshopSupportEntries`，所以作者看到的就是加载器做的。
  for (const pack of packs) {
    if (!Array.isArray(pack.support) || !pack.support.length) continue;
    const { entries, errors } = workshopSupportEntries({ chess: pack.files.chess || {} }, [pack]);
    for (const e of errors) {
      push(report.checks, 'support', { field: 'support', code: e.code, severity: 'error', message: e.reason }, ['checks'], pack.id);
    }
    const entry = rowFor(report, pack.id);
    // `entry.support` 的既有形状（`<id> → 阶 <n>`）保持原样：它是**用 CLI 的人读的**，
    // 而 `shared/` 是被 i18n 扫描的一层（未包裹的中文字面量会让 test/i18n.test.js 红）。
    // 所以这里用 `t()` 包一层 —— CLI 进程里没人 `setLang`，`t()` 恒等返回中文，输出逐字节不变。
    if (entry && entries.length) entry.support = entries.map((e) => t('{0} → 阶 {1}', e.id, e.tier));
    report.supportEntries = (report.supportEntries || 0) + entries.length;
  }

  // ---- 行为层（kits/<chessId>.js）：import 只证明它能解析、默认导出是个函数；静默的那些失败
  // （没人发的钩子名、Math.random/Date.now、只在服务器解析得开的相对 import）由静态扫描抓（shared/kitAuthoring.js）。
  if (loaded.packs.length) {
    const merged = loadData(DATA_DIR, { log, workshopDir: root });
    const knownIds = new Set(Object.keys(merged.chess || {}));
    const knownTokenIds = new Set(Object.keys(merged.tokens || {}));
    const kitInfo = await loadWorkshopKits(loaded, { log, knownIds, knownTokenIds });
    const ambiguousIds = [...knownIds].filter((id) => knownTokenIds.has(id));
    const explained = new Set();
    const staticCoding = [];
    for (const pack of loaded.packs) {
      const kitDir = path.join(pack.dir, 'kits');
      if (!fs.existsSync(kitDir)) continue;
      const ownChessIds = Object.keys((pack.files && pack.files.chess) || {});
      const ownTokenIdsList = Object.keys((pack.files && pack.files.tokens) || {});
      const ownCharIdsList = Object.keys(pack.operators || {});
      for (const name of fs.readdirSync(kitDir).sort()) {
        // ⚠️ 与装载器**同判**（`server/workshop.js:1249-1253`，逐字同形）：`_` 前缀的是**共享件**不是 kit；
        // 不是普通文件（子目录、socket、坏链接）也不是 kit。2026-10-15 实测的缺陷：这里原来只判 `.js` 后缀 ⇒
        // `kits/_helper.js` 被报 `KIT_NO_TARGET`、一个名为 `x.js` 的**目录**让 `readFileSync` 当场抛 EISDIR，
        // 而装载器两种情况都会安静跳过 —— 校验器比装载器严，作者会看到一条**永远修不掉**的错。
        if (!name.endsWith('.js') || name.startsWith('_')) continue;
        const file = path.join(kitDir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile()) continue;
        const id = name.slice(0, -'.js'.length);
        const issues = validateKit(fs.readFileSync(file, 'utf8'), {
          id, ownChessIds, ownCharIds: ownCharIdsList, ownTokenIds: ownTokenIdsList, overrides: pack.overrides, ambiguousIds,
        }).map((i) => ({ ...i, packId: pack.id, field: `kits/${pack.id}/${name}${i.field && i.field !== 'source' ? ` · ${i.field}` : ''}` }));
        if (issues.some((i) => i.severity === 'error')) explained.add(`${pack.id}/${id}`);
        staticCoding.push(...issues);
      }
    }
    report.kits = { loaded: kitInfo.modules.map((m) => m.id), modules: kitInfo.modules, issues: staticCoding, errors: [] };
    // `staticCoding` 里每一条都带着自己属于哪个包（上面 `issues.push` 时挂的 `packId`）—— kit 这一层是
    // 唯一一层「一批问题来自多个包」的，所以它不能像别的层那样用循环变量 `pack`。
    for (const i of staticCoding) push(report.checks, 'kit', i, ['checks'], i.packId ?? null);
    for (const e of kitInfo.errors) {
      if (explained.has(`${e.pack}/${e.id}`)) continue;
      const issue = { field: `kits/${e.id}.js`, code: 'KIT', severity: 'error', message: `${e.pack}: ${e.reason}` };
      report.kits.errors.push(issue);
      push(report.checks, 'kit', issue, ['checks'], e.pack);
    }
  }

  // ---- 地图层：groundPaths / deployTiles 是**推导**出来的，这里重新推一遍再比。手改过网格却留下旧表的图
  // 看起来完好，却会把敌人送上一条这张图已经没有的路线 —— 这正是这一层存在的理由。
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.stages || {}).length)) {
    const data = loadData(DATA_DIR, { log, workshopDir: root });
    const officialStages = new Set(Object.keys(readJsonOr(path.join(DATA_DIR, 'stages.json'), {})));
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
        for (const i of validateStageRecord(j.rec, { id, officialIds: j.officialIds })) { stageIssues.push(i); push(report.checks, 'stage', i, ['checks'], pack.id); }
        if (!listedIn.has(id)) {
          const issue = { field: id, code: 'NOT_SELECTABLE', severity: 'warning', message: 'no mode lists this stage, so no match can ever pick it', hint: 'give the stage a `modes` array naming the modes it belongs to — the loader appends it to those' };
          stageIssues.push(issue); push(report.checks, 'stage', issue, ['checks'], pack.id);
        }
      }
    }
    if (stageIssues.length) report.stages = stageIssues;
  }

  // ---- 怪物层：be / attrPower 由数值推导，手打的值会换错数量的敌人。
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.enemies || {}).length)) {
    const officialEnemies = new Set(Object.keys(readJsonOr(path.join(DATA_DIR, 'enemies.json'), {})));
    const enemyIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      const merged = declared.size ? mergedData() : null;
      for (const [key, rec] of Object.entries(pack.files.enemies || {})) {
        const j = judgeRecord('enemies', key, rec, { declared, merged, officialIds: officialEnemies });
        for (const i of validateEnemy(j.rec, { key, officialIds: j.officialIds })) { enemyIssues.push(i); push(report.checks, 'enemy', i, ['checks'], pack.id); }
      }
    }
    if (enemyIssues.length) report.enemies = enemyIssues;
  }

  // ---- 出怪层：跨文件的静默失败最要命（刷出来的敌人没人定义 ⇒ 什么都不出；routeIndex 越界 ⇒ 走另一条路）。
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.waves || {}).length)) {
    const officialWaves = new Set(Object.keys(readJsonOr(path.join(DATA_DIR, 'waves.json'), {})));
    const knownEnemyKeys = new Set(Object.keys(loadData(DATA_DIR, { log, workshopDir: root }).enemies || {}));
    const waveIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      const merged = declared.size ? mergedData() : null;
      for (const [id, rec] of Object.entries(pack.files.waves || {})) {
        const j = judgeRecord('waves', id, rec, { declared, merged, officialIds: officialWaves });
        for (const i of validateWave(j.rec, { id, officialIds: j.officialIds, knownEnemyKeys })) { waveIssues.push(i); push(report.checks, 'wave', i, ['checks'], pack.id); }
      }
    }
    if (waveIssues.length) report.waves = waveIssues;
  }

  // ---- 装备层：引擎读 `params` 而不是 buffs，所以手打的 params 会让一件卡面正确的装备在局内什么都不做。
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.items || {}).length)) {
    const officialItems = new Set(Object.keys(readJsonOr(path.join(DATA_DIR, 'items.json'), {})));
    const merged = mergedData();
    const itemIssues = [];
    for (const pack of packs) {
      const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
      for (const [id, rec] of Object.entries(pack.files.items || {})) {
        const j = judgeRecord('items', id, rec, { declared, merged, officialIds: officialItems });
        for (const i of validateItem(j.rec, { id, officialIds: j.officialIds })) { itemIssues.push(i); push(report.checks, 'item', i, ['checks'], pack.id); }
        const m = (merged.items || {})[id];
        if (!m) {
          const issue = { field: id, code: 'NOT_MERGED', severity: 'error', message: 'the record did not reach the merged data' };
          itemIssues.push(issue); push(report.checks, 'item', issue, ['checks'], pack.id);
          continue;
        }
        if (!m.isGolden && m.goldenId && !(merged.items || {})[m.goldenId]) {
          const issue = { field: `${id}.goldenId`, code: 'GOLDEN_MISSING', severity: 'error', message: `the merge target "${m.goldenId}" is neither in this pack nor in the official data`, hint: 'emit the elite record too, or set upgradeNum 0 for a standalone item' };
          itemIssues.push(issue); push(report.checks, 'item', issue, ['checks'], pack.id);
        }
      }
    }
    // 这一层**总是**登记（哪怕一条问题都没有）：items 这一段在 CLI 的文本里是**无条件**打印的
    // （`items (装备):` + `OK`），test/itemEditor.test.js 正是按「干净的一包也要看见这一段」读的。
    report.items = itemIssues;
  }

  // ---- 汇总：`packs[]`（CLI 的逐包报告）与 `checks[]`（界面的打平报告）**必须给出同一个总数**。
  //
  // ⚠ 一条问题只入账一次，按**它真正在哪个数组里**分：
  //   * `packs[].issues` —— 逐记录（模型层）、**静态路由**、**外观素材**（这两层的文本形状印在包那一行里：
  //     `--json` 的既有形状 + test/workshopValidateRoutes.test.js 与 workshopValidateArtTables.test.js 读的就是它）；
  //   * `report.engine` —— 第 3 层真引擎；
  //   * `checks[]` —— 其余各层（语音 / 图标 / 助战 / kit / 地图 / 怪物 / 出怪 / 装备）。
  // 两个数组各存一份会让总数翻倍，而报告看上去毫无异常 —— 下面那条自检就是钉这件事的。
  for (const p of report.packs) for (const i of p.issues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  for (const i of report.engine) (i.severity === 'error' ? report.errors++ : report.warnings++);
  for (const c of report.checks) (c.severity === 'error' ? report.errors++ : report.warnings++);
  // 自检：入账的条数必须等于**报告里真实存在的**条数（`report.routes` 是路由那批的副本视图，不单独入账）。
  let counted = 0;
  for (const p of report.packs) counted += p.issues.length;
  counted += report.engine.length;
  counted += report.checks.length;
  if (report.errors + report.warnings !== counted) {
    throw new Error(`workshopValidate: 计数不自洽（${report.errors}+${report.warnings} != ${counted}）—— 有一条问题没被数到、或被数了两遍`);
  }
  report.errorCount = report.errors;
  report.warningCount = report.warnings;
  return report;
}

/** 一个包的装载结论（`/api/packs/<id>/validate` 与界面横幅用的那一格）。 */
export function packVerdict(loaded, packId) {
  const err = (loaded.errors ?? []).find((e) => e.pack === packId);
  if (err) return { status: 'refused', reason: err.reason, code: 'PACK_LOAD' };
  const foreign = (loaded.foreign ?? []).find((f) => f.pack === packId);
  if (foreign) return { status: 'foreign', reason: foreign.reason, code: 'PACK_FOREIGN' };
  const hit = (loaded.packs ?? []).find((p) => p.id === packId);
  return hit ? { status: 'loaded', reason: null, code: null } : { status: 'absent', reason: null, code: null };
}

export { formatIssues };
