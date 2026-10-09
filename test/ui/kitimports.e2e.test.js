// 浏览器侧的真机验证：import map 真的把 @kit/ / @sim/ 解析到了模块上（DESIGN §28.12 / docs/WORKSHOP.md §4.5）。
//
//   SP_E2E=1 node --test test/ui/kitimports.e2e.test.js
//
// 这是缺口④里**唯一 Node 测不了**的那一半：import map 的解析规则由浏览器实现，Node 没有 import map，所以
// test/kitImports.test.js 只能验「map 与表一致」「每个 URL 在磁盘上有文件」——那两条都不是「浏览器真的解析成功」。
// 本文件用真 Chrome 打开 public/index.html（import map 就在它的 <head> 里），然后在**页面上下文**里
// import() 每一个白名单 specifier：成不成、导出对不对、白名单外是不是真的解析不到，一次问清楚。
// 依赖树不用手写：白名单与导出名下限都从 shared/kitImports.js / test/kitImports.test.js 读，浏览器与守卫看同一份表。
//
// 无 Chrome 时整组跳过（SP_E2E != 1 或缺 Chrome），所以在 CI/本机都不会变红。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, hasChrome } from '../e2e/client.mjs';
import { KIT_IMPORT_FILES, KIT_IMPORT_TARGETS } from '../../shared/kitImports.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 导出名下限：与 test/kitImports.test.js 的 KIT_IMPORT_EXPORTS 同源（那里是唯一真相，这里只读它）。 */
function expectedExports() {
  const src = fs.readFileSync(path.join(ROOT, 'test/kitImports.test.js'), 'utf8');
  const start = src.indexOf('const KIT_IMPORT_EXPORTS = {');
  assert.ok(start >= 0, 'test/kitImports.test.js 里必须有 KIT_IMPORT_EXPORTS（导出名下限表）');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  // 读的是本仓测试文件里的字面量表，不是外部输入
  return new Function(`return (${src.slice(open, end + 1)})`)();
}

describe('kit import：真 Chrome 里的 import map 解析', { skip: !ENABLED && 'set SP_E2E=1 (Chrome)' }, () => {
  let srv;
  let browser;
  let base;
  let page;
  let problems;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--no-first-run', '--mute-audio', '--force-device-scale-factor=1'],
    });
    const [first] = await browser.pages();
    page = first || await browser.newPage();
    problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  });

  after(async () => { await browser?.close().catch(() => {}); await srv?.close(); });

  test('index.html 在浏览器里真的认下了 import map（它必须在任何 module 脚本之前声明）', async () => {
    const r = await page.evaluate(() => {
      const el = document.querySelector('script[type="importmap"]');
      const before = !el || ![...document.querySelectorAll('script[type="module"]')].some((s) => el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_PRECEDING);
      return {
        supports: typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('importmap'),
        hasMap: !!el,
        before,
        count: document.querySelectorAll('script[type="importmap"]').length,
      };
    });
    assert.ok(r.supports, '这个 Chrome 不支持 import map（Safari 16.4+ / Chrome 89+ 才支持），无法验证浏览器侧');
    assert.ok(r.hasMap, 'index.html 里找不到 <script type="importmap">');
    assert.equal(r.count, 1, '一个文档只能有一个 import map');
    assert.ok(r.before, 'import map 必须在第一个 module 脚本之前声明，否则不生效');
  });

  test('每一个白名单 specifier 都能在浏览器里 import 成功，且导出名下限全部满足', async () => {
    const want = expectedExports();
    const specs = KIT_IMPORT_FILES.map((e) => e.specifier);
    const got = await page.evaluate(async (specs) => {
      const out = {};
      for (const s of specs) {
        try {
          const m = await import(s);
          out[s] = { keys: Object.keys(m).sort(), error: null };
        } catch (e) {
          out[s] = { keys: [], error: String(e && e.message ? e.message : e) };
        }
      }
      return out;
    }, specs);

    const broken = [];
    for (const { specifier, file } of KIT_IMPORT_FILES) {
      const r = got[specifier];
      if (!r || r.error) { broken.push(`${specifier} → 浏览器解析失败：${r ? r.error : '没有结果'}`); continue; }
      const missing = (want[file] || []).filter((n) => !r.keys.includes(n));
      if (missing.length) broken.push(`${specifier} → 少了这些导出：${missing.join('、')}`);
    }
    assert.deepEqual(broken, [], `浏览器侧 import 有问题：\n${broken.join('\n')}`);
  });

  test('白名单之外的 specifier 在浏览器里也解析不到（白名单不是只在服务端生效）', async () => {
    const r = await page.evaluate(async () => {
      try { await import('@kit/evil.js'); return { ok: true, error: null }; }
      catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    });
    assert.equal(r.ok, false, '@kit/evil.js 竟然被浏览器解析成功了：白名单被绕过');
    assert.match(r.error, /evil\.js|Failed to resolve|not.*resolve/i, `失败原因看着不像「解析不到」：${r.error}`);
  });

  test('这一页没有任何 console / 页面 / 请求错误（import map 没把别的东西弄坏）', async () => {
    const relevant = problems.filter((p) => !/ERR_ABORTED/.test(p) && !/fonts\.googleapis|fonts\.gstatic/.test(p));
    assert.deepEqual(relevant, []);
  });

  test('表里的每个文件都被上面这组 specifier 覆盖到了（没有漏测的文件）', () => {
    const covered = new Set(KIT_IMPORT_FILES.map((e) => e.file));
    assert.deepEqual([...KIT_IMPORT_TARGETS.values()].sort(), [...covered].sort(), 'KIT_IMPORT_TARGETS 与 KIT_IMPORT_FILES 不同步');
  });
});
