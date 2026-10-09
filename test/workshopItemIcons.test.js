// 工坊包自带的装备/道具图标：`itemIcons: { "<iconId>": "<path inside assets/>" }`。
//
// 为什么需要它：客户端按**道具的图标 id** 从 `data/assets.json` 的 `assets.items` 取图
// （public/js/assets.js itemIconUrl：先看 `item.iconId`、再看 `item.trapId`，然后查 `m.items[id]`），而一个包没法
// 往 assets.json 里加条目 —— 于是包新增的装备在界面上没有图标。这条通路让包把自己的图走 /workshop-assets（唯一那条
// 发包素材的路由）交给客户端，做法与盟约图标逐条相同：声明写在 pack.json、文件放 assets/、叠加层并进 assets.items、
// 客户端读的还是同一份合并后的清单（**没有任何客户端改动**）。
//
// 本文件钉住三件事：声明的形状与每一条拒绝路径、并表规则（覆盖官方 vs 新增、两个包抢同一个 id）、以及真的到达客户端。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizePackManifest, applyWorkshop, workshopItemIconIndex, workshopSummary } from '../shared/workshop.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const norm = (extra = {}, opts = { hasAssets: true }) => normalizePackManifest(
  { id: 'my-pack', content: ['items'], license: 'CC0-1.0', ...extra }, 'my-pack', opts);
const refused = (extra, opts, error) => {
  const r = norm(extra, opts);
  assert.equal(r.ok, false, `${error}: expected a refusal`);
  assert.equal(r.error, error, `${error}: got ${r.error} (${r.detail})`);
  return r;
};

