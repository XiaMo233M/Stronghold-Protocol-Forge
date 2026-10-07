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

**一键**（双击 / 直接跑脚本，首次自动装依赖，然后打开浏览器）：

```
scripts\start-editor-windows.bat          # Windows：双击，或加上参数  --port 3400
./scripts/start-editor.sh                 # macOS / Linux
```

用发行页的零安装整合包时是包根的 `启动编辑器.bat`（游戏是 `启动游戏.bat`）。手动启动：

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
| `workshop/<pack>/kits/<chessId>.js` | **行为层 kit**：它既是源、也是游戏加载的产物（见下面「kit 编辑器」），保存时会在文件开头补写署名头 |
| `workshop/<pack>/pack.json` | 首次保存时自动创建（`id` 必须等于目录名）；**语音编辑器就地更新它的 `voices` 字段**，**包管理页就地更新它的 `support` 字段**，其余字段、键序与缩进原样保留 |
| `workshop/<pack>/**` | **导入一个 `.zip`** 时整包写入（新建目录；覆盖同名包需要显式 `--force`/`?force=1`，且写入全部在这个目录之内） |
| `data/support.json` | 只在动「是否助战」开关时修改——它是**手工维护的服务端配置**，不是 `build-data` 的产物 |

`data/` 下由 `tools/build-data.mjs` 生成的其它文件**永不改动**。

**安全的合并规则**：`chess.json` 里**没有对应 spec** 的记录会被原样保留。所以用
`tools/workshop-scaffold.mjs` 或手工写的包，不会被编辑器破坏。

## 界面

编辑器共九个页面，右上角可互相跳转：

| 页面 | 用途 |
|---|---|| `/` | **干员**编辑器（下栏详述） |
| `/stage.html` | **地图**设计器（2D 摆放器 + 路线） |
| `/enemy.html` | **怪物**编辑器（数值 + 特殊机制） |
| `/wave.html` | **出怪**设计器（时间轴 + 明细表） |
| `/item.html` | **装备**编辑器（一件装备 = 一个 spec = 两条记录） |
| `/bond.html` | **盟约（羁绊）**编辑器（新增盟约，或**覆盖官方 23 条**的阈值 / 计数 / 说明 / 黑板数值 + 成员） |
| `/kit.html` | **kit（行为层）**编辑器（直接编辑 `kits/<chessId>.js` 的代码，静态校验） |
| `/voice.html` | **语音**编辑器（`pack.json` 的 `voices` 字段：干员 × 槽位 × 文件） |
| `/pack.html` | **包管理**（导出/导入 `.zip`、`pack.json` 的 `support` 助战声明、**一键试玩**） |

五个内容页（地图 / 怪物 / 出怪 / 装备 / 盟约）的侧栏或右栏都有一个**保存目标**下拉：列出所有工坊包（id 与 `pack.json` 里的名字），
选好再保存。以前每次保存都要在对话框里手打一次包 id —— 打错就是存进别的包，或者凭空建一个空包。
只有选「＋ 新建一个包…」时才问一次新包的 id（那一步确实只能问）。

### 界面语言（中英双语）

右上角有一个 `EN` / `中文` 按钮，**默认中文**。选择记在 `localStorage`，也可以用 `?lang=en` 直接把链接发给别人。

- 词典以**中文原文为键**（`editor/ui/i18n.en.*.js`）：中文界面不需要维护任何对照表，英文只写「中文 → 英文」。
  **缺译文时退回中文**，而不是显示 `pack.newOperator` 这种 key 名或一片空白。
- HTML 里的静态文案用 `data-i18n`，元素里保留中文原文当兜底：脚本没跑起来时页面是中文。
- 词条按页分片；**两个以上页面共用的词条放 `i18n.en.shared.js`** —— 放在某一页里，那一页收尾删词条时
  会把别的页面悄悄退回中文，而当场没有测试会发现。
- `kit` 页的页面脚本有一条「不许 import 任何东西」的安全断言（那一页直接编辑并展示作者的 kit 源码），
  所以它通过 `i18n.global.js` 从 `globalThis` 取接口，保持零 import。
- 加了文案就要补译文：`test/editorI18n.test.js` 会扫源码，**漏一条、多一个死键、分片之间重复键**都会失败。

### 干员编辑器（首页）

**表单分段、可折叠，顶上有一条「跳到」**：干员页已经长到十段（身份 / 外观 / 范围·分类 / 数值 / 技能 / 天赋 /
精锐 / 模组 / 盟约 / 校验），所以「找不到」是它的第一号可用性问题。做法是标准的那两条：
不常改的段落（精锐 / 模组 / 盟约）默认收起（渐进披露），顶部「跳到」条一点就展开并滚过去
（收起的分段会先展开再滚，滚动放在下一帧，因为重画之后 DOM 才存在）。折叠状态记在 `state.sections` 里 ——
表单每 250ms 自动校验重画一次，状态放在 DOM 上会被抹掉。

- **左栏**：工坊包列表 → 该包的干员列表。可编辑的干员（有 spec）与「非编辑器管理」的记录分开显示。
- **新建有两条路**：`＋ 新建干员` 从空白表单开始；**`⧉ 以模板新建`** 从官方干员（112 位可见干员，可搜名称/代号/id）
  或本包已有干员复制一份底子 —— 数值、职业、分支、**攻击范围**、技能（含黑板）、天赋、外观一次填好，
  只需填新 id 与名字。**模板不会带 id**：顺手复制原 id 会直接撞官方 id，记录会被引擎丢弃。
- **职业 → 分支联动**：官方数据里 57 个分支各归一个职业（没有一个是跨职业的），所以分支下拉**只列当前职业允许的分支**，
  改职业立刻换清单；计数报的是**这个职业真实的分支数**（狙击就是 7 个，不算留在清单里的旧值）。
  当前值不属于新职业时**不静默清空**：它留在下拉里，并有一条说明
  「这个分支不属于「术师」，它属于 狙击……它留在下拉里，不会被自动清掉」——记录能保存，但职业光环与分支行为可能对不上。
  手填一个官方分支表里没有的 id 时给同一句保证（这时没有「它属于谁」可说）。
  手填框仍然保留（官方没有的分支也能写）。`/api/state.subProfessions` 从**全部**记录算出，
  所以只在一条不可见记录上出现的 `pusher`（推击手）也能选到 —— 从可见干员推就会漏掉它。
- **数值参照尺子**：每个数值下面一条细线，标出官方同职业的 min–中位–max 与当前值落点，越界时变色并写明。
  它是参照不是上限 —— `/api/state` 的 `statRanges` 按职业统计，页面只负责画。
  每栏还有一个**「按官方中位填入」**按钮：白纸起手最劝退的就是「这八个数字该填多少」，一键落进官方中位即可开改
  （普通与精锐各有自己的按钮，因为两套数值本来就是分开填的）。
