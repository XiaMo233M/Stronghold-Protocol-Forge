// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { MODS_CATALOG_URL } from './mods.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 *
 * `modHealth`（可选）是包的服务端模块贡献的字段（DESIGN §28.14）：一个**函数**（每次请求现算，因为那三件要报的是
 * 内存 / 循环延迟 / 归档标签这类实时值）或一个现成的对象。返回空对象时**不加这个键** —— 干净安装的 `/healthz`
 * 与从前逐字节相同。**包的摘要**已经在 `lobby.stats()` 里（`mods` / `modPacks`，DESIGN §28.9 第 2 项），所以这里
 * 不重复放一份。
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, modHealth?: (() => Record<string, any>)|null }} health
 */
export function healthReport({ startedAt, network, registry, lobby, modHealth = null }) {
  /** @type {Record<string, any>} */
  const out = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
  let fields = null;
  try {
    fields = typeof modHealth === 'function' ? modHealth() : modHealth;
  } catch {
    fields = null; // 一个包的 healthz 回调炸了不该让运维拿不到 /healthz
  }
  if (fields && typeof fields === 'object' && Object.keys(fields).length) out.modHealth = fields;
  return out;
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object,
 *           modsCatalog?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, modsCatalog }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === MODS_CATALOG_URL && modsCatalog && modsCatalog(req, res)) return;
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, healthReport(health));
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
