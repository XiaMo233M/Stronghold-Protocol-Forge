// 行为开关 `prepLoadout` 的**客户端半**（DESIGN §28.43.3，投稿 `8b4e5da55c58`「休整期可更换技能和模组」）。
//
// 服务端那一半第 8 刀第二格就落了（`Match.setLoadout` 读 `server/match/match/platform.js` 的 `LOADOUT_PHASES`：
// `locked`（缺省）只收 `INFO_CHECK`，`prep` 另收 `PREP`）。而客户端这一半原来**写死在**
// `public/js/screens/loadout.js` 的 `phase !== PHASE.INFO_CHECK && phase !== PHASE.LOBBY` 里 —— 于是在局中、
// 非 `INFO_CHECK` 一律算"锁定" ⇒ 声明了 `prep` 的房间会出现「**服务端收得下、界面却说"本局已锁定 · 下一局生效"**」
// 的自相矛盾。本刀把那份相位判据收成"一份两档的表 + 一个纯函数"，屏幕只读它。
//
// 三条钉法（第 8 刀客户端半的判据）：
//   (a) 单元：缺省档的相位表与写死之前**逐字相等**；
//   (b) 源码级：屏幕那一行**必须读那个函数**（并且**取反**），不许再写死 `PHASE.INFO_CHECK`；
//   (c) 行为级：**逐相位遍历**（真实的相位枚举），缺省档下新判据与旧表达式**同一个布尔**。
// 外加一条把**两张表钉在一起**的断言（客户端的 `LOADOUT_CLIENT_PHASES` ↔ 服务端的 `LOADOUT_PHASES`）——
// 客户端不能 import `server/**`（导入边界），所以这是这一层既有的"客户端副本 + 一个测试钉住"的做法。
//
// ⚠️ **这条测试自己踩过的坑（现在有断言防它）**：相位枚举曾经写成
// `Object.values(PHASE).filter((v) => typeof v === 'number')` —— 而 `PHASE` 的值**全是字符串**，那个过滤把整张
// 表滤成**空数组**，于是 (c) 那两条"逐相位遍历"变成空转，把一个**方向写反**的判据（徽标漏了取反 ⇒ 缺省档下
// 只在 `INFO_CHECK` 画）放了过去。现在枚举是 `Object.values(PHASE)`，并且每条遍历都先断言它够长、够全。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE } from '../shared/constants.js';
import { parseBehaviourDecl, behaviourIsDefault } from '../shared/behaviour.js';
import { LOADOUT_PHASES, loadoutPhasesFor } from '../server/match/match/platform.js';
import {
  LOADOUT_CLIENT_PHASES, loadoutLockPhases, currentLoadoutLockPhases,
  setPrepLoadout, prepLoadoutAllowed,
} from '../public/js/ui/loadoutSync.js';
import { shouldAutoClose } from '../public/js/screens/loadout.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const declOf = (option) => parseBehaviourDecl([{ switch: 'prepLoadout', option }]).decl;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 写死之前那一行里的旧判据（逐字抄下来，作为行为级的对照）。 */
const OLD_LOCKED = (inMatch, phase) => !!(inMatch && phase && phase !== PHASE.INFO_CHECK && phase !== PHASE.LOBBY);
/** 写死之前 `shouldAutoClose` 简报那一支的旧判据。 */
const OLD_AUTOCLOSE_BRIEFING = (phase) => !!(phase && phase !== PHASE.INFO_CHECK);

/** 引擎今天认定的**所有**相位（逐相位遍历用）。`PHASE` 的值全是字符串 —— 见文件头那条坑。 */
const ALL_PHASES = Object.values(PHASE);

/**
 * 屏幕那一行在某一档下的「锁定」判据（照抄 `screens/loadout.js` 的结构）。
 * ⚠️ 表列的是这一档"**收得下**"的相位 ⇒ 取反才是"锁定"。
 */
const LOCKED_AT = (option, phase, inMatch = true) =>
  !!(inMatch && phase && phase !== PHASE.LOBBY && !loadoutLockPhases(option).includes(phase));

