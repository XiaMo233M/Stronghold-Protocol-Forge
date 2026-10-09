// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST '::' dual-stack, TRUST_PROXY auto, DEBUG),
//                      which startServer() options go to net.js / lobby.js, the console logger
//   http/websocket.js  session wiring (SessionRegistry → Lobby → Network) and the WebSocket at /ws (maxPayload 64 KB;
//                      refused at upgrade with 404 / 429 per network / 503)
//   http/static.js     the static mounts (/ → public/, /data/, /shared/, /sim/ `.js` only), the /data.js browser stand-in,
//                      the content packs (/packs/index.json, /packs/<id>/<file> — the registry is packs.js)
//   http/media.js      /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 (audio addressed without its extension)
//   http/files.js      one file → response: MIME, gzip + memory cache, ETag / Last-Modified / 304, Cache-Control, ranges
//   http/buildTag.js   the build tag of the served browser runtime (/healthz `build`, public/js/ui/buildGuard.js)
//   http/routes.js     the request listener: security headers, 414 / 400 / 405, GET /healthz → JSON status, else static
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
import { loadWorkshop, loadWorkshopKits, loadWorkshopHooks, loadWorkshopPanels, workshopThemeFor, dropUnavailablePreDispatchPacks, WORKSHOP_DIR } from './workshop.js';
import { loadMetaModules } from './match/metaPack.js';
import { loadBattleInstallers } from './battlePack.js';
import { loadServerModules, mountServerModules, stateRootFor } from './modModules.js';
import { workshopNotices } from './notices.js';
import { createRoomAssets } from './roomAssets.js';
import { Match as DefaultMatch } from './match/Match.js';
import {
  buildWorkshopDataFiles, workshopKitFilesFor, workshopPanelFilesFor, workshopAssetsFor, workshopRoutesFor,
  workshopResourceFilesFor, workshopModAssetsFrom, buildWorkshopI18nFiles, resourceServerPolicy, WORKSHOP_ASSET_PREFIX, WORKSHOP_ASSET_TYPES, workshopBattleFilesFor,
} from './http/workshop.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { createModsRoute, serveMods, MODS_CATALOG_URL, MOD_FILE_PREFIX } from './http/mods.js';
import { buildModCatalog } from './modCatalog.js';
import { answerClientError } from './http/common.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
  // 创意工坊 (docs/WORKSHOP.md): the HTTP helpers live in ./http/workshop.js but stay part of this module's API
  buildWorkshopDataFiles, workshopKitFilesFor, workshopPanelFilesFor, workshopAssetsFor, workshopRoutesFor,
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
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPackRegistry>,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);

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
  const loadedOnce = loadWorkshop(workshopDir, { log });
  const workshopHooks = await loadWorkshopHooks(loadedOnce, { log });
  // 包声明的**对局元注册表**模块（`pack.json.server.meta`, DESIGN §29，B 段）：与钩子同一条纪律 —— 声明了却装不上
  //（源码里带非确定性的东西、没有 `registerMeta` 导出、import 失败）的包**整包移出已加载集合**，而不是「包照旧
  // 加载、只是它的效果不在」。所以它必须在**数据叠加层之前**跑完，与钩子合在同一个裁剪点上。
  const workshopMeta = await loadMetaModules(loadedOnce, { log });
  // 包的**服务端模块**（`server.modules`, DESIGN §28.14）：与上面两条同一个裁剪点 —— 模块文件不在、import 失败、
  // 没有 `registerServer`、或者它挂了一个自己没声明的挂载点，都让**这个包**整份移出已加载集合。
  const serverModules = await loadServerModules(loadedOnce, { log, stateRoot: stateRootFor(ROOT) });
  // 包声明的**战斗逻辑**模块（`pack.json.server.battle`, DESIGN §28.17）：与上面三条同一个裁剪点 —— 源码里带非确定性
  // 的东西、import 越界、没有 `install` 导出、模块文件不在，都让**这个包**整份移出已加载集合。
  const battlePack = await loadBattleInstallers(loadedOnce, { log });
  const pruned = dropUnavailablePreDispatchPacks(loadedOnce, [...workshopHooks.errors, ...workshopMeta.errors, ...serverModules.errors, ...battlePack.errors]);
  if (pruned.removed.length) {
    log.warn(`[workshop] dropped ${pruned.removed.length} pack(s) whose declared server-side payload cannot be installed: `
      + pruned.removed.map((r) => `"${r.pack}" (${r.code})`).join(', '));
  }
  // 裁剪之后才有「这一版到底装了哪些包」：被别的声明裁掉的包**也不该**留下它的 meta 处理器或服务端模块
  // （否则一个装不上的包会继续在对局里 / 在 /healthz 上说话）。
  const survivors = new Set(pruned.packs.map((p) => p.id));
  const metaModules = workshopMeta.modules.filter((m) => survivors.has(m.id));
  const serverModulesLive = serverModules.modules.filter((m) => survivors.has(m.pack));
  // 战斗逻辑同理：被别的声明裁掉的包不该继续在战场里说话（它的 installer 与 URL 清单一起消失）。
  const battleInstallers = battlePack.installers.filter((m) => survivors.has(m.id));
  const battleModules = battlePack.modules.filter((m) => survivors.has(m.pack));
  const modMount = mountServerModules(serverModulesLive, { log });
  const excludedPacks = new Set(pruned.removed.map((r) => r.pack));
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
  const workshopLoaded = { ...loadedOnce, packs: pruned.packs, errors: pruned.errors };
  const workshopJson = buildWorkshopDataFiles(data, workshopLoaded);
  // 公告 / 鸣谢的合并体（DESIGN §28.15）：引擎那一半**从更新记录生成**（单一事实源，不手写第二份），包那一半按
  // 包 id 追加。它走**既有的**合并数据通道送出（`/data/notices.json`，map 的键是 `notices`），所以既没有新路由、
  // 也没有新的静态路径；`data/notices.json` 本来就不存在，所以这纯属新增。
  const notices = workshopNotices(workshopLoaded, { changelogPath: path.join(ROOT, 'CHANGELOG.md'), log });
  workshopJson.set('notices', Buffer.from(JSON.stringify(notices.body), 'utf8'));
  const workshopKits = await loadWorkshopKits(workshopLoaded, { log, knownIds: new Set(Object.keys(data.chess || {})) });
  // The mod set (DESIGN §28.2): one identity per pack, one digest for the whole set. It travels in `welcome`, in
  // `/healthz` (lobby.stats) and in every BattleSpec, so the three can never disagree about what is running.
  const workshopMods = (workshopLoaded.packs || []).map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }));
  const workshopKitFiles = workshopKitFilesFor(workshopKits.modules, workshopDir);
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
      modules: workshopKits.modules,
      log,
    })
    : null;
  // `/room-data/<摘要>/<文件>.json` 那一面（同一个物化缓存；没有装包时这一面根本不存在）。
  const roomDataFace = roomAssets ? (digest) => roomAssets.byDigest(digest) : null;
  const workshopAssets = workshopAssetsFor(workshopLoaded, workshopDir);
  // 包声明的只读路由（`pack.json.routes`, DESIGN §28.13）：绝对路径 → 包内 `.json`，带声明的 `Cache-Control`。
  const workshopRoutes = workshopRoutesFor(workshopLoaded, workshopDir, { log }).routes;
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
  // 客户端 mod 本地缓存 (W-C): the catalogue a browser downloads to decide what it is missing. Built from the SAME
  // `workshopLoaded` that produced `workshopMods` above — which is the **裁剪后**的那一份（B4 段把装不上钩子的包移出了
  // 已加载集合），所以「不在身份清单里的包」也不会出现在目录里。Empty on a plain install, and then the two /mods
  // routes answer `{ packs: [] }` / 404 and nothing else.
  const modsJson = createModsRoute(workshopLoaded, buildModCatalog(workshopLoaded));
  // 包声明服务端模块时，它可以给对局套一层 `MatchClass` 包装器（`uses: ['matchClass']`，DESIGN §28.14）。按**包 id**
  // 次序层层套上（`mountServerModules` 已经排过序），任何一层抛异常或返回非函数都只记日志并跳过那一层 ——
  // 一个包不该让服务器起不来。没有包声明时 `MatchClass` 就是原来的那一个（连字段都不多传）。
  const matchWrappers = modMount.matchClassWrappers();
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
      ...(matchWrappers.length ? { MatchClass } : {}),
      workshop: { kits: workshopKits.kits, modules: workshopKits.modules, mods: workshopMods, hooks: workshopHooks.hooks, panels: workshopPanels.panels, assets: workshopModAssets, theme: workshopTheme.theme, meta: metaModules, roomAssets, battle: battleModules, battleInstallers },
    },
    { data, log },
  );
  // content packs (docs/PACKS.md): scanned now — the start log names them — and again whenever their folders change
  const packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log });
  packs.refresh(true);
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log, workshopJson, workshopKitFiles, workshopPanelFiles, workshopAssets, workshopRoutes, workshopResourceFiles, resourcePolicy, workshopI18n, modsJson, roomData: roomDataFace, workshopBattleFiles });
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  const server = http.createServer(createRequestHandler({ serveStatic, health: { startedAt, network, registry, lobby, modHealth: () => modMount.healthz() }, log,
    modsCatalog: (req, res) => serveMods(req, res, MODS_CATALOG_URL, '', modsJson) }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log });

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
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));
  // 包的服务端模块的 `onBoot`（DESIGN §28.14）：**绑上端口之后**才跑 —— 「服务起来了」对它们是一句真话。
  // 每个回调单独 try（`mountServerModules.boot` 内部就是这么做的），一个包炸了不影响别的包，也不影响启动。
  modMount.boot();

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${displayHost(boundHost)}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      // 包的服务端模块的 `onShutdown`（例如停机播报 + 快照留档）：与 `onBoot` 同一条，失败只记日志、不阻塞停机。
      try { modMount.shutdown(); } catch (e) { log.error('[shutdown] mod modules', e); }
      network.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host: boundHost, url, server, wss, lobby, network, registry, packs, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(startServer);
