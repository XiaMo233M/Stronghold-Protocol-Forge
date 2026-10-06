# 官方 Prompt（创作模板）

把一个 prompt 文件**全文**作为 prompt，连同你的**事实**（数值、文字描述、想要的效果）交给任意 AI，它就能产出
本仓库能直接使用的工坊内容。这些文件是本项目的官方创作接口 —— 它们和编辑器、CLI、校验器共用同一批
`shared/*Authoring.js` 规则，所以**AI 写出来的东西与人在编辑器里点出来的东西完全一样**。

| Prompt | 用于 | 状态 |
|---|---|---|
| [operator-pack.md](operator-pack.md) | 干员（含技能黑板、天赋、普通/精锐两套数值、**模组**、**攻击分类覆盖**、**盟约成员**） | ✅ 完整（含黑板书键表） |
| 本文档的「各内容种类的 spec 形状」一节 | 地图 / 怪物 / 出怪 / 装备 / **盟约** / 语音 / 行为层 kit | ✅ 形状与推导规则在此，配合校验器闭环 |

> 为什么只有一个独立的 prompt 文件：干员的黑板书有 **60 多个键**、每个键的含义与拼写例外都必须写清楚，
> 那是唯一需要一整份文档的内容种类。其余几种的 spec 形状很短，且都能用同一条闭环
> （推导 → 校验 → 按 `code` 改）收敛，所以它们放在下面。**行为层 kit 是例外中的例外**：它不是 spec 而是
> JavaScript 代码，形状只有一个「默认导出一个函数」，但三条硬规则都会静默失败 —— 编辑器里有专门的
> `/kit.html` 页签直接编辑这个文件并实时做静态检查（见下面「行为层 kit」一节）。

---

## 一、所有内容共用的两条硬规矩

这两条不是风格建议，是**结构性**的。编辑器、CLI、校验器和本 prompt 都建立在它们之上。

1. **只写你知道的，机械字段一律推导。** 每个 `derive*` 都会把价格、稀有度、寻路、攻击分类、`attrPower`、
   `params` 之类的字段算出来。手写它们不会更准，只会和引擎不一致 —— 校验器会重算并比对，报 `STALE_DERIVED`。
2. **校验器复用真实引擎。** `tools/workshop-validate.mjs` 的分层是：格式 → 记录语义 → **真实引擎**
   （能否进商店池、精锐是否互指、模拟器能否构建 unit def、物品商店抽不抽得到）→ 每种内容一层
   （kits / 地图 / 怪物 / 出怪 / 装备 / 语音 / 助战）。所以「把它写成一个好记录」和「让引擎接受它」是同一件事。

**闭环（务必执行，别只看代码）**：

```powershell
node tools/workshop-validate.mjs <包目录> --json    # 机器可读：每条带 field / code / message / hint
```

`0 error(s)` 即 `VALID: the engine accepts this content.`。按 `code` 改，再跑一次。

**工作目录约定**：一个包就是 `workshop/<packId>/`，`pack.json` 里 `content` 列出这个包贡献哪些文件
（`chess` `items` `enemies` `stages` `waves` `bonds`）。`<kind>-specs/<slug>.json` 是**可编辑的源**，
`<kind>.json` 是**推导产物** —— 产物不要手改，改源再推导。行为层 kit 是唯一的例外：它在 `kits/<干员 id>.js`，
**不进 `content`**（`content` 只列数据文件），也没有推导产物 —— 文件本身就是游戏加载的东西。
语音是第二个例外：它写在 `pack.json.voices` 里，音频文件放在包的 `assets/` 下（见下面「语音」一节）。
盟约的源目录是 `bond-specs/`（不是 `specs/`），因为盟约 id 是它自己的键，不和干员共用一个目录。

---

## 二、各内容种类的 spec 形状

### 地图（`stage-specs/<slug>.json`）

