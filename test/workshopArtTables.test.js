// test/workshopArtTables.test.js
//
// `pack.json.art.bonds` / `pack.json.art.bands` —— 盟约图集与分队（策略）图集。
//
// 为什么这两张表在 `ART_TABLES` 里：`data/assets.json` 实测 `bonds["yanShip"]` / `bands["band_bldsk"]` 的值
// **直接就是路径字符串**（`/assets/bond/yanShip.png` / `/assets/band/band_bldsk.png`），与 `skills` / `profSub`
// 同一张脸，所以它们是 `{ flat: true, target: [...] }` 两行。真实 mod（盟约拓展包 `ave-mujica`：`art.bonds` 的
// `aveMujica`、`art.bands` 的 `band_wuyouyoumeng`）正是这么写的 —— 而在这两张表存在之前，闸门 `ART_UNKNOWN_TABLE`
// 会把**整包**拒掉（连 `data.chess` 都进不去），代价是一整包素材全废。
//
// 本文件钉住四件事，每一件都是一条**实测过的**契约：
//   1. 落点与消费端键名一致：`public/js/ui/assetUrls.js` 的 `bondIconUrl(m, bondId)` / `bandIconUrl(m, bandId)`
//      读的是 `m.bonds[<bondId>]` / `m.bands[<bandId>]`。这里**直接 Import 那个模块**问它要 URL，而不是自己再写一遍
//      「bonds 表长什么样」—— 复制一份判断就等于没有判断。
//   2. 用错键名（`art.bond` / `art.band` 单数，或 index 落到 `bond` 而不是 `bonds`）**不会静默通过**：单数是
//      `ART_UNKNOWN_TABLE`，点名的名单里必须列出 `bonds`；查错 id 则让消费者给出一个**明确的 null**（画兜底），
//      不是一个看起来像成功的值。
//   3. 扁平表的 `target` 不变量：少写 `target` 的扁平表在**导入时**就抛，而不是「校验通过、图没进清单」。
//   4. `art.bonds` 与 `bondIcons` 是**同一件事的两个写法**（两条路最后都写 `assets.bonds[<bondId>]`）：同一个 id
//      两处都声明 ⇒ 点名拒绝整包；两处声明**不同**的 id ⇒ 都生效、不冲突。规则写死在
//      `normalizePackManifest`（`BOND_ICON_CONFLICT`），docs/WORKSHOP.md §1.4 是同一份说法。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePackManifest, applyWorkshop, workshopArtIndex, workshopSummary, ART_TABLES } from '../shared/workshop.js';
import { bondIconUrl, bandIconUrl } from '../public/js/ui/assetUrls.js';

/** 已加载包的替身：只带索引与并表要读的字段（与 test/workshopArt.test.js 同一个写法）。 */
const pack = (id, art, extra = {}) => ({ id, name: id, art, files: {}, voices: {}, ...extra });

const norm = (extra = {}, opts = { hasAssets: true }) => normalizePackManifest(
  { id: 'my-pack', content: ['chess'], license: 'CC0-1.0', ...extra }, 'my-pack', opts);

const refused = (extra, error, opts = { hasAssets: true }) => {
  const r = norm(extra, opts);
  assert.equal(r.ok, false, `${error}: expected a refusal, got ${JSON.stringify(r.pack?.art ?? r)}`);
  assert.equal(r.error, error, `${error}: got ${r.error} (${r.detail})`);
  return r;
};

/** 官方的盟约/分队图集都在（那 23 + 40 条），外加一条本包要替换的官方 id。 */
const BASE = {
  assets: {
    bonds: {
      yanShip: '/assets/bond/yanShip.png',
      sargonShip: '/assets/bond/sargonShip.png',
      aveMujica_official: '/assets/bond/aveMujica.png',
    },
    bands: { band_bldsk: '/assets/band/band_bldsk.png' },
    skills: { skchr_official_1: '/assets/skill/skchr_official_1.png' },
    prof: { sub: { fastshot: '/assets/prof/sub/fastshot.png' } },
  },
};

