# 更新记录

**这一份 = 索引 + 最近 8 节；更早的按大版本分卷在 [`docs/changelog/`](docs/changelog/)。**

切点**由公告定，不由体积定**：`server/notices.js` 的 `engineAnnouncements` 从**本文件**生成游戏内公告 ——
它认「`## <版本> — <日期>`」的节、取**前 8 条**能展示的，所以**顶层留的节数就是公告的条数**。实测（当前解析器）：
留 1 节 → 1 条公告、留 7 节 → 7 条、**留 8 节 → 8 条**（上限就是 8）；**再往下切就静默少发公告**，
所以顶层至少要有 8 节。`0.16.0` 那一节是已发布事实，**原样留在原位、一字不改**。

---

**房间里的模组集合可以改了，solo 房也能声明它，工作坊面板多了第 10 个挂载点。** 上游游戏本体仍是 **0.2.5**；
`APP_VERSION` **未动**（本节因此**还没有**版本号与 tag —— 发版时在最上面加一行 `## <版本> — <日期>` 即可，本段
第一句就是那一条公告的摘要）。`UPSTREAM_VERSION`（`'0.2.6'`）与 `PROTOCOL_VERSION`（`2`）、`MOD_API_VERSION`（`1`）
**一个都没抬**：只新增了一条 C2S 消息与一个面板挂载点，**推送帧的形状一个字没变**（`room.state.mods` 这个键从 W-A
起就在，仍然「不声明就没有」）—— 按 `shared/constants.js` 那条口径（只有推送帧形状变了、旧页面会读错才抬），
新增一条客户端消息不在其中。**不需要 `golden:update`**（没有改游戏规则、没有动 `server/sim/`）。

### 房间内改模组集合（`room.mods`，房主）

- 新增 C2S **`room.mods { modIds }`**：房主把这一房声明的集合换成另一个（`[]` = 改回「不声明」，即这一局按服务器
  加载的全部模组跑）。此前只有建房那一次能选 —— 点错了、或者开好房才发现要跑哪几个包，唯一的办法是解散重开，
  而重开要把已经坐进来的博士全赶出去。形状与 `room.create.modIds` 逐字同形，但**必填**：缺了它，「声明空集合」与
  「消息坏了」就分不开了。
- **三道守卫，全部点名拒绝**：`NOT_HOST`（只有房主）；对局已开 ⇒ **新错误码 `MOD_SET_LOCKED`**；**任一真人座位
  已就绪** ⇒ 同一个码（那个人的客户端是按旧集合对齐完才点的准备就绪）。**AI 座位不算**：`addBot` 建出来的座位天生
  `ready: true`，而 AI 从不对齐任何字节 —— 照字面收进这条判据，房主一加 AI 队友就再也改不了集合。
- **为什么新造码而不复用 `NOT_READY`**：`NOT_READY` 说的是「还有玩家没准备好，所以开不了局」，这一格说的是
  「集合已经锁住了，改不了」—— 两句话在界面上正好相反，复用会让玩家读到一个与事实相反的理由。四个语言包都补了
  它的文案。
- **双检**：进 handler 先判一次，**真正应用之前再判一次**（借 Ave-Mujica 的设计：另一个会话可能刚刚让某个座位
  就绪、或者开了局）。今天这个 handler 是同步的，但守卫与改动之间的距离是它唯一的脆弱点。
- 改完**立刻物化**新摘要的数据面（`roomAssets.forRoom`）并广播 `room.state`；**所有真人（房主除外）退回未就绪**。
- **加入者怎么重新对齐**：客户端按新的 `mods.digest` 重跑 `planAlignment`，而且**摘要一变就先锁住准备就绪** ——
  核对出结论之前，上一份摘要的 `ok: true` **不是关于这一份集合的结论**（那一瞬间放行就是「拿旧结论点下去」）。
- UI：房间屏房主这一侧多一个「更改本房间模组」（`public/js/screens/room.js`），可选列表就是 `welcome.mods.packs`；
  入口给不给由纯函数 `canEditRoomMods` 判（与服务端守卫**同一份读法**，有真跑的判据）。

### solo 房也能声明集合，而且房主缺件时开不了局

- 建房屏的模组选择器此前**只在 co-op 出现**，而服务端从不按模式分支（`resolveRoomModSet` 建房时无条件跑），
  W-B 又让声明的集合**真的决定这一局跑什么** —— 所以 solo 房声明它是有效的，从前只是**客户端没给入口**。
  两个建房屏的守卫收成一处 `hasRoomModPicker`（一份判据，两个渲染点共用）；干净安装逐字节不变。
- solo 房主现在**也**走对齐硬门：本机缺件（或还在核对）时**「开始模拟」被挡住**，补齐即可开。理由是 solo 房没有
  第二个人的「准备就绪」能替他挡，而缺件开局之后没有任何人能拦。**非 solo 的口径一个字不改**（co-op 房主的开始
  照旧不看自己本机的对齐 —— 那是 W-D 定的开局政策，改它等于换一条开局政策）。判据本体收成 `isAlignBlocked`，
  两个门读同一份。

### 工作坊面板：第 10 个挂载点 `screen.room.aside`

- `client.panels[].slot` 的闭枚举多了 **`screen.room.aside`**（房间屏的旁栏），两侧表（`shared/workshop.js` 与
  `public/js/ui/extensions.js`）同改并由测试逐字钉住。它属于「插进**已存在**的组件」那一半：容器由房间屏自己渲染
  `[data-mod-slot]`，**不是**引擎按需创建的浮层（`MOD_PANEL_CREATED` 仍然是四个）。计数因此是
  **十个挂载点 = 四个浮层 + 六个组件宿主**。
- `PANEL_SEND_TYPES` 多了 **`room.mods`**：面板（房主侧的那种）也能发这一条。**`room.create` 依旧不在表里** ——
  面板能改对局状态的那一天，就是这一层失效的那一天。

### 测试

- `test/roomModSet.test.js` 新增 9 条：房主改集合成功（`room.state.mods` 广播、**新摘要与 `modSetOf` 一致**、
  其它真人被退回未就绪）· 非房主 `NOT_HOST` · 不在房间 `NOT_IN_ROOM` · 已开局 `MOD_SET_LOCKED`（并逐字断言
  **不是** `NOT_READY`）· 有人就绪 `MOD_SET_LOCKED`、他取消就绪后又能改 · AI 座位不锁集合 · 未知包名
  `MOD_UNKNOWN` · 同一份集合幂等（不广播）· 协议形状与 `MOD_SET_LOCKED` 的四个语言包。
- `test/client-static.test.js`：solo 建房屏拿得到选择器 · `canEditRoomMods` 六种输入 · `hostStartAlignBlocked`
  的 solo / 非 solo 两面。
- `test/modClientHosts.test.js` 与 `test/modClientPanels.test.js`：第 10 槽两侧同表、由组件渲染、**不**按需创建、
  不是可重复宿主；面板发 `room.mods` 被接受、发 `room.create` 仍被拒。
- 详细口径见 `docs/META.md` §1.9c、`docs/WORKSHOP.md` §1.9.3（槽位表与注入面）、`docs/design/network.md` §8.1。

---

> **维护规矩**：每发一版，新节写在**最上面**；顶层掉出公告窗口的那些节，**可以**移进对应的分卷
> （守卫 `test/docs-paths.test.js` 只要求「顶层仍能发满 8 条」，所以不急 —— 但顶层会一版一版变长）。
> 动顶层或分卷前先读 `test/docs-paths.test.js` 里那条守卫：**每一节只能出现在一处**。

| 卷 | 版本（新 → 旧） | 日期 | 文件 |
|---|---|---|---|
| **顶层** | 0.19.1 · 0.19.0 · 0.18.6 · 0.18.5 · 0.18.4 · 0.18.3-0.2.6 · 0.18.3-0.2.5 · 0.18.2-0.2.5 · 0.18.1-0.2.5 · 0.18.0-0.2.5 · 0.17.0-0.2.4 · 0.16.0-0.2.4 | 2026-10-12 – 2026-10-17 | 本文 |
| 0.15 | 0.15.3-0.2.4 · 0.15.2-0.2.4 · 0.15.1-0.2.4 · 0.15.0-0.2.4 | 2026-10-11 – 2026-10-12 | [docs/changelog/0.15.md](docs/changelog/0.15.md) |
| 0.14 | 0.14.0-0.2.4 · 0.14.0 | 2026-10-10 – 2026-10-11 | [docs/changelog/0.14.md](docs/changelog/0.14.md) |
| 0.13 | 0.13.1 · 0.13.0 | 2026-10-10 | [docs/changelog/0.13.md](docs/changelog/0.13.md) |
| 0.12 | 0.12.1 · 0.12.0 | 2026-10-10 | [docs/changelog/0.12.md](docs/changelog/0.12.md) |
| 0.11 | 0.11.1 · 0.11.0 | 2026-10-10 | [docs/changelog/0.11.md](docs/changelog/0.11.md) |
| 0.10 | 0.10.0 | 2026-10-09 | [docs/changelog/0.10.md](docs/changelog/0.10.md) |
| 0.9 | 0.9.4 · 0.9.3 · 0.9.2 · 0.9.1 · 0.9.0 | 2026-10-08 – 2026-10-09 | [docs/changelog/0.9.md](docs/changelog/0.9.md) |
| 0.8 | 0.8.2 · 0.8.1 · 0.8.0 | 2026-10-08 | [docs/changelog/0.8.md](docs/changelog/0.8.md) |
| 0.7 | 0.7.3 · 0.7.2 · 0.7.1 · 0.7.0 | 2026-10-08 | [docs/changelog/0.7.md](docs/changelog/0.7.md) |
| 0.6 | 0.6.4 · 0.6.3 · 0.6.2 · 0.6.1 · 0.6.0 | 2026-10-07 | [docs/changelog/0.6.md](docs/changelog/0.6.md) |
| 0.5 | 0.5.0 | 2026-10-07 | [docs/changelog/0.5.md](docs/changelog/0.5.md) |
| 0.4 | 0.4.2 · 0.4.1 · 0.4.0 | 2026-10-07 | [docs/changelog/0.4.md](docs/changelog/0.4.md) |
| 0.3 | 0.3.1 · 0.3.0 | 2026-10-06 – 2026-10-07 | [docs/changelog/0.3.md](docs/changelog/0.3.md) |
| 0.2 | 0.2.2 · 0.2.1 · 0.2.0 | 2026-10-06 – 2026-10-09 | [docs/changelog/0.2.md](docs/changelog/0.2.md) |
| 0.1 | 0.1.3 · 0.1.2 · 0.1.1 · 0.1.0 | 2026-10-02 – 2026-10-04 | [docs/changelog/0.1.md](docs/changelog/0.1.md) |

> 分卷文件**只存在于源码仓库**：玩家包里只带这一份顶层文件（`tools/package.mjs` 的 `PLAYER_DOCS` 不含
> `docs/changelog/`），所以上面那些链接在**解压出来的整合包里**是断的 —— 那 13 卷是**开发史**，玩家不需要；
> 要看就回源码仓库。

---

## 0.19.1-0.3.1 — 2026-10-19

**整包跟到上游 0.3.1。** `UPSTREAM_VERSION` 由 `'0.3.0'` 抬到 `'0.3.1'`；`APP_VERSION` **不动**
（`0.19.1`）—— 这一版只跟随上游，按 `shared/constants.js` 那条口径：只跟随上游的版本保持 `APP_VERSION`、
移动 `UPSTREAM_VERSION`。发行 tag 是 `v0.19.1-0.3.1`。`PLUGIN_API` 抬到 `{ current: 2, min: 1 }`
（旧包仍按 `min` 装得上）；`PROTOCOL_VERSION`（`2`）与 `MOD_API_VERSION`（`1`）**一个都没动** ——
推送帧的形状没变，`golden` 一个场景都没移动。

上游 0.3.0 → 0.3.1 是 **215 个提交 / 537 个文件**。下面按「玩家能看见什么」分组。

### 皮肤（docs/SKINS.md）

- 渲染层补上整块**皮肤呈现**：`skinOf` / `applyInfo` / `setMe` / `setSkins` / `refreshSkins`，以及
  boss 搭档的只读准备视图（`syncReadOnlyPrepUnits`）—— 皮肤是视图模型的一部分，换了就丢掉重建，
  正在跑的战斗不重启播放
- 设置里多了一行**「显示其他玩家的皮肤」**：关掉时**别的座位**的棋子画成干员自己的模型；
  没有主人的单位（装置、敌人）本来也没皮肤可丢。刻意的不对称：你画什么是你的选择，别人画什么是他们的
- 四个同步引擎里的第四个：`room.skins { skins }`（`ui/loadoutSync.js` 的 `installSkinsSync`）。
  与另外三个不同，它**任何相位都收** —— 外观是纯客户端的事

### 音效与素材

- 攻击 / 受击音效改成**按池引用**（上游 #680）：单位条目只记 `pools: { attack: … }`，
  音高 / 延迟 / 音量**只存一份**在 `audio.sfx.pools`（941 个池、484 个单位）
- 官方表的**大小上限与形状校验**接上（`tools/assets/cache.mjs` 的 `maxBytes` / `validate`）：
  坏表不再被当成「已经下过」永远复用；原子写换成唯一临时名 + `finally` 清理
- `data/local-assets.json` 与 `public/assets/local` 换成**上游 0.3.1 完整包**那一批（1697 条）

### 测试房间

- `welcome` 带 `testMode`；聊天、席位上限、host 迁移、观战、限流、审计在测试房间里都有独立口径
- 观战座的 `g.test` 先交给 `applyTestCommand` 再拒 —— 它要写审计并占限流格子，
  在入口直接拒会让它既不进日志也不占格子

### 战斗与装备

- **流形战斗**：attack 循环换成 combat clip，技能循环也换成它（我先前把这段当成死代码删过，已恢复）
- 装备拆卸（`unequip: "allow"`）：两条开关来源（房间规则优先，其次模块层 `behaviour`），
  「不是已装备」与「找不到」分开报；临时整备区仍是 **5 格窗口**（两处都满就 `HAND_FULL`）
- 装备位策略统一到**一个对局入口**（`matchSlotPolicy`）：`plus` 档下变形同构体不占格、
  每名干员最多一件、顶替只挑真占格的那一件
- 详情面板的 `EQUIP n/2` 与盟约链按这一页的形态档位算；「卸下」按钮只看调用方给没给 `onUnquip`

### 插件

- `PLUGIN_API` 到 **2**；工作室多两条控制台路由（`/studio/api/console/options` 与 `/console/build`），
  表面表与 `docs/PLUGIN-API.md` 跟着重生成
- `runner.js` 转出 `loadBrowserSim`（工作室控制台自己拿浏览器侧的战斗模拟器）
- 工坊：一个目录如果自己声明了 `plugin.json`，它是**插件示例**、不是坏包（静默跳过）
- 补回 `items.js` 的 `unequipAllowed`（`shared/modSurface.js` 里那一条是**工坊包声明依赖的公开面**）

### 其它

- `tools/assets/plan.mjs` 取上游 0.3.1，**并把我们 fork 的 `voiceLang` / `voiceLangs` 合回去** ——
  上游把它换成了 `VOICE_OPTIONAL_TREES`（`voiceEn` / `voiceKr` / `voiceNative`），两套并存：
  我们这套按「干员各选一套」用，上游那套按「整棵树换一套」用。默认配音仍是 `jp`（0.9.0 业主决定）
- 头像解析链的**精确键提前到后缀之前**（跟上游 `chessPortraitUrl` / `chessAvatarUrl`）
- 调配同步：休整期提交**带显式默认值**（「把某一格改回默认」必须把默认值发出去，
  只从 `entries` 里删掉那一格服务端会保留原来那份）
- 派生模组 trait 时补 `modeOnly` / `rangeExpand`（GitHub #700 的中文读数）
- `Match` 里那次多余的、无参数的 `GameData` 构造删掉（它把带 mod 层选项的那一次整个覆盖了）

### 验证

```
node --test（串行）  11178 项 · 0 失败（18 项按环境跳过：真实浏览器 / 真实网络）
npm run ci           setup / test / smoke / lint / imports / typecheck 全部 ok
npm run golden       全部场景 match（0 移动）
i18n                 2416 msgids × 4 语言 · 100 %
```

### 已知限制

- 联网的 `fetch-assets` 需要 `node --use-env-proxy` + `HTTPS_PROXY`（Node 的 `fetch` 不读系统代理）
- 本地素材提取（`tools/local-extract`）需要 Python + `UnityPy` 与本机客户端；没有客户端时
  从完整包复制 `public/assets/local` 与 `data/local-assets.json` 即可
- 8 个 `test/mod*.test.mjs` 改用 `.test.js`：仓库已声明 `type: module`，而 `npm test` 的 glob 只收 `.test.js`
  —— 它们此前**从未被执行过**

## 0.19.1 — 2026-10-17

**补完上游 0.3.0 合入时没落的一半：两个设置区块、一处既有函数的缺失赋值，外加一批测试与文档的对齐。**
`APP_VERSION` 由 `0.19.0` 抬到 `0.19.1`（`CACHE_NAME` 认这个数，旧缓存因此自然换名）。
`UPSTREAM_VERSION` 仍是 `'0.3.0'`，`PROTOCOL_VERSION`（`2`）与 `MOD_API_VERSION`（`1`）**一个都没动** ——
本版不改推送帧的形状，**不需要 `golden:update`**。发行 tag 将是 `v0.19.1-0.3.0`。

> ⚠️ **本版的修复都不在 `0.19.0` 的发行包里**（那一版对应 tag `v0.19.0-0.3.0` / `37e16197`）：
> `0.19.1` 对应新 tag —— **包与 tag 一一对应**，拿到旧包的人需要重新下载。

### 补落：`0.3.0` 合入时只落了一半的三处

这三处在合入时留在了 `*.rej` 里，**症状各不相同**，第三处最隐蔽。

