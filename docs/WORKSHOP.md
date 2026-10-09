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
  items.json  enemies.json  stages.json  waves.json  tokens.json  bosses.json
  factions.json  garrisons.json  bands.json  bonds.json  effects.json  choices.json
```

`pack.json`：

| 字段 | 必需 | 说明 | 编辑器里的入口 |
|---|---|---|---|
| `id` | 建议 | 包 id，必须等于目录名；只能是 `[A-Za-z0-9_-]`，≤32 字符 | 建包时定（改它等于换一个包） |
| `name` | 否 | 显示名（默认取 `id`） | 包管理 → 包元数据 |
| `version` | 否 | 默认 `0.0.0` | 包管理 → 包元数据 |
| `author` / `license` / `description` | 否 | 元信息；`license` 用于声明素材授权 | 包管理 → 包元数据 |
| `gameVersion` | 否 | 作者针对的游戏版本，便于排查 | 包管理 → 包元数据 |
| `content` | 贡献项之一 | 这个包提供哪些数据文件（上表的名字，含 `bonds`） | 各页保存时自动补 |
| `voices` | 贡献项之一 | 这个包为哪些干员提供**默认配音**的语音，见 §1.4 | 语音页 |
| `voiceLangs` | 贡献项之一 | 同一个包给**其它配音语言**（cn/en/kr，默认那一档是日文）各配一份，见 §1.4；形状与 `voices` 相同，多一层语种 | 语音页（语种选择） |
| `bondIcons` | 贡献项之一 | 这个包为哪些盟约提供图标，见 §1.4 与 §1.8：`{ "<bondId>": "<包内相对 assets/ 的路径>" }` | 盟约页 + 该页的「已声明」清单 |
| `itemIcons` | 贡献项之一 | 这个包为哪些装备/道具提供图标，见 §1.4：`{ "<图标 id>": "<包内相对 assets/ 的路径>" }` | 装备页 + 该页的「已声明」清单 |
| `art` | 贡献项之一 | 这个包自带的外观素材（头像 / 立绘 / 模型），见 §1.4：`{ chars / enemies / tokens: { "<id>": <官方条目形状的子集> } }` | 干员页 / 怪物页的「本包自带的外观素材」+ 「已声明」清单 |
| `support` | 否 | 这个包自己新增的、应当进助战卡池的干员 id 列表，见 §2.1；阶由记录推导 | 包管理 → 助战声明 |
| `overrides` | 否 | 允许覆盖的官方记录，格式 `"<file>:<id>"`，例如 `"chess:chess_char_1_01_a"`、`"bonds:yanShip"` | 包管理 → overrides（盟约页覆盖官方时自动补 `bonds:<id>`） |

**每个字段都有图形入口**（0.8.1 起，最后补上的是元数据与 `overrides`）：写进 `pack.json` 的东西必须能在界面上增删改，
包括**陈旧/没人用的条目**（它们只是不生效，不是错误，但要能删掉）。唯一没有入口的是 `id`：它必须等于目录名。

`content` 只接受上表列出的文件。**`config` 被刻意排除**：一个能改写经济、回合表或难度参数的包改的是规则而不是内容，那需要另一套审查机制，不在本功能范围内。

**只带素材的包是合法的包**：`content: []` + `voices` / `voiceLangs` / `bondIcons` / `itemIcons` / `art` 里任意一项（见 §1.4）。
一个只给助战干员配语音、只给盟约/装备配一张图、或只给某个干员配一张立绘的包，不需要提供任何数据文件；
反过来，这些贡献项**全空**才会被拒（`EMPTY_PACK`）。

### 1.2 叠加规则
- **默认叠加（additive）**：新 id 直接加入。
- **覆盖需要显式声明**：官方已有的 id 只有在 `overrides` 里列出时才被替换；否则该记录**被拒绝并记入报告**，官方记录保留。这条规则存在的理由是：静默替换一名官方干员会污染服务器上的每一局。
- **记录自检**：内容文件必须是 `{ id: record }` 对象；当记录自带 id 字段（如 `chess.chessId`）而它与键不一致时，整条被拒绝。
- **两个包抢同一个 id：包 id 字典序小的赢**（DESIGN §27.3，2026-10-09 业主裁定）。这一条**对所有面都一样** —— 数据记录、`kits/<chessId>.js`、`bondIcons`、`itemIcons`、`art`；而且与「包是按什么顺序被扫描到的」**无关**（服务端按目录名读、合并前再按包 id 排序，两处用同一个比较器）。输的一方会得到一条**点名**占位包的报告（`definedBy` + 文案里写出包名），不是静默覆盖。
- **覆盖官方 id 仍要显式声明**：`overrides` 是唯一能让一个包替换**官方**记录 / 官方干员 kit 的方式，且这份声明会让它同时成为「后来的包」要撞的那一方（上一条规则决定谁赢）。**给维护者的一句话**：编辑器这一侧的判罚必须**同时看 id 与声明**，不能只在校验前把官方 id 从集合里剔掉 —— 后者会让编辑器放行一次保存、而加载器随后因为「没声明」丢掉这条记录（编辑器回 200、游戏里没有），比「编辑器 400 拒绝」更坏。所以放行与记住声明是同一次保存的两半（`editor/server.mjs` 的 `overrideBlockers` 与 `withOverrideDeclarations`），预览与保存也必须算出同一个判罚。
- **覆盖是「按字段打补丁」，不是整条替换**（DESIGN §27.3，2026-10-09）：只写 `stats.maxHp` 就只改这一个数，官方那条记录的其它 43 个字段（`tier` / `skill` / `talents` / `rangeGrid`…）原样保留；数值与普通对象递归合并，**行为与结构字段整块替换** —— `skill` / `skills` / `trait` / `traitBase` / `traitOverride` / `modules` / `rangeGrid` / `attackRangeGrid` / `assets` / `diy` / `bonds`（清单在 `shared/workshop.js` 的 `OVERRIDE_REPLACE_KEYS`，数组一律整块替换）。**覆盖是闭合世界**：写了记录里没有的字段会被 `UNKNOWN_OVERRIDE_FIELD` 拒绝（要发明新字段就把它作为一个新 id 的新记录）。想「连行为一起接管」的包必须成套补回：给了 kit 就要给 `skill`（§4.1），否则那个干员没有技能。
- **两张天赋表按条目合并，不是整块替换**（DESIGN §27.3，2026-10-09 当天第二次修正）：`talents` / `talentsBase` 按 `index` 逐条合并 —— 你写的那一条里出现的字段生效，**你没写的字段（包括官方那条天赋自带的注释）留着**；`index` 对不上官方任何一条时是「你新增了一条天赋」，追加在后面。模组内部的 `modules[].talentChanges` 同理，按 `talentIndex` 逐条合并。
  **为什么单独开一条规则**：官方记录里的天赋可以带「潜能链」注释（记录层的 `potDown`、天赋层的 `potMin` + `potBelow`），而编辑器派生出来的记录**故意不带**这些注释。整块替换的话，你只是改了一条天赋的文案，官方那条天赋的整条潜能链就没了，而加载器一句错都不报 —— 一条**静默**的数据丢失。裸列表（`bonds` / `immunities` / `rangeGrid` …）仍然是整块替换：按字段合并一个裸列表会造出一条没人写过的记录。
- **失败关闭**：包 id 不合法、`content` 为空、文件缺失或不是合法 JSON — 该包被跳过并报告，服务器继续启动。
- **`workshop/` 不存在是正常情况**：没有包就没有叠加层，行为与加入本功能之前完全一致。

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
| 三张表，形状照抄官方条目 | `chars` 的 `spine` 是**嵌套**的 `{ front: …, back: … }`；`enemies` / `tokens` 的 `spine` 是**扁平**的。可用的字段就是官方条目里的那几个：`chars` 用 `avatar`/`avatarE2`/`portrait`/`portraitE2`，`enemies` 用 `icon`（另有 `spineAliasOf` 指向别的模型），`tokens` 用 `avatar`（另有 `owner`）。写别的字段会被拒（`ART_UNKNOWN_FIELD`） |
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
| 浏览器端**真机端到端**（Chrome 跑一场带 kit 的对局） | ⛔ 未做（需 `SP_E2E=1` + Chrome；import map 的解析本身由浏览器做，Node 没有 import map） |
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
  清单（DESIGN §27.2）。服务端那次重写只发生在内存里，**不落盘、不进哈希**，所以同一个包在两端摘要一致。
- **确定性判罚不变**：`Math.random` / `Date.now` / `fetch` / `document` … 仍然是 `KIT_NONDETERMINISTIC`
  （warning），本次只动 import 口径。

测试：`test/kitImports.test.js`（白名单表与两端解析、校验器口径、服务端真加载并调用 `num`、白名单外仍被拒、
哈希前后不变、社区 kit 5 条映射）。
