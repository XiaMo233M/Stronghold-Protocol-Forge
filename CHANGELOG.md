# 更新记录

**这一份 = 索引 + 最近 8 节；更早的按大版本分卷在 [`docs/changelog/`](docs/changelog/)。**

切点**由公告定，不由体积定**：`server/notices.js` 的 `engineAnnouncements` 从**本文件**生成游戏内公告 ——
它认「`## <版本> — <日期>`」的节、取**前 8 条**能展示的，所以**顶层留的节数就是公告的条数**。实测（当前解析器）：
留 1 节 → 1 条公告、留 7 节 → 7 条、**留 8 节 → 8 条**（上限就是 8）；**再往下切就静默少发公告**，
所以顶层至少要有 8 节。`0.16.0` 那一节是已发布事实，**原样留在原位、一字不改**。

> **维护规矩**：每发一版，新节写在**最上面**；顶层掉出公告窗口的那些节，**可以**移进对应的分卷
> （守卫 `test/docs-paths.test.js` 只要求「顶层仍能发满 8 条」，所以不急 —— 但顶层会一版一版变长）。
> 动顶层或分卷前先读 `test/docs-paths.test.js` 里那条守卫：**每一节只能出现在一处**。

| 卷 | 版本（新 → 旧） | 日期 | 文件 |
|---|---|---|---|
| **顶层** | 0.16.0-0.2.4 · 0.15.3-0.2.4 · 0.15.2-0.2.4 · 0.15.1-0.2.4 · 0.15.0-0.2.4 · 0.14.0-0.2.4 · 0.14.0 · 0.13.1 | 2026-10-10 – 2026-10-12 | 本文 |
| 0.13 | 0.13.0 | 2026-10-10 | [docs/changelog/0.13.md](docs/changelog/0.13.md) |
| 0.12 | 0.12.1 · 0.12.0 | 2026-10-10 | [docs/changelog/0.12.md](docs/changelog/0.12.md) |
| 0.11 | 0.11.1 · 0.11.0 | 2026-10-10 | [docs/changelog/0.11.md](docs/changelog/0.11.md) |
| 0.10 | 0.10.0 | 2026-10-09 | [docs/changelog/0.10.md](docs/changelog/0.10.md) |
| 0.9 | 0.9.4 · 0.9.3 · 0.9.2 · 0.9.1 · 0.9.0 | 2026-10-08 – 2026-10-09 | [docs/changelog/0.9.md](docs/changelog/0.9.md) |
| 0.8 | 0.8.2 · 0.8.1 · 0.8.0 | 2026-10-08 | [docs/changelog/0.8.md](docs/changelog/0.8.md) |
| 0.7 | 0.7.3 · 0.7.2 · 0.7.1 · 0.7.0 | 2026-10-08 | [docs/changelog/0.7.md](docs/changelog/0.7.md) |
| 0.6 | 0.6.4 · 0.6.3 · 0.6.2 · 0.6.1 · 0.6.0 | 2026-10-07 | [docs/changelog/0.6.md](docs/changelog/0.6.md) |
| 0.5 | 0.5.0 | 2026-10-07 | [docs/changelog/0.5.md](docs/changelog/0.5.md) |
| 0.4 | 0.4.2 · 0.4.1 · 0.4.0 | 2026-10-07 | [docs/changelog/0.4.md](docs/changelog/0.4.md) |
| 0.3 | 0.3.1 · 0.3.0 | 2026-10-06 – 2026-10-07 | [docs/changelog/0.3.md](docs/changelog/0.3.md) |
| 0.2 | 0.2.2 · 0.2.1 · 0.2.0 | 2026-10-06 – 2026-10-09 | [docs/changelog/0.2.md](docs/changelog/0.2.md) |
| 0.1 | 0.1.3 · 0.1.2 · 0.1.1 · 0.1.0 | 2026-10-02 – 2026-10-04 | [docs/changelog/0.1.md](docs/changelog/0.1.md) |

> 分卷文件**只存在于源码仓库**：玩家包里只带这一份顶层文件（`tools/package.mjs` 的 `PLAYER_DOCS` 不含
> `docs/changelog/`），所以上面那些链接在**解压出来的整合包里**是断的 —— 那 13 卷是**开发史**，玩家不需要；
> 要看就回源码仓库。

---
## 0.16.0-0.2.4 — 2026-10-12

### 对局战绩与可选账号（第 2 刀）

**战绩落盘 + 可选账号口令库（docs/RECORDS.md）。** 今天 `playerId` 每次连接都是新的，所以「我上一局打得
怎么样」换个会话就找不回来；这一刀给两样东西：一次完整结算落一条战绩，以及一个**默认关闭**的账号层（账号名 →
跨会话稳定的 `playerId`，口令由玩家自己持有）。

* **开关是显式的 `SP_ACCOUNTS=1`，不是「某个文件恰好存在」。** 没有它时 `AccountStore` 与 `MatchRecords` 都
  **不构造**：`hello` 里没有认证那一段、结算点不落盘、`GET /api/records/account/<NAME>` 回 404。**老客户端握手
  逐字节不变**（`playerId` 还是那 10 位十六进制临时 id）。
* **口令**：每账号 16 字节随机盐 + scrypt（`N=2^15, r=8, p=1`），`timingSafeEqual` 比较，**永不落明文、永不回显**，
  落盘 `0o600`。登录失败不区分「账号不存在」与「口令不对」（那会是账号枚举）；注册才分开
  `NAME_TAKEN` / `WEAK_PASSWORD`。坏库 / 版本不对 ⇒ 抛（fail closed）。
* **限流按客户端网络键**（`TokenBucket(0.1, 8)`）加同连接不并发派生 —— 一次 scrypt 是几十毫秒单核 CPU，没有这道
  闸门口令库就是一个 CPU 放大器。
* **改密入口本版不存在**（业主裁令）。投稿带的是 `POST /api/account/password` + 站点级共享 `SP_ADMIN_TOKEN`：共享的
  管理员密钥不是玩家的口令，而且它会让「必须提供旧口令」变成装饰。连为它服务的脚手架（`sameSecret` /
  `readJsonBody` / `adminToken` / `MIN_TOKEN_LENGTH`）都没有实现。将来要代改，另立一次性重置票据的设计。
* **战绩落盘有界**：JSONL 追加日志（行首 `v` = 行格式版本；坏行与未知版本**跳过并告警**），`byPlayer` ≤ 20000、
  `byRoom` ≤ 5000，追加到 5000 行时**原子压缩重写**（临时文件 + `rename`）。行数硬上界 `20000+5000+5000`。
  **代价**：压缩丢弃不再被索引引用的历史局 ⇒ 这不是一份可归档的战绩史（`SP_RECORDS_FILE` 指到会备份的地方）。
* **公开战绩面收窄**（业主裁令）：`GET /api/records/<CODE>` 只给 **seat + 是否本人**；`GET /api/records/account/<NAME>`
  只回**被查账号本人那一行聚合**（队友的昵称与逐回合购卡明细都不出现，本人明细走 `records.mine`）。昵称与购卡
  明细只到房间成员与本人。`playerId` 任何档位都不出现在公开面。**房间号不是安全边界**。
* **两条只读战绩路由限流**：每客户端地址 `TokenBucket(1/s, 突发 10)`，超限 **429 + `Retry-After`**；两条共用一只
  桶。HTTP 面不受 WebSocket 的桶保护，而 `/account/<NAME>` 若不限流就是一个账号名枚举面。名字与登录同一套键
  （NFC 归一 + 小写、**精确匹配**），「账号不存在」与「存在但没打过」**同答复**（否则是存在性探针）。
* **协议面**：`hello` 加**可选** `auth` / `password`；C2S 加 `records.mine`、S2C 加 `records.latest`。
  **`PROTOCOL_VERSION` 与 `MOD_API_VERSION` 都不动**，不改默认游戏行为 ⇒ **不需要 `golden:update`**。
  `server/net.js` 的 `HEAVY_TYPES` **只**多 `records.mine`（`room.list` / `room.skins` / `user.activity` /
  `lastInputAt` 属于第 3、4 刀，投稿的补丁把它们混在一起了，这里一律不带）。
* **`sanitizeName` 一律不动**：投稿要禁 `test` / `admin` / 三位以上 `a`。那反转的是**既有判定**（脱敏 + 截断），
  会打断 `test/lobby.test.js` 与 `test/client-static.test.js` 的既有断言，客户端 `title.js` 另有一份会漂移，而且
  它**不解决顶替** —— 另议。

### 房间目录读面：`GET /api/rooms` 只报一个数（第 3 刀）

**新增只读端点 `GET | HEAD /api/rooms` ⇒ `{ "publicRooms": <int> }`（DESIGN §28.42，docs/META.md §1.7a）。**

- **一个数，不是列表**：公开面**永远只有** `publicRooms` 这一个整数字段，**不**回答房号、房主名、人数或任何明细
  —— 任何一个这样的字段都能把「数」变成对某一个房间的**侧写**。`sendJson` 回答（`no-store`），
  `POST` 等动词走既有的 `405` + `Allow: GET, HEAD` 闸。
