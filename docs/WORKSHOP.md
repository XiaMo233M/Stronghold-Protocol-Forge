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
| 助战配置与校验（纯函数，前后端共用） | `shared/support.js` |
| 助战卡池的服务端声明 | `data/support.json` |
| 助战的引擎侧视图 | `server/match/gamedata.js` |
| 助战消息与落库 | `shared/protocol.js`、`server/lobby.js` |
| 助战的对局内生效 | `server/match/Match.js`、`server/match/PlayerState.js` |
| 测试 | `test/workshop.test.js`、`test/support.test.js` |

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

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 建议 | 包 id，必须等于目录名；只能是 `[A-Za-z0-9_-]`，≤32 字符 |
| `name` | 否 | 显示名（默认取 `id`） |
| `version` | 否 | 默认 `0.0.0` |
| `author` / `license` / `description` | 否 | 元信息；`license` 用于声明素材授权 |
| `gameVersion` | 否 | 作者针对的游戏版本，便于排查 |
| `content` | **是** | 这个包提供哪些数据文件（上表的名字），至少一个 |
| `overrides` | 否 | 允许覆盖的官方记录，格式 `"<file>:<id>"`，例如 `"chess:chess_char_1_01_a"` |

`content` 只接受上表列出的文件。**`config` 被刻意排除**：一个能改写经济、回合表或难度参数的包改的是规则而不是内容，那需要另一套审查机制，不在本功能范围内。

### 1.2 叠加规则

- **默认叠加（additive）**：新 id 直接加入。
- **覆盖需要显式声明**：官方已有的 id 只有在 `overrides` 里列出时才被替换；否则该记录**被拒绝并记入报告**，官方记录保留。这条规则存在的理由是：静默替换一名官方干员会污染服务器上的每一局。
- **记录自检**：内容文件必须是 `{ id: record }` 对象；当记录自带 id 字段（如 `chess.chessId`）而它与键不一致时，整条被拒绝。
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

仓库与官方整合包**不含任何游戏素材**（`.gitignore` 已排除 `public/assets/`）。工坊包可以自带素材，但：

- 仓库本身不接受素材文件；
- `pack.json` 的 `license` 字段应当声明该包素材的授权；
- 二次分发带素材的工坊包时，风险由分发者承担。

示例包的作法值得参考：它**不含素材**，而是复用已有干员的美术 id，只改身份与数值。这也是目前唯一无需分发素材就能让新内容正常渲染的方式（Spine 小人需要 `.skel` + `.atlas` 二进制对）。

### 1.5 作者接口（面向人，也面向 AI）

手写 `data/chess.json` 形状的记录需要约 30 个字段，其中大部分是机械的。作者层把这部分推导掉：

| 组件 | 作用 |
|---|---|
| `shared/chessAuthoring.js` | `deriveChessRecord(spec)`：从「名字 / 阶 / 职业 / 普通与精锐两套数值 / 技能文字」推导出合法的普通+精锐记录对；`validateChessRecord(rec)` 返回**机器可读**的 `{ field, code, message, hint }[]`（不抛异常、不半途停止） |
| `tools/workshop-scaffold.mjs` | `spec.json` → 写入 `<pack>/chess.json`（合并已有内容，必要时补 `pack.json`） |
| `tools/workshop-validate.mjs` | 三层校验：**格式 → 记录语义 → 真实引擎**（是否进商店池、能否解析出精英、模拟器能否构建 unit def）。`--json` 输出机器可读报告 |
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

### 1.6 当前状态

| 部分 | 状态 |
|---|---|
| 包发现、格式校验、叠加合并、失败关闭 | ✅ 已实现 |
| 合并数据送达浏览器（HTTP） | ✅ 已实现 |
| 新干员进入商店池、被购买、部署、真实战斗、精英/模组解析 | ✅ 已验证（`test/workshop.test.js`） |
| **地图（stages）**：推导 + 校验 + 2D 摆放器 | ✅ 已完成（`test/stageAuthoring.test.js`、`editor/ui/stage.html`、`tools/workshop-scaffold.mjs`） |
| **怪物 / 出怪表 / 装备** | ⚠️ 数据层可叠加，但**无推导、无校验、无界面**（见 §5 roadmap） |
| **作者接口**：spec → 合法记录、机器可读校验、模板 prompt、校验 CLI | ✅ 已实现（`test/chessAuthoring.test.js`） |
| **行为层**：包内 `kits/<chessId>.js` 接入 `battle.on(...)` 钩子总线 | ✅ 已实现（见 §4） |
| **局外编辑器 UI**（创建/编辑干员、装备、怪物、地图） | ⛔ **未实现**（目前用 spec + CLI） |
| 工坊包的版本对齐、依赖声明、内容寻址 | ⛔ 未实现（`gameVersion` 目前只是元信息） |

