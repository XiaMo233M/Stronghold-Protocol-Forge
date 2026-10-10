// test/packFanpackKits.test.js — 「一干员一文件」拆分的**端到端验收**（DESIGN §28.18 的包相对 import）。
//
// 被验的对象是业主侧**交付用**工坊包 `_up/mod-compat/deliver/packs/fanpack-kazdel-rhodes/`：它不在本仓库里
// （社区 mod 的内容按业主裁定**永不进这个仓库**，也不进发行版），所以这个文件全程用**绝对路径**，
// 并且目录不存在时**整体跳过** —— 与 `test/packMetaFanpack.test.js` 的既有做法一致
// （那个文件把移植出来的逻辑**内联**在测试里；这里不同：拆分的价值恰恰在于**文件本身**的形状，
// 内联会把这个测试要验的东西——`kits/<id>.js` + `kits/lib/*.js` + 包相对 import——整个抹掉）。
//
// 这个文件钉四件事：
//   1. **装载**：13 个干员文件（含别名件）全部走**真实** `loadWorkshopKits()` 装上，0 error；
//   2. **形状**：`kits/` 顶层恰好 13 个 `.js`、`lib/` 是子目录（§28.18：子目录不算 kit）、
//      共享逻辑**只有一份**（同一段辅助函数不得在多个干员文件里复制粘贴）；
//   3. **白名单**：每个文件的每一条 import 都过 `shared/kitImports.js` 的判据（`@kit/` / `@sim/` 白名单 +
//      包内向下 `./…`），**没有任何一处**为了过测试而偷偷扩大白名单；
//   4. **引擎常量守卫**：`kits/lib/constants.js` 的 `COLS` / `ROWS` 默认值必须等于引擎当前值 ——
//      这两个数是「副本」，漂移了格键算术就会整体错位（实测踩过：把 COLS 当 21 而引擎是 33，
//      凯尔希的 `kalts:outrange` 判罚与原件不同）。
//
// 不在这里跑真战场：等效性需要**原件**（业主侧的第三方 mod 原文，同样不在仓库里），
// 由 `tools/check-fanpack-kits.mjs --equiv` 与 `_up/mod-compat/out/equiv-*.mjs` 承担。
//
// Run: node --test test/packFanpackKits.test.js
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { kitImportIssues, kitImportDeclarations, isPackRelativeSpecifier } from '../shared/kitImports.js';
import { COLS, ROWS } from '../server/sim/constants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 交付包目录：业主侧「交付用」工坊包（不在仓库里）。 */
const PACK_DIR = process.env.SP_FANPACK_PACK
  ?? 'E:\\destop\\harness_1\\_up\\mod-compat\\deliver\\packs\\fanpack-kazdel-rhodes';
const PACKS_DIR = path.dirname(PACK_DIR);
const KITS_DIR = path.join(PACK_DIR, 'kits');
const LIB_DIR = path.join(KITS_DIR, 'lib');

/** 13 件 = 原件 `PACK_KITS` 的 12 个手写干员 + 1 个别名件（红豆）。 */
const EXPECTED_IDS = Object.freeze([
  'chess_char_9_01_a', // 红豆（别名件：复用官方同一干员的 kit）
  'chess_char_9_02_a', // 陨星
  'chess_char_9_04_a', // 闪灵
  'chess_char_9_06_a', // 赫德雷
  'chess_char_9_09_a', // 阿斯卡纶
  'chess_char_9_10_a', // 维什戴尔
  'chess_char_9_11_a', // 霜叶
  'chess_char_9_13_a', // 坚雷
  'chess_char_9_14_a', // 阿米娅
  'chess_char_9_16_a', // 煌
  'chess_char_9_18_a', // 凯尔希
  'chess_char_9_21_a', // Mon3tr
  'chess_char_9_22_a', // 逻各斯
]);

/** 共享逻辑应当落在这几个文件里（同一段辅助函数只定义一次）。 */
const EXPECTED_LIB = Object.freeze(['bb.js', 'constants.js', 'engine.js', 'unit.js']);

