// editor/ui/i18n.en.stage.js — 地图设计器页（stage.html / stage.js / stage3d.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。
//
// 共用词条不在这里重复：「名称」「重新载入」「载入失败：{0}」在 shared，「可编辑」「保存中…」「（记录）」
// 「已保存 {0}，生成 {1}。重启游戏服务器后生效。」「已删除 {0}」在 index（干员编辑器）；本页还要用的
// 「非编辑器管理」「显示路线」「id（slug）」「✔ 校验通过」已经在 wave 分片、「保存到哪个工坊包？（id：字母数字下划线短横线）」
// 已经在 kit 分片 —— 分片之间有重复键会被 test/editorI18n.test.js 判失败，而词典是合并成一张表的，
// 所以这里只写本页独有的词条。（这几条跨页共用，理想的归宿是 shared，但那不在本页的改动范围里。）
//
// 不翻的东西：地图名 / 模式名 / 地形 label（接口回来的游戏数据）、id 与字段名（id（slug）里的 slug、
// WALK/FLY 这类枚举值）、装置 role（crate / platform / …）、工坊包 id 的默认值 my-map-pack —— 这些会写进
// 用户文件或是数据本身，不是给人看的界面文案。

export const EN_STAGE = Object.freeze({
  // ---- 顶部与左栏（stage.html 静态文案 + 列表） ----
  '新建地图': 'New map',
  '＋ 新建地图': '+ New map',
  '以模板新建…': 'New from a template…',
  '工坊包 / 地图': 'Workshop packs / maps',
  '寻路 {0} 条': '{0} paths',
  '寻路：未生成': 'Paths: not generated',
  '部署 {0} 格': '{0} deploy tiles',
  '还没有工坊地图': 'No workshop map yet',
  '{0} 张工坊地图': '{0} workshop maps',
  '左边选一张地图，或点「新建地图」。': 'Pick a map on the left, or click "New map".',

  // ---- 工具条、覆盖层与 3D 按钮 ----
  '画笔': 'Brush',
  '放装置': 'Place device',
  '擦除': 'Erase',
  '画路线': 'Draw route',
  '显示部署区': 'Show deploy area',
  '显示寻路': 'Show paths',
  '3D 预览': '3D preview',
  '3D 预览（点回 2D）': '3D preview (click to go back to 2D)',
  '正在准备 3D 预览…': 'Preparing the 3D preview…',
  '3D 预览不可用：{0}': '3D preview unavailable: {0}',

  // ---- 视图工具条与画布提示（整图适应视野、缩放平移） ----
  '适应': 'Fit',
  '＋': '+',
  '－': '−',
  '自动寻路': 'Auto-route',
  '业主口径：绝不自动生成；只有点这一下才算。按本图的 S（出生点）配最近的 E（防守点）求一条寻路，追加进路线里': 'The owner’s rule: never generated automatically — only this click does it. Pairs every S (spawn) of this map with its nearest E (defense point), then appends the routes.',
  '缩放平移：滚轮 / 双指缩放，中键拖或按住空格拖平移，「适应」复位。': 'Zoom: wheel / two-finger. Pan: middle-drag or hold Space and drag. “Fit” resets the view.',

  // ---- 画布提示与地形调色板 ----
  '把鼠标移到网格上看坐标。row 0 在最下面一行（和引擎一致）。': 'Move the mouse over the grid to read coordinates. row 0 is the bottom row (same as the engine).',
  'row {0}, col {1} · 字符 {2} · {3}': 'row {0}, col {1} · char {2} · {3}',
  '地形调色板': 'Terrain palette',
  '空': 'Air',
  '地图外 · 空气：不可走、不可部署': 'Outside the map · air: not walkable, not deployable',
  '字符 {0}': 'char {0}',

  // ---- 右栏：地图身份、地图种类、模式与地块图例 ----
  '地图': 'Map',
  '权重 weight': 'Weight',
  '地图种类': 'Map kind',
  '这张图算什么地图': 'What kind of map this is',
  '单人（默认）': 'Single player (default)',
  '联防（1 人）': 'Co-op defense (1 helper)',
  '联防（2 人）': 'Co-op defense (2 helpers)',
  '首领战（boss）不是地图种类：在下面的「回合绑定」里给某一回合绑上首领出怪表，那一回合就是首领战。': 'A boss fight is not a map kind: bind a boss wave table to a round in “Round bindings” below and that round becomes the boss fight.',
  '可选中的模式（必须至少选一个）': 'Selectable modes (pick at least one)',
  '（没有可选模式）': '(no selectable mode)',
  '地块图例 / 部署规则': 'Tile legend / deploy rules',
  '这里改的是这张图的图例：高度 / 可部署 / 通行三个字段直接决定引擎算出来的部署区。': 'What you change here is this map’s legend: height / buildable / passable are the three fields the engine derives the deploy area from.',
  '高度': 'Height',
  '可部署': 'Buildable',
  '通行': 'Passable',
  '空气：不可走、不可部署': 'Air: not walkable, not deployable',
  '可放地面干员（近战位）': 'Ground operator (melee tile)',
  '只能放远程位（高台干员）': 'Ranged tile only (high-ground operator)',
  '不可部署': 'No deployment',
  '（没有 tileKey）': '(no tileKey)',
  '部署规则': 'Deploy rules',
  '地面也能放远程位（高台干员）': 'The ground also takes ranged tiles (high-ground operators)',
  '已勾上：普通地面也接受远程位（高台干员），近战位不变。': 'On: plain ground also takes ranged tiles (high-ground operators); melee tiles are unchanged.',
  '默认不勾：只有道路放地面干员、高台放远程位；普通地面不接受高台干员。这个开关是这张图自己的。': 'Off by default: roads take ground operators and high ground takes ranged tiles; plain ground takes no high-ground operator. The switch belongs to this map.',

  // ---- 右栏：装置 ----
  '装置': 'Devices',
  '（还没有装置）': '(no device yet)',
  '隐藏': 'Hidden',
  '激活': 'Active',
  '隐藏的装置在对局开始时不存在（由效果打开）': 'A hidden device does not exist when the match starts (an effect turns it on).',
  '要摆放的装置类型': 'Device type to place',
  '选「放装置」工具后点网格放置。': 'Pick the "place device" tool, then click the grid to place one.',

  // ---- 右栏：路线 ----
  '路线（出生点 → 防守点）': 'Routes (spawn → defense point)',
  '正在画：{0} 个点，起点 {1}。继续点网格加检查点，然后按「完成路线」。': 'Drawing: {0} point(s), start {1}. Keep clicking the grid to add checkpoints, then click "Finish route".',
  '选「画路线」工具后依次点击：第一下是起点（城门 S），中间是检查点，最后按「完成路线」收尾。WALK 走地面寻路，FLY 直线飞。': 'Pick the "draw route" tool and click in order: the first click is the start (gate S), the middle ones are checkpoints, and "Finish route" closes the route. WALK follows ground pathing, FLY goes straight.',
  'WALK（地面，按寻路走）': 'WALK (ground, follows pathing)',
  'FLY（飞行，直线）': 'FLY (flying, straight line)',
  '新路线的运动方式': 'Movement of the new route',
  '完成路线': 'Finish route',
  '取消当前路线': 'Cancel current route',
  '无路可走': 'no path',
  '（还没有路线：这张图上的敌人目前没有从出生点到防守点的走法）': '(no route yet: on this map enemies currently have no way from spawn to the defense point)',
  '路线存在工坊包的 spec 里（引擎的 routes 属于出怪表，由下一步的出怪编辑器绑定到回合）。': 'Routes live in the workshop pack spec (the engine routes belong to the spawn table; the spawn designer binds them to rounds).',

  // ---- 右栏：保存、删除与推导结果 ----
  '保存并推导': 'Save and derive',
  '删除该地图': 'Delete this map',
  '删除地图 {0}？': 'Delete map {0}?',
  '校验与推导结果': 'Validation and derivation',
  '（改动后会自动推导）': '(derives automatically after each change)',
  '寻路 {0} 条（含装置 {1} 条）': '{0} paths ({1} with devices)',
  '部署 {0} 近战 / {1} 远程': 'deploy {0} melee / {1} ranged',

  // ---- 以模板新建 / 试玩这张图 ----
  '点一个模板就以它为底开一张新图（模板的 id 与名字不会被占用）。': 'Click a template to start a new map from it (the template’s id and name stay its own).',
  '收起': 'Collapse',
  '正在载入模板…': 'Loading templates…',
  '（这台机器上没有可用的模板）': '(no template on this machine)',
  '拉取模板清单失败：{0}': 'Could not load the template list: {0}',
  '已按「{0}」载入一份新图：请填一个新的 id 与名称。': 'Loaded a new map from “{0}”: fill in a new id and name.',
  '▶ 试玩这张图': '▶ Playtest this map',
  '这张图还没有绑定出怪表：试玩里敌人会按官方模板的路线走，看起来会乱走。建议在出怪页建一张表并把它绑到回合上。': 'This map binds no wave table yet: in a playtest the enemies walk the official template’s routes and look like they wander. Create a table in the spawn designer and bind it to a round.',
  // 「正在起…」「试玩服务器已就绪（新标签页已打开）：{0}」与干员页共用，已在 index 分片

  // ---- 自动寻路（唯一会生成寻路表的地方） ----
  '自动寻路：新增 {0} 条路线（共 {1} 条）。': 'Auto-route: added {0} route(s), {1} in total.',
  '自动寻路：没有新的路线可加（这张图上同起终点的已经有了）。': 'Auto-route: nothing new to add (this map already has a route with the same start and end).',
  '自动寻路失败：{0}': 'Auto-route failed: {0}',
  '这张图没有可配对的入口与保护目标': 'this map has no gate/objective pair to route between',

  // ---- 3D 预览：控制提示、视角名与退回原因 ----
  '左键拖动调俯角 · 滚轮缩放 · 按住空格拖（或中键拖）平移。这一层是游戏自己的 3D 渲染器跑你这张地图。': "Left-drag tilts · wheel zooms · hold Space and drag (or middle-drag) to pan. This layer is the game's own 3D renderer running your map.",  '（页面上没有 3D 画布）': '(there is no 3D canvas on this page)',
  '全图': 'Whole map',
  '俯视': 'Top-down',
  '游戏视角': 'Game view',
  '侧视': 'Side view',
  '近景': 'Close-up',
  '本机没有官方棋盘素材（data/local-assets.json 未列出棋盘图集），已退回 2D': 'This machine has no official board art (data/local-assets.json does not list the board atlas) — stayed on 2D',
  '这台设备没有可用的 WebGL2，已退回 2D': 'This device has no usable WebGL2 — stayed on 2D',
  'three.js 没加载成功，已退回 2D': 'three.js failed to load — stayed on 2D',
  '棋盘素材包不完整，已退回 2D': 'The board art pack is incomplete — stayed on 2D',

  // ---- 回合绑定（这张图自己的出怪表） ----
  '回合绑定（这张图自己的出怪表）': 'Round bindings (this map’s own wave tables)',
  '不指定就用模式的默认出怪表。引擎先看这张图、再看模式的模板，所以这里绑过的回合会走你自己的表。': 'Leave a round alone and it uses the mode’s default wave table. The engine looks at this map first and at the mode’s template second, so a round bound here runs your own table.',
  '（服务端没有给出回合表）': '(the server sent no round table)',
  '{0}（这张表不存在）': '{0} (this table does not exist)',
  // 「第 {0} 回合」与出怪页共用，已放 shared 分片
  '默认 {0}': 'default {0}',
  '首领模板': 'boss template',
  '首领回合': 'boss round',
  '（用模式的模板）': '(use the mode’s template)',
  '首领回合的出怪表（该模式的首领都会用它）': 'Wave table for the boss round (every boss of this mode uses it)',
  '（用模式的首领模板）': '(use the mode’s boss template)',
  '这些绑定的出怪表不存在，引擎会静默回落到模式的模板：{0}': 'These bound wave tables do not exist — the engine silently falls back to the mode’s template: {0}',

  // ---- 地图尺寸（大图支持：业主 2026-10-08「把地图做得更大些，加入对大图的支持」） ----
  '尺寸': 'Size',
  '尺寸 {0}': 'Size {0}',
  '地图尺寸': 'Map size',
  '这张图多大': 'How big this map is',
  '标准': 'Standard',
  '大': 'Large',
  '特大': 'Huge',
  '自定（{0}）': 'Custom ({0})',
  '放大尺寸会保留左下角已有的地形，多出来的行列填成空气（地图外），分区重置为这个尺寸的默认。': 'Enlarging keeps the terrain already painted in the lower-left corner, fills the added rows and columns with air (outside the map), and resets the zones to this size’s defaults.',
  '已把地图改成 {0}：多出来的行列填成空气（地图外），分区重置为这个尺寸的默认。': 'Map resized to {0}: the added rows and columns are air (outside the map) and the zones are reset to this size’s defaults.',
  '把整张 {0} 缩放回视野里（最少留 8px 边距）': 'Scale the whole {0} back into view (at least 8px of margin on every side)',

  // ---- 分区编辑（「分区」模式：拖分区、改数字） ----
  '分区': 'Zones',
  '分区编辑': 'Zone editing',
  '分区编辑：拖白点改这一块的行（部署区的列由棋盘定死），上下左右微调选中的那一条边。': 'Zone editing: drag a white handle to move that side (a deploy field’s columns are fixed by the board); the arrow keys nudge the selected side by one tile.',
  '拖白点改分区：部署区、战斗矩形、怪物等待区都能上下挪（部署区的列由棋盘定死），镜像轴只作标注': 'Drag the white handles to move the zones: deploy fields, battle rects and the enemy pen all move vertically (a deploy field’s columns are fixed by the board), and the mirror axis is a label only',
  '这里能改的是「分区」：部署区、战斗矩形、怪物等待区。左右拖只对没定死的那些矩形有效，上下拖都能挪。': 'What you change here are the zones: deploy fields, battle rects and the enemy pen. Dragging left/right only works on rects that are not fixed; up/down always moves them.',
  '{0}（改这一格就是改分区）': '{0} (changing this number moves the zone)',
  '{0}（改这一格就是整块棋盘上下挪）': '{0} (changing this number moves the whole board up or down)',
  '{0} 由棋盘定死（两个半场在 col 10 相接、镜像轴 20），不能改': '{0} is fixed by the board (the two halves meet at col 10, the mirror axis is 20) and cannot be changed',
  '镜像轴': 'Mirror axis',
  '镜像轴：boss 右半场就是过第 {0} 列翻过来的（由棋盘定死，只作标注）。': 'Mirror axis: the boss right half is the left half mirrored across column {0} (fixed by the board, a label only).',
  '重置为尺寸默认': 'Reset to the size’s defaults',
  '分区已重置为 {0} 的默认布局。': 'Zones reset to the default layout of {0}.',
  '分区有问题（保存会被拦下）：{0}': 'The zones have a problem (saving will be blocked): {0}',
  '✔ 分区合法': '✔ Zones are valid',
  '怪物等待区': 'Enemy waiting pen',
  '普通战斗矩形': 'Normal battle rect',
  '整备矩形': 'Prep rect',
  '联防满宽矩形': 'Co-op full-width rect',
  'boss 战斗矩形': 'Boss battle rect',
  'boss 整备矩形': 'Boss prep rect',
  '普通': 'Normal',
  'boss 左半': 'Boss left half',
  'boss 右半': 'Boss right half',

  // ---- 分区视图（业主 2026-10-08：一张 19×21 里住着三个区） ----
  '区域': 'Zone',
  '怪物等待区（预览围栏）': 'Enemy waiting pen (preview)',
  '普通对战': 'Normal battle',
  'boss 对战': 'Boss battle',
  '整图（专业检修）': 'Whole grid (pro inspection)',
  '只画这一区（区外压暗）；「整图」是三合一的老画面，留给专业检修': 'Edit only this zone (the rest is dimmed); “Whole grid” is the old three-in-one view, kept for pro inspection',
  '普通对战部署区': 'Normal deploy field',
  'boss 左半部署区': 'Boss left-half deploy field',
  'boss 右半部署区': 'Boss right-half deploy field',
  '从官方图取这一区…': 'Take this zone from an official map…',
  '把官方图（或样板图）里属于这一区的行抄过来，其它区不动': 'Copy the rows of this zone from an official map (or the sample) and leave every other zone untouched',
  '把「{0}」这一区的行整段换成模板的行；其它区一个字节都不动。': 'Replaces the rows of “{0}” with the template’s; every other zone stays byte-for-byte.',
  '已把「{0}」换成「{1}」那一区（改了 {2} 格）。': 'Replaced “{0}” with the same zone from “{1}” ({2} tiles changed).',
  '这个模板没有可用的 rows': 'this template has no usable rows',

  // ---- 部署读out（能不能部署 = 在不在部署矩形里 × 地块属性） ----
  '不在任何部署区内：敌人会走，但放不了干员': 'outside every deploy field: enemies walk it, but no operator can stand there',
  '在 {0} 内 · {1}': 'inside {0} · {1}',
  '地图外（空气）': 'outside the map (air)',
  '地块本身不可部署': 'the tile itself is not deployable',
  '部署行里有 {0} 格「可放地面干员」的地块落在部署矩形外：敌人会走，但那里部署不了干员（能不能部署由矩形决定）。': '{0} tile(s) in a deployment row take ground operators yet fall outside the deploy field: enemies walk them, but nothing can be deployed there (the rect decides).',
  '跳到第一格 ({0}, {1})': 'Jump to the first one ({0}, {1})',

  // ---- 新建地图到试玩：把前置条件自己做掉 ----
  '▶ 保存并试玩这张图': '▶ Save and playtest this map',
  '先自动填了一个 id：{0}': 'Filled in an id automatically: {0}',
  '已一键创建工坊包 {0}：这张图先存进去再试玩。': 'Created the workshop pack {0} in one click: this map is saved into it before the playtest.',

  // ---- 3D 相机的控制面（为什么不能绕圈转） ----
  '3D 这一层用的是游戏自己的相机（固定朝向的投影相机），所以没有「绕圈转」：俯角 + 平移 + 远近就是它的全部控制面；想换角度就用上面那五个取景。': 'This layer uses the game’s own camera (a fixed-orientation projection camera), so there is no orbit: tilt, pan and zoom are all the control it has — use the five framings above for another angle.',
});
