// test/forgeOperator.test.js — 用一个**真实干员**的数值与技能，走完整条「工坊创作 → 引擎接受」链路。
//
// 为什么要这份测试：编辑器、CLI、校验器和 AI prompt 都声称「spec 进去，合法记录出来」。这种声称只有在拿真实
// 数据跑通一遍之后才算数 —— 所以输入不是编的：它从 data/chess.json 里**搜**出一个官方干员（而不是写死某个 id，
// 数据变了也该继续成立），把它的数值、技能黑板、天赋原样搬进一份 spec。这正是作者做「我自己版本的 X」时会做的事。
//
// 它要求的链条，一步都不能少：
//   * 编辑器 API 预览干净 → 保存成对写出普通/精锐 → _meta 进 spec 而**不进**产物
//   * 两套数值逐字段回到官方原值（derive 不许把数字改坏）
//   * 真实引擎认它：进商店池、精锐互指、模拟器能构建 def、GameData 看得到
//   * CLI（workshop-scaffold）用同一份 spec 产出**等价**记录 —— 编辑器与 CLI 不许有分歧
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { createEditorServer } from '../editor/server.mjs';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { toDataSource } from '../server/sim/simdata.js';
import { isKnownBbKey, bbKeyProblem } from '../shared/chessAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const README_KEYS = ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat'];

const chess = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));

/**
 * A real operator a generic kit can fully implement: shop-eligible, has a skill whose blackboard uses only keys the
 * generic kit reads (with the right spelling — `BB_SPELLING` would mean a silently dead effect), has a documented
 * talent, and has its elite twin in the data. Nothing is hardcoded: if the data changes, this re-picks.
 */
function pickSource() {
  for (const [id, rec] of Object.entries(chess)) {
    if (!rec || rec.isGolden || !rec.visible || rec.isHidden || rec.isDiy || !Number.isInteger(rec.tier)) continue;
    if (!rec.skill || !rec.skill.bb || !Object.keys(rec.skill.bb).length) continue;
    if (!Object.keys(rec.skill.bb).every((k) => isKnownBbKey(k) && !bbKeyProblem(k))) continue;
    if (!Array.isArray(rec.talents) || !rec.talents.length || rec.talents.some((t) => !t.name || !t.desc)) continue;
    const golden = chess[rec.goldenId];
    if (!golden || !golden.stats || !rec.stats) continue;
    return { id, rec, golden };
  }
  return null;
}

const picked = pickSource();

/** The spec an author would write, built from the real record — the shape docs/prompts/operator-pack.md documents. */
function specFrom(rec, slug) {
  const stats = (s) => Object.fromEntries(README_KEYS.map((k) => [k, s[k]]));
  return {
    id: slug,
    name: rec.name,
    appellation: rec.appellation ?? null,
    tier: rec.tier,
    profession: rec.profession,
    subProfessionId: rec.subProfessionId ?? null,
    position: rec.position,
    traitDesc: rec.traitDesc ?? '',
    assetsSpine: rec.assets?.spine ?? null,
    stats: { normal: stats(rec.stats), golden: stats(chess[rec.goldenId].stats) },
    skill: {
      name: rec.skill.name,
      desc: rec.skill.desc,
      skillType: rec.skill.skillType,
      durationType: rec.skill.durationType,
      spType: rec.skill.spType,
      spCost: rec.skill.spCost,
      initSp: rec.skill.initSp,
      duration: rec.skill.duration,
      bb: { ...rec.skill.bb },
    },
    talents: rec.talents.map((t) => ({ name: t.name, desc: t.desc, bb: { ...(t.bb || {}) } })),
  };
}

