// test/packServerModulesWire.test.js — 服务端模块**接线到真服务器**（DESIGN §28.14，G2 第二半）。
//
// 第一半（`test/packServerModules.test.js`）验的是声明层、装载器与宿主；这里验的是「接起来之后」才成立的四件事：
//   1. `onBoot` 在**端口绑好之后**真的跑了一次，而且它写的东西落在**自己的状态目录**里（`SP_STATE_DIR`）；
//   2. `healthz` 的字段出现在 `GET /healthz` 的 `modHealth` 上，按包 id 分组；
//   3. `uses: ['matchClass']` 的包装器**真的套在 MatchClass 上**：开一局，计数器就动；
//   4. 装不上的包（挂了自己没声明的挂载点）与 `server.preDispatch` / `server.meta` 走**同一个裁剪点**，
//      从 `welcome.mods.packs` 里消失。
// 另外：**没有任何包声明服务端模块时，`/healthz` 里没有 `modHealth` 这个键**（干净安装的字节不变）。
//
// Run: node --test test/packServerModulesWire.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'docs/examples');

/** 一个包目录：`pack.json` + 一个 `server/<id>.mjs`。 */
function writePack(root, id, declaration, source) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2', ...declaration,
  }));
  for (const [name, body] of Object.entries(source)) fs.writeFileSync(path.join(dir, 'server', name), body);
  return dir;
}

const OPS = [
  'let boots = 0;',
  'export function registerServer(host) {',
  '  host.onBoot(() => { boots += 1; host.io.write("state.json", JSON.stringify({ boots })); });',
  '  host.healthz(() => ({ boots, wrote: host.io.exists("state.json"), pack: host.pack }));',
  '}',
  '',
].join('\n');

const STATS = [
  'let matches = 0;',
  'export function registerServer(host) {',
  '  host.matchClass((Base) => class extends Base { constructor(o) { super(o); matches += 1; } });',
  '  host.healthz(() => ({ matches }));',
  '}',
  '',
].join('\n');

const BAD = [
  "export function registerServer(host) { host.io.write('x', 'y'); }", // 没声明 write，也没有 io
  '',
].join('\n');

describe('真服务器：boot / healthz / matchClass / 裁剪', () => {
  let tmp;
  let wsRoot;
  let srv;
  let clean;
  let digest;
  const saved = process.env.SP_STATE_DIR;
  const clients = [];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-modwire-'));
    wsRoot = path.join(tmp, 'ws');
    process.env.SP_STATE_DIR = path.join(tmp, 'var');   // 绝不往仓库里写（那三件原件写的是 var/state、var/stats）
    writePack(wsRoot, 'ops-pack', { server: { modules: [{ id: 'ops', entry: 'server/ops.mjs', uses: ['boot', 'healthz'], write: true }] } }, { 'ops.mjs': OPS });
    writePack(wsRoot, 'stats-pack', { combat: true, server: { modules: [{ id: 'stats', entry: 'server/stats.mjs', uses: ['matchClass', 'healthz'] }] } }, { 'stats.mjs': STATS });
    writePack(wsRoot, 'bad-pack', { server: { modules: [{ id: 'bad', entry: 'server/bad.mjs', uses: ['boot'] }] } }, { 'bad.mjs': BAD });
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    clean = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
    digest = srv.lobby.welcomeInfo().mods.digest;
  });
  after(async () => {
    for (const c of clients) { try { await c.close(); } catch { /* already closed */ } }
    if (srv) await srv.close();
    if (clean) await clean.close();
    if (saved === undefined) delete process.env.SP_STATE_DIR; else process.env.SP_STATE_DIR = saved;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('`onBoot` 跑了一次，而且写在自己的状态目录里', async () => {
    const state = path.join(tmp, 'var', 'mod', 'ops-pack', 'state.json');
    assert.ok(fs.existsSync(state), `模块应当在自己的状态目录里留下东西：${state}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')), { boots: 1 }, 'boot 恰好一次');
  });

  test('`GET /healthz` 带 `modHealth`，按包 id 分组', async () => {
    const health = await (await fetch(`${srv.url}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.deepEqual(Object.keys(health.modHealth).sort(), ['ops-pack', 'stats-pack']);
    assert.deepEqual(health.modHealth['ops-pack'], { boots: 1, wrote: true, pack: 'ops-pack' });
    assert.equal(health.modHealth['stats-pack'].matches, 0, '还没开过局');
    assert.equal(typeof health.mods, 'string', '包的摘要本来就在 lobby.stats() 里（DESIGN §28.9 第 2 项）');
  });

  test('干净安装：`/healthz` 里没有 `modHealth` 这个键', async () => {
    const health = await (await fetch(`${clean.url}/healthz`)).json();
    assert.equal('modHealth' in health, false);
  });

  test('`matchClass` 包装器真的套上了：开一局，计数就动', async () => {
    const c = await TestClient.connect(`${srv.url.replace('http', 'ws')}/ws`);
    clients.push(c);
    await c.hello('接线博士');
    const created = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    await c.waitFor('room.state');
    const started = await c.request({ t: 'room.start' });
    assert.equal(started.t, 'ok', JSON.stringify(started));
    await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    const health = await (await fetch(`${srv.url}/healthz`)).json();
    assert.equal(health.modHealth['stats-pack'].matches, 1, '包装器的构造函数跑了一次');
  });

  test('装不上的包与别的载荷走同一个裁剪点：从 `welcome.mods.packs` 里消失', async () => {
    const packs = srv.lobby.welcomeInfo().mods.packs.map((p) => p.id);
    assert.equal(packs.includes('bad-pack'), false, `被裁剪的包不该出现在摘要里：${JSON.stringify(packs)}`);
    assert.deepEqual(packs.sort(), ['ops-pack', 'stats-pack']);
    assert.equal('bad-pack' in (await (await fetch(`${srv.url}/healthz`)).json()).modHealth, false);
  });

  test('停机：`onShutdown` 只记日志、不阻塞关闭', async () => {
    // 用一个只有 shutdown 的包单独起一台服务器，关掉它，确认关闭正常返回（回调里故意抛）
    const root = path.join(tmp, 'shutdown-ws');
    writePack(root, 'bye-pack', {
      server: { modules: [{ id: 'bye', entry: 'server/bye.mjs', uses: ['shutdown', 'healthz'], write: true }] },
    }, {
      'bye.mjs': [
        'export function registerServer(host) {',
        "  host.onShutdown(() => { host.io.write('bye.txt', new Date().toISOString()); throw new Error('boom'); });",
        '}',
        '',
      ].join('\n'),
    });
    const s = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
    await s.close();
    assert.ok(fs.existsSync(path.join(tmp, 'var', 'mod', 'bye-pack', 'bye.txt')), '停机钩子跑过了（抛的那一下没拦住写入）');
  });
});
