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
> 真实代码范本：`server/sim/content/kits/shared/tier1.js` … `tier6.js`（官方 200 多个 kit 共用的辅助函数，
> 单个干员的 kit 在同级的 `ops/` 下）。
>
> **本版基线**：本仓库 **0.8.2** / 上游游戏本体 **0.2.1**。上游这一版**没有增删任何钩子**，本文的词表就是引擎现在
> emit 的全部事件；但它把官方干员的数值改成了**满潜能（潜能 6）**口径 —— 你读到的 `unit.s.atk` 之类的数已经是满潜能那套，
> 所以数值**永远从 `bb` 读**这条硬规矩比以前更要紧。

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

---

## 八、常见效果怎么做（配方手册）

§一–§七 回答「怎么写对」，这一节回答「想要的效果具体怎么写」。每条配方都对着真实引擎 API，并给出仓库里那条实现的
位置（`文件:行号`）—— 那些位置就是这条配方的证据，API 改名时它们会先变。§8.12 汇总了**引擎确实不提供**的东西。

### 8.1 先读这条：工坊 kit 不能 `import`，官方辅助函数要自己内联

官方 kit 站在 `server/sim/` 里面，可以 `import` 引擎与辅助模块；工坊 kit 不行（§二 第二条硬规则，校验器报
`KIT_IMPORT`：`shared/kitAuthoring.js:195`）。所以官方 kit 里那些一眼就用的辅助，在这里都得内联一份：

| 官方辅助（位置） | 工坊 kit 里的等价写法 |
|---|---|
| `num(v, d)` 读黑板数字（`server/sim/content/kits/shared/tier1.js:40`） | 原样抄一份：`const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d));` |
| `talentBb(chess, i)` / `traitBb(chess)` / `moduleBb(chess)`（`…/shared/tier1.js:48`、`:58`、`:52`） | `(chess.talents ?? []).filter((t) => t && t.index !== -1)[i]?.bb ?? {}`；`chess?.trait?.bb ?? {}`；把 `index === -1` 的隐藏天赋 `bb` 合并起来 |
| `byEnemyAttack(ctx)` 官方「受到攻击时」口径（`…/shared/tier1.js:80`） | 见 §8.4 的内联版（它依赖的 `isHpLoss` 在 `server/sim/damage.js:121`，同样不能 import） |
| `statBuff` / `toggleBuff` / `installAura`（`…/shared/tier1.js:155`、`:162`、`:178`） | 都是 `battle.addBuff` / `battle.every` 的 3–8 行封装，见 §8.2 |
| `enemiesInGrid` / `alliesInGridOf`（`…/shared/tier1.js:127`、`:137`） | 自己按 `unit.dir` 旋转范围格、拼绝对 tile key，再调 `battle.enemiesInKeys`（见 §8.9） |
| `makeZone(...)`（`…/shared/tier1.js:214`） | `battle.fx('zone', …)` + `battle.every(interval, fn, { immediate: true })` |
| `summonTileFree` / `freeTileAround`（`…/shared/tier1.js:229`、`:234`） | `battle.grid.inRect(r, c) && !battle.isReservedTile(r, c)`（`server/sim/battle/tiles.js:66`）+ 自己旋转 |
| `releaseSkillSummon(...)`（`server/sim/content/tokens.js:381`） | **引擎不提供给工坊**：用 `battle.spawnToken` 自己放（§8.6） |
| `summonDeck(...)` 召唤师牌堆（`server/sim/content/kits/shared/summoner.js:99`） | **引擎不提供给工坊**：`unit.mem` 记持有数 + `battle.every` + `battle.redeploy` 自己复刻（§8.6） |

`unit.mem` 是引擎给内容的**每单位草稿本**（`server/sim/units.js:83`）——工坊 kit 记状态就记在这里，别用模块变量。

### 8.2 常驻 / 一次性数值修改

**常驻** = 一条永不过期的 buff（`battle.addBuff`，`server/sim/battle/status.js:13`）。要它在退场、被击倒、再部署之后
仍然在，就写 `persist: true` 与 `allowDead: true`（`server/sim/buffs.js:173`、`server/sim/battle/status.js:14`）：

```js
export default function kit(bb, chess, def) {
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d));
  const t0 = (chess.talents ?? []).filter((t) => t && t.index !== -1)[0]?.bb ?? {};
  return {
    // 一次性 / 只在技能期间生效的数值：写进 SkillSpec 的 mods（引擎按 skill 的持续时间挂上、结束摘掉）
    skill: { kind: 'duration', mods: { atkPct: num(bb.atk), aspd: num(bb.attack_speed) } },
    talents: [{
      name: '常驻数值',
      install(battle, unit) {
        battle.addBuff(unit, {
          key: 'ws:resolve', duration: Infinity, persist: true, allowDead: true, visible: true, tags: ['talent'],
          mods: { atkPct: num(t0.atk), defFlat: num(t0.def), aspd: num(t0.attack_speed) },
        });
      },
    }],
  };
}
```

要点：

- **键名不能自己造**。加算键与乘算键是两张固定表：`server/sim/buffs.js:20`（`atkFlat` `atkPct` `atkFinal` `defFlat`
  `hpPct` `resFlat` `aspd` `batPct` `blockCnt` `rangeExtend` `defIgnorePct` `dodgePhys` `maxTargets` `taunt` `hpRegen`
  `massFlat` …）与 `:28`（`atkMul` `dmgDealtMul` `dmgTakenMul` `physTakenMul` `artsTakenMul` `healingTakenMul`
  `spRecoveryMul` `atkScaleMul` …）；开关类在 `:40`（`stun` `silence` `untargetable` `noHeal` `liftoff` `isolated` …）。
