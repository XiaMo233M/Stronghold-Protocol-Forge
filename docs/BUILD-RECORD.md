# 发布流程与构建记录

本文件是**「怎么打、怎么发、踩过哪些坑」的累积知识**，不是某一次发版的流水账：
前四节是可复用的流程与判据，第五节按版本积累实例。

> ⚠️ 本文提到的「仓外工作目录」指发版时用来放打包树与产物的那个目录（例如 `_up/pkg-0191/`），
> 它**不进仓库**（避免污染 `git status`）。本文只记录相对路径与命令。

---

## 1. 发版八步

每一步都带约束；顺序本身是有原因的（第 6 步的 `update` 依赖第 6 步的 bundle）。

### ① 清 `%TEMP%`（可选，磁盘紧张时）
只清**自己造的**：`wp1b-test-*` · `sp-p3a-*` · `sp-forge-*` · `sp-tp-*` · `sp-test-*` ·
`sp-plugin-test-*` · `sp-errors-*`。
⛔ **绝不碰**：`sp-live-*`（评审证据：`decision.json` / `meta.json` / `mod.zip` / `orig.zip`）·
`nsx9746.tmp` · `puppeteer_dev_chrome_profile-*` · `cdp-net-public-*`。
⚠️ **先列清单报批，再删**；只删匹配项本身、不递归删父目录、不碰仓内。

### ② 全量测试 + golden
```powershell
node --test --test-concurrency=4 --test-reporter=spec
node tools/golden.mjs --jobs 4
```
⚠️ `--test-reporter=spec` 才有 `ℹ tests/pass/fail` 汇总行（默认 TAP 没有）。
⚠️ 报告分三栏：**已修 / 仍红（标明是已知项还是非已知）/ 环境红（ENOSPC 等）**。
⚠️ **有"非已知项"的红 ⇒ 停下，不发版。**
⛔ **绝不用 `golden:update`** —— 发版前基线必须是原样。

### ③ 推 `main`
⚠️ 先试直连；失败改走代理 `http://127.0.0.1:10808`。
⚠️ 用**一次性** `-c http.proxy=…`，⛔ **绝不写 `git config`**。
⚠️ 只推 `main`；⛔ 不用 `--force` / `--tags` / `--follow-tags` / `--mirror`。

### ④ 打 annotated tag 并**显式**推
```powershell
git tag -a v<APP_VERSION>-<UPSTREAM_VERSION> -m "<说明>"
git push origin v<APP_VERSION>-<UPSTREAM_VERSION>     # ⛔ 不用 --tags
```
核两项：
```powershell
git ls-remote --tags origin 'v<ver>'        # tag 对象 SHA
git ls-remote --tags origin 'v<ver>^{}'     # ⭐ peeled 到的 commit（必须等于当前 HEAD）
```
⚠️ 裸 tag 名返回的是 **tag 对象**的 SHA，带 `^{}` 才是它指向的 commit。
⚠️ 先确认上一版的 tag 也是 annotated（`git cat-file -t v<旧ver>` → `tag`），保持形态一致。

### ⑤ 发 release（REST）
`POST https://api.github.com/repos/<owner>/<repo>/releases`
```json
{ "tag_name": "v<ver>", "name": "<标题>", "body": "<正文>", "draft": false, "prerelease": false }
```
⚠️ `draft` / `prerelease` 都必须是 `false`。
⚠️ 正文**程序读取文件逐字贴**（不手抄），贴完核 API 返回的 `bodyLength` 与本地字符数一致。
⚠️ 发之前可先发一个 `GET /repos/<owner>/<repo>` 验证 token 有效且有 `push` 权限 ——
   避免"token 有问题但已经动了写操作"。

### ⑥ 打包四个资产：src → voices → win-x64 → update
⚠️ **`update` 必须在 `win-x64` 之后** —— 它读 bundle 目录。
⚠️ 每个打完报：大小 / 耗时 / sha256 / 磁盘前后（`C:` / `E:` / `%TEMP%`）。

