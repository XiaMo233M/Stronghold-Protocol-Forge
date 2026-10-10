// test/modAssets.test.js — `assets` 声明的**服务端行为**（B3a 段：DESIGN §28.13.3/§28.13.4，
// docs/WORKSHOP.md §1.9.4）与**客户端资源流程**（B4 段：DESIGN §28.13.5）。A 段只认下声明（形状层，
// `test/packAssets.test.js` 钉住），B3a 把服务端那一半落地：
//
//   容器与清单 —— `assets.container`（包内 `.spresources`）与 `assets.manifest`（包内 `.json`）在
//                `/workshop-resources/<pack>/<声明路径>` 上被服务。纪律照 B2 的模块路由：**只有装载器注册过的 URL**
//                会被回答，未注册 / 目录穿越 / 不在声明里 ⇒ 404；`?v=<hash12>` 是缓存键。容器可达数百 MB，所以它
//                **流式**出去（`fs.createReadStream` + `pipeline`），绝不整读进内存。
//   `serverPolicy` —— `serve`（缺省）= 今天的服务器行为一个字节不变；`cache-only` = `/assets/` 与 `/fonts/` 回
//                **412 且不回源**，而且**只在包显式声明时**生效。它是部署语义（那两棵树是全服务器共用的），所以是
//                进程级的，启动日志里点名是哪个包声明的。
//   `verify`    —— 按声明校验容器（旁挂 `<container>.sha256`，`sha256` 是缺省算法）。校验失败**明示**：整包被拒，
//                理由里点名 `ASSETS_VERIFY_FAILED`（摘要对不上）或 `ASSETS_VERIFY_UNAVAILABLE`（声明了校验却没有
//                摘要文件）—— 绝不静默放行。
//
// 外加 B1 留下的口子（B3a 补齐并对齐）：`server.preDispatch` 以前只拒那个钩子、包照旧加载，现在与 `client` /
// `assets` 同一口径 —— **声明了却不可用 ⇒ 拒绝整个包**（DESIGN §28.13.3）。
//
// B4 段在这份文件里补上四块（都是能在这台机器上**真跑**的纯逻辑）：
//   * **SW 与客户端流程**：`public/resource-sw.js` + `public/js/resources/**` 由引擎自带（业主裁决：引擎自带 SW、
//     包只声明）。容器的解析/逐文件校验/写缓存/深浅校验在 Node 里**真的跑**（假的 `CacheStorage`，真的 `Response`
//     / `crypto.subtle`），并且与 `tools/spresources.mjs` 的 Node 解析器在**同一批字节**上给出同一个结果。
//   * **`welcome.modAssets` 的条件性**：只有包声明了 `assets` 才多这个字段（与 `modPanels` 同构）。
//   * **容器摘要进身份**：装载期与字节核对过的 `assetsDigest` 进包的内容哈希 ⇒「同一个房间摘要 = 同一份容器」；
//     没声明 `assets` 的包逐字节不变。
//   * **`server.preDispatch` 的最后一格**：只有 import 才知道的两种失败（模块装不上 / 没有工厂导出）由启动装配
//     路径上的 `dropUnavailablePreDispatchPacks` 裁剪并点名 —— 声明了闸门却没有闸门不再是一个能通过的结局。
//
// Run: node --test test/modAssets.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { WORKSHOP_RESOURCE_PREFIX, ASSETS_FILE_CODES } from '../shared/workshop.js';
import { MEDIA_PREFIX as SHARED_MEDIA_PREFIX, AUDIO_EXTS as SHARED_AUDIO_EXTS } from '../shared/media.js';
import { modSetOf } from '../shared/modIdentity.js';
import {
  loadWorkshop, loadWorkshopHooks, assetsIssues, preDispatchIssues, sha256FileSync,
  identifyPack, dropUnavailablePreDispatchPacks, ASSETS_DIGEST_PATH,
} from '../server/workshop.js';
import { workshopResourceFilesFor, workshopModAssetsFrom, isCacheOnlyPath, resourceServerPolicy } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';
import { parsePack, buildPack, sha1_12, computeVersion } from '../tools/spresources.mjs';
import { makePack } from '../tools/make-spresources.mjs';
// 客户端资源流程（引擎自带）：这几个模块在 Node 下**真跑** —— 它们只依赖 URL / MIME / Cache Storage / WebCrypto
// 这几件标准件（`caches` 由本文件给一个假的，其余用 Node 自己的 `Response` / `crypto.subtle`）。
import {
  CACHE_NAME, indexUrl, receiptUrl, absoluteUrl, MEDIA_PREFIX, AUDIO_EXTS,
  validateManifest, mediaCandidates, isResourcePath, isResourceUrl, rangeResponse,
} from '../public/js/resources/common.js';
import {
  importResourcePack, fetchManifest, fetchContainer, importedReceipt, revokeImport, sha256, computeManifestVersion,
} from '../public/js/resources/bundle.js';
import { verifyImportedResources, verifyContainerBytes } from '../public/js/resources/verify.js';
import { handleResourceRequest } from '../public/js/resources/service.js';
import {
  installModAssets, modAssetsFor, modAssetDeclarations, normalizeModAsset, importAndVerify, importStateFor,
  WORKSHOP_RESOURCE_PREFIX as CLIENT_RESOURCE_PREFIX,
} from '../public/js/resources/host.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** `docs/examples/` 是仓库里既有的**真实**工坊根（三份示例包，一份都没声明 `assets`）：不变量对照的基线。 */
const EXAMPLES = join(ROOT, 'docs/examples');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const CONT = 'packs/resources-0.1.0.spresources';
const MANIFEST = 'resource-manifest.json';
/** 容器的字节：不解析内容（服务端只把它当字节流），但让它是**一段可辨认的**东西，便于断言 200 的 body。 */
const CONT_BYTES = Buffer.concat([
  Buffer.from('SPRES001', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('{"format":"sp-resource-pack","version":1}', 'utf8'),
  Buffer.alloc(300 * 1024, 0x5a), // 300 KiB：够大到「整读进内存」这件事会在下面被看见
]);
const MANIFEST_BODY = JSON.stringify({ format: 1, version: 'deadbeefcafe', files: [
  { url: '/assets/demo-0.bin', size: 2048, hash: '26ad4b31297b', tier: 2 },
] });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SIDECAR = `${sha(CONT_BYTES)}  resources-0.1.0.spresources\n`;
const CONT_SHA = sha(CONT_BYTES);

/** 一个合法的准入钩子（对齐后它只是「合法」的那一半，用来证明好声明照旧生效）。 */
const HOOK_SOURCE = `export function createPreDispatch() { return { preDispatch() { return false; } }; }\n`;

let tmp;
let wsRoot;

/**
 * 写一个工坊包：`pack.json` + `extra` 里的文件。`assets: false` 表示不声明。
 * @returns {string} 包的目录
 */
function writePack(root, id, { assets = null, server = null, routes = null, content = null, extra = {} } = {}) {
  const dir = join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const decl = {};
  if (assets) decl.assets = assets;
  if (server) decl.server = server;
  if (routes) decl.routes = routes;
  const pack = { id, version: '0.1.0', license: 'CC0-1.0', ...(content ? { content } : {}), ...decl };
  fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify(pack));
  for (const [rel, body] of Object.entries(extra)) {
    const abs = join(dir, ...rel.split('/'));
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const DECL = { container: CONT, manifest: MANIFEST };
const BASE_FILES = { [CONT]: CONT_BYTES, [`${CONT}.sha256`]: SIDECAR, [MANIFEST]: MANIFEST_BODY };

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-modassets-'));
  wsRoot = join(tmp, 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });
  // `resource-pack`：`serve`（缺省值写出来）—— 容器与清单都可取
  writePack(wsRoot, 'resource-pack', { assets: DECL, extra: BASE_FILES });
  // `cache-pack`：同一个声明 + `cache-only`
  writePack(wsRoot, 'cache-pack', { assets: { ...DECL, serverPolicy: 'cache-only' }, extra: BASE_FILES });
  // `serve-explicit`：显式 `serve`（对照组：声明了 `assets` 但不要求 412）
  writePack(wsRoot, 'serve-explicit', { assets: { ...DECL, serverPolicy: 'serve' }, extra: BASE_FILES });
  // 不声明 `assets` 的普通数据包（对照组的另一半）
  writePack(wsRoot, 'plain-pack', { content: ['chess'], extra: { 'chess.json': JSON.stringify({ chess_ws_plain_a: { chessId: 'chess_ws_plain_a', name: 'p' } }) } });
  // 坏摘要：旁挂写的是另一份文件的摘要
  writePack(wsRoot, 'bad-digest', { assets: { container: 'c.spresources', manifest: 'm.json' }, extra: { 'c.spresources': CONT_BYTES, 'c.spresources.sha256': `${sha(Buffer.from('other'))}  c.spresources\n`, 'm.json': MANIFEST_BODY } });
  // 声明了校验却没有摘要文件
  writePack(wsRoot, 'no-sidecar', { assets: { container: 'c.spresources', manifest: 'm.json' }, extra: { 'c.spresources': CONT_BYTES, 'm.json': MANIFEST_BODY } });
  // 容器文件不在包里
  writePack(wsRoot, 'no-container', { assets: { container: 'gone.spresources', manifest: 'm.json' }, extra: { 'm.json': MANIFEST_BODY } });
  // 清单文件不在包里
  writePack(wsRoot, 'no-manifest', { assets: { container: 'c.spresources', manifest: 'gone.json' }, extra: { 'c.spresources': CONT_BYTES, 'c.spresources.sha256': SIDECAR } });
  // `server.preDispatch` 的对齐用例：文件不在 ⇒ 整包被拒（B1 以前只是「钩子被拒」）
  writePack(wsRoot, 'hook-missing-module', { server: { preDispatch: { module: 'server/gone.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'p.json': '{}' } });
  writePack(wsRoot, 'hook-missing-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'gone.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE } });
  writePack(wsRoot, 'hook-bad-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '[1,2,3]' } });
  writePack(wsRoot, 'hook-unknown-type', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['match.queue'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
  // 好声明（对照组）+ 一个既声明 assets 又声明 hooks 的包（两组闸门互不干扰）
  writePack(wsRoot, 'hook-ok', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{"version":"v1"}' } });
});

after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------
// 1. 不变量：不声明 `assets` ⇒ 服务器行为逐字节不变
// ---------------------------------------------------------------------------------------------------
describe('不声明 assets：没有新路由、没有新头、没有新分支', () => {
  test('真实夹具（docs/examples 三份示例包）装载后没有任何资源表，也没有 412 策略', () => {
    const loaded = loadWorkshop(EXAMPLES, { log: quiet });
    assert.deepEqual(loaded.errors, [], '三份示例包必须都加载成功');
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), ['clementia', 'demo-workshop', 'kit-demo']);
    for (const p of loaded.packs) {
      assert.equal('assets' in p, false, `${p.id}: 没声明就不该有 assets 键`);
      assert.equal('assetsDigest' in p, false, `${p.id}: 没声明就不该有容器摘要`);
    }
    assert.equal(workshopResourceFilesFor(loaded.packs, EXAMPLES).size, 0);
    assert.equal(resourceServerPolicy(new Map(), { log: quiet }), 'serve');
  });

  test('真服务器：`/workshop-resources/` 一个字节都不服务（404），`/assets` 也不回 412', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    try {
      for (const p of [
        WORKSHOP_RESOURCE_PREFIX,
        `${WORKSHOP_RESOURCE_PREFIX}clementia/`,
        `${WORKSHOP_RESOURCE_PREFIX}clementia/packs/x.spresources`,
        `${WORKSHOP_RESOURCE_PREFIX}demo-workshop/resource-manifest.json`,
      ]) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
      // 没有包声明 `cache-only` ⇒ `/assets/` 的行为与 B2 之后完全相同（本机通常没有 public/assets/<name>，
      // 所以这里断言的是**不是 412**：412 只可能由本刀的开关产生，缺文件是 404）。
      const miss = await fetch(`${srv.url}/assets/definitely-not-here-${Date.now()}.png`);
      assert.notEqual(miss.status, 412, '/assets 不得因为本刀变成 412');
      assert.equal((await fetch(`${srv.url}/fonts/definitely-not-here.css`)).status === 412, false);
    } finally {
      await srv.close();
    }
  });

  test('不声明 `assets` 的包：`loadWorkshop` 的结果里一个字段都不多（与 `plain-pack` 对照）', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const plain = loaded.packs.find((p) => p.id === 'plain-pack');
    assert.ok(plain);
    assert.equal('assets' in plain, false);
    assert.equal('assetsDigest' in plain, false);
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 容器与清单：注册 URL 可服务、`?v=` 生效、穿越 / 未注册 ⇒ 404、大文件不整读
// ---------------------------------------------------------------------------------------------------
describe('容器与清单的服务（包作用域路由，照 B2 的纪律）', () => {
  test('服务表：只有声明过的那两个 URL，键是**不带查询串**的路径，且容器带装载期算出的摘要', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const digests = new Map(loaded.packs.filter((p) => p.assetsDigest).map((p) => [p.id, p.assetsDigest]));
    const files = workshopResourceFilesFor(loaded.packs, wsRoot, { digests });
    // 五个声明了 assets 且容器摘要正确的包（resource-pack / cache-pack / serve-explicit 各两个 URL）
    for (const id of ['resource-pack', 'cache-pack', 'serve-explicit']) {
      const cont = files.get(`${WORKSHOP_RESOURCE_PREFIX}${id}/${CONT}`);
      const man = files.get(`${WORKSHOP_RESOURCE_PREFIX}${id}/${MANIFEST}`);
      assert.ok(cont, `${id}: 容器必须注册`);
      assert.ok(man, `${id}: 清单必须注册`);
      assert.equal(cont.kind, 'container');
      assert.equal(man.kind, 'manifest');
      assert.equal(cont.sha256, CONT_SHA, '容器条目的摘要是装载期校验过的那个（不重算）');
      assert.equal(man.sha256, null, '清单没有整包摘要');
      assert.equal(cont.url, `${WORKSHOP_RESOURCE_PREFIX}${id}/${CONT}?v=${loaded.packs.find((p) => p.id === id).hash.slice(0, 12)}`);
    }
    // 未声明的路径不进表：`pack.json`、`kits/…`、`assets/…`、别的包的文件
    for (const url of [
      `${WORKSHOP_RESOURCE_PREFIX}plain-pack/${CONT}`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/pack.json`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/${CONT}.sha256`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/assets/x.png`,
      `${WORKSHOP_RESOURCE_PREFIX}resource-pack/../plain-pack/pack.json`,
    ]) {
      assert.equal(files.has(url), false, url);
    }
    assert.equal(workshopResourceFilesFor(loaded.packs, null).size, 0, '关掉工坊就是空表');
    assert.equal(workshopResourceFilesFor(null, wsRoot).size, 0);
  });

  test('真 HTTP：容器与清单都 200，`?v=` 只是缓存键（带与不带同一个 body）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const base = `${srv.url}${WORKSHOP_RESOURCE_PREFIX}resource-pack`;
      const cont = await fetch(`${base}/${CONT}?v=abcdef123456`);
      assert.equal(cont.status, 200);
      assert.equal(cont.headers.get('content-type'), 'application/octet-stream');
      assert.equal(cont.headers.get('cache-control'), 'no-cache');
      assert.equal(cont.headers.get('x-sp-resource-sha256'), CONT_SHA, 'HTTP 头带的就是装载期校验过的摘要');
      assert.equal(Number(cont.headers.get('content-length')), CONT_BYTES.length);
      assert.deepEqual(Buffer.from(await cont.arrayBuffer()), CONT_BYTES, '字节逐字节相同');
      // 不带 `?v=` 也拿同一份（`?v=` 是缓存键，不是路由的一部分）
      const bare = await fetch(`${base}/${CONT}`);
      assert.equal(bare.status, 200);
      assert.deepEqual(Buffer.from(await bare.arrayBuffer()), CONT_BYTES);
      // HEAD：有头、无 body
      const head = await fetch(`${base}/${CONT}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      // 清单：`.json` 的 Content-Type，body 就是文件字节
      const man = await fetch(`${base}/${MANIFEST}?v=abcdef123456`);
      assert.equal(man.status, 200);
      assert.equal(man.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(await man.text(), MANIFEST_BODY);
      assert.equal(man.headers.get('x-sp-resource-sha256'), null, '清单不该带容器摘要头');
    } finally {
      await srv.close();
    }
  });

  test('真 HTTP：未注册 / 穿越 / 摘要文件 / 别的包 / 包清单一律 404', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      for (const p of [
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/pack.json`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/${CONT}.sha256`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/not-declared.json`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/../plain-pack/pack.json`,
        `${WORKSHOP_RESOURCE_PREFIX}plain-pack/${CONT}`,
        `${WORKSHOP_RESOURCE_PREFIX}`,
        `${WORKSHOP_RESOURCE_PREFIX}resource-pack/`,
      ]) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
    } finally {
      await srv.close();
    }
  });

  test('大文件不整读：容器走 `fs.createReadStream`（而不是整读进内存）', async () => {
    const origStream = fs.createReadStream;
    /** @type {string[]} */
    const streamed = [];
    // 真实容器可达数百 MB：一次把整个包读进内存就是这条路由唯一不能犯的错。插桩打在 `fs.createReadStream` 上
    // （`server/http/static.js` 用的是 `import fs from 'node:fs'` 的活绑定），断言容器**确实**经流式送出。
    fs.createReadStream = function patched(...args) { streamed.push(String(args[0])); return origStream.apply(this, args); };
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const url = `${srv.url}${WORKSHOP_RESOURCE_PREFIX}resource-pack/${CONT}`;
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, CONT_BYTES.length);
      assert.deepEqual(body, CONT_BYTES, '流式送出的字节与文件逐字节相同');
      const abs = join(wsRoot, 'resource-pack', CONT);
      // 插桩是全局的（同一进程里别的请求也会调用它），所以只断言**这一个文件**是否出现在流式调用里。
      assert.ok(streamed.includes(abs), `容器必须经 fs.createReadStream 送出（实际：${streamed.join(', ')}）`);
    } finally {
      fs.createReadStream = origStream;
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. `serverPolicy`：`serve` 缺省不变，`cache-only` 只在显式声明时生效
// ---------------------------------------------------------------------------------------------------
describe('serverPolicy：serve（默认）不变，cache-only 只在声明时生效', () => {
  test('`isCacheOnlyPath` 覆盖 `/assets`、`/fonts` 两棵树（含裸挂载），不碰别的', () => {
    for (const p of ['/assets', '/assets/', '/assets/x.png', '/assets/a/b/c.js', '/fonts', '/fonts/x.woff2']) {
      assert.equal(isCacheOnlyPath(p), true, p);
    }
    for (const p of ['/asset', '/assetsx', '/media/bgm/act1', '/data/chess.json', '/workshop-assets/p/a.png', '/', '/workshop-resources/p/x']) {
      assert.equal(isCacheOnlyPath(p), false, p);
    }
  });

  test('求解进程策略：没有任何声明 ⇒ serve；一个 cache-only ⇒ cache-only 并点名是哪个包', () => {
    const seen = [];
    const log = { info: (...a) => seen.push(a[0]), warn() {}, error() {}, debug() {} };
    assert.equal(resourceServerPolicy(new Map([['a', 'serve'], ['b', 'serve']]), { log }), 'serve');
    assert.equal(resourceServerPolicy({ a: 'serve' }), 'serve');
    assert.equal(resourceServerPolicy(null), 'serve');
    assert.deepEqual(seen, [], '全是 serve 时一行日志都不该有');
    assert.equal(resourceServerPolicy(new Map([['a', 'serve'], ['z', 'cache-only'], ['b', 'cache-only']]), { log }), 'cache-only');
    assert.equal(seen.length, 1, '翻成 cache-only 必须有且只有一条启动日志');
    assert.match(seen[0], /cache-only/);
    assert.match(seen[0], /"b", "z"/, '日志点名是哪些包声明的（排序后）');
  });

  test('真服务器：声明 `cache-only` ⇒ `/assets/…` 与 `/fonts/…` 412，且短路在文件系统之前', async () => {
    // 用**本机真的存在**的两份素材做对照（`tools/fetch-assets.mjs` 的产物，git-ignored；本机没有就跳过）：
    // 它们平时是 200，声明 `cache-only` 之后必须变成 412 —— 这是「不回源」最直接的证据：走文件系统就只能是
    // 200 或 404（缺文件），绝不可能是 412。412 只可能由本刀那个分支产生。
    const BGM = '/assets/audio/bgm/m_bat_abyssalhunters_intro.mp3';
    const FONT = '/fonts/bender-regular.woff2';
    const haveBgm = fs.existsSync(join(ROOT, 'public', ...BGM.split('/').filter(Boolean)));
    const haveFont = fs.existsSync(join(ROOT, 'public', ...FONT.split('/').filter(Boolean)));
    assert.ok(haveBgm && haveFont, '本机素材缺失（tools/fetch-assets.mjs 的产物），这份对照跑不了');
    const serveSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    const cacheSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      // 对照组：没有 `cache-only` 时它们是 200（本机真的有这两份文件）
      assert.equal((await fetch(serveSrv.url + BGM, { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(serveSrv.url + FONT, { method: 'HEAD' })).status, 200);
      for (const p of [BGM, FONT, '/assets/x.png', '/assets/', '/assets', '/fonts/x.woff2', '/fonts']) {
        const res = await fetch(cacheSrv.url + p);
        assert.equal(res.status, 412, p);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }
      // 别的路由完全不受影响
      assert.equal((await fetch(`${cacheSrv.url}/data/chess.json`)).status, 200);
      assert.equal((await fetch(`${cacheSrv.url}/healthz`)).status, 200);
    } finally {
      await serveSrv.close();
      await cacheSrv.close();
    }
  });

  test('真服务器：只有显式 `serve` 的包 ⇒ `/assets/…` 不 412（缺文件是 404，不是策略）', async () => {
    const serveOnly = join(tmp, 'ws-serve-only');
    writePack(serveOnly, 'resource-pack', { assets: { ...DECL, serverPolicy: 'serve' }, extra: BASE_FILES });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: serveOnly });
    try {
      const res = await fetch(`${srv.url}/assets/definitely-not-here-${Date.now()}.png`);
      assert.notEqual(res.status, 412);
      assert.equal(res.status, 404);
      assert.equal((await fetch(`${srv.url}/fonts/nope.woff2`)).status !== 412, true);
    } finally {
      await srv.close();
    }
  });

  test('`plain-pack`（不声明 assets）与 `cache-only` 包同时装着：策略是进程级的，日志点名声明者', async () => {
    const ws = join(tmp, 'ws-two');
    writePack(ws, 'a-plain', { content: ['chess'], extra: { 'chess.json': JSON.stringify({ chess_ws_a: { chessId: 'chess_ws_a', name: 'a' } }) } });
    writePack(ws, 'z-cache', { assets: { ...DECL, serverPolicy: 'cache-only' }, extra: BASE_FILES });
    const lines = [];
    const log = { info: (...a) => lines.push(a[0]), warn() {}, error() {}, debug() {} };
    const loaded = loadWorkshop(ws, { log: quiet });
    const policy = resourceServerPolicy(new Map(loaded.packs.filter((p) => p.assets).map((p) => [p.id, p.assets.serverPolicy])), { log });
    assert.equal(policy, 'cache-only');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"z-cache"/);
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws });
    try {
      assert.equal((await fetch(`${srv.url}/assets/x.png`)).status, 412, '一个包声明就够改变整个服务器的 /assets');
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. `verify`：校验失败明示（点名拒绝码），绝不静默放行
// ---------------------------------------------------------------------------------------------------
describe('verify：按声明校验容器，失败点名', () => {
  test('摘要对得上 ⇒ 无 issue，并把摘要交出来（服务面不重算）', () => {
    const dir = join(wsRoot, 'resource-pack');
    const r = assetsIssues({ assets: { ...DECL, serverPolicy: 'serve', verify: 'sha256' } }, dir);
    assert.deepEqual(r.issues, []);
    assert.equal(r.digest, CONT_SHA);
    assert.equal(r.containerAbs, join(dir, CONT));
    assert.equal(r.manifestAbs, join(dir, MANIFEST));
    assert.equal(sha256FileSync(join(dir, CONT)), CONT_SHA, '流式摘要与一次性摘要同值');
  });

  test('摘要对不上 ⇒ `ASSETS_VERIFY_FAILED`（不是静默放行），且带出两个值', () => {
    const dir = join(wsRoot, 'bad-digest');
    const r = assetsIssues({ assets: { container: 'c.spresources', manifest: 'm.json', serverPolicy: 'serve', verify: 'sha256' } }, dir);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].code, ASSETS_FILE_CODES.VERIFY_FAILED);
    assert.match(r.issues[0].reason, /does not match/i);
    assert.match(r.issues[0].reason, new RegExp(CONT_SHA), '理由里要能看出文件真实的摘要');
    assert.equal(r.digest, null, '没通过校验就没有可交出去的摘要');
  });

  test('声明了校验却没有旁挂摘要 ⇒ `ASSETS_VERIFY_UNAVAILABLE`（与「对不上」是两个不同的回答）', () => {
    const r = assetsIssues({ assets: { container: 'c.spresources', manifest: 'm.json', serverPolicy: 'serve', verify: 'sha256' } }, join(wsRoot, 'no-sidecar'));
    assert.equal(r.issues[0].code, ASSETS_FILE_CODES.VERIFY_UNAVAILABLE);
    assert.match(r.issues[0].reason, /c\.spresources\.sha256/);
  });

  test('容器 / 清单不在包里 ⇒ 沿用形状层的两个码（作者看到的是同一个字段名）', () => {
    const noCont = assetsIssues({ assets: { container: 'gone.spresources', manifest: 'm.json', serverPolicy: 'serve', verify: 'sha256' } }, join(wsRoot, 'no-container'));
    assert.equal(noCont.issues[0].code, ASSETS_FILE_CODES.CONTAINER);
    assert.match(noCont.issues[0].reason, /not a readable file/);
    const noMan = assetsIssues({ assets: { container: 'c.spresources', manifest: 'gone.json', serverPolicy: 'serve', verify: 'sha256' } }, join(wsRoot, 'no-manifest'));
    assert.equal(noMan.issues[0].code, ASSETS_FILE_CODES.MANIFEST);
    // 没声明 / 没目录时什么都不判（不猜路径、不凭空报错）
    assert.deepEqual(assetsIssues({}, wsRoot).issues, []);
    assert.deepEqual(assetsIssues({ assets: DECL }, '').issues, []);
  });

  test('装载期：坏摘要的包**不进 `loaded.packs`**，理由里点名拒绝码', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const listed = loaded.packs.map((p) => p.id);
    for (const id of ['resource-pack', 'cache-pack', 'serve-explicit', 'plain-pack']) {
      assert.ok(listed.includes(id), `${id} 应当加载（${listed.join(',')}）`);
    }
    for (const [id, code] of [
      ['bad-digest', ASSETS_FILE_CODES.VERIFY_FAILED],
      ['no-sidecar', ASSETS_FILE_CODES.VERIFY_UNAVAILABLE],
      ['no-container', ASSETS_FILE_CODES.CONTAINER],
      ['no-manifest', ASSETS_FILE_CODES.MANIFEST],
    ]) {
      assert.equal(listed.includes(id), false, `${id} 不得进 loaded.packs`);
      const err = loaded.errors.find((e) => e.pack === id);
      assert.ok(err, `${id}: 必须有具名错误`);
      assert.match(err.reason, new RegExp(`^${code}: `), err.reason);
    }
  });

  test('真服务器：坏摘要的包不存在，它的 URL 也 404（不是 200 + 坏字节）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      assert.equal((await fetch(`${srv.url}${WORKSHOP_RESOURCE_PREFIX}bad-digest/c.spresources`)).status, 404);
      assert.equal((await fetch(`${srv.url}${WORKSHOP_RESOURCE_PREFIX}no-sidecar/c.spresources`)).status, 404);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. `server.preDispatch` 对齐：声明了却不可用 ⇒ 整包被拒（B1 留下的口子）
// ---------------------------------------------------------------------------------------------------
describe('server.preDispatch 对齐：不可用 ⇒ 拒绝整个包（与 client / assets 同一口径）', () => {
  test('`preDispatchIssues` 五种坏声明各自具名（与形状层同名）', () => {
    const at = (id, pack) => preDispatchIssues(pack, join(wsRoot, id));
    assert.deepEqual(preDispatchIssues({}, wsRoot), []);
    assert.equal(at('hook-missing-module', { server: { preDispatch: { module: 'server/gone.mjs', policy: 'p.json', intercepts: ['room.create'] } } })[0].code, 'PREDISPATCH_BAD_MODULE');
    assert.equal(at('hook-missing-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'gone.json', intercepts: ['room.create'] } } })[0].code, 'PREDISPATCH_BAD_POLICY');
    assert.equal(at('hook-bad-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } } })[0].code, 'PREDISPATCH_BAD_POLICY');
    assert.match(at('hook-bad-policy', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } } })[0].reason, /must be a JSON object/);
    const unknown = at('hook-unknown-type', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['match.queue'] } } });
    assert.equal(unknown[0].code, 'PREDISPATCH_UNKNOWN_TYPE');
    assert.match(unknown[0].reason, /match\.queue/);
    // 路径逃出包：形状层拒过一次，装载期再拒一次（防御纵深）
    const escape = preDispatchIssues({ server: { preDispatch: { module: '../x.mjs', policy: 'p.json', intercepts: ['room.create'] } } }, join(wsRoot, 'hook-ok'));
    assert.equal(escape[0].code, 'PREDISPATCH_BAD_PATH');
    // 注入一份窄协议：名单里的类型在本服务器不存在
    const narrow = { 'room.join': 1 };
    assert.equal(preDispatchIssues({ server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } } }, join(wsRoot, 'hook-ok'), { c2s: narrow })[0].code, 'PREDISPATCH_UNKNOWN_TYPE');
  });

  test('装载期：四种坏声明让整个包不出现，好声明照旧加载', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const listed = loaded.packs.map((p) => p.id);
    assert.ok(listed.includes('hook-ok'), listed.join(','));
    for (const [id, code] of [
      ['hook-missing-module', 'PREDISPATCH_BAD_MODULE'],
      ['hook-missing-policy', 'PREDISPATCH_BAD_POLICY'],
      ['hook-bad-policy', 'PREDISPATCH_BAD_POLICY'],
      ['hook-unknown-type', 'PREDISPATCH_UNKNOWN_TYPE'],
    ]) {
      assert.equal(listed.includes(id), false, `${id} 不得进 loaded.packs（「加载了但能力没生效」是禁止的结局）`);
      assert.match(loaded.errors.find((e) => e.pack === id).reason, new RegExp(`^${code}: `));
    }
  });

  test('回归：一个只声明 `server.preDispatch` 的好包照旧是合法包（这条纪律不是「拒绝一切」）', async () => {
    const ws = join(tmp, 'ws-hook-only');
    writePack(ws, 'hook-only', { server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs.map((p) => p.id), ['hook-only']);
    // 真服务器起来之后钩子是真的装上了（不是「包在、钩子没有」）
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws });
    try {
      assert.equal(srv.lobby.welcomeInfo().mods.packs.length, 1);
    } finally {
      await srv.close();
    }
  });

  test('两组闸门互不干扰：一个包同时声明 assets 与 hooks，两边都过才加载', () => {
    const ws = join(tmp, 'ws-both');
    writePack(ws, 'both-ok', { assets: DECL, server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { ...BASE_FILES, 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
    writePack(ws, 'both-bad-hook', { assets: DECL, server: { preDispatch: { module: 'server/gone.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { ...BASE_FILES, 'p.json': '{}' } });
    writePack(ws, 'both-bad-assets', { assets: { container: 'gone.spresources', manifest: MANIFEST }, server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } }, extra: { [MANIFEST]: MANIFEST_BODY, 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}' } });
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['both-ok']);
    assert.equal(loaded.errors.length, 2);
    assert.match(loaded.errors.find((e) => e.pack === 'both-bad-hook').reason, /^PREDISPATCH_BAD_MODULE: /);
    assert.match(loaded.errors.find((e) => e.pack === 'both-bad-assets').reason, /^ASSETS_BAD_CONTAINER: /);
  });
});

// ---------------------------------------------------------------------------------------------------
// 6. 引擎自带的 SW 与客户端资源流程（B4 段：DESIGN §28.13.5）—— 纯逻辑在 Node 里真跑
// ---------------------------------------------------------------------------------------------------

/** 一个够真的假 `CacheStorage`：`Response` 每次取出都是**克隆**（真缓存也是每次都给你一条新响应，body 只能读一次）。 */
function fakeCaches() {
  /** @type {Map<string, Map<string, Response>>} */
  const stores = new Map();
  return {
    _stores: stores,
    async open(name) {
      let map = stores.get(name);
      if (!map) { map = new Map(); stores.set(name, map); }
      return {
        async put(key, response) { map.set(String(key), response.clone ? response.clone() : response); },
        async match(key) { const hit = map.get(String(key)); return hit && hit.clone ? hit.clone() : hit; },
        async delete(key) { return map.delete(String(key)); },
      };
    },
  };
}

/** 一个够真的假文件：`importResourcePack` 只要求 `size` + `slice(...).arrayBuffer()`。
 *
 * `arrayBuffer()` 必须给出**独立的一份**缓冲：`Buffer.prototype.slice` 返回的是视图而不是副本，而 `.buffer` 指向
 * Node 的缓冲池（`fs.readFileSync` 的小文件就在池里、`byteOffset !== 0`），直接交出去会把它前面那段内存也读进来
 * —— 真的 `Blob` 不会这样，这个假件也不能。 */
function fakeFile(bytes) {
  const copy = (view) => { const out = new Uint8Array(view.byteLength); out.set(view); return out; };
  return {
    size: bytes.length,
    slice(start, end) {
      const part = bytes.subarray(start === undefined ? 0 : start, end === undefined ? bytes.length : end);
      return { size: part.length, arrayBuffer: async () => copy(part).buffer };
    },
    arrayBuffer: async () => copy(bytes).buffer,
  };
}

/** 客户端夹具的四个文件（`url` 用**清单里的原样写法**，所以方括号那种名字也照原样写）。 */
const CLIENT_FILES = [
  { url: '/assets/demo-0.bin', body: Buffer.alloc(2048, 0x11), tier: 2 },
  { url: '/assets/[opt]demo.svg', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'), tier: 2 },
  { url: '/assets/audio/bgm/act1.mp3', body: Buffer.alloc(512, 0x22), tier: 1 },
  { url: '/fonts/demo.woff2', body: Buffer.alloc(256, 0x33), tier: 1 },
];

/**
 * 用**我们的**生成器造一个真的容器（`tools/make-spresources.mjs`），放进一个真的工坊包。
 * @returns {{ dir: string, manifest: any, containerAbs: string, srcDir: string, manifestFile: string }}
 */
function buildClientPack(root, id, { entries = CLIENT_FILES, name = 'resources-0.1.0', extraBytes = null } = {}) {
  const srcDir = join(tmp, 'src', id);
  /** @type {Array<{ url: string, size: number, hash: string, tier: number }>} */
  const files = [];
  for (const e of entries) {
    const body = extraBytes && e.url === extraBytes.url ? extraBytes.body : e.body;
    const abs = join(srcDir, ...e.url.split('/').filter(Boolean));
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    files.push({ url: e.url, size: body.length, hash: sha1_12(body), tier: e.tier });
  }
  const manifest = { format: 1, version: computeVersion(files), files };
  const manifestFile = join(tmp, 'manifests', `${id}.json`);
  fs.mkdirSync(dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const dir = writePack(root, id, { assets: { container: `packs/${name}.spresources`, manifest: 'resource-manifest.json' } });
  makePack({ manifestFile, publicDir: srcDir, outDir: dir, name });
  return { dir, manifest, containerAbs: join(dir, 'packs', `${name}.spresources`), srcDir, manifestFile };
}

/** 把站点路径补成绝对 URL（假 `fetch` 用；浏览器里 `fetch` 自己按页面 origin 解析）。 */
const absoluteFor = (base) => (url, init) => fetch(new URL(url, base).href, init);

let clientWs;
let clientPacks;

before(() => {
  clientWs = join(tmp, 'ws-client');
  fs.mkdirSync(clientWs, { recursive: true });
  // ① 一份声明 + 一份容器；② 同一份声明、**同一份字节**（哈希必须相同）；③ 同一份声明、**不同字节**（哈希必须不同）
  const a = buildClientPack(clientWs, 'resource-pack');
  const b = buildClientPack(clientWs, 'same-bytes');
  const c = buildClientPack(clientWs, 'other-bytes', { extraBytes: { url: '/assets/demo-0.bin', body: Buffer.alloc(2048, 0x44) } });
  clientPacks = { a, b, c };
});

describe('工具：我们的容器写入器与参考写入器逐字节相同（「别重写格式」是一条会红的断言）', () => {
  test('同一份清单 + 同一批源文件 ⇒ 两个写入器产出的容器逐字节相同；Node 解析器与浏览器解析器同解', async () => {
    const { manifest, srcDir, containerAbs } = clientPacks.a;
    const mine = fs.readFileSync(containerAbs);
    // 参考写入器（`_up/mod4-pack/tools/spresources.mjs` 的 buildPack，正文一字未改地搬进 tools/spresources.mjs）。
    const outDir = join(tmp, 'ref-out');
    const ref = buildPack({ manifest, publicDir: srcDir, outDir, force: true, log: () => {} });
    const refBytes = fs.readFileSync(ref.pack);
    assert.deepEqual(Buffer.from(mine), Buffer.from(refBytes), '两个写入器的字节必须完全相同（否则就是我们自己重写了格式）');
    assert.equal(ref.sha256, await sha256(mine), '参考写入器自己算的整包摘要 == 我们对同一批字节算的');
    // Node 侧的解析器（权威）
    const parsed = parsePack(mine);
    assert.deepEqual(parsed.manifest, manifest);
    assert.equal(parsed.files.length, manifest.files.length);
    assert.equal(parsed.totalBytes, mine.length);
    // 旁挂摘要就是装载期会读的那一份
    assert.equal(fs.readFileSync(`${containerAbs}.sha256`, 'utf8').split(/\s+/)[0], parsed.sha256);
    // 浏览器侧的解析器算的版本号：同一批字节、同一份清单 ⇒ 同一个值
    assert.equal(await computeManifestVersion(manifest.files), manifest.version);
  });

  test('清单版本号：Node 的 `computeVersion` 与浏览器的 `computeManifestVersion` 同值；换了字节就是换了一版', async () => {
    const { manifest } = clientPacks.a;
    const v = await computeManifestVersion(manifest.files);
    assert.equal(v, computeVersion(manifest.files));
    assert.equal(v, manifest.version);
    assert.notEqual(clientPacks.c.manifest.version, manifest.version, '换了字节就是换了一版清单');
    // 条目内 key 顺序是版本算法的一部分（`url,size,hash,tier`）—— 换个写法就换个值，所以两侧都必须保序
    const reordered = manifest.files.map((f) => ({ url: f.url, tier: f.tier, hash: f.hash, size: f.size }));
    assert.notEqual(await computeManifestVersion(reordered), manifest.version);
  });

  test('清单形状：浏览器侧比参考实现更严 —— `size` / `hash` 缺一不可（没有指纹的条目无法校验）', () => {
    const { manifest } = clientPacks.a;
    assert.deepEqual(validateManifest(manifest), manifest);
    const noHash = { ...manifest, files: manifest.files.map((f, i) => (i ? f : { url: f.url, size: f.size, tier: f.tier })) };
    assert.throws(() => validateManifest(noHash), /指纹无效/);
    const noSize = { ...manifest, files: manifest.files.map((f, i) => (i ? f : { url: f.url, hash: f.hash, tier: f.tier })) };
    assert.throws(() => validateManifest(noSize), /大小无效/);
    assert.throws(() => validateManifest({ ...manifest, format: 2 }), /格式不受支持/);
    // `/media/…` 不许进清单：它不指向任何静态主机能提供的文件，一条这样的条目会让客户端追着取不到的名字跑
    assert.equal(isResourceUrl('/media/bgm/act1'), false);
    assert.equal(isResourceUrl('/assets/x.png'), true);
    assert.equal(isResourceUrl('/assets/x.unknownext'), false);
    assert.equal(isResourcePath('/build/x.js'), false);
    assert.equal(isResourcePath('/assets/x.js'), true);
  });

  test('音频扩展名表与无扩展名路由：**就是** `shared/media.js` 那一份，不抄第二份', () => {
    assert.equal(MEDIA_PREFIX, SHARED_MEDIA_PREFIX);
    assert.deepEqual([...AUDIO_EXTS], [...SHARED_AUDIO_EXTS]);
    assert.deepEqual(mediaCandidates('/media/bgm/act1'), AUDIO_EXTS.map((e) => '/assets/audio/bgm/act1' + e));
    assert.deepEqual(mediaCandidates('/media/bgm/act1.ogg').slice(0, 2), ['/assets/audio/bgm/act1.ogg', '/assets/audio/bgm/act1.mp3']);
    for (const p of ['/media/', '/media/bgm/', '/media/bgm/.hidden', '/media/..', '/assets/x.png']) {
      assert.deepEqual(mediaCandidates(p), [], p);
    }
    // 客户端那条路由判据的前缀（引擎自己那一份常量）必须与共享的那一份同值
    assert.equal(CLIENT_RESOURCE_PREFIX, WORKSHOP_RESOURCE_PREFIX);
  });
});

describe('客户端流程：取清单 → 容器导入（逐文件校验 + 写缓存）→ 深浅校验', () => {
  test('真 HTTP：声明里的两个 URL 真能取到，容器摘要头 == 声明里的 digest，清单自洽', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const decl = srv.lobby.welcomeInfo().modAssets.find((d) => d.pack === 'resource-pack');
      assert.ok(decl, JSON.stringify(srv.lobby.welcomeInfo().modAssets));
      const res = await fetch(new URL(decl.container, srv.url).href);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-sp-resource-sha256'), decl.digest);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(await sha256(bytes), decl.digest, '真取到的字节就是声明的那份容器');
      const man = await fetch(new URL(decl.manifest, srv.url).href);
      assert.equal(man.status, 200);
      const served = await man.json();
      assert.deepEqual(served, clientPacks.a.manifest);
      assert.equal(await computeManifestVersion(served.files), served.version, '清单版本号 == sha256(压紧 files)[0:12]');
    } finally {
      await srv.close();
    }
  });

  test('整条流程（假的 CacheStorage，真的 Response / crypto.subtle）：导入 → 浅度 → 深度 全绿', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const decl = srv.lobby.welcomeInfo().modAssets.find((d) => d.pack === 'resource-pack');
      const caches = fakeCaches();
      const fetchImpl = absoluteFor(srv.url);
      const blob = await fetchContainer(decl, { fetchImpl });
      assert.equal(blob.size, fs.statSync(clientPacks.a.containerAbs).size);
      const manifest = await fetchManifest(decl, { fetchImpl });
      assert.deepEqual(manifest, clientPacks.a.manifest);
      const progress = [];
      const imported = await importResourcePack(blob, decl, manifest, { caches, origin: srv.url, onProgress: (p) => progress.push(p.count) });
      assert.equal(imported.count, 4);
      assert.equal(imported.bytes, manifest.files.reduce((n, f) => n + f.size, 0));
      assert.equal(imported.digest, decl.digest);
      // 收据按包：版本、文件数、容器摘要
      const receipt = await importedReceipt(decl, { caches, origin: srv.url });
      assert.equal(receipt.manifest, manifest.version);
      assert.equal(receipt.count, 4);
      assert.equal(receipt.digest, decl.digest);
      assert.equal(receipt.importedAt > 0, true);
      // 两份合成条目就在同一个缓存里（索引与收据都是 `CACHE_NAME` 下的普通条目）
      assert.equal(caches._stores.get(CACHE_NAME).has(receiptUrl(srv.url)), true);
      assert.equal(caches._stores.get(CACHE_NAME).has(indexUrl(srv.url)), true);
      // 索引：URL → 指纹，一条不多一条不少
      const index = await (await (await caches.open(CACHE_NAME)).match(indexUrl(srv.url))).json();
      assert.equal(index.format, 1);
      assert.deepEqual(Object.keys(index.files).sort(), manifest.files.map((f) => absoluteUrl(f.url, srv.url)).sort());
      // 浅度 / 深度
      const shallow = await verifyImportedResources(decl, manifest, { caches, origin: srv.url });
      assert.deepEqual(shallow, { valid: true, checked: 4, missing: [], deep: false });
      const deep = await verifyImportedResources(decl, manifest, { caches, origin: srv.url, deep: true });
      assert.deepEqual(deep, { valid: true, checked: 4, missing: [], deep: true });
      // 进度是单调的
      assert.ok(progress.length >= 1 && progress[progress.length - 1] === 4, progress.join(','));
    } finally {
      await srv.close();
    }
  });

  test('坏容器逐个具名拒绝：清单不一致 / 不是容器 / 不完整 / 头撒谎 —— 收据一律不留', async () => {
    const { manifest, containerAbs } = clientPacks.a;
    const good = fs.readFileSync(containerAbs);
    const decl = {
      pack: 'broken',
      container: '/workshop-resources/broken/packs/resources-0.1.0.spresources',
      manifest: '/workshop-resources/broken/resource-manifest.json',
      digest: await sha256(good), serverPolicy: 'serve', verify: 'sha256',
    };
    /** 一个坏包跑一遍：必须有具名错误，且**收据不存在**（半途而废的导入不许留下「已导入」的痕迹）。 */
    const attempt = async (label, bytes, expect, m = manifest) => {
      const caches = fakeCaches();
      await assert.rejects(() => importResourcePack(fakeFile(bytes), decl, m, { caches, origin: 'http://x' }), expect, label);
      assert.equal(await importedReceipt(decl, { caches, origin: 'http://x' }), null, `${label}: 半途而废的导入不许留下收据`);
    };
    await attempt('清单与容器头不一致', good, /资源包清单与服务器不一致/,
      { ...manifest, files: manifest.files.map((f, i) => (i ? f : { ...f, size: f.size + 1 })) });
    await attempt('不是容器', Buffer.from('not a pack at all, just some bytes'), /格式不正确/);
    await attempt('被截断', good.subarray(0, good.length - 1), /不完整/);
    const flipped = Buffer.from(good);
    flipped[flipped.length - 1] ^= 0xff;
    // 最后一个字节属于最后一个文件体 ⇒ 逐文件指纹不符（若恰好落在边界上，就报「不完整」，两条都是具名拒绝）
    await attempt('字节被动过', flipped, /资源包文件损坏|不完整/);
    // 头长撒谎 ⇒ 头部损坏
    const badHeader = Buffer.from(good);
    badHeader.writeUInt32LE(0xfffffff, 8);
    await attempt('头长撒谎', badHeader, /包头损坏/);
    assert.equal(decl.digest, await sha256(good));
  });

  test('`fetchManifest` 要求清单自洽（version == sha256(压紧 files)[0:12]），并对 HTTP 失败具名', async () => {
    const { manifest } = clientPacks.a;
    const ok = await fetchManifest({ manifest: '/m.json' }, { fetchImpl: async () => new Response(JSON.stringify(manifest)) });
    assert.deepEqual(ok, manifest);
    const tampered = { ...manifest, version: 'deadbeefcafe' };
    await assert.rejects(
      () => fetchManifest({ manifest: '/m.json' }, { fetchImpl: async () => new Response(JSON.stringify(tampered)) }),
      /自相矛盾/,
    );
    await assert.rejects(() => fetchManifest({ manifest: '/m.json' }, { fetchImpl: async () => new Response('nope', { status: 404 }) }), /取不到/);
    await assert.rejects(() => fetchManifest({ manifest: '/m.json' }, { fetchImpl: async () => new Response('not json') }), /不是 JSON/);
    await assert.rejects(() => fetchManifest({}, { fetchImpl: async () => new Response('{}') }), /没有声明资源清单/);
  });

  test('缓存被动过 ⇒ 浅度校验点名那个 URL；撤掉收据 ⇒ 校验直接说「没导入」', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const decl = srv.lobby.welcomeInfo().modAssets.find((d) => d.pack === 'resource-pack');
      const caches = fakeCaches();
      const fetchImpl = absoluteFor(srv.url);
      const manifest = await fetchManifest(decl, { fetchImpl });
      await importResourcePack(await fetchContainer(decl, { fetchImpl }), decl, manifest, { caches, origin: srv.url });
      // 有人把某个条目的响应头改了（换了字节 / 索引与条目不再一致）—— 点名它，valid: false
      const victim = manifest.files[1];
      const key = absoluteUrl(victim.url, srv.url);
      const store = caches._stores.get(CACHE_NAME);
      store.set(key, new Response(Buffer.from('swapped'), { headers: { 'X-SP-Resource': '1', 'X-SP-Resource-Hash': '000000000000' } }));
      const bad = await verifyImportedResources(decl, manifest, { caches, origin: srv.url });
      assert.equal(bad.valid, false);
      assert.deepEqual(bad.missing, [victim.url]);
      // 收据被撤（换容器 / 用户清缓存）⇒ 「没导入」，而不是「部分有效」
      assert.equal(await revokeImport('resource-pack', { caches, origin: srv.url }), true);
      assert.equal(await revokeImport('resource-pack', { caches, origin: srv.url }), false, '撤两次：第二次没什么可撤');
      const gone = await verifyImportedResources(decl, manifest, { caches, origin: srv.url });
      assert.deepEqual(gone.missing, ['import receipt']);
    } finally {
      await srv.close();
    }
  });

  test('换容器 = 换身份：收据里的摘要与服务器这次宣告的不同 ⇒ 校验判 `container digest`', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const decl = srv.lobby.welcomeInfo().modAssets.find((d) => d.pack === 'resource-pack');
      const caches = fakeCaches();
      const fetchImpl = absoluteFor(srv.url);
      const manifest = await fetchManifest(decl, { fetchImpl });
      await importResourcePack(await fetchContainer(decl, { fetchImpl }), decl, manifest, { caches, origin: srv.url });
      const moved = { ...decl, digest: 'f'.repeat(64) };
      const verdict = await verifyImportedResources(moved, manifest, { caches, origin: srv.url });
      assert.equal(verdict.valid, false);
      assert.deepEqual(verdict.missing, ['container digest']);
      // host 的导入状态也这么说
      installModAssets([moved], {});
      const state = await importStateFor('resource-pack', { caches, origin: srv.url });
      assert.equal(state.stale, true);
      assert.equal(state.receipt.digest, decl.digest, '收据还是原来那份');
    } finally {
      await srv.close();
    }
  });

  test('`rangeResponse`：206 的三段算术（起止 / 开尾 / 后缀）与越界 416', async () => {
    const full = new Response(Buffer.alloc(100, 7), { headers: { 'Content-Type': 'application/octet-stream' } });
    const of = async (range) => {
      const r = await rangeResponse(full.clone(), range);
      return { status: r.status, range: r.headers.get('content-range'), len: Number(r.headers.get('content-length')) };
    };
    assert.deepEqual(await of('bytes=0-9'), { status: 206, range: 'bytes 0-9/100', len: 10 });
    assert.deepEqual(await of('bytes=10-'), { status: 206, range: 'bytes 10-99/100', len: 90 });
    assert.deepEqual(await of('bytes=-5'), { status: 206, range: 'bytes 95-99/100', len: 5 });
    assert.deepEqual(await of('bytes=99999-'), { status: 416, range: 'bytes */100', len: 0 });
    // 200 那条路（媒体能播）不走这里：SW 只在请求带 `Range` 时调它，所以这里不替它编一个「无 Range」的行为。
  });

  test('整包摘要（可选那一步）：对了就说 checked+ok，太大就如实说「没查」', async () => {
    const { containerAbs } = clientPacks.a;
    const bytes = fs.readFileSync(containerAbs);
    const digest = await sha256(bytes);
    assert.deepEqual(await verifyContainerBytes(fakeFile(bytes), digest), { checked: true, ok: true, actual: digest });
    const wrong = await verifyContainerBytes(fakeFile(bytes), 'a'.repeat(64));
    assert.equal(wrong.checked, true);
    assert.equal(wrong.ok, false);
    const big = await verifyContainerBytes({ size: 512 * 1024 * 1024, arrayBuffer: async () => { throw new Error('不许读'); } }, digest);
    assert.deepEqual(big, { checked: false, ok: false, reason: 'too-large' }, '**如实报告没查**，而不是假装查过');
    assert.equal((await verifyContainerBytes(fakeFile(bytes), 'nope')).reason, 'no-digest');
  });
});

describe('SW：只用本地校验过的缓存回答，命不中 412 且绝不回源（`public/resource-sw.js` + `service.js`）', () => {
  /** 导入一个真包，返回 `{ decl, manifest, caches, origin }`（SW 用例的公共前置）。 */
  async function imported(srv, packId) {
    const decl = srv.lobby.welcomeInfo().modAssets.find((d) => d.pack === packId);
    const caches = fakeCaches();
    const fetchImpl = absoluteFor(srv.url);
    const manifest = await fetchManifest(decl, { fetchImpl });
    await importResourcePack(await fetchContainer(decl, { fetchImpl }), decl, manifest, { caches, origin: srv.url });
    return { decl, manifest, caches, origin: srv.url };
  }
  const reqOf = (origin, path, init) => new Request(new URL(path, origin).href, init);

  test('命中：普通资源 200、`/media/…` 走候选、`%5B` 与 `[` 两种拼写都认、Range ⇒ 206', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const { caches, origin } = await imported(srv, 'resource-pack');
      const hit = await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches });
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get('x-sp-resource'), '1');
      assert.equal(hit.headers.get('content-type'), 'application/octet-stream');
      assert.equal((await hit.arrayBuffer()).byteLength, 2048);
      // 方括号的两种拼写（导入器保留 `[`，棋盘素材加载器 `encodeURI` 出来的是 `%5B`）
      for (const p of ['/assets/[opt]demo.svg', '/assets/%5Bopt%5Ddemo.svg']) {
        const r = await handleResourceRequest(reqOf(origin, p), { caches });
        assert.equal(r.status, 200, p);
        assert.equal(await r.text(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      }
      // 无扩展名音频路由：映射到清单里真的存着的那个条目
      const audio = await handleResourceRequest(reqOf(origin, '/media/bgm/act1'), { caches });
      assert.equal(audio.status, 200);
      assert.equal((await audio.arrayBuffer()).byteLength, 512);
      // Range ⇒ 206（媒体 seek 用）
      const ranged = await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin', { headers: { Range: 'bytes=0-9' } }), { caches });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), 'bytes 0-9/2048');
      assert.equal((await ranged.arrayBuffer()).byteLength, 10);
      // 越界的 Range ⇒ 416
      const bad = await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin', { headers: { Range: 'bytes=99999-' } }), { caches });
      assert.equal(bad.status, 416);
    } finally {
      await srv.close();
    }
  });

  test('未命中 / 不是资源路径 / 非 GET：412（不是 200 空体、不是 404），且**永远返回响应**（所以浏览器不会回源）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const { caches, origin } = await imported(srv, 'resource-pack');
      for (const p of ['/assets/nope.png', '/fonts/nope.woff2', '/media/bgm/nope', '/assets/audio/bgm/other.mp3']) {
        const r = await handleResourceRequest(reqOf(origin, p), { caches });
        // 「不回源」的行为证明：资源路径上**永远**返回一条 Response。返回 null/undefined 才是「交给网络」。
        assert.ok(r instanceof Response, `${p}: 必须返回响应（返回 null 就等于回源）`);
        assert.equal(r.status, 412, p);
        assert.equal(r.headers.get('cache-control'), 'no-store');
      }
      // 不是资源路径 ⇒ null（放行给网络，这是 SW 的边界而不是它的策略）
      for (const p of ['/data/chess.json', '/js/main.js', '/build/x.js', '/workshop-resources/p/x.spresources', '/']) {
        assert.equal(await handleResourceRequest(reqOf(origin, p), { caches }), null, p);
      }
      assert.equal(await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin', { method: 'POST' }), { caches }), null, '非 GET 不管');
      // 没有 Cache Storage（隐私模式）⇒ 明确 412，不偷偷回源
      assert.equal((await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches: null })).status, 412);
      // 索引在、但这条 URL 不在索引里（上一版清单的孤儿）⇒ 不许发
      const store = caches._stores.get(CACHE_NAME);
      const key = absoluteUrl('/assets/demo-0.bin', origin);
      const index = await store.get(indexUrl(origin)).clone().json();
      delete index.files[key];
      store.set(indexUrl(origin), new Response(JSON.stringify(index)));
      assert.equal((await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches })).status, 412, '索引没作保的条目必须当没有');
      // 响应头的指纹与索引说的不一致 ⇒ 也不许发（孤儿）
      const index2 = await store.get(indexUrl(origin)).clone().json();
      index2.files[key] = '000000000000';
      store.set(indexUrl(origin), new Response(JSON.stringify(index2)));
      assert.equal((await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches })).status, 412);
      // 索引整个没了 ⇒ 同样 412
      store.delete(indexUrl(origin));
      assert.equal((await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches })).status, 412);
    } finally {
      await srv.close();
    }
  });

  test('字节被判定为坏之后（收据与索引一起摘）那个 URL 立刻变 412', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const { decl, manifest, caches, origin } = await imported(srv, 'resource-pack');
      const url = absoluteUrl('/assets/demo-0.bin', origin);
      assert.equal((await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches })).status, 200);
      await revokeImport('resource-pack', { caches, origin, urls: manifest.files.map((f) => absoluteUrl(f.url, origin)) });
      assert.equal((await handleResourceRequest(reqOf(origin, '/assets/demo-0.bin'), { caches })).status, 412,
        '已知是坏的字节必须停止被回答 —— 只撤收据是不够的（SW 看的是索引）');
      const index = await (await (await caches.open(CACHE_NAME)).match(indexUrl(origin))).json();
      assert.equal(Object.hasOwn(index.files, url), false);
      assert.equal(await importedReceipt(decl, { caches, origin }), null);
    } finally {
      await srv.close();
    }
  });
});

