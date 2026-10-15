# 同步点清单 —— 加东西时要一起改哪几处

**为什么要有这一份**：这个仓库里「加一个东西」从来不是改一个地方。少改一处，失败的方向往往是**静默**的 ——
包装上了、界面开了、动作发出去了，只是**什么都没发生**。这一份把每条链路的**全部落点**写死在一处，
并点明**漏了以后看到什么**和**哪个测试会红**。

**怎么用**：动手前先在下面找到你要加的那一类，照那一行一行走完；收尾跑它点名的测试。
**这一份是清单，不是规则** —— 规则在 `docs/design/` 与各领域文档；两处不一致时以**代码与测试**为准
（是它们真的在拦）。

> 发现新的「加 X 要改 N 处」？**加进这份文件**，别只留在 commit message 里。

---

## 1. 加一个 `C2S` 意图 —— **5 处**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/protocol.js` 的 **`C2S`** 表加一条（可选字段登记进同一条的 `$optional`） | 协议层当场 `BAD_MSG` 拒收 —— 意图**到不了服务端** |
| ② | `server/match/match/intents.js` 加 `case '…'` 分支 | 消息过了协议层、**没人处理**：客户端发了、服务端什么都不做，**没有任何报错** |
| ③ | `test/match/fuzz.test.js` 的 **`randomIntent`** 给它一个合法形状（该文件的 `GAME` 是从 `Object.keys(C2S)` 现推的，所以新意图**自动进名单**，但生成器要会造它） | **全量当场两条红**（fuzz 造不出、或造出判不过的消息） |
| ④ | `public/js/ui/gameActions.js` 加「动作 → 意图」映射 | 界面上**没有发出它的入口** ⇒ 这个意图永远不会被发出来（哑） |
| ⑤ | **i18n 词条**（仅当它产生玩家可见文字：错误提示、动作标签、toast）：`public/i18n/{en,ja,ko,zh-TW}.json` 四个包都要有。代码里的中文源串走 `t('中文')` | 界面显示**中文源串原样**或空白（英文 / 日文 / 韩文 / 繁中玩家看到不一致的界面） |

**钉它的测试**：`test/match/fuzz.test.js`（③）· `test/protocol*` / 各 `test/match/*.test.js` 里按消息驱动的那些（①）·
`test/docs-consistency.test.js`（`C2S` 里几条形状被逐句钉住）· i18n 判据 `node tools/i18n.mjs check --all --strict`（⑤）。

> **有意的摩擦**：`$optional` 与判据两条路都要留 —— `$optional` 管「键根本没出现」，判据里的
> `v === undefined || v === null` 管「显式给了 null」。只留一条，包就会把一个合法消息当成缺字段。
>
> **`C2S` 是作者可见的表面**：`server/modDispatch.js` 把它复制进交给包的 `c2s`。表里漏一条，
> 包就会把一个合法消息判成缺字段。

---

## 2. 加一格 `behaviour` 开关 —— **4 处**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/behaviour.js` 的 **`BEHAVIOUR_SWITCHES`** 表加一格（今天 **4 格**：`shopBias` / `prepLoadout` / `morphPairing` / `unequip`） | 声明表里没有的开关被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒** —— 通道通、但响 |
| ② | **引擎侧的执行点 / 读取点**（改那条规则的地方） | 开关**声明得下、却什么都不改** —— 正是这一格存在的理由就是「不许声明了没做」 |
| ③ | `shared/modSurface.js` 的 `behaviour` 条目锚点（`{ symbol: 'BEHAVIOUR_SWITCHES', module: 'behaviour' }`） | `test/modSurface.test.js` 红：表面清单点名的锚点符号找不到 |
| ④ | `test/packBehaviour.test.js` 用**合成表**把失败分支逐条走一遍 | 新开关的拒绝分支没有守卫 |

**钉它的测试**：`test/packBehaviour.test.js` · `test/modSurface.test.js` ·
`test/modSurface.test.js` 的「引擎里每一个『包可声明的名单』都被某条表面引用」那一条（**加了名单却没进表面清单也红**）。