### ⑦ 上传（流式）
`POST https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=<文件名>`
⚠️ ⭐ **端点是 `uploads.github.com`，不是 `api.github.com`**（见 §3 坑 1）。
⚠️ `Content-Type: application/zip`；大文件必须**流式**（不能整个读进内存）。
⚠️ 每个上传完核返回的 `digest`（`sha256:…`）与本地 sha256 **逐字一致**；任一失败停下。
⚠️ 顺序：小的先传（失败时损失小）。

### ⑧ 收尾核验
```powershell
GET /releases/<id>   →  assets 数 = 4 · draft=false · prerelease=false · bodyLength 一致
```

---

## 2. 四个资产各自怎么产

### `…-src.zip`（源码整包）
```powershell
git archive --format=zip -o <out>\…-src.zip HEAD
```
⭐ **不要加 `--prefix`**：加了用户解压后会多一层目录。
⚠️ 判据：`file entries` 应等于 `git ls-files` 的数量；`.rej` 条目数与仓库一致
（`.rej` 是「还没实现的部分」的索引，**有意保留**）。

### `…-voices-<langs>.zip`（多语言配音）
```powershell
node scripts/make-voice-pack.mjs --out <out>\…-voices-cn-en-kr.zip --langs=cn,en,kr
```
⚠️ 脚本默认打「除默认配音外的全部」；默认配音 = `data/assets.json` 的 `audio.voiceLang`（`jp`）。
⛔ 不带 `--include-default`（若上一版也没带 jp）。
⚠️ 判据：解压后各语言文件数应与 `public/assets/audio/voice/<lang>/` 逐一对上。

### `…-win-x64.zip`（Windows 便携包）
```powershell
node scripts/make-windows-bundle.mjs --out <out>\bundle --release <ver> --all-dubs
# 压缩前把目录名改成发行名（同卷 Rename-Item = 元数据操作，零拷贝），让 zip 顶层目录正确：
Rename-Item <out>\bundle '<发行名>'
cd <out>; tar -a -cf '<发行名>.zip' '<发行名>'
Rename-Item '<发行名>' 'bundle'      # zip 校验通过后再改回
```
⚠️ ⭐ **`--all-dubs` 必须给**：默认只打默认配音（`jp`），四语必须显式（见 §3 坑 6）。
⚠️ 需要 `--force` 才能覆盖上一次的打包目录（脚本只肯删空目录或上一次的便携包）。
⚠️ Windows 自带 `tar` 是 **bsdtar（libarchive）**，`tar -a -cf x.zip` 能直接写 zip（见 §3 坑 5）。
⚠️ 判据：`file entries` 等于 bundle 树的文件数；`node\node.exe --version` 与上一版一致；
`app\package.json` 的 `release` 等于 `<ver>`；`local/fx` / `local/scene` / `local/mesh` 的计数与上一版一致。

### `…-update.zip`（增量更新包）
```powershell
node scripts/make-update-package.mjs --bundle <out>\bundle --from <上一版完整包或目录> --out <out>\…-update.zip
```
⚠️ ⭐ **`--from` 是「上一版的完整发行包」（目录或 zip），不是版本号**（见 §3 坑 2）。
⚠️ 判据：`app/UPDATE.json` 的 `from` 写着上一版的发行标识；`file` 条目数应远小于整包
（只含变化文件）；上界是"不能接近整包大小"。

---

## 3. 踩过的坑

### 坑 1：上传资产的端点不是 `api.github.com`
- **症状**：`POST https://api.github.com/repos/…/releases/<id>/assets` 返回 **404 Not Found**，
  看起来像 release 不存在。
- **根因**：GitHub 把资产上传放在**另一个域名**。
- **正解**：用 release 的 `upload_url` 字段：`https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets{?name,label}`。
- **附注**：404 时**什么都没传上去**，可安全重试。

### 坑 2：`make-update-package` 的 `--from` 不是版本号
- **症状**：给 `--from v0.19.0-0.3.0` 会 `statSync` 失败。
- **根因**：它要读**旧包本身**来算差异（从 `app/package.json` 学 version/release，
  从 `app/MANIFEST.json` 取指纹）。
