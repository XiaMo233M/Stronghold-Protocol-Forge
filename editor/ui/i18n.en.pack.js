// editor/ui/i18n.en.pack.js — 包管理页（pack.html / pack.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。

export const EN_PACK = Object.freeze({
  // ---- 左栏：包列表 ----
  '还没有工坊包（先用干员编辑器建一个，或导入一个 .zip）': 'No workshop pack yet — create one in the operator editor first, or import a .zip',
  '、': '·',
  '内容 {0}': 'content {0}',
  '内容（无）': 'content (none)',
  '语音 {0}': 'voice {0}',
  '助战 {0}': 'support {0}',
  '{0} 个': '{0}',
  '加载器接受': 'loader accepts',

  // ---- 中栏：包详情 ----
  '左边选一个工坊包，或在右边导入一个 .zip。': 'Pick a workshop pack on the left, or import a .zip on the right.',
  '「{0}」': '“{0}”',
  '包 id': 'Pack id',
  '版本': 'Version',
  '作者': 'Author',
  '（未声明）': '(not declared)',
  '授权 license': 'License',
  '内容文件': 'Content files',
  '（无 —— 只带语音/助战也是合法的包）': '(none — a pack may ship only voice/support)',
  '语音': 'Voice',
  '自带素材': 'Bundled assets',
  '有 assets/（必须有 license）': 'has assets/ (license is then required)',
  '没有 assets/': 'no assets/',
  '✔ 加载器接受这个包（格式与 content 声明都对得上）。改完要重启游戏服务器才会生效。': '✔ The loader accepts this pack (its format and content declaration agree). Restart the game server for changes to take effect.',
  '✘ 加载器不会使用这个包：{0}': '✘ The loader will not use this pack: {0}',
  '（未知原因）': '(unknown reason)',
  '；pack.json 本身：{0} — {1}': '; pack.json itself: {0} — {1}',

  // ---- 中栏：助战声明 ----
  '助战声明（pack.json 的 support）': 'Support declaration (pack.json support)',
  '只勾选**这个包自己新增**的干员：卡池是安装方的规则，包不能把官方干员塞进或移出卡池（违反会被加载器记 SUPPORT_FOREIGN_OPERATOR 并整条丢掉）。阶由记录推导，这里不接受手输的阶 —— 手写的阶一旦与记录不一致，该干员会静默不可选（isSupportChess 要求 id 出现在它自己那一阶的池子里）。': 'Tick only operators **this pack itself adds**: the pool belongs to the install, and a pack cannot push official operators in or out (the loader records SUPPORT_FOREIGN_OPERATOR and drops the whole entry). The tier is derived from the record — there is no field to type one: a hand-written tier that disagrees with the record makes the operator silently unselectable (isSupportChess requires the id to appear in the pool of its own tier).',
  '这个包还没有自己的 chess.json —— 先在干员编辑器里保存一个干员，助战声明才有对象。': 'This pack has no chess.json of its own yet — save an operator in the operator editor first, then there is something to declare.',
  '阶（推导）': 'Tier (derived)',
  '会不会进卡池': 'Enters the pool?',
  '这条记录没有 1–6 的整数 tier，进不了卡池': 'This record has no integer tier 1–6, so it can never enter the pool',
  '（无整数 tier）': '(no integer tier)',
  '会进 {0} 阶卡池': 'enters the tier-{0} pool',
  '阶梯未知，进不了池': 'tier unknown, cannot enter the pool',
  '未声明': 'not declared',
  '保存助战声明': 'Save support declaration',
  '还原': 'Reset',
  '保存只改 pack.json 的 support 字段：其余字段、键序与两空格缩进原样保留，也不会给包补一条它没声明过的 content。': 'Saving touches only the support field of pack.json: every other field, the key order and the two-space indent stay as they are, and no content entry the pack never declared gets added.',
  '{0} 条声明会被拒绝': '{0} declaration(s) will be rejected',
  '[{0}] {1}：{2}': '[{0}] {1}: {2}',

  // ---- 中栏：卡池在哪里 ----
  '卡池在哪里': 'Where the pool really lives',
  '{0} 阶：{1}': 'tier {0}: {1}',
  '当前 data/support.json 的卡池：{0}': 'Current pool in data/support.json: {0}',
  'data/support.json 里没有可用的卡池（没有这个文件，或没有「名额 + 卡池」的组合）。': 'data/support.json has no usable pool (the file is missing, or it has no "slots + pool" combination).',
  '助战卡池本身由服务端的 data/support.json 决定：这个页面只写包的「建议」。安装方在那里写 "workshop": false 就会忽略所有包的助战声明（启动日志会写出来）。': 'The support pool itself is decided by data/support.json on the server: this page only writes the pack’s suggestion. An install that writes "workshop": false there ignores every pack’s support declaration (its startup log says so).',
  '⚠ 这个安装现在没有开启助战，保存后这些声明不会进卡池。': '⚠ Support is currently off for this install, so saving these declarations will not put anything into the pool.',

  // ---- 右栏：导出 ----
  '导出一个包': 'Export a pack',
  '下载 <包id>.zip：pack.json 与包内所有文件（含 assets/ 整个目录）都在 zip 根，所以这个 zip 就是这个包。条目按名字排序、时间戳固定，同样的内容永远得到同样的字节。': 'Downloads <pack id>.zip: pack.json and every file of the pack (the whole assets/ directory included) sit at the zip root, so the zip is the pack. Entries are sorted by name with fixed timestamps, so the same content always gives the same bytes.',
  '导出中…': 'Exporting…',
  '导出 {0}.zip': 'Export {0}.zip',
  '（先选一个包）': '(pick a pack first)',
  '命令行等价：node tools/workshop-pack.mjs export <包id>': 'CLI equivalent: node tools/workshop-pack.mjs export <pack id>',

  // ---- 右栏：导入 ----
  '导入一个包': 'Import a pack',
  '覆盖同名包（--force）': 'Overwrite a pack of the same name (--force)',
  '导入中…': 'Importing…',
  '导入这个 .zip': 'Import this .zip',
  '.zip 文件': '.zip file',
  '先解压到临时目录、校验 pack.json（用加载器自己的规则），再整个搬进 workshop/<包id>/。坏归档、恶意归档、校验不过的包都不会在 workshop/ 里留下半个包；同名包默认拒绝覆盖。': 'The archive is unpacked to a temp directory, pack.json is validated (with the loader’s own rules), then the whole thing moves into workshop/<pack id>/. A broken, malicious or invalid archive leaves nothing behind in workshop/; a pack of the same name is refused by default.',
  '命令行等价：node tools/workshop-pack.mjs import <文件.zip> [--force]': 'CLI equivalent: node tools/workshop-pack.mjs import <file.zip> [--force]',

  // ---- 右栏：试玩 ----
  '试玩这一版': 'Playtest this build',
  '游戏服务器正在跑：{0}': 'The game server is running: {0}',
  '起一个游戏服务器（子进程，绑 127.0.0.1 的随机空闲端口），把当前工坊根交给它，然后打开浏览器直接进一局独立模拟。改完包再点一次「重启试玩」就能看到新内容 —— 编辑器自己不会重载数据。': 'Starts a game server (a child process bound to a random free port on 127.0.0.1), hands it the current workshop root, then opens a browser straight into a standalone simulation. Change a pack, click “Restart playtest”, and the new content shows up — the editor never reloads data by itself.',
  '难度': 'Difficulty',
  '启动中…': 'Starting…',
  '重启试玩': 'Restart playtest',
  '启动试玩': 'Start playtest',
  '停止': 'Stop',
  '在新标签页打开这一局': 'Open this match in a new tab',
  '命令行等价：node scripts/launch.mjs（游戏服务器）；试玩用的是 SP_WORKSHOP，所以这里选的工坊目录就是它读的目录。': 'CLI equivalent: node scripts/launch.mjs (the game server); the playtest uses SP_WORKSHOP, so the workshop directory picked here is the one it reads.',

  // ---- 右栏：说明 ----
  '说明': 'Notes',
  '导入的包必须自带 pack.json（在 zip 根，或包在一个唯一的顶层目录里 —— 两种归档都很常见）。校验用 shared/workshop.js 的 normalizePackManifest，与游戏加载器同一个函数，所以「装得上」就是「加载器会接受」。': 'An imported pack must carry its own pack.json (at the zip root, or wrapped in a single top-level directory — both layouts are common). Validation uses normalizePackManifest from shared/workshop.js, the same function the game loader uses, so “it installs” means “the loader accepts it”.',
  '装好的包要重启游戏服务器才会出现在游戏里。这里只写 workshop/<包id>/ 与 pack.json 的 support 字段。': 'An installed pack shows up in the game only after the game server restarts. All this page writes is workshop/<pack id>/ and the support field of pack.json.',

  // ---- 消息与错误回显 ----
  '{0} 个文件': '{0} file(s)',
  '{0} 字节': '{0} bytes',
  '已安装 {0}：{1}。重启游戏服务器后生效。': 'Installed {0}: {1}. Restart the game server to take effect.',
  '导入被拒绝：{0}': 'Import refused: {0}',
  '先选一个 .zip 文件。': 'Pick a .zip file first.',
  '已导出 {0}.zip（{1} 字节）': 'Exported {0}.zip ({1} bytes)',
  '{0}→{1} 阶': '{0} → tier {1}',
  '；': ';',
  '（{0}）': '({0})',
  '已写入 {0} 的 support：{1} 个{2}{3}': 'Wrote the support of {0}: {1} entr(ies){2}{3}',
  '{0} 的 support 没有变化，文件未被改写{1}': 'The support of {0} is unchanged; the file was not rewritten{1}',
  '试玩服务器已就绪：{0}': 'Playtest server is ready: {0}',
  '试玩服务器已停止。': 'The playtest server stopped.',
  '试玩服务器本来就没在跑。': 'The playtest server was not running.',
  '{0} 个包': '{0} pack(s)',
  '还没有包': 'no pack yet',
});
