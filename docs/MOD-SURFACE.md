# Mod 表面清单（pack-facing ABI）

这份文件回答一个问题：**一个工坊包（workshop pack）到底能依赖引擎的哪些东西？**

答案是**一张表**，不是一段散文：每一行是一格「表面」—— 一条 `pack.json` 声明、承载它的导出符号、实现它的引擎文件、
钉死它的测试、定义它的设计稿小节。表的机读版本是 [`shared/modSurface.js`](../shared/modSurface.js)，
守卫是 [`test/modSurface.test.js`](../test/modSurface.test.js)。

## 为什么需要它

引擎会被上游移植整段改写：`server/lobby.js`、`server/match/*`、`public/js/screens/*` 都可能在某一次移植里换掉。
中间层（工坊包这一整套契约）不能靠「没人会动它」活着 —— 一份没有被断言的契约，被一次重构顺手删掉时**没有任何
测试会红**，而作者看到的只是「装了但没反应」。

所以每一格表面都被钉住三件事：

1. **锚点符号还在**（`SERVER_MEMBERS` 里还有 `battle`、`CLIENT_PANEL_SLOTS` 还是那十个……）；
2. **实现文件与测试文件还在**；
3. **设计稿与本文档里那一节还在**。

反过来也钉：`shared/workshop.js` 里每一个「包可声明的名单」都必须被某一格表面引用 —— 于是「引擎里加了一格却没进
清单」同样会红。移植的人只要跑一次测试，就知道自己有没有把中间层落在后面。

本仓另有一份同族守卫：`test/modSurface.test.js` 的前半钉的是**就地补丁式**社区 mod 依赖的通用名（`data/backups.json`
的记录形状、`kits/shared/tier1.js` 的具名导出、`battle.refreshRange`）。那些 mod 不经过我们的校验器；工坊包经过，
但校验器只能保证「今天判得过」，保证不了「明天这一格还在」。

## 版本政策

- 这张表属于**一个 ABI 世代**：`shared/constants.js` 的 `MOD_API_VERSION`。包用 `pack.json.api` 声明它要的世代
  （`>=1 <2`、`1.x`、`^1.0.0` …），判定见 [mod-layer.md §28.5](design/mod-layer.md)。
- **加一格不抬世代**。加一格对已发布的包是纯增量；抬世代会让所有写了 `api: "1.x"` 的老包被判
  `MOD_API_INCOMPATIBLE` 而拒绝加载 —— 那是在惩罚老包。
- **删一格、改名、改语义必须抬世代**，并且必须给出迁移说明（哪一格被谁取代、老包怎么改）。冻结账本
  `MOD_SURFACE_FROZEN` 记着「每个世代必须仍然全部在场的 id」；在一个世代里悄悄拿掉一格，账本守卫就红。
- 结构性协商已经存在，且是**响的**：`pack.json` 的顶层键与 `server` 的成员都是闭集，一格这个引擎没有的表面
  不会被忽略，而是加载期**点名拒绝**（`PACK_UNKNOWN_FIELD` / `SERVER_UNKNOWN_FIELD`）。这份表补的是另一半：
  作者要知道**哪一版引擎**有这一格。

## 表面表

`层` 按 [DESIGN §28.1](design/mod-layer.md) 的三层：**A** 内容 / **B** 服务端逻辑 / **C** 客户端界面。
`requires` 是「用它还必须满足什么」—— 这一格不是白给的。