describe('工坊装备图标：声明（pack.json 的 itemIcons）', () => {
  test('一件装备一张图，路径相对 assets/', () => {
    const r = norm({ itemIcons: { trap_ws_my_item: 'item/my.png', trap_ws_other: 'icon/other.png' } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.itemIcons, { trap_ws_my_item: 'item/my.png', trap_ws_other: 'icon/other.png' });
  });

  test('没有声明时是空对象（不是 undefined），包照常加载', () => {
    assert.deepEqual(norm().pack.itemIcons, {});
    assert.equal(norm().ok, true);
  });

  test('每一种写法错误都被拒（错误码要能被作者按名字找到）', () => {
    const cases = [
      [{ itemIcons: { trap_ws_a: '../secret.png' } }, { hasAssets: true }, 'ITEM_ICON_PATH_UNSAFE'],
      [{ itemIcons: { trap_ws_a: '/abs.png' } }, { hasAssets: true }, 'ITEM_ICON_PATH_UNSAFE'],
      [{ itemIcons: { trap_ws_a: 'a\\b.png' } }, { hasAssets: true }, 'ITEM_ICON_PATH_UNSAFE'],
      [{ itemIcons: { trap_ws_a: 'C:/abs.png' } }, { hasAssets: true }, 'ITEM_ICON_PATH_UNSAFE'],
      [{ itemIcons: { trap_ws_a: './ok.png' } }, { hasAssets: true }, 'ITEM_ICON_PATH_UNSAFE'],
      [{ itemIcons: { trap_ws_a: '' } }, { hasAssets: true }, 'ITEM_ICON_BAD_SHAPE'],
      [{ itemIcons: { trap_ws_a: 7 } }, { hasAssets: true }, 'ITEM_ICON_BAD_SHAPE'],
      [{ itemIcons: { 'bad id!': 'ok.png' } }, { hasAssets: true }, 'ITEM_ICON_BAD_ID'],
      [{ itemIcons: { 'also bad/': 'ok.png' } }, { hasAssets: true }, 'ITEM_ICON_BAD_ID'],
      [{ itemIcons: [] }, { hasAssets: true }, 'ITEM_ICON_BAD_SHAPE'],
      [{ itemIcons: { trap_ws_a: 'ok.png' } }, { hasAssets: false }, 'ITEM_ICON_NEEDS_ASSETS'],
    ];
    for (const [extra, opts, error] of cases) refused(extra, opts, error);
  });

  test('键的字符集与既有 record id 同一套：点、冒号、短横线与下划线都收', () => {
    const r = norm({ itemIcons: { 'trap_ws_my-item.v2:x': 'item/a.png' } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(Object.keys(r.pack.itemIcons), ['trap_ws_my-item.v2:x']);
  });

  test('只带图标、没有数据文件的包也是包（content 可以为空）', () => {
    const r = normalizePackManifest(
      { id: 'icons-only', content: [], license: 'CC0-1.0', itemIcons: { trap_ws_a: 'item/x.png' } },
      'icons-only', { hasAssets: true });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.content, []);
    // 什么都没有的包还是被拒（空对象等于没声明）
    assert.equal(normalizePackManifest({ id: 'x', content: [], itemIcons: {} }, 'x').error, 'EMPTY_PACK');
    assert.equal(normalizePackManifest({ id: 'x', content: [] }, 'x').error, 'EMPTY_PACK');
  });
});

/** 已加载包的替身：只带索引与并表要读的字段。 */
const pack = (id, itemIcons) => ({ id, name: id, itemIcons, files: {}, voices: {} });

describe('工坊装备图标：索引与并表（assets.items）', () => {
  const BASE = { assets: { items: { trap_1013_lhp: '/assets/item/trap_1013_lhp.png' }, ui: { x: { p: '/assets/ui/x.png' } } } };

  test('索引给出的就是 /workshop-assets 那条路由的回答', () => {
    assert.deepEqual(workshopItemIconIndex([pack('a-pack', { trap_ws_a: 'item/x.png' })]), {
      trap_ws_a: '/workshop-assets/a-pack/item/x.png',
    });
    assert.deepEqual(workshopItemIconIndex([]), {});
    assert.deepEqual(workshopItemIconIndex([pack('x', {})]), {});
  });

  test('URL 逐段百分号编码：`#`、空格与中文文件名都要能发出去', () => {
    const idx = workshopItemIconIndex([pack('a-pack', { trap_ws_a: 'item/my#icon.png', trap_ws_b: 'item/我 的图.png' })]);
    assert.equal(idx.trap_ws_a, '/workshop-assets/a-pack/item/my%23icon.png');
    assert.equal(idx.trap_ws_b, '/workshop-assets/a-pack/item/%E6%88%91%20%E7%9A%84%E5%9B%BE.png');
  });

  test('覆盖官方装备的图标：替换它（不是追加），并且不动 assets 里别的东西', () => {
    const { data, report } = applyWorkshop(BASE, [pack('i-pack', { trap_1013_lhp: 'item/mine.png' })]);
    assert.equal(data.assets.items.trap_1013_lhp, '/workshop-assets/i-pack/item/mine.png');
    assert.deepEqual(data.assets.ui, BASE.assets.ui);
    assert.equal(BASE.assets.items.trap_1013_lhp, '/assets/item/trap_1013_lhp.png', '输入不被改动');
    assert.deepEqual(report.itemIcons, { 'i-pack': ['trap_1013_lhp'] });
    assert.match(workshopSummary(report), /1 item icon/);
  });

  test('新增装备的图标：加进去（官方条目照旧）', () => {
    const { data, report } = applyWorkshop(BASE, [pack('i-pack', { trap_ws_my_item: 'item/my.png' })]);
    assert.equal(data.assets.items.trap_ws_my_item, '/workshop-assets/i-pack/item/my.png');
    assert.equal(data.assets.items.trap_1013_lhp, '/assets/item/trap_1013_lhp.png');
    assert.deepEqual(report.itemIcons, { 'i-pack': ['trap_ws_my_item'] });
    assert.match(workshopSummary(report), /i-pack\(i-pack\): 1 item icon/);
  });

  test('两个包抢同一件装备的图标：第一个赢（按包 id 排序），并且报出来', () => {
    // 故意把 b-pack 放在前面，胜者仍然必须是 a-pack：谁赢只取决于包 id，不取决于加载顺序
    const { data, report } = applyWorkshop(BASE, [pack('b-pack', { trap_ws_a: 'item/b.png' }), pack('a-pack', { trap_ws_a: 'item/a.png' })]);
    assert.equal(data.assets.items.trap_ws_a, '/workshop-assets/a-pack/item/a.png');
    assert.deepEqual(report.itemIcons, { 'a-pack': ['trap_ws_a'] });
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].pack, 'b-pack');
    assert.match(report.errors[0].reason, /a-pack/);
  });

  test('`assets.items` 原本不存在时**不凭空造一个空表**，而是报出来', () => {
    // assets 在、items 不在（素材流程只跑了一半）
    const a = applyWorkshop({ assets: { bonds: { x: '/assets/bond/x.png' } } }, [pack('i-pack', { trap_ws_a: 'item/x.png' })]);
    assert.equal('items' in a.data.assets, false, '不能给清单添一个它本来没有的键');
    assert.deepEqual(a.data.assets.bonds, { x: '/assets/bond/x.png' });
    assert.equal(a.report.errors.length, 1);
    assert.equal(a.report.errors[0].file, 'assets');
    assert.equal(a.report.errors[0].id, 'items');
    assert.match(a.report.errors[0].reason, /items/);
    // 连 assets.json 都没有的安装（同一个报告，不能悄悄丢）
    const b = applyWorkshop({}, [pack('i-pack', { trap_ws_a: 'item/x.png' })]);
    assert.equal(b.data.assets, undefined);
    assert.equal(b.report.errors.length, 1);
    assert.match(b.report.errors[0].reason, /assets\.json/);
  });

  test('没有图标的包不动数据、也不出现在汇总里', () => {
    const { data, report } = applyWorkshop(BASE, [{ id: 'x', name: 'X', files: {} }]);
    assert.equal(report.itemIcons, undefined);
    assert.deepEqual(data.assets, BASE.assets);
    assert.equal(workshopSummary(report), 'X(x): nothing');
  });
});

