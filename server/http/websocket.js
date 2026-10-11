// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, per-message deflate OFF unless a pack declares
//     `pack.json.server.transport` (DESIGN §28.30 — declarative only: a pack never injects server code to change the
//     socket) → Network.handleConnection. Refused at the upgrade: any other path 404; per-network socket limit for
//     internet clients (maxConnectionsPerAddr, see net.js clientAddress; local/LAN peers are exempt) 429; server full
//     (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { createModDispatch } from '../modDispatch.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

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
 *   * **没有任何包声明 ⇒ `perMessageDeflate: false`**，与 B 段之前逐字节相同（这是缺省，也是绝大多数安装）；
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
    return {
      perMessageDeflate: false,
      transport: { deflate: false, params: null, maxPayload: WS_MAX_PAYLOAD, threshold: null },
    };
  }
  const [winnerId, winner] = entries[0];
  for (const [id] of entries.slice(1)) {
    log?.warn?.(`[workshop] server.transport declared by "${id}" is ignored: "${winnerId}" declares it too and the smaller pack id wins (DESIGN §28.3)`);
  }
  if (winner.deflate !== true) {
    log?.info?.(`[workshop] server.transport: "${winnerId}" declares deflate: false — per-message deflate stays off (that is also the engine default; the declaration is named so the choice is visible)`);
    return {
      perMessageDeflate: false,
      transport: { deflate: false, params: null, maxPayload: WS_MAX_PAYLOAD, threshold: null },
    };
  }
  /** 只把**声明过**的键交给 `ws`：省掉的字段用库自己的缺省（引擎不抄第二份）。 */
  /** @type {Record<string, any>} */
  const perMessageDeflate = {};
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
  const threshold = winner.threshold === undefined ? WS_DEFLATE_LIBRARY_THRESHOLD : winner.threshold;
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
export function createSessionStack(opts, { data, log }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  const lobby = new Lobby({
    registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions,
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
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, perMessageDeflate?: false|object }} deps
 *   `perMessageDeflate` 来自 `transportPolicy(...)`（`pack.json.server.transport`，DESIGN §28.30）。缺省 `false`：
 *   没有包声明它就是 B 段之前那一个 `WebSocketServer`，逐字节不变。
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, perMessageDeflate = false }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
