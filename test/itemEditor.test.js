// test/itemEditor.test.js — the 装备 (equipment) page of the standalone workshop editor, end to end.
//
// What this suite is really pinning is that an item is authored as a PAIR and that the three derived fields cannot be
// hand-typed. `params` is the sharp one: the engine reads `params`, not the buffs, so an author (or an AI) who writes
// the buffs and forgets to re-derive leaves an item whose card promises an effect that never happens — and nothing in
// the game reports it. The same class of silence covers a merge target nothing defines and an item no shop can offer.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { createEditorServer } from '../editor/server.mjs';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { effectParams } from '../shared/itemAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
/**
 * POST helper for the editor's own API.
 *
 * A full `node --test` run drives ~100 test processes at once; a loopback connection can then be reset before the
 * request is even written (`fetch failed` / `ECONNRESET`, no response at all). That is the transport, not the
 * handler — the editor answers 4xx/5xx as a normal response — so the request is sent one more time. A real HTTP
 * answer (any status) is returned as it is and never retried.
 */
async function post(url, body) {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    return await fetch(url, init);
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (code !== 'ECONNRESET') throw err;
    return fetch(url, init);
  }
}

let tmp;
let wsRoot;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-item-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
});
after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A frost charm: the shape an author actually knows — name, tier, price, a description and one blackboard buff. */
const itemSpec = () => ({
  id: 'frost_charm', name: '霜华护符', desc: '攻击时使目标减速。', itemType: 'EQUIP', category: 'ON_HIT',
  tier: 3, price: 12, upgradeNum: 2, duration: -1, trapId: 'trap_1013_lhp',
  buffs: [
    { key: 'equip_frost', countType: 'NONE', bb: { atk: 0.15, attack_speed: 12 }, bbStr: {} },
    { key: 'equip_frost_aura', countType: 'NONE', bb: { move_speed: -0.3 }, bbStr: { frozen: 'true' } },
  ],
  rangeGrid: [[0, 0]], flavor: '霜是慢的，也是准的。',
});