/** 相位枚举本身的健全性：空了 / 缺了，下面那两条"逐相位"就白钉。 */
const assertPhaseEnum = () => {
  assert.deepEqual([...ALL_PHASES].sort(), Object.keys(PHASE).sort(), '枚举必须与 PHASE 的键一一对应');
  assert.ok(ALL_PHASES.length >= 10, `相位枚举只有 ${ALL_PHASES.length} 条 —— 逐相位遍历会空转`);
  assert.ok(ALL_PHASES.every((p) => typeof p === 'string'), 'PHASE 的值全是字符串');
  for (const p of [PHASE.LOBBY, PHASE.INFO_CHECK, PHASE.PREP, PHASE.COMBAT]) {
    assert.ok(ALL_PHASES.includes(p), `枚举里必须有 ${p}`);
  }
};

test('相位枚举本身：这张表不许再被过滤成空的（逐相位遍历的前提）', () => {
  assertPhaseEnum();
});

test('(a) 缺省档的相位表与写死之前**逐字相等**：就是 [INFO_CHECK]', () => {
  assertPhaseEnum();
  assert.deepEqual([...loadoutLockPhases(null)], [PHASE.INFO_CHECK]);
  assert.deepEqual([...loadoutLockPhases(undefined)], [PHASE.INFO_CHECK]);
  assert.deepEqual([...loadoutLockPhases('locked')], [PHASE.INFO_CHECK]);
  assert.deepEqual([...loadoutLockPhases('nonsense')], [PHASE.INFO_CHECK], '不认识的档位按缺省处理');
  assert.deepEqual([...loadoutLockPhases('prep')], [PHASE.INFO_CHECK, PHASE.PREP]);
  assert.deepEqual([...LOADOUT_CLIENT_PHASES.locked], [PHASE.INFO_CHECK]);
  assert.ok(Object.isFrozen(LOADOUT_CLIENT_PHASES) && Object.isFrozen(LOADOUT_CLIENT_PHASES.locked)
    && Object.isFrozen(LOADOUT_CLIENT_PHASES.prep), '两张表都冻结');
});

test('(a) 默认状态：没被喂过档位 ⇒ 就是缺省（不许"默认开"）', () => {
  setPrepLoadout(null);
  assert.equal(prepLoadoutAllowed(), false);
  assert.deepEqual([...currentLoadoutLockPhases()], [PHASE.INFO_CHECK]);
  setPrepLoadout('locked');
  assert.equal(prepLoadoutAllowed(), false);
  setPrepLoadout('prep');
  assert.equal(prepLoadoutAllowed(), true);
  assert.deepEqual([...currentLoadoutLockPhases()], [PHASE.INFO_CHECK, PHASE.PREP]);
  setPrepLoadout('nonsense');
  assert.equal(prepLoadoutAllowed(), false, '不认识的档位一律当缺省');
  setPrepLoadout(null);
});

test('方向：相位表列的是"**收得下**"的相位 ⇒ 徽标必须取反（写反了就在这里红）', () => {
  assertPhaseEnum();
  // 表里确实含 INFO_CHECK —— 所以"正读 includes"就是写反
  assert.equal(!!loadoutLockPhases('locked').includes(PHASE.INFO_CHECK), true, '缺省表里含 INFO_CHECK');
  assert.equal(LOCKED_AT('locked', PHASE.INFO_CHECK), false, '缺省：简报里改得了 ⇒ 不画「本局已锁定」');
  assert.equal(LOCKED_AT('locked', PHASE.PREP), true, '缺省：休整期改不了 ⇒ 画');
  assert.equal(LOCKED_AT('locked', PHASE.COMBAT), true);
  assert.equal(LOCKED_AT('locked', PHASE.LOBBY), false, 'LOBBY 那一半照旧不画');
  assert.equal(LOCKED_AT('locked', null), false, '没有相位就不画');
  // `prep` 档：休整期改得了 ⇒ 不画；别的相位一位不动
  assert.equal(LOCKED_AT('prep', PHASE.PREP), false, 'prep：休整期不画');
  assert.equal(LOCKED_AT('prep', PHASE.INFO_CHECK), false);
  assert.equal(LOCKED_AT('prep', PHASE.COMBAT), true, 'prep 只放开 PREP 一个');
  // 逐相位：`prep` 与缺省**只**在 PREP 上不同
  const differs = ALL_PHASES.filter((p) => LOCKED_AT('locked', p) !== LOCKED_AT('prep', p));
  assert.deepEqual(differs, [PHASE.PREP], '两档的差别只有 PREP');
});

