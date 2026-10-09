// shared/workshop.js — 创意工坊 (community workshop) pack format and the overlay merge, pure ESM shared by the server
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
// (the loader, the match data) and the browser (which reads the same merged /data/*.json).
//
// A workshop pack is DATA ONLY at this layer. It never edits `data/*.json` — the loader applies an additive overlay on
// top of the generated official data just before that object is frozen (server/data.js loadData). Two consequences are
// load-bearing for the whole feature:
//
//   1. `data/*.json` stays byte-identical, so the official integrity suite (test/data.test.js, incl. the offline
//      rebuild that must reproduce data/ byte-for-byte) keeps passing and the official content is a clean baseline.
//   2. The overlay runs BEFORE deepFreeze, so every consumer (match engine, sim, client) sees one ordinary merged
//      object and no downstream code needs to know workshop content exists.
//
// Overlay rule: **an id the official data already has is NOT replaced** unless the pack lists it in
// `pack.json.overrides` as `"<file>:<id>"`. Additive by default, explicit to override — a pack that silently redefines
// an official operator would otherwise corrupt every match on the server.
//
// Pack layout (`workshop/<packId>/`):
//   pack.json        { id, name, version, author, license, description, gameVersion, content: [file…], overrides: [] }
//   chess.json       { [chessId]:  record }   ← same shape as data/chess.json
//   items.json enemies.json stages.json waves.json tokens.json bosses.json factions.json   (any file in `content`)
//
// The behaviour layer (a pack's `kits/*.js`, wired to the battle.on(...) hook bus) is deliberately NOT part of this
// module: it is code, it is loaded by the server only, and it is documented in docs/WORKSHOP.md.

/** Data files a pack may contribute to. Deliberately a conservative subset of data/: `config` is excluded because a
 * pack that rewrote the economy or the round schedule would change the rules rather than the content. */
export const WORKSHOP_CONTENT_FILES = Object.freeze([
  'chess', 'units', 'items', 'enemies', 'stages', 'waves', 'tokens', 'bosses', 'factions', 'garrisons', 'bands', 'bonds', 'effects', 'choices',
]);

/** Files whose records are keyed by an id field that must equal the map key (catches copy-paste mistakes in a pack). */
const ID_FIELD_BY_FILE = Object.freeze({
  chess: 'chessId', units: 'charId', items: 'id', enemies: 'key', stages: 'stageId', waves: 'templateId',
  tokens: 'tokenId', bosses: 'bossId', factions: 'factionId', garrisons: 'garrisonId',
  bands: 'bandId', bonds: 'bondId', effects: 'effectId', choices: 'id',
});

/**
 * `units.json` 的一条干员记录**必须有的那几个字段**（docs/WORKSHOP.md §1.2）。
 *
 * 为什么只查这几个：这条记录是 `data/backups.json` 的 `units[charId]`，形状由**上游官方数据**决定（14 个顶层键，
 * 见 `test/modSurface.test.js`）。我们**不复制官方 schema** —— 复刻一份就是给自己加一个会漂移的第二真相，官方每次
 * 加字段我们都要跟一次；而下游（`server/sim`、`server/match`）真正读的也只是这几个键。其余字段一律照抄
 * （与 `ART_TABLES` 同一个哲学：作者照抄官方条目，我们不重新发明形状）。
 *
 * 每一条的形状用一套**声明**写出来（名字 + 一个判据 + 缺了它下游会怎样），所以校验、拒绝码与提示文案只有一个来源。
 */
export const UNIT_REQUIRED_FIELDS = Object.freeze([
  {
    key: 'charId',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_CHAR_ID',
    detail: 'must be a non-empty string (it is how the client asks for this operator\'s data)',
  },
  {
    key: 'name',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_NAME',
    detail: 'must be a non-empty string (the operator shows up nameless otherwise)',
  },
  {
    key: 'rarity',
    ok: (v) => Number.isInteger(v),
    code: 'UNIT_BAD_RARITY',
    detail: 'must be an integer (the star rating; the 自选池 screen draws it)',
  },
  {
    key: 'profession',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_PROFESSION',
    detail: 'must be a non-empty string (WARRIOR / SNIPER / … — the project\'s own profession names, not DEFENDER/VANGUARD)',
  },
  {
    key: 'subProfessionId',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_SUB_PROFESSION',
    detail: 'must be a non-empty string (the branch; `assets.prof.sub` carries its icon)',
  },
  {
    key: 'forms',
    ok: (v) => isPlainObj(v) && Object.keys(v).length > 0,
    code: 'UNIT_BAD_FORMS',
    detail: 'must be a non-empty object of "elite/level/skill/module" ranks (the operator has no stats without one)',
  },
]);

/** Pack ids: a short filesystem- and URL-safe slug (it names the directory under workshop/). */
export const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * `pack.json` 的**顶层键闭集** —— 这份格式认识的每一个字段，一个不多一个不少。
 *
 * 为什么需要它（本刀最重要的那条纪律）：一个**声明了、而我们不认识的键**如果只是被读过去，作者看到的是
 * 「pack.json 合法、包加载了、可我写的那件事没发生」。这正是三个社区 mod 反复撞上的那面墙：
 *   * `variants`（fanpack G-01，口径/变体）—— `normalizePackManifest` 从没读过它，`{content:["chess","variants"]}`
 *     归一化之后只剩 `["chess"]`，作者以为写了；
 *   * `skins`（fanpack G-05）—— 与 `variants` 同一个形状：静默丢；
 *   * `i18n`（fanpack G-04）—— 归一化结果里根本没有这个键。
 * 三者都是「写了等于没写」，而且失败的方向是**静默**。所以这一层的判据是：任何一个不在下面这张表里的顶层键，
 * **点名整包拒绝**（`PACK_UNKNOWN_FIELD`），理由里列出这份格式认识的字段 —— 作者一眼能看到自己该写哪个。
 *
 * 这不是「不支持新特性」的门：一个我们**故意**不支持的键（`config`，见 `WORKSHOP_CONTENT_FILES` 的注释）与一个
 * 拼错的键在作者眼里是同一件事（都是「没用」），而拒绝的错误文案会把两种情况都解释清楚（"config" is not a
 * field of this pack format）。方向也一致：宁可当场说「这张表没有通道」，也不要收下一份没人读的声明。
 *
 * 加字段的规矩：新字段进这张表的那一刀，必须同时（a）在 `normalizePackManifest` 里给它一个解析分支、
 * （b）决定它算不算贡献项、（c）把它的文件并进 `identifyPack` 的哈希清单（能改变一端行为的声明不进哈希，
 * 同一个摘要下就有两种行为，DESIGN §28.2）。
 */
export const PACK_FIELDS = Object.freeze([
  // 身份与元信息
  'id', 'name', 'version', 'author', 'license', 'description', 'gameVersion', 'game', 'api', 'layer', 'combat',
  // 内容与覆盖
  'content', 'overrides',
  // 素材与声明（贡献项，见 EMPTY_PACK 那一处）
  'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art', 'support', 'operators', 'i18n',
  // 行为开关（**不是**贡献项）
  'playtest',
  // 中间层四组能力声明（DESIGN §28.13）
  'assets', 'client', 'server', 'routes',
]);

/** 未知顶层键的拒绝码（见 `PACK_FIELDS`）。 */
export const PACK_UNKNOWN_FIELD_CODE = 'PACK_UNKNOWN_FIELD';
/** 一个顶层键在错误文案里最多显示多少个字符（一个手写坏掉的 pack.json 可以有几千字符的键）。 */
const MAX_KEY_SHOWN = 60;

/**
 * 一条 `pack.json.overrides` 声明的形状：`"<文件>:<id>"`（例 `chess:chess_char_1_01_a`）。**只此一份**：
 * `normalizePackManifest` 下面用它过滤，编辑器的写入端与校验器用它拒绝（两处正则不一致的话，界面会写出一个
 * 加载器悄悄丢掉的声明 —— 那正是「写了等于没写」这一类静默失败）。
 */
export const OVERRIDE_ENTRY_RE = /^([a-z]+):([A-Za-z0-9_\-.:]{1,64})$/;

/**
 * The URL prefix a pack's own media is served under: `<prefix><packId>/<path inside that pack's assets/>`
 * (server/index.js serves the route, docs/WORKSHOP.md §5). One source of truth, because the voice URLs this module
 * writes into the data must be exactly the ones that route answers.
 */
export const WORKSHOP_MEDIA_PREFIX = '/workshop-assets/';

/**
 * The URL prefix a pack's **C-layer panel module** is served under: `<prefix><packId>/<module path inside the pack>`
 * (DESIGN §28.8, docs/WORKSHOP.md §1.9.3). The twin of `WORKSHOP_MEDIA_PREFIX` on the other side of the line
 * `/workshop-assets` draws: that route serves a pack's MEDIA and therefore refuses `.js`; this one serves its CODE and
 * therefore serves nothing else. One source of truth, because a URL the loader builds and a route that answers it must
 * be the same string — and because the browser-side guard (`public/js/ui/extensions.js`) accepts exactly this prefix.
 */
export const WORKSHOP_PANEL_PREFIX = '/workshop-panels/';

/**
 * The URL prefix a pack's **declared resource container and manifest** are served under
 * (`pack.json.assets`, DESIGN §28.13, docs/WORKSHOP.md §1.9.4): the twin of `WORKSHOP_PANEL_PREFIX` for the
 * `assets` declaration, and deliberately a prefix of its own rather than a branch of `/workshop-assets` — that route
 * serves a pack's MEDIA under an extension allowlist and knows nothing about a pack's ROOT, while this one serves two
 * files the manifest itself names (a `.spresources` container, which no allowlist covers, and a `.json` table).
 * Widening `/workshop-assets` would have traded one narrow rule for two looser ones; a separate prefix keeps both
 * maps "only the URLs the loader registered", which is the discipline every pack-scoped route here follows.
 */
export const WORKSHOP_RESOURCE_PREFIX = '/workshop-resources/';
/** Record ids follow the wire-id charset (shared/protocol.js isId) so an id can travel in a message. */
const RECORD_ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

import { VOICE_SLOTS, VOICE_LANGS, DEFAULT_VOICE_LANG, MOD_API_VERSION } from './constants.js';
import { SOURCE_LANG, isLangCode } from './i18nPacks.js';
import { isSupportTier } from './support.js';
import { isVersionRange, appVersionMatches } from './packs.js';
import { MOD_LAYERS } from './modIdentity.js';
import { requiredUnitForms } from './diy.js';
// `intercepts` 是「分发前的准入钩子拦哪几个消息类型」，所以它的**唯一真相**必须是 `C2S` 本身（DESIGN §28.13）：
// 一个写在 `intercepts` 里而协议不认识的类型，只会让作者以为钩子拦住了什么。同一条依赖方向已有先例 ——
// `shared/modIdentity.js` 的线格式就被 `shared/protocol.js` 反过来 re-export（那两个模块之间的唯一箭头）。
import { C2S } from './protocol.js';

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (error, detail) => ({ ok: false, error, detail });
/** 一个可选的字符串字段：非空字符串就裁剪，其它一律 null（缺省与写错都读成「没声明」）。 */
const strField = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** 包内素材路径：相对、在包自己的 `assets/` 下、无穿越。语音、各类图标、外观素材共用这一条规则。 */
const isSafeAssetPath = (p) =>
  typeof p === 'string' && !!p && !p.startsWith('/') && !p.includes('\\')
  && !p.split('/').some((seg) => seg === '..' || seg === '.') && !/^[A-Za-z]:/.test(p);

/** 包内**相对路径**（`assets/` 之外的那些：资源容器、清单、包内模块、策略文件）。同一条安全规则，
 *  只是不要求它住在 `assets/` 下 —— 一条路径要么相对、要么点名拒绝，绝不静默丢掉。 */
const isSafeRelativePath = (p, max = 200) =>
  typeof p === 'string' && p.length > 0 && p.length <= max && isSafeAssetPath(p);

/** 从 `i` 处开始的键序（`JSON.parse` 保留书写顺序），与这个文件里其它「键序是清单字节的一部分」的地方同一做法。 */
const stableStringList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))].sort() : []);

// ---------------------------------------------------------------------------------------------------------------
// 四组中间层能力声明（DESIGN §28.13，《扩展提案》A 段）
//
// 这四组字段是**纯声明**：本轮没有一条行为读它们（分发前钩子、只读路由、C 层注册点与资源容器都是 B 段）。
// 它们存在的理由是「今天表达不了」：一个完整资源包导入/校验/准入的 mod 在我们的 A 层什么都不贡献，
// `pack.json` 没有地方说它要什么，于是两边都判它 `EMPTY_PACK`（`_up/mod4-pack/pack/validator-verdict.json`）。
//
// 三条载重纪律：
//   1. **默认缺省 = 今天逐字节不变**。归一化结果里**只在清单真的声明了这个键时**才多出这个键
//      （`normalizePackManifest` 末尾的 `declared` 循环），否则一个没声明新字段的包的归一化清单与内容哈希
//      都会变 —— 那会让所有已存在的包摘要改变、房间的摘要闸门误判（DESIGN §28.2）。
//   2. **声明了就必须进身份哈希**：能改变一端行为的声明不在哈希里，同一个摘要下就有两种行为。这里靠上面那条
//      实现：声明进了归一化清单，`identifyPack` 哈希的就是归一化清单（`canonicalJson(pack)`）。
//   3. **形状不对 / 未知键 / 非法值一律点名拒绝**，不静默丢弃。未知键尤其重要：一个把 `"container"` 写成
//      `"containers"` 的包如果只是被忽略，作者看到的是「包合法、但资源没生效」。
// ---------------------------------------------------------------------------------------------------------------

/** `assets.serverPolicy`（DESIGN §28.13）：`serve` = 素材照常由 `/workshop-assets` 送；`cache-only` =
 *  这个包要求 `/assets` / `/fonts` 回 412，只从包自己的缓存取（B 段实现，本轮只认这个值）。 */
export const ASSETS_SERVER_POLICIES = Object.freeze(['serve', 'cache-only']);
/** `assets.verify`：整包摘要的算法（旁挂 `<container>.sha256`）。今天只有 sha256 一种，枚举写出来是为了让
 *  第二个算法出现时**必须**改这里，而不是让校验器悄悄按 sha256 比对一份 md5。 */
export const ASSETS_VERIFY_ALGORITHMS = Object.freeze(['sha256']);
/** `assets` 的四个字段，一个不多一个不少。 */
const ASSETS_FIELDS = Object.freeze(['container', 'manifest', 'serverPolicy', 'verify']);
/** 资源容器的扩展名：它是 `tools/make-spresources.mjs` 的产物，由格式定义（`SPRES001` 魔数 + 压紧 JSON 头）。 */
const SPRESOURCES_EXT = '.spresources';

/**
 * `assets` 在**装载期**（文件真的在不在、摘要对不对）会用的两个拒绝码（DESIGN §28.13.3，B3a 段）。
 *
 * 为什么容器/清单的**文件级**失败沿用形状层的两个名字（`ASSETS_BAD_CONTAINER` / `ASSETS_BAD_MANIFEST`）而不是新造一对：
 * 作者看到的是同一条判据的两半 ——「你声明的那个容器」不相对、不是 `.spresources`、**或者这个文件不在包里**，
 * 三件事的修法都是「改 `assets.container` 指向一个真的在包里的 `.spresources`」。B2 段对面板模块正是这么做的
 * （形状层与服务面同名 `CLIENT_BAD_PANEL_MODULE`，理由写在 §28.13.3），本刀照抄那条先例，理由不同不另开码。
 * 一句话：**拒绝码点名的是「哪个字段坏了」，不是「在哪一层被发现的」。**
 *
 * `verify` 的两条是这一刀新增的，因为它们说的是另一件事 —— 容器在，但它的字节**不是**声明所要求的那份：
 *   * `ASSETS_VERIFY_FAILED` —— 旁挂 `<container>.sha256` 存在且可解析，但摘要对不上（或容器读不动 / 不是文件）；
 *   * `ASSETS_VERIFY_UNAVAILABLE` —— 声明了 `verify`，却找不到那份摘要（旁挂文件不在 / 格式不对）。
 * 两条都是**整个包被拒**，绝不静默放行：一个「校验失败但照旧服务」的资源包，会让客户端导入一份服务端已经
 * 知道是坏的字节，而唯一的信号是一行没人看的日志。
 */
export const ASSETS_FILE_CODES = Object.freeze({
  CONTAINER: 'ASSETS_BAD_CONTAINER',
  MANIFEST: 'ASSETS_BAD_MANIFEST',
  VERIFY_FAILED: 'ASSETS_VERIFY_FAILED',
  VERIFY_UNAVAILABLE: 'ASSETS_VERIFY_UNAVAILABLE',
});

/**
 * `client.panels[*].slot`（DESIGN §28.8 列出的四个宿主 → §28.13）：**闭枚举**。写成自由字符串的话，
 * 一个拼错的挂载点就是一个永远不出现的界面 —— 而挂载点是设计稿里已经数得清的那四个。
 */
export const CLIENT_PANEL_SLOTS = Object.freeze(['root.overlays', 'root.guide', 'screen.game.aside', 'screen.result.footer']);
/** 面板的字段：四个 + `styles`（这个面板自带的样式表，见 `CLIENT_PANEL_STYLES_EXT`）。 */
const CLIENT_PANEL_FIELDS = Object.freeze(['id', 'slot', 'module', 'order', 'gate', 'styles']);
/** 一个包能声明它需要哪些浏览器能力；缺一即「浏览器不支持」，不是「装了但静默不工作」（DESIGN §28.13）。 */
export const CLIENT_REQUIRES = Object.freeze(['serviceWorker', 'cacheStorage', 'webCrypto']);
/**
 * 面板自带样式表的扩展名 —— `.css` 是**唯一**一种。这个通道送的是**样式**：不是代码（`.js` 那条是 `module`），
 * 不是媒体（那条是 `assets` / `art`）。业主裁决 2026-10-10：两条路一起给 —— 主题变量写「几个值」，
 * 自带样式表写「一整份新组件的样式」。插件包那三份（`chat.css` 21 KB / `devices.css` 11.7 KB /
 * `title.css` 22 KB）走的是后者，光有变量装不下。
 */
const CLIENT_PANEL_STYLES_EXT = '.css';
/** 上限：一个面板最多带几份样式表、一份主题最多写几个变量 —— 「注入」这件事必须有界。 */
const CLIENT_MAX_PANEL_STYLES = 8;
const CLIENT_MAX_THEME_VARS = 200;
/** 一个主题里允许的字段，一个不多一个不少。 */
const CLIENT_THEME_FIELDS = Object.freeze(['vars']);
/** CSS 自定义属性的名字必须是 `--` 开头：一个不叫 `--x` 的键写进去等于什么都没发生（正是要消灭的静默失败）。 */
const CLIENT_THEME_VAR_RE = /^--[A-Za-z0-9_-]{1,64}$/;
/**
 * 一个变量值里**不许**出现的东西。这几个字符能让一条声明跑出它自己那一格：`;` 结束当前声明、`{}` 结束规则块、
 * `<` 是往标签里插内容的第一笔、换行同理。值本身是数据，不该有能力改结构。
 */
const CLIENT_THEME_VALUE_BAD = /[;{}<>\n\r]/;
const CLIENT_THEME_VALUE_MAX = 400;

/** `server.preDispatch`：包内模块、准入策略文件、以及它要拦的消息类型。三件都不能空 —— 少了 `policy`
 *  的钩子无法判定该放谁进来，那正是「声明了却没人能执行」这一类静默失败。 */
const PRE_DISPATCH_FIELDS = Object.freeze(['module', 'policy', 'intercepts']);
/** `server.meta` 的两个字段，一个不多一个不少（DESIGN §29）。 */
const META_FIELDS = Object.freeze(['module', 'registers']);
const META_MODULE_EXT = '.mjs';
/**
 * 对局元注册表的**七个键类别**（DESIGN §29）：`server/match/effectsMeta.js` 的 `MetaRegistry` 恰好有七个
 * 对应的方法（`garrison` / `band` / `bond` / `item` / `choice` / `effect` / `global`），一条注册键就是
 * `<类别>:<id>`。
 *
 * 为什么这一份名单住在 `shared/` 而不是从 `effectsMeta.js` 读出来：那个模块在服务端（`server/match/`），
 * 而形状层要在浏览器也会加载的共享文件里判形状。第二份真相会漂 —— 所以 `test/packMeta.test.js` 用**反射**
 * 把两者钉在一起：`MetaRegistry.prototype` 上那七个方法必须与这份名单逐字相同，少一个或多一个都失败。
 */
export const META_KEY_CLASSES = Object.freeze(['garrison', 'band', 'bond', 'item', 'choice', 'effect', 'global']);
/**
 * 注册键里**类别之后**那一段允许的字符。与 `server/match/effectsMeta.js` 的 `KEY_RE` 的尾段逐字相同
 * （`[A-Za-z0-9_\-.:#]`）—— 「形状层放行、运行时抛异常」是最坏的一种分工，所以两处必须一致
 * （`test/packMeta.test.js` 用反射与实例各钉一遍）。
 */
