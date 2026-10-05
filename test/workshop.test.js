// test/workshop.test.js — 创意工坊 (community workshop) packs: format, overlay and delivery (docs/WORKSHOP.md).
//
// The load-bearing promises, all checked here:
//   * `data/*.json` is NEVER rewritten — the overlay is additive and applied in memory (server/data.js, before the
//     freeze), so the official data stays byte-identical and remains a clean baseline.
//   * A pack cannot replace an official record unless `pack.json.overrides` names it explicitly; a silent collision is
//     rejected and reported, because redefining a shipped operator would corrupt every match on the server.
//   * A broken pack is skipped with a report, never fatal — and a missing `workshop/` directory is the normal case.
//   * The BROWSER receives the merged data over `/data/<file>.json`, so client and server agree; a file no pack touches
//     is still served straight from disk.
//   * Workshop content is real content: it lands in the shop pool, resolves in the sim and fights in a real battle.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadData, getData } from '../server/data.js';
import { loadWorkshop, workshopTouchedFiles, WORKSHOP_DIR } from '../server/workshop.js';
import { applyWorkshop, normalizePackManifest, normalizeContentFile, workshopSummary, WORKSHOP_CONTENT_FILES } from '../shared/workshop.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';
import { buildWorkshopDataFiles, startServer } from '../server/index.js';
import { makeMatch, give, legalTileFor } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const EXAMPLE = join(ROOT, 'docs/examples/demo-workshop');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const WS_BASE = 'chess_char_ws_demo_01_a';
const WS_GOLD = 'chess_char_ws_demo_01_b';
const SOURCE = 'chess_char_5_01_a';
/** The demo pack's maxHp, i.e. deliberately different from the operator it reskins. */
const WS_MAXHP = 2067;

let tmpRoot;
/** A temp workshop root holding just the shipped example pack. */
let tmpWs;

before(() => {
  tmpRoot = fs.mkdtempSync(join(tmpdir(), 'sp-workshop-'));
  tmpWs = join(tmpRoot, 'ws');
  fs.mkdirSync(tmpWs, { recursive: true });
  fs.cpSync(EXAMPLE, join(tmpWs, 'demo-workshop'), { recursive: true });
});
after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('workshop: loader', () => {
  test('a missing workshop/ directory is the normal case, not an error', () => {
    const r = loadWorkshop(join(tmpRoot, 'does-not-exist'), { log: quiet });
    assert.equal(r.present, false);
    assert.deepEqual(r.packs, []);
    assert.deepEqual(r.errors, []);
  });

  test('the shipped example pack loads cleanly and declares what it ships', () => {
    const r = loadWorkshop(tmpWs, { log: quiet });
    assert.equal(r.present, true);
    assert.equal(r.packs.length, 1);
    assert.deepEqual(r.errors, []);
    const pack = r.packs[0];
    assert.equal(pack.id, 'demo-workshop');
    assert.equal(pack.version, '0.1.0');
    assert.equal(pack.license, 'CC0-1.0');
    assert.deepEqual(pack.content, ['chess']);
    assert.deepEqual([...workshopTouchedFiles(r)], ['chess']);
  });

  test('a broken pack is reported and skipped instead of throwing', () => {
    const bad = join(tmpRoot, 'bad');
    fs.mkdirSync(join(bad, 'no-manifest'), { recursive: true });
    fs.mkdirSync(join(bad, 'missing-file'), { recursive: true });
    fs.writeFileSync(join(bad, 'missing-file/pack.json'), JSON.stringify({ id: 'missing-file', content: ['chess'] }));
    fs.mkdirSync(join(bad, 'not-json'), { recursive: true });
    fs.writeFileSync(join(bad, 'not-json/pack.json'), '{ not json');
    const r = loadWorkshop(bad, { log: quiet });
    assert.deepEqual(r.packs, []);
    assert.equal(r.errors.length, 3);
    assert.match(r.errors.map((e) => e.reason).join(' | '), /pack\.json is missing/);
    assert.match(r.errors.map((e) => e.reason).join(' | '), /declared in pack\.json but missing/);
    assert.match(r.errors.map((e) => e.reason).join(' | '), /unreadable/);
  });
});

