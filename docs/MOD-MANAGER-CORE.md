# Mod Manager Core（重构版第一层）

这一份文档描述**重构版 mod 管理器**的第一层落地：以 SDK 边界为第一公民的
**Mod Manager Core**，以及随之而来的两项安全修复。它**不改变**任何现有包的运行行为——
默认路径逐字节不变，新增能力全部是**显式开关**。

> 目标形态（重构计划）：`官方 Mod 管理器核心` → `upstream-compatible 官方档(sp:sdk@1)` + `Forge 扩展档(forge-legacy)`。
> 本层只落地**核心**与**Forge 扩展档的归一化**；官方档（`sp:sdk@1`）的 manifest 解析也已落地，但是
> **provisional**（见 §3），因为它依据的是文档而非上游真规范。

## 1. 唯一一份 ActivationPlan

`server/mod-manager/plan.js` 的 `buildActivationPlan({ packs, registry, refused, unavailable, options })`
把「这一版到底装了哪些包」收成**一份**冻结的计划：

```text
discover → parse(归一化描述符) → registry(启用/禁用) → consent/pin → resolve(依赖/冲突) → activate → 派生摘要
```

产物：`{ discovered, parsed, descriptors, resolved, enabled, disabled, refused, excluded,
activated, capabilities, consent, digest:{contentDigestOf, modDigest, activationDigest}, errors, warnings }`。

`server/index.js` 现在从它取 `survivors` 与 `excludedPacks`（值与原实现**逐元素相同**），并把它交回
`startServer()` 的返回值（`srv.modPlan`）。运行时组件问「这个包在不在」时应当问计划
（`isActivated(plan, id)` / `activatedSetOf(plan)`），而不是各自重算——这正是原先
`lobby.js` 里 `packChannels` / `serverChannels` / `modSet` / 每房间过滤分散判断的根因。
`lobby.js` 的两张通道表已改为调用 `server/mod-manager/derive.js` 的纯函数（见 §7）。

### 1.1 一个装载门：计划先于任何插件代码执行

**这是本层最重要的一条顺序不变量。** 旧顺序是「解析 → 无条件 import/执行 → 算计划」，意味着一个
被禁用 / 被裁 / 未同意的插件，它的**顶层副作用与注册早就发生了**；而 `server/sim/content/extensions.js`
的注册表是**模块级全局**、没有回滚 API，于是它照样对**每一个房间**生效（「plan 说不在、运行时说在」）。

现在的顺序（`server/index.js`）：

```text
loadOfficialPlugins（只读 manifest、算摘要，不执行）
  → buildActivationPlan（清单层失败 → unavailable）
  → loadOfficialModules({ filter: 激活集合 })   ← 装载门
  → buildActivationPlan（装载期失败并入 unavailable）
  → 只把激活的交给运行时
```

`loadOfficialModules` 的 `filter` 拦下的插件**既不扫描也不 import**——它的字节永远不进入本进程
（`test/modOfficialCombat.test.js` 用「顶层写文件」的探针插件钉住：标记文件不存在）。

### 1.2 未接线的 profile 具名拒，绝不退回进程内

`class: 'script'` 在上游语义里是 **profile `sandbox`**（SES `Compartment` + 子进程）。本仓**没有**引入
`ses`/`acorn`，`createSandboxRunner` 也**没有生产调用点**——所以 `officialHost.js` 的 `UNWIRED_PROFILES`
把它**具名拒载**（`PLUGIN_SANDBOX_UNAVAILABLE`），而不是「悄悄在宿主进程里跑」。

进程内执行的是 `trusted` 档（profile `module`，严格档源码扫描 + 只注入声明过的 capability）。
一个声明「我要被隔离」的插件在宿主进程里跑，是**声明与语义相反**——本仓库反复判死刑的那种形状。

### 1.3 房间范围：扩展注册不是进程全局的

