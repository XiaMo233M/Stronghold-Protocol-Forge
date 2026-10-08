// editor/playtest.mjs — 编辑器里的「一键试玩」：由编辑器起一个**游戏服务器进程**，把作者当前那个工坊根交给它。
//
// 为什么是子进程而不是在编辑器进程里 `startServer()`：编辑器要能「改完包 → 重启试玩 →
// 立刻看到新内容」，而 `server/data.js` 的 `getData()` 是进程级单例，同一个进程里重启也只会拿到第一次加载的
// 数据。子进程每次都是干净的一份，同时把「编辑器崩了会不会带走游戏服务器」这类问题交给进程边界，而不是靠约定。
//
// 生命周期只有三条规则，但它们都是踩过的坑：
//   * **同时只有一个**：第二次 start 返回同一个实例（`reused: true`），不悄悄起第二个占端口的进程；
//   * **退出必收尸**：stop / 编辑器 close / 自己的进程退出（含 SIGINT）都要杀掉子进程，否则用户会在任务管理器里
//     留下一堆孤儿 node.exe —— 而它们还占着端口，下次试玩会以「端口被占用」失败；
//   * **失败即回滚**：子进程起不来、或 /healthz 一直不通，就把进程杀掉并抛错，绝不返回一个「看起来在跑」的实例。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/** 编辑器根目录；游戏服务器就在它的上一级（本仓库同时是编辑器与游戏）。 */
export const EDITOR_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(EDITOR_ROOT, '..');

/** 试玩默认绑本机：这是给作者自己看的窗口，不是给局域网用的服务器。 */
export const PLAYTEST_HOST = '127.0.0.1';

/** `/healthz` 最多等多久（冷启动要读全部 data/*.json 并合并工坊包；实测本机 1–2 s，30 s 是慢盘的安全余量）。 */
export const HEALTH_TIMEOUT_MS = 30_000;
/** 健康检查的轮询间隔。 */
export const HEALTH_POLL_MS = 250;
/** stop 先 SIGTERM 等这么久，进程还不走就 SIGKILL。 */
export const KILL_GRACE_MS = 4_000;

/**
 * 挑一个当前空闲的本机端口。
 *
 * 绑 0 号端口让内核给一个空闲端口再立刻释放 —— 释放与子进程真正绑定之间有极小的竞态窗口，
 * 但这是本机单用户工具，比「固定 3000 端口」实际得多（作者的 3000 常常已经被自己开着的那份占了）。
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function freePort(host = PLAYTEST_HOST) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 试玩页面的 URL：带上客户端的深链参数（`?playtest=1`，见 public/js/main.js），
 * 于是打开浏览器就直接进一局独立模拟，而不是停在选单里。
 *
 * `stage` 只是**说明性**的（客户端不认识这个参数）：真正决定打哪张图的是子进程的 `SP_STAGE`（见 start()）。
 * 带上它纯粹是为了让作者在地址栏里也能看出这一局是「试玩某张图」。
 * @param {number} port
 * @param {string|null} [difficulty] 难度键（shared/constants.js 的 DIFFICULTIES）；不认识就不带
 * @param {string|null} [stage] 强制的地图 id（地图页「▶ 试玩这张图」）
 * @returns {string}
 */
export function playtestUrl(port, difficulty = null, stage = null) {
  const q = new URLSearchParams({ playtest: '1' });
  if (typeof difficulty === 'string' && difficulty) q.set('difficulty', difficulty);
  if (typeof stage === 'string' && stage.trim()) q.set('stage', stage.trim());
  return `http://${PLAYTEST_HOST}:${port}/?${q.toString()}`;
}

/**
 * 建一个试玩控制器。返回的对象被 `createEditorServer` 持有，并挂在它的 `close()` 上。
 * @param {{ root?: string, repoRoot?: string, node?: string, log?: object, stdio?: string }} [opts]
 *   `root` 是**工坊根**（编辑器 `--workshop` 的那个），会以 `SP_WORKSHOP` 交给子进程。
 *   `stdio` 默认 `'inherit'`：游戏服务器的日志直接出现在编辑器那个终端里（试玩失败时那是唯一的线索）；
 *   测试传 `'ignore'` 免得刷屏。
 */