- **设置「秘术师能量」**（`mysticEnergy`）：渲染侧当时已齐（`render/app.js` 的默认 `false` 与 live `setSettings`、
  `render/units.js` 的读取），而**设置侧四样全缺**（`DEFAULT_SETTINGS` 的键、`sanitizeSettings` 的归一、
  对话框的开关、四语文案）⇒ 设置页里根本看不到这一格。本版补齐四样，逐条与本仓既有的「弹药数量」同形。
- **设置「外观插件」区块**（`CosmeticSection`）：整个区块没搬进来，而 `plugins-client:437` 要它。
  ⚠️ 这**不是依赖缺失** —— 该函数用到的 14 个符号本仓 14 个都在（3 个已 import、11 个只是没 import）；
  本体照上游逐字补入，并按上游次序挂在「快捷键」与「诊断」之间。
- ⭐ **`lastBgmKey` 的两处赋值**：`refreshBgm()` 与 `main.js` 的订阅、注释**都在**，
  **只有 `lastBgmKey` 的初始化与赋值缺了** ⇒ 那个条件恒假 ⇒ **清单在音乐下面变了也从不重切曲目**。
  ⚠️ 症状是「房间套到达后音乐不换」，很容易被当成「设计如此」而不是 bug。本版补上那两行。

### i18n

- 上述两处共补 **6 个 msgid × 4 语种**（阶段1 两键、阶段2 四键），逐字取上游成品。
  `node tools/i18n.mjs check --all --strict` → 四语 **2101/2101 = 100 %**，`0 missing / 0 errors`。
  ⚠️ 新增的 6 键里，「本服务器安装了 {n} 个插件」**代码里没有 `t()` 调用**（只有 4 处注释提到它，
  上游亦然）⇒ i18n 工具按「代码实际引用的 msgid」计数，**不计**这一条 ⇒ 总数是 **2101** 而不是 2102。

### 测试与文档对齐（不改运行行为）

- `runner.js` 的 `SIM_DATA_FILES` 改成从 `simLoader.js` **re-export**，去掉重复定义（两份内容逐字节相同、
  且没有任何外部代码从 `runner.js` 导入它）。
- `raid-body-window`：解码 `bodyKeys()` 改用引擎的 `COLS`（`GEO.CANVAS_COLS` = 33）；
  原先硬编码 21（那是 `flatStage` 的场景宽度）⇒ 同一个 15 格矩形被解成三段互不连通的格。
- `studio/trial`：不再断言 Node 的 `child.killed` —— Windows 上 `taskkill /T /F` 已经杀干净，
  那个内部标志恒为 `false`；改成验「进程真的没了（`process.kill(pid, 0)` → ESRCH）」+「额度回到 0」。
- `plugins/ui`：只对**真正的意图键**断言（`isIntentType` 自己分类，不硬编码名单），
  并反向断言「C2S 里确实还有非对局消息」。
- `plugins-audio`：mock 照**真实服务器**行为造（`/media/…` 404 带 `Content-Type: text/html`）；
  语音回落那条改用「失败被报告 + 不播放」，并把「插件语音素材坏了就听不到」这个缺口记档（见下）。
  另补落 `lastBgmKey`（见上）。
- `packServerSurface`：把「包可见白名单」（4 个 `SP_*`）与「引擎私有」（`SP_CSP` / `SP_MATCH_HOST` /
  `SP_PLUGIN_SCRIPTS`）拆成两份归类，并断言引擎读到的等于两者之并、且互不相交。
- `modI18n` / `modPluginPackDelivery`：插件包补丁与我们的重叠由 4 条变 6 条（`数值` / `正在读取…` 是
  `b13d80b6` 之后引擎自带的）⇒ 新增 74 − 6 = **68**；`en` 的冲突表多一条 `数值`。
- `.gitignore`：补 5 条**锚定**条目（`/node_modules` `/public/vendor` `/public/assets` `/public/fonts` `/.cache`），
  让「worktree 用符号链接共享这些目录」的形态也被忽略。
- `formNames.js`：用生成器重跑（补上 `enemy_9011_acrefr`）。
- 相机：`issue602` 用 **prep 带**（`r0 = GEO.HAND_ROW`）而不是普通带；`bigmap-client` 记录
  **D29 之后 prep 与 pen 共用同一条带**（上游 0.3.0 同形），并加反向断言防回退。
- 文档：`promptCitations` 抓到的 **30 处行号漂移 + 4 处成员引用不符** 全部对齐到真正含该成员的那一行。

### ⚠️ `cs` 会随 `APP_VERSION` 变（知情项）

- `server/plugins/identity.js` 的 `computeVanillaContent` 把 `app` 放进 `contentHashOf({ app, sim, data, … })`，
  而 `shared/plugins/identity.js` 的 `contentHashInput` 明确含 `app: String(app)`。
  ⇒ **换版即换内容集身份 `cs`**，与 `CACHE_NAME` 同一思路，属设计而非缺陷；换版后首次会全部重算。
- ⚠️ **诚实局限**：这一点只核到 identity 那条链
  （`server/plugins/identity.js:121` → `shared/plugins/identity.js:96`），
  **未做全仓验证「抬版本是否影响持久化数据」**。

### 已知问题（未在本版处理）

- **插件语音素材坏了 ⇒ 该槽没有声音**：`voice` 的 `fallback` 语义是「所选配音语言缺这句 ⇒ 用默认配音同名的文件」
  （上游 0.3.0 的 `voiceLine` 逐字同义），**不覆盖「插件素材坏了」**；`bgm` / `sfx` 走 `mediaUrl` 回落、
  `voice` 不走，**上游亦然**。要不要补「插件坏了回落到安装版」作为一个独立特性，待定
  （副作用：回落会掩盖插件作者的错误 ⇒ 需「能播 + 仍有 `onFailed` 报告」）。
- **打包白名单不含作者资源**（`plugin-package` ×3 / `update-package` / `plugins/registry:296`）：
  改的是发行包内容，需单独拍板。
- **82 个 `*.rej` 里 30 个对应补丁仍未落**（实测：已落 12 · 部分落 37 · **未落 30** · 无可判行 3；
  基准 `18389f88`。本版之后 `lastBgmKey` / `officialFx` / `.gitignore` 等已落，当前工作区是 29 ⇒
  以「未落」计数落在 29–30 之间，随每笔补落递减）。
  且**已发布的 `0.19.0` 包里带着 62 个**：那是 `scripts/make-windows-bundle.mjs:78` 的
  `SKIP_TRACKED = ['test/']` —— 打包**复制全部 git 跟踪文件、只略过 `test/`**，
  所以 82 个里 `test/` 之外的 **62** 个跟着进了包。
  ⚠️ **不是 npm 白名单**（`isPlayerFile` 只判 38 个）—— 两个口径不同，别混。
- ⚠️ **一条时序型 flaky**：`test/ui/plugins-content.test.js:372`
  「a content set still loading when the b.start comes (a reconnect): the authority once it is there」
  —— 失败形态是 `TypeError: Cannot read properties of undefined (reading 'authoritative')`（`:380`）；
  实测单独重跑 3 次 **1 红 2 绿**，且 `run6`（本版之前）就已记录 ⇒ **非本版引入**，待单独修。
  ⚠️ 本版**没有**动它（单独改它属「为变绿而动测试」，不在本轮范围）—— **记档，不是忽略**。

---

## 0.19.0 — 2026-10-16

**上游游戏本体从 0.2.6 抬到 0.3.0：插件系统与官方战斗特效两套能力整份进来，节号随之与上游永久分叉。**
`APP_VERSION` 由 `0.18.6` 抬到 `0.19.0`（`CACHE_NAME` 认这个数，旧缓存因此自然换名）。
`UPSTREAM_VERSION` 由 `'0.2.6'` 抬到 `'0.3.0'`（`docs/history/0.3.0.md` 随之落地，见下）。
`PROTOCOL_VERSION`（`2`）与 `MOD_API_VERSION`（`1`）**一个都没动** —— 本版是**新增能力与吸收下游改动**，
没有改推送帧的形状，**不需要 `golden:update`**。发行 tag 将是 `v0.19.0-0.3.0`。

### 上游 0.3.0 全份合入（`0bfe3727`）

- 上游这一版是 **909 个文件 / +119621 −9324 行**（以 `git diff` 为准）。上游更新包 `UPDATE.json` 只记一部分，
  一律以 diff 为准（与 0.18.3-0.2.6 那一节同口径）。
- **两套新能力落进本仓**：**插件系统**（上游 `§32` = 我们 **§34**）与**官方战斗特效**（上游 `§33` = 我们 **§35**）。
  前者是「一个自带入口的功能包」，后者是官方特效文件的提取格式；两份章节分别在
  [docs/history/0.3.0.md](docs/history/0.3.0.md) 与 [docs/design/vfx-format.md](docs/design/vfx-format.md)，
  索引在 [docs/DESIGN.md](docs/DESIGN.md) 的章节表。

### 节号与上游永久分叉：我们比上游大 2

- ⚠️ **我们自己的章节号是全局的，且从插入的 `§28` / `§29` 起就比上游大 2** ——
  上游 `§N` 是**我们**的 `§(N+2)`。所以上游 `§32`（插件系统）在这里是 **§34**、
  上游 `§33`（官方特效）在这里是 **§35**。**引用一律用我们的号**。
- 本版把散在代码、测试与文档里的 `§32` / `§33` 引用**逐条改号成 `§34` / `§35`**
  （带 `§` 前缀的 **310 条**账 + 裸号 **123 条**），并**新增「标题号唯一性」守卫**：
  [test/docs-paths.test.js](test/docs-paths.test.js) 断言每个 `N` / `N.M` / `N.M.K` 标题号**只有一个家**
  —— 改号最怕的是两个号撞进同一篇，这条判据就是为了让它当场红，而不是等读者发现。

### 吸收下游 fork 的四格声明面

下游分支先做了、本版吸收进来的四条（每条都有设计稿与判据）：

- **`pack.json.matchKinds`**（**§28.54**）—— 第二种对局的**声明面**，不是分派表：管理器不认玩法名，
  `host.matchKinds()` 只交出冻结的只读数据，判定住在包自己的 `matchClass` 包装器里。
- **`pack.json.client.screens[]`**（**§28.55**）—— 包可以自带整屏界面（`{ id, route, module, order?, styles?, data?, messages? }`）。
- **`server.modules[].lane`**（**§28.56**）—— 服务端模块多一种挂载点，`SERVER_MODULE_USES` 因此 **6 → 7**。
- **`server.room.hold`**（**§28.57**）—— 房间侧的新声明面。

### mod 层契约面扩大（都是实测数）

- **kit 白名单 20 → 22 条**：新开 `@sim/body.js` 与 `@sim/professions.js`；
  官方 ops kit 的 **8 条一条不少**（`@ops/` 是命名空间，准入始终按文件）。
- **`PACK_FIELDS` 37 → 38**：`pack.json` 的顶层键闭集多一格。
- **`SERVER_MODULE_USES` 6 → 7**：尾巴就是上面那条 `lane`。

### i18n：四语各补 540 条（`b13d80b6`）

- 合入漏掉的译文一次补齐：`en` / `ja` / `ko` / `zh-TW` **各 +540 条**（`b13d80b6`：4 个文件 `+2164 −4`）。
- 现在四语种各自 **2096 条 msgid，翻译 100 %**：`node tools/i18n.mjs check --all --strict` **exit 0**
  （`2096/2096`，`0 missing / 0 errors`）。
- ⭐ **并修回合入过程中从界面条目里删掉的两条**：`[撤退选中干员]` 与 `[出售选中干员]` —— 缺了它们，
  界面上会直接露原文；两条已在四个语言包里补齐。

### 合入的丢失账：新增行零丢失，被删条目曾丢 2 条、已还原

- **对新增行零丢失**：上游这一版带进来的每一行都在。
- ⚠️ **对被删条目曾丢 2 条**：合入过程中有两条既有条目被上游的删除带走了，**已还原** ——
  就是上面 i18n 那一节的那两条。**不写「零丢失」**：账要按这两个方向分开记。

### 兼容性：合入前后对照实测，未发现兼容性回归

口径是**合入前后的对照**（同一批包，改前跑一遍、改后跑一遍，比结果）：

- **线上真包闸门**（[`.github/pack-compat.mjs`](.github/pack-compat.mjs)）：我方包 `--mine-only`（34 条）⇒ `{"VALID":34}`、**exit 0**；
  全量 functional（60 条）⇒ `{"VALID":58,"NO_PACK_JSON":1,"ZIP_REFUSED":1}`、**exit 0**。
- **本机 mod 库 before/after**（**91 条共同 id**）：`class` 变化 **0** · `errors`/`warnings` 变化 **0** ·
  `firstErrorCode` 变化 **0** · `sha256` 变化 **0**。
- **官方素材派生**（`GAME_ASSET` 6 条）：**全部 `pack-clean`**，前后一字未变。

⇒ 结论按实测写：**未发现兼容性回归**（不是「零回归」——那是对未测面的断言）。

### 工具与文档

- [`.github/pack-compat.mjs`](.github/pack-compat.mjs)：把 `flagged` 的包**一起测**（此前漏测）、
  id 规则**改用引擎的 `PACK_ID_RE`**（别再在工具里抄一份）、并给 3 处 `spawnSync` 补 `windowsHide: true`
  —— 最后这条修的是**工具自身的弹窗根因**。
- [tools/package-server.mjs](tools/package-server.mjs)：**服务器轻量发行**（只有游戏运行时与 Mod API，
  不带本机素材、不带随包内容）。
- 三份新文档：[docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md)（怎么跑服务器发行）、
  [docs/UPSTREAM-PR-LEDGER.md](docs/UPSTREAM-PR-LEDGER.md)（我们发给上游的、以及回来的）、
  [docs/ENGINE-COMPAT-STARDUST-AUDIT.md](docs/ENGINE-COMPAT-STARDUST-AUDIT.md)（Forge / Stardust 兼容审计）。

### 判据与已知的既存红灯

- 版本与文档闸门（本版直接相关）：`node --test --test-concurrency=4 test/version.test.js
  test/docs-consistency.test.js test/promptBaseline.test.js test/docs-paths.test.js` ⇒
  **47 tests · 47 pass · 0 fail**（exit 0）。**golden 六族零差异**（`node tools/golden.mjs --jobs 4` ⇒
  `roster 49 · bonds 46 · fields 22 · matches 21 · standins 10 · diy 140`，**288 个场景全部 match**，exit 0）。
- 全量：`node --test --test-concurrency=4` ⇒ **10273 tests · 10181 pass · 74 fail · 18 skipped**。
- ⚠️ **那 74 条不是本版引入的**：把本版的改动整份移开、在**同一个 HEAD（`f7936199`）**上重跑，
  得到**逐条同名**的 **89 个失败用例**（同名集合完全一致，只有耗时不同）—— 也就是说这些红灯在
  0.3.0 合入时就已存在，本版既没加重也没修掉它们。**这里如实记下来，不粉饰**。
- 同类既存红灯还有 CI 的 `typecheck`：`tools/ci.mjs --only …` 的 `setup` / `smoke` / `lint` / `imports`
  四步 **ok**，`typecheck` 报 **6 个既存 TS 错**（`shared/formProjection.js` 4 个、`shared/morph.js` 2 个），
  移开本版改动后**逐条相同** ⇒ 同样是既存问题，与本版无关。

## 0.18.6 — 2026-10-14

**工坊包第一次可以「复用引擎自带的官方 ops kit」：`@ops/` 按文件开了 4 条白名单。**
`APP_VERSION` 由 `0.18.5` 抬到 `0.18.6`（`CACHE_NAME` 认这个数，旧缓存因此自然换名）。
`UPSTREAM_VERSION` 仍是 `'0.2.6'`（`docs/history/` 不动，它与上游那一半一起动）；`PROTOCOL_VERSION`（`2`）
与 `MOD_API_VERSION`（`1`）**一个都没动** —— 没有新协议消息、没有新包字段、没有改游戏规则，**不需要
`golden:update`**。发行 tag 将是 `v0.18.6-0.2.6`。

### 为什么开这 4 条

工坊包 `rimbilliton`（雷姆必拓）的 4 张棋子卡就是 4 名官方干员换皮，作者的 kit 是极薄的委派：
`import opShwaz from '@ops/op-shwaz.js'` 之后调 `opShwaz.char_340_shwaz(bb, chess)`。而 `@ops/` 此前
**不在任何白名单里**（`shared/kitImports.js` 的两个前缀只有 `@kit/` 与 `@sim/`），装载器与校验器同源地
（同一份 `kitImportIssues`）把这 4 个 kit 逐个拒掉 —— 校验器报的是 **error**（`errors = 4`），
包本身还能装，但那 4 名干员的战斗行为缺失。

- 当时唯一「不改引擎」的出路是内联，实测那条路的传递闭包是 **18 个文件 / 513 KB**：`sim/content/tokens.js`
  （召唤物注册表，107 KB）、`sim/ai.js`（索敌，58 KB）、`sim/simdata.js`、`sim/professions.js` 与
  `shared/i18n.js`（浏览器 i18n 运行时，25 KB）。
- 那不是「搬几个 helper」，是把**引擎子系统在包内冻结一份** —— 引擎日后更新它们时包仍跑旧副本，
  而且**没有任何东西会报**。

### 改了什么：4 行，不是一个前缀

- `shared/kitImports.js` 的 `KIT_IMPORT_FILES` 加四行：`@ops/op-shwaz.js` · `@ops/op-ray.js` ·
  `@ops/op-aglna2.js` · `@ops/op-thumpy.js` → `server/sim/content/kits/ops/op-*.js`。
- `KIT_IMPORT_PREFIXES` 里加了 `@ops/`，因为浏览器那张 import map 是**按前缀**生成的（`kitImportMap()`，
  `public/index.html` 同步加了 `"@ops/": "/sim/content/kits/ops/"`），而且错误文案必须能说「模块名未开放
  （前缀合法）」而不是「未知前缀」—— 否则作者看到的是「这个命名空间不存在」，真相却是「它在，只是这个文件没开」。
