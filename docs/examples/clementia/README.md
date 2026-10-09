# clementia（端到端夹具）
社区 mod「克莱门莎」（`E:\destop\clementia-mod`，就地补丁型）的 payload 按**工坊包**格式写了一遍，
用作「新增一个干员」这条 A 层通道的端到端夹具（`test/workshopOperators.test.js`）。

- 来源：`data/unit.json`（干员记录）、`data/diy-operator.json`（自选池声明）、`data/assets-char.json`
  （头像 / 立绘 / spine 路径）、`data/assets-skills.json`（3 张技能图标）、`data/assets-prof.json`（分支图标
  `primguard`）、`data/assets-voice.json`（双语语音，这里每种语种只留 4 个槽位）。
- **不含素材文件**（9 MB 的美术与 70 个 mp3），也**不含它的 kit**：叠加层不看文件在不在，而包 kit 的 import
  权利不在 2026-10-09 这一轮（`_up/pack-operator-channel.md` §6）。所以这个包不声明 `kits/`。
- 干员 id 仍是她的 `char_4231_clemnt`；`forms` 里补了 `2/60/7/3` 一档（她的原始 payload 只有
  `2/1/4/0` 与 `2/60/7/1`，缺自选槽精锐记录要的那一档 → 加载器以 `OPERATOR_FORM_MISSING` 整条拒掉）。
- 字段逐字来自她的 payload；本目录是**例子**，不是发布物（`tools/package.mjs` 只收 `git ls-files` 里的东西）。
