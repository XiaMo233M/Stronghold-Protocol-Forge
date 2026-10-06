// editor/ui/i18n.en.shared.js — 共享词条：8 个页面共用的顶部导航、页面名与通用按钮。
//
// 各页自己的词条在 i18n.en.<页面>.js 里（见 i18n.en.js 的汇总）。同一个键只允许出现在一个分片里：
// test/editorI18n.test.js 会检查分片之间没有重复键，免得两处译文不一致还以为改好了。

export const EN_SHARED = Object.freeze({
  // ---- 顶部导航（页面名，不带箭头） ----
  '地图设计器': 'Stage designer',
  '怪物编辑器': 'Enemy editor',
  '出怪设计器': 'Spawn designer',
  '装备编辑器': 'Equipment editor',
  'kit 编辑器': 'Kit editor',
  '语音编辑器': 'Voice editor',
  '包管理': 'Pack manager',
  '干员编辑器': 'Operator editor',

  // ---- 各页 <title> ----
  '卫戍协议 · 创意工坊编辑器': 'Stronghold Protocol · Workshop Editor',
  '卫戍协议 · 工坊地图设计器': 'Stronghold Protocol · Workshop Stage Designer',
  '卫戍协议 · 工坊怪物编辑器': 'Stronghold Protocol · Workshop Enemy Editor',
  '卫戍协议 · 工坊出怪设计器': 'Stronghold Protocol · Workshop Spawn Designer',
  '卫戍协议 · 工坊装备编辑器': 'Stronghold Protocol · Workshop Equipment Editor',
  '卫戍协议 · 工坊 kit（行为层）编辑器': 'Stronghold Protocol · Workshop Kit (Behaviour) Editor',
  '卫戍协议 · 工坊语音编辑器': 'Stronghold Protocol · Workshop Voice Editor',
  '卫戍协议 · 工坊包管理': 'Stronghold Protocol · Workshop Pack Manager',

  // ---- 各页 <h1> ----
  '工坊地图设计器': 'Workshop stage designer',
  '工坊怪物编辑器': 'Workshop enemy editor',
  '工坊出怪设计器': 'Workshop spawn designer',
  '工坊装备编辑器': 'Workshop equipment editor',
  '工坊 kit（行为层）编辑器': 'Workshop kit (behaviour) editor',
  '工坊语音编辑器': 'Workshop voice editor',
  '工坊包管理': 'Workshop pack manager',

  // ---- 通用按钮与词 ----
  '重新载入': 'Reload',
  '新建工坊包': 'New workshop pack',
  '工坊包': 'Workshop packs',
  '干员': 'Operators',
  '名称': 'Name',
  '（空）': '(empty)',
  '（还没有工坊包）': '(no workshop pack yet)',
  '正在载入…': 'Loading…',
  '载入失败：{0}': 'Load failed: {0}',
});
