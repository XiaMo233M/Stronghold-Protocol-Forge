// test/match/runnerLoadSimContract.test.js — `createBattleRunner` 的 **`deps.loadSim` 两个契约**（D26）。
//
// 为什么需要这条判据：本树同时留着两条「在哪份数据上模拟」的来源 ——
//   · 我们的数据面（W-D, DESIGN §28.16：`dataBaseFor` → `/data/` 或 `/room-data/<摘要>/`），和
//   · 上游 0.3.0 的内容集（DESIGN §34.6：`contentFor` / `simContent` / `vanillaCs`）。
// 两边的调用方对 `deps.loadSim` 的**第一个参数**要求不同，不可能共用一个参数位：
//   · `test/match/runnerDataBase.test.js`（我们的 W-D）要 `loadSim(dataBase)`；
//   · `test/ui/plugins-content.test.js`（上游）要 `loadSim(content?)`（它的 loader 是
//     `async (content) => loads.push(content ? content.cs : null)`，传 `base` 进去只会得到 `undefined`）。
// 所以 `ensureSim` 按「**这个调用方要不要数据面**」分开：注入了 `deps.dataBaseFor` ⇒ `(dataBase, content?)`；
// 没注入 ⇒ 上游的 `(content?)`。**这条文件把那两种形状钉住** —— 把 `ensureSim` 里的 `perFace` 判据反过来、
// 或把任一条路的参数顺序改掉，下面 4 条就会红，不会静默错行为（把 `base` 当 `content` 传进去是最坏的一种）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBattleRunner } from '../../public/js/battle/runner.js';

const CS = 'cd'.repeat(32);
const VANILLA = 'ee'.repeat(32);
const FACE = '/room-data/abababab/';

/** A runner whose `loadSim` records its call arguments (it never builds a battle: only `ensureSim` is exercised). */
function rig({ dataBaseFor = null, held = null } = {}) {
  const calls = [];
  const deps = {
    net: { on: () => () => {}, send: () => true, request: () => Promise.resolve({ t: 'ok' }) },
    store: { get: () => ({}), patch() {}, subscribe: () => () => {} },
    doc: null,
    now: () => 1000,
    raf: () => 1, caf: () => {}, setInterval: () => 1, clearInterval: () => {},
    vanillaCs: () => VANILLA,
    contentFor: async (cs) => (held && held.cs === cs ? held : null),
    simContent: () => held,
    loadingContent: () => null,
    loadSim: (...args) => { calls.push(args); return Promise.resolve({ spec: null, ds: null }); },
  };
  if (dataBaseFor) deps.dataBaseFor = dataBaseFor;
  return { runner: createBattleRunner(deps), calls };
}

test('没有 dataBaseFor ⇒ 上游契约 loadSim(content?)：干净面上收到一个 null、只传一个参数', async () => {
  const r = rig();
  await r.runner.ensureSim({});
  assert.equal(r.calls.length, 1, '加载一次');
  assert.equal(r.calls[0].length, 1, '上游契约只有第一个参数位');
  assert.equal(r.calls[0][0], null, '没有内容集 ⇒ null（不是数据面字符串）');
  r.runner.dispose();
});

test('没有 dataBaseFor + 内容集 ⇒ 上游契约 loadSim(content)：第一个参数就是那份已校验的内容集', async () => {
  const r = rig({ held: { cs: CS, data: { chess: {} } } });
  await r.runner.ensureSim({ cs: CS });
  assert.equal(r.calls.length, 1, '加载一次');
  assert.equal(r.calls[0].length, 1, '上游契约只有第一个参数位');
  assert.equal(r.calls[0][0] && r.calls[0][0].cs, CS, '第一个参数是内容集，不是 /data/');
  r.runner.dispose();
});

test('注入了 dataBaseFor ⇒ 我们的数据面契约 loadSim(dataBase, content?)：干净面上收到 (面, null)', async () => {
  const r = rig({ dataBaseFor: () => FACE });
  await r.runner.ensureSim({});
  assert.equal(r.calls.length, 1, '加载一次');
  assert.deepEqual(r.calls[0], [FACE, null], '第一个参数是数据面，第二个是 null');
  r.runner.dispose();
});

test('注入了 dataBaseFor + 内容集 ⇒ loadSim(dataBase, content)：两个参数都在，面在第一个位', async () => {
  const r = rig({ dataBaseFor: () => FACE, held: { cs: CS, data: {} } });
  await r.runner.ensureSim({ cs: CS });
  assert.equal(r.calls.length, 1, '加载一次');
  assert.equal(r.calls[0].length, 2, '数据面契约有两个参数位');
  assert.equal(r.calls[0][0], FACE, '第一个参数是数据面');
  assert.equal(r.calls[0][1] && r.calls[0][1].cs, CS, '第二个参数是内容集');
  r.runner.dispose();
});

test('同一个面只加载一次（缓存按内容集 / 数据面分开）', async () => {
  const r = rig({ dataBaseFor: () => FACE });
  await r.runner.ensureSim({});
  await r.runner.ensureSim({});
  assert.equal(r.calls.length, 1, '同一数据面命中缓存');
  const c = rig({ held: { cs: CS, data: {} } });
  await c.runner.ensureSim({ cs: CS });
  await c.runner.ensureSim({ cs: CS });
  assert.equal(c.calls.length, 1, '同一内容集命中缓存');
  r.runner.dispose();
  c.runner.dispose();
});
