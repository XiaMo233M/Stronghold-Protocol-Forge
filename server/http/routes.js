// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`, unless a lane claimed that method for that path;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * GET /api/rooms → 公开房间数，**一个整数，不是列表**（见下「房间目录」）；
//   * GET /api/records/<CODE> → the latest finished match of that 4-letter room code;
//   * GET /api/records/account/<NAME> → that account's OWN row from its latest finished match (name → playerId → row);
//     404 when the server runs without accounts (`SP_ACCOUNTS` unset) — an absent feature, not an empty one;
//   * a path inside a host-registered request lane (DESIGN §28.45, httpLanes.js) → that lane, for a method the lane
//     claimed. No lanes (the default, and the only thing a plain `npm start` has) ⇒ every rule below is exactly as it
//     was: any method but GET / HEAD 405, everything else the static files;
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

// ## 房间目录（公开面）：只报数，不枚举（业主裁令）
// 这一格来自投稿 7ca51de6f346「服务器房间目录与活跃人数」的**收窄**。原投稿要的是 C2S `room.list` + `user.activity`
// 与 S2C `room.list`：整张房间列表，含**房号、房主代号、真人与 AI 人数、在线及近期操作人数、招募状态**，以及加入 /
// 观战入口。**那个形状本批不采纳** —— 它必须先有一整套「公开 / 私有」的房间属性（`room.setInviteOnly`）、一个
// 网络心跳口径（`lastInputAt`）和一套限流，而且会把 4 字母房号变成可枚举的东西（房号进列表就等于公开）。
//
// 业主裁令把它收窄成**一个数**：「我们做成不枚举所有全服房间，我们枚举公开房间数，管理员可以查看所有房间数，
// 这样就行了」。所以公开面**只有** `publicRooms` 一个整数字段，**永远**不回答房号、房主名、人数或任何明细：
// 任何一个这样的字段都能把「数」变成对某一个房间的**侧写**。
//
// 维护口径（`Lobby.roomCounts`）：**今天** `publicRooms` 与 `/healthz` 的 `rooms` **恒等**，因为引擎今天**没有**
// 「公开 / 私有」这个属性（`inviteOnly` 不存在，本批**不预埋**）。「公开房间数」因此暂时就是「房间数」——
// 如实返回同一个计数，而不是假装有一个筛选。solo 房算数（与 `stats().rooms` 同口径）。`inviteOnly` 落地后，
// 改 `Lobby.roomCounts` 一处即可。
//
// **管理员面不在这里**：`/healthz` 的 `rooms` **就是**「全部房间数」（运维口径），无需新端点、无需任何令牌。
// 本批**不引入** `SP_ADMIN_TOKEN` 这类共享管理员秘密（见 routes.js 头部对投稿 `POST /api/account/password` 的
// 拒绝理由，那是同一个东西）。
//
// **本刀不动协议面**：`shared/protocol.js` 的 C2S / S2C 一字不改，`server/net.js` 的 `HEAVY_TYPES` 不加任何东西
// （尤其**不引入** `ACTIVITY_TYPES` / `user.activity` / `lastInputAt`），`PROTOCOL_VERSION` / `MOD_API_VERSION`
// 不抬。将来的 `room.list` 若真要做，HTTP 面与协议面互不干扰。

import { existsSync } from 'node:fs';
import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { MODS_CATALOG_URL } from './mods.js';
import { VIEW } from '../matchRecords.js';
import { TokenBucket } from '../net.js';
import { clientAddress, isLocalIp } from '../net.js';
import { validateHttpLanes, resolveHttpLane } from './httpLanes.js';

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

/** 公开房间数的**唯一**路径（一个数，不是列表）。见文件头「房间目录（公开面）」。 */
export const PUBLIC_ROOMS_URL = '/api/rooms';

/**
 * The GET /healthz body.
 *
 * `modHealth`（可选）是包的服务端模块贡献的字段（DESIGN §28.14）：一个**函数**（每次请求现算，因为那三件要报的是
 * 内存 / 循环延迟 / 归档标签这类实时值）或一个现成的对象。返回空对象时**不加这个键** —— 干净安装的 `/healthz`
 * 与从前逐字节相同。**包的摘要**已经在 `lobby.stats()` 里（`mods` / `modPacks`，DESIGN §28.9 第 2 项），所以这里
 * 不重复放一份。
 *
 * `withTraffic`（`?traffic=1`，只对 loopback / 内网客户端）加上流量计数与内容哈希索引的状态（traffic.js /
 * assetIndex.js / assetViews.js）。
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, modHealth?: (() => Record<string, any>)|null,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null }} health
 * @param {boolean} [withTraffic]
 */
