// test/packMetaPage.e2e.test.js — 第八页（/pack.html）的「包元数据」与「覆盖官方记录」在真浏览器里长什么样。
//
// 为什么值得一条浏览器测试：这一版补的是编辑器此前**完全没有入口**的一件事 —— 写 `pack.json` 的
// name/version/author/license/description/gameVersion 与 overrides。它的价值全在三条只有真 DOM 才证明得了的规则上：
//   1. 一个有 `assets/` 的包在界面上填上 license、点一次保存之后，**磁盘上的 pack.json 真的有了它**，
//      而加载器的结论从「整包拒绝（ASSETS_NEED_LICENSE）」变成「接受」—— 此前作者只能手改 pack.json，
//      而在这之前编辑器的语音/图标/外观三个页面全都拒绝写入；
//   2. **写进 pack.json 的东西必须能在界面上删掉**（业主的硬约束）：overrides 那一块加一条、再逐条删掉；
//   3. 「清空」唯一会被拒的那个字段（有 assets/ 的包的 license）要把服务端那句中文**原样显示给作者**，
//      而不是让他自己去猜为什么保存没反应。
// 纯逻辑那一半（形状、拒绝清单、CLI 等价）由 test/packMetaEditor.test.js 用 HTTP + 临时包钉住，这里只跑页面。
//
// 用的是仓库既有的 puppeteer-core 套路（test/artEditorPage.e2e.test.js 同一套）：默认跳过，`EDITOR_E2E=1` 才起浏览器。
//
//   EDITOR_E2E=1 node --test test/packMetaPage.e2e.test.js
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

const PACK = 'meta-pack';
/** 官方 chess 表里真的有的一个 id：候选来自服务端读的 `data/chess.json`，`<文件>:<id>` 就是 overrides 里那条。 */
const OVERRIDE = 'chess:chess_char_1_01_a';

