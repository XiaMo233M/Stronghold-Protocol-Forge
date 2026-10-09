// 干员包通道（`_up/pack-operator-channel.md`）：一个工坊包**新增一个干员**的三件东西 —— 干员记录（`content: ["units"]`）、
// 自选池声明（`pack.json.operators`）、技能与分支图标（`pack.json.art.skills` / `art.profSub`）。
//
// 为什么需要它们：社区 mod「克莱门莎」是**就地补丁** —— 它往 `data/backups.json` 的 `units` 加一条记录、往
// `diy.ownedPool` 加一个 id、往 `assets.json` 的 `skills` / `prof.sub` 加图标。这三处以前**没有包通道**：
// `WORKSHOP_CONTENT_FILES` 里没有 `units`，`ASSET_TABLES` 里没有那两张扁平表，装载器会把它们静默过滤掉
// （`_up/clemnt-pack-probe.mjs` 的 before 证据）。补上之后，「新增一个干员」在 A 层是**一等公民**，作者不用再
// 手改我们的生成物（那会被下一次 `npm run build-data` 整条抹掉）。
//
// 三条载重承诺，全部在这里钉住：
//   * `data/*.json` 一个字节都不改（叠加发生在 `deepFreeze` 之前，`docs/WORKSHOP.md` §1.3）—— 所以生成器契约
//     （`test/backups.test.js` 对**文件**的断言，`ownedPool.length === 71`）完全不受影响；
//   * 每一条拒绝都**点名**并**失败关闭**（没有干员记录 / 不是 6★ / 盟约 id 不存在 / 形态不齐 / 两个包抢同一个 id）；
//   * 落盘位置是**真实数据布局**：`data/` 里没有顶层 `units.json`，记录住在 `data.backups.units[charId]`。
//
// Run: node --test test/workshopOperators.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  normalizePackManifest, normalizeContentFile, applyWorkshop, workshopSummary, WORKSHOP_CONTENT_FILES,
  UNIT_REQUIRED_FIELDS, ART_TABLES,
} from '../shared/workshop.js';
import { requiredUnitForms } from '../shared/diy.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
/** 端到端夹具（`docs/examples/clementia/README.md`）：社区 mod「克莱门莎」的 payload 按包格式写了一遍。
 *  它**本身就是一个包目录**（与 `docs/examples/kit-demo` 同一个布局：`docs/examples/` 是仓库里既有的工坊根，
 *  加载器要求它的每个子目录都是一条能读的包，所以夹具不能再套一层根目录）。 */
const FIXTURE_PACK = join(ROOT, 'docs/examples/clementia');
/** 一个只装着这一个包的临时工坊根 —— 加载器是按 `<根>/<包 id>/pack.json` 找包的。 */
const makeFixtureRoot = () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sp-ws-clemnt-'));
  fs.cpSync(FIXTURE_PACK, join(dir, 'clementia'), { recursive: true });
  return dir;
};
const HER = 'char_4231_clemnt';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const load = (f) => JSON.parse(fs.readFileSync(join(DATA_DIR, `${f}.json`), 'utf8'));
const OFFICIAL_UNITS = load('backups').units;
/** 官方两份数据只读一次：形态档位（`requiredUnitForms`）与盟约合法性都从它们派生。 */
const OFFICIAL_BACKUPS = load('backups');
const OFFICIAL_CHESS = load('chess');
/** `data/backups.json` 的官方自选池长度（生成物契约里的那个 71 —— 这里读它、不改它）。 */
const OFFICIAL_POOL = OFFICIAL_BACKUPS.diy.ownedPool.length;
/** 一条官方干员记录，作为「包自带一条干员记录」的模板（字段照抄，只换身份）。 */
const TEMPLATE = OFFICIAL_UNITS[Object.keys(OFFICIAL_UNITS)[0]];

/** 官方 forms 的档位键（`2/1/4/0`）——一份**完整**的形态集合，供不受形态规则影响的用例使用。
 *  注意两份数据都要喂：档位是从 `diy.slots` 指向的**那两条 chess 记录**的 `status` 派生的。 */
const ALL_FORMS = Object.fromEntries(
  requiredUnitForms({ chess: OFFICIAL_CHESS, backups: OFFICIAL_BACKUPS }).map((k) => [k, { statusKey: k }]),
);

/** 一条形状合法的 `units.json` 记录（字段与官方记录同形，身份换成包自己的）。 */
const unitRec = (charId, extra = {}) => ({
  ...JSON.parse(JSON.stringify(TEMPLATE)),
  charId,
  name: '测试干员',
  rarity: 6,
  profession: 'WARRIOR',
  subProfessionId: 'primguard',
  forms: JSON.parse(JSON.stringify(ALL_FORMS)),
  ...extra,
});