describe('host：声明登记 + 一站式流程 + 注册参数（真 SW 不在这里跑，参数在这里钉住）', () => {
  test('`normalizeModAsset`：坏声明逐条具名拒绝，好声明原样归一化', () => {
    const base = `${WORKSHOP_RESOURCE_PREFIX}resource-pack/`;
    const good = { pack: 'resource-pack', container: `${base}packs/resources-0.1.0.spresources?v=abc`, manifest: `${base}resource-manifest.json?v=abc`, digest: 'a'.repeat(64), serverPolicy: 'cache-only', verify: 'sha256' };
    const r = normalizeModAsset(good);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual({ ...r.decl }, { ...good, mediaPrefix: MEDIA_PREFIX });
    assert.equal(Object.isFrozen(r.decl), true);
    /** @type {Array<[string, any, RegExp]>} */
    const bad = [
      ['不是对象', 'x', /not an object/],
      ['包 id 不合法', { ...good, pack: '../x' }, /not a usable id/],
      ['容器不是注册路由', { ...good, container: '/assets/x.spresources' }, /only \/workshop-resources/],
      ['容器不是 .spresources', { ...good, container: `${base}x.zip` }, /only \/workshop-resources/],
      ['清单不是 .json', { ...good, manifest: `${base}x.txt` }, /only \/workshop-resources/],
      ['缺摘要', { ...good, digest: undefined }, /not a sha256/],
      ['摘要形状不对', { ...good, digest: 'abc' }, /not a sha256/],
      ['策略不在闭枚举里', { ...good, serverPolicy: 'preload' }, /not one of serve, cache-only/],
      ['校验算法不认识', { ...good, verify: 'md5' }, /not one of sha256/],
    ];
    for (const [label, raw, re] of bad) {
      const got = normalizeModAsset(raw);
      assert.equal(got.ok, false, label);
      assert.match(got.detail, re, label);
    }
    // 缺省：`serverPolicy` / `verify` 补成形状层的缺省值，不是「没有」
    const minimal = normalizeModAsset({ pack: 'p', container: `${WORKSHOP_RESOURCE_PREFIX}p/a.spresources`, manifest: `${WORKSHOP_RESOURCE_PREFIX}p/m.json`, digest: 'b'.repeat(64) });
    assert.equal(minimal.ok, true);
    assert.equal(minimal.decl.serverPolicy, 'serve');
    assert.equal(minimal.decl.verify, 'sha256');
  });

  test('`installModAssets`：登记声明并在后台注册引擎自带的 SW（口径逐字钉住），坏的具名拒绝且不注册', async () => {
    /** 一个只记账的假 `navigator.serviceWorker`。 */
    function fakeNav({ control = true } = {}) {
      const calls = [];
      /** @type {Map<string, Function>} */
      const listeners = new Map();
      const nav = {
        controller: control ? { scriptURL: '/resource-sw.js' } : null,
        register(url, opts) { calls.push({ url, opts }); return Promise.resolve({ scope: '/' }); },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
      };
      return { nav, calls, listeners };
    }
    const good = { pack: 'a', container: `${WORKSHOP_RESOURCE_PREFIX}a/a.spresources`, manifest: `${WORKSHOP_RESOURCE_PREFIX}a/m.json`, digest: 'c'.repeat(64) };
    // 「注册一次」是**模块级**的一次性状态（同一页只注册一次），所以这一段用一份**干净的模块实例**跑
    // （带查询串 import 得到的是新实例）—— 否则同一份文件里别的用例先登记过，断言就成了顺序的函数。
    const fresh = await import('../public/js/resources/host.js?fresh=install');
    const nav = fakeNav();
    const logged = [];
    const log = { info() {}, warn() {}, error: (...a) => logged.push(String(a[0])), debug() {} };
    const res = fresh.installModAssets([good, { pack: 'bad id' }], { nav: nav.nav, log });
    assert.equal(res.accepted, 1);
    assert.equal(res.refused.length, 1);
    assert.equal(res.refused[0].code, 'MOD_ASSETS_BAD_PACK');
    assert.ok(logged.some((l) => l.includes('MOD_ASSETS_BAD_PACK')), logged.join('\n'));
    await Promise.resolve();
    // 参数照参考实现的口径：模块 SW、根作用域、绝不从 HTTP 缓存取脚本
    assert.equal(nav.calls.length, 1);
    assert.deepEqual(nav.calls[0], { url: '/resource-sw.js', opts: { type: 'module', scope: '/', updateViaCache: 'none' } });
    assert.equal(fresh.modAssetsFor('a').digest, 'c'.repeat(64));
    assert.equal(fresh.modAssetDeclarations().length, 1);
    // 第二次 welcome（重连）整份替换，而不是追加；而且**不再注册第二次**
    const goodB = { pack: 'b', container: `${WORKSHOP_RESOURCE_PREFIX}b/a.spresources`, manifest: `${WORKSHOP_RESOURCE_PREFIX}b/m.json`, digest: 'c'.repeat(64) };
    fresh.installModAssets([goodB], { nav: nav.nav });
    assert.deepEqual(fresh.modAssetDeclarations().map((d) => d.pack), ['b']);
    assert.equal(fresh.modAssetsFor('a'), null);
    assert.equal(nav.calls.length, 1, '同一页只注册一次：重连带来的第二个 welcome 不许再注册');
    // 没有声明 ⇒ 不注册、登记表为空（「不声明 ⇒ 无新请求」）
    const empty = fakeNav();
    const noneMod = await import('../public/js/resources/host.js?fresh=empty');
    assert.deepEqual(noneMod.installModAssets([], { nav: empty.nav }), { accepted: 0, refused: [] });
    assert.deepEqual(empty.calls, []);
    assert.deepEqual(noneMod.modAssetDeclarations(), []);
    assert.equal(noneMod.modAssetsFor('a'), null);
    // 共享实例：登记与「有没有 SW」无关（SW 那一步失败只记日志），后面的用例照旧读这张登记表
    const noNav = installModAssets([good], { nav: null, log });
    assert.equal(noNav.accepted, 1);
    assert.equal(modAssetsFor('a').pack, 'a');
    assert.deepEqual(modAssetDeclarations().map((d) => d.pack), ['a']);
  });

  test('`importAndVerify`：整条流程走通；未声明的包明确报错（入口闸门那支笔仍在面板手里）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    try {
      const decl = srv.lobby.welcomeInfo().modAssets.find((d) => d.pack === 'resource-pack');
      installModAssets([decl], {});
      const caches = fakeCaches();
      const fetchImpl = absoluteFor(srv.url);
      const report = await importAndVerify(await fetchContainer(decl, { fetchImpl }), 'resource-pack', { caches, origin: srv.url, fetchImpl, deep: true });
      assert.equal(report.pack, 'resource-pack');
      assert.equal(report.version, clientPacks.a.manifest.version);
      assert.equal(report.digest, decl.digest);
      assert.equal(report.count, 4);
      assert.equal(report.valid, true);
      assert.deepEqual(report.missing, []);
      assert.equal(report.deep, true);
      // 未声明的包：明确报错，而不是默默用一个空声明
      await assert.rejects(() => importAndVerify(fakeFile(Buffer.alloc(64)), 'not-declared', { caches, origin: srv.url }), /没有声明 assets/);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 7. `welcome.modAssets` 的条件性（与 B2 的 `modPanels` 同构：只有读者才加）
// ---------------------------------------------------------------------------------------------------
describe('welcome.modAssets：只有包声明了 `assets` 才多这个字段', () => {
  test('求解器：没有声明 ⇒ 空数组；有声明 ⇒ 每条都是注册过的 URL + 装载期核对过的摘要 + 归一化策略值', () => {
    const loaded = loadWorkshop(clientWs, { log: quiet });
    assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
    const digests = new Map(loaded.packs.filter((p) => p.assetsDigest).map((p) => [p.id, p.assetsDigest]));
    const files = workshopResourceFilesFor(loaded.packs, clientWs, { digests });
    const list = workshopModAssetsFrom(files, loaded.packs);
    assert.deepEqual(list.map((d) => d.pack), ['other-bytes', 'resource-pack', 'same-bytes'], '按包 id 排序（不随装载顺序）');
    for (const d of list) {
      const pack = loaded.packs.find((p) => p.id === d.pack);
      assert.equal(d.digest, pack.assetsDigest, `${d.pack}: digest 就是装载器交给服务面的那一个`);
      assert.equal(d.container, `${WORKSHOP_RESOURCE_PREFIX}${d.pack}/packs/resources-0.1.0.spresources?v=${pack.hash.slice(0, 12)}`);
      assert.equal(d.manifest, `${WORKSHOP_RESOURCE_PREFIX}${d.pack}/resource-manifest.json?v=${pack.hash.slice(0, 12)}`);
      assert.equal(d.serverPolicy, 'serve');
      assert.equal(d.verify, 'sha256');
      assert.equal(files.has(d.container.split('?')[0]), true, 'container URL 必须在服务表里（不是另拼一份）');
      assert.equal(files.has(d.manifest.split('?')[0]), true);
    }
    // 真实夹具（三份示例包，一份都没声明 `assets`）⇒ 空数组
    const examples = loadWorkshop(EXAMPLES, { log: quiet });
    assert.equal(workshopModAssetsFrom(workshopResourceFilesFor(examples.packs, EXAMPLES), examples.packs).length, 0);
    // 关掉工坊 / 没有 packs ⇒ 空
    assert.deepEqual(workshopModAssetsFrom(new Map(), loaded.packs), []);
    assert.deepEqual(workshopModAssetsFrom(files, []), []);
    assert.deepEqual(workshopModAssetsFrom(null, null), []);
    // 只有一半（手工拼的服务表少了清单）⇒ 不出这一条，而不是给半个地址
    const half = new Map([...files].filter(([, e]) => e.kind === 'container'));
    assert.deepEqual(workshopModAssetsFrom(half, loaded.packs), []);
    // 摘要不是 64 位十六进制 ⇒ 不出这一条（没有「同一份容器」这句话，就没有可宣告的东西）
    const noDigest = new Map([...files].map(([k, e]) => [k, { ...e, sha256: null }]));
    assert.deepEqual(workshopModAssetsFrom(noDigest, loaded.packs.map((p) => ({ ...p, assetsDigest: undefined }))), []);
  });

  test('真服务器：字段集合只差 `modAssets` 一个；声明了 `client` 却没声明 `assets` 的包不产生它', async () => {
    const onlyClient = join(tmp, 'ws-client-only');
    const panelOnly = writePack(onlyClient, 'panel-only', {
      content: ['chess'],
      extra: { 'chess.json': JSON.stringify({ chess_ws_panel_only: { chessId: 'chess_ws_panel_only', name: 'p' } }), 'p.js': 'export function mount() {}\n' },
    });
    // 只声明 `client` 的包（`writePack` 不认 client，这里直接改 pack.json）
    fs.writeFileSync(join(panelOnly, 'pack.json'), JSON.stringify({
      id: 'panel-only', version: '0.1.0', license: 'CC0-1.0', content: ['chess'],
      client: { panels: [{ id: 'p1', slot: 'root.overlays', module: 'p.js' }] },
    }));

    const withAssets = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    const plain = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    const clientOnly = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: onlyClient });
    try {
      const w1 = withAssets.lobby.welcomeInfo();
      const w2 = plain.lobby.welcomeInfo();
      const w3 = clientOnly.lobby.welcomeInfo();
      assert.equal(w1.modAssets.length, 3);
      assert.deepEqual(w1.modAssets.map((d) => d.pack), ['other-bytes', 'resource-pack', 'same-bytes']);
      for (const d of w1.modAssets) {
        assert.deepEqual(Object.keys(d).sort(), ['container', 'digest', 'manifest', 'pack', 'serverPolicy', 'verify']);
        assert.match(d.digest, /^[0-9a-f]{64}$/);
      }
      assert.equal('modAssets' in w2, false, '没有包声明 assets ⇒ welcome 里没有这个字段');
      assert.deepEqual(Object.keys(w1).sort(), [...Object.keys(w2), 'modAssets'].sort(), '两侧 welcome 的字段集合只差 modAssets 一个');
      // 只声明 `client` 的包：有 `modPanels`，没有 `modAssets`
      assert.equal(w3.modPanels.length, 1);
      assert.equal('modAssets' in w3, false);
    } finally {
      await withAssets.close();
      await plain.close();
      await clientOnly.close();
    }
  });

  test('真握手：`welcome` 帧里字段按条件出现（两侧对照，字段集合只差一个）', async () => {
    const withAssets = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: clientWs });
    const plain = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    try {
      const a = await TestClient.connect(`${withAssets.url.replace('http', 'ws')}/ws`);
      const b = await TestClient.connect(`${plain.url.replace('http', 'ws')}/ws`);
      const wa = await a.hello('资源博士');
      const wb = await b.hello('干净博士');
      assert.equal(wa.modAssets.length, 3);
      assert.equal('modAssets' in wb, false);
      assert.deepEqual(Object.keys(wa).sort(), [...Object.keys(wb), 'modAssets'].sort());
      await a.close();
      await b.close();
    } finally {
      await withAssets.close();
      await plain.close();
    }
  });

  test('引擎文件与声明无关：`/resource-sw.js` 与 `/js/resources/**` 在没有声明的服务器上照旧可取', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    try {
      const w = srv.lobby.welcomeInfo();
      assert.equal('modAssets' in w, false);
      for (const p of ['/resource-sw.js', '/js/resources/host.js', '/js/resources/bundle.js', '/js/resources/service.js', '/js/resources/common.js', '/js/resources/verify.js', '/js/resources/worker.js']) {
        const res = await fetch(srv.url + p);
        assert.equal(res.status, 200, p);
        assert.match(res.headers.get('content-type'), /javascript/, p);
        // 脚本必须是 no-cache：一次部署要能到达已经打开的页面（`updateViaCache: 'none'` 是第二道）
        assert.equal(res.headers.get('cache-control'), 'no-cache', p);
      }
      // SW 脚本落在站点根上 ⇒ 它自己的最大作用域就是 `/`，所以 `scope: '/'` 不需要 Service-Worker-Allowed 头
      assert.equal((await fetch(`${srv.url}/resource-sw.js`)).headers.get('service-worker-allowed'), null);
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 8. 容器摘要进身份：同一个房间摘要 ⇒ 同一份容器（没声明 `assets` 的包逐字节不变）
// ---------------------------------------------------------------------------------------------------
describe('assetsDigest 进身份哈希（DESIGN §28.2 / §28.13.5）', () => {
  test('同一个声明、不同的容器字节 ⇒ 不同的容器摘要；同一份字节 ⇒ 同一个摘要', () => {
    const loaded = loadWorkshop(clientWs, { log: quiet });
    const by = (id) => loaded.packs.find((p) => p.id === id);
    const a = by('resource-pack');
    const b = by('same-bytes');
    const c = by('other-bytes');
    assert.ok(a && b && c, loaded.packs.map((p) => p.id).join(','));
    assert.deepEqual(a.assets, c.assets, '两个包的声明逐字相同（只有容器的字节不同）');
    assert.deepEqual(a.assets, b.assets);
    assert.equal(a.assetsDigest, b.assetsDigest, '同一份容器字节 ⇒ 同一个摘要');
    assert.notEqual(a.assetsDigest, c.assetsDigest, '不同字节 ⇒ 不同摘要');
    // 整包哈希不能直接用装载结果比：这两个包的 **id 不同**，而 id 是 `pack.json` 的一部分 —— 用同一份归一化清单
    // （同一个包对象）比才是「摘要进了哈希」这件事本身。
    const packObj = { assets: a.assets };
    const hashOf = (digest) => identifyPack(clientPacks.a.dir, packObj, {}, { assetsDigest: digest }).hash;
    const sameA = hashOf(a.assetsDigest);
    const sameB = hashOf(b.assetsDigest);
    const other = hashOf(c.assetsDigest);
    assert.equal(sameA, sameB, '同一份容器字节 ⇒ 同一个内容哈希');
    assert.notEqual(sameA, other, '摘要进了内容哈希：换容器就是换身份');
    // 哈希清单里那一条合成路径：路径名说的就是「这是容器的 sha256」
    for (const p of [a, b, c]) {
      const entry = p.manifest.filter((m) => m.path === ASSETS_DIGEST_PATH);
      assert.equal(entry.length, 1, `${p.id}: 恰好一条`);
      assert.equal(entry[0].hash, p.assetsDigest);
    }
    // 「同一个房间摘要 ⇒ 同一份容器」在线上那一半：摘要跟着容器变，房间摘要随之变
    const entry = (hash) => ({ id: 'room', hash, layer: 'A', combat: false, api: null });
    assert.notEqual(modSetOf([entry(sameA)]).digest, modSetOf([entry(other)]).digest);
    assert.equal(modSetOf([entry(sameA)]).digest, modSetOf([entry(sameB)]).digest, '同一份容器 ⇒ 同一个房间摘要');
  });

  test('缺少摘要就不进哈希：手工拼一个没有 `assetsDigest` 的包对象 ⇒ 与不带摘要同解', () => {
    const decl = { container: 'packs/resources-0.1.0.spresources', manifest: 'resource-manifest.json', serverPolicy: 'serve', verify: 'sha256' };
    const withDigest = identifyPack(clientPacks.a.dir, { assets: decl }, {}, { assetsDigest: 'd'.repeat(64) });
    const without = identifyPack(clientPacks.a.dir, { assets: decl }, {});
    assert.equal(withDigest.manifest.some((m) => m.path === ASSETS_DIGEST_PATH), true);
    assert.equal(without.manifest.some((m) => m.path === ASSETS_DIGEST_PATH), false);
    assert.notEqual(withDigest.hash, without.hash);
  });

  test('不声明 `assets` 的包一个字不变：三份真实包的哈希 + 集合摘要照旧', () => {
    // clementia 那一个在 0.2.3 那一轮**移过**：上游把克莱门莎收成了官方干员（官方 id `char_4231_clemnt`），
// 本仓库的示例夹具再用那个 id 会被加载器按 OFFICIAL_ID_COLLISION 拒掉，于是 id 换成工坊保留前缀的
// `char_ws_clemnt`（docs/examples/clementia/README.md）—— 包的内容真的变了，基线随之移动。
const BASELINE = {
      clementia: '27627f47d04aef3a622202a92038ada7a514b2c2b44389bfb069720b823d987e',
      'demo-workshop': '15092019fd1dbc85589af4b89102746c3a3c0389aef3847d7d9a335bca1a73ef',
      'kit-demo': '77b80c6e74021508d5857208d669da36cc74f20384798a6d5a269fd37f9e4f35',
    };
    const loaded = loadWorkshop(EXAMPLES, { log: quiet });
    assert.deepEqual(loaded.errors, [], '三份示例包必须都加载成功');
    for (const p of loaded.packs) {
      assert.equal(p.hash, BASELINE[p.id], `${p.id}: 缺省包的内容哈希变了`);
      assert.equal('assetsDigest' in p, false);
      assert.equal(p.manifest.some((m) => m.path === ASSETS_DIGEST_PATH), false, `${p.id}: 不该有容器摘要那一条`);
    }
    const set = modSetOf(loaded.packs.map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api })));
    // 实测值。整套摘要随着 clementia 那一份身份哈希一起移过：上游 0.2.3 把克莱门莎收成官方干员
    // （char_4231_clemnt），示例夹具换成工坊保留前缀的 char_ws_clemnt（docs/examples/clementia/README.md），
    // 于是那一个包的 hash 变了、整套摘要跟着变 —— 而另两份包（demo-workshop / kit-demo）的哈希一个字没变，
    // 正是这一条要守的东西。
    assert.equal(set.digest, '8913d669e9c01c15e2293b966de3a547c05828ba36c5f805f8888dcfc9f6ac10');
  });
});

