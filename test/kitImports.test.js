// test/kitImports.test.js — 工坊包 kit 的 import 权利（缺口④，DESIGN §28.12 / docs/WORKSHOP.md §4.5）。
//
// 一个 kit 是**同一份文件被两处加载**：服务端按真实路径（server/workshop.js loadWorkshopKits 的 import()）、
// 浏览器按 URL（public/js/battle/runner.js loadSpecKits 的 import('/workshop-kits/…')）。相对 specifier 对其中
// 一端成立、对另一端必然不成立 —— 这正是旧口径「一律拒绝 import」的全部理由。
//
// 新口径是**白名单 + 双端解析**：作者写 `@kit/tier1.js`，服务端在 import 前把白名单 specifier 窄重写成真实
// file: URL，浏览器靠 public/index.html 的 import map 声明式解析。两端共用 shared/kitImports.js 一张表，
// 所以编辑器判过的东西加载器不会再拒。
//
// 本文件按「两端一致」组织：① 白名单表本身（含浏览器侧解析）；② 校验器口径；③ 加载器口径 + 真加载；④ 哈希；
// ⑤ 验收 —— 社区 mod「克莱门莎」的 5 条 import 逐条映射。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  BATTLE_IMPORT_PREFIXES, KIT_IMPORT_FILES, KIT_IMPORT_PREFIXES, KIT_IMPORT_TARGETS, kitImportAllowedText, kitImportBrowserUrl,
  kitImportDeclarations, kitImportIssues, kitImportMap, rewriteKitImports,
} from '../shared/kitImports.js';
import { validateKit, kitErrors } from '../shared/kitAuthoring.js';
import { identifyPack, loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { battleSourceIssues } from '../server/battlePack.js';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ID = 'chess_ws_importprobe_a';
const OPTS = { id: ID, ownChessIds: [ID] };

/** 夹具 kit：既证明 helper 真可用（num 的返回值进断言），也覆盖社区 kit 用到的每一个白名单模块。 */
const KIT_SRC = [
  "import { num, talentBb, traitBb, skillRec, up } from '@kit/tier1.js';",
  "import { selectedId, copyGrid } from '@kit/tier3.js';",
  "import { dirVec } from '@sim/dir.js';",
  "import { absoluteRangeKeys } from '@sim/targeting.js';",
  "import { COLS, ROWS } from '@sim/constants.js';",
  '',
  'export default function kit() {',
  '  return {',
  '    probe: {',
  '      n: num("7", 0) * 10 + num(undefined, 3),          // 70 + 3 = 73',
  '      cols: COLS, rows: ROWS,',
  '      selected: selectedId, copied: copyGrid,',
  '      dir: dirVec, range: absoluteRangeKeys,',
  '      talent: talentBb, trait: traitBb, skill: skillRec, up,',
  '    },',
  '  };',
  '}',
  '',
].join('\n');

const CHESS_REC = {
  chessId: ID, baseId: ID, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR',
  position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 1, atk: 1, def: 1, res: 0, cost: 1, blockCnt: 1, bat: 1 },
  talents: [], bonds: [],
};
const OTHER = 'chess_ws_importprobe_b';

/**
 * One pack, one kit, its own workspace root — so a test that swaps the kit source cannot collide with another test's
 * pack (a kit id owned by two packs is a KIT_ID_COLLISION, which would hide the verdict under test).
 */
function makePack(source = KIT_SRC, packId = 'import-probe', extraIds = []) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-kit-imports-'));
  const wsRoot = path.join(dir, 'workshop');
  const packDir = path.join(wsRoot, packId);
  fs.mkdirSync(path.join(packDir, 'kits'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
    id: packId, name: 'Import probe', version: '0.1.0', content: ['chess'], overrides: [],
  }));
  const chess = { [ID]: CHESS_REC };
  // a second id the pack OWNS: a kit for an id with no record is refused by the ownership rule, which would hide the
  // import verdict this fixture exists to produce
  for (const id of extraIds) chess[id] = { ...CHESS_REC, chessId: id, baseId: id };
  fs.writeFileSync(path.join(packDir, 'chess.json'), JSON.stringify(chess));
  const kitFile = path.join(packDir, 'kits', `${ID}.js`);
  fs.writeFileSync(kitFile, source);
  return { dir, wsRoot, packDir, kitFile, pack: { id: packId, name: 'Import probe', version: '0.1.0' } };
}
/** Load one fixture's single kit. `known` defaults to the probe id, so a kit for an id nobody carries is still reported. */
const loadOne = (fixture, known = [ID]) =>
  loadWorkshopKits(loadWorkshop(fixture.wsRoot, { log: quiet }), { log: quiet, knownIds: new Set(known) });