- **正解**：给上一版**完整发行 zip 或它解压出来的目录**。读 zip 时它会用
  `name.slice(slash + 1)` 砍掉唯一顶层目录名（因此要求所有条目在同一顶层文件夹下）。

### 坑 3：一个版本目录里可能有多棵打包树 —— 先确认哪一棵是发布的
- **症状**：拿上一版的打包树当基准，得到的文件数与已发布 zip 差几千，误判成 bug。
- **根因**：上一版可能打过多次（先漏素材、再补齐），目录里留着多个候选
  （例：`bundle` / `bundle-fx` / `bundle-scene`）。
- **正解**：把**已发布的 zip** 的 entry 清单与各候选树**双向比对**，
  `zip-only = 0` 且 `tree-only = 0` 的那一棵才是发布树。**拿错基准会把正常差异误判成缺陷。**

### 坑 4：`SKIP_TRACKED = ['test/']` ⇒ `test-data/` 会进包
- **症状**：包里的文件数比预期多出若干，且多出来的在 `test-data/` 下。
- **根因**：打包只略过 `test/`，`test-data/` 不在名单里。
- **正解**：这不是缺陷，是预期行为。基准对齐时把这段差额算进去。

### 坑 5：Windows 自带的 `tar` 是 bsdtar，不是 GNU tar
- **要点**：**bsdtar 能直接写 zip**（`tar -a -cf x.zip <dir>`）；**GNU tar 不能**。
- **附注**：bsdtar 会显式写目录 entry（`…/`），因此 zip 会比"不写目录 entry 的工具"大一点
  （实测约 +0.4 MB / 2400 个目录）。**解压后文件完全一致**，用户无感。

### 坑 6：`make-windows-bundle` 默认只打默认配音
- **症状**：包里的 `public/assets/audio/voice/` 只有一个语言目录（`jp`）。
- **根因**：默认只带 `data/assets.json` 的 `audio.voiceLang`（`jp`），其余走单独的配音包。
- **正解**：要四语必须显式 `--all-dubs`。

### 坑 7：`src.zip` 加 `--prefix` 会让用户解压后多一层目录
- **症状**：解压出来的结构与上一版不同（多一层 `<name>/`）。
- **根因**：`git archive --prefix=<x>/` 会给每个条目加前缀。
- **正解**：**不加 `--prefix`**。核法：读已发布 zip 的**前几个 entry 名**，
  若首个是 `.dockerignore` 这类文件名（而不是目录），说明那一版无前缀。

### 坑 8：设置项「读了但没存」⇒ 功能静默不存在
- **症状**：某个设置项在设置页里**看不见**；或看得见但**不生效**；或相关面板/数字**永远不出现**。
- **根因**：运行时（渲染侧、`screens/*.js`、`diag.js`）早就在读某个键 `s?.X === true`，
  而**设置侧的四样**（`DEFAULT_SETTINGS` 键 / `sanitizeSettings` 归一 / 设置页的控件 / i18n 文案）
  **一项都没落地**。那个键因此永远不存在 ⇒ 读到的恒为 `undefined` / `false` ⇒ 该功能静默不存在。
  ⚠️ 这类缺口**没有报错、没有红测试**，只有"这个功能好像没有"的主观印象。
- **三个实例**（本项目都出现过，都已补落）：
  · `mysticEnergy`（秘术师能量）—— 渲染侧与 HUD 读它，设置侧四样全缺
  · `officialFx`（官方特效）—— 读写链路缺赋值，控件动了不生效
  · `combatMetrics`（作战统计）—— `screens/game.js` 读 `useSettings().combatMetrics === true`，
    键不存在 ⇒ 面板永远不显示
- **排查法**：⭐ 怀疑某个设置不生效时，**先核渲染侧有没有 `s?.X === true` 这类读法，
  再核 `DEFAULT_SETTINGS` 有没有 X** —— 两者对不上就是这里。
