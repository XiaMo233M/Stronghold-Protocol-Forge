// 工坊包自带的外观素材：`art: { chars | enemies | tokens: { "<id>": <assets.json 里对应条目的形状的子集> } }`。
//
// 为什么需要它：客户端画一个单位时，头像与模型都从 `data/assets.json` 取（`public/js/assets.js spineEntry` 读
// `chars[id].spine.front/back`（嵌套）或 `enemies[id].spine` / `tokens[id].spine`（扁平），头像读
// `chars[id].avatar/portrait`、`enemies[id].icon`），而一个包没法往 assets.json 里加条目 —— 于是包新增的干员与怪物
// 只能画成一张菱形贴图（`shared/workshop.js chessLookIssues` 会在启动日志里警告这件事）。这条通路让包把文件放进
// 自己的 `assets/`、在 pack.json 里按官方条目的形状声明出来，装载时并进合并后的清单（**没有任何客户端改动**）。
//
// 本文件钉住四件事：声明的形状与每一条拒绝路径、索引与并表（字段级合并 / 两个包抢同一个 id）、真的到达客户端
// （合并后的 assets.json + 包素材路由真的发得出 .skel/.atlas/.png）、以及作者侧校验把客户端那些**静默失败**
// （文件不在、atlas 与 skel 不同名、版本不对、动画名不存在…）变成可读输出。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizePackManifest, applyWorkshop, workshopArtIndex, workshopSummary } from '../shared/workshop.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const norm = (extra = {}, opts = { hasAssets: true }) => normalizePackManifest(
  { id: 'my-pack', content: ['chess'], license: 'CC0-1.0', ...extra }, 'my-pack', opts);
const refused = (extra, opts, error) => {
  const r = norm(extra, opts);
  assert.equal(r.ok, false, `${error}: expected a refusal`);
  assert.equal(r.error, error, `${error}: got ${r.error} (${r.detail})`);
  return r;
};

/** 一条 spine 声明（形状与 assets.json 里的条目 1:1）。 */
const spine = (stem, extra = {}) => ({
  skel: `art/${stem}.skel`, atlas: `art/${stem}.atlas`, textures: [`art/${stem}.png`], pma: false, ...extra,
});

/**
 * 一份**真的能被 @pixi-spine/runtime-3.8 解析**的 3.8 骨架二进制 —— 在测试里现造，而不是把官方模型的字节拷进仓库
 * （仓库与官方整合包都不含任何游戏素材，`.gitignore` 排除 `public/assets/`）。
 *
 * 布局照 SkeletonBinary.readSkeletonData：hash + version 两个长度前缀字符串、四个 float（大端）、nonessential
 * 一个字节，然后是空的字符串表 / 骨骼 / 槽位 / IK / 形变 / 路径约束 / 默认皮肤 / 皮肤表 / 事件，最后是动画表 ——
 * 一条动画 = 名字 + 八段空的 timeline 计数（slot/bone/ik/transform/path/deform/drawOrder/event）。
 * 于是「读版本」和「读动画名」这两条体检有了可控的输入：版本想写多少写多少，动画名想给几个给几个。
 */
function skelBytes({ version = '3.8.99', anims = [] } = {}) {
  const varint = (n) => {
    const out = [];
    let v = n;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  };
  const str = (s) => [...varint(s.length + 1), ...Buffer.from(s, 'utf8')];
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return [...b]; };
  const bytes = [
    ...str('stand-in'), ...str(version),
    ...f32(0), ...f32(0), ...f32(64), ...f32(64),
    0,              // nonessential
    ...varint(0),   // 字符串表
    ...varint(0),   // 骨骼
    ...varint(0),   // 槽位
    ...varint(0),   // IK 约束
    ...varint(0),   // 形变约束
    ...varint(0),   // 路径约束
    ...varint(0),   // 默认皮肤的槽位数
    ...varint(0),   // 皮肤表
    ...varint(0),   // 事件表
    ...varint(anims.length),
    ...anims.flatMap((n) => [...str(n), ...new Array(8).fill(0).flatMap(() => varint(0))]),
  ];
  return Buffer.from(bytes);
}

/** 一段 atlas 文本：页名 + 页字段 + 一个区域。`size` / `pma` 可按需给或省。 */
const atlasText = (page, { size = '64,64', pma = false } = {}) => [
  page,
  ...(size ? [`size: ${size}`] : []),
  'format: RGBA8888',
  'filter: Linear,Linear',
  'repeat: none',
  ...(pma ? ['pma: true'] : []),
  'Body',
  '  rotate: false',
  '  xy: 0, 0',
  '  size: 64, 64',
  '  orig: 64, 64',
  '  offset: 0, 0',
  '  index: -1',
  '',
].join('\n');

/** 一张 1×1 的真 PNG（路由按扩展名给 content-type，字节必须原样回来）。 */
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6e0000000049454e44ae426082', 'hex');