const META_KEY_TAIL_RE = /^[A-Za-z0-9_\-.:#]+$/;
/** 分发前钩子只能拦 `shared/protocol.js` 的 `C2S` 里真实存在的类型（DESIGN §28.13）。刻意从协议反推而不是
 *  在这里抄一份名单：抄一份就是第二个会漂移的真相，而漂移的方向是「作者声明了一个拦不住的类型」。 */
const PRE_DISPATCH_INTERCEPTS = Object.freeze(Object.keys(C2S).sort());
/** 准入模块的扩展名：它是**服务端**加载的 ESM，浏览器不加载。 */
const PRE_DISPATCH_MODULE_EXT = '.mjs';

/** `routes[*].cache`：只读路由允许的三种缓存语义。 */
export const ROUTE_CACHE_POLICIES = Object.freeze(['no-cache', 'no-store', 'public']);
/** 只读路由的键，一个不多一个不少。 */
const ROUTE_FIELDS = Object.freeze(['path', 'file', 'cache']);

/**
 * `pack.json.assets` —— 客户端资源容器（§28.13）。缺省 `serverPolicy: "serve"` / `verify: "sha256"`；
 * 形状照扩展提案逐字，**只在键存在时**才写回归一化清单（见上面第 1 条纪律）。
 * @returns {{ ok: true, decl: object } | { ok: false, error: string, detail: string }}
 */
function parseAssetsDecl(raw) {
  if (!isPlainObj(raw)) {
    return fail('ASSETS_DECL_BAD_SHAPE', 'assets must be an object: { container, manifest, serverPolicy?, verify? }');
  }
  for (const key of Object.keys(raw)) {
    if (!ASSETS_FIELDS.includes(key)) {
      return fail('ASSETS_UNKNOWN_FIELD', `assets: "${key}" is not a declared field (${ASSETS_FIELDS.join(', ')})`);
    }
  }
  if (!isSafeRelativePath(raw.container)) {
    return fail('ASSETS_BAD_CONTAINER', 'assets.container must be a relative path inside the pack (no absolute paths, no "..")');
  }
  if (!raw.container.endsWith(SPRESOURCES_EXT) || raw.container.length <= SPRESOURCES_EXT.length) {
    return fail('ASSETS_BAD_CONTAINER', `assets.container must name a "${SPRESOURCES_EXT}" file (e.g. "packs/resources-0.1.0${SPRESOURCES_EXT}")`);
  }
  if (!isSafeRelativePath(raw.manifest)) {
    return fail('ASSETS_BAD_MANIFEST', 'assets.manifest must be a relative path inside the pack (no absolute paths, no "..")');
  }
  if (!raw.manifest.endsWith('.json')) {
    return fail('ASSETS_BAD_MANIFEST', 'assets.manifest must name a .json file — it is the flat file table the client validates');
  }
  const serverPolicy = raw.serverPolicy === undefined ? 'serve' : raw.serverPolicy;
  if (!ASSETS_SERVER_POLICIES.includes(serverPolicy)) {
    return fail('ASSETS_BAD_SERVER_POLICY', `assets.serverPolicy must be one of: ${ASSETS_SERVER_POLICIES.join(', ')}`);
  }
  const verify = raw.verify === undefined ? 'sha256' : raw.verify;
  if (!ASSETS_VERIFY_ALGORITHMS.includes(verify)) {
    return fail('ASSETS_BAD_VERIFY', `assets.verify must be one of: ${ASSETS_VERIFY_ALGORITHMS.join(', ')}`);
  }
  return { ok: true, decl: { container: raw.container, manifest: raw.manifest, serverPolicy, verify } };
}

/** 面板模块的扩展名：这个通道送的是**代码**（浏览器 import 它），所以只有 `.js`。 */
const CLIENT_PANEL_MODULE_EXT = '.js';

/**
 * 一个面板的 `module` 必须是**包内相对路径**、不是 URL、且是一个 `.js`：装载器要知道去哪个包的哪一层读它，
 * 而一条 `https://…` 或 `/…` 会把「代码来自哪个包」这件事从身份里抹掉（DESIGN §28.2）；`.html` / `.json` 之类
 * 则是这条通道**永远送不出去**的东西（服务面只送 `.js`，与 `/workshop-assets` 拒 `.js` 是同一条线的两侧）。
 *
 * `.js` 这一条是 B2 段补的：A 段只判了「相对、不是 URL」，而一条 `module: "x.html"` 在形状层合法、进了身份哈希，
 * 客户端却永远拿不到它 —— 作者看到的是「包合法、面板不出现」。两次判据（形状层与服务面）现在一致。
 * 目录段不许以 `.` 开头：与 `/workshop-assets`、核心静态挂载对点文件的处理同一条规则。
 */
const isSafeModulePath = (p) =>
  isSafeRelativePath(p) && p.endsWith(CLIENT_PANEL_MODULE_EXT) && p.length > CLIENT_PANEL_MODULE_EXT.length
  && !p.split('/').some((seg) => seg.startsWith('.'))
  && !/^[a-z][a-z0-9+.-]*:/i.test(p);

/**
 * `pack.json.client` —— C 层注册点（§28.13）。`panels` 按 id 排序（与 `operators` 同一个理由：键序是清单字节的
 * 一部分，不能随作者书写顺序变）；`requires` 按闭枚举的次序归一化。
 * @returns {{ ok: true, decl: object } | { ok: false, error: string, detail: string }}
 */
function parseClientDecl(raw) {
  if (!isPlainObj(raw)) {
    return fail('CLIENT_DECL_BAD_SHAPE', 'client must be an object: { panels: [...], requires: [...] }');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'panels' && key !== 'requires' && key !== 'theme') {
      return fail('CLIENT_UNKNOWN_FIELD', `client: "${key}" is not a declared field (panels, requires, theme)`);
    }
  }
  // `client` 至少要声明**一件能用的东西**：面板，或主题变量。业主裁决 2026-10-10 之后主题可以单独存在 —— 一个只想
  // 换几个颜色的包不该为了合法而附一个空面板（那正是「多样性/简便性」要的东西）。`requires` 单独出现仍然被拒：
  // 一个既没有界面、也没有主题的能力声明等于什么都没声明。空 `panels` 数组照旧被拒（与不写没区别，却会让
  // 「这个包有客户端界面」这句话变成假的）。
  if (raw.panels !== undefined && !Array.isArray(raw.panels)) return fail('CLIENT_BAD_PANELS', 'client.panels must be an array of panel declarations');
  if (Array.isArray(raw.panels) && !raw.panels.length) return fail('CLIENT_BAD_PANELS', 'client.panels must declare at least one panel (drop the key instead of sending [])');
  if (raw.panels === undefined && raw.theme === undefined) {
    return fail('CLIENT_BAD_PANELS', 'client must declare at least one of: panels (client interfaces), theme (CSS variables) — a client block that declares neither, or only requires, says nothing at all');
  }
  const panels = [];
  const seen = new Set();
  for (const [i, panel] of (Array.isArray(raw.panels) ? raw.panels : []).entries()) {
    if (!isPlainObj(panel)) return fail('CLIENT_BAD_PANEL', `client.panels[${i}] must be an object: { id, slot, module, order?, gate? }`);
    for (const key of Object.keys(panel)) {
      if (!CLIENT_PANEL_FIELDS.includes(key)) {
        return fail('CLIENT_PANEL_UNKNOWN_FIELD', `client.panels[${i}]: "${key}" is not a panel field (${CLIENT_PANEL_FIELDS.join(', ')})`);
      }
    }
    if (typeof panel.id !== 'string' || !RECORD_ID_RE.test(panel.id)) {
      return fail('CLIENT_BAD_PANEL_ID', `client.panels[${i}].id: "${String(panel.id)}" is not a valid panel id`);
    }
    if (seen.has(panel.id)) {
      return fail('CLIENT_PANEL_DUPLICATE_ID', `client.panels: "${panel.id}" is declared twice (one id, one panel: the second would overwrite the first)`);
    }
    seen.add(panel.id);
    if (!CLIENT_PANEL_SLOTS.includes(panel.slot)) {
      return fail('CLIENT_BAD_PANEL_SLOT', `client.panels["${panel.id}"].slot must be one of: ${CLIENT_PANEL_SLOTS.join(', ')}`);
    }
    if (!isSafeModulePath(panel.module)) {
      return fail('CLIENT_BAD_PANEL_MODULE', `client.panels["${panel.id}"].module must be a relative path inside the pack (e.g. "resources/preloadModal.js")`);
    }
    if (panel.order !== undefined && !Number.isInteger(panel.order)) {
      return fail('CLIENT_BAD_PANEL_ORDER', `client.panels["${panel.id}"].order must be an integer`);
    }
    if (panel.gate !== undefined && (typeof panel.gate !== 'string' || !panel.gate)) {
      return fail('CLIENT_BAD_PANEL_GATE', `client.panels["${panel.id}"].gate must be a non-empty string (e.g. "session.preloadRequired")`);
    }
    // 面板自带的样式表（业主裁决 2026-10-10）：包内相对 `.css`，一份一份点名。`clean` 里放的是**稳定序**清单 ——
    // 注入顺序就是层叠顺序，所以同一份声明两处写法不同必须得到同一份字节（DESIGN §28.2）。
    /** @type {string[]} */
    let styles = [];
    if (panel.styles !== undefined) {
      if (!Array.isArray(panel.styles) || !panel.styles.length) {
        return fail('CLIENT_BAD_PANEL_STYLES', `client.panels["${panel.id}"].styles must be a non-empty array of pack-relative "${CLIENT_PANEL_STYLES_EXT}" paths (drop the key instead of sending [])`);
      }
      if (panel.styles.length > CLIENT_MAX_PANEL_STYLES) {
        return fail('CLIENT_BAD_PANEL_STYLES', `client.panels["${panel.id}"].styles: at most ${CLIENT_MAX_PANEL_STYLES} stylesheets per panel (got ${panel.styles.length})`);
      }
      for (const style of panel.styles) {
        if (typeof style !== 'string' || !isSafeRelativePath(style)
          || !style.endsWith(CLIENT_PANEL_STYLES_EXT) || style.length <= CLIENT_PANEL_STYLES_EXT.length) {
          return fail('CLIENT_BAD_PANEL_STYLE', `client.panels["${panel.id}"].styles: "${String(style)}" must be a pack-relative "${CLIENT_PANEL_STYLES_EXT}" path (e.g. "ui/chat${CLIENT_PANEL_STYLES_EXT}")`);
        }
      }
      styles = stableStringList(panel.styles);
      if (styles.length !== panel.styles.length) {
        const dup = panel.styles.find((s, i) => panel.styles.indexOf(s) !== i);
        return fail('CLIENT_DUPLICATE_PANEL_STYLE', `client.panels["${panel.id}"].styles: "${String(dup)}" is listed twice (a stylesheet injected twice is not a thing to reason about)`);
      }
    }
    /** @type {Record<string, unknown>} */
    const clean = { id: panel.id, slot: panel.slot, module: panel.module };
    if (panel.order !== undefined) clean.order = panel.order;
    if (panel.gate !== undefined) clean.gate = panel.gate;
    if (styles.length) clean.styles = styles;
    panels.push(clean);
  }
  const rawRequires = raw.requires === undefined ? [] : raw.requires;
  if (!Array.isArray(rawRequires)) {
    return fail('CLIENT_BAD_REQUIRES', `client.requires must be an array (one of: ${CLIENT_REQUIRES.join(', ')})`);
  }
  const requires = stableStringList(rawRequires);
  for (const r of requires) {
    if (!CLIENT_REQUIRES.includes(r)) {
      return fail('CLIENT_UNKNOWN_REQUIRE', `client.requires: "${r}" is not a capability this layer knows (one of: ${CLIENT_REQUIRES.join(', ')})`);
    }
  }
  panels.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 主题（`client.theme.vars`）：写 CSS 自定义属性，**加法**语义 —— 只加/改这几个变量名，不整份替换样式表。
  // 与面板自带 `.css` 的分工：要「几个颜色」用这里，要「一整份新组件的样式」用 `panels[].styles`（业主裁决：两条路都给）。
  /** @type {{ vars: Record<string, string> }|undefined} */
  let theme;
  if (raw.theme !== undefined) {
    const spec = raw.theme;
    if (!isPlainObj(spec)) return fail('CLIENT_THEME_BAD_SHAPE', 'client.theme must be an object: { vars }');
    for (const key of Object.keys(spec)) {
      if (!CLIENT_THEME_FIELDS.includes(key)) {
        return fail('CLIENT_THEME_UNKNOWN_FIELD', `client.theme: "${key}" is not a declared field (${CLIENT_THEME_FIELDS.join(', ')})`);
      }
    }
    if (!isPlainObj(spec.vars) || !Object.keys(spec.vars).length) {
      return fail('CLIENT_THEME_BAD_VARS', 'client.theme.vars must be a non-empty object of CSS custom properties (e.g. { "--sp-accent": "#c33" })');
    }
    const names = Object.keys(spec.vars);
    if (names.length > CLIENT_MAX_THEME_VARS) {
      return fail('CLIENT_THEME_TOO_MANY_VARS', `client.theme.vars: at most ${CLIENT_MAX_THEME_VARS} variables (got ${names.length})`);
    }
    /** @type {Record<string, string>} */
    const vars = {};
    // 按名字排序写进清单：注入顺序不影响结果（变量之间不互相替换），但字节必须稳定（DESIGN §28.2）。
    for (const name of names.slice().sort()) {
      if (!CLIENT_THEME_VAR_RE.test(name)) {
        return fail('CLIENT_THEME_BAD_VAR_NAME', `client.theme.vars: "${name}" is not a CSS custom property name — it must start with "--", or writing it would do nothing at all`);
      }
      const value = spec.vars[name];
      const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
      if (typeof text !== 'string' || !text.trim()) {
        return fail('CLIENT_THEME_BAD_VAR_VALUE', `client.theme.vars["${name}"] must be a non-empty string or a finite number`);
      }
      // 值是**数据**：它不许有「结束自己这条声明、再开一条」的能力（`;` / `{}` / `<` / 换行）。
      if (text.length > CLIENT_THEME_VALUE_MAX || CLIENT_THEME_VALUE_BAD.test(text)) {
        return fail('CLIENT_THEME_BAD_VAR_VALUE', `client.theme.vars["${name}"] may not contain ; { } < > or a newline, and is limited to ${CLIENT_THEME_VALUE_MAX} characters — a variable value must not be able to end its own declaration and start another`);
      }
      vars[name] = text;
    }
    theme = { vars };
  }
  // requires 按闭枚举次序，不按作者书写顺序：同一个包两处写法不同的清单必须是同一份字节（DESIGN §28.2）
  return { ok: true, decl: { panels, requires: CLIENT_REQUIRES.filter((c) => requires.includes(c)), ...(theme ? { theme } : {}) } };
}

/**
 * `pack.json.server` —— 消息分发前的准入钩子（§28.13）。本轮**只认形状**：没有钩子被安装、没有模块被加载
 * （B 段）。三条硬约束里有两条是形状层就能拦住的：`intercepts` 必须是真实存在的 `C2S` 类型，且 `module`
 * 必须是包内相对路径（一个绝对路径会让「这个钩子来自哪个包」从身份里消失）。
 * @returns {{ ok: true, decl: object } | { ok: false, error: string, detail: string }}
 */
function parseServerDecl(raw) {
  if (!isPlainObj(raw)) {
    return fail('SERVER_DECL_BAD_SHAPE', 'server must be an object: { preDispatch: { module, policy, intercepts }, meta: { module, registers } }');
  }
  const SERVER_MEMBERS = ['preDispatch', 'meta'];
  for (const key of Object.keys(raw)) {
    if (!SERVER_MEMBERS.includes(key)) {
      return fail('SERVER_UNKNOWN_FIELD', `server: "${key}" is not a declared field (${SERVER_MEMBERS.join(', ')})`);
    }
  }
  if (raw.preDispatch === undefined && raw.meta === undefined) {
    return fail('SERVER_EMPTY_MEMBER', `server must declare at least one member (${SERVER_MEMBERS.join(', ')}) — an empty object says nothing and is refused rather than ignored`);
  }
  /** @type {Record<string, object>} */
  const decl = {};
  if (raw.meta !== undefined) {
    const meta = parseMetaDecl(raw.meta);
    if (!meta.ok) return meta;
    decl.meta = meta.decl.meta;
  }
  if (raw.preDispatch === undefined) return { ok: true, decl };
  const pre = raw.preDispatch;
  if (!isPlainObj(pre)) {
    return fail('PREDISPATCH_BAD_SHAPE', 'server.preDispatch must be an object: { module, policy, intercepts }');
  }
  for (const key of Object.keys(pre)) {
    if (!PRE_DISPATCH_FIELDS.includes(key)) {
      return fail('PREDISPATCH_UNKNOWN_FIELD', `server.preDispatch: "${key}" is not a declared field (${PRE_DISPATCH_FIELDS.join(', ')})`);
    }
  }
  for (const key of ['module', 'policy']) {
    if (!isSafeRelativePath(pre[key])) {
      return fail('PREDISPATCH_BAD_PATH', `server.preDispatch.${key} must be a relative path inside the pack (no absolute paths, no "..")`);
    }
  }
  if (!pre.module.endsWith(PRE_DISPATCH_MODULE_EXT)) {
    return fail('PREDISPATCH_BAD_MODULE', `server.preDispatch.module must be a "${PRE_DISPATCH_MODULE_EXT}" module — the server loads it, the browser does not`);
  }
  if (!pre.policy.endsWith('.json')) {
    return fail('PREDISPATCH_BAD_POLICY', 'server.preDispatch.policy must name a .json policy file (the list of files a client must prove it holds)');
  }
  if (!Array.isArray(pre.intercepts) || !pre.intercepts.length) {
    return fail('PREDISPATCH_BAD_INTERCEPTS', 'server.preDispatch.intercepts must be a non-empty array of C2S message types (a hook that intercepts nothing gates nothing)');
  }
  for (const t of pre.intercepts) {
    if (typeof t !== 'string' || !PRE_DISPATCH_INTERCEPTS.includes(t)) {
      return fail('PREDISPATCH_UNKNOWN_TYPE', `server.preDispatch.intercepts: "${String(t)}" is not a message type of shared/protocol.js C2S (the bus never delivers a name no client sends)`);
    }
  }
  // 与 `client.panels` / `operators` 同一个理由：键序（列表次序也是字节）不能随作者书写顺序变。
  // 返回值保持提案的形状（外面那一层 `preDispatch` 是包格式的一部分，不在这里拆平）。
  const intercepts = stableStringList(pre.intercepts);
  decl.preDispatch = { module: pre.module, policy: pre.policy, intercepts };
  return { ok: true, decl };
}

/**
 * 一条注册键的形状：`<类别>:<id>`，或结尾带**一个** `*` 的前缀通配（`garrison:custom_*`）。
 * @returns {string|null} 拒绝理由；`null` = 形状合法
 */
function metaKeyIssue(key) {
  if (typeof key !== 'string' || !key) return `server.meta.registers: ${JSON.stringify(key)} is not a registry key`;
  const starred = key.endsWith('*');
  const body = starred ? key.slice(0, -1) : key;
  // 星号只能是**结尾那一个**：`bond:a*b` 既不是精确键（注册表的 id 字符集不含 `*`）也不是前缀匹配，
  // 它会变成一条永远注册不上的声明 —— 而「写了等于没写」正是这一节要消灭的东西。
  if (body.includes('*')) {
    return `server.meta.registers: "${key}" may carry at most ONE trailing "*" (a prefix match such as "garrison:custom_*")`;
  }
  if (starred && !body) return `server.meta.registers: "${key}" is only a "*": name a class and a prefix`;
  const at = body.indexOf(':');
  if (at <= 0 || at === body.length - 1) {
    return `server.meta.registers: "${key}" must look like "<class>:<id>" — one of ${META_KEY_CLASSES.join(', ')}`;
  }
  const cls = body.slice(0, at);
  if (!META_KEY_CLASSES.includes(cls)) {
    return `server.meta.registers: "${key}" names the registry class "${cls}", which is not one of ${META_KEY_CLASSES.join(', ')}`;
  }
  // id 的字符集与注册表自己那条 `KEY_RE` 一致（`[A-Za-z0-9_\-.:#]`）：形状层放行、运行时抛异常，是最坏的一种分工。
  if (!META_KEY_TAIL_RE.test(body.slice(at + 1))) {
    return `server.meta.registers: "${key}" has characters the registry does not accept after the class (allowed: letters, digits, _ - . : #)`;
  }
  return null;
}

/**
 * `pack.json.server.meta` —— 包的**对局元注册表**载荷（DESIGN §29）。它是 B 层的第二类载荷：一个 `.mjs` 导出
 * `registerMeta(registry)`（与官方内容模块同形），在**这一局**的注册表上登记它自己的处理器。
 *
 * `registers` 是**白名单，不是提示**：运行时那个受限注册表对任何没列在这里的键**一注册就抛**。理由与
 * `intercepts` 逐字相同 —— 不声明就可能**悄悄顶掉官方的**处理器（`register()` 是「后注册的赢」），
 * 而「静默改官方行为」正是本仓每个面都在拒绝的那一类。
 *
 * 形状层判形状；「文件真的在不在、能不能 import」是装载期（`server/workshop.js metaIssues` 与装配路径）。
 * @returns {{ ok: true, decl: object } | { ok: false, error: string, detail: string }}
 */
function parseMetaDecl(raw) {
  if (!isPlainObj(raw)) {
    return fail('META_BAD_SHAPE', 'server.meta must be an object: { module, registers }');
  }
  for (const key of Object.keys(raw)) {
    if (!META_FIELDS.includes(key)) {
      return fail('META_UNKNOWN_FIELD', `server.meta: "${key}" is not a declared field (${META_FIELDS.join(', ')})`);
    }
  }
  if (!isSafeRelativePath(raw.module)) {
    return fail('META_BAD_PATH', 'server.meta.module must be a relative path inside the pack (no absolute paths, no "..")');
  }
  if (!raw.module.endsWith(META_MODULE_EXT)) {
    return fail('META_BAD_MODULE', `server.meta.module must be a "${META_MODULE_EXT}" module — the server loads it, the browser does not`);
  }
  if (!Array.isArray(raw.registers) || !raw.registers.length) {
    return fail('META_BAD_REGISTERS', 'server.meta.registers must be a non-empty array of the registry keys this pack may register (a module allowed to register nothing is a module that does nothing)');
  }
  for (const key of raw.registers) {
    const issue = metaKeyIssue(key);
    if (issue) return fail('META_BAD_KEY', issue);
  }
  const registers = stableStringList(raw.registers);
  if (registers.length !== raw.registers.length) {
    const seen = new Set();
    const dup = raw.registers.find((k) => (seen.has(k) ? true : (seen.add(k), false)));
    return fail('META_DUPLICATE_KEY', `server.meta.registers: "${String(dup)}" is listed twice (one key, one owner)`);
  }
  return { ok: true, decl: { meta: { module: raw.module, registers } } };
}

