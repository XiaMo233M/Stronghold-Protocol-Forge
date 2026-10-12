# 网络可调参数说明书（`m.public` 增量帧）

> 随发行物给出。本文只说明「哪些东西可以调、默认值多少、上游原来是什么、改了会怎样」。
> 所有默认值都取自当前工作树的字面量，每条都带 `文件:行`；**没有实测过的数字都标了「未证实」**，不猜。
>
> 上游对照基线：`E:\destop\harness_1\_up\upstream-024\repo` 的 tag `v0.2.3` 与 `v0.2.4`
> （读法：`git show v0.2.4:<path>`、`git grep -n <sym> v0.2.4`）。

## 1. 一句话

本次优化把服务端推给每个客户端的 `m.public` 从「每次变化发整张表」改成「**第一帧全量 + 之后按字段增量**」：
服务端保留一份「全房间共享的基线」（`_pubPrev`），只把变化的顶层键、变了的玩家行字段、变了的战场条目发出去；
客户端用 `public/js/matchDelta.js` 把这些增量合并进自己的物化状态，所以**下游（store、各界面）读到的仍然是一份完整的 `m.public`，看不到增量**。

**不作任何配置时的行为**：第一帧一定是全量；此后每次变化发增量；两帧之间至少隔 100 ms 且内容没变就不发；
每 32 个连续增量帧后强制一帧全量；任何成员进出 / 掉线重连 / 某帧没能送达所有 socket，下一帧全量。
以上五个数字全部是**源码常量**，没有环境变量、也没有 `startServer()` 选项可以覆盖（要改只能改源码）。

## 2. 可调参数总表

### 2.1 与本次增量帧直接相关的参数

| 参数 | 我们的默认值 | 位置（文件:行） | 上游值 | 改大 | 改小 |
| --- | --- | --- | --- | --- | --- |
| `DELAYS.PUBLIC_THROTTLE`（`m.public` 节流间隔） | `100`（ms，即 ≤ 10 帧/s） | `server/match/match/common.js:22` | `100`（上游同名同值，`v0.2.4:server/match/match/common.js` 的 `DELAYS` 块） | 帧更稀、带宽更低、界面更钝 | 帧更密、更实时，密集变化时带宽回升；到 0/1 等于取消节流，退回「每次变化发」 |
| `PUBLIC_FULL_EVERY`（增量帧保活：多少个连续增量帧后强制全量） | `32` | `server/match/match/common.js:40` | **上游无此参数** | 自愈窗口变长（32→64 时约 3.2 s→6.4 s），全量帧占比下降 | 自愈窗口变短，全量帧占比上升；大房间带宽回升 |
| `PUBLIC_FULL_ASK_MS`（客户端 `g.publicFull` 的最小间隔） | `2000`（ms） | `public/js/main.js:150`（用在 `:379`） | **上游无此参数**（上游客户端 `net.on('m.public', …)` 只有一行 `store.patch`） | 客户端发现状态错后更晚才修 | 客户端更急着要全量；调得太小会把「要全量」放大成「每帧都要全量」 |
| `PROTOCOL_VERSION`（线上帧格式号 / 陈旧页面闸门） | `2` | `shared/constants.js:16` | `1`（`v0.2.3`、`v0.2.4` 两 tag 都是 `export const PROTOCOL_VERSION = 1;`） | 见 §4：只有「帧的形状变了、旧页面会读错」才顶 | 不要「改回去」；降回 1 等于放一台没有合并逻辑的旧页面进来读错名册 |
| 增量 diff 的字段范围 `SCALAR_KEYS`（顶层哪些键参与 diff） | 27 个键：`phase, round, lastRound, deadline, modeId, difficulty, stageId, setupRevision, rerollVote, factions, disabledBonds, drawnDisabledBonds, bannedChess, bossId, hiddenBossId, bossRound, hiddenRound, spRound, combatMode, paused, teamLp, overtimeAt, bossHp, draft, sp, unite, uniteResult` | `server/viewsDelta.js:55-60` | **上游无此参数**（上游没有 diff，每次都发整份 `publicView()`） | 新增顶层字段若不登记，它的变化**不会**进入增量帧 | 移除某项后，该项变化只在全量帧时才更新（客户端会长期读到旧值） |
| 行内字段的 diff | 无白名单：按 `Object.keys(row)` 逐字段比 | `server/viewsDelta.js:249-285`（玩家行）、`:297-327`（战场条目） | **上游无此参数** | — | — |
| `null` 语义 / `gone` 名单（不是数值，是行为口子） | 行内 `null` = 「这个键没了」→ 客户端删除该键；顶层键消失写进 `gone: [...]`；整行/整条目消失是 `{playerId|fieldId, gone: true}` | `server/viewsDelta.js:12-21`；客户端合并规则 `public/js/matchDelta.js:13-17`、`:75-76`、`:91-94`、`:123-125` | **上游无此参数** | — | 改错这一层的后果见 §5 |
| 判断一帧能不能合并 `canMerge` | 无开关：`frame.delta === true` 且内层 `players`/`fields` 每项都有 `playerId`/`fieldId` 才可合并，否则判定不可合并 | `public/js/matchDelta.js:36-53` | **上游无此参数** |

