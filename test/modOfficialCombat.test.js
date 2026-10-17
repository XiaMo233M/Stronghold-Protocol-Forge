// test/modOfficialCombat.test.js — 官方档的「改对局结果」那两格（0.3.0 词表下）：
//   * 宿主面：`meta` 面按 `meta.code` 派生、战斗逻辑就是 `sim.code` + `entry.sim`（上游没有 `battle` 概念）；
//   * 确定性那条线：声明 `sim` / `meta` 的插件**并上** kit 那张表（时钟 / 随机 / 计时器）；
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

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makePlugin(root, name, manifest, entryBody) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OFFICIAL_PLUGIN_MANIFEST), JSON.stringify({ manifest: 2, api: 1, id: name, name, version: '1.0.0', ...manifest }));
  if (entryBody) fs.writeFileSync(path.join(dir, 'plugin.mjs'), entryBody);
  return dir;
}

/** 0.3.0 里「有代码」的声明：class trusted + sim.code（+ meta.code 表示还要挂 meta 面）。
 *  用 `trusted` 而不是 `script`：本版**没有把沙箱接进运行时**，`script`（profile `sandbox`）在装载门被具名拒
 *  （见 `test/modOfficialManifest.test.js` 的拒载用例）—— 进程内执行的是 `trusted` 档。 */
const script = (extra = {}) => ({
  class: 'trusted', scope: 'server', permissions: ['sim.code', ...(extra.meta ? ['meta.code'] : [])],
  entry: { sim: 'plugin.mjs', ...(extra.meta ? { meta: 'plugin.mjs' } : {}) },
  ...(extra.overrides ? { overrides: extra.overrides } : {}),
});