/**
 * `pack.json.routes` —— 包能声明的**只读** HTTP 路由（§28.13）。刻意窄：绝对路径、包内 `.json`、三种缓存语义。
 *   * `path` 必须是 `/` 开头的绝对路径：一条相对路径落到哪个前缀上是路由表说了算，作者不该猜；
 *   * `file` 必须以 `.json` 结尾：`.js` / `.html` 一律不在此通道（那与 `/workshop-assets` 拒绝它们同一个理由
 *     —— 那是代码执行面，不是数据面）。
 * @returns {{ ok: true, decl: object[] } | { ok: false, error: string, detail: string }}
 */
function parseRoutesDecl(raw) {
  if (!Array.isArray(raw)) return fail('ROUTES_BAD_SHAPE', 'routes must be an array of { path, file, cache? }');
  const out = [];
  const seen = new Set();
  for (const [i, route] of raw.entries()) {
    if (!isPlainObj(route)) return fail('ROUTES_BAD_SHAPE', `routes[${i}] must be an object: { path, file, cache? }`);
    for (const key of Object.keys(route)) {
      if (!ROUTE_FIELDS.includes(key)) {
        return fail('ROUTE_UNKNOWN_FIELD', `routes[${i}]: "${key}" is not a route field (${ROUTE_FIELDS.join(', ')})`);
      }
    }
    if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.length < 2
      || route.path.includes('\\') || route.path.split('/').some((seg) => seg === '..' || seg === '.')) {
      return fail('ROUTE_BAD_PATH', `routes[${i}].path must be an absolute HTTP path (e.g. "/data/resource-manifest.json")`);
    }
    if (seen.has(route.path)) return fail('ROUTE_DUPLICATE_PATH', `routes: "${route.path}" is declared twice (one path, one file)`);
    seen.add(route.path);
    if (!isSafeRelativePath(route.file)) {
      return fail('ROUTE_BAD_FILE', `routes["${route.path}"].file must be a relative path inside the pack (no absolute paths, no "..")`);
    }
    if (!route.file.endsWith('.json')) {
      return fail('ROUTE_BAD_FILE', `routes["${route.path}"].file must name a .json file — this channel never serves code or markup`);
    }
    const cache = route.cache === undefined ? 'no-cache' : route.cache;
    if (!ROUTE_CACHE_POLICIES.includes(cache)) {
      return fail('ROUTE_BAD_CACHE', `routes["${route.path}"].cache must be one of: ${ROUTE_CACHE_POLICIES.join(', ')}`);
    }
    out.push({ path: route.path, file: route.file, cache });
  }
  return { ok: true, decl: out };
}

/**
 * `pack.json.i18n` —— 给**已有语种**补词条的通道（fanpack G-04 / plugin-pack G4，docs/WORKSHOP.md §1.10）。
 *
 * 为什么需要它：`packs/` 的 `lang` 类型只能**新增**一个语种 —— 一个包带 `en` / `ja` / `ko` / `zh-TW` 里的任何一个，
 * 真实的扫描器都会整包跳过，原文是 `the language en is already provided by public/i18n/en.json`。而任何带新界面的
 * 包（新面板、新按钮、新提示）都需要**给已有语种补键**，所以这是个结构性的缺口，不是配置问题。
 *
 * 形状刻意是「语种 → 包内 .json 文件」而不是内联对象：
 *   * 一个包给四个语种各补 74 键，内联会让 `pack.json` 长出 20 KB，而这份清单是身份哈希的输入（`identifyPack`
 *     哈希的是归一化后的清单），内联等于把整份译文塞进哈希清单的**一个字符串**里；
 *   * 文件路径是**可哈希**的：`identifyPack` 对每一个声明的 i18n 文件单独 `sha256`（与 `client.panels` 的模块同一条
 *     纪律）—— 换一份译文就是换一个包；
 *   * 形状与语言包本身逐字相同（`{ "<中文 msgid>": "<译文>" }`），作者可以照抄 `public/i18n/<code>.json`。
 *
 * 拒绝的三种形状（都点名，不静默）：语种码不是 `shared/i18nPacks.js` 认的常用大小写、语种是源语言 `zh`
 * （msgid 自己，没有包）、路径不是包内相对 `.json`。至于「这个文件在不在、是不是 JSON 对象」要读磁盘，
 * 在装载期（`server/workshop.js i18nIssues`）。
 *
 * @returns {{ ok: true, decl: Record<string, string> } | { ok: false, error: string, detail: string }}
 */
function parseI18nDecl(raw) {
  if (!isPlainObj(raw)) {
    return fail('I18N_BAD_SHAPE', 'i18n must be an object: { "<lang code>": "<relative path to a .json of msgid → translation>" }');
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const code of Object.keys(raw).sort()) {
    const file = raw[code];
    if (!isLangCode(code)) {
      return fail('I18N_BAD_LANG', `i18n: "${code}" is not a language code in its usual case (en, ja, ko, zh-TW, pt-BR …)`);
    }
    if (code === SOURCE_LANG) {
      return fail('I18N_SOURCE_LANG', `i18n: "${SOURCE_LANG}" is the source language (the msgids themselves) — it has no language file to add to`);
    }
    if (!isSafeRelativePath(file) || !file.endsWith('.json')) {
      return fail('I18N_BAD_FILE', `i18n["${code}"] must be a relative path inside the pack, ending in .json (e.g. "i18n/${code}.json") — the loader reads those bytes, and they are part of this pack's identity`);
    }
    out[code] = file;
  }
  // 键序不影响 `canonicalJson`（它排键），但**键在不在**影响哈希，所以这里只保证「声明过才有」，
  // 顺序由 `parseI18nDecl` 的 sort 定死，不随作者书写顺序变。
  return { ok: true, decl: out };
}


/**
 * `pack.json.operators[<charId>]` 允许的两个列表字段。**只此一份**：形状校验（`normalizePackManifest`）与
 * 「盟约存不存在」那一步（`mergeWorkshopOperators`）读的是同一张表，两处不会漂移。
 *
 * 为什么 `bonds` 必须点名：盟约 id 写错时那条盟约条**永远不会出现**，而作者只会以为「盟约没生效」—— 静默失效
 * （与 `bondIcons` 同一个理由：一个没人读到的声明比一条报错坏得多）。
 */
const OPERATOR_LIST_FIELDS = Object.freeze(['powers', 'bonds']);

/**
 * 一个「字符串列表」字段（`operators[*].bonds` / `.powers`）：数组、每一项是非空字符串、去重、排序（键序是清单
 * 字节的一部分）。不是数组、或里面有一个不是字符串 → 拒绝，并指出**是哪一条的哪一个字段**。
 * @returns {{ ok: true, list: string[] } | { ok: false, detail: string }}
 */
function parseStringList(value, where) {
  const list = value === undefined ? [] : value;
  if (!Array.isArray(list)) return { ok: false, detail: `${where} must be an array of ids` };
  const out = [];
  for (const id of list) {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, detail: `${where}: "${String(id)}" is not a valid id` };
    const clean = id.trim();
    if (!out.includes(clean)) out.push(clean);
  }
  return { ok: true, list: out.sort() };
}

/**
 * 外观素材的三张表，以及每张表的条目允许带什么。
 *
 * 形状与 `data/assets.json` 里对应条目**1:1**，作者可以照抄官方条目（tools/assets 计划的产物）再改路径，所以这里
 * 只描述「哪些字段是路径、spine 在哪一层」，不重新发明一套 schema：
 *   * `urls`   —— 这个条目上直接是路径的字段（头像/立绘/图标）；
 *   * `strings`—— 原样抄过去的字符串字段（`enemies.spineAliasOf` 指向另一个怪物的模型、`tokens.owner` 是它属于谁）；
 *   * `spine`  —— `'sides'`：spine 在 `spine.front` / `spine.back` 两层下（chars）；`'flat'`：spine 就是条目上的
 *                 `spine` 字段（enemies / tokens）。
 *   * `flat`   —— 这一张表的**条目本身就是一条路径字符串**（不是"对象 + `urls` 字段"）。今天的成员是 `skills`
 *                 （技能图标）与 `profSub`（分支图标）：`assets.skills[key]` 与 `assets.prof.sub[key]` 的值**直接
 *                 就是路径字符串**（`data/assets.json` 实测），所以这里没有字段可列。谁赢与落盘位置由 `target`
 *                 给出（见 `mergeWorkshopFlatArt`）。
 */
export const ART_TABLES = {
  chars: { urls: ['avatar', 'avatarE2', 'portrait', 'portraitE2'], strings: [], spine: 'sides' },
  enemies: { urls: ['icon'], strings: ['spineAliasOf'], spine: 'flat' },
  tokens: { urls: ['avatar'], strings: ['owner'], spine: 'flat' },
  skills: { flat: true, target: ['skills'] },
  profSub: { flat: true, target: ['prof', 'sub'] },
};
/**
 * 一个 spine 对象里的路径字段、路径数组字段，以及原样抄过去但要查类型的字段。
 *
 * 这些类型**不是我们定的**，是 `data/assets.json` 里官方条目的实际类型（工具链产物，0.8.0 实测）：
 * `anims` 与 `animations` 都是**对象**（前者是"角色 → 动画名"的映射，后者是"动画名 → 时长"），
 * `events` 是**数组**（事件名列表，例如 `["OnAttack","OnStart"]`），`pma` 是布尔、`hits`/`bounds` 是对象。
 * 文档教作者「照官方条目抄」，所以这里必须与官方一致 —— 类型写反，一个正确的条目会被我们拒掉。
 */
export const ART_SPINE_URLS = ['skel', 'atlas'];
export const ART_SPINE_LISTS = ['textures'];
export const ART_SPINE_PASSTHROUGH = {
  pma: ['boolean'],
  anims: ['object'],
  animations: ['object'],
  events: ['array'],
  hits: ['object'],
  bounds: ['object', 'array'],
};
const ART_SPINE_FIELDS = [...ART_SPINE_URLS, ...ART_SPINE_LISTS, ...Object.keys(ART_SPINE_PASSTHROUGH)];

/** 一个 spine 对象（`{ skel, atlas, textures?, pma?, anims?, … }`）。`skel` 与 `atlas` 缺一不可：加载器是从 skel
 * 的路径**推出** atlas 的，清单里的 atlas 只用来做内存回收，写错不会报错 —— 所以形状这一层就要求它必须在。 */
function parseArtSpine(spine, where) {
  if (!isPlainObj(spine)) return { error: 'ART_BAD_SHAPE', detail: `${where} must be a spine object { skel, atlas, … }` };
  const out = {};
  for (const [key, value] of Object.entries(spine)) {
    if (!ART_SPINE_FIELDS.includes(key)) {
      return { error: 'ART_UNKNOWN_FIELD', detail: `${where}: "${key}" is not a spine field (${ART_SPINE_FIELDS.join(', ')})` };
    }
    if (ART_SPINE_URLS.includes(key)) {
      if (!isSafeAssetPath(value)) return { error: 'ART_PATH_UNSAFE', detail: `${where}.${key}: "${String(value)}" must be a relative path inside assets/` };
      out[key] = value;
      continue;
    }
    if (ART_SPINE_LISTS.includes(key)) {
      if (!Array.isArray(value) || !value.length) return { error: 'ART_BAD_SHAPE', detail: `${where}.${key} must be a non-empty array of paths` };
      for (const p of value) {
        if (!isSafeAssetPath(p)) return { error: 'ART_PATH_UNSAFE', detail: `${where}.${key}: "${String(p)}" must be a relative path inside assets/` };
      }
      out[key] = [...new Set(value)];
      continue;
    }
    const got = Array.isArray(value) ? 'array' : (value && typeof value === 'object' ? 'object' : typeof value);
    if (!ART_SPINE_PASSTHROUGH[key].includes(got)) {
      return { error: 'ART_BAD_SHAPE', detail: `${where}.${key} must be a ${ART_SPINE_PASSTHROUGH[key].join(' or ')}` };
    }
    out[key] = value;
  }
  for (const need of ART_SPINE_URLS) {
    if (!out[need]) return { error: 'ART_SPINE_INCOMPLETE', detail: `${where} needs both "skel" and "atlas"` };
  }
  return { spine: out, error: null };
}

/** 一张外观表里的一个条目：路径字段、原样字符串、以及（按表）嵌套或扁平的 spine。 */
function parseArtEntry(entry, where, shape) {
  // 扁平表（skills / profSub）：条目本身就是一条路径。`isSafeAssetPath` 由调用方判，好让拒绝码是 ART_PATH_UNSAFE
  // 而不是形状错误 —— 作者写一条 `../x.png` 与写一个对象是两种错，提示要分开。
  if (shape.flat) return { entry, error: null };
  if (!isPlainObj(entry)) return { error: 'ART_BAD_SHAPE', detail: `${where} must be an object` };
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (shape.urls.includes(key)) {
      if (!isSafeAssetPath(value)) return { error: 'ART_PATH_UNSAFE', detail: `${where}.${key}: "${String(value)}" must be a relative path inside assets/` };
      out[key] = value;
      continue;
    }
    if (shape.strings.includes(key)) {
      if (typeof value !== 'string' || !value) return { error: 'ART_BAD_SHAPE', detail: `${where}.${key} must be a non-empty string` };
      out[key] = value;
      continue;
    }
    if (key === 'spine') {
      if (shape.spine === 'flat') {
        const parsed = parseArtSpine(value, `${where}.spine`);
        if (parsed.error) return parsed;
        out.spine = parsed.spine;
        continue;
      }
      if (!isPlainObj(value)) return { error: 'ART_BAD_SHAPE', detail: `${where}.spine must map sides to a spine object ({ front: {…}, back: {…} })` };
      const sides = {};
      for (const [side, obj] of Object.entries(value)) {
        if (side !== 'front' && side !== 'back') return { error: 'ART_UNKNOWN_FIELD', detail: `${where}.spine: "${side}" is not a side (front, back)` };
        const parsed = parseArtSpine(obj, `${where}.spine.${side}`);
        if (parsed.error) return parsed;
        sides[side] = parsed.spine;
      }
      if (Object.keys(sides).length) out.spine = sides;
      continue;
    }
    return {
      error: 'ART_UNKNOWN_FIELD',
      detail: `${where}: "${key}" is not a field of this art entry (${[...shape.urls, ...shape.strings, 'spine'].join(', ')})`,
    };
  }
  return { entry: out, error: null };
}

/**
 * Validate and normalise one pack's `pack.json`.
 * @param {any} raw parsed pack.json
 * @param {string} [dirName] the pack's directory name (authoritative when the manifest omits / contradicts `id`)
 * @returns {{ ok: true, pack: { id: string, name: string, version: string, author: string|null, license: string|null,
 *   description: string|null, gameVersion: string|null, content: string[], overrides: string[],
 *   voices: Record<string, Record<string, string[]>>, voiceLangs: Record<string, Record<string, Record<string, string[]>>>,
 *   bondIcons: Record<string, string>, itemIcons: Record<string, string>,
 *   art: Record<string, Record<string, object>>, support: string[],
 *   operators: Record<string, { powers: string[], bonds: string[] }>, i18n?: Record<string, string> } }
 *   | { ok: false, error: string, detail: string }}
 */
