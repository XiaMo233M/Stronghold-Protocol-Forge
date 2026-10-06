# third-party —— 不属于本项目 GPL 覆盖范围的内容

这个文件夹是**边界**：它划出「哪些东西不是我们写的、也不能由我们授权」。

- **代码**（`server/` `shared/` `public/js` `editor/` `tools/` `test/` …）是 **GPL-3.0-or-later**，见 [LICENSE](../LICENSE)。
- **这里的内容**是《明日方舟》的美术、音频、字体，以及**由官方数据表生成的数据** —— 版权归
  鹰角网络（Hypergryph）及其授权方（Yostar 等）。它们**不适用** GPL，本项目也无权向任何人授予权利。
  完整条款见 [NOTICE.md](../NOTICE.md) §2、§3。

把两者分开的好处很实际：**下架只需要删一个文件夹**，代码侧的许可故事也保持干净 ——
`third-party/` 之外的一切都可以放心按 GPL 分发。

## 这里放什么

| 内容 | 来源 | 为什么不在这里提交 |
|---|---|---|
| `public/assets/**` | `tools/fetch-assets.mjs` 下载，或 `tools/local-extract/extract.py` 从本机客户端提取 | 约 270 MB，且版权不属于本项目 |
| `public/fonts/**` | 同上 | 字体归各作者 |
| `data/*.json` | `tools/build-data.mjs` 从官方数据表生成 | 内容是官方数据（游戏运行时需要它，但**不要**当成我们的作品） |
| `docs/research/**`、`docs/img/**`、`public/dev/recordings/**`、`test/fixtures/official-*.json` | 调研记录、截图、开发录像、测试夹具 | 含官方数据或游戏画面 |

## 怎么把它单独发布

`tools/export-third-party.mjs` 把这四类内容**收集**成一份可独立上传的包（它只读，不改动原树）：

```powershell
node tools/export-third-party.mjs --dry-run        # 先看会导出什么、多大
node tools/export-third-party.mjs                 # → third-party/bundle/
node tools/export-third-party.mjs --copy           # 默认用硬链接省磁盘；跨盘或想要真副本时用 --copy
node tools/export-third-party.mjs --out D:\sp-bundle --json
```

产出 `third-party/bundle/`：保持原有相对路径 + `NOTICE.md`（第三方声明）+ `MANIFEST.json`
（每个文件的字节数与 sha256）。把这个文件夹**单独**打成一个压缩包或单独建一个仓库上传即可。

`third-party/bundle/` 已在 [.gitignore](../.gitignore) 里排除 —— 它是一次性产物，不该进主仓库。

## 玩家怎么自己得到这些内容

不需要向任何人索取：

```powershell
npm run setup                 # 下载公开镜像上的素材（约 270 MB，可中断续传）
node tools/build-data.mjs     # 从官方数据表生成 data/*.json（离线可用）
node tools/setup.mjs --local  # 可选：从本机的《明日方舟》客户端提取官方 3D 棋盘等
```

没有这些内容游戏照样能跑：会退回 2D 棋盘、样式相近的图标与替代外观
（见 [docs/DEPLOY.md](../docs/DEPLOY.md) §6 的回落清单）。
