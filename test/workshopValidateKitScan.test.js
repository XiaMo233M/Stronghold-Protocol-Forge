// test/workshopValidateKitScan.test.js
//
// 校验器与**装载器同判**这条契约的回归测试（`shared/workshopValidate.mjs` vs `server/workshop.js`）。
//
// 背景（2026-10-15 实测的两个真缺陷）：
//   ① kit 扫描只判 `.js` 后缀，没跟装载器同判 ⇒
//      * `kits/_helper.js`（`_` 前缀的**共享件**，装载器 `server/workshop.js:1249` 明确跳过）被静态扫描读成
//        一个名叫 `_helper` 的 kit，报 `KIT_NO_TARGET` —— 作者看到一条**永远修不掉**的错；
//      * 一个**名为 `x.js` 的目录**会让 `fs.readFileSync` 当场抛 `EISDIR`，整个 `validateWorkshop` 崩掉
//        （CLI 表现：退出码 2 + stdout 为空，作者只看到「没有这个包」）。
//   ② `only` 命中不到的短路只回 `missing: true`，把**装载器记下的真因**丢掉 ⇒ 作者看到「没有这个包」，
//      而他真正的问题是 `PACK_UNKNOWN_FIELD`（`pack.json` 有闭集外的键）。
//
// 判据来自仓库自己写下的契约：校验器**不比装载器严**（装载器会跳过的，校验器不许报），并且
// 「磁盘上没这个 id」与「这个包装载期就被拒」必须能分开说清。本文件两半都钉住：**该跳的跳、该报的报**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'workshop-validate.mjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 一个只带一份 chess 的最小包目录（目录名 = 包 id，装载器的硬要求）。 */
function makePack(root, id, extra = {}) {
  writeJson(path.join(root, id, 'pack.json'), {
    id, name: `kit 扫描夹具 ${id}`, version: '0.1.0', license: 'CC0-1.0',
    description: '校验器的 kit 扫描必须与装载器同判（test/workshopValidateKitScan.test.js）',
    gameVersion: '0.2.x', content: ['chess'], ...extra,
  });
  writeJson(path.join(root, id, 'chess.json'), {
    chess_char_1_01_a: { chessId: 'chess_char_1_01_a', charId: 'char_002_amiya', tier: 1 },
  });
}

function runTool(target) {
  // CLI 的 `only` 是靠**传包目录本身**推出来的（`resolveRoots`：目录里有 `pack.json` ⇒ 取 dirname 当工坊根、
  // basename 当包 id），没有 `--only` 选项 —— 所以这一路传的是 `<root>/<包 id>`。
  const r = spawnSync(process.execPath, [TOOL, target, '--json'], { encoding: 'utf8', timeout: 120_000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* 让断言把原文带出来 */ }
  return { status: r.status, report, stdout: r.stdout, stderr: r.stderr };
}

const kitIssuesOf = (report) => (report?.kits?.issues || []);
const fieldsOf = (report) => kitIssuesOf(report).map((i) => String(i.field || ''));

test('① kit 扫描与装载器同判：`_` 前缀的共享件不当 kit，名为 `x.js` 的目录不让校验器崩', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-kitscan-'));
  try {
    const root = path.join(tmp, 'workshop');
    makePack(root, 'kitscan-pack');
    const kitDir = path.join(root, 'kitscan-pack', 'kits');
    fs.mkdirSync(kitDir, { recursive: true });
    // 共享件（装载器会跳过）与一个**名为 `x.js` 的目录**（装载器会跳过，旧代码在这里抛 EISDIR）
    fs.writeFileSync(path.join(kitDir, '_helper.js'), 'export const shared = 1;\n', 'utf8');
    fs.mkdirSync(path.join(kitDir, 'x.js'), { recursive: true });
    // 一个**真的** kit，它没有对应的棋子/干员 ⇒ 必须照旧报 `KIT_NO_TARGET`（证明检查没被关掉）
    fs.writeFileSync(path.join(kitDir, 'broken.js'), 'export default { id: "broken" };\n', 'utf8');

    const { report, stdout, stderr } = runTool(root);
    assert.ok(report, `--json 必须给出一份可解析的报告（目录 x.js 不许让校验器崩）\nstdout=${stdout}\nstderr=${stderr}`);

    const fields = fieldsOf(report);
    assert.ok(!fields.some((f) => f.includes('_helper')),
      `\`kits/_helper.js\` 是共享件，装载器会跳过它 ⇒ 校验器不许把它当 kit 报问题。实际：${JSON.stringify(kitIssuesOf(report))}`);
    assert.ok(!fields.some((f) => f.includes('/x.js')),
      `名为 \`x.js\` 的目录不是 kit ⇒ 校验器不许读它。实际：${JSON.stringify(fields)}`);
    assert.ok(fields.some((f) => f.includes('broken.js')),
      `真的 kit 必须照旧被判（这一条证明上面两条不是"把检查关掉"）。实际：${JSON.stringify(fields)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('② 装载期被拒的包：`missing` 之外还要给出真因（`loadErrors`），CLI 那句话也带上它', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-loaderr-'));
  try {
    const root = path.join(tmp, 'workshop');
    // 一个闭集外的顶层键 ⇒ 装载器点名拒（`PACK_UNKNOWN_FIELD`），于是 `only` 命中不到它
    makePack(root, 'badpack', { zzzNotAField: true });

    const { validateWorkshop } = await import('../shared/workshopValidate.mjs');
    const report = await validateWorkshop({ root, only: 'badpack' });
    assert.equal(report.missing, true, '装载不了的包，`only` 命中不到 ⇒ `missing` 仍是真（这条语义不变）');
    const errs = report.loadErrors || [];
    assert.ok(errs.length > 0,
      `必须把装载器的错一并回显，否则作者只看到「没有这个包」（真因是 PACK_UNKNOWN_FIELD）。实际：${JSON.stringify(report)}`);
    assert.ok(errs.some((e) => String(e.reason).includes('PACK_UNKNOWN_FIELD')),
      `真因里必须点名那个码（装载器的错形状是 { pack, reason }，码嵌在 reason 前缀里）。实际：${JSON.stringify(errs)}`);

    const cli = runTool(path.join(root, 'badpack'));
    assert.notEqual(cli.status, 0, 'CLI 在这一路上必须非零退出');
    assert.ok(String(cli.stderr).includes('PACK_UNKNOWN_FIELD'),
      `CLI 那句话要带上真因，不能只喊 \`no loadable pack\`。实际 stderr=${cli.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
