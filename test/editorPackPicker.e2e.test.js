// test/editorPackPicker.e2e.test.js — 「新建工坊包」在真浏览器里是页面内的输入框，不是原生弹窗。
//
// 为什么值得一条浏览器测试：这条改动的全部价值就两点 —— **不弹 window.prompt**、以及**弹出来的东西能校验**。
// 两件事都不是「函数返回了什么」能证明的：`globalThis.prompt` 在页面上存不存在、点一下之后 DOM 里真的多出一个
// 输入框、错误真的显示在表单里而不是某个 alert 里 —— 只有把页面跑起来才算数。纯逻辑那一半（选项、校验规则、
// 取消回退）由 test/packPicker.test.js 用桩钉住，这里只跑「真页面 + 真 DOM」。
//
// 用的是仓库既有的 puppeteer-core 套路（test/editorVoicePage.e2e.test.js 同一套）：默认跳过，
// `EDITOR_E2E=1` 才起浏览器。浏览器路径取 `$CHROME_PATH`，否则找下面几个常见位置。
//
//   EDITOR_E2E=1 node --test test/editorPackPicker.e2e.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 一个 Chromium 就够了：Edge 与 Chrome 都是 puppeteer-core 能驱动的。 */
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => fs.existsSync(p));
const enabled = process.env.EDITOR_E2E === '1' && !!CHROME;
const skip = enabled ? false : 'set EDITOR_E2E=1 (needs a Chromium browser: $CHROME_PATH or a default install)';

/** 已存在的包（页面载入时会从 /api/state 拿到）：撞名的那条测试要它。 */
const PACK = 'ui-pack';

