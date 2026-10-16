// test/packBehaviour.test.js — 行为开关层（DESIGN §28.43）：`pack.json.behaviour` + 表 `shared/behaviour.js`。
//
// 这一刀要消掉的那面墙：一份真实投稿（`ac8c9821f5ba`）把「改一条规则」做成了**安装器** —— `install.mjs` 整份
// 覆盖 `data/*.json`、`server/sim/**` 与整屏 UI（它的 `files.json` 自述「a target that gets the whole file gets
// the whole feature」）。本刀不把它搬进引擎，而是开一条**受约束的声明通道**：包只说「哪一格开关、哪一档」，
// 动作由引擎构造。所以本文件钉住的判据按「响亮失败 → 缺省不变 → 真生效」三层排，与 `test/workshopVariants.test.js`
// （第 1 刀的口径层）逐字同构 —— 两张表是同一个形状，两份测试也读起来是同一套东西。
//
// **本刀那张表是空的**（业主裁决：交付物＝通道 + 守卫本身，首格与它的引擎实现点一起落）。所以这里有两类证据：
//   * **真表路径**（生产路径）：不声明 `behaviour` ⇒ 归一化清单里**不得**多出这个键；而任何一条声明都被
//     `BEHAVIOUR_UNKNOWN_SWITCH` **点名整包拒** —— 「通道真的通、且响」就是这一条（空表不是「一律忽略」）。
//   * **合成表路径**：其余四条拒绝码、「写了才进清单」、进身份哈希、`BEHAVIOUR_NEEDS_COMBAT` 这几条分支，在空表下
//     生产路径**不可能**走到。判据写成「表是入参」的纯函数（`parseBehaviourDecl(raw, table)`，与
//     `surfaceLedgerIssues(ids, generation)` 同一条理由）正是为了让它们今天就被逐条走一遍 —— 一条只在今天的
//     数据上成立、从来没验过失败分支的守卫，和没有守卫是一回事。
//
// Run: node --test test/packBehaviour.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, PACK_FIELDS, WORKSHOP_CONTENT_FILES } from '../shared/workshop.js';
import {
  BEHAVIOUR_SWITCHES, BEHAVIOUR_SWITCH_NAMES, isBehaviourSwitch, isBehaviourOption, parseBehaviourDecl,
  behaviourValue, behaviourIsDefault, behaviourSwitchIssues, behaviourActions, mergeBehaviourDecls,
} from '../shared/behaviour.js';
import { modSetOf } from '../shared/modIdentity.js';
import { identifyPack } from '../server/workshop.js';
import { VARIANT_AXES, VARIANT_AXIS_NAMES } from '../shared/variants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 一份**合成的**表：它证明的是「这张表的形状是对的、判据把它当入参读」，**不是**本版有这一格开关。
 * 生产路径永远只读真的那一份（`BEHAVIOUR_SWITCHES`，空表）。形状照 `VARIANT_AXES` 逐字来（中文 label /
 * 中文 optionLabels / 英文 effect），额外多一个 `actions`（引擎构造的动作）。
 */
const SYNTH = Object.freeze({
  shopBias: {
    label: '商店出货偏向',
    options: Object.freeze(['official', 'highestBond']),
    default: 'official',
    optionLabels: Object.freeze({ official: '官方出货（不看盟约）', highestBond: '偏向叠得最高的盟约（不授予它）' }),
    effect: Object.freeze({
      official: 'the official shop draw: each slot draws uniformly from the remaining pool copies',
      highestBond: 'the shop draw is biased towards the 盟约 this player has stacked highest, and does NOT grant it',
    }),
    actions: (option) => (option === 'official' ? [] : [{ kind: 'shop.biasHighestBond', value: true }]),
  },
});

/** 一份**合法贡献**的底盘（行为开关不是贡献项，所以一个只带 `behaviour` 的包照旧 `EMPTY_PACK`）。 */
const mk = (extra = {}, opts = {}) => normalizePackManifest({
  id: 'p', name: 'p', content: [], operators: { char_x: { powers: [], bonds: [] } }, ...extra,
}, 'p', opts);
/** 一份声明了开关的合法包（`combat: true` 是第五条硬闸门，见下）。 */
const mkBehaviour = (behaviour, extra = {}) => mk({ combat: true, behaviour, ...extra }, { behaviourSwitches: SYNTH });