- **准入判据始终是那张表**：`@ops/op-siege.js`、`@ops/op-chen.js` 这类**同前缀、未列名**的文件今天仍然被拒
  —— 这正是「按文件开」与「开前缀」的分界线。
- 这 4 条**两端都不需要改写文件**，也不用把它复制进包：服务端把它窄重写成 `file:` URL 之后 import，该文件
  **自己的**相对 import（`../shared/tier1.js`、`../../../body.js`、`../../tokens.js` …）由 Node 按它的
  **真实路径**原样解析；浏览器按 import map 取 `/sim/content/kits/ops/op-shwaz.js`，它自己的 `../../../body.js`
  原样解析成 `/sim/body.js`（`/sim/` 与磁盘 `server/sim/` 同构，`server/http/static.js`）。所以
  `rewriteKitImports` 一个字都没动。

### 判据：先红后绿

- 加这四行**之前**跑 `node --test --test-name-pattern='按文件开放官方 ops kit' test/kitImports.test.js`
  得到 **4 个 failure**（失败信息就是 `@ops/op-shwaz.js 必须在 KIT_IMPORT_FILES 里…` 与 `未知前缀 "@ops/"`）。
- 加完之后 `test/kitImports.test.js` **41 pass / 0 fail**。新增的 5 条判据里，除了「表里逐条指向真实文件」
  「`@ops/` 下未列名的仍被拒且理由是『前缀合法』」「`kitImportMap()` 与 `index.html` 同源」之外，还有两条：
  **加载器口径与校验器同源**（真的让 `loadWorkshopKits` 加载一个 `import "@ops/op-shwaz.js"` 的夹具 kit，
  断言零 error），以及把**包真正调用的那个 `default` 成员**（`default.char_340_shwaz` / `char_4117_ray` /
  `char_1015_aglna2` / `char_4235_thumpy`）钉成函数 —— 这 4 个文件的具名导出很少（两个是空的），原有的
  具名导出下限对它们等于空转，所以下限必须记在 `default` 的成员上。
- 全量：`node --test --test-concurrency=2` → **8867 tests · 8862 pass · 0 fail · 5 skipped**（exit 0）。

文档：`docs/design/mod-layer.md` 新增 **§28.12.2**、`docs/WORKSHOP.md` §4.5.1 加这 4 行，
以及模组仓 `SKILL.md` / `AGENTS.md` 的白名单一节（11 → 15 条，写明 `@ops/` 是命名空间不是放行）。

### 口径数据通道（§28.51）：包可以带上自己那套口径数值

包此前只有两条路：`content` **新增记录**、`overrides` **替换官方记录**。作者要让「同一名干员在满练度下的
口径数值」也随包走时，没有通道 —— 本版加第 15 张数据表 `variants`。

- `pack.json` 写 `content:["variants"]`，包内放 `variants.json`。它是**三层闭枚举**
  `{ <轴>: { <数据文件>: { <记录 id>: <字段级补丁> } } }`：轴必须在 `pack.json.variants` 里声明过
  （`VARIANTS_UNDECLARED_AXIS`），文件必须是加载器认识的数据表（`VARIANTS_UNKNOWN_FILE`，且不许补
  `variants` 自己），补丁只能改目标记录**已有**的键（`VARIANTS_UNKNOWN_KEY`，与 `overrides` 同一套闭合世界）。
- **覆盖、不追加**：补丁只落在**已有记录**上，id 不存在时报 `VARIANTS_TARGET_MISSING` 而不是被创建 ——
  口径表**不能发明记录**。新增记录仍然只有 `content`，替换官方记录仍然只有 `overrides`。
- **只在装载期生效**：补丁在 `applyWorkshop` 里合进数据，**不接管运行时练度开关** —— 房间里点不点满练度、
  走哪条轴，仍由原有的运行时开关与 `pack.json.variants` 声明决定，本通道没有改它。
- 判据：`test/workshopVariantsData.test.js` **16 pass / 0 fail**（红 15 → 绿 16）。
- 全量：`node --test --test-concurrency=2` → **8867 tests · 8862 pass · 0 fail · 5 skipped**（exit 0）。
- 真包：对真实工坊包跑 `node tools/workshop-validate.mjs` → **0 error / 84 warning · VALID**；
  **32 条记录 / 4019 个值 / 与官方口径不一致 0**。
- 文档：`docs/design/mod-layer.md` §28.51、`docs/WORKSHOP.md` §1.20.1、`docs/MOD-SURFACE.md` 14 → 15 张表、
  `docs/prompts/README.md` +14 行；校验器与编辑器同步认这一层（`CHECK_KINDS` 与 `checkKindLabel` 加 `variants`）。

## 0.18.5 — 2026-10-14

**修掉「升级后图标 / 立绘 / 3D 场景大片空白、只能强刷」那一场：根作用域 Service Worker 一次注册变成永久劫持。**
`APP_VERSION` 由 `0.18.4` 抬到 `0.18.5` —— 抬它**就是**修复的一半：`CACHE_NAME` 认这个数，旧缓存因此自然换名。
`UPSTREAM_VERSION` 仍是 `'0.2.6'`（`docs/history/` 不动，它与上游那一半一起动）；`PROTOCOL_VERSION`（`2`）与
`MOD_API_VERSION`（`1`）**一个都没动** —— 没有新协议消息、没有新包接口面、没有改游戏规则，**不需要
`golden:update`**。发行 tag 将是 `v0.18.5-0.2.6`。

### 现象与根因（实测坐实，不是推断）

干净 profile 实测：6 条探针（盟约图、立绘、`local/scene/scene.json`、`scene.bin`、`.obj`、一个**不存在**的文件）
5×200 + 1×404，S.W.E.E.P. 屏 `<img>` **35**；手工注册 `/resource-sw.js` 之后同 6 条**全 412**（连不存在的那个也是
412）、`<img>` **0**。根因是三件事叠在一起：

- SW 只从「本地导入并逐文件校验过的字节」回答，命不中一律 **412 且绝不回源**
  （`public/js/resources/service.js`），而它管的正是 `/assets`、`/fonts`、`/media` 三棵树；
- 缓存名是**固定串** `sp-workshop-resources-v1-all`（不含版本），`activate` 只有 `skipWaiting` +
  `clients.claim`，全仓 `public/js/**` 没有任何 `caches.delete`/`unregister`；
- 服务器只在包声明 `assets` 时才发 `welcome.modAssets`，页面只在那一刻注册 —— 于是「删掉包 / 换回不声明资源包的
  发行包」之后，页面不再注册，**老 SW 却还控制着页面**。

结果就是「一次注册 = 永久劫持」，只有强刷 / 清站点数据能解除（与业主口径完全吻合）。未带 `~hash` 的 `/assets/**`
吃一天长缓存，是同一场里浏览器那一半的推手。

### 三道闸

1. **缓存名带版本 + 激活清旧**：`CACHE_NAME = sp-workshop-resources-v1-<APP_VERSION>-all`；`activate` 删掉本引擎
   家族里**不是当前名字**的缓存（`common.js staleCacheNames`：别人的缓存与当前那个都不动 —— 当前那个装着玩家本地
   导入的几百 MB，删了他没有任何办法拿回来）。
2. **自愈阀**：服务器这次**没有**声明 `welcome.modAssets` 而本页被一个 SW 控制着 ⇒ 页面主动注销本引擎那条注册
   并删掉它的缓存（`public/js/resources/release.js`，落点在 `main.js` 的注册点旁边）。它是**动态** import：从没装
   过 SW 的干净环境不多取一个字节，「不声明 assets ⇒ 无新请求」仍是结构性的。
3. **未带 `~hash` 的 `/assets/**` 不再吃一天长缓存**：`server/http/files.js LONG_CACHE_DIRS` 去掉 `assets`
   （改 `no-cache` + 原内容 ETag，`fonts`/`vendor` 不动；带指纹的三条路 —— 内容哈希 URL、Spine 模型组、`?v=` ——
   仍然 `immutable`）。

另修一处复现中揪出来的残留：`service.js` 在缓存**根本不存在**时不再 `caches.open()` 建一个空缓存。被注销却仍控制
着页面的那一个 SW 每答一次 412 就会把它建回来，于是「注销成功、`caches.keys()` 却永远非空、看着像装过资源包」。

### 界面：按第三方 UI 包 20261014 换新（与上面那条修复同一版发出）

`ui-package-20261014.zip`（`MANIFEST.basedOn = 0.2.6`，34 条目）按它自己的 `AGENTS.md` 装上。**口径：包版作底，我们的增量追加在末尾。**

- **整份替换 5 个**：`screens/{lobby.js,lobby.css,room.js,loadout.js,loadout.css}` —— 替换**前**先把我们相对 `ui-hub-package-20261013` 的本地改动逐条移植进包版（不是替换后再补）。**包版那两个我们服务器没有的闸门**（`match.queue`、`room.setMaxSeats`）因此自动隐藏，能力由我们自己的入口提供。
- **新增 8 个**：`ui/{lobbyMusic,screenFit,seatArt,trophies}.js`、`compat/ui/{achievements,friends,namecards}.js`（垫片**只在目标没有同名模块时装**；目标已有的 7 个一律不覆盖）、`test/ui/sweep.test.js`。
- **三个 patch feature 照 `tools/patches.mjs` 的规则手工落**（该工具本身**不执行**，`install.mjs` 同样不执行）：`settings.js` 两处锚点（异形屏适配段）· `devices.css` 末尾追加 `patches/devices-screenfit.css` · `fieldHost.js` 6 处必需锚点（唯一可选锚点不在 ⇒ 按 optional 语义跳过）· `audio.js` 的 `playBgm` 两处 BGM 钩子；`roundNumber` 在无 `gtop` 顶栏的部署上记 `n/a`。
- **CSS 方向**：包版 `lobby.css`（1013→1014 涨 38,958 B）是底，我们那 50 行增量追加到**它的末尾**（`AGENTS.md:70`）。另外把包版新的 `font-size` 全部接上四档文字大小（150 处 `max(<n>rem, <m>px)` / 裸 `<n>rem` → `calc(<n> * var(--t))`，与引擎头同一形状），并按 `test/client-static.test.js` 的契约补 9 处 `color-mix()` 前置回退与 `-webkit-backdrop-filter` 孪生。
- **移植回我们独有的七项**：座席上限滑杆（`room.setSeatCap`）· 快速匹配（`room.queue`/`room.dequeue`）· 房间模组回显 · 助战 · 聊天 · 添加/移除 AI 队友（`room.addBot`/`room.removeBot`）· i18n 包装（新增 50 条 msgid，四个语言包 100%）。
- **协议一字未动**：没有新消息，`PROTOCOL_VERSION`（`2`）与 `MOD_API_VERSION`（`1`）都不动 ⇒ 同样**不需要 `golden:update`**。
- **一处判据收窄（只收窄，不放松）**：`test/ui/text-scale.test.js` 原断言「`--t` 只在 `theme.css` 里定义」。包版在 `screens/lobby.css` 的 `.ach__box`（成就统计面板）**子树内**钉了 `--t: 1rem`（包作者的注释：文字大小放大后徽标与模式表会重叠）⇒ 改为**只禁止 `:root`/`html`/`body` 级定义**。守的行为不变：全局文字根仍只由 `theme.css` 的四档决定。红→绿两次输出：改前红（`public/css/screens/lobby.css: --t is defined in theme.css only`），改后 10/10 绿。

### 判据

- **本版界面换新的判据**：`test/ui/**` `tests 846 / pass 842 / fail 0 / skipped 4`。**逐项真点**（headless Edge + CDP，对着主树）：座席滑杆拖到 8 ⇒ 建房 ⇒ WS `room.state` 里 `"seatCap":8` + 房内 **8 张席位卡**；快速匹配 ⇒ 等待面板出现（`1/4`）⇒ 取消 ⇒ 面板消失，WS 依次 `room.queued waiting` / `cancelled`；添加 AI 队友 ⇒ `room.state` 中出现 `{"name":"AI·华法琳","isBot":true}` 的席位 ⇒ 移除后该席位回到 `null`；助战 / 聊天（真发一条 ⇒ `chat.msg` 回显）/ S.W.E.E.P. 三页签 / 干员调配 112 张卡各自打开确有其物。**四视口**（1280/1536/1600/1920）console 错误 **0**、未捕获异常 **0**、HTTP ≥ 400 **0**；`.hub-stage` 三栏、座席滑杆 458/550/573/688 px，与改前**逐像素相同**。**房间模组回显本机看不到**：那台服务器没有声明任何工坊包（`welcome.mods.packs` 为空），`RoomModsPanel` 按设计不渲染 —— 行为由 `roomModIndependence` / `roomModSet` / `modAlign` 三条判据钉住。
- 新判据 **6 条**（`test/modAssets.test.js:977` 的 describe 5 条 + `test/asset-index.test.js:285` 1 条），并就地翻转
  3 处同族断言（`test/asset-index.test.js:276`、`:315`、`test/lobby.test.js:277`）。**带牙证明**：对着 `HEAD` 的旧
  源逐条核对 ⇒ **6/6 红**；改后 ⇒ **6/6 绿**。改前真跑（`node --test test/modAssets.test.js test/asset-index.test.js
  test/lobby.test.js`）`tests 88 / pass 83 / fail 5`，改后 `tests 143 / suites 27 / pass 143 / fail 0`。
- `node --test --test-concurrency=2`（全量，**本版最终**，含界面换新新增的 17 条判据）：`tests 8841 / suites 917 /
  pass 8835 / fail 1 / cancelled 0 / skipped 5`。那一条失败是 `test/package.test.js`「真实跟踪树」：新文件
  （`public/js/resources/release.js`，以及本版界面换新的 7 个 UI 模块与 `test/ui/sweep.test.js`）当时**未被
  跟踪**（`plan()` 读 `git ls-files`），提交后自绿（`isPlayerFile()` 实测为 `true`，`resolveSpecifier()` 也对得上）。
  与 0.18.4 记的冻结树 8816/8811 的差额里，**+6 是本次新判据**（`git show HEAD:` 逐文件计数：modAssets 53→58、
  asset-index 13→14、lobby 72→72），另 +2 来自 0.18.4 之后、本次改动之外的提交，未逐条归因。
- **真实浏览器复现**（headless Edge + CDP，直接对着主树，不是包版）：干净 **200×5+404 / img 35** → 注册 SW 后
  reload **412×6 / img 0**（与改前基线逐字相同）→ 自愈阀在同一页的欢迎那一刻落地（`regs:[] caches:[]`，2 ms 内
  查到）→ 再 reload **200×5+404 / img 35**、`navigator.serviceWorker.controller` 变 **null**、`caches.keys()` 里
  `sp-workshop-resources-*` 消失。另测「新版本 SW 首次 activate 时缓存里摆着旧名」：`sp-workshop-resources-v1-0.18.4-all`
  与历史旧名 `sp-workshop-resources-v1-all` 两条被删，`unrelated-cache` 原样保留。

### 玩家侧应急（README 顶部同时留了一行）

升级后若图标 / 立绘 / 3D 场景空白：先按 `Ctrl+Shift+R` 强制刷新；仍然不行 ⇒ 地址栏站点设置里「清除此站点数据」
后重开页面。**已发布的 0.18.4 仍带这个 bug**，其 Release 正文另加了一条醒目提示。

## 0.18.4 — 2026-10-13

**把第三方界面包 `ui-hub-package-20261013` 按它自己的 `AGENTS.md` 完整装进引擎（业主裁定「走 C、不绕远路」），并把
我们相对上游 v0.2.6 的**全部本地改动**逐条移植进包版 —— 一件都没丢。** 这一版**只动前端界面层**：`APP_VERSION` 由
`0.18.3` 抬到 `0.18.4`；`UPSTREAM_VERSION` 仍是 `'0.2.6'`（`docs/history/` 不动，因为它与上游那一半一起动）；
`PROTOCOL_VERSION`（`2`）与 `MOD_API_VERSION`（`1`）**一个都没动** —— 没有新协议消息、没有新包接口面、没有改游戏
规则，**不需要 `golden:update`**。发行 tag 将是 `v0.18.4-0.2.6`。

### 装了什么：5 个整份替换 + 5 个新增 + 7 个兼容垫片

- `public/js/screens/{lobby,room,loadout}.js` 与 `public/css/screens/{lobby,loadout}.css` 五个文件**整份换成包版**。
  装前逐份核过包完整性：`MANIFEST.json` 的 10 个 payload 条目 sha256 **十份十对**，`compat/` 7 份、
  `compat-snippets/` 1 份、`test/` 1 份、`tools/` 2 份齐备。
- 五个新模块已是逐字节的包版：`public/js/ui/{hubBackdrop,matchFlow,protocolScene,transitions}.js` 与
  `public/js/screens/sweep.js`；`hubBackdrop.js` 保留我们自己的 i18n 接线（主题名走 `N_()`、文案走 `t()`）。
- **7 个兼容垫片**按包的 §4.1 只在目标**缺同名模块**时装：`public/js/federation.js`、
  `public/js/ui/{accounts,matchmaking,ownerName,skinPicker,skins}.js`、`shared/randomMode.js`。
- §4.2 `public/js/screens/title.js` 的 `Emblem` 补 `export`（包版大厅中央徽标复用它，函数体与调用点未动）。
- §4.3 `public/js/ui/loadoutModel.js` 追加 `compat-snippets/mergeSkins.js`（导入调配时合并皮肤选择）。

### 方向拨正：包版 CSS 是「底」，我们的是「追加」

