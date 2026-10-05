# 干员工坊包生成 · 模板 Prompt

把这份文档全文作为 prompt，连同**干员的技能文字描述**与**普通 / 精锐两套数值**一起交给任意 AI（或人），
它就能产出本仓库能直接使用的工坊干员包。

配套工具（生成后必须跑一遍）：

```powershell
node tools/workshop-scaffold.mjs <spec.json> --pack <packId>     # spec → 合法记录（自动补齐机械字段）
node tools/workshop-validate.mjs <packId 或 workshop 根>          # 三层校验，含真实引擎检查
```

---

## 一、你要产出的东西

一个 JSON 文件（`spec`）。**只填你知道的事实**，其余由工具推导。

```json
{
  "id": "abyss_hunter",
  "name": "深渊猎手",
  "appellation": "Abyss Hunter",
  "tier": 5,
  "profession": "SNIPER",
  "subProfessionId": "fastshot",
  "position": "RANGED",
  "traitDesc": "优先攻击空中单位",
  "assetsSpine": "char_1038_whitw2",

  "stats": {
    "normal": { "maxHp": 1500, "atk": 480, "def": 140, "res": 0, "cost": 18, "blockCnt": 1, "bat": 1.0 },
    "golden": { "maxHp": 1900, "atk": 620, "def": 180, "res": 0, "cost": 18, "blockCnt": 1, "bat": 1.0 }
  },

  "skill": {
    "name": "贯穿射击",
    "desc": "攻击力+60%，攻击装有8发弹药",
    "skillType": "MANUAL",
    "durationType": "AMMO",
    "spType": "INCREASE_WITH_TIME",
    "spCost": 30,
    "initSp": 10,
    "bb": { "atk": 0.6, "atk_scale": 1.6, "trigger_time": 8 }
  },

  "talents": [{ "name": "猎手嗅觉", "desc": "攻击空中单位时攻击力提升至115%", "bb": { "atk_scale": 1.15 } }]
}
```

### 字段规则

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 短横线/下划线 slug。最终 id 为 `chess_ws_<slug>_a` / `_b`（普通 / 精锐） |
| `name` | ✅ | 显示名 |
| `tier` | ✅ | 1–6，决定 **价格**（2/3/3/3/4/4）与 **稀有度** |
| `profession` | ✅ | 必须是 `WARRIOR` `SNIPER` `CASTER` `MEDIC` `SUPPORT` `TANK` `SPECIAL` `PIONEER` 之一。**注意：这是本项目数据里的名字，不是通用职业名** —— 重装是 `TANK`（不是 DEFENDER）、先锋是 `PIONEER`（不是 VANGUARD）、特种是 `SPECIAL`（不是 SPECIALIST）。写错会被拒绝；若写成通用名而被接受，该干员的职业加成就全部失效 |
| `subProfessionId` | ⬜ | 决定职业特性行为，例如 `fastshot`（速射手）`fortress`（要塞）`bard`（吟游者）。留空则按 `position` 取通用行为 |
| `position` | ✅ | `MELEE` 或 `RANGED` |
| `traitDesc` | ⬜ | 特性文字（**只影响分类推导**：含「法术伤害」会被判为法术伤害） |
| `assetsSpine` | ⬜ | 复用一个**已有**干员的 Spine id。仓库不含素材，所以这是让新干员有立绘的唯一方式；留空则用替代外观 |
| `stats.normal` / `stats.golden` | ✅ | 就是**普通 / 精锐两套数值**。`maxHp` `atk` `def` `res` `cost` `blockCnt` `bat` 必填；`aspd` `respawnTime` `spRecovery` `moveSpeed` 可省（默认 100 / 70 / 1 / 1） |
| `skill` | ⬜ | 见下节。不需要技能就留空（`null`） |
| `talents` | ⬜ | `[{ name, desc, bb }]`，可空 |

### 不要自己写的字段（工具会推导，写了也会被覆盖）

`chessId` `baseId` `goldenId` `isGolden` `upgradeNum` `upgradeChessId` `price` `sellPrice` `rarity`
`dmgType` `attackKind` `projectile` `canHitFly` `rangeGrid`（除非你要覆盖）`immunities` `status` `visible`
`isHidden` `isDiy` `chessType` `tokens` `module` `assets.*`（除 `assetsSpine`）

---

## 二、技能：用黑板书（blackboard）描述，不需要写代码

`bb` 是**声明式**的。引擎里有一个**通用 kit**（`server/sim/content/generic.js`），它会读下面这些键并自动生成行为——
所以绝大多数技能**不需要任何 JavaScript**。

### 允许的键（除此之外的键不会报错，但也不会有任何效果）

`k`、`attack@k`、`skill@k` 三种写法**一般**都接受：`attack@` 表示「命中时」，不带前缀表示「技能期间 / 技能开始时」。
**但有三个例外**（generic.js 只按一种写法读它们，写错不会报错、只会静默失效，校验会给出 `BB_SPELLING` 警告）：

| 键 | 只能写成 |
|---|---|
| `range_radius`（溅射半径） | **`attack@range_radius`** |
| `duration`（持续时间） | **`duration`**（不带前缀） |
| `aoe_cd`（反伤冷却） | **`aoe_cd`**（不带前缀） |

