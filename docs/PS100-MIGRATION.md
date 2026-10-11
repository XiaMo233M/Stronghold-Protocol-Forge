# 百卫补丁 v0.3（100 人版）移植记录

> 对象：第三方交付物 `百卫补丁-v0.3`（基于**上游 v0.2.1**），解出的真补丁 `_up/sp100/sp100.patch`
> （389146 字节，SHA-256 `D5A5BE4E…B7E9D6`，与 `Install-SP100.ps1` 内的声明一致）。
> 本仓库 = Forge 分支（自研 0.14.0 + 上游 0.2.3），所以**不是** `git apply` 就能过去的局面：补丁的
> 52 文件 / 104 hunk / +3980 −183 里，一部分与上游 0.2.3 的差异撞车，一部分是设计级改动。
> 本文记录**逐 hunk 的判定**、**已落地的移植**、**待裁决的设计级改动**，以及**把补丁打到本仓库所需的部署参数**。
>
> **现状补记（业主裁令 2026-10-12，本文正文是当时的历史记录，不追改）**：座位**缺省上限**已由 4 改成 **20**
> （`DEFAULT_MAX_SEATS`，`SP_MAX_SEATS=N` 可加；`SP_MAX_SEATS=4` 回到官方那一档），而 `MAX_SEATS = 4` 不变。
> 超容变体的闸门也由「房间容量 > 4」改成「**在场参与者数 > 4**」（`Match.variant`），所以**容量 20、只坐 4 人**
> 仍走原路径 —— 本文里所有「≤ 4 座逐字节等价」的结论按「**≤ 4 名参与者**」读。快速匹配的队列门槛固定为
> 「一间官方房 = 4」，不跟随缺省上限。接口、同抬项与强刷提醒见 `docs/NET-TUNING.md` §2.3、`docs/META.md` §1.9b。

## 1. 结论

- **可直接移植的部分已落地**：座位上限可配置、活敌上限按战场人数缩放、首领血量上限不再被 4 人封顶、
  单人/独狼准备阶段的死锁。四处都在 `≤ 4 座` 时**逐字节等价**（§4 逐条证明）。
- **四项设计级改动未动代码**：每人独立牌库、机变按小队并发、`unite100.mjs` 100 人联防、
  UI 100 张座位卡。它们要么依赖彼此，要么改变玩法平衡，**需要业主裁决**（§6）。
- **一处硬阻塞**：补丁把 `BOSS_HIT_LIMIT` 由 `300000` 改成 `Infinity`，而本仓库有
  `test/docs-consistency.test.js` 与 `test/sim/playtest6_limits.test.js` **硬断言它等于 300000**。
  改默认值 = 放松既有断言，与业主要求冲突 ⇒ 未改（§5）。

## 2. 逐 hunk 映射（104 个）

用 `_up/sp100/match-hunks.mjs` 按 `git apply` 的语义（逐个 hunk、带累计 offset、允许 fuzz）
对我们树逐 hunk 匹配，判定分布：

| 判定 | 数量 | 含义 |
|---|---|---|
| 新增文件 | 14 | 树里没有，纯新增 |
| 直接可应用（含带 offset） | 55 | 上下文逐行一致，`git apply` 自己就能落 |
| 上下文冲突但语义清楚 | 27 | 我们这边（0.2.3 或 Forge 改动）挪动了上下文行；语义唯一，可手工落 |
| 语义冲突需裁决 | 8 | 与设计级改动绑在一起，单独落会留下悬空引用 |

**警告：不要用 `apply-check.txt` 当冲突面的依据。** 它只有 385 行，`git apply --check` 在**每个文件里只报
**第一个**失败的 hunk（`error: patch failed: <file>:<line>` 之后就跳到下一个文件），所以它把 33 个冲突 hunk 报成
19 行、漏掉同一文件里后续的冲突。真实的逐 hunk 判定要用带 offset 与 fuzz 的匹配器重算（`_up/sp100/match-hunks.mjs`
→ `hunk-match.json`）；`hunk-classification.json` 与 `hunk-match.json` 是这次移植的审计依据，保留。

（`_up/sp100/hunk-match.json` 是逐 hunk 的原始判定。）

### 2.1 语义冲突需裁决（8 个 hunk）

| 文件:hunk | 改什么 | 为什么不能单独落 |
|---|---|---|
| `server/match/match/spDraft.js` h1/h2/h3 | 机变改为「每小队 6 张、25 队并发」，卡池从公共广播改为每人私密视图 | 与 §6-B 同一件事；依赖 `m.sp` 由对象改成按小队数组，客户端读 `priv?.sp` 而非 `pub?.sp` |
| `server/match/match/unitePhase.js` h1 | 联防由单战场改为「每小队一个战场 + 阶段 2 第二轮战场」 | 依赖新增 `unite100.mjs` 与 `combineUniteResults`；共 189+/11− |
| `server/match/player/economy.js` h1 | 商店抽卡改走**玩家自己的**牌库 | §6-A 每人独立牌库的取用点之一 |
| `server/match/player/diy.js` h1 | 同上（自选库存路由） | 同上 |
| `server/match/player/views.js` h1/h3 | 同上（视图口径） | 同上 |
| `server/match/PlayerState.js` h1/h2 | 新增 `PlayerRules` 方法容器并挂到方法链**最后** | 同 A；且 `PLAYER_PARTS` 列表我们已多一项 `PlayerSupport` |
| `server/index.js` h2 | `SP_COMBAT=server` 时**硬拒绝启动** | 部署策略，不是玩法：作者依据是「单局峰值 CPU 25–90 s > 一回合墙钟 15–30 s」。我们树默认就是 client 战斗，且 Forge 另有 `server/match/match/clientCombat.js` 改动，需业主定 |

### 2.2 上下文冲突但语义清楚（19 个文件，27 hunk）

已落地的见 §3；**未落地**的（属于设计级，或纯 UI）：