const hasPack = fs.existsSync(KITS_DIR);
const skip = hasPack ? false : `交付包不在本机：${PACK_DIR}（业主侧交付物，不进仓库）`;

describe('fanpack 拆包：一干员一文件 + 共享逻辑进 kits/lib/', { skip }, () => {
  let loaded;
  let data;
  let kitInfo;

  before(async () => {
    loaded = loadWorkshop(PACKS_DIR, { log: quiet });
    data = loadData(undefined, { log: quiet, workshopDir: PACKS_DIR });
    kitInfo = await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set(Object.keys(data.chess ?? {})) });
  });

  test('包本身能被 loadWorkshop 装载（content 声明了 chess，combat: true）', () => {
    assert.deepEqual(loaded.errors, [], `包被拒：${JSON.stringify(loaded.errors)}`);
    assert.ok(loaded.packs.some((p) => p.id === path.basename(PACK_DIR)), '交付包在已装载集合里');
    const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
    assert.ok(manifest.content.includes('chess'),
      'content 必须声明 chess —— 否则包内 chess.json 被**静默不读**（docs/WORKSHOP.md §1.1 那条坑）');
    assert.equal(manifest.combat, true, '带 kit 的包必须声明 combat: true');
  });

  test('13 件全部装上，0 error，默认导出都是函数', () => {
    assert.deepEqual(kitInfo.errors, [], `装载错误：${JSON.stringify(kitInfo.errors)}`);
    const ids = Object.keys(kitInfo.kits).sort();
    assert.deepEqual(ids, [...EXPECTED_IDS].sort(), '装载出来的 kit id 集合');
    for (const id of EXPECTED_IDS) {
      assert.equal(typeof kitInfo.kits[id], 'function', `${id} 的默认导出必须是 kit 函数（KIT_NO_DEFAULT_EXPORT）`);
    }
    assert.equal(kitInfo.modules.length, EXPECTED_IDS.length, 'modules 清单（浏览器要按 URL 取的那一份）');
  });

  test('每个 kit 都能用包内 chess 记录构造出 Kit（不抛异常，且给了 skill）', () => {
    for (const id of EXPECTED_IDS) {
      const rec = data.chess[id];
      assert.ok(rec, `${id} 必须在合并后的 data.chess 里（包内 chess.json 真的被读了）`);
      const kit = kitInfo.kits[id](rec.skill?.bb ?? {}, rec, rec);
      assert.equal(typeof kit, 'object', `${id}: kit 要返回一个对象`);
      // §4.1 第一条硬规则：返回了 kit 就必须自己给出 skill，否则这个干员没有技能。
      assert.ok(kit.skill || kit.skills, `${id}: 给了 kit 就必须给 skill / skills`);
    }
  });

  test('形状：kits/ 顶层恰好 13 个 .js；lib/ 是子目录因此不算 kit', () => {
    const top = fs.readdirSync(KITS_DIR, { withFileTypes: true });
    const jsFiles = top.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name).sort();
    assert.deepEqual(jsFiles, EXPECTED_IDS.map((id) => `${id}.js`).sort(), 'kits/ 顶层就是那 13 个干员文件');
    assert.ok(top.some((e) => e.isDirectory() && e.name === 'lib'), 'kits/lib/ 存在');
    // §28.18：子目录不是 kit —— 装载器不许把 lib/*.js 当成一个叫 "lib" 的干员。
    for (const name of Object.keys(kitInfo.kits)) {
      assert.ok(!name.includes('/') && name !== 'lib', `辅助文件被当成了 kit：${name}`);
    }
  });

  test('共享逻辑只定义一次：每个辅助 symbol 在 kits/ 下的定义处恰好一个', () => {
    const libFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(libFiles, [...EXPECTED_LIB].sort(), 'lib/ 的文件清单');

    // 同一段辅助逻辑**不得**在多个干员文件里复制粘贴 —— 这是这次拆分的核心价值。
    // 判据：每个辅助函数名在整个 kits/ 子树里的 `export const/function <name>` 定义处恰好 1 个。
    const SYMBOLS = ['num', 'mods', 'talentBb', 'batPct', 'on', 'whileOn', 'neighbors', 'inRangeOf', 'tokenOf',
      'hasHp', 'periodicDamage', 'bodyInKeys', 'PRIO_REVIVE', 'configure'];
    const allJs = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) allJs.push(p);
      }
    };
    walk(KITS_DIR);
    assert.equal(allJs.length, EXPECTED_IDS.length + EXPECTED_LIB.length, '干员文件 + lib 文件的总数');
    for (const sym of SYMBOLS) {
      const holders = allJs.filter((f) => new RegExp(`^export\\s+(?:const|function|let)\\s+${sym}\\b`, 'm').test(fs.readFileSync(f, 'utf8')));
      assert.equal(holders.length, 1,
        `辅助 symbol ${sym} 应当**只**定义在一处，实际在：${holders.map((f) => path.relative(KITS_DIR, f)).join(', ')}`);
    }
  });

  test('干员文件只用包相对 import 引用共享逻辑（不复制、也不向上走）', () => {
    for (const id of EXPECTED_IDS) {
      const src = fs.readFileSync(path.join(KITS_DIR, `${id}.js`), 'utf8');
      const decls = kitImportDeclarations(src);
      assert.ok(decls.length >= 1, `${id}: 至少要有 import（共享逻辑走 lib/）`);
      for (const d of decls) {
        const s = d.specifier;
        const legal = s.startsWith('@kit/') || s.startsWith('@sim/') || isPackRelativeSpecifier(s);
        assert.ok(legal, `${id}: import "${s}" 不在白名单、也不是包相对路径`);
        assert.ok(!s.includes('..'), `${id}: import "${s}" 含 ".."（§28.18 算术上两端不可能一致）`);
      }
    }
  });

  test('每个文件的每一条 import 都过装载器的判据（白名单没被偷偷扩大）', () => {
    const allJs = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) allJs.push(p);
      }
    };
    walk(KITS_DIR);
    for (const f of allJs) {
      const src = fs.readFileSync(f, 'utf8');
      const issues = kitImportIssues(src, kitImportDeclarations(src));
      assert.deepEqual(issues, [], `${path.relative(KITS_DIR, f)} 的 import 判罚`);
    }
  });

  test('kits/lib/ 里不许出现 @kit/ / @sim/ —— 实测的引擎限制，不是风格', () => {
    // 为什么单独钉这一条：`loadWorkshopKits()` 的 `rewriteKitImports()` 只作用在**被加载的那个 kit 文件自己的
    // 源码**上；`./lib/x.js` 交给 Node 的是一个真实 `file:` URL，于是辅助文件被**原样**加载，
    // 它里面的 `@sim/…` 没有 import map 可解 ⇒ KIT_IMPORT_FAILED ⇒ 那个干员整件装不上。
    // （实测记录：`_up/mod-compat/out/probe-libimports.mjs`；四个用例里两个因此失败。）
    for (const f of fs.readdirSync(LIB_DIR).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
      for (const d of kitImportDeclarations(src)) {
        assert.ok(!d.specifier.startsWith('@'),
          `kits/lib/${f} 写了 "${d.specifier}"：辅助文件够不到白名单，装满就整个干员装不上`);
        assert.ok(isPackRelativeSpecifier(d.specifier),
          `kits/lib/${f} 的 "${d.specifier}" 必须是包相对路径（辅助文件之间只能用 ./…）`);
      }
    }
  });

  test('引擎常量守卫：lib/constants.js 的默认 COLS / ROWS 必须等于引擎当前值', () => {
    // 这两个数是**副本**（辅助文件不许 import @sim/，只能由干员文件注入）。副本就会漂 ——
    // 引擎改了 canvas 尺寸而这里没跟，格键算术立刻整体错位，而**没有任何东西会报错**。
    const src = fs.readFileSync(path.join(LIB_DIR, 'constants.js'), 'utf8');
    const cols = /export let COLS = (\d+);/.exec(src);
    const rows = /export let ROWS = (\d+);/.exec(src);
    assert.ok(cols && rows, 'lib/constants.js 要导出 let COLS / let ROWS（可注入的默认值）');
    assert.equal(Number(cols[1]), COLS, `lib/constants.js 的 COLS 默认值 (${cols[1]}) 必须等于 @sim/constants.js 的 COLS (${COLS})`);
    assert.equal(Number(rows[1]), ROWS, `lib/constants.js 的 ROWS 默认值 (${rows[1]}) 必须等于 @sim/constants.js 的 ROWS (${ROWS})`);
    // 依赖这两个数的干员文件必须在模块顶层注入真值。
    // 判据只看**必须注入的那几个**：`COLS` 是底线（`lib/unit.js` 的 `inRangeOf` 与 `lib/engine.js` 的
    // `bodyInKeys` 都要它）；`ROWS` 只有 `bodyInKeys` 要。注入**超出**需要的常量不算错（无害的多给一个），
    // 少给才是错 —— 所以匹配用「至少包含」，不是精确相等。
    for (const id of EXPECTED_IDS) {
      const s = fs.readFileSync(path.join(KITS_DIR, `${id}.js`), 'utf8');
      const needsCols = /from '\.\/lib\/(unit|engine)\.js'/.test(s) || /from '@sim\/constants\.js'/.test(s);
      if (!needsCols) continue;
      const needsRows = /import \{[^}]*\bbodyInKeys\b[^}]*\} from '\.\/lib\/engine\.js'/.test(s);
      const call = /^configure\(\{ ([^}]*) \}\);$/m.exec(s);
      assert.ok(call, `${id} 依赖格键算术，必须在模块顶层 configure({ COLS${needsRows ? ', ROWS' : ''} }) 注入引擎真值`);
      const given = call[1].split(',').map((x) => x.trim()).filter(Boolean);
      assert.ok(given.includes('COLS'), `${id}: configure 必须给 COLS（实际给了 ${given.join(', ') || '空'}）`);
      if (needsRows) assert.ok(given.includes('ROWS'), `${id}: 用了 bodyInKeys，configure 必须也给 ROWS`);
    }
  });

  test('别名件（红豆）与官方同一干员的 kit 逐条等价', () => {
    // 原件写的是 `import OFFICIAL_VIGNA from './ops/chess_char_1_05-vigna.js'`，再取 `['chess_char_1_05_a']`。
    // 那条 import 在工坊包里**两端都不成立**（实测见 _up/mod-compat/out/probe-alias.mjs：包相对会解析到
    // `<包>/kits/ops/…`、`@kit/ops/…` 被白名单拒、把官方那 33 行抄进来它自己的 `../shared/tier1.js` 又断），
    // 所以别名件是**等价的重写**。这条测试钉住重写的形状：它必须用到官方 kit 用到的那套 tier1 helper，
    // 且行为键与官方那份一致。
    const src = fs.readFileSync(path.join(KITS_DIR, 'chess_char_9_01_a.js'), 'utf8');
    for (const helper of ['num', 'talentBb', 'traitBb']) {
      assert.ok(new RegExp(`\\b${helper}\\b`).test(src), `别名件要用到 tier1 的 ${helper}（官方红豆 kit 用的同一套）`);
    }
    // 官方那份的行为标识：天赋 buff key 'vigna:proc' 与触发点 beforeAttack / attack。
    assert.ok(src.includes("'vigna:proc'"), '别名件必须保留官方红豆的 vigna:proc 天赋 buff key');
    assert.ok(src.includes("battle.on('beforeAttack'"), '别名件必须保留官方红豆的 beforeAttack 触发点');
    // 且它自己不许去够 ops/（那条路是死的）。只在**真正的 import 声明**里查，因为文件头的注释正是在讲解
    // 「为什么不能写 ./ops/…」，把注释也算上就会把解释当成违规。
    for (const d of kitImportDeclarations(src)) {
      assert.ok(!d.specifier.startsWith('./ops/'),
        `别名件不许 import "./ops/…"（在包里会解析到 <包>/kits/ops/…，实测装不上）`);
    }
  });
});
