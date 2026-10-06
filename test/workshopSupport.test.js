// 工坊包自带助战卡池 (`pack.json.support`, docs/WORKSHOP.md §2).
//
// Why this exists: the 助战 pool has exactly one source, `data/support.json`, which is the INSTALL's file — so a pack
// that adds a 助战 operator (the reserved 助战语音包 case) was not self-contained: whoever installed it also had to
// hand-edit the server's data before the operator could be picked. `pack.json.support` closes that gap, with two
// deliberate limits, both pinned here:
//   * only an operator THE PACK ITSELF adds may enter the pool — a pack must not change which official operators are
//     available (that is a rules decision, and the pool belongs to the install);
//   * the tier is DERIVED from the record, never written in the manifest — a mismatch would silently disable the
//     operator, because shared/support.js `isSupportChess` requires an id to sit under its own tier.
// The install keeps the last word: `"workshop": false` in data/support.json turns every contribution off.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, applyWorkshop, workshopSupportEntries, workshopSummary } from '../shared/workshop.js';
import { normalizeSupportConfig, isSupportChess, supportPicker } from '../shared/support.js';
import { loadWorkshop, workshopTouchedFiles } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { startServer } from '../server/index.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const WS_ID = 'chess_char_ws_ally_01_a';
const OFFICIAL_5 = 'chess_char_5_01_a';
const OFFICIAL_6 = 'chess_char_6_01_a';

/** A loaded-pack stand-in: only the fields the support rules read. */
const pack = (id, support, chess = {}) => ({ id, name: id, support, files: chess ? { chess } : {} });
/**
 * Base data carrying ONLY the official operators (an operator a pack adds comes from the pack's own chess file, which
 * the overlay merges first — so the tier the support rule reads is the merged one).
 */
const baseData = (support, chess = {}) => ({
  chess: { [OFFICIAL_5]: { tier: 5, visible: true }, [OFFICIAL_6]: { tier: 6, visible: true }, ...chess },
  support,
});

describe('工坊助战: pack.json.support 的形状', () => {
  test("a list of the pack's own operators, collapsed and kept in order", () => {
    const r = normalizePackManifest({ id: 'p', content: ['chess'], support: ['a', 'b', 'a'] }, 'p', { hasAssets: false });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.support, ['a', 'b']);
    assert.deepEqual(normalizePackManifest({ id: 'p', content: ['chess'] }, 'p', {}).pack.support, [], 'absent → [] , never undefined');
  });

  test('a malformed declaration is refused', () => {
    const cases = [
      [['ok', 42], 'SUPPORT_BAD_ID'],
      [['../evil'], 'SUPPORT_BAD_ID'],
      ['chess_x', 'SUPPORT_BAD_SHAPE'],
      [{ 5: ['x'] }, 'SUPPORT_BAD_SHAPE'],
    ];
    for (const [support, error] of cases) {
      const r = normalizePackManifest({ id: 'p', content: ['chess'], support }, 'p', {});
      assert.equal(r.ok, false, `${JSON.stringify(support)} must be refused`);
      assert.equal(r.error, error);
    }
  });
});

describe('工坊助战: 谁能进池、按哪一阶', () => {
  test('the tier comes from the record, never from the manifest', () => {
    const merged = { chess: { [WS_ID]: { tier: 5 } }, support: {} };
    const { entries, errors } = workshopSupportEntries(merged, [pack('p', [WS_ID], { [WS_ID]: { tier: 5 } })]);
    assert.deepEqual(errors, []);
    assert.deepEqual(entries, [{ pack: 'p', id: WS_ID, tier: 5 }]);
  });

  test('an ID the pack does not add is refused (a pack may not widen the official pool)', () => {
    const { entries, errors } = workshopSupportEntries(baseData({}), [pack('p', [OFFICIAL_5], { [WS_ID]: { tier: 5 } })]);
    assert.deepEqual(entries, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /not an operator this pack adds/);
  });

  test('an operator with no usable tier is refused (it could never be picked anyway)', () => {
    for (const tier of [undefined, 0, 9, '5', 5.5]) {
      const merged = { chess: { [WS_ID]: { tier } }, support: {} };
      const { entries, errors } = workshopSupportEntries(merged, [pack('p', [WS_ID], { [WS_ID]: { tier } })]);
      assert.deepEqual(entries, [], `tier ${JSON.stringify(tier)} must be refused`);
      assert.match(errors[0].reason, /integer tier 1–6/);
    }
  });
});