/** 官方数据的一份干净副本（`backups` 是叠加层唯一会写的那一块）。
 *  `diy` **整块**照抄：`diy.slots` 是形态规则（`requiredUnitForms`）与自选池语义的输入，少一个键就会让
 *  「缺档位」这类判据静默失效（它变成「没有槽位要求」）—— 那样测试自己就成了假的。 */
const baseData = () => ({
  chess: load('chess'),
  bonds: load('bonds'),
  assets: { chars: {}, skills: { skchr_official_1: '/assets/skill/skchr_official_1.png' }, prof: { sub: { fastshot: '/assets/prof/sub/fastshot.png' } } },
  backups: {
    units: JSON.parse(JSON.stringify(OFFICIAL_UNITS)),
    diy: JSON.parse(JSON.stringify(load('backups').diy)),
  },
});

/** 一个已加载包的替身：只有 `applyWorkshop` 读的那几个字段。 */
const pack = (id, files, extra = {}) => ({ id, name: id, overrides: [], files, ...extra });

const errorsOf = (report, code) => report.errors.filter((e) => e.code === code);

describe('干员包: units 内容文件（pack.json content 的一个成员）', () => {
  test('`units` 是内容文件之一，且它的记录自检读 charId', () => {
    assert.ok(WORKSHOP_CONTENT_FILES.includes('units'), 'units 必须能出现在 pack.json 的 content 里');
    assert.ok(WORKSHOP_CONTENT_FILES.includes('chess'), 'chess 不能被挤掉');
    assert.equal(WORKSHOP_CONTENT_FILES.includes('config'), false, 'config 依旧被排除（它改的是规则）');
    // 记录自带的 id 字段必须等于键（沿用既有「记录自检」手法）
    const bad = normalizeContentFile('units', { char_a: unitRec('char_b') });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'ID_MISMATCH');
    assert.match(bad.detail, /char_b/, '提示里要能读到记录自己写的那个 id');
  });

  test('形状合法的一条记录通过，其余字段**原样照抄**（不复制官方 schema）', () => {
    const rec = unitRec('char_ws_new', { 自定义字段: { 随便: 1 }, appellation: '测试' });
    const r = normalizeContentFile('units', { char_ws_new: rec });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.records.char_ws_new, rec, '我们没有权利丢作者照抄来的字段');
  });

  test('缺字段/写错类型逐条点名 —— 判据的 6 条声明就是那 6 个必填字段', () => {
    assert.deepEqual(UNIT_REQUIRED_FIELDS.map((f) => f.key),
      ['charId', 'name', 'rarity', 'profession', 'subProfessionId', 'forms']);
    const cases = [
      [{ charId: undefined }, 'UNIT_MISSING_CHAR_ID'],
      [{ name: '' }, 'UNIT_MISSING_NAME'],
      [{ rarity: '6' }, 'UNIT_BAD_RARITY'],
      [{ rarity: 6.5 }, 'UNIT_BAD_RARITY'],
      [{ profession: null }, 'UNIT_MISSING_PROFESSION'],
      [{ subProfessionId: 42 }, 'UNIT_MISSING_SUB_PROFESSION'],
      [{ forms: {} }, 'UNIT_BAD_FORMS'],
      [{ forms: [] }, 'UNIT_BAD_FORMS'],
      [{ forms: undefined }, 'UNIT_BAD_FORMS'],
    ];
    for (const [patch, code] of cases) {
      const r = normalizeContentFile('units', { char_ws_new: unitRec('char_ws_new', patch) });
      assert.equal(r.ok, false, `${JSON.stringify(patch)} 必须被拒`);
      assert.equal(r.error, code, `${JSON.stringify(patch)}: 期望 ${code}，实际 ${r.error}（${r.detail}）`);
      assert.match(r.detail, /^units\.json\["char_ws_new"\]\./, `${code}: 提示必须指到具体是哪一条的哪个字段`);
    }
    // 其它内容文件不受这套规则影响（只有 units 查这六个字段）
    const chess = normalizeContentFile('chess', { chess_x: { chessId: 'chess_x' } });
    assert.equal(chess.ok, true, 'chess 记录的必填字段是另一回事');
  });
});

