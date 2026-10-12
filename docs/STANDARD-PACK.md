# 标准包规范（STANDARD-PACK）

**这份文档回答一个问题：什么样的投稿算「标准工坊包」，什么不算，以及不算的那些怎么办。**

它存在的理由很具体：到今天为止，社区投进来的东西**七种形态都真出现过**，而「哪种算标准」此前散在 `SKILL.md` §3、`packs/README`、`site/README`、`WORKSHOP.md` 四处 —— 于是 ③ 补丁型与 ④ 安装器型**反复被投进来**，每次都要有人从头解释一遍。

> **一句话口径（业主 2026-10-12 裁）**：**兼容优先。**「非标准」这三个字**只用来告诉投稿人怎么写**，
> **不是拒收规则**。③④ 照收（进 `incoming/`），由站侧/我们改写成包；**不打回、不删**。
> 判不了的宁可留在待审，也不当垃圾清掉。

---

## 一、七种形态与定级

| # | 形态 | 长什么样 | 定级 | 引擎收吗 | 站点收吗 |
|---|---|---|---|---|---|
| ① | **标准工坊包** | ZIP 根有 `pack.json`，键都在闭集内 | **标准** | ✅ | ✅ |
| ② | **包裹式** | 所有文件套在**一个顶层目录**下（`<mod名>/pack.json`） | **半标准** | ✅（引擎两种都收） | ❌ **400**（站点只认 ZIP 根） |
| ③ | **补丁型** | `SOURCE.md` + `changes.patch`（对源码的 diff） | **非标准** | ❌ 没有 patch 面 | ❌ |
| ④ | **安装器型** | `install.mjs` + `payload/**`（整份覆盖 `data/**`、`server/**`） | **非标准** | ❌ 且**违反发行纪律** | ❌ |
| ⑤ | **资源容器型** | 标准包 + `packs/*.spresources` 容器（素材随包送达） | **标准** | ✅ | ✅ |
| ⑥ | **功能包** | 声明了 `client.panels` / `server.modules` / `messages` 等生效面 | **标准** | ✅ | ✅ |
| ⑦ | **声明包** | 只声明 `variants` / `assets` / `notices` 这类 | **标准** | ✅（须有"贡献"，见 §三.3） | ✅ |

**② 的差别只在站点那一层**：引擎的装包器（`installZip`）**两种都收**（ZIP 根 → 否则取唯一顶层目录），
而站点的 `packJsonFor`（`site/server.mjs`）**只认 ZIP 根** ⇒ 包裹式上传会被 **HTTP 400** 挡下。
⇒ 投稿人只要**重新压一次、把包内文件放到 ZIP 根**即可（不需要改内容）。

---

## 二、标准包的四条硬要求

1. **`pack.json` 在 ZIP 根**（② 请重压）。
2. **键必须在闭集内**：`PACK_FIELDS` 共 **35 键**，完整清单见 `shared/workshop.js`：
   `id name version author license description gameVersion game api layer combat` ·
   `content overrides` · `voices voiceLangs bondIcons itemIcons art skins support operators i18n` ·
   `forms fx` · `notices playtest` · `variants behaviour` · `assets client server routes` · `target` ·
   `dependencies conflicts`。
   **不认识的顶层键点名拒绝**（`PACK_UNKNOWN_FIELD`），**绝不读过去** —— 这是这一层最硬的一条纪律。
   `target`（§28.46）是**唯一一格可以带出本引擎的键**：`"stardust"` 的包是给 Stardust 宿主的**声明型包**，
   本引擎只认识、不装载（`server/workshop.js` 的 `foreign`）；**不写 `target` 的包一个字节都不受影响**。
   `dependencies` / `conflicts`（§28.48）是**包之间的关系**声明（`[{ id, range? }]`，`id` 是另一个工坊包）：
   形状在这里判，**语义在装载期裁决**（缺失依赖 / 版本不合 / 互斥 / 级联 / 循环，全部具名拒绝）。
3. **必须有"贡献"**：只声明 `variants`（或只有元信息）会被判 **`EMPTY_PACK`** —— 原话是
   「`variants` is NOT a contribution」。要上架就得**至少贡献一样东西**（内容 / 面板 / 规则 / 公告 / 素材…）。
   **不算贡献项的六个键**（`shared/workshop.js` 的 `notContributions`；只在该包真的声明了它们时才逐字点名）：
   **`behaviour` · `variants` · `support` · `playtest` · `dependencies` · `conflicts`** —— 它们**都只是「怎么跑」或
   「和别的包什么关系」的声明，自己不往对局里带任何东西**（`behaviour` 选规则档、`variants` 选口径、`support` 只决定
   助战卡池里放谁、`playtest` 只是试玩时直接发手牌、`dependencies` / `conflicts` 只说包之间的关系）。
   ⚠️ **声明行为开关的包必须另带一样真贡献**：`content` / `client` / `notices` / `routes` … 里至少要有一个，
   否则整包被拒（`EMPTY_PACK` 的文案会逐字写「`"behaviour"` is NOT a contribution — a pack that declares it
   alone brings nothing into a match」）。**声明还得是表里有的**：`shared/behaviour.js` 的
   `BEHAVIOUR_SWITCHES` 今天 **4 格**（`shopBias` / `prepLoadout` / `morphPairing` / `unequip`）⇒
   声明表里没有的开关或选项被 `BEHAVIOUR_UNKNOWN_SWITCH` / `BEHAVIOUR_UNKNOWN_OPTION` 点名整包拒；
   上面那条「另带一样真贡献」照样管着它。