> 行为层是用户的明确选择（「完全开放 battle 钩子 API」）。它与一体化整合包的冲突按**分渠道**解决：官方整合包保持纯净、不含工坊内容；工坊包单独分发，玩家主动安装并知情。**注意：脚本会在客户端执行**（默认 `SP_COMBAT=client`），服务端 `SP_VERIFY` 只能复算结果、不能阻止脚本本身 — 这正是必须分渠道的原因。

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

这个文件由服务器维护、**不参与 `build-data`**，改完重启即生效，无需重建 `data/`。

### 2.2 「没有即禁用」的三层含义

1. **客户端看不到**：客户端只能通过 `gd.supportPicker()` 拿卡池；服务端是唯一来源。
2. **请求被整条拒绝**：`checkSupport()`（`shared/support.js`）对卡池外的 id、重复 id、超出该阶名额的请求返回 `BAD_TARGET`，**不做静默降级** — 静默降级会把「被禁用的干员」悄悄变成「已发放的干员」。空选择永远合法，表示不带助战。
3. **发放时再查一次**：`PlayerState.grantSupports()` 会重新核对卡池。因为 `data/support.json` 可能在 `lobby` 校验之后、对局开始之前被改掉；此时该干员被跳过并给玩家一条提示。

### 2.3 生命周期

```
房间席位 seat.support ─→ Match 构造 opts.seats[].support ─→ PlayerState.setSupport()（再校验）
                                                                    │
        INFO_CHECK 期间仍可改（与 room.loadout 一样，之后锁定）      │
                                                                    ▼
                                      ROUND 1 开始时 grantSupports() → acquireChess() → 整备区
```

- 实现方式刻意复用现有的 `acquireChess()`（买入/奖励/效果发放走的就是它）：助战干员从共享池**取走一份拷贝**，因此 `poolCopies` 与共享池恒等式（`left + Σ held == cap`）自动成立；卖出时会照常归还。
- 助战因此就是**普通棋子**：可卖、可合成精锐、可装备、可部署。
- 整备区满时由 `acquireChess()` 自行报告并返还拷贝。
- 机器人不带助战。

### 2.4 消息

`room.support { entries: [chessId, …] }` — 数组，最多 `SUPPORT_LIMITS.entries`(16) 项，元素为互不重复的合法 id。校验与 `room.loadout` 同风格：结构错误 `BAD_MSG`，语义错误 `BAD_TARGET`，对局已过 `INFO_CHECK` 则 `WRONG_PHASE`（stub 对局没有 `setSupport` 时 `ROOM_STARTED`，与 loadout 一致）。

### 2.5 当前状态

| 部分 | 状态 |
|---|---|
| 服务端卡池、名额、全部失败关闭路径 | ✅ 已实现并测试 |
| `room.support` 消息、会话/席位存储、对局内再校验 | ✅ 已实现并测试 |
| ROUND 1 发放进整备区、共享池记账恒等式 | ✅ 已实现并测试 |
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
| **必须自包含，不要 import 引擎模块** | 同一份文件服务端按真实路径加载、浏览器按 URL 加载，相对路径不可能同时对 |
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
- 可运行示例：**[docs/examples/kit-demo/](examples/kit-demo/README.md)**（含「常驻 +25% 攻击力」天赋，并演示上述三条规则）。

### 4.4 当前状态

| 部分 | 状态 |
|---|---|
| 服务端加载 + 校验 + 注入 `opts.kits` | ✅ 已用**真实战斗**验证（kit 的 `install` 在对局中确实执行） |
| 浏览器分发（spec 携带 URL + runner 重建同一张表） | ✅ 已实现并测试（模块可按 URL 取得、装配路径有断言） |
| 浏览器端**真机端到端**（Chrome 跑一场带 kit 的对局） | ⛔ 未做（需 `SP_E2E=1` + Chrome） |
| 编辑器里的 kit 编辑页签 | ⛔ 未做（kit 目前手写文件） |
| 包之间 kit id 冲突、kit 的沙箱与审查 | ⛔ 未做（冲突会被报告并跳过；沙箱按分渠道策略不做） |
