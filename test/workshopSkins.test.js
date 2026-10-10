// 工坊包自带的**时装**：`pack.json.skins = [{ id, charId, name, series?, desc?, art?, voices? }]`。
//
// 为什么它是 A 层的一个新字段：`skins` 曾经在「不认识的顶层键」名单里 —— 一个包写了它，归一化时被**静默丢掉**
// （0.10.0 时代三个社区 mod 反复撞上的那面墙：`variants` / `skins` / `i18n`）。皮肤层落地后它是真字段：
//   * **数据**在 A 层（这一份声明 + 素材）；
//   * **行为**在 mod 里（`public/js/ui/extensions.js` 的 appearance 注册面 + `portraitChain` 的那一个 hook）。
//
// 这一层只判**形状**，而且刻意复用 `art.chars` 那一套解析器（`parseArtEntry`）—— 一套外观的 `art` 与
// `art.chars` 的一条是同形的，所以「字段白名单 / 路径必须包内相对 / spine 要齐 skel+atlas」这些判据不会出现第二份实现。
//
// Run: node --test test/workshopSkins.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePackManifest, SKIN_FIELDS, SKIN_ID_RE, applyWorkshop } from '../shared/workshop.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';

/** 一个有 assets/ 的包的合法底盘（时装素材放在包内，所以要 license）。 */
const mk = (skins, extra = {}) => normalizePackManifest({
  id: 'p', name: 'p', license: 'CC0-1.0', content: [], skins, ...extra,
}, 'p', { hasAssets: true });

const ONE = { id: 'summer', charId: 'char_1_01', name: '夏日余韵', art: { portrait: 'skins/s/p.png' } };