| 文件 | 冲突来源 | 落点 |
|---|---|---|
| `shared/protocol.js` h1 | `room.addBot` 前后我们多了 `room.setAiPicksLast`（GitHub #338） | 补丁这条是新增 `room.setListed`（在线人数与公开房间列表）。**注意**：这不在补丁作者列的四簇里，且本仓库的 `server/lobby.js` 已有 `setListed` 相关基础设施 ⇒ 判定为**重复/不需要**，未落 |
| `data/config.json` h1 | `data/` 已被 0.2.3 重新生成；补丁是单行整体替换 | 只取 `bossHpScale.aliveFull` 的语义（§3.3），**不整行替换**（那会回退 0.2.3 的全部数据） |
| `shared/constants.js` h1 | `MAX_SEATS = 4` 位置从 59 行漂到 59 行但上下文不同 | 已落（§3.1） |
| `server/sim/battle/spawns.js` h3 | 文档注释我们已多一个字段 `inTotal` | 已落（§3.2） |
| `public/css/screens/*.css`、`public/js/screens/{title,room,game}.js`、`public/js/ui/teamPanel.js` | 0.2.3 的 UI 改动 + Forge 的 UI 改动 | 属于 §6-D（100 张座位卡）与封面水印，**未落** |
| `server/lobby.js` h1–h4 | 我们多了房间级 mod set（`modSet`/`modIds`，DESIGN §28.9）等 | 补丁这条把 `addBot` 由 host-only 放宽为「任一在座人类」。**未落**：属 §6 的接入放宽，需裁决 |
| `server/match/{gamedata,invariants,bot,effectsMeta,choices}.js`、`server/match/match/{combat,intents,phases,platform,views}.js`、`server/match/player/acquire.js`、`server/match/audit.js`、`server/match/Match.js`、`server/match/unite.js` | 我们多了 0.2.3 / Forge 的条目（`PlayerSupport`、`bountyCard`、`inTotal`、`aiPicksLast` 等） | 这些是 §6-A/B 的配套取用点与审计，**未落**（`gamedata.js` 的 `aliveFull` 语义已单独落，§3.3） |

### 2.3 新增文件

14 个：`docs/FINDINGS-100.md`（作者实测记录）、`smoke100.mjs` + 8 个 `probe-*.mjs`（压测/探针脚本）、
`shared/squads.js`（25 小队编制，纯 ESM、与现有代码零冲突，**建议随 §6-A/B 一起落**）、
`public/js/screens/lobbyFeed.js`、`server/match/player/rules.js`、`server/match/unite100.mjs`。

**未落**：探针与 `smoke100.mjs` 是一次性诊断工具，放仓库外 `_up/sp100/` 更合适；
`shared/squads.js` / `rules.js` / `unite100.mjs` 只有与 §6-A/B 同时落才有意义。
（`docs/FINDINGS-100.md` 520 行是作者的结论文档，可作参考材料放 `_up/sp100/`。）

## 3. 已移植清单（5 项）

| # | 文件 | 改了什么 | 为什么 | 测试 |
|---|---|---|---|---|
| 1 | `shared/constants.js`、`shared/protocol.js`、`server/lobby.js`、`server/matchmaking.js` | 新增纯函数 `maxSeatsFrom(env)`；`MAX_SEATS` **保持 4**；`LOBBY_DEFAULTS.maxSeats = maxSeatsFrom(process.env)`；`Room(code,mode,diff,now,seatCap)` 按 `seatCap` 建座位；`room.removeBot`/`room.kick` 的座位上界由 `MAX_SEATS` 改为同一来源 `SEAT_CAP`；matchmaking 队列上限跟随 `lobby.opts.maxSeats` | 补丁把 `MAX_SEATS` 写死 100；本仓库 `test/quickmatch.test.js` 硬断言 `MAX_SEATS === 4`，且「≤4 座行为不变」要求默认不动。做成**可配置**（`SP_MAX_SEATS`）既满足 100 人部署，又不动默认 | `test/ps100-migration.test.js` §1（4 项） |
| 2 | `server/sim/constants.js`、`server/sim/battle/spawns.js` | 新增 `MAX_ALIVE_ENEMIES_PER_PLAYER`（**等于** `MAX_ALIVE_ENEMIES`）与 `aliveEnemyCap(players) = 每玩家额度 × players`；`spawnEnemy` 的两处守卫与 `_queueSpawn` 改用 `aliveEnemyCap(this.players.length)` | 补丁写 `max(600, 1500×n)`，那会让**单玩家**的上限变成 1500，而 `test/sim/robustness.test.js:189` 硬断言单玩家时 `aliveEnemies().length === MAX_ALIVE_ENEMIES`（600）。改成「每玩家 600」：`n=1` 时**逐字节等于 600**，只有多玩家共享战场（联防）才放宽 | `test/ps100-migration.test.js` §2（2 项）+ `test/sim/robustness.test.js` 35/35 |
| 3 | `server/match/gamedata.js`、`server/match/finalAssault.js`、`server/match/Match.js` | `bossPoolShareOf(..., seatCap = MAX_SEATS)`，`aliveFull` 上限由 `max(aliveFull, seatCap)` 决定；`GameData` 增加 `this.seatCap`；`Match` 由 `opts.seatCap`/`opts.seats.length` 推座位数并传下去 | 补丁的根因修复：`Math.min(32, 4)` 把 32 人的血池夹成 4 人份（`aliveFull = 4` 是 4 人房标定值）。`seatCap = 4` 时 `alive ≤ 4`，**逐字节等价**；100 人房不再被夹 | `test/ps100-migration.test.js` §3（3 项）+ `test/match/boss-hp-scaling.test.js`、`finalAssault.test.js`、`playtest6-bosspool.test.js` 25/25 |
| 4 | `server/match/match/infra.js`、`server/match/match/prep.js`、`server/match/audit.js` | 新增 `hasReadyableHuman`（有能按 Ready 的真人吗）/ `prepFallbackGuard` / `prepUntimed`；`prepDeadlineSeconds()` 成为**唯一定义**：`isSolo → 不限时`；回合声明了 `prepTime → 它`；**否则仅独狼同盟房退到官方 `timers.infoCheck`（25 s）**；`prep.js` 与 `audit.js` 都读它 | 纯收益修复：`maybeEndPrep` 要求「所有存活座位都 ready」，而独狼（1 真人 + N AI）在同盟房里 `soloUntimed = true` ⇒ **准备阶段没有任何闹钟** ⇒ 那个人不按 Ready 就**永远卡死**。**首版曾把兜底时限套在所有 `prepUntimed` 情形，导致零延迟时序移动、`verification-slices` 回归；已收窄为只作用于独狼房**（详见 §5） | `test/ps100-migration.test.js` §5（4 项）+ `test/match/draft.test.js` 8/8 + `test/match/verification-slices.test.js` 11/11 |
| 5 (D) | `server/lobby.js`（`toState`）、`public/js/screens/room.js`（`normalizeSeats` + 网格类名）、`public/css/screens/room.css`（`.seats--dense`） | `room.state` 在**容量 ≠ `MAX_SEATS` 时**才多带一个 `seatCap`；客户端按**这个**值把座位卡补到容量（缺省/垃圾值仍是 4，且**上限 256** 防呆）；`room.js` 只在 `> MAX_SEATS` 时加 `seats--dense`，CSS 把网格改成 `auto-fill` 换行 + 纵向滚动、并把 100 张卡的入场错峰由 60 ms 降到 6 ms | 补丁原版**无条件**改 `.seats` 的列宽/行高与 `animation-delay`，那会连 1–4 座房的版式一起改掉。这里全部**限定在超容量房间**：4 座房既没有 `seatCap` 键、也没有 `seats--dense` 类，版式与今天逐字节相同 | `test/ps100-migration.test.js` §1（D 2 项）+ `test/client-static.test.js` 390/390 |