- **管理员面不新建任何东西**：`/healthz` 的 `rooms`（= `Lobby.stats().rooms` = `rooms.size` = **全部房间数**）
  就是业主要的那个数，运维口径。**本刀不引入** `SP_ADMIN_TOKEN` 这类共享管理员秘密。
- **「公开」的定义：今天没有这个概念，所以照实说。** 引擎今天没有「公开 / 私有」这个房间属性（`inviteOnly`
  不存在，本刀**不预埋**），因此 `publicRooms` 与 `/healthz` 的 `rooms` **今天恒等**，两者共用
  `Lobby.roomCounts()` 的**同一次遍历**与同一个 `rooms.size`（solo 房算数）。`this.rooms` 只装在册房间
  （`disposeRoom` 立刻 `delete`）。`inviteOnly` 将来落地后，`roomCounts()` 是唯一该改的地方。
- **协议面一字未动**：`shared/protocol.js` 的 C2S / S2C 不改，`server/net.js` 的 `HEAVY_TYPES` 不加任何东西,
  **不引入** `ACTIVITY_TYPES` / `user.activity` / `lastInputAt`；`PROTOCOL_VERSION` / `MOD_API_VERSION` **不抬**；
  默认逐字节不变（不新增任何线上帧，`/healthz` 的字段集合不变）。
- **投稿 `7ca51de6f346` 的采纳/改动说明**（作者 **Leiothrix**，来源 `NeoPecos/Stronghold-Protocol 2cadc618`，
  基线 `sganggs/Stronghold-Protocol bc50cac0`，许可 **GPL-3.0-or-later**，原件不含游戏素材）：
  原件要的是 C2S `room.list` + `user.activity` 与 S2C `room.list` —— 整张**公开合作房间**列表，每条含房号、
  房主代号、难度、真人与 AI 人数、在线及近期操作人数、招募或对局状态，并提供加入 / 观战入口，招募房间优先，
  **独立模拟（solo）房间不公开列出**；它自己在 `SOURCE.md` 里就写明这需要引擎提供**受限的列表读面**，
  **不要让普通模组直接访问整个 Lobby 内部**。
  **采纳**：受限只读读面这一条**方向**（业主裁令收窄为「只给公开房间数 + 管理员可看全部房间数」），
  以及「不要暴露 Lobby 内部」的边界主张。
  **改动**：不做全量枚举、不做 `room.list` / `user.activity` / `lastInputAt` / `inviteOnly` / `recruitWanted`，
  不做加入 / 观战入口与招募排序，**也不预埋**这些字段；公开面只剩一个整数。
  **未采纳的原因**：整张列表需要先有一整套「公开 / 私有」房间属性、一个心跳口径和一套限流，且会把 4 字母房号
  变成可枚举的东西。**solo 房**按业主裁令**算数**（与 `stats().rooms` 同口径），与原件「solo 不列出」不同 ——
  这一处是我们**刻意**的口径差异。
- **隐私边界（照实写）**：只给数 ⇒ 不泄露房号 / 房主名 / 人数明细；但 `n = 1` 时「数」就等于暴露「有一个房间
  存在」，`n = 0` 与 `n >= 1` 的差别本身可推「现在有没有人在玩」，这个量级无法再降。而 `/healthz.rooms` **今天
  就已经公开同一个数**（默认 `HOST='::'` 全网卡绑定），所以本刀新增的信息量约等于零。
- **测试**：`test/lobby.test.js` —— body 恰好一个字段、随注册表 +1 / 离开 −1、**隐私哨兵**（建房后响应文本不得
  含该房号或房主名）、HEAD 200 无 body、POST 405、`roomCounts()` 与 `stats()` 同源
  （`publicRooms === total ===` `/healthz` 的 `rooms`）。

### 素材加载源：`pack.json.assets.mirrors[]` + `sources(ctx)`（第 5 刀）

**素材加载源：`pack.json.assets.mirrors[]` + `sources(ctx)`（DESIGN §28.40，docs/WORKSHOP.md §1.21）。**
投稿 `2a031cf0f869`（「CDN 源选择」）的作者在 `note` 里把话说得很直：**做不到改素材加载源**。这一版把那一格补上，
由两半组成 —— 数据那一半 `assets.mirrors[] = [{ id, base, sha256 }]` 说**哪些镜像被允许**，面板模块导出的
`sources(ctx)` 说**先试哪一条**。

- **只镜像「本包自己的容器」**，绝不做「把整棵 `/assets` 树指到第三方」。三条硬事实：`data/assets.json` 只有
  清单级摘要、**没有逐文件摘要**（哈希锁得住清单字节、**锁不住图**）；把整站素材树交给第三方正是「不分发官方
  素材」要拦的形态；坏一个镜像就等于**全站**素材出问题，收窄之后只影响一个包。`server/http/static.js` 一行未改。
- **形状与守卫全部点名**：`base` 必须绝对 `https://`（有主机、无凭据、无查询、尾斜杠）、id 唯一且 ≤ 4 条、
  `sha256` 是 64 位小写 hex、字段闭集；声明了 `mirrors` **必须**写 `license`
  （`ASSETS_MIRROR_NEEDS_LICENSE`：素材的再分发者是作者，授权问题不因为换了一台主机就消失 —— 与 §28.36 的
  `VOICE_CDN_NEEDS_LICENSE` 逐字同一条理由）。八条拒绝码：
  `ASSETS_MIRROR_{BAD_SHAPE,UNKNOWN_FIELD,BAD_ID,DUPLICATE_ID,BAD_BASE,BAD_DIGEST,TOO_MANY,NEEDS_LICENSE}`。
- **装载期比对、不下载**：每条镜像的 `sha256` 必须等于**装载期从包内文件算出的**容器摘要；对不上的那条**停用并
  点名**（`ASSETS_MIRROR_DIGEST_MISMATCH`）而**不是拒绝整个包**（§28.35「宁少不拒」）。**服务端一条网络请求都不
  发** —— 没有服务端超时、没有服务端缓存目录、没有启动期阻塞（与 §28.36 的 `voiceCdn` 相反）。
- **客户端次序是硬性的**：取清单 → 取容器 → **先核整包 sha256**（必须 `checked && ok`）→ 再走**既有**的逐文件
  SHA-1[0:12] 导入与写缓存；任何一步不过就换下一条；**全都不行 ⇒ 回落包内那条 `/workshop-resources/…` URL 并
  点名**（`CLIENT_SOURCES_FALLBACK` + `via: 'pack'`，面板可见）。**不静默、不空白。**
- **`sources(ctx)` 结构上不可能引入主机名**：与外观提供者（`appearance(ctx)`）逐条同构（进程内最多一个、
  四个具名拒绝码、只提供不 `mount` 不是错），返回 `{ order(mirrors) }`，**只许回已声明 id 的排列或子集**；
  喂主机名 / URL / 未声明 id ⇒ `CLIENT_SOURCES_BAD_ORDER`，整条顺序作废。地址只在 `pack.json`，
  而每条都已在装载期与包内容器摘要比对过。
- **一键回退**：设置里新增「工坊素材源」（`settings.workshopSources`，默认开）。关掉 ⇒ 走的与「没声明 `mirrors`」
  **完全同一条**路径，镜像那条 URL **一次都不被请求**。
- **如实说清的做不到**：容器大于 **256 MiB** 用不了镜像（浏览器没有流式摘要接口），那类包只能走包内；不设这条线
  就等于「不核摘要也导入」，那是「不能算错」的直接反面。
- **缺省逐字节不变**：不声明 `mirrors` 的包归一化清单里没有这个键、`welcome.modAssets` 里没有这个字段、请求的
  URL 与次序与从前逐字相同、引擎 SW（§28.13.5）一行未改。**`MOD_API_VERSION` 仍是 1**（加一格字段不抬版本）、
  **不要求 `combat: true`**（只改「哪台主机送同一份已校验字节」，改不了这一局的结果；容器摘要本来就在内容哈希里）。
  **不新增协议消息、不动 `server/http/routeMount.js`、不动 `MOD_SURFACE_FROZEN['1']`**（新表面 `client.sources`
  只加不改）。

### 口径轴 `form`：干员形态投影（第 6 刀）

**口径轴 `form`：普通干员按精锐形态出战（DESIGN §28.41，docs/WORKSHOP.md §1.20）。** 投稿 `e4fe4d5cf0a0`
（「干员满练mod」）的 `training` 一段真正想做的那件事，在这里单独立项落地：`pack.json.variants` 加第三条轴
`form`（`official` / `elite`，缺省 `official` = 引擎今天的行为），`elite` 时每条**普通（`_a`）**棋子按它精锐兄弟
（`_b`）的**战斗职能**出战。

* **数值全部由引擎自己烘，包一个数都不许塞。** 投影从**引擎自己的** `_b` 记录读 `stats` / `trait` / `skill` /
  `skills` / `talents` / `module` / `modules[]` / `assets`（`shared/formProjection.js`；`IDENTITY_FIELDS` 复用
  `shared/standIn.js` 那一份）。投稿自带的那套数**没有被采纳**，而且是刻意不采纳：它比引擎今天**低**
  （投稿给 `chess_char_1_01_a` 的 `atk` 是 497，引擎的 `_b` 是 531），照搬会**静默降级**干员。