- **`atkPct` 是加算桶**，与技能、盟约的百分比相加，不是相乘（`server/sim/units.js:130` 的
  `(atk + atkFlat)·(1 + ΣatkPct) + atkFinal`）。想「翻倍」就写 `atkMul`。
- **「同名效果取最高」的家族用 `applyStrongest`**（`server/sim/battle/status.js:270`），不是 `addBuff` —— 两个来源用
  `addBuff` 会乘起来。官方用法（庇护）在 `server/sim/content/kits/shared/tier1.js:122`。
- **条件常驻**（「生命高于 50 % 时 +20 % 攻击」）不要每帧 `addBuff`：先 `findBuff` 比一下再改，或直接照抄
  `server/sim/content/kits/ops/chess_char_2_09-humus.js:24`（用 `buff.data.v` 记住当前档位）。
- **「生命回复速度」不是治疗**：它是一条 `hpRegen` / `hpRegenRatio` 的 buff（`server/sim/units.js:170`），禁疗与治疗
  加成都管不到它 —— 治疗加成那条路在 `server/sim/damage.js:544`（`opts.regen`）。口径见
  `server/sim/content/kits/README.md:330`。

### 8.3 攻击附带的额外效果（追加伤害 / 溅射 / 真伤 / 状态）

四个位置各管一件事，**改错位置就是「这次不算」或「算了两次」**：

| 想要的效果 | 写在哪 | 为什么 |
|---|---|---|
| 这次攻击的伤害倍率 / 多段 / 溅射 | SkillSpec 的 `attack`（`atkScale` `hits` `splashRadius` `splashScale` `dmgType`） | 引擎按它生成每次伤害实例（`server/sim/ai.js:296`），溅射在 `server/sim/ai.js:306` 用**中点判定**半径落 |
| 临时改这一刻的伤害（增伤 / 无视防御 / 取消） | `hit` 钩子改 `ctx.dmg` | `hit` 在减伤**之前**触发（`server/sim/damage.js:238`），可改的字段在 `server/sim/damage.js:69` |
| 命中之后的追加伤害 / 反伤 / 回技力 | `damaged` 钩子 + `battle.dealDamage` | `damaged` 在伤害**落地之后**触发（`server/sim/damage.js:332`） |
| 打中了就给状态 | SkillSpec 的 `attack.onHitStatus`，或 `onEachHit` 里 `battle.applyStatus` | 引擎在每次攻击的主目标后应用 `onHitStatus`（`server/sim/ai.js:301`）；`onEachHit` 每个受害者各一次（`server/sim/ai.js:279`） |

```js
skills: {
  ws_s1: {
    kind: 'instant',
    attack: {
      atkScale: num(bb.atk_scale, 1),        // 主目标倍率
      hits: 2,                               // 主目标两段（server/sim/ai.js:295）
      splashRadius: 1, splashScale: 0.5,     // 中点 1 格内溅射 50%（server/sim/ai.js:306）
      dmgType: 'arts',
      // 真伤：mitigate 完全不减（server/sim/damage.js:15）；改成 'true' 就是「真实伤害」
      onEachHit({ battle, unit, target, kind }) {
        if (kind !== 'main' || !target.alive) return;              // 溅射/连锁受害者也会走到这里
        battle.applyStatus(target, 'stun', { duration: num(bb.stun, 1), source: unit });
      },
    },
  },
},
```

```js
talents: [{
  install(battle, unit) {
    // ① 改「这一次」的伤害。守卫必须写：技能伤害、持续伤害、反伤、元素损伤都会走到 hit
    battle.on('hit', (ctx) => {
      if (ctx.source !== unit || !ctx.dmg.isAttack) return;        // 只认普攻（伤害实例的 isAttack：server/sim/ai.js:296）
      if (ctx.target.hpRatio > 0.5) return;
      ctx.dmg.mul *= 1.5;                                         // 在物理/法术减伤之后再乘（server/sim/damage.js:271、:274）
      ctx.dmg.defIgnorePct = Math.max(ctx.dmg.defIgnorePct, 0.4);
    }, { owner: unit });

    // ② 命中之后的追加真伤
    battle.on('damaged', (ctx) => {
      const d = ctx.dmg;
      if (ctx.source !== unit || !d || ctx.target.side !== 'enemy') return;
      if (ctx.type === 'element') return;                          // 元素损伤也走 damaged（server/sim/damage.js:415）
      if (d.tags.includes('hpLoss')) return;                       // 流失不是「造成伤害」（server/sim/damage.js:121）
      if (d.tags.includes('ws:followup')) return;                  // ★ 必须挡住自己刚造成的那一下，否则无限递归
      battle.dealDamage(unit, ctx.target, { amount: unit.s.atk * 0.3, type: 'true', canDodge: false, tags: ['ws:followup'] });
    }, { owner: unit });
  },
}],
```

- **追加伤害一定要打 tag 并跳过自己的 tag**：`damaged` 里再 `dealDamage` 会重新触发 `damaged`，两次这样的效果会
  乒乓到嵌套上限，而嵌套守卫一旦触发会**连 `kill` / `death` 一起跳过**（`docs/SIM.md:810`）。官方反伤就是这么写的：
  `server/sim/content/kits/ops/chess_char_1_06-vendla.js:57`（`tags: ['counter']` + `byEnemyAttack` 跳过
  `counter` / `reflect`）。
- **手写 AoE 用哪个查询**：`battle.foesInRadius(x, y, r, centre)` 是「一次范围效果**能选中**的敌人」（剔除不可选中与
  隐匿，`server/sim/battle/queries.js:175`），`battle.enemiesInRadius(...)` 是「位置在半径里」的（含不可选中，
  `server/sim/battle/queries.js:154`）。写伤害用前者，写光环 / 碰撞用后者。德克萨斯 S2 的两段伤害 + 眩晕在
  `server/sim/content/kits/ops/chess_char_1_08-texas.js:30`。
