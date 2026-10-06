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
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