export function normalizePackManifest(raw, dirName = '', opts = {}) {
  if (!isPlainObj(raw)) return fail('BAD_MANIFEST', 'pack.json must be a JSON object');
  // 顶层键闭集（`PACK_FIELDS`）：一个我们不认识的键**点名拒绝**，绝不读过去。这是本刀那条共通纪律的落点 ——
  // 三个社区 mod 里的 `variants` / `skins` / `i18n` 全都是「写了等于没写」的静默丢，而作者从错误文案里
  // 得不到任何线索。判据放在最前面：一个连键都不认识的清单，后面的字段级判据都是在猜它想说什么。
  for (const key of Object.keys(raw)) {
    if (PACK_FIELDS.includes(key)) continue;
    return fail(PACK_UNKNOWN_FIELD_CODE,
      `pack.json: "${key.length > MAX_KEY_SHOWN ? `${key.slice(0, MAX_KEY_SHOWN)}…` : key}" is not a field of this pack format (${PACK_FIELDS.join(', ')}). A key this loader does not know is never read: write it as one of the fields above, or drop it — a declaration that is ignored is worse than a refusal`);
  }
  const id = typeof raw.id === 'string' && raw.id ? raw.id : dirName;
  if (!PACK_ID_RE.test(id)) return fail('BAD_PACK_ID', `"${id}" is not a valid pack id (letters, digits, _ and - only)`);
  if (dirName && typeof raw.id === 'string' && raw.id && raw.id !== dirName) {
    return fail('PACK_ID_MISMATCH', `pack.json id "${raw.id}" does not match its directory "${dirName}"`);
  }
  const content = Array.isArray(raw.content)
    ? [...new Set(raw.content.filter((f) => typeof f === 'string' && WORKSHOP_CONTENT_FILES.includes(f)))].sort()
    : [];
  // (EMPTY_PACK is checked after `voices` below: a pack whose whole contribution is a 助战 operator's voice lines has no
  // data file at all, and refusing it here would make the reserved voice pack impossible to write.)
  const overrides = Array.isArray(raw.overrides)
    ? [...new Set(raw.overrides.filter((o) => typeof o === 'string' && OVERRIDE_ENTRY_RE.test(o)))].sort()
    : [];
  const license = typeof raw.license === 'string' && raw.license ? raw.license : null;
  // A pack that SHIPS ITS OWN ART must say under what terms (`hasAssets` = it has an assets/ folder; the loader passes
  // it, since this function only sees the manifest). The repo ships no game assets, so a pack's art is the pack author's
  // to license — and the redistributor carries the risk, which is why the manifest has to name the licence rather than
  // leave it to a README nobody reads (docs/WORKSHOP.md §5).
  if (opts.hasAssets === true && !license) {
    return fail('ASSETS_NEED_LICENSE',
      'this pack has an assets/ folder, so pack.json must declare a license (e.g. "CC0-1.0", "CC-BY-4.0", or "see assets/LICENSE.txt")');
  }
  // Voice lines of a pack's own (or its 助战) operators — the RESERVED workshop half of the voice interface
  // (docs/WORKSHOP.md §1.4, docs/ASSETS.md "Voice lines"): `voices: { <charId>: { <slot>: ["<path inside assets/>", …] } }`.
  // The files live under the pack's assets/, so the licence gate above already applies to them, and the client reads
  // them from /workshop-assets/<pack>/<path> — the one route that serves pack media. Only the fixed slot vocabulary is
  // accepted, so a typo cannot silently produce a line that never plays.
  const voices = raw.voices === undefined ? {} : raw.voices;
  if (!isPlainObj(voices)) return fail('VOICE_BAD_SHAPE', 'voices must be an object: { "<charId>": { "<slot>": ["<path>"] } }');
  if (Object.keys(voices).length && opts.hasAssets !== true) {
    return fail('VOICE_NEEDS_ASSETS', 'a pack that declares voices must put the files in its assets/ folder (e.g. assets/voice/…)');
  }
  /**
   * Parse ONE `<charId> → <slot> → [path inside assets/]>` table. `voices` (the default dub) and every
   * `voiceLangs[<lang>]` carry exactly this shape and these rules, so they share one implementation — a rule that held
   * for one table but not the other would be a silent hole. `where` is how the author wrote the table, so a refusal
   * points at the exact place in pack.json (`voices["c"]["place"]`, `voiceLangs["jp"]["c"]["place"]`).
   * Paths are relative and inside assets/, with no traversal — the same rule the /workshop-assets route enforces
   * (that route refuses `.` and `..` segments, so a `.` here would only ever produce a URL that 404s).
   */
  const parseVoiceTable = (table, where) => {
    if (!isPlainObj(table)) return fail('VOICE_BAD_SHAPE', `${where} must map slots to file lists`);
    /** @type {Record<string, Record<string, string[]>>} */
    const out = {};
    for (const [charId, slots] of Object.entries(table)) {
      if (!/^[A-Za-z0-9_\-]{1,64}$/.test(charId)) return fail('VOICE_BAD_CHAR_ID', `${where}: "${charId}" is not a valid operator id`);
      if (!isPlainObj(slots)) return fail('VOICE_BAD_SHAPE', `${where}["${charId}"] must map slots to file lists`);
      const clean = {};
      for (const [slot, files] of Object.entries(slots)) {
        if (!VOICE_SLOTS.includes(slot)) {
          return fail('VOICE_SLOT_UNKNOWN', `${where}["${charId}"]["${slot}"] is not a voice slot (one of: ${VOICE_SLOTS.join(', ')})`);
        }
        const list = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === 'string' && f);
        if (!list.length) return fail('VOICE_EMPTY', `${where}["${charId}"]["${slot}"] names no file`);
        for (const f of list) {
          if (f.startsWith('/') || f.includes('\\') || f.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(f)) {
            return fail('VOICE_PATH_UNSAFE', `${where}["${charId}"]["${slot}"]: "${f}" must be a relative path inside assets/ (no absolute paths, no "..")`);
          }
        }
        clean[slot] = [...new Set(list)].sort();
      }
      if (Object.keys(clean).length) out[charId] = clean;
    }
    return { ok: true, table: out };
  };
  const parsedVoices = parseVoiceTable(voices, 'voices');
  if (!parsedVoices.ok) return parsedVoices;
  const voiceLines = parsedVoices.table;
  // 多语言配音：`voiceLangs: { "<lang>": { <charId>: { <slot>: ["<path>"] } } }` —— 一个语种一张表，与上面 `voices`
  // 同一个形状、同一套路径规则、同一个槽位词表。`voices` 是**默认配音**那一档（清单的 `audio.voiceLang`，
  // 见 docs/ASSETS.md），所以默认语种键写进 voiceLangs 会被拒（VOICE_LANG_DEFAULT）：同一批台词有两个写法的话，
  // 「客户端到底读哪一份」就成了作者猜不出来的事。播放侧不需要任何新通道 —— 加载时并进 `assets.audio.voiceLangs`
  // （mergeWorkshopVoices），客户端 public/js/audio.js voiceLinesFor 本来就在那张表里按语种取台词。
  const voiceLangs = raw.voiceLangs === undefined ? {} : raw.voiceLangs;
  if (!isPlainObj(voiceLangs)) {
    return fail('VOICE_LANG_BAD_SHAPE', 'voiceLangs must be an object: { "<lang>": { "<charId>": { "<slot>": ["<path>"] } } }');
  }
  if (Object.keys(voiceLangs).length && opts.hasAssets !== true) {
    return fail('VOICE_NEEDS_ASSETS', 'a pack that declares voices must put the files in its assets/ folder (e.g. assets/voice/…)');
  }
  /** @type {Record<string, Record<string, Record<string, string[]>>>} */
  const voiceLangLines = {};
  for (const [lang, table] of Object.entries(voiceLangs)) {
    if (!VOICE_LANGS.includes(lang)) {
      return fail('VOICE_LANG_UNKNOWN', `"${lang}" is not a dub (one of: ${VOICE_LANGS.join(', ')})`);
    }
    if (lang === DEFAULT_VOICE_LANG) {
      return fail('VOICE_LANG_DEFAULT', `"${lang}" is the default dub — declare its lines in "voices", not in "voiceLangs"`);
    }
    const parsed = parseVoiceTable(table, `voiceLangs["${lang}"]`);
    if (!parsed.ok) return parsed;
    if (!Object.keys(parsed.table).length) return fail('VOICE_LANG_EMPTY', `voiceLangs["${lang}"] declares no operator`);
    voiceLangLines[lang] = parsed.table;
  }
  // VOICE_LANGS order is the canonical one (same reason workshopVoiceLangIndex sorts): the table this function returns
  // goes straight into the merged manifest, whose bytes must not depend on how the author happened to write pack.json.
  const orderedLangLines = Object.fromEntries(VOICE_LANGS.filter((l) => voiceLangLines[l]).map((l) => [l, voiceLangLines[l]]));
  // 盟约图标（这个包自带的 art）：`bondIcons: { "<bondId>": "<path inside assets/>" }`。
  //
  // 为什么需要它：客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图标（public/js/assets.js bondIconUrl），
  // 而一个包没法往 `assets.json` 里加条目 —— 于是新增盟约在盟约条上只能是一个圆点。这里把这个口子开在
  // **pack.json 的一个字段**上（和一个包的语音是同一个做法），装载时叠加进 `assets.bonds`，URL 走同一条
  // /workshop-assets 路由。路径安全规则与语音逐字相同（相对 assets/、无穿越）。
  const bondIcons = raw.bondIcons === undefined ? {} : raw.bondIcons;
  if (!isPlainObj(bondIcons)) return fail('BOND_ICON_BAD_SHAPE', 'bondIcons must be an object: { "<bondId>": "<path inside assets/>" }');
  if (Object.keys(bondIcons).length && opts.hasAssets !== true) {
    return fail('BOND_ICON_NEEDS_ASSETS', 'a pack that declares bondIcons must put the image in its assets/ folder');
  }
  /** @type {Record<string, string>} */
  const bondIconFiles = {};
  for (const [bondId, file] of Object.entries(bondIcons)) {
    if (!/^[A-Za-z0-9_\-.:]{1,64}$/.test(bondId)) return fail('BOND_ICON_BAD_ID', `"${bondId}" is not a valid bond id`);
    if (typeof file !== 'string' || !file) return fail('BOND_ICON_BAD_SHAPE', `bondIcons["${bondId}"] must be a path inside assets/`);
    if (file.startsWith('/') || file.includes('\\') || file.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(file)) {
      return fail('BOND_ICON_PATH_UNSAFE', `"${file}" must be a relative path inside assets/ (no absolute paths, no "..")`);
    }
    bondIconFiles[bondId] = file;
  }
  // 装备/道具图标（这个包自带的 art）：`itemIcons: { "<iconId>": "<path inside assets/>" }`。
  //
  // 为什么需要它：客户端按**道具 id** 从 `data/assets.json` 的 `assets.items` 取图标（public/js/assets.js
  // itemIconUrl：先看 `item.iconId`、再看 `item.trapId`，然后查 `m.items[id]`），而一个包没法往 assets.json 里加
  // 条目 —— 于是包新增的装备在界面上没有图标。做法与 `bondIcons` 逐字相同：口子开在 pack.json 的一个字段上，
  // 装载时叠加进 `assets.items`（mergeWorkshopItemIcons），URL 走同一条 /workshop-assets 路由 —— 客户端零改动。
  // 键的字符集与其它 record id 同一套（RECORD_ID_RE），路径安全规则与语音/盟约图标逐字相同。
  const itemIcons = raw.itemIcons === undefined ? {} : raw.itemIcons;
  if (!isPlainObj(itemIcons)) return fail('ITEM_ICON_BAD_SHAPE', 'itemIcons must be an object: { "<itemId>": "<path inside assets/>" }');
  if (Object.keys(itemIcons).length && opts.hasAssets !== true) {
    return fail('ITEM_ICON_NEEDS_ASSETS', 'a pack that declares itemIcons must put the image in its assets/ folder');
  }
  /** @type {Record<string, string>} */
  const itemIconFiles = {};
  for (const [itemId, file] of Object.entries(itemIcons)) {
    if (!RECORD_ID_RE.test(itemId)) return fail('ITEM_ICON_BAD_ID', `"${itemId}" is not a valid item id`);
    if (typeof file !== 'string' || !file) return fail('ITEM_ICON_BAD_SHAPE', `itemIcons["${itemId}"] must be a path inside assets/`);
    if (file.startsWith('/') || file.includes('\\') || file.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(file)) {
      return fail('ITEM_ICON_PATH_UNSAFE', `"${file}" must be a relative path inside assets/ (no absolute paths, no "..")`);
    }
    itemIconFiles[itemId] = file;
  }
  // 包自带的外观素材：`art: { chars | enemies | tokens: { "<id>": <该条目在 assets.json 里的形状的子集> } }`。
  //
  // 为什么需要它：客户端画一个单位时，模型与头像都从 `data/assets.json` 取 —— `public/js/assets.js spineEntry()` 读
  // `chars[id].spine.front/back`（嵌套）或 `tokens[id].spine` / `enemies[id].spine`（扁平），头像读
  // `chars[id].avatar/portrait`、`enemies[id].icon`。包没法往 assets.json 加条目，于是**新干员/新怪物只能画成
  // 一张菱形贴图**（shared/workshop.js chessLookIssues 会在启动日志里警告这件事）。这个字段把口子开在 pack.json 上：
  // 装载时叠加进 `assets.<表>`（mergeWorkshopArt），路径变成 /workshop-assets 的绝对 URL —— 客户端零改动
  // （validSpine 只要求 skel 是 `/` 开头的路径，包素材路由天然满足）。
  //
  // 两条**包改不了**的硬约束（由 vendor 里的 pixi-spine 决定，校验器会逐条查，见 tools/workshop-validate.mjs）：
  //   * `.atlas` 必须与 `.skel` **同目录同名** —— 加载器是从 skel 的路径推出 atlas 的，清单里的 `atlas` 字段我方代码
  //     只是用来做内存回收（assets.js forgetPendingSpine），写错不会报错，只会画不出来；
  //   * `.atlas` 里写的每一页 png 必须与它**同目录同名**。
  // 形状按表驱动（ART_TABLES）：哪几个字段是路径、spine 是嵌套（chars 的 front/back）还是扁平（enemies/tokens），
  // 都写在那一张表里，校验、索引与并表三处共用，不会各自漂移。
  const art = raw.art === undefined ? {} : raw.art;
  if (!isPlainObj(art)) return fail('ART_BAD_SHAPE', 'art must be an object: { chars|enemies|tokens: { "<id>": { … } } }');
  if (Object.keys(art).length && opts.hasAssets !== true) {
    return fail('ART_NEEDS_ASSETS', 'a pack that declares art must put the files in its assets/ folder (e.g. assets/art/…)');
  }
  /** @type {Record<string, Record<string, object>>} */
  const artEntries = {};
  for (const [table, entries] of Object.entries(art)) {
    const shape = ART_TABLES[table];
    if (!shape) return fail('ART_UNKNOWN_TABLE', `"${table}" is not an art table (one of: ${Object.keys(ART_TABLES).join(', ')})`);
    if (!isPlainObj(entries)) return fail('ART_BAD_SHAPE', `art.${table} must be an object: { "<id>": { … } }`);
    const clean = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!RECORD_ID_RE.test(id)) return fail('ART_BAD_ID', `art.${table}: "${id}" is not a valid id`);
      // 扁平表：条目本身就是路径（`assets.skills[key]` / `assets.prof.sub[key]` 的值就是路径字符串）
      if (shape.flat) {
        if (!isSafeAssetPath(entry)) {
          return fail('ART_PATH_UNSAFE', `art.${table}["${id}"]: "${String(entry)}" must be a relative path inside assets/`);
        }
        clean[id] = entry;
        continue;
      }
      const parsed = parseArtEntry(entry, `art.${table}["${id}"]`, shape);
      if (parsed.error) return fail(parsed.error, parsed.detail);
      if (Object.keys(parsed.entry).length) clean[id] = parsed.entry;
    }
    if (Object.keys(clean).length) artEntries[table] = clean;
  }
  // 助战卡池贡献 (docs/WORKSHOP.md §2): the operators of THIS pack that should be selectable as 助战. The tier is NOT
  // written here — it is derived from the pack's own chess record, exactly like every other derived field, so a tier can
  // never disagree with the record (a mismatch would silently disable the operator: shared/support.js isSupportChess
  // requires the id to sit under its own tier).
  const support = raw.support === undefined ? [] : raw.support;
  if (!Array.isArray(support)) {
    return fail('SUPPORT_BAD_SHAPE', 'support must be an array of operator ids this pack adds, e.g. ["chess_char_ws_my_op_a"]');
  }
  const supportIds = [];
  for (const id of support) {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
      return fail('SUPPORT_BAD_ID', `"${String(id)}" is not a valid operator id`);
    }
    if (!supportIds.includes(id)) supportIds.push(id);
  }
  // 自选池贡献 (`pack.json.operators`, docs/WORKSHOP.md §1.2): the operators of THIS pack that should be **selectable
  // in the 自选 pool** (`data/backups.json` 的 `diy.ownedPool` / `diy.operators`) — the half that made a community
  // "new operator" mod a hand-patch instead of a pack.
  //
  // 形状是**对象**（不是数组）：每个干员要带它自己的盟约与该盟约的权能。而 `name` / `rarity` / `profession` /
  // `subProfessionId` **一律从同一个包的 `units[charId]` 派生**（`mergeWorkshopOperators`），清单里再写一遍就是
  // 两份会漂移的真相 —— `diy.operators` 那份今天是生成器产出的，包不该抄它。
  //
  // 这里只查**形状**与「同一个 id 只出现一次」；「有没有同名的 units 记录」「是不是 6★」「盟约存不存在」三条要读
  // 数据，它们失败要关闭，所以在加载期（`mergeWorkshopOperators`）判定并点名报告。
  const operators = raw.operators === undefined ? {} : raw.operators;
  if (!isPlainObj(operators)) {
    return fail('OPERATOR_BAD_SHAPE', 'operators must be an object: { "<charId>": { bonds: ["<bondId>"], powers: ["<powerId>"] } }');
  }
  /** @type {Record<string, { powers: string[], bonds: string[] }>} */
  const operatorDecls = {};
  for (const [charId, decl] of Object.entries(operators)) {
    if (!RECORD_ID_RE.test(charId)) return fail('OPERATOR_BAD_SHAPE', `operators: "${charId}" is not a valid operator id`);
    if (!isPlainObj(decl)) return fail('OPERATOR_BAD_SHAPE', `operators["${charId}"] must be an object: { bonds, powers }`);
    const parsed = { powers: [], bonds: [] };
    for (const field of OPERATOR_LIST_FIELDS) {
      const list = parseStringList(decl[field], `operators["${charId}"].${field}`);
      if (!list.ok) return fail('OPERATOR_BAD_SHAPE', list.detail);
      parsed[field] = list.list;
    }
    operatorDecls[charId] = parsed;
  }
  // 键序是**清单的字节**的一部分（`identifyPack` 把归一化后的清单哈希进去），所以按 id 排序，不随作者书写顺序变。
  const orderedOperators = Object.fromEntries(Object.keys(operatorDecls).sort().map((k) => [k, operatorDecls[k]]));
  // 试玩行为开关（行为层，不进记录）：`playtest: { "directToHand": ["<chessId>", …] }`。
  //
  // 为什么住在 pack.json 而不是 chess 记录里：覆盖模式下记录必须与官方**同形**（官方记录没有
  // `directToHand` 这个键，保存路径因此会在写补丁前把它摘掉），而「试玩时直接发到手上」是**行为层**的开关，
  // 不是「覆盖官方数据」这件事 —— 于是覆盖一条官方干员时它曾经静默失效。搬到这里之后，记录继续同形，
  // 开关照旧能用（见 docs/WORKSHOP.md §1.2）。
  //
  // 形状这一层只查「是不是对象、值是不是字符串数组」；「名单里的 id 真的属于这个包吗」要看包自己的
  // chess 记录与 `overrides`，那只有文件系统/加载器知道（`server/workshop.js` 与 `tools/workshop-pack.mjs`
  // 用同一个 `playtestUnknownIds` 判）。
  const playtest = raw.playtest === undefined ? {} : raw.playtest;
  if (!isPlainObj(playtest)) {
    return fail('PLAYTEST_BAD_SHAPE', 'playtest must be an object: { "directToHand": ["<chessId>", …] }');
  }
  /** @type {string[]} */
  let directToHand = [];
  if (playtest.directToHand !== undefined) {
    if (!Array.isArray(playtest.directToHand)) {
      return fail('PLAYTEST_BAD_SHAPE', 'playtest.directToHand must be an array of chess ids this pack ships (or declares in overrides)');
    }
    for (const id of playtest.directToHand) {
      if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
        return fail('PLAYTEST_BAD_SHAPE', `playtest.directToHand: "${String(id)}" is not a valid chess id`);
      }
      if (!directToHand.includes(id)) directToHand.push(id);
    }
    directToHand.sort();
  }
  // 中间层四组能力声明（DESIGN §28.13）：`assets` 客户端资源容器、`client` C 层注册点、`server.preDispatch`
  // 分发前钩子、`routes` 只读路由。本轮**纯加法**：解析、点名拒绝、并进身份哈希，没有一条行为读它们。
  //
  // 这里的四段顺序与 `declared` 收集顺序只影响可读性：返回对象的键序不影响哈希（`canonicalJson` 排序键），
  // 但**键在不在**影响哈希 —— 所以下面用 `raw[k] !== undefined` 判定「这个包声明了没有」。
  const assetsParsed = raw.assets === undefined ? null : parseAssetsDecl(raw.assets);
  if (assetsParsed && !assetsParsed.ok) return assetsParsed;
  const clientParsed = raw.client === undefined ? null : parseClientDecl(raw.client);
  if (clientParsed && !clientParsed.ok) return clientParsed;
  const serverParsed = raw.server === undefined ? null : parseServerDecl(raw.server);
  if (serverParsed && !serverParsed.ok) return serverParsed;
  const routesParsed = raw.routes === undefined ? null : parseRoutesDecl(raw.routes);
  if (routesParsed && !routesParsed.ok) return routesParsed;
  // `i18n`（fanpack G-04）：给**已有语种**补词条的声明，形状见 `parseI18nDecl`。它同样遵守上面那条
  // 「只在清单真的写了这个键时才进归一化结果」的纪律 —— 没声明 i18n 的包（今天所有的包）哈希逐字节不变。
  const i18nParsed = raw.i18n === undefined ? null : parseI18nDecl(raw.i18n);
  if (i18nParsed && !i18nParsed.ok) return i18nParsed;
  // 一条声明只有在清单里**真的写了这个键**时才进归一化结果。这一条是本刀最容易做坏的地方：无条件写进去会让
  // 每一个已存在的包（它们没有这些键）的归一化清单多出四个键，于是内容哈希全变、`identifyPack` 的
  // `manifest` 与 `hash` 也跟着变 —— 房间的摘要闸门会开始误判（DESIGN §28.2）。
  /** @type {Array<[string, object]>} */
  const declared = [];
  if (assetsParsed) declared.push(['assets', assetsParsed.decl]);
  if (clientParsed) declared.push(['client', clientParsed.decl]);
  if (serverParsed) declared.push(['server', serverParsed.decl]);
  if (routesParsed) declared.push(['routes', routesParsed.decl]);
  if (i18nParsed) declared.push(['i18n', i18nParsed.decl]);
  /** 一条声明算不算「贡献」：归一化后的值里有没有东西。`routes: []` 与 `client: { panels: [], requires: [] }`
   *  都是**合法但什么都不做**的声明（与 `voices: {}` / `art: { chars: {} }` 同一个语义），照旧不算贡献 ——
   *  所以「一个只写了 `routes: []` 的包」仍然是空包。反向的那条同样载重：`assets` / `client.panels` /
   *  `server.preDispatch` 的必填字段在形状层就各自非空，所以它们只声明出来就**是**贡献项。 */
  const contributes = (v) => (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
  // A pack may bring data files, voice lines (either table), 盟约图标, 装备图标, 外观素材, 助战声明, 自选池声明
  // — never none of them (docs/WORKSHOP.md §1.4). 这条检查必须放在**所有**贡献项都解析完之后：放在前面会出现
  // 「一个只带 `operators` 的包被判成空包」，而在它前面引用后面声明的变量则是 TDZ 报错。
  // `playtest` **不是**贡献项：它是行为开关，一个只带它的包仍然什么都没带来，照旧 EMPTY_PACK
  // （test/playtestDirectToHand.test.js 有断言钉住这一点）。四组新声明的贡献语义见上面 `contributes` 的注释：
  // A 段把提案的语义落死（B 段实现行为时不用再改），而「只带 `playtest` 照旧被拒」这条既有裁决一字未动。
  if (!content.length && !Object.keys(voiceLines).length && !Object.keys(orderedLangLines).length
    && !Object.keys(bondIconFiles).length && !Object.keys(itemIconFiles).length && !Object.keys(artEntries).length
    && !Object.keys(orderedOperators).length && !declared.some(([, v]) => contributes(v))) {
    // `support` 与 `playtest` 是这份清单里**唯二**「声明了也不算贡献」的字段，所以它们单独出现时必须被点名 ——
    // 只声明助战的包今天整包被拒（plugin-pack G6：一个 `support: [...]` + `content: []` 的包得到的就是这一条），
    // 而原来的文案里**没有** `support` 这个词，作者只能对着 `EMPTY_PACK` 猜。`support` 只决定**助战卡池**里放谁，
    // 干员本体还是由 `content: ["chess"]` 带进来的 —— 所以放宽它不是这一刀的活（那是既有裁决），把话说明白才是。
    const notContributions = ['support', 'playtest']
      .filter((n) => raw[n] !== undefined);
    const names = [...WORKSHOP_CONTENT_FILES, 'voices', 'voiceLangs', 'bondIcons', 'itemIcons', 'art', 'operators',
      'assets', 'client', 'server.preDispatch', 'server.meta', 'routes', 'i18n'];
    const alsoNot = notContributions.length
      ? ` (note: ${notContributions.map((n) => `"${n}"`).join(' and ')} ${notContributions.length === 1 ? 'is' : 'are'} NOT a contribution — a pack that declares ${notContributions.length === 1 ? 'it' : 'them'} alone brings nothing into a match)`
      : '';
    return fail('EMPTY_PACK', `content must name at least one of: ${WORKSHOP_CONTENT_FILES.join(', ')} — or the pack must declare ${names.filter((n) => !WORKSHOP_CONTENT_FILES.includes(n)).join(' / ')}${alsoNot}`);
  }
  // 版本声明（DESIGN §28.5）：`api` 是**模组 API** 的区间（钩子总线与 kit 契约），`game` 是**上游游戏版本**的区间，
  // 两者都用 shared/packs.js isVersionRange 的语法（`>=0.2.0`、`0.2.x`、`^0.2.0`、`~0.2.1`、`*`、`||`）。
  // `gameVersion` 保留一代作为 `game` 的别名：编辑器与现成的包都在写它，读的时候优先 `game`。
  const api = strField(raw.api, 60);
  if (api && !isVersionRange(api)) return fail('BAD_API_RANGE', `"api": "${api}" is not a version range (">=1 <2", "1.x" …)`);
  // `api` 的可比对那一半（DESIGN §28.5 的前置项，本轮补上）：`shared/constants.js MOD_API_VERSION` 是钩子总线与
  // kit 契约的版本，**只在包自己声明了 `api` 时才比对** —— 没声明的包（今天所有的包）一个字节都不受影响。
  // 拒绝而不是降级：一个按别的总线写的钩子无法被证明是安全的，而「运行它」正是「有声明、没验证」那一类错误。
  // 版本串由常量推导（`appVersionMatches` 读三段的 `vM.m.p`，**读不出来时算匹配** —— 那个兜底会让每一次比对
  // 都通过，所以这里绝不能把整数直接传进去）。
  if (api && !appVersionMatches(api, `${MOD_API_VERSION}.0.0`)) {
    return fail('MOD_API_INCOMPATIBLE', `this pack declares "api": "${api}", which excludes the installed mod API ${MOD_API_VERSION} (DESIGN §28.5: write the range this pack was written against, or drop the field)`);
  }
  const game = strField(raw.game, 60) ?? strField(raw.gameVersion, 60);
  if (game && !isVersionRange(game)) return fail('BAD_GAME_RANGE', `"game": "${game}" is not a version range (">=0.2.0", "0.2.x" …)`);
  // 声明的层（DESIGN §28.1）：A 内容 / B 服务端逻辑 / C 客户端界面。写错了要拒，不能猜。
  const layer = raw.layer === undefined || raw.layer === null ? null : String(raw.layer).trim().toUpperCase();
  if (layer !== null && !MOD_LAYERS.includes(layer)) return fail('BAD_LAYER', `"layer": "${raw.layer}" is not one of ${MOD_LAYERS.join(' / ')}`);
  if (raw.combat !== undefined && typeof raw.combat !== 'boolean') return fail('BAD_COMBAT', '"combat" must be true or false (may this pack change a battle result?)');
  // `server.meta` 改的是**对局结果**，所以按业主裁决（2026-10-10）它必须声明 `combat: true` —— 那正是「要改
  // 对局结果的包进入房间摘要闸门 + golden 语料」这条线的入口（DESIGN §28.13.1 与 §29）。**硬闸门，不是警告**：
  // 一个能改结果却把自己标成 `combat: false` 的包，会让「不声明 combat 的包改不了结果」这句话从**结构性保证**
  // 退化成一句口号。位置放在这里（而不是形状层刚解析完 `server` 的地方）是为了让 `combat` 的**类型**错误先报出来。
  if (serverParsed && serverParsed.decl.meta && raw.combat !== true) {
    return fail('META_NEEDS_COMBAT', 'server.meta changes match results, so this pack must declare "combat": true — that is what puts it into the room digest gate and the golden corpus (DESIGN §29); a pack that cannot state that must not ship server-side match logic');
  }
  return {
    ok: true,
    pack: {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      version: typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0',
      author: typeof raw.author === 'string' && raw.author ? raw.author : null,
      license,
      hasAssets: opts.hasAssets === true,
      description: typeof raw.description === 'string' && raw.description ? raw.description : null,
      gameVersion: typeof raw.gameVersion === 'string' && raw.gameVersion ? raw.gameVersion : null,
      api,
      game,
      layer,
      combat: typeof raw.combat === 'boolean' ? raw.combat : null,
      content,
      overrides,
      voices: voiceLines,
      voiceLangs: orderedLangLines,
      bondIcons: bondIconFiles,
      itemIcons: itemIconFiles,
      art: artEntries,
      support: supportIds,
      operators: orderedOperators,
      playtest: { directToHand },
      // 四组新声明：**只在声明过时才存在**（见上面 `declared` 的注释）。哈希覆盖它们靠的就是这一条 ——
      // `identifyPack` 哈希的是这份归一化清单的 `canonicalJson`（server/workshop.js）。
      ...Object.fromEntries(declared),
    },
  };
}