> **首格必须与它的引擎实现点同刀**。表里今天一格都没有，正是这条纪律的产物：
> 一格开关只在「它与它的执行点」一起进仓库时才有意义。`shared/modSurface.js` 那一行**明说今天没有执行点**。
>
> 两条硬闸门：这个包**必须 `combat: true`**（`BEHAVIOUR_NEEDS_COMBAT` —— 一格的入场券本就是「它改一条规则」）；
> 它**不是贡献项** —— 一个只带 `behaviour` 的包照旧 `EMPTY_PACK`（与 `variants` / `support` / `playtest` 同一条）。

---

## 3. 加一个包字段（`pack.json` 顶层键）—— **4 处**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/workshop.js` 的 **`PACK_FIELDS`**（**今天 37 键**） | 作者写它 ⇒ `PACK_UNKNOWN_FIELD` **整包拒**；字段在这一层就是**闭集** |
| ② | 同文件的 **`normalizePackManifest`** 加解析分支 | 键合法了、**归一化时被丢掉** ⇒ 作者看到「pack.json 合法、包加载了、可我写的那件事没发生」 |
| ③ | `server/workshop.js` 的 **`identifyPack`** 的哈希清单 | **能改变一端行为的声明不进哈希** ⇒ 同一个摘要下出现两种行为（§28.2） |
| ④ | `docs/MOD-SURFACE.md` 那一行（表面清单） | 文档与实现分叉；`test/modSurface.test.js` 红 |

**钉它的测试**：`test/modSurface.test.js` · 该字段自己那一批（例：`behaviour` → `test/packBehaviour.test.js`、
`forms` → `test/packForms.test.js`、`notices` → `test/packNotices.test.js`、`variants` → `test/workshopVariants.test.js`、
`assets` → `test/packAssets.test.js`）。

> 三条同时要定：**(a)** 解析分支 · **(b)** 它**算不算贡献项** · **(c)** 进不进身份哈希。
> 还有一条易错：**不声明时不许长出这个键** —— 无条件写一个空数组会换掉**所有已发布包**的内容哈希。

---

## 4. 加一个 `client.panels` 槽位 —— **3 处**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/workshop.js` 的 **`CLIENT_PANEL_SLOTS`**（**今天 9 个**）；宿主若可重复还要登记 **`CLIENT_PANEL_REPEATABLE`**（今天 1 个：`screen.game.shopCard`） | 槽位是**闭枚举**：拼错 / 未登记的槽位 ⇒ 面板**永远不出现**，而且**没有任何错误** |
| ② | **客户端渲染点**：该槽位的宿主元素。两档 —— **组件自己渲染** `[data-mod-slot="…"]`（如 `public/js/screens/game.js`、`public/js/ui/bondStrip.js`、`public/js/ui/detailPanel.js`、`public/js/ui/shopBar.js`）；**浮层**那一档由 `public/js/ui/extensions.js` 的 `MOD_PANEL_SLOTS` 与注册点负责 | 面板挂到一个**不存在的容器**上 ⇒ 静默不显示 |
| ③ | `test/modPanelWraps.test.js` | 两处名单（形状层副本 / 客户端真相）没人钉在一起 ⇒ 可以各说各话 |

**钉它的测试**：`test/modPanelWraps.test.js` · `test/modClientPanels.test.js` · `test/modClientHosts.test.js` ·
`test/modSurface.test.js` · `test/modPluginPackDelivery.test.js`。

> **两份名单是两个命名空间**：`CLIENT_PANEL_SLOTS`（插进哪个**位置**）与 `CLIENT_WRAP_COMPONENTS`
> （哪个**组件本身**被改写，今天 4 个）不能互相替代。可重复宿主那一档还要给 `ctx.hostKey` 一个键
> （商店卡那个键就是棋子的 id）。

---

## 5. 加一条 i18n 词条 —— **1 处 + 1 条判据**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `public/i18n/{en,ja,ko,zh-TW}.json` **四个包都要有**（中文是源语言，串写在代码里过 `t('中文')`） | 那一档语言的界面回落到中文源串 / 空白 |

**判据**：`node tools/i18n.mjs check --all --strict`（`--all` 查所有语言包，`--strict` 让警告也退非零）。

> 只加一个语言包不算完成 —— 这条判据是**跨包**的。

---

## 6. 改文档 / 改规则

