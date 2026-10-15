// test/modStrictGlobals.test.js — GAP-1：server.modules 的源码扫描**分档**。
//   * legacy（旧行为，逐字节不变）：`globalThis` 允许（仓库里已有合法 fixture 用它），`process` 等仍被拒；
//   * module / sandbox（官方档）：`globalThis` 也进禁止表。
import test from 'node:test';
import assert from 'node:assert/strict';

import { serverModuleSourceIssues, isStrictProfile, MODULE_FORBIDDEN_GLOBALS_STRICT } from '../server/modModules.js';

const SRC_GLOBALTHIS = 'export function registerServer(host) { globalThis.__probe = 1; }';
const SRC_PROCESS = 'export function registerServer(host) { return process.env.X; }';
const SRC_IN_TABLE = 'export function registerServer(host) { return eval("1"); }';

test('档位判据：只有 module / sandbox 是严格档', () => {
  assert.equal(isStrictProfile('module'), true);
  assert.equal(isStrictProfile('sandbox'), true);
  assert.equal(isStrictProfile('legacy'), false);
  assert.equal(isStrictProfile('host'), false);
  assert.equal(isStrictProfile(undefined), false);
});

test('严格档的禁止表包含 globalThis（旧表被剔除过一格）', () => {
  assert.ok(MODULE_FORBIDDEN_GLOBALS_STRICT.some(([n]) => n === 'globalThis'));
});

test('legacy：globalThis 放行，process / eval 仍拒（旧行为不变）', () => {
  assert.deepEqual(serverModuleSourceIssues(SRC_GLOBALTHIS, 'p', 'm'), []);
  assert.equal(serverModuleSourceIssues(SRC_PROCESS, 'p', 'm')[0].code, 'MODULES_BAD_SOURCE');
  assert.equal(serverModuleSourceIssues(SRC_IN_TABLE, 'p', 'm')[0].code, 'MODULES_BAD_SOURCE');
  // 缺省不传 profile == legacy
  assert.deepEqual(serverModuleSourceIssues(SRC_GLOBALTHIS, 'p', 'm', {}), []);
});

test('严格档（module）：globalThis 被拒，且理由里点名 profile', () => {
  const issues = serverModuleSourceIssues(SRC_GLOBALTHIS, 'p', 'm', { profile: 'module' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'MODULES_BAD_SOURCE');
  assert.match(issues[0].reason, /globalThis/);
  assert.match(issues[0].reason, /profile module/);
});

test('注释里的字样不算（stripComments 先行）', () => {
  const src = '// globalThis is mentioned here only in a comment\nexport function registerServer() {}';
  assert.deepEqual(serverModuleSourceIssues(src, 'p', 'm', { profile: 'module' }), []);
});