/**
 * `pack.json.playtest.directToHand` 里那些**不属于这个包**的 id（`PLAYTEST_UNKNOWN_CHESS` 的判罚依据）。
 *
 * 为什么要有这条：名单里的 id 只要加载器不认识，开关就是**静默失效** —— 作者在界面上勾了、试玩里却什么都没发生。
 * 静默无效正是这个缺口的老毛病，所以这里点名拒绝。合法的 id 只有两类：
 *   * 本包自己的 chess 记录 id（`ownChessIds`，非覆盖的工坊干员）；
 *   * 本包在 `overrides` 里声明过的官方 id（覆盖模式：记录写的是官方 id，加载器只认这条声明）。
 *
 * 形状（不是对象、值不是字符串数组）在 `normalizePackManifest` 就已经被拒了，这里只管成员资格。
 * 判罚只有这一份：加载器（`server/workshop.js`）、`tools/workshop-pack.mjs` 的 `readPackDir`
 * 与编辑器读包的地方都调它，所以三处不可能给出不同结论。
 *
 * @param {string[]} declared `pack.json.playtest.directToHand`（已归一化）
 * @param {string[]} overrides `pack.json.overrides`（`"<file>:<id>"` 列表）
 * @param {Iterable<string>} ownChessIds 本包 chess.json 自己的记录 id
 * @returns {string[]} 不认识的 id（保持声明顺序，去重）
 */
export function playtestUnknownIds(declared, overrides, ownChessIds) {
  const own = ownChessIds instanceof Set ? ownChessIds : new Set(Array.isArray(ownChessIds) ? ownChessIds : []);
  const declaredOverrides = new Set(Array.isArray(overrides) ? overrides : []);
  const out = [];
  for (const id of Array.isArray(declared) ? declared : []) {
    if (typeof id !== 'string' || !id) continue;
    if (own.has(id)) continue;
    if (declaredOverrides.has(`chess:${id}`)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Validate one content file of a pack: a `{ [id]: record }` map, every key a safe id, every value a JSON object, and —
 * when the record carries its own id field — that field equal to the key.
 *
 * `units`（新干员的干员记录）**另外**要过一遍「下游用得上吗」：见 `UNIT_REQUIRED_FIELDS` 的长注释 —— 我们只查那
 * 六个字段，其余一律照抄，不复制官方 schema。
 * @param {string} file data file basename, e.g. 'chess'
 * @param {any} json parsed file
 * @returns {{ ok: true, records: Record<string, object> } | { ok: false, error: string, detail: string }}
 */
export function normalizeContentFile(file, json) {
  if (!isPlainObj(json)) return fail('BAD_CONTENT', `${file}.json must be a JSON object of { id: record }`);
  const field = ID_FIELD_BY_FILE[file] || null;
  /** @type {Record<string, object>} */
  const records = {};
  for (const [id, rec] of Object.entries(json)) {
    if (!RECORD_ID_RE.test(id)) return fail('BAD_RECORD_ID', `${file}.json key "${id}" is not a valid id`);
    if (!isPlainObj(rec)) return fail('BAD_RECORD', `${file}.json["${id}"] must be a JSON object`);
    if (field && rec[field] !== undefined && rec[field] !== id) {
      return fail('ID_MISMATCH', `${file}.json["${id}"].${field} is "${rec[field]}" — it must equal the key`);
    }
    if (file === 'units') {
      for (const need of UNIT_REQUIRED_FIELDS) {
        if (need.ok(rec[need.key])) continue;
        return fail(need.code, `units.json["${id}"].${need.key} ${need.detail}`);
      }
    }
    records[id] = rec;
  }
  if (!Object.keys(records).length) return fail('EMPTY_CONTENT', `${file}.json has no records`);
  return { ok: true, records };
}

// ---------------------------------------------------------------------------------------------------------------
// i18n：给**已有语种**补词条（fanpack G-04 / plugin-pack G4，docs/WORKSHOP.md §1.10）
//
// 背景：`packs/` 的 `lang` 类型只能**新增**一个语种 —— 带 `en` / `ja` / `ko` / `zh-TW` 的包会被真实的扫描器整包
// 跳过，原文是 `the language en is already provided by public/i18n/en.json`。而任何带新界面的包都需要给已有语种
// 补键，所以这是一个结构性的缺口。补法只有三条规矩，三条都必须有测试钉住：
//   1. **已有键绝不覆盖**（官方/先到的译文永远赢）；
//   2. **冲突显式报告**，点名 **键 + 语种 + 包 id**（外加双方的值）—— 只报「值不同」的重叠；
//   3. **包里的值必须是字符串**，否则整包拒绝（非字符串会让 `t()` 把原文打印到界面上，是查不出源头的那种故障）。
// ---------------------------------------------------------------------------------------------------------------

/**
 * 一个包的 `i18n` 声明摊平成 `Map<语种, { pack, file }>`（装载期校验、HTTP 合并体与校验器共用的**唯一**解析）。
 *
 * 同一个语种被多个包声明时**按包 id 排序后的第一个赢**（与 `workshopVoiceIndex` / DESIGN §28.3 同一条规则），
 * 其余的进 `overridden`：输的那个作者必须看到一行字，否则他会以为自己那份译文生效了。
 *
 * @param {Array<{ id?: string, i18n?: Record<string, string> }>} packs
 * @returns {{ langs: Map<string, { pack: string, file: string }>, overridden: Array<{ pack: string, lang: string, definedBy: string, reason: string }> }}
 */
export function parsePackI18n(packs) {
  /** @type {Map<string, { pack: string, file: string }>} */
  const langs = new Map();
  /** @type {Array<{ pack: string, lang: string, definedBy: string, reason: string }>} */
  const overridden = [];
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p === 'object' && p.id).sort(byPackId)) {
    const decl = isPlainObj(pack.i18n) ? pack.i18n : {};
    for (const lang of Object.keys(decl).sort()) {
      const file = decl[lang];
      if (typeof file !== 'string' || !file) continue;
      const holder = langs.get(lang);
      if (holder) {
        overridden.push({
          pack: pack.id, lang, definedBy: holder.pack.id,
          reason: `i18n["${lang}"] is already contributed by pack "${holder.pack.id}" — the pack with the smaller id keeps it (DESIGN §28.3). Drop this file, or let "${holder.pack.id}" drop it`,
        });
        continue;
      }
      langs.set(lang, { pack, file });
    }
  }
  return { langs, overridden };
}

/**
 * 把包带的词条并进一份已存在的语言文件 —— **已有键绝不覆盖**，冲突逐条报告（见上面那一节的三条规矩）。
 *
 * `entries` 的形状就是一条 i18n 声明的形状（`{ "<msgid>": "<译文>" }`）。校验与合并共用这一个函数：不可能出现
 * 「校验器放行的值，合并时被丢掉」。
 *
 * @param {Record<string, any>|null|undefined} base 已有的语言文件（`public/i18n/<code>.json` 的解析结果）
 * @param {Record<string, any>|null|undefined} entries 包声明的词条
 * @param {{ pack?: string, lang?: string }} [where] 点名信息（拒绝文案与冲突报告都带上）
 * @returns {{ ok: true, merged: Record<string, any>, added: string[], conflicts: Array<{ pack: string, lang: string, key: string, official: string, packValue: string }>, skippedSame: number }
 *   | { ok: false, error: string, detail: string }}
 */
export function mergeWorkshopI18n(base, entries, { pack = '', lang = '' } = {}) {
  if (entries !== undefined && !isPlainObj(entries)) {
    return fail('I18N_BAD_FILE', `i18n["${lang}"] must be a JSON object of { "<msgid>": "<translation>" } (got ${Array.isArray(entries) ? 'an array' : typeof entries})`);
  }
  const clean = isPlainObj(entries) ? entries : {};
  /** @type {string[]} */
  const added = [];
  /** @type {Array<{ pack: string, lang: string, key: string, official: string, packValue: string }>} */
  const conflicts = [];
  let skippedSame = 0;
  for (const key of Object.keys(clean).sort()) {
    const value = clean[key];
    if (!key || key.startsWith('_')) {
      return fail('I18N_BAD_KEY', `i18n["${lang}"]: "${key}" is not a valid msgid (a non-empty key that does not start with "_" — the "_"-prefixed keys are a language file's metadata block)`);
    }
    if (typeof value !== 'string') {
      return fail('I18N_BAD_VALUE', `i18n["${lang}"]: "${key}" must map to a string (got ${Array.isArray(value) ? 'an array' : typeof value}) — t() would print the raw value, and the broken interface could never be traced back to this pack`);
    }
    const official = isPlainObj(base) ? base[key] : undefined;
    if (typeof official === 'string') {
      // 已有键**绝不覆盖**。值相同就什么都不用做（也不是冲突）；值不同就是一条要报出来的冲突。
      if (official === value) skippedSame++;
      else conflicts.push({ pack, lang, key, official, packValue: value });
      continue;
    }
    if (!added.includes(key)) added.push(key);
  }
  const merged = { ...(isPlainObj(base) ? base : {}) };
  for (const key of added) merged[key] = clean[key];
  return { ok: true, merged, added, conflicts, skippedSame };
}

/**
 * `parsePackI18n` + `mergeWorkshopI18n` 的一站式版本：遍历每个声明的语种，读出包的文件并合并。
 *
 * 读盘由调用方注入（`shared/` 两端共用，浏览器没有 fs）：`readFile(packId, file)` 返回**已解析的对象**，或 `null`
 * （文件不在 / 不是 JSON）。所以「文件在不在」的判罚点只有调用方一处，而「值合不合法」的判罚点只有这里一个。
 *
 * @param {Array<{ id?: string, i18n?: Record<string, string> }>} packs
 * @param {(pack: string, file: string) => Record<string, any>|null} readFile `(pack id, declared path)` → the parsed file
 * @param {(lang: string) => Record<string, any>|null} readBase 读官方语言文件（`public/i18n/<code>.json`）
 * @returns {{ files: Map<string, Record<string, any>>, added: Record<string, string[]>, conflicts: object[], skippedSame: Record<string, number>, errors: Array<{ pack: string, lang: string, code: string, reason: string }> }}
 */
export function workshopI18nFiles(packs, readFile, readBase) {
  const { langs, overridden } = parsePackI18n(packs);
  /** @type {Map<string, Record<string, any>>} */
  const files = new Map();
  /** @type {Record<string, string[]>} */
  const added = {};
  /** @type {object[]} */
  const conflicts = [...overridden];
  /** @type {Record<string, number>} */
  const skippedSame = {};
  /** @type {Array<{ pack: string, lang: string, code: string, reason: string }>} */
  const errors = [];
  for (const lang of [...langs.keys()].sort()) {
    const { pack, file } = langs.get(lang);
    const entries = readFile(pack.id, file);
    if (entries === null || entries === undefined) {
      errors.push({
        pack: pack.id, lang, code: 'I18N_BAD_FILE',
        reason: `i18n["${lang}"] names "${file}", which is not a readable JSON object inside the pack`,
      });
      continue;
    }
    const merged = mergeWorkshopI18n(readBase(lang), entries, { pack: pack.id, lang });
    if (!merged.ok) {
      errors.push({ pack: pack.id, lang, code: merged.error, reason: merged.detail });
      continue;
    }
    files.set(lang, merged.merged);
    if (merged.added.length) (added[pack.id] ||= []).push(...merged.added.map((k) => `${lang}:${k}`));
    for (const c of merged.conflicts) conflicts.push(c);
    if (merged.skippedSame) skippedSame[lang] = merged.skippedSame;
  }
  for (const list of Object.values(added)) list.sort();
  return { files, added, conflicts, skippedSame, errors };
}

/**
 * `stripPackOperators`（fanpack G-16）：**包把一名官方干员变成棋子**时，他与自选池的关系要**记录下来** ——
 * 一个被包变成棋子的干员同时躺在自选池里，意味着同一个干员能被上两次（一次作为棋子、一次作为自选槽），
 * 而且还绕过棋子自己的盟约。原件在它自己的 `shared/customContent.js` 里为此写了一条装载层规则：**把人摘出池**。
 *
 * 本刀**只做「记录 + 拒绝重复」这一半**，理由必须说清（业主需要裁决的那一半）：
 *
 *   * `diy.ownedPool` 是「自选槽能挑的已拥有干员」这份**名单本身**（`shared/diy.js` 从它出格子，
 *     `tools/golden.mjs` 给池里每一位配一个精锐场景）。把它摘掉不是「去重」，而是**改对局结果**：
 *     池子变小、可挑的干员变少、语料里那一位的场景整个消失。实测：fanpack 那份真实数据里 **8 名**
 *     干员同时在池里（`char_147_shining`、`char_4088_hodrer`、`char_4132_ascln`、`char_1035_wisdel`、
 *     `char_017_huang`、`char_003_kalts`、`char_4179_monstr`、`char_4133_logos`），摘掉就是 `ownedPool` 71 → 63。
 *   * 而本刀的验收要求 `test/golden/*.json` 一个字节都不动、六份语料的数字不变 —— 这两件事不可能同时成立。
 *     按 `AGENTS.md`「Deliberate deviations from the official mode are the maintainer's decision only」，
 *     这一半是**维护者的决定**，所以它停在这里，写进报告等裁决。
 *
 * 「拒绝重复」那一半**今天已经成立**，而且不在这个函数里：`mergeWorkshopOperators` 的 `if (!pool.includes(id))`
 * 是一条既有的不变量（`test/workshopOperators.test.js` 钉着「一个 id 只进池一次」）。所以一个包把池里已有的
 * 干员声明进 `operators` 时**不会**让池里出现第二条 —— 但「他本来就在池里、现在又被这个包变成棋子」这件事
 * 以前**没有任何地方说出来**，这个函数就是那句话。
 *
 * @param {Array<{ id?: string, operators?: Record<string, unknown>, files?: Record<string, Record<string, object>> }>} packs
 * @param {Readonly<Record<string, any>>} data 合并后的数据（`data.backups.units` / `data.backups.diy.ownedPool`）
 * @returns {{ overlaps: Array<{ pack: string, charId: string, inPoolBefore: boolean, poolEntry: boolean, entryFrom: string, note: string }>, stripped: string[] }}
 *   `overlaps` 逐条点名（`inPoolBefore` = 官方池里本来就有他，`poolEntry` = 他是这个包声明进池的）；
 *   `stripped` 是**没有真的被摘掉**的 id（本刀不移除任何东西，所以它列出的就是全部 `inPoolBefore` 的 id ——
 *   留一个显式的名字，好让将来真的做摘除时改动面一目了然）。
 */
export function stripPackOperators(packs, data) {
  const backups = isPlainObj(data) && isPlainObj(data.backups) ? data.backups : {};
  const ownedPool = Array.isArray(backups.diy?.ownedPool) ? backups.diy.ownedPool : [];
  const inPool = new Set(ownedPool);
  /** @type {Array<{ pack: string, charId: string, inPoolBefore: boolean, poolEntry: boolean, entryFrom: string, note: string }>} */
  const overlaps = [];
  /** @type {string[]} */
  const stripped = [];
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId)) {
    /** @type {Map<string, string>} charId → 这个包把它变成棋子的那条记录 id */
    const chessByChar = new Map();
    for (const [chessId, rec] of Object.entries(isPlainObj(pack.files?.chess) ? pack.files.chess : {})) {
      const charId = isPlainObj(rec) && typeof rec.charId === 'string' && rec.charId ? rec.charId : null;
      if (charId && !chessByChar.has(charId)) chessByChar.set(charId, chessId);
    }
    const declared = isPlainObj(pack.operators) ? pack.operators : {};
    for (const charId of [...chessByChar.keys()].sort()) {
      const inPoolBefore = inPool.has(charId);
      const poolEntry = Object.hasOwn(declared, charId);
      if (!inPoolBefore && !poolEntry) continue;
      if (inPoolBefore) stripped.push(charId);
      overlaps.push({
        pack: pack.id, charId, inPoolBefore, poolEntry,
        entryFrom: chessByChar.get(charId),
        note: inPoolBefore
          ? `"${charId}" is in the 自选 pool (data/backups.json diy.ownedPool) AND this pack turns him into the chess piece "${chessByChar.get(charId)}" — he can be fielded twice, and the 自选 slot bypasses the piece's own bond. Stripping him from the pool changes what the pool offers, so it is the maintainer's call (see the loader report)`
          : `this pack puts "${charId}" into the 自选 pool through pack.json operators AND ships the chess piece "${chessByChar.get(charId)}" for the same operator — one operator with two ways in`,
      });
    }
  }
  return { overlaps, stripped };
}

/**
 * The voice lines every pack contributes, keyed exactly like the manifest the client looks them up in:
 * `{ <charId>: { <slot>: [url, …] } }` (docs/ASSETS.md "Voice lines").
 *
 * The URLs point into the pack media route (`WORKSHOP_MEDIA_PREFIX`), so the client needs no new channel: the overlay
 * merges this map into `assets.audio.voice` and the game server serves `/data/assets.json` merged, which is the object
 * public/js/audio.js already reads (`installAudio({ getManifest: () => data.get('assets') })`).
 *
 * Every path segment is percent-encoded: a pack filename may legitimately hold a `#`, a space or a `+`, and the route
 * decodes the path before it resolves it (`/workshop-assets/<pack>/voice/a%23b.mp3`).
 *
 * @param {Array<{ id: string, voices?: Record<string, Record<string, string[]>>, voiceLangs?: Record<string, Record<string, Record<string, string[]>>> }>} packs loaded packs (server/workshop.js)
 * @param {{ prefix?: string, lang?: string|null }} [opts] `lang` selects a dub's table (`voiceLangs[lang]`); the default
 *   (null) is the pack's default-dub table `voices`.
 * @returns {Record<string, Record<string, string[]>>}
 */
export function workshopVoiceIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX, lang = null } = {}) {
  /** @type {Record<string, Record<string, string[]>>} */
  const out = {};
  const list = (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id);
  // sorted by pack id: the merged line list must not depend on the order the filesystem handed the packs over
  for (const pack of [...list].sort(byPackId)) {
    const table = lang === null
      ? (isPlainObj(pack.voices) ? pack.voices : null)
      : (isPlainObj(pack.voiceLangs) && isPlainObj(pack.voiceLangs[lang]) ? pack.voiceLangs[lang] : null);
    if (!table) continue;
    for (const [charId, slots] of Object.entries(table)) {
      if (!isPlainObj(slots)) continue;
      for (const [slot, files] of Object.entries(slots)) {
        if (!Array.isArray(files) || !files.length) continue;
        const bySlot = (out[charId] ||= {});
        const urls = (bySlot[slot] ||= []);
        for (const f of files) {
          if (typeof f !== 'string' || !f) continue;
          urls.push(prefix + pack.id + '/' + f.split('/').map(encodeURIComponent).join('/'));
        }
      }
    }
  }
  return out;
}

/**
 * Every NON-default dub the packs declare, one index each: `{ <lang>: <workshopVoiceIndex shape> }`.
 *
 * The default dub's table is `voices` itself, so it is not repeated here — `normalizePackManifest` refuses a
 * `voiceLangs[<default>]` outright (VOICE_LANG_DEFAULT). A language no pack declares is simply absent, so the overlay
 * never writes an empty `voiceLangs` into a manifest that had none.
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 * @returns {Record<string, Record<string, Record<string, string[]>>>}
 */
export function workshopVoiceLangIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, Record<string, Record<string, string[]>>>} */
  const out = {};
  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!pack || !isPlainObj(pack.voiceLangs)) continue;
    for (const lang of Object.keys(pack.voiceLangs)) {
      if (out[lang] || !VOICE_LANGS.includes(lang) || lang === DEFAULT_VOICE_LANG) continue;
      const index = workshopVoiceIndex(packs, { prefix, lang });
      if (Object.keys(index).length) out[lang] = index;
    }
  }
  // VOICE_LANGS order decides the key order: this object ends up in the merged manifest, and that file must not change
  // with the order the packs happened to load in.
  return Object.fromEntries(VOICE_LANGS.filter((l) => out[l]).map((l) => [l, out[l]]));
}

