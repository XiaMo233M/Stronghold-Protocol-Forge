# 行为层示例包（kit-demo）

这个包演示**工坊的行为层**：一个包的 JavaScript 如何接入战斗引擎的钩子总线。

```
kit-demo/
  pack.json                       包声明（content 只列数据文件）
  chess.json                      干员数据（由 docs/examples/operator-spec.json 推导）
  kits/chess_ws_abyss_hunter_a.js 行为层：kit 函数
```

试用：

```powershell
Copy-Item -Recurse docs\examples\kit-demo workshop\kit-demo
node tools/workshop-validate.mjs workshop\kit-demo    # 会报告 kits/ 是否加载成功
npm start                                            # 重启游戏服务器
```

## 这个例子说明了什么

1. **文件名就是干员 id**：`kits/chess_ws_abyss_hunter_a.js` 只作用于 `chess_ws_abyss_hunter_a`。
2. **kit 一旦返回，技能就归它管** —— 返回 kit 却不给 `skill`，这名干员就**没有技能**。示例里显式给出了等价的 `skill`。
3. **本示例不 import 任何东西**：同一份文件服务端按真实路径加载、浏览器按 URL 加载，**向上**走的相对 import
   不可能同时对。要 import 就用 `@kit/…` / `@sim/…`（引擎的 SDK 与纯函数模块），或 `./…` 开头的**本包**相对路径
   （`./lib/bonds.js` 这种，用来把一份大文件拆成几个文件）—— 见 `docs/WORKSHOP.md` §4.5 / §4.6。
4. **它会在玩家浏览器里执行**，服务端再用同一份文件复算——所以不要有环境依赖。

细节与完整契约见 [docs/WORKSHOP.md](../../WORKSHOP.md) 的 §4。
