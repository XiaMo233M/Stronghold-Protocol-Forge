# docs/ — 文档索引

这份文件是 `docs/` 的**入口**：新人（人或 AI）先在这里找到该读哪一份，再进去。

**规则与纪律不在这里** —— 那些在仓库根的 [AGENTS.md](../AGENTS.md)（AI 助手与贡献者的入口：硬规则、怎么验、提交要求）
与 [CONTRIBUTING.md](../CONTRIBUTING.md)（同一份材料的全文版）。`docs/` 只放**领域文档**。

---

## 先读哪三份

| 顺序 | 文件 | 它回答什么 |
|---|---|---|
| 1 | [AGENTS.md](../AGENTS.md) | 硬规则、怎么验、提交与 PR 要求 |
| 2 | [DESIGN.md](DESIGN.md) | **设计的唯一真相**：§0–§31 各自住在哪个文件 |
| 3 | [ARCHITECTURE.md](ARCHITECTURE.md) | 代码地图：东西在哪、数据怎么流、常见改动从哪起手 |

> `DESIGN.md` 与 `docs/research/` 冲突时以 `DESIGN.md` 为准；`DESIGN.md` 没说的看 research；
> 两边都没说的，挑最简单的忠实实现并写进模块头注释。

## 按你想做的事找

| 你想做的事 | 从这读 |
|---|---|
| 改战斗引擎、写干员 kit | [SIM.md](SIM.md) — 引擎 API、钩子、测试台 |
| 改对局流程与商店、备战期 | [META.md](META.md) — 对局与备战引擎、干员练度 |
| 改界面、渲染、棋面 | [design/client.md](design/client.md) |
| 改联网与协议 | [design/network.md](design/network.md) · [NET-TUNING.md](NET-TUNING.md) |
| 写工坊包（mod） | [WORKSHOP.md](WORKSHOP.md) → [MOD-SURFACE.md](MOD-SURFACE.md) |
| **我这份投稿算不算标准包** | [STANDARD-PACK.md](STANDARD-PACK.md) — 七种形态定级、`functional`/`documentation` 判据、非标准的怎么办 |
| 改工坊编辑器 | [EDITOR.md](EDITOR.md) |
| 加语言、改界面文案 | [I18N.md](I18N.md) |
| 改数值与平衡 | [BALANCE.md](BALANCE.md) · [PLAYING.md](PLAYING.md) |
| 动生成的游戏数据 | [DATA.md](DATA.md) — **永不手改** `data/*.json` |
| 部署、打包、发版 | [DEPLOY.md](DEPLOY.md) · [WINDOWS.md](WINDOWS.md) · [UPSTREAM-UPGRADE.md](UPSTREAM-UPGRADE.md) |
| **打发行包、发 release** | [BUILD-RECORD.md](BUILD-RECORD.md) — 发版八步、四个资产的产出命令、踩过的坑、历史版本的实测基线 |
| 素材从哪来、怎么授权 | [ASSETS.md](ASSETS.md) |
| **加东西**（意图 / 开关 / 包字段 / 槽位 / i18n） | [SYNC-POINTS.md](SYNC-POINTS.md) — 要一起改哪几处、漏了怎样、谁拦 |
| 对局战绩与账号 | [RECORDS.md](RECORDS.md) |
| 百卫补丁（100 人版）移植史 | [PS100-MIGRATION.md](PS100-MIGRATION.md) |

## 全清单

### 入口与地图

| 文件 | 是什么 |
|---|---|
| [DESIGN.md](DESIGN.md) | 设计文档的**索引**：每一段 §N 住在 `design/` 还是 `history/`。它自己不含任何段 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 代码地图：目录、数据流、导入边界、golden 语料、常见改动的起手处 |

### 领域参考（不占 DESIGN 段号）

