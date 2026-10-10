// shared/modSurface.js — 包能碰的**表面清单**（pack-facing ABI）与冻结账本。
// (i18n-ignore-file: 这是给维护者与 AI 读的接口清单与拒绝理由，不是客户端界面文案)
//
// WHY THIS FILE EXISTS (owner's question of 2026-10-10: 「如果改动引擎，我们的中间层可能又被覆盖，那怎么办呢」)
//
// 引擎会被上游移植改写 —— `server/lobby.js`、`server/match/*`、`public/js/screens/*` 都会整段换掉。中间层
// （工坊包这一整套契约）**不能靠「没人会动它」活着**：一份没有清单、没有守卫的契约，被一次重构顺手删掉时
// 没有任何测试会红。所以这里把「包能依赖的表面」写成一张**可断言的表**：
//
//   表面 = 一条声明 + 一个承载它的符号 + 一组实现文件 + 一份钉死它的测试 + 一节设计稿。
//
// `test/modSurface.test.js` 逐条断言这张表：锚点符号还在、成员还在、实现文件还在、测试文件还在、设计稿那节还在，
// 并且 `shared/workshop.js` 里**每一个**「包可声明的名单」都被某一条表面引用 —— 于是「引擎里加了一格但没进清单」
// 与「引擎里删了一格而清单还说它在」两种断裂都会当场变红。这是移植时的唯一防线，比任何注释都硬。
//
// 与 `test/modSurface.test.js` 前半部分的分工：那一半钉的是**就地补丁式**社区 mod 依赖的通用名
// （`data/backups.json` 的记录形状、`kits/shared/tier1.js` 的具名导出、`battle.refreshRange`）—— 那些 mod 不经过
// 我们的校验器；这一半钉的是**工坊包**依赖的声明层 ABI —— 它经过校验器，但校验器只能保证「今天判得过」，
// 保证不了「明天这一格还在」。
//
// 版本政策（与 docs/design/mod-layer.md §28.5 的三档判定配套）：
//   * 这一张表属于**一个 ABI 世代**（`shared/constants.js MOD_API_VERSION`）。包用 `pack.json.api` 声明它要的世代。
//   * 世代的数字**只在「删除 / 改名 / 改语义」时抬**；**加一格不抬** —— 加一格对已发布的包是纯增量，
//     抬数字会让所有写了 `api: "1.x"` 的老包被判 `MOD_API_INCOMPATIBLE` 而拒绝加载，那是在惩罚老包。
//   * `MOD_SURFACE_FROZEN` 是**冻结账本**：每个世代必须仍然全部在场的 id 列表。删掉一格而没抬世代 =
//     守卫红（`surfaceLedgerIssues`）。抬世代时，被删的那一格必须同时给出迁移说明，写在 docs/MOD-SURFACE.md。

/**
 * 一张表面的形状。字段的用法都是断言用的，不是装饰：
 * @typedef {object} ModSurface
 * @property {string} id            稳定标识（也是 docs/MOD-SURFACE.md 里的那一行）
 * @property {'A'|'B'|'C'} layer    A 内容 / B 服务端逻辑 / C 客户端界面（DESIGN §28.1 的三层）
 * @property {string} decl          `pack.json` 里的声明路径 —— 作者写的那一行
 * @property {Array<{symbol: string, members?: string[]}>} anchors
 *   承载它的**导出符号**（`shared/workshop.js` 的名单常量等）。守卫会 import 真模块并断言符号存在、`members` 仍在。
 * @property {string[]} requires    用它还必须满足什么（硬闸门、确定性、两端一致…）—— 「这一格不是白给的」
 * @property {string[]} files       实现它的引擎文件（改了这些文件就要回头看这一格）
 * @property {string[]} tests       钉死它的测试文件
 * @property {string} spec          定义它的设计稿小节（`docs/design/mod-layer.md`）
 */