**未采用**（记录判定）：
- 探针脚本与 `smoke100.mjs`（一次性诊断工具，放仓库外 `_up/sp100/`）。
- `bandDraft.js` 的 `duplicatesAllowed`（独立开关，与 100 座四簇无关）。
- **`room.setListed` / `lobbyFeed.js`（在线人数 + 公开房间列表）与 `title.css` 水印**：这三项**本仓库都没有**
  （`room.setListed`、`useLobbyFeed`、`RoomList` 在树里查不到），且 `setListed` 要动 `server/lobby.js` 与
  `shared/protocol.js` 的消息面、不是「100 座座位」的事；`room.setListed` 已在 §2.2 记为「新增能力、未落」。
  D 只落了**座位容量**那一条（唯一与 `seatCap` 相关的部分），因为只有它必须与座位上限同源。

## 4. 「≤ 4 座行为不变」的证据

1. **黄金结果逐字节不变**：`GOLDEN_FULL=1 node --test test/golden.test.js` → **9/9 通过**（改前改后各跑一次，
   同一 9 项）。黄金摘要包含 `bossHpLeft`、`unspawned`、`enemies` 计数——正是 §3.2/§3.3 会碰到的字段，
   而摘要**不含任何 timer/deadline**，所以 §3.4 的闹钟改动在结构上不可能移动摘要。
2. **`aliveEnemyCap(1) = 600`**：`server/match/match/combat.js` 给**每个玩家各建一张单人战场**
   （`players: [ps.playerId]`），所以 ≤4 座的每张普通战场都取 `n=1`；`test/sim/robustness.test.js` 35/35
   （其中 189 行就是「单玩家上限 = `MAX_ALIVE_ENEMIES`」）。唯一的多玩家战场是联防（≤2 helper），
   `600×2 = 1200` 仍高于实测峰值。
3. **`bossPoolShareOf` 对 ≤4 座逐点等价**：`test/ps100-migration.test.js` 用**迁移前的公式原样**做期望值，
   对 `seatCap ∈ {未传,1,2,3,4}` × `alive ∈ 1..8` 全等；`seatCap` 未传时等于旧的 4 人上限。
4. **`MAX_SEATS` 仍是 4**：`test/quickmatch.test.js:443` 原样通过；座位校验在默认环境下仍是「0–3 合法，
   4 起拒绝」（`test/ps100-migration.test.js` §1 断言了这两侧）。
5. **独狼闹钟只加在准备阶段**：solo 的准备阶段仍 `deadline = 0`、无 timer（§5 测试第 2 项）；
   `INFO_CHECK` / `BAND_DRAFT` / `SP_DRAFT` 仍走 `soloUntimed`，逐条断言未动。
6. **隔离验证**（因为工作树里有 4 个并行子 agent 在改）：在 `git worktree` 的**干净 HEAD** 上只叠加本文
   这 12 个文件，`test/match/draft.test.js` 8/8、`docs-consistency` + `docs-paths` 全通过。

## 5. 已裁决的偏差（不再是阻塞）

1. **`BOSS_HIT_LIMIT`（补丁要求 `Infinity`）— 按「默认 300000 + 可按 `SP_BOSS_HIT_LIMIT` 覆盖」落地，默认值未动**。
   `test/docs-consistency.test.js` 与 `test/sim/playtest6_limits.test.js` 里原有的 `assert.equal(BOSS_HIT_LIMIT, 300000)`
   **原样保留**，并在其后**加强**为「无覆盖 ⇒ `undefined`（即 300000 仍生效）；`0`/`off`/`infinity`/`inf` ⇒ `Infinity`；
   正数 ⇒ 该值；junk/负数 ⇒ 默认」。落地方式见 §3 与 §7。
   理由：补丁那一步是**移除机制本身**，而 `leaderHitCancelled` **同时作用于我方承受的伤害**，所以它是玩法改动、
   不是可移植的自包含项；关与不关交给部署侧一次显式决定。
2. **`test/match/draft.test.js` 的既有断言被我改了（加强，未放松）**。
   原文断言「独狼在战斗外的**每个**阶段都 `deadline === 0`」，并把「prep waits（永远等下去）」当成正确行为——
   那正是 §3 第 4 项的死锁。我把该断言**收窄到仍成立的 6 个阶段**，并**新增**更强的断言：
   准备阶段必须有 deadline / 必须有 timer，且「10 分钟后必须已经离开准备阶段」。测试名与注释都写明了例外。
   `docs/META.md` §1、`docs/design/match.md` 的对应描述已同步（**修订 playtest #4 item 3**）。
