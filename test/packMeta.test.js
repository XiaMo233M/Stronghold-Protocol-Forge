// test/packMeta.test.js — 包的**对局元注册表**载荷（`pack.json.server.meta`，DESIGN §29）。
//
// 这一刀（A 段）只落**声明**：解析、点名拒绝、进身份哈希、装载期判「模块文件真的在不在」。**没有任何执行** ——
// 运行时装配（受限注册表 + 按房间 fork）是同一节的 B 段。所以本文件的断言分四组：
//   1. 形状：一张合法声明被接受并归一化；每一种写错都**点名**拒绝（含 `registers` 的键形状与通配规则）；
//   2. 语义闸门：`server.meta` 必须配 `combat: true`（业主裁决 2026-08-10 的落地）、`server: {}` 被拒、
//      只声明 `meta` 的包**是**一个合法包（贡献项）；
//   3. 身份：模块字节进内容哈希；**没声明 `server.meta` 的包哈希逐字节不变**（拿仓库里三份真实示例包对照）；
//   4. 接缝：装载期 `metaIssues` 判文件在不在；`MetaRegistry.fork()` 与原件互不影响（「禁止全局 set/restore」的落点）；
//      以及一条**反射钉**：`shared/workshop.js META_KEY_CLASSES` 必须与 `MetaRegistry` 的七个方法逐字相同
//      （两处真相会漂，所以用测试把它们钉在一起）。
//
// Run: node --test test/packMeta.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, META_KEY_CLASSES } from '../shared/workshop.js';
import { loadWorkshop, metaIssues, identifyPack } from '../server/workshop.js';
import { MetaRegistry } from '../server/match/effectsMeta.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 一份最小合法清单：`meta` 之外的一切都按最省写。 */
const base = (extra = {}) => ({
  id: 'meta-pack', name: 'Meta Pack', version: '1.0.0', license: 'CC0-1.0', description: 'x',
  gameVersion: '0.2.x', combat: true, ...extra,
});
const META = { module: 'meta/bonds.mjs', registers: ['bond:kazdelShip'] };
const okShape = (raw, note) => {
  const v = normalizePackManifest(raw, raw.id, { hasAssets: false });
  assert.equal(v.ok, true, `${note}: 应当被接受，实际 ${v.ok ? '' : `${v.error} — ${v.detail}`}`);
  return v.pack;
};
const refuses = (raw, code, note) => {
  const v = normalizePackManifest(raw, raw.id, { hasAssets: false });
  assert.equal(v.ok, false, `${note}: 应当被拒，实际被接受`);
  assert.equal(v.error, code, `${note}: 期待 ${code}，实际 ${v.error} — ${v.detail}`);
  return v;
};

describe('server.meta：形状与点名拒绝（A 段只做格式）', () => {
  test('一张合法声明被接受，并且 registers 归一化成排序去重后的列表', () => {
    const pack = okShape(base({ server: { meta: { module: 'meta/bonds.mjs', registers: ['garrison:custom_b', 'bond:kazdelShip'] } } }), '合法');
    assert.deepEqual(pack.server, { meta: { module: 'meta/bonds.mjs', registers: ['bond:kazdelShip', 'garrison:custom_b'] } });
  });

  test('`server.preDispatch` 与 `server.meta` 可以同时声明（两个成员，各自归一化）', () => {
    const pack = okShape(base({
      server: {
        preDispatch: { module: 'server/gate.mjs', policy: 'admit.json', intercepts: ['room.join'] },
        meta: META,
      },
    }), '两个成员');
    assert.deepEqual(Object.keys(pack.server).sort(), ['meta', 'preDispatch']);
    assert.deepEqual(pack.server.preDispatch.intercepts, ['room.join']);
  });

  test('只声明 `server.meta` 的包是一个合法包（贡献项），不是 EMPTY_PACK', () => {
    const pack = okShape(base({ server: { meta: META } }), '只声明 meta');
    assert.ok(pack.server.meta);
  });

  test('`server: {}` 被点名拒绝，而不是当成「什么都没声明」', () => {
    refuses(base({ server: {} }), 'SERVER_EMPTY_MEMBER', '空 server');
  });

  test('未知成员 / 未知字段都点名拒绝（不静默丢掉）', () => {
    refuses(base({ server: { preDispatch: 'nope', meta: META } }), 'PREDISPATCH_BAD_SHAPE', 'preDispatch 不是对象');
    refuses(base({ server: { meta: META, hooks: {} } }), 'SERVER_UNKNOWN_FIELD', 'server 的未知成员');
    refuses(base({ server: { meta: { ...META, hooks: [] } } }), 'META_UNKNOWN_FIELD', 'meta 的未知字段');
  });

  test('module 必须是包内相对路径、且必须是 .mjs', () => {
    refuses(base({ server: { meta: { ...META, module: '/abs/x.mjs' } } }), 'META_BAD_PATH', '绝对路径');
    refuses(base({ server: { meta: { ...META, module: '../out/x.mjs' } } }), 'META_BAD_PATH', '跑出包外');
    refuses(base({ server: { meta: { ...META, module: 'meta/x.js' } } }), 'META_BAD_MODULE', '不是 .mjs');
  });

  test('registers 必须非空，且每条键必须是 `<类别>:<id>`（或一个结尾 * 的前缀通配）', () => {
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: [] } } }), 'META_BAD_REGISTERS', '空清单');
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: ['kazdelShip'] } } }), 'META_BAD_KEY', '没有类别');
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: ['bonds:kazdelShip'] } } }), 'META_BAD_KEY', '类别名写错');
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: ['bond:'] } } }), 'META_BAD_KEY', 'id 为空');
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: ['bond:*x'] } } }), 'META_BAD_KEY', '星号在中间');
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: ['bond:**'] } } }), 'META_BAD_KEY', '两个星号');
    refuses(base({ server: { meta: { module: 'meta/x.mjs', registers: ['bond:a', 'bond:a'] } } }), 'META_DUPLICATE_KEY', '重复键');
    // 合法的那几种：精确键、前缀通配、global 类
    okShape(base({ server: { meta: { module: 'meta/x.mjs', registers: ['garrison:custom_*', 'global:kazdelPrep'] } } }), '前缀通配');
  });
});

