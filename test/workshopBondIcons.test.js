// 工坊包自带的盟约图标（docs/WORKSHOP.md §1.8）：`bondIcons: { "<bondId>": "<path inside assets/>" }`。
//
// 为什么需要它：客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图（public/js/assets.js bondIconUrl），
// 而一个包没法往 assets.json 里加条目 —— 于是新增盟约在盟约条上只能是一个圆点。这条通路让包把自己的图标
// 走 /workshop-assets（唯一那条发包素材的路由）交给客户端，做法与语音逐条相同：
// 声明写在 pack.json、文件放 assets/、叠加层并进 assets.bonds、客户端读的还是同一份清单（没有任何客户端改动）。
//
// 本文件钉住三件事：声明的形状与每一条拒绝路径、并表规则（覆盖官方 vs 新增、两个包抢同一个 id）、以及真的到达客户端。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { normalizePackManifest, applyWorkshop, workshopBondIconIndex, workshopSummary } from '../shared/workshop.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';

const norm = (extra = {}, opts = { hasAssets: true }) => normalizePackManifest(
  { id: 'my-pack', content: ['bonds'], license: 'CC0-1.0', ...extra }, 'my-pack', opts);
const refused = (extra, opts, error) => {
  const r = norm(extra, opts);
  assert.equal(r.ok, false, `${error}: expected a refusal`);
  assert.equal(r.error, error, `${error}: got ${r.error} (${r.detail})`);
  return r;
};

describe('工坊盟约图标：声明（pack.json 的 bondIcons）', () => {
  test('一个盟约一张图，路径相对 assets/', () => {
    const r = norm({ bondIcons: { myShip: 'bond/myShip.png', yanShip: 'icon/yan.png' } });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.bondIcons, { myShip: 'bond/myShip.png', yanShip: 'icon/yan.png' });
  });

  test('没有声明时是空对象（不是 undefined），包照常加载', () => {
    assert.deepEqual(norm().pack.bondIcons, {});
    assert.equal(norm().ok, true);
  });

  test('每一种写法错误都被拒（错误码要能被作者按名字找到）', () => {
    const cases = [
      [{ bondIcons: { myShip: '../secret.png' } }, { hasAssets: true }, 'BOND_ICON_PATH_UNSAFE'],
      [{ bondIcons: { myShip: '/abs.png' } }, { hasAssets: true }, 'BOND_ICON_PATH_UNSAFE'],
      [{ bondIcons: { myShip: 'a\\b.png' } }, { hasAssets: true }, 'BOND_ICON_PATH_UNSAFE'],
      [{ bondIcons: { myShip: 'C:/abs.png' } }, { hasAssets: true }, 'BOND_ICON_PATH_UNSAFE'],
      [{ bondIcons: { myShip: './ok.png' } }, { hasAssets: true }, 'BOND_ICON_PATH_UNSAFE'],
      [{ bondIcons: { myShip: '' } }, { hasAssets: true }, 'BOND_ICON_BAD_SHAPE'],
      [{ bondIcons: { myShip: 7 } }, { hasAssets: true }, 'BOND_ICON_BAD_SHAPE'],
      [{ bondIcons: { 'bad id!': 'ok.png' } }, { hasAssets: true }, 'BOND_ICON_BAD_ID'],
      [{ bondIcons: [] }, { hasAssets: true }, 'BOND_ICON_BAD_SHAPE'],
      [{ bondIcons: { myShip: 'ok.png' } }, { hasAssets: false }, 'BOND_ICON_NEEDS_ASSETS'],
    ];
    for (const [extra, opts, error] of cases) refused(extra, opts, error);
  });

  test('只带图标、没有数据文件的包也是包（content 可以为空）', () => {
    const r = normalizePackManifest(
      { id: 'icons-only', content: [], license: 'CC0-1.0', bondIcons: { myShip: 'bond/x.png' } },
      'icons-only', { hasAssets: true });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.content, []);
    // 什么都没有的包还是被拒
    assert.equal(normalizePackManifest({ id: 'x', content: [], bondIcons: {} }, 'x').error, 'EMPTY_PACK');
  });
});

/** 已加载包的替身：只带索引与并表要读的字段。 */
const pack = (id, bondIcons) => ({ id, name: id, bondIcons, files: {}, voices: {} });