| 文件 | 是什么 |
|---|---|
| [SIM.md](SIM.md) | 战斗模拟引擎（`server/sim`）：给内容作者与对局负责人 |
| [META.md](META.md) | 对局与备战引擎（`server/match`）、商店、协议 |
| [DATA.md](DATA.md) | 生成的游戏数据（`data/*.json`）与生成器 `tools/build-data.mjs` |
| [I18N.md](I18N.md) | 语言：中文、English 与语言包 |
| [BALANCE.md](BALANCE.md) | 难度模型与测量（官方数值，不做自定义调优） |
| [ASSETS.md](ASSETS.md) | 素材来源、布局、清单、致谢 |
| [NET-TUNING.md](NET-TUNING.md) | 网络可调参数（`m.public` 增量帧） |
| [WORKSHOP.md](WORKSHOP.md) | 创意工坊与助战（本项目自行新增） |
| [MOD-SURFACE.md](MOD-SURFACE.md) | mod 表面清单（pack-facing ABI）：一个包能依赖引擎的哪些东西 |
| [STANDARD-PACK.md](STANDARD-PACK.md) | **标准包规范**：七种投稿形态的定级、标准包的四条硬要求、`functional`/`documentation`/`unknown` 判据、非标准形态（补丁型 / 安装器型）怎么处置 |
| [EDITOR.md](EDITOR.md) | 工坊编辑器（可选、独立分发） |
| [PLAYING.md](PLAYING.md) | 玩法指南（给玩家） |
| [DEPLOY.md](DEPLOY.md) | 部署指南（长期开服） |
| [WINDOWS.md](WINDOWS.md) | Windows 便携包（零安装方案） |
| [BUILD-RECORD.md](BUILD-RECORD.md) | **发布流程与构建记录**：发版八步、四个资产各自怎么产、踩过的坑、各版本的实测基线与资产 sha256 |
| [RECORDS.md](RECORDS.md) | 对局战绩与可选账号（`SP_ACCOUNTS=1`） |
| [SYNC-POINTS.md](SYNC-POINTS.md) | **加东西时的同步点清单**：意图 / `behaviour` 开关 / 包字段 / 槽位 / i18n 各要一起改哪几处、漏了怎样、谁拦 |
| [UPSTREAM-UPGRADE.md](UPSTREAM-UPGRADE.md) | 上游更新校对清单：上游发新版后照它走一遍 |
| [PS100-MIGRATION.md](PS100-MIGRATION.md) | 百卫补丁 v0.3（100 人版）移植记录 |
| [PACKS.md](PACKS.md) | **content pack**（内容包）：语言包那套机制 |

> ⚠️ **两个「pack」不是一回事**：`PACKS.md` 说的是 **content pack**（`shared/packs.js`，服务端从文件夹里读的
> 语言 / 素材 / 数据包，走 `/packs/index.json`）；`WORKSHOP.md` 说的是**工坊包**（`shared/workshop.js` 的
> `PACK_FIELDS`，玩家装进 `workshop/` 的 mod）。两套机制、两个索引，互不相干。

### 设计文档（DESIGN 的现在时）

`docs/design/` 下每个 `.md` 都是一个 `§N` 分片，段落号全局唯一、永不改号。

| 文件 | 段 | 是什么 |
|---|---|---|
| [design/overview.md](design/overview.md) | §0 §1 §2 §11 §12 | 范围、技术栈、仓库布局、质量标准 |
| [design/geometry-time.md](design/geometry-time.md) | §3 §4 | 坐标、场地、几何与时间 |
| [design/engine.md](design/engine.md) | §5 §7 | 战斗引擎（`server/sim`）与内容模块 |
| [design/match.md](design/match.md) | §6 §16 | 对局与备战引擎、干员练度 |
| [design/network.md](design/network.md) | §8 §14 | 网络协议与客户端战斗 |
| [design/client.md](design/client.md) | §9 §10 §13 §15 | 渲染、界面、本地素材、3D 棋面 |
| [design/mod-layer.md](design/mod-layer.md) | §28 | **mod 层**：身份、装载、隔离、版本、分发（本仓库最大的一份文档） |
| [design/meta-payload.md](design/meta-payload.md) | §29 | 对局 meta 载荷：包的 `server.meta` |

### 历史（DESIGN 的过去时，一版一段）

每条规则背后的证据与当次修订。**规则改了以后，`design/` 里那条规则也一起改**。

