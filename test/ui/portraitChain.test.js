// 立绘 / 头像的**解析链**（`public/js/ui/portraitChain.js`）：一条链，旧行为是它的分支。
//
// 这份测试的核心手法：拿**今天那两个实现**（`assetUrls.chessPortraitUrl` / `assets.portraitUrl`）当**对照**，
// 对同一批输入逐项比对「没有 hook 时逐字相同」。这比手写期望值硬 —— 手写的期望会跟着我的实现一起漂。
//
// Run: node --test test/ui/portraitChain.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chessPortraitUrl, chessAvatarUrl } from '../../public/js/ui/assetUrls.js';
import { DEFAULT_SETTINGS } from '../../public/js/ui/gameLogic/settings.js';
import {
  portraitEntry, portraitUrlOf, avatarUrlOf,
  setAppearanceLookup, currentAppearanceLookup, clearAppearanceLookup,
  setAppearanceFirst, appearanceFirstEnabled,
} from '../../public/js/ui/portraitChain.js';

/**
 * 一份小清单：官方两条记录 + 一条 `_2`（精锐）+ 一条只有 E2 立绘的。
 */
const M = {
  chars: {
    char_a: { portrait: 'a/p1.png', portraitE2: 'a/p2.png', avatar: 'a/v1.png', avatarE2: 'a/v2.png' },
    char_b: { portrait: 'b/p1.png', avatar: 'b/v1.png' },                    // 没有 E2
    char_c: { portrait: 'c/p1.png', avatar: 'c/v1.png' },
    char_c_2: { portrait: 'c2/p1.png', portraitE2: 'c2/p2.png', avatar: 'c2/v1.png', avatarE2: 'c2/v2.png' },
  },
};

/**
 * 一批覆盖真实形状的输入（含边界：无 assets、空 id、后缀、精锐、不存在的 id）—— **两个方向共用**，
 * 所以「开关关掉时逐字相同」与「开关打开时新增的只有提供者那一步」比的是同一批输入。
 */
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

/**
 * 拿今天那两个实现当对照，逐项比对「开关**关掉**时逐字相同」。
 *
 * 两个方向共用一份判据（业主的硬验收点）：关的那一次**每一个输入**都必须与旧实现相同（除了那条被有意
 * 并进来的「精确命中」，单独一条断言钉它）；开的那一次只允许在**提供者真的给了一套**的那一种输入上不同。
 * @param {boolean} skins 工坊外观开关（`opts.skins`；不用模块门控，所以两个方向在同一次运行里互不干扰）
 */
function compareWithToday(skins) {
  for (const c of CASES) {
    const got = portraitEntry(M, c.chess, { skins });
    const want = chessPortraitUrl(M, c.chess);
    // 唯一有意的差异：`assets.portrait` 是 `chars` 里的**精确键**时，链用精确命中（步骤 3），
    // 而旧的 `chessPortraitUrl` 忽略它（它只认 `_1`/`_2`）。这是「把 portraitUrl 的行为并进来」那一步，
    // 也是这次统一要消掉的分叉 —— 单独一条断言钉住它，其余输入必须**逐字相同**。
    const exactHit = !!(c.chess && c.chess.assets && c.chess.assets.portrait && M.chars[c.chess.assets.portrait]);
    if (exactHit) continue;
    assert.equal(got, want, `skins=${skins} ${c.name}: 链 = ${JSON.stringify(got)}，而详情页那条 = ${JSON.stringify(want)}`);
  }
  for (const c of CASES) {
    const got = avatarUrlOf(M, c.chess, { skins });
    const want = chessAvatarUrl(M, c.chess);
    assert.equal(got, want, `skins=${skins} ${c.name}: 头像链 = ${JSON.stringify(got)}，今天 = ${JSON.stringify(want)}`);
  }
}

