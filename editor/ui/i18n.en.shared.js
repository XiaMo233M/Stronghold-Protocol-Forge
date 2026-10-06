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

  // ---- 跨页共用 ----
  // 规则：**两个以上页面都在用的词条放这里**。放在某一页的分片里会出事——那一页收尾时把它当死键删掉，
  // 别的页面就悄悄退回中文（而且没有任何测试会当场发现）。test/editorI18n.test.js 的重复键检查逼着这里只能是唯一归属。
  '保存': 'Save',
  '删除': 'Delete',
  '保存中…': 'Saving…',
  '已保存 {0}，生成 {1}。': 'Saved {0}, generated {1}.',
  '已保存 {0}，生成 {1}。重启游戏服务器后生效。': 'Saved {0}, generated {1}. Restart the game server to take effect.',
  '已删除 {0}': 'Deleted {0}',
  '可编辑': 'editable',
  '非编辑器管理': 'not managed by the editor',
  '（无）': '(none)',
  '（记录）': '(record)',
  '身份': 'Identity',
  'id（slug）': 'id (slug)',
  '校验': 'Validation',
  '✔ 校验通过': '✔ Validation passed',
  '（改动后自动校验）': '(validation runs automatically as you type)',
  '（改动后自动推导）': '(derived automatically as you type)',
  '派生量（只读，服务端算）': 'Derived values (read-only, computed by the server)',
  '先填 id 才能保存。': 'Fill in an id before saving.',
  '＋ 加一个键': '+ Add a key',
  // 保存目标（五个页面共用同一个下拉，editor/ui/packPicker.js）
  '保存到': 'Save to',
  '＋ 新建一个包…': '+ New pack…',
  '先在右边选一个工坊包（或点「＋ 新建一个包…」）。': 'Pick a workshop pack on the right (or click “+ New pack…”).',
  '新工坊包的 id（字母数字下划线短横线，≤32）：': 'New workshop pack id (letters, digits, underscore, hyphen, ≤32):',
  '{0} 阶': 'tier {0}',
  '{0} 条': '{0} entries',
  '干员 id': 'operator id',
  '还没有工坊包': 'no workshop pack yet',
  '；⚠ {0}': '; ⚠ {0}',
  '显示路线': 'Show routes',
  '官方': 'official',

  // ---- 数值尺子（editor/ui/statScale.js；干员页与怪物页共用） ----
  '官方区间 {0}–{1}（中位 {2}）': 'Official {0}–{1} (median {2})',
  '高于官方上限': 'above the official maximum',
  '低于官方下限': 'below the official minimum',

  // ---- 「以模板新建」选择器（干员页与怪物页共用同一套说法） ----
  '返回': 'Back',
  '以模板新建': 'New from a template',
  '⧉ 以模板新建': '⧉ New from a template',
  '第 {0} 回合': 'Round {0}',
  '已按「{0}」生成模板：请填一个新的 id 与名字（改完会自动校验）。': 'Template built from “{0}”: give it a new id and name (validation runs as you type).',
  '已复制「{0}」：填一个新的 id 再保存（改完会自动校验）。': 'Copied “{0}”: give it a new id before saving (validation runs as you type).',
});
