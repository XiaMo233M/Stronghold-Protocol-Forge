// test/modRoutes.test.js — 包声明的**只读 HTTP 路由**（`pack.json.routes`，DESIGN §28.13，docs/WORKSHOP.md §1.9；
// A 段只认下声明，B1 段把服务面落地）。
//
// 这一层的载重是「刻意窄」四个字，所以断言也只围绕窄：
//   * **命中**：只有**精确等于**声明路径的请求被回答，内容就是包内那个 `.json`，`Cache-Control` 按声明给；
//   * **未命中**：照旧走核心静态挂载（于是普通 404），不会因为「包声明过别的路径」而改变任何既有行为；
//   * **只读**：没有写路径（routes.js 早就把非 GET/HEAD 挡成 405）、不做目录列表、不做任何重写；
//   * **只 `.json`**：`.js` / `.html` 在服务面**再拒一次**（形状层拒过，但这一层读到的声明可能来自旧 schema 或
//     手工构造的装载结果 —— 代码执行面这条线不许只靠上游把关）；
//   * **路径越不出去**：声明里带 `..`、解析后逃出包目录、以及请求侧的编码穿越，全部拒绝，而且拒绝的方式是
//     「没有这个 key」/「403」，不是「拼出一条包外路径然后读它」。
//
// Run: node --test test/modRoutes.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { ROUTE_CACHE_POLICIES } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { workshopRoutesFor, ROUTE_CACHE_HEADERS } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let tmp;
let wsRoot;

const MANIFEST = JSON.stringify({ version: 'v1', files: [{ url: '/a', sha256: 'a'.repeat(64) }] });
const NOSTORE = JSON.stringify({ n: 1 });
const PUBLIC = JSON.stringify({ p: 1 });

/** 三份包：一份声明三条路由（三种 cache），一份抢占一条**核心路径**，一份不带任何 content。 */
const PACKS = {
  'manifest-pack': {
    pack: {
      name: 'Manifest',
      routes: [
        { path: '/data/resource-manifest.json', file: 'resource-manifest.json', cache: 'no-cache' },
        { path: '/sp-nostore.json', file: 'n.json', cache: 'no-store' },
        { path: '/sp-public.json', file: 'p.json', cache: 'public' },
      ],
    },
    files: { 'resource-manifest.json': MANIFEST, 'n.json': NOSTORE, 'p.json': PUBLIC },
  },
  'core-claim': {
    pack: { name: 'CoreClaim', routes: [{ path: '/data/support.json', file: 'support.json', cache: 'no-store' }] },
    files: { 'support.json': JSON.stringify({ from: 'the pack' }) },
  },
};

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modroutes-'));
  wsRoot = join(tmp, 'ws');
  for (const [id, pack] of Object.entries(PACKS)) {
    const dir = join(wsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id, version: '0.1.0', license: 'CC0-1.0', ...pack.pack }));
    for (const [rel, body] of Object.entries(pack.files)) fs.writeFileSync(join(dir, rel), body);
  }
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** 一个手工构造的装载结果（服务面必须自己判，不能假设形状层已经把坏的挡住了）。 */
const fakeLoaded = (routes, dir = wsRoot) => ({ packs: [{ id: 'hand', dir, routes }] });

