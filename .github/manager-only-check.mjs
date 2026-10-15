#!/usr/bin/env node
// .github/manager-only-check.mjs —— 「我的 fork 分支必须只有 mod 管理器」这条令的机器闸门。
//
//   node .github/manager-only-check.mjs --work <master树> --up <上游树>
//
// 判的是**我方增量**：`master` 相对维护方 Forge 每一个不同的文件，都必须是这条令允许的东西 ——
// 控制面（CI / 门禁 / 打包 / 发布 / 叠层清单）+ 已登记的上游文件（`overlay.json` 的 `patches[].file`）
// + 明确列为自有的文件（`overlay.json` 的 `mine`）。出现白名单外的文件就红。
//
// 它与 `game-overlap-check.mjs` 是**两条不同的红线**，不要混：
//   * game-overlap 判「我改的路径，游戏本体 sganggs 是否也有」⇒ 将来维护方吃本体时会不会撞我；
//   * 这一格判「我改的东西是不是都还是 mod 管理器这一层的」⇒ 分支会不会悄悄长成一条带游戏 UI / 性能调优
//     附加的线（那是另一条产品线的东西，不该混进管理器发布物）。
// 两条都过才算「只有 mod 管理器」。
//
// 退出码：0 = 增量全部在允许范围内；1 = 有越界文件（拦同步）；3 = 判不了（目录/清单缺失，出 ::warning:: 不报绿）。
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] || d) : d; };
const work = arg('--work'), up = arg('--up');
if (!work || !up) { console.error('usage: node .github/manager-only-check.mjs --work <dir> --up <dir>'); process.exit(3); }
if (!fs.existsSync(work) || !fs.existsSync(up)) { console.log('::warning::目录读不到，无法判定（不报绿）'); process.exit(3); }

const ovPath = path.join(work, '.github/overlay.json');
if (!fs.existsSync(ovPath)) { console.log('::warning::叠层清单读不到，无法判定（不报绿）'); process.exit(3); }
let ov;
try { ov = JSON.parse(fs.readFileSync(ovPath, 'utf8')); } catch (e) { console.error(`::error::清单不是合法 JSON：${e.message}`); process.exit(3); }

const allow = new Set([...(ov.mine ?? []), ...(ov.patches ?? []).map((p) => p.file)]);
const CONTROL_PREFIXES = ['.github/'];

const walk = (root, rel = '', out = new Set()) => {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === '.git' || e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.add(r);
  }
  return out;
};
const same = (a, b) => { try { const x = fs.readFileSync(a), y = fs.readFileSync(b); return x.length === y.length && x.equals(y); } catch { return false; } };

const mine = walk(work), ups = walk(up);
const delta = [...mine].filter((p) => !ups.has(p) || !same(path.join(work, p), path.join(up, p)));
const outside = delta.filter((p) => !allow.has(p) && !CONTROL_PREFIXES.some((pre) => p.startsWith(pre)));

console.log(`我方增量 = ${delta.length} 个文件 | 允许范围 = ${allow.size} 条登记 + 控制面前缀 ${CONTROL_PREFIXES.join('/')}`);
if (outside.length) {
  for (const p of outside.slice(0, 40)) console.log(`✗ 增量里有不属于 mod 管理器这一层的文件：${p}`);
  console.error(`::error::${outside.length} 个越界文件 —— 「分支只有 mod 管理器」这条不成立，同步不放行`);
  process.exit(1);
}
console.log(`✓ 增量全部是控制面或已登记的叠层（${delta.length} 个文件，无一越界）`);