describe('干员编辑：拿一个真实干员跑通整条链路', () => {
  let tmp;
  let wsRoot;
  let editor;
  const SLUG = 'remix_real_op';

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-forge-op-'));
    wsRoot = join(tmp, 'workshop');
    fs.mkdirSync(wsRoot, { recursive: true });
    // the support pool is a hand-maintained server config, so the toggle needs a real file to edit: seed a throwaway copy
    // rather than letting the test touch the repo's data/support.json
    fs.copyFileSync(join(DATA_DIR, 'support.json'), join(tmp, 'support.json'));
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), forgeAuthor: '测试作者' });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('数据里确实有一个「通用 kit 能完整实现」的真实干员（否则下面的测试没有意义）', () => {
    assert.ok(picked, 'data/chess.json 里找不到符合条件（商店可招募 + 技能黑板只含通用键 + 有天赋说明 + 有精锐）的干员');
    assert.ok(picked.rec.name, 'pick 到的干员必须有名字');
    console.log(`      → 本次使用真实干员：${picked.rec.name}（${picked.id}，t${picked.rec.tier} ${picked.rec.profession}）`);
  });

  test('编辑器预览这份 spec：0 错误，且技能黑板没有静默失效的键', async () => {
    const r = await post(`${editor.url}/api/preview`, { spec: specFrom(picked.rec, SLUG) }).then((x) => x.json());
    assert.equal(r.ok, true, `预览必须干净：${JSON.stringify(r.errors)}`);
    for (const bad of ['BB_UNKNOWN_KEY', 'BB_SPELLING']) {
      assert.equal((r.warnings ?? []).filter((w) => String(w).includes(bad)).length, 0, `${bad} 不该出现：${JSON.stringify(r.warnings)}`);
    }
    assert.equal(fs.existsSync(join(wsRoot, 'op-pack')), false, '预览不写盘');
  });

  test('保存：成对写出普通/精锐，_meta 进 spec', async () => {
    const r = await post(`${editor.url}/api/packs/op-pack/operators`, { spec: specFrom(picked.rec, SLUG) }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    const packDir = join(wsRoot, 'op-pack');
    const spec = JSON.parse(fs.readFileSync(join(packDir, 'specs', `${SLUG}.json`), 'utf8'));
    assert.equal(spec._meta.author, '测试作者', 'Option 署名写进 spec');
    assert.equal(spec._meta.source, 'Stronghold-Protocol-Forge');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.deepEqual(Object.keys(records).sort(), [`chess_ws_${SLUG}_a`, `chess_ws_${SLUG}_b`]);
  });

  test('两套数值逐字段回到官方原值 —— derive 不许把数字改坏', async () => {
    const records = JSON.parse(fs.readFileSync(join(wsRoot, 'op-pack/chess.json'), 'utf8'));
    const base = records[`chess_ws_${SLUG}_a`];
    const golden = records[`chess_ws_${SLUG}_b`];
    for (const k of README_KEYS) {
      assert.equal(base.stats[k], picked.rec.stats[k], `普通 ${k}`);
      assert.equal(golden.stats[k], picked.golden.stats[k], `精锐 ${k}`);
    }
    assert.equal(base.skill.name, picked.rec.skill.name);
    assert.equal(base.skill.desc, picked.rec.skill.desc);
    assert.deepEqual(base.skill.bb, picked.rec.skill.bb, '技能黑板原样保留');
    assert.equal(base.talents.length, picked.rec.talents.length);
    for (const [i, t] of picked.rec.talents.entries()) {
      assert.equal(base.talents[i].name, t.name);
      assert.equal(base.talents[i].desc, t.desc);
    }
    // the derivation's own work: price from tier, rarity, classification, the pair
    assert.equal(base.price, picked.rec.price, '价格由阶层推导，且与官方一致');
    assert.equal(base.tier, picked.rec.tier);
    assert.equal(base.isGolden, false);
    assert.equal(golden.isGolden, true);
    assert.equal(base.goldenId, golden.chessId);
    assert.equal(golden.baseId, base.chessId);
    assert.equal(records[`chess_ws_${SLUG}_a`]._meta, undefined, '_meta 绝不能进入游戏读的产物');
  });

  test('真实引擎认它：进商店池、精锐互指、模拟器能构建 def', () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    const gd = new GameData(data, 'mode_multi_hard');
    const ds = toDataSource(data);
    const id = `chess_ws_${SLUG}_a`;
    assert.ok(data.chess[id], '记录必须进入合并后的数据');
    assert.ok(gd.visibleChess.includes(id), '必须能被商店抽到');
    assert.equal(gd.goldenIdOf(id), `chess_ws_${SLUG}_b`, '精锐互指必须解析');
    assert.ok(ds.getChess(id), '模拟器必须能构建 unit def');
    // and the elite resolves to a real unit too
    assert.ok(ds.getChess(`chess_ws_${SLUG}_b`), '精锐也要能构建 def');
  });

  test('CLI 用同一份 spec 产出等价记录 —— 编辑器与 CLI 不许有分歧', async () => {
    const specPath = join(tmp, 'cli-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(specFrom(picked.rec, SLUG)));
    const cliRoot = join(tmp, 'cli-workshop');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-scaffold.mjs'), specPath, '--pack', 'cli-pack', '--workshop', cliRoot], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const cli = JSON.parse(fs.readFileSync(join(cliRoot, 'cli-pack', 'chess.json'), 'utf8'));
    const ui = JSON.parse(fs.readFileSync(join(wsRoot, 'op-pack', 'chess.json'), 'utf8'));
    // the generated records must be identical field-for-field: same rules, same result
    assert.deepEqual(cli[`chess_ws_${SLUG}_a`], ui[`chess_ws_${SLUG}_a`], '普通记录：编辑器与 CLI 必须逐字段一致');
    assert.deepEqual(cli[`chess_ws_${SLUG}_b`], ui[`chess_ws_${SLUG}_b`], '精锐记录：编辑器与 CLI 必须逐字段一致');
  });

  test('校验器对这个包 0 错误，并打出 VALID 与各层结果', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), wsRoot], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /VALID: the engine accepts this content\./);
    assert.match(r.stdout, /0 error\(s\)/);
  });

  test('干员的助战开关也能打开（这是编辑器首页那条规则）', async () => {
    const id = `chess_ws_${SLUG}_a`;
    const supportFile = join(tmp, 'support.json');
    const r = await post(`${editor.url}/api/support/toggle`, { chessId: id, tier: picked.rec.tier, enabled: true }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    const cfg = JSON.parse(fs.readFileSync(supportFile, 'utf8'));
    const listed = JSON.stringify(cfg).includes(id);
    assert.equal(listed, true, '开启助战后该干员必须出现在服务端卡池里');
  });
});
