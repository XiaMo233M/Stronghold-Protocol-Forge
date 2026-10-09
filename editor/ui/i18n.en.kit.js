// editor/ui/i18n.en.kit.js — kit（行为层）编辑器页（kit.html / kit.js）的英文词条。
// 键是中文原文；改这一页时只碰这个文件（见 i18n.en.js 的汇总说明）。
//
// 这里**没有**这些中文，因为它们不是界面文案，而是数据或产物：kit 源码片段与钩子名/字段名/枚举值、
// 文件路径与命令行参数、blankSource() 里会写进作者 kits/<id>.js 的模板注释、以及服务端随 data.error 回传的报错。

export const EN_KIT = Object.freeze({
  // ---- 左栏（工坊包 / kit 列表） ----
  '＋ 新建 kit': '+ New kit',
  '工坊包 / kit': 'Workshop packs / kits',
  '{0} 错误': '{0} error(s)',
  '{0} 警告': '{0} warning(s)',
  '无署名头': 'no credit header',
  '{0} · {1} 字节 · {2}': '{0} · {1} bytes · {2}',
  '钩子 {0}': 'hooks {0}',
  '无钩子': 'no hooks',
  '可编辑（文件即源）': 'editable (the file is the source)',
  '（还没有 kit：点「＋ 新建 kit」）': '(no kit yet: click "+ New kit")',

  // ---- 中栏（工坊包 + id + 文件本体） ----
  '左边选一个 kit，或点「新建 kit」。': 'Pick a kit on the left, or click "New kit".',
  '这个页面编辑什么': 'What this page edits',
  'kit 是包里的 JavaScript（<pack>/kits/<干员 id>.js），不是数据表：默认导出的函数就是模拟器调用的 kit 实现。':
    'A kit is JavaScript in a pack (<pack>/kits/<operator id>.js), not a data table: the default-exported function is the kit implementation the simulator calls.',
  '它既是可编辑的源、也是游戏真正加载的产物，所以这里编辑的是文件本体（左栏没有「非编辑器管理」的记录可区分）。':
    'It is both the editable source and the artifact the game really loads, so what you edit here is the file itself (the left column has no "not editor-managed" record to tell them apart).',
  'kit id（= 它服务的干员 id，文件名就是它）': 'kit id (= the id of the operator it serves; that is the file name)',
  '文件内容（整份文件，含开头的署名注释）：保存时服务端只在缺少署名头时补写，已有的一行只更新 modified —— created 永远保留。':
    'File contents (the whole file, credit header included): on save the server only adds a header when one is missing, and an existing line only gets its modified updated — created is always kept.',

  // ---- 右栏（保存 / 删除） ----
  '先填 id：kit 的文件名必须正好是一个这个包提供的干员 id。': 'Fill in the id first: a kit\'s file name must be exactly an operator id this pack provides.',
  '已保存 {0}/kits/{1}.js。': 'Saved {0}/kits/{1}.js.',
  '已保存 {0}/kits/{1}.js（{2} 条警告）。': 'Saved {0}/kits/{1}.js ({2} warning(s)).',
  '删除 {0}/kits/{1}.js？': 'Delete {0}/kits/{1}.js?',

  // ---- 右栏（静态校验） ----
  '静态校验（编辑器不会运行你的文件）': 'Static checks (the editor does not run your file)',
  '（左边选一个 kit）': '(pick a kit on the left)',
  '✔ 静态校验通过': '✔ Static checks passed',
  '错误 {0} · 警告 {1}': '{0} error(s) · {1} warning(s)',
  '(源文件)': '(source file)',
  '静态校验只读文本：不 import、不执行。真正导入一遍（能否加载、有没有默认导出）由 node tools/workshop-validate.mjs 做。':
    'The static checks only read the text: no import, no execution. The real import run (does it load, does it default-export) is done by node tools/workshop-validate.mjs.',

  // ---- 右栏（钩子） ----
  '注册的钩子': 'Registered hooks',
  '（没有注册任何钩子）': '(no hook registered)',
  '钩子名必须是引擎真正会 emit 的名字：battle.on() 接受任意字符串，写错不会报错，也永远不会触发。':
    'A hook name must be one the engine really emits: battle.on() accepts any string, so a typo reports nothing and never fires.',

  // ---- 右栏（文件头 / 署名） ----
  '文件头（署名）': 'File header (credits)',
  '（未署名）': '(no author)',
  '创建 {0} · 最近修改 {1}': 'created {0} · last modified {1}',
  '这个文件还没有 Forge 署名头：保存时会写在文件开头（作者 / 创建时间 / 修改时间 / 来源 / 著作权与反打包转售声明），':
    'This file has no Forge credit header yet: saving writes one at the top of the file (author / creation time / modification time / source / copyright and anti-repackaging notice),',
  'created 之后每次保存都不会被重置。': 'and created is never reset by later saves.',

  // ---- 右栏（这个包可以用的 kit id） ----
  '这个包可以用的 kit id': 'kit ids this pack may use',
  '（先在中间选一个工坊包）': '(pick a workshop pack in the middle first)',
  '这个包还没有干员：先在这个包里保存一个干员（或在 pack.json 的 overrides 里声明 chess:<id>），否则这个 kit 不会被加载。':
    'This pack has no operator yet: save an operator into this pack first (or declare chess:<id> in the pack.json overrides), otherwise this kit is never loaded.',
  '这个包的 overrides：{0}': 'This pack\'s overrides: {0}',
  '文件名必须正好是这些 id 之一（或 overrides 声明的 chess:<id>）：对不上号的 kit 永远不会被使用。':
    'The file name must be exactly one of these ids (or a chess:<id> declared in overrides): a kit that matches nothing is never used.',

  // ---- 右栏（三条硬规则） ----
  '三条硬规则': 'Three hard rules',
  '返回了 kit 就必须自己给出 skill —— 引擎用 `u.kit.skill || null` 取技能，缺省技能不会回退到通用 kit。':
    'If you return a kit you must supply its own skill — the engine reads the skill with `u.kit.skill || null`, and the default skill does not fall back to the generic kit.',
  'import 只允许三种写法：`@kit/…`、`@sim/…` 与 `./…` 开头的本包相对路径（如 ./lib/bonds.js）；`..`、`/` 开头、裸模块名、require、动态导入一律被拒 —— 同一份文件服务端按真实路径、浏览器按 URL 各加载一次，只有这三种两端都对得上。':
    'Only three import forms are allowed: `@kit/…`, `@sim/…` and this pack\'s own relative paths starting with `./…` (e.g. ./lib/bonds.js). `..`, a leading `/`, bare module names, require and dynamic import are all refused — the same file is loaded once on the server by real path and once in the browser by URL, and only these three forms resolve on both ends.',
  'kits/ 里哪些文件算 kit：只有**顶层**的 <干员 id>.js。子目录（kits/lib/…）与 `_` 开头的文件（kits/_shared.js）都不是 kit，可以放共享代码让 kit 用 `./…` import。':
    'Which files under kits/ count as kits: only a **top-level** <operator id>.js. A subdirectory (kits/lib/…) and a file starting with `_` (kits/_shared.js) are not kits — put shared code there and import it with `./…`.',
  '它会跑在玩家浏览器里，服务端用同一份文件复算这场战斗 —— 随机用 battle.rng，不要碰 DOM / 网络 / 墙钟时间。':
    'It runs in the player\'s browser, and the server recomputes the same battle with the same file — use battle.rng for randomness, and never touch the DOM / network / wall-clock time.',
  '另外：kit 所在的包必须贡献至少一个数据文件（例如 chess）—— 空包不会被加载，它的 kit 也就不会被导入。':
    'Also: the pack a kit lives in must contribute at least one data file (for example chess) — an empty pack is never loaded, so its kits are never imported.',
  '完整写法、词表与自检闭环：': 'Full syntax, vocabulary and self-check loop:',
  '引擎会 emit 的事件名（{0} 个，可钩）': 'Event names the engine emits ({0}, hookable)',
  '禁用词（会静默破坏复算的 {0} 项）': 'Forbidden words ({0} that silently break recomputation)',

  // ---- 页头与载入 ----
  '新建 kit': 'New kit',
  '{0} 个 kit（{1} 个工坊包）': '{0} kit(s) ({1} workshop pack(s))',
  '{0} 个工坊包，还没有 kit': '{0} workshop pack(s), no kit yet',
});
