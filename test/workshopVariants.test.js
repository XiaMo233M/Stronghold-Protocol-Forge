// test/workshopVariants.test.js — 变体 / 口径层（DESIGN §28.39）：`pack.json.variants` + 轴表 `shared/variants.js`。
//
// 这一层要消掉的那面墙，逐字记在 `shared/workshop.js` 的 `PACK_FIELDS` 注释里：三个社区 mod 的 `variants` 曾经
// 「写了等于没写」（归一化时被静默丢掉）。所以本文件钉住的判据按「响亮失败 → 缺省不变 → 真生效」三层排：
//
//   1. **闭枚举**：轴名不认识 / 选项名不认识 / `default` 类型不对 / 同一个轴声明两遍 ⇒ 各自的**拒绝码**整包拒绝
//      （不是忽略、不是回落到缺省）。断言的是码，不是「失败了就行」。
//   2. **缺省逐字节不变**：不声明 `variants` 的包，归一化清单里**不得**多出这个键（多一个键 = 所有已发布包的
//      内容哈希全变，房间的摘要闸门随即误判，DESIGN §28.2）；而 `GameData` 在不给口径时 `deployCap` 逐字是
//      数据里那个 8。
//   3. **真生效 + 进摘要**：`deploy: "max"` 把这一局的部署位抬到 `DEPLOY_CAP_MAX`；只差口径的两份包**摘要必须
//      不同**（一个口径改的是对局结果，同一个摘要下两种行为是不允许的）。
//
// 另有一条**既有静默失败**的回归：`content` 里不认识的条目从前被 `normalizePackManifest` 静默过滤掉，作者看到
// 「包合法、我写的那件事没发生」。本刀把它改成点名拒（`UNKNOWN_CONTENT_FILE`），而这一版举的例子是仍然**刻意
// 没有通道**的 `config` —— 0.18.6 给 `variants` 开了**口径数据通道**（DESIGN §28.51，判据在
// `test/workshopVariantsData.test.js`），所以它不再是「不认识的条目」。
//
// Run: node --test test/workshopVariants.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, PACK_FIELDS, WORKSHOP_CONTENT_FILES } from '../shared/workshop.js';
import {
  VARIANT_AXES, VARIANT_AXIS_NAMES, isVariantAxis, isVariantOption,
  parseVariantsDecl, variantValue, variantIsDefault, variantDataPatch, mergeVariantDecls,
} from '../shared/variants.js';
import { DEPLOY_CAP_MAX } from '../shared/constants.js';
import { modSetOf } from '../shared/modIdentity.js';
import { loadWorkshop } from '../server/workshop.js';
import { GameData } from '../server/match/gamedata.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const DATA_DIR = join(ROOT, 'data');

/** 一份**合法贡献**的底盘（口径不是贡献项，所以一个只带 `variants` 的包照旧 `EMPTY_PACK`）。 */
const mk = (extra = {}) => normalizePackManifest({
  id: 'p', name: 'p', content: [], operators: { char_x: { powers: [], bonds: [] } }, ...extra,
}, 'p');
/** 一份声明了口径的合法包（`combat: true` 是硬闸门，见下）。 */
const mkVariants = (variants, extra = {}) => mk({ combat: true, variants, ...extra });