- **额外伤害要不要乘 `unit.s.atkScaleMul`**：它是「技能伤害倍率」桶（`server/sim/units.js:166`），官方 kit 的追加伤害
  会乘（`server/sim/content/kits/ops/op-judge.js:164`）。
- **状态词表**在 `server/sim/buffs.js:57`：`stun` `freeze` `cold` `sleep` `slow` `sluggish` `bind` `silence` `fear`
  `tremble` `disarm` `stealth` `camou` `reveal` `levitate` `groundbind` `palsy` `taunt` `weaken` `defDown` `resDown`
  `fragile` `artsFragile` `physFragile` `elemFragile` `resist` …。带 `value` 的语义写在同处注释里。
- **想免疫 / 改写一个状态就写 `beforeStatus`**（`server/sim/battle/status.js:173`）：`cancel = true` 免疫、改
  `duration` / `value` 是强化或削弱。

### 8.4 触发时机钩子：选对那一个

§三 是词表，这里只讲**同一个效果为什么必须挂在这个时机上**。注册 API 是
`battle.on(name, fn, { owner, priority, once })`（`server/sim/battle/hooks.js:17`）。

| 你要的效果 | 钩子 | 为什么不是别的 |
|---|---|---|
| 取消 / 改这一次攻击的目标 | `beforeAttack` `{ attacker, targets, isSkill, profile }` | 目标已选定、还没结算：清空 `ctx.targets` 就是取消（`server/sim/ai.js:187`） |
| 「每次攻击」计数 / 特效 | `attack` `{ attacker, targets, isSkill }` | 伤害已发出、溅射与连锁还没走完（`server/sim/ai.js:221`） |
| 改这一下伤害 | `hit` `{ source, target, dmg, credit }` | 在减伤之前，唯一能改 `dmg.mul` / `defIgnore*` / `cancel` 的位置（`server/sim/damage.js:238`） |
| 附伤 / 反伤 / 回技力 / 叠层 | `damaged` `{ source, target, amount, type, dmg, credit }` | 伤害真的落地之后（`server/sim/damage.js:332`）；`amount` 可能为 0（全被盾吃掉） |
| 元素损伤倍率 | `elementHit` `{ source, target, dmg }` | 只给元素损伤（`server/sim/damage.js:404`），改 `dmg.amount` / `dmg.mul` / `cancel` |
| 不死 / 保留 1 点血 | `fatal` `{ unit, source, credit, dmg, amount, prevented }` | `ctx.prevented = true` 就是不死（`server/sim/damage.js:314`） |
| 击杀叠层 | `kill` `{ killer, victim }` | `killer` 可能是召唤物或 `null`，要判 `killer === unit`（`server/sim/battle/deploy.js:77`）；召唤物击杀另有 `summonKill`（`server/sim/content/tokens.js:1713`） |
| 清自己的标记 / 召唤物随主人消失 | `death` `{ unit, reason, killer, dying }` | 任何单位死亡（含友军、撤退、漏怪；`server/sim/battle/deploy.js:149`） |
| 「受到攻击时」的反伤 | `damaged` + 自己判来源 | 官方口径是**任何敌方来源的伤害实例**（不是只有普攻），并且要跳过 `counter` / `reflect` / 流失 / 元素损伤 —— 内联版就是 `byEnemyAttack`： |
| 部署时给东西 | `deploy` `{ unit, initial, move? }` | `initial: true` 才是开局那一次；`move: true` 是【移动】再部署（`server/sim/battle/deploy.js:66`、`server/sim/battle/tiles.js:56`） |
| 技能起止 | `skillStart` / `skillEnd` `{ unit, skill, reason }` | `skillStart` 里挂的、`skillEnd` 里清；`onEnd` 跑的时候技能加成**还在**（`server/sim/skills.js:498`、`:556`） |
| 每帧 | `tick` `{ dt }` | 只用来做轻量的条件检查（`server/sim/battle/lifecycle.js:102`） |
| 定时 | `battle.after` / `battle.every` | 战斗自己的时钟（`server/sim/battle/hooks.js:112`、`:119`）；`setTimeout` 会被 `KIT_NONDETERMINISTIC` 抓 |

「受到攻击时」的内联口径（官方版：`server/sim/content/kits/shared/tier1.js:80`）：

```js
/** 一次「敌方来源的伤害实例」——它的普攻、技能、范围脉冲都算；流失、元素损伤、无来源、反伤不算。 */
const byEnemyAttack = (ctx) => {
  const s = ctx.source, d = ctx.dmg;
  if (!s || s.side !== 'enemy' || !d || d.sourceless || ctx.type === 'element') return false;
  if (d.tags.includes('hpLoss')) return false;                     // 流失：server/sim/damage.js:121
  return !(d.tags.includes('counter') || d.tags.includes('reflect'));
};
```

三个时机陷阱：

1. **`deploy` 每次（再）部署都会触发**，不是只有开局。要判 `ctx.initial`，或者拿 `unit.deploySeq` 作废旧的那次回调
   （每次部署 +1：`server/sim/battle/deploy.js:39`）。
2. **`battle.after` 的回调在单位死后仍会跑**（定时器在 step 开头统一执行）。回调里第一行就要自己判：
   `if (!unit.alive || !unit.deployed || unit.deploySeq !== seq) return;` —— 官方写法见
   `server/sim/content/kits/ops/chess_char_1_01-inside.js:36`。`unit.deployedAt`（`server/sim/battle/deploy.js:41`）用来
   算「部署后过了多少秒」。
3. **`skillStart` 早于 `deploy`**（`activateOnDeploy` 的技能：`docs/SIM.md:925`），所以「部署时」的逻辑不要假设技能还没开；
   反过来，在 `skillStart` 里读 `unit.deployedAt` 是安全的。

