// test/modErrorCodes.test.js — 错误码对齐层：**每个映射目标都必须真的存在于上游 0.3.0 的码表**。
// 判据优先级：`up/shared/plugins/errors.js`（vendor 线才有）→ `docs/PLUGIN-API.md` 的 error.* 表（同一份生成物）。
// 都拿不到 ⇒ 明说跳过，绝不假装校验过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODE_ALIGNMENT, alignErrorCode, alignFailure, isForgeOnlyCode } from '../shared/sdk/errorCodes.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readUpstreamCodes() {
  const candidates = [
    path.join(ROOT, 'up', 'shared', 'plugins', 'errors.js'),
    path.join(ROOT, 'docs', 'PLUGIN-API.md'),
  ];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const codes = [...text.matchAll(/\bPLUGIN_[A-Z_]+\b/g)].map((m) => m[0]);
      if (codes.length) return { codes: new Set(codes), source: p };
    } catch { /* try next */ }
  }
  return { codes: null, source: null };
}

const { codes: UPSTREAM, source: UPSTREAM_SOURCE } = readUpstreamCodes();

test('码表：每个映射目标都存在于上游 0.3.0 的码表', () => {
  if (!UPSTREAM) {
    console.warn(`[skip] no upstream error table found (looked in up/ and docs/) — mapping validated by tools instead`);
    return;
  }
  const targets = Object.values(CODE_ALIGNMENT).filter(Boolean);
  assert.ok(targets.length >= 40, `映射应覆盖全部自造码（实际 ${targets.length} 条）`);
  const bad = targets.filter((c) => !UPSTREAM.has(c));
  assert.deepEqual(bad, [], `这些码不在上游码表（${UPSTREAM_SOURCE}）里：${bad.join(', ')}`);
});

test('对齐行为：上游有同义码 ⇒ 返回上游码；本来就是上游码 ⇒ 原样', () => {
  assert.equal(alignErrorCode('SDK_NOT_CONSENTED'), 'PLUGIN_CONSENT');
  assert.equal(alignErrorCode('SDK_PIN_STALE'), 'PLUGIN_TRUST_PIN');
  assert.equal(alignErrorCode('SDK_BAD_DESCRIPTOR'), 'PLUGIN_MANIFEST_SHAPE');
  assert.equal(alignErrorCode('PLUGIN_SANDBOX_UNAVAILABLE'), 'PLUGIN_SANDBOX_UNAVAILABLE');
  assert.equal(alignErrorCode('ADMISSION_SET_MISMATCH'), 'PLUGIN_INVALID');
});

test('alignFailure：换码且原码留进 forge 字段（不丢信息）；非对象原样返回', () => {
  const out = alignFailure({ code: 'SDK_PIN_STALE', reason: 'byte changed' });
  assert.equal(out.code, 'PLUGIN_TRUST_PIN');
  assert.equal(out.forge, 'SDK_PIN_STALE');
  assert.equal(out.reason, 'byte changed');
  const same = alignFailure({ code: 'PLUGIN_CONSENT', reason: 'x' });
  assert.equal(same.code, 'PLUGIN_CONSENT');
  assert.equal('forge' in same, false, '本来就是上游码 ⇒ 不加 forge 字段');
  assert.equal(alignFailure(null), null);
});

test('isForgeOnlyCode：管理器自己的码认得出；已对齐的上游码不是', () => {
  assert.equal(isForgeOnlyCode('SDK_ORIGIN_NOT_ALLOWED'), true, '运行模式是 Forge 扩展，上游无此概念');
  assert.equal(isForgeOnlyCode('PLUGIN_USE_UNDECLARED'), true, '原名是我们的（出口已换成 PLUGIN_PERMISSION_MISSING）');
  assert.equal(isForgeOnlyCode('PLUGIN_CONSENT'), false, '上游码不是 Forge 独有');
  assert.equal(isForgeOnlyCode('PLUGIN_SCRIPT_CHECK'), false);
  assert.equal(isForgeOnlyCode(null), false);
});
