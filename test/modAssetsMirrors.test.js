// test/modAssetsMirrors.test.js — 第 5 刀：**素材加载源**（DESIGN §28.40，docs/WORKSHOP.md §1.21）。
//
// 这一格由两半组成，缺一半都不成立：
//   * **`pack.json.assets.mirrors[]`** —— 作者自备 CDN 承载**本包自己的容器**。形状层判形态（绝对 `https://`、
//     尾斜杠、无凭据、`sha256` 是 64 位小写 hex、id 唯一、至多 4 条、字段闭集），装载期把每条的 `sha256` 与
//     **从包内文件算出来的**容器摘要比对 —— 对不上的那条**停用并点名**（不拒包）。
//   * **`sources(ctx)`** —— 面板模块的一个导出，与 `appearance(ctx)` 同族：进程内最多一个，只回答「先试哪一条」。
//     它**结构上不可能引入主机名**：只许回已声明 id 的排列 / 子集，喂一个主机名或 URL 进去 ⇒
//     `CLIENT_SOURCES_BAD_ORDER`，整条顺序作废。地址只在 `pack.json`。
//
// 三条不变量在这份文件里各有断言：
//   1. **默认逐字节不变**：不声明 `mirrors` 的包，归一化结果里没有这个键；`welcome.modAssets` 也没有这个字段；
//      客户端的请求 URL 与次序与从前逐字相同。
//   2. **服务端一次网络请求都不发**：镜像的字节由客户端取（`importFromServer`），`loadWorkshop` 只做
//      「声明与包内字节是不是同一份」这个**比对**。
//   3. **次序不许改**：先核整包 sha256（必须 `checked && ok`）⇒ 再走既有逐文件 SHA-1[0:12]。任何一步不过就换
//      下一条；全都不行 ⇒ 回落包内那条 `/workshop-resources/…` URL 并**点名**（不静默、不空白）。
//
// Run: node --test test/modAssetsMirrors.test.js
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  normalizePackManifest, ASSETS_MIRROR_FIELDS, ASSETS_MIRROR_MAX, ASSETS_MIRROR_ID_RE,
} from '../shared/workshop.js';
import { assetsMirrorIssues, loadWorkshop } from '../server/workshop.js';
import { workshopModAssetsFrom } from '../server/http/workshop.js';
import { computeVersion, sha1_12 } from '../tools/spresources.mjs';
import { makePack } from '../tools/make-spresources.mjs';
import {
  normalizeModAsset, installModAssets, importFromServer, modAssetDeclarations, modAssetsFor,
} from '../public/js/resources/host.js';
import { verifyContainerBytes } from '../public/js/resources/verify.js';
import {
  orderDeclared, setSourceOrder, clearSourceOrder, sourcesEnabled, setSourcesEnabled,
  resetSourcesState, currentSourceOrderer, sourcesRegistrationRefused, markSourcesRegistrationRefused,
} from '../public/js/resources/sources.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const hex = (b) => createHash('sha256').update(b).digest('hex');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const DECL = Object.freeze({ container: 'packs/r-0.1.0.spresources', manifest: 'resource-manifest.json' });
const MIRROR = (over = {}) => ({ id: 'fast', base: 'https://cdn.example.com/ak/r-0.1.0/', sha256: SHA_A, ...over });
const norm = (assets) => normalizePackManifest({ id: 'mirror-pack', version: '0.1.0', license: 'CC0-1.0', assets }, 'mirror-pack', {});