3. **`SP_COMBAT=server` 硬拒绝启动（补丁 `server/index.js` h2）— 未落**：部署策略，非玩法，需业主定。
4. **第二条被修订的既有决定**：`test/match/verification-slices.test.js` 里「抽样校验保留被接受结果」那条断言，
   原文读 `m.lastResults`（**每回合重建的 Map**），它**只有靠上面的死锁把比赛卡在回合 1 才可能成立**。
   已改到**该场已接受的结果对象**（`f.result`，跨回合不被清空）上，并在 `test/ps100-migration.test.js` §5 新增
   **正向断言**「独狼同盟房必须有准备时限」把死锁的消失钉死。mutation 复核：把准备修复换回迁移前表达式，
   **只有这条正向断言变红**（`_up/sp100/mutation-check.mjs`），还原后逐字节通过。
2. **`test/match/draft.test.js` 的既有断言被我改了（加强，未放松）**。
   原文断言「独狼在战斗外的**每个**阶段都 `deadline === 0`」，并把「prep waits（永远等下去）」当成正确行为——
   那正是 §3.4 的死锁。我把该断言**收窄到仍成立的 6 个阶段**，并**新增**两条更强的断言：
   准备阶段必须有 deadline / 必须有 timer，且「10 分钟后必须已经离开准备阶段」。测试名与注释都写明了例外。
   `docs/META.md`、`docs/design/match.md` 的对应描述同步更新（playtest #4 item 3 的例外）。
   ⇒ 这实际上是**对「独狼不限时」那条既有决定的修订**，请业主确认（我认为死锁不可能是原意）。
3. **`SP_COMBAT=server` 硬拒绝启动（补丁 `server/index.js` h2）— 未落**：部署策略，非玩法，需业主定。

## 6. 设计级改动（未动代码，待裁决）

| # | 改什么 | 为什么必须 | 我们这里的落点 | 风险（尤其：会不会改变没上百人时的行为） | 建议 |
|---|---|---|---|---|---|
| A | **每人独立牌库**：`PlayerRules`（新）挂在方法链最后，`pool()` 惰性建本玩家自己的 `SharedPool`，`poolOf()` 为唯一分派点；`m.pool` 降为「权威目录」，审计守恒式从全局改**每玩家** | 上游池子是全局共享（第 6 阶每干员 5 份，合成精锐吃 3 份）⇒ 100 座下 84% 座位被淘汰（作者实测 16/100 存活）；独立后 100/100 | `server/match/player/rules.js`（新）+ `player/{economy,acquire,diy,views}.js` + `match/{choices,spDraft}.js` + `effectsMeta.js` + `bot.js`(4 处) + `invariants.js` + `PlayerState.js` | **会**：改成「每人一份」后，共享池的稀缺性消失，**低于 4 座也会变**（四人局各买各的，不再抢同一批牌）。这会移动黄金摘要（`pool`/`rngShop` 抽取序列） | 做成**模式/人数开关**（如 `≥ 5 座才启用独立牌库`），保住 ≤4 座的黄金与手感。需业主先定 |
| B | **机变按小队**：`m.sp` 由单个对象改为按小队数组，每队各发 6 张、25 队并发；卡池不再公共广播（走 `m.private.sp`），合作局不设计时器 | 原版一局一次、全场共享 6 张 ⇒ 100 座里 94 人空手 | `server/match/match/spDraft.js`（162+/60−，6 hunk）+ `views.js` + `player/views.js` + 客户端读 `priv?.sp` | **会**：`sp` 的数据形状与「6 张给全队」的语义都变；≥2 人房间的机变流程随之改变（作者也报告过「两个人都没法选牌」的三个连锁缺陷，§8 有修法）。**≤4 座也会受影响** | 与 A 一起做成开关；客户端需要同步（本仓库 UI 由 Forge 维护）。**必须业主裁决** |
| C | **`unite100.mjs` 100 人联防**：每小队一个战场、同一 `FieldRunner` 锁步；阶段 2 改「第二轮战场」（`config.unite.relayBattlefield` 默认 true）；审计由全局改逐小队 | 上游联防是单战场、全局 helper，装不下 25 队 | `server/match/unite100.mjs`（新，535 行）+ `match/unitePhase.js`（237+/31−）+ `unite.js`（`combineUniteResults`）+ `audit.js` + `Match.js`（`uniteRound`/`unitePlans`/`_uniteToken`） | **会**：`startUnite` 由单计划改数组、阶段 2 由原子结算改成多打一轮战场，**4 座房也会走到新代码路径**（作者自称 4 座 0 违规，但仍需我们自己的黄金验证） | 属最大的一块；建议**单独排期**，并以 golden + `test/match/unitedown.test.js` 兜住 |
| D | **UI 100 张座位卡** + 封面水印 + 在线人数/公开房间列表 | 100 座需要重排房间页；补丁含 `room.css` 58+/5−、`lobby.css` 41+、`title.css` 134+ | `public/css/screens/*`、`public/js/screens/{room,title,lobby,game}.js`、`public/js/ui/teamPanel.js`、`lobbyFeed.js`（新） | **基本不会**改玩法（纯展示），但 `room.js` 的 `normalizeSeats` 会把座位补齐到上限并逐个渲染——上限一旦调大，DOM 规模随之上升 | 与 A–C 一起做；**未上百人时不激活**，风险最低 |

## 7. 把 100 人跑起来要调什么（部署参数）

补丁的实测曲线（NORMAL、全 AI 座位）：4 座 3.7 s / 285 MB，100 座 24.6 s / 488 MB，调度层 0 异常。
翻到 100 座需要**同时**调：