上一版把包版 `lobby.css` 整段追加在**引擎规则之后**，于是包版的 `.lobby-body{grid-template-columns:minmax(0,1fr)}`
反过来压掉引擎的两栏（`lobby.css:359` 压 `:5`），`.section-label` 三个同 class 的高度变成 243/115/25，座席滑杆只剩
217.9px。本版按 `AGENTS.md:70` 拨正：`lobby.css` = **包版整份**（含本仓库要求的字号形状 `calc(<x> * var(--t))` 换算与
`color-mix` / `backdrop-filter` 的新旧双写回退）+ 我们自己的增量（`.seat-cap*` / `.quickmatch-*`）**追加在包版末尾**；
`loadout.css` 直接用包版（它在 `test/ui/text-scale.test.js` 的 `NOT_SCALED_FILES` 豁免里，而
`test/ui/loadout-stats.test.js` 要求那一组字号是 `max(<rem>, <px>px)`）。

### 零丢失：我们独有的东西逐条移植进包版

- **座位上限滑杆**（业主裁决 B5）：`SeatCapPicker` 进包版的 `ProtocolSelect`（选择模拟协议）创建区、
  `SeatCapSetter` 进包版的 ⚙「同盟设置」浮层；协议**仍是我们自己的 `room.setSeatCap`**（带 `code`、房主专属），
  `shared/protocol.js` 一字未动；`serverSeatMaxOf` / `seatCapRange` / `seatCapPayload` 原样导出，
  「同盟卡按本服务器上限重算 `{n}`」也一并移植（包版只画 desc，本版把被包版闲置的 points 一并画出来用 `pointParams`）。
- **快速匹配**：包版那一条走 `match.queue`（本服务器没有 ⇒ 按包自己的规则自动隐藏），我们的
  `room.queue` / `room.dequeue` / `room.queued` 版本（`QuickMatchPanel`）接回同一条创建路径，按 `HAS('room.queue')` 开。
- **本房模组**：`ModPicker` / `roomMods.buildCreatePayload` / `buildJoinPayload` / `RoomModsPanel` /
  `mods/align.js` 对齐闸（模组没就绪就不给「准备就绪」按钮）全部移植。
- **助战 / 聊天**：`SupportButton` 进大厅顶栏与房间顶栏（`test/ui/support.test.js` 钉的三处入口）；`ChatPanel` 回房间。
- **S.W.E.E.P.报告 / 大厅背景 / 难度示意图 / 转场**：包版自己就有（`SweepPlate`、`HubRadar`、`.proto-stage`、`tr-*`）。
- **外观链路**：`loadout.js` 的取图仍走 `ui/portraitChain.js`（包版比上游多两处取图点，一并接上）。
- **`prepLoadout` 客户端半**：`loadout.js` 的两处相位判据仍读 `currentLoadoutLockPhases()`，不回写死 `PHASE.INFO_CHECK`。
- **`screens/lobby.js` 的导出面**：`DEFAULT_DIFFICULTY` / `parsePlaytestParam` 继续从它转发导出 —— 包版这两个符号是
  0 处，漏了这一步 `screens/playtestLink.js` 会直接白屏（`main.js` 静态 import 它）。

### 业主需要知情的两件产品级变化

- **包版房间不再提供「添加 AI 队友」入口**：空席位现在是「邀请」与「搜寻中」，AI 补位那条路换成精确搜寻 /
  matchmaking（包版连 `fillBots: false`）。服务端的 `room.addBot` 仍在，缺的只是界面入口。我们**没有**擅自把旧按钮
  加回去（那会改包版的房间设计），报业主裁定。
- **可选件 `optional/room-card` 未装**：它**不是**我们说的「房间模组回显」（那是 `roomMods.js` / `RoomModsPanel`），
  而是**名片干员同步**（`room.card`，让队友看到彼此选的立绘）。装它要改 `shared/protocol.js` + `server/lobby.js` 并**重启**，
  与「本次不动协议」「发版由业主走流程」两条冲突，故按包 §0「由主人择时」留待裁定。

### 判据

- `node --test --test-concurrency=2`（全量一次，冻结树上）：`tests 8816 / suites 916 / pass 8811 / fail 0 / cancelled 0 / skipped 5`，用时 **739 s**。并发降到 2 之后原先那三条负载抖动（`test/lobby.test.js:575` websocket、`:593` 限流、`test/packMatchMsg.test.js:247`）**一条都不再红** ⇒ 判为全量并发下的负载抖动，不是回归；每条单独跑也全绿（`test/lobby.test.js` 73/73、`test/packMatchMsg.test.js` 47/47）。**装前基线核不到**（`_up` 里的基线发行包不带 `test/`，无法在装前树跑同一套判据）。
- `test/roomSeatCap.test.js` 三处断言按新 DOM / 被取代的文案重钉（`.seats--dense` → 包版 `.rs--big`；
  `.room-bar__opts` → ⚙ 浮层里的 `RoomOptions`；同盟卡那条被包版改写的 msgid），行为断言一条未放松。
- `node tools/i18n.mjs check --all --strict`：四包 1435/1435（新增 101 条逐条翻译、占位符逐个保留）。
- `npx eslint`：改动文件 0 error（8 个 warning 全部继承自包版自己的文件）。
- `npm run check:imports` exit 0；`npm run typecheck` 仍有 6 条既有报错（`shared/formProjection.js` / `shared/morph.js`，
  这两个文件本次一个字节未动，属装包前既有状态）。

## 0.18.3-0.2.6 — 2026-10-13

**上游底座从 0.2.5 抬到 0.2.6，并按我们自己的分批节奏把这一版整份吃完。** 上游这一版是 **93 个文件 / +5750 −254 行
/ 58 个提交**（以 `git diff v0.2.5 v0.2.6` 为准；上游更新包 `UPDATE.json` 只记 67 个文件，一律以 diff 为准）。
本仓库自己的版本仍是 **0.18.3**，发行 tag 是 **`v0.18.3-0.2.6`**；`shared/constants.js` 的 `UPSTREAM_VERSION`
由 `'0.2.5'` 抬到 `'0.2.6'`，而 `APP_VERSION`（`0.18.3`）、`PROTOCOL_VERSION`（`2`）与
`MOD_API_VERSION`（`1`）**一个都没动** —— 这一版没有改协议形状，也没有改包的接口面。

### 我们怎么吃的：四批，各自有判据

上游那一版同时动了资源、服务器、客户端渲染与文档，我们的树在这些方向上各有自己的改动，所以没有整份照搬，按四条
互不重叠的线进场，每条线都真跑判据（不是「文件在、行为是旧的」）：

- **① 美术资源批** —— 上游缺的 **114 个本地客户端文件**落进 `public/assets/local/**`，与完整资源包**逐文件同哈希**
  （1725 个文件），`data/local-assets.json` 同步更新、各战场官方场景可提取。
- **② 服务器流量层** —— 取上游新增的 `shared/assetPaths.js` 与
  `server/http/{assetIndex,assetViews,traffic}.js` 及四个测试；`index / routes / static / websocket / config /
  files / media` **留我们的骨架、接上游的能力**（流量计数、素材内容哈希、brotli、permessage-deflate 自 1 KB 起、
  `/healthz?traffic=1`）。判据：`test/{asset-index,asset-paths,traffic,ws-compression}` 全绿 + 既有全量 `fail 0`。
- **③ 客户端渲染与设置层** —— 本版正文里 §33.5–§33.11 那几件事。`render/{spine,impostor,materials}.js`、
  `render/app/tune.js`、`screens/bandDraft.js`、`ui/guide.js`、`ui/fieldHost.js`、`ui/gameLogic/phases.js`、
  `server/sim/**/op-wisdel.js`、`tools/local-extract/extract.py` 与上游**逐字节相同**，直接取；
  `render/units.js`、`board3d/{scene,layout}.js`、`ui/settings.js`、`ui/gameLogic/settings.js` 与上游 v0.2.5
  **本来就不一样**（我们有自己的 `formsFor` 形态增量通道、大地图背景缩放、逐干员配音与工坊两个开关），所以做
  **三方合并**而不是覆盖。**接线层也必须一起走**：`test/render` 的两条判据只认 0.2.6 的 `render/app.js`，而
  「落地音」需要 `audio.js deployCue`、回合开始重播需要 `screens/game.js` 接 `roundStartReplay`、
  `ui/gameLogic.js` 要转发 `deployOrder` —— 这几件在上游那一版里同属一条改动，漏一件判据就红。
  判据：`test/render` **661 条 / 0 红**、`test/ui` **843 条 / 0 红**、**六族 golden 一次没动**（roster 49 /
  bonds 46 / fields 22 / matches 20 / standins 10 / diy 140 全部 match，**没有跑 `golden:update`**）、
  全量 **8803 条 / fail 0**、`check-imports` exit 0、mod 闸门 `check-packs.mjs --engine …` exit 0。
- **④ 文档与版本次**（就是这一节所在的那一批）—— `UPSTREAM_VERSION` 抬号、本文件、`README.md`、
  `docs/DESIGN.md` 的章节表与版本段落、`docs/history/0.2.6.md`（**§33**）、`docs/prompts/*` 的基线声明，
  以及上游那几份参考文档里与本版事实有关的部分。

### 我们保留了什么、为什么

- **形态增量通道（`shared/packForms.js formsFor`）**：`render/units.js` 里三处查 `FORMS` 的地方走
  `formsFor(FORMS, spine)` 而不是直接索引 —— 这是 **§28.29** 的包层能力（包声明 `assets.modForms`，第一方优先
  合并），上游 0.2.6 把 `units.js` 整份重写了，所以这里做的是「以上游为底、把我方那三处重新贴回」。
- **工坊与大厅那一层**：`ui/{transitions,hubBackdrop,matchFlow,protocolScene}.js`、`screens/sweep.js`、
  `public/css/**`、`shared/{workshop,modSurface,enabled}.js`、`server/{lobby,modModules}.js` 本版**一个字没改**。
  0.2.6 换了客户端渲染底层，所以这一层专门做了 **「UI-B × 0.2.6 联跑」**复验：大厅 / 房间 / 编队三页
  pageerror **0**、console error **0**，五件独有功能（座位上限滑杆、快速匹配、助战入口、房间模组回显、聊天）
  逐项实测在位可用，四个导出仍在，三视口预算（1440×900 / 1366×768 / 1280×720）**全 GREEN**。
- **i18n 走管线，不照抄文件**：我们的语言包比上游多 **122 个键**，直接拿上游的 json 会把这些键整片删掉。上游本版
  新增的两条（「弹药数量」与它的说明）按 `tools/i18n.mjs` 的规矩补进四个语言包；`en` 100 % / 0 errors，
  `ja` / `ko` / `zh-TW` 各 58 条缺译是 0.2.5 起就有的既有欠账，与本版无关。
- **协议与包接口面不动**：`PROTOCOL_VERSION` 仍是 2、`MOD_API_VERSION` 仍是 1 —— 上游这一版没有改推送帧的形状，
  也没有改包能写的接口，所以按「形状变了才抬号」的规矩不抬。

### 上游这一版带来了什么

规则面只有一条（魂灵之影只落在场上的部署格，#557 / PR #558），其余全是流量、渲染与界面：静音时不下载背景音乐、
1 KB 以上的 WebSocket 消息压缩、素材地址带内容哈希长期缓存、brotli、教程图 WebP、`/healthz?traffic=1` 与诊断里的
下载量行、官方场景光照改回官方值（#549）、显示官方场景时补画装置板（#569）、最后一个未选策略的玩家不再看到可点的
「跳过」（PR #546）、每回合开始按部署顺序重播入场动画与落地音（PR #416）、设置新增「弹药数量」（PR #552，默认关）、
单位多时缓存画面裁切与残影的修正（#542）。逐条的依据、实测数字与 `[ASSUMED]` 标记写在
[docs/history/0.2.6.md](docs/history/0.2.6.md)（**§33**；上游自己那一章是它的 §31，我们的章节号是全局且已用到 §32）。

### 3D 棋盘：官方场景在本版真渲染过

第 ① 批落的官方场景本版第一次进浏览器验：`node tools/doctor.mjs` 报「本地客户端美术（可选） 1658 项，3D 棋盘
可用，**已提取各战场官方场景**」，11 个战场逐个在 headless Edge 里真渲染，**pageerror 0 / console error 0 /
HTTP≥400 0**，画面落 `_up/up026c-shots/board3d_*.png`。

### 门槛（本版实测）

`test/render` 661 条 / 660 过 / **0 失败** / 1 跳过（`RENDER_E2E=1` 门控）· `test/ui` 843 条 / 839 过 /
**0 失败** / 4 跳过 · 全量 `node --test --test-concurrency=4` **8803 条 / 8798 过 / 0 失败 / 5 跳过**（531.0 s）·
`npm run golden` exit 0（六族 **49 / 46 / 22 / 20 / 10 / 140** 全部 match，六份语料逐字节未动）·
`node tools/check-imports.mjs` exit 0（`server/sim/nodeData.js` 的 3 处 `sim-node` 是既有基线）·
mod 闸门 `tools/check-packs.mjs --engine …` exit 0（`packs/` 10 个 + `demo/` 3 个全部装上）。
牙证明（本批新加的一条判据）：把 `shared/constants.js` 的 `UPSTREAM_VERSION` 改回 `'0.2.5'` ⇒
`test/docs-paths.test.js` 当场红（`'0.2.5' !== '0.2.6'`：「UPSTREAM_VERSION 是 0.2.5，而 docs/history 里最新的是 0.2.6」）；
把 `README.md` 的「本仓库当前的底座」改回 0.2.5 ⇒ `test/promptBaseline.test.js` 红，点名 `README.md:638`
（并会给全 `:427 / :680 / :735` 与 `docs/prompts/README.md:7`、`docs/prompts/kit.md:22` 那几处）；
把 `lobby.js` 里 `seatCapRange` 的接线去掉 ⇒ `test/roomSeatCap.test.js` 红（`max: 4` 对 `max: 20`）。

---

## 0.18.3-0.2.5 — 2026-10-13

**把「创意工坊说明」真正放进四个包，并把界面里那三个真缺口补上。** 上游游戏本体仍是 **0.2.5**，发行 tag 是
`v0.18.3-0.2.5`。

### 四个包里第一次带上了「怎么做包」

业主的原话是「发布四个包，并且包含创意工坊说明」。此前四个包里**一个字都没教人做包**（包内有 238 KB 的
`docs/WORKSHOP.md`，那是**规则**，不是**入门**；而且界面里没有任何一句话指向它）。本版把入门层随包发出：

- 新增 **`docs/START-HERE.md`**（四步做一个包：复制模板 → 改三处 → 导出 → 上传；每一步都写清「输入 / 敲什么 /
  成功看到什么 / 最常见失败原因」）、**`docs/errors.md`**（错误码白话表）、
  **`docs/task-01-换个立绘.md`** 与 **`docs/task-02-加个干员.md`**。
- 新增 **`docs/my-first-pack/`**：一个**真跑过**的模板包（`pack.json` + `assets/portrait.png`，
  共 438 字节），它是 `START-HERE.md` 第 1 步要复制的那个起点。
- `tools/package.mjs` 的名单相应扩了：`PLAYER_WORKSHOP_DOCS`（上面四份）、`PLAYER_DOC_DIRS`（`docs/examples/`）、
  `PLAYER_WORKSHOP_REFS`（`WORKSHOP.md` / `STANDARD-PACK.md` / `MOD-SURFACE.md` / `EDITOR.md` —— 入门层指向它们，
  包内断链等于把读者引到 404）、以及 `workshop/README.md`。
- 包内入口两处：包根 `README-开箱即用.md`（`scripts/make-windows-bundle.mjs` 的 `bundleReadme()`）加了一节
  **「做自己的工坊包」**（三条路 + 六份文档的对照表），并打开 `workshop/` 就能看到的那一份
  `workshop/README.md` 首行加了指路。
- **同步纪律写进了文件头**：`docs/START-HERE.md` 与 Mods 仓的 `BEGINNER.md` 同源，**改一边要改另一边**。

### 界面：A1–A5 + B1（业主说过「界面没优化过就一起优化」）

- **A1** 包管理页的「说明」面板以前**一句都没提过文档**（而服务端早就把 `/docs/**.md` 只读地挂出来了）——
  现在给《五分钟上手》《错误码白话表》《换个立绘》《加个干员》《包格式全解》五个入口。
- **A2** 九个页面顶栏共用加一个 **`帮助（五分钟上手）`** 链接 —— 这是界面里第一次出现说明书入口。
- **A3** 导出按钮改成 **`导出投稿件 <包id>.zip`**，并补一句「**这个 zip 的形状就是站点要的**：`pack.json`
  直接躺在最外层，不要手工重压」。这一句消灭的是「我要不要再套一层文件夹」那个死结：仓库里讲装包（要顶层目录）
  与讲投稿（要扁平）是两份不同的文件，界面上一句话都没说过。
- **A4** `覆盖同名包（--force）` 改成 **`覆盖机器上同名的包（危险：会先删掉 workshop/<包id>/ 里已有的那一份）`**
  —— 命令行词直接上界面，作者看不出它删东西。
- **A5 新增 `editor/ui/errHints.zh.js`**：十条最常撞的错误码（`EMPTY_PACK` / `PACK_ID_COLLISION` /
  `ASSETS_NEED_LICENSE` / `PACK_ID_MISMATCH` / `PACK_UNKNOWN_FIELD` / `BAD_API_TYPE` / `ART_NEEDS_ASSETS` /
  `TRAIT_GRANT_BAD_SHAPE` / `TRAIT_GRANT_EMPTY` / `TRAIT_GRANT_UNKNOWN_BOND`）逐条给「一句人话 + 一条修法」，
  在 `pack.js`（加载器拒绝）与 `app.js`（逐记录校验）两条渲染路径上接线。**查不到就回落显示 `[CODE] 原文`，
  绝不静默** —— 引擎里有一百多条码，没进表的那些不能让作者看到一片空白（有测试钉住这条回落）。
- **A6** 「以模板新建」的副标题补上它**不是**「改官方那位」：要换官方干员的立绘 / 数值，走
  「包管理 → 覆盖官方记录」——堵住最高频的一次误操作。