### A 层：内容

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `content` | `content[]` + `<文件>.json`（15 张表，`WORKSHOP_CONTENT_FILES`；第 15 张 `variants` 是 §28.51 的**口径数据通道**：只给**已有**记录写字段级补丁，不新增记录、不写新键、不发明轴） | 记录形状照抄官方；数据不是代码，改不了对局结果 | §28.13 |
| `traits.grantsBonds` | 一条 chess 记录的 `trait.grantsBonds = ["<bondId>", …]` | **特质 ⇒ 盟约成员资格 ⇒ count/tier**：`bondId` 必须是本机 `bonds.json` 里真有的（不存在的 id **点名**且永不进计数，但**不拒包**）；形状写歪一律点名（`TRAIT_GRANT_BAD_SHAPE` / `TRAIT_GRANT_EMPTY`）；**不写 ⇒ 逐字节不变**；判据只有一份（`shared/morph.js` 的 `grantedBondsByTrait`），合并也只有一份（`memberBonds`），三处读取点同源 | §28.49 |
| `overrides` | `overrides[] = "<文件>:<id>"` | 覆盖官方条目必须显式声明 | §28.3 |
| `units.operators` | `operators` / `support` + `units.json` | 干员记录必须带 `UNIT_REQUIRED_FIELDS` 那几个键 | §28.10 |
| `media.voices` | `voices` / `voiceLangs` + 包内音频 | 只服务登记过的 URL | §28.13 |
| `media.voices.cdn` | `voices` / `voiceLangs` 里的 `{ url, sha256, file }` 条目（作者自备 CDN） | **协议只认 `https:`**；`sha256` 是作者声明的内容摘要，取回来必须对上（对不上不落盘、不服务）；**绝不内置任何官方语音地址、也绝不新增下载路由**（主机名只来自 `pack.json`，字节由既有的 `/workshop-assets/` 送出）；不放宽 `VOICE_LANG_*`；失败逐条点名 + 那条台词从客户端语音表里摘掉（回落默认配音，而不是留一条永远 404 的静音）；声明了就必须写 `license` | §28.36 |
| `media.icons` | `bondIcons` / `itemIcons` / `art` | 路径是包内相对路径；素材不进 git | §28.13 |
| `skins` | `skins[] = { id, charId, name, series?, desc?, art?, voices? }` + 包内素材 | `art` 与 `art.chars` 同形（复用同一套解析器）；**哪一套生效**在一个注册了的外观提供者里（链按 `kind` 各问一次：`'portrait'` / `'avatar'`，于是立绘与头像**分开受控**；调用方点名版本——`_1`/`_2` 后缀、`isGolden`、`{ variant: 'elite' }`——时提供者不参与），且玩家可以用设置里的「工坊外观」整个关掉 —— 关掉时解析链与不装包逐字相同 | §28.28 |

| `notices` | `notices = { 栏目: 文本 }` | 纯文本，结构化但不执行 | §28.15 |
| `i18n` | `i18n = { 语言码: 包内 .json }` | 文件名必须是语言码 | §28.13 |

