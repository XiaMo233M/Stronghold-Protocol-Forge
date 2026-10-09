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
| `gameVersion` | 否 | 作者针对的游戏版本，便于排查 | 包管理 → 包元数据 |
| `content` | 贡献项之一 | 这个包提供哪些数据文件（上表的名字，含 `bonds`、`units`） | 各页保存时自动补 |
| `voices` | 贡献项之一 | 这个包为哪些干员提供**默认配音**的语音，见 §1.4 | 语音页 |
| `voiceLangs` | 贡献项之一 | 同一个包给**其它配音语言**（cn/en/kr，默认那一档是日文）各配一份，见 §1.4；形状与 `voices` 相同，多一层语种 | 语音页（语种选择） |
| `bondIcons` | 贡献项之一 | 这个包为哪些盟约提供图标，见 §1.4 与 §1.8：`{ "<bondId>": "<包内相对 assets/ 的路径>" }` | 盟约页 + 该页的「已声明」清单 |
| `itemIcons` | 贡献项之一 | 这个包为哪些装备/道具提供图标，见 §1.4：`{ "<图标 id>": "<包内相对 assets/ 的路径>" }` | 装备页 + 该页的「已声明」清单 |
| `art` | 贡献项之一 | 这个包自带的外观素材（头像 / 立绘 / 模型）**与两张扁平图标表**（技能图标 / 分支图标），见 §1.4：`{ chars / enemies / tokens / skills / profSub: { "<id>": … } }` | 干员页 / 怪物页的「本包自带的外观素材」+ 「已声明」清单 |
| `support` | 否 | 这个包自己新增的、应当进助战卡池的干员 id 列表，见 §2.1；阶由记录推导 | 包管理 → 助战声明 |
| `operators` | 贡献项之一 | 这个包自己新增的、应当进**自选池**（自选编队）的干员，见 §1.2；名字/星级/职业/分支从本包那条 `units` 记录派生 | 包管理 → 自选池声明 |
| `playtest` | 否 | **试玩行为开关**（不进记录）：`{ "directToHand": ["<chessId>", …] }` —— 这些干员在编辑器「一键试玩」的第一回合直接进手牌，见 §1.2 与 docs/EDITOR.md §试玩 | 干员页的「试玩时直接发到手上」复选框（覆盖官方干员时写在这里；本包新增的干员仍写在记录里）+ 包管理 → 试玩直接发到手上（逐条删除） |
| `overrides` | 否 | 允许覆盖的官方记录，格式 `"<file>:<id>"`，例如 `"chess:chess_char_1_01_a"`、`"bonds:yanShip"`、`"units:char_4231_clemnt"` | 包管理 → overrides（盟约页覆盖官方时自动补 `bonds:<id>`） |
| `api` | 否 | 包写它时的**模组 API 区间**（钩子总线与 kit 契约，见 §1.9）：只有声明了才与 `shared/constants.js MOD_API_VERSION` 比对，不含这个 build 就整个包被拒（`MOD_API_INCOMPATIBLE`） | 包管理 → 包元数据（本轮只是可写可读可判，编辑器入口见 §1.9「当前状态」） |
| `assets` | 贡献项之一 | 客户端资源容器声明（§1.9）：`{ container, manifest, serverPolicy?, verify? }` | ⛔ 本轮无入口（A 段只做格式） |
| `client` | 贡献项之一 | C 层注册点声明（§1.9）：`{ panels: [{ id, slot, module, order?, gate? }], requires?: […] }`，`slot` 是闭枚举 | ⛔ 本轮无入口 |
| `server` | 贡献项之一 | 分发前准入钩子声明（§1.9）：`{ preDispatch: { module, policy, intercepts } }`；`intercepts` 必须是 `shared/protocol.js C2S` 里真实存在的类型 | ⛔ 本轮无入口 |
| `routes` | 贡献项之一 | 只读 HTTP 路由声明（§1.9）：`[{ path, file, cache? }]`，只服务包内 `.json` | ⛔ 本轮无入口 |
| `i18n` | 贡献项之一 | 给**已有语种**（`en` / `ja` / `ko` / `zh-TW` …）补界面词条：`{ "<语种>": "<包内相对 .json 路径>" }`，见 §1.10 | ⛔ 本轮无入口 |

**每个字段都有图形入口**（0.8.1 起，最后补上的是元数据与 `overrides`；`operators` 的入口见 §1.2）：写进 `pack.json`
的东西必须能在界面上增删改，包括**陈旧/没人用的条目**（它们只是不生效，不是错误，但要能删掉）。唯一没有入口的是 `id`：它必须等于目录名。