describe('server.meta：必须声明 combat: true（业主裁决的落地）', () => {
  test('combat 缺省 / false / null 都拒绝，combat: true 通过', () => {
    refuses(base({ server: { meta: META }, combat: undefined }), 'META_NEEDS_COMBAT', '没写 combat');
    refuses(base({ server: { meta: META }, combat: false }), 'META_NEEDS_COMBAT', 'combat: false');
    okShape(base({ server: { meta: META }, combat: true }), 'combat: true');
  });

  test('combat 类型写错时先报类型错（顺序：类型 → 语义）', () => {
    refuses(base({ server: { meta: META }, combat: 'yes' }), 'BAD_COMBAT', 'combat 不是布尔');
  });

  test('只声明 preDispatch 的包不受这条闸门影响（对照）', () => {
    okShape(base({
      combat: false,
      server: { preDispatch: { module: 'server/gate.mjs', policy: 'a.json', intercepts: ['room.join'] } },
    }), 'preDispatch + combat:false 照旧合法');
  });
});

describe('server.meta：身份（声明与模块字节都进内容哈希）', () => {
  let tmp;
  let wsRoot;
  const PACKS = {
    'meta-pack': { manifest: { server: { meta: META } }, files: { 'meta/bonds.mjs': 'export function registerMeta() {}\n' } },
    plain: { manifest: { content: ['chess'] }, files: { 'chess.json': JSON.stringify({ chess_ws_a: { chessId: 'chess_ws_a', name: 'x' } }) } },
  };
  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-packmeta-'));
    wsRoot = join(tmp, 'ws');
    for (const [id, p] of Object.entries(PACKS)) {
      const dir = join(wsRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
        id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2', combat: true, ...p.manifest,
      }));
      for (const [rel, body] of Object.entries(p.files)) {
        fs.mkdirSync(dirname(join(dir, ...rel.split('/'))), { recursive: true });
        fs.writeFileSync(join(dir, ...rel.split('/')), body);
      }
    }
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('声明的 meta 模块进 manifest（按路径），改一个字节就换一个内容哈希', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const pack = loaded.packs.find((p) => p.id === 'meta-pack');
    assert.ok(pack, JSON.stringify(loaded.errors));
    assert.ok(pack.manifest.some((m) => m.path === 'meta/bonds.mjs'), pack.manifest.map((m) => m.path).join(','));
    const before = pack.hash;
    fs.writeFileSync(join(wsRoot, 'meta-pack', 'meta', 'bonds.mjs'), 'export function registerMeta() { /* changed */ }\n');
    const after = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'meta-pack').hash;
    assert.notEqual(after, before, '模块字节变了，内容哈希必须跟着变');
    fs.writeFileSync(join(wsRoot, 'meta-pack', 'meta', 'bonds.mjs'), PACKS['meta-pack'].files['meta/bonds.mjs']);
    assert.equal(loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'meta-pack').hash, before);
  });

  test('没声明 server.meta 的包：归一化清单里没有 server 键，哈希逐字节不变（三份真实示例包）', () => {
    // 0.11.0 之前钉下的三个值（test/packAssets.test.js 同一套）：它们必须一个字都不变。
    // clementia 那一个在 0.2.3 那一轮**移过**：上游把克莱门莎收成了官方干员（官方 id `char_4231_clemnt`），
// 本仓库的示例夹具再用那个 id 会被加载器按 OFFICIAL_ID_COLLISION 拒掉，于是 id 换成工坊保留前缀的
// `char_ws_clemnt`（docs/examples/clementia/README.md）—— 包的内容真的变了，基线随之移动。
const EXPECT = { clementia: '27627f47', 'demo-workshop': '15092019', 'kit-demo': '77b80c6e' };
    const loaded = loadWorkshop(join(ROOT, 'docs/examples'), { log: quiet });
    for (const [id, prefix] of Object.entries(EXPECT)) {
      const pack = loaded.packs.find((p) => p.id === id);
      assert.ok(pack, `${id} 不在 docs/examples 的装载结果里`);
      assert.equal(pack.server, undefined, `${id} 的归一化清单里不该有 server 键`);
      assert.ok(pack.hash.startsWith(prefix), `${id} 的内容哈希变了：${pack.hash}`);
    }
  });

  test('装载期判「模块文件真的在不在」：不在 ⇒ 整个包不进 loaded.packs 并点名', () => {
    const dir = join(tmp, 'ws-missing');
    fs.mkdirSync(join(dir, 'gone'), { recursive: true });
    fs.writeFileSync(join(dir, 'gone', 'pack.json'), JSON.stringify({
      id: 'gone', name: 'Gone', version: '1.0.0', license: 'CC0-1.0', description: 'x',
      gameVersion: '0.2.2', combat: true, server: { meta: { module: 'meta/nope.mjs', registers: ['bond:x'] } },
    }));
    const loaded = loadWorkshop(dir, { log: quiet });
    assert.equal(loaded.packs.some((p) => p.id === 'gone'), false, '模块文件不在 ⇒ 整包不出现');
    const err = loaded.errors.find((e) => e.pack === 'gone');
    assert.ok(err && /^META_BAD_MODULE: /.test(err.reason), JSON.stringify(loaded.errors));
    // 函数本身也直接可测（与 assetsIssues / preDispatchIssues 同一个形状）
    const issues = metaIssues({ server: { meta: { module: 'meta/nope.mjs', registers: ['bond:x'] } } }, join(dir, 'gone'));
    assert.deepEqual(issues.map((i) => i.code), ['META_BAD_MODULE']);
    assert.deepEqual(metaIssues({ server: { meta: { module: '../x.mjs' } } }, join(dir, 'gone')).map((i) => i.code), ['META_BAD_PATH']);
    assert.deepEqual(metaIssues({}, join(dir, 'gone')), [], '没声明 meta 的包：一条意见都没有');
  });

  test('identifyPack 把 meta 模块的字节算进去（不传 meta 时与会话前的清单相同）', () => {
    const dir = join(wsRoot, 'meta-pack');
    const raw = JSON.parse(fs.readFileSync(join(dir, 'pack.json'), 'utf8'));
    const pack = normalizePackManifest(raw, 'meta-pack', { hasAssets: false }).pack;
    const withMeta = identifyPack(dir, pack, {});
    assert.ok(withMeta.manifest.some((m) => m.path === 'meta/bonds.mjs'));
    const without = { ...pack, server: { preDispatch: pack.server.preDispatch } };
    delete without.server.meta;
    const noMeta = identifyPack(dir, without, {});
    assert.equal(noMeta.manifest.some((m) => m.path === 'meta/bonds.mjs'), false);
    assert.notEqual(noMeta.hash, withMeta.hash);
  });
});