describe('编辑器新建工坊包：页内内联输入框（真浏览器）', { skip }, () => {
  let tmp;
  let wsRoot;
  let editor;
  let browser;
  let page;
  /** 页面自己报的错（console.error / pageerror / /api/ 4xx）：整个流程只要有一条，这条测试就不算通过。 */
  const problems = [];

  const inlineForm = '#newPackPanel .packNewForm';
  const inlineInput = '#newPackPanel .packNewId';

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-pack-picker-'));
    wsRoot = join(tmp, 'workshop');
    const dir = join(wsRoot, PACK);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
      id: PACK, name: '界面测试包', version: '1.0.0', license: 'CC0-1.0', content: ['chess'],
    }, null, 2)}\n`);

    const { createEditorServer } = await import('../editor/server.mjs');
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-gpu'] });

    page = await browser.newPage();
    // 「Failed to load resource」是浏览器对下面那条 response 的复述，URL 在有 response 的那一处判 ——
    // 否则一条对 favicon 的 404 会伪装成「页面报错」。
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    // 浏览器会自己来要 favicon：编辑器没有这个文件，与页面是否正常无关。
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) problems.push(`HTTP ${r.status()} ${r.url()}`);
    });

    // 「保存到哪个包」的下拉由 /api/state 的包清单画出来，所以先等它出来再开始点。
    await page.goto(`${editor.url}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#packList .item', { timeout: 20000 });
  });

  after(async () => {
    await browser?.close();
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 让页面把微任务跑完（展开表单后的聚焦是 queueMicrotask，点击的默认行为会晚一步覆盖它）。 */
  const settle = () => new Promise((r) => setTimeout(r, 30));
  /** 点「新建工坊包」并等输入框出现。 */
  const openForm = async () => {
    await page.click('#btnNewPack');
    await page.waitForSelector(inlineInput, { timeout: 5000 });
    await settle();
  };
  /** 验证当前展开的表单里写着什么错误（没有错误时返回 ''）。 */
  const errorText = () => page.$eval('#newPackPanel .packNewForm', (e) => e.querySelector('.err')?.textContent ?? '');
  /** 往输入框里敲一个值。**用 set + input 事件**：puppeteer 的 type() 会先点一下输入框，而这里
   *  刚刚重画过 DOM，逐字符输入会打在一个正在被替换的元素上（实测只进去第一个字符）。 */
  const typeId = async (value) => {
    await page.$eval(inlineInput, (e, v) => {
      e.focus();
      e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await settle();
  };

  test('点「新建工坊包」：出现页内输入框、并自动获得焦点，不是原生弹窗', async () => {
    await openForm();
    // 原生弹窗在这里是不存在的：这个页面从来没有把 prompt 挂在 window 上过（下面那条测试更直接地钉它）
    assert.equal(await page.$eval(inlineForm, (e) => e.closest('body') !== null), true, '输入框真的长在页面里');
    assert.equal(await page.evaluate(() => document.activeElement?.className ?? ''), 'packNewId', '展开就把光标放进去，不用先点一下');
    assert.deepEqual(await page.$$eval(inlineForm, (els) => els.length), 1, '只有一个表单，不能画两份');
  });

  test('原生 prompt 根本没有被调用过（页面里装了会抛错的桩）', async () => {
    // 页面已经跑起来了，现在才挂钩子也来得及：这条路径上的 prompt 调用只可能发生在「点新建」那一下。
    await page.evaluate(() => { window.prompt = () => { throw new Error('这条路上不该出现原生 prompt()'); }; });
    await page.click('#btnNewPack');                             // 再点一次 = 收起
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, inlineForm);
    await openForm();                                            // 再开一次：整个流程都走一遍桩
    assert.equal(await page.$eval(inlineInput, (e) => !!e), true);
  });

  test('非法 id 就地报错：表单不收起、也不新建', async () => {
    await typeId('有中文的 id');
    await page.click('#newPackPanel button.primary');
    assert.match(await errorText(), /只能是字母、数字、下划线、短横线/, '错误说清规则，而不是弹一个 alert');
    assert.equal(await page.$eval(inlineInput, (e) => e.value), '有中文的 id', '报错不能把用户打的字擦掉');
    assert.equal(await page.$(inlineForm) !== null, true, '表单还在，作者可以改');

    await typeId('   ');
    await page.click('#newPackPanel button.primary');
    assert.match(await errorText(), /不能为空/);
  });

  test('撞上已有的包：报错里点名是哪一个', async () => {
    await typeId(PACK);
    await page.click('#newPackPanel button.primary');
    assert.match(await errorText(), new RegExp(PACK), '重名时得说清是撞上了哪一个');
  });

  test('取消：表单收起、不新建', async () => {
    await page.click('#newPackPanel button.ghost');
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, inlineForm);
    assert.equal(await page.$eval('#newPackPanel', (e) => e.children.length), 0);
  });

  test('输入合法 id 后确认：真的新建成功（保存目标换成了它）', async () => {
    await openForm();
    await typeId('brand_new_pack');
    // 保存目标是不是真的变了，看页面往哪儿 POST —— 拦下请求、原样回一条错误，页面会把它显示出来，
    // 这样既证明了 URL 里的包 id，又不用真的在磁盘上建包（建包是服务端在第一次保存时做的事）。
    await page.evaluate(() => {
      window.__packSave = null;
      const real = window.fetch;
      window.fetch = (url, init = {}) => {
        if (init.method === 'POST' && String(url).includes('/operators')) {
          window.__packSave = { url: String(url), body: init.body ?? null };
          return Promise.resolve(new Response(JSON.stringify({ error: '拦住了（测试桩）' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
        }
        return real(url, init);
      };
    });
    await page.click('#newPackPanel button.primary');
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, inlineForm);

    // 「保存第一个干员时会创建工坊包 …」是页面自己的确认文案：它证明 state.packId 真的换成了新 id
    // （新包这时**还不会**出现在左栏清单里 —— 它要等第一次保存落到磁盘、再 /api/state 回来才在清单里，
    //  这是这一页原本就有的行为，不是这次改动引入的。）
    await page.waitForFunction(() => document.querySelector('#editor')?.textContent?.includes('brand_new_pack'), { timeout: 5000 });

    // 选择目标是不是真的变了，看页面往哪儿 POST —— 拦下请求、原样回一条错误，页面会把它显示出来，
    // 这样既证明了 URL 里的包 id，又不用真的在磁盘上建包（建包是服务端在第一次保存时做的事）。
    await page.click('#editor button.primary');
    await page.waitForFunction(() => window.__packSave !== null, { timeout: 5000 });
    const saved = await page.evaluate(() => window.__packSave);
    assert.match(saved.url, /\/api\/packs\/brand_new_pack\/operators$/, '保存目标就是刚新建的那个包');
  });

  test('整个流程没有一条页面错误（console.error / pageerror / /api/ 4xx）', () => {
    assert.deepEqual(problems, []);
  });
});
