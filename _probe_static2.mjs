// 探针 2：证明那几条 404 是新分支自己给的（不是穿到底层的通用 404），并且老路由没有回归。
import http from 'node:http';
import path from 'node:path';
import { createStaticHandler } from './server/http/static.js';
import { computeVanillaContent } from './server/plugins/identity.js';
import { csUrlPart } from './shared/plugins/identity.js';
import { DATA_SHIM_JS } from './server/http/static.js';

const ROOT = process.cwd();
const dirs = { publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), sharedDir: path.join(ROOT, 'shared'), simDir: path.join(ROOT, 'server', 'sim') };
const handler = createStaticHandler({ ...dirs, log: { info() {}, warn() {}, error() {} } });

// 用与处理器内部同一个算式算出原生 cs，好构造一条「应该 200」的 /cs/ URL
const c = computeVanillaContent({ ...dirs, shim: DATA_SHIM_JS, log: { info() {}, warn() {}, error() {} } });
const cs16 = csUrlPart(c.cs);
console.log('vanilla cs =', c.cs, '-> cs16 =', cs16);

const server = http.createServer((req, res) => {
  const q = req.url.indexOf('?');
  handler(req, res, q === -1 ? req.url : req.url.slice(0, q), q === -1 ? '' : req.url.slice(q + 1))
    .catch((e) => { res.writeHead(500); res.end(String(e)); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const urls = [
  `/cs/${cs16}/index.json`,                       // 原生内容集清单：应 200 且是不可变缓存
  `/cs/${cs16}/data/nope.json`,                   // 该集合没改过的文件：应 404
  '/cs/tooshort/index.json',                      // 形状不对：应 404
  '/plugins/index.json',                          // 目录：200
  '/p/',                                          // 前缀命中但形状不对：应 404
  '/vs/',                                         // 前缀命中但形状不对：应 404
  '/packs/index.json',                            // 老路由：200
  '/data/local-assets.json',                      // 老路由（缺文件时空清单）：200
  '/room-data/deadbeef.json',                     // 老路由（roomData 未提供）：应 404
  '/workshop-assets/nope/x.png',                  // 老工坊路由：应 404
];
for (const u of urls) {
  const res = await fetch(`http://127.0.0.1:${port}${u}`);
  const body = await res.text();
  console.log(`${String(res.status).padEnd(4)} cc=${(res.headers.get('cache-control') || '-').padEnd(34)} ${u.padEnd(36)} len=${body.length}`);
}
await new Promise((r) => server.close(r));
