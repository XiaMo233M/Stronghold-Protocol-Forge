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
| **顶层** | 0.18.1-0.2.5 · 0.18.0-0.2.5 · 0.17.0-0.2.4 · 0.16.0-0.2.4 · 0.15.3-0.2.4 · 0.15.2-0.2.4 · 0.15.1-0.2.4 · 0.15.0-0.2.4 | 2026-10-11 – 2026-10-13 | 本文 |
| 0.14 | 0.14.0-0.2.4 · 0.14.0 | 2026-10-10 – 2026-10-11 | [docs/changelog/0.14.md](docs/changelog/0.14.md) |
| 0.13 | 0.13.1 · 0.13.0 | 2026-10-10 | [docs/changelog/0.13.md](docs/changelog/0.13.md) |
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
## 0.18.1-0.2.5 — 2026-10-13

**`v0.18.0-0.2.5` 的补丁版：把那一版的资产里**没有**的三笔补齐** —— ① 池权重数据（洛洛八件加权池 + 焰尾
10/10/3）与落到上游 0.2.5 的 `test/match/pool.test.js`，外加六族 golden 里按新数据重算的 6 个 matches 场景；
② 三笔欠账（打包脚本的「工作区必须干净」守卫 · `docs/WORKSHOP.md` 的历史双编号收掉并补一条无重号守卫 ·
`docs/img/*.svg` 的陈旧与矛盾数字）；③ 两个仓库的 README 与 mods 仓库的 `SKILL.md` / `AGENTS.md` / `UPLOAD.md`
按实况更新。上游游戏本体仍是 **0.2.5**，发行 tag 是 `v0.18.1-0.2.5`。**

### 池权重数据补齐（上游 0.2.5 的 PR #497）

- **`tools/build-data.mjs` 与上游 0.2.5 逐字节一致**：`pool_equip_rockr` 由「4 件均匀」改为路标月报 #2 实测的
  8 件加权（维式重锤 10 / 战栗维式重锤 2 / 坚固维式重锤 2 / 加速维式重锤 2 / 灼燃维式重锤 2 / 有限加速器 1 /
  护盾无人机 4 / 激光发射器 4），`pool_char_pinus` 由 `45/45/10` 改为 `10/10/3`，共 4 行。
- **`data/choices.json`** 由 `node tools/build-data.mjs --offline` 重跑生成（未手改产物）：16 个池里**只有这 2 个变**。
- **`test/match/pool.test.js` 落上游 0.2.5 的版本**：单跑 **11 条真绿**（不是跳过），逐个字段真跑加权与去重路径。
- **六族 golden 里只有 `matches` 变、恰好 6 个场景移动**（`coop2-NORMAL-1-coverage-standins` · `coop2-NORMAL-3` ·
  `coop2-NORMAL-8-serverrun` · `coop3-ABYSS-5` · `coop4-ABYSS-7` · `coop4-FUNNY-6`）：**没有用 `golden:update`** ——
  在仓库外按 `goldenDocument` / `stringifyGolden` 生成六份、校验定义集与移动集合后才拷回；场景 id、`about` / `fast`
  逐字不变，UNEXPECTED 0 / PENDING 0。其余五族**逐字节未动**。

### 三笔欠账

- **打包脚本加「工作区必须干净」守卫**：`scripts/make-windows-bundle.mjs` 与 `scripts/make-update-package.mjs` 共用
  同一份实现 —— 清单来自 `git ls-files`、内容来自磁盘，工作区脏就会打出与 tag 对不上的包，所以有未提交改动就
  直接拒绝；`--allow-dirty` 是显式放行并打印风险。配套 `test/windows-bundle.test.js` 两条判据（纯函数 + 真跑一次脚本），
  `docs/DEPLOY.md` 与 `docs/WINDOWS.md` 两处说明同步。
- **`docs/WORKSHOP.md` 的历史双编号收掉**：目标引擎（`target`）那一节由 **§1.23** 改号为 **§1.26**（§1.23 归「逐格加开关」，
  CHANGELOG 与 `docs/design/mod-layer.md` 两处引文指的正是它），§1.24 里指 `FOREIGN` 的那处编号跟着改；顺带把
  两处闭集数字按实测改准（顶层键 34 → **35**，与 `PACK_FIELDS` 实测一致）。新增守卫断言「`docs/WORKSHOP.md` 无重号
  编号标题」—— 判据钉在**号**上而不是整行标题上，因为重号的两节标题文字必然不同（按整行判一条都抓不到）。
