// 编辑器的「一键试玩」（docs/EDITOR.md §试玩，editor/playtest.mjs）：由编辑器起一个游戏服务器**子进程**。
//
// 这个套件真的会起服务器进程（约 1–2 s 一次），因为这里要钉住的恰恰是进程边界上的行为，而它们都无法用假对象证明：
//   * 子进程拿到的是**编辑器当前的工坊根**（`SP_WORKSHOP`）—— 不传的话试玩里看不到作者正在编辑的包，
//     而这正是这个功能存在的理由；
//   * 停掉 / 关掉编辑器之后进程真的走了 —— 留一个占端口的孤儿 node.exe，下次试玩会以「端口被占用」失败；
//   * 起不来时必须回滚（杀进程 + 抛错），绝不返回一个「看起来在跑」的实例。
// `stdio: 'ignore'` 是给测试用的：正常运行时游戏服务器的日志会直接出现在编辑器终端里。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { freePort, playtestUrl, createPlaytest, PLAYTEST_HOST } from '../editor/playtest.mjs';
import { createEditorServer } from '../editor/server.mjs';
import { APP_VERSION } from '../shared/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const WS_ID = 'chess_char_ws_play_01_a';

/** 端口上有没有人在听（判断子进程是否真的走了，比看 PID 可靠）。 */
function listening(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: PLAYTEST_HOST, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(600, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

let tmp;
let ws;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-playtest-'));
  ws = join(tmp, 'workshop');
  // 一个真实的包：试玩服务器能读到它，就证明 SP_WORKSHOP 真的传到了子进程
  const dir = join(ws, 'play-pack');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    id: 'play-pack', name: '试玩包', version: '1.0.0', content: ['chess'],
  }));
  fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({
    [WS_ID]: { chessId: WS_ID, name: '试玩干员', tier: 5, visible: true },
  }));
  editor = await createEditorServer({
    workshopRoot: ws, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), log: quiet,
    // 真实控制器，只是不要子进程刷屏
  });
});
after(async () => {
  await editor?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('playtest: 端口与 URL（纯函数）', () => {
  test('freePort 给一个真的能绑的本机端口', async () => {
    const port = await freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
    await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, PLAYTEST_HOST, () => s.close(resolve));
    });
  });

  test('URL 带客户端深链参数，难度不认识就不带', () => {
    assert.equal(playtestUrl(3000), 'http://127.0.0.1:3000/?playtest=1');
    assert.equal(playtestUrl(3000, 'HARD'), 'http://127.0.0.1:3000/?playtest=1&difficulty=HARD');
    assert.equal(playtestUrl(3000, null), 'http://127.0.0.1:3000/?playtest=1');
    assert.equal(playtestUrl(3000, ''), 'http://127.0.0.1:3000/?playtest=1');
  });
});

describe('playtest: 编辑器路由与子进程', () => {
  test('POST /api/playtest/start 起一个真的游戏服务器，而且它读的是编辑器的工坊根', async () => {
    const before = await fetch(`${editor.url}/api/playtest`).then((r) => r.json());
    assert.equal(before.running, false);
    assert.deepEqual(before.difficulties, ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'], '难度键来自 shared/constants.js');
    assert.equal(before.workshopRoot, ws);

    const res = await fetch(`${editor.url}/api/playtest/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ difficulty: 'HARD' }),
    });
    assert.equal(res.status, 200);
    const started = await res.json();
    assert.equal(started.ok, true);
    assert.equal(started.reused, false);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/\?playtest=1&difficulty=HARD$/);

    // /healthz：服务器真的在跑，而且是这一个仓库的版本
    const health = await fetch(`http://${PLAYTEST_HOST}:${started.port}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.app, APP_VERSION);

    // 关键一条：子进程读到的 chess.json 里有**这个工坊根**里的干员 —— SP_WORKSHOP 起了作用
    const chess = await fetch(`http://${PLAYTEST_HOST}:${started.port}/data/chess.json`).then((r) => r.json());
    assert.ok(chess[WS_ID], `试玩服务器必须能看到 ${ws} 里的包（否则这个功能没有意义）`);

    const status = await fetch(`${editor.url}/api/playtest`).then((r) => r.json());
    assert.equal(status.running, true);
    assert.equal(status.port, started.port);
  });

  test('再点一次不会起第二个进程，而是复用（reused）', async () => {
    const a = await fetch(`${editor.url}/api/playtest/start`, { method: 'POST' }).then((r) => r.json());
    const b = await fetch(`${editor.url}/api/playtest/start`, { method: 'POST' }).then((r) => r.json());
    assert.equal(b.reused, true);
    assert.equal(b.port, a.port);
    assert.equal(b.pid, a.pid);
  });

  test('难度不合法直接 400，不起进程', async () => {
    const res = await fetch(`${editor.url}/api/playtest/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ difficulty: 'NIGHTMARE' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /难度不合法/);
  });

  test('POST /api/playtest/stop 之后端口真的没人听了（不是只改了个标志位）', async () => {
    const running = await fetch(`${editor.url}/api/playtest`).then((r) => r.json());
    assert.equal(running.running, true);
    const port = running.port;

    const stopped = await fetch(`${editor.url}/api/playtest/stop`, { method: 'POST' }).then((r) => r.json());
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.running, false);

    // 进程退出与端口释放之间有极短的延迟：给它一点时间，但必须有界
    let free = false;
    for (let i = 0; i < 20 && !free; i++) {
      free = !(await listening(port));
      if (!free) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(free, true, `停止后端口 ${port} 仍有人在听 —— 子进程没被杀掉`);

    // 再停一次是 no-op（幂等），不是错误
    const again = await fetch(`${editor.url}/api/playtest/stop`, { method: 'POST' }).then((r) => r.json());
    assert.equal(again.stopped, false);
  });

  test('关掉编辑器会带走试玩进程', async () => {
    const started = await fetch(`${editor.url}/api/playtest/start`, { method: 'POST' }).then((r) => r.json());
    assert.equal(started.reused, false);
    await editor.close();
    let free = false;
    for (let i = 0; i < 20 && !free; i++) {
      free = !(await listening(started.port));
      if (!free) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(free, true, '编辑器关闭后试玩服务器必须一起走（否则留下占端口的孤儿进程）');
  });
});

describe('playtest: 失败要回滚', () => {
  test('入口不存在时抛错，且不留下进程', async () => {
    const fake = createPlaytest({ root: ROOT, repoRoot: join(ROOT, 'no-such-repo'), log: quiet, stdio: 'ignore' });
    await assert.rejects(() => fake.start(), /找不到游戏服务器入口/);
    assert.equal(fake.status().running, false);
  });

  test('端口被占用时不会假装成功', async () => {
    // 自己先占住一个端口，再让试玩用同一个端口起 —— 子进程会以 EADDRINUSE 退出，start() 必须抛错并收尸
    const port = await freePort();
    const blocker = net.createServer();
    // 占位服务器必须记下连接并主动销毁：健康检查会连上它、然后被超时打断，而 `server.close()` 要等所有连接结束 ——
    // 不销毁这些 socket，关闭这一步永远不回调（这个测试第一次写就这么卡死过，而且卡在 await 上不会报错）。
    const sockets = new Set();
    blocker.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, PLAYTEST_HOST, resolve);
    });
    try {
      const fake = createPlaytest({ root: ws, repoRoot: ROOT, log: quiet, stdio: 'ignore' });
      await assert.rejects(() => fake.start({ port }), /退出|未就绪/);
      assert.equal(fake.status().running, false, '失败后不能留下一个「在跑」的实例');
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => blocker.close(() => resolve()));
    }
  });
});
