// test/packFileSet.test.js — 包身份清单 = 客户端下载清单 = 包目录下会被执行/读到的文件（DESIGN §28.2「业主裁决 B」）。
//
// 为什么需要这一组：B 之前清单是**一份声明清单**（pack.json + 内容文件 + kits/*.js + assets/** + 声明过的模块），
// 于是「一个被声明模块 import、自己却没被声明」的文件（`server/rules.mjs`、`client/helper.js`）**两份清单里都没有**
// —— 摘要不再等价于同一份行为，而且干净的客户端根本下不到它（服务端跑得好的包，浏览器里 import 解析不出来）。
// 这一组钉住 B 的四条：
//   1. 清单 = **包目录下的每一个普通文件**，没有任何按名字/目录的排除项（README.md / *.bak / test/** 也在里面）；
//   2. **未被声明的**文件进身份、进下载清单，而且真的改变摘要（两边同时看，才算"同一份清单"）；
//   3. 两份清单**同源**：catalogue 的文件列表 == 身份清单 == `server/packFiles.js listPackFiles`；
//   4. 没装任何包的装机行为逐字节不变（没有包 ⇒ `modSetOf` 为 `null`、catalogue 是 `{ packs: [] }`）。
// 另外，B 落地时暴露并修好了一条既有 P0：声明了 `assets` 的包，catalogue 从前丢掉那条合成的容器摘要行
// （那一行没有文件），于是客户端**永远重建不出**它的包摘要 —— 第 3 组把这一条也钉住。
//
// Run: node --test test/packFileSet.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadWorkshop } from '../server/workshop.js';
import { ASSETS_DIGEST_PATH, containerDigestBytes, listPackFiles } from '../server/packFiles.js';
import { buildModCatalog, catalogPackHash } from '../server/modCatalog.js';
import { createModsRoute, serveMods, MOD_FILE_PREFIX } from '../server/http/mods.js';
import { modSetOf } from '../shared/modIdentity.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** 一份最小合法包：`content: ['chess']` + 一份非空记录（否则装载器按 `EMPTY_PACK` 拒）。 */
const CHESS = { chess_ws_probe_a: { chessId: 'chess_ws_probe_a', name: 'probe' } };
const manifestOf = (id, extra = {}) => JSON.stringify({
  id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2', content: ['chess'], ...extra,
});

let tmp;
let wsRoot;
/** 一个"会成长"的包：用来证明**新增一个未被声明的文件**会改变身份、并且出现在两份清单里。 */
let grownDir;

