// test/modOfficialOverlay.test.js — 官方档**声明式内容**并进 `server/data.js` 叠加层（Phase 3 的接线）。
//
// 这个测试之所以重要：它是**唯一直验接线**的地方（`loadData` 不 import `ws`，本机就能跑）。
// 三条都要钉住：目录不存在 ⇒ 逐字节不变；`excludePacks` 同样生效；贡献的表真的并进去了。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadData, DATA_DIR, PLUGINS_DIR } from '../server/data.js';
import { OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { SDK_OFFICIAL } from '../shared/sdk/sdkConstants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const NONE = path.join(tmpdir(), `sp-overlay-none-${process.pid}-${Date.now()}`);

const makePluginRoot = (id, table, payload) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-overlay-'));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({
    id, name: id, version: '1.0.0', sdk: SDK_OFFICIAL, content: [table],
  }));
  fs.writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(payload));
  return root;
};

test('PLUGINS_DIR 默认指向仓库 plugins/；目录不存在 ⇒ 官方档整块不生效（逐字节不变）', () => {
  assert.equal(PLUGINS_DIR, path.join(DATA_DIR, '..', 'plugins'));
  const base = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: null });
  const missing = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: NONE });
  assert.deepEqual(missing, base, '目录不存在时官方叠加层必须一个字都不改');
  assert.ok(Object.keys(base.items || {}).length > 0, '夹具前提：官方 data/items.json 非空');
});

test('贡献的声明式内容真的并进 data（新的表键出现、原表键保留）', () => {
  const root = makePluginRoot('hello', 'items', { spOverlayProbe: { id: 'spOverlayProbe', name: 'Probe' } });
  try {
    const base = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: null });
    const merged = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: root });
    assert.ok('spOverlayProbe' in merged.items, '官方插件的表项必须并进来');
    assert.equal(merged.items.spOverlayProbe.name, 'Probe');
    // 原有记录仍在（并集，不是替换）
    const before = Object.keys(base.items).filter((k) => k !== 'spOverlayProbe');
    assert.ok(before.every((k) => Object.prototype.hasOwnProperty.call(merged.items, k)));
    // 没被碰的表保持同一份内容
    assert.deepEqual(merged.chess, base.chess);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('excludePacks 对官方插件同样生效（被禁用/被裁的插件，内容也不许进叠加层）', () => {
  const root = makePluginRoot('hello', 'items', { spOverlayProbe: { id: 'spOverlayProbe' } });
  try {
    const base = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: null });
    const excluded = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: root, excludePacks: new Set(['hello']) });
    assert.deepEqual(excluded, base, '被排除的官方插件不能留下任何内容');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('坏清单的插件被具名拒（不贡献、不影响其它插件、也不炸装载）', () => {
  const root = makePluginRoot('good', 'items', { spOverlayProbe: { id: 'spOverlayProbe' } });
  try {
    const bad = path.join(root, 'bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({ id: 'bad', sdk: SDK_OFFICIAL, server: {} })); // Forge-only 字段
    const merged = loadData(DATA_DIR, { log: quiet, workshopDir: null, pluginsDir: root });
    assert.ok('spOverlayProbe' in merged.items, '好插件照常生效');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
