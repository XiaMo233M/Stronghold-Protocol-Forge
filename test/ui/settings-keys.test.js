// test/ui/settings-keys.test.js — 设置项的「写入点 → 默认值」一致性
//
// 为什么需要这条：本项目发现过**三个同一形状的缺口**，都是「运行时/渲染侧早在读某个设置键，
// 而设置侧的存储与入口从没落地」——功能因此**静默不存在**：
//   · `mysticEnergy`   —— 渲染侧与 HUD 读它，设置侧四样全缺（能看不见那一格）
//   · `officialFx`     —— 读写链路缺赋值，「官方特效」控件动了不生效
//   · `combatMetrics`  —— `screens/game.js` 读 `useSettings().combatMetrics === true`，
//                         而那个键永远不存在 ⇒ 面板永远不显示
//
// 这条测试守的是**较窄但低误报**的一半：**凡在 `updateSettings({ X: … })` 里写过的 X，
// 必须存在于 `DEFAULT_SETTINGS`** —— 防「加了 Toggle 却忘了加键」。
//
// ⚠️ 它**抓不住**另一半：「运行时读了某键，但连 Toggle 都没有」（那正是 `combatMetrics` 补之前的状态）。
//    那一半只能靠审 `*.rej`；排查法记在 `docs/BUILD-RECORD.md` 的「读了但没存」一条里。
//
// ⚠️ 只做**单向**（写入 ⊆ 默认），不做双向：`DEFAULT_SETTINGS` 里的键可能由别处程序化写入
//    （不走 `updateSettings`），或确实只读不改 —— 双向断言会产生假红。
//
// Run: node --test test/ui/settings-keys.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DEFAULT_SETTINGS } from '../../public/js/ui/gameLogic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** `updateSettings({ X: … })` 里的那个 `X`。只认字面量键；spread / 传变量抓不到，故下面有数量下限兜着。 */
const WRITE = /updateSettings\(\{\s*([A-Za-z_$][\w$]*)\s*:/g;

test('every settings key written via updateSettings exists in DEFAULT_SETTINGS', () => {
  const files = execFileSync('git', ['grep', '-l', 'updateSettings(', '--', 'public/js'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((f) => f && !f.endsWith('.rej')); // ⚠️ 排除 .rej：那是未落地的伪写入点

  const writes = [];
  const byKey = new Map();
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(WRITE)) {
      writes.push({ key: m[1], file: rel });
      if (!byKey.has(m[1])) byKey.set(m[1], new Set());
      byKey.get(m[1]).add(rel);
    }
  }

  const defaults = Object.keys(DEFAULT_SETTINGS);
  // 把实际数字带进消息里：跑一次就看到 17 / 17 / 17，掉下来立刻能发现
  const summary = `扫描到 ${writes.length} 个写入点、${byKey.size} 个唯一键；DEFAULT_SETTINGS 有 ${defaults.length} 个键`;

  // ⚠️ 判据不能静默失效：正则只认字面量键，遇到 `updateSettings({ ...spread })` 或 `updateSettings(obj)`
  // 会一个都抓不到。下面两条下限让「抓不到」变成**红**，而不是安静地通过。
  assert.ok(writes.length >= 10, `写入点太少，扫描可能失效（${summary}）—— 是不是写法换了、正则漏了？`);
  assert.ok(byKey.size >= 10, `抓到的唯一键太少，扫描可能失效（${summary}）`);
  assert.ok(defaults.length >= 10, `DEFAULT_SETTINGS 只有 ${defaults.length} 个键 —— 导出被改名或删掉了？`);

  const known = new Set(defaults);
  const missing = [...byKey.keys()].filter((k) => !known.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `这些键被 updateSettings 写入，却不在 DEFAULT_SETTINGS 里（会写进一个不存在的设置项）：\n`
      + missing.map((k) => `  · ${k}  ← ${[...byKey.get(k)].join(', ')}`).join('\n')
      + `\n${summary}`,
  );
});