* **身份与价格都不动**：棋子 id、`tier`、`price`、`sellPrice`、盟约、特质、`upgradeNum` / `upgradeChessId` 仍是
  `_a` 那一份。
* **`status` 是身份标牌，不参与投影**（`phase` / `level` / `skillLevel` / `equipLevel` 整格留在 `_a`）。这条是**刻意
  的**，三条理由：**①** 引擎从它读补位形态（`shared/standIn.js` 的 `statusKey` → `backups.units[charId].forms`）、
  模组激活与技能档位（`:64`），`test/backups.test.js:209` 逐字钉住 `_b` 的 `status` —— 挪过去会连带改掉这三条既有
  语义；**② 数据本身不允许**：129 对里 **39 对**的 `_b.level` **小于** `_a.level`（`1/55` → `2/50`），照搬会让那 39
  块地**显示练度回落**，直接违反本轴的「不许降级」；**③** 投稿自己也是这个口径（它对 `_a` 只写
  `status.skillLevel = 7`，不改 `phase` / `level`）。作者的意图仍然达成：投影后 `_a.skills[]` 每条的 `level` 与
  `_a.skill.level` **都跟着精锐走**（引擎里 `skillLevel` 与 `skills[].level` 恒等，`test/data.test.js:453` 钉住）。
* **两条如实披露的后果**（业主裁决 2026-10-13；两者都是刻意的，也是它必须标 `combat: true` 的理由）：
  **① 1 阶价拿到精锐形态的数值**（价格不动 ⇒ 一枚 1 阶棋子带着精锐的数值上场）；
  **② `upgradeNum` 不动 ⇒「3 张 `_a` 换 1 张 `_b`」在投影下价值中性**（不是 bug：投影改的是战斗职能，不是合成经济，
  改它就越出这个声明的范围）。
* **召唤物同一个轴**：`data/tokens.json` 里 owner 变体有 `_a` / `_b` 一对的召唤物（本季 19 个），`_a` 的 owner 变体
  在 `form: "elite"` 下换成 `_b` 的那一条；没有 `_b` 变体的原样不动。
* **缺省逐字节不变**：不声明这个轴的包，`GameData.chess(id)` / `DataSource.rawChess(id)` 返回 `data/chess.json` 里
  **那个对象本身**（`===`，对象身份不变）；`test/golden/*.json` 一个字节都不动，**不需要** `golden:update`。
* **面板与战斗不分叉**：`Match` 建**一份**形态视图，`GameData` 与这一局的 `DataSource` 共用；`Match.js` 的
  `dsCache` 缓存键并进了 `form` 口径（同一份 data 的两个房间，一个声明 `elite`、一个不声明，各拿各的
  `DataSource`）。
* **`combat: true` 是硬闸门**：沿用既有的 `VARIANTS_NEED_COMBAT`（口径改对局结果 ⇒ 必须进房间摘要闸门与 golden
  语料），本刀没有新增闸门。**`MOD_API_VERSION` 仍是 1**（只加一格口径选项，不新增协议消息、不改默认游戏行为）。
* **不许降级**是逐条断言的门（干员与召唤物都过）：投影后每条记录的 `atk` / `maxHp` / `def` 必须 ≥ 投影前
  （`test/form-projection.test.js`）。

### 行为补丁 / 声明通道：`pack.json.behaviour`（第 4 刀）

**`pack.json.behaviour`：引擎实现一格，任何包声明它（DESIGN §28.43，docs/WORKSHOP.md §1.22）。** 投稿
`ac8c9821f5ba`（「卫戍协议mod-跨版本一键安装包-v1.4.8-适配0.2.4」）把「改一条规则」做成了**安装器**：`install.mjs`
（43,658 B）按 `files.json` 的 `copy` 清单**整份覆盖** `data/{chess,config,items,official,skins}.json`、`server/**`
48 个文件（含 `server/sim/**` 22 个）、`public/**` 五十余个与 `payload/tools/**` 13 个。它自己的 `files.json`
把语义写得很直：「**Nothing is trimmed: a target that gets the whole file gets the whole feature**」。本刀**不
把这套搬进引擎**，而是开一条受约束的声明通道 —— 判断与 `official` / `config` / `meta` / `shared` / `theme` /
`serverModules` 六格「刻意没有通道」**逐字一致**。

* **形状与 `variants` 逐字同构、表独立**：`behaviour = [{ switch, option?, name?, desc? }]`，条目字段闭集，
  归一化结果按开关名排序（键序是清单字节）。它与口径**分两张表**，因为入场券不同 —— 口径必有「官方那一档」、
  缺省＝引擎今天的行为；行为开关是「引擎里本来没有、现在由维护者实现的规则」。混在一起会把口径那条唯一的执行点
  逼成一个通用 patch 分发器。**`VARIANT_AXES` 一字不动。**
* **包里没有数值、也没有路径**：动作（`{ kind, value }`）**由引擎构造**，`value` 只能来自那一格或引擎自己的常量。
  `module` / `entry` / `file` / `path` / `value` / `key` 这类键在形状层**点名拒**，理由里写清「一条行为声明只说
  一个开关与它的一个选项」；这一层**没有**「删官方键」的表达能力（没有 `$del`）。
* **不认识的声明响亮失败**：`BEHAVIOUR_UNKNOWN_SWITCH` / `BEHAVIOUR_UNKNOWN_OPTION` / `BEHAVIOUR_BAD_OPTION` /
  `BEHAVIOUR_BAD_SHAPE` / `BEHAVIOUR_DUPLICATE_SWITCH`，每一条都整包拒绝并点名。
* **本版那张表是空的 —— 这是交付物本身**（业主裁决 2026-10-13）：第 4 刀交的是「**通道 + 守卫**」，通道真的通、
  且响 —— **任何**一条 `behaviour` 声明都被 `BEHAVIOUR_UNKNOWN_SWITCH` 点名整包拒（空表不是「一律忽略」，而是
  一个都不认识，文案里写清「本版一个开关都没有，因为没有实现点」）。**首格与它的引擎实现点一起落**，由业主点名；
  加一格的门槛因此比加口径轴更严。
* **第五条 `combat` 硬闸门**（`BEHAVIOUR_NEEDS_COMBAT`）：一格的入场券本就是「它改一条规则」⇒ 必须进房间摘要闸门
  与 golden 语料，与 `server.meta` / `server.battle` / `modules[].uses: ["matchClass"]` / `variants` 四条同一条线。
  将来若有一格**明确改不了结果**，它必须**不**要求 `combat`（判据是能力，不是意图）。
* **不是贡献项**：一个只带 `behaviour` 的包照旧 `EMPTY_PACK`（与 `support` / `playtest` / `variants` 同一条），
  文案里点名 `"behaviour" is NOT a contribution`。
* **缺省逐字节不变**：不声明 `behaviour` 的包归一化清单里**没有**这个键（否则所有已发布包的内容哈希全变、房间的
  摘要闸门误判）；声明了**必须**进包身份哈希（只差一个开关的两份包摘要必须不同），**不进** `modDigest`
  （只哈希 `[id, hash]`），随 `welcome.mods[].behaviour` 与 `variants` 并列投影（漏掉投影 = 开关**静默不生效**）。
  **`MOD_API_VERSION` 仍是 1**（加一格字段不抬版本）、**不新增协议消息**、不改默认游戏行为 ⇒
  **不需要 `golden:update`**。**`MOD_SURFACE_FROZEN['1']` 不动**（新表面 `behaviour` 只加不改）。
* **判据写成「表是入参」的纯函数**（`parseBehaviourDecl(raw, table)` / `behaviourSwitchIssues(table)` …）：表是空的，
  写死的话「选项名不认识」「同一个开关写两遍」「缺省写错」这些分支**任何测试都碰不到**，而一条从来没验过失败分支的
  守卫和没有守卫是一回事（与 `surfaceLedgerIssues(ids, generation)` 同一条理由）。`normalizePackManifest` 因此多一个
  **可选** `opts.behaviourSwitches`（默认真表；装载器 / 校验器 / 编辑器一律不传）。**如实说清**：这是为可测性加的
  一个入口，不是新能力。