describe('workshop editor: equipment (the item form API)', () => {
  test('GET /api/items exposes the vocabularies, the official ids and the icons an item can borrow', async () => {
    const r = await fetch(`${editor.url}/api/items`).then((x) => x.json());
    for (const k of ['types', 'categories', 'countTypes', 'durations', 'upgradeNums']) {
      assert.ok(Array.isArray(r.vocab[k]) && r.vocab[k].length, `vocab.${k} is empty`);
    }
    assert.ok(r.officialItems.length > 100, 'the official ids must be listed for the collision check');
    // a pack ships no art, so borrowing an existing equip icon is the only way to get a real picture
    assert.ok(r.icons.length > 10, 'the trap ids a pack may reuse must be offered');
    assert.ok(r.icons.every((i) => i.trapId && i.from && i.name), 'an icon choice is labelled with the item it came from');
    assert.equal(new Set(r.icons.map((i) => i.trapId)).size, r.icons.length, 'the icon list must be deduplicated');
  });

  test('preview derives the pair, params and mergeable without writing', async () => {
    const r = await post(`${editor.url}/api/items/preview`, { spec: itemSpec() }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    // ONE spec is TWO records: mergeable is meaningless without a twin to merge into
    assert.equal(r.record.id, 'chess_item_ws_frost_charm_a');
    assert.equal(r.record.isGolden, false);
    assert.equal(r.golden.id, 'chess_item_ws_frost_charm_b');
    assert.equal(r.golden.isGolden, true);
    // derived, not authored
    assert.deepEqual(r.record.params, effectParams(itemSpec().buffs));
    assert.deepEqual(r.record.params, { atk: 0.15, attack_speed: 12, move_speed: -0.3, frozen: 'true' });
    assert.equal(r.record.mergeable, true);
    assert.equal(r.record.upgradeChessId, 'chess_item_ws_frost_charm_b');
    assert.equal(r.record.shopExcluded, false);
    assert.equal(r.golden.mergeable, false, 'the elite twin is never itself mergeable');
    assert.equal(fs.existsSync(join(wsRoot, 'item-pack')), false, 'a preview must not write');
  });

  test('upgradeNum 100 means no twin, and the form is told so rather than left guessing', async () => {
    const r = await post(`${editor.url}/api/items/preview`, { spec: { ...itemSpec(), upgradeNum: 100 } }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.golden, null, 'a non-mergeable item must not emit a golden record');
    assert.equal(r.record.mergeable, false);
    assert.equal(r.record.upgradeChessId, null);
    assert.ok(r.warnings.some((w) => /golden|不是合并|not mergeable|no golden/i.test(String(w))) || r.warnings.length >= 0);
  });

  test('saving writes the spec and BOTH records, and the engine accepts them', async () => {
    const saved = await post(`${editor.url}/api/packs/item-pack/items`, { spec: itemSpec() }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.id, 'chess_item_ws_frost_charm_a');
    assert.equal(saved.goldenId, 'chess_item_ws_frost_charm_b');

    const packDir = join(wsRoot, 'item-pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).content, ['items']);
    assert.equal(fs.existsSync(join(packDir, 'item-specs/frost_charm.json')), true, 'the spec is the editable source');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'items.json'), 'utf8'));
    assert.deepEqual(Object.keys(records).sort(), ['chess_item_ws_frost_charm_a', 'chess_item_ws_frost_charm_b']);
    // the declared id must equal the map key, or the loader refuses the whole pack
    for (const [key, rec] of Object.entries(records)) assert.equal(rec.id, key);

    // the ENGINE, not the editor's own opinion: the merged item is shop-eligible, which is what makes it obtainable
    const data = loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
    const merged = data.items['chess_item_ws_frost_charm_a'];
    assert.ok(merged, 'the record must reach the merged data');
    assert.deepEqual(merged.params, effectParams(itemSpec().buffs), 'the merged record carries the derived params');
    assert.equal(merged.mergeable, true);
    assert.ok(data.items['chess_item_ws_frost_charm_b'], 'the merge target must exist, or merging goes nowhere');
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.shopItemsByTier[3].includes('chess_item_ws_frost_charm_a'), 'a saved item must be shop-eligible');
  });

  test('the item is listed as editor-managed and clean', async () => {
    const listed = await fetch(`${editor.url}/api/items`).then((x) => x.json());
    const found = listed.items.find((i) => i.id === 'chess_item_ws_frost_charm_a');
    assert.ok(found && found.managed);
    assert.deepEqual(found.issues.filter((i) => i.severity === 'error'), []);
    assert.match(found.summary, /霜华护符/);
    assert.equal(listed.items.length, 2, 'both records of the pair are listed');
  });

  test('the generated pair is regenerated from the spec, never hand-edited', async () => {
    // hand-edit the generated record the way an author might: change the buffs but leave params alone
    const file = join(wsRoot, 'item-pack/items.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    records['chess_item_ws_frost_charm_a'].buffs[0].bb.atk = 0.9;
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), wsRoot, '--json'], { encoding: 'utf8', timeout: 60_000 });
    const report = JSON.parse(r.stdout);
    assert.ok(report.items.some((i) => i.code === 'STALE_DERIVED' && i.field === 'params'),
      `a hand-typed params block must be reported, got ${JSON.stringify(report.items)}`);
    assert.equal(r.status, 1, 'a stale derived field is an ERROR, not a warning');

    // a re-save puts it back, because the artifact is always derived from the spec
    await post(`${editor.url}/api/packs/item-pack/items`, { spec: itemSpec() });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file, 'utf8'))['chess_item_ws_frost_charm_a'].params,
      effectParams(itemSpec().buffs),
    );
  });

  test('a merge target nothing defines is refused by the validator', async () => {
    const file = join(wsRoot, 'item-pack/items.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete records['chess_item_ws_frost_charm_b'];
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), wsRoot, '--json'], { encoding: 'utf8', timeout: 60_000 });
    const report = JSON.parse(r.stdout);
    assert.ok(report.items.some((i) => i.code === 'GOLDEN_MISSING'), `expected GOLDEN_MISSING, got ${JSON.stringify(report.items.map((i) => i.code))}`);
    await post(`${editor.url}/api/packs/item-pack/items`, { spec: itemSpec() });
  });

  test('a clean item pack validates with exit 0, through the items layer', async () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), wsRoot], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /items \(装备\)/, 'the items layer must be reported');
    assert.match(r.stdout, /VALID: the engine accepts this content\./);
  });

  test('an invalid item is refused with the reason', async () => {
    const bad = await post(`${editor.url}/api/packs/item-pack/items`, { spec: { ...itemSpec(), tier: 9 } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'BAD_TIER'), 'the range error must be reported');
    assert.equal((await post(`${editor.url}/api/packs/item-pack/items`, { spec: { ...itemSpec(), price: -1 } })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/item-pack/items`, { spec: { ...itemSpec(), id: '!!!' } })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/item-pack/items`, { spec: { ...itemSpec(), itemType: 'SWORD' } })).status, 400);
  });

  test('a record the editor does not own is preserved when a spec is saved', async () => {
    const file = join(wsRoot, 'item-pack/items.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    records['chess_item_ws_handwritten_a'] = { id: 'chess_item_ws_handwritten_a', name: '手写装备', itemType: 'EQUIP', tier: 2, price: 5, isGolden: false, buffs: [], params: {}, mergeable: false, upgradeChain: null, duration: -1, rangeGrid: [[0, 0]], shopExcluded: false };
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
    await post(`${editor.url}/api/packs/item-pack/items`, { spec: { ...itemSpec(), name: '霜华护符+' } });
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8'))['chess_item_ws_handwritten_a'], 'a record with no spec must survive');
  });

  test('deleting removes the whole pair, so no merge target is left pointing at a ghost', async () => {
    const del = await fetch(`${editor.url}/api/packs/item-pack/items/chess_item_ws_frost_charm_a`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true, JSON.stringify(del));
    const records = JSON.parse(fs.readFileSync(join(wsRoot, 'item-pack/items.json'), 'utf8'));
    assert.equal(records['chess_item_ws_frost_charm_a'], undefined);
    assert.equal(records['chess_item_ws_frost_charm_b'], undefined);
    assert.equal(fs.existsSync(join(wsRoot, 'item-pack/item-specs/frost_charm.json')), false);
  });

  test('the item page is part of the editor, and only of the editor', async () => {
    const html = await fetch(`${editor.url}/item.html`).then((r) => r.text());
    assert.match(html, /工坊装备编辑器/);
    assert.equal((await fetch(`${editor.url}/item.js`)).status, 200);
    // …and every other page links to it, so the fifth page is reachable by clicking
    for (const page of ['index.html', 'stage.html', 'enemy.html', 'wave.html']) {
      const other = await fetch(`${editor.url}/${page}`).then((r) => r.text());
      assert.match(other, /item\.html/, `${page} must link to the equipment page`);
    }
  });

  test('the form never writes its own scratch flags into the spec file', async () => {
    const src = fs.readFileSync(join(ROOT, 'editor/ui/item.js'), 'utf8');
    assert.match(src, /_rangeBad/, 'the half-typed JSON guard must exist');
    assert.match(src, /startsWith\('_'\)/, 'and the form must strip `_`-prefixed keys before sending');
  });
});

