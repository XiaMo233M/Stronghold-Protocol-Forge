# 服务器轻量发行：不预装美术与内容包

这份配置把 Forge 作为**服务端**部署，而不是把完整玩家整合包原样搬到服务器上。它是一个**不含游戏美术载荷的 Web 游戏服务器发行包**，不是纯 headless daemon：基础 HTML、CSS、JavaScript、协议和页面仍由服务端提供。

## 怎么验「这包真的只有管理器」

两个只读检查器 + 一个条目判据，都读同一份清单 `.github/overlay.json`：

```sh
# ① 增量是否只含控制面或已登记叠层（判「这条分支必须只有 mod 管理器」）
node .github/manager-only-check.mjs --work <本树> --up <对照树>

# ② 增量里的路径，游戏本体 sganggs 是否有同名文件；有 ⇒ 必须是已登记且锚点在位的受控例外
node .github/game-overlap-check.mjs --work <本树> --up <对照树>

# ③ 产物条目清单（素材 / 内容包 / editor / test / .github 必须为 0 条，mustContain 必须在场）
node .github/release-verify.mjs --zip <构建出的 zip> --manifest .github/overlay.json
```

判据写在清单里，不在脚本里：**登记 = 留证据**（`why` + 至少一条锚点），锚点当场找不到就拦。②的口径是 2026-10 定的那一条 —— 与本体路径的交集不再要求为 0，但**每一处交集都必须可机器核对**；对外表述因此是「N 处受控例外，锚点在位」，不是「零交集」。

## 构建

在仓库根目录执行，要求 Node.js 22 或 24：

```sh
npm ci
node tools/package-server.mjs --dry-run
node tools/package-server.mjs --out ../stronghold-server-release
```

`--out` 必须在源码仓库目录之外。成功后生成 `Stronghold-Protocol-v<version>-server.zip`。Windows PowerShell 示例：

```powershell
npm ci
node tools/package-server.mjs --dry-run
node tools/package-server.mjs --out D:\Stronghold-Server-Release
```

默认构建会在临时 staging 目录执行生产依赖安装，并检查清单、入口、模块导入、私人路径与 staging 里是否混入未计划文件。不要用 `--no-install` 生成实际部署包；它只用于快速核对选择结果。

⚠ 在 CI runner 上必须 `SP_PACKAGE_SCAN_USER=0`：私密路径扫描会拒绝「产物里出现本机账户名」，而 runner 的账户名是 `runner` —— 一个常见词（`tools/package.mjs` 的注释就为这种情况留了这个开关）。真实发布机不要设。

## 安装与启动

1. 将 ZIP 解压到服务器上的独立目录。
2. 使用 Node.js 22 或更高版本。发行时已装好生产依赖并生成 `public/vendor/`。
3. 启动：`node server/index.js`。默认端口 3000，可用 `PORT` / `HOST` 配置；健康检查 `GET /healthz`。
4. 用交互式启动器且不希望跑素材 setup 时：`node scripts/launch.mjs --no-setup --no-open`。不要把 `tools/setup.mjs` 或会自动 setup 的安装流程跑到这台服务器上，除非确实要把素材下载到服务器。

## 资源与 Mod 边界

- 发行包不含 `public/assets/` 的游戏美术、`public/fonts/` 的字体、`packs/` 里预装的内容包，也不含 `docs/my-first-pack/` 与 `docs/examples/` 的样例包载荷。
- 核心 `public/index.html`、CSS、客户端 JS 与官方游戏协议**必须保留**。删掉整个 `public/` 会让当前 Node 服务无法提供可玩的页面。
- `public/js/ui/extensions.js`、`public/js/ui/modComponents.js` 是 Mod 运行时 API，不是预装 UI 覆盖物。现有 UI Mod 依赖面板槽位、组件包裹/替换这些接口，**不能**为了「消除预装覆盖层」而删掉这些兼容点。
- ⚠ 一条实测结论：想要一个「把第三方 UI 附加也剥掉」的更窄产物，在 profile 这一层做不到 —— 打包器的运行时目录白名单包含整个 `public/`，而大厅/房间页面**整份 import** 那些模块，删文件等于毁界面。窄档只能另开一种产物（并接受它没有这些界面），或者由部署方自己不带那些包。
- 发行包不预装 Mod 内容，但保留 Mod Registry / workshop 装载代码。已审核的 Mod 走单独的分发流程安装，不复制进引擎源码树。
- `data/assets.json` 作为资源清单保留。本配置不把核心美术 URL 自动改写成 CDN，也不保证外部 CDN 覆盖了每一项资源。要求「服务器磁盘上始终不存素材」的话，必须另行验收 CDN 映射、CORS、缓存、版本哈希与缺失回退；否则应允许按现有机制获取素材。**不能**把「ZIP 不含美术」理解成「远端资源托管已完成」。

## 验收

```sh
node tools/package-server.mjs --dry-run --list
node --test test/package-server-profile.test.js
npm run ci
npm run golden
```

上线前还应对着 Mod 仓库当前已上架的包逐个做运行时装载、协议通道、房间/对局与 UI 面板验收 —— Mod 索引里的旧加载记录不是新引擎上的复验结果。