| 场景 | 同步点 | 判据 |
|---|---|---|
| **改一条规则** | `docs/design/`（现在时）**与** `docs/history/`（那一版的修订与证据）**一起改**；段号**永不改号** | `node --test test/docs-paths.test.js test/docs-consistency.test.js` |
| **加一份 `docs/design/` 或 `docs/history/` 的文档** | 它必须恰好是一个 `§N` 分片：标题 `# DESIGN §N, §M — …`，紧跟一行指向 `../DESIGN.md` 的链接；并登记进 `docs/DESIGN.md` 的索引表 | 同上（`docs-paths` 会逐份检查） |
| **加一份 `docs/` 根下的文档** | **不占段号** —— 照 `RECORDS.md` / `SYNC-POINTS.md` 的先例放根下，别塞进 `design/` | 同上 |
| **改了引擎的行号** | 手写 `文件:行号` 要**重指**（不是加偏移，要按内容对位） | `node --test test/promptCitations.test.js` |

> **引用纪律**：手写的 `文件:行号` 会随代码位移漂，而漂移**不会自己报错**。优先写**符号锚点**
> （段号、导出名、函数名）。`docs/prompts/` 与 `docs/design/` 里的行号引用**已经**受
> `test/promptCitations.test.js` 门禁看着。

### 一笔记在案的旧账（对账用）

`v0.16.0-0.2.4` 的 **release 正文**里写着「既有 **5 处**漂移未修、留待单独重数」。**release 正文是已发布的
冻结件，不改**；但那句话对今天的仓库已经不准了 —— 那 5 处**已全部收掉**：

| release 里记的 5 处 | 现状 |
|---|---|
| `server/data.js:144` | 已按内容重指：`lookup` 的 null 分支现在是 `server/data.js:156-159` |
| `server/workshop.js:412`（记了两处） | 已按内容重指：`KIT_ID_COLLISION` + `definedBy` 现在是 `server/workshop.js:1249-1253` |
| `public/js/battle/runner.js:127` | 已按内容重指：浏览器那份模块清单现在是 `public/js/battle/runner.js:230-233` |
| `server/net.js:676` | 已收掉：`:676-677` 是 `}` 与一句注释；真正做那件事的是 `server/net.js:715-716`（`version mismatch: server <PROTOCOL_VERSION>`），`docs/NET-TUNING.md` 已重指 |

**别再拿旧 release 的说法对账** —— 以本文件与 `test/promptCitations.test.js` 为准。

> ⚠️ **还有一处**：`docs/NET-TUNING.md` 自己有 **56 处**手写 `文件:行号`（`docs/` 根下最多的一份），
> 而它**不在**上面那条门禁里（门禁只扫 `docs/prompts/` 与 `docs/design/`）。改网络参数时**手工核对**它。
> 同样在门禁外的还有 `docs/PS100-MIGRATION.md`（9 处）、`docs/EDITOR.md`（2 处）、`docs/DEPLOY.md`（1 处）。

---

## 7. 改「表面」（表面清单是给社区 mod 的冻结接口）

`docs/MOD-SURFACE.md` 与 `shared/modSurface.js` 是同一张表的两个面。**改名、挪文件、换形状**等于
**静默**打断社区 mod（数据照装、界面照开，只是没有声音 / 没有数值 / 没有天赋）。

**同步点**：`shared/modSurface.js` 那一行（`anchors` / `files` / `tests` / 设计稿小节）+ 那一行点名的实现文件 +
`docs/MOD-SURFACE.md` 的那一行。

**钉它的测试**：`test/modSurface.test.js` —— 它会断言**锚点符号还在声明的模块里**、**实现文件与测试文件都还在**、
**文档的那一行还在**，以及**引擎里每一个「包可声明的名单」都被某条表面引用**（加了一格却没进清单**也红**）。

## 8. 加一格 `server.modules` 的挂载点（`SERVER_MODULE_USES` 闭枚举）—— **6 处**

