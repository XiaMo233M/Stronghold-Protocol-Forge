# WORKSHOP.md — 创意工坊与助战（remake 扩展）

本文档描述两件**本项目自行新增**的功能，它们都不属于官方数据，也不在 `tools/build-data.mjs` 的生成范围内：

1. **创意工坊（workshop）**：一个不修改 `data/*.json` 的内容叠加层，让社区可以新增/替换干员、装备、怪物、地图等。
2. **助战（support）**：由**服务端**控制的助战卡池与名额，每名玩家每阶可选 n 个，不在卡池中的干员即禁用。

代码位置：

| 关注点 | 文件 |
|---|---|
| 包格式与叠加合并（纯函数，前后端共用） | `shared/workshop.js` |
| 包的文件系统加载 | `server/workshop.js` |
| 叠加层接入数据加载（冻结之前） | `server/data.js` |
| 把合并后的 `/data/*.json` 发给浏览器 | `server/index.js`（`buildWorkshopDataFiles`） |
| 包语音汇总进 `assets.audio.voice` | `shared/workshop.js`（`workshopVoiceIndex` / `mergeWorkshopVoices`） |
| 包自带盟约图标并进 `assets.bonds` | `shared/workshop.js`（`workshopBondIconIndex` / `mergeWorkshopBondIcons`） |
| 助战配置与校验（纯函数，前后端共用） | `shared/support.js` |
| 助战卡池的服务端声明 | `data/support.json` |
| 助战的引擎侧视图 | `server/match/gamedata.js` |
| 助战消息与落库 | `shared/protocol.js`、`server/lobby.js` |
| 助战的对局内生效 | `server/match/Match.js`、`server/match/PlayerState.js` |
| 一个包的 `.zip` 读写（零依赖，确定性且拒绝优先） | `shared/zip.js` |
| 导出 / 导入 / 列出与 `pack.json.support` 的读写（CLI 与编辑器共用） | `tools/workshop-pack.mjs` |
| 测试 | `test/workshop.test.js`、`test/workshopVoices.test.js`、`test/workshopAssets.test.js`、`test/support.test.js`、`test/zip.test.js`、`test/workshopPack.test.js` |

---

## 1. 创意工坊

### 1.1 包结构

```
workshop/<packId>/
  pack.json         必需
  chess.json        内容文件：{ [id]: record }，与 data/chess.json 同形
  units.json        内容文件：{ [charId]: record }，与 data/backups.json 的 units[charId] 同形（新干员的干员记录）
  items.json  enemies.json  stages.json  waves.json  tokens.json  bosses.json
  factions.json  garrisons.json  bands.json  bonds.json  effects.json  choices.json
  variants.json     内容文件，但**不是记录表**：`{ [轴]: { [文件]: { [id]: 补丁 } } }`，只给**已有**记录写另一套
                    口径数值（DESIGN §28.51）—— 不新增记录、不写新键、不发明轴
```

> `units.json` 是唯一一个**文件名与落点不同名**的内容文件：`data/` 里没有顶层 `units.json`，那条干员记录住在
> `data/backups.json` 的 `units[charId]`（`server/sim/simdata.js`、`shared/standIn.js`、客户端
> `data.get('backups').units` 都只读这一个位置）。所以 `content: ["units"]` 的包，装载时被并进 `data.backups.units`，
> 而浏览器要拿到的**合并后**文件是 `/data/backups.json`（`workshopTouchedFiles` 把 `units` 映射成 `backups`）。

`pack.json`：

| 字段 | 必需 | 说明 | 编辑器里的入口 |
|---|---|---|---|
| `id` | 建议 | 包 id，必须等于目录名；只能是 `[A-Za-z0-9_-]`，≤32 字符 | 建包时定（改它等于换一个包） |
| `name` | 否 | 显示名（默认取 `id`） | 包管理 → 包元数据 |
| `version` | 否 | 默认 `0.0.0` | 包管理 → 包元数据 |
| `author` / `license` / `description` | 否 | 元信息；`license` 用于声明素材授权 | 包管理 → 包元数据 |
| `gameVersion` | 否 | 作者针对的游戏版本，便于排查；`game` 的**别名**（读的时候优先 `game`）。**必须是字符串**：写成非字符串（`3`、`true`、数组）整包被拒 `BAD_GAME_TYPE`；`null` / 空串 = 没写 | 包管理 → 包元数据 |
| `game` | 否 | 作者针对的**上游游戏版本区间**（`>=0.2.0` / `0.2.x` / `*`），见 §1.9；`gameVersion` 是它的别名、优先读它。写了坏区间整包被拒 `BAD_GAME_RANGE`，写成非字符串被拒 `BAD_GAME_TYPE`；`null` / 空串 = 没写 | ⛔ 本轮无图形入口（作者手写 `pack.json`） |
| `content` | 贡献项之一 | 这个包提供哪些数据文件（上表的名字，含 `bonds`、`units`） | 各页保存时自动补 |
| `voices` | 贡献项之一 | 这个包为哪些干员提供**默认配音**的语音，见 §1.4 | 语音页 |
| `voiceLangs` | 贡献项之一 | 同一个包给**其它配音语言**（cn/en/kr，默认那一档是日文）各配一份，见 §1.4；形状与 `voices` 相同，多一层语种 | 语音页（语种选择） |
| `bondIcons` | 贡献项之一 | 这个包为哪些盟约提供图标，见 §1.4 与 §1.8：`{ "<bondId>": "<包内相对 assets/ 的路径>" }` | 盟约页 + 该页的「已声明」清单 |
| `itemIcons` | 贡献项之一 | 这个包为哪些装备/道具提供图标，见 §1.4：`{ "<图标 id>": "<包内相对 assets/ 的路径>" }` | 装备页 + 该页的「已声明」清单 |
| `art` | 贡献项之一 | 这个包自带的外观素材（头像 / 立绘 / 模型）**与四张扁平图表**（技能图标 / 分支图标 / 盟约图集 / 分队图集），见 §1.4、§1.2：`{ chars / enemies / tokens / skills / profSub / bonds / bands: { "<id>": … } }` | 干员页 / 怪物页的「本包自带的外观素材」+ 「已声明」清单 |
| `skins` | 贡献项之一 | 这个包给某些干员带来的**时装**（一套 = 立绘 / 头像 / 可选模型与语音），见 §1.17：`[{ id, charId, name, series?, desc?, art?, voices? }]`。字段闭集是 `SKIN_FIELDS`，`art` 与 `art.chars` 的一条**同形**；落点是 `assets.skins[<charId>]` 的一列（同一干员可以有好几套）。**引擎不认识「皮肤」**：哪一套生效由一个注册了的外观提供者决定，玩家可以用设置里的「工坊外观」整个关掉 | ⛔ 本轮无图形入口（作者手写 `pack.json`） |
| `support` | 否 | 这个包自己新增的、应当进助战卡池的干员 id 列表，见 §2.1；阶由记录推导 | 包管理 → 助战声明 |
| `operators` | 贡献项之一 | 这个包自己新增的、应当进**自选池**（自选编队）的干员，见 §1.2；名字/星级/职业/分支从本包那条 `units` 记录派生 | 包管理 → 自选池声明 |
| `playtest` | 否 | **试玩行为开关**（不进记录）：`{ "directToHand": ["<chessId>", …] }` —— 这些干员在编辑器「一键试玩」的第一回合直接进手牌，见 §1.2 与 docs/EDITOR.md §试玩 | 干员页的「试玩时直接发到手上」复选框（覆盖官方干员时写在这里；本包新增的干员仍写在记录里）+ 包管理 → 试玩直接发到手上（逐条删除） |
| `overrides` | 否 | 允许覆盖的官方记录，格式 `"<file>:<id>"`，例如 `"chess:chess_char_1_01_a"`、`"bonds:yanShip"`、`"units:char_4231_clemnt"` | 包管理 → overrides（盟约页覆盖官方时自动补 `bonds:<id>`） |
| `api` | 否 | 包写它时的**模组 API 区间**（钩子总线与 kit 契约，见 §1.9）：只有声明了才与 `shared/constants.js MOD_API_VERSION` 比对，不含这个 build 就整个包被拒（`MOD_API_INCOMPATIBLE`）。**必须是字符串**：`"1"` / `"1.x"` 都行，写成非字符串（`1`、`true`、数组）整包被拒 `BAD_API_TYPE` —— 不静默读成「没声明」；`null` / 空串 = 没写 | 包管理 → 包元数据（本轮只是可写可读可判，编辑器入口见 §1.9「当前状态」） |
| `assets` | 贡献项之一 | 客户端资源容器声明（§1.9）：`{ container, manifest, serverPolicy?, verify? }` | ⛔ 本轮无入口（A 段只做格式） |
| `client` | 贡献项之一 | C 层注册点声明（§1.9）：`{ panels: [{ id, slot, module, order?, gate? }], requires?: […] }`，`slot` 是闭枚举 | ⛔ 本轮无入口 |
| `server` | 贡献项之一 | 服务端侧的三类声明（§1.9）：`{ preDispatch: { module, policy, intercepts }, meta: { module, registers }, modules: [{ id, entry, uses, write? }] }`。`preDispatch.intercepts` 必须是 `shared/protocol.js C2S` 里真实存在的类型；`meta` 与挂了 `matchClass` 的模块都要求包声明 `combat: true` | ⛔ 本轮无图形入口 |
| `routes` | 贡献项之一 | 只读 HTTP 路由声明（§1.9）：`[{ path, file, cache? }]`，只服务包内 `.json` | ⛔ 本轮无入口 |
| `i18n` | 贡献项之一 | 给**已有语种**（`en` / `ja` / `ko` / `zh-TW` …）补界面词条：`{ "<语种>": "<包内相对 .json 路径>" }`，见 §1.10 | ⛔ 本轮无入口 |
| `forms` | 贡献项之一 | 这个包自带的干员 / 怪物**自己的形态（clip set）**，见 §1.19：`{ chars / enemies / tokens: { "<spine id>": { "<形态名>": { change?, end?, leave?, next?, roles } } } }`。**第一方已有的形态名不许覆盖**（`FORMS_FIRST_PARTY_OVERLAP` 整包拒绝） | ⛔ 本轮无图形入口（作者手写 `pack.json`） |
| `fx` | 贡献项之一（空数组除外） | 包自己的**静态相位**：`{ "silentPhases": ["<phase kind>", …] }`，命中的 `'phase'` 特效不放通用特效，见 §1.19。与第一方那两个**并集**（取消不了） | ⛔ 本轮无图形入口 |
| `variants` | 否（声明，**不是**贡献项） | 这个包要的**变体 / 口径**（满练度 / 12 部署位这类可切换口径），见 §1.20：`[{ axis, default? }]`，轴与选项名都是**闭枚举**（`shared/variants.js`），值由引擎自己给。声明了就必须标 `combat: true`（`VARIANTS_NEED_COMBAT`） | ⛔ 本轮无图形入口（作者手写 `pack.json`） |
| `behaviour` | 否（声明，**不是**贡献项） | 这个包要的**行为开关**（引擎里**已经实现**的一条规则按哪一档跑），见 §1.22：`[{ switch, option?, name?, desc? }]`，开关名与选项名都是**闭枚举**（`shared/behaviour.js`），**动作由引擎构造**。声明了就必须标 `combat: true`（`BEHAVIOUR_NEEDS_COMBAT`）。**本版那张表有 5 格**（`shopBias` / `prepLoadout` / `morphPairing` / `unequip` / `diyPoolOverlap`，见 §1.22 与 §1.23）⇒ 声明表里没有的开关（或选项）仍被 `BEHAVIOUR_UNKNOWN_SWITCH` / `BEHAVIOUR_UNKNOWN_OPTION` 点名整包拒 | ⛔ 本轮无图形入口（作者手写 `pack.json`） |

**每个字段都有图形入口**（0.8.1 起，最后补上的是元数据与 `overrides`；`operators` 的入口见 §1.2）：写进 `pack.json`
的东西必须能在界面上增删改，包括**陈旧/没人用的条目**（它们只是不生效，不是错误，但要能删掉）。唯一没有入口的是 `id`：它必须等于目录名。

**顶层键是闭集**（`shared/workshop.js PACK_FIELDS`）：上面这张表**就是**这份格式认识的每一个字段。写一个不在这张表里的
顶层键（打错、或者抄了另一个 mod 格式的字段）**整个包被点名拒绝**：`PACK_UNKNOWN_FIELD`，理由里列出全部合法字段。
这不是「我们还没做」，是**刻意**的 —— 一个我们不认识的键如果只是被读过去，作者看到的是「包合法、加载了、可我写的那件事
没发生」。三个社区 mod 里最典型的三个键里，两个**没有通道**、都被当场拒绝而不是静默丢弃；第三个（`skins`）
后来做成了真字段，所以它今天在**上面的字段表里**、在下面这张表里只留下「为什么它不该被当成 `art` 用」这一条：

| 键 | 今天的结果 | 想做的事 | 今天该往哪儿写 |
|---|---|---|---|
| `variants` | **已实现，见 §1.20** | 「同一份数据的另一套数值 + 一个开关」（满练度 / 12 部署位这类**可切换口径**） | 写成 `variants: [{ axis, default? }]` —— **不是**一张数据文件，也**不是**一条数值覆盖通道：轴与选项名都是**闭枚举**（`shared/variants.js` 的 `VARIANT_AXES`），值由引擎自己给。声明了就必须标 `combat: true`（`VARIANTS_NEED_COMBAT`） |
| `skins` | **已实现，见 §1.17** | 干员时装（皮肤）与「换装」Tab | 写成 `skins: [{ id, charId, name, art?, voices? }]`（一套外观的**数据**）；**哪一套生效**由一个注册了的外观提供者决定（C 层面板导出的 `appearance(ctx)`），玩家可以用设置里的「工坊外观」整个关掉。只装数据包不会有画面变化 —— 那需要那个提供者。**不要**改成 `art.chars[<charId>]`：那给的是**唯一一套**素材，换不了装 |
| `official` / `config` / `meta` / `shared` / `theme` / `serverModules` | `PACK_UNKNOWN_FIELD` | 官方口径文件 / 规则改写 / match 元注册表 / 共享层补丁 / 主题 / 服务端模块 | **刻意没有通道**（`config` 见下面那一段；其余是引擎特性或 wire 契约，按 `AGENTS.md`「Official first … the maintainer's decision only」）。**判断一字不变**；属于「**引擎先实现、包只声明**」那一类规则改动走 §1.22 的 `behaviour`（唯一入口）—— **不是**这六个键复活 |

`content` 只接受上表列出的文件，而且**不认识的条目点名整包拒绝**（`UNKNOWN_CONTENT_FILE`）—— 从前它是安静过滤掉的，
作者看到的是「包合法、我写的那件事没发生」。**`config` 被刻意排除**：一个能改写经济、回合表或难度参数的包改的是
规则而不是内容，那需要另一套审查机制，不在本功能范围内。**`behaviour`（§1.22）不是 `config` 换了个名字**：它只收
「开关名 + 闭枚举选项名」，一个数字、一个键路径、一个文件都写不进去 —— 这正是两者分得开的地方。

**只带素材的包是合法的包**：`content: []` + `voices` / `voiceLangs` / `bondIcons` / `itemIcons` / `art` / `skins` / `operators` / `i18n` / `forms` / `fx`
里任意一项（见 §1.4、§1.10、§1.17、§1.19）。一个只给助战干员配语音、只给盟约/装备配一张图、只给某个干员配一张立绘或一套时装、
只给已有语种补几条界面词条、只给自己的怪物补一个形态或一个静默相位的包，不需要提供任何数据文件；反过来，这些贡献项**全空**才会被拒（`EMPTY_PACK`）。

`support` 与 `playtest` **不是**贡献项：`support` 只决定**助战卡池**里放谁，干员本体还是由 `content: ["chess"]` 带进来的
—— 所以一个只写 `"support": […]`、`content: []` 的包会被 `EMPTY_PACK` 拒，而理由里会点名 `support`（见 §2.1 的完整例子）。

中间层的四组能力声明（`assets` / `client` / `server` / `routes`，见 §1.9）与 `i18n` 也是贡献项 —— 但只有**声明了内容**
才算：`routes: []`（空数组）与不声明没有区别，照旧 `EMPTY_PACK`；`fx: { "silentPhases": [] }` 同理（见 §1.19）。
`api` 与 `playtest` 一样**不是**贡献项：它们是声明（前者的区间、后者的行为开关），一个只带它们的包什么都没带来。

### 1.2 叠加规则
- **默认叠加（additive）**：新 id 直接加入。
- **覆盖需要显式声明**：官方已有的 id 只有在 `overrides` 里列出时才被替换；否则该记录**被拒绝并记入报告**，官方记录保留。这条规则存在的理由是：静默替换一名官方干员会污染服务器上的每一局。
- **记录自检**：内容文件必须是 `{ id: record }` 对象；当记录自带 id 字段（如 `chess.chessId`）而它与键不一致时，整条被拒绝。
- **两个包抢同一个 id：包 id 字典序小的赢**（DESIGN §28.3，2026-10-09 业主裁定）。这一条**对所有面都一样** —— 数据记录、`kits/<chessId>.js`、`bondIcons`、`itemIcons`、`art`；而且与「包是按什么顺序被扫描到的」**无关**（服务端按目录名读、合并前再按包 id 排序，两处用同一个比较器）。输的一方会得到一条**点名**占位包的报告（`definedBy` + 文案里写出包名），不是静默覆盖。
- **覆盖官方 id 仍要显式声明**：`overrides` 是唯一能让一个包替换**官方**记录 / 官方干员 kit 的方式，且这份声明会让它同时成为「后来的包」要撞的那一方（上一条规则决定谁赢）。**给维护者的一句话**：编辑器这一侧的判罚必须**同时看 id 与声明**，不能只在校验前把官方 id 从集合里剔掉 —— 后者会让编辑器放行一次保存、而加载器随后因为「没声明」丢掉这条记录（编辑器回 200、游戏里没有），比「编辑器 400 拒绝」更坏。所以放行与记住声明是同一次保存的两半（`editor/server.mjs` 的 `overrideBlockers` 与 `withOverrideDeclarations`），预览与保存也必须算出同一个判罚。
- **覆盖是「按字段打补丁」，不是整条替换**（DESIGN §28.3，2026-10-09）：只写 `stats.maxHp` 就只改这一个数，官方那条记录的其它 43 个字段（`tier` / `skill` / `talents` / `rangeGrid`…）原样保留；数值与普通对象递归合并，**行为与结构字段整块替换** —— `skill` / `skills` / `trait` / `traitBase` / `traitOverride` / `modules` / `rangeGrid` / `attackRangeGrid` / `assets` / `diy` / `bonds`（清单在 `shared/workshop.js` 的 `OVERRIDE_REPLACE_KEYS`，数组一律整块替换）。**覆盖是闭合世界**：写了记录里没有的字段会被 `UNKNOWN_OVERRIDE_FIELD` 拒绝（要发明新字段就把它作为一个新 id 的新记录）。想「连行为一起接管」的包必须成套补回：给了 kit 就要给 `skill`（§4.1），否则那个干员没有技能。**作者侧校验判的是合并后的那一条**：`tools/workshop-validate.mjs` 对 `overrides` 里声明过的 id 先取 `loadData` 的合并体再跑逐记录校验（`judgeRecord`），所以一份只写要改的字段的差量补丁不会被报成「缺 `profession` / 缺 `stats`」，也不会再报 `OFFICIAL_ID_COLLISION` —— 与引擎、编辑器同一份判据（`docs/EDITOR.md` 的那条「编辑器接受什么、校验器就接受什么」）。反过来，**没有**声明覆盖的补丁仍按一条完整记录判，缺什么报什么（`test/workshopValidateOverrides.test.js` 把两半都钉住）。
- **规则字段不靠包引入（`giveBondBiasOnly` 这一类）**。一个社区 mod 给**每一条官方装备**加了一个字段
  `giveBondBiasOnly`（其中 18 条为 `true`），语义是「商店里那 18 件盟约签名装备的**刷出概率**偏向你叠得最高的
  盟约，但**不授予**盟约」。它今天的两条路都被挡住，而且是**故意的**：
  - 写进记录（`overrides`）⇒ `UNKNOWN_OVERRIDE_FIELD`，整条被拒、值一个字节都不落地（闭合世界，上面那一条）；
  - 写成 `pack.json` 的顶层键 ⇒ `PACK_UNKNOWN_FIELD`（§1.1 的闭集）。

  **为什么不补它**：它改的是**一局的商店出货概率**（= 改对局结果），而按 `AGENTS.md`
  「Official first … Deliberate deviations from the official mode are the maintainer's decision only」，
  这类改动是维护者的决定，不该由内容包引入 —— 与 `config` 被排除是同一条理由。**也不能凑合**：只写 `giveBondId`
  会变成「**授予**盟约」（本引擎的语义），与原作的「只偏置、不授予」**相反** —— 宁可少一个特性，也不制造一个
  语义相反的假实现。真要这条特性，正确做法是维护者在引擎里做成一个开关（商店池 + `bondsMeta` 的读取点），
  然后**任何**包都能用 —— **这条通道今天开着，见 §1.22 `behaviour`**：开关的名字、选项与动作都由引擎写，
  包只能声明「要哪一档」。本版那张表还是**空的**（引擎里还没有实现好的那一格），所以这句话今天仍读作「等维护者
  落那一格」，只是落点已经有名有姓。
- **被包变成棋子的官方干员：记录，不摘除（`stripPackOperators`）**。一个包可以把一名**官方干员**变成棋子
  （`content: ["chess"]` 里那条记录的 `charId` 指向他）。这时他会**同时**躺在自选池（`data/backups.json` 的
  `diy.ownedPool`）里 —— 同一个干员能被上两次，而且自选槽绕过棋子自己的盟约。装载层把这件事**逐条记下来**
  （`applyWorkshop` 报告的 `overlaps`：包 id、干员 id、那条 chess 记录 id、他本来就在池里还是本包声明进池的），
  但**不把人摘出池**：`diy.ownedPool` 就是「自选槽能挑到谁」这份名单，摘掉它 = 改对局结果 = 改版本语料，
  那是维护者的决定（实测：一份真实的社区数据里 **8 名**干员同时满足这两个条件，摘掉就是 `ownedPool` 71 → 63）。
  重复**永远不会发生**：`mergeWorkshopOperators` 的「一个 id 只进池一次」是既有不变量，与这条记录无关。
  **这一条已经在设计里定过**：DESIGN §28.10.1 明写「包**不给**作者改官方干员在不在池里的能力 —— 池子属于安装方」，
  并把社区 mod 的 `stripPackOperators` 具名列为**按此条驳回**的行为。所以这里的「只记录」不是「还没做」。
- **两张天赋表按条目合并，不是整块替换**（DESIGN §28.3，2026-10-09 当天第二次修正）：`talents` / `talentsBase` 按 `index` 逐条合并 —— 你写的那一条里出现的字段生效，**你没写的字段（包括官方那条天赋自带的注释）留着**；`index` 对不上官方任何一条时是「你新增了一条天赋」，追加在后面。模组内部的 `modules[].talentChanges` 同理，按 `talentIndex` 逐条合并。
  **为什么单独开一条规则**：官方记录里的天赋可以带「潜能链」注释（记录层的 `potDown`、天赋层的 `potMin` + `potBelow`），而编辑器派生出来的记录**故意不带**这些注释。整块替换的话，你只是改了一条天赋的文案，官方那条天赋的整条潜能链就没了，而加载器一句错都不报 —— 一条**静默**的数据丢失。裸列表（`bonds` / `immunities` / `rangeGrid` …）仍然是整块替换：按字段合并一个裸列表会造出一条没人写过的记录。
- **特质可以授予盟约（`trait.grantsBonds`，DESIGN §28.49）**。一条 chess 记录的 `trait` 上可以写一格
  `"grantsBonds": ["<bondId>", …]`，语义是「带这条特质的棋子**视为那些盟约的成员**」—— 于是它进成员计数
  （`server/match/bondsMeta.js` 的去重成员集合）⇒ count +1 ⇒ 该盟约的**层数**自然上去（这就是「固有天赋叠加盟约
  层数」那条路，纯数据，不需要模块、不需要 `server.meta`）。
  - **不写这一格 ⇒ 逐字节不变**：特质今天完全不参与计数，官方 266 条记录一条都没有它，所以 `test/golden/*.json`
    一个字都不动，也不需要抬 `MOD_API_VERSION` / `PROTOCOL_VERSION`（加一格字段不抬版本）。
  - **判据只有一份**：`shared/morph.js` 的 `grantedBondsByTrait`；而**成员资格的合并**也只有一份
    （同文件的 `memberBonds`）—— prep 的 `bondsMeta.pieceBonds`、战斗里的 `support/index.js unitBonds`、
    客户端的 `gameLogic/bonds.js`（`pieceBondIds` 与盟约弹窗的 `bondMembers` **两处**读者）调的都是它。
  - **写错了会被点名，但不会让包装不上**（与 `assets.mirrors` 那条「停用并点名，不拒包」同一条口径）：盟约 id
    在这台机器上不存在 ⇒ `TRAIT_GRANT_UNKNOWN_BOND`；`grantsBonds` 不是「非空字符串数组」⇒
    `TRAIT_GRANT_BAD_SHAPE`（`"yanShip"` / `[1]` / `[null]` / `{}` 都算）；空数组 ⇒ `TRAIT_GRANT_EMPTY`。
    这三条在**启动日志**（`[workshop] <包>: <码>: <理由>`）与 **`npm run workshop:validate`**（warning，不红）
    里都会出现，而且读取点会把不存在的 id 挡在计数之外 —— **一个静默降级都不会留下**。
  - ⚠️ 那条特质的 `trait` 必须写成**对象**（`trait` 写成字符串时它连子键都挂不上；那是一个既有的静默降级，
    不在本格范围内）。
- **行为开关不进记录：`playtest.directToHand`**（2026-10-09）。这个字段列出的干员在**编辑器「一键试玩」**起的那个服务器里第一回合直接进手牌；正式对局一个都不发。它存在的理由是**覆盖模式**：覆盖官方干员时记录必须与官方**同形**（覆盖的契约就是「按字段打补丁」，多一个官方没有的键会被 `UNKNOWN_OVERRIDE_FIELD` 整条拒掉），所以「试玩直接发牌」这种**行为开关**不能写进记录，只能写在包的行为层。三条规则：
  - **成员资格**：名单里的每个 id 必须是**这个包自己的** chess 记录 id，或者（覆盖模式）这个包在 `overrides` 里声明过的官方 id（**一对都要**：普通 `_a` 与精锐 `_b` 各算一个 id）。不认识的 id ⇒ **整个包被拒**并**点名**那个 id（`PLAYTEST_UNKNOWN_CHESS`）—— 静默无效正是这个字段要修的那个老毛病。形状错（不是对象、值不是字符串数组、元素不是合法 id）⇒ `PLAYTEST_BAD_SHAPE`。
  - **谁赢**：两个包声明同一个 id 时，沿用上面那条「包 id 字典序小的赢」；输的一方拿到一条点名报告（`PLAYTEST_ID_COLLISION` + `definedBy`），名单里那个 id 只出现一次。与目录扫描顺序无关。
  - **与记录里的 `directToHand` 是并集**：本包**新增**的干员照旧把 `directToHand: true` 写在记录里（今天的行为一字未改），引擎把两个来源并起来。两种写法都只在 `SP_PLAYTEST=1` 时生效。
- **失败关闭**：包 id 不合法、`content` 为空、文件缺失或不是合法 JSON — 该包被跳过并报告，服务器继续启动。
- **`workshop/` 不存在是正常情况**：没有包就没有叠加层，行为与加入本功能之前完全一致。

#### 新增一个干员（`content: ["units"]` + `pack.json.operators`）

「一个包新增一名干员」需要两件东西，缺一件这个干员在游戏里就不完整：

| 件 | 写在哪 | 落进哪 | 少了它会怎样 |
|---|---|---|---|
| 干员记录 | `<pack>/units.json`，`{ [charId]: record }`，形状与 `data/backups.json` 的 `units[charId]` 同形 | `data.backups.units[charId]` | 自选界面画不出名字/职业，一局里取不到 def |
| 自选池声明 | `pack.json.operators`，`{ [charId]: { bonds, powers } }` | `data.backups.diy.ownedPool`（push，去重）+ `diy.operators[charId]` | 干员记录在数据里，但**自选编队里没有他** —— 拿不到手 |

> ⚠️ **判据：走自选池的干员，`data.chess` 里没有他的棋子 —— 这是正常形状，不是「没装上」。**
> 自选干员不注册自己的 `chess` 记录（所以 `content` 里**不该**声明 `chess`，他也没有 `kits/<chessId>.js`
> 那种按棋子 id 挂的 kit）：他出战走的是**自选槽位** `chess_char_5_diy1_a` / `chess_char_6_diy1_a` 这类
> 通用棋子，引擎在开局时按 `shared/diy.js` 把 `diy.operators[charId]` **组合**成那一局的 def。
> ⇒ 于是「**`GameData.chess(charId)` 是 `false` / `visibleChess` 里没有他**」**不能**当作「永远进不了游戏」的证据。
> **要判他进没进游戏，查这三处**（这才是判据）：① `backups.diy.ownedPool` 含这个 charId；
> ② `backups.diy.operators[charId]` 在（名字/星级/职业/盟约）；③ 这条 `units` 记录的 `forms` 覆盖
> `diy.slots` 要的那组档位（`requiredUnitForms`，缺了自选槽挑不上、`tools/golden.mjs` 会抛）。
> 另外 `tools/workshop-validate.mjs` 对这类干员会报一条 `ART_UNKNOWN_ID`（「没有 chess 记录指过来 ⇒ 这份素材
> 没人用」）—— 那是**误报**：素材由 `assets.chars[charId]` 直接可达（`assets.spine` 在），它只是不认识自选干员。
> （实测来源：包 `makoto-yuki`，站上记录 `49e807b1b5b0`。第一次只查 `data.chess` 得 `[]`、误判「进不了游戏」，
> 补查上面三处后为「进得了游戏」。）

```json
{
  "id": "my-op", "license": "CC0-1.0", "content": ["units"],
  "operators": { "char_4231_clemnt": { "bonds": ["egirShip"], "powers": ["egir", "iberia"] } },
  "art": {
    "skills":  { "skchr_my_1": "skill/my1.png" },
    "profSub": { "mybranch":  "prof/sub/mybranch.png" }
  }
}
```

**规则（都已强制）**：

| 规则 | 说明 |
|---|---|
| **只查「下游用得上吗」，不复制官方 schema** | `units.json` 的每条记录只要求 `charId`（＝键）、`name`、`rarity`（整数）、`profession`、`subProfessionId`、`forms`（非空对象）六项，其余字段**一律照抄**。理由：复刻一份官方 schema 就是给自己加一个会漂移的第二真相；下游真正读的也只是这几个键。逐条的拒绝码：`UNIT_MISSING_CHAR_ID` / `UNIT_MISSING_NAME` / `UNIT_BAD_RARITY` / `UNIT_MISSING_PROFESSION` / `UNIT_MISSING_SUB_PROFESSION` / `UNIT_BAD_FORMS`，`charId` 与键不一致是既有的 `ID_MISMATCH` |
| **四个字段从记录派生，清单里不重复写** | `name` / `rarity` / `profession` / `subProfessionId` 一律取本包那条 `units` 记录，`obtainable` 恒为 `true`。`pack.json.operators` 里写这些字段是**没有用**的（装载器不读）—— 两份真相会漂移，而 `diy.operators` 那份今天是生成器产出的 |
| `OPERATOR_NO_UNIT` | 声明了一个本包没有 `units` 记录的干员 → 拒绝 + 点名。没有记录就没有名字与职业，进池等于一个空槽 |
| `OPERATOR_NOT_SIX` | `rarity !== 6` → 拒绝。**自选池就是六星那条路**；5★ 及以下请走工坊棋子注册表（`content.chess` + `kits/<chessId>.js`），那里才有商店阶级 |
| `OPERATOR_BOND_UNKNOWN` | `bonds` 里某个 id 不在 `data/bonds.json` → 拒绝 + 点名。**这条必须拒**：盟约 id 写错时那条盟约条**永远不会出现**（没有图标、没有阈值），而作者只会以为「盟约没生效」—— 一次完全静默的失效 |
| `OPERATOR_FORM_MISSING` | `forms` 没覆盖自选槽要的档位 → 拒绝 + 点名缺的那一档。自选槽的**普通与精锐两条记录各自**要求一个档位（`shared/diy.js` `checkDiyPick` 同时解析两条；**哪两条算这一对**见下面那一节），缺一个这个干员就挑不上；更重的是 `tools/golden.mjs` 会给池里每位配一个精锐场景，所以缺档位会让**语料生成抛异常**，`golden` / `ci` 全线挂。要求的那一组**从 `diy.slots` 的两条记录派生**（`requiredUnitForms`），不是硬编码 `2/60/7/3` |
| `OPERATOR_BAD_SHAPE` | `operators` 不是对象、某一条不是对象、`bonds`/`powers` 不是字符串数组、干员 id 不合法 → 拒绝 |
| **两个包给同一个 charId** | 内容文件那一层就按 §1.2 裁决：**包 id 字典序最小者赢**，输的一方得到一条点名报告（`units:<id>`），它的自选池声明随之作废（它其实没有可供声明的记录）。`ownedPool` 因此只会多一个 id |
| **`data/*.json` 一个字节都不改** | 叠加发生在 `deepFreeze` 之前（§1.3）。所以「作者能加」与「生成器是唯一来源」同时成立：磁盘上的 `ownedPool` 仍是生成器写的那份，`test/backups.test.js` 对**文件**的断言完全不受影响；把包删掉，游戏立刻回到原样 |
| **入池顺序只由包 id 排序决定** | 与目录扫描顺序无关（`byPackId`，DESIGN §28.3）—— 同样的包集合永远得到同样的 `ownedPool` |
| **潜能注解（`potDown` / `potMin` / `potBelow`）不写 = 潜能对它无效** | 包干员通常没有这些注解，0.2.2 引擎的行为是：**不报错、天赋不丢，但属性与天赋数值不随潜能缩放**（潜能 1 与潜能 6 真建局逐字节相同；官方带注解的干员会缩放）。要让它随潜能变，就得照官方记录把注解一并抄进 `forms` |
| 编辑器入口 | 包管理 → **自选池声明**（§1.1）。干员记录本身由干员页写成 `units.json`；**「新建一个干员」的表单不在本轮**，见 DESIGN §28.11 |

