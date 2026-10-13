// test/packEnabled.test.js — 包的启用声明（DESIGN §28.50）：`pack.json.enabled` + `shared/enabled.js`。
//
// 这一刀补的缺口：**装好 ≠ 生效**。`loadWorkshop` 今天读 `workshop/` 下每个目录，只要校验得过、有贡献项，
// 这个包就参与装载。于是「先留着、但现在不要它生效」没有表达方式 —— 只能删目录，而删目录与停用是两件事
// （删了要重新下载、重新校验、重新对齐房间摘要）。
//
// 判据按「缺省不变 → 响亮拒绝 → 真跳过」三层排，与 `test/workshopVariants.test.js` / `test/packBehaviour.test.js`
// 同构（三张表同一个形状，三份测试读起来是同一套东西）。**没有合成表**：这一格不需要第二张表 —— 值域就是
// 两个布尔，失败分支在真表下全部可达，所以每一条都被真路径走一遍。
//
// 来源：上游 PR#8（作者 jingjiangze）的 `shared/enabled.js` + 本文件，按内容并进本仓库；上游把这一格编到
// **§28.46**，而本仓库的 §28.46 已经是 `pack.json.target`（§28.46–§28.49 已占用），所以本节按**下一个空号**
// 落成 **§28.50**，正文与断言逐条对齐后随本刀一起落。
//
// Run: node --test test/packEnabled.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, PACK_FIELDS } from '../shared/workshop.js';
import { parseEnabledDecl, packEnabled, ENABLED_BAD_SHAPE, ENABLED_SKIP_CODE } from '../shared/enabled.js';
import { loadWorkshop, identifyPack } from '../server/workshop.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** `loadWorkshop` 要一个 log（装载器自己不打印，调用方才打印）—— 测试要的是安静的装载。 */
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let tmp;