describe('workshop: the overlay', () => {
  test('adds content before the freeze, leaving data/*.json byte-identical', () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: tmpWs });
    assert.ok(data.chess[WS_BASE], 'the workshop base operator is missing');
    assert.ok(data.chess[WS_GOLD], 'the workshop elite is missing');
    assert.equal(Object.isFrozen(data), true);
    assert.equal(Object.isFrozen(data.chess), true);
    assert.equal(Object.isFrozen(data.chess[WS_BASE]), true);
    // the official file on disk must NOT have been touched
    const disk = JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8'));
    assert.equal(Object.keys(disk).length, 266);
    assert.equal(disk[WS_BASE], undefined);
    // the merged view is official + workshop
    assert.equal(Object.keys(data.chess).length, 268);
  });

  test('the official data stays a clean baseline when no (or no) pack is used', () => {
    assert.equal(Object.keys(getData({ log: quiet }).chess).length, 266, 'the process singleton must not see workshop content');
    assert.equal(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess).length, 266);
    assert.equal(loadWorkshop(WORKSHOP_DIR, { log: quiet }).packs.length, 0, 'the repo ships no active pack');
  });

  test('a collision with an official id is rejected unless the pack declares the override', () => {
    const officialId = 'chess_char_1_01_a';
    const official = loadData(DATA_DIR, { log: quiet, workshopDir: null }).chess[officialId];
    const hostile = { ...official, name: 'hijacked' };
    const base = { chess: { [officialId]: official } };

    const silent = applyWorkshop(base, [{ id: 'evil', name: 'evil', overrides: [], files: { chess: { [officialId]: hostile } } }]);
    assert.equal(silent.data.chess[officialId].name, official.name, 'the official record must win');
    assert.equal(silent.report.errors.length, 1);
    assert.match(silent.report.errors[0].reason, /overrides/);
    assert.deepEqual(silent.report.overridden, {});

    const declared = applyWorkshop(base, [{ id: 'ok', name: 'ok', overrides: [`chess:${officialId}`], files: { chess: { [officialId]: hostile } } }]);
    assert.equal(declared.data.chess[officialId].name, 'hijacked');
    assert.deepEqual(declared.report.overridden.chess, [officialId]);
    assert.deepEqual(declared.report.errors, []);
  });

  test('the merge never mutates its input and reports readable counts', () => {
    const base = { chess: { a: { chessId: 'a' } } };
    const { data, report } = applyWorkshop(base, [{ id: 'p', name: 'P', files: { chess: { b: { chessId: 'b' } } } }]);
    assert.deepEqual(Object.keys(base.chess), ['a'], 'the input object must be left alone');
    assert.deepEqual(Object.keys(data.chess), ['a', 'b']);
    assert.deepEqual(report.added.chess, ['b']);
    assert.match(workshopSummary(report), /P\(p\): chess \+1/);
    assert.equal(workshopSummary(null), 'no workshop packs');
  });

  test('the format fails closed on a malformed pack or record', () => {
    assert.equal(normalizePackManifest({ id: 'a/b' }, 'a/b').error, 'BAD_PACK_ID');
    assert.equal(normalizePackManifest({ id: 'x' }, 'y').error, 'PACK_ID_MISMATCH');
    assert.equal(normalizePackManifest({ id: 'x', content: [] }, 'x').error, 'EMPTY_PACK');
    // `config` is deliberately not a workshop-contributable file
    assert.equal(WORKSHOP_CONTENT_FILES.includes('config'), false);
    assert.equal(normalizePackManifest({ id: 'x', content: ['config'] }, 'x').error, 'EMPTY_PACK');
    assert.equal(normalizeContentFile('chess', []).error, 'BAD_CONTENT');
    assert.equal(normalizeContentFile('chess', {}).error, 'EMPTY_CONTENT');
    assert.equal(normalizeContentFile('chess', { a: 'nope' }).error, 'BAD_RECORD');
    assert.equal(normalizeContentFile('chess', { 'not a valid id!': {} }).error, 'BAD_RECORD_ID');
    assert.equal(normalizeContentFile('chess', { a: { chessId: 'b' } }).error, 'ID_MISMATCH');
    assert.equal(normalizeContentFile('chess', { a: { chessId: 'a' } }).ok, true);
  });
});

