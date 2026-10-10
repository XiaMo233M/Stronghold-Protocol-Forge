// test/packRelativeImports.test.js — 包相对 import（DESIGN §28.18, docs/WORKSHOP.md §4.6）。
//
// 一个 kit 是**同一份文件被两处加载**：服务端按真实路径、浏览器按 URL（§28.12）。所以「把 1138 行的
// kits/custom.js 拆成一干员一文件」这件事，卡在**共享辅助代码够不着**上：白名单只开引擎文件，而 `@包/` 这种
// 前缀不可能存在（public/index.html 的 import map 是**每页一张静态表**，写不出「每个包一个前缀」）。
//
// 唯一两端都能原生解析的形式是**向下相对**：`./lib/util.js`。
//
//   * 磁盘上 kit 是 <packDir>/kits/<id>.js → `./lib/util.js` 是 <packDir>/kits/lib/util.js；
//   * 浏览器取的是 /workshop-kits/<pack>/<id>.js（**kits/ 这一段不在 URL 里**）→ `./lib/util.js` 是
//     /workshop-kits/<pack>/lib/util.js，而路由把 `<pack>/<rel>` 映回 <packDir>/kits/<rel>。
//
// 同一个文件。`..` 永远做不到（URL 里没有 kits/ 这一层可退），所以它仍然被拒 —— 本文件把这两半都钉住：
// ① 判据；② 真加载；③ 真服务器的路由（含穿越与非 .js）；④ 两端指向同一个文件；⑤ 身份哈希的递归覆盖。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import {
  BATTLE_IMPORT_TARGETS, KIT_IMPORT_TARGETS, battleImportAllowedText, isPackRelativeSpecifier,
  kitImportAllowedText, kitImportDeclarations, kitImportIssues, kitImportRelativeText, packRelativePath, rewriteKitImports,
} from '../shared/kitImports.js';
import { validateKit, kitErrors } from '../shared/kitAuthoring.js';
import { identifyPack, loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { workshopKitDirsFor } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const PACK = 'packrel-probe';
const ID = 'chess_ws_packrel_a';
const OTHER_ID = 'chess_ws_packrel_b';
const OPTS = { id: ID, ownChessIds: [ID, OTHER_ID] };

/** 辅助文件里的那个常量：两处断言都用它，证明 helper 真的执行过，而不只是「能被解析」。 */
const UTIL_SRC = 'export const tag = "PACKREL_UTIL_V1";\nexport default function util() { return tag; }\n';
/** 二级目录里的辅助文件：证明子目录不只是「放得下」，而是真的按目录解。 */
const NESTED_SRC = 'export const nested = "PACKREL_NESTED";\n';

const utilOf = (packDir) => path.join(packDir, 'kits', 'lib', 'util.js');

const CHESS_REC = (id) => ({
  chessId: id, baseId: id, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR',
  position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 1, atk: 1, def: 1, res: 0, cost: 1, blockCnt: 1, bat: 1 },
  talents: [], bonds: [],
});

/**
 * A pack whose kit imports `./lib/util.js`. `recordIds` are the ids the pack's `chess.json` carries and `kitIds` the
 * ones it ships a kit FILE for; both default to `[kitId, OTHER_ID]` so a fixture never leaves a record without a kit
 * (the loader reports a kit for an unknown id, and that report would hide what a test is really about).
 * `kitBody`/`util` let one fixture serve the loader test, the route test and the two-end test.
 */
