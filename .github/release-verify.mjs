#!/usr/bin/env node
// .github/release-verify.mjs —— 发布前的**产物**闸门。
//
//   node .github/release-verify.mjs --zip <构建出的 zip> [--manifest .github/overlay.json]
//
// 为什么要有这个文件：打包器 `tools/package.mjs` 的 `zipFolder` 在走 `zip` 那条分支时
// **不校验产物**（2026-10-14 实测：维护方 main 的 `Lint`/打包红就是这一类，返回码骗人）。
// 所以发布这一步自己按 zip 的**条目清单**判，不接受「命令跑完了 = 包是对的」。
//
// 退出码：0 = 可以发；1 = 违背 `release.excludePrefixes` / 缺 `mustContain`（**不发**）；
//         2 = 判不了（zip 读不到、条目为空、清单坏了）—— 同样不发，绝不报绿。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? (process.argv[i + 1] || d) : d; };
const zip = arg('--zip'), manPath = arg('--manifest', '.github/overlay.json');
if (!zip) { console.error('usage: node .github/release-verify.mjs --zip <file.zip> [--manifest <overlay.json>]'); process.exit(2); }
if (!fs.existsSync(zip)) { console.error(`::error::zip 不存在：${zip}`); process.exit(2); }
let ov;
try { ov = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (e) { console.error(`::error::清单读不到或不是 JSON：${e.message}`); process.exit(2); }
const rel = ov.release ?? {};
const excludes = rel.excludePrefixes ?? [];
const must = rel.mustContain ?? [];
if (!excludes.length || !must.length) { console.error('::error::清单里 release.excludePrefixes / mustContain 是空的，不判绿'); process.exit(2); }

const r = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.error || r.status !== 0) { console.error(`::error::unzip -Z1 失败：${(r.stderr || r.error?.message || '').slice(0, 300)}`); process.exit(2); }
const entries = r.stdout.split(/\r?\n/).filter((l) => l && !l.endsWith('/'));
if (!entries.length) { console.error('::error::zip 里一条文件都没有 —— 判不了，不发'); process.exit(2); }

const bad = entries.filter((e) => excludes.some((p) => e.startsWith(p)));
const missing = must.filter((e) => !entries.includes(e));
const byExt = {};
for (const e of entries) {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(e);
  const k = m ? m[1].toLowerCase() : '(无扩展名)';
  byExt[k] = (byExt[k] || 0) + 1;
}
const top = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`产物：${path.basename(zip)} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)，条目 ${entries.length} 个；扩展名前列：${top}`);
console.log(`判据：排除前缀 ${excludes.length} 条、必须在 ${must.length} 条`);
for (const e of bad.slice(0, 20)) console.log(`✗ 不该出现的条目：${e}`);
if (bad.length > 20) console.log(`✗ …另 ${bad.length - 20} 条`);
for (const e of missing) console.log(`✗ 缺必须的条目：${e}`);
if (bad.length || missing.length) {
  console.error(`::error::产物不合格（多余 ${bad.length} / 缺失 ${missing.length}）—— 不发布`);
  process.exit(1);
}
console.log('✓ 条目清单合格：无素材 / 无内容包 / 无 editor / 无测试 / 无 .github / 无我这线附加，且 Mod API 那几个入口都在');