- **`docs/img/*.svg` 的 5 处陈旧 / 矛盾修正**：`cap-01-layers.svg` 的「上游 0.2.4」改为 0.2.5、「behaviour（表空）」
  改成实况的 4 格、补 `target` 与依赖 / 互斥（原来图与 README 正文直接矛盾）、「mod 仓库（25 条）」改为**条数以
  `mods/index.json` 为准**（实测 30 条）；`cap-02-pack-lifecycle.svg` 的「顶层键 32」改为**实测 35**；
  `cap-03-submission-pipeline.svg` 的「今天 3 个包」改为**实测 8**（`packs/` 目录）。三份 SVG 均过 XML 语法校验。

### 两份 README 与 mods 仓库

- **引擎仓库 `README.md`**：「Forge 现在能干什么」补四行已合入的面（特质授予盟约 §28.49 / 宿主 lane §28.44·45 /
  `target` §28.46 / 依赖与互斥 §28.48）与登记册一行（§28.47，注明编辑器未接）；「还不能做什么」把编辑器未接登记册、
  `server.modules[].channels` 不存在、没有热重载三条写明白；能力图与能力总表按实况对齐；英文节同步。
- **mods 仓库 `README.md` / `SKILL.md` / `AGENTS.md` / `UPLOAD.md`**：`trait.grantsBonds` 由「在途 / 未合入」改为
  **已可用**（§19.7，三个读取点都调同一份判据），并留下「上一版写在这里的 `trait.grantsBonds` 已经落地」的对照。

### 门槛（发布前全绿）

`node --test --test-concurrency=4` **8642 条 / 8636 通过 / 0 失败 / 6 跳过**（263.5 s，两轮一致；跳过全是 Chromium / 素材门控）·
`npm run golden` exit 0（六份语料 **49 / 46 / 22 / 20 / 10 / 140** 全部 match，只有 `matches` 的 6 个场景按上面的新数据
重算）· mod 闸门 `tools/check-packs.mjs --engine …` exit 0（`packs/` 8 个 + `demo/` 3 个全部装上）。

---
## 0.18.0-0.2.5 — 2026-10-13

**本版吃上游 0.2.5：规则面（浮游族的本体一击、受击格四舍六入五成双）、界面面（官方伤害数字默认关、盟约叠层音效）、
工具面（打包脚本、`/dev/sim-check`、场景提取）三条线一并并入；上游游戏本体升到 **0.2.5**，发行 tag 是
`v0.18.0-0.2.5`。**

### 规则（按官方，上游 0.2.5）

- **受击格改用官方四舍六入五成双**（PRTS 作战机制，PR #520）：`body.js` / `targeting.js` / `battle/queries.js` 的
  取整全走 `detmath.roundHalfEven`；被挡在场地边缘的敌人被 `FIELD_EDGE_INSET` 按在边线内侧那一格，不会因为边号是
  奇数而落到场外（`battle/spawns.js`）。
- **驭械术师的浮游改成本体一击 + 未释放浮游的附加伤害**（PR #537）：`funnelMul` 与本体倍率分离，附加实例带
  `addition, funnel` 标签并共享 `attackId`，一次天赋掷骰；`funnelBodyHits: 0` 是「只要浮游不要本体」；再部署与
  换目标立刻重置斜坡，自由移动保留（PR #536）；洛洛 S2 在目标离开攻击范围后继续锁定（PR #535）。
- **只改普攻的技能保留干员自己那一击**；要塞职业自身格也满足基础开技条件。
- **联防阿戈尔开场不再二次结算吞噬**：HP/SP 恢复推迟到全部开场效果之后，保留精确比例与小数生命。
- 自在重生后的无敌期不再被普攻或需要可选目标的自动技能锁定（#510）；谢拉格不融冰、催泪瓦斯改「造成伤害时」判定，
  含持续伤害（#489）。
- 首领配对改为**每局随机**、准备期至开战固定，隐藏首领沿用同局分组。

### 对局与经济（上游 0.2.5）

- 固定赠品不再被共享库存阻断（#488/#491/#495）；已展示的干员商店牌与奖励牌不再因随后库存耗尽而领取失败（#498）。
- 调度中心 4 级的五阶晋升奖励可以出现五阶自选（#515），自选来源是 `diyStockEntries`（本作把上游那一处与我方
  100 座变体的主池分派点 `mainPool()` 合成在一条语句上）。
- Touch 外勤医疗按本局团队权益保留：持有者淘汰或退出后不再使下一场医疗消失。
- AI 选开局策略与构筑重心时软性让开仍在场队友已经选择的阵营（#514）。

### 界面（上游 0.2.5）

- 设置新增「官方伤害数字」（默认关闭，#412）：只按 PRTS 红字规则显示红色整数，以及本该出红字却被闪避的 MISS；
  判定在 `server/sim/damage.js`，客户端只画。
