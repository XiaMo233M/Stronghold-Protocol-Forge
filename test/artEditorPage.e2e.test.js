// test/artEditorPage.e2e.test.js — 「本包自带的外观素材」在真浏览器里长什么样（干员页 + 怪物页各一段）。
//
// 为什么值得一条浏览器测试：这一块的价值全在两件只有真 DOM 才证明得了的事上 ——
//   1. **选完 skel 自动填同目录同名的 atlas**（那条包改不了的硬约束，界面替作者填掉）；以及
//   2. **任何写进 pack.json 的声明都能在界面上删掉**（业主的硬要求：不许要求作者手改清单）。
// 纯逻辑那一半（形状、拒绝清单、逐级清理、端到端并表）由 test/artEditor.test.js 用 HTTP + 临时包钉住，这里只跑页面。
//
// 用的是仓库既有的 puppeteer-core 套路（test/editorPackPicker.e2e.test.js 同一套）：默认跳过，`EDITOR_E2E=1` 才起浏览器。
//
//   EDITOR_E2E=1 node --test test/artEditorPage.e2e.test.js
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

const PACK = 'look-pack';

/** 一份**真的能被 @pixi-spine/runtime-3.8 解析**的 3.8 骨架二进制（布局见 test/workshopArt.test.js）。 */
function skelBytes({ version = '3.8.99', anims = [] } = {}) {
  const varint = (n) => {
    const out = [];
    let v = n;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  };
  const str = (s) => [...varint(s.length + 1), ...Buffer.from(s, 'utf8')];
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return [...b]; };
  return Buffer.from([
    ...str('stand-in'), ...str(version),
    ...f32(0), ...f32(0), ...f32(64), ...f32(64),
    0,
    ...varint(0), ...varint(0), ...varint(0), ...varint(0), ...varint(0), ...varint(0), ...varint(0), ...varint(0), ...varint(0),
    ...varint(anims.length),
    ...anims.flatMap((n) => [...str(n), ...new Array(8).fill(0).flatMap(() => varint(0))]),
  ]);
}
const atlasText = (page) => [page, 'size: 64,64', 'format: RGBA8888', 'filter: Linear,Linear', 'repeat: none', 'Body', '  rotate: false', '  xy: 0, 0', '  size: 64, 64', '  orig: 64, 64', '  offset: 0, 0', '  index: -1', ''].join('\n');
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6e0000000049454e44ae426082', 'hex');

