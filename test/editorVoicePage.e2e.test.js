// test/editorVoicePage.e2e.test.js — 语音页的**语言选择**在真浏览器里跑一遍。
//
// 为什么值得一条浏览器测试：语言选择是这一版唯一「只活在界面上」的东西。服务端的形状、合并与拒绝由
// test/workshopVoices.test.js（叠加层）和 test/voiceEditor.test.js（HTTP 接口）钉住了，但
// 「点中文 → 中栏与右栏整块换成 cn 那一档 → 存下去的是 voiceLangs.cn 而不是 voices」这件事，
// 只有把页面真的跑起来才算证明；而它恰恰是最容易写错、错了还静默的一半（选错档位 = 台词写进另一份表，
// 界面不报错，玩家只是听不到）。所以这条测试点的是真按钮、填的是真表单、读的是磁盘上的 pack.json。
//
// 用的是仓库既有的 puppeteer-core 套路（test/render/browser.test.js 同一套）：默认跳过，
// `EDITOR_E2E=1` 才起浏览器。浏览器路径取 `$CHROME_PATH`，否则找下面几个常见位置。
//
//   EDITOR_E2E=1 node --test test/editorVoicePage.e2e.test.js
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

const PACK = 'ui-pack';
const CH = 'char_ws_ui';
const MP3 = (tag) => Buffer.from(`ID3\x03\x00\x00\x00\x00\x00\x00${tag}`, 'latin1');