- 补齐回合开始、机变、休整期和战斗中的盟约叠层提示音（#482）：`m.layer` 由服务端在**真实备战相位**发出，
  重连与结算回填不补播，同类最多一路。
- 标题画面页脚新增「项目仓库」链接；敌血条头顶高度、AI 托管遮罩、攻击后模型多挥一次（#506）等修正。

### 有意与官方不同的调整

- **萨卡兹枯朽战士 / 组长**：上游 0.2.5 把「沉默时死亡不留污染秽蚀」的理由改述成维护者的实机回忆，并写明它与
  PRTS / 游戏内文字「不可沉默」相反。**本作不采纳该改述，也不采纳它的断言** —— 理由仍是 0.2.0 起的客户端模板读法
  （battle prefab 的 `projectile_on_killed` 先查 `CheckAbnormalFlag SILENCED`），行为是**这两个键可被沉默、沉默状态
  下死亡不留污染秽蚀**（GitHub #470 拒）。钉子：`test/content/enemies_bosses.test.js` 的具名判据
  `#470 拒: …可被沉默…`，记录见 `server/sim/content/enemies/archetypes.js` 与 [history/0.2.5.md](docs/history/0.2.5.md) §32.32。
- 本作 `APP_VERSION` 保持 **`0.18.0`**（拒上游把 `APP_VERSION` 改成 `'0.2.5'`；本仓库的发行号自己的那一半），
  `UPSTREAM_VERSION` 由 `'0.2.4'` 抬到 `'0.2.5'`。

### 门槛（发布前全绿）

`node --test` **8638 条 / 8632 通过 / 0 失败 / 6 跳过**（三条支线整合后的实测；跳过全是 Chromium / 素材门控：批2 带进来的
`test/ui/bond-audio.e2e.test.js` 就是 `5 跳过` → `6 跳过` 的那一条） · `npm run golden` exit 0（六份语料 **49 / 46 / 22 / 20 / 10 / 140**
全部 match；本版重算 66 个场景，与上游两 tag 的差集逐条一致，见 §32.34）· `--twice`（第二遍倒序）identical ·
`GOLDEN_FULL=1` 9/9。

## 0.17.0-0.2.4 — 2026-10-12

**这一版把「给模组用的那些面」收成一套：`behaviour` 四格全部落地，宿主两条路径表、`pack.json.target`、mod 登记册、
跨包依赖裁决与 `trait.grantsBonds` 一并并入。** 上游游戏本体仍是 **0.2.4**，所以发行 tag 是
**`v0.17.0-0.2.4`**；`PROTOCOL_VERSION` 仍是 **2**、`MOD_API_VERSION` 仍是 **1**、`UPSTREAM_VERSION` 仍是
**`0.2.4`**。默认游戏行为**逐字节不变** ⇒ **不需要 `golden:update`**。

### `behaviour` 四格：开关表从空表变成四格（第 8 刀）

上一版（0.16.0）交的是**通道 + 守卫**本身，那一版**一个开关都没有**；这一版把四格补齐，并顺手把两处语义收进
同一份判据。

* **`shopBias`**（投稿 `b293e061b38f`）——商店装备槽**偏向已激活盟约的装备**。
* **`prepLoadout`**（投稿 `8b4e5da55c58`）——**休整期也能改技能与模组**（客户端那半也在这一版补上）。
* **`morphPairing`**（投稿 `19ea65909cf6`）——变形同构体的**配对规则**：三处读取点收成**一份判据**（原来是三处
  各写一遍，改一处漏两处）。第 7 段槽位语义在这一格落地：变形同构体**不占位**、**每名干员一件**、**第三件顶掉
  真占格的那两件**。
* **`unequip`**（投稿 `79de9ff03518`）——**装备拆卸**，也是本层第一条「开关 + 新意图」：加一个 `behaviour`
  开关会连带加一条 C2S 意图，同步点不止一处，`DESIGN §28.43.2` 把「加意图清单」写成显式全表。
* **两条门禁**把「文档说 `BEHAVIOUR_SWITCHES` 今天是一张空表」这句话与代码钉在一起 —— 那一句是**按时间叙述**，
  这一版之后它就该红，红在文档上而不是让人猜。

### 宿主 lane：两条路径表的移植（DESIGN §28.44 / §28.45）

- **§28.44 升级路径表**（PR #4）：宿主用**数据**注册 WebSocket 升级路径，同一条端口上跑第二套协议。
- **§28.45 请求路径表**（PR #5）：宿主用**数据**注册命名空间子树与方法（含 `POST`），模组自己的页面与自己的
  写入口不再靠改引擎。
