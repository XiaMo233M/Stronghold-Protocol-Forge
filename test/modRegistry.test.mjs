// The mod manager's registry + CLI verbs (server/modRegistry.js, tools/workshop-pack.mjs): one state file (the plan's
// "一份真实 registry 为准") that records installs and the operator's enable/disable, the upgrade→rollback half, and
// that a disabled pack is filtered from a loaded set exactly like one that failed to load.
//
// The state root is redirected to a temp dir via SP_STATE_DIR (stateRootFor reads it per call), so the CLI verbs can be
// driven through runCli without touching the repository's own var/.

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

/** A minimal valid pack: one items record (the same shape the shared fixtures use), zipped at the root. */
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
/** runCli 的 import 要一个文件路径：把 zip 字节落到临时文件再传。 */
function importZip(root, zip, ...args) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modregistry-zip-')), 'pack.zip');
  fs.writeFileSync(file, zip);
  runCli(['import', file, '--workshop', root, ...args]);
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

function putPackDir(root, id) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'pack.json'), `${JSON.stringify({ id, name: id, version: '1.0.0', license: 'CC0-1.0', content: ['items'] }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, id, 'items.json'), `${JSON.stringify({ [`${id}_item_a`]: { id: `${id}_item_a`, name: 'x', tier: 1 } }, null, 2)}\n`);
}
