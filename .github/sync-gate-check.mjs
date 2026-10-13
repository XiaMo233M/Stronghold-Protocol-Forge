#!/usr/bin/env node
// .github/sync-gate-check.mjs —— 同步门控的判定器（控制面文件，不属于引擎代码）。
//
//   node .github/sync-gate-check.mjs --tap <file.tap> --baseline <file.json>
//
// 三条判据，缺一条就红：
//   1. **跑了 0 条 = 红**。上游把某个测试文件改名/删掉时，`node --test` 照样退 0，
//      于是「什么都没跑」会被读成「全绿」—— 这正是旧 sync-upstream.yml 骗人的形态。
//   2. 失败**名称集合** ⊆ baseline.contract ⇒ 绿（那些红是维护方 main 自己就有的，见基线里的 capturedFrom）。
//   3. 出现任何**净新增**失败名 ⇒ 红，并点名是哪几条。
//
// 判净新增一律比名称集合，不比总数（总数会被上游新增/删除的用例数带着漂）。
import fs from 'node:fs';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const tapPath = arg('--tap');
const basePath = arg('--baseline');
if (!tapPath || !basePath) {
  console.error('usage: node .github/sync-gate-check.mjs --tap <tap> --baseline <json>');
  process.exit(2);
}

const tap = fs.readFileSync(tapPath, 'utf8').split(/\r?\n/);
const names = [];
for (const line of tap) {
  const m = /^(\s*)not ok \d+ - (.*)$/.exec(line);
  if (m) names.push(m[2].replace(/\s*\((?:[\d.]+)ms\)\s*$/, '').trim());
}
const passCount = tap.filter((l) => /^\s*ok \d+ - /.test(l)).length;
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const known = new Set((base.contract ?? []).map((s) => s.trim()));
const failed = [...new Set(names)].sort();
const fresh = failed.filter((n) => !known.has(n));
const tolerated = failed.filter((n) => known.has(n));
// 基线里那条红如果**不再**出现，说明维护方修好了 ⇒ 不红，但要说一声（否则基线会越攒越脏）
const healed = [...known].filter((n) => !failed.includes(n));

const lines = [
  '### 契约门控判定',
  `- TAP 通过 ${passCount} 条 / 失败 ${failed.length} 条（净新增 ${fresh.length}、已知红容忍 ${tolerated.length}）`,
  tolerated.length ? `- 已知红（维护方 main 自带，见基线 capturedFrom）：\n${tolerated.map((s) => '  - ' + s).join('\n')}` : '',
  healed.length ? `- 基线里的已知红这次**没再出现**（可能已被上游修好，可以从基线删掉）：\n${healed.map((s) => '  - ' + s).join('\n')}` : '',
  fresh.length ? `- ⚠ 净新增失败：\n${fresh.map((s) => '  - ' + s).join('\n')}` : '',
].filter(Boolean);
const dest = process.env.GITHUB_STEP_SUMMARY;
if (dest) { try { fs.appendFileSync(dest, lines.join('\n') + '\n'); } catch { /* 摘要写不进不该影响判定 */ } }
for (const l of lines) console.log(l);

if (passCount === 0 && failed.length === 0) {
  console.error('::error::门控一条测试都没跑到（测试文件被改名/删了？跑了 0 条不等于绿）');
  process.exit(1);
}
if (fresh.length) {
  console.error(`::error::契约面有 ${fresh.length} 条净新增失败 —— 同步不放行`);
  process.exit(1);
}
console.log('✓ 契约门控通过（无净新增失败）');
