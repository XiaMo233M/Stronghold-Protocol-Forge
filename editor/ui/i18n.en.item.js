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

  // ---- 表单：本包自带的图标（pack.json 的 itemIcons） ----
  // 这一段的按钮/标签文案与盟约页共用（`本包自带的图标（可选）`、`图标文件（本包 assets/ 下的图片）`、
  // `（不用本包图标）`、`已把 {0} 的图标设为本包的 {1}` 等原文逐字相同），所以那些不在这里重复译。
  '客户端按**道具的图标 id** 取图：`itemIconUrl` 先看 `item.iconId`、再看 `item.trapId`，都从 `data/assets.json` 的 `items` 里查。配了本包这张图（走 /workshop-assets）就显示它；没配就看官方清单有没有这个 id，都没有就是兜底图。图片要自己先放进 `{0}/assets/`，编辑器不上传素材。': 'The client resolves an item icon by **item icon id**: `itemIconUrl` reads `item.iconId` first, then `item.trapId`, and looks that id up in `data/assets.json`’s `items`. This pack’s image (served from /workshop-assets) is used when set; otherwise the official manifest decides, and with no entry at all the fallback art shows. Put the image into `{0}/assets/` yourself — the editor never uploads assets.',
  '这件装备还没有图标 id：先在「图标 trapId」里填一个（如 trap_ws_my_item）并保存，再回来给它配图。': 'This item has no icon id yet: fill in “Icon (trapId)” (e.g. trap_ws_my_item), save, then come back to give it an icon.',
  '本包的 `assets/` 里还没有图片：把图标文件放进去（如 assets/item/{0}.png），再回到这一页挑。': 'This pack’s `assets/` has no images yet: put the icon file there (e.g. assets/item/{0}.png) and come back to pick it.',
  '官方清单里没有 `{0}` 这张图：不配本包图标时，这件装备显示兜底图。': 'The official manifest has no `{0}`: without a pack icon this item shows the fallback art.',
  // ---- 表单：本包已声明的装备图标（pack.json 的 itemIcons，含陈旧条目） ----
  // 上面那一段只认当前 trapId；这一块把**全部**声明列出来，好让作者删掉改过 trapId 之后遗留下来的那条。
  // `有人在用` 与 `陈旧 / 没人用` 两条与盟约页共用：一个键只准出现在一个分片里（test/editorI18n.test.js 查重复键），
  // 而 i18n.en.shared.js 不在这次改动范围内，所以按「只留一份」的规则归属这里，两页的原文刻意逐字相同。
  '本包已声明的装备图标': 'Item icons this pack declares',
  'pack.json 的 `itemIcons` 里声明的每一条都列在下面，含已经没人用的那条：不用手改清单，在这一页删掉就行。': 'Every entry declared in pack.json’s `itemIcons` is listed below, including the ones nothing uses any more: no hand-editing the manifest — delete it right here.',
  // ---- 中栏：没有打开任何装备时的清单（包删光装备之后只剩旧声明的那条边界） ----
  // 这一块要常驻，所以它的包来源必须写在页面上（`state.packId` 与右栏「保存到」是同一个值）。
  '下面列的是 {0} 这个包在 pack.json 里声明的装备图标：想看别的包，用右边「保存到」那里的包下拉换。': 'Listed below are the item icons this pack ({0}) declares in pack.json: to look at another pack, switch it with the pack dropdown under “Save to” on the right.',
  '还没有工坊包：先在下面选一个包（或点「＋ 新建一个包…」）。': 'No workshop pack yet: pick one below first (or click “+ New pack…”).',
  '「有人在用」= 本包 items.json 里有记录的 iconId / trapId 等于它。': '“In use” = a record in this pack’s items.json has this id as its iconId / trapId.',
  '有人在用': 'in use',
  '陈旧 / 没人用': 'stale / unused',
  '本包还没有声明任何自带装备图标。': 'This pack declares no icon of its own yet.',
  '「陈旧 / 没人用」不是错误：它不违反规则，只是本包没有记录再用这个 id 当图标 —— 留着它这张图也永远不会显示。': '“Stale / unused” is not an error: it breaks no rule — it only means no record of this pack uses this id as an item icon any more, so the image never shows while the entry stays.',
  '删掉本包图标 {0} 的声明？（图片文件本身不会删）': 'Delete this pack’s icon declaration for {0}? (The image file itself is not deleted)',

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
