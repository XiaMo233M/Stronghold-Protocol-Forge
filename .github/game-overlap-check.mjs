#!/usr/bin/env node
// .github/game-overlap-check.mjs —— 「与卫戍协议本体不冲突」这条性质的机器闸门。
//
//   node .github/game-overlap-check.mjs --work <master树> --up <上游树>
//        [--game-repo sganggs/Stronghold-Protocol --game-ref master]
//
// 判的是什么：我方相对上游（维护方 Forge）的**增量文件清单**，与游戏本体仓 `sganggs` 的文件清单，
// 两者**路径交集必须为 0**。交集非空 = 我改了本体也有的那个路径 ⇒ 维护方下次吃 sganggs 时
// 一定会撞我，或者更糟：我那一份静默覆盖上游的行为。实测 2026-10-14：交集 = 0
// （我唯一改的上游文件 `tools/workshop-validate.mjs` 在本体仓里根本不存在这个路径）。
//
// 退出码：
//   0 = 交集为 0（结构性不冲突成立）
//   1 = 有交集 ⇒ **拦下同步**，要把东西挪到管理器命名空间或改走适配层
//   3 = 判不了（目录缺失 / 本体清单取不到）⇒ 出 ::warning:: 不拦（那是可用性问题，不是我的代码撞了），
//       但绝不印「✓ 不冲突」。
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] || d) : d; };
const work = arg('--work'), up = arg('--up');
const GAME = arg('--game-repo', 'sganggs/Stronghold-Protocol');
const REF = arg('--game-ref', 'master');
if (!work || !up) { console.error('usage: node .github/game-overlap-check.mjs --work <dir> --up <dir> [--game-repo o/r] [--game-ref master]'); process.exit(3); }
if (!fs.existsSync(work) || !fs.existsSync(up)) { console.log('::warning::目录读不到，无法判交集（不报绿）'); process.exit(3); }

// 递归列两边（这个脚本跑在 Actions 的 worktree 上，没有 .git 也能算）
const walk = (root, rel = '', out = new Set()) => {
  const abs = path.join(root, rel);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === '.git' || e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.add(r);
  }
  return out;
};
const same = (a, b) => {
  try { const x = fs.readFileSync(a), y = fs.readFileSync(b); return x.length === y.length && x.equals(y); } catch { return false; }
};

const mine = walk(work), ups = walk(up);
const delta = [...mine].filter((p) => !ups.has(p) || !same(path.join(work, p), path.join(up, p)));
console.log(`我方增量（相对维护方 Forge）= ${delta.length} 个文件`);

let game;
try {
  const r = await fetch(`https://api.github.com/repos/${GAME}/git/trees/${REF}?recursive=1`, {
    headers: {
      'user-agent': 'forge-overlay-check',
      ...(process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  game = new Set((await r.json()).tree.filter((t) => t.type === 'blob').map((t) => t.path));
} catch (e) {
  console.log(`::warning::取不到 ${GAME}@${REF} 的清单（${e.message}）—— 本次**不判**「不冲突」，但也不拦合并`);
  process.exit(3);
}
console.log(`游戏本体 ${GAME}@${REF} = ${game.size} 个条目`);

const hit = delta.filter((p) => game.has(p));
if (hit.length) {
  for (const p of hit.slice(0, 20)) console.log(`✗ 本体仓也有这个路径：${p}`);
  console.error(`::error::我方增量与卫戍协议本体有 ${hit.length} 处路径交集 —— 同步不放行：挪到管理器命名空间（shared/、server/ 下另起文件）或改走适配层`);
  process.exit(1);
}
console.log(`✓ 路径交集 0 / ${delta.length} —— 维护方吃 sganggs 时结构上撞不到我的代码`);
