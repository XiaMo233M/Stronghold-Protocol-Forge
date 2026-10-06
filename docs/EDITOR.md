# EDITOR.md — 工坊编辑器（可选、独立分发）

工坊编辑器是一个**独立的本地工具**，用来创建和编辑工坊内容。它**不是游戏的一部分**：游戏服务器不会加载它，
网页客户端与后续打包的 APK 也不会包含它。

## 为什么这样分发

| 事实 | 含义 |
|---|---|
| 代码位于仓库根的 `editor/`，**不在 `public/` 下** | `server/index.js` 只挂载 `/data/`、`/shared/`、`/sim/` 和 `public/`，所以游戏服务器在结构上**无法**把一个字节的编辑器发给客户端 |
| 没有任何游戏客户端代码 import 它 | `test/editor.test.js` 会扫描 `public/js`、`shared/` 与 `public/index.html`，出现引用即失败 |
| 只有显式运行才启动 | `node tools/workshop-editor.mjs` —— 这就是「option 方式分发」：不运行就不存在 |
| 无构建步骤、无新依赖 | 纯 Node `http` + 原生 ES 模块 UI，和主项目一样的风格 |

## 运行

```powershell
node tools/workshop-editor.mjs                    # 打开 http://127.0.0.1:3311
node tools/workshop-editor.mjs --port 3400 --open # 换端口并自动打开浏览器
node tools/workshop-editor.mjs --workshop D:\packs # 指定其它工坊目录
```

**默认只绑定 `127.0.0.1`**，因为编辑器可以写文件。绑定到局域网地址需要显式 `--host 0.0.0.0`，此时会打印警告。
编辑器**没有登录、没有权限控制**：不要暴露到公网。

## 它会写哪些文件

| 路径 | 说明 |
|---|---|
| `workshop/<pack>/specs/<slug>.json` | **编辑器的源文件**：你填的那份 spec，可反复编辑 |
| `workshop/<pack>/chess.json` | **生成产物**：由 specs 推导出来，游戏读的是它。请不要手改（和 `data/*.json` 同样的态度） |
| `workshop/<pack>/pack.json` | 首次保存时自动创建（`id` 必须等于目录名） |
| `data/support.json` | 只在动「是否助战」开关时修改——它是**手工维护的服务端配置**，不是 `build-data` 的产物 |

`data/` 下由 `tools/build-data.mjs` 生成的其它文件**永不改动**。

**安全的合并规则**：`chess.json` 里**没有对应 spec** 的记录会被原样保留。所以用
`tools/workshop-scaffold.mjs` 或手工写的包，不会被编辑器破坏。

## 界面

编辑器共四个页面，右上角可互相跳转：

| 页面 | 用途 |
|---|---|
| `/` | **干员**编辑器（下栏详述） |
| `/stage.html` | **地图**设计器（2D 摆放器 + 路线） |
| `/enemy.html` | **怪物**编辑器（数值 + 特殊机制） |
| `/wave.html` | **出怪**设计器（时间轴 + 明细表） |

### 干员编辑器（首页）

- **左栏**：工坊包列表 → 该包的干员列表。可编辑的干员（有 spec）与「非编辑器管理」的记录分开显示。
- **表单**：身份（id/名称/阶/职业/分支/位置）、外观（复用已有 Spine id）、**普通与精锐两套数值**、**技能**（技能名/类型/持续类型/技力消耗/初始技力/持续时间/技力回复/自动释放触发/官方技能描述，外加**黑板书键值编辑器**）、**天赋**（0~2 条，每条含天赋名、说明、黑板书）、以及**「是否助战」开关**（直接写入服务端助战卡池）。
- 天赋的**说明是必填的**：没有说明的天赋在生成的记录里会被标记为 `hidden` —— 也就是说它什么都不做。编辑器会在提示里写明，`test/editor.test.js` 锁住了这条。
- 黑板书键必须是通用 kit 认识的键（见 `docs/prompts/operator-pack.md` 的表格）。写了不认的键**不会报错，但也不会有任何效果**——校验只给警告。
- **实时校验**：每次改动都会调用 `/api/preview`，用与 CLI、AI 完全相同的 `shared/chessAuthoring.js` 规则给出错误与警告，并显示**将要生成的记录**。
- 保存后需**重启游戏服务器**才会出现在游戏里。

