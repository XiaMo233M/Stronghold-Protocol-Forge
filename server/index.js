// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST '::' dual-stack, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503)
//                      which startServer() options go to net.js / lobby.js, the console logger, the official versions
//                      this server offers (SP_VERSIONS / SP_VERSION_DEFAULT / SP_MAX_VERSION_HOSTS — versions.js below)
//   versions.js        the official versions (DESIGN §37.23, M1): each enabled one's cs, data, manifest
//                      (/cs/<cs16>/index.json) and data directory (/data/versions/<slug>/); their matches run in match
//                      hosts of their own (match/host/, kind 'version') — the pool exists when another version is
//                      enabled (the default: all four) and forks a process on the first match of one, never at boot;
//                      none when only 第二期下半 is enabled
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB,
//                      permessage-deflate from 1 KB; refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the language packs (/packs/index.json, /packs/<id>/<file>) and the plugin catalogue
//                      (/plugins/index.json — the registry is plugins/registry.js), the vanilla content set's manifest
//                      (/cs/<cs16>/index.json — plugins/identity.js), the visual sets of cosmetic plugins
//                      (/vs/<vs16>/…, plugins/visualSet.js), their files (/p/<id>/<hash8>/…) and the content sets of
//                      gameplay plugins (/cs/<cs16>/…, plugins/contentSets.js)
//   http/csp.js        the site CSP of the served pages (SP_CSP=off leaves it out; routes.js)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, brotli / gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/assetIndex.js the content hashes of public/assets and public/fonts (built in the background, cached in
//                      .cache/asset-hashes.json by path + size + mtime; Spine models share one hash)
//   http/assetViews.js the served /data/assets.json and /data/local-assets.json: every art URL with its hash segment
//                      (/assets/~<hash>/…, immutable when the hash matches); the committed files stay unchanged
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400, the plugin studio (/studio/, studio/index.js —
//                      this machine and the local network only), 405, GET /healthz → JSON status, else static
//   http/traffic.js    the traffic counters: bytes sent per category (assets / audio / code / data) and on the
//                      WebSocket, since the start (GET /healthz?traffic=1)
//   http/common.js     what every answer shares: security headers, URL split, error page, JSON replies, bare 400
//   http/boot.js       a pending update package first (update.js: old files deleted, the install verified against
//                      MANIFEST.json), banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT /
//                      SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import path from 'node:path';
import { getData, loadData } from './data.js';
import { loadWorkshop, loadWorkshopKits, loadWorkshopHooks, loadWorkshopPanels, workshopThemeFor, dropUnavailablePreDispatchPacks, adjudicatePackGraph, WORKSHOP_DIR } from './workshop.js';
import { readModRegistry, applyModRegistry } from './modRegistry.js';
import { loadMetaModules } from './match/metaPack.js';
import { loadBattleInstallers } from './battlePack.js';
import { loadRoomInstallers } from './roomPack.js';
import { loadServerModules, mountServerModules, stateRootFor, bootConfigSnapshot } from './modModules.js';
import { materializeVoiceCdn, dropFailedVoiceCdnFiles } from './voiceCdn.js';
import { workshopNotices } from './notices.js';
import { createRoomAssets } from './roomAssets.js';
import { Match as DefaultMatch } from './match/Match.js';
import {
  buildWorkshopDataFiles, workshopKitFilesFor, workshopKitDirsFor, workshopPanelFilesFor, workshopAssetsFor, workshopRoutesFor,
  workshopResourceFilesFor, workshopModAssetsFrom, buildWorkshopI18nFiles, resourceServerPolicy, WORKSHOP_ASSET_PREFIX, WORKSHOP_ASSET_TYPES, workshopBattleFilesFor,
} from './http/workshop.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy, assetIndexOptionsFrom, versionsFrom, parseRoomCode } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket, transportPolicy } from './http/websocket.js';
import { getBotStrategy } from './match/botStrategies.js';
import { noteLlmIgnored, releaseIgnoresExternalAi, validateExternalConfig } from './match/llmGate.js';
import { siteCsp } from './http/csp.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
// 0.3.0（上游 DESIGN §34）的插件面：包注册表并进插件注册表（`server/packs.js` 现在只是它的别名再导出），
// 加原生内容集、视觉集、仅服务端生效的插件策略 / 房间集合、以及「一局一进程」的对局宿主与可信脚本运行器。
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContent } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { createMatchHosts } from './match/host/index.js';
import { createVersionSets } from './versions.js';
import { versionById } from '../shared/versions.js';
import { createTrustedRuntime } from './plugins/trustedRuntime.js';
import { trustedHostAllowed } from './plugins/trusted.js';
import { createStudio } from './studio/index.js';
import { MIME, COMPRESSIBLE, acceptsGzip, pickEncoding, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { createTrafficCounter } from './http/traffic.js';
import { createAssetIndex } from './http/assetIndex.js';
import { createManifestViews } from './http/assetViews.js';
import { AccountStore } from './accounts.js';
import { MatchRecords } from './matchRecords.js';
import { resolveAccountConfig } from './accountConfig.js';
// 保留表只此一处真相（DESIGN §28.35）：核心挂载目录与「核心先吃」判据都来自 routeMount.js。
import { coreMounts } from './http/routeMount.js';
import { createModsRoute, serveMods, MODS_CATALOG_URL, MOD_FILE_PREFIX } from './http/mods.js';
import { buildModCatalog } from './modCatalog.js';
import { answerClientError } from './http/common.js';
import { createEventLoopMonitor } from './health/eventLoop.js';
import { createRoomWorkerPool } from './workers/roomPool.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, pickEncoding, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
  // 创意工坊 (docs/WORKSHOP.md): the HTTP helpers live in ./http/workshop.js but stay part of this module's API
  buildWorkshopDataFiles, workshopKitFilesFor, workshopKitDirsFor, workshopPanelFilesFor, workshopAssetsFor, workshopRoutesFor,
  workshopResourceFilesFor, workshopModAssetsFrom, buildWorkshopI18nFiles, resourceServerPolicy, WORKSHOP_ASSET_PREFIX, WORKSHOP_ASSET_TYPES,
  workshopBattleFilesFor,
  // 客户端 mod 本地缓存 (W-C): the catalogue builder and the routes a browser downloads from (server/modCatalog.js,
  // server/http/mods.js) — exported here so tests reach them the way they reach the workshop helpers above.
  buildModCatalog, createModsRoute, serveMods, MODS_CATALOG_URL, MOD_FILE_PREFIX,
};

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   accounts?: boolean, accountsFile?: string, recordsFile?: string,
 *   wsLanes?: readonly import('./http/wsLanes.js').WsLane[],
 *   httpLanes?: readonly import('./http/httpLanes.js').HttpLane[],
 *   assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number },
 * }} [opts]
 *   assetIndex: the content-hash index (default on; false or SP_ASSET_INDEX=0: off — config.js assetIndexOptionsFrom)
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPackRegistry>,
 *                     accounts: import('./accounts.js').AccountStore|null,
 *                     records: import('./matchRecords.js').MatchRecords|null,
 *                     traffic: ReturnType<typeof createTrafficCounter>,
 *                     assetIndex: ReturnType<typeof createAssetIndex> | null,
 *                     views: ReturnType<typeof createManifestViews> | null,
 *   versionVoteMs?: number, versionRetryMs?: number,
 *   roomCode?: string | null,
 *   assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number }, studio?: boolean,
 *   matchHost?: object, versions?: { enabled?: 'all' | string[], default?: string, maxHosts?: number },
 * }} [opts]
 *   assetIndex: the content-hash index (default on; false or SP_ASSET_INDEX=0: off — config.js assetIndexOptionsFrom);
 *   studio: the plugin studio at /studio/ (default on for this machine and the local network — SP_STUDIO=local|off;
 *   false: none);
 *   matchHost: options of the match hosts (server/match/host/index.js — watchdogMs, matchOptions …; tests) — the
 *   version hosts' too; versions: the official versions this server offers (http/config.js versionsFrom; DESIGN §37.23);
 *   versionVoteMs / versionRetryMs: the version vote's answer window and the guard after a declined or expired vote (tests;
 *   server/lobby.js header "Official versions")
 *   roomCode: a fixed alliance key for every new room (--room-code; four letters or digits — config.js parseRoomCode);
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPluginRegistry>,
 *                     content: import('./plugins/identity.js').VanillaContent, visual: ReturnType<typeof createVisualSets>,
 *                     contents: ReturnType<typeof createContentSets>, hosts: ReturnType<typeof createMatchHosts>,
 *                     versions: ReturnType<typeof createVersionSets>, versionHosts: ReturnType<typeof createMatchHosts> | null,
 *                     traffic: ReturnType<typeof createTrafficCounter>, assetIndex: ReturnType<typeof createAssetIndex> | null,
 *                     views: ReturnType<typeof createManifestViews> | null, studio: ReturnType<typeof createStudio> | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  // A release ignores external-AI settings (one log line) and keeps the built-in bot (§37.66).
  // An unknown strategy id still fails here, before data is loaded or the port is opened.
  const log = opts.log || makeLogger(!!opts.quiet);
  if (releaseIgnoresExternalAi()) noteLlmIgnored(log);
  try {
    const strategy = getBotStrategy(process.env.SP_BOT_STRATEGY);
    if (strategy.id === 'external') validateExternalConfig();
  } catch (cause) {
    throw new Error(`Invalid SP_BOT_STRATEGY: ${cause.message}. Unset SP_BOT_STRATEGY to use the original bot (legacy).`, { cause });
  }
  const { port, host } = listenAddress(opts);
  const { publicDir, dataDir, sharedDir, packsDir, pluginsDir } = serveDirs(opts);
  // `createStaticHandler` 的 `/sim/` 默认值，这里显式取同一个 —— 「核心先吃」要看到引擎真正会读的那个目录。
  const simDir = opts.simDir || path.join(ROOT, 'server', 'sim');

  // 原生内容哈希 `cs`（DESIGN §34，上游 0.3.0）：**现在**把服务出去的那份 sim / shared 代码与游戏数据读一次算出
  // 摘要 —— 与对局用的数据、下面的构建标记同一条纪律（一次读、之后引用同一个值）。它进 /plugins/index.json 与
  // /cs/<cs16>/index.json，也交给 Lobby 作为「这一局的底座」。
  const content = computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log });
  log.info(`[content] vanilla ${content.cs.slice(0, 16)} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
  // 语言包与插件（docs/PACKS.md · docs/PLUGINS.md）：启动时扫一次（启动日志点名），之后文件夹一变再扫。
  // 缺省就是上游的 createPluginRegistry —— `server/packs.js` 现在只是它的别名再导出，registry.index() / servable()
  // 的语义与 0.2.x 逐字相同，所以工坊那一整层读它读到的还是同一份东西。
  const scriptMode = process.env.SP_PLUGIN_SCRIPTS;
  const packs = createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log, scriptHost: host, scriptMode });
  packs.refresh(true);

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy. The 创意工坊 overlay
  // is applied inside the loader (server/data.js), i.e. whichever way the data is obtained, it is already merged.
  // SP_WORKSHOP (editor/playtest.mjs) lets the Forge editor's 试玩 subprocess read the workshop root the editor was
  // started with (`--workshop <dir>`) instead of the repository's own workshop/ — without it the playtest cannot see the
  // pack being edited (docs/EDITOR.md 「工坊目录」).
  const envWorkshop = process.env.SP_WORKSHOP ? path.resolve(process.env.SP_WORKSHOP) : null;
  const workshopDir = opts.workshopDir === undefined ? (envWorkshop || WORKSHOP_DIR) : opts.workshopDir;
  // 分发前钩子（`pack.json.server.preDispatch`, DESIGN §28.13）**排在最前面**，因为它的最后两种失败只能由动态
  // import 发现（模块装不上 / 没有工厂导出），而 `loadWorkshop` 与 `loadData` 都是同步的。判据一旦跑完，装配路径
  // 就把「声明了钩子却装不上」的包从已加载集合里**裁掉**（`dropUnavailablePreDispatchPacks`），再用裁剪后的数组
  // 喂给下面每一个读者：数据叠加层、身份清单、kits、面板、资源表、Lobby/Network。B1 段这里是「包照旧加载、只是
  // 钩子没装上」—— 那种结局让运维以为自己有一道不存在的闸门，而它的内容却已经并进了游戏数据。
  const stateRoot = stateRootFor(ROOT);
  const loadedOnce = loadWorkshop(workshopDir, { log });
  // 启用 / 禁用（DESIGN §28.47，`server/modRegistry.js`）：操作者的开关在这条装配流水线的**最上游**生效 ——
  // 被禁用的包连它的服务端载荷都不会被装载（没有 hook、没有订阅、没有字节），文件留在磁盘上，一条
  // `enable` 命令就回来。被禁用的 id 同时进 `excludePacks`，数据叠加层与这里是同一次裁剪。
  const modRegistry = readModRegistry(stateRoot, { log });
  const registryApplied = applyModRegistry(loadedOnce.packs, modRegistry);
  for (const d of registryApplied.disabled) log.warn(`[mod-registry] "${d.id}" disabled (${d.where}) — not loaded`);
  // 依赖 / 冲突的装载期裁决（DESIGN §28.48）：缺失依赖、版本不合、互斥、级联与循环，全部在这一步**具名拒绝**
  // —— 一个依赖链断裂的包，和它依赖的那个一样「不在」。与上一条同一个裁剪点：裁决出来的集合喂给下面每一个读者。
  const adjudicated = adjudicatePackGraph(registryApplied.packs);
  for (const r of adjudicated.refused) log.warn(`[mod-registry] "${r.id}" refused: ${r.reason}`);
  const loadedForPayloads = { ...loadedOnce, packs: adjudicated.kept };
  const workshopHooks = await loadWorkshopHooks(loadedForPayloads, { log });
  // 包声明的**对局元注册表**模块（`pack.json.server.meta`, DESIGN §29，B 段）：与钩子同一条纪律 —— 声明了却装不上
  //（源码里带非确定性的东西、没有 `registerMeta` 导出、import 失败）的包**整包移出已加载集合**，而不是「包照旧
  // 加载、只是它的效果不在」。所以它必须在**数据叠加层之前**跑完，与钩子合在同一个裁剪点上。
  const workshopMeta = await loadMetaModules(loadedForPayloads, { log });
  // 包的**服务端模块**（`server.modules`, DESIGN §28.14）：与上面两条同一个裁剪点 —— 模块文件不在、import 失败、
  // 没有 `registerServer`、或者它挂了一个自己没声明的挂载点，都让**这个包**整份移出已加载集合。
  // 账号与战绩（docs/RECORDS.md）。**开关是显式的 `SP_ACCOUNTS=1`**（业主裁令）：不能让「某个文件恰好存在」悄悄
  // 改掉握手语义。没有它时下面两件**都不构造**，`Network` 收到 `accounts: null`、`Lobby` 收到 `records: null`，
  // `hello` 与会话建立走的还是今天那条路，逐字节不变。
  //
  // 两个环境变量**刻意在 `server/accountConfig.js` 里读**，不在这里：`modModules.js` 的 `BOOT_CONFIG_ENV_KEYS`
  // 是**包能看见的**环境白名单，而 `test/packServerSurface.test.js` 用反射源码把「引擎读过的 SP_*」与它钉成
  // 一份 —— 而「这个服务器开不开账号」正是那种**不该**让包看见的运维杠杆（包据此分叉就成了「同一份摘要有两种
  // 行为」）。为什么这样切，写在 `accountConfig.js` 的文件头。
  const accountConfig = resolveAccountConfig(opts, stateRoot);
  const accounts = accountConfig.enabled ? new AccountStore(accountConfig.accountsFile) : null;
  const records = accountConfig.enabled ? new MatchRecords(accountConfig.recordsFile, log) : null;
  if (accountConfig.enabled) {
    // 生效值必须被**说出来**（与 resourcePolicy / transportPolicy 同一条纪律）：运维要能从启动日志确认
    // 「账号开着、库在哪」，而不是靠猜。
    log.info(`[accounts] enabled (SP_ACCOUNTS): ${accounts.byName.size} account(s) in ${accountConfig.accountsFile}; `
      + `match records in ${accountConfig.recordsFile}`);
  }
  const serverModules = await loadServerModules(loadedForPayloads, { log, stateRoot });
  // 包声明的**战斗逻辑**模块（`pack.json.server.battle`, DESIGN §28.17）：与上面三条同一个裁剪点 —— 源码里带非确定性
  // 的东西、import 越界、没有 `install` 导出、模块文件不在，都让**这个包**整份移出已加载集合。
  const battlePack = await loadBattleInstallers(loadedForPayloads, { log });
  // 包声明的**房间级钩子**（`pack.json.server.room`, DESIGN §28.20）：与上面四条同一个裁剪点 —— 源码里带非确定性的
  // 东西、import 越界、没有 `install` 导出、模块文件不在，都让**这个包**整份移出已加载集合。与 `server.battle` 的
  // 差别只有一处：这一层**只在服务端**跑，所以没有一份「送浏览器的 URL 清单」。
  const roomPack = await loadRoomInstallers(loadedForPayloads, { log });
  const pruned = dropUnavailablePreDispatchPacks(loadedForPayloads, [...workshopHooks.errors, ...workshopMeta.errors, ...serverModules.errors, ...battlePack.errors, ...roomPack.errors]);
  if (pruned.removed.length) {
    log.warn(`[workshop] dropped ${pruned.removed.length} pack(s) whose declared server-side payload cannot be installed: `
      + pruned.removed.map((r) => `"${r.pack}" (${r.code})`).join(', '));
  }
  // 裁剪之后才有「这一版到底装了哪些包」：被别的声明裁掉的包**也不该**留下它的 meta 处理器或服务端模块
  // （否则一个装不上的包会继续在对局里 / 在 /healthz 上说话）。
  const survivors = new Set(pruned.packs.map((p) => p.id));
  const metaModules = workshopMeta.modules.filter((m) => survivors.has(m.id));
  const serverModulesLive = serverModules.modules.filter((m) => survivors.has(m.pack));
  // 包通道的**投递面**（`server.modules[].channels`，DESIGN §28.23）：`<包 id>` → 这个包的服务端模块声明过的
  // 接收通道集合。与 Lobby 的 `packChannels`（面板清单推出来的「客户端能说什么」）成对：那张表决定消息**收不收**，
  // 这张决定消息送不送进**这一局**（`packMsg` → `Match.handlePackMsg`）。没有包声明 `channels` 时是空表 ⇒
  // `pack.msg` 的投递路径与从前**逐字节相同**（不建对象、不多一次调用、不多一行日志）。
  /** @type {Map<string, Set<string>>} */
  const serverChannelMap = new Map();
  for (const m of serverModulesLive) {
    for (const channel of (m.channels || [])) {
      if (!serverChannelMap.has(m.pack)) serverChannelMap.set(m.pack, new Set());
      serverChannelMap.get(m.pack).add(channel);
    }
  }
  // 战斗逻辑同理：被别的声明裁掉的包不该继续在战场里说话（它的 installer 与 URL 清单一起消失）。
  const battleInstallers = battlePack.installers.filter((m) => survivors.has(m.id));
  const battleModules = battlePack.modules.filter((m) => survivors.has(m.pack));
  // 房间级钩子同理：被别的声明裁掉的包不该继续在大厅里说话（它的 `install(room)` 与事件钩子一起消失）。
  const roomInstallers = roomPack.installers.filter((m) => survivors.has(m.id));
  const modMount = mountServerModules(serverModulesLive, { log });
  const excludedPacks = new Set([...pruned.removed.map((r) => r.pack), ...registryApplied.disabled.map((d) => d.id), ...adjudicated.refused.map((r) => r.id)]);
  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy. The 创意工坊 overlay
  // is applied inside the loader (server/data.js), i.e. whichever way the data is obtained, it is already merged.
  // SP_WORKSHOP (editor/playtest.mjs) lets the Forge editor's 试玩 subprocess read the workshop root the editor was
  // started with (`--workshop <dir>`) instead of the repository's own workshop/ — without it the playtest cannot see the
  // pack being edited (docs/EDITOR.md 「工坊目录」).
  // A caller that names a data dir OR a workshop root must get a FRESH load: `getData` is a process-wide singleton whose
  // first caller wins, and something in the import graph may already have created it with the default workshop/ — which
  // is exactly why SP_WORKSHOP has to take the loadData() branch, or the 试玩 subprocess would silently read the wrong
  // (empty) pack root.
  // `excludePacks` 让那一层也遵守同一次裁剪（`server/data.js`）：不这样做，被裁的包会留下一个「谁都不认识的干员」。
  const data = (opts.dataDir || opts.workshopDir !== undefined || envWorkshop)
    ? loadData(dataDir, { log, workshopDir, excludePacks: excludedPacks })
    : getData({ dir: dataDir, log, workshopDir, excludePacks: excludedPacks });
  // 创意工坊 (docs/WORKSHOP.md): 装载一次，派生运行时要的三件东西 ——
  //   * workshopJson      the /data files the browser must receive merged instead of the on-disk originals;
  //   * workshopKits.kits the behaviour layer (a per-battle kit map) for battles the server itself runs;
  //   * workshopKitFiles  the URLs serving those same kit modules to the browser, which must rebuild the identical map,
  //                       or its client-simulated battle would disagree with the server's verification.
  const workshopLoaded = { ...loadedForPayloads, packs: pruned.packs, errors: pruned.errors };
  // 作者自备 CDN 的语音素材（`pack.json.voices` / `voiceLangs` 里的 `{ url, sha256, file }` 条目，DESIGN §28.33）：
  // 在**合并语音表之前**把字节取到本地缓存并按作者声明的 sha256 核对。四条纪律见 `server/voiceCdn.js`；
  // 这里负责两件事 —— **逐条点名**（失败绝不静默）与**把取不到的那几条从语音表里摘掉**（宁可回落到默认配音，
  // 也不要留一条永远 404 的静音台词）。一条外部 CDN 不该让服务器起不来，所以失败只影响那一条素材。
  const voiceCdn = await materializeVoiceCdn(workshopLoaded.packs, { stateRoot, log });
  const voiceLoaded = voiceCdn.failed.size ? { ...workshopLoaded, packs: dropFailedVoiceCdnFiles(workshopLoaded.packs, voiceCdn.failed) } : workshopLoaded;
  const workshopJson = buildWorkshopDataFiles(data, voiceLoaded);
  // 公告 / 鸣谢的合并体（DESIGN §28.15）：引擎那一半**从更新记录生成**（单一事实源，不手写第二份），包那一半按
  // 包 id 追加。它走**既有的**合并数据通道送出（`/data/notices.json`，map 的键是 `notices`），所以既没有新路由、
  // 也没有新的静态路径；`data/notices.json` 本来就不存在，所以这纯属新增。
  const notices = workshopNotices(workshopLoaded, { changelogPath: path.join(ROOT, 'CHANGELOG.md'), log });
  workshopJson.set('notices', Buffer.from(JSON.stringify(notices.body), 'utf8'));
  // 行为层的**两个键空间**（docs/WORKSHOP.md §4.7）：一个 `kits/<id>.js` 的 id 要么是**干员键**（`kitOf`：
  // `def.charId` / `def.baseId` / `def.id`），要么是**召唤物键**（token 记录的 id：`tokens.kits?.[def.id]`）。
  // 两边都要被告知，装载器才判得出「这条 kit 到底给谁」—— 只给 chess 表的话，一个包的召唤物 kit 会被当成未知目标
  // 丢掉（而那正是「包能做数据、做不了行为」这个缺口）。
  //   干员那一半还包括各已装包 `pack.json.operators` 声明的 charId：自选池干员的 kit 就是按 charId 查的
  //   （server/sim/content/index.js isDiyDef + kitOf:85），所以那个 id 也是一个合法的 kit 目标。
  const workshopKits = await loadWorkshopKits(workshopLoaded, {
    log,
    knownIds: new Set([
      ...Object.keys(data.chess || {}),
      ...((workshopLoaded.packs || []).flatMap((p) => Object.keys(p.operators || {}))),
    ]),
    knownTokenIds: new Set(Object.keys(data.tokens || {})),
  });
  // The mod set (DESIGN §28.2): one identity per pack, one digest for the whole set. It travels in `welcome`, in
  // `/healthz` (lobby.stats) and in every BattleSpec, so the three can never disagree about what is running.
  // 口径声明（DESIGN §28.39）**随同一个 mod 条目走**：`modDigest` 只哈希 `[id, hash]` 对（shared/modIdentity.js:196），
  // 所以把 `variants` 带在这里不改任何摘要；而 `Match` 从 `mods.packs[].variants` 合成这一局的轴表，正是靠它。
  // 与 `voiceCdn` / `skins` 同一条纪律：**只在包真的声明过时才存在这个键**，没声明的包这一份与从前逐字节相同。
  // 行为开关声明（DESIGN §28.43）走**同一条路、同一个投影点**：漏掉它 = 服务端装载器读到了声明、`Match` 却读到
  // `undefined` ⇒ 开关**静默不生效**（§28.39 把这一处记成「这一层最容易做坏的地方」）。同样不进 `modDigest`
  // （它只哈希 `[id, hash]`），而它**必须**进包身份哈希 —— 那一半由 `server/workshop.js` 的 `canonicalJson(pack)` 管。
  const workshopMods = (workshopLoaded.packs || []).map((p) => ({
    id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api,
    ...(Array.isArray(p.variants) && p.variants.length ? { variants: p.variants } : {}),
    ...(Array.isArray(p.behaviour) && p.behaviour.length ? { behaviour: p.behaviour } : {}),
  }));
  const workshopKitFiles = workshopKitFilesFor(workshopKits.modules, workshopDir);
  // 行为层相对 import 的服务面（§28.18）：包 id → 它的 `kits/` 目录。`/workshop-kits/` 靠它才服务得了一个 kit
  // 用 `./lib/util.js` import 的兄弟文件 —— URL 里没有 `kits/` 这一段，所以路由要把这一段加回去（server/http/static.js
  // resolvePackRelativeKit），而**只有已装载的包**在这张表里，服务范围仍由装载器决定。
  const workshopKitDirs = workshopKitDirsFor(workshopLoaded);
  // 包声明的战斗逻辑模块送到浏览器（`/workshop-battle/<包>/<模块>`）：与 kits 逐字同一条通道 —— 只服务装载器登记过的
  // URL，客户端战斗必须跑同一段代码（否则浏览器算出的战果与服务端复算的对不上）。
  const workshopBattleFiles = workshopBattleFilesFor(battleModules, workshopDir);
  // 按房间物化（W-B，DESIGN §28.9）：房间声明的集合要真的决定这一局跑什么。只在**装了包**时建它 ——
  // 干净安装既不需要官方那一份的第二次读取，也没有任何集合会比「进程级那一份」更小。
  const roomAssets = (workshopLoaded.packs || []).length
    ? createRoomAssets({
      official: loadData(dataDir, { log, workshopDir: null }),
      processData: data,
      packs: workshopLoaded.packs,
      kits: workshopKits.kits,
      kitOwners: workshopKits.owners,
      tokenKits: workshopKits.tokenKits,
      tokenKitOwners: workshopKits.tokenOwners,
      modules: workshopKits.modules,
      log,
    })
    : null;
  // `/room-data/<摘要>/<文件>.json` 那一面（同一个物化缓存；没有装包时这一面根本不存在）。
  const roomDataFace = roomAssets ? (digest) => roomAssets.byDigest(digest) : null;
  // 上游 0.3.0 的插件流水线（DESIGN §34.6）：服务端主人的策略（plugins/config.json）·「带玩法插件的内容集」
  // （服务在 /cs/<cs16>/…）· 房间级那一层把前两者合起来 · 以及「有玩法插件的房间真的跑在哪个宿主里」。
  // 视觉集（DESIGN §34 P1a）与它同源：一套 cosmetic 插件合成的那个集合，服务在 /vs/ 与 /p/。
  const visual = createVisualSets({ registry: packs, log });
  const policy = createPluginPolicy({ pluginsDir, log });
  const contents = createContentSets({ registry: packs, vanillaData: data, log, maxSets: () => policy.get().maxSets });
  const roomSets = createRoomSets({ registry: packs, visual, contents, policy });
  // 一个内容集一个子进程；SP_MATCH_HOST=worker 改成 worker 线程（match/host/index.js 的文件头说明了取舍：
  // worker 线程里一次 out-of-memory 会带走整个服务器，所以缺省是子进程）。
  const matchHostTransport = String(process.env.SP_MATCH_HOST || '').trim().toLowerCase() === 'worker' ? 'worker' : 'process';
  const hosts = createMatchHosts({ contents, log, options: { transport: matchHostTransport, maxWorkers: Math.max(1, policy.get().maxSets), ...(opts.matchHost || {}) } });
  const versionCfg = versionsFrom(opts, log);
  const versions = createVersionSets({ enabled: versionCfg.enabled, defaultId: versionCfg.default, dataDir, vanilla: content, defaultData: data, log });
  // (the test options of matchHost apply to both pools, but never the version pool's kind or its own SP_MAX_VERSION_HOSTS)
  const versionHosts = versions.nonDefault.length
    ? createMatchHosts({ contents: versions, log, options: { transport: matchHostTransport, ...(opts.matchHost || {}), kind: 'version', maxWorkers: Math.max(1, versionCfg.maxHosts) } })
    : null;
  log.info(`[versions] enabled: ${versions.ids.map((id) => `${id} (${/** @type {any} */ (versionById(id)).label}${id === versions.defaultId ? ', default' : ''})`).join(', ')}`);
  const simPool = createRoomWorkerPool({ data });
  // Main-thread event-loop delay sampling (server/health/eventLoop.js): opt-in with SP_LOOP_SAMPLE=1, no worker pool involved, and a
  // LOCAL log line per window (`[loop] p50=… p95=… p99=… max=… cpu=… mem=… rooms=… humans=… phase=…`) — deliberately not
  // part of /healthz. This is what tells an operator whether a stall is the rehearsal / battle slice or something else.
  const eventLoop = createEventLoopMonitor({
    log,
    windowMs: opts.loopSample?.windowMs,
    counts: () => {
      const s = lobby.stats();
      const phases = new Set();
      let rehearsals = 0;
      for (const room of lobby.rooms.values()) {
        if (room.match?.phase) phases.add(room.match.phase);
        rehearsals += room.match?._rehearsalTasks?.size || 0;
      }
      return { rooms: s.rooms, matches: s.matches, humans: s.humans, spectators: s.spectators,
        phase: [...phases].sort().join('+') || 'idle', rehearsals };
    },
  });
  const workshopAssets = workshopAssetsFor(workshopLoaded, workshopDir);
  // 包声明的只读路由（`pack.json.routes`, DESIGN §28.13）：绝对路径 → 包内 `.json`，带声明的 `Cache-Control`。
  // `mount` 让「核心先吃」这条判据（DESIGN §28.35）读到**真正的**核心挂载目录：与 createStaticHandler 那份同一组
  // 目录（`coreMounts` 是它们共同的来源），所以一条声明会不会顶掉引擎自己的文件，判的就是引擎自己读的那个文件。
  const workshopRoutes = workshopRoutesFor(workshopLoaded, workshopDir, {
    log,
    mount: coreMounts({ publicDir, dataDir, sharedDir, simDir }),
  }).routes;
  // C 层注册点（`pack.json.client.panels`, DESIGN §28.8）：面板清单（随 `welcome` 推到客户端）与这些模块的服务表。
  // 没有包声明 `client` 时两者都是空的，`welcome` 不多一个字段、`/workshop-panels/` 不服务任何东西。
  const workshopPanels = loadWorkshopPanels(workshopLoaded, { log });
  const workshopPanelFiles = workshopPanelFilesFor(workshopPanels.panels, workshopDir);
  // 包写的主题变量（`pack.json.client.theme.vars`, 业主裁决 2026-10-10）：合并成**一份** `{ vars }`，随 `welcome` 送到
  // 客户端。没有包声明主题时是 `null` ⇒ `welcome` 里没有这个字段、页面不多一条自定义属性（与 `modPanels` 同一条不变量）。
  const workshopTheme = workshopThemeFor(workshopLoaded, { log });
  // 资源容器与清单（`pack.json.assets`, DESIGN §28.13）：两个注册 URL → 包内的那两个文件。容器的 sha256 是装载期
  // 已经校验过的那个（`assetsIssues` 随包带出来），服务时只进 HTTP 头、不重算。没有包声明 `assets` 时这张表是空
  // 的，`/workshop-resources/` 一个字节都不服务、也没有任何 412 策略生效。
  const workshopResourceFiles = workshopResourceFilesFor(workshopLoaded.packs, workshopDir, {
    digests: new Map((workshopLoaded.packs || []).filter((p) => p && p.assetsDigest).map((p) => [p.id, p.assetsDigest])),
  });
  // 声明清单（`welcome.modAssets`, DESIGN §28.13.5）：容器/清单的注册 URL、装载期核对过的容器摘要、以及两个归一化
  // 后的策略值。没有包声明 `assets` 时它是**空数组** ⇒ `welcome` 里没有这个字段、客户端不 import 资源流程、
  // 不注册 SW、不多一个请求（B2/B3a 同一条不变量）。
  const workshopModAssets = workshopModAssetsFrom(workshopResourceFiles, workshopLoaded.packs);
  // 包给**已有语种**补的词条（`pack.json.i18n`, fanpack G-04, docs/WORKSHOP.md §1.10）：`/i18n/<code>.json` 的合并体。
  // 没有包声明 `i18n` 时这是一张空表 ⇒ 请求落到普通静态路径，`public/i18n/*.json` 逐字节照旧送出。
  const workshopI18n = buildWorkshopI18nFiles(workshopLoaded, { log });
  // `serverPolicy` 只有 `cache-only` 一种取值会改变行为，而它**只在包显式声明时**生效（缺省 `serve` = 今天逐字节
  // 不变）。策略覆盖的是 `/assets/` 与 `/fonts/` 这两棵**全服务器共用**的树，所以是进程级的：一个包声明它，就是
  // 全服务器都不再服务那两棵树 —— 这件事必须在启动日志里说出来（`resourceServerPolicy` 负责）。
  const resourcePolicy = resourceServerPolicy(
    new Map((workshopLoaded.packs || []).filter((p) => p && p.assets).map((p) => [p.id, p.assets.serverPolicy])),
    { log },
  );
  // 声明式传输配置（`pack.json.server.transport`, DESIGN §28.30）：与 `resourcePolicy` 逐字同一条先例 —— 读声明、
  // 收敛成**一个进程级**的值（`perMessageDeflate` 是 `WebSocketServer` 的构造选项，不是某个房间的属性）、启动日志
  // 点名生效值。没有任何包声明时是 `false`（B 段之前那一个 wss，逐字节不变）。包**只能声明**，绝不能注入代码改
  // `wss`（业主裁决：声明式足够就不做）。
  const transport = transportPolicy(
    new Map((workshopLoaded.packs || []).filter((p) => p && p.server && p.server.transport).map((p) => [p.id, p.server.transport])),
    { log },
  );
  // 客户端 mod 本地缓存 (W-C): the catalogue a browser downloads to decide what it is missing. Built from the SAME
  // `workshopLoaded` that produced `workshopMods` above — which is the **裁剪后**的那一份（B4 段把装不上钩子的包移出了
  // 已加载集合），所以「不在身份清单里的包」也不会出现在目录里。Empty on a plain install, and then the two /mods
  // routes answer `{ packs: [] }` / 404 and nothing else.
  const modsJson = createModsRoute(workshopLoaded, buildModCatalog(workshopLoaded));
  // 包声明服务端模块时，它可以给对局套一层 `MatchClass` 包装器（`uses: ['matchClass']`，DESIGN §28.14）。按**包 id**
  // 次序层层套上（`mountServerModules` 已经排过序），任何一层抛异常或返回非函数都只记日志并跳过那一层 ——
  // 一个包不该让服务器起不来。没有包声明时 `MatchClass` 就是原来的那一个（连字段都不多传）。
  const matchWrappers = modMount.matchClassWrappers();
  // 包声明的动态只读端点（`server.modules[*].uses` 含 `route`，DESIGN §28.32）：解析成一张 `Map<路径, 登记项>`，
  // 空 Map = 没有包声明它 ⇒ `createStaticHandler` 那一段整块跳过（干净安装逐字节不变）。启动日志点名每一条挂上的
  // 路径（与 `resourcePolicy` / `transportPolicy` 同一条「生效值必须被说出来」的纪律）。
  const modRoutes = modMount.routes();
  let MatchClass = opts.MatchClass;
  if (matchWrappers.length) {
    let base = MatchClass || DefaultMatch;
    for (const w of matchWrappers) {
      try {
        const next = w.fn(base);
        if (typeof next !== 'function') {
          log.warn(`[workshop] ${w.pack}/${w.id}: matchClass(...) returned ${typeof next}, not a class — that layer is skipped`);
          continue;
        }
        // 「声明了 channels 却没有接收方法」是这一层最讨厌的形态（装了但没反应），所以点名一次 —— 但**不拒绝**：
        // 方法可以挂在实例上（构造器里），静态看不出来，拒绝会误伤合法写法（DESIGN §28.23）。
        const declaredChannels = (serverModulesLive.find((m) => m.pack === w.pack && m.id === w.id) || {}).channels || [];
        if (declaredChannels.length && typeof next.prototype?.handlePackMsg !== 'function') {
          log.warn(`[workshop] ${w.pack}/${w.id}: declares server channels (${declaredChannels.join(', ')}) but its MatchClass layer has no handlePackMsg method — those messages will only be relayed (DESIGN §28.23)`);
        }
        base = next;
      } catch (e) {
        log.warn(`[workshop] ${w.pack}/${w.id}: matchClass(...) threw (${e && e.message ? e.message : e}) — that layer is skipped`);
      }
    }
    MatchClass = base;
  }
  const { registry, lobby, network } = createSessionStack(
    {
      ...opts,
      // 账号与战绩：`accounts: null` 时 `Network` / `Lobby` 都走各自那条「没有这个功能」的分支。
      accounts,
      records,
      ...(matchWrappers.length ? { MatchClass } : {}),
      workshop: { kits: workshopKits.kits, tokenKits: workshopKits.tokenKits, modules: workshopKits.modules, kitOwners: workshopKits.owners, tokenKitOwners: workshopKits.tokenOwners, kitBudgets: workshopKits.budgets, mods: workshopMods, hooks: workshopHooks.hooks, panels: workshopPanels.panels, assets: workshopModAssets, theme: workshopTheme.theme, meta: metaModules, roomAssets, battle: battleModules, battleInstallers, roomHooks: roomInstallers, transport: transport.transport, serverChannels: serverChannelMap },
    },
    { data, log, content, plugins: roomSets, hosts, versions, versionHosts, simPool },
  );
  // the content hashes of the art (built in the background once listening) and the manifests served with them
  const indexOptions = assetIndexOptionsFrom(opts, publicDir);
  const assetIndex = indexOptions ? createAssetIndex({ publicDir, log, ...indexOptions }) : null;
  const views = assetIndex ? createManifestViews({ dataDir, index: assetIndex, log }) : null;
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, simDir, packsDir, pluginsDir, packs, content, log, workshopJson, workshopKitFiles, workshopKitDirs, workshopPanelFiles, workshopAssets, workshopRoutes, workshopResourceFiles, resourcePolicy, workshopI18n, modsJson, roomData: roomDataFace, workshopBattleFiles, modRoutes, voiceCdn: voiceCdn.overrides, assetIndex, views, visual, contents, versions });
  // 插件工坊（DESIGN §34.9）：它自己的页面与 API，只对本机与本地网开放（路由层另一道门）。它只在被用到之后才
  // 盯 plugins/（热重载），而「房主是作者或独自一人」的房间自己跟随插件的改动。`studio: false` 关掉它。
  const studio = opts.studio === false ? null : createStudio({ publicDir, pluginsDir, dataDir, registry: packs, lobby, sessions: registry, log, fetch: opts.fetch });
  // 可信插件脚本的运行器（上游 0.3.0）：它只在**绑到的地址确实允许**时才留着（见下面 bind 之后的 trustedHostAllowed）。
  const trustedRuntime = await createTrustedRuntime({ registry: packs, log });
  lobby.trustedRuntime = trustedRuntime;
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag(ROOT, { servedVersionDirs: versions.servedDirs() });

  const traffic = createTrafficCounter();
  const server = http.createServer(createRequestHandler({ serveStatic, csp: process.env.SP_CSP === 'off' ? null : siteCsp(publicDir), health: { startedAt, network, registry, lobby, modHealth: () => modMount.healthz(), content, traffic, assetIndex, views, trusted: trustedRuntime?.health, versions, versionHosts }, log,
    records, accounts,
    httpLanes: opts.httpLanes, publicDir, trustProxy: network.opts.trustProxy,
    studio, trustedRuntime,
    modsCatalog: (req, res) => serveMods(req, res, MODS_CATALOG_URL, '', modsJson) }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, lanes: opts.wsLanes, perMessageDeflate: transport.perMessageDeflate, traffic });

  // The address actually bound. The default may fall back to IPv4; the returned host and url follow that.
  let boundHost;
  try {
    // A host with IPv6 switched off refuses '::'. Fall back to IPv4 rather than not booting. Only the default is
    // retried: an explicit HOST is literal (server/http/config.js bindCandidates).
    let bound = null;
    let lastError = null;
    const candidates = bindCandidates(host);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.off('listening', onListening); reject(e); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, candidate);
        });
        bound = candidate;
        break;
      } catch (e) {
        lastError = e;
        const retry = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code) && i < candidates.length - 1;
        if (!retry) break;
        log.warn(`[boot] cannot bind ${candidate} (${e.code}) — falling back to IPv4 only`);
      }
    }
    if (bound === null) throw lastError;
    boundHost = bound;
    // Check the kernel's address too: aliases/DNS and bind fallback cannot weaken the owner gate.
    const actual = server.address();
    const scriptHost = actual && typeof actual === 'object' ? actual.address : '';
    packs.setScriptHost(scriptHost);
    if (!trustedHostAllowed(scriptHost, scriptMode)) {
      lobby.trustedRuntime = null;
      await trustedRuntime?.close();
    }
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    hosts.close();
    versionHosts?.close();
    assetIndex?.close();
    studio?.close();
    eventLoop?.close();
    await simPool?.close();
    await trustedRuntime?.close();
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  // 内容哈希索引：**绑上端口之后**才在后台开跑（第一次构建等 ASSET_INDEX_DELAY_MS，只起停一次的测试什么也不读）。
  assetIndex?.start();
  // started only once the server is listening: the first window then reports real counts, not a half-built hall
  eventLoop?.start();

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  // 包的服务端模块的 `onBoot`（DESIGN §28.14）：**绑上端口之后**才跑 —— 「服务起来了」对它们是一句真话，
  // 而**真正绑到的** port / host 也才是这个快照里该有的值（包只能观察，不能设值）。
  // 每个回调单独 try（`mountServerModules.boot` 内部就是这么做的），一个包炸了不影响别的包，也不影响启动。
  modMount.boot(bootConfigSnapshot({ port: actualPort, host: boundHost, stateRoot }));

  const url = `http://${displayHost(boundHost)}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      // 包的服务端模块的 `onShutdown`（例如停机播报 + 快照留档）：与 `onBoot` 同一条，失败只记日志、不阻塞停机。
      try { modMount.shutdown(); } catch (e) { log.error('[shutdown] mod modules', e); }
      // 对局宿主（一个内容集一个子进程 / worker）· 插件工坊 · 可信脚本运行器：与上面两条同一条纪律，
      // 每一件单独 try —— 一件关不掉不该拖住停机。
      try { hosts.close(); } catch (e) { log.error('[shutdown] match hosts', e); }
      try { versionHosts?.close(); } catch (e) { log.error('[shutdown] version hosts', e); }
      // after the lobby: every room is gone, so no rehearsal can still be waiting on a thread
      try { await simPool?.close(); } catch (e) { log.error('[shutdown] simulation pool', e); }
      eventLoop?.close();
      network.close();
      assetIndex?.close();
      studio?.close();
      await trustedRuntime?.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  // `accounts` / `records` 也交出来（两份都是 `null` 时表示没开 `SP_ACCOUNTS`）：运维与测试要能确认
  // 「这个进程到底有没有账号」，而不是靠猜 `hello` 的回复。
  return { port: actualPort, host: boundHost, url, server, wss, lobby, network, registry, packs, content, visual, contents, hosts, versions, versionHosts, accounts, records, traffic, assetIndex, views, studio, eventLoop, simPool, close };
}

export function roomCodeFromArgv(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room-code') {
      const v = argv[i + 1];
      if (v == null || v.startsWith('-') || !v.trim()) throw new RangeError('--room-code needs 4 letters or digits');
      return parseRoomCode(v);
    }
    if (a.startsWith('--room-code=')) {
      const v = a.slice('--room-code='.length);
      if (!v.trim()) throw new RangeError('--room-code needs 4 letters or digits');
      return parseRoomCode(v);
    }
  }
  return null;
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(() => startServer({ roomCode: roomCodeFromArgv() }));
