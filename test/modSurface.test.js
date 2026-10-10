// 第三方 mod 依赖的接口面（冻结清单）。README/设计稿里的规矩：这些位置**改名、挪文件、换形状**等于打断社区
// mod —— 而且多数是**静默**打断（数据照装、界面照开，只是没有声音 / 没有数值 / 没有天赋）。
//
// 为什么要一份专门的守卫：社区 mod 是「就地补丁」，它不经过我们的校验器，也不在我们的测试里。它引用的是
// 通用名（`data/backups.json` 的 `units[charId]`、`kits/shared/tier1.js` 的具名导出、`battle.refreshRange`），
// 一次内部整理就能把它们挪走而**没有任何测试会红**。这份文件就是那条红线：它断言的是「存在且形状不变」，
// 不是「今天的取值」——所以数据长大、干员变多都不会让它红，只有真正的接口断裂才会。
//
// 现场依据：`_up/clementia-mod-recon.md`（社区 mod「克莱门莎」逐条盘出的 14 条接口面，
// 它在本仓 `port/0.2.2-mechanical` 树上**真装成功**、8 项自检全绿）。
//
// Run: node --test test/modSurface.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { makeBattle, enemyRec } from './helpers/battleHarness.js';
import { OPERATOR_KIT_FILES, OPERATOR_KITS, KITTED_CHARS } from '../server/sim/content/kits/index.js';
import * as tier1 from '../server/sim/content/kits/shared/tier1.js';
import * as tier3 from '../server/sim/content/kits/shared/tier3.js';
import * as simDir from '../server/sim/dir.js';
import * as targeting from '../server/sim/targeting.js';
import * as constants from '../server/sim/constants.js';
import { validateKit, kitErrors } from '../shared/kitAuthoring.js';
import * as workshopSchema from '../shared/workshop.js';
import * as kitImports from '../shared/kitImports.js';
import * as extensions from '../public/js/ui/extensions.js';
import {
  MOD_SURFACE, MOD_SURFACE_IDS, MOD_SURFACE_FROZEN, surfaceLedgerIssues,
} from '../shared/modSurface.js';
import { MOD_API_VERSION } from '../shared/constants.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}.json`, import.meta.url), 'utf8'));
const BACKUPS = load('backups');
const ASSETS = load('assets');

/** 点名一个成员被谁依赖：守卫红的时候，读的人要立刻知道「这是给谁留的」。 */
const WHO = '社区 mod（就地补丁 / 工坊包）依赖这一项';

// ---------------------------------------------------------------------------------------------------
// 一、data/backups.json：干员记录的形状（社区 mod 直接往里加键）
// ---------------------------------------------------------------------------------------------------
test('backups.units 的一条干员记录：社区 mod 抄的那个字段集仍然齐全', () => {
  const ids = Object.keys(BACKUPS.units);
  assert.ok(ids.length > 0, 'units 不能是空的');
  const rec = BACKUPS.units[ids[0]];
  // 克莱门莎 mod 的 data/unit.json 顶层就是这 14 个键，一个不多一个不少（_up/clementia-mod-recon.md §二 #1）
  const REQUIRED = ['charId', 'name', 'appellation', 'rarity', 'profession', 'subProfessionId',
    'subProfessionName', 'position', 'nationId', 'isNotObtainable', 'assets', 'moduleNames', 'standsIn', 'forms'];
  for (const k of REQUIRED) {
    assert.ok(k in rec, `${WHO}：units[${ids[0]}] 少了字段 "${k}"（记录形状变了，就地补丁的干员记录会装不上）`);
  }
  assert.equal(rec.charId, ids[0], '记录自己的 charId 必须等于键（社区 mod 靠这个键找记录）');
});

test('backups.units 的 forms：档位键与档内字段仍然是社区 mod 抄的形状', () => {
  const rec = BACKUPS.units[Object.keys(BACKUPS.units)[0]];
  const ranks = Object.keys(rec.forms);
  assert.ok(ranks.length > 0, 'forms 不能是空的');
  for (const r of ranks) assert.match(r, /^\d+\/\d+\/\d+\/\d+$/, `档位键必须是 "精英/等级/技能等级/模组" 形状，今天见到 "${r}"`);
  const form = rec.forms[ranks[0]];
  for (const k of ['status', 'stats', 'rangeId', 'rangeGrid', 'trait', 'skills', 'talents']) {
    assert.ok(k in form, `${WHO}：forms[${ranks[0]}] 少了字段 "${k}"（克莱门莎的 S2 自检读的正是 forms['2/60/7/1'].skills[i].rangeGrid）`);
  }
  assert.ok(Array.isArray(form.skills) && form.skills.length > 0, 'forms[*].skills 必须是数组');
});

