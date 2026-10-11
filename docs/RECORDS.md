# 对局战绩与账号（`SP_ACCOUNTS=1`）

这一页是**补充文档**，放在 `docs/` 根下（**不在** `docs/design/` 里，因此不占 DESIGN 段号）：`test/docs-paths.test.js`
要求 `docs/design/` 与 `docs/history/` 下每个 `.md` 都是一个 `§N` 分片，而这个功能没有属于它的段。规则性的东西
（协议形状、`ERR` 码）仍然写在 `shared/protocol.js` 与 `shared/constants.js` 的注释里。

## 1. 它解决什么

今天 `playerId` 每次连接都是新的（`server/net.js` 的 `'p_' + randomBytes(5)`），所以「我上一局打得怎么样」在换
个会话之后就找不回来了。这一层给两样东西：

* **战绩落盘**：一次完整结算落一条，重启后还在（`server/matchRecords.js`）；
* **可选账号**：账号名 → **跨会话稳定**的 `playerId`，玩家自己用口令证明身份（`server/accounts.js`）。

中途退出、服务关闭**不产生**记录。旧版本从未持久保存的对局**无法补录** —— 落盘只认结算那一刻给的事件。

## 2. 开关：`SP_ACCOUNTS=1`

**这一层默认完全关闭，而且不是靠「文件存不存在」判的。** `server/index.js` 只在 `SP_ACCOUNTS` 匹配
`1` / `true` / `yes`（大小写不敏感）时才构造 `AccountStore` 与 `MatchRecords`；否则两者都是 `null` 并且：

* `Network` 收到 `accounts: null` ⇒ `hello` 里**没有**认证那一段。老客户端（不发 `auth` / `password`）照旧拿
  `welcome`，`playerId` 还是那 10 位十六进制的临时 id —— **握手逐字节不变**；
* `Lobby` 收到 `records: null` ⇒ 结算点不落盘，`records.mine` 回 `{ record: null }`；
* `GET /api/records/account/<NAME>` 回 **404**（功能不存在），不是「这个账号没有战绩」。

这条不变量由 `test/accounts.test.js` 的第三个测试钉住。测试可以用 `startServer({ accounts: true })` 显式打开，
它**不读**环境变量。

## 3. 口令是怎么存与怎么验的（`server/accounts.js`）

* 每账号 **16 字节随机盐** + **scrypt** 派生 32 字节键；文件里只有 `salt` / `hash` 的十六进制，**永不明文**、
  也**永不回显**（错误信息里也没有）。落盘用 `mode:0o600`。
* 参数 `N=2^15, r=8, p=1, maxmem=64MiB`。**取舍**：OWASP 当前推荐 `N=2^17`，`2^15` 是折中；它已经比投稿的
  `2^14` 高一倍。一次派生约 32 MiB 内存 + 单核几十毫秒 —— **这两个数字就是攻击面**（拿它当 CPU 放大器很划算），
  所以真正的闸门不是参数而是 `server/net.js` 的 `authBuckets`（按**客户端网络键**限流，`TokenBucket(0.1, 8)`）
  加 `conn.authenticating`（同一连接不并发派生）。继续抬 `N` 会让合法玩家等更久、让攻击者更划算。
* 比较一律 `timingSafeEqual`，且在**长度守卫之后**（不等长只可能是记录损坏，不是攻击面）。
* **登录失败不区分「账号不存在」与「口令不对」**：都回 `BAD_CREDENTIALS`。区分就是账号枚举。
  注册时才分开：`NAME_TAKEN`（换名字）/ `WEAK_PASSWORD`（换口令）。
* 账号名按 NFC 归一 + 小写作键，所以 `Alice` 与 `alice` **互相占用**。
* 坏库 / 版本不对 ⇒ **抛**（fail closed），绝不「当空的用」—— 那等于静默注销所有人。
* 落盘是原子的：同目录临时文件（`flag:'wx'`）+ `renameSync`。**欠 `fsync`**（防进程崩溃，不防掉电）。

## 4. 战绩的落盘、上限与可见性（`server/matchRecords.js`）

* 形状：**JSONL 追加日志**，一行一局，行首 `v` 是**行格式版本**。装载时逐行解析：坏行与**未知 `v` 都跳过并
  告警**（将来演进行形状时，旧进程读到新行是「少一条」，不是「起不来」）。
* **不许无界增长**（业主裁令）：两个索引各自有上限 —— `byPlayer`（`records.mine` 真正要的那张表）
  ≤ 20000，`byRoom` ≤ 5000；追加到 `COMPACT_AFTER_APPENDS = 5000` 行时**原子压缩一次**，把两个索引当前指向的
  记录重写进文件，其余历史行丢弃。文件行数的硬上界是 **`20000 + 5000 + 5000`**，由
  `test/match-records.test.js` 断言。
* **代价（明写）**：压缩丢弃不再被索引引用的历史局 —— 「ABCD 房间的上一局」查不到，只有「最近一局」。这不是
  缺陷（`GET /api/records/ABCD` 的语义就是「最近一局」），但它意味着**这不是一份可归档的战绩史**。要归档就把
  `SP_RECORDS_FILE` 指到会被备份的地方，并在压缩前另行导出。
