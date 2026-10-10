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
import { normalizePackManifest, SKIN_FIELDS, SKIN_ID_RE } from '../shared/workshop.js';

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

  test('没有声明 skins 时归一化结果是空数组（旧包逐字节不变）', () => {
    const r = normalizePackManifest({ id: 'p', name: 'p', content: ['chess'] }, 'p', {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.pack.skins, [], '缺席 ⇒ 空数组，包不因此被拒');
  });
});