test('backups.diy：自选池与盟约表的位置与字段集', () => {
  const diy = BACKUPS.diy;
  for (const k of ['ownedPool', 'operators', 'prototypes', 'slots']) {
    assert.ok(k in diy, `${WHO}：backups.diy 少了 "${k}"（社区 mod 往 ownedPool 里加 id、往 operators 里加盟约）`);
  }
  assert.ok(Array.isArray(diy.ownedPool) && diy.ownedPool.length > 0, 'diy.ownedPool 必须是非空数组');
  const id = diy.ownedPool[0];
  const op = diy.operators[id];
  assert.ok(op, `diy.operators 必须有一条对应 ownedPool 里的 ${id}`);
  // 克莱门莎 mod 的 data/diy-operator.json 与官方条目逐字同形（_up/clementia-mod-recon.md §二 #4）
  for (const k of ['name', 'rarity', 'profession', 'subProfessionId', 'obtainable', 'powers', 'bonds']) {
    assert.ok(k in op, `${WHO}：diy.operators[${id}] 少了字段 "${k}"`);
  }
  assert.ok(Array.isArray(op.bonds), 'diy.operators[*].bonds 必须是数组（盟约就是从这里读的）');
});

// ---------------------------------------------------------------------------------------------------
// 二、data/assets.json：外观、图标、语音（社区 mod 的 84 个素材都落在这几张表上）
// ---------------------------------------------------------------------------------------------------
test('assets.chars：头像 / 立绘 / spine 的字段集', () => {
  const id = Object.keys(ASSETS.chars)[0];
  const c = ASSETS.chars[id];
  for (const k of ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'spine']) {
    assert.ok(k in c, `${WHO}：assets.chars[id] 少了 "${k}"（pack.json.art.chars 与就地补丁都按这五个字段写）`);
  }
  for (const side of ['front', 'back']) {
    const s = c.spine[side];
    if (!s) continue;
    for (const k of ['skel', 'atlas']) {
      assert.ok(k in s, `${WHO}：chars[*].spine.${side} 少了 "${k}"（缺 skel/atlas 模型就加载不出来）`);
    }
  }
  assert.ok(c.spine.front || c.spine.back, 'chars[*].spine 至少要有 front 或 back');
});

test('assets.prof.sub 与 assets.skills：图标表的容器还在（分支图标 / 技能图标）', () => {
  assert.ok(ASSETS.prof && typeof ASSETS.prof.sub === 'object' && !Array.isArray(ASSETS.prof.sub),
    `${WHO}：assets.prof.sub 必须是 { <subProfessionId>: <路径> }（一个没有分支图标的职业会显示不出来）`);
  assert.ok(Object.keys(ASSETS.prof.sub).length > 0, 'prof.sub 不能是空的');
  for (const [k, v] of Object.entries(ASSETS.prof.sub)) {
    assert.equal(typeof v, 'string', `assets.prof.sub["${k}"] 必须是路径字符串`);
    assert.equal(k, k.toLowerCase(), `assets.prof.sub 的键是小写的 subProfessionId，今天见到 "${k}"`);
  }
  assert.ok(ASSETS.skills && typeof ASSETS.skills === 'object', 'assets.skills 必须是 { <图标 id>: <路径> }');
  const [sk, sv] = Object.entries(ASSETS.skills)[0];
  assert.equal(typeof sv, 'string', `assets.skills["${sk}"] 必须是路径字符串`);
});

