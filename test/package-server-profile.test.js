import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectServerFiles, planServer } from '../tools/package-server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server file selection excludes game art payload, fonts, bundled packs and sample pack payloads', () => {
  const files = selectServerFiles(ROOT);
  assert.ok(files.includes('server/index.js'));
  assert.ok(files.includes('server/modRegistry.js'));
  assert.ok(files.includes('server/workshop.js'));
  assert.ok(files.includes('shared/workshop.js'));
  assert.ok(files.includes('shared/modSurface.js'));
  assert.ok(files.includes('public/index.html'));
  assert.ok(files.includes('public/js/ui/extensions.js'));
  assert.ok(files.includes('public/js/ui/modComponents.js'));
  assert.ok(files.includes('docs/DEPLOY-SERVER.md'));
  assert.ok(files.includes('data/assets.json'));
  assert.ok(!files.some((f) => f.startsWith('public/assets/')));
  assert.ok(!files.some((f) => f.startsWith('public/fonts/')));
  assert.ok(!files.some((f) => f.startsWith('packs/')));
  assert.ok(!files.some((f) => f.startsWith('docs/my-first-pack/')));
  assert.ok(!files.some((f) => f.startsWith('docs/examples/')));
  // 2026-10-14 业主口径：发布物 = **纯 mod 管理器**，比玩家包再窄一档。`editor/` 这些本来就不在
  // `RUNTIME_DIRS`（只有 server/ shared/ data/ public/ packs/）里 —— 但「本来不在」最容易在上游
  // 下一次改动后悄悄变成「在」，所以逐条钉死，不靠记忆也不靠注释。
  for (const drop of ['editor/', 'test/', '.github/', 'types/', 'handoff/', 'mod-xie/', '_validate/']) {
    assert.ok(!files.some((f) => f.startsWith(drop)), `server profile 不该含 ${drop}`);
  }
  // 客户端 UI 那两格是上游自己的文件，必须留着（剔除的是**我这线**的附加，不是官方界面）
  assert.ok(files.some((f) => f === 'public/js/ui/extensions.js'), '官方 UI 扩展模块仍在');
});

test('server profile validation reports a clean source selection in the tracked checkout', () => {
  const plan = planServer(ROOT, { allowDirty: true, scan: false });
  assert.deepEqual(plan.problems, []);
  assert.ok(plan.files.length > 300, 'runtime allowlist has more than a trivial subset');
});