### 2.2 与增量帧同批、但属于通用网络层（与本次优化无因果关系）

这一节全是**上游本来就有的**参数（逐条对照 `v0.2.4` 同名文件，值完全一致），列在这里只为了打包时一张表能查全。

| 参数 | 我们的默认值 | 位置（文件:行） | 上游值 |
| --- | --- | --- | --- |
| WebSocket 单帧上限 `WS_MAX_PAYLOAD` | `64 * 1024` | `server/http/websocket.js:19`（用在 `:135`） | 同值（`v0.2.4:server/http/websocket.js`） |
| `perMessageDeflate` | `false`（**可被 `pack.json.server.transport` 声明打开**，2026-10-11：`server/http/websocket.js:43-91` 的 `transportPolicy`） | `server/http/websocket.js:134-135` | 同值（上游没有这条声明通道） |
| 每连接令牌桶 `ratePerSec` / `rateBurst` | `40` / `40` | `server/net.js:50-51` | 同值 |
| 重负载意图桶 `heavyPerSec` / `heavyBurst` | `2` / `6` | `server/net.js:61-62` | 同值 |
| `HEAVY_TYPES`（额外吃重负载桶的意图） | `g.watch, g.publicFull, room.loadout, room.ownership, room.diy, room.spectate, room.queue` | `server/net.js:83`（集合；闸门在 `:652`） | 上游 `v0.2.4:server/net.js:70` 的 `HEAVY_TYPES` **少两个**：`room.queue`（野排匹配是我们加的，非本次优化）与 `g.publicFull`（**上游无此意图**，见 §2.1 `PUBLIC_FULL_ASK_MS`） |
| `snapDropBytes`（发送缓冲超过则丢 `b.snap`） | `1 << 20` | `server/net.js:56`（用在 `:298`） | 同值 |
| `hardBufferBytes`（发送队列超过则断开） | `16 << 20` | `server/net.js:57`（用在 `:297`） | 同值 |
| `isDroppable` | 只有 `b.snap` 可丢；`m.public` **永不**因背压被丢 | `server/net.js:307`（用在 `:318`） | 同值 |
| `heartbeatMs` / `helloTimeoutMs` / `reconnectWindowMs` | `30000` / `30000` / `600000` | `server/net.js:53-55` | 同值 |
| `maxConnections` / `maxConnectionsPerAddr` / `maxSessions` | `2000` / `64` / `20000` | `server/net.js:58-60` | 同值 |
| `maxRooms` / `maxRoomsPerAddr` / `maxMatchesPerAddr` | `1000` / `16` / `8` | `server/lobby.js:155-157` | 同值 |
| `resyncMinGapMs`（重复 hello 的重同步间隔） | `1000` | `server/lobby.js:163` | 同值 |
| `lobbyGraceMs` / `soloReconnectWindowMs` | `60000` / `null` | `server/lobby.js:154`、`:164` | 同值 |
| 静态 gzip 阈值 / 缓存 | `GZIP_MIN_BYTES = 512`、`GZIP_CACHE_MAX_FILE = 8 << 20`、`GZIP_CACHE_MAX_TOTAL = 96 << 20`、level 6 | `server/http/files.js:62-64`、`:94` | 同值 |
| 匹配队列 `MATCHMAKE_DEFAULTS` | `size:null, max:null, waitMs:120000, sweepMs:5000, difficulty:'NORMAL'` | `server/matchmaking.js:59-70` | **上游无此参数**（野排匹配是我们的功能，与本次优化无关） |
| 座位上限 | **缺省 20 座**（`DEFAULT_MAX_SEATS`），`SP_MAX_SEATS=N` 可加 | `shared/constants.js`（`MAX_SEATS = 4`、`DEFAULT_MAX_SEATS = 20`、`maxSeatsFrom`）；`server/lobby.js:162` | 上游 `MAX_SEATS = 4` 且**无覆盖**（上游 `shared/constants.js` 没有 `maxSeatsFrom`）。**`MAX_SEATS = 4` 不动**：它是「官方房间 1–4 人」的声明与超容变体的参照，缺省上限是另一件事 |

