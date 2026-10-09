// test/packMetaWiring.test.js — `server.meta` 的**接线与端到端验收**（DESIGN §29，B 段的收口）。
// 装配层本身（受限注册表、逐包回滚、多包冲突点名）由 `test/packMetaAssembly.test.js` 钉；这里钉的是四件「接起来之后
// 才成立」的事：
//
//   1. **包的处理器真的在真对局里跑起来**：一个声明了 `server.meta` 的包，它的 `onPrepStart` 在真 `Match` 里被派发，
//      效果从 `m.toast` 上看得见 —— 这是「装了包、效果不在」那类静默失败的正面反例；
//   2. **进程级那一份一个键都不多**（业主裁决：禁止全局 set/restore）—— 每局一份 fork 的实证；
//   3. **启动接线**：真服务器上，装了的 meta 包出现在 `lobby.workshop.meta`（index.js 把它交给了 Lobby）；
//   4. **装不上的 meta 模块 ⇒ 整包移出已加载集合**（与 `server.preDispatch` 同一个裁剪点）：源码里带非确定性的东西时，
//      真服务器的 `welcome.mods.packs` 里**没有**这个包。
//
// Run: node --test test/packMetaWiring.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadWorkshop, dropUnavailablePreDispatchPacks } from '../server/workshop.js';
import { loadMetaModules, buildRoomRegistry } from '../server/match/metaPack.js';
import { getDefaultRegistry, resetDefaultRegistry } from '../server/match/effectsMeta.js';
import { startServer } from '../server/index.js';
import { makeMatch } from './match/harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const MARKER = 'META-MARKER-ACTIVE';

/** 一个声明了 `server.meta` 的包目录（`module` 的字节由调用方给）。 */
function writePack(root, id, moduleSource, registers = ['global:testMarker']) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
    combat: true, server: { meta: { module: 'meta/effect.mjs', registers } },
  }));
  fs.writeFileSync(path.join(dir, 'meta', 'effect.mjs'), moduleSource);
  return dir;
}

const GOOD_MODULE = [
  '// 一个最小的 meta 模块：进准备阶段时给玩家一条提示（效果从 m.toast 上看得见）。',
  'export function registerMeta(registry) {',
  "  registry.global('testMarker', { onPrepStart(ctx) { ctx.toast('" + MARKER + "'); } });",
  '}',
  '',
].join('\n');
const BAD_MODULE = [
  "export function registerMeta(registry) { registry.global('testMarker', { onPrepStart() { return Math.random(); } }); }",
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------------------------
describe('真对局：包的 meta 处理器被派发，进程级那份注册表一个键都不多', () => {
  let tmp;
  let wsRoot;
  before(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-metawire-'));
    wsRoot = path.join(tmp, 'ws');
    writePack(wsRoot, 'marker-pack', GOOD_MODULE);
  });
  after(() => {
    resetDefaultRegistry();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('装配 → 真 Match：`onPrepStart` 跑起来，效果看得到', async () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    const { modules, errors } = await loadMetaModules(loaded, { log: quiet });
    assert.deepEqual(errors, []);
    assert.deepEqual(modules.map((m) => m.id), ['marker-pack']);

    const base = getDefaultRegistry();
    const baseKeysBefore = base.keys().slice().sort();
    const { registry, errors: buildErrors } = buildRoomRegistry({ packs: modules, base, log: quiet });
    assert.deepEqual(buildErrors, []);
    assert.ok(registry.has('global:testMarker'));

    const h = makeMatch({ mode: 'solo', registry }).start();
    h.toPrep(1);
    const toasts = h.sent.filter(([, msg]) => msg.t === 'm.toast').map(([, msg]) => msg.text);
    assert.ok(toasts.includes(MARKER), `包的处理器必须在真对局里被派发；实际收到的提示：${JSON.stringify(toasts)}`);
    assert.deepEqual(h.logs.error, [], '元处理器不该报错');

    // 禁止全局 set/restore：进程级那一份的键一个不多一个不少。
    assert.deepEqual(getDefaultRegistry().keys().slice().sort(), baseKeysBefore);
    assert.equal(getDefaultRegistry().has('global:testMarker'), false);
  });

  test('拿掉 registry ⇒ 对局照旧跑（默认那一份进程级注册表），提示不再出现', () => {
    const h = makeMatch({ mode: 'solo' }).start();
    h.toPrep(1);
    const toasts = h.sent.filter(([, msg]) => msg.t === 'm.toast').map(([, msg]) => msg.text);
    assert.equal(toasts.includes(MARKER), false, '没有包声明 meta 时不会有这条提示');
    assert.deepEqual(h.logs.error, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('启动接线：装得上的进 Lobby，装不上的整包移出', () => {
  let tmp;
  let srv;
  let badSrv;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-metaboot-'));
    const good = path.join(tmp, 'good');
    const bad = path.join(tmp, 'bad');
    writePack(good, 'marker-pack', GOOD_MODULE);
    writePack(bad, 'bad-pack', BAD_MODULE);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: good });
    badSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: bad });
  });
  after(async () => {
    if (srv) await srv.close();
    if (badSrv) await badSrv.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('装得上的包：Lobby 拿到了它的模块（`workshop.meta`）', () => {
    const meta = srv.lobby.workshop && srv.lobby.workshop.meta;
    assert.ok(Array.isArray(meta), 'index.js 必须把 meta 模块交给会话栈');
    assert.deepEqual(meta.map((m) => m.id), ['marker-pack']);
    assert.equal(typeof meta[0].registerMeta, 'function');
  });

  test('源码里带非确定性 ⇒ 整包移出已加载集合（`welcome.mods.packs` 里没有它）', () => {
    const packs = (badSrv.lobby.welcomeInfo().mods || { packs: [] }).packs.map((p) => p.id);
    assert.equal(packs.includes('bad-pack'), false, `被裁剪的包不该出现在线上摘要里：${JSON.stringify(packs)}`);
    const meta = badSrv.lobby.workshop && badSrv.lobby.workshop.meta;
    assert.deepEqual(meta, [], '它连模块都不该被装上');
  });

  test('裁剪点是同一个：把 meta 的错误喂给 `dropUnavailablePreDispatchPacks` 也会摘掉那个包', async () => {
    const root = path.join(tmp, 'bad');
    const loaded = loadWorkshop(root, { log: quiet });
    assert.ok(loaded.packs.some((p) => p.id === 'bad-pack'), '装载期（形状/文件）它是合法的 —— 拦它的是 meta 那一层');
    const { errors } = await loadMetaModules(loaded, { log: quiet });
    const pruned = dropUnavailablePreDispatchPacks(loaded, errors);
    assert.deepEqual(pruned.packs, []);
    assert.deepEqual(pruned.removed.map((r) => r.pack), ['bad-pack']);
    assert.equal(pruned.removed[0].code, 'META_BAD_SOURCE');
  });
});