```json
{
  "id": "my_map", "name": "示例地图", "weight": 40, "modes": ["mode_multi_normal"],
  "rows": ["SrrrrrrrrrrrrrrrrrrrE", "…19 行 × 21 列，row 0 是最下面一行…"],
  "tiles": { "r": { "tileKey": "tile_road", "height": "LOW", "buildable": "ALL", "passable": "ALL",
                    "groundPassable": true, "flyPassable": true, "special": null, "bb": {} } },
  "devices": [{ "key": "trap_1105_accrate", "pos": [11, 10], "dir": "UP", "hidden": false, "role": "crate" }],
  "options": { "characterLimit": 8, "moveMultiplier": 0.5 },
  "routes": [{ "motion": "WALK", "start": [9, 0], "end": [9, 20], "checkpoints": [[9, 10]] }],
  "rounds": { "2": { "template": "my_wave_id" } }
}
```

- **`rows` 是 19 行 × 21 列**，字符取自 `TILE_PALETTE`（`shared/stageAuthoring.js`）；`S` 敌方入口、
  `E` 保护目标。`row 0` 是最下面一行（与引擎存储一致）。
- **不要写** `groundPaths` / `groundPathsWithDevices` / `deployTiles`：它们由 `server/stageAuthoring.js`
  调用**引擎自己的寻路**（`server/sim/grid.js`）推导。工坊地图的 `routes` 存在 spec 里，不进入记录。
- `modes` 必须至少写一个；加载器只把这些模式追加进 `config.modes[].stages`，不改 config 其他字段。
- 图形化等价物：编辑器 `/stage.html`（2D 摆放器 + 路线 + 3D 预览）。

### 怪物（`enemy-specs/<slug>.json`）

```json
{
  "id": "my_hound", "name": "示例猎犬", "rank": "ELITE", "applyWay": "MELEE", "motion": "WALK",
  "dmgType": "phys", "desc": "一句话说明。",
  "stats": { "maxHp": 4200, "atk": 620, "def": 180, "res": 20, "moveSpeed": 1.6, "bat": 1.3,
             "blockCnt": 1, "massLevel": 2, "rangeRadius": 0.8 },
  "abilities": [{ "text": "无法被阻挡" }], "talents": { "bb": { "move_speed": 0.3 }, "bbStr": {} },
  "skills": [], "tags": ["origen"], "immunities": { "silence": true, "frozen": true },
  "spine": "enemy_1007_slime", "beFactor": 1
}
```

- 最终 key 是 `enemy_ws_<slug>`。**`attrPower` 与 `be` 由数值推导**：`be` 决定阵营换怪时替换多少只，
  手写它会静默换错数量，所以校验器会重算并比对。
- `spine` 复用现有 prefab 键才有真美术（仓库不含素材）。图形化等价物：编辑器 `/enemy.html`。

### 出怪表（`wave-specs/<slug>.json`）

```json
{
  "id": "my_round2", "kind": "normal", "characterLimit": 8,
  "routes": [{ "motion": "WALK", "start": [9, 0], "end": [9, 20], "checkpoints": [] }],
  "spawns": [
    { "time": 3,  "key": "enemy_1007_slime", "count": 2, "interval": 5, "routeIndex": 0, "slot": "N" },
    { "time": 20, "key": "enemy_1007_slime", "count": 1, "interval": 0, "routeIndex": 0, "slot": "NF", "unharmful": true }
  ],
  "usedBy": [{ "modeId": "mode_multi_normal", "round": 2 }]
}
```

- **`totalCount` 与 `slotCounts` 由 `spawns` 推导**，且两者**不对称**：`slotCounts` 计入 `unharmful`，
  `totalCount` 不计入（`build-data` 的原样行为）。
- 两条最容易静默失败的检查：`spawns[].key` 必须是**存在**的敌人键（不存在则这一项什么都不刷）；`routeIndex`
  必须指向本表 `routes` 里的下标（越界时模拟器会**悄悄退回 route 0**，敌人走另一条路）。
