// test/workshopValidateRoutes.test.js — 作者侧校验器不许对「服务器会丢掉的声明」还回 VALID。
//
// 判据必须是**服务器那一份**（server/http/routeMount.js coreRouteShadow），不是第二张表：
// 校验器比服务器严 = 把合法的包判死；比服务器松 = 给一条永远不回答的路由发绿牌。两边都测。
// Run: node --test test/workshopValidateRoutes.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreRouteShadow, coreMounts } from '../server/http/routeMount.js';
import { serveDirs } from '../server/http/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一个只声明 `routes` 的合法包（形状层要求 file 是包内相对 `.json`）。 */
function packWith(root, id, paths) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ from: id }));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', author: 'test', license: 'CC0-1.0', description: 'routes 判据对照包',
    routes: paths.map((p) => ({ path: p, file: 'data.json' })),
  }));
  return dir;
}

function validate(workshopDir) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'workshop-validate.mjs'), workshopDir, '--json'],
    { encoding: 'utf8', timeout: 180_000 });
  const report = JSON.parse(r.stdout);
  const codes = (id) => {
    const p = report.packs.find((x) => x.pack === id);
    return (p?.issues || []).map((i) => `${i.severity}:${i.code}`);
  };
  return { status: r.status, report, codes, stdout: r.stdout, stderr: r.stderr };
}

describe('routes 声明与核心先吃：校验器与服务器同判据（DESIGN §28.35）', () => {
  let tmp;
  test('撞上核心真在服务的文件 ⇒ error，整轮失败（服务器会丢掉这条声明）', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-vroute-'));
    // 引擎的 data/ 里真有一张 chess.json（`serveDirs({}).dataDir`），所以这条是**真冲突**
    packWith(tmp, 'clash-data', ['/data/chess.json']);
    packWith(tmp, 'clash-exact', ['/healthz']);
    const { status, codes } = validate(tmp);
    assert.equal(status, 1, `撞核心的声明不能还给 VALID：${JSON.stringify(codes('clash-data'))}`);
    assert.ok(codes('clash-data').includes('error:ROUTE_CLASHES_CORE'), codes('clash-data').join(','));
    assert.ok(codes('clash-exact').includes('error:ROUTE_CLASHES_CORE'), codes('clash-exact').join(','));
  });

  test('落在引擎命名空间里但核心今天没有那个文件 ⇒ 只 warning，不拦（与服务器逐字一致）', () => {
    const root = path.join(tmp, 'soft');
    fs.mkdirSync(root, { recursive: true });
    // docs/WORKSHOP.md §1.9 举的例子就是这一条：核心 data/ 下没有 resource-manifest.json
    packWith(root, 'soft-ns', ['/data/resource-manifest.json']);
    const { status, codes } = validate(root);
    assert.equal(status, 0, `这条今天能服务，校验器不许比服务器严：${JSON.stringify(codes('soft-ns'))}`);
    assert.deepEqual(codes('soft-ns'), ['warning:ROUTE_IN_ENGINE_NAMESPACE']);
  });

  test('谁都不占的路径 ⇒ 一条 issue 都不产生', () => {
    const root = path.join(tmp, 'clean');
    fs.mkdirSync(root, { recursive: true });
    packWith(root, 'clean-path', ['/duel/modes.json']);
    const { status, codes } = validate(root);
    assert.equal(status, 0);
    assert.deepEqual(codes('clean-path'), []);
  });

  test('判据只此一处：校验器不养第二份保留名单（源码级断言）', () => {
    // 2026-10-13：判据本体从 tools/workshop-validate.mjs 搬到了 shared/workshopValidate.mjs
    // （CLI 是维护者工具、不随玩家包发出，而编辑器界面的「校验这个包」必须用同一份判据）。
    // 这条断言跟到判据**现在所在**的那个文件上 —— 它钉的是「不另抄一张保留前缀表」，不是某个文件名。
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'workshopValidate.mjs'), 'utf8');
    assert.match(src, /from '\.\.\/server\/http\/routeMount\.js'/, '必须 import 服务器那一份 coreRouteShadow');
    assert.doesNotMatch(src, /const RESERVED[A-Z_]* = \[/, '不许在校验器里另抄一张保留前缀表');
  });

  test('校验器的三档判词与服务器同一张 mount 表逐条一致（反向对照：改坏目录就不再算冲突）', () => {
    const dirs = serveDirs({});
    const mounts = coreMounts({ ...dirs, simDir: path.join(ROOT, 'server', 'sim') });
    assert.equal(coreRouteShadow('/data/chess.json', { mount: mounts }).kind, 'file', '核心真有这个文件');
    assert.equal(coreRouteShadow('/data/resource-manifest.json', { mount: mounts }).kind, 'reserved', '命名空间里、但今天没有同名文件');
    assert.equal(coreRouteShadow('/duel/modes.json', { mount: mounts }), null, '与核心无关');
    // 同一份声明喂给校验器，三档必须分别落在 error / warning / 无 —— 两边不许漂
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-vroute-agree-'));
    packWith(root, 'a', ['/data/chess.json', '/data/resource-manifest.json', '/duel/modes.json']);
    const { codes } = validate(root);
    assert.deepEqual(codes('a').sort(), ['error:ROUTE_CLASHES_CORE', 'warning:ROUTE_IN_ENGINE_NAMESPACE'].sort(), codes('a').join(','));
  });
});