## 地图设计器（2D 摆放器）

编辑器里有第二个页面：**`/stage.html`**（干员编辑器右上角有入口）。它是 WebGL 之外的纯 Canvas 2D 摆放器 —— 19×21 网格，用现有地形配色绘制。

**它只编辑「作者能画的东西」**：`rows`（网格）、`tiles`（字符→地形图例）、`devices`（装置）。
其余字段**全部由服务端推导**，绝不手写 —— 因为 `groundPaths` / `groundPathsWithDevices` / `deployTiles` 是
模拟器自己的寻路算出来的（`server/stageAuthoring.js` 复用 `server/sim/grid.js`），手写会让寻路与地图不一致。

- **调色板**：`shared/stageAuthoring.js` 的 `TILE_PALETTE`（道路 / 地面 / 高台 / 阻隔 / 围栏 / 入口 / 目标 / 传送 / 沼泽 / 毒雾 / 深水区 / 源石污染），单击选笔刷。
- **工具**：画笔 / 放装置 / 擦除。装置可选 crate、platform、mound、blower、mireController、turret；「隐藏」的装置在对局开始时不存在（由效果打开）。
- **覆盖层**：**显示部署区**（绿=近战位、蓝=远程位，直接来自推导结果）与**显示寻路**（12 条路线的流场折线）。
  这两层就是「所见即引擎所算」：画什么地形，右侧立刻显示这样会导出什么路径与部署位。
- **模式**：必须至少勾选一个。地图只有出现在某个模式的 `stages` 列表里才能被选中，而 `config` 不允许工坊改写 ——
  加载器会把地图自己声明的 `modes` 追加进去（`shared/workshop.js linkStages`），其余 config 字段一律不动。
- **路线（出生点 → 防守点）**：选「画路线」工具后依次点击网格 —— 第一下是起点（城门 `S`），中间是检查点，最后按「完成路线」收尾。
  可选 `WALK`（走地面，**按模拟器的流场寻路**）或 `FLY`（直线飞）。画布上画的是**推导出的实际走法**，不是折线示意：
  寻路不通时会标红「无路可走」并在校验里给 `ROUTE_NOPATH`。起点不在城门、终点不在保护目标只给**警告**（传送门与领袖出生点合法）。
  路线存在**工坊包的 spec** 里；引擎的 `routes` 属于出怪表（`data/waves.json`，由 `spawns[].routeIndex` 选中），
  下一步的出怪编辑器会把这张图的路线绑定到回合上。
- **`row 0` 是最下面一行**（与引擎存储一致），画布上已标注行号。
- **3D 预览**：点工具栏的「3D 预览」把当前地图放进**游戏自己的 3D 渲染器**（`public/js/render/board3d`）。
  渲染的就是游戏的代码、你这张图的数据 —— 所以它不可能和玩家看到的跑偏，正如路径表由 `server/sim/grid.js` 推导而不是重写。
  也可以直接用 `?board=3d` 打开（沿用游戏客户端的写法，`public/js/app.js`）。
  - 拖动平移 · 滚轮缩放 · Shift+拖动（或右键拖动）调俯角。这是固定朝向的投影相机，没有偏航可给。
  - **没有本地素材就自动退回 2D**，并说明原因（没装官方棋盘图集 / 没有 WebGL2 / three.js 没加载 / 素材包不完整），
    与游戏客户端的探测链一致（`board3d/load.js`）。
  - 它需要三条**只读**通路：`/client/**`（客户端模块）、`/vendor/**`（three.js）、`/assets/**`（棋盘素材），
    外加 `/data/local-assets.json`。编辑器默认只绑 127.0.0.1；只服务白名单扩展名，`..` 与点开头段一律拒绝，
    而且**不会**变成通用文件服务器（`/data/chess.json` 仍是 404）。
