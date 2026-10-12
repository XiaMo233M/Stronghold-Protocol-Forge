# 署名与来源 · PROVENANCE

## 包

| 项 | 值 |
|---|---|
| 包 id | `mod-xie` |
| 版本 | `2.1.0` |
| 名称 | 促融共竞 · 协同共竞 |
| 目录名 = 包 id | 是（引擎逐包判 `PACK_ID_MISMATCH`，不一致会被拒） |

## 原作者 / 上游

**jingjiangze** —— `pack.json.author` 原文。

- 玩法上游：本包的服务端经济/救援层，最初写在我们自己的 fork（`Stronghold-Protocol` 的 `master-play` 分支）与自研安装器形态的
  v1 MOD（`stronghold-mod-xie`）里；v2 起改为工坊包形态，服务端逻辑一字未改地搬进 `server/`。

## 许可

`GPL-3.0-or-later`（`pack.json.license` 原文）。

## 来源

- 原件：本包的前身 = v1 MOD（运行时猴补丁形态，含 `boot.template.mjs` 与安装器）与 v2 工坊包（`server.modules[]` 里带
  `channels` 的版本，曾以投稿 `5ab25ef07906` 上传到工坊站，并由站侧维护者改写为 `mod-xie 2.0.0`）。
- 本版（2.1.0）= 在 v2 之上按业主 2026-10-12 的口径改玩法，并**去掉引擎不认识的 `server.modules[].channels`**
  （引擎的模块字段是闭集 `id / entry / uses / write`，写了整包被 `MODULES_UNKNOWN_FIELD` 点名拒绝）。

## 改了什么（2.0.0 → 2.1.0）

| 面 | 改动 |
|---|---|
| 借钱 | 按钮 = **广播**给其余全体队友（不再选人）；**每人各自可借 1**；一人同意**不**关掉其他人的提示（其余的不自动关闭）；服务端随广播下发一句随机喊话，客户端把它挂到喊话人的头像框右侧 |
| 复活 | 从「单人捐 LP」改成 **全体队友同意 + 共享池按人头扣款**：每人 `5 + 5 × 已复活次数`（5 / 10 / 15…，依次叠加）；bot 自动同意 |
| 后勤项目 | **满级 4 级**（成本 4/8/12/16）；一个人点击 = 发起提案，**其余队友同意**后才从共享池扣款升级；bot 自动同意 |
| bot | 借款意愿 `basePct` 10 → **75** |
| 契约 | `pack.json` 不带 `channels`；投递白名单 = `client.panels[].messages`（新增 `vote` 通道） |
| 面板 | 键与服务端视图**逐键对齐**（2.0.0 的「面板读一套键、服务端发另一套」是按钮点不动的根因）；同意按钮与借钱按钮同款样式 |

## 自带素材来源

**不带任何素材。**（`data/` 是规则数值与官方模式记录留档，`docs/` 是玩法文档。）

## 校验

- `node --test mod-xie/test/module.test.mjs` —— 9/9（含三条新规则：广播借钱 / 全票复活 + 池价递增 / 升级提案与满级 4）
- `node --test test/modxiePackLoads.test.mjs` —— 2/2（引擎装载器零拒绝；面板声明与投递白名单一致；包自足）
- `node --test test/modxieServerE2E.test.mjs` —— 1/1（真服务器 + 真对局：命令通道被 `Match.handlePackMsg` 消费，
  对照组包照旧回显）