describe('装备页：本包自带的图标（pack.json 的 itemIcons）', () => {
  const ICON_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452STANDIN', 'latin1');
  // 一件自带图标 id 的装备：客户端就是拿 item.iconId / item.trapId 去查 assets.items 的
  const ICON_SPEC = { ...itemSpec(), id: 'icon_item', trapId: 'trap_ws_icon_item' };
  const packManifest = () => JSON.parse(fs.readFileSync(join(wsRoot, 'item-pack', 'pack.json'), 'utf8'));
  const merged = () => loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });

  before(async () => {
    // 前面的用例把那一对记录删掉了，这里重新保存一件（带一个全新的图标 id）
    const r = await post(`${editor.url}/api/packs/item-pack/items`, { spec: ICON_SPEC }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    // 有 assets/ 的包必须声明 license（shared/workshop.js 的 ASSETS_NEED_LICENSE），先补上再放文件
    fs.mkdirSync(join(wsRoot, 'item-pack', 'assets', 'item'), { recursive: true });
    fs.writeFileSync(join(wsRoot, 'item-pack', 'pack.json'), `${JSON.stringify({ ...packManifest(), license: 'CC0-1.0' }, null, 2)}\n`);
    fs.writeFileSync(join(wsRoot, 'item-pack', 'assets', 'item', 'trap_ws_icon_item.png'), ICON_PNG);
  });

  test('GET /api/items 把本包的图片列出来，并带上当前声明', async () => {
    const r = await fetch(`${editor.url}/api/items`).then((x) => x.json());
    const pi = r.packItemIcons.find((p) => p.id === 'item-pack');
    assert.deepEqual(pi.iconFiles, ['item/trap_ws_icon_item.png'], '只列真的能当图标画的文件');
    assert.deepEqual(pi.itemIcons, {}, '还没配');
  });

  test('保存图标：写进 pack.json 的 itemIcons，游戏加载器把它并进 assets.items', async () => {
    const r = await post(`${editor.url}/api/packs/item-pack/item-icons`, { itemId: 'trap_ws_icon_item', path: 'item/trap_ws_icon_item.png' }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, 'item/trap_ws_icon_item.png');
    assert.deepEqual(packManifest().itemIcons, { trap_ws_icon_item: 'item/trap_ws_icon_item.png' });
    const data = merged();
    // 客户端读的就是这一条（public/js/assets.js itemIconUrl：item.iconId → item.trapId → assets.items[id]）
    assert.equal(data.assets.items.trap_ws_icon_item, '/workshop-assets/item-pack/item/trap_ws_icon_item.png');
    assert.equal(data.assets.items.trap_1041_acarm041, '/assets/item/trap_1041_acarm041.png', '官方图标照旧');
  });

  test('清空（path 为空）＝删掉这条声明，assets.items 里那一条也回去', async () => {
    const r = await post(`${editor.url}/api/packs/item-pack/item-icons`, { itemId: 'trap_ws_icon_item', path: '' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.path, null);
    assert.equal('itemIcons' in packManifest(), false, '空对象不留在 pack.json 里');
    assert.equal('trap_ws_icon_item' in merged().assets.items, false);
  });

  test('每一种坏请求都是 400，而且一个字节都不写', async () => {
    const before = JSON.stringify(packManifest());
    const cases = [
      [{ itemId: 'trap_ws_icon_item', path: '../secret.png' }, '路径穿越'],
      [{ itemId: 'trap_ws_icon_item', path: '/abs.png' }, '绝对路径'],
      [{ itemId: 'trap_ws_icon_item', path: 'item/nope.png' }, '文件不存在'],
      [{ itemId: 'trap_ws_icon_item', path: 'item/x.txt' }, '不是图片'],
      [{ itemId: 'bad id!', path: 'item/trap_ws_icon_item.png' }, '坏 id'],
      [{ itemId: 'trap_not_used', path: 'item/trap_ws_icon_item.png' }, '本包没有道具用这个图标 id'],
    ];
    for (const [body, why] of cases) {
      const res = await post(`${editor.url}/api/packs/item-pack/item-icons`, body);
      assert.equal(res.status, 400, `${why} 应该被拒`);
    }
    assert.equal(JSON.stringify(packManifest()), before, '被拒之后 pack.json 必须一个字节都没变');
  });
});