// ---------------------------------------------------------------------------------------------------
// 9. `server.preDispatch` 的最后一格：只有 import 才知道的两种失败，在装配路径上被裁掉并点名
// ---------------------------------------------------------------------------------------------------
describe('preDispatch 对齐（B4）：声明不可用 ⇒ 装配路径把包移出已加载集合', () => {
  /** 一个 import 得动、但什么都不导出的模块；一个语法就错的模块；一个 import 当场抛的模块。 */
  const NO_FACTORY = 'export const nothing = 1;\n';
  const BROKEN_SYNTAX = 'export function createPreDispatch( { return }\n';
  const THROWS_ON_IMPORT = 'throw new Error("boom at import time");\nexport function createPreDispatch() { return { preDispatch() { return false; } }; }\n';
  let pruneWs;

  before(() => {
    pruneWs = join(tmp, 'ws-prune');
    fs.mkdirSync(pruneWs, { recursive: true });
    for (const [id, source] of [['no-factory', NO_FACTORY], ['broken-syntax', BROKEN_SYNTAX], ['throws', THROWS_ON_IMPORT]]) {
      const key = `chess_ws_${id.replace('-', '_')}`;
      writePack(pruneWs, id, {
        server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } },
        content: ['chess'],
        extra: {
          'server/hook.mjs': source,
          'p.json': '{}',
          // 这个包还带一条**数据**：裁剪必须发生在数据叠加层之前，否则「包不存在」而它的干员还在
          'chess.json': JSON.stringify({ [key]: { chessId: key, name: id } }),
        },
      });
    }
    writePack(pruneWs, 'good-hook', {
      server: { preDispatch: { module: 'server/hook.mjs', policy: 'p.json', intercepts: ['room.create'] } },
      content: ['chess'],
      extra: { 'server/hook.mjs': HOOK_SOURCE, 'p.json': '{}', 'chess.json': JSON.stringify({ chess_ws_good_hook: { chessId: 'chess_ws_good_hook', name: 'good' } }) },
    });
    writePack(pruneWs, 'no-hook', { content: ['chess'], extra: { 'chess.json': JSON.stringify({ chess_ws_no_hook: { chessId: 'chess_ws_no_hook', name: 'plain' } }) } });
  });

  test('装载期照旧列出它们（文件合法），装配路径把它们裁掉并点名', async () => {
    const loaded = loadWorkshop(pruneWs, { log: quiet });
    // 装载期：`module` / `policy` 都是可读文件、policy 是 JSON 对象、intercepts 在协议里 —— 文件层面全合法
    assert.deepEqual(loaded.packs.map((p) => p.id).sort(), ['broken-syntax', 'good-hook', 'no-factory', 'no-hook', 'throws']);
    assert.deepEqual(loaded.errors, []);
    const { hooks, errors } = await loadWorkshopHooks(loaded, { log: quiet });
    assert.deepEqual(hooks.map((h) => h.pack), ['good-hook']);
    assert.deepEqual(errors.map((e) => e.pack).sort(), ['broken-syntax', 'no-factory', 'throws']);
    for (const e of errors) {
      assert.equal(e.code, 'PREDISPATCH_BAD_MODULE', e.reason);
      assert.match(e.reason, /the startup assembly path drops this pack/);
    }
    const pruned = dropUnavailablePreDispatchPacks(loaded, errors);
    assert.deepEqual(pruned.removed.map((r) => r.pack), ['broken-syntax', 'no-factory', 'throws'], '按装载顺序（目录名排序）');
    assert.deepEqual(pruned.packs.map((p) => p.id).sort(), ['good-hook', 'no-hook']);
    for (const r of pruned.removed) {
      assert.equal(r.code, 'PREDISPATCH_BAD_MODULE');
      assert.ok(pruned.errors.some((e) => e.pack === r.pack && e.reason.startsWith(`${r.code}: `)), `${r.pack}: 裁剪要点名`);
    }
    // 纯函数：入参没被改
    assert.equal(loaded.packs.length, 5);
    assert.deepEqual(loaded.errors, []);
    // 没声明钩子的包 / 好钩子不受影响；空的错误表 ⇒ 什么都不裁
    assert.deepEqual(dropUnavailablePreDispatchPacks(loaded, []).packs.map((p) => p.id).sort(), loaded.packs.map((p) => p.id).sort());
    assert.deepEqual(dropUnavailablePreDispatchPacks(null, null).removed, []);
  });

  test('真服务器：这三个包**不存在** —— 不在 welcome.mods，数据也没进叠加层（裁剪在叠加层之前）', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: pruneWs });
    try {
      const w = srv.lobby.welcomeInfo();
      assert.deepEqual(w.mods.packs.map((p) => p.id).sort(), ['good-hook', 'no-hook'], '裁掉的包不得出现在线摘要里');
      const chess = await (await fetch(`${srv.url}/data/chess.json`)).json();
      assert.equal(Object.hasOwn(chess, 'chess_ws_no_factory'), false, '被裁的包的数据不得进叠加层');
      assert.equal(Object.hasOwn(chess, 'chess_ws_good_hook'), true, '好包的数据照旧进叠加层');
      assert.equal(Object.hasOwn(chess, 'chess_ws_no_hook'), true);
    } finally {
      await srv.close();
    }
  });

  test('启动日志点名：一条汇总，每个被裁的包带包 id 与拒绝码', async () => {
    const lines = [];
    const log = { info: (...a) => lines.push(String(a[0])), warn: (...a) => lines.push(String(a[0])), error: () => {}, debug: () => {} };
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: pruneWs, log });
    try {
      const dropped = lines.filter((l) => l.startsWith('[workshop] dropped') && l.includes('cannot be installed'));
      assert.equal(dropped.length, 1, lines.join('\n'));
      for (const id of ['broken-syntax', 'no-factory', 'throws']) assert.match(dropped[0], new RegExp(`"${id}" \\(PREDISPATCH_BAD_MODULE\\)`));
      assert.match(dropped[0], /dropped 3 pack\(s\)/);
      // 好包照旧有钩子装上（这一刀不是「拒绝一切」）
      assert.equal(srv.lobby.welcomeInfo().mods.packs.length, 2);
    } finally {
      await srv.close();
    }
  });

  test('回归：B3a 的同步判据一条都没变（坏模块/坏策略/未知类型照旧在装载期整包拒绝）', async () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const listed = loaded.packs.map((p) => p.id);
    for (const [id, code] of [
      ['hook-missing-module', 'PREDISPATCH_BAD_MODULE'],
      ['hook-missing-policy', 'PREDISPATCH_BAD_POLICY'],
      ['hook-bad-policy', 'PREDISPATCH_BAD_POLICY'],
      ['hook-unknown-type', 'PREDISPATCH_UNKNOWN_TYPE'],
    ]) {
      assert.equal(listed.includes(id), false, `${id} 不得进 loaded.packs`);
      assert.match(loaded.errors.find((e) => e.pack === id).reason, new RegExp(`^${code}: `));
    }
    // 已经在装载期被拒的包不会出现在 loadWorkshopHooks 的错误里（它的 packs 里根本没有它）
    const { errors } = await loadWorkshopHooks(loaded, { log: quiet });
    assert.deepEqual(errors.filter((e) => e.pack.startsWith('hook-')), []);
  });
});

