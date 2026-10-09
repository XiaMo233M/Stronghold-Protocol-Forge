// test/workshopValidateOverrides.test.js
//
// `tools/workshop-validate.mjs` 判**哪一份**记录 —— 这条契约的回归测试。
//
// 背景（一个真实踩到的坑）：覆盖官方记录时，包写的是一份**差量补丁**（DESIGN §28.3「逐字段补丁」：只写要改的
// 字段，其余字段仍是官方的），而引擎吃的是 `loadData` 合并出来的那一条。校验器原来把**补丁**当一条完整记录喂进
// 逐记录校验器，于是：
//   * 每条覆盖记录都拿到一条 `OFFICIAL_ID_COLLISION`（明明已经在 `pack.json.overrides` 里声明过）；
//   * 补丁里没写的必填字段全被报成 `MISSING` / `BAD_*`；
//   * `_a` / `_b` 这类跨记录检查也拿到 `NO_PARTNER`。
// 实测：一份合法的社区内容包（104 条记录 / 33 条覆盖）在这条路上拿到 **184 个 error**，而它**一个真问题都没有**。
// 噪声反过来还有一半代价：真问题（例如 `params` 与 `buffs` 不一致，引擎读 `params`）就埋在那 184 条里没人看得见。
//
// 判据来自仓库自己写下的契约 —— `docs/EDITOR.md`：「编辑器里能保存的内容，`tools/workshop-validate.mjs` 一定也
// 接受，反之亦然」。编辑器就是按**合并后**的记录判的（`editor/server.mjs` 的 `overrideBlockers()` + `loadData`），
// 所以校验器照同一份判。本文件把两半都钉住：**覆盖声明过 ⇒ 按合并体判、不再报冲突**，以及
// **没声明覆盖 ⇒ 照旧把缺字段一条条报出来**（证明这不是「把检查关掉」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'workshop-validate.mjs');
const DATA_DIR = path.join(ROOT, 'data');

/** 一条**官方**干员 id（覆盖模式的靶子）。 */
const OFFICIAL_ID = 'chess_char_1_01_a';
/** 只改一个字段的差量补丁：`tier` 之外的一切都必须来自官方那一条。 */
const PARTIAL_PATCH = { tier: 3 };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 一个只带一份 chess 的最小包目录。 */
function makePack(root, id, { overrides = [], records }) {
  writeJson(path.join(root, id, 'pack.json'), {
    id, name: `校验器对照夹具 ${id}`, version: '0.1.0', license: 'CC0-1.0',
    description: '覆盖官方的差量补丁该按合并后的记录判（test/workshopValidateOverrides.test.js）',
    gameVersion: '0.2.x', content: ['chess'], overrides,
  });
  writeJson(path.join(root, id, 'chess.json'), records);
}

function runTool(dir) {
  const r = spawnSync(process.execPath, [TOOL, dir, '--json'], { encoding: 'utf8', timeout: 120_000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* 让下面那条断言把原文带出来 */ }
  return { status: r.status, report, stdout: r.stdout, stderr: r.stderr };
}

const errorsOf = (report) => (report?.packs || []).flatMap((p) => p.issues).filter((i) => i.severity === 'error');

test('覆盖官方记录：按合并后的记录判，不报 OFFICIAL_ID_COLLISION、也不报补丁里没写的字段', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-override-'));
  try {
    const root = path.join(tmp, 'workshop');
    makePack(root, 'override-pack', { overrides: [`chess:${OFFICIAL_ID}`], records: { [OFFICIAL_ID]: { ...PARTIAL_PATCH } } });
    const { status, report, stdout, stderr } = runTool(root);
    assert.ok(report, `--json 必须给出一份可解析的报告\nstdout=${stdout}\nstderr=${stderr}`);
    const errs = errorsOf(report);
    assert.deepEqual(errs.map((e) => `${e.field}/${e.code}`), [], `合并体必须干净，实际：${JSON.stringify(errs)}`);
    assert.equal(status, 0, stdout + stderr);

    // 这三条就是原来的噪声：一条都不许回来
    const all = (report.packs || []).flatMap((p) => p.issues).map((i) => i.code);
    for (const code of ['OFFICIAL_ID_COLLISION', 'MISSING', 'BAD_PROFESSION', 'NO_PARTNER']) {
      assert.equal(all.includes(code), false, `${code} 不该出现在一份声明过覆盖的差量补丁上：${JSON.stringify(all)}`);
    }
    // 合并这件事真的发生了：补丁里只有 tier，判的那一份必须有官方的 profession（否则上面的 0 error 是假的）
    const official = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'chess.json'), 'utf8'))[OFFICIAL_ID];
    assert.ok(official && typeof official.profession === 'string' && official.profession, '夹具前提：官方那一条有 profession');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同一条差量补丁、没有覆盖声明 ⇒ 缺字段照旧一条条报出来（检查没有被关掉）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-override-'));
  try {
    const root = path.join(tmp, 'workshop');
    // 没有 overrides：这份补丁就是一条**本包自己的新记录**，它必须被当作完整记录来判
    makePack(root, 'own-pack', { overrides: [], records: { chess_ws_partial_a: { ...PARTIAL_PATCH } } });
    const { status, report, stdout } = runTool(root);
    assert.ok(report, `--json 必须给出一份可解析的报告\n${stdout}`);
    const codes = errorsOf(report).map((e) => e.code);
    for (const code of ['BAD_PROFESSION', 'BAD_POSITION', 'BAD_RANGE', 'MISSING', 'BAD_TALENTS']) {
      assert.ok(codes.includes(code), `${code} 必须照旧报出来，实际：${JSON.stringify(codes)}`);
    }
    assert.equal(status, 1, '一条不完整的自有记录是 error，不是 warning');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('装备层同一条纪律：覆盖官方装备的差量补丁按合并体判', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-override-'));
  try {
    const root = path.join(tmp, 'workshop');
    const items = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'items.json'), 'utf8'));
    // 挑一条有 params 的官方装备，只改一个字段做差量补丁
    const target = Object.entries(items).find(([, r]) => r && typeof r.params === 'object' && !r.isGolden);
    assert.ok(target, '夹具前提：官方装备表里有一条带 params 的普通记录');
    const id = target[0];
    makePack(root, 'item-override-pack', { overrides: [`items:${id}`], records: {} });
    // chess 空包会被 EMPTY_PACK 拒；所以这个夹具只带 items
    writeJson(path.join(root, 'item-override-pack', 'pack.json'), {
      id: 'item-override-pack', name: '校验器对照夹具（装备）', version: '0.1.0', license: 'CC0-1.0',
      description: '覆盖官方装备的差量补丁该按合并后的记录判（test/workshopValidateOverrides.test.js）',
      gameVersion: '0.2.x', content: ['items'], overrides: [`items:${id}`],
    });
    fs.rmSync(path.join(root, 'item-override-pack', 'chess.json'), { force: true });
    writeJson(path.join(root, 'item-override-pack', 'items.json'), { [id]: { price: 7 } });

    const { status, report, stdout } = runTool(root);
    assert.ok(report, `--json 必须给出一份可解析的报告\n${stdout}`);
    const codes = errorsOf(report).map((e) => e.code);
    assert.equal(codes.includes('OFFICIAL_ID_COLLISION'), false, `声明过覆盖就不该再报冲突：${JSON.stringify(codes)}`);
    assert.equal(codes.includes('MISSING_DERIVED'), false, `合并体带着官方的 params，不该报缺：${JSON.stringify(codes)}`);
    assert.equal(status, 0, stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
