// test/workshopValidateArtTables.test.js
//
// `tools/workshop-validate.mjs` 遍历 `pack.json.art` 的**每一张表**，而 `art` 里有两类表：
//
//   * **对象表**（chars / enemies / tokens）：条目的值是带 `spine` 的对象，客户端按 id 查表，所以「这个 id 有没有
//     人用」是一条成立的判据（`ART_UNKNOWN_ID`，warning）；
//   * **扁平表**（skills / profSub）：条目的值**就是一条路径字符串**（`assets.skills[key]` / `assets.prof.sub[key]`），
//     `ART_TABLES[表].flat = true` 标着它们。
//
// 真实踩到的坑：第二段循环（「id 有没有人用」）拿**每一张**表去索引 `OFFICIAL_ART_IDS` / `ownIds` —— 那两张只对
// 三张对象表建过。于是**任何声明 `art.skills` 或 `art.profSub` 的包都会让校验器抛 `TypeError`（退出码 2）**：
// 一份只多了一张图标表的合法包，得到的不是「结论」，而是**连报告都吐不出来**的崩溃。
//
// 本文件钉住两件事：
//   1. 只声明 `art.skills` / `art.profSub` 的包 —— 校验器**跑完**（退出码 0/1，不是 2），且 `--json` 的报告可解析；
//   2. 同一份包在**加了**一条没人用的对象表素材时，`ART_UNKNOWN_ID` 照旧报出来（证明守卫没有把整段检查关掉）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'workshop-validate.mjs');

/** 一张 1×1 的最小 png（素材路由只按**扩展名**放行，内容不参与这一层的判定）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 一个最小包：`art.skills` / `art.profSub` 各一条（扁平表），外加可选的一条对象表素材。
 * `assets/` 目录必须存在 —— `art` 的声明要求包自带素材（`ART_NEEDS_ASSETS`）。
 */
function makePack(root, id, { extraArt = null } = {}) {
  writeJson(path.join(root, id, 'pack.json'), {
    id, name: `扁平图标表夹具 ${id}`, version: '0.1.0', license: 'CC0-1.0',
    description: '只声明 art.skills / art.profSub 的包必须跑完而不是崩（test/workshopValidateArtTables.test.js）',
    gameVersion: '0.2.x', content: ['chess'],
    art: {
      skills: { skchr_fixture_1: 'art/skchr_fixture_1.png' },
      profSub: { fixturebranch: 'art/fixturebranch.png' },
      ...(extraArt ? { enemies: extraArt } : {}),
    },
  });
  writeJson(path.join(root, id, 'chess.json'), {
    [`chess_fixture_${id.replace(/-/g, '_')}`]: {
      charId: `fixture_${id.replace(/-/g, '_')}`, name: '夹具干员', rarity: 3,
      profession: 'WARRIOR', subProfessionId: 'fixturebranch', tier: 1,
      isDiy: false, isHidden: false, isGolden: false, visible: true,
      assets: { spine: `fixture_${id.replace(/-/g, '_')}` },
    },
  });
  fs.mkdirSync(path.join(root, id, 'assets', 'art'), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'assets', 'art', 'skchr_fixture_1.png'), PNG);
  fs.writeFileSync(path.join(root, id, 'assets', 'art', 'fixturebranch.png'), PNG);
}

function runTool(dir) {
  const r = spawnSync(process.execPath, [TOOL, dir, '--json'], { encoding: 'utf8', timeout: 120_000 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* 让下面那条断言把原文带出来 */ }
  return { status: r.status, report, stdout: r.stdout, stderr: r.stderr };
}

const issuesOf = (report) => (report?.packs || []).flatMap((p) => p.issues);
const codesOf = (report) => issuesOf(report).map((i) => i.code);

test('只声明 art.skills / art.profSub 的包：校验器跑完并给出结论，不崩', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-flat-art-'));
  try {
    const root = path.join(tmp, 'workshop');
    makePack(root, 'flat-art-pack');
    const { status, report, stdout, stderr } = runTool(root);
    // 退出码 2 = 用法/崩溃；这一条钉的就是它不再是 2。0 = 没有 error，1 = 有 error（都对，只要报告在）。
    assert.notEqual(status, 2, `校验器崩了（退出码 2）\nstdout=${stdout}\nstderr=${stderr}`);
    assert.ok(report, `--json 必须给出一份可解析的报告\nstdout=${stdout}\nstderr=${stderr}`);
    // 扁平表的两个键都数进了 art 的条目数：证明这一趟循环真的走过那两张表（不是被提前跳过）
    const pack = (report.packs || []).find((p) => p.pack === 'flat-art-pack');
    assert.ok(pack, '报告里必须有这个包');
    assert.equal(pack.art, 2, `art 的条目数应当是 skills + profSub 两条，实际 ${pack.art}`);
    // 扁平表不报 ART_UNKNOWN_ID（它没有「谁的模型」这回事），也不该报任何别的 error 前缀
    assert.equal(codesOf(report).includes('ART_UNKNOWN_ID'), false,
      `扁平图标表不该走「这个 id 有没有人用」那条判据：${JSON.stringify(issuesOf(report))}`);
    const errs = issuesOf(report).filter((i) => i.severity === 'error' && i.field.startsWith('art.'));
    assert.deepEqual(errs, [], `art 这一层不该有 error：${JSON.stringify(errs)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('对象表那一段没有被关掉：多一条没人用的 enemies 素材照旧报 ART_UNKNOWN_ID', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-validate-flat-art-'));
  try {
    const root = path.join(tmp, 'workshop');
    makePack(root, 'flat-art-plus-orphan', { extraArt: { enemy_nobody_uses: { icon: 'art/orphan.png' } } });
    fs.writeFileSync(path.join(root, 'flat-art-plus-orphan', 'assets', 'art', 'orphan.png'), PNG);
    const { status, report, stdout, stderr } = runTool(root);
    assert.notEqual(status, 2, `校验器崩了（退出码 2）\nstdout=${stdout}\nstderr=${stderr}`);
    assert.ok(report, `--json 必须给出一份可解析的报告\nstdout=${stdout}\nstderr=${stderr}`);
    const hits = issuesOf(report).filter((i) => i.code === 'ART_UNKNOWN_ID');
    assert.deepEqual(hits.map((i) => i.field), ['art.enemies.enemy_nobody_uses'],
      `只有那条对象表素材该被点名，实际：${JSON.stringify(issuesOf(report))}`);
    assert.equal(hits[0].severity, 'warning');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('扁平表都在 shared/workshop.js 的 ART_TABLES 里标着 flat —— 守卫读的是那一份，不是抄来的名单', async () => {
  const { ART_TABLES } = await import('../shared/workshop.js');
  assert.deepEqual(
    Object.entries(ART_TABLES).filter(([, shape]) => shape.flat).map(([t]) => t).sort(),
    ['bands', 'bonds', 'profSub', 'skills'],
    '扁平表就是这四张：校验器与加载器读的是同一个 ART_TABLES，多一张 / 少一张这里先红',
  );
  // 一张扁平表必须给出落点（`target`）—— `bonds` / `bands` 就是这样加进来的（art.bonds → assets.bonds）。
  // 少写 target 的后果是「校验通过、报数也对、图没进清单」，所以模块加载时就抛。
  for (const [table, shape] of Object.entries(ART_TABLES).filter(([, s]) => s.flat)) {
    assert.ok(Array.isArray(shape.target) && shape.target.length, `${table} 必须有非空 target`);
  }
});