- **绑定到回合**：记录哪个模式的第几回合用它（`usedBy`）。真正生效是在**地图**里写 `rounds` 指向它
  （方案 B），这样官方地图完全不受影响。图形化等价物：编辑器 `/wave.html`（时间轴 + 明细表）。

### 装备（`item-specs/<slug>.json`）

```json
{
  "id": "my_charm", "name": "示例护符", "desc": "攻击时使目标减速。",
  "itemType": "EQUIP", "category": "ON_HIT", "tier": 3, "price": 12,
  "upgradeNum": 2, "duration": -1, "trapId": "trap_1013_lhp",
  "buffs": [
    { "key": "equip_frost", "countType": "NONE", "bb": { "atk": 0.15, "attack_speed": 12 }, "bbStr": {} }
  ]
}
```

- **一件装备 = 一个 spec = 两条记录**（`chess_item_ws_<slug>_a` 普通 + `_b` 精英）。`mergeable` 本来就是
  「不是精英、`upgradeNum` 在 0 和 100 之间、**并且有一个能合进去的对象**」，所以只写一条的可合成装备点不动。
- **`params` 由 buffs 的黑板推导**（`{...bb, ...bbStr}` 依次摊平，先出现的键先赢）。引擎读的是 `params`，
  **不是 buffs** —— 改了 buffs 忘了重推，会做出一件「卡面写得很好、进游戏什么都不干」的装备。
- `trapId` 复用现有装备图标（仓库不含素材）；可用的 trap id 由 `GET /api/items` 的 `icons` 列出。
- 图形化等价物：编辑器 `/item.html`。

### 盟约（`bond-specs/<bondId>.json`）

盟约（羁绊）有**三层**，写 spec 时要分清哪一层是你能改的：

| 层 | 字段 | 改了会怎样 |
|---|---|---|
| 计数与激活 | `countMode` `thresholds` `countsHand` `countsGoldenOnly` | 谁算成员、几个才算激活 |
| 数据面 | `weight` `isCore` `desc` `iconId` `members` | 本局禁用抽签、界面显示、盟约弹窗列谁 |
| 战斗加成 | 引擎实现（官方 23 条按 id 写死）+ `genericBuffs` | 见下面两条 |

```json
{
  "id": "bond_ws_my_bond", "name": "示例盟约", "isCore": false, "bondType": "SEASON",
  "identifier": 99, "weight": 10, "countMode": "BOARD", "thresholds": [3, 6, 9],
  "activeType": "BATTLE", "desc": "【示例盟约】干员攻击力提升（受层数影响）",
  "bb": { "base_atk": 0.15, "atk_per_stack": 0.05 },
  "genericBuffs": true
}
```

- **覆盖官方盟约 = 真正修改盟约**：官方 23 条的效果在 `server/sim/content/bonds/*` 里按 id 实现，但阈值、计数模式、
  说明、黑板数值全部从 `data/bonds.json` 的记录读。所以用官方 id 写一份记录、并在 `pack.json` 的
  `overrides` 里写 `"bonds:<id>"`，改的数字**立刻生效**。此时**不要**打开 `genericBuffs` —— 会和官方处理器叠加两次。
- **新增盟约必须打开 `genericBuffs`** 才能在战斗里加东西：`server/sim/content/bonds/dataDriven.js` 按 `bb` 的
  `base_atk` / `atk_per_stack`（防御 `base_def` / `def_per_stack`、生命 `base_max_hp` / `max_hp_per_stack`）
  给成员加百分比，与官方盟约同一个「直接乘算」桶。**不打开**时这条盟约只有数据面：计数、阈值、层数、
  详情与盟约条都正常，但战斗里不加任何东西。
- **`members` 不是盟约说了算**：它由**干员的 `bonds` 列表**推导（见 [operator-pack.md](operator-pack.md) 第四节）。
  手写 `members` 不会有用 —— 引擎按干员记录数人。