* **投稿 `ac8c9821f5ba` 的采纳 / 改动说明**（作者 B站@伊佐那邪_，来源
  `github.com/yznx09/Stronghold-Protocol-Rhodes-Kazdel-Mod`，站点 `flagged/`，`flags` 含 `EXECUTABLE`(blocker) /
  `NO_PACK_JSON` / `WRAPPED`）：
  **采纳**：它真正需要的那一类「改一条规则」的**方向** —— 由引擎实现、由包声明（本刀把那一格开好）；
  以及它**自带内容包**那一半（`payload/packs/fanpack/`：`pack.json` 893 B + `records` / `chess` / `tokens` /
  `variants` + 7 张**自制** PNG）所属的通道 —— 那一半今天**已有**通道（`content` + `kits/` + `art` / `bondIcons` /
  `itemIcons` + `variants`），只是**格式不同**（它的 `type: "data"` / `files{}` / `_doc` / `credits` /
  `englishName` 不在 `PACK_FIELDS` 里，会被 `PACK_UNKNOWN_FIELD` 点名拒）。
  **改动 / 未采纳**：**不采纳安装器**（`install.mjs` + `一键跨版本安装.bat`）、**不采纳整包 `payload/` 上架**、
  **不采纳**对 `data/*.json` / `server/sim/**` / 整屏 UI / `tools/**` 的**整份覆盖**语义；`EXECUTABLE` 那条
  suspected 命中的只是文件名 `.bat`（规则字面判对、实务误判），但**整份覆盖**这条语义本身正是本刀要拦的形态。
  **它自己遵守「不分发官方素材」**：`files.json` 自述官方 `public/assets/**` 从不随包发（`install.mjs --assets`
  才下），所以那 7 张图是自制的 —— **对外表述必须与这条一致**，不要把它说成侵权包。
  **站侧含义**：原件在 `flagged/` 且 `flags` 含 `NO_PACK_JSON` + `WRAPPED`（全部文件套在 `跨版本安装包/` 一层下）
  ⇒ **若做成兼容包上传，必须先扁平化**（`pack.json` 必须在 zip 根）。这条归站侧那条线。

### 本版刻意没有做、或被否决的部分（照实写）

- **②（战绩/账号）**：投稿带的 `POST /api/account/password` + 站点级共享 `SP_ADMIN_TOKEN` **没有实现**，连为它服务的
  脚手架（`sameSecret` / `readJsonBody` / `adminToken`）都没有 —— 改密必须是**账号上的操作**，等一次性重置票据的设计。
  投稿还要禁 `test` / `admin` 这类名字，**未采纳**（那会反转既有判定，且不解决顶替）。
- **③（房间目录）**：投稿原件的 C2S `room.list` / `user.activity` 与 S2C `room.list`（整张房间列表 + 招募排序 + 加入 /
  观战入口）**没有采纳**，`inviteOnly` / `recruitWanted` / `lastInputAt` **一律不预埋**；公开面只剩一个整数。
  **solo 房算数**（与原件「solo 不列出」不同）—— 这是刻意的口径差异。
- **⑤（素材源）**：不把整棵 `/assets` 树指到第三方，**只镜像本包自己的容器**；服务端**不发任何网络请求**；
  容器 > 256 MiB 用不了镜像（浏览器没有流式摘要接口）。
- **⑥（形态投影）**：`status` **不参与投影**（身份标牌；39/129 对里 `_b.level` 更低，照搬会显示练度回落）；
  价格与 `upgradeNum` 不动 ⇒「一档价拿到精锐数值」与「3 张 `_a` 换 1 张 `_b` 价值中性」两条**如实披露**。
- **④（行为声明通道）**：**本版这一格没有任何可用开关** —— `BEHAVIOUR_SWITCHES` 今天为空 ⇒ **任何**一条 `behaviour`
  声明都会被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒**。这是刻意的：**格子先立起来、开关逐个按需加**
  （首格与它的引擎实现点一起落）。

## 0.15.3-0.2.4 — 2026-10-12

**变体 / 口径层：`pack.json.variants`（DESIGN §28.39，docs/WORKSHOP.md §1.20）。** 三个社区 mod「写了等于没写」
的键之一（0.10.0 时代 `normalizePackManifest` 从没读过 `variants`，`{content:["chess","variants"]}` 归一化后只剩
`["chess"]`）现在是一条**真通道**：同一份数据的两套表现 —— **满练度 / 12 部署位** —— 由包声明、由这一局执行。

* **它是闭枚举的口径声明，不是数值覆盖通道。** 包说的是「哪一套」，**不是「改成几」**：轴与选项名都在
  `shared/variants.js` 的 `VARIANT_AXES` 里，值由引擎自己给。首发两条轴：`training`（`official` / `full`，缺省
  `full` = 引擎今天的行为）与 `deploy`（`official` = 数据里的官方 8 / `max` = 12）。**一个能指定任意文件覆盖的包
  格式就是安装器** —— `official` / `config` / `meta` / `shared` / `theme` / `serverModules` 那六格「刻意没有通道」
  的判断逐字不变。
* **不认识的声明响亮失败**：`VARIANTS_UNKNOWN_AXIS` / `VARIANTS_UNKNOWN_OPTION` / `VARIANTS_BAD_DEFAULT` /
  `VARIANTS_BAD_SHAPE` / `VARIANTS_DUPLICATE_AXIS`，每一条都整包拒绝并点名。
* **`combat: true` 是硬闸门**（`VARIANTS_NEED_COMBAT`）：口径改对局结果，所以必须进房间摘要闸门与 golden 语料
  —— 与 `server.meta` / `server.battle` / `matches[].uses: ["matchClass"]` 同一条线。
* **缺省逐字节不变**：不声明 `variants` 的包，归一化清单里不长出这个键（否则所有已发布包的内容哈希全变、房间的
  摘要闸门误判），`GameData.deployCap` 逐字是数据里那个 8，`data/*.json` 一个字节不动。**`MOD_API_VERSION` 仍是 1**，
  不新增协议消息，**不改默认游戏行为 ⇒ 不需要 `golden:update`**。
* **顺手修掉一条既有的静默失败**：`content` 里不认识的条目从前被安静过滤掉（`{content:["config"]}` 只是变成一个
  空包），现在点名拒 `UNKNOWN_CONTENT_FILE`。
* **一处收敛**：硬编码在 `server/match/effectsMeta.js` 的部署位天花板 `12` 提成 `shared/constants.js` 的
  `DEPLOY_CAP_MAX`，与 `deploy: "max"` 口径共用同一个数（一个数只有一个真相）。
* **口径随 mod 条目走**：`server/index.js` 构建 `welcome.mods` 的条目时带上 `variants`。`modDigest` 只哈希
  `[id, hash]` 对，所以**任何摘要都不变**（改摘要等于让每个已发布的包在同一条房间里被判成「另一个包」）。漏掉
  这一步口径会**静默不生效** —— `test/workshopVariants.test.js` 的「装载结果 → 房间 mod 集合 → `Match` 的那条链」
  钉住它。

**还没做的**：`training` 今天落在引擎**已有的**练度开关（`room.loadout.ops`：潜能 1–6 与 未精英化→精英2 Lv.60）
上；把一名**普通**干员的精锐形态数值投影给它（投稿 `e4fe4d5cf0a0` 的 `training` 一段真正想做的那件事）是另一条
新规则，不在这一刀。

## 0.15.2-0.2.4 — 2026-10-12

本仓库自己的版本 **0.15.1 → 0.15.2**；打包的上游游戏本体**仍是 0.2.4**（这一批没有任何上游改动）。
`MOD_API_VERSION` 仍是 **1** —— 这一批全是加法，已发布的包一个都不受影响，也不需要重装已装的包。
上游游戏本体仍是 **0.2.4**，发行 tag：`v0.15.2-0.2.4`。

**静态 `pack.json.routes` 收紧：核心先吃**（DESIGN §28.13.2 / §28.35，实现见 `server/http/static.js` 与
`shared/workshop.js` 里那张核心保留表判据）。立场从 `static.js` 那句「声明过的路径就是声明过的路径」改成：包声明与
核心**真的同名**时，**声明不生效**（核心挂载照旧回答）、**响亮点名**（装载报告一条 `errors` + 启动日志一行
`log.warn`）、**包不被拒**。判据**按文件探**，不按前缀：先看核心**是不是真的会服务这条路径**（`dataDir` /
`sharedDir` / `simDir` / `publicDir` 里逐字存在那个文件，或命中常量端点），只有那样才算顶掉。**线上被打到的
包 = 0**：唯一声明 `routes` 的 `f3711c357e20`（`ws-compression-reference`）声明 `/data/ws-compression.json`，
而 `data/` 下没有同名文件 ⇒ **照常生效、也不报警**。这是**刻意选的兼容做法**：宁愿少生效一条声明，也不让一个
已发布的包因为多写一行就装不上；副作用是好的 —— 核心将来真长出那个文件时，同一条声明**自动**让位，不必再改规则。

**席位缺省上限 4 → 20 座**（业主裁令 2026-10-12）。一台**没设任何环境变量**的服务器现在**缺省允许房主把一间同盟房
开到 20 座**（原来 4 座）：`SP_MAX_SEATS=N`
可加（`SP_MAX_SEATS=4` 回到官方那一档），解析见 `shared/constants.js maxSeatsFrom`（空 / 不可解析 / < 1 回落到
`DEFAULT_MAX_SEATS = 20`，小数向下取整）。**`MAX_SEATS = 4` 一个字没动** —— 它是「官方房间 1–4 人」的声明与
超容变体的参照。快速匹配的**队列门槛固定为「一间官方房」= 4 人，不跟随**这个上限（只有显式配 `queue.size` 才由
部署方决定）。`welcome.maxSeats` 变成**每次握手都发**（原来只在上限 ≠ 4 时才发），所以「vanilla 握手逐字节不变」
这条承诺改成「**`SP_MAX_SEATS=4` 时不变**」；老页面不认该字段只会少要（滑杆到 4），服务器不会拒。

