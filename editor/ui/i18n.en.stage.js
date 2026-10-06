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
  '工坊包 / 地图': 'Workshop packs / maps',
  '寻路 {0} 条 · 部署 {1} 格': '{0} paths · {1} deploy tiles',
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

  // ---- 画布提示与地形调色板 ----
  '把鼠标移到网格上看坐标。row 0 在最下面一行（和引擎一致）。': 'Move the mouse over the grid to read coordinates. row 0 is the bottom row (same as the engine).',
  'row {0}, col {1} · 字符 {2}': 'row {0}, col {1} · char {2}',
  '地形调色板': 'Terrain palette',

  // ---- 右栏：地图身份与模式 ----
  '地图': 'Map',
  '权重 weight': 'Weight',
  '可选中的模式（必须至少选一个）': 'Selectable modes (pick at least one)',
  '（没有可选模式）': '(no selectable mode)',

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
  '先填一个 id 才能保存。': 'Fill in an id before saving.',
  '删除地图 {0}？': 'Delete map {0}?',
  '校验与推导结果': 'Validation and derivation',
  '（改动后会自动推导）': '(derives automatically after each change)',
  '推导：寻路 {0} 条（含装置 {1} 条）· 部署 {2} 近战 / {3} 远程': 'Derived: {0} paths ({1} with devices) · deploy {2} melee / {3} ranged',

  // ---- 3D 预览：控制提示、视角名与退回原因 ----
  '拖动平移 · 滚轮缩放 · Shift+拖动（或右键拖动）调俯角。这一层是游戏自己的 3D 渲染器跑你这张地图。': "Drag to pan · wheel to zoom · Shift+drag (or right-drag) to tilt. This layer is the game's own 3D renderer running your map.",
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
});
