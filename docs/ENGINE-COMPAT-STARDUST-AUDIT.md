<!--
  吸收说明（我方维护方加，非原文）：本文档吸收自下游 fork `jingjiangze/Stronghold-Protocol-Forge`，
  其中提到的仓库名 / 分支名 / 路径名属**对方**语境；我方口径以本仓（`XiaMo233M/Stronghold-Protocol-Forge`）为准。
  原文一字未改，说明只加在顶部。
-->
# Forge 引擎、Mod 与 Stardust 分支兼容审计

审计日期：2026-10-13  
执行分支：`work/upstream-026-mod-engine`（**已于 2026-10-14 分支收敛时并进 `master`，该分支删除**；本文件按当日快照保留，日期以下的判据不要当实时事实引用）  
工作基线：`XiaMo233M/Stronghold-Protocol-Forge@2303e44de7adf7fd8855e635087a09faaf9b2a6b`  
上游基线：`sganggs/Stronghold-Protocol@488db49f11daf862b67ce26fa4cf89aa6cba2466`  
Stardust 基线：`Stardust-minus/Stronghold-Protocol@c7521500f506cdf02467bffa9c169a25e1a82cbb`

## 1. 结论

不要将旧 PR 分支直接堆叠到已经前进到 Forge 0.18.3 / 上游 0.2.6 的引擎上。Forge 当前 main 已经包含多项 PR #2–#8 所尝试能力的演进版本；旧 PR 的上下文、函数签名和测试基线已经漂移，直接 cherry-pick 会有重复路由、消息重复分发和 Mod API 回退风险。

本分支从 Forge 当前 main 单独创建，不触碰原作者仓库或你的个人 main，也不向 `sganggs` 提交 PR。当前落地的是一个新增的服务器轻量打包器 `tools/package-server.mjs`，避免改动高冲突引擎文件。它没有宣称 30 个 Mod 已完成新版本认证，也没有部署到未指定的服务器。

## 2. 分支和版本基线

| 项目 | 核对结果 | 状态 |
|---|---|---|
| Forge 原仓库 main | `2303e44d`，版本 `0.18.3`，上游兼容基线 `0.2.6` | BASELINE |
| 你的旧 Forge main | `9242425d`，版本记录为 `0.15.1 / 0.2.4`；比 Forge 原仓库 main 落后 135 个提交 | BASELINE |
| 当前工作分支 | `work/upstream-026-mod-engine` 从 Forge 原仓库当前 main 建立 | IMPLEMENTED |
| 官方上游 | `sganggs` master 为 `0.2.6` | BASELINE |
| Stardust 分支 | 当前 head 以官方 0.2.6 为底；相对 upstream 比较 ahead 107、behind 0 | BASELINE |
| 当前全部 Mod 已在 Forge 0.18.3 验收 | Mod 索引记载的是 `0.16.0 / modApiVersion 1`，不是目标引擎版本 | PENDING |
| 核心美术 URL 完全外置 | 尚未改写资源 URL，也未测 CDN 覆盖率 / CORS / 缓存回退 | PENDING |
| 完整 CI、golden、30 包回归 | 尚未在实际 Node 工作树运行 | PENDING |
| 部署到真实服务器 | 未提供服务器地址/凭据，本分支未远程安装 | PENDING |

## 3. “目前 PR”的处置

| PR | 主题 | 本次结论 |
|---|---|---|
| #2 | `server.modules[].channels` 与对局消息 | 当前 main 已有 `test/modMatchChannels.test.mjs` 等演进实现；不叠加旧 patch |
| #3 | Mod Registry、生命周期、依赖/冲突/target | 当前 main 已有 `server/modRegistry.js`、依赖与 Registry 测试；不复用旧文件 |
| #4 | WebSocket 升级路由表 | 当前 main 已有 `server/http/wsLanes.js`、`test/wsLanes.test.js` |
| #5 | HTTP 请求路由表 | 当前 main 已有 `server/http/httpLanes.js`、`test/httpLanes.test.js` |
| #6 | `coreRouteShadow` 校验 | 以当前路由契约和测试守卫为准，不回灌旧实现 |
| #8 | `pack.json.enabled` | 当前 main 已有 `shared/enabled.js`、`test/packEnabled.test.js` |
| #9 | mod-xie v2.1 | 当前 Forge 树没有预装 `mod-xie` 代码；个人 Mod 索引包含 `mod-xie@2.0.0`。不要直接用旧 PR 包覆盖，应拿当前 Mod 源做 API 验证 |
| #10 | 上游 0.2.4 → 0.2.5 | 旧同步快照；当前基线为 0.2.6，不再用该 PR 覆盖当前主干 |