#### 哪条档位算「普通」、哪条算「精锐」（`units.json` 的 `forms` 键）

`OPERATOR_FORM_MISSING` 要求的是「自选槽的普通与精锐两条记录各自的档位」。**这两条记录是官方数据给定的
一对**，不是包在 `forms` 里怎么写的：

| | 是哪一条 | 依据 |
|---|---|---|
| **普通** | 槽位自己的 id（`chess_char_6_diy1_a`；`data/chess.json` 里 `isGolden: false`） | `shared/diy.js diySlot()` 的 `normal`，从 `diy.slots` 的键取 |
| **精锐** | `data/backups.json` 的 `diy.slots[<槽位>].goldenId`（`…_b`；`isGolden: true`） | `shared/diy.js diySlot()` 的 `golden`；这一对来自**官方** `shop.goldenChessId`（`tools/build-data.mjs`，slot 只收 `isDiy && !isGolden` 那条、精锐由它的 `goldenId` 指过去） |

两条记录各自的 `status` 变成一个 `forms` 键：`${phase}/${level}/${skillLevel}/${equipLevel}`
（`shared/standIn.js statusKey`），而**两条都要在** —— `requiredUnitForms()`（`shared/diy.js`）取每个槽位
那一对的**并集**，装载器拿它判 `OPERATOR_FORM_MISSING`（缺哪一条就点名哪一条）。实测（`data/chess.json` /
`data/backups.json`，2026-10-13）：4 个官方槽位的 `_a` 都是 `2/1/4/0`（E2 Lv1 / 技能 4 / 模组 0），
`_b` 是 `2/60/7/1`（tier 5 的槽位，模组 1）或 `2/60/7/3`（tier 6 的槽位，模组 3）——
`requiredUnitForms()` 就是这三个键的并集，判据在 `test/workshopOperators.test.js`。

**引擎里没有「按名字或按书写次序给 `forms` 分普通与精锐」这回事**，也不该有：分类的唯一来源是 `diy.slots`
指向的那两条记录。所以一个包干员要进自选池，正确做法是照官方那两条记录把**两个档位**都抄进 `forms`，
而不是猜「第一条是普通」或者「键里带 60 的那条是精锐」。

> `[ASSUMED]`：「**普通 / 精锐**」这两个词是**本项目**对自选槽那一对记录的叫法（`diySlot().elite`，
> 代码与本文档里一直这么用）；官方词表里没有这两个词，Forge（上游工坊工具）也没有为「包声明的
> `forms` 里哪条算普通、哪条算精锐」下过定义。有依据的是「哪两条记录的 `status` 必须都在 `forms` 里」
> （上面那张表，一路上溯到官方 `shop.goldenChessId`）；**没有依据**的是「官方口径里哪一条叫普通、
> 哪一条叫精锐」—— 那一步请以数据为准，不要按名字或键序猜。

#### 技能图标与分支图标（`art.skills` / `art.profSub`）

`assets.json` 的这两张表**值直接就是路径字符串**（不像 `chars` 那样是「对象 + `urls` 字段」），所以它们是
`ART_TABLES` 里的**扁平表**（`flat: true`）：条目本身就是路径，落点由 `target` 给出。

```json
"art": {
  "skills":  { "skchr_my_1": "skill/my1.png" },
  "profSub": { "mybranch":  "prof/sub/mybranch.png" }
}
```

| 表 | 落点 | 客户端读它的地方 |
|---|---|---|
| `skills` | `data.assets.skills[<图标 id>]` | 技能图标（`<技能 id>` = 记录里 `skills[].icon`） |
| `profSub` | `data.assets.prof.sub[<subProfessionId>]` | 职业分支图标（小写分支名，例如 `primguard`） |

规则与其它图标通道逐字相同：路径相对 `assets/`、无穿越（`ART_PATH_UNSAFE`）、id 字符集同一套（`ART_BAD_ID`）、
URL 走 `/workshop-assets`（客户端零改动）、官方已有这个 id 时是**替换**（给官方技能换图标）、两个包抢同一个 id 时
**包 id 最小者赢**并点名（`ASSET_COLLISION`）。`assets.json` 缺失时报告 `MANIFEST_MISSING`，不凭空造一张表。

**`skillsById` 不在本轮范围内**（业主 2026-10-09）：我们没查清它的用途（本仓数据里它是 `{ id: id }` 这种自映射，
522 条与 `skills` 一一对应），所以**故意不开口子**。写了 `art.skillsById` 会被 `ART_UNKNOWN_TABLE` 拒掉 —— 那正是
我们要的：宁可当场说「这张表没有通道」，也不要收下一份没人读的声明。

#### 盟约图集与分队图集（`art.bonds` / `art.bands`）

`assets.json` 的这两张表**值也直接就是路径字符串**（`bonds["yanShip"]` = `/assets/bond/yanShip.png`，
`bands["band_bldsk"]` = `/assets/band/band_bldsk.png`），所以它们同样是 `ART_TABLES` 里的**扁平表**：

```json
"art": {
  "bonds": { "aveMujica": "bond/icon_aveMujica.png" },
  "bands": { "band_wuyouyoumeng": "band/band_wuyouyoumeng.png" }
}
```

| 表 | 落点 | 客户端读它的地方 | 键名 |
|---|---|---|---|
| `bonds` | `data.assets.bonds[<bondId>]` | 盟约条与详情面板的图标 | **`bondId`** |
| `bands` | `data.assets.bands[<bandId>]` | 分队（策略）图标 | **`bandId`** |

**键名必须与消费端一致，写错不会报错**：客户端那两行是
`public/js/ui/assetUrls.js` 的 `bondIconUrl(m, bondId)`（`m.bonds[bondId]`）与 `bandIconUrl(m, bandId)`
（`m.bands[bandId]`）—— 查不到时它们返回 `null`，调用方画自己的兜底（圆点 / CSS 形状），**不回落**到别的图，
也**不回落首字**。所以把 id 挂到 `bond`（单数）上不会「看起来生效」，它只是每一个都查不到：

```jsonc
// 无效：assets.bond 这个键没人读（落点是 assets.bonds）
"art": { "bond": { "aveMujica": "bond/icon.png" } }   // 连带 art.bond 表名本身也被拒：ART_UNKNOWN_TABLE
```

规则与 `skills` / `profSub` 逐字相同：路径相对 `assets/`、无穿越（`ART_PATH_UNSAFE`）、id 字符集同一套
（`ART_BAD_ID`）、URL 走 `/workshop-assets`、官方已有这个 id 时是**替换**（给官方盟约换图）、两个包抢同一个 id 时
**包 id 最小者赢**并点名（`ASSET_COLLISION`）。

**与 `bondIcons` 是同一件事的两个写法 —— 不能同时声明同一个 id。** 两条路最后都写 `assets.bonds[<bondId>]`，
客户端只看得到一条，所以：

| 情形 | 结果 |
|---|---|
| 只在 `art.bonds` 里声明 | 生效（落点 `assets.bonds`） |
| 只在 `bondIcons` 里声明 | 生效（落点同样是 `assets.bonds`，见 §1.4「盟约图标」） |
| **同一个 `bondId` 两处都声明** | **点名拒绝整包**：`BOND_ICON_CONFLICT`。必须自己删掉一份 |
| 两处声明**不同**的 id | 两份都生效，谁也不覆盖谁（各管一个图标） |

为什么是**拒绝**而不是「谁赢」：`mergeWorkshopFlatArt` 排在 `mergeWorkshopBondIcons` 之后，真按顺序判就是
`art.bonds` **静默压掉** `bondIcons` —— 作者改了 `bondIcons` 那一份却发现图标没变，日志一句话都没有。这不是
「两种写法各有取舍」，而是同一个最终值的两个来源，必须由作者自己决定留哪一个。

`art.bands` **没有**对应的历史字段（不存在 `bandIcons`），所以 `bands` 不参与这条互斥判据：一个 id 同时出现在
`bondIcons` 与 `art.bands` 里是两件不相干的事（盟约 vs 分队），两份都生效。

**落点必须先在 `data/assets.json` 里存在**：`assets.bonds` / `assets.bands` 是素材管线的产物（官方那 23 + 40 条），
这两张表**不会被凭空创建** —— 清单里没有那张表时点名报告 `MANIFEST_MISSING`（`id` 是 `art.bonds` / `art.bands`），
让作者去跑 `npm run assets`；这与 `itemIcons` 对 `assets.items` 的规矩一致。`skills` / `profSub` 不受这条约束
（它们本来就没有「官方必有一张表」的前提）。

**启动日志的措辞**：扁平表**按表名逐项汇总** —— `skills +11 (…)`、`bonds +1 (…)`、`bands +1 (…)`，
（原为把四张表折成一句 `N icons`）。改措辞的两个理由：`art.bonds` 是盟约**图集**、不是图标，折进 `icons` 会让
读日志的人去 `assets.skills` 里找一个盟约 id；而「表名 + N」正好是作者能在 `pack.json` 里对照着改的那个名字。
按旧字样 `N icons` 在日志里找工坊包的人，请改看 `<表名> +N`。

### 1.3 数据流

```
data/*.json ──┐
              ├─→ loadData() 内存合并 ─→ deepFreeze ─→ 对局引擎 / 模拟器
workshop/*/ ──┘        （冻结之前）              └─→ /data/<file>.json（合并后）──→ 浏览器
```

两个关键点：

- 合并发生在 `deepFreeze` **之前**，所以下游（对局引擎、`sim`、客户端）看到的仍是一个普通的数据对象，**没有任何下游代码需要知道工坊的存在**。
- 浏览器通过 HTTP 拿到的是**合并后**的对象。被包触及的数据文件由 `buildWorkshopDataFiles()` 生成一份合并 JSON 提供；**没有被打包触及的文件仍然直接读磁盘**，因此正常安装的字节内容完全不变。`data/*.json` 本身永不被改写。

### 1.4 素材与授权