**超容变体的闸门改成读「在场参与者数」**（`Match.participants` / `Match.variant`，一场开始时算一次、定死，
真人 + AI，旁观席不算）：容量 20、只坐 4 人的房**走原来那条代码路径**，5 人起才进「每人独立牌库 / 分小队联防 /
逐玩家守恒」。`PlayerState.variantOn` / `planUnite` / `collectViolations` 读同一个值。结算帧多一个
`variant` 字段（`m.result` 是自由形状，客户端忽略未知键），日志在结算时点名人数与路径。

**`ctx.battle.damage()`：逐单位伤害读数，让包自己算 DPS**（DESIGN §28.38，实现见 `public/js/battle/runner.js` +
`public/js/ui/extensions.js` + `public/js/main.js`）。§28.30 把伤害看板拆成两半，说逐单位那一半「今天读不到」——
这一节补上：一格**只读**的逐单位 / 逐人累计伤害，外加**时间基准** `gt` / `t0`（`dps = dmg / (gt - t0)`）。它
**不是新账，是一个读者**：伤害早在模拟里逐次命中就记好了（`server/sim/damage.js`），这一格只把那些数字按面板看得懂
的形状抄出来（逐人那几行照 `Battle._buildResult()` 的配对写法 —— 座位与账**不是同一个对象**，写错一边会永远读到
`0`，这条静默错误由 `test/modClientBattleReads.test.js` 钉住）。每次读一份**新的、冻结到第二层**的副本；
`players[].dmg` 已含 `bossDmg`；`uid` 必须给（面板对名单靠它）。**只给屏上这一场**（队友那几场不在这一格里；全队
总伤仍走 `m.result`）。拿不到就是 `null`（四种出口各自只记一行；准备期 / 结算期**不记**）。**不新增 `pack.json`
声明，`MOD_API_VERSION` 不动。**

**这一版起旧页面不需要手动强刷**：`/js`、`/css` 走 `Cache-Control: no-cache` **强校验**
（`server/http/files.js` 的 `cacheControlFor`），文件变了**刷新一次**就拿新的；开着不动的旧页面由
`public/js/ui/buildGuard.js` **自己叫刷** —— 不在对局里当场自动重载一次，对局里**不丢这一局**（横幅提示刷新，
局终自动刷新）。**若只改了服务端**（不进构建标签那几棵树），刷新一次即可。线协议号没动（`PROTOCOL_VERSION`
仍是 2），握手不拒旧页面。

配套文档见 `docs/NET-TUNING.md` §2.3（怎么设、要同抬 `maxConnectionsPerAddr`、`SP_MAX_CONNS_PER_ADDR`
**并不存在**）、`docs/META.md` §1.9 / §1.9b、`README.md` 的环境变量表与 `docs/DEPLOY.md`；`ctx.battle.damage()`
的形状与边界见 DESIGN §28.38。

## 0.15.1-0.2.4 — 2026-10-11

本仓库自己的版本 **0.15.0 → 0.15.1**；打包的上游游戏本体**仍是 0.2.4**（这一批没有任何上游改动）。
`MOD_API_VERSION` 仍是 **1** —— 这一批全是加法，已发布的包一个都不受影响，也不需要重装已装的包。
上游游戏本体仍是 **0.2.4**，发行 tag：`v0.15.1-0.2.4`。

**面板读面第二批：`ctx.me.voice` / `ctx.session.setVoiceLang` / `ctx.net.transport()`**（`docs/design/mod-layer.md`
§28.31 / §28.32，实现见 `public/js/ui/extensions.js` + `ui/settings.js` + `main.js`）。面板答不出「这台机器现在
用哪套配音」（那个值住在设置库，与 `ctx.me` 读的不是同一个 store），也答不出「这条 WebSocket 实际跑在什么
参数上」（浏览器侧 `WebSocket` API 不暴露 `Sec-WebSocket-Extensions`）——补一格读数加**一个受限写口**：
`ctx.me.voice` 是 `{ global, byChar }` 的冻结副本（每次读一份新的，`byChar[charId] ?? global` 就是播放时那个
语言，形状不对的键不进快照，拿不到就是 `null`）；`ctx.session.setVoiceLang(charId, lang)` 是**面板能写的唯一
一格设置**：只改 `voiceLangByChar` 的一个键、过同一份 sanitize、走同一条既有 `savePref` 订阅，值是闭枚举
（`''` / `null` = 清覆盖），越界一律点名（`CLIENT_VOICE_*`）而不是静默丢弃；`ctx.net.transport()` 读的就是
`welcome.transport`，缺字段 ⇒ 整格 `null` 并记一行，**绝不自己造默认值**。

**`pack.json.server.transport`：声明式的启动期传输配置**（§28.33）。`perMessageDeflate` 原先写死在
`server/http/websocket.js`，一个想开压缩的包只能手改引擎那一行。现在它是一张字段闭集
（`deflate` 必填，其余有上下界），复用 `assets.serverPolicy` 的同一条三件套（读声明 → 收敛成**一个进程级**的
值 → 启动日志点名），多包声明时包 id 小的赢、其余点名。**只是声明**：包永远不能注入服务端代码去改 `wss`。
生效值随既有的 `welcome` 帧送出去，**报的是生效值不是声明值**；没有任何包声明时仍是 `false`，与这一刀之前
逐字节相同。

**`uses: ["metrics"]` 与 `boot(config)` 的冻结快照**（§28.34）。`host.metrics()` 交出的是一份**深冻结的标量
快照**（`uptimeSec` / `rss` / `heapUsed` / `elu` / `loopP*` / `sampleAgeMs` / `state`）：是值不是句柄，没有
`process`、没有直方图、没有定时器、没有函数，惰性启用（没包声明时开销为零），样本过期就 `loopP*` 全 `null` +
`state: "stale"` + 点名一次。`onBoot` 的回调收到深冻结只读配置快照 `{ port, host, stateDir, env }`（真正绑到的
port / host 才在里面，`env` 只带 `BOOT_CONFIG_ENV_KEYS` 白名单）——包只能观察，不能设值。

**`uses: ["route"]`：动态只读端点 `/mod/<包id>/…`**（§28.35）。`pack.json.routes` 只能挂一个包内写死的
`.json`，「内容随运行时状态变」表达不出来。这一格是一个**同步返回 JSON 可序列化值**的回调：路径必须在
`/mod/<包id>/…` 里（结构性隔离）并再判一遍核心保留路径表，只有 GET / HEAD，缓存只有 `no-store` / `no-cache`，
体 ≤ 64 KB，四种失败各自点名并回 500。**认证口径与引擎其余 HTTP 面逐字一致：没有认证** ⇒ 它不是私有通道。

**作者自备 CDN 的语音素材**（§28.36）。业主口径：**分发官方语音不行，但留出「按作者写下的地址取作者自己的
素材」这条路**。所以 `voices` / `voiceLangs` 的条目可以是 `{ url, sha256, file }`：协议只认 `https:`、
`sha256` 是作者声明的内容摘要（取回来必须对上，对不上不落盘、不服务）、`file` 是包内逻辑位置（客户端看见的
URL 与「素材本来就在包里」时逐字相同）、声明了就必须写 `license`、失败逐条点名并把那条台词从客户端语音表里
摘掉（回落默认配音，而不是留一条永远 404 的静音）。**引擎里没有一个语音素材主机名常量、没有新增任何下载
路由、`VOICE_LANG_*` 一个字没放宽**。

**三个「说了没做」的真 bug。** 一、`shared/modSurface.js` 的 `server.modules` 那一格从第一天起写着「源码过静态
确定性扫描（无 `process` / `require` / `eval`）」，而 `server/modModules.js` 只检查了文件读得到就直接 `import()`
进服务器自己的进程 —— 现在在 import **之前**跑 `stripComments` + `mentionsIdentifier`，取与另外三处同一张共享表
（`SERVER_CODE_FORBIDDEN_GLOBALS`）**去掉 `globalThis`** 一格（承诺逐字是那三个名字，而仓库里有一个能用的
`server.modules` fixture 用 `globalThis` 与同进程测试通信）。二、`MOD_SURFACE_FROZEN['1']` 原先直接写成
`MOD_SURFACE_IDS`：两者是同一个数组对象 ⇒ 从表面清单里删掉一格时账本跟着一起少一格，守卫恒真、真实代码路径
从来没有红过（装饰性守卫比没有守卫更坏），现在改成手抄字面量并加断言钉住「两者不是同一个对象」。三、面板
数据表上限是手写的 13，而名单在 `notices` 加进来之后是 **14** ⇒「把这个面板要读的表全列出来」这件最自然的事
被判成超限，错误文案还写着「at most 13 tables (that is all of them)」；现在上限由名单推导
（`CLIENT_MAX_PANEL_DATA_TABLES`），并有断言钉住「上限 == 名单长度」。

