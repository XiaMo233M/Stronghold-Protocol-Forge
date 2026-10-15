// test/modSandbox.test.js — 官方 sandbox 档：真起子进程，验隔离、看门狗、预算、重启。
// 需要 `node --test`（会 fork 真实子进程）。不依赖任何第三方包。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createSandboxRunner, SandboxError } from '../server/mod-manager/sandbox.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const T = 8000; // 单条用例的上限（fork + 握手 + 调用）

function makePlugin(body, { id = 'demo', extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `sp-sandbox-${id}-`));
  fs.writeFileSync(path.join(dir, 'plugin.mjs'), body);
  return { dir, id, ...extra };
}

const run = (p, opts = {}) => createSandboxRunner({ pluginId: p.id, entry: 'plugin.mjs', dir: p.dir, log: quiet, timeoutMs: T, ...opts });

test('真子进程：health + request/response 往返，shutdown 干净退出', async () => {
  const p = makePlugin(`export function registerPlugin(host) {
    host.health.add({ alive: true });
    host.routes.add({ path: '/mod/demo/echo', handler: (body) => ({ status: 200, body: { echo: body.who } }) });
  }`);
  try {
    const r = await run(p, { stateRoot: path.join(p.dir, 'var') });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const { runner } = r;
    assert.deepEqual(runner.routes, ['/mod/demo/echo']);
    assert.equal(runner.state.status, 'ready');

    const h = await runner.health();
    assert.deepEqual(h.fields, { alive: true });

    const resp = await runner.request('/mod/demo/echo', { who: 'world' });
    assert.deepEqual(resp, { ok: true, status: 200, body: { echo: 'world' } });

    const miss = await runner.request('/mod/demo/nope', {});
    assert.equal(miss.ok, false);
    assert.equal(miss.status, 404);

    await runner.shutdown();
    assert.equal(runner.state.status, 'closed');
  } finally { fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('看门狗：死循环的 handler 被超时杀掉，宿主不受影响，随后可重启', async () => {
  const p = makePlugin(`export function registerPlugin(host) {
    host.routes.add({ path: '/mod/demo/hang', handler: () => { const t = Date.now() + 60000; while (Date.now() < t) { /* 堵死这一进程 */ } return 1; } });
    host.routes.add({ path: '/mod/demo/ok', handler: () => ({ body: 'fine' }) });
  }`);
  try {
    // 单次调用 1.5s 超时（对付那个 60s 死循环），但**起进程**给足 8s —— CI 上 fork+import 比本机慢得多
    const r = await run(p, { timeoutMs: 1500, readyTimeoutMs: T, stateRoot: path.join(p.dir, 'var') });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const { runner } = r;
    // 宿主进程显然还活着（我们正跑在这一行）；现在让那个死循环的调用超时
    await assert.rejects(() => runner.request('/mod/demo/hang', {}), (e) => e instanceof SandboxError && e.code === 'SANDBOX_TIMEOUT');
    assert.ok(['timeout', 'crashed', 'starting'].includes(runner.state.status), `status=${runner.state.status}`);
    assert.equal(runner.state.timeouts, 1);
    // 重启之后同一个入口又能用了（字节没变 ⇒ 代码没变）
    const again = await runner.restart();
    assert.equal(again.ok, true, JSON.stringify(again));
    const ok = await runner.request('/mod/demo/ok', {});
    assert.deepEqual(ok.body, 'fine');
    await runner.shutdown();
  } finally { fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('严格档扫描在 fork **之前**：globalThis / process 的插件连子进程都不起', async () => {
  const g = makePlugin(`export function registerPlugin(host) { globalThis.__x = 1; }`, { id: 'g' });
  const p = makePlugin(`export function registerPlugin(host) { host.routes.add({ path: '/mod/p/x', handler: () => process.pid }); }`, { id: 'p' });
  try {
    const a = await run(g);
    assert.equal(a.ok, false);
    assert.equal(a.errors[0].code, 'PLUGIN_BAD_SOURCE');
    assert.match(a.errors[0].reason, /globalThis/);
    const b = await run(p);
    assert.equal(b.ok, false);
    assert.equal(b.errors[0].code, 'PLUGIN_BAD_SOURCE');
    assert.match(b.errors[0].reason, /process/);
  } finally { fs.rmSync(g.dir, { recursive: true, force: true }); fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('入口越界 / 不存在 / registerPlugin 抛异常 ⇒ 具名拒，宿主不被拖死', async () => {
  const p = makePlugin(`export function registerPlugin(host) { throw new Error('boom'); }`, { id: 'boom' });
  try {
    const escaped = await createSandboxRunner({ pluginId: 'e', entry: '../outside.mjs', dir: p.dir, log: quiet });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.errors[0].code, 'PLUGIN_BAD_ENTRY');

    const missing = await createSandboxRunner({ pluginId: 'm', entry: 'nope.mjs', dir: p.dir, log: quiet });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors[0].code, 'PLUGIN_BAD_ENTRY');

    const r = await run(p, { timeoutMs: 1500, readyTimeoutMs: T });
    assert.equal(r.ok, false, 'registerPlugin 抛异常 ⇒ 起不来');
    assert.equal(r.errors[0].code, 'SANDBOX_START_FAILED');
  } finally { fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('预算：用完就不再放行（与另外两档同一份记账）', async () => {
  const p = makePlugin(`export function registerPlugin(host) {
    host.routes.add({ path: '/mod/demo/x', handler: () => ({ body: 1 }) });
  }`);
  try {
    const r = await run(p, { budget: { maxCalls: 1 } });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const first = await r.runner.request('/mod/demo/x', {});
    assert.equal(first.ok, true);
    await assert.rejects(() => r.runner.request('/mod/demo/x', {}), (e) => e instanceof SandboxError && e.code === 'SDK_BUDGET_EXCEEDED');
    assert.equal(r.runner.state.budget.calls, 1);
    await r.runner.shutdown();
  } finally { fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('storage 限本插件目录（子进程内解析，越界即抛）', async () => {
  const p = makePlugin(`export function registerPlugin(host) {
    host.routes.add({ path: '/mod/demo/w', handler: () => { host.storage.write('a/b.txt', 'hi'); return { body: host.storage.read('a/b.txt') }; } });
    host.routes.add({ path: '/mod/demo/esc', handler: () => host.storage.read('../escape.txt') });
  }`);
  try {
    const stateRoot = path.join(p.dir, 'var');
    const r = await run(p, { stateRoot });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const w = await r.runner.request('/mod/demo/w', {});
    assert.equal(w.body, 'hi');
    assert.equal(fs.readFileSync(path.join(stateRoot, 'official', 'demo', 'a', 'b.txt'), 'utf8'), 'hi');
    const esc = await r.runner.request('/mod/demo/esc', {});
    assert.equal(esc.ok, false);
    assert.equal(esc.status, 500);
    assert.match(String(esc.error), /relative path/);
    await r.runner.shutdown();
  } finally { fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