`sp.content.register` / `sp.meta.register` 的登记落在**进程级**表里，而一场战斗只属于**一个房间**。
所以 `installExtensions(battle, { packs })` 与 `registerExtensionMeta(registry, { packs })` 接收可选的
包 id 集合：房间在 `modSet` 里声明了子集 ⇒ 只装集合内的插件；没声明 ⇒ 不传（既有行为逐字节相同）。
这条集合从 `lobby.startMatch` 经 `Match.battleModIds` 传到 `Battle` opts 再到 `installContent`，
与 meta / battle 的既有房间过滤**同一条纪律**。

### 1.4 下游读者全部收敛到计划

`server/index.js` 的 `workshopLoaded.packs` 现在同时过 `pruned` 与 `modPlan.activatedSet`，于是
身份清单（`welcome.mods` / `modDigest`）、kits、面板、资源表、`/mods/catalog.json`、`roomAssets`
**一处过滤、全部受控**。`preDispatch` 钩子总线同样按激活集合过滤（它是唯一能 `return true` 否决
`room.create` / `room.join` 的包能力，漏它就是漏一道闸门）。`roomAssets` 的**官方基底**也补上了
`excludePacks`——否则被裁官方插件的声明式内容会从房间物化这条路回流。

### 1.5 房间子集准入

`server/lobby.js` 的 `room.create` 在 `resolveRoomModSet` 之后调用 `admission.js` 的 `roomSubset`：
房间点名的包必须在计划里**被激活**才放行。身份清单只能说明「这个服务器认识它」，计划才说明
「它此刻真的能跑」（启用 / 未被裁决拒绝 / 装载成功 / 已同意 / 钉版未失效）。

## 2. 三个摘要（不是一个）

| 摘要 | 含义 | 用途 | 位置 |
|---|---|---|---|
| `contentDigest` | **一个包**的内容（`[path, sha256]` 排序后哈希） | 包身份 | `shared/sdk/digest.js`（= `modManifestDigest`） |
| `modDigest`（集合） | **房间选中的包集合**（`[id, hash]` 排序后哈希） | 联机准入、客户端资源匹配 | `shared/sdk/digest.js`（= 既有 `modDigest`，**语义不变**） |
| `activationDigest` | **实际执行配置**：contentDigest + sdk + profile + capabilities + permissions + budget + consent + pin + 策略 | 审计、运行时证明、安全日志 | `shared/sdk/digest.js`（新增） |

`activationDigest` **只进日志与审计**，绝不进 wire——否则同一批包字节会在两种运行策略下得到两个不同的
`mods.digest`，把客户端资源匹配与联机准入一起污染。

## 3. SDK 边界：origin × profile 分域

`shared/sdk/sdkConstants.js`：

```text
origin:  'official' | 'forge'                （这份包按谁家的规范写）
sdk:     'sp:sdk@1' | 'forge-legacy'         （由 origin 决定，不接受自定义）
profile:  official → module | sandbox
          forge    → legacy | host
```

跨域声明（`official` 声称 `legacy`、`forge` 声称 `sandbox`）在形状层被**点名拒绝**。
`shared/sdk/descriptor.js` 把两种 manifest 分别解析后归一化到同一个 `NormalizedModDescriptor`：

```text
ForgeManifest(loadWorkshop 的 pack) ── ForgeLegacyAdapter ──▶ NormalizedModDescriptor
OfficialManifest(sp:sdk@1)          ── OfficialManifestAdapter ─▶ NormalizedModDescriptor
```

**官方档是 provisional 的**：上游 `sp:sdk@1` 的真规范在落地时并不存在（公开上游仍是 0.2.6），
所以 `OfficialManifestAdapter` 把文档能确定的部分**固化成一份封闭、可测的形状**——
字段闭集 `OFFICIAL_MANIFEST_FIELDS`、`apis[] → capabilities` 映射表 `OFFICIAL_API_MAP`、
缺省预算 `OFFICIAL_DEFAULT_BUDGET`（文档里的「8000 次插件预算」）、以及**硬边界**
`FORGE_ONLY_FIELDS`（官方 manifest 出现 Forge 私有字段即**具名拒绝**）。上游真规范到达时，只改
`shared/sdk/descriptor.js` 的这几张表与那一个函数。