| 项 | 默认 | 100 座要什么 | 我们这里的状态 |
|---|---|---|---|
| 座位上限 | `MAX_SEATS = 4` | `SP_MAX_SEATS=100` | **已实现**（§3.1） |
| 单 IP 连接数 | `net.js` `maxConnectionsPerAddr = 64` | 同一出口 IP 超 64 个客户端直接 429（本地/局域网豁免）；**未擅自改默认** | 需部署时调 `maxConnectionsPerAddr`（`startServer` 选项 / 环境变量，见 `server/http/config.js`） |
| 单 IP 房间数 / 对局数 | `maxRoomsPerAddr = 16`、`maxMatchesPerAddr = 8` | 100 人同网段会撞 | 同上；`startServer({ maxRoomsPerAddr, maxMatchesPerAddr })` |
| 活敌上限 | 600（单玩家） | 共享战场按人数放宽 | **已实现**（§3.2；如需更高，调 `MAX_ALIVE_ENEMIES_PER_PLAYER`） |
| 首领血池 | `aliveFull = 4` | 不再被 4 人封顶 | **已实现**（§3.3；`data/config.json` 的值保持 4，代码取 `max(aliveFull, seatCap)`） |
| 限伤 | 300000 | 可按需关闭 | **已实现**（§5.1；默认仍是官方 300000，部署侧用 `SP_BOSS_HIT_LIMIT=off` 关闭） |
| 座位卡 UI | 4 张卡 | 100 张卡需要换行 + 滚动 | **已实现**（§3 第 5 项/D：`room.state.seatCap` → `normalizeSeats` → `.seats--dense`；**≤4 座不加键、不加类，版式不变**） |
| 隐秘核心门槛 | `hiddenCore.multi = 1200` | 独立牌库下「人人满配」使门槛动辄被突破（作者实测 32 座 `layerSum = 10073`）⇒ **每局都会进隐秘核心** | **未动**；这是 A 的连带后果，属平衡账，必须与 A 一起裁决 |
| 战斗模式 | client（Forge 默认） | 补丁要求 `SP_COMBAT=server` 直接拒绝启动 | **未落**（§5.3） |
| 内存 | — | 作者用 `--max-old-space-size=8192` 跑 100 座 | 部署注意 |
| 未验证 | — | 真实浏览器 100 客户端、100 座 UI 可用性、美术素材（`npm run assets`） | 作者自述未测；我们同样未测 |

## 8. 复现与产物

- 逐 hunk 判定：`_up/sp100/hunk-match.json`（含每个冲突 hunk 的首个错位行）、`hunk-classification.json`
- 补丁清单：`_up/sp100/patch-files.txt`；`git apply --check`（只报每文件首个失败 hunk）：`apply-check.txt`
- 改动前的文件备份：`_up/sp100/preimage/`（38 个文件）
- 本次探针：`_up/sp100/probe-prep-deadlock.mjs`（死锁，改前/改后）、`probe-enemycap.mjs`、
  `probe-bosspool.mjs`、`probe-spdraft-solo*.mjs`
- 本仓库回归测试：`test/ps100-migration.test.js`

## 9. 验证结果（实测原始输出）

**测量纪律**：工作树里同时有 4 个并行子 agent 在改（`server/match/*`、`docs/*`、`shared/*` 等），
所以「工作树直跑」的结果会被别人的半成品污染。因此另建了一个 `git worktree` 的干净 HEAD 检出，
**只**叠加本文这 17 个文件（`_up/sp100/apply-my-edits.mjs` 负责把属于我的那几行打进 `Match.js` / `audit.js` /
`docs/META.md` / `docs/design/match.md`，其余 13 个文件整体复制），再跑全部验证。以下都是在**该干净树**上的结果：

| 命令 | 结果 |
|---|---|
| `GOLDEN_FULL=1 node --test test/golden.test.js` | **9/9 pass, 0 fail**（41.6 s） |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | **31/31 pass, 0 fail** |
| `node --test test/ps100-migration.test.js` | **12/12 pass, 0 fail** |
| `node --test test/match/draft.test.js` | **8/8 pass, 0 fail** |
| `node --test test/sim/robustness.test.js` | **35/35 pass, 0 fail** |
| `node --test test/match/boss-hp-scaling.test.js test/match/finalAssault.test.js test/match/playtest6-bosspool.test.js` | **25/25 pass, 0 fail** |
| `npx eslint <本文改动的 14 个 js>` | 0 error / 2 warning（两条都是改动前就有的 `no-useless-assignment`） |
| `npx tsc --noEmit --checkJs -p jsconfig.json` | exit 0 |

**死锁探针（改前 → 改后，`_up/sp100/probe-prep-deadlock.mjs`）**：

```
改前  coop 1 human + 1 AI (unready)   soloUntimed=true  | at PREP: deadline=0 phaseTimer=false | after 400s: PREP R1 *** STUCK ***
改后  coop 1 human + 1 AI (unready)   soloUntimed=true  | at PREP: deadline=1700000070000 phaseTimer=true | after 400s: SP_DRAFT R3 MOVED
改后  solo 1 human (unready)          soloUntimed=true  | at PREP: deadline=0 phaseTimer=false   （solo 不变）
```

**首领血量探针（`probe-bosspool.mjs`）**：≤4 座 × `alive 1..8` 与迁移前公式**全等**；
`seatCap=100` 时 `bloodPoint 400000 × alive 32 = 12800000`，正是补丁 `FINDINGS-100.md` §3.4 期望值
（旧行为是 `1600000`）。

**两个必须知道的测量陷阱**（否则会误判成本次改动）：
1. 工作树上 `server/match/Match.js`、`audit.js`、`spDraft.js`、`match/views.js`、`player/views.js` 已被**别的**
   子 agent 改成「共享装备库存（`SharedItemPool`/`itemPool`）」的半成品，而 `server/match/pool.js` 的
   `SharedItemPool` 与该改动并不同步 ⇒ 工作树里 `机变` 与 `golden` 会直接抛模块/空引用错误。
   用 `_up/scratch` 干净树可绕开；**这不是本次改动的问题**。
2. `docs/META.md` 与 `docs/design/match.md` 里当时出现的、指向上游 0.2.4 共享库存那一小节的引用，是另一个子
   agent 的 0.2.4 文档在制品：**上游自己的编号**是 29.8，而本仓库把上游 0.2.4 的历史小节记为
   `docs/history/0.2.4.md` 的 31.8。**已由 0.2.4 合并那一刀统一改写为 31.x**（不再有指向不存在标题的引用）。

## 10. 设计级 A/B/C 的「开关化」方案（不写代码，供业主拍板）

前提：**只有 `seatCap > MAX_SEATS`（即 ≥5 座）才启用 A/B/C；≤4 座必须走今天那条代码路径**。逐条回答
「门控点在哪 / 关掉时是否真的走旧分支 / 客户端要不要同步 / 动多少 golden」。

### A 每人独立牌库
- **门控点**：`PlayerState.pool()` 的**唯一分派点** `poolOf(baseId)`。今天它已按「自选槽 → 玩家库存，否则
  `m.pool`」分派；门控就加在这里：`this.m.seatCap > MAX_SEATS && this.m.rules.independentPools ? playerPool : m.pool`。
  `PlayerRules` 本身可以照补丁挂在方法链最后（它只在开启时才被取用）。
