// 行为开关 `prepLoadout`（DESIGN §28.43.1，投稿 `8b4e5da55c58`「休整期可更换技能和模组」）。
//
// 投稿把它做成了**安装器**（`files.json.copy` 整份覆盖 `shared/protocol.js`、`server/match/match/{intents,platform}.js`
// 与四个客户端文件，外加它自己的 `g.loadout` 意图）。本刀**不新增协议消息**：既有的 `room.loadout { entries, ops? }`
// 在比赛进行中本来就会走到 `Match.setLoadout`，唯一的闸门是**相位**。所以这一格只做一件事：让那一格开关决定
// 「休整期收不收」。
//
// 四件事在这里被钉住：
//   1. **缺省档（`locked`）与今天逐字相同**：`INFO_CHECK` 收、其余相位 `WRONG_PHASE`。
//   2. **`prep` 档只在 `PREP` 上多开一扇门**，而且**这个座位已经准备就绪时仍拒**。
//   3. **合并语义**：这一次提交只覆盖它写了的那些干员，没写的保留当前配发。
//   4. **协议面一个字节都不动**：`room.loadout` 的登记、lobby 的转发点都还在（源码级断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEHAVIOUR_SWITCHES, parseBehaviourDecl, behaviourActions, behaviourIsDefault, behaviourValue } from '../shared/behaviour.js';
import { LOADOUT_PHASES, loadoutPhasesFor, mergeLoadoutEntries } from '../server/match/match/platform.js';
import { PHASE, ERR } from '../shared/constants.js';
import { C2S, loadoutOptions } from '../shared/protocol.js';
import { makeMatch, DATA } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW = 'prepLoadout';
const declOf = (option) => parseBehaviourDecl([{ switch: SW, option }]).decl;

/** 一名真的能改技能的低阶干员（S1/S2，缺省 S2=1）+ 另一名。`checkLoadout` 会把「等于缺省」的条**丢掉**，
 *  所以测试里要挑**非缺省**的那一档（`loadoutOptions` 的 `defaultSkill` 是 1）。 */
const OP = 'chess_char_1_01_a';
const OP_SKILLS = DATA.chess[OP].skills.map((s) => s.index);
const NON_DEFAULT_SKILL = OP_SKILLS.find((i) => i !== loadoutOptions(DATA.chess[OP], DATA.chess[DATA.chess[OP].goldenId]).defaultSkill);
const OTHER = 'chess_char_1_02_a';

/** R1 的 prep（照 test/match/morph-bond.test.js 的作法）。 */
function prep(o = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, fake: true, seed: o.seed ?? 21 }).start();
  h.toPrep(1);
  return h;
}

// ---------------------------------------------------------------------------------------------------------------
test('真表里的那一格：形状、两档、缺省是引擎今天的行为', () => {
  const spec = BEHAVIOUR_SWITCHES[SW];
  assert.ok(spec, `真表里必须有这一格：${SW}`);
  assert.deepEqual([...spec.options], ['locked', 'prep']);
  assert.equal(spec.default, 'locked');
  assert.equal(behaviourIsDefault(null, SW), true, '没声明 = 今天的行为');
  for (const option of spec.options) {
    const decl = parseBehaviourDecl([{ switch: SW, option }]).decl;
    assert.equal(behaviourValue(decl, SW), option);
    assert.equal(behaviourIsDefault(decl, SW), option === 'locked');
  }
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'locked' }]).decl), { ok: true, actions: [] });
  assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: SW, option: 'prep' }]).decl),
    { ok: true, actions: [{ kind: 'loadout.allowDuringPrep', value: true }] });
});

