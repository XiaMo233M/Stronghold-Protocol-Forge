# Stronghold-Protocol-Forge · 卫戍协议工坊编辑器

![version](https://img.shields.io/badge/version-0.3.0-2ea44f)
![license](https://img.shields.io/badge/code%20license-GPL--3.0--or--later-blue)
![node](https://img.shields.io/badge/node-22%20%7C%2024-339933)

本仓库 = **上游同人游戏**（卫戍协议：盟约 · Stronghold Protocol: Alliance）+ **一套图形化的内容创作工具「Forge 工坊编辑器」**。

代码以 **GPL-3.0-or-later** 发布；与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**。

## 目录

- **编辑器（本仓库的主角）**：[这是什么](#这是什么) · [能做什么](#能做什么) · [快速开始（编辑器）](#快速开始编辑器) · [两条硬规矩](#设计上的两条硬规矩) · [Option 署名](#option-署名) · [工坊与助战](#工坊与助战)
- **上游游戏本体**：[本仓库完整包含上游游戏](#本仓库完整包含上游游戏) · [功能一览](#功能一览) · [快速开始（游戏）](#快速开始游戏) · [联机方式](#联机方式) · [操作](#操作)
- **文档与法律**：[文档](#文档) · [开发与测试](#开发与测试) · [项目结构](#项目结构) · [著作权声明](#著作权声明) · [上游来源与修改说明](#上游来源与修改说明) · [许可证](#许可证) · [致谢与数据来源](#致谢与数据来源) · [贡献](#贡献) · [English](#english)

## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有。这些素材**不适用**本项目的 GPL-3.0 许可证；GPL 只覆盖本项目自己编写的代码。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括但不限于：售卖本项目或整合包、付费下载或付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现方式，以及其他任何商业用途。
> - 仓库源码不包含游戏的美术与音频素材（只有由官方数据表生成的数据和几张游戏截图，同样不适用 GPL）；[Releases](../../releases/latest) 中的整合包为了方便玩家附带了素材，下载即视为同意本声明。请勿将素材用于本项目以外的用途或单独再分发。完整条款见 [NOTICE.md](NOTICE.md)。
> - 权利人如认为本项目侵犯其权益，请通过 Issue 联系，我们会**立即删除**相关内容。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。

## 这是什么

**Forge 工坊编辑器**（`editor/`）是一个**游戏之外的独立工具**，用来创作这个游戏的内容：干员、地图、怪物、出怪表、装备、行为层 kit、语音，以及把做好的包**导出成一个 `.zip` 交给别人**（或把别人的包装回来）。它在你本机的浏览器里打开，改的是你仓库里的工坊包。

- 它是**可选工具**：不运行就不存在。可以单独分发、单独使用（[docs/EDITOR.md](docs/EDITOR.md)）。
- **游戏客户端不含编辑器**：`editor/` 不在 `public/` 下，服务器结构上无法把它发给网页端或后续打包的 APK（`test/editor.test.js` 锁住了这条）。
- 编辑器、命令行工具与 AI 走**同一套创作规则**（`shared/*Authoring.js`），产出的工坊包完全一样。

## 能做什么

八个页面，右上角可互相跳转：

| 页面 | 路由 | 能编辑什么 |
|---|---|---|
| **干员** | `/` | id / 名称 / 阶 / 职业 / 分支 / 位置、**普通与精锐两套数值**、技能（含技能黑板）、天赋（0~2 条，每条含说明与黑板）、是否助战 |
| **地图** | `/stage.html` | **19×21 网格**、地形图例（调色板）、装置、路线（出生点 → 防守点）、**2D 摆放 + 3D 预览**（用游戏自己的渲染器） |
| **怪物** | `/enemy.html` | **17 项数值**、能力说明、天赋黑板、技能、五项免疫、复用现有美术（`spine`） |
| **出怪** | `/wave.html` | **时间轴 + 明细表**：每次出怪的时间 / 敌人 / 数量 / 间隔 / 路线 / 槽位、绑定到回合 |
| **装备** | `/item.html` | 一件装备 = 一个 spec = **两条记录（普通 + 精英）**、buffs 黑板（`bb` / `bbStr`）、图标复用 |
| **kit（行为层）** | `/kit.html` | 包里的 `kits/<干员 id>.js` —— **代码本体**（整份文件），配上**静态校验**（钩子词表、三条硬规则）与保存时自动写入的署名头 |
| **语音** | `/voice.html` | `pack.json` 的 `voices` 字段：干员 × 槽位 × 文件，**就地编辑**（其余字段原样保留）、按包内 `assets/` 真实文件挑选、可试听 |
| **包管理** | `/pack.html` | 整包的收发：**导出成 `.zip`**、**导入别人的 `.zip`**、勾选本包自己的干员进**助战卡池**（阶由记录推导）、看每个包的加载器结论、**一键试玩**（编辑器自己起游戏服务器并直接进一局） |

除上述表单，编辑器还有实时校验（与 CLI 完全相同的规则）与「将生成的记录」预览；地图页额外有**部署区覆盖层**与**寻路覆盖层**（12 条路线的流场），出怪页有按排期槽位配色的时间轴泳道，kit 页有钩子清单、合法 id 与静态校验（它**只读文本、不执行你的文件**）。

## 快速开始（编辑器）

**一键启动（推荐）**：双击 **`scripts\start-editor-windows.bat`**（Windows）/ 运行 **`./scripts/start-editor.sh`**（macOS / Linux）。它们会检查 Node、首次自动装依赖，然后启动编辑器并在浏览器里打开 <http://127.0.0.1:3311>。**不需要先下载素材、也不需要开游戏服务器。**

用发行页的**零安装整合包**时同理：解压后双击包根目录的 **`启动编辑器.bat`**（游戏是 `启动游戏.bat`）。

手动 / 脚本化：

```bash
npm run editor                       # 打开工坊编辑器（独立工具，默认只绑 127.0.0.1）
node tools/workshop-validate.mjs workshop                     # 分层校验整个工坊目录
node tools/workshop-scaffold.mjs docs/examples/operator-spec.json --pack my-pack   # spec → 合法工坊包
node tools/workshop-pack.mjs export my-pack                   # 把包导出成一个可分享的 .zip
node tools/workshop-pack.mjs import ~/Downloads/my-pack.zip   # 把别人的包装回来（--force 覆盖同名包）
```

- 也可以直接 `node tools/workshop-editor.mjs --port 3400 --open`，或用 `--workshop <目录>` 指定其它工坊目录。
- **默认只绑 127.0.0.1**（编辑器可以写文件）；要绑局域网需要显式 `--host`，此时会打印警告。**没有登录、没有权限控制**，不要暴露到公网。
- **无构建步骤、无新依赖**：纯 Node `http` + 原生 ES 模块 UI。**不需要改游戏服务器**。
- 它只写这些路径：`workshop/**`（spec 源文件与生成产物）与 `data/support.json`（只在动「是否助战」开关时）；`tools/build-data.mjs` 生成的其它 `data/*.json` **永不改动**。
- 保存后需**重启游戏服务器**才会出现在游戏里；**包管理页的「启动试玩」会替你做这件事**——它起一个游戏服务器子进程（绑本机随机空闲端口、读你当前的工坊根），并打开浏览器直接进一局独立模拟。改完包再点一次（「重启试玩」）即可。

## 设计上的两条硬规矩

### 一、只编辑人能给的，机械字段一律推导

手写派生字段会让数据与引擎不一致，而且游戏里不会报错。所以编辑器只让人填「人能决定的东西」，其余全部由服务端按真实引擎推导：

| 内容 | 作者填 | 一律推导（绝不手写） |
|---|---|---|
| 干员 | 身份、两套数值、技能、天赋 | **精锐一对**：`chess_ws_<slug>_a`（普通）+ `_b`（精锐），两条记录成对生成、成对删除 |
| 地图 | `rows`（网格）、`tiles`（字符 → 地形图例）、`devices`（装置）、路线 | `groundPaths` / `groundPathsWithDevices` / `deployTiles` —— 由 `server/stageAuthoring.js` 复用 `server/sim/grid.js` **模拟器自己的寻路**算出（路线本身也按引擎的流场寻路，画的是实际走法） |
| 怪物 | 17 项数值、能力说明、天赋黑板、技能、免疫、复用美术 | `attrPower` 与 `be`（`be` 决定阵营换怪时替换多少只，所以必须算，不能手填） |
| 出怪 | 时间 / 敌人 / 数量 / 间隔 / 路线 / 槽位 / 不计入 | `totalCount` 与 `slotCounts`（两者**不对称**：`slotCounts` 计入 `unharmful` 的出怪，`totalCount` 不计入） |
| 装备 | 身份、buffs 黑板、复用的图标 `trapId` | `params`、`mergeable`、`shopExcluded` —— 三条推导精确复现官方全部 115 条装备（`test/itemAuthoring.test.js`） |
| kit（行为层，手写文件） | 代码 | 钩子词表 + 三条硬规则（`shared/kitAuthoring.js`）：**必须自己给 `skill`**、**自包含不 import 引擎模块**、**会在玩家浏览器里执行** |

### 二、校验器复用真实引擎

`tools/workshop-validate.mjs` 是**分层校验**：格式 → 语义 → 真实引擎 → 每种内容一层（`kits` / 地图 / 怪物 / 出怪 / 装备）。地图层会**重算并比对路径表**，怪物层重算 `be` / `attrPower`，出怪层重算 `totalCount` / `slotCounts` 并检查每只敌人的键与 `routeIndex`，装备层重算 `params` / `mergeable` / `shopExcluded`。

编辑器、CLI 与 AI 共用同一批 `shared/*Authoring.js`（干员 / 地图 / 怪物 / 出怪 / 装备 / kit），所以**规则不会漂移**：编辑器里能保存的内容，校验器一定也接受，反之亦然。

## Option 署名

编辑器保存的**每一个 Option**（干员、地图、怪物、出怪、装备的 spec）都会自动带一个 `_meta`：作者、创建时间、来源、著作权声明、反打包转售声明 —— 声明写在 README 里不会跟着文件走，而一份被拷到别处的关卡文件必须自己说明它是谁做的。

- **`created` 只写一次**，之后再保存只更新 `modified`。
- **`_meta` 只存在于 spec（源文件）里，绝不会进入游戏读的产物**（`test/forgeNotice.test.js` 钉住了这条）。
- **行为层 kit 是 `.js`，写的是一行注释头**（`// @forge created=… author=…` + 声明全文）：JavaScript 里没有可以挂 `_meta` 的数据对象。规则相同 —— `created` 只写一次、只补写缺失的头、不动你自己写的注释（`test/kitEditor.test.js` 钉住了这条）。
- 作者名按 `createEditorServer({ forgeAuthor })` → `SP_FORGE_AUTHOR` → 该包 `pack.json` 的 `author` 取；都没有就写「未署名 (anonymous)」，不猜。

字段结构与边界详见 [docs/EDITOR.md](docs/EDITOR.md)，法律文本见 [著作权声明](#著作权声明)。

## 工坊与助战

> [!NOTE]
> 以下是**本项目自行新增**的功能，不是官方内容，也不在 `tools/build-data.mjs` 的生成范围内。它不修改 `data/*.json`。

- **助战**：每名玩家每阶可选 n 个助战干员，**卡池由服务端控制**（`data/support.json`），不在卡池中的即禁用。
- **创意工坊**：把工坊包放进 `workshop/<包>/`，即可新增/覆盖干员等内容。官方数据保持字节不变。
- **工坊语音包**：包可以在 `pack.json.voices` 里给自己的（或助战的）干员配语音，音频放在包自己的 `assets/` 下；客户端不需要任何新通道就能听到——叠加层把台词并进它本来就在读的 `assets.audio.voice`。只带语音、不含任何数据文件的包是合法的。见 [docs/WORKSHOP.md](docs/WORKSHOP.md) §1.4。
- **包自带助战**：`pack.json.support` 列出本包自己新增、应当进助战卡池的干员 —— 装包即可选，不必再手工改 `data/support.json`（阶由记录推导；安装方可用 `"workshop": false` 关掉一切包的声明）。见 [docs/WORKSHOP.md](docs/WORKSHOP.md) §2.1。
- **把包交给别人 / 装别人的包**：`node tools/workshop-pack.mjs export <包>` 打成一个 `.zip`，对方 `import` 即装；整合包里更简单——**把 `.zip` 拖到 `安装工坊包.bat` 上**。装包只写 `workshop/<包>/`，不碰 `data/*.json`。见 [docs/WORKSHOP.md](docs/WORKSHOP.md) §1.5。

```bash
node tools/workshop-scaffold.mjs docs/examples/operator-spec.json --pack my-pack   # spec → 合法工坊包
node tools/workshop-validate.mjs workshop                                          # 分层校验（含真实引擎）
node tools/workshop-pack.mjs export my-pack                                        # 包 → 可分享的 .zip
node tools/workshop-pack.mjs import ~/Downloads/my-pack.zip                        # .zip → workshop/my-pack/
npm run editor                                                                     # 打开工坊编辑器（独立工具）
```

**客户端不需要、也不会包含编辑器**：`editor/` 不在 `public/` 下，游戏服务器无法把它发给网页端或后续打包的 APK。
详见 [docs/WORKSHOP.md](docs/WORKSHOP.md) 与 [docs/EDITOR.md](docs/EDITOR.md)。

## 本仓库完整包含上游游戏

下面是本仓库**一并附带**的上游游戏：**卫戍协议：盟约 · Stronghold Protocol: Alliance**（非官方同人复刻）。它是这套编辑器的创作对象 —— 编辑器写出的内容，最终在这里跑起来。

### 简介

「卫戍协议：盟约」是自走棋 + 塔防：休整期在调度中心招募干员、摆阵、配装备，作战期干员自动部署，迎击从红门涌来的敌人，漏过去的敌人扣目标生命值。本项目在浏览器里复刻了这一玩法，规则和数值尽量对照官方数据表与 PRTS 核对。

- **独立模拟**（单人）与**同盟模拟**（1–4 人**合作**，没有 PvP；空位可以加 AI 队友）。
- 服务器是一个 Node.js 程序，**战斗在各玩家的浏览器里模拟**（和官方一样），服务器只管经济与回合，一台低功耗小主机就能开服。
- **本仓库打包的上游游戏本体为 0.1.3**（本仓库自己的版本是 0.2.0，两者的读法见[版本号怎么读](#版本号怎么读)）：修复了 0.1.2 发布后玩家和 GitHub 上反馈的问题，详见 [CHANGELOG.md](CHANGELOG.md)。仍有少数规则按推断实现，与官方不一致的地方欢迎在 Issue 里反馈。

下面是给作者做参照的游戏画面。

| 同盟房间 | 策略轮选 | 休整期（商店 / 盟约） |
|---|---|---|
| ![房间](docs/img/room.jpg) | ![策略](docs/img/band-draft.jpg) | ![休整期](docs/img/prep.jpg) |
| **部署方向轮盘** | **作战** | **最终攻势** |
| ![方向](docs/img/facing-wheel.jpg) | ![作战](docs/img/combat.jpg) | ![最终攻势](docs/img/final-assault.jpg) |

### 功能一览

- **完整的一局**：确认本局信息 → 策略轮选（40 名策略）→ 14 回合 → 结算称号；险境及以上满足条件时进入第 15 回合「隐秘核心」。
- **4 种难度**：标准 / 险境 / 绝境 / 终极，独立与同盟各一套参数，均取自官方数据。
- **休整期**：招募、刷新、冻结、升级调度中心；整备区与临时整备区；从整备区拖到棋盘部署，用**方向轮盘**选择朝向。同盟模拟的卡池共用。
- **晋升精锐**：3 名同名干员自动合成精锐，并获得一次高一阶的免费招募。
- **干员与调配**：112 名可招募干员（+ 精锐）及其技能、天赋和特质；开局前可以为每名干员选择携带的技能（283 个技能全部手工实现）和精锐的模组。
- **盟约与层数**：23 个盟约（8 个势力核心盟约 + 附加盟约），层数整局保留，每个盟约最多 999 层。
- **装备与机变**：装备与法术，同名装备合成、特定组合赋予盟约效果；已配发的装备锁定在干员身上。部分回合开始前有机变选卡（装备、资金、干员、层数、悬赏等）。
- **自动作战**：技能按官方「技能策略」自动释放；按接触半径阻挡，阻挡者倒下时由接触的干员接替；元素损伤与元素爆发；召唤物由玩家手动摆放；推开 / 拉拽按力度与重量计算；被击倒的干员留在原地显示再部署倒计时。
- **地形与敌人**：阻隔工事、射击台、源石流吹风机、沼泽、排气格栅、涨潮等地形装置；空中与近地悬浮敌人、悬赏敌人。
- **联防**：有人漏怪、又有人完美作战时，完美作战的队友带着阵容帮忙拦截漏掉的敌人。
- **最终攻势与隐秘核心**：两人共享一个战场，全队共同削减同一条领袖血条；10 个敌方领袖，巨型领袖约 5×3 格的受击范围，以及官方的限伤规则。
- **结算称号**：卫戍之星、不朽盟约、坚若磐石等 6 个称号。
- **断线重连**：同盟模拟断线后 10 分钟内重新打开页面即可回到原座位，掉线期间按原阵容自动作战，也可以「暂离」交给 AI 托管；独立模拟 24 小时内可以回来继续（同一个浏览器）。
- **交互细节**：漏怪时顶栏的目标生命值实时减少（结算时确定）；点选、拖放和配发装备都按地上的方格；购买、升级和机变选卡都需要点两次确认；只有一名玩家时除作战外不计时。
- **画面与声音**：真实 Spine 小人、官方 BGM 与音效、表情（6 套 × 6 个）、作战特效；可选的官方 3D 棋盘（需要从本机客户端提取贴图）。
- **手机与电脑**：触摸拖拽、长按查看详情，推荐横屏；设置里可以调低画质。

### 快速开始（游戏）

发行页上的两个包对应下面两种方式，按需选一个即可。

#### 方式一：零安装整合包（Windows x64，推荐）

**不需要装 Node、也不需要再下载素材**：包里自带便携 Node 22，解压后双击 `启动游戏.bat` 就会启动服务器并打开浏览器。

1. **下载**：在 [Releases](../../releases/latest) 页面下载最新版本的 **`…-win-x64.zip`**（含全部素材，较大；确切大小与 sha256 见发行页）。
2. **解压**到一个路径较短、**不在 OneDrive 同步范围内**的文件夹，例如 `C:\Stronghold-Protocol`。
3. **双击包根目录里的 `启动游戏.bat`**。Windows 防火墙弹窗请勾选「专用网络」并允许；关闭窗口即停止服务器。想开工坊编辑器就双击同一个目录里的 **`启动编辑器.bat`**（不需要先开游戏服务器）。
4. 浏览器会自动打开 `http://localhost:3000`。窗口里列出的局域网地址可以直接发给同一网络的朋友。

包内含编辑器、`docs/prompts/` 官方 prompt、全部公开镜像素材，以及从本机客户端提取的官方素材：**官方 3D 棋盘**、官方界面底板、灼热 / 炽焰源石虫的官方模型。素材版权归上海鹰角网络 / Yostar，**仅限非商业使用**，包内附 `NOTICE.md` 与 `THIRD-PARTY-NOTICES.md`。**不含**角色配音台词（`voice_cn/*`，客户端没有播放路径，设计上默认关闭）；每个干员的战斗音效（攻击 / 受击 / 技能）是齐的。

macOS / Linux 请用方式二。

#### 方式二：源码包 / 从源码运行（不含素材）

包里只有代码，素材在首次运行时从公开镜像下载（约 270 MB，可中断续传）。

```bash
unzip Stronghold-Protocol-Forge-*-src.zip     # 或 git clone 本仓库
cd Stronghold-Protocol
npm install        # 安装依赖（postinstall 会把 pixi / preact / three 复制到 public/vendor）
npm run setup      # 检查环境，并从公开镜像下载约 270 MB 美术 / 音频（可中断，再次运行会续传）
npm start          # 启动服务器：http://localhost:3000
```

也可以直接运行启动脚本（Windows `scripts\start-windows.bat`，macOS / Linux `scripts/start.sh`）：首次会自动安装依赖、下载素材，然后启动服务器并打开浏览器。

- **本地客户端素材（可选）**：官方 3D 棋盘、部分官方界面图标（交流按钮与表情面板的边框、模组类型图标等）和灼热 / 炽焰源石虫的官方模型需要从本机的《明日方舟》PC 客户端提取（Windows 原生客户端、macOS 的 CrossOver 或 PlayCover）。`npm run setup` 检测到客户端时会询问是否提取（需要 Python 3.8+，依赖装在项目内的 `.venv-extract`，不影响系统）；之后可以用 `node tools/setup.mjs --local` 重新提取，或用 `--game "<…/StreamingAssets/AB/Windows>"` 指定路径。没有客户端时游戏照常运行，这几样换成替代样式：2D 棋盘、样式相近的图标、染色的普通源石虫。表情和「玩法说明」的教程图随上面的素材一起从公开镜像下载，不需要客户端。没有客户端的服务器（例如 Linux VPS）也可以从**同一版本**的整合包里复制 `public/assets/local/` 和 `data/local-assets.json`，见 [docs/DEPLOY.md](docs/DEPLOY.md) 的「本地客户端素材」。
- **素材下载优先使用 GitHub**，失败时自动改用 jsDelivr 镜像。
- **干员语音台词（可选，默认关闭）**：`node tools/fetch-assets.mjs --voices` 额外下载约 138 MB 的角色语音（约 2000 段，120/138 名干员有战斗台词），装好后在「设置 → 干员语音」调高音量即可。**不加这个开关时一切照旧**：不下载、不写进清单、客户端也不请求。细节（槽位、`#` 文件名、URL 编码）见 [docs/ASSETS.md](docs/ASSETS.md) 的「Voice lines」；**工坊包自带的语音**（助战干员的配音）走同一条链路，见 [docs/WORKSHOP.md](docs/WORKSHOP.md) §1.4。
- `npm run doctor`（即 `node tools/doctor.mjs`）可以随时诊断：Node 版本、素材是否完整、端口占用、局域网地址和防火墙。

#### 版本号怎么读

发行 tag 写成 **`v<forge>-<上游>`**：`v0.2.0-0.1.3` = 本仓库（Forge 工坊编辑器）**0.2.0** + 上游游戏（[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)）**0.1.3**。程序里显示的版本（标题页、启动横幅、`/healthz`）只是前半部分，因为仓库自己的元数据检查要求它是三段普通 semver —— 详见 [CHANGELOG.md](CHANGELOG.md) 与 `test/version.test.js`。

#### 系统要求

| 项目 | 要求 |
|---|---|
| 开服的电脑 | **方式一**：Windows 10/11 x64，不需要装任何东西（自带 Node）；解压后约 510 MB。**方式二**：Windows / macOS / Linux + Node.js 22 或 24（LTS）；磁盘约 400–500 MB（素材、依赖与可选的本地提取贴图）。内存空闲约 100 MB，每局再加几 MB |
| 玩家 | 支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari 最新版），电脑、手机或平板（横屏） |
| 网络 | 首次进入游戏时，每位玩家要从开服的电脑下载几十 MB 素材（之后走浏览器缓存）；对局中流量很小 |

显卡较弱时可以在「设置」里调低画质，或在网址后加 `?board=2d`（强制 2D 棋盘）/ `?render=fallback`（不用 WebGL 的简化画面）。

#### 端口与配置

默认监听 **TCP 3000**。换端口：启动脚本加 `--port 3001`，或设置环境变量 `PORT`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` = 只允许本机，放在反向代理后面时使用） |
| `SP_COMBAT` | `client` | `client`：各玩家浏览器模拟自己的战斗（服务器负载极低）；`server`：由服务器模拟并推流 |
| `SP_VERIFY` | `off` | 服务器复算客户端上报的战斗结果：`off` / `sample`（约 1/8 抽查）/ `all`（全部复算，更耗 CPU） |
| `TRUST_PROXY` | `auto` | 是否信任 `X-Forwarded-For` 等转发头：`auto` 只信任来自本机 / 内网的代理；`1` 总是；`0` 从不 |
| `DEBUG` | 空 | 设为任意值输出详细日志 |
| `SP_NO_BROWSER` | 空 | 设为 `1` 时启动脚本不自动打开浏览器 |

设置方式：macOS / Linux `PORT=8080 npm start`；PowerShell `$env:PORT=8080; npm start`；cmd `set "PORT=8080" && npm start`。健康检查：`GET /healthz`。

#### 和朋友一起玩（局域网）

1. 打开页面 → 输入昵称 → **同盟模拟** → 创建房间。房主选择难度，可以添加 / 移除 AI 队友；开始前也可以把其他博士移出房间（对方可凭密钥重新加入）。
2. 把 4 位字母的**同盟密钥**，或「复制链接」得到的 `http://<地址>:3000/?room=密钥` 发给朋友。
3. 所有人点「准备就绪」后房主开始。
4. 同一 Wi-Fi / 路由器下的朋友打开启动窗口里列出的地址（形如 `http://192.168.x.x:3000`）即可。打不开时多半是防火墙：Windows 首次启动时在弹窗中允许「专用网络」，或运行 `npm run doctor` 查看具体命令；访客 Wi-Fi 常开启「AP 隔离」，也会导致连不上。

刷新页面或断线后，同盟模拟 10 分钟内、独立模拟 24 小时内重新打开即可回到原座位。服务器把房间和对局都保存在内存里，**重启服务器会结束所有对局**。

### 联机方式

朋友不在同一个局域网时，下面是几类常见做法，按自己的情况选一种即可。这里只做简单介绍，提到的工具和服务只是举例，本项目与它们没有任何关系，也不做推荐；具体的安装、费用和使用规则请以各自的官方说明为准。部署细节（防火墙、开机自启、反向代理与 HTTPS、Docker）见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

| 方式 | 怎么做 | 适合 |
|---|---|---|
| **同一局域网直连** | 把启动窗口里的局域网地址发给朋友 | 同一个家、宿舍或网吧 |
| **组网工具（虚拟局域网）** | 例如 Tailscale、ZeroTier、EasyTier、蒲公英：开服的人和朋友都安装同一个工具并加入同一个网络，朋友用开服电脑的虚拟 IP 访问 `http://<虚拟 IP>:3000` | 固定的几个熟人；不暴露到公网。朋友也要装客户端，部分工具需要注册账号；跨地区时可能走中继而变慢 |
| **内网穿透 / 隧道** | 只有开服的人运行客户端，朋友直接打开网址。例如自建的 frp（需要一台有公网 IP 的服务器）、Cloudflare 的 `cloudflared tunnel --url http://localhost:3000`（临时地址，每次启动都会变；国内访问延迟可能较高）、国内的樱花 frp 一类公共穿透服务（通常需要实名，大陆节点承载网页可能有备案要求） | 不想改路由器、没有公网 IP；免费线路带宽小时，首次加载素材会慢一些 |
| **云服务器 / VPS 直接部署** | 在 VPS 上运行整合包，或用仓库自带的 `Dockerfile`；用 Caddy / Nginx 加上 HTTPS。选离玩家近、线路好的地区（面向大陆玩家时，境外机房要关注回程线路，否则晚高峰延迟可能很高；大陆服务器绑定域名需要 ICP 备案） | 想长期开服、玩家分布在不同地区 |

通用注意事项：

- 游戏是**单个常驻 Node.js 进程 + WebSocket**（路径 `/ws`），只能跑一个实例，必须部署在域名根路径；Vercel 之类的 Serverless 平台和 GitHub Pages 之类的静态托管都不适用。反向代理要转发 WebSocket 升级。
- 游戏没有账号系统，**知道地址的人都能进来**。请只把地址发给朋友，不要公开发布，也不要搭建公开大厅；这同时能降低素材版权方面的风险。
- 有公网 IPv4 时也可以在路由器上做端口转发，但这会把家里的电脑直接暴露在公网上，优先考虑上面的方式。

### 操作

| 操作 | 方法 |
|---|---|
| 购买 / 升级调度中心 / 机变选卡 | 点一次选中，再点一次确认（`D` 升级） |
| 部署 / 移动干员 | 从整备区拖到棋盘格 → 出现方向轮盘 → 往上 / 右 / 下 / 左滑动选择朝向后松手；松在中心或点「✕ 点击取消」取消。拖动时模型在指针 / 手指下，指针所在的格子就是落点 |
| 调整朝向 | 把干员拖回它自己的格子，再选方向 |
| 出售 / 撤退 / 销毁装备 | 点击单位所在的格子 → 底部按钮「出售 +1」「撤退」；也可以把棋盘上的干员拖回整备区撤退。整备区里的装备与法术只能「销毁」，已配发的装备锁定在干员身上（干员出售或合成精锐时退回整备区） |
| 装备 | 把装备拖到干员所在的格子上（每人 2 件；满了会弹出替换窗口，被替换的一件会被销毁）；法术拖到地块上并选方向 |
| 查看详情 | 右键或长按单位 / 卡牌（属性为实时数值，高于基础值为绿色、低于为红色） |
| 快捷键 | `R` 刷新 · `F` 冻结 · `D` 升级 · `Space` 准备就绪 · `Esc` 取消 / 关闭 |
| 方向轮盘键盘操作 | 方向键预览 · `Enter` 确认 · `Esc` 取消 |
| 暂停（独立模拟） | 作战中（含最终攻势 / 隐秘核心）点顶栏的「暂停」或按 `Space`，再点「继续作战」（或 `Space`）继续；同盟模拟的作战不能暂停 |
| 表情 | 左下角「交流」，左右滑动（或方向键）换主题，冷却 1 秒 |
| 观战 | 自己的作战结束后（或休整期）点左侧队友头像 →「前往查看」；不参战的朋友可以在大厅输入同盟密钥点「观战」（每个同盟最多 2 名观战者，本作新增） |

完整的规则、数值和小技巧见 **[docs/PLAYING.md](docs/PLAYING.md)**（游戏内左下角也有「玩法说明」）。

## 文档

| 文档 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 更新记录：每个版本修复了什么、哪些反馈经核实不是问题 |
| [docs/EDITOR.md](docs/EDITOR.md) | **工坊编辑器**（可选、独立分发，游戏客户端不含它）：运行方式、界面、API、会写哪些文件 |
| [docs/WORKSHOP.md](docs/WORKSHOP.md) | **创意工坊与助战**（本项目新增）：工坊包格式与叠加规则、助战卡池与名额、作者接口、当前状态 |
| [docs/prompts/](docs/prompts/README.md) | **官方 Prompt（创作模板）**：把文件全文丢给任意 AI，加上你的数值与文字描述，就能产出本仓库直接能用的工坊内容。干员有完整的一份（含 60+ 黑板书键表），地图/怪物/出怪/装备/kit 的 spec 形状与推导规则在索引里 |
| [docs/PLAYING.md](docs/PLAYING.md) | 玩法指南：流程、经济、招募与晋升、摆阵、联防、盟约、最终攻势、结算称号 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署指南：Windows 开服与开机自启、防火墙、组网 / 隧道、反向代理与 HTTPS、Docker、systemd、排错 |
| [docs/WINDOWS.md](docs/WINDOWS.md) | Windows 便携包：怎么打一份「零安装」包（`scripts/make-windows-bundle.mjs`）、包里放了什么、授权注意事项 |
| [docs/DESIGN.md](docs/DESIGN.md) | 架构与契约（英文）：技术栈、目录分工、网络协议、渲染与 UI、各次试玩后的规则修订 |
| [docs/SIM.md](docs/SIM.md) | 战斗模拟引擎参考（英文）：钩子、技能描述格式、职业默认行为 |
| [docs/META.md](docs/META.md) | 对局与经济引擎（英文）：回合流程、商店、联防、最终攻势的实现细节 |
| [docs/DATA.md](docs/DATA.md) | 由官方数据表生成的游戏数据（英文） |
| [docs/ASSETS.md](docs/ASSETS.md) | 素材来源、目录结构与清单（英文） |
| [docs/BALANCE.md](docs/BALANCE.md) | 难度模型与测量（英文） |
| [docs/research/](docs/research/00-INDEX.md) | 官方规则、数据与界面的调研记录 |

## 开发与测试

```bash
npm run dev                 # node --watch：改动服务器代码后自动重启
node --test                 # 单元 + 集成测试（约 3870 项；缺少素材 / 浏览器的用例会自动跳过）
SP_E2E=1 node --test test/ui/mock.e2e.test.js        # 浏览器端到端测试，需要本机 Chrome（CHROME_PATH 可指定路径）
SP_REAL_E2E=1 node --test test/ui/real.e2e.test.js   # 需要 Chrome + 已下载的素材
RENDER_E2E=1 node --test 'test/render/*.browser.test.js'   # 渲染测试，部分需要本地提取的棋盘贴图
```

浏览器用例的两个前提（缺一个就整批静默 skip，看起来像「通过了」）：

- **`puppeteer-core`** 是 devDependency，`npm ci` / `npm install` 会装上；只 `npm ci --omit=dev` 就没有。
- **`CHROME_PATH`**：默认值写的是 macOS 的 Chrome 路径，所以 Windows/Linux 上必须显式指定，否则
  `existsSync(CHROME)` 为假，套件直接跳过。Windows 上系统自带 Edge 就能用：

  ```powershell
  $env:CHROME_PATH = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $env:SP_E2E = "1"; $env:RENDER_E2E = "1"
  node --test test/ui/mock.e2e.test.js
  ```

**等待约定**：浏览器用例一律用「导航到 `load` + 等一个语义条件」（`waitForSelector` / `waitForFunction`），
**不要用 `waitUntil: 'networkidle0'`** —— 它是个靠连接计数器收尾的启发式，Puppeteer 官方也不推荐，实测会让
某些页面（`phase=HIDDEN_CORE`）在 `readyState === 'complete'`、零失败请求、飞行中请求为空的情况下仍然等到超时。
需要「没有东西挂住」这条保证时，改成导航后显式断言「还有没有 HTTP 请求在飞」，并排除 WebSocket（长连接是正常的）。

- 游戏数据由 `npm run build-data`（`tools/build-data.mjs`）从官方数据表生成，不要手工修改 `data/*.json`。
- GitHub Actions（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 Ubuntu 与 Windows、Node 22 / 24 上运行 `npm ci`、`node --test` 和服务器冒烟测试。

## 项目结构

| 路径 | 内容 |
|---|---|
| `editor/` | **工坊编辑器**（独立工具，不在 `public/` 下，客户端拿不到） |
| `shared/` | 前后端共用的常量、网络协议与创作规则 `*Authoring.js` |
| `workshop/` | 工坊包（内容叠加层）；编辑器与 `workshop-scaffold.mjs` 写这里 |
| `tools/` | `setup.mjs` / `doctor.mjs`、素材下载 `fetch-assets.mjs`、数据构建、`workshop-editor.mjs` / `workshop-validate.mjs` / `workshop-scaffold.mjs`、本地提取 `local-extract/` |
| `server/` | Node HTTP 静态服务 + WebSocket（`/ws`）、大厅、对局引擎（`match/`）、战斗模拟（`sim/`，浏览器与服务器共用） |
| `public/` | 浏览器客户端（原生 ES 模块，PixiJS + pixi-spine、three.js 3D 棋盘、Preact + htm UI） |
| `data/` | 由官方数据表生成的游戏数据与素材清单 `assets.json`（以及助战卡池 `support.json`） |
| `scripts/` | 启动脚本（Windows / macOS / Linux）、Windows 开机自启 |
| `docs/` | 文档与调研 |
| `test/` | `node:test` 测试 |
| `third-party/` | **不属于本项目 GPL 范围的内容**（游戏素材、字体、由官方数据表生成的数据、调研与截图）的边界，以及把它们**单独打包上传**的出口：`node tools/export-third-party.mjs` → `third-party/bundle/`（已 gitignore）。见 [third-party/README.md](third-party/README.md) |

## 著作权声明

> [!NOTE]
> 本声明针对**用本编辑器创作的 Option（关卡、配置及其他创作内容）**，不改变本项目**代码**的 GPL-3.0-or-later 授权，也不附加任何限制 —— 代码部分只适用 GPL-3.0-or-later，见[许可证](#许可证)。
>
> 编辑器在每份保存的 Option 里自动写入 `_meta` 字段，把下列声明随文件一起带走（作者、创建时间、来源、著作权声明、反打包转售声明）；详见 [docs/EDITOR.md](docs/EDITOR.md)。

本编辑器（Stronghold-Protocol-Forge）生成的关卡文件、配置及其他创作内容（以下统称 “Option”），
其著作权归 **创建该 Option 的作者本人** 所有。

- 创作者可使用自己创作的 Option 进行分享、分发，并可通过其获得合理回报。
- 任何人不得未经授权，从公开渠道收集他人创作的 Option 并打包、转售、批量分发。
- 转载、整合或二次分发他人 Option，必须保留原作者署名与来源信息。
- 违反上述约定者，视为侵犯原作者著作权，原作者有权依法追究。

本声明不限制 Option 的自由分享与社区共创，仅禁止剽窃他人劳动成果并直接牟利的行为。

### Copyright Notice

All levels, configurations, and other creative content (collectively, "Options")
generated by this editor (Stronghold-Protocol-Forge) are the property of
**the respective author who created them**.

- Creators may share, distribute, and reasonably profit from their own Options.
- No one may, without authorization, collect Options created by others from
  public sources and package, resell, or bulk-distribute them.
- Any redistribution of another author's Option must retain the original
  author's attribution and source information.
- Violation of the above constitutes copyright infringement, and the original
  author reserves the right to pursue legal remedies.

This notice does not restrict the free sharing and community co-creation of
Options. It only prohibits the unauthorized packaging and resale of others'
work for direct profit.

## 上游来源与修改说明

本仓库（**Stronghold-Protocol-Forge**）是独立托管的**派生作品**：它不是 GitHub fork 网络中的一员，也没有关联任何上游 remote。它基于下列上游项目，并**整体按 GPL-3.0-or-later 分发**。

| 项 | 内容 |
|---|---|
| 上游项目 | **Stronghold-Protocol**（卫戍协议：盟约 · 非官方同人复刻） |
| 上游地址 | <https://github.com/sganggs/Stronghold-Protocol> |
| 本项目基于 | 上游 **v0.1.3** 的 Release 整合包（解压得到，不是 `git clone`）。因此**没有可对应的上游 commit hash 或 tag** —— 这是事实，不做推测。 |
| 改动时间 | 2026 年 10 月起，逐次提交见 `git log` 的提交日期 |
| 许可 | 整体 **GPL-3.0-or-later**，全文见 [LICENSE](LICENSE)；上游的版权与许可声明原样保留（[NOTICE.md](NOTICE.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)） |

### 取证方法与它的边界

本工作区是「解压整合包 → `git init`」，而且 `git init` 时本项目的工坊与编辑器**已经写完**。所以第一个提交（根提交）里同时装着上游原文和本项目成果，**git 历史无法把它们分开**。下面的清单由两类**可核实**的证据合成，并明确标出哪些是推断：

| 分类 | 依据 | 强度 |
|---|---|---|
| **A 本项目新增** | 不存在于根提交，由本仓库的提交创建 | 可核实（git） |
| **B 本项目修改** | 存在于根提交，且被本仓库的提交改动 | 可核实（git） |
| **C 工坊/编辑器功能区** | 路径与内容属于本项目新增的功能，但其中一部分在本仓库建立前就已完成，因而混在根提交里 | **推断**：无法逐字节比对（没有上游 checkout） |
| **D 其余** | 根提交中除 A/B/C 之外的文件 | **推断**：视为上游原文 |

### A. 本项目新增的文件

| 目录 | 文件 |
|---|---|
| `editor/ui/` | `enemy.html` `enemy.js` `item.html` `item.js` `pack.html` `pack.js` `wave.html` `wave.js` `voice.html` `voice.js` `stage3d.js` |
| `shared/` | `itemAuthoring.js` `kitAuthoring.js` `waveAuthoring.js` `forgeNotice.js` `zip.js` |
| `public/` | `css/screens/support.css` `js/screens/support.js` `js/ui/supportModel.js` `js/ui/supportSync.js` |
| `test/` | `itemAuthoring.test.js` `itemEditor.test.js` `kitAuthoring.test.js` `forgeNotice.test.js` `waveAuthoring.test.js` `support.test.js` `workshopAssets.test.js` `workshopStageRounds.test.js` `voiceEditor.test.js` `workshopVoices.test.js` `workshopSupport.test.js` `workshopPack.test.js` `packManager.test.js` `zip.test.js` |

### B. 本项目修改的上游文件

| 目录 | 文件 |
|---|---|
| 根目录 | `README.md` |
| `server/` | `index.js` `lobby.js` `stageAuthoring.js` `workshop.js` `match/Match.js` `match/PlayerState.js` `match/waves.js` |
| `shared/` | `stageAuthoring.js` `workshop.js` |
| `editor/` | `server.mjs` `ui/app.js` `ui/index.html` `ui/stage.html` `ui/stage.js` |
| `public/` | `index.html` `js/main.js` `js/screens/briefing.js` `js/screens/lobby.js` `js/screens/room.js` `js/screens/game.js` `js/ui/underframe.js` |
| `tools/` | `workshop-validate.mjs` |
| `docs/` | `ASSETS.md` `EDITOR.md` `WORKSHOP.md` |
| `test/` | `docs-consistency.test.js` `editor.test.js` `support.test.js` `ui/mock.e2e.test.js` `ui/devices.e2e.test.js` `ui/emotes.e2e.test.js` `ui/leftovers.e2e.test.js` `ui/playtest2.test.js` `ui/playtest2.e2e.test.js` `ui/playtest5-ui.e2e.test.js` `ui/playtest6-ui.e2e.test.js` `ui/feedback1-gaps.e2e.test.js` `ui/feedback1-secret-shop.e2e.test.js` `ui/feedback1-tactic.e2e.test.js` `render/flash.browser.test.js` `render/models.browser.test.js` |

改动内容以**工坊与助战**为主：内容叠加层的加载与合并（`server/workshop.js`、`server/data.js` 的注入点）、工坊内容的只读分发路由（`server/index.js`）、地图的回合作用域（`server/match/waves.js`）、助战卡池的服务端下发与客户端同步（`server/lobby.js`、`server/match/PlayerState.js`、`public/js/screens/support.js`、`public/js/ui/support*.js`），以及编辑器的六个页面。**游戏规则本身没有被改动**：战斗模拟、经济与回合流程保持上游行为，工坊只做内容叠加。

### C. 工坊与编辑器功能区（推断为新增）

这些路径承载本项目新增的功能；其中 `editor/`、`shared/chessAuthoring.js`、`shared/enemyAuthoring.js`、`shared/stageAuthoring.js`、`shared/workshop.js`、`server/workshop.js`、`server/stageAuthoring.js`、`tools/workshop-*.mjs`、`docs/WORKSHOP.md`、`docs/EDITOR.md`、`docs/prompts/operator-pack.md`、`docs/examples/**`、`workshop/README.md`、`test/{chess,enemy,stage}Authoring.test.js`、`test/workshop*.test.js` 属于本项目功能，但**它们在本仓库建立之前就已完成**，所以与上游原文一起落在根提交里 —— 本仓库无法逐字节证明这一点。

同理，根提交里的 `shared/support.js`、`data/support.json`、`server/sim/content/support/**`、`test/content/bonds_support.test.js` 涉及**助战**。本项目新增的是「卡池由服务端控制、客户端同步」这一层；上游是否已有同名/同路径的支援机制，本仓库无法逐字节判定，故不在此断言归属。

### D. 未改动的部分

上述 A/B/C 之外，`server/`、`public/`、`data/`、`test/`、`tools/`、`docs/`、`scripts/` 下的其余文件均视为**上游原文**，未作修改，版权与许可声明原样保留。

### 源码获取

**本仓库即为完整对应源码**（Corresponding Source）：编辑器、工坊叠加层、校验工具与其测试都在这里，构建与运行方式见[快速开始（编辑器）](#快速开始编辑器)。游戏素材与 `data/*.json` 的获取方式见 [NOTICE.md](NOTICE.md) 与 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 许可证

- **代码**：本项目自己编写的代码以 **GPL-3.0-or-later** 发布，全文见 [LICENSE](LICENSE)；另附一条 GPL 第 7 条的附加许可，允许与 pixi-spine 中的 Spine Runtimes 组合分发（见 [NOTICE.md](NOTICE.md)）。
- **游戏素材不在许可范围内**：《明日方舟》相关的美术、音乐、音效、文本与数据等版权归原权利人所有，不适用 GPL，使用限制见上方的[声明](#声明)和 [NOTICE.md](NOTICE.md)。
- **第三方组件**各自遵循其许可证：通过 npm 安装的库（整合包的 `node_modules` 中附带各自的许可证文件）、`tools/local-extract/aklz4.py` 的算法（BSD-3-Clause），以及字体等，清单与许可证全文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 致谢与数据来源

- 游戏数据：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)。
- 素材来源：[yuanyan3060/ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)、[fexli/ArknightsResource](https://github.com/fexli/ArknightsResource)、[isHarryh/Ark-Models](https://github.com/isHarryh/Ark-Models)、[ArknightsAssets/ArknightsAssets2](https://github.com/ArknightsAssets/ArknightsAssets2)；字体来自 [TimWangZi/The-font-of-Arknights](https://github.com/TimWangZi/The-font-of-Arknights) 与 Google Fonts（Noto Sans SC）。详见 [docs/ASSETS.md](docs/ASSETS.md)。
- 规则核对参考：[PRTS 明日方舟中文 Wiki](https://prts.wiki/)。
- LZ4AK 解包：`tools/local-extract/aklz4.py` 的算法来自 [isHarryh/Ark-Unpacker](https://github.com/isHarryh/Ark-Unpacker)（BSD-3-Clause，经 MooncellWiki/UnityPy）；解析 Unity 资源使用 [UnityPy](https://github.com/K0lb3/UnityPy)（MIT）。
- 库：[PixiJS](https://pixijs.com/)（MIT）、[pixi-spine](https://github.com/pixijs/spine)（MIT；其中包含的 Spine Runtime 另受 [Spine Runtimes License](https://esotericsoftware.com/spine-runtimes-license) 约束）、[three.js](https://threejs.org/)（MIT）、[Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm)（MIT）、[ws](https://github.com/websockets/ws)（MIT）。

感谢以上项目的作者与维护者，以及鹰角网络带来的这款游戏。

## 贡献

欢迎提 Issue 反馈 bug、与官方规则不一致的地方或改进建议，也欢迎提交 Pull Request：

- 提交前请运行 `node --test`，并同步更新相关文档；文档使用简体中文，代码与注释使用英文。
- 提交的代码将以 GPL-3.0-or-later 发布。
- 请不要提交任何游戏素材文件（`public/assets/` 等目录已被 `.gitignore` 排除）。
- 本项目坚持非商业：请不要提交广告、付费、打赏等任何形式的变现功能。

---

## English

This repository is **Stronghold-Protocol-Forge**: a standalone, out-of-game **graphical authoring tool (the Forge editor)** for the content of the fan remake of Arknights' seasonal auto-chess tower-defense mode *Stronghold Protocol: Alliance* — plus that bundled upstream game itself.

- **The Forge editor (what this repo is for):** run `npm run editor` and open <http://127.0.0.1:3311> — no build step, no game-server change, bound to loopback by default. Eight pages author operators (`/`), maps (`/stage.html`, 19×21 grid with 2D placement and a 3D preview), enemies (`/enemy.html`), spawn waves (`/wave.html`), items (`/item.html`), behaviour-layer kits (`/kit.html`), a pack's voice lines (`/voice.html`) and the pack itself (`/pack.html`: export to a `.zip`, import someone else's, tick which of the pack's own operators enter the 助战 pool, and start a playtest server that opens straight into a solo run). Mechanical fields are always derived from the real engine rather than typed by hand, and `tools/workshop-validate.mjs` re-checks every pack in layers (format → semantics → the real engine → kits / maps / enemies / waves / items / voice lines / 助战) through the same `shared/*Authoring.js` rules the editor and CLI use, so the rules cannot drift. Saved Options carry a `_meta` attribution block. See [docs/EDITOR.md](docs/EDITOR.md) and [docs/WORKSHOP.md](docs/WORKSHOP.md).
- **The bundled game:** an **unofficial, non-commercial fan remake** played in the browser: solo, or 1–4 player co-op (AI teammates can fill seats). Combat is simulated in each player's browser, so a low-power PC can host. Download the all-in-one bundle from [Releases](../../releases/latest), install Node.js 22 or 24, then double-click `scripts\start-windows.bat` (Windows) or run `./scripts/start.sh` (macOS / Linux) and open <http://localhost:3000>. From source: `npm install && npm run setup && npm start` (setup downloads ~270 MB of art from public mirrors, the emotes and the how-to-play pages included; the official 3D board, some official HUD icons and two enemy models are extracted from a local Arknights client — without one the game uses the 2D board and look-alike stand-ins, and a server can copy `public/assets/local/` and `data/local-assets.json` from the release bundle of the same version). Create a co-op room and share the 4-letter key or the `?room=KEY` link; on a LAN use the address printed at start, otherwise a virtual-LAN tool, a tunnel or a VPS — see [docs/DEPLOY.md](docs/DEPLOY.md).
- **Disclaimer:** not affiliated with or endorsed by Hypergryph or Yostar. All Arknights names, art, audio, text and data are © their respective owners and are **not** covered by this project's GPL licence. For study and personal non-commercial use only — no selling, paid distribution, paid servers or monetisation of any kind. Content will be removed on request of the rights holders. Provided "as is", without warranty.
- **License:** code GPL-3.0-or-later ([LICENSE](LICENSE)); game assets excluded.