- 保存后同样需**重启游戏服务器**才生效。

命令行等价路径（同一套推导）：

```powershell
node tools/workshop-scaffold.mjs docs/examples/stage-spec.json --pack map-demo   # spec → 推导 → 写 stages.json
node tools/workshop-validate.mjs workshop                                        # 含 stages 层：重算并比对路径表
```

## 怪物编辑器

第三个页面：**`/enemy.html`**。同样是"只编辑人能给的东西，机械字段一律推导"。

- **身份**：id（生成 `enemy_ws_<id>`）、名称、rank、攻击方式、伤害类型、移动方式、描述
- **数值**：17 项 stats（生命/攻击/防御/法抗/移速/攻击间隔/攻速/射程/阻挡/重量/回复…）
- **特殊机制**：`abilities`（游戏里显示的能力说明，一行一条）、`talents.bb`（天赋黑板键值）、`skills`（JSON，
  形如 `{ prefabKey, priority, cooldown, bb }`）、`acType`、`tags`、五项免疫
- **美术与非数据表字段**：这些**不在游戏数据表里**（来自客户端清单），必须手填 —— `spine`（复用现有 prefab 键才有真美术）、
  `modelScale`、`hitArea`（受击框）、`attackAnim`
- **派生量只读显示**：`attrPower` 与 `be` 由服务端按数值实时算出。**`be` 决定阵营换怪时替换多少只**，所以它必须算，不能手填
- 保存写 `<pack>/enemy-specs/<slug>.json`（源）并重新生成 `<pack>/enemies.json`（产物）

命令行等价路径：

```powershell
node tools/workshop-validate.mjs workshop     # enemies 层：重算 be/attrPower 并比对
```

## 助战（客户端）

助战的选择由**服务端**声明并强制：卡池之外的干员是**禁用**的，请求会被整条拒绝，**没有回退**（回退会让一个被禁用的干员变成已发放）。

- 服务端在 `room.state` 里下发卡池目录（`enabled` / `label` / `tiers` / `capacity` / `slots`）—— 客户端无法自行得知卡池
- **界面**：`js/screens/support.js`（房间 / 大厅 / 简报室左下角「助战」按钮）—— 按阶列出卡池，每阶显示「已选 n/m」，
  顶部显示同步状态。**卡池没到就显示「等待服务器下发」而不是猜**；服务器没开助战就显示「本服务器未开启助战」
- 客户端 `ui/supportModel.js` + `ui/supportSync.js`：卡池未知时**等待不发**；被拒绝时**报错并保留玩家选择**
- 对局开始后 `room.state` 的助战会锁定，改动在下一局生效
- **随机禁用的干员不禁用助战**：随机禁用只影响商店抽卡（`server/match/pool.js`），被禁的干员作为助战照样发放
  （以 0 份入库，与"效果发放"同一规则；`test/support.test.js` 锁住了这条）
- 局内 `m.private.support` 回显 `{ selected, granted }`：卡池在开局前变化导致「选了但没发到」时客户端能解释

## 出怪设计器（时间轴）

第四个页面：**`/wave.html`**。它有两半，因为两半都必要：

- **时间轴**：每次出怪一条泳道，横轴是秒，方块宽度 = 这次出怪从第一只到最后一只能持续多久
  （`time + (count-1) × interval`）。颜色按排期槽位（N/E/S/T 系）区分，`不计入总数` 的出怪画成虚线半透明。
  哪一次先出、出多久、隔多久，一眼就能看出来。
- **明细表**：数值真正在这里输入 —— 时间 / 敌人 / 数量 / 间隔 / 路线 / 槽位 / 不计入。画布拖动是锦上添花，精确的输入框不是。
- **敌人是下拉选择**，选项来自合并后的敌人表（官方 249 只 + 工坊自己写的怪物），不用手打键名
- **路线**：这张出怪表自己带的路线列表（起点/终点/检查点）。地图只做参照 —— 上方选了哪张地图就画它的路线，并标出 `#序号`，
  因为 `spawns[].routeIndex` 索引的正是这个序号