describe('干员包: units 并进 data.backups.units（落盘位置 = 真实数据布局）', () => {
  test('新 charId 直接进 backups.units，且 data/ 里没有顶层 units 这一项', () => {
    const base = baseData();
    const files = { units: { char_ws_new: unitRec('char_ws_new') } };
    const { data, report } = applyWorkshop(base, [pack('p1', files)]);
    assert.ok(data.backups.units.char_ws_new, '`data.backups.units[charId]` 就是它的家（server/sim/simdata.js、shared/standIn.js、客户端都只读这里）');
    assert.equal(data.units, undefined, '`data/` 里没有顶层 units.json，叠加层不该发明一个');
    assert.equal(Object.keys(data.backups.units).length, Object.keys(OFFICIAL_UNITS).length + 1);
    assert.deepEqual(report.added.units, ['char_ws_new']);
    assert.deepEqual(report.errors, []);
    // 输入没有被改写（调用方拿去 deepFreeze）
    assert.equal(base.backups.units.char_ws_new, undefined);
  });

  test('撞官方 charId 而未声明 → 拒绝 + 点名，官方那条保留', () => {
    const id = Object.keys(OFFICIAL_UNITS).find((k) => Object.hasOwn(OFFICIAL_UNITS, k));
    const base = baseData();
    const hostile = unitRec(id, { name: '冒充' });
    const silent = applyWorkshop(base, [pack('evil', { units: { [id]: hostile } })]);
    assert.equal(silent.data.backups.units[id].name, OFFICIAL_UNITS[id].name, '没有声明就不能替换官方记录');
    assert.equal(errorsOf(silent.report, 'OFFICIAL_ID_COLLISION').length, 1);
    assert.match(silent.report.errors[0].reason, new RegExp(`units:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'reason 里要能读到该写进 overrides 的那一行');
    // 声明了就能替换（沿用既有 overrides 契约）
    const declared = applyWorkshop(base, [pack('ok', { units: { [id]: hostile } }, { overrides: [`units:${id}`] })]);
    assert.equal(declared.data.backups.units[id].name, '冒充');
    assert.deepEqual(declared.report.errors, []);
    assert.deepEqual(declared.report.overridden.units, [id]);
  });

  test('两个包给同一个新 charId：包 id 字典序最小者赢，且与传入顺序无关', () => {
    const files = (name) => ({ units: { char_ws_tie: unitRec('char_ws_tie', { name }) } });
    const claim = (id, name) => pack(id, files(name));
    const alpha = claim('alpha', 'A');
    const zeta = claim('zeta', 'Z');
    const runs = [[zeta, alpha], [alpha, zeta]].map((packs) => applyWorkshop(baseData(), packs));
    for (const { data, report } of runs) {
      assert.equal(data.backups.units.char_ws_tie.name, 'A', '包 id 小的那个赢');
      assert.equal(errorsOf(report, 'PACK_ID_COLLISION').length, 1);
      assert.equal(report.errors[0].pack, 'zeta', '输的一方得到那条报告');
      assert.equal(report.errors[0].definedBy, 'alpha', '报告点名占住它的包');
    }
    assert.deepEqual(runs[0].report.errors, runs[1].report.errors, '换一个传入顺序，判罚逐字相同');
    assert.deepEqual(runs[0].data.backups.units.char_ws_tie, runs[1].data.backups.units.char_ws_tie);
  });

  test('缺 diy 清单时报告 MANIFEST_MISSING，不凭空造一份池子', () => {
    // `backups` 在、但 `diy` 不在：记录并得进去（它就是为这一层而来的），池子却没有落点
    // （`chess` 也要给：形态档位是从 `diy.slots` 指向的那两条 chess 记录的 status 派生的）
    const { data, report } = applyWorkshop(
      { chess: OFFICIAL_CHESS, backups: { units: {} } },
      [pack('p1', { units: { char_ws_new: unitRec('char_ws_new') } }, { operators: { char_ws_new: {} } })],
    );
    assert.equal(data.backups.units.char_ws_new.name, '测试干员');
    assert.equal(data.backups.diy, undefined, '没有 diy 就只并记录，不发明一个池子');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'MANIFEST_MISSING');
    assert.match(report.errors[0].reason, /diy/);
    // `backups` 整块缺失时只并记录，一条报错都没有（没有池子要发布，也就没有可抱怨的对象）
    const none = applyWorkshop({ chess: OFFICIAL_CHESS }, [pack('p1', { units: { char_ws_new: unitRec('char_ws_new') } })]);
    assert.equal(none.data.backups.units.char_ws_new.name, '测试干员');
    assert.deepEqual(none.report.errors, []);
  });

  test('把 units 标成 backups 这个被触及的文件（浏览器要拿合并后的那一个）', () => {
    const loaded = { packs: [pack('p1', { units: { char_ws_new: unitRec('char_ws_new') } })] };
    assert.deepEqual([...workshopTouchedFiles(loaded)], ['backups'], 'data/ 里没有顶层 units.json —— 要合并送达的是 backups.json');
  });
});

describe('干员包: pack.json.operators（自选池声明）', () => {
  const norm = (extra = {}) => normalizePackManifest(
    { id: 'my-pack', content: ['units'], ...extra }, 'my-pack', { hasAssets: false });

  test('形状：对象（每个干员带盟约与权能），bonds/powers 去重并排序，键按 id 排序', () => {
    const r = norm({ operators: {
      char_b: { bonds: ['yanShip', 'yanShip'], powers: ['sui', 'yan'] },
      char_a: {},
    } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.operators, {
      char_a: { powers: [], bonds: [] },
      char_b: { powers: ['sui', 'yan'], bonds: ['yanShip'] },
    }, '缺省的列表读成空表（不是 undefined），键序不随作者书写顺序变（清单的字节要可复现）');
    assert.deepEqual(norm().pack.operators, {}, '没声明 → 空对象，绝不留 undefined');
  });

  test('每个 OPERATOR_BAD_SHAPE：不是对象 / 不是数组 / 成员不是字符串 / id 不合法', () => {
    const cases = [
      [{ operators: ['char_a'] }, /operators must be an object/],
      [{ operators: { char_a: 'egirShip' } }, /operators\["char_a"\] must be an object/],
      [{ operators: { char_a: { bonds: 'yanShip' } } }, /bonds must be an array/],
      [{ operators: { char_a: { powers: ['ok', 42] } } }, /powers: "42" is not a valid id/],
      [{ operators: { 'bad id!': {} } }, /is not a valid operator id/],
    ];
    for (const [extra, re] of cases) {
      const r = norm(extra);
      assert.equal(r.ok, false, `${JSON.stringify(extra)} 必须被拒`);
      assert.equal(r.error, 'OPERATOR_BAD_SHAPE');
      assert.match(r.detail, re);
    }
  });

  test('只带 operators 的包也是包（content 可以为空）', () => {
    const r = normalizePackManifest({ id: 'p', content: [], operators: { char_a: {} } }, 'p', {});
    assert.equal(r.ok, true, r.detail);
    assert.equal(normalizePackManifest({ id: 'p', content: [] }, 'p', {}).error, 'EMPTY_PACK', '什么都没有仍然是空包');
  });

  test('字段派生：name/rarity/profession/subProfessionId/obtainable 来自本包那条 units 记录', () => {
    const rec = unitRec('char_ws_new', { name: '派生出来的名字', rarity: 6, profession: 'SNIPER', subProfessionId: 'fastshot' });
    const { data, report } = applyWorkshop(baseData(), [
      pack('p1', { units: { char_ws_new: rec } }, { operators: { char_ws_new: { bonds: ['egirShip'], powers: ['egir'] } } }),
    ]);
    assert.deepEqual(data.backups.diy.operators.char_ws_new, {
      name: '派生出来的名字', rarity: 6, profession: 'SNIPER', subProfessionId: 'fastshot',
      obtainable: true, powers: ['egir'], bonds: ['egirShip'],
    }, '清单里不重复写这四个字段：它们只能从记录派生（两份真相会漂移）');
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL + 1, '进池');
    assert.ok(data.backups.diy.ownedPool.includes('char_ws_new'));
    assert.equal(data.backups.diy.ownedPool.filter((id) => id === 'char_ws_new').length, 1, '只加一次');
    assert.deepEqual(report.operators, { p1: ['char_ws_new'] });
    assert.deepEqual(report.errors, []);
    assert.match(workshopSummary(report), /自选池 \+1/);
  });

  test('OPERATOR_NO_UNIT：没有同名的 units 记录 → 拒绝 + 点名，池子不动', () => {
    const { data, report } = applyWorkshop(baseData(), [pack('p1', {}, { operators: { char_ws_ghost: {} } })]);
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL);
    assert.equal(data.backups.diy.operators.char_ws_ghost, undefined);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'OPERATOR_NO_UNIT');
    assert.match(report.errors[0].reason, /char_ws_ghost/);
    assert.match(report.errors[0].reason, /units\.json/, '提示要说清去哪里声明');
  });

  test('OPERATOR_NOT_SIX：非 6★ 被拒，并指向工坊棋子注册表那条路', () => {
    const rec = unitRec('char_ws_five', { rarity: 5 });
    const { data, report } = applyWorkshop(baseData(), [
      pack('p1', { units: { char_ws_five: rec } }, { operators: { char_ws_five: {} } }),
    ]);
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL);
    assert.equal(data.backups.units.char_ws_five.name, '测试干员', '干员记录本身照常并进去（只有进池被拒）');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'OPERATOR_NOT_SIX');
    assert.match(report.errors[0].reason, /content\.chess/, 'reason 要指到 5★ 该走的那条路');
  });

  test('OPERATOR_BOND_UNKNOWN：盟约 id 不存在 → 拒绝 + 点名（静默失效的大门）', () => {
    const rec = unitRec('char_ws_new');
    const { data, report } = applyWorkshop(baseData(), [
      pack('p1', { units: { char_ws_new: rec } }, { operators: { char_ws_new: { bonds: ['egirShip', 'noSuchShip'] } } }),
    ]);
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'OPERATOR_BOND_UNKNOWN');
    assert.match(report.errors[0].reason, /noSuchShip/, '写错的那个 id 必须出现在提示里');
    assert.match(report.errors[0].reason, /egirShip/, '提示要给出一个对照的合法例子');
    // 合法的那条（egirShip 在 data/bonds.json 里）通过
    const ok = applyWorkshop(baseData(), [pack('p1', { units: { char_ws_new: rec } }, { operators: { char_ws_new: { bonds: ['egirShip'] } } })]);
    assert.deepEqual(ok.report.errors, []);
  });

  test('OPERATOR_FORM_MISSING：形态不齐 → 拒绝 + 点名缺的那一档（否则 golden / ci 会挂）', () => {
    const need = requiredUnitForms({ chess: load('chess'), backups: load('backups') });
    assert.ok(need.length >= 2, '自选槽的普通与精锐记录各自要求一个档位');
    // 缺最后一档（精锐 equipLevel 3）—— 这正是社区 mod 那条记录的实际情况
    const missing = need[need.length - 1];
    const forms = Object.fromEntries(Object.entries(ALL_FORMS).filter(([k]) => k !== missing));
    const rec = unitRec('char_ws_new', { forms });
    const { data, report } = applyWorkshop(baseData(), [
      pack('p1', { units: { char_ws_new: rec } }, { operators: { char_ws_new: {} } }),
    ]);
    assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL, '缺档位就是不进池');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'OPERATOR_FORM_MISSING');
    assert.match(report.errors[0].reason, new RegExp(missing.replace(/[/\\]/g, '\\$&')), `提示要点名缺的档位 ${missing}`);
    assert.match(report.errors[0].reason, /golden/, '提示要说清更重的那个后果（语料生成会抛异常）');
    // 齐了就过一次
    const ok = applyWorkshop(baseData(), [pack('p1', { units: { char_ws_new: unitRec('char_ws_new') } }, { operators: { char_ws_new: {} } })]);
    assert.deepEqual(ok.report.errors, []);
  });

  test('两个包声明同一个干员：最小包 id 赢，池子只多一个 id，两条面都点名', () => {
    const rec = () => ({ units: { char_ws_tie: unitRec('char_ws_tie') } });
    const decl = (bond) => ({ operators: { char_ws_tie: { bonds: [bond] } } });
    const alpha = pack('alpha', rec(), decl('egirShip'));
    const zeta = pack('zeta', rec(), decl('yanShip'));
    const runs = [[zeta, alpha], [alpha, zeta]].map((packs) => applyWorkshop(baseData(), packs));
    for (const { data, report } of runs) {
      assert.equal(data.backups.diy.ownedPool.length, OFFICIAL_POOL + 1, '一个 id 只进池一次');
      assert.equal(data.backups.diy.operators.char_ws_tie.bonds[0], 'egirShip', '包 id 小的那份声明生效');
      // 输的一方在**两条面**上都被点名：`units` 那条记录（内容文件层）与它的自选池声明（声明层）。
      // 两条都是实话 —— 记录被拒了，所以它其实没有可供声明的干员记录。
      const collisions = errorsOf(report, 'PACK_ID_COLLISION');
      assert.equal(collisions.length, 2, `两条面各点名一次，实际：${JSON.stringify(report.errors.map((e) => `${e.file}:${e.code}`))}`);
      assert.deepEqual(collisions.map((e) => e.file).sort(), ['backups', 'units']);
      for (const e of collisions) {
        assert.equal(e.pack, 'zeta', '输的一方是 zeta');
        assert.equal(e.definedBy, 'alpha', '点名占住它的包');
      }
    }
    assert.deepEqual(runs[0].report.errors, runs[1].report.errors, '与传入顺序无关');
  });

  test('没有 backups/diy 时同样报告 MANIFEST_MISSING（不凭空造一份）', () => {
    const { data, report } = applyWorkshop(
      { backups: {} },
      [pack('p1', { units: { char_ws_new: unitRec('char_ws_new') } }, { operators: { char_ws_new: {} } })],
    );
    // 记录进得去（backups.units 是新建的），但池子没有落点
    assert.ok(data.backups.units.char_ws_new);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'MANIFEST_MISSING');
    assert.match(report.errors[0].reason, /diy/);
  });
});

describe('干员包: 两张扁平图标表（art.skills / art.profSub）', () => {
  const norm = (art) => normalizePackManifest({ id: 'p', content: [], art, license: 'CC0-1.0' }, 'p', { hasAssets: true });

  test('两张表在 ART_TABLES 里，条目就是路径，落点由 target 给出', () => {
    assert.equal(ART_TABLES.skills.flat, true);
    assert.deepEqual(ART_TABLES.skills.target, ['skills']);
    assert.equal(ART_TABLES.profSub.flat, true);
    assert.deepEqual(ART_TABLES.profSub.target, ['prof', 'sub']);
    const r = norm({ skills: { skchr_x_1: 'skill/x1.png' }, profSub: { primguard: 'prof/sub/primguard.png' } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.art, { skills: { skchr_x_1: 'skill/x1.png' }, profSub: { primguard: 'prof/sub/primguard.png' } });
  });

  test('ART_PATH_UNSAFE：`../`、绝对路径、反斜杠、盘符逐条被拒', () => {
    for (const bad of ['../x.png', '/abs/x.png', 'a\\b.png', 'C:/x.png', '', './x.png']) {
      const r = norm({ skills: { skchr_x_1: bad } });
      assert.equal(r.ok, false, `"${bad}" 必须被拒`);
      assert.equal(r.error, 'ART_PATH_UNSAFE', `"${bad}": 期望 ART_PATH_UNSAFE，实际 ${r.error}`);
      assert.match(r.detail, /art\.skills\["skchr_x_1"\]/, '提示要指到具体哪一张表的哪一个 id');
    }
    assert.equal(norm({ profSub: { primguard: '../x.png' } }).error, 'ART_PATH_UNSAFE');
  });

  test('并进 assets.skills / assets.prof.sub：官方表整张保留，新增键加进去', () => {
    const base = baseData();
    const { data, report } = applyWorkshop(base, [
      pack('p1', {}, { art: { skills: { skchr_ws_1: 'skill/ws1.png' }, profSub: { primguard: 'prof/sub/primguard.png' } } }),
    ]);
    assert.equal(data.assets.skills.skchr_official_1, '/assets/skill/skchr_official_1.png', '官方那张表一个条目都不能少');
    assert.equal(data.assets.skills.skchr_ws_1, '/workshop-assets/p1/skill/ws1.png');
    assert.equal(data.assets.prof.sub.fastshot, '/assets/prof/sub/fastshot.png');
    assert.equal(data.assets.prof.sub.primguard, '/workshop-assets/p1/prof/sub/primguard.png');
    assert.deepEqual(Object.keys(data.assets.prof).sort(), ['sub'], 'prof 的其它键不被碰');
    assert.equal(base.assets.skills.skchr_ws_1, undefined, 'the input is never mutated');
    assert.deepEqual(report.flatArt, { p1: ['profSub.primguard', 'skills.skchr_ws_1'] });
    assert.match(workshopSummary(report), /2 icons/);
  });

  test('官方已有这个 id 时是替换（给官方技能/分支换图标），不是拒绝', () => {
    const { data, report } = applyWorkshop(baseData(), [pack('p1', {}, { art: { skills: { skchr_official_1: 'skill/mine.png' } } })]);
    assert.equal(data.assets.skills.skchr_official_1, '/workshop-assets/p1/skill/mine.png');
    assert.deepEqual(report.errors, []);
  });

  test('两个包抢同一个图标 id：包 id 最小者赢 + 点名，与传入顺序无关', () => {
    const claim = (id) => pack(id, {}, { art: { skills: { skchr_tie: `skill/${id}.png` }, profSub: { primguard: `prof/${id}.png` } } });
    const runs = [[claim('zeta'), claim('alpha')], [claim('alpha'), claim('zeta')]].map((packs) => applyWorkshop(baseData(), packs));
    for (const { data, report } of runs) {
      assert.equal(data.assets.skills.skchr_tie, '/workshop-assets/alpha/skill/alpha.png');
      assert.equal(data.assets.prof.sub.primguard, '/workshop-assets/alpha/prof/alpha.png');
      assert.equal(errorsOf(report, 'ASSET_COLLISION').length, 2, '两张表各一条点名报告');
      for (const e of report.errors) {
        assert.equal(e.pack, 'zeta');
        assert.equal(e.definedBy, 'alpha');
      }
    }
    assert.deepEqual(runs[0].report.errors, runs[1].report.errors);
  });

  test('缺 assets 清单时报告 MANIFEST_MISSING，不凭空造一张表', () => {
    const { data, report } = applyWorkshop({ backups: {} }, [pack('p1', {}, { art: { skills: { skchr_x: 'skill/x.png' } } })]);
    assert.equal(data.assets, undefined);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].code, 'MANIFEST_MISSING');
    assert.match(report.errors[0].reason, /assets\.json/);
  });

  test('两张表的 url 走同一条 /workshop-assets 路由，路径分段百分号编码（客户端零改动）', () => {
    // id 的字符集与其它记录 id 同一套 —— 校验发生在清单那一层（加载器只会把校验过的包交到这里）
    const badId = normalizePackManifest({ id: 'p', content: [], art: { skills: { 'skchr a#b': 'skill/x.png' } }, license: 'CC0-1.0' }, 'p', { hasAssets: true });
    assert.equal(badId.ok, false);
    assert.equal(badId.error, 'ART_BAD_ID', '空格与 # 不是合法 id');
    // 路径里合法的 `#` / 空格必须编码，否则 `#` 会把 URL 从此截断
    const r = applyWorkshop(baseData(), [pack('p1', {}, { art: { skills: { skchr_x: 'skill/a#b c.png' } } })]);
    assert.equal(r.data.assets.skills.skchr_x, '/workshop-assets/p1/skill/a%23b%20c.png');
  });
});

describe('干员包: 磁盘未被改写（生成器仍是唯一来源）', () => {
  const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  let ws;
  before(() => { ws = makeFixtureRoot(); });
  after(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

  test('装包前后 data/backups.json 与 data/assets.json 的 sha256 相同', () => {
    const files = ['backups', 'assets', 'chess', 'bonds'];
    const before = files.map((f) => sha(join(DATA_DIR, `${f}.json`)));
    const loaded = loadWorkshop(ws, { log: quiet });
    const base = loadData(DATA_DIR, { log: quiet, workshopDir: null });
    const { data } = applyWorkshop(base, loaded.packs);
    assert.ok(data.backups.units[HER], '夹具确实被并进去了（否则这条断言什么也没证明）');
    const after = files.map((f) => sha(join(DATA_DIR, `${f}.json`)));
    for (const [i, f] of files.entries()) {
      assert.equal(after[i], before[i], `data/${f}.json 被改写了 —— 生成物不该被动`);
    }
    // 生成器契约（对**文件**的断言）因此完全不受影响
    assert.equal(load('backups').diy.ownedPool.length, 71, '磁盘上的 ownedPool 仍是 71（test/backups.test.js 钉着它）');
    assert.equal(load('backups').units[HER], undefined, '磁盘上没有她');
  });

  test('buildWorkshopDataFiles 把被触及的 backups 与 assets 都算进去', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: ws });
    const files = buildWorkshopDataFiles(data, loaded);
    assert.deepEqual([...files.keys()].sort(), ['assets', 'backups'], '夹具触及 backups（干员记录 + 自选池）与 assets（图标 + 语音 + 外观）');
    const served = JSON.parse(files.get('backups').toString('utf8'));
    assert.ok(served.units[HER], '发出去的那份里有她');
    assert.equal(served.diy.ownedPool.length, 72);
  });
});