以 §28.54 的 `lane` 为实例（今天闭枚举 7 格：`boot` / `shutdown` / `matchClass` / `healthz` / `metrics` / `route` / `lane`）。

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/workshop.js` 的 **`SERVER_MODULE_USES`**，**加在末尾** | 作者写它 ⇒ `MODULES_BAD_USES` 整包拒。加在末尾是因为归一化结果按这张表的次序输出（`uses: SERVER_MODULE_USES.filter(...)`）—— 插在中间会**改掉现存包的摘要** |
| ② | 同文件 **`SERVER_MODULE_FIELDS`** + 解析分支（新声明字段时） | 键合法但被丢掉 ⇒ 「包加载了、我写的那件事没发生」；`MODULES_UNKNOWN_FIELD` 也就永远不会替作者纠错 |
| ③ | `server/modModules.js`：`moduleHost` 上的门面 + 装载循环里的登记（**没声明就抛 `MODULE_USE_UNDECLARED`**，不是 `undefined`） | 交出一个 `undefined` 只会变成一行 `TypeError: not a function`，作者分不清是「没声明」还是「拼错了」 |
| ④ | **能力闸门**：这一格能不能改对局结果？能 ⇒ 必须要求 `combat: true`（照 `MODULES_NEED_COMBAT` / `MATCHKINDS_NEED_COMBAT` 的写法） | 「不声明 combat 的包改不了结果」从结构性保证退化成一句口号 |
| ⑤ | `shared/modSurface.js` + `docs/MOD-SURFACE.md` + `docs/WORKSHOP.md` 各一行/一节 | `test/modSurface.test.js` 红；文档与实现分叉 |
| ⑥ | 新测试加进 `test/` **并且**加进 `.github/workflows/mirror-upstream-forge.yml` 的 `CONTRACT` 数组；同时把改过的上游文件登记进 `.github/overlay.json` 的 `patches`（带锚点） | 闸门会在「什么都没跑」的情况下报绿；下一次同步把我方那一格**静默吃掉**（新增文件丢了自己会响，插入体丢了是静默的） |

## 9. 加一格客户端整屏声明（`client.screens` 这类「C 层新声明面」）—— **4 处**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/workshop.js`：闭枚举（`CLIENT_SCREEN_ROUTES`）+ 字段闭集 + 解析分支 + **`client` 块的「至少说出一件能用的事」判据** | 声明进不了清单，或反过来 —— 一个只声明空 `client` 的包被当成「有客户端界面」 |
| ② | `server/workshop.js`：装载期的文件判据（`panelModuleIssues` 现在同时收 panels 与 screens）与**投递**（合成同一份线表）；`identifyPack` 里源码字节进摘要 | 包合法、URL 永远 404；或两份不同的界面共用同一个摘要 |
| ③ | `public/js/ui/extensions.js`：**客户端那份名单**（`MOD_SCREEN_ROUTES` / `MOD_PANEL_SLOTS`）+ 挂载 / 卸载 / 失败方向 | 两处名单各说各话 —— 作者写出「声明合法、客户端永远不调用」的死格子。所以 `test/modClientScreens.test.mjs` 直接读源码文本把两份钉成同一份 |
| ④ | `docs/MOD-SURFACE.md` + `shared/modSurface.js` + `docs/WORKSHOP.md` + `test/`（并进 `CONTRACT`）+ `overlay.json` 登记 | 同 §8 的 ⑤⑥ |

## 10. 越一次本体路径（`.github/overlay.json` 的 `bodyPaths` 受控例外）—— **5 处**