describe('工坊外观素材：声明（pack.json 的 art）', () => {
  test('chars：四个图片字段 + 嵌套的 spine.front / spine.back，逐字抄官方条目', () => {
    const r = norm({
      art: {
        chars: {
          char_ws_my_op: {
            avatar: 'art/avatar.png', avatarE2: 'art/avatar_2.png',
            portrait: 'art/portrait.png', portraitE2: 'art/portrait_2.png',
            spine: {
              front: spine('front'),
              // `animations` / `events` 的类型与官方 assets.json 一致（animations 是 名称→时长 的对象、
              // events 是名字数组）—— 这两条曾经在 shared/workshop.js 里写反过，照官方条目抄会被自己拒掉。
              back: spine('back', { pma: true, anims: { idle: 'Idle', attack: { loop: 'Attack' } }, animations: { Idle: 8.7 }, events: ['OnAttack'], hits: { Idle: [0.5] }, bounds: { x: 0, y: 0, width: 64, height: 64 } }),
            },
          },
        },
      },
    });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(Object.keys(r.pack.art.chars.char_ws_my_op).sort(),
      ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'spine']);
    assert.deepEqual(Object.keys(r.pack.art.chars.char_ws_my_op.spine).sort(), ['back', 'front']);
    const back = r.pack.art.chars.char_ws_my_op.spine.back;
    assert.equal(back.pma, true);
    assert.deepEqual(back.anims, { idle: 'Idle', attack: { loop: 'Attack' } });
    assert.deepEqual(back.animations, { Idle: 8.7 });
    assert.deepEqual(back.events, ['OnAttack']);
    assert.deepEqual(back.hits, { Idle: [0.5] });
    assert.deepEqual(back.bounds, { x: 0, y: 0, width: 64, height: 64 });
  });

  test('enemies：icon + 扁平的 spine + 原样抄的 spineAliasOf', () => {
    const r = norm({
      art: {
        enemies: {
          enemy_ws_thing: { icon: 'art/thing_icon.png', spine: spine('thing', { anims: { idle: 'Idle_A' } }), spineAliasOf: 'enemy_10001_trslim' },
        },
      },
    });
    assert.equal(r.ok, true, r.detail);
    const e = r.pack.art.enemies.enemy_ws_thing;
    assert.equal(e.icon, 'art/thing_icon.png');
    assert.equal(e.spine.skel, 'art/thing.skel');
    assert.equal(e.spineAliasOf, 'enemy_10001_trslim');
  });

  test('tokens：avatar + portrait（召唤物立绘）+ spineVariant + 扁平的 spine + 原样抄的 owner；textures 去重', () => {
    const r = norm({
      art: {
        tokens: {
          token_ws_thing: {
            avatar: 'art/token.png', portrait: 'art/token_full.png', owner: 'char_ws_my_op',
            spineVariant: 'winter',
            spine: spine('token', { textures: ['art/token.png', 'art/token.png', 'art/token_2.png'] }),
          },
        },
      },
    });
    assert.equal(r.ok, true, r.detail);
    const t = r.pack.art.tokens.token_ws_thing;
    assert.equal(t.avatar, 'art/token.png');
    // G-08 / G-09 收口：这两格是真实 mod 要用的，白名单里原本没有 ⇒ 作者只能弃用
    assert.equal(t.portrait, 'art/token_full.png', 'portrait（召唤物立绘）与 avatar 同类：一条包内相对路径');
    assert.equal(t.spineVariant, 'winter', 'spineVariant 是一条非空字符串（选引擎已有的变体名，不是路径）');
    assert.equal(t.owner, 'char_ws_my_op');
    assert.deepEqual(t.spine.textures, ['art/token.png', 'art/token_2.png']);
  });

  test('tokens 的新格子照旧挡两种错：未知字段点名、portrait 的穿越路径拒', () => {
    const unknown = norm({ art: { tokens: { t: { avatar: 'a.png', nope: 1 } } } });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'ART_UNKNOWN_FIELD');
    assert.match(unknown.detail, /portrait/, '拒绝理由要列出合法字段（含新开的这两个），否则作者只能猜');
    assert.match(unknown.detail, /spineVariant/);
    const escape = norm({ art: { tokens: { t: { portrait: '../escape.png' } } } });
    assert.equal(escape.ok, false);
    assert.equal(escape.error, 'ART_PATH_UNSAFE', 'portrait 是新开的路径格，穿越必须照样被拒');
    const emptyVariant = norm({ art: { tokens: { t: { spineVariant: '' } } } });
    assert.equal(emptyVariant.ok, false);
    assert.equal(emptyVariant.error, 'ART_BAD_SHAPE', 'spineVariant 不许空串（空名选不到任何变体）');
  });

  test('没有声明时是空对象（不是 undefined），包照常加载', () => {
    assert.deepEqual(norm().pack.art, {});
    assert.equal(norm().ok, true);
  });

  test('三张表的 id 用同一套字符集（点、冒号、短横线与下划线都收）', () => {
    const r = norm({ art: { enemies: { 'enemy_ws.my-thing:v2': { icon: 'art/x.png' } } } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(Object.keys(r.pack.art.enemies), ['enemy_ws.my-thing:v2']);
  });

  test('每一种写法错误都被拒（错误码要能被作者按名字找到）', () => {
    const cases = [
      // 形状
      [{ art: [] }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: [] } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: { c: 'x' } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: { c: { spine: 7 } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: { c: { spine: { front: 7 } } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: { c: { spine: { front: {} } } } } }, { hasAssets: true }, 'ART_SPINE_INCOMPLETE'],
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel', atlas: 'a.atlas', textures: 'a.png' } } } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel', atlas: 'a.atlas', textures: [] } } } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      // pma 是原样抄的 boolean，给字符串就是写错了
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel', atlas: 'a.atlas', pma: 'yes' } } } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      // events 是原样抄的名字数组，给对象就是写错了（animations 反过来：官方那边是对象）
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel', atlas: 'a.atlas', events: { x: 1 } } } } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel', atlas: 'a.atlas', animations: ['Idle'] } } } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { enemies: { e: { spineAliasOf: 7 } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      [{ art: { tokens: { t: { owner: '' } } } }, { hasAssets: true }, 'ART_BAD_SHAPE'],
      // 表 / 字段 / 侧
      [{ art: { weapons: { x: { avatar: 'a.png' } } } }, { hasAssets: true }, 'ART_UNKNOWN_TABLE'],
      [{ art: { chars: { c: { nickname: 'x' } } } }, { hasAssets: true }, 'ART_UNKNOWN_FIELD'],
      [{ art: { chars: { c: { spine: { side: { skel: 'a.skel', atlas: 'a.atlas' } } } } } }, { hasAssets: true }, 'ART_UNKNOWN_FIELD'],
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel', atlas: 'a.atlas', nope: 1 } } } } } }, { hasAssets: true }, 'ART_UNKNOWN_FIELD'],
      [{ art: { enemies: { e: { icon: 'a.png', owner: 'x' } } } }, { hasAssets: true }, 'ART_UNKNOWN_FIELD'],
      // 路径
      [{ art: { chars: { c: { avatar: '../secret.png' } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { chars: { c: { avatar: '/abs.png' } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { chars: { c: { avatar: 'a\\b.png' } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { chars: { c: { avatar: 'C:/abs.png' } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { chars: { c: { avatar: './ok.png' } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { chars: { c: { avatar: '' } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { enemies: { e: { spine: { skel: '../a.skel', atlas: 'a.atlas' } } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      [{ art: { tokens: { t: { spine: { skel: 'a.skel', atlas: 'a.atlas', textures: ['../a.png'] } } } } }, { hasAssets: true }, 'ART_PATH_UNSAFE'],
      // id
      [{ art: { chars: { 'bad id!': { avatar: 'a.png' } } } }, { hasAssets: true }, 'ART_BAD_ID'],
      [{ art: { enemies: { 'also bad/': { icon: 'a.png' } } } }, { hasAssets: true }, 'ART_BAD_ID'],
      // skel 与 atlas 缺一不可（加载器是从 skel 推 atlas 的，清单里那个字段只做内存回收）
      [{ art: { chars: { c: { spine: { front: { skel: 'a.skel' } } } } } }, { hasAssets: true }, 'ART_SPINE_INCOMPLETE'],
      [{ art: { chars: { c: { spine: { front: { atlas: 'a.atlas' } } } } } }, { hasAssets: true }, 'ART_SPINE_INCOMPLETE'],
      [{ art: { enemies: { e: { spine: { skel: 'a.skel' } } } } }, { hasAssets: true }, 'ART_SPINE_INCOMPLETE'],
      // 素材住在包自己的 assets/ 里
      [{ art: { chars: { c: { avatar: 'a.png' } } } }, { hasAssets: false }, 'ART_NEEDS_ASSETS'],
      [{ art: { enemies: { e: { icon: 'a.png' } } } }, { hasAssets: false }, 'ART_NEEDS_ASSETS'],
    ];
    for (const [extra, opts, error] of cases) refused(extra, opts, error);
  });

  test('只带外观素材、没有数据文件的包也是包（content 可以为空）', () => {
    const r = normalizePackManifest(
      { id: 'art-only', content: [], license: 'CC0-1.0', art: { chars: { char_ws_a: { avatar: 'art/a.png' } } } },
      'art-only', { hasAssets: true });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.content, []);
    // 声明了 art 却一条都没有 = 空对象 = 没声明，仍是 EMPTY_PACK（提示语里已经提到 art）
    const empty = normalizePackManifest({ id: 'x', content: [], art: {} }, 'x');
    assert.equal(empty.error, 'EMPTY_PACK');
    assert.match(empty.detail, /art/);
    assert.equal(normalizePackManifest({ id: 'x', content: [], license: 'CC0-1.0', art: { chars: {} } }, 'x', { hasAssets: true }).error, 'EMPTY_PACK');
    // 反过来：有数据文件的包写一个空的 art 不算声明，也不该被拒
    assert.equal(norm({ art: {} }).ok, true);
  });
});

/** 已加载包的替身：只带索引与并表要读的字段。 */
const pack = (id, art) => ({ id, name: id, art, files: {}, voices: {} });
const wsUrl = (p, rel) => `/workshop-assets/${p}/${rel}`;

describe('工坊外观素材：索引与并表（assets.chars / enemies / tokens）', () => {
  const OFFICIAL_SPINE = {
    skel: '/assets/spine/c/char_official.skel', atlas: '/assets/spine/c/char_official.atlas',
    textures: ['/assets/spine/c/char_official.png'],
    anims: { idle: 'Idle', attack: { loop: 'Attack' } }, events: ['OnAttack'], pma: false,
  };
  const BASE = {
    assets: {
      chars: {
        char_official: {
          avatar: '/assets/char/avatar/char_official.png',
          portrait: '/assets/char/portrait/char_official_1.png',
          spine: { front: { ...OFFICIAL_SPINE }, back: { ...OFFICIAL_SPINE, skel: '/assets/spine/c/char_official_b.skel' } },
        },
      },
      enemies: { enemy_official: { icon: '/assets/enemy/icon/enemy_official.png', spine: { ...OFFICIAL_SPINE } } },
      tokens: { token_official: { avatar: '/assets/token/avatar/token_official.png', owner: 'char_official' } },
      items: { trap_1013_lhp: '/assets/item/trap_1013_lhp.png' },
      ui: { x: { p: '/assets/ui/x.png' } },
    },
  };

  test('索引给出的就是 /workshop-assets 那条路由的回答（chars 嵌套，enemies/tokens 扁平）', () => {
    const idx = workshopArtIndex([pack('a-pack', {
      chars: { char_ws_a: { avatar: 'art/a.png', spine: { front: spine('f'), back: spine('b') } } },
      enemies: { enemy_ws_e: { icon: 'art/e.png', spineAliasOf: 'enemy_official', spine: spine('e') } },
      tokens: { token_ws_t: { avatar: 'art/t.png', owner: 'char_ws_a', spine: spine('t') } },
    })]);
    assert.equal(idx.chars.char_ws_a.avatar, wsUrl('a-pack', 'art/a.png'));
    assert.equal(idx.chars.char_ws_a.spine.front.skel, wsUrl('a-pack', 'art/f.skel'));
    assert.equal(idx.chars.char_ws_a.spine.front.atlas, wsUrl('a-pack', 'art/f.atlas'));
    assert.deepEqual(idx.chars.char_ws_a.spine.back.textures, [wsUrl('a-pack', 'art/b.png')]);
    assert.equal(idx.enemies.enemy_ws_e.spine.skel, wsUrl('a-pack', 'art/e.skel'), 'enemies 的 spine 是扁平的');
    assert.equal(idx.enemies.enemy_ws_e.spineAliasOf, 'enemy_official', '这几个字符串原样抄，不当路径');
    assert.equal(idx.tokens.token_ws_t.spine.skel, wsUrl('a-pack', 'art/t.skel'));
    assert.equal(idx.tokens.token_ws_t.owner, 'char_ws_a');
    assert.deepEqual(workshopArtIndex([]), {}, '没有包 → 三张表都不存在（不是空表）');
    assert.deepEqual(workshopArtIndex([pack('x', {})]), {});
    assert.deepEqual(workshopArtIndex([{ id: 'x', name: 'x', files: {} }]), {});
  });

  test('URL 逐段百分号编码：`#`、空格与中文文件名都要能发出去', () => {
    const idx = workshopArtIndex([pack('a-pack', {
      chars: { char_ws_a: { avatar: 'art/my#avatar.png' }, char_ws_b: { avatar: 'art/我 的图.png' } },
    })]);
    assert.equal(idx.chars.char_ws_a.avatar, '/workshop-assets/a-pack/art/my%23avatar.png');
    assert.equal(idx.chars.char_ws_b.avatar, '/workshop-assets/a-pack/art/%E6%88%91%20%E7%9A%84%E5%9B%BE.png');
  });

  test('同一个 <表>.<id> 两个包相争：按包 id 排序第一个赢（与加载顺序无关）', () => {
    const idx = workshopArtIndex([
      pack('b-pack', { chars: { c: { avatar: 'art/b.png' } } }),
      pack('a-pack', { chars: { c: { avatar: 'art/a.png' } } }),
    ]);
    assert.equal(idx.chars.c.avatar, '/workshop-assets/a-pack/art/a.png');
  });

  test('官方已有该 id：字段级合并 —— skel/atlas 换掉，anims/events/back/头像一个字都不动', () => {
    const { data } = applyWorkshop(BASE, [pack('p1', {
      chars: {
        char_official: { spine: { front: { skel: 'art/new.skel', atlas: 'art/new.atlas' } } },
        char_ws_new: { avatar: 'art/n_avatar.png', spine: { front: spine('n') } },
      },
    })]);
    const front = data.assets.chars.char_official.spine.front;
    assert.equal(front.skel, wsUrl('p1', 'art/new.skel'));
    assert.equal(front.atlas, wsUrl('p1', 'art/new.atlas'));
    assert.deepEqual(front.anims, OFFICIAL_SPINE.anims, '包没给 anims，官方那一侧的必须留着');
    assert.deepEqual(front.events, OFFICIAL_SPINE.events);
    assert.deepEqual(front.pma, OFFICIAL_SPINE.pma);
    assert.deepEqual(front.textures, OFFICIAL_SPINE.textures, '包没给 textures，官方清单也留着');
    const back = data.assets.chars.char_official.spine.back;
    assert.equal(back.skel, '/assets/spine/c/char_official_b.skel', '包只给了 front，back 整侧原样');
    const ch = data.assets.chars.char_official;
    assert.equal(ch.avatar, '/assets/char/avatar/char_official.png');
    assert.equal(ch.portrait, '/assets/char/portrait/char_official_1.png');
    // 官方没有的 id：直接新增
    assert.equal(data.assets.chars.char_ws_new.avatar, wsUrl('p1', 'art/n_avatar.png'));
    assert.equal(data.assets.chars.char_ws_new.spine.front.skel, wsUrl('p1', 'art/n.skel'));
    assert.deepEqual(data.assets.chars.char_ws_new.spine.front.textures, [wsUrl('p1', 'art/n.png')]);
  });

  test('enemies / tokens 两张表同样各一条：新增与覆盖都按字段合并', () => {
    const { data, report } = applyWorkshop(BASE, [pack('p1', {
      enemies: {
        enemy_official: { icon: 'art/mine_icon.png' },
        enemy_ws_new: { icon: 'art/e_icon.png', spine: spine('e') },
      },
      tokens: {
        token_official: { avatar: 'art/mine_token.png' },
        token_ws_new: { avatar: 'art/t_avatar.png', owner: 'char_ws_new', spine: spine('t') },
      },
    })]);
    assert.equal(data.assets.enemies.enemy_official.icon, wsUrl('p1', 'art/mine_icon.png'));
    assert.deepEqual(data.assets.enemies.enemy_official.spine, BASE.assets.enemies.enemy_official.spine, '只给 icon 时官方模型照旧');
    assert.equal(data.assets.enemies.enemy_ws_new.icon, wsUrl('p1', 'art/e_icon.png'));
    assert.equal(data.assets.enemies.enemy_ws_new.spine.skel, wsUrl('p1', 'art/e.skel'));
    assert.equal(data.assets.tokens.token_official.avatar, wsUrl('p1', 'art/mine_token.png'));
    assert.equal(data.assets.tokens.token_official.owner, 'char_official', '包没给 owner，官方那条留着');
    assert.equal(data.assets.tokens.token_ws_new.owner, 'char_ws_new');
    assert.equal(data.assets.tokens.token_ws_new.spine.skel, wsUrl('p1', 'art/t.skel'));
    assert.deepEqual(report.art, { p1: ['enemies.enemy_official', 'enemies.enemy_ws_new', 'tokens.token_official', 'tokens.token_ws_new'] });
  });

  test('assets 里别的表一个字都没动，输入对象也不被改', () => {
    const before = JSON.stringify(BASE);
    const { data, report } = applyWorkshop(BASE, [pack('p1', {
      chars: {
        char_official: { spine: { front: { skel: 'art/new.skel', atlas: 'art/new.atlas' } } },
        char_ws_new: { avatar: 'art/n_avatar.png' },
      },
      enemies: { enemy_ws_new: { icon: 'art/e.png' } },
      tokens: { token_ws_new: { avatar: 'art/t.png' } },
    })]);
    assert.deepEqual(data.assets.items, BASE.assets.items);
    assert.deepEqual(data.assets.ui, BASE.assets.ui);
    assert.deepEqual(data.assets.tokens.token_official, BASE.assets.tokens.token_official);
    assert.equal(JSON.stringify(BASE), before, '输入（合并前的清单）必须原封不动');
    assert.deepEqual(report.art, {
      p1: ['chars.char_official', 'chars.char_ws_new', 'enemies.enemy_ws_new', 'tokens.token_ws_new'],
    });
    assert.match(workshopSummary(report), /4 art entries \(chars\.char_official, chars\.char_ws_new, enemies\.enemy_ws_new, tokens\.token_ws_new\)/);
  });

  test('两个包抢同一个 <表>.<id>：第一个赢，后一个报出来，report.art 只记赢家', () => {
    // 故意把 b-pack 放在前面，胜者仍然必须是 a-pack：谁赢只取决于包 id，不取决于加载顺序
    const { data, report } = applyWorkshop(BASE, [
      pack('b-pack', { chars: { c: { avatar: 'art/b.png' } } }),
      pack('a-pack', { chars: { c: { avatar: 'art/a.png' } } }),
    ]);
    assert.equal(data.assets.chars.c.avatar, '/workshop-assets/a-pack/art/a.png');
    assert.deepEqual(report.art, { 'a-pack': ['chars.c'] });
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].pack, 'b-pack');
    assert.equal(report.errors[0].id, 'chars.c');
    assert.match(report.errors[0].reason, /a-pack/);
  });

  test('没有 assets.json 时报告出来，**不凭空造**一份清单', () => {
    const a = applyWorkshop({}, [pack('p1', { chars: { char_ws_a: { avatar: 'art/a.png' } } })]);
    assert.equal(a.data.assets, undefined, '不能凭空造一份 assets');
    assert.equal(a.report.errors.length, 1);
    assert.equal(a.report.errors[0].pack, 'p1');
    assert.equal(a.report.errors[0].file, 'assets');
    assert.equal(a.report.errors[0].id, 'art');
    assert.match(a.report.errors[0].reason, /assets\.json/);
    // 连 assets 表都没有的包（`assets` 在、但这个包一张表都没落在里面）也不动别的键
    const b = applyWorkshop({ stats: { n: 1 } }, [pack('p1', { chars: { char_ws_a: { avatar: 'art/a.png' } } })]);
    assert.equal(b.data.assets, undefined);
    assert.deepEqual(b.data.stats, { n: 1 });
    assert.equal(b.report.errors.length, 1);
  });

  test('没有外观素材的包不动数据、也不出现在汇总里', () => {
    const { data, report } = applyWorkshop(BASE, [{ id: 'x', name: 'X', files: {} }]);
    assert.equal(report.art, undefined);
    assert.deepEqual(data.assets, BASE.assets);
    assert.equal(workshopSummary(report), 'X(x): nothing');
  });
});

describe('工坊外观素材：加载器与端到端', () => {
  const SKEL = skelBytes({ version: '3.8.99', anims: ['Idle', 'Attack'] });
  const ATLAS = atlasText('char_ws_looks.png');
  /** 文件名里带空格与 `#`：合法文件名只有在逐段百分号编码之后才能活着走到路由 */
  const AVATAR = 'art/头 像#1.png';
  const CHESS = {
    chess_ws_looks: {
      chessId: 'chess_ws_looks', name: '外观测试', tier: 5,
      assets: { avatar: 'char_ws_looks', portrait: 'char_ws_looks', spine: 'char_ws_looks' },
    },
  };
  let tmp;
  let dataDir;
  let ws;
  let srv;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-art-e2e-'));
    dataDir = join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // 官方 chars **必须非空**：`chessLookIssues` 在 chars 为空时会直接返回空数组（那份豁免是给「没跑过素材管线」的），
    // 空夹具会让「有 art / 没 art」两边都断言成空。
    fs.writeFileSync(join(dataDir, 'assets.json'), JSON.stringify({
      chars: { char_003_kalts: { avatar: '/assets/char/avatar/char_003_kalts.png' } },
      enemies: {}, tokens: {},
      items: { trap_1013_lhp: '/assets/item/trap_1013_lhp.png' },
    }));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'art-pack');
    fs.mkdirSync(join(dir, 'assets', 'art'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'art-pack', name: '外观包', version: '1.0.0', license: 'CC0-1.0', content: ['chess'],
      art: {
        chars: {
          char_ws_looks: {
            avatar: AVATAR, portrait: 'art/portrait.png',
            spine: {
              front: {
                skel: 'art/char_ws_looks.skel', atlas: 'art/char_ws_looks.atlas',
                textures: ['art/char_ws_looks.png'], pma: false,
                anims: { idle: 'Idle', attack: { loop: 'Attack' } },
              },
            },
          },
        },
      },
    }));
    fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify(CHESS));
    fs.writeFileSync(join(dir, 'assets', 'art', 'char_ws_looks.skel'), SKEL);
    fs.writeFileSync(join(dir, 'assets', 'art', 'char_ws_looks.atlas'), ATLAS);
    fs.writeFileSync(join(dir, 'assets', 'art', 'char_ws_looks.png'), PNG_1PX);
    fs.writeFileSync(join(dir, 'assets', 'art', '头 像#1.png'), PNG_1PX);
    fs.writeFileSync(join(dir, 'assets', 'art', 'portrait.png'), PNG_1PX);
    // 第二个包**只带外观素材**（content: []）：一个数据文件都不发，但它是一个包
    const only = join(ws, 'art-only');
    fs.mkdirSync(join(only, 'assets', 'art'), { recursive: true });
    fs.writeFileSync(join(only, 'pack.json'), JSON.stringify({
      id: 'art-only', name: '只有外观', version: '1.0.0', license: 'CC0-1.0', content: [],
      art: { tokens: { token_ws_only: { avatar: 'art/token.png', owner: 'char_ws_looks', spine: spine('token') } } },
    }));
    fs.writeFileSync(join(only, 'assets', 'art', 'token.png'), PNG_1PX);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws, dataDir });
  });
  after(async () => {
    await srv?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('只带外观素材的包被认成一个包，并把 assets 标成需要合并发送的文件', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['art-only', 'art-pack']);
    assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
    const only = loaded.packs.find((p) => p.id === 'art-only');
    assert.deepEqual(only.content, []);
    assert.deepEqual(only.files, {}, '它一个数据文件都不发');
    assert.deepEqual(Object.keys(only.art), ['tokens']);
    assert.deepEqual([...workshopTouchedFiles(loaded)].sort(), ['assets', 'chess'], 'art 必须让 assets 进入被触及的集合');
    const data = loadData(dataDir, { log: quiet, workshopDir: ws });
    const served = buildWorkshopDataFiles(data, loaded);
    assert.ok(served.has('assets'), 'assets 必须被合并发送');
    assert.equal(JSON.parse(served.get('assets').toString('utf8')).chars.char_ws_looks.spine.front.skel,
      '/workshop-assets/art-pack/art/char_ws_looks.skel');
  });

  test('客户端读到的 assets.json 里有这条干员，而且 URL 真的由包素材路由服务出正确字节', async () => {
    const manifest = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    const ch = manifest.chars.char_ws_looks;
    assert.equal(ch.avatar, '/workshop-assets/art-pack/art/%E5%A4%B4%20%E5%83%8F%231.png');
    assert.equal(ch.portrait, '/workshop-assets/art-pack/art/portrait.png');
    assert.equal(ch.spine.front.skel, '/workshop-assets/art-pack/art/char_ws_looks.skel');
    assert.equal(ch.spine.front.atlas, '/workshop-assets/art-pack/art/char_ws_looks.atlas');
    assert.deepEqual(ch.spine.front.textures, ['/workshop-assets/art-pack/art/char_ws_looks.png']);
    assert.equal(ch.spine.front.pma, false);
    assert.deepEqual(ch.spine.front.anims, { idle: 'Idle', attack: { loop: 'Attack' } }, 'anims 原样抄进清单');
    // 加载器推出的 atlas 就是清单里那一个（硬约束 1：同目录同名）
    assert.equal(ch.spine.front.atlas, ch.spine.front.skel.replace(/\.skel$/, '.atlas'));
    // 官方那条一个字都没动
    assert.equal(manifest.chars.char_003_kalts.avatar, '/assets/char/avatar/char_003_kalts.png');
    // 只带外观素材那个包的召唤物也在（叠加层写的是同一份清单）
    assert.equal(manifest.tokens.token_ws_only.spine.skel, '/workshop-assets/art-only/art/token.skel');
    for (const [url, type, bytes] of [
      [ch.spine.front.skel, /application\/octet-stream/, SKEL],
      [ch.spine.front.atlas, /text\/plain/, Buffer.from(ATLAS, 'utf8')],
      [ch.spine.front.textures[0], /image\/png/, PNG_1PX],
      [ch.avatar, /image\/png/, PNG_1PX],
    ]) {
      const res = await fetch(srv.url + url);
      assert.equal(res.status, 200, `${url} 必须真的取得到 —— 这就是整条线路`);
      assert.match(res.headers.get('content-type') || '', type, url);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, url);
    }
  });

  test('report.looks 的联动：包把模型接上之后，「这个干员没有模型」的警告消失', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    const base = { assets: { chars: { char_003_kalts: { avatar: '/assets/char/avatar/char_003_kalts.png' } } } };
    const withArt = applyWorkshop(base, loaded.packs);
    assert.deepEqual(withArt.report.looks, [], 'chars 里有这条 id，就没有「会画成贴图」的警告');
    assert.deepEqual(withArt.report.art['art-pack'], ['chars.char_ws_looks']);
    assert.deepEqual(withArt.report.art['art-only'], ['tokens.token_ws_only'], '另一个包只带了召唤物');
    // 把 art 去掉：同一条 chess 记录的 assets.spine 就查不到了 → 警告回来
    const withoutArt = applyWorkshop(base, loaded.packs.map((p) => (p.id === 'art-pack' ? { ...p, art: {} } : p)));
    assert.equal(withoutArt.report.looks.length, 1);
    assert.ok(['MODEL_UNKNOWN', 'MODEL_MISSING'].includes(withoutArt.report.looks[0].code),
      `got ${withoutArt.report.looks[0].code}`);
    assert.equal(withoutArt.report.looks[0].id, 'chess_ws_looks');
    // 为什么夹具里的官方 chars 必须非空：chars 为空时 chessLookIssues 直接返回空数组（那份豁免是给没跑过素材管线的
    // 安装的），于是「有 art / 没 art」两边都会是空的，这条断言就什么都没钉住。
    const noChars = applyWorkshop({ assets: { chars: {} } }, loaded.packs.map((p) => (p.id === 'art-pack' ? { ...p, art: {} } : p)));
    assert.deepEqual(noChars.report.looks, []);
  });
});

describe('工坊外观素材：作者侧校验（tools/workshop-validate.mjs）', () => {
  const SKEL_OK = skelBytes({ version: '3.8.99', anims: ['Idle', 'Attack'] });
  const SKEL_OLD = skelBytes({ version: '4.1.0', anims: ['Idle'] });
  const SKEL_ONE = skelBytes({ version: '3.8.99', anims: ['Idle'] });
  let tmp;
  let ws;

  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-art-val-'));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'art-pack');
    const art = (p) => join(dir, 'assets', 'art', p);
    for (const d of ['ok', 'bad', 'mism', 'anim', 'noanim']) fs.mkdirSync(art(d), { recursive: true });
    // atlas 文件名与 skel 不同的那一份（加载器是从 skel 推 atlas 的，清单里这个字段写错在客户端毫无反应）
    const mismatch = { skel: 'art/mism/mism.skel', atlas: 'art/mism/other.atlas', textures: ['art/mism/other.png'], anims: { idle: 'Idle' } };
    const animSpine = (extra = {}) => ({
      skel: 'art/anim/anim.skel', atlas: 'art/anim/anim.atlas', textures: ['art/anim/anim.png'], anims: { idle: 'Idle' }, ...extra,
    });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'art-pack', name: '外观包', version: '1.0.0', license: 'CC0-1.0', content: ['chess'],
      art: {
        chars: {
          // 正面对照组：全部合法（文件在、类型能发、atlas 同名、页在、版本 3.8、动画名都在）
          char_ws_ok: {
            avatar: 'art/ok_avatar.png', portrait: 'art/ok_portrait.png', // 立绘不在盘上 → ART_FILE_MISSING
            spine: {
              front: { skel: 'art/ok/char_ws_ok.skel', atlas: 'art/ok/char_ws_ok.atlas', textures: ['art/ok/char_ws_ok.png'], pma: false, anims: { idle: 'Idle', attack: { loop: 'Attack' } } },
              // 4.1 的骨架 + 缺 size 行 + 页 png 不在 + 动画名 'Nope' 不存在
              back: { skel: 'art/bad/bad.skel', atlas: 'art/bad/bad.atlas', textures: ['art/bad/bad.png'], anims: { idle: 'Nope' } },
            },
          },
          // 扩展名不在白名单里（文件其实在）
          char_ws_txt: { avatar: 'art/notes.txt', spine: { front: mismatch } },
          // anims 里的动画名骨架里没有
          char_ws_anim: { spine: { front: animSpine({ anims: { idle: 'Idle', attack: { loop: 'Attacktypo' } } }) } },
          // 一个 anims 都没有
          char_ws_noanim: { spine: { front: { skel: 'art/noanim/noanim.skel', atlas: 'art/noanim/noanim.atlas', textures: ['art/noanim/noanim.png'] } } },
          // 清单说 pma: false，atlas 页却声明 pma: true
          char_ws_pma: { spine: { front: animSpine({ pma: false }) } },
          // 谁也不用的 id（本包没有这条 chess 记录，官方清单里也没有）
          char_ws_ghost: { avatar: 'art/ok_avatar.png' },
          // 覆盖**官方**干员的头像（本包没有这条 chess 记录，但官方 chars 表里有）→ 不该报 unknown；
          // 顺带给它一条**没有 anims** 的 spine：官方已有这个 id，字段级合并会留着官方那条的 anims，
          // 所以缺 anims 只该是 warning（新 id 缺 anims 才是 error，见 char_ws_noanim）。
          char_003_kalts: {
            avatar: 'art/ok_avatar.png', portrait: 'art/ok_avatar.png',
            spine: { front: { skel: 'art/ok/char_ws_ok.skel', atlas: 'art/ok/char_ws_ok.atlas', textures: ['art/ok/char_ws_ok.png'] } },
          },
        },
        enemies: { enemy_ws_ghost: { icon: 'art/ok_avatar.png', spineAliasOf: 'enemy_10001_trslim' } },
        tokens: { token_ws_ghost: { avatar: 'art/ok_avatar.png', owner: 'char_ws_ok' } },
      },
    }));
    const rec = (id, spine) => ({ chessId: id, name: id, tier: 5, assets: { avatar: spine, portrait: spine, spine } });
    fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({
      chess_ws_ok: rec('chess_ws_ok', 'char_ws_ok'),
      chess_ws_txt: rec('chess_ws_txt', 'char_ws_txt'),
      chess_ws_anim: rec('chess_ws_anim', 'char_ws_anim'),
      chess_ws_noanim: rec('chess_ws_noanim', 'char_ws_noanim'),
      chess_ws_pma: rec('chess_ws_pma', 'char_ws_pma'),
    }));
    fs.writeFileSync(art('ok_avatar.png'), PNG_1PX);
    fs.writeFileSync(art('notes.txt'), 'not a media file the route serves');
    fs.writeFileSync(art('ok/char_ws_ok.skel'), SKEL_OK);
    fs.writeFileSync(art('ok/char_ws_ok.atlas'), atlasText('char_ws_ok.png'));
    fs.writeFileSync(art('ok/char_ws_ok.png'), PNG_1PX);
    fs.writeFileSync(art('bad/bad.skel'), SKEL_OLD);
    fs.writeFileSync(art('bad/bad.atlas'), atlasText('bad_page.png', { size: null }));
    fs.writeFileSync(art('mism/mism.skel'), SKEL_ONE);
    fs.writeFileSync(art('mism/other.atlas'), atlasText('other.png'));
    fs.writeFileSync(art('mism/other.png'), PNG_1PX);
    fs.writeFileSync(art('anim/anim.skel'), SKEL_ONE);
    fs.writeFileSync(art('anim/anim.atlas'), atlasText('anim.png', { pma: true }));
    fs.writeFileSync(art('anim/anim.png'), PNG_1PX);
    fs.writeFileSync(art('noanim/noanim.skel'), SKEL_ONE);
    fs.writeFileSync(art('noanim/noanim.atlas'), atlasText('noanim.png'));
    fs.writeFileSync(art('noanim/noanim.png'), PNG_1PX);
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  const run = () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), ws, '--json'], { encoding: 'utf8', timeout: 120_000 });
    assert.ok(r.stdout, r.stderr);
    return JSON.parse(r.stdout);
  };

  test('「客户端一条日志都不打」的那些失败：每一条都有人话输出（code + severity + hint）', () => {
    const report = run();
    const codes = report.packs[0].issues.map((i) => `${i.code} ${i.field}`);
    const expect = [
      ['ART_FILE_MISSING', 'art.chars.char_ws_ok.portrait'],
      ['ART_TYPE_UNSERVABLE', 'art.chars.char_ws_txt.avatar'],
      ['ART_ATLAS_NAME_MISMATCH', 'art.chars.char_ws_txt.spine.front.atlas'],
      ['ART_ATLAS_PAGE_MISSING', 'art.chars.char_ws_ok.spine.back.atlas'],
      ['ART_ATLAS_NO_SIZE', 'art.chars.char_ws_ok.spine.back.atlas'],
      ['ART_SPINE_VERSION', 'art.chars.char_ws_ok.spine.back.skel'],
      ['ART_ANIM_UNKNOWN', 'art.chars.char_ws_ok.spine.back.anims'],
      ['ART_ANIM_UNKNOWN', 'art.chars.char_ws_anim.spine.front.anims'],
      ['ART_SPINE_NO_ANIMS', 'art.chars.char_ws_noanim.spine.front.anims', 'error'],
      ['ART_SPINE_NO_ANIMS', 'art.chars.char_003_kalts.spine.front.anims', 'warning'],
      ['ART_PMA_HINT', 'art.chars.char_ws_pma.spine.front.pma'],
      ['ART_UNKNOWN_ID', 'art.chars.char_ws_ghost'],
      ['ART_UNKNOWN_ID', 'art.enemies.enemy_ws_ghost'],
      ['ART_UNKNOWN_ID', 'art.tokens.token_ws_ghost'],
    ];
    // 每行可以显式给严重度（同一条 code 在不同情形下会不一样：ART_SPINE_NO_ANIMS 在新 id 上是 error、
    // 在官方已有 id 上只是 warning，因为字段级合并会留着官方那条的 anims）
    for (const [code, field, severity] of expect) {
      assert.ok(codes.includes(`${code} ${field}`), `${code} ${field} missing, got ${JSON.stringify(codes)}`);
      const issue = report.packs[0].issues.find((i) => i.code === code && i.field === field);
      const want = severity ?? (['ART_ATLAS_NO_SIZE', 'ART_PMA_HINT', 'ART_UNKNOWN_ID'].includes(code) ? 'warning' : 'error');
      assert.equal(issue.severity, want, `${code} ${field}`);
      assert.ok(issue.message && issue.message.length > 20, `${code}: message must say something human`);
      assert.ok(issue.hint && issue.hint.length > 10, `${code}: hint must tell the author what to do`);
    }
  });

  test('正面对照组一条 ART_* 都不报（这一层不许把合法素材也说成错的）', () => {
    const report = run();
    const noisy = report.packs[0].issues.filter((i) => i.code.startsWith('ART_') && i.field.startsWith('art.chars.char_ws_ok.spine.front'));
    assert.deepEqual(noisy, [], '合法的那一侧（3.8 骨架、atlas 同名、页在、有 size、动画名都在）不该被点名');
    // 「本包自己的 id」不报 unknown：chess.json 里那五条记录的 assets.spine 都是本包 art 的 id
    // 「官方的 id」也不报 unknown：覆盖官方干员的头像是作者最常见的动作
    const unknown = report.packs[0].issues.filter((i) => i.code === 'ART_UNKNOWN_ID').map((i) => i.field).sort();
    assert.deepEqual(unknown, ['art.chars.char_ws_ghost', 'art.enemies.enemy_ws_ghost', 'art.tokens.token_ws_ghost']);
    // 官方清单里有的 id 不该被点名（除了那条「没有 anims」的 warning：官方已有这个 id，字段级合并会留着官方的 anims，
    // 所以这里只提醒，不当错误 —— 这条是上一条用例特意加的，见那里的注释）
    const onOfficial = report.packs[0].issues.filter((i) => i.field.startsWith('art.chars.char_003_kalts'));
    assert.deepEqual(onOfficial.map((i) => `${i.code}:${i.severity}`), ['ART_SPINE_NO_ANIMS:warning']);
  });

  test('报出这个包带了几条外观条目（照装备图标那两行）', () => {
    const report = run();
    assert.equal(report.art, 9, '7 条 chars + 1 条 enemies + 1 条 tokens');
    assert.equal(report.packs[0].art, 9);
    const text = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), ws], { encoding: 'utf8', timeout: 120_000 }).stdout;
    assert.match(text, /9 art entries/);
  });

  test('官方清单里有的 id 不报 unknown（判定用的是 data/assets.json 那三张表，不是自己编一套）', () => {
    const official = JSON.parse(fs.readFileSync(join(DATA_DIR, 'assets.json'), 'utf8'));
    for (const table of ['chars', 'enemies', 'tokens']) assert.ok(Object.keys(official[table]).length > 0, `官方 ${table} 表必须非空`);
    // 夹具里那两个「官方 id」必须真的在清单里，否则上面那条断言什么都没钉住
    assert.ok(Object.hasOwn(official.chars, 'char_003_kalts'), 'char_003_kalts 必须真的在官方 chars 表里');
    assert.ok(Object.hasOwn(official.enemies, 'enemy_10001_trslim'), 'enemy_10001_trslim 必须真的在官方 enemies 表里');
    const report = run();
    const fields = report.packs[0].issues.filter((i) => i.code === 'ART_UNKNOWN_ID').map((i) => i.field);
    assert.ok(!fields.some((f) => /char_003_kalts|enemy_10001_trslim/.test(f)), '官方 id 是合法的');
  });
});