// ---------------------------------------------------------------------------------------------------
// 1. 服务面自己的判据（workshopRoutesFor）
// ---------------------------------------------------------------------------------------------------
describe('routes: 服务面自己的判据（只读 / 只 .json / 越不出去）', () => {
  test('声明合法：绝对路径 → 包内文件，cache 缺省 no-cache，三种语义都有对应的 Cache-Control', () => {
    const { routes, errors } = workshopRoutesFor(loadWorkshop(wsRoot, { log: quiet }), wsRoot, { log: quiet });
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.deepEqual([...routes.keys()].sort(), ['/data/resource-manifest.json', '/data/support.json', '/sp-nostore.json', '/sp-public.json']);
    const m = routes.get('/data/resource-manifest.json');
    assert.equal(m.file, join(wsRoot, 'manifest-pack', 'resource-manifest.json'));
    assert.equal(m.cache, 'no-cache');
    assert.equal(m.pack, 'manifest-pack');
    assert.equal(routes.get('/sp-nostore.json').cache, 'no-store');
    assert.equal(routes.get('/sp-public.json').cache, 'public');
    // 三种语义就是三种，与 shared/workshop.js 那份闭枚举一一对应
    assert.deepEqual(Object.keys(ROUTE_CACHE_HEADERS).sort(), [...ROUTE_CACHE_POLICIES].sort());
    assert.deepEqual(ROUTE_CACHE_POLICIES, ['no-cache', 'no-store', 'public']);
    assert.equal(ROUTE_CACHE_HEADERS.public, 'public, max-age=86400');
  });

  test('`.js` / `.html` 在服务面再拒一次（不是「形状层拒过就算」）', () => {
    const cases = [
      [{ path: '/a.js', file: 'a.js' }, 'code'],
      [{ path: '/a.html', file: 'a.html' }, 'markup'],
      [{ path: '/a.json', file: 'sub/../a.js' }, 'traversal into code'],
    ];
    for (const [route, why] of cases) {
      const { routes, errors } = workshopRoutesFor(fakeLoaded([route]), wsRoot, { log: quiet });
      assert.equal(routes.size, 0, `${why}: 不得进路由表`);
      assert.equal(errors.length, 1);
      assert.match(errors[0].reason, /never serves code or markup|outside the pack/);
    }
  });

  test('路径越界：相对路径、`..`、包外解析一律拒绝', () => {
    const bad = [
      { path: 'data/a.json', file: 'a.json' },              // 不是绝对路径
      { path: '/../a.json', file: 'a.json' },               // path 里有 ..
      { path: '/a.json', file: '../a.json' },               // file 里有 ..
      { path: '/a.json', file: '/etc/a.json' },             // file 是绝对路径
      { path: '/a\\b.json', file: 'a.json' },               // 反斜杠
    ];
    for (const route of bad) {
      const { routes, errors } = workshopRoutesFor(fakeLoaded([route]), wsRoot, { log: quiet });
      assert.equal(routes.size, 0, JSON.stringify(route));
      assert.equal(errors.length, 1, JSON.stringify(route));
    }
    // 一个**能解析出包内相对路径**但逃出包目录的 file（`sub/../../x.json` 这类拼法已经在上面的 `..` 里被拒了，
    // 这里再钉一条控制：正常写法必须落回包内）
    const inside = workshopRoutesFor(fakeLoaded([{ path: '/ok.json', file: 'sub/ok.json' }]), wsRoot, { log: quiet });
    assert.equal(inside.routes.get('/ok.json').file, join(wsRoot, 'sub', 'ok.json'));
  });

  test('两个包声明同一条路径：包 id 小的赢，输的那条被报告（DESIGN §28.3）', () => {
    const loaded = { packs: [
      { id: 'zeta', dir: join(wsRoot, 'manifest-pack'), routes: [{ path: '/x.json', file: 'resource-manifest.json' }] },
      { id: 'alpha', dir: join(wsRoot, 'core-claim'), routes: [{ path: '/x.json', file: 'support.json' }] },
    ] };
    const { routes, errors } = workshopRoutesFor(loaded, wsRoot, { log: quiet });
    assert.equal(routes.get('/x.json').pack, 'alpha', '小 id 赢（与数据叠加 / kit 碰撞同一条规则）');
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /already declared by pack "alpha"/);
  });

  test('文件不在时路由**留在表里**（于是 404，而不是悄悄回落到同名核心文件）+ 一条报告', () => {
    const { routes, errors } = workshopRoutesFor(fakeLoaded([{ path: '/data/chess.json', file: 'gone.json' }]), wsRoot, { log: quiet });
    assert.ok(routes.has('/data/chess.json'), '声明的路径必须在表里 —— 否则它会回落到核心的 /data/chess.json');
    assert.equal(routes.get('/data/chess.json').file, join(wsRoot, 'gone.json'));
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /declared in pack\.json but missing/);
  });

  test('没有包 / 关掉工坊（workshopDir null）时是空表', () => {
    assert.equal(workshopRoutesFor(null, wsRoot).routes.size, 0);
    assert.equal(workshopRoutesFor(loadWorkshop(wsRoot, { log: quiet }), null).routes.size, 0);
    assert.equal(workshopRoutesFor(loadWorkshop(wsRoot, { log: quiet }), '').routes.size, 0);
  });

  test('routes 不是数组的装载结果被忽略（不抛）', () => {
    const { routes, errors } = workshopRoutesFor({ packs: [{ id: 'x', dir: wsRoot, routes: 'nope' }] }, wsRoot, { log: quiet });
    assert.equal(routes.size, 0);
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 真 HTTP：命中 / 未命中 / cache 头 / 穿越 / 只读
// ---------------------------------------------------------------------------------------------------
describe('routes: 真 HTTP 服务面', () => {
  test('命中声明路径、Cache-Control 按声明、未命中照旧 404、穿越拿不到包外文件', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    const get = (p) => fetch(`${srv.url}${p}`);
    try {
      // 命中：no-cache（缺省）
      const m = await get('/data/resource-manifest.json');
      assert.equal(m.status, 200);
      assert.equal(m.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(m.headers.get('cache-control'), 'no-cache');
      assert.deepEqual(await m.json(), JSON.parse(MANIFEST));
      // 三种语义各一条
      const n = await get('/sp-nostore.json');
      assert.equal(n.status, 200);
      assert.equal(n.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await n.json(), JSON.parse(NOSTORE));
      const p = await get('/sp-public.json');
      assert.equal(p.status, 200);
      assert.equal(p.headers.get('cache-control'), 'public, max-age=86400');
      assert.deepEqual(await p.json(), JSON.parse(PUBLIC));
      // HEAD 也走这条路（只回头，不读体）
      const head = await fetch(`${srv.url}/sp-public.json`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');

      // 未命中：包声明过别的路径不改变任何既有行为（核心静态挂载照旧）
      assert.equal((await get('/sp-not-declared.json')).status, 404);
      assert.equal((await get('/sp-not-declared.js')).status, 404);
      assert.equal((await get('/data/nope.json')).status, 404);

      // 声明的路径没有文件 ⇒ 404（而不是回落到核心同名文件）
      const claimed = await get('/data/support.json');
      assert.equal(claimed.status, 200, '这条路径有文件，所以是包的文件');
      assert.deepEqual(await claimed.json(), { from: 'the pack' });

      // 穿越：编码过的 `..` 解出来还是 `..`，但没有那样的声明路径 ⇒ 落到核心静态层被拒
      for (const path of ['/data/../manifest-pack/pack.json', '/%2e%2e/%2e%2e/etc/passwd', '/data/%2e%2e/manifest-pack/pack.json']) {
        const res = await fetch(`${srv.url}${path}`);
        assert.notEqual(res.status, 200, `${path} 不得被服务`);
        assert.equal(String(await res.text()).includes('"name":"Manifest"'), false, `${path} 不得读到包清单`);
      }
      // 请求侧想直接读包里的文件：pack.json 不在任何声明路径上，核心挂载也到不了 workshop/
      const direct = await get('/manifest-pack/pack.json');
      assert.equal(direct.status, 404);

      // 只读：没有写路径（routes.js 把非 GET/HEAD 挡成 405）
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${srv.url}/data/resource-manifest.json`, { method });
        assert.equal(res.status, 405, method);
        assert.equal(res.headers.get('allow'), 'GET, HEAD');
      }
    } finally {
      await srv.close();
    }
  });

  test('关掉工坊（workshopDir: null）时没有任何声明路由，路径回到核心静态行为', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: null });
    try {
      assert.equal((await fetch(`${srv.url}/data/resource-manifest.json`)).status, 404);
      assert.equal((await fetch(`${srv.url}/sp-public.json`)).status, 404);
    } finally {
      await srv.close();
    }
  });

  test('声明的路径抢占核心同名文件时，服务的是包的文件（有意为之：声明过的路径就是声明过的）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const res = await fetch(`${srv.url}/data/support.json`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { from: 'the pack' });
      const official = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'support.json'), 'utf8'));
      assert.notDeepEqual(JSON.parse(fs.readFileSync(join(wsRoot, 'core-claim', 'support.json'), 'utf8')), official);
    } finally {
      await srv.close();
    }
  });

  test('拒绝码与 A 段同名：`routes` 的形状层判罚一字未改', () => {
    // 这一条只是把「B1 段没有放松 A 段的判罚」钉在路由这一组上（形状层的完整用例表在 test/packAssets.test.js）
    const bad = [
      [{ path: '/a.json', file: 'a.js' }, 'ROUTE_BAD_FILE'],
      [{ path: '/a.json', file: 'a.json', cache: 'forever' }, 'ROUTE_BAD_CACHE'],
      [{ path: 'data/a.json', file: 'a.json' }, 'ROUTE_BAD_PATH'],
    ];
    for (const [route, code] of bad) {
      const root = join(tmp, `shape-${code}`);
      const dir = join(root, 'shape');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id: 'shape', license: 'CC0-1.0', routes: [route] }));
      const loaded = loadWorkshop(root, { log: quiet });
      assert.equal(loaded.packs.length, 0, `${code}: 包整体被拒`);
      assert.equal(loaded.errors.length, 1, JSON.stringify(loaded.errors));
      assert.match(loaded.errors[0].reason, new RegExp(`^${code}:`), loaded.errors[0].reason);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