**官方装载器**：`server/mod-manager/officialLoader.js` 的 `loadOfficialPlugins(root)` 把一个官方插件根
（`plugins/<插件>/plugin.json`）装成与 Forge 档同形的候选包：描述符 + `contentDigest`（插件**全部文件**的
归一化哈希）。纪律与 `server/workshop.js` 逐字同源——id 必须等于目录名、坏清单**具名拒整包**、
符号链接**既不跟随也不列出**。产出的候选包可直接喂给同一份 `buildActivationPlan({ options: { origin: 'official' } })`。

**官方 module 运行时**：`server/mod-manager/officialHost.js` 的 `loadOfficialModules(plugins)` 把声明了 `modules`
的插件装起来——严格档扫描 → 动态 import → `registerPlugin(host)`，宿主上**只有声明过的那几个面**。

描述符字段闭集：`id version origin sdk profile layer combat api entrypoints content assets
capabilities permissions dependencies conflicts budget contentDigest activationPolicy compatibility`。
未知字段**点名拒绝**（与 `pack.json` 的 41 键闭集同一条纪律）。

## 4. 同意 / 钉版（默认关闭）

`server/mod-manager/consent.js` + `server/modRegistry.js` 的三个新字段：

* `profile` —— 操作者指定的执行档位；
* `consent: { digest, at }` —— 对**某一版字节**的同意（装上 ≠ 同意）；
* `pin: { digest, at }` —— 钉版；**字节一变即失效**。

判据：`evaluateConsentPin(descriptor, entry, policy)`。两个纪律：

1. **默认 `requireConsentForHost: false`** —— 现装包一个都不会因为新增机制被裁掉；
2. 打开它时，未同意的宿主进程档包被**具名**拒（`SDK_NOT_CONSENTED`），钉失效同理（`SDK_PIN_STALE`）。

CLI/程序接口：`setConsent` / `clearConsent` / `setPin` / `clearPin` / `setProfile`（`server/modRegistry.js`，
写盘仍走那唯一的 `mutate`——**不新增第二份状态文件**）。

## 5. 统一调用预算 / 看门狗（默认关闭）

`server/mod-manager/budget.js`：`maxCalls / maxBytesIn / maxBytesOut / maxWallTimeMs / maxCpuMs / maxConcurrentCalls`。
`mountServerModules(modules, { budget })` 给每个包的 `boot` / `shutdown` / `healthz` 套上记账与上限，
给 `matchClass` / `route` handler 套上只记不改语义的计时器。

* 开关：`SP_MOD_BUDGET='{"*":{"maxCalls":1000,"maxWallTimeMs":500}}'`（读在 `budget.js` 里——
  「给包多少预算」是运维杠杆，按 `server/accountConfig.js` 的先例不进包的可见环境白名单）。
* **诚实的一条**：JS 不能抢占式打断同步代码，所以 `maxWallTimeMs` 是**事后测量 + 记账 + 拒绝下一次**，
  不是到点掐断。真正的隔离是官方 sandbox 档（子进程）的事。

## 5.5 运行时策略开关（默认全关）

`server/mod-manager/policy.js` 的 `modPolicyFromEnv()` 把三个开关收成一份策略，`server/index.js` 只调用它：

| 开关 | 效果 | 默认 |
|---|---|---|
| `SP_MOD_REQUIRE_CONSENT=1` | 宿主进程档的包需有**对本版字节的同意**才激活（否则 `SDK_NOT_CONSENTED` 具名拒） | 关 |
| `SP_MOD_STRICT_GLOBALS=1` | `server.modules` 源码扫描走**严格档**（`profile: 'module'`，含 `globalThis`） | 关（legacy） |
| `SP_MOD_BUDGET='{...}'` | 统一调用预算 | 关 |

**为什么读在 `policy.js` / `budget.js` 里，而不是 `index.js`**：`server/index.js` 与 `server/modModules.js`
在 `test/packServerSurface.test.js` 的 `SP_*` **反射名单**内（那份名单 = 包能看见的环境白名单），而
「这个服务器对包有多严」是运维杠杆，按 `server/accountConfig.js` 的先例刻意不进包的可见面。