仓库与官方整合包**不含任何游戏素材**（`.gitignore` 已排除 `public/assets/`）。工坊包**可以**自带素材，通道只有一条：

    <pack>/assets/**                     ← 该包自己的美术，放在这个文件夹里
    pack.json 的 license 字段             ← 有 assets/ 就**必须**声明（否则整包被拒）
    客户端从 /workshop-assets/<pack>/<路径> 读取

规则（**已强制**，不只是建议）：

- **有 `assets/` 就必须声明 `license`**：加载器会拒绝该包并给出 `ASSETS_NEED_LICENSE`
  （`tools/workshop-validate.mjs` 会把它报成错误并退出非 0）。素材的二次分发者是**包作者**，风险由其承担，
  所以授权必须写在清单里，而不是靠 README。
- 仓库本身仍然不接受素材文件；官方整合包也不含素材。
- 只有 `assets/` 子树可读：数据、kit、`pack.json` 都**不在**这条路由上。
- 只服务媒体类型（图片/音频/字体/`atlas`/`skel`）。**`.js` 与 `.html` 被排除** ——
  要分发代码请走 `kits/`（那条路由只服务加载器登记过的模块）。

示例包的作法仍值得参考：它**不含素材**，而是复用已有干员的美术 id，只改身份与数值。这也是目前唯一无需分发素材就能让新内容正常渲染的方式（Spine 小人需要 `.skel` + `.atlas` 二进制对）。

#### 语音包（`voices`）

包可以给干员配语音 —— 主要是给**自己新增的助战干员**配，也可以给官方干员补几条：

```json
{
  "id": "my-voice", "license": "CC0-1.0", "content": [],
  "voices": { "char_ws_my_op": { "select": ["voice/select1.mp3", "voice/select2.mp3"], "deploy": ["voice/deploy.mp3"] } }
}
```

| 规则 | 说明 |
|---|---|
| 槽位固定 | `start`（行动出发）`faceEnemy`（行动开始）`select`（选中）`place`（部署）`skill1`–`skill4`（作战中 1-4）`resultFour` / `resultThree` / `resultTwo` / `resultLose`（四种结算）—— 即 `shared/constants.js` 的 `VOICE_SLOTS`，客户端、资产管线与校验器共用同一份词表；写别的槽位会被拒（`VOICE_SLOT_UNKNOWN`） |
| 路径相对 `assets/` | 必须放在该包自己的 `assets/` 里（音频同样受 §1.4 的授权闸门约束：有 `assets/` 就必须声明 `license`）。绝对路径、`..`、`.`、反斜杠与盘符都会被拒（`VOICE_PATH_UNSAFE`） |
| 一个槽位可以多条 | 客户端每次随机挑一条，并避免连续重复 |
| 与官方语音**并存** | 同一干员同一槽位，官方台词在前、包台词在后，一起参与随机；不会替换官方语音 |

**送达方式（不需要新的客户端通道）**：加载时 `applyWorkshop()` 把各包的语音汇成 `assets.audio.voice` 并写入合并后的
`data/assets.json`（`shared/workshop.js` 的 `workshopVoiceIndex` / `mergeWorkshopVoices`），HTTP 层再把该文件**合并后**发给浏览器
——也就是 `public/js/audio.js` 本来就在读的那份清单（`installAudio({ getManifest: () => data.get('assets') })`）。
因此：只要有包带语音，`assets.json` 就进入「被触及的数据文件」集合（`workshopTouchedFiles`），否则浏览器拿到的还是磁盘上的原版。
生成的 URL 就是 §1.4 那条素材通道（`/workshop-assets/<pack>/<路径>`，路径分段做百分号编码，
所以文件名里的 `#`、空格都能正常播放）。安装里没有 `data/assets.json`（没跑过素材管线）时，加载器会在启动日志里报告这件事，
而不是静默丢弃。

玩家侧：官方语音自 0.7.0 起随素材一起下载（`node tools/fetch-assets.mjs`；想要多语言配音加
`--voice-langs=cn,jp,en,kr`），设置里的「干员语音 VOICE」**默认 0.8 = 开** —— 只有玩家把音量调到 0 或勾了静音才听不到。
以上 `voices` 进的是**默认配音**那一档（合并进 `assets.audio.voice`）；要让这个包在别的配音语言下也发声，用下面的 `voiceLangs`。

#### 多语言配音（`voiceLangs`）

同样的表，一个语种一份。玩家在设置里（或干员详情里逐个干员）选了 cn / en / kr 时，听到的就是这里对应的那一句
（默认那一档是**日文**，所以默认台词写在 `voices` 里、用 `jp_` 的文件名）：

```json
{
  "id": "my-voice", "license": "CC0-1.0", "content": [],
  "voices":     { "char_ws_my_op": { "select": ["voice/jp_select.mp3"] } },
  "voiceLangs": {
    "cn": { "char_ws_my_op": { "select": ["voice/cn_select.mp3"], "place": ["voice/cn_place.mp3"] } },
    "kr": { "char_ws_my_op": { "select": ["voice/kr_select.mp3"] } }
  }
}
```

| 规则 | 说明 |
|---|---|
| 语种词表固定 | 键必须是 `shared/constants.js` 的 `VOICE_LANGS`（`cn` / `jp` / `en` / `kr`），写别的会被拒（`VOICE_LANG_UNKNOWN`） |
| **默认语种不能写在这里** | `jp`（即 `DEFAULT_VOICE_LANG`，0.9.0 起就是它，也就是清单 `audio.voiceLang` 指的那一档）必须写在 `voices` 里；写进 `voiceLangs` 会被拒（`VOICE_LANG_DEFAULT`）。同一批台词有两个写法，「客户端到底读哪一份」就成了作者猜不出来的事 |
| 表内规则与 `voices` 完全相同 | 槽位词表、干员 id、路径安全规则逐字相同，错误码也共用（`VOICE_SLOT_UNKNOWN` / `VOICE_PATH_UNSAFE` / `VOICE_BAD_CHAR_ID` / `VOICE_EMPTY`），提示里会带上具体是哪张表（`voiceLangs["cn"]["char_ws_my_op"]["place"]`） |
| 空表被拒 | `voiceLangs: { "cn": {} }` 是 `VOICE_LANG_EMPTY`：声明了语种却一个干员都没有，多半是写错了 |
| **可以只带其它语种** | `content: []` + 只写 `voiceLangs` 是合法的包 —— 这个包只补某个语种，默认配音仍用官方那份 |
| 与官方**并存** | 该语种官方本来就有这个干员的台词时，官方在前、包在后一起参与随机，不替换 |

**送达方式与 `voices` 是同一条路，只差落在哪张表**：`applyWorkshop()` 把默认配音并进 `assets.audio.voice`，
把其它语种并进 `assets.audio.voiceLangs[<lang>]`（`shared/workshop.js` 的 `workshopVoiceIndex` /
`workshopVoiceLangIndex` / `mergeWorkshopVoices`）—— 正是客户端 `public/js/audio.js voiceLinesFor` 按玩家选的
配音语言查的那两张表，所以**播放侧一行代码都不用改**。该语种没有这个干员的条目时，客户端回退到默认配音那一档，
玩家不会因为某个语种缺文件而突然没声音。任何一边非空，`assets.json` 都进「被触及的数据文件」集合
（`workshopTouchedFiles`）；一个语种都没有的包**不会**让清单长出一个空的 `voiceLangs`。

> ⚠️ **音频没有 `art` 表：`art.audio` 会被拒（2026-10-13 实测）。** `data/assets.json` 里那张 `assets.audio`
> 是**生成物**（`tools/assets/audio.mjs` 从官方素材写的），不是 `pack.json` 的一条素材通道 —— 包的音频入口
> **只有** `voices`（默认配音 ⇒ `assets.audio.voice`）与 `voiceLangs`（其它语种 ⇒ `assets.audio.voiceLangs[<lang>]`）
> 这两个顶层字段。`ART_TABLES` 的表名闭集是 `chars` / `enemies` / `tokens` / `skills` / `profSub` / `bonds` /
> `bands`，所以照着清单里的 `assets.audio` 写 `art.audio` 时被点名的码是 **`ART_UNKNOWN_TABLE`**
> （与 `art.weapons`、单数 `art.bond` 逐字同一格，`shared/workshop.js` 的 `parseArtDecl`）——
> **不是** `PACK_UNKNOWN_FIELD`：那个码管的是 `pack.json` 的**顶层键**闭集。判据在
> `test/workshopArt.test.js` 的「每一种写法错误都被拒」那一格。
>
> **表名闭集排在「有没有 `assets/`」之前**（这条顺序本身是诊断性的一部分，2026-10-13 修）：写错表名的包
> **就算没有 `assets/` 目录**，得到的也是 `ART_UNKNOWN_TABLE`，而不会先撞一句「请把文件放进 `assets/`」——
> 后者会把作者支去建一个解决不了问题的目录，真因（这张表不存在）没人说。反过来，**表名写对、只是没建
> `assets/`** 的包照旧报 `ART_NEEDS_ASSETS`（对照：`art: { audio: … }` 且没有 `assets/` ⇒ `ART_UNKNOWN_TABLE`；
> `art: { chars: … }` 且没有 `assets/` ⇒ `ART_NEEDS_ASSETS`）。三面都有判据：`test/workshopArt.test.js` 的拒绝表。

**写这两个字段的图形入口是编辑器的第七个页面 `/voice.html`**（`docs/EDITOR.md` §语音）：先在语言下拉里选要编辑哪一档
（默认配音 = `voices`，或 cn / en / kr = `voiceLangs[<lang>]`），再就地改对应的表；其余字段、键序与缩进原样保留，
并且只接受**包内 `assets/` 下真实存在、且扩展名在服务端媒体白名单里**的文件；它在编辑器里就能试听 ——
用的就是客户端会请求的那个 URL。

#### 盟约图标（`bondIcons`）

客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图，而一个包没法往 `assets.json` 里加条目 —— 于是**新增**的盟约
在盟约条与详情面板上只能是一个圆点。这个字段把这个口子开在 `pack.json` 上（与语音同一套做法）：

```json
{
  "id": "my-icons", "license": "CC0-1.0", "content": [],
  "bondIcons": { "myShip": "bond/myShip.png", "yanShip": "bond/my-yan.png" }
}
```

| 规则 | 说明 |
|---|---|
| 路径相对 `assets/` | 与语音逐字相同（绝对路径、`..`、`.`、反斜杠、盘符都会被拒：`BOND_ICON_PATH_UNSAFE`）；图片同样受 §1.4 的授权闸门约束 |
| id 必须是盟约 id | 字符集 `[A-Za-z0-9_.:-]`（`BOND_ICON_BAD_ID`）。写一个不存在的 id 不会报错，但那张图永远不会被用到 —— 编辑器只允许给**本包真的有的盟约**配图 |
| 覆盖官方 = 换掉官方图标 | 同一个 id 出现在官方 `bonds` 里时这张图**替换**它；新增的 id 直接加进去 |
| 两张图抢同一个 id | 按**包 id 排序**第一个赢，后一个包会在启动日志里得到一条错误（静默覆盖会变成「换个包顺序图标就变了」） |
| **不能与 `art.bonds` 声明同一个 `bondId`** | 两条路最后都写 `assets.bonds[<bondId>]`，客户端只看得到一条 ⇒ 同一个 id 两处都声明是 **`BOND_ICON_CONFLICT`：整包被拒**，必须自己删掉一份。两处声明**不同**的 id 则两份都生效（见 §1.2「盟约图集与分队图集」） |

**送达方式与语音完全一致**：`applyWorkshop()` 把它们并进 `assets.bonds`（`workshopBondIconIndex` /
`mergeWorkshopBondIcons`），`assets.json` 因此进入「被触及的数据文件」集合，URL 走同一条
`/workshop-assets/<pack>/<路径>`（分段百分号编码）。**写这个字段的图形入口是编辑器盟约页的「本包自带的图标」一段**：
它只让你从本包 `assets/` 里**真的存在**的图片里挑，并在保存前就挡掉不存在的文件。

#### 装备图标（`itemIcons`）

同一套做法，给**装备/道具**用。客户端取图不看道具记录 id，而是拿**道具记录自己的 `iconId`、没有才用 `trapId`**
去查 `data/assets.json` 的 `items`（`public/js/assets.js itemIconUrl`）—— 所以一个包新增的装备在商店与手牌上只能
显示兜底图。这个字段让包把图接上去，**键就是那个 id**：

```json
{
  "id": "my-items", "license": "CC0-1.0", "content": ["items"],
  "itemIcons": { "trap_ws_my_item": "item/my-item.png", "trap_ws_my_second": "item/my-second.png" }
}
```

| 规则 | 说明 |
|---|---|
| 键 = 客户端会查的那个 id | 也就是道具记录的 `iconId` 或 `trapId`（`iconId` 优先）。官方清单 `data/assets.json` 的 `items` 表用的就是 trap id（本仓库 59 条），而 `shared/itemAuthoring.js` 的派生规则把新装备的 `iconId` 写成它的 `trapId` —— 所以实际上填的就是那个 trap id。字符集 `[A-Za-z0-9_.:-]`（`ITEM_ICON_BAD_ID`） |
| 路径相对 `assets/` | 与语音、盟约图标逐字相同（`ITEM_ICON_PATH_UNSAFE`）；图片同样受 §1.4 的授权闸门约束 |
| 覆盖官方 = 换掉官方图 | id 已经在官方 `items` 里时这张图**替换**它；新增的 id 直接加进去 |
| 两张图抢同一个 id | 按**包 id 排序**第一个赢，后一个包在启动日志里得到一条错误（与盟约图标同一条规则） |
| 编辑器只让你给**本包真的有的**图标 id 配图 | 键取自当前装备的 `trapId`；改掉某个道具的 `trapId` 之后，留在 `pack.json` 里的旧声明会出现在装备页的「本包已声明的装备图标」清单里（标成「陈旧 / 没人用」）并可以逐条删除 —— **不需要手改清单** |

**送达方式**：`applyWorkshop()` 把它们并进 `assets.items`（`workshopItemIconIndex` / `mergeWorkshopItemIcons`），
URL 走同一条 `/workshop-assets/<pack>/<路径>`，**客户端零改动**（`itemIconUrl` 本来就读那张表）。`assets.json` 里
**没有 `items` 表**时（没跑过素材管线）不凭空造一个，而是在启动日志里报告。图形入口是编辑器装备页的
「本包自带的图标（可选）」一段。

#### 外观素材（`art`）：头像 / 立绘 / 模型

第三条素材通道，也是**唯一能让包新增的干员不再是"一张菱形贴图"**的那条。客户端画单位时，头像与模型都从
`data/assets.json` 取（`public/js/assets.js` 的 `spineEntry` / `avatarUrl` / `portraitUrl`），而包加不了条目 ——
所以新干员/新怪物以前只能复用官方已装好的模型 id。现在可以把文件放进包自己的 `assets/`，按 `assets.json` 里
**对应条目的形状**声明出来：

```json
{
  "id": "my-art", "license": "CC0-1.0", "content": [],
  "art": {
    "chars": {
      "char_ws_my_op": {
        "avatar": "art/my_op_avatar.png",
        "portrait": "art/my_op_portrait.png",
        "spine": { "front": {
          "skel": "art/my_op/my_op.skel", "atlas": "art/my_op/my_op.atlas",
          "textures": ["art/my_op/my_op.png"], "pma": false,
          "anims": { "idle": "Idle", "move": "Move", "attack": "Attack", "skill": "Skill", "die": "Die", "born": "Start" }
        } }
      }
    },
    "enemies": { "enemy_ws_my_thing": { "icon": "art/thing_icon.png", "spine": { "skel": "…", "atlas": "…", "anims": {…} } } },
    "tokens":  { "token_ws_my_thing":  { "avatar": "art/token.png", "owner": "char_ws_my_op" } }
  }
}
```

| 规则 | 说明 |
|---|---|
| 三张对象表，形状照抄官方条目 | `chars` 的 `spine` 是**嵌套**的 `{ front: …, back: … }`；`enemies` / `tokens` 的 `spine` 是**扁平**的。可用的字段就是官方条目里的那几个：`chars` 用 `avatar`/`avatarE2`/`portrait`/`portraitE2`，`enemies` 用 `icon`（另有 `spineAliasOf` 指向别的模型），`tokens` 用 `avatar`（另有 `owner`）。写别的字段会被拒（`ART_UNKNOWN_FIELD`） |
| **另外四张是扁平表** | `skills`（技能图标）、`profSub`（职业分支图标）、`bonds`（盟约图集）、`bands`（分队图集）：条目本身**就是一条路径字符串**（`assets.skills[key]` / `assets.prof.sub[key]` / `assets.bonds[bondId]` / `assets.bands[bandId]` 在官方清单里就是路径）。落点由 `ART_TABLES[表].target` 给出，见 §1.2 那两小节；`skillsById` 没有通道（故意） |
| 路径相对 `assets/` | 与语音、各类图标逐字相同（`ART_PATH_UNSAFE`）；**受 §1.4 的授权闸门约束**（有 `assets/` 就必须声明 `license`） |
| `skel` 与 `atlas` 缺一不可 | `ART_SPINE_INCOMPLETE`。清单里的 `atlas` 我方代码只用来做内存回收，但形状这一层就要求它必须在 —— 见下面第一条硬约束 |
| **字段级合并，不是整条替换** | 官方已有这个 id 时，包只给头像就保留官方模型、只给 `spine.front` 的 `skel`/`atlas` 就保留官方那一侧的 `anims`/`events`（整侧替换会让一个官方模型变成「能出来但不动」，而且一条日志都没有） |
| 两个包抢同一个 `<表>.<id>` | 按**包 id 排序**第一个赢，后一个包在启动日志里得到一条错误（与盟约/装备图标同一条规则） |
| **只带 `art` 的包合法** | `content: []` + `art` 就是一个包：只给某个干员配一张立绘也算 |

**两条包改不了的硬约束**（由 vendor 里的 pixi-spine 决定，写错在客户端**完全不报错**）：

1. **`.atlas` 必须与 `.skel` 同目录同名** —— 加载器是从 `.skel` 的路径推出 `.atlas` 的（`dirname(src) + basename(src, '.skel') + '.atlas'`），清单里的 `atlas` 字段它不读。不同名 → 客户端静默退回菱形贴图。
2. **`.atlas` 里写的每一页 png 必须与它同目录同名** —— 官方 712 个模型里有 2 个是双页（`char_1052_kalts2`），所以不能假设"一个模型一张 png"。

`.skel` 的版本请用 **3.8.x**（本机 712 个模型实测 709 个 `3.8.99` + 3 个 `3.8.84`）。vendor 里的解析器是 uni 构建、理论上也认 3.7/4.0/4.1，但作者侧校验只放行 3.8.x —— 放行别的收益为零、风险最高。

**作者侧校验（`node tools/workshop-validate.mjs workshop`）是这条通道的安全网**：文件在不在、扩展名能不能服务、atlas 是否与 skel 同名同目录、atlas 里每一页 png 是否真的存在、skel 版本、`anims` 缺不缺、动画名在骨架里是否存在、atlas 有没有 `size:` 行 —— 客户端在这些情况下一律静默，只有校验器会说话。
其中「缺 `anims`」**分两种严重度**：给一个**新 id** 配模型时缺 `anims` 是**错误**（客户端的 `validSpine` 要求 `anims` 是个对象，缺了它这个模型根本不会被采用，只会画成贴图）；覆盖**官方已有** id 时只是**警告**（字段级合并会把官方那条的 `anims`/`events` 留着，模型照常会动）。

**送达方式**：`applyWorkshop()` 把它们并进 `assets.chars` / `assets.enemies` / `assets.tokens`
（`workshopArtIndex` / `mergeWorkshopArt`），URL 走同一条 `/workshop-assets/<pack>/<路径>`，**客户端零改动**
（`validSpine` 只要求 skel 是 `/` 开头的路径，包素材 URL 天然满足）。`assets.json` 不存在时报告出来，不凭空造。
一个附带好处：包把模型接上之后，启动日志里那条「这个干员没有模型（会画成贴图）」的警告会**自动消失**
（`mergeWorkshopArt` 必须排在 `chessLookIssues` 之前，否则日志会一直报一条已经解决的问题）。

### 1.5 分享与安装一个包

在此之前，一个包**只能靠手抄目录**交给别人。现在有一个 `.zip` 通道，CLI 与编辑器第八页
（`/pack.html`，见 `docs/EDITOR.md` §包管理）用的是同一批函数（`tools/workshop-pack.mjs`）：

```powershell
node tools/workshop-pack.mjs export my-pack                 # → ./my-pack.zip
node tools/workshop-pack.mjs export my-pack --out D:\share\my-pack.zip
node tools/workshop-pack.mjs import D:\share\my-pack.zip    # 装到 workshop/my-pack/
node tools/workshop-pack.mjs import other.zip --force       # 覆盖同名包（默认拒绝）
node tools/workshop-pack.mjs list                           # 每个包一行：id/名称/版本/内容/语音/助战
```

**zip 布局**：`pack.json` 与包内其它文件（**包括 `assets/**`**）都在 **zip 根**，一个目录层级都不多 ——
也就是「这个 zip 就是这个包」。导入时也接受常见的那一种变体：整个包在一个**唯一的顶层目录**里
（`my-pack-1.0.0/pack.json`），那层目录会被去掉。

**所以「这个包有哪些文件」= 这个目录里的每一个普通文件**（DESIGN §28.2 业主裁决 B，2026-10-11）：包的身份哈希
覆盖包目录下的全部普通文件，而那一份清单**同时就是**客户端下载清单（`GET /mods/catalog.json`）—— 没有任何按
名字或目录的排除项，`README.md` / `test/**` / `*.bak` / 点文件也一样。理由是：**被声明的模块可以 `import` 同目录
的兄弟文件、可以在运行时读一个数据文件**（`server/rules.mjs`、`data/rules.mjs`、`client/helper.js` 都真的发生过），
所以「这个包会执行/读到哪些文件」除了"一整个目录"以外没有可判定的答案。作者要自己承担两件事：

- **别把不该分发的东西留在包目录里**：编辑器备份、构建产物、`node_modules/`、`.git/` 都会进身份、也会被每个装了
  这个包的客户端下载（改一个 README 就是一个新摘要，房间的摘要闸门会要求客户端重新对齐）；
- **别指望"没被声明就不算"**：清单是目录，不是声明。

| 规则 | 为什么 |
|---|---|
| 条目按名字排序、DOS 时间戳固定、deflate（压不动就退回 store） | 同样的内容永远得到同样的字节：作者能核对哈希，分发物可复现 |
| 导入先解压到**临时目录**、校验清单、再整个搬进 `workshop/<packId>/` | 坏归档、恶意归档、校验不过的包都**不会**在 `workshop/` 里留下半个包 |
| 清单用 `shared/workshop.js` 的 `normalizePackManifest` 校验（与加载器同一个函数） | 「装得上」就等于「加载器会接受它的格式」，不会有第二套判断 |
| 一切写入都在 `workshop/<packId>/` 之内，**绝无例外** | 归档是别人给的文件：zip 读取器先拒一次遍历名，解压路径再拒一次 |
| 默认**拒绝**覆盖已存在的包（`--force` / `?force=1` 才覆盖） | 一个误点不该毁掉作者自己的包 |
| 读取器拒绝 ZIP64、加密、非 0/8 压缩方法、多卷、重名、CRC 不符、超上限的条目 | 猜一个畸形归档的结构比拒绝它更危险 |

**名字的编码不构成拒绝理由**（`shared/zip.js decodeEntryName`，`test/zip.test.js` 钉着）：ZIP 只有一个「这个文件名是
UTF-8」的位（bit 11），而 **Windows 上的 `tar` / 资源管理器写中文名时用的是本地码页（GBK）且常常不置这一位** ——
玩家自己解压时也是按 GBK 解的。所以读取器按 ZIP 自己的规矩分三种情况：

| 情况 | 处理 |
|---|---|
| bit 11 置位 | 按严格 UTF-8 解；字节不合法 ⇒ **拒**（头承诺了 UTF-8，承诺坏了就是坏归档） |
| 未置位、有 Info-ZIP **Unicode Path extra field（0x7075）** | 用它里面的 UTF-8 名字（与头里名字的 CRC 对上才认） |
| 未置位、没有那个字段 | 先按严格 UTF-8、再按 **GBK**；**两种都解不出来才拒**（例如 `0xFF`） |

所以「包里有中文文件夹」不会让导入失败。**安全判据一个字没放松**：解出来的名字照样过同一条规则（穿越 / 绝对路径 /
反斜杠 / 空段一律拒），所以宽松解码不会变成「写文件跑到包目录外面」。同一份解码器也被更新包读取器
（`tools/package-update.mjs`）使用 —— 这条规则曾经只长在更新器里，而包导入那条路没有，于是同一个中文名 zip
「更新得了、导入不了」。

装好的包要**重启游戏服务器**才会出现在游戏里。`pack.json.support`（§2.1）在编辑器第八页有图形入口：
勾选本包自己新增的干员，阶由记录推导，页面不接受手输的阶。

### 1.6 作者接口（面向人，也面向 AI）

手写 `data/chess.json` 形状的记录需要约 30 个字段，其中大部分是机械的。作者层把这部分推导掉：

| 组件 | 作用 |
|---|---|
| `shared/chessAuthoring.js` | `deriveChessRecord(spec)`：从「名字 / 阶 / 职业 / 普通与精锐两套数值 / 技能文字 / 模组」推导出合法的普通+精锐记录对；`validateChessRecord(rec)` 返回**机器可读**的 `{ field, code, message, hint }[]`（不抛异常、不半途停止） |
| `tools/workshop-scaffold.mjs` | `spec.json` → 写入 `<pack>/chess.json`（合并已有内容，必要时补 `pack.json`） |
| `tools/workshop-validate.mjs` | 分层校验：**格式 → 记录语义 → 真实引擎**（是否进商店池、能否解析出精英、模拟器能否构建 unit def），再按内容种类各一层（kits / 地图 / 怪物 / 出怪 / 装备）。`--json` 输出机器可读报告 |
| `docs/prompts/operator-pack.md` | **模板 prompt**：连同技能文字描述与普通/精锐数值一起丢给任意 AI，即可产出可用干员 |
| `docs/examples/operator-spec.json` | spec 示例（可直接改） |

关键设计：**只用声明式黑板书键就能做出可战斗的干员**。通用 kit（`server/sim/content/generic.js`）会读一组固定的键并自动生成行为，
`GENERIC_BB_KEYS` 镜像了这组键（`test/chessAuthoring.test.js` 有漂移守卫）。键名可写 `k`、`attack@k`、`skill@k` 三种形式。
因此校验器最能救命的一条是 `BB_UNKNOWN_KEY`：**用了通用 kit 不认的键不会报错，但也不会有任何效果** —— 校验器会警告，
这正好是「该技能需要行为层脚本」的信号（见 §4）。

**职业名陷阱（曾导致 88/266 条官方记录被校验器拒绝）**：本项目数据用的职业名是
`WARRIOR` `SNIPER` `CASTER` `MEDIC` `SUPPORT` **`TANK`（重装）** **`SPECIAL`（特种）** **`PIONEER`（先锋）** ——
**不是**通用职业名 `DEFENDER` / `SPECIALIST` / `VANGUARD`。写通用名会被拒绝；若被某处接受，该干员的职业加成会静默全部失效。
`test/chessAuthoring.test.js` 现在把 `PROFESSIONS` 钉死在 `data/chess.json` 实际的职业集合上（漂移守卫）。

**拼写例外（`BB_SPELLING`）**：多数键可写 `k` / `attack@k` / `skill@k`，但有三个只能按一种写法 ——
`range_radius` 只能是 `attack@range_radius`，`duration` 与 `aoe_cd` 只能不带前缀。写错不会报错、只会静默失效，
所以校验器会给出 `BB_SPELLING` 警告。

```powershell
node tools/workshop-scaffold.mjs docs/examples/operator-spec.json --pack my-pack
node tools/workshop-validate.mjs my-pack
```

### 1.7 当前状态

| 部分 | 状态 |
|---|---|
| 包发现、格式校验、叠加合并、失败关闭 | ✅ 已实现 |
| **冲突裁决（谁赢）与归因**：所有面按包 id 字典序，报告点名占位的包 | ✅ 已实现（契约写在 §1.2，`test/workshop.test.js` 钉住「五个面算出同一个赢家」） |
| 合并数据送达浏览器（HTTP） | ✅ 已实现 |
| 新干员进入商店池、被购买、部署、真实战斗、精英/模组解析 | ✅ 已验证（`test/workshop.test.js`） |
| **干员模组（`modules`）**：spec → 精锐记录的 `modules[]`（数值加成 / 特性覆盖 / 天赋改写），且模板往返逐字节保真 | ✅ 已完成（`shared/chessAuthoring.js`、`test/chessModules.test.js`、编辑器干员页的模组块） |
| **攻击分类的覆盖**：`dmgType` / `attackKind` / `projectile` / `canHitFly` 可显式钉住（默认仍按职业与分支推导，覆盖时校验给 `CLASS_OVERRIDE` 警告） | ✅ 已完成（`shared/chessAuthoring.js`） |
| **干员的盟约归属**：干员页勾选官方 23 条与本包自写的盟约，写进该干员记录的 `bonds`（成员由此推导） | ✅ 已完成（`editor/ui/app.js`） |
| **地图（stages）**：推导 + 校验 + 2D 摆放器 | ✅ 已完成（`test/stageAuthoring.test.js`、`editor/ui/stage.html`、`tools/workshop-scaffold.mjs`） |
| **怪物（enemies）**：`be`/`attrPower` 推导 + 校验 + 编辑器表单 | ✅ 已完成（`test/enemyAuthoring.test.js`、`editor/ui/enemy.html`） |
| **出怪表（waves）**：`totalCount`/`slotCounts` 推导 + 校验 + 时间轴 | ✅ 已完成（`test/waveAuthoring.test.js`、`editor/ui/wave.html`） |
| **装备（items）**：`params`/`mergeable`/`shopExcluded` 推导 + 校验 + 编辑器表单 | ✅ 已完成（`test/itemAuthoring.test.js`、`editor/ui/item.html`） |
| **盟约（bonds）**：新增一条盟约、或覆盖官方 23 条的阈值 / 计数 / 说明 / 黑板数值；成员由干员的 `bonds` 推导 | ✅ 已完成（`shared/bondAuthoring.js`、`test/bondAuthoring.test.js`、`test/bondEditor.test.js`、`editor/ui/bond.html`） |
| **盟约的通用加成（`genericBuffs`）**：新增盟约在战斗里按黑板数值给成员加百分比 | ✅ 已完成（`server/sim/content/bonds/dataDriven.js`、`test/content/workshopBond.test.js`） |
| **盟约图标（`pack.json.bondIcons`）**：包自带图标并进 `assets.bonds`，走 `/workshop-assets` 送达客户端 | ✅ 已完成（`shared/workshop.js`、`test/workshopBondIcons.test.js`） |
| **行为层 kit 的创作 prompt**：`docs/prompts/kit.md`（钩子词表 + 可跑示例，示例被测试真的执行） | ✅ 已完成（`test/kitPrompt.test.js`） |
| **作者接口**：spec → 合法记录、机器可读校验、模板 prompt、校验 CLI | ✅ 已实现（`test/chessAuthoring.test.js`） |
| **行为层**：包内 `kits/<chessId>.js` 接入 `battle.on(...)` 钩子总线 | ✅ 已实现（见 §4） |
| **语音包（`voices`）**：汇总进 `assets.audio.voice`、随合并的 `assets.json` 送达客户端 | ✅ 已实现（`test/workshopVoices.test.js`） |
| **多语言语音包（`voiceLangs`）**：其它语种汇总进 `assets.audio.voiceLangs[<lang>]`，玩家选的配音语言直接生效 | ✅ 已实现（`test/workshopVoices.test.js`） |
| **盟约图标（`bondIcons`）**：汇总进 `assets.bonds`、随合并的 `assets.json` 送达客户端（只带图标的包也合法） | ✅ 已实现（`test/workshopBondIcons.test.js`） |
| **装备图标（`itemIcons`）**：汇总进 `assets.items`、随合并的 `assets.json` 送达客户端（客户端零改动） | ✅ 已实现（`test/workshopItemIcons.test.js`） |
| **外观素材（`art`）**：头像 / 立绘 / spine 模型汇总进 `assets.chars` / `assets.enemies` / `assets.tokens`，包新增的干员不再是菱形贴图 | ✅ 已实现（`test/workshopArt.test.js`） |
| **技能图标与分支图标（`art.skills` / `art.profSub`）**：两张扁平表汇总进 `assets.skills` / `assets.prof.sub`，走同一条 `/workshop-assets` 路由 | ✅ 已实现（`test/workshopOperators.test.js`） |
| **盟约图集与分队图集（`art.bonds` / `art.bands`）**：两张扁平表汇总进 `assets.bonds` / `assets.bands`（客户端 `bondIconUrl` / `bandIconUrl` 零改动）；与 `bondIcons` 声明同一个 `bondId` 时整包被拒（`BOND_ICON_CONFLICT`）；落点不存在时报 `MANIFEST_MISSING`，不凭空造表 | ✅ 已实现（`test/workshopArtTables.test.js`） |
| **时装（`skins`）**：一套外观的**数据**（一套一个 `art`，一名干员可以有好几套）按干员分组合并进 `assets.skins`；**哪一套生效**由一个注册了的外观提供者（C 层面板 `appearance(ctx)`）决定，玩家可以用设置里的「工坊外观」整个关掉（默认开） | ✅ 已实现（`test/workshopSkins.test.js`、`test/ui/portraitChain.test.js`；设计 §28.28 / §1.17）。⚠️ 只装数据包不会有画面变化 —— 还需要那个提供者 |
| **形态（`forms`）**：包自带的干员 / 怪物声明自己的形态（clip set），并进 `assets.modForms` 后由 `formsFor()` 折进第一方 `FORMS`（**第一方优先**，包只做增量） | ✅ 已实现（`test/packForms.test.js`；设计 §28.29 / §1.19） |
| **静态相位（`fx.silentPhases`）**：包声明哪几个 `'phase'` 种类不放通用特效，并进 `assets.silentPhases`，与第一方 `SILENT_PHASES` 取并集 | ✅ 已实现（`test/packForms.test.js`；设计 §28.29 / §1.19） |
| **新增一个干员（`content: ["units"]`）**：干员记录并进 `data.backups.units`，形状只查「下游用得上吗」 | ✅ 已实现（`test/workshopOperators.test.js`、`docs/examples/clementia-pack/`） |
| **自选池声明（`pack.json.operators`）**：进 `diy.ownedPool` / `diy.operators`；四条拒绝规则（`OPERATOR_NO_UNIT` / `OPERATOR_NOT_SIX` / `OPERATOR_BOND_UNKNOWN` / `OPERATOR_FORM_MISSING`）失败关闭 | ✅ 已实现（`test/workshopOperators.test.js`、编辑器包管理页） |
| **「新建一个干员」的编辑器表单** | ⛔ 不在本轮（业主未裁定；干员记录目前只能手写 `units.json`，或由干员页的机制产出） |
| **包 kit 的 import 权利（`KIT_IMPORT`）** | ⛔ 未裁定：本轮之后，克莱门莎的 kit 仍然只能用就地补丁（`test/modSurface.test.js` 那条「判罚稳定」的测试是留给这次裁决的锚点） |
| **包自带助战（`support`）**：按记录推导阶并入 `data/support.json` 的卡池、随合并的 `support.json` 送达客户端 | ✅ 已实现（`test/workshopSupport.test.js`） |
| **分享与安装（`.zip`）**：导出/导入/列出，CLI 与编辑器第八页共用同一批函数 | ✅ 已实现（`shared/zip.js`、`tools/workshop-pack.mjs`、`test/workshopPack.test.js`） |
| **局外编辑器 UI**：干员 / 地图 / 怪物 / 出怪 / 装备 / **盟约** / 行为层 kit / **语音** / **包管理** 九个页面 | ✅ 已实现（`editor/`，见 `docs/EDITOR.md`） |
| 工坊包的版本对齐、依赖声明、内容寻址 | ⛔ 未实现（`gameVersion` 目前只是元信息） |

> 行为层是用户的明确选择（「完全开放 battle 钩子 API」）。它与一体化整合包的冲突按**分渠道**解决：官方整合包保持纯净、不含工坊内容；工坊包单独分发，玩家主动安装并知情。**注意：脚本会在客户端执行**（默认 `SP_COMBAT=client`），服务端 `SP_VERIFY` 只能复算结果、不能阻止脚本本身 — 这正是必须分渠道的原因。

### 1.8 盟约（`bonds`）与「通用加成」

盟约是可以被工坊贡献的数据文件之一（`content: ["bonds"]`），编辑器第六页（`/bond.html`）是它的图形入口。两件事必须说清：

- **覆盖官方盟约是主要用法**：官方 23 条盟约的效果在 `server/sim/content/bonds/*` 里**按 id 写死**，但它们的数值全部从
  `data/bonds.json` 的记录里读（阈值、`bb` 黑板、`countMode`…）。所以把 `yanShip` 写进 `overrides` 并给出自己的记录，
  改的就是**真实生效**的数值 —— 这正是「修改盟约」的落地方式，编辑器保存时自动补 `overrides` 声明。
- **新增盟约需要打开 `genericBuffs`**：新 id 没有处理器，记录里写 `"genericBuffs": true` 才会走
  `server/sim/content/bonds/dataDriven.js`，按 `bb` 的 `base_atk` / `atk_per_stack`（防御 `base_def` / `def_per_stack`、
  生命 `base_max_hp` / `max_hp_per_stack`）给成员加百分比，与官方盟约同一个「直接乘算」桶（相加而非相乘）。
  不打开时这条盟约只有数据面：计数、阈值、层数、本局禁用抽签、干员详情与盟约条都正常，但战斗里不加任何东西。
  用记录上的开关而不是「不在官方 23 条里就自动生效」，是因为后者会把**覆盖**官方盟约的黑板叠加两次 —— 双倍加成不会
  报错，只会让平衡悄悄歪掉。
- **成员是干员说了算**：`members` 由干员的 `bonds` 列表推导（`bondEditor` 的成员那一段改的就是那些干员的 spec）。
  引擎计数、盟约弹窗的成员列表都读这个列表；一份「盟约说自己是这群人、干员却不认」的记录会安静地少人。
  **干员页也有盟约勾选**（`docs/EDITOR.md` 的「干员编辑器（首页）」一节）：官方 23 条 + 本包自己写的盟约都在那里，
  勾选即写进该干员的 `bonds`，模板带过来的官方盟约默认勾着 —— 查不到的 id 界面会当场指出来（能保存，但游戏里不会有任何效果）。
- **图标**：客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图（`public/js/assets.js bondIconUrl`）。
  新增盟约原本只能是一个圆点，现在**包可以自带图标**：`pack.json` 写
  `"bondIcons": { "<bondId>": "<包内相对 assets/ 的路径>" }`，装载时叠加层把它并进 `assets.bonds`，
  URL 走 `/workshop-assets` 那条包素材路由（与语音同一条路，客户端不需要任何改动）。覆盖官方盟约时这张图会
  **替换**官方图标；两张图抢同一个 id 时按包 id 排序第一个赢，并给后一个包报一条错误。
  写这个字段的图形入口是编辑器的盟约页（§「本包自带的图标」一段）。

### 1.9 中间层能力声明：`assets` / `client` / `server` / `routes`

这四组字段是给「包不只是数据」这件事开的口子：一个包可以说它要一个客户端资源容器、一个挂载点、一个分发前准入钩子、
一条只读路由。**A 段只做格式**：解析形状、点名拒绝、把声明并进身份哈希；**B1 段把其中两组落成行为** ——
`server.preDispatch` 的钩子真的挂在分发路径上（§1.9.1），`routes` 的只读路由真的被服务（§1.9.2）；**B2 段把
`client` 落成行为** —— 包内的面板模块真的被送到浏览器并挂上十个宿主（四个浮层 + 六个既有组件里的宿主，见 §1.9.3），而「声明了却用不了的声明」从此
**拒绝整个包**（§1.9.3 末尾的那条纪律）；**B3a 段把最后那一组 `assets` 落成服务端行为** —— 容器与清单在
`/workshop-resources/` 上被服务（流式，不整读进内存）、`verify` 按声明校验容器、`serverPolicy` 决定 `/assets` /
`/fonts` 还回不回（§1.9.4），并且**把 B1 的 `server.preDispatch` 对齐到同一条纪律**（声明不可用 ⇒ 整包拒绝）。
**Service Worker（客户端读到容器之后做什么）不在本段**：它等业主对「包能不能注册根作用域 SW」的裁决。

**为什么需要它们**：一个第三方「完整资源包导入 / 校验 / 服务端准入」的 mod 改写成本仓库的包格式之后，在 A 层
**什么都不贡献**（没有干员/装备/怪物/地图/语音/美术），而旧 schema 没有地方表达这四件事，所以真校验器两边都判它
`EMPTY_PACK`。缺口与逐字理由写在 `_up/mod4-pack/pack/README.md` §4，实测判罚在
`_up/mod4-pack/pack/validator-verdict.json`。

#### 四组字段的形状（+ `i18n`，B5 段）

| 字段 | 形状 | 要点 |
|---|---|---|
| `assets` | `{ container, manifest, serverPolicy?, verify? }` | `container` 是包内相对路径、必须以 `.spresources` 结尾（`tools/make-spresources.mjs` 的产物）；`manifest` 是包内相对路径、必须 `.json`（客户端要验的扁平文件表）；`serverPolicy` 缺省 `"serve"`，可选 `"cache-only"`（后者让服务器对 `/assets`、`/fonts` 回 412，见 §1.9.4）；`verify` 缺省 `"sha256"`，按旁挂 `<container>.sha256` 校验 |
| `client` | `{ panels: [{ id, slot, module, order?, gate?, styles?, data?, messages?, wraps? }], requires?, theme? }` | 面板按 `id` 排序后才进清单；`module` 是包内相对路径，**不是 URL**；`slot` 是闭枚举的十个宿主（四个浮层 + 六个既有组件里的宿主，见 §1.9.3）；`styles` 是这个面板自带的 `.css`、`data` 是它要读的数据表、`messages` 是它要收发的**包通道**（四者见 §1.9.3 的数据口 / §1.9.5 / §1.9.6）；`wraps` 是它要**包裹 / 替换**的引擎具名组件（见 §1.9.7）；`requires` 只能取 `serviceWorker` / `cacheStorage` / `webCrypto` —— 缺一即「浏览器不支持」，不是「装了但静默不工作」；`theme.vars` 是包写的 CSS 变量（见 §1.9.5） |
| `server` | `{ preDispatch: { module, policy, intercepts } }` | `module` 必须 `.mjs`（服务端加载，浏览器不加载）；`policy` 必须 `.json`；`intercepts` 每一项**必须**存在于 `shared/protocol.js C2S`（从协议反推，不在这里另抄一份名单 —— 抄一份就是第二个会漂移的真相） |
| `routes` | `[{ path, file, cache? }]` | `path` 是 `/` 开头的绝对 HTTP 路径；`file` 是包内相对路径且必须 `.json`（`.js` / `.html` 一律不在此通道：那是代码执行面）；`cache` 缺省 `"no-cache"`，可选 `"no-store"` / `"public"` |
| `i18n` | `{ "<语种>": "<包内相对 .json>" }` | 给**已有语种**（`en` / `ja` / `ko` / `zh-TW` …）补界面词条；语种码必须是常用大小写、不能是源语言 `zh`；文件里是 `{ "<中文 msgid>": "<译文>" }`。**已有键绝不覆盖**、冲突点名报告 —— 见 **§1.10** |

四条纪律，与本仓库其它字段逐字相同：

- **未知键一律点名拒绝**，不静默丢弃。一个把 `container` 写成 `containers` 的包如果只是被忽略，作者看到的是
  「包合法、但资源没生效」—— 这正是这个缺口要修的那类静默失败。
- **路径必须是包内相对路径**：绝对路径、`..`、盘符一律拒。声明是身份的一部分，一条指向包外的路径会把「这段行为
  来自哪个包」从身份里抹掉（DESIGN §28.2）。
- **键序与列表次序归一化**：面板按 `id` 排序、`intercepts` 去重排序、`requires` 按闭枚举次序 —— 键序是清单字节的
  一部分，不能随作者书写顺序变。
- **空声明不算贡献**：`routes: []` 与不声明没有区别。反向的那条同样载重：`assets` 与
  `server.preDispatch` 的必填字段在形状层就各自非空，所以它们只声明出来**就是**贡献项（一个只声明 `assets` 的包
  不再是 `EMPTY_PACK`）。`api` **不是**贡献项，与 `playtest` 同一类。

#### `EMPTY_PACK` 的语义（本刀落死）

| 声明 | 算贡献项吗 |
|---|---|
| `content` 里任一文件 / `voices` / `voiceLangs` / `bondIcons` / `itemIcons` / `art` / `skins` / `operators` | **算**（旧语义，一字未改；`skins` 见 §1.17） |
| `assets` / `client`（至少一个面板）/ `server.preDispatch` / `routes`（至少一条） | **算**（A 段新增；一个只声明它们的包是合法包） |
| `i18n`（至少一个语种） | **算**（B5 段；一个只给已有语种补词条的包是合法包，见 §1.10） |
| `routes: []`、空的 `client.panels`、空的 `i18n`、`playtest`、`api`、`support` | **不算** —— 什么都没带来，照旧 `EMPTY_PACK` |

`support` 在这一行里是**最容易踩**的一条：它只决定助战**卡池**里放谁，干员本体由 `content: ["chess"]` 带进来。
一个只写 `"support": ["chess_ws_x"]`、`content: []` 的包会被 `EMPTY_PACK` 拒，理由里会**点名 `support` 不是贡献项**
（B5 段补的措辞：原来的文案只列了合法贡献项，没有提到 `support`，作者只能对着 `EMPTY_PACK` 猜）。
`EMPTY_PACK` 的**语义一个字都没放宽** —— 改的只是它把话说清楚。

「只带 `playtest` 的包照旧被拒」是既有裁决（`test/playtestDirectToHand.test.js` 钉着它），本刀**没有**为了让谁的
测试变绿而放松任何断言 —— `test/packAssets.test.js` 里有同一断言的对照用例。

#### 身份哈希：缺省不变，声明进去（DESIGN §28.2）

能改变一端行为的声明必须在内容哈希里，否则同一个摘要下就有两种行为。做法是**只在清单真的写了这个键时**才把归一化
后的声明放进归一化清单（`identifyPack` 哈希的就是那份清单的 `canonicalJson`）：

- **没声明这些字段的包**：归一化清单里**不得**多出这四个键，于是内容哈希逐字节不变 —— 否则所有已存在的包摘要都会
  变，房间的摘要闸门（`modSetOf` / `welcome.mods.digest`）会开始误判。实测：`docs/examples/` 三份示例包在
  `450e9ea` 与本刀之后的哈希**完全相同**（`96ebc2d4…` clementia / `15092019…` demo-workshop / `77b80c6e…`
  kit-demo，`test/packAssets.test.js` 钉住这三个值）。
- **声明了的包**：新哈希随声明改变，并顺着 `modSetOf` 传到线摘要。

#### `api`：声明了才比对

`pack.json.api` 是**模组 API 区间**（钩子总线与 kit 契约的版本），与 `shared/constants.js MOD_API_VERSION` 比对
（DESIGN §28.5）。规则只有一条：**包声明了 `api` 才比对** —— 没声明的包（今天所有的包）一个字节都不受影响；声明了
而区间不含本 build，整个包被拒（`MOD_API_INCOMPATIBLE`，理由里写出声明的区间与本 build 的号）。写成坏区间照旧是
`BAD_API_RANGE`（先判语法，再判区间）。A 段**只**加了那个常量与这一条判罚，没有别的东西读它。

**写成非字符串会被点名拒绝**（B7 段）。`"api": 1`（JSON 数字）、`true`、`["1.x"]`、`{ range: "1.x" }` 一律整包被拒：

| 键 | 非字符串时的拒绝码 |
|---|---|
| `api` | `BAD_API_TYPE` |
| `game` / `gameVersion` | `BAD_GAME_TYPE`（别名与主名同一条判罚，理由里点名**是哪一个键**写坏了） |

这条判罚的落点与「写了等于没写」是同一处：三个键的解析以前只有 `strField` 一个人，而它把非字符串读成 `null`，
于是 `api: 1` 在 `api &&` 的两条校验里都短路、归一化结果 `api: null` —— 包当没声明一样通过，作者看到的是
「包合法、我写的区间没生效」。**失败方向是静默的**，所以这里当场拒绝。三条边界：

- **缺键照旧一个字节都不受影响**：`api` / `game` / `gameVersion` 全缺的包不进任何新分支，归一化清单不多出键、
  身份哈希与今天逐字相同（`test/workshopDeclTypes.test.js` 钉住一个缺键包的身份哈希）。
- **`null` 与省略同一后果，不是错误**：仓库既有语义是「`null` = 没有这个键」—— 编辑器写元数据那一端把 `null`
  当「删掉这个键」（`packMetaEditor.test.js`：`description: null` ⇒ `!Object.hasOwn(obj, 'description')`），
  `layer` 的解析分支对 `undefined || null` 逐字相同。空串与纯空白同理（`""` / `"   "` 只是把键写成了空的）。
- **类型先于语法**：`api: 1` 报的是 `BAD_API_TYPE`，不是 `BAD_API_RANGE` —— 把它报成「坏区间」会把作者引到错的
  地方。`game` 写坏而 `gameVersion` 合法时**仍然是错**：一个被别名盖住的坏键只是被盖住，不是没事。

#### 当前状态（A 段 + B1 段 + B2 段 + B3a 段 + B4 段 + B5 段）

| 部分 | 状态 |
|---|---|
| 四组字段的形状、点名拒绝、进身份哈希 | ✅ 已实现（`shared/workshop.js`，`test/packAssets.test.js`） |
| `MOD_API_VERSION` + 「声明了才比对」 | ✅ 已实现（`shared/constants.js`、`shared/workshop.js`） |
| 作者向字段表与本文档 §1.9 | ✅ 已更新 |
| 编辑器里的图形入口 | ⛔ 本轮无（与 §1.1 那句「每个字段都有图形入口」的例外就是这四组 + `api`） |
| 分发前钩子被挂上、能拦消息 | ✅ 已实现（B1：`server/workshop.js loadWorkshopHooks`、`server/modDispatch.js`、`server/net.js`；`test/modPreDispatch.test.js`） |
| `resource.*` 三个 `C2S` 类型 | ✅ 已实现（B1：`shared/protocol.js`；`PROTOCOL_VERSION` 仍是 1） |
| 只读路由被注册、被服务 | ✅ 已实现（B1：`server/http/workshop.js workshopRoutesFor`、`server/http/static.js`；`test/modRoutes.test.js`） |
| C 层面板被注册、被挂载（模块路由 + `welcome.modPanels` + 十个宿主（四个浮层 + 六个既有组件里的宿主，见 §1.9.3） + `order`/`gate`/`requires`） | ✅ 已实现（B2：`server/workshop.js loadWorkshopPanels`、`server/http/workshop.js workshopPanelFilesFor`、`public/js/ui/extensions.js`、`server/lobby.js welcomeInfo`；`test/modClientPanels.test.js`） |
| **组件级改写**（`client.panels[].wraps`：包裹 / 替换一个具名引擎组件，链按 §28.3 次序合成） | ✅ 已实现（DESIGN §28.19：`shared/workshop.js` 的闭枚举 + `public/js/ui/modComponents.js` + `extensions.js` 的注册与失败隔离；`test/modPanelWraps.test.js`） |
| `assets` 的容器与清单被服务（`/workshop-resources/`，流式、只服务注册过的 URL、`?v=` 缓存键） | ✅ 已实现（B3a：`server/workshop.js assetsIssues`、`server/http/workshop.js workshopResourceFilesFor`、`server/http/static.js`；`test/modAssets.test.js`） |
| `serverPolicy`：`serve`（缺省）/ `cache-only`（`/assets`、`/fonts` 回 412 且不回源） | ✅ 已实现（B3a：`server/http/workshop.js resourceServerPolicy`、`server/http/static.js`；只在包显式声明时生效） |
| `verify`：按声明校验容器，失败明示 | ✅ 已实现（B3a：`server/workshop.js assetsIssues` + 旁挂 `<container>.sha256`；`ASSETS_VERIFY_FAILED` / `ASSETS_VERIFY_UNAVAILABLE`） |
| 目录逃逸 / 非 `.js` / 声明了却没有文件的模块 ⇒ **整包被拒** | ✅ 已实现（B2：`server/workshop.js panelModuleIssues` + `shared/workshop.js` 的 `.js` 判据；DESIGN §28.13.3） |
| 声明了却没有的容器/清单、摘要对不上、`server.preDispatch` 的文件不在 ⇒ **整包被拒** | ✅ 已实现（B3a：`server/workshop.js assetsIssues` / `preDispatchIssues`，在 `loadWorkshop` 列出包之前；DESIGN §28.13.3） |
| Service Worker（引擎自带、包只声明） | ✅ 已实现（B4：`public/resource-sw.js` + `public/js/resources/**`；注册口径与流程的纯逻辑在 `test/modAssets.test.js` 里钉住） |
| 客户端资源流程（取清单 → 容器导入 → 逐文件校验 → 写缓存 → 索引/收据 → 深浅校验） | ✅ 已实现（B4：`public/js/resources/{host,bundle,verify,service}.js`；Node 里用假 `CacheStorage` + 真 `Response`/`crypto.subtle` 真跑） |
| `welcome.modAssets` 的条件性（不声明 ⇒ 无字段、无请求、无 DOM、无全局） | ✅ 已实现（B4：`server/http/workshop.js workshopModAssetsFrom`、`server/lobby.js welcomeInfo`、`public/js/main.js` 的动态 import） |
| 容器摘要进身份哈希（同一房间摘要 ⇒ 同一份容器） | ✅ 已实现（B4：`server/workshop.js identifyPack` 的 `assets.container.sha256` 那一条；不声明 `assets` 的包逐字节不变） |
| `server.preDispatch` 的最后一格（import 失败 / 没有工厂导出 / 模块的 `validatePolicy` 拒绝策略 ⇒ 整包移出已加载集合，数据也不并） | ✅ 已实现（B4：`server/workshop.js dropUnavailablePreDispatchPacks` + `server/index.js` 装配路径 + `server/data.js excludePacks`；可选导出 `validatePolicy` 走同一条裁剪） |
| 浏览器里真的 import + 真的渲染（真 Chrome）、真 SW 的生命周期与作用域 | ⛔ 本机无 Chrome（`SP_E2E=1` 的可选路径，与 §4.4 同一个 standing gap；`test/modAssets.test.js` §10 是**跳过且从未运行**的占位用例） |
| **顶层键闭集**：不认识的键 ⇒ `PACK_UNKNOWN_FIELD` 整包被拒（不是静默丢） | ✅ 已实现（B5：`shared/workshop.js PACK_FIELDS` + `normalizePackManifest`；`test/workshop.test.js`） |
| `api` / `game` / `gameVersion` 写成非字符串 ⇒ `BAD_API_TYPE` / `BAD_GAME_TYPE`（缺键与 `null` 逐字节不变） | ✅ 已实现（B7：`shared/workshop.js declaredString` 类型闸门 + `test/workshopDeclTypes.test.js`） |
| 编辑器元数据页显示 `api` / `game`（`PACK_META_FIELDS` 不含它们，只读到了 `gameVersion`） | ⛔ **另一件事，本轮没动**（`tools/workshop-pack.mjs PACK_META_FIELDS` 归编辑器那一波） |
| `i18n`：给已有语种补词条，**已有键绝不覆盖** + 冲突点名 | ✅ 已实现（B5：`shared/workshop.js parseI18nDecl` / `mergeWorkshopI18n`、`server/workshop.js i18nIssues`、`server/http/workshop.js buildWorkshopI18nFiles`、`server/http/static.js` 的 `/i18n/<code>.json` 合并体；见 §1.10） |

#### 1.9.1 `server.preDispatch`：分发前的准入钩子（B1 段已实现）

一个包可以声明一个**在消息分发之前**被调用的钩子，用来做「进房间之前先证明你导入了完整资源包」这类准入。

```jsonc
"server": {
  "preDispatch": {
    "module": "server/resourceAdmission.mjs",   // 包内 ESM；服务端加载，浏览器不加载
    "policy": "admission-files.json",           // 包内 .json，钩子自己的数据（原样注入，不解释）
    "intercepts": ["room.create", "room.join", "room.spectate", "room.start"]
  }
}
```

**模块契约**（`module` 必须导出其中之一；两者同形）：

```js
export function createPreDispatch(deps) {
  return {
    onConnection(conn) { /* 可选：连接建立时调用一次（挑战就是在这里发出去的） */ },
    preDispatch(conn, msg) { return false; },   // true = 这条消息已被消费，不再交给大厅
  };
}