**如实说清的四件事。** ① 那道源码扫描是**启发式，不是沙箱**：`globalThis['pro'+'cess']` 这类拼字符串仍然绕得过
（另外三处也一样绕得过）；真正兜底的是「同一份包字节 ⇒ 同一份服务端代码」的内容哈希与模块只能拿到 `uses` 里
声明过的那几样东西。② 静态 `pack.json.routes` 通道仍然可以声明一条与核心挂载同名的路径（`server/http/static.js`
的「声明过的路径就是声明过的路径」），**本批没动**：核心保留路径表这一批只施加在**动态**通道上，给静态通道补
这条判据会改变已发布包的行为，需要单独裁。③ `/healthz` 的 `ok` 恒为 `true`、状态码恒为
`200`，**「不 ok 时 503」做不到、本批也不做**：要那个语义就得先定义「谁的不 ok」，而「任一第三方包说不 ok 就摘流量」
正是这一层一直在拒绝的能力形态（详见 §28.37）。④ 文档里**既有**的 13 处 `文件:行` 引用漂移（非功能性引用）
**本批未修**，留作单独一次重数。

## 0.15.0-0.2.4 — 2026-10-11

**`m.public` 改成增量帧**（`docs/design/network.md` §8.2.1，实现见 `server/viewsDelta.js` +
`server/match/match/messaging.js` + `public/js/matchDelta.js`）。帧现在有两种形态：**全量**（整张视图，仍是首帧与每个
重置点发的那个）与**增量**（`delta: true`：只带变了的顶层键，`gone: [...]` 列出消失的顶层键，`players` 每个变了的座位
一条 `{ playerId, 变了的字段… }`、离场座位 `{ playerId, gone: true }`，`fields` 每个变了的场地一条、场地创建/销毁时带
`fieldsFull: true` 整表替换）。行内的 `null` 表示「这个键没了」、客户端删键；全量帧里行的 `null` 也物化成同一状态。

- **为什么**：40 座房间里每帧重发 40 行是 O(座位数 × 字段数) 的载荷，而单客户端收包的绝大部分就是它。字段级增量让
  帧的大小只随**真正变化的字段数**增长。
- **语义不变是验收点**：客户端把增量合进自己那份物化状态后，与全量帧**逐字段相同**。真对局的帧流走浏览器自己的合并
  再与全量帧对比，4 座与 40 座各一遍（`test/match/public-delta.test.js`、`test/match/public-delta-match.test.js`）。
- **重置点**（下一帧必为全量）：首帧；任何成员变化（加入 / 离开 / 断线 / 重连 / 观战者 —— 全房共用一条基线，所以整房
  都收到全量帧，不只是掉队那一个）；某次广播没能送到所有 socket；以及每 `PUBLIC_FULL_EVERY`（32）个连续增量帧的保活。
  因此新加入者 / 重连 / 观战者**先收到全量再收增量**。
- **自愈**：客户端合并不了时（没有基线、补丁点不到座位）**不半途应用**，发 `g.publicFull` 要一份全量；服务器也会按保活
  周期主动补一份全量。两条路各自独立，都有测试。
- **不再发无用帧**：脏标记没有实际变化时一帧都不发（原样保留）。
- **客户端时钟**：`serverNow` 每帧都带（增量帧也一样），但它不属于被 diff 的状态。
- **`PROTOCOL_VERSION` 1 → 2**：这次改的是**帧的形状**，一个**没有合并逻辑的旧页面**会把增量帧的 `players` 当成整份名册
  读 —— 不是「值旧了」，是**人数与名册显示错**。引擎本来就有一条现成的版本闸门（`hello` 声明线上版本号，不一致时
  `server/net.js onHelloMsg` 在握手第一步就回 `BAD_MSG` 'version mismatch'、不建会话，浏览器把它渲染成「客户端版本与
  服务器不一致，请刷新页面」），所以这次只需要把号**顶上去**（`shared/constants.js`，附带说明什么形状变化才需要顶号）：
  跨部署一直开着的旧标签页会被明确要求刷新，而不是静默进对局显示错名册。测试：
  `test/match/connection.test.js`「a page from the previous wire format is refused at the handshake…」（旧号被拒、
  拿不到 `welcome` / 房间 / 任何 `m.public`；新号进局的第一帧是全量且有完整名册）与 `test/version.test.js`。
- 测试客户机（`test/helpers/wsClient.js`）现在也照浏览器的方式物化 `m.public`（`publicFrames` / `stateOf` 拿到的是物化
  后的完整视图，`log` 里仍是原始线上帧），所以既有用例读到的仍是完整视图；它握手用的版本号改为读 `PROTOCOL_VERSION`。
  既有套件里**写死的线上版本号也一并改成读 `PROTOCOL_VERSION`**（`test/lobby.test.js` 的替换连接用例、`test/modPreDispatch.test.js`
  的三条 preDispatch 帧）—— 写死的 1 在顶号后会被新闸门正确拒掉，那不是回归而是闸门生效；改读常量后这两条用例不再写死格式号。
- **既有断言语义变化（唯一一条）**：`test/match/connection.test.js` 的 `m.public` 形状检查里，`players[].bandId` /
  `players[].fieldId` / `players[].ready` 从「**必须有这个键**」改成「**有值或缺席都合法**」（`p[k] == null || k in p`）。
  为什么必须变：这两个键在引擎里是**显式 null**（未定策略 / 未上场），而增量帧里「未设」与「这个键没了」物化成同一个
  状态（客户端合并后是缺席的键）—— 否则「全量帧的 null」与「增量帧删掉的键」会materialize成两种不同的行，增量就没法
  保证「物化后与全量逐字段相同」。改前断言「键必须存在（值可为 null）」，改后断言「键可以有值，也可以缺席」；其余
  字段（`playerId`/`seat`/`name`/`isBot`/`connected`/`alive`/`lp`/`shopLevel`/`boardCount`/`bonds`/`status`）仍然**必须存在**，
  断言没有放松（只对这两个「未设」字段更贴近真实语义）。

**行为层 kit 的键空间从「一个」变成「两个」**（`docs/WORKSHOP.md` §4.7，设计见 `docs/design/mod-layer.md` §28.12.1）。
一个 `kits/<id>.js` 的 id 现在可以是：

- **干员 id** —— 本包 `chess.json` 的记录 id，或**本包声明进自选池的 charId**（`pack.json.operators` 的键；模拟层
  `kitOf` 对自选干员就是按 `def.charId` 查 kit 的），或 `overrides` 里的 `"chess:<id>"`；
- **召唤物的 token id** —— 本包 `tokens.json` 的记录 id，或 `overrides` 里的 `"tokens:<id>"`。

这条补上的是那半个缺口：包的召唤物以前只能有**数据**、没有**行为层**（`server/sim/content/tokens.js` 的
`kits[tokenId]` 是引擎内置的表，包碰不到）。两个键空间的注入点与送达通道与本来的那条逐字对称：
服务端 `Battle opts.kits`（干员）/ `Battle opts.tokenKits`（召唤物），浏览器从**同一份** `spec.workshopKits`
清单重建两张表（召唤物那一半带 `kind: 'token'`，缺省即干员，所以老包与老读者一个字节都不变）。

- 归属：本包自己的记录、`pack.json.operators` 的 charId、`overrides` 的声明 —— 三条里满足一条即可，否则
  `KIT_NO_TARGET`（既有裁决，未放松）；真的存在但**不属于本包**的 id 是 `KIT_OFFICIAL_OVERRIDE_UNDECLARED`。
- 冲突裁决沿既有规则（§1.2 / §28.3）：**包 id 字典序小的赢**，输的一方被点名（`definedBy`）——改为**按空间各裁一次**。
- 新增一条拒绝：一个 id **同时**是干员与召唤物（合并后的两张表都有它，现实例子是 `data/tokens.json` 里那两名
  `char_` 开头的地图角色）⇒ `KIT_TARGET_AMBIGUOUS`。不猜、不静默：干员那一半会赢，召唤物那一半会成一条永远
  不跑也没有任何报错的 kit。判据是**查表**，不是看名字前缀。
- 无包对局逐字节不变：`spec.js` / `Match` / `combat.js` 只在有值时设这个键，`lobby.js` 送进去的 `opts` 与从前一致。
- 文档落在 `docs/WORKSHOP.md` §4.2 / §4.3 / §4.7、`docs/EDITOR.md`、`docs/prompts/kit.md`、
  `docs/design/mod-layer.md` §28.12.1。测试：`test/workshopKits.test.js`（召唤物通道十条）、
  `test/kitAuthoring.test.js`（`ownCharIds` / `ownTokenIds` / 歧义）、`test/roomAssets.test.js`。

**`pack.json` 的 `api` / `game` / `gameVersion` 写成非字符串时点名拒绝**（`shared/workshop.js`，文档见
`docs/WORKSHOP.md` §1.9）。以前这三个键的解析只有 `strField` 一个人，而它把非字符串读成 `null`（「缺省与写错都
读成没声明」），于是 `api: 1`（JSON 数字）在 `api &&` 的两条校验里都短路、归一化结果 `api: null` —— 包当没声明
一样通过，作者看到的是「包合法、我写的区间没生效」。失败方向是静默的，正是本仓库那句「写了等于没写」。

- **新增两个拒绝码**：`BAD_API_TYPE`（`api`）与 `BAD_GAME_TYPE`（`game` 与别名 `gameVersion` 同一条判罚）。
  理由里点名**哪一个键**、写成了**什么类型**、以及「非字符串会被读成没声明」。类型判罚**先于**区间语法：
  `api: 1` 报的是 `BAD_API_TYPE` 而不是 `BAD_API_RANGE`。
