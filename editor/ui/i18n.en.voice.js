// editor/ui/i18n.en.voice.js — 语音编辑器页（voice.html / voice.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。
//
// 一个键只定义一次，别的分片已经有同一条中文时这里只写 t() 调用、不再重复一份（合并后的 EN 照样查得到）。
// 本页借用的词条：导航/页名/`重新载入`/`载入失败：{0}` 在 i18n.en.shared.js；
// `保存中…` 在 i18n.en.index.js；`干员 id`、`{0} 条`、`；⚠ {0}` 在 i18n.en.pack.js；`官方` 在 i18n.en.wave.js。
// 重复定义同一个键会被 test/editorI18n.test.js 的「分片之间没有重复键」判失败。
// 不翻的东西（它们会写进用户的 pack.json，或本来就是数据）：干员 id、包内路径与文件名、扩展名、
// 槽位枚举值（start/select/…）、错误码（BAD_MANIFEST / ASSETS_NEED_LICENSE）。占位符里的示例值也一样，
// 所以「例如 char_ws_my_op」写成 t('例如 {0}', 'char_ws_my_op')，只翻「例如」。

export const EN_VOICE = Object.freeze({
  // ---- 槽位名（仅展示；槽位清单本身来自服务端） ----
  '行动出发（开战）': 'Sortie (battle start)',
  '行动开始（首次接敌）': 'Engagement (first contact)',
  '选中干员': 'Operator selected',
  '部署': 'Deployment',
  '作战中1': 'In battle 1',
  '作战中2': 'In battle 2',
  '作战中3': 'In battle 3',
  '作战中4': 'In battle 4',
  '完成高难行动': 'Hard operation cleared',
  '3 星结束行动（完美作战）': '3-star clear (perfect run)',
  '非 3 星结束行动': 'Under 3-star clear',
  '行动失败': 'Operation failed',

  // ---- 左栏：包 ----
  '还没有工坊包（先用干员编辑器建一个）': 'No workshop pack yet (create one in the operator editor first)',
  '{0} 条语音': '{0} voice line(s)',
  '{0} 条语音 · 没有 assets/': '{0} voice line(s) · no assets/',
  '清单可加载': 'Manifest loads',
  '缺 license': 'Missing license',

  // ---- 中栏：已配的语音 ----
  '左边选一个工坊包，或先用干员编辑器建一个。': 'Pick a workshop pack on the left, or create one in the operator editor first.',
  '「{0}」的语音': 'Voice lines for “{0}”',
  // ---- 中栏：配音语言（默认配音 + voiceLangs 里的其它语种） ----
  // 语言名（中文 / 日本語 / English / 한국어，shared/constants.js VOICE_LANG_NAMES）是 data，按母语写法显示，不翻。
  '配音语言': 'Voice language',
  '默认配音': 'default dub',
  '本包已声明 {0} 种配音语言': '{0} dubbed language(s) declared by this pack',
  '编辑 {0} 这一份配音（voiceLangs.{1}）': 'Edit the {0} table (voiceLangs.{1})',
  '默认配音写在同一份 pack.json 的 voices 字段里（清单的 audio.voiceLang 指明它是哪一种）': 'The default dub lives in the voices field of the same pack.json (the manifest’s audio.voiceLang says which one it is)',
  '这里的语种会写进 pack.json 的 voiceLangs：只写你真的配了台词的语种，默认配音「{0}」照旧写在 voices 里，所以它不能作为 voiceLangs 的键（加载器会报 VOICE_LANG_DEFAULT）。': 'These languages are written to voiceLangs in pack.json: only the ones you really recorded lines for. The default dub “{0}” stays in voices, so it can never be a key of voiceLangs (the loader reports VOICE_LANG_DEFAULT).',
  '这个包还没有「{0}」配音。右边选干员、槽位和文件，加一条就声明了这个语种。': 'This pack has no “{0}” dub yet. Pick an operator, a slot and a file on the right — adding one line declares this language.',
  '当前配音': 'Current dub',
  '这个包还没有 assets/ 文件夹，所以还不能写 voices：先建 workshop/{0}/assets/ 并把音频文件放进去。': 'This pack has no assets/ folder yet, so voices cannot be written: create workshop/{0}/assets/ and put the audio files there.',
  '有 assets/ 就必须声明 license，否则整个包会被加载器拒绝（ASSETS_NEED_LICENSE）—— 去「包管理」页的「包元数据」里填一个（0.8.1 起，不必再手改 pack.json）。':
    'With an assets/ folder the pack must declare a license, or the loader rejects the whole pack (ASSETS_NEED_LICENSE) — fill one in under “Pack metadata” on the Pack manager page (since 0.8.1 you no longer have to hand-edit pack.json).',
  'pack.json 现在会被加载器拒绝：[{0}] {1}': 'pack.json is currently rejected by the loader: [{0}] {1}',
  '这个包还没有语音。右边选干员、槽位和文件，就能加一条。': 'This pack has no voice lines yet. Pick an operator, a slot and a file on the right to add one.',
  '不是已知干员 id': 'Unknown operator id',
  '不是合法槽位': 'Not a valid slot',
  '清空本槽位': 'Clear slot',
  '这个槽位不在 VOICE_SLOTS 里，只能手工改 pack.json': 'This slot is not in VOICE_SLOTS — edit pack.json by hand',
  '文件不存在': 'File not found',
  '类型不允许': 'Type not allowed',
  '不是音频': 'Not audio',
  '试听': 'Preview',
  '删除本行': 'Delete this line',
  '文件放这里：workshop/{0}/assets/**（编辑器不上传素材，请自己把文件拷进去）。试听播放的就是 /workshop-assets/<包>/<路径>，和游戏客户端读的是同一条通路。': 'Put the files here: workshop/{0}/assets/** (the editor does not upload assets — copy the files in yourself). Preview plays /workshop-assets/<pack>/<path> — the same route the game client reads.',

  // ---- 右栏：加一条 / 清空 ----
  '加一条语音': 'Add a voice line',
  '先选一个工坊包。': 'Pick a workshop pack first.',
  '例如 {0}': 'e.g. {0}',
  '槽位': 'Slot',
  '本包({0})': 'this pack ({0})',
  '音频': 'audio',
  '非音频': 'non-audio',
  '服务端不会提供这个类型': 'the server will not serve this type',
  '文件（包内 assets/ 下的相对路径）': 'File (path relative to assets/ inside the pack)',
  '加入该槽位': 'Add to this slot',
  '清空该槽位': 'Clear this slot',
  '一个槽位可以有任意多条，客户端每次随机挑一条并避免连续重复；同一个干员同一槽位，官方台词在前、包台词在后。': 'A slot can hold any number of lines; the client picks one at random and avoids repeating the last one. For the same operator and slot, official lines come first, pack lines after.',
  '该包 assets/ 下的文件（{0} 个）': 'Files under the pack assets/ ({0})',
  '没有找到文件（文件夹不存在，或还没放素材）。': 'No files found (the folder does not exist, or no assets have been added yet).',
  '槽位与位置': 'Slots and placement',
  '路径相对 workshop/{0}/assets/；不能以 / 开头、不能含反斜杠、盘符或 . .. 段，文件必须真的存在，扩展名必须在包内媒体允许的类型里（{1} 是音频）。': 'The path is relative to workshop/{0}/assets/; it must not start with /, must not contain a backslash, a drive letter, or a . / .. segment, and the file must really exist. The extension must be in the pack media allowlist ({1} are audio).',

  // ---- 动作与提示 ----
  '试听失败：{0}（{1}）': 'Preview failed: {0} ({1})',
  '先填干员 id。': 'Fill in the operator id first.',
  '先选一个槽位。': 'Pick a slot first.',
  // 页面自己先挡一次「语种不在 VOICE_LANGS 里」（服务端也会挡，文案对齐加载器的错误码）
  '配音语言不合法（VOICE_LANG_UNKNOWN）：可用配音是 {0}': 'Not a valid voice language (VOICE_LANG_UNKNOWN): the available dubs are {0}',
  '{0} · {1} · {2}：现在 {3} 条': '{0} · {1} · {2}: now {3} line(s)',
  '先选一个文件（assets/ 下的相对路径）。': 'Pick a file first (a relative path under assets/).',
  '这个槽位已经有 "{0}" 了。': 'This slot already has "{0}".',
  '先填干员 id 并选一个槽位。': 'Fill in the operator id and pick a slot first.',
  '清空 {0} 的 {1} 槽位？': 'Clear slot {1} of {0}?',
  '{0} 个工坊包 · {1} 条语音': '{0} workshop pack(s) · {1} voice line(s)',

  // ---- voice.html 的静态文案 ----
  '工坊包 / 语音': 'Packs / voice',
});
