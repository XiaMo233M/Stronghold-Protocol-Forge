// test/packServerModules.test.js — 包的**服务端模块**载荷（`pack.json.server.modules`，DESIGN §28.14）。
//
// 这一类载荷存在的理由很具体：社区插件包要做的三件事（停机播报与快照留档、匿名对局统计落盘、给 `/healthz` 加字段）
// 每一条都与 kit 的契约相反（kit 明写「不碰文件系统、不碰网络」），今天只能靠**手改引擎文件**。这一格就是那条
// 不手改的通道，而它的安全性来自「**只给声明过的那几样**」：
//   * `uses` 是挂载点的闭枚举，没声明的那个一碰就抛（不是 `undefined` 那种要靠猜的失败）；
//   * `write: true` 才拿到 `host.io`，而它被限定在 `<状态目录>/mod/<包id>/`：包目录只读、引擎目录不在门面里；
//   * `matchClass` 是唯一能碰对局的挂载点，所以只有它要求包声明 `combat: true`；
//   * 模块的字节进包的内容哈希。
//
// Run: node --test test/packServerModules.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, SERVER_MODULE_USES } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { loadServerModules, mountServerModules, moduleStateDir, checkHealthzFields } from '../server/modModules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------------------
describe('声明层：`server.modules` 的形状与点名拒绝', () => {
  const base = (extra = {}) => ({
    id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x', ...extra,
  });
  const norm = (extra) => normalizePackManifest(base(extra), 'p', { hasAssets: false });
  const MOD = { id: 'ops', entry: 'server/ops.mjs', uses: ['shutdown', 'boot'] };

  test('合法声明：`uses` 按闭枚举次序归一化、`write` 缺省 false、模块按 id 排序', () => {
    const r = norm({ server: { modules: [{ id: 'zeta', entry: 'a/z.mjs', uses: ['healthz'] }, MOD] } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
    assert.deepEqual(r.pack.server.modules.map((m) => m.id), ['ops', 'zeta']);
    assert.deepEqual(r.pack.server.modules[0].uses, ['boot', 'shutdown'], '按枚举次序，不按书写次序');
    assert.equal(r.pack.server.modules[0].write, false, '缺省不写盘');
  });

  test('`write: true` 被记下来', () => {
    const r = norm({ server: { modules: [{ ...MOD, write: true }] } });
    assert.equal(r.ok, true);
    assert.equal(r.pack.server.modules[0].write, true);
  });

  test('每一种写错都点名拒绝', () => {
    const bad = (modules, code, note) => {
      const r = norm({ server: { modules } });
      assert.equal(r.ok, false, `${note}: 应当被拒`);
      assert.equal(r.error, code, `${note}: 期待 ${code}，实际 ${r.error} — ${r.detail}`);
    };
    bad('nope', 'MODULES_BAD_SHAPE', '不是数组');
    bad([], 'MODULES_BAD_SHAPE', '空数组');
    bad([{ ...MOD, extra: 1 }], 'MODULES_UNKNOWN_FIELD', '未知字段');
    bad([{ ...MOD, id: 'has space' }], 'MODULES_BAD_ID', 'id 非法');
    bad([MOD, MOD], 'MODULES_DUPLICATE_ID', 'id 重复');
    bad([{ ...MOD, entry: '/abs/ops.mjs' }], 'MODULES_BAD_ENTRY', '绝对路径');
    bad([{ ...MOD, entry: 'server/ops.js' }], 'MODULES_BAD_ENTRY', '不是 .mjs');
    bad([{ ...MOD, entry: 'server/' }], 'MODULES_BAD_ENTRY', '不是文件');
    bad([{ ...MOD, uses: [] }], 'MODULES_BAD_USES', '空 uses');
    bad([{ ...MOD, uses: ['nope'] }], 'MODULES_BAD_USES', '未知挂载点');
    bad([{ ...MOD, uses: ['boot', 'boot'] }], 'MODULES_DUPLICATE_USE', '挂载点重复');
    bad([{ ...MOD, write: 'yes' }], 'MODULES_BAD_WRITE', 'write 不是布尔');
    bad(Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, entry: `a${i}.mjs`, uses: ['boot'] })), 'MODULES_TOO_MANY', '超过 8 个');
  });

  test('`matchClass` 必须配 `combat: true`；只挂 boot / healthz 的不需要', () => {
    const withMatch = { server: { modules: [{ id: 'stats', entry: 'server/stats.mjs', uses: ['matchClass'] }] } };
    const r1 = norm(withMatch);
    assert.equal(r1.ok, false);
    assert.equal(r1.error, 'MODULES_NEED_COMBAT');
    const r2 = norm({ ...withMatch, combat: true });
    assert.equal(r2.ok, true, r2.ok ? '' : `${r2.error} — ${r2.detail}`);
    const r3 = norm({ server: { modules: [{ id: 'ops', entry: 'server/ops.mjs', uses: ['boot', 'shutdown'] }] }, combat: false });
    assert.equal(r3.ok, true, '碰不到对局的挂载点不需要 combat');
    // 类型错误先报（与 meta 那条闸门同一个顺序）
    const r4 = norm({ ...withMatch, combat: 'yes' });
    assert.equal(r4.error, 'BAD_COMBAT');
  });

  test('只声明 `server.modules` 的包是一个合法包（贡献项）', () => {
    const r = norm({ server: { modules: [MOD] } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
    assert.ok(r.pack.server.modules.length);
  });

  test('挂载点闭枚举就是那四个', () => {
    assert.deepEqual(SERVER_MODULE_USES, ['boot', 'shutdown', 'matchClass', 'healthz']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('装载期与身份：文件、字节、layer', () => {
  let tmp;
  let wsRoot;
  const OP = 'export function registerServer(host) { host.onBoot(() => {}); }\n';
  before(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-srvmod-'));
    wsRoot = path.join(tmp, 'ws');
    const dir = path.join(wsRoot, 'ops-pack');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'ops-pack', name: 'Ops', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      server: { modules: [{ id: 'ops', entry: 'server/ops.mjs', uses: ['boot', 'healthz'] }] },
    }));
    fs.writeFileSync(path.join(dir, 'server', 'ops.mjs'), OP);
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('模块字节进内容哈希；改一个字节换一个摘要', () => {
    const before = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'ops-pack');
    assert.ok(before.manifest.some((m) => m.path === 'server/ops.mjs'), '模块源码在身份清单里');
    assert.equal(before.layer, 'B', '服务端模块属于 B 层');
    assert.equal(before.combat, false, '只有 boot/healthz 的包不该被推导成 combat');
    const file = path.join(wsRoot, 'ops-pack', 'server', 'ops.mjs');
    fs.writeFileSync(file, `${OP}// x\n`);
    const after = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'ops-pack');
    assert.notEqual(after.hash, before.hash);
    fs.writeFileSync(file, OP);
    assert.equal(loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'ops-pack').hash, before.hash);
  });

  test('声明的 entry 读不到 ⇒ 整包被拒并点名', () => {
    const dir = path.join(tmp, 'missing');
    fs.mkdirSync(path.join(dir, 'gone'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gone', 'pack.json'), JSON.stringify({
      id: 'gone', name: 'Gone', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      server: { modules: [{ id: 'ops', entry: 'server/nope.mjs', uses: ['boot'] }] },
    }));
    const loaded = loadWorkshop(dir, { log: quiet });
    assert.equal(loaded.packs.some((p) => p.id === 'gone'), false);
    assert.match(loaded.errors.find((e) => e.pack === 'gone').reason, /MODULES_BAD_ENTRY/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('装载与宿主：挂载点权限、io 门面、挂载器', () => {
  let tmp;
  let wsRoot;
  let stateRoot;
  const MODULE = `
export function registerServer(host) {
  host.onBoot(() => { host.log.info('booted'); });
  if (host.io && host.uses !== undefined) { /* 只是读一下，不写 */ }
  host.healthz(() => ({ tag: 'x', n: 1 }));
}
`;
  before(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-srvmod2-'));
    wsRoot = path.join(tmp, 'ws');
    stateRoot = path.join(tmp, 'var');
    const dir = path.join(wsRoot, 'a-pack');
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'a-pack', name: 'A', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      server: { modules: [{ id: 'ops', entry: 'server/ops.mjs', uses: ['boot', 'healthz'], write: true },
        { id: 'nope', entry: 'server/nope.mjs', uses: ['boot'] }] },
    }));
    fs.writeFileSync(path.join(dir, 'server', 'ops.mjs'), MODULE);
    fs.writeFileSync(path.join(dir, 'server', 'nope.mjs'), 'export const x = 1;\n');
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('装了 registerServer 的进列表，没有它的点名（MODULES_NO_REGISTER）', async () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    const { modules, errors } = await loadServerModules(loaded, { log: quiet, stateRoot });
    assert.deepEqual(modules.map((m) => m.id), ['ops']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'MODULES_NO_REGISTER');
    assert.match(errors[0].reason, /registerServer/);
  });

  test('挂载器：boot 真的跑、healthz 按包分组收字段', async () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const { modules } = await loadServerModules(loaded, { log: quiet, stateRoot });
    const mount = mountServerModules(modules, { log: quiet });
    mount.boot();
    assert.deepEqual(mount.healthz(), { 'a-pack': { tag: 'x', n: 1 } });
    assert.deepEqual(mount.matchClassWrappers(), []);
    mount.shutdown();
  });

  test('没声明的挂载点一碰就抛（不是 undefined）', async () => {
    const dir = path.join(tmp, 'ws2');
    const packDir = path.join(dir, 'b-pack');
    fs.mkdirSync(path.join(packDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
      id: 'b-pack', name: 'B', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      combat: true,
      server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'] }] },
    }));
    fs.writeFileSync(path.join(packDir, 'server', 'm.mjs'), 'export function registerServer(host) { host.matchClass(() => {}); }\n');
    const { modules, errors } = await loadServerModules(loadWorkshop(dir, { log: quiet }), { log: quiet, stateRoot });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'MODULE_USE_UNDECLARED');
    assert.match(errors[0].reason, /matchClass/);
  });

  test('io 门面：写在包自己的状态目录里，爬出去一律拒', async () => {
    const dir = path.join(tmp, 'ws3');
    const packDir = path.join(dir, 'c-pack');
    fs.mkdirSync(path.join(packDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
      id: 'c-pack', name: 'C', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      server: { modules: [{ id: 'io', entry: 'server/io.mjs', uses: ['boot'], write: true }] },
    }));
    // 模块在 boot 时写两个文件：一个合法、一个试图爬出去（必须抛）
    fs.writeFileSync(path.join(packDir, 'server', 'io.mjs'), [
      'export function registerServer(host) {',
      '  host.onBoot(() => {',
      "    host.io.write('sub/state.json', '{\"n\":1}');",
      "    host.io.append('sub/log.txt', 'line\\n');",
      '    try { host.io.write(\'../escape.json\', \'x\'); host.log.info(\'ESCAPED\'); } catch (e) { host.log.info(\'refused:\' + e.code); }',
      '    try { host.io.write(\'/abs.json\', \'x\'); } catch (e) { host.log.info(\'refused-abs:\' + e.code); }',
      '  });',
      '}',
      '',
    ].join('\n'));
    const loaded = loadWorkshop(dir, { log: quiet });
    const said = [];
    const log = { info: (...a) => said.push(a.join(' ')), warn() {}, error() {}, debug() {} };
    // 宿主上的 `log` 是**装载期**给的那一个（模块自己的日志出口），所以两次都要给同一个收集器。
    const { modules, errors } = await loadServerModules(loaded, { log, stateRoot });
    assert.deepEqual(errors, []);
    mountServerModules(modules, { log }).boot();
    const own = moduleStateDir(stateRoot, 'c-pack');
    assert.equal(fs.readFileSync(path.join(own, 'sub', 'state.json'), 'utf8'), '{"n":1}');
    assert.equal(fs.readFileSync(path.join(own, 'sub', 'log.txt'), 'utf8'), 'line\n');
    assert.ok(said.some((l) => l.includes('refused:MODULE_IO_BAD_PATH')), said.join(' | '));
    assert.ok(said.some((l) => l.includes('refused-abs:MODULE_IO_BAD_PATH')), said.join(' | '));
    assert.equal(fs.existsSync(path.join(stateRoot, 'escape.json')), false, '爬出去的那个文件一个字节都不该出现');
    assert.equal(ROOT.length > 0, true);
  });

  test('`write: false` 的模块拿不到 io（一碰就抛）', async () => {
    const dir = path.join(tmp, 'ws4');
    const packDir = path.join(dir, 'd-pack');
    fs.mkdirSync(path.join(packDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({
      id: 'd-pack', name: 'D', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      server: { modules: [{ id: 'ro', entry: 'server/ro.mjs', uses: ['boot'] }] },
    }));
    fs.writeFileSync(path.join(packDir, 'server', 'ro.mjs'), 'export function registerServer(host) { host.io.write(\'a\', \'b\'); }\n');
    const { modules, errors } = await loadServerModules(loadWorkshop(dir, { log: quiet }), { log: quiet, stateRoot });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'MODULE_USE_UNDECLARED');
  });

  test('healthz 的回执判据：扁平标量、有上限', () => {
    assert.deepEqual(checkHealthzFields(null, 'm'), { ok: true, fields: null });
    assert.equal(checkHealthzFields([1], 'm').ok, false, '数组不算扁平对象');
    assert.equal(checkHealthzFields({ a: { b: 1 } }, 'm').ok, false, '嵌套对象会撑大 /healthz');
    assert.equal(checkHealthzFields({ a: Number.NaN }, 'm').ok, false, '非有限数不是 JSON');
    assert.equal(checkHealthzFields({ a: 'x'.repeat(3000) }, 'm').ok, false, '超过字节上限');
    assert.deepEqual(checkHealthzFields({ a: 1, b: 'x', c: true, d: null }, 'm').fields, { a: 1, b: 'x', c: true, d: null });
  });
});
