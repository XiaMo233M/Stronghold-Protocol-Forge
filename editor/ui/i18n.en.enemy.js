// editor/ui/i18n.en.enemy.js — 怪物编辑器页（enemy.html / enemy.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。
//
// 词典里只放「本页独有」的键：导航、页名、名称、可编辑、保存中…、已删除 {0} 等共用词条在 shared / index 分片里，
// 这里再写一遍会让「分片之间没有重复键」那条测试失败。本页与别的页面共用的新词条同理只写一处。

export const EN_ENEMY = Object.freeze({
  // ---- 左栏：列表与新建 ----
  '＋ 新建怪物': '+ New enemy',
  '新建怪物': 'New enemy',
  '工坊包 / 怪物': 'Packs / enemies',
  '{0} 只工坊怪物': '{0} workshop enemies',
  '还没有工坊怪物': 'No workshop enemies yet',
  '能力 {0} · 技能 {1}': 'Abilities {0} · skills {1}',

  // ---- 表单：身份 ----
  '左边选一只怪物，或点「新建怪物」。': 'Pick an enemy on the left, or click “New enemy”.',
  // id（slug）不在本分片：stage / wave 分片已经译过同一条（重复键会被 test/editorI18n.test.js 抓住）
  '会生成 enemy_ws_<id>，例如 frost_hound': 'Generates enemy_ws_<id>, e.g. frost_hound',
  '等级 rank': 'Rank',
  // 枚举值本身（NORMAL / ELITE / BOSS）不能动：它是写进用户文件的取值，中文标签才是给人看的
  'NORMAL 普通': 'NORMAL — Normal',
  'ELITE 精英': 'ELITE — Elite',
  'BOSS 领袖': 'BOSS — Boss',
  '攻击方式': 'Attack type',
  '伤害类型': 'Damage type',
  'phys 物理': 'phys — Physical',
  'arts 法术': 'arts — Arts',
  'none 无攻击': 'none — No attack',
  '移动方式': 'Movement type',
  'WALK 地面': 'WALK — Ground',
  'FLY 飞行': 'FLY — Flying',
  '描述': 'Description',
  '飞行单位（不填则跟随移动方式）': 'Flying unit (leave empty to follow the movement type)',
  '不计入总数': 'Does not count toward the total',

  // ---- 表单：数值 ----
  '数值 stats': 'Stats',
  '生命上限': 'Max HP',
  '攻击': 'ATK',
  '防御': 'DEF',
  '法抗': 'RES',
  '移动速度': 'Move speed',
  '攻击间隔(秒)': 'Attack interval (s)',
  '攻速': 'Attack speed',
  '射程(格)': 'Range (tiles)',
  '阻挡数': 'Block count',
  '重量等级': 'Weight level',
  '生命恢复比例': 'HP recovery ratio',
  '每秒回血': 'HP regen per second',
  '元素抗性': 'Elemental RES',
  '元素伤害抗性': 'Elemental damage RES',
  '物理命中率': 'Physical hit rate',
  '法术命中率': 'Arts hit rate',
  '嘲讽等级': 'Taunt level',
  '这些字段下面是推导量，不要手写。': 'The fields below are derived — do not type them by hand.',

  // ---- 表单：特殊机制 ----
  '特殊机制': 'Special mechanics',
  '能力说明（abilities，一行一条，游戏里显示的那几行）': 'Ability text (abilities — one per line; these are the lines the game shows)',
  '天赋黑板 talents.bb（键 → 数值）': 'Talent blackboard (talents.bb — key → value)',
  '技能 skills（JSON 数组；每项形如 { prefabKey, priority, cooldown, bb }）': 'Skills (skills — a JSON array; each item looks like { prefabKey, priority, cooldown, bb })',
  '能力分类 acType': 'Ability category (acType)',
  '标记 tags（逗号分隔）': 'Tags (tags — comma-separated)',
  '免疫 {0}': 'Immune to {0}',

  // ---- 表单：美术与非数据表字段 ----
  '美术与非数据表字段': 'Art and off-datatable fields',
  '这些字段不在游戏数据表里（来自客户端清单），所以必须手填。spine 复用现有怪物的 prefab 键才有真美术。': 'These fields are not in the game data tables (they come from the client manifest), so they must be typed by hand. Only reusing an existing enemy prefab key in spine gives real art.',
  'spine（复用现有 prefab，如 enemy_1007_slime）': 'spine (reuse an existing prefab, e.g. enemy_1007_slime)',
  '模型缩放 modelScale': 'Model scale (modelScale)',
  'beFactor（战力系数，默认 1）': 'beFactor (power factor, default 1)',
  '受击框 w': 'Hit box w',
  '受击框 h': 'Hit box h',
  '偏移 dx': 'Offset dx',
  '偏移 dy': 'Offset dy',

  // ---- 右栏：派生量与校验 ----
  'be 决定阵营换怪时替换多少只，所以它必须由数值算出来，不能手填。': 'be decides how many enemies a faction swap replaces, so it must be computed from the stats — never typed by hand.',
  'skills 不是合法 JSON，暂不校验': 'skills is not valid JSON — validation is skipped',
  '删除怪物 {0}？': 'Delete enemy {0}?',

  // ---- 模板新建与数值参照（本页专属；「返回 / 以模板新建 / 已复制…」等与干员页共用的在 shared） ----
  '选一只怪物当底子：数值、档位、攻击方式、能力文字、技能、免疫与 spine 都会带过来，之后填一个新 id 与名字就能保存。': 'Pick an enemy as the base: stats, rank, attack way, ability text, skills, immunities and spine all come along — then give it a new id and name and save.',
  '搜索怪物（名称 / key）': 'Search enemies (name / key)',
  '复制本包的怪物（{0} 只）': 'Copy an enemy from this pack ({0})',
  '官方怪物（匹配 {0} / 共 {1}）': 'Official enemies ({0} of {1} match)',
  '（没有匹配的怪物）': '(no enemy matches)',
  '只显示了前 {0} 只，用上面的搜索框缩小范围。': 'Only the first {0} are shown — narrow it down with the search box above.',
  '细线上的刻度是官方同档位怪物的区间（共 {0} 只），只作参照，不是上限。': 'The tick on the line is the official range for this rank ({0} enemies) — a reference, not a cap.',
  '这个 prefab 键不在官方清单里：游戏里会显示成占位模型（不会报错）。': 'This prefab key is not in the official list: the game shows a placeholder model instead (and reports nothing).',
  '留空则用占位模型；想要真美术就填一个官方 prefab 键。': 'Leave it empty for the placeholder model; type an official prefab key to get real art.',
  '是官方 prefab 键，游戏里用这套美术。': 'A real official prefab key — the game uses this art.',

  // ---- 本包自带的外观素材（pack.json 的 art；这一页是 enemies 表、扁平的 spine） ----
  '客户端画一只怪物时读的是合并后的 `data/assets.json` 的 `enemies`：这里声明的东西会被并进那一条（素材走 /workshop-assets），客户端零改动。路径都相对包的 `assets/`，文件要自己先放进去 —— 编辑器不上传素材。': 'To draw an enemy the client reads the merged data/assets.json enemies table: what you declare here is merged into that entry (the files are served from /workshop-assets), so the client needs no change. Every path is relative to the pack’s assets/ — put the files there yourself, the editor does not upload assets.',
  '先在右边选一个工坊包。': 'Pick a workshop pack on the right first.',
  '先填 id（记录键是 enemy_ws_<id>，客户端就是拿它去 `enemies` 表查外观），再回来给它配素材。': 'Fill in an id first (the record key is enemy_ws_<id>, which is what the client looks up in the enemies table), then come back to give it art.',
  '图标 icon': 'Icon',
  '别人的模型 spineAliasOf（可留空）': 'Another enemy’s model (spineAliasOf — may be empty)',
  '还没选骨架：这一条就不会带模型（只换图标/头像也可以）。': 'No skeleton picked yet: this entry ships no model (replacing only the icon is fine).',
  "✎ 覆盖官方怪物": "✎ Override an official enemy",
  "覆盖官方怪物": "Override an official enemy",
  "选一只官方怪物：编辑器会把它**原样**读成表单（key 就是官方 key，不加 enemy_ws_ 前缀）。你只改要改的字段，没写的字段保存后仍然是官方的 —— 保存时会自动往 pack.json 的 overrides 里补一条声明。": "Pick an official enemy: the editor reads it into the form as-is (the key is the official key, with no enemy_ws_ prefix). Change only the fields you care about — anything you leave alone stays official — and saving adds the matching declaration to pack.json overrides for you.",
  "官方 key {0}": "official key {0}",
  "已打开官方怪物「{0}」（key {1}）：你改的字段会覆盖它，没改的仍然是官方的。": "Opened the official enemy “{0}” (key {1}): the fields you change override it, the ones you leave alone stay official.",
  "将改动的字段（覆盖官方 key）": "Fields that will change (official key override)",
});
