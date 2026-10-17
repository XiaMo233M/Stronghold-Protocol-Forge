// test/modOfficialHost.test.js — 官方档进程内 module 运行时：只注入**派生出来的** capability + 严格档扫描。
// 声明面按 0.3.0 词表（`class` / `permissions` / `entry`），能力由它们派生（见 shared/sdk/descriptor.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadOfficialPlugins, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { loadOfficialModules, PluginRefused, HOST_CAPABILITIES } from '../server/mod-manager/officialHost.js';
import { mountServerModules } from '../server/modModules.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** `klass` 决定 entry 往哪个槽放：script→sim、ui→client、其余→server。 */
function makePlugin(root, name, { klass = 'trusted', permissions = ['trusted.server'], entry = null, entryBody = '', extra = {} } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { manifest: 2, api: 1, id: name, name, version: '1.0.0', class: klass, permissions, ...extra };
  if (entry) manifest.entry = klass === 'script' ? { sim: entry } : (klass === 'ui' ? { client: entry } : { server: entry });
  fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify(manifest));
  if (entry && entryBody) fs.writeFileSync(path.join(dir, entry), entryBody);
  return dir;
}

test('trusted 档：boot + health 面可用；**storage 不是官方能力** ⇒ 碰一下就抛', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host-'));
  try {
    makePlugin(root, 'demo', {
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) {
        host.onBoot(() => {});
        host.health.add({ ready: true });
        host.storage.write('state.txt', 'hi');
      }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet, stateRoot: path.join(root, 'var') });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'PLUGIN_PERMISSION_MISSING');
    assert.match(errors[0].reason, /storage/, '官方档没有 storage 权限 ⇒ 那一格不可达');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('已声明的宿主面真的挂上：boot 跑一次、healthz 出字段', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host1b-'));
  try {
    makePlugin(root, 'demo', { entry: 'plugin.mjs', entryBody: `export function registerPlugin(host) { host.health.add({ ready: true }); }` });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(errors, []);
    assert.equal(modules.length, 1);
    assert.deepEqual([...modules[0].uses].sort(), ['health', 'modules', 'room', 'routes']);
    const m = mountServerModules(modules, { log: quiet });
    assert.deepEqual(m.healthz(), { demo: { ready: true } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('没派生的面碰一下就是具名错误（content 档没有 routes）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host2-'));
  try {
    makePlugin(root, 'greedy', {
      klass: 'content', permissions: ['data.patch'],
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) { host.routes.add({ path: '/mod/greedy/x', handler: () => {} }); }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'PLUGIN_PERMISSION_MISSING');
    assert.match(errors[0].reason, /routes/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('严格档源码扫描在 import **之前**：`globalThis` 的插件整包被拒', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host3-'));
  try {
    makePlugin(root, 'sneaky', {
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) { globalThis.__leak = host; }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(modules, [], '严格档拒 globalThis');
    assert.equal(errors[0].code, 'PLUGIN_SCRIPT_CHECK');
    assert.match(errors[0].reason, /globalThis/);
    assert.equal(globalThis.__leak, undefined, '被拒的模块**没有**被 import（顶层副作用没发生）');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('没有 registerPlugin 导出 / 入口越界 ⇒ 具名拒', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host4-'));
  try {
    makePlugin(root, 'noreg', { entry: 'plugin.mjs', entryBody: 'export const nope = 1;' });
    makePlugin(root, 'escapes', { entry: '../outside.mjs', entryBody: '' });
    const { plugins, errors: loadErrors } = loadOfficialPlugins(root, { log: quiet });
    const { errors } = await loadOfficialModules(plugins, { log: quiet });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));
    assert.equal(byPack.noreg.code, 'PLUGIN_ENTRY');
    // `entry` 越界在**形状层**就被拒（`entry.server must be a plugin-relative path`）⇒ 根本进不了装载
    assert.ok(loadErrors.some((e) => e.pack === 'escapes' && /plugin-relative/.test(e.reason)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('装载门：`script` 档具名拒（沙箱没接线），`trusted` 档才是进程内执行的那一档', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host5-'));
  try {
    makePlugin(root, 'nocode', { klass: 'script', permissions: ['sim.code'] }); // 没有 entry
    const a0 = loadOfficialPlugins(root, { log: quiet });
    assert.deepEqual(a0.plugins.length, 1, '形状层不要求 script 一定有 entry（上游也没强制）');
    const a1 = await loadOfficialModules(a0.plugins, { log: quiet });
    assert.deepEqual(a1.modules, [], '没有 entry ⇒ 不装载任何模块');
    assert.equal(a1.errors.length, 1);
    assert.equal(a1.errors[0].code, 'PLUGIN_SANDBOX_UNAVAILABLE', 'script = profile sandbox，本版没接沙箱 ⇒ 具名拒');

    makePlugin(root, 'ok', { klass: 'trusted', permissions: ['trusted.server'], entry: 'plugin.mjs', entryBody: 'export function registerPlugin(host) {}' });
    const b = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins.filter((p) => p.id === 'ok'), { log: quiet });
    assert.deepEqual(b.errors, []);
    assert.equal(b.modules.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('room：trusted 档的只读观察面（`api.lobby.on` 的归一），事件名是闭集', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host6-'));
  try {
    makePlugin(root, 'watcher', {
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) {
        host.room.on('create', () => {});
        host.room.on('matchEnd', () => {});
      }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(errors, []);
    assert.deepEqual(modules[0].mounted.room.map((r) => r.event), ['create', 'matchEnd']);
    assert.ok(modules[0].uses.includes('room'));

    makePlugin(root, 'typo', { entry: 'plugin.mjs', entryBody: `export function registerPlugin(host) { host.room.on('matchend', () => {}); }` });
    const t = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins.filter((p) => p.id === 'typo'), { log: quiet });
    assert.equal(t.errors[0].code, 'PLUGIN_MANIFEST_SHAPE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('content 档没有 room 面 ⇒ 碰一下就抛 PLUGIN_USE_UNDECLARED', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host7-'));
  try {
    makePlugin(root, 'nosy', {
      klass: 'content', permissions: ['data.patch'],
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) { host.room.on('create', () => {}); }`,
    });
    const { errors } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    assert.equal(errors[0].code, 'PLUGIN_PERMISSION_MISSING');
    assert.match(errors[0].reason, /room/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('HOST_CAPABILITIES 是运行时面的闭集（新词表）', () => {
  assert.deepEqual([...HOST_CAPABILITIES], ['modules', 'sim', 'kits', 'storage', 'health', 'routes', 'metrics', 'lane', 'room', 'meta', 'panels']);
  assert.equal(typeof PluginRefused, 'function');
});
