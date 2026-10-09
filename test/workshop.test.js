// test/workshop.test.js — 创意工坊 (community workshop) packs: format, overlay and delivery (docs/WORKSHOP.md).
//
// The load-bearing promises, all checked here:
//   * `data/*.json` is NEVER rewritten — the overlay is additive and applied in memory (server/data.js, before the
//     freeze), so the official data stays byte-identical and remains a clean baseline.
//   * A pack cannot replace an official record unless `pack.json.overrides` names it explicitly; a silent collision is
//     rejected and reported, because redefining a shipped operator would corrupt every match on the server.
//   * A broken pack is skipped with a report, never fatal — and a missing `workshop/` directory is the normal case.
//   * The BROWSER receives the merged data over `/data/<file>.json`, so client and server agree; a file no pack touches
//     is still served straight from disk.
//   * Workshop content is real content: it lands in the shop pool, resolves in the sim and fights in a real battle.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadData, getData } from '../server/data.js';
import { loadWorkshop, workshopTouchedFiles, WORKSHOP_DIR } from '../server/workshop.js';
import { applyWorkshop, normalizePackManifest, normalizeContentFile, workshopSummary, WORKSHOP_CONTENT_FILES, OVERRIDE_REPLACE_KEYS, OVERRIDE_KEYED_LISTS } from '../shared/workshop.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';
import { makeMatch, give, legalTileFor } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const EXAMPLE = join(ROOT, 'docs/examples/demo-workshop');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const WS_BASE = 'chess_char_ws_demo_01_a';
const WS_GOLD = 'chess_char_ws_demo_01_b';
const SOURCE = 'chess_char_5_01_a';
/** The demo pack's maxHp, i.e. deliberately different from the operator it reskins. */
const WS_MAXHP = 2067;

let tmpRoot;
/** A temp workshop root holding just the shipped example pack. */
let tmpWs;

before(() => {
  tmpRoot = fs.mkdtempSync(join(tmpdir(), 'sp-workshop-'));
  tmpWs = join(tmpRoot, 'ws');
  fs.mkdirSync(tmpWs, { recursive: true });
  fs.cpSync(EXAMPLE, join(tmpWs, 'demo-workshop'), { recursive: true });
});
after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('workshop: loader', () => {
  test('a missing workshop/ directory is the normal case, not an error', () => {
    const r = loadWorkshop(join(tmpRoot, 'does-not-exist'), { log: quiet });
    assert.equal(r.present, false);
    assert.deepEqual(r.packs, []);
    assert.deepEqual(r.errors, []);
  });

  test('the shipped example pack loads cleanly and declares what it ships', () => {
    const r = loadWorkshop(tmpWs, { log: quiet });
    assert.equal(r.present, true);
    assert.equal(r.packs.length, 1);
    assert.deepEqual(r.errors, []);
    const pack = r.packs[0];
    assert.equal(pack.id, 'demo-workshop');
    assert.equal(pack.version, '0.1.0');
    assert.equal(pack.license, 'CC0-1.0');
    assert.deepEqual(pack.content, ['chess']);
    assert.deepEqual([...workshopTouchedFiles(r)], ['chess']);
  });

  test('a broken pack is reported and skipped instead of throwing', () => {
    const bad = join(tmpRoot, 'bad');
    fs.mkdirSync(join(bad, 'no-manifest'), { recursive: true });
    fs.mkdirSync(join(bad, 'missing-file'), { recursive: true });
    fs.writeFileSync(join(bad, 'missing-file/pack.json'), JSON.stringify({ id: 'missing-file', content: ['chess'] }));
    fs.mkdirSync(join(bad, 'not-json'), { recursive: true });
    fs.writeFileSync(join(bad, 'not-json/pack.json'), '{ not json');
    const r = loadWorkshop(bad, { log: quiet });
    assert.deepEqual(r.packs, []);
    assert.equal(r.errors.length, 3);
    assert.match(r.errors.map((e) => e.reason).join(' | '), /pack\.json is missing/);
    assert.match(r.errors.map((e) => e.reason).join(' | '), /declared in pack\.json but missing/);
    assert.match(r.errors.map((e) => e.reason).join(' | '), /unreadable/);
  });
});

