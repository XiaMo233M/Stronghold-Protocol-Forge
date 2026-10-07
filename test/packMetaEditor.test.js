// test/packMetaEditor.test.js — 编辑器里 `pack.json` 的**元数据与 overrides** 图形入口（包管理页那一块）。
//
// 这一块补的是编辑器唯一一处仍然要求作者手改 `pack.json` 的地方，所以断言的不是「字段写进去了」，而是三件事：
//
//   1. **license 必须先能填**：一个有 `assets/` 的包（语音/图标/外观素材都要它）不声明 license 会被加载器整包拒绝，
//      而素材端点在那种状态下全部拒绝写入 —— 于是「填 license」这条路必须存在，且清空它必须被当场拦住；
//   2. **只动传进来的键**：其余字段、键序原样保留，内容没变就一个字节都不写；空串/null = 删掉那个键（不是写成
//      空字符串）；
//   3. **overrides 能被增、也能被删**（含官方没有的、或本包没那条记录的陈旧声明），而且**声明之后覆盖真的生效**：
//      包带了官方 id 的记录时，加载器不再把它整条丢掉 —— 业主的硬约束是任何写进 `pack.json` 的条目都要能在界面上
//      增删改，而不是「只让你删在用的那条」。
//
// 覆盖的判定在 `applyWorkshop`（`loadWorkshop` 只管清单与文件），所以这里按 test/workshop.test.js 的同一方式调用它。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { loadWorkshop } from '../server/workshop.js';
import { applyWorkshop, normalizePackManifest } from '../shared/workshop.js';
import { PACK_META_FIELDS, LICENSE_CHOICES } from '../tools/workshop-pack.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** 每个拒绝都必须是一句中文界面能用的话，而不是英文调试串。 */
const isChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s));

/** 官方干员表：`applyWorkshop` 的「官方已有这个 id」就是拿它比的。 */
const OFFICIAL_CHESS = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));

let tmp;
let wsRoot;
let editor;