- 两处「Numbering」段原先引用了本树**不存在**的 `§28.43.4`，验收补缺时一并修掉（引用指错行不会有人踩空，
  但会让人以为那一节不存在）。

### `pack.json.target`：一份清单两个宿主读得懂（DESIGN §28.46）

**`foreign` 三面接线**（移植 PR #3 收尾）：`target` 声明的是「这份包写给哪个宿主」，缺省 `forge`，`stardust`
是声明型 —— 三面（装载、登记、作者侧校验）都读同一个字段，所以**跨宿主误用不再静默通过**，而是被点名。

### mod registry 与跨包裁决（DESIGN §28.47 / §28.48）

- **§28.47 登记册**（移植 PR #3）：**装过什么 / 操作者启停过什么**落一份登记册，落点是 `SP_STATE_DIR`
  重定向的 `var/mod-registry.json`（并进 `.gitignore`：它是运行态，不是源码）。
- **§28.48 依赖 / 冲突**（移植 PR #3）：`pack.json.dependencies` / `conflicts` 在**装载期**裁决 —— 跨包的
  依赖装不上、或两个包互相冲突时，当场点名，而不是等某个玩家进游戏才发现功能少了一半。

### `trait.grantsBonds`：特质 ⇒ 盟约成员资格（DESIGN §28.49）

把「特质给出盟约成员资格」写成**数据**（纯数据叠加盟约层数），不再让每个包自己推一遍。这一刀另有 11 处
`shared/workshop.js` 引文修正：其中 1 处是本刀漂移、10 处是在**父提交上就已经指错**的旧账。

### 作者侧校验器读 `coreRouteShadow`（PR #6）

作者侧校验器原先**自己算**一遍路由遮蔽，于是「会被丢掉的 `routes` 声明」照样发 **VALID** —— 作者以为声明生效了，
游戏里没有。现在它读**服务器那一份** `coreRouteShadow`，同一份判据只有一处实现。

### 文档判据与若干修正

- 新增两条**文档判据**，把「按时间叙述」与「现在时断言」分开，避免把历史叙述误判成违规。
- `docs/prompts/kit.md` 一处 `server/sim/Battle.js:149` → `:150`、`:113` → `:114` 的引用位移重指；
  `docs/WORKSHOP.md` 加一条判据（走自选池的干员在 `data.chess` 里没有棋子是**正常形状**，别误报
  「永远进不了游戏」）；`docs/design/mod-layer.md` 修 8 处 `WORKSHOP.md` 引用；`docs/MOD-SURFACE.md`
  把 `morphPairing` 槽位半条的冻结锚点点名。
- 测试平台修复：浏览器套件截图落盘改用 `fileURLToPath`（Windows 上 `new URL(...).pathname` 会解成
  `E:\E:\…`，那是**测试工具**的错，不是产品的错）。
- `support/index.js` 补 3 行再导出，把引擎已有的 5 个原语交给工坊 kit（**只增导出**，不改既有行为）。

### 门槛（发布前全绿）

`node --test` **8367 条 / 8362 通过 / 0 失败 / 0 取消 / 5 跳过**（357.9 s）· 三件套
（`docs-consistency` / `docs-paths` / `promptCitations`）**39 / 39** · `npm run golden` exit 0
（六份语料 49 / 46 / 22 / 20 / 10 / 140 **全部 match**）· mod 闸门
（`tools/check-packs.mjs --engine .`）**exit 0**（`packs/` 8 包 + `demo/` 3 样板全部装上）·
`data/` 与 `test/golden/` **零改动**。

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
- **④（行为声明通道）**：第 4 刀落地时**那一格没有任何可用开关** —— `BEHAVIOUR_SWITCHES` 当初为空 ⇒ **任何**一条
  `behaviour` 声明都会被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒**。那是刻意的：**格子先立起来、开关逐个按需加**
  （首格与它的引擎实现点一起落）。**第 8 刀按这条落了前三格，见下。**

### 行为开关的第一批格（第 8 刀）

**投稿 `b293e061b38f`（「商店刷新盟约装备几率提升」）与 `8b4e5da55c58`（「休整期可更换技能和模组」）要的那两件事，
收成引擎里两格实现好的开关（DESIGN §28.43.1）。** 两份原件都把它们做成了**安装器**（`files.json` 的 `copy` 整份
覆盖 `data/items.json`、`server/match/**`、`shared/protocol.js` 与客户端文件）。本刀不采纳安装器：**引擎实现一格，
任何包声明它**（`docs/WORKSHOP.md` §1.22 / §1.23）。

