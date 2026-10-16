// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, permessage-deflate from 1 KB (WS_DEFLATE — the engine's own default
//     since 0.2.6; the host's lanes and the traffic counters, traffic.js, ride the same listener). A pack may still
//     only DECLARE it off or re-tune it (`pack.json.server.transport`, DESIGN §28.30 — declarative only: a pack never
//     injects server code to change the socket) → Network.handleConnection. Refused at the upgrade: any other path 404;
//     per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js clientAddress; local/LAN peers
//     are exempt) 429; server full (maxConnections) or shutting down 503.
//   * the same upgrade event also answers the host's lane table (DESIGN §28.44, server/http/wsLanes.js): other exact
//     paths the operator registered, each handing the socket to code the operator installed. No lanes (the default,
//     and the only thing a plain `npm start` has) ⇒ /ws accepted and every other path 404, exactly as before.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { createModDispatch } from '../modDispatch.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';
import { validateLanes, resolveLane } from './wsLanes.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/**
 * permessage-deflate (RFC 7692) for the JSON text frames. A message from 1 KB up (m.public, m.private, b.start, welcome
 * …) is compressed on its own — no context is kept from one message to the next (`serverNoContextTakeover`) — with a
 * 2 KB window and zlib memLevel 7, so a connection holds about 72 KB of zlib state; smaller frames (pong, ok) go out
 * as they are. Measured on a solo session (rounds 3–5, the server's own counters, traffic.js): 173 KB of payload →
 * 60 KB on the wire; replaying a session's frames with larger windows gained nothing on these messages. Browsers
 * negotiate it by themselves; a client that offers none gets plain frames. The inflated size of a client frame still
 * counts against WS_MAX_PAYLOAD.
 *
 * 0.2.6 进场（本仓的接法）：这一份是「引擎自己的」压缩参数，也是 `transportPolicy` **没有包声明时的缺省**
 * （`attachWebSocket` 未指定时同样落在这里）。包依旧只能**声明**（`pack.json.server.transport`, DESIGN §28.30）：
 *   * 没有包声明 ⇒ 这一份原样生效（0.2.6 改了缺省：从前是 `perMessageDeflate: false`。理由：这是上游 0.2.6
 *     「服务器流量层」的真实缺省，而流量计数要报的正是「压缩省了多少」；代价：`http://` 的 LAN 地址上浏览器不协商
 *     `br`/`deflate`，那类客户端只多挂一层 zlib 状态，功能与字节不受影响）；
 *   * 包声明 `deflate: true` ⇒ 这一份当**基线**，该包声明过的那几个键盖在上面（`threshold=512` 这类仍然生效）；
 *   * 包声明 `deflate: false` ⇒ **关**（`transportPolicy` 里 `winner.deflate !== true` 那条分支），这是显式关闭的
 *     唯一入口，不许静默回退成「引擎缺省开着」；
 *   * `attachWebSocket` 收到显式 `false` 时同样关（只有 `undefined` 才落回这一份缺省）。
 */
export const WS_DEFLATE = Object.freeze({
  threshold: 1024,
  serverNoContextTakeover: true,
  serverMaxWindowBits: 11,
  zlibDeflateOptions: Object.freeze({ memLevel: 7 }),
});

/**
 * Does every permessage-deflate offer of this `Sec-WebSocket-Extensions` header cap the server window below
 * WS_DEFLATE.serverMaxWindowBits? ws cannot accept such an offer and refuses the whole handshake (400), so the upgrade
 * drops the header instead and the connection goes uncompressed. No browser sends `server_max_window_bits`.
 * @param {string | string[] | undefined} header
 */
export function narrowDeflateOffer(header) {
  if (typeof header !== 'string') return false;
  const offers = header.split(',').map((s) => s.trim()).filter((s) => /^permessage-deflate\b/i.test(s));
  if (!offers.length) return false;
  return offers.every((offer) => {
    const m = /(?:^|;)\s*server_max_window_bits\s*=\s*"?(\d+)"?/i.exec(offer);
    return !!m && Number(m[1]) < WS_DEFLATE.serverMaxWindowBits;
  });
}

/**
 * `ws` 自己的 `perMessageDeflate.threshold` 缺省值（1024）。**只**用在「没声明 threshold」时的诊断文案里 ——
 * 引擎刻意不把库的缺省值抄成自己的配置，抄一份就是第二个会漂的真相。
 */
export const WS_DEFLATE_LIBRARY_THRESHOLD = 1024;

/**
 * 声明式的传输配置（`pack.json.server.transport`，DESIGN §28.30）→ **真正生效的** `perMessageDeflate` 选项。
 *
 * 与 `resourceServerPolicy`（`server/http/workshop.js`）逐字同一条三件套：读声明 → 收敛成**一个进程级**的值 →
 * **启动日志点名**。三条语义：
 *   * **没有任何包声明 ⇒ 引擎自己的 `WS_DEFLATE`**（0.2.6 的缺省：1 KB 起、2 KB 窗口、不保留上下文）。这一格
 *     在我们的树上**改了**：从前缺省是 `perMessageDeflate: false`。理由与代价都写明 —— 上游 0.2.6 把「服务器流量层」
 *     的缺省就是这个，而**包依旧只能声明**（`pack.json.server.transport` 一个字没改，仍然是唯一的声明式入口），
 *     区别只在「没人声明时引擎自己开不开」；
 *   * **多包声明时包 id 小的赢**（DESIGN §28.3），其余每一包**点名**说明它被谁盖住了 —— 一条声明被静默忽略，
 *     正是这一层到处在消灭的形态；
 *   * **返回值里 `transport` 是「生效值」不是我声明了什么**：`deflate` / `threshold` / `params` 全部按**真正交给
 *     `ws` 的那个对象**生成。声明了 `deflate: false` 时 `transport.deflate` 就是 `false`、`threshold` 是 `null`
 *     —— 报声明值会让客户端面板显示一个不存在的压缩。
 * @param {Map<string, object>|Record<string, object>|null} policies 包 id → 归一化后的 `server.transport`
 * @param {{ log?: object|null }} [opts]
 * @returns {{ perMessageDeflate: false|object, transport: { deflate: boolean|null, params: string|null,
 *   maxPayload: number, threshold: number|null } }}
 */
export function transportPolicy(policies, { log = null } = {}) {
  const entries = (policies && typeof policies.entries === 'function'
    ? [...policies.entries()]
    : Object.entries(policies || {}))
    .filter(([id, decl]) => id && decl && typeof decl.deflate === 'boolean')
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!entries.length) {
    // 0.2.6（上游 WS_DEFLATE）：没有人声明时**引擎自己开**这一格。包声明仍然是唯一的入口，只是缺省值从 false 改了。
    return {
      perMessageDeflate: { ...WS_DEFLATE },
      transport: { deflate: true, params: null, maxPayload: WS_MAX_PAYLOAD, threshold: WS_DEFLATE.threshold },
    };
  }
  const [winnerId, winner] = entries[0];
  for (const [id] of entries.slice(1)) {
    log?.warn?.(`[workshop] server.transport declared by "${id}" is ignored: "${winnerId}" declares it too and the smaller pack id wins (DESIGN §28.3)`);
  }
  if (winner.deflate !== true) {
    log?.info?.(`[workshop] server.transport: "${winnerId}" declares deflate: false — per-message deflate stays OFF (the engine default since 0.2.6 is ON, so this declaration is what turns it off; the declaration is named so the choice is visible)`);
    return {
      perMessageDeflate: false,
      transport: { deflate: false, params: null, maxPayload: WS_MAX_PAYLOAD, threshold: null },
    };
  }
  /** 只把**声明过**的键交给 `ws`：省掉的字段用库自己的缺省（引擎不抄第二份）。基线是引擎自己的 WS_DEFLATE
   *  （0.2.6 的调参：1 KB 起、2 KB 窗口、不保留上下文），包声明过的键盖在它上面。 */
  /** @type {Record<string, any>} */
  const perMessageDeflate = { ...WS_DEFLATE };
  /** @type {string[]} */
  const params = [];
  for (const key of ['threshold', 'concurrencyLimit', 'serverMaxWindowBits', 'clientMaxWindowBits', 'serverNoContextTakeover', 'clientNoContextTakeover']) {
    if (winner[key] === undefined) continue;
    perMessageDeflate[key] = winner[key];
    params.push(`${key}=${winner[key]}`);
  }
  if (winner.level !== undefined || winner.memLevel !== undefined) {
    /** @type {Record<string, number>} */
    const zlibDeflateOptions = {};
    if (winner.level !== undefined) { zlibDeflateOptions.level = winner.level; params.push(`level=${winner.level}`); }
    if (winner.memLevel !== undefined) { zlibDeflateOptions.memLevel = winner.memLevel; params.push(`memLevel=${winner.memLevel}`); }
    perMessageDeflate.zlibDeflateOptions = zlibDeflateOptions;
  }
  const threshold = winner.threshold === undefined ? (perMessageDeflate.threshold ?? WS_DEFLATE_LIBRARY_THRESHOLD) : winner.threshold;
  const transport = {
    deflate: true,
    params: params.length ? params.join(' ') : null,
    maxPayload: WS_MAX_PAYLOAD,
    threshold,
  };
  log?.info?.(`[workshop] server.transport: per-message deflate ON by "${winnerId}" (${transport.params || 'ws defaults'}; threshold ${transport.threshold}) — this is a process-wide socket option, so it applies to every client and every pack`);
  return { perMessageDeflate, transport };
}

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object }} deps the game data the lobby's matches use, the logger
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, content = null, plugins = null, hosts = null }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  const lobby = new Lobby({
    registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, content, plugins, hosts, options: lobbyOptions,
    // 对局战绩（docs/RECORDS.md §3）：null = 没有 SP_ACCOUNTS ⇒ 结算点不落盘。
    records: opts.records || null,
    // 创意工坊 (docs/WORKSHOP.md): the behaviour layer of the installed packs travels with every match this lobby starts
    workshop: opts.workshop,
  });
  // 包声明的**分发前钩子**（DESIGN §28.13, server/modDispatch.js）: assembled here, because it needs the framework's
  // own send helper and the Network it belongs to. `send` is late-bound to `network` on purpose — it must be
  // `network.reply` (the send path with the backpressure guards), never a second write path on the raw socket.
  // No pack declares `server.preDispatch` ⇒ `createModDispatch` returns null ⇒ Network gets neither option and its
  // onFrame behaves byte-for-byte as before.
  let network;
  const modDispatch = createModDispatch({
    hooks: opts.workshop && opts.workshop.hooks,
    send: (conn, msg) => network.reply(conn, msg),
    log,
  });
  network = new Network({
    registry, handler: lobby, log,
    // 账号（docs/RECORDS.md §2）：null = 没有 SP_ACCOUNTS ⇒ `hello` 里没有认证那一段，握手逐字节不变。
    accounts: opts.accounts || null,
    options: modDispatch ? { ...netOptions, preDispatch: modDispatch.preDispatch, onConnection: modDispatch.onConnection } : netOptions,
  });
  return { registry, lobby, network };
}
/**
 * Count a socket in the traffic counters (traffic.js): its wire bytes from now until it closes, the payload of every
 * message it sends (ws.send wrapped) and receives.
 * @param {import('ws').WebSocket} ws
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<typeof import('./traffic.js').createTrafficCounter>} traffic
 */
