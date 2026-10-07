# Typecheck

`npm run typecheck` runs `tsc --noEmit --checkJs -p jsconfig.json`.

The first slice is the closed set that already typechecks:

- `shared/` except `shared/protocol.js` and `shared/bandBonds.js` (their JSDoc does not match the code yet; see below)
- `server/sim/rng.js`, `server/sim/dir.js`, `server/sim/constants.js` (the last imports `GEO` from shared)
- `types/` — JSDoc for `Unit`, `DamageInfo`, the snapshot tuples, and the protocol message envelope

`strict` is off. `tsc` does not read `jsconfig.json` on its own; the script passes `-p`.

## Widen it

Add one file or one folder to `jsconfig.json` `include`, then run `npm run typecheck`. Fix JSDoc that disagrees with the code in that folder. Leave `strict` off until the folder reports nothing. Do not add `@ts-nocheck`.

Suggested order once the sim split settles: `server/sim/grid.js`, `server/sim/body.js`, `server/sim/buffs.js`, then `server/sim/damage.js` against the typedefs in `types/core.js`. The sim does not import `types/`. The typedefs are a reference, not a runtime dependency.

`types/core.js` follows docs/DESIGN.md §5.2, §5.4, §8 and docs/SIM.md §4, §9. Where those two disagree on `DamageInfo.type`, the typedef uses the union `makeDamageInfo` actually builds (`'elemental'` as well as `'element'`).

## Not in the first slice

`shared/protocol.js` — the catalogue JSDoc is ahead of a few object literals (`$optional` sits on a `Record` of checkers; `unitStatsEntry` does not list `side` or `silenced`, and the code reads `side`). Fix the comments, then remove it from `exclude`.

`shared/bandBonds.js` — the data-shape JSDoc rejects an empty fallback object and a tuple callback. Same treatment.

### Forge 新增到 `shared/` 的 8 个文件（0.7.0 起）

`shared/zip.js`、`shared/workshop.js`、`shared/chessAuthoring.js`、`shared/support.js`、`shared/enemyAuthoring.js`、`shared/statReference.js`、`shared/stageAuthoring.js`、`shared/waveAuthoring.js`
—— 它们放在上游那份 `shared/**` 里，于是被 `include` 扫到，但从来不属于「已经能过 `tsc` 的封闭集合」。
一起扫会报 107 条，全是这一批：`Buffer` / `process` 没有 node 类型（`types: []`），加上几个函数返回
`{ ok: false }` 之类的联合字面量被推断宽了。与玩法无关，所以先按文件名排除，等切片按上面的规矩扩到它们时再逐个修。
（校验方式：把这几行从 `exclude` 里删掉，`npm run typecheck` 应报出这 107 条。）