describe('第八页：包元数据与 overrides（真浏览器）', { skip }, () => {
  let tmp;
  let wsRoot;
  let editor;
  let browser;
  /** 页面自己报的错：整段流程里只要有一条，这条测试就不算通过（它多半意味着某处抛了异常）。 */
  const problems = [];
  /** **故意**要的那条 4xx 的正文（见 openPage 里的说明）：清空一个有 assets/ 的包的 license 会被 400 拒绝。 */
  const expectedRefusals = [];
  /** 删除声明会问一次 confirm（与「删除干员」同一个约定）：一律确认，并把问题记下来当断言用。 */
  const dialogs = [];
  const manifestPath = () => join(wsRoot, PACK, 'pack.json');
  const manifest = () => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  /** 服务端自己的结论（页面只显示它，不自己判断）：`ok === false` 就是「加载器不会用这个包」。 */
  const serverMeta = async () => {
    const res = await fetch(`${editor.url}/api/packs/support`);
    assert.equal(res.status, 200);
    return (await res.json()).meta[PACK];
  };
  /** 等 pack.json 变成期望的样子（页面保存是异步的，落盘之后才断言）。 */
  const waitManifest = async (check) => {
    for (let i = 0; i < 100; i++) {
      try { if (check(manifest())) return manifest(); } catch { /* 还没写出来 */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pack.json 没有变成期望的样子：${JSON.stringify(manifest())}`);
  };
  /** 等一个纯内存条件（读响应正文是异步的：断言前必须等它落进数组，否则就是在赌时序）。 */
  const waitFor = async (check, label) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`没有等到：${label}`);
  };

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-pack-meta-page-'));
    wsRoot = join(tmp, 'workshop');
    const dir = join(wsRoot, PACK);
    fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
    // 一个有 assets/ 但**没有 license** 的包：加载器会整包拒绝（ASSETS_NEED_LICENSE），而编辑器此前只能让作者手改清单。
    // 它带一个自己的 chess.json 并且 content 声明了它 —— 空包不会被加载器接（那样这条测试就测不到 license 那道门了）。
    // 素材不需要是真音频：这一页不解析文件，`hasAssets` 只看 assets/ 这个目录在不在。
    fs.writeFileSync(manifestPath(), `${JSON.stringify({ id: PACK, name: '元数据页测试包', version: '0.1.0', content: ['chess'] }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({ chess_ws_meta_a: { chessId: 'chess_ws_meta_a', name: '元数据页干员', tier: 4 } }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'assets', 'voice', 'select1.mp3'), Buffer.from('ID3', 'utf8'));

    const { createEditorServer } = await import('../editor/server.mjs');
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-gpu'] });
  });

  after(async () => {
    await browser?.close();
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 开一页并把「页面自己有没有报错」挂上（favicon 的 404 与页面无关）。 */
  async function openPage(path) {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', async (r) => {
      if (r.status() < 400 || r.url().endsWith('/favicon.ico')) return;
      const body = await r.text().catch(() => '');
      // 只有一条 4xx 是**故意**要的：清空一个有 assets/ 的包的 license 会被服务端拒绝（ASSETS_NEED_LICENSE），
      // 而「那句话真的显示给作者」正是要验证的一件事。除此之外任何 4xx/5xx 都算页面出错。
      if (r.status() === 400 && r.url().endsWith('/meta') && body.includes('ASSETS_NEED_LICENSE')) {
        expectedRefusals.push(body);
        return;
      }
      problems.push(`HTTP ${r.status()} ${r.url()}`);
    });
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${editor.url}/${path}`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  test('缺 license 的包：填上 license 保存后 pack.json 真的有它，警告消失、加载器接受；留空则删掉字段', async () => {
    const page = await openPage('pack.html');
    try {
      await page.waitForSelector('#packList .item', { timeout: 20000 });
      await page.click('#packList .item');                       // 唯一的那个包
      await page.waitForSelector('#detail .metaPanel', { timeout: 10000 });

      // 保存之前：这一块顶上有缺 license 的警告（说的就是加载器那句 ASSETS_NEED_LICENSE），服务端的结论是「拒绝」
      assert.equal(
        await page.$eval('#detail .metaBanner', (e) => e.textContent.includes('ASSETS_NEED_LICENSE')),
        true,
        '有 assets/ 又没 license 时，必须有一条说清后果的警告',
      );
      const before = await serverMeta();
      assert.equal(before.hasAssets, true, '这个包要真的有 assets/（不然这条测试什么都没测）');
      assert.equal(before.meta.license, null);
      assert.equal(before.ok, false, '缺 license 时加载器整包拒绝');
      // 横幅旁边还该有一个一键填上的按钮（它走的是同一条保存路径，所以这里只证明它画出来了）
      assert.equal(await page.$eval('#detail .metaQuickLicense', (e) => e.disabled), false);

      // 六个字段都在（清单来自服务端的 metaFields），初值取服务端给的 meta，null 显示成空
      assert.deepEqual(
        await page.$$eval('#detail .metaInput', (els) => els.map((e) => e.dataset.field).sort()),
        ['author', 'description', 'gameVersion', 'license', 'name', 'version'],
      );
      assert.equal(await page.$eval('#detail .metaInput[data-field="name"]', (e) => e.value), '元数据页测试包');
      assert.equal(await page.$eval('#detail .metaInput[data-field="version"]', (e) => e.value), '0.1.0');
      assert.equal(await page.$eval('#detail .metaInput[data-field="license"]', (e) => e.value), '', 'null 要显示成空输入框');
      // license 的候选来自服务端的 licenseChoices（datalist，仍可手输）
      assert.ok(
        (await page.$$eval('#licenseChoices option', (els) => els.map((o) => o.value))).includes('CC0-1.0'),
        'license 该有 datalist 候选',
      );

      // 一个还没填 license 的包也必须能改别的字段：页面只发**真的改了**的键，否则服务端「有 assets/ 不许清空
      // license」那条会把整个表单一起拦下（那正是这一版要修的那类包，不该出现「想改作者名却被 license 拦住」）
      await page.type('#detail .metaInput[data-field="author"]', '测试作者');
      await page.click('#detail .metaSave');
      await waitManifest((m) => m.author === '测试作者');
      assert.equal(manifest().license, undefined, '这一步一个字都没碰 license');
      assert.equal(await page.$eval('#detail', (e) => e.textContent.includes('加载器不会使用这个包')), true, '没 license 就还是拒绝状态');
      // 等页面重画完（写完还要重新取一次 /api/packs/support）再去填 license，顺便确认警告还在
      await page.waitForFunction(() => document.querySelector('#detail .metaInput[data-field="author"]').value === '测试作者', { timeout: 10000 });
      assert.equal(await page.$eval('#detail .metaBanner', (e) => e.textContent.includes('ASSETS_NEED_LICENSE')), true, '改作者名不该让缺 license 的警告消失');

      // 填 license、保存：磁盘上要真的有，页面要换掉那条警告
      await page.type('#detail .metaInput[data-field="license"]', 'CC0-1.0');
      await page.click('#detail .metaSave');
      const saved = await waitManifest((m) => m.license === 'CC0-1.0');
      assert.equal(saved.name, '元数据页测试包', '没动的字段原样留着');
      assert.equal(saved.version, '0.1.0');
      assert.equal(saved.author, '测试作者', '上一步改的作者还在');
      // 页面的警告消失（这是这一版的核心目的：作者不必再手改 pack.json 才能解封语音/图标/外观三页）
      await page.waitForFunction(() => !document.querySelector('#detail .metaBanner'), { timeout: 10000 });
      assert.equal(await page.$eval('#detail', (e) => e.textContent.includes('加载器接受这个包')), true, '保存后页面该显示加载器接受');
      const after = await serverMeta();
      assert.equal(after.meta.license, 'CC0-1.0', '服务端也认为 license 声明上了');
      assert.equal(after.ok, true, '填上 license 之后加载器该接受这个包');

      // 留空 = 删掉这个字段（不是写一个空字符串进去）：清空 author 再保存，那个键要从 pack.json 里消失
      await page.$eval('#detail .metaInput[data-field="author"]', (e) => {
        e.value = '';
        e.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('#detail .metaSave');
      await waitManifest((m) => !('author' in m));
      assert.equal((await serverMeta()).meta.author, null, '服务端也认为这个字段没了');

      assert.deepEqual(problems, [], '整段流程里页面不该报任何错');
    } finally {
      await page.close();
    }
  });

  test('overrides：手输一个官方 id 加进去就写进 pack.json，删除按钮让它消失', async () => {
    const page = await openPage('pack.html');
    try {
      await page.waitForSelector('#packList .item', { timeout: 20000 });
      await page.click('#packList .item');
      await page.waitForSelector('#detail .ovPanel', { timeout: 10000 });
      assert.equal(await page.$eval('#detail .ovList', (e) => e.textContent.includes('还没有声明')), true);

      // 文件下拉列的就是官方那些数据表（值 = 文件名，与 `<文件>:<id>` 的前半段同一个写法）
      const files = await page.$$eval('#detail .ovAddFile option', (els) => els.map((o) => o.value));
      assert.ok(files.includes('chess') && files.includes('bonds'), `文件下拉该列出官方数据表（实际 ${files.join(',')}）`);
      await page.select('#detail .ovAddFile', 'chess');
      // 候选来自服务端的 overrideCandidates：官方真的有的那个 id 要在里面（候选是提示，不是白名单）
      const choices = await page.$$eval('#ovIdChoices option', (els) => els.map((o) => o.value));
      assert.ok(choices.includes('chess_char_1_01_a'), `chess 的候选里该有官方 id（实际 ${choices.length} 条）`);

      // 手输（必须能手输：官方没有的 id 也能声明）+ 添加
      await page.type('#detail .ovAddId', 'chess_char_1_01_a');
      await page.click('#detail .ovAdd');
      await waitManifest((m) => (m.overrides ?? []).includes(OVERRIDE));
      // 页面重画是异步的（写盘之后还要重新取一次 /api/packs/support）：先等那一行真的出现在清单里
      await page.waitForFunction(
        (entry) => [...document.querySelectorAll('#detail .ovRow')].some((r) => r.dataset.entry === entry),
        { timeout: 10000 },
        OVERRIDE,
      );
      // 这一条官方有、但本包没带那条记录 —— 界面要标成「陈旧，不生效」（留着不是错误，但能删）
      const row = await page.evaluateHandle((entry) => [...document.querySelectorAll('#detail .ovRow')].find((r) => r.dataset.entry === entry), OVERRIDE);
      assert.ok(row.asElement(), '新加的这条要在清单里列出来');
      assert.equal(await row.asElement().$eval('.ovEntry', (e) => e.textContent), OVERRIDE);
      assert.equal(await row.asElement().$eval('.tag', (e) => e.textContent), '陈旧，不生效');

      // 删掉它：业主的硬约束 —— 写进 pack.json 的东西必须能在界面上删掉
      // （按 `data-entry` 选中那一行的删除按钮：elementHandle.click() 在 puppeteer 25 里只接受 options，
      //  传选择符会点到整行的中心，所以这里用 page.click + 属性选择符）
      await page.click(`#detail .ovRow[data-entry="${OVERRIDE}"] .ovDel`);
      await waitManifest((m) => !(m.overrides ?? []).includes(OVERRIDE));
      await page.waitForFunction(
        (entry) => ![...document.querySelectorAll('#detail .ovRow')].some((r) => r.dataset.entry === entry),
        { timeout: 10000 },
        OVERRIDE,
      );
      assert.ok(dialogs.some((d) => d.includes(OVERRIDE)), '删除前要问一次（与其它页面同一个约定）');
      assert.equal('overrides' in manifest(), false, '表空了就不该留一个空数组');

      assert.deepEqual(problems, [], '整段流程里页面不该报任何错');
    } finally {
      await page.close();
    }
  });

  test('清空一个有 assets/ 的包的 license：服务端拒绝（ASSETS_NEED_LICENSE），页面把这句话原样显示给作者', async () => {
    const page = await openPage('pack.html');
    try {
      await page.waitForSelector('#packList .item', { timeout: 20000 });
      await page.click('#packList .item');
      await page.waitForSelector('#detail .metaInput[data-field="license"]', { timeout: 10000 });
      const before = manifest();

      await page.$eval('#detail .metaInput[data-field="license"]', (e) => {
        e.value = '';
        e.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('#detail .metaSave');
      // 页面上要出现服务端那句中文（不是「保存失败」这种让作者猜的话）
      await page.waitForFunction(
        () => document.querySelector('#side .banner')?.textContent.includes('ASSETS_NEED_LICENSE'),
        { timeout: 10000 },
      );
      // 读响应正文是异步的：先等那条 400 的正文落进数组（否则就是在赌时序）
      await waitFor(() => expectedRefusals.length === 1, '那条故意要的 400（ASSETS_NEED_LICENSE）的正文');
      assert.equal(expectedRefusals.length, 1, '这一次 400 是故意要的（见 openPage 里的说明）');
      assert.ok(expectedRefusals[0].includes('必须声明一个 license'), `服务端要给出一句能懂的中文：${expectedRefusals[0]}`);
      // 被拒绝的保存不能写盘：磁盘上什么都不该变
      assert.deepEqual(manifest(), before, '拒绝的保存不能写盘');
      assert.deepEqual(problems, [], '除了那一条故意要的 400，页面不该报任何错');
    } finally {
      await page.close();
    }
  });
});
