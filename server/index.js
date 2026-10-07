// server/index.js — process entry & boot (DESIGN §1, §2). Plain node:http + ws, no framework: startServer() below
// wires the modules under server/http/, in this order —
//
//   http/config.js     ROOT, the served directories, the environment (PORT 3000, HOST 0.0.0.0, TRUST_PROXY auto, DEBUG),
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
//   http/boot.js       banner (Local / LAN / tunnel URLs), port-in-use hint, graceful shutdown on SIGINT / SIGTERM
//
// Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
// (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import path from 'node:path';
import { getData, loadData } from './data.js';
import { loadWorkshop, loadWorkshopKits, WORKSHOP_DIR } from './workshop.js';
import { buildWorkshopDataFiles, workshopKitFilesFor, workshopAssetsFor, WORKSHOP_ASSET_PREFIX, WORKSHOP_ASSET_TYPES } from './http/workshop.js';
import { ROOT, listenAddress, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { answerClientError } from './http/common.js';
import { lanUrls, isProcessEntry, runMain } from './http/boot.js';

// The public API of this module (tests and tools import it from here); the code lives in ./http/.
export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
  // 创意工坊 (docs/WORKSHOP.md): the HTTP helpers live in ./http/workshop.js but stay part of this module's API
  buildWorkshopDataFiles, workshopKitFilesFor, workshopAssetsFor, WORKSHOP_ASSET_PREFIX, WORKSHOP_ASSET_TYPES,
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
  // A caller that names a data dir OR a workshop root must get a FRESH load: `getData` is a process-wide singleton whose
  // first caller wins, and something in the import graph may already have created it with the default workshop/ — which
  // is exactly why SP_WORKSHOP has to take the loadData() branch, or the 试玩 subprocess would silently read the wrong
  // (empty) pack root.
  const data = (opts.dataDir || opts.workshopDir !== undefined || envWorkshop)
    ? loadData(dataDir, { log, workshopDir })
    : getData({ dir: dataDir, log, workshopDir });
  // 创意工坊 (docs/WORKSHOP.md): load the packs ONCE and derive the three things the runtime needs —
  //   * workshopJson      the /data files the browser must receive merged instead of the on-disk originals;
  //   * workshopKits.kits the behaviour layer (a per-battle kit map) for battles the server itself runs;
  //   * workshopKitFiles  the URLs serving those same kit modules to the browser, which must rebuild the identical map,
  //                       or its client-simulated battle would disagree with the server's verification.
  const workshopLoaded = loadWorkshop(workshopDir, { log });
  const workshopJson = buildWorkshopDataFiles(data, workshopLoaded);
  const workshopKits = await loadWorkshopKits(workshopLoaded, { log, knownIds: new Set(Object.keys(data.chess || {})) });
  const workshopKitFiles = workshopKitFilesFor(workshopKits.modules, workshopDir);
  const workshopAssets = workshopAssetsFor(workshopLoaded, workshopDir);
  const { registry, lobby, network } = createSessionStack(
    { ...opts, workshop: { kits: workshopKits.kits, modules: workshopKits.modules } },
    { data, log },
  );
  // content packs (docs/PACKS.md): scanned now — the start log names them — and again whenever their folders change
  const packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log });
  packs.refresh(true);
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log, workshopJson, workshopKitFiles, workshopAssets });
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  const server = http.createServer(createRequestHandler({ serveStatic, health: { startedAt, network, registry, lobby }, log }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log });

  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
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

  return { port: actualPort, host, url, server, wss, lobby, network, registry, packs, close };
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(startServer);