describe('workshop: the overlay', () => {
  test('adds content before the freeze, leaving data/*.json byte-identical', () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: tmpWs });
    assert.ok(data.chess[WS_BASE], 'the workshop base operator is missing');
    assert.ok(data.chess[WS_GOLD], 'the workshop elite is missing');
    assert.equal(Object.isFrozen(data), true);
    assert.equal(Object.isFrozen(data.chess), true);
    assert.equal(Object.isFrozen(data.chess[WS_BASE]), true);
    // the official file on disk must NOT have been touched
    const disk = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));
    assert.equal(Object.keys(disk).length, 266);
    assert.equal(disk[WS_BASE], undefined);
    // the merged view is official + workshop
    assert.equal(Object.keys(data.chess).length, 268);
  });

  test('the official data stays a clean baseline when no (or no) pack is used', () => {
    assert.equal(Object.keys(getData({ log: quiet }).chess).length, 266, 'the process singleton must not see workshop content');
    assert.equal(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess).length, 266);
    assert.equal(loadWorkshop(WORKSHOP_DIR, { log: quiet }).packs.length, 0, 'the repo ships no active pack');
  });

  // 「试玩里是一张贴图而不是模型」的数据侧安全网：手写包、CLI 写出来的包、编辑器写出来的包走的是同一层，
  // 所以这条判定放在 overlay 里 —— 没有任何报错的字段，必须有人替作者看一眼。
  test('an operator with no resolvable model is reported (it renders as a flat portrait)', () => {
    const base = loadData(DATA_DIR, { log: quiet, workshopDir: null });
    const source = base.chess[SOURCE];
    // 客户端取模型 = rec.assets?.spine || rec.charId：两者都空才是真的没有模型（编辑器写出来的记录就是这种）
    const noSpine = { ...source, chessId: 'chess_ws_noface_a', baseId: 'chess_ws_noface_a', goldenId: null, name: '没外观', charId: null };
    delete noSpine.assets;
    const badSpine = { ...source, chessId: 'chess_ws_badface_a', baseId: 'chess_ws_badface_a', goldenId: null, name: '错外观', assets: { ...source.assets, spine: 'char_not_installed' } };
    const goodSpine = { ...source, chessId: 'chess_ws_goodface_a', baseId: 'chess_ws_goodface_a', goldenId: null, name: '正常外观' };
    const byCharId = { ...source, chessId: 'chess_ws_charid_a', baseId: 'chess_ws_charid_a', goldenId: null, name: '靠 charId 渲染' };
    delete byCharId.assets;
    const r = applyWorkshop({ ...base }, [{
      id: 'p', name: 'P',
      files: { chess: { 'chess_ws_noface_a': noSpine, 'chess_ws_badface_a': badSpine, 'chess_ws_goodface_a': goodSpine, 'chess_ws_charid_a': byCharId } },
    }]);
    const looks = r.report.looks;
    assert.equal(looks.length, 2, JSON.stringify(looks));
    assert.deepEqual(looks.map((l) => l.id).sort(), ['chess_ws_badface_a', 'chess_ws_noface_a']);
    assert.equal(looks.find((l) => l.id === 'chess_ws_noface_a').code, 'MODEL_MISSING');
    assert.equal(looks.find((l) => l.id === 'chess_ws_badface_a').code, 'MODEL_UNKNOWN');
    // 报的是「会画成贴图」，并且说清该怎么办
    assert.match(looks[0].reason, /flat portrait/);
    // 复用已装好模型 / 靠 charId 取到模型的干员必须安静（这条规则只抓真的没模型的）
    assert.equal(looks.some((l) => l.id === 'chess_ws_goodface_a' || l.id === 'chess_ws_charid_a'), false);
    assert.match(workshopSummary(r.report), /2 个干员没有模型/);
  });

  test('an enemy with no resolvable model is reported too (the monster half of the same safety net)', () => {
    // 干员那条检查只看 chess 记录；怪物走 enemies.json，而客户端在拿不到模型时同样一条日志都不打
    // （simdata 取 rec.spine ?? key，assets.spineEntry 读 enemies[key].spine，条目里的 spineAliasOf 可以借别人的模型）。
    const base = {
      assets: {
        enemies: {
          enemy_ok: { icon: '/assets/enemy/ok.png', spine: { skel: '/assets/spine/e/ok.skel', atlas: '/assets/spine/e/ok.atlas' } },
          enemy_alias: { icon: '/assets/enemy/a.png', spineAliasOf: 'enemy_ok' },
          enemy_nomodel: { icon: '/assets/enemy/n.png' },
        },
      },
    };
    const enemies = {
      enemy_ws_good: { key: 'enemy_ws_good', name: '正常', spine: 'enemy_ok' },
      enemy_ws_alias: { key: 'enemy_ws_alias', name: '借模型', spine: 'enemy_alias' },
      enemy_ws_bad: { key: 'enemy_ws_bad', name: '错模型', spine: 'enemy_missing' },
      enemy_ws_nomodel: { key: 'enemy_ws_nomodel', name: '无模型', spine: 'enemy_nomodel' },
      enemy_ws_selfkey: { key: 'enemy_selfkey', name: '自己就是模型名' },
    };
    const r = applyWorkshop({ ...base }, [{ id: 'p', name: 'P', files: { enemies } }]);
    const looks = r.report.looks;
    assert.deepEqual(looks.map((l) => l.id).sort(), ['enemy_ws_bad', 'enemy_ws_nomodel', 'enemy_ws_selfkey']);
    assert.equal(looks.every((l) => l.kind === 'enemy'), true, '怪物条目要能被认出来（summary 分开数）');
    assert.equal(looks.find((l) => l.id === 'enemy_ws_bad').code, 'MODEL_UNKNOWN');
    assert.equal(looks.find((l) => l.id === 'enemy_ws_nomodel').code, 'MODEL_MISSING');
    assert.equal(looks.find((l) => l.id === 'enemy_ws_selfkey').code, 'MODEL_UNKNOWN', '没写 spine 时用 key 当模型名');
    // 借到模型的（enemy_alias → enemy_ok）与直接指向真模型的必须安静
    assert.equal(looks.some((l) => l.id === 'enemy_ws_good' || l.id === 'enemy_ws_alias'), false);
    assert.match(workshopSummary(r.report), /3 个怪物没有模型/);
    assert.doesNotMatch(workshopSummary(r.report), /个干员没有模型/);
    // 包把模型自带进来（art）之后，这条警告就该消失 —— 注意 art 的键是**客户端会查的那个模型 id**：
    // enemy_ws_bad 的 spine 写了 enemy_missing，所以模型要声明在 art.enemies.enemy_missing 上；
    // 而没写 spine 的怪物，客户端拿它的 key 当模型名（rec.spine ?? key），所以 art 就按那个 key 声明。
    const withArt = applyWorkshop({ ...base }, [{
      id: 'p', name: 'P',
      files: { enemies: { enemy_ws_bad: enemies.enemy_ws_bad, enemy_ws_selfkey: enemies.enemy_ws_selfkey } },
      art: {
        enemies: {
          enemy_missing: { spine: { skel: 'art/bad.skel', atlas: 'art/bad.atlas' } },
          enemy_ws_selfkey: { icon: 'art/self.png', spine: { skel: 'art/self.skel', atlas: 'art/self.atlas' } },
        },
      },
    }]);
    assert.deepEqual(withArt.report.looks, []);
    assert.match(workshopSummary(withArt.report), /2 art entr/);
  });

  test('a collision with an official id is rejected unless the pack declares the override', () => {
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    const hostile = { ...official, name: 'hijacked' };
    const base = { chess: { [officialId]: official } };

    const silent = applyWorkshop(base, [{ id: 'evil', name: 'evil', overrides: [], files: { chess: { [officialId]: hostile } } }]);
    assert.equal(silent.data.chess[officialId].name, official.name, 'the official record must win');
    assert.equal(silent.report.errors.length, 1);
    assert.match(silent.report.errors[0].reason, /overrides/);
    assert.match(silent.report.errors[0].reason, /official data/);
    assert.equal(silent.report.errors[0].definedBy, 'official', 'and the attribution must say so');
    assert.equal(silent.report.errors[0].code, 'OFFICIAL_ID_COLLISION');
    assert.deepEqual(silent.report.overridden, {});

    const declared = applyWorkshop(base, [{ id: 'ok', name: 'ok', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: hostile } } }]);
    assert.equal(declared.data.chess[officialId].name, 'hijacked');
    assert.deepEqual(declared.report.overridden.chess, [officialId]);
    assert.deepEqual(declared.report.errors, []);
  });

  // 归因（本次修复）：第二个包撞上第一个包**新增**的 id 时，旧文案说它「已存在于官方数据」——作者会去 `data/chess.json`
  // 里找一条根本不存在的记录。文案必须点名占位的那个包，并且给出机器可读的 `definedBy`（日志只打 reason，测试只能
  // 靠文字，而编辑器/工具需要结构化字段）。
  test('two packs claiming the same NEW id name the pack that already ships it, not the official data', () => {
    const rec = (chessId) => ({ chessId, baseId: chessId, name: chessId });
    const claim = (id) => ({ id, name: id, files: { chess: { chess_ws_shared_a: rec('chess_ws_shared_a') } } });

    const { data, report } = applyWorkshop({ chess: {} }, [claim('alpha'), claim('beta')]);
    assert.equal(data.chess.chess_ws_shared_a.name, 'chess_ws_shared_a', 'the first pack keeps the id');
    assert.deepEqual(report.added.chess, ['chess_ws_shared_a']);
    assert.equal(report.errors.length, 1);
    const err = report.errors[0];
    assert.equal(err.pack, 'beta', 'the error blames the pack that collided');
    assert.equal(err.code, 'PACK_ID_COLLISION', 'and carries a machine-readable code');
    assert.equal(err.file, 'chess');
    assert.equal(err.id, 'chess_ws_shared_a');
    assert.equal(err.definedBy, 'alpha', 'and names the pack that holds it');
    assert.match(err.reason, /pack "alpha"/);
    assert.doesNotMatch(err.reason, /official/, 'the record is not in the official data and the text must not imply it is');
    // the refined rule (owner, 2026-10-09): an `overrides` declaration does NOT beat another pack, so the message must
    // not offer it as the way in — the way in is to rename the record, or to let the holder drop it
    assert.doesNotMatch(err.reason, /overrides to replace/, 'an override cannot beat another pack');
    assert.match(err.reason, /does not win against another pack/);
    assert.match(err.reason, /Rename this record/);

    // and the winner is a property of the pack ids, not of the array: the reversed array gives the same verdict
    const flipped = applyWorkshop({ chess: {} }, [claim('beta'), claim('alpha')]);
    assert.equal(flipped.data.chess.chess_ws_shared_a.name, 'chess_ws_shared_a');
    assert.deepEqual(flipped.report.errors, report.errors, 'the array order must not decide anything');
  });

  // 归一（DESIGN §27.3，2026-10-09 业主裁定）：**所有面都按包 id 字典序**，赢家与「包是按什么顺序交进来的」无关。
  // 这条测试钉的是契约本身：同一个包集正序与倒序必须给出同一个赢家、同一条报告、同一份合并结果。
  test('every face picks the same winner, and the winner does not depend on the array order', () => {
    const chessId = 'chess_ws_tie_a';
    const packOf = (id, name) => ({
      id, name, overrides: [],
      files: { chess: { [chessId]: { chessId, baseId: chessId, name } } },
      bondIcons: { bond_tie: `${name}.png` },
      itemIcons: { item_tie: `${name}.png` },
      art: { chars: { [chessId]: { avatar: `${name}.png` } } },
    });
    const zeta = packOf('zeta', 'Z');   // 数组里在前，但包 id 更大
    const alpha = packOf('alpha', 'A');
    const base = () => ({ chess: {}, assets: { bonds: {}, items: {}, chars: {} } });

    const results = [[zeta, alpha], [alpha, zeta]].map((packs) => applyWorkshop(base(), packs));
    for (const { data, report } of results) {
      assert.deepEqual(report.packs.map((p) => p.id), ['alpha', 'zeta'], 'packs merge in pack-id order');
      // the five faces: data record, bond icon, item icon, art entry — the smaller id wins every one of them
      assert.equal(data.chess[chessId].name, 'A', 'data face');
      assert.equal(data.assets.bonds.bond_tie, '/workshop-assets/alpha/A.png', 'bond icon face');
      assert.equal(data.assets.items.item_tie, '/workshop-assets/alpha/A.png', 'item icon face');
      assert.equal(data.assets.chars[chessId].avatar, '/workshop-assets/alpha/A.png', 'art face');
      // one reported collision per face, all of them blaming zeta and naming alpha as the holder
      assert.equal(report.errors.length, 4, JSON.stringify(report.errors));
      for (const e of report.errors) {
        assert.equal(e.pack, 'zeta');
        assert.equal(e.definedBy, 'alpha');
      }
      assert.deepEqual([...new Set(report.errors.map((e) => e.code))].sort(), ['ASSET_COLLISION', 'PACK_ID_COLLISION']);
    }
    // …and the two runs are indistinguishable: the array order changed nothing at all
    assert.deepEqual(results[0].report.errors, results[1].report.errors);
    assert.deepEqual(results[0].report.added, results[1].report.added);
    assert.deepEqual(results[0].data.assets, results[1].data.assets);
    assert.deepEqual(Object.keys(results[0].data.chess), Object.keys(results[1].data.chess));
  });

  test('a collision that a declared override resolved does not mis-attribute the next pack', () => {
    // alpha REPLACES an official id on purpose; beta claims the same id without declaring it — beta collides with
    // alpha's record, so the message names alpha (the official record is gone from the merged view either way)
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    const base = { chess: { [officialId]: official } };
    const packs = [
      { id: 'alpha', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: { ...official, name: 'alpha' } } } },
      { id: 'beta', overrides: [], files: { chess: { [officialId]: { ...official, name: 'beta' } } } },
    ];
    const { data, report } = applyWorkshop(base, packs);
    assert.equal(data.chess[officialId].name, 'alpha');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].pack, 'beta');
    assert.equal(report.errors[0].definedBy, 'alpha');
    assert.equal(report.errors[0].code, 'PACK_ID_COLLISION');
  });

  // 业主 2026-10-09 细化的裁决（DESIGN §27.3）：**覆盖同一条已存在记录**时，包 id 字典序最小者生效 —— 而且
  // `overrides` 声明**不能**用来压过另一个包（声明是「可以替换官方数据」的授权，不是抢别人内容的许可）。
  test('overriding the SAME existing record: the smaller pack id wins even when both declare the override', () => {
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    const base = () => ({ chess: { [officialId]: official } });
    const both = [
      { id: 'alpha', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: { ...official, name: 'alpha' } } } },
      { id: 'zeta', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: { ...official, name: 'zeta' } } } },
    ];
    for (const packs of [both, [...both].reverse()]) {
      const { data, report } = applyWorkshop(base(), packs);
      assert.equal(data.chess[officialId].name, 'alpha', 'the smaller pack id keeps the record');
      assert.equal(report.errors.length, 1, JSON.stringify(report.errors));
      assert.equal(report.errors[0].pack, 'zeta');
      assert.equal(report.errors[0].definedBy, 'alpha');
      assert.equal(report.errors[0].code, 'PACK_ID_COLLISION');
      assert.match(report.errors[0].reason, /does not win against another pack/);
      assert.deepEqual(report.overridden.chess, [officialId], 'alpha did override the official record; zeta did not');
    }
  });

  // 业主 2026-10-09（DESIGN §27.5）：`overrides` 是**按字段合并**，不是整条替换。改之前实测：一条只写
  // `stats.maxHp` 的覆盖把 44 字段的干员压成 2 字段，engine 看到 tier:1 / atk:0 / skill:null，画成一格占位，
  // 而 `applyWorkshop` 报 **0 error** —— 这就是这一组测试要挡住的静默失败。
  test('a partial override keeps every field it did not write (44-field record in, 44-field record out)', () => {
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    assert.equal(Object.keys(official).length, 44, 'the fixture is the shipped record');
    assert.equal(Object.keys(official.stats).length, 16);

    const patch = { stats: { maxHp: 12345 } };
    const { data, report } = applyWorkshop({ chess: { [officialId]: official } }, [
      { id: 'p', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: patch } } },
    ]);
    assert.deepEqual(report.errors, []);
    const got = data.chess[officialId];
    assert.equal(Object.keys(got).length, 44, 'no top-level field may be lost by a partial override');
    for (const k of Object.keys(official)) assert.ok(Object.hasOwn(got, k), `survived: ${k}`);
    assert.equal(Object.keys(got.stats).length, 16, 'the other stats survive too');
    assert.equal(got.stats.maxHp, 12345, 'and the one field the pack wrote is the pack\'s');
    assert.equal(got.stats.atk, official.stats.atk);
    assert.equal(got.tier, official.tier);
    assert.equal(got.skill, official.skill, 'a behaviour field the patch did not name is untouched');
    assert.equal(official.stats.maxHp === 12345, false, 'the official record on the way in is never mutated');
  });

  test('behaviour fields and bare arrays are replaced wholesale, by name; keyed lists merge on their key', () => {
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    const patch = { rangeGrid: [[0, 0]], skill: { index: 2 }, talents: [{ name: 'mine' }] };
    const { data } = applyWorkshop({ chess: { [officialId]: official } }, [
      { id: 'p', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: patch } } },
    ]);
    const got = data.chess[officialId];
    assert.deepEqual(got.rangeGrid, [[0, 0]], 'an array is replaced, never field-merged');
    assert.deepEqual(got.skill, { index: 2 }, 'a half-merged skill would be a record nobody wrote');
    // `talents` 是**键控列表**（按 `index` 合并）：补丁那一条没有可用的 `index` ⇒ 追加，官方的条目原样留下。
    // 2026-10-09 修正：整块替换会让作者改一个天赋就抹掉官方的整条潜能链（0.2.2 的 `potMin` / `potBelow`），
    // 而编辑器派生的记录按引擎约定本来就不带这些注解 ⇒ 那是一条**静默**的数据丢失。
    // 逐条覆盖见 test/overridePotential.test.js（含「改数值不丢 potDown」与「改文案不丢 potMin」）。
    assert.deepEqual(got.talents.slice(0, official.talents.length), official.talents,
      'the official talents stay, potential annotations and all');
    assert.deepEqual(got.talents.at(-1), { name: 'mine' }, 'an entry with no usable index is appended, not guessed at');
    assert.equal(got.stats.maxHp, official.stats.maxHp, 'and the untouched numeric map still comes from the official record');
    const keys = ['skill', 'skills', 'trait', 'traitBase', 'traitOverride', 'modules', 'rangeGrid', 'attackRangeGrid', 'assets', 'diy', 'bonds'];
    for (const k of keys) assert.ok(OVERRIDE_REPLACE_KEYS.includes(k), `${k} is a replace-type key`);
    assert.ok(!OVERRIDE_REPLACE_KEYS.includes('talents'),
      '`talents` now merges on its `index` — it must not be back in the wholesale list');
    assert.deepEqual(OVERRIDE_KEYED_LISTS, { talents: 'index', talentsBase: 'index' }, 'the keyed lists are exactly these');
  });

  test('an override is a closed world: a field the record does not have is refused, and nothing is applied', () => {
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    const { data, report } = applyWorkshop({ chess: { [officialId]: official } }, [
      { id: 'p', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: { stats: { maxHp: 1 }, nonsense: true } } } },
    ]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'UNKNOWN_OVERRIDE_FIELD');
    assert.match(report.errors[0].reason, /"nonsense"/);
    assert.equal(data.chess[officialId].stats.maxHp, official.stats.maxHp, 'the good half of the patch is not applied either');
    assert.deepEqual(report.overridden, {});
    // a NEW record has no official counterpart to be closed against: the per-record authoring layers own that check
    const fresh = applyWorkshop({ chess: {} }, [{ id: 'p', files: { chess: { chess_ws_fresh_a: { chessId: 'chess_ws_fresh_a', nonsense: true } } } }]);
    assert.deepEqual(fresh.report.errors, []);
    assert.equal(fresh.data.chess.chess_ws_fresh_a.nonsense, true);
  });

  test('the merge never mutates its input and reports readable counts', () => {
    const base = { chess: { a: { chessId: 'a' } } };
    const { data, report } = applyWorkshop(base, [{ id: 'p', name: 'P', files: { chess: { b: { chessId: 'b' } } } }]);
    assert.deepEqual(Object.keys(base.chess), ['a'], 'the input object must be left alone');
    assert.deepEqual(Object.keys(data.chess), ['a', 'b']);
    assert.deepEqual(report.added.chess, ['b']);
    assert.match(workshopSummary(report), /P\(p\): chess \+1/);
    assert.equal(workshopSummary(null), 'no workshop packs');
  });

  test('the format fails closed on a malformed pack or record', () => {
    assert.equal(normalizePackManifest({ id: 'a/b' }, 'a/b').error, 'BAD_PACK_ID');
    assert.equal(normalizePackManifest({ id: 'x' }, 'y').error, 'PACK_ID_MISMATCH');
    assert.equal(normalizePackManifest({ id: 'x', content: [] }, 'x').error, 'EMPTY_PACK');
    // `config` is deliberately not a workshop-contributable file
    assert.equal(WORKSHOP_CONTENT_FILES.includes('config'), false);
    assert.equal(normalizePackManifest({ id: 'x', content: ['config'] }, 'x').error, 'EMPTY_PACK');
    assert.equal(normalizeContentFile('chess', []).error, 'BAD_CONTENT');
    assert.equal(normalizeContentFile('chess', {}).error, 'EMPTY_CONTENT');
    assert.equal(normalizeContentFile('chess', { a: 'nope' }).error, 'BAD_RECORD');
    assert.equal(normalizeContentFile('chess', { 'not a valid id!': {} }).error, 'BAD_RECORD_ID');
    assert.equal(normalizeContentFile('chess', { a: { chessId: 'b' } }).error, 'ID_MISMATCH');
    assert.equal(normalizeContentFile('chess', { a: { chessId: 'a' } }).ok, true);
  });
});