- **图标只能复用本机已装好的**：客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图，一个包无法给
  `assets.json` 加条目 —— 新增盟约在盟约条上是一个圆点，覆盖官方则沿用官方图标。
- `content` 里要声明 `bonds`，否则加载器**完全不读**这个包的 `bonds.json`（与干员同一个坑）。
- 图形化等价物：编辑器 `/bond.html`（左栏清单 / 中间表单 / 右侧「战斗里会加什么」的实时结论）。

### 语音（`pack.json.voices`）

语音**没有 spec 文件、也没有推导产物**：它直接写在包自己的 `pack.json` 里，音频文件放在包的 `assets/` 下。
（这也是唯一一种能独立成包的内容 —— 一个只配语音的包可以 `content: []`。）

```json
{
  "id": "my-voice", "name": "助战语音", "version": "1.0.0", "license": "CC0-1.0",
  "content": [],
  "voices": {
    "char_ws_my_op": {
      "start":  ["voice/start.mp3"],
      "select": ["voice/select1.mp3", "voice/select2.mp3"],
      "deploy": ["voice/deploy.mp3"],
      "battle": ["voice/battle1.mp3", "voice/battle2.mp3"],
      "win":    ["voice/win.mp3"],
      "lose":   ["voice/lose.mp3"]
    }
  }
}
```

| 规则 | 说明 |
|---|---|
| **槽位只有六个** | `start`（行动出发/开始）`select`（选中）`deploy`（部署）`battle`（作战中）`win`（胜利结算）`lose`（失败结算），即 `shared/constants.js` 的 `VOICE_SLOTS`。写别的槽位整包被拒（`VOICE_SLOT_UNKNOWN`） |
| **一个槽位可以多条** | 客户端每次随机一条，且不会连续重复；同一个词给几段不同语气是正常用法 |
| **路径相对 `assets/`** | 例如 `voice/select1.mp3` 指 `<pack>/assets/voice/select1.mp3`。绝对路径、`..`、`.`、反斜杠、盘符都会被拒 |
| **有 `assets/` 就必须有 `license`** | 音频也是素材，授权由包作者承担（`ASSETS_NEED_LICENSE`） |
| **可以只给官方干员补几条** | 同一槽位官方台词在前、包台词在后，一起参与随机；不会替换官方语音 |

**你能做与不能做**：你把音频文件放进 `<pack>/assets/voice/`，然后按上面的形状声明路径 —— 剩下的（编码成 URL、
送达客户端、何时播放）由加载器和游戏负责。**不要**去改 `data/assets.json`：那是生成物，包语音由叠加层合进去。
`node tools/workshop-validate.mjs` 的语音层会检查每条台词的文件在不在、扩展名是不是可播放的媒体类型
（`VOICE_FILE_MISSING` / `VOICE_TYPE_UNSERVABLE` 是错误），以及这个干员 id 是不是真的存在
（`VOICE_UNKNOWN_OPERATOR` 是警告 —— 这种台词永远不会播）。图形化等价物：编辑器 `/voice.html`。

### 自己的干员进助战卡池（`pack.json.support`）

新增的干员默认**不能**被选为助战：助战卡池只有 `data/support.json` 一个来源。让这个包自足的办法是在清单里声明：

```json
{ "id": "my-ally", "content": ["chess"], "support": ["chess_char_ws_my_ally_01_a"] }
```

- **只写本包自己新增的干员 id**。写官方干员会被拒（`SUPPORT_FOREIGN_OPERATOR`）—— 卡池是安装方的规则决定，
  内容包不能改它。
- **不要写阶**：装载时按记录自己的 `tier` 决定进哪一阶。手写阶就会出现「写错了没人报错、该干员静默不可选」
  （记录没有 1–6 的整数 `tier` 记 `SUPPORT_TIER_UNKNOWN`）。
