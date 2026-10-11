// test/workshopDeclTypes.test.js — `pack.json` 的版本声明写成**非字符串**时必须点名拒绝（B7 段）。
//
// 缺口：`shared/workshop.js` 的 `strField` 把非字符串一律读成 `null`（"缺省与写错都读成没声明"），而 `api` /
// `game` / `gameVersion` 的解析**只有它一个人**。于是 `api: 1`（JSON 数字）在 `api &&` 的两条校验里都短路，
// 归一化结果 `api: null` —— 包当没声明一样通过，作者看到的是「包合法、我写的区间没生效」。失败方向是静默的，
// 正是本仓库 §1.1 那句「写了等于没写」。本文件钉住修复后的三条契约：
//
//   1. **键存在且不是字符串 ⇒ 当场拒绝**：`BAD_API_TYPE` / `BAD_GAME_TYPE`，理由里点名**是哪个键**、**写成了
//      什么类型**、以及「非字符串会被读成没声明」这句话。这三个键的判据只看**类型**，不看打包出来的值好不好看。
//   2. **没有这几个键的包逐字节不变**（本刀最硬的一条）：`api` / `game` / `gameVersion` 三个键全缺时，归一化结果
//      与「显式 `undefined`」逐字段相同、身份哈希相同，且归一化清单里不多出任何键 —— 否则所有已存在的包摘要
//      都会变，房间的摘要闸门随之误判（DESIGN §28.2）。
//   3. **`null` / 空串不是类型错误**：仓库既有语义是「`null` = 没有这个键」（编辑器的写元数据那一端把 `null`
//      当"删掉这个键"，`layer` 的解析分支对 `undefined || null` 逐字相同），所以它们与缺键同一后果。
//
// 断言的是**拒绝码**而不是「失败了就行」：一个静默丢弃的声明比一条报错坏得多。
// Run: node --test test/workshopDeclTypes.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePackManifest } from '../shared/workshop.js';
import { canonicalJson, sha256Hex } from '../shared/modIdentity.js';
import { MOD_API_VERSION } from '../shared/constants.js';

/** 归一化一份临时的 `pack.json`（目录名与 id 一致）。`content: ['chess']` 让它免于 `EMPTY_PACK`。 */
const norm = (raw, opts = {}) => normalizePackManifest({ id: 'p', ...raw }, 'p', opts);
/** 一个「除了被测字段之外都合法」的最小包。 */
const MIN = { content: ['chess'] };
/** 归一化清单的身份哈希：`identifyPack` 哈希的就是这份清单（`sha256Hex(canonicalJson(pack))`）。 */
const identityHash = (pack) => sha256Hex(canonicalJson(pack));

