// test/artEditorEnemyPage.e2e.test.js — 怪物页「本包自带的外观素材（可选）」在真浏览器里长什么样。
//
// 与 test/artEditorPage.e2e.test.js（干员页那一份）同一套 puppeteer-core 套路，为什么还要单独一条：怪物页那一块
// 走的是**另一份实现**（editor/ui/enemy.js 的 enemyArtBox，不是干员页的 lookArtPanel），而这一块的价值全在三件只有
// 真 DOM 才证明得了的事上 ——
//   1. 面板真的渲染出来（选包、填 id 之后那一段出现）；
//   2. **选完 skel 自动填同目录同名的 atlas**（包改不了的硬约束，界面替作者填掉，手打必错而且错了不报错）；
//   3. `anims` 的下拉里能选到**骨架里真的存在的**动画名（名字写错 → 模型能出来但不动，一条日志都没有），
//      以及保存 / 删除真的落到 `pack.json.art.enemies[...]` 上。
// 形状、拒绝清单、逐级清理那些由 test/artEditor.test.js 用 HTTP + 临时包钉住，这里只跑页面。
//
//   EDITOR_E2E=1 node --test test/artEditorEnemyPage.e2e.test.js
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

const PACK = 'enemy-look-pack';
/** 面板自动算出来的记录键（`enemy_ws_<id>`，shared/enemyAuthoring.js 的 enemyKey）：保存用的 id 就是它。 */
const ENEMY_KEY = 'enemy_ws_frost_hound';

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

