#!/usr/bin/env node
// .github/overlay-check.mjs —— 叠加层的机器闸门（读 .github/overlay.json，人和 CI 都只信它）。
//
//   node .github/overlay-check.mjs --work <master树> --up <上游树>
//
// 三件事，退出码各不相同，别混：
//   1 = 自有文件丢了 / 我方**补丁锚点**丢了（同步把我的修复弄没了 —— 最危险的静默故障）
//   2 = 上游**已收到**同一个修复 ⇒ 触发退役流程（这是好事，不是坏在合并）
//   3 = 用法/清单错（清单读不到、目录不存在）⇒ 绝不报绿
//
// 与工坊站那条线（`sync-upstream-mods`）同一套判据形状，但那边管的是「挂载点」（在上游文件体内插入的代码），
// 这边管的是「补丁」：管理器线相对上游只改了 `tools/workshop-validate.mjs` 一个文件的两处收尾，
// 其余全是新增文件 —— 所以 `patches` 用「锚点存在 + 上游那份是否还有我要绕的形态」两条来判。
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] || d) : d; };
const work = arg('--work'), up = arg('--up');
if (!work || !up) { console.error('usage: node .github/overlay-check.mjs --work <dir> --up <dir>'); process.exit(3); }
const ovPath = path.join(work, '.github/overlay.json');
if (!fs.existsSync(ovPath) || !fs.existsSync(up)) { console.error('::error::清单或目录不存在，不判绿'); process.exit(3); }
let ov;
try { ov = JSON.parse(fs.readFileSync(ovPath, 'utf8')); } catch (e) { console.error(`::error::清单不是合法 JSON：${e.message}`); process.exit(3); }
const read = (root, p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };

let lost = 0, retired = 0;
for (const f of ov.mine ?? []) {
  if (!fs.existsSync(path.join(work, f))) { console.log(`✗ 自有文件缺失：${f}`); lost++; }
}
for (const p of ov.patches ?? []) {
  const w = read(work, p.file), u = read(up, p.file);
  if (w === null) { console.log(`✗ 补丁宿主文件不存在：${p.file}`); lost++; continue; }
  for (const a of p.anchors ?? []) {
    if (!w.includes(a)) { console.log(`✗ 补丁锚点丢了：${p.file} 里找不到 ${JSON.stringify(a.slice(0, 48))}（原因：${p.why}）`); lost++; }
  }
  if (u === null) { console.log(`⚑ 上游没有 ${p.file} 这个文件了 —— 它被改名/删除，我方补丁无处可贴，人工复核`); retired++; continue; }
  const mineUpstream = (p.anchors ?? []).some((a) => u.includes(a));
  const problemGone = p.problemPattern ? !u.includes(p.problemPattern) : false;
  if (mineUpstream) { console.log(`⚑ 上游已收到同一个修复（${p.file} 里已有我方锚点）⇒ 按 retireWhen 删掉这一条 patches`); retired++; }
  else if (problemGone) { console.log(`⚑ 上游已不再用我要绕的形态（${p.file} 里 ${JSON.stringify(p.problemPattern.slice(0, 40))} 已消失）⇒ 复核这一条 patches 是否还需要`); retired++; }
}
const total = (ov.mine?.length ?? 0) + (ov.patches ?? []).reduce((n, p) => n + 1 + (p.anchors?.length ?? 0), 0);
console.log(`叠加层检查：条目 ${total} 项（自有文件 ${ov.mine?.length ?? 0} / 补丁 ${ov.patches?.length ?? 0}）| 丢失 ${lost} | 可退役 ${retired}`);
if (lost) { console.error(`::error::${lost} 处自有文件/补丁锚点丢失 —— 同步不放行`); process.exit(1); }
if (retired) { console.error(`::notice::${retired} 处上游已实现 → 该减叠加层了（合并本身是好的）`); process.exit(2); }
console.log('✓ 叠加层完整，且上游还没有收到我们这些修复');