* **`shopBias`**：`official`（缺省，今天的行为）· `bondBias`（装备槽只在本玩家**已激活**盟约对应的装备里抽，
  **只偏置、不授予**）。读取点 `bondBiasPreference`（`server/match/pool.js`）→ `bondBiasBonds`
  （`server/match/player/economy.js`）→ `PlayerEconomy._rollItemSlot`。**抽到的阶级仍由棋子份额决定**，某一级无命中
  就**回落官方那一份**（偏向不会把商店抽空），库存闸门一步不跳过。
* **未实现的两条 + 未读的两个字段（如实披露）**：原件的 `_doc` 还提到「已激活**核心**盟约优先于已激活附加盟约」
  与「骑士戒律也接入这套偏向」，其 `payload/data/items.json` 另带 `giveBondBiasOnly`（115 处）与一批
  `canGiveBond`（115 处）。那两条的源件不在我们手上 ⇒ **不做、也不在 `effect` 里声称做了**；这一格**只读
  `giveBondId`**，不读 `giveBondBiasOnly`（我们数据里连这个键都不存在）。`test/shopBias.test.js` 用源码级断言钉住。
* **缺省路径逐字节不变**：不声明 / 选缺省 ⇒ `restrict` 为 `null`，与从前同一份代码路径、同一份结果；
  `Match` 只多一行 `mergeBehaviourDecls`（与 `variants` 同一个投影点，**不新增协议消息**）。
  **不需要 `golden:update`**：没有任何一格在缺省时改变一局的结果。
* **`prepLoadout`**：`locked`（缺省，今天的行为）· `prep`（休整期里、且**这个座位还没准备**时，也收一次既有的
  `room.loadout { entries, ops? }`）。读取点 `LOADOUT_PHASES` / `loadoutPhasesFor`
  （`server/match/match/platform.js`）→ `MatchPlatform.setLoadout` 的相位闸门。**不新增协议消息**（投稿自己那个
  `g.loadout` 我们不需要：`room.loadout` 在比赛进行中本来就走到 `Match.setLoadout`）；`PREP` 那一次走
  `mergeLoadoutEntries`：**只覆盖这次写了的干员**，没写的保留当前配发（整份替换会把其余干员静默打回默认）。
  `INFO_CHECK` 那一半**不看** `ps.ready`（今天也不看）—— 两个相位是两条独立的门。缺省档读到的相位数组与从前
  逐字相同（只有 `INFO_CHECK`），**不需要 `golden:update`**。
* **测试**：新增 `test/shopBias.test.js`（9 条）+ `test/prepLoadout.test.js`（8 条：形状 / 两档 / 缺省与今天
  逐字相同 / `prep` 档的合并语义 / `ready` 后仍拒 / 别的相位照旧 `WRONG_PHASE` / 协议面一个字节不动）。
* **`morphPairing`**：`official`（缺省，今天的行为：少于两件装备不配对、配上了就每一件 `giveBondId` 都授予）·
  `plus`（投稿 `19ea65909cf6` 那一套：**一件起配**、只取装备行里**最左边**那一件）。**判据只有一份** ——
  `shared/morph.js` 的 `grantedBondsByMorph`：投稿原件是把**三处读取点各覆盖一份**
  （`bondsMeta.js` / `sim/content/support/index.js` / `public/js/ui/gameLogic/bonds.js`），三处各写一份循环正是
  这条规则最容易分叉的地方。本刀把那三处收成一个纯函数：prep 侧从 `GameData.morphPairing` 读（`Match` 建
  `GameData` 时传进去），战斗侧由 `withMorphPairing` 的作用域给（与 `withGameData` 同一条同步作用域纪律，
  `Battle` 构造期与每一步都压上），客户端由 `roomMods.js` 从 `welcome.mods` 合成后写入
  （`setMorphPairing`，合并规则直接调 `mergeBehaviourDecls`，不自己实现一遍）。BattleSpec 与
  `battleOptsFromMatch` 各带一个 `morphPairing` 键，**只在非缺省档才出现**。缺省档一个键都不多 ⇒ 逐字节不变。