describe('workshop: the content reaches the game', () => {
  let data;
  before(() => { data = loadData(DATA_DIR, { log: quiet, workshopDir: tmpWs }); });

  test('GameData treats it as an ordinary shop-eligible operator', () => {
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.visibleChess.includes(WS_BASE));
    assert.equal(gd.tierOf(WS_BASE), 5);
    assert.equal(gd.goldenIdOf(WS_BASE), WS_GOLD);
    assert.equal(gd.baseIdOf(WS_GOLD), WS_BASE);
    assert.equal(gd.chess(WS_BASE).stats.maxHp, WS_MAXHP);
    assert.notEqual(gd.chess(WS_BASE).stats.maxHp, gd.chess(SOURCE).stats.maxHp, 'the workshop numbers must be the pack\'s own');
  });

  test('the shared pool gives it copies like any tier-5 operator', () => {
    const pool = new SharedPool(new GameData(data, 'mode_multi_hard'), {});
    assert.equal(pool.has(WS_BASE), true);
    assert.equal(pool.cap(WS_BASE), 8);
    assert.equal(pool.left(WS_BASE), 8);
    assert.equal(pool.take(WS_BASE, 3), 3);
    assert.equal(pool.left(WS_BASE), 5);
    assert.equal(pool.give(WS_BASE, 3), 3);
    assert.equal(pool.left(WS_BASE), 8);
  });

  test('the sim resolves a def for it (this is what makes it fight)', async () => {
    const simdata = await import('../server/sim/simdata.js');
    const ds = simdata.toDataSource(data);
    const def = ds.getChess(WS_BASE);
    assert.ok(def, 'simdata could not build a def for the workshop operator');
    assert.match(JSON.stringify(def), new RegExp(String(WS_MAXHP)), 'the pack\'s maxHp did not reach the sim');
    assert.ok(ds.getChess(WS_GOLD), 'the workshop elite did not resolve');
  });

  test('a real battle runs with it deployed on the board', () => {
    const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 21, data });
    h.start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    assert.equal(h.m.pool.take(WS_BASE, 1), 1, 'the pool must offer it');
    const tile = legalTileFor(h.m, ps, WS_BASE);
    give(h.m, ps, WS_BASE, 'board', tile);
    assert.ok(tile, 'no legal tile was found for the workshop operator');
    assert.equal(ps.board.get(tile.join(','))?.id, WS_BASE);
    assert.ok(h.drive(() => h.m.round >= 2 || h.ended != null), `stuck at ${h.m.phase} R${h.m.round}`);
    assert.deepEqual(h.logs.error, []);
  });
});

describe('workshop: delivery to the browser over HTTP', () => {
  test('a touched data file is served merged; an untouched one comes from disk', async () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: tmpWs });
    const touched = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: tmpWs });
    try {
      const chess = await fetch(`${touched.url}/data/chess.json`).then((r) => r.json());
      assert.ok(chess[WS_BASE], 'the browser must receive the workshop operator');
      assert.equal(Object.keys(chess).length, 268);
      const support = await fetch(`${touched.url}/data/support.json`).then((r) => r.json());
      assert.deepEqual(support, JSON.parse(fs.readFileSync(join(DATA_DIR, 'support.json'), 'utf8')));
      // only the files a pack touches are mapped (the rest keep the plain static path)
      assert.deepEqual([...buildWorkshopDataFiles(data, loadWorkshop(tmpWs, { log: quiet })).keys()], ['chess']);
    } finally {
      await touched.close();
    }
  });

  test('with no pack installed the served data equals the files on disk', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: null });
    try {
      const chess = await fetch(`${srv.url}/data/chess.json`).then((r) => r.json());
      assert.deepEqual(chess, JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8')));
    } finally {
      await srv.close();
    }
  });
});