4. **版本范围与 `combat`**：
   - `api` 要落在 `MOD_API_VERSION` 相容范围内（今天 `MOD_API_VERSION = 1`，写法 `">=1 <2"`）；
     **不写 `api` 不比对**，但写了就得对。
   - 声明了**会改对局结果**的面（`server.modules` 用 `matchClass`、`behaviour` 任一格）⇒
     **必须 `combat: true`**（`MODULES_NEED_COMBAT` / `BEHAVIOUR_NEEDS_COMBAT` 会点名拒）。
   - `game` / `gameVersion` 是**标签**，引擎**不与运行版本比对**（写 `0.2.x` 是上游版本号，写 `0.15.1`
     是引擎版本号，都只是标签）；但**写对**才便于人读。

---

## 三、分类判据：`functional` / `documentation` / `unknown`

站点与 mod 仓库都用这一份判据（**按序判，写实测值**，不抄别处的分类）：

1. **`functional`** —— 声明了
   **`content` / `overrides` / `kits` / `variants` / `behaviour` / `client` / `server` / `assets` / `notices` / `routes`** 任一
   ⇒ 它供给的东西**会被游戏消费、或玩家看得见**（`routes` 也算：它把数据挂成端点供对局侧读）。
2. **`documentation`** —— 否则，若**包自己**在 `note` / `README` / `SOURCE` 里**自述是参考/说明包**
   （「说明 · 参考 · 不会启用 · 装不上或没效果是【预期】的」这类）⇒ 它是**说明包**：
   **装上去玩家侧什么都不会发生**。
3. **`unknown`** —— 都不满足 ⇒ 量不出，**不入 mod 仓库**，交人判。

**两个先例（用来对齐）**：
- `7bf0bd0e56fd`（WS 压缩参考 v2）自述「装不上或没效果是【预期】的」⇒ **`documentation`** ✓
- `duel-copy`（只声明 `notices`、公告会被玩家看到）⇒ **`functional`** ✓

> ⚠️ **`documentation-only` 是审核策略，不是 `category`。** 站点对说明包的策略是
> 「**不上架但留在待审、不打回**」（`AGENTS.md` §4 第 5 条），因为**它的简介是做兼容包的依据**；
> 而 `category` 是这条包**实测是什么**。两件事，别混。

---

## 四、非标准形态（③④）怎么处置

**照收，我们改写，不打回不删。**

| 形态 | 为什么不标准 | 处置 |
|---|---|---|
| ③ 补丁型 | 引擎**没有 patch 面**（`pack.json` 是声明式契约，不执行代码） | 收进 `incoming/` ⇒ 读 `changes.patch` 弄清它想改什么 ⇒ **按我们的通道改写成包**（口径轴 / `behaviour` 开关 / `client.panels` / `content`…）⇒ 上站 |
| ④ 安装器型 | 它的做法是**整份覆盖 `data/**` 与 `server/**`**，而**包不许整份覆盖引擎文件**（`WORKSHOP.md` §1.1 六格「刻意没有通道」+ DESIGN §28.43） | 收进 `incoming/` ⇒ **逐条看它改了引擎什么**：能靠既有通道表达的改写成包；**确属引擎本体的，整合进发行版**（见 §五） |

**③④ 不是"废件"** —— 到今天为止，它们恰恰是**新能力的主要来源**：② 战绩、③ 房间目录、④ 行为声明通道、
⑤ 素材源、⑥ 形态投影这五刀，全部是被这类投稿驱动的。

---

## 五、一条总原则（决定"做包"还是"做引擎"）

> **引擎能力必须在引擎，包只能消费它；不能做成 mod 的就整合进发行版一起开。**

- 包**只能**消费引擎已经提供的能力（声明式、受约束、引擎自烘）。
- 投稿要的能力若**引擎还没有** ⇒ **不开"包可以改引擎"的口子**，而是**把能力做进引擎**（新的
  `behaviour` 开关 / 口径轴 / `client.panels` 槽位 / `server.modules` 用途），然后**包才可能表达它**。
- 因此：**加一格开关 = 引擎侧一刀**（必须同时有引擎执行点与测试），不是"往表里塞个名字"。

---

## 六、相关文档

- 包格式与全部字段：`docs/WORKSHOP.md`
- mod 面（槽位 / 模块用途 / 可 wrap 组件 / 锚点）：`docs/MOD-SURFACE.md`
- 加东西时要一起改哪几处：`docs/SYNC-POINTS.md`
- mod 层设计与历史决策（§28）：`docs/design/mod-layer.md`
- 投稿与交付流程：`Stronghold-Protocol-Forge-Mods/SKILL.md` · `UPLOAD.md`