* **`morphPairing` 的槽位语义（第 7 段补上的那半条）**：投稿还要求「不占装备位、每名干员只一件、第三件顶掉真占格
  那两件」—— 第三格落地时它被如实记成「未做」，这一段把它做完。判据是同一份 `shared/morph.js` 的
  **`morphSlotPolicy(decl)`**：`official`（缺省）⇒ **`OFFICIAL_SLOT_POLICY`**，一个**共享的冻结单例**，每个方法都
  逐字是引擎今天那条算术（`slotsUsed` = `items.length`、`slotCap` / `maxItems` = `equipPerChess`、`replacedIndex`
  的「`replaceUid` 找不到 ⇒ 0」）；`plus` ⇒ **`PLUS_SLOT_POLICY`**（不占位、每名干员最多一件、顶替只挑真正占格的
  那一件、一行最多 `equipPerChess + 1` 件）。六处读取点**同判**：服务端 `player/items.js`（`_attach` /
  `_takeReplaced` / `equip` 的两条守卫）· `player/acquire.js`（回收）· `bot.js`（选人与选装备）· `invariants.js`
  （不变量），客户端 `ui/detailPanel.js`（`EQUIP n/2` 分子与「不占装备格」标签）· `ui/gameLogic/placement.js`
  （`equipReplaces` 的替换判据，`roomMods.js` 把档位写进 `bonds.setMorphSlotPolicy`）。
  **缺省档逐字节不变**：没声明 / `official` / 不认识的档位返回的都是**那个单例本身**，缺省路径上「同一批数字、
  同一次比较、同一个 splice 下标」⇒ **不需要 `golden:update`**，已发布包一个字节不动。`gamedata.equipPerChess`
  本身**一字未动**（那两格装备位是官方的，策略只回答「这一行占了几格、能不能再放一件、顶替挑哪一件」）。
  `getItem` 的契约写在 `shared/morph.js`（收一件棋子或一个 id，回 items 记录）—— 第 7 段第一版在这里踩过一次真
  bug（`invariants.js` 写的是收棋子的形状、其余写的是收 id 的，判据只假设一种 ⇒ 不变量把变形同构体当成占位的普通
  装备），所以它由 `test/morphSlots.test.js` 的 `collectViolations` 断言回归。
* **测试**：新增 `test/morphSlots.test.js`（8 条行为级：缺省档拿到官方单例 / 官方档它占位且会被顶掉 / `plus` 档
  两件真装备 + 它共存 / 第三件真装备顶掉真占格的那一件 / 点名它做 `replaceUid` 被拒 / 每名干员最多一件 / 点名真
  占格的有效 / 官方档不认「槽位豁免」）。`test/morphPairing.test.js` 原地改了两条：原来钉「未实现」的那条**反过来
  钉「已经做了」**（`effect` 必须写明动了槽位、四处服务端读取点都必须读这一局的策略），另加两条单元级断言
  （缺省档 `===` 官方单例、`equipSlotsUsed` 的裸入口）。
* **测试**：`test/morphPairing.test.js`（形状 / 档位归一化 / 判据本体两档 / prep 读取点 / 战斗读取点的
  缓存按档位失效 / **三处读取点同判**（逐行遍历两档）/ 三处共用同一份判据的源码级断言）。
* **`test/packBehaviour.test.js` 原地改了三处（换语义，不放松）**：①「本版是空表」→「真表里每一格都通过形状守卫、
  每一格至少两档且有非缺省档」；②「空表也响亮」→「不认识的开关也响亮」（被拒的名字从 `shopBias` 换成真表外的名字，
  并新增「文案必须列出真表里的每一个开关」）；③「真表（空）下包装不上」→「真表下不认识的开关装不上」+ 新增
  「选了缺省档 = 引擎今天的行为（逐格遍历真表）」。`PACK_FIELDS` 的闭集计数**不变**（这一刀加的是**表里的成员**，
  不是顶层键）。`test/modSurface.test.js` 的 `ANCHOR_MODULES` 多登记三个模块（`pool` / `economy` / `platform`）
  —— 那是**判据的登记**，不是放松：新增的锚点照样逐条被验。

### 第 8 刀第四格 `unequip`：装备拆卸，以及本层**第一条「开关 + 新意图」**

**投稿 `79de9ff03518`（「装备拆卸mod」）要的那件事收成引擎里一格开关 + 一条新意图（DESIGN §28.43.2）。**
原件同样是安装器：`files.json` 的 `copy` **整份覆盖** `shared/protocol.js`、`server/match/match/intents.js`、
`server/match/player/items.js` 与六个客户端文件，并自加 `g.unequip {itemUid}` 意图。

* **`unequip`**：`official`（缺省，今天的行为：装上之后只能靠精英化 / 合成 / 卖出离开）· `allow`（休整期可以
  把一件已装备的装备**退回手牌**，右→左优先；手牌满则进**临时整备区**）。读取点：
  `unequipAllowed(decl)`（`server/match/player/items.js`，模块层纯函数）→ `PlayerState.unequip`；客户端同一判据
  读它决定**画不画**「卸下」按钮。