## 6. 运行模式（Phase 8）

`buildActivationPlan({ options: { mode } })`，闭集在 `shared/sdk/sdkConstants.js` 的 `RUN_MODES`：

| 模式 | 语义 |
|---|---|
| `legacy-compatible`（**缺省**） | 两种 origin 都放行 —— 与重构前逐字节相同，**不产生任何 mode 判定** |
| `official-preferred` | 都放行，但 Forge 档**逐包告警** `SDK_LEGACY_IN_OFFICIAL_PREFERRED`（不提供跨上游兼容证明） |
| `official-only` | 只放行官方档；其余**具名**拒 `SDK_ORIGIN_NOT_ALLOWED`（进 `plan.modeRefused` 与 `excluded`） |

非法 mode 字符串**回落缺省**（绝不因为一个拼错的开关改变行为）。mode 进 `activationDigest` 的策略段
（换模式 = 换执行配置 = 换摘要），但**不进**集合摘要 `modDigest`。

## 6.5 源码扫描分档（GAP-1）

`server/modModules.js` 的 `serverModuleSourceIssues(source, packId, moduleId, { profile })`：

| profile | 禁止表 |
|---|---|
| `legacy`（缺省，旧行为） | `process` / `require` / `eval` / `new Function`（`globalThis` **保留**豁免，见文件头理由） |
| `module` / `sandbox`（官方档） | 上表 **+ `globalThis`**（`MODULE_FORBIDDEN_GLOBALS_STRICT`） |

`globalThis` 的豁免是**实测出来的**（仓库里已有合法的 `server.modules` fixture 用它通信），
所以处置是**分档**而不是一刀切。`loadServerModules(..., { profile })` 传递档位，缺省 `legacy`。

## 7. 未完成（诚实清单）

* **SES 沙箱没有接线**（唯一的功能性缺口）：`server/mod-manager/sandbox.js` 的 `createSandboxRunner` 实现完整
  （fork + watchdog + 预算 + restart，实测 `while(true)` 被超时杀掉而宿主不受影响），但**生产零调用**。
  于是 `class: 'script'`（profile `sandbox`）在装载门被**具名拒载**（见 §1.2）——这是**有意的**：宁可拒，
  也不把声明隔离的代码放进宿主进程。要真沙箱需要引入 `ses`/`acorn` 并重生成 `package-lock.json`，
  这一步必须在能跑 `npm install` 的环境（CI / 维护者机器）里做，本机无法验证。
* **上游协议面的 `cs` / `room.setPlugins` / `room.consent` / `room.contentReady` 未复制**：Forge 已有等价且
  更早的房间级闸门（`modSet.digest` + `checkModSet` + 本节 §1.5 的 `roomSubset`）。再补一套就是
  「同一个问题回答两遍」——本仓库反复判死刑的形状。真要逐字对齐上游那是**替换**（服务端+客户端协议核心），
  不能在本机验证，属于独立一轮。
* **`forgeImport` 反向互操作**（上游 `server/plugins/forgeImport.js` 把 Forge 包转成官方插件）**未做**：
  本仓的方向是「官方 manifest 只作为输入格式」（§1.1/§1.4），与上游的转换方向相反；两边同时存在会是
  两条互逆的转换链，容易产生「同一份字节、两个身份」。
* **`assets` / `theme` 叠加进渲染树未做**：官方 manifest 的 `assets`/`theme` 目前只参与能力派生与摘要，
  没有并入 `workshopAssets` / `workshopTheme` 的产物。

## 7.1 已落地（本轮之前/本轮）