### B 层：服务端逻辑

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `server.preDispatch` | `server.preDispatch = { module, policy, intercepts }` | `intercepts` 必须是 `shared/protocol.js` C2S 里的类型名 | §28.13 |
| `server.meta` | `server.meta = { module, registers }` | `registers` 的每一类都要有对应键 | §28.13 |
| `server.modules` | `server.modules = { module, uses[], channels? }` | 只用 `SERVER_MODULE_USES` 里的钩子；源码过静态确定性扫描（**2026-10-11 起真的实现了**：`import()` 之前跑 `stripComments`+`mentionsIdentifier`，取 `SERVER_CODE_FORBIDDEN_GLOBALS` = `process`/`globalThis`/`require`/`eval`/`new Function` —— **`globalThis` 那一格 2026-10-13 回归**：它曾被拿掉，为保住那个拿 `globalThis` 与同进程测试通信的合法模块；那个用例现在改走**引擎显式注入**的 `host.io`（包声明 `write: true`，目录限定在 `<状态目录>/mod/<包id>/`），于是这一格没有留下的理由，而开着它时 `globalThis.process` 绕得过 `process` 那一格（读 env、`process.exit` 都走得通）。与 meta / battle / room 三处逐字同一句免责：这是**启发式，不是沙箱**）。`uses` 含 `matchClass`（⇒ 必须 `combat: true`）时，子类的 `handlePackMsg(playerId, msg)` 会在 `pack.msg` **限流之后、转发之前**被调到一次：返回 `true` / `{ consumed: true }` = 已消费（不再转发），其余返回值与抛错都按未消费继续转发。**`channels`（§28.23）= 这个模块在对局里的接收入口**：最多 8 条、与面板那半边共用一份名字形状（`PACK_CHANNEL_RE`）、每条还必须被本包某个面板的 `messages` 声明过（`MODULES_UNKNOWN_CHANNEL`，否则客户端根本发不出来），模块必须挂 `matchClass`（`MODULES_CHANNELS_NEED_MATCH`）；没声明就不长这个键（包身份逐字节不变）。**这一格已连投递一起落地**：`server/index.js` 从**裁后**的服务端模块推出「包 → 接收通道集合」（`workshop.serverChannels`），大厅 `packMsg` 只在**本包模块声明过这条通道**时才把消息投给对局 —— 只被面板声明、模块没声明的通道**投都不投**（转发口径一字未动，那是面板那半边 §1.9.6 的事）；声明了 `channels` 却没挂 `handlePackMsg` 的模块在装载期记一条**点名**日志但不拒包（方法可挂在实例上，静态看不出来）；没声明 `channels` 的包投递表里没有它这一行，行为与从前逐字节相同（`test/packMatchMsg.test.js` 钉住收窄） | §28.14 / §28.23 |
| `matchKinds` | `pack.json.matchKinds = [{ id, seats?: { min, max }, label? }]` | **第二种对局的声明面，不是分派表**：管理器不认玩法名，`host.matchKinds()` 只交出深度冻结的只读数据，判定住在包自己的 `matchClass` 包装器里。必须有接收人（本包至少一个模块挂 `matchClass`，否则 `MATCHKINDS_NEED_MATCH_CLASS` 点名拒，形状照 `MODULES_CHANNELS_NEED_MATCH`）；`combat: true` **不在这一格重复判** —— §28.14 的 `MODULES_NEED_COMBAT` 先拦，再写一遍就是永远不会命中的死格子（`test/modMatchKinds.test.mjs` 断言的正是「先命中的是那条」）。**只在写出来时**才进归一化清单（`identifyPack` 哈希的就是它 ⇒ 没声明的包摘要逐字节不变），且按 id 排序（书写顺序不同的两份清单必须是同一份字节 —— 否则书写顺序就能改摘要）。有界：每包 ≤4 种、座位 1..12、`label` ≤60 且是**作者可见**文本（不经 `t()` ⇒ 不占 i18n）。⚠ `MatchClass` 是**进程级一次**包装（`server/index.js` 换类一次，之后所有房间同一份）⇒ 包装器只能在自己的构造里判「这一局是不是我的」，命中才换、否则必须原样把 Base 交回；房间侧读得到的信号只有 `opts.mods.packs[].id`（口径轴 `variants` 在 `server/lobby.js` 的 `resolveRoomModSet` 重建条目时被剪掉）。不新增 `C2S`、不动协议号：输入走 `pack.msg`，下行复用 `m.public` 的自定义顶层键，结局仍按 `m.result` + `onEnd(summary)`（`summary.players` 非空才写战绩） | §28.54 |
| `server.transport` | `server.transport = { deflate, threshold?, level?, memLevel?, concurrencyLimit?, … }` | **只是声明**，包永远不能注入代码改 `wss`；`deflate` 必填、其余是闭集 + 上下界；进程级，多包声明时包 id 小的赢、其余点名；`welcome.transport` 报的是**生效值**而不是声明值 | §28.33 |
| `server.modules.metrics` | `server.modules[].uses` 含 `"metrics"` ⇒ `host.metrics()` | **是值不是句柄**（深冻结标量快照，没有 `process`/直方图/定时器/函数）；惰性启用；样本过期 ⇒ `loopP*` 全 `null` + `state: "stale"` + 点名一次。`onBoot` 收到深冻结只读配置快照 `{ port, host, stateDir, env }`，`env` 只带 `BOOT_CONFIG_ENV_KEYS` 白名单 —— 包只能观察不能设值，也不能声明启动变量 | §28.34 |
| `server.modules.route` | `server.modules[].uses` 含 `"route"` ⇒ `host.route(path, fn, { cache? }?)` | 路径必须在 `/mod/<包id>/…` 里并再判一遍核心保留路径表；只有 GET/HEAD；缓存只有 `no-store`/`no-cache`；回调必须**同步**返回 JSON 可序列化的值（`Promise` 点名拒并回 500）；体积 ≤ 64 KB；**没有认证**（与引擎其余 HTTP 面一致 ⇒ 不是私有通道） | §28.35 |
| `server.modules.lane` | `server.modules[].uses` 含 `"lane"` + `lane = { path, summary? }` ⇒ `host.lane(onUpgrade)` | **包自带一条 WebSocket 通道，但通道由宿主开**：包仍然拿不到监听套接字/端口/定时器/子进程，`onUpgrade(req,socket,head,ctx)` 与 §28.44 的表行逐字相同（多给 `ctx.lane`）。路径**按声明同步认领**、处理器 import 完才挂（宿主在 `server/index.js:432` 就快照那张表）；没挂上就升级 ⇒ 503 点名，认领失败 ⇒ **整包装载期被拒**并点名（`LANE_BAD_PATH`/`LANE_RESERVED`/`LANE_TAKEN`/`LANE_DUPLICATE_MODULE`/`LANE_LIMIT`）。语法判据只有一份（`server/http/wsLanes.js`），形状层只管命名空间（`/mod-ws/<本包id>` 之下，`MODULES_LANE_BAD_NAMESPACE`）；限额是宿主的表预算 ⇒ 闭字段只有 `{path, summary?}`。入口 `server/modServer.js`，**不改 `server/index.js`**（本体路径红线）。`MOD_API_VERSION` 不动（加一格成员是纯加法，老包的 `uses` 逐字节不变） | §28.56 |
| `server.room.hold` | `server.room = { module, hold: true }` ⇒ `room.canHold(fn)` | **空席房间的回收裁决**（§28.57）：包申请「真人全退了但这一局先别作废」的那一票。它是 §28.20 那句「房间钩子不是 combat 闸门」的唯一例外 —— 能决定一局会不会被回收就是能改对局结果，故 `ROOM_HOLD_NEEDS_COMBAT` 要求 `combat: true`；没声明就调 `canHold` ⇒ `ROOM_HOLD_UNDECLARED` 点名（不静默收下）。**包决定留不留、宿主决定留多久**：`ROOM_HOLD_MAX_MS` = 15 分钟硬夹时限（**具名常量**），多包 OR、时限取最早那一票，到点重新判；谓词抛异常 ⇒ 这一票作废 + `ROOM_HOOK_THREW`。裁决表按房间码存并随 `disposeRoom` 收回（房间码会被复用）。`hold` 只在写出来时进归一化清单 ⇒ 没用的包摘要逐字节不变。⚠ 挂载点住在 `server/lobby.js`，改法是最小替换（两处 `disposeRoom(room,'empty')` ⇒ `reapEmptyRoom(room)`，没人申请时**就是**原来那一行）；不新增 `C2S`、不动协议号、不进模拟 | §28.57 |
| `server.battle` | `server.battle = { module }` | `combat: true`；两端跑同一段字节；只能 import `@battle/` 与 `@sim/` | §28.17 |
| `server.room` | `server.room = { module }` | **不**要 `combat: true`：只读观察面（快照/访问器/订阅），返回值被忽略 ⇒ 改不了谁在玩、装了什么、这一局的结果；import 只走 `@sim/` | §28.20 |
| `kits.relativeImports` | `kits/<id>.js` 里的 `./…`（含 `kits/_shared.js` 这类辅助文件） | 只许**向下**相对（`..`/绝对/`%`/反斜杠/非 `.js` 仍拒）；按「出现 import 的那个文件」自己的目录解析，两端同一文件；辅助文件字节进身份哈希（`kits/**/*.js` 递归） | §28.18 |
| `routes` | `routes = [{ path, cache }]` | 路径与缓存策略都在允许集合内 | §28.13 |
| `assets` | `assets = { container, manifest, serverPolicy?, verify?, mirrors? }`；`mirrors[] = { id, base, sha256 }` | 装载期核对摘要；`server: serve \| cache-only`；`mirrors` **只镜像本包自己的容器**：`base` 必须绝对 `https://`（有主机、无凭据、无查询、尾斜杠）、id 唯一且 ≤ 4 条、`sha256` 必须等于装载期从包内文件算出的容器摘要（对不上的那条**停用并点名**，不拒包）；声明 `mirrors` 必须写 `license`（`ASSETS_MIRROR_NEEDS_LICENSE`：素材的再分发者是作者，授权问题不因为换了一台主机就消失，与 §28.36 的 `VOICE_CDN_NEEDS_LICENSE` 同一条理由）；**服务端不为这一格发一次网络请求**（取字节的是客户端） | §28.13 / §28.40 |
| `behaviour` | `behaviour = [{ switch, option?, name?, desc? }]` | **闭枚举**：开关名与选项名都只许取 `BEHAVIOUR_SWITCHES` 里有的（`BEHAVIOUR_UNKNOWN_SWITCH` / `BEHAVIOUR_UNKNOWN_OPTION`，整包拒，不是忽略）；**包里没有数值、也没有路径** —— 动作（`{ kind, value }`）由引擎构造，`module` / `entry` / `file` / `path` / `value` / `key` 这类键在形状层**点名拒**（这一格永远不是一条数值 / 文件覆盖通道，那就是安装器）；必须 `combat: true`（`BEHAVIOUR_NEEDS_COMBAT`）；**不是贡献项**（只带它的包照旧 `EMPTY_PACK`）；不声明 ⇒ 归一化清单里不长这个键，而声明了**必须**进包身份哈希、**不进** `modDigest`（只哈希 `[id, hash]`）；**第 8 刀起表里有实现好的格**（加一格必须已有实现点、一个测试文件与一节文档） | §28.43 |
| `behaviour: shopBias` | `shopBias: official \| bondBias` | **缺省 `official` = 引擎今天的行为**（逐字节不变，不需要 `golden:update`）；`bondBias` 把商店装备槽的候选集缩到本玩家**已激活**盟约的装备（`giveBondId` 落在那些盟约里），**只偏置、不授予**；抽到的**阶级**仍由棋子份额决定，某一级无命中就**回落官方那一份**（偏向不会把商店抽空），库存闸门（`canGain`）一步不跳过。原件 `_doc` 另提的两条（核心盟约优先、骑士戒律接入）与其 `items.json` 的 `giveBondBiasOnly` **未实现、也未读取**（源件不在手上） | §28.43.1 |
| `behaviour: prepLoadout` | `prepLoadout: locked \| prep` | **缺省 `locked` = 引擎今天的行为**（`room.loadout` 只在 `INFO_CHECK` 收）；`prep` 让休整期（`PREP`，且这个座位还没准备）也收一次既有的 `room.loadout { entries, ops? }`，**不新增协议消息**；`PREP` 那一次**合并**（只覆盖写了的干员，没写的保留当前配发），`INFO_CHECK` 那一半照旧不看 `ready`；**客户端半（§28.43.3）**：`screens/loadout.js` 那两处写死的相位判据（「本局已锁定」那句与 `shouldAutoClose`）改成读 `loadoutSync.currentLoadoutLockPhases()`（档位由 `roomMods.js` 从 `welcome.mods` 合成、与另外三格同一处），缺省与从前**逐字等价**；**编辑不需要新发送点**（`loadoutSync` 早在发既有的 `room.loadout`）；⚠️ **`PREP` 里的入口还没做**（§28.43.4 记账） | §28.43.1 / §28.43.3 |
| `behaviour: morphPairing` | `morphPairing: official \| plus` | **缺省 `official` = 引擎今天的行为**（少于两件装备不配对，配上了就每一件 `giveBondId` 都授予）；`plus` = 一件起配、只取装备行**最左边**那一件。**判据只有一份**（`shared/morph.js` 的 `grantedBondsByMorph`），三处读取点同判：prep 的 `pieceBonds`、战斗的 `unitBonds`（档位经 `withMorphPairing` 作用域）、客户端的 `grantedBonds`（档位经 `roomMods.js` 从 `welcome.mods` 合成）。**第 7 段补上槽位那半条**：`plus` 下变形同构体**不占装备位**、每名干员**最多一件**、第三件真装备**永远顶掉真正占格的那一件**；判据是同一份 `shared/morph.js` 的 `morphSlotPolicy`（`OFFICIAL_SLOT_POLICY` / `PLUS_SLOT_POLICY`），六处读取点同判（`player/items.js` · `player/acquire.js` · `bot.js` · `invariants.js` · `ui/detailPanel.js` · `ui/gameLogic/placement.js`）。缺省档返回的是**共享冻结单例** ⇒ 缺省逐字节不变、不需要 `golden:update`；`equipPerChess` 本身一字未动 | §28.43.1 |
| ↳ 冻结锚点（本文档与 `shared/modSurface.js` 的 `behaviour` 那一格**必须一致**） | `MORPH_PAIRING_OPTIONS` · `grantedBondsByMorph` · **`morphSlotPolicy` · `matchSlotPolicy` · `OFFICIAL_SLOT_POLICY` · `PLUS_SLOT_POLICY` · `equipSlotsUsed`**（后五个是第 7 段的槽位半条；`getItem` 解析器的契约是**收 id**） | 改这七个名字里任何一个 = 打断所有声明这一格的包（`test/modSurface.test.js` 的锚点守卫会红） | §28.43.1 |
| `behaviour: unequip` | `unequip: official \| allow` | **缺省 `official` = 引擎今天的行为**（逐字节不变，不需要 `golden:update`：缺省回的就是 `destroy` 今天那句 `'equipped items are locked'`）；`allow` 让**新意图** `g.unequip { itemUid }`（本层第一格「开关 + 新意图」，`PROTOCOL_VERSION` 不动、不新增 S2C）把一件已装备的装备退回手牌（右→左优先），手牌满则进临时整备区，两者都满 ⇒ **原子拒绝**（`HAND_FULL`）且装备留在原处；客户端**缺省一个按钮都不画**。装备只是从装备位移到手牌 / 临时（同一 `piece` / `uid`）⇒ 池 `held` / `cap` / `left` 全不变。**不发内容钩子**（`HOOKS` 是 `META` 契约面，今天是刻意的决定） | §28.43.2 |
| `behaviour: diyPoolOverlap` | `diyPoolOverlap: report \| strip` | **缺省 `report` = 引擎今天的行为**（不声明 / 选缺省 ⇒ 池子一个字节不动，不需要 `golden:update`）：`stripPackOperators` 逐条点名本包做成棋子的干员、**不摘任何人**（他能被上两次、自选槽绕过棋子自己的盟约）；`strip` 把**本包自己**做成棋子的那几名干员从 `diy.ownedPool` 这一份名单里摘掉（`diy.operators` 那条记录**留着** —— 池子之外 UI 还按 id 读它），池子少几个干员、golden 语料随动。⚠️ **全表第一格「按包读取」的开关**：读取点（`stripPackOperators`）逐个包读**它自己**的 `pack.behaviour`，**刻意不走** `mergeBehaviourDecls` —— 照其余四格那样先合并成一个值，会让「A 包声明 `strip`」连 **B 包**的重叠一起摘掉，而 B 从没声明过这件事（判据仍是同一份 `behaviourValue`、闭枚举仍是这一张表；后人若在这里「顺手补上 merge」，那是改错）。逐格叙述见 `docs/WORKSHOP.md` §1.23 | §28.43 |
| `target` | `target = "forge" \| "stardust"`（缺省 `forge`） | **闭枚举**：只许取 `PACK_TARGETS` 里有的（`PACK_TARGET_UNKNOWN`，整包拒）；缺省 `forge`，不写 ⇒ 归一化清单里**不长这个键**（老包身份哈希逐字节不变），显式写就是一条声明、**进**包身份哈希；`stardust` 是给 Stardust 宿主的**声明型包**：本引擎认识、**不装载**（`server/workshop.js` 的 `foreign`，启动日志一行具名）、不进数据叠加层、不进 `/mods/catalog.json`，也不受 `EMPTY_PACK` 约束；`stardust` 目标额外放行 `STARDUST_TARGET_FIELDS`（`type` 必须是 `"mod"`；`capabilities` 是能力 id 列表）与**声明过的能力自己认领的字段**（`STARDUST_CAPABILITY_FIELDS`），`forge` 一个都不放行 | §28.46 |
| `dependencies` | `dependencies = [{ id, range? }]` | `id` 是**另一个工坊包**的 id（`PACK_ID_RE` 同一套字符集；`DEPENDENCIES_BAD_ID` 整包拒 —— 绝不留到装载期去拼路径）；`range` 是那个包 `version` 的区间（`shared/packs.js` 的同一套语法，缺省 = 任意版本；`DEPENDENCIES_BAD_RANGE`）；逐字重复去重并按 `(id, range)` 排序，同一个 id 配两个 range ⇒ `DEPENDENCIES_CONFLICTING_RANGES`（不许猜作者的意思）；**语义在装载期裁决**（`adjudicatePackGraph`）：缺失依赖 / 版本不合 / 级联 / 循环 ⇒ **依赖方被拒**，全部具名成一行启动日志；**不是贡献项**（只声明依赖的包照旧 `EMPTY_PACK`）；不声明 ⇒ 归一化清单里不长这个键（§28.2） | §28.48 |
| `conflicts` | `conflicts = [{ id, range? }]` | 与 `dependencies` 共用同一个形状解析器与同一个装载期裁决（错误码换 `CONFLICTS_` 前缀）；差别只在方向：互斥时 **包 id 大的那个被拒**（与既有裁决「同 id 抢占按包 id 排序」同一条确定性来源），双方都声明时同一条边只裁决一次；带 `range` 时只有**区间匹配**才互斥；**不是贡献项**；不声明 ⇒ 归一化清单里不长这个键 | §28.48 |
| `enabled` | `pack.json.enabled = true \| false` | **装好 ≠ 生效**：`false` 的包在装载期被跳过（`ENABLED_FALSE` 进 `loadWorkshop` 的 `errors`，**响亮**，不是静默消失），字节一个不动；**只有布尔** —— `"false"` / `0` / `null` 一律 `ENABLED_BAD_SHAPE` 整包拒（被 JS 真值表放行的假布尔是静默失效）；**缺省 = 引擎今天的行为**，`"enabled": true` 与没写在**数据上不可区分**（只有 `false` 进归一化清单，否则所有已发布包的 `identifyPack` 摘要漂移）；**不是贡献项**（只带 `true` 的包照旧 `EMPTY_PACK`）；**不是热更新** —— 装载期读一次，改它要重启（`DESIGN §28.4` 的「No hot reload」不受影响）；**不投影** `welcome.mods[]`（没进 `packs` 的包对房间不存在） | §28.50 |