- **关掉时是否走旧分支**：**是**。`poolOf()` 落回 `m.pool` 后，所有取用点（`economy` 商店、`acquire` 奖励、
  `choices` 盟约、`spDraft.rollPool`、`effectsMeta.rollChess/grantChess`）拿到的就是同一个全局池 —— 与今天
  同一条语句、同一个对象，不是「新代码但结果相同」。`invariants.js` 的守恒式必须**同时**支持两种口径
  （全局 / 每玩家），所以它需要门控而不是替换。
- **客户端**：**不需要**。牌库口径是服务端的权威数据，客户端只读商店帧与手牌。
- **golden**：**开启时才可能移动**。`test/golden/matches.json` 里带商店抽取的场景（`coop2-*`、`diy` 场景）
  在开启后必然变；**≤4 座关掉 ⇒ 0 移动（必须由 `GOLDEN_FULL=1` 验证）**。

### B 机变按小队
- **门控点**：`MatchSpDraft.enterSpDraft()` 的**数据形状**。这是最麻烦的一条：补丁把 `m.sp` 从**对象**改成
  **按小队的数组**，并让客户端从 `m.private.sp` 读卡、`m.public.sp` 只留进度。形状是全局的，
  **不能靠一个布尔在同一个 `m.sp` 上两种形状共存**。
- **关掉时是否走旧分支**：需要**显式的双分支**（`if (squads) 新路径 else 今天的单对象路径`），而不是
  「新代码 + 开关」。也就是说 B 的「开关化」是**保留今天那条实现**、另加一条小队实现，
  代价是 `spDraft.js` / `views.js` / `player/views.js` 各多一层分支。
- **客户端**：**要同步**。今天读 `pub?.sp`，补丁读 `priv?.sp`；两条路径的帧形状不同 ⇒ 客户端必须按同一
  开关选读哪一边（服务端可以把开关放进 `m.public`，客户端据此分支）。**本仓库 UI 由 Forge 维护，这块必须
  与 A/B 一起排期。**
- **golden**：`spDraft` 的抽卡序列与 `m.public.sp` 的公开内容都会变 ⇒ `matches.json` 会移动；≤4 座关掉 ⇒ 0 移动。

### C `unite100.mjs` 100 人联防
- **门控点**：`MatchUnite.startUnite(planOrPlans)` 的**入参形状**与 `_afterUniteRound`。今天收**单个** `plan`
  并只取 `fields[0]`；补丁收**数组**、每队一个 `u<squad>` 战场，并把阶段 2 做成第二轮战场
  （`config.unite.relayBattlefield` 默认 true）。
- **关掉时是否走旧分支**：**是**，但要把 `Match.js` 里补丁新增的 `uniteRound`/`unitePlans`/`uniteRelays`/
  `_uniteToken`/`_uniteDoneToken` 全部保持「不用」状态；`startUnite` 保留今天的单战场实现作为 `else` 分支。
  审计（`audit.js` 的联防断言）同样需要双分支：逐小队 vs 全局。
- **客户端**：**基本不需要**（联防帧本就走既有的 field meta / 多战场路径），但补丁提到 `_uniteLeft`/`statusOf`
  在多计划下是**展示值可能读到别队**的已知未收敛点 —— 若开启 C，这两处要一并处理，否则 100 座下 HUD 数字会串。
- **golden**：`fields.json` 的 `unite-1`/`unite-2` 场景（1、2 helper）**在两种模式下都应该不变**（1–2 helper
  ⇒ 单小队 ⇒ 与今天等价），这是最关键的一条**可验证的不变量**；`matches.json` 里出现 `UNITE@Rn` 的场景
  在开启后可能移动。

### 结论（建议给业主的三个选项）
1. **只做 D（已做）**：100 座可进房、可看座位，但玩法仍是 4 人局的规则 —— 最保守，0 golden 移动。
2. **D + A + C，B 暂缓**：A 与 C 都能用「保留旧分支 + 门控」做到 ≤4 座 0 移动；B 必须改客户端帧形状，
   牵动 Forge UI，单列一期。
3. **全上**：需要接受 `matches.json` 的移动 + 客户端同步 + 一次平衡复核（`hiddenCore.multi` 门槛、
   `aliveFull`、机变卡强度是同一套账）。

## 11. A + C 已落地（业主批准 A+C 现在做、B 单列一期）

§10 是设计书；本节是按它的实现记录。两条都**由 `seatCap > MAX_SEATS` 门控**，关掉时走的是**今天那条代码路径**，
不是「新代码但结果相同」。

### 11.1 A 每人独立牌库

| 项 | 落地 |
|---|---|
| 门控点 | `PlayerState.poolOf(baseId)` —— **唯一分派点**（`server/match/player/rules.js`，方法链最后）。`this.diyStock.has(baseId) → diyStock`（两种模式都不变），否则 `variantOn() ? this.pool() : this.m.pool` |
| 关掉时 | `variantOn()` 读 `m.seatCap > MAX_SEATS`；关掉 ⇒ `poolOf` 落回 **同一个 `m.pool` 对象**。新加 `mainPool()`（抽卡来源）同样关掉即 `this.m.pool` |
| 抽卡来源 | 商店摇棋（`player/economy.js` `_rollChessSlot`）、奖励重摇（`player/acquire.js`）、盟约「获得某盟约干员」（`choices.js`）、`effectsMeta.rollChess`、`spDraft.rollPool({pool})`、AI 的池子读数（`bot.js` 4 处）全部改走 `mainPool()` / `pool()`；关掉时是同一个对象上的同一条语句 |
| 客户端 | **不需要**（§10-A）：牌库口径是服务端权威数据 |
| 不变量 | `invariants.js` **两种口径并存**：关掉仍是房间级 `left + Σheld == cap`（逐字未改）；打开改为**每玩家**对**自己的池**同一条守恒式，`m.pool` 降为只读权威目录（只查 `left <= cap`）。两种模式都另有 `heldOf` 每玩家账 |
| 与 DIY 的关系 | 自选槽先于独池分派：自选片的份数永远走该玩家自己的 `DiyStock`（两种模式一致），所以 `pool()` 用 `m.gd` 建池不含自选槽，也不会夺走它 |
| 助战 | 每玩家池镜像 `m.pool` 的 `support`（shared/support.js）。**偏差**：补丁的 `rules.js` 只传 `banned`；丢掉 `support` 会让「本局禁用**但自己带上场**的助战」在 100 座下买不到，那是删功能，故保留 |
| 副作用（已知，未动） | 独立池后「人人满配」使 `hiddenCore.multi = 1200` 更容易被突破（§7 已记为 A 的连带平衡账） |