| 键 | 含义 |
|---|---|
| `atk` | 攻击力 +X%（`0.6` = +60%） |
| `def` | 防御力 +X% |
| `max_hp` | 生命上限 +X%（>5 视为固定值，如 `+5000` 写 `5000`） |
| `attack_speed` | 攻击速度 +X（固定值） |
| `base_attack_time` | 攻击间隔变化（`-0.3` = 缩短 30%） |
| `magic_resistance` | 法抗（`-0.2` 为比例，正数小数） |
| `damage_scale` | 造成伤害 ×X |
| `block_cnt` | 阻挡数 +X |
| `taunt_level` | 仇恨值 +X |
| `damage_resistance` | 受到伤害降低 X（按 `1−v`） |
| `hp_recovery_per_sec` / `hp_recovery_per_sec_by_max_hp_ratio` | 每秒回血（固定 / 按生命上限比例） |
| `sp_recovery_per_sec` | 每秒额外技力 |
| `magic_resist_penetrate_fixed` / `def_penetrate_fixed` | 无视法抗 / 防御（固定值） |
| `ability_range_forward_extend` | 攻击距离 +N 格 |
| `max_target` | 目标数 |
| `atk_scale` / `heal_scale` | 本次伤害 / 治疗倍率（`1.6` = 160%） |
| `times` | 攻击次数 |
| `range_radius`（**只能写 `attack@range_radius`**） | 溅射半径（格） |
| `trigger_time` / `ammo` / `cnt` | 弹药数（`durationType: "AMMO"` 时**必须有其中之一**） |
| `duration`（**不带前缀**） | 持续时间（秒） |
| `stun` `cold` `sleep` `fear` `sluggish` `root` `unmovable` | 施加状态，**值就是持续秒数**（没有 `_duration` 这种键） |
| `ep_damage_ratio` | 附带元素损伤（配合技能文字里的「凋亡 / 灼燃 / 神经损伤」） |
| `shield_max_hp_ratio` / `hp_ratio` / `shield_max_duration` | 屏障 / 自身生命代价 / 屏障时长 |
| `force` | 推开 / 拉拽力度（按官方力度−重量规则） |
| `aoe_cd`（**不带前缀**） | 反伤等效果的冷却 |
| `prob` | 触发概率（`0.3`） |

### 技能元数据

| 字段 | 取值 |
|---|---|
| `skillType` | `MANUAL`（手动）`AUTO`（自动）`PASSIVE`（被动） |
| `durationType` | `NONE` 或 `AMMO` |
| `spType` | `INCREASE_WITH_TIME` `INCREASE_WHEN_ATTACK` `INCREASE_WHEN_TAKEN_DAMAGE` `ON_DEPLOY` |
| `spCost` / `initSp` | 技力消耗 / 初始技力（`initSp > spCost` 会被警告） |
| `duration` | 秒；`0` 立即，`-1` 无限 / 弹药型 |
| `maxChargeTime` | 可充能次数 |
| `rangeGrid` | 技能范围（`[[dRow,dCol],…]`，朝向右）；不写则用干员自身范围 |
| `triggerRule` | 自动释放规则，通常不用写（默认 `DEFAULT`；重装用 `TAKE_DAMAGE`，有独立技能范围用 `SKILL_RANGE`） |

> ⚠️ `MANUAL` + `spCost: 0` 会让技能无限连发，校验器会警告。

---

## 三、自查闭环（务必执行）

```powershell
# 1. 生成记录（自动补齐机械字段，并打印推导结果）
node tools/workshop-scaffold.mjs spec.json --pack my-pack

# 2. 三层校验：格式 → 记录语义 → 真实引擎
node tools/workshop-validate.mjs my-pack

# 3. 只看机器可读结果（便于程序/AI 循环处理）
node tools/workshop-validate.mjs my-pack --json
```

校验器返回的每条问题都带 `field` / `code` / `message` / `hint`，按提示改即可。常见 code：

| code | 含义 | 怎么改 |
|---|---|---|
| `BB_UNKNOWN_KEY` | 黑板书里用了通用 kit 不认的键 → **该效果不会发生** | 换成上面表格里的键；确实需要它 → 写一个行为层脚本（见下） |
| `AMMO_NO_COUNT` | 弹药型却没写弹药数 | 加 `trigger_time` / `ammo` / `cnt` |
| `MANUAL_NO_COST` | 手动技能 `spCost: 0` → 无限连发 | 给一个正数 `spCost` |
| `OFFICIAL_ID_COLLISION` | id 与官方数据撞车 | 换 id；**确实要覆盖**官方干员 → 在 `pack.json` 的 `overrides` 写 `"chess:<id>"` |
| `NOT_SHOP_ELIGIBLE` | 进不了商店池 | `visible: true`、`isHidden/isDiy: false`、`tier` 为整数 |
| `PARTNER_MISSING` | 普通/精锐互指的对象不存在 | 两个状态一起生成（scaffold 会自动成对） |
| `SIM_NO_DEF` / `SIM_THREW` | 引擎无法构建该单位 | 通常是数值或范围缺失 |

`0 error(s)` 即 **`VALID: the engine accepts this content.`**

---

## 四、什么时候需要写行为层脚本

通用 kit 覆盖的是「**加数值、加状态、加倍率、加弹药、加屏障、加位移、加元素损伤**」这一类。
下面这些**声明式表达不了**，需要 `kits/<chessId>.js`（接入 `battle.on(...)` 钩子总线）：

- 召唤物 / 切换形态 / 傀儡替身
- 特殊索敌（只打某种单位、按生命百分比选目标、锁定后追击）
- 链式跳跃、弹射、回环飞镖等多段判定
- 与队友/盟约层数联动的复杂条件
- 施法期间的特殊位移或强制位移组合

> 行为层是下一步的实现内容（见 [docs/WORKSHOP.md](../WORKSHOP.md) 的「当前状态」）。
> **在此之前**：只用上面表格里的键，就能做出大量可用的助战干员——这是「一劳永逸」的部分。

---

## 五、授权

仓库与官方整合包**不含任何游戏素材**。`assetsSpine` 只是**引用**已有干员的美术 id。
如需自带素材，请自行确认授权，并在 `pack.json` 的 `license` 字段声明。