### C 层：客户端界面

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `client.panels` | `client.panels[] = { id, slot, module, order, gate }` | `slot` 必须是引擎渲染得出的宿主；用不了就点名丢掉整个面板 | §28.8 |
| `client.screens` | `client.screens[] = { id, route, module, order?, styles?, data?, messages? }` | 整屏替换。**route 是闭枚举且只有引擎真的有的四条**（`title`/`lobby`/`room`/`game`）——`selectRoute`（`public/js/store.js`）与 `main.js` 的 `SCREENS` 都只到这四个值，结算与干员调配是路由**内部**的视图，多写一条就是永远不会命中的死格子；两份名单（形状层 `CLIENT_SCREEN_ROUTES` / 客户端 `MOD_SCREEN_ROUTES`）由 `test/modClientScreens.test.mjs` 钉成同一份。字段判据与面板**共用**：`module`/`styles` 同一条装载期文件判据、`data`/`messages` 同一批闭枚举、`id` 共用一个包内命名空间（`CLIENT_SCREEN_DUPLICATE_ID`）、一个包一条路由只许一份（`CLIENT_SCREEN_DUPLICATE_ROUTE`）。屏模块与样式表源码字节**进身份摘要**，没声明的包摘要逐字节不变。运行时失败方向是**宿主原生界面保持可见**（样式失败 / import 失败 / 没导出 `mountScreen` / 挂载抛错四种都点名并拉黑该 key），卸载对称，路由所有权按 `order / pack / id` 确定性裁决。**没有写死像素、也没有桌面视口假设**：路由是语义名闭枚举，全屏宿主用 `inset: 0` 贴合视口、背景取 `var(--screen-background, …)`。⚠ 来源分支里 `enter(rawName)` 那行原本把控制码写成 caret 记法的字面文本（`^@-^_`），字符类成了反向区间、整个模块 `node --check` 都过不去 —— 合并时按意图改成 `[\u0000-\u001f\u007f-\u009f]`；同文件的 `isPanelId` 也有同一处 caret 记法，**未吸收**（保留我方正确的 `[\s\u0000-\u001f]`） | §28.55 |
| `client.panels.me` | 无需声明：`ctx.me` 引擎总是给 | 只读会话态 `playerId` / `name` / `room` 快照 + `snapshot()`；每次读取当前值；**不含** store / match / runner / audio，也不含 `search` | §28.8 |
| `client.panels.wraps` | `client.panels[].wraps[] = { component, mode }` | `component` 必须在引擎注册表里，`mode` 是 `wrap` \| `replace`；`wrap` 每帧拿一次 vnode，`replace` 的 `orig` 是 `null`；注入面只多 `component` 与 `props`（只读深拷贝）；任一环坏了退回**它下面那一份**并点名 | §28.19 |
| `client.panels.styles` | `client.panels[].styles[]` | 只服务登记过的 URL；挂载时注入、dispose 时移除 | §28.8 |
| `client.theme` | `client.theme.vars = { --x: 值 }` | 变量名 `--` 开头；值里不许有 `; { } < >` 换行 | §28.8 |
| `client.panels.data` | `client.panels[].data[]` | 表必须在 `CLIENT_PANEL_DATA_TABLES` 里；拿到的是只读快照 | §28.8 |
| `client.panels.messages` | `client.panels[].messages[]` | 类型名由引擎定（`pack.msg`），通道名由包定；有额度与限流 | §28.8 |
| `client.requires` | `client.requires[]` | 缺一即「浏览器不支持」，不是静默不工作 | §28.13 |
| `client.sources` | 无需声明：面板模块导出 `sources(ctx)`；地址只在 `pack.json.assets.mirrors[]` | **结构上不可能引入主机名**：只许回已声明 id 的排列/子集（喂主机名 / URL ⇒ `CLIENT_SOURCES_BAD_ORDER`，整条顺序作废）；进程内最多一个提供者（`CLIENT_SOURCES_TAKEN`）；只导出 `sources` 不 `mount` 不是错；导入次序硬性 —— 先核整包 sha256（必须 `checked && ok`）⇒ 再走既有逐文件 SHA-1[0:12]，任何一步不过就换下一条，全败则回落包内 `/workshop-resources/…` 并**点名**；设置里「工坊素材源」关掉 ⇒ 一次都不问镜像（一键回退） | §28.40 |
| `forms` | `forms = { chars\|enemies\|tokens: { "<spine id>": { "<形态名>": { change?, end?, leave?, next?, roles } } } }` | **第一方 `FORMS` 优先**：与第一方同名的形态在形状层就被 `FORMS_FIRST_PARTY_OVERLAP` 拒掉（宁可拒绝，不要静默丢掉）；`roles` 的键 ∈ `FORM_ROLE_KEYS`、clip 名是非空字符串（或 `{ begin, loop, end }`）；`next` 必须指向同一个 spine id 上已声明的形态，否则 `FORMS_NEXT_UNKNOWN`；两个包撞同一个 `spine id + 形态名` 时包 id 小的赢（`FORM_COLLISION`） | §28.29 |
| `fx.silentPhases` | `fx = { silentPhases: ["<phase kind>", …] }` | **并集**：第一方那两个（`bombed` / `warning`）永远静默，包只能加、取消不了；每一项必须是非空字符串（`FX_BAD_SILENT_PHASE`），未知字段点名拒绝（`FX_UNKNOWN_FIELD`）；落点 `assets.silentPhases`，`fxSpec` 在每个特效上同步查它 | §28.29 |

