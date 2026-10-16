// test/modOfficialCatalog.test.js — 官方插件的**客户端目录**：与 Forge 那份同形，且「客户端能重建同一个摘要」这条
// 不变量必须成立（那是「官方插件进 mod 集合」之所以安全的前提）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { loadOfficialPlugins, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { buildOfficialCatalog, catalogHashHolds, mergeCatalog } from '../server/mod-manager/officialCatalog.js';
import { fromOfficialManifest } from '../shared/sdk/descriptor.js';
import { SDK_UPSTREAM } from '../shared/sdk/sdkConstants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sha = (b) => createHash('sha256').update(b).digest('hex');

function makeRoot(plugins) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-cat-'));
  for (const p of plugins) {
    const dir = path.join(root, p.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({ id: p.name, name: p.name, version: '1.0.0', sdk: SDK_UPSTREAM, ...p.manifest }));
    for (const [rel, body] of Object.entries(p.files || {})) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  }
  return root;
}

test('目录条目与 Forge 那份同形，且**客户端重建的摘要 == 发布的 hash**（逐文件 canonical 口径）', () => {
  const root = makeRoot([{ name: 'hello', manifest: { apis: ['content', 'health'] }, files: { 'items.json': '{"a":1}', 'data/extra.txt': 'xyz' } }]);
  try {
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { packs } = buildOfficialCatalog(plugins);
    assert.equal(packs.length, 1);
    const e = packs[0];
    assert.equal(e.id, 'hello');
    assert.equal(e.hash, plugins[0].hash);
    assert.equal(e.layer, 'B', '有服务端载荷（health）⇒ B 档');
    assert.equal(e.combat, false);
    assert.equal(e.api, null);
    assert.deepEqual(e.files.map((f) => f.path).sort(), ['data/extra.txt', 'items.json', OFFICIAL_PLUGIN_MANIFEST]);

    for (const row of e.files) {
      const bytes = fs.readFileSync(path.join(root, 'hello', ...row.path.split('/')));
      assert.equal(row.bytes, bytes.length, `${row.path}: bytes 是真实长度`);
      assert.equal(row.sha256, sha(bytes), `${row.path}: sha256 是磁盘字节的哈希`);
      assert.equal(row.canonical, row.sha256, `${row.path}: 官方装载器对每个文件都哈希原始字节 ⇒ canonical == sha256`);
    }
    assert.equal(catalogHashHolds(e), true, '客户端用同一个算法能重建出发布的 hash —— 这是进 mod 集合的前提');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('读不到的文件 ⇒ 那一行不进目录（宁可少一行，也不给复算不出来的哈希）', () => {
  const root = makeRoot([{ name: 'hello', manifest: { apis: ['content'] }, files: { 'items.json': '{}' } }]);
  try {
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { packs } = buildOfficialCatalog(plugins, { readFile: () => { throw new Error('nope'); } });
    assert.deepEqual(packs[0].files, []);
    assert.equal(catalogHashHolds(packs[0]), false, '少一行 ⇒ 摘要不变量立刻不成立（不是静默通过）');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('mergeCatalog：并集、按 id 排序、**同 id 不静默覆盖**（官方那一条被丢掉并点名）', () => {
  const forge = { packs: [{ id: 'b', hash: 'h1' }, { id: 'a', hash: 'h2' }] };
  const official = { packs: [{ id: 'c', hash: 'h3' }, { id: 'a', hash: 'hX' }] };
  const { catalog, collisions } = mergeCatalog(forge, official);
  assert.deepEqual(catalog.packs.map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(collisions, ['a']);
  assert.equal(catalog.packs.find((p) => p.id === 'a').hash, 'h2', 'Forge 那一条留下（先到者胜）');
  assert.deepEqual(mergeCatalog(null, null).catalog.packs, []);
  assert.deepEqual(mergeCatalog({ packs: [] }, { packs: [] }).collisions, []);
});

test('描述符 layer 由能力推出：纯内容 ⇒ A；任何服务端载荷 ⇒ B', () => {
  const a = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, content: ['items'] });
  assert.equal(a.descriptor.layer, 'A');
  for (const api of ['health', 'storage', 'meta', 'battle', 'room', 'http.route', 'lane', 'modules']) {
    const m = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, combat: true, apis: [api], ...(api === 'meta' ? { metaRegisters: ['item:x'] } : {}) });
    assert.equal(m.descriptor.layer, 'B', `api ${api} ⇒ B 档`);
  }
});
