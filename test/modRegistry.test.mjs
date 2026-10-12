// 模组管理器的登记册 + CLI 动词（`server/modRegistry.js`、`tools/workshop-pack.mjs`，DESIGN §28.47）。
//
// 覆盖三件东西：
//   ① 登记册本身：一份状态文件（装了/从哪来/摘要/上一版留底）——「一份真实 registry 为准」，不留第二份副本；
//   ② CLI 的 enable / disable / uninstall / rollback 一圈，以及 **升级 → 回滚** 那一半；
//   ③ **删除的两道闸**（本文件的重点）：
//        * **ownership** —— 只卸载本管理器**登记过**的包；
//        * **留底** —— 卸载与回滚都是 `fs.renameSync` 进 `workshop/.mod-backups/<id>/…`，**不是 unlink**；
//      外加**越界删除被拦的有牙证明**（见文件结尾那三条）：`uninstall` 只 rename **这个包自己的目录**，
//      引擎文件 / `data/` / `test/golden/` 一律不碰；而登记册里那个会被拼成路径的 `previous.backup`
//      只接受**包内相对目录** —— 手改过的登记册指不到工坊根之外。
//
// 状态根用 `SP_STATE_DIR` 重定向到临时目录（`stateRootFor` 每次调用都读它），所以 CLI 动词可以经 `runCli`
// 直接驱动，**不碰仓库自己的 `var/`**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipWrite } from '../shared/zip.js';
import { loadWorkshop } from '../server/workshop.js';
import { runCli } from '../tools/workshop-pack.mjs';
import { applyModRegistry, normalizeRegistry, normalizePackEntry, readModRegistry, registryPath } from '../server/modRegistry.js';
import { stateRootFor } from '../server/modModules.js';

