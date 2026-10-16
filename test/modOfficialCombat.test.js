// test/modOfficialCombat.test.js — 官方档 meta / battle（Phase 7 的高风险能力）：
//   * 宿主面：声明才给、未声明即抛、必须 combat:true（形状层）；
//   * 确定性那条线：声明 meta/battle 的插件**并上** kit 那张表（时钟 / 随机 / 计时器）；
//   * 两个桥：把装载期登记重放成**引擎本来就在用**的那两个形状，并用**真的** buildRoomRegistry 验 meta。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadOfficialPlugins, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { loadOfficialModules, officialMetaModules, officialBattleInstallers, officialBattleModules, officialPluginSourceIssues } from '../server/mod-manager/officialHost.js';
import { workshopBattleFilesFor } from '../server/http/workshop.js';
import { buildRoomRegistry } from '../server/match/metaPack.js';
import { MetaRegistry } from '../server/match/effectsMeta.js';
import { SDK_OFFICIAL } from '../shared/sdk/sdkConstants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makePlugin(root, name, manifest, entryBody) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({ id: name, name, version: '1.0.0', sdk: SDK_OFFICIAL, ...manifest }));
  if (entryBody) fs.writeFileSync(path.join(dir, 'plugin.mjs'), entryBody);
  return dir;
}