test('`loadoutPhasesFor`：缺省 / `locked` ⇒ 只有 `INFO_CHECK`（逐字与从前那个相位判据相同）；`prep` ⇒ 另加 `PREP`', () => {
  assert.deepEqual([...LOADOUT_PHASES.locked], [PHASE.INFO_CHECK]);
  assert.deepEqual([...LOADOUT_PHASES.prep], [PHASE.INFO_CHECK, PHASE.PREP]);
  assert.deepEqual([...loadoutPhasesFor(null)], [PHASE.INFO_CHECK]);
  assert.deepEqual([...loadoutPhasesFor([])], [PHASE.INFO_CHECK]);
  assert.deepEqual([...loadoutPhasesFor(declOf('locked'))], [PHASE.INFO_CHECK]);
  assert.deepEqual([...loadoutPhasesFor(declOf('prep'))], [PHASE.INFO_CHECK, PHASE.PREP]);
});

test('`mergeLoadoutEntries`：只覆盖这次写了的干员；非对象条目原样交给 `PlayerState.setLoadout` 去拒', () => {
  const current = { a: { skill: 1, module: null }, b: { skill: 0, module: 'm1' } };
  // 只写 a ⇒ b 原样保留
  assert.deepEqual(mergeLoadoutEntries(current, { a: { skill: 0, module: null } }),
    { a: { skill: 0, module: null }, b: { skill: 0, module: 'm1' } });
  // 写没见过的干员 ⇒ 加上去
  assert.deepEqual(Object.keys(mergeLoadoutEntries(current, { c: { skill: 0 } })).sort(), ['a', 'b', 'c']);
  // 空提交 / null ⇒ 一份不改（返回的是**副本**，不是同一个对象）
  assert.deepEqual(mergeLoadoutEntries(current, {}), current);
  assert.deepEqual(mergeLoadoutEntries(null, null), {});
  assert.notEqual(mergeLoadoutEntries(current, null), current);
  // 坏形状不被这里吞掉：非法条目照旧进得去，由唯一那份判据（checkLoadout）去拒
  assert.deepEqual(mergeLoadoutEntries(current, { a: 'nope' }), current, '非对象条目不当成一次改写');
  assert.deepEqual(mergeLoadoutEntries(current, { a: [1] }), current, '数组也不算一条配发');
});

// ---------------------------------------------------------------------------------------------------------------
test('缺省档（`locked`）：`INFO_CHECK` 收，`PREP` 照旧 `WRONG_PHASE` —— 与今天逐字相同', () => {
  const h = prep();
  const { m } = h;
  assert.equal(m.phase, PHASE.PREP);
  assert.deepEqual(m.setLoadout('p_0', { [OP]: { skill: OP_SKILLS[0] } }),
    { error: ERR.WRONG_PHASE, detail: 'loadout locked for this match' }, '没声明这一格');
  m.behaviour = declOf('locked');
  assert.deepEqual(m.setLoadout('p_0', { [OP]: { skill: OP_SKILLS[0] } }),
    { error: ERR.WRONG_PHASE, detail: 'loadout locked for this match' }, '显式选了缺省档');
  assert.deepEqual(h.ps('p_0').loadout, {}, '拒掉的那次一个字节都没落地');
});

test('`prep` 档：休整期收、只覆盖写了的干员、准备就绪后仍拒', () => {
  const h = prep();
  const { m } = h;
  const ps = h.ps('p_0');
  m.behaviour = declOf('prep');
  const skill = NON_DEFAULT_SKILL;
  assert.deepEqual(m.setLoadout('p_0', { [OP]: { skill } }), { ok: true });
  assert.equal(ps.loadout[OP].skill, skill, '这名干员的技能真的改了');
  // 第二次只写另一名 ⇒ 第一名保留（**合并**，不是整份替换）
  assert.deepEqual(m.setLoadout('p_0', { [OTHER]: { skill: NON_DEFAULT_SKILL } }), { ok: true });
  assert.equal(ps.loadout[OP].skill, skill, '没写到的干员保留原值');
  assert.equal(ps.loadout[OTHER].skill, NON_DEFAULT_SKILL);
  // 这个座位准备就绪之后，休整期那扇门关上
  ps.ready = true;
  assert.deepEqual(m.setLoadout('p_0', { [OP]: { skill: OP_SKILLS.find((i) => i !== skill) } }),
    { error: ERR.WRONG_PHASE, detail: 'loadout locked for this match (this seat has readied up)' });
  assert.equal(ps.loadout[OP].skill, skill, '被拒的那次没有落地');
  ps.ready = false;
  // 非法输入照旧被那一份判据拒（技能序号越界 ⇒ 整份拒，配发不变）
  assert.deepEqual(m.setLoadout('p_0', { [OP]: { skill: 99 } }),
    { error: ERR.BAD_TARGET, detail: 'loadout does not match the game data' });
  assert.equal(ps.loadout[OP].skill, skill);
  h.invariants();
});

