// test/modOfficialHost.test.js — 官方档进程内 module 运行时：只注入声明过的 capability + 严格档扫描。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadOfficialPlugins, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { loadOfficialModules, PluginRefused, HOST_CAPABILITIES, COMBAT_HOST_CAPABILITIES } from '../server/mod-manager/officialHost.js';
import { mountServerModules } from '../server/modModules.js';
import { SDK_OFFICIAL } from '../shared/sdk/sdkConstants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makePlugin(root, name, { apis = [], entry = null, entryBody = '', combat = false } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: name, name, version: '1.0.0', sdk: SDK_OFFICIAL, apis, ...(combat ? { combat: true } : {}) };
  if (entry) manifest.entry = entry;
  fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify(manifest));
  if (entry && entryBody) fs.writeFileSync(path.join(dir, entry), entryBody);
  return dir;
}

test('只注入声明过的 capability：没声明的面**抛** PLUGIN_USE_UNDECLARED（不是 undefined）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host-'));
  try {
    makePlugin(root, 'demo', {
      apis: ['health', 'storage'],
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) {
        host.onBoot(() => {});
        host.health.add({ ready: true });
        host.storage.write('state.txt', 'hi');
      }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet, stateRoot: path.join(root, 'var') });
    assert.deepEqual(errors, []);
    assert.equal(modules.length, 1);
    assert.deepEqual([...modules[0].uses].sort(), ['health', 'modules', 'storage']);
    // 声明过的面真的挂上了
    const m = mountServerModules(modules, { log: quiet });
    assert.deepEqual(m.healthz(), { demo: { ready: true } });
    assert.equal(fs.readFileSync(path.join(root, 'var', 'official', 'demo', 'state.txt'), 'utf8'), 'hi');
    assert.equal(m.routes().size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('没声明的面碰一下就是具名错误（routes / metrics 未声明）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host2-'));
  try {
    makePlugin(root, 'greedy', {
      apis: ['health'],
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) { host.routes.add({ path: '/mod/greedy/x', handler: () => {} }); }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'PLUGIN_USE_UNDECLARED');
    assert.match(errors[0].reason, /routes/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('严格档源码扫描在 import **之前**：`globalThis` 的插件整包被拒', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host3-'));
  try {
    makePlugin(root, 'sneaky', {
      apis: ['health'],
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) { globalThis.__leak = host; }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(modules, [], '严格档（profile module）拒 globalThis');
    assert.equal(errors[0].code, 'PLUGIN_BAD_SOURCE');
    assert.match(errors[0].reason, /globalThis/);
    assert.equal(globalThis.__leak, undefined, '被拒的模块**没有**被 import（顶层副作用没发生）');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('没有 registerPlugin 导出 / 入口不在插件内 ⇒ 具名拒', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host4-'));
  try {
    makePlugin(root, 'noreg', { apis: ['health'], entry: 'plugin.mjs', entryBody: 'export const nope = 1;' });
    makePlugin(root, 'escapes', { apis: ['health'], entry: '../outside.mjs', entryBody: '' });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { errors } = await loadOfficialModules(plugins, { log: quiet });
    const byPack = Object.fromEntries(errors.map((e) => [e.pack, e]));
    assert.equal(byPack.noreg.code, 'PLUGIN_NO_REGISTER');
    assert.equal(byPack.escapes.code, 'PLUGIN_BAD_ENTRY');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('战斗类能力（meta/battle）在这一层具名拒；room 是只读观察、放行；storage 路径越界被拒', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host5-'));
  try {
    makePlugin(root, 'fighter', { apis: ['battle'], combat: true, entry: 'plugin.mjs', entryBody: 'export function registerPlugin(host) {}' });
    const a = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const fa = a.errors.find((e) => e.pack === 'fighter');
    assert.equal(fa.code, 'PLUGIN_CAPABILITY_NOT_IN_THIS_LAYER');
    assert.match(fa.reason, /battle/);

    makePlugin(root, 'badpath', { apis: ['storage'], entry: 'plugin.mjs', entryBody: `export function registerPlugin(host) { host.storage.read('../escape.txt'); }` });
    const b = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet, stateRoot: path.join(root, 'var') });
    assert.equal(b.errors.find((e) => e.pack === 'badpath').code, 'PLUGIN_BAD_PATH');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('room：只读观察面（不必 combat），事件名是闭集、注册落在 mounted.room', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host6-'));
  try {
    makePlugin(root, 'watcher', {
      apis: ['room'],
      entry: 'plugin.mjs',
      entryBody: `export function registerPlugin(host) {
        host.room.on('create', (room) => {});
        host.room.on('matchEnd', () => {});
      }`,
    });
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    assert.equal(plugins[0].descriptor.combat, false, 'room 不该要求 combat');
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(errors, []);
    assert.deepEqual(modules[0].mounted.room.map((r) => r.event), ['create', 'matchEnd']);
    assert.ok(modules[0].uses.includes('room'));

    // 事件名不在闭集里 ⇒ 具名拒
    makePlugin(root, 'typo', { apis: ['room'], entry: 'plugin.mjs', entryBody: `export function registerPlugin(host) { host.room.on('matchend', () => {}); }` });
    const t = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    assert.equal(t.errors.find((e) => e.pack === 'typo').code, 'PLUGIN_BAD_ROOM_EVENT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('room：没声明就碰 host.room ⇒ PLUGIN_USE_UNDECLARED', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-host7-'));
  try {
    makePlugin(root, 'nosy', { apis: ['health'], entry: 'plugin.mjs', entryBody: `export function registerPlugin(host) { host.room.on('create', () => {}); }` });
    const { errors } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    assert.equal(errors[0].code, 'PLUGIN_USE_UNDECLARED');
    assert.match(errors[0].reason, /room/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('HOST_CAPABILITIES 是运行时面的闭集：room 在内、meta/battle 不在', () => {
  assert.deepEqual([...HOST_CAPABILITIES], ['modules', 'storage', 'health', 'routes', 'metrics', 'lane', 'room']);
  assert.equal(HOST_CAPABILITIES.includes('meta'), false);
  assert.equal(HOST_CAPABILITIES.includes('battle'), false);
  assert.deepEqual([...COMBAT_HOST_CAPABILITIES], ['meta', 'battle']);
  assert.equal(typeof PluginRefused, 'function');
});
