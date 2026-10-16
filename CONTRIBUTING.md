# 参与贡献

欢迎提 Issue 和 Pull Request：bug、和官方规则不一致的地方、新干员的战斗逻辑、翻译、文档都可以。动手之前先看一眼
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（代码地图：哪个规则在哪个文件）。English summary at the end.

## 1. 准备环境

需要 Node.js 22 或 24。CI 在 ubuntu 与 windows 两个系统上、按这两个 Node 版本跑矩阵（`.github/workflows/ci.yml`）。

```bash
git clone https://github.com/XiaMo233M/Stronghold-Protocol-Forge.git
cd Stronghold-Protocol-Forge
npm install        # postinstall 把 pixi / preact / three 复制到 public/vendor
npm run setup      # 下载美术 / 音频（只跑测试可以不下载：多数用例缺素材会跳过，少数严格判据会硬失败，见本节末）
npm run dev        # 启动服务器（node --watch，改了服务器代码自动重启）：http://localhost:3000
```

**本仓是 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 底座之上的非官方改版。**
贡献提到**本仓**（`XiaMo233M/Stronghold-Protocol-Forge`），不要提到上游原作；往上游客提过的 PR 记在
[docs/UPSTREAM-PR-LEDGER.md](docs/UPSTREAM-PR-LEDGER.md)。

`npm run doctor` 检查 Node 版本、素材、端口。官方数据表由 `tools/build-data.mjs` 下载到 `.cache/gamedata/`，改数据时才需要。

### 多 worktree 并行，与缺素材时哪些用例会红

`git worktree add` 出来的新工作树**只带跟踪文件**：`public/assets`、`public/vendor`、fonts 目录（同在 `public/` 下）
与 `data/local-assets.json` 都是 git-ignored 的，不会跟过来，得自己接上。

| 要接的东西 | 从哪来 |
|---|---|
| `public/vendor` | `npm install` 的 postinstall（`tools/vendor.mjs`） |
| `public/assets` | `node tools/fetch-assets.mjs`，约 270 MB |
| fonts 目录（同在 `public/` 下） | 同上，`fetch-assets` 一并生成 |
| `data/local-assets.json` | `tools/local-extract/extract.py`，从本机客户端提取 |

```powershell
# 示例：把新工作树里的四处接线指回有素材的主树（Windows；macOS / Linux 用 ln -s 代替 mklink /J）
cmd /c mklink /J  public\vendor            <主树>\public\vendor
cmd /c mklink /J  public\assets            <主树>\public\assets
cmd /c mklink /J  public\fonts             <主树>\public\fonts
cmd /c mklink /H  data\local-assets.json   <主树>\data\local-assets.json
```

**症状**：不接就跑 `node --test`，会看到两类失败 —— `test/editor.test.js:596` 要 `/data/local-assets.json` 却得到
404，`test/modAssets.test.js:341` 的 `assert.ok(haveBgm && haveFont)` 直接失败 —— 外加一批跳过（缺素材的用例自己
跳过）。接好这四处之后，这两条失败就不再出现。**结论：这是工作树搭建问题，不是产品缺陷**
（它们报的是接线缺失，不是代码缺陷）。

**缺素材时跳不跳**：多数用例会自己跳过（`test/assets.test.js` 用 `t.skip('fonts not generated …')`），但少数
**严格判据**缺素材就**硬失败**（`test/modAssets.test.js`：它要拿两份真实文件对照 `/assets` 与 `/fonts` 声明
`cache-only` 后必须是 412，没有素材就没有对照）。所以只跑测试可以不下载素材；碰到硬失败先 `npm run assets`
补齐，别当成代码坏了。

## 2. 运行测试

只跑和改动相关的测试，提交 PR 前再跑一次全部：

```bash
node --test test/content/op_siege.test.js                        # 一个文件
node --test --test-name-pattern="S3" test/content/op_siege.test.js  # 文件里的部分用例
node --test                                                      # 全部（多数需要浏览器 / 素材的用例自动跳过；少数严格判据缺素材会硬失败，见 §1 末）
npm run golden                                                   # 黄金结果：整套固定种子的战斗和对局
GOLDEN_FULL=1 node --test test/golden.test.js                    # 同上，node:test 形式
npm run golden:update                                            # 有意改变玩法时重新生成
npm run lint && npm run check:imports && npm run typecheck       # 代码检查、导入边界、类型
```

