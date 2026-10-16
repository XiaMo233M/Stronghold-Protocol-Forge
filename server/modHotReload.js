// server/modHotReload.js — 创意工坊目录的**变更监听 + 重载驱动**（DESIGN 未覆盖：本模块为新增能力）。
//
// 背景（先说清能力边界，别把运维骗了）：
//   这个引擎的装配是**一次性**的 —— startServer() 里 loadWorkshop → 注册表开关 → 依赖裁决 → 钩子/meta/服务端模块/
//   战斗/房间 → 裁剪 → 数据叠加层 → Lobby/Network/MatchClass/静态层，全部在 listen 之前烘进对象里。
//   因此**真正意义上的"原地换包"需要把这段装配抽成可重入的 applyWorkshop()**（见本 PR 描述里的第 2 步）。
//   本模块先交付"可用的热装载"里**安全的那一半**：
//     * 盯着 workshop/，变更（防抖、合并突发、串行化）后重新扫一遍并**精确 diff**（增/删/版本变化）；
//     * 按 `mode` 决定动作：
//         - `report`（默认）：只报告，不动服务；
//         - `restart`：**受监督**部署下自动优雅重启（关掉服务再退出，交给 supervisor 拉起来）——
//                     这才是本引擎当前架构下"换包生效"的正确形态（docs/MIRROR.md:50 原来写的就是"重启生效"）。
//     * 任何异常都只记日志：**一个坏包绝不能让服务器变成起不来或半死不活**。
//
// 与 mod 层的关系：本模块**不**碰 server.modules / pack.msg / /healthz 的 modHealth / 静态层 —— 那些语义一律不动。
import fs from 'node:fs';
import path from 'node:path';

const noop = { info() {}, warn() {} };
export const DEFAULT_DEBOUNCE_MS = 300;

/**
 * 热装载的两个环境开关 —— 读取**刻意放在这个模块里**（§28.14 的反射扫描只看 `server/index.js`、
 * `server/modModules.js`、`server/match/Match.js`、`server/match/botEmotes.js` 这一组核心文件；
 * 与 `server/accountConfig.js` 的 `SP_ACCOUNTS` / `SP_RECORDS_FILE` 同一政策）：热装载是**宿主运维开关**，
 * 不该让包看见、更不许包据此分叉（MOD_SURFACE：同一份摘要 ⇒ 同一份行为）。
 */
export function resolveHotReloadMode(env = process.env) {
  return env.SP_HOT_RELOAD === 'restart' ? 'restart' : 'report';
}

/** 受监督重启的退出码（supervisor 靠它决定是拉起还是放停）。 */
export function hotReloadExitCode(env = process.env) {
  return Number(env.SP_HOT_RELOAD_EXIT_CODE || 0);
}

/** 扫一个工坊根目录，列出（目录名 → 版本号）。读不到就返回空表（不抛）。 */
export function scanPacks(dir, { fsImpl = fs, log = noop } = {}) {
  const out = new Map();
  let names = [];
  try {
    names = fsImpl.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    log.warn?.(`[hot-reload] cannot read ${dir}: ${e?.message || e}`);
    return out;
  }
  for (const name of names) {
    let version = null;
    try {
      const raw = fsImpl.readFileSync(path.join(dir, name, 'pack.json'), 'utf8');
      const j = JSON.parse(raw);
      version = typeof j?.version === 'string' ? j.version : (j?.version == null ? null : String(j.version));
    } catch { version = null; }   // 坏包 / 缺 pack.json：照样列出来（version=null），由 diff 报告
    out.set(name, version);
  }
  return out;
}

/** 两份扫描结果的精确 diff（增/删/版本变化）。 */
export function diffPacks(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, v] of after) {
    if (!before.has(id)) added.push({ id, version: v });
    else if (before.get(id) !== v) changed.push({ id, from: before.get(id), to: v });
  }
  for (const [id, v] of before) if (!after.has(id)) removed.push({ id, version: v });
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}

/**
 * @param {{ dir: string, fsImpl?: object, log?: object, debounceMs?: number, mode?: 'report'|'restart',
 *           onReload?: (info: { kind: string, diff: object, packs: Map<string,string|null> }) => any,
 *           restart?: () => any|Promise<any>, watchImpl?: Function }} opts
 */
export function createHotReload({
  dir, fsImpl = fs, log = noop, debounceMs = DEFAULT_DEBOUNCE_MS,
  mode = resolveHotReloadMode(),
  onReload = null, restart = null, watchImpl = fs.watch,
} = {}) {
  let watcher = null;
  let timer = null;
  let running = false;
  let packs = new Map();
  const status = { running: false, dir, mode, reloads: 0, skipped: 0, lastAt: null, lastDiff: null, lastError: null, debounceMs };

  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void trigger(reason); }, Math.max(0, debounceMs));
    timer.unref?.();
  };

  async function trigger(reason) {
    if (running) { status.skipped += 1; return; }   // 串行化：上一轮没跑完就跳过（下一轮变更还会来）
    running = true;
    try {
      const next = scanPacks(dir, { fsImpl, log });
      const diff = diffPacks(packs, next);
      if (!diff.total) { status.lastError = null; return; }
      packs = next;
      status.reloads += 1;
      status.lastAt = new Date().toISOString();
      status.lastDiff = diff;
      const parts = [];
      if (diff.added.length) parts.push(`+${diff.added.map((a) => a.id).join(',')}`);
      if (diff.removed.length) parts.push(`-${diff.removed.map((a) => a.id).join(',')}`);
      if (diff.changed.length) parts.push(`~${diff.changed.map((c) => `${c.id}@${c.from}->${c.to}`).join(',')}`);
      log.info?.(`[hot-reload] ${reason}: ${parts.join(' ')} (mode=${mode})`);
      if (onReload) await onReload({ kind: reason, diff, packs: next });
      if (mode === 'restart') {
        if (typeof restart === 'function') await restart();
        else log.warn?.('[hot-reload] mode=restart but no restart() callback was given — nothing to do');
      }
    } catch (e) {
      // 绝不外抛：监听失败/回调失败都只记日志，保服务活着。
      status.lastError = String(e?.message || e).slice(0, 200);
      log.warn?.(`[hot-reload] reload failed: ${status.lastError}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (watcher) return status;
      packs = scanPacks(dir, { fsImpl, log });
      try {
        watcher = watchImpl(dir, { recursive: true }, () => schedule('change'));
        watcher.unref?.();   // 不把事件循环吊住（测试/短命进程靠它退出）
        watcher.on?.('error', (e) => { status.lastError = String(e?.message || e).slice(0, 200); log.warn?.(`[hot-reload] watcher error: ${status.lastError}`); });
        status.running = true;
        log.info?.(`[hot-reload] watching ${dir} (${packs.size} pack(s), mode=${mode}, debounce=${debounceMs}ms)`);
      } catch (e) {
        status.lastError = String(e?.message || e).slice(0, 200);
        log.warn?.(`[hot-reload] cannot watch ${dir}: ${status.lastError}`);
      }
      return status;
    },
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      try { watcher?.close?.(); } catch { /* ignore */ }
      watcher = null; status.running = false;
    },
    /** 主动触发一次（测试/运维用）。 */
    async check(reason = 'manual') { await trigger(reason); return status; },
    packs: () => new Map(packs),
    status: () => ({ ...status }),
  };
}