describe('解析链：没有 hook 时与今天**逐字相同**（开关开与关两个方向）', () => {
  test('立绘：除「精确命中」那一种输入外，与 chessPortraitUrl 逐字相同', () => {
    for (const c of CASES) {
      const got = portraitEntry(M, c.chess);
      const want = chessPortraitUrl(M, c.chess);
      const exactHit = !!(c.chess && c.chess.assets && c.chess.assets.portrait && M.chars[c.chess.assets.portrait]);
      if (exactHit) continue;
      assert.equal(got, want, `${c.name}: 链 = ${JSON.stringify(got)}，而详情页那条 = ${JSON.stringify(want)}`);
    }
  });

  test('头像：与 chessAvatarUrl 逐例一致 —— 上游 0.3.1 起头像**也**看 isGolden', () => {
    for (const c of CASES) {
      const got = avatarUrlOf(M, c.chess);
      const want = chessAvatarUrl(M, c.chess);
      assert.equal(got, want, `${c.name}: 头像链 = ${JSON.stringify(got)}，今天 = ${JSON.stringify(want)}`);
    }
    // 上游 0.3.1 改了这条语义（`chessAvatarUrl` 的 avatarE2 分支）：精锐棋子在该角色条目有 E2 头像时
    // 用 `avatarE2`，头像与立绘在这一点上**一致**了。0.3.0 的旧约定（精锐变体由调用方自己传）已被上游取消。
    assert.equal(avatarUrlOf(M, { charId: 'char_a', isGolden: true }), 'a/v2.png', '精锐头像走 avatarE2');
    assert.equal(portraitEntry(M, { charId: 'char_a', isGolden: true }, { kind: 'portrait' }), 'a/p2.png', '立绘同样走 E2');
  });

  test('开关**关掉**时：逐项与今天相同（这是那条最硬的验收点）', () => {
    // 这里显式写 `skins: false`，而不是靠「没注册提供者」—— 后者只是**今天**的偶然，前者是那句
    // 「开关关掉时一个字节的行为都不变」本身。两个对照实现都在这份文件里，所以判据不是我手写的期望值。
    compareWithToday(false);
  });

  test('开关关掉时**注册了提供者也不问**：一个字节都不变', () => {
    clearAppearanceLookup();
    let asked = 0;
    setAppearanceLookup((kind, charId, id) => { asked++; return { portrait: 'skin/never.png' }; });
    try {
      for (const c of CASES) {
        assert.equal(portraitEntry(M, c.chess, { skins: false }), portraitEntry(M, c.chess, { skins: false, lookup: undefined }),
          `${c.name}: 关掉时链只看自己的输入`);
      }
      assert.equal(asked, 0, '关掉时提供者一次都不该被问到');
    } finally { clearAppearanceLookup(); }
    // 模块门控（`setAppearanceFirst`）是另一个方向上的同一条：关掉它时**连显式打开 opts 也不问**
    setAppearanceFirst(false);
    try {
      let asked2 = 0;
      setAppearanceLookup(() => { asked2++; return { portrait: 'skin/never.png' }; });
      try {
        compareWithToday(false);
        compareWithToday(true);        // 门控关掉时，`opts.skins: true` 也压不过它
        assert.equal(asked2, 0, '模块门控关掉时提供者一次都不该被问到');
      } finally { clearAppearanceLookup(); }
    } finally { setAppearanceFirst(true); }
  });

  test('精确命中的 id：链用上了它（这是把 portraitUrl 的行为并进来的一步）', () => {
    // 这条正是**两条旧链的差异**：`chessPortraitUrl` 会忽略 `char_c`（不是 _1/_2）而回落 char_a；
    // 链必须**先看精确命中**（第 3 步），否则一套外部外观的 id 永远不会被认出来。
    const id = portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c' } });
    assert.equal(id, 'c/p1.png', '精确命中优先于回落');
    // 也就是说：这一条**有意**与旧的 chessPortraitUrl 不同 —— 差异集中在「id 是 chars 里的精确键」这一种输入上。
    // 上游 0.3.1 起 `chessPortraitUrl` 自己也认「id 是 chars 里的精确键」了（它多了 E2 那一条分支），
    // 所以这一条现在与链一致 —— 0.3.0 时旧实现确实忽略它，那条差异已经被上游抹平。
    assert.equal(chessPortraitUrl(M, { charId: 'char_a', assets: { portrait: 'char_c' } }), 'c/p1.png', '旧实现现在也认精确键');
    // 开了工坊外观也一样：**没有提供者**时这一步整段不存在（这是「默认开」仍然安全的原因）
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c' } }, { skins: true }), 'c/p1.png');
  });

  test('`_1` / `_2` 后缀是链的第一分支，不受 hook 影响', () => {
    const spy = () => { throw new Error('后缀分支不该调用 hook'); };
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_2' } }, { lookup: spy }), 'a/p2.png');
    assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_1' } }, { lookup: spy }), 'a/p1.png');
  });

  test('开关打开但**没有提供者**时：与今天逐字相同（「默认开」不改变任何画面）', () => {
    clearAppearanceLookup();
    // `skins: true` 就是**默认那一条**：一台装了包、但没有任何面板注册外观的服务器，每一帧都走这里。
    // 判据是「开着**且**确有提供者」，两者缺一即整段不存在 —— 所以这里逐项比对照，比的是「没有提供者」那一半。
    compareWithToday(true);
    assert.equal(setAppearanceLookup(null), false, '非函数不接受（与既有那条一致）');
    compareWithToday(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// 「提供者先说话」（步骤 0）：开关打开**且**确实注册了提供者时，链在 `_1`/`_2` 后缀那一步**之前**
// 先问一次；给 `null` / 抛错 / 给一个没有可用字段的对象 ⇒ 继续走原来的链。
//
// 这一段是业主裁决的那条口径的落点：**不去**改 `chess.assets.portrait`（那要引擎认识皮肤），而是让引擎
// 把不透明 id 交给提供者问一次 —— 引擎仍然不认识「皮肤」。
// ---------------------------------------------------------------------------------------------------
describe('提供者先说话（步骤 0）：开关打开且确有提供者', () => {
  /** 一段有提供者的时间；无论如何都恢复成「没有提供者」。 */
  const withProvider = (lookup, body) => {
    clearAppearanceLookup();
    assert.equal(setAppearanceLookup(lookup), true, '这一段里提供者必须真的注册上');
    try { body(); } finally { clearAppearanceLookup(); }
  };

  test('提供者给的一套赢过 `chars` 里的**精确命中**（顺序：先问，再走旧链）', () => {
    // 这条正是「先说话」的含义：`char_c` 在 `chars` 里有记录（步骤 3 会命中），提供者也认识这套外观 ——
    // 提供者必须**先被问到**，否则玩家选的时装永远被 `chars` 里同名的那一条挡住。
    withProvider((kind, charId, id) => (id === 'char_c' && charId === 'char_a' ? { portrait: 'skin/c.png', avatar: 'skin/c_v.png' } : null), () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c' } }), 'skin/c.png');
      assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'char_c' } }), 'skin/c_v.png');
    });
  });

  test('调用方点名了 `_1`/`_2` 版本 ⇒ 提供者**不让位、也不被问到**（调用方 > 提供者）', () => {
    // 【行为变更，业主裁决「头像与立绘要能分开受控」】这一条以前钉的是「后缀命中也要让位」。
    // 现在反过来：`_1` / `_2` 是调用方**点名一个版本**的既有编码（`assetUrls.js` 逐字同一套语义），
    // 属于优先级的第一档 ⇒ 提供者不参与。理由：别人明确要精锐立绘（`_2` / `isGolden`）时，
    // 不该被一份「只有一张头像图」的时装盖掉 —— 那正是业主报的那个错。
    let asked = 0;
    withProvider((kind, charId, id) => { asked++; return ({ portrait: 'skin/a2.png' })[kind] || null; }, () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_2' } }), 'a/p2.png', '点名 E2 ⇒ 官方 E2');
      assert.equal(chessPortraitUrl(M, { charId: 'char_a', assets: { portrait: 'char_a_2' } }), 'a/p2.png', '与旧实现逐字相同');
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_1' } }), 'a/p1.png', '点名一阶 ⇒ 官方一阶');
      assert.equal(asked, 0, '点名了版本就不该打扰提供者');
      // 夹具里的 `char_c_2` 是一条**真实存在的记录**（官方精锐就是这样）：上游 0.3.1 起
      // `chessPortraitUrl` 也认精确键，所以两边都直接用它自己的 `portrait`，不再走「去掉 _2」那条分支。
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c_2' } }), 'c2/p1.png');
      assert.equal(chessPortraitUrl(M, { charId: 'char_a', assets: { portrait: 'char_c_2' } }), 'c2/p1.png', '与旧实现逐字相同');
    });
  });

  test('提供者给 null / 抛错 / 给没有可用字段的对象 ⇒ 继续走原来的链', () => {
    const boom = () => { throw new Error('boom'); };
    for (const lookup of [() => null, boom, () => ({ nope: 'x' }), () => 'a string', () => ({}), () => undefined]) {
      withProvider(lookup, () => {
        assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'a/p1.png', '回落原版');
        assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_a_2' } }), 'a/p2.png', '后缀分支照旧');
        assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'char_c' } }), 'c/p1.png', '精确命中照旧');
      });
    }
  });

  test('没有 charId 或没有 assets 里的 id 时不问（提供者按这两样归属一套外观）', () => {
    withProvider(() => { throw new Error('不该被问到'); }, () => {
      assert.equal(portraitEntry(M, { assets: { portrait: 'summer' } }), null, '没有 charId ⇒ 步骤 5 也没有记录可回落');
      assert.equal(portraitEntry(M, { charId: 'char_a' }), 'a/p1.png', '没有 id ⇒ 直接回落');
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: {} }), 'a/p1.png');
    });
  });

  test('问的是**模块级那一个**提供者，不是调用点传进来的函数', () => {
    // 失败形态很坏：一个陈旧的捕获值（`opts.lookup` 比注册晚）会把新提供者挡在外面，而画面**静默**回落原版。
    withProvider((kind, charId, id) => (id === 'summer' ? { portrait: 'skin/registered.png' } : null), () => {
      const stale = () => null;
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }, { lookup: stale }), 'skin/registered.png',
        '链问的是注册上的那一个，不是这个调用点的引用');
    });
  });

  test('模块门控（`setAppearanceFirst`）：设置关掉后再打开，链跟着走', () => {
    assert.equal(appearanceFirstEnabled(), true, '默认开（与 DEFAULT_SETTINGS.workshopSkins 同值）');
    clearAppearanceLookup();
    setAppearanceLookup((kind, charId, id) => (id === 'summer' ? { portrait: 'skin/s.png' } : null));
    try {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'skin/s.png', '开着 ⇒ 提供者先说话');
      setAppearanceFirst(false);
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'a/p1.png', '关掉 ⇒ 提供者不说话');
      setAppearanceFirst(true);
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'skin/s.png', '再打开 ⇒ 又回来了');
    } finally {
      clearAppearanceLookup();
      setAppearanceFirst(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 立绘与头像**分开受控**（业主裁决）：链按 kind 各问一次、各答一次；调用方点名了版本时提供者不参与。
//
// 这两段是本次改动的判据。第一条的失败形态是业主实测撞到的那个：一份只有 `avatar` 图的时装，
// 选了之后**头像与立绘都变成那张图**；第二条的失败形态是「调用方明确要精锐立绘，被时装盖成普通版」。
// ---------------------------------------------------------------------------------------------------
describe('立绘与头像分开受控：按 kind 各问各的', () => {
  /** 注册一段提供者；函数或 `{ lookup }` 都收（后者就是 `appearance(ctx)` 返回的那个形状）。 */
  const withProvider = (provider, body) => {
    clearAppearanceLookup();
    const lookup = typeof provider === 'function' ? provider : provider.lookup;
    assert.equal(setAppearanceLookup(lookup), true, '这一段里提供者必须真的注册上');
    try { body(); } finally { clearAppearanceLookup(); }
  };

  test('一份**只有头像图**的时装：立绘回落官方、头像用时装那张', () => {
    // 形状照真实时装写：`art` 里只有 `avatar`（业主撞到的就是这种包）。
    const onlyAvatar = (kind, charId, id) => (id === 'summer' && kind === 'avatar' ? { avatar: 'skin/summer_v.png' } : null);
    withProvider(onlyAvatar, () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'a/p1.png',
        '立绘：提供者没有立绘图 ⇒ 回落官方立绘，不许拿头像顶上');
      assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'summer' } }), 'skin/summer_v.png',
        '头像：这一条 kind 有图 ⇒ 用时装那张');
    });
    // 反过来：一份只有立绘图的时装，头像回落官方 —— 两边**都不串**
    const onlyPortrait = (kind, charId, id) => (id === 'summer' && kind === 'portrait' ? { portrait: 'skin/summer_p.png' } : null);
    withProvider(onlyPortrait, () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'skin/summer_p.png');
      assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'summer' } }), 'a/v1.png', '头像不许拿立绘顶上');
    });
  });

  test('提供者拿到的 kind 就是这一条链的 kind（`portrait` / `avatar`），而且只问一次', () => {
    const seen = [];
    // 按 kind 各答各的字段 —— 这就是提供者契约的形状（`appearance(ctx)` 里那个 `lookup`）。
    const both = (kind, charId, id) => { seen.push(kind); return kind === 'avatar' ? { avatar: 'skin/v.png' } : { portrait: 'skin/p.png' }; };
    withProvider(both, () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'skin/p.png');
      assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'summer' } }), 'skin/v.png');
    });
    assert.deepEqual(seen, ['portrait', 'avatar'], '每次调用只问一次，而且送的是这一条 kind');
  });

  test('提供者只答另一条 kind 的字段 ⇒ **不算答案**（链继续走自己的路，不串）', () => {
    // 这正是那个错的形状：提供者不区分 kind，一律给 `{ avatar }`。
    withProvider(() => ({ avatar: 'skin/top.png' }), () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'a/p1.png', '立绘不认 avatar 字段');
      assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'summer' } }), 'skin/top.png', '头像照旧用时装那张');
    });
    // 也不认「不是对象」的返回值（裸字符串 / 数字）：那是坏形状 ⇒ 同一个回落，链不猜。
    withProvider(() => 'skin/top.png', () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }), 'a/p1.png', '裸字符串不是一套外观');
    });
  });

  test('`opts.variant: elite`（调用方的显式写法）⇒ 提供者不参与', () => {
    let asked = 0;
    withProvider(() => { asked++; return { portrait: 'skin/p.png', avatar: 'skin/v.png' }; }, () => {
      assert.equal(portraitEntry(M, { charId: 'char_a', assets: { portrait: 'summer' } }, { variant: 'elite' }), 'a/p2.png',
        '点名精锐 ⇒ 官方 E2');
      assert.equal(avatarUrlOf(M, { charId: 'char_a', assets: { avatar: 'summer' } }, { variant: 'elite' }), 'a/v2.png',
        '头像点名精锐 ⇒ 官方 E2（`isGolden` 那条只对立绘）');
      assert.equal(portraitEntry(M, { charId: 'char_b', assets: { portrait: 'summer' } }, { variant: 'elite' }), 'b/p1.png',
        '这个干员没有精锐字段 ⇒ 官方回落，不是 null');
      assert.equal(asked, 0, '点名了版本就不该打扰提供者');
    });
  });

  test('调用方显式点名的精锐立绘不被盖：`isGolden` 时提供者不参与（头像不受影响）', () => {
    const seen = [];
    const both = (kind, charId, id) => { seen.push(kind); return kind === 'avatar' ? { avatar: 'skin/v.png' } : { portrait: 'skin/p.png' }; };
    withProvider(both, () => {
      // 详情页 / 商店卡那条既有语义：精锐画 `portraitE2`
      assert.equal(portraitEntry(M, { charId: 'char_a', isGolden: true, assets: { portrait: 'summer' } }), 'a/p2.png',
        '别人明确要精锐立绘 ⇒ 时装不许盖');
      // 头像**不看** `isGolden`（精锐头像由调用方自己传变体）⇒ 时装在这条 kind 上照旧生效
      assert.equal(avatarUrlOf(M, { charId: 'char_a', isGolden: true, assets: { avatar: 'summer' } }), 'skin/v.png',
        '头像这一条 kind 与 isGolden 无关，照旧问提供者');
    });
    assert.deepEqual(seen, ['avatar'], '只有头像那一次被问到（立绘那一次被点名版本短路了）');
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

// ---------------------------------------------------------------------------------------------------
// 设置 →「工坊外观」这条线（源码级守卫）：开关**必须有唯一一个写入面**，而且它接的是链上那一个门控。
//
// 为什么是源码守卫而不是行为测试：`ui/settings.js` 会拖进 Preact 与一整套界面（audio / data / 语言包），
// 在 Node 里 import 它只为断言一次 `setAppearanceFirst` 不值得 —— 而这一条真正会坏的方式是**改名 / 漏接**，
// 那正好是源码层面看得出来的。链那一边的行为由上面两个方向钉住。
// ---------------------------------------------------------------------------------------------------
describe('设置 →「工坊外观」：门控与设置的接线（源码级守卫）', () => {
  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

  test('设置的默认值与链的默认门控同值（默认开）', () => {
    assert.equal(DEFAULT_SETTINGS.workshopSkins, true);
    assert.equal(appearanceFirstEnabled(), true, '链的模块门控默认开（与设置默认同值）');
  });

  test('`ui/settings.js` 是那条线唯一的写入面：订阅里与首帧之前各同步一次', () => {
    const src = read('public/js/ui/settings.js');
    assert.ok(src.includes('setAppearanceFirst'), 'ui/settings.js 必须同步门控');
    assert.ok(/setAppearanceFirst\(\s*s\.workshopSkins\s*\)/.test(src),
      '订阅里那一句必须跟着 store 的 workshopSkins 走（否则改开关不会立刻生效）');
    // 与 applyTextSize 同一条纪律：**第一帧之前**同步好，否则首帧用链的默认值、下一帧才改成玩家的选择。
    assert.ok(/^setAppearanceFirst\(settingsStore\.get\(\)\.workshopSkins\);$/m.test(src),
      '启动时也要同步一次（第一帧之前）');
    // 开关界面那一个 Toggle：`value` 与 `onChange` 都接同一个键（props 的先后顺序不重要，
    // 所以这里分两条断言 —— 一条整体正则会被 `value=${s.workshopSkins}` 里那个同名的键带偏）。
    assert.ok(/onChange=\$\{\(v\) => updateSettings\(\{\s*workshopSkins\s*:\s*v\s*\}\)\}/.test(src),
      '开关界面那一个 Toggle 必须写进同一份设置');
    assert.ok(/value=\$\{s\.workshopSkins\}/.test(src), '并且它的当前值来自同一份设置');
  });

  test('链不 import 设置 / store（引擎不认识皮肤，设置也不反向依赖链）', () => {
    const chain = read('public/js/ui/portraitChain.js');
    const imports = chain.split('\n').filter((l) => /^\s*import\b/.test(l));
    assert.deepEqual(imports, [], `portraitChain.js 今天一个 import 都没有；加了 import 就要重新审这条边界：${imports.join(' | ')}`);
    assert.equal(/settingsStore|sanitizeSettings|localStorage/.test(chain), false, '链自己不认识设置');
  });
});