| 文件 | 段 | 是什么 |
|---|---|---|
| [history/v2.2-playtest3.md](history/v2.2-playtest3.md) | §17 | 用户试玩 #3（v2.2） |
| [history/v2.3-playtest4.md](history/v2.3-playtest4.md) | §18 | 用户试玩 #4（v2.3） |
| [history/v2.4-playtest5.md](history/v2.4-playtest5.md) | §19 | 用户试玩 #5（v2.4） |
| [history/v2.5-playtest6.md](history/v2.5-playtest6.md) | §20 | 用户试玩 #6（v2.5）及其后续，直到 0.1.0 |
| [history/0.1.1.md](history/0.1.1.md) | §21 | 0.1.1 — 0.1.0 之后的玩家反馈 |
| [history/0.1.2.md](history/0.1.2.md) | §22 | 0.1.2 — 0.1.1 之后的 GitHub issue |
| [history/0.1.3.md](history/0.1.3.md) | §23 | 0.1.3 — 0.1.2 之后的社区报告 |
| [history/0.1.4.md](history/0.1.4.md) | §24 | 0.1.4 — 0.1.3 之后的社区报告 |
| [history/0.2.0.md](history/0.2.0.md) | §25 | 0.2.0 |
| [history/0.2.1.md](history/0.2.1.md) | §26 | 0.2.1 |
| [history/0.2.2.md](history/0.2.2.md) | §27 | 0.2.2 |
| [history/0.2.3.md](history/0.2.3.md) | §30 | 0.2.3 |
| [history/0.2.4.md](history/0.2.4.md) | §31 | 0.2.4 |
| [history/0.2.5.md](history/0.2.5.md) | §32 | 0.2.5 |

### 更新记录的分卷

[CHANGELOG.md](../CHANGELOG.md) 是**索引 + 最近 8 节**；更早的按大版本分卷在 [`changelog/`](changelog/)，每一卷是
**冻结件**（正文与原文件逐字节相同，一个字都不许改）。顶层那 8 节**不是随便定的** —— 游戏内公告由它生成，
`server/notices.js` 取前 8 条能展示的，**再往下切就静默少发公告**（守卫在
[test/docs-paths.test.js](../test/docs-paths.test.js)）。每一卷的版本清单见 `CHANGELOG.md` 顶部那张表。

### 研究底稿

[research/00-INDEX.md](research/00-INDEX.md) 是这一组的入口。研究文件正文与它的
「Addendum (critic)」不一致时**以 addendum 为准**。这组不对应发行版本，也不占段号。

### 给创作者与 AI 的提示词

| 文件 | 是什么 |
|---|---|
| [prompts/README.md](prompts/README.md) | 这一组的入口与用法 |
| [prompts/kit.md](prompts/kit.md) | 写一个干员 kit 的提示词与依据 |
| [prompts/operator-pack.md](prompts/operator-pack.md) | 写一个干员包的提示词与依据 |

> 这几个文件靠**手写的 `文件:行号`** 把读者带到引擎现场，所以它们受
> [test/promptCitations.test.js](../test/promptCitations.test.js) 门禁。改引擎行号后要跑它。

### 示例

[examples/](examples/) 下是可以照着搭的最小样例与规格（`clementia`、`demo-workshop`、`kit-demo`、
`operator-spec.json`、`stage-spec.json`）。它们**不是包**，不进任何闸门。

### 图片

[img/](img/) 放 README 与文档引用的介绍图。

---

## 改文档前必读的规矩

1. **`docs/design/` 与 `docs/history/` 下的每个 `.md` 必须恰好是一个 `§N` 分片**：标题形如
   `# DESIGN §N, §M — …`，紧跟一行 `Part of` 加一个指回 `../DESIGN.md` 的相对链接。段号全局唯一，
   **永不改号** —— 代码、测试与其它文档都按「DESIGN §N」引用它。
2. **`docs/` 根下的文件不占段号**（`RECORDS.md` 的先例）。所以补充文档放根下，别塞进 `design/`。
3. **`DESIGN.md` 自己不含任何 `## N.` 段**，它只是一张索引表；表里每行点名的段必须恰好是该文件持有的段。
4. **门禁**（改完文档至少跑这三条）：

   ```bash
   node --test test/docs-paths.test.js test/docs-consistency.test.js test/promptCitations.test.js
   ```

5. **引用纪律**：文档里的 `文件:行号` 会随代码位移漂移，而漂移不会自己报错。手写行号时优先写成
   **符号锚点**（段号、导出名、函数名）；确需写行号时，改完代码必须回来重指。
