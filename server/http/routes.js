// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * GET /api/records/<CODE> → the latest finished match of that 4-letter room code;
//   * GET /api/records/account/<NAME> → that account's OWN row from its latest finished match (name → playerId → row);
//     404 when the server runs without accounts (`SP_ACCOUNTS` unset) — an absent feature, not an empty one;
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.
//
// ## What these two routes are allowed to say (业主裁令)
// **Both are read-only and unauthenticated**, and neither reveals more than the caller already proved it knows:
//
//   * `/api/records/<CODE>` — the PUBLIC view: per player, a seat number and whether it is the caller's own seat.
//     Nicknames, bond layers and the per-round purchase ledger are **not** here. The room code is therefore *not* a
//     secret and this file does not pretend it is: anyone who knows 4 letters gets 4 seat numbers.
//   * `/api/records/account/<NAME>` — **only the named account's own row**, never a teammate's nickname and never the
//     purchase ledger (server/matchRecords.js `ownAccountSummary`). The account name is the queried key, so this
//     endpoint is deliberately **narrower than the owner's own view**: the full ledger for yourself arrives over the
//     authenticated `records.mine` message, not here.
//
// Both are rate-limited per remote address (below), and the account name is matched through the SAME key as login —
// NFC-normalised, lower-cased, **exact** — so there is no prefix or fuzzy search to walk a name space with. An unknown
// account and a known account with no finished match answer **identically** (404 + the same body): telling those two
// apart would make this endpoint an account-existence probe.
//
// ## There is deliberately no write route
// The submission that proposed this feature shipped `POST /api/account/password` guarded by a shared `SP_ADMIN_TOKEN`.
// That route is **not implemented here**: a site-wide admin secret shared with a chat bot is not a player's password,
// and "change a password knowing only the account name" would make the old password decorative. Password changes are
// an operator action on the account file until a per-account reset-ticket design exists (docs/RECORDS.md §5).

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { MODS_CATALOG_URL } from './mods.js';
import { VIEW } from '../matchRecords.js';
import { TokenBucket } from '../net.js';

const MAX_URL_LENGTH = 4096;
/** 账号名按**码点**算长度（`[...s].length`），与昵称那条 `NAME_MAX_LEN` 是同一条思路；这里只防一条超长 URL。 */
const ACCOUNT_NAME_MAX = 64;
const ACCOUNT_PATH_RE = /^\/api\/records\/account\/([^/]{1,256})$/;
/**
 * 房间号：`server/lobby.js` 的 `CODE_ALPHABET`（无 I / O）**只生成大写**，所以这里大小写不敏感地**归一到大写**再查
 * —— 手打小写的人不该得到一个「没有这个房间」的空答复，而 `latestRoom` 也只认大写。
 */
const ROOM_CODE_PATH_RE = /^\/api\/records\/([A-HJ-NP-Za-hj-np-z]{4})$/;
/**
 * 这两条只读路由的限流：**每客户端地址**一只桶，照 `server/net.js` 的既有做法（`TokenBucket`）。
 *
 * 为什么 HTTP 面也要限流：`server/net.js` 的桶只保护 WebSocket 帧，而这两条路由**不需要会话**就能打 —— 没有桶
 * 的话，一个循环就能把服务端拖进「每次请求都遍历索引 + 序列化一份记录」里，而 `/account/<NAME>` 还会被拿来
 * **枚举账号名**。1/s 重填 + 10 突发对「人点按钮」绰绰有余（客户端一条 `records.mine` 走 WebSocket，根本不碰
 * 这两条），对扫名字则很紧。
 *
 * **已知边界**（明写，不假装）：键取 `req.socket.remoteAddress`。直接暴露在公网时它不可伪造；但若前面挂了反向
 * 代理且没在代理侧限流，所有人会共用一个地址、共享同一只桶（宁可漏限流也不按可伪造的 `X-Forwarded-For` 分桶
 * —— 后者会让攻击者换一个头就重置额度）。运维文档里要写「代理后面请自行限流」。
 */
const RECORDS_RATE_PER_SEC = 1;
const RECORDS_RATE_BURST = 10;
/** 空闲多久回收一只桶（与 `net.js` sweep 同一条思路：不做的话这张表本身会随着见过的地址一直长）。 */
const RECORDS_BUCKET_IDLE_MS = 10 * 60_000;

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
 *           records?: import('../matchRecords.js').MatchRecords|null,
 *           accounts?: import('../accounts.js').AccountStore|null,
 *           modsCatalog?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, records = null, accounts = null, modsCatalog }) {
  /** @type {Map<string, TokenBucket>} 客户端地址 → 只读战绩路由的桶（见文件头那条「已知边界」） */
  const recordBuckets = new Map();

  /**
   * 这两条只读路由的准入。true = 放行。超限回 429（带 `Retry-After`），而不是静默降级成空结果 —— 客户端/机器人
   * 要能分辨「限流了」与「没有这条记录」。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function admitRecordRead(req, res) {
    const key = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
    const now = Date.now();
    let bucket = recordBuckets.get(key);
    if (!bucket) { bucket = new TokenBucket(RECORDS_RATE_PER_SEC, RECORDS_RATE_BURST, now); recordBuckets.set(key, bucket); }
    if (bucket.take(now)) {
      // 顺手回收空闲桶（这张表本身也该有界）；只在放行路径上扫，代价摊在正常请求里。
      if (recordBuckets.size > 1) {
        for (const [other, b] of recordBuckets) if (other !== key && now - b.at > RECORDS_BUCKET_IDLE_MS) recordBuckets.delete(other);
      }
      return true;
    }
    res.setHeader('Retry-After', '1');
    sendJson(req, res, 429, { error: 'RATE' });
    return false;
  }

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
    // 账号名规则**先**判：它与房间号规则共用 `/api/records/` 前缀，而账号名不一定是 4 个字母。
    // 没有账号的服务器上这里回 404 —— 「功能不存在」与「这个账号没打过」是两件事，不该用同一个码回答。
    const accountPath = ACCOUNT_PATH_RE.exec(parts.rawPath);
    if (accountPath) {
      if (!records || !accounts) { sendJson(req, res, 404, { error: 'NOT_ENABLED' }); return; }
      let name;
      try { name = decodeURIComponent(accountPath[1]); } catch { sendJson(req, res, 400, { error: 'BAD_REQUEST' }); return; }
      // 「这个名字太长」与「没有这个账号」必须同答复：分开就成了存在性/长度探针。
      if ([...name].length > ACCOUNT_NAME_MAX) { sendJson(req, res, 404, { error: 'RECORD_NOT_FOUND' }); return; }
      if (!admitRecordRead(req, res)) return;
      // 形状收窄在 `matchRecords.latestByAccount` 里：只回**被查账号本人**那一行，且不含购卡明细。
      const record = records.latestByAccount(accounts, name);
      res.setHeader('Cache-Control', 'no-store');
      sendJson(req, res, record ? 200 : 404, record || { error: 'RECORD_NOT_FOUND' });
      return;
    }
    const recordPath = ROOM_CODE_PATH_RE.exec(parts.rawPath);
    if (recordPath) {
      if (!records) { sendJson(req, res, 404, { error: 'NOT_ENABLED' }); return; }
      if (!admitRecordRead(req, res)) return;
      const record = records.latestRoom(recordPath[1].toUpperCase(), VIEW.PUBLIC);
      res.setHeader('Cache-Control', 'no-store');
      sendJson(req, res, record ? 200 : 404, record || { error: 'RECORD_NOT_FOUND' });
      return;
    }
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
