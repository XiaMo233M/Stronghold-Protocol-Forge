// test/packMetaAssembly.test.js — B 段：包声明的**对局元注册表模块**的装配（`pack.json.server.meta`，DESIGN §29）。
//
// A 段（`test/packMeta.test.js`）只判**声明**；这里判**装配**：静态确定性扫描 → 动态 import → 受限注册表逐包注册。
// 断言分五组，每一组对应一条不许破的纪律：
//   1. 静态判据：`Math.random` / `Date.now` / `process` 这类东西**在 import 之前**就被点名（错误码与 kit 那套同源）；
//      一条非包内的 `import` 也在此拦下 —— 引擎辅助函数走 `registry.api`，不走 import；
//   2. 白名单：`registers` 之外的键一注册就抛（`META_UNDECLARED_KEY`），且**这个包这次注册过的键一并回滚**
//      ——「装了一半的包」不许存在（§28.13.3 的口径）；
//   3. 多包：两个包抢同一个键时**包 id 小的持有它**（DESIGN §28.3），输的那次装配点名（`META_KEY_TAKEN`）并整体回滚；
//   4. 边界：只读面开放、写面只有 `register` / `unregister`；`unregister` 只许撤自己注册过的那几个
//      —— 撤掉官方处理器与覆盖它是同一件事，而且更难发现；
//   5. 不变量：没装任何 meta 包时 `buildRoomRegistry` 回 `null`（调用方据此照旧用进程级那一份），
//      且装配**从不**改进程级的 `getDefaultRegistry()`（「禁止全局 set/restore」）。
//
// Run: node --test test/packMetaAssembly.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { loadWorkshop } from '../server/workshop.js';
import { MetaRegistry, resetDefaultRegistry } from '../server/match/effectsMeta.js';
import {
  GuardedMetaRegistry, META_API, MetaRefused, buildRoomRegistry, keyDeclared, loadMetaModules, metaSourceIssues,
} from '../server/match/metaPack.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const HANDLER = 'export function registerMeta(r) { r.bond("shared", { onRoundStart() {} }); }\n';

// ---------------------------------------------------------------------------------------------------------------
// 1. 静态判据（纯函数，不需要磁盘）