// 可选：你对自己那份 policy 的**内部形状**的意见（不要写成 `valid:` 之类的键 —— 见下面那一条）
export function validatePolicy(policy) {
  return policy.files?.length >= 3 ? { ok: true } : 'policy.files needs at least 3 entries';
}
```

- **工厂每条连接调用一次**（`onConnection` 之前）。挑战与「已证明」这类状态就放在工厂的闭包里 —— 那是**连接私有**的，
  所以两台客户端 / 两个房间并发时不会串味。不要把它放到包的模块顶层：那是进程级共享状态。
- **`validatePolicy` 是可选的第二道自检，而且它是唯一能判「策略内部形状」的地方。** 装载期只保证 `policy` 能解析成
  一个 JSON **对象** —— 它不认识**你的**数据格式（`version` / `files` 是你自己的方言）。所以一份形状坏掉的策略，
  没有这道自检时唯一的信号是工厂在**每条连接**上抛异常，而工厂抛异常的姿态是「这条连接上这个钩子不存在、消息照常
  分发」—— 也就是「包看着装好了、闸门一条都没拦」。导出它之后，你说「不能用」= 装载器**点名拒绝整个包**，
  理由带 `PREDISPATCH_BAD_POLICY`：
  | 你返回 | 判定 |
  |---|---|
  | 不导出这个函数 | 不做这道自检，行为与从前**逐字节相同** |
  | `undefined` / `null` / `true` / `{ ok: true }` | 通过 |
  | `false`、非空字符串、`{ ok: false, detail }` | **拒绝**，字符串就是给作者看的理由 |
  | 其它任何值（例如手误写成 `{ valid: false }`） | **拒绝**，理由写「返回了一个不认识的判定」 |
  | 抛异常 | **拒绝**，理由取异常信息 |

  装载期正是「响亮拒绝」该在的地方（`deps` 里的 `now()` 纪律同理）：一个拿不准的返回值宁可让包不加载，也不要让它
  看起来装好了。
- **依赖对象是冻结的，键恰好这八个**：`pack`、`policy`（解析好的 JSON，深冻结）、`policyFile`、`intercepts`、
  `c2s`（`shared/protocol.js` 的 `C2S` 冻结副本）、`log`、`now`（注入的时钟）、`send`。**没有** `data` / `lobby` /
  `Match` / 任何对局对象，也**没有** socket：所以钩子能做的只有观察、记录、上报和否决入口消息，它**改不了对局结果**
  （不声明 `combat: true` 的包更是如此），也**不能**自己注册 `socket.on('message')` —— 那会让同一条消息被处理两次
  （`room.create` / `g.buy` 这类有副作用的类型是实打实的双执行），框架不给你这个口子。
- **`send(conn, msg)` 是框架的发送助手**（带背压守卫）。`preDispatch` 返回 `true` 时钩子**自己负责回执**，而回执
  **必须带上你收到的那条消息的 `rid`**：没有 `rid` 的错误帧在客户端会走 `unhandledError` 弹一条红条
  （`public/js/main.js`），玩家看到的就是「操作没反应 + 一条看不懂的错误」。
- **每一条通过协议校验的消息都会到达钩子**，不只是 `intercepts` 里那些：三个 `resource.*` 类型（`resource.proof` /
  `resource.challenge.request` / `resource.reset`，`shared/protocol.js` 的 `C2S`）**不在**任何 `intercepts` 里 ——
  它们不是「进入一局」的入口，而是钩子总线自己的类型，必须能到钩子。`intercepts` 是**钩子自己**判断「要不要闸」的
  名单（框架把它原样注入，并在加载期按协议校验过）。
- **钩子在 `validateC2S` 之后、`ping`/`hello` 与会话检查之前被调用**。这条位置是被证明流程逼出来的：服务端的挑战是
  连接建立时就发出去的，客户端的证明因此往往在 `hello` 之前到达 —— 放到会话检查之后，它只会被回 `hello required`。
- **`intercepts` 里那些类型在被否决时不会进大厅**；钩子放行时（包括它自己 `intercepts` 里的类型）照常分发 ——
  「声明了拦截」不等于「这条消息永远到不了大厅」。
- **没有包声明它时，服务器行为与从前逐字节相同**：不装载模块、不建任何对象、不注册任何监听器、没有一行新日志。

**坏声明点名拒绝，拒绝码与形状层同名**（`_up/mod4-pack` 那份声明对不上时作者看到的还是这几个词）：
`PREDISPATCH_BAD_MODULE`（模块文件不在包里 / 导入失败 / 没有 `createPreDispatch` 导出）、`PREDISPATCH_BAD_POLICY`
（策略文件不在包里 / 不是 JSON / 不是对象 / **模块自己的 `validatePolicy` 说它不能用**）、`PREDISPATCH_UNKNOWN_TYPE`
（`intercepts` 里有一个协议不认识的名字 —— 不是静默丢掉那一条）、`PREDISPATCH_BAD_PATH`（解析到包外）。

**从 B3a 段起，坏声明拒绝的是整个包**（DESIGN §28.13.3，与 §1.9.3 的 `client`、§1.9.4 的 `assets` 同一条纪律）：
模块/策略文件不在包里、策略不是 JSON 对象、`intercepts` 里有协议不认识的名字 ⇒ 包**整个不加载**，理由进启动日志。
B1 段当时只拒那个钩子、包照旧加载；那样一来服务器以为自己被准入闸门保护着，其实一条消息都没拦 —— 「加载了但能力
没生效」是最坏的失败形态，所以这一条被对齐掉了。留在装载期之外的是那一格**只有 `import` 才知道**的失败：模块文件在、
但 `import` 不了 / 没有 `createPreDispatch` 导出 / `validatePolicy` 说策略不能用。装载器是同步的，所以它们由
`loadWorkshopHooks` 具名拒绝，并**由启动装配路径把整个包移出已加载集合**（`server/index.js` 的
`dropUnavailablePreDispatchPacks`）—— 结局与上一段那三种**完全一样**，只是判的时刻晚一步。

**作者纪律（业主裁决）**：注入的服务端逻辑不得依赖时钟（用 `deps.now()`）、不得依赖 RNG 与无序容器的遍历顺序、
不得使用进程级可变全局状态；状态一律放连接 / 房间自己的作用域里。**不许**写「开打前设全局、打完恢复」那种代码 ——
多局并发会串味。

#### 1.9.2 `routes`：只读 HTTP 路由（B1 段已实现）

```jsonc
"routes": [ { "path": "/data/resource-manifest.json", "file": "resource-manifest.json", "cache": "no-cache" } ]
```

- `path` 是**绝对** HTTP 路径，`file` 是包内 `.json`。服务方式刻意窄：**只 GET / HEAD**（别的动词在
  `server/http/routes.js` 就被 `405 Allow: GET, HEAD` 挡掉）、没有写路径、没有目录列表、不做任何重写。
- **只有精确等于声明路径的请求被回答**。于是目录穿越不是一个「被检查出来」的边界，而是**没有可穿越的目标**：
  `..` 永远拼不出一个已声明的 key。声明里带 `..`、或解析后逃出包目录的 `file`，在装载期就被拒（并记一条警告）。
- `.js` / `.html` **在服务面再拒一次**（与 `/workshop-assets` 同一条线：那是代码执行面，不是数据面）。
- `cache` 决定 `Cache-Control`：`no-cache`（缺省）→ `no-cache`；`no-store` → `no-store`；`public` →
  `public, max-age=86400`（与包自己的素材同一条策略）。
- 声明的路径**先于**核心静态挂载被查找，但**核心先吃**（0.15.2 起，DESIGN §28.13.2 / §28.35）：一条声明若与核心
  **真的会服务**的路径相撞，那条声明**不生效**，回答的是引擎自己那份，并且**表决不拒包** —— 包照常装载、照常在
  报告与启动日志里被点名（「声明了却顶核心」不许静默）。判据只看「核心是不是真的服务那条路径」：像
  `/data/<你自己的名字>.json` 这种核心下没有同名文件的声明**照常生效**。
- 作者侧的 `node tools/workshop-validate.mjs` 判的就是**服务器那一份** `coreRouteShadow`（同一张 mount 表，不抄第二份
  名单）：撞上核心**真的会服务**的路径 ⇒ `ROUTE_CLASHES_CORE`（error，整轮非 0 退出）；落在引擎命名空间里但核心今天
  没有那个文件 ⇒ `ROUTE_IN_ENGINE_NAMESPACE`（warning，与服务器同档 —— 它今天照常生效）。校验器比服务器严会把合法的包
  判死，比服务器松会给一条永远不回答的路由发绿牌，所以两边同判据是被测试钉住的（`test/workshopValidateRoutes.test.js`）。
- 反过来，「**声明了但文件不在**」是 **404**，不会悄悄回落到那个同名核心文件。
- 两条路由声明同一个 `path`：包 id 小的赢（DESIGN §28.3），输的那条记一条警告。

#### 1.9.3 `client`：包自带的客户端面板（B2 段已实现）

一条声明就能让包带上一块界面，而且**不用改本仓库一行代码**：

```jsonc
"client": {
  "panels": [
    { "id": "resource-import", "slot": "root.overlays", "module": "resources/preloadModal.js", "order": 10 },
    { "id": "aside-note", "slot": "screen.game.aside", "module": "resources/aside.js" },
    // `gate` 只在**别人**替你置真那个路径时才写（见下面那条警告）：
    { "id": "settle-note", "slot": "screen.result.footer", "module": "resources/settle.js", "gate": "session.entered" }
  ],
  "requires": ["cacheStorage", "webCrypto"]
}
```

> ⚠️ **不要给「唯一那个会打开 `session.preloadRequired` 的面板」写 `gate: "session.preloadRequired"`。** `gate` 的
> 语义是「store 里那个路径为真**才**挂载」，而 `session.preloadRequired` 缺省是 `false`、**唯一会把它置真的正是
> 这个面板自己** —— 于是全新会话里它**永远挂不上**，导入界面永远不出现，而服务器侧的准入闸门照样拦人：一个走不出去
> 的环。正确写法是**无条件挂载 + 挂载时自己关闸**（`ctx.session.setPreload({ required: true, ready: false })`，
> 见 §1.9.4 末尾那段客户端示例）。`gate` 适合的是「等某个**别人的**状态成立再出现」的面板，例如
> `session.entered`（玩家已经进过大厅）。

**模块契约**（`module` 是包内 `.js`；浏览器 `import` 它）：

```js
export function mount(ctx) {
  // ctx.host 是一个属于你这次挂载的 <div>，往里画你的界面。
  return { unmount() { /* 可选：页面卸载 / 引擎 dispose 时收尾 */ } };   // 也可以什么都不返回
}
```

`default` 导出同一个函数也行。**模块源码进包的身份哈希**：改了面板的字节就是换了一个包（DESIGN §28.8），所以不
用担心「摘要一样、界面不一样」。

**十个挂载点**（闭枚举，写别的整包被拒：`CLIENT_BAD_PANEL_SLOT`）：

| `slot` | 位置 | 容器谁创建 |
|---|---|---|
| `root.overlays` | 最上层浮层（模态框、提示条这类东西放这里） | 注册点按需创建 |
| `root.guide` | 说明层之上、浮层之下 | 注册点按需创建 |
| `screen.game.aside` | 屏幕右侧竖条（对局界面旁边） | 注册点按需创建 |
| `screen.result.footer` | 屏幕底部横条（结算界面下方） | 注册点按需创建 |
| `screen.game.shopCard` | **每一张商店卡**里（可重复） | 组件渲染 |
| `screen.game.bondStrip` | 盟约条里 | 组件渲染 |
| `screen.game.hud` | 对局 HUD 层里 | 组件渲染 |
| `screen.game.overlay` | 对局画面之上（整屏覆盖层） | 组件渲染 |
| `screen.loadout.detail` | 干员详情面板里（插一节） | 组件渲染 |
| `screen.room.aside` | 房间屏（等待开局的那一屏）的旁栏 | 组件渲染 |

前四个是**固定浮层**：与当前在哪个界面无关，面板挂一次就一直在，容器由注册点在面板真的挂载时创建（没有包声明
`client` 时页面上一个容器都没有）。

后六个是**既有组件里的宿主**（业主裁决 2026-10-10），容器由**组件自己**渲染 `[data-mod-slot]`。三条性质：

- **空闲时零影响**：容器 `display: contents`（不产生盒子），里面的面板默认 `pointer-events: none`（不吃点击）。
  想让标记/手势/一节接收输入，在你自己的样式表里打开 `pointer-events: auto` —— 默认绝不能是「一层看不见的东西
  把你的点击吃了」，商店卡尤其必须照旧能买。
- **定位是你的事**：引擎只给地址，不给样子（这正是 `styles[]` 那一半存在的理由）。
- **`screen.game.shopCard` 是「可重复」宿主**：每张卡一个容器，你的面板会挂进**每一张**，并且通过 `ctx.hostKey`
  知道自己是哪一张（那个键就是棋子的 id）。后来才出现的卡会在下一次状态变化时自动补上。

**`order` 决定挂载顺序**（整数，缺省 0）：小的先挂；相同则包 id 小的先，再按面板 id。顺序永远不随发现顺序 /
数组顺序变（DESIGN §28.3 的同一条规则）。**`gate` 是一个客户端 store 点路径**（例如 `session.entered`）：路径为真
**才**挂，一个面板只挂一次、之后不会被摘掉。写一个 store 里不存在的路径是**具名拒绝**（`CLIENT_PANEL_GATE_UNKNOWN`），
不是「永远不出现」。**别拿它等自己会置真的那个标志**（`session.preloadRequired`）—— 那是一个挂不上的环，理由与
正确写法见 §1.9.3 开头那段警告。

**`requires` 是能力声明，不是愿望**：只能取 `serviceWorker` / `cacheStorage` / `webCrypto`（写别的 `CLIENT_UNKNOWN_REQUIRE`）。
缺一项时这个包的面板**一个都不挂**，并且**明说**「浏览器不支持」（控制台一条具名错误 + 玩家界面一条提示）——
这个仓库不接受「装了但静默不工作」。

**注入面是冻结的，键恰好这几个**（DESIGN §28.8 的「边界由没给什么决定」）：

| 给 | 说明 |
|---|---|
| `id` / `pack` / `slot` / `order` / `gate` | 你声明的那几个值（只读） |
| `hostKey` | 可重复宿主下你是**哪一份**（每张商店卡一个容器，这个键就是棋子 id）；不可重复的宿主是 `null` |
| `log` | 带 `[mod <包>/<面板>]` 前缀的 `info` / `warn` / `error` |
| `host` | 属于这次挂载的 `<div>`；往里画界面 |
| `session.setPreload({ required, ready })` | **唯一**的 store 写口：入口闸门那两个状态位（见下） |
| `net.on(type, fn)` / `net.sendResourceMessage(msg)` | **唯一**的网络口；见下 |
| `session.send(type, fields)` | 发一条**引擎消息**：白名单是**闭枚举** `PANEL_SEND_TYPES`（今天 `room.appearance` 与 `room.mods`），形状再过一遍 `shared/protocol.js` 的 C2S。⚠️ 这是 `ctx.session` 上那一格 —— `ctx.net.send(channel, data)` 是**你自己的通道**（§1.9.6，先在 `messages` 里声明过才发得出去），两者不是同一条路 |
| `data.get('<表>')` / `data.tables()` | **只读快照**：你在 `data` 里声明过的那些表（见下） |

**没有** store 句柄、没有 `net` 对象本身、没有对局对象、没有 `Match`/`Battle`，也**不能**自己注册
`socket.on('message')`。所以面板能画错，**改不了对局结果**。

**`PANEL_SEND_TYPES` 为什么只有两条**（`public/js/ui/extensions.js`）：它是「面板能**主动发起**的引擎消息」的**闭
枚举**，而这一层的历史立场是「只列**展示**类：面板能改对局状态的那一天，就是这一层失效的那一天」。今天两条：
`room.appearance`（只改别人看到的外观、不碰战果）与 `room.mods`（房间级、**只有房主**、开局前且没人就绪才收，
`docs/META.md` §1.9c）—— 后者是**唯一**一条能改变「这一局跑哪几个包」的消息，之所以放进来，是因为它改的是
**房间声明的集合**（一个已经被 `MOD_SET_LOCKED` 锁在开局前的房间级设置），而不是某一场对局里的任何数值。
**`room.create` 不在里面，也永远不该在**：面板能替玩家建房，就是它能改对局状态。加一条要同时改这张表、那条消息的
C2S 形状、以及一条测试（`test/modClientPanels.test.js` 那一组）。

**数据口（`client.panels[].data`，业主裁决 2026-10-10）**：要在卡上按数据画标记，就声明你要读哪几张表，然后用
`ctx.data.get('chess')` 拿一份**冻结的深拷贝**：

```json
{ "id": "marks", "slot": "screen.game.shopCard", "module": "ui/marks.js", "data": ["chess"] }
```

- 可读的表就是**浏览器本来就抓得到的那几张**（`chess` / `bonds` / `items` / `bands` / `enemies` / `bosses` /
  `stages` / `tokens` / `choices` / `config` / `assets` / `backups` / `local`）—— 读一张表**不会多一个请求**，你读的
  是引擎已经抓过的那份内容。名字必须在名单里，写别的整包被拒（`CLIENT_BAD_PANEL_DATA`）。
- 拿到的是**快照**：冻结的深拷贝，同一个包多次调用拿到同一份。你改自己那份，引擎缓存里那份一个字节不动；反过来，
  引擎也不会因为你读了就变慢或变只读。
- 读一张**没声明**的表返回 `null` 并在控制台**点名**（`CLIENT_DATA_UNDECLARED`）—— 不抛异常（多读一行不该让整个
  界面消失），但这件事必须看得见。
- 这一格**不是** store 的替代品：这里只有**静态数据表**，没有对局状态。要读对局状态请走服务端（§1.9.1 / §1.11）。

**入口闸门（「素材没就绪不许进」怎么写）**：`session.setPreload({ required: true, ready: false })` 把路由压回标题页，
预载完成后再 `setPreload({ ready: true })` 放行。两个状态位缺省都是 `false`（不启用 = 今天的行为一个字节不变），
`selectRoute` 里那条件是 `preloadRequired && !preloadReady`。它**不是安全边界**（真正的边界是 §1.9.1 的服务端准入），
但它连 `?room=` / `?playtest=` 深链和「localStorage 说我已经进过」那条旁路一起挡住（B2 段把 `main.js` 的
`wasEntered` 旁路堵了）。

**资源消息（挑战在 `hello` 之前到）**：用 `ctx.net.sendResourceMessage({ t: 'resource.challenge.request' })`、
`{ t: 'resource.proof', nonce, version, proofs }`、`{ t: 'resource.reset' }`。**不要**用普通的 `send()`：服务端的挑战
是连接建立时就发出去的，那一刻 `status` 还不是 `online`，`send()` 会**静默丢弃**（这正是社区资源包 mod 踩过的坑）。
`sendResourceMessage` 走原始发送口（`_sendRaw`），只看这三个类型 + 协议形状。

**模块路由**：`/workshop-panels/<包id>/<module>`。只有装载器注册过的 URL 被服务（没注册的、`..` 穿越的、`.html`
一律 404），所以**别指望它当文件服务器用**；要送数据请用 §1.9.2 的 `routes`，要送图片/音频请用 `/workshop-assets`。

**纪律：一个用不了的声明拒绝整个包**（DESIGN §28.13.3）。`module` 文件不在包里、不是 `.js`、或解析后跑出包目录，
包**整个不加载**（拒绝码 `CLIENT_BAD_PANEL_MODULE`，与形状层同名），因为「包照旧加载、只是面板不出现」会让作者与
服务器都以为自己有客户端界面，而浏览器里什么都没有。对既有包的影响是零：不声明 `client` 的包一个字节都不受影响。

**当前状态**：服务端与纯逻辑部分全部有测试（`test/modClientPanels.test.js`：注册、服务面、`welcome`、
`order`/`gate`/`requires`、注入面、三处客户端缺口）。**浏览器里真的 `import` 与真的渲染在本机没有 Chrome 上跑不了**
—— 那是 `SP_E2E=1` 的可选路径，与 §4.4 同一个 standing gap。

#### 1.9.4 `assets`：包自带的资源容器与清单（B3a 段已实现服务端）

一个包可以带一份**资源容器**（`.spresources`，客户端资源包的字节格式）与一份**扁平文件表**（清单 `.json`），
并声明这两棵树的服务态度：

```jsonc
"assets": {
  "container": "packs/resources-0.1.0.spresources",  // 包内相对路径，必须是 .spresources，不能是别的扩展名
  "manifest":  "resource-manifest.json",             // 包内相对路径，必须是 .json
  "serverPolicy": "serve",                            // "serve"（缺省）| "cache-only"，见下
  "verify": "sha256",                                 // 整包摘要的算法；缺省 sha256，今天只有这一种
  "mirrors": [                                        // 可选：作者自备 CDN 承载**本包自己的容器**（§1.21）
    { "id": "fast", "base": "https://你的域名/ak/resources-0.1.0/", "sha256": "<64 位小写 hex>" }
  ]
}
```

**容器怎么产**：`node tools/make-spresources.mjs --manifest <清单.json> --public <素材根> --out <你的包目录>` 会写出
三件东西 —— `<包>/packs/<名字>.spresources`、它的旁挂 `<…>.sha256`、以及 `<包>/resource-manifest.json`（就是
`assets.manifest` 指向的那份**权威清单**）。**清单必须显式给**：`tier` 是内容判断（首屏必需 / 后台慢慢拉），
工具不替作者猜，而且它产出的容器字节与参考实现（`_up/mod4-pack/tools/spresources.mjs` 的 `buildPack`）在
`test/modAssets.test.js` 里被断言为**逐字节相同**。

**容器与清单从哪取**：`/workshop-resources/<包id>/<你声明的那条路径>`。`?v=<内容哈希前 12 位>` 是缓存键
（重新打包 = 新 URL）。两条纪律：

- **只有装载器注册过的两个 URL 被回答**。别的路径（包自己的 `pack.json`、`assets/**`、旁挂的 `.sha256`、`..` 穿越、
  另一个包的路径）一律 **404** —— 与 §1.9.3 的模块路由同一条，所以这条通道**不能当文件服务器用**。
- **容器是流式送出的**（可以到数百 MB：客户端资源包本身就是那么大），响应里带 `Content-Length` 与
  `X-SP-Resource-Sha256`（装载期校验过的整包摘要）。清单按 `.json` 正常送。

**`serverPolicy` —— 这条是**服务端**语义，写之前请读三遍**：

| 值 | **服务端**对 `/assets/…` 与 `/fonts/…` 做什么 |
|---|---|
| `"serve"`（缺省，等于不写） | 照旧从磁盘服务。本仓库现有的包全是这个值，**服务端**行为与 B2 之后**逐字节相同** |
| `"cache-only"` | 回 **412 Precondition Failed**，并且**不回源**（连 `stat` 都不做）：素材只允许从客户端自己的缓存取 |

> ⚠️ **`serverPolicy` 管的是服务端，不是玩家看到的东西。** 引擎的资源 Service Worker 在**任何**包声明
> `assets` 时就会注册（它拦 `GET` 且路径落在 `/assets/`、`/fonts/`、`/media/` 的请求），而它**只用本地导入并通过
> 校验的缓存回答，命不中回 412、绝不回源** —— 这个行为**与 `serverPolicy` 无关**。所以：
> - `"serve"` **不是**「对玩家没有影响」：对一个还没导入容器的玩家，那三棵树已经是 412 了（服务端本来会正常送出，
>   但请求根本到不了服务端）；
> - 一个真实部署里，容器的内容必须覆盖**页面真的会去取**的那三棵树，否则玩家看到的是一页没有素材的界面。
>
> 缺省那一行的「逐字节相同」说的是**服务端**；把这一句读成「装了没影响」是这份文档曾经最容易误导人的地方
> （`_up/mod-compat/README.md` 的交付说明里有实测记述）。

`cache-only` 覆盖的 `/assets/` 与 `/fonts/` 是**全服务器共用**的两棵树（核心游戏、所有包都用它们），所以它是
**进程级**的：任何一个包声明它，整个服务器的这两棵树都不再服务。启动日志会点名是哪个包声明的。客户端那半
（把容器导入 `CacheStorage`、由 Service Worker 应答这两棵树）见下面「客户端那半」与
[DEPLOY.md](DEPLOY.md) 的 `cache-only` 一节。

**`verify` —— 校验失败就是整个包被拒**：装载期读旁挂的 `<container>.sha256`（格式 `<64 位十六进制摘要>`，
后面可以跟一个文件名，两段之间空白分隔 —— 与 `sha256sum` 的输出一致），再用**流式**读取把容器哈希一遍：

| 情况 | 拒绝码 | 结果 |
|---|---|---|
| 摘要对得上 | — | 包正常加载，摘要随响应头出去 |
| 摘要对不上 | `ASSETS_VERIFY_FAILED` | **整个包不加载**（理由里写出两个摘要值） |
| 声明了 `verify` 却没有旁挂摘要（或格式不对） | `ASSETS_VERIFY_UNAVAILABLE` | **整个包不加载** |
| `container` / `manifest` 指的文件不在包里 | `ASSETS_BAD_CONTAINER` / `ASSETS_BAD_MANIFEST` | **整个包不加载** |
| `i18n[<语种>]` 指的文件不在包里 / 不是 JSON 对象 | `I18N_BAD_FILE` | **整个包不加载**（§1.10） |
| `i18n` 里语种码不是常用大小写 / 是源语言 `zh` | `I18N_BAD_LANG` / `I18N_SOURCE_LANG` | **整个包不加载**（§1.10） |
| `i18n` 的某条译文不是字符串 / 键以 `_` 开头 | `I18N_BAD_VALUE` / `I18N_BAD_KEY` | **整个包不加载**（§1.10） |
| `pack.json` 有一个这份格式不认识的顶层键 | `PACK_UNKNOWN_FIELD` | **整个包不加载**（§1.1 的闭集表） |

「声明了校验、但校验不过还照旧发」这个仓库不接受：客户端会导入一份服务端**已经知道是坏的**字节，而唯一的信号是
一行没人看的日志。

**纪律：一个用不了的声明拒绝整个包**（DESIGN §28.13.3，与 §1.9.3 逐字同一条）。**`server.preDispatch` 从本刀起
也是这条**（§1.9.1）：模块或策略文件不在包里、策略不是 JSON 对象、`intercepts` 里有协议不认识的名字 ⇒ 整个包
不加载。B1 段当时只拒那个钩子、包照旧加载 —— 「服务器以为自己被准入闸门保护着，其实一条消息都没拦」正是这条纪律
要消灭的失败形态。B4 段把最后剩下的一格也补上：**`import` 失败 / 没有 `createPreDispatch` 导出**这两种只有
`import` 才知道的失败，由启动装配路径（`loadWorkshopHooks` 之后、其余一切读者之前）**把整个包移出已加载集合**并
在启动日志里点名（`server/workshop.js dropUnavailablePreDispatchPacks`）。它的数据文件也不再并进游戏数据 ——
「包不在身份清单里，而它的干员在游戏里」这种半装状态是被明确拒绝的。

**对既有包的影响是零**：不声明 `assets` 的包一个字节都不受影响（没有新路由、没有新响应头、没有 412、没有新字段、
没有 SW 注册）。

##### 客户端那半：引擎自带 SW，包只声明（B4 段）

**业主裁决（2026-10-10）：Service Worker 由引擎自带，包只声明。** 理由一句话：根作用域的 SW 能拦截该站点**所有**
请求，让包提供 `.js` 去注册它就等于把客户端控制权交出去。所以：

| 谁 | 提供什么 |
|---|---|
| **引擎** | `public/resource-sw.js`（唯一的 SW 脚本）与 `public/js/resources/**`（`common` / `service` / `bundle` / `verify` / `worker` / `host`）。注册口径：`type: 'module'`、`scope: '/'`、`updateViaCache: 'none'` |
| **包** | 只有那一句 `assets` 声明，加上**容器 / 清单 / 旁挂摘要**三个文件。**不能**提供 SW 脚本，也没有任何字段能指定一个 SW 地址 |

**缺省不启用**：没有任何包声明 `assets` 时，`welcome` 里没有 `modAssets` 字段，浏览器**不加载资源流程、不注册
SW、不多一个请求、不多一个 DOM、不在 `globalThis` 上留任何名字**（`public/js/main.js` 只在字段真的到达时才
`import('./resources/host.js')`，所以这条不变量是结构性的）。

**声明之后你会得到什么**：服务器在 `welcome` 里为你的包带一条 `modAssets`（容器 URL、清单 URL、装载期已与字节核对
过的容器摘要 `digest`、归一化后的 `serverPolicy` / `verify`）。客户端拿到它之后——

```
① 取清单（你的 assets.manifest）→ 校验形状，并核对 version == sha256(压紧 files)[0:12]
② 取容器（你的 assets.container，或玩家自己选的文件）→ 解析容器头，核对它与①逐条相同
③ 逐文件核对 SHA-1[0:12] → 写进 Cache Storage（每个条目带 X-SP-Resource / X-SP-Resource-Hash）
④ 写索引（URL → 指纹）与收据（这个包是为哪份容器、哪版清单导入的）
⑤ 浅度校验（条目指纹三处一致）／深度校验（重读字节、重算指纹）→ 都过了才算装好
```

**入口放行是你（包）的事，不是引擎的事**。什么时候算「装好了」是包的策略（浅度还是深度、允不允许跳过），所以
引擎只**报告**结果，动那支笔的是你的 C 层面板（§1.9.3）：`ctx.session.setPreload({ required: true, ready: false })`
在挂载时关闸，导入 + 校验通过之后 `{ ready: true }` 开闸。两个标志缺省都是 `false`，也就是**不声明就完全不挡人**。

你的面板模块可以直接 import 引擎的流程（它们是站点上的模块，不是包里的文件）：

```js
import { installModAssets, modAssetsFor, importAndVerify, importFromServer, importStateFor } from '/js/resources/host.js';

export function mount(ctx) {
  const decl = modAssetsFor(ctx.pack);       // 服务器宣告的、属于你这个包的那一条（没声明 assets 时是 null）
  ctx.session.setPreload({ required: true, ready: false });
  // …你自己的界面：一个「导入完整资源包」的按钮 + 一个 <input type=file accept=".spresources">…
  // 两种来路喂的是同一个函数：服务端那条（`decl.container`）与玩家本地的文件。
  return {
    async onPick(file) {
      const report = await importAndVerify(file, ctx.pack, { deep: false });
      // 或者：const report = await importFromServer(ctx.pack);
      if (report.valid) ctx.session.setPreload({ ready: true });
    },
  };
}
```

**两条要记住的后果**：

- **容器摘要进了包的身份哈希。** 装载期已经拿它与字节核对过，所以它和 `pack.json`、内容文件、`kits/`、`assets/**`
  一样是这份包的属性：**换了容器 = 换了身份** = 房间的摘要闸门（`welcome.mods.digest`）随之改变，客户端也会据此判定
  旧缓存作废（收据里的 `digest` 与服务器这次宣告的比）。不声明 `assets` 的包哈希逐字节不变（`test/packAssets.test.js`
  钉着 `docs/examples/` 三份真实包）。
- **`serverPolicy: "cache-only"` 的两半合起来才成立。** 服务端对 `/assets`、`/fonts` 回 412（不回源），客户端那半
  由引擎的 SW 用**本地校验过的缓存**回答同一批 URL：命不中也是 **412，绝不回源**。所以 `cache-only` 的部署里，
  容器从 `/workshop-resources/…` 进来一次是玩家唯一需要的那次网络传输；离线/别人给的文件则是第二条来路。

**当前状态**：服务端与客户端流程的**纯逻辑**都有测试（`test/modAssets.test.js`：不声明 ⇒ 无变化、容器/清单可取、
`?v=` 生效、穿越/未注册 ⇒ 404、容器走流式、`cache-only` 只对两棵树生效且只在声明时生效、`verify` 失败点名、
我们的容器写入器与参考写入器**逐字节相同**、容器导入/逐文件校验/索引/收据/深浅校验在 Node 里真跑、SW 的应答选择
规则（含 `%5B` 编码等价、`/media/` 候选、Range ⇒ 206、命不中 412）、`welcome.modAssets` 的条件性、
`assetsDigest` 进身份、`server.preDispatch` 装配路径裁剪的回归）。**浏览器路径没有验过**：真 SW 的注册与作用域、
真 `caches` 的配额行为、`<input type=file>` 的 `File`、面板模块的真 `import()`、渲染与样式叠放 —— 那是
`SP_E2E=1` + 有 Chrome 的机器上的事（§4.4 同一条 standing gap），本机没有 Chrome，所以这些用例**默认跳过**，
而且没有跑过。


#### 1.9.5 面板自带样式表与主题变量（业主裁决 2026-10-10）

**两条路一起给**，因为它们解决的是两件不同的事：**主题变量**是「几个颜色/尺寸」，**面板自带样式表**是「一整份新组件的
样式」。插件包那三份 CSS（`chat.css` 21 KB / `devices.css` 11.7 KB / `title.css` 22 KB）走的是后者 —— 光有变量装不下。

```json
"client": {
  "theme": { "vars": { "--sp-chat-bg": "#111", "--sp-chat-fg": "#ffcc00" } },
  "panels": [
    { "id": "chat", "slot": "root.overlays", "module": "ui/chat.js", "styles": ["ui/chat.css"] }
  ]
}
```

**主题变量**（`client.theme.vars`，最多 200 个）：

- 名字**必须**是 CSS 自定义属性（`--` 开头）：写一个不叫 `--x` 的键等于什么都没发生，所以形状层直接拒
  （`CLIENT_THEME_BAD_VAR_NAME`）。
- 值是**数据**：不许含 `;` `{` `}` `<` `>` 或换行，最长 400 字符。这几个字符能让一条声明**跑出它自己那一格**
  （结束当前声明、再开一条），一个主题值不该有这种能力。
- 语义是**加法**：引擎只把这几个变量写到 `:root` 上，改不了任何规则、也替换不了任何样式表；`dispose()` 按名字恢复
  原值（原本没有这个变量就删掉）。
- **多包抢同一个变量**：包 id 小的持有它，后到的包被点名（`CLIENT_THEME_VAR_TAKEN`）并保留先到的那份值 —— 与内容层
  同一条规则（DESIGN §28.3）。

**面板自带样式表**（`client.panels[].styles[]`，每个面板最多 8 份）：

- 必须是**包内相对**路径、`.css`（`CLIENT_BAD_PANEL_STYLE`）；同一份列两次被拒（`CLIENT_DUPLICATE_PANEL_STYLE`）。
- 走的是与模块**同一条**通道：`/workshop-panels/<包id>/<file>.css`，**只有装载器注册过的 URL** 被服务（没注册的、
  `..` 穿越的、`.html`/`.js` 张冠李戴的一律 404），`?v=<包摘要前 12 位>` 与模块同一份，所以「同一个房间摘要 ⇒
  同一份样式」这条对齐对样式同样成立。
- 注入顺序是**在调用面板工厂之前**、`<link>` 追加到 `<head>` **末尾**（后到的规则在层叠里更靠后，也就是排在引擎
  样式之后）；`dispose()` 时全部移除。
- 声明了一份**读不到/不在包里**的样式表 ⇒ **整个包不加载**（`CLIENT_BAD_PANEL_STYLE`，与坏模块同一个结局）：
  「包加载了、只是样式没生效」会让作者与服务器都以为界面装上了，而页面上一片没样式。

**当前状态**：形状层、装载期、服务面、`welcome.modTheme`、客户端注入与撤销全部有测试
（`test/modClientStyles.test.js` 17 条；`test/modClientPanels.test.js` 的 `welcome` 字段集合对照照旧钉着
「没有包声明就一个字段都不多」）。

#### 1.9.6 包通道：`client.panels[].messages` 与 `pack.msg`

插件包要的**聊天 / 皮肤**这类通道，引擎里没有，而引擎也不该替它发明语义。所以这一格的分工是：

- **类型名由引擎定**：线上只有一种消息 `pack.msg`，它进 `shared/protocol.js` 的 `C2S` / `S2C`。包**不能**定义新的协议
  类型 —— `b.*` 那条边界（C 层改不了对局结果）**一个字没动**。
- **通道名由包定**：你在面板里写 `"messages": ["chat", "skins"]`（只写后半段），线上是 `<你的包id>.chat`。
- **引擎只做三件事**：校验（包装着 + 通道声明过）、限流（每会话令牌桶）、转发（**同一个房间**的成员与旁观者）。
  载荷 `data` 是**不透明**的：引擎不看、不改、不落库。

```json
{ "id": "chat", "slot": "root.overlays", "module": "ui/chat.js", "messages": ["chat"] }
```

```js
export function mount(ctx) {
  ctx.net.on('chat', (data, msg) => render(data, msg.from));   // 收：只收自己包、自己声明的那个通道
  ctx.net.send('chat', { text: '你好' });                        // 发：同一个房间的人都收到
  return {};
}
```

| 判据 | 行为 |
|---|---|
| 通道名形状 | 小写字母开头、`[a-z0-9_-]`、≤ 64，每个面板最多 8 条；写别的整包被拒（`CLIENT_BAD_PANEL_CHANNEL`） |
| 载荷大小 | `data` 序列化后 ≤ 4096（`PACK_MSG_LIMITS.bytes`），超了整条消息按 `BAD_MSG` 拒 |
| 频率 | 每会话令牌桶：容量 20、每秒补 5（`PACK_MSG_LIMITS`）；超了回 `RATE`（「操作过于频繁」） |
| 不在房间里 | 回 `NOT_IN_ROOM` —— 通道是**房间内**的，不在大厅里广播全网 |
| 没声明的通道 | 服务端回 `BAD_MSG` 并**点名**那个通道；客户端 `send` 返回 `false`、`on` 返回一个什么都不做的退订函数，两边都会在控制台点名（`CLIENT_CHANNEL_UNDECLARED`）|
| 引擎类型 | `ctx.net.on('<引擎类型>')`（`shared/protocol.js S2C` 里的那些）照旧原样透传，不受这一格影响 |
| 对局子类 | 声明了 `server.modules { uses: ["matchClass"] }` + `combat: true` 的包，其子类的 `handlePackMsg` 在**限流之后、转发之前**被调到一次；返回 `true` / `{ consumed: true }` 就不再转发（见下） |

**这一格不提供什么**：没有服务端存档、没有离线消息、没有跨房间广播、没有服务端语义（谁该收到、聊天记录怎么存、
皮肤怎么同步，都是**包自己**的事 —— 服务端那一半用 §1.9.1 的 `server.preDispatch` 钩子接，它在 `intercepts` 里
写上 `pack.msg` 就能看到这条消息，并可以用 `send` 回话）。

**让对局里也看到这条消息**：上面那条 `preDispatch` 是「消息路过大厅」，它拿不到这一局的 Match。要**对局里**的代码
看到它，用 `server.modules` 的 `matchClass`（DESIGN §28.14）—— 它要求包同时写 `combat: true`，因为那条子类碰得到
整个 Match：

```json
{ "combat": true,
  "server": { "modules": [{ "id": "chat", "entry": "server/chat.mjs", "uses": ["matchClass"] }] },
  "client": { "panels": [{ "id": "chat", "slot": "root.overlays", "module": "ui/chat.js", "messages": ["chat", "mute"] }] } }
```

```js
// server/chat.mjs —— 引擎在**限流之后、转发之前**调它一次，参数就是发送者与那条 `pack.msg` 原样
const muted = new Set();
export function registerServer(host) {
  host.matchClass((Base) => class extends Base {
    handlePackMsg(playerId, msg) {
      if (msg.channel === 'mute') { muted.add(playerId); return true; }   // 已消费：同房谁都不转发
      if (msg.channel === 'chat' && muted.has(playerId)) return true;     // 同上
      // 不返回 = 照旧转发（今天的行为，逐字不变）
    }
  });
}
```

返回值就是全部语义：`true` 或 `{ consumed: true }` = **已消费**（同房谁都不转发，发送者也没有回显）；`false` /
什么都不返回 / 根本没有这个方法 = **照旧转发**。钩子**抛错按「未消费」处理**：日志里点名一次
（`match.handlePackMsg threw`），消息照旧转发 —— 一条坏消息不该把通道打断。注意 `playerId` **可能是观战者**
（`pack.msg` 与 `room.chat` 不同，没有旁观者判据），要不要拒绝由包自己判。

#### 1.9.7 组件级改写：`client.panels[].wraps`（DESIGN §28.19）

**它解决的是什么**：§1.9.3 的十个槽位说的是「插进这个位置」—— 你在引擎**已经画出来的容器**里画你自己的东西。
但「这一屏现在长得不一样了」不是插入：那要改的是**引擎自己那个组件**。所以面板还可以声明 `wraps`，
每个条目点名一个**引擎具名组件**和一个方式：

| 方式 | 意思 | 你拿到什么 |
|---|---|---|
| `wrap` | **包一层**：链条下方那一份留给你放在自己的树里 | `orig`（一个 vnode，直接嵌进你返回的那棵树即可） |
| `replace` | **整段换掉**：你给出完整子树 | `orig` 是 `null` —— 引擎决定它下方不再渲染，不是靠你自觉 |

可改写的组件就四个（闭枚举，写别的整包被拒 `CLIENT_WRAP_UNKNOWN_COMPONENT`）：

| `component` | 是什么 | 里面顺带有的槽位 |
|---|---|---|
| `game.bondStrip` | 对局 HUD 的**盟约条** | `screen.game.bondStrip` |
| `game.shopCard` | **每一张干员卡**（商店 / 晋升奖励 / 定向投放） | `screen.game.shopCard`（可重复） |
| `game.hud.topBar` | 对局 HUD 的**顶栏** | `screen.game.hud` |
| `loadout.detail` | **干员详情面板**本身 | `screen.loadout.detail` |

名字与槽位**是两个命名空间**（`game.bondStrip` 是组件，`screen.game.bondStrip` 是那个组件里的一个容器）：
要「往里塞东西」用槽位，要「换掉/包住整块」用组件。

**模块契约**（与 `mount` 同一个模块文件，两个导出可以同时有）：

```js
// wrap(ctx) 每次渲染调用一次：ctx.props 是**这一帧**的 props 只读快照。
export function wrap(ctx) {
  // 返回一个渲染函数：外层拿到链条下方那一份当 `orig`（replace 档拿到 null）。
  return (orig) => html`<div class="badge">${ctx.props.pub?.round ?? '-'}<${orig} /></div>`;
}
```

```jsonc
// 1) wrap：给顶栏加一个角标 —— 顶层组件原样还在
{ "id": "hud-badge", "slot": "screen.game.hud", "module": "ui/badge.js",
  "wraps": [ { "component": "game.hud.topBar", "mode": "wrap" } ] }
```

```js
// 2) replace：整条盟约条换成你自己的那一套（引擎的实现与它里面的槽位这一帧都不渲染）
export function wrap(ctx) {
  return () => html`<div class="mychat">
    ${ctx.props.bonds.map((b) => html`<span key=${b.bondId}>${b.bondId} ×${b.count}</span>`)}
  </div>`;
}
```

**`ctx` 就是面板那一个注入面**（§1.9.3 的那张表），**只多两个键**：

| 多给 | 说明 |
|---|---|
| `component` | 你这一条链改的是哪个组件 id（一个面板可以声明两条链，得知道自己是哪一条） |
| `props` | 那个组件**这一帧**的 props 的**冻结深拷贝**：`ctx.props.pub.round`、`ctx.props.bonds`… 你改自己那份，引擎那份一个字节不动 |

**没有** store、没有对局对象、没有 `Match` / `Battle` —— 所以改写能画错，**改不了对局结果**（与面板同一条边界）。
`host` / `hostKey` 是 `null`：改写没有容器可挂。

**次序**：同一条链上多个包按**既有面板比较器**排（`order` → 包 id → 面板 id，DESIGN §28.3）：`order` 小的在**内层**、
大的在**外层**；与数组次序、谁先加载都无关。**只改写的面板不需要 `mount`**（`wraps` 和挂槽位互不影响：两个都写
就两件事都做）。

**三条纪律**（与别处逐字相同）：

- **用不了的声明拒整包**：未知组件（`CLIENT_WRAP_UNKNOWN_COMPONENT`，理由里会列出合法 id）、坏或缺 `mode`
  （`CLIENT_WRAP_BAD_MODE`）、坏形状（`CLIENT_WRAP_BAD_SHAPE`：不是数组 / 空数组 / 条目不是 `{ component, mode }` /
  同一组件两条 / 条数超过组件数 —— 一个组件一条链）。装载期再加两条：模块 import 不了（`CLIENT_PANEL_IMPORT_FAILED`）、
  模块没有 `wrap` 导出（`CLIENT_WRAP_NO_EXPORT`）—— 这时**整个面板不落地**，连它声明的槽位也不挂。
- **失败隔离，点名一次**：`wrap(ctx)` 抛异常、或什么都没返回（`null` / 不是函数），这一环就退回**它下面那一份**
  （最内层 = 引擎自己的组件），控制台一条 `CLIENT_WRAP_THREW` / `CLIENT_WRAP_NO_RENDER`（带包 + 面板 + 组件），
  一次渲染只报一条。**屏幕不会因为你的包坏掉而消失**。
- **不声明就没有成本**：没有包写 `wraps` 时，引擎渲染的还是它今天那一棵 vnode 树（不多一层、不多一次快照、不多
  一个 DOM 节点、不多一次重画）。

`wraps` 进内容哈希：只有 `mode` 不同就是两个摘要（同一个摘要不能有两种界面）。声明写进 `pack.json` 之后照旧随
`welcome.modPanels` 到达浏览器；模块 URL 与注册路由一字不动（`/workshop-panels/<包id>/<module>`）。

**当前状态**：形状层、装载期、传输与全部纯逻辑有测试（`test/modPanelWraps.test.js`：次序与合成、`replace`、
混合链、两个失败码、无声明零工作、快照脱钩、组件 id 表的漂移守卫）。浏览器里真的 import + 真的渲染在本机没有
Chrome 上跑不了 —— 那是 `SP_E2E=1` 的可选路径，与 §4.4 同一个 standing gap。

### 1.10 `i18n`：给**已有语种**补界面词条（B5 段已实现）

**它解决的是什么**：`packs/` 的 `lang` 类型只能**新增**一个语种 —— 一个包带 `en` / `ja` / `ko` / `zh-TW` 里的任何一个，
真实的扫描器都会整包跳过，原文是：

```
[packs] packs/quickchat-en/ skipped: the language en is already provided by public/i18n/en.json
```

同一个 fixture 换成全新语种 `pt` 就被正常登记（`quickchat-pt … 1 strings`）。而任何带新界面的包（新面板、新按钮、新提示）
都需要**给已有语种补键**，所以这是个结构性的缺口 —— 窄路（做成一个全新语种）解决不了它。

```json
// pack.json
{
  "id": "quickchat",
  "content": ["chess"],
  "i18n": { "en": "i18n/en.json", "ja": "i18n/ja.json" }
}
```

```json
// i18n/en.json —— 形状与 public/i18n/<code>.json 逐字相同：{ "<中文 msgid>": "<译文>" }
{ "我玩 {bond}": "I'm playing {bond}", "请给我 {chess}": "Can you send me {chess}?" }
```

**形状**：`i18n` 是对象，键是**语种码**（`shared/i18nPacks.js` 的常用大小写：`en` / `ja` / `ko` / `zh-TW` / `pt-BR` …），
值是**包内相对路径**、必须以 `.json` 结尾。源语言 `zh` 被拒（msgid 自己，没有语言文件可补，`I18N_SOURCE_LANG`）；
路径不是包内相对 `.json` 被拒（`I18N_BAD_FILE`）；语种码写错被拒（`I18N_BAD_LANG`）。**声明的文件必须在包里、必须是
JSON 对象、每个值必须是字符串** —— 任一不满足**整个包不加载**（与 `assets` / `client` / `server.preDispatch` 同一条
纪律，DESIGN §28.13.3）：一份读不出来的译文如果只是被跳过，作者看到的是「包加载了、我的词条没生效」。

**合并规则（三条，都有测试钉住）**：

1. **已有键绝不覆盖**。官方（`public/i18n/<code>.json`）里已经有的 msgid，值**原样留着**，你写的那一份只是被记下来。
   理由：这类补丁的来源常常是机器翻译或某个旧版官方文件，覆盖它等于让一个包**悄悄改掉**已发布的界面文案。
2. **冲突显式报告**。你的键与已有键**值不同**时，装载期与启动日志各报一条，点名**键 + 语种 + 包 id + 双方的值**：

   ```
   [workshop] i18n en "语音语言": kept the existing translation (pack "quickchat" wanted "Voice language")
   ```

   值相同的重叠**不是冲突**（它只是「这一条官方已经有了」），所以不会堆进报告 —— 报告的条数就是真要你处理的那几条。
3. **值是字符串**。非字符串（数组 / 对象）整包被拒（`I18N_BAD_VALUE`）：`t()` 会把非字符串原样打印到界面上，
   那是最难查的一类界面故障。

**服务面**：客户端读的一直是 `/i18n/<code>.json`（`public/js/ui/lang.js`），而 `public/i18n/<code>.json` **一个字节都不改**
（与 `data/*.json` 同一条纪律）。有包声明 `i18n` 的语种，这个 URL 送的是**合并体**（官方文件 + 这个包的新增键，
`_meta` 原样保留）；没有包声明的语种照旧走普通静态路径，字节不变。

**身份哈希**：声明的每一个 i18n 文件都**逐字节进包的身份哈希**（与 `client.panels[*].module` 同一条：能改变玩家看到的
东西的字节不该躲在摘要之外）。没声明 `i18n` 的包哈希逐字节不变（`docs/examples/` 三份真实包钉着）。

**今天没有的东西（照实说）**：`data/i18n/<code>.json`（**游戏文本**）不在这个通道里 —— 本字段只补界面词条
（`public/i18n/`）。要不要让包也给游戏文本补键是下一刀的裁决；`tools/i18n.mjs check` 也不检查包声明了却没被代码用到的键
（一个写错的键今天不会报错，只是永远不显示）。

---

### 1.11 `server.meta`：包写的**对局逻辑**（**A 段 + B 段已实现**）

`kits/<chessId>.js` 能给一名干员一套战斗行为，但它碰不到**对局**：它不会在 `onRoundStart` 触发、不能加盟约层数、
不能对商店刷新做反应。`server.meta` 就是给这一类代码开的口子 —— 它的形状与引擎自己的内容模块**逐字相同**：

```jsonc
"combat": true,                                   // 必填，见下
"server": {
  "meta": {
    "module": "meta/bonds.mjs",                   // 包内相对路径，必须 .mjs（服务端加载，浏览器不加载）
    "registers": ["bond:kazdelShip", "garrison:custom_*"]
  }
}
```

```js
// meta/bonds.mjs —— 与 server/sim/content/bonds.js 同形：一个 registerMeta(registry)
export function registerMeta(registry) {
  registry.bond('kazdelShip', {
    onRoundStart(ctx, ev) { /* 这一局开始时做点什么 */ },
    onGain(ctx, ev) { /* … */ },
  });
}
```

**三条硬规则**（设计全文见 [DESIGN §29](design/meta-payload.md)）：

1. **`registers` 是白名单，不是说明。** 注册表的规则是「**后注册的覆盖先注册的**」，而官方内容先注册 —— 所以一个
   没声明的键可能**悄悄顶掉官方的**处理器（例如 `bond:yanShip`）。运行时给你的是一个**受控注册表**：写一个不在
   清单里的键就抛，那一局这个包的作用**整份不生效并点名**，而不是「一半生效、一半静默」。清单里每项写法：
   * 精确键：`bond:kazdelShip`；
   * 前缀通配：**只能**在结尾带一个 `*`，例如 `garrison:custom_*` 覆盖那 13 个 `custom_*` 效果键。
   类别只能是七个之一：`garrison` / `band` / `bond` / `item` / `choice` / `effect` / `global`。
2. **必须声明 `combat: true`。** 这是业主裁决（2026-10-10）的落地：注入的服务端逻辑**不得成为对局结果的差异来源**，
   除非它声明 `combat: true` —— 那正是「进入房间摘要闸门 + 全员同集合 + golden 语料」这条线的入口。
   声明了 `server.meta` 却没写 `combat: true` ⇒ **整包不加载**并点名（`META_NEEDS_COMBAT`）。**这不是警告。**
3. **按房间装配，没有全局 set/restore。** 你的处理器只进**这一局**的注册表副本（`MetaRegistry.fork()`），
   进程级那一份永远不动。所以：状态放在**闭包**里（用传给 `registerMeta` 的那次调用捕获房间参数），
   **不要**去改共享的处理器对象；也**不要**写「开局前设全局、打完恢复」——多局并发会串味。
   房间没有声明任何带 `meta` 的包时，`Match` 的行为与从前**逐字节相同**（不做 fork）。

**代码纪律**：这个模块在**一局对局里**执行，所以它与引擎同一条确定性规则 —— 不得用 `Math.random`（用 `ctx.rng`，
那是对局自己的随机流）、不得读时钟（`Date.now` / `new Date` / `performance.now`）、不得碰 `process` / `globalThis` /
`eval`、不得收发网络。**静态扫描挡在 `import` 之前**：命中就**整包移出已加载集合**并点名（`META_BAD_SOURCE`，
规则与 `shared/kitAuthoring.js` 对 kit 的那一套共用同一份判据）。

**你拿到的两样东西**（`registerMeta(registry)` 的参数）：

| 给 | 说明 |
|---|---|
| `registry.garrison / band / bond / item / choice / effect / global` | 注册处理器（七个类别，与 `registers` 里写的键同形），另外 `register` / `unregister` / `get` / `has` / `keys` / `globals` |
| `registry.api` | 引擎辅助函数：`num` / `bondRecord` / `itemRecord` / `garrisonRecord` / `bandRecord` / `effectRecord` / `buffsOf` / `buffParams` / `itemKeyOf` / `isGoldenId`，外加 `version`（= `MOD_API_VERSION`）。**这是唯一的引擎入口** —— 模块里不许 `import` 引擎内部，一条爬出包目录的 `import` 会被静态扫描点名 |

处理器签名与官方内容模块一样：`(ctx, ev) => void`，`ctx` 就是 `server/match/effectsMeta.js makeCtx` 那个对象
（读：`bondActive` / `layers` / `board` / `hand` / `piece` / `chessRecord` …；写：`addFunds` / `grantItem` / `grantChess` /
`addLayers` / `setCounter` / `toast` / `offerChess` …；`ctx.rng` 是这一局的随机流）。钩子名就是 `HOOKS` 那 19 个
（`onRoundStart` / `onIncome` / `onPrepStart` / `onPrepEnd` / `onGain` / `onSold` / `onRefresh` / `onPrice` / `onBuy` /
`onSpend` / `onMerge` / `onLevelUp` / `onBattleStart` / `onBattleResult` / `onChoicePick` / `onEquip` / `onArt` /
`onDestroy` / `onLayers`）；写错的名字会进启动日志的警告（不会静默不跑）。

**当前状态（全部已实现）**：
* **A 段**：形状、点名拒绝、`registers` 归一化、`combat` 闸门、模块字节进身份哈希、装载期判「文件真的在不在」；
* **B 段**：启动时静态扫描 + `import`（模块 URL 带包摘要，换版本不会被模块缓存粘住）、受控注册表、逐包**试用副本**
  （失败的包连它注册到一半的键一起回滚）、多包抢同一个键时**包 id 小的持有**并点名（`META_KEY_TAKEN`，DESIGN §28.3）、
  `Lobby` 建对局时做 `fork()` 并作为 `Match` 的 `opts.registry` 传下去；
* 一个包都没声明 `server.meta` 时**连 fork 都不做**（`opts.registry` 根本不出现），行为与从前逐字节相同；
* 端到端验收：`test/packMetaWiring.test.js`（真服务器 + 真 `Match`，处理器派发、进程级那一份一个键都不多、装不上的包
  被移出已加载集合）与 `test/packMetaFanpack.test.js`（把 fanpack 的**准备阶段那一半**逐句移植成 meta 模块，按层里程碑
  发奖、计数器保证一步只结一次账）。

**装配期失败（注册了一个没声明的键）怎么办**：那个包的注册**整份回滚**并在启动/装配日志里点名，**对局照常开始** ——
不让一个包把整个房间变成不能玩。装载期就失败的（扫描 / import / 没有 `registerMeta`）更早：整包移出已加载集合，
它的内容也不并进游戏数据（与 `server.preDispatch` 同一个裁剪点）。

**写错的拒绝码**：`META_BAD_SHAPE` / `META_UNKNOWN_FIELD` / `META_BAD_PATH` / `META_BAD_MODULE` /
`META_BAD_REGISTERS` / `META_BAD_KEY` / `META_DUPLICATE_KEY` / `META_NEEDS_COMBAT` / `SERVER_EMPTY_MEMBER`；
装载期还有 `META_BAD_MODULE`（模块文件不在包里）。前八个在 `pack.json` 的形状层就拒，失败同样**整包不加载**。

### 1.12 `server.modules`：包的**服务端模块**（已实现）

一类与 `kits/` 并列、但契约**相反**的载荷。kit 是战斗里的代码，明写「不碰文件系统、不碰网络」；而社区插件包真正要做
的那几件事恰好相反 —— 停机播报与快照留档、匿名对局统计落盘、给 `/healthz` 加几个字段。以前它们只能靠**手改引擎
文件**；这一格就是那条不手改的通道。

```jsonc
"server": {
  "modules": [
    { "id": "ops",     "entry": "server/ops.mjs",     "uses": ["boot", "shutdown"], "write": true },
    { "id": "stats",   "entry": "server/stats.mjs",   "uses": ["matchClass"],       "write": true },
    { "id": "healthz", "entry": "server/healthz.mjs", "uses": ["healthz"] }
  ]
}
```

```js
// server/ops.mjs —— 一个 registerServer(host)
export function registerServer(host) {
  host.onBoot(() => host.io.write('state.json', JSON.stringify({ startedAt: Date.now() })));
  host.onShutdown(() => host.log.info('bye'));
  host.healthz(() => ({ boots: 1, tag: host.hash.slice(0, 8) }));
}
```

**四个挂载点**（`uses` 是闭枚举，写别的整包被拒）：

| 挂载点 | 拿到什么 | 何时跑 |
|---|---|---|
| `boot` | `host.onBoot(fn)` | 服务器**绑上端口之后**一次 |
| `shutdown` | `host.onShutdown(fn)` | 关闭流程里一次（失败只记日志，不阻塞停机）|
| `healthz` | `host.healthz(() => ({...}))` | 每次 `GET /healthz`（现算），字段进 `modHealth["<包id>"]` |
| `matchClass` | `host.matchClass(Base => Sub)` | 建对局时：按**包 id** 次序层层套在 `MatchClass` 上 |

**没声明的挂载点一碰就抛**（`MODULE_USE_UNDECLARED`），不是给一个 `undefined` —— 后者只会变成一行
`TypeError: not a function`，作者看不出是「没声明」还是「拼错了」。

**写盘要单独声明**（`"write": true`）：拿到的是 `host.io`，它被**限定在 `<状态目录>/mod/<包id>/`**（`SP_STATE_DIR`
优先，否则 `<仓库>/var`）。包自己的目录是只读的、引擎的目录根本不在门面里 —— `..` 与绝对路径一律
`MODULE_IO_BAD_PATH`，目录按需创建（声明了却从没写过，磁盘上不留东西）。

**`matchClass` 是唯一能碰到对局的挂载点**，所以只有它要求包声明 `combat: true`（`MODULES_NEED_COMBAT`）：一个
`MatchClass` 包装器原则上能改对局结果，而「要改结果的必须进房间摘要闸门与 golden 那条线」是业主裁决。只挂
`boot` / `shutdown` / `healthz` 的模块碰不到对局，不需要它。

**接收通道**（`"channels": ["borrow", …]`，DESIGN §28.23）：声明这个模块在对局里**接收**哪些包通道 —— 玩家从
包自己的面板（§1.9.6 的 `client.panels[].messages` + `pack.msg`）发出来的消息，在**转发之前**投给本房间进行中的
对局（`Match.handlePackMsg(playerId, { pack, channel, from, seat, data })`；`from` / `seat` 由平台从会话与座位
解析，载荷里自称的身份不作数）。四条判据：每条通道名必须与面板那半边**共用同一份名字形状**
（`PACK_CHANNEL_RE`）并**同时**被本包某个面板声明（否则没人发得出来，`MODULES_UNKNOWN_CHANNEL`）；最多 8 条
（`MODULES_TOO_MANY_CHANNELS`）；不许重复（`MODULES_DUPLICATE_CHANNEL`）；模块必须挂 `matchClass`（否则没有
接收人，`MODULES_CHANNELS_NEED_MATCH` ⇒ 整包仍须 `combat: true`）。**声明是可选的**：没写 `channels` 的模块在
归一化清单里不长这个键，包身份逐字节不变（DESIGN §28.2 的老账）。

**投递已收窄到声明过的通道**：装载结果把 `channels` 带出来（`server/modModules.js`），`server/index.js` 再从**裁后**
的服务端模块推出「包 → 接收通道集合」（`workshop.serverChannels`），大厅在 `pack.msg` 里查它 —— **本包的服务端模块
声明过这条通道，消息才投给对局**（`Match.handlePackMsg(playerId, msg)`，仍在限流之后、转发之前调，仍是 §28.14 的
那一次）。只被面板声明、模块没声明的通道**投都不投**：客户端发得出来（面板那半边 §1.9.6），对局收不到 —— 收窄只
影响「送不送进这一局」，**转发口径一字未动**。通道声明与接收方法两缺一（声明了 `channels` 却没挂 `handlePackMsg`）
在装载期记一条**点名**日志但**不拒包**：方法可以挂在构造器的实例上，静态看不出来。一个通道都没声明的包没有接收入口
（投递表里没有它这一行），行为与从前逐字节相同；收窄这一条由 `test/packMatchMsg.test.js` 钉住。

**`healthz` 的回执有界**：扁平对象、值只能是字符串/数字/布尔/`null`、最多 12 个字段 / 2KB；嵌套或超限的那一条被
**点名跳过**（其余字段照旧报到）。端点是给运维看的，不是数据通道。

**宿主还给你**：`host.pack` / `host.module` / `host.hash`（包的摘要，写进归档或播报里用）/ `host.dir`（包的目录，
只读，仅用于诊断）/ `host.log`（带 `[mod <包>/<模块>]` 前缀）。

**纪律：一个用不了的声明拒绝整个包**（与 §1.9 同一条）。`entry` 不在包里、不是 `.mjs`、import 失败、没有
`registerServer` 导出、或者挂了一个自己没声明的挂载点 —— 这个包**整份移出已加载集合**（与 `server.preDispatch` /
`server.meta` **同一个裁剪点**），它的数据也不并进游戏数据。没有任何包声明服务端模块时：`/healthz` 里没有
`modHealth` 这个键，一个字节都不多。

**模块字节进内容哈希**，层推导算 **B**（DESIGN §28.1 的三层表：它执行服务端逻辑）。`combat` 的推导仍然**只看
`kits/`** —— 只挂 `boot`/`healthz` 的模块不该被算成「可能改对局结果」。

**写错的拒绝码**：`MODULES_BAD_SHAPE` / `MODULES_UNKNOWN_FIELD` / `MODULES_BAD_ID` / `MODULES_DUPLICATE_ID` /
`MODULES_BAD_ENTRY` / `MODULES_BAD_USES` / `MODULES_DUPLICATE_USE` / `MODULES_BAD_WRITE` / `MODULES_TOO_MANY` /
`MODULES_NEED_COMBAT` / `MODULES_BAD_CHANNELS` / `MODULES_BAD_CHANNEL` / `MODULES_DUPLICATE_CHANNEL` /
`MODULES_TOO_MANY_CHANNELS` / `MODULES_CHANNELS_NEED_MATCH` / `MODULES_UNKNOWN_CHANNEL`（以上在形状层）；
装载期与运行期另有 `MODULES_NO_REGISTER` / `MODULES_IMPORT_FAILED` /
`MODULE_USE_UNDECLARED` / `MODULE_IO_BAD_PATH` / `MODULE_BAD_HOOK`。

### 1.13 `notices`：公告与鸣谢（已实现，服务端 + 声明）

**这一类缺的先是载体本身** —— 仓库里原本没有「公告」的任何形态。所以引擎先有了一份：公告**从 `CHANGELOG.md`
生成**（单一事实源：更新记录写在哪、公告就是什么，不手写第二份），鸣谢来自引擎自己的名单；两者与各包的声明合成
**一份**合并体，经 `/data/notices.json` 送出（走既有的合并数据通道，没有新路由）。

```jsonc
"notices": {
  "announcement": "notice/announcement.json",   // { version, date, summary, sections: [{ name, items: [] }] }
  "credits": "notice/credits.json"              // [{ name, note?, url? }]，url 只能 https://
}
```

**合并语义是「追加」**（与 `i18n` 的逐键覆盖刻意不同）：一个包一条**自己的**公告、一张**自己的**署名表，所以两个包
不会互相覆盖，引擎的也不会被包顶掉。合并体有上限（8 条公告 / 40 条署名 / 每条最多 12 小节 × 40 项）；挤到上限时丢的
是**引擎那一端最旧**的那几条 —— 玩家还没看过的一条包公告，比引擎更旧的那几条更该被看到（旧版说明在更新记录里永远
查得到）。

**从更新记录认什么形状**（`server/notices.js` 的 `engineAnnouncements`）：一节是 `## <版本> — <日期>`，**节内第一段
正文就是摘要** —— 它在第一个 `###` 之前还是之后都算；`### <名字>` 是小节，小节里的 `- ` / `* ` 行是条目。**没有
`###` 的节也发得出去**（`sections` 留空，公告只展示那一段摘要）：判据与客户端同一条 —— 有 `version` + `summary`
就能展示。**只有 `###`、连一段正文都没有的节仍然跳过**（不拿标题行顶上，那是猜）。发行 tag 把上游版本挂在标题
后面时（`## 0.17.0-0.2.4 — 2026-10-12`）两半都认。⚠️ 因此**带 `-<上游>` 的节与不带的那一节会显示成同一个版本号**
（`0.14.0-0.2.4` 与 `0.14.0` 都显示 `0.14.0`）—— 这是**刻意的**：面板上那个版本号是本仓库那一半，发行 tag 两半的
读法见 [README](../README.md) 的「版本号怎么读」。