- **缺键路径逐字节不变**：三个键全缺（或写成 `undefined`）的包不进任何新分支，归一化清单不多出键、身份哈希与
  今天逐字相同（`test/workshopDeclTypes.test.js` 钉住一个缺键包的身份哈希）。
- **`null` 与省略同一后果、不是错误**：仓库既有语义就是「`null` = 没有这个键」（编辑器写元数据那一端把 `null`
  当「删掉这个键」；`layer` 的解析分支对 `undefined || null` 逐字相同），空串与纯空白同理。没有发明「显式 null
  也算无效声明」这条新语义。
- **`strField` 的全局行为没有改**：它今天只有 `api` / `game` / `gameVersion` 三个调用点，做法是在调用点前面加一道
  类型闸门（`declaredString`），而不是让它自己报错。
- **编辑器元数据页那条是另一件事**：`tools/workshop-pack.mjs` 的 `PACK_META_FIELDS` 不含 `api` / `game`，所以
  元数据页显示不出它们（只显示 `gameVersion`）—— 本刀**没动**，见 `docs/WORKSHOP.md` §1.9 状态表那一行。
- 测试：`test/workshopDeclTypes.test.js`（14 条：类型拒绝 / `"1"` 通过 / 缺键逐字节不变 / `null` 与空串语义 /
  别名与优先级 / 非贡献项）。既有 11 处 mod 相关套件（`workshop*`、`modIdentity*`、`packMeta*`、`packAssets*`）
  没有因此变红。

**可变座位：房主用滑杆决定本房人数上限**（`shared/constants.js`、`shared/protocol.js`、`server/lobby.js`、`public/js/screens/{lobby,room}.js`，文档见 `docs/META.md` §1.9）。`SP_MAX_SEATS` 仍是**这台服务器允许**的最大座位数（缺省官方 4），房主在建房界面用滑杆选**本房**开几张座位卡（`MIN_SEATS` 2 … 服务器上限，缺省＝不另设上限）。`room.create.seatCap` 只作用于同盟房间，越界或垃圾值**点名拒绝**（`BAD_MSG` / `bad field seatCap`）而不是静默钳制；服务端再用同一个纯函数 `clampSeats` 兜底不走协议的调用方。`welcome.maxSeats` 只在服务器上限 ≠ 4 时才发，滑杆据此定范围。**容量为 4（或缺省）时 `room.state` 与协议帧逐字节不变**。快速匹配不受影响：队列上限就是服务器上限，被建房时还没有房主可问，因此不发 `seatCap`。（**本条的缺省值与队列口径已被 2026-10-12 的裁令更新**：缺省上限 4 → **20**，`welcome.maxSeats` 改成每次握手都发，快速匹配的队列门槛固定为**一间官方房 = 4**、不再跟随服务器上限 —— 见文首「未发布」一节。）

**房主建房后仍可改本房容量**（`room.setSeatCap { code, seatCap }`，`docs/META.md` §1.9a）。房主可在房间里把自己这一房的座位数改大或改小，**守卫是两条**：`新上限 ≥ 房间内现有人数（真人 + AI）` **且** `新上限 > 最高被占座位号`（座位允许有空洞）—— 合起来让缩容只可能砍掉**空**座位，所以**永远不可能踢掉任何人**，也不会移动任何人的座位号。两种拒绝**分得开**：数字本身不合法 ⇒ `BAD_MSG`，数字合法但装不下现有人数 ⇒ 新的 `SEAT_CAP_TOO_SMALL`；一处都**不静默钳制**。另有 `NOT_HOST` / `NOT_IN_ROOM` / `ROOM_STARTED` / `BAD_TARGET`。改完广播 `room.state`，调回 4 时 `seatCap` 键消失 ⇒ 4→8→4 与改之前**逐字节相同**且幂等。房间页给房主一个滑杆（下限跟现有人数走、上限是服务器上限），座位网格与房间版式**一个字节没动**。

## 0.14.0-0.2.4 — 2026-10-11

这一版把**上游游戏本体从 0.2.3 抬到 0.2.4**（本仓库自己的版本号仍是 `0.14.0`，发行 tag 按 `v<本仓库>-<上游>` 读作 `v0.14.0-0.2.4`）。上游这 28 个提交 / 129 个文件带来的主要变化如下。合流方式沿用既有的三方分类后处理：我们没碰过的 **69 个**直接采纳上游的 0.2.4 版本，两边都改的 **47 个**用 `git merge-file` 做三方合并（其中 33 个自动干净、14 个逐一人工消解），上游**新增**的 **13 个**原样补入。`data/config.json` 由 `tools/build-data.mjs` 重新生成（未手改产物）；`test/golden/*.json` 的实际改动等业主点头后再跑 `npm run golden:update`。

### 规则（按官方）
- 共享卡池和装备库存按官方规则补齐（依据路标档案馆的实测视频和公开资料）：单人和同盟的干员份数不同（同盟为 2 倍，单人部分低阶干员例外）；装备也有全队共享的库存，部分特殊装备例外；普通 / 进阶装备分别占 1 / 2 份，商店展示不占份数，购买时再检查一次，机变卡用尽时不能再选，消耗、销毁、出售和淘汰都会归还份数。商业包装方案是同时最多持有 2 份，不是整局限购 2 次；拟态物质按符合条件的干员身份抽取，整备也不会超过库存。
- 突袭成员复活后若没有阻挡敌人，会按新的优先级重新选一次落点（嘲讽优先，其次离蓝门最近）；脚下有敌人时留在原地，普通的轮询和再部署仍按原规则。联机首领 / 隐秘首领战中，突袭可以跳到空半场的正常部署格；手牌区、临时区、单人模式和单人联防的空半场仍不行（#475）。
- 浊心斯卡蒂一技能和坚守同时生效时，伤害不再互相反弹导致战斗卡住，两边分走的伤害也与原伤害守恒（PR #464，感谢 @HappyTanuki）。
- 哈洛德二技能在友方只有元素损伤时也能开启（PR #459）；涤火杰西卡的盾牌只能放在相邻四格（PR #460）；家族徽章在解除隐匿后的第一笔伤害触发（PR #461）；松果二技能每次重新部署都重新成长（PR #462）。感谢 @Xinglan233。
- 克莱门莎二技能溅射按更新后的资料修正（半径 1.1、100% 攻击力），扩展范围内只有可选飞行目标时也会自动开启（#467）；白面鸮复制歌蕾蒂娅 / 余时，准备期赠送不再要求三人条件（#473，按实机视频，只限这两个特例）。
- 琳琅诗怀雅的香槟炸弹不会再被友方的光环、鼓舞或治疗选中（PR #468 / #476，感谢 @Siornya）。
- 首领战超时扣血的额外宽限只留给有 AI 队友的队伍。

### 界面
- 琳琅诗怀雅技能自带的金币显示在血条下方，显示余额和上限（PR #450，感谢 @IceCodeNew）；外勤医疗策略在准备阶段显示预备医疗（PR #451，感谢 @YinqiMargatroid）；香槟炸弹可使用原皮模型。
- 大厅标题栏重新设计（PR #471，感谢 @YuriRestia）；日语界面改用官方日服用语（PR #448，感谢 @scutkane）；大字号下结算页的返回按钮不再被挤出屏幕。
- 自选编队的详情与干员调配共用同一套数值、技能和潜能练度显示；自选 / 补位干员的伤害公告显示正确名称。
- 渲染资源加载失败后会自动重试并可恢复 3D 画面，不会重开正在进行的战斗；主动选择的平面模式会保留。战斗中重新进入同一场战斗时，箱子等装置仍可以点开说明。
- **本仓库采纳上游 0.2.4 的 8 条日译修正**（中文原文未变、只改日译，属与上游收敛，不是覆盖本仓库的定制；见 `docs/history/0.2.4.md` §31.6 / PR #448）：`作战结束` 戦闘終了 → 作戦終了、`作战结束，等待队友完成作战` 戦闘終了。… → 作戦終了。…、`自动回复` 自動回復 → 自然回復、`全员无伤！` 全員無傷！ → 完璧な作戦！、`交流` 通信 → 交流、`休息一下` ひと休み → 休憩タイム、`层数叠加已禁用` 加算数は増加しません → 盟約加算無効化中、`作战中无法查看队友，作战结束后可前往查看` → …作戦終了後に確認できます。其它语种未动（`node tools/i18n.mjs check --all --strict` 与移植前一致：ja/ko/zh-TW 各缺 44 条）。

## 0.14.0 — 2026-10-10

这一版把**上游游戏本体从 0.2.2 抬到 0.2.3**（本仓库自己的版本 0.13.1 → 0.14.0）。上游这 36 个提交 / 203 个文件
带来的主要变化：新干员**克莱门莎**（本源近卫，三个技能、两项天赋），**黍「好时节」与乌尔比安「前路」模组**，
四档界面文字大小，逐干员配音语言，添加到桌面（PWA），开局重随，恢复本机对局，以及按官方数据与社区反馈
修正的一批规则与界面。上游的四档界面文字大小落在 `--t` 这一个变量上，本仓库自己加的那两个样式表
（`public/css/screens/room.css`、`support.css`）也接到了它（用既有的 `max(calc(N * var(--t)), Mpx)` 写法，
默认档数值等价）。