describe('server.meta 的静态判据：在 import 之前点名', () => {
  test('非确定性 / 环境绑定的名字被点名（与 kit 那套同一份名单 + 服务端多出来的那几个）', () => {
    for (const src of ['export function registerMeta(){ return Math.random(); }',
      'export function registerMeta(){ return Date.now(); }',
      'export function registerMeta(){ return process.env.HOME; }',
      'export function registerMeta(){ return globalThis.x; }']) {
      const issues = metaSourceIssues(src, 'p');
      assert.equal(issues[0]?.code, 'META_BAD_SOURCE', src);
      assert.ok(issues[0].reason.includes('p'), '拒绝理由要点名是哪个包');
    }
  });

  test('注释里提到这些名字不算 —— 头注里解释「为什么不能用 Math.random」是允许的', () => {
    const src = '// never call Math.random() here: the server recomputes this match\nexport function registerMeta(){}\n';
    assert.deepEqual(metaSourceIssues(src, 'p'), []);
  });

  test('只许 import 包内文件，且不许爬出包：引擎辅助函数走 registry.api', () => {
    // `meta/m.mjs` 在包内只深一层，所以 `../x.mjs` 还在包里（= pack/x.mjs），但 `../../` 就出去了 —— 那正是
    // 「把引擎的内部路径写进包」这条路，必须点名。
    const ok = metaSourceIssues("import { helper } from '../lib/helper.mjs';\nimport { n } from './n.mjs';\nexport function registerMeta(){}\n", 'p', 'meta/m.mjs');
    assert.deepEqual(ok, []);
    const esc = metaSourceIssues("import { num } from '../../server/sim/content/support/index.js';\nexport function registerMeta(){}\n", 'p', 'meta/m.mjs');
    assert.equal(esc[0].code, 'META_BAD_IMPORT');
    const bad = metaSourceIssues("import fs from 'node:fs';\nexport function registerMeta(){}\n", 'p', 'meta/m.mjs');
    assert.equal(bad[0].code, 'META_BAD_IMPORT');
  });

  test('白名单匹配：精确键与一条结尾 `*` 的前缀，别的一律不算', () => {
    assert.equal(keyDeclared('bond:kazdelShip', ['bond:kazdelShip']), true);
    assert.equal(keyDeclared('garrison:custom_a', ['garrison:custom_*']), true);
    assert.equal(keyDeclared('garrison:official', ['garrison:custom_*']), false);
    assert.equal(keyDeclared('band:kazdelShip', ['bond:kazdelShip']), false);
    assert.equal(keyDeclared('bond:kazdelShip', []), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2-5. 装配（真目录 + 真动态 import）

describe('server.meta 的装配：受限注册表、逐包回滚、多包冲突点名', () => {
  let tmp;
  const PACKS = {
    // id 升序：alpha < sneaky < zeta。两个包抢 `bond:shared`，所以 alpha 赢、zeta 整体回滚。
    alpha: {
      manifest: { server: { meta: { module: 'meta/m.mjs', registers: ['bond:shared', 'bond:alphaOnly'] } } },
      files: { 'meta/m.mjs': 'export function registerMeta(r) { r.bond("shared", { onRoundStart() {} }); r.bond("alphaOnly", { onRoundStart() {} }); }\n' },
    },
    zeta: {
      manifest: { server: { meta: { module: 'meta/m.mjs', registers: ['bond:shared', 'bond:zetaOnly'] } } },
      files: { 'meta/m.mjs': 'export function registerMeta(r) { r.bond("zetaOnly", { onRoundStart() {} }); r.bond("shared", { onRoundStart() {} }); }\n' },
    },
    sneaky: {
      // 声明一个键、注册两个：第二个不在白名单里 ⇒ 整次装配回滚（第一个也不留）
      manifest: { server: { meta: { module: 'meta/m.mjs', registers: ['bond:ok'] } } },
      files: { 'meta/m.mjs': 'export function registerMeta(r) { r.bond("ok", { onRoundStart() {} }); r.bond("undeclared", { onRoundStart() {} }); }\n' },
    },
    nomod: {
      manifest: { server: { meta: { module: 'meta/m.mjs', registers: ['bond:x'] } } },
      files: { 'meta/m.mjs': 'export const nope = 1;\n' },
    },
    rng: {
      manifest: { server: { meta: { module: 'meta/m.mjs', registers: ['bond:y'] } } },
      files: { 'meta/m.mjs': 'export function registerMeta(r) { r.bond("y", { onRoundStart() { return Math.random(); } }); }\n' },
    },
  };

  /** 只装载点名的那些包：每次测试一份独立目录，免得一个包的错误影响另一个。 */
  function loadOnly(...ids) {
    const dir = fs.mkdtempSync(join(tmp, 'ws-'));
    for (const id of ids) {
      const p = PACKS[id];
      const packDir = join(dir, id);
      fs.mkdirSync(packDir, { recursive: true });
      fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({
        id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2', combat: true, ...p.manifest,
      }));
      for (const [rel, body] of Object.entries(p.files)) {
        fs.mkdirSync(dirname(join(packDir, ...rel.split('/'))), { recursive: true });
        fs.writeFileSync(join(packDir, ...rel.split('/')), body);
      }
    }
    const loaded = loadWorkshop(dir, { log: quiet });
    assert.deepEqual(loaded.errors, [], `fixture 必须能加载：${JSON.stringify(loaded.errors)}`);
    return loaded;
  }

  before(() => { tmp = fs.mkdtempSync(join(tmpdir(), 'sp-metaasm-')); });
  after(() => {
    resetDefaultRegistry();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('一个包注册它声明过的键：注册表里有它，进程级那一份没有', async () => {
    const { modules, errors } = await loadMetaModules(loadOnly('alpha'), { log: quiet });
    assert.deepEqual(errors, []);
    assert.equal(modules.length, 1);
    const base = new MetaRegistry();
    base.register('bond:official', { onRoundStart() {} });
    const { registry, errors: buildErrors } = buildRoomRegistry({ packs: modules, base, log: quiet });
    assert.deepEqual(buildErrors, []);
    assert.deepEqual(registry.keys().sort(), ['bond:alphaOnly', 'bond:official', 'bond:shared']);
    assert.deepEqual(base.keys(), ['bond:official'], '进程级那份一个字都不许变（禁止全局 set/restore）');
    resetDefaultRegistry();
  });

  test('声明之外的键一注册就抛，而且这个包这次注册过的键一并回滚', async () => {
    const { modules } = await loadMetaModules(loadOnly('sneaky'), { log: quiet });
    const { registry, errors } = buildRoomRegistry({ packs: modules, base: new MetaRegistry(), log: quiet });
    assert.equal(errors[0].code, 'META_UNDECLARED_KEY');
    assert.match(errors[0].reason, /bond:undeclared/);
    assert.equal(registry, null, '一个键都没装成 ⇒ 回 null，调用方照旧用进程级那一份');
  });

  test('两个包抢同一个键：包 id 小的持有它，输的那次装配整体回滚并点名', async () => {
    const { modules } = await loadMetaModules(loadOnly('alpha', 'zeta'), { log: quiet });
    assert.deepEqual(modules.map((m) => m.id), ['alpha', 'zeta'], '装配顺序是包 id 升序（DESIGN §28.3）');
    const { registry, errors } = buildRoomRegistry({ packs: modules, base: new MetaRegistry(), log: quiet });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'META_KEY_TAKEN');
    assert.equal(errors[0].pack, 'zeta');
    assert.match(errors[0].reason, /"alpha"/, '理由要点名持有者');
    const keys = registry.keys().sort();
    assert.deepEqual(keys, ['bond:alphaOnly', 'bond:shared'], 'zeta 的 zetaOnly 也随它一起回滚');
  });

  test('没有 registerMeta 导出 ⇒ 装载期点名（META_NO_REGISTER），不上桌', async () => {
    const { modules, errors } = await loadMetaModules(loadOnly('nomod'), { log: quiet });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'META_NO_REGISTER');
  });

  test('源码里有 Math.random ⇒ 在 import 之前就被拒（META_BAD_SOURCE）', async () => {
    const { modules, errors } = await loadMetaModules(loadOnly('rng'), { log: quiet });
    assert.deepEqual(modules, []);
    assert.equal(errors[0].code, 'META_BAD_SOURCE');
    assert.match(errors[0].reason, /Math\.random/);
  });

  test('一个 meta 包都没有 ⇒ 回 null（调用方据此走进程级那一份，行为逐字节不变）', () => {
    const { registry, errors } = buildRoomRegistry({ packs: [], base: new MetaRegistry(), log: quiet });
    assert.equal(registry, null);
    assert.deepEqual(errors, []);
  });

  test('受限注册表：只读面开放，unregister 只许撤自己注册过的那几个', () => {
    const target = new MetaRegistry();
    target.register('bond:official', { onRoundStart() {} });
    const guard = new GuardedMetaRegistry(target, { id: 'p', registers: ['bond:mine'] }, new Map());
    assert.ok(guard.get('bond:official'), '只读面必须能读到官方处理器 —— 「官方有我就让路」这种合作要靠它');
    assert.throws(() => guard.unregister('bond:official'), (e) => e instanceof MetaRefused && e.code === 'META_NOT_OWNED',
      '撤掉官方处理器与覆盖它是同一件事，而且更难发现：日志里只会少一条效果');
    guard.bond('mine', { onRoundStart() {} });
    assert.equal(guard.has('bond:mine'), true);
    assert.equal(guard.unregister('bond:mine'), true, '自己这次注册过的可以撤');
    assert.equal(guard.has('bond:mine'), false);
    assert.throws(() => guard.register('bond:other', { onRoundStart() {} }), (e) => e.code === 'META_UNDECLARED_KEY');
    assert.ok(Object.isFrozen(META_API) && META_API.num('12', 0) === 12, 'registry.api 是冻结的接口面');
  });

  test('一个真模块经装载 + 装配后，处理器就在这一局的注册表里', async () => {
    const dir = fs.mkdtempSync(join(tmp, 'ws-plain-'));
    const packDir = join(dir, 'plain');
    fs.mkdirSync(join(packDir, 'meta'), { recursive: true });
    fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({
      id: 'plain', name: 'plain', version: '1.0.0', license: 'CC0-1.0', description: 'x',
      gameVersion: '0.2.2', combat: true, server: { meta: { module: 'meta/m.mjs', registers: ['bond:shared'] } },
    }));
    fs.writeFileSync(join(packDir, 'meta', 'm.mjs'), HANDLER);
    const { modules, errors } = await loadMetaModules(loadWorkshop(dir, { log: quiet }), { log: quiet });
    assert.deepEqual(errors, []);
    assert.deepEqual(modules[0].registers, ['bond:shared']);
    const { registry, errors: buildErrors } = buildRoomRegistry({ packs: modules, base: new MetaRegistry(), log: quiet });
    assert.deepEqual(buildErrors, []);
    assert.equal(typeof registry.get('bond:shared').onRoundStart, 'function');
  });
});