* **官方档 `sp:sdk@1`**：manifest 适配器、**装载器**、module 运行时、sandbox 运行时（已实现，未接线，见 §7）都已落地。
  **已接线**：`server/index.js` 在启动流水线里装载 `plugins/`、建立官方 `ActivationPlan`（`srv.officialPlan`）、
  把它的 excluded 并进**同一份** `excludePacks` 交给数据层；官方插件的**声明式内容**由此并进 `server/data.js`
  的叠加层（`test/modOfficialOverlay.test.js` 直验：目录不存在 ⇒ 逐字节不变）。
  **一致性（Phase 7 收口）**：官方插件**进进程级 mod 集合** —— 它们的 `meta`/`battle` 会改对局结果，
  所以身份必须被**房间摘要闸门**覆盖。随之而来的三件配套都已落地：
  ① 描述符**按能力推出 `layer`**：服务端载荷 ⇒ `B`，否则有客户端面板 ⇒ `C`，再否则 `A`（`isModEntry` 要求它）；
     **客户端 UI 面板**（C 档）也已落地：官方 manifest 的 `panels: [{ id, slot, module, messages?, styles? }]`，
     槽位走引擎**同一张**闭枚举 `CLIENT_PANEL_SLOTS`、URL 走**同一条** `/workshop-panels/<包>/<模块>` 约定，
     于是 `welcome.modPanels`、投递表、以及 Lobby 从面板推出来的 `packChannels`（`pack.msg` 的「收不收」）
     **一行都不用改**（`test/modOfficialPanels.test.js` 直验投递表指到插件里的真实文件、坏面板只丢那一个并点名）；
  ② `server/mod-manager/officialCatalog.js` 产出与 `buildModCatalog` **逐字同形**的客户端目录，
     `test/modOfficialCatalog.test.js` 直接断言那条不变量 —— **客户端用同一个算法能重建出发布的 `hash`**；
  ③ 目录与 `/mods/file/<包>/<路径>` 和 Forge 的并成**一份**（同 id 不静默覆盖，点名丢弃），
     所以**客户端一行都不用改**，下载与对齐走的就是既有那条链。
* **官方 module 运行时**（进程内）已落地：`server/mod-manager/officialHost.js` —— **只注入声明过的 capability**
  （碰没声明的那个**抛** `PLUGIN_USE_UNDECLARED`，不是 undefined）、**严格档源码扫描在 import 之前**（含
  `globalThis`）、战斗类能力（`meta`/`battle`/`room`）在这一层**具名拒**（本轮起 `meta`/`battle` 已由桥重放，见下）、
  `storage` 限本插件目录、`routes` 限
  `/mod/<插件id>/`。装出来的模块与 Forge 档**共用同一个** `mountServerModules`（boot/shutdown/healthz/route）。
* **官方 sandbox 运行时**（子进程 / watchdog 的真实隔离）已落地：`server/mod-manager/sandbox.js` +
  `sandboxRuntime.js` —— 严格档扫描**在 fork 之前**（被拒的插件连子进程都不起）、每次调用有墙钟超时
  （超时 ⇒ `SANDBOX_TIMEOUT` + **杀进程**）、崩溃可 `restart()`、记账复用同一份 `budget.js`。
  实测证据：一个 `while(true)` 的 handler 被超时杀掉而**宿主不受影响**。未做：跨进程 storage 回写、lane/WSS 隧道、
  多插件共享一个子进程。
* **Phase 7 第一项 —— 官方 `room` 面**已落地**运行时侧**：`officialHost.js` 的 `host.room.on(event, fn)`，
  事件名走 Forge 档同一张闭集 `ROOM_HOOK_EVENTS`（8 个），**只读观察**（返回值丢弃）、**不要求 `combat`**；
  注册落在 `mounted.room`；**已接线**：`server/index.js` 装载官方 module（喂进计划、只把**激活**的交给大厅）→
  `server/lobby.js` 用 `officialRoomInstallers` 把它的房间钩子并进**同一条** `createRoomHooks` 总线
  （没官方插件时展开的是空数组 ⇒ 逐元素相同；桥用**真总线**验过：`test/modOfficialRoomBridge.test.js`）。
  `meta` / `battle` **也已落地并接线**（见下），不再被拒。