before(() => { tmp = fs.mkdtempSync(join(tmpdir(), 'sp-enabled-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure */ } });

/** 造一个可装载的最小包（有贡献项，所以不会 `EMPTY_PACK`）。id 必须等于目录名（`identifyPack` 的硬规则）。 */
function writePack(name, packJson, files = { chess: { op_a: { name: 'A' } } }) {
  const dir = join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  // `name` 覆盖调用方给的 id：目录名是身份，`pack.json.id` 必须与它一致，否则 `identifyPack` 报
  // `PACK_ID_MISMATCH` —— 那是另一格的守卫，与本刀无关，不要让它在测试里变成噪声。
  fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ ...packJson, id: name }));
  for (const [file, records] of Object.entries(files)) {
    fs.writeFileSync(join(dir, `${file}.json`), JSON.stringify(records));
  }
  return dir;
}

const base = (extra) => ({ id: 'demo', name: 'Demo', license: 'MIT', ...extra });

// ---------------------------------------------------------------------------------------------------------------
describe('第一层：缺省 = 引擎今天的行为（一个字节都不变）', () => {
  test('不写 `enabled` ⇒ 归一化清单里不长出这个键（否则所有已发布包的内容哈希改变）', () => {
    const m = normalizePackManifest(base({ content: ['chess'] }), 'demo', {});
    assert.equal(m.ok, true, m.detail);
    assert.equal('enabled' in m.pack, false, '没声明的键不许出现在归一化清单里 —— §28.2 的内容哈希纪律');
    assert.equal(packEnabled(m.pack).enabled, true);
    assert.equal(packEnabled(m.pack).reason, null);
  });

  test('写了 `true` 与没写在数据上等价（同一份清单、同一个摘要）', () => {
    const off = normalizePackManifest(base({ content: ['chess'] }), 'demo', {});
    const on = normalizePackManifest(base({ content: ['chess'], enabled: true }), 'demo', {});
    assert.equal(on.ok, true, on.detail);
    // 两者都进入身份哈希（`identifyPack` 哈希 `canonicalJson(pack)`），但**值相同**，所以 digest 相同。
    const dirOff = writePack('eq-off', base({ content: ['chess'] }));
    const dirOn = writePack('eq-on', base({ content: ['chess'], enabled: true }));
    const idOff = identifyPack(dirOff, off.pack, { chess: { op_a: { name: 'A' } } });
    const idOn = identifyPack(dirOn, on.pack, { chess: { op_a: { name: 'A' } } });
    assert.equal(idOn.hash, idOff.hash, '`enabled: true` 不许改变包身份 —— 它必须与「没写」在数据上等价');
  });

  test('`enabled` 在 `PACK_FIELDS` 闭集里（不认的键会被 `PACK_UNKNOWN_FIELD` 拒）', () => {
    assert.equal(PACK_FIELDS.includes('enabled'), true);
    const m = normalizePackManifest(base({ content: ['chess'], enabled: true }), 'demo', {});
    assert.equal(m.ok, true, m.detail);
  });
});

describe('第二层：响亮拒绝（一个被 JS 真值表放行的假布尔是静默失效）', () => {
  for (const [label, raw] of [
    ['字符串 "false"', 'false'],
    ['字符串 "true"', 'true'],
    ['数字 0', 0],
    ['数字 1', 1],
    ['null', null],
    ['数组', []],
    ['对象', {}],
  ]) {
    test(`${label} ⇒ ENABLED_BAD_SHAPE 整包拒`, () => {
      const r = parseEnabledDecl(raw);
      assert.equal(r.ok, false);
      assert.equal(r.error, ENABLED_BAD_SHAPE);
      // 拒绝必须**点名**写的是什么，不只说「坏了」—— 否则作者要去猜是哪一格。
      assert.match(r.detail, /must be a boolean/);
    });
  }

  test('坏形状经 `normalizePackManifest` 变成整包拒绝（不是忽略那一格）', () => {
    const m = normalizePackManifest(base({ content: ['chess'], enabled: 'false' }), 'demo', {});
    assert.equal(m.ok, false);
    assert.equal(m.error, ENABLED_BAD_SHAPE);
  });

  test('坏形状的包也判 false：`packEnabled` 与形状层同判据', () => {
    const r = packEnabled({ enabled: 'false' });
    assert.equal(r.enabled, false);
    assert.match(r.reason, new RegExp(ENABLED_BAD_SHAPE));
  });
});

describe('第三层：真跳过（装载期读一次，跳过必须响亮）', () => {
  test('`enabled: false` ⇒ 不进已加载集合，进 `errors` 且点名', () => {
    writePack('off-pack', base({ content: ['chess'], enabled: false }));
    const r = loadWorkshop(tmp, { log: quiet });
    const loaded = r.packs.map((p) => p.id);
    assert.equal(loaded.includes('off-pack'), false, '被关掉的包不许参与装载');
    const err = r.errors.find((e) => e.pack === 'off-pack');
    assert.ok(err, '跳过必须响亮：进 errors，而不是静默消失');
    assert.match(err.reason, new RegExp(ENABLED_SKIP_CODE));
    // 文案要说清「怎么把它带回来」—— 一个只说「跳过了」的报告让作者不知道怎么恢复。
    assert.match(err.reason, /set true to bring it back/);
  });

  test('被关掉的包连 `chess.json` 都不读（缺文件不报噪声）', () => {
    // 声明了 content 但文件不在：开着 ⇒ 报缺文件；关着 ⇒ 什么都不报（它今天不贡献任何东西）。
    writePack('off-missing', base({ content: ['chess'], enabled: false }), {});
    const r = loadWorkshop(tmp, { log: quiet });
    const err = r.errors.find((e) => e.pack === 'off-missing');
    assert.ok(err);
    assert.match(err.reason, new RegExp(ENABLED_SKIP_CODE), '关着的包报的是「被关掉」，不是「缺 chess.json」');
  });

  test('开着但缺文件照旧报缺文件（这一格不放宽任何既有校验）', () => {
    writePack('on-missing', base({ content: ['chess'], enabled: true }), {});
    const r = loadWorkshop(tmp, { log: quiet });
    const err = r.errors.find((e) => e.pack === 'on-missing');
    assert.ok(err);
    assert.match(err.reason, /chess\.json is declared in pack\.json but missing/);
  });

  test('同一个目录里开着与关着的包互不影响（这一格是逐包的）', () => {
    writePack('mixed-on', base({ id: 'mixed-on', name: 'On', license: 'MIT', content: ['chess'], enabled: true }));
    writePack('mixed-off', base({ id: 'mixed-off', name: 'Off', license: 'MIT', content: ['chess'], enabled: false }));
    const r = loadWorkshop(tmp, { log: quiet });
    const ids = r.packs.map((p) => p.id);
    assert.equal(ids.includes('mixed-on'), true);
    assert.equal(ids.includes('mixed-off'), false);
  });
});

describe('第四层：`enabled` 不是贡献项，也不是热更新', () => {
  test('只写 `"enabled": true` 的包照旧 `EMPTY_PACK`（它什么都没带来）', () => {
    const m = normalizePackManifest({ id: 'empty', name: 'E', license: 'MIT', enabled: true }, 'empty', {});
    assert.equal(m.ok, false, m.detail);
    assert.equal(m.error, 'EMPTY_PACK');
  });

  test('`true` 不进归一化清单，`false` 进（唯一真正改变行为的取值必须进身份）', () => {
    // 这一条是 §28.50 判据 2 的落点，也是本刀与 `variants` 唯一的不同：`identifyPack` 哈希
    // `canonicalJson(pack)`，所以 `true` 若进清单就会换掉包身份，而它做的事与没写一字不差。
    const on = normalizePackManifest({ id: 'd', name: 'D', license: 'MIT', content: ['chess'], enabled: true }, 'd', {});
    const off = normalizePackManifest({ id: 'd', name: 'D', license: 'MIT', content: ['chess'], enabled: false }, 'd', {});
    const none = normalizePackManifest({ id: 'd', name: 'D', license: 'MIT', content: ['chess'] }, 'd', {});
    assert.equal(on.ok && off.ok && none.ok, true);
    assert.equal('enabled' in on.pack, false, '`true` 与缺席在数据上逐字等价');
    assert.equal('enabled' in none.pack, false);
    assert.equal(off.pack.enabled, false, '`false` 必须进清单：装好了但不参与，这件事要进包身份');
  });

  test('`enabled: false` 进了身份哈希：与「没写」的同一份包摘要**必须不同**', () => {
    // 这一条是选 `pack.json` 而不是旁挂 `enabled.json` 的理由：旁挂文件不进包身份，
    // 于是「同一个包在两台机器上摘要相同而行为不同」—— 房间摘要闸门会误判（§28.2）。
    // 同一个目录 + 同一个 id 喂两次 `identifyPack`，变量只有 `enabled` 这一格。
    const files = { chess: { op_a: { name: 'A' } } };
    // 目录名 = `pack.json.id`（`PACK_ID_MISMATCH` 是另一格的守卫，别让它变成这里的噪声）。
    const probe = (extra) => ({ id: 'hash-probe', name: 'Probe', license: 'MIT', content: ['chess'], ...extra });
    const dir = writePack('hash-probe', probe({}));
    const off = normalizePackManifest(probe({ enabled: false }), 'hash-probe', {});
    const none = normalizePackManifest(probe({}), 'hash-probe', {});
    const on = normalizePackManifest(probe({ enabled: true }), 'hash-probe', {});
    assert.equal(off.ok && none.ok && on.ok, true, off.detail || none.detail || on.detail);
    const idOff = identifyPack(dir, off.pack, files);
    const idNone = identifyPack(dir, none.pack, files);
    const idOn = identifyPack(dir, on.pack, files);
    assert.ok(idOff.hash && idOff.hash.length > 0);
    assert.notEqual(idOff.hash, idNone.hash,
      '「装好了但不参与」必须进包身份：两台机器摘要相同 ⇒ 行为相同，而这两个包的行为不同');
    assert.equal(idOn.hash, idNone.hash, '`enabled: true` 与缺席必须同摘要（缺省 = 引擎今天的行为）');
  });
});

// 供 `test/modSurface.test.js` 的账本断言用：这一格的拒绝码必须是具名的。
void ROOT;
