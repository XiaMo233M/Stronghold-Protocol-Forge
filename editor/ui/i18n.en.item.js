// editor/ui/i18n.en.item.js — 装备编辑器页（item.html / item.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。
//
// 这一页和兄弟页（怪物/出怪/kit）长得几乎一样，所以一批文案的中文原文也在别的页面上：
// `（无）`、`id（slug）`、`身份`、`校验`、`（记录）`、`保存`、`删除`、`保存中…`、`{0} 阶`、
// `已删除 {0}`、`载入失败：{0}`、`非编辑器管理`、`派生量（只读，服务端算）`、`（改动后自动推导）`、
// `（改动后自动校验）`、`先填 id 才能保存。`、`✔ 校验通过`、`已保存 {0}，生成 {1}。`、
// `保存到哪个工坊包？（id：字母数字下划线短横线）` 这类**共用原文不在这里重复写**——
// 分片之间出现重复键会被 test/editorI18n.test.js 判失败，而且两张译文必然会有一天只改一处。
// 下面只放这一页独有的文案。

export const EN_ITEM = Object.freeze({
  // ---- 左栏 / 工具条（item.html） ----
  '新建装备': 'New item',
  '工坊包 / 装备': 'Pack / equipment',
  '＋ 新建装备': '+ New item',
  '左边选一件装备，或点「新建装备」。': 'Pick an item on the left, or click “New item”.',
  '{0} 件工坊装备（{1} 条记录）': '{0} workshop items ({1} records)',
  '还没有工坊装备': 'No workshop items yet',
  '可合成': 'mergeable',
  '{0} 金': '{0} gold',

  // ---- 表单：身份 ----
  '写入 chess_item_ws_<id>_a 与 _b': 'Writes chess_item_ws_<id>_a and _b',
  '类型 itemType': 'Type (itemType)',
  '分类 category': 'Category (category)',
  '阶级 tier（1-6）': 'Tier (tier, 1-6)',
  '价格 price': 'Price (price)',
  '持续 duration': 'Duration (duration)',
  '-1 整场有效': '-1 lasts the whole battle',
  '0 立即结算': '0 settles immediately',
  '合成数 upgradeNum': 'Merge count (upgradeNum)',
  '0 独立（不可合成）': '0 standalone (cannot merge)',
  '2 可合成（需要 _b）': '2 mergeable (needs _b)',
  '100 特殊（不可合成）': '100 special (cannot merge)',
  '例如 trap_1013_lhp': 'e.g. trap_1013_lhp',
  '图标 trapId（复用现有装备图标，否则用兜底图）': 'Icon (trapId — reuse an existing equip icon, otherwise the fallback art)',
  'identifier（数值表 id，可留空）': 'identifier (numeric-table id, may be empty)',
  '商店不显示 hideInShop': 'Hidden in the shop (hideInShop)',
  '可授予羁绊 canGiveBond': 'Can grant a bond (canGiveBond)',
  '卡面描述 desc': 'Card description (desc)',

  // ---- 表单：效果 buffs ----
  '效果 buffs（引擎真正读的是它们摊平出来的 params）': 'Effects — buffs (what the engine really reads is the params they flatten into)',
  'buff 的 key 是技能/触发器的模板键；bb 是数值黑板，bbStr 是字符串黑板。同名键先出现的先赢。': 'A buff key is a skill/trigger template key; bb is the numeric blackboard and bbStr the string one. For a duplicate key the first one wins.',
  '键': 'key',
  'bb（数值）': 'bb (numeric)',
  'bbStr（字符串）': 'bbStr (string)',
  '＋ 加一个 buff': '+ Add a buff',

  // ---- 表单：其余文案与联动 ----
  '其余文案与联动': 'Other text and links',
  'effectId（留空则自动生成 eff_ws_<id>）': 'effectId (auto-generates eff_ws_<id> when empty)',
  'effectName（留空则用名称）': 'effectName (falls back to the name when empty)',
  'requiresBondId（需要哪个羁绊）': 'requiresBondId (which bond it requires)',
  'giveBondId（授予哪个羁绊）': 'giveBondId (which bond it grants)',
  'shopExcludedBy（填了就等于商店排除）': 'shopExcludedBy (any value means the shop excludes it)',
  'note（备注）': 'note (memo)',
  'implFormula（实现公式，给人看的）': 'implFormula (the implementation formula, for humans)',
  'flavor（风味文本）': 'flavor (flavour text)',

  // ---- 表单：覆盖范围 ----
  '覆盖范围 rangeGrid': 'Coverage (rangeGrid)',
  'rangeGrid（JSON，[[行,列],…]）': 'rangeGrid (JSON, [[row,col],…])',
  'rangeGrid 不是合法 JSON，暂不校验': 'rangeGrid is not valid JSON — validation is skipped',

  // ---- 右栏：会写出的记录、保存与删除 ----
  '会写出的两个记录': 'The two records that will be written',
  '（先填 id）': '(fill in an id first)',
  '一件装备 = 一个 spec = 普通记录 + 精英记录。没有 _b 就不能合成，所以可合成项必须成对写出。': 'One item = one spec = a base record + an elite record. Without _b nothing can merge, so a mergeable item must be written out as a pair.',
  '引擎读的是 params，不是 buffs。手写 params 只会让卡面说谎，所以它每次都由 buffs 重算。': 'The engine reads params, not buffs. A hand-written params block only makes the card lie, so it is recomputed from the buffs every time.',
  '删除装备 {0}（连同它的精英记录）？': 'Delete the item {0} (together with its elite record)?',
});