### 8.5 计数与层数（counter / stack）

**带层数的效果**：必须写 `refresh: 'stack'`（默认是 `replace`，层数永远 1）；加算键随层数线性放大、乘算键按层数取幂
（`server/sim/buffs.js:8`）。刷新规则与封顶逻辑在 `server/sim/battle/status.js:19` 起。

```js
const addRage = (battle, unit) => battle.addBuff(unit, {
  key: 'ws:rage', refresh: 'stack', stacks: 1, maxStacks: num(t0.max_stack_cnt, 5),
  duration: Infinity, mods: { atkPct: num(t0.atk) }, visible: true, tags: ['talent'],
});
const stacksOf = (unit) => unit.findBuff('ws:rage')?.stacks ?? 0;   // findBuff: server/sim/units.js:231

// 纯计数器：不给任何数值也行（只用来记住「发生了几次」）
battle.addBuff(unit, { key: 'ws:count', refresh: 'stack', maxStacks: 99, duration: Infinity });
```

- **封顶要自己判**。`maxStacks` 只管 buff 的层数，不管你的效果逻辑；超了要在加之前 `return`
  （官方例子：`server/sim/content/kits/ops/chess_char_3_04-swire2.js:243`）。
- **要不要跨部署保留**：写 `persist: true, allowDead: true` 就留着（`server/sim/buffs.js:173`）；不写就随单位退场消失。
  死亡时想清干净，在 `death` 里 `battle.removeBuff(unit, key)`（`server/sim/battle/deploy.js:149`）。
- **层数状态挂在 buff 上，不要自己数**：`unit.findBuff(key).stacks` 就是唯一真相；`duration: Infinity` + `refresh: 'stack'`
  的组合天然自带「累计、封顶、随 key 唯一」。
- **一场战斗级的计数**（「这场里第 3 次技能」）用 `unit.mem`（`server/sim/units.js:83`）或按 `battle` 作键的 `WeakMap`
  —— 官方辅助 `once(battle, key, fn)` 就是后者（`server/sim/content/kits/shared/tier1.js:146`）。**不要**用模块级普通变量：
  同一份文件在服务端和浏览器各加载一次，两边的模块变量不是一份（`server/sim/content/kits/README.md:84`）。
- **盟约层数**：`battle.addLayers(playerId, bondId, n, reason, { source })`（`server/sim/battle/economy.js:22`），
  上限是 `BOND_LAYER_CAP` 999（`shared/constants.js:133`，`layerGainRoom` 在 `:140` 算真正能加多少），
  `layerGain` 钩子里 `ctx.n` 可改（`server/sim/battle/economy.js:31`）。**它只在普通战场生效**：`flags.layerGainsEnabled`
  只有 `kind === 'normal'` 时为 `true`（`server/sim/Battle.js:113`），联防 / boss 战场里是 no-op。官方 kit 一处都没调用
  它 —— 加层属于盟约/数据层的活，kit 调用它是允许的，但先想清楚你写的是「内容」还是「规则」。

### 8.6 召唤物

唯一入口是 `battle.spawnToken(owner, tokenId, row, col, opts)`
（`server/sim/battle/summons.js:45`）—— 它是 `battle` 上的方法，所以工坊 kit 能直接用：

```js
// def 有两种来源：
//  ① 数据里的 tokens.json 记录（官方，或本包用 content: ["tokens"] 自带一份）
//  ② 内联：opts.def，字段与 tokens.json 同形（server/sim/simdata.js:304 归一化，stats 键名见 :147）
const spawnDrone = (battle, unit, r, c) => battle.spawnToken(unit, 'token_ws_my_drone', r, c, {
  duration: 10,                                            // 到期自动撤退（reason 'expired'）：server/sim/battle/summons.js:70
  untargetable: true,                                      // 敌人选不到它：server/sim/battle/summons.js:62
  stats: { maxHp: 1500, atk: 300 },                        // 覆盖面板（写的是 base）：server/sim/battle/summons.js:60
  dir: unit.dir,
  kit: { skill: null, trait: { noAttack: true } },          // 只做光环的召唤物：不攻击、不放技能
});

// 不知道 token id 存在时，先问引擎：不存在就返回 null 并记一条日志（server/sim/battle/summons.js:50）
const def = battle.tokenDef('token_ws_my_drone', unit);
```

要点与边界：

- **`spawnToken` 会拒绝的情况**：格子被活着的单位占着（`server/sim/battle/summons.js:57`）、token id 数据里没有（`:50`）、
  当前选中技能不产出它（`producesToken`：`:51` —— 只有数据里 `sources` 明确没有 `skill` / `talent` 时才拒，工坊新增的
  token 通常没有 variants，所以不会被拒）。返回 `null` 而不是抛错，**要判返回值**。
- **找格子**：`battle.grid.inRect(r, c)` + `!battle.isReservedTile(r, c)`（`server/sim/battle/tiles.js:66`，预留格 = 站着人、
  或某个还没部署 / 等再部署的干员的落点）+ `battle.grid.canStand(r, c, { ranged })`（`server/sim/grid.js:209`）。战场的
  固定点位用 `battle.findTacticalPoint(unit)`（`server/sim/battle/tiles.js:130`）。
- **本包自带 token 记录**：`tokens.json` 是允许工坊贡献的数据文件之一（`shared/workshop.js:29`，形状与 `data/tokens.json`
  同形，记录里的 `tokenId` 字段必须等于键：`shared/workshop.js:34`），放进 `pack.json.content` 里声明即可。
- **召回 / 让召唤物离场**：`battle.retreat(token, { reason: 'retreat' })`（`server/sim/battle/deploy.js:94`）；
  让它原地回来：`battle.redeploy(token, { free: false, tile: [r, c] })`（`server/sim/battle/deploy.js:187`）。
