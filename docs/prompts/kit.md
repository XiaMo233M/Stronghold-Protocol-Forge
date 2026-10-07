# 行为层 kit 生成 · 模板 Prompt

把这份文档全文作为 prompt，连同**干员的技能文字描述**（与它的黑板书 `bb`）一起交给任意 AI（或人），
它就能产出一个本仓库能直接加载、且**在真实战斗里跑得起来**的行为层脚本（`kits/<chessId>.js`）。

配套工具（生成后必须跑一遍）：

```powershell
node tools/workshop-validate.mjs <包目录> --json    # 会真的 import 你的文件并做静态检查
npm run editor                                      # 图形化等价物：编辑器 /kit.html 页
```

> 为什么只有这一种内容需要写代码：干员的数值、技能、模组、盟约、地图、出怪、装备都是**数据**，工具能推导、
> 校验器能重算。行为层不是数据 —— 它是「这个干员的技能在战斗里到底干什么」。所以它没有推导产物，
> `kits/<chessId>.js` 本身就是游戏加载的东西（不进 `pack.json` 的 `content`）。
>
> 深度参考（本文只写「怎么写对」，不重复引擎细节）：
> `docs/SIM.md` §5 钩子总线、§6 引擎助手、§7.2 kits、§7.3 SkillSpec schema、§7.5 官方实例、§10 测试内容；
> 真实代码范本：`server/sim/content/kits/tier1.js` … `tier6.js`（官方 200 多个 kit）。

---

## 一、你要产出的东西

一个 JS 文件：`<包目录>/kits/<chessId>.js`。其中 `<chessId>` **必须是本包自己的干员 id**
（例如 `chess_ws_tide_hunter_a`）；要替换**官方**干员的行为，得先在 `pack.json` 的 `overrides` 里写 `"chess:<那个 id>"`，
否则加载器直接跳过这个文件（`KIT_NO_TARGET`）。

```js
export default function kit(bb, chess, def) {
  return { skill: {…}, talents: [ … ], install(battle, unit) { … } };
}
```

| 参数 | 是什么 |
|---|---|
| `bb` | **当前选中技能**的黑板（`chess.skill.bb`）—— 技能升级档与模组都算进去了 |
| `chess` | 普通记录对象（`def.raw`）：`skills[]`、`talents[]`、`trait`、`modules[]`、`stats` … |
| `def` | 归一化后的 unit def（`def.baseId` / `def.id` 用来认出「我是谁」） |

**返回的 Kit 形状**（`server/sim/content/index.js` 的 `selectSkillSpec`）：

| 字段 | 什么时候用 |
|---|---|
| `skill` | 技能 spec。**只有选中的技能是记录里那个默认技能时才会用它**（多技能干员要写 `skills`） |
| `skills` | `{ [skillId]: SkillSpec }`：按**选中的技能 id** 分发。多技能干员用这个 |
| `talents` | `[{ install(battle, unit) }]`：天赋，**任何情况都会被装上**（这是行为层最主要的位置） |
| `trait` | 特性层（结构与 talents 相同），用于「与天赋分开记」的常驻效果 |
| `install(battle, unit)` | 兜底：上面都不合适时自己装钩子 |

> ⚠️ **返回了 kit 就必须自己给出 `skill`**。缺省技能**不会**回退到通用 kit —— 不是「少个技能」，
> 而是这个干员在战场上永远不放技能，而且没有任何报错。

### SkillSpec 速查（完整表见 `docs/SIM.md` §7.3）

```js
skill: {
  kind: 'ammo',                      // duration | ammo | instant | charges | passive | toggle | heal | lock | def
  ammo: Math.max(1, Math.floor(Number(bb.trigger_time) || 8)),   // ammo 型的弹药数
  duration: 10,                      // duration 型的秒数
  mods: { atkPct: 0.6, aspd: 20 },   // 技能期间给自身的加成（键表见 SIM.md §3）
  attack: { atkScale: 1.6, hits: 2, splashRadius: 1, dmgType: 'arts' },
  targeting: { maxTargets: 3, rangeGrid: [[0,0],[0,1]], priority: 'FLY' },
  onStart({ battle, unit, skill }) { },
  onEnd({ battle, unit, skill }) { },      // 仍带着技能加成时调用（清理放在这里）
  onHit({ battle, unit, skill, target, dealt }) { },
  onAttack({ battle, unit, skill, target }) { },   // 可以把 ctx.noAmmo = true：这次攻击不消耗弹药
}
```