export function createPlaytest({ root, repoRoot = REPO_ROOT, node = process.execPath, log = console, stdio = 'inherit' } = {}) {
  /** @type {{ child: import('node:child_process').ChildProcess, port: number, url: string, startedAt: number }|null} */
  let current = null;
  /** stop() 期间的标志：防止并发的 start 与正在退出的进程抢端口。 */
  let stopping = null;
  /** 进程退出钩子只挂一次（见 start()）。 */
  let exitHooked = false;

  const entry = path.join(repoRoot, 'server', 'index.js');

  /** 等到 `/healthz` 真的回答（子进程已经死了就直接失败，不必等满超时）。 */
  async function waitHealthy(child, port) {
    const until = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < until) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`游戏服务器进程还没起来就退出了（code ${child.exitCode ?? child.signalCode}）`);
      }
      try {
        const res = await fetch(`http://${PLAYTEST_HOST}:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return true;
        lastError = new Error(`/healthz 返回 ${res.status}`);
      } catch (e) {
        lastError = e;
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`等了 ${Math.round(HEALTH_TIMEOUT_MS / 1000)} s 游戏服务器仍未就绪${lastError ? `（最后一次：${lastError.message}）` : ''}`);
  }

  /** 杀掉子进程并等它真的走掉；已经在跑别的 stop 时等那一次。 */
  function kill(child) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } setTimeout(resolve, 200); }, KILL_GRACE_MS);
      child.once('exit', done);
      try { child.kill('SIGTERM'); } catch { done(); }
    });
  }

  const playtest = {
    /** 现在有没有在跑、跑在哪个端口（页面用它渲染状态）。 */
    status() {
      const alive = !!current && current.child.exitCode === null && current.child.signalCode === null;
      return alive
        ? { running: true, port: current.port, url: current.url, pid: current.child.pid, since: current.startedAt }
        : { running: false, port: null, url: null, pid: null, since: null };
    },

    /**
     * 起一个游戏服务器（已在跑就直接复用）。失败时不留半死不活的进程。
     * @param {{ difficulty?: string|null, port?: number }} [opts]
     * @returns {Promise<{ ok: true, url: string, port: number, pid: number, reused: boolean }>}
     */
    async start({ difficulty = null, port = null, stage = null } = {}) {
      if (stopping) await stopping;
      const now = playtest.status();
      if (now.running) return { ok: true, url: playtestUrl(now.port, difficulty, stage), port: now.port, pid: now.pid, reused: true };

      if (!fs.existsSync(entry)) throw new Error(`找不到游戏服务器入口：${entry}`);
      const usePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : await freePort();
      // SP_WORKSHOP：让子进程用**编辑器当前的工坊根**，否则试玩里看不到作者正在编辑的包（server/index.js main）
      // SP_PLAYTEST：告诉这一局它是试玩（记录里标了「直接发到手上」的干员会进手牌，见 Match.grantDirectToHand）。
      // SP_STAGE：地图页「▶ 试玩这张图」——这一局强制打指定的那张图（Match 构造器里覆盖抽图结果）。
      const env = { ...process.env, PORT: String(usePort), HOST: PLAYTEST_HOST, SP_PLAYTEST: '1' };
      if (root) env.SP_WORKSHOP = path.resolve(root);
      if (typeof stage === 'string' && stage.trim()) env.SP_STAGE = stage.trim();
      // stdio: 'inherit'（默认）让游戏服务器的日志直接出现在编辑器那个终端里 —— 试玩失败时那是唯一的线索
      const child = spawn(node, [entry], { cwd: repoRoot, env, stdio });
      current = { child, port: usePort, url: playtestUrl(usePort, difficulty, stage), startedAt: Date.now() };
      const forget = () => { if (current && current.child === child) current = null; };
      child.once('exit', forget);
      // 编辑器自己被 Ctrl+C 或崩溃带走时也要收尸，否则占着端口的孤儿 node.exe 会留到下次试玩才发现。
      // 每个控制器只挂一次（测试会建很多个编辑器实例，反复挂监听会触发 MaxListeners 警告）。
      if (!exitHooked) {
        exitHooked = true;
        process.once('exit', () => playtest.killNow());
      }
      try {
        await waitHealthy(child, usePort);
      } catch (e) {
        await kill(child);
        forget();
        throw e;
      }
      log.info?.(`[playtest] 游戏服务器已就绪：http://${PLAYTEST_HOST}:${usePort}（工坊根 ${root ?? '(默认)'}${env.SP_STAGE ? `，强制地图 ${env.SP_STAGE}` : ''}）`);
      return { ok: true, url: playtestUrl(usePort, difficulty, stage), port: usePort, pid: child.pid, reused: false };
    },

    /** 停掉试玩（没在跑就是 no-op）。 */
    async stop() {
      if (stopping) return stopping;
      if (!current) return { ok: true, stopped: false };
      const { child, port } = current;
      stopping = (async () => {
        await kill(child);
        if (current && current.child === child) current = null;
        log.info?.(`[playtest] 已停止（端口 ${port}）`);
        return { ok: true, stopped: true };
      })();
      try { return await stopping; } finally { stopping = null; }
    },

    /** 编辑器退出时收尸：同步杀一次，够用且不必等（`process.on('exit')` 里不能 await）。 */
    killNow() {
      if (current && current.child.exitCode === null) {
        try { current.child.kill('SIGTERM'); } catch { /* gone */ }
      }
      current = null;
    },
  };

  return playtest;
}