describe('工坊装备图标：加载器与 touched 文件（端到端）', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452STANDIN', 'latin1');
  let tmp;
  let dataDir;
  let ws;
  let srv;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-itemicon-'));
    dataDir = join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(join(dataDir, 'assets.json'), JSON.stringify({ items: { trap_1013_lhp: '/assets/item/trap_1013_lhp.png' } }));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'icon-pack');
    fs.mkdirSync(join(dir, 'assets', 'item'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'icon-pack', name: '图标包', version: '1.0.0', license: 'CC0-1.0',
      // 只带图标的包：content 为空，一个数据文件都不发（与「只带语音 / 只带盟约图标」同一种形状）
      content: [],
      itemIcons: { 'trap_ws_my.icon': 'item/my#icon.png', trap_1013_lhp: 'item/yan.png', trap_ws_cn: 'item/我的图.png' },
    }));
    fs.writeFileSync(join(dir, 'assets', 'item', 'my#icon.png'), PNG);
    fs.writeFileSync(join(dir, 'assets', 'item', 'yan.png'), PNG);
    fs.writeFileSync(join(dir, 'assets', 'item', '我的图.png'), PNG);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws, dataDir });
  });
  after(async () => {
    await srv?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('加载器读出声明，并把 assets 标成需要合并发送的文件', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['icon-pack']);
    assert.deepEqual(Object.keys(loaded.packs[0].itemIcons).sort(), ['trap_1013_lhp', 'trap_ws_cn', 'trap_ws_my.icon']);
    assert.deepEqual([...workshopTouchedFiles(loaded)], ['assets']);
  });

  test('客户端读到的 assets.json 里有这三条，而且 URL 真的能取到那张图', async () => {
    const manifest = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    // 官方条目被替换（覆盖官方装备那一档），两个新增 id 都在，`#` 与中文都必须百分号编码
    assert.equal(manifest.items.trap_1013_lhp, '/workshop-assets/icon-pack/item/yan.png');
    assert.equal(manifest.items['trap_ws_my.icon'], '/workshop-assets/icon-pack/item/my%23icon.png');
    assert.match(manifest.items.trap_ws_cn, /^\/workshop-assets\/icon-pack\/item\/%E6%88%91/);
    for (const url of [manifest.items.trap_1013_lhp, manifest.items['trap_ws_my.icon'], manifest.items.trap_ws_cn]) {
      const res = await fetch(srv.url + url);
      assert.equal(res.status, 200, `${url} 必须真的取得到 —— 这就是整条线路`);
      assert.match(res.headers.get('content-type') || '', /image\/png/);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    }
  });

  test('只带图标的包让 assets 成为唯一需要合并的数据文件', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    const data = loadData(dataDir, { log: quiet, workshopDir: ws });
    assert.deepEqual([...buildWorkshopDataFiles(data, loaded).keys()], ['assets']);
  });
});

