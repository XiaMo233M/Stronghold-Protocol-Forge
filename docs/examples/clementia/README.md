# clementia（端到端夹具）
社区 mod「克莱门莎」（`E:\destop\clementia-mod`，就地补丁型）的 payload 按**工坊包**格式写了一遍，
用作「新增一个干员」这条 A 层通道的端到端夹具（`test/workshopOperators.test.js`）。

- 来源：`data/unit.json`（干员记录）、`data/diy-operator.json`（自选池声明）、`data/assets-char.json`
  （头像 / 立绘 / spine 路径）、`data/assets-skills.json`（3 张技能图标）、`data/assets-prof.json`（分支图标
  `primguard`）、`data/assets-voice.json`（双语语音，这里每种语种只留 4 个槽位）。
- **不含素材文件**（9 MB 的美术与 70 个 mp3），也**不含它的 kit**：叠加层不看文件在不在，而包 kit 的 import
  权利不在 2026-10-09 这一轮（`_up/pack-operator-channel.md` §6）。所以这个包不声明 `kits/`。
- `forms` 里补了 `2/60/7/3` 一档（她的原始 payload 只有 `2/1/4/0` 与 `2/60/7/1`，缺自选槽精锐记录要的那一档
  → 加载器以 `OPERATOR_FORM_MISSING` 整条拒掉）。
- 字段逐字来自她的 payload；本目录是**例子**，不是发布物（`tools/package.mjs` 只收 `git ls-files` 里的东西）。

## 为什么干员 id 是 `char_ws_clemnt` 而不是 `char_4231_clemnt`

**因为上游 0.2.3 把克莱门莎收成了官方干员**，官方 id 正是 `char_4231_clemnt`
（`data/backups.json` 的 `diy.ownedPool` 由 71 变 72，官方自选池里多了她；上游同时带了自己的
`server/sim/content/kits/ops/op-clemnt.js`）。

它变成官方之后，这个夹具再用那个 id 就会被加载器按 `OFFICIAL_ID_COLLISION` 拒掉 —— 而夹具要验的是
「**包新增一个干员**」这条通道，不是「撞官方 id」。所以 id 换成**工坊保留前缀** `char_ws_*`
（与本测试里其它虚构干员 `char_ws_new` / `char_ws_tie` / `char_ws_tmp` 同一约定；官方 id 用数字，
这个前缀不会与上游将来发布的干员相撞）。**载荷与字段一个字节没改**，只有 id 与它引用的路径段跟着换。

想覆盖一名**官方**干员时，走的是另一条路：在 `pack.json` 里声明 `overrides`（如
`"units:char_4231_clemnt"`），见 `docs/WORKSHOP.md` 的 `overrides` 一节与 `test/packOverrides.test.js`。