**顶层键是闭集**（`shared/workshop.js PACK_FIELDS`）：上面这张表**就是**这份格式认识的每一个字段。写一个不在这张表里的
顶层键（打错、或者抄了另一个 mod 格式的字段）**整个包被点名拒绝**：`PACK_UNKNOWN_FIELD`，理由里列出全部合法字段。
这不是「我们还没做」，是**刻意**的 —— 一个我们不认识的键如果只是被读过去，作者看到的是「包合法、加载了、可我写的那件事
没发生」。三个社区 mod 里最典型的三个键因此都被当场拒绝而不是静默丢弃：

| 键 | 今天的结果 | 想做的事 | 今天该往哪儿写 |
|---|---|---|---|
| `variants` | `PACK_UNKNOWN_FIELD` | 「同一份数据的另一套数值 + 一个开关」（满练度 / 12 部署位这类**可切换口径**） | **没有通道**。可以拿 `overrides` 落**一份**数值进默认口径，但那不是「可切换的变体」，而且会让包改默认规则（比不做更坏）。要做得先在引擎里做出「口径 / 变体」这一层（`data/official.json` + 运行时的练度开关，今天都不存在） |
| `skins` | `PACK_UNKNOWN_FIELD` | 干员时装（皮肤）与「换装」Tab：皮肤表 + 切换 UI + 包字段**三样都没有** | **走 `art`**（§1.4）—— `art.chars[<charId>]` 收 `avatar` / `portrait` / `spine`，也就是「这个包给这名干员一套外观素材」。**换装界面**是另一件事（C 层，§1.9.3 的 `client.panels` 能挂一个面板，但它读不到 store，换装要写进玩家状态就不在这个口子里）。`skins: {…}` 不是 `art` 的别名，别照抄 |
| `official` / `config` / `meta` / `shared` / `theme` / `serverModules` | `PACK_UNKNOWN_FIELD` | 官方口径文件 / 规则改写 / match 元注册表 / 共享层补丁 / 主题 / 服务端模块 | **刻意没有通道**（`config` 见下面那一段；其余是引擎特性或 wire 契约，按 `AGENTS.md`「Official first … the maintainer's decision only」） |

`content` 只接受上表列出的文件。**`config` 被刻意排除**：一个能改写经济、回合表或难度参数的包改的是规则而不是内容，那需要另一套审查机制，不在本功能范围内。

**只带素材的包是合法的包**：`content: []` + `voices` / `voiceLangs` / `bondIcons` / `itemIcons` / `art` / `operators` / `i18n`
里任意一项（见 §1.4、§1.10）。一个只给助战干员配语音、只给盟约/装备配一张图、只给某个干员配一张立绘、只给已有语种
补几条界面词条的包，不需要提供任何数据文件；反过来，这些贡献项**全空**才会被拒（`EMPTY_PACK`）。

`support` 与 `playtest` **不是**贡献项：`support` 只决定**助战卡池**里放谁，干员本体还是由 `content: ["chess"]` 带进来的
—— 所以一个只写 `"support": […]`、`content: []` 的包会被 `EMPTY_PACK` 拒，而理由里会点名 `support`（见 §2.1 的完整例子）。

