# 加个干员

- **你要做的事**：加一名游戏里原本没有的新干员，能在商店里刷到、能上阵。
- **需要什么**：一个能玩的整合包；一张纸写下她的名字、职业、两套数值、技能文字。不用写代码。
- **花多久**：第一次留 40 分钟（想清楚数值最花时间）。

> 第一次做包的话，先看 [`START-HERE.md`](START-HERE.md)。这篇只讲「加干员」本身。

---

## 一、别手写棋盘数据

一名干员的完整记录有 **479 行、30 多个字段**，手写会静默写错（不报错，但游戏里没效果）。

**正确做法**：你只写一张 **38 行的「设定表」**，让工具把剩下的 479 行推出来。

做完长这样：

```
my-op/
├── pack.json         ← 工具生成，你只需要补 3 行
└── chess.json        ← 工具生成，479 行，不要手改
```

> `chess.json` 里是**两条**记录：普通（`_a`）和精锐（`_b`）。它们成对生成、成对删除，**两条都要留着**。

---

## 二、写设定表

1. 在整合包根目录新建一个文件，名字用英文，例如 `my-op-spec.json`。
2. 从整合包里引擎自带的示例 `Stronghold-Protocol\docs\examples\operator-spec.json` **整份复制过来**，再照下面改。别从零敲。
3. 内容照这个填：

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
    "normal": { "maxHp": 1500, "atk": 480, "def": 140, "res": 0, "cost": 18, "blockCnt": 1, "bat": 1.0, "respawnTime": 70 },
    "golden": { "maxHp": 1900, "atk": 620, "def": 180, "res": 0, "cost": 18, "blockCnt": 1, "bat": 1.0, "respawnTime": 70 }
  },
  "skill": {
    "name": "贯穿射击",
    "desc": "攻击力+60%，攻击速度+40，攻击装有8发弹药，打完后技能结束（可充能1次）",
    "skillType": "MANUAL",
    "durationType": "AMMO",
    "spType": "INCREASE_WITH_TIME",
    "spCost": 30,
    "initSp": 10,
    "maxChargeTime": 1,
    "bb": { "atk": 0.6, "attack_speed": 40, "atk_scale": 1.6, "trigger_time": 8 }
  },
  "talents": [
    { "name": "猎手嗅觉", "desc": "攻击空中单位时攻击力提升至115%", "bb": { "atk_scale": 1.15 } }
  ]
}
```

4. 三个字段**只能照官方的写法填**，填错要么被拒、要么静默失效：

- `profession` 只能填 `WARRIOR` `SNIPER` `CASTER` `MEDIC` `SUPPORT` `TANK` `SPECIAL` `PIONEER`。
  **不要**写 `DEFENDER` / `VANGUARD` / `SPECIALIST` —— 那是通用叫法，本项目不用，填错的后果是**这个干员的职业加成全部失效，而且不报错**。
- `position` 只能填 `MELEE` 或 `RANGED`。
- `assetsSpine` 要填一个**官方已经有**的模型 id，借她的模型来用。查法跟查干员 id 一样：

```
node -e "const a=require('./data/assets.json');for(const k of Object.keys(a.chars))console.log(k)"
```

  填错了**不报错**，游戏里这个干员会画成一张菱形贴纸。

> 复用官方模型是合法的，模型仍然归鹰角网络所有。

---

## 三、跑一条命令，包就出来了

1. 在整合包根目录（有 `tools\` 的那一层）打开命令提示符。
2. 粘贴（把文件名和包 id 换成你自己的）：

```
node tools/workshop-scaffold.mjs my-op-spec.json --pack my-op
```

3. 成功时你会看到：

```
wrote E:\…\app\workshop\my-op\chess.json
  normal chess_ws_abyss_hunter_a  深渊猎手  tier 5  SNIPER/fastshot  phys/ranged  hp 1500 atk 480
  elite  chess_ws_abyss_hunter_b  深渊猎手  tier 5  SNIPER/fastshot  phys/ranged  hp 1900 atk 620
```

卡住的话：

- `--pack must be a slug` —— 包 id 用了中文，或者超过 32 个字符。换成英文。
- `the spec is invalid` —— 设定表里有个字段填了上面那张清单以外的值。
- 只有 warning 没有 error —— 不挡你，但去看一眼。多半是技能里用了引擎不认的键，**那说明这个技能不会有任何效果**。

---

## 四、补上 `pack.json` 的三行

工具生成的 `pack.json` 里 `author` / `license` / `description` 是空的。**上传前必须补**：

```json
{
  "id": "my-op",
  "name": "深渊猎手",
  "version": "0.1.0",
  "author": "你的名字",
  "license": "CC-BY-4.0",
  "description": "新增一名 5★ 狙击干员「深渊猎手」，复用官方角色模型。",
  "gameVersion": "0.2.2",
  "content": ["chess"],
  "overrides": []
}
```

> `"content": ["chess"]` 是工具写好的，**不要删**。
> 删了的话 `chess.json` 还在磁盘上，但引擎**一个字节都不会读它** —— 商店摇不到她、试玩里没有她、日志里也没有任何错误。
> 这是这个格式里最阴的一个坑。

---

## 五、验一遍

1. 粘贴：

```
node tools/workshop-validate.mjs app/workshop
```

2. 看到这两行就是通过（退出码 `0`）：

```
0 error(s), 0 warning(s)
VALID: the engine accepts this content.
```

3. 重启游戏，去商店里找她。

> 引擎**没有热重载**，不重启看不到。

---

## 六、卡住了看这里

- 包装上了但商店里摇不到她 —— `content` 里没写 `chess`。
- 技能写了但游戏里没效果 —— 技能里用了引擎不认的键。校验器会给一条警告。
- 画成一张菱形贴纸 —— `assetsSpine` 填了一个不存在的 id，回第二步重挑一个。
- 干员的职业加成失效 —— `profession` 写成了通用职业名。

---

## 七、下一步

- **给她配专属立绘 / 头像**：见 [`task-01-换个立绘.md`](task-01-换个立绘.md)，`art.chars` 的 key 写你这个新干员的 id。
- **打包和上传**：见 [`START-HERE.md`](START-HERE.md) 第 3、4 步。
- **想让技能做出「填表表达不了」的效果**（改伤害类型、加新机制）：那要写代码，见源码仓库的 `SKILL.md`。
- **让她的特质授予盟约**：一条记录里写 `trait.grantsBonds`，一格数据、不用写代码。