test('宿主面：meta.register / battle.install 只在声明后存在；未声明即抛', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat-'));
  try {
    makePlugin(root, 'm', { apis: ['meta'], combat: true, entry: 'plugin.mjs', metaRegisters: ['item:demo'] },
      `export function registerPlugin(host) {
         host.meta.register('item:demo', () => ({ ok: true }));
         host.battle.install(() => {});
       }`);
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    assert.equal(plugins[0].descriptor.combat, true);
    // battle 没声明 ⇒ 那一句应当抛（整包被拒、具名）
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'PLUGIN_USE_UNDECLARED');
    assert.match(errors[0].reason, /battle/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('形状层：声明 meta 却不给 metaRegisters ⇒ 拒；没声明 meta 却写了它 ⇒ 也拒', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat2-'));
  try {
    makePlugin(root, 'noreg', { apis: ['meta'], combat: true });
    makePlugin(root, 'orphan', { apis: ['health'], metaRegisters: ['item:x'] });
    const { plugins, errors } = loadOfficialPlugins(root, { log: quiet });
    assert.deepEqual(plugins, []);
    const by = Object.fromEntries(errors.map((e) => [e.pack, e]));
    assert.equal(by.noreg.code, 'SDK_BAD_DESCRIPTOR');
    assert.match(by.noreg.reason, /metaRegisters/);
    assert.equal(by.orphan.code, 'SDK_UNKNOWN_FIELD');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('确定性那条线：声明 meta/battle 的插件**并上** kit 表（Math.random / Date.now 被拒）', () => {
  // 不开 combat 的普通插件：时钟可用（那一层没有确定性契约）
  assert.deepEqual(officialPluginSourceIssues('const t = Date.now();', 'p', { capabilities: ['health'] }), []);
  // 声明 battle ⇒ 并上 kit 表
  const a = officialPluginSourceIssues('const t = Date.now();', 'p', { capabilities: ['battle'] });
  assert.equal(a[0].code, 'PLUGIN_BAD_SOURCE');
  assert.match(a[0].reason, /Date.now/);
  const b = officialPluginSourceIssues('const r = Math.random();', 'p', { capabilities: ['meta'] });
  assert.match(b[0].reason, /Math.random/);
  // 严格档本身仍然生效（globalThis）
  assert.match(officialPluginSourceIssues('globalThis.x = 1;', 'p', { capabilities: ['health'] })[0].reason, /globalThis/);
});

test('meta 桥：重放成 registerMeta(registry)，且受**真的** buildRoomRegistry 白名单约束', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat3-'));
  try {
    makePlugin(root, 'm', {
      apis: ['meta'], combat: true, entry: 'plugin.mjs',
      metaRegisters: ['item:declared'],
    }, `export function registerPlugin(host) {
          host.meta.register('item:declared', () => 'registered');
        }`);
    const { modules } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const packs = officialMetaModules(modules);
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].registers, ['item:declared']);
    assert.equal(typeof packs[0].registerMeta, 'function');

    const { registry, errors } = buildRoomRegistry({ packs, base: new MetaRegistry(), log: quiet });
    assert.deepEqual(errors, [], '声明过的键注册不该报错');
    assert.ok(registry, '每局注册表建起来了');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('meta 桥：**没声明**的键注册时被引擎那条受限注册表点名拒（逐包回滚）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat4-'));
  try {
    makePlugin(root, 'greedy', {
      apis: ['meta'], combat: true, entry: 'plugin.mjs',
      metaRegisters: ['item:declared'],
    }, `export function registerPlugin(host) {
          host.meta.register('item:not-declared', () => 1);
        }`);
    const { modules } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const { registry, errors } = buildRoomRegistry({ packs: officialMetaModules(modules), base: new MetaRegistry(), log: quiet });
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /not-declared/);
    assert.equal(errors[0].pack, 'greedy');
    assert.equal(registry, null, '一个包都没成功 ⇒ 没有房间注册表');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('battle 桥：重放成 install(battle)，与 Forge 的 installers 同形', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat5-'));
  try {
    makePlugin(root, 'b', { apis: ['battle'], combat: true, entry: 'plugin.mjs' },
      `export function registerPlugin(host) {
         host.battle.install((battle) => { battle.installedBy = 'b'; });
       }`);
    const { modules } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const installers = officialBattleInstallers(modules);
    assert.equal(installers.length, 1);
    assert.equal(installers[0].id, 'b');
    assert.equal(installers[0].pack, 'b');
    const battle = {};
    installers[0].install(battle);
    assert.equal(battle.installedBy, 'b', 'install(battle) 真的跑到了插件登记的那个函数');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('battle 投递面：URL 走同一条约定，且**真表**指向插件目录里的那个文件', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat6-'));
  try {
    makePlugin(root, 'b', { apis: ['battle'], combat: true, entry: 'plugin.mjs' },
      `export function registerPlugin(host) { host.battle.install(() => {}); }`);
    const { modules } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const list = officialBattleModules(modules);
    assert.equal(list.length, 1);
    assert.match(list[0].url, /^\/workshop-battle\/b\/plugin\.mjs\?v=/);
    assert.equal(list[0].pack, 'b');

    // 投递表：与 Forge 档同一张表，只是根目录换成插件根
    const files = workshopBattleFilesFor(list, root);
    const url = list[0].url.split('?')[0];
    assert.equal(files.size, 1);
    assert.equal(files.get(url), path.join(root, 'b', 'plugin.mjs'));
    assert.ok(fs.existsSync(files.get(url)), '投递表指的必须是一个真实存在的文件');
    // 越界解不出来（同一条纪律：只在包里解）
    assert.equal(workshopBattleFilesFor([{ id: 'b', pack: 'b', url: '/workshop-battle/b/..%2F..%2Fsecret.mjs' }], root).size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('没有 meta/battle 的插件 ⇒ 三个桥都给空数组（展开后逐元素相同）', () => {
  assert.deepEqual(officialMetaModules([]), []);
  assert.deepEqual(officialBattleInstallers(null), []);
  assert.deepEqual(officialBattleModules(null), []);
  assert.deepEqual(officialBattleModules([]), []);
  const plain = [{ pack: 'p', hash: 'h', entry: 'e.mjs', mounted: { meta: [], battle: [] } }];
  assert.deepEqual(officialMetaModules(plain), []);
  assert.deepEqual(officialBattleInstallers(plain), []);
  assert.deepEqual(officialBattleModules(plain), [], '没有 battle ⇒ 不进投递表');
});