- **攻击范围：预设之外可以自己画**。预设下拉列的是官方出现过的形状（每种标一个用过它的干员当例子，
  例如「10 格 · 例：能天使」），旁边就是**画板**：7×9 格（x∈[-3,3]、y∈[-2,6]，官方 258 条带范围的记录都画得下），
  点格子点亮/点灭，底纹是推导出来的形状，所以一眼看得见自己改动了哪几格。格子是 `<button>`（键盘可达），
  原点那一格去不掉（干员必须站在自己的范围内；空范围谁都打不到而引擎不会报错）。
  画出来的就是记录里的 `rangeGrid`，**五处范围字段共用这一套**（干员范围 / 干员特性范围 / 精锐特性范围 /
  模组特性范围 / 天赋改写范围）—— 所以「特殊情况」在哪儿都能自己画，不再只有主范围能改。
  画板装不下的超大范围（模板带来或手写）不会被丢掉：数字上会说明还有几格在板外，它们原样保留。
- **攻击分类的覆盖**（「特殊情况才用」那一段）：`dmgType` `attackKind` `projectile` `canHitFly` 四项都能钉住，
  留空＝用推导值；下拉的第一项永远写着「（推导：物理）」这类结果，所以作者看得见自己放弃了什么。
  钉住的值与原推导不同时，校验会给一条 `CLASS_OVERRIDE` 警告（是提醒，不是错误：官方特例确实存在）。
  **四项互不牵连**：只钉 `dmgType` 时 `projectile` 仍按推导值走 —— 下方「记录里会写」那一行显示的就是这个组合的结果。
- **模组（`modules`）**：只有精锐记录会读它。每张模组卡可编 id / 名称 / 类型 / 图标 / 等级 / **数值加成**
  / 特性覆盖（含**特性自带范围**）/ 天赋改写（每条改写可带**自己的范围**，官方「攻击范围扩大」的模组靠它），可增删；
  **默认模组只有一个**（勾一个会自动取消另一个，两个默认是校验错误）。
  面板上有一行「当前默认模组 → 精锐记录里写下去的数值」，用的是引擎自己的 `composeStats()`（`shared/loadoutRecord.js`），
  所以「加了模组之后是多少」和游戏里算出来的必然一致。`attr` 的键是下拉（`MODULE_ATTR_KEYS` 的 8 个真键，有数据漂移守卫）——
  写错键名不会报错，但一个数值也不加。
- **特性自带范围**：特性自己那片范围（不是干员的攻击范围，引擎里由特性定义 —— 例：散射手用它定义正面那一圈）。
  身份面板里有一个「特性自带范围」下拉，留空＝没有；精锐那一份要不一样就在「精锐特性不同」勾上之后再设一个。
  官方 4 位干员的特性、6 个模组的特性覆盖用到它，与模组卡里的同名字段是同一套实现。
- **盟约（`bonds`）**：官方的 23 条 + 本包自己写出来的盟约（标「本包」），可搜索、可勾选；
  模板带过来的官方盟约默认勾着，取消即退出。查不到的 id 会当场警告（能保存，但游戏里不会有任何效果）。
- **精锐（精英 2）与普通不同时**：数值一直是两套（上面那两个面板），而**特性、天赋、攻击范围**在 spec 里是
  **可选**的第二份 —— 官方 112 位可见干员里有 33 位两态天赋不同、2 位精锐特性不同、2 位精锐攻击范围不同。
  所以这一块是三个开关：**不勾就是两态共用一份**（字段根本不写），勾上时以普通那一份为起点，取消勾选回到共用。
  留一份与普通一模一样的副本会让 spec 变脏，也让「精锐到底改了什么」看不出来。
- **保存旁边就能起一局试玩**：`▶ 试玩` 直接调 `/api/playtest/start`（已经在跑就先停掉再起 —— 点这个按钮的意思
  就是「把我刚写的内容加载进去」），并在新标签页打开；省掉「切到包管理页 → 点试玩」那两步。
