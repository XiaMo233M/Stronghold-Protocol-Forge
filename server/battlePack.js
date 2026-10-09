// 包声明的**战斗逻辑**模块的装载路径（`pack.json.server.battle`, DESIGN §28.17）。
// (i18n-ignore-file: 这里的文案是给作者/加载器的错误说明 —— 与 server/match/metaPack.js 同一类，不是客户端界面文案)
//
// 这一类载荷补的是 `kits/` 补不上的那一块：kit 是**一个干员**的代码（`kits/<chessId>.js`），而一份真实 mod 的盟约
// 效果是**整场**的 —— 「我方所有成员对处于眩晕/停顿/束缚的敌人增伤」「凑够 6 名不同成员时全员加攻速」「某两件装备
// 同时装备时每秒真实伤害」。这些条件要在战场级别读玩家、读全场单位、读装备组合，kit 看不到别人，所以粒度只能是
// 「一个包一份、一场一次」。
//
// 三层结构，与 `server.meta` 的装配路径（`server/match/metaPack.js`）同形：
//   * **形状**（`shared/workshop.js parseBattleDecl`）：`{ module }`，包内相对 `.mjs`；
//   * **装载**（本文件 `loadBattleInstallers`，启动时一次）：静态确定性扫描 + import 白名单 → 动态 `import` →
//     有没有 `install` 导出；
//   * **装配**（`server/sim/content/index.js installContent`，每场一次）：把这一场声明过的 installer 逐个跑一遍，
//     每个包**单独 try/catch** —— 一个包抛异常只记日志，不让整个战场起不来（与 kits 逐单位隔离同一条口径）。
//
// 为什么 import 走白名单而不是 `registry.api` 那样的显式对象：这两个东西的形状不同 —— meta 模块导出的是
// `registerMeta(registry)`（引擎把对象**递进去**），而战斗逻辑模块导出的是 `install(battle)`，与官方内容模块
// （`content/bonds/custom.js` 之类）**逐字同形**。要让它与官方模块同形，辅助函数就得能 `import` —— 于是用
// `shared/kitImports.js` 那张已经在两端都成立的白名单（`@battle/` 指向战斗内容层的 support，`@sim/` 三个纯函数），
// 服务端把白名单前缀改写成真实 `file:` URL 再用 `data:` URL 加载，浏览器靠 `public/index.html` 的 import map。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { KIT_FORBIDDEN_GLOBALS, SERVER_CODE_FORBIDDEN_GLOBALS, stripComments, mentionsIdentifier } from '../shared/kitAuthoring.js';
import {
  BATTLE_IMPORT_TARGETS, battleImportAllowedText, kitImportDeclarations, kitImportIssues, rewriteKitImports,
} from '../shared/kitImports.js';

/** 仓库根：白名单里的路径是**工作区相对**的（与 `server/workshop.js` 同一个值）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 静态判定一个战斗逻辑模块的源码，**在 import 之前**（与 `metaSourceIssues` 同一套纪律与同一张表）。
 *
 * 唯一的差别是 import 面：meta 模块只许 import 包内文件（辅助函数走 `registry.api`），而战斗模块按官方内容模块的
 * 形状写，所以它走 `@battle/` / `@sim/` 白名单 —— 一个**两端都成立**的前缀，而不是把引擎路径硬编码进包。
 * @param {string} source
 * @param {string} packId
 * @returns {Array<{ code: string, reason: string }>}
 */
export function battleSourceIssues(source, packId = '') {
  const text = String(source ?? '');
  const code = stripComments(text);
  const out = [];
  for (const [needle, why] of [...KIT_FORBIDDEN_GLOBALS, ...SERVER_CODE_FORBIDDEN_GLOBALS]) {
    if (mentionsIdentifier(code, needle)) {
      out.push({ code: 'BATTLE_BAD_SOURCE', reason: `"${needle}" is not allowed in a server.battle module${packId ? ` ("${packId}")` : ''}: ${why}` });
    }
  }
  // `allowRelative: false` 是两类载荷之间**刻意的不对称**（DESIGN §28.18）：kit 可以 import 本包 kits/ 下的兄弟文件
  // （`./lib/util.js`），而战斗逻辑模块不行 —— 它在服务端是当 `data:` URL 加载的，`data:` 没有目录，相对说明符
  // 无从解析；浏览器那半虽然能解，但两端必须跑同一段代码，所以只能拒绝。官方内容层的东西走 `@battle/`。
  for (const issue of kitImportIssues(text, kitImportDeclarations(text), { targets: BATTLE_IMPORT_TARGETS, allowedText: battleImportAllowedText, allowRelative: false })) {
    out.push({ code: 'BATTLE_BAD_IMPORT', reason: `${issue.reason}（server.battle 模块的白名单与 kit 不同：只有 @battle/ 与 @sim/）` });
  }
  return out;
}