- **B1 界面里第一次能按到「真引擎校验」**：包管理页新增 **`校验这个包`** 按钮与结果面板
  （装了没装 / 必须修的几条 / 只需留意的几条，每条都给码、人话、修法、引擎原文）。
- **一处订正**：Mods 仓 `README.md` 那句「在游戏的工坊界面能看到它」**与代码不符**（`public/js/screens/`
  的 24 个屏里没有工坊屏）—— 改成实况：看启动日志 `[workshop] applied <n> pack(s)` 与游戏内容变没变。

### 校验器：判据搬到 `shared/`，CLI 与界面从此是同一个函数

B1 要的是「按一下给我结论」，而那条结论必须与 `node tools/workshop-validate.mjs` **一致**。判据原先整个住在
`tools/workshop-validate.mjs` 里，而那是**维护者工具**（不在 `tools/package.mjs` 的 `PLAYER_TOOLS` 里、不随玩家包
发出）—— 编辑器服务端 import 它会当场崩。

- 判据本体搬进 **`shared/workshopValidate.mjs`**（随包发出、编辑器与游戏共用的一层）；CLI 变成薄包装
  （解析参数 → 调同一个函数 → 打文本），**规则一条都不在它里面了**。
- 新增只读端点 **`GET /api/packs/<包id>/validate`**：调同一个 `validateWorkshop`，把报告剪成「这一个包」的，
  逐条给界面渲染。**只读**：`loadWorkshop` / `loadData` 都只读文件，没有写盘分支；只认 GET；包 id 走
  `PACK_ID_RE` 挡住路径穿越。测试里核过「GET 之后磁盘上一个字节都没变」。
- **报告形状一字未改**（`--json` 的逐包 `issues`、`itemIcons` / `art` / `support` 计数、`engine`、各分层数组），
  所以原有判据一条都没动，只是**加**了一层 `checks[]`（按层打平，带 `pack` 归属）给界面用。
  收尾还加了一条**计数自检**：入账条数必须等于报告里真实存在的条数 —— 同一件事被数两遍会当场抛错，
  而不是安静地给一个翻倍的总数。

### 测试

- 新增 `test/errHints.test.js`（18 条）：十条码逐条、英文界面也有人话、**未知码必须回落原文**、
  只读端点的读 / 权限 / 路径穿越 / 与 CLI 同一结论。带牙证明：去掉端点接线 ⇒ 3 条红；让白话表永远查不到 ⇒
  2 条红；让渲染恒返回空串 ⇒ 2 条红。
- `test/workshopValidateRoutes.test.js` 那条源码级断言（「判据只此一处，不养第二份保留名单」）跟到判据**现在
  所在**的文件（`shared/workshopValidate.mjs`）—— 它钉的是那条纪律，不是某个文件名。
- `test/package.test.js` 的清单期望跟着新名单走（只改数字与路径，判据一条没弱化）。

## 0.18.2-0.2.5 — 2026-10-13

**补丁版：把从来没跑过的两套浏览器 E2E 真跑一遍，并修掉渲染套件挡住它们的那处基座缺陷。**上游游戏本体仍是
**0.2.5**，发行 tag 是 `v0.18.2-0.2.5`。

### 渲染套件的 GPU 基座（本版唯一的代码改动）

- **`test/render/{board3d,fieldview,recovery}.browser.test.js` 原先硬编码 `--use-angle=metal`** —— 那是 macOS 的
  ANGLE 后端。在 Windows 上这个名字不是一个后端，ANGLE 于是回落到 **Microsoft Basic Render Driver**（WARP，纯
  软件）；而产品自己的 `webgl2Available()`（`public/js/render/board3d/load.js`）要的是带
  `failIfMajorPerformanceCaveat` 的上下文，软件设备给不出来 ⇒ `enable3d()` 根本不会被调用 ⇒ 3D 棋盘
  `on: false` 而 `error` 为空。**38 条 board3d 判据**就是这么红的，报错原文只有一句 `3D board on ()`。
- **改法只是让基座能在本平台跑起来**：这三处启动参数改用仓库里早就有的 `gpuArgs()`（`tools/perfbench.mjs`；
  `battle-perf.browser.test.js` 一直用它，`test/perfbench.test.js` 也一直钉它）—— Windows → `d3d11`、
  macOS → `metal`、Linux 不指定。**断言一个字没动。**
- **新增基座自检**：`test/helpers/gpu.mjs` 的 `assertRealtimeGpu()` 在三套的 `before()` 里先建一个
  `failIfMajorPerformanceCaveat` 上下文并读出 `UNMASKED_RENDERER_WEBGL`；拿不到、或后端是 WARP / SwiftShader /
  llvmpipe 这类软件设备，就**当场响亮失败并点名后端**，不再留一句空 error 让人猜。`test/render/gpu-harness.test.js`
  用假 Browser 钉住这两条（5 条纯单测，不需要 GPU）。
- 实测（本机 Edge = Chromium 内核，`Edg/156.0.4314.15`）：改前同一页 `board3d.on=false, error=null, fps 59.8`；
  改后 **`on=true, calls=9, fps=200`、0 pageerror**，自检打印的后端是 `NVIDIA GeForce RTX 5070 Ti (D3D11)`。

### 两套浏览器 E2E 首次开跑，与逐条归因

- **`RENDER_E2E=1`（29 个文件）**：修基座前 **150 条 / 102 过 / 47 红**；修后 **141 过 / 8 红**（用时 613 s → 540 s）。
- **`SP_E2E=1`（48 个 `test/ui/*.e2e`）**：**231 条 / 202 过 / 28 红**（这一套不经 `gpuArgs()`，基座改动与它无关）。
- **`SIM_E2E=1`**：`test/sim/*.browser.test.js` 3 个文件全绿（`morph-bonds` 单跑 3/3）。
- **不为「全绿」背书**：这两套此前从未在任何机器上跑过（`581ed1cb` 的 commit message 就写着「两条 RENDER_E2E
  门控文件已搬但本环境未开 RENDER_E2E，未真跑」），所以它们**没有基线**。逐条归因的办法是**把同一批测试文件拿到
  上游 `v0.2.5` 的树上、同一台机器、同一套基座下再跑一遍**（上游 tag `v0.2.5` = `cf7a940`）：
  - **渲染侧落下的 8 条全部是「本就如此」**：`forms`（crawling 的 `*_02` 剪辑集）、`feedback1-forms`（`the change
    clip`、`重生: 'Die'`）、`feedback5-prisoners`（`enemy_1116_liprr warning` 的橙色集）、`held-pose`（`held final
    frame is pixel-identical to continual updates`）在上游 `v0.2.5` 上**报的是同一句断言**；`fieldview` 的两条
    4× 降频 50 fps 判据在上游同样红（`boss (3d): 49.5 fps`），本机复跑时它自己在 40.5 / 42.2 / 49.9 fps 之间来回
    翻（同一条判据这一轮过、下一轮又过 2d 那条）—— 是卡在 50 fps 门线上的**阈值抖动**，不是本仓库引入的性能回退。
  - 这五个渲染文件里，`forms` / `held-pose` / `feedback1-forms` / `feedback5-prisoners` 与上游 `v0.2.5`
    **逐字节相同**，`fieldview` 只多 0.18.1 加的那 6 行。
  - **UI 侧（SP_E2E）**：同样这 10 个文件在上游 `v0.2.5` 的树上也红 **21 条**（我们 28 条）。我们多出来的集中在
    `loadout.e2e.test.js`（10 条）：它们的 `problems` 里只有 `requestfailed: …/audio/voice/{cn,en,kr}/…  net::ERR_ABORTED`
    —— 本仓库 **0.7.1 起**的**多语言配音**（`audio.voiceLangs` + 逐干员配音，`public/js/audio.js` 的
    `voiceLinesFor` / `voiceLangOf`；该文件在 `581ed1cb^` 上就已经有这套模型，比 0.2.5 的合并早得多）会按候选配音
    取音频，浏览器把没播的那几条标成 `ERR_ABORTED`，而上游后来加的这条「页面没有任何 console / 页面 / 请求错误」
    判据只认空数组（本仓库自己的 `kitimports.e2e.test.js` 反而显式过滤 `ERR_ABORTED`，可见项目一向把它当良性）。
    这条是**两位作者的设计差异 + 从未跑过的判据**，不是本版引入的行为变化。
  - `devices.e2e.test.js`（8 条）是视口 / 触屏版式的 `deepEqual` 与两条导航 `TimeoutError`：该文件本仓库比上游多
    11 行、少 5 行（本仓库自己扩的设备矩阵），上游那次同跑也红 2 条；`text-scale` 那条只在 48 文件同跑时出现、单独
    跑 10 文件时不复现（超时类）。`community-controls` 反而是**上游红 13 条、我们红 1 条**。
  - **结论：75 条红全部有归因，没有一条能归到「本版引入的回退」** —— 本版没有改产品行为。
- 静态检查（首次逐项对基线）：`npx eslint .` → **0 errors / 218 warnings**（与基线一致）；`npx tsc --noEmit --checkJs
  -p jsconfig.json` → **6 errors**（`shared/formProjection.js` 4 条 + `shared/morph.js` 2 条，与基线逐条一致）；
  `node tools/check-imports.mjs` → **3 处**违规（`server/sim/nodeData.js` 的 `node:fs` / `node:path` / `node:url`，
  与基线一致）。

### 官方战场：两条实测事实

- **没有本机《明日方舟》客户端就提不出场景**（实测）：`node tools/setup.mjs --scenes` 退出码 0 并报「没有本机
  客户端，不能提取战场场景（贴图仍取自客户端）」；`python tools/local-extract/fetch_scenes.py` 退出码 0、
  **33/33 个包**、落盘 33 个文件 / **29,714,076 字节**；`tools/local-extract/extract.py --only scene` 退出码 2
  （`No Arknights install found`），把 `--game` 指到下载目录也只能退出码 1、**落盘 0 个文件**（日志逐条
  `dependency …arts/maps/… missing`、`mesh #10210: File cab-… not found`）—— 场景的材质与网格取自客户端。
  没有客户端时游戏照常运行，3D 棋盘用**程序化金属地块**优雅退化。
- **完整包会自动带上打包机上已提取的本地资产**（实测）：`scripts/make-windows-bundle.mjs` 里 `app/` 的**代码**
  清单来自 `git ls-files`，但 `public/{assets,fonts,vendor}` 走 `copyDir` **整目录复制**，另有一步显式收
  `data/local-assets.json`。已发布的 `v0.18.1-0.2.5` 完整包里 `app/public/assets/local/**` 实测 **1611 个文件 /
  70.3 MB**、`app/data/local-assets.json` 在位（两者都在 `.gitignore` 里）。所以**谁有客户端谁提取，他打出的完整包
  就自带官方战场**（含 `public/assets/local/scene/`）。打包脚本**未因此改动**；场景本身给完整包增加的体积仍未实测
  （本机提不出，0 个文件）。

## 0.18.1-0.2.5 — 2026-10-13

**`v0.18.0-0.2.5` 的补丁版：把那一版的资产里**没有**的三笔补齐** —— ① 池权重数据（洛洛八件加权池 + 焰尾
10/10/3）与落到上游 0.2.5 的 `test/match/pool.test.js`，外加六族 golden 里按新数据重算的 6 个 matches 场景；
② 三笔欠账（打包脚本的「工作区必须干净」守卫 · `docs/WORKSHOP.md` 的历史双编号收掉并补一条无重号守卫 ·
`docs/img/*.svg` 的陈旧与矛盾数字）；③ 两个仓库的 README 与 mods 仓库的 `SKILL.md` / `AGENTS.md` / `UPLOAD.md`
按实况更新。上游游戏本体仍是 **0.2.5**，发行 tag 是 `v0.18.1-0.2.5`。**

### 池权重数据补齐（上游 0.2.5 的 PR #497）

- **`tools/build-data.mjs` 与上游 0.2.5 逐字节一致**：`pool_equip_rockr` 由「4 件均匀」改为路标月报 #2 实测的
  8 件加权（维式重锤 10 / 战栗维式重锤 2 / 坚固维式重锤 2 / 加速维式重锤 2 / 灼燃维式重锤 2 / 有限加速器 1 /
  护盾无人机 4 / 激光发射器 4），`pool_char_pinus` 由 `45/45/10` 改为 `10/10/3`，共 4 行。
- **`data/choices.json`** 由 `node tools/build-data.mjs --offline` 重跑生成（未手改产物）：16 个池里**只有这 2 个变**。
- **`test/match/pool.test.js` 落上游 0.2.5 的版本**：单跑 **11 条真绿**（不是跳过），逐个字段真跑加权与去重路径。
- **六族 golden 里只有 `matches` 变、恰好 6 个场景移动**（`coop2-NORMAL-1-coverage-standins` · `coop2-NORMAL-3` ·
  `coop2-NORMAL-8-serverrun` · `coop3-ABYSS-5` · `coop4-ABYSS-7` · `coop4-FUNNY-6`）：**没有用 `golden:update`** ——
  在仓库外按 `goldenDocument` / `stringifyGolden` 生成六份、校验定义集与移动集合后才拷回；场景 id、`about` / `fast`
  逐字不变，UNEXPECTED 0 / PENDING 0。其余五族**逐字节未动**。

### 三笔欠账

- **打包脚本加「工作区必须干净」守卫**：`scripts/make-windows-bundle.mjs` 与 `scripts/make-update-package.mjs` 共用
  同一份实现 —— 清单来自 `git ls-files`、内容来自磁盘，工作区脏就会打出与 tag 对不上的包，所以有未提交改动就
  直接拒绝；`--allow-dirty` 是显式放行并打印风险。配套 `test/windows-bundle.test.js` 两条判据（纯函数 + 真跑一次脚本），
  `docs/DEPLOY.md` 与 `docs/WINDOWS.md` 两处说明同步。
- **`docs/WORKSHOP.md` 的历史双编号收掉**：目标引擎（`target`）那一节由 **§1.23** 改号为 **§1.26**（§1.23 归「逐格加开关」，
  CHANGELOG 与 `docs/design/mod-layer.md` 两处引文指的正是它），§1.24 里指 `FOREIGN` 的那处编号跟着改；顺带把
  两处闭集数字按实测改准（顶层键 34 → **35**，与 `PACK_FIELDS` 实测一致）。新增守卫断言「`docs/WORKSHOP.md` 无重号
  编号标题」—— 判据钉在**号**上而不是整行标题上，因为重号的两节标题文字必然不同（按整行判一条都抓不到）。
- **`docs/img/*.svg` 的 5 处陈旧 / 矛盾修正**：`cap-01-layers.svg` 的「上游 0.2.4」改为 0.2.5、「behaviour（表空）」
  改成实况的 4 格、补 `target` 与依赖 / 互斥（原来图与 README 正文直接矛盾）、「mod 仓库（25 条）」改为**条数以
  `mods/index.json` 为准**（实测 30 条）；`cap-02-pack-lifecycle.svg` 的「顶层键 32」改为**实测 35**；
  `cap-03-submission-pipeline.svg` 的「今天 3 个包」改为**实测 8**（`packs/` 目录）。三份 SVG 均过 XML 语法校验。

### 两份 README 与 mods 仓库

- **引擎仓库 `README.md`**：「Forge 现在能干什么」补四行已合入的面（特质授予盟约 §28.49 / 宿主 lane §28.44·45 /
  `target` §28.46 / 依赖与互斥 §28.48）与登记册一行（§28.47，注明编辑器未接）；「还不能做什么」把编辑器未接登记册、
  `server.modules[].channels` 不存在、没有热重载三条写明白；能力图与能力总表按实况对齐；英文节同步。
- **mods 仓库 `README.md` / `SKILL.md` / `AGENTS.md` / `UPLOAD.md`**：`trait.grantsBonds` 由「在途 / 未合入」改为
  **已可用**（§19.7，三个读取点都调同一份判据），并留下「上一版写在这里的 `trait.grantsBonds` 已经落地」的对照。

### 门槛（发布前全绿）

`node --test --test-concurrency=4` **8642 条 / 8636 通过 / 0 失败 / 6 跳过**（263.5 s，两轮一致；跳过全是 Chromium / 素材门控）·
`npm run golden` exit 0（六份语料 **49 / 46 / 22 / 20 / 10 / 140** 全部 match，只有 `matches` 的 6 个场景按上面的新数据
重算）· mod 闸门 `tools/check-packs.mjs --engine …` exit 0（`packs/` 8 个 + `demo/` 3 个全部装上）。

---
## 0.18.0-0.2.5 — 2026-10-13

**本版吃上游 0.2.5：规则面（浮游族的本体一击、受击格四舍六入五成双）、界面面（官方伤害数字默认关、盟约叠层音效）、
工具面（打包脚本、`/dev/sim-check`、场景提取）三条线一并并入；上游游戏本体升到 **0.2.5**，发行 tag 是
`v0.18.0-0.2.5`。**

### 规则（按官方，上游 0.2.5）

- **受击格改用官方四舍六入五成双**（PRTS 作战机制，PR #520）：`body.js` / `targeting.js` / `battle/queries.js` 的
  取整全走 `detmath.roundHalfEven`；被挡在场地边缘的敌人被 `FIELD_EDGE_INSET` 按在边线内侧那一格，不会因为边号是
  奇数而落到场外（`battle/spawns.js`）。
- **驭械术师的浮游改成本体一击 + 未释放浮游的附加伤害**（PR #537）：`funnelMul` 与本体倍率分离，附加实例带
  `addition, funnel` 标签并共享 `attackId`，一次天赋掷骰；`funnelBodyHits: 0` 是「只要浮游不要本体」；再部署与
  换目标立刻重置斜坡，自由移动保留（PR #536）；洛洛 S2 在目标离开攻击范围后继续锁定（PR #535）。