**哪些参数能不改代码就调**：`startServer()` 选项里只有 `server/http/config.js:19-23` 列的键能被转发
（net：`reconnectWindowMs, heartbeatMs, helloTimeoutMs, ratePerSec, rateBurst, maxConnections, abuseDropsPerSec, maxConnectionsPerAddr, heavyPerSec, heavyBurst, trustProxy`；
lobby：`lobbyGraceMs, maxRooms, maxRoomsPerAddr, maxMatchesPerAddr, resyncMinGapMs, soloReconnectWindowMs, queue`）。
**§2.1 的五个参数都不在这两张名单里**——这就是「要动必须改源码」的确切依据。

### 2.3 席位上限：缺省 20 座，`SP_MAX_SEATS=N` 可加

一台**没设任何环境变量**的服务器现在允许房主开到 **20 座**（业主裁令 2026-10-12：「改成默认 20 吧，上限可加并给出文档」）。
这是**唯一**的接口，改法与 `PORT` 一样：

```powershell
# PowerShell（Windows）
$env:SP_MAX_SEATS = 40; npm start
```
```bash
# macOS / Linux
SP_MAX_SEATS=40 npm start
```
```
# cmd
set "SP_MAX_SEATS=40" && npm start
```

* **缺省 20**：解析见 `shared/constants.js maxSeatsFrom` —— 读 `SP_MAX_SEATS`，空 / 不可解析 / `< 1` ⇒ **20**
  （`DEFAULT_MAX_SEATS`）；小数**向下取整**（`7.8` ⇒ 7）。同一个数成为 `LOBBY_DEFAULTS.maxSeats`（房主滑杆的上限）
  与协议里的 `SEAT_CAP`（`room.create.seatCap` / `room.removeBot` / `room.kick` 的上界），三者不会漂。
* **`MAX_SEATS = 4` 一个字不动**：它是「官方房间 1–4 人」的声明，也是超容变体的参照 —— 见下一条。
* **`SP_MAX_SEATS=4` 回到官方那一档**：那时 `room.state` 与协议帧与从前的 4 座部署**逐字节相同**
  （`welcome.maxSeats` 仍会发、值为 4；`room.state.seatCap` 只在容量 ≠ 4 时才出现）。
* **抬席位常要同时抬连接上限**：`maxConnectionsPerAddr` 是 `startServer` 的**选项**（`server/http/config.js:20`），
  **不是环境变量**；注释里出现过的 `SP_MAX_CONNS_PER_ADDR` **代码里并不存在**（见 §7），别照它去设。同批还要看
  lobby 的 `maxRoomsPerAddr` / `maxMatchesPerAddr`（§2.2 的表）。
* **超容变体的闸门读的是「在场参与者数」，不是房间容量**：一场**超过 4 人**的对局才走「每人独立池 / 分小队联防」
  （`server/match/Match.js` 的 `variant`，一场开始时定死）。所以**容量 20、只坐 4 人**的房走的是原来那条代码路径，
  人头 `/血池` 等都不受容量影响；**快速匹配的队列门槛是「一间官方房」= 4，不跟随本变量**，只有显式配了
  `queue.size` 才由部署方决定（见 `docs/META.md` §1.9）。
* **旧浏览器要强刷**：这一改让缺省部署的 `welcome` **总是**多带一个 `maxSeats`。老页面不认这个字段，它的座位滑杆
  只会到 4（少要，不会发出服务器会拒的请求）；但**同一个房间的第 5 个人加进来时它会只画 4 张卡**。部署后让玩家
  刷新一次页面即可（资源版本戳会让老页面自己顶号）。

## 3. 同步与自愈：客户端多久发现错了、多快能修好

两条路互相独立，任一条都能收场：

