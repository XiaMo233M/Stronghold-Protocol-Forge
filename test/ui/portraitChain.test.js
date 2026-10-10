// 立绘 / 头像的**解析链**（`public/js/ui/portraitChain.js`）：一条链，旧行为是它的分支。
//
// 这份测试的核心手法：拿**今天那两个实现**（`assetUrls.chessPortraitUrl` / `assets.portraitUrl`）当**对照**，
// 对同一批输入逐项比对「没有 hook 时逐字相同」。这比手写期望值硬 —— 手写的期望会跟着我的实现一起漂。
//
// Run: node --test test/ui/portraitChain.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chessPortraitUrl, chessAvatarUrl } from '../../public/js/ui/assetUrls.js';
import {
  portraitEntry, portraitUrlOf, avatarUrlOf,
  setAppearanceLookup, currentAppearanceLookup, clearAppearanceLookup,
} from '../../public/js/ui/portraitChain.js';

/** 一份小清单：官方两条记录 + 一条 `_2`（精锐）+ 一条只有 E2 立绘的。 */
const M = {
  chars: {
    char_a: { portrait: 'a/p1.png', portraitE2: 'a/p2.png', avatar: 'a/v1.png', avatarE2: 'a/v2.png' },
    char_b: { portrait: 'b/p1.png', avatar: 'b/v1.png' },                    // 没有 E2
    char_c: { portrait: 'c/p1.png', avatar: 'c/v1.png' },
    char_c_2: { portrait: 'c2/p1.png', portraitE2: 'c2/p2.png', avatar: 'c2/v1.png', avatarE2: 'c2/v2.png' },
  },
};

describe('解析链：没有 hook 时与今天**逐字相同**', () => {
  /** 一批覆盖真实形状的输入（含边界：无 assets、空 id、后缀、精锐、不存在的 id）。 */
  const CASES = [
    { name: '无 assets，普通', chess: { charId: 'char_a' } },
    { name: '无 assets，精锐', chess: { charId: 'char_a', isGolden: true } },
    { name: '无 assets，该干员没有 E2', chess: { charId: 'char_b', isGolden: true } },
    { name: 'assets.portrait = _1 后缀', chess: { charId: 'char_a', assets: { portrait: 'char_a_1' } } },
    { name: 'assets.portrait = _2 后缀', chess: { charId: 'char_a', assets: { portrait: 'char_a_2' } } },
    { name: 'assets.portrait = 别的 _2 干员', chess: { charId: 'char_a', assets: { portrait: 'char_c_2' } } },
    { name: 'assets.portrait = 精确 id（今天 assetUrls 会忽略）', chess: { charId: 'char_a', assets: { portrait: 'char_c' } } },
    { name: 'assets.portrait = 不存在的 id', chess: { charId: 'char_a', assets: { portrait: 'nope_x' } } },
    { name: 'assets.portrait 为空串', chess: { charId: 'char_a', assets: { portrait: '' } } },
    { name: 'charId 不存在', chess: { charId: 'ghost' } },
    { name: 'charId 缺失', chess: {} },
    { name: 'chess 是 null', chess: null },
  ];

  test('立绘：除「精确命中」那一种输入外，与 chessPortraitUrl 逐字相同', () => {
    for (const c of CASES) {
      const got = portraitEntry(M, c.chess);
      const want = chessPortraitUrl(M, c.chess);
      // 唯一有意的差异：`assets.portrait` 是 `chars` 里的**精确键**时，链用精确命中（步骤 3），
      // 而旧的 `chessPortraitUrl` 忽略它（它只认 `_1`/`_2`）。这是「把 portraitUrl 的行为并进来」那一步，
      // 也是这次统一要消掉的分叉 —— 单独一条断言钉住它，其余输入必须**逐字相同**。
      const exactHit = !!(c.chess && c.chess.assets && c.chess.assets.portrait && M.chars[c.chess.assets.portrait]);
      if (exactHit) continue;
      assert.equal(got, want, `${c.name}: 链 = ${JSON.stringify(got)}，而详情页那条 = ${JSON.stringify(want)}`);
    }
  });

  test('头像：与 chessAvatarUrl 一致 —— **包括不看 isGolden 这一条**', () => {
    for (const c of CASES) {
      const got = avatarUrlOf(M, c.chess);
      const want = chessAvatarUrl(M, c.chess);
      assert.equal(got, want, `${c.name}: 头像链 = ${JSON.stringify(got)}，今天 = ${JSON.stringify(want)}`);
    }
    // 单独钉住那条容易写错的语义：头像**不**因 isGolden 改用 E2 —— 精锐变体由调用方自己传
    // （`screens/diy.js`：`elite ? unit.assets.avatarGolden : unit.assets.avatar`）。
    assert.equal(avatarUrlOf(M, { charId: 'char_a', isGolden: true }), 'a/v1.png', '普通头像');
    assert.equal(portraitEntry(M, { charId: 'char_a', isGolden: true }, { kind: 'portrait' }), 'a/p2.png', '而立绘会走 E2');
  });

  test('精确命中的 id：链用上了它（这是把 portraitUrl 的行为并进来的一步）', () => {
    // 这条正是**两条旧链的差异**：`chessPortraitUrl` 会忽略 `char_c`（不是 _1/_2）而回落 char_a；
    // 链必须**先看精确命中**（第 3 步），否则一套外部外观的 id 永远不会被认出来。
    const id = portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c' } });
    assert.equal(id, 'c/p1.png', '精确命中优先于回落');
    // 也就是说：这一条**有意**与旧的 chessPortraitUrl 不同 —— 差异集中在「id 是 chars 里的精确键」这一种输入上。
    assert.equal(chessPortraitUrl(M, { charId: 'char_a', assets: { portrait: 'char_c' } }), 'a/p1.png', '旧实现确实忽略它');
  });

  test('`_1` / `_2` 后缀是链的第一分支，不受 hook 影响', () => {
    const spy = () => { throw new Error('后缀分支不该调用 hook'); };
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_2' } }, { lookup: spy }), 'a/p2.png');
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_1' } }, { lookup: spy }), 'a/p1.png');
  });
});