test('assets.audio：默认档 / 其它语种表都在，日配档两种写法都认（社区 mod 的双语语音要落到其中一张）', () => {
  const a = ASSETS.audio;
  assert.ok(a && typeof a.voice === 'object', 'assets.audio.voice 必须在（默认档，本仓默认 jp）');
  const id = Object.keys(a.voice)[0];
  assert.equal(typeof id, 'string', 'audio.voice 的键是干员 id');
  assert.ok(a.voice[id] && typeof a.voice[id] === 'object', 'audio.voice[charId] 是 { <槽位>: <路径或路径数组> }');
  assert.equal(typeof a.voiceLang, 'string', 'assets.audio.voiceLang 是默认语种的声明（本仓默认 jp）');
  assert.ok(a.voiceLangs && typeof a.voiceLangs === 'object' && !Array.isArray(a.voiceLangs),
    `${WHO}：assets.audio.voiceLangs 是「其它语种」表：{ <lang>: { <charId>: { <槽位>: <路径> } } }`);
  const lang = Object.keys(a.voiceLangs)[0];
  assert.ok(lang, 'voiceLangs 至少有一个语种');
  const line = a.voiceLangs[lang]?.[id]?.start ?? Object.values(a.voiceLangs[lang]?.[id] ?? {})[0];
  assert.ok(typeof line === 'string' || Array.isArray(line), `voiceLangs["${lang}"]["${id}"][槽位] 是路径或路径数组`);
  // upstream 0.2.2 的输入叫 voiceJp（0.9.x 的数据里没有它，移植后才出现）：在就必须是同一种形状
  if ('voiceJp' in a) {
    assert.ok(a.voiceJp && typeof a.voiceJp === 'object' && !Array.isArray(a.voiceJp),
      `${WHO}：assets.audio.voiceJp 存在时必须是 { <charId>: { <槽位>: <路径> } }`);
  }
});

// ---------------------------------------------------------------------------------------------------
// 三、kit 注册表与引擎 helper：社区 kit 的 import 目标（静态具名导入，改名就当场炸）
// ---------------------------------------------------------------------------------------------------
test('kits/index.js 的 OPERATOR_KIT_FILES：就地补丁靠「插一行」注册，这个结构必须留着', () => {
  assert.ok(Array.isArray(OPERATOR_KIT_FILES) && OPERATOR_KIT_FILES.length > 0, 'OPERATOR_KIT_FILES 必须是非空数组');
  for (const f of OPERATOR_KIT_FILES) {
    assert.match(f, /^[A-Za-z0-9_-]+\.js$/, `注册项是文件名，今天见到 "${f}"`);
    assert.ok(existsSync(new URL(`../server/sim/content/kits/ops/${f}`, import.meta.url)),
      `OPERATOR_KIT_FILES 列了 "${f}"，但 kits/ops/ 下没有这个文件`);
  }
  // 就地补丁是从源码文本里定位注册表、再往它的 `]);` 前插一行。**名字第一次出现在哪一行**因此是接口的一部分：
  // 2026-10-09 实测（社区「克莱门莎」mod）：名字先在第 18 行注释里出现一次，补丁于是把行插进了更靠前的
  // stand-in 数组，两个字符串字面量之间没有逗号 ⇒ `node server/index.js` 直接 exit 1，而补丁自己的自检只查
  // 「名字在不在文件里」，全绿。规矩：**靠文本定位的名字，第一次出现必须在它的声明行**。
  const src = readFileSync(new URL('../server/sim/content/kits/index.js', import.meta.url), 'utf8');
  const first = src.indexOf('OPERATOR_KIT_FILES');
  assert.notEqual(first, -1, '注册表的名字必须留在源码里（就地补丁按它做文本定位）');
  const toEol = src.slice(src.lastIndexOf('\n', first) + 1, src.indexOf('\n', first));
  assert.match(toEol, /export const OPERATOR_KIT_FILES\s*=/,
    `第一次出现必须是声明行，否则就地补丁会定位到注释、把注册行插进别的数组：今天是「${toEol.trim()}」`);
  const close = src.indexOf(']);', first);
  assert.ok(close > first, '声明的结尾必须是 `]);`（就地补丁按它找插入点）');
  assert.ok(!src.slice(first, close).includes('export const'),
    '声明之后第一个 `]);` 必须是这个数组自己的结尾，中间不能夹着另一个导出（否则插入点属于别的数组）');
  assert.ok(Object.keys(OPERATOR_KITS).length > 0, 'OPERATOR_KITS 不能是空的');
  for (const [charId, fn] of Object.entries(OPERATOR_KITS)) {
    assert.equal(typeof fn, 'function', `OPERATOR_KITS["${charId}"] 必须是函数（kit 的默认导出会进来）`);
  }
  assert.ok(KITTED_CHARS.length > 0, 'KITTED_CHARS 不能是空的');
});

