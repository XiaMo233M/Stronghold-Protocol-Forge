#!/usr/bin/env node
// tools/mod-manager-report.mjs — 打印这台服务器**这一版到底装了什么**（DESIGN 重构计划 Phase 0 的「运行时
// 证明」那一件，也是官方/Forge 两档的**同一个**入口）。
//
// 为什么值得单独一个工具：重构的核心是把「哪些包在跑」收成唯一一份 `ActivationPlan`，但那份计划此前只有
// **启动日志**这一条出口 —— 运维要回答「激活摘要是什么、哪些包被裁了、为什么」只能翻日志。这个工具把同样的
// 判据搬到命令行，且**走的是生产装载器**（`loadWorkshop` / `loadOfficialPlugins`），不是另写一份近似实现。
//
// 用法：
//   node tools/mod-manager-report.mjs [--workshop <dir>] [--plugins <dir>] [--state <dir>]
//                                     [--mode official-only|official-preferred|legacy-compatible]
//                                     [--require-consent] [--json]
//
// 退出码：0 = 报告成功（**与「有没有包被裁」无关**——被裁是配置事实，不是命令失败）；
//         2 = 连装载都读不了（目录/参数不可用）⇒ 只报错，**绝不印一份看着正常的报告**。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkshop, WORKSHOP_DIR } from '../server/workshop.js';
import { readModRegistry } from '../server/modRegistry.js';
import { stateRootFor } from '../server/modModules.js';
import { loadOfficialPlugins, OFFICIAL_PLUGINS_DIR } from '../server/mod-manager/officialLoader.js';
import { buildActivationPlan } from '../server/mod-manager/plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function parseArgs(argv) {
  const out = { workshop: WORKSHOP_DIR, plugins: path.join(ROOT, OFFICIAL_PLUGINS_DIR), state: null, mode: undefined, requireConsent: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--require-consent') out.requireConsent = true;
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--workshop') out.workshop = argv[++i];
    else if (a === '--plugins') out.plugins = argv[++i];
    else if (a === '--state') out.state = argv[++i];
    else if (a === '-h' || a === '--help') { out.help = true; }
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return out;
}

/** 一份 origin 的计划 → 可打印的行（不含任何 IO）。 */
function describePlan(origin, plan, excludedReasons) {
  const rows = [];
  for (const p of plan.parsed) {
    const reason = excludedReasons.get(p.id);
    rows.push({
      id: p.id,
      origin: p.origin,
      sdk: p.sdk,
      profile: p.profile,
      version: p.version,
      capabilities: p.capabilities,
      permissions: p.permissions,
      contentDigest: p.contentDigest,
      status: plan.activatedSet.has(p.id) ? 'activated' : 'excluded',
      ...(reason ? { code: reason.code, reason: reason.why } : {}),
    });
  }
  return {
    origin,
    counts: { discovered: plan.discovered.length, activated: plan.activated.length, excluded: plan.excluded.length },
    packages: rows,
    capabilities: plan.capabilities,
    digest: plan.digest,
    warnings: plan.warnings,
    errors: plan.errors,
  };
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`[mod-manager-report] ${e.message}`);
    process.exit(2);
  }
  if (args.help) { console.log('usage: node tools/mod-manager-report.mjs [--workshop <dir>] [--plugins <dir>] [--state <dir>] [--mode <m>] [--require-consent] [--json]'); return; }

  const stateRoot = args.state ? path.resolve(args.state) : stateRootFor(ROOT);
  const registry = readModRegistry(stateRoot, { log: quiet });

  // Forge 档
  const loaded = loadWorkshop(args.workshop, { log: quiet });
  const forgeExcluded = new Map();
  for (const d of registry?.packs ? Object.entries(registry.packs).filter(([, e]) => e.state === 'disabled').map(([id]) => id) : []) {
    forgeExcluded.set(d, { code: 'ADMISSION_NOT_ACTIVATED', why: 'disabled by the operator (mod-registry)' });
  }
  const forgePlan = buildActivationPlan({
    packs: loaded.packs,
    registry,
    unavailable: loaded.errors,
    options: { origin: 'forge', ...(args.mode ? { mode: args.mode } : {}), requireConsentForHost: args.requireConsent },
  });
  for (const r of forgePlan.modeRefused) forgeExcluded.set(r.id, { code: r.code, why: r.reason });
  for (const d of forgePlan.disabled) forgeExcluded.set(d.id, { code: 'ADMISSION_NOT_ACTIVATED', why: d.reason });
  for (const r of forgePlan.refused) forgeExcluded.set(r.id, { code: 'ADMISSION_NOT_ACTIVATED', why: r.reason });

  // 官方档
  const official = loadOfficialPlugins(args.plugins, { log: quiet });
  const officialPlan = buildActivationPlan({
    packs: official.plugins,
    registry,
    unavailable: official.errors,
    options: { origin: 'official', ...(args.mode ? { mode: args.mode } : {}), requireConsentForHost: args.requireConsent },
  });
  const officialExcluded = new Map();
  for (const e of official.errors) officialExcluded.set(e.pack, { code: e.code, why: e.reason });
  for (const d of officialPlan.disabled) officialExcluded.set(d.id, { code: 'ADMISSION_NOT_ACTIVATED', why: d.reason });
  for (const r of officialPlan.modeRefused) officialExcluded.set(r.id, { code: r.code, why: r.reason });

  const report = {
    version: 1,
    mode: args.mode || 'legacy-compatible',
    requireConsentForHost: args.requireConsent,
    sources: {
      workshop: { dir: args.workshop, present: !!loaded.present, errors: loaded.errors },
      plugins: { dir: args.plugins, present: !!official.present, errors: official.errors },
    },
    plans: {
      forge: describePlan('forge', forgePlan, forgeExcluded),
      official: describePlan('official', officialPlan, officialExcluded),
    },
    stateRoot,
  };

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  const line = (s) => process.stdout.write(`${s}\n`);
  line(`mod manager report — mode=${report.mode}${args.requireConsent ? ' requireConsent=on' : ''}`);
  for (const key of ['forge', 'official']) {
    const p = report.plans[key];
    line(`\n[${key}] ${p.counts.activated} activated / ${p.counts.excluded} excluded (of ${p.counts.discovered})`);
    for (const row of p.packages) {
      const mark = row.status === 'activated' ? '+' : '-';
      line(`  ${mark} ${row.id}  sdk=${row.sdk} profile=${row.profile} caps=[${row.capabilities.join(', ')}]${row.code ? `  ${row.code}: ${row.reason}` : ''}`);
    }
    if (p.digest.modDigest) line(`  modDigest=${p.digest.modDigest}`);
    line(`  activationDigest=${p.digest.activationDigest}`);
    line(`  capabilities=[${p.capabilities.join(', ')}]`);
    for (const w of p.warnings) line(`  warn ${w.id ? `${w.id}: ` : ''}${w.code}`);
  }
}

main();
