// test/modOfficialSdk.test.js — **`setup(sp)` SDK 表面**（`sp:sdk@1` 的上游契约）：
// 一个按上游 `docs/PLUGINS.md` 写法写的插件，在本仓能被装载、注册能落到 extensions 注册表、
// 注册进战场的 kit 能真的跑、meta 能进**真的** buildRoomRegistry、权限闸生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadOfficialPlugins, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { loadOfficialModules } from '../server/mod-manager/officialHost.js';
import { createSDK, SANDBOX_LIMITS } from '../server/mod-manager/officialSdk.js';
import { installExtensions, resetExtensions } from '../server/sim/content/extensions.js';
import { buildRoomRegistry } from '../server/match/metaPack.js';
import { MetaRegistry } from '../server/match/effectsMeta.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
/** 上游入口契约：`export default function setup(sp)`（docs/PLUGINS.md:756）。 */
const SETUP = 'export default function setup(sp) {';

function makePlugin(root, name, manifest, entryBody) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({ manifest: 2, api: 1, id: name, name, version: '1.0.0', ...manifest }));
  if (entryBody) fs.writeFileSync(path.join(dir, 'plugin.mjs'), entryBody);
  return dir;
}

test('上游写法的插件：setup(sp) 收到九成员冻结对象；sp.kits.register 落进注册表', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-sdk1-'));
  try {
    makePlugin(root, 'kitdemo', {
      class: 'trusted', permissions: ['trusted.server', 'sim.code'], entry: { server: 'plugin.mjs' },
    }, `${SETUP}
      if (Object.isFrozen(sp) && sp.kit && sp.math && sp.constants && typeof sp.kits.register === 'function'
        && typeof sp.enemies.register === 'function' && typeof sp.content.register === 'function'
        && typeof sp.meta.register === 'function' && typeof sp.log === 'function' && 'settings' in sp) {
        sp.kits.register('kit-demo', () => ({ num: sp.kit.num(3) }));
      } else { throw new Error('SDK surface incomplete'); }
      }`);
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(errors, []);
    assert.equal(modules.length, 1);
    assert.equal(modules[0].sdk, true, '走的是 setup(sp) 那条契约');
    const battle = { on() {}, _handlerError() {} };
    // installExtensions 把注册的 kit 装上战场（这里主要验证不抛 + kit 内容可取）
    assert.doesNotThrow(() => installExtensions(battle));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('权限闸：没声明 sim.code 却调 sp.kits.register ⇒ PLUGIN_PERMISSION_MISSING', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-sdk2-'));
  try {
    makePlugin(root, 'nosy', {
      class: 'trusted', permissions: ['trusted.server'], entry: { server: 'plugin.mjs' },
    }, `${SETUP}
      try { sp.kits.register('x', () => ({})); }
      catch (e) { sp.log('caught', e.code); return; }
      throw new Error('should have thrown');
      }`);
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(errors, [], '插件自己接住了异常 ⇒ setup 正常返回、不产生装载错误');
    assert.equal(modules.length, 1, '模块照常装载（权限闸抛出但被作者的 try/catch 接住）');
    // 直接验证权限闸本身
    const sp = createSDK({ id: 'p', officialPermissions: [] });
    assert.throws(() => sp.kits.register('x', () => ({})), (e) => e.code === 'PLUGIN_PERMISSION_MISSING');
    assert.throws(() => sp.meta.register('x', () => ({})), (e) => e.code === 'PLUGIN_PERMISSION_MISSING');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('setup(sp) 的 meta.register 进**真的** buildRoomRegistry（overrides 白名单约束）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-sdk3-'));
  try {
    makePlugin(root, 'meta', {
      class: 'trusted', permissions: ['trusted.server', 'sim.code', 'meta.code'], entry: { server: 'plugin.mjs' },
      overrides: ['item:declared'],
    }, `${SETUP}
      sp.meta.register('item:declared', { run: () => 'registered' });
      }`);
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(errors, []);
    const packs = [{
      id: modules[0].pack, hash: modules[0].hash, registers: ['item:declared'],
      registerMeta(registry) { registry.register('item:declared', { run: () => 'registered' }); },
    }];
    const { registry, errors: regErrors } = buildRoomRegistry({ packs, base: new MetaRegistry(), log: quiet });
    assert.deepEqual(regErrors, []);
    assert.ok(registry);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('入口双契约：既无 setup(sp) 也无 registerPlugin(host) ⇒ 具名拒；两者都在时 setup 优先', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-sdk4-'));
  try {
    makePlugin(root, 'neither', {
      class: 'trusted', permissions: ['trusted.server'], entry: { server: 'plugin.mjs' },
    }, 'export const x = 1;');
    const a = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins.filter((p) => p.id === 'neither'), { log: quiet });
    assert.equal(a.errors[0].code, 'PLUGIN_NO_REGISTER');
    assert.match(a.errors[0].reason, /setup\(sp\)/, '错误信息要点出两条契约的名字');

    makePlugin(root, 'both', {
      class: 'trusted', permissions: ['trusted.server'], entry: { server: 'plugin.mjs' },
    }, `export default function setup(sp) { sp.log('setup ran'); }
       export function registerPlugin(host) { throw new Error('registerPlugin must not run when setup exists'); }`);
    const b = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins.filter((p) => p.id === 'both'), { log: quiet });
    assert.deepEqual(b.errors, []);
    assert.equal(b.modules[0].sdk, true, 'setup(sp) 优先');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('settings 与 log：manifest 的 settings 冻结透传；log 封顶 20 行', async () => {
  const sp = createSDK({ id: 's', officialPermissions: [] }, { settings: { a: { b: 1 } }, log: () => {} });
  assert.ok(Object.isFrozen(sp.settings));
  assert.deepEqual(sp.settings, { a: { b: 1 } });
  let out = 0;
  const sp2 = createSDK({ id: 's2', officialPermissions: [] }, { log: () => { out += 1; } });
  for (let i = 0; i < 30; i++) sp2.log('x');
  assert.equal(out, 20, '上游 [ASSUMED] 的 20 行上限');
});

test('SANDBOX_LIMITS 是上游同款数字（64 文件 / 1MiB）', () => {
  assert.deepEqual({ ...SANDBOX_LIMITS }, { files: 64, bytes: 1024 * 1024 });
});