- **只改普攻的技能保留干员自己那一击**；要塞职业自身格也满足基础开技条件。
- **联防阿戈尔开场不再二次结算吞噬**：HP/SP 恢复推迟到全部开场效果之后，保留精确比例与小数生命。
- 自在重生后的无敌期不再被普攻或需要可选目标的自动技能锁定（#510）；谢拉格不融冰、催泪瓦斯改「造成伤害时」判定，
  含持续伤害（#489）。
- 首领配对改为**每局随机**、准备期至开战固定，隐藏首领沿用同局分组。

### 对局与经济（上游 0.2.5）

- 固定赠品不再被共享库存阻断（#488/#491/#495）；已展示的干员商店牌与奖励牌不再因随后库存耗尽而领取失败（#498）。
- 调度中心 4 级的五阶晋升奖励可以出现五阶自选（#515），自选来源是 `diyStockEntries`（本作把上游那一处与我方
  100 座变体的主池分派点 `mainPool()` 合成在一条语句上）。
- Touch 外勤医疗按本局团队权益保留：持有者淘汰或退出后不再使下一场医疗消失。
- AI 选开局策略与构筑重心时软性让开仍在场队友已经选择的阵营（#514）。

### 界面（上游 0.2.5）

- 设置新增「官方伤害数字」（默认关闭，#412）：只按 PRTS 红字规则显示红色整数，以及本该出红字却被闪避的 MISS；
  判定在 `server/sim/damage.js`，客户端只画。
- 补齐回合开始、机变、休整期和战斗中的盟约叠层提示音（#482）：`m.layer` 由服务端在**真实备战相位**发出，
  重连与结算回填不补播，同类最多一路。
- 标题画面页脚新增「项目仓库」链接；敌血条头顶高度、AI 托管遮罩、攻击后模型多挥一次（#506）等修正。

### 有意与官方不同的调整

- **萨卡兹枯朽战士 / 组长**：上游 0.2.5 把「沉默时死亡不留污染秽蚀」的理由改述成维护者的实机回忆，并写明它与
  PRTS / 游戏内文字「不可沉默」相反。**本作不采纳该改述，也不采纳它的断言** —— 理由仍是 0.2.0 起的客户端模板读法
  （battle prefab 的 `projectile_on_killed` 先查 `CheckAbnormalFlag SILENCED`），行为是**这两个键可被沉默、沉默状态
  下死亡不留污染秽蚀**（GitHub #470 拒）。钉子：`test/content/enemies_bosses.test.js` 的具名判据
  `#470 拒: …可被沉默…`，记录见 `server/sim/content/enemies/archetypes.js` 与 [history/0.2.5.md](docs/history/0.2.5.md) §32.32。
- 本作 `APP_VERSION` 保持 **`0.18.0`**（拒上游把 `APP_VERSION` 改成 `'0.2.5'`；本仓库的发行号自己的那一半），
  `UPSTREAM_VERSION` 由 `'0.2.4'` 抬到 `'0.2.5'`。

### 门槛（发布前全绿）

`node --test` **8638 条 / 8632 通过 / 0 失败 / 6 跳过**（三条支线整合后的实测；跳过全是 Chromium / 素材门控：批2 带进来的
`test/ui/bond-audio.e2e.test.js` 就是 `5 跳过` → `6 跳过` 的那一条） · `npm run golden` exit 0（六份语料 **49 / 46 / 22 / 20 / 10 / 140**
全部 match；本版重算 66 个场景，与上游两 tag 的差集逐条一致，见 §32.34）· `--twice`（第二遍倒序）identical ·
`GOLDEN_FULL=1` 9/9。

## 0.17.0-0.2.4 — 2026-10-12

**这一版把「给模组用的那些面」收成一套：`behaviour` 四格全部落地，宿主两条路径表、`pack.json.target`、mod 登记册、
跨包依赖裁决与 `trait.grantsBonds` 一并并入。** 上游游戏本体仍是 **0.2.4**，所以发行 tag 是
**`v0.17.0-0.2.4`**；`PROTOCOL_VERSION` 仍是 **2**、`MOD_API_VERSION` 仍是 **1**、`UPSTREAM_VERSION` 仍是
**`0.2.4`**。默认游戏行为**逐字节不变** ⇒ **不需要 `golden:update`**。

### `behaviour` 四格：开关表从空表变成四格（第 8 刀）

上一版（0.16.0）交的是**通道 + 守卫**本身，那一版**一个开关都没有**；这一版把四格补齐，并顺手把两处语义收进
同一份判据。

* **`shopBias`**（投稿 `b293e061b38f`）——商店装备槽**偏向已激活盟约的装备**。
* **`prepLoadout`**（投稿 `8b4e5da55c58`）——**休整期也能改技能与模组**（客户端那半也在这一版补上）。
* **`morphPairing`**（投稿 `19ea65909cf6`）——变形同构体的**配对规则**：三处读取点收成**一份判据**（原来是三处
  各写一遍，改一处漏两处）。第 7 段槽位语义在这一格落地：变形同构体**不占位**、**每名干员一件**、**第三件顶掉
  真占格的那两件**。
* **`unequip`**（投稿 `79de9ff03518`）——**装备拆卸**，也是本层第一条「开关 + 新意图」：加一个 `behaviour`
  开关会连带加一条 C2S 意图，同步点不止一处，`DESIGN §28.43.2` 把「加意图清单」写成显式全表。
* **两条门禁**把「文档说 `BEHAVIOUR_SWITCHES` 今天是一张空表」这句话与代码钉在一起 —— 那一句是**按时间叙述**，
  这一版之后它就该红，红在文档上而不是让人猜。

### 宿主 lane：两条路径表的移植（DESIGN §28.44 / §28.45）

- **§28.44 升级路径表**（PR #4）：宿主用**数据**注册 WebSocket 升级路径，同一条端口上跑第二套协议。
- **§28.45 请求路径表**（PR #5）：宿主用**数据**注册命名空间子树与方法（含 `POST`），模组自己的页面与自己的
  写入口不再靠改引擎。
- 两处「Numbering」段原先引用了本树**不存在**的 `§28.43.4`，验收补缺时一并修掉（引用指错行不会有人踩空，
  但会让人以为那一节不存在）。

### `pack.json.target`：一份清单两个宿主读得懂（DESIGN §28.46）

**`foreign` 三面接线**（移植 PR #3 收尾）：`target` 声明的是「这份包写给哪个宿主」，缺省 `forge`，`stardust`
是声明型 —— 三面（装载、登记、作者侧校验）都读同一个字段，所以**跨宿主误用不再静默通过**，而是被点名。

### mod registry 与跨包裁决（DESIGN §28.47 / §28.48）

- **§28.47 登记册**（移植 PR #3）：**装过什么 / 操作者启停过什么**落一份登记册，落点是 `SP_STATE_DIR`
  重定向的 `var/mod-registry.json`（并进 `.gitignore`：它是运行态，不是源码）。
- **§28.48 依赖 / 冲突**（移植 PR #3）：`pack.json.dependencies` / `conflicts` 在**装载期**裁决 —— 跨包的
  依赖装不上、或两个包互相冲突时，当场点名，而不是等某个玩家进游戏才发现功能少了一半。

### `trait.grantsBonds`：特质 ⇒ 盟约成员资格（DESIGN §28.49）

把「特质给出盟约成员资格」写成**数据**（纯数据叠加盟约层数），不再让每个包自己推一遍。这一刀另有 11 处
`shared/workshop.js` 引文修正：其中 1 处是本刀漂移、10 处是在**父提交上就已经指错**的旧账。

### 作者侧校验器读 `coreRouteShadow`（PR #6）

作者侧校验器原先**自己算**一遍路由遮蔽，于是「会被丢掉的 `routes` 声明」照样发 **VALID** —— 作者以为声明生效了，
游戏里没有。现在它读**服务器那一份** `coreRouteShadow`，同一份判据只有一处实现。

### 文档判据与若干修正

- 新增两条**文档判据**，把「按时间叙述」与「现在时断言」分开，避免把历史叙述误判成违规。
- `docs/prompts/kit.md` 一处 `server/sim/Battle.js:149` → `:150`、`:113` → `:114` 的引用位移重指；
  `docs/WORKSHOP.md` 加一条判据（走自选池的干员在 `data.chess` 里没有棋子是**正常形状**，别误报
  「永远进不了游戏」）；`docs/design/mod-layer.md` 修 8 处 `WORKSHOP.md` 引用；`docs/MOD-SURFACE.md`
  把 `morphPairing` 槽位半条的冻结锚点点名。
- 测试平台修复：浏览器套件截图落盘改用 `fileURLToPath`（Windows 上 `new URL(...).pathname` 会解成
  `E:\E:\…`，那是**测试工具**的错，不是产品的错）。
- `support/index.js` 补 3 行再导出，把引擎已有的 5 个原语交给工坊 kit（**只增导出**，不改既有行为）。

### 门槛（发布前全绿）

`node --test` **8367 条 / 8362 通过 / 0 失败 / 0 取消 / 5 跳过**（357.9 s）· 三件套
（`docs-consistency` / `docs-paths` / `promptCitations`）**39 / 39** · `npm run golden` exit 0
（六份语料 49 / 46 / 22 / 20 / 10 / 140 **全部 match**）· mod 闸门
（`tools/check-packs.mjs --engine .`）**exit 0**（`packs/` 8 包 + `demo/` 3 样板全部装上）·
`data/` 与 `test/golden/` **零改动**。

---
## 0.16.0-0.2.4 — 2026-10-12

### 对局战绩与可选账号（第 2 刀）

**战绩落盘 + 可选账号口令库（docs/RECORDS.md）。** 今天 `playerId` 每次连接都是新的，所以「我上一局打得
怎么样」换个会话就找不回来；这一刀给两样东西：一次完整结算落一条战绩，以及一个**默认关闭**的账号层（账号名 →
跨会话稳定的 `playerId`，口令由玩家自己持有）。

* **开关是显式的 `SP_ACCOUNTS=1`，不是「某个文件恰好存在」。** 没有它时 `AccountStore` 与 `MatchRecords` 都
  **不构造**：`hello` 里没有认证那一段、结算点不落盘、`GET /api/records/account/<NAME>` 回 404。**老客户端握手
  逐字节不变**（`playerId` 还是那 10 位十六进制临时 id）。
* **口令**：每账号 16 字节随机盐 + scrypt（`N=2^15, r=8, p=1`），`timingSafeEqual` 比较，**永不落明文、永不回显**，
  落盘 `0o600`。登录失败不区分「账号不存在」与「口令不对」（那会是账号枚举）；注册才分开
  `NAME_TAKEN` / `WEAK_PASSWORD`。坏库 / 版本不对 ⇒ 抛（fail closed）。
* **限流按客户端网络键**（`TokenBucket(0.1, 8)`）加同连接不并发派生 —— 一次 scrypt 是几十毫秒单核 CPU，没有这道
  闸门口令库就是一个 CPU 放大器。
* **改密入口本版不存在**（业主裁令）。投稿带的是 `POST /api/account/password` + 站点级共享 `SP_ADMIN_TOKEN`：共享的
  管理员密钥不是玩家的口令，而且它会让「必须提供旧口令」变成装饰。连为它服务的脚手架（`sameSecret` /
  `readJsonBody` / `adminToken` / `MIN_TOKEN_LENGTH`）都没有实现。将来要代改，另立一次性重置票据的设计。
* **战绩落盘有界**：JSONL 追加日志（行首 `v` = 行格式版本；坏行与未知版本**跳过并告警**），`byPlayer` ≤ 20000、
  `byRoom` ≤ 5000，追加到 5000 行时**原子压缩重写**（临时文件 + `rename`）。行数硬上界 `20000+5000+5000`。
  **代价**：压缩丢弃不再被索引引用的历史局 ⇒ 这不是一份可归档的战绩史（`SP_RECORDS_FILE` 指到会备份的地方）。
* **公开战绩面收窄**（业主裁令）：`GET /api/records/<CODE>` 只给 **seat + 是否本人**；`GET /api/records/account/<NAME>`
  只回**被查账号本人那一行聚合**（队友的昵称与逐回合购卡明细都不出现，本人明细走 `records.mine`）。昵称与购卡
  明细只到房间成员与本人。`playerId` 任何档位都不出现在公开面。**房间号不是安全边界**。
* **两条只读战绩路由限流**：每客户端地址 `TokenBucket(1/s, 突发 10)`，超限 **429 + `Retry-After`**；两条共用一只
  桶。HTTP 面不受 WebSocket 的桶保护，而 `/account/<NAME>` 若不限流就是一个账号名枚举面。名字与登录同一套键
  （NFC 归一 + 小写、**精确匹配**），「账号不存在」与「存在但没打过」**同答复**（否则是存在性探针）。
* **协议面**：`hello` 加**可选** `auth` / `password`；C2S 加 `records.mine`、S2C 加 `records.latest`。
  **`PROTOCOL_VERSION` 与 `MOD_API_VERSION` 都不动**，不改默认游戏行为 ⇒ **不需要 `golden:update`**。
  `server/net.js` 的 `HEAVY_TYPES` **只**多 `records.mine`（`room.list` / `room.skins` / `user.activity` /
  `lastInputAt` 属于第 3、4 刀，投稿的补丁把它们混在一起了，这里一律不带）。
* **`sanitizeName` 一律不动**：投稿要禁 `test` / `admin` / 三位以上 `a`。那反转的是**既有判定**（脱敏 + 截断），
  会打断 `test/lobby.test.js` 与 `test/client-static.test.js` 的既有断言，客户端 `title.js` 另有一份会漂移，而且
  它**不解决顶替** —— 另议。

### 房间目录读面：`GET /api/rooms` 只报一个数（第 3 刀）

**新增只读端点 `GET | HEAD /api/rooms` ⇒ `{ "publicRooms": <int> }`（DESIGN §28.42，docs/META.md §1.7a）。**

- **一个数，不是列表**：公开面**永远只有** `publicRooms` 这一个整数字段，**不**回答房号、房主名、人数或任何明细
  —— 任何一个这样的字段都能把「数」变成对某一个房间的**侧写**。`sendJson` 回答（`no-store`），
  `POST` 等动词走既有的 `405` + `Allow: GET, HEAD` 闸。
- **管理员面不新建任何东西**：`/healthz` 的 `rooms`（= `Lobby.stats().rooms` = `rooms.size` = **全部房间数**）
  就是业主要的那个数，运维口径。**本刀不引入** `SP_ADMIN_TOKEN` 这类共享管理员秘密。
- **「公开」的定义：今天没有这个概念，所以照实说。** 引擎今天没有「公开 / 私有」这个房间属性（`inviteOnly`
  不存在，本刀**不预埋**），因此 `publicRooms` 与 `/healthz` 的 `rooms` **今天恒等**，两者共用
  `Lobby.roomCounts()` 的**同一次遍历**与同一个 `rooms.size`（solo 房算数）。`this.rooms` 只装在册房间
  （`disposeRoom` 立刻 `delete`）。`inviteOnly` 将来落地后，`roomCounts()` 是唯一该改的地方。
- **协议面一字未动**：`shared/protocol.js` 的 C2S / S2C 不改，`server/net.js` 的 `HEAVY_TYPES` 不加任何东西,
  **不引入** `ACTIVITY_TYPES` / `user.activity` / `lastInputAt`；`PROTOCOL_VERSION` / `MOD_API_VERSION` **不抬**；
  默认逐字节不变（不新增任何线上帧，`/healthz` 的字段集合不变）。
- **投稿 `7ca51de6f346` 的采纳/改动说明**（作者 **Leiothrix**，来源 `NeoPecos/Stronghold-Protocol 2cadc618`，
  基线 `sganggs/Stronghold-Protocol bc50cac0`，许可 **GPL-3.0-or-later**，原件不含游戏素材）：
  原件要的是 C2S `room.list` + `user.activity` 与 S2C `room.list` —— 整张**公开合作房间**列表，每条含房号、
  房主代号、难度、真人与 AI 人数、在线及近期操作人数、招募或对局状态，并提供加入 / 观战入口，招募房间优先，
  **独立模拟（solo）房间不公开列出**；它自己在 `SOURCE.md` 里就写明这需要引擎提供**受限的列表读面**，
  **不要让普通模组直接访问整个 Lobby 内部**。
  **采纳**：受限只读读面这一条**方向**（业主裁令收窄为「只给公开房间数 + 管理员可看全部房间数」），
  以及「不要暴露 Lobby 内部」的边界主张。
  **改动**：不做全量枚举、不做 `room.list` / `user.activity` / `lastInputAt` / `inviteOnly` / `recruitWanted`，
  不做加入 / 观战入口与招募排序，**也不预埋**这些字段；公开面只剩一个整数。
  **未采纳的原因**：整张列表需要先有一整套「公开 / 私有」房间属性、一个心跳口径和一套限流，且会把 4 字母房号
  变成可枚举的东西。**solo 房**按业主裁令**算数**（与 `stats().rooms` 同口径），与原件「solo 不列出」不同 ——
  这一处是我们**刻意**的口径差异。
- **隐私边界（照实写）**：只给数 ⇒ 不泄露房号 / 房主名 / 人数明细；但 `n = 1` 时「数」就等于暴露「有一个房间
  存在」，`n = 0` 与 `n >= 1` 的差别本身可推「现在有没有人在玩」，这个量级无法再降。而 `/healthz.rooms` **今天
  就已经公开同一个数**（默认 `HOST='::'` 全网卡绑定），所以本刀新增的信息量约等于零。
- **测试**：`test/lobby.test.js` —— body 恰好一个字段、随注册表 +1 / 离开 −1、**隐私哨兵**（建房后响应文本不得
  含该房号或房主名）、HEAD 200 无 body、POST 405、`roomCounts()` 与 `stats()` 同源
  （`publicRooms === total ===` `/healthz` 的 `rooms`）。

### 素材加载源：`pack.json.assets.mirrors[]` + `sources(ctx)`（第 5 刀）