describe('工坊助战: 并进 data/support.json', () => {
  const POOL = { enabled: true, slots: { 5: 2, 6: 1 }, pool: { 5: [OFFICIAL_5], 6: [OFFICIAL_6] }, denyUnknown: true };

  test("the pack's operator is ADDED to its own tier; the official pool is untouched", () => {
    const base = baseData(POOL);
    const { data, report } = applyWorkshop(base, [pack('p', [WS_ID], { [WS_ID]: { tier: 5 } })]);
    assert.deepEqual(data.support.pool['5'], [OFFICIAL_5, WS_ID]);
    assert.deepEqual(data.support.pool['6'], [OFFICIAL_6]);
    assert.deepEqual(report.support, { p: [WS_ID] });
    assert.match(workshopSummary(report), /助战 \+1/);
    // the input is never mutated
    assert.deepEqual(base.support.pool['5'], [OFFICIAL_5]);
    assert.equal(base.chess[WS_ID], undefined, "the pack's record is not written into the caller's data");
    // and the rest of the config survives (this is a merge into the install's file, not a replacement)
    assert.equal(data.support.slots['5'], 2);
    assert.equal(data.support.denyUnknown, true);
  });

  test("...and the operator is then really pickable, by the engine's own rules", () => {
    const { data } = applyWorkshop(baseData(POOL), [pack('p', [WS_ID], { [WS_ID]: { tier: 5 } })]);
    const cfg = normalizeSupportConfig(data.support);
    const getChess = (id) => data.chess[id];
    assert.equal(cfg.enabled, true);
    assert.equal(isSupportChess(cfg, WS_ID, getChess), true, 'the whole point: installed pack → selectable 助战');
    assert.equal(isSupportChess(cfg, OFFICIAL_5, getChess), true);
    const tiers = supportPicker(cfg);
    assert.deepEqual(tiers.map((t) => t.tier), [5, 6]);
    assert.ok(tiers[0].ids.includes(WS_ID));
  });

  test('a record whose tier does not exist is reported, not silently added', () => {
    const { data, report } = applyWorkshop(baseData(POOL), [pack('p', [WS_ID], { [WS_ID]: { tier: 9 } })]);
    assert.deepEqual(data.support.pool['5'], [OFFICIAL_5], 'nothing was added');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].file, 'support');
  });

  test('the install can switch every pack contribution off with "workshop": false', () => {
    const { data, report } = applyWorkshop(baseData({ ...POOL, workshop: false }), [pack('p', [WS_ID], { [WS_ID]: { tier: 5 } })]);
    assert.deepEqual(data.support.pool['5'], [OFFICIAL_5], "the pool is the install's decision");
    assert.equal(report.support, undefined);
    assert.equal(report.supportOff, true);
    assert.match(workshopSummary(report), /pool contributions off/);
  });

  test('an install with no data/support.json is reported (助战 is off there), not crashed', () => {
    const { report } = applyWorkshop(baseData(undefined), [pack('p', [WS_ID], { [WS_ID]: { tier: 5 } })]);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].reason, /data\/support\.json is missing/);
  });

  test('a pack with no declaration changes nothing at all', () => {
    const base = baseData(POOL);
    const { data, report } = applyWorkshop(base, [pack('p', [], {})]);
    assert.equal(report.support, undefined);
    assert.equal(report.supportOff, undefined);
    assert.deepEqual(data.support, base.support);
  });
});

describe('工坊助战: 装入一个包就进池（端到端）', () => {
  let tmp;
  let dataDir;
  let ws;
  let srv;
  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-ws-support-'));
    dataDir = join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(join(dataDir, 'support.json'), JSON.stringify({
      enabled: true, label: '助战', slots: { 5: 1 }, pool: { 5: [OFFICIAL_5] }, denyUnknown: true,
    }));
    ws = join(tmp, 'ws');
    const dir = join(ws, 'ally-pack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      id: 'ally-pack', name: '助战包', version: '1.0.0', content: ['chess'], support: [WS_ID],
    }));
    fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({
      [WS_ID]: { chessId: WS_ID, name: '新助战', tier: 5, visible: true },
    }));
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: ws, dataDir });
  });
  after(async () => {
    await srv?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the pack marks `support` as a touched file, so the browser gets the merged pool', () => {
    const loaded = loadWorkshop(ws, { log: quiet });
    assert.deepEqual(loaded.packs[0].support, [WS_ID]);
    assert.deepEqual([...workshopTouchedFiles(loaded)].sort(), ['chess', 'support']);
    const data = loadData(dataDir, { log: quiet, workshopDir: ws });
    assert.deepEqual(data.support.pool['5'], [OFFICIAL_5, WS_ID]);
  });

  test("GET /data/support.json carries the pack's operator (the client picks 助战 from this file)", async () => {
    const remote = await fetch(`${srv.url}/data/support.json`).then((r) => r.json());
    assert.deepEqual(remote.pool['5'], [OFFICIAL_5, WS_ID]);
    const onDisk = JSON.parse(fs.readFileSync(join(dataDir, 'support.json'), 'utf8'));
    assert.deepEqual(onDisk.pool['5'], [OFFICIAL_5], 'data/support.json itself is never rewritten');
  });
});
