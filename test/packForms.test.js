// test/packForms.test.js — 形态（clip set）与静态相位两条**包增量通道**（DESIGN §28.29）。
//
// 背景：`public/js/render/units.js` 的 `FORMS` 与 `public/js/render/fx/kinds.js` 的 `SILENT_PHASES` 是两张
// **冻结的第一方常量**。业主的要求是「做不了的加接口」：包要能声明自己的形态与静默相位，而第一方那两条语义
// 一个字节不许变味。于是两条通道的形状是同一个：
//
//   1. 第一方常量留在家（`FORMS` / `SILENT_PHASES`，不改）；
//   2. `pack.json.forms` / `pack.json.fx.silentPhases` 是**增量声明**，由 `shared/workshop.js` 在形状层判死
//      （不合法**整包拒绝**，绝不静默丢掉）；
//   3. 并表后落到客户端数据（`assets.modForms` / `assets.silentPhases`），消费点走统一入口
//      （`shared/packForms.js` 的 `formsFor` / `fx/kinds.js` 的 `silentPhase`）。
//
// 本文件钉住四件事：**包声明生效**、**第一方与包共存（且第一方优先）**、**不合法声明被拒**、
// **没声明这两条的包行为与今天逐字相同**。
//
// Run: node --test test/packForms.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest, applyWorkshop, formNextDeadLink } from '../shared/workshop.js';
import * as schema from '../shared/workshop.js';
import { formsFor, installPackForms, resetPackForms, installedPackForms, FORM_KIND_RE, FORM_ROLE_KEYS, FORM_TABLES } from '../shared/packForms.js';
import { FIRST_PARTY_FORM_NAMES, firstPartyFormNames } from '../shared/formNames.js';
import { installSilentPhases, silentPhase, fxSpec } from '../public/js/render/fx/kinds.js';
import { FORMS } from '../public/js/render/units.js';

/** 一份最小的合法清单骨架（`id` 会被覆盖）。 */
const packJson = (over = {}) => ({
  id: 'forms-fixture', name: '形态夹具', version: '0.1.0', license: 'CC0-1.0',
  content: [], overrides: [], ...over,
});

/** 一个**自己的**干员 + 一份形态声明（`next` 指向同一个 spine 上的第二个形态）。 */
const NEW_FORM_DECL = {
  chars: {
    fixture_hero: {
      shift: { change: 'Start_B', end: 'Die_B', next: 'shifted', roles: { idle: 'Idle_B', die: 'Die_B_2', move: { loop: 'Move_B' } } },
      shifted: { change: null, roles: { idle: 'Idle_C', die: 'Die_C' } },
    },
  },
};

// ---------------------------------------------------------------------------------------------------
// 一、形状层：不合法一律**整包拒绝**（不是静默丢掉）
// ---------------------------------------------------------------------------------------------------
test('forms：一个合法声明被归一化（clip / roles / next 原样留住）', () => {
  const r = normalizePackManifest(packJson({ forms: NEW_FORM_DECL }));
  assert.equal(r.ok, true, JSON.stringify(r));
  // 归一化**丢掉的是「没有」的写法**（`change: null` 与省略 `change` 在渲染器里是同一件事），
  // 留下的是内容本身。所以两种写法归一化后逐字相同 —— 它们的哈希也就相同（DESIGN §28.2）。
  assert.deepEqual(r.pack.forms, {
    chars: {
      fixture_hero: {
        shift: { change: 'Start_B', end: 'Die_B', next: 'shifted', roles: { idle: 'Idle_B', die: 'Die_B_2', move: { loop: 'Move_B' } } },
        shifted: { roles: { idle: 'Idle_C', die: 'Die_C' } },
      },
    },
  });
  const explicitNull = normalizePackManifest(packJson({ forms: { chars: { fixture_hero: { shifted: { change: null, roles: { idle: 'Idle_C', die: 'Die_C' } } } } } }));
  assert.equal(explicitNull.ok, true, JSON.stringify(explicitNull));
  assert.deepEqual(explicitNull.pack.forms.chars.fixture_hero.shifted, { roles: { idle: 'Idle_C', die: 'Die_C' } },
    '`change: null` 与省略 `change` 归一化后必须逐字相同（否则同一份行为的哈希会不同）');
  // forms 是**贡献项**：一个只带它的包不是空包（EMPTY_PACK 不能把它拦下来）
  assert.deepEqual(Object.keys(r.pack.content), []);
});