**素材加载源：`pack.json.assets.mirrors[]` + `sources(ctx)`（DESIGN §28.40，docs/WORKSHOP.md §1.21）。**
投稿 `2a031cf0f869`（「CDN 源选择」）的作者在 `note` 里把话说得很直：**做不到改素材加载源**。这一版把那一格补上，
由两半组成 —— 数据那一半 `assets.mirrors[] = [{ id, base, sha256 }]` 说**哪些镜像被允许**，面板模块导出的
`sources(ctx)` 说**先试哪一条**。

- **只镜像「本包自己的容器」**，绝不做「把整棵 `/assets` 树指到第三方」。三条硬事实：`data/assets.json` 只有
  清单级摘要、**没有逐文件摘要**（哈希锁得住清单字节、**锁不住图**）；把整站素材树交给第三方正是「不分发官方
  素材」要拦的形态；坏一个镜像就等于**全站**素材出问题，收窄之后只影响一个包。`server/http/static.js` 一行未改。
- **形状与守卫全部点名**：`base` 必须绝对 `https://`（有主机、无凭据、无查询、尾斜杠）、id 唯一且 ≤ 4 条、
  `sha256` 是 64 位小写 hex、字段闭集；声明了 `mirrors` **必须**写 `license`
  （`ASSETS_MIRROR_NEEDS_LICENSE`：素材的再分发者是作者，授权问题不因为换了一台主机就消失 —— 与 §28.36 的
  `VOICE_CDN_NEEDS_LICENSE` 逐字同一条理由）。八条拒绝码：
  `ASSETS_MIRROR_{BAD_SHAPE,UNKNOWN_FIELD,BAD_ID,DUPLICATE_ID,BAD_BASE,BAD_DIGEST,TOO_MANY,NEEDS_LICENSE}`。
- **装载期比对、不下载**：每条镜像的 `sha256` 必须等于**装载期从包内文件算出的**容器摘要；对不上的那条**停用并
  点名**（`ASSETS_MIRROR_DIGEST_MISMATCH`）而**不是拒绝整个包**（§28.35「宁少不拒」）。**服务端一条网络请求都不
  发** —— 没有服务端超时、没有服务端缓存目录、没有启动期阻塞（与 §28.36 的 `voiceCdn` 相反）。
- **客户端次序是硬性的**：取清单 → 取容器 → **先核整包 sha256**（必须 `checked && ok`）→ 再走**既有**的逐文件
  SHA-1[0:12] 导入与写缓存；任何一步不过就换下一条；**全都不行 ⇒ 回落包内那条 `/workshop-resources/…` URL 并
  点名**（`CLIENT_SOURCES_FALLBACK` + `via: 'pack'`，面板可见）。**不静默、不空白。**
- **`sources(ctx)` 结构上不可能引入主机名**：与外观提供者（`appearance(ctx)`）逐条同构（进程内最多一个、
  四个具名拒绝码、只提供不 `mount` 不是错），返回 `{ order(mirrors) }`，**只许回已声明 id 的排列或子集**；
  喂主机名 / URL / 未声明 id ⇒ `CLIENT_SOURCES_BAD_ORDER`，整条顺序作废。地址只在 `pack.json`，
  而每条都已在装载期与包内容器摘要比对过。
- **一键回退**：设置里新增「工坊素材源」（`settings.workshopSources`，默认开）。关掉 ⇒ 走的与「没声明 `mirrors`」
  **完全同一条**路径，镜像那条 URL **一次都不被请求**。
- **如实说清的做不到**：容器大于 **256 MiB** 用不了镜像（浏览器没有流式摘要接口），那类包只能走包内；不设这条线
  就等于「不核摘要也导入」，那是「不能算错」的直接反面。
- **缺省逐字节不变**：不声明 `mirrors` 的包归一化清单里没有这个键、`welcome.modAssets` 里没有这个字段、请求的
  URL 与次序与从前逐字相同、引擎 SW（§28.13.5）一行未改。**`MOD_API_VERSION` 仍是 1**（加一格字段不抬版本）、
  **不要求 `combat: true`**（只改「哪台主机送同一份已校验字节」，改不了这一局的结果；容器摘要本来就在内容哈希里）。
  **不新增协议消息、不动 `server/http/routeMount.js`、不动 `MOD_SURFACE_FROZEN['1']`**（新表面 `client.sources`
  只加不改）。

### 口径轴 `form`：干员形态投影（第 6 刀）

**口径轴 `form`：普通干员按精锐形态出战（DESIGN §28.41，docs/WORKSHOP.md §1.20）。** 投稿 `e4fe4d5cf0a0`
（「干员满练mod」）的 `training` 一段真正想做的那件事，在这里单独立项落地：`pack.json.variants` 加第三条轴
`form`（`official` / `elite`，缺省 `official` = 引擎今天的行为），`elite` 时每条**普通（`_a`）**棋子按它精锐兄弟
（`_b`）的**战斗职能**出战。

* **数值全部由引擎自己烘，包一个数都不许塞。** 投影从**引擎自己的** `_b` 记录读 `stats` / `trait` / `skill` /
  `skills` / `talents` / `module` / `modules[]` / `assets`（`shared/formProjection.js`；`IDENTITY_FIELDS` 复用
  `shared/standIn.js` 那一份）。投稿自带的那套数**没有被采纳**，而且是刻意不采纳：它比引擎今天**低**
  （投稿给 `chess_char_1_01_a` 的 `atk` 是 497，引擎的 `_b` 是 531），照搬会**静默降级**干员。
* **身份与价格都不动**：棋子 id、`tier`、`price`、`sellPrice`、盟约、特质、`upgradeNum` / `upgradeChessId` 仍是
  `_a` 那一份。
* **`status` 是身份标牌，不参与投影**（`phase` / `level` / `skillLevel` / `equipLevel` 整格留在 `_a`）。这条是**刻意
  的**，三条理由：**①** 引擎从它读补位形态（`shared/standIn.js` 的 `statusKey` → `backups.units[charId].forms`）、
  模组激活与技能档位（`:64`），`test/backups.test.js:209` 逐字钉住 `_b` 的 `status` —— 挪过去会连带改掉这三条既有
  语义；**② 数据本身不允许**：129 对里 **39 对**的 `_b.level` **小于** `_a.level`（`1/55` → `2/50`），照搬会让那 39
  块地**显示练度回落**，直接违反本轴的「不许降级」；**③** 投稿自己也是这个口径（它对 `_a` 只写
  `status.skillLevel = 7`，不改 `phase` / `level`）。作者的意图仍然达成：投影后 `_a.skills[]` 每条的 `level` 与
  `_a.skill.level` **都跟着精锐走**（引擎里 `skillLevel` 与 `skills[].level` 恒等，`test/data.test.js:453` 钉住）。
* **两条如实披露的后果**（业主裁决 2026-10-13；两者都是刻意的，也是它必须标 `combat: true` 的理由）：
  **① 1 阶价拿到精锐形态的数值**（价格不动 ⇒ 一枚 1 阶棋子带着精锐的数值上场）；
  **② `upgradeNum` 不动 ⇒「3 张 `_a` 换 1 张 `_b`」在投影下价值中性**（不是 bug：投影改的是战斗职能，不是合成经济，
  改它就越出这个声明的范围）。
* **召唤物同一个轴**：`data/tokens.json` 里 owner 变体有 `_a` / `_b` 一对的召唤物（本季 19 个），`_a` 的 owner 变体
  在 `form: "elite"` 下换成 `_b` 的那一条；没有 `_b` 变体的原样不动。
* **缺省逐字节不变**：不声明这个轴的包，`GameData.chess(id)` / `DataSource.rawChess(id)` 返回 `data/chess.json` 里
  **那个对象本身**（`===`，对象身份不变）；`test/golden/*.json` 一个字节都不动，**不需要** `golden:update`。
* **面板与战斗不分叉**：`Match` 建**一份**形态视图，`GameData` 与这一局的 `DataSource` 共用；`Match.js` 的
  `dsCache` 缓存键并进了 `form` 口径（同一份 data 的两个房间，一个声明 `elite`、一个不声明，各拿各的
  `DataSource`）。
* **`combat: true` 是硬闸门**：沿用既有的 `VARIANTS_NEED_COMBAT`（口径改对局结果 ⇒ 必须进房间摘要闸门与 golden
  语料），本刀没有新增闸门。**`MOD_API_VERSION` 仍是 1**（只加一格口径选项，不新增协议消息、不改默认游戏行为）。
* **不许降级**是逐条断言的门（干员与召唤物都过）：投影后每条记录的 `atk` / `maxHp` / `def` 必须 ≥ 投影前
  （`test/form-projection.test.js`）。

### 行为补丁 / 声明通道：`pack.json.behaviour`（第 4 刀）

**`pack.json.behaviour`：引擎实现一格，任何包声明它（DESIGN §28.43，docs/WORKSHOP.md §1.22）。** 投稿
`ac8c9821f5ba`（「卫戍协议mod-跨版本一键安装包-v1.4.8-适配0.2.4」）把「改一条规则」做成了**安装器**：`install.mjs`
（43,658 B）按 `files.json` 的 `copy` 清单**整份覆盖** `data/{chess,config,items,official,skins}.json`、`server/**`
48 个文件（含 `server/sim/**` 22 个）、`public/**` 五十余个与 `payload/tools/**` 13 个。它自己的 `files.json`
把语义写得很直：「**Nothing is trimmed: a target that gets the whole file gets the whole feature**」。本刀**不
把这套搬进引擎**，而是开一条受约束的声明通道 —— 判断与 `official` / `config` / `meta` / `shared` / `theme` /
`serverModules` 六格「刻意没有通道」**逐字一致**。

* **形状与 `variants` 逐字同构、表独立**：`behaviour = [{ switch, option?, name?, desc? }]`，条目字段闭集，
  归一化结果按开关名排序（键序是清单字节）。它与口径**分两张表**，因为入场券不同 —— 口径必有「官方那一档」、
  缺省＝引擎今天的行为；行为开关是「引擎里本来没有、现在由维护者实现的规则」。混在一起会把口径那条唯一的执行点
  逼成一个通用 patch 分发器。**`VARIANT_AXES` 一字不动。**
* **包里没有数值、也没有路径**：动作（`{ kind, value }`）**由引擎构造**，`value` 只能来自那一格或引擎自己的常量。
  `module` / `entry` / `file` / `path` / `value` / `key` 这类键在形状层**点名拒**，理由里写清「一条行为声明只说
  一个开关与它的一个选项」；这一层**没有**「删官方键」的表达能力（没有 `$del`）。
* **不认识的声明响亮失败**：`BEHAVIOUR_UNKNOWN_SWITCH` / `BEHAVIOUR_UNKNOWN_OPTION` / `BEHAVIOUR_BAD_OPTION` /
  `BEHAVIOUR_BAD_SHAPE` / `BEHAVIOUR_DUPLICATE_SWITCH`，每一条都整包拒绝并点名。
* **本版那张表是空的 —— 这是交付物本身**（业主裁决 2026-10-13）：第 4 刀交的是「**通道 + 守卫**」，通道真的通、
  且响 —— **任何**一条 `behaviour` 声明都被 `BEHAVIOUR_UNKNOWN_SWITCH` 点名整包拒（空表不是「一律忽略」，而是
  一个都不认识，文案里写清「本版一个开关都没有，因为没有实现点」）。**首格与它的引擎实现点一起落**，由业主点名；
  加一格的门槛因此比加口径轴更严。
* **第五条 `combat` 硬闸门**（`BEHAVIOUR_NEEDS_COMBAT`）：一格的入场券本就是「它改一条规则」⇒ 必须进房间摘要闸门
  与 golden 语料，与 `server.meta` / `server.battle` / `modules[].uses: ["matchClass"]` / `variants` 四条同一条线。
  将来若有一格**明确改不了结果**，它必须**不**要求 `combat`（判据是能力，不是意图）。
* **不是贡献项**：一个只带 `behaviour` 的包照旧 `EMPTY_PACK`（与 `support` / `playtest` / `variants` 同一条），
  文案里点名 `"behaviour" is NOT a contribution`。
* **缺省逐字节不变**：不声明 `behaviour` 的包归一化清单里**没有**这个键（否则所有已发布包的内容哈希全变、房间的
  摘要闸门误判）；声明了**必须**进包身份哈希（只差一个开关的两份包摘要必须不同），**不进** `modDigest`
  （只哈希 `[id, hash]`），随 `welcome.mods[].behaviour` 与 `variants` 并列投影（漏掉投影 = 开关**静默不生效**）。
  **`MOD_API_VERSION` 仍是 1**（加一格字段不抬版本）、**不新增协议消息**、不改默认游戏行为 ⇒
  **不需要 `golden:update`**。**`MOD_SURFACE_FROZEN['1']` 不动**（新表面 `behaviour` 只加不改）。
* **判据写成「表是入参」的纯函数**（`parseBehaviourDecl(raw, table)` / `behaviourSwitchIssues(table)` …）：表是空的，
  写死的话「选项名不认识」「同一个开关写两遍」「缺省写错」这些分支**任何测试都碰不到**，而一条从来没验过失败分支的
  守卫和没有守卫是一回事（与 `surfaceLedgerIssues(ids, generation)` 同一条理由）。`normalizePackManifest` 因此多一个
  **可选** `opts.behaviourSwitches`（默认真表；装载器 / 校验器 / 编辑器一律不传）。**如实说清**：这是为可测性加的
  一个入口，不是新能力。
* **投稿 `ac8c9821f5ba` 的采纳 / 改动说明**（作者 B站@伊佐那邪_，来源
  `github.com/yznx09/Stronghold-Protocol-Rhodes-Kazdel-Mod`，站点 `flagged/`，`flags` 含 `EXECUTABLE`(blocker) /
  `NO_PACK_JSON` / `WRAPPED`）：
  **采纳**：它真正需要的那一类「改一条规则」的**方向** —— 由引擎实现、由包声明（本刀把那一格开好）；
  以及它**自带内容包**那一半（`payload/packs/fanpack/`：`pack.json` 893 B + `records` / `chess` / `tokens` /
  `variants` + 7 张**自制** PNG）所属的通道 —— 那一半今天**已有**通道（`content` + `kits/` + `art` / `bondIcons` /
  `itemIcons` + `variants`），只是**格式不同**（它的 `type: "data"` / `files{}` / `_doc` / `credits` /
  `englishName` 不在 `PACK_FIELDS` 里，会被 `PACK_UNKNOWN_FIELD` 点名拒）。
  **改动 / 未采纳**：**不采纳安装器**（`install.mjs` + `一键跨版本安装.bat`）、**不采纳整包 `payload/` 上架**、
  **不采纳**对 `data/*.json` / `server/sim/**` / 整屏 UI / `tools/**` 的**整份覆盖**语义；`EXECUTABLE` 那条
  suspected 命中的只是文件名 `.bat`（规则字面判对、实务误判），但**整份覆盖**这条语义本身正是本刀要拦的形态。
  **它自己遵守「不分发官方素材」**：`files.json` 自述官方 `public/assets/**` 从不随包发（`install.mjs --assets`
  才下），所以那 7 张图是自制的 —— **对外表述必须与这条一致**，不要把它说成侵权包。
  **站侧含义**：原件在 `flagged/` 且 `flags` 含 `NO_PACK_JSON` + `WRAPPED`（全部文件套在 `跨版本安装包/` 一层下）
  ⇒ **若做成兼容包上传，必须先扁平化**（`pack.json` 必须在 zip 根）。这条归站侧那条线。

### 本版刻意没有做、或被否决的部分（照实写）

- **②（战绩/账号）**：投稿带的 `POST /api/account/password` + 站点级共享 `SP_ADMIN_TOKEN` **没有实现**，连为它服务的
  脚手架（`sameSecret` / `readJsonBody` / `adminToken`）都没有 —— 改密必须是**账号上的操作**，等一次性重置票据的设计。
  投稿还要禁 `test` / `admin` 这类名字，**未采纳**（那会反转既有判定，且不解决顶替）。
- **③（房间目录）**：投稿原件的 C2S `room.list` / `user.activity` 与 S2C `room.list`（整张房间列表 + 招募排序 + 加入 /
  观战入口）**没有采纳**，`inviteOnly` / `recruitWanted` / `lastInputAt` **一律不预埋**；公开面只剩一个整数。
  **solo 房算数**（与原件「solo 不列出」不同）—— 这是刻意的口径差异。
- **⑤（素材源）**：不把整棵 `/assets` 树指到第三方，**只镜像本包自己的容器**；服务端**不发任何网络请求**；
  容器 > 256 MiB 用不了镜像（浏览器没有流式摘要接口）。
- **⑥（形态投影）**：`status` **不参与投影**（身份标牌；39/129 对里 `_b.level` 更低，照搬会显示练度回落）；
  价格与 `upgradeNum` 不动 ⇒「一档价拿到精锐数值」与「3 张 `_a` 换 1 张 `_b` 价值中性」两条**如实披露**。
