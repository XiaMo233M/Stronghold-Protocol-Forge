# 错误信息白话化对照

**这份文件是「错误码 → 人话」的对照表。** 它落在文档层，**本轮没有改动引擎代码里的任何用户可见字符串** ——
那是另一件事，要另裁。

**方法**：下面每一条的「现在报什么」都是**实测原文**，不是从文档里抄的。
来源是 `_up/workshop-ux/_verify-l1-output.txt`（跑 `node _up/workshop-ux/verify-l1.mjs` 得到，
走引擎自己的装载器 `server/workshop.js` 的 `loadWorkshop()`）。

> **总纲**：现在的文案**技术上全对，但全在回答「引擎为什么不收」，没有一句在回答「我该改哪个字」。**
> 小白看到 `EMPTY_PACK` 的第一反应不是「我要补一个内容声明」，是「什么叫贡献项」。

---

## 一、会拒包的码（这几条必须改，否则包装不上）

每一条给四段：**现在报什么（原文）· 小白会怎么想 · 改成什么（一句话人话）· 修法（一步一条）**。

### 1. `ASSETS_NEED_LICENSE` —— 有图就必须写授权

| | |
|---|---|
| **现在报什么** | `ASSETS_NEED_LICENSE: this pack has an assets/ folder, so pack.json must declare a license (e.g. "CC0-1.0", "CC-BY-4.0", or "see assets/LICENSE.txt")` |
| **在哪** | `Stronghold-Protocol/shared/workshop.js:1861-1863` |
| **小白会怎么想** | 「我没有要卖钱啊，为什么管我要 license？而且 license 是什么、写在哪、写什么？」英文句子会在第一眼就劝退一部分人 |
| **改成什么** | **「你的包里有图片。请在 `pack.json` 里加一行告诉别人这张图能不能转发：`"license": "CC-BY-4.0"`（保留你的署名即可）或 `"CC0-1.0"`（随便用）。」** |
| **修法** | ① 打开 `pack.json`<br>② 在 `"author"` 那一行下面加一行 `"license": "CC-BY-4.0"`<br>③ 重跑校验 |

### 2. `PACK_ID_MISMATCH` —— 文件夹名和 id 不一样

| | |
|---|---|
| **现在报什么** | `PACK_ID_MISMATCH: pack.json id "some-other-id" does not match its directory "my-first-pack"` |
| **在哪** | `Stronghold-Protocol/shared/workshop.js:1830-1831` |
| **小白会怎么想** | 「id 是哪个？目录名叫什么我改过啊？」—— 它说了两边不一样，但**没说改哪边** |
| **改成什么** | **「文件夹名和 `pack.json` 里的 `"id"` 必须是同一个词，现在一个是 `my-first-pack`、一个是 `some-other-id`。挑一个：把文件夹改名成 `some-other-id`，或者把 `pack.json` 里的 `"id"` 改成 `my-first-pack`。」** |
| **修法** | ① 看错误里那两个词<br>② 决定以哪个为准<br>③ 把另一个改成一致 |

### 3. `PACK_UNKNOWN_FIELD` —— 多写了一个字段

| | |
|---|---|
| **现在报什么** | `PACK_UNKNOWN_FIELD: pack.json: "type" is not a field of this pack format (id, name, version, author, license, description, gameVersion, game, api, layer, combat, content, overrides, voices, voiceLangs, bondIcons, itemIcons, art, skins, support, operators, i18n, forms, fx, notices, playtest, variants, behaviour, assets, client, server, routes, target, dependencies, conflicts). A key this loader does not know is never read: write it as one of the fields above, or drop it — a declaration that is ignored is worse than a refusal` |
| **在哪** | `Stronghold-Protocol/shared/workshop.js:1825-1826` |
| **小白会怎么想** | 「35 个合法字段一次性全砸过来，我怎么知道 `type` 该换成哪个？」后半句「a declaration that is ignored is worse than a refusal」是**纯设计哲学**，对用户零信息量 |
| **改成什么** | **「`pack.json` 里不能有 `"type"` 这个字段。包的类型不用你写 —— 引擎会看你声明了什么自己判断。把这一行删掉就行。」** |
| **修法** | ① 删掉报出来那个字段所在的一行<br>② 如果那个字段其实是想表达别的意思，按下面的高频对照换：`type` → 删掉；`app` → `client` / `server`；`authors` → `author`；`englishName` → `name`；`target` → `api` + `game`；`capabilities` → 具体声明<br>③ 重跑校验 |

> 只有引擎**认不出**的键才需要拉那张 35 个字段的长清单；已经反复出现的高频错键应当单独给一句。

### 4. `BAD_API_TYPE` —— `api` 写成了数字