describe('外观素材那一块：真浏览器（干员页 + 怪物页）', { skip }, () => {
  let tmp;
  let wsRoot;
  let editor;
  let browser;
  /** 页面自己报的错：整段流程里只要有一条，这条测试就不算通过（它多半意味着某处抛了异常）。 */
  const problems = [];
  const dialogs = [];
  const manifestPath = () => join(wsRoot, PACK, 'pack.json');
  const manifest = () => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  const settle = () => new Promise((r) => setTimeout(r, 60));
  /** 等 pack.json 变成期望的样子（页面保存是异步的，落盘之后才断言）。 */
  const waitManifest = async (check) => {
    for (let i = 0; i < 100; i++) {
      try { if (check(manifest())) return manifest(); } catch { /* 还没写出来 */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pack.json 没有变成期望的样子：${JSON.stringify(manifest())}`);
  };

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-art-page-'));
    wsRoot = join(tmp, 'workshop');
    const dir = join(wsRoot, PACK);
    fs.mkdirSync(join(dir, 'assets', 'art'), { recursive: true });
    // 一个已经声明过外观的包：清单里那条要点得出来、删得掉
    fs.writeFileSync(manifestPath(), `${JSON.stringify({
      id: PACK, name: '外观页测试包', version: '1.0.0', license: 'CC0-1.0',
      art: { chars: { char_ws_hero: { avatar: 'art/avatar.png' } } },
    }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'assets', 'art', 'op.skel'), skelBytes({ anims: ['Idle', 'Attack'] }));
    fs.writeFileSync(join(dir, 'assets', 'art', 'op.atlas'), atlasText('op.png'));
    fs.writeFileSync(join(dir, 'assets', 'art', 'op.png'), PNG_1PX);
    fs.writeFileSync(join(dir, 'assets', 'art', 'avatar.png'), PNG_1PX);

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
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) problems.push(`HTTP ${r.status()} ${r.url()}`); });
    // 删除声明会问一次 confirm（与「删除干员」同一个约定）：一律确认，并把它记下来当断言用
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${editor.url}/${path}`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  test('干员页：选完 skel 自动填同名的 atlas，保存后声明出现、删除按钮让它消失', async () => {
    const page = await openPage('index.html');
    try {
      await page.waitForSelector('#packList .item', { timeout: 20000 });
      await page.click('#packList .item');                       // 唯一的那个包
      await page.waitForSelector('#opList .item', { timeout: 10000 });
      await page.click('#opList .item');                         // 「＋ 新建干员」
      await page.waitForSelector('#sec-look', { timeout: 10000 });
      // 填 assetsSpine（客户端就是拿它去 chars 表查外观）：那一段里唯一的自由文本框
      await page.$eval('#sec-look .sec-body > .grid input', (e, v) => {
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, 'char_ws_hero');
      // 等的不是「面板出现了」而是「填完 id 那一版面板出现了」：面板在两种状态下都存在
      await page.waitForSelector('#sec-look .artPanel .artSkel', { timeout: 10000 });

      // 已经声明过的那条要点得出来（表.id + 它引用的文件）
      assert.equal(await page.$eval('#sec-look .artDeclared', (e) => e.textContent.includes('chars.char_ws_hero')), true);
      // 下拉里只列本包 assets/ 里**真的有的**文件（一个都没有的文件不会出现在候选里）
      assert.deepEqual(
        await page.$$eval('#sec-look .artPanel select', (els) => [...new Set(els.flatMap((s) => [...s.options].map((o) => o.value)).filter(Boolean))].sort()),
        ['art/avatar.png', 'art/op.atlas', 'art/op.png', 'art/op.skel'],
      );

      // 选本包的骨架：atlas 必须自动填上同目录同名的那个（手打必错，而且错了不报错）
      await page.select('#sec-look .artSkel', 'art/op.skel');
      assert.equal(await page.$eval('#sec-look .artAtlas', (e) => e.value), 'art/op.atlas', 'atlas 要按同名自动填上');
      assert.equal(await page.$eval('#sec-look .artTextures', (e) => e.value), 'art/op.png', 'textures 默认按图谱页名填');
      // 动画名候选来自服务端解析出的骨架（名字写错 → 模型能出来但不动，所以只能从真的有的名字里挑）
      await page.waitForFunction(() => [...document.querySelectorAll('#sec-look .artPanel select')]
        .some((s) => [...s.options].some((o) => o.value === 'Attack')), { timeout: 10000 });
      // 角色 idle 只有一个（只有 front 那一侧选了骨架）：它是 `field('idle', …)` 里那个下拉
      const idle = await page.evaluateHandle(() => [...document.querySelectorAll('#sec-look .artPanel label')]
        .find((l) => l.textContent === 'idle')?.parentElement.querySelector('select'));
      await idle.asElement().select('Idle');

      await page.click('#sec-look .artSave');
      const saved = await waitManifest((m) => m.art?.chars?.char_ws_hero?.spine?.front?.skel === 'art/op.skel');
      const front = saved.art.chars.char_ws_hero.spine.front;
      assert.equal(front.atlas, 'art/op.atlas');
      assert.deepEqual(front.textures, ['art/op.png'], 'textures 没手填时保存前自动补上');
      assert.equal(front.pma, false, '图谱没声明 pma 就写 false（清单与图谱不一致时客户端画的是错的）');
      assert.equal(front.anims.idle, 'Idle');
      assert.equal(saved.art.chars.char_ws_hero.avatar, 'art/avatar.png', '原来那条头像声明原样留着');

      // 删掉这条声明（业主的硬要求：写进 pack.json 的东西必须能在界面上删掉）
      await page.waitForSelector('#sec-look .artDeclared .artDel', { timeout: 10000 });
      await page.click('#sec-look .artDeclared .artDel');
      await waitManifest((m) => !m.art?.chars?.char_ws_hero);
      assert.ok(dialogs.some((d) => d.includes('chars.char_ws_hero')), '删除前要问一次（与删除干员同一个约定）');
      assert.deepEqual(problems, [], '整段流程里页面不该报任何错');
    } finally {
      await page.close();
    }
  });

  // 干员页的第三块：召唤物（`art.tokens`）。表的 id 是**召唤物自己的 id**（`assets.tokens` 的键），不是干员的
  // `assetsSpine`；`owner` 是原样抄过去的 id。与上面那条同一个包，所以这一条跑完只该留下 `art.tokens`。
  //
  // 这一条**故意不填 `assetsSpine`**：召唤物是另一张表、另一个 id，一个用官方模型的干员照样要能给自己召唤
  // 出来的东西换图。少了这条断言，把那块挂回 `assetsSpine` 的提前返回之后也能全绿（就是「删得掉、加不了」）。
  test('干员页：召唤物那一块（自己的 id、扁平 spine、owner、保存与删除；不填 assetsSpine 也要在）', async () => {
    const page = await openPage('index.html');
    try {
      await page.waitForSelector('#packList .item', { timeout: 20000 });
      await page.click('#packList .item');
      await page.waitForSelector('#opList .item', { timeout: 10000 });
      await page.click('#opList .item');                           // 「＋ 新建干员」
      await page.waitForSelector('#sec-look', { timeout: 10000 });
      // 干员的 id 要真的填上：`owner` 这个按钮写的是 `chess_ws_<slug>_a`，slug 就是它
      await page.type('#sec-identity input', 'char_ws_hero');
      // assetsSpine 留空：chars 那一块的提示还在，但召唤物那一块必须照样在
      await page.waitForSelector('#sec-look .artTokens .tokenId', { timeout: 10000 });
      assert.equal(await page.evaluate(() => document.querySelector('#sec-look').textContent.includes('先在「assetsSpine」里填')), true,
        '没填 assetsSpine 时那句提示仍要说清');
      assert.equal(await page.$('#sec-look .artPanel .artSkel'), null, 'chars 那一侧这时候还不该有骨架下拉');

      // 候选来自服务端（官方 tokens.json 与官方/各包 chess.json 里的 tokens 数组）：`data/tokens.json` 里那些
      // 官方召唤物 id 必须在里面 —— 这一块绝大多数时候是给一个**已有的**召唤物换模型。
      const choices = await page.$$eval('#sec-look .artTokens #tokenIdChoices option', (els) => els.map((o) => o.value));
      assert.ok(choices.includes('token_10000_silent_healrb'), `召唤物候选里该有官方 token id（实际 ${choices.length} 条）`);

      // 填一个新的召唤物 id（手输这条路必须在：新 token 写进 pack.json 之前不在任何清单里）
      await page.$eval('#sec-look .artTokens .tokenId', (e, v) => {
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, 'token_ws_hero');
      await page.waitForSelector('#sec-look .artTokens .artSkel', { timeout: 10000 });
      // owner 是原样抄的 id，界面给一个「用当前干员」按钮（写 `chess_ws_<slug>_a`）
      await page.click('#sec-look .artTokens .artUseOwner');
      assert.equal(await page.$eval('#sec-look .artTokens .artOwner', (e) => e.value), 'chess_ws_char_ws_hero_a');

      // 选完 skel 自动填同目录同名的 atlas（与 chars / enemies 同一条硬约束）
      await page.select('#sec-look .artTokens .artSkel', 'art/op.skel');
      assert.equal(await page.$eval('#sec-look .artTokens .artAtlas', (e) => e.value), 'art/op.atlas');
      assert.equal(await page.$eval('#sec-look .artTokens .artTextures', (e) => e.value), 'art/op.png');
      // anims 只能从骨架里真的有的名字里挑
      await page.waitForFunction(() => [...document.querySelectorAll('#sec-look .artTokens select')]
        .some((s) => [...s.options].some((o) => o.value === 'Attack')), { timeout: 10000 });
      const idle = await page.evaluateHandle(() => [...document.querySelectorAll('#sec-look .artTokens label')]
        .find((l) => l.textContent === 'idle')?.parentElement.querySelector('select'));
      await idle.asElement().select('Idle');

      await page.click('#sec-look .artTokens .artSave');
      const saved = await waitManifest((m) => m.art?.tokens?.token_ws_hero?.spine?.skel === 'art/op.skel');
      const token = saved.art.tokens.token_ws_hero;
      assert.equal(token.owner, 'chess_ws_char_ws_hero_a');
      assert.equal(token.spine.atlas, 'art/op.atlas');
      assert.deepEqual(token.spine.textures, ['art/op.png']);
      assert.equal(token.spine.pma, false);
      assert.equal(token.spine.anims.idle, 'Idle');
      // `__id`（界面用的「草稿是给谁的」标记）绝不能写进清单
      assert.equal('__id' in token, false);
      // 只该多出 tokens 这张表：上面那条测试跑完已经把 chars 删干净了，这里不该又冒出来
      assert.deepEqual(Object.keys(saved.art), ['tokens']);
      assert.equal(await page.evaluate((key) => document.querySelector('#sec-look .artDeclared').textContent.includes(key), 'token_ws_hero'), true);

      // 删掉这一条：清单里按文本找到那一行（别拿第一个 `.artDel`，将来多一条声明就会删错人）
      const delBtn = await page.evaluateHandle((key) => [...document.querySelectorAll('#sec-look .artDeclared .row')]
        .find((row) => row.querySelector('.n')?.textContent === `tokens.${key}`)?.querySelector('.artDel'), 'token_ws_hero');
      assert.ok(delBtn.asElement(), '召唤物那条声明在清单里要有一个删除按钮');
      await delBtn.asElement().click();
      await waitManifest((m) => !m.art?.tokens?.token_ws_hero);
      assert.ok(dialogs.some((d) => d.includes('tokens.token_ws_hero')), '删除前要问一次');
      assert.deepEqual(problems, [], '整段流程里页面不该报任何错');
    } finally {
      await page.close();
    }
  });

  test('怪物页：同一块控件用扁平的 spine（id 就是记录键 enemy_ws_<id>）', async () => {
    const page = await openPage('enemy.html');
    try {
      await page.waitForSelector('#list .item', { timeout: 20000 });
      await page.click('#list .item');                           // 「＋ 新建怪物」
      // 这一页的保存目标一开始是空的（右栏那个下拉只是显示了一个兜底值）：先真的选一个包
      await page.waitForSelector('#side .packSelectSel', { timeout: 10000 });
      await page.select('#side .packSelectSel', PACK);
      await page.waitForSelector('#form .artPanel', { timeout: 10000 });
      // id 变了那一段要跟着重画（表单平时只重画右栏）
      await page.$eval('#form input', (e, v) => {
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, 'frost_hound');
      await page.waitForFunction(() => !document.querySelector('#form .artPanel').textContent.includes('先填 id'), { timeout: 10000 });
      await page.select('#form .artSkel', 'art/op.skel');
      assert.equal(await page.$eval('#form .artAtlas', (e) => e.value), 'art/op.atlas');
      await page.click('#form .artSave');
      const saved = await waitManifest((m) => m.art?.enemies?.enemy_ws_frost_hound?.spine?.skel === 'art/op.skel');
      assert.equal(saved.art.enemies.enemy_ws_frost_hound.spine.atlas, 'art/op.atlas');
      assert.deepEqual(saved.art.enemies.enemy_ws_frost_hound.spine.textures, ['art/op.png'], 'textures 也从图谱页名自动补上');
      // 这一页的清单里也要能删（表.id 是 enemies.enemy_ws_frost_hound）
      assert.equal(await page.$eval('#form .artDeclared', (e) => e.textContent.includes('enemies.enemy_ws_frost_hound')), true);
      await page.click('#form .artDeclared .artDel');
      await waitManifest((m) => !m.art?.enemies?.enemy_ws_frost_hound);
      assert.deepEqual(problems, [], '整段流程里页面不该报任何错');
    } finally {
      await page.close();
    }
  });
});