**合流方式与以往几次不同，值得写明**：本仓库与上游**没有共享的 git 历史**（merge-base 为空），所以没有
`git merge` 可用 —— 做的是**三方分类后处理**：

- 上游改了但**我们从来没碰过**的文件 **1134 个**：不动（我们那份就是上游那份）；
- 上游改了、而**我们那份与上游的 0.2.2 逐字节一致**的 **91 个**：直接采纳上游的 0.2.3 版本（等于没改动）；
- **两边都改、合并有意义**的 **65 个**：用 `git merge-file` 做三方合并 —— 其中 **38 个自动干净**落下，
  **27 个真冲突人工消解，合计 65 处冲突**，零冲突标记；
- 上游**新增**的 **47 个**文件：原样补入。

**白名单别名 11 条一条没动**（`shared/kitImports.js` 的 `@kit/` `@sim/` `@battle/` → 引擎真实路径）。
这条是这一版最要紧的兼容结论：已装的 mod **不会因为上游挪文件而失效**、不需要重置。照
`docs/UPSTREAM-UPGRADE.md` 的清单重跑了一遍，上游这 36 个提交**动到了 0 条白名单别名**；
`shared/kitImports.js` 与 0.13.1 那份**逐字节相同**。（宿主槽位与契约面各有 2 个文件被上游改了，
都在同一个提交里按上游形状对齐，见下。）

- **`data/` 用新版游戏数据缓存重新生成**（`node tools/build-data.mjs`），产物与上游 0.2.3 **逐字节相同（8/8）**
  —— 采纳不是盲抄，是同一条生成链跑出同一份结果。
- **素材清单用自有管线重建**（`node tools/fetch-assets.mjs --add-only --refresh-index --voice-langs=cn,jp,en,kr`）：
  恢复本仓库的 `audio.voiceLang = jp` 与 `audio.voiceLangs`（**cn 192 / en 182 / kr 182**），并带上上游 0.2.3 的
  **192 名**有官方语音的干员（0.13.1 是 191 名，多的那一位就是克莱门莎）。**这一条必须走我们自己的管线** ——
  直接取上游的 `data/assets.json` 会把逐干员配音的词表退成上游那两档（cn / jp）。

### 两处有意分歧（都写清了理由）

- **逐干员配音：实现用本仓库的，上游那套调用形状保留为接口层。** 单一真相是设置里的 `voiceLangByChar` 加
  `shared/constants.js` 的共用词表 `VOICE_LANGS`（**cn / jp / en / kr** 四个）。上游 0.2.3 为同一件事另开过一套
  调用（只有 cn / jp 两档），本仓库**不并存两套状态** —— 那会出现「设置里选了 A、实际播的是 B」。
  所以那个模块变成**接口层**：对外提供与上游**同名同签名**的 `VOICE_LANGS` / `sanitizeVoiceOverrides(raw)` /
  `voiceLangFor(charId, globalLang, overrides)`，内部一律委托给设置与共用词表，自己一份状态都不存；
  将来上游再动这块，调用点不必跟着改。界面（干员详情、干员调配）走本仓库形状的
  `voiceLangOverrideOf` / `voiceLangOf` / `withVoiceLang`。
- **上游 0.2.3 的历史小节在本仓库记为 `docs/DESIGN.md` §30。** 本仓库的 §28 / §29 是 **mod 层**与 **meta 载荷**
  （`docs/design/mod-layer.md`、`docs/META.md`），而代码里**到处引用「§28」**（20 多个文件），不能改号 ——
  所以上游新那一节顺延到 §30（`docs/history/0.2.3.md`），漂掉的行号引用按「那句话点名的东西」重新对位。

### 上游把克莱门莎收成了官方干员 ⇒ 工坊端到端夹具换 id

上游 0.2.3 把克莱门莎收成官方干员（官方 id `char_4231_clemnt`），而本仓库的工坊端到端夹具用的**正是那个 id**
（当初它是虚构的）。夹具再用它就会被加载器按 `OFFICIAL_ID_COLLISION` 拒掉，所以改用工坊保留前缀
**`char_ws_clemnt`**（与本文件其它虚构干员同一约定），**载荷一个字节没改**；自选池计数随之 71/72 → 72/73。
缘由写在 `docs/examples/clementia/README.md`：要覆盖官方干员得走 `overrides`。

### golden：六个语料里五个与上游逐字节相同，只有 matches 差一个场景

`test/golden/` 的六个语料随上游 0.2.3 一起走，但**两边的口径要说清楚**（这里踩过一次措辞）：

- **`roster` / `bonds` / `fields` / `standins` / `diy` 五份与上游 0.2.3 逐字节相同**。它们确实在合流时动过
  —— 上游 0.2.3 自己重算了这批语料（`diy` 从 138 个场景增到 140 个，多出来的两条编在 `diy-135` / `diy-136`，
  正是克莱门莎那两条，末尾的编号随之顺移；`roster` 8 个、`fields` 7 个、`standins` 1 个场景的内容/编号也移了）
  —— 但**我们没有偏离上游**，所以最终是逐字节一致，而不是「一字未动」。
- **只有 `matches` 与上游不同，差的就是一个场景 `coop2-NORMAL-14-standins`**（18 个场景里的 1 个，
  其余 17 个与上游逐字节相同）。它是 `npm run golden:update` 按**我们这边**的代码重算出来的，
  两个原因各自独立：
  1. 本仓库有一条**有意与上游不同**的玩法（维护者的决定，代码写在 `server/match/player/economy.js` 的
     `_rollChessSlot`）：自己带上场的**助战干员**在商店里按 `data/support.json` 的价目进抽取池，且
     「我的商店池里一定有它」。这个补位场景里那名真人席位的商店抽取因此与上游不同，结局自然不同。
     这条偏差在合流**之前就存在**（0.13.1 时本仓库语料记的就是我们的值），合流时按「取上游 recording」
     暂时盖掉了，所以现在按仓库规矩重算并在此点名。
  2. 上游 0.2.3 把合作模式的开局策略改成**每人 50 秒**（`data/config.json` `timers.bandTurn` 30 → 50），
     这也是同一场景虚拟时长变化的来源之一。

上游游戏本体 **0.2.3**，发行 tag：`v0.14.0-0.2.3`。这一版发**四件**：完整包、增量更新包（**基准 0.13.1**）、
源码包、语音包。

### 门槛（发布前全绿）

`node --test` **7651 条 / 7647 通过 / 0 失败 / 4 跳过** · `eslint` **0 错** · `tsc --noEmit --checkJs` **0 错** ·
`npm run golden` exit 0（六份语料 **49 / 46 / 22 / 18 / 10 / 140** 全部 match，其中 `matches` 的那一场景按上面
的说明重算）。

## 0.13.1 — 2026-10-10

一件补齐：**时装现在也影响小头像**。上一版（0.13.0）把「一套外观」的链路与声明做了出来，但那条链只接到了
**立绘** —— 头像那一类还留在旧函数上，于是换上外观之后会出现这一幕：

> **结算页、队伍面板、手牌、商店卡上的小头像是原版，而详情页的立绘已经是新装。**

这个错**没人会报**，因为两个画面各自都对得上自己的代码。根源是引擎里同一个干员一直有**两条**互不相通的
头像解析路径（详情页那条只认 `_1` / `_2` 后缀、通用那条先精确查 `chars[id]`）—— 平时两者答案相同，
一旦引入一套外部外观就会分叉。

这一版把**每一个**头像消费点都接到同一条链上：

- `ui/gameComponents.js` 的 `UnitThumb` —— **结算页、队伍面板、手牌、商店共用这一个组件**，所以接它一次覆盖四类；
- `ui/detailPanel.js` 立绘、`ui/shopBar.js` 商店卡、`ui/fallbackField.js` 补位头像；
- `screens/{loadout,diy,ownership,support}.js` 四个屏幕。

旧的 `chessAvatarUrl` / `chessPortraitUrl` **保留导出** —— 它们是这条链的**对照实现**（链的测试逐例拿它们比对）。
另外加了两条**源码级守卫**：逐文件断言「`import` 之外没有一处还在直接调旧函数」，且「每个消费点都传了
`currentAppearanceLookup()`」。所以以后哪个消费点偷偷留着旧调用，套件会**红**，而不是给某个玩家看一张过期的图。

修好这条链还顺手换来一件事：**没有外观提供者时，上面每一处的输出与从前逐字节相同**（链的第一、二、三分支
就是旧实现那几条），所以这一版对不装外观 mod 的人**没有任何可见变化**。

上游游戏本体仍是 **0.2.2**，发行 tag：`v0.13.1-0.2.2`。这一版只发**源码包**与**升级包**两件（增量包基准 0.13.0）。

### 门槛（发布前全绿）

`node --test` **7451 条 / 7448 通过 / 0 失败 / 3 跳过** · `eslint` **0 错** · `tsc --noEmit --checkJs` **0 错** ·
`npm run golden` exit 0（六份语料 49 / 46 / 22 / 18 / 10 / 138 全部未变）· `data/` 与 `test/golden/` **零改动**。