describe('解析链：hook 是唯一的扩展点', () => {
  test('hook 回答一套外观 id ⇒ 用它；不回答 ⇒ 回落原版', () => {
    const lookup = (kind, charId, id) => (id === 'summer' && charId === 'char_a' ? { portrait: 'skin/summer.png', avatar: 'skin/summer_v.png' } : null);
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }, { lookup }), 'skin/summer.png');
    assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'summer' } }, { lookup }), 'skin/summer_v.png');
    // 不认识 ⇒ 回落原版（可见、可解释）
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'winter' } }, { lookup }), 'a/p1.png');
  });

  test('hook 抛异常时回落原版，不让一个坏 mod 把画面打没', () => {
    const boom = () => { throw new Error('boom'); };
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }, { lookup: boom }), 'a/p1.png');
  });

  test('hook 必须在**精确命中之后**才被问到（chars 里有的一律赢）', () => {
    const spy = () => { throw new Error('chars 里有的 id 不该问 hook'); };
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c' } }, { lookup: spy }), 'c/p1.png');
  });

  test('没有 charId 时不问 hook（它按 charId 归属外观）', () => {
    let asked = 0;
    const lookup = () => { asked++; return { portrait: 'x' }; };
    portraitEntry(M, { assets: { portrait: 'summer' } }, { lookup });
    assert.equal(asked, 0);
  });
});