describe('pack.json.skins：形状与拒绝路径', () => {
  test('最小合法一套（只有 id / charId / name / art）', () => {
    const r = mk([ONE]);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.skins, [ONE]);
  });

  test('全部可选字段都收：series / desc / avatar / spine（chars 是**嵌套**的 front/back）/ voices', () => {
    const r = mk([{
      id: 'winter', charId: 'char_1_01', name: '冬日', series: '寒夜', desc: '作者给玩家看的说明',
      art: {
        avatar: 'skins/w/a.png', portrait: 'skins/w/p.png',
        // `ART_TABLES.chars` 的 spine 是 `sides`（front/back），与时装同形 —— 这里就按那个形状写
        spine: { front: { skel: 'skins/w/m.skel', atlas: 'skins/w/m.atlas', textures: ['skins/w/m.png'] } },
      },
      voices: { start: ['skins/w/v.mp3'], idle: ['skins/w/i1.mp3', 'skins/w/i2.mp3'] },
    }]);
    assert.equal(r.ok, true, r.detail);
    const s = r.pack.skins[0];
    assert.equal(s.series, '寒夜');
    assert.equal(s.art.spine.front.skel, 'skins/w/m.skel');
    assert.deepEqual(s.voices.idle, ['skins/w/i1.mp3', 'skins/w/i2.mp3']);
  });

  test('拒绝路径逐条（每条都点名，不静默丢）', () => {
    const cases = [
      [[{ ...ONE, id: 'has space' }], 'SKIN_BAD_ID'],
      [[{ ...ONE, id: '' }], 'SKIN_BAD_ID'],
      [[{ ...ONE, id: 'x'.repeat(40) }], 'SKIN_BAD_ID'],
      [[{ ...ONE, charId: '' }], 'SKIN_BAD_CHAR_ID'],
      [[{ ...ONE, charId: 'has space' }], 'SKIN_BAD_CHAR_ID'],
      [[{ ...ONE, name: '' }], 'SKIN_BAD_SHAPE'],
      [[{ ...ONE, name: '   ' }], 'SKIN_BAD_SHAPE'],
      [[{ ...ONE, series: '' }], 'SKIN_BAD_SHAPE'],
      [[{ ...ONE, desc: '' }], 'SKIN_BAD_SHAPE'],
      [[ONE, { ...ONE }], 'SKIN_DUPLICATE_ID'],
      [[{ ...ONE, nope: 1 }], 'SKIN_UNKNOWN_FIELD'],
      [[{ ...ONE, art: {} }], 'SKIN_BAD_SHAPE'],                        // 一套时装至少要带一样外观
      [[{ ...ONE, art: { portrait: '../escape.png' } }], 'ART_PATH_UNSAFE'],
      [[{ ...ONE, art: { nope: 'x.png' } }], 'ART_UNKNOWN_FIELD'],      // 复用 art 的字段白名单
      // chars 的 spine 是嵌套的 front/back；写成扁平的 `{skel}` 会被判成「不认识 side 这个名字」
      [[{ ...ONE, art: { spine: { skel: 'a.skel' } } }], 'ART_UNKNOWN_FIELD'],
      [[{ ...ONE, art: { spine: { front: { skel: 'a.skel' } } } }], 'ART_SPINE_INCOMPLETE'],
      [[{ ...ONE, voices: { start: [] } }], 'SKIN_BAD_SHAPE'],
      [[{ ...ONE, voices: { start: ['../x.mp3'] } }], 'SKIN_PATH_UNSAFE'],
      [['summer'], 'SKIN_BAD_SHAPE'],                                   // 数组里放字符串
    ];
    for (const [skins, code] of cases) {
      const r = mk(skins);
      assert.equal(r.ok, false, `${code} 应当被拒：${JSON.stringify(skins).slice(0, 90)}`);
      assert.equal(r.error, code, `期望 ${code}，实际 ${r.error} / ${r.detail}`);
    }
  });

  test('skins 本身不是数组 ⇒ SKIN_BAD_SHAPE（对象、字符串、数字、null 都不收）', () => {
    // 只有 `undefined`（键根本不写）算「没声明」。显式写 `null` 是一个坏声明，不是「没有」——
    // 与 `art` / `voices` 的既有口径一致：作者写了什么就按什么判，不替他猜。
    for (const bad of [{}, 'summer', 42, null]) {
      const r = mk(bad);
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 不该被接受`);
      assert.equal(r.error, 'SKIN_BAD_SHAPE', `${JSON.stringify(bad)} ⇒ ${r.error}`);
    }
    assert.equal(mk(undefined).error, 'EMPTY_PACK', '没写这个键 ⇒ 什么都没带来');
  });

  test('只带时装也算贡献项（不再 EMPTY_PACK）；空数组仍拒', () => {
    assert.equal(mk([ONE]).ok, true, '一套时装就是这个包带来的东西');
    assert.equal(mk([]).error, 'EMPTY_PACK', '空数组什么都没带来');
    // 与 art 一样：有 assets/ 就要 license
    const noLic = normalizePackManifest({ id: 'p', name: 'p', content: [], skins: [ONE] }, 'p', { hasAssets: true });
    assert.equal(noLic.error, 'ASSETS_NEED_LICENSE');
  });

  test('字段表与 id 正则是一份真相，测试直接锚它', () => {
    assert.deepEqual([...SKIN_FIELDS].sort(), ['art', 'charId', 'desc', 'id', 'name', 'series', 'voices']);
    assert.equal(SKIN_ID_RE.test('summer'), true);
    assert.equal(SKIN_ID_RE.test('summer_2'), true);
    assert.equal(SKIN_ID_RE.test('_x'), false, '不许下划线开头');
    assert.equal(SKIN_ID_RE.test('a b'), false);
  });

  test('没有声明 skins 时**清单里没有这个键**（老包哈希逐字节不变）', () => {
    const r = normalizePackManifest({ id: 'p', name: 'p', content: ['chess'] }, 'p', {});
    assert.equal(r.ok, true);
    // 与 `declared` 那四组同一条纪律：只在声明过时才存在。给每个包都加 `skins: []` 会让**所有已发布包的哈希
    // 全部改变**，而哈希是房间身份与 W-D 对齐的依据（test/modAssets.test.js 那条基线就是这么被撞红的）。
    assert.equal('skins' in r.pack, false, '缺席 ⇒ 键根本不存在，而不是空数组');
  });
});

// ---------------------------------------------------------------------------------------------------
// 第 3 步的另一半：`assets.skins` 的**合并**（`shared/workshop.js mergeWorkshopSkins`）。
// 形状是**按干员分组的一列** `skins[charId] = [entry…]`，因为客户端要问的问题永远是「这个干员有哪几套」。
// 与 art 的三条规则逐字相同：路径变绝对 URL、同 id 冲突按包 id 升序第一个赢、清单不在时点名报告。
// ---------------------------------------------------------------------------------------------------
describe('assets.skins：按干员分组的合并', () => {
  const apply = (packs) => applyWorkshop({ assets: { chars: {} }, backups: { diy: { ownedPool: [] } } }, packs);
  const P = (id, skins) => ({ id, skins });

  test('按 charId 分组；路径变成 /workshop-assets 的绝对 URL', () => {
    const r = apply([P('skinA', [{ id: 'summer', charId: 'char_1_01', name: '夏日', art: { portrait: 's/p.png' } }])]);
    const one = r.data.assets.skins['char_1_01'];
    assert.equal(one.length, 1);
    assert.equal(one[0].pack, 'skinA');
    assert.equal(one[0].art.portrait, '/workshop-assets/skinA/s/p.png', '客户端零改动：还是那条只服务登记 URL 的路由');
    assert.deepEqual(r.report.skins, { char_1_01: 1 });
  });

  test('同一干员的多套**并列共存**（这是它与 art 最不同的一点）', () => {
    const r = apply([P('skinA', [
      { id: 'summer', charId: 'char_1_01', name: '夏日' },
      { id: 'winter', charId: 'char_1_01', name: '冬日' },
    ])]);
    assert.deepEqual(r.data.assets.skins['char_1_01'].map((s) => s.id), ['summer', 'winter'], '一个人可以有好几套');
  });

  test('不同包、不同干员互不冲突；**同一个干员的同一套 id** 冲突时按包 id 升序第一个赢并点名', () => {
    const r = apply([
      P('skinB', [{ id: 'summer', charId: 'char_1_01', name: '撞车的' }, { id: 'other', charId: 'char_2_02', name: '别的' }]),
      P('skinA', [{ id: 'summer', charId: 'char_1_01', name: '先来的' }]),
    ]);
    const one = r.data.assets.skins['char_1_01'];
    assert.equal(one.length, 1, '同一套 id 只有一份');
    assert.equal(one[0].pack, 'skinA', '包 id 升序第一个赢（与加载次序无关）');
    assert.equal(one[0].name, '先来的');
    assert.equal(r.data.assets.skins['char_2_02'].length, 1, '不同干员不受影响');
    const cols = r.report.errors.filter((e) => e.code === 'SKIN_COLLISION');
    assert.equal(cols.length, 1);
    assert.equal(cols[0].pack, 'skinB', '被拒的一方点名');
    assert.equal(cols[0].definedBy, 'skinA', '并指出是谁占住了');
  });

  test('可选字段缺席时**不写空键**（面板按 falsy 判，不必区分 undefined 与 null）', () => {
    const r = apply([P('skinA', [{ id: 'plain', charId: 'char_1_01', name: '素' }])]);
    const s = r.data.assets.skins['char_1_01'][0];
    assert.deepEqual(Object.keys(s).sort(), ['id', 'name', 'pack'], '没写 art / voices / series / desc 就不出现');
  });

  test('语音路径同样转绝对 URL', () => {
    const r = apply([P('skinA', [{ id: 'summer', charId: 'char_1_01', name: '夏', voices: { start: ['v/a.mp3'] } }])]);
    assert.deepEqual(r.data.assets.skins['char_1_01'][0].voices.start, ['/workshop-assets/skinA/v/a.mp3']);
  });

  test('清单不在时点名 MANIFEST_MISSING（不是静默丢掉）', () => {
    const r = applyWorkshop({ backups: { diy: { ownedPool: [] } } }, [P('skinA', [{ id: 'summer', charId: 'char_1_01', name: '夏' }])]);
    assert.equal(r.report.errors.filter((e) => e.code === 'MANIFEST_MISSING' && e.id === 'skins').length, 1);
  });

  test('没有包带时装时，assets 一个字节都不多（旧行为不变）', () => {
    const r = apply([{ id: 'plain', content: ['chess'], files: {} }]);
    assert.equal('skins' in (r.data.assets || {}), false, '不写这个键');
  });
});

// ---------------------------------------------------------------------------------------------------
// 真实装载路径：只带时装的包必须**被认下**，而且 `assets` 必须进「被触及文件」。
// 这两条都是「装上了但什么都没发生」那类静默失效的入口 —— 我第一次跑就撞上了第一条。
// ---------------------------------------------------------------------------------------------------
describe('只带时装的包：真的被装载，且 assets 进了被触及文件', () => {
  const write = (root, id, pack, files = {}) => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(pack), 'utf8');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), body, 'utf8');
    }
    return dir;
  };

  test('一个只有 skins 的包会被 loadWorkshop 认下（不是「静默跳过」）', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-skins-'));
    try {
      write(root, 'skins-only', {
        id: 'skins-only', name: '纯时装', license: 'CC0-1.0', content: [],
        skins: [{ id: 'summer', charId: 'char_1_01', name: '夏日', art: { portrait: 's/p.png' } }],
      }, { 'assets/s/p.png': 'x' });
      const loaded = loadWorkshop(root, { log: null });
      const pack = (loaded.packs || []).find((p) => p.id === 'skins-only');
      assert.ok(pack, `只带时装的包必须被认下（errors: ${JSON.stringify(loaded.errors)}）`);
      assert.deepEqual(loaded.errors, [], '0 拒绝');
      assert.equal(pack.skins.length, 1);
      // 被触及文件：漏了这一条，服务端说「时装在」，浏览器拿到的清单里没有 skins ⇒ 面板永远是空的
      assert.ok([...workshopTouchedFiles(loaded)].includes('assets'), 'assets 必须在被触及文件里');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