test('(c) 行为级：**逐相位遍历**，缺省档下新判据与旧表达式同一个布尔', () => {
  assertPhaseEnum();
  let n = 0;
  for (const phase of [...ALL_PHASES, 0, '', null, undefined, 'NOPE']) {
    for (const inMatch of [true, false]) {
      const old = OLD_LOCKED(inMatch, phase);
      const now = LOCKED_AT('locked', phase, inMatch);
      assert.equal(now, old, `inMatch=${inMatch} phase=${phase}: ${now} !== ${old}`);
      n += 1;
    }
  }
  assert.ok(n >= 2 * (ALL_PHASES.length + 1), `遍历过的组合数 ${n} 太少（枚举又被滤空了？）`);
});

test('(c) 行为级：`prep` 档**只**放开 PREP 一个相位，别的相位一位不动', () => {
  assertPhaseEnum();
  const base = loadoutLockPhases('locked');
  const prep = loadoutLockPhases('prep');
  const opened = prep.filter((p) => !base.includes(p));
  const closed = base.filter((p) => !prep.includes(p));
  assert.deepEqual(opened, [PHASE.PREP], '只多出 PREP');
  assert.deepEqual(closed, [], '一个都没少');
  for (const phase of ALL_PHASES) {
    const lockedNow = LOCKED_AT('prep', phase);
    if (phase === PHASE.PREP) assert.equal(lockedNow, false, 'PREP 在 prep 档下不再算锁定');
    else assert.equal(lockedNow, OLD_LOCKED(true, phase), `phase=${phase} 与旧判据一致`);
  }
});

test('两张表钉在一起：客户端的 `LOADOUT_CLIENT_PHASES` ↔ 服务端的 `LOADOUT_PHASES`（逐档逐字相等）', () => {
  assert.deepEqual(Object.keys(LOADOUT_CLIENT_PHASES).sort(), Object.keys(LOADOUT_PHASES).sort());
  for (const option of Object.keys(LOADOUT_PHASES)) {
    assert.deepEqual([...loadoutLockPhases(option)], [...LOADOUT_PHASES[option]], `档位 ${option}`);
    // 服务端那个纯函数读的是"声明"，两档各喂一次
    assert.deepEqual([...loadoutPhasesFor(declOf(option))], [...LOADOUT_CLIENT_PHASES[option]], `loadoutPhasesFor(${option})`);
  }
  assert.deepEqual([...loadoutLockPhases(null)], [...loadoutPhasesFor(null)], '缺省档两边同判');
  assert.equal(behaviourIsDefault(null, 'prepLoadout'), true);
});

test('(b) 源码级：屏幕那一行**读那个函数**、**取反**，不许再写死 `PHASE.INFO_CHECK`', () => {
  const src = read('public/js/screens/loadout.js');
  assert.match(src, /const locked = \(inMatch && phase && phase !== PHASE\.LOBBY && !currentLoadoutLockPhases\(\)\.includes\(phase\)\) \|\| st\.sync === 'locked';/,
    '那一行必须读 currentLoadoutLockPhases() 并**取反**（表列的是"收得下"的相位）');
  assert.doesNotMatch(src, /&& currentLoadoutLockPhases\(\)\.includes\(phase\)/,
    '正读（漏了取反）那一种写法必须不存在 —— 它会让缺省档只在 INFO_CHECK 画徽标');
  assert.doesNotMatch(src, /phase !== PHASE\.INFO_CHECK && phase !== PHASE\.LOBBY/, '写死的旧判据必须消失');
  assert.doesNotMatch(src, /return !!phase && phase !== PHASE\.INFO_CHECK;/, 'shouldAutoClose 里那一处写死也必须消失');
  assert.match(src, /import \{[^}]*currentLoadoutLockPhases[^}]*\} from '\.\.\/ui\/loadoutSync\.js';/, '它从 loadoutSync 取');
  // `ownLocked`（干员持有 / 自选编队那两个 tab）是**局外设置**，与这一格无关 ⇒ 不动
  assert.match(src, /const ownLocked = inMatch && !!phase && phase !== PHASE\.LOBBY;/, 'ownLocked 原样保留');
});