* **第一条「开关 + 新意图」的五处落点**（将来加意图照抄这份清单）：① `shared/protocol.js` 的 `C2S` 表
  `'g.unequip': { itemUid: isUid }`（与 `g.equip.itemUid` / `g.destroy.uid` **同一个 `isUid` 子**）；
  ② `server/match/match/intents.js` 一行分支；③ `PlayerState.unequip`；④ 客户端发送点（`gameActions.js` 复用
  既有 `act()`）+ UI（`detailPanel.js` 的 `ItemRow` 的「卸下」+ `game.js` 接线）；⑤ 一处可锚的判据导出。
  **`PROTOCOL_VERSION` 不动**（新增类型不是改已有形状，先例 `records.mine`）；**不新增 S2C 消息**。
* **缺省档逐字节不变**：`unequipAllowed` 为假 ⇒ 回 `ERR.BAD_TARGET` + `'equipped items are locked'`，
  **与 `destroy` 今天那一句逐字相同**；客户端**一个按钮都不画**（判据是「有人传 `onUnequip` 且 `unequipAllowed()`」），
  `ItemDetail` 那句「配发后无法取下」**只在 `allow` 档**换成不带那半句的版本 ⇒ **不需要 `golden:update`**。
* **原子性**（这一格最容易做坏的地方）：`_detach` 之后 `stow(piece, { allowTemp: true })` 可能返回 `null`
  （手牌与临时都满）。那时按**原下标**塞回 `holder.items` 并回 `ERR.HAND_FULL` —— 先摘后塞没有回滚的话装备会
  **凭空消失**。用 `HAND_FULL` 而不是 `BAD_TARGET`：「没地方放」是独立、可行动的错误。
* **池不变式照旧**：装备只是从**装备位**移到**手牌 / 临时**（同一个 `piece`、同一个 `uid`）⇒
  `SharedItemPool.held()` 前后都数得到它 ⇒ `held` / `cap` / `left` 全不变。**没有「归还」这回事**
  （`destroy` / `sell` 才真让池子少一件）。
* **刻意的决定：本格不发内容钩子。** `HOOKS` 那 19 个是**契约面**（进 `META`），「卸下」用哪一个都不贴切
  （不是 `onDestroy`、不是 `onEquip`），今天也没有包需要被通知；将来真有需要就**另立一刀**按契约面扩展。
  写进 §28.43.2 是为了让后人知道这是**决定**，不是漏做。
* **i18n**：新增两个词条（`卸下`、以及不带「无法取下」的那半句），**四个包都补齐**（en / ja / ko / zh-TW）。
  `node tools/i18n.mjs check --all --strict` 的 msgid 数 **1283 → 1285**，en 仍 **100 %**，ja / ko / zh-TW 的
  **57 个缺失与基线逐字相同**（那是既有缺口，不是本刀引入的）。
* **测试**：新增 `test/unequip.test.js`（10 条：真表那一格 / `C2S` 登记与 `validateC2S` 的拒绝（**两层都钉**：
  `validateC2S` 返回原因串、`server/net.js` 折成 `BAD_MSG`，而 `Match.handle` 只认过了它的消息）/ 缺省档
  `g.destroy` 与 `g.unequip` 回**同一句**且一个字节不落地 / `allow` 档三分支（手牌 / 临时 / 两者都满 ⇒
  原子回滚 + `HAND_FULL` 且**下标与失败前相同**）/ 池快照与 `checkInvariants` 前后一致 / `recompute` 后盟约人数
  真的变了（1 → 0，用 `morph-bonds.test.js` 的配方）/ 客户端源码级断言 / 四个 i18n 包的两个新词条）。
  `test/modSurface.test.js` 的 `ANCHOR_MODULES` 多登记一个模块（`items`）—— 同样是**判据的登记**，不是放松。
* **`test/match/fuzz.test.js` 必须同时教一遍**（这一次全量跑出来的真事）：那个模糊测试按 `C2S` 表逐个类型造随机
  载荷，并有 `assert.equal(validateC2S(msg), null, …)` 钉住「造出来的每一条都是合法消息」。新类型没进它的
  `switch` 就会掉进 `default`（`{ t }`，缺字段）⇒ **当场两条红**。补法是加一行
  `case 'g.unequip': return { t, itemUid: uid() };` —— **断言一字未动**，而新意图这下真的进了模糊覆盖
  （随机 uid 会打到 `BAD_TARGET` / 缺省档那句，都被 `assert.ok(res.ok || ERR[res.error])` 接住）。
  ⇒ **记在这里**：这一层将来再加意图，`fuzz.test.js` 的 `randomIntent` 是必须同步的第三处（协议表、`intents.js`、
  它的 `switch`）。

