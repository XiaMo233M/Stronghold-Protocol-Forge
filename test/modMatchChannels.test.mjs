// test/modMatchChannels.test.mjs — 包通道的**服务端那一半**（`server.modules[].channels`，DESIGN §28.23）：
// 声明面（形状层）与装载面各测一半。
//
// 为什么这个文件存在：`client.panels[].messages`（docs/WORKSHOP.md §1.9.6）给了包一条**说得出**的通道，而
// 「这一局收得到哪些通道」在此之前**没有声明面** —— 服务端只有一条笼统的 `matchClass` 挂载点。这一格补的是
// **声明**：一个模块可以点名它在对局里接收哪几条通道，判据与面板那半边**共用一份**（`PACK_CHANNEL_RE`），
// 并且每条名字还必须被本包某个面板声明过（否则客户端根本发不出来，那是一条「声明了却不可能发生」的声明）。
//
// 本文件只钉**已经落地的两半**：
//   形状层 —— 五条拒绝各自点名、合法时进归一化清单（排序、**只在声明时**出现，哈希稳定）；
//   装载层 —— 真 `loadServerModules` 把 `channels` 带出来，包装链照旧把方法套上。
//
// ⚠️ **投放面（`Lobby.packMsg` 按声明集合决定投不投）刻意不在这里**：那是 PR#2 的另一半，它会把
// `test/packMatchMsg.test.js` 钉住的「声明了 `matchClass` 的包就收得到 `handlePackMsg`」改成「声明过 `channels`
// 才收得到」。既有断言不放松，所以那一半没有随这一格落地，这里也不写一条会与它冲突的断言。
//
// 两层都不需要起服务：形状层是纯函数，装载层用临时目录 + 真 `loadServerModules`（唯一的写入落在 os.tmpdir()）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizePackManifest, PACK_CHANNEL_RE, MAX_SERVER_MODULE_CHANNELS } from '../shared/workshop.js';
import { loadServerModules, mountServerModules } from '../server/modModules.js';

const HASH_A = 'ab'.repeat(32);

/** 一个合法到形状层能过的最小清单：一个面板声明通道，一个服务端模块（**不含** channels —— 那是逐案加的）。 */
function manifest(over = {}) {
  const base = {
    id: 'probe',
    name: 'Probe',
    version: '1.0.0',
    combat: true,
    client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'client/p.js', messages: ['ping'] }] },
    server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'] }] },
  };
  return { ...base, ...over };
}

const norm = (raw) => normalizePackManifest(raw, 'probe');

test('形状层：通道名与面板共用一份判据；channels 合法时进清单（排序、只在声明时出现）', () => {
  assert.ok(PACK_CHANNEL_RE.test('ping') && PACK_CHANNEL_RE.test('borrow-2') && !PACK_CHANNEL_RE.test('Ping'), '包通道名一份判据，两半共用');

  const withCh = norm(manifest({
    client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'client/p.js', messages: ['ping', 'pong'] }] },
    server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['pong', 'ping'] }] },
  }));
  assert.equal(withCh.ok, true, withCh.detail);
  assert.deepEqual(withCh.pack.server.modules[0].channels, ['ping', 'pong'], '按字母序归一化：两个书写顺序是同一个包');

  const without = norm(manifest());
  assert.equal(without.ok, true, without.detail);
  assert.ok(!Object.hasOwn(without.pack.server.modules[0], 'channels'), '没声明的包一个字节都不变（哈希稳定）');
});

test('形状层：五条拒绝各自点名，combat 闸门照旧', () => {
  const tooMany = Array.from({ length: MAX_SERVER_MODULE_CHANNELS + 1 }, (_, i) => `c${i}`);
  const cases = [
    ['MODULES_UNKNOWN_CHANNEL', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['pong'] }] } })],
    ['MODULES_CHANNELS_NEED_MATCH', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'], channels: ['ping'] }] } })],
    ['MODULES_BAD_CHANNEL', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['Ping'] }] } })],
    ['MODULES_DUPLICATE_CHANNEL', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: ['ping', 'ping'] }] } })],
    ['MODULES_TOO_MANY_CHANNELS', manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: tooMany }] } })],
  ];
  for (const [code, raw] of cases) {
    const r = norm(raw);
    assert.equal(r.ok, false, `${code}: 这种写法应该被拒`);
    assert.equal(r.error, code, `${code}: 点名的是这一条`);
  }
  // channels 挂在 matchClass 上 ⇒ 模块已经能碰对局 ⇒ 整包仍须 combat: true（既有的 MODULES_NEED_COMBAT）
  const noCombat = norm(manifest({ combat: undefined }));
  assert.equal(noCombat.ok, false);
  assert.equal(noCombat.error, 'MODULES_NEED_COMBAT');
});

test('形状层：`channels` 是模块字段（写错拼法照旧 `MODULES_UNKNOWN_FIELD`），`[]` 与空表都被点名', () => {
  // 闭集：`SERVER_MODULE_FIELDS` 里没有的名字照旧被拒 —— 加这一格不许把闭集放松成通配。
  const typo = norm(manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channel: ['ping'] }] } }));
  assert.equal(typo.ok, false);
  assert.equal(typo.error, 'MODULES_UNKNOWN_FIELD');
  // 空数组不是「没声明」：要停用就删掉这个键（与 `uses` / `server.modules` 同一条「响亮」纪律）。
  const empty = norm(manifest({ server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], channels: [] }] } }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'MODULES_BAD_CHANNELS');
});

test('装载层：模块记录带出 channels，包装链把方法送进 handlePackMsg', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-channels-'));
  try {
    const packDir = path.join(root, 'probe');
    fs.mkdirSync(path.join(packDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'server', 'm.mjs'), [
      'export function registerServer(host) {',
      '  host.matchClass((Base) => class ProbeMatch extends Base {',
      '    handlePackMsg(playerId, msg) { host.io.append("inbox.ndjson", `${playerId}|${msg.channel}\\n`); }',
      '  });',
      '}',
    ].join('\n'));
    const loaded = await loadServerModules({
      packs: [{
        id: 'probe', dir: packDir, hash: HASH_A,
        server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['matchClass'], write: true, channels: ['ping'] }] },
      }],
    }, { stateRoot: root, log: { info() {}, warn() {}, error() {} } });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.modules[0].channels, ['ping'], '装载结果把接收通道带出来');
    assert.deepEqual(loaded.modules[0].uses, ['matchClass']);

    let cls = class Base {};
    for (const w of mountServerModules(loaded.modules).matchClassWrappers()) cls = w.fn(cls);
    const inst = new cls();
    assert.equal(typeof inst.handlePackMsg, 'function', '包装链真的把方法套上了');
    inst.handlePackMsg('p1', { pack: 'probe', channel: 'ping' });
    assert.equal(fs.readFileSync(path.join(root, 'mod', 'probe', 'inbox.ndjson'), 'utf8'), 'p1|ping\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('装载层：没声明 channels 的模块记录里**不长这个键**（与归一化清单同一条纪律）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-channels-none-'));
  try {
    const packDir = path.join(root, 'plain');
    fs.mkdirSync(path.join(packDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'server', 'm.mjs'), 'export function registerServer() {}\n');
    const loaded = await loadServerModules({
      packs: [{
        id: 'plain', dir: packDir, hash: HASH_A,
        server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'] }] },
      }],
    }, { stateRoot: root, log: { info() {}, warn() {}, error() {} } });
    assert.deepEqual(loaded.errors, []);
    assert.ok(!Object.hasOwn(loaded.modules[0], 'channels'), '没声明的模块不许长出这个键');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