test('共享 helper 的具名导出：社区 kit 静态 import 的那 9 个名字一个都不能少', () => {
  // 名单来自社区 mod 的 op-clemnt.js 的 5 行 import（_up/clementia-mod-recon.md §二 #11-13）
  const NEEDED = [
    [tier1, ['num', 'talentBb', 'traitBb', 'skillRec', 'up'], 'server/sim/content/kits/shared/tier1.js'],
    [tier3, ['selectedId', 'copyGrid'], 'server/sim/content/kits/shared/tier3.js'],
    [simDir, ['dirVec'], 'server/sim/dir.js'],
    [targeting, ['absoluteRangeKeys'], 'server/sim/targeting.js'],
    [constants, ['COLS', 'ROWS'], 'server/sim/constants.js'],
  ];
  for (const [mod, names, file] of NEEDED) {
    for (const n of names) {
      assert.ok(n in mod, `${WHO}：${file} 不再导出 "${n}" —— 社区 kit 的静态 import 会当场抛错，不是静默降级`);
    }
  }
});

test('kit 的 import 判罚：白名单内放行，白名单外一律 KIT_IMPORT', () => {
  // 这条是「口径」的锚点，**有意改写**：2026-10-10 业主裁定缺口④，口径从「一律拒绝」改成「白名单内放行」。
  // 判罚表与加载器共用一个扫描器（shared/kitImports.js），所以编辑器判过的东西加载器不会再拒。
  const opts = { id: 'chess_char_ws_mod_a', ownChessIds: ['chess_char_ws_mod_a'] };
  const allowed = [
    "import { num } from '@kit/tier1.js';",
    "import { selectedId } from '@kit/tier3.js';",
    "import { COLS } from '@sim/constants.js';",
    "export { dirVec } from '@sim/dir.js';",
  ];
  for (const line of allowed) {
    const src = `${line}\nexport default () => ({ ok: true });\n`;
    assert.deepEqual(kitErrors(validateKit(src, opts)), [], `${line} 必须在白名单里放行`);
  }
  const refused = [
    "import { num } from '../shared/tier1.js';",   // 相对路径：两端不可能同时对（就是这条规则的理由）
    "import x from '/abs.js';",                    // 绝对路径
    "import y from '@kit/../../x.js';",            // 路径穿越
    "import z from '@kit/evil.js';",               // 前缀对、模块名不在白名单
    "const r = require('./x.js');",                // CommonJS
    "const p = import('@kit/tier1.js');",          // 动态 import()：不可静态解析
    "export { a } from '@sim/nope.js';",           // export … from 同样按白名单判
  ];
  for (const line of refused) {
    const src = `${line}\nexport default () => ({ ok: true });\n`;
    const hit = kitErrors(validateKit(src, opts)).find((e) => e.code === 'KIT_IMPORT');
    assert.ok(hit, `${line} 今天必须被 KIT_IMPORT 拒掉`);
    assert.match(hit.message, /白名单/, '拒绝理由要说清允许什么');
  }
  const plain = "export default () => ({ ok: true });\n";
  assert.deepEqual(kitErrors(validateKit(plain, opts)), []);
});

// ---------------------------------------------------------------------------------------------------
// 四、引擎运行时 API：社区 kit 在战斗里直接调的那些成员（活体 Battle 上断言，不查源码文本）
// ---------------------------------------------------------------------------------------------------
test('活体 Battle 上的运行时成员与事件名：社区 kit 直接调的那些都还在', () => {
  const h = makeBattle({
    defs: { enemies: { enemy_dummy: enemyRec({ key: 'enemy_dummy', hp: 1e9, speed: 0, mass: 0 }) } },
    timeLimit: 60, autoFinish: false, seed: 5,
    flags: { dpPerSec: 0, dpMax: 999 },
    units: [{ uid: 1, charId: BACKUPS.diy.ownedPool[0], elite: false, row: 10, col: 5 }],
  });
  const b = h.battle ?? h.b;
  assert.ok(b, '测试夹具必须给出一个 Battle 实例');
  for (const m of ['enemiesInKeys', 'dealDamage', 'refreshRange', 'setExtraRange', 'addBuff', 'emit', 'fx', 'on']) {
    assert.equal(typeof b[m], 'function', `${WHO}：battle.${m}() 不见了`);
  }
  assert.equal(typeof b.grid?.groundPassable, 'function', `${WHO}：battle.grid.groundPassable() 不见了（浮游舱靠它判断能不能站）`);
  assert.equal(typeof b.rng?.chance, 'function', `${WHO}：battle.rng.chance() 不见了（概率类天赋与技能靠它，且它必须与 Math.random 无关）`);
  for (const ev of ['hit', 'elementBurst', 'tick']) {
    const hooked = b.on(ev, () => {});
    assert.ok(hooked === undefined || hooked === b || typeof hooked === 'object',
      `battle.on('${ev}') 的返回值形状变了（社区 kit 忽略返回值，但不能抛错）`);
  }
});