- **召唤物的击杀**：引擎发 `summonKill` `{ token, owner, victim }`（`server/sim/content/tokens.js:1713`），
  召唤流干员听这个。
- **引擎不提供（`import` 的那两个）**：
  - `releaseSkillSummon`（`server/sim/content/tokens.js:381`）—— 官方「技能召唤物做成一张手牌、开局免费部署一次、技能再
    把它放出来」那套在 content 模块里，工坊 kit 不能 import。**用 `battle.spawnToken` 自己放**；要做成手牌得在
    `tokens.json` 里写 `placeable`（那属于数据层）。
  - `summonDeck`（`server/sim/content/kits/shared/summoner.js:99`）—— 召唤师牌堆（持有数、回收、随主人消失、满足条件
    自动回到原格）。要复刻就用 `unit.mem` 记持有数 + `battle.every` 轮询 + `battle.redeploy`。
- **引擎不提供「凭空造一个任意单位」**：`spawnToken` 必须给 tokenId + def；`spawnDevice` 造的是**不可攻击**的装置
  （它的 profile 被钉成 `{ noAttack: true, maxTargets: 0 }`：`server/sim/battle/summons.js:97`）。要一个「能被自己人打」的
  单位，用 `battle.setAllyTarget(unit, true)` 把己方单位注册成可攻击目标（`server/sim/battle/queries.js:62`）。

### 8.7 范围改写（rangeGrid）

**技能自己的范围**用 SkillSpec 的 `targeting.rangeGrid`（相对格，朝 RIGHT 编写，引擎按 `unit.dir` 旋转：
`server/sim/dir.js:6`）。**运行中改范围**要在改完 `unit.rangeGrid` 之后调 `battle.refreshRange(unit)`
（`server/sim/battle/queries.js:262`）—— 不调的话 `unit.rangeKeys` 还是旧的（`server/sim/battle/queries.js:243`）：

```js
install(battle, unit) {
  const own = unit.rangeGrid;                                  // ★ 初始就是 def.rangeGrid，深度冻结（server/sim/battle/players.js:197、server/sim/simdata.js:518）
  const wide = own.map(([r, c]) => [r, c]);                     // 先复制，再改副本
  wide.push([0, 2], [0, 3]);
  const setRange = (g) => {
    if (!unit.alive || !unit.deployed) return;
    unit.rangeGrid = g.map(([r, c]) => [r, c]);                 // 每次都给一份新副本
    battle.refreshRange(unit);                                  // ★ 不调用它，rangeKeys / rangeKeySet 还是旧格子
  };
  battle.on('skillStart', (ctx) => { if (ctx.unit === unit) setRange(wide); }, { owner: unit });
  battle.on('skillEnd', (ctx) => { if (ctx.unit === unit) setRange(own); }, { owner: unit });
},
```

| 想要的效果 | 用什么 | 证据 |
|---|---|---|
| 「攻击范围 +1」 | buff 的 `mods.rangeExtend`（永久的那部分进初始范围） | `server/sim/units.js:141`、`server/sim/buffs.js:183`、`server/sim/battle/queries.js:252` |
| 换掉整个范围形状 | `unit.rangeGrid = 副本` + `battle.refreshRange` | `server/sim/content/kits/ops/chess_char_5_15-thorn2.js:168`、`…/op-cgbird.js:149` |
| 只多几个「打得到」的格子（不改形状） | `battle.setExtraRange(unit, keys)`，key 是绝对 tile key（`row * COLS + col`，`COLS` 是**画布**宽度 —— 一张图是画布里的一个窗口，`shared/constants.js:95` 的 `CANVAS_COLS`，`server/sim/constants.js:12`） | `server/sim/battle/queries.js:273`、用法 `…/ops/chess_char_6_01-lemuen.js:201` |
| 技能范围与自己的范围不同 | `targeting.rangeGrid` | `docs/SIM.md:1025` |
| 技能范围**不**吃单位的攻击距离加成 | `targeting.noRangeExtend` | `server/sim/battle/queries.js:240` |
| 范围只用来选目标、不改卡面上的范围 | `targeting.showOwnRange` | `server/sim/battle/queries.js:249` |
| 「不靠普攻触发技能」的额外范围 | `trigger: { rule: 'SKILL_RANGE', grid }`，或 `unit.skill.addTriggerRange(fn)`（回调返回格 key 数组或 `{ keys, profile }`） | `server/sim/skills.js:146`、`:130` |
| 临时换自动释放规则 | `unit.skill.setTrigger(rule, grid)` | `server/sim/skills.js:130` |

**不要**直接改 `unit.rangeKeys` / `unit.rangeKeySet`（每次 rebuild 都会重建，`server/sim/battle/queries.js:237`），
也**不要**往 `unit.rangeGrid` 里 `push`：初始那个数组就是冻结的 `def.rangeGrid`（`server/sim/battle/players.js:197`
+ `server/sim/simdata.js:518`），写它会抛异常。官方 kit 一律先复制：`server/sim/content/kits/shared/tier5.js:181`。

### 8.8 治疗与护盾