describe('B7：`api` 的类型闸门（声明了就不能不是字符串）', () => {
  test('`api: 1`（数字）⇒ BAD_API_TYPE，且**不是** BAD_API_RANGE', () => {
    const r = norm({ ...MIN, api: 1 });
    assert.equal(r.ok, false, '数字声明必须被拒，不能静默变成 null');
    assert.equal(r.error, 'BAD_API_TYPE');
    assert.match(r.detail, /"api"/, '理由里要点名是哪个键');
    assert.match(r.detail, /\bnumber\b/, '理由里要写出实际类型');
    assert.match(r.detail, /not declared/, '理由里要说清后果：会被读成"没声明"');
    // 类型错误必须是**第一条**判罚：`api: 1` 从来不是"坏区间"，把它报成 BAD_API_RANGE 会把作者引到错的地方
    assert.notEqual(r.error, 'BAD_API_RANGE');
  });

  test('非字符串的其它形状同样点名拒绝（布尔 / 数组 / 对象）', () => {
    for (const [v, what] of [[true, /\bboolean\b/], [['1.x'], /an array/], [{ range: '1.x' }, /\bobject\b/]]) {
      const r = norm({ ...MIN, api: v });
      assert.equal(r.ok, false, `${JSON.stringify(v)} 必须被拒`);
      assert.equal(r.error, 'BAD_API_TYPE');
      assert.match(r.detail, what);
    }
  });

  test('`api: "1"` 通过，值照写进归一化清单；区间照旧先判语法再判可比对', () => {
    const ok = norm({ ...MIN, api: '1' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.pack.api, '1');
    assert.equal(norm({ ...MIN, api: '1.x' }).ok, true);
    assert.equal(norm({ ...MIN, api: '1.x ' }).ok, true, '两端空白被 trim，trim 之后的区间照旧判');
    assert.equal(norm({ ...MIN, api: 'not a range' }).error, 'BAD_API_RANGE', '写了坏的区间照旧 BAD_API_RANGE');
    assert.equal(norm({ ...MIN, api: '2.x' }).error, 'MOD_API_INCOMPATIBLE', `区间不含本 build（${MOD_API_VERSION}）`);
  });

  test('缺 `api` ⇒ 与今天逐字节相同：不报错、归一化结果与显式 undefined 一致', () => {
    const absent = norm({ ...MIN });
    assert.equal(absent.ok, true);
    assert.equal(absent.pack.api, null, '这个值本刀没有改（既有裁决，见 docs/WORKSHOP.md §1.9）');
    const explicitUndefined = norm({ ...MIN, api: undefined });
    assert.deepEqual(explicitUndefined.ok, absent.ok);
    assert.equal(explicitUndefined.pack.api, absent.pack.api);
    assert.equal(identityHash(explicitUndefined.pack), identityHash(absent.pack));
  });

  test('`api: null` / `api: ""` / `api: "   "` 按「等于没写」处理（不是类型错误）', () => {
    for (const v of [null, '', '   ']) {
      const r = norm({ ...MIN, api: v });
      assert.equal(r.ok, true, `${JSON.stringify(v)} 不是类型错误`);
      assert.equal(r.pack.api, null, `${JSON.stringify(v)} 读成"没声明"`);
    }
  });
});

describe('B7：`game` / `gameVersion` 的类型闸门', () => {
  test('`game: 1`（数字）⇒ BAD_GAME_TYPE', () => {
    const r = norm({ ...MIN, game: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'BAD_GAME_TYPE');
    assert.match(r.detail, /"game"/);
    assert.match(r.detail, /\bnumber\b/);
    assert.notEqual(r.error, 'BAD_GAME_RANGE');
  });

  test('`game: "0.2.0"` 通过；坏区间照旧 BAD_GAME_RANGE', () => {
    const ok = norm({ ...MIN, game: '0.2.0' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.pack.game, '0.2.0');
    assert.equal(norm({ ...MIN, game: 'not a range' }).error, 'BAD_GAME_RANGE');
  });

  test('`gameVersion` 是 `game` 的别名，同一条类型闸门、同一个码', () => {
    const bad = norm({ ...MIN, gameVersion: 1 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'BAD_GAME_TYPE');
    assert.match(bad.detail, /"gameVersion"/, '理由里要点名是别名那一个键');
    assert.match(bad.detail, /\bnumber\b/);
    // 别名写了合法的字符串：照旧原样保留、不校验（它是"作者针对的游戏版本"这条元信息）
    assert.equal(norm({ ...MIN, gameVersion: '0.1.3' }).pack.game, '0.1.3');
    assert.equal(norm({ ...MIN, gameVersion: '0.1.3' }).pack.gameVersion, '0.1.3');
  });

  test('`game` 写坏、`gameVersion` 合法：仍然是错（不问"这个字段有没有人读"）', () => {
    const r = norm({ ...MIN, game: 1, gameVersion: '0.2.0' });
    assert.equal(r.ok, false, 'game 被 gameVersion 盖住不是"没事"——作者改错的那个键要报出来');
    assert.equal(r.error, 'BAD_GAME_TYPE');
    assert.match(r.detail, /"game"/);
  });

  test('缺 `game` / `gameVersion` ⇒ 与今天逐字节相同；`null` / 空串 = 没声明', () => {
    const absent = norm({ ...MIN });
    assert.equal(absent.ok, true);
    assert.equal(absent.pack.game, null);
    assert.equal(absent.pack.gameVersion, null);
    const explicitUndefined = norm({ ...MIN, game: undefined, gameVersion: undefined });
    assert.equal(identityHash(explicitUndefined.pack), identityHash(absent.pack));
    // 三个值各自的结果与修复前**逐字相同**：`game` 经 strField（trim 过、空白串读成 null），`gameVersion` 是
    // 原样保留的元信息（**不 trim**：`""` 读成 null，`"   "` 照旧原样留着 —— 两条都是既有行为，本刀没有顺手改它）
    for (const [v, game, gameVersion] of [[null, null, null], ['', null, null], ['   ', null, '   ']]) {
      const r = norm({ ...MIN, game: v, gameVersion: v });
      assert.equal(r.ok, true, `${JSON.stringify(v)} 不是类型错误`);
      assert.equal(r.pack.game, game, `game ${JSON.stringify(v)}`);
      assert.equal(r.pack.gameVersion, gameVersion, `gameVersion ${JSON.stringify(v)} 原样保留`);
    }
  });

  test('优先级一字未改：`game` 是空串时落到 `gameVersion`', () => {
    const r = norm({ ...MIN, game: '', gameVersion: '0.2.0' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pack.game, '0.2.0');
    assert.equal(r.pack.gameVersion, '0.2.0');
  });
});

describe('B7：没写这几个键的包，行为逐字节不变（本刀最硬的一条）', () => {
  test('三个键全缺 ⇒ 归一化清单不多出任何键，身份哈希与"显式 undefined"相同', () => {
    const absent = norm({ ...MIN });
    const explicitUndefined = norm({ ...MIN, api: undefined, game: undefined, gameVersion: undefined });
    assert.equal(absent.ok, true);
    assert.equal(identityHash(absent.pack), identityHash(explicitUndefined.pack),
      '缺键与 undefined 必须同一条路：都读成没声明、都不进任何新分支');
    // 逐字段相同：多一个键、少一个键都会被这条抓住
    assert.deepEqual(Object.keys(absent.pack), Object.keys(explicitUndefined.pack));
    assert.ok(!Object.hasOwn(absent.pack, 'declaredApi'), '不新增归一化键');
  });

  test('缺键包的身份哈希：本刀没有让它动一个字节', () => {
    // `api` / `game` / `gameVersion` 三个键全缺的最小包的身份哈希。这条断言是"缺键路径逐字节不变"的机器证明
    // —— 修复前算出来的就是这个值（本刀的 mutation 复核里，把三道类型闸门短路掉之后这一条仍然绿）。
    const pack = norm({ ...MIN }).pack;
    assert.equal(identityHash(pack), 'f86f23822d74c1f76f7da77c42a3825c1991dea54ce704ac6e7878cad908f45b', '缺键包的身份哈希本刀不变');
  });

  test('`api` / `game` 仍然不是贡献项：只带它们的包照旧 EMPTY_PACK', () => {
    assert.equal(norm({ content: [], api: '1.x' }).error, 'EMPTY_PACK');
    assert.equal(norm({ content: [], game: '0.2.0' }).error, 'EMPTY_PACK');
    // 空包那条判罚在版本声明**之前**（既有次序，本刀没动）：两个错都在时先报空包，再报类型
    assert.equal(norm({ content: [], api: 1 }).error, 'EMPTY_PACK');
    assert.equal(norm({ content: [], game: 1 }).error, 'EMPTY_PACK');
    // 有内容的包：`"1.x "` 两端空白被 trim 掉、照旧合法；`2`（数字）是类型错而不是"坏区间"
    assert.equal(norm({ ...MIN, api: '1.x ' }).ok, true);
    assert.equal(norm({ ...MIN, api: 2 }).error, 'BAD_API_TYPE');
  });
});
