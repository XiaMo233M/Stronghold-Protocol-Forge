// test/modxieServerE2E.test.mjs — 真服务器 + 真对局的端到端（第二轮审计「第四阶段」的服务端那一半）：
// `server/index.js` 起真进程（`SP_WORKSHOP` 指向装了包的临时工坊），WebSocket 客户端走 hello → 建房（点名房间集合）
// → 开局 → 发通道消息。断言的是**消费语义在真链路上成立**：
//   * 房间还在 LOBBY（没有对局）时，mod-xie 的通道消息**照旧回显**（今天的转发口径）；
//   * 对局起来之后，同一条消息**不再回显**（真 Match 里的 `handlePackMsg` 返回 true = 消费）；
//   * 对照组 `probe` 包（声明了通道、但它的 matchClass 层**没有** handlePackMsg）在同一个房间里照旧回显 ——
//     所以「不回显」不是「有对局就不转发」，而是那一个包自己的选择。
//
// 不点浏览器：这一条证明的是服务端装配（装载 → 房间集合 → 真 Match → 包装器 → 投递 → 消费），
// 客户端面板的渲染仍属 PENDING。跑法（在管理器树根）：`node --test test/modxieServerE2E.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, deadlineMs = 30_000) {
  const end = Date.now() + deadlineMs;
  let lastErr = null;
  while (Date.now() < end) {
    try { return await fetch(url); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`server never answered ${url}: ${lastErr?.message ?? 'timeout'}`);
}

/** 一个最小的 WS 客户端：收集帧 + 按条件等待。 */
function connect(url) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    frames.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  return {
    ws,
    frames,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e?.message ?? e?.type ?? 'unknown'}`)));
    }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    wait(pred, what, ms = 10_000) {
      const hit = frames.find((m) => pred(m));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === resolve);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${what}; frames: ${frames.map((f) => f.t).join(', ')}`));
        }, ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    /** 等一小会儿确认「某类帧**没有**出现」（消费断言用）。 */
    async settle(ms = 600) { await new Promise((r) => setTimeout(r, ms)); },
  };
}

test('真服务 + 真对局：包的通道消息在对局里被消费（对照组照旧回显）', { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modxie-e2e-'));
  let child = null;
  let client = null;
  try {
    // 临时工坊：真包 + 对照组（声明通道但没有 handlePackMsg 的 matchClass 层）
    fs.cpSync(path.join(ROOT, 'mod-xie'), path.join(tmp, 'mod-xie'), { recursive: true });
    const probe = path.join(tmp, 'probe');
    fs.mkdirSync(path.join(probe, 'server'), { recursive: true });
    fs.mkdirSync(path.join(probe, 'client'), { recursive: true });
    fs.writeFileSync(path.join(probe, 'pack.json'), JSON.stringify({
      id: 'probe', name: 'Probe', version: '1.0.0', combat: true,
      server: { modules: [{ id: 'p', entry: 'server/p.mjs', uses: ['matchClass'] }] },
      client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'client/p.js', messages: ['ping'] }] },
    }, null, 2));
    fs.writeFileSync(path.join(probe, 'server', 'p.mjs'),
      'export function registerServer(host) {\n  host.matchClass((Base) => class extends Base {});\n}\n');
    fs.writeFileSync(path.join(probe, 'client', 'p.js'), 'export function mount() { return {}; }\n');

    const port = await freePort();
    const log = [];
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SP_WORKSHOP: tmp, SP_NO_BROWSER: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { log.push(String(d)); });
    child.stderr.on('data', (d) => { log.push(String(d)); });

    const health = await waitForHttp(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200, `healthz（server log: ${log.join('')}）`);
    const healthBody = await health.json();
    assert.ok(healthBody.mods, '进程身份清单在 /healthz 上（装了包）');

    // 面板模块真的被服务（客户端半边的那条路）
    const panel = await fetch(`http://127.0.0.1:${port}/workshop-panels/mod-xie/client/econ.js`);
    assert.equal(panel.status, 200, '包的面板模块按注册 URL 服务');
    assert.match(panel.headers.get('content-type') ?? '', /javascript/);

    // —— WS：hello → 建房（两个包都点名）→ LOBBY 里先发一条（应回显）→ 开局 → 再发（mod-xie 不回显、probe 回显）
    client = connect(`ws://127.0.0.1:${port}/ws`);
    await client.ready;
    client.send({ t: 'hello', name: 'A', rid: 1 });
    const welcome = await client.wait((m) => m.t === 'welcome', 'welcome');
    assert.ok(welcome.mods && typeof welcome.mods.digest === 'string', 'welcome 带进程集合摘要');
    const digest = welcome.mods.digest;

    client.send({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', mods: digest, modIds: ['mod-xie', 'probe'], rid: 2 });
    const okCreate = await client.wait((m) => m.t === 'ok' && m.rid === 2 || (m.t === 'error' && m.rid === 2), 'room.create reply');
    assert.equal(okCreate.t, 'ok', `建房失败：${JSON.stringify(okCreate)}（server log: ${log.join('')}）`);
    const state = client.frames.filter((m) => m.t === 'room.state').pop();
    assert.ok(state && state.mods && Array.isArray(state.mods.packs), 'room.state 带本房间的集合');

    client.send({ t: 'pack.msg', pack: 'mod-xie', channel: 'borrow', data: { amount: 1 }, rid: 3 });
    await client.wait((m) => m.t === 'pack.msg' && m.pack === 'mod-xie', 'LOBBY 里的回显（没有对局 ⇒ 照旧转发）');

    client.send({ t: 'room.start', rid: 4 });
    const okStart = await client.wait((m) => (m.t === 'ok' && m.rid === 4) || (m.t === 'error' && m.rid === 4), 'room.start reply');
    assert.equal(okStart.t, 'ok', `开局失败：${JSON.stringify(okStart)}（server log: ${log.join('')}）`);
    await client.wait((m) => m.t === 'm.public', '真对局的第一帧 m.public');

    const before = client.frames.length;
    client.send({ t: 'pack.msg', pack: 'mod-xie', channel: 'borrow', data: { amount: 1 }, rid: 5 });
    await client.settle(700);
    const afterMod = client.frames.slice(before).filter((m) => m.t === 'pack.msg' && m.pack === 'mod-xie');
    assert.equal(afterMod.length, 0, `对局起来后 mod-xie 的命令被消费（不回显）；实际收到：${JSON.stringify(afterMod)}`);

    client.send({ t: 'pack.msg', pack: 'probe', channel: 'ping', data: { n: 1 }, rid: 6 });
    await client.wait((m) => m.t === 'pack.msg' && m.pack === 'probe', '对照包照旧回显（它的对局层没有 handlePackMsg）');
  } finally {
    try { client?.ws?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