- **服务端保活（无需客户端配合）**：每 32 个连续增量帧后，下一帧是全量。
- **客户端自救**：`applyPublic` 返回 `ok:false`（没有基线，或帧不可合并）时，客户端**不半途应用**
  （`public/js/main.js:379-382`），而是发 `g.publicFull`；服务端 `resendPublic` 立刻单播一份全量，
  并把**整个房间**的下一帧也置为全量（`server/match/match/platform.js:135-146`，配合 `markMembershipChanged`）。

**最坏窗口的算法**（不是拍脑袋，而是把上面两条路的边界相加）：

```
t_throttle = DELAYS.PUBLIC_THROTTLE = 100 ms                    // common.js:22
W_keepalive = PUBLIC_FULL_EVERY × t_throttle = 32 × 100 = 3200 ms   // common.js:40
W_ask       = PUBLIC_FULL_ASK_MS + RTT + t_server = 2000 + RTT + ε  // main.js:138 / platform.js:141
W_worst     = max(W_keepalive, W_ask) + RTT ≈ 3.2 s + RTT
```

读法与前提：

- `W_keepalive` 是「帧数 × 节流间隔」，所以它**只在帧真的在产生时成立**。静默阶段（例：没事发生的休整期）
  不产生增量帧，保活计数也就不会推进——此时窗口由「下一帧什么时候产生」决定，可能远大于 3.2 s。**这是本设计有意的**：
  静默期客户端手里的状态本来就没有落后。若你的场景必须给一个时间上的上界，只能靠把客户端自救做可靠（下一条）。
- `W_ask` 是客户端这一路的延迟：发现失败最多等 `PUBLIC_FULL_ASK_MS`（2000 ms），
  服务端在同一轮 `flush()` 里单播（`platform.js:141`），再加一个往返。
- `RTT`（往返延迟）与 `t_server`（服务端处理）**未证实**：没有实测数据，这里只作为加项保留。
- 保活帧数落在**最后一帧之后的下一帧**，所以实际是 `W_keepalive` 再乘以一个帧间隔的量级。

## 4. 顶号规则：什么改动必须顶 `PROTOCOL_VERSION`

判据只有一条：**「推送帧的形状变了，而且一个不会合并的旧页面会把它读错」才顶。**
旧页面只是**忽略**一个新增字段 ⇒ 不顶。

| 改动 | 顶号？ | 理由 |
| --- | --- | --- |
| 开始发 `delta: true` 的增量帧 | **必须顶（1 → 2，已顶）** | 没有合并逻辑的页面会把增量的 `players` 当成整份名册 ⇒ 名册变得明显错误，不是「旧一点」 |
| 增量帧里新增一个顶层键或行内字段 | 不必 | 旧客户端不认识就忽略；但**我们自己的客户端**要不要读它，得同步确认 |
| 新增一个 C→S 意图（例：`g.publicFull`） | 不必 | 旧客户端从不发它；新服务端只是没人叫它 |
| 改 `null`/`gone` 的语义，或改「行消失」的写法 | **必须顶** | 旧页面会把「键没了」当成「值是 null」而长期留着旧值 |
| 改 `serverNow` 在帧里的位置或名字 | **必须顶** | 客户端时钟同步直接读它（`public/js/net.js:583`；`public/js/main.js` 的物化状态） |
| 把 `PUBLIC_FULL_EVERY` / `PUBLIC_THROTTLE` / `PUBLIC_FULL_ASK_MS` 调大调小 | 不必 | 帧的形状没变 |
| 把第一帧从全量改成增量 | **必须顶** | 直接违反「joiner/reconnect 先拿全量」，旧页面读错 |

代价要说清：顶号的后果是**所有陈旧标签页在握手时被拒**（`server/net.js:715-716`，
`error BAD_MSG` + `detail: version mismatch: server <n>`，前端翻成「客户端版本与服务器不一致，请刷新页面」），
即「刷新一次」。这比让玩家看错名册便宜，所以本次顶了。

## 5. 风险：改这些参数容易踩的坑

- **把 `PUBLIC_FULL_EVERY` 调大 ⇒ 自愈窗口变长。** 32→128 时窗口约 3.2 s→12.8 s：玩家的名册 / LP 可能错十几秒才恢复。
  建议区间 16–64；只有在实测带宽吃紧、且已确认客户端 `g.publicFull` 这条路可靠时，才考虑超过 64。
