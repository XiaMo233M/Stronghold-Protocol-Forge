#!/usr/bin/env node
// .github/game-overlap-check.mjs —— 「与卫戍协议本体不冲突」这条性质的机器闸门。
//
//   node .github/game-overlap-check.mjs --work <master树> --up <上游树>
//        [--game-repo sganggs/Stronghold-Protocol --game-ref master]
//
// 判的是什么：我方相对上游（维护方 Forge）的**增量文件清单**，与游戏本体仓 `sganggs` 的文件清单。
// 2026-10-15 起判据从「路径交集必须为 0」改成「**每一处交集都必须是登记过的受控例外**」—— 因为服主定的路线
// 是管理器由我方自行演进、不再向维护方/上游提 PR，能力越往引擎里走越不可能全部躲开本体路径。
// 放宽的**不是红线本身，而是它的证明方式**：越线要在 `.github/overlay.json` 的 `bodyPaths` 里逐格写
// `why` + 锚点，锚点当场找不到就拦同步（否则「登记」只是口头授权，下一次同步把我方插入体弄掉时没人知道）。
//
// 退出码：
//   0 = 无交集（结构性不冲突，更强的那条性质），或全部交集都是「已登记 + 锚点在位」的受控例外
//       —— 输出行会明说这不是零交集，**别按零交集对外表述**
//   1 = 有交集，且其中至少一格未登记 / 没锚点 / 锚点丢了 ⇒ **拦下同步**
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
if (!hit.length) {
  console.log(`✓ 路径交集 0 / ${delta.length} —— 维护方吃 sganggs 时结构上撞不到我的代码`);
  process.exit(0);
}

// 2026-10-15 起这条红线的语义变了（服主定：管理器由我方自行演进，不提上游 PR，以后还要大改）。
// 原来它是「交集必须为 0」；现在是「**每一处交集都必须是登记过的受控例外**」：
//   * 每一格必须在 `.github/overlay.json` 的 `bodyPaths` 里有一项，写清 `why`；
//   * 必须带**至少一条锚点**，而且锚点当场能在我们的树里找到 —— 否则「登记」只是一句口头授权，
//     下一次同步把我方插入体弄掉时没人知道（那正是本层最恨的静默故障）。
// 换句话说：越线不再是「不许」，而是「必须留证据」。但对外**不能再说「与本体零交集」**，只能说
// 「N 处受控例外，锚点在位」—— 这条口径由下面的输出行负责，别在 PR 里引用成 0。
let ov = { bodyPaths: [] };
try {
  ov = JSON.parse(fs.readFileSync(path.join(work, '.github/overlay.json'), 'utf8'));
} catch (e) {
  console.log(`::warning::读不到叠层清单（${e.message}）—— 有 ${hit.length} 处交集却无从核对登记，按未登记处理`);
}
const reg = new Map((ov.bodyPaths ?? []).map((b) => [b && b.file, b]));
const bad = [];
for (const p of hit) {
  const r = reg.get(p);
  if (!r) { bad.push(`${p}：未登记 —— 要越这条线就先进 overlay.json 的 bodyPaths 写清 why + 锚点`); continue; }
  const anchors = Array.isArray(r.anchors) ? r.anchors : [];
  if (!anchors.length) { bad.push(`${p}：登记了但一条锚点都没有 —— 受控例外必须可被机器核对`); continue; }
  const txt = fs.readFileSync(path.join(work, p), 'utf8');
  const missing = anchors.filter((a) => !txt.includes(a));
  if (missing.length) { bad.push(`${p}：${missing.length}/${anchors.length} 条锚点找不到 —— 我方插入体可能已被同步吃掉（逐条：${missing.map((m) => JSON.stringify(String(m).slice(0, 40))).join(', ')}）`); continue; }
  console.log(`⚑ 受控例外 ${p}（${anchors.length} 条锚点在位）${r.why ? ` —— ${String(r.why).slice(0, 100)}` : ''}`);
}
if (bad.length) {
  for (const b of bad) console.log(`✗ ${b}`);
  console.error(`::error::与本体有 ${hit.length} 处路径交集，其中 ${bad.length} 处不是「已登记且锚点在位」的受控例外 —— 同步不放行`);
  process.exit(1);
}
console.log(`✓ 本体路径交集 ${hit.length} 处，全部为已登记且锚点在位的受控例外（**这不是「零交集」，别按零交集对外表述**）`);
