// 一次性脚本：把上游 0.3.0 lock 里那 4 条 (ses + @endo/*) 并进我们的 package-lock.json。
// 保我们的 version（0.18.6）；不做任何依赖解析，只补条目，随后由 `npm install` 定稿与校验。
import { readFileSync, writeFileSync } from 'node:fs';

const OURS = 'package-lock.json';
const UP = 'E:/destop/mod2/_work/attr-030/package-lock.json';

const ours = JSON.parse(readFileSync(OURS, 'utf8'));
const up = JSON.parse(readFileSync(UP, 'utf8'));

const WANT = [
  'node_modules/@endo/cache-map',
  'node_modules/@endo/env-options',
  'node_modules/@endo/immutable-arraybuffer',
  'node_modules/ses',
];

for (const k of WANT) {
  if (!up.packages[k]) throw new Error(`upstream lock has no ${k} — 拒绝静默跳过`);
  if (ours.packages[k]) { console.log('already present, skip:', k); continue; }
  ours.packages[k] = up.packages[k];
  console.log('added:', k, up.packages[k].version);
}

// npm 自己的键序：packages 里的键本来就是我们按字典序存的，补完再按字典序重排，逐键一致。
const sorted = {};
for (const k of Object.keys(ours.packages).sort()) sorted[k] = ours.packages[k];
ours.packages = sorted;

writeFileSync(OURS, JSON.stringify(ours, null, 2) + '\n');
console.log('wrote', OURS, '| packages now', Object.keys(ours.packages).length, '| version kept', ours.version);