// ---------------------------------------------------------------------------------------------------
// 1. 形状层（`shared/workshop.js parseAssetsMirrors`）
// ---------------------------------------------------------------------------------------------------
describe('§28.40 形状：assets.mirrors[] 的判据（每一条都点名）', () => {
  test('不声明 mirrors ⇒ 归一化结果里**没有**这个键（默认逐字不变）', () => {
    const r = norm({ ...DECL });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(Object.keys(r.pack.assets).sort(), ['container', 'manifest', 'serverPolicy', 'verify']);
    assert.equal('mirrors' in r.pack.assets, false, '给每个包都加一个 mirrors: [] 会换掉所有已发布包的哈希');
  });

  test('声明一条合法镜像 ⇒ 逐字段出现，字段闭集就是那三个', () => {
    const r = norm({ ...DECL, mirrors: [MIRROR()] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.pack.assets.mirrors, [{ id: 'fast', base: 'https://cdn.example.com/ak/r-0.1.0/', sha256: SHA_A }]);
    assert.deepEqual([...ASSETS_MIRROR_FIELDS], ['id', 'base', 'sha256']);
    assert.equal(ASSETS_MIRROR_MAX, 4);
    assert.equal(ASSETS_MIRROR_ID_RE.test('fast'), true);
  });

  test('十六种坏写法各回一个具名拒绝码', () => {
    /** @type {Array<[string, any, string]>} */
    const cases = [
      ['未知字段', [{ ...MIRROR(), host: 'x' }], 'ASSETS_MIRROR_UNKNOWN_FIELD'],
      ['不是对象', ['https://cdn.example.com/'], 'ASSETS_MIRROR_BAD_SHAPE'],
      ['空数组', [], 'ASSETS_MIRROR_BAD_SHAPE'],
      ['不是数组', 'x', 'ASSETS_MIRROR_BAD_SHAPE'],
      ['http:', [{ ...MIRROR(), base: 'http://cdn.example.com/ak/' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['协议相对', [{ ...MIRROR(), base: '//cdn.example.com/ak/' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['data:', [{ ...MIRROR(), base: 'data:text/plain,' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['file:', [{ ...MIRROR(), base: 'file:///tmp/' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['带凭据', [{ ...MIRROR(), base: 'https://user:pw@cdn.example.com/ak/' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['带查询', [{ ...MIRROR(), base: 'https://cdn.example.com/ak/?x=1' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['少尾斜杠', [{ ...MIRROR(), base: 'https://cdn.example.com/ak' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['没有主机', [{ ...MIRROR(), base: 'https://' }], 'ASSETS_MIRROR_BAD_BASE'],
      ['摘要大写', [{ ...MIRROR(), sha256: 'A'.repeat(64) }], 'ASSETS_MIRROR_BAD_DIGEST'],
      ['摘要长度不对', [{ ...MIRROR(), sha256: 'a'.repeat(63) }], 'ASSETS_MIRROR_BAD_DIGEST'],
      ['id 大写', [{ ...MIRROR(), id: 'Fast' }], 'ASSETS_MIRROR_BAD_ID'],
      ['id 以数字开头', [{ ...MIRROR(), id: '1fast' }], 'ASSETS_MIRROR_BAD_ID'],
      ['id 重复', [MIRROR(), MIRROR()], 'ASSETS_MIRROR_DUPLICATE_ID'],
      ['超量', [1, 2, 3, 4, 5].map((n) => MIRROR({ id: `m${n}` })), 'ASSETS_MIRROR_TOO_MANY'],
    ];
    for (const [what, mirrors, code] of cases) {
      const r = norm({ ...DECL, mirrors });
      assert.equal(r.ok, false, `${what}：本该被拒（${JSON.stringify(r)}）`);
      assert.equal(r.error, code, `${what}：拒绝码不对 —— ${r.detail}`);
    }
  });

  test('声明了 mirrors 就必须写 license（再分发那条理由与 voiceCdn 逐字相同）', () => {
    const strip = { id: 'p', version: '0.1.0', assets: { ...DECL, mirrors: [MIRROR()] } };
    const r = normalizePackManifest(strip, 'p', {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ASSETS_MIRROR_NEEDS_LICENSE');
    // 没声明 mirrors 的包**不**受这一条影响：与从前逐字相同。
    const plain = normalizePackManifest({ id: 'p', version: '0.1.0', assets: { ...DECL } }, 'p', {});
    assert.equal(plain.ok, true, JSON.stringify(plain));
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 装载期：摘要比对（服务端**不发网络请求**）
// ---------------------------------------------------------------------------------------------------
describe('§28.40 装载期：镜像的 sha256 必须等于包内容器的摘要', () => {
  test('assetsMirrorIssues：相等即放行、不等即停用、没有摘要可比的如实报出来', () => {
    const pack = {
      assets: {
        mirrors: [
          { id: 'ok', base: 'https://ok.example/', sha256: SHA_A },
          { id: 'bad', base: 'https://bad.example/', sha256: SHA_B },
        ],
      },
    };
    const issues = assetsMirrorIssues(pack, SHA_A);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, 'bad');
    assert.equal(issues[0].code, 'ASSETS_MIRROR_DIGEST_MISMATCH');
    assert.match(issues[0].reason, /may only serve the very bytes this pack ships/);
    // 没声明 mirrors ⇒ 什么都不判（没声明这一格的包一个字节都不受影响）
    assert.deepEqual(assetsMirrorIssues({ assets: { ...DECL } }, SHA_A), []);
    assert.deepEqual(assetsMirrorIssues(null, SHA_A), []);
    assert.deepEqual(assetsMirrorIssues({ assets: { mirrors: [] } }, SHA_A), []);
    // 拿不到容器摘要（容器不可用）⇒ 如实说「没得比」，不假装通过
    const noDigest = assetsMirrorIssues(pack, null);
    assert.equal(noDigest.length, 2);
    assert.equal(noDigest[0].code, 'ASSETS_MIRROR_NO_DIGEST');
  });

  test('loadWorkshop：与包内容器不符的那条**停用并点名**，包照旧加载（不拒包）', () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-mirrors-load-'));
    const root = join(tmp, 'ws');
    const dir = join(root, 'ok-mirror');
    const bytes = Buffer.from('SPRES001-plus-some-body', 'utf8');
    const digest = hex(bytes);
    fs.mkdirSync(join(dir, 'packs'), { recursive: true });
    fs.writeFileSync(join(dir, 'packs', 'r-0.1.0.spresources'), bytes);
    fs.writeFileSync(join(dir, 'packs', 'r-0.1.0.spresources.sha256'), `${digest}  r-0.1.0.spresources\n`);
    fs.writeFileSync(join(dir, 'resource-manifest.json'), '{"format":1,"version":"x","files":[]}');
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'ok-mirror', version: '0.1.0', license: 'CC0-1.0',
      assets: {
        ...DECL,
        mirrors: [
          { id: 'good', base: 'https://cdn.example.com/a/', sha256: digest },
          { id: 'bad', base: 'https://cdn.example.com/b/', sha256: SHA_B },
        ],
      },
    }));
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['ok-mirror'], '镜像不符**不拒包**（§28.35 的「宁少不拒」）');
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0].reason, /^ASSETS_MIRROR_DIGEST_MISMATCH: /);
    assert.match(loaded.errors[0].reason, /\["bad"\]/);
    assert.deepEqual(loaded.packs[0].assets.mirrors.map((m) => m.id), ['good'], '交给客户端的声明里只剩可用的那条');
    assert.equal(loaded.packs[0].assetsDigest, digest);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('多包共用同一个镜像 base 与同一个容器文件名：判定按**各自包内字节**做，互不误伤', async () => {
    // 两个包的容器字节不同，而 `mirrors[].base` 与包内文件名**逐字相同** ⇒ 镜像 URL 撞在一起。规则是硬的：
    // 装载期只拿「这条声明」与**本包**的容器摘要比，所以两条声明各自成立、谁都不被停用（没有跨包误伤）；
    // 而客户端那边用的是**本包**的 `decl.digest` ⇒ 同一台主机送错字节会被当场判死（最后两条断言）。
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-mirrors-multi-'));
    const root = join(tmp, 'ws');
    const mk = (id, bytes, declared) => {
      const dir = join(root, id);
      const digest = hex(bytes);
      fs.mkdirSync(join(dir, 'packs'), { recursive: true });
      fs.writeFileSync(join(dir, 'packs', 'r-0.1.0.spresources'), bytes);
      fs.writeFileSync(join(dir, 'packs', 'r-0.1.0.spresources.sha256'), `${digest}  r-0.1.0.spresources\n`);
      fs.writeFileSync(join(dir, 'resource-manifest.json'), '{"format":1,"version":"x","files":[]}');
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
        id, version: '0.1.0', license: 'CC0-1.0',
        assets: { ...DECL, mirrors: [{ id: 'shared', base: 'https://cdn.example.com/x/', sha256: declared ?? digest }] },
      }));
      return { digest, bytes };
    };
    const bytesA = Buffer.from('SPRES001-AAAA', 'utf8');
    const bytesB = Buffer.from('SPRES001-BBBB', 'utf8');
    const bytesC = Buffer.from('SPRES001-CCCC', 'utf8');
    const a = mk('pack-a', bytesA);
    const b = mk('pack-b', bytesB);
    mk('pack-c', bytesC, a.digest);              // c 抄了 a 的摘要 ⇒ 只有 c 那条该停用
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['pack-a', 'pack-b', 'pack-c'], '镜像声明不符**不拒包**');
    assert.deepEqual(loaded.packs.find((p) => p.id === 'pack-a').assets.mirrors.map((m) => m.id), ['shared']);
    assert.deepEqual(loaded.packs.find((p) => p.id === 'pack-b').assets.mirrors.map((m) => m.id), ['shared'], '同一条 URL 撞车不误伤 b');
    assert.deepEqual(loaded.packs.find((p) => p.id === 'pack-c').assets.mirrors, [], '抄错摘要的那一条只停用它自己');
    assert.equal(loaded.errors.length, 1);
    assert.equal(loaded.errors[0].pack, 'pack-c', '点名的必须是声明错了的那一个包');
    assert.match(loaded.errors[0].reason, /^ASSETS_MIRROR_DIGEST_MISMATCH: /);
    // 客户端那一半：同一个 URL 上的字节如果是**别人**那份，`verifyContainerBytes` 当场判死（不会「先导入再说」）。
    const fileLike = (buf) => ({ size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    assert.deepEqual(await verifyContainerBytes(fileLike(bytesA), a.digest), { checked: true, ok: true, actual: a.digest });
    const crossed = await verifyContainerBytes(fileLike(bytesB), a.digest);
    assert.equal(crossed.checked, true);
    assert.equal(crossed.ok, false, 'b 的字节配上 a 的摘要 ⇒ 不许用');
    assert.equal(crossed.actual, b.digest);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('welcome.modAssets：声明了才带 mirrors，且字段就是那三个', () => {
    const files = new Map([
      ['a#c', { kind: 'container', pack: 'a', url: '/workshop-resources/a/packs/r-0.1.0.spresources', sha256: SHA_A }],
      ['a#m', { kind: 'manifest', pack: 'a', url: '/workshop-resources/a/resource-manifest.json', sha256: null }],
    ]);
    const withMirrors = workshopModAssetsFrom(files, [{
      id: 'a', assetsDigest: SHA_A,
      assets: { serverPolicy: 'serve', verify: 'sha256', mirrors: [{ id: 'fast', base: 'https://cdn.example.com/ak/', sha256: SHA_A }] },
    }]);
    assert.equal(withMirrors.length, 1);
    assert.deepEqual(Object.keys(withMirrors[0]).sort(), ['container', 'digest', 'manifest', 'mirrors', 'pack', 'serverPolicy', 'verify']);
    assert.deepEqual(withMirrors[0].mirrors, [{ id: 'fast', base: 'https://cdn.example.com/ak/', sha256: SHA_A }]);
    // 没声明 mirrors 的包：这一条 `welcome` 帧与从前**逐字段相同**（没有 mirrors 这个键）
    const plain = workshopModAssetsFrom(files, [{ id: 'a', assetsDigest: SHA_A, assets: { serverPolicy: 'serve', verify: 'sha256' } }]);
    assert.deepEqual(Object.keys(plain[0]).sort(), ['container', 'digest', 'manifest', 'pack', 'serverPolicy', 'verify']);
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. 排序面（`public/js/resources/sources.js`）—— 与 appearance 同构，且**不可能**引入主机名
// ---------------------------------------------------------------------------------------------------
describe('§28.40 sources(ctx)：只排序，不点名主机', () => {
  afterEach(() => resetSourcesState());

  const MIRRORS = Object.freeze([
    Object.freeze({ id: 'a', base: 'https://a.example/', sha256: SHA_A }),
    Object.freeze({ id: 'b', base: 'https://b.example/', sha256: SHA_A }),
    Object.freeze({ id: 'c', base: 'https://c.example/', sha256: SHA_A }),
  ]);

  test('没有提供者 ⇒ 声明顺序；空 / null 输入 ⇒ 空顺序（一个没声明 mirrors 的包连这一步都不到）', () => {
    assert.equal(currentSourceOrderer(), null);
    assert.deepEqual(orderDeclared(MIRRORS), { ids: ['a', 'b', 'c'], refusals: [] });
    assert.deepEqual(orderDeclared(null), { ids: [], refusals: [] });
    assert.deepEqual(orderDeclared([]), { ids: [], refusals: [] });
    // 形态不对的条目由 `usableMirror` 挡在外面（形状层已经判过，这里是第二个读者）
    assert.deepEqual(orderDeclared([{ id: 'x', base: 'http://x/', sha256: SHA_A }, null]).ids, []);
  });

  test('提供者可以重排，也可以只留一个子集；剩下的按声明顺序补在后面', () => {
    setSourceOrder(() => ['c'], 'pack/p1');
    assert.equal(currentSourceOrderer(), 'pack/p1');
    assert.deepEqual(orderDeclared(MIRRORS), { ids: ['c', 'a', 'b'], refusals: [] });
    clearSourceOrder();
    setSourceOrder(() => ['b', 'a', 'c'], 'pack/p1');
    assert.deepEqual(orderDeclared(MIRRORS).ids, ['b', 'a', 'c']);
    clearSourceOrder();
    setSourceOrder(() => ['c', 'c', 'a'], 'pack/p1');
    assert.deepEqual(orderDeclared(MIRRORS).ids, ['c', 'a', 'b'], '重复 id 去重后仍是声明那些 id 的一个排列');
  });

  test('**喂一个主机名 / URL 进去必须被拒**（这一格存在的全部价值）', () => {
    for (const bad of [['https://evil.example/'], ['evil.example'], ['a', 'https://evil.example/'], [0], [null], ['https://a.example/']]) {
      clearSourceOrder();
      setSourceOrder(() => bad, 'pack/p1');
      const out = orderDeclared(MIRRORS);
      assert.deepEqual(out.ids, ['a', 'b', 'c'], `${JSON.stringify(bad)}：整条顺序必须作废，回落声明顺序`);
      assert.equal(out.refusals.length, 1);
      assert.equal(out.refusals[0].code, 'CLIENT_SOURCES_BAD_ORDER');
      assert.match(out.refusals[0].detail, /declared|host name/);
    }
  });

  test('抛错 / async / 非数组 / null 各自的结局：四种都点名，一种都不静默', () => {
    setSourceOrder(() => { throw new Error('boom'); }, 'pack/p1');
    assert.equal(orderDeclared(MIRRORS).refusals[0].code, 'CLIENT_SOURCES_THREW');
    clearSourceOrder();
    setSourceOrder(async () => ['a'], 'pack/p1');
    assert.equal(orderDeclared(MIRRORS).refusals[0].code, 'CLIENT_SOURCES_ASYNC');
    clearSourceOrder();
    setSourceOrder(() => 'a', 'pack/p1');
    assert.equal(orderDeclared(MIRRORS).refusals[0].code, 'CLIENT_SOURCES_BAD_ORDER');
    clearSourceOrder();
    setSourceOrder(() => null, 'pack/p1');
    assert.deepEqual(orderDeclared(MIRRORS), { ids: ['a', 'b', 'c'], refusals: [] }, 'null = 「我没什么可排的」，不是失败');
  });

  test('setSourceOrder：**首次调用者赢**（最多一个），注册读数可查', () => {
    assert.equal(setSourceOrder(() => ['a'], 'pack/one'), true);
    assert.equal(currentSourceOrderer(), 'pack/one');
    assert.equal(setSourceOrder(() => ['b'], 'pack/two'), false, '第二个提供者必须建立不起来');
    assert.equal(currentSourceOrderer(), 'pack/one', '先来的继续有效');
    assert.equal(setSourceOrder(null), false);
    assert.equal(sourcesRegistrationRefused(), false);
    markSourcesRegistrationRefused();
    assert.equal(sourcesRegistrationRefused(), true);
  });

  test('门控：默认开；关掉之后**仍然可读**（「一次都不问」是调用方那一个 if）', () => {
    assert.equal(sourcesEnabled(), true, '默认 true，与设置默认同值');
    setSourcesEnabled(false);
    assert.equal(sourcesEnabled(), false);
    setSourcesEnabled(true);
    assert.equal(sourcesEnabled(), true);
  });
});

// ---------------------------------------------------------------------------------------------------
// 4. 客户端第二读者（`normalizeModAsset`）
// ---------------------------------------------------------------------------------------------------
const PACK = 'mirror-e2e';
const ORIGIN = 'https://site.example';
const serverDecl = (mirrors, digest) => ({
  pack: PACK,
  container: `/workshop-resources/${PACK}/packs/r-0.1.0.spresources`,
  manifest: `/workshop-resources/${PACK}/resource-manifest.json`,
  digest,
  serverPolicy: 'serve',
  verify: 'sha256',
  ...(mirrors ? { mirrors } : {}),
});

describe('§28.40 客户端第二读者：normalizeModAsset 复判 mirrors', () => {
  test('合法 / 缺省 / 八种坏写法', () => {
    const good = normalizeModAsset(serverDecl([{ id: 'fast', base: 'https://fast.example/ak/', sha256: SHA_A }], SHA_A));
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.deepEqual(good.decl.mirrors, [{ id: 'fast', base: 'https://fast.example/ak/', sha256: SHA_A }]);
    assert.equal(Object.isFrozen(good.decl.mirrors[0]), true);
    const none = normalizeModAsset(serverDecl(null, SHA_A));
    assert.equal(none.ok, true);
    assert.equal('mirrors' in none.decl, false, '没声明就不该有这个键（这一帧逐字不变）');
    /** @type {Array<[string, any, string]>} */
    const bad = [
      ['未知字段', [{ id: 'f', base: 'https://f.example/', sha256: SHA_A, path: '/' }], 'MOD_ASSETS_BAD_MIRROR'],
      ['空数组', [], 'MOD_ASSETS_BAD_MIRROR'],
      ['http:', [{ id: 'f', base: 'http://f.example/', sha256: SHA_A }], 'MOD_ASSETS_BAD_MIRROR_BASE'],
      ['带凭据', [{ id: 'f', base: 'https://u:p@f.example/', sha256: SHA_A }], 'MOD_ASSETS_BAD_MIRROR_BASE'],
      ['少尾斜杠', [{ id: 'f', base: 'https://f.example', sha256: SHA_A }], 'MOD_ASSETS_BAD_MIRROR_BASE'],
      ['摘要不对', [{ id: 'f', base: 'https://f.example/', sha256: 'zz' }], 'MOD_ASSETS_BAD_MIRROR_DIGEST'],
      ['id 重复', [{ id: 'f', base: 'https://f.example/', sha256: SHA_A }, { id: 'f', base: 'https://g.example/', sha256: SHA_A }], 'MOD_ASSETS_BAD_MIRROR_ID'],
      ['超量', [1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, base: 'https://f.example/', sha256: SHA_A })), 'MOD_ASSETS_BAD_MIRROR'],
    ];
    for (const [what, mirrors, code] of bad) {
      const r = normalizeModAsset(serverDecl(mirrors, SHA_A));
      assert.equal(r.ok, false, `${what}：本该被拒`);
      assert.equal(r.code, code, `${what}：${r.detail}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 5. 端到端：选源、次序、回落（假 `CacheStorage`、按 URL 路由的假 `fetch`、真的容器）
// ---------------------------------------------------------------------------------------------------
/** 一个够真的假 `CacheStorage`（与 `test/modAssets.test.js` 那一份同形：取出即克隆）。 */
function fakeCaches() {
  /** @type {Map<string, Map<string, Response>>} */
  const stores = new Map();
  return {
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

describe('§28.40 端到端：镜像取字节、先核整包再逐文件、失败换下条、全败落包内', () => {
  /** @type {string} */
  let tmp;
  /** @type {{ containerBytes: Buffer, manifestBytes: Buffer, manifest: any }} */
  let built;
  /** @type {string} */
  let DIGEST;

  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-mirror-e2e-'));
    const srcDir = join(tmp, 'src');
    const entries = [
      { url: '/assets/demo-0.bin', body: Buffer.alloc(2048, 0x11), tier: 2 },
      { url: '/fonts/demo.woff2', body: Buffer.alloc(256, 0x33), tier: 1 },
    ];
    const files = [];
    for (const e of entries) {
      const abs = join(srcDir, ...e.url.split('/').filter(Boolean));
      fs.mkdirSync(dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.body);
      files.push({ url: e.url, size: e.body.length, hash: sha1_12(e.body), tier: e.tier });
    }
    const manifest = { format: 1, version: computeVersion(files), files };
    const manifestFile = join(tmp, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const outDir = join(tmp, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    makePack({ manifestFile, publicDir: srcDir, outDir, name: 'r-0.1.0' });
    built = {
      containerBytes: fs.readFileSync(join(outDir, 'packs', 'r-0.1.0.spresources')),
      manifestBytes: fs.readFileSync(join(outDir, 'resource-manifest.json')),
      manifest,
    };
    DIGEST = hex(built.containerBytes);
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  afterEach(() => resetSourcesState());

  const M = (id, over = {}) => ({ id, base: `https://${id}.example/ak/`, sha256: DIGEST, ...over });

  /** 全部路由：镜像那两条（`<base><包内文件名>`）与包内那两条（绝对 URL）。 */
  function routes({ mirrors = [], packUrl = true, container = built.containerBytes, manifest = built.manifestBytes } = {}) {
    const map = new Map();
    for (const id of mirrors) {
      map.set(`https://${id}.example/ak/r-0.1.0.spresources`, container);
      map.set(`https://${id}.example/ak/resource-manifest.json`, manifest);
    }
    if (packUrl) {
      map.set(`${ORIGIN}/workshop-resources/${PACK}/packs/r-0.1.0.spresources`, built.containerBytes);
      map.set(`${ORIGIN}/workshop-resources/${PACK}/resource-manifest.json`, built.manifestBytes);
    }
    return map;
  }
  /** 按 URL 路由的假 `fetch`：`/…` 按页面 origin 补成绝对 URL，其余原样查表；请求逐条记进 `calls`。 */
  function fakeFetch(map, calls) {
    return async (url) => {
      const raw = String(url);
      const key = raw.startsWith('/') ? `${ORIGIN}${raw}` : raw;
      calls.push(key);
      const hit = map.get(key);
      if (!hit) return new Response('not found', { status: 404, headers: { 'content-length': '9' } });
      return new Response(hit, { status: 200, headers: { 'content-length': String(hit.length) } });
    };
  }
  const install = (mirrors) => installModAssets([serverDecl(mirrors, DIGEST)], {});

  test('从镜像导入成功 ⇒ via 是那条 id，逐文件校验照旧通过，且**从不**碰包内那条 URL', async () => {
    install([M('fast')]);
    assert.deepEqual(modAssetsFor(PACK).mirrors.map((m) => m.id), ['fast']);
    const calls = [];
    const report = await importFromServer(PACK, { caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(routes({ mirrors: ['fast'] }), calls), deep: true, log: quiet });
    assert.equal(report.valid, true, JSON.stringify(report));
    assert.equal(report.via, 'fast');
    assert.deepEqual(report.refusals, []);
    assert.equal(report.count, 2);
    assert.equal(report.digest, DIGEST);
    assert.deepEqual(calls.slice().sort(), [
      'https://fast.example/ak/r-0.1.0.spresources',
      'https://fast.example/ak/resource-manifest.json',
    ], '成功时两条请求都打在镜像上');
  });

  test('`sources(ctx)` 真的决定次序：b 被排到 a 前面就先试 b', async () => {
    install([M('a'), M('b')]);
    setSourceOrder(() => ['b'], 'pack/e2e');
    const calls = [];
    const report = await importFromServer(PACK, { caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(routes({ mirrors: ['a', 'b'] }), calls), log: quiet });
    assert.equal(report.via, 'b');
    assert.equal(calls.every((u) => u.includes('b.example')), true, JSON.stringify(calls));
  });

  test('摘要不符 ⇒ 那条作废、换下一条；两条都不行 ⇒ 回落包内并**点名**（不静默、不空白）', async () => {
    // ① 第一条被换掉字节，第二条是好的
    install([M('evil'), M('good')]);
    const calls = [];
    const map1 = routes({ mirrors: ['evil', 'good'] });
    map1.set('https://evil.example/ak/r-0.1.0.spresources', Buffer.alloc(64, 0x99));
    const one = await importFromServer(PACK, { caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(map1, calls), log: quiet });
    assert.equal(one.via, 'good', '第一条不符 ⇒ 换下一条');
    assert.equal(one.valid, true);
    assert.equal(one.refusals.length, 1);
    assert.match(one.refusals[0], /^CLIENT_SOURCES_MIRROR_DIGEST_MISMATCH /);
    assert.match(one.refusals[0], /hash to .* but this pack's container is/);

    // ② 两条都不行 ⇒ 回落包内那条 `/workshop-resources/…`，并且逐条点名 + 一条 FALLBACK
    install([M('evil'), M('worse')]);
    const calls2 = [];
    const warns = [];
    const map2 = routes({ mirrors: ['evil', 'worse'] });
    map2.set('https://evil.example/ak/r-0.1.0.spresources', Buffer.alloc(64, 0x99));
    map2.set('https://worse.example/ak/resource-manifest.json', Buffer.from('{"format":1}'));
    const two = await importFromServer(PACK, {
      caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(map2, calls2),
      log: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
    });
    assert.equal(two.via, 'pack');
    assert.equal(two.valid, true, '回落之后照样导入成功：包内那份永远在');
    assert.equal(two.refusals.some((r) => r.startsWith('CLIENT_SOURCES_FALLBACK ')), true, JSON.stringify(two.refusals));
    assert.equal(warns.some((m) => m.includes('CLIENT_SOURCES_FALLBACK')), true, '必须点名，不许静默');
    assert.equal(calls2.some((u) => u.includes('/workshop-resources/')), true, '回落意味着真的去取了包内那条 URL');
    assert.match(two.refusals.find((r) => r.startsWith('CLIENT_SOURCES_FALLBACK')), /the load source is NOT the one the author asked for/);
  });

  test('**没核过整包摘要就不许用**（`checked: false` 换下一条），次序不许改', async () => {
    install([M('unverified'), M('good')]);
    const order = [];
    const verifyBytes = async (file, digest) => {
      order.push(digest);
      return { checked: false, ok: false, reason: 'too-large' };
    };
    const calls = [];
    const report = await importFromServer(PACK, {
      caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(routes({ mirrors: ['unverified', 'good'] }), calls),
      verifyBytes, log: quiet,
    });
    assert.equal(report.via, 'pack', '两条都「没核过」⇒ 谁都不许用 ⇒ 回落包内');
    assert.equal(report.refusals.filter((r) => r.startsWith('CLIENT_SOURCES_NOT_VERIFIED ')).length, 2);
    assert.match(report.refusals[0], /an unverified mirror is never used/);
    assert.deepEqual(order, [DIGEST, DIGEST], '每条镜像都要先问一次整包摘要（次序：先整包，再逐文件）');
    // 真实的那个上限：超过 256 MiB 的容器，`verifyContainerBytes` 如实回「没查」而不是假装查过。
    const huge = { size: 300 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) };
    assert.deepEqual(await verifyContainerBytes(huge, DIGEST), { checked: false, ok: false, reason: 'too-large' });
  });

  test('门控关掉 ⇒ 与「没声明 mirrors」**同一条**路径：镜像那条 URL 一次都不被请求', async () => {
    install([M('fast')]);
    setSourcesEnabled(false);
    const calls = [];
    const report = await importFromServer(PACK, { caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(routes({ mirrors: ['fast'] }), calls), log: quiet });
    assert.equal(report.valid, true, JSON.stringify(report));
    assert.equal('via' in report, false, '门控关掉时返回值的形状与「没声明 mirrors」逐字相同');
    assert.equal('refusals' in report, false);
    assert.equal(calls.some((u) => u.includes('.example/ak/')), false, `${JSON.stringify(calls)}：关掉之后一次都不许问镜像`);
  });

  test('没声明 mirrors 的包：请求的 URL 与次序与从前逐字相同（默认不变的那条断言）', async () => {
    install(null);
    const calls = [];
    const report = await importFromServer(PACK, { caches: fakeCaches(), origin: ORIGIN, fetchImpl: fakeFetch(routes({ mirrors: [] }), calls), log: quiet });
    assert.equal(report.valid, true);
    assert.equal('via' in report, false);
    assert.equal('refusals' in report, false);
    assert.deepEqual(calls, [
      `${ORIGIN}/workshop-resources/${PACK}/packs/r-0.1.0.spresources`,
      `${ORIGIN}/workshop-resources/${PACK}/resource-manifest.json`,
    ], '没有镜像 ⇒ 请求的 URL 与次序与从前逐字相同（先容器、再清单，与 B3a 同一条路）');
  });
});