describe('workshop: the content reaches the game', () => {
  let data;
  before(() => { data = loadData(DATA_DIR, { log: quiet, workshopDir: tmpWs }); });

  test('GameData treats it as an ordinary shop-eligible operator', () => {
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.visibleChess.includes(WS_BASE));
    assert.equal(gd.tierOf(WS_BASE), 5);
    assert.equal(gd.goldenIdOf(WS_BASE), WS_GOLD);
    assert.equal(gd.baseIdOf(WS_GOLD), WS_BASE);
    assert.equal(gd.chess(WS_BASE).stats.maxHp, WS_MAXHP);
    assert.notEqual(gd.chess(WS_BASE).stats.maxHp, gd.chess(SOURCE).stats.maxHp, 'the workshop numbers must be the pack\'s own');
  });

  test('the shared pool gives it copies like any tier-5 operator', () => {
    const pool = new SharedPool(new GameData(data, 'mode_multi_hard'), {});
    assert.equal(pool.has(WS_BASE), true);
    assert.equal(pool.cap(WS_BASE), 8);
    assert.equal(pool.left(WS_BASE), 8);
    assert.equal(pool.take(WS_BASE, 3), 3);
    assert.equal(pool.left(WS_BASE), 5);
    assert.equal(pool.give(WS_BASE, 3), 3);
    assert.equal(pool.left(WS_BASE), 8);
  });

  test('the sim resolves a def for it (this is what makes it fight)', async () => {
    const simdata = await import('../server/sim/simdata.js');
    const ds = simdata.toDataSource(data);
    const def = ds.getChess(WS_BASE);
    assert.ok(def, 'simdata could not build a def for the workshop operator');
    assert.match(JSON.stringify(def), new RegExp(String(WS_MAXHP)), 'the pack\'s maxHp did not reach the sim');
    assert.ok(ds.getChess(WS_GOLD), 'the workshop elite did not resolve');
  });

  test('a real battle runs with it deployed on the board', () => {
    const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 21, data });
    h.start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    assert.equal(h.m.pool.take(WS_BASE, 1), 1, 'the pool must offer it');
    const tile = legalTileFor(h.m, ps, WS_BASE);
    give(h.m, ps, WS_BASE, 'board', tile);
    assert.ok(tile, 'no legal tile was found for the workshop operator');
    assert.equal(ps.board.get(tile.join(','))?.id, WS_BASE);
    assert.ok(h.drive(() => h.m.round >= 2 || h.ended != null), `stuck at ${h.m.phase} R${h.m.round}`);
    assert.deepEqual(h.logs.error, []);
  });
});

describe('workshop: delivery to the browser over HTTP', () => {
  test('a touched data file is served merged; an untouched one comes from disk', async () => {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: tmpWs });
    const touched = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: tmpWs });
    try {
      const chess = await fetch(`${touched.url}/data/chess.json`).then((r) => r.json());
      assert.ok(chess[WS_BASE], 'the browser must receive the workshop operator');
      assert.equal(Object.keys(chess).length, 268);
      const support = await fetch(`${touched.url}/data/support.json`).then((r) => r.json());
      assert.deepEqual(support, JSON.parse(fs.readFileSync(join(DATA_DIR, 'support.json'), 'utf8')));
      // only the files a pack touches are mapped (the rest keep the plain static path)
      assert.deepEqual([...buildWorkshopDataFiles(data, loadWorkshop(tmpWs, { log: quiet })).keys()], ['chess']);
    } finally {
      await touched.close();
    }
  });

  test('with no pack installed the served data equals the files on disk', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: null });
    try {
      const chess = await fetch(`${srv.url}/data/chess.json`).then((r) => r.json());
      assert.deepEqual(chess, JSON.parse(fs.readFileSync(join(DATA_DIR, 'chess.json'), 'utf8')));
    } finally {
      await srv.close();
    }
  });
});