中间层的四组能力声明（`assets` / `client` / `server` / `routes`，见 §1.9）与 `i18n` 也是贡献项 —— 但只有**声明了内容**
才算：`routes: []`（空数组）与不声明没有区别，照旧 `EMPTY_PACK`。`api` 与 `playtest` 一样**不是**贡献项：它们是声明
（前者的区间、后者的行为开关），一个只带它们的包什么都没带来。

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
  然后**任何**包都能用。
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
| `OPERATOR_FORM_MISSING` | `forms` 没覆盖自选槽要的档位 → 拒绝 + 点名缺的那一档。自选槽的**普通与精锐两条记录各自**要求一个档位（`shared/diy.js` `checkDiyPick` 同时解析两条），缺一个这个干员就挑不上；更重的是 `tools/golden.mjs` 会给池里每位配一个精锐场景，所以缺档位会让**语料生成抛异常**，`golden` / `ci` 全线挂。要求的那一组**从 `diy.slots` 的两条记录派生**（`requiredUnitForms`），不是硬编码 `2/60/7/3` |
| `OPERATOR_BAD_SHAPE` | `operators` 不是对象、某一条不是对象、`bonds`/`powers` 不是字符串数组、干员 id 不合法 → 拒绝 |
| **两个包给同一个 charId** | 内容文件那一层就按 §1.2 裁决：**包 id 字典序最小者赢**，输的一方得到一条点名报告（`units:<id>`），它的自选池声明随之作废（它其实没有可供声明的记录）。`ownedPool` 因此只会多一个 id |
| **`data/*.json` 一个字节都不改** | 叠加发生在 `deepFreeze` 之前（§1.3）。所以「作者能加」与「生成器是唯一来源」同时成立：磁盘上的 `ownedPool` 仍是生成器写的那份，`test/backups.test.js` 对**文件**的断言完全不受影响；把包删掉，游戏立刻回到原样 |
| **入池顺序只由包 id 排序决定** | 与目录扫描顺序无关（`byPackId`，DESIGN §28.3）—— 同样的包集合永远得到同样的 `ownedPool` |
| **潜能注解（`potDown` / `potMin` / `potBelow`）不写 = 潜能对它无效** | 包干员通常没有这些注解，0.2.2 引擎的行为是：**不报错、天赋不丢，但属性与天赋数值不随潜能缩放**（潜能 1 与潜能 6 真建局逐字节相同；官方带注解的干员会缩放）。要让它随潜能变，就得照官方记录把注解一并抄进 `forms` |
| 编辑器入口 | 包管理 → **自选池声明**（§1.1）。干员记录本身由干员页写成 `units.json`；**「新建一个干员」的表单不在本轮**，见 DESIGN §28.11 |

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
| **另外两张是扁平表** | `skills`（技能图标）与 `profSub`（职业分支图标）：条目本身**就是一条路径字符串**（`assets.skills[key]` / `assets.prof.sub[key]` 在官方清单里就是路径）。落点分别是 `assets.skills` 与 `assets.prof.sub`，见 §1.2 最后一小节；`skillsById` 没有通道（故意） |
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
`client` 落成行为** —— 包内的面板模块真的被送到浏览器并挂上四个宿主（§1.9.3），而「声明了却用不了的声明」从此
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
| `client` | `{ panels: [{ id, slot, module, order?, gate? }], requires? }` | 面板按 `id` 排序后才进清单；`module` 是包内相对路径，**不是 URL**；`slot` 是闭枚举 `root.overlays` / `root.guide` / `screen.game.aside` / `screen.result.footer`（DESIGN §28.8 已经数得清的那四个宿主）；`requires` 只能取 `serviceWorker` / `cacheStorage` / `webCrypto` —— 缺一即「浏览器不支持」，不是「装了但静默不工作」 |
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
| `content` 里任一文件 / `voices` / `voiceLangs` / `bondIcons` / `itemIcons` / `art` / `operators` | **算**（旧语义，一字未改） |
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
| C 层面板被注册、被挂载（模块路由 + `welcome.modPanels` + 四个宿主 + `order`/`gate`/`requires`） | ✅ 已实现（B2：`server/workshop.js loadWorkshopPanels`、`server/http/workshop.js workshopPanelFilesFor`、`public/js/ui/extensions.js`、`server/lobby.js welcomeInfo`；`test/modClientPanels.test.js`） |
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
- 声明的路径**先于**核心静态挂载被查找：一条声明过的路径不会因为磁盘上恰好有同名核心文件而变成别的东西。反过来，
  「声明了但文件不在」是 **404**，不会悄悄回落到那个同名核心文件。
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

**四个挂载点**（闭枚举，写别的整包被拒：`CLIENT_BAD_PANEL_SLOT`）：

| `slot` | 位置 |
|---|---|
| `root.overlays` | 最上层浮层（模态框、提示条这类东西放这里） |
| `root.guide` | 说明层之上、浮层之下 |
| `screen.game.aside` | 屏幕右侧竖条（对局界面旁边） |
| `screen.result.footer` | 屏幕底部横条（结算界面下方） |

四个宿主都是**固定的浮层容器**，与当前在哪个界面无关 —— 面板挂一次就一直在，不需要自己判断路由。容器的类与
`data-mod-slot` 属性由注册点在面板真的挂载时创建（没有包声明 `client` 时页面上一个容器都没有）。

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
| `log` | 带 `[mod <包>/<面板>]` 前缀的 `info` / `warn` / `error` |
| `host` | 属于这次挂载的 `<div>`；往里画界面 |
| `session.setPreload({ required, ready })` | **唯一**的 store 写口：入口闸门那两个状态位（见下） |
| `net.on(type, fn)` / `net.sendResourceMessage(msg)` | **唯一**的网络口；见下 |

**没有** store 句柄、没有 `net` 对象本身、没有对局对象、没有 `Match`/`Battle`，也**不能**自己注册
`socket.on('message')`。所以面板能画错，**改不了对局结果**。

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
  "verify": "sha256"                                  // 整包摘要的算法；缺省 sha256，今天只有这一种
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

## 4. 行为层（`kits/<chessId>.js`）