describe('接缝：META_KEY_CLASSES 与 MetaRegistry 的七个方法（反射钉，防两处真相漂移）', () => {
  test('shared/workshop.js 的类别名单 === MetaRegistry 上的七个 sugar 方法', () => {
    const methods = Object.getOwnPropertyNames(MetaRegistry.prototype)
      .filter((n) => !n.startsWith('_') && !['constructor', 'register', 'unregister', 'get', 'has', 'keys', 'globals', 'fork', 'warnings'].includes(n))
      .sort();
    assert.deepEqual(methods, [...META_KEY_CLASSES].sort(),
      'MetaRegistry 的键类别与 META_KEY_CLASSES 必须逐字相同：少一个，形状层就会拒掉一个引擎真的支持的类别；多一个，作者会写出一个永远注册不上的键');
  });

  test('fork() 复制内容、互不影响，且不碰原件（禁止全局 set/restore 的落点）', () => {
    const base = new MetaRegistry();
    base.bond('official', { onRoundStart() {} });
    const room = base.fork();
    assert.deepEqual(room.keys(), base.keys(), '副本一开始与原件内容相同');
    assert.equal(room.get('bond:official'), base.get('bond:official'), '处理器对象是共享的（内容相同）');
    room.bond('kazdelShip', { onRoundStart() {} });
    assert.equal(base.has('bond:kazdelShip'), false, '往副本里注册不许影响原件');
    assert.equal(room.has('bond:kazdelShip'), true);
    base.bond('later', { onRoundStart() {} });
    assert.equal(room.has('bond:later'), false, '原件后来注册的不许出现在副本里');
    // 警告也要各走各的（否则一个包的错别字会记到另一个房间的账上）
    room.register('bond:typo', { notAHook() {} });
    assert.equal(base.warnings.length, 0);
    assert.equal(room.warnings.length, 1);
  });
});