**形状层判**：`notices` 只认这两个字段、至少写一个、路径必须是包内相对 `.json`（`NOTICES_BAD_SHAPE` /
`NOTICES_UNKNOWN_FIELD` / `NOTICES_EMPTY` / `NOTICES_BAD_PATH`）。**装载期判**：声明的文件必须在包里、可读、是合法
JSON，否则**整包被拒**（`NOTICES_BAD_FILE`，与 §1.9 同一条纪律）。**合并期判**：公告缺 `version`/`date`/`summary`、
署名条目没名字、`url` 不是 `https://` —— **点名跳过那一条**，其余照旧（这里的坏值只影响它自己，不必连坐整包）。

**字节进身份哈希**：声明的两份 `.json` 与 `i18n` 的译文文件走同一条（换了正文就是换了包）。

**客户端面板已实现**：登录页右上角的「公告」按钮打开 `public/js/ui/notices.js` 的面板，正文经**既有的**数据层读
`/data/notices.json`（`data.get('notices')`，与页面其它数据同一份缓存与重试）。客户端是**第二个读者**：形状不对的条目
在那边也被复判一次，最要紧的一条是**链接只认 `https://`** —— 一个包写 `javascript:` 或 `http:` 不会变成页面上一个可点
的链接（名字照旧展示）。包自己的面板也能读它（`notices` 在 `client.panels[].data` 的白名单里）。

**今天没有的东西（照实说）**：公告正文本身**还没有多语**（它跟着 `CHANGELOG.md` 走，与 `data/*.json` 的游戏文本
同一类东西）。正路是把这一类正文接进 `data/i18n/` 那条通道 —— 那是后续的一刀；编辑器的公告编辑入口也还没有（服务端与
声明这一半已就绪）。

### 1.14 房间声明了自己的集合之后（W-B / W-D，已实现）

**这一节没有新字段**：写它的原因是「房间可以只声明一部分包」这件事现在**真的生效**了，作者与玩家都会看到差别。

- **服务端（W-B）**：`room.create` 里的 `modIds` 只声明一个子集时，那一局跑的就是「**官方数据 + 这几个包**」——
  数据、`kits/`、`server.meta` 处理器都按这个集合物化（`server/roomAssets.js`，按摘要缓存、结果冻结）。没声明集合
  的房间（以及干净安装）拿到的仍是进程级那一份**本体**，逐字节不变。
- **客户端拿哪一份数据**：一个声明了集合的房间，它的对局数据从 `/room-data/<房间摘要>/<文件>.json` 取（那就是上面
  那份物化结果），而不是 `/data/*.json`（那一份是「官方 + 全部已装包」）。战斗模拟与界面都按房间那一份走。
- **入座仍然只判进程摘要**：入座前客户端还不知道房间里声明的集合，所以 `room.join` 判的还是 `welcome.mods.digest`
  —— 它证明的是「我们谈的是同一个包目录、同一批字节」。房间的集合随 `room.state.mods` 发给成员与旁观者。
- **本机对齐（W-D）**：成员在按「准备就绪」之前，客户端会核对**本地字节**能不能复算出房间声明的那些包摘要
  （缺文件、字节被改坏、或服务器根本没有这个包，都算没对齐），缺的可以就地补齐（`public/js/mods/align.js`，
  只下这个房间点名的包）。没对齐就不给准备按钮 —— 房间因此不会带着一个跑不起来的成员开打；**旁观者不受这条限制**。