**`kind` 的语义**：`duration` 持续 N 秒；`ammo` 打出 N 次攻击后结束（可选 `duration` 上限）；
`instant` 一次性（`onStart` + 可选「下一次攻击覆盖」）；`charges` 同 instant 但可充能；
`passive` 部署后常驻、不吃技力；`toggle` 开启后持续到死亡。

---

## 二、四条硬规则（每一条**都会静默失败**，所以校验器逐条检查）

| 规则 | 违反的后果 | 校验器 |
|---|---|---|
| **默认导出 kit 函数** | 加载器读 `mod.default`，没有就整份文件被跳过 | `NO_DEFAULT_EXPORT`（错误） |
| **必须自包含，不能 `import` / `require`** | 同一份文件服务端按真实路径加载、浏览器按 URL 加载 —— 任何相对路径不可能同时对 | `KIT_IMPORT`（错误） |
| **必须确定性、与环境无关** | 它在玩家浏览器里跑，服务端会用同一份文件**复算**这一局来验算；`Math.random()` / `Date.now()` 会让两边结果不同，玩家的成绩被拒，理由看起来和「你用了随机数」毫无关系 | `KIT_NONDETERMINISTIC`（警告） |
| **钩子名必须是引擎真的会 emit 的名字** | `battle.on('beforeAttck', …)` 注册得很干净、**永远不会触发**，没有任何地方会报告 | `HOOK_UNKNOWN_EVENT`（警告，并给「你是想写 … 吗」的建议） |

被禁的全局量（`shared/kitAuthoring.js` 的 `KIT_FORBIDDEN_GLOBALS`）：`Math.random` `Date.now` `performance.now`
`new Date` `fetch` `XMLHttpRequest` `WebSocket` `document` `window` `localStorage` `setTimeout` `setInterval`。
随机数用 **`battle.rng()`**，时间用**战斗自己的时钟**（`battle.after(秒, fn)` / `battle.every(秒, fn)`）。

---

## 三、钩子词表（`battle.on(名字, fn, { owner, priority })`）

`ctx` 是引擎 emit 时给你的对象；标「可改」的字段改了会影响结算。