function makePack({ packId = PACK, kitId = ID, kitBody = 'return { probe: { tag: util(), path: "lib/util.js" } };', util = UTIL_SRC, extra = [], recordIds = [kitId, OTHER_ID], kitIds = [kitId, OTHER_ID], expectedKits = [kitId, OTHER_ID].filter((id) => kitIds.includes(id)) } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-packrel-'));
  const wsRoot = path.join(dir, 'workshop');
  const packDir = path.join(wsRoot, packId);
  fs.mkdirSync(path.join(packDir, 'kits', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
    id: packId, name: 'Pack-relative probe', version: '0.1.0', content: ['chess'], overrides: [],
  }));
  const chess = {};
  for (const id of recordIds) chess[id] = CHESS_REC(id);
  fs.writeFileSync(path.join(packDir, 'chess.json'), JSON.stringify(chess));
  const haveKits = kitIds.slice();
  fs.writeFileSync(path.join(packDir, 'kits', `${haveKits[0]}.js`), `import util from './lib/util.js';\n\nexport default function kit() {\n  ${kitBody}\n}\n`);
  // 第二个 kit 不 import 任何东西（其它测试用不到它，但它必须能装上，否则夹具自己会报错）
  for (const id of haveKits.slice(1)) fs.writeFileSync(path.join(packDir, 'kits', `${id}.js`), 'export default function kit() { return { sibling: true }; }\n');
  fs.writeFileSync(utilOf(packDir), util);
  for (const [rel, text] of extra) {
    const abs = path.join(packDir, 'kits', ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return { dir, wsRoot, packDir, kitDir: path.join(packDir, 'kits'), expectedKits };
}

/** The loaded pack list for a fixture. */
const loadFixture = (fx) => loadWorkshop(fx.wsRoot, { log: quiet });

// ---------------------------------------------------------------------------------------------------
// ① 判据：接受什么、拒绝什么，以及拒绝理由里必须说清新写法（编辑器与加载器共用这一份）
// ---------------------------------------------------------------------------------------------------
describe('§28.18 判据：向下相对的形式', () => {
  const src = (spec) => `import { a } from ${JSON.stringify(spec)};\nexport default () => a;\n`;
  const verdict = (spec) => kitImportIssues(src(spec));

  test('接受 / 拒绝的清单（正好是提示里点名的那几条）', () => {
    const accepted = ['./x.js', './lib/x.js'];
    const refused = ['../x.js', './../x.js', '/abs/x.js', 'x.js', './x.mjs', './x', './', './%2e%2e/x.js', './x.js?1', './sub\\x.js'];
    for (const spec of accepted) {
      assert.equal(isPackRelativeSpecifier(spec), true, `${spec} 必须被认成包相对`);
      assert.deepEqual(verdict(spec), [], `${spec} 必须放行`);
    }
    for (const spec of refused) {
      assert.equal(isPackRelativeSpecifier(spec), false, `${spec} 不能被认成包相对`);
      const hit = verdict(spec).find((i) => i.code === 'KIT_IMPORT');
      assert.ok(hit, `${spec} 必须被拒`);
    }
  });

  test('每一条拒绝理由都说清「白名单 + 还能 import 自己包里的 ./…」（只说不行 = 作者只能把代码塞进一个文件）', () => {
    for (const spec of ['../x.js', '/abs.js', 'lodash', '@kit/evil.js', './x.mjs']) {
      const hit = verdict(spec).find((i) => i.code === 'KIT_IMPORT');
      assert.ok(hit.reason.includes(kitImportAllowedText()), `${spec} 的理由必须内嵌白名单文本`);
      assert.ok(hit.reason.includes(kitImportRelativeText), `${spec} 的理由必须告诉作者包相对写法也能用`);
    }
  });

  test('% 一律拒绝（%2e%2e 就是这样变成 ".." 的）：不是「解码后放行」', () => {
    for (const spec of ['./%2e%2e/x.js', './%2E%2E/x.js', './lib/%2e/x.js', './x%2Ejs']) {
      assert.equal(isPackRelativeSpecifier(spec), false, `${spec} 必须原样拒绝`);
      assert.match(verdict(spec)[0].reason, /%/, `${spec} 的理由要点名百分号`);
    }
  });

  test('空段、NUL、`?`/`#`、反斜杠、非 .js 各有自己的理由', () => {
    assert.match(verdict('./x//y.js')[0].reason, /不是可用的包相对路径/);
    assert.match(verdict('./x.js?1')[0].reason, /\?/);
    assert.match(verdict('./x.js#a')[0].reason, /#/);
    assert.match(verdict('./sub\\x.js')[0].reason, /反斜杠/);
    assert.match(verdict('./x.mjs')[0].reason, /只支持 \.js/);
    assert.match(verdict('./x')[0].reason, /必须以 "\.js" 结尾/);
    // 空段：`./x//y.js` 会被拼成 kits/x//y.js，两端都不该接受（判据与重写用的是同一条）
    assert.equal(isPackRelativeSpecifier('./x//y.js'), false);
    // NUL 不是「某一类相对路径的问题」：它连静态扫描都过不去（这里只钉判据那一半）
    assert.equal(isPackRelativeSpecifier('./x.js\0'), false);
  });

  test('`..` 的理由说清**为什么**两端不可能一致（URL 里没有 kits/ 这一层）', () => {
    for (const spec of ['../x.js', './../x.js', './lib/../x.js']) {
      const hit = verdict(spec).find((i) => i.code === 'KIT_IMPORT');
      assert.match(hit.reason, /kits\//, `${spec} 的理由必须点出 kits/ 这一段`);
    }
  });

  test('战斗逻辑模块（server.battle）刻意不对称：同一个 `./x.js` 被拒，理由指向 @battle/', () => {
    // battle 模块在服务端是当 data: URL 加载的：data: 没有目录，相对说明符无从解析 —— 所以这张表不接受它。
    const battle = (spec) => kitImportIssues(src(spec), null, {
      targets: BATTLE_IMPORT_TARGETS, allowedText: battleImportAllowedText, allowRelative: false,
    });
    for (const spec of ['./x.js', './lib/x.js']) {
      const hit = battle(spec).find((i) => i.code === 'KIT_IMPORT');
      assert.ok(hit, `${spec} 在战斗逻辑模块里必须被拒`);
      assert.match(hit.reason, /data: ?URL|data:/, `${spec} 的理由要说清 data: 没有目录`);
      assert.match(hit.reason, /@battle\//, `${spec} 的理由要指向 @battle/`);
      assert.ok(battleImportAllowedText().includes('@battle/index.js'));
      // 对照：同一句 import 在 kit 那张表里是放行的 —— 不对称是**有意**的，不是判据漏了
      assert.deepEqual(verdict(spec), []);
    }
    // 白名单本身在两张表里照样成立：战斗模块能用 @battle/ 与 @sim/
    for (const spec of ['@battle/index.js', '@sim/dir.js']) assert.deepEqual(battle(spec), [], spec);
  });

  test('编辑器读的是同一份判据（validateKit → kitImportIssues），所以它不会放过加载器会拒的东西', () => {
    assert.deepEqual(kitErrors(validateKit(src('./lib/util.js'), OPTS)), [], './lib/util.js 在编辑器里必须零错误');
    for (const spec of ['../x.js', './%2e%2e/x.js', './x.mjs', './sub\\x.js']) {
      const hit = kitErrors(validateKit(src(spec), OPTS)).find((e) => e.code === 'KIT_IMPORT');
      assert.ok(hit, `${spec} 在编辑器里必须被拒`);
      // 同一句话：加载器的 reason 就是校验器的 message（§28.12 的「一个判据两个读者」）
      assert.equal(hit.message, kitImportIssues(src(spec))[0].reason, `${spec}：编辑器与加载器必须算出同一句话`);
    }
  });

  test('scan 仍然只认真正的静态 import：注释/字符串里的 ./x.js 不算', () => {
    const text = [
      '// import { a } from "./lib/util.js";  ← 说明文字',
      'const s = "import { b } from \'./lib/util.js\';";',
      "import { c } from './lib/util.js';",
      'export default () => s && c;',
    ].join('\n');
    assert.deepEqual(kitImportDeclarations(text).map((d) => d.specifier), ['./lib/util.js']);
    assert.deepEqual(kitImportIssues(text), []);
  });
});

// ---------------------------------------------------------------------------------------------------
// ② 重写：白名单走 urlOf，包相对走**这个文件自己的目录**（data: 没有目录，不重写就解不出来）
// ---------------------------------------------------------------------------------------------------
describe('§28.18 重写：只动该动的两行，其余字节一个不改', () => {
  test('whitelisted → urlOf(file)；pack-relative → resolveRelative(specifier)', () => {
    const text = "import { num } from '@kit/tier1.js';\nimport util from './lib/util.js';\nconst s = \"import x from './y.js';\";\nexport default () => [num, util, s];\n";
    const out = rewriteKitImports(text, (file) => `file:///${file}`, {
      resolveRelative: (spec) => `file:///PACK/kits/${packRelativePath(spec)}?v=7`,
    });
    assert.equal(out, "import { num } from 'file:///server/sim/content/kits/shared/tier1.js';\nimport util from 'file:///PACK/kits/lib/util.js?v=7';\nconst s = \"import x from './y.js';\";\nexport default () => [num, util, s];\n");
  });

  test('没有 resolveRelative 时（战斗那张表）包相对**不**重写：留给加载器报错，而不是抛模块解析失败', () => {
    const text = "import util from './lib/util.js';\nexport default () => util;\n";
    assert.equal(rewriteKitImports(text, (file) => `file:///${file}`), text);
  });

  test('被拒的包相对形式（含 ".."）同样不重写', () => {
    const text = "import util from './../outside.js';\nexport default () => util;\n";
    const out = rewriteKitImports(text, (f) => `file:///${f}`, { resolveRelative: (spec) => `file:///NOPE/${spec}` });
    assert.equal(out, text);
  });

  test('KIT_IMPORT_TARGETS 里没有 "./…" 这种条目：两张表永远互不覆盖', () => {
    for (const key of KIT_IMPORT_TARGETS.keys()) assert.equal(key.startsWith('./'), false, key);
  });
});

// ---------------------------------------------------------------------------------------------------
// ③ 真加载：服务端 import 一个带包相对 import 的 kit，并调用辅助函数
// ---------------------------------------------------------------------------------------------------
describe('§28.18 加载器：带 ./lib/util.js 的 kit 真的装上了', () => {
  let fx;
  before(() => { fx = makePack(); });
  after(() => { if (fx) fs.rmSync(fx.dir, { recursive: true, force: true }); });

  test('kit 被 import 成功，辅助函数的返回值进了断言（不是「能解析」就算过）', async () => {
    const info = await loadWorkshopKits(loadFixture(fx), { log: quiet, knownIds: new Set([ID, OTHER_ID]) });
    assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
    const fn = info.kits[ID];
    assert.equal(typeof fn, 'function', '带包相对 import 的 kit 必须真的被加载');
    assert.deepEqual(fn().probe, { tag: 'PACKREL_UTIL_V1', path: 'lib/util.js' }, '辅助模块真的执行了');
    // 浏览器那半的 URL 还是老规矩：登记过的 kits/<id>.js
    assert.deepEqual(info.modules.map((m) => m.id), [ID, OTHER_ID].slice().sort());
    const mine = info.modules.find((m) => m.id === ID);
    assert.match(mine.url, new RegExp(`^/workshop-kits/${PACK}/${ID}\\.js\\?v=\\d+$`));
  });

  test('辅助文件**自己**再去 import 兄弟文件时，按它自己的目录解（浏览器按模块自己的 URL 解，逐字同构）', async () => {
    const nested = makePack({
      packId: 'packrel-nested',
      kitBody: 'return { nested: util() };',
      util: "import { nested } from './deeper.js';\nexport default function util() { return nested; }\n",
      extra: [['lib/deeper.js', NESTED_SRC]],
      recordIds: [ID],
      kitIds: [ID],
    });
    try {
      const info = await loadWorkshopKits(loadFixture(nested), { log: quiet, knownIds: new Set([ID]) });
      assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
      assert.deepEqual(info.kits[ID]().nested, 'PACKREL_NESTED');
    } finally {
      fs.rmSync(nested.dir, { recursive: true, force: true });
    }
  });

  test('不存在的包相对文件：报 KIT_IMPORT_FAILED 并跳过这一个 kit，不影响启动', async () => {
    const broken = makePack({ packId: 'packrel-broken', recordIds: [ID], kitIds: [ID] });
    fs.rmSync(utilOf(broken.packDir));
    try {
      const info = await loadWorkshopKits(loadFixture(broken), { log: quiet, knownIds: new Set([ID]) });
      const hit = info.errors.find((e) => e.id === ID);
      assert.ok(hit, JSON.stringify(info.errors));
      assert.equal(hit.code, 'KIT_IMPORT_FAILED');
      assert.equal(info.kits[ID], undefined);
    } finally {
      fs.rmSync(broken.dir, { recursive: true, force: true });
    }
  });

  test('无 import 的 kit 仍然走「按真实路径 import」的快路径（§28.18 没动它）', async () => {
    const plain = makePack({ packId: 'packrel-plain', recordIds: [ID], kitIds: [ID] });
    fs.writeFileSync(path.join(plain.packDir, 'kits', `${ID}.js`), 'export default function kit() { return { plain: true }; }\n');
    try {
      const info = await loadWorkshopKits(loadFixture(plain), { log: quiet, knownIds: new Set([ID]) });
      assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
      assert.deepEqual(info.kits[ID](), { plain: true });
    } finally {
      fs.rmSync(plain.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// ④ 真服务器路由：`<包>/<rel>` 放宽到 kits/ 子树，但只放宽到那里
// ---------------------------------------------------------------------------------------------------
describe('§28.18 路由：/workshop-kits/<包>/<rel>', () => {
  let fx;
  let stray;
  let srv;
  before(async () => {
    fx = makePack({ extra: [['lib/util.txt', 'not javascript\n'], ['notes.js', 'export const notes = 1;\n']] });
    // 另一个包装着同名辅助文件，但**不**在本服务器的已装载集合里（另一个 workshop 根）：它必须 404
    stray = makePack({ packId: 'packrel-unloaded' });
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: fx.wsRoot });
  });
  after(async () => {
    if (srv) await srv.close();
    if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
    if (stray) fs.rmSync(stray.dir, { recursive: true, force: true });
  });

  const get = (p) => fetch(srv.url + p);

  test('kits/lib/util.js 是 200 且按 JS 送出，内容就是磁盘上那一份', async () => {
    const res = await get(`/workshop-kits/${PACK}/lib/util.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
    assert.equal(await res.text(), UTIL_SRC);
  });

  test('登记过的 kit URL 照旧 200（放宽没有把旧入口挤掉）', async () => {
    const res = await get(`/workshop-kits/${PACK}/${ID}.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /import util from '\.\/lib\/util\.js'/);
  });

  test('穿越、非 .js、未知包、缺文件一律同一个 404（不透露文件在不在）', async () => {
    const paths = [
      `/workshop-kits/${PACK}/../pack.json`,          // 经典穿越
      `/workshop-kits/${PACK}/%2e%2e/pack.json`,      // 编码过的穿越：**只解一次**，到这里就是 ".."，按段拒
      `/workshop-kits/${PACK}/lib/../../pack.json`,
      `/workshop-kits/${PACK}/lib/util.txt`,          // 非 .js
      `/workshop-kits/${PACK}/lib/util.js.bak`,       // 末段不是 .js
      `/workshop-kits/${PACK}/lib/`,                  // 空段
      `/workshop-kits/${PACK}/`,                      // 只有包名
      `/workshop-kits/${PACK}`,                       // 连斜杠都没有
      `/workshop-kits/${PACK}/nope.js`,               // 不存在的文件
      `/workshop-kits/packrel-unloaded/lib/util.js`,  // 另一个包（不在这台服务器的已装载集合里）
      `/workshop-kits/lib/util.js`,                   // 把 "lib" 当包名
      `/workshop-kits/`,
    ];
    const bodies = new Set();
    for (const p of paths) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      bodies.add(await res.text());
    }
    // 同一个 404 体：一次穿越与一个「只是不存在」的文件，客户端看不出区别
    assert.equal(bodies.size, 1, `404 体必须完全一致，实际 ${bodies.size} 种`);
  });

  test('未装载的包**不是**「被挡住」，而是根本不在表里（服务范围由装载器决定）', () => {
    const dirs = workshopKitDirsFor(loadFixture(fx));
    assert.deepEqual([...dirs.keys()], [PACK]);
    assert.equal(dirs.get(PACK), fx.kitDir);
    assert.equal(workshopKitDirsFor({ packs: [] }).size, 0);
    assert.equal(workshopKitDirsFor(null).size, 0);
    // 手写的包对象缺 dir / id 时整条丢掉，不猜路径
    assert.equal(workshopKitDirsFor({ packs: [{ id: PACK }, { dir: fx.kitDir }, null] }).size, 0);
  });

  test('HEAD 与 GET 都不写体（HEAD 只回头）', async () => {
    const res = await fetch(`${srv.url}/workshop-kits/${PACK}/lib/util.js`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
});

// ---------------------------------------------------------------------------------------------------
// ⑤ 两端指向同一个文件：这一条是 §28.18 的全部理由，所以两面都断言
// ---------------------------------------------------------------------------------------------------
describe('§28.18 两端：同一个 ./lib/util.js 解析到同一份字节', () => {
  let fx;
  let srv;
  before(async () => {
    fx = makePack();
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: fx.wsRoot });
  });
  after(async () => {
    if (srv) await srv.close();
    if (fx) fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  test('服务端读的那一份、浏览器会去取的那一份、磁盘上的那一份，是同一个文件', async () => {
    const spec = './lib/util.js';
    // (a) 服务端：kit 真的被加载，且它的辅助函数返回辅助文件的字节里那个常量
    const loaded = loadFixture(fx);
    const info = await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set([ID, OTHER_ID]) });
    assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
    assert.deepEqual(info.kits[ID]().probe, { tag: 'PACKREL_UTIL_V1', path: 'lib/util.js' });
    // 服务端这一次 import 用的那个 file: URL：就是「kit 自己的目录 + specifier」，与加载器里的解析同一条规则
    const serverFile = path.join(fx.kitDir, ...packRelativePath(spec).split('/'));
    assert.equal(serverFile, utilOf(fx.packDir), '服务端解析出来的必须是 <packDir>/kits/lib/util.js');
    assert.equal(await fs.promises.readFile(serverFile, 'utf8'), UTIL_SRC, '服务端读到的就是那份字节');

    // (b) 浏览器：kit 的 URL 是 /workshop-kits/<包>/<id>.js，相对 specifier 按**那个 URL** 解析
    const kitUrl = `http://x/workshop-kits/${PACK}/${ID}.js`;
    const browserUrl = new URL(spec, kitUrl).pathname;
    assert.equal(browserUrl, `/workshop-kits/${PACK}/lib/util.js`, '浏览器解出来的是这个 URL');
    // 这个 URL 经**真服务器**取回来的字节，必须与 (a) 里服务端 import 的那份逐字符相同
    const res = await fetch(new URL(browserUrl, srv.url));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), await fs.promises.readFile(serverFile, 'utf8'), '两端必须是同一个文件的同一份字节');
    assert.match(res.headers.get('content-type') || '', /javascript/, '两端都把它当 ES 模块');
    assert.equal(fileURLToPath(pathToFileURL(serverFile).href), serverFile, '服务端那一半用的是这个 file: URL');
    // 反证：URL 里没有 "kits/" 这一段，所以浏览器解出来的相对路径里也不该有
    assert.equal(browserUrl.includes('/kits/'), false, 'URL 里不该出现 kits/ 这一段（它只在磁盘路径上）');
  });
});

// ---------------------------------------------------------------------------------------------------
// ⑥ 身份哈希（DESIGN §28.2）：递归覆盖 kits/**，且**扁平** kits/ 的清单逐字节不变
// ---------------------------------------------------------------------------------------------------
describe('§28.18 身份哈希：kits/** 的每一个 .js 都进摘要', () => {
  const files = () => ({ chess: { [ID]: CHESS_REC(ID), [OTHER_ID]: CHESS_REC(OTHER_ID) } });
  let hx;
  before(() => { hx = makePack(); });
  after(() => { if (hx) fs.rmSync(hx.dir, { recursive: true, force: true }); });

  test('改一个字节的 kits/lib/util.js，identifyPack().hash 就变（辅助文件的字节决定战斗怎么打）', () => {
    const before = identifyPack(hx.packDir, { id: PACK }, files());
    const entry = before.manifest.find((m) => m.path === 'kits/lib/util.js');
    assert.ok(entry, `子目录里的 .js 必须在清单里：${before.manifest.map((m) => m.path).join(', ')}`);
    assert.equal(entry.hash.length, 64);
    // 只改辅助文件（kit 源码一个字节没动）
    try {
      fs.writeFileSync(utilOf(hx.packDir), 'export const tag = "PACKREL_UTIL_V2";\nexport default function util() { return tag; }\n');
      const after = identifyPack(hx.packDir, { id: PACK }, files());
      assert.notEqual(after.hash, before.hash, '辅助文件改了、摘要不变 ⇒ 两个客户端会共用同一个摘要（W-D 对齐就失效）');
      assert.notEqual(after.manifest.find((m) => m.path === 'kits/lib/util.js').hash, entry.hash);
      assert.equal(after.manifest.find((m) => m.path === `kits/${ID}.js`).hash, before.manifest.find((m) => m.path === `kits/${ID}.js`).hash, 'kit 源码没动，它的条目不该动');
    } finally {
      fs.writeFileSync(utilOf(hx.packDir), UTIL_SRC);
    }
    assert.deepEqual(identifyPack(hx.packDir, { id: PACK }, files()), before, '还原后必须回到原摘要');
  });

  test('扁平的 kits/ 目录：清单路径与从前逐字节相同（kits/<name>，没有第二个 kits/ 前缀）', () => {
    const flat = makePack({ packId: 'packrel-flat', recordIds: [ID], kitIds: [ID] });
    // 去掉子目录：留下一个纯扁平的 kits/
    fs.rmSync(path.join(flat.packDir, 'kits', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(flat.packDir, 'kits', `${ID}.js`), 'export default function kit() { return {}; }\n');
    try {
      const manifest = identifyPack(flat.packDir, { id: 'packrel-flat' }, {}).manifest;
      assert.deepEqual(manifest.filter((m) => m.path.startsWith('kits/')).map((m) => m.path), [`kits/${ID}.js`]);
      assert.equal(manifest.some((m) => m.path === 'kits//x.js' || m.path.endsWith('//')), false);
    } finally {
      fs.rmSync(flat.dir, { recursive: true, force: true });
    }
  });

  test('仓库里三份真实包的摘要不动（其中 kit-demo 的 kits/ 是扁平的）—— 用 packAssets 的基线在这里复核一遍', () => {
    // 基线取自 test/packAssets.test.js（450e9ea 的装载器实测），这里只复核**哈希覆盖改了**之后它们还是那三个数。
    // clementia 那一个在 0.2.3 那一轮**移过**：上游把克莱门莎收成了官方干员（官方 id `char_4231_clemnt`），
// 本仓库的示例夹具再用那个 id 会被加载器按 OFFICIAL_ID_COLLISION 拒掉，于是 id 换成工坊保留前缀的
// `char_ws_clemnt`（docs/examples/clementia/README.md）—— 包的内容真的变了，基线随之移动。
const BASELINE = {
      clementia: '27627f47d04aef3a622202a92038ada7a514b2c2b44389bfb069720b823d987e',
      'demo-workshop': '15092019fd1dbc85589af4b89102746c3a3c0389aef3847d7d9a335bca1a73ef',
      'kit-demo': '77b80c6e74021508d5857208d669da36cc74f20384798a6d5a269fd37f9e4f35',
    };
    const loaded = loadWorkshop(path.join(ROOT, 'docs/examples'), { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), Object.keys(BASELINE).sort());
    for (const pack of loaded.packs) {
      assert.equal(pack.hash, BASELINE[pack.id], `${pack.id}: 扁平 kits/ 的包摘要不该动`);
      // 清单里**没有**多出第二条 kits 条目（递归不该把 kits/<name> 写成 kits/kits/<name>）
      const kitPaths = pack.manifest.filter((m) => m.path.startsWith('kits/')).map((m) => m.path);
      assert.deepEqual(kitPaths, kitPaths.filter((p) => !p.startsWith('kits/kits/')), `${pack.id}: 清单路径多了一层 kits/`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// ⑦ 「什么算一个 kit」：子目录不是 kit，`_` 开头不是 kit
// ---------------------------------------------------------------------------------------------------
describe('§28.18 扫描规则：kits/ 里什么算 kit', () => {
  test('子目录不是 kit；`kits/_shared.js` 不是 kit；顶层 <id>.js 照旧', async () => {
    const fx = makePack({ packId: 'packrel-scan', recordIds: [ID], kitIds: [ID] });
    fs.writeFileSync(path.join(fx.kitDir, '_shared.js'), 'export const shared = 1;\n');
    fs.mkdirSync(path.join(fx.kitDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(fx.kitDir, 'lib', 'helper.js'), 'export const helper = 1;\n');
    try {
      const loaded = loadFixture(fx);
      const info = await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set([ID]) });
      assert.deepEqual(info.errors, [], JSON.stringify(info.errors));
      // 只有顶层那个 kit 被加载：_shared.js 与 lib/helper.js 都不是 kit，也没有被报成「干员不存在」
      assert.deepEqual(Object.keys(info.kits), [ID]);
      assert.deepEqual(info.modules.map((m) => m.id), [ID]);
      assert.equal(info.errors.some((e) => e.id === '_shared' || e.id === 'helper'), false, '子目录与 _ 前缀不该被当成 kit id');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('`kits/_shared.js` 的字节**进**身份哈希（它是战斗的一部分），但不进 kit 计数', () => {
    const fx = makePack({ packId: 'packrel-hashshared', recordIds: [ID], kitIds: [ID] });
    fs.writeFileSync(path.join(fx.kitDir, '_shared.js'), 'export const shared = 1;\n');
    try {
      const manifest = identifyPack(fx.packDir, { id: 'packrel-hashshared' }, {}).manifest;
      assert.ok(manifest.some((m) => m.path === 'kits/_shared.js'), `共享辅助文件必须在哈希里：${manifest.map((m) => m.path).join(', ')}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});