* **可见性分三档**（业主裁令：公开面只给 seat + 是否本人）：

  | 档位 | 谁 | 昵称 | 逐回合购卡明细 | `playerId` |
  |---|---|---|---|---|
  | `PUBLIC` | 只知道房间号（`GET /api/records/<CODE>`） | ✗（显示 `P1`…`P4`） | ✗（`null`） | ✗ |
  | **账号面** | 知道账号名（`GET /api/records/account/<NAME>`） | ✓（**只有他自己那一行**，队友的行根本不出现） | ✗（`null`，**比本人那一档更严**） | ✗ |
  | `MEMBER` | 同房的人 | ✓ | ✗ | ✗ |
  | `OWNER` | 本人（`records.mine`，已认证会话） | ✓ | ✓ | ✗ |

  `playerId` **任何档位都不出现在公开面**（它在 journal 里留着，因为 `records.mine` 与压缩都要用它）。
  账号面**不是** `OWNER` 档：拿账号名来查的调用方（机器人、任何知道名字的人）**不是**那个账号的持有者，所以
  它只回**被查账号本人的一行聚合**，且不给购卡明细；本人要完整明细走的是 WebSocket 的 `records.mine`。
  「账号不存在」与「账号存在但这局里没有他」**同答复**（404 + 同一个 body），否则这个端点就是**账号存在性
  探针**。名字与登录**同一套键**（NFC 归一 + 小写、**精确匹配**），不做前缀或模糊。
* **房间号不是安全边界**：知道 4 个字母就能查到那个房间 4 个座位号。这一点**写在这里，不复述成承诺**。
* **两条只读路由都限流**：HTTP 面**不受** `server/net.js` 的 WebSocket 桶保护，所以 `server/http/routes.js`
  给这两条各挂一只 **每客户端地址**的 `TokenBucket(1/s, 突发 10)`，超限回 **429 + `Retry-After`**（不是静默
  空结果 —— 「限流了」与「没有这条记录」必须可分辨）。两条**共用**一只桶，换个路由不能翻倍额度。
  **已知边界**：键取 `socket.remoteAddress`。直接暴露时不可伪造；**挂在反向代理后面且代理侧没限流时，所有人
  共用一个地址、共享同一只桶** —— 宁可漏限流也不按可伪造的 `X-Forwarded-For` 分桶（那会让攻击者换一个头就
  重置额度）。**代理后面请自行限流。**
* **`records.mine` 在 `HEAVY_TYPES` 里**（`server/net.js`，2/s 重填 + 6 突发，业主裁令）：它一次请求换**一整份
  战绩**，本来就不是廉价请求，与 `g.watch` / `g.publicFull` / `room.loadout` 同一档。
* 隐私：记座位、昵称、是否 AI、胜负、通过回合、统计、盟约层数、购卡明细、结算时刻。**不记** IP、不记会话
  token。

## 5. 改密：本版**不存在**

投稿 `b639e98e6efb` 带了一个 `POST /api/account/password`，由**站点级共享密钥 `SP_ADMIN_TOKEN`** 守卫。这个端点
**没有实现**，连为它服务的脚手架（`sameSecret` / `readJsonBody` / `adminToken` / `MIN_TOKEN_LENGTH`）都没有：

* 共享的管理员密钥**不是**玩家的口令。它还要被逐字抄进聊天机器人的配置面板，于是任何读得到那份配置的人就能改
  **任意账号**的口令；
* 更根本的是：`hello` 已经要求口令，而那个端点让「知道账号名 + 拿着管理员密钥」就能改密 —— 这会让「必须提供旧
  口令」这道唯一持有证明变成装饰。

忘记口令的处理方式是**维护者直接改账号库**（停服 → 删那一行 → 重启 → 该名字可以被重新注册）。将来要做代改，
另立**一次性重置票据**的设计（按账号签发、独立端点、独立存储，与 `SP_ADMIN_TOKEN` 无任何关系），并另开一刀。

## 6. 协议面

* `hello` 多了两个**可选**字段：`auth`（`'login'` / `'register'`）与 `password`（≤128 字符的**传输**上限；真正的
  门槛在 `accounts.js validPassword`）。两者都在 `$optional` 里 ⇒ 老客户端不发，解析通过。
* C2S 新增 `records.mine`（空消息），S2C 新增 `records.latest { record }`（只发给请求者）。
* **`PROTOCOL_VERSION` 不动**、**`MOD_API_VERSION` 不动**：新增字段可选、没有既有消息变形，与本刀的包契约无关。
* `server/net.js` 的 `HEAVY_TYPES` **只多了 `records.mine`**（业主裁令保持：它一次换一整份战绩，不是廉价请求 ⇒
  2/s 重填 + 6 突发）。
* **本刀不碰** `room.list` / `room.skins` / `user.activity` / `lastInputAt` / `ACTIVITY_TYPES` —— 那些属于第 3、4 刀
  （投稿的 `changes.patch` 是**累积**的，把它们一起带进来了）。

## 7. 运维

```ini
Environment=SP_ACCOUNTS=1
# 可选：把战绩放到别的卷 / 会备份的地方
# Environment=SP_RECORDS_FILE=/var/lib/sp/match-records.jsonl
```

文件默认落在 `SP_STATE_DIR`（缺省 `<仓库>/var`）下：`accounts.json` 与 `match-records.jsonl`。
启动时 `[accounts] enabled ...` 那行日志点名生效值与两个路径。**升级部署必须保留这两个文件**；重启后会重新装载。

**反向代理**：`/api/records/<CODE>` 与 `/api/records/account/<NAME>` 按 `socket.remoteAddress` 限流（1/s、突发
10）。挂在代理后面时，所有请求看起来都来自代理那一个地址、共享同一只桶 —— 要么在代理侧按真实客户端限流，
要么接受「全站共用 1/s」这个上限。**不要**靠可伪造的 `X-Forwarded-For` 来分桶（那等于没有限流）。