| 事件 | `ctx` | 什么时候触发 / 能干什么 |
|---|---|---|
| `battleStart` | `{}` | 战斗开始（初始部署完成）。装常驻效果、开局召唤 |
| `battleEnd` | `{ result }` | 战斗结束。收尾统计 |
| `tick` | `{ dt }` | 每个逻辑帧（`dt` 固定 `1/30` 秒）。别做重活、别每帧分配大对象 |
| `deploy` | `{ unit, initial, move? }` | 有单位进入战场（`initial: true` 是开局就在场的）。给「部署时」的效果 |
| `enemySpawn` | `{ enemy }` | 敌人进场（比 `deploy` 更具体，只给敌人） |
| `beforeAttack` | `{ attacker, target, isSkill, … }` | **攻击发起前**，可取消/改写 |
| `attack` | `{ attacker, targets, isSkill }` | 一次攻击打向这些目标（命中之前） |
| `hit` | `{ source, target, dmg, credit }`（`dmg` 可改） | **伤害结算前**：改 `dmg.atkScale` / `dmg.cancel` / `dmg.element` 就在这里 |
| `damaged` | `{ source, target, amount, type, dmg, credit }` | 目标**真的掉了血之后**（附伤、反伤、回技力都用它） |
| `fatal` | `{ unit, source, credit, dmg, amount, prevented }`（可改 `prevented`） | 致命一击即将生效：`ctx.prevented = true` 就是「不死」 |
| `dodge` | `{ source, target, dmg }` | 一次攻击被闪避 |
| `kill` | `{ killer, victim }` | 击杀（`killer` 可能是 token） |
| `death` | `{ unit, reason, killer }` | 任何单位死亡（含友军） |
| `heal` | `{ source, target, amount, opts }`（`amount` 可改） | 治疗结算前 |
| `blocked` | `{ blocker, enemy }` | 阻挡成立 |
| `enemyLeak` | `{ enemy }` | 敌人走进保护点（漏怪） |
| `lpLoss` | `{ amount, reason, source }` | 掉生命点 |
| `skillStart` / `skillEnd` | `{ unit, skill, reason }` | 技能起止。`skillStart` 里加的 buff，`skillEnd` 里要自己清 |
| `spGain` | `{ unit, amount, reason, skill }`（`amount` 可改） | 获得技力前（`amount = 0` 就是「这口不给」） |
| `ammoUsed` | `{ unit, left, skill }` | 消耗一发弹药 |
| `beforeStatus` | `{ source, target, status, duration, value, cancel }`（**均可改**） | 状态即将附上：`cancel = true` 免疫它，改 `duration` / `value` 就是强化或削弱 |
| `statusApplied` | `{ source, target, status, duration, value, entered }` | 状态附上之后（`entered` = 目标原本没有这个状态） |
| `elementHit` | `{ source, target, dmg }` | 元素损伤命中（爆条之前） |
| `elementBurst` | `{ source, target, element }` | 元素爆发（爆条） |
| `layerGain` | `{ playerId, bondId, n, reason, source, tile }`（可改 `n`） | 盟约层数即将增加。改 `n` 就是加/减层 |
| `merchantPay` | `{ unit, cost, cancel }` | 行商付钱（可取消） |
| `summonKill` | `{ token, owner, victim }` | **召唤物**击杀（给召唤流干员用） |
| `dollSwap` / `dollSwitch` | `{ unit, form }` / `{ unit, reason, done }` | 傀儡替身切换 |
| `enemyAttackStart` | `{ enemy, target }` | 敌人攻击动作**起手**（伤害帧之前）：这时晕眩/冻结/浮空能打断这一下 |
| `hpDamage` | `{ unit, amount, source }` | 按**最大生命值比例**结算的掉血（与 `damaged` 的固定值分开） |
| `bardRegen` | `{ unit, amount }` | 吟游者一类的**生命回复**（不算治疗，禁疗也照样生效） |
| `palsyTrigger` | `{ unit, source }` | 麻痹累积到阈值触发的那一下 |
| `boomerangCaught` | `{ unit, weapon }` | 回环射手的回旋镖被接住（回环流干员用） |
| `nearl2:knockdown` | `{ unit }` | 官方内容自定义的**命名空间**事件：只要同一份文件里 `battle.emit` 了它，就可以 `on` |

约定：**`{ owner: unit }` 一定要写** —— 单位退场/死亡时引擎会 `offOwner(unit)` 摘掉它的钩子；不写就是永久钩子
（一场战斗里重复部署会越挂越多）。`priority` 越大越先跑（默认 0，引擎内部捕获用 -1000）。

---

## 四、`battle` 与 `unit` 上你真正会用到的接口

```js
// 时钟与随机（唯一合法的随机源）
battle.rng()                          // 0..1 的确定性随机
battle.after(seconds, fn, { owner })  // 一次性
battle.every(seconds, fn, { owner, immediate })   // 周期

// buff / 状态
battle.addBuff(unit, { key, duration = Infinity, refresh: 'replace'|'extend'|'stack'|'independent'|'keep',
                       stacks, maxStacks, mods, flags, persist, visible, onTick, onExpire, tags })
battle.removeBuff(unit, key)          // unit.findBuff(key) 取实例（.stacks / .timeLeft）
battle.applyStatus(target, 'stun', { duration, source })          // 目录状态（stun/freeze/cold/sleep/slow/…）
battle.applyStrongest(target, key, { duration, value, mods })     // 「同名取最高」的非目录效果

// 伤害与治疗
battle.dealDamage(source, target, { atkScale, dmgType, tags })    // 通常用不到：优先改 ctx.dmg
battle.heal(source, target, amount)
battle.enemiesInKeys(keys, unit, { canHitFly })                   // 取范围内的敌人
battle.alliesFor(unit) / battle.alliesInGrid(unit, grid)          // 友军（会跳过 孤立 单位）

// unit 上常用的
unit.tileR / unit.tileC / unit.dir / unit.alive / unit.deployed / unit.hp / unit.s.maxHp
unit.rangeKeys / unit.findBuff(key) / unit.profile
```

