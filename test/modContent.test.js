// test/modContent.test.js — 官方档声明式内容合并（Phase 3）：并集 + **具名冲突**，绝不静默覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { mergeDeclarativeContent, collectOfficialContent } from '../server/mod-manager/content.js';

test('对象表：并集；同 id 由第二个来源再给一次 ⇒ 具名冲突、先到者胜', () => {
  const base = { items: { a: { v: 1 } } };
  const out = mergeDeclarativeContent(base, [
    { packId: 'p1', table: 'items', data: { b: { v: 2 } } },
    { packId: 'p2', table: 'items', data: { b: { v: 99 }, c: { v: 3 } } },
  ]);
  assert.deepEqual(Object.keys(out.tables.items).sort(), ['a', 'b', 'c']);
  assert.deepEqual(out.tables.items.b, { v: 2 }, '先到者胜');
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].code, 'CONTENT_DUPLICATE_ID');
  assert.equal(out.conflicts[0].key, 'b');
  assert.equal(out.conflicts[0].packId, 'p2');
  assert.deepEqual(out.applied.map((a) => a.packId), ['p1', 'p2']);
  // 输入没有被就地改写
  assert.deepEqual(base, { items: { a: { v: 1 } } });
});

test('overrides 白名单允许被后来的来源替换（明说才生效）', () => {
  const out = mergeDeclarativeContent({ items: { a: { v: 1 } } }, [
    { packId: 'p2', table: 'items', data: { a: { v: 2 } } },
  ], { overrides: new Set(['items:*']) });
  assert.deepEqual(out.tables.items.a, { v: 2 });
  assert.deepEqual(out.conflicts, []);
});

test('数组表：追加 + 按 id 去重；同 id ⇒ 冲突并跳过', () => {
  const out = mergeDeclarativeContent({ bonds: [{ id: 'x', v: 1 }] }, [
    { packId: 'p1', table: 'bonds', data: [{ id: 'y', v: 2 }, { id: 'x', v: 9 }, { v: 3 }] },
  ]);
  assert.deepEqual(out.tables.bonds, [{ id: 'x', v: 1 }, { id: 'y', v: 2 }, { v: 3 }]);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].key, 'x');
});

test('形状不认识 / 一边对象一边数组 / 标量 ⇒ 冲突，不猜', () => {
  const a = mergeDeclarativeContent({ t: {} }, [{ packId: 'p', table: 't', data: [1] }]);
  assert.equal(a.conflicts[0].code, 'CONTENT_SHAPE_MISMATCH');
  const b = mergeDeclarativeContent({ t: [] }, [{ packId: 'p', table: 't', data: { a: 1 } }]);
  assert.equal(b.conflicts[0].code, 'CONTENT_SHAPE_MISMATCH');
  const c = mergeDeclarativeContent({}, [{ packId: 'p', table: 't', data: 42 }]);
  assert.equal(c.conflicts[0].code, 'CONTENT_UNSUPPORTED_SHAPE');
  // 新表按数据形状建
  const d = mergeDeclarativeContent({}, [{ packId: 'p', table: 'fresh', data: { k: 1 } }]);
  assert.deepEqual(d.tables.fresh, { k: 1 });
  assert.deepEqual(d.conflicts, []);
});

test('collectOfficialContent：读得到就贡献，读不到/坏 JSON 都**具名**记错且不贡献', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sp-content-'));
  try {
    const p = path.join(dir, 'p1');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'items.json'), JSON.stringify({ a: 1 }));
    fs.writeFileSync(path.join(p, 'bad.json'), '{nope');

    const plugins = [
      { id: 'p1', dir: p, descriptor: { content: ['items'] } },
      { id: 'p2', dir: path.join(dir, 'nope'), descriptor: { content: ['items'] } },
      { id: 'p3', dir: p, descriptor: { content: ['bad'] } },
    ];
    const { contributions, errors } = collectOfficialContent(plugins);
    assert.deepEqual(contributions, [{ packId: 'p1', table: 'items', data: { a: 1 } }]);
    assert.deepEqual(errors.map((e) => [e.pack, e.code]).sort(), [['p2', 'CONTENT_FILE_MISSING'], ['p3', 'CONTENT_FILE_BAD_JSON']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