/** 一个包声明的战斗逻辑模块的绝对路径（形状层已经判过「包内相对 + .mjs」）。 */
function moduleAbs(pack) {
  return path.join(pack.dir, ...String(pack.server.battle.module).split('/'));
}

/**
 * 启动时一次：把每个**声明了 `server.battle`** 的包读出来、扫一遍、import，收下它的 `install`。
 *
 * 顺序按包 id 升序（DESIGN §28.3）：一趟里几个包都要挂钩子时，谁先挂谁的钩子先跑 —— 这个顺序不能随目录读取顺序变。
 * 失败**不抛**：一条 `{ pack, code, reason }` 回到调用方，由它按「一条用不了的声明拒绝整个包」把包裁掉
 * （`server/index.js` 与 `server.preDispatch` / `server.meta` 走同一个裁剪点）。
 *
 * 返回的 `modules` 是**要送到浏览器的那一份**（JSON 安全：id / pack / hash / url）：客户端战斗必须加载同一段代码，
 * 否则浏览器算出来的战果与服务端复算的对不上、玩家的成绩会被拒。
 * @param {{ packs?: Array<any> }} loaded `loadWorkshop(...)`
 * @param {{ log?: any, baseUrl?: string, importModule?: (url: string) => Promise<any> }} [opts]
 * @returns {Promise<{ installers: Array<{ id: string, hash: string, pack: string, install: Function }>,
 *   modules: Array<{ id: string, pack: string, hash: string, url: string }>,
 *   errors: Array<{ pack: string, code: string, reason: string }> }>}
 */
export async function loadBattleInstallers(loaded, { log = null, baseUrl = '/workshop-battle', importModule = (url) => import(url) } = {}) {
  const installers = [];
  const modules = [];
  const errors = [];
  const packs = (loaded && Array.isArray(loaded.packs) ? loaded.packs : [])
    .filter((p) => p && p.server && p.server.battle)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const pack of packs) {
    const abs = moduleAbs(pack);
    const rel = String(pack.server.battle.module);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      errors.push({ pack: pack.id, code: 'BATTLE_BAD_MODULE', reason: `server.battle.module "${rel}" is not readable: ${e && e.message ? e.message : e}` });
      continue;
    }
    const issues = battleSourceIssues(source, pack.id);
    if (issues.length) {
      errors.push({ pack: pack.id, code: issues[0].code, reason: issues[0].reason });
      log?.warn?.(`[workshop] ${pack.id}: ${issues[0].code}: ${issues[0].reason}`);
      continue;
    }
    // 带包摘要的查询串：包换了一版（目录里的字节变了）就是另一条 URL，动态 import 的模块缓存不会把旧模块交回来。
    const v = encodeURIComponent(pack.hash || '');
    const decls = kitImportDeclarations(source);
    let mod;
    try {
      // 有白名单 import 时加载**改写过的** `data:` 模块：`data:` 没有目录，相对说明符解不出来，所以先把白名单条目
      // 换成真实 `file:` URL。改写只碰白名单里的说明符，包里的字节（也就是身份哈希的输入）一个都不动。
      mod = decls.length
        ? await importModule(`data:text/javascript;base64,${Buffer.from(rewriteKitImports(source, (file) => pathToFileURL(path.join(ROOT, file)).href, { targets: BATTLE_IMPORT_TARGETS }), 'utf8').toString('base64')}#v=${v}`)
        : await importModule(`${pathToFileURL(abs).href}?v=${v}`);
    } catch (e) {
      errors.push({ pack: pack.id, code: 'BATTLE_IMPORT_FAILED', reason: `server.battle.module "${rel}" failed to load: ${e && e.message ? e.message : e}` });
      continue;
    }
    const install = typeof mod?.install === 'function' ? mod.install : null;
    if (!install) {
      errors.push({ pack: pack.id, code: 'BATTLE_NO_INSTALL', reason: `server.battle.module "${rel}" does not export an install(battle) function — the same shape the official content modules use` });
      continue;
    }
    installers.push({ id: pack.id, hash: pack.hash || '', install });
    modules.push({ id: pack.id, pack: pack.id, hash: pack.hash || '', url: `${baseUrl}/${encodeURIComponent(pack.id)}/${rel.split('/').map(encodeURIComponent).join('/')}?v=${v}` });
  }
  return { installers, modules, errors };
}