### 发行

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `callBudget` | `pack.json.callBudget = { max? }` | **每局每插件**的调用次数上限（沙箱档的运行时保护，缺省 8000，**只许收紧不许放宽** —— `CALL_BUDGET_TOO_HIGH`）；**不是闸门**（那是 `combat`），也不要求 `combat: true`（它只收紧、不授权）；**必须进内容摘要**、**不声明就不长键**、**不是贡献项**；计数与回滚**只有一份实现**（`server/sim/battle/hooks.js` 两端同一段字节），预算路径里**不许有端特有分支**；`kits/*.js` 的逐单位回调**也归账**（注册点在 `battle/players.js` 的 `_safe(…, pack)`，归属按对象身份记）；判决在**装载期一次**（`server/battlePack.js` 与 `server/workshop.js loadWorkshopKits` 读同一个 `effectivePackCallBudget`，只带 `kits/` 的包也建账；浏览器从同一份模块清单读同一个数字），**不进建房路径** | §28.52 |
| `mods.catalog` | 客户端 mod 目录 + 房间 `modIds` | 房间声明了集合时只有点名的包参与（W-B）；两端字节要能对齐（W-D） | §28.16 |

## 加一格表面的清单

1. `shared/workshop.js`：形状校验 + 拒绝码（点名，不静默跳过）+ 进身份哈希（能改变一端行为的字节必须进摘要）。
2. `shared/modSurface.js`：加一行，锚点写**真实导出符号**。
3. 实现文件：两端一致的那一端也要写（包声明的代码要能同时在服务端与浏览器成立）。
4. 测试：一个钉行为的测试文件，在那一行里点名。
5. `docs/design/mod-layer.md` 加一节；本文档的表加一行。
6. 跑 `node --test test/modSurface.test.js`。