```js
// 治疗：返回真正加上去的血量（damage.js heal 的返回值）；heal 钩子只能改 amount，不能改目标
battle.heal(unit, ally, unit.s.atk * num(bb.heal_scale, 1));                        // server/sim/battle/combat.js:13
battle.heal(unit, unit, num(bb.value, 0), { self: true });                          // 自疗：server/sim/damage.js:537
battle.heal(unit, ally, 500, { overheal: true });                                   // 溢疗转屏障：server/sim/damage.js:554

// 屏障（护盾）= buff 上的 shield 字段；盾先于 HP 被扣（server/sim/damage.js:279）
battle.addBuff(ally, { key: 'ws:barrier', shield: unit.s.atk * 2, duration: num(bb.duration, 8), visible: true, source: unit });
battle.addBuff(ally, { key: 'ws:artsbarrier', shield: 2000, duration: 10, shieldType: 'arts' }); // 只吸法术：server/sim/damage.js:196
battle.addBuff(ally, { key: 'ws:onelayer', shieldHits: 1, visible: true });                      // 挡下一次伤害：server/sim/damage.js:199

// 选治疗目标
const hurt = battle.lowestHpAllyInRange(unit) ?? unit;        // server/sim/battle/queries.js:109
const list = battle.alliesFor(unit);                          // 会跳过「孤立」：server/sim/battle/queries.js:145
```

- 盾的数据模型就是 buff 的 `shield`（吸收量）与 `shieldHits`（免疫次数）（`server/sim/buffs.js:167`、`:168`），
  `shieldType` 限定吸收类型（`server/sim/damage.js:196`），**没有独立的护盾槽**。
- 「一层护盾」的官方写法（破盾时给技力，用 `onRemove`）：`server/sim/content/kits/ops/chess_char_3_21-archet.js:103`。
- 「溢疗转屏障」也可以在 `heal` 钩子里手写：`server/sim/content/kits/ops/chess_char_2_09-humus.js:48`。
- **递减屏障**：`buff.onTick` 里扣 `buff.shield`（`server/sim/buffs.js:161` 的 `onTick` + `interval`），官方例子
  `server/sim/content/kits/ops/chess_char_6_13-angel2.js:13`。
- **禁疗 / 治疗加成**：目标是 `noHeal` / `healFree` 时 `heal` 返回 0（`server/sim/damage.js:543`、`:545`）；
  治疗量乘的是施疗者的 `healingDealtMul` 与目标的 `healingTakenMul`（`server/sim/damage.js:546`）。
  这些桶你自己**不要**再乘一遍。
- **「生命回复速度」不要用 `heal`**：用 `mods.hpRegen` / `hpRegenRatio`（`server/sim/units.js:170`），
  它以 `opts.regen` 走同一条 `heal` 函数、但不吃禁疗与治疗加成（`server/sim/damage.js:544`）。口径见
  `server/sim/content/kits/README.md:330`。

### 8.9 目标选择

**能声明就声明，别自己挑**（声明式的东西引擎会连技能触发、范围重建一起处理）：

```js
// 技能期间：技能自己的索敌
skill: { kind: 'duration', targeting: { maxTargets: 3, priority: 'elite', canHitFly: false, allInRange: false } },
// 常驻：特性层（kit.trait 会覆盖战斗档案，server/sim/professions.js:698）
trait: { priority: 'lowDef', maxTargets: 2, splashRadius: 1.2 },
```

- **`priority` 是固定词表**（`server/sim/targeting.js:176`）：`fly` `lowDef` `highDef` `ranged` `lowestHp` `highestHp`
  `lowestHpRatio` `highestAtk` `boss` `elite` `notBurst` `ground` `heaviest`，另外 `nearest` / `farthest` 由引擎特判
  （`server/sim/targeting.js:203`）。用法例子：`server/sim/content/kits/ops/chess_char_1_01-inside.js:21`（`ranged`）、
  `…/chess_char_6_13-angel2.js:50`（`fly`）、`…/op-cerber.js:91`（`highDef`）。
- **`maxTargets` 是上限，不是下限**：引擎按 `prof.maxTargets` 截断候选（`hitAllBlocked` 的档案改用阻挡数），
  再加上 buff 的 `mods.maxTargets`（`server/sim/ai.js:178` 数目标数，`:163` 与 `:158` 才真正切片）。
- **打不打空军**：`targeting.canHitFly` / `trait.canHitFly`（`server/sim/ai.js:68`）；「只打地面」用 `groundOnly`
  （`server/sim/targeting.js:88`）。
- **自己挑人**（技能/天赋里手写选取）用 `battle.enemiesInKeys(keys, unit, profile)`（`server/sim/battle/queries.js:34`），
  `keys` 是**绝对** tile key。工坊里要自己旋转范围格 —— 引擎的 `absoluteRangeKeys`（`server/sim/targeting.js:25`）不能
  import，照抄 `server/sim/dir.js:39` 那张表：

```js
const COLS = 33;                                                  // shared/constants.js:95 的 CANVAS_COLS（server/sim/constants.js:12）
/** 把朝 RIGHT 编写的相对格 [dr, dc] 转到 `dir` 的绝对格（抄 server/sim/dir.js:39 的 rotateOffset）。 */
const rot = ([dr, dc], dir) => (dir === 'UP' ? [dc, -dr] : dir === 'LEFT' ? [-dr, -dc] : dir === 'DOWN' ? [-dc, dr] : [dr, dc]);
const gridKeys = (unit, grid) => grid.map(([dr, dc]) => {
  const [a, b] = rot([dr, dc], unit.dir);
  return (unit.tileR + a) * COLS + (unit.tileC + b);
});
const foes = battle.enemiesInKeys(gridKeys(unit, def.skill.rangeGrid), unit, { canHitFly: false });
```

- **「范围效果能选中」的语义**用 `foesInRadius`（`server/sim/battle/queries.js:175`，剔除不可选中 / 隐匿），
  「谁在半径里」用 `enemiesInRadius`（`:154`）。
- **友方**：`battle.alliesFor(unit)` / `battle.alliesInGrid(unit)` / `battle.alliesInRadius(...)` 都会跳过「孤立」单位
  （`server/sim/battle/queries.js:140`）；`battle.injuredAlliesInKeys(keys, healer)` 专挑需要治疗的人（`:92`）。
