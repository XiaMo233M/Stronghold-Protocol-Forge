// server/modServer.js — 认「包声明 lane」与「工坊目录热装载」的启动入口（DESIGN §28.56 + docs/DEPLOY-SERVER.md）。
//
// 它存在的一条理由就是**不必改 `server/index.js`**：那是游戏本体 `sganggs/Stronghold-Protocol` 拥有的路径
// （`.github/game-overlap-check.mjs` 从 2026-10-15 起判「每处与本体的交集都必须是 `overlay.json` 的 `bodyPaths`
// 里已登记、锚点在位的受控例外」——能不走这条路就不走）。
// 而这两件事要的三样东西 —— 工坊目录、`close()`、进程退出码 —— 在进程入口这一层本来就都有：
//   * lane：`startServer(opts)` 的签名今天已经有 `opts.wsLanes`（`server/index.js:105`），这里只是把
//     `server/modLanes.js` 那份**活表**交进去，装载期认领的路径因此一定在宿主快照之前就在表里；
//   * 热装载：监听 + 精确 diff + 可选受监督重启，由本入口持有并负责停（`exit` / `SIGINT` / `SIGTERM`）。
//
// 不用这一入口的部署照旧 `node server/index.js`，行为与字节都不变。
import path from 'node:path';
import { isProcessEntry, runMain } from './http/boot.js';
import { startServer } from './index.js';
import { WORKSHOP_DIR } from './workshop.js';
import { packLaneTable, packLaneRows } from './modLanes.js';
import { createHotReload, resolveHotReloadMode, hotReloadExitCode } from './modHotReload.js';

const log = { info: (...a) => console.info(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };

if (isProcessEntry(import.meta.url)) {
  runMain((opts = {}) => startServer({ ...opts, wsLanes: packLaneTable() }).then((result) => {
    // 1) 把认领到的 lane 打一行出来：运维要能确认「这个进程到底开了哪几条包通道」，而不是靠猜。
    const rows = packLaneRows();
    if (rows.length) {
      log.info(`[mod-lane] ${rows.length} pack lane(s): ${rows.map((r) => `${r.path}${r.ready ? '' : ' (NO HANDLER)'}`).join(', ')}`);
    }

    // 2) 工坊目录热装载。默认 `report`：只报告不动服务；`SP_HOT_RELOAD=restart` 才受监督重启
    //    （退出码 `SP_HOT_RELOAD_EXIT_CODE`，交给 systemd / npm watch 之类的外部 supervisor）。
    //    环境读取**全部**留在 modHotReload 里 —— §28.14 的反射扫描只看那四个核心文件，宿主运维开关不该进
    //    包可见的白名单（与 `SP_ACCOUNTS` 同一条政策）。任何异常只记日志，绝不影响服务器功能。
    const envWorkshop = process.env.SP_WORKSHOP ? path.resolve(process.env.SP_WORKSHOP) : null;
    const mode = resolveHotReloadMode();
    const hot = createHotReload({
      dir: opts.workshopDir === undefined ? (envWorkshop || WORKSHOP_DIR) : opts.workshopDir,
      log,
      mode,
      onReload: ({ diff }) => log.info(`[hot-reload] packs changed: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`
        + (mode === 'restart' ? ' → restarting to apply' : ' (report only; restart to apply)')),
      restart: async () => {
        try { await result.close(); } catch { /* 关不干净也要退，交给 supervisor */ }
        process.exit(hotReloadExitCode());
      },
    });
    try {
      hot.start();
    } catch (e) {
      log.error('[hot-reload] watcher failed to start (the server keeps running)', e);
    }
    const stop = () => { try { hot.stop(); } catch { /* already stopped */ } };
    process.on('exit', stop);
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, stop);

    return result;
  }));
}