/**
 * The ONE arbitration order of the overlay (DESIGN §28.3): pack ids are slugs, so a plain code-unit compare is a stable,
 * locale-independent order, and "the pack with the smaller id wins" is decided by this comparator on **every** face —
 * data records, kit ids, icons, item icons and art. Exported because the kit loader (server/workshop.js) must sort by
 * the same rule; two orderings would be two contracts, and the loser of a collision would depend on which one ran.
 */
export const byPackId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 「试玩时直接发到手上」名单的**声明侧**：把所有包的 `pack.json.playtest.directToHand` 汇成一份名单，并裁掉撞车的。
 *
 * 沿用 §1.2 的**谁赢**规则（DESIGN §28.3）：两个包声明同一个 id 时，包 id 字典序最小者赢，输的一方拿到一条
 * **点名**报告（`definedBy` 是赢家的包 id）。与其它面一样，结果只取决于包 id —— 先把包按 `byPackId` 排序再处理，
 * 所以与「目录是按什么顺序扫描到的」无关。
 *
 * 这只是名单的**一半**：另一半是记录里自带 `directToHand: true` 的工坊件（非覆盖的包，向后兼容）。
 * 两半的并集在引擎侧算（`server/match/match/phases.js` 的 `directToHandIds`）—— 正式服务器一个都不发，
 * 因为那里 `SP_PLAYTEST` 不是 `1`。
 *
 * @param {Array<{ id: string, playtest?: { directToHand?: string[] } }>} packs
 * @returns {{ ids: string[], errors: Array<{ pack: string, id: string, code: string, definedBy: string, reason: string }> }}
 */
export function workshopPlaytestIndex(packs) {
  /** @type {string[]} */
  const ids = [];
  const owner = new Map();
  const errors = [];
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId)) {
    const declared = isPlainObj(pack.playtest) && Array.isArray(pack.playtest.directToHand) ? pack.playtest.directToHand : [];
    for (const id of declared) {
      if (typeof id !== 'string' || !id) continue;
      const holder = owner.get(id);
      if (holder) {
        if (holder === pack.id) continue;
        errors.push({
          pack: pack.id, id, code: 'PLAYTEST_ID_COLLISION', definedBy: holder,
          reason: `"${id}" is already declared by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3). Remove it from this pack, or rename the record; an "overrides" entry does not win against another pack`,
        });
        continue;
      }
      owner.set(id, pack.id);
      ids.push(id);
    }
  }
  return { ids, errors };
}

/**
 * Keys of a record that an override REPLACES wholesale instead of merging field by field (DESIGN §28.3, owner's
 * request of 2026-10-09). Two classes, one reason each:
 *
 *   * **behaviour / structure** — `skill`, `skills`, `talents`, `trait`, `traitBase`, `traitOverride`, `modules`,
 *     `rangeGrid`, `attackRangeGrid`, `assets`, `diy`, `bonds`: these are read as whole units by the sim and the
 *     loadout layer (`shared/loadoutRecord.js` resolveRecordLoadout / loadoutRecord, `server/sim/simdata.js`).
 *     Half-merging e.g. a `skill` (a new index with the old blackboard) would create a record nobody wrote and no
 *     validator describes; replacing is the only honest reading of "this pack ships its own skill".
 *   * **arrays** — replaced by definition, a field-wise array merge has no meaning here.
 *
 * Everything else (numbers, strings, booleans and the plain objects that hold them, e.g. `stats`, `assets`' sibling
 * numeric maps) is merged field by field, recursively, so an override that writes ONE number keeps every other field of
 * the official record. That is the whole point: before this, a one-key override silently reduced a 44-field operator to
 * two fields, and `applyWorkshop` reported no error at all.
 */
export const OVERRIDE_REPLACE_KEYS = Object.freeze([
  'skill', 'skills', 'trait', 'traitBase', 'traitOverride', 'modules',
  'rangeGrid', 'attackRangeGrid', 'assets', 'diy', 'bonds',
]);

/**
 * Lists whose entries carry a **stable identity key**: merged entry by entry on that key instead of wholesale, so an
 * author's partial edit cannot erase data they never wrote.
 *
 * Why this exists (0.2.2's potential annotations): a record in `data/chess.json` carries `potDown`, and a talent carries
 * `potMin` + `potBelow` — the chain that changes that talent below a potential rank (`shared/potential.js`). A record
 * the editor derives deliberately carries **none** of them (that is the engine's convention; `stripPotential` is "what a
 * record built at one rank looks like"). So replacing `talents` wholesale dropped the official's whole potential chain
 * the moment an author touched one talent — while `potDown` survived only because the patch never mentioned it. Merging
 * by `index` keeps the chain: the author's fields win, everything they did not write stays.
 *
 * The key is a property of the **list**, not of the entry shape, and it is not always `index`:
 *
 *   * `talents` / `talentsBase` — a talent entry is keyed by `index` (sparse: 0, 1, 3).
 *   * `talentChanges` — the module-internal talent rewrites, keyed by `talentIndex` (the `name` of the field says it).
 *     It sits INSIDE an entry of `modules`, which is itself replaced wholesale; the key list still applies, because
 *     `mergeRecord` recurses into the entries it pairs up. Without it the same silent loss happened one level deeper:
 *     a record opened as an override template comes back without `potMin`/`potBelow`, `modules` is replaced wholesale,
 *     and the official's chained module talent is gone (see `test/overridePotential.test.js`).
 *
 * Deliberately narrow: only lists that HAVE such a key. `bonds` / `immunities` / `rangeGrid` / `modules` itself still
 * replace wholesale (see the note above `OVERRIDE_REPLACE_KEYS`): a field-wise merge of a bare list would invent a
 * record nobody wrote, and `modules` is an ordered list the loadout screen reads as a whole.
 */
export const OVERRIDE_KEYED_LISTS = Object.freeze({ talents: 'index', talentsBase: 'index', talentChanges: 'talentIndex' });

/**
 * Merge one override record onto the record it replaces: field by field, with `OVERRIDE_REPLACE_KEYS` and arrays taken
 * wholesale (`OVERRIDE_KEYED_LISTS` excepted — those merge on their identity key). The input objects are never mutated
 * (the caller may keep the official data frozen).
 * @param {object} base the record being overridden (official, or a record an earlier pack contributed)
 * @param {object} patch the pack's record
 * @returns {object} a new record
 */
export function mergeRecord(base, patch) {
  if (!isPlainObj(base) || !isPlainObj(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const idKey = OVERRIDE_KEYED_LISTS[key];
    if (idKey && Array.isArray(value) && Array.isArray(base[key])) {
      out[key] = mergeKeyedList(base[key], value, idKey);
      continue;
    }
    if (OVERRIDE_REPLACE_KEYS.includes(key) || Array.isArray(value)) { out[key] = value; continue; }
    out[key] = isPlainObj(value) && isPlainObj(base[key]) ? mergeRecord(base[key], value) : value;
  }
  return out;
}

/**
 * Merge a list whose entries carry an identity key (`OVERRIDE_KEYED_LISTS`) onto the base list: entries pair up by that
 * key and merge field by field, unmatched base entries stay where they are, unmatched patch entries are appended.
 *
 * Order and the base's own order are preserved (a `talents` index is sparse — 0, 1, 3 — so array position is not the
 * key). An entry without a usable key is appended rather than guessed at: that is a talent the author added.
 *
 * **A key that repeats is not an identity.** `talentChanges` uses `-1` for "a hidden module talent", and an official
 * module may carry several of those, so the same key can address more than one entry. When either side has a duplicate
 * key the whole list falls back to the behaviour every other list gets (replace wholesale): pairing two of them would
 * drop an entry, and appending the ambiguous ones would reorder a list the loadout screen reads positionally. Merging
 * is for a list that really is keyed; when the data says otherwise, honesty beats cleverness.
 * @param {unknown[]} baseList @param {unknown[]} patchList @param {string} idKey
 * @returns {unknown[]}
 */
function mergeKeyedList(baseList, patchList, idKey) {
  const at = new Map();
  const dup = (list) => {
    const seen = new Set();
    for (const entry of list) {
      if (!isPlainObj(entry) || !Number.isInteger(entry[idKey])) continue;
      if (seen.has(entry[idKey])) return true;
      seen.add(entry[idKey]);
    }
    return false;
  };
  if (dup(baseList) || dup(patchList)) return patchList;
  for (const [i, entry] of baseList.entries()) {
    if (isPlainObj(entry) && Number.isInteger(entry[idKey])) at.set(entry[idKey], i);
  }
  const out = baseList.map((e) => e);
  const added = [];
  for (const entry of patchList) {
    const i = isPlainObj(entry) && Number.isInteger(entry[idKey]) ? at.get(entry[idKey]) : undefined;
    if (i === undefined) { added.push(entry); continue; }
    out[i] = mergeRecord(baseList[i], entry);
  }
  return [...out, ...added];
}

/**
 * The keys of `patch` that the record it overrides does not have (DESIGN §28.3, "closed world"): a declared override
 * may only speak about fields that exist, because today any well-formed nonsense is accepted silently and the author
 * gets a record that is quietly not what they wrote. `null` when `base` is not an object (nothing to compare against).
 * @param {object} base @param {object} patch
 * @returns {string[]|null}
 */
export function unknownOverrideKeys(base, patch) {
  if (!isPlainObj(base) || !isPlainObj(patch)) return null;
  return Object.keys(patch).filter((k) => !Object.hasOwn(base, k));
}

/**
 * Resolve every pack's 助战 declaration (`pack.json.support`) into the pool entries it asks for, plus the reasons a
 * declaration is refused (docs/WORKSHOP.md §2).
 *
 * ONE rule, two callers: the overlay (`mergeWorkshopSupport`, which actually publishes them) and
 * `tools/workshop-validate.mjs` (which reports them to the author). Two restrictions, both deliberate:
 *   * only an operator THIS pack adds may enter the pool — a pack must not change which OFFICIAL operators are
 *     available as 助战 (that is a rules decision, and the pool belongs to the install);
 *   * the TIER is derived from the record, never written in the manifest, so it cannot disagree with it — a mismatch
 *     would silently disable the operator, because shared/support.js `isSupportChess` requires an id to sit under the
 *     tier its record declares.
 *
 * @param {Readonly<Record<string, any>>} data merged game data (the tier is read from the MERGED chess record)
 * @param {Array<{ id: string, support?: string[], files?: Record<string, Record<string, object>> }>} packs
 * @returns {{ entries: Array<{ pack: string, id: string, tier: number }>, errors: Array<{ pack: string, id: string, code: string, reason: string }> }}
 */
export function workshopSupportEntries(data, packs) {
  const entries = [];
  const errors = [];
  const chess = isPlainObj(data) && isPlainObj(data.chess) ? data.chess : {};
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId)) {
    const own = isPlainObj(pack.files) && isPlainObj(pack.files.chess) ? pack.files.chess : {};
    for (const id of Array.isArray(pack.support) ? pack.support : []) {
      if (!Object.hasOwn(own, id)) {
        errors.push({
          pack: pack.id, id, code: 'SUPPORT_FOREIGN_OPERATOR',
          reason: `"${id}" is not an operator this pack adds — only a pack's OWN operators may enter the 助战 pool`,
        });
        continue;
      }
      const rec = isPlainObj(chess[id]) ? chess[id] : own[id];
      const tier = rec ? rec.tier : null;
      if (!isSupportTier(tier)) {
        errors.push({
          pack: pack.id, id, code: 'SUPPORT_TIER_UNKNOWN',
          reason: `"${id}" has no integer tier 1–6 (got ${JSON.stringify(tier)}), so it can never be a 助战`,
        });
        continue;
      }
      entries.push({ pack: pack.id, id, tier });
    }
  }
  return { entries, errors };
}

/**
 * Publish the 助战 pool entries the packs ask for into `data/support.json` (docs/WORKSHOP.md §2) — this is what makes a
 * distributed pack SELF-CONTAINED: without it, a player who installs a pack that adds a 助战 operator would also have to
 * hand-edit `data/support.json` before the operator could be picked.
 *
 * The installer keeps the last word: `"workshop": false` in `data/support.json` turns every pack contribution off.
 */
function mergeWorkshopSupport(data, packs, report) {
  const { entries, errors } = workshopSupportEntries(data, packs);
  for (const e of errors) report.errors.push({ pack: e.pack, file: 'support', id: e.id, code: e.code, reason: e.reason });
  if (!entries.length) return;
  const support = isPlainObj(data.support) ? data.support : null;
  if (!support) {
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.pack)) continue;
      seen.add(e.pack);
      report.errors.push({
        pack: e.pack, file: 'support', id: e.id, code: 'MANIFEST_MISSING',
        reason: 'this pack declares 助战 operators, but data/support.json is missing — 助战 is off for this install',
      });
    }
    return;
  }
  if (support.workshop === false) { report.supportOff = true; return; }
  const pool = { ...(isPlainObj(support.pool) ? support.pool : {}) };
  /** @type {Record<string, string[]>} */
  const added = {};
  for (const { pack, id, tier } of entries) {
    const key = String(tier);
    const list = Array.isArray(pool[key]) ? pool[key].slice() : [];
    if (!list.includes(id)) list.push(id);
    list.sort();
    pool[key] = list;
    (added[pack] ||= []).push(id);
  }
  data.support = { ...support, pool };
  report.support = added;
}

/**
 * 内容文件的记录**落在哪个容器**里 —— 只对本仓库的**真实数据布局**与文件名不一致的那一个文件开口子。
 *
 * `units.json` 是唯一一个：「新增一个干员的干员记录」在 `data/` 里**没有顶层 `units.json`**，那条记录住在
 * `data/backups.json` 的 `units[charId]`（`server/sim/simdata.js:541`、`shared/standIn.js:36`、客户端
 * `data.get('backups').units` 都只读这一个位置）。所以 `content: ["units"]` 的 `units.json` 会被并进
 * `data.backups.units` —— 这也正是合同 §1.1 写的那句「落盘：`applyWorkshop` 里写进 `data.backups.units[id]`」。
 *
 * 其它文件一律同名：`chess.json` → `data.chess`，`items.json` → `data.items`，依此类推（不在这里出现）。
 */
const OVERLAY_TARGET_BY_FILE = Object.freeze({ units: ['backups', 'units'] });

/**
 * 把一组记录并进 `out` 上由 `OVERLAY_TARGET_BY_FILE` 指定的那一层。
 *
 * 非嵌套的文件（绝大多数）：就是 `out[file]` 的一份浅复制，写完挂回去。
 * 嵌套的文件（今天的 `units` → `backups.units`）：路径上的每一层各浅复制一次，**只复制这条路径**，
 * 所以 `backups` 的同层兄弟（`diy` / `tokens`）原样留着，`data/*.json` 也一个字节都不动。
 *
 * @param {Record<string, any>} out 合并中的顶层数据
 * @param {Record<string, any>} base 加载出来的官方数据（`overrides` 的「官方那条」从这里取）
 * @param {string} file 内容文件基名
 * @param {Record<string, object>} records 归一化过的记录
 * @param {(id: string, rec: object, prior: Record<string, object>) => 'added'|'overridden'} mergeOne
 *   把一条记录并进 `prior`（调用方负责判定与报错）；返回它是新增还是覆盖。
 * @returns {Record<string, number>} `{ added, overridden }`
 */
function overlayContentFile(out, base, file, records, mergeOne) {
  const path = OVERLAY_TARGET_BY_FILE[file] || [file];
  /** @type {Array<{ owner: Record<string, any>, key: string, value: Record<string, any> }>} */
  const chain = [];
  let cur = out;
  for (const seg of path.slice(0, -1)) {
    const inner = isPlainObj(cur[seg]) ? { ...cur[seg] } : {};
    chain.push({ owner: cur, key: seg, value: inner });
    cur = inner;
  }
  const leaf = path[path.length - 1];
  const prior = isPlainObj(cur[leaf]) ? cur[leaf] : {};
  const merged = { ...prior };
  let added = 0;
  let overridden = 0;
  for (const [id, rec] of Object.entries(records || {})) {
    const outcome = mergeOne(id, rec, prior);
    if (!outcome) continue;
    merged[id] = outcome.record;
    if (outcome.existed) overridden++; else added++;
  }
  cur[leaf] = merged;
  for (let i = chain.length - 1; i >= 0; i--) chain[i].owner[chain[i].key] = chain[i].value;
  return { added, overridden };
}

/** `base` 上这条记录所在的容器（`overrides` 的「官方那条」要按落盘位置取，不是按内容文件名取）。 */
function baseContainerFor(base, file) {
  const path = OVERLAY_TARGET_BY_FILE[file] || [file];
  let cur = isPlainObj(base) ? base : null;
  for (const seg of path) {
    if (!cur || !isPlainObj(cur[seg])) return null;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Apply every pack's content on top of the official data and return a NEW top-level object (the input is never
 * mutated; the caller freezes the result). Official ids are only replaced when the pack declared them in `overrides`;
 * a collision that was not declared is a reported error and the record already in place is kept.
 *
 * The record already in place is not always an OFFICIAL one: packs are merged in `byPackId` order (DESIGN §28.3 — the
 * order is the rule, not the caller's array order), so a later pack claiming an earlier pack's new id collides with
 * that pack. Such an error says which pack holds the id (`definedBy`, and in the text); it used to say "already exists
 * in the official data" for both cases, which sent the author looking for a record that is not in `data/`.
 *
 * @param {Readonly<Record<string, any>>} base the loaded official data (server/data.js)
 * @param {Array<{ id: string, name?: string, overrides?: string[], files: Record<string, Record<string, object>> }>} packs
 * @returns {{ data: Record<string, any>, report: { packs: object[], added: Record<string, string[]>, overridden: Record<string, string[]>, errors: Array<{ pack: string, file: string, id: string, code: string, definedBy?: string, reason: string }> } }}
 */
export function applyWorkshop(base, packs) {
  const out = { ...(isPlainObj(base) ? base : {}) };
  const report = { packs: [], added: {}, overridden: {}, errors: [] };
  const push = (bag, file, id) => { (bag[file] ||= []).push(id); };
  /** 工坊新增/覆盖的每一条干员记录（供 `chessLookIssues` 事后判断它有没有模型）。 */
  const looked = [];
  /** 同上，怪物记录（`enemies`）：包自带怪物模型这条路本来没有任何启动保护，见 `enemyLookIssues`。 */
  const lookedEnemies = [];

  /** `"<file>:<id>"` → the pack id that put that record into `out` (a pack-vs-pack collision is attributed with it). */
  const contributors = new Map();

  // THE ordering rule (DESIGN §28.3): the smaller pack id wins every collision, so the merge never depends on the
  // order the caller happened to hand the packs over in. Sorting a copy keeps the caller's array untouched.
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p === 'object' && p.id).sort(byPackId)) {
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    const entry = { id: pack.id, name: pack.name || pack.id, files: {} };
    for (const [file, records] of Object.entries(pack.files || {})) {
      // 落盘位置由 `overlayContentFile` 决定（`units` 并进 `data.backups.units`，其余文件就是 `out[file]`）。
      // `priorMap` 是 **官方数据 + 这个包之前已经并进去的每一个包**（变量曾经叫 `official`，把它当成「只有官方」
      // 正是那条把作者引到 `data/` 去找一条其实属于另一个包的记录的错误文案）。
      const { added, overridden } = overlayContentFile(out, base, file, records, (id, rec, priorMap) => {
        const key = `${file}:${id}`;
        const exists = Object.hasOwn(priorMap, id);
        const holder = contributors.get(key);
        // The owner's refinement (2026-10-09, DESIGN §28.3): when another PACK already contributed this record, pack id
        // order decides the winner — the later pack loses even if it declared `"<file>:<id>"` in `overrides`, because a
        // declaration is the authorisation to replace OFFICIAL data, not a licence to overwrite another pack. Two packs
        // adding the same NEW id is the same rule seen from the other side: the id is refused and the holder is named.
        if (holder) {
          report.errors.push({
            pack: pack.id, file, id, code: 'PACK_ID_COLLISION', definedBy: holder,
            reason: `"${id}" is already contributed by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3). Rename this record, or let "${holder}" drop it; an "overrides" entry does not win against another pack`,
          });
          return null;
        }
        if (exists && !declared.has(key)) {
          report.errors.push({
            pack: pack.id, file, id, code: 'OFFICIAL_ID_COLLISION', definedBy: 'official',
            reason: `"${id}" already exists in the official data — add "${file}:${id}" to pack.json overrides to replace it`,
          });
          return null;
        }
        // A declared override is a FIELD-LEVEL patch, not a replacement (DESIGN §28.3): writing one number must keep
        // every other field of the record it overrides. And it may only speak about fields that exist ("closed world").
        if (exists) {
          const official = baseContainerFor(base, file)?.[id] ?? priorMap[id];
          const unknown = unknownOverrideKeys(official, rec);
          if (unknown && unknown.length) {
            report.errors.push({
              pack: pack.id, file, id, code: 'UNKNOWN_OVERRIDE_FIELD', definedBy: 'official',
              reason: `the override of "${id}" names ${unknown.map((k) => `"${k}"`).join(', ')}, which the record does not have — an override may only change fields that exist (add the record under a new id to invent one)`,
            });
            return null;
          }
        }
        contributors.set(key, pack.id);
        if (file === 'chess') looked.push({ pack: pack.id, id, rec });
        if (file === 'enemies') lookedEnemies.push({ pack: pack.id, id, rec });
        if (exists) push(report.overridden, file, id); else push(report.added, file, id);
        return { record: exists ? mergeRecord(priorMap[id], rec) : rec, existed: exists };
      });
      entry.files[file] = { added, overridden };
    }
    report.packs.push(entry);
  }
  linkWorkshopStages(out, report);
  mergeWorkshopVoices(out, packs, report);
  mergeWorkshopBondIcons(out, packs, report);
  mergeWorkshopItemIcons(out, packs, report);
  // 必须在 chessLookIssues 之前：那条检查读的是**合并后**的 assets.chars，包自带模型到位之后
  // 「这个干员没有模型（会画成贴纸）」的警告就该消失（反过来放在后面，日志会一直报一条已经解决的问题）。
  mergeWorkshopArt(out, packs, report);
  // 扁平的那两张图标表（`assets.skills` / `assets.prof.sub`）—— 与上一条同一个理由放在 looks 之前，
  // 而且必须在 mergeWorkshopOperators 之前：干员进池时读的 `units` 记录已经由内容文件那一层并好了，
  // 但它的**分支图标**要靠这一条（`prof.sub[subProfessionId]`），顺序反了自选界面就是一个没有分支图的格子。
  mergeWorkshopFlatArt(out, packs, report);
  mergeWorkshopSupport(out, packs, report);
  // 自选池（`diy.ownedPool` / `diy.operators`）：读 `data.backups.units` 里那条已经合并好的记录，
  // 所以必须排在内容文件那一层之后 —— 它在这个函数里是最末一批，天然满足。
  mergeWorkshopOperators(out, packs, report);
  // 试玩开关（`pack.json.playtest`）不并进任何数据文件 —— 它是**行为层**的声明，引擎只在试玩服务器里读它
  // （`SP_PLAYTEST=1`）。但两个包撞同一个 id 这件事必须与其它面一样被点名报告，否则输的一方会在
  // 「我明明勾了」和「试玩里没有」之间反复，而日志一句话都不说。
  for (const e of workshopPlaytestIndex(packs).errors) report.errors.push({ pack: e.pack, file: 'playtest', id: e.id, code: e.code, definedBy: e.definedBy, reason: e.reason });
  report.looks = [...chessLookIssues(out, looked), ...enemyLookIssues(out, lookedEnemies)];
  // `stripPackOperators`（fanpack G-16）：**只记录，不摘除**。一个被包变成棋子的干员同时还在自选池里这件事，
  // 以前没有任何地方说出来；而「真的把他摘出池」会改变自选槽能挑到的干员（= 改对局结果），
  // 与「`test/golden/*.json` 一个字节不动」的验收不能同时成立 —— 所以它是一条**待裁决**的记录，
  // 不是一次静默的行为差异（理由与实测数字见 `stripPackOperators` 的注释）。
  report.overlaps = stripPackOperators(packs, out).overlaps;
  for (const list of Object.values(report.added)) list.sort();
  for (const list of Object.values(report.overridden)) list.sort();
  return { data: out, report };
}