const packDir = (id) => join(wsRoot, id);
const manifestText = (id) => fs.readFileSync(join(packDir(id), 'pack.json'), 'utf8');
const manifest = (id) => JSON.parse(manifestText(id));
const writePack = (id, raw, files = {}) => {
  fs.mkdirSync(packDir(id), { recursive: true });
  fs.writeFileSync(join(packDir(id), 'pack.json'), raw);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(packDir(id), ...rel.split('/'));
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
};
/** 加载器这一侧的结论：`applyWorkshop` 的合并结果与报告（`overrides` 是不是真的生效，看的就是这里）。 */
const applyMerged = () => applyWorkshop({ chess: OFFICIAL_CHESS }, loadWorkshop(wsRoot, { log: quiet }).packs);
/** 一个包此刻的元数据状态（GET 那条路上给的形状）。 */
const metaOf = async (id) => (await fetch(`${editor.url}/api/packs/support`).then((r) => r.json())).meta[id];

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-pack-meta-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });

  // 一个「编辑器建的」包：正是干员页第一次保存写下的形状（license 为 null），外加一个 assets/（语音 + 外观素材）
  writePack('fresh', `${JSON.stringify({
    id: 'fresh', name: '编辑器建的包', version: '0.1.0', author: '水沫沐沐', license: null,
    description: null, gameVersion: '0.1.3', content: ['chess'],
  }, null, 2)}\n`, {
    'chess.json': `${JSON.stringify({ chess_ws_fresh_a: { chessId: 'chess_ws_fresh_a', name: '新干员', tier: 4 } }, null, 2)}\n`,
    'assets/voice/select1.mp3': 'ID3\x03\x00\x00\x00MP3-STANDIN',
    // 一张真的存在的图片：否则「写外观被拒」会在更早的一步（文件不存在）就失败，测不到 license 那道门
    'assets/art/avatar.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });

  // 一个手写排版的包 + 一条 overrides：证明写元数据不会重排别人的文件
  writePack('handmade', '{\n    "id": "handmade",\n    "name": "手写排版",\n    "version": "2.0.0",\n    "license": "CC0-1.0",\n    "content": ["items", "chess"],\n    "overrides": ["items:chess_item_1_01_e_a"]\n}\n', {
    'items.json': `${JSON.stringify({ item_ws_handmade_a: { id: 'item_ws_handmade_a', name: '自己的装备' } }, null, 2)}\n`,
    // 先放一条自己的记录；「覆盖官方记录」那条用例会把它换成一条官方 id 的记录
    'chess.json': `${JSON.stringify({ chess_ws_handmade_a: { chessId: 'chess_ws_handmade_a', name: '自己的干员', tier: 4 } }, null, 2)}\n`,
  });

  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', dataDir: DATA_DIR, supportFile: join(tmp, 'support.json') });
});
after(async () => {
  await editor?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('包元数据：读（GET /api/packs/support 的 meta 与候选）', () => {
  test('每个包都给一份 meta、可编辑字段清单与 license 候选', async () => {
    const body = await fetch(`${editor.url}/api/packs/support`).then((r) => r.json());
    assert.deepEqual(body.meta.fresh.metaFields, PACK_META_FIELDS);
    assert.deepEqual(body.meta.fresh.licenseChoices, LICENSE_CHOICES);
    assert.equal(body.meta.fresh.meta.name, '编辑器建的包');
    // license 为 null：页面要把它当成「没填」而不是空字符串（加载器对这几个字段各有默认值）
    assert.equal(body.meta.fresh.meta.license, null);
    assert.equal(body.meta.fresh.hasAssets, true);
    // 有 assets/ 又没 license → 加载器会整包拒绝，页面要能看到这件事
    assert.equal(body.meta.fresh.ok, false);
    assert.equal(body.meta.fresh.issue.code, 'ASSETS_NEED_LICENSE');
  });

  test('overrides 的候选是官方每张表的 id + 名字（作者不必记住 chess_char_1_01_a 这种字符串）', async () => {
    const body = await fetch(`${editor.url}/api/packs/support`).then((r) => r.json());
    const chess = body.overrideCandidates.chess;
    assert.ok(Array.isArray(chess) && chess.length > 100);
    const row = chess.find(([id]) => id === 'chess_char_1_01_a');
    assert.ok(row, '官方干员必须在候选里');
    assert.ok(row[1], '候选要带官方名字');
    assert.ok(Array.isArray(body.overrideCandidates.items));
    assert.ok(!Object.hasOwn(body.overrideCandidates, 'config'), 'config 不是包能声明的数据文件');
  });

  test('声明的 overrides 列出「本包有没有那条记录」与「官方有没有这个 id」（两者都不是错误）', async () => {
    const meta = await metaOf('handmade');
    assert.deepEqual(meta.overrides.map((o) => [o.entry, o.inUse, o.official]), [['items:chess_item_1_01_e_a', false, true]]);
  });
});

describe('包元数据：写（POST /api/packs/<id>/meta）', () => {
  test('填上 license 之后包立刻变成加载器会接受的包（而素材端点此前一律拒绝写入）', async () => {
    const before = await post(`${editor.url}/api/packs/fresh/art`, { table: 'chars', id: 'char_ws_fresh', art: { avatar: 'art/avatar.png' } });
    assert.equal(before.status, 400, '缺 license 时写外观素材会被拒');
    assert.match((await before.json()).error, /ASSETS_NEED_LICENSE/);

    const res = await post(`${editor.url}/api/packs/fresh/meta`, { license: 'CC0-1.0' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.changed, true);
    assert.equal(body.meta.license, 'CC0-1.0');
    assert.equal(body.issue, null, '现在加载器接受这个包');
    assert.deepEqual(loadWorkshop(wsRoot, { log: quiet }).errors, []);
    assert.deepEqual(applyMerged().report.errors, []);
    // 加载器真的把 license 读出来了（不是只有编辑器自己以为写了）
    assert.equal(normalizePackManifest(manifest('fresh'), 'fresh', { hasAssets: true }).pack.license, 'CC0-1.0');
  });

  test('只动传进来的键：其余字段与键序原样保留（已存在的键留在原位）', async () => {
    const beforeObj = manifest('fresh');
    const res = await post(`${editor.url}/api/packs/fresh/meta`, { description: '包管理页写的说明' });
    assert.equal(res.status, 200);
    const afterText = manifestText('fresh');
    const afterObj = JSON.parse(afterText);
    assert.deepEqual(Object.keys(afterObj), Object.keys(beforeObj), '键序一字不动（description 本来就在清单里）');
    assert.equal(afterObj.description, '包管理页写的说明');
    assert.equal(afterObj.author, beforeObj.author, '没传的字段一字不动');
    assert.equal(afterObj.version, beforeObj.version);
    assert.match(afterText, /\n  "description": "包管理页写的说明",/, '两空格缩进');
    assert.equal(afterText.endsWith('}\n'), true, '结尾换行还在');
  });

  test('内容没变就不写盘：同一个值再发一次既不 reformat 也不改一个字节', async () => {
    // handmade 是作者手写的 4 空格排版：一次**没有变化**的写请求必须留下完全相同的字节
    const before = manifestText('handmade');
    assert.match(before, /\n    "name": "手写排版",/, '手写排版确实还在（这条断言的前提）');
    const res = await post(`${editor.url}/api/packs/handmade/meta`, { name: '手写排版' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).changed, false);
    assert.equal(manifestText('handmade'), before, '没有变化就不碰文件');
  });

  test('新键追加在末尾；空串 / null 再把它删掉（而不是写成一个空字符串）', async () => {
    const added = await post(`${editor.url}/api/packs/handmade/meta`, { description: '手写包的说明', gameVersion: '0.2.0' });
    assert.equal(added.status, 200);
    assert.deepEqual(Object.keys(manifest('handmade')).slice(-2), ['description', 'gameVersion'], '新键追加在末尾');
    assert.match(manifestText('handmade'), /\n  "description": "手写包的说明",/, '两空格缩进');

    const cleared = await post(`${editor.url}/api/packs/handmade/meta`, { description: null, gameVersion: '   ' });
    assert.equal(cleared.status, 200);
    const obj = manifest('handmade');
    assert.ok(!Object.hasOwn(obj, 'description'), 'null = 删掉这个键');
    assert.ok(!Object.hasOwn(obj, 'gameVersion'), '空串 = 删掉这个键');
    assert.deepEqual(Object.keys(obj).slice(-1), ['overrides'], '其余键序不变');
  });

  test('有 assets/ 就不许把 license 清空：当场拒绝，文件一个字节都不写', async () => {
    const before = manifestText('fresh');
    const res = await post(`${editor.url}/api/packs/fresh/meta`, { license: '' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /ASSETS_NEED_LICENSE/);
    const nulled = await post(`${editor.url}/api/packs/fresh/meta`, { license: null });
    assert.equal(nulled.status, 400);
    assert.ok(isChinese((await nulled.json()).error));
    assert.equal(manifestText('fresh'), before, '拒绝不留半成品');
  });

  test('不认识的字段、非字符串的值、超长的值都被拒（写下去的清单必须仍是加载器接受的那一份）', async () => {
    assert.equal((await post(`${editor.url}/api/packs/fresh/meta`, { id: 'other' })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/fresh/meta`, { name: { x: 1 } })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/fresh/meta`, { name: 'x'.repeat(400) })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/fresh/meta`, {})).status, 400, '一个字段都没给');
    assert.equal((await post(`${editor.url}/api/packs/nope/meta`, { name: 'x' })).status, 404);
    const obj = manifest('fresh');
    assert.equal(obj.name, '编辑器建的包', '拒绝之后什么都没变');
    assert.equal(normalizePackManifest(obj, 'fresh', { hasAssets: true }).ok, true, '写出来的清单加载器照旧接受');
  });

  test('name 与 version 也能改（它们是作者自己的版本号，加载器只管「非空字符串」）', async () => {
    const res = await post(`${editor.url}/api/packs/fresh/meta`, { name: '改过名的包', version: '3.1.4' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.changed, true);
    assert.deepEqual([body.meta.name, body.meta.version], ['改过名的包', '3.1.4']);
    const again = await post(`${editor.url}/api/packs/fresh/meta`, { name: '改过名的包' });
    assert.equal((await again.json()).changed, false);
  });
});

describe('包 overrides：写（POST /api/packs/<id>/overrides）', () => {
  test('加一条覆盖官方的声明：整表替换、排序去重，且只动这一个字段', async () => {
    const beforeObj = manifest('handmade');
    const res = await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: ['chess:chess_char_1_01_a', 'items:chess_item_1_01_e_a', 'items:chess_item_1_01_e_a'] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.changed, true);
    assert.deepEqual(body.overrides.map((o) => o.entry), ['chess:chess_char_1_01_a', 'items:chess_item_1_01_e_a'], '排序 + 去重');
    const afterObj = manifest('handmade');
    assert.deepEqual(Object.keys(afterObj), Object.keys(beforeObj), '键序一字不动');
    assert.equal(afterObj.license, beforeObj.license);
    // 写盘是按 2 空格重新序列化的（与 writePackSupport 同一条规则）：字段值不变，缩进归编辑器管
    assert.match(manifestText('handmade'), /\n  "content": \[\n    "items",/, '两空格缩进');
    assert.equal(afterObj.items, undefined, '写 overrides 不碰 data 文件');
  });

  test('覆盖一条官方记录真的生效：包带了官方 id 的记录，加载器不再把它整条丢掉', async () => {
    // 先撤掉 chess 那条声明，再放一条官方 id 的记录：不带 overrides 时加载器整条拒绝 —— 这正是作者需要这一块的原因
    await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: ['items:chess_item_1_01_e_a'] });
    const hostile = { chess_char_1_01_a: { chessId: 'chess_char_1_01_a', name: '被改过的官方干员', tier: 4 } };
    fs.writeFileSync(join(packDir('handmade'), 'chess.json'), `${JSON.stringify(hostile, null, 2)}\n`);
    const bare = applyMerged();
    assert.ok(bare.report.errors.some((e) => e.pack === 'handmade' && /overrides/.test(String(e.reason))), JSON.stringify(bare.report.errors));
    assert.equal(bare.data.chess.chess_char_1_01_a.name, OFFICIAL_CHESS.chess_char_1_01_a.name, '没声明就还是官方那条');

    // 声明之后：合并报告里没有错误，而且官方那条真的被换掉了
    const declared = await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: ['chess:chess_char_1_01_a', 'items:chess_item_1_01_e_a'] });
    assert.equal(declared.status, 200);
    const ok = applyMerged();
    assert.deepEqual(ok.report.errors, []);
    assert.deepEqual(ok.report.overridden.chess, ['chess_char_1_01_a']);
    assert.equal(ok.data.chess.chess_char_1_01_a.name, '被改过的官方干员');
    // 「在用」现在也变成 true（页面靠它标出陈旧声明）
    assert.deepEqual((await metaOf('handmade')).overrides.map((o) => [o.entry, o.inUse]), [
      ['chess:chess_char_1_01_a', true], ['items:chess_item_1_01_e_a', false],
    ]);
  });

  test('清空整表：删到最后一条时连 overrides 这个键一起收掉（那条覆盖也随之失效）', async () => {
    const res = await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: [] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).changed, true);
    assert.ok(!Object.hasOwn(manifest('handmade'), 'overrides'));
    // 官方那条记录随声明一起失效（加载器重新拒绝它）—— 这是删除的**后果**，不是错误，页面要能解释
    assert.ok(applyMerged().report.errors.some((e) => e.pack === 'handmade' && /overrides/.test(String(e.reason))), '删掉声明之后那条覆盖不再生效');
    // 再删一次：已经没有这个键，不写盘
    assert.equal((await (await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: [] })).json()).changed, false);
    assert.ok(!Object.hasOwn(manifest('handmade'), 'overrides'));
  });

  test('形状不合法的声明被拒（与加载器同一份正则、同一份文件清单），且文件不动', async () => {
    const before = manifestText('handmade');
    for (const bad of [['chess'], ['chess:'], ['chess:bad id'], ['nope:thing'], [42], 'not-an-array']) {
      const res = await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.ok(isChinese((await res.json()).error));
    }
    assert.equal(manifestText('handmade'), before);
  });

  test('官方没有的 id、本包没有那条记录的 id 都照收（它们只是不生效，界面必须能删掉）', async () => {
    const res = await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: ['chess:not_an_official_id', 'items:chess_item_1_01_e_a'] });
    assert.equal(res.status, 200);
    const rows = (await res.json()).overrides;
    assert.deepEqual(rows.map((o) => [o.entry, o.official, o.inUse]), [
      ['chess:not_an_official_id', false, false],
      ['items:chess_item_1_01_e_a', true, false],
    ]);
    // 删掉那一批：删除永远不被「有没有在用」挡住（业主的硬约束）
    const cleared = await post(`${editor.url}/api/packs/handmade/overrides`, { overrides: [] });
    assert.equal(cleared.status, 200);
    assert.ok(!Object.hasOwn(manifest('handmade'), 'overrides'));
  });
});