- **每个受害者各一次**用 `attack.onEachHit(ctx)`（`ctx.kind` = `'main'` / `'splash'` / `'chain'`，还带
  `dealt` / `isSplash` / `isChain` / `main` / `attackId`：`server/sim/ai.js:279`）；**每次攻击一次、只给主目标**用
  `attack.onHit(ctx)`（`server/sim/ai.js:346`，它的 `ctx.dealt` 是这次攻击对**所有**目标造成的总伤害）。
- **引擎不提供**：改不了敌人「怎么挑我」（那是敌人的 profile / data），只能靠 `taunt`（`server/sim/units.js:148`）或
  `battle.setAllyTarget` 把友军注册成可攻击目标（`server/sim/battle/queries.js:62`）。

### 8.10 与盟约、天赋、数据层交互的边界

- **天赋不会自动生效**。记录里的 `talents[]` 只是数据，`genericTalents` 只在**没有 kit、回退到通用 kit** 的那条路上
  才跑（`server/sim/content/index.js:90` 的 `fallbackKit`、`:124` 的调用点），而且只认补位 / 自选干员能精确套用的无条件
  数值条款。本包干员的每一条天赋都必须在 `talents` 里自己实现。
- **kit 一旦存在，官方 kit 就完全不被调用**：查表是「注入表优先」（`server/sim/content/index.js:114`）。所以覆盖官方
  干员时，你得把它的每条技能、天赋、特性都补回来。
- **黑板书分三处，别搞混**：`bb` 是**选中技能**的黑板（`server/sim/content/index.js:103`）；具名天赋用
  `talentBb(chess, i)`；**模组带来的天赋改动**是 `index === -1` 的隐藏天赋，要用 `moduleBb(chess)` 合并；
  **特性**的模组升级已经并进 `traitBb(chess)`（`server/sim/content/kits/shared/tier1.js:48`、`:52`、`:58`）。
  `chess.module.active` 表示这个模组是否生效（同文件 `:60`）。不要自己按等级或模组再算一遍。
- **`trait` 一身两职**：它既是战斗档案的覆盖字段（`{ priority, maxTargets, splashRadius, noAttack, groundOnly … }`，
  合并点 `server/sim/professions.js:698`，键表在 `server/sim/professions.js:11`），也可以带 `install(battle, unit)`
  （与 `talents` 同形：`server/sim/content/kits/ops/chess_char_1_06-vendla.js:27`）。
- **安装顺序是固定的**：`profile.install`（也就是 `trait.install`）→ `talents[].install` → `kit.install`
  （`server/sim/battle/players.js:206`–`:231`），都在战斗开始前的构造期跑一次。别指望 `talents` 先跑。
- **盟约不是你的事**：官方 23 条的加成在 `server/sim/content/bonds/*` 里按 id 实现，成员由**干员的 `bonds` 列表**推导
  （`docs/prompts/README.md:179`，那一节从 `:152` 开始）。kit 里再给成员加一遍就是双倍。要动层数用 `battle.addLayers`（§8.5）。
- **装备 / 道具的加成也不在 kit 里**（`server/sim/content/items/battle.js`）；kit 只负责「这个干员的技能与天赋」。
- **元素有两个桶**：`elemTakenMul` 是元素**损伤**（量表）倍率，`elementalTakenMul` 是元素**伤害**（掉血）倍率
  （`server/sim/units.js:162`、`:163`）。改 `dmg.mul` 时不要顺手把这两个也乘上。
- **`bb` / `chess` / `def` 是深度冻结的**（`raw` 例外：`server/sim/simdata.js:518`）。要「改数值」就换一条 buff，
  要「改范围」就换一份副本（§8.7）。

### 8.11 不要这么做（反例）

| 反例 | 会发生什么 | 正确做法 |
|---|---|---|
| 在 kit 里改全局状态：`bb.atk = 2`、`def.rangeGrid.push(…)`、`battle.flags.dpPerSec = 5` | `bb` / `def` 深度冻结会当场抛异常（`server/sim/simdata.js:518`）；`battle.flags` 是构造期输入（`server/sim/Battle.js:113`），运行中改它没有文档保证，而且服务端复算与浏览器两头都得改才一致 | `addBuff`（数值）、`unit.rangeGrid` 副本 + `refreshRange`（范围）、`setExtraRange`（补格子） |
| 依赖执行时序：「我的 `hit` 一定在别人之后 / 之前跑」 | 顺序 = `priority` 降序 + 注册顺序（`server/sim/battle/hooks.js:22`），同一份文件里换个写法就变，而且官方 kit 的 priority 你看不到 | 用自己的标记判断（官方例子：`server/sim/content/kits/ops/op-judge.js:158` 用 `WeakSet` 认自己的那次伤害） |
| 写死数值：`mods: { atkPct: 0.6 }` | 干员升级、精英、模组换了数值它**永远不变**，还不报错 | 从黑板读：`num(bb.atk, 0)` —— 数字只从黑板来是硬规矩（`server/sim/content/kits/README.md:268`） |
| `Math.random()` / `Date.now()` / `setTimeout` | 服务端复算结果不同 → 玩家成绩被拒，而报错看起来与随机数无关（`shared/kitAuthoring.js:41`） | `battle.rng()` / `battle.after` / `battle.every`（`server/sim/battle/hooks.js:112`） |
| 模块级可变变量记状态：`let hits = 0;` | 同一份文件在服务端与浏览器各加载一次，两边的变量不是一份（`server/sim/content/kits/README.md:84`） | `unit.mem`（`server/sim/units.js:83`）或按 `battle` 作键的 `WeakMap`（`server/sim/content/kits/shared/tier1.js:146`） |
| `battle.on(…)` 不写 `{ owner: unit }` | 单位退场后钩子还在，反复部署越挂越多、效果翻倍（`server/sim/battle/hooks.js:46`） | 每个 `on` 都带 `owner` |
| 在 `tick` 里做重活或每帧分配大对象 | 一局 30 fps × 玩家数，卡的是主机 | `battle.every(0.5, …)`（`server/sim/battle/hooks.js:119`） |
| 直接设面板值：`unit.base.atk = 999` | `base` 是面板输入、`unit.s` 才是聚合结果（`server/sim/units.js:112`、`:120`），绕过去会让「属性来源」全乱，而且没有接口保证 | 用 `mods`（`atkFlat` / `atkPct` / `atkFinal`，`server/sim/units.js:130`）；召唤物可以用 `spawnToken` 的 `opts.stats`（`server/sim/battle/summons.js:60`） |
| 在 `hit` 里加伤却不判 `isAttack` / 不排元素损伤 | 技能伤害、持续伤害、反伤、元素损伤都会被加成 | `if (!ctx.dmg.isAttack) return;`（`server/sim/content/kits/ops/chess_char_4_10-aroma.js:38`、`:73`） |
| 在 `damaged` 里 `dealDamage` 却不打 tag / 不跳过自己的 tag | 与自己的输出乒乓递归，嵌套守卫触发后连 `kill` / `death` 一起被跳过（`docs/SIM.md:810`） | 打 tag 并跳过它（`server/sim/content/kits/ops/chess_char_1_06-vendla.js:62`） |
| 想用 `import` 拿官方辅助函数 | `KIT_IMPORT` 错误（`shared/kitAuthoring.js:195`）：服务端按路径、浏览器按 URL，跨环境路径不可能同时对 | 内联（§8.1） |
| 改完 `unit.rangeGrid` 忘了 `refreshRange` | `unit.rangeKeys` / `rangeKeySet` 仍是旧格子，攻击与技能触发都用不上新范围 | 改完立刻 `battle.refreshRange(unit)`（`server/sim/battle/queries.js:262`） |
| 用 `unit.rangeKeys` 当「范围定义」缓存起来 | 它是快照，部署、换方向、范围重建后都会变（`server/sim/battle/queries.js:237`） | 每次重新读，或读 `unit.rangeKeySet` |

