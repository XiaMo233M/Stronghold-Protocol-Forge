# mod-xie · 促融共竞（协同共竞）— Forge 工坊包 v2

《卫戍协议：盟约》非官方同人复刻的**合作经济玩法 + 救援**，以**标准工坊包**形式装进
[Stronghold-Protocol-Forge](../../)（Forge 管理器）的 Mod 层 —— 需要带 DESIGN §28.23 的版本（见下「要求」）：

- **服务端**：一个 `server.modules` 模块把自己挂成 `MatchClass` 包装器（DESIGN §28.14），并在声明过的
  **包通道**上接收玩家的操作（DESIGN §28.23，`Match.handlePackMsg`）；
- **客户端**：`client.panels[]` 的一个面板（`screen.game.hud`）画经济条 / 借还牌 / 救援牌，
  状态读引擎推来的 `m.public` / `m.private`（本包在视图里加的 `econ` 键），动作走 `pack.msg`；
- **启停**：建房时勾选本包（`room.create.modIds`）⇒ 这一局跑促融共竞规则（W-B）；普通房间**逐字节不变**
  （每个覆写先看 `this.mods`）。两端对齐由管理器负责（W-D）。

与 v1（`feat/mod-xie`，自研安装器 + `boot.template.mjs` 猴补丁）相比：**没有安装器、没有锚点清单、没有
`public/index.html` 注入、没有自加协议类型、不改任何引擎文件**。包的身份 = 内容哈希。

## 装法

```bash
# 「安装」就是把包目录放进 workshop/（目录名必须等于 pack.json 的 id）
cp -r mod-xie <管理器树>/workshop/mod-xie
# 或打成一个 zip 交给别人：node tools/workshop-pack.mjs export …（包根 = 本目录）
```

重启服务器即可（进程级装载，无热重载 —— DESIGN §28.11）。建房时在模组列表里勾选「促融共竞」。

**要求管理器带 DESIGN §28.23**：本分支（`feat/modxie-pack`，基于 `feat/mod-layer-channels`）即带这一格；
上游提案见 `XiaMo233M/Stronghold-Protocol-Forge#1`（那份 PR 合并后，官方版本自带）。管理器不认识模块的
`channels` 字段时会**整包点名拒绝**（`MODULES_UNKNOWN_FIELD`）—— 这是刻意的失败姿态：一个装不上的包要响亮地
说出来，而不是静默地少一条能力。

## 通道（客户端 ↔ 对局）

| 通道 | data | 语义 |
|---|---|---|
| `borrow` | `{ to, amount }` | 向队友借调资金（受规则上限/预算/团队总额约束） |
| `answer` | `{ id, approve }` | 应答一条收到的借调请求（同意即转账并落债务） |
| `project` | `{ project }` | 购买 / 升级后勤项目（应急仓储、后勤调度） |
| `relief` | `{}` | 从团队储备取救济（每回合每人/全队有上限） |
| `revive` | `{ round, playerId }` | 结算期救援窗口内捐 LP 救人（`round` 必须与当前回合一致） |

这五条都是**命令通道**：对局处理它们并**返回 `true` = 消费** —— 平台不再把原始命令广播给全房，状态只经
`m.public` / `m.private` 视图下发（私有债务与借款请求因此不会被默认公开，也没有人会看见一条被拒绝的请求的广播）。
`from` / `seat` 由平台从会话解析，载荷里自称的身份不作数；金额 / 目标 / 回合 / 项目 id 由 `economy` / `revival`
容器逐项校验；请求 id 一次性消费、救援先认领后应用（防重）。

规则数据在 `data/rules.mjs`（每难度一组 `teamEconomy` / `revival` 覆盖块，由 v1 的 modes.json 提取）：
**官方模式记录不复制** —— 回合表 / 敌人倍率 / 商店一律用引擎的官方 `mode_multi_*`（审计 P1 的修法）。
展示文案（`transferDesc`）由同一份数字生成（审计 P2）。`data/modes.json` 是 v1 的原始模式记录，只作**提取来源**
留档（运行时**不加载**它；包里被读取的只有 `data/rules.mjs`）。
房间集合（W-B）既管投递也管转发：不在本房间集合里的包，连它通道消息的转发都没有（`Lobby.packMsg` 就点名拒绝）。

## 完成度（2026-10-10）

**已实现（机械验收见 `test/`）：** 装载验收（管理器零拒绝、通道两半边一致、包自足性）；
服务端接缝（房间自门控、规则派生、借用/应答/还债、席位包装）；审计 P2 的三条规则修正（联合采购逐玩家发放、
`projects: {}` 语义、救援成本钳制、全员无伤用本轮参与者集合）。

**PENDING（未做 / 未验证，别当已完成）：**
1. **浏览器实跑**：建房 → 借钱 → 答借 → 救济 → 项目 → 救援窗口 → 淘汰 的整条交互链没有在浏览器里走过
   （面板 `client/econ.js` 只经过装载器，不经过渲染）；样式表（`client/econ.css`）还没写。
2. **兜底利息的分红暂缺**：它需要「这一局计划出多少敌人」这个引擎读数（v1 靠 import 引擎的波次构建器），包不能
   import 引擎内部 —— `_econCoverTotal()` 返回 0，利率因此恒为 0、**分红**永不发放。**「下回合收入里还本金」的
   账本不受影响**（`coverInterest.enabled` 保持 true 是那条账本的开关，关掉它反而会静默取消还款 —— 踩过的坑）。
   要恢复分红：给管理器加一格表面，或另找等价模型。
3. **包内服务端模块必须 `.mjs`**（入口的约束传染到兄弟文件）：包里没有 `package.json`，`.js` 会被 Node 当 CJS，
   装载期报 `MODULES_IMPORT_FAILED`。浏览器面板模块仍是 `.js`（客户端那条路按 URL 抓）。
4. **引擎版本面**：装载树 = Forge 0.13.1（游戏 0.2.2，本分支）；0.2.3 / 0.2.4 未跑。
5. **v1 的其余特性**：救援窗口的完整交互、bot 借贷策略的调参复验、`economy.md` 的文档对齐 —— 逻辑已随包，
   但整体链路的真实对局验证没做。