- **对作者意味着什么**：一个包的 `combat` / 数据 / kit / meta 能改的东西，只有在房间**点名了它**时才生效。既是
  「不同房间可以跑不同组合」，也是「玩家下载的东西与那一局真正跑的东西一致」。

### 1.15 `server.battle`：包写的**战斗逻辑**（整场一份，已实现）

`kits/<干员id>.js` 是**一个干员**的代码。可一份真实 mod 的效果常常是**整场**的：「我方这个盟约的成员，对处于
眩晕 / 停顿 / 束缚 / 不动的敌人增伤」「凑够 6 名**不同**成员时全员加攻速、攻击额外带真实伤害」「某两件装备同时装备
时，每秒对范围内受控敌人造成伤害」。这些条件要读**玩家**、读**全场单位**、读**装备组合** —— kit 看不到别人，而给
42 名干员一人写一份 kit 也不现实。

```jsonc
"combat": true,                                     // 必须：它会改战斗结果
"server": { "battle": { "module": "battle/bonds.mjs" } }
```

```js
// battle/bonds.mjs —— install(battle)，与官方内容模块（content/bonds/*.js）逐字同形
import { num, bondRecord, buffParams, bondActive, isMember, playerOps, passiveBuff } from '@battle/index.js';

export function install(battle) {
  const bb = buffParams(bondRecord('kazdelShip'), 'env_gbuff_new') ?? {};
  for (const p of battle.players) {
    if (!bondActive(battle, p.playerId, 'kazdelShip')) continue;
    const members = playerOps(battle, p.playerId).filter((u) => isMember(battle, u, 'kazdelShip'));
    const set = new Set(members);
    battle.on('hit', (c) => {                       // 受控的敌人才吃增伤（数值只从黑板读）
      if (!set.has(c.source) || !c.dmg) return;
      const f = (c.target.s && c.target.s.flags) || {};
      if (!(f.stun || f.bind || f.noMove)) return;
      c.dmg.mul *= 1 + num(bb.base_damage_scale) + num(bb.damage_scale_per_stack) * battle.getPlayer(p.playerId).bonds.kazdelShip.layers;
    });
    if (battle.getPlayer(p.playerId).bonds.kazdelShip.tier >= 2) {
      for (const u of members) passiveBuff(battle, u, 'bond:kazdelShip:aspd', { aspd: num(bb.bonus_attack_speed) });
    }
  }
}
```

| 你能 import 什么 | 前缀 | 是什么 |
|---|---|---|
| `@battle/index.js` | `@battle/` | **战斗内容层的辅助函数**：`num` / `bondRecord` / `itemRecord` / `garrisonRecord` / `bandRecord` / `effectRecord` / `buffsOf` / `buffParams` / `bondActive` / `bondTier` / `bondLayers` / `isMember` / `onField` / `playerOps` / `itemsOf` / `itemKeyOf` / `hasItemKey` / `passiveBuff` / `directMods` / `fxOn` / `battleStore`（官方内容模块用的同一份） |
| `@sim/constants.js` `@sim/dir.js` `@sim/targeting.js` | `@sim/` | 三个纯函数模块（数值常数、方向、选中判定） |

`battle` 就是引擎的 Battle 对象，**能用的方法以 [docs/SIM.md](SIM.md) §6 为准**（`on` / `every` / `after` /
`addBuff` / `dealDamage` / `spawnEnemy` / `enemiesInKeys` / `allies` / `getPlayer` …）。**不能 import** `@kit/`
那一套干员构造器：这是战斗逻辑，不是干员 kit。

**判据**（与 `server.meta` 同一条线）：

- **必须声明 `combat: true`**，否则整包被拒（`BATTLE_NEEDS_COMBAT`）—— 改战斗结果的代码要进房间摘要闸门与 golden；
- 源码在 import **之前**过静态扫描：`Math.random` / `Date.now` / `fetch` / `setTimeout` / `process` / `globalThis` /
  `require` / `eval` 一律点名；import 只能走上面两个前缀（相对路径、`node:fs` 之类一律拒）；
- 模块文件必须真的在包里（`BATTLE_BAD_MODULE`）、导出 `install(battle)`（`BATTLE_NO_IMPORT` / `BATTLE_NO_INSTALL`）；
  装不上的包**整包移出已加载集合**，与 `server.preDispatch` / `server.meta` / `server.modules` 同一个裁剪点；
- 模块字节进内容哈希（换了代码就是换了包摘要）；
- **两端都跑同一段代码**：浏览器按 `/workshop-battle/<包>/<模块>` 加载它（源码原样、`@battle/` 由 import map 解），
  服务端复算也用同一份 —— 所以浏览器算出来的战果与服务端的对得上；
- 一个包抛异常只记一条内容错误（点名是哪个包），**不让整个战场起不来**；
- 房间声明了集合时只有**它点名的包**的 installer 参与（W-B，见 §1.14）。

### 1.16 我到底能用哪些东西？（表面清单）

一个包能依赖的**全部**东西写成了一张表：[`docs/MOD-SURFACE.md`](MOD-SURFACE.md)。每一行是一格「表面」——
一条 `pack.json` 声明、承载它的引擎符号、实现文件、钉死它的测试、定义它的设计稿小节；机读版本是
`shared/modSurface.js`，守卫是 `test/modSurface.test.js`。

作者只需要知道两件事：

- **这一格属于哪一代 ABI**：用 `pack.json.api` 声明你要的世代（`>=1 <2`、`1.x`…），数字见
  `shared/constants.js MOD_API_VERSION`（见 §1.9 的 `api` 那一节）。**加一格不抬世代**，所以老包不会因为引擎变强
  而被拒；
- **用这一格还要满足什么**：表里每行都有 `requires`（例如 `server.battle` 要 `combat: true` 且两端跑同一段字节）。

写了一个引擎**没有**的格子不会静默：顶层键与 `server` 成员都是闭集，加载期点名拒绝
（`PACK_UNKNOWN_FIELD` / `SERVER_UNKNOWN_FIELD`）。

---

### 1.17 时装（`skins`）：一套外观的**数据**在包里

到这一刀之前，`skins` 是「顶层键闭集」里被点名拒绝的那一格（`PACK_UNKNOWN_FIELD`），作者只能借 `art.chars`
给一名干员换**唯一一套**素材。现在它是一个真字段：**一个包可以给一名干员带来好几套外观**，由玩家选哪一套。

```jsonc
{
  "id": "my-outfits", "name": "我的时装", "license": "CC0-1.0", "content": [],
  "skins": [
    {
      "id": "summer",                    // 包内唯一，≤32，字母/数字/_/-
      "charId": "char_1_01",             // 这套是给谁的（必须在你的包或官方数据里存在才有画面）
      "name": "夏日余韵",                 // 显示名（必填）
      "series": "夏季系列", "desc": "作者给玩家看的说明",   // 可选
      "art": {                           // 与 art.chars 的一条**同形**（同一套解析器、同一套拒绝码）
        "portrait": "outfits/summer/p.png", "avatar": "outfits/summer/a.png",
        "spine": { "front": { "skel": "outfits/summer/m.skel", "atlas": "outfits/summer/m.atlas" } }
      },
      "voices": { "start": ["outfits/summer/start.mp3"] }
    }
  ]
}
```

| 判据 | 说明 |
|---|---|
| 字段闭集 | `SKIN_FIELDS` = `id` / `charId` / `name` / `series` / `desc` / `art` / `voices`，一个不多一个不少；写别的名字**点名拒绝**（`SKIN_UNKNOWN_FIELD`） |
| `id` 与 `charId` | `SKIN_ID_RE`（≤32 字符、不许下划线开头）；同一个包里两个同名 `id` ⇒ `SKIN_DUPLICATE_ID` |
| `art` | 路径必须是包内相对路径（`ART_PATH_UNSAFE`）；spine 要齐 `skel` + `atlas`（`ART_SPINE_INCOMPLETE`）。有 `assets/` 就要声明 `license`（与 art 同一条） |
| 贡献项 | **只带时装、`content: []` 的包合法** —— 一套时装就是这个包带来的东西（空数组仍 `EMPTY_PACK`） |

落点是**清单**：`assets.skins[<charId>] = [{ pack, id, name, series?, desc?, art?, voices? }, …]`（按干员分组的
一列；同一干员可以有几套）。两个包给同一干员的**同一套 id** 时按包 id 升序第一个赢，输的一方点名
`SKIN_COLLISION`。路径与其它素材通道逐字相同：变成 `/workshop-assets/<包>/<路径>`，只服务登记过的 URL。

**引擎不认识「皮肤」。** 它做两件事，第三件由包自己做：

1. **数据**：把上面的声明并进 `assets.skins`（`mergeWorkshopSkins`）；
2. **一个中间层接口**：C 层面板可以导出 `appearance(ctx)` 返回 `{ lookup(kind, charId, id) }`，注册成**外观
   提供者**（一个进程最多一个，后注册者被拒）。引擎把**不透明 id** 连同**这条链的 kind**
   （`'portrait'` / `'avatar'`）交给它问一次 —— 那个 id 是不是一套时装、属于哪个包，是提供者自己的事；
   提供者只回答**被问的那一条 kind** 的一张图（`{ portrait }` 或 `{ avatar }`），另一条 kind 没图就回
   `null`，由链回落官方；
3. **哪一套生效**：完全在提供者（也就是那个 mod）里 —— 它自己读偏好、自己决定回落。**偏好按 kind 分开记**
   也是它的事（`skin-picker` 用 `skin:portrait:<charId>` / `skin:avatar:<charId>` 两格，旧键
   `skin:<charId>` 仍作公共退路）：引擎侧只负责「按 kind 问」，不认识「皮肤」，也不认识偏好键。

解析链（`public/js/ui/portraitChain.js`）里那一次提问在 `_1`/`_2` 后缀那一步**之前**（「提供者先说话」），
所以提供者给出的那一套优先于 `chars` 里同名的条目；提供者给 `null`、抛错、或给一个没有可用字段的对象时，
**继续走原来的链**（回落原版立绘，画面照旧）。

**优先级：调用方显式点名的变体 > 提供者的选择 > 官方回落。** 调用方点名版本的三种写法 —— `id` 以 `_2`
结尾（精锐）/ `_1` 结尾（一阶）、`chess.isGolden`（详情页 / 商店卡的精锐立绘）、显式传 `{ variant: 'elite' }`
—— 都让提供者**一次都不被问到**：别人明确要精锐立绘时，不该被一份只有一张头像图的时装盖掉。头像那一条
kind **不看 `isGolden`**（精锐头像由调用方自己传变体），所以时装在头像上照旧生效 —— 这就是「立绘与头像
分开受控」。

**玩家可以整个关掉它**：设置 →「工坊外观」（`settings.workshopSkins`，默认开）。关掉时解析链与没有这一步
逐字相同 —— 房主把开关关掉，结果与不装包一致（`test/ui/portraitChain.test.js` 两个方向都钉）。

三样东西一起才有一张会变的图：**一个声明了 `skins` 的包** + **一个注册了外观提供者的面板**（它决定哪一套生效）
+ **开关打开**。只装数据包（例如只带 271 套时装的目录包）不会有任何画面变化 —— 启动日志里那一行会写出
`N outfits`（`workshopSummary`），所以「装了但没反应」在第一行日志里就看得见。

自检：`node tools/workshop-validate.mjs <包目录>`（形状）；`node --test test/workshopSkins.test.js`
（声明 → 清单 → 冲突 → 只带时装的包真的被装上）；`node --test test/ui/portraitChain.test.js`（链的两个方向）。
设计稿：[`docs/design/mod-layer.md` §28.28](design/mod-layer.md)、[`docs/MOD-SURFACE.md`](MOD-SURFACE.md) 的 `skins` 一行。

---

### 1.18 `server.room`：包写的**房间级钩子**（已实现）

到这一刀之前，一个包能挂的服务端载荷有四类：`server.modules`（进程启动）、`server.preDispatch`（一次 HTTP 请求）、
`server.meta`（一局的商店 / 经济）、`server.battle`（战场）。**没有一样覆盖房间本身** —— 房间被创建、有人加入或离开、
有人加入观战、一局开始或结束、房间被销毁。参考社区插件包就是手改 `server/lobby.js`（+687/−14 行）补的这些行为。
`server.room` 就是给这一类代码开的口子：**一个包一份，每个房间跑一次**。

```jsonc
// combat: true 不是必须的 —— 房间钩子只观察，它改不了对局结果（见下面的「闸门分类」）
"server": { "room": { "module": "room/hooks.mjs" } }
```

```js
// room/hooks.mjs —— install(room)：拿到的是这个房间的**只读观察面**
export function install(room) {
  room.log.info(`房间 ${room.id} 起来了，模组集合 ${room.modIds ? room.modIds.join(', ') : '(进程级)'}`);
  room.on('join', ({ by }) => room.log.info(`${by.name} 进来了（座位 ${by.seat}）`));
  room.on('matchEnd', ({ matchNo, victory }) => room.log.info(`第 ${matchNo} 局结束，胜=${victory}`));
  room.on('dispose', ({ reason }) => room.log.info(`房间没了（${reason}）`));
}
```

`install(room)` 收到的东西，一条一句理由：

| 成员 | 是什么 | 为什么给 |
|---|---|---|
| `room.id` | 4 字母房间码（`room.code`） | 包要能把自己的日志 / 播报对上某个房间 |
| `room.modIds` | 这个房间声明的模组 id 数组（**冻结**），没声明集合时是 `null` | W-B 之后「这个房间跑哪几个包」是房间里最重要的一件事，包要能看见 |
| `room.players` | 本包 `install` 那一刻的**座位快照**数组（冻结），每项 `{ playerId, name, seat, isBot, ready, connected, left }` | 只读名单：机器人和真人一眼分得开，而包拿不到活的座位对象 |
| `room.spectators` | 同一刻的观战者快照（`{ playerId, name, connected }`） | 观战是这一版有的一档，播报 / 统计要数得上 |
| `room.player(seat)` | 按座位号取一条上面的快照（空位给一个空对象，不是 `undefined`） | 少了它，包要自己写 `find`；多给一个方法比让作者自己遍历安全 |
| `room.phase()` | `'lobby'` 或 `'match'` | 「现在是不是在对局里」是最基本的判断，读一个字符串比读内部字段好 |
| `room.now()` | 与大厅同一个时钟（毫秒） | 播报 / 采样要时间戳，而**不能**是 `Date.now()`（进程内要一致，见下面的扫描） |
| `room.on(event, fn)` | 订阅一个生命周期事件，返回 `true` / `false`（名字 / 函数非法时点名 + `false`） | 观察通道；名字是**闭枚举**，拼错会被点名（`ROOM_UNKNOWN_EVENT`），不会静默不动 |
| `room.off(event, fn)` | 退订（`on` 是稳的：同一个函数注册几次就是几个钩子） | 一次性钩子（例如「只报第一局」）要收得回来 |
| `room.log.{info,warn,error}` | 带包名与房间码前缀的日志 | 一条日志必须归属到「哪个包的哪个房间」，否则运维分不开 |

**8 个事件**（`create` / `join` / `spectate` / `leave` / `matchStart` / `matchEnd` / `matchFailed` / `dispose`），触发顺序就是
引擎的调用顺序，每个事件的载荷：

| 事件 | 何时 | 载荷 |
|---|---|---|
| `create` | 房间**完全建好**之后（房主就位、集合已物化、`room.state` 已广播） | `{ room, by }` |
| `join` | 一个新的人类拿到玩家座位（重复 `room.join` 不算） | `{ room, by }` |
| `spectate` | 一个新观战者入座 | `{ room, by }` |
| `leave` | 任何永久性离开：`room.leave`、被踢、观战者被移除、大厅宽限超时、连接过期 —— **在座位释放之前**触发 | `{ by }` |
| `matchStart` | 一局真的起来了（`match.start()` 跑完且没抛） | `{ matchNo, mode, difficulty, seed, players, spectators }` |
| `matchEnd` | 一局结束（座位清理之前） | `{ matchNo, summary, victory, players, spectators }` |
| `matchFailed` | 这一局没起来（构造 / `start()` 抛了） | `{ matchNo, error }` |
| `dispose` | 房间被销毁（最后一个事件；此时 `room.disposed` 已经是 `true`） | `{ reason, room }` |

`by` 是一条**座位快照**（与 `room.players` 里的条目同形）；`room` 是那一刻的房间状态快照（`room.state` 的字段，
去掉线格式的 `t` 与 `mods`）；`players` / `spectators` 是 id 数组。

**闸门分类：房间钩子不需要 `combat: true`。** 判据是**能力**而不是意图 —— `install(room)` 拿到的每一件东西要么是
只读快照、要么是订阅，`on(...)` 回调的**返回值被忽略**，所以这一层没有一件能力能改「谁在玩 / 装了什么 / 这一局的
结果」。因此它**不**进房间摘要闸门、**不**进 golden 语料（把它算进去只会让一个只做观战播报的诚实包被推成
`combat: true`，把那条线稀释掉）。反过来是硬规则：**将来这一层若交出任何一件能改那三样中任一样的东西**
（「按包自己的规则拒绝一个人进房」「按包的点名换掉这一局的集合」），那件东西**必须**要求 `combat: true`
（DESIGN §28.20 的分类规则），因为那时它就不再是观察面了。

**房间钩子仍然做不到什么**（这一层有意不开口子的东西）：

- **改不了对局结果**：拿不到 Battle、拿不到 `Match`、拿不到 store、拿不到 socket，也没有任何写入口；
- **改不了谁在玩**：座位快照是拷贝，`room.on` 的回调没有返回值语义 —— 包不能让谁进来、也不能把谁踢出去；
- **改不了装了什么**：`room.modIds` 是只读的，集合在房间建起来那一刻就定死了（那条路是 `room.create` 的 `modIds`）；
- **碰不到文件系统与网络**：源码在 import **之前**过静态扫描（`process` / `require` / `fetch` / `setTimeout` /
  `Date.now` / `Math.random` / `globalThis` … 一律点名），import 只能走 `@sim/`；
- **不是协议层**：包不能新增或拦截任何客户端消息（那是 `server.preDispatch` 与 C 层包通道的事），也不能给某个玩家
  发一帧（没有 `send`）。

**判据**（与 `server.battle` 同一条线，只有 import 面更窄）：

- 模块必须是包内相对 `.mjs`（`ROOM_BAD_MODULE` 管扩展名），声明的文件必须真的在包里（`ROOM_BAD_MODULE` 整包被拒）；
- 模块必须导出 `install(room)`（`ROOM_NO_INSTALL`）；
- 源码在 import **之前**过静态扫描，非确定性 / 环境绑定一律点名（`ROOM_BAD_SOURCE`）；
- **import 只有 `@sim/`**（`@sim/constants.js` / `dir.js` / `targeting.js` 三个纯函数模块）——`ROOM_BAD_IMPORT`。
  **刻意不新开 `@room/` 前缀**：白名单前缀是**两端共用**的一张表（`kitImportMap()` 与 `public/index.html` 的 import
  map 由测试钉在一起），而这个模块**只在服务端**跑 —— 为一个永不进浏览器的模块在浏览器侧开一个命名空间，正是这一层
  到处在拒绝的「声明了却没有」。`@battle/` 也不开放：那是战场辅助函数，房间钩子是观察面；
- 模块字节进内容哈希（换了代码就是换了包摘要 —— 房间的摘要闸门靠这一步对齐）；
- 装不上的包**整包移出已加载集合**，与 `server.preDispatch` / `server.meta` / `server.modules` / `server.battle`
  同一个裁剪点；
- **一个钩子抛异常只记一行**（`ROOM_HOOK_THREW`，点名**包 + 钩子**），建房、加入、对局结束照旧完成 ——
  一个包坏掉不能让真人卡在房间里；
- 房间声明了集合时，只有**它点名的包**的房间钩子在这个房间里装上（W-B，见 §1.14）；一个包都没声明时，
  大厅连一张表都不建（干净安装与从前逐字节相同）。

完整规范（成员表、分类规则、隔离、测试）见 [docs/design/mod-layer.md](design/mod-layer.md) §28.20。

---

### 1.19 形态（`forms`）与静态相位（`fx.silentPhases`）：渲染器的两条**行为增量**

这两条是给「包自带干员 / 怪物有自己的变身形态，或者自己的相位不该撒通用特效」准备的。两条通道的规矩一样：
**引擎里第一方那张表一个字节不动，你的声明只做增量**。

#### `pack.json.forms` —— 形态（clip set）

> ⚠️ 这一节的 `forms` 与 `units.json` 里那组 `forms`（干员的**档位**，`2/1/4/0` 那种键，见 §1.4 的「哪条档位算
> 普通、哪条算精锐」）**不是同一件东西**，只是同名的两个字段：这一节说的是**渲染用的 clip 集**
> （`spine id → 形态名 → roles`），与 `diy.slots` 那一对记录没有任何关系。

引擎里 `public/js/render/units.js` 的 `FORMS` 是一张**冻结的常量**：按 spine id（就是 `assets.spine` / 怪物 /
召唤物自己的 id）键，值是「形态名 → `{ change, end, leave, next, roles }`」。sim 发一条 `'phase'` 特效带
`form` 字段时，渲染器就用它换 clip 集（掠海漂移体的爬行模式、转译基底的变身、首领的重生……）。

包能声明**引擎没有的**形态：

```json
{
  "id": "my-pack", "name": "…", "version": "0.1.0", "license": "CC0-1.0",
  "content": ["chess"],
  "forms": {
    "chars": {
      "char_ws_hero": {
        "shift":   { "change": "Start_B", "end": "Die_B", "next": "shifted",
                     "roles": { "idle": "Idle_B", "die": "Die_B_2", "move": { "loop": "Move_B" } } },
        "shifted": { "roles": { "idle": "Idle_C", "die": "Die_C" } }
      }
    }
  }
}
```

| 键 / 字段 | 说明 |
|---|---|
| `forms.chars` / `.enemies` / `.tokens` | 三张表，与 `art` 的对象表同一组（形态说的是 spine 模型） |
| `<spine id>`（第二层键） | 渲染器查找用的那个 id：干员的 `assets.spine`、怪物自己的键、召唤物 id |
| `<形态名>`（第三层键） | 自己起的名字，字母开头、字母数字下划线。**它就是 sim 的 fx 里 `form` 的值** |
| `change` | 进这个形态时先放一遍的过渡 clip（可省 / `null` = 直接切） |
| `end` | 这个形态结束前放的收尾 clip（配合 fx 的 `dur`） |
| `leave` | 离开这个形态时放的 clip（例如傀儡师换回本体） |
| `next` | `end` 放完之后落到**同一个 spine id 上**的哪个形态（必须是已声明的，否则 `FORMS_NEXT_UNKNOWN`） |
| `roles` | 这个形态的 clip 集：`idle` / `deploy` / `die` / `stun` / `move` / `attack` / `skill`，值是 clip 名字符串、`null`、或 `{ begin, loop, end }`。`{}` = 这个形态什么都不画（合法） |

**两条你会撞上的规则**：

1. **第一方的形态名不许覆盖。** 引擎已经有 `enemy_1040_bombd` 的 `bombed`，你就不能在自己包里再声明一个
   `bombed` —— 那样写**整包被拒**（`FORMS_FIRST_PARTY_OVERLAP`）。想要自己的形态，起一个自己的名字
   （或者用自己的 spine id）。这是刻意的：一份「写了却不生效」的声明比一条报错坏得多。
2. **两个包撞同一个 `spine id + 形态名` 时，包 id 小的赢**（`FORM_COLLISION` 点名），与 `art` / `skins` 同一条规则。

不合法一律**报错**，不静默丢弃：表名错 `FORMS_UNKNOWN_TABLE`、形态名形状错 `FORMS_BAD_KIND`、clip 名不是字符串
`FORMS_BAD_CLIP`、`roles` 缺 / 键不认识 / 值不是字符串 `FORMS_MISSING_ROLES` / `FORMS_BAD_ROLES`、
`next` 死链 `FORMS_NEXT_UNKNOWN`、字段名写错 `FORMS_SPEC_UNKNOWN_FIELD`。

#### `pack.json.fx.silentPhases` —— 「这个相位不要通用特效」

`'phase'` 种类的特效默认会撒一层通用光效。有些相位是**模型自己就表示**的（引擎第一方有 `bombed` 与
`warning` 两个），那些不放特效。你自己包的相位种类可以加进来：

```json
"fx": { "silentPhases": ["helmLow", "spinStop"] }
```

- **并集**：引擎第一方那两个永远静默，你只能**加**，取消不了（这一点与 `forms` 的「第一方优先」不同 ——
  静默与否没有「同名覆盖」这回事）；
- 每一项必须是非空字符串（`FX_BAD_SILENT_PHASE`），`fx` 里写别的字段会被点名拒绝（`FX_UNKNOWN_FIELD`）；
- `"fx": { "silentPhases": [] }` 是合法但**什么都不做**的声明（与 `"routes": []` 同义），所以它不算贡献项 ——
  一个只带它的包仍然会被判成空包。

#### 怎么验证

```bash
node tools/workshop-validate.mjs workshop/<你的包>     # 形状不合法一律点名（两条通道都在这一层判）
node --test test/packForms.test.js
```

完整规范（判据逐条、合并规则、为什么第一方优先）见 [docs/design/mod-layer.md](design/mod-layer.md) §28.29。

---

### 1.20 变体 / 口径（`variants`）：同一份数据的另一套数值 + 一个开关

**它解决什么**：一个社区 mod 反复撞上的那面墙（§1.1 那张表的第一行）——「满练度 / 12 部署位」这类**可切换口径**：
同一份数据、两套表现，由玩家/房主选一套。从前 `variants` 是 `PACK_UNKNOWN_FIELD`（整个包被拒），
而它想做的事在包里**没有通道**。

**它不是什么**（这一条比上面那条更重要）：**它不是一个「包可以覆盖任意数值」的通道**。一个能指定任意文件覆盖的
包格式就是安装器 —— `official` / `config` / `meta` / `shared` / `theme` / `serverModules` 那六格的判断逐字适用。
所以这一层收成**闭枚举的口径声明**：包说的是「哪一套」，**不是「改成几」**。
（**0.18.6 起有半个例外**：包可以给它**自己带来的**记录写另一套口径**数值** —— 走 `content: ["variants"]` +
`variants.json`，三条守卫见下面的 §1.20.1 与 [design/mod-layer.md](design/mod-layer.md) §28.51。官方记录的数值
仍然只能由引擎自己给。）

```jsonc
{
  "id": "my-pack", "name": "满练度", "content": ["chess"],
  "combat": true,                                  // ← 硬闸门：口径改对局结果，必须标（VARIANTS_NEED_COMBAT）
  "variants": [
    { "axis": "deploy",   "default": "max" },      // 12 个部署位（官方 8）
    { "axis": "training", "default": "full" },     // 引擎缺省的满潜能 / 精英2 Lv.60
    { "axis": "form",     "default": "elite" }     // 普通干员按精锐形态出战（第 6 刀）
  ]
}
```

**首发三条轴**（`shared/variants.js` 的 `VARIANT_AXES` —— 一个轴只在这份表里，一个数只有一个真相）：

| 轴 | 选项 | 缺省（= **引擎今天的行为**） | 它动什么 |
|---|---|---|---|
| `training` | `official` / `full` | `full` | 这一局用哪一套练度。落点是引擎**已有的** `room.loadout.ops`（干员调配：潜能 1–6 与 未精英化→精英2 Lv.60，`shared/potential.js`），不是在数据里塞第二套数值 |
| `deploy` | `official` / `max` | `official` | 部署位：`official` 是数据里的 8（官方 `maxBattleChessCnt`），`max` 抬到 `shared/constants.js` 的 `DEPLOY_CAP_MAX` = 12（与销毁类装备的天花板同一个常量） |
| `form` | `official` / `elite` | `official` | 干员形态投影（第 6 刀）：`elite` 时每条**普通（`_a`）**棋子按它精锐兄弟（`_b`）的**战斗职能**出战 —— `stats` / `trait` / `skill` / `skills` / `talents` / `module` / `modules[]` / `assets` 取自**引擎自己的** `_b` 记录（`shared/formProjection.js`）。身份与价格**都不动**：棋子 id、`tier`、`price`、盟约、特质、`upgradeNum` 仍是 `_a` 那一份 |

**`form: "elite"` 要如实知道的三件事**（业主裁决 2026-10-13，三条都是**刻意的**，也是它必须标 `combat: true` 的理由）：

1. **数值全部由引擎自己烘，作者一个数都不许塞**。这一条不是限制、是这一层存在的理由：投影从**引擎自己的** `_b`
   记录读值。同一个想法在安装器时代是「把 `official.json` 里那 258 条的数值搬过来」—— 那套数比引擎今天**低**
   （投稿 `e4fe4d5cf0a0` 给 `chess_char_1_01_a` 的 `atk` 是 497，引擎的 `_b` 是 531），照搬会**静默降级**干员。
   所以 `variants` 里**没有**任何数值格，这一层也**没有**数值通道。
2. **1 阶价拿到精锐形态的数值**。`_a` 的价格 / 阶级不动 ⇒ 一枚 1 阶的普通棋子带着精锐的 `atk` / 技能 / 模组天赋上场。
   这是投影**只改职能**的直接后果，**不是 bug**，但它确实改平衡 —— 声明它的包必须标 `combat: true`，也必须让玩家
   知道。
3. **`upgradeNum` 不动 ⇒「3 张 `_a` 换 1 张 `_b`」在投影下是价值中性的**。`_a` 已经带着 `_b` 的数值，所以合成出来的
   那一张与合成前的一张**一样强**（合成仍然合法、仍然按既有的 3 张规则走）。同样不是 bug：投影改的是战斗职能，
   不是合成经济；改它就越出这个声明的范围。

**召唤物同一个轴**：`data/tokens.json` 里 owner 变体有 `_a` / `_b` 一对的召唤物（本季 19 个），`_a` 的 owner 变体
在 `form: "elite"` 下换成 `_b` 的那一条 —— 只投干员不投召唤物是自相矛盾的。没有 `_b` 变体的召唤物原样不动。

**`status` 留在 `_a`**：`status`（`phase` / `level` / `skillLevel` / `equipLevel`）是那块地的**身份**，不是战斗数值 ——
引擎从它读补位形态（`shared/standIn.js` 的 `statusKey`）、模组激活与技能档位。战斗数值由烘好的
`stats` / `skill` / `talents` / `modules` 承担（`_a.skills[]` 里每条的 `level`、`_a.skill.level` 都跟着精锐走）。

**三条硬判据**：

1. **闭枚举、响亮失败**。轴名不认识 ⇒ `VARIANTS_UNKNOWN_AXIS`；选项名不认识 ⇒ `VARIANTS_UNKNOWN_OPTION`；
   形状 / 未知字段 ⇒ `VARIANTS_BAD_SHAPE`；非字符串的 `default` ⇒ `VARIANTS_BAD_DEFAULT`；同一个轴写两遍 ⇒
   `VARIANTS_DUPLICATE_AXIS`。**每一条都是整包拒绝**，不是忽略、也不是回落到缺省。
2. **缺省逐字节不变**。不声明 `variants` 的包，归一化清单里**不长出这个键**（多一个键会让所有已发布包的内容哈希
   全变，房间的摘要闸门随即误判，DESIGN §28.2）；`GameData` 拿不到口径时 `deployCap` 逐字是数据里那个 8。
   而**声明了口径就必须进内容哈希**：只差口径的两份包摘要必须不同 —— 同一个摘要下两种对局行为是不允许的。
3. **必须标 `combat: true`**（`VARIANTS_NEED_COMBAT`）。判据是**能力**而不是意图：一条能改结果的口径声明，
   必须进房间摘要闸门与 golden 语料（与 `server.meta` / `server.battle` / `modules[].uses: ["matchClass"]` 同一条线）。

**不是**贡献项：一个只声明了 `variants` 的包照旧 `EMPTY_PACK`（与 `support` / `playtest` 同一个语义 —— 口径选的
是引擎已有的一套表现，不是内容）。

**多包抢同一个轴**：按既有的「包 id 字典序小的赢」（§1.2、DESIGN §28.3），输的一方会被**点名**报告。

**落点**：`training` 落在引擎已有的练度开关上；把一名普通干员的**精锐形态**投影给它（投稿 `e4fe4d5cf0a0` 的
`training` 一段真正想做的那件事）落在 `form` 轴上 —— 它在第 6 刀立项并落地（见上面那条与
[docs/design/mod-layer.md](design/mod-layer.md) §28.41）。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.39（口径层）与 §28.41（形态投影）。

#### 1.20.1 口径**数值**：`content: ["variants"]` + `variants.json`（0.18.6，DESIGN §28.51）

上面那一层只让包说「**哪一套**口径」，值由引擎自己给。它对**官方记录**够用，对**包自己带来的记录**不够：
一个新棋子 / 新召唤物是作者手写的，引擎没有它的第二套数值（`potDown` 只能从满潜往下降）。这一格补的就是
那半个缺口 —— 投稿 `c26a6ed4c1e7`（卡兹戴尔多功能）的 `variants.json`（`training.chess` 28 条 +
`training.tokens` 4 条）走的正是它。

```jsonc
// pack.json
{ "content": ["chess", "tokens", "variants"],
  "combat": true,                                  // 与 §1.20 同一个硬闸门
  "overrides": ["chess:chess_char_6_12_a"],         // 撞官方 id 的仍要走 overrides
  "variants": [{ "axis": "training", "default": "full" }] }

// variants.json —— 三层闭合枚举 + 字段级补丁
{ "training": {                    // ① 轴名：VARIANT_AXES 的键，而且**这个包必须声明过它**
    "chess": {                     // ② 数据文件：WORKSHOP_CONTENT_FILES 的名字
      "chess_char_9_01_a": {       // ③ 记录 id：装载期必须已经在合并后的数据里
        "stats": { "atk": 676 } } } } }   // ④ 只许写目标记录**已经有**的键
```

**它**不是**什么，比它是什么更重要**：它**不是**一条「包可以覆盖任意数值」的通道（§1.1 那张表对 `official` /
`config` 的判断逐字仍成立）。三条守卫每一条都是**具名整条拒绝**，不是忽略：

