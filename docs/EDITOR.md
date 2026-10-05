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

- **左栏**：工坊包列表 → 该包的干员列表。可编辑的干员（有 spec）与「非编辑器管理」的记录分开显示。
- **表单**：身份（id/名称/阶/职业/分支/位置）、外观（复用已有 Spine id）、**普通与精锐两套数值**、技能（含黑板书键值编辑器）、以及**「是否助战」开关**（直接写入服务端助战卡池）。
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
- 保存后同样需**重启游戏服务器**才生效。

命令行等价路径（同一套推导）：

```powershell
node tools/workshop-scaffold.mjs docs/examples/stage-spec.json --pack map-demo   # spec → 推导 → 写 stages.json
node tools/workshop-validate.mjs workshop                                        # 含 stages 层：重算并比对路径表
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

## 当前不包含

- **行为层脚本**（`kits/<chessId>.js`）的编辑——kit 目前手写文件
- **怪物 / 出怪表 / 装备**的编辑页签（数据层叠加已就绪；作者层与界面待做，见 [WORKSHOP.md](WORKSHOP.md)）
- 地图的 **3D 视图**（项目自带 `public/js/render/board3d/`；2D 为先，接口预留）
- 助战**名额**（`slots`）的编辑——目前改 `data/support.json` 的 `slots` 字段
- 任何鉴权

## 与其它工具的关系

| 工具 | 面向 | 关系 |
|---|---|---|
| `editor/`（本文件） | 人，图形界面 | 写 spec，生成记录 |
| `tools/workshop-scaffold.mjs` | 人 / 脚本 / AI | 同样的 spec → 同样的记录（无界面） |
| `tools/workshop-validate.mjs` | 人 / CI / AI | 三层校验（格式 → 语义 → 真实引擎） |
| `docs/prompts/operator-pack.md` | 任意 AI | 模板 prompt，让 AI 产出 spec |

四者共用 `shared/chessAuthoring.js`，所以**规则不会漂移**。