describe('art.bonds / art.bands：声明形状（与 skills / profSub 逐字相同的两条判据）', () => {
  test('形状就是「id → 包内相对路径」的一张扁平表', () => {
    const r = norm({ art: { bonds: { aveMujica: 'bond/icon_aveMujica.png' }, bands: { band_wuyouyoumeng: 'band/band_wuyouyoumeng.png' } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.art, {
      bonds: { aveMujica: 'bond/icon_aveMujica.png' },
      bands: { band_wuyouyoumeng: 'band/band_wuyouyoumeng.png' },
    });
  });

  test('两张表都进 ART_TABLES，且都是 flat + 有落点（落点就是 assets.json 里的键）', () => {
    assert.deepEqual(ART_TABLES.bonds, { flat: true, target: ['bonds'] });
    assert.deepEqual(ART_TABLES.bands, { flat: true, target: ['bands'] });
  });

  test('路径不安全就拒（与 skills 同一套规则，不是另写一份）', () => {
    for (const bad of ['../x.png', '/abs.png', 'a\\b.png', 'C:/x.png', './x.png']) {
      refused({ art: { bonds: { aveMujica: bad } } }, 'ART_PATH_UNSAFE');
      refused({ art: { bands: { band_x: bad } } }, 'ART_PATH_UNSAFE');
    }
    assert.equal(norm({ art: { bonds: { aveMujica: 7 } } }).error, 'ART_PATH_UNSAFE', '不是字符串同样不安全');
    assert.equal(norm({ art: { bonds: { aveMujica: '' } } }).error, 'ART_PATH_UNSAFE');
  });

  test('带 `/` 或空格的 id 被点名拒（RECORD_ID_RE）', () => {
    assert.equal(norm({ art: { bonds: { 'bad/id': 'bond/x.png' } } }).error, 'ART_BAD_ID');
    assert.equal(norm({ art: { bands: { 'bad id': 'band/x.png' } } }).error, 'ART_BAD_ID');
  });

  test('art 声明了但包里没有 assets/ ⇒ ART_NEEDS_ASSETS（与既有表同一条）', () => {
    assert.equal(norm({ art: { bonds: { aveMujica: 'bond/x.png' } } }, { hasAssets: false }).error, 'ART_NEEDS_ASSETS');
  });
});

describe('art bonds/bands：落点与消费端键名（错键名不会静默通过）', () => {
  test('并进 assets.bonds / assets.bands，官方那张表整张保留，替换官方 id 是替换', () => {
    const { data, report } = applyWorkshop(structuredClone(BASE), [
      pack('p1', { bonds: { aveMujica: 'bond/icon_aveMujica.png', aveMujica_official: 'bond/mine.png' }, bands: { band_wuyouyoumeng: 'band/band_wuyouyoumeng.png' } }),
    ]);
    assert.equal(data.assets.bonds.yanShip, '/assets/bond/yanShip.png', '官方那 23 条一条都不能少');
    assert.equal(data.assets.bonds.aveMujica, '/workshop-assets/p1/bond/icon_aveMujica.png', '新 id 是新增');
    assert.equal(data.assets.bonds.aveMujica_official, '/workshop-assets/p1/bond/mine.png', '官方已有这个 id ⇒ 替换（这是一个包给官方盟约换图的方式）');
    assert.equal(data.assets.bands.band_bldsk, '/assets/band/band_bldsk.png', '官方那 40 条一条都不能少');
    assert.equal(data.assets.bands.band_wuyouyoumeng, '/workshop-assets/p1/band/band_wuyouyoumeng.png');
    assert.deepEqual(report.errors, [], '一次干净的新增不该报任何错');
    assert.deepEqual(report.flatArt, { p1: ['bands.band_wuyouyoumeng', 'bonds.aveMujica', 'bonds.aveMujica_official'] });
  });

  // **这一条就是第 3 条要求的那条测试。** 断言的是消费者自己的回答，不是我方代码里抄的一份表名。
  test('消费端（assetUrls.js）按 bondId / bandId 真的取到了合并后的 URL', () => {
    const { data } = applyWorkshop(structuredClone(BASE), [
      pack('p1', { bonds: { aveMujica: 'bond/icon_aveMujica.png' }, bands: { band_wuyouyoumeng: 'band/band_wuyouyoumeng.png' } }),
    ]);
    const m = data.assets;
    assert.equal(bondIconUrl(m, 'aveMujica'), '/workshop-assets/p1/bond/icon_aveMujica.png', '键名是 bondId（不是 bond / bonds / icon）');
    assert.equal(bandIconUrl(m, 'band_wuyouyoumeng'), '/workshop-assets/p1/band/band_wuyouyoumeng.png', '键名是 bandId');
    assert.equal(bondIconUrl(m, 'yanShip'), '/assets/bond/yanShip.png', '官方盟约照旧');
    assert.equal(bandIconUrl(m, 'band_bldsk'), '/assets/band/band_bldsk.png', '官方分队照旧');
  });

  test('用错键名 / 查错 id 得到的是**明确的 null**，不是一个看起来成功的值', () => {
    const { data } = applyWorkshop(structuredClone(BASE), [
      pack('p1', { bonds: { aveMujica: 'bond/icon_aveMujica.png' }, bands: { band_wuyouyoumeng: 'band/band_wuyouyoumeng.png' } }),
    ]);
    const m = data.assets;
    assert.equal(bondIconUrl(m, 'aveMujica_missing'), null, '这个 id 两处都没有 ⇒ null（调用方画兜底），不是随便回落到别的盟约图上');
    assert.equal(bandIconUrl(m, 'band_nope'), null);
    assert.equal(bondIconUrl(m, ''), null);
    assert.equal(bandIconUrl(m, undefined), null);
    // **键名写错就是查不到**，没有「回落到第一张图」这种事：同一个 id 挂到 `assets.bond`（单数）上，
    // 消费端读 `assets.bonds` —— 拿到的是 null，不是一个相邻的、看起来成功的 URL。
    assert.equal(bondIconUrl({ bond: { aveMujica: '/workshop-assets/p1/bond/icon_aveMujica.png' } }, 'aveMujica'), null);
    assert.equal(bandIconUrl({ band: { band_wuyouyoumeng: '/workshop-assets/p1/band/x.png' } }, 'band_wuyouyoumeng'), null);
    // 反过来：id 在正确的键下才有值（这一对断言把「键名」钉成唯一的判据）
    assert.equal(bondIconUrl({ bonds: { aveMujica: '/workshop-assets/p1/bond/icon_aveMujica.png' } }, 'aveMujica'), '/workshop-assets/p1/bond/icon_aveMujica.png');
  });

  test('索引给出的就是 /workshop-assets 那条路由的回答（逐段百分号编码）', () => {
    const idx = workshopArtIndex([pack('a-pack', { bonds: { aveMujica: 'bond/icon_aveMujica.png' }, bands: { band_x: 'band/my band#1.png' } })]);
    assert.deepEqual(idx, {
      bonds: { aveMujica: '/workshop-assets/a-pack/bond/icon_aveMujica.png' },
      bands: { band_x: '/workshop-assets/a-pack/band/my%20band%231.png' },
    });
  });

  test('两个包抢同一个 盟约/分队 id：包 id 字典序小的赢，输的一方点名（不静默覆盖）', () => {
    const { data, report } = applyWorkshop(structuredClone(BASE), [
      pack('b-pack', { bonds: { aveMujica: 'bond/b.png' } }),
      pack('a-pack', { bonds: { aveMujica: 'bond/a.png' } }),
    ]);
    assert.equal(data.assets.bonds.aveMujica, '/workshop-assets/a-pack/bond/a.png', '谁赢只看包 id，不看加载次序');
    assert.deepEqual(report.errors.map((e) => [e.pack, e.id, e.code, e.definedBy]), [['b-pack', 'bonds.aveMujica', 'ASSET_COLLISION', 'a-pack']]);
  });

  test('assets.json 里没有 bonds 那张表时报告出来，不凭空造一份', () => {
    const { data, report } = applyWorkshop({ assets: {} }, [pack('p1', { bonds: { aveMujica: 'bond/x.png' } })]);
    assert.deepEqual(report.errors.map((e) => [e.pack, e.code, e.id]), [['p1', 'MANIFEST_MISSING', 'art.bonds']]);
    assert.equal(data.assets.bonds, undefined, '落点不存在就不写：凭空造一张只有这个 id 的表是假象');
  });

  test('落点存在但缺这一个 id 时是新增，官方那一条不动', () => {
    const { data, report } = applyWorkshop(structuredClone(BASE), [pack('p1', { bonds: { aveMujica: 'bond/icon.png' } })]);
    assert.equal(data.assets.bonds.yanShip, '/assets/bond/yanShip.png');
    assert.equal(data.assets.bonds.aveMujica, '/workshop-assets/p1/bond/icon.png');
    assert.deepEqual(report.errors, []);
  });

  test('启动日志按表名分列：bonds / bands / skills 各一行，不混成一句含糊的 "icons"', () => {
    const { report } = applyWorkshop(structuredClone(BASE), [
      pack('p1', { bonds: { aveMujica: 'bond/icon.png' }, bands: { band_wuyouyoumeng: 'band/band.png' }, skills: { skchr_ws_1: 'skill/ws1.png' } }),
    ]);
    const text = workshopSummary(report);
    assert.match(text, /bands \+1 \(bands\.band_wuyouyoumeng\)/, text);
    assert.match(text, /bonds \+1 \(bonds\.aveMujica\)/, text);
    assert.match(text, /skills \+1 \(skills\.skchr_ws_1\)/, text);
    assert.doesNotMatch(text, /3 icons/, '三张表不能被糊成一句 "3 icons"');
  });
});

describe('art bonds/bands：与既有 bondIcons 是同一件事的两个写法', () => {
  test('同一个 id 两处都声明 ⇒ 点名拒绝整包（BOND_ICON_CONFLICT），不静默选一个', () => {
    const r = refused({ bondIcons: { aveMujica: 'bond/a.png' }, art: { bonds: { aveMujica: 'bond/b.png' } } }, 'BOND_ICON_CONFLICT');
    assert.match(r.detail, /aveMujica/, '错误文案必须点名是哪一个 id');
    assert.match(r.detail, /bondIcons/);
    assert.match(r.detail, /art\.bonds/);
  });

  test('两处声明**不同**的 id ⇒ 都生效，谁也不覆盖谁', () => {
    const r = norm({ bondIcons: { yanShip: 'bond/yan.png' }, art: { bonds: { aveMujica: 'bond/ave.png' } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.bondIcons, { yanShip: 'bond/yan.png' });
    assert.deepEqual(r.pack.art.bonds, { aveMujica: 'bond/ave.png' });
    const { data } = applyWorkshop(structuredClone(BASE), [
      pack('p1', r.pack.art, { bondIcons: r.pack.bondIcons }),
    ]);
    assert.equal(data.assets.bonds.yanShip, '/workshop-assets/p1/bond/yan.png', 'bondIcons 那一份生效');
    assert.equal(data.assets.bonds.aveMujica, '/workshop-assets/p1/bond/ave.png', 'art.bonds 那一份也生效');
  });

  test('规则同样管到 bandId 之外的每一张扁平表：只有 art.bonds 会被这么比', () => {
    // `bandIcons` 这个概念不存在（分队图标只有 `art.bands` 一条路），所以 `bands` 不参与这条判据：
    // 一个 id 同时出现在 bondIcons 与 art.bands 里是两件不相干的事（盟约 vs 分队），不该被拒。
    assert.equal(norm({ bondIcons: { shared_id: 'bond/x.png' }, art: { bands: { shared_id: 'band/x.png' } } }).ok, true);
  });
});

describe('art 表的形状不变量：加一张扁平表 = 两行，漏掉第二行就在导入时炸', () => {
  test('每一张扁平表都有非空 target，且 target 就是它在 assets.json 里的落点', () => {
    const flat = Object.entries(ART_TABLES).filter(([, s]) => s.flat);
    assert.deepEqual(flat.map(([t]) => t).sort(), ['bands', 'bonds', 'profSub', 'skills'],
      '扁平表就是这四张；多一张 / 少一张这里先红（校验器、索引、并表、日志都读这同一份）');
    for (const [table, shape] of flat) {
      assert.ok(Array.isArray(shape.target) && shape.target.length, `${table} 必须有非空 target`);
      assert.equal(typeof shape.target[0], 'string');
    }
    assert.deepEqual(ART_TABLES.skills.target, ['skills']);
    assert.deepEqual(ART_TABLES.profSub.target, ['prof', 'sub']);
  });

  test('落点键与消费端键名一致（写错这一层就是静默失效）', () => {
    // 消费者读的是 `assets.<target[0]>`：bonds → `assets.bonds`、bands → `assets.bands`。
    // 这张断言把「落点」与「消费端那一行」绑在一起 —— 落点改成 `bond` 而消费端读 `bonds` 时这里先红。
    assert.equal(ART_TABLES.bonds.target[0], 'bonds');
    assert.equal(ART_TABLES.bands.target[0], 'bands');
    const { data } = applyWorkshop(structuredClone(BASE), [
      pack('p1', { bonds: { aveMujica: 'bond/x.png' } }),
    ]);
    assert.ok(Object.hasOwn(data.assets, ART_TABLES.bonds.target[0]), '并表写的就是 assets.<target[0]>');
    assert.equal(bondIconUrl(data.assets, 'aveMujica'), '/workshop-assets/p1/bond/x.png',
      '落点那一层写对了，消费者才拿得到（两者是同一个键名）');
  });

  test('单数表名（art.bond / art.band）是 ART_UNKNOWN_TABLE，点名的名单里有复数那两张', () => {
    for (const bad of ['bond', 'band']) {
      const r = refused({ art: { [bad]: { x: 'bond/x.png' } } }, 'ART_UNKNOWN_TABLE');
      assert.match(r.detail, /bonds/, `拒绝文案要把可用的表名列出来（含 bonds）：${r.detail}`);
      assert.match(r.detail, /bands/, `含 bands：${r.detail}`);
    }
  });
});