describe('外观素材那一块：真浏览器（怪物页）', { skip }, () => {
  let tmp;
  let wsRoot;
  let editor;
  let browser;
  /** 页面自己报的错：整段流程里只要有一条，这条测试就不算通过（它多半意味着某处抛了异常）。 */
  const problems = [];
  const dialogs = [];
  const manifestPath = () => join(wsRoot, PACK, 'pack.json');
  const manifest = () => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  /** 等 pack.json 变成期望的样子（页面保存是异步的，落盘之后才断言）。 */
  const waitManifest = async (check) => {
    for (let i = 0; i < 100; i++) {
      try { if (check(manifest())) return manifest(); } catch { /* 还没写出来 */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pack.json 没有变成期望的样子：${fs.readFileSync(manifestPath(), 'utf8')}`);
  };

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-art-enemy-page-'));
    wsRoot = join(tmp, 'workshop');
    const dir = join(wsRoot, PACK);
    fs.mkdirSync(join(dir, 'assets', 'art'), { recursive: true });
    // 一个已经声明过怪物外观的包：清单里那条既要能显示，也要能删掉
    fs.writeFileSync(manifestPath(), `${JSON.stringify({
      id: PACK, name: '怪物外观页测试包', version: '1.0.0', license: 'CC0-1.0',
      art: { enemies: { enemy_ws_old_thing: { icon: 'art/icon.png' } } },
    }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'assets', 'art', 'hound.skel'), skelBytes({ anims: ['Idle', 'Death'] }));
    fs.writeFileSync(join(dir, 'assets', 'art', 'hound.atlas'), atlasText('hound.png'));
    fs.writeFileSync(join(dir, 'assets', 'art', 'hound.png'), PNG_1PX);
    fs.writeFileSync(join(dir, 'assets', 'art', 'icon.png'), PNG_1PX);

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
    // 删除声明会问一次 confirm（与「删除怪物」同一个约定）：一律确认，并把它记下来当断言用
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
    await page.goto(`${editor.url}/${path}`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  test('怪物页：面板渲染、选完 skel 自动填同名的 atlas、anims 能选到骨架里的真实动画名、保存后声明出现、删除后消失', async () => {
    const page = await openPage('enemy.html');
    try {
      await page.waitForSelector('#list .item', { timeout: 20000 });
      await page.click('#list .item');                           // 「＋ 新建怪物」
      // 这一页的保存目标一开始是空的（右栏那个下拉只是显示了一个兜底值）：先真的选一个包
      await page.waitForSelector('#side .packSelectSel', { timeout: 10000 });
      await page.select('#side .packSelectSel', PACK);

      // 1) 面板真的渲染出来（外观素材那一段就在表单里）
      await page.waitForSelector('#form .artPanel', { timeout: 10000 });
      assert.equal(await page.$eval('#form .artPanel', (e) => e.textContent.includes('本包自带的外观素材（可选）')), true);

      // id 变了那一段要跟着重画（表单平时只重画右栏）：id → 记录键 `enemy_ws_<id>`
      await page.$eval('#form input', (e, v) => {
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, 'frost_hound');
      await page.waitForFunction(() => !document.querySelector('#form .artPanel').textContent.includes('先填 id'), { timeout: 10000 });
      // 已声明过的那条要点得出来（表.记录键 + 它引用的文件）
      assert.equal(await page.$eval('#form .artDeclared', (e) => e.textContent.includes('enemies.enemy_ws_old_thing')), true);
      assert.equal(await page.$eval('#form .artDeclared', (e) => e.textContent.includes('art/icon.png')), true);

      // 2) 下拉里只列本包 assets/ 里**真的有的**文件
      assert.deepEqual(
        await page.$$eval('#form .artPanel select', (els) => [...new Set(els.flatMap((s) => [...s.options].map((o) => o.value)).filter(Boolean))].sort()),
        ['art/hound.atlas', 'art/hound.png', 'art/hound.skel', 'art/icon.png'],
      );

      // 选本包的骨架：atlas 必须自动填上同目录同名的那个（手打必错，而且错了不报错）
      await page.select('#form .artSkel', 'art/hound.skel');
      assert.equal(await page.$eval('#form .artAtlas', (e) => e.value), 'art/hound.atlas', 'atlas 要按同名自动填上');
      assert.equal(await page.$eval('#form .artTextures', (e) => e.value), 'art/hound.png', 'textures 默认按图谱页名填');

      // 3) 动画名候选来自服务端解析出的骨架（Idle / Death 都在里面，别的名字一个都没有）
      await page.waitForFunction(() => [...document.querySelectorAll('#form .artPanel select')]
        .some((s) => [...s.options].some((o) => o.value === 'Death')), { timeout: 10000 });
      const animNames = await page.$$eval('#form .artPanel select', (els) => [...new Set(els.flatMap((s) => [...s.options].map((o) => o.value)).filter((v) => v && !v.includes('/')))].sort());
      assert.deepEqual(animNames, ['Death', 'Idle'], 'anims 里只该有骨架里真的有的名字');
      // 角色 idle：挑一个**真的在骨架里**的名字（写错的话模型能出来但不动，而且一条日志都没有）
      const idle = await page.evaluateHandle(() => [...document.querySelectorAll('#form .artPanel label')]
        .find((l) => l.textContent === 'idle')?.parentElement.querySelector('select'));
      await idle.asElement().select('Death');

      await page.click('#form .artSave');
      const saved = await waitManifest((m) => m.art?.enemies?.[ENEMY_KEY]?.spine?.skel === 'art/hound.skel');
      const spine = saved.art.enemies[ENEMY_KEY].spine;
      assert.equal(spine.atlas, 'art/hound.atlas');
      assert.deepEqual(spine.textures, ['art/hound.png'], 'textures 没手填时保存前自动补上');
      assert.equal(spine.pma, false, '图谱没声明 pma 就写 false（清单与图谱不一致时客户端画的是错的）');
      assert.equal(spine.anims.idle, 'Death', '挑的是骨架里真的有的那个名字');
      // 原来那条声明原样留着（写一条不动另一条）
      assert.deepEqual(saved.art.enemies.enemy_ws_old_thing, { icon: 'art/icon.png' });
      assert.equal(await page.evaluate((key) => document.querySelector('#form .artDeclared').textContent.includes(key), ENEMY_KEY), true);

      // 4) 删掉**这一条**声明（业主的硬要求：写进 pack.json 的东西必须能在界面上删掉）。
      //    清单是照 `art` 的键序画的，所以按这一行的文本找按钮，别拿第一个 `.artDel`（那会删错人）。
      const delBtn = await page.evaluateHandle((key) => [...document.querySelectorAll('#form .artDeclared .row')]
        .find((row) => row.querySelector('.n')?.textContent === `enemies.${key}`)?.querySelector('.artDel'), ENEMY_KEY);
      assert.ok(delBtn.asElement(), '这一条声明在清单里要有一个删除按钮');
      await delBtn.asElement().click();
      await waitManifest((m) => !m.art?.enemies?.[ENEMY_KEY]);
      assert.ok(dialogs.some((d) => d.includes(`enemies.${ENEMY_KEY}`)), '删除前要问一次（与删除怪物同一个约定）');
      // 另一条声明不受影响
      assert.deepEqual(manifest().art.enemies.enemy_ws_old_thing, { icon: 'art/icon.png' });
      assert.deepEqual(problems, [], '整段流程里页面不该报任何错（console error / pageerror / 4xx）');
    } finally {
      await page.close();
    }
  });
});
