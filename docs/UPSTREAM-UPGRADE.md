# 上游更新校对清单

> 用途：**原项目发布新版本后**，照这份单子走一遍，就能找齐所有「会被上游改动打断」的地方。
> 本文只讲**怎么核对与怎么修**，不讲设计（设计在 `docs/design/mod-layer.md` 与 `docs/MOD-SURFACE.md`）。
>
> 一句话原则：**契约面（规范）上游会照顾我们；引擎内部（实现）我们自己盯。**
> 前者动一下会进上游 CHANGELOG，后者挪个文件就可能让包装不上。

---

## 0. 先跑一条命令

```powershell
npm run ci
```

六步里会红给你看的东西（都不需要人去找）：

| 步骤 | 会抓到什么 | 名字长什么样 |
|---|---|---|
| `test` | 白名单别名指向的文件不见了 | `@kit/tier2.js → …/tier2.js 不存在` |
| `test` | 具名组件枚举与客户端的 `modComponent(id, …)` 漂移 | `CLIENT_WRAP_UNKNOWN_COMPONENT` |
| `test` | 表面清单里的锚点符号被改名/挪走 | `表面 "…" 锚在 X 上，但 Y 不再导出这个名字` |
| `imports` | 跨层 import 越界（`shared/` 不许引 `server/`） | 逐条点名 |
| `typecheck` | 上游改了签名而我们还在旧写法 | `tsc` 报点 |
| `lint` | 该走 `t()` 的字面量、`server/sim/` 里出现时钟/随机 | 逐条点名 |

**拦住「已装的 mod 会不会重置」的正是第一行那条**（见 §2）。

---

## 1. 契约面（11 个文件）：上游会照顾，我们只读

这 11 个是**两边共同的规范**，上游动它们会进 CHANGELOG：

| 文件 | 它是什么 |
|---|---|
| `shared/protocol.js` | 线上消息契约 |
| `shared/constants.js` | 阶段、错误码、`MOD_API_VERSION` |
| `shared/packs.js` | 包类型表 |
| `shared/i18n.js` / `shared/i18nPacks.js` | 界面词条 |
| `shared/modIdentity.js` | 房间身份与摘要 |
| `shared/diy.js` | 自选池记录 |
| `shared/support.js` | 助战目录 |
| `shared/packs` 的三个同族文件 | 见 `npm run ci` 的 imports 步骤 |

**核对方式**：看上游 CHANGELOG 有没有改这 11 个；有，就逐条读它改了什么形状。

**什么时候抬 `MOD_API_VERSION`**：只有「**契约语义变了、没有别名可对**」才抬
（比如 kit 函数的签名变了、效果注册表的形状变了）。抬了老包会**响亮地被拒**（`MOD_API_INCOMPATIBLE`）——
这是对的，**不能悄悄跑错**。

**加一个能力永远不抬版本**：`docs/MOD-SURFACE.md` 的版本政策写死了这一条，所以 `ctx.me`、宿主键、
表面清单加行这些**加法**不会让已发布的包失效。

---

## 2. 引擎内部（会打断包的地方）：只有四处

上游**挪文件 / 改名**是最常见的一类改动，而它对包的影响只经过这四个口子。**改这里，包不动、mod 不重置。**

### 2.1 白名单别名（最常见，只改一行）

`shared/kitImports.js` 的 11 条 `@kit/` / `@sim/` / `@battle/` → 引擎真实路径：

| 别名 | 指向 |
|---|---|
| `@kit/tier1..6.js` | `server/sim/content/kits/shared/tierN.js` |
| `@kit/summoner.js` | `server/sim/content/kits/shared/summoner.js` |
| `@sim/constants.js` / `dir.js` / `targeting.js` | `server/sim/*.js` |
| `@battle/index.js` | `server/sim/content/support/index.js` |

**上游把某个文件挪走时**：改**这一行**的目标。包的源码**一个字节都不用动**，mod 作者什么也不用改，玩家不用重装。

**实测证据**（把 `tier2.js` 改名模拟上游挪文件）：

- 守卫报「白名单里指向缺失文件的条目 = 1」⇒ CI 期就红；
- 一个用到它的包装载时得到 `KIT_IMPORT_FAILED`，**点名是哪个包的哪个 kit**；
- 那条别名重指之后，同一个包原样能跑。**⇒ 不需要重置。**

### 2.2 具名组件枚举（少见）

`shared/workshop.js CLIENT_WRAP_COMPONENTS` 的 4 个 id：`game.bondStrip` / `game.hud.topBar` /
`game.shopCard` / `loadout.detail`。

每个 id 在 `public/js/**` 里正好**一处** `modComponent('<id>', impl)`。上游改组件名 ⇒ 两边一起改。
有一条守卫盯着「枚举里的每个 id 在客户端真的有实现」。

### 2.3 宿主与挂载点（九个槽位）

`CLIENT_PANEL_SLOTS` 指向的九个宿主容器（`[data-mod-slot]`）。上游改动对局屏结构 ⇒ 核这九个还在不在。
**注意**：注入面**刻意**不给 store / 对局对象 / battleRunner（面板可以画错，但不能算错）——
不要因为上游改了内部结构就顺手把这些开出去。

### 2.4 表面清单

`shared/modSurface.js` 的 24 行 + `docs/MOD-SURFACE.md`。加即可，删/改名才抬版本。

---

## 3. 复算性：改完必须还能比

- `npm run golden` 六份语料必须**全 match**（`roster` / `bonds` / `fields` / `matches` / `standins` / `diy`）。
- **有意改动玩法**才跑 `npm run golden:update`，而且**同一次提交**里点名每一个移动的场景与理由
  （`AGENTS.md` 的硬规则）。上游更新本身**不该**让 golden 移动 —— 移动了就说明我们误改了行为。

---

## 4. 上游更新时的执行顺序（建议）

1. `git fetch` 上游，读它的 CHANGELOG / DESIGN 版本行。
2. 合进来（或重新对齐），先解冲突 —— 冲突几乎总在**契约面**那 11 个文件上。
3. 跑 `npm run ci`：第 0 节那张表会点名所有断掉的地方。
4. 断在白名单 ⇒ 照 §2.1 改一行。断在组件枚举 ⇒ 照 §2.2 改一行。
5. 跑 `npm run golden`：**应当全 match**。有移动 ⇒ 停下来查是我们误改还是上游真改了玩法。
6. 用 `_up/mod-compat/out/verify-both-packs.mjs` 把两个第三方 mod 真装一遍（0 拒绝 + 面板/kits 都挂上）。

---

## 5. 明确**不**做的两件事（避免以后有人重新提议）

- **不做就地补丁分发**（让包去改引擎文件）。它会换掉「多 mod 共存 / 升级不冲突 / 成绩可复算」三样，
  而那三样正是这个工坊存在的理由。详见 `_up/mod-compat/deliver/说明/改引擎与工坊支持.md`。
- **不做适配层**（把 20 个依赖收成一层 `modHost`）。收益只是「我们少改几行」，代价是多一层可能撒谎的间接；
  真正的升级成本是 §2 那四处的**几行**，而且已经有守卫盯着。