// ---------------------------------------------------------------------------------------------------
// 五、**工坊包**能依赖的表面清单（`shared/modSurface.js` + docs/MOD-SURFACE.md）。
//
// 与上面四条的分工：那些钉的是**就地补丁式** mod 依赖的通用名；这五条钉的是**声明层 ABI** —— 引擎会被上游移植整段
// 改写（lobby / match / screens 都换过），中间层不能靠「没人会动它」活着。业主 2026-10-10 的问题原话：
// 「如果改动引擎，我们的中间层可能又被覆盖，那怎么办呢」——答案就是这几条断言。
// ---------------------------------------------------------------------------------------------------
const WORKSHOP_MD = readFileSync(new URL('../docs/MOD-SURFACE.md', import.meta.url), 'utf8');
const MOD_LAYER_MD = readFileSync(new URL('../docs/design/mod-layer.md', import.meta.url), 'utf8');

/** 锚点符号住在哪个模块。默认是 schema（`shared/workshop.js`）；kit import 面住 `shared/kitImports.js`；
 *  客户端那一格（`ctx.me` / 宿主键）住 `public/js/ui/extensions.js`（引擎自己那一端的契约表）。 */
const ANCHOR_MODULES = { schema: workshopSchema, kitImports, extensions };

test('表面清单：每一条的锚点符号都还在它声明的模块里，成员一个不少', () => {
  assert.ok(MOD_SURFACE.length > 0, '表面清单不能是空的');
  for (const s of MOD_SURFACE) {
    for (const a of s.anchors) {
const mod = ANCHOR_MODULES[a.module || 'schema'];
      assert.ok(mod, `表面 "${s.id}" 的锚点声明的模块 "${a.module}" 不在 ANCHOR_MODULES 里（守卫不认识它）`);
      assert.ok(a.symbol in mod,
        `表面 "${s.id}" 锚在 ${a.symbol} 上，但 ${a.module || 'shared/workshop.js'} 不再导出这个名字（改名/挪走 = 打断所有用它的包）`);
      if (a.members) {
        const list = mod[a.symbol];
        for (const m of a.members) {
          assert.ok(Array.isArray(list) ? list.includes(m) : m in list,
            `表面 "${s.id}"：${a.symbol} 里不再有 "${m}" —— 这一格没了，包写下的声明会被 ${a.symbol === 'SERVER_MEMBERS' ? 'SERVER_UNKNOWN_FIELD' : '未知字段'} 拒掉`);
        }
      }
    }
  }
});

test('表面清单：实现文件、测试文件、设计稿小节、本文档的那一行都还在', () => {
  for (const s of MOD_SURFACE) {
    for (const f of s.files) {
      assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `表面 "${s.id}" 的实现文件 ${f} 不在了`);
    }
    for (const t of s.tests) {
      const u = new URL(`../${t}`, import.meta.url);
      assert.ok(existsSync(u), `表面 "${s.id}" 的测试文件 ${t} 不在了（没有测试钉的表面，等于没有表面）`);
      assert.match(readFileSync(u, 'utf8'), /test\(/, `表面 "${s.id}" 的 ${t} 里一条 test() 都没有`);
    }
    assert.ok(MOD_LAYER_MD.includes(s.spec.slice(1)),
      `表面 "${s.id}" 指向设计稿 ${s.spec}，但 docs/design/mod-layer.md 里没有这一节`);
    assert.ok(WORKSHOP_MD.includes(`\`${s.id}\``),
      `表面 "${s.id}" 没有写进 docs/MOD-SURFACE.md（表与文档必须同时有一行）`);
  }
});