describe('工坊装备图标：作者侧校验（tools/workshop-validate.mjs）', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452STANDIN', 'latin1');
  let tmp;
  let ws;

  before(() => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-itemicon-val-'));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'icon-pack');
    fs.mkdirSync(join(dir, 'assets', 'item'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'icon-pack', name: '图标包', version: '1.0.0', license: 'CC0-1.0', content: ['items'],
      itemIcons: {
        trap_1041_acarm041: 'item/yan.png',   // 官方道具的图标（覆盖；id 取自 data/items.json 真的有的那批）
        trap_ws_mine: 'item/mine.png',       // 本包 items.json 里那件装备的图标
        trap_ws_ghost: 'item/ghost.png',     // 谁也不用的 id → warning
        trap_1047_acarm047: 'item/nope.png', // 官方 id，但文件不在盘上 → error
        trap_1066_acarm066: 'item/model.txt', // 官方 id，但包路由不发这个类型 → error
      },
    }));
    fs.writeFileSync(join(dir, 'items.json'), JSON.stringify({
      chess_item_ws_mine_a: { id: 'chess_item_ws_mine_a', name: '自制装备', itemType: 'EQUIP', tier: 3, price: 8, isGolden: false, iconId: 'trap_ws_mine', trapId: 'trap_ws_mine', buffs: [], params: {}, mergeable: false, duration: -1, rangeGrid: [[0, 0]], shopExcluded: false },
    }));
    fs.writeFileSync(join(dir, 'assets', 'item', 'yan.png'), PNG);
    fs.writeFileSync(join(dir, 'assets', 'item', 'mine.png'), PNG);
    fs.writeFileSync(join(dir, 'assets', 'item', 'ghost.png'), PNG);
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  const run = () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), ws, '--json'], { encoding: 'utf8', timeout: 60_000 });
    assert.ok(r.stdout, r.stderr);
    return JSON.parse(r.stdout);
  };

  test('文件真的在盘上、扩展名在白名单里，各出一条 error', () => {
    const report = run();
    const codes = report.packs[0].issues.map((i) => `${i.code} ${i.field}`);
    assert.ok(codes.includes('ITEM_ICON_FILE_MISSING itemIcons.trap_1047_acarm047'), `got ${JSON.stringify(codes)}`);
    assert.ok(codes.includes('ITEM_ICON_TYPE_UNSERVABLE itemIcons.trap_1066_acarm066'), `got ${JSON.stringify(codes)}`);
    assert.equal(report.packs[0].issues.find((i) => i.code === 'ITEM_ICON_FILE_MISSING').severity, 'error');
  });

  test('官方道具的 id 与本包新增的 id 都不报；谁也不用的 id 是一条 warning', () => {
    const report = run();
    const warned = report.packs[0].issues.filter((i) => i.code === 'ITEM_ICON_UNKNOWN_ITEM');
    assert.deepEqual(warned.map((i) => i.field), ['itemIcons.trap_ws_ghost'], '只有没人用的那个 id 该被点名');
    assert.equal(warned[0].severity, 'warning');
    assert.ok(!report.packs[0].issues.some((i) => i.code.startsWith('ITEM_ICON') && /trap_1041_acarm041|trap_ws_mine/.test(i.field)), '官方 id 与本包自己的 id 都是合法的');
  });

  test('判定用的「官方道具 id」就是官方素材清单 `assets.items` 的键（这一层不许自己编一套）', () => {
    const official = JSON.parse(fs.readFileSync(join(DATA_DIR, 'assets.json'), 'utf8')).items || {};
    assert.ok(Object.hasOwn(official, 'trap_1041_acarm041'), '用例里那个官方 id 必须真的在清单里');
    assert.equal(Object.hasOwn(official, 'trap_1013_lhp'), false, '只在测试里出现过的 id 不是官方道具');
  });

  test('报告里写清楚这个包带了几张图标，并且加载器接受这种「只带图标」的包', () => {
    const report = run();
    assert.equal(report.itemIcons, 5);
    assert.equal(report.packs[0].itemIcons, 5);
    assert.ok(report.errors >= 2, '两条 error 要计入总数');
    const text = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), ws], { encoding: 'utf8', timeout: 60_000 }).stdout;
    assert.match(text, /5 item icon\(s\)/);
  });
});
