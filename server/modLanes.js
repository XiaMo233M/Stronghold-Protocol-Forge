// server/modLanes.js — 包声明的 WebSocket lane：一张「装载期按声明填好、升级时才找处理器」的活表（DESIGN §28.56）。
//
// 为什么要有这一格：§28.44 把升级路径做成了一张表，但那张表今天只有**宿主进程自己**能登记 —— 一个自带玩法的
// 包（3v3 足球、任何不用 `/ws` 协议的进程）没有地方说「我要一条自己的路径」。这一格把它变成声明。
//
// 为什么这张表必须是**活的**、处理器必须**惰性查**：`server/index.js` 在 `:188` 装载服务端模块，在 `:432` 才把
// `opts.wsLanes` 交给 `attachWebSocket`。启动器（`server/modServer.js`）在 `startServer` 之前就要交出那份表，
// 而那时处理器还没 import 完。所以拆成两步：**路径按声明同步认领**（保证 attach 之前就在表里，不会出现
// 「声明了却永远不路由」的哑格子），**处理器 import 完成后挂上**（升级发生时才查）。没挂上就升级 ⇒ 明确 503
// 点名这条 lane —— §28.44 的原话是「一条安静地从不应答的 lane 比没有 boot 更糟」，所以这里的失败方向必须是响的。
//
// 这一格**不碰 `server/index.js`**（那是游戏本体 `sganggs` 拥有的路径）：`startServer(opts)` 的签名今天已经有
// `opts.wsLanes`（`server/index.js:92`），启动器只是把它填满。
import { isLanePath, LANE_RESERVED, MAX_WS_LANES } from './http/wsLanes.js';

/** 交给 `startServer({ wsLanes })` 的那一份活数组：装载期往里推，`attachWebSocket` 在 `:392` 快照它。 */
const table = [];
/** path -> `包id/模块id`，用来在撞车时点出是谁先认领的。 */
const owners = new Map();
/** `包id/模块id` -> handler，异步 import 完成后由 `attachPackLaneHandler` 填。 */
const handlers = new Map();

const keyOf = (packId, moduleId) => `${packId}/${moduleId}`;

/** 这条 lane 后面跑的是谁（诊断与 boot 日志用；不含任何句柄）。 */
export function packLaneRows() {
  return table.map((row) => Object.freeze({
    id: row.id, path: row.path, summary: row.summary, ready: handlers.has(row.id),
  }));
}

/** 装载器要的那份表（同一引用 —— 复制就丢掉「活」的语义）。 */
export function packLaneTable() { return table; }

/**
 * 按声明认领一条路径。**同步**调用，坏配置当场点名（返回 `{ ok:false, code, reason }`，装载器把它变成整包拒）。
 * 判据只复用 §28.44 那一份，不在这里抄第二份语法。
 */
export function claimPackLane({ packId = '', moduleId = '', path, summary = null } = {}) {
  const key = keyOf(packId, moduleId);
  if (!packId || !moduleId) {
    return { ok: false, code: 'LANE_NO_OWNER', reason: `a pack lane must name its owner (got pack ${String(packId)} / module ${String(moduleId)})` };
  }
  if (!isLanePath(path)) {
    return { ok: false, code: 'LANE_BAD_PATH', reason: `server.modules["${key}"].lane.path ${JSON.stringify(path)} is not a rooted, plain, exact path (see server/http/wsLanes.js)` };
  }
  if (LANE_RESERVED.includes(path)) {
    return { ok: false, code: 'LANE_RESERVED', reason: `server.modules["${key}"].lane claims ${path}, which the game already serves` };
  }
  if (owners.has(path)) {
    const holder = owners.get(path);
    return { ok: false, code: 'LANE_TAKEN', reason: `server.modules["${key}"].lane claims ${path}, already claimed by "${holder}" (one path, one lane)` };
  }
  if (table.length >= MAX_WS_LANES) {
    return { ok: false, code: 'LANE_LIMIT', reason: `server.modules["${key}"].lane would be lane #${table.length + 1}; the host table serves at most ${MAX_WS_LANES} (this is a per-process budget, not a per-pack one)` };
  }
  if (handlers.has(key) || table.some((row) => row.id === key)) {
    return { ok: false, code: 'LANE_DUPLICATE_MODULE', reason: `server.modules["${key}"] already owns a lane (one lane per module)` };
  }
  const row = {
    id: key,
    path,
    summary: typeof summary === 'string' && summary ? summary : `pack lane for ${key}`,
    // 升级发生时才查处理器：这样「路径在表里」与「处理器已就位」是两件独立的事，各自的失败都能点名。
    onUpgrade(req, socket, head, ctx = {}) {
      const fn = handlers.get(key);
      if (typeof fn !== 'function') {
        ctx.log?.warn?.(`[mod-lane] ${key} got an upgrade before its handler was mounted — answering 503`);
        if (typeof ctx.reject === 'function') ctx.reject(503, 'pack lane not ready');
        else { try { socket.destroy(); } catch { /* nothing better to do */ } }
        return;
      }
      try { fn(req, socket, head, { ...ctx, lane: row }); } catch (e) {
        // §28.44 的口径：抛错就关掉这条连接，并按名字记账 —— 绝不回落到 `/ws`，否则客户端能把自己塞进游戏。
        ctx.log?.error?.(`[mod-lane] ${key} onUpgrade threw`, e);
        try { socket.destroy(); } catch { /* already gone */ }
      }
    },
  };
  owners.set(path, key);
  table.push(row);
  return { ok: true, row };
}

/** 模块 import 完成后挂处理器。没有已认领的路径就返回 false（调用方点名，不让它哑着）。 */
export function attachPackLaneHandler(packId, moduleId, fn) {
  const key = keyOf(packId, moduleId);
  if (typeof fn !== 'function') return { ok: false, code: 'LANE_NO_HANDLER', reason: `host.lane(...) needs a function onUpgrade(req, socket, head, ctx)` };
  if (!table.some((row) => row.id === key)) return { ok: false, code: 'LANE_NOT_CLAIMED', reason: `host.lane(...) called by "${key}" before its pack declared a lane path (server.modules[].lane.path)` };
  handlers.set(key, fn);
  return { ok: true, path: (table.find((row) => row.id === key) || {}).path };
}

/** 清空整张表 —— 只给测试与热装载重启用（生产路径不叫它）。 */
export function clearPackLanes() {
  table.length = 0;
  owners.clear();
  handlers.clear();
}