- **绑定到回合**：记录意图（哪个模式的第几回合）。真正生效是在**地图设计器**里给地图写 `rounds` 指向它（方案 B）——
  这样官方地图完全不受影响
- **推导量只读**：`totalCount` 与 `slotCounts` 由服务端算。注意两者**不对称**：`slotCounts` 计入 `unharmful` 的出怪，
  `totalCount` 不计入 —— 这是 `build-data` 的原样行为

命令行等价路径：

```powershell
node tools/workshop-validate.mjs workshop     # waves 层：重算 totalCount/slotCounts，
                                              # 并检查每只敌人的键是否存在、routeIndex 是否越界
```

## API（供二次开发）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 工坊包、干员、校验问题、助战配置、可选用的官方 Spine 列表 |
| POST | `/api/preview` | `{ spec }` → 推导并校验，**不写盘** |
| POST | `/api/packs/:pack/operators` | `{ spec }` → 写 specs 并重新生成 `chess.json` |
| DELETE | `/api/packs/:pack/operators/:slug` | 删除 spec 及其拥有的记录 |
| POST | `/api/support/toggle` | `{ chessId, tier, enabled }` → 增删 `data/support.json` 的卡池 |
| GET | `/api/stages` | 工坊地图列表 + 调色板 + 网格尺寸 + **可指派的模式列表** |
| GET | `/api/stages/:pack/:id` | 该地图的**可编辑 spec**（源）与生成的记录 |
| POST | `/api/stages/preview` | `{ spec }` → 推导路径与部署区并校验，**不写盘** |
| POST | `/api/packs/:pack/stages` | `{ spec }` → 写 `stage-specs/` 并重新生成 `stages.json` |
| DELETE | `/api/packs/:pack/stages/:id` | 删除该地图的 spec 及它拥有的记录 |
| GET | `/api/enemies` | 工坊怪物列表 + **枚举词表** + 官方怪物键 |
| GET | `/api/enemies/:pack/:key` | 该怪物的**可编辑 spec**（源）与生成的记录 |
| POST | `/api/enemies/preview` | `{ spec }` → 推导 `attrPower`/`be` 并校验，**不写盘** |
| POST | `/api/packs/:pack/enemies` | `{ spec }` → 写 `enemy-specs/` 并重新生成 `enemies.json` |
| DELETE | `/api/packs/:pack/enemies/:key` | 删除该怪物的 spec 及它拥有的记录 |
| GET | `/api/waves` | 工坊出怪表列表 + 词表 + **可选敌人键** + 模式 + 地图（含各自带的回合） |
| GET | `/api/waves/:pack/:id` | 该出怪表的**可编辑 spec**（源）与生成的记录 |
| POST | `/api/waves/preview` | `{ spec }` → 推导 `totalCount`/`slotCounts` 并校验，**不写盘** |
| POST | `/api/packs/:pack/waves` | `{ spec }` → 写 `wave-specs/` 并重新生成 `waves.json` |
| DELETE | `/api/packs/:pack/waves/:id` | 删除该出怪表的 spec 及它拥有的记录 |

## 当前不包含

- **行为层脚本**（`kits/<chessId>.js`）的编辑——kit 目前手写文件
- **装备（items）**的编辑页签（数据层叠加已就绪；作者层与界面待做）
- 助战**名额**（`slots`）的编辑——改 `data/support.json` 的 `slots` 字段或编辑器里的「是否助战」开关
- 任何鉴权

## 与其它工具的关系

| 工具 | 面向 | 关系 |
|---|---|---|
| `editor/`（本文件） | 人，图形界面 | 写 spec，生成记录 |
| `tools/workshop-scaffold.mjs` | 人 / 脚本 / AI | 同样的 spec → 同样的记录（无界面） |
| `tools/workshop-validate.mjs` | 人 / CI / AI | 三层校验（格式 → 语义 → 真实引擎） |
| `docs/prompts/operator-pack.md` | 任意 AI | 模板 prompt，让 AI 产出 spec |

四者共用 `shared/chessAuthoring.js`，所以**规则不会漂移**。