process.env.SP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modregistry-state-'));
const STATE = stateRootFor(process.cwd());

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-modregistry-${tag}-`));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 一个最小合法包：一条 items 记录（与 shared 的语料同形），zip 在根。 */
function packZip(id, version = '1.0.0', extra = {}) {
  const manifest = {
    id, name: `演示包 ${id}`, version, author: 'tester', license: 'CC0-1.0',
    description: 'registry 测试包', content: ['items'], ...extra,
  };
  return zipWrite([
    { name: 'pack.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'items.json', data: Buffer.from(`${JSON.stringify({ [`${id}_item_a`]: { id: `${id}_item_a`, name: '演示装备', tier: 2 } }, null, 2)}\n`) },
  ]);
}
const digestOf = (root, id) => createHash('sha256').update(fs.readFileSync(path.join(root, id, 'pack.json'))).digest('hex');
/** `runCli` 的 import 要一个文件路径：把 zip 字节落到临时文件再传。 */
function importZip(root, zip, ...args) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modregistry-zip-')), 'pack.zip');
  fs.writeFileSync(file, zip);
  runCli(['import', file, '--workshop', root, ...args]);
}

/**
 * 一棵目录树的确定性摘要（按相对路径排序，录 `路径 + sha256`）—— 「一字节不变」这种断言必须能真的验，
 * 不能只看某个文件在不在。
 */
function treeHash(dir) {
  if (!fs.existsSync(dir)) return '(missing)';
  const h = createHash('sha256');
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) { walk(abs, r); continue; }
      h.update(r).update(fs.readFileSync(abs));
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

/** 一棵「像仓库」的树：引擎文件与 `data/` / `test/golden/` 的哨兵，装在 `<parent>/root/` 里当作工坊根用。 */
function repoLikeRoot(tag) {
  const parent = tmpdir(tag);
  const root = path.join(parent, 'root');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test', 'golden'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'gamedata.json'), '{"official":true}\n');
  fs.writeFileSync(path.join(root, 'test', 'golden', 'roster.json'), '[{"id":"a"}]\n');
  fs.writeFileSync(path.join(root, 'server', 'index.js'), '// engine\n');
  // root 的同级哨兵：任何「越界」都会碰到它
  fs.mkdirSync(path.join(parent, 'outside-marker'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'outside-marker', 'keep.txt'), 'do not move me\n');
  return { parent, root };
}

test('normalizeRegistry: bad shapes are dropped by name, valid ones survive', () => {
  const { registry, issues } = normalizeRegistry({
    version: 1,
    packs: {
      'good-pack': { state: 'disabled', source: 'a.zip' },
      'bad-state': { state: 'maybe' },
      'Bad_Id': { state: 'enabled' },
      'with-previous': { state: 'enabled', previous: { digest: 'ab', backup: '.mod-backups/x/1' } },
      'with-escape': { state: 'enabled', previous: { digest: 'ab', backup: '../escape' } },
    },
  });
  // 'Bad_Id' 是合法 id（PACK_ID_RE 允许大写）；'bad-state' 整条剔除；'with-escape' 只丢坏的 previous 字段
  assert.deepEqual(Object.keys(registry.packs).sort(), ['Bad_Id', 'good-pack', 'with-escape', 'with-previous']);
  assert.equal(registry.packs['good-pack'].state, 'disabled');
  assert.equal(registry.packs['good-pack'].source, 'a.zip');
  assert.equal(registry.packs['with-escape'].previous, undefined, 'the traversal backup is dropped, the entry stays');
  assert.ok(issues.some((i) => i.startsWith('bad-state:')));
  assert.ok(issues.some((i) => i.startsWith('with-escape:')));
});

test('normalizePackEntry: a missing state reads as enabled; unknown extra keys are dropped', () => {
  const { entry } = normalizePackEntry({ source: 'x.zip' });
  assert.equal(entry.state, 'enabled');
  assert.equal(entry.source, 'x.zip');
  const { entry: trimmed } = normalizePackEntry({ state: 'disabled', whoKnows: 1 });
  assert.deepEqual(trimmed, { state: 'disabled' });
});

test('normalizePackEntry: previous.backup 是**安全闸** —— 越界与绝对路径都点名丢掉', () => {
  // 这一格会被 `cliRollback` 拼成路径，所以它只接受**包内相对目录**。三种越界写法逐条丢、且逐条具名。
  const bad = {
    '../escape': '../escape',
    'deep-escape': '.mod-backups/x/../../../etc',
    'absolute-unix': '/etc/passwd',
    'absolute-win': 'C:/Windows/System32',
  };
  for (const [tag, backup] of Object.entries(bad)) {
    const { entry, issues } = normalizePackEntry({ state: 'enabled', previous: { digest: 'ab', backup } });
    assert.equal(entry.previous, undefined, `${tag}: previous 必须整格丢掉`);
    assert.ok(issues.some((i) => i.includes('"previous"')), `${tag}: 必须具名报出`);
  }
  // 合法的包内相对留底照旧收下（否则回滚就没法用了）
  const ok = normalizePackEntry({ state: 'enabled', previous: { digest: 'ab', backup: '.mod-backups/demo/2026-01-01' } });
  assert.deepEqual(ok.entry.previous, { digest: 'ab', backup: '.mod-backups/demo/2026-01-01' });
});

test('applyModRegistry: unrecorded packs stay enabled; disabled packs leave with a named reason', () => {
  const packs = [{ id: 'a', dir: '/w/a' }, { id: 'b', dir: '/w/b' }];
  const enabled = applyModRegistry(packs, { version: 1, packs: {} });
  assert.deepEqual(enabled.packs.map((p) => p.id), ['a', 'b']);
  assert.deepEqual(enabled.disabled, []);
  const mixed = applyModRegistry(packs, { version: 1, packs: { b: { state: 'disabled' } } });
  assert.deepEqual(mixed.packs.map((p) => p.id), ['a']);
  assert.deepEqual(mixed.disabled, [{ id: 'b', where: '/w/b', reason: 'disabled by the operator (mod-registry)' }]);
});

test('CLI: import records the install (source + digest + enabled), disable filters, enable restores', () => {
  const root = tmpdir('ws');
  const zip = packZip('demo-mod');
  importZip(root, zip);

  const registry = readModRegistry(STATE);
  const entry = registry.packs['demo-mod'];
  assert.equal(entry.state, 'enabled', 'installing enables');
  assert.equal(entry.digest, digestOf(root, 'demo-mod'), 'the digest is the installed pack.json the receipt names');
  assert.match(entry.source, /pack\.zip$/, 'the source is the file the manager imported from');
  assert.ok(entry.installedAt);

  // 一个装上即生效的包：加载器看得到它；disable 之后，同一个加载结果按 registry 过滤就看不到它
  const loaded = loadWorkshop(root, { log: quiet });
  assert.deepEqual(loaded.packs.map((p) => p.id), ['demo-mod']);
  runCli(['disable', 'demo-mod', '--workshop', root]);
  assert.equal(readModRegistry(STATE).packs['demo-mod'].state, 'disabled');
  const filtered = applyModRegistry(loadWorkshop(root, { log: quiet }).packs, readModRegistry(STATE));
  assert.deepEqual(filtered.packs.map((p) => p.id), [], 'a disabled pack is as absent as one that failed to load');
  assert.equal(filtered.disabled[0].id, 'demo-mod');

  runCli(['enable', 'demo-mod', '--workshop', root]);
  assert.equal(readModRegistry(STATE).packs['demo-mod'].state, 'enabled');
});

test('CLI: import --force upgrades keep a rollback target (previous.digest + backup), rollback restores', () => {
  const root = tmpdir('upgrade');
  importZip(root, packZip('demo-mod', '1.0.0'));
  const oldDigest = digestOf(root, 'demo-mod');

  importZip(root, packZip('demo-mod', '2.0.0'), '--force');
  const after = readModRegistry(STATE).packs['demo-mod'];
  assert.equal(after.digest, digestOf(root, 'demo-mod'), 'the record points at the new version');
  assert.equal(after.previous.digest, oldDigest, 'the rollback target is the old digest');
  assert.ok(fs.existsSync(path.join(root, ...after.previous.backup.split('/'))), 'the backup dir exists on disk');

  runCli(['rollback', 'demo-mod', '--workshop', root, '--json']);
  assert.equal(digestOf(root, 'demo-mod'), oldDigest, 'the old bytes are back');
  assert.equal(readModRegistry(STATE).packs['demo-mod'].digest, oldDigest);
  assert.equal(readModRegistry(STATE).packs['demo-mod'].previous, undefined, 'the rollback target is consumed');
  assert.equal(readModRegistry(STATE).packs['demo-mod'].state, 'enabled');
});

test('CLI: uninstall removes the dir and the record, and keeps the bytes as a backup', () => {
  const root = tmpdir('uninstall');
  importZip(root, packZip('demo-mod'));
  assert.ok(fs.existsSync(path.join(root, 'demo-mod')));
  runCli(['uninstall', 'demo-mod', '--workshop', root, '--json']);
  assert.equal(fs.existsSync(path.join(root, 'demo-mod')), false);
  assert.equal(readModRegistry(STATE).packs['demo-mod'], undefined, 'the record is gone with the pack');
  const backups = path.join(root, '.mod-backups', 'demo-mod');
  assert.ok(fs.existsSync(backups) && fs.readdirSync(backups).length >= 1, 'the bytes survive as a backup');
});

test('CLI: uninstall of a pack the registry never recorded is refused (ownership)', () => {
  const root = tmpdir('ownership');
  putPackDir(root, 'hand-made');
  assert.throws(() => runCli(['uninstall', 'hand-made', '--workshop', root]), /没有本管理器的安装登记/, 'an unrecorded pack is not the manager\'s to delete');
  assert.ok(fs.existsSync(path.join(root, 'hand-made')), 'the refused pack stays on disk');
});

test('a registry file that does not exist reads as empty, and writes are atomic (no temp files left)', () => {
  const root = tmpdir('fresh');
  assert.deepEqual(readModRegistry(STATE).packs, {});
  const before = fs.existsSync(path.join(root, 'whatever')) ? fs.readdirSync(path.join(root, 'whatever')) : [];
  importZip(root, packZip('demo-mod'));
  const leftovers = fs.readdirSync(root).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(before, []);
  assert.ok(fs.existsSync(registryPath(STATE)), 'the registry file exists');
});

// ---- 越界删除被拦（DESIGN §28.47 的三条硬边界） ---------------------------------------------------------------
//
// ⚠️ 这一节是**有牙**的那一半，而且它故意**不只测入口**：`PACK_ID_RE`（`findPackDir`）确实是第一道闸，
// 但它挡的是「id 里有 `/` 或 `..`」这一种写法。真正要证明的是**即使 id 合法、即使登记册被人手改过，
// 删除也只落在工坊根之内、只落在那个包自己的目录上**。所以下面三条都用**合法 id**，并且逐字节比对
// 目录树 —— 「文件还在」这种弱断言在这类缺陷面前是绿的。

test('越界①：uninstall 只 rename 包自己的目录 —— 引擎文件 / data / test/golden / 同级目录一字节不变', () => {
  const { parent, root } = repoLikeRoot('bounds');
  importZip(root, packZip('demo-mod'));
  const before = {
    data: treeHash(path.join(root, 'data')),
    golden: treeHash(path.join(root, 'test', 'golden')),
    server: treeHash(path.join(root, 'server')),
    outside: treeHash(path.join(parent, 'outside-marker')),
    parentEntries: fs.readdirSync(parent).sort(),
  };

  runCli(['uninstall', 'demo-mod', '--workshop', root, '--json']);

  assert.equal(fs.existsSync(path.join(root, 'demo-mod')), false, '包自己的目录走了');
  assert.equal(treeHash(path.join(root, 'data')), before.data, 'data/ 一字节不变');
  assert.equal(treeHash(path.join(root, 'test', 'golden')), before.golden, 'test/golden/ 一字节不变');
  assert.equal(treeHash(path.join(root, 'server')), before.server, '引擎文件一字节不变');
  assert.equal(treeHash(path.join(parent, 'outside-marker')), before.outside, '工坊根之外一字节不变');
  assert.deepEqual(fs.readdirSync(parent).sort(), before.parentEntries, 'root 之外没有多出任何条目（没有东西被挪出工坊根）');
  // 留底落在 root/.mod-backups/<id>/uninstall-* 里 —— 是 rename 不是 unlink，字节还在
  const kept = fs.readdirSync(path.join(root, '.mod-backups', 'demo-mod'));
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^uninstall-/);
  assert.ok(fs.existsSync(path.join(root, '.mod-backups', 'demo-mod', kept[0], 'pack.json')), '留底里有完整的包');
});

test('越界②：合法 id + 手改的登记册指到工坊根之外 ⇒ 回滚被拒，外面一字节不变', () => {
  const { parent, root } = repoLikeRoot('handedit');
  importZip(root, packZip('demo-mod'));
  const outsideBefore = treeHash(path.join(parent, 'outside-marker'));

  // 手改登记册：把 previous.backup 指向工坊根之外（这是**唯一**会被拼成路径的外部数据）
  const file = registryPath(STATE);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.packs['demo-mod'].previous = { digest: 'deadbeef', backup: '../outside-marker' };
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  // 读的时候那一格就被点名丢掉了 ⇒ 回滚只能拒（它"没有可回滚的上一版"）
  assert.throws(() => runCli(['rollback', 'demo-mod', '--workshop', root]), /没有可回滚的上一版/);
  assert.equal(treeHash(path.join(parent, 'outside-marker')), outsideBefore, '工坊根之外一字节不变');
  assert.ok(fs.existsSync(path.join(parent, 'outside-marker', 'keep.txt')), '外面的文件还在');
  assert.ok(fs.existsSync(path.join(root, 'demo-mod')), '包还在原位（回滚没动它）');
});

test('越界③：id 合法、目录也真的合格，但没有安装登记 ⇒ 拒绝，且一个字节都不动', () => {
  const { parent, root } = repoLikeRoot('nomove');
  const outsideBefore = treeHash(path.join(parent, 'outside-marker'));
  // `data` 是**合法 id**（过第一道闸）、也确实在工坊根下有一份 pack.json（`findPackDir` 会接受它）——
  // 但没有**安装登记**，所以它不是管理器的东西。这一条与「id 里有 ..」是两回事：入口闸放行了它，
  // 拦住它的是 ownership 那道闸。
  putPackDir(root, 'data');
  const dataBefore = treeHash(path.join(root, 'data'));

  assert.throws(() => runCli(['uninstall', 'data', '--workshop', root]), /没有本管理器的安装登记/);

  assert.equal(treeHash(path.join(root, 'data')), dataBefore, '被拒的目录一字节不变（引擎的 data/ 也在里面）');
  assert.ok(fs.existsSync(path.join(root, 'data', 'gamedata.json')), '引擎的 data/gamedata.json 还在');
  assert.equal(treeHash(path.join(parent, 'outside-marker')), outsideBefore, '外面一字节不变');
  assert.equal(fs.existsSync(path.join(root, '.mod-backups')), false, '被拒时连留底目录都不该建');
});

function putPackDir(root, id) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'pack.json'), `${JSON.stringify({ id, name: id, version: '1.0.0', license: 'CC0-1.0', content: ['items'] }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, id, 'items.json'), `${JSON.stringify({ [`${id}_item_a`]: { id: `${id}_item_a`, name: 'x', tier: 1 } }, null, 2)}\n`);
}