- **已加的门禁**：`test/ui/settings-keys.test.js` 守「`updateSettings({ X: … })` 写入的 X
  必须在 `DEFAULT_SETTINGS` 里」，防"加了 Toggle 却忘了加键"。
  ⚠️ **它抓不住「连控件都没有」的那种**（上面三个实例补落前的状态）——
  那一半只能靠审 `*.rej` 与上面那条排查法。⚠️ **别以为"有测试了就不会再犯"。**

### 坑 9：两条打包路径对 `test/` 的处理不一致（⚠️ **记档，不是已修**）
- **事实**：
  · **npm 发行包**（`tools/package.mjs` 的 `isPlayerFile`）**收** `test/helpers/battleHarness.js`
    ——设计意图写在 `tools/package.mjs` 的 `AUTHOR_TEST_FILES` 注释里：
    「the author-facing test harness that **ships with the player package**（**the only test file a release carries**）」。
    `Dockerfile` / `.dockerignore` 也都按这个路径放行它。
  · **Windows 便携包**（`scripts/make-windows-bundle.mjs` 的 `SKIP_TRACKED = ['test/']`）**整目录跳过** `test/`
    ——连 `battleHarness.js` 一起跳掉。
- **⚠️ 一个反证**（说明便携包那条可能是故意的）：0.19.0 的构建日志写「略过 **1037** 个 test/ 文件」，
  若 `battleHarness.js` 该带，数字应是「1036 个 test/ + 1 个豁免」。
- **状态**：⚠️ **两条并存，本版未修。** 哪条是对的属**产品裁决**（"便携包该不该带作者工具"）。
- **提示**：`test/plugin-package.test.js` 那条走的是 `plan()`（npm 发行包路径），**不覆盖便携包**
  ——所以这一致性问题没有任何测试盯着。

### 坑 10：`core.autocrlf=true` 让测试读到的行尾与 git 里不同（⚠️ **第二次踩**）
- **症状**：断言某几行"在文件里"，逐条打印却发现确实在 ⇒ 但 `includes()` 全 false。
- **根因**：`core.autocrlf=true` 的 Windows 检出把 git 里的 **LF** 变成工作区的 **CRLF**。
  测试若 `readFileSync(...).split('\n')`，切出来的每行末尾带 `\r`，
  于是 `lines.includes('node_modules')` 实际比的是 `'node_modules\r'` ⇒ false。
  ⚠️ **git 里一切正常**（`git show` 看不到 `\r`，`git status` 也干净）—— **只有测试读工作区时才暴露**。
- **两次实例**：
  · ① `docs/design/mod-layer.md` 被写成 CRLF ⇒ `test/docs-paths.test.js` 红
  · ② `.dockerignore` 检出即 CRLF ⇒ `test/plugin-package.test.js` 的 14 条规则**全部 MISS**（本版才修）
- **修法**：读仓库文件时用 `split(/\r?\n/)`。
  ⚠️ **切法兼容两种行尾，断言的规则仍逐条精确比较 —— 这不是放宽判据。**
  反向验证：把 `.dockerignore` 里的 `node_modules` 删掉 ⇒ 断言照样红。
- **⚠️ 还剩两处已知风险**（当前绿，但**靠断言形态的侥幸，不是设计**）：
  · `test/docs-paths.test.js:223` —— `split('\n')[0]` 取首行，`\r` 落在 `\b` 之后仍成立
  · `test/promptCitations.test.js:48` —— 按行取引用，只用到行内部分字段
  ⇒ ⭐ **若将来把 `\r` 纳入比较（例如改成整行相等），这两处会突然红。**
  ⇒ 全仓 `.split('\n')` 共 76 处，只有这 2 处读**仓库文件**（其余读运行时产物或源码 banner，行尾不受影响），
    故**本版不改它们**（没有红，改了属无依据的预防性改动）。

---

## 4. 实测基线

发版时的数字（下一次发版可拿它对照；⚠️ 数字会随版本变，**别当成断言**）：