describe('工坊盟约图标：并表（assets.bonds）', () => {
  const BASE = { assets: { bonds: { yanShip: '/assets/bond/yanShip.png' }, ui: { x: { p: '/assets/ui/x.png' } } } };

  test('索引给出的就是 /workshop-assets 那条路由的回答', () => {
    assert.deepEqual(workshopBondIconIndex([pack('a-pack', { myShip: 'bond/x.png' })]), {
      myShip: '/workshop-assets/a-pack/bond/x.png',
    });
    assert.deepEqual(workshopBondIconIndex([]), {});
    assert.deepEqual(workshopBondIconIndex([pack('x', {})]), {});
  });

  test('覆盖官方盟约的图标：替换它（不是追加），并且不动 assets 里别的东西', () => {
    const { data, report } = applyWorkshop(BASE, [pack('i-pack', { yanShip: 'bond/my-yan.png' })]);
    assert.equal(data.assets.bonds.yanShip, '/workshop-assets/i-pack/bond/my-yan.png');
    assert.deepEqual(data.assets.ui, BASE.assets.ui);
    assert.equal(BASE.assets.bonds.yanShip, '/assets/bond/yanShip.png', '输入不被改动');
    assert.deepEqual(report.bondIcons, { 'i-pack': ['yanShip'] });
    assert.match(workshopSummary(report), /1 bond icon/);
  });

  test('新增盟约的图标：加进去（官方图标照旧）', () => {
    const { data, report } = applyWorkshop(BASE, [pack('i-pack', { myShip: 'bond/my.png' })]);
    assert.equal(data.assets.bonds.myShip, '/workshop-assets/i-pack/bond/my.png');
    assert.equal(data.assets.bonds.yanShip, '/assets/bond/yanShip.png');
    assert.deepEqual(report.bondIcons, { 'i-pack': ['myShip'] });
  });

  test('两个包抢同一个盟约的图标：第一个赢，并且报出来（静默覆盖会变成「换个包顺序图标就变了」）', () => {
    const { data, report } = applyWorkshop(BASE, [pack('a-pack', { myShip: 'bond/a.png' }), pack('b-pack', { myShip: 'bond/b.png' })]);
    assert.equal(data.assets.bonds.myShip, '/workshop-assets/a-pack/bond/a.png');
    assert.deepEqual(report.bondIcons, { 'a-pack': ['myShip'] });
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].pack, 'b-pack');
    assert.match(report.errors[0].reason, /a-pack/);
  });

  test('没有 assets.json 的安装要报出来，而不是悄悄丢掉', () => {
    const { data, report } = applyWorkshop({}, [pack('i-pack', { myShip: 'bond/x.png' })]);
    assert.equal(data.assets, undefined);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].file, 'assets');
    assert.match(report.errors[0].reason, /assets\.json/);
  });

  test('没有图标的包不动数据、也不出现在汇总里', () => {
    const { data, report } = applyWorkshop(BASE, [{ id: 'x', name: 'X', files: {} }]);
    assert.equal(report.bondIcons, undefined);
    assert.deepEqual(data.assets, BASE.assets);
  });
});

describe('工坊盟约图标：加载器与 touched 文件（端到端）', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452STANDIN', 'latin1');
  let tmp;
  let dataDir;
  let ws;
  let srv;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-bondicon-'));
    dataDir = join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(join(dataDir, 'assets.json'), JSON.stringify({ bonds: { yanShip: '/assets/bond/yanShip.png' } }));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'icon-pack');
    fs.mkdirSync(join(dir, 'assets', 'bond'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'icon-pack', name: '图标包', version: '1.0.0', license: 'CC0-1.0',
      // 只带图标的包：content 为空，一个数据文件都不发（与「只带语音的包」同一种形状）
      content: [],
      bondIcons: { myShip: 'bond/my#icon.png', yanShip: 'bond/yan.png' },
    }));
    fs.writeFileSync(join(dir, 'assets', 'bond', 'my#icon.png'), PNG);
    fs.writeFileSync(join(dir, 'assets', 'bond', 'yan.png'), PNG);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws, dataDir });
  });
  after(async () => {
    await srv?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('加载器读出声明，并把 assets 标成需要合并发送的文件', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.packs.map((p) => p.id), ['icon-pack']);
    assert.deepEqual(loaded.packs[0].bondIcons, { myShip: 'bond/my#icon.png', yanShip: 'bond/yan.png' });
    assert.deepEqual([...workshopTouchedFiles(loaded)], ['assets']);
  });

  test('客户端读到的 assets.json 里有这两条，而且 URL 真的能取到那张图', async () => {
    const manifest = await fetch(`${srv.url}/data/assets.json`).then((r) => r.json());
    // 官方条目照旧，新增与覆盖都在（`#` 必须百分号编码，否则 URL 会在那里截断）
    assert.equal(manifest.bonds.yanShip, '/workshop-assets/icon-pack/bond/yan.png');
    assert.equal(manifest.bonds.myShip, '/workshop-assets/icon-pack/bond/my%23icon.png');
    for (const url of [manifest.bonds.yanShip, manifest.bonds.myShip]) {
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