| | |
|---|---|
| **现在报什么** | `BAD_API_TYPE: "api" must be a string (a version range such as ">=1 <2" or "1.x"), got number — a non-string declaration would be read as "not declared"` |
| **在哪** | `Stronghold-Protocol/shared/workshop.js:2420` |
| **小白会怎么想** | 「什么是 version range？`>=1 <2` 中间那个空格是什么？」 |
| **改成什么** | **「`"api"` 后面必须加引号。写 `"api": ">=1 <2"`，不要写 `"api": 1`。」** |
| **修法** | ① 找到 `"api"` 那一行<br>② 给值两边加上双引号，照抄 `">=1 <2"`<br>③ 重跑校验 |

### 5. `EMPTY_PACK` —— 这个包什么都没带

| | |
|---|---|
| **现在报什么** | `EMPTY_PACK: content must name at least one of: chess, units, items, enemies, stages, waves, tokens, bosses, factions, garrisons, bands, bonds, effects, choices — or the pack must declare voices / voiceLangs / bondIcons / itemIcons / art / skins / operators / assets / client / server.preDispatch / server.meta / server.battle / server.room / server.modules / server.transport / routes / i18n / notices / forms / fx (note: "support" is NOT a contribution — a pack that declares it alone brings nothing into a match)` |
| **在哪** | `Stronghold-Protocol/shared/workshop.js:2396` |
| **小白会怎么想** | 这是**全文档最难读的一条**。33 个候选名、混合大小写与点号、还带一段 `NOT a contribution` 的辩解。小白读不完，也不知道自己「想干的那件事」对应哪个词 |
| **改成什么** | **「这个包什么都没带，装上去不会有任何变化，所以引擎不收。它至少要带一样东西。你想做什么？换素材（立绘 / 图标 / 语音）→ 用 `art`；改数据（干员 / 装备）→ 用 `content`；加界面 → 用 `client`；发公告 → 用 `notices`。另外：只写 `support` 不算 —— 那只是说「谁能进助战池」，不是内容本身。」** |
| **修法** | ① 想清你这个包到底要带来什么<br>② 按上面的对照挑一个字段补上<br>③ 如果做的是「换立绘」这类素材包，用 `art` 并**同时**建 `assets/` 文件夹（见第 1 条与第 6 条）<br>④ 重跑校验 |

### 6. `ART_NEEDS_ASSETS` —— 有 `art` 但没有 `assets/` 文件夹

| | |
|---|---|
| **现在报什么** | `ART_NEEDS_ASSETS: a pack that declares art must put the files in its assets/ folder (e.g. assets/art/…)` |
| **在哪** | `Stronghold-Protocol/shared/workshop.js:2065-2081`（`parseArtDecl`：① 形状 → ② **表名闭集** → ③ 这一条） |
| **先看这一条** | **表名写错时先报的是 `ART_UNKNOWN_TABLE`，不是这一条**（2026-10-13 把表名闭集挪到这条之前）：`art` 只认 `chars` / `enemies` / `tokens` / `skills` / `profSub` / `bonds` / `bands` —— 写 `art.audio` / `art.weapons` / 单数 `art.bond` 的包，**哪怕也没有 `assets/`**，先得到的是「这张表不存在」。音频不走 `art`：它走 `voices` / `voiceLangs`（`docs/WORKSHOP.md` §1.4）。 |
| **小白会怎么想** | 「我放了文件啊？」—— 问题多半是文件夹**名字**或**位置**，而这句话只重复了一遍要求，没告诉他「引擎到底在找什么路径」 |
| **改成什么** | **「引擎在包目录下找 `assets` 这个文件夹（全小写，和 `pack.json` 同一层），没找到。请新建一个名为 `assets` 的文件夹，把图片放进去。」** |
| **修法** | ① 打开包文件夹<br>② 在 `pack.json` 旁边新建文件夹，名字**全小写**：`assets`<br>③ 把图片放进这个文件夹<br>④ 重跑校验 |

### 7. `content` 声明了但文件不在 —— **这条不是拒绝码，但同样致命**

| | |
|---|---|
| **现在报什么** | `[my-first-pack] chess.json is declared in pack.json but missing` |
| **在哪** | `Stronghold-Protocol/server/workshop.js:159` |
| **小白会怎么想** | 「我知道不在啊，我要问的是怎么办。」**没有错误码、没有前缀、格式和其它错误不一样** —— 在一堆 `CODE: reason` 里夹着一句裸英文，看不出严重度 |
| **改成什么** | **「`pack.json` 的 `"content"` 里写了 `chess`，但包里没有 `chess.json`。要么把那个文件放进来，要么把 `"content"` 里的 `chess` 删掉。」** |
| **修法** | ① 看错误里点名的文件名<br>② 要么把那个文件放进包文件夹，要么从 `"content"` 里删掉这个名字<br>③ 重跑校验 |

> ⚠️ **实测发现的一条不对称**：这个错误报出来之后，**包还是被判为「装上了」**（`packs=1 errors=1`）。
> 也就是「有一条错误」和「这个包没装上」是两件事。对小白来说这就是「校验说有错，但游戏里包在，那我到底要不要改」。
> ⇒ 建议在入口处把这两种状态分开显示（❌ 没装上 / ⚠️ 装上了但有 N 处问题）。

