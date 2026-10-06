// test/itemAuthoring.test.js — authoring a workshop EQUIPMENT item (shared/itemAuthoring.js).
//
// The load-bearing test is the first one: the three fields this layer derives must be reproduced for the WHOLE shipped
// roster from the fields an author actually knows. `params` matters most — the engine reads `params`, not the buffs —
// so a hand-typed value would leave the item looking right on the card and doing nothing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveItem, validateItem, itemIds, effectParams, isMergeable, itemErrors, itemSummaryLine,
  ITEM_TYPES, ITEM_CATEGORIES, COUNT_TYPES, ITEM_DURATIONS, UPGRADE_NUMS,
} from '../shared/itemAuthoring.js';
import { applyWorkshop } from '../shared/workshop.js';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const ITEMS = JSON.parse(fs.readFileSync(join(DATA_DIR, 'items.json'), 'utf8'));
const ALL = Object.values(ITEMS);
const OFFICIAL = new Set(Object.keys(ITEMS));

const SPEC = {
  id: 'frost_charm',
  name: '霜华护符',
  desc: '攻击力+20%，被冻结的敌人受到伤害提高',
  tier: 4,
  price: 3,
  itemType: 'EQUIP',
  category: 'STAT',
  duration: -1,
  upgradeNum: 2,
  trapId: 'trap_1041_acarm041',
  buffs: [
    { key: 'env_gbuff_new_with_verify', countType: 'NONE', bb: { atk: 0.2 }, bbStr: { key: 'attr_common_global_buff' } },
  ],
};

describe('item authoring: the derived fields are reproduced', () => {
  test('params is reproduced for EVERY shipped item from its buffs', () => {
    const bad = [];
    for (const it of ALL) {
      const mine = effectParams(it.buffs);
      if (JSON.stringify(mine) !== JSON.stringify(it.params || {})) bad.push(`${it.id}: stored ${JSON.stringify(it.params)}, derived ${JSON.stringify(mine)}`);
    }
    assert.deepEqual(bad, [], `params must be reproducible from the buffs:\n${bad.slice(0, 5).join('\n')}`);
  });

  test('mergeable and shopExcluded are reproduced for EVERY shipped item', () => {
    const bad = [];
    for (const it of ALL) {
      const merge = isMergeable(it.isGolden === true, it.upgradeNum, it.goldenId ?? null);
      if (merge !== it.mergeable) bad.push(`${it.id}: mergeable ${it.mergeable}, rule gives ${merge} (isGolden ${it.isGolden}, upgradeNum ${it.upgradeNum}, goldenId ${JSON.stringify(it.goldenId)})`);
      const excl = it.shopExcludedBy != null;
      if (excl !== it.shopExcluded) bad.push(`${it.id}: shopExcluded ${it.shopExcluded}, but shopExcludedBy is ${JSON.stringify(it.shopExcludedBy)}`);
    }
    assert.deepEqual(bad, [], `the rules must hold for the whole roster:\n${bad.slice(0, 5).join('\n')}`);
    // and the extra clause the rule needs is exercised by the data: nothing is mergeable without a twin
    assert.equal(ALL.filter((i) => i.mergeable && !i.goldenId).length, 0);
  });

  test('effectParams: bbStr overrides bb within a buff, and the earliest buff wins across buffs', () => {
    // build-data spreads `{ ...bb, ...bbStr }` per buff (so bbStr wins a shared key) and keeps the first across buffs
    assert.deepEqual(effectParams([{ bb: { atk: 1 }, bbStr: { atk: 2, key: 'x' } }]), { atk: 2, key: 'x' });
    assert.deepEqual(effectParams([{ bb: { a: 1 } }, { bb: { a: 9, b: 2 } }]), { a: 1, b: 2 }, 'the first buff wins for a shared key');
    assert.deepEqual(effectParams([]), {});
    assert.deepEqual(effectParams(null), {});
  });

  test('the enums cover every value the shipped data uses (drift guard)', () => {
    const seen = { itemType: new Set(), category: new Set(), countType: new Set(), duration: new Set(), upgradeNum: new Set() };
    for (const it of ALL) {
      seen.itemType.add(it.itemType);
      if (it.category != null) seen.category.add(it.category);
      for (const b of it.buffs || []) seen.countType.add(b.countType);
      seen.duration.add(it.duration);
      seen.upgradeNum.add(it.upgradeNum);
    }
    for (const [key, list] of Object.entries({
      itemType: ITEM_TYPES, category: ITEM_CATEGORIES, countType: COUNT_TYPES, duration: ITEM_DURATIONS, upgradeNum: UPGRADE_NUMS,
    })) {
      assert.ok(seen[key].size > 0, `${key} was not exercised`);
      for (const v of seen[key]) assert.ok(list.includes(v), `the data uses ${key}="${v}" but the validator does not accept it`);
    }
  });

  test('the shipped roster validates clean (no false positives)', () => {
    const bad = [];
    for (const it of ALL) {
      const errs = itemErrors(validateItem(it, { id: it.id, officialIds: new Set() }));
      if (errs.length) bad.push(`${it.id}: ${errs.map((e) => `${e.code}(${e.field})`).join(',')}`);
    }
    assert.deepEqual(bad, [], `official items rejected (${bad.length}):\n${bad.slice(0, 5).join('\n')}`);
  });

  test('the id pair rule matches the data', () => {
    const normals = ALL.filter((i) => !i.isGolden);
    const paired = normals.filter((i) => i.goldenId && ITEMS[i.goldenId]?.isGolden);
    assert.ok(paired.length > 50, `expected the shipped pairs, found ${paired.length}`);
    for (const it of paired) {
      assert.equal(it.goldenId, it.id.replace(/_a$/, '_b'), `${it.id}: the twin is the _b id`);
      assert.equal(it.upgradeChessId, it.goldenId, `${it.id}: the merge target is the twin`);
      assert.equal(ITEMS[it.goldenId].goldenId, it.goldenId, 'a golden names itself');
    }
  });
});

