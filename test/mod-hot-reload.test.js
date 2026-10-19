// 热装载驱动单测：变更被合并/串行化、diff 精确、坏包不炸、restart 只在 mode=restart 时调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHotReload, scanPacks, diffPacks } from '../server/modHotReload.js';

const silent = { info() {}, warn() {} };
function ws(packs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-reload-'));
  for (const [id, version] of Object.entries(packs)) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'pack.json'), JSON.stringify({ id, version }));
  }
  return dir;
}

test('scanPacks lists directories and reads versions; a broken pack is listed with version=null', () => {
  const dir = ws({ a: '1.0.0', b: '2.0.0' });
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'pack.json'), '{oops');
  fs.mkdirSync(path.join(dir, '.hidden'));
  const got = scanPacks(dir, { log: silent });
  assert.deepEqual([...got.keys()], ['a', 'b', 'broken']);
  assert.equal(got.get('a'), '1.0.0');
  assert.equal(got.get('broken'), null);
});

test('diffPacks reports added / removed / version-changed precisely', () => {
  const before = new Map([['a', '1.0.0'], ['b', '1.0.0'], ['c', '1.0.0']]);
  const after = new Map([['a', '1.0.0'], ['b', '2.0.0'], ['d', '1.0.0']]);
  const d = diffPacks(before, after);
  assert.deepEqual(d.added.map((x) => x.id), ['d']);
  assert.deepEqual(d.removed.map((x) => x.id), ['c']);
  assert.deepEqual(d.changed.map((x) => `${x.id}:${x.from}->${x.to}`), ['b:1.0.0->2.0.0']);
  assert.equal(d.total, 3);
});

test('a change is detected, debounced, and reported once; unchanged scans do nothing', async () => {
  const dir = ws({ a: '1.0.0' });
  const seen = [];
  const hot = createHotReload({ dir, log: silent, debounceMs: 0, onReload: (info) => seen.push(info) });
  hot.start();
  fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'b', 'pack.json'), JSON.stringify({ id: 'b', version: '9.9.9' }));
  await hot.check('manual');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].diff.added.map((x) => x.id), ['b']);
  await hot.check('manual');                     // 没变化 ⇒ 不再触发
  assert.equal(seen.length, 1);
  assert.equal(hot.status().skipped, 0);
  hot.stop();
});

test('mode=restart calls the restart callback; mode=report never does', async () => {
  const dir = ws({ a: '1.0.0' });
  let restarts = 0;
  const rep = createHotReload({ dir, log: silent, mode: 'report', restart: () => { restarts += 1; } });
  rep.start();
  fs.mkdirSync(path.join(dir, 'x'));
  fs.writeFileSync(path.join(dir, 'x', 'pack.json'), JSON.stringify({ id: 'x' }));
  await rep.check('r1');
  assert.equal(restarts, 0, 'report 模式绝不重启');
  rep.stop();

  const dir2 = ws({ a: '1.0.0' });
  const res = createHotReload({ dir: dir2, log: silent, mode: 'restart', restart: () => { restarts += 1; } });
  res.start();
  fs.mkdirSync(path.join(dir2, 'y'));
  fs.writeFileSync(path.join(dir2, 'y', 'pack.json'), JSON.stringify({ id: 'y' }));
  await res.check('r2');
  assert.equal(restarts, 1, 'restart 模式才重启');
  res.stop();
});

test('a throwing onReload callback never escapes (server must stay up)', async () => {
  const dir = ws({ a: '1.0.0' });
  const hot = createHotReload({ dir, log: silent, onReload: () => { throw new Error('boom'); } });
  hot.start();
  fs.mkdirSync(path.join(dir, 'z'));
  fs.writeFileSync(path.join(dir, 'z', 'pack.json'), JSON.stringify({ id: 'z' }));
  await hot.check('boom');
  assert.match(hot.status().lastError || '', /boom/);
  assert.equal(hot.status().running, true);
  hot.stop();
});

test('stop() closes the watcher; watch failures degrade to a logged warning', () => {
  const dir = ws({ a: '1.0.0' });
  const bad = createHotReload({ dir: path.join(dir, 'nope'), log: silent, watchImpl: () => { throw new Error('EACCES'); } });
  const st = bad.start();
  assert.equal(st.running, false);
  assert.match(st.lastError || '', /EACCES/);
  bad.stop();
});