describe('编辑器语音页：语言选择（真浏览器）', { skip }, () => {
  let tmp;
  let wsRoot;
  let editor;
  let browser;
  let page;
  /** 页面自己报的错（console.error / pageerror / /api/ 4xx）：整个流程只要有一条，这条测试就不算通过。 */
  const problems = [];

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-voice-page-'));
    wsRoot = join(tmp, 'workshop');
    const dir = join(wsRoot, PACK);
    fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
      id: PACK, name: '界面测试包', version: '1.0.0', license: 'CC0-1.0', content: ['chess'],
      voices: { [CH]: { select: ['voice/jp1.mp3'] } },
    }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'assets', 'voice', 'cn1.mp3'), MP3('CN1'));
    fs.writeFileSync(join(dir, 'assets', 'voice', 'jp1.mp3'), MP3('JP1'));

    const { createEditorServer } = await import('../editor/server.mjs');
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-gpu'] });

    page = await browser.newPage();
    // 「Failed to load resource」是浏览器对下面那条 4xx/5xx response 的复述，URL 在有 response 的那一处判 ——
    // 否则一条对 favicon 的 404 会伪装成「页面报错」。
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    // 浏览器会自己来要 favicon：编辑器没有这个文件，与页面是否正常无关。
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) problems.push(`HTTP ${r.status()} ${r.url()}`);
    });
    await page.goto(`${editor.url}/voice.html`, { waitUntil: 'domcontentloaded' });
    // 页面自己拉完 /api/voices、并且选中了第一个包，才会画出左栏与语言选择
    await page.waitForSelector('#packList .item', { timeout: 20000 });
    await page.waitForSelector('.langs button.chip', { timeout: 20000 });
  });

  after(async () => {
    await browser?.close();
    await editor?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * 磁盘上的 pack.json —— 但**可能正被写到一半**：写回是「打开文件、写、关」那一瞬间的事，而这里是在轮询。
   * 所以读不到或解析失败都返回 null，由调用方重试：一个半截文件不是「保存失败」的证据。
   */
  const manifest = () => {
    try { return JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'pack.json'), 'utf8')); } catch { return null; }
  };
  /** 页面上的语言 chip：默认配音那一个没有 `<code>`，其余各带自己的语种码。 */
  const chips = () => page.$$eval('.langs button.chip', (els) => els.map((e) => ({
    lang: e.querySelector('code')?.textContent ?? null,
    pressed: e.getAttribute('aria-pressed') === 'true',
    text: e.textContent,
  })));
  const clickChip = async (lang) => {
    await page.evaluate((want) => {
      const btn = [...document.querySelectorAll('.langs button.chip')]
        .find((b) => (b.querySelector('code')?.textContent ?? null) === want);
      if (!btn) throw new Error(`no chip for ${want}`);
      btn.click();
    }, lang);
  };
  /** 一个输入框换成给定值，并保证页面自己的 state 跟得上（它监听的是 input 事件）。 */
  const setInput = async (sel, value) => {
    await page.$eval(sel, (e) => { e.value = ''; });
    await page.type(sel, value);
  };
  /** 存一条，并等磁盘真的变了：超时就报错，而不是「大概好了」。 */
  const saveLine = async (charId, slot, file) => {
    await setInput('#form input[list="opChoices"]', charId);
    await page.select('#form select', slot);
    await setInput('#form input[list="fileChoices"]', file);
    await page.click('#form button.primary');
    const deadline = Date.now() + 10000;
    for (;;) {
      const m = manifest();
      const hit = m && (Object.values(m.voiceLangs ?? {}).some((t) => t?.[charId]?.[slot]?.includes(file))
        || m.voices?.[charId]?.[slot]?.includes(file));
      if (hit) return m;
      if (Date.now() > deadline) throw new Error(`save did not land: ${charId}/${slot}/${file}\n${JSON.stringify(manifest())}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  test('打开页面就有语言选择：默认配音 + cn/en/kr 三档，默认配音是当前那一档', async () => {
    const list = await chips();
    assert.deepEqual(list.map((c) => c.lang), [null, 'cn', 'en', 'kr'], '语言词表来自 shared/constants.js 的 VOICE_LANGS');
    assert.deepEqual(list.filter((c) => c.pressed).map((c) => c.lang), [null], '默认配音是打开时的当前档');
    assert.match(list[0].text, /默认配音/, '第一档说清它就是默认配音');
    assert.match(list[0].text, /1/, '默认配音那一档已有 1 条');
    assert.match(list[1].text, /未声明/, 'cn 还一条都没有');
    const hint = await page.$eval('.langs .hint', (e) => e.textContent);
    assert.match(hint, /voiceLangs/, '页面明说这些语种写进 voiceLangs');
    assert.match(hint, /VOICE_LANG_DEFAULT/, '也明说默认语种不能写进 voiceLangs');
  });

  test('点中文：中栏与右栏整块换成 voiceLangs.cn 那一档', async () => {
    await clickChip('cn');
    await page.waitForFunction(() => document.querySelector('#form')?.textContent?.includes('voiceLangs.cn'));
    const list = await chips();
    assert.deepEqual(list.filter((c) => c.pressed).map((c) => c.lang), ['cn']);
    const center = await page.$eval('#lines', (e) => e.textContent);
    assert.match(center, /中文/, '中栏说的是当前这一档');
    assert.match(center, /还没有/, 'cn 这一档还是空的，页面说清楚怎么加');
  });

  test('在 cn 那一档存一条 → 只写进 voiceLangs.cn，voices 一个字节没动', async () => {
    const before = manifest();
    const after = await saveLine(CH, 'select', 'voice/cn1.mp3');
    assert.deepEqual(after.voiceLangs, { cn: { [CH]: { select: ['voice/cn1.mp3'] } } }, '就写进 cn 那一份');
    assert.deepEqual(after.voices, before.voices, '默认配音那一份完全没动');
    assert.equal(after.content.includes('chess'), true, '清单的其余字段照旧');
    // 存过之后 chip 不该再写「未声明」，而是条数
    const list = await chips();
    assert.doesNotMatch(list.find((c) => c.lang === 'cn').text, /未声明/);
  });

  test('回到默认配音那一档存同一位干员的另一个槽位 → 只改 voices', async () => {
    await clickChip(null);
    await page.waitForFunction(() => !document.querySelector('#form')?.textContent?.includes('voiceLangs.'));
    const after = await saveLine(CH, 'place', 'voice/jp1.mp3');
    assert.deepEqual(after.voices[CH], { select: ['voice/jp1.mp3'], place: ['voice/jp1.mp3'] }, '默认配音这一份多了一个槽位');
    assert.deepEqual(after.voiceLangs, { cn: { [CH]: { select: ['voice/cn1.mp3'] } } }, 'cn 那一份原样不动');
  });

  test('整个流程没有一条页面错误（console.error / pageerror / /api/ 4xx）', () => {
    assert.deepEqual(problems, []);
  });
});