提交 PR 前可以一条命令跑一遍 GitHub CI（`.github/workflows/ci.yml`）的全部检查：`npm run ci`（或 `node tools/ci.mjs`）。
它按顺序跑 `setup` → `test` → `smoke` → `lint` → `imports` → `typecheck`（`tools/ci.mjs` 里的 `STEPS`），
第一步失败就停下并打印每步结果和耗时。`--keep-going` 失败后继续，`--only lint,test` 只跑指定步骤，`--list` 列出步骤。
不包含 `npm ci`（依赖请自己装），也不跑 Node 版本 × 系统的矩阵。

浏览器测试默认不跑，需要本机 Chrome（路径不标准时设置 `CHROME_PATH`），用环境变量打开：

```bash
SP_E2E=1 node --test test/ui/mock.e2e.test.js                    # 界面端到端（不需要素材）
SP_REAL_E2E=1 node --test test/ui/real.e2e.test.js               # 真实对局（需要已下载的素材）
RENDER_E2E=1 node --test 'test/render/*.browser.test.js'         # 渲染
SIM_E2E=1 node --test 'test/sim/*.browser.test.js'               # 浏览器里的战斗模拟
```

**黄金结果**（[test/golden/README.md](test/golden/README.md)）：只重构、不改玩法的提交不能改变
`test/golden/*.json`；有意改变玩法时运行 `npm run golden:update`，把新文件和改动放在同一个提交里，并在提交说明里写清
哪些场景变了、为什么。

**另一条不跟着 `npm run ci` 跑的闸门**：`node .github/pack-compat.mjs` 把**工坊站线上在跑的包**喂给本仓自己的校验器，
回答「引擎抬版本之后，玩家手上的包还装不装得上」。工作流 `.github/workflows/pack-compat.yml` 只在**这个工具自己变了**
或人工触发时跑它（一轮要从站上拉 60+ MB 存档）。退出码 0 = 我方的包没有新增不兼容，1 = 有，2 = 清单取不到
（**取不到绝不报绿**）。默认站点是本仓自己的工坊站，脚本对站只做 GET，不需要凭据。

## 3. 忠实原则

这是官方玩法的复刻，规则以官方为准：