因此不是忽略这些 PR：当前主干里存在的等价实现以其现有契约和测试为准；缺失行为再做小型定向补丁，而非堆叠过时分支。

## 4. 当前 Mod 清单和风险

`jingjiangze/Stronghold-Protocol-Forge-Mods/mods/index.json` 于 2026-10-12 记录了 30 个包。索引的 engine 字段是 `appVersion 0.16.0 / modApiVersion 1`，并记录各包加载无错误；这只是历史索引记录，不是新引擎回归结论。

| Mod ID | 记录版本 | 主要风险面 |
|---|---:|---|
| `ave-mujica` | 1.1.0 | 战斗/内容和素材 |
| `boss-fixed-pool` | 1.0.0 | 战斗规则 |
| `capacity-panel` | 1.0.1 | 客户端 UI |
| `cdn-source` | 1.0.2 | UI / 素材路由 |
| `chat-bubble` | 1.0.0 | 客户端消息和 UI |
| `dmg-board` | 1.0.0 | UI |
| `duel-assets` | 0.1.0 | 素材 / 资源路径 |
| `duel-copy` | 0.1.0 | 内容 |
| `duel-data` | 0.1.0 | 内容 |
| `duel-fighter` | 0.1.0 | 战斗 / 内容 |
| `duel-mode` | 0.2.1 | 战斗 / 协议通道 |
| `duel-panel` | 0.1.0 | 客户端 UI |
| `fanpack-skillful-items` | 1.0.0 | 战斗 / 素材 |
| `healthz-ext` | 1.0.0 | 服务端路由 |
| `makoto-yuki` | 1.0.1 | 内容 / Spine 素材 |
| `mod-xie` | 2.0.0 | 战斗 / 协议 |
| `morph-plus` | 1.1.0 | 战斗规则 |
| `name-guard` | 1.0.0 | 服务端校验 |
| `net-panel` | 1.0.0 | 客户端 UI |
| `notice-board` | 1.0.0 | 公告数据 |
| `perf-lite` | 1.0.0 | 客户端性能 UI |
| `prep-loadout` | 1.0.0 | 战斗规则 |
| `shop-bond-bias` | 1.0.0 | 商店 / 战斗规则 |
| `skin-catalogue` | 1.0.0 | 皮肤 / 素材 |
| `skin-picker` | 1.0.0 | 客户端 UI |
| `srv-notice` | 1.0.0 | 服务端公告 |
| `strawberry-ui` | 1.0.0 | 客户端 UI |
| `theme-night` | 1.0.0 | 客户端主题 |
| `unequip` | 1.1.0 | 战斗规则 |
| `ws-compression-reference` | 1.0.0 | WebSocket / 网络行为 |

兼容策略：保持 `MOD_API_VERSION=1` 和现有扩展导出；不删除 `server/modRegistry.js`、`server/workshop.js`、`shared/workshop.js`、`public/js/ui/extensions.js` 或 `public/js/ui/modComponents.js`。只有证明确实破坏了已有 API，才升级 ABI 并提供迁移说明。完整验收须在新引擎下将 30 个包真实装载并运行协议、房间/对局、UI 和素材测试。

## 5. 移除静态资源与预装 UI 覆盖层：正确边界

删除整个 `public/` 不可行：Forge 进程本身提供基础 HTML/CSS/JS 和 WebSocket。应当分层：

- 服务器发行包排除 `public/assets/` 实际美术、`public/fonts/` 字体、仓库 `packs/` 里的预装内容包，以及 `docs/my-first-pack/` / `docs/examples/` 样例包载荷。
- 保留 `public/index.html`、核心 CSS/JS、`public/vendor/` 运行库副本、`data/assets.json` 资源清单、服务器/共享协议和模拟引擎。核心 Web UI 代码不是 Mod overlay。
- 保留 `extensions.js`、`modComponents.js`、Mod Registry 和 workshop loader 等接口。它们按 Mod 声明挂载面板/组件修改，不代表服务端预先安装了某个主题或 UI 覆盖包。
- Mod 本体和素材继续由独立 Mod 仓或管理员目录分发，不复制进引擎树，不在上游同步期间改写。