/**
 * 工坊干员的**外观能不能真的渲染成模型**：`assets.spine`（或 `charId`）必须是本机素材清单 `assets.chars` 里的键。
 *
 * 为什么单独查这一条：查不到时游戏**不会报错** —— `assets.spineEntry()` 返回 null，单位就画成一张头像菱形贴图，
 * 于是作者只会觉得「模型没加载出来」。这个仓库不携带干员美术，但**包可以自带**（`pack.json.art.chars` 里的
 * `spine`，0.8.0 起）：所以这条检查读的是**合并后**的 `assets.chars` —— 包把自己的模型接上去之后，警告自然消失
 * （applyWorkshop 里必须在写 `report.looks` 之前先合并 art，否则日志会一直报一条已经解决的问题）。
 * 没带模型时，「复用已装好的 spine id」仍是唯一的路；手写包与编辑器写出来的包在这一层同样能被发现。
 *
 * 只查干员、不查怪物：怪物那条在 `enemyLookIssues`（同一个 `report.looks`，条目上带 `kind: 'enemy'`）。
 *
 * 没有清单（素材流程没跑）时不判断：宁可不说，也不要乱说。
 *
 * @param {Readonly<Record<string, any>>} data 合并后的数据
 * @param {Array<{ pack: string, id: string, rec: object }>} looked 工坊贡献的干员记录
 * @returns {Array<{ pack: string, id: string, spine: string|null, code: string, reason: string }>}
 */
function chessLookIssues(data, looked) {
  const chars = isPlainObj(data.assets) && isPlainObj(data.assets.chars) ? data.assets.chars : null;
  if (!chars || !Object.keys(chars).length) return [];
  const out = [];
  for (const { pack, id, rec } of looked) {
    const spine = isPlainObj(rec) && isPlainObj(rec.assets) && typeof rec.assets.spine === 'string' ? rec.assets.spine
      : (isPlainObj(rec) && typeof rec.charId === 'string' ? rec.charId : null);
    if (spine && Object.hasOwn(chars, spine)) continue;
    out.push({
      pack, id, spine, code: spine ? 'MODEL_UNKNOWN' : 'MODEL_MISSING',
      reason: spine
        ? `${id}: assets.spine "${spine}" is not in this install's model list (data/assets.json chars) — it renders as a flat portrait, not a model`
        : `${id}: no assets.spine — it renders as a flat portrait, not a model. Reuse an installed spine id (an existing operator's) instead`,
    });
  }
  return out;
}

/**
 * 包自带的**怪物**模型有没有着落 —— `chessLookIssues` 的怪物版（同一条 `report.looks`，条目带 `kind: 'enemy'`）。
 *
 * 为什么要有它：干员那条检查只由 `chess` 记录填（`looked`），而怪物走 `enemies.json` —— 包新增的怪物如果把 `spine`
 * 写成一个本机没有的模型 id，客户端**同样一条日志都不打**：`assets.spineEntry()` 返回 null，那只怪物画成一张图标
 * 贴图。判定链与客户端逐字一致（`server/sim/simdata.js` 取 `rec.spine ?? key`；`public/js/assets.js spineEntry` 读
 * `enemies[key].spine`，条目里的 `spineAliasOf` 指向另一个模型），所以别名链要跟着走（官方有 8 个敌人是这样）。
 *
 * `assets.json` 里没有 `enemies` 表（没跑过素材管线）时不判断：宁可不说，也不要乱说。
 * @param {Readonly<Record<string, any>>} data 合并后的数据
 * @param {Array<{ pack: string, id: string, rec: object }>} looked 工坊贡献的怪物记录
 * @returns {Array<{ pack: string, id: string, spine: string, kind: string, code: string, reason: string }>}
 */
function enemyLookIssues(data, looked) {
  if (!looked.length) return [];
  const enemies = isPlainObj(data.assets) && isPlainObj(data.assets.enemies) ? data.assets.enemies : null;
  if (!enemies || !Object.keys(enemies).length) return [];
  const out = [];
  for (const { pack, id, rec } of looked) {
    const want = isPlainObj(rec) && typeof rec.spine === 'string' && rec.spine ? rec.spine : id;
    let cur = want;
    let ok = false;
    // 跟着 spineAliasOf 走：别名链是有向的、官方数据里不会成环，但这里仍然限深，坏数据不能把启动卡住
    for (let hop = 0; hop < 8 && cur; hop++) {
      const entry = enemies[cur];
      if (!isPlainObj(entry)) break;
      if (isPlainObj(entry.spine)) { ok = true; break; }
      cur = typeof entry.spineAliasOf === 'string' && entry.spineAliasOf ? entry.spineAliasOf : '';
    }
    if (ok) continue;
    const known = Object.hasOwn(enemies, want);
    out.push({
      pack, id, spine: want, kind: 'enemy', code: known ? 'MODEL_MISSING' : 'MODEL_UNKNOWN',
      reason: known
        ? `${id}: assets.enemies "${want}" carries no model of its own (no spine, and no spineAliasOf to borrow one) — it renders as a flat icon, not a model`
        : `${id}: assets.spine "${want}" is not in this install's model list (data/assets.json enemies) — it renders as a flat icon, not a model`,
    });
  }
  return out;
}

/**
 * Publish every pack's voice lines to the client by extending `assets.audio.voice` — the manifest the client looks an
 * operator's line up in (public/js/audio.js `voice()`), which the HTTP layer then serves merged
 * (server/index.js `buildWorkshopDataFiles` + `workshopTouchedFiles`).
 *
 * APPEND, never replace: a pack that adds lines to an operator the official data already has keeps both, and
 * `pickVoiceLine` picks among them. The DEFAULT dub's lines go into `audio.voice`; a pack's other dubs
 * (`pack.json.voiceLangs`, v0.7.3) go into `audio.voiceLangs[lang]` — the same two tables the player's 配音语言
 * setting chooses between (public/js/audio.js voiceLinesFor), so a pack line is heard exactly when the player picks
 * that dub, and a dub no pack touches is left byte-identical. Mutates `data` (a fresh copy) and records the counts in
 * `report.voices` / `report.voiceLangs`.
 *
 * An install without `data/assets.json` (the asset pipeline was never run) has no audio at all, so there is nowhere to
 * publish to: that is reported rather than silently dropped.
 */

/** Append every line of ONE index into a `<charId> → <slot> → [url]>` table; the input table is not mutated. */
function appendVoiceLines(table, index) {
  const out = { ...table };
  for (const [charId, slots] of Object.entries(index)) {
    const lines = isPlainObj(out[charId]) ? { ...out[charId] } : {};
    for (const [slot, urls] of Object.entries(slots)) {
      // The official manifest writes a slot with ONE line as a bare string and several as an array (0.2.0's
      // tools/assets/audio.mjs); the client accepts both. Normalize before appending, or a pack line would silently
      // REPLACE that single official line instead of joining it.
      const cur = lines[slot];
      const official = Array.isArray(cur) ? cur : (typeof cur === 'string' && cur ? [cur] : []);
      lines[slot] = [...new Set([...official, ...urls])];
    }
    out[charId] = lines;
  }
  return out;
}

/** Files one `<charId> → <slot> → [paths]>` table declares (the boot log counts, not a validation). */
function countVoiceLines(table) {
  let n = 0;
  if (!isPlainObj(table)) return 0;
  for (const slots of Object.values(table)) {
    if (!isPlainObj(slots)) continue;
    for (const files of Object.values(slots)) if (Array.isArray(files)) n += files.length;
  }
  return n;
}

/** Does this pack declare voice lines at all — in either table? */
const packDeclaresVoices = (pack) =>
  (isPlainObj(pack?.voices) && Object.keys(pack.voices).length > 0)
  || (isPlainObj(pack?.voiceLangs) && Object.keys(pack.voiceLangs).length > 0);

function mergeWorkshopVoices(data, packs, report) {
  const index = workshopVoiceIndex(packs);
  const langIndex = workshopVoiceLangIndex(packs);
  const langs = Object.keys(langIndex);
  if (!Object.keys(index).length && !langs.length) return;
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of Array.isArray(packs) ? packs : []) {
      if (!packDeclaresVoices(pack)) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'audio.voice', code: 'MANIFEST_MISSING',
        reason: 'this pack declares voice lines, but data/assets.json is missing — run `npm run assets` so the client has an audio manifest to extend',
      });
    }
    return;
  }
  const audio = isPlainObj(assets.audio) ? { ...assets.audio } : {};
  const voice = appendVoiceLines(isPlainObj(audio.voice) ? audio.voice : {}, index);
  /** @type {Record<string, number>} */
  const counts = {};
  // 按包 id 排序后再数：这两个 map 会随合并后的 manifest 一起发给客户端，键序不能随加载顺序变（DESIGN §28.3）
  for (const pack of (Array.isArray(packs) ? packs : []).slice().sort(byPackId)) {
    const n = countVoiceLines(pack?.voices);
    if (n) counts[pack.id] = n;
  }
  // `undefined` while no pack declares another dub: a manifest that had no `voiceLangs` must not gain an empty one.
  /** @type {Record<string, Record<string, Record<string, string[]>>>|undefined} */
  let voiceLangs;
  /** @type {Record<string, Record<string, number>>|undefined} */
  let langCounts;
  if (langs.length) {
    const base = isPlainObj(audio.voiceLangs) ? audio.voiceLangs : {};
    voiceLangs = { ...base };
    for (const [lang, idx] of Object.entries(langIndex)) {
      voiceLangs[lang] = appendVoiceLines(isPlainObj(base[lang]) ? base[lang] : {}, idx);
      for (const pack of (Array.isArray(packs) ? packs : []).slice().sort(byPackId)) {
        const n = countVoiceLines(isPlainObj(pack?.voiceLangs) && isPlainObj(pack.voiceLangs[lang]) ? pack.voiceLangs[lang] : null);
        if (n) ((langCounts ||= {})[pack.id] ||= {})[lang] = n;
      }
    }
  }
  data.assets = { ...assets, audio: { ...audio, voice, ...(voiceLangs ? { voiceLangs } : {}) } };
  report.voices = counts;
  if (langCounts) report.voiceLangs = langCounts;
}

/**
 * 包自带盟约图标的 URL 表：`{ <bondId>: '/workshop-assets/<pack>/<path>' }`。
 * 与 `workshopVoiceIndex` 同一套：URL 指向 /workshop-assets 那条唯一的包素材路由，客户端不需要任何新通道。
 * 同一个 bondId 被两个包声明时**第一个赢**，并记一条错误 —— 两个包抢同一个盟约的图标是作者要自己解决的事，
 * 静默让后加载的那个覆盖掉，会变成「换个包顺序图标就变了」这种没人能查的问题。
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 */
export function workshopBondIconIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  // 按包 id 排序再处理（与 workshopVoiceIndex 同一条规则）：谁赢只取决于包 id，不取决于加载顺序。
  for (const pack of [...(Array.isArray(packs) ? packs : [])].sort(byPackId)) {
    const icons = isPlainObj(pack?.bondIcons) ? pack.bondIcons : null;
    if (!icons) continue;
    for (const [bondId, file] of Object.entries(icons)) {
      if (Object.hasOwn(out, bondId)) continue;
      // 逐段百分号编码：文件名里的 `#` / 空格 / 中文在 URL 里必须编码，否则 `#` 会把 URL 从此截断
      const path = String(file).split('/').map(encodeURIComponent).join('/');
      out[bondId] = `${prefix}${pack.id}/${path}`;
    }
  }
  return out;
}

/**
 * Publish every pack's 盟约图标 by extending `assets.bonds` — the map the client resolves a bond's icon in
 * (`public/js/assets.js bondIconUrl`), served merged like every other workshop overlay.
 *
 * REPLACE for a bond the official data already has (that is how a pack gives its **override** of an official bond a
 * custom icon), APPEND for a new one. Mutates `data` (a fresh copy) and records the ids in `report.bondIcons`.
 */
function mergeWorkshopBondIcons(data, packs, report) {
  const index = workshopBondIconIndex(packs);
  const ids = Object.keys(index);
  if (!ids.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  // 谁跟谁抢了同一个 id：按包 id 排序后第一个赢，后面的写进 report.errors（不阻断，但作者必须知道）
  const claimed = new Map();
  for (const pack of list) {
    for (const bondId of Object.keys(isPlainObj(pack?.bondIcons) ? pack.bondIcons : {})) {
      if (claimed.has(bondId)) {
        report.errors.push({
          pack: pack.id, file: 'assets', id: `bonds.${bondId}`, code: 'ASSET_COLLISION',
          definedBy: claimed.get(bondId),
          reason: `another pack (${claimed.get(bondId)}) already ships an icon for this bond; keep only one`,
        });
      } else claimed.set(bondId, pack.id);
    }
  }
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of list) {
      if (!isPlainObj(pack?.bondIcons) || !Object.keys(pack.bondIcons).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'bonds', code: 'MANIFEST_MISSING',
        reason: 'this pack ships a bond icon, but data/assets.json is missing — run `npm run assets` so the client has a manifest to extend',
      });
    }
    return;
  }
  const bonds = isPlainObj(assets.bonds) ? { ...assets.bonds } : {};
  for (const id of ids) bonds[id] = index[id];
  data.assets = { ...assets, bonds };
  /** @type {Record<string, string[]>} */
  const counts = {};
  for (const [bondId, packId] of claimed) (counts[packId] ??= []).push(bondId);
  for (const list of Object.values(counts)) list.sort();
  report.bondIcons = counts;
}

/**
 * 包自带装备图标的 URL 表：`{ <iconId>: '/workshop-assets/<pack>/<path>' }`。
 * 与 `workshopBondIconIndex` / `workshopVoiceIndex` 同一套：URL 指向 /workshop-assets 那条唯一的包素材路由，
 * 客户端不需要任何新通道 —— public/js/assets.js itemIconUrl 本来就在读 `assets.items`。
 * 同一个 id 被两个包声明时**第一个赢**，并记一条错误（理由与盟约图标相同：静默让后加载的那个覆盖掉，会变成
 * 「换个包顺序图标就变了」这种没人能查的问题）。
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 */
export function workshopItemIconIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  // 按包 id 排序再处理（与 workshopBondIconIndex 同一条规则）：谁赢只取决于包 id，不取决于加载顺序。
  for (const pack of [...(Array.isArray(packs) ? packs : [])].sort(byPackId)) {
    const icons = isPlainObj(pack?.itemIcons) ? pack.itemIcons : null;
    if (!icons) continue;
    for (const [itemId, file] of Object.entries(icons)) {
      if (Object.hasOwn(out, itemId)) continue;
      // 逐段百分号编码：文件名里的 `#` / 空格 / 中文在 URL 里必须编码，否则 `#` 会把 URL 从此截断
      const path = String(file).split('/').map(encodeURIComponent).join('/');
      out[itemId] = `${prefix}${pack.id}/${path}`;
    }
  }
  return out;
}

/**
 * Publish every pack's 装备图标 by extending `assets.items` — the map the client resolves an item icon in
 * (`public/js/assets.js itemIconUrl`, which reads `item.iconId` / `item.trapId` and then looks the id up in it),
 * served merged like every other workshop overlay. **No client change**: that lookup already existed.
 *
 * REPLACE for an id the official data already has (that is how a pack gives an official equip a picture of its own),
 * APPEND for a new one. Mutates `data` (a fresh copy) and records the ids in `report.itemIcons`.
 *
 * `assets.items` that does NOT exist is left alone (the same rule as `voiceLangs`): the pack's icons are reported
 * instead, because a manifest the asset pipeline never produced is not something this overlay should invent.
 */
function mergeWorkshopItemIcons(data, packs, report) {
  const index = workshopItemIconIndex(packs);
  const ids = Object.keys(index);
  if (!ids.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  // 谁跟谁抢了同一个 id：按包 id 排序后第一个赢，后面的写进 report.errors（不阻断，但作者必须知道）
  const claimed = new Map();
  for (const pack of list) {
    for (const itemId of Object.keys(isPlainObj(pack?.itemIcons) ? pack.itemIcons : {})) {
      if (claimed.has(itemId)) {
        report.errors.push({
          pack: pack.id, file: 'assets', id: `items.${itemId}`, code: 'ASSET_COLLISION',
          definedBy: claimed.get(itemId),
          reason: `another pack (${claimed.get(itemId)}) already ships an icon for this item; keep only one`,
        });
      } else claimed.set(itemId, pack.id);
    }
  }
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets || !isPlainObj(assets.items)) {
    for (const pack of list) {
      if (!isPlainObj(pack?.itemIcons) || !Object.keys(pack.itemIcons).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'items', code: 'MANIFEST_MISSING',
        reason: 'this pack ships an item icon, but data/assets.json has no "items" map — run `npm run assets` so the client has an icon table to extend',
      });
    }
    return;
  }
  const items = { ...assets.items };
  for (const id of ids) items[id] = index[id];
  data.assets = { ...assets, items };
  /** @type {Record<string, string[]>} */
  const counts = {};
  for (const [itemId, packId] of claimed) (counts[packId] ??= []).push(itemId);
  for (const list of Object.values(counts)) list.sort();
  report.itemIcons = counts;
}