- **出处**：官方数据表（`.cache/gamedata/excel/`：character_table、skill_table、uniequip_table / battle_equip_table、
  activity_table 的 act2autochess、enemy_database、关卡文件）和 [PRTS](https://prts.wiki/)（干员页、技能和天赋的「备注」、
  卫戍协议相关页面）。数值尽量取 blackboard，不要凭记忆写数字。官方实测的截图或录像也很有价值，请附在 Issue / PR 里。
- **查不到出处**的细节按最简单、最接近官方的方式实现，在代码注释和 PR 描述里标 `[ASSUMED]`。维护者拍板的写成
  “the owner's decision of YYYY-MM-DD”。有意和官方不同的规则只能由维护者决定，并写进设计文档（[docs/DESIGN.md](docs/DESIGN.md)
  是索引：现行规则在 `docs/design/`，各版本的修订与依据在 `docs/history/`）。
- **版权**：不要把技能描述、剧情等受版权保护的文本大段复制进代码、文档或 PR，引一小句并注明出处即可。不要提交任何游戏
  素材文件（`public/assets/` 已被 `.gitignore` 排除）。
- **数据**：不要手改 `data/*.json`。改 `tools/build-data.mjs`，用 `node tools/build-data.mjs --offline` 重新生成，再比较
  JSON，确认只变了想改的部分。

## 4. 提交与 PR

- 一个 PR 只做一件事；干员的 kit 一个 PR 只放一名，便于审阅。
- 提交信息一行写清改了什么（中文或英文都可以），相关的 Issue 写上编号，例如 `余 S2 casts with an enemy on its x-1 (#32)`。
  只写改动本身，不加 `Co-Authored-By:`、`Generated with …` 这类署名尾行（维护者的约定）。合并的 PR 会在 CHANGELOG
  里写明并致谢作者。
- PR 描述写：改了什么、为什么、出处（数据表字段、PRTS 链接）、`[ASSUMED]` 的地方、跑了哪些测试、黄金结果里哪些场景变了。
  界面改动附截图。
- 规则改了，相关文档一起改：`docs/design/` 里对应的规则（章节号与文件见 docs/DESIGN.md 的索引）、`docs/history/` 里当前版本的
  修订记录、docs/SIM.md、docs/META.md、docs/DATA.md 等。
  `test/docs-consistency.test.js` 固定了文档里的一些句子，改文档后跑一下。
- **节号写我们的号**：`docs/DESIGN.md` 是唯一的索引。我们这边插入了 §28 / §29，所以从那里起节号比上游**大 2**
  —— 上游 `§N` 是我们的 `§(N+2)`（上游 §32 插件系统 = 我们的 §34，上游 §33 官方特效 = 我们的 §35）。
  `node --test test/docs-paths.test.js` 守这一条：引用的 `DESIGN §N` 必须是真标题，且同一个标题号
  （`N` / `N.M` / `N.M.K`）不许出现两次。
- 代码和注释用英文；玩家文档（README、PLAYING、DEPLOY）用简体中文，技术文档用英文。界面上的文字写中文并用 `t('…')`
  包起来，英文放进 `public/i18n/en.json`（[docs/I18N.md](docs/I18N.md)）。
- 翻译成新的语言：一个语言就是 `public/i18n/` 里的一个文件，不用改代码。`node tools/i18n.mjs template <语言代码>` 生成骨架，
  翻译后用 `node tools/i18n.mjs check <语言代码>` 检查，步骤见 [docs/I18N.md](docs/I18N.md)「Adding a language」；语言包是
  内容包的第一种，格式见 [docs/PACKS.md](docs/PACKS.md)。
- 提交的代码以 GPL-3.0-or-later 发布。本项目坚持非商业，请不要加入广告、付费、打赏等任何变现功能。

## 5. 添加干员（自选编队）

自选编队里的每名 6★ 干员都需要一个自己的战斗文件（kit），写法见
[server/sim/content/kits/README.md](server/sim/content/kits/README.md) 的「How to add an operator (自选)」。简要步骤：

1. 数据已经生成好：`data/backups.json` 的 `units[charId]`（各形态的数值、技能、天赋、模组）和 `tokens`（召唤物）。
   先对照官方数据表和 PRTS 核对。
2. 新建 `server/sim/content/kits/ops/op-<codename>.js`（codename 是 charId 去掉 `char_<n>_`），默认导出只有一个键：charId。
3. 把文件名加进 `server/sim/content/kits/index.js` 的 `OPERATOR_KIT_FILES`，这名干员就能在自选编队里选了。
4. 写测试 `test/content/op_<codename>.test.js`（照 `test/content/op_siege.test.js` 的写法：每个形态、每个模组、每个技能），
   跑 `node --test test/content/kits_layout.test.js`，再 `npm run golden:update`（只应新增 `test/golden/diy.json` 的场景）。
5. PR 里逐项勾选 README 里的「Fidelity checklist」。

自选池里的每一名干员都已经有 kit —— 没有 kit 文件的干员不会被列为自选（`server/sim/content/kits/index.js` 的
`OPERATOR_KIT_FILES`，现在 72 条）；改进现有的 kit 也按同样的清单来。相关讨论见 GitHub issue #136。

## 6. 打包与分发

- **服务器轻量发行**：`node tools/package-server.mjs` 打出「只要游戏运行时与 Mod API、不带本机美术、不带内置内容包」的
  服务器包。`--dry-run` 先看清单，`--list` 列文件，`--out <目录>` 指定输出。部署与运维读
  [docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md)。
- **完整整合包**：`npm run package`（`tools/package.mjs`）。
- **包格式与兼容审计**：[docs/WORKSHOP.md](docs/WORKSHOP.md) 是工坊包格式的规则；
  [docs/ENGINE-COMPAT-STARDUST-AUDIT.md](docs/ENGINE-COMPAT-STARDUST-AUDIT.md) 是 Forge / Stardust 的兼容审计。
  插件另有一套入口：[docs/PLUGINS.md](docs/PLUGINS.md) 与 [plugins/AGENTS.md](plugins/AGENTS.md)。

---

## English summary

- **Setup**: Node.js 22 or 24 (CI runs the matrix on ubuntu and windows). Clone
  `https://github.com/XiaMo233M/Stronghold-Protocol-Forge.git` — this repository; the upstream original is
  [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol), and pull requests sent upstream are
  logged in [docs/UPSTREAM-PR-LEDGER.md](docs/UPSTREAM-PR-LEDGER.md). Then `npm install`, `npm run setup` (art and
  audio — optional for tests: most suites skip without them, a few strict ones fail hard, see the section above),
  `npm run dev`. The code map is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Parallel worktrees**: a new `git worktree` carries only tracked files. Link the four git-ignored locations from an
  existing checkout — the vendored libraries under `public/vendor`, the downloaded art under `public/assets`, the
  generated fonts, and `data/local-assets.json` (Windows `mklink /J`, `mklink /H`; `ln -s` elsewhere) — or two suites
  fail for reasons that are not product bugs: `test/editor.test.js:596` gets a 404 for `/data/local-assets.json`, and
  `test/modAssets.test.js:341` fails its `haveBgm && haveFont` assertion. Linking the four makes those two go away.
- **Tests**: run the targeted files (`node --test <file>`, `--test-name-pattern`), then `node --test` and
  `npm run golden` before a pull request; `npm run lint`, `npm run check:imports`, `npm run typecheck`.
  `npm run ci` (or `node tools/ci.mjs`) runs the steps of `.github/workflows/ci.yml` in order — `setup`, `test`,
  `smoke`, `lint`, `imports`, `typecheck` — and stops at the first failure (`--keep-going`, `--only <steps>`, `--list`);
  it does not run `npm ci`, and it does not run the OS × Node matrix. Browser suites are opt-in: `SP_E2E=1`,
  `SP_REAL_E2E=1` (needs downloaded art), `RENDER_E2E=1`, `SIM_E2E=1` (a local Chrome, `CHROME_PATH`). A refactor never
  changes `test/golden/*.json`; an intended gameplay change runs `npm run golden:update` and commits the digests with the
  change, naming the scenarios that moved. Separate from `npm run ci`: `node .github/pack-compat.mjs` feeds the packs
  live on the workshop site to this repository's own validator — "do the packs players already have still install?" The
  workflow `.github/workflows/pack-compat.yml` runs it when the tool itself changes or on a manual dispatch, and exit
  code 2 (the catalogue could not be fetched) is never green.
- **Fidelity**: the official tables (`.cache/gamedata/excel/`) and PRTS (including the 备注 notes) are the sources;
  numbers come from the blackboards. Anything no source settles is marked `[ASSUMED]` in the code and the pull
  request; owner decisions are cited with their date; deliberate deviations are the owner's call and go into the design
  document (docs/DESIGN.md is its index: the rules in `docs/design/`, the per-release revisions in `docs/history/`).
  Do not paste copyrighted game text at length (quote briefly, cite) and never commit game assets.
  Never hand-edit `data/*.json`: change `tools/build-data.mjs`, rebuild with `--offline`, compare the JSON.
- **Commits and pull requests**: one change per pull request, one operator per kit pull request. A one-line commit
  message saying what changed, with the issue number; no attribution trailers such as `Co-Authored-By:` or
  `Generated with …` (the maintainers' convention) — merged pull requests are credited in the CHANGELOG. Describe the
  sources, the `[ASSUMED]` items, the tests and the golden scenarios that moved; update the docs a rule change makes
  wrong. Section numbers are **ours**: `docs/DESIGN.md` is the only index, and from the inserted §28 / §29 our numbering
  runs two ahead of upstream, so upstream `§N` is our `§(N+2)` (upstream §32 = our §34, upstream §33 = our §35).
  `node --test test/docs-paths.test.js` requires every `DESIGN §N` citation to be a real heading, and every heading
  number to be unique. Code and comments in English; player-facing text in Chinese through `t('…')` with the English in
  `public/i18n/en.json`. A new language is one file in `public/i18n/` and no code: `node tools/i18n.mjs template <code>`,
  translate, `node tools/i18n.mjs check <code>` (docs/I18N.md "Adding a language"; packs in general: docs/PACKS.md).
  Code is GPL-3.0-or-later; no monetisation features.
- **Adding an operator (自选)**: follow "How to add an operator (自选)" in
  [server/sim/content/kits/README.md](server/sim/content/kits/README.md): `op-<codename>.js` keyed by the charId,
  registered in `OPERATOR_KIT_FILES`, a test `test/content/op_<codename>.test.js`, the fidelity checklist in the pull
  request. Every operator of the 自选 pool already has a kit — an operator without a kit file is never offered as a pick
  (`OPERATOR_KIT_FILES` in `server/sim/content/kits/index.js`, 72 entries today); improvements follow the same checklist
  (GitHub issue #136).
- **Packaging**: `node tools/package-server.mjs` builds the server-only distribution — the game runtime and the Mod API,
  without local art and without bundled content packs (`--dry-run`, `--list`, `--out <dir>`; guide:
  [docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md)); `npm run package` builds the full bundle. Workshop pack format:
  [docs/WORKSHOP.md](docs/WORKSHOP.md). The plugin system has its own entry points
  ([docs/PLUGINS.md](docs/PLUGINS.md), [plugins/AGENTS.md](plugins/AGENTS.md)).