以 §28.55 为实例（`server/lobby.js`：「空席就销毁房间」那句话住在大厅里，没有别的挂载点）。这条红线的判据
2026-10-15 从「与本体 `sganggs` 的路径交集**必须为 0**」改成「每一处交集都必须是**已登记且锚点在位**的受控例外」——
放宽的是**证明方式**，不是红线本身，而且它**不放松**另外两条（`manager-only-check` 仍然要求增量属于管理器那一层）。

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | 先问「**有没有不改本体的现成入口**」：`startServer(opts)` 那类参数（§28.54 就是靠 `opts.wsLanes` 才没动 `server/index.js`）、包自己的 `install(room)`、`server/modServer.js` 那类启动器 | 跳过这一步，本体路径会越描越多，最后每一格都得靠登记活着 |
| ② | 改法必须是**最小替换**，且**默认路径与从前逐字相同**（§28.55：两处 `disposeRoom(room, 'empty')` ⇒ `reapEmptyRoom(room)`，没人申请时后者**就是**原来那一行） | 「登记过」变成一张空白支票：一个能力悄悄改掉宿主默认行为，而读登记的人看不出来 |
| ③ | `.github/overlay.json` 的 `bodyPaths`：`file` + `why` + **至少一条 `anchors`**，且锚点要取**我方插入体里独有的那段文本**（不是上下文里本来就有的行） | 锚点丢了 ⇒ 下一次同步把我方插入体弄掉而没人知道（`.github/game-overlap-check.mjs` 逐条核对，丢了拦同步）；抄来的锚点恒真 = 等于没锚 |
| ④ | `docs/design/mod-layer.md` 那一节**写明为什么必须动它**（§28.55 末尾那段），`shared/modSurface.js` 的 `requires` 里带 ⚠ 那一条 | 后来人只看到「本体路径被改了」，看不到「为什么没有第二条路」，于是要么回退要么再开一格 |
| ⑤ | 对外口径跟着改：闸门输出行是「N 处受控例外，锚点在位」，**不能**再写「与本体零交集」 | 报告里引用成 0 就是伪造证据 |

## 11. 抬一次发行版本号（`APP_VERSION`）—— **9 处**（0.18.7 那一版漏了两处，CI 当场判红）

tag 是 `modmgr-v<APP_VERSION>-<UPSTREAM_VERSION>`；`test/version.test.js` 判「四处同源 + CHANGELOG 首节 + README 徽章」，
`test/promptBaseline.test.js` 把 README 与 `docs/prompts/*` 里每一条「本仓库 x.y.z」/「this repo's own version is x」都当声明来判。

| # | 同步点 | 谁拦 / 漏了会怎样 |
|---|---|---|
| ① | `shared/constants.js` 的 `APP_VERSION` | `test/version.test.js`（四处同源的第一处） |
| ②③④ | `package.json` 的 `version` + `package-lock.json` 的**根 `version`** 与 `packages[""].version` | 同上；只改一处 = lock 与包名版本自相矛盾，`npm ci` 会按 lock 走 |
| ⑤ | `CHANGELOG.md` 新加一节 `## x.y.z — 日期`（**顶层那一段必须仍能发满 8 条公告**） | `test/version.test.js` 判首节 == `APP_VERSION`；`test/docs-paths.test.js` 判顶层仍能发满 `NOTICE_LIMITS.announcements`；少一节是**静默**少一条玩家公告 |
| ⑥ | `README.md` 顶部 shields 徽章 `badge/version-<x.y.z>-`（`-` 要写成 `--`） | `test/version.test.js` 用正则按 `APP_VERSION` 重建徽章名 —— 这一处最容易漏 |
| ⑦ | `README.md`「版本号怎么读」表里 `APP_VERSION` 那一行的**取值** | 值本身被 `promptBaseline` 判；⚠ 同一格里那个常量**行号引用**（`` `:34` ``）**没有任何测试判** —— 往 `shared/constants.js` 上面插一行就会静默漂错，是这九处里唯一的纯静默面 |
| ⑧ | `README.md` 中文「本仓库自己的版本是 x.y.z」+ 英文段 `this repo's own version is **x.y.z**` 与那行的 tag 示例 `v<x>-<上游>` | `test/promptBaseline.test.js`（两类都扫）；只改中文不改英文 ⇒ 英文那条判据红 |
| ⑨ | `docs/prompts/README.md` 与 `docs/prompts/kit.md` 的「**本版基线**」行 | `test/promptBaseline.test.js`；这两格在 0.18.7 那版就是漏抬的，CI 红过一次 |

⚠ ①–④ 与 ⑤ 都在**本体也有的路径**上（`shared/constants.js` / `package.json` / `package-lock.json` / `CHANGELOG.md` / `README.md`）
⇒ 抬版本本身就是「每轮同步都要复核的受控例外」：`.github/overlay.json` 的 `bodyPaths` 锚点写的就是这些新值，
抬完不改锚点 ⇒ `game-overlap-check` 拦同步（那是有意的：**没留下证据的越线**才算越线）。
`UPSTREAM_VERSION` 那一半**不在这里** —— 它与 `docs/history/` 最新一节由 `test/docs-consistency.test.js` 钉在一起。