1. **不能发明记录** —— 目标 `<文件>:<id>` 必须已在合并后的数据里，否则 `VARIANTS_TARGET_MISSING`。
   要新增记录请走 `content`（新 id）或 `overrides`（官方 id）。
2. **不能发明字段** —— 补丁只能写目标记录已有的键（与 `overrides` 的 `UNKNOWN_OVERRIDE_FIELD` **同一份**判据
   `unknownOverrideKeys`），否则 `VARIANTS_UNKNOWN_KEY`。
3. **不能发明轴** —— 表名不在 `VARIANT_AXES` ⇒ `VARIANTS_UNKNOWN_AXIS`；表名合法但这个包**没有**在
   `pack.json.variants` 里声明它 ⇒ `VARIANTS_UNDECLARED_AXIS`（一张没人声明过的表永远不会被应用，
   那正是本层要消灭的失败方向，所以它是拒绝而不是跳过）。写错的数据文件名 ⇒ `VARIANTS_UNKNOWN_FILE`。

**合并语义**：**覆盖**（字段级），不追加。补丁走引擎**同一份** `mergeRecord`（对象递归、`OVERRIDE_REPLACE_KEYS`
与数组整块替换、`talents` 一类按身份键合）。**生效条件**是既有的那条：这个轴按「包 id 字典序小的赢」落到
**这个包**头上；被别的包抢掉时这张表不应用，但会**具名**记进装载报告的 `variantPatches`（启动日志里
「写进去的 N 条」与「被抢掉的 N 张」分开印）。

**不是**贡献项这条不再成立：口径**数值**是真的往对局里带数值，所以 `content: ["variants"]` 的包**不是**
`EMPTY_PACK`；只声明轴、不带 `variants.json` 的包仍然是（与 `support` / `playtest` 同一条语义）。

**它只在装载期生效**，不接管玩家自己的「干员调配」练度开关（`training` 轴今天的行为一字未改）。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.51（含两处如实写下的边界：投稿原件的 patch 是
**深层合并**、引擎的 `mergeRecord` 对 `skill` 一类是**整块替换**，所以「按本通道装包」要把那些分支写成完整值；
以及 `talents` 按 `index` 合会留下官方的潜能链）。

### 1.21 素材加载源：`assets.mirrors[]` + `sources(ctx)`（第 5 刀，`0.16.0`）

「让包真的换掉取素材字节的主机」由**两半**组成，拆开任一半都不成立：**`assets.mirrors[]` 说哪些镜像被允许**，
**面板模块导出的 `sources(ctx)` 说先试哪一条**。

#### 声明（数据那一半）

```jsonc
"assets": {
  "container": "packs/resources-0.1.0.spresources",
  "manifest": "resource-manifest.json",
  "license": "CC0-1.0",                     // 声明了 mirrors 就**必须**写（ASSETS_MIRROR_NEEDS_LICENSE）
  "mirrors": [
    { "id": "fast", "base": "https://你的域名/ak/resources-0.1.0/", "sha256": "<64 位小写 hex>" },
    { "id": "backup", "base": "https://另一台/ak/", "sha256": "<同上，必须一样>" }
  ]
}
```

| 位置 | 判据 | 拒绝码 |
|---|---|---|
| `mirrors` 整体 | 非空数组，至多 **4** 条 | `ASSETS_MIRROR_BAD_SHAPE` / `ASSETS_MIRROR_TOO_MANY` |
| 条目字段 | 只有 `id` / `base` / `sha256` | `ASSETS_MIRROR_UNKNOWN_FIELD` |
| `id` | 小写字母开头，`a-z0-9_-`，≤ 32；不许重复 | `ASSETS_MIRROR_BAD_ID` / `ASSETS_MIRROR_DUPLICATE_ID` |
| `base` | **绝对 `https://`**、有主机、无凭据、无查询、无片段、**以 `/` 结尾** | `ASSETS_MIRROR_BAD_BASE` |
| `sha256` | 64 位小写 hex | `ASSETS_MIRROR_BAD_DIGEST` |
| 与包内字节的关系 | 必须**等于**装载期从包内容器算出的摘要 | `ASSETS_MIRROR_DIGEST_MISMATCH`（**停用那条镜像**，包照旧加载） |
| `license` | 声明了 `mirrors` 就必须有 | `ASSETS_MIRROR_NEEDS_LICENSE` |

地址拼法是 `<base><包内文件名>`（`base` 的那条尾斜杠就是为此）。**只镜像本包自己的容器**：`mirrors` 里的 `base`
不会影响 `/assets/**` 从哪来 —— 那两棵树照旧由服务器（或 `cache-only` 下的引擎 SW）回答。理由是硬事实：
`data/assets.json` 只有清单级摘要、**没有逐文件摘要**，一条镜像清单的哈希锁不住它指向的那些图；把整棵官方素材树
交给第三方主机也正是「不分发官方素材」那条红线要拦的事；而且坏一个镜像就等于全站素材出问题，收窄之后只影响一个包。

#### 提供者那一半（`sources(ctx)`）

一个面板模块（`client.panels[].module`）可以导出 `sources(ctx)`，返回 `{ order(mirrors) }`：

```js
export function sources(ctx) {
  return {
    order(mirrors) {                       // mirrors：已声明镜像的只读列表 [{ id, base, sha256 }]
      return [...mirrors].map((m) => m.id).sort();   // 只回 **id** 的排列或子集
    },
  };
}
```

- **只许回已声明的 id**（排列或子集）。喂一个主机名、一条 URL、一个没声明过的 id ⇒ `CLIENT_SOURCES_BAD_ORDER`，
  **整条顺序作废**、回落声明顺序。这不是一条约定，是这一格的结构：注册面没有位置写下地址。
- 进程内**最多一个**提供者（`CLIENT_SOURCES_TAKEN`）；抛错 `CLIENT_SOURCES_THREW`；没有 `order` 成员
  `CLIENT_SOURCES_BAD_SHAPE`；返回 promise `CLIENT_SOURCES_ASYNC`；返回 `null` = 「我没什么可排的」。
- 一个**只导出 `sources`、不 `mount`** 的模块是合法的（它已经做完了要做的事）。
- 排序是给「现场测速挑源」这类策略用的：把测得的次序用 `ctx.session.setPref` 记下来，下次直接回那个次序。

#### 导入次序（硬性，作者不用管，但必须知道）

1. 逐条镜像：取清单 → 取容器 → **先核整包 sha256**（必须真的算过且对得上）→ 过了才走**既有**的逐文件
   SHA-1[0:12] 导入与写缓存；
2. 任何一步不过 ⇒ **那条镜像作废、换下一条**；
3. 全部不行 ⇒ **回落包内那条 `/workshop-resources/…` URL**，并在日志与返回值里**点名**
   （`CLIENT_SOURCES_FALLBACK`，面板可以据此显示降级）。**绝不静默，也绝不空白。**

**如实说清的一条限制**：容器大于 **256 MiB** 时用不了镜像（浏览器没有流式摘要接口），那种包只能走包内；
不设这条线就等于「不核摘要也导入」。

#### 玩家侧：一键回退

设置 →「工坊素材源」（默认**开**）。关掉之后，导入走的与「这个包没声明 `mirrors`」**完全同一条**路径，镜像那条
URL **一次都不被请求**。一个包把加载源改坏了，关掉这一格就回到原样。

**默认逐字节不变**：不声明 `mirrors` 的包 —— 归一化清单里没有这个键、`welcome.modAssets` 里没有这个字段、
请求的 URL 与次序与从前逐字相同、引擎 SW 一行未改。`MOD_API_VERSION` 仍是 **1**（加一格字段不抬版本），
**不要求 `combat: true`**（它改的是「哪台主机送同一份已校验字节」，改不了对局结果）。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.40。

---

### 1.22 行为开关（`behaviour`）：引擎实现一格，**任何**包声明它（第 4 刀，`0.16.0`）

**一句话**：`pack.json.behaviour = [{ switch, option?, name?, desc? }]`。它与 §1.20 的 `variants` **逐字同构**
（同一套字段名与文案口径，两张表读起来是同一套东西），差别只在**表是另一张**、而且每一格多一个
`actions(option)` —— **动作由引擎构造**，包一个数都塞不进来。

**它解决的是哪一面墙。** 投稿 `ac8c9821f5ba`（「卫戍协议mod-跨版本一键安装包」）把「改一条规则」做成了**安装器**：
`install.mjs` 按清单**整份覆盖** `data/*.json`、`server/**`、`public/**` 与 `tools/**`。它自己的 `files.json`
把语义写得很直：「**Nothing is trimmed: a target that gets the whole file gets the whole feature**」。本节的判断
与 §1.1 那六格「刻意没有通道」**逐字一致**：一个能指定任意文件覆盖、或让包直接写数值的包格式**就是安装器**。
所以这里开的**不是**一条覆盖通道，而是「**引擎先实现、包只声明**」这一条：`giveBondBiasOnly` 那段（§1.2）说的
「维护者在引擎里做成一个开关，然后**任何**包都能用」，落点就是这一格。

**与 `variants` 为什么分两张表**：口径是「同一份数据的另一套表现」，每条轴**必有**「官方那一档」、缺省＝引擎
今天的行为；行为开关是「引擎里本来没有、现在由维护者实现的规则」，它**不要求**有「官方那一档」。混在一起会让
作者以为它是「一套可切的口径」，而它实际是「一个必须由维护者先实现的规则」。

**形状与判据**（判据只有一份：`shared/behaviour.js`；装载器与校验器都调它）：

```jsonc
{
  "combat": true,                                        // 硬闸门（见下）
  "behaviour": [{ "switch": "<闭枚举开关名>", "option": "<该格的闭枚举选项>" }]
}
```

1. **闭枚举、响亮失败**：`BEHAVIOUR_BAD_SHAPE`（不是数组 / 条目不是对象 / `switch` 不是非空字符串 / 未知字段 /
   `name`·`desc` 写坏）· `BEHAVIOUR_UNKNOWN_SWITCH`（开关名不在表里，文案列出全部开关）·
   `BEHAVIOUR_UNKNOWN_OPTION`（选项名不在那一格，文案列出该格全部选项）· `BEHAVIOUR_BAD_OPTION`（`option` 写成
   `null` / 数字 / `false` —— 非字符串会被读成「用了缺省」，即**静默不是作者写的那个**）· `BEHAVIOUR_DUPLICATE_SWITCH`。
   **每一条都是整包拒绝**，不是忽略、也不是回落。
2. **红线落在形状层**：`module` / `entry` / `file` / `path` / `value` / `key` 这类键**点名拒**，理由里写清
   「一条行为声明只说一个开关与它的一个选项 —— 它永远不带模块、文件、路径或数字」。这一层**没有**「删官方键」的
   表达能力（没有 `$del`）。
3. **必须标 `combat: true`**（`BEHAVIOUR_NEEDS_COMBAT`）：一格的入场券本就是「它改一条规则」⇒ 必须进房间摘要
   闸门与 golden 语料。判据是**能力**而不是意图：将来若有一格**明确改不了结果**（例如纯客户端规则），它必须
   **不**要求 `combat`，并把「不改结果」写进那一格的 `effect`。
4. **不是贡献项**：与 `support` / `playtest` / `variants` 同一个语义 —— 一个只带 `behaviour` 的包照旧 `EMPTY_PACK`
   （文案里点名 `"behaviour" is NOT a contribution`）。
5. **缺省逐字节不变**：不声明 `behaviour` 的包，归一化清单里**没有这个键**（否则所有已发布包的内容哈希全变、
   房间的摘要闸门误判）；而**声明了就必须进身份哈希** —— 只差一个开关的两份包摘要必须不同（同一个摘要下两种
   对局行为是不允许的）。**不进** `modDigest`（它只哈希 `[id, hash]` 对），但随 `welcome.mods[].behaviour` 与
   `variants` 并列投影（漏掉投影 = 开关**静默不生效**）。

### 1.23 逐格加开关（第 8 刀，`0.17.0` 内）

**本版那张表里有实现好的格 —— 这一点与第 4 刀那一版不同。** 第 4 刀交的是「**通道 + 守卫**」本身（当时表是空的：
任何一条 `behaviour` 声明都被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒**，文案里写清「本版一个开关都没有，因为没有
实现点」）。**首格与它的引擎实现点一起落**，由业主点名；**加一格的门槛**因此比 §1.20 的加轴纪律更严：那一格必须
**已经在引擎里有实现点**（`docs/design/mod-layer.md` §28.43.1 逐格列出）。今天有 **5 格**，下表就是那五格。

| 开关 | 选项 | 缺省 | 引擎侧的读取点 | 投稿 |
|---|---|---|---|---|
| `shopBias` | `official` · `bondBias` | `official` | `bondBiasPreference`（`server/match/pool.js`）→ `bondBiasBonds`（`server/match/player/economy.js`）→ `PlayerEconomy._rollItemSlot` | `b293e061b38f` |
| `prepLoadout` | `locked` · `prep` | `locked` | `LOADOUT_PHASES` / `loadoutPhasesFor`（`server/match/match/platform.js`）→ `Match.setLoadout` 的相位闸门 | `8b4e5da55c58` |
| `morphPairing` | `official` · `plus` | `official` | 判据本体 `grantedBondsByMorph`（`shared/morph.js`），三处读取点同判：`bondsMeta.pieceBonds` · `support/index.unitBonds` · 客户端 `gameLogic/bonds.grantedBonds`；**装备位语义**那半条是 `morphSlotPolicy`（`shared/morph.js`），六处读取点同判：`player/items.js` · `player/acquire.js` · `bot.js` · `invariants.js` · 客户端 `ui/detailPanel.js` · `ui/gameLogic/placement.js` | `19ea65909cf6` |
| `unequip` | `official` · `allow` | `official` | `unequipAllowed`（`server/match/player/items.js`）→ `PlayerState.unequip`（新意图 `g.unequip { itemUid }`）；客户端同一判据读它决定画不画「卸下」按钮 | `79de9ff03518` |
| `diyPoolOverlap` | `report` · `strip` | `report` | `stripPackOperators`（`shared/workshop.js`）—— ⚠️ **按包读取**：逐个包读**它自己**的 `pack.behaviour`，**刻意不走** `mergeBehaviourDecls`（理由见 §1.23 该格那一段） | `stripDiyOverlaps`（`rimbilliton` / `columbia` / `rainbow-squad`） |

**每一格的三件事写清**：**缺省档 = 引擎今天的行为**（不声明 / 选缺省 ⇒ 逐字节不变，所以没有任何 `golden:update`）；
**非缺省档由引擎实现**（包给不出数字、路径或模块）；**那一格的 `effect` 逐字说明它到底动了什么**。

#### `shopBias` —— 商店装备槽的出货偏向

* `official`：装备槽按**棋子**阶级份额抽一个阶级，再在同阶级的**商店候选**里等概率抽（今天的行为）。
* `bondBias`：装备槽在这个玩家**已激活**盟约对应的装备里抽（`giveBondId` 落在那些盟约里），**只偏置、不授予** ——
  授予盟约是 `giveBondId` 本来的语义，由装备自己的规则管。抽到的**阶级**仍由棋子份额决定；某一级里一件命中都没有
  就**回落官方那一份**（偏向永远不会把商店抽空），库存闸门（`SharedItemPool.canGain`）一步都不跳过。
* **没做的两条**（原件 `files.json._doc` 提到）：①「已激活**核心**盟约优先于已激活附加盟约」；②「骑士戒律也接入
  这套偏向」。**原因**：那两条的源件不在我们手上 ⇒ 按「缺源件不做假实现」**不做**，也不在 `effect` 里声称做了。
* **没读的两个字段**：原件的 `payload/data/items.json` 带来 `giveBondBiasOnly`（115 处）与一批
  `canGiveBond`（115 处）。**这两个字段不是这一格读的东西** —— 我们只读 `giveBondId`；这一格与它那两个文件里
  **没有**任何一处读 `giveBondBiasOnly`（我们数据里连这个键都不存在），`canGiveBond` 是官方记录本来就有的键
  （变形同构体自己的标记）。`test/shopBias.test.js` 把这几条钉住。

#### `prepLoadout` —— 休整期能不能改技能与模组

* `locked`：**官方**——`room.loadout` 只在 `INFO_CHECK`（briefing 的干员调配）期间收，之后锁死（今天的行为）。
* `prep`：休整期（`PHASE.PREP`）里、且**这个座位还没准备**（`ready` 还没置位）时，也收一次 `room.loadout`。
  **不新增协议消息**：走的就是既有那条 `room.loadout { entries, ops? }`（投稿 `8b4e5da55c58` 自己也是复用既有
  意图；它另加的那个 `g.loadout` 我们不需要）。**合并语义**：这一次提交**只覆盖它写了的那些干员**，没写的保留
  当前配发 —— 整份替换会让一个只带一名干员的面板提交把其余干员静默打回默认。
* `INFO_CHECK` 那一半**不看** `ready`（今天也不看）：两个相位是两条独立的门。
* **客户端半（DESIGN §28.43.3）**：客户端的"是否锁定"现在**跟着这一格走** —— `screens/loadout.js` 里那两处
  写死的相位判据（"本局已锁定"那句 + `shouldAutoClose`）改成读 `loadoutSync.currentLoadoutLockPhases()`，
  档位由 `roomMods.js` 从 `welcome.mods` 合成。缺省 ⇒ 只含 `INFO_CHECK`，**与从前逐字等价**。
  编辑本身**不需要新发送点**：`loadoutSync` 早就在发既有的 `room.loadout`。
* ⚠️ **`PREP` 里的入口还没做**（§28.43.4 记账）：对局屏（`screens/game.js`）没有任何 `LoadoutButton`，
  所以在贴一个 `PREP` 入口之前，这一格在实战里还差最后一步。

#### `morphPairing` —— 变形同构体的配对规则

* `official`：**引擎今天的行为** —— 少于两件装备就**不配对**（变形同构体占一个装备位），配上了就**每一件**
  `giveBondId` 装备都授予。
* `plus`：投稿 `19ea65909cf6` 的那一套 —— **一件就够**（不要求两件），且**只取装备行里最左边**那一件能授予盟约的。
* **判据只有一份**：`shared/morph.js` 的 `grantedBondsByMorph`。prep 侧（`bondsMeta.pieceBonds`）、战斗里
  （`support/index.unitBonds`，档位由 `withMorphPairing` 的作用域给）与客户端
  （`gameLogic/bonds.grantedBonds`，档位由 `roomMods.js` 从 `welcome.mods` 合成后写入）**都调它** ——
  投稿原件是把这三处各自覆盖一份，而三处各写一份循环正是这条规则最容易分叉的地方。
* **第 7 段把槽位那半也补上了**（第三格落地时它被如实记成「未做」）：`plus` 档下变形同构体
  **不占装备位**（两格真装备满了也装得上）、每名干员**最多一件**、第三件真装备**永远顶掉真正占格的那一件**
  （它自己永远不会被顶掉，也不是可顶替的对象）。判据同样只有一份：`shared/morph.js` 的 **`morphSlotPolicy`**
  返回一个策略对象（`OFFICIAL_SLOT_POLICY` / `PLUS_SLOT_POLICY`），六个读取点都读它：
  服务端 `player/items.js`（`_attach` / `_takeReplaced` / `equip` 的两条守卫）、`player/acquire.js`（回收）、
  `bot.js`（选人与选装备）、`invariants.js`（不变量），客户端 `ui/detailPanel.js`（`EQUIP n/2` 与
  「不占装备格」标签）与 `ui/gameLogic/placement.js`（替换对话框的判据）。
* **缺省档逐字节不变**：`morphSlotPolicy()` 在没声明 / `official` / 不认识的档位下返回的是
  **`OFFICIAL_SLOT_POLICY` 这个共享冻结单例本身**，它的每个方法都逐字是引擎今天那条算术
  （`slotsUsed` = `items.length`、`slotCap` = `equipPerChess`、`replacedIndex` 的「找不到 ⇒ 0」）——
  所以缺省路径上「同一批数字、同一次比较、同一个 splice 下标」，**不需要 `golden:update`**。
  `gamedata.equipPerChess` 本身**一字未动**：那两格装备位是官方的，策略只回答「这一行占了几格、能不能再放一件、
  顶替挑哪一件」。`test/morphSlots.test.js` 逐条钉住两档的行为，`test/morphPairing.test.js` 钉住缺省档拿到的是
  那个单例。

#### `unequip` —— 已装备的装备能不能卸下

* `official`：**引擎今天的行为** —— 装备装上之后只能靠**精英化 / 合成 / 卖出**离开干员；`g.destroy` 对已装备的
  装备回 `equipped items are locked`。
* `allow`：休整期可以用**新意图 `g.unequip { itemUid }`** 把一件已装备的装备取下，退回**手牌**（右→左优先），
  手牌满则进**临时整备区**；两者都满 ⇒ 整件事**原子拒绝**（`HAND_FULL`），装备**留在原处、下标不变**。
* **这是本层第一格「开关 + 新意图」**，五处落点（协议表 / `intents.js` / `PlayerState.unequip` / 客户端发送点 /
  判据读取点 `unequipAllowed`）在 `docs/design/mod-layer.md` §28.43.2 里逐条点名。
* **`PROTOCOL_VERSION` 不动**：新增一个类型不是改已有形状（先例 `records.mine`），老客户端不发它就一切照旧。
* **缺省档逐字节不变**：缺省回的就是 `destroy` 今天那句 `'equipped items are locked'`，客户端**一个按钮都不画**
  （`ItemRow` 的判据是「有人传 `onUnequip` **且** `unequipAllowed()`」），`ItemDetail` 那句「配发后无法取下」
  **只在 `allow` 档**换成不带那半句的版本 —— 所以**不需要 `golden:update`**，已发布包一个字节不动。
* **池不变式**：装备只是从**装备位**移到**手牌 / 临时**（同一个 `piece`、同一个 `uid`）⇒ `held` / `cap` / `left`
  全不变，**没有「归还」这回事**（`destroy` / `sell` 才真让池子少一件）。
* **刻意的决定**：本格**不发内容钩子**（`HOOKS` 是 `META` 契约面，「卸下」用哪个都不贴切，今天也没有包需要被
  通知）；将来真有需要就**另立一刀**按契约面扩展。写在这里是为了让后人知道这是决定，不是漏做。

#### `diyPoolOverlap` —— 自选池重叠（本包做成棋子的干员又在自选池里）

* 要解决的那件事：一个包把一名**官方干员**做成自己的棋子（`chess.json` 里那条记录的 `charId` 是他），而这位
  干员**本来就在自选池**（`data/backups.json` 的 `diy.ownedPool`）里 ⇒ 他**能被上两次**，而且**自选槽绕过棋子
  自己的盟约**。唯一对应物是 `shared/workshop.js` 的 **`stripPackOperators`**（fanpack G-16）。
* `report`：**引擎今天的行为** —— 逐条点名那位干员（加载器报告里的 `overlaps`），池子**一个字节不动**；
  「如果按维护者开关摘会是哪些」照旧列在 `report.strippedPool` 里。
* `strip`：把这个包**自己**做成棋子的、又在池里的干员**摘出名单**。摘的是 `diy.ownedPool` 这一份**名单**，
  **不是** `diy.operators` 那条记录（界面在池外仍按 id 读它，删记录反而会让别的引用找不到它）。
  报告里被摘掉的那些进 `report.strippedByPack`（可点名到 char id），`report.poolStripped` 说明这一次到底改没改。
* ⚠️ **这一格是全表第一格「按包读取」的开关，它刻意不走 `mergeBehaviourDecls`**（其余四格读的是 `Match` /
  `roomMods` 里那一份**合并后**的 decl，包 id 小者赢）。理由是一条硬语义：这一格说的是「**本包**做成的棋子」，
  不是一条全局口径。若照其余四格那样先合并成一个值，那么「A 包声明 `strip`」会连 **B 包**的重叠一起摘掉 ——
  而 B 从没声明过这件事。所以读取点（`stripPackOperators`）逐个包读**它自己**的 `pack.behaviour`
  （判据仍然是同一份 `behaviourValue`，闭枚举仍然是同一张表）。**后人若在这里「顺手补上 merge」，那是改错。**
  `test/diyPoolOverlap.test.js` 判据③（两包 A/B 只 A 声明）与⑤（源码级：`stripPackOperators` 里不许出现
  `mergeBehaviourDecls` 调用）把这条钉住。
* **摘除有两条通道，落到同一个动作上**：① **维护者总开关** `stripPackOperators(packs, data, { apply: true })` ——
  今天的口径，语义一字未动，**只**由维护者调用；② **包级声明**（本格）。装载路径 `applyWorkshop` 走的是 ②，
  所以作者声明了、装载出来的池子就是他声明的样子；不声明的包逐字节不变。
* **为什么缺省不摘**（这条是这一格存在的前提）：摘掉一份已经在池里的干员 = 池子变小、可挑的干员变少、
  `tools/golden.mjs` 给池里每一位配的那个精锐场景整个消失 —— 一次**有意的玩法改动**按 `AGENTS.md` 的 golden
  规矩必须在同一个提交里跑 `golden:update` 并逐条点名移动了哪些场景。那是**包作者**声明之后才发生的事，
  不是加载器替维护者决定的事；所以缺省档（今天的 golden 语料）**逐字节不变、不需要 `golden:update`**。
* 实测（本机那份真投稿、`apply:false`、`ownedPool` 规模 72）：`rimbilliton` 4 条、`columbia` 4 条、
  `rainbow-squad` 0 条。`test/diyPoolOverlap.test.js` 拿真装载器把 `rimbilliton`（声明 ⇒ 池 72→68，被摘的
  正是它复用的 4 个官方 ops kit 的干员）与 `rainbow-squad`（声明了但 0 重叠 ⇒ `applied:false`、池不变）逐条钉住。

**新增一格怎么做**：先把**引擎侧的读取点**实现好（照这一格），再把那一格加进 `BEHAVIOUR_SWITCHES`
（`label` / `options` / `default` / `optionLabels` / `effect` / `actions` 一件都不能少 —— `behaviourSwitchIssues`
逐格检查），最后补一节文档与一个测试文件（并把读取点登记进 `shared/modSurface.js` 的那一格锚点）。

**`MOD_API_VERSION` 仍是 `1`**（加一格字段不抬版本；与 §1.20 / §1.21 同一条）。**「老引擎优雅降级」明确不做** ——
老引擎遇到这个键回的是 `PACK_UNKNOWN_FIELD`（点名拒），作者该知道的是自己该跑哪一版；**老包一个字节不受影响**
（不声明就不长键）。**不新增协议消息、不改默认游戏行为 ⇒ 不需要 `golden:update`**。

**站侧含义（照实写）**：空表在站上**真的挡过投稿** —— `e3a5d09eb6d3`（第 4 刀那一份跨版本安装包，已批准公开）
按 `pack.json.behaviour` 声明时拿到 `BEHAVIOUR_UNKNOWN_SWITCH`，文案就是「Known switches: none yet …」。这四格落了
之后，`b293e061b38f` / `8b4e5da55c58` / `19ea65909cf6` / `79de9ff03518` 四条**有了可声明的档**（仍要按包格式重写，见 §1.1）。
另一条实测约束：`11746baa0662` 只声明 `pack.json.variants` 会拿到 `EMPTY_PACK`（`"variants" is NOT a contribution`）
—— **口径与开关都不是贡献项**，一个只带它们的包不构成一份包。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.43。

---

### 1.26 目标引擎（`target`）：一份 `pack.json`，两个宿主各自读得懂

> **编号说明**：这一节早先与 **§1.23 逐格加开关**用了同一个号（历史遗留的双编号），本刀把它改成 **§1.26** ——
> `target` 与 §1.9–§1.21 是同一族（中间层能力声明），而 §1.22 / §1.23（行为开关）已在正文里逐处互指，
> 所以动的是这一节。指过来的链接按编号改。

`pack.json` 的顶层键是**闭集**：不认识的键点名拒绝（`PACK_UNKNOWN_FIELD`）。这条纪律对 Forge 自己的包是对的，但当同一份
清单要给**另一个宿主**（Stardust）读时，它就成了死结 —— 那边认识的键（`type` / `capabilities` / `englishName` /
`authors` / `app`，以及能力自己认领的 `announcements`）在 Forge 这一侧会被整包拒。

`target` 就是这一格的出口：

```json
{ "id": "sd-pack", "name": "…", "version": "1.0.0", "license": "CC0-1.0",
  "target": "stardust", "type": "mod", "capabilities": ["announcements"],
  "announcements": [ … ] }
```

* **`"forge"`（缺省）**：本引擎自己装。**不写 `target` 时一个字节都不动** —— 归一化清单里不长这个键，包身份哈希、
  `/mods/catalog.json`、`PROTOCOL_VERSION`、`MOD_API_VERSION` 全部逐字节不变。显式写 `target: "forge"` 是一条**声明**，
  它进清单、也进哈希。
* **`"stardust"`**：给 Stardust 宿主的**声明型包**。本引擎**只认识、不装载** —— 它不进 `packs`、不进数据叠加层、
  不进 `/mods/catalog.json`，启动日志里留一行具名（`server/workshop.js` 的 `foreign`）。它不需要任何 Forge 贡献项，
  所以 `EMPTY_PACK` 对它不适用。`type` 必须是 `"mod"`，`capabilities` 是能力 id 列表；能力自己认领的字段只对
  **声明过那个能力**的包放行。
* 写别的值：`PACK_TARGET_UNKNOWN`，整包拒。

**作者可见面（已接线）**：三面都会**点名**它 —— `node tools/workshop-validate.mjs` 给它一行具名
`PACK_FOREIGN` warning（清单合法，所以是 warning 不是 error；收尾另有一句 `NOTE: N pack(s) target another host
("stardust")`），`node tools/workshop-pack.mjs list` 打的是 `FOREIGN（本引擎不装载：…）`（**带原因**，不是
`REFUSED（null）`），编辑器包管理页的列表行与详情页各给一格说明（中英双语）。跨宿主误用从「响亮拒绝」变成
「接受且不装载」之后，**这三面是作者唯一能看见它的地方** —— 不说就是 §1.1 那条教训。

**不抬版本**：`MOD_API_VERSION` 仍是 `1`、`PROTOCOL_VERSION` 仍是 `2`（加一格字段不抬世代）。闭集就地延长：
顶层键 34 → 35（`docs/STANDARD-PACK.md` §二.2 同步）。**不需要 `golden:update`**：缺省路径一个字节不动。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.46。

---

### 1.24 模组管理器（mod registry）：装过什么、启停过什么，与**删除的两道闸**

管理器（`tools/workshop-pack.mjs` 的 `import` / `enable` / `disable` / `uninstall` / `rollback`）把一个包的生命周期
分成了三种状态，而在此以前只有两种：「装」与「没装」。第三种是**装了但不装载** —— 这是这一节要消掉的那面墙。

```powershell
node tools/workshop-pack.mjs import demo.zip        # 装上并启用；记下来源与 pack.json 摘要
node tools/workshop-pack.mjs disable demo           # 文件留在盘上，服务器不再装载它（重启后生效）
node tools/workshop-pack.mjs enable  demo           # 一条命令回来
node tools/workshop-pack.mjs uninstall demo --json  # 整包留底到 workshop/.mod-backups/demo/uninstall-<时间戳>/
node tools/workshop-pack.mjs rollback  demo         # 把升级时留底的上一版换回来
```

**唯一事实是登记册 `var/mod-registry.json`**（状态根，`SP_STATE_DIR` 可改；**不在** `workshop/` 里 —— 那里是加载器
扫描的地方，状态文件放进去会被当成一个包）。CLI、编辑器、服务器读的是同一份。**不在册里 = 启用**：装一个包就该
立刻能用，「禁用」是操作者的一次明确动作；反过来的话，这个文件一丢所有包都会静默消失。

被禁用的包与**装载失败**的包在结果上完全一样：没有 hook、没有订阅、没有面板、没有字节进数据叠加层。
`node tools/workshop-pack.mjs list` 里它带 ` · DISABLED（不装载）` 后缀 —— 这一格与 `FOREIGN`（§1.26）**正交**，
一个包可以同时是「清单合法」且「被操作者关掉了」。

**删除的两道闸（都不可绕过）。**

1. **ownership：只卸载本管理器登记过的包。** 一个没有安装记录的包可能是仓库自带、手工放置或者旧版装的 ——
   这个管理器不认识它，就没资格处置它。`uninstall` 会点名拒绝。
2. **留底：卸载不销毁字节。** 卸载与回滚都是把整个包目录 **`rename`** 进
   `workshop/.mod-backups/<id>/…`（点开头 ⇒ 加载器不扫描 ⇒ 立刻"不在"，但一个字节都没丢），**不是删除**。
   CLI 会把留底路径打出来，不想要可以自己删。升级（`import --force`）也走这条路，`rollback` 靠它回去。

**三条硬边界**：只动**这个包自己的目录**；引擎文件 / `data/` / `test/golden/` **一律不碰**；**越界删除必须被拦，
而且有测试证明**（两条闸分别有契约测试：`PACK_ID_RE` 挡住 `../../x` 这类 id，`previous.backup` 只接受包内相对
目录 —— 手改过的登记册也指不到工坊根之外；证明方式是逐字节比对目录树，见 `test/modRegistry.test.mjs`）。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.47。

---

### 1.25 包之间的依赖与互斥（`dependencies` / `conflicts`）：**装载期**裁决

```json
{ "id": "my-mod", "…": "…",
  "dependencies": [{ "id": "shared-lib", "range": ">=2.0.0" }],
  "conflicts":    [{ "id": "rival-mod" }] }
```

`id` 是**另一个工坊包**的 id，`range` 是那个包 `version` 的区间（与 `api` / `game` 同一套语法，缺省 = 任意版本）。
两个键都进顶层键闭集，但**都不是贡献项**：一个只声明依赖的包照旧 `EMPTY_PACK`。

**为什么是装载期**：一个包声明「我依赖 `lib`」时，这句话只有在**本机真的装了哪些包**之后才成立 —— 作者看不到
别人的 `workshop/` 里有什么。所以「缺依赖」不是他写错了，而是这个组合在这台机器上不成立。

五条规则，全部**具名**（拒绝理由点名双方，写进启动日志）：