test('forms：表名必须落在 FORM_TABLES 里', () => {
  for (const table of FORM_TABLES) {
    const r = normalizePackManifest(packJson({ forms: { [table]: { x_1: { a: { roles: { idle: 'I' } } } } } }));
    assert.equal(r.ok, true, `${table}: ${JSON.stringify(r)}`);
    assert.ok(r.pack.forms[table].x_1.a, `${table} 的形态必须进归一化结果`);
  }
  const bad = normalizePackManifest(packJson({ forms: { weapons: { x_1: { a: { roles: { idle: 'I' } } } } } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'FORMS_UNKNOWN_TABLE');
});

test('forms：形态名、clip 名、roles 的每一项都必须是字符串（非法即拒）', () => {
  const cases = [
    ['FORMS_BAD_KIND', { chars: { x_1: { 'not a name!': { roles: { idle: 'I' } } } } }],
    ['FORMS_BAD_KIND', { chars: { x_1: { 7: { roles: { idle: 'I' } } } } }],
    ['FORMS_BAD_CLIP', { chars: { x_1: { a: { change: 3, roles: { idle: 'I' } } } } }],
    ['FORMS_BAD_CLIP', { chars: { x_1: { a: { end: '', roles: { idle: 'I' } } } } }],
    ['FORMS_BAD_ROLES', { chars: { x_1: { a: { roles: { idle: 3 } } } } }],
    ['FORMS_BAD_ROLES', { chars: { x_1: { a: { roles: { fly: 'I' } } } } }],
    ['FORMS_BAD_ROLES', { chars: { x_1: { a: { roles: { idle: '' } } } } }],
    ['FORMS_BAD_ROLES', { chars: { x_1: { a: { roles: { attack: { loop: 9 } } } } } }],
    ['FORMS_BAD_ROLES', { chars: { x_1: { a: { roles: { attack: { begin: 'B', nope: 'N' } } } } } }],
    ['FORMS_BAD_ROLES', { chars: { x_1: { a: { roles: {} } } } }],
    // `roles: null` 与「省略 roles」是同一件事：都是「这个形态没有 clip 集」——所以走 MISSING 那条码
    ['FORMS_MISSING_ROLES', { chars: { x_1: { a: { roles: null } } } }],
    ['FORMS_MISSING_ROLES', { chars: { x_1: { a: { change: 'Start' } } } }],
    ['FORMS_SPEC_UNKNOWN_FIELD', { chars: { x_1: { a: { roles: { idle: 'I' }, nope: 1 } } } }],
    ['FORMS_BAD_SHAPE', { chars: { x_1: 'not an object' } }],
    ['FORMS_BAD_ID', { chars: { 'bad id!': { a: { roles: { idle: 'I' } } } } }],
    ['FORMS_BAD_NEXT', { chars: { x_1: { a: { next: 'not a name!', roles: { idle: 'I' } } } } }],
  ];
  for (const [code, forms] of cases) {
    const r = normalizePackManifest(packJson({ forms }));
    assert.equal(r.ok, false, `应当被拒：${JSON.stringify(forms)}`);
    assert.equal(r.error, code, `${JSON.stringify(forms)} → ${r.error}（期望 ${code}）`);
    assert.ok(r.detail && r.detail.length > 10, '拒绝必须带人话理由');
  }
});

test('forms：`next` 必须指向同一个 spine id 上已声明的形态（第一方或本包），否则是死链', () => {
  const dead = normalizePackManifest(packJson({ forms: { chars: { x_1: { a: { next: 'nowhere', roles: { idle: 'I' } } } } } }));
  assert.equal(dead.ok, false);
  assert.equal(dead.error, 'FORMS_NEXT_UNKNOWN');
  assert.match(dead.detail, /nowhere/);
  // 指向**第一方**那个 spine 上的形态：合法（`form2` 是 enemy_1539_reid 的第一方形态）
  const toFirstParty = normalizePackManifest(packJson({
    forms: { enemies: { enemy_1539_reid: { extra_form: { next: 'form2', roles: { idle: 'I' } } } } },
  }));
  assert.equal(toFirstParty.ok, true, JSON.stringify(toFirstParty));
  // 指向**另一个** spine 上的形态：死链
  const crossSpine = normalizePackManifest(packJson({
    forms: { chars: { x_1: { a: { next: 'shifted', roles: { idle: 'I' } } }, x_2: { shifted: { roles: { idle: 'J' } } } } },
  }));
  assert.equal(crossSpine.ok, false);
  assert.equal(crossSpine.error, 'FORMS_NEXT_UNKNOWN');
});

test('formNextDeadLink 是纯函数：失败分支自己也被测（喂一份手工声明）', () => {
  assert.equal(formNextDeadLink({ chars: { x_1: { a: { next: 'b', roles: {} }, b: { roles: {} } } } }), null);
  assert.deepEqual(formNextDeadLink({ chars: { x_1: { a: { next: 'b', roles: {} } } } }), { table: 'chars', id: 'x_1', kind: 'a', next: 'b' });
  assert.equal(formNextDeadLink(null), null);
});

test('forms：第一方的形态名**一律拒绝**（声明了却不生效，宁可拒绝）', () => {
  // `enemy_1040_bombd` 的第一方形态是 'bombed'；包想盖它 → 点名拒绝
  const r = normalizePackManifest(packJson({
    forms: { enemies: { enemy_1040_bombd: { bombed: { change: 'X', roles: { idle: 'I' } } } } },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FORMS_FIRST_PARTY_OVERLAP');
  assert.match(r.detail, /bombed/);
  // 同一个 spine 上**新增**一个第一方没有的形态名：合法（这就是包该走的路）
  const add = normalizePackManifest(packJson({
    forms: { enemies: { enemy_1040_bombd: { divebomb: { change: 'Die', roles: { idle: 'Idle_3' } } } } },
  }));
  assert.equal(add.ok, true, JSON.stringify(add));
});

// ---------------------------------------------------------------------------------------------------
// 二、第一方镜像：`shared/formNames.js` 与 `FORMS` 真身逐条一致（守卫自己也被测）
// ---------------------------------------------------------------------------------------------------
test('shared/formNames.js 是第一方 FORMS 的忠实镜像（少一个 / 多一个 / 拼错都红）', () => {
  const fromForms = Object.fromEntries(Object.entries(FORMS).map(([k, v]) => [k, Object.keys(v).sort()]));
  assert.deepEqual(FIRST_PARTY_FORM_NAMES, fromForms,
    'shared/formNames.js 漂了 —— 跑 `node tools/build-form-names.mjs` 重新生成');
  // 失败分支：镜像真被读过（不是两个空对象在互相相等）
  assert.ok(Object.keys(fromForms).length > 20, `第一方形态表不该这么小：${Object.keys(fromForms).length}`);
  assert.deepEqual([...firstPartyFormNames('enemy_1040_bombd')], ['bombed']);
  assert.deepEqual([...firstPartyFormNames('nobody_has_this')], [], '不认识的 spine id 给空集，不给 undefined');
});

// ---------------------------------------------------------------------------------------------------
// 三、合并规则：第一方优先 + 包只做增量 + 谁赢不取决于加载次序
// ---------------------------------------------------------------------------------------------------
test('formsFor：没有包增量时与今天的 `FORMS[id]` 逐字相同（对象同一性也不变）', () => {
  resetPackForms();
  for (const id of Object.keys(FORMS)) assert.equal(formsFor(FORMS, id), FORMS[id], id);
  assert.equal(formsFor(FORMS, 'nobody_has_this'), undefined);
  assert.equal(formsFor(FORMS, null), undefined);
  assert.equal(formsFor(null, 'enemy_1040_bombd'), undefined);
});

test('formsFor：包给一个**新 spine id** 的形态生效', () => {
  resetPackForms();
  const dropped = installPackForms({ fixture_hero: { shift: { pack: 'a-pack', form: NEW_FORM_DECL.chars.fixture_hero.shift } } }).dropped;
  assert.deepEqual(dropped, []);
  const got = formsFor(FORMS, 'fixture_hero');
  assert.deepEqual(Object.keys(got), ['shift']);
  assert.equal(got.shift.change, 'Start_B');
  assert.equal(got.shift.next, 'shifted');
  // 第一方那一条仍然在旁边，没有被写坏
  assert.equal(formsFor(FORMS, 'enemy_1040_bombd'), FORMS.enemy_1040_bombd);
});

test('formsFor：第一方与包**共存**，第一方在同一 spine 上仍然赢（第二道闸）', () => {
  resetPackForms();
  // 绕过形状层直接喂一份「想盖第一方」的增量：客户端也要挡住它（浏览器拿到的 JSON 不该被信任）
  const { dropped } = installPackForms({
    enemy_1040_bombd: {
      divebomb: { pack: 'a-pack', form: { change: 'Die', roles: { idle: 'Idle_3' } } },
      bombed: { pack: 'a-pack', form: { change: 'HACK', roles: { idle: 'HACK' } } },
    },
  });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].kind, 'bombed');
  assert.match(dropped[0].reason, /first-party/);
  const got = formsFor(FORMS, 'enemy_1040_bombd');
  assert.equal(got.bombed.change, undefined, '第一方那条不许被盖');
  assert.deepEqual(got.bombed.roles.idle, 'Idle_2');
  assert.equal(got.divebomb.change, 'Die', '包新增的那条要在');
  // 第一方原表一个字节没动
  assert.equal(FORMS.enemy_1040_bombd.bombed.roles.idle, 'Idle_2');
  assert.equal(Object.isFrozen(FORMS), true);
});

test('formsFor：包增量是**整份替换**的（清单只来一次，两份清单不该叠成三份事实）', () => {
  resetPackForms();
  assert.deepEqual(installPackForms({ t_1: { m: { pack: 'a-pack', form: { change: 'A', roles: { idle: 'IA' } } } } }).dropped, []);
  assert.deepEqual(Object.keys(installedPackForms().t_1), ['m']);
  assert.deepEqual(installPackForms({ t_1: { n: { pack: 'a-pack', form: { change: 'N', roles: { idle: 'IN' } } } } }).dropped, []);
  assert.deepEqual(Object.keys(installedPackForms().t_1), ['n'], '第二份清单替换第一份，而不是叠上去');
  // 清空 = 回到今天（一个包都没有声明 forms）
  resetPackForms();
  assert.deepEqual(installedPackForms(), {});
  assert.equal(formsFor(FORMS, 't_1'), undefined);
});

test('并表：跨包撞同名形态 → FORM_COLLISION 点名赢家（谁赢不取决于加载次序）', () => {
  const bPack = { id: 'b-pack', overrides: [], files: {}, forms: { enemies: { enemy_1001_bigbo: { mine: { change: 'X', roles: { idle: 'I' } } } } } };
  const aPack = { id: 'a-pack', overrides: [], files: {}, forms: { enemies: { enemy_1001_bigbo: { mine: { change: 'Y', roles: { idle: 'I' } } } } } };
  // 故意把 b 放在前面：结果必须与顺序无关（a 的小 id 赢）
  const { data, report } = applyWorkshop({ assets: {} }, [bPack, aPack]);
  const errs = report.errors.filter((e) => e.code === 'FORM_COLLISION');
  assert.equal(errs.length, 1, JSON.stringify(report.errors));
  assert.equal(errs[0].pack, 'b-pack');
  assert.equal(errs[0].definedBy, 'a-pack');
  assert.equal(data.assets.modForms.enemy_1001_bigbo.mine.pack, 'a-pack');
  assert.equal(data.assets.modForms.enemy_1001_bigbo.mine.form.change, 'Y');
});

test('并表：assets.json 不在时点名报告（MANIFEST_MISSING），不凭空造一份', () => {
  const { data, report } = applyWorkshop({}, [{ id: 'a-pack', overrides: [], files: {}, forms: NEW_FORM_DECL }]);
  const errs = report.errors.filter((e) => e.code === 'MANIFEST_MISSING' && e.id === 'forms');
  assert.equal(errs.length, 1, JSON.stringify(report.errors));
  assert.equal(data.assets, undefined);
});

test('并表：包与包各自的形态进同一张 modForms，带上包 id（客户端按它排序）', () => {
  const { data, report } = applyWorkshop({ assets: {} }, [
    { id: 'z-pack', overrides: [], files: {}, forms: { chars: { z_1: { zform: { change: 'C', roles: { idle: 'I' } } } } } },
    { id: 'a-pack', overrides: [], files: {}, forms: { chars: { a_1: { aform: { change: 'A', roles: { idle: 'I' } } } } } },
  ]);
  assert.deepEqual(Object.keys(data.assets.modForms).sort(), ['a_1', 'z_1']);
  assert.equal(data.assets.modForms.a_1.aform.pack, 'a-pack');
  assert.equal(data.assets.modForms.z_1.zform.pack, 'z-pack');
  assert.deepEqual(report.forms, { 'a-pack': ['forms.chars.a_1.aform'], 'z-pack': ['forms.chars.z_1.zform'] });
  assert.deepEqual(report.errors, []);
});

// ---------------------------------------------------------------------------------------------------
// 四、没声明 forms 的包：行为与今天**逐字相同**（归一化清单不多键、哈希不动）
// ---------------------------------------------------------------------------------------------------
test('没有 forms / fx 的包：归一化清单里没有这两个键（老包的哈希逐字节不变）', () => {
  const before = normalizePackManifest(packJson({ art: { chars: { fixture_hero: { avatar: 'a.png' } } } }), '', { hasAssets: true });
  assert.equal(before.ok, true, JSON.stringify(before));
  assert.equal('forms' in before.pack, false, 'forms 只在声明过时才存在');
  assert.equal('fx' in before.pack, false, 'fx 只在声明过时才存在');
  // 空的 `forms: {}` 不算声明（与 `art: {}` / `voices: {}` 同一个语义：合法但什么都不做）
  const empty = normalizePackManifest(packJson({ forms: {} }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'EMPTY_PACK');
});

test('`forms` 与 `fx` 进了 PACK_FIELDS（否则整个包会被 PACK_UNKNOWN_FIELD 拒掉）', () => {
  assert.ok(schema.PACK_FIELDS.includes('forms'));
  assert.ok(schema.PACK_FIELDS.includes('fx'));
});

// ---------------------------------------------------------------------------------------------------
// 五、静态相位通道（`pack.json.fx.silentPhases`）
// ---------------------------------------------------------------------------------------------------
test('fx：形状层判形状（未知字段 / 非字符串项一律拒，`fx: {}` 也拒）', () => {
  const ok = normalizePackManifest(packJson({ fx: { silentPhases: ['helmLow', 'bombed'] } }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.pack.fx.silentPhases, ['bombed', 'helmLow'], '去重 + 排序，声明次序不影响结果');
  for (const [code, fx] of [
    ['FX_UNKNOWN_FIELD', { loud: true }],
    ['FX_BAD_SHAPE', {}],
    ['FX_BAD_SHAPE', { silentPhases: 'bombed' }],
    ['FX_BAD_SILENT_PHASE', { silentPhases: ['ok', 3] }],
    ['FX_BAD_SILENT_PHASE', { silentPhases: [''] }],
  ]) {
    const r = normalizePackManifest(packJson({ fx }));
    assert.equal(r.ok, false, `应当被拒：${JSON.stringify(fx)}`);
    assert.equal(r.error, code, `${JSON.stringify(fx)} → ${r.error}`);
  }
  // 空的 `silentPhases: []`：合法但什么都不做 → 不是一个贡献项，所以只带它的包照旧 EMPTY_PACK
  const empty = normalizePackManifest(packJson({ fx: { silentPhases: [] } }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'EMPTY_PACK');
});

test('silentPhase：第一方那两个不变，包声明的加进来，没声明的照旧不静默', () => {
  installSilentPhases([]);
  assert.equal(silentPhase('bombed'), true, '第一方的 bombed');
  assert.equal(silentPhase('warning'), true, '第一方的 warning');
  assert.equal(silentPhase('helmLow'), false, '没声明的照旧不静默');
  const { added } = installSilentPhases(['helmLow', 'bombed']);
  assert.deepEqual(added, ['helmLow'], '第一方已有的那条不算「新增」');
  assert.equal(silentPhase('helmLow'), true);
  // 整份替换：第二份清单里没有 helmLow，它就不再静默（包被卸掉以后状态不该留在进程里）
  installSilentPhases(['bombed']);
  assert.equal(silentPhase('helmLow'), false);
  installSilentPhases([]);
});

test('fxSpec：包的静默相位真的让那条 phase 不放特效，没声明的照旧放', () => {
  installSilentPhases([]);
  const loud = fxSpec('phase', { kind: 'helmLow' });
  assert.notEqual(loud.a, 'none', '没声明时它照旧有特效');
  installSilentPhases(['helmLow']);
  assert.deepEqual(fxSpec('phase', { kind: 'helmLow' }), { a: 'none', c: 0xffffff });
  assert.deepEqual(fxSpec('phase', { kind: 'bombed' }), { a: 'none', c: 0xffffff }, '第一方那条没被动过');
  assert.notEqual(fxSpec('phase', { kind: 'lionAdvance' }).a, 'none');
  installSilentPhases([]);
});

test('并表：包的 silentPhases 并进 assets.silentPhases（去重 + 排序，两份声明同一个种类只留一条）', () => {
  const { data, report } = applyWorkshop({ assets: { silentPhases: ['bombed'] } }, [
    { id: 'b-pack', overrides: [], files: {}, fx: { silentPhases: ['wheel'] } },
    { id: 'a-pack', overrides: [], files: {}, fx: { silentPhases: ['wheel', 'bombed'] } },
  ]);
  assert.deepEqual(data.assets.silentPhases, ['bombed', 'wheel']);
  assert.deepEqual(report.silentPhases, { 'b-pack': ['wheel'], 'a-pack': ['bombed', 'wheel'] });
  assert.deepEqual(report.errors, []);
});

// ---------------------------------------------------------------------------------------------------
// 七、渲染器那四处消费点：包声明的形态真的换掉了 clip 集（第一方那条也照旧）
// ---------------------------------------------------------------------------------------------------
test('渲染层：UnitView.setForm 用得上包声明的形态（四处查找走的是同一个入口）', async () => {
  const { installFakePixi, fakeViewCtx } = await import('./render/fakepixi.js');
  const { presetCamera } = await import('../public/js/render/projection.js');
  const fake = installFakePixi();
  try {
    const { UnitView } = await import('../public/js/render/units.js');
    const assetsJson = JSON.parse((await import('node:fs')).readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
    const ENEMY = 'enemy_1001_bigbo';
    const entry = assetsJson.enemies[ENEMY].spine;
    const names = Object.keys(entry.animations || {});
    // 夹具前提：真的拿到这个 skeleton 的动画名，后面断言 clip 才有意义
    assert.ok(names.length > 3, `${ENEMY} 必须有动画，拿到 ${names.length} 条`);
    const ctx = fakeViewCtx(fake.P, {
      assets: {
        picture: () => null, image: async () => null, spineEntry: () => entry,
        spine: { acquire: async () => ({ animations: names.map((name) => ({ name })) }), release() {} },
      },
      cam: () => presetCamera('normal', { width: 1280, height: 720 }),
    });
    const tick = () => new Promise((r) => setImmediate(r));
    resetPackForms();
    const v = new UnitView(ctx, { id: 8, side: 'enemy', kind: 'enemy', defId: ENEMY, spine: ENEMY, tier: 1, x: 8, y: 9, maxHp: 500, facing: -1 });
    await tick(); await tick();
    assert.ok(v.actor, 'Spine model built');
    // 没有包声明时：一个第一方不认识的形态名不改任何东西（今天的行为）
    v.setForm('packform');
    assert.equal(v.form, null, '第一方没有这个形态时 setForm 什么都不做');
    // 包声明一个自己的形态（新 spine id 或新形态名）：消费点立刻用得上。
    // clip 名用**这个 skeleton 真的有的**那两条（`names`），因为一个骨架没有的 clip 会被渲染器按自己的
    // 兜底规则顶掉 —— 那条规则是既有的，不是这条通道要测的。
    const IDLE = names.includes('Idle_2') ? 'Idle_2' : 'Idle';
    const OTHER = names.find((n) => n !== IDLE) || IDLE;
    installPackForms({ [ENEMY]: { packform: { pack: 'a-pack', form: { change: OTHER, roles: { idle: IDLE, die: 'Die' } } } } });
    v.setForm('packform');
    assert.equal(v.form, 'packform');
    assert.equal(v.info.form, 'packform');
    // `change` 是过渡 clip（`setForm` 先放它，再落到 roles）——这里只钉「包声明的 clip 真的被读到了」
    assert.ok([OTHER, IDLE].includes(v.actor.current), `包声明的 clip 应当被用上，实际 ${v.actor.current}`);
    // 第一方那一条仍然照旧（同一个 spine 上没有的形态名，第一方那条也没被动过）
    resetPackForms();
    v.setForm(null);
    assert.equal(v.form, null);
  } finally {
    resetPackForms();
    fake.restore();
  }
});

// ---------------------------------------------------------------------------------------------------
// 六、形状层的常数面（守卫与文档引用的是同一份）
// ---------------------------------------------------------------------------------------------------
test('形态通道的常数面：表名 / 名字形状 / 角色键', () => {
  assert.deepEqual([...FORM_TABLES], ['chars', 'enemies', 'tokens']);
  assert.match('divebomb', FORM_KIND_RE);
  assert.doesNotMatch('_leading', FORM_KIND_RE);
  assert.doesNotMatch('has space', FORM_KIND_RE);
  // roles 的键就是渲染器画的那一组（`units.js` 的 clipSet / dollRoles / rebirth 用的）
  for (const k of ['idle', 'deploy', 'die', 'stun', 'move', 'attack', 'skill']) assert.ok(FORM_ROLE_KEYS.includes(k), k);
});