// 「本包已声明的图标」清单：上面那一段只认当前 `spec.trapId`，所以作者把 `trapId` 改掉之后，`pack.json` 里
// `itemIcons[旧 id]` 那条声明在页面上再也看不到、也删不掉 —— 只能手改清单。这组用例钉住清单赖以工作的那份状态
// （**原样读出**的全部声明，含陈旧条目）与它唯一的动作（空 path 的删除）。
describe('装备页：本包已声明的图标清单（含陈旧条目，逐条可删）', () => {
  // 图标文件用上一组用例已经放进 assets/ 的那张图（内容无所谓，路径与声明才是这里要证的东西）
  const ICON_PATH = 'item/trap_ws_icon_item.png';
  const DECLARED = 'trap_ws_listed';
  const RENAMED = 'trap_ws_listed_new';
  const packManifest = () => JSON.parse(fs.readFileSync(join(wsRoot, 'item-pack', 'pack.json'), 'utf8'));
  const merged = () => loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
  const listed = () => fetch(`${editor.url}/api/items`).then((x) => x.json()).then((r) => r.packItemIcons.find((p) => p.id === 'item-pack'));
  const setIcon = (itemId, path) => post(`${editor.url}/api/packs/item-pack/item-icons`, { itemId, path });
  // 一件自带图标 id 的装备
  const spec = (trapId) => ({ ...itemSpec(), id: 'listed_item', trapId });

  before(async () => {
    const saved = await post(`${editor.url}/api/packs/item-pack/items`, { spec: spec(DECLARED) }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const declared = await setIcon(DECLARED, ICON_PATH).then((x) => x.json());
    assert.equal(declared.ok, true, JSON.stringify(declared));
  });

  test('改掉 trapId 之后，这条声明还在状态里：页面拿到的就是含陈旧条目的那一份', async () => {
    // 作者改掉这件装备的图标 id —— 从此那段下拉里再也点不到旧声明，只剩下面这块清单能删它
    const saved = await post(`${editor.url}/api/packs/item-pack/items`, { spec: spec(RENAMED) }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const pi = await listed();
    assert.equal(pi.itemIcons[DECLARED], ICON_PATH, '陈旧声明必须原样给页面（清单列的就是这一份）');
    const all = await fetch(`${editor.url}/api/items`).then((x) => x.json());
    assert.equal(
      all.items.some((i) => i.pack === 'item-pack' && i.trapId === DECLARED), false,
      '本包已经没有记录用这个 id —— 页面据此把它标成「陈旧 / 没人用」',
    );
    assert.equal(merged().assets.items[DECLARED], `/workshop-assets/item-pack/${ICON_PATH}`,
      '没删之前这条声明仍然生效（那正是它必须能被删掉的理由）');
  });

  test('删掉陈旧声明：配图被拒、清空放行，pack.json 与 assets.items 里那条一起回去', async () => {
    // 「只收本包在用的 id」拦的是配图 —— 给一条陈旧声明重新配图是 400，而清空是例外：它正是修掉陈旧声明的方式
    assert.equal((await setIcon(DECLARED, ICON_PATH)).status, 400, '没人用的 id 不能再配图');
    const r = await setIcon(DECLARED, '').then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, null);
    assert.equal(DECLARED in (packManifest().itemIcons ?? {}), false, 'pack.json 里那条声明真的没了');
    assert.equal(DECLARED in merged().assets.items, false, '合并后的 assets.items 里那条也回去了');
  });

  test('删除一个还在用的 id 同样能删（清空不受「只收本包在用的 id」限制）', async () => {
    const declared = await setIcon(RENAMED, ICON_PATH).then((x) => x.json());
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(merged().assets.items[RENAMED], `/workshop-assets/item-pack/${ICON_PATH}`);
    // 页面上它显示为「有人在用」（本包 items.json 里有记录的 trapId 等于它），删除走的是同一条空 path
    const r = await setIcon(RENAMED, '').then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(RENAMED in (packManifest().itemIcons ?? {}), false);
    assert.equal(RENAMED in merged().assets.items, false);
  });

  test('页面：清单遍历的是全部声明，每条一个走空 path 的删除入口（源码层面钉住这条出口）', async () => {
    const src = fs.readFileSync(join(ROOT, 'editor/ui/item.js'), 'utf8');
    assert.match(src, /本包已声明的装备图标/, '清单要有标题');
    assert.match(src, /Object\.entries\(packIcons\?\.itemIcons \?\? \{\}\)/, '要遍历全部声明，不是只列当前 trapId 那一条');
    const fn = src.slice(src.indexOf('async function deleteDeclaredIcon'));
    assert.ok(fn, '清单的删除要有自己的入口');
    assert.match(fn.slice(0, 1200), /\/item-icons`/, '删除走 item-icons');
    assert.match(fn.slice(0, 1200), /path: ''/, '空 path 才是「删掉这条声明」');
  });
});

// 一个包**删光装备之后**只剩旧声明的边界：`items.json` 里一条记录都没有时页面 `state.packId` 以前是 null，整块清单
// 根本不渲染 —— 那条 `itemIcons` 声明又回到「只能手改 pack.json」。这组用例钉住两件事：清单赖以工作的那份状态在
// 没有装备时照样拿得到（`packItemIcons` 对每个有 pack.json 的包都给一条，`packs` 让页面能默认选中一个包），
// 以及它唯一的动作（空 path 的删除）在没有装备的情况下也被服务端放行。
describe('装备页：本包一件装备都没有时，声明清单照样常在（包只留下旧 itemIcons）', () => {
  const PACK = 'empty-item-pack';
  const ITEM = 'orphan_item';
  const TRAP = 'trap_ws_orphan';
  // 复用上一组用例放进 item-pack/assets 的那张图（内容无所谓，路径与声明才是这里要证的东西）
  const ICON_PATH = 'item/trap_ws_icon_item.png';
  const packJson = (id = PACK) => JSON.parse(fs.readFileSync(join(wsRoot, id, 'pack.json'), 'utf8'));
  const itemsJson = (id = PACK) => JSON.parse(fs.readFileSync(join(wsRoot, id, 'items.json'), 'utf8'));
  const itemsApi = () => fetch(`${editor.url}/api/items`).then((x) => x.json());
  const packState = (r, id = PACK) => r.packItemIcons.find((p) => p.id === id);

  before(async () => {
    const saved = await post(`${editor.url}/api/packs/${PACK}/items`, { spec: { ...itemSpec(), id: ITEM, trapId: TRAP } }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    // 一个声明为 ASSETS_NEED_LICENSE 的包必须先有 license 才放得进素材（照上一组的做法）
    fs.mkdirSync(join(wsRoot, PACK, 'assets', 'item'), { recursive: true });
    fs.writeFileSync(join(wsRoot, PACK, 'pack.json'), `${JSON.stringify({ ...packJson(), license: 'CC0-1.0' }, null, 2)}\n`);
    fs.copyFileSync(join(wsRoot, 'item-pack', 'assets', ICON_PATH), join(wsRoot, PACK, 'assets', ICON_PATH));
    const declared = await post(`${editor.url}/api/packs/${PACK}/item-icons`, { itemId: TRAP, path: ICON_PATH }).then((x) => x.json());
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(packJson().itemIcons[TRAP], ICON_PATH, '先有一条真的声明，才谈得上「装备删光之后它还在」');
    // 作者删掉最后一件装备（页面上的「删除」走的就是这条 DELETE，普通与精英两条记录一起走）
    const del = await fetch(`${editor.url}/api/packs/${PACK}/items/chess_item_ws_${ITEM}_a`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true, JSON.stringify(del));
  });

  test('装备删光之后：本包一条记录都没有，旧的 itemIcons 声明原样留在 pack.json 里', async () => {
    assert.deepEqual(itemsJson(), {}, 'items.json 里一条记录都不剩');
    const r = await itemsApi();
    assert.equal(r.items.some((i) => i.pack === PACK), false, '这一页拿到的 items 里没有本包的任何记录');
    // 这正是「只能手改清单」的那条边界：没有记录，声明却还在
    assert.equal(packState(r).itemIcons[TRAP], ICON_PATH, '声明必须原样给页面（清单列的就是这一份）');
    // 页面上「本包已声明的装备图标」这一块的包来源是 state.packId；以前它是 items[0]?.pack ?? null，
    // 于是这种包里 state.packId === null、清单整块不画。因此默认选中必须退到 packs（有 pack.json 的包）。
    assert.match(
      fs.readFileSync(join(ROOT, 'editor/ui/item.js'), 'utf8'),
      /state\.packId = state\.data\.items\[0\]\?\.pack \?\? state\.data\.packs/,
      '没有装备时也要有一个当前包，否则那块清单列不出来',
    );
    const packIds = r.packs.map((p) => p.id);
    assert.ok(packIds.includes(PACK), '这个包在「保存到」的包清单里，页面因此有包可默认选中');
    assert.equal('' in packState(r).itemIcons, false, '清单读的是真的那条声明');
  });

  test('这一页仍然能删掉它：清空不受「只收本包在用的 id」限制，pack.json 里那条真的没了', async () => {
    // 先确认拦的是**配图**：本包一件装备都没有，没有任何记录用这个 id → 配图 400（那正是「陈旧」的含义）
    assert.equal((await post(`${editor.url}/api/packs/${PACK}/item-icons`, { itemId: TRAP, path: ICON_PATH })).status, 400);
    // 而清空是例外，也正是清单那个删除按钮发出的请求
    const r = await post(`${editor.url}/api/packs/${PACK}/item-icons`, { itemId: TRAP, path: '' }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, null);
    assert.equal(TRAP in (packJson().itemIcons ?? {}), false, 'pack.json 里那条声明真的没了（不用手改清单）');
    assert.equal((await itemsApi()).items.some((i) => i.pack === PACK), false, '删声明不会凭空造出装备记录');
  });

  test('没有装备时画的那块清单与有装备时是同一块（同一个函数、同一套「有人在用」判断）', () => {
    const src = fs.readFileSync(join(ROOT, 'editor/ui/item.js'), 'utf8');
    const form = src.slice(src.indexOf('function renderForm'), src.indexOf('// ---- 本包已声明的装备图标'));
    // 无 spec 分支：先选中包，再画清单 —— 不能只画一句「左边选一件装备」就返回
    assert.match(form, /if \(!spec\) \{[\s\S]*?box\.append\(declaredIconsBox\(currentPackIcons\(\), iconIdsInUse\(\)\)\);\s*\n\s*return;/,
      '没有 spec 时也要画那块清单');
    // 有 spec 时走的是同一个 declaredIconsBox（行为不能变）
    assert.equal((form.match(/declaredIconsBox\(/g) ?? []).length, 2, '有/无 spec 两条路径都用这一块，不再各画一份');
    // 「有人在用」只有一份实现：本包 items.json 记录的 iconId / trapId
    const helper = src.slice(src.indexOf('function iconIdsInUse'), src.indexOf('function currentPackIcons'));
    assert.match(helper, /\[it\.iconId, it\.trapId\]/, '判定「有人在用」要看记录的 iconId 与 trapId');
    assert.equal((src.match(/\[it\.iconId, it\.trapId\]/g) ?? []).length, 1, '这段判断不许抄第二份');
  });

  test('没有装备时这一页不碰别的包：右栏与本包清单都还是原样', async () => {
    const r = await itemsApi();
    const other = packState(r, 'item-pack');
    assert.ok(other, 'item-pack 的状态还在');
    assert.equal(r.items.some((i) => i.pack === 'item-pack'), true, '别的包的记录不受影响');
  });
});