/** Write one file under `dir`, creating its parent directories. */
function write(dir, rel, body) {
  const abs = join(dir, ...rel.split('/'));
  fs.mkdirSync(join(abs, '..'), { recursive: true });
  fs.writeFileSync(abs, body);
}

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-fileset-'));
  wsRoot = join(tmp, 'ws');
  // 1. 一份普通数据包
  const plain = join(wsRoot, 'plain-pack');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(join(plain, 'pack.json'), manifestOf('plain-pack'));
  fs.writeFileSync(join(plain, 'chess.json'), JSON.stringify(CHESS));
  // 2. 一个"会成长"的包（本文件第一条断言用）
  grownDir = join(wsRoot, 'grown-pack');
  fs.mkdirSync(grownDir, { recursive: true });
  fs.writeFileSync(join(grownDir, 'pack.json'), manifestOf('grown-pack'));
  fs.writeFileSync(join(grownDir, 'chess.json'), JSON.stringify(CHESS));
  // 3. 声明了一个 `server.meta` 模块，而那个模块 import 两个**没被声明**的同包文件 —— 这就是 B 要堵的那个洞
  const withhelpers = join(wsRoot, 'helpers-pack');
  fs.mkdirSync(withhelpers, { recursive: true });
  fs.writeFileSync(join(withhelpers, 'pack.json'), manifestOf('helpers-pack', {
    // `server.meta` 能改对局结果，形状层因此要求这个包显式声明 `combat: true`（MODULES_NEED_COMBAT, DESIGN §29）
    combat: true,
    server: { meta: { module: 'meta/x.mjs', registers: ['bond:x'] } },
  }));
  fs.writeFileSync(join(withhelpers, 'chess.json'), JSON.stringify(CHESS));
  write(withhelpers, 'meta/x.mjs', "import '../server/rules.mjs';\nimport '../data/rules.mjs';\nexport function registerMeta() {}\n");
  write(withhelpers, 'server/rules.mjs', 'export const RULE_V1 = 1;\n');
  write(withhelpers, 'data/rules.mjs', 'export const DATA_V1 = 1;\n');
  // 这些文件从前一份清单都不收；B 之后它们在两份清单里，所以顺手也钉住"没有任何按名字的排除项"
  write(withhelpers, 'README.md', '# helpers\n');
  write(withhelpers, 'pack.json.bak', 'STRAY-BACKUP\n');
  write(withhelpers, 'test/fixture.txt', 'a fixture the author kept\n');
  write(withhelpers, 'client/helper.js', 'export const helper = 1;\n');
  // 4. 声明了 `assets` 的包：容器 + 旁挂 .sha256 + 清单（B3a 段要求声明与文件都在）
  const respack = join(wsRoot, 'res-pack');
  fs.mkdirSync(join(respack, 'packs'), { recursive: true });
  const container = 'packs/resources-0.1.0.spresources';
  const bytes = Buffer.from('SPRES001 fake demo container for the loader gate\n', 'utf8');
  fs.writeFileSync(join(respack, 'pack.json'), manifestOf('res-pack', {
    assets: { container, manifest: 'resource-manifest.json' },
  }));
  fs.writeFileSync(join(respack, 'chess.json'), JSON.stringify(CHESS));
  write(respack, container, bytes);
  write(respack, `${container}.sha256`, `${sha256(bytes)}  resources-0.1.0.spresources\n`);
  write(respack, 'resource-manifest.json', '{ "format": 1, "files": [] }');
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** Load the fixture root and return `id → pack entry`. */
function load(ids = null) {
  const loaded = loadWorkshop(wsRoot, { log: quiet });
  assert.deepEqual(loaded.errors, [], 'the fixture must load without errors');
  if (!ids) return loaded;
  const out = {};
  for (const id of ids) out[id] = loaded.packs.find((p) => p.id === id);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// 1. 清单 = 包目录下的每一个普通文件（排除项：无）
// ---------------------------------------------------------------------------------------------------
describe('裁决 B：清单是**目录**，不是声明（排除项：无）', () => {
  test('包目录里新增一个**未被声明**的同目录文件（client/helper.js）⇒ 身份哈希改变，且它出现在两份清单里', (t) => {
    const before = load().packs.find((p) => p.id === 'grown-pack');
    const hashBefore = before.hash;
    const listBefore = listPackFiles(grownDir);

    // 作者只是往包里放了一个同目录的 helper —— 没有任何声明指向它
    write(grownDir, 'client/helper.js', 'export const helper = 1;\n');

    const loaded = load();
    const after = loaded.packs.find((p) => p.id === 'grown-pack');
    const hashAfter = after.hash;
    const listAfter = listPackFiles(grownDir);
    const catalogue = buildModCatalog(loaded).packs.find((p) => p.id === 'grown-pack');

    assert.deepEqual(listBefore, ['chess.json', 'pack.json'], 'B 之前之后，清单就是目录里那两个文件');
    assert.deepEqual(listAfter, ['chess.json', 'client/helper.js', 'pack.json'], '新增的文件按路径排序进入清单（确定性）');
    assert.ok(after.manifest.some((m) => m.path === 'client/helper.js'), '身份清单里有它');
    assert.ok(catalogue.files.some((f) => f.path === 'client/helper.js'), '下载清单里有它（干净的客户端下得到）');
    assert.notEqual(hashAfter, hashBefore, '同一个摘要不能描述两份不同的包');
    // 它自己那一行的 `sha256` 与 `canonical` 都是它的字节 —— 它是普通文件，没有归一化那回事
    const row = catalogue.files.find((f) => f.path === 'client/helper.js');
    const onDisk = fs.readFileSync(join(grownDir, 'client', 'helper.js'));
    assert.equal(row.sha256, sha256(onDisk));
    assert.equal(row.canonical, row.sha256);
    assert.equal(row.bytes, onDisk.length);
    // 报告用的原始数字（`node --test` 会把 diagnostic 原样打出来）
    t.diagnostic(`identity without client/helper.js = ${hashBefore}`);
    t.diagnostic(`identity with    client/helper.js = ${hashAfter}`);
    t.diagnostic(`identity manifest (before) = ${JSON.stringify(before.manifest.map((m) => m.path))}`);
    t.diagnostic(`identity manifest (after)  = ${JSON.stringify(after.manifest.map((m) => m.path))}`);
    // 复原，别影响别的用例
    fs.rmSync(join(grownDir, 'client'), { recursive: true, force: true });
    assert.equal(load().packs.find((p) => p.id === 'grown-pack').hash, hashBefore, '删掉那个文件，摘要回到原值');
  });

  test('被声明模块 import 的、自己没被声明的文件（server/rules.mjs、data/rules.mjs）也在两份清单里', () => {
    const loaded = load();
    const pack = loaded.packs.find((p) => p.id === 'helpers-pack');
    const catalogue = buildModCatalog(loaded).packs.find((p) => p.id === 'helpers-pack');
    const paths = pack.manifest.map((m) => m.path);
    for (const rel of ['meta/x.mjs', 'server/rules.mjs', 'data/rules.mjs']) {
      assert.ok(paths.includes(rel), `${rel} 必须在身份清单里：${paths.join(', ')}`);
      assert.ok(catalogue.files.some((f) => f.path === rel), `${rel} 必须在下载清单里`);
    }
    // 声明本身仍然改变哈希（走 `pack.json` 的归一化清单那一条腿）—— 两条腿都在，缺一不可
    assert.equal(pack.server.meta.module, 'meta/x.mjs');
  });

  test('没有任何按名字的排除项：README.md / pack.json.bak / test/** 也是包的一部分', () => {
    const loaded = load();
    const pack = loaded.packs.find((p) => p.id === 'helpers-pack');
    const catalogue = buildModCatalog(loaded).packs.find((p) => p.id === 'helpers-pack');
    for (const rel of ['README.md', 'pack.json.bak', 'test/fixture.txt', 'client/helper.js']) {
      assert.ok(pack.manifest.some((m) => m.path === rel), `${rel} 在身份清单里（排除项为空是有意的）`);
      assert.ok(catalogue.files.some((f) => f.path === rel), `${rel} 在下载清单里`);
    }
    // 而包目录**之外**的东西一条都不进来：工作树根下的文件与 `..` 都不可达
    assert.equal(pack.manifest.some((m) => m.path.includes('..')), false);
  });

  test('确定性：同一份字节、不同的建包顺序与目录位置 ⇒ 同一个摘要；清单按路径排序', () => {
    const a = fs.mkdtempSync(join(tmpdir(), 'sp-fileset-a-'));
    const b = fs.mkdtempSync(join(tmpdir(), 'sp-fileset-b-'));
    try {
      const rels = ['pack.json', 'chess.json', 'z/last.txt', 'a/first.txt', 'm/mid.txt'];
      for (const root of [a, b]) fs.mkdirSync(join(root, 'det-pack'), { recursive: true });
      for (const rel of rels) write(join(a, 'det-pack'), rel, rel === 'pack.json' ? manifestOf('det-pack') : rel === 'chess.json' ? JSON.stringify(CHESS) : `body of ${rel}\n`);
      for (const rel of [...rels].reverse()) write(join(b, 'det-pack'), rel, rel === 'pack.json' ? manifestOf('det-pack') : rel === 'chess.json' ? JSON.stringify(CHESS) : `body of ${rel}\n`);
      const pa = loadWorkshop(a, { log: quiet }).packs.find((p) => p.id === 'det-pack');
      const pb = loadWorkshop(b, { log: quiet }).packs.find((p) => p.id === 'det-pack');
      assert.equal(pa.hash, pb.hash, '同一份字节在任何机器/任何建包顺序上都哈希相同');
      assert.deepEqual(listPackFiles(join(a, 'det-pack')), ['a/first.txt', 'chess.json', 'm/mid.txt', 'pack.json', 'z/last.txt'],
        '清单是按路径排序的（递归结果也要全局有序，不能只是每层有序）');
      assert.deepEqual(pa.manifest.map((m) => m.path), [...pa.manifest.map((m) => m.path)].sort(), '身份清单同样有序');
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. 两份清单同源（B 的核心）
// ---------------------------------------------------------------------------------------------------
describe('裁决 B：catalogue 的文件列表 == 身份清单 == listPackFiles', () => {
  test('每一个包：三条路给出**同一个集合**（含子目录、含未声明文件、含声明了 assets 的包）', () => {
    const loaded = load();
    const catalogue = buildModCatalog(loaded);
    assert.deepEqual(catalogue.packs.map((p) => p.id), ['grown-pack', 'helpers-pack', 'plain-pack', 'res-pack']);
    for (const pack of loaded.packs) {
      const entry = catalogue.packs.find((p) => p.id === pack.id);
      const files = entry.files.map((f) => f.path);
      const identity = pack.manifest.map((m) => m.path);
      const shared = listPackFiles(pack.dir);
      // 只有那条合成的容器摘要行不是文件；其余每一个路径都必须是共享枚举器给出的那个
      const identityFiles = identity.filter((p) => p !== ASSETS_DIGEST_PATH);
      assert.deepEqual(identityFiles, shared, `${pack.id}: 身份清单 == listPackFiles`);
      assert.deepEqual(files, identity, `${pack.id}: 下载清单 == 身份清单（同源，不能漂移）`);
      assert.deepEqual(files, [...files].sort(), `${pack.id}: 下载清单按路径排序`);
    }
  });

  test('声明了 `assets` 的包：下载清单能重建它的身份哈希，保留行也是可下载的（B 落地时修掉的既有 P0）', async () => {
    const loaded = load();
    const pack = loaded.packs.find((p) => p.id === 'res-pack');
    const entry = buildModCatalog(loaded).packs.find((p) => p.id === 'res-pack');
    assert.equal(typeof pack.assetsDigest, 'string');
    // 修之前：catalogue 丢掉那条没有文件的合成行 ⇒ 这个等式是 false ⇒ 客户端永远证明不了自己持有这个包
    assert.equal(catalogPackHash(entry.files), entry.hash, 'catalogue 独力重建出装载器的包哈希');
    const row = entry.files.find((f) => f.path === ASSETS_DIGEST_PATH);
    assert.ok(row, '合成行必须发布，否则客户端重建不出摘要');
    assert.equal(row.canonical, pack.assetsDigest, '它的贡献就是容器摘要');
    assert.equal(row.sha256, sha256(containerDigestBytes(pack.assetsDigest)), '它的载荷是那 64 个十六进制字符');
    assert.equal(row.bytes, 64);
    // 容器本身也在清单里（B：它在包目录里），所以客户端既下得到容器、也下得到它的摘要行
    assert.ok(entry.files.some((f) => f.path === pack.assets.container));
    // 路由真的把它交出来（否则 `sync` 会在这一行上永远失败，客户端仍旧"没有这个 mod"）
    const routes = createModsRoute(loaded, { packs: [entry] });
    const res = { status: 0, headers: null, body: null, headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body) { this.body = body; } };
    const handled = serveMods({ method: 'GET', headers: {} }, res, `${MOD_FILE_PREFIX}res-pack/${ASSETS_DIGEST_PATH}`, '', routes);
    assert.equal(handled, true);
    for (let i = 0; i < 5000 && !res.headersSent; i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(res.status, 200, '合成行是可下载的');
    assert.equal(sha256(Buffer.from(res.body)), row.sha256, '下载到的字节与服务端声明的 sha256 一致');
    assert.equal(Buffer.from(res.body).toString('utf8'), pack.assetsDigest);
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. 没装任何包：行为逐字节不变
// ---------------------------------------------------------------------------------------------------
describe('裁决 B：没装任何包的装机一个字不变', () => {
  test('空的 workshop ⇒ 没有包、没有 mod 集合、catalogue 是空表', () => {
    const empty = join(tmp, 'empty-ws');
    fs.mkdirSync(empty, { recursive: true });
    const loaded = loadWorkshop(empty, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs, []);
    assert.equal(modSetOf(loaded.packs.map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }))), null,
      '没装包 ⇒ modSet 为 null（welcome 因此不带 mods，既有链路的判据）');
    assert.deepEqual(buildModCatalog(loaded), { packs: [] }, 'catalogue 仍是空表这个形状');
    assert.deepEqual(buildModCatalog(null), { packs: [] }, '连装载结果都没有时也一样');
  });
});