- **把 `PUBLIC_THROTTLE` 调高会同时改变时间口径。** 保活窗口 = 帧数 × 节流间隔：200 ms 时 32 帧 = 6.4 s。
  改节流不能只看帧率，必须同时重算窗口。
- **把 `PUBLIC_THROTTLE` 调低 ⇒ 密集变化时带宽回升。** 100→20 ms 时帧频上限从 10/s 升到 50/s。
  本次优化省的是「每帧的字节数」，不是「帧数」；帧数翻五倍会把这笔收益吃掉。
  调到 0/1 等于取消节流，行为退回上游的「每次变化都发」。
- **`PUBLIC_FULL_ASK_MS` 不能取消（不能设为 0）。** 帧流损坏时客户端会**每收到一帧就请求一次全量**，
  而服务端每次应答都会 `markMembershipChanged()` ⇒ 整个房间下一帧全量 ⇒ 把「一个客户端的问题」放大成「房间级全量帧风暴」。
  这个 2000 ms 的设计作用正是把客户端请求频率压在服务端自愈频率之下。
- **降低 `PUBLIC_FULL_ASK_MS` 的并发风险。** N 个客户端各自每 `PUBLIC_FULL_ASK_MS` 最多请求一次，
  每次都把一个房间级全量帧排在下一帧。40 座房间里全量帧比增量帧大一到两个数量级，
  所以这个值同时是「客户端自救的灵敏度」和「房间级全量帧的频率上限」。
- **限速 `g.publicFull` 的手段就是把它放进 `HEAVY_TYPES`，与 `m.public` 无关。** 它现在**在**里面
  （`server/net.js:83`；闸门 `:652`），所以它不再吃普通桶 40/s、突发 40，而是和 `g.watch` 共用重负载桶
  `heavyPerSec: 2` / `heavyBurst: 6`（`:61-62`）。**为什么值得限**：一次请求买到的不是一个回包，而是
  **一份单播全量帧 + 整个房间的下一帧也变全量**（`server/match/match/platform.js:135-146`，`resendPublic` →
  `_sendFullPublic` + `markMembershipChanged`），所以 N 个请求就是 N 份全量帧。**算法（用仓库自己测出的字节数）**：
  40 座房间里一份全量帧是 **17282 B**（`test/match/public-delta-match.test.js` 打印的
  `[dense 40] full 17282 B`）。放进重负载桶前只受 `ratePerSec: 40` / `rateBurst: 40` 约束 ⇒ **第一秒最多 40 × 17 kB ≈ 680 kB**；
  放进后 ⇒ **稳定 2 × 17 kB ≈ 34 kB/s**，`heavyBurst: 6` 的一次性上限也才 **6 × 17 kB ≈ 102 kB**。
  **改法与代价**：想更松就把 `g.publicFull` 从 `server/net.js:83` 的集合里拿掉（它退回普通桶 40/s），
  或只把 `heavyPerSec` / `heavyBurst` 调大（`startServer()` 选项可覆盖，见 §2.2 末）；
  想更紧就调小这两个桶——但**不能再小到正常客户端之下**：客户端自己的闸门 `PUBLIC_FULL_ASK_MS = 2000`
  （`public/js/main.js:150`、用在 `:379`）把请求压在 **≤ 0.5 次/s**，桶的 2/s 有 **4 倍余量**，
  所以正常掉线的玩家照样要得到全量，被限的是「每帧都要全量」的那种失控节奏（后果见下一条）。
- **不要删 `g.publicFull` 的意图。** 删了客户端自救就断了，只剩保活一条路（窗口 3.2 s 起）。
  单纯新增这个意图**不需要顶号**（旧客户端从不发它）。
- **不要从增量帧里去掉 `serverNow`。** 它是客户端时钟同步唯一的每帧来源之一；
  而且它**本来就不参与 diff**（`server/viewsDelta.js` 的 `SCALAR_KEYS` 里没有它），
  增量帧里那一行是在 `server/match/match/messaging.js:190` 显式补上的。
- **`SCALAR_KEYS` 的维护是隐式契约。** 新增一个顶层字段却忘了登记，它的变化**不会**进增量帧，
  客户端会一直读到旧值，而且没有任何测试会因此变红（除非专门补用例）。
  行内字段没有白名单，改了就自动进 diff——所以「行内加字段」是安全的，「顶层加字段」不是。