let tmp;
before(() => { tmp = fs.mkdtempSync(join(tmpdir(), 'sp-behaviour-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ } });

// ---------------------------------------------------------------------------------------------------------------
describe('表：闭枚举，一格开关只有一个值', () => {
  test('**真表里每一格都实现好了**（通道 + 守卫之后的第一批格）：逐格形状守卫为 `[]`', () => {
    // 第 4 刀（0.16.0）交的是**通道 + 守卫**本身，那一版的断言是「本版一个开关都没有」
    // （`assert.deepEqual(Object.keys(BEHAVIOUR_SWITCHES), [])`）。第 8 刀按业主裁决**逐格加开关**：
    // 每一格都带**引擎侧实现点**才准进表，所以这一条换成同一件事的**当代表达** ——
    // 「表里每一格都通过形状守卫、每一个都能被解析、真表以外一个都不认」。
    // **没有放松**：整份表的完整性仍被要求（`behaviourSwitchIssues` 逐格为 `[]`），而且比空表那一版多钉了
    // 「每一格至少两档 + 有非缺省档」——一个只有缺省档的开关等于没有开关。
    const names = Object.keys(BEHAVIOUR_SWITCHES);
    assert.ok(names.length >= 1, '第 8 刀之后真表里至少有一格实现好的开关');
    assert.deepEqual([...BEHAVIOUR_SWITCH_NAMES], names, '名字清单与表逐字同序');
    assert.deepEqual(behaviourSwitchIssues(BEHAVIOUR_SWITCHES), [], '真表自己必须对得上（逐格）');
    for (const name of names) {
      assert.equal(isBehaviourSwitch(name), true);
      const spec = BEHAVIOUR_SWITCHES[name];
      assert.ok(spec.options.length >= 2, `${name}：一格开关至少两档（缺省那一档 + 至少一个非缺省档）`);
      assert.ok(spec.options.includes(spec.default), `${name}：缺省必须在 options 里`);
      assert.ok(spec.options.some((o) => o !== spec.default), `${name}：必须有一个非缺省档`);
      for (const o of spec.options) assert.equal(isBehaviourOption(name, o), true, `${name} 的选项 ${o}`);
      assert.equal(isBehaviourOption(name, 'nope'), false, `${name}：这一格以外的选项名不认`);
    }
    // 空表是**合法**的（那正是第 4 刀那一版），所以「一片空白」与「表自己烂了」必须分得开
    assert.deepEqual(behaviourSwitchIssues({}), []);
  });

  test('形状守卫的**失败分支**自己也被测：一格少任何一件都当场报出来', () => {
    // 只验「今天的表是好的」的守卫，和没有守卫是一回事（`shared/modSurface.js` 的 `surfaceLedgerIssues` 同一条）。
    const full = SYNTH.shopBias;
    assert.deepEqual(behaviourSwitchIssues({ shopBias: full }), [], '合成的表本身必须是一份合格的表');
    const drop = (key) => {
      const copy = { ...full };
      delete copy[key];
      return behaviourSwitchIssues({ shopBias: copy });
    };
    for (const key of ['label', 'options', 'optionLabels', 'effect', 'actions']) {
      const issues = drop(key);
      assert.ok(issues.length > 0, `少了 ${key} 必须报出来`);
      assert.ok(issues.some((s) => s.includes(key)), `报的那一条必须点名 ${key}`);
    }
    // 缺省不在 options 里 = 悄悄改默认游戏行为；选项缺 effect / optionLabels = 编辑器与错误文案给作者一个空缺
    assert.match(behaviourSwitchIssues({ x: { ...full, default: 'nope' } })[0], /default/);
    assert.ok(behaviourSwitchIssues({ x: { ...full, effect: {} } }).some((s) => s.includes('effect')));
    assert.ok(behaviourSwitchIssues({ x: { ...full, optionLabels: {} } }).some((s) => s.includes('optionLabels')));
    assert.ok(behaviourSwitchIssues({ x: { ...full, options: [] } }).some((s) => s.includes('options')));
    assert.ok(behaviourSwitchIssues({ x: null }).length > 0);
  });

  test('合成的表按同一个形状登记（将来加格按这条形状加，不许改既有格的语义）', () => {
    for (const [name, spec] of Object.entries(SYNTH)) {
      assert.equal(typeof spec.label, 'string', `${name}.label`);
      assert.ok(spec.options.length >= 2, `${name}.options 至少两个选项`);
      assert.ok(spec.options.includes(spec.default), `${name}.default 必须在 options 里`);
      for (const o of spec.options) {
        assert.equal(typeof spec.optionLabels[o], 'string', `${name}.optionLabels["${o}"]`);
        assert.equal(typeof spec.effect[o], 'string', `${name}.effect["${o}"]`);
      }
      assert.equal(typeof spec.actions, 'function', `${name}.actions —— 一格的执行点`);
    }
  });

  test('`behaviour` 是顶层键闭集的一员，且**不**在 content 白名单里（开关不是数据文件）', () => {
    assert.ok(PACK_FIELDS.includes('behaviour'));
    assert.equal(PACK_FIELDS[PACK_FIELDS.indexOf('variants') + 1], 'behaviour',
      '新格紧挨着口径那一格：两张表逐字同形，读起来是同一套东西');
    // 38 = 36 + `callBudget`（§28.52，沙箱档的每局每插件调用预算：`{ max? }`，只许收紧不许放宽）+ `matchKinds`
    // （§28.54，第二种对局的声明面）。`callBudget` 不是行为开关那一族（那一族改的是引擎里已有的某条规则），
    // 而是一条**上限**声明，所以它不挨着 `behaviour`。
    assert.equal(PACK_FIELDS.length, 38, '顶层键是闭集：加一格必须就地延长这个计数，不许放松它');
    // ⚠️ 只钉总数是不够的：两条独立的线各自加过一格，数字**碰巧都是 37**、加的却**不是同一格**
    // （我们加 `callBudget`，吸收进来的下游加 `matchKinds`）。这种「数字相同但不是同一格」一旦按数字
    // 取一边，就会**静默丢格**、而总数断言照样是绿的。所以这里逐格点名：并线之后两格都必须还在。
    assert.ok(PACK_FIELDS.includes('callBudget'),
      '调用预算那格（§28.52）不能被并线时的「数字一样取一边」丢掉');
    assert.ok(PACK_FIELDS.includes('matchKinds'),
      '对局种类声明那格（§28.54）同样不能被丢掉 —— 它与 callBudget 是两条线各自加的，不是同一格');
    assert.equal(WORKSHOP_CONTENT_FILES.includes('behaviour'), false,
      '行为开关走 pack.json.behaviour；把它当数据文件就是开一条「包可以覆盖任意数值 / 任意文件」的通道');
    // 第 1 刀的口径表**一字不动**（它已随 v0.15.3 发布）
    assert.deepEqual([...VARIANT_AXIS_NAMES].sort(), ['deploy', 'form', 'training']);
    assert.deepEqual(VARIANT_AXES.deploy.options, ['official', 'max']);
  });

  test('只声明开关不写 option ⇒ 用这一格的缺省；写了就照写（缺省选项也如实写出来）', () => {
    const a = parseBehaviourDecl([{ switch: 'shopBias' }], SYNTH);
    assert.equal(a.ok, true, a.detail);
    assert.deepEqual(a.decl, [{ switch: 'shopBias', option: 'official', name: null, desc: null }]);
    const b = parseBehaviourDecl([{ switch: 'shopBias', option: 'official' }], SYNTH);
    assert.equal(b.ok, true, b.detail);
    assert.equal(b.decl[0].option, 'official', '「选了缺省」与「没声明」在数据上等价，但作者写了什么就回什么');
  });

  test('归一化结果按**开关名排序**（键序是清单字节的一部分，不许随书写顺序变）', () => {
    const two = { ...SYNTH, zLast: { ...SYNTH.shopBias } };
    const r = parseBehaviourDecl([{ switch: 'zLast' }, { switch: 'shopBias' }], two);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.decl.map((e) => e.switch), ['shopBias', 'zLast']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('拒绝路径逐条：每个码点名，绝不静默丢', () => {
  test('形状层（`shared/behaviour.js`）：五个码逐个被合成表走到', () => {
    const cases = [
      [{}, 'BEHAVIOUR_BAD_SHAPE'],                                            // 不是数组
      [[], 'BEHAVIOUR_BAD_SHAPE'],                                            // 空数组 = 一条什么都不做的声明
      [['shopBias'], 'BEHAVIOUR_BAD_SHAPE'],                                  // 数组里放字符串
      [[{ switch: '' }], 'BEHAVIOUR_BAD_SHAPE'],                              // switch 空串
      [[{ switch: 7 }], 'BEHAVIOUR_BAD_SHAPE'],                               // switch 不是字符串
      [[{ switch: 'shopBias', nope: 1 }], 'BEHAVIOUR_BAD_SHAPE'],             // 未知字段（闭合世界）
      [[{ switch: 'shopBias', name: '' }], 'BEHAVIOUR_BAD_SHAPE'],            // name 写空
      [[{ switch: 'shopBias', name: 'x'.repeat(41) }], 'BEHAVIOUR_BAD_SHAPE'],// name 过长
      [[{ switch: 'shopBias', desc: 5 }], 'BEHAVIOUR_BAD_SHAPE'],             // desc 类型不对
      [[{ switch: 'nope' }], 'BEHAVIOUR_UNKNOWN_SWITCH'],
      [[{ switch: 'shopBias', option: 'lots' }], 'BEHAVIOUR_UNKNOWN_OPTION'],
      [[{ switch: 'shopBias', option: 12 }], 'BEHAVIOUR_BAD_OPTION'],         // 非字符串 option
      [[{ switch: 'shopBias', option: null }], 'BEHAVIOUR_BAD_OPTION'],
      [[{ switch: 'shopBias', option: false }], 'BEHAVIOUR_BAD_OPTION'],
      [[{ switch: 'shopBias' }, { switch: 'shopBias' }], 'BEHAVIOUR_DUPLICATE_SWITCH'],
    ];
    for (const [behaviour, code] of cases) {
      const r = parseBehaviourDecl(behaviour, SYNTH);
      assert.equal(r.ok, false, `${code} 应当被拒：${JSON.stringify(behaviour)}`);
      assert.equal(r.error, code, `期望 ${code}，实际 ${r.error} / ${r.detail}`);
      assert.ok(r.detail.length > 0, '拒绝必须带一句人能读的理由');
      // 拒绝码自己必须在文案里点名（作者从错误里要能看出该写哪个）
      if (code === 'BEHAVIOUR_UNKNOWN_SWITCH') assert.match(r.detail, /"shopBias"/);
      if (code === 'BEHAVIOUR_UNKNOWN_OPTION') assert.match(r.detail, /"official"/);
      if (code === 'BEHAVIOUR_DUPLICATE_SWITCH') assert.match(r.detail, /shopBias/);
    }
  });

  test('`pack.json.behaviour` 的形状层接进整包校验（同一份判据，不出现第二份实现）', () => {
    assert.equal(mk({ behaviour: 'shopBias' }, { behaviourSwitches: SYNTH }).error, 'BEHAVIOUR_BAD_SHAPE');
    assert.equal(mk({ behaviour: [{ switch: 'nope' }] }, { behaviourSwitches: SYNTH }).error, 'BEHAVIOUR_UNKNOWN_SWITCH');
    assert.equal(mkBehaviour([{ switch: 'shopBias', option: 'lots' }]).error, 'BEHAVIOUR_UNKNOWN_OPTION');
    assert.equal(mkBehaviour([{ switch: 'shopBias', option: 12 }]).error, 'BEHAVIOUR_BAD_OPTION');
    assert.equal(mkBehaviour([{ switch: 'shopBias' }, { switch: 'shopBias' }]).error, 'BEHAVIOUR_DUPLICATE_SWITCH');
  });

  test('**越权写入被拒**（红线逐条）：这一层永远不是一条「改文件 / 给数值」的通道', () => {
    // 这几条形状**就是安装器**（`ac8c9821f5ba` 的 `install.mjs` + `files.json`）：一个包想指名道姓地改哪个文件、
    // 改哪个键、改成几 —— 全部在形状层死掉，并且理由里说清「这一层只收开关名与选项名」。
    const forbidden = [
      { switch: 'shopBias', module: 'ui/x.mjs' },
      { switch: 'shopBias', entry: 'server/rules.mjs' },
      { switch: 'shopBias', file: 'data/config.json' },
      { switch: 'shopBias', path: '../server/sim/damage.js' },
      { switch: 'shopBias', value: 12 },
      { switch: 'shopBias', key: 'economy.deployCap' },
      { switch: 'shopBias', $del: ['official'] },
      { switch: 'shopBias', assets: 'assets/container.zip' },
    ];
    for (const entry of forbidden) {
      const r = parseBehaviourDecl([entry], SYNTH);
      assert.equal(r.ok, false, `不许放行：${JSON.stringify(entry)}`);
      assert.equal(r.error, 'BEHAVIOUR_BAD_SHAPE');
      assert.match(r.detail, /never carries a module, a file, a path or a number/);
    }
    // 而一个包**永远**给不出动作里的那个值：`actions` 由表（＝引擎）构造，包只能选选项名。
    assert.deepEqual(behaviourActions([{ switch: 'shopBias', option: 'highestBond' }], SYNTH),
      { ok: true, actions: [{ kind: 'shop.biasHighestBond', value: true }] });
    assert.deepEqual(behaviourActions([{ switch: 'shopBias', option: 'official' }], SYNTH), { ok: true, actions: [] });
    // 未经归一化的声明（开关名不在表里）在执行点也照旧点名拒 —— 判据只有一份，执行点不假设调用方归一化过
    const bad = behaviourActions([{ switch: 'nope' }], SYNTH);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'BEHAVIOUR_UNKNOWN_SWITCH');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('第五条 `combat` 硬闸门 + `EMPTY_PACK` 的次序', () => {
  test('声明了开关却不标 `combat: true` ⇒ `BEHAVIOUR_NEEDS_COMBAT`', () => {
    // 一格的入场券本就是「它改一条规则」⇒ 必须进房间摘要闸门与 golden 语料（与 `server.meta` / `server.battle` /
    // `modules[].uses: ["matchClass"]` / `variants` 四条同一条线）。
    const needs = mk({ behaviour: [{ switch: 'shopBias' }] }, { behaviourSwitches: SYNTH });
    assert.equal(needs.ok, false, JSON.stringify(needs));
    assert.equal(needs.error, 'BEHAVIOUR_NEEDS_COMBAT');
    assert.match(needs.detail, /DESIGN §28\.43/);
    // `combat` 的**类型**错误先报：作者该改的是类型，不是缺一个 true
    assert.equal(mk({ combat: 'yes', behaviour: [{ switch: 'shopBias' }] }, { behaviourSwitches: SYNTH }).error, 'BAD_COMBAT');
    // 标了就是合法包
    const ok = mkBehaviour([{ switch: 'shopBias' }]);
    assert.equal(ok.ok, true, ok.detail);
    assert.deepEqual(ok.pack.behaviour, [{ switch: 'shopBias', option: 'official', name: null, desc: null }]);
  });

  test('`EMPTY_PACK` 优先于 `BEHAVIOUR_NEEDS_COMBAT`：开关**不是**贡献项', () => {
    const only = normalizePackManifest({ id: 'p', name: 'p', content: [], behaviour: [{ switch: 'shopBias' }] }, 'p', { behaviourSwitches: SYNTH });
    assert.equal(only.ok, false);
    assert.equal(only.error, 'EMPTY_PACK');
    assert.match(only.detail, /"behaviour" is NOT a contribution/);
    // 真表（空）下：任何声明都在**形状层**就被拒，连 `EMPTY_PACK` 都到不了 —— 这正是「响亮」的含义。
    const realOnly = normalizePackManifest({ id: 'p', name: 'p', content: [], behaviour: [{ switch: 'x' }] }, 'p');
    assert.equal(realOnly.error, 'BEHAVIOUR_UNKNOWN_SWITCH');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('空表也响亮（业主点名必加的那一条）', () => {
  test('不认识的开关也响亮：本版**认得的**只有真表里那几个，其余一律点名整包拒（不是静默通过）', () => {
    // 这一条钉的是「通道真的通、且响」：通道开着**不等于**「不认识的开关一律忽略」。
    // （第 8 刀之前这条钉的是「本版一个开关都没有」；那一版是**通道 + 守卫**本身，首格与它的引擎实现点一起落。
    // 今天真表里有实现好的格了，所以这一条改成同一件事的**当代表达**：真表里的格名被认，真表外的名字被点名拒。
    // 断言没有放松 —— 它仍在钉「响亮拒绝」，只是被拒的那个名字从 `shopBias` 换成了真表外的名字。）
    const known = Object.keys(BEHAVIOUR_SWITCHES);
    assert.ok(known.length >= 1, '这一条的前提：真表里至少有一格实现好的开关');
    assert.equal(isBehaviourSwitch('nopeBias'), false);
    for (const name of known) assert.equal(isBehaviourSwitch(name), true, `真表里声明的那一格必须被认：${name}`);

    const res = parseBehaviourDecl([{ switch: 'nopeBias', option: 'on' }]);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BEHAVIOUR_UNKNOWN_SWITCH');
    assert.match(res.detail, /nopeBias/); // 命中的名字必须出现在文案里，不是只报一个码
    // 文案里列出**本版真的有哪些开关**（空表那一版的「none yet — …」只要表里有一格就不再成立）
    for (const name of known) assert.match(res.detail, new RegExp(`"${name}"`), `文案必须列出可声明的开关：${name}`);

    // 整包路径也要拒：不是「解析器拒、装载器放过」。
    const pack = normalizePackManifest(
      { id: 'p', name: 'p', version: '1.0.0', combat: true, behaviour: [{ switch: 'nopeBias' }] },
      'p',
    );
    assert.equal(pack.ok, false);
    assert.equal(pack.error, 'BEHAVIOUR_UNKNOWN_SWITCH');
    // 忘了写 `combat` 也一样：不认识的开关**先**被那一层拒 —— 响亮拒绝排在 `BEHAVIOUR_NEEDS_COMBAT` 前面
    assert.equal(normalizePackManifest({ id: 'p', name: 'p', content: ['chess'], behaviour: [{ switch: 'nopeBias' }] }, 'p').error,
      'BEHAVIOUR_UNKNOWN_SWITCH');
  });

  test('每一格真表都要能通过形状守卫（加格不是「塞进去就算」）', () => {
    // `behaviourSwitchIssues` 是加格时最容易漏的那道闸：一格少了 `actions` / `options` / `default` / `effect` /
    // `optionLabels` 就是「声明了、装上了、什么都没发生」。真表通过它，等于每一格都有实现点与文案。
    assert.deepEqual(behaviourSwitchIssues(BEHAVIOUR_SWITCHES), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('缺省逐字节不变', () => {
  test('不声明 `behaviour` 的包：归一化清单里**没有**这个键（多一个键 = 所有已发布包哈希全变）', () => {
    const p = mk().pack;
    assert.equal(Object.hasOwn(p, 'behaviour'), false);
    // 显式 `undefined` 等于没写（既有语义）；显式 `null` **不是**「没写」：与 `variants` 逐字同一条 —— 它不是数组，
    // 所以点名拒绝，而不是被读成「没声明」（那正是「写了等于没写」这一层要消灭的失败方向）。
    assert.equal(Object.hasOwn(mk({ behaviour: undefined }).pack ?? {}, 'behaviour'), false);
    assert.equal(mk({ behaviour: null }).error, 'BEHAVIOUR_BAD_SHAPE');
    // 连**合成表**在手上时不声明也不长键（判据与表无关，只看作者写没写）
    assert.equal(Object.hasOwn(mk({}, { behaviourSwitches: SYNTH }).pack, 'behaviour'), false);
  });

  test('缺省 / 没声明 ⇒ 动作表是空的（调用方据此一个字节都不动）', () => {
    assert.deepEqual(behaviourActions(null), { ok: true, actions: [] });
    assert.deepEqual(behaviourActions([]), { ok: true, actions: [] });
    assert.deepEqual(behaviourActions(undefined), { ok: true, actions: [] });
    assert.deepEqual(behaviourActions(parseBehaviourDecl([{ switch: 'shopBias' }], SYNTH).decl, SYNTH),
      { ok: true, actions: [] }, '选了缺省选项 = 引擎今天的行为 = 没有动作');
    // 两个方向：`behaviourValue` / `behaviourIsDefault` 都要测「开」与「关」
    const on = parseBehaviourDecl([{ switch: 'shopBias', option: 'highestBond' }], SYNTH).decl;
    const off = parseBehaviourDecl([{ switch: 'shopBias' }], SYNTH).decl;
    assert.equal(behaviourValue(on, 'shopBias', SYNTH), 'highestBond');
    assert.equal(behaviourValue(off, 'shopBias', SYNTH), 'official');
    assert.equal(behaviourValue(on, 'nope', SYNTH), null);
    assert.equal(behaviourIsDefault(on, 'shopBias', SYNTH), false);
    assert.equal(behaviourIsDefault(off, 'shopBias', SYNTH), true);
  });

  test('真表下：一个包只能声明**真表里有的**那一格；它想靠一个不认识的开关改摘要 —— 装不上', () => {
    const raw = { id: 'p', name: 'P', combat: true, content: [], operators: { char_x: { powers: [], bonds: [] } }, behaviour: [{ switch: 'nopeBias' }] };
    const real = normalizePackManifest(raw, 'p');
    assert.equal(real.ok, false);
    assert.equal(real.error, 'BEHAVIOUR_UNKNOWN_SWITCH');
    // 而同一份 raw 去掉 `behaviour` 之后逐字就是既有的那次归一化
    assert.equal(Object.hasOwn(normalizePackManifest({ ...raw, behaviour: undefined }, 'p').pack, 'behaviour'), false);
  });

  test('**选了缺省档 = 引擎今天的行为**（行为层那一半的「逐字节不变」）', () => {
    // 真表里的每一格都过一遍：不声明这一格 ⇒ 读点是今天的值；显式选 `default` 那一档 ⇒ **同一个值**。
    // 两条路在**规则读取**这一层必须等价（`behaviourIsDefault`）—— 这就是「声明了但选了缺省 = 没声明」这条承诺的
    // 落点。**它不承诺归一化清单逐字节相同**：清单进的是包身份哈希，两份不同的字节必须有两个不同的摘要
    // （§28.43 判据 4），所以这里钉的是读取点，不是清单。
    for (const name of Object.keys(BEHAVIOUR_SWITCHES)) {
      const spec = BEHAVIOUR_SWITCHES[name];
      assert.equal(behaviourValue(null, name), null, `${name}：没声明 ⇒ 读点没有值`);
      assert.equal(behaviourIsDefault(null, name), true, `${name}：没声明 = 今天的行为`);
      const decl = parseBehaviourDecl([{ switch: name }]);
      assert.equal(decl.ok, true, decl.detail);
      const read = behaviourValue(decl.decl, name);
      assert.equal(read, spec.default, `${name}：只写开关不写 option ⇒ 这一格的缺省`);
      assert.equal(behaviourIsDefault(decl.decl, name), true, `${name}：选了缺省档 = 今天的行为`);
      assert.deepEqual(behaviourActions(decl.decl), { ok: true, actions: [] }, `${name}：缺省档没有动作`);
      // 另一端：真表里每一格至少有一个**非缺省**选项，选它就不再是「今天的行为」
      const on = spec.options.find((o) => o !== spec.default);
      assert.ok(on, `${name}：一格开关至少要有一个非缺省选项，否则它没有任何作用`);
      const onDecl = parseBehaviourDecl([{ switch: name, option: on }]).decl;
      assert.equal(behaviourIsDefault(onDecl, name), false, `${name}：非缺省档不是今天的行为`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('写了才进清单 + 进身份哈希 + 一路走到房间（合成表）', () => {
  const CONTRIB = { content: [], operators: { char_x: { powers: [], bonds: [] } } };
  const SYNTH_OPTS = { behaviourSwitches: SYNTH };

  test('声明了开关的包：归一化清单里有它，且内容哈希与「没声明」的包**必须不同**', () => {
    // 与 `test/workshopVariants.test.js` 的口径那条同一条理由：一份只差开关的包若共用同一个摘要，房间的摘要闸门
    // 就会放行两种不同的行为（DESIGN §28.2）。
    const plain = normalizePackManifest({ id: 'p', name: 'Base', ...CONTRIB }, 'p', SYNTH_OPTS).pack;
    const biased = normalizePackManifest({ id: 'p', name: 'Base', combat: true, ...CONTRIB, behaviour: [{ switch: 'shopBias', option: 'highestBond' }] }, 'p', SYNTH_OPTS).pack;
    const official = normalizePackManifest({ id: 'p', name: 'Base', combat: true, ...CONTRIB, behaviour: [{ switch: 'shopBias', option: 'official' }] }, 'p', SYNTH_OPTS).pack;

    assert.equal(Object.hasOwn(plain, 'behaviour'), false, '没声明的包不该有这个键');
    assert.deepEqual(biased.behaviour, [{ switch: 'shopBias', option: 'highestBond', name: null, desc: null }]);

    // 摘要：用装载器**同一份** `identifyPack`（它哈希的就是归一化清单的 canonicalJson）—— 不抄一份实现。
    const dir = join(tmp, 'hash');
    fs.mkdirSync(dir, { recursive: true });
    const h = (pack) => identifyPack(dir, pack, {}).hash;
    assert.notEqual(h(biased), h(plain), '开关必须进内容哈希');
    assert.notEqual(h(biased), h(official), '只差开关的两份包摘要必须不同（两种对局行为）');
    // 反复算稳定
    assert.equal(h(biased), h(biased));
  });

  test('装载结果 → 房间 mod 集合 → 那一份投影真的带着开关（`modDigest` 只哈希 `[id, hash]`）', () => {
    // 这一条钉的是 `server/index.js` 构建 `workshopMods` 时的**投影**：开关必须跟着 mod 条目走，否则 `Match` 从
    // `mods.packs[].behaviour` 读到的是 `undefined`，开关**静默不生效** —— 那正是这一层要消灭的失败方向
    // （§28.39 把这一处记成「这一层最容易做坏的地方」）。`modSetOf` 只按 `isModEntry`（id/hash/layer/combat/api）
    // **过滤**、不剥掉别的键，所以投影是唯一的一环。
    const pack = normalizePackManifest({ id: 'chain', name: 'Chain', layer: 'B', combat: true, ...CONTRIB, behaviour: [{ switch: 'shopBias', option: 'highestBond' }] }, 'chain', SYNTH_OPTS).pack;
    const hash = identifyPack(join(tmp, 'hash'), pack, {}).hash;
    // `server/index.js` 的那一份投影（开关只在声明过时才存在，与 `variants` / `voiceCdn` / `skins` 同一条纪律）
    const entry = {
      id: pack.id, hash, layer: pack.layer, combat: pack.combat, api: pack.api,
      ...(Array.isArray(pack.behaviour) && pack.behaviour.length ? { behaviour: pack.behaviour } : {}),
    };
    const set = modSetOf([entry]);
    assert.ok(set, '有包时必须算得出 mod 集合');
    assert.deepEqual(set.packs[0].behaviour, [{ switch: 'shopBias', option: 'highestBond', name: null, desc: null }]);
    // 摘要**只**认 `[id, hash]`：带上开关不改变任何摘要（改摘要等于让每个老包在同一条房间里被判成另一个包）
    assert.equal(set.digest, modSetOf([{ id: pack.id, hash, layer: pack.layer, combat: pack.combat, api: pack.api }]).digest);
    // 合成一格开关 → 引擎动作
    assert.deepEqual(mergeBehaviourDecls(set.packs, SYNTH).decl, [{ switch: 'shopBias', option: 'highestBond', by: 'chain' }]);
    assert.deepEqual(behaviourActions(mergeBehaviourDecls(set.packs, SYNTH).decl, SYNTH),
      { ok: true, actions: [{ kind: 'shop.biasHighestBond', value: true }] });
    // 没声明开关的包：投影里没有这个键，合成出空表，动作是空的
    const plain = normalizePackManifest({ id: 'plain', name: 'Plain', ...CONTRIB }, 'plain', SYNTH_OPTS).pack;
    assert.equal(Object.hasOwn(plain, 'behaviour'), false);
    assert.deepEqual(mergeBehaviourDecls([{ id: 'plain' }], SYNTH).decl, []);
    assert.deepEqual(behaviourActions([], SYNTH), { ok: true, actions: [] });
  });

  test('投影**那一行**真的在 `server/index.js` 里（不是测试里抄的一段自说自话）', () => {
    // 上面那条为了不抄引擎实现，自己写了一份投影 —— 所以这里回到源头：那一行必须真的在文件里。
    // 与本仓既有的源码级断言同一条做法（`test/workshopVariants.test.js` 对 `Math.min(v, DEPLOY_CAP_MAX)` 那一处）。
    const src = fs.readFileSync(join(ROOT, 'server', 'index.js'), 'utf8');
    assert.match(src, /Array\.isArray\(p\.behaviour\) && p\.behaviour\.length \? \{ behaviour: p\.behaviour \} : \{\}/,
      'server/index.js 的 workshopMods 投影必须带上 behaviour —— 漏掉它 = 开关静默不生效');
  });

  test('多包合成：按既有的「包 id 字典序小的赢」，输的一方被点名（不是静默）', () => {
    const { decl: merged, overridden } = mergeBehaviourDecls([
      { id: 'b-pack', behaviour: [{ switch: 'shopBias', option: 'highestBond' }] },
      { id: 'a-pack', behaviour: [{ switch: 'shopBias', option: 'official' }] },
    ], SYNTH);
    assert.deepEqual(merged, [{ switch: 'shopBias', option: 'official', by: 'a-pack' }]);
    assert.deepEqual(overridden, [{ switch: 'shopBias', by: 'b-pack', lostTo: 'a-pack', value: 'highestBond' }]);
    // 不依赖调用方传进来的顺序
    const other = mergeBehaviourDecls([
      { id: 'a-pack', behaviour: [{ switch: 'shopBias', option: 'official' }] },
      { id: 'b-pack', behaviour: [{ switch: 'shopBias', option: 'highestBond' }] },
    ], SYNTH);
    assert.deepEqual(other.decl, merged);
    // 表里没有的开关名在合成时被丢掉（它根本到不了这一步，装载期就整包拒了）
    assert.deepEqual(mergeBehaviourDecls([{ id: 'a', behaviour: [{ switch: 'nope' }] }], SYNTH).decl, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('老包不受影响', () => {
  test('一份**没有**`behaviour`、用了既有字段的包：归一化清单逐字是既有的那一份', () => {
    // 「老包一个字不改」在这一层的判据只有一条：**归一化清单不长新键**。清单是身份哈希的输入，所以它不变 ⇒
    // 摘要不变 ⇒ 房间的摘要闸门不会把已发布的包判成「另一个包」。整个 `node --test` 全量绿是这条的外部证据。
    const old = normalizePackManifest({
      id: 'old', name: 'Old', version: '1.0.0', author: 'a', license: 'CC0-1.0',
      game: '0.2.x', api: '>=1 <2', combat: false, content: ['chess'],
      overrides: ['chess:chess_char_1_01_a'], playtest: { directToHand: ['chess_char_1_01_a'] },
      notices: { credits: 'notice/credits.json' }, i18n: { en: 'i18n/en.json' },
    }, 'old');
    assert.equal(old.ok, true, old.detail);
    assert.equal(Object.hasOwn(old.pack, 'behaviour'), false);
    assert.equal(Object.hasOwn(old.pack, 'variants'), false);
    assert.deepEqual(Object.keys(old.pack).filter((k) => k === 'variants' || k === 'behaviour'), []);
  });
});