### 11.2 C 100 人联防

| 项 | 落地 |
|---|---|
| 门控点 | `startUnite(planOrPlans)` 的**入参形状**：`Array.isArray(plan)` ⇒ 变体分支，否则**逐字保留**今天是单战场实现（`else` 分支）。数组只可能来自 `planUnite()`，而它的开关也是 `m.seatCap > MAX_SEATS` |
| 新规则层 | `server/match/unite100.mjs`（新）：`SQUAD_SIZE` / `squadIndexOf` / `squadMembersOf` / `squadsOf` / `planUniteBySquad`（阶段 1 队内兜底）/ `squadStrength` / `takeUnhandled` / `planRelayBySquad` / `pickRelaySquad` / `relayPlanFor`（阶段 2 跨队兜底）。纯函数，不碰阶段状态 |
| 阶段 2 | `_afterUniteRound`：`uniteRound !== 1` ⇒ 结算；`_phase1Driven === this.round` ⇒ 只规划一次（补丁的 16 座串队缺陷就是这里重入）。默认走**第二轮真战场**（`config.unite.relayBattlefield` 非 `false`，即默认 true），`_relayAtomic` 作为文档化的退路 |
| 场地 | 阶段 1 `u<squad>`、阶段 2 `r<squad>`；**只剩一张战场时仍叫 `u`**，并且 seed 仍是 `u:<round>`、每个 battle option 都不变 —— 这就是 `unite-1`/`unite-2`（1–2 helper ⇒ 单小队）**两种模式都不动**的原因 |
| `views.js` / `statusOf` | **未改**（不在本刀文件面内）。`unitePlan` 在变体下是**全房间并集**（`combineUniteResults`），所以 `statusOf` 的 `helpers.includes(ps)`、`m.public.unite`、`settle(plan, result)` 全部照旧正确 |
| `_uniteLeft` 串队 | 已处理：`_unitePlanFor(ps)` 找「以 ps 为 leaker 的那个小队计划」，`_uniteFieldFor(plan)` 找它自己的战场；关掉时两者分别返回 `this.unitePlan` 与今天那句 `fields.find(kind==='unite')`。`_uniteTick` 多战场时改为**求和**后再发布 |
| 客户端 | **不用动**：联防帧本就走既有 field meta / 多战场路径；变体客户端分支只多做「一队一战场 + 每观众看自己那场」 |
| 审计 | `audit.js` 的 `startUnite` 断言**双分支**：关掉是今天的房间级断言（逐字），打开按小队（helper/leaker 必须同队、≤ maxHelpers、并集必须等于房间 leaker 全集、敌人不得记到队外人头上） |
| `Match.js` | 新增 `unitePlans` / `uniteRound` / `_uniteToken` / `_uniteHandoff` / `_phase1Settle` / `_phase1Driven` / `_relayToken`，**关掉时保持不用状态**（`null`/`1`/`0`），有测试钉住 |

### 11.3 验证（本次实测原始输出）

| 命令 | 结果 |
|---|---|
| `node --test test/ps100-variant-ac.test.js` | **19/19 pass, 0 fail**（门控开/关两个方向、每玩家守恒活着、单小队战场逐项相等、阶段 2 真跑、harness 双口径都不丢牙齿） |
| `node --test test/ps100-variant-ac.test.js test/ps100-migration.test.js` | **39/39 pass, 0 fail** |
| `node --test test/match/*.test.js`（103 文件） | **777 tests / 773 pass / 4 fail** —— 4 条红的归属见 §11.4 第 3 项（`fuzz` 已由 §11.4 第 1 项的修复转绿） |
| `node --test test/match/unitedown.test.js` | **3/3 pass, 0 fail**（关掉时走旧分支的既有回归） |
| `node --test test/docs-consistency.test.js test/docs-paths.test.js` | **31/31 pass, 0 fail** |

**≤4 座 / 门控关掉 = 真旧分支**的三条证据（全部断言，不是描述）：
1. **同一个对象**：`ps.poolOf(x) === m.pool`、`ps.mainPool() === m.pool`、`ps._ownPool === null`（关掉时不建池）。
2. **同一条守恒式**：关掉时房间级 `left + Σheld != cap` 仍会报；打开时该式不再对 `m.pool` 生效，改为每玩家。
3. **同一张战场**：4 座（关）与 8 座（开、单小队）在同一脚本下产出**同一个 field id `u`、同一个 seed、同一份
   players/spawns/waveId/rect**；且 1 helper 时 `waveId = act1autochess_escaped_single`、2 helper 时
   `act1autochess_escaped_multi` —— 正是 `test/golden/fields.json` 的 `unite-1`/`unite-2`。

### 11.4 收尾（授权后补齐，业主第二次裁决）

1. **`test/match/harness.js` 的 `legacyInvariants`**（已按授权修好）。它自己的注释是「必须与 `collectViolations` 一致」
   （"kept alongside collectViolations; they must agree"），而权威那侧已经支持两种口径 ⇒ **它是漂移的一方**。
   fuzz 造房最多 `3 humans + 2 bots = 5 座`（`fuzz.test.js:49-50`）⇒ A 打开 ⇒ 旧房间级式误报。
   已改成**双口径**：`m.seatCap ≤ MAX_SEATS` 逐字保留房间级三行；`> MAX_SEATS` 改为逐玩家对 `ps._ownPool` 查同一条
   守恒式（`left` 上界、`own.left(base)` 非负投影、`left + Σheld == cap`、非池棋子份数 0），并保留目录的 `left ≤ cap`。
   **只加强不放松**：`test/ps100-variant-ac.test.js` 新增一条「两种模式都不丢牙齿」的断言 —— 关掉时把共享池扣 1 仍被抓、
   打开时把某玩家自己的池扣 1 仍被抓、干净状态两边都过。证据：`_up/sp100/ac/probe-fuzz-attribution.mjs`。