test('`prep` 档也不越过 `INFO_CHECK`：那个相位本来就收，且走的是**整份**替换那条老路', () => {
  const h = prep();
  const { m } = h;
  const ps = h.ps('p_0');
  m.behaviour = declOf('prep');
  m.phase = PHASE.INFO_CHECK;
  assert.deepEqual(m.setLoadout('p_0', { [OP]: { skill: NON_DEFAULT_SKILL } }), { ok: true });
  assert.equal(ps.loadout[OP].skill, NON_DEFAULT_SKILL);
  // INFO_CHECK 这一半**不看** `ps.ready`（今天也不看）：两个相位是两条独立的门
  ps.ready = true;
  assert.deepEqual(m.setLoadout('p_0', { [OTHER]: { skill: NON_DEFAULT_SKILL } }), { ok: true });
  assert.equal(ps.loadout[OTHER].skill, NON_DEFAULT_SKILL);
});

test('两个档位在别的相位上一律 `WRONG_PHASE`（`PREP` 是唯一被加进来的那一个）', () => {
  for (const option of ['locked', 'prep']) {
    const h = prep();
    h.m.behaviour = declOf(option);
    h.m.phase = PHASE.COMBAT;
    assert.equal(h.m.setLoadout('p_0', { [OP]: { skill: 0 } }).error, ERR.WRONG_PHASE, option);
    h.m.phase = PHASE.UNITE;
    assert.equal(h.m.setLoadout('p_0', { [OP]: { skill: 0 } }).error, ERR.WRONG_PHASE, option);
  }
});

// ---------------------------------------------------------------------------------------------------------------
test('协议面一个字节都不动：`room.loadout` 仍登记在 C2S，lobby 仍把它转给 `match.setLoadout`', () => {
  // 这一格**不新增**任何协议消息（投稿自己的 `g.loadout` 意图也不需要）—— 这一条把「不动契约面」钉住。
  assert.ok(Object.hasOwn(C2S, 'room.loadout'), 'room.loadout 必须仍在协议表里');
  assert.equal(Object.hasOwn(C2S, 'g.loadout'), false, '本引擎不因此新增 g.loadout 意图：room.loadout 本来就到得了比赛');
  const lobby = readFileSync(join(ROOT, 'server/lobby.js'), 'utf8');
  assert.match(lobby, /room\.match\.setLoadout\(session\.playerId, loadout, opsSet\)/,
    'lobby 的转发点必须还在（比赛进行中 room.loadout 就是走它到 Match 的）');
  // 相位判据只有一处：`Match.setLoadout`（lobby 只做数据校验，不自己判相位）。范围只取 `setLoadout` 那一段
  // —— `setSupport` 的 `!== INFO_CHECK` 是**另一格**（助战）的闸门，这一格不许动它。
  const platform = readFileSync(join(ROOT, 'server/match/match/platform.js'), 'utf8');
  const body = platform.slice(platform.indexOf('  setLoadout('), platform.indexOf('  setSupport('));
  assert.ok(body.length > 200, '必须真的切到 setLoadout 那一段');
  assert.match(body, /loadoutPhasesFor\(this\.behaviour\)/, '相位闸门必须读这一格的声明，而不是写死 INFO_CHECK');
  assert.equal(/phase\s*!==\s*PHASE\.INFO_CHECK/.test(body), false, 'setLoadout 里写死的相位判据必须已经被那格开关取代');
  assert.match(platform, /setSupport\(playerId, entries\) \{[\s\S]{0,200}PHASE\.INFO_CHECK/,
    '助战那一格的闸门**不动**（它不是这一格）');
});
