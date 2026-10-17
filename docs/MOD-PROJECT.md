# Mod 项目格式与打包（MOD-PROJECT）

这一份回答三件事：**你写 mod 的时候目录长什么样**、**发出去的东西长什么样**、**装上之后引擎看到的又是什么样**。
三者刻意分开——它们本来就不是同一个形状，混在一起是绝大多数"我明明写对了却装不上"的来源。

> 相关的既有文档：[`WORKSHOP.md`](WORKSHOP.md)（包能做什么 / 不能做什么）、
> [`STANDARD-PACK.md`](STANDARD-PACK.md)（站点如何给提交定级）、
> [`MOD-SURFACE.md`](MOD-SURFACE.md)（每个生效面的闭枚举）。

---

## 1. 三种形态

### 1.1 项目形态（你写东西的地方）

```text
my-first-pack/                 ← 目录名随意，**不必**等于 id
├── pack.json                  ← 必须有，必须在根
├── chess.json                 ← 你声明的内容（文件名在 pack.json 里点名）
├── kits/
│   └── chess_ws_mine_a.js     ← 行为层，按干员键查
├── assets/                    ← 素材（声明了 assets 才需要）
│   └── portrait.png
└── README.md                  ← 随包发出（会长进包哈希，见 §4）
```

**`pack.json` 必须显式写 `id`。** 安装形态里 id 取自目录名，但项目目录叫什么都行
（`my-first-pack`、`我的第一个包`…），拿目录名当 id 会得到一个既不可预测也不合法的身份。
所以打包工具会先要求它：

```json
{
  "id": "my-first-pack",
  "name": "我的第一个包",
  "version": "1.0.0",
  "author": "你的名字",
  "license": "CC-BY-4.0",
  "gameVersion": "0.3.0",
  "content": ["chess"],
  "overrides": []
}
```

`id` 的合法形态：字母/数字开头，只含字母、数字、`_`、`-`，≤32 字符
（`shared/workshop.js:112 PACK_ID_RE`）。

### 1.2 交付形态（发给别人的东西）

**一个 zip**，两种布局都收：

```text
my-first-pack.zip
├── pack.json          ← 推荐：清单在 zip 根
├── chess.json
└── kits/…

# 也接受（很多站点的"打包下载"就是这个形状）
my-first-pack.zip
└── my-first-pack/     ← 唯一一个顶层目录
    ├── pack.json
    └── chess.json
```

**不接受**：多个顶层目录都带 `pack.json`（无法判断哪个是包）、`pack.json` 既不在根也不在唯一顶层目录里、
zip 里套 zip。判定实现只有一份：`tools/workshop-pack.mjs` 的 `manifestPrefix`，安装与校验共用。

### 1.3 安装形态（引擎读的东西）

```text
workshop/
└── my-first-pack/     ← 目录名 == pack.json 的 id（引擎就是这么取 id 的）
    ├── pack.json
    └── chess.json
```

`server/workshop.js` 的 `loadWorkshop` 只扫**目录**（跳过 `.` 开头的），每个目录必须有 `pack.json`，
id 取自目录名。所以安装时工具会把 zip 解开到 `<id>/`——这也是为什么交付 zip 里的 `id` 和目录名必须能对上。

---

## 2. 打包

```bash
# 打出 dist/<id>.zip（确定性：同一份输入 ⇒ 同一个字节序列 ⇒ 同一个 sha256）
node tools/mod-pack.mjs pack ./my-first-pack

# 指定输出位置
node tools/mod-pack.mjs pack ./my-first-pack -o ./release/my-first-pack.zip

# 机器可读（含 sha256，方便贴到发布帖里让别人核对）
node tools/mod-pack.mjs pack ./my-first-pack --json
```

打包前会跑**加载器同一个校验函数**（`shared/workshop.js` 的 `normalizePackManifest`）：
这里给绿，装进去就一定绿；这里给红，说明装进去也会被整包丢掉。另有一道"声明了内容却没给文件"的检查
（那种包能装上、但加载时会被丢掉，属于最难查的一类）。

### 不会被打进包里的东西