/** `{ plugins: n }` when the server has n > 0 unofficial plugins (the lobby's visual sets count them), else nothing. */
function pluginCount(lobby) {
  let n;
  try { n = Number(lobby?.plugins?.unofficial?.()) || 0; } catch { n = 0; }
  // 目录元信息：只在有已加载插件发布公告时带上，从不进房间或对局
  let notices = false;
  try { notices = lobby?.plugins?.hasNotices?.() === true; } catch { /* optional catalogue hint */ }
  return { ...(n > 0 ? { plugins: n } : {}), ...(notices ? { notices: true } : {}) };
}

/** The content sets with gameplay plugins rooms hold now (DESIGN **§34.6**，上游原文 `§32.6`; 0 without any). */
function contentSets(lobby) {
  try { return Number(lobby?.plugins?.contentInUse?.()) || 0; } catch { return 0; }
}

/**
 * **D19（取并集）**：上游的 `content` / `trusted` 照加法接；**我们的 `modHealth` 保留**。
 */
export function healthReport({ startedAt, network, registry, lobby, modHealth = null, content = null, traffic, assetIndex, views, trusted }, withTraffic = false) {
  /** @type {Record<string, any>} */
  const out = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    // what its rooms play (DESIGN **§34**，上游原文 `§32`): the vanilla content hash, and how many content sets with
    // gameplay plugins rooms hold now (P1c, §34.6 — a room's cosmetic plugins leave its cs the vanilla one); how many
    // unofficial plugins it has, when it has some (a page's title screen says so; P1a)
    ...(content ? { content: { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) } } : {}),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
  let fields = null;
  try {
    fields = typeof modHealth === 'function' ? modHealth() : modHealth;
  } catch {
    fields = null; // 一个包的 healthz 回调炸了不该让运维拿不到 /healthz
  }
  if (fields && typeof fields === 'object' && Object.keys(fields).length) out.modHealth = fields;
  if (trusted && Object.keys(trusted).length) out.plugins = trusted;
  if (withTraffic && traffic) out.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) out.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return out;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object,
 *           records?: import('../matchRecords.js').MatchRecords|null,
 *           accounts?: import('../accounts.js').AccountStore|null,
 *           modsCatalog?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean,
 *           httpLanes?: readonly import('./httpLanes.js').HttpLane[], publicDir?: string,
 *           trustProxy?: 'auto' | boolean }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, records = null, accounts = null, modsCatalog, httpLanes, publicDir, trustProxy = 'auto', studio = null, csp = null, trustedRuntime = null }) {
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
  // A bad table fails at boot, naming every problem — same ruling as the upgrade table (§28.44), same reason: a lane
  // that silently never answers is worse than a server that refuses to start.
  const table = validateHttpLanes(httpLanes ?? [], { publicDir, existsSync });
  if (table.problems.length) throw new Error(`bad http lane table: ${table.problems.join('; ')}`);
  if (table.lanes.length) log.info(`[http] lanes: ${table.lanes.map((l) => l.prefix + l.methods.join('|')).join(', ')}`);

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    // 受信任插件的精确路径（server/plugins/trustedApi.js，上游 §34.13）：只接 /x/<id>/…，不传活请求/套接字
    if (trustedRuntime && parts.rawPath.startsWith('/x/') && await trustedRuntime.route(req, res, parts.rawPath)) return;
    // 插件工作台（server/studio/index.js）：只给本机与局域网；其他客户端走 404 页
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req, res, parts.rawPath, parts.query); return; }
    // A lane is asked before anything else, because it is the only rule here that knows about methods the game does
    // not serve (POST). It cannot reach the engine's own paths: `validateHttpLanes` refuses any prefix that overlaps
    // them, including `/healthz` and the catalogue, so the order below is untouched for every request a lane does not
    // claim — including a POST to `/healthz`, which stays the 405 it always was.
    const lane = resolveHttpLane(req.method || 'GET', parts.rawPath, table.lanes);
    if (lane) {
      try {
        await lane.onRequest(req, res, { rawPath: parts.rawPath, query: parts.query, log, lane });
      } catch (e) {
        // Named, and never a fall-through into the game's static space: a half-written lane response stays half-written.
        log.error(`[http] lane ${lane.id} failed`, e);
        if (!res.headersSent) sendError(req, res, 500, '玩法服务出错 · Mode error');
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === MODS_CATALOG_URL && modsCatalog && modsCatalog(req, res)) return;
    if (parts.rawPath === PUBLIC_ROOMS_URL) {
      // **只有一个整数字段**：加任何一个别的键（房号、房主名、在局中、人数、容量）都是把「数」变成侧写，
      // 那正是这一格被收窄掉的东西。`sendJson` 自带 `Cache-Control: no-store`。
      sendJson(req, res, 200, { publicRooms: health.lobby.roomCounts().publicRooms });
      return;
    }
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
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    // 每一条回答的体字节都进流量计数（traffic.js），在**写出任何东西之前**接上 —— 与上游同一条纪律。
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