- **表单**：身份（id/名称/阶/**职业**/**分支**/**位置**，都是中文名 + 英文枚举的双语下拉）、外观（复用已有 Spine id）、**普通与精锐两套数值**、**技能**（技能名/类型/持续类型/技力消耗/初始技力/持续时间/技力回复/自动释放触发/官方技能描述，外加**黑板书键值编辑器**）、**天赋**（0~2 条，每条含天赋名、说明、黑板书）、**模组**、**盟约**、以及**「是否助战」开关**（直接写入服务端助战卡池）。
- **改了纯文本 = 连富文本原文一起改**：官方记录的 `descRaw`（`<$ba.stun>晕眩</>` 这类标记）与 `desc` 常常不同，
  而派生层优先读 `descRaw` —— 数据里 199 条天赋有 56 条如此。所以编辑干员特性、天赋说明、模组特性/说明/天赋改写时，
  界面会把两个字段一起改掉；否则「在界面上改了字、记录里一个字没变」这种静默失败无法察觉。
- **id 在输入时就检查**：撞本包已有干员、或撞官方 id（除非在 `pack.json` 里声明 `overrides`，否则记录会被丢弃）
  分别提示。已有干员**改了 id 再保存只会新建一份记录**，原来那份仍留在包里 —— 表单会当场提醒这一条。
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
- **回合绑定**（侧栏）：把出怪表绑到这张图的回合上。这是**引擎真正读的那份**（`stage.rounds` / `stage.bossRounds`）——
  引擎先看这张图、再看模式的模板，所以在这里绑过的回合会走你自己的表，官方地图完全不受影响。
  每一行都显示「不指定的话本来会打哪张表」（不显示这个就没法判断该不该覆盖），首领回合再多一行。
  **绑了不存在的 id 会静默回落到模式的模板**，所以面板自己查存在性并把失效的绑定列出来。
- **`row 0` 是最下面一行**（与引擎存储一致），画布上已标注行号。
- **3D 预览是默认视图**：打开一张地图时，它直接放进**游戏自己的 3D 渲染器**（`public/js/render/board3d`）——
  官方棋盘贴图才让一张地图看得懂，2D 网格留着当编辑面。工具栏的「3D 预览」按钮随时切回 2D，切回去之后
  自动流程不会再把它扳回来；想一进页面就停在 2D，用 `?board=2d`（沿用游戏客户端的写法，`public/js/app.js`，
  `?board=3d` 同样可用）。
  渲染的就是游戏的代码、你这张图的数据 —— 所以它不可能和玩家看到的跑偏，正如路径表由 `server/sim/grid.js` 推导而不是重写。
  - 拖动平移 · 滚轮缩放 · Shift+拖动（或右键拖动）调俯角。这是固定朝向的投影相机，没有偏航可给。
  - **没有本地素材就自动退回 2D**，并说明原因（没装官方棋盘图集 / 没有 WebGL2 / three.js 没加载 / 素材包不完整），
    与游戏客户端的探测链一致（`board3d/load.js`）。「默认 3D」因此不会让谁卡在一块空白画布上。
  - 它需要三条**只读**通路：`/client/**`（客户端模块）、`/vendor/**`（three.js）、`/assets/**`（棋盘素材），
    外加 `/data/local-assets.json`。界面自己还会读 `/shared/**`（只读，只给 `.js`/`.mjs`/`.json`/`.css`）——
    这样数值尺子的刻度换算、伤害分类这些规则在浏览器与服务端是**同一份文件**，不会各写一套慢慢跑偏。
    编辑器默认只绑 127.0.0.1；只服务白名单扩展名，`..` 与点开头段一律拒绝，
    而且**不会**变成通用文件服务器（`/data/chess.json` 仍是 404）。
  - 素材名里的方括号、空格、`#` 会以 percent-encoding 发过来（官方棋盘里就有 `map/fx/[opt]merged_textures.png`
    这样的文件），编辑器**先解码、再按同一套规则检查段** —— 顺序反了会让 `%2e%2e` 绕过 `..` 的判断，
    不解码则会静默 404、让 3D 预览整块全黑。
- 保存后同样需**重启游戏服务器**才生效。

命令行等价路径（同一套推导）：

```powershell
node tools/workshop-scaffold.mjs docs/examples/stage-spec.json --pack map-demo   # spec → 推导 → 写 stages.json
node tools/workshop-validate.mjs workshop                                        # 含 stages 层：重算并比对路径表
```

## 怪物编辑器

第三个页面：**`/enemy.html`**。同样是"只编辑人能给的东西，机械字段一律推导"。

- **新建有两条路**：`＋ 新建怪物` 从空白表单开始；**`⧉ 以模板新建`** 从官方 249 只怪（可搜名称/key，按档位排序）
  或本包已有怪物复制一份底子 —— 数值、档位、攻击方式、能力文字、技能、免疫、spine 一次带过来。
- **数值参照尺子**：每个数值下面一条细线，标出官方**同档位**（普通/精英/领袖）的 min–中位–max；
  切到精英怪时尺子跟着换。参照不是上限。
- **`spine` 有候选、也有存在性校验**：这是整张表单里**唯一一个填错不报错**的字段 —— prefab 键查不到时
  `assets.spineEntry()` 直接画个占位菱形，游戏照跑、日志干净。输入框挂了官方 prefab 候选（datalist），
  并在下面当场说清三种情况：留空 → 占位模型；填错 → 静默变占位模型；填对 → 用官方美术。
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

## 装备编辑器

第五个页面：**`/item.html`**（`shared/itemAuthoring.js`）。规则和前四个页面一样：人填人能填的，机器字段一律推导。

**一件装备 = 一个 spec = 两条记录**（`chess_item_ws_<id>_a` 普通 + `_b` 精英）。这不是冗余：`mergeable` 本来就是
「不是精英、`upgradeNum` 在 0 和 100 之间、**并且有一个能合进去的对象**」，所以只写一条记录的可合成装备是点不动的。
编辑器始终显示它将写出的**两个 id**，删除时也**整对删除**（留下 `_b` 会得到一个指向幽灵的合成目标）。

- **身份**：id（生成 `_a`/`_b` 两个 id）、名称、`itemType`、`category`、`tier`(1-6)、`price`、
  `duration`（-1 整场 / 0 立即）、`upgradeNum`（0 独立 / 2 可合成 / 100 特殊）
- **buffs**：每个 buff 有 `key`、`countType`，以及两块黑板 —— `bb`（数值）与 `bbStr`（字符串）
- **图标 `trapId`**：工坊包不含素材，所以**复用现有装备图标**是唯一能拿到真图的办法（和怪物的 `spine` 同理）。
  表单用 `datalist` 列出官方全部 trap id 及其来源装备；留空则用兜底图并给警告
- **派生量只读显示**：`params`、`mergeable`、`shopExcluded`、`upgradeChessId`

三条推导不是猜的，每一条都**精确复现全部 115 条官方装备**（`test/itemAuthoring.test.js`）：

| 派生字段 | 规则 | 出处 |
|---|---|---|
| `params` | 各 buff 的黑板 `{ ...bb, ...bbStr }` 依次摊平，**先出现的键先赢** | `tools/build-data.mjs` `effectParams` |
| `mergeable` | `!isGolden && 0 < upgradeNum < 100`（且必须存在 `goldenId`） | `tools/build-data.mjs:1465` |
| `shopExcluded` | 就是 `shopExcludedBy != null` | `tools/build-data.mjs:1464` |

**`params` 是最凶的一个**：引擎读的是 `params`，**不是 buffs**。所以手写 `params`（或改了 buffs 忘了重推）会做出
一件「卡面写得很好、进了游戏什么都不干」的装备，而且游戏里不会报任何错。校验器会重算并比对，给出 `STALE_DERIVED`。

命令行等价路径：

```powershell
node tools/workshop-validate.mjs workshop     # items 层：重算 params/mergeable/shopExcluded 并比对，
                                              # 并检查合成目标是否存在、商店抽得到抽不到
```

## kit（行为层）编辑器

第六个页面：**`/kit.html`**（`shared/kitAuthoring.js`）。这是唯一一页**编辑代码**的编辑器，因为 kit 是唯一一种
**本身就是代码**的内容：`workshop/<pack>/kits/<chessId>.js` 既是可编辑的源、也是游戏加载的产物，没有「spec → 产物」
这一对，也就没有可推导的字段。所以中间那一栏是一个 `<textarea>`，装的就是**整份文件**（连文件名里的干员 id 也
由你定）—— 代码要高亮才看得懂的话，那是编辑器的口味；这里刻意不做高亮、不引依赖、不加构建步骤。

**要写第一份 kit 就从 [docs/prompts/kit.md](prompts/kit.md) 开始**：它把 Kit 形状、四条硬规则、32 个钩子与
`battle`/`unit` 常用接口写在一处，并带一个**被测试真的跑过**的完整示例 —— 那份示例既是范本，也是这一页静态校验的
活样本（`test/kitPrompt.test.js` 会从 markdown 里抽出来注入真实战斗）。

- **左栏**：所有包的 `kits/*.js` —— id、所属包、字节数、注册的钩子、错误/警告数，以及是否已带署名头。
- **右栏**：静态校验（错误 / 警告，每条带 `field`+`code`+`message`+`hint`）、它注册的钩子、文件头状态、
  这个包**合法的 kit id**（点一下就填进文件名），以及三条硬规则的速查与 [docs/prompts/README.md](prompts/README.md) 的链接。
  那个链接指向本仓库的文档，编辑器为此提供一条**只读**通路 `/docs/**.md`：只服务 markdown，`..` 与点开头的段一律拒绝
  （所以 `docs/examples/kit-demo/kits/*.js` 读不到，它也不改变 `/data/**`、`/client/**` 那几条通路的范围）。
- **文件名就是干员 id**：`kits/chess_ws_xxx_a.js`。加载器（`server/workshop.js loadWorkshopKits()`）只接受
  **本包真的提供了这个干员 id**（`<pack>/chess.json` 里有），或者你在 `pack.json` 的 `overrides` 里声明了
  `chess:<id>`（那是「替换官方干员的 kit」，属于声明过的行为）。两者都不满足就是 `KIT_NO_TARGET`：kit 永远不会被使用。
- **kit 所在的包必须贡献至少一个数据文件**（例如 `chess`）。空包不会被 `loadWorkshop` 列为已加载的包，它的 kit 自然
  也不会被导入 —— 保存时页面会给一条 `PACK_NOT_LOADED` 警告，因为文件看上去完全正常，失败是无声的。

三条硬规则（都来自引擎源码，都会**静默失败**，所以静态校验逐条检查）：

1. **返回了 kit 就必须自己给出 `skill`** —— `Battle._setupUnit` 用 `u.kit.skill || null` 取技能：返回了 kit 却省略
   `skill`，这名干员就**没有技能**，缺省技能**不会**回退到通用 kit。
2. **必须自包含，不能 `import`** —— 同一份文件服务端按真实路径加载、浏览器按 URL 加载，`../../sim/…` 对前者成立、
   对后者不成立，所以没有任何相对路径能同时成立。
3. **它会跑在玩家浏览器里，服务端用同一份文件复算这场战斗** —— 默认 `SP_COMBAT=client`，服务端 `SP_VERIFY` 会重算并
   比对，不一致就**拒绝玩家的结果**，而报错信息看上去和「你用了 `Math.random()`」毫无关系。随机请用 `battle.rng`，
   时间请用战斗自己的时钟（`battle.after` / `battle.every`），DOM、网络、墙钟一律不要碰。

外加一条属于钩子总线的：`battle.on(name, fn)` 接受**任意**字符串，而 `emit()` 只触发真正被 emit 的名字。所以
`battle.on('beforeAttck', …)` 注册得很干净、永不触发、也没有任何地方会报错 —— 校验器会给出 `HOOK_UNKNOWN_EVENT`
和「你是想写 `beforeAttack` 吗」的建议（词表在 `shared/kitAuthoring.js` 的 `HOOK_EVENTS`，由漂移守卫钉在引擎源码上）。
命名空间事件（`mypack:ready`）只要**同一文件自己 emit 过**就合法。

**编辑器里的校验只是静态的。** 它只读文本、不 `import`、不执行你的文件 —— 一个会把调用者提交的文本拿去求值的 HTTP
接口就是代码执行面，编辑器不该在无意中变成那种东西。真正把文件导入一遍（能不能加载、有没有默认导出、钩子词表、
三条硬规则）是 `tools/workshop-validate.mjs` 的 kits 层，它不在请求路径上：

```powershell
node tools/workshop-validate.mjs workshop     # kits 层：静态检查 + 真实导入，并列出已加载的 kit
```

**署名头（`.js` 文件没有 `_meta` 可挂）。** 保存时服务端会在文件开头补写一段注释头：一行机器可读的
`// @forge created=… modified=… pack=… source=Stronghold-Protocol-Forge author=…`，下面是著作权与反打包转售声明全文。
它只在文件还没有署名头时补写；已有的一行**只更新 `modified`** —— `created` 永远保留，且绝不会重复写第二个头、
也绝不会动你自己写在文件里的注释。完整规则见下面的「Option 署名」一节，实现在 `shared/forgeNotice.js` 的
`forgeHeader` / `parseForgeHeader` / `stampForgeHeader` 三个纯函数里。

## 语音（voice lines）编辑器

第七个页面：**`/voice.html`**。它和前六页都不一样：`voices` **不是单独的文件**，而是 `pack.json` 里的一个字段
（`{ <干员id>: { <槽位>: ["<assets/ 内的相对路径>", …] } }`，见 `docs/WORKSHOP.md` §1.4），而 `pack.json` 本身就是
游戏读的清单 —— 加载时 `shared/workshop.js` 把它并进 `assets.audio.voice`，客户端从 `/workshop-assets/<包>/<路径>`
取文件。所以这一页**没有 spec、没有可推导的字段**，它就地编辑那份清单。

- **左栏**：每个工坊包一条 —— 名称、包 id、已有多少条语音、有没有 `assets/`、清单能不能被加载器接受
  （不能就直接显示校验器给的 code，例如 `ASSETS_NEED_LICENSE`）。
- **中栏**：这个包已经配了哪些语音。每个干员一张卡，每个槽位一段，每条语音一行；**文件不存在**、
  **扩展名不在允许的类型里**、**不是音频**、**槽位不属于 `VOICE_SLOTS`** 都在行上标出来 ——
  这四种在游戏里都是**无声失败**。每条可以**试听**或**删除本行**，每个槽位可以**清空**。
- **右栏**：加一条 —— **干员 id**（下拉列出官方干员 + 这个包 `chess.json` 里自己新增的干员，不必背 id）、
  **槽位**（下拉，来自 `/api/voices` 的 `slots`）、**文件**（下拉列出该包 `assets/` 下真实存在的文件，并标明哪些是音频）。
  下面还列出该包 `assets/` 的全部文件，点一下就填进输入框。
- **试听走的就是客户端那条通路**：编辑器提供一条**只读、只服务音频**的 `/workshop-assets/<包>/<路径>`
  （与游戏服务器同前缀，扩展名取 `server/index.js` 白名单的音频部分），所以**试听用的 URL 就是游戏里会播的那个 URL**。
  没有目录列表，`..`、点开头的段一律拒绝，`pack.json` 本身不在那条通路上。素材仍然由作者自己拷进 `<pack>/assets/`：
  **编辑器没有上传接口**（那会是另一类攻击面）。
- **写入规则**（全部在服务端强制；拒绝时 **400，且一个字节都不写**）：包 id 合法；干员 id 匹配 `[A-Za-z0-9_-]{1,64}`；
  槽位 ∈ `VOICE_SLOTS`（`shared/constants.js`，**不复制**）；路径是包内 `assets/` 的相对路径（不得以 `/`、反斜杠、
  盘符开头，不得含 `.` / `..` / 空段 / 点开头的隐藏段）；**文件必须真的存在**；扩展名必须在 `server/index.js` 的
  `WORKSHOP_ASSET_TYPES` 里（**引用同一份表**）；包没有 `assets/` 文件夹时直接拒绝 ——
  否则写出的清单会被 `VOICE_NEEDS_ASSETS` 整包丢掉。
- **其余字段原样保留**：写回用的是编辑器自己的 `writeJson`，所以 `id` / `name` / `version` / `author` / `license` /
  `description` / `gameVersion` / `content` / `overrides` 的**值、键序与两空格缩进**都不变；
  新出现的 `voices` 键追加在末尾；**绝不会给包补一条它没有声明过的 `content`**。
- **空数组 = 删除**：给一个槽位传空数组就删除它；一个干员没有槽位了，它的 key 一并删除（空 key 回答不了
  「这个包给谁配了音」）；最后一个也没有时 `voices` 整个删除。只有「清空」这一类写入允许把包变成加载器会拒绝的
  形态（例如 `content: []` 的助战语音包被清空后就是 `EMPTY_PACK`），这时响应里给 `warnings` ——
  **一条删不掉的语音，比一个被校验器报告的包更糟**。
- **手工写坏的槽位只能手工改**：`pack.json` 里若写着 `VOICE_SLOTS` 之外的槽位，两个接口都会按规则拒绝，
  页面会把该槽位的按钮禁用并说明原因。

命令行等价路径：

```powershell
node tools/workshop-validate.mjs workshop     # 语音层：文件是否存在、扩展名是否可服务、槽位与干员 id 是否合法
```

## 包管理（导出 / 导入 / 助战声明）

第八个页面：**`/pack.html`**。它补上两件一直缺失的事：一个包**没法交给别人**（只能手抄目录），
而 `pack.json.support`（助战声明，见 `docs/WORKSHOP.md` §2.1）**没有图形入口**。

**归档规则只有一份实现**：这一页与 `node tools/workshop-pack.mjs …` 调用的是
`tools/workshop-pack.mjs` 里的同一批函数（zip 的字节由 `shared/zip.js` 负责），所以图形界面与命令行
不可能给出不同结论。这与其它页面的立场一致：规则由服务端/共享模块持有，页面只渲染它。

- **左栏**：每个工坊包一条 —— 名称、包 id、版本、license、内容文件、语音条数、助战个数，以及**加载器的结论**
  （`loadWorkshop` 接受的显示「加载器接受」，否则显示它拒绝的码，例如 `EMPTY_PACK`、`ASSETS_NEED_LICENSE`）。
- **中栏**：这个包的详情（id / 版本 / 作者 / license / 内容 / 语音 / 是否有 `assets/`）+ 校验结论 +
  **助战声明编辑器** + 「卡池在哪里」的说明。
- **右栏**：**导出**（下载 `<包id>.zip`）与**导入**（选一个 `.zip`，可选覆盖同名包），各自都写明命令行等价路径。

**导出**：`pack.json` 与包内所有文件（**包括 `assets/**`**）都在 **zip 根** —— 这个 zip 就是这个包。
条目按名字排序、DOS 时间戳固定，所以同样的内容永远得到同样的字节；响应是 `application/zip`，带
`Content-Disposition: attachment; filename="<包id>.zip"`。一个加载器会整包丢掉的包**拒绝导出**：
把一个坏包发给别人不是「分享」。

**导入**：上传的是原始字节（`application/octet-stream`，不走 JSON —— 那条 1 MB 的 `readBody` 上限不适用，
这条路由用 `shared/zip.js` 的总量常量做独立上限，超了先 413）。装上之前过三道关：

1. **读归档**：ZIP64、加密、非 0/8 压缩方法、多卷、重名、CRC 不符、超上限的条目、以及遍历名
   （`../x`、`/abs`、`a\b`、`./x`）全部**拒绝而不是猜**；
2. **解压到临时目录** `<workshop>/.pack-import-XXXX/`（点开头，加载器不会把它当成包），在这里校验清单 ——
   用 `shared/workshop.js` 的 `normalizePackManifest`，**与加载器同一个函数**，所以「装得上」就等于「加载器会接受它的格式」；
3. **整个搬进** `workshop/<包id>/`（同一个卷 → rename）。

所以一个坏归档、恶意归档、校验不过的包**永远不会在 `workshop/` 里留下半个包**。
清单可以在 zip 根，也可以在一个**唯一的顶层目录**里（`my-pack-1.0.0/pack.json`，两种归档都很常见），后者那层目录会被去掉。
默认**拒绝**覆盖已存在的包，勾上「覆盖同名包」才覆盖（`?force=1`）—— 覆盖时旧目录先改名挪开、新包搬进去之后才清理，
所以失败的覆盖不会留下半个包，也不会把原来的包弄丢。安装的写入**全部在 `workshop/` 之内**。

**助战声明**（`pack.json` 的 `support`）：

- 只能勾选**这个包自己新增**的干员（来自它的 `chess.json`）。卡池是安装方的规则：允许包把官方干员塞进或移出卡池，
  就等于让内容包改规则。违反会被加载器记 `SUPPORT_FOREIGN_OPERATOR` 并整条丢掉，编辑器**直接拒绝写入**并说明原因。
- **阶由记录推导**（`workshopSupportEntries`，与加载器/校验器同一份规则），页面上**没有任何可以手输阶的地方** ——
  手写的阶一旦与记录不一致，`isSupportChess` 会让该干员静默不可选。记录没有 1–6 的整数 `tier` 时
  （`SUPPORT_TIER_UNKNOWN`）勾选框被禁用并说明原因，而不是让作者勾一个不会生效的选项。
- **写入只动 `support` 一个字段**：其余字段、键序与两空格缩进原样保留，新键追加在末尾，
  而且**绝不会**给包补一条它没声明过的 `content`（写助战不是声明数据文件）。内容没变就不写盘。
- 页面明说卡池本身在服务端的 `data/support.json`，而且安装方在那里写 `"workshop": false` 就会忽略所有包的声明 ——
  否则作者会把「没生效」当成编辑器的 bug。

命令行等价路径（同一批函数，所以结果逐字节相同）：

```powershell
node tools/workshop-pack.mjs export my-pack [--out D:\share\my-pack.zip]
node tools/workshop-pack.mjs import my-pack.zip [--force] [--json]
node tools/workshop-pack.mjs list [--json]     # id / 名称 / 版本 / 内容 / 语音 / 助战，每个包一行
```

## 试玩（一键开一局）

包管理页右下角有 **「启动试玩」**：编辑器起一个**游戏服务器子进程**，等它 `/healthz` 就绪，然后打开浏览器
直接进一局独立模拟 —— 不用再开终端、不用手敲 `npm start`，而且**不用先想清楚工坊目录是哪一个**。

```
编辑器（127.0.0.1:3311） ──spawn──→ node server/index.js（127.0.0.1:随机空闲端口）
        │                                   ▲
        └─ 浏览器打开 http://127.0.0.1:<port>/?playtest=1&difficulty=…
                                            │
        SP_WORKSHOP=<编辑器的工坊根> ──────────┘（所以试玩读的就是你正在编辑的那些包）
```

| 关注点 | 行为 |
|---|---|
| 端口 | 每次挑一个当前空闲的本机端口（绑 0 号端口问内核要一个再释放），**不固定 3000** —— 作者自己的服务器常常就占着 3000 |
| 绑定地址 | 只绑 `127.0.0.1`：这是给自己看的窗口，不是给局域网用的服务器 |
| 工坊目录 | 以 `SP_WORKSHOP` 交给子进程，即**编辑器当前的工坊根**（`--workshop <目录>` 的那个）。不传这一项，试玩里就看不到你正在编辑的包 |
| `?playtest=1` | 客户端深链：进入并联网后自动建一个**独立模拟**房间并开局（`room.create {mode:'solo'}` → `room.start`），参数用完即从地址栏抹掉，刷新不会又开一局。见 `public/js/screens/lobby.js` 的 `parsePlaytestParam` |
| 难度 | 页面上选，作为 `&difficulty=<键>` 传给深链；键表来自 `shared/constants.js` 的 `DIFFICULTIES`，页面不自己写一份 |
| 改完包要生效 | 再点一次（按钮变成「重启试玩」）：先停旧进程再起新的。**编辑器自己不会重载数据**，这是刻意的 —— `server/data.js` 的 `getData()` 是进程级单例，同一个进程里「重启」也只会拿到第一次加载的数据，所以试玩必须是子进程 |
| 收尸 | 停止 / 关编辑器 / 编辑器进程退出（含 Ctrl+C）都会杀掉子进程。留一个占端口的孤儿 `node.exe`，下次试玩会以「端口被占用」失败，而用户不知道是谁占的 |
| 失败 | 起不来就是 500 + 原话（入口不存在 / 端口被占 / 30 s 内没就绪），并且**先把进程杀掉再抛错**，绝不返回一个「看起来在跑」的实例 |

命令行等价（编辑器做的事就是这一条，只是它自己挑端口并带上深链）：

```powershell
node scripts/launch.mjs                 # 开游戏服务器（默认 3000，浏览器自动打开）
node scripts/launch.mjs --port 3001     # 换个端口
```

> [!NOTE]
> 试玩**不是**打包器：它跑的是这个仓库当前的工作树。要让别人也能玩到你写的内容，用「包管理」页导出 `.zip`。

## 助战（客户端）

助战的选择由**服务端**声明并强制：卡池之外的干员是**禁用**的，请求会被整条拒绝，**没有回退**（回退会让一个被禁用的干员变成已发放）。

- 服务端在 `room.state` 里下发卡池目录（`enabled` / `label` / `tiers` / `capacity` / `slots`）—— 客户端无法自行得知卡池
- **界面**：`js/screens/support.js`（房间 / 大厅 / 简报室左下角「助战」按钮）—— 按阶列出卡池，每阶显示「已选 n/m」，
  顶部显示同步状态。**卡池没到就显示「等待服务器下发」而不是猜**；服务器没开助战就显示「本服务器未开启助战」
- 客户端 `ui/supportModel.js` + `ui/supportSync.js`：卡池未知时**等待不发**；被拒绝时**报错并保留玩家选择**
- 对局开始后 `room.state` 的助战会锁定，改动在下一局生效
- **助战干员进商店，不白送**（业主 2026-10-07 定下）：带上的干员在共享池里多一份拷贝，因此像普通棋子一样被摇到、
  按阶级价买到、按普通规则卖掉。价格可以用 `data/support.json` 的 `prices`（`{ "<chessId>": 3 }`）单独定，
  没配就用它的阶级价；助战摇出来的格子带 `support: true`，客户端可以据此加个标
- **随机禁用的干员不禁用助战**：随机禁用只影响商店抽卡（`server/match/pool.js`），带上的助战照样进池
  —— 哪怕它整条都在本局禁用名单里，池中仍有且仅有那一份助战拷贝（`test/support.test.js` 锁住了这条）
- 局内 `m.private.support` 回显 `{ selected, granted }`：`granted` = 本局商店里真的买得到的那几个，
  卡池在开局前变化导致「选了但买不到」时客户端能解释

## 盟约（羁绊）编辑器

第六个页面：**`/bond.html`**。盟约在引擎里分成三层，页面按这三层画，因为「改了就生效」只在其中两层成立：

| 层 | 谁决定 | 改了会怎样 |
|---|---|---|
| **计数与激活** | `countMode` / `thresholds` / `countsHand` / `countsGoldenOnly` | 谁算成员、几个才算激活 —— 改阈值立刻改变商店里能不能凑出它 |
| **数据面** | `weight` / `isCore` / `desc` / 图标 / `members` | 本局禁用抽签会不会抽到它、界面怎么显示、盟约弹窗列出哪些成员 |
| **战斗加成** | 引擎里的实现 | **官方 23 条**的效果按 id 写在 `server/sim/content/bonds/*`，数值从记录读 → 覆盖官方 = 改数值立刻生效；**新增盟约**没有处理器，必须打开 `genericBuffs`（`server/sim/content/bonds/dataDriven.js` 按 `base_atk` / `atk_per_stack`（防御、生命同理）给成员加百分比） |

- **新增 / 覆盖是同一件事的两种结果**：id 撞官方 23 条就是**覆盖**（保存时自动写进 `pack.json.overrides` 的 `bonds:<id>`，
  页面顶上有一条红字说明），新 id 就是**新增**。覆盖官方时**不要**打开通用加成 —— 那会和官方处理器叠加两次。
- **以模板新建**：官方 23 条或任何包里已有的盟约都能当底子（阈值、计数模式、说明、黑板数值一次带过来），
  `spec.id` 一律留空：顺手复制 id 会直接变成「覆盖官方」。
- **成员不是盟约自己说了算**：`members` 由**干员的 `bonds` 列表**推导（引擎按干员记录数人，弹窗列的就是它）。
  所以成员那一段勾选等于去改那些干员的 spec —— **只有本包自有的干员能改**；要改官方干员的盟约归属，
  得先把它覆盖/新建进本包（那是另一个明确动作，不该在盟约页顺手做掉）。
- **图标**：客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图（`bondIconUrl`），所以「图标 iconId」那个字段只是记录上的名字。
  页面上的「**本包自带的图标**」一段才是真的能改的那一处：它让你从本包 `assets/` 里**真的存在**的图片里挑一张，
  写进 `pack.json` 的 `bondIcons`（`POST /api/packs/:pack/bond-icons`），装载时叠加层把它并进 `assets.bonds`，
  客户端不需要任何改动。覆盖官方盟约时这张图会替换官方图标；官方清单里没有、本包也没配，就是盟约条上的一个圆点 ——
  页面会当场说明当前是哪一种。要删掉声明就把下拉选回「（不用本包图标）」。
- **保存写两处**：`bond-specs/<bondId>.json`（可编辑的源）与 `bonds.json`（游戏读的产物），
  并保证 `pack.json` 的 `content` 声明了 `bonds`（否则加载器**完全不读**这个包的 `bonds.json`，
  与干员那条同一个坑）、覆盖官方时 `overrides` 里有 `bonds:<id>`。派生失败的保存会**还原**刚写的 spec，
  一个字节都不留。
- **手写的记录不会被毁掉**：没有 spec 的盟约记录在保存别的盟约时原样保留（与干员/地图/装备同一条规则）。
- 相关测试：`test/bondAuthoring.test.js`（往返与校验）、`test/bondEditor.test.js`（接口 + 加载器/引擎端到端）、
  `test/content/workshopBond.test.js`（通用加成在真实战斗里生效）。

## 出怪设计器（时间轴）

第四个页面：**`/wave.html`**。它有两半，因为两半都必要：

- **时间轴**：每次出怪一条泳道，横轴是秒，方块宽度 = 这次出怪从第一只到最后一只能持续多久
  （`time + (count-1) × interval`）。颜色按排期槽位（N/E/S/T 系）区分，`不计入总数` 的出怪画成虚线半透明。
  哪一次先出、出多久、隔多久，一眼就能看出来。
- **明细表**：数值真正在这里输入 —— 时间 / 敌人 / 数量 / 间隔 / 路线 / 槽位 / 不计入。画布拖动是锦上添花，精确的输入框不是。
- **敌人是下拉选择**，选项来自合并后的敌人表（官方 249 只 + 工坊自己写的怪物），**按 `官方` / `本包` 分组、
  显示中文名**（只有键名的 250 项平铺下拉基本没法用）。下拉第一项是「＋ 新建怪物…（新标签页打开）」：
  中途发现缺一只怪时不必先保存、切页、再切回来 —— **必须新标签页**，否则这张还没保存的出怪表就被顶掉了；
  它会把当前包带过去（`enemy.html?pack=<包>`）。
  **阵营占位符会标出来**：官方数据里有 8 个键（`data/factions.json` 的 `templateSlots`）是阵营随机生成的占位符，
  选了它们实际出的是阵营随机怪、数量按战力重算；抽到的怪与它移动方式不同时，这一次**一只都不出**
  （`server/match/waves.js` 的 `valid:false` 分支），而校验器一个字不说。所以选项里带「（阵营占位符）」，
  右栏也会给一条警告。
- **路线画布画的是选中地图的真实地形**（地图自己画的装置也标出来）：路线定义在地图页、引用在这里，
  没有底图就只能对着另一页抄坐标，抄错一格就是「怪从墙里出来」。地图没有地形数据时退回网格，并在页头说明。
  取色两档：调色板认识的字用它的颜色，不认识的按该图图例的高度给近似色（官方地图有调色板之外的地形）。
- **路线**：这张出怪表自己带的路线列表（起点/终点/检查点）。地图只做参照 —— 上方选了哪张地图就画它的路线，并标出 `#序号`，
  因为 `spawns[].routeIndex` 索引的正是这个序号
- **绑定到回合**：这一栏只记录**意图**（哪个模式的第几回合）。真正生效的是**地图自己的 `rounds`**，
  在地图设计器的「回合绑定」面板里选这张表 —— 所以下面的「真正在用这张表的地图」会把权威答案列出来，
  两栏对不上时一眼就能看见
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
| GET | `/api/state` | 工坊包（含每个包 `bonds.json` 里的盟约清单 `bonds`）、干员、校验问题、助战配置、可选用的官方 Spine 列表、**按职业的数值参照 `statRanges`**、**官方盟约清单 `officialBonds`**（干员页的盟约勾选）；官方干员条目带 `subProfessionName`（分支中文名） |
| GET | `/api/operators/template?chessId=` | 把一对已发布的干员记录转成一份**可继续编辑的 spec**（模板新建用；id 留空） |
| POST | `/api/preview` | `{ spec }` → 推导并校验，**不写盘** |
| POST | `/api/packs/:pack/operators` | `{ spec }` → 写 specs 并重新生成 `chess.json` |
| DELETE | `/api/packs/:pack/operators/:slug` | 删除 spec 及其拥有的记录 |
| POST | `/api/support/toggle` | `{ chessId, tier, enabled }` → 增删 `data/support.json` 的卡池（取消助战时顺手删掉它的专属售价） |
| POST | `/api/support/price` | `{ chessId, price }` → 写 `data/support.json` 的 `prices`（`price: null`/空串即删除，回到阶级价） |
| GET | `/api/bonds` | 官方 23 条盟约 + 各包的盟约状态（specs/记录/校验）+ 枚举候选 + 图标与效果清单 + **成员勾选用的干员表** |
| GET | `/api/bonds/template?bondId=` | 把一条已有的盟约转成一份**可继续编辑的 spec**（模板新建用；id 留空） |
| POST | `/api/bonds/preview` | `{ spec }` → 推导并校验，**不写盘**（与保存同一条路：撞官方 id 不报错，因为保存会自动声明覆盖） |
| POST | `/api/packs/:pack/bonds` | `{ spec }` → 写 `bond-specs/` 并重新生成 `bonds.json`；补 `content: bonds`，覆盖官方时补 `overrides: bonds:<id>` |
| POST | `/api/packs/:pack/bonds/:bondId/members` | `{ add?, remove? }` → 改**本包自有**干员的 `bonds`（成员由此推导），并重算盟约记录的 `members` |
| DELETE | `/api/packs/:pack/bonds/:bondId` | 删除该盟约的 spec 及它拥有的记录（覆盖官方时同时收掉那条 `overrides` 声明） |
| GET | `/api/stages` | 工坊地图列表 + 调色板 + 网格尺寸 + **可指派的模式列表** + **回合绑定要的出怪表与模式回合表 `roundBind`** + **保存目标包 `packs`** |
| GET | `/api/stages/:pack/:id` | 该地图的**可编辑 spec**（源）与生成的记录 |
| POST | `/api/stages/preview` | `{ spec }` → 推导路径与部署区并校验，**不写盘** |
| POST | `/api/packs/:pack/stages` | `{ spec }` → 写 `stage-specs/` 并重新生成 `stages.json` |
| DELETE | `/api/packs/:pack/stages/:id` | 删除该地图的 spec 及它拥有的记录 |
| GET | `/api/enemies` | 工坊怪物列表 + **枚举词表** + 官方怪物键 + **模板清单 / spine 候选 / 按档位的数值参照** |
| GET | `/api/enemies/template?key=` | 把一只已发布的怪物记录转成一份**可继续编辑的 spec**（模板新建用；id 留空） |
| GET | `/api/enemies/:pack/:key` | 该怪物的**可编辑 spec**（源）与生成的记录 |
| POST | `/api/enemies/preview` | `{ spec }` → 推导 `attrPower`/`be` 并校验，**不写盘** |
| POST | `/api/packs/:pack/enemies` | `{ spec }` → 写 `enemy-specs/` 并重新生成 `enemies.json` |
| DELETE | `/api/packs/:pack/enemies/:key` | 删除该怪物的 spec 及它拥有的记录 |
| GET | `/api/waves` | 工坊出怪表列表 + 词表 + **可选敌人键** + 模式 + 地图（含各自带的回合）+ **阵营占位符清单** + 保存目标包 |
| GET | `/api/waves/:pack/:id` | 该出怪表的**可编辑 spec**（源）与生成的记录 |
| POST | `/api/waves/preview` | `{ spec }` → 推导 `totalCount`/`slotCounts` 并校验，**不写盘** |
| POST | `/api/packs/:pack/waves` | `{ spec }` → 写 `wave-specs/` 并重新生成 `waves.json` |
| DELETE | `/api/packs/:pack/waves/:id` | 删除该出怪表的 spec 及它拥有的记录 |
| GET | `/api/items` | 工坊装备列表 + 词表 + 官方 id + **可复用的图标 trap id** |
| GET | `/api/items/:pack/:id` | 该装备的**可编辑 spec**（源）与生成的两条记录 |
| POST | `/api/items/preview` | `{ spec }` → 推导 `params`/`mergeable`/`shopExcluded` 并校验，**不写盘** |
| POST | `/api/packs/:pack/items` | `{ spec }` → 写 `item-specs/` 并重新生成 `items.json`（一对记录） |
| DELETE | `/api/packs/:pack/items/:id` | 删除该装备的 spec **及它的一对记录** |
| GET | `/api/kits` | 工坊 kit 列表（含静态 `issues`）+ **钩子词表** + **禁用词及其原因** + 每个包合法的 kit id 与 `overrides` |
| GET | `/api/kits/:pack/:id` | 该 kit 的**文件原文**（文件不存在时 `source: null`） |
| POST | `/api/kits/preview` | `{ pack, id, source }` → **仅静态**校验（不写盘，**不 import / 不执行**你的文件） |
| POST | `/api/packs/:pack/kits` | `{ id, source }` → 写 `kits/<id>.js`，并在缺少署名头时补写 |
| DELETE | `/api/packs/:pack/kits/:id` | 删除该 kit 文件 |
| GET | `/api/voices`（可选 `?pack=`） | 各包的语音状态 + **槽位词表** + **允许的扩展名** + 可选干员 id + 包内 `assets/` 真实存在的文件 |
| POST | `/api/packs/:pack/voices` | `{ charId, slot, paths }` → 设置**一个槽位**（空数组即删除），就地更新 `pack.json` 的 `voices` |
| POST | `/api/packs/:pack/bond-icons` | `{ bondId, path }` → 设置本包自带的**盟约图标**（`path` 空即删除），就地更新 `pack.json` 的 `bondIcons`；文件必须真的在 `assets/` 下 |
| DELETE | `/api/packs/:pack/voices/:charId/:slot` | 删除一个干员的一个槽位（不存在则报告 `removed: false`，不重写文件） |
| GET | `/api/packs/:id/export` | 该包的 `.zip`（`application/zip` + `Content-Disposition: attachment`）；包不存在 → 404 |
| POST | `/api/packs/import`（可选 `?force=1`） | **原始 zip 字节**（`application/octet-stream`）→ 解压到临时目录、校验、搬进 `workshop/<包id>/`；返回装好的包摘要 |
| GET | `/api/packs/support` | 各包的助战状态 + 每个包的**自有干员与推导阶** + `data/support.json` 的卡池与总开关 |
| POST | `/api/packs/:id/support` | `{ ids }` → 就地更新 `pack.json` 的 `support`（只动这一个字段，绝不补 `content`） |
| GET | `/api/playtest` | 试玩状态（`running` / `port` / `url` / `pid`）+ 难度键表 + 当前工坊根 |
| POST | `/api/playtest/start` | `{ difficulty? }` → 起（或复用）一个游戏服务器子进程并等 `/healthz`；起不来 → 500 + 原话，且进程已被收尸 |
| POST | `/api/playtest/stop` | 停掉试玩（没在跑时 `stopped: false`，幂等） |

## Option 署名（`_meta`）

编辑器保存的**每一个 Option**（干员、地图、怪物、出怪、装备的 spec）都会自动带上一个 `_meta` 字段，把
[README 的著作权声明](../README.md#著作权声明)随文件一起带走 —— 声明写在 README 里不会跟着文件走，而一份
被拷到别处的关卡文件必须自己说明它是谁做的：

```json
"_meta": {
  "schema": 1,
  "source": "Stronghold-Protocol-Forge",
  "author": "水沫沐沐",
  "pack": "my-pack",
  "created": "2026-10-06T06:30:26.000Z",
  "modified": "2026-10-06T07:12:03.000Z",
  "copyright": { "zh": "…著作权归创建它的作者本人所有…", "en": "…" },
  "antiResale": { "zh": "…禁止打包、转售或批量分发…", "en": "…" },
  "scope": "本声明只针对 Option 创作内容，不改变本项目代码的 GPL-3.0-or-later 授权，也不附加任何限制。"
}
```

- **`created` 只写一次。** 之后再保存只更新 `modified` —— 作者改一下地图不该把创建日期重置。
- **作者名的来源**，按优先级：`createEditorServer({ forgeAuthor })` → 环境变量 `SP_FORGE_AUTHOR` →
  该包 `pack.json` 的 `author`。都没有就写 `未署名 (anonymous)`，不猜。
  ```powershell
  $env:SP_FORGE_AUTHOR = "你的名字"; npm run editor
  ```
- **`_meta` 只存在于 spec（源文件）里，绝不会进入游戏读的产物。** 每个 `derive*` 都是逐字段构造记录，
  所以 `_meta` 天然不会漏进 `stages.json` / `chess.json` —— `test/forgeNotice.test.js` 把这条钉住了
  （否则署名声明会顺着合并数据上到网络里）。
- **kit（`.js`）写的是文件头注释，不是 `_meta`。** 一份 JavaScript 里没有「数据对象」可以挂 `_meta`（那会变成要执行
  的代码），所以同一份声明写成注释头。格式只有一行是机器可读的，`created` 从它里面读回来：
  ```js
  // @forge created=2026-10-06T06:30:26.000Z modified=2026-10-06T07:12:03.000Z pack=my-pack source=Stronghold-Protocol-Forge author=水沫沐沐
  ```
  `author` 放在**最后**并吃掉整行剩余部分 —— 名字里可以有空格。规则同上：`created` 只写一次、之后只更新
  `modified`；只补写缺失的头，绝不写第二个，也绝不动作者自己的注释（`shared/forgeNotice.js` 的三个纯函数，
  见 `test/kitEditor.test.js`）。
- **它不是对代码的附加限制。** `_meta` 描述的是 Option 这一创作内容；代码仍然是 GPL-3.0-or-later，
  这条声明不改变也不缩减任何人在 GPL 下的权利。这条边界是它能与 GPL 共存的原因。

## 当前不包含

- 助战**名额**（`slots`）的编辑——改 `data/support.json` 的 `slots` 字段或编辑器里的「是否助战」开关
- 语音**素材的上传**——编辑器只写路径，音频文件由作者自己放进 `<pack>/assets/`（没有二进制上传接口）
- 包的**签名与来源校验**——导入只保证「归档结构合法、清单能被加载器接受」，不证明这个包是谁做的
- 包的**版本对齐与依赖声明**——一个包里没有「需要另一个包」的字段（见 `docs/WORKSHOP.md` §1.7）
- kit 的**真实导入检查**——编辑器只做静态校验（见上），把文件真的 `import` 一遍是 `tools/workshop-validate.mjs` 的事
- kit 的**沙箱与审查**——按分渠道策略不做（脚本会在客户端执行，见 `docs/WORKSHOP.md` §4）
- 任何鉴权
- 试玩的**热重载**——改完包要自己点一次「重启试玩」；编辑器不会替你重载游戏数据（见上面「试玩」一节的理由）

## 与其它工具的关系

| 工具 | 面向 | 关系 |
|---|---|---|
| `editor/`（本文件） | 人，图形界面 | 写 spec，生成记录；导出/导入 `.zip`，改 `pack.json` 的 `voices` / `support`；一键起试玩服务器 |
| `editor/playtest.mjs` | 编辑器内部 | 起 / 停游戏服务器子进程（挑空闲端口、`SP_WORKSHOP`、等 `/healthz`、退出收尸） |
| `scripts/launch.mjs` | 人 / 脚本 | 同样的服务器，由人来起（试玩的命令行等价物） |
| `tools/workshop-scaffold.mjs` | 人 / 脚本 / AI | 同样的 spec → 同样的记录（无界面） |
| `tools/workshop-pack.mjs` | 人 / 脚本 / CI | 导出 / 导入 / 列出包，读写 `pack.json.support` —— 编辑器第八页调用的就是它 |
| `tools/workshop-validate.mjs` | 人 / CI / AI | 分层校验：格式 → 语义 → 真实引擎 → 每种内容一层（kits / 地图 / 怪物 / 出怪 / 装备 / 语音 / 助战） |
| `docs/prompts/operator-pack.md` | 任意 AI | 模板 prompt，让 AI 产出 spec |

编辑器与 CLI 共用同一批 `shared/*Authoring.js`（干员 / 地图 / 怪物 / 出怪 / 装备 / kit），所以**规则不会漂移** ——
编辑器里能保存的内容，`tools/workshop-validate.mjs` 一定也接受，反之亦然。
包管理这一页更进一步：它**直接 import** `tools/workshop-pack.mjs`（而不是复制一份逻辑），
所以「编辑器能导出/导入/写 support」与「命令行能导出/导入/写 support」不是两条实现。