describe('外观提供者：一个进程最多一个，没有时链与今天逐字相同', () => {
  test('setAppearanceLookup 只认第一个；currentAppearanceLookup 没注册时是 undefined', () => {
    clearAppearanceLookup();
    assert.equal(currentAppearanceLookup(), undefined, '没注册 ⇒ 不存在这一步（与今天逐字相同的那条路径）');
    assert.equal(setAppearanceLookup(() => null), true, '第一个成功');
    assert.equal(setAppearanceLookup(() => null), false, '第二个被拒（「谁提供外观」没有歧义）');
    assert.equal(typeof currentAppearanceLookup(), 'function');
    clearAppearanceLookup();
    assert.equal(currentAppearanceLookup(), undefined, '清掉之后回到「不存在」');
    assert.equal(setAppearanceLookup(null), false, '非函数不接受');
  });

  test('把 currentAppearanceLookup 直接当 opts.lookup 用：注册后链真的走它', () => {
    clearAppearanceLookup();
    const before = portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }, { lookup: currentAppearanceLookup() });
    assert.equal(before, 'a/p1.png', '注册前：回落原版');
    setAppearanceLookup((kind, charId, id) => (id === 'summer' ? { portrait: 'skin/s.png' } : null));
    const after = portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }, { lookup: currentAppearanceLookup() });
    assert.equal(after, 'skin/s.png', '注册后：走提供者');
    clearAppearanceLookup();
  });
});

describe('简写与清单缺失', () => {
  test('portraitUrlOf / avatarUrlOf 是同一函数的两个 kind', () => {
    assert.equal(portraitUrlOf(M, { charId: 'char_a' }), 'a/p1.png');
    assert.equal(avatarUrlOf(M, { charId: 'char_a' }), 'a/v1.png');
  });

  test('清单里没有 chars（或清单本身是 null）⇒ null，不抛', () => {
    assert.equal(portraitEntry(null, { charId: 'char_a' }), null);
    assert.equal(portraitEntry({}, { charId: 'char_a' }), null);
    assert.equal(portraitEntry(M, { charId: 'ghost' }), null);
  });
});

// ---------------------------------------------------------------------------------------------------
// 消费点：立绘与头像**走同一条链**（皮肤层设计稿的开放问题 2 —— 时装也影响小头像这一类）。
//
// 这条测的不是链本身，而是「**没有哪个消费点漏掉**」：漏掉的那个会继续读旧函数，
// 于是同一个干员在结算页是原版、在详情页是新装 —— 一个没人会报的错（两个画面各自都对）。
// ---------------------------------------------------------------------------------------------------
describe('消费点都接了链（源码级守卫）', () => {
  const ROOT = new URL('../../', import.meta.url);
  const read = async (rel) => (await import('node:fs')).readFileSync(new URL(rel, ROOT), 'utf8');

  /** 这些文件以前直接调旧函数，现在必须全走链。 */
  const CONSUMERS = [
    'public/js/ui/gameComponents.js',     // UnitThumb：结算页 / 队伍面板 / 手牌共用的小头像
    'public/js/ui/detailPanel.js',        // 详情页立绘
    'public/js/ui/shopBar.js',            // 商店卡立绘
    'public/js/ui/fallbackField.js',      // 补位小头像
    'public/js/screens/loadout.js',       // 干员调配：立绘 + 头像
    'public/js/screens/diy.js',           // 自选编队
    'public/js/screens/ownership.js',     // 干员持有
    'public/js/screens/support.js',       // 助战列表
  ];

  test('没有任何消费点还在直接调旧函数（调用，不是 import）', async () => {
    for (const f of CONSUMERS) {
      const src = await read(f);
      for (const old of ['chessAvatarUrl', 'chessPortraitUrl']) {
        const calls = src.split('\n').filter((l) => !/^\s*import\b/.test(l) && l.includes(`${old}(`));
        assert.equal(calls.length, 0, `${f} 还在直接调 ${old}()：${calls[0]?.trim()}`);
      }
    }
  });

  test('每个消费点都传了 hook（`currentAppearanceLookup()`）—— 否则装了时装也不生效', async () => {
    for (const f of CONSUMERS) {
      const src = await read(f);
      const usesChain = /(portraitUrlOf|avatarUrlOf)\(/.test(src);
      assert.ok(usesChain, `${f} 应当用链上的简写`);
      assert.ok(src.includes('currentAppearanceLookup'), `${f} 必须传 hook`);
    }
  });
});
