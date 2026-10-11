// test/form-projection.test.js — 干员形态投影（口径轴 `form`，DESIGN §28.41）。
//
// 投稿 `e4fe4d5cf0a0`（「干员满练mod」）的 `training` 一段真正想要的是「把普通干员投影成精锐形态」：258 条记录里
// 每条普通形态（`_a`）拿它精锐兄弟（`_b`）的 `status` / `stats` / `skill` / `skills` / `talents` / `module`。
// 引擎今天**到不了**那一档（`shared/potential.js:29-39` 的潜能 1–6 与练度 0–3 都改不了 `phase` / `equipLevel`，
// 也开不出精锐的技能 2 与模组天赋），所以这一条是**新的规则**、走**声明通道**、默认关。
//
// 本文件钉住的判据，按「缺省不变 → 真生效 → 一个数都不来自包 → 两边不许分叉」排：
//   1. **缺省 = 引擎今天的行为，且是对象身份意义上的**：不声明 `form` 时 `GameData.chess(id)` / `DataSource.rawChess(id)`
//      必须返回 `data/chess.json` 里**那个对象本身**（`===`）。对象身份是这一层最重要的一条承诺的影子：DataSource
//      的 def 缓存、`test/golden/*.json` 的摘要、`standIn` 的 memo 都按它成立。
//   2. **真生效**：`form: "elite"` ⇒ 普通干员拿到精锐的职能（`chess_char_1_01_a` 的 atk 422 → 531、skill.level 4 → 7、
//      `modules` 从无到有、`status` 变成 `_b` 的 `status`）。
//   3. **一个数都不来自包**（业主裁决 2026-10-13）：投影后的每一个数字都必须等于**引擎自己那条 `_b` 记录**里的
//      数字 —— 投稿自带的那套旧数值（`chess_char_1_01_a.atk = 497`）**一个都不许出现**。这条是本刀的立项理由。
//   4. **身份字段逐个不变**：投影只换**职能**（`shared/standIn.js` 的 `IDENTITY_FIELDS`），`tier` / `price` /
//      `sellPrice` / `bonds` / `rarity` / `position` / `charId` / `backup` / `upgradeNum` / `upgradeChessId` … 逐条不变。
//   5. **不许降级**：投影后每条记录的 `atk` / `maxHp` / `def` 必须 ≥ 投影前（投稿那套比引擎低，倒灌就是降级）。
//      干员与召唤物**都**过这道闸。这条是**数据 + 判据**的断言，不由运行期回调承担：投影是纯函数，缺省路径上
//      连一次比较都不做（多一次比较 = 缺省路径多一个分叉），所以这道闸的全部强度就在本文件里。
//   6. **召唤物同一个轴、同一套机制**：`data/tokens.json` 里 owner 变体有 `_a` / `_b` 一对的那 19 个召唤物，
//      `_a` 的 owner 变体换成 `_b` 的那一条。
//   7. **面板与战斗不许分叉**：同一份 data、两个房间（一个声明 `form: "elite"`、一个不声明）必须各拿各的
//      `DataSource`（`Match.js` 的 `dsCache` 缓存键并进了口径），且两边的 `_a` 数值**必须不同**。
//
// Run: node --test test/form-projection.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formView, projectElite, isEliteForm } from '../shared/formProjection.js';
import { IDENTITY_FIELDS } from '../shared/standIn.js';
import { parseVariantsDecl, mergeVariantDecls, variantValue } from '../shared/variants.js';
import { GameData } from '../server/match/gamedata.js';
import { DataSource } from '../server/sim/simdata.js';
import { makeMatch } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const load = (n) => JSON.parse(readFileSync(join(DATA_DIR, `${n}.json`), 'utf8'));
const CHESS = load('chess');
const TOKENS = load('tokens');
const DATA = { chess: CHESS, tokens: TOKENS };

/** The 口径 a pack pins: `mergeVariantDecls` of one pack entry (the lobby's own path). */
const declOf = (variants) => mergeVariantDecls([{ id: 'p', variants: parseVariantsDecl(variants).decl }]).decl;
const ELITE = declOf([{ axis: 'form', default: 'elite' }]);

