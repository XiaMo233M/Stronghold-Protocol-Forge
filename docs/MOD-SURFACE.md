# Mod 表面清单（pack-facing ABI）

这份文件回答一个问题：**一个工坊包（workshop pack）到底能依赖引擎的哪些东西？**

答案是**一张表**，不是一段散文：每一行是一格「表面」—— 一条 `pack.json` 声明、承载它的导出符号、实现它的引擎文件、
钉死它的测试、定义它的设计稿小节。表的机读版本是 [`shared/modSurface.js`](../shared/modSurface.js)，
守卫是 [`test/modSurface.test.js`](../test/modSurface.test.js)。

## 为什么需要它

引擎会被上游移植整段改写：`server/lobby.js`、`server/match/*`、`public/js/screens/*` 都可能在某一次移植里换掉。
中间层（工坊包这一整套契约）不能靠「没人会动它」活着 —— 一份没有被断言的契约，被一次重构顺手删掉时**没有任何
测试会红**，而作者看到的只是「装了但没反应」。

所以每一格表面都被钉住三件事：

1. **锚点符号还在**（`SERVER_MEMBERS` 里还有 `battle`、`CLIENT_PANEL_SLOTS` 还是那九个……）；
2. **实现文件与测试文件还在**；
3. **设计稿与本文档里那一节还在**。

反过来也钉：`shared/workshop.js` 里每一个「包可声明的名单」都必须被某一格表面引用 —— 于是「引擎里加了一格却没进
清单」同样会红。移植的人只要跑一次测试，就知道自己有没有把中间层落在后面。

本仓另有一份同族守卫：`test/modSurface.test.js` 的前半钉的是**就地补丁式**社区 mod 依赖的通用名（`data/backups.json`
的记录形状、`kits/shared/tier1.js` 的具名导出、`battle.refreshRange`）。那些 mod 不经过我们的校验器；工坊包经过，
但校验器只能保证「今天判得过」，保证不了「明天这一格还在」。

## 版本政策

- 这张表属于**一个 ABI 世代**：`shared/constants.js` 的 `MOD_API_VERSION`。包用 `pack.json.api` 声明它要的世代
  （`>=1 <2`、`1.x`、`^1.0.0` …），判定见 [mod-layer.md §28.5](design/mod-layer.md)。
- **加一格不抬世代**。加一格对已发布的包是纯增量；抬世代会让所有写了 `api: "1.x"` 的老包被判
  `MOD_API_INCOMPATIBLE` 而拒绝加载 —— 那是在惩罚老包。
- **删一格、改名、改语义必须抬世代**，并且必须给出迁移说明（哪一格被谁取代、老包怎么改）。冻结账本
  `MOD_SURFACE_FROZEN` 记着「每个世代必须仍然全部在场的 id」；在一个世代里悄悄拿掉一格，账本守卫就红。
- 结构性协商已经存在，且是**响的**：`pack.json` 的顶层键与 `server` 的成员都是闭集，一格这个引擎没有的表面
  不会被忽略，而是加载期**点名拒绝**（`PACK_UNKNOWN_FIELD` / `SERVER_UNKNOWN_FIELD`）。这份表补的是另一半：
  作者要知道**哪一版引擎**有这一格。

## 表面表

`层` 按 [DESIGN §28.1](design/mod-layer.md) 的三层：**A** 内容 / **B** 服务端逻辑 / **C** 客户端界面。
`requires` 是「用它还必须满足什么」—— 这一格不是白给的。

### A 层：内容

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `content` | `content[]` + `<文件>.json`（14 张表，`WORKSHOP_CONTENT_FILES`） | 记录形状照抄官方；数据不是代码，改不了对局结果 | §28.13 |
| `overrides` | `overrides[] = "<文件>:<id>"` | 覆盖官方条目必须显式声明 | §28.3 |
| `units.operators` | `operators` / `support` + `units.json` | 干员记录必须带 `UNIT_REQUIRED_FIELDS` 那几个键 | §28.10 |
| `media.voices` | `voices` / `voiceLangs` + 包内音频 | 只服务登记过的 URL | §28.13 |
| `media.icons` | `bondIcons` / `itemIcons` / `art` | 路径是包内相对路径；素材不进 git | §28.13 |
| `notices` | `notices = { 栏目: 文本 }` | 纯文本，结构化但不执行 | §28.15 |
| `i18n` | `i18n = { 语言码: 包内 .json }` | 文件名必须是语言码 | §28.13 |