test('宿主面：`meta` 面按 meta.code 派生；未声明的面（content 档）碰 meta 就抛', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat-'));
  try {
    makePlugin(root, 'm', script({ meta: true, overrides: ['item:demo'] }),
      `export function registerPlugin(host) { host.meta.register('item:demo', () => ({ ok: true })); }`);
    const a = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    assert.deepEqual(a.errors, []);
    assert.deepEqual(a.modules[0].mounted.meta.map((r) => r.key), ['item:demo']);
    assert.deepEqual(a.modules[0].registers, ['item:demo'], 'overrides → registers');

    makePlugin(root, 'c', { class: 'content', permissions: ['data.patch'], entry: { sim: 'plugin.mjs' } },
      `export function registerPlugin(host) { host.meta.register('item:x', () => 1); }`);
    const b = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins.filter((p) => p.id === 'c'), { log: quiet });
    assert.equal(b.errors[0].code, 'PLUGIN_PERMISSION_MISSING');
    assert.match(b.errors[0].reason, /meta/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('确定性那条线：声明 sim / meta 的插件**并上** kit 表（Math.random / Date.now 被拒）', () => {
  // 不碰对局结果的档：时钟可用（那一层没有确定性契约）
  assert.deepEqual(officialPluginSourceIssues('const t = Date.now();', 'p', { capabilities: ['content'] }), []);
  assert.deepEqual(officialPluginSourceIssues('const t = Date.now();', 'p', { capabilities: ['health'] }), []);
  // script(sim) / meta ⇒ 并上 kit 表
  const a = officialPluginSourceIssues('const t = Date.now();', 'p', { capabilities: ['sim'] });
  assert.equal(a[0].code, 'PLUGIN_SCRIPT_CHECK');
  assert.match(a[0].reason, /Date.now/);
  const b = officialPluginSourceIssues('const r = Math.random();', 'p', { capabilities: ['meta'] });
  assert.match(b[0].reason, /Math.random/);
  // 严格档本身仍然生效（globalThis）
  assert.match(officialPluginSourceIssues('globalThis.x = 1;', 'p', { capabilities: ['content'] })[0].reason, /globalThis/);
});

test('meta 桥：重放成 registerMeta(registry)，且受**真的** buildRoomRegistry 白名单约束', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat3-'));
  try {
    makePlugin(root, 'm', script({ meta: true, overrides: ['item:declared'] }),
      `export function registerPlugin(host) { host.meta.register('item:declared', () => 'registered'); }`);
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
    makePlugin(root, 'greedy', script({ meta: true, overrides: ['item:declared'] }),
      `export function registerPlugin(host) { host.meta.register('item:not-declared', () => 1); }`);
    const { modules } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const { registry, errors } = buildRoomRegistry({ packs: officialMetaModules(modules), base: new MetaRegistry(), log: quiet });
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /not-declared/);
    assert.equal(errors[0].pack, 'greedy');
    assert.equal(registry, null, '一个包都没成功 ⇒ 没有房间注册表');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('战斗逻辑桥：`sim.code` + `entry.sim` ⇒ 重放成 install(battle)（与 Forge 的 installers 同形）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat5-'));
  try {
    makePlugin(root, 'b', script(),
      `export function registerPlugin(host) { host.battle.install((battle) => { battle.installedBy = 'b'; }); }`);
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

test('战斗模块投递面：URL 走同一条约定，且**真表**指向插件目录里的那个文件', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat6-'));
  try {
    makePlugin(root, 'b', script(), `export function registerPlugin(host) { host.battle.install(() => {}); }`);
    const { modules } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    const list = officialBattleModules(modules);
    assert.equal(list.length, 1);
    assert.match(list[0].url, /^\/workshop-battle\/b\/plugin\.mjs\?v=/);
    assert.equal(list[0].pack, 'b');

    const files = workshopBattleFilesFor(list, root);
    const url = list[0].url.split('?')[0];
    assert.equal(files.size, 1);
    assert.equal(files.get(url), path.join(root, 'b', 'plugin.mjs'));
    assert.ok(fs.existsSync(files.get(url)), '投递表指的必须是一个真实存在的文件');
    // 越界解不出来（同一条纪律：只在包里解）
    assert.equal(workshopBattleFilesFor([{ id: 'b', pack: 'b', url: '/workshop-battle/b/..%2F..%2Fsecret.mjs' }], root).size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('没有 meta / 战斗登记的插件 ⇒ 三个桥都给空数组（展开后逐元素相同）', () => {
  assert.deepEqual(officialMetaModules([]), []);
  assert.deepEqual(officialBattleInstallers(null), []);
  assert.deepEqual(officialBattleModules(null), []);
  assert.deepEqual(officialBattleModules([]), []);
  const plain = [{ pack: 'p', hash: 'h', entry: 'e.mjs', mounted: { meta: [], battle: [] } }];
  assert.deepEqual(officialMetaModules(plain), []);
  assert.deepEqual(officialBattleInstallers(plain), []);
  assert.deepEqual(officialBattleModules(plain), [], '没有战斗登记 ⇒ 不进投递表');
});

test('装载门：`class: script`（profile sandbox）被**具名拒载**，源码永不 import', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat7-'));
  try {
    // 顶层副作用探针：真的被 import 了，文件系统上就会留下这个标记
    const marker = path.join(root, 'imported.marker');
    makePlugin(root, 's', { class: 'script', permissions: ['sim.code'], entry: { sim: 'plugin.mjs' } },
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\nexport function registerPlugin(host) { host.battle.install(() => {}); }`);
    const { modules, errors } = await loadOfficialModules(loadOfficialPlugins(root, { log: quiet }).plugins, { log: quiet });
    assert.deepEqual(modules, [], '沙箱档不被装载');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'PLUGIN_SANDBOX_UNAVAILABLE');
    assert.equal(errors[0].pack, 's');
    assert.match(errors[0].reason, /sandbox/);
    assert.equal(fs.existsSync(marker), false, '被拒的插件连字节都不该进这一进程（顶层副作用没发生）');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('装载门：`filter` 拦下的插件**既不扫描也不 import**（计划之外的代码永不执行）', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-combat8-'));
  try {
    const marker = path.join(root, 'imported2.marker');
    makePlugin(root, 'keep', { class: 'trusted', scope: 'server', permissions: ['sim.code'], entry: { sim: 'plugin.mjs' } },
      `export function registerPlugin(host) { host.battle.install(() => {}); }`);
    makePlugin(root, 'drop', { class: 'trusted', scope: 'server', permissions: ['sim.code'], entry: { sim: 'plugin.mjs' } },
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\nexport function registerPlugin(host) { host.battle.install(() => {}); }`);
    const plugins = loadOfficialPlugins(root, { log: quiet }).plugins;
    const { modules, errors } = await loadOfficialModules(plugins, { log: quiet, filter: (p) => p.id === 'keep' });
    assert.deepEqual(errors, []);
    assert.deepEqual(modules.map((m) => m.pack), ['keep'], '只有计划里的插件被装载');
    assert.equal(fs.existsSync(marker), false, '被 filter 拦下的插件，顶层副作用没发生');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