| 项 | 0.19.1-0.3.0 时的值 |
|---|---|
| 全量 `node --test` | 10169 tests · 10146 pass · **6 fail** · 17 skipped |
| 其中 6 条 fail 的构成 | 5 条发布面（`plugin-package` ×3 · `plugins/registry` · `update-package`）+ 1 条时序型 flaky（`plugins-content:372`） |
| `golden --jobs 4` | 六族全 match（roster 49 · bonds 46 · fields 22 · matches 21 · standins 10 · diy 140）· 未用 `golden:update` |
| `node tools/i18n.mjs check --all --strict` | 四语各 2101 / 2101（100 %）· 0 missing · 0 errors |
| 内容集身份 `cs` | 随 `APP_VERSION` 变（`0.19.0` → `aefa6e90…`，`0.19.1` → `d8050e8b…`） |
| `settings-keys` 门禁 | 绿（20 个写入点 / 17 个唯一键 / `DEFAULT_SETTINGS` 17 个键 —— 两边键集合相等） |

⚠️ **`cs` 的诚实局限**：只核到 identity 那条链
（`server/plugins/identity.js` 的 `computeVanillaContent` → `shared/plugins/identity.js` 的 `contentHashInput`，
其中含 `app: String(app)`），**未做全仓验证「抬版本是否影响持久化数据」**。
换版后 `cs` 会变、首次全部重算，与 `CACHE_NAME` 同一思路，属设计而非缺陷。

⚠️ **i18n 的计数口径**：`i18n.mjs` 统计的是**代码里用 `t()` 实际引用的条目**，
不是语言包文件里的键总数。因此某个条目「在包里存在但代码没引用」时**不计入**该总数。

---

## 5. 版本记录

### 0.19.1-0.3.0（2026-10-17 首次记录）

> 本节由 0.19.1 发版时的构建记录整理而来。

| 项 | 值 |
|---|---|
| `APP_VERSION` / `UPSTREAM_VERSION` | `0.19.1` / `0.3.0` |
| `PROTOCOL_VERSION` / `MOD_API_VERSION` | `2` / `1`（均未动） |
| commit | `b19da9c8ed4f2b282eef8809f05fbec05ee5b014` |
| tag | `v0.19.1-0.3.0`（annotated，tag 对象 `fec100bfacc5262511ab2655504d67f70f2412e3`） |
| release id | `415756078` · 非 draft · 非 prerelease |
| release 正文长度 | 5,591 字符（与本地正文源逐字一致） |

四个资产（全部已上传，`digest` 与本地 sha256 逐字一致）：

| 资产 | 大小 (B) | sha256 |
|---|---|---|
| `…-src.zip` | 24,740,114 | `050c700ae829ba862467227ece549c9bb3a3a632a8491488b69af07933f45993` |
| `…-update.zip` | 1,123,850 | `1b5bf4bd942e9d4e5e3f1b4eee8cf8c7656a94cb1a25d0e70c6b60364caa4c5a` |
| `…-voices-cn-en-kr.zip` | 212,041,380 | `2b64b3a84ead1494b5502dd66bd18ac1245c3490f48a8d72ef5f1706f0e30aa7` |
| `…-win-x64.zip` | 875,148,618 | `dba8762482210a434b930817330b6605bf188136cd24d6349395c8fb36bb5523` |

三个数字差异（都不是缺陷）：

1. **`update.zip` 只有 1.07 MB**（0.19.0 是 114.8 MB）——
   0.19.0 那次是 `bundle`（漏素材）→ `bundle-scene`（补齐），要带 12534 个 `local/fx` 文件；
   本次两版**素材几乎无变化**（`local/fx` 12534 / `scene` 137 / `mesh` 15 全部相同，四语配音也都在），
   只带 49 个变化文件。核过 `app/UPDATE.json` 的 `from` 写作 `0.19.0-0.3.0`。
2. **`win-x64.zip` 比 0.19.0 多 2447 个目录 entry（+0.41 MB）** —— 见 §3 坑 5；解压后文件一致。
   `file entries = 37669`，比 0.19.0 的 37652 多 17 = `test-data/forge` 那 17 个。
3. **`src.zip` 里是全部 82 个 `.rej`** —— 与 0.19.0 一致，有意保留（「还没实现的部分」的索引）。
   `file entries = 2293`，与 0.19.0 相同。