/** 包能碰的全部表面。**顺序即阅读顺序**：A 内容 → B 服务端 → C 客户端 → 发行。 */
export const MOD_SURFACE = Object.freeze([
  // ------------------------------------------------------------------ A 层：内容
  {
    id: 'content',
    layer: 'A',
    decl: 'pack.json.content[] + <file>.json',
    anchors: [{ symbol: 'WORKSHOP_CONTENT_FILES' }, { symbol: 'PACK_FIELDS', members: ['content'] }],
    requires: ['记录形状照抄官方（test/modSurface.test.js 前半钉的那 14 个键）', '确定性：数据不是代码，改不了对局结果'],
    files: ['shared/workshop.js', 'server/workshop.js', 'server/data.js'],
    tests: ['test/workshop.test.js', 'test/workshopPack.test.js'],
    spec: '§28.13',
  },
  {
    id: 'overrides',
    layer: 'A',
    decl: 'pack.json.overrides[] = "<文件>:<id>"',
    anchors: [{ symbol: 'OVERRIDE_ENTRY_RE' }, { symbol: 'PACK_FIELDS', members: ['overrides'] }],
    requires: ['覆盖官方条目必须显式声明（否则改的是别人的东西）'],
    files: ['shared/workshop.js', 'server/workshop.js'],
    tests: ['test/overrideMode.test.js', 'test/workshopValidateOverrides.test.js'],
    spec: '§28.3',
  },
  {
    id: 'units.operators',
    layer: 'A',
    decl: 'pack.json.operators / pack.json.support + units.json',
    anchors: [{ symbol: 'UNIT_REQUIRED_FIELDS' }, { symbol: 'PACK_FIELDS', members: ['operators', 'support'] }],
    requires: ['干员记录必须带 UNIT_REQUIRED_FIELDS 那几个键'],
    files: ['shared/workshop.js', 'server/workshop.js', 'tools/build-data.mjs'],
    tests: ['test/workshopOperators.test.js', 'test/workshopSupport.test.js'],
    spec: '§28.10',
  },
  {
    id: 'media.voices',
    layer: 'A',
    decl: 'pack.json.voices / voiceLangs + voices/<charId>/<槽位>.<ext>',
    anchors: [{ symbol: 'WORKSHOP_MEDIA_PREFIX' }, { symbol: 'PACK_FIELDS', members: ['voices', 'voiceLangs'] }],
    requires: ['只服务声明过的 URL（未登记的路径 404，穿越没有目标）'],
    files: ['shared/workshop.js', 'server/workshop.js', 'server/http/static.js'],
    tests: ['test/workshopVoices.test.js', 'test/voicePack.test.js'],
    spec: '§28.13',
  },
  {
    id: 'media.icons',
    layer: 'A',
    decl: 'pack.json.bondIcons / itemIcons / art',
    anchors: [{ symbol: 'ART_TABLES' }, { symbol: 'PACK_FIELDS', members: ['bondIcons', 'itemIcons', 'art'] }],
    requires: ['图标路径必须是包内相对路径', '素材不进 git（public/assets/ 被忽略）'],
    files: ['shared/workshop.js', 'server/workshop.js', 'server/modCatalog.js'],
    tests: ['test/workshopBondIcons.test.js', 'test/workshopItemIcons.test.js', 'test/workshopArt.test.js'],
    spec: '§28.13',
  },
  {
    id: 'notices',
    layer: 'A',
    decl: 'pack.json.notices = { <栏目>: <文本> }',
    anchors: [{ symbol: 'PACK_FIELDS', members: ['notices'] }],
    requires: ['纯文本，结构化但不执行'],
    files: ['shared/workshop.js', 'server/notices.js'],
    tests: ['test/packNotices.test.js', 'test/modNoticesPanel.test.js'],
    spec: '§28.15',
  },
  {
    id: 'i18n',
    layer: 'A',
    decl: 'pack.json.i18n = { <code>: <包内 .json> }',
    anchors: [{ symbol: 'PACK_FIELDS', members: ['i18n'] }],
    requires: ['语言文件名必须是语言码（`/i18n/<code>.json` 就是这条声明的 URL）'],
    files: ['shared/workshop.js', 'server/http/static.js'],
    tests: ['test/modI18n.test.js'],
    spec: '§28.13',
  },
  // ------------------------------------------------------------------ B 层：服务端逻辑
  {
    id: 'server.preDispatch',
    layer: 'B',
    decl: 'pack.json.server.preDispatch = { module, policy, intercepts }',
    anchors: [{ symbol: 'SERVER_MEMBERS', members: ['preDispatch'] }],
    requires: ['intercepts 必须是 shared/protocol.js C2S 里的类型名（总线不会送一个没人发的名字）'],
    files: ['shared/workshop.js', 'server/modDispatch.js', 'server/http/websocket.js'],
    tests: ['test/modPreDispatch.test.js'],
    spec: '§28.13',
  },
  {
    id: 'server.meta',
    layer: 'B',
    decl: 'pack.json.server.meta = { module, registers }',
    anchors: [{ symbol: 'SERVER_MEMBERS', members: ['meta'] }, { symbol: 'META_KEY_CLASSES' }],
    requires: ['registers 的每一类都要有对应键（否则那条声明永远不生效）'],
    files: ['shared/workshop.js', 'server/match/metaPack.js', 'server/match/Match.js'],
    tests: ['test/packMeta.test.js', 'test/packMetaWiring.test.js'],
    spec: '§28.13',
  },
  {
    id: 'server.modules',
    layer: 'B',
    decl: 'pack.json.server.modules = { module, uses[] }',
    anchors: [{ symbol: 'SERVER_MEMBERS', members: ['modules'] }, { symbol: 'SERVER_MODULE_USES' }],
    requires: ['只允许 uses 里那几个生命周期钩子', '源码过静态确定性扫描（无 process / require / eval）'],
    files: ['shared/workshop.js', 'server/modModules.js', 'shared/kitAuthoring.js'],
    tests: ['test/packServerModules.test.js', 'test/packServerModulesWire.test.js'],
    spec: '§28.14',
  },
  {
    id: 'server.battle',
    layer: 'B',
    decl: 'pack.json.server.battle = { module }',
    anchors: [{ symbol: 'SERVER_MEMBERS', members: ['battle'] }, { symbol: 'BATTLE_IMPORT_PREFIXES', module: 'kitImports' }],
    requires: ['combat: true（硬闸门：它改得了对局结果）', '两端跑同一段字节', 'import 只能走 @battle/ 与 @sim/'],
    files: ['shared/workshop.js', 'shared/kitImports.js', 'server/workshop.js', 'server/battlePack.js', 'server/sim/content/index.js'],
    tests: ['test/packBattle.test.js'],
    spec: '§28.17',
  },
  {
    id: 'server.room',
    layer: 'B',
    decl: 'pack.json.server.room = { module }',
    anchors: [{ symbol: 'SERVER_MEMBERS', members: ['room'] }, { symbol: 'ROOM_IMPORT_PREFIXES', module: 'kitImports' }],
    requires: [
      '**不**是 combat 闸门：它拿到的是只读观察面（快照/访问器/订阅），返回值一律忽略 ⇒ 改不了谁在玩、装了什么、这一局的结果',
      'import 只能走 @sim/（刻意不新开 @room/：白名单是两端共用的一张表，而这一层只在服务端跑）',
      'W-B：房间声明了集合时只有它点名的包的钩子装上',
    ],
    files: ['shared/workshop.js', 'shared/kitImports.js', 'server/roomPack.js', 'server/workshop.js', 'server/lobby.js'],
    tests: ['test/packRoom.test.js'],
    spec: '§28.20',
  },
  {
    id: 'routes',
    layer: 'B',
    decl: 'pack.json.routes = [{ path, cache }]',
    anchors: [{ symbol: 'ROUTE_CACHE_POLICIES' }, { symbol: 'PACK_FIELDS', members: ['routes'] }],
    requires: ['路径与缓存策略都要在允许集合内（没有「包自己发明的缓存语义」）'],
    files: ['shared/workshop.js', 'server/http/routes.js', 'server/http/mods.js'],
    tests: ['test/modRoutes.test.js'],
    spec: '§28.13',
  },
  {
    id: 'assets',
    layer: 'B',
    decl: 'pack.json.assets = { container, algorithm, digest, file, server }',
    anchors: [{ symbol: 'ASSETS_SERVER_POLICIES' }, { symbol: 'ASSETS_VERIFY_ALGORITHMS' }],
    requires: ['装载期核对声明的摘要（对不上就不服务）', 'server: serve | cache-only 二选一'],
    files: ['shared/workshop.js', 'server/workshop.js', 'server/http/static.js'],
    tests: ['test/modAssets.test.js', 'test/packAssets.test.js', 'test/workshopAssets.test.js'],
    spec: '§28.13',
  },
  // ------------------------------------------------------------------ C 层：客户端界面
  {
    id: 'client.panels',
    layer: 'C',
    decl: 'pack.json.client.panels[] = { id, slot, module, order, gate }',
    anchors: [{ symbol: 'CLIENT_PANEL_SLOTS' }, { symbol: 'CLIENT_PANEL_REPEATABLE' }],
    requires: ['slot 必须是引擎渲染得出的宿主（九个之一）', '一个声明用不了就点名丢掉整个面板，不挂半个'],
    files: ['shared/workshop.js', 'server/workshop.js', 'server/http/workshop.js', 'public/js/ui/extensions.js'],
    tests: ['test/modClientPanels.test.js', 'test/modClientHosts.test.js'],
    spec: '§28.8',
  },
  {
    id: 'client.panels.wraps',
    layer: 'C',
    decl: 'pack.json.client.panels[].wraps[] = { component, mode }',
    anchors: [{ symbol: 'CLIENT_WRAP_COMPONENTS' }, { symbol: 'CLIENT_WRAP_MODES' }],
    requires: [
      'component 必须是引擎注册表里的具名组件；mode 是 wrap | replace',
      'wrap 每帧调用一次，拿到的是 vnode；replace 拿到的 orig 是 null（下方整段不渲染由引擎保证）',
      '面板除了今天那份冻结注入面，只多 component 与 props（只读深拷贝）——没有 store、没有 engine、没有 match',
      '任一环抛错或返回空：退回**它下面那一份**并点名一次（CLIENT_WRAP_THREW / CLIENT_WRAP_NO_RENDER），屏幕照旧',
    ],
    files: ['shared/workshop.js', 'public/js/ui/extensions.js', 'public/js/ui/modComponents.js', 'server/workshop.js'],
    tests: ['test/modPanelWraps.test.js'],
    spec: '§28.19',
  },
  {
    id: 'kits.relativeImports',
    layer: 'B',
    decl: 'kits/<id>.js 里的 ./… 相对 import（含 kits/_shared.js 之类的辅助文件）',
    anchors: [{ symbol: 'KIT_IMPORT_PREFIXES', module: 'kitImports' }, { symbol: 'KIT_IMPORT_FILES', module: 'kitImports' }],
    requires: [
      '只允许**向下**相对：`..`、绝对路径、`%`、反斜杠、非 .js、空段一律仍拒（URL 里没有 kits/ 段，`..` 两端走不出同样层数）',
      '按**出现 import 的那个文件**自己的目录解析，服务端重写成 file: URL，浏览器按模块自己的 URL 原生解析 —— 两端同一个文件',
      '/workshop-kits/<包>/<rel> 只服务已装载包 kits/ 子树里的 .js（一次解码、path.relative 判界、非 .js 与穿越同一个 404）',
      '辅助文件的字节进身份哈希（kits/**/*.js 递归），因为改它就能改战果，而摘要正是 W-D 对齐比较的对象',
      '顶层非 `_` 的 .js 才算 kit；子目录与 `_` 前缀是辅助文件',
      '作者侧的提示必须与这条判据同步 —— 但那只是**镜像**，不是实现依赖：shared 与服务端代码一律不引用编辑器的路径',
    ],
    files: ['shared/kitImports.js', 'server/workshop.js', 'server/http/static.js', 'server/http/workshop.js'],
    tests: ['test/packRelativeImports.test.js', 'test/kitImports.test.js'],
    spec: '§28.18',
  },
  {
    id: 'client.panels.styles',
    layer: 'C',
    decl: 'pack.json.client.panels[].styles[] = "<包内 .css>"',
    anchors: [{ symbol: 'WORKSHOP_PANEL_PREFIX' }],
    requires: ['只服务登记过的 URL', '样式是加法：挂载时注入 <link>，dispose 时移除'],
    files: ['shared/workshop.js', 'server/http/workshop.js', 'public/js/ui/extensions.js'],
    tests: ['test/modClientStyles.test.js'],
    spec: '§28.8',
  },
  {
    id: 'client.theme',
    layer: 'C',
    decl: 'pack.json.client.theme.vars = { --x: <值> }',
    anchors: [{ symbol: 'CLIENT_REQUIRES' }],
    requires: ['变量名必须 -- 开头（不叫 --x 的键写进去等于什么都没发生）', '值里不许有 ; { } < > 换行'],
    files: ['shared/workshop.js', 'public/js/ui/extensions.js'],
    tests: ['test/modClientStyles.test.js'],
    spec: '§28.8',
  },
  {
    id: 'client.panels.data',
    layer: 'C',
    decl: 'pack.json.client.panels[].data[] = "<表名>"',
    anchors: [{ symbol: 'CLIENT_PANEL_DATA_TABLES' }],
    requires: ['表必须在 CLIENT_PANEL_DATA_TABLES 里（浏览器本来就抓得到的那几张）', '读到的是只读快照，不是引擎的缓存本体'],
    files: ['shared/workshop.js', 'public/js/ui/extensions.js', 'public/js/data.js'],
    tests: ['test/modClientData.test.js', 'test/modClientHosts.test.js'],
    spec: '§28.8',
  },
  {
    id: 'client.panels.messages',
    layer: 'C',
    decl: 'pack.json.client.panels[].messages[] = "<通道名>"',
    anchors: [{ symbol: 'CLIENT_PANEL_SLOTS' }],
    requires: ['线上类型名由引擎定（pack.msg），通道名由包定', '每会话令牌桶限流，data ≤ 4096 字节'],
    files: ['shared/workshop.js', 'shared/protocol.js', 'server/net.js', 'public/js/ui/extensions.js'],
    tests: ['test/modClientMessages.test.js'],
    spec: '§28.8',
  },
  {
    id: 'client.requires',
    layer: 'C',
    decl: 'pack.json.client.requires[] = serviceWorker | cacheStorage | webCrypto',
    anchors: [{ symbol: 'CLIENT_REQUIRES' }],
    requires: ['缺一即「这个浏览器不支持」，不是「装了但静默不工作」'],
    files: ['shared/workshop.js', 'public/js/ui/extensions.js'],
    tests: ['test/modClientHosts.test.js'],
    spec: '§28.13',
  },
  // ------------------------------------------------------------------ 发行：房间集合与对齐
  {
    id: 'mods.catalog',
    layer: 'C',
    decl: '客户端 mod 目录与房间声明（welcome.modPanels / room modIds）',
    anchors: [{ symbol: 'PACK_ID_RE' }],
    requires: ['房间声明了 modIds 时，只有它点名的包参与（W-B）', '两端的字节要能对齐（W-D：摘要一致才开局）'],
    files: ['server/modCatalog.js', 'server/roomAssets.js', 'public/js/mods/store.js', 'public/js/mods/align.js', 'public/js/mods/sync.js'],
    tests: ['test/modCatalog.test.js', 'test/modAlign.test.js', 'test/roomModSet.test.js'],
    spec: '§28.16',
  },
]);