* **官方 `meta` / `battle`**（Phase 7 的高风险那一格）已落地**运行时 + 接线**：
  * 宿主面 `host.meta.register(key, handler)` 与 `host.battle.install(fn)`，**都要求 `combat: true`**（形状层判）；
  * 声明 `meta` 的 manifest **必须**给 `metaRegisters`（白名单，与 Forge 档 `server.json.server.meta.registers` 同义：
    「没声明就等于不许」）；
  * **确定性那条线**：声明 `meta`/`battle` 的插件，源码扫描在严格档之外**再并上 kit 那张表**
    （`Math.random` / `Date.now` / `setTimeout` …），与 `server/battlePack.js` / `server/match/metaPack.js` 同一张表、同一个扫描器；
  * 两个桥 `officialMetaModules()` / `officialBattleInstallers()` 把装载期登记**重放成引擎本来就在用的那两个形状**
    （`registerMeta(registry)` / `install(battle)`）—— 不新造语义，于是官方插件走进**同一条**装配路径、
    同一份逐包 try/catch 隔离、**同一份房间摘要闸门与受限注册表白名单**
    （`test/modOfficialCombat.test.js` 用**真的** `buildRoomRegistry` 验过：声明过的键注册成功、没声明的键被点名拒并逐包回滚）；
  * **投递面已补齐**：`officialBattleModules()` 产出与 Forge 档 `battleModules` 同形的条目，URL 走**同一条**约定
    `/workshop-battle/<包id>/<入口>`（常量取自 `server/http/static.js`，两边不可能各写一套），只是根目录是 `plugins/`；
    `server/index.js` 把它与 Forge 那张表并成**一张**「URL → 磁盘文件」表（键冲突**不静默覆盖**，点名告警）。
    客户端因此能加载**同一段代码**，与服务端复算一致 —— `test/modOfficialCombat.test.js` 直验投递表指到真实文件、
    且越界路径解不出来。
* **协议适配层**（Phase 5）已落地**骨架**：`server/mod-manager/eventRouter.js`（进站消息分流成
  `room.mod.handshake` / `resource.admission` / `sdk.intercept` / `pack.msg` / `plain`，按固定顺序派发、
  钩子抛异常只记日志不吞后面的）+ `server/mod-manager/admission.js`（集合摘要准入 / 单包准入 / 房间子集）。
  **已接线**：`server/modDispatch.js` 的钩子总线改由 `eventRouter` 派发（固定顺序 = 包 id 次序、`=== true`
  短接、抛错只记日志不吞后面的）—— 与它从前的内联循环**逐条等价**，`test/modDispatchRouter.test.js` 钉住；
  `server/net.js` 因此**一个字未动**（它照旧调 `opts.preDispatch`，而那个函数现在就是路由器）。
  分类结果（`kind` / `type`）已随 `ctx` 传到钩子面前，供将来的适配器按种类过滤。
* **Phase 3 声明式内容合并**已落地**核心**：`server/mod-manager/content.js` —— `mergeDeclarativeContent`
  （对象表并集 / 数组表追加按 id 去重 / **同 id 由第二个来源再给一次 ⇒ 具名冲突、先到者胜** / 形状不认识即冲突 /
  输入不被就地改写 / `overrides` 白名单才允许替换）+ `collectOfficialContent`（读插件目录里的表文件，读不到或
  坏 JSON **具名记错且不贡献**）。**已接线**：`server/data.js` 的官方块把它并进叠加层（`pluginsDir` 默认
  `plugins/`，不存在即逐字节不变；`excludePacks` 对它同样生效）。
* **`server/lobby.js` 的分散判定**：`packChannels`（客户端可发通道）与 `serverChannels`（可投递进对局的通道）
  已收敛成 `server/mod-manager/derive.js` 的**纯函数** —— 语义由 `test/modDerive.test.js` 对着**重构前的就地实现**
  逐项钉住，构造器里不再有第二份实现。**仍未收敛**：`modSet`（wire 形状，改动面大）与**每房间**的过滤
  （`roomPack` / `meta` / `battle` 按 `room.modSet` 选子集 —— 那是房间级的合法判断，不是进程级的「包在不在」）。
* **`globalThis` 的完整移除**：只在官方档严格档生效；Forge legacy 保留（合法 fixture 仍用它）。