- **`gone` 名单与 `null` 的区分不能弄反。** 顶层 `null` 是**真值**（`rerollVote`、`bossId`、`uniteResult`），
  「键消失」必须走 `gone`；行内 `null` 才是「键没了」。弄反会出现「客户端状态与服务端基线永久不一致」，
  表现为每 `PUBLIC_FULL_ASK_MS` 就要一次全量、房间被反复打成全量帧。
- **改完形状不顶号 ⇒ 最贵的坑。** 不顶号时，一台没合并逻辑的旧页面会一直错着读（名册、LP 都可能错），
  而服务端与测试都不会报错。反过来，顶了不该顶的号只是让所有人刷新一次——**不确定时，顶号的代价更小**。

## 6. 一页速查（运维 / 打包）

| 我遇到 X | 调 Y | 方向 | 注意 |
| --- | --- | --- | --- |
| 密集变化时带宽被打满 | `DELAYS.PUBLIC_THROTTLE`（`server/match/match/common.js:22`） | 100 → 150/200 | 同时重算保活窗口 = 32 × 新值 |
| 大房间仍嫌全量帧太多 | `PUBLIC_FULL_EVERY`（`common.js:40`） | 32 → 64 | 自愈窗口 3.2 s → 6.4 s |
| 玩家偶尔看到错的名册/LP，恢复太慢 | `PUBLIC_FULL_EVERY` | 32 → 16 | 全量帧占比上升，带宽回升 |
| 断线重连后界面卡在旧状态 | 先查客户端 `g.publicFull` 是否发得出去（`public/js/main.js:379`），再看服务端 `resendPublic`（`platform.js:135`） | — | 若两者都在，问题多半在 `canMerge` 判据，不在参数 |
| 服务端日志出现「刷新页面」式的拒绝 | `PROTOCOL_VERSION`（`shared/constants.js:16`）与前端构建号是否一致 | — | 这是顶号的正常后果；部署时前后端必须整包一起换 |
| 单人/测试环境想更快看到效果 | `opts.timerScale`（`server/match/Match.js:298`） | 调小 | 它**不会**改变 `PUBLIC_THROTTLE`（该值不经 `scaled()`），只会让阶段推进更快 |
| 想限定某个连接的调用频率 | `ratePerSec`/`rateBurst`、`heavyPerSec`/`heavyBurst`（`server/net.js:50-51`、`:61-62`） | 按需 | 通用网络层，与增量帧本身无关；但 `g.publicFull` **走重负载桶**（在 `HEAVY_TYPES` 里，`server/net.js:83`），不再走普通桶 |
| 想换上行前的反代行为 | `TRUST_PROXY` / `trustProxy`（`server/http/config.js:75`、`net.js:63`） | — | 通用网络层 |
| 100 人版需要更多连接 | `maxConnectionsPerAddr`（`startServer` 选项，`server/http/config.js:20`）与 `SP_MAX_SEATS` | 按需 | 注释里写的 `SP_MAX_CONNS_PER_ADDR` **代码里并不存在**（全仓只有注释提到它，未证实为可用环境变量） |
| 一台服务器默认允许多少座 | `SP_MAX_SEATS`（环境变量） | 缺省 **20**；`SP_MAX_SEATS=4` 回到官方那一档 | 抬席位**不会**自动抬连接上限：同抬 `startServer({ maxConnectionsPerAddr })`、lobby 的 `maxRoomsPerAddr` / `maxMatchesPerAddr`。快速匹配的队列门槛**不跟随**它（见 §2 末） |

## 7. 未证实 / 我们没法确认的

- 上游 `v0.2.3` 与 `v0.2.4` 的 delta 相关符号（`PUBLIC_FULL_EVERY`、`publicFull`、`viewsDelta`、`matchDelta`）
  经 `git grep` 与 `git ls-tree` 确认**完全不存在**；因此本表中标「上游无此参数」的项，上游没有可对照的字面值。
- 各参数改动后的**实际字节数 / 带宽收益**：本文只给了帧数与字节的结构算法，没有实测。
- `RTT` 与 `t_server`（服务端单播处理耗时）：未实测，`W_ask` 里的这两项只作为加项保留。
- `SP_MAX_CONNS_PER_ADDR`：仓库里只有 `server/lobby.js:159` 与 `shared/constants.js:76` 两处**注释**提到它，
  没有任何代码读取该环境变量；真正生效的是 `startServer({ maxConnectionsPerAddr })`。是否有构建脚本在外部
  设置这个变量，未证实。