完整列表：`docs/SIM.md` §5–§7。**不要**碰 `unit.base.massLevel` 这类存档字段（用 `mods.massFlat`），
也不要自己写 `setTimeout`（用 `battle.after`）。

---

## 五、一个完整的例子（这份例子在 `test/kitPrompt.test.js` 里被真的跑过一遍）

场景：技能是**弹药型**（打完 8 发或技能结束），天赋「涨潮」在技能期间每次击杀叠一层攻击力，技能结束清空。

```js
// kits/chess_ws_tide_hunter_a.js —— 潮汐猎手
// 四条硬规则都在这里体现：默认导出、零 import、只用 battle 的时钟、钩子名取自词表。
export default function kit(bb, chess, def) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    // 有 kit 就必须自己给出 skill
    skill: {
      kind: 'ammo',
      ammo: Math.max(1, Math.floor(num(bb.trigger_time, 8))),
      mods: { atkPct: num(bb.atk, 0.6) },
      attack: { atkScale: num(bb.atk_scale, 1.6) },
      // 技能结束时清掉天赋叠的层（onEnd 仍带着技能加成，清理放这里）
      onEnd({ battle, unit }) { battle.removeBuff(unit, 'kit:tide'); },
    },
    talents: [{
      name: '涨潮',
      description: '技能期间每次击杀攻击力 +8%（最多 5 层），技能结束后清空',
      install(battle, unit) {
        battle.on('skillStart', ({ unit: u }) => {
          if (u !== unit) return;
          battle.addBuff(unit, {
            key: 'kit:tide', duration: Infinity, refresh: 'stack', stacks: 1, maxStacks: 5,
            mods: { atkPct: 0.08 }, visible: true, tags: ['talent'],
          });
        }, { owner: unit });
        battle.on('kill', ({ killer }) => {
          if (killer !== unit) return;
          const buff = unit.findBuff('kit:tide');
          if (!buff || buff.stacks >= 5) return;
          battle.addBuff(unit, {
            key: 'kit:tide', duration: Infinity, refresh: 'stack', stacks: 1, maxStacks: 5,
            mods: { atkPct: 0.08 }, visible: true, tags: ['talent'],
          });
        }, { owner: unit });
      },
    }],
  };
}
```

用法与自查：

```powershell
# 1) 放进包里（文件名必须等于干员 id）
#    <workshop>/my-pack/kits/chess_ws_tide_hunter_a.js
# 2) 真的 import 一遍 + 静态检查（钩子名、三条硬规则、有没有对应干员）
node tools/workshop-validate.mjs my-pack --json
# 3) 编辑器 /kit.html 看实时静态检查；4) 试玩里实战验证
```

---

## 六、常见坑（按「踩了会怎样」排序）

| 坑 | 后果 | 正确写法 |
|---|---|---|
| `battle.on` 少写 `{ owner: unit }` | 单位死亡后钩子还在，反复部署越挂越多、效果翻倍 | 每个 `on` 都带 `owner` |
| 在 `tick` 里做重活 | 一局 30 fps × 4 名玩家，卡的是主机 | 用 `battle.every(0.5, …)` |
| 用 `battle.addBuff` 叠层却不写 `refresh: 'stack'` | 默认是 `replace`，层数永远 1 | `refresh: 'stack'` + `stacks` + `maxStacks` |
| 自己维护一个模块级变量记状态 | 同一份文件在服务端与浏览器各加载一次，**两边的模块变量不是一份** | 状态挂在 `battle` / `unit` / buff 上 |
| 「同名效果取最高」的效果直接用 `addBuff` | 两个同源效果会乘起来 | `battle.applyStrongest(target, key, …)` |
| 想给「下一次攻击」加成，却改在 `hit` 里 | 这次就已经算完了 | `kind: 'instant'` + `onAttack` / `attack` 字段 |
| 技能结束忘了清理 buff | 效果永久留在场上 | 在 `onEnd` / `skillEnd` 里 `removeBuff` |
| `Math.random()` | 服务端复算结果不同 → 玩家成绩被拒 | `battle.rng()` |

---

## 七、授权

行为层会在**玩家浏览器里执行**。仓库与官方整合包**不含任何工坊内容**：包由玩家主动安装并知情，
所以工坊包与整合包**分渠道分发**（`docs/WORKSHOP.md` §4）。署名由编辑器保存时自动写进文件头注释。