let fx;
before(() => { fx = makePack(); });
after(() => { if (fx) fs.rmSync(fx.dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------
// ① 白名单表：它是两端唯一的真相，所以先钉住表本身
// ---------------------------------------------------------------------------------------------------
/** kit 与 battle 两份前缀的并集：表是共用的，解析时的前缀也要一起看。 */
const ALL_PREFIXES = Object.freeze([...new Set([...KIT_IMPORT_PREFIXES, ...BATTLE_IMPORT_PREFIXES])]);

describe('kit import 白名单：表与两端解析', () => {
  test('每个白名单 specifier 都指向一个真实存在的文件，且浏览器 URL 落在 /sim/ 挂载里', () => {
    assert.ok(KIT_IMPORT_FILES.length > 0);
    for (const { specifier, file } of KIT_IMPORT_FILES) {
      assert.ok(ALL_PREFIXES.some((p) => specifier.startsWith(p)), `${specifier} 必须带一个白名单前缀`);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${specifier} → ${file} 不存在`);
      // 浏览器侧：/sim/ → server/sim/（server/http/static.js 的挂载），只服务 .js
      const url = kitImportBrowserUrl(file);
      assert.match(url, /^\/sim\/.*\.js$/, `${specifier} 的浏览器 URL 必须落在 /sim/ 下，今天算出 "${url}"`);
      assert.ok(fs.existsSync(path.join(ROOT, 'server', url.replace(/^\/sim\//, 'sim/'))), `${url} 在磁盘上没有对应文件`);
    }
    assert.equal(new Set(KIT_IMPORT_FILES.map((e) => e.specifier)).size, KIT_IMPORT_FILES.length, 'specifier 不能重复');
    assert.equal(new Set(KIT_IMPORT_FILES.map((e) => e.file)).size, KIT_IMPORT_FILES.length, '一个文件不要开两个名字');
  });

  test('public/index.html 的 import map 与表一致（漂移就是浏览器 404）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert.ok(m, 'index.html 必须有 import map');
    const imports = JSON.parse(m[1]).imports;
    const want = kitImportMap();
    for (const [prefix, url] of Object.entries(want)) {
      assert.equal(imports[prefix], url, `import map 的 "${prefix}" 与 kitImportMap() 不一致（表改了就要改 index.html）`);
    }
    // 前缀映射必须真的把 specifier 落到表里那个文件上：把每个 specifier 按 import map 解析一遍
    for (const { specifier, file } of KIT_IMPORT_FILES) {
      const prefix = ALL_PREFIXES.find((p) => specifier.startsWith(p));
      const resolved = imports[prefix] + specifier.slice(prefix.length);
      assert.equal(resolved, kitImportBrowserUrl(file), `${specifier} 经 import map 解析后不是 ${file}`);
      assert.ok(fs.existsSync(path.join(ROOT, 'server', resolved.replace(/^\/sim\//, 'sim/'))), `${resolved} 不存在`);
    }
  });

  test('扫描器只认真正的静态 import/export-from：注释与字符串里的不算', () => {
    const src = [
      '// import { x } from "@kit/tier1.js";  ← 这是说明文字',
      'const s = "import { y } from \'@kit/tier1.js\';";',
      "import { num } from '@kit/tier1.js';",
      "export { dirVec } from '@sim/dir.js';",
      'export default () => {};',
    ].join('\n');
    assert.deepEqual(kitImportDeclarations(src).map((d) => d.specifier), ['@kit/tier1.js', '@sim/dir.js']);
    assert.deepEqual(kitImportIssues(src), []);
  });

  test('窄重写只动白名单 specifier，其余字节一个不改（引号、注释、其它 import 都留着）', () => {
    const src = "import { num } from '@kit/tier1.js';\n// 注释别动\nconst a = \"import b from 'c';\";\nexport default () => {};\n";
    const out = rewriteKitImports(src, () => 'FILE_URL');
    assert.equal(out, "import { num } from 'FILE_URL';\n// 注释别动\nconst a = \"import b from 'c';\";\nexport default () => {};\n");
    // 非白名单 specifier 不重写：留给加载器报错，而不是让 Node 抛一句模块解析失败
    const bad = "import { num } from '../shared/tier1.js';\nexport default () => {};\n";
    assert.equal(rewriteKitImports(bad, () => 'FILE_URL'), bad);
  });
});

// ---------------------------------------------------------------------------------------------------
// ①b 白名单文件的**导出名下限**守卫
//
// 白名单把 tier1..tier6 + summoner + 三个 @sim/ helper 变成了**对外接口**：作者包 import 的就是这些名字。
// 所以这里把每个白名单文件当前的**具名导出名集合**记下来，断言「这些名字仍然都被导出」——
//   · 用**超集**（⊇）而不是相等：**加**一个导出永远不会打断任何 mod（老包不 import 它），**删**或**改名**才会。
//     相等断言会把「加导出」也判红，那是把守卫变成噪声。
//   · 失败信息点名「哪个文件少了哪个导出」，让读的人一眼知道谁被打断了（而不是自己去 diff 两个集合）。
// 与 §⑤ 的 9 个名字不重复：那条是社区 kit 用到的名字，这条是**每个白名单文件的全部导出**。
// 快照取自各模块自己的命名空间（2026-10-10，commit 1c64bd7 时点），不是从源码文本里猜的。
// ---------------------------------------------------------------------------------------------------
/** 每个白名单文件的导出名下限（写死在测试里：改动它必须是**有意**的，而不是跟着源码自动变）。 */
const KIT_IMPORT_EXPORTS = {
  "server/sim/content/kits/shared/tier1.js": [
    "PROTECT", "PROTECT_TICK_HOLD", "RING1", "alliesInGridOf", "batMod", "byEnemyAttack", "cheb", "enemiesInGrid",
    "enemyInRange", "freeTileAround", "giveSp", "holdProtect", "hurtSpDamage", "installAura", "installReveal",
    "instantKind", "isMainHit", "makeZone", "moduleBb", "moduleOn", "num", "onDamagedOn", "onHitBy", "onHitOn",
    "once", "posKey", "protectMods", "skillBbOf", "skillBusy", "skillRec", "spTimeBonus", "statBuff",
    "summonTileFree", "talentBb", "talentGrid", "toggleBuff", "traitBb", "up",
  ],
  "server/sim/content/kits/shared/tier2.js": [
    "onDefaultSkill",
  ],
  "server/sim/content/kits/shared/tier3.js": [
    "NINE", "alive", "altSkills", "aura", "copyGrid", "defOf", "enemiesOn", "freeTile", "funnelMap", "fx",
    "giveSp", "gridKeys", "groundAspd", "groundTile", "installFunnelPrune", "instantKindOf", "isLeader",
    "moduleTalentBb", "num", "onTiles", "selectedId", "statSkill", "tacticalPoint", "talentBb", "textNum",
    "traitBb", "whileTrue",
  ],
  "server/sim/content/kits/shared/tier4.js": [
    "AURA", "AURA_DUR", "alt", "applyModuleRange", "batFlat", "enemiesOnRange", "enemyHasTag", "grid",
    "installLowHpHealBonus", "instantKind", "isSel", "keySet", "lonely", "moduleBb", "nationOf", "num",
    "pullToFront", "pulse", "resCut", "reveal", "skillActive", "spAura", "targetsInGrid", "targetsInRange", "tbb",
    "toggleBuff", "whileDeployed", "withDefaults",
  ],
  "server/sim/content/kits/shared/tier5.js": [
    "AURA_DUR", "AURA_IV", "HALF_HP", "NEVER", "RING1", "batPct", "burstDamageUp", "burstSpUp",
    // `crowdAspd` 不在下限里：0.2.2 的 REA-Y 那条规则改由引擎施加（`sim/content/traitMods.js`），
    // 这个 0.2 秒轮询的旧助手被上游**有意删掉**（docs/history/0.2.2.md §27.15）。删名是那条规则的本职，
    // 所以这里跟着删一个名字，不是放宽：下限仍然挡「再删别的名字」，剩下的名字一个都没动。
    "dist", "elementHit", "enemiesInGrid", "inFaction", "inRange", "instantKind", "isAbyssal", "isOp",
    "lazySkills", "leaderOf", "lowHpHealUp", "maxCharges", "mods", "moduleRangeUp", "num", "on", "permBuff",
    "selectedId", "skillGrid", "skillRange", "spAura", "talent", "talentRec", "traitBb", "whileOn",
  ],
  "server/sim/content/kits/shared/tier6.js": [
    "ABNORMAL", "ANY", "AROUND8", "N4", "WHOLE_FIELD", "aura", "batOf", "bestTile", "bstate", "bv",
    "cleanseAbnormal", "elementDmg", "enemiesIn", "freeTiles", "hasAbnormal", "hasBond", "instantKind", "isElite",
    "isTok", "keyOf", "live", "moduleBb", "num", "onDefaultSkill", "onElementHit", "opsOf", "parseN",
    "pullToward", "selectedSkill", "skillGridOf", "tbb", "tdesc",
  ],
  "server/sim/content/kits/shared/summoner.js": [
    "DECK_RETRY", "holdBuff", "summonDeck", "summonTriggerArea", "tokenStat",
  ],
  "server/sim/constants.js": [
    "ALLY_COLLIDER_RADIUS", "ASPD_MAX", "ASPD_MIN", "ATTACK_ANIM_TIME", "ATTACK_PAUSE", "AUTO_OP_COOLDOWN",
    "BLOCK_RADIUS", "BLOCK_RADIUS_SQ", "BOOMERANG_RETURN_SPEED", "BOSS_POOL_MIN_HP", "BOSS_ROW_OFFSET",
    "CHAIN_RADIUS", "COLD_ASPD", "COLD_FREEZE_DURATION", "COLS", "DEPLOY_ANIM_TIME", "DIE_ANIM_TIME",
    "DIRECT_BONUS_STACKING", "DOWN_STATE", "DP_DEFAULTS", "ELEMENT", "ELEMENTS", "ELEMENT_GAUGE_MAX",
    "ELEMENT_GAUGE_MAX_LEADER", "ELEMENT_ORDER", "EVENT_BUFFER_CAP", "FIELD_COLS", "FIELD_ROWS", "FORCED_EXIT",
    "FREEZE_RES_DOWN", "LEVITATE_HALF_WEIGHT", "MAX_ALIVE_ENEMIES", "MAX_BATTLE_TIME", "MAX_HOOK_DEPTH",
    "MAX_INTERNAL_ERRORS", "MIN_DAMAGE_RATIO", "MOVE_SCALE", "OBSTACLE_DEVICES", "PALSY_MAX", "PROJECTILE_SPEED",
    "PROJECTILE_SPEEDS", "PULL_CRAWL", "PULL_ORIGIN", "PULL_STOP_RADIUS", "PULL_WEAK_SHARE",
    "PUSH_DIRECTIONAL_MIN_DIST", "PUSH_EFFECT_SKILLS", "PUSH_TILES", "PUSH_TILES_EFFECT", "REGEN_EVENT_MIN",
    "RESIST_DEFAULT", "RESIST_PALSY_DECAY", "ROWS", "SNAPSHOT_EVERY", "STEALTH_RESTORE", "TICK",
  ],
  "server/sim/dir.js": [
    "DEFAULT_DIR", "DIRS", "DIR_VEC", "dirFromDelta", "dirVec", "frontOf", "hSign", "isDir", "localBefore",
    "localOrder", "mirrorDir", "normDir", "offsetTile", "oppositeDir", "perpendicular", "rotateOffset", "toLocal",
  ],
  "server/sim/targeting.js": [
    "absoluteRangeKeys", "aggroCmp", "areaSelectable", "auraSelectable", "canTargetAlly", "canTargetEnemy",
    "enemyStealthed", "evadesGround", "extendedGrid", "sortAllyTargets", "sortEnemyTargets", "stealthOffKey",
    "tileKeyOf",
  ],
  // 2026-10-15 新开两格。记的是当前**全部**具名导出，判据仍是超集 —— 加导出不打断任何包，删名或改名才会。
  // 两格都按「按文件指名、不开前缀」放开：`@sim/` 下别的文件（`ai.js`、`pairing.js` 等）仍然被拒。
  "server/sim/body.js": [
    "bodyDist", "bodyInKeys", "bodyInRadius", "bodyInRange", "bodyInRangeTile", "bodyKeys", "bodyOnTile",
    "bodyTileReach", "colliderKeys", "hitRect", "normHitArea",
  ],
  "server/sim/professions.js": [
    "BARD_REGEN_DUR", "BARD_REGEN_IV", "DOLL_SWITCH", "KNOWN_SUBPROFESSIONS", "PROFESSION_DEFAULTS", "SUB",
    "bardRegen", "resolveProfile",
  ],
  // 战斗逻辑模块（`server.battle`, DESIGN §28.17）的 SDK：官方内容模块用的那一份辅助函数。
  // `@sim/detmath.js`（2026-10-15 加进白名单）：确定性数学的**唯一**入口（`Math.sin` 这类在两端可能不一致，
  // `tools/check-imports.mjs` 与 `test/sim/detmath.test.js` 一起钉这件事）。它导出的是 6 个纯函数。
  "server/sim/detmath.js": ["atan2", "cos", "hypot", "powi", "roundHalfEven", "sin"],
  "server/sim/content/support/index.js": [
    "COLS", "activeBondIds", "alliesAround", "allyAt", "bandRecord", "baseChessId", "battleStore", "bodyDist",
    "bodyInKeys", "bodyInRadius", "bodyOnTile", "bodyTileReach", "bondActive", "bondLayers", "bondMembers",
    "bondRecord", "bondState", "bondTier", "buffParams", "buffsOf", "chessRecord", "contentInfo", "coreBondIds",
    "directMods", "effectRecord", "frontTile", "fxOn", "gainLayers", "gameData", "garrisonRecord", "goldenItemCount",
    "hasItemKey", "inRange", "isCoreBond", "isElite", "isGoldenId", "isGroundOp", "isMember", "isOp", "itemKeyOf",
    "itemRecord", "itemsOf", "layersUsed", "matchBands", "num", "onField", "onKeys", "passiveBuff", "player",
    "playerOps", "rowMates", "setGameData", "sideTiles", "tierOf", "tileKey", "topActiveBond", "unitBonds",
    "withGameData",
  ],
  // 复用官方 ops kit（2026-10-14 起 4 个，2026-10-15 加到 8 个）：这些文件的**对外接口是 `default` 导出里的
  // 那一个成员**（`default.char_340_shwaz` 等），具名导出只有少数几个。所以这里如实记下限 ——
  // 「包真正调用的那个 default 成员还在不在」由 §⑥ 的另一条测试钉住：只记具名导出的话
  // op-shwaz / op-thumpy / op-aphris / op-heyak 会是空集，那条守卫就等于不存在。
  "server/sim/content/kits/ops/op-shwaz.js": [],
  "server/sim/content/kits/ops/op-ray.js": ["SANDBEAST", "SPECIAL_TAG"],
  "server/sim/content/kits/ops/op-aglna2.js": ["MARKER"],
  "server/sim/content/kits/ops/op-thumpy.js": [],
  "server/sim/content/kits/ops/op-aphris.js": [],
  "server/sim/content/kits/ops/op-heyak.js": [],
  "server/sim/content/kits/ops/op-jesca2.js": ["SHIELD"],
  "server/sim/content/kits/ops/op-nasti.js": ["NSTBLD", "NSTCHR", "NSTDEF"],
};

describe('kit import 白名单：每个文件的导出名下限（⊇，不是相等）', () => {
  test('记录的导出名下限覆盖了白名单里的每一个文件（表加了文件就要加一行）', () => {
    assert.deepEqual(
      Object.keys(KIT_IMPORT_EXPORTS).sort(),
      KIT_IMPORT_FILES.map((e) => e.file).sort(),
      'KIT_IMPORT_EXPORTS 与 shared/kitImports.js KIT_IMPORT_FILES 不同步：白名单加了文件，这里必须补上它的导出名',
    );
  });

  for (const { specifier, file } of KIT_IMPORT_FILES) {
    test(`${specifier} 仍然导出它承诺的每一个名字（删名/改名 = 打断所有依赖它的包）`, async () => {
      const mod = await import(new URL(`../${file}`, import.meta.url).href);
      const missing = KIT_IMPORT_EXPORTS[file].filter((name) => !(name in mod));
      assert.deepEqual(
        missing,
        [],
        `${file}（${specifier}）少导出这些名字：${missing.join('、')} —— 白名单文件是对外接口，删名或改名会打断所有 import 它的工坊包`,
      );
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// ①c 白名单文件的**可变状态不出边界**守卫
//
// 为什么需要这一条：白名单（`shared/kitImports.js`）决定「包能 import 什么」，它是一道**安全边界**。
// 放开 `@sim/body.js` 与 `@sim/professions.js` 之前做的那次审计结论是：
//   · `body.js` —— 模块级 `let`/`var` = 0、可变容器 = 0，导出全是纯函数（文件自述
//     「Pure functions of (x, y, hitArea); no battle state」，`body.js:29`）⇒ 放开它是安全的，无需守卫。
//   · `professions.js` —— **确实有** 3 个模块级容器/对象：`DOLL_SWITCH_IMMUNE`（`new Set`）、`TUNE`、
//     `PRIORITY_ALIASES`（后两个连 `Object.freeze` 都没有）。放开它**之所以仍然安全**，靠三条实测事实：
//     ① 三者**全部不是导出**（ESM 里非导出绑定没有外部句柄，包拿不到引用）；
//     ② 三者**从未被写**（源码里只在 `:284` / `:681` / `:698` 被读）；
//     ③ 能到包的那一侧全是不可变形态（`PROFESSION_DEFAULTS` / `SUB` / `KNOWN_SUBPROFESSIONS` 都 frozen，
//        其余是数值常量）。
//
// ⚠️ 这三条是**放开白名单的安全前提**，而「前提今天成立」不能靠记性：白名单是永久开放的入口，
// 将来任何人顺手写一个 `export` 就会把可变容器递到包手里、且没有任何东西会红。
// 所以把前提钉成判据 —— 与 ①b「导出名下限」同一种做法，只是这条守的是**不该出现的东西**。
// 判据是能给红的：把 `DOLL_SWITCH_IMMUNE` 临时加进 `professions.js` 的导出表，本用例即 `not ok`。
// ---------------------------------------------------------------------------------------------------
/** 白名单里**含模块级可变状态**的文件，以及「让它保持安全」必须成立的三件事。 */
const KIT_IMPORT_MUTABLE_GUARD = {
  'server/sim/professions.js': {
    /** ① 这些名字带可变状态（`Set` / 未 freeze 的对象），**不得**被导出。 */
    notExported: ['DOLL_SWITCH_IMMUNE', 'TUNE', 'PRIORITY_ALIASES'],
    /** ② 它们在源码里的写入形态一个都不许出现。 */
    writePatterns: [
      /\bDOLL_SWITCH_IMMUNE\s*\.\s*(?:add|delete|clear|set)\b/,
      /\bTUNE\s*\[[^\]]*\]\s*=/,
      /\bPRIORITY_ALIASES\s*\[[^\]]*\]\s*=/,
    ],
    /** ③ 能到包的那一侧必须冻结。 */
    frozen: ['PROFESSION_DEFAULTS', 'SUB', 'KNOWN_SUBPROFESSIONS'],
  },
};

describe('kit import 白名单：可变状态不出边界（放开 professions.js 的安全前提）', () => {
  for (const [file, guard] of Object.entries(KIT_IMPORT_MUTABLE_GUARD)) {
    test(`${file} 的模块级可变绑定不被导出`, async () => {
      const mod = await import(new URL(`../${file}`, import.meta.url).href);
      const leaked = guard.notExported.filter((name) => name in mod);
      assert.deepEqual(
        leaked,
        [],
        `${file} 导出了带可变状态的 ${leaked.join('、')} —— 白名单一放开，包就拿到了一个**共享可写句柄**`
        + '（改一次影响所有对局）。要么不给它加 export，要么先把它改成 Object.freeze 后的只读形态。',
      );
    });

    test(`${file} 的模块级可变绑定从未被写（源码里没有写入形态）`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const hits = guard.writePatterns.flatMap((re) => src.match(re) ?? []);
      assert.deepEqual(hits, [], `${file} 出现了写入形态：${hits.join('、')} —— 模块级共享状态被就地改写会跨对局串味`);
    });

    test(`${file} 能到包的那一侧全是不可变形态（frozen 或数值常量）`, async () => {
      const mod = await import(new URL(`../${file}`, import.meta.url).href);
      const mutable = guard.frozen.filter((name) => !Object.isFrozen(mod[name]));
      assert.deepEqual(
        mutable,
        [],
        `${file} 的 ${mutable.join('、')} 不是 frozen —— 包拿到它就能就地改写引擎的默认值表`,
      );
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// ② 校验器口径（编辑器/CLI 走这一条）
// ---------------------------------------------------------------------------------------------------
describe('kit import：校验器口径', () => {
  const kit = (head) => `${head}\nexport default () => ({ ok: true });\n`;

  test('白名单内的 import 零错误', () => {
    for (const { specifier } of KIT_IMPORT_FILES) {
      assert.deepEqual(kitErrors(validateKit(kit(`import * as m from '${specifier}';`), OPTS)), [], specifier);
    }
  });

  test('白名单外的一切都还是 KIT_IMPORT，且 reason 说清允许什么', () => {
    for (const spec of ['../shared/tier1.js', '/abs.js', '@kit/../../x.js', '@kit/evil.js', 'lodash', '@nope/x.js']) {
      const issues = validateKit(kit(`import { x } from '${spec}';`), OPTS);
      const hit = kitErrors(issues).find((e) => e.code === 'KIT_IMPORT');
      assert.ok(hit, `${spec} 必须被拒`);
      assert.match(hit.message, /白名单/, `${spec} 的 reason 必须点名白名单`);
      assert.match(hit.hint, /@kit\/tier1\.js/, `${spec} 的 hint 必须给出可用的写法`);
    }
  });

  // §28.18 把「相对路径一律不行」改成「**向下**相对（`./…`）可以，用来 import 自己包 kits/ 下的兄弟文件」：
  // 白名单之外仍然全是 KIT_IMPORT，但 `./…` 这一族里哪些成立、哪些不成立有了明确分界。
  test('§28.18：./… 放行，其余相对与畸形形式仍被拒，且每条理由都给得出可用的写法', () => {
    for (const spec of ['./helpers.js', './lib/bonds.js']) {
      assert.deepEqual(kitErrors(validateKit(kit(`import { x } from '${spec}';`), OPTS)), [], `${spec} 必须放行`);
    }
    for (const spec of ['../x.js', './../x.js', '/abs/x.js', 'x.js', './x.mjs', './x', './', './%2e%2e/x.js', './x.js?1', './sub\\x.js', './x//y.js']) {
      const hit = kitErrors(validateKit(kit(`import { x } from '${spec}';`), OPTS)).find((e) => e.code === 'KIT_IMPORT');
      assert.ok(hit, `${spec} 必须被拒`);
      assert.ok(hit.hint.includes(kitImportAllowedText()), `${spec} 的 hint 必须给出白名单写法`);
      // 每个拒绝理由都要顺带告诉作者「自己包里的 ./… 也能写」—— 否则唯一的出路是把代码塞回一个文件
      assert.match(hit.message, /\.\/…/, `${spec} 的 reason 必须提到包相对写法`);
    }
  });

  test('§28.18：战斗逻辑模块（server.battle）刻意不接受 ./…（data: 没有目录），理由指向 @battle/', () => {
    const issue = battleSourceIssues("import h from './lib/util.mjs';\nexport function install() { return h; }\n", 'p')[0];
    assert.ok(issue, '战斗模块里 ./… 必须被拒');
    assert.equal(issue.code, 'BATTLE_BAD_IMPORT');
    assert.match(issue.reason, /data:/);
    assert.match(issue.reason, /@battle\//);
  });

  test('require 与动态 import() 都被拒，理由各自说得通', () => {
    const req = kitErrors(validateKit(kit("const a = require('@kit/tier1.js');"), OPTS));
    assert.ok(req.some((e) => e.code === 'KIT_IMPORT' && /require/.test(e.message)), JSON.stringify(req));
    const dyn = kitErrors(validateKit(kit("const p = import('@kit/tier1.js');"), OPTS));
    assert.ok(dyn.some((e) => e.code === 'KIT_IMPORT' && /动态/.test(e.message)), JSON.stringify(dyn));
  });

  test('确定性规则没有被顺手放松：Math.random 仍然是 KIT_NONDETERMINISTIC', () => {
    const issues = validateKit(kit("import { num } from '@kit/tier1.js';\nconst r = Math.random();"), OPTS);
    assert.deepEqual(kitErrors(issues), [], '白名单 import 不该再产生错误');
    assert.ok(issues.some((i) => i.code === 'KIT_NONDETERMINISTIC' && i.message.includes('Math.random')));
  });
});

// ---------------------------------------------------------------------------------------------------
// ③ 加载器口径 + 真加载：白名单内的 kit 必须真的能被服务端 import 成功，helper 必须可用
// ---------------------------------------------------------------------------------------------------
describe('kit import：加载器与校验器同一口径，且真加载', () => {
  test('白名单内的 kit 被真的 import 成功，helper 可用（num 的返回值算进断言）', async () => {
    const info = await loadOne(fx);
    assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
    const fn = info.kits[ID];
    assert.equal(typeof fn, 'function', '带白名单 import 的 kit 必须真的被加载');
    const probe = fn().probe;
    assert.equal(probe.n, 73, 'num("7",0)*10 + num(undefined,3) 必须是 73 —— helper 真的执行了');
    assert.ok(probe.cols > 0 && probe.rows > 0, 'COLS/ROWS 必须来自 @sim/constants.js');
    for (const [name, v] of Object.entries(probe)) {
      if (name === 'n' || name === 'cols' || name === 'rows') continue;
      assert.equal(typeof v, 'function', `@kit/@sim 的 ${name} 必须解析出一个函数`);
    }
    assert.equal(info.modules.length, 1);
    assert.match(info.modules[0].url, new RegExp(`^/workshop-kits/import-probe/${ID}\\.js\\?v=\\d+$`));
  });

  test('白名单外的 import 被加载器拒掉，且与校验器给同一个 code 与同一句 reason', async () => {
    const bad = "import { num } from '../shared/tier1.js';\nexport default () => ({});\n";
    const badFx = makePack(bad);
    try {
      const info = await loadOne(badFx);
      const hit = info.errors.find((e) => e.id === ID);
      assert.ok(hit, JSON.stringify(info.errors));
      assert.equal(hit.code, 'KIT_IMPORT');
      assert.equal(info.kits[ID], undefined, '被拒的 kit 不能进注入表');
      // 双端一致：加载器那句 reason 就是校验器那句（同一个 kitImportIssues）
      const fromValidator = kitErrors(validateKit(bad, OPTS)).find((e) => e.code === 'KIT_IMPORT');
      assert.equal(hit.reason, fromValidator.message, '加载器与校验器必须算出同一句话');
    } finally {
      fs.rmSync(badFx.dir, { recursive: true, force: true });
    }
  });

  test('一个坏 import 不会连累同一包里其它 kit 的加载路径（只跳过它自己）', async () => {
    const mixed = makePack("import { x } from '@kit/evil.js';\nexport default () => ({});\n", 'import-probe', [OTHER]);
    fs.writeFileSync(path.join(path.dirname(mixed.kitFile), `${OTHER}.js`), "export default () => ({});\n");
    try {
      const info = await loadOne(mixed, [ID, OTHER]);
      assert.equal(info.kits[ID], undefined);
      assert.equal(typeof info.kits[OTHER], 'function', '同包其它 kit 照常加载');
      assert.ok(info.errors.some((e) => e.id === ID && e.code === 'KIT_IMPORT'));
    } finally {
      fs.rmSync(mixed.dir, { recursive: true, force: true });
    }
  });

  // 浏览器侧能测到什么程度：服务端发的**是作者写的源码**（含 @kit/ 前缀，没被重写），而那个前缀指向的模块确实
  // 在 /sim/ 上可取。import map 的解析本身由浏览器做（Node 没有 import map），所以这一条只证明「取得到 + 发的是
  // 原文」，真机端到端仍未验（报告 §⑨）。
  test('浏览器拿到的 kit 是作者写的原文，且 @kit/ 指向的模块在 /sim/ 上可取', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: fx.wsRoot });
    try {
      const kitRes = await fetch(`${srv.url}/workshop-kits/import-probe/${ID}.js`);
      assert.equal(kitRes.status, 200);
      const served = await kitRes.text();
      assert.match(served, /from '@kit\/tier1\.js'/, '发给浏览器的是作者原文（重写只在服务端内存里）');
      for (const { specifier, file } of KIT_IMPORT_FILES) {
        const url = kitImportBrowserUrl(file);
        const res = await fetch(srv.url + url);
        assert.equal(res.status, 200, `${specifier} → ${url} 必须可取`);
        assert.match(res.headers.get('content-type') || '', /javascript/, `${url} 必须按 JS 发出`);
        assert.equal(await res.text(), fs.readFileSync(path.join(ROOT, file), 'utf8'), `${url} 必须就是那个文件`);
      }
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// ④ 哈希：包摘要按**作者写的源码**算，重写不参与
// ---------------------------------------------------------------------------------------------------
describe('kit import：重写不进入包哈希', () => {
  /** 这一组会改磁盘字节，所以用自己的夹具（共享夹具被改了会串到别的用例上）。 */
  let hx;
  before(() => { hx = makePack(); });
  after(() => { if (hx) fs.rmSync(hx.dir, { recursive: true, force: true }); });
  const files = () => ({ chess: { [ID]: CHESS_REC } });

  test('kits/*.js 进哈希的是磁盘字节，不是重写后的文本', () => {
    const before = identifyPack(hx.packDir, hx.pack, files());
    const entry = before.manifest.find((m) => m.path === `kits/${ID}.js`);
    assert.ok(entry, 'kits/*.js 必须在 manifest 里（§28.2：能改一场战斗的那份文件必须在哈希里）');
    assert.equal(entry.hash.length, 64);
    // 重写后的文本与原文不同，但它绝不能是进入哈希的那一份
    const raw = fs.readFileSync(hx.kitFile, 'utf8');
    const rewritten = rewriteKitImports(raw, (rel) => `file:///${rel}`);
    assert.notEqual(rewritten, raw, '夹具 kit 必须真的被重写，否则这条测试没意义');
    assert.deepEqual(identifyPack(hx.packDir, hx.pack, files()), before, '重复算哈希必须逐字段相同');
  });

  test('加载一次（真的走了重写路径）之后，包哈希与摘要一个字都没变', async () => {
    // the hash the SERVER itself computed while discovering the pack — the one that rides along in the battle spec
    const discovered = loadWorkshop(hx.wsRoot, { log: quiet }).packs[0].hash;
    const before = identifyPack(hx.packDir, hx.pack, files());
    const info = await loadOne(hx);
    assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
    const after = identifyPack(hx.packDir, hx.pack, files());
    assert.deepEqual(after, before, '重写只发生在内存里，磁盘与哈希都不该动');
    assert.equal(info.modules[0].hash, discovered, 'spec 里带出去的 hash 就是发现这个包时算的那一份');
  });

  test('哈希只随源码字节变：改一个字节就变，同一份字节重复算不变', () => {
    const original = fs.readFileSync(hx.kitFile, 'utf8');
    const same = identifyPack(hx.packDir, hx.pack, files());
    assert.deepEqual(identifyPack(hx.packDir, hx.pack, files()), same);
    try {
      fs.writeFileSync(hx.kitFile, `${original}\n// one more comment line\n`);
      assert.notEqual(identifyPack(hx.packDir, hx.pack, files()).hash, same.hash, '源码变了哈希必须变（这就是它在哈希里的意义）');
    } finally {
      fs.writeFileSync(hx.kitFile, original);
    }
    assert.deepEqual(identifyPack(hx.packDir, hx.pack, files()), same, '还原后必须回到原哈希');
  });
});

// ---------------------------------------------------------------------------------------------------
// ⑤ 验收：社区 mod「克莱门莎」的 5 条 import → 新写法
// ---------------------------------------------------------------------------------------------------
describe('kit import：验收 —— 社区 kit 的 5 条 import 等价改写', () => {
  /** 逐条映射（作者原文 → 白名单写法）。夹具 kit 的第一段就是这五行。 */
  const MAPPING = [
    ["import { num, talentBb, traitBb, skillRec, up } from '../shared/tier1.js';",
      "import { num, talentBb, traitBb, skillRec, up } from '@kit/tier1.js';"],
    ["import { selectedId, copyGrid } from '../shared/tier3.js';",
      "import { selectedId, copyGrid } from '@kit/tier3.js';"],
    ["import { dirVec } from '../../../dir.js';",
      "import { dirVec } from '@sim/dir.js';"],
    ["import { absoluteRangeKeys } from '../../../targeting.js';",
      "import { absoluteRangeKeys } from '@sim/targeting.js';"],
    ["import { COLS, ROWS } from '../../../constants.js';",
      "import { COLS, ROWS } from '@sim/constants.js';"],
  ];

  test('5 条映射逐条成立：原文被拒、新写法零错误、且指向同一个文件', () => {
    assert.equal(MAPPING.length, 5);
    for (const [oldLine, newLine] of MAPPING) {
      const before = validateKit(`${oldLine}\nexport default () => ({});\n`, OPTS);
      assert.ok(kitErrors(before).some((e) => e.code === 'KIT_IMPORT'), `原文今天仍须被拒：${oldLine}`);
      const after = validateKit(`${newLine}\nexport default () => ({});\n`, OPTS);
      assert.deepEqual(kitErrors(after), [], `新写法必须零错误：${newLine}`);
      const spec = newLine.slice(newLine.indexOf("'") + 1, newLine.lastIndexOf("'"));
      assert.ok(KIT_IMPORT_TARGETS.has(spec), `${spec} 必须在白名单表里`);
      assert.match(KIT_IMPORT_TARGETS.get(spec), /^server\/sim\/.*\.js$/, `${spec} 必须解析到 server/sim 下的真实文件`);
    }
  });

  test('夹具 kit 用的就是这 5 条新写法，且它加载出来的具名导出全部是真函数', async () => {
    const src = fs.readFileSync(fx.kitFile, 'utf8');
    for (const [, newLine] of MAPPING) assert.ok(src.includes(newLine), `夹具 kit 必须含这一行：${newLine}`);
    const info = await loadOne(fx);
    assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
    const probe = info.kits[ID]().probe;
    // 社区 kit 真的用到的名字（tier1 五个 + tier3 两个 + dir/targeting/constants 各一个）全部解析成函数
    for (const name of ['selected', 'copied', 'dir', 'range', 'talent', 'trait', 'skill', 'up']) {
      assert.equal(typeof probe[name], 'function', `${name} 必须解析成函数`);
    }
  });

  test('白名单文本就是拒绝理由里引用的那一串（不允许两处各写一份）', () => {
    const msg = kitImportIssues("import { x } from '@kit/evil.js';\n")[0].reason;
    assert.ok(msg.includes(kitImportAllowedText()), 'reason 必须内嵌白名单文本');
    assert.match(msg, /evil\.js/);
  });
});

// ---------------------------------------------------------------------------------------------------
// ⑥ 复用官方 ops kit：**按文件**开表（不是把 `@ops/` 前缀整个放开）
//
// 背景（2026-10-14，工坊包 `rimbilliton` 雷姆必拓）：包里有 4 个 kit 想复用引擎自带的官方 ops kit
// （同一名官方干员的实现，换一张 mod 棋子卡）。此前唯一的出路是把引擎子系统复制进包 ——
// 实测那条路要内联 18 个文件 / 513 KB，其中包含 `content/tokens.js`（召唤物注册表）、`ai.js`（索敌）、
// `simdata.js`、`professions.js`、`shared/i18n.js`（浏览器 i18n 运行时）：那是**包内一份冻结副本**，
// 引擎日后更新这些模块时它会静默漂移。业主裁定改为**在表里按文件指名这 4 个 file**。
//
// 本节就是那次裁定的**有牙齿的判据**（改前必红、加完必绿），并且把「按文件」与「开前缀」的分界线钉住：
//   · `KIT_IMPORT_PREFIXES` 里会出现 `@ops/`（浏览器 import map 需要它、错误文案也需要它），
//   · 但**准入判据始终是 `KIT_IMPORT_FILES`**（`kitImportIssues` 走 `targets.has(specifier)`）——
//     所以 `@ops/op-siege.js` 这类**同前缀、未列名**的文件今天仍然被拒，第 2 条测试盯着这件事。
// ---------------------------------------------------------------------------------------------------
describe('kit import 白名单：按文件开放官方 ops kit（复用官方干员的唯一通道）', () => {
  /** specifier → 引擎里的真实文件。这就是"按文件"的全部内容：8 条，一条不多。 */
  const OPS_REUSE = [
    ['@ops/op-shwaz.js', 'server/sim/content/kits/ops/op-shwaz.js'],
    ['@ops/op-ray.js', 'server/sim/content/kits/ops/op-ray.js'],
    ['@ops/op-aglna2.js', 'server/sim/content/kits/ops/op-aglna2.js'],
    ['@ops/op-thumpy.js', 'server/sim/content/kits/ops/op-thumpy.js'],
    // 2026-10-15：`rimbilliton` 投稿还要这 4 个（它自己那 8 个 kit 里有 4 个是「同一名官方干员换一张 mod 棋子卡」）
    ['@ops/op-aphris.js', 'server/sim/content/kits/ops/op-aphris.js'],
    ['@ops/op-heyak.js', 'server/sim/content/kits/ops/op-heyak.js'],
    ['@ops/op-jesca2.js', 'server/sim/content/kits/ops/op-jesca2.js'],
    ['@ops/op-nasti.js', 'server/sim/content/kits/ops/op-nasti.js'],
  ];

  test('这 8 个官方 ops kit 逐条在表里、指向真实文件、浏览器 URL 落在 /sim/ 上', () => {
    for (const [spec, file] of OPS_REUSE) {
      assert.equal(KIT_IMPORT_TARGETS.get(spec), file, `${spec} 必须在 KIT_IMPORT_FILES 里指向 ${file}`);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} 不存在`);
      assert.equal(kitImportBrowserUrl(file), `/sim/content/kits/ops/${spec.slice('@ops/'.length)}`);
    }
  });

  test('白名单加后总条数就是 22：这个数是契约，加一行必须是有意为之（连这条一起改）', () => {
    // 为什么断言一个**硬数字**：白名单是「两端唯一的真相」，也是这个格式**唯一**的准入面。一个没有条数的表
    // 会在下一次「顺手加一行」时静默变宽 —— 而白名单每宽一格，第三方包能碰到的引擎面就多一格。
    // 所以加行这件事必须是**改了这条断言**的有意行为（本节 §⑥ 与 `docs/WORKSHOP.md` 的白名单表同步改）。
    // 22 = 7（`@kit/`：tier1..tier6 + summoner）+ 6（`@sim/`：constants / dir / targeting / detmath
    //      / body / professions）+ 1（`@battle/`：support/index）+ 8（`@ops/`）。
    // ⚠️ `@sim/` 从 4 涨到 6 是 2026-10-15 有意为之（`body.js` + `professions.js`，理由见
    // `shared/kitImports.js` 里「包已经在整份复制它们了」那两段）：这个数**不是**「取一边」，两边加起来才是它。
    assert.equal(KIT_IMPORT_FILES.length, 22, `白名单条数变了（现在 ${KIT_IMPORT_FILES.length}）—— 加/删一行都要连这条与文档一起改`);
    const byPrefix = (p) => KIT_IMPORT_FILES.filter((e) => e.specifier.startsWith(p)).length;
    assert.deepEqual(
      { '@kit/': byPrefix('@kit/'), '@sim/': byPrefix('@sim/'), '@battle/': byPrefix('@battle/'), '@ops/': byPrefix('@ops/') },
      { '@kit/': 7, '@sim/': 6, '@battle/': 1, '@ops/': 8 },
      '按前缀的分布也是契约的一部分（`@ops/` 只是命名空间，不是整体放行）',
    );
  });

  test('没有把 @ops/ 整个前缀放开：这 8 个之外，@ops/ 下任何文件仍被拒', () => {
    const others = ['@ops/op-siege.js', '@ops/op-chen.js', '@ops/op-shining.js', '@ops/index.js', '@ops/op-shwaz.mjs'];
    for (const spec of others) {
      assert.equal(KIT_IMPORT_TARGETS.has(spec), false, `${spec} 不该在表里`);
      const issues = kitErrors(validateKit(`import * as m from '${spec}';\nexport default () => ({});\n`, OPTS));
      const hit = issues.find((e) => e.code === 'KIT_IMPORT');
      assert.ok(hit, `${spec} 必须仍被拒`);
      // 理由必须说"前缀合法、这个文件没开"，而不是"未知前缀"——后者会让作者以为整个命名空间都不存在
      assert.match(hit.message, /前缀合法/, `${spec} 的 reason 必须说"前缀合法、模块没开"，今天说的是：${hit.message}`);
      assert.ok(hit.hint.includes('@ops/op-shwaz.js'), `${spec} 的 hint 必须给出真正可用的写法`);
    }
  });

  test('两端一致：这 8 条经 kitImportMap() 解析后落到同一个文件', () => {
    const map = kitImportMap();
    assert.equal(map['@ops/'], '/sim/content/kits/ops/', 'import map 必须为 @ops/ 声明前缀（index.html 与它同源）');
    for (const [spec, file] of OPS_REUSE) {
      assert.equal(map['@ops/'] + spec.slice('@ops/'.length), kitImportBrowserUrl(file), spec);
    }
  });

  test('包真正调用的那个 default 成员仍在（改导出形状 = 静默打断所有复用它的包）', async () => {
    // 这些 ops kit 的具名导出很少（四个甚至是空的），**对外接口全在 `default` 上**：
    // 包写的是 `opShwaz.char_340_shwaz(bb, chess)`。所以下限必须记在 default 的成员上，
    // 否则 §①b 那条具名导出守卫对这些文件等于空转。
    const USED = [
      ['server/sim/content/kits/ops/op-shwaz.js', 'char_340_shwaz'],
      ['server/sim/content/kits/ops/op-ray.js', 'char_4117_ray'],
      ['server/sim/content/kits/ops/op-aglna2.js', 'char_1015_aglna2'],
      ['server/sim/content/kits/ops/op-thumpy.js', 'char_4235_thumpy'],
      ['server/sim/content/kits/ops/op-aphris.js', 'char_4229_aphris'],
      ['server/sim/content/kits/ops/op-heyak.js', 'char_4027_heyak'],
      ['server/sim/content/kits/ops/op-jesca2.js', 'char_1034_jesca2'],
      ['server/sim/content/kits/ops/op-nasti.js', 'char_4212_nasti'],
    ];
    for (const [file, member] of USED) {
      const mod = await import(new URL(`../${file}`, import.meta.url).href);
      assert.equal(typeof mod.default?.[member], 'function',
        `${file} 的 default.${member} 必须仍是函数 —— 复用它的包调用的就是这个成员`);
    }
  });

  test('加载器口径与校验器同源：@ops/ 这 8 条零错误，同前缀未列名的仍被拒', async () => {
    const good = makePack("import opShwaz from '@ops/op-shwaz.js';\nexport default () => ({});\n");
    const bad = makePack("import opSiege from '@ops/op-siege.js';\nexport default () => ({});\n");
    try {
      assert.deepEqual((await loadOne(good)).errors, [], '包 kit import @ops/op-shwaz.js 必须零错误');
      const badInfo = await loadOne(bad);
      assert.ok(badInfo.errors.some((e) => e.code === 'KIT_IMPORT'), JSON.stringify(badInfo.errors));
    } finally {
      fs.rmSync(good.dir, { recursive: true, force: true });
      fs.rmSync(bad.dir, { recursive: true, force: true });
    }
  });
});