describe('item authoring: deriveItem', () => {
  test('a minimal spec produces a base and a golden twin, wired as a pair', () => {
    const r = deriveItem(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.base.id, 'chess_item_ws_frost_charm_a');
    assert.equal(r.golden.id, 'chess_item_ws_frost_charm_b');
    // the DERIVED fields
    assert.deepEqual(r.base.params, { atk: 0.2, key: 'attr_common_global_buff' }, 'params comes from the buffs');
    assert.equal(r.base.mergeable, true);
    assert.equal(r.base.upgradeChessId, r.golden.id, 'the merge target is the twin');
    assert.equal(r.base.shopExcluded, false);
    assert.equal(r.base.iconId, SPEC.trapId);
    assert.equal(r.base.isGolden, false);
    assert.equal(r.golden.isGolden, true);
    assert.equal(r.golden.mergeable, false, 'a golden is never itself mergeable');
    assert.equal(r.golden.goldenId, r.golden.id);
    assert.deepEqual(r.base.rangeGrid, [[0, 0]], 'the shipped default');
    assert.deepEqual(itemErrors(validateItem(r.base, { officialIds: OFFICIAL })), []);
    assert.deepEqual(itemErrors(validateItem(r.golden, { officialIds: OFFICIAL })), []);
  });

  test('a standalone item (upgradeNum 0 or golden:false) emits one record with no twin', () => {
    const solo = deriveItem({ ...SPEC, upgradeNum: 0 });
    assert.equal(solo.ok, true);
    assert.equal(solo.golden, null);
    assert.equal(solo.base.goldenId, null);
    assert.equal(solo.base.upgradeChessId, null);
    assert.equal(solo.base.mergeable, false);
    const noGolden = deriveItem({ ...SPEC, golden: false });
    assert.equal(noGolden.golden, null);
    assert.equal(noGolden.base.mergeable, false, 'without a twin it cannot be mergeable');
    assert.deepEqual(itemErrors(validateItem(noGolden.base, { officialIds: OFFICIAL })), []);
  });

  test('shopExcluded follows shopExcludedBy, and the exclusion source is kept', () => {
    const r = deriveItem({ ...SPEC, shopExcludedBy: 'shop_rule_x' });
    assert.equal(r.base.shopExcludedBy, 'shop_rule_x');
    assert.equal(r.base.shopExcluded, true);
    assert.deepEqual(itemErrors(validateItem(r.base, { officialIds: OFFICIAL })), []);
  });

  test('every missing or wrong fact is reported with a field and a code', () => {
    const r = deriveItem({ id: '', tier: 99, price: -1, itemType: 'WEAPON', category: 'NOPE', duration: 5, buffs: [{ bb: {} }] });
    assert.equal(r.ok, false);
    const codes = r.errors.map((e) => `${e.field}:${e.code}`);
    for (const want of ['id:BAD_ID', 'name:MISSING', 'itemType:BAD_ENUM', 'category:BAD_ENUM', 'duration:BAD_ENUM', 'tier:BAD_TIER', 'price:BAD_NUMBER', 'buffs[0].key:MISSING']) {
      assert.ok(codes.includes(want), `${want} missing from ${codes.join(' ')}`);
    }
  });

  test('a bad rangeGrid and a bad countType are refused', () => {
    assert.equal(deriveItem({ ...SPEC, rangeGrid: [] }).ok, false);
    assert.equal(deriveItem({ ...SPEC, rangeGrid: [[0, 0.5]] }).ok, false);
    const badCount = deriveItem({ ...SPEC, buffs: [{ key: 'k', countType: 'SOMETIMES', bb: { a: 1 } }] });
    assert.equal(badCount.ok, false);
    assert.ok(badCount.errors.some((e) => e.code === 'BAD_ENUM' && /countType/.test(e.field)));
  });

  test('an item with no buffs still derives, but is warned it does nothing', () => {
    const r = deriveItem({ ...SPEC, buffs: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.base.params, {});
    assert.ok(r.warnings.some((w) => /no buffs/.test(w)));
    const noIcon = deriveItem({ ...SPEC, trapId: undefined });
    assert.ok(noIcon.warnings.some((w) => /trapId/.test(w)));
  });

  test('the summary line names the tier, price and mergeability', () => {
    const r = deriveItem(SPEC);
    const line = itemSummaryLine(r.base);
    assert.match(line, /霜华护符/);
    assert.match(line, /4 阶/);
    assert.match(line, /可合成/);
    assert.match(line, /atk=0\.2/);
  });
});

describe('item authoring: validateItem catches drift', () => {
  const good = () => deriveItem(SPEC);

  test('a hand-typed params is caught (the engine reads params, not the buffs)', () => {
    const r = good();
    const tampered = { ...r.base, params: { atk: 99 } };
    const hit = itemErrors(validateItem(tampered, { id: tampered.id, officialIds: OFFICIAL })).find((e) => e.code === 'STALE_DERIVED' && e.field === 'params');
    assert.ok(hit, 'params drift must be an error');
    const noParams = { ...r.base };
    delete noParams.params;
    assert.ok(validateItem(noParams, { id: noParams.id, officialIds: OFFICIAL }).some((e) => e.code === 'MISSING_DERIVED'));
  });

  test('a hand-typed mergeable or shopExcluded is caught', () => {
    const r = good();
    assert.ok(validateItem({ ...r.base, mergeable: false }, { id: r.base.id, officialIds: OFFICIAL }).some((e) => e.code === 'STALE_DERIVED' && e.field === 'mergeable'));
    assert.ok(validateItem({ ...r.base, shopExcluded: true }, { id: r.base.id, officialIds: OFFICIAL }).some((e) => e.code === 'STALE_DERIVED' && e.field === 'shopExcluded'));
  });

  test('a broken id pair is caught', () => {
    const r = good();
    assert.ok(validateItem({ ...r.base, upgradeChessId: 'chess_item_ws_other_b' }, { id: r.base.id, officialIds: OFFICIAL }).some((e) => e.code === 'PAIR_MISMATCH'));
    assert.ok(validateItem({ ...r.golden, goldenId: 'chess_item_ws_other_b' }, { id: r.golden.id, officialIds: OFFICIAL }).some((e) => e.code === 'PAIR_MISMATCH'));
    assert.ok(validateItem({ ...r.base, goldenId: null, upgradeChessId: null }, { id: r.base.id, officialIds: OFFICIAL }).some((e) => e.code === 'PAIR_MISSING'));
  });

  test('an official id collision is an error with the fix in the hint', () => {
    const officialId = Object.keys(ITEMS)[0];
    const issues = validateItem(ITEMS[officialId], { id: officialId, officialIds: OFFICIAL });
    const hit = issues.find((i) => i.code === 'OFFICIAL_ID_COLLISION');
    assert.ok(hit && hit.severity === 'error', JSON.stringify(issues));
    assert.match(hit.hint, /overrides/);
    // and a derived workshop id never collides
    const r = deriveItem({ ...SPEC, id: officialId });
    assert.equal(itemErrors(validateItem(r.base, { officialIds: OFFICIAL })).length, 0);
    assert.notEqual(r.base.id, officialId);
  });

  test('a missing icon is only a warning (an item still works without art)', () => {
    const r = deriveItem({ ...SPEC, trapId: undefined });
    const issues = validateItem(r.base, { officialIds: OFFICIAL });
    assert.ok(issues.some((i) => i.code === 'NO_ICON' && i.severity === 'warning'));
  });
});

describe('item authoring: a workshop item reaches the engine', () => {
  test('it merges under its own ids, and an official id needs a declared override', () => {
    const r = deriveItem(SPEC);
    assert.equal(r.ok, true);
    const pack = { id: 'item-pack', overrides: [], files: { items: { [r.base.id]: r.base, [r.golden.id]: r.golden } } };
    const { data, report } = applyWorkshop({ items: ITEMS }, [pack]);
    assert.deepEqual(report.added.items, [r.base.id, r.golden.id].sort());
    assert.equal(Object.keys(data.items).length, Object.keys(ITEMS).length + 2);
    // the twin survives the merge as a real record, which is what makes the merge resolve
    assert.equal(data.items[r.golden.id].isGolden, true);

    const officialId = Object.keys(ITEMS)[0];
    const evil = applyWorkshop({ items: ITEMS }, [
      { id: 'evil', overrides: [], files: { items: { [officialId]: { ...ITEMS[officialId], price: 999 } } } },
    ]);
    assert.equal(evil.data.items[officialId].price, ITEMS[officialId].price, 'the official item must win');
    assert.equal(evil.report.errors.length, 1);
    assert.match(evil.report.errors[0].reason, /overrides/);
  });

  test('loadData carries it, and GameData resolves it', () => {
    const tmp = fs.mkdtempSync(join(ROOT, '.tmp-items-'));
    const wsRoot = join(tmp, 'ws');
    const packDir = join(wsRoot, 'item-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({ id: 'item-pack', name: 'Items', version: '1.0.0', content: ['items'], overrides: [] }));
    const r = deriveItem(SPEC);
    assert.equal(r.ok, true);
    fs.writeFileSync(join(packDir, 'items.json'), JSON.stringify({ [r.base.id]: r.base, [r.golden.id]: r.golden }));
    try {
      const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
      assert.ok(data.items[r.base.id], 'the item must reach the merged data');
      assert.equal(data.items[r.base.id].params.atk, 0.2);
      const gd = new GameData(data, 'mode_multi_normal');
      const rec = typeof gd.item === 'function' ? gd.item(r.base.id) : data.items[r.base.id];
      assert.ok(rec, 'GameData must resolve the workshop item');
      assert.equal(rec.name, '霜华护符');
      assert.equal(rec.mergeable, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
