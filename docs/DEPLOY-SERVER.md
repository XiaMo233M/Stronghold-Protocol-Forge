<!--
  吸收说明（我方维护方加，非原文）：本文档吸收自下游 fork `jingjiangze/Stronghold-Protocol-Forge`，
  其中提到的仓库名 / 分支名 / 路径名属**对方**语境；我方口径以本仓（`XiaMo233M/Stronghold-Protocol-Forge`）为准。
  原文一字未改，说明只加在顶部。
-->
# 服务器轻量发行：不预装美术与内容包

这份配置将 Forge 作为服务端部署，而不是把完整玩家整合包原样放到服务器上。它是一个**不含游戏美术载荷的 Web 游戏服务器发行包**，不是纯 headless daemon：基础 HTML、CSS、JavaScript、协议和页面仍由服务端提供。

## 构建

在 Forge 仓库根目录执行，要求 Node.js 22 或 24：

```sh
npm ci
node tools/package-server.mjs --dry-run
node tools/package-server.mjs --out ../stronghold-server-release
```

`--out` 必须在源码仓库目录之外。成功后会生成 `Stronghold-Protocol-v<version>-server.zip`。Windows PowerShell 示例：

```powershell
npm ci
node tools/package-server.mjs --dry-run
node tools/package-server.mjs --out D:\Stronghold-Server-Release
```

默认构建会在临时 staging 目录执行生产依赖安装，并检查清单、入口、模块导入、私人路径和 staging 中是否混入未计划文件。不要用 `--no-install` 生成实际部署包；它只用于快速核对选择结果。

## 安装与启动

1. 将 ZIP 解压到服务器上的独立目录。
2. 使用 Node.js 22 或更高版本。发行时已经安装生产依赖和生成 `public/vendor/`。
3. 启动服务：
   ```sh
   node server/index.js
   ```
   默认端口为 3000；可以通过 `PORT` 和 `HOST` 配置。健康检查为 `GET /healthz`。
4. 如果使用交互式启动器，并且暂时不希望运行素材 setup，可用 `node scripts/launch.mjs --no-setup --no-open`。不要直接运行 `node tools/setup.mjs` 或会自动执行 setup 的安装流程，除非确实希望把素材下载到这台服务器。

## 资源与 Mod 边界

- 发行包不包含 `public/assets/` 的游戏美术、`public/fonts/` 的字体、`packs/` 中的仓库预装内容包，也不包含 `docs/my-first-pack/` 和 `docs/examples/` 的样例包载荷。
- 核心 `public/index.html`、CSS、客户端 JS 与官方游戏协议必须保留。删除整个 `public/` 会使当前 Node 服务无法提供可玩的页面。
- `public/js/ui/extensions.js`、`public/js/ui/modComponents.js` 是 Mod 运行时 API，不是预装 UI 覆盖物。当前 UI Mod 依赖面板槽位、组件包裹/替换等接口，不能为了消除预装覆盖层而删除这些兼容点。
- 发行包不预装 Mod 内容，但保留 Mod Registry / workshop 加载代码。已经审核的 Mod 应按单独的 Mod 分发流程安装，不复制进引擎源码树。
- `data/assets.json` 作为资源清单保留。本配置不把核心美术 URL 自动改写为 CDN，也不保证外部 CDN 已覆盖每一项资源。若要求服务器磁盘始终不保存素材，必须另行验收 CDN 映射、CORS、缓存、版本哈希和缺失回退；否则应允许服务器/客户端按现有机制获取素材。不能把“ZIP 不含美术”理解为“远端资源托管已经完成”。

## 验收

```sh
node tools/package-server.mjs --dry-run --list
node --test test/package-server-profile.test.js
npm run ci
npm run golden
```

上线前还须用 Mod 仓库当前的 30 个包逐个进行运行时装载、协议通道、房间/对局和 UI 面板验收。Mod 索引里的旧加载记录不是新引擎上的复验结果；详见 [引擎兼容审计](ENGINE-COMPAT-STARDUST-AUDIT.md)。

## 换入口：`node server/modServer.js`（可选，认两件事）

默认入口 `node server/index.js` 的行为与字节**不变**。`server/modServer.js` 是给需要这两件事的部署用的可选入口，
它存在的唯一理由是不改 `server/index.js`（那是游戏本体拥有的路径，改它就越过「与本体路径交集必须为 0」那条红线）：

| 能力 | 怎么开 | 不开会怎样 |
|---|---|---|
| 包声明的 WebSocket lane（DESIGN §28.56） | 包在 `server.modules[].lane.path` 声明 `/mod-ws/<包id>/…`，模块里 `host.lane(onUpgrade)` | 那条 lane 根本不在宿主的升级表里，客户端连过去是 404 —— 不是 503，是查无此路 |
| 工坊目录热装载（监听 + 精确 diff + 可选受监督重启） | `SP_HOT_RELOAD=report`（缺省，只报告）或 `SP_HOT_RELOAD=restart` + `SP_HOT_RELOAD_EXIT_CODE=<n>` 交给外部 supervisor | 包改动不会被报出来；服务本身不受任何影响（异常一律只记日志） |

⚠️ 热装载只交付**安全的那一半**：它**不**承诺「原地换包」。这个引擎的装配是一次性的（`startServer()` 在 `listen` 之前把工坊、钩子、服务端模块、战斗、房间、数据叠加层全部烘进对象里），真正原地换包要先把那段装配抽成可重入的 `applyWorkshop()` —— 那是另一件事。所以缺省 `report` 只报告不动服务，要生效请用 `restart` 交给外部 supervisor 拉起；**缺省路径的行为与字节零变化**。

启动时这一入口会多打一行 `[mod-lane] N pack lane(s): /mod-ws/<包id>/… (NO HANDLER)` —— 运维要能确认这个进程
到底开了哪几条包通道，而不是靠猜。`workshop/` 的位置仍由 `SP_WORKSHOP` 或 `opts.workshopDir` 决定，与默认入口一致。