一个包可以带 JavaScript：`workshop/<pack>/kits/<chessId>.js`。**文件名就是干员 id**（写 `_a` 那个 `baseId`）。
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
| **只能 import 白名单里的模块** | 同一份文件服务端按真实路径加载、浏览器按 URL 加载，相对路径不可能同时对。所以作者写 `@kit/…` / `@sim/…` 前缀，两端各自解析（§4.5）；其余一切 import / `require` / 动态 `import()` 仍然是 `KIT_IMPORT` |
| **它会在玩家浏览器里执行** | 默认 `SP_COMBAT=client`；服务端用**同一份文件**复算，所以不要有环境依赖（随机用 `battle.rng`，不要碰 DOM/网络/时间） |

### 4.2 注入点与双通道（关键一致性）

- 注入点是 **`Battle opts.kits`**：`server/sim/content/index.js setupUnitKit()` 会**先**查它、再查内置注册表 ——
  按对局注入，**不改动那个冻结的全局表**。
- 浏览器拿不到函数，所以战斗 spec 里带的是 JSON 安全的 `workshopKits: [{ id, pack, url }]`，
  `public/js/battle/runner.js loadSpecKits()` 按 URL 动态 `import` 后重建**同一张表**。
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
| `KIT_IMPORT` | error | 白名单之外的 `import` / `export … from` / `require` / 动态 `import()` —— 违反 §4.1 第二条（服务端按路径、浏览器按 URL，相对路径不可能同时对）。白名单写法见 §4.5，错误 reason 里会直接列出可用的 specifier |
| `NO_DEFAULT_EXPORT` | error | 没有默认导出（加载器读的是 `mod.default`） |
| `KIT_NO_TARGET` | error | 包内没有这个干员 id，也没在 `pack.json overrides` 里声明 `chess:<id>` |

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
相对 specifier 对其中一端成立、对另一端必然不成立 —— 所以 kit 的 import 走**前缀白名单**：

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

一个文件只开一个名字；加一行就是同时给两端开一个模块（表在 `shared/kitImports.js`，浏览器那张 import map 由
`kitImportMap()` 生成、`test/kitImports.test.js` 钉住两者一致 —— 改表就要改 `public/index.html`，否则测试会红）。

#### 4.5.2 白名单之外：全部仍是 `KIT_IMPORT`（error）

| 作者写了 | 为什么不行 | reason 里会说的 |
|---|---|---|
| `'../shared/tier1.js'` | 相对路径：服务端解析成真实文件、浏览器解析成 `/workshop-kits/…` | 「相对路径无法同时在服务端与浏览器成立」 |
| `'./x.js'` | 同上 | 同上 |
| `'/abs.js'` | 绝对路径：浏览器按站点根、服务端按文件系统根 | 「绝对路径无法同时在服务端与浏览器成立」 |
| `'@kit/../../x.js'` | 路径穿越，一律拒绝 | 「路径穿越一律拒绝」 |
| `'@kit/evil.js'` | 前缀合法但模块名没开放 | 「模块名 "evil.js" 未开放」 |
| `'lodash'` | 裸模块名：两端都没有 node_modules 解析 | 「裸模块名未开放」 |
| `require('…')` | kit 两端都按 ES 模块加载，没有 CommonJS | 「禁止 require()」 |
| `import('@kit/tier1.js')` | 动态 import 的 specifier 是表达式，两端都无法静态解析 | 「禁止动态 import()」 |
| `export { x } from '…'` | 与 `import` 同一张白名单（`export … from` 也是一个模块依赖） | 同 import |

每一条 reason 末尾都会列出**完整白名单**，`hint` 里给可用写法 —— 拒绝的时候必须说清允许什么。

#### 4.5.3 哈希与确定性（两条都不受影响）

- **包哈希按作者写的源码算**：`server/workshop.js identifyPack()` 把 `kits/*.js` 的**磁盘字节**放进 `[path, sha256]`
  清单（DESIGN §28.2）。服务端那次重写只发生在内存里，**不落盘、不进哈希**，所以同一个包在两端摘要一致。
- **确定性判罚不变**：`Math.random` / `Date.now` / `fetch` / `document` … 仍然是 `KIT_NONDETERMINISTIC`
  （warning），本次只动 import 口径。

测试：`test/kitImports.test.js`（白名单表与两端解析、校验器口径、服务端真加载并调用 `num`、白名单外仍被拒、
哈希前后不变、社区 kit 5 条映射、以及每个白名单文件的**导出名下限**守卫 —— 删名/改名会红并点名，
加导出不会）；真机那半是 `test/ui/kitimports.e2e.test.js`（默认跳过，见 §4.4 的命令）。