/** id → 表面。 */
export const MOD_SURFACE_BY_ID = Object.freeze(new Map(MOD_SURFACE.map((s) => [s.id, s])));

/** 全部 id，按表的顺序。 */
export const MOD_SURFACE_IDS = Object.freeze(MOD_SURFACE.map((s) => s.id));

/**
 * 冻结账本：**世代 → 该世代里必须仍然全部在场的 id**。
 *
 * 加一格不改这里（增量不需要新世代）；删一格而世代数字没抬，就是这里红。抬世代时把当世代那份抄下来、写成新的
 * 键，并在 docs/MOD-SURFACE.md 写明「哪一格被谁取代、老包怎么迁移」。
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const MOD_SURFACE_FROZEN = Object.freeze({
  1: MOD_SURFACE_IDS,
});

/**
 * 账本的判据本身（**纯函数**，所以它自己可以被测：喂一份「少了一格」的列表进去必须报出来 —— 一条只在今天的数据
 * 上成立、从来没有验过失败分支的守卫，和没有守卫是一回事）。
 * @param {readonly string[]} ids 今天表里的 id
 * @param {number|string} generation 今天的 ABI 世代（`shared/constants.js MOD_API_VERSION`）
 * @returns {string[]} 人话说明；空数组 = 账本对得上
 */
