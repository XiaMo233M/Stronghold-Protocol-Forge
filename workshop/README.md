# workshop/ — 创意工坊包目录

> **第一次做包的人请先看 [`../docs/START-HERE.md`](../docs/START-HERE.md)**（四步做一个包：复制模板 → 改三处 →
> 导出 → 上传）。里面第 1 步要复制的模板包就在 [`../docs/my-first-pack/`](../docs/my-first-pack)。
> 报错看不懂就查 [`../docs/errors.md`](../docs/errors.md)；想改立绘 / 加干员分别见
> [`../docs/task-01-换个立绘.md`](../docs/task-01-换个立绘.md) 与 [`../docs/task-02-加个干员.md`](../docs/task-02-加个干员.md)。
> 这一页讲的是**目录约定**，不是教程。

把工坊包放在这个目录下（一个包一个子目录），服务器启动时会自动加载：

```
workshop/
  my-pack/
    pack.json        # 必需：包的身份声明
    chess.json       # 内容文件，按 pack.json 的 content 列表
    items.json
    enemies.json
    stages.json
    waves.json
    ...
```

## 快速上手

```powershell
# 1. 复制示例包
Copy-Item -Recurse docs\examples\demo-workshop workshop\demo-workshop
# 2. 重启服务器
npm start
```

启动日志会出现一行 `[workshop] applied 1 pack(s): …`，游戏里就能招募到示例干员了。

## 规则要点

- **不改动 `data/*.json`**。工坊内容是在内存里叠加到官方数据之上的，官方数据永远保持原样，可以随时删掉这个目录回到纯净状态。
- **默认只增不改**。想替换一个官方 id（例如改数值），必须在 `pack.json` 的 `overrides` 里显式写出 `"chess:chess_char_1_01_a"`，否则这条记录会被拒绝并报告，官方记录保留。
- **一个包坏了不会拖垮服务器**：无法解析的包会被跳过并在日志里报告，其余内容照常加载。
- **这里只放数据**。行为层脚本（`kits/*.js`，接 `battle.on(...)` 钩子）尚未接入，见 [docs/WORKSHOP.md](../docs/WORKSHOP.md) 的「当前状态」。

完整格式与字段说明见 **[docs/WORKSHOP.md](../docs/WORKSHOP.md)**。

## 授权提醒

本仓库的代码是 GPL-3.0-or-later，但**《明日方舟》相关素材不在许可范围内**，版权归鹰角网络。请不要把素材文件提交进仓库或官方整合包；工坊包如需自带素材，请自行确认授权，并在 `pack.json` 的 `license` 字段里声明。