test('(b) 源码级：`shouldAutoClose` 那一处写死也消失，改读同一份表（简报打开的面板不该在 PREP 被收走）', () => {
  const src = read('public/js/screens/loadout.js');
  assert.match(src, /if \(st\.from === 'briefing'\) return !!phase && !currentLoadoutLockPhases\(\)\.includes\(phase\);/,
    'shouldAutoClose 必须读同一份相位表');
  // 缺省档下与写死**逐相位等价**（旧：phase 不是 INFO_CHECK；新：[INFO_CHECK] 不含它）
  setPrepLoadout(null);
  assertPhaseEnum();
  let n = 0;
  for (const phase of [...ALL_PHASES, null, '', undefined]) {
    for (const inMatch of [true, false]) {
      for (const wasInMatch of [true, false]) {
        for (const from of ['briefing', 'lobby', 'room']) {
          const st = { open: true, from };
          const old = from === 'briefing' ? OLD_AUTOCLOSE_BRIEFING(phase) : !!(inMatch && !wasInMatch);
          assert.equal(shouldAutoClose(st, phase, inMatch, wasInMatch), old,
            `缺省档 ${from} phase=${phase} inMatch=${inMatch} wasInMatch=${wasInMatch}: 新判据必须与旧判据同判`);
          n += 1;
        }
      }
    }
  }
  assert.ok(n >= 6 * ALL_PHASES.length, `遍历过的组合数 ${n} 太少（枚举又被滤空了？）`);
  assert.equal(shouldAutoClose({ open: false, from: 'briefing' }, PHASE.PREP, true, true), false, '没开就不关');
});

test('(c) 行为级：`prep` 档下从简报打开的面板**在 PREP 里不被收走**（缺省档则照旧收走）', () => {
  const st = { open: true, from: 'briefing' };
  setPrepLoadout('locked');
  assert.equal(shouldAutoClose(st, PHASE.PREP, true, true), true, '缺省：进 PREP 就关（今天的行为）');
  setPrepLoadout('prep');
  assert.equal(shouldAutoClose(st, PHASE.PREP, true, true), false, 'prep 档：PREP 里留着');
  assert.equal(shouldAutoClose(st, PHASE.INFO_CHECK, true, false), false, '两个档下 INFO_CHECK 都留着');
  assert.equal(shouldAutoClose(st, PHASE.ROUND_START, true, true), true, '别的相位照旧关');
  assert.equal(shouldAutoClose(st, PHASE.UNITE, true, true), true);
  assert.equal(shouldAutoClose(st, PHASE.LOBBY, true, true), true, 'LOBBY 在简报那一支照旧关（与从前同判）');
  // 从大厅 / 房间打开的那一支**不受这一格影响**（对局一开始就收走，与档位无关）
  for (const option of ['locked', 'prep']) {
    setPrepLoadout(option);
    assert.equal(shouldAutoClose({ open: true, from: 'lobby' }, PHASE.PREP, true, false), true, `${option}: lobby 那一支不变`);
    assert.equal(shouldAutoClose({ open: true, from: 'room' }, PHASE.PREP, true, true), false, `${option}: 已在局中不重复关`);
  }
  setPrepLoadout(null);
});

test('接线：`roomMods.js` 从 `welcome.mods` 喂档位（与另外三格同一处、同一份合并规则）', () => {
  const src = read('public/js/roomMods.js');
  assert.match(src, /setPrepLoadout\(behaviourValue\(decl, 'prepLoadout'\)\)/, 'roomMods 派生这一格');
  assert.match(src, /mergeBehaviourDecls\(packs\)\.decl/, '仍然只有一份合并规则（不自己实现一遍）');
  assert.match(src, /from '\.\/ui\/loadoutSync\.js'/, '从 loadoutSync 取 setPrepLoadout');
});

test('客户端半**不新造发送链路**：编辑走既有的 `setEntries` + `room.loadout`', () => {
  const sync = read('public/js/ui/loadoutSync.js');
  assert.match(sync, /msgType: 'room\.loadout'/, '既有那一条消息还在（第二格服务端收的就是它）');
  assert.match(sync, /export function setEntries\(/, '编辑落点还是 setEntries');
  assert.match(sync, /key: \['entries', 'ops'\]/, '同步的 key 不变');
  const model = read('public/js/ui/loadoutModel.js');
  assert.match(model, /export function setChoice\(entries, base, golden, patch\)/, '单干员编辑的纯函数早就有了');
  // 客户端半**没有**新增任何 C2S 类型：g.loadout 不存在（第二格复用的是 room.loadout）
  const proto = read('shared/protocol.js');
  assert.doesNotMatch(proto, /'g\.loadout'/, '不新造 g.loadout');
});