test('表面清单：引擎里每一个「包可声明的名单」都被某条表面引用（加了一格却没进清单也红）', () => {
  // 这份名单本身也要是真实导出 —— 否则它自己会烂掉，而它正是「新加的格子有没有被漏掉」的判据。
  // 名单按「符号 + 它在哪个模块」列，和锚点同一套写法：一半在 schema（shared/workshop.js），
  // 一半在 import 面（shared/kitImports.js，kit 与战斗/房间载荷共用的白名单前缀）。
  const SURFACE_LISTS = [
    ['PACK_FIELDS', 'schema'], ['WORKSHOP_CONTENT_FILES', 'schema'], ['UNIT_REQUIRED_FIELDS', 'schema'],
    ['OVERRIDE_ENTRY_RE', 'schema'], ['WORKSHOP_MEDIA_PREFIX', 'schema'], ['WORKSHOP_PANEL_PREFIX', 'schema'],
    ['ART_TABLES', 'schema'],
    ['CLIENT_PANEL_SLOTS', 'schema'], ['CLIENT_PANEL_REPEATABLE', 'schema'],
    ['CLIENT_PANEL_DATA_TABLES', 'schema'], ['CLIENT_REQUIRES', 'schema'],
    ['CLIENT_WRAP_COMPONENTS', 'schema'], ['CLIENT_WRAP_MODES', 'schema'],
    ['SERVER_MEMBERS', 'schema'], ['SERVER_MODULE_USES', 'schema'], ['META_KEY_CLASSES', 'schema'],
    ['ROUTE_CACHE_POLICIES', 'schema'], ['ASSETS_SERVER_POLICIES', 'schema'],
    ['ASSETS_VERIFY_ALGORITHMS', 'schema'], ['PACK_ID_RE', 'schema'],
    ['KIT_IMPORT_PREFIXES', 'kitImports'], ['KIT_IMPORT_FILES', 'kitImports'],
    ['BATTLE_IMPORT_PREFIXES', 'kitImports'], ['ROOM_IMPORT_PREFIXES', 'kitImports'],
  ];
  const anchored = new Set(MOD_SURFACE.flatMap((s) => s.anchors.map((a) => `${a.module || 'schema'}:${a.symbol}`)));
  for (const [sym, mod] of SURFACE_LISTS) {
    assert.ok(sym in ANCHOR_MODULES[mod], `判据列了 ${mod}:${sym}，但它不是那个模块的导出（判据自己烂了）`);
    assert.ok(anchored.has(`${mod}:${sym}`),
      `${mod}:${sym} 是「包可声明的一格」，但没有一条表面锚在它上面 —— 新加一格必须同时进 shared/modSurface.js 与 docs/MOD-SURFACE.md`);
  }
});

test('表面清单：一个世代里不许悄悄拿掉一格（账本的失败分支自己也被测）', () => {
  assert.deepEqual(surfaceLedgerIssues(MOD_SURFACE_IDS, MOD_API_VERSION), [], '今天的表必须满足今天世代的冻结账本');
  assert.ok(MOD_SURFACE_FROZEN[String(MOD_API_VERSION)],
    `没有世代 ${MOD_API_VERSION} 的冻结账本：这一代没有任何防删保护`);
  // 失败分支：少一格必须被点名。只验「今天是对的」的守卫，和没有守卫是一回事。
  const missing = MOD_SURFACE_IDS.filter((id) => id !== 'server.battle');
  const issues = surfaceLedgerIssues(missing, MOD_API_VERSION);
  assert.equal(issues.length, 1, '少一格必须正好报一条');
  assert.match(issues[0], /server\.battle/, '报的必须是少掉的那一格');
  assert.match(issues[0], /MOD_API_VERSION/, '理由里必须说清「删格要抬世代并写迁移」');
  // 没登记过的世代要明说自己没有账本，而不是默默通过。
  assert.match(surfaceLedgerIssues(MOD_SURFACE_IDS, 999)[0] ?? '', /没有任何防删保护|冻结账本/);
});

test('表面清单：一行的字段齐、id 不重复、层次合法', () => {
  const seen = new Set();
  for (const s of MOD_SURFACE) {
    assert.match(s.id, /^[a-z][A-Za-z0-9._]*$/, `表面 id "${s.id}" 形状不对（会被文档与守卫当成键用）`);
    assert.ok(!seen.has(s.id), `表面 id 重复：${s.id}`);
    seen.add(s.id);
    assert.ok(['A', 'B', 'C'].includes(s.layer), `表面 "${s.id}" 的 layer 必须是 A/B/C`);
    assert.ok(s.decl && s.decl.length > 0, `表面 "${s.id}" 没有写声明路径`);
    assert.ok(Array.isArray(s.requires) && s.requires.length > 0,
      `表面 "${s.id}" 没写 requires —— 「这一格不是白给的」必须落在纸上`);
    assert.ok(Array.isArray(s.files) && s.files.length > 0, `表面 "${s.id}" 没有实现文件`);
    assert.ok(Array.isArray(s.tests) && s.tests.length > 0, `表面 "${s.id}" 没有钉它的测试`);
    assert.match(s.spec, /^§28\.\d+$/, `表面 "${s.id}" 的 spec 要写成 §28.NN`);
  }
});