/** 投稿自带的那些旧数值（干员满练mod 的 `training.chess`）——本刀**一个都不许**用。 */
const SUBMITTED = { chess_char_1_01_a: { skillLevel: 7, atk: 497, level: 55 } };

const NORMAL = Object.keys(CHESS).filter((id) => /_a$/.test(id) && !CHESS[id].isDiy);

// ---------------------------------------------------------------------------------------------------------------
describe('轴表：`form` 与 `training` / `deploy` 并列，默认是引擎今天的行为', () => {
  test('`form` 的选项是 official / elite，缺省 official（= 普通干员按普通形态出战）', () => {
    assert.equal(isEliteForm('elite'), true);
    assert.equal(isEliteForm('official'), false);
    assert.equal(isEliteForm(null), false);
    assert.equal(isEliteForm(undefined), false);
    assert.equal(variantValue(ELITE, 'form'), 'elite');
    assert.equal(variantValue(declOf([{ axis: 'form' }]), 'form'), 'official', '只声明轴 ⇒ 这个轴的缺省');
    assert.equal(variantValue(declOf([{ axis: 'deploy', default: 'max' }]), 'form'), null, '没声明这个轴 ⇒ null');
  });

  test('一条坏选项被点名拒（不是静默回落到缺省）', () => {
    const bad = parseVariantsDecl([{ axis: 'form', default: 'elite2' }]);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'VARIANTS_UNKNOWN_OPTION');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('缺省逐字节不变：`form` 不声明时返回**原对象本身**（`===`）', () => {
  test('`GameData.chess(id)` / `DataSource.rawChess(id)` 恒等，且 == data/chess.json 里那一条', () => {
    const gd = new GameData(DATA, 'mode_multi_hard');
    const ds = new DataSource(DATA, null);
    assert.equal(gd.eliteForm, false);
    for (const id of NORMAL) {
      assert.equal(gd.chess(id), CHESS[id], `${id}: GameData.chess 必须是同一个对象`);
      assert.equal(ds.rawChess(id), CHESS[id], `${id}: DataSource.rawChess 必须是同一个对象`);
    }
    // 精锐自己、自选槽、召唤物也一样（这一层不碰它们）
    for (const id of ['chess_char_1_01_b', 'chess_char_5_diy1_a']) {
      assert.equal(gd.chess(id), CHESS[id], `${id}: 非普通形态一条都不动`);
    }
    assert.equal(gd.token('token_10000_silent_healrb'), TOKENS.token_10000_silent_healrb);
  });

  test('视图在缺省时也是恒等的（`formView(..., false)`）', () => {
    const v = formView(CHESS, false, { tokens: TOKENS });
    assert.equal(v.eliteProjected, false);
    assert.equal(v.chess('chess_char_1_01_a'), CHESS.chess_char_1_01_a);
    assert.equal(v.token('token_10000_silent_healrb'), TOKENS.token_10000_silent_healrb);
  });

  test('声明 `official` 与「没声明」在数据上等价（对象身份也一样）', () => {
    const off = new GameData(DATA, 'mode_multi_hard', { variants: declOf([{ axis: 'form' }]) });
    assert.equal(off.eliteForm, false);
    assert.equal(off.chess('chess_char_1_01_a'), CHESS.chess_char_1_01_a);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('真生效：`form: "elite"` ⇒ 普通干员拿到精锐的战斗职能', () => {
  test('样例值逐条对上引擎自己的 `_b` 记录（不是投稿里的数）', () => {
    const gd = new GameData(DATA, 'mode_multi_hard', { variants: ELITE });
    for (const id of ['chess_char_1_01_a', 'chess_char_1_06_a', 'chess_char_2_11_a']) {
      const a = CHESS[id], b = CHESS[a.goldenId], got = gd.chess(id);
      assert.notEqual(got, a, `${id}: 声明了就必须是一份投影过的记录`);
      assert.notEqual(got, b, `${id}: 也不是精锐那一条本身（它有 _a 的身份）`);
      assert.equal(got.stats.atk, b.stats.atk, `${id}: atk 取引擎自己的 _b`);
      assert.equal(got.stats.maxHp, b.stats.maxHp, `${id}: maxHp 取引擎自己的 _b`);
      assert.equal(got.status.skillLevel, a.status.skillLevel, `${id}: status 整格留在 _a（见下一条）`);
      assert.equal(got.skill.level, b.skill.level, `${id}: skill.level 取 _b`);
      assert.deepEqual(got.talents, b.talents, `${id}: talents 取 _b`);
      assert.deepEqual(got.modules ?? null, b.modules ?? null, `${id}: modules 取 _b`);
      assert.equal(got.chessId, id, `${id}: 它仍然是自己那条 _a`);
      assert.equal(got.isGolden, false, `${id}: 投影不是「变成精锐」`);
    }
    // 引擎 `_b` 的 atk 就是 531（本文件据以立论的那个数），而投稿给的是 497
    assert.equal(CHESS.chess_char_1_01_a.stats.atk, 422);
    assert.equal(CHESS.chess_char_1_01_b.stats.atk, 531);
    assert.equal(SUBMITTED.chess_char_1_01_a.atk, 497);
    assert.equal(new GameData(DATA, 'mode_multi_hard', { variants: ELITE }).chess('chess_char_1_01_a').stats.atk, 531);
  });

  test('`DataSource.rawChess(id)` 看到的是同一份投影（不是原记录）', () => {
    const gd = new GameData(DATA, 'mode_multi_hard', { variants: ELITE });
    const v = formView(CHESS, true, { tokens: TOKENS });
    const ds = new DataSource(DATA, null, { forms: v });
    assert.notEqual(ds.rawChess('chess_char_1_01_a'), CHESS.chess_char_1_01_a);
    // 两个消费者读同一个 id 得到同一份数值（对象可以不同——两边各自 memo——**数值**必须一致）
    assert.deepEqual(ds.rawChess('chess_char_1_01_a').stats, gd.chess('chess_char_1_01_a').stats);
    assert.deepEqual(ds.rawChess('chess_char_1_01_a').skills, gd.chess('chess_char_1_01_a').skills);
  });

  test('同一份视图对同一条 id 给同一个对象（memo），且是冻结的', () => {
    const v = formView(CHESS, true, { tokens: TOKENS });
    const one = v.chess('chess_char_1_01_a');
    assert.equal(v.chess('chess_char_1_01_a'), one);
    assert.equal(Object.isFrozen(one), true);
    assert.equal(Object.isFrozen(CHESS.chess_char_1_01_a), false, '原记录一个字节都不许动');
  });

  test('没有精锐兄弟的记录投不了，也不假装投了（原样返回）', () => {
    const orphan = { chessId: 'chess_x_a', baseId: 'chess_x_a', goldenId: 'chess_x_b', isGolden: false, tier: 1, stats: { atk: 1 }, status: { phase: 1, level: 1, skillLevel: 1, equipLevel: 0 } };
    const v = formView({ chess_x_a: orphan }, true);
    assert.equal(v.chess('chess_x_a'), orphan, '`_b` 不在 ⇒ 原对象');
    // 精锐自己与自选槽也不动
    const g = { chessId: 'chess_x_b', baseId: 'chess_x_a', goldenId: 'chess_x_b', isGolden: true, tier: 1, stats: { atk: 2 }, status: { phase: 2, level: 60, skillLevel: 7, equipLevel: 1 } };
    const diy = { chessId: 'chess_char_5_diy1_a', baseId: 'chess_char_5_diy1_a', goldenId: 'chess_char_5_diy1_b', isGolden: false, isDiy: true, tier: 5, stats: { atk: 3 }, status: { phase: 1, level: 1, skillLevel: 1, equipLevel: 0 } };
    const v2 = formView({ chess_x_a: orphan, chess_x_b: g, chess_char_5_diy1_a: diy }, true);
    assert.equal(v2.chess('chess_x_b'), g, '精锐是 donor，不投影自己');
    assert.equal(v2.chess('chess_char_5_diy1_a'), diy, '自选槽有自己的一套状态，不投影');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('身份字段逐个不变（投影只换职能）', () => {
  test('`IDENTITY_FIELDS` 里凡 `_a` 有值的，投影后逐条相等', () => {
    const v = formView(CHESS, true, { tokens: TOKENS });
    const changed = [];
    for (const id of NORMAL) {
      const a = CHESS[id], b = CHESS[a.goldenId], got = v.chess(id);
      for (const k of IDENTITY_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
        const same = JSON.stringify(a[k]) === JSON.stringify(got[k]);
        if (!same) changed.push(`${id}.${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(got[k])}`);
      }
      // 身份的四个硬点单独点名，防止 `IDENTITY_FIELDS` 被改宽
      for (const k of ['tier', 'price', 'sellPrice', 'charId', 'bonds', 'rarity', 'position', 'backup', 'upgradeNum', 'upgradeChessId']) {
        assert.deepEqual(got[k], a[k], `${id}.${k}: 身份字段必须留在 _a 自己那一份`);
      }
      assert.equal(got.goldenId, b.chessId, `${id}.goldenId: 精锐兄弟仍然是它`);
      assert.equal(got.baseId, a.baseId ?? id, `${id}.baseId`);
    }
    assert.deepEqual(changed, [], '身份字段一条都不许被投影改掉');
  });

  test('`projectElite` 是纯函数：两个输入都不被改动', () => {
    const a = CHESS.chess_char_1_01_a, b = CHESS.chess_char_1_01_b;
    const aBefore = JSON.stringify(a), bBefore = JSON.stringify(b);
    const out = projectElite(a, b);
    assert.equal(JSON.stringify(a), aBefore, '`_a` 没被动');
    assert.equal(JSON.stringify(b), bBefore, '`_b` 没被动');
    assert.equal(out.chessId, a.chessId);
    assert.equal(out.stats.atk, b.stats.atk);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('一个数都不来自包：投稿自带的那套旧数值一个都不许出现', () => {
  test('`chess_char_1_01_a`：投影给 531（引擎 `_b`），不是投稿的 497', () => {
    const got = new GameData(DATA, 'mode_multi_hard', { variants: ELITE }).chess('chess_char_1_01_a');
    assert.equal(got.stats.atk, 531);
    assert.notEqual(got.stats.atk, SUBMITTED.chess_char_1_01_a.atk);
    assert.equal(got.skill.level, CHESS.chess_char_1_01_b.skill.level, '技能档位取 _b（7，不是 _a 的 4）');
  });

  test('`status` 整格留在 `_a`：它是**身份**，不是职能（`IDENTITY_FIELDS` 的一条）', () => {
    // 这一条是刻意的，也是审查过的一条：`shared/standIn.js:36-39` 用 `statusKey(status)` 去
    // `backups.units[charId].forms` 查表，`shared/standIn.js:64` 又从它读 `equipLevel`，`test/backups.test.js:209`
    // 逐字钉住 `_b` 的 `status` —— 把 `status` 挪到 `_b` 会连带改掉补位 / 技能档位 / 模组激活这三条既有语义。
    // 而且**数据本身就不允许**：「level 越大越强」不成立 —— 129 对里有 39 对的 `_b.level` **小于** `_a.level`
    // （例如这一对 `_a` 1/55 → `_b` 2/50），把它挪过去等于让那块地显示成「练度掉了」。
    // 战斗数值不靠它：`stats` / `skill` / `talents` / `modules` 是烘好的（上面几条已逐条对上 `_b`）。
    // 投稿自己也是这个口径：它对 `_a` 只写 `status.skillLevel = 7`（不改 `phase` / `level`）。
    const v = formView(CHESS, true, { tokens: TOKENS });
    const bad = [];
    let lower = 0;
    for (const id of NORMAL) {
      const a = CHESS[id], got = v.chess(id);
      if (JSON.stringify(got.status) !== JSON.stringify(a.status)) bad.push(`${id}.status: ${JSON.stringify(a.status)} → ${JSON.stringify(got.status)}`);
      if (CHESS[a.goldenId].status.level < a.status.level) lower++;
    }
    assert.deepEqual(bad, [], 'status 整格必须留在 _a 那一份');
    // 现场数：39 对里 `_b.level` 比 `_a.level` **低** —— 这条现场数就是「不能照搬 `_b` 的 status」的依据本身。
    // 作者的意图仍然达成了：`_a.skills[]` 里每条的 `level` 与 `_a.skill.level` 跟着精锐走（第 2 条已断言），
    // 也就是投稿对 `_a` 写的 `status.skillLevel = 7` 那件事，在这里由**技能记录自己**表达（引擎里 skillLevel 与
    // `skills[].level` 恒等：`data.test.js:453` 逐条钉住）。`status` 是那块地的**名义练度标牌**，不是战斗数值。
    assert.equal(lower, 39);
  });

  test('**不许降级**：投影后 atk / maxHp / def 每条都 ≥ 投影前（干员）', () => {
    const v = formView(CHESS, true, { tokens: TOKENS });
    const bad = [];
    for (const id of NORMAL) {
      const a = CHESS[id], got = v.chess(id);
      for (const k of ['atk', 'maxHp', 'def']) {
        if (a.stats[k] > got.stats[k]) bad.push(`${id}.${k}: ${a.stats[k]} → ${got.stats[k]}`);
      }
    }
    assert.deepEqual(bad, [], '投影不许把任何一条记录往下调');
  });

  test('**不许降级**：同一个视图里的**召唤物**也逐条过闸', () => {
    const v = formView(CHESS, true, { tokens: TOKENS });
    let checked = 0;
    const bad = [];
    for (const [id, rec] of Object.entries(TOKENS)) {
      const variants = rec.variants;
      if (!variants) continue;
      for (const owner of Object.keys(variants)) {
        if (!/_a$/.test(owner)) continue;
        const golden = `${owner.slice(0, -2)}_b`;
        if (!variants[golden]) continue;
        checked++;
        const got = v.token(id).variants[owner];
        assert.notEqual(got, variants[owner], `${id}[${owner}]: 必须是精锐那一条`);
        for (const k of ['atk', 'maxHp', 'def']) {
          const before = variants[owner].stats?.[k], after = got.stats?.[k];
          if (typeof before === 'number' && typeof after === 'number' && before > after) bad.push(`${id}[${owner}].${k}: ${before} → ${after}`);
        }
        // 注意**不**对 `level` 过闸：owner 变体上的 `level` 是那个形态的**名义练度标牌**（和 `status.level` 同一类），
        // 129 对里有 39 对的 `_b.level` 比 `_a.level` 低 ⇒ 拿它当「降级」判据是**假阳性**。业主那道闸说的是
        // `atk` / `maxHp` / `def`。真正会骗人的是这三个数，它们已逐条断言在上面。
      }
    }
    assert.deepEqual(bad, []);
    // 现场数：19 个召唤物有 `_a` / `_b` 一对 owner 变体（投稿 `training.tokens` 那 19 个）
    assert.equal(checked, 19);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('召唤物：同一个轴、同一套机制', () => {
  test('`DataSource.getToken` 的 owner 变体在声明后换成精锐那一条', () => {
    const plainDs = new DataSource(DATA, null);
    const eliteDs = new DataSource(DATA, null, { forms: formView(CHESS, true, { tokens: TOKENS }) });
    const tid = 'token_10000_silent_healrb';
    const owner = 'chess_char_2_02_a';
    const golden = CHESS[owner].goldenId;
    assert.ok(TOKENS[tid].variants[owner] && TOKENS[tid].variants[golden], '这一条要有 _a / _b 一对 owner 变体');
    const before = plainDs.getToken(tid, owner, null);
    const after = eliteDs.getToken(tid, owner, null);
    assert.equal(before.stats.atk, TOKENS[tid].variants[owner].stats.atk, '缺省：还是 `_a` 那一条');
    assert.equal(after.stats.atk, TOKENS[tid].variants[golden].stats.atk, '声明后：`_b` 那一条');
    assert.notEqual(before.stats.atk, after.stats.atk, '这一对的 atk 本来就不同（8 升 / 11 平）');
  });

  test('精锐 owner 自己不变；`_b` 变体不在时原样（不假装投了）', () => {
    const eliteDs = new DataSource(DATA, null, { forms: formView(CHESS, true, { tokens: TOKENS }) });
    const tid = 'token_10000_silent_healrb';
    const golden = CHESS.chess_char_2_02_a.goldenId;
    assert.equal(eliteDs.getToken(tid, golden, null).stats.atk, TOKENS[tid].variants[golden].stats.atk);
    // 一个只有 `_a` 变体的 lab 记录：原样
    const lone = { tokenId: 'token_lab', variants: { chess_lab_a: { stats: { atk: 7 } } } };
    const ds = new DataSource({ chess: {}, tokens: { token_lab: lone } }, null, { forms: formView({}, true, { tokens: { token_lab: lone } }) });
    const got = ds.getToken('token_lab', 'chess_lab_a', null);
    assert.equal(got.stats.atk, 7);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('面板与战斗不许分叉（`Match.js` 的 `dsCache` 缓存键并进了口径）', () => {
  const ELITE_MODS = {
    digest: 'mods-elite',
    packs: [{ id: 'p', hash: 'h', layer: 'content', combat: true, api: null, variants: parseVariantsDecl([{ axis: 'form', default: 'elite' }]).decl }],
  };
  const PLAIN_MODS = {
    digest: 'mods-plain',
    packs: [{ id: 'q', hash: 'h', layer: 'content', combat: true, api: null }],
  };

  test('同一份 data 的两个房间各拿各的 `DataSource`（一个 elite 一个不声明）', () => {
    // `makeMatch` 默认用模块级的 `DATA`（同一个对象）⇒ 正是「同一份 data 两个房间」那个形状。
    const elite = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 3, fake: true, mods: ELITE_MODS });
    const plain = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 3, fake: true, mods: PLAIN_MODS });
    assert.equal(elite.m.eliteForm, true);
    assert.equal(plain.m.eliteForm, false);
    assert.notEqual(elite.m.ds, plain.m.ds, '两个口径必须各拿各的 DataSource —— 共用就是分叉');
    // 两个房间对**同一条 `_a`** 的数值必须不同（这就是那条会被抓到的红）
    const a = elite.m.ds.rawChess('chess_char_1_01_a').stats.atk;
    const b = plain.m.ds.rawChess('chess_char_1_01_a').stats.atk;
    assert.equal(a, CHESS.chess_char_1_01_b.stats.atk);
    assert.equal(b, CHESS.chess_char_1_01_a.stats.atk);
    assert.notEqual(a, b);
  });

  test('同一份 data 的两个**同口径**房间共用一份（缓存仍然生效，不是每次新建）', () => {
    const one = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 4, fake: true, mods: ELITE_MODS });
    const two = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 5, fake: true, mods: ELITE_MODS });
    assert.equal(one.m.ds, two.m.ds);
    const p1 = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 6, fake: true });
    const p2 = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 7, fake: true });
    assert.equal(p1.m.ds, p2.m.ds);
  });

  test('`Match` 的 `GameData` 与 `DataSource` 是同一份视图（数值一致、口径一致）', () => {
    const h = makeMatch({ mode: 'solo', humans: 1, bots: 0, seed: 8, fake: true, mods: ELITE_MODS });
    assert.equal(h.m.gd.eliteForm, true);
    assert.equal(h.m.gd.formView, h.m.formView, 'GameData 拿到的必须是 `Match` 建的那一份');
    const fromGd = h.m.gd.chess('chess_char_1_06_a');
    const fromDs = h.m.ds.rawChess('chess_char_1_06_a');
    assert.deepEqual(fromGd.stats, fromDs.stats);
    assert.deepEqual(fromGd.skills, fromDs.skills);
    assert.deepEqual(fromGd.talents, fromDs.talents);
  });
});