### 8.12 引擎确实不提供的那些东西（汇总）

| 想要的效果 | 引擎不提供什么 | 替代写法 |
|---|---|---|
| 在工坊 kit 里 `import` 官方辅助 / 引擎模块 | `KIT_IMPORT`（`shared/kitAuthoring.js:195`） | 内联一份（§8.1） |
| 运行时换掉战斗档案（攻击方式、弹道、治疗模式） | 没有公开接口：`kit.trait` 只在构造期合并一次（`server/sim/battle/players.js:211`、`server/sim/professions.js:698`） | 技能期间用 SkillSpec 的 `attack` / `targeting`（`server/sim/skills.js:567` 是它的生效判定），或改 `ctx.dmg` |
| 直接设操作者的面板属性 | 没有接口（只有召唤物能用 `spawnToken` 的 `opts.stats`：`server/sim/battle/summons.js:60`） | `mods` |
| 运行时改全局规则 / 经济 / 回合表 | `battle.flags` 是构造期输入（`server/sim/Battle.js:113`）；包也不能贡献 `config`（`docs/WORKSHOP.md:56`） | 改自己的单位、自己 `battle.emit` 命名空间事件 |
| 让敌人改路线 / 换 AI | 没有接口 | 位移 `battle.push` / `pull` / `pullToFront`（`server/sim/battle/displacement.js:41`、`:69`、`:97`）与状态 `fear` / `attract`（`server/sim/buffs.js:84`、`:120`） |
| 独立的护盾槽 / 多个盾各吸一类伤害 | 没有：盾就是 buff 的 `shield` / `shieldHits`（`server/sim/buffs.js:167`、`:168`） | 一个 key 一个盾，用 `shieldType` 限定吸收类型（`server/sim/damage.js:196`） |
| 改「治疗落在谁身上」 | `heal` 钩子只能改 `amount`（`server/sim/damage.js:551`） | 自己选目标（`server/sim/battle/queries.js:92`、`:109`） |
| 读存档 / 准备区 / 商店 / 装备栏 | sim 里没有这些对象 | `battle.getPlayer(playerId)` 给的是战场视图（`docs/SIM.md:843`），`battle.data` 给的是本局数据（`server/sim/Battle.js:88`） |
| 给包加一份 `tokens.json` 之外的新数据种类 | 只有 13 个内容文件可贡献（`shared/workshop.js:29`） | 贡献 `tokens.json`（`shared/workshop.js:34`），或用 `spawnToken` 的 `opts.def` 内联定义（`server/sim/simdata.js:304`） |
| 在联防 / boss 战场里加盟约层数 | `addLayers` 只在 `flags.layerGainsEnabled` 时生效（`server/sim/battle/economy.js:23`），只有普通战场是 `true`（`server/sim/Battle.js:113`） | 没有替代：那两种战场里加层是 no-op |
| 我方单位的「攻击前摇开始」事件 | 没有：`beforeAttack` 在目标已选定之后才触发（`server/sim/ai.js:186`） | 用 `beforeAttack` 清 `ctx.targets` 取消这次攻击；敌人的起手另有 `enemyAttackStart`（`server/sim/ai.js:805`） |
| 「技能召唤物做成手牌」那套现成流程 | `releaseSkillSummon` 在 content 模块里，工坊不能 import（`server/sim/content/tokens.js:381`） | 自己 `battle.spawnToken`；手牌形式要走 `tokens.json` 的 `placeable` |
| 召唤师牌堆（持有 / 回收 / 随主人消失） | `summonDeck` 是要 import 的辅助（`server/sim/content/kits/shared/summoner.js:99`） | `unit.mem` + `battle.every` + `battle.redeploy` 自己写 |