---

## 二、站点侧的三档检查

上传站把投稿分成三档（`site/review.mjs` 的 `F(level, code, text)`）：

| 档 | 现在的表现 | 谁看得见 | 判定 |
|---|---|---|---|
| `blocker` | 红条，`BLOCKER GAME_ASSET — …` | **只有维护者在审核台看见** | 有 blocker 就不能直接上线 |
| `warn` | 黄条 | 同上 | 看一眼 |
| `info` | 灰条 | 同上 | 记录 |

**问题不在文案，在「谁看得见」。** 投稿人在上传页面上看到的是 `LEVEL — CODE — text`，
例如 `BLOCKER EXECUTABLE — 含可执行 / 脚本文件 3 个…`。

### 逐条改成给投稿人看的话

| 码（`site/review.mjs`） | 现在报什么（原文） | 小白会怎么想 | 改成什么 |
|---|---|---|---|
| `GAME_ASSET`（`:69`） | `Spine 骨骼文件（.skel）—— 官方模型解包的典型产物 —— 命中 3 条，例如 a.skel、b.skel` | 「要把我打回了？」（其实**照收**，只要标注） | **「检测到游戏解包的素材。这**不影响收录** —— 但请在备注里写明「含官方素材」，并注明版权归鹰角网络、仅供非商业使用。」** |
| `EXECUTABLE`（`:87`） | `含可执行 / 脚本文件 3 个，例如 a.exe、b.dll —— mod 不该带这些` | 半懂 | **「包里带了 .exe / .dll / .bat 这类程序文件。工坊包不需要这些，请删掉再传。」** |
| `PATH_TRAVERSAL`（`:93`） | `条目名里有 .. 或绝对路径 2 条…解压时会写到包外` | 完全不懂 | **「zip 里有文件名带 `..` 或盘符（`C:\`）。这会让解压跑到别的文件夹去，请重压一次。」** |
| `WRAPPED`（`:110`） | `所有文件都在同一个顶层目录「xxx/」下 —— 装包器要的是包内文件放在 zip 根，请重新压一次（不要套一层文件夹）` | 这句**是对的、可照做**（本批里最好的一条） | 保留，只把「装包器」换成「上传」：**「zip 里套了一层文件夹。请把 `pack.json` 这一类文件直接放在 zip 最外层，不要套文件夹。」** |
| `NO_PACK_JSON`（`:101`） | `没有 pack.json —— 像是原件（未兼容），按 incoming/ 那条路处理` | 「incoming 是什么？」 | **「这个 zip 里没有 `pack.json`，所以它不是做好的工坊包。没关系 —— 我们照收，由维护者帮你改写成包。」** |
| `SIZE`（`:59`） | `12 个文件 · 解压后约 3.40 MB` | 懂 | 保留 |
| `NAME_EMPTY`（`:37`） | `名称为空` | 懂 | 保留 |
| `NAME_IMPERSONATE`（`:43`） | `名称含「官方 / official / 鹰角 / Yostar」这类词 —— 容易让人误以为是官方出品` | 懂 | 保留 |
| `NAME_ANGLE`（`:42`） | `名称里有尖括号（显示时会转义，但最好去掉）` | 懂 | 保留 |

> **三档本身是对的**（三档的判据干净、单一）。要改的是**呈现**：
> ① 上传页现在把 `blocker` / `warn` / `info` 用同一个渲染函数渲染成同一种条 —— **三档在视觉上没区别**；
> ② 三档的文案里混着「给维护者的话」（`按 incoming/ 那条路处理`）和「给投稿人的话」；
> ③ **没有一句话告诉投稿人「接下来会发生什么」**。

---

## 三、统一的改法（一条规则管住全部）

引擎里一共有约 150 个具名的拒绝 / 报警码，其中大部分是给包作者与维护者看的。
小白最常撞上的是上面第一节那 7 条。它们的共同毛病是：

1. **报的是「引擎的判据」，不是「你的动作」**（`must declare a license` 而不是 `加一行 "license": "CC-BY-4.0"`）；
2. **用英文写**，而整个产品是中文的；
3. **一句话里塞进设计理由**（`a declaration that is ignored is worse than a refusal`）；
4. **不说是哪个文件的哪一行**（`PACK_ID_MISMATCH` 说了两个值，但没给方位）。

**统一规则**：

> 每条错误信息都按 **「哪里 → 现在是什么 → 改成什么」** 三段写。
> 第一段给文件与字段名；第二段贴现在读到的值；第三段给一句**可以直接照抄**的替换文本。
> 设计理由一律**从错误信息里搬走**，放进文档。

⚠️ **本条是「该怎么改」的建议，不是已经改好的事实。** 本轮只在文档层落地，
引擎代码里的用户可见字符串**一字未动**。