新增的 `tools/package-server.mjs` 按以上边界从 Git 跟踪文件生成服务器 ZIP，不携带美术和 `packs/`。它不完成 CDN URL 改写，也不保证核心素材已在外部镜像；如要求服务器磁盘不保留美术，下一阶段必须单独验收 CDN 映射、CORS、版本哈希、缓存和缺失回退。

## 6. Stardust 相对官方上游的增量

Stardust 当前 master 相对 `sganggs/master` ahead 107 / behind 0。这个数字包括上游合并和 fork 自身的提交，不能理解成 107 个独立功能。核对 README、近期提交和 0.2.6 变更记录后，可归纳为：

### Stardust 自己的服务层
- 公开匹配、扩展好友房人数/观战/AI 等房间能力。
- 服务端战斗/校验、协调器以及多 game/ingress 节点的集群部署。
- 登录门禁/PRTS 验证、账号和比赛记录、健康与流量统计。
- 多源素材分发、Formal/Beta 部署区分，以及 Nginx、Docker Compose、固定 profile/digest 等部署工具。

### Stardust 自身或为 fork 保留的修复
- 断线重连时保留玩家原座位并将其导回原席位。
- 跟随官方 0.2.6 的 WebSocket 压缩，同时保留 fork 的压缩策略。
- 不支持 `svh` 的浏览器上对 UI 根容器尺寸的回退。
- 官方 3D 战场场景里平台/高台绘制修复；其他模型裁剪、渲染缓存和 E2E 稳定性修复。

### 官方上游 0.2.6 的公共变化
- 背景音乐音量为 0 时跳过音乐下载。
- 大于约 1 KB 的 WebSocket 消息启用 permessage-deflate；上游记录的单人局服务器消息量示例由约 173 KB 降至 60 KB（属于该记录的测试口径）。
- 静态资源内容哈希 URL 和长缓存、Brotli、教程图 WebP 与下一页预载优化。
- 多项战斗规则、3D 场景、UI 和断线修复。

**取舍**：保持 Forge 当前 0.2.6 上游基线。不将 Stardust 的认证、集群、账号/匹配系统整体搬入 Forge；这些是部署/产品层而非通用 Mod ABI。优先逐项评估重连座位、压缩和地形修复，只有存在目标需求并有独立回归测试时才移植，不能合并整个 `deploy/stardust/`。

## 7. 上游无痛同步

1. 更新时固定 `sganggs` 提交 SHA 与版本，不以 Stardust HEAD 替代官方基线。
2. 按文件/符号区分官方引擎和 Forge 扩展；不覆盖整目录，也不批量 cherry-pick 陈旧 PR。
3. 对 `shared/protocol.js`、`shared/constants.js`、`shared/workshop.js`、`shared/modSurface.js`、`shared/kitImports.js` 等 API 合同表面保留明确边界和测试。
4. `MOD_API_VERSION` 只在删除、改名或改变既有语义时递增；纯新增项通过兼容性测试保护。
5. 每次更新运行 `npm run ci`、`npm run golden`、相关 `test/mod*` / `test/workshop*`，并对当前 Mod 仓库 30 个包逐个真实装载。
6. 构建服务器 ZIP，确认无美术/字体/预装内容包，验证服务器启动、`/healthz`、`/` 和资源路径；采用 CDN 或本地获取的策略要明确。
7. 状态必须区分 BASELINE / IMPLEMENTED / PASS / PENDING；没实际跑过的检查不能标 PASS。

## 8. 当前提交验收矩阵

| 检查项 | 状态 | 备注 |
|---|---|---|
| 工作分支从 Forge 当前 main 创建 | IMPLEMENTED | 与个人 main、原作者仓库分离 |
| 服务器无美术/预装包打包脚本 | IMPLEMENTED | `tools/package-server.mjs` 已提交；实跑结果待验证 |
| 核心客户端与 Mod API 保留 | IMPLEMENTED | 脚本选择清单保留运行时文件 |
| 新打包器 dry-run / 实际 ZIP | PENDING | 需在工作树执行 Node 22/24 |
| CI / golden | PENDING | 未在本次 GitHub API 环境执行 |
| 30 个 Mod 0.18.3 装载与回归 | PENDING | 旧索引 0.16.0 不能替代实测 |
| 核心美术完全外置 | PENDING | 需单独改写/验证资源 URL 与 CDN |
| 真实服务器安装 | PENDING | 当前没有目标主机凭据，未远程操作 |