## 上游更新时

原项目发新版时照 [`UPSTREAM-UPGRADE.md`](UPSTREAM-UPGRADE.md) 走一遍：它会点名所有会被上游改动打断的地方
（白名单别名 / 具名组件枚举 / 宿主槽位 / 本文档这张表），并说清**什么时候才抬 `MOD_API_VERSION`**。
一句话：**上游挪文件只改别名一行，包不动、已装的 mod 不重置**；只有契约语义真的变了才抬版本，
那时候老包会**响亮地被拒**（这是我们要的，不能悄悄跑错）。

## 刻意**不是**表面的东西

写在这里，是因为「不做什么」同样是这一层的设计：

- **协议类型**：包不能发明 `S2C`/`C2S` 类型。包自己的通道走 `pack.msg`，类型名由引擎定。
- **就地改动引擎文件**：`shared/protocol.js`、`shared/constants.js`、`server/lobby.js` 这类补丁式分发产物不是表面，
  是**发行工件**（社区 mod 的 `*.patch`）。要它们的**效果**，就得先在设计稿里把它变成一格表面。
- **产品功能**：野排匹配（快速匹配）、房间保留、**房内聊天与快捷短语**（docs/META.md §1.6–§1.8）都是**产品功能**，
  与 mod 层无关 —— 它们由引擎自己实现，不开放给包，也不要求任何 `pack.json` 声明。一个包要用自己的消息，走
  `client.panels[].messages` + `pack.msg`；它**不能**发明线上类型（`room.chat` / `room.quickMsg` 是引擎的）。
- **改对局结果而不声明 `combat: true`**：`server.battle` 与任何能改结果的注入都硬闸门。成绩必须可复算，
  否则「按房间选集合」与「两端对齐」都失去意义。
- **文件系统与网络**：包内的服务端代码拿不到 `fs`、`path`、`process`、`require`、`eval`。这是 §28.4 的边界，
  静态扫描与 import 白名单一起守。