describe('干员包: 端到端（社区 mod「克莱门莎」当夹具）', () => {
  let srv;
  let ws;
  before(async () => {
    ws = makeFixtureRoot();
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws });
  });
  after(async () => {
    await srv?.close();
    if (ws) fs.rmSync(ws, { recursive: true, force: true });
  });

  test('加载器全绿：内容文件、自选池声明、两张图标表、语音、外观都被读到', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.errors, [], '夹具自己不能有加载错误');
    assert.deepEqual(loaded.packs.map((p) => p.id), ['clementia']);
    const p = loaded.packs[0];
    assert.deepEqual(p.content, ['units']);
    assert.deepEqual(Object.keys(p.files.units), [HER]);
    assert.deepEqual(p.operators, { [HER]: { powers: ['egir', 'iberia'], bonds: ['egirShip'] } });
    assert.deepEqual(Object.keys(p.art.skills), ['skchr_clemnt_1', 'skchr_clemnt_2', 'skchr_clemnt_3']);
    assert.deepEqual(Object.keys(p.art.profSub), ['primguard']);
    assert.equal(p.layer, 'A', '只有数据与素材 → A 层');
    assert.equal(p.combat, false, 'A 层不改战斗结果');
    // 干员记录的形状：社区 mod 抄的就是官方那 14 个字段
    const rec = p.files.units[HER];
    for (const k of ['charId', 'name', 'appellation', 'rarity', 'profession', 'subProfessionId', 'subProfessionName', 'position', 'nationId', 'isNotObtainable', 'assets', 'moduleNames', 'standsIn', 'forms']) {
      assert.ok(k in rec, `units[${HER}] 少了 "${k}"`);
    }
    assert.deepEqual(Object.keys(rec.forms), requiredUnitForms({ chess: load('chess'), backups: load('backups') }), '夹具的形态集合与自选槽要求的一致');
  });

  test('applyWorkshop 之后：干员记录 / 自选池 71→72 / 图标 / 双语语音全部就位', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    const base = loadData(DATA_DIR, { log: quiet, workshopDir: null });
    const { data, report } = applyWorkshop(base, loaded.packs);
    assert.deepEqual(report.errors, [], '夹具必须一条错都没有');

    // ① 干员记录
    assert.ok(data.backups.units[HER], 'data.backups.units[char_4231_clemnt] 在');
    assert.equal(data.backups.units[HER].name, '克莱门莎');
    assert.equal(data.backups.units[HER].rarity, 6);
    // ② 自选池 71 → 72
    assert.equal(base.backups.diy.ownedPool.length, 71);
    assert.equal(data.backups.diy.ownedPool.length, 72, 'ownedPool 71 → 72');
    assert.equal(data.backups.diy.ownedPool[71], HER, '追加在末尾（入池顺序只由包 id 排序决定）');
    // ③ diy.operators
    assert.deepEqual(data.backups.diy.operators[HER], {
      name: '克莱门莎', rarity: 6, profession: 'WARRIOR', subProfessionId: 'primguard',
      obtainable: true, powers: ['egir', 'iberia'], bonds: ['egirShip'],
    }, '字段从她那条 units 记录派生，盟约来自 pack.json.operators');
    // ④ 分支图标
    assert.equal(data.assets.prof.sub.primguard, '/workshop-assets/clementia/prof/sub/primguard.png');
    // ⑤ 三张技能图标
    for (const k of ['skchr_clemnt_1', 'skchr_clemnt_2', 'skchr_clemnt_3']) {
      assert.equal(data.assets.skills[k], `/workshop-assets/clementia/skill/${k}.png`, k);
    }
    // ⑥ 双语语音：默认档 = 日语（清单的 voiceLang），cn 在 voiceLangs
    const jp = data.assets.audio.voice[HER];
    assert.ok(jp, 'data.assets.audio.voice[char_4231_clemnt] 在（默认档 = 日语）');
    assert.equal(data.assets.audio.voiceLang, 'jp', '默认档就是日语（所以她的日语台词写在 voices 里）');
    const cn = data.assets.audio.voiceLangs.cn[HER];
    assert.ok(cn, 'data.assets.audio.voiceLangs.cn[char_4231_clemnt] 在');
    for (const slot of Object.keys(jp)) {
      for (const url of jp[slot]) assert.match(url, /^\/workshop-assets\/clementia\/audio\/voice\/jp\//);
    }
    for (const slot of Object.keys(cn)) {
      for (const url of cn[slot]) assert.match(url, /^\/workshop-assets\/clementia\/audio\/voice\/cn\//);
    }
    assert.ok(Object.keys(jp).length >= 4 && Object.keys(cn).length >= 4, '两种语种都真的带上了台词');
    // ⑦ 外观（头像 / 立绘 / spine）
    assert.equal(data.assets.chars[HER].avatar, '/workshop-assets/clementia/char/avatar/char_4231_clemnt.png');
    assert.equal(data.assets.chars[HER].spine.front.skel, '/workshop-assets/clementia/spine/op/char_4231_clemnt/front/char_4231_clemnt.skel');
    // ⑧ 一句汇总，读日志的人能认出这个包做了什么
    const summary = workshopSummary(report);
    assert.match(summary, /units \+1/);
    assert.match(summary, /自选池 \+1/);
    assert.match(summary, /4 icons/);
    assert.match(summary, /voice lines/);
  });

  test('浏览器拿到的那份 /data/backups.json 是合并后的（磁盘上那份没变）', async () => {
    const remote = await fetch(`${srv.url}/data/backups.json`).then((r) => r.json());
    assert.ok(remote.units[HER], '合并后的 backups.json 里有她');
    assert.equal(remote.diy.ownedPool.length, 72);
    assert.equal(remote.diy.operators[HER].bonds[0], 'egirShip');
    const onDisk = JSON.parse(fs.readFileSync(join(DATA_DIR, 'backups.json'), 'utf8'));
    assert.equal(onDisk.units[HER], undefined, 'data/backups.json 本身永不被改写');
    assert.equal(onDisk.diy.ownedPool.length, 71);
    // 图标与语音走的是同一份合并后的 assets.json
    const assets = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    assert.equal(assets.prof.sub.primguard, '/workshop-assets/clementia/prof/sub/primguard.png');
    assert.equal(assets.skills.skchr_clemnt_2, '/workshop-assets/clementia/skill/skchr_clemnt_2.png');
    assert.ok(assets.audio.voice[HER] && assets.audio.voiceLangs.cn[HER]);
  });

  test('她的 kit 不在这条通道里（本轮明确不做，见 brief §6）', () => {
    assert.equal(fs.existsSync(join(FIXTURE_PACK, 'kits')), false,
      '包 kit 的 import 权利未裁定（KIT_IMPORT 仍是 error），所以夹具不带 kits/ —— 这一条是「本轮范围」的守卫');
  });
});

describe('干员包: 临时工坊根的端到端（自造包，不依赖例子目录）', () => {
  let tmp;
  let ws;
  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-ws-op-'));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'op-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'op-pack', name: '新干员包', version: '1.0.0', content: ['units'],
      operators: { char_ws_tmp: { bonds: ['egirShip'], powers: ['egir'] } },
    }), 'utf8');
    fs.writeFileSync(join(dir, 'units.json'), JSON.stringify({ char_ws_tmp: unitRec('char_ws_tmp', { name: '临时干员' }) }), 'utf8');
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('加载 → 叠加 → 送达，一条链走通', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual([...workshopTouchedFiles(loaded)], ['backups']);
    const base = loadData(DATA_DIR, { log: quiet, workshopDir: null });
    const { data, report } = applyWorkshop(base, loaded.packs);
    assert.deepEqual(report.errors, []);
    assert.equal(data.backups.units.char_ws_tmp.name, '临时干员');
    assert.equal(data.backups.diy.operators.char_ws_tmp.name, '临时干员');
    assert.equal(data.backups.diy.ownedPool.length, 72);
  });
});