| 情形 | 结果 |
|---|---|
| 缺失依赖 | **依赖方被拒**（`missing dependency "lib"`） |
| 版本不合 | **依赖方被拒**（`dependency "lib" version 1.0.0 does not satisfy ">=2.0.0"`）；**依赖包没写 `version` 时视为满足** |
| 互斥 | **包 id 大的那个**被拒（`conflicts with "alpha"`）；带 `range` 时只有区间匹配才互斥 |
| 级联 | 依赖链上任何一个被拒，依赖方跟着拒（迭代到不动点，理由链完整） |
| 循环 | 环上**全体**被拒（`dependency cycle: a → b → c → a`） |

被拒的包与「没装」在结果上一样：不进数据叠加层、不进 `/mods/catalog.json`、不装载任何载荷。
**不抬版本**：`MOD_API_VERSION` 仍是 `1`、`PROTOCOL_VERSION` 仍是 `2`；没写这两个键的包**一个字节都不变**。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.48。

---

### 1.27 启用声明（`enabled`）：**装好 ≠ 生效**

**一句话**：`pack.json.enabled = true | false`。`false` = 这个包**装好了、但现在不参与** —— 目录留在工坊目录里，
字节一个不动，装载期跳过它。这是今天没有的第三态：在此之前想让一个包暂时不参与，只能把 `pack.json` 改坏
（响亮的失败）或把目录搬出去（作者自己都不知道发生了什么）。

**它不是什么，比它是什么更重要**：`enabled` **不是**一条能力通道 —— 它打不开任何引擎里没有的东西
（包能声明的格子见 [docs/MOD-SURFACE.md](MOD-SURFACE.md)，与本格无关）。它**也不是**热更新：装载期读一次，
改它要**重启**（[design/mod-layer.md](design/mod-layer.md) §28.4 的「No hot reload」不受影响）。

**形状与判据**（判据只有一份：`shared/enabled.js`）：

```jsonc
{
  "enabled": false        // 省略或 true = 引擎今天的行为；false = 装载期跳过
}
```

1. **只有布尔**：`"false"` / `0` / `null` / `"true"` 一律 `ENABLED_BAD_SHAPE` **整包拒** —— 一个被 JS 真值表放行的
   假布尔是**静默失效**（作者写下 `"false"`，引擎读到「启用了」，中间没有人收到错误）。
2. **缺省 = 今天**：不写 `enabled`，或写 `"enabled": true`，都与**今天逐字相同**。所以只有 `false` 会进包的
   归一化清单 —— 无条件写 `true` 会让**所有已发布包**的包身份摘要改变（房间的摘要闸门会误判）。
3. **跳过必须响亮**：`false` 的包不进已加载集合，而是进装载器的 `errors`（`ENABLED_FALSE`）并被逐条点名 warn。
   一个静默消失的包比一个报错的包难查得多。跳过发生在读任何内容文件之前，所以它连声明的 `chess.json` 都不读。
4. **不是贡献项**：只带 `"enabled": true` 的包照旧 `EMPTY_PACK`（与 `variants` / `playtest` / `behaviour` 同一条）。
5. **客户端读不到它**：`welcome.mods[]` 不投影这一格 —— 没进已加载集合的包对房间**不存在**。

**什么时候用它**：一个包内容还想要、但暂时不想让它参与对局（例如等适配下一个版本、或想 A/B 两份配置），
而你又不想动它的字节。想让一个包**永久**不再参与，正确做法是从工坊目录里删掉它 —— `enabled: false` 是
**暂停**，不是卸载。

完整规范见 [docs/design/mod-layer.md](design/mod-layer.md) §28.50。

---

## 2. 助战

### 2.1 配置：`data/support.json`

```json
{
  "enabled": true,
  "label": "助战",
  "slots": { "5": 2, "6": 1 },
  "pool": {
    "5": ["chess_char_5_01_a", "…"],
    "6": ["chess_char_6_01_a", "…"]
  },
  "denyUnknown": true
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关。`false` 或缺少可用的「名额 + 卡池」组合时整体禁用 |
| `slots` | 每阶每名玩家可带的助战数量；`0` 表示该阶关闭 |
| `pool` | 该阶允许的干员 id。**必须与 `data/chess.json` 里该干员的 `tier` 一致**：把 6 阶干员写进 `"5"` 里不会被提升，而是被禁用 |
| `denyUnknown` | 卡池外一律拒绝（默认 `true`） |
| `prices` | `{ "<chessId>": 3 }`：**带上这名助战的玩家**商店里的标价（0–99 整数，只认卡池里真有的 id）。留空 = 阶级价；关掉该助战时这条价目会被清掉（见 §2.3） |
| `workshop` | 写 `false` 即忽略**所有**工坊包的助战声明（安装方保留最终决定权，启动日志会写出来） |

这个文件由服务器维护、**不参与 `build-data`**，改完重启即生效，无需重建 `data/`。

#### 工坊包自带助战（`pack.json.support`）

`data/support.json` 是**这个安装**的决定；工坊包可以**建议**自己新增的哪些干员该进池：

```json
{ "id": "my-ally", "content": ["chess"], "support": ["chess_char_ws_my_ally_01_a"] }
```

> **`support` 本身不是贡献项**（`content` 才是）：上面那个例子里的 `"content": ["chess"]` 是**必需**的，
> 因为干员本体是 `chess` 记录带进来的。一个只有 `"support": [...]`、`content: []` 的包会被 `EMPTY_PACK` 拒
> —— 这不是缺陷，是既有裁决（§1.9 的 `EMPTY_PACK` 表）；B5 段把这条**写进了拒绝文案**，理由里会点名 `support`。

装载时叠加层把每个 id 按**记录自己的阶**加进 `pool`（`shared/workshop.js` 的 `workshopSupportEntries` / `mergeWorkshopSupport`），
于是「装包即可选」——不必再手工改 `data/support.json`。两条硬规则：

| 规则 | 为什么 |
|---|---|
| **只能声明本包自己新增的干员** | 卡池是安装方的规则决定；允许包把官方干员塞进/移出卡池就等于让内容包改规则。违反记 `SUPPORT_FOREIGN_OPERATOR`（整条被拒，其余照常生效） |
| **阶由记录推导，清单里不写** | `isSupportChess()` 要求 id 出现在**它自己那一阶**的池子里；清单里手写阶就会出现「写错了但没人报错、该干员静默不可选」。记录没有 1–6 的整数 `tier` 时记 `SUPPORT_TIER_UNKNOWN` |

安装方保留最终决定权：`data/support.json` 里写 `"workshop": false` 即忽略所有包的助战声明（启动日志会写出来）。
被触及的 `support.json` 会**合并后**发给浏览器（`workshopTouchedFiles`），客户端从那里渲染助战选择界面 —— 与其它工坊内容同一条路径。

**写这个字段的图形入口是编辑器的第八个页面 `/pack.html`**（`docs/EDITOR.md` §包管理）：它勾选本包自己新增的干员进池，
界面上显示的阶**由记录推导**（`workshopSupportEntries`，与加载器/校验器同一份规则，手输的阶会让该干员静默不可选），
就地改 `pack.json` 的 `support` 一个字段，并说明卡池本身在 `data/support.json`、可用 `"workshop": false` 整体关掉。

### 2.2 「没有即禁用」的三层含义

1. **客户端看不到**：客户端只能通过 `gd.supportPicker()` 拿卡池；服务端是唯一来源。
2. **请求被整条拒绝**：`checkSupport()`（`shared/support.js`）对卡池外的 id、重复 id、超出该阶名额的请求返回 `BAD_TARGET`，**不做静默降级** — 静默降级会把「被禁用的干员」悄悄变成「已发放的干员」。空选择永远合法，表示不带助战。
3. **开局时再查一次**：`PlayerState.prepareSupports()` 会重新核对卡池，并把「本局商店里真的买得到的那几个」记进
   `supportGranted`。因为 `data/support.json` 可能在 `lobby` 校验之后、对局开始之前被改掉；此时该干员被跳过并给玩家一条提示。

### 2.3 生命周期

```
房间席位 seat.support ─→ Match 构造 opts.seats[].support ─→ PlayerState.setSupport()（再校验）
        │                                                            │
        │  构造时：Match.supportSupply = 人（非机器人）带上的助战        │
        │  → SharedPool 给每人一份额外拷贝（连本局禁用也盖过去）          │
        │                                                             │
        INFO_CHECK 期间仍可改（与 room.loadout 一样，之后锁定）          │
                                                                     ▼
                            ROUND 1 开始时 prepareSupports() → 只记录「买得到的那几个」
```

- **助战干员进商店，不白送**（业主 2026-10-07 定下：「助战干员就应该加入商店，按阶级像普通棋子一样购买出售」）。
  实现方式是共享池里**多一份拷贝**：`cap` 与 `left` 同时 +1，所以共享池恒等式（`left + Σ held == cap`）自动成立；
  这份拷贝属于**这场对局**（池是共享的，合作模式里队友也能买到它）。
- 助战因此就是**普通棋子**：可以在商店里摇到、按阶级价买到、可合成精锐、可装备、可部署、卖掉按普通规则归还拷贝。
- **价格可以改**：`data/support.json` 的 `prices: { "<chessId>": 3 }` 是**带上它的那名玩家**商店里的标价（0–99，
  只接受卡池里真有的 id）；没配的用它的阶级价（`GameData.chessPrice`）。出售价不分助战，一律走 `sellPrice`。
- **阶级门照旧**：六阶助战仍要商店等级 6 才摇得到。
- **随机禁用不禁用助战**：本局禁用名单照旧生成，但带上的助战仍然有一份拷贝 —— 「禁用抽卡」不是「禁用助战」。
- 机器人不带助战（`PlayerState.setSupport` 直接拒绝，`Match.supportSupply` 也不看机器人的席位）。

### 2.4 消息

`room.support { entries: [chessId, …] }` — 数组，最多 `SUPPORT_LIMITS.entries`(16) 项，元素为互不重复的合法 id。校验与 `room.loadout` 同风格：结构错误 `BAD_MSG`，语义错误 `BAD_TARGET`，对局已过 `INFO_CHECK` 则 `WRONG_PHASE`（stub 对局没有 `setSupport` 时 `ROOM_STARTED`，与 loadout 一致）。

### 2.5 当前状态

| 部分 | 状态 |
|---|---|
| 服务端卡池、名额、全部失败关闭路径 | ✅ 已实现并测试 |
| `room.support` 消息、会话/席位存储、对局内再校验 | ✅ 已实现并测试 |
| ROUND 1 记录「本局商店里买得到哪些助战」、共享池记账恒等式 | ✅ 已实现并测试 |
| 客户端**助战选择 UI** | ⛔ **未实现**（服务端已就绪，`m.private` 里也还没有回显 `support`） |

---

## 3. 本地验证

```powershell
node --test test/workshop.test.js test/support.test.js
```

示例包位于 `docs/examples/demo-workshop/`（**目录名必须等于 `pack.json` 的 `id`**，否则加载器会以 `PACK_ID_MISMATCH` 跳过它），复制到 `workshop/demo-workshop/` 即生效；测试会在临时目录里做同样的事，所以仓库默认状态不含任何工坊内容。

```powershell
node --test test/chessAuthoring.test.js test/workshop.test.js test/support.test.js test/editor.test.js test/workshopKits.test.js
```

---

## 4. 行为层（`kits/<id>.js`）

一个包可以带 JavaScript：`workshop/<pack>/kits/<chessId>.js`。**文件名就是一个键**（写 `_a` 那个 `baseId`）——
它可以是一个干员 id，也可以是一个**召唤物**的 token id（两个键空间，见 §4.7）。
默认导出就是模拟器调用的 kit 函数，契约与官方内容 `server/sim/content/kits/tierN.js` **完全一致**，所以工坊能做官方能做的一切：

```js
export default function kit(bb, chess, def) {
  return {
    skill: { /* SkillSpec，见 docs/DESIGN.md §5.6 */ },
    talents: [{ install(battle, unit) { /* battle.on(...) / battle.addBuff(...) */ } }],
    // trait?、install? 亦可
  };
}
```

### 4.1 三条硬规则（均从源码确认，不是推测）

| 规则 | 为什么 |
|---|---|
| **返回了 kit 就必须自己给出 `skill`** | `Battle._setupUnit` 用 `u.kit.skill \|\| null` 取技能：给了 kit 却省略 `skill`，该干员就**没有技能** —— 缺省技能**不会**回退到通用 kit |
| **import 只有三种写法** | 同一份文件服务端按真实路径加载、浏览器按 URL 加载，向上走的相对路径不可能同时对。所以作者写 `@kit/…` / `@sim/…` 前缀（§4.5），或 `./…` 开头的**本包**相对路径（§4.6）；其余一切 import / `require` / 动态 `import()` 仍然是 `KIT_IMPORT` |
| **它会在玩家浏览器里执行** | 默认 `SP_COMBAT=client`；服务端用**同一份文件**复算，所以不要有环境依赖（随机用 `battle.rng`，不要碰 DOM/网络/时间） |

### 4.2 注入点与双通道（关键一致性）

- 注入点是 **`Battle opts.kits`**（干员）/ **`Battle opts.tokenKits`**（召唤物，§4.7）：`server/sim/content/index.js
  setupUnitKit()` 会**先**查它、再查内置注册表 —— 按对局注入，**不改动那个冻结的全局表**。没有包声明对应那一半时
  那个键**根本不出现**，战斗与从前逐字节相同。
- 浏览器拿不到函数，所以战斗 spec 里带的是 JSON 安全的 `workshopKits: [{ id, pack, url }]`（召唤物那一半多一个
  `kind: 'token'`），`public/js/battle/runner.js loadSpecKits()` 按 URL 动态 `import` 后重建**同一批表**。
- **只做服务端会让默认配置直接出错**：浏览器若回退到通用 kit，算出的结果会被服务端复算判为不一致而**拒绝**。
  这就是「行为层必须成对交付」的原因。

### 4.3 加载与校验

- 服务端启动时加载（`server/workshop.js loadWorkshopKits()`）。导入失败、没有默认导出、干员 id 不存在的 kit 会被
  **报告并跳过**，绝不影响启动。
- `tools/workshop-validate.mjs` 把 `kits/` 作为**第四层**一并校验并列出已加载的 kit。

**静态检查（`shared/kitAuthoring.js`）**：导入只能证明「文件能解析、默认导出了函数」，对**在游戏里静默失效**的那几类
问题一无所知。所以除了导入，还会静态扫一遍源码，全部给机器可读的 `{ field, code, message, hint }`：

| code | 严重度 | 抓的是什么 |
|---|---|---|
| `HOOK_UNKNOWN_EVENT` | warn | `battle.on('beforeAttck', …)` —— `on()` 接受**任意**字符串（总线在 `server/sim/battle/hooks.js`；这个文件与两个方法名钉在 `shared/kitAuthoring.js` 的 `HOOK_BUS` 上，**这里不写行号** —— 从前写的是 `server/sim/Battle.js` 的两个行号，而那个文件早就不含这两个方法，行号烂掉时没有任何东西会报错），而 `emit()` 只触发真正被 emit 的名字（同一文件的方法 `emit`）。写错的钩子**永远不会触发，且没有任何地方会报错**。引擎真实的 emit 词表在 `HOOK_EVENTS`，由漂移守卫钉在源码上，所以能给出「你是想写 beforeAttack 吗」。命名空间事件（`mypack:ready`）只要**同一文件自己 emit 过**就合法 —— 官方内容就是这么扩展总线的（`nearl2:knockdown`） |
| `HOOK_DYNAMIC_NAME` | warn | 用变量当事件名（`battle.on(name, …)`）—— 查不了，所以要说一声 |
| `KIT_NONDETERMINISTIC` | warn | `Math.random` / `Date.now` / `fetch` / `document` / `setTimeout` … —— 服务端用同一份文件**复算**对局，不一致就**拒绝玩家的结果**，而报错信息看上去和「你用了 Math.random」毫无关系 |
| `KIT_IMPORT` | error | 白名单之外的 `import` / `export … from` / `require` / 动态 `import()` —— 违反 §4.1 第二条（服务端按路径、浏览器按 URL，向上的相对路径不可能同时对）。可用写法见 §4.5（白名单前缀）与 §4.6（自己包里的 `./…`），错误 reason 里会直接列出可用的 specifier |
| `NO_DEFAULT_EXPORT` | error | 没有默认导出（加载器读的是 `mod.default`） |
| `KIT_NO_TARGET` | error | 本包没有这个干员 / 召唤物 id，也没在 `pack.json overrides` 里声明；键空间的完整定义见 §4.7 |
| `KIT_TARGET_AMBIGUOUS` | error | 这个 id 在合并后的数据里**同时**是干员与召唤物（两张表都有它）：干员那一半会赢，召唤物那一半静默失效，所以点名拒绝（§4.7） |

注释与字符串会先被剥掉再检查 —— 示例 kit 的头注释本来就在**讲解**这些规则，文字不该被当成代码。

- 可运行示例：**[docs/examples/kit-demo/](examples/kit-demo/README.md)**（含「常驻 +25% 攻击力」天赋，并演示上述三条规则）。
- 编辑器页面：**`/kit.html`**（`docs/EDITOR.md` §kit）—— 直接编辑这个文件，用上面的静态检查当实时反馈，保存时在文件开头写署名头。
  它**不**执行你的文件（那会让一个 HTTP 接口变成代码执行面），真正导入一遍仍是 `tools/workshop-validate.mjs` 的 kits 层。

### 4.4 当前状态

| 部分 | 状态 |
|---|---|
| 服务端加载 + 校验 + 注入 `opts.kits` | ✅ 已用**真实战斗**验证（kit 的 `install` 在对局中确实执行） |
| kit **静态校验**（钩子词表 + 三条硬规则），机器可读 | ✅ 已完成（`shared/kitAuthoring.js`、`test/kitAuthoring.test.js`，词表有漂移守卫） |
| 浏览器分发（spec 携带 URL + runner 重建同一张表） | ✅ 已实现并测试（模块可按 URL 取得、装配路径有断言） |
| kit 的**受限 import**（白名单 + 双端解析，§4.5） | ✅ 服务端已验（真 import 成功、helper 可用、白名单外仍被拒、包哈希不变）；浏览器侧只验到「import map 与表一致 + 模块在 `/sim/` 可取」 |
| 浏览器端**真机端到端**（Chrome 跑一场带 kit 的对局） | ⛔ 未做（需 `SP_E2E=1` + Chrome；import map 的解析本身由浏览器做，Node 没有 import map）。**能跑的那一条已经写好**：`SP_E2E=1 node --test test/ui/kitimports.e2e.test.js`（页面上下文里 import 每个白名单 specifier、验导出名下限、并验白名单外的 specifier 在浏览器里也解析不到） |
| 编辑器里的 kit 编辑页签（`editor/ui/kit.html`） | ✅ 已完成（编辑文件本体 + 上面的静态校验 + 保存时写署名头；真正 `import` 一遍仍由 `tools/workshop-validate.mjs` 做，编辑器不执行作者的文件） |
| 包之间 kit id 冲突、kit 的沙箱与审查 | ⛔ 未做（冲突会被报告并跳过；沙箱按分渠道策略不做） |

---

### 4.5 受限 import：白名单 + 双端解析

一个 kit 是**同一份文件被两处加载**：服务端按真实路径 `import()`（`server/workshop.js loadWorkshopKits()`），
浏览器按 URL `import('/workshop-kits/<pack>/<id>.js?v=…')`（`public/js/battle/runner.js loadSpecKits()`）。
向上走的相对 specifier（`../shared/tier1.js`、`../../../dir.js`）对其中一端成立、对另一端必然不成立 ——
所以 kit 的 import 走**前缀白名单**（自己包里的**向下**相对路径是另一种，见 §4.6）：

```js
import { num, talentBb, traitBb, skillRec, up } from '@kit/tier1.js';
import { selectedId, copyGrid } from '@kit/tier3.js';
import { dirVec } from '@sim/dir.js';
import { absoluteRangeKeys } from '@sim/targeting.js';
import { COLS, ROWS } from '@sim/constants.js';

export default function kit(bb, chess, def) { /* … */ }
```

这就是社区 mod「克莱门莎」那 5 行 import 的等价改写（它原来写的是 `../shared/tier1.js`、`../../../dir.js` …）。
两端怎么解析：

| 端 | 谁做 | 怎么做 |
|---|---|---|
| 服务端 | `server/workshop.js` | import 前用 `shared/kitImports.js rewriteKitImports()` 把白名单 specifier **窄重写**成真实 `file:` URL，再用 `data:` 模块 import（不改磁盘） |
| 浏览器 | `public/index.html` 的 import map | `"@kit/": "/sim/content/kits/shared/"`、`"@sim/": "/sim/"` —— 声明式解析，源码**原样**发给浏览器（`/sim/` → `server/sim/`，见 `server/http/static.js`） |

#### 4.5.1 白名单（唯一真相：`shared/kitImports.js KIT_IMPORT_FILES`）

| specifier | 真实文件 | 里面有什么 |
|---|---|---|
| `@kit/tier1.js` … `@kit/tier6.js` | `server/sim/content/kits/shared/tierN.js` | 官方 kit 写作用的那套 helper（`num`、`skillRec`、`onHitOn`、`installAura` …） |
| `@kit/summoner.js` | `server/sim/content/kits/shared/summoner.js` | 召唤物 helper |
| `@sim/constants.js` | `server/sim/constants.js` | `COLS` / `ROWS` / `TICK` … |
| `@sim/dir.js` | `server/sim/dir.js` | `dirVec` / `offsetTile` |
| `@sim/targeting.js` | `server/sim/targeting.js` | `absoluteRangeKeys` / `sortEnemyTargets` |
| `@ops/op-shwaz.js` · `@ops/op-ray.js` · `@ops/op-aglna2.js` · `@ops/op-thumpy.js` | `server/sim/content/kits/ops/op-*.js` | **复用官方 ops kit**：包里的棋子就是某名官方干员换皮时，直接调它 `default` 上的那个成员（如 `opShwaz.char_340_shwaz(bb, chess)`），不必把引擎子系统复制进包。**按文件开、只此 4 个** —— `@ops/` 是命名空间不是放行：`@ops/op-siege.js` 这类同前缀未列名的文件仍然被拒（2026-10-14 业主裁定） |

一个文件只开一个名字；加一行就是同时给两端开一个模块（表在 `shared/kitImports.js`，浏览器那张 import map 由
`kitImportMap()` 生成、`test/kitImports.test.js` 钉住两者一致 —— 改表就要改 `public/index.html`，否则测试会红）。

⚠️ 这 4 个 ops kit **不要**做 import 改写、也不要复制进包：它们自己的 `../shared/tier1.js`、`../../../body.js`
由两端**按真实位置**解析（服务端按真实路径；浏览器按 `/sim/` 与磁盘 `server/sim/` 同构的 URL，见
`server/http/static.js`），原样写 `@ops/…` 就能用。包文件一多，那 4 个文件的依赖闭包是 18 个文件 / 513 KB。

#### 4.5.2 白名单之外：全部仍是 `KIT_IMPORT`（error）

| 作者写了 | 为什么不行 | reason 里会说的 |
|---|---|---|
| `'../shared/tier1.js'` | 含 `..`：服务端会解析到 `kits/` 之外，而浏览器的 URL 里没有 `kits/` 这一层可以退回来 | 「含 ".." 段」+「路径穿越一律拒绝」 |
| `'/abs.js'` | 绝对路径：浏览器按站点根、服务端按文件系统根 | 「绝对路径无法同时在服务端与浏览器成立」 |
| `'@kit/../../x.js'` | 路径穿越，一律拒绝 | 「路径穿越一律拒绝」 |
| `'./x.mjs'` | 包相对 import 只支持 `.js` | 「包相对 import 只支持 .js」 |
| `'./%2e%2e/x.js'` | 百分号编码会在解析后变成 `..`，所以 `%` 一律拒绝 | 「包相对路径不得含 "%"」 |
| `'./x.js?1'` | 查询串不是文件名的一部分 | 「不得带查询串或片段」 |
| `'@kit/evil.js'` | 前缀合法但模块名没开放 | 「模块名 "evil.js" 未开放」 |
| `'lodash'` | 裸模块名：两端都没有 node_modules 解析 | 「裸模块名未开放」 |
| `require('…')` | kit 两端都按 ES 模块加载，没有 CommonJS | 「禁止 require()」 |
| `import('@kit/tier1.js')` | 动态 import 的 specifier 是表达式，两端都无法静态解析 | 「禁止动态 import()」 |
| `export { x } from '…'` | 与 `import` 同一张白名单（`export … from` 也是一个模块依赖） | 同 import |

每一条 reason 末尾都会列出**完整白名单**，并附上「自己包里的 `./…` 也能写」，`hint` 里给可用写法 ——
拒绝的时候必须说清允许什么（§4.6 就是这条 `./…`）。

#### 4.5.3 哈希与确定性（两条都不受影响）

- **包哈希按作者写的源码算**：`server/workshop.js identifyPack()` 把 `kits/**/*.js`（**递归**，§4.6）的**磁盘字节**
  放进 `[path, sha256]` 清单（DESIGN §28.2）。服务端那次重写只发生在内存里，**不落盘、不进哈希**，所以同一个包在
  两端摘要一致。
- **确定性判罚不变**：`Math.random` / `Date.now` / `fetch` / `document` … 仍然是 `KIT_NONDETERMINISTIC`
  （warning），本次只动 import 口径。

测试：`test/kitImports.test.js`（白名单表与两端解析、校验器口径、服务端真加载并调用 `num`、白名单外仍被拒、
哈希前后不变、社区 kit 5 条映射、以及每个白名单文件的**导出名下限**守卫 —— 删名/改名会红并点名，
加导出不会）；包相对那半是 `test/packRelativeImports.test.js`（§4.6）；真机那半是
`test/ui/kitimports.e2e.test.js`（默认跳过，见 §4.4 的命令）。

---

### 4.6 包相对 import：用 `./…` 把一份大文件拆成几个文件

§4.5 的白名单让 kit 够得着**引擎**的模块，但够不着**自己包里**的代码。于是「一个包一份、几百上千行的
`kits/custom.js`」没法拆：共享的辅助函数只能整段复制进每一个干员文件。而 `@包名/` 这种前缀不存在 ——
浏览器的 import map 是**每页一张静态表**，写不出「每个包一个前缀」。

所以给了第三种写法：**向下的相对路径**。

```js
// kits/chess_ws_kazdel_a.js —— 只写这一个干员的事
import { bondsShared } from './lib/bonds.js';   // 同一个包、同一个 kits/ 目录下的文件
import { num } from '@kit/tier1.js';            // 引擎的 SDK（§4.5）

export default function kit(bb, chess, def) { /* … bondsShared(…) … */ }
```

拆分前后（同一份 1138 行的 `kits/custom.js`）：

```
拆之前                     拆之后
kits/custom.js             kits/chess_ws_<id>_a.js   ← 一个干员一个文件
  1138 行                  kits/chess_ws_<id>_b.js
                           kits/lib/bonds.js          ← 共享的盟约辅助
                           kits/lib/items.js
                           kits/_shared.js            ← 也可以直接放在 kits/ 下
```

`lib/bonds.js` 里还能继续 `./` 到自己旁边的文件 —— **按它自己的位置解**，与服务端一致（两端都是「谁 import
就按谁的目录/URL 解」）。

#### 为什么 `./…` 两端都对得上，而 `..` 永远不行

kit 在磁盘上是 `<包目录>/kits/<id>.js`，浏览器取的却是 `/workshop-kits/<包>/<id>.js`：**`kits/` 这一段不在 URL 里**。
于是同一个 `./lib/util.js`：

| 端 | 基准 | 解析结果 | 实际文件 |
|---|---|---|---|
| 服务端 | `file:///<包目录>/kits/<id>.js` | `file:///<包目录>/kits/lib/util.js` | `<包目录>/kits/lib/util.js` |
| 浏览器 | `/workshop-kits/<包>/<id>.js` | `/workshop-kits/<包>/lib/util.js` | 同左（路由把 `<包>/<rel>` 映回 `<包目录>/kits/<rel>`） |

**同一个文件**。而 `../x.js` 做不到：磁盘上它要退到 `kits/` 之外，URL 上却没有 `kits/` 这一层可以退 ——
退的步数不同，两端必然指向不同文件。所以 `..` 仍然一律拒绝（连带 `/` 开头、裸模块名、`require`、动态 `import()`）。

#### 合法与非法（判据在 `shared/kitImports.js isPackRelativeSpecifier`，编辑器与加载器读同一份）

| 写法 | 结果 |
|---|---|
| `./helpers.js`、`./lib/bonds.js` | ✅ 放行（本包 `kits/` 下的 `.js`，逐段可拼） |
| `../x.js`、`./../x.js`、`./lib/../x.js` | ⛔ 含 `..` 段 |
| `./%2e%2e/x.js` | ⛔ 含 `%`（百分号编码解析后会变成 `..`，所以 `%` 一律拒绝） |
| `./x.mjs`、`./x`、`./`、`./x//y.js` | ⛔ 不是「以 `.js` 结尾、没有空段」的包内相对路径 |
| `./x.js?1`、`./x.js#a`、`./sub\x.js` | ⛔ 查询串/片段/反斜杠都算畸形 |
| `/abs/x.js`、`x.js` | ⛔ 绝对路径 / 裸模块名（同 §4.5.2） |

#### 哪些文件算 kit

`kits/` 下只有**顶层**的 `<干员 id>.js` 会被当成 kit；子目录里的文件与 `_` 开头的文件（`kits/_shared.js`）
都不是 kit，可以放共享代码。它们的字节同样进包身份哈希（§4.5.3）—— 辅助文件的字节能改变一场战斗的结果。

#### 两点不对称，都是刻意的

- **`server.battle` 不接受 `./…`**：那类模块在服务端是当 `data:` URL 加载的，`data:` 没有目录，相对说明符
  无从解析。战斗内容层的辅助函数请走 `@battle/`（DESIGN §28.17）。
- **`/workshop-battle/` 只服务登记过的 URL**：它没有第二个「按 URL 解出包内相对路径」的消费者，登记表就是它
  全部的入口（`/workshop-kits/` 服务的是已装载包 `kits/` 子树里的任意 `.js`，仍然只服务**已装载**的包）。

服务端只重写该重写的那几行（白名单 → 真实 `file:` URL，包相对 → 该文件自己目录下的 `file:` URL），磁盘上的字节
一个都不动，所以包摘要不变。测试见 `test/packRelativeImports.test.js`。

> 可运行示例 `docs/examples/kit-demo/` 仍然**一个 import 都不写**（它演示的是三条硬规则本身）。要看 `./…` 的
> 完整形态，读 `test/packRelativeImports.test.js`；把一份大文件拆成几个文件，照上面「拆之后」的目录摆法即可。

---

### 4.7 kit 键空间：`kits/<id>.js` 的 id 可以落在两个空间

**最终定义（这一句是判据本身）**：一个 kit 文件的 id 必须是**本包 chess 记录 id**、**本包声明进自选池的 charId**
（`pack.json.operators` 的键）、**本包 `tokens.json` 的 token id**、或**本包在 `pack.json.overrides` 里声明过的官方 id**
（`"chess:<id>"` / `"tokens:<id>"`）之一；四条都不满足就是 `KIT_NO_TARGET`。

引擎按**两把不同的键**取 kit，所以这里有**两个键空间**，一个文件名规则管两边：

| 空间 | 引擎在哪取 | 键是谁 | 谁算「本包拥有」 |
|---|---|---|---|
| **干员** | `server/sim/content/index.js kitOf()`：`def.charId`（补位 / 自选干员）→ 否则 `def.baseId` / `def.id` / 去掉 `_a`/`_b` 的裸 id | 干员 id | 本包 `chess.json` 的记录 id；`pack.json.operators` 声明的 charId（**自选池干员的 kit 就是按 charId 查的**，`isDiyDef` + `kitOf:85`）；`overrides` 里的 `"chess:<id>"` |
| **召唤物** | 同文件 `setupUnitKit()` 的 token 分支：`tokens.kits?.[def.id]`（`def.id` = token 记录的 id，`simdata.js normalizeToken` 逐字写下） | token 记录的 id | 本包 `tokens.json` 的记录 id；`overrides` 里的 `"tokens:<id>"` |

两个空间**分开裁决**：同一个 id 上的两条 kit 互不遮挡（各自注册、各自的冲突与覆盖判定），注入点也是两个 ——
服务端 `Battle opts.kits`（干员）/ `Battle opts.tokenKits`（召唤物），浏览器从**同一份** `spec.workshopKits`
模块清单重建两张表（召唤物那一半带 `kind: 'token'` 标记，缺省 = 干员，所以老包与老读者逐字节不变）。

**id 同时落在两个空间里是歧义，点名拒绝**（`KIT_TARGET_AMBIGUOUS`）：干员那一半会赢得引擎的查找，召唤物那一半
就成了一条**永远不会跑、也没有任何报错**的 kit —— 这正是这条通道存在的理由。两个空间**确有重名**的现实例子是
`data/tokens.json` 里的两名地图角色（`char_605_cmedic` / `char_613_acmedc`，`char_` 开头的 token id），所以
**判据是查表、不是看名字前缀**：装载器拿到的两张表说这个 id 在哪，它就在哪。

**冲突裁决（与 §1.2 同一条，一个字没改）**：两个包声明同一个 id（无论哪个空间）时，**包 id 字典序小的赢**，
输的一方拿到一条**点名**占位包的报告（`definedBy` + 文案里写出包名），与「包是按什么顺序被扫描到的」无关
（`server/workshop.js` 的 `byPackId`）。既有 `byPackId` 与 `KIT_ID_COLLISION` 的**顺序规则不变**，只是改为**按空间
各裁一次**。

**为什么要有第二个空间**：一个包的召唤物（例如一名干员的两个面具 token）原来只能有**数据**、没有**行为层** ——
`tokens.kits` 这张表是引擎内置的，包碰不到。现在它与干员那条通道逐字对称：同样的白名单、同样的归属判据、
同样的冲突裁决、同样的双端送达。

```js
// workshop/<包>/tokens.json          { "token_ws_mask_a": { … } }
// workshop/<包>/kits/token_ws_mask_a.js
export default function kit(bb, raw, def) {
  return { skill: null, install(battle, unit) { /* battle.on('deploy', …) */ } };
}
```

