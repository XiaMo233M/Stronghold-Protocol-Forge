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
>
> **`room.*`（房间级意图）的落点不一样**：②落在 `server/lobby.js` 的 `onMessage`（不是 `intents.js` —— 那里只收对局内
> 的 `g.*`），③不适用（`test/match/fuzz.test.js` 的 `GAME` 只从 `g.*` 里取），④落在房间屏
> （`public/js/screens/room.js`，不是 `gameActions.js`），⑤照旧（玩家可见文案要进四个语言包）。先例：`room.setSeatCap`
> （`docs/META.md` §1.9a）与 `room.mods`（§1.9c）。
>
> **给一条既有意图加一个可选字段**（比新意图轻，但那条「两条路都要留」的摩擦一样）：① 同一格加判据 + 登记进
> `$optional`；② 不动（handler 只是多解一个字段）；③ 不动；④ 落在那条意图真正的发出点；⑤ 只有产生玩家可见文字时
> 才要。**加性可选字段不抬 `PROTOCOL_VERSION`**（判据是「推送帧的形状变了」；先例 `records.mine`）—— 但要在
> `shared/protocol.js` 那一格把理由写下来。先例：`room.join.consent`（W7, `docs/design/mod-layer.md` §28.53）。

---

## 2. 加一格 `behaviour` 开关 —— **5 处**

| # | 同步点 | 漏了会怎样 |
|---|---|---|
| ① | `shared/behaviour.js` 的 **`BEHAVIOUR_SWITCHES`** 表加一格（今天 **5 格**：`shopBias` / `prepLoadout` / `morphPairing` / `unequip` / `diyPoolOverlap`） | 声明表里没有的开关被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒** —— 通道通、但响 |
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
| ① | `shared/workshop.js` 的 **`CLIENT_PANEL_SLOTS`**（**今天 10 个**）；宿主若可重复还要登记 **`CLIENT_PANEL_REPEATABLE`**（今天 1 个：`screen.game.shopCard`） | 槽位是**闭枚举**：拼错 / 未登记的槽位 ⇒ 面板**永远不出现**，而且**没有任何错误** |
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