| 排除项 | 为什么 |
|---|---|
| `.git/` | 工作树元数据，进去会让同一份内容每次得到不同字节 |
| `node_modules/` | 与 mod 无关，体积会直接撞上 64 MiB 上限 |
| `dist/<id>.zip`（以及 `-o` 指定的那个文件） | 否则第二次打包会把第一次的产物装进新包，包会自指且逐次膨胀 |

**除此之外没有排除项。** `README.md`、`*.bak`、测试文件——只要你放在项目目录里，它们都会进包，
并且**参与包哈希**（见 §4）。要它们不进包，就别放在项目目录里。

---

## 3. 校验别人发来的 zip（不安装）

```bash
node tools/mod-pack.mjs check ./some-mod.zip
```

它在**内存里**读归档并校验清单，不落盘、不安装。适合"先看看这个包能不能装，再决定要不要放进 mod 目录"。

`shared/zip.js` 的读侧已经把这些全判过一遍并具名拒绝：
路径穿越（`../`、`/abs`、`C:/`、`a\b`）、重名条目、ZIP64、加密、多卷、CRC 不符、超出上限。

| 上限 | 数值 | 常量 |
|---|---|---|
| 条目数 | 4096 | `ZIP_MAX_ENTRIES` |
| 解开后总量 | 64 MiB | `ZIP_MAX_TOTAL_BYTES` |
| 单条目解开后 | 32 MiB | `ZIP_MAX_FILE_BYTES` |
| 单条目名长度 | 255 字节 | `ZIP_MAX_NAME_BYTES` |

（真值只在 `shared/zip.js:24-30`；本文不另写一套数字。）

---

## 4. 包身份（为什么"改个 README"等于"换了一个包"）

包哈希 = 对下面这些内容的 `[路径, sha256]` 排序后再哈希（`server/workshop.js identifyPack`）：

1. `pack.json` 的**归一化**形态（键排序、去 undefined，`shared/modIdentity.js canonicalJson`）；
2. 每个声明的内容表文件（`chess.json` 等）的归一化记录；
3. **包目录下的每一个普通文件**（`server/packFiles.js listPackFiles`，刻意没有按名字/目录的排除项）；
4. 声明过的客户端面板、服务端模块、meta/battle/room 模块的源码；
5. 资源容器的 sha256、i18n 译文、notices 文件的字节。

推算出来的后果，作者需要知道：

* 改一个字节的 `README.md` ⇒ 包哈希变了 ⇒ 联机时**所有客户端**都要重新拉一次这个包。
  把"人看的说明"放在项目目录里是可以的，但每次改它都会改变包的联机身份。
* 同一份内容、不同的换行（CRLF/LF）⇒ 不同的哈希。本项目统一 LF。
* 打包是确定性的（条目排序 + 固定时间戳），所以**同一棵树**打两次得到同一个 sha256，可以拿去对账。

---

## 5. 安装与启用是两件事

把 zip 放进 mod 目录（或 `.mod-inbox/`）只会完成**安装**。带服务端代码的包
（`pack.json.server` 的 `modules` / `battle` / `meta` / `room`）装完会被登记为 **disabled**——
那些代码在游戏服务端进程里跑，所以"启用"必须是一次刻意的动作
（`server/modRegistry.js` 的语义是「不在登记册 = 启用」，安装器会显式写一条 `disabled`）。

启用之后还需要**重启游戏服务器**：装配是一次性的（`server/modHotReload.js` 的头部注释），
热装载默认只报告，不原地换包。

---

## 6. 常见拒绝与含义

| 拒绝 | 含义 |
|---|---|
| `BAD_PACK_ID` | 没写 `id`，或 id 含非法字符 |
| `PACK_UNKNOWN_FIELD` | `pack.json` 有闭集外的键（`PACK_FIELDS`，38 个） |
| `EMPTY_PACK` | 只声明了行为/元数据键，没有任何"贡献"（内容、素材、模块…） |
| `MOD_API_INCOMPATIBLE` | 声明了 `api` 但本引擎的 `MOD_API_VERSION` 不落在那个区间 |
| `归档里没有 pack.json` | zip 布局不对（见 §1.2） |
| `ZIP_BAD_NAME` / `ZIP_TOO_LARGE` / … | zip 本身不可信或超限（见 §3） |

完整的错误码白话表见 [`errors.md`](errors.md)。