// ---------------------------------------------------------------------------------------------------
// 10. 浏览器路径（真 SW / 真 import / 渲染 / CSS 叠放）：本机跑不了，默认跳过
// ---------------------------------------------------------------------------------------------------
//
// **这些用例从来没有在本机跑过**（这台机器没有 Chrome，见 B4 报告「未解决项」）。它们写在这里是**待办清单**，
// 不是验收证据：`SP_E2E=1` + 有 Chrome 的机器上才会执行，而执行之前谁都不许把它们说成「验过了」。
// 本刀能在那台机器之外钉住的都钉住了：注册参数（`navigator.serviceWorker.register` 的入参逐字）、声明归一化、
// 容器字节、逐文件校验、SW 的应答选择规则（`service.js` 的纯函数部分）—— 剩下的是「浏览器真的按这些规则跑」：
// SW 的生命周期与作用域、真实 `caches` 的配额行为、`<input type=file>` 给出的 `File`、面板模块的真
// `import()`、以及挂载之后的渲染与样式叠放。
const BROWSER_E2E = process.env.SP_E2E === '1';

describe('浏览器路径：真 Service Worker / 真 import / 渲染（未验证，默认跳过）',
  { skip: BROWSER_E2E ? false : 'set SP_E2E=1 and run on a machine with Chrome (this box has none)' }, () => {
    test('真注册：`/resource-sw.js` 以 module + scope "/" 注册并接管，`/assets/**` 由 SW 应答', () => {
      // 真正实现要 puppeteer 驱动（本机没有 Chrome，所以这一段从未运行过）：
      //   1. 起 `startServer({ workshopDir })`，让 welcome 带上 `modAssets`；
      //   2. `page.goto(url)`，等 `navigator.serviceWorker.ready` 与 `controllerchange`；
      //   3. 断言 `(await navigator.serviceWorker.getRegistration('/')).scope === location.origin + '/'`；
      //   4. `fetch('/assets/demo-0.bin')` → 412（未导入）；用 host 的 `importFromServer` 导入之后 → 200 且
      //      `x-sp-resource: 1`；
      //   5. `cache-only` 部署下服务端对 `/assets/demo-0.bin` 回 412，而页面里同一个 URL 由 SW 回 200。
      assert.ok(false, 'not implemented on this machine (no Chrome)');
    });

    test('真 import：包的 C 层面板模块挂到 slot、渲染出导入界面、CSS 与既有组件不撞', () => {
      assert.ok(false, 'not implemented on this machine (no Chrome)');
    });
  });