### 第 8 刀第二格的**客户端半**：修掉一句写了很久的谎话（投稿 `8b4e5da55c58`）

第二格的服务端半（`Match.setLoadout` 读 `LOADOUT_PHASES`）第 8 刀就落了，客户端半一直没落。取证发现它**不是**
"少一个发送点"，而是**客户端在撒谎**：

* **发送链路整套早就有**：`public/js/ui/loadoutSync.js` 的 `installLoadoutSync` 早在发 `room.loadout { entries, ops }`
  （500 ms 去抖、面板关闭立刻冲刷、`WRONG_PHASE`/`ROOM_STARTED` ⇒ `'locked'` + 提示）；单干员编辑的纯函数也早在
  （`loadoutModel.setChoice`，缺键即删 entry，与 `mergeLoadoutEntries` 的"只覆盖写了的干员"天然对齐）。
  ⇒ **本刀不新造发送链路、不新增协议消息、不动 `PROTOCOL_VERSION`。**
* **缺的是客户端自己的相位判据，而它写死在两处**（`screens/loadout.js`）：
  1. 「本局已锁定 · 下一局生效」那句的 `locked`（原来"在局中、相位不是 `INFO_CHECK` 就算锁定"）—— 实测它
     **只喂两处文案、不 disable 任何控件** ⇒ 声明 `prep` 的房间出现「**服务端收得下、界面却说锁着**」；
  2. `shouldAutoClose` 的简报那一支 ⇒ 玩家刚进 `PREP`（正是服务端允许改调配的那一段）面板被**自动收走**。
* **做法**：把那份判据收成"一份两档的表 + 一个纯函数"。`loadoutSync.js` 导出 `LOADOUT_CLIENT_PHASES` /
  `loadoutLockPhases(option)` / `currentLoadoutLockPhases()` / `setPrepLoadout(option)`；`roomMods.js` 在**同一处**
  （与 `morphPairing` / `unequip` 并列）用**同一份合并规则**（`mergeBehaviourDecls` + `behaviourValue`）喂档位。
* **两张表的关系**：客户端的表与服务端的 `LOADOUT_PHASES` 是两张表（客户端不能 `import server/**`），这是这一层
  既有的做法 —— **客户端副本 + 一个测试把两张表钉在一起**（与 `CLIENT_WRAP_COMPONENTS`↔`MOD_COMPONENT_IDS`、
  `CLIENT_PANEL_SLOTS`↔`MOD_PANEL_SLOTS` 逐字同一条）。
* **缺省逐字节不变**：缺省 / 没声明 / 不认识的档位 ⇒ 只含 `INFO_CHECK`；两处的旧表达式与新判据
  **逐相位遍历同一个布尔** ⇒ 界面一个字节不变，**没有任何 `golden:update`**。
* ⚠️ **还没做的一件（如实披露，`docs/design/mod-layer.md` §28.43.4 记账）**：`PREP` 里**没有入口**能打开干员调配
  面板 —— `LoadoutButton` 只在大厅 / 房间 / 简报（只活在 `INFO_CHECK`）里出现，`screens/game.js` 里一个都没有
  ⇒ 在贴一个 `PREP` 入口之前，"服务端开了"与"玩家改得了"之间还差最后一步。那是**在对局屏新增一个可见控件**，
  属"新渲染分支"，本轮不做、记账待裁。
* **顺带排查（同类写死相位 / 写死能力，只记录不改）**：`screens/support.js` 的 `shouldAutoClose` 同形，但助战
  **没有开关**且服务端 `room.support` 同样只在 `INFO_CHECK` 收 ⇒ **两边一致、不是缺陷**（将来若要"休整期换助战"，
  那就是第 5 格开关）；`ui/equipReplace.js` 的 `if (equipped.length < 2) return null;` 与
  `ui/gameLogic/placement.js` 的 `items.length < 2` 把**装备位写死 2** ⇒ **与第 7 段（槽位语义）直接相关**，
  第 7 段必须一并交代（否则客户端对话框的触发判据会与服务端的 `equipPerChess` 对不上）。
* **测试**：新增 `test/prepLoadoutClient.test.js`（10 条：缺省档相位表逐字相等 / 默认状态不许"默认开" /
  **逐相位遍历**新旧判据同判 / `prep` 档只放开 `PREP` 一个相位 / **两张表逐档逐字相等** / 源码级（那一行读函数、
  旧写死消失、`ownLocked` 原样保留）/ `shouldAutoClose` 两档行为 / `roomMods` 接线 / **客户端半不新造发送链路**）。

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