### B 层：服务端逻辑

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `server.preDispatch` | `server.preDispatch = { module, policy, intercepts }` | `intercepts` 必须是 `shared/protocol.js` C2S 里的类型名 | §28.13 |
| `server.meta` | `server.meta = { module, registers }` | `registers` 的每一类都要有对应键 | §28.13 |
| `server.modules` | `server.modules = { module, uses[] }` | 只用 `SERVER_MODULE_USES` 里的钩子；源码过静态确定性扫描 | §28.14 |
| `server.battle` | `server.battle = { module }` | `combat: true`；两端跑同一段字节；只能 import `@battle/` 与 `@sim/` | §28.17 |
| `server.room` | `server.room = { module }` | **不**要 `combat: true`：只读观察面（快照/访问器/订阅），返回值被忽略 ⇒ 改不了谁在玩、装了什么、这一局的结果；import 只走 `@sim/` | §28.20 |
| `kits.relativeImports` | `kits/<id>.js` 里的 `./…`（含 `kits/_shared.js` 这类辅助文件） | 只许**向下**相对（`..`/绝对/`%`/反斜杠/非 `.js` 仍拒）；按「出现 import 的那个文件」自己的目录解析，两端同一文件；辅助文件字节进身份哈希（`kits/**/*.js` 递归） | §28.18 |
| `routes` | `routes = [{ path, cache }]` | 路径与缓存策略都在允许集合内 | §28.13 |
| `assets` | `assets = { container, algorithm, digest, file, server }` | 装载期核对摘要；`server: serve \| cache-only` | §28.13 |

### C 层：客户端界面

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `client.panels` | `client.panels[] = { id, slot, module, order, gate }` | `slot` 必须是引擎渲染得出的宿主；用不了就点名丢掉整个面板 | §28.8 |
| `client.panels.wraps` | `client.panels[].wraps[] = { component, mode }` | `component` 必须在引擎注册表里，`mode` 是 `wrap` \| `replace`；`wrap` 每帧拿一次 vnode，`replace` 的 `orig` 是 `null`；注入面只多 `component` 与 `props`（只读深拷贝）；任一环坏了退回**它下面那一份**并点名 | §28.19 |
| `client.panels.styles` | `client.panels[].styles[]` | 只服务登记过的 URL；挂载时注入、dispose 时移除 | §28.8 |
| `client.theme` | `client.theme.vars = { --x: 值 }` | 变量名 `--` 开头；值里不许有 `; { } < >` 换行 | §28.8 |
| `client.panels.data` | `client.panels[].data[]` | 表必须在 `CLIENT_PANEL_DATA_TABLES` 里；拿到的是只读快照 | §28.8 |
| `client.panels.messages` | `client.panels[].messages[]` | 类型名由引擎定（`pack.msg`），通道名由包定；有额度与限流 | §28.8 |
| `client.requires` | `client.requires[]` | 缺一即「浏览器不支持」，不是静默不工作 | §28.13 |

### 发行

| id | 声明 | requires | 设计稿 |
|---|---|---|---|
| `mods.catalog` | 客户端 mod 目录 + 房间 `modIds` | 房间声明了集合时只有点名的包参与（W-B）；两端字节要能对齐（W-D） | §28.16 |

## 加一格表面的清单

1. `shared/workshop.js`：形状校验 + 拒绝码（点名，不静默跳过）+ 进身份哈希（能改变一端行为的字节必须进摘要）。
2. `shared/modSurface.js`：加一行，锚点写**真实导出符号**。
3. 实现文件：两端一致的那一端也要写（包声明的代码要能同时在服务端与浏览器成立）。
4. 测试：一个钉行为的测试文件，在那一行里点名。
5. `docs/design/mod-layer.md` 加一节；本文档的表加一行。
6. 跑 `node --test test/modSurface.test.js`。

## 刻意**不是**表面的东西

写在这里，是因为「不做什么」同样是这一层的设计：

- **协议类型**：包不能发明 `S2C`/`C2S` 类型。包自己的通道走 `pack.msg`，类型名由引擎定。
- **就地改动引擎文件**：`shared/protocol.js`、`shared/constants.js`、`server/lobby.js` 这类补丁式分发产物不是表面，
  是**发行工件**（社区 mod 的 `*.patch`）。要它们的**效果**，就得先在设计稿里把它变成一格表面。
- **产品功能**：野排匹配（快速匹配）、房间保留、**房内聊天与快捷短语**（docs/META.md §1.6–§1.8）都是**产品功能**，
  与 mod 层无关 —— 它们由引擎自己实现，不开放给包，也不要求任何 `pack.json` 声明。一个包要用自己的消息，走
  `client.panels[].messages` + `pack.msg`；它**不能**发明线上类型（`room.chat` / `room.quickMsg` 是引擎的）。
- **改对局结果而不声明 `combat: true`**：`server.battle` 与任何能改结果的注入都硬闸门。成绩必须可复算，
  否则「按房间选集合」与「两端对齐」都失去意义。
- **文件系统与网络**：包内的服务端代码拿不到 `fs`、`path`、`process`、`require`、`eval`。这是 §28.4 的边界，
  静态扫描与 import 白名单一起守。
