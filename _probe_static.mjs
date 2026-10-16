// 临时探针：真的起一个静态处理器，打几条请求，看路由是否按预期作答。
// 不是交付物，只是这次改动的运行时证据。
import http from 'node:http';
import path from 'node:path';
import { createStaticHandler } from './server/http/static.js';

const ROOT = process.cwd();
const handler = createStaticHandler({
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  sharedDir: path.join(ROOT, 'shared'),
  log: { info() {}, warn() {}, error() {} },
});

const server = http.createServer((req, res) => {
  const q = req.url.indexOf('?');
  const rawPath = q === -1 ? req.url : req.url.slice(0, q);
  const query = q === -1 ? '' : req.url.slice(q + 1);
  handler(req, res, rawPath, query).catch((e) => { res.writeHead(500); res.end(String(e)); });
});

const urls = [
  '/plugins/index.json',
  '/packs/index.json',
  '/data.js',
  '/cs/deadbeefdeadbeef/index.json',
  '/vs/deadbeefdeadbeef/overlay.json',
  '/p/nope/00000000/index.js',
  '/sim/simdata.js',
  '/nope-does-not-exist',
];

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
for (const u of urls) {
  const res = await fetch(`http://127.0.0.1:${port}${u}`);
  const body = await res.text();
  console.log(`${String(res.status).padEnd(4)} ${u.padEnd(34)} ct=${res.headers.get('content-type') || '-'} len=${body.length} head=${JSON.stringify(body.slice(0, 70))}`);
}
await new Promise((r) => server.close(r));
