<!--
  吸收说明（我方维护方加，非原文）：本文档吸收自下游 fork `jingjiangze/Stronghold-Protocol-Forge`，
  其中提到的仓库名 / 分支名 / 路径名属**对方**语境；我方口径以本仓（`XiaMo233M/Stronghold-Protocol-Forge`）为准。
  原文一字未改，说明只加在顶部。
-->
# 上游 PR 账本（谁提的、现在在哪、还要不要合）

维护对象 = `XiaMo233M/Stronghold-Protocol-Forge`（模组管理器的维护方仓）。
本文件的存在理由：**「上游的 PR 该不该合进我的分支」这个问题不能靠记忆回答**——2026-10-14 就撞过一次：
删陈旧分支时把一条**开着的** PR 的头分支一起删了（GitHub 连带关 PR），事后只能从时间线倒查。

复核方法都写在表里，照做一次就能重演结论（判据是 blob 哈希，不是「我记得」）。

| PR | 内容 | 现状 | 现在住在哪 | 我还要不要合 |
|---|---|---|---|---|
| **#32** | `tools/workshop-validate.mjs` 大份 JSON 在 POSIX 管道上被 `process.exit()` 截断 ⇒ 改 `exitCode` 自然退出 | **open**（14:10 被我的分支清理误关，已原样恢复头分支并重开） | 上游**未收**（main 里还有 2 处 `process.exit(report.errors ? 1 : 0);`）；我的 `master` 有 | **内容已在 master，逐字节相同**（`0f0ff4ba19` = PR 头 = master）。等维护方收；收了之后按 `.github/overlay.json` 的 `patches[0].retireWhen` 删我这份叠加 |
| #2 | 包通道进对局 `server.modules[].channels` + `Match.handlePackMsg` | closed（未点 merge，内容被吸收） | 上游 main：`server/index.js` 命中 `handlePackMsg`、`test/modMatchChannels.test.mjs` 在 | 不合。我的 `master` 就是上游 main 的叠加，已含 |
| #3 | 管理器闭环 registry + 依赖冲突裁决 + `target` | closed（内容被吸收） | 上游 main：`server/modRegistry.js`、`test/modRegistry.test.mjs` 在 | 不合（同上） |
| #4 | 宿主用数据注册 WebSocket 升级路径（§28.44） | closed（内容被吸收，**实现换了形状**） | 上游 main：`server/http/wsLanes.js` + `test/wsLanes.test.js`（我的 `.mjs` 版本是被取代的旧写） | 不合。再合会把同一功能塞两遍 |
| #5 | 宿主用数据注册请求路径表（§28.45） | closed（内容被吸收） | 上游 main：`server/http/httpLanes.js` 命中签名 + `test/httpLanes.test.js` | 不合 |
| #6 | 作者侧校验器读服务器那份 `coreRouteShadow` | closed（内容被吸收） | 上游 main：`shared/workshopValidate.mjs` 命中 `coreRouteShadow`、`test/workshopValidateRoutes.test.js` | 不合 |
| #8 | 启用声明 `pack.json.enabled`（装好 ≠ 生效） | closed（内容被吸收） | 上游 main：`shared/workshop.js` 命中 `enabled`，CHANGELOG 也提到 `enabled` | 不合 |
| #9 | mod-xie v2.1 工坊包 | closed（**引擎侧未收**，`merge_sha c2771fc14a` 不在上游历史里：diverged / behind 47） | 它是**内容包**不是引擎码：正式发行物在工坊站 `mod-xie/2.1.0/mod.zip`；仓侧两个 e2e 测试（`test/modxiePackLoads.test.mjs`、`test/modxieServerE2E.test.mjs`）随源分支删除，**恢复指针** = tip `5f8e2d09b4e92a3a41d28709cded369ec4702063` | 不合进引擎分支。要复活测试就从那个 tip 取，且只在包体就位后再取（否则净新增红） |
| #10 | 上游 0.2.4 → 0.2.5 同步（发行标识） | closed | 已被后续同步取代；`test/ui/random-boss-pairs.test.js` 未进上游，恢复指针 = tip `6af6ec957185518a91bc2f44b81e8b56a77df255` | 不合 |

## 与卫戍协议本体（`sganggs/Stronghold-Protocol`）的关系

- **不由我合**：维护方自己吃游戏本体（现 `APP_VERSION 0.18.4` / `UPSTREAM_VERSION 0.2.6`，而 sganggs `master` 就是 `0.2.6` ⇒ **落差 0**）。
  自己直接对 sganggs 的代价已量化过：与 `v0.2.2` 基线在 671 个交集文件里 123 个内容不同。
- **结构性不冲突**：我的叠加层是 **14 个文件**，与 sganggs `master` 的 1477 个条目**路径交集为 0**
  （含我唯一改动的那个上游文件 `tools/workshop-validate.mjs` —— 本体仓里根本没有这个路径）。
  ⇒ 维护方下一次吃 sganggs 时**不可能撞上我的代码**，因为我的东西全在管理器自己的面上。
- 这条不是口头承诺：`.github/game-overlap-check.mjs` 每次同步都现取 sganggs 的文件清单来比，
  一旦我的增量里出现「本体仓也有的路径」就 **exit 1 拦下合并**，并要求把它挪到管理器命名空间或改走适配层。

## 复核命令（照抄即可）

```sh
# ① PR 头与 master 的字节比较（#32）
gh api repos/jingjiangze/Stronghold-Protocol-Forge/git/trees/aa329406e82e7b61e30180f7acc64d6101355084?recursive=1 \
  --jq '.tree[]|select(.path=="tools/workshop-validate.mjs")|.sha'
gh api repos/jingjiangze/Stronghold-Protocol-Forge/git/trees/master?recursive=1 \
  --jq '.tree[]|select(.path=="tools/workshop-validate.mjs")|.sha'
# ② 上游有没有收我的修复（数被截断的写法）
gh api repos/XiaMo233M/Stronghold-Protocol-Forge/contents/tools/workshop-validate.mjs?ref=main --jq .content | base64 -d | grep -c 'process.exit(report.errors'
# ③ 与本体仓的路径交集（0 才算不冲突）
node .github/game-overlap-check.mjs --work <master树> --up <上游树>
```

最后核对时间：2026-10-14（`master` = `1c620dca92`，上游 main = `7a311a2189`，本体 `0.2.6`）。