let tmp;
before(() => { tmp = fs.mkdtempSync(join(tmpdir(), 'sp-variants-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ } });

// ---------------------------------------------------------------------------------------------------------------
describe('轴表：闭枚举，一个轴只有一个值', () => {
  test('轴名单与各轴的选项 / 缺省，逐字是设计里定下的那一份', () => {
    // 这一行是**闭合世界守卫**：轴名单一个不多一个不少。第 1 刀落地时它读作 `['deploy', 'training']`；
    // **第 6 刀（干员形态投影）按同一形状加了第三条轴 `form`**，所以这里**就地把枚举延长到三条** ——
    // 断言本身没有放松（多一条、少一条、改个名都仍然红），放松它等于把这条守卫变成一句口号。
    assert.deepEqual([...VARIANT_AXIS_NAMES].sort(), ['deploy', 'form', 'training']);
    assert.deepEqual(VARIANT_AXES.training.options, ['official', 'full']);
    assert.deepEqual(VARIANT_AXES.deploy.options, ['official', 'max']);
    assert.deepEqual(VARIANT_AXES.form.options, ['official', 'elite']);
    // 缺省 = **引擎今天的行为**：练度缺省满潜能 / 精英2 Lv.60，部署位缺省是数据里那个官方 8，
    // 形态缺省是「普通干员按普通形态出战」（`data/chess.json` 里那份记录本身）。
    assert.equal(VARIANT_AXES.training.default, 'full');
    assert.equal(VARIANT_AXES.deploy.default, 'official');
    assert.equal(VARIANT_AXES.form.default, 'official');
    assert.equal(isVariantAxis('deploy'), true);
    assert.equal(isVariantAxis('nope'), false);
    assert.equal(isVariantOption('deploy', 'max'), true);
    assert.equal(isVariantOption('form', 'elite'), true);
    // 一个轴的选项名不许串到另一个轴上（`full` 是 training 的、`elite` 是 form 的，不是 deploy 的）
    assert.equal(isVariantOption('deploy', 'full'), false);
    assert.equal(isVariantOption('deploy', 'elite'), false);
    assert.equal(isVariantOption('training', 'max'), false);
    assert.equal(isVariantOption('form', 'full'), false);
  });

  test('**可扩展**：每一条轴都按同一个形状登记（将来加轴按这条形状加，不许改既有轴的语义）', () => {
    // 第 4 刀（行为补丁 / 声明通道）将来也会碰这条表，所以这里钉住的是**形状**而不是轴的数量：
    // 每条轴都必须有 label / options / default / optionLabels / effect，且后两者覆盖**每一个**选项
    // （缺一条 ⇒ 编辑器与错误文案会给作者一个空缺，那正是「写了等于没写」那种失败）。
    assert.ok(VARIANT_AXIS_NAMES.length >= 2);
    for (const name of VARIANT_AXIS_NAMES) {
      const spec = VARIANT_AXES[name];
      assert.equal(typeof spec.label, 'string', `${name}.label`);
      assert.ok(spec.label.length > 0 && spec.label.length <= 40, `${name}.label 的长度`);
      assert.ok(Array.isArray(spec.options) && spec.options.length >= 2, `${name}.options 至少两个选项`);
      assert.equal(new Set(spec.options).size, spec.options.length, `${name}.options 不许重复`);
      for (const o of spec.options) assert.ok(typeof o === 'string' && o.length > 0 && o.length <= 40, `${name}.options 的选项名`);
      assert.ok(spec.options.includes(spec.default), `${name}.default 必须在 options 里`);
      for (const o of spec.options) {
        assert.equal(typeof spec.optionLabels[o], 'string', `${name}.optionLabels["${o}"]`);
        assert.equal(typeof spec.effect[o], 'string', `${name}.effect["${o}"]`);
      }
      assert.deepEqual(Object.keys(spec.optionLabels).sort(), [...spec.options].sort(), `${name}.optionLabels 的键集`);
      assert.deepEqual(Object.keys(spec.effect).sort(), [...spec.options].sort(), `${name}.effect 的键集`);
    }
  });

  test('`variants` 是顶层键闭集的一员，**也**是 content 白名单的一员（0.18.6：口径数据通道，DESIGN §28.51）', () => {
    assert.ok(PACK_FIELDS.includes('variants'));
    // 本刀之前这里是 `assert.equal(…, false)`，理由是「把它当数据文件就是开一条『包可以覆盖任意数值』的通道」。
    // 那条理由今天仍然成立，所以通道落地的**同时**带上了三条守卫（不能发明记录 / 不能发明字段 / 不能发明轴，
    // 见 `test/workshopVariantsData.test.js`）。**声明**（`pack.json.variants`，哪一套口径）与**数值**
    // （`variants.json`，这套口径下每一条记录读几）从这一版起是两件事、两个落点。
    assert.equal(WORKSHOP_CONTENT_FILES.includes('variants'), true,
      '口径数值走 content 的 "variants" 数据文件；它只改已有记录的字段，一条记录都发明不出来');
    // 而 `config` 依旧**没有**通道：它改的是规则，不是内容（这条判据一个字都没放松）
    assert.equal(WORKSHOP_CONTENT_FILES.includes('config'), false);
  });

  test('只声明轴不写 default ⇒ 用这个轴的缺省；写了就照写（缺省选项也如实写出来）', () => {
    const a = parseVariantsDecl([{ axis: 'deploy' }]);
    assert.equal(a.ok, true, a.detail);
    assert.deepEqual(a.decl, [{ axis: 'deploy', default: 'official', name: null, desc: null }]);
    const b = parseVariantsDecl([{ axis: 'deploy', default: 'official' }]);
    assert.equal(b.ok, true, b.detail);
    assert.equal(b.decl[0].default, 'official', '「选了缺省」与「没声明」在数据上等价，但作者写了什么就回什么');
  });

  test('归一化结果按**轴名排序**（键序是清单字节的一部分，不许随书写顺序变）', () => {
    const r = parseVariantsDecl([{ axis: 'training', default: 'official' }, { axis: 'deploy', default: 'max' }]);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.decl.map((e) => e.axis), ['deploy', 'training']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('拒绝路径逐条：每个码点名，绝不静默丢', () => {
  test('形状层（`shared/variants.js`）', () => {
    const cases = [
      [{}, 'VARIANTS_BAD_SHAPE'],                                        // 不是数组
      [[], 'VARIANTS_BAD_SHAPE'],                                        // 空数组 = 一条什么都不做的声明
      [['deploy'], 'VARIANTS_BAD_SHAPE'],                                // 数组里放字符串
      [[{ axis: '' }], 'VARIANTS_BAD_SHAPE'],                            // axis 空串
      [[{ axis: 7 }], 'VARIANTS_BAD_SHAPE'],                             // axis 不是字符串
      [[{ axis: 'deploy', nope: 1 }], 'VARIANTS_BAD_SHAPE'],             // 未知字段（闭合世界）
      [[{ axis: 'deploy', name: '' }], 'VARIANTS_BAD_SHAPE'],            // name 写空
      [[{ axis: 'deploy', name: 'x'.repeat(41) }], 'VARIANTS_BAD_SHAPE'],// name 过长
      [[{ axis: 'deploy', desc: 5 }], 'VARIANTS_BAD_SHAPE'],             // desc 类型不对
      [[{ axis: 'nope' }], 'VARIANTS_UNKNOWN_AXIS'],
      [[{ axis: 'deploy', default: 'lots' }], 'VARIANTS_UNKNOWN_OPTION'],
      [[{ axis: 'training', default: 'max' }], 'VARIANTS_UNKNOWN_OPTION'], // 选项串轴
      [[{ axis: 'deploy', default: 12 }], 'VARIANTS_BAD_DEFAULT'],       // 非字符串 default
      [[{ axis: 'deploy', default: null }], 'VARIANTS_BAD_DEFAULT'],
      [[{ axis: 'deploy', default: false }], 'VARIANTS_BAD_DEFAULT'],
      [[{ axis: 'deploy' }, { axis: 'deploy' }], 'VARIANTS_DUPLICATE_AXIS'],
    ];
    for (const [variants, code] of cases) {
      const r = parseVariantsDecl(variants);
      assert.equal(r.ok, false, `${code} 应当被拒：${JSON.stringify(variants)}`);
      assert.equal(r.error, code, `期望 ${code}，实际 ${r.error} / ${r.detail}`);
      assert.ok(r.detail.length > 0, '拒绝必须带一句人能读的理由');
      // 拒绝码自己必须在文案里点名（作者从错误里要能看出该写哪个）
      if (code === 'VARIANTS_UNKNOWN_AXIS') assert.match(r.detail, /"deploy"/);
      if (code === 'VARIANTS_UNKNOWN_OPTION') assert.match(r.detail, /"official"/);
    }
  });

  test('`pack.json.variants` 的形状层接进整包校验（同一份判据，不出现第二份实现）', () => {
    assert.equal(mkVariants('deploy').error, 'VARIANTS_BAD_SHAPE');
    assert.equal(mkVariants([{ axis: 'nope' }]).error, 'VARIANTS_UNKNOWN_AXIS');
    assert.equal(mkVariants([{ axis: 'deploy', default: 'lots' }]).error, 'VARIANTS_UNKNOWN_OPTION');
  });

  test('**combat 硬闸门**：声明了口径却不标 `combat: true` ⇒ `VARIANTS_NEED_COMBAT`', () => {
    // 一个口径改的是对局结果（部署位 / 练度），所以它必须进房间摘要闸门与 golden 语料。
    const needs = mk({ variants: [{ axis: 'deploy', default: 'max' }] });
    assert.equal(needs.ok, false, JSON.stringify(needs));
    assert.equal(needs.error, 'VARIANTS_NEED_COMBAT');
    // `combat` 的**类型**错误先报：作者该改的是类型，不是缺一个 true
    assert.equal(mk({ combat: 'yes', variants: [{ axis: 'deploy' }] }).error, 'BAD_COMBAT');
    // 标了就是合法包
    const ok = mkVariants([{ axis: 'deploy', default: 'max' }]);
    assert.equal(ok.ok, true, ok.detail);
  });

  test('`EMPTY_PACK` 优先于 `VARIANTS_NEED_COMBAT`：口径**不是**贡献项', () => {
    // 一个只声明了口径、什么都没带来的包，真问题是「什么都没带来」——照 `playtest` / `support` 的既有语义。
    // 这一条用**没有** `operators` 的底盘：两份判据各自成立时，先报的是「空包」那一个。
    const only = normalizePackManifest({ id: 'p', name: 'p', content: [], variants: [{ axis: 'deploy' }] }, 'p');
    assert.equal(only.ok, false);
    assert.equal(only.error, 'EMPTY_PACK');
    assert.match(only.detail, /"variants" is NOT a contribution/);
    // 而**有**贡献的口径包，缺 `combat` 时拿到的才是 `VARIANTS_NEED_COMBAT`（上面那条已在测）
    const contributed = mk({ variants: [{ axis: 'deploy' }] });
    assert.equal(contributed.error, 'VARIANTS_NEED_COMBAT');
  });

  test('**既有的静默失败一并修掉**：`content` 里不认识的条目从前被安静过滤，现在点名拒', () => {
    // 本刀之前这里举的例子是 `["chess","variants"]`（那时 `variants` 没有通道）。0.18.6 给它建了通道
    // （DESIGN §28.51），所以「不认识的条目」改用仍然**刻意没有通道**的 `config` 举例 —— 判据本身一个字没放松。
    const r = mk({ content: ['chess', 'config'] });
    assert.equal(r.ok, false, '一个不认识的 content 条目不许再被静默丢掉');
    assert.equal(r.error, 'UNKNOWN_CONTENT_FILE');
    assert.match(r.detail, /"config"/);
    assert.match(r.detail, /NO content channel/);
    // 拼错的表名同样点名（不存在的表一个字都不许被读）
    assert.equal(mk({ content: ['ches'] }).error, 'UNKNOWN_CONTENT_FILE');
    // 非字符串条目也拒，而不是被 filter 吃掉
    assert.equal(mk({ content: [7] }).error, 'UNKNOWN_CONTENT_FILE');
    // `content` 本身不是数组 ⇒ 另一条码（不是「空数组」那个合法形状）
    assert.equal(mk({ content: 'chess' }).error, 'BAD_CONTENT_LIST');
    // 合法的 content 一字不变（含本刀新开的 `variants`，它排序后落在末尾）
    const good = normalizePackManifest({ id: 'p', name: 'p', content: ['chess', 'items'] }, 'p');
    assert.equal(good.ok, true, good.detail);
    assert.deepEqual(good.pack.content, ['chess', 'items']);
    const withVariants = normalizePackManifest({ id: 'p', name: 'p', content: ['variants', 'chess'] }, 'p');
    assert.equal(withVariants.ok, true, withVariants.detail);
    assert.deepEqual(withVariants.pack.content, ['chess', 'variants']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('缺省逐字节不变', () => {
  test('不声明 `variants` 的包：归一化清单里**没有**这个键（多一个键 = 所有已发布包哈希全变）', () => {
    const p = mk().pack;
    assert.equal(Object.hasOwn(p, 'variants'), false);
    // 显式 null / undefined 等于没写（与 `api` / `layer` 的既有语义逐字一致）
    assert.equal(Object.hasOwn(mk({ variants: null }).pack ?? {}, 'variants'), false);
  });

  test('口径 → 数据动作：缺省 / 没声明 ⇒ `null`（调用方据此一个字节都不动）', () => {
    assert.equal(variantDataPatch(null), null);
    assert.equal(variantDataPatch([]), null);
    assert.equal(variantDataPatch(undefined), null);
    assert.equal(variantDataPatch(parseVariantsDecl([{ axis: 'deploy' }]).decl), null, '缺省选项 = 引擎今天的行为');
    assert.equal(variantDataPatch(parseVariantsDecl([{ axis: 'training', default: 'full' }]).decl), null,
      'training 缺省不给数据动作：练度是玩家自己的干员调配设置，不是数据里第二套数值');
    assert.deepEqual(variantDataPatch(parseVariantsDecl([{ axis: 'deploy', default: 'max' }]).decl),
      { economy: { deployCap: DEPLOY_CAP_MAX } });
  });

  test('`GameData.deployCap`：不给口径 ⇒ 逐字是数据里那个 8（官方 maxBattleChessCnt）', () => {
    const data = { chess: {}, config: { economy: { deployCap: 8 } } };
    assert.equal(new GameData(data, 'mode_multi_hard').deployCap, 8);
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: [] }).deployCap, 8);
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: null }).deployCap, 8);
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: parseVariantsDecl([{ axis: 'deploy' }]).decl }).deployCap, 8);
    // 真数据：`data/config.json` 那份 8 一个字节没动
    const real = JSON.parse(fs.readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
    assert.equal(real.economy.deployCap, 8);
    assert.equal(real.economy.deployCap, VARIANT_AXES.deploy.default === 'official' ? 8 : -1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('口径真生效（两个方向）', () => {
  const data = { chess: {}, config: { economy: { deployCap: 8 } } };
  const decl = (v) => parseVariantsDecl(v).decl;

  test('`deploy: "max"` ⇒ 本局部署位 12；`deploy: "official"` ⇒ 回到数据里那个 8', () => {
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: decl([{ axis: 'deploy', default: 'max' }]) }).deployCap, DEPLOY_CAP_MAX);
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: decl([{ axis: 'deploy', default: 'official' }]) }).deployCap, 8);
  });

  test('口径是**天花板**：一份被裁过的 data（没有 `deployCap` 键）也拿得到 12', () => {
    const bare = { chess: {}, config: {} };
    assert.equal(new GameData(bare, 'mode_multi_hard', { variants: decl([{ axis: 'deploy', default: 'max' }]) }).deployCap, DEPLOY_CAP_MAX);
  });

  test('`DEPLOY_CAP_MAX` 就是既有的那个 12（`setDeployCapAtLeast` 的天花板），不是第二处硬编码', () => {
    const src = fs.readFileSync(join(ROOT, 'server', 'match', 'effectsMeta.js'), 'utf8');
    assert.match(src, /Math\.min\(v, DEPLOY_CAP_MAX\)/, '销毁类装备的天花板必须读同一个常量');
    assert.equal(/Math\.min\(v, 12\)/.test(src), false, '硬编码的 12 不许留在第二处');
    assert.equal(DEPLOY_CAP_MAX, 12);
  });

  test('`variantValue` / `variantIsDefault` 的两个方向（防「只测开不测关」）', () => {
    const on = decl([{ axis: 'deploy', default: 'max' }, { axis: 'training', default: 'official' }]);
    const off = decl([{ axis: 'deploy', default: 'official' }, { axis: 'training', default: 'full' }]);
    assert.equal(variantValue(on, 'deploy'), 'max');
    assert.equal(variantValue(off, 'deploy'), 'official');
    assert.equal(variantValue(on, 'nope'), null);
    assert.equal(variantIsDefault(on, 'deploy'), false);
    assert.equal(variantIsDefault(off, 'deploy'), true, '选了缺省选项 = 什么都不动');
    assert.equal(variantIsDefault(on, 'training'), false);
    assert.equal(variantIsDefault(off, 'training'), true);
  });

  test('多包合成：口径按既有的「包 id 字典序小的赢」，输的一方被点名（不是静默）', () => {
    const { decl: merged, overridden } = mergeVariantDecls([
      { id: 'b-pack', variants: [{ axis: 'deploy', default: 'max' }] },
      { id: 'a-pack', variants: [{ axis: 'deploy', default: 'official' }] },
    ]);
    assert.deepEqual(merged, [{ axis: 'deploy', default: 'official', by: 'a-pack' }]);
    assert.deepEqual(overridden, [{ axis: 'deploy', by: 'b-pack', lostTo: 'a-pack', value: 'max' }]);
    // 不依赖调用方传进来的顺序
    const other = mergeVariantDecls([
      { id: 'a-pack', variants: [{ axis: 'deploy', default: 'official' }] },
      { id: 'b-pack', variants: [{ axis: 'deploy', default: 'max' }] },
    ]);
    assert.deepEqual(other.decl, merged);
    // 不同轴各占一个，互不干扰
    const both = mergeVariantDecls([
      { id: 'a', variants: [{ axis: 'deploy', default: 'max' }] },
      { id: 'b', variants: [{ axis: 'training', default: 'official' }] },
    ]);
    assert.deepEqual(both.decl.map((e) => e.axis), ['deploy', 'training']);
    assert.deepEqual(both.overridden, []);
    // 没有包 / 包没有声明 ⇒ 空（缺省路径）
    assert.deepEqual(mergeVariantDecls([]).decl, []);
    assert.deepEqual(mergeVariantDecls([{ id: 'a' }]).decl, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('进身份哈希（DESIGN §28.2）与真装载', () => {
  /** 一份真实落盘的包：`<root>/<id>/pack.json` + 一个合法贡献（`operators` 声明，不需要数据文件）。 */
  const writePack = (root, id, pack) => {
    fs.mkdirSync(join(root, id), { recursive: true });
    fs.writeFileSync(join(root, id, 'pack.json'), JSON.stringify(pack, null, 2));
  };
  const CONTRIB = { content: [], operators: { char_x: { powers: [], bonds: [] } } };

  test('声明了口径的包：内容哈希与「没声明」的包**必须不同**（同一个摘要下两种行为是不允许的）', () => {
    const root = join(tmp, 'hash');
    writePack(root, 'base', { id: 'base', name: 'Base', ...CONTRIB });
    writePack(root, 'max', { id: 'max', name: 'Max', combat: true, ...CONTRIB, variants: [{ axis: 'deploy', default: 'max' }] });
    writePack(root, 'official', { id: 'official', name: 'Official', combat: true, ...CONTRIB, variants: [{ axis: 'deploy', default: 'official' }] });
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const by = (id) => loaded.packs.find((p) => p.id === id);
    const base = by('base'), max = by('max'), official = by('official');
    assert.ok(base && max && official);
    assert.equal(Object.hasOwn(base, 'variants'), false, '没声明的包不该有这个键');
    assert.deepEqual(base.variants, undefined);
    assert.notEqual(max.hash, base.hash, '口径必须进内容哈希');
    assert.notEqual(max.hash, official.hash, '只差口径的两份包摘要必须不同（`max` 与 `official` 是两种对局行为）');
    // 归一化后的声明原样送到装载结果（B 段 / 房间要读的就是它）
    assert.deepEqual(max.variants, [{ axis: 'deploy', default: 'max', name: null, desc: null }]);
    // 同一个包反复装载：摘要稳定
    assert.equal(loadWorkshop(root, { log: quiet }).packs.find((p) => p.id === 'max').hash, max.hash);
  });

  test('声明口径的包能真的装进 `loadData`，且不声明口径时数据一个字节都不动', async () => {
    const { loadData } = await import('../server/data.js');
    const plainRoot = join(tmp, 'plain');
    writePack(plainRoot, 'plain', { id: 'plain', name: 'Plain', ...CONTRIB });
    const variantRoot = join(tmp, 'varianted');
    writePack(variantRoot, 'var', { id: 'var', name: 'Var', combat: true, ...CONTRIB, variants: [{ axis: 'deploy', default: 'max' }] });

    const plain = loadData(DATA_DIR, { log: quiet, workshopDir: plainRoot });
    const withVar = loadData(DATA_DIR, { log: quiet, workshopDir: variantRoot });

    // 缺省路径：`data/` 里的每一个顶层键逐字节相同（overlay 只加内容，口径不是内容）
    for (const key of Object.keys(plain)) {
      assert.deepEqual(Object.keys(withVar).sort(), Object.keys(plain).sort(), '顶层键集合不许变');
      assert.equal(JSON.stringify(withVar[key]), JSON.stringify(plain[key]), `${key}: 没有包声明口径时数据必须逐字节不变`);
      break;
    }
    // 两条路径的 `economy.deployCap` 都还是数据里那份 8 —— 口径**不写进 data**，它只改这一局的 GameData
    assert.equal(plain.config.economy.deployCap, 8);
    assert.equal(withVar.config.economy.deployCap, 8);
    // 而 `data/*.json` 在磁盘上仍然是一个字节都没被动过
    assert.equal(JSON.parse(fs.readFileSync(join(DATA_DIR, 'config.json'), 'utf8')).economy.deployCap, 8);
  });

  test('装载结果 → 房间 mod 集合 → `Match` 的那条链真的带着口径（`modDigest` 只哈希 `[id, hash]`）', () => {
    // 这一条钉的是 `server/index.js` 构建 `workshopMods` 时的**投影**：口径必须跟着 mod 条目走，否则
    // `Match` 从 `mods.packs[].variants` 读到的是 `undefined`，口径**静默不生效** —— 那正是这一层要消灭的失败方向。
    // `modSetOf` 只按 `isModEntry`（id / hash / layer / combat / api）过滤、**不剥掉**别的键，所以投影是唯一的一环。
    const root = join(tmp, 'chain');
    writePack(root, 'chain', { id: 'chain', name: 'Chain', combat: true, ...CONTRIB, variants: [{ axis: 'deploy', default: 'max' }] });
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const pack = loaded.packs[0];
    // `server/index.js:187` 的那一份投影（口径在声明过时才存在，与 `voiceCdn` / `skins` 同一条纪律）
    const entry = {
      id: pack.id, hash: pack.hash, layer: pack.layer, combat: pack.combat, api: pack.api,
      ...(Array.isArray(pack.variants) && pack.variants.length ? { variants: pack.variants } : {}),
    };
    const set = modSetOf([entry]);
    assert.ok(set, '有包时必须算得出 mod 集合');
    assert.deepEqual(set.packs[0].variants, [{ axis: 'deploy', default: 'max', name: null, desc: null }]);
    // 摘要**只**认 `[id, hash]`：带上口径不改变任何摘要（改摘要等于让每个老包在同一条房间里被判成另一个包）
    assert.equal(set.digest, modSetOf([{ id: pack.id, hash: pack.hash, layer: pack.layer, combat: pack.combat, api: pack.api }]).digest);
    // 一路走到 `GameData`
    const data = { chess: {}, config: { economy: { deployCap: 8 } } };
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: mergeVariantDecls(set.packs).decl }).deployCap, DEPLOY_CAP_MAX);
    // 没声明口径的包：投影里没有这个键，合成出空表，部署位逐字是 8
    const plain = loadWorkshop(join(tmp, 'hash'), { log: quiet }).packs.find((p) => p.id === 'base');
    assert.equal(Object.hasOwn(plain, 'variants'), false);
    assert.deepEqual(mergeVariantDecls([{ id: plain.id, hash: plain.hash, layer: plain.layer, combat: plain.combat, api: plain.api }]).decl, []);
    assert.equal(new GameData(data, 'mode_multi_hard', { variants: [] }).deployCap, 8);
  });
});
