// editor/ui/i18n.en.wave.js — 出怪设计器页（wave.html / wave.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。
//
// 已经译过的通用词（`保存中…`、`已删除 {0}`、`可编辑`、`（记录）`、`载入失败：{0}`）在 shared / index 分片里，
// 这里不再重复一份：同一个键出现在两个分片会被 test/editorI18n.test.js 判失败，页面照样查得到译文。
//
// 同理，`保存`、`删除`、`非编辑器管理` 这几个跨页共用的词当前由 kit 分片提供，本页用同一份译文，
// 不再各自译一遍 —— 两处译文迟早会不一致，而这正是分片去重要防的事。（跨页共用词的正经归宿是 shared 分片。）

export const EN_WAVE = Object.freeze({
  // ---- 页头与左侧列表 ----
  '工坊包 / 出怪表': 'Packs / spawn tables',
  '新建出怪表': 'New spawn table',
  '＋ 新建出怪表': '+ New spawn table',
  '还没有工坊出怪表': 'No workshop spawn table yet',
  '{0} 张工坊出怪表': '{0} workshop spawn table(s)',
  '{0} 次 · {1} 只 · 路线 {2}': '{0} spawn(s) · {1} enemy(ies) · {2} route(s)',
  '未绑定回合': 'not bound to a round',

  // ---- 地图面板 ----
  '看哪张地图的路线': 'Routes of which map to show',
  '（自带回合）': '(brings its own rounds)',
  '官方地图': 'official map',
  '工坊地图': 'workshop map',

  // ---- 时间轴 ----
  '时间轴（横轴 = 秒）': 'Timeline (x axis = seconds)',
  '还没有出怪。用下面的「添加一次出怪」开始。': 'No spawn yet. Start with “Add a spawn” below.',
  '每条泳道 = 一次出怪。点击方块选中后可改时间/数量/间隔/路线；拖动不改数值，用右侧表格精确编辑。': 'One lane = one spawn. Click a block to select it, then change its time/count/interval/route; dragging does not change the numbers — use the table on the right for exact edits.',
  '（不计）': '(not counted)',
  '{0} ×{1} @{2}s 间隔 {3}s · route #{4} · slot {5}': '{0} ×{1} @{2}s interval {3}s · route #{4} · slot {5}',

  // ---- 出怪明细表 ----
  '出怪明细': 'Spawn details',
  '＋ 添加一次出怪': '+ Add a spawn',
  '时间(s)': 'Time (s)',
  '敌人': 'Enemy',
  '数量': 'Count',
  '间隔(s)': 'Interval (s)',
  '路线': 'Route',
  '槽位 slot': 'Slot',
  '不计入': 'Not counted',

  // ---- 右侧面板：出怪表与路线 ----
  '出怪表': 'Spawn table',
  '左边选一张出怪表，或点「新建出怪表」。': 'Pick a spawn table on the left, or click “New spawn table”.',
  '类型 kind': 'Kind',
  '路线（这张表自己带的）': 'Routes (carried by this table)',
  '＋ 复制上一条路线': '+ Copy the last route',
  '路线的起点/终点坐标请在「地图设计器」里画好，这里只引用。': 'Draw each route’s start/end coordinates in the stage designer; this page only references them.',

  // ---- 绑定到回合 ----
  '绑定到回合（方案 B）': 'Bound to rounds (option B)',
  '＋ 加一条绑定': '+ Add a binding',
  '绑定只记录意图：真正让这张表生效，是在「地图设计器」里给地图写 rounds 指向它（方案 B）。': 'A binding only records the intent: to make this table take effect, point the map’s rounds at it in the stage designer (option B).',

  // ---- 保存、删除与校验 ----
  '保存到哪个工坊包？': 'Save to which workshop pack?',
  '删除出怪表 {0}？': 'Delete spawn table {0}?',
  '推导与校验': 'Derivation and validation',
});