- 安装方可以在 `data/support.json` 写 `"workshop": false` 忽略所有包的助战声明。
- **助战的价格也是安装方的事**：`data/support.json` 的 `"prices": { "<chessId>": 3 }` 改的是带这名助战的玩家商店里的标价
  （0–99 的整数，只认卡池里真有的 id）；没配的用它的阶级价，出售价一律走普通棋子的 `sellPrice`。
  助战仍然受阶级店铺等级门限限制（六阶助战要商店等级 6 才摇得到）。

### 行为层 kit（`kits/<chessId>.js`）

```js
export default function kit(bb, chess, def) {
  return {
    skill: { kind: 'ammo', ammo: nb(bb.trigger_time, 8), mods: { atkPct: nb(bb.atk, 0) } },
    talents: [{ name: '天赋名', description: '说明', install(battle, unit) { battle.addBuff(unit, { key: 'p:t', duration: Infinity, mods: { atkPct: 0.25 } }); } }],
  };
}
```

三条硬规则（**都会静默失败**，所以校验器逐条检查）：

1. **返回了 kit 就必须自己给出 `skill`** —— 否则这名干员没有技能，缺省技能不会回退到通用 kit。
2. **必须自包含，不能 import** —— 同一份文件服务端按路径加载、浏览器按 URL 加载，相对路径不可能同时对。
3. **它会跑在玩家浏览器里** —— 服务端用同一份文件复算，所以不要有环境依赖（随机用 `battle.rng`，不要碰
   DOM / 网络 / 墙钟时间）。

外加一条：钩子名必须是引擎**真正会 emit** 的名字。`battle.on('x')` 接受任意字符串，而写错的名字**永远不会
触发**；校验器会给出 `HOOK_UNKNOWN_EVENT` 和「你是想写 … 吗」的建议（词表见 `shared/kitAuthoring.js` 的
`HOOK_EVENTS`，由漂移守卫钉在引擎源码上）。

- 图形化等价物：编辑器 **`/kit.html`**（`docs/EDITOR.md`）。它编辑的就是这个文件本体 —— 中间那一栏是整份源码，
  右栏是上面这些静态检查的实时结果（外加它注册的钩子与这个包合法的 kit id）。它**只读文本、不执行你的文件**：
  真正把文件 `import` 一遍（能否加载、有没有默认导出）由 `node tools/workshop-validate.mjs` 完成。
- 保存时编辑器会在文件开头补写**署名头注释**（作者 / 创建时间 / 修改时间 / 来源 / 著作权与反打包转售声明全文），
  已有的一行只更新 `modified` —— 详见下面第三节。

---

## 三、Option 署名（自动，不需要你写）

用编辑器保存的每一份 spec 都会带上 `_meta`：作者、创建时间、来源、著作权声明、反打包转售声明。
`created` 只写一次，之后保存只更新 `modified`。它**只存在于源文件**，不会进入游戏读的产物 —— 所以
AI 或手写 spec 时不必自己造这个字段，走编辑器保存即可获得；直接写文件的话可以留空。

**行为层 kit 是唯一的例外**：它是一个 `.js` 文件，没有一个数据对象可以挂 `_meta`，所以同一份声明写在**文件头注释**里：

```js
// @forge created=2026-10-06T06:30:26.000Z modified=2026-10-06T07:12:03.000Z pack=my-pack source=Stronghold-Protocol-Forge author=水沫沐沐
```

这一行是机器可读的（`created` 就是从这里读回来的），下面接着声明全文。编辑器保存时自动补写：没有头才写，
已有的一行只更新 `modified`，也绝不动你自己写在文件里的注释。

声明全文见 [README 的著作权声明](../../README.md#著作权声明)。

---

## 四、成套的自查命令

```powershell
node tools/workshop-scaffold.mjs <spec.json> --pack <packId> [--workshop <root>] [--dry-run] [--json]
node tools/workshop-validate.mjs <包目录> [--json]     # 分层校验，含真实引擎与语音文件
npm run editor                                        # 图形化等价物（只绑 127.0.0.1）；语音页 /voice.html
```