2. **每一处「取份数」都走 `PlayerState.poolOf`（补齐）**：`test/match/harness.js` 的 `give()`、`match/phases.js` 的
   `grantDirectToHand`（编辑器 `SP_PLAYTEST`/`SP_DIRECT_TO_HAND` 试玩发牌）都改成 `ps.poolOf(base).take(...)`。
   关掉时 `poolOf` **就是 `m.pool` 本身**（同一对象、同一语句 ⇒ 逐字节相同）；打开时才落到该玩家自己的池。
   两条断言在 `test/ps100-variant-ac.test.js`（「EVERY copy source follows poolOf」）：关时 `give()` 仍扣共享池、
   开时扣本人池且目录**一份不少**、`grantDirectToHand` 同样。
3. **`test/match/` 剩下的 4 条红，全部不是本刀**（隔离树对照 + 断言内容 + 逐文件 `git diff --no-index` 定位）：
   - `bot.test.js:276`「single-human co-op is untimed」：**隔离树里也红** ⇒ **上一刀 SP100 的遗漏**（他们改了
     「独狼同盟房准备阶段」有时限并同步 `draft.test.js`，漏了这条）。已按 `draft.test.js` 的同一处理方式收掉：
     **改测试期望、不动引擎**（现在断言 `m.deadline > 0` + `m._phaseTimer != null`，并把标题里的 "untimed PREP"
     改成「lone-human PREP (timed since §5)」）。
   - `draft.test.js:271`、`loadout.test.js:248`、`leftovers.test.js:118`：读的是**广播出去的原始帧**，而增量帧
     （`server/viewsDelta.js` 的 `publicDelta`）**只发变化的键** ⇒ 没有变化的 `deadline`/`phase` 键根本不在帧里，
     值成了 `undefined`（`pubs` 只收到 1 帧）。**修法：读物化后的状态**，不放宽、不删断言：
     `harness.js` 新增 `h.publicSeries()`（把 `m.public` 全帧按 full-then-delta 合并成**每帧一个完整状态**的序列，
     与 `lastBc('m.public')`/浏览器同一条合并路），三处改为在它上面取 `phase`/`deadline`。
     **mutation 复核（逐条，改错期望值 ⇒ 必红）**：
     `draft` 把 `d === 0` 改成 `d === 12345` ⇒ 只红「a single human …」1 条；`loadout` 同样 ⇒ 只红
     「solo: no deadline outside combat」1 条；`leftovers` 把 `pubs.length >= secs - 2` 改成 `>= secs + 999` ⇒ 只红
     「Final Assault: boss b.progress …」1 条。三次改后**逐字节还原**（文件哈希相同）。
4. **B（机变按小队）一行未动**：`m.sp` 仍是一个对象（`spDraft.js:29 this.sp = { ...draft, order, idx, picks, taken, untimed, turnDeadline }`）、
   `views.js:111 v.sp` 照旧、`public/**` 未碰。按 §10-B 单列一期。
5. **`shared/squads.js` 未建**：小队编制内联在 `server/match/unite100.mjs`（本刀文件面只到 `server/match/**`）。
6. **阶段 2 ticker 复用既有 i18n 键**（补丁原文是一句新 key）：`public/i18n/*` 不在本刀文件面内。
   ⇒ **待办（未做）：阶段 2 ticker 需要专属四语文案**（排进 i18n 那一波）。
7. **`config.unite.relayBattlefield` 走默认 true（`!== false`）**：`data/*.json` 是**生成物**，由 `tools/build-data.mjs`
   产出 ⇒ **这个键应由生成器写进 `data/config.json`**（另排一刀给生成器，本刀不手改 data）。
8. **`_uniteOpts` 的 seed 只在多战场时加 `:<fieldId>`**：补丁对所有情况都加，那会移动 `unite-1`/`unite-2` 的种子。
9. `test/golden/**` 未跑也未改（golden 由另一波独占）。A/C 在 ≥5 座时**会**移动 `matches.json` 里带商店抽取 /
   `UNITE@Rn` 的场景 —— 那是开启后的预期，需要 golden 那一波在切换默认值前决定。

### 11.5 本刀造成的可观察变化（一次看全）

| # | 变化 | 谁能观察到 | 严重度 |
|---|---|---|---|
| 1 | **≥5 座时共享池不再被消耗**：每个玩家有自己的池；`m.pool` 的 `entries`/`cap` 仍是权威目录（AI、审计、商店图鉴照读），但 `left` 恒等于 `cap` | 100 座部署的玩法（A 的目的）；恒等于 `seatCap > MAX_SEATS` | 设计目标 |
| 2 | **≥5 座时「份数」的守恒式改为逐玩家**（`invariants.js` + `test/match/harness.js` 两份实现都改）。房间级那条式在开启时不再成立 —— 任何**第三方**读 `m.pool.left` 当「还剩几张」的代码在 100 座下会读到一个不再下降的数 | `collectViolations`/`checkInvariants` 的违规文本；外部工具 | 需知会（§10-A 的既定设计） |
| 3 | **≥5 座时 ≥2 个小队同时漏怪会同时开多张联防战场**（`u<squad>`），且阶段 2 是**真第二轮战场**（`r<squad>`、`uniteRound=2`）。`config.unite.relayBattlefield === false` 才走旧的原子判定 | 战局流程与 `m.public.fields`；≤4 座看不到 | 设计目标 |
| 4 | **≥5 座时独狼/单人的 ≤4 座路径不变**，但 `Match` 多了 7 个字段（关掉时保持初值） | `Object.keys(m)` 级别的东西 | 无 |
| 5 | **增量帧（另一波）的代价**：`m.public` 的 DELTA 帧只带变化的键 ⇒ 任何读**原始帧**的测试/客户端代码都会看到 `deadline`/`phase` 等键**缺失**（不是 0）。本刀把 `draft`/`loadout`/`leftovers` 三条测试改成读物化状态；**这不是本刀引入的**，但它是本刀所在这一波里必须一起收掉的东西 | 所有读 `h.bc` 的测试；本刀新加的 `h.publicSeries()` 是正确读法 | 已在 §11.4-3 收掉 3 条；同类读法全仓可能还有 |