/**
 * 把包自带的外观素材变成合并后清单里的那几条：`{ <表>: { <id>: <条目，路径已换成 /workshop-assets 的绝对 URL> } }`。
 *
 * 与 `workshopVoiceIndex` / `workshopBondIconIndex` 同一套：URL 指向 /workshop-assets 那条唯一的包素材路由，客户端
 * 不需要任何新通道（`public/js/assets.js validSpine` 只要求 skel 是 `/` 开头的路径，包素材 URL 天然满足）。
 * 同一个 `<表>.<id>` 被两个包声明时**第一个赢**（按包 id 排序），后一个包在启动日志里得到一条错误。
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 */
export function workshopArtIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, Record<string, object>>} */
  const out = {};
  const toUrl = (packId, p) => `${prefix}${packId}/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  // 按包 id 排序再处理：谁赢只取决于包 id，不取决于加载顺序（与既有的三条素材通道同一条规则）
  for (const pack of [...(Array.isArray(packs) ? packs : [])].sort(byPackId)) {
    const art = isPlainObj(pack?.art) ? pack.art : null;
    if (!art) continue;
    for (const [table, entries] of Object.entries(art)) {
      const shape = ART_TABLES[table];
      if (!shape || !isPlainObj(entries)) continue;
      const bucket = (out[table] ||= {});
      for (const [id, entry] of Object.entries(entries)) {
        if (Object.hasOwn(bucket, id)) continue;
        if (shape.flat) {
          // 扁平表：条目本身就是路径，转成 URL 就是终点（没有字段可映射）；校验阶段已经确认它是安全相对路径
          if (typeof entry === 'string' && entry) bucket[id] = toUrl(pack.id, entry);
          continue;
        }
        if (!isPlainObj(entry)) continue;
        bucket[id] = artEntryUrls(entry, shape, (p) => toUrl(pack.id, p));
      }
    }
  }
  return out;
}

/** 一个条目里路径字段换成 URL 之后的副本；`spine` 按表嵌套（chars 的 front/back）或扁平（enemies/tokens）。 */
function artEntryUrls(entry, shape, toUrl) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (shape.urls.includes(key)) out[key] = toUrl(value);
    else if (shape.strings.includes(key)) out[key] = value;
    else if (key === 'spine' && isPlainObj(value)) {
      out.spine = shape.spine === 'flat'
        ? spineUrls(value, toUrl)
        : Object.fromEntries(Object.entries(value).map(([side, s]) => [side, spineUrls(s, toUrl)]));
    }
  }
  return out;
}

/** 一个 spine 对象里的路径字段换成 URL，其余（`anims`/`events`/`pma`…）原样抄。 */
function spineUrls(spine, toUrl) {
  const out = {};
  for (const [key, value] of Object.entries(spine)) {
    if (ART_SPINE_URLS.includes(key)) out[key] = toUrl(value);
    else if (ART_SPINE_LISTS.includes(key)) out[key] = value.map(toUrl);
    else out[key] = value;
  }
  return out;
}

/**
 * 把包自带的外观并进 `assets.chars` / `assets.enemies` / `assets.tokens` —— 客户端画单位与头像时读的那三张表。
 *
 * **字段级合并**，不是整条替换：包只给头像时官方模型照旧；包给 `spine.front` 的 `skel`/`atlas` 时，官方那一侧的
 * `anims`/`events` 等字段留着（整侧替换会让一个官方模型变成「能出来但不动」，而且一条日志都没有）。官方没有这个
 * id 时就是新增。`assets.json` 本身不存在（没跑过素材管线）时报告出来，不凭空造一份。
 */
function mergeWorkshopArt(data, packs, report) {
  const index = workshopArtIndex(packs);
  // 扁平表（skills / profSub）不住在 `assets.<表>` 下，它们的家是 `assets.skills` / `assets.prof.sub`，所以拿掉
  const tables = Object.keys(index).filter((t) => !ART_TABLES[t]?.flat);
  if (!tables.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  // 谁跟谁抢了同一个 <表>.<id>：按包 id 排序后第一个赢，后面的写进 report.errors
  const claimed = artClaims(list, (t) => !ART_TABLES[t]?.flat, report);
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of list) {
      if (!isPlainObj(pack?.art) || !Object.keys(pack.art).filter((t) => !ART_TABLES[t]?.flat).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'art', code: 'MANIFEST_MISSING',
        reason: 'this pack ships art (avatars / portraits / spine models), but data/assets.json is missing — run `npm run assets` so the client has a manifest to extend',
      });
    }
    return;
  }
  const next = { ...assets };
  for (const table of tables) {
    const entries = isPlainObj(next[table]) ? { ...next[table] } : {};
    for (const [id, patch] of Object.entries(index[table])) {
      entries[id] = mergeArtEntry(isPlainObj(entries[id]) ? entries[id] : {}, patch);
    }
    next[table] = entries;
  }
  data.assets = next;
  report.art = artClaimCounts(claimed, (t) => !ART_TABLES[t]?.flat);
}

/**
 * 谁跟谁抢了同一张 art 表里的同一个 id：按包 id 排序后第一个赢（`claimArt`），输的一方**点名**记一条
 * `ASSET_COLLISION`（`definedBy` = 占住的那一方）。
 *
 * 两张 art 面（对象表与扁平表）共用它：规则只有一份，输出两张面孔 —— 谁赢这件事不该因为「这张表的条目是对象还是
 * 字符串」而不同。
 * @param {Array<object>} list 已按包 id 排好序的包
 * @param {(table: string) => boolean} include 这次要处理哪些表
 * @param {{ errors: object[] }} report 错误去处
 * @returns {Map<string, string>} `"<表>.<id>"` → 占住它的包 id
 */
function artClaims(list, include, report) {
  /** @type {Map<string, string>} */
  const claimed = new Map();
  for (const pack of list) {
    for (const [table, entries] of Object.entries(isPlainObj(pack?.art) ? pack.art : {})) {
      if (!ART_TABLES[table] || !include(table)) continue;
      // 扁平表的条目**是路径字符串**，`isPlainObj` 会为假 —— 用 `entries` 存在与否判断，不是「它是不是对象」
      for (const id of Object.keys(isPlainObj(entries) ? entries : {})) {
        const key = `${table}.${id}`;
        if (claimed.has(key)) {
          report.errors.push({
            pack: pack.id, file: 'assets', id: key, code: 'ASSET_COLLISION',
            definedBy: claimed.get(key),
            reason: `another pack (${claimed.get(key)}) already ships art for this entry; keep only one`,
          });
        } else claimed.set(key, pack.id);
      }
    }
  }
  return claimed;
}

/** `artClaims` 的结果按包归拢、每张表内按 key 排序（`report.art` / `report.flatArt` 的形状）。 */
function artClaimCounts(claimed, include) {
  /** @type {Record<string, string[]>} */
  const counts = {};
  for (const [key, packId] of claimed) {
    const table = key.slice(0, key.indexOf('.'));
    if (!include(table)) continue;
    (counts[packId] ??= []).push(key);
  }
  for (const arr of Object.values(counts)) arr.sort();
  return counts;
}

/**
 * 把包自带的**两张扁平图标表**并进 `assets.skills` / `assets.prof.sub`（`pack.json.art.skills` /
 * `pack.json.art.profSub`）—— 客户端画技能图标与分支图标时读的那两张表。
 *
 * 为什么单独一条通道：这两张表的值**直接就是路径字符串**（`data/assets.json` 实测：`skills["skchr_kalts_1"]`
 * 与 `prof.sub["fastshot"]`），不像 `chars` 那样是一个带 `urls` 字段的对象，所以它可以复用 `mergeWorkshopArt`
 * 的一切（路径安全规则、`/workshop-assets` 路由、包 id 排序、点名撞车），只有「写进哪一层」不同 —— 那一层由
 * `ART_TABLES[表].target` 给出（`['skills']` / `['prof','sub']`）。
 *
 * 官方已有这个 id 时**替换**（这就是一个包给官方技能换图标的方式）；`assets.json` 缺失时报告，不凭空造一份。
 */
function mergeWorkshopFlatArt(data, packs, report) {
  const index = workshopArtIndex(packs);
  const tables = Object.keys(index).filter((t) => ART_TABLES[t]?.flat);
  if (!tables.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  const claimed = artClaims(list, (t) => ART_TABLES[t]?.flat, report);
  if (!isPlainObj(data.assets)) {
    for (const pack of list) {
      if (!Object.keys(isPlainObj(pack?.art) ? pack.art : {}).some((t) => ART_TABLES[t]?.flat)) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'art', code: 'MANIFEST_MISSING',
        reason: 'this pack ships skill / sub-profession icons, but data/assets.json is missing — run `npm run assets` so the client has an icon table to extend',
      });
    }
    return;
  }
  const next = { ...data.assets };
  for (const table of tables) {
    // `target` 就是那张表在 `assets.json` 里的路径：`['skills']` 或 `['prof','sub']`。**逐个**段浅复制
    // （长度 1 时落点就是 `assets.skills` 这个表本身 —— 要往表里写，不是把整张表换成一条路径）。
    const chain = [];
    let cur = /** @type {Record<string, any>} */ (next);
    for (const seg of ART_TABLES[table].target) {
      const inner = isPlainObj(cur[seg]) ? { ...cur[seg] } : {};
      chain.push({ owner: cur, key: seg, value: inner });
      cur = inner;
    }
    for (const [id, url] of Object.entries(index[table])) cur[id] = url;
    for (let i = chain.length - 1; i >= 0; i--) chain[i].owner[chain[i].key] = chain[i].value;
  }
  data.assets = next;
  report.flatArt = artClaimCounts(claimed, (t) => ART_TABLES[t]?.flat);
}

/** 一个条目按字段合并；`spine` 再往里一层（一侧之内的字段逐项合并，见 mergeWorkshopArt 的注释）。 */
function mergeArtEntry(cur, patch) {
  const out = { ...cur };
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'spine' || !isPlainObj(value)) { out[key] = value; continue; }
    const spine = isPlainObj(cur.spine) ? { ...cur.spine } : {};
    for (const [k, v] of Object.entries(value)) {
      spine[k] = isPlainObj(v) && isPlainObj(spine[k]) ? { ...spine[k], ...v } : v;
    }
    out.spine = spine;
  }
  return out;
}

/**
 * 一个包声明要进**自选池**的干员，逐条判定它能不能进（`pack.json.operators`，docs/WORKSHOP.md §1.2）。
 *
 * 与 `workshopSupportEntries` 同一种结构、同一种理由（**规则只有一份**，加载期与校验器/编辑器读的是同一个函数）：
 * 每一条声明要么给出它落盘时要写的数据，要么给出一条**点名**的拒绝。四条规则：
 *
 *   * `OPERATOR_NO_UNIT` —— 这个包没有同名的 `units[charId]` 记录。没有干员记录的干员进池后是**空槽**：
 *     自选界面画不出名字与职业，一局里也取不到 def。这是唯一一条「写成什么样都不该放过」的错。
 *   * `OPERATOR_NOT_SIX` —— `rarity !== 6`。**不是 6★ 请走工坊棋子注册表**（`content.chess` + `kits/<chessId>.js`）：
 *     自选池这一层是「六星干员的获得方式」，5★ 与以下在这条路上没有商店阶级可落。
 *   * `OPERATOR_BOND_UNKNOWN` —— `bonds` 里某个 id 不在 `data/bonds.json`。**这条必须拒**：盟约 id 写错时那条
 *     盟约条**永远不会出现**（`assets.bonds` 里没有它的图标，`bonds` 表里没有它的阈值），而作者只会以为
 *     「盟约没生效」—— 一次完全静默的失效。
 *   * `OPERATOR_FORM_MISSING` —— `forms` 没覆盖自选槽要的档位。自选槽的普通与精锐两条记录**各自**要求一个档位
 *     （`shared/diy.js checkDiyPick` 同时解析两条），缺一个这个干员就挑不上；更重的是 `tools/golden.mjs` 会给池里
 *     每位配一个精锐场景，所以缺档位会让**语料生成抛异常**，`golden` / `ci` 全线挂。要求的那一组从 `diy.slots`
 *     派生（`requiredUnitForms`），不硬编码。
 *   * `PACK_ID_COLLISION` —— 两个包声明同一个 charId。按包 id 字典序最小者赢（DESIGN §28.3），输的一方得到一条
 *     点名报告；`ownedPool` 因此只会多一个 id，不会出现两条记录抢一个槽。
 *
 * `name` / `rarity` / `profession` / `subProfessionId` **从 `data.backups.units[charId]` 派生**（同一个包的
 * `units` 记录已经由内容文件那一层并进 `data` 了），所以清单里写不出第二份会漂移的真相。
 *
 * @param {Readonly<Record<string, any>>} data 合并后的数据（`units` 记录已就位）
 * @param {Array<{ id: string, operators?: Record<string, { powers?: string[], bonds?: string[] }> }>} packs
 * @returns {{ entries: Array<{ pack: string, id: string, rec: object }>, errors: object[] }}
 */
export function workshopOperatorEntries(data, packs) {
  /** @type {Array<{ pack: string, id: string, rec: object }>} */
  const entries = [];
  /** @type {object[]} */
  const errors = [];
  const list = (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId);
  const units = isPlainObj(data) && isPlainObj(data.backups) && isPlainObj(data.backups.units) ? data.backups.units : {};
  const bonds = isPlainObj(data) && isPlainObj(data.bonds) ? data.bonds : {};
  /** charId → 已经声明它的包（`byPackId` 顺序下第一个就是赢家）。 */
  const claimed = new Map();
  for (const pack of list) {
    const declared = isPlainObj(pack.operators) ? pack.operators : {};
    for (const charId of Object.keys(declared).sort()) {
      const decl = isPlainObj(declared[charId]) ? declared[charId] : {};
      const unit = isPlainObj(units[charId]) ? units[charId] : null;
      if (!unit) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_NO_UNIT',
          reason: `"${charId}" has no units record in this pack — declare it in units.json (the 自选池 entry derives its name / rarity / profession from that record)`,
        });
        continue;
      }
      if (unit.rarity !== 6) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_NOT_SIX',
          reason: `"${charId}" is rarity ${JSON.stringify(unit.rarity)}, not 6 — the 自选池 is the 6★ path; a 5★ or lower operator goes through the workshop chess registry instead (content.chess + kits/<chessId>.js)`,
        });
        continue;
      }
      const unknown = (Array.isArray(decl.bonds) ? decl.bonds : []).filter((b) => !isPlainObj(bonds[b]));
      if (unknown.length) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_BOND_UNKNOWN',
          reason: `"${charId}" declares the bond(s) ${unknown.map((b) => `"${b}"`).join(', ')}, which data/bonds.json does not have — that bond would simply never appear in a match (a mistyped id fails silently; check data/bonds.json for the exact id, e.g. "egirShip")`,
        });
        continue;
      }
      // 形态齐不齐：自选槽的两条记录（普通 + 精锐）各自要求一个 forms 档位，缺一个这个干员**根本挑不上**
      // （shared/diy.js checkDiyPick 同时解析两条）。而它的后果不止「挑不上」：`tools/golden.mjs` 会给池里每一位
      // 配一个 tier-6 精锐场景，所以一个缺档位的干员进池 = 语料生成抛异常 = `golden` / `ci` 全线挂（2026-10-09 实测：
      // 只有 `2/1/4/0` 与 `2/60/7/1` 两个档位的干员会让 `chess_char_6_diy1_a` 报 `no form for`）。
      // 要求的那一组**从 `diy.slots` 的两条记录派生**（shared/diy.js requiredUnitForms），不硬编码 `2/60/7/3`。
      const forms = isPlainObj(unit.forms) ? unit.forms : {};
      const missing = requiredUnitForms(data).filter((f) => !isPlainObj(forms[f]));
      if (missing.length) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_FORM_MISSING',
          reason: `"${charId}" has no unit form for ${missing.map((f) => `"${f}"`).join(', ')} — the 自选 slots' normal and elite records both need one (data/backups.json diy.slots => chess status), and a pool member without them cannot be picked: \`node tools/golden.mjs\` throws and the golden / ci suites go down with it. Copy the missing form(s) from the operator record you derived this one from`,
        });
        continue;
      }
      const holder = claimed.get(charId);
      if (holder) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'PACK_ID_COLLISION', definedBy: holder,
          reason: `"${charId}" is already contributed by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3). Rename this record, or let "${holder}" drop it; an "overrides" entry does not win against another pack`,
        });
        continue;
      }
      claimed.set(charId, pack.id);
      entries.push({
        pack: pack.id,
        id: charId,
        rec: {
          name: unit.name,
          rarity: unit.rarity,
          profession: unit.profession,
          subProfessionId: unit.subProfessionId,
          obtainable: true,
          powers: [...(Array.isArray(decl.powers) ? decl.powers : [])],
          bonds: [...(Array.isArray(decl.bonds) ? decl.bonds : [])],
        },
      });
    }
  }
  return { entries, errors };
}

/**
 * 把包声明的新干员**放进自选池**：`data/backups.json` 的 `diy.ownedPool`（push，去重）与
 * `diy.operators[charId]`（那张自选界面读的名字 / 星级 / 职业 / 盟约表）。
 *
 * 这是「新增一个干员」从**就地补丁**变成**包**的最后一块：在它之前，一个包能带干员记录、能带素材、能带语音，
 * 但它加的新干员在自选界面里**根本不存在**（`diy` 只认生成器写出来的那 86 条）；作者只能手改
 * `data/backups.json`，而那是生成物 —— 下次 `npm run build-data` 会把他的条目整条抹掉。
 *
 * `data/*.json` 依旧一个字节都不改：叠加发生在 `deepFreeze` 之前（docs/WORKSHOP.md §1.3），所以
 * 「作者能加」与「生成器是唯一来源」同时成立 —— 磁盘上的 `ownedPool.length === 71` 那几条生成器契约
 * （`test/backups.test.js`）完全不受影响。
 *
 * 入池顺序只由包 id 排序决定（`workshopOperatorEntries` 内部就是 `byPackId`），不依赖目录扫描顺序。
 * `data.backups` 不存在时报告 `MANIFEST_MISSING`，不凭空造一份（与 art 缺 `assets.json` 同一手法）。
 */
function mergeWorkshopOperators(data, packs, report) {
  const { entries, errors } = workshopOperatorEntries(data, packs);
  for (const e of errors) report.errors.push(e);
  if (!entries.length) return;
  const backups = isPlainObj(data.backups) ? data.backups : null;
  const diy = backups && isPlainObj(backups.diy) ? backups.diy : null;
  if (!diy) {
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.pack)) continue;
      seen.add(e.pack);
      report.errors.push({
        pack: e.pack, file: 'backups', id: 'diy', code: 'MANIFEST_MISSING',
        reason: 'this pack declares 自选池 operators, but data/backups.json has no "diy" map — run `npm run build-data` so the 自选 pool has somewhere to publish to',
      });
    }
    return;
  }
  const pool = [...(Array.isArray(diy.ownedPool) ? diy.ownedPool : [])];
  const operators = { ...(isPlainObj(diy.operators) ? diy.operators : {}) };
  /** @type {Record<string, string[]>} */
  const added = {};
  for (const { pack, id, rec } of entries) {
    // 已经在这个池里（一个官方干员、或者……）时不再 push：`ownedPool` 是一份「拥有哪些干员」的集合，
    // 两个条目一个 id 只会让自选界面出现两个一样的格子。
    if (!pool.includes(id)) pool.push(id);
    operators[id] = rec;
    (added[pack] ||= []).push(id);
  }
  for (const list of Object.values(added)) list.sort();
  data.backups = { ...backups, diy: { ...diy, ownedPool: pool, operators } };
  report.operators = added;
}

/**
 * Make newly added STAGES selectable.
 *
 * A stage only enters a match when the mode's `stages` list names it (server/match/waves.js picks among those by
 * `weight`) — and `config` is deliberately NOT a workshop-contributable file, because a pack that could rewrite config
 * could rewrite the economy and the round schedule. So instead of letting a pack ship a config overlay, the loader
 * honours the stage's OWN `modes` list by APPENDING its id to those mode entries. Nothing else in `config` is ever
 * written, and only stages the pack actually added are linked.
 *
 * Mutates `data.config` (a fresh copy) and records each link in `report.linkedStages` so the boot log can show it.
 */
function linkWorkshopStages(data, report) {
  const added = Array.isArray(report.added.stages) ? report.added.stages : [];
  if (!added.length || !isPlainObj(data.stages) || !isPlainObj(data.config) || !isPlainObj(data.config.modes)) return;
  const modes = { ...data.config.modes };
  let touched = false;
  for (const id of added) {
    const stage = data.stages[id];
    const declared = stage && Array.isArray(stage.modes) ? stage.modes : [];
    for (const modeId of declared) {
      const mode = modes[modeId];
      if (!isPlainObj(mode)) continue;
      const list = Array.isArray(mode.stages) ? mode.stages.slice() : [];
      if (list.includes(id)) continue;
      list.push(id);
      modes[modeId] = { ...mode, stages: list };
      touched = true;
      (report.linkedStages ||= []).push(`${id} -> ${modeId}`);
    }
  }
  if (touched) data.config = { ...data.config, modes };
}

/**
 * One-line summary of a merge report for the boot log / `--doctor`.
 * @param {ReturnType<typeof applyWorkshop>['report']} report
 */
export function workshopSummary(report) {
  if (!report || !Array.isArray(report.packs) || !report.packs.length) return 'no workshop packs';
  const parts = report.packs.map((p) => {
    const bits = [];
    const files = Object.entries(p.files).filter(([, n]) => n.added || n.overridden)
      .map(([f, n]) => `${f} +${n.added}${n.overridden ? ` ~${n.overridden}` : ''}`);
    if (files.length) bits.push(files.join(', '));
    const voices = report.voices && report.voices[p.id];
    const langVoices = report.voiceLangs && report.voiceLangs[p.id];
    if (voices || langVoices) {
      // the default dub first, then each extra dub with its own count: `3 voice lines (jp 2, en 1)`
      const perLang = langVoices ? Object.entries(langVoices).map(([l, n]) => `${l} ${n}`).join(', ') : '';
      const head = voices ? `${voices} voice line${voices === 1 ? '' : 's'}` : 'voice lines';
      bits.push(perLang ? `${head} (${perLang})` : head);
    }
    const icons = report.bondIcons && report.bondIcons[p.id];
    if (icons) bits.push(`${icons.length} bond icon${icons.length === 1 ? '' : 's'}`);
    const itemIcons = report.itemIcons && report.itemIcons[p.id];
    if (itemIcons) bits.push(`${itemIcons.length} item icon${itemIcons.length === 1 ? '' : 's'}`);
    const art = report.art && report.art[p.id];
    if (art) bits.push(`${art.length} art entr${art.length === 1 ? 'y' : 'ies'} (${art.join(', ')})`);
    // 扁平图标表（`assets.skills` / `assets.prof.sub`）与上面那条分开数：它们的落点不是 `assets.<表>`，
    // 一条日志里混在一起会让读的人去 assets.chars 里找一个技能图标。
    const flatArt = report.flatArt && report.flatArt[p.id];
    if (flatArt) bits.push(`${flatArt.length} icon${flatArt.length === 1 ? '' : 's'} (${flatArt.join(', ')})`);
    const support = report.support && report.support[p.id];
    if (support) bits.push(`助战 +${support.length}`);
    const operators = report.operators && report.operators[p.id];
    if (operators) bits.push(`自选池 +${operators.length}`);
    const looks = (report.looks || []).filter((l) => l.pack === p.id);
    // 干员与怪物分开数：一句话里混着「3 个干员」而其中两个是怪物，读日志的人会去找错对象
    const lookOperators = looks.filter((l) => l.kind !== 'enemy').length;
    const lookEnemies = looks.length - lookOperators;
    if (lookOperators) bits.push(`${lookOperators} 个干员没有模型（会画成贴图）`);
    if (lookEnemies) bits.push(`${lookEnemies} 个怪物没有模型（会画成贴图）`);
    return `${p.name}(${p.id}): ${bits.length ? bits.join(', ') : 'nothing'}`;
  });
  if (report.supportOff) parts.push('助战 pool contributions off (support.json "workshop": false)');
  if (report.errors.length) parts.push(`${report.errors.length} rejected record(s)`);
  return parts.join('; ');
}
