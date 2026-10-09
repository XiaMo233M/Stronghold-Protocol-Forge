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
  // 战斗逻辑模块（`server.battle`, DESIGN §28.17）的 SDK：官方内容模块用的那一份辅助函数。
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