- **④（行为声明通道）**：第 4 刀落地时**那一格没有任何可用开关** —— `BEHAVIOUR_SWITCHES` 当初为空 ⇒ **任何**一条
  `behaviour` 声明都会被 `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒**。那是刻意的：**格子先立起来、开关逐个按需加**
  （首格与它的引擎实现点一起落）。**第 8 刀按这条落了前三格，见下。**

### 行为开关的第一批格（第 8 刀）

**投稿 `b293e061b38f`（「商店刷新盟约装备几率提升」）与 `8b4e5da55c58`（「休整期可更换技能和模组」）要的那两件事，
收成引擎里两格实现好的开关（DESIGN §28.43.1）。** 两份原件都把它们做成了**安装器**（`files.json` 的 `copy` 整份
覆盖 `data/items.json`、`server/match/**`、`shared/protocol.js` 与客户端文件）。本刀不采纳安装器：**引擎实现一格，
任何包声明它**（`docs/WORKSHOP.md` §1.22 / §1.23）。

* **`shopBias`**：`official`（缺省，今天的行为）· `bondBias`（装备槽只在本玩家**已激活**盟约对应的装备里抽，
  **只偏置、不授予**）。读取点 `bondBiasPreference`（`server/match/pool.js`）→ `bondBiasBonds`
  （`server/match/player/economy.js`）→ `PlayerEconomy._rollItemSlot`。**抽到的阶级仍由棋子份额决定**，某一级无命中
  就**回落官方那一份**（偏向不会把商店抽空），库存闸门一步不跳过。
* **未实现的两条 + 未读的两个字段（如实披露）**：原件的 `_doc` 还提到「已激活**核心**盟约优先于已激活附加盟约」
  与「骑士戒律也接入这套偏向」，其 `payload/data/items.json` 另带 `giveBondBiasOnly`（115 处）与一批
  `canGiveBond`（115 处）。那两条的源件不在我们手上 ⇒ **不做、也不在 `effect` 里声称做了**；这一格**只读
  `giveBondId`**，不读 `giveBondBiasOnly`（我们数据里连这个键都不存在）。`test/shopBias.test.js` 用源码级断言钉住。
* **缺省路径逐字节不变**：不声明 / 选缺省 ⇒ `restrict` 为 `null`，与从前同一份代码路径、同一份结果；
  `Match` 只多一行 `mergeBehaviourDecls`（与 `variants` 同一个投影点，**不新增协议消息**）。
  **不需要 `golden:update`**：没有任何一格在缺省时改变一局的结果。
* **`prepLoadout`**：`locked`（缺省，今天的行为）· `prep`（休整期里、且**这个座位还没准备**时，也收一次既有的
  `room.loadout { entries, ops? }`）。读取点 `LOADOUT_PHASES` / `loadoutPhasesFor`
  （`server/match/match/platform.js`）→ `MatchPlatform.setLoadout` 的相位闸门。**不新增协议消息**（投稿自己那个
  `g.loadout` 我们不需要：`room.loadout` 在比赛进行中本来就走到 `Match.setLoadout`）；`PREP` 那一次走
  `mergeLoadoutEntries`：**只覆盖这次写了的干员**，没写的保留当前配发（整份替换会把其余干员静默打回默认）。
  `INFO_CHECK` 那一半**不看** `ps.ready`（今天也不看）—— 两个相位是两条独立的门。缺省档读到的相位数组与从前
  逐字相同（只有 `INFO_CHECK`），**不需要 `golden:update`**。
* **测试**：新增 `test/shopBias.test.js`（9 条）+ `test/prepLoadout.test.js`（8 条：形状 / 两档 / 缺省与今天
  逐字相同 / `prep` 档的合并语义 / `ready` 后仍拒 / 别的相位照旧 `WRONG_PHASE` / 协议面一个字节不动）。
* **`morphPairing`**：`official`（缺省，今天的行为：少于两件装备不配对、配上了就每一件 `giveBondId` 都授予）·
  `plus`（投稿 `19ea65909cf6` 那一套：**一件起配**、只取装备行里**最左边**那一件）。**判据只有一份** ——
  `shared/morph.js` 的 `grantedBondsByMorph`：投稿原件是把**三处读取点各覆盖一份**
  （`bondsMeta.js` / `sim/content/support/index.js` / `public/js/ui/gameLogic/bonds.js`），三处各写一份循环正是
  这条规则最容易分叉的地方。本刀把那三处收成一个纯函数：prep 侧从 `GameData.morphPairing` 读（`Match` 建
  `GameData` 时传进去），战斗侧由 `withMorphPairing` 的作用域给（与 `withGameData` 同一条同步作用域纪律，
  `Battle` 构造期与每一步都压上），客户端由 `roomMods.js` 从 `welcome.mods` 合成后写入
  （`setMorphPairing`，合并规则直接调 `mergeBehaviourDecls`，不自己实现一遍）。BattleSpec 与
  `battleOptsFromMatch` 各带一个 `morphPairing` 键，**只在非缺省档才出现**。缺省档一个键都不多 ⇒ 逐字节不变。
* **`morphPairing` 的槽位语义（第 7 段补上的那半条）**：投稿还要求「不占装备位、每名干员只一件、第三件顶掉真占格
  那两件」—— 第三格落地时它被如实记成「未做」，这一段把它做完。判据是同一份 `shared/morph.js` 的
  **`morphSlotPolicy(decl)`**：`official`（缺省）⇒ **`OFFICIAL_SLOT_POLICY`**，一个**共享的冻结单例**，每个方法都
  逐字是引擎今天那条算术（`slotsUsed` = `items.length`、`slotCap` / `maxItems` = `equipPerChess`、`replacedIndex`
  的「`replaceUid` 找不到 ⇒ 0」）；`plus` ⇒ **`PLUS_SLOT_POLICY`**（不占位、每名干员最多一件、顶替只挑真正占格的
  那一件、一行最多 `equipPerChess + 1` 件）。六处读取点**同判**：服务端 `player/items.js`（`_attach` /
  `_takeReplaced` / `equip` 的两条守卫）· `player/acquire.js`（回收）· `bot.js`（选人与选装备）· `invariants.js`
  （不变量），客户端 `ui/detailPanel.js`（`EQUIP n/2` 分子与「不占装备格」标签）· `ui/gameLogic/placement.js`
  （`equipReplaces` 的替换判据，`roomMods.js` 把档位写进 `bonds.setMorphSlotPolicy`）。
  **缺省档逐字节不变**：没声明 / `official` / 不认识的档位返回的都是**那个单例本身**，缺省路径上「同一批数字、
  同一次比较、同一个 splice 下标」⇒ **不需要 `golden:update`**，已发布包一个字节不动。`gamedata.equipPerChess`
  本身**一字未动**（那两格装备位是官方的，策略只回答「这一行占了几格、能不能再放一件、顶替挑哪一件」）。
  `getItem` 的契约写在 `shared/morph.js`（收一件棋子或一个 id，回 items 记录）—— 第 7 段第一版在这里踩过一次真
  bug（`invariants.js` 写的是收棋子的形状、其余写的是收 id 的，判据只假设一种 ⇒ 不变量把变形同构体当成占位的普通
  装备），所以它由 `test/morphSlots.test.js` 的 `collectViolations` 断言回归。
* **测试**：新增 `test/morphSlots.test.js`（8 条行为级：缺省档拿到官方单例 / 官方档它占位且会被顶掉 / `plus` 档
  两件真装备 + 它共存 / 第三件真装备顶掉真占格的那一件 / 点名它做 `replaceUid` 被拒 / 每名干员最多一件 / 点名真
  占格的有效 / 官方档不认「槽位豁免」）。`test/morphPairing.test.js` 原地改了两条：原来钉「未实现」的那条**反过来
  钉「已经做了」**（`effect` 必须写明动了槽位、四处服务端读取点都必须读这一局的策略），另加两条单元级断言
  （缺省档 `===` 官方单例、`equipSlotsUsed` 的裸入口）。
* **测试**：`test/morphPairing.test.js`（形状 / 档位归一化 / 判据本体两档 / prep 读取点 / 战斗读取点的
  缓存按档位失效 / **三处读取点同判**（逐行遍历两档）/ 三处共用同一份判据的源码级断言）。
* **`test/packBehaviour.test.js` 原地改了三处（换语义，不放松）**：①「本版是空表」→「真表里每一格都通过形状守卫、
  每一格至少两档且有非缺省档」；②「空表也响亮」→「不认识的开关也响亮」（被拒的名字从 `shopBias` 换成真表外的名字，
  并新增「文案必须列出真表里的每一个开关」）；③「真表（空）下包装不上」→「真表下不认识的开关装不上」+ 新增
  「选了缺省档 = 引擎今天的行为（逐格遍历真表）」。`PACK_FIELDS` 的闭集计数**不变**（这一刀加的是**表里的成员**，
  不是顶层键）。`test/modSurface.test.js` 的 `ANCHOR_MODULES` 多登记三个模块（`pool` / `economy` / `platform`）
  —— 那是**判据的登记**，不是放松：新增的锚点照样逐条被验。

### 第 8 刀第四格 `unequip`：装备拆卸，以及本层**第一条「开关 + 新意图」**

**投稿 `79de9ff03518`（「装备拆卸mod」）要的那件事收成引擎里一格开关 + 一条新意图（DESIGN §28.43.2）。**
原件同样是安装器：`files.json` 的 `copy` **整份覆盖** `shared/protocol.js`、`server/match/match/intents.js`、
`server/match/player/items.js` 与六个客户端文件，并自加 `g.unequip {itemUid}` 意图。

* **`unequip`**：`official`（缺省，今天的行为：装上之后只能靠精英化 / 合成 / 卖出离开）· `allow`（休整期可以
  把一件已装备的装备**退回手牌**，右→左优先；手牌满则进**临时整备区**）。读取点：
  `unequipAllowed(decl)`（`server/match/player/items.js`，模块层纯函数）→ `PlayerState.unequip`；客户端同一判据
  读它决定**画不画**「卸下」按钮。
* **第一条「开关 + 新意图」的五处落点**（将来加意图照抄这份清单）：① `shared/protocol.js` 的 `C2S` 表
  `'g.unequip': { itemUid: isUid }`（与 `g.equip.itemUid` / `g.destroy.uid` **同一个 `isUid` 子**）；
  ② `server/match/match/intents.js` 一行分支；③ `PlayerState.unequip`；④ 客户端发送点（`gameActions.js` 复用
  既有 `act()`）+ UI（`detailPanel.js` 的 `ItemRow` 的「卸下」+ `game.js` 接线）；⑤ 一处可锚的判据导出。
  **`PROTOCOL_VERSION` 不动**（新增类型不是改已有形状，先例 `records.mine`）；**不新增 S2C 消息**。
* **缺省档逐字节不变**：`unequipAllowed` 为假 ⇒ 回 `ERR.BAD_TARGET` + `'equipped items are locked'`，
  **与 `destroy` 今天那一句逐字相同**；客户端**一个按钮都不画**（判据是「有人传 `onUnequip` 且 `unequipAllowed()`」），
  `ItemDetail` 那句「配发后无法取下」**只在 `allow` 档**换成不带那半句的版本 ⇒ **不需要 `golden:update`**。
* **原子性**（这一格最容易做坏的地方）：`_detach` 之后 `stow(piece, { allowTemp: true })` 可能返回 `null`
  （手牌与临时都满）。那时按**原下标**塞回 `holder.items` 并回 `ERR.HAND_FULL` —— 先摘后塞没有回滚的话装备会
  **凭空消失**。用 `HAND_FULL` 而不是 `BAD_TARGET`：「没地方放」是独立、可行动的错误。
* **池不变式照旧**：装备只是从**装备位**移到**手牌 / 临时**（同一个 `piece`、同一个 `uid`）⇒
  `SharedItemPool.held()` 前后都数得到它 ⇒ `held` / `cap` / `left` 全不变。**没有「归还」这回事**
  （`destroy` / `sell` 才真让池子少一件）。
* **刻意的决定：本格不发内容钩子。** `HOOKS` 那 19 个是**契约面**（进 `META`），「卸下」用哪一个都不贴切
  （不是 `onDestroy`、不是 `onEquip`），今天也没有包需要被通知；将来真有需要就**另立一刀**按契约面扩展。
  写进 §28.43.2 是为了让后人知道这是**决定**，不是漏做。
* **i18n**：新增两个词条（`卸下`、以及不带「无法取下」的那半句），**四个包都补齐**（en / ja / ko / zh-TW）。
  `node tools/i18n.mjs check --all --strict` 的 msgid 数 **1283 → 1285**，en 仍 **100 %**，ja / ko / zh-TW 的
  **57 个缺失与基线逐字相同**（那是既有缺口，不是本刀引入的）。
* **测试**：新增 `test/unequip.test.js`（10 条：真表那一格 / `C2S` 登记与 `validateC2S` 的拒绝（**两层都钉**：
  `validateC2S` 返回原因串、`server/net.js` 折成 `BAD_MSG`，而 `Match.handle` 只认过了它的消息）/ 缺省档
  `g.destroy` 与 `g.unequip` 回**同一句**且一个字节不落地 / `allow` 档三分支（手牌 / 临时 / 两者都满 ⇒
  原子回滚 + `HAND_FULL` 且**下标与失败前相同**）/ 池快照与 `checkInvariants` 前后一致 / `recompute` 后盟约人数
  真的变了（1 → 0，用 `morph-bonds.test.js` 的配方）/ 客户端源码级断言 / 四个 i18n 包的两个新词条）。
  `test/modSurface.test.js` 的 `ANCHOR_MODULES` 多登记一个模块（`items`）—— 同样是**判据的登记**，不是放松。
* **`test/match/fuzz.test.js` 必须同时教一遍**（这一次全量跑出来的真事）：那个模糊测试按 `C2S` 表逐个类型造随机
  载荷，并有 `assert.equal(validateC2S(msg), null, …)` 钉住「造出来的每一条都是合法消息」。新类型没进它的
  `switch` 就会掉进 `default`（`{ t }`，缺字段）⇒ **当场两条红**。补法是加一行
  `case 'g.unequip': return { t, itemUid: uid() };` —— **断言一字未动**，而新意图这下真的进了模糊覆盖
  （随机 uid 会打到 `BAD_TARGET` / 缺省档那句，都被 `assert.ok(res.ok || ERR[res.error])` 接住）。
  ⇒ **记在这里**：这一层将来再加意图，`fuzz.test.js` 的 `randomIntent` 是必须同步的第三处（协议表、`intents.js`、
  它的 `switch`）。

### 第 8 刀第二格的**客户端半**：修掉一句写了很久的谎话（投稿 `8b4e5da55c58`）

第二格的服务端半（`Match.setLoadout` 读 `LOADOUT_PHASES`）第 8 刀就落了，客户端半一直没落。取证发现它**不是**
"少一个发送点"，而是**客户端在撒谎**：

* **发送链路整套早就有**：`public/js/ui/loadoutSync.js` 的 `installLoadoutSync` 早在发 `room.loadout { entries, ops }`
  （500 ms 去抖、面板关闭立刻冲刷、`WRONG_PHASE`/`ROOM_STARTED` ⇒ `'locked'` + 提示）；单干员编辑的纯函数也早在
  （`loadoutModel.setChoice`，缺键即删 entry，与 `mergeLoadoutEntries` 的"只覆盖写了的干员"天然对齐）。
  ⇒ **本刀不新造发送链路、不新增协议消息、不动 `PROTOCOL_VERSION`。**
* **缺的是客户端自己的相位判据，而它写死在两处**（`screens/loadout.js`）：
  1. 「本局已锁定 · 下一局生效」那句的 `locked`（原来"在局中、相位不是 `INFO_CHECK` 就算锁定"）—— 实测它
     **只喂两处文案、不 disable 任何控件** ⇒ 声明 `prep` 的房间出现「**服务端收得下、界面却说锁着**」；
  2. `shouldAutoClose` 的简报那一支 ⇒ 玩家刚进 `PREP`（正是服务端允许改调配的那一段）面板被**自动收走**。
* **做法**：把那份判据收成"一份两档的表 + 一个纯函数"。`loadoutSync.js` 导出 `LOADOUT_CLIENT_PHASES` /
  `loadoutLockPhases(option)` / `currentLoadoutLockPhases()` / `setPrepLoadout(option)`；`roomMods.js` 在**同一处**
  （与 `morphPairing` / `unequip` 并列）用**同一份合并规则**（`mergeBehaviourDecls` + `behaviourValue`）喂档位。
* **两张表的关系**：客户端的表与服务端的 `LOADOUT_PHASES` 是两张表（客户端不能 `import server/**`），这是这一层
  既有的做法 —— **客户端副本 + 一个测试把两张表钉在一起**（与 `CLIENT_WRAP_COMPONENTS`↔`MOD_COMPONENT_IDS`、
  `CLIENT_PANEL_SLOTS`↔`MOD_PANEL_SLOTS` 逐字同一条）。
* **缺省逐字节不变**：缺省 / 没声明 / 不认识的档位 ⇒ 只含 `INFO_CHECK`；两处的旧表达式与新判据
  **逐相位遍历同一个布尔** ⇒ 界面一个字节不变，**没有任何 `golden:update`**。
* ⚠️ **还没做的一件（如实披露，`docs/design/mod-layer.md` §28.43.4 记账）**：`PREP` 里**没有入口**能打开干员调配
  面板 —— `LoadoutButton` 只在大厅 / 房间 / 简报（只活在 `INFO_CHECK`）里出现，`screens/game.js` 里一个都没有
  ⇒ 在贴一个 `PREP` 入口之前，"服务端开了"与"玩家改得了"之间还差最后一步。那是**在对局屏新增一个可见控件**，
  属"新渲染分支"，本轮不做、记账待裁。
* **顺带排查（同类写死相位 / 写死能力，只记录不改）**：`screens/support.js` 的 `shouldAutoClose` 同形，但助战
  **没有开关**且服务端 `room.support` 同样只在 `INFO_CHECK` 收 ⇒ **两边一致、不是缺陷**（将来若要"休整期换助战"，
  那就是第 5 格开关）；`ui/equipReplace.js` 的 `if (equipped.length < 2) return null;` 与
  `ui/gameLogic/placement.js` 的 `items.length < 2` 把**装备位写死 2** ⇒ **与第 7 段（槽位语义）直接相关**，
  第 7 段必须一并交代（否则客户端对话框的触发判据会与服务端的 `equipPerChess` 对不上）。
* **测试**：新增 `test/prepLoadoutClient.test.js`（10 条：缺省档相位表逐字相等 / 默认状态不许"默认开" /
  **逐相位遍历**新旧判据同判 / `prep` 档只放开 `PREP` 一个相位 / **两张表逐档逐字相等** / 源码级（那一行读函数、
  旧写死消失、`ownLocked` 原样保留）/ `shouldAutoClose` 两档行为 / `roomMods` 接线 / **客户端半不新造发送链路**）。