export function surfaceLedgerIssues(ids, generation) {
  const out = [];
  const key = String(generation);
  const frozen = MOD_SURFACE_FROZEN[key];
  if (!frozen) {
    out.push(`没有世代 ${key} 的冻结账本：加了新世代就把它那一份 id 抄进 MOD_SURFACE_FROZEN["${key}"]，否则这一代没有任何防删保护`);
    return out;
  }
  const have = new Set(ids || []);
  for (const id of frozen) {
    if (!have.has(id)) {
      out.push(`表面 "${id}" 在世代 ${key} 的冻结账本里，但今天的表里没有了：删/改名/改语义都要抬 MOD_API_VERSION 并写明迁移，不能在一个世代里悄悄拿掉`);
    }
  }
  return out;
}

/**
 * 表里出现的全部锚点，写成 `"<模块>:<符号>"`（模块省略时是 `schema`，即 `shared/workshop.js`）—— 给守卫用：
 * 守卫不去猜，它 import 那几个模块再逐条查，所以「锚点写错名字」和「符号被挪走」都会红。
 * @returns {string[]}
 */
export function modSurfaceAnchorSymbols() {
  return [...new Set(MOD_SURFACE.flatMap((s) => s.anchors.map((a) => `${a.module || 'schema'}:${a.symbol}`)))].sort();
}