function meterSocket(ws, req, traffic) {
  const socket = req.socket;
  traffic.wsOpen(socket);
  const send = ws.send;
  ws.send = function meteredSend(data, ...rest) {
    traffic.wsSent(data);
    return send.call(this, data, ...rest);
  };
  ws.on('message', (data) => traffic.wsReceived(data));
  ws.once('close', () => traffic.wsClose(socket));
}

/**
 * Serve the WebSocket endpoints on `server` (its 'upgrade' event): the game's own /ws, plus the host's lanes.
 *
 * A lane is a second protocol on the same port and the same listener. It gets no privileges with this change:
 * admission (per-address and server-wide caps, `Network.admission`) runs for a lane exactly as it runs for /ws, so
 * registering a path is not a way to serve more sockets per address, and a lane is never a fallback — a request that
 * does not match a registered path is answered 404, it is not quietly handed to the game.
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, lanes?: readonly import('./wsLanes.js').WsLane[],
 *   perMessageDeflate?: false|object, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>|null }} deps
 *   `perMessageDeflate` 来自 `transportPolicy(...)`（`pack.json.server.transport`, DESIGN §28.30）。**缺省是引擎自己的
 *   `WS_DEFLATE`**（0.2.6 的缺省，与上游 `attachWebSocket` 逐字同一条）；只有**显式 `false`** 才关掉这一格 ——
 *   包的 `server.transport: { deflate: false }` 走的就是这一条。
 *   `lanes` 是宿主的升级路径表（DESIGN §28.44）；缺省没有表 ⇒ 只有 /ws，行为与这一格之前逐字节相同。
 *   `traffic` 是流量计数（traffic.js）；缺省 null ⇒ 不数 socket（`createTrafficCounter` 之外的使用者，例如测试里
 *   那个假 Network）。
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, lanes, perMessageDeflate = undefined, traffic = null }) {
  // 未指定 = 引擎缺省（WS_DEFLATE）；显式 false = 关（包声明 deflate:false / 调用方要求）。
  const deflate = perMessageDeflate === undefined ? { ...WS_DEFLATE } : perMessageDeflate;
  // A bad table is a configuration error, and it fails here — at boot, named — rather than leaving the operator
  // with a lane that answers 404 forever (the silent-revert shape this family has been burned by before).
  const table = validateLanes(lanes ?? []);
  if (table.problems.length) throw new Error(`bad ws lane table: ${table.problems.join('; ')}`);
  if (table.lanes.length) log.info('[ws] lanes: ' + table.lanes.map((l) => `${l.path} (${l.id})`).join(', '));

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: deflate, clientTracking: false });
  wss.on('connection', (ws, req) => {
    if (traffic) meterSocket(ws, req, traffic);
    network.handleConnection(ws, req);
  });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts) { reject(404, 'Not Found'); return; }
    const lane = parts.rawPath === '/ws' ? null : resolveLane(parts.rawPath, table.lanes);
    if (!lane && parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    if (lane) {
      // The lane owns the socket from here. Anything it throws closes that socket and says which lane said it —
      // falling through to /ws would let a client ask for `/duel/lobby` and land in a Stronghold match.
      try { lane.onUpgrade(req, socket, head, { reject, log, lane }); } catch (e) {
        log.error(`[ws] lane ${lane.id} failed`, e);
        socket.destroy();
      }
      return;
    }
    // 一个把服务器窗口压到 WS_DEFLATE 之下的 offer：`ws` 接不了、会拒掉整个握手（400）。丢头 ⇒ 这条连接不压缩，
    // 而不是连不上（上游 0.2.6 的窄 offer 处置，与上面那条 transport 策略并存）。
    if (narrowDeflateOffer(req.headers['sec-websocket-extensions'])) delete req.headers['sec-websocket-extensions'];
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
