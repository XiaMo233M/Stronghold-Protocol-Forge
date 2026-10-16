// test/modOfficialPanels.test.js — 官方档的客户端 UI 面板（C 档）：与 Forge 面板同一批槽位、同一条 URL 约定，
// 因此 `welcome.modPanels` 与 `/workshop-panels/…` 的投递表**一行都不用改**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadOfficialPlugins, OFFICIAL_PLUGIN_MANIFEST } from '../server/mod-manager/officialLoader.js';
import { officialPanels } from '../server/mod-manager/officialPanels.js';
import { workshopPanelFilesFor } from '../server/http/workshop.js';
import { fromOfficialManifest } from '../shared/sdk/descriptor.js';
import { CLIENT_PANEL_SLOTS, WORKSHOP_PANEL_PREFIX } from '../shared/workshop.js';
import { SDK_UPSTREAM } from '../shared/sdk/sdkConstants.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeRoot(plugins) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sp-panel-'));
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

test('面板进清单：与 Forge 面板同形（pack/id/slot/module/url），URL 走同一个前缀与 ?v=<hash12>', () => {
  const root = makeRoot([{
    name: 'ui',
    manifest: { panels: [{ id: 'banner', slot: 'screen.game.hud', module: 'panel/hud.js', messages: ['hud-chat'] }] },
    files: { 'panel/hud.js': 'export const x = 1;' },
  }]);
  try {
    const { plugins } = loadOfficialPlugins(root, { log: quiet });
    assert.equal(plugins[0].descriptor.layer, 'C', '只有面板 ⇒ C 档');
    assert.ok(plugins[0].descriptor.capabilities.includes('panels'));

    const { panels, errors } = officialPanels(plugins);
    assert.deepEqual(errors, []);
    assert.equal(panels.length, 1);
    const p = panels[0];
    assert.equal(p.pack, 'ui');
    assert.equal(p.id, 'banner');
    assert.equal(p.slot, 'screen.game.hud');
    assert.equal(p.module, 'panel/hud.js');
    assert.ok(p.url.startsWith(`${WORKSHOP_PANEL_PREFIX}ui/panel/hud.js?v=`), `url=${p.url}`);
    assert.deepEqual(p.messages, ['hud-chat'], 'messages 原样带出（Lobby 的 packChannels 靠它）');
    assert.ok(CLIENT_PANEL_SLOTS.includes(p.slot), '槽位来自引擎那张闭枚举');

    // 投递表：与 Forge 面板同一张表、同一个根替换 ⇒ 指到插件目录里的真实文件（键是**去掉 query** 的路径）
    const files = workshopPanelFilesFor(panels, root);
    const key = p.url.split('?')[0];
    assert.equal(files.size, 1);
    assert.equal(files.get(key), path.join(root, 'ui', 'panel', 'hud.js'));
    assert.ok(fs.existsSync(files.get(key)));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('坏声明只丢那一个面板并点名：未知槽位 / 模块不在插件内', () => {
  const root = makeRoot([
    { name: 'a', manifest: { panels: [{ id: 'x', slot: 'screen.nope', module: 'p.js' }] }, files: { 'p.js': '' } },
    { name: 'b', manifest: { panels: [{ id: 'y', slot: 'root.guide', module: 'missing.js' }] }, files: {} },
  ]);
  try {
    const { panels, errors } = officialPanels(loadOfficialPlugins(root, { log: quiet }).plugins);
    assert.deepEqual(panels, []);
    const by = Object.fromEntries(errors.map((e) => [e.pack, e]));
    assert.equal(by.a.code, 'PANEL_UNKNOWN_SLOT');
    assert.match(by.a.reason, /screen\.nope/);
    assert.equal(by.b.code, 'PANEL_BAD_MODULE');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('描述符：panels 的形状校验（module 必须是插件内相对路径；messages 必须是字符串数组）', () => {
  const bad1 = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, panels: [{ slot: 'root.guide', module: '../escape.js' }] });
  assert.equal(bad1.descriptor, null);
  assert.ok(bad1.issues.some((i) => /pack-relative/.test(i.reason)));
  const bad2 = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, panels: [{ slot: 'root.guide', module: 'a.js', messages: [1] }] });
  assert.equal(bad2.descriptor, null);
  assert.ok(bad2.issues.some((i) => /messages/.test(i.reason)));
  const bad3 = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, panels: {} });
  assert.equal(bad3.descriptor, null);
  const ok = fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, panels: [{ slot: 'root.guide', module: 'a.js' }] });
  assert.equal(ok.descriptor.layer, 'C');
  assert.equal(ok.descriptor.panels[0].module, 'a.js');
});

test('layer 优先级：服务端载荷 > 面板 > 纯内容', () => {
  assert.equal(fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, content: ['items'] }).descriptor.layer, 'A');
  assert.equal(fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, panels: [{ slot: 'root.guide', module: 'a.js' }] }).descriptor.layer, 'C');
  assert.equal(fromOfficialManifest({ id: 'x', sdk: SDK_UPSTREAM, apis: ['health'], panels: [{ slot: 'root.guide', module: 'a.js' }] }).descriptor.layer, 'B');
});

test('没有面板的插件 ⇒ 空清单（展开后逐元素相同）', () => {
  assert.deepEqual(officialPanels([]).panels, []);
  assert.deepEqual(officialPanels(null).panels, []);
  assert.deepEqual(officialPanels([{ id: 'p', hash: 'h', dir: '/tmp', descriptor: { panels: [] } }]).panels, []);
});
