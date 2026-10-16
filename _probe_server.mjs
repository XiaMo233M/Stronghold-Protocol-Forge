// 临时探针：真的把 startServer 起起来，打几条请求，核新写进去的插件流水线真的通了。
// 只绑回环、端口 0、跑完 close()。不是交付物。
import { startServer } from './server/index.js';

const s = await startServer({
  port: 0,
  host: '127.0.0.1',
  quiet: true,
  log: { info() {}, warn() {}, error(...a) { console.log('[log.error]', ...a.map(String)); } },
});
console.log('booted at', s.url);
console.log('returned keys:', Object.keys(s).filter((k) => ['content', 'visual', 'contents', 'hosts', 'studio', 'packs'].includes(k)).join(', '));
console.log('content.cs =', s.content && s.content.cs ? s.content.cs.slice(0, 16) : String(s.content));
console.log('studio =', s.studio ? 'created' : 'null');
console.log('hosts =', s.hosts ? 'created' : 'null');

const base = `http://127.0.0.1:${s.port}`;
const urls = [
  '/plugins/index.json',
  '/packs/index.json',
  '/healthz',
  '/ws',
  '/data.js',
];
for (const u of urls) {
  try {
    const res = await fetch(base + u);
    const body = await res.text();
    console.log(`${String(res.status).padEnd(4)} ${u.padEnd(22)} ct=${(res.headers.get('content-type') || '-').padEnd(32)} len=${body.length} head=${JSON.stringify(body.slice(0, 60))}`);
  } catch (e) {
    console.log(`ERR  ${u} -> ${e.message}`);
  }
}
await s.close();
console.log('closed cleanly');
