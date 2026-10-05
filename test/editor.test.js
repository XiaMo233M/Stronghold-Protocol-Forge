// test/editor.test.js — the standalone 工坊编辑器 (editor/server.mjs, tools/workshop-editor.mjs; docs/EDITOR.md).
//
// The boundary is the point of this suite: the editor is an OPTION. It lives outside `public/`, the game server mounts
// only /data /shared /sim and public/, and no game-client source mentions it — so a web client (or a later APK) can
// never load it. Everything else here checks the editor actually works: derive → write specs + generated records →
// reload → the engine accepts it, plus the 「是否助战」 switch writing the server's support pool.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer, UI_DIR } from '../editor/server.mjs';
import { startServer } from '../server/index.js';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { checkSupport, normalizeSupportConfig } from '../shared/support.js';
import { TILE_PALETTE } from '../shared/stageAuthoring.js';
import { attrPowerOf, battleEffectivenessOf } from '../shared/enemyAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const SPEC = {
  id: 'editor_made',
  name: '编辑器干员',
  tier: 5,
  profession: 'SNIPER',
  subProfessionId: 'fastshot',
  position: 'RANGED',
  stats: {
    normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 1, bat: 1.0 },
    golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 1, bat: 1.0 },
  },
  skill: { name: '试作', desc: '攻击力+50%', skillType: 'MANUAL', durationType: 'NONE', spType: 'INCREASE_WITH_TIME', spCost: 25, initSp: 10, duration: 15, bb: { atk: 0.5 } },
};

const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let tmp;
let wsRoot;
let supportFile;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });
  // a throwaway copy of the support config, so these tests never rewrite the repo's data/support.json
  supportFile = join(tmp, 'support.json');
  fs.copyFileSync(join(DATA_DIR, 'support.json'), supportFile);
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile });
});
after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workshop editor: the option boundary (the client must not contain it)', () => {
  test('it lives outside public/, so the game server cannot serve it', async () => {
    assert.equal(fs.existsSync(join(ROOT, 'public/editor')), false, 'the editor must not live under public/');
    assert.equal(fs.existsSync(UI_DIR), true, 'the editor UI must exist');
    const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      for (const p of ['/editor/server.mjs', '/editor/ui/app.js', '/editor/ui/index.html', '/editor/']) {
        const res = await fetch(game.url + p);
        assert.equal(res.status, 404, `${p} must not be reachable from the game server`);
      }
      // the client's own files still work
      assert.equal((await fetch(`${game.url}/data/support.json`)).status, 200);
    } finally {
      await game.close();
    }
  });

  test('no game-client source references the editor', () => {
    const offenders = [];
    for (const file of [...walkJs(join(ROOT, 'public/js')), ...walkJs(join(ROOT, 'shared')), join(ROOT, 'public/index.html')]) {
      const text = fs.readFileSync(file, 'utf8');
      if (/workshop-editor|editor\/server|editor\/ui|\.\.\/editor/.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'the game client and shared code must not import the editor');
  });
});

describe('workshop editor: the API', () => {
  const api = (p, opts) => fetch(editor.url + p, opts);

  test('GET /api/state reports the root, the official operators and the support config', async () => {
    const r = await api('/api/state').then((x) => x.json());
    assert.equal(r.workshopRoot, wsRoot);
    assert.deepEqual(r.packs, []);
    assert.ok(r.officialChess.length > 100, 'the spine picker needs the official operators');
    assert.equal(r.support.enabled, true);
    assert.ok(r.officialChess.every((c) => c.id && c.name && Number.isInteger(c.tier)));
  });

  test('POST /api/preview derives and validates without writing anything', async () => {
    const good = await post(`${editor.url}/api/preview`, { spec: SPEC }).then((r) => r.json());
    assert.equal(good.ok, true, JSON.stringify(good.errors));
    assert.equal(good.base.chessId, 'chess_ws_editor_made_a');
    assert.equal(good.base.name, '编辑器干员');
    assert.equal(good.golden.stats.maxHp, 1800);
    const bad = await post(`${editor.url}/api/preview`, { spec: { ...SPEC, tier: 99, stats: {} } }).then((r) => r.json());
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 3);
    assert.equal(fs.existsSync(join(wsRoot, 'editor_made')), false, 'a preview must not write');
  });

  test('a spec with an unreadable blackboard key warns but still passes', async () => {
    const r = await post(`${editor.url}/api/preview`, { spec: { ...SPEC, skill: { ...SPEC.skill, bb: { atk: 0.5, nonsense_key: 1 } } } }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('nonsense_key')), JSON.stringify(r.warnings));
  });

  test('POST /operators creates the pack, the spec and the generated records', async () => {
    const r = await post(`${editor.url}/api/packs/my-pack/operators`, { spec: SPEC }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'editor_made');
    const packDir = join(wsRoot, 'my-pack');
    const manifest = JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8'));
    assert.equal(manifest.id, 'my-pack', 'the pack id must equal its directory name');
    assert.deepEqual(manifest.content, ['chess']);
    assert.equal(fs.existsSync(join(packDir, 'specs/editor_made.json')), true, 'the editable spec is the source of truth');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.deepEqual(Object.keys(records).sort(), ['chess_ws_editor_made_a', 'chess_ws_editor_made_b']);
  });

  test('the saved operator reaches the engine as a shop-eligible operator', async () => {
    const data = loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.visibleChess.includes('chess_ws_editor_made_a'));
    assert.equal(gd.tierOf('chess_ws_editor_made_a'), 5);
    assert.equal(gd.goldenIdOf('chess_ws_editor_made_a'), 'chess_ws_editor_made_b');
    assert.equal(data.chess['chess_ws_editor_made_a'].name, '编辑器干员');
  });

  test('GET /api/state now lists the operator as editor-managed', async () => {
    const r = await api('/api/state').then((x) => x.json());
    assert.equal(r.packs.length, 1);
    const pack = r.packs[0];
    assert.equal(pack.specs.length, 1);
    assert.equal(pack.specs[0].id, 'editor_made');
    const base = pack.operators.find((o) => o.chessId === 'chess_ws_editor_made_a');
    assert.equal(base.managed, true);
    assert.deepEqual(base.issues.filter((i) => i.severity === 'error'), []);
  });

  test('a record the editor does not own is preserved when a spec is saved', async () => {
    const packDir = join(wsRoot, 'my-pack');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    records['chess_ws_handwritten_a'] = { ...records['chess_ws_editor_made_a'], chessId: 'chess_ws_handwritten_a', baseId: 'chess_ws_handwritten_a', goldenId: null, name: '手工记录' };
    fs.writeFileSync(join(packDir, 'chess.json'), JSON.stringify(records));
    // re-save the spec: the hand-written record must survive
    await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, name: '改过名字' } });
    const after = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.equal(after['chess_ws_handwritten_a'].name, '手工记录', 'a record with no spec must never be destroyed');
    assert.equal(after['chess_ws_editor_made_a'].name, '改过名字', 'the spec owns its records and regenerates them');
  });

  test('the 是否助战 switch writes the server support pool, and checkSupport accepts it', async () => {
    const before = JSON.parse(fs.readFileSync(supportFile, 'utf8'));
    assert.equal((before.pool['5'] || []).includes('chess_ws_editor_made_a'), false);
    const on = await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_ws_editor_made_a', tier: 5, enabled: true }).then((r) => r.json());
    assert.equal(on.ok, true);
    const written = JSON.parse(fs.readFileSync(supportFile, 'utf8'));
    assert.ok(written.pool['5'].includes('chess_ws_editor_made_a'), 'the id must be in the tier-5 pool');
    assert.equal(written.note, before.note, 'unknown keys of the config must be preserved');
    // and the server-side validator accepts it against the merged data
    const data = loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
    const cfg = normalizeSupportConfig(written);
    const checked = checkSupport(['chess_ws_editor_made_a'], cfg, (id) => data.chess[id] || null);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    const off = await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_ws_editor_made_a', tier: 5, enabled: false }).then((r) => r.json());
    assert.equal(off.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(supportFile, 'utf8')).pool['5'].includes('chess_ws_editor_made_a'), false);
  });

  test('DELETE removes the spec and the records it owned', async () => {
    const r = await fetch(`${editor.url}/api/packs/my-pack/operators/editor_made`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(join(wsRoot, 'my-pack/specs/editor_made.json')), false);
    const records = JSON.parse(fs.readFileSync(join(wsRoot, 'my-pack/chess.json'), 'utf8'));
    assert.equal(records['chess_ws_editor_made_a'], undefined);
    assert.equal(records['chess_ws_editor_made_b'], undefined);
    assert.ok(records['chess_ws_handwritten_a'], 'the unowned record stays');
  });

  test('bad ids and unknown routes are refused', async () => {
    assert.equal((await post(`${editor.url}/api/packs/bad%20id/operators`, { spec: SPEC })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, id: '' } })).status, 400);
    assert.equal((await fetch(`${editor.url}/api/packs/x/operators/..%2F..%2Fetc`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${editor.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${editor.url}/../server/index.js`)).status, 404);
  });

  test("the editor's own UI is served (and only from its own directory)", async () => {
    const html = await api('/').then((r) => r.text());
    assert.match(html, /创意工坊编辑器/);
    assert.equal((await api('/app.js')).status, 200);
    // the 2D map placer is part of the editor, and only of the editor
    const placer = await api('/stage.html').then((r) => r.text());
    assert.match(placer, /工坊地图设计器/);
    assert.equal((await api('/stage.js')).status, 200);
    assert.equal((await fetch(`${editor.url}/../data/chess.json`)).status, 404, 'the editor must not become a file server');
  });

  test('a sibling spec that no longer derives cannot cause silent record loss', async () => {
    const packDir = join(wsRoot, 'my-pack');
    await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, id: 'keepme', name: 'Keep' } });
    const before = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.ok(before['chess_ws_keepme_a'], 'the fixture operator must exist');

    // break a DIFFERENT spec by hand: tier 7 and empty stats can never derive
    const brokenPath = join(packDir, 'specs', 'broken.json');
    fs.writeFileSync(brokenPath, JSON.stringify({ id: 'broken', name: 'B', tier: 7, profession: 'WARRIOR', position: 'MELEE', stats: { normal: {}, golden: {} } }));
    try {
      const res = await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, id: 'other', name: 'Other' } });
      assert.equal(res.status, 400, 'the save must be refused rather than write a pack that lost records');
      const body = await res.json();
      assert.ok(body.errors && body.errors.some((e) => e.slug === 'broken'), JSON.stringify(body));
      const after = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
      assert.ok(after['chess_ws_keepme_a'], 'an unrelated operator\'s records must survive a broken sibling spec');
    } finally {
      fs.rmSync(brokenPath);
    }
  });

  test('the support toggle validates the id and the tier it is given', async () => {
    assert.equal((await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_does_not_exist', tier: 5, enabled: true })).status, 400);
    // the client supplies the tier: a wrong one must not be persisted as junk config
    assert.equal((await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_char_5_01_a', tier: 6, enabled: true })).status, 400);
    assert.equal((await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_char_5_01_a', tier: 5, enabled: true })).status, 200);
    assert.ok(JSON.parse(fs.readFileSync(supportFile, 'utf8')).pool['5'].includes('chess_char_5_01_a'));
    await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_char_5_01_a', tier: 5, enabled: false });
  });
});

describe('workshop editor: maps (the 2D placer API)', () => {
  const stageSpec = () => ({
    id: 'ws_editor_map', name: '编辑器地图', weight: 40, modes: ['mode_multi_normal'],
    rows: Array.from({ length: 19 }, (_, r) => (r === 9 ? `S${'r'.repeat(19)}E` : 'r'.repeat(21))),
    tiles: Object.fromEntries(TILE_PALETTE.map((t) => [t.glyph, {
      tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable,
      groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE', special: t.special ?? null, bb: {},
    }])),
    devices: [{ key: 'trap_1105_accrate', pos: [11, 10], dir: 'UP', hidden: false, role: 'crate' }],
    options: { characterLimit: 8, moveMultiplier: 0.5 },
  });

  test('GET /api/stages exposes the palette, the grid size and the assignable modes', async () => {
    const r = await fetch(`${editor.url}/api/stages`).then((x) => x.json());
    assert.deepEqual(r.size, [19, 21]);
    assert.ok(r.palette.length > 10, 'the placer needs the palette');
    assert.ok(r.modes.length > 0, 'the placer needs the modes a map can be assigned to');
    assert.ok(r.modes.every((m) => m.id && m.name));
  });

  test('POST /api/stages/preview derives the paths without writing', async () => {
    const r = await post(`${editor.url}/api/stages/preview`, { spec: stageSpec() }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(Object.keys(r.record.groundPaths).length > 0, 'the sim must derive ground routes');
    assert.ok(r.record.deployTiles.normal.melee.length > 0);
    assert.equal(fs.existsSync(join(wsRoot, 'map-pack')), false, 'a preview must not write');
  });

  test('saving writes the spec and the generated record; deleting removes them', async () => {
    const saved = await post(`${editor.url}/api/packs/map-pack/stages`, { spec: stageSpec() }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const packDir = join(wsRoot, 'map-pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).content, ['stages']);
    assert.equal(fs.existsSync(join(packDir, 'stage-specs/ws_editor_map.json')), true, 'the spec is the editable source');
    assert.ok(JSON.parse(fs.readFileSync(join(packDir, 'stages.json'), 'utf8')).ws_editor_map.groundPaths, 'the generated record carries the derived paths');

    const listed = await fetch(`${editor.url}/api/stages`).then((x) => x.json());
    const found = listed.stages.find((s) => s.id === 'ws_editor_map');
    assert.ok(found && found.managed, 'the map must be listed as editor-managed');
    assert.deepEqual(found.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(found.deployMelee > 0, true);

    const del = await fetch(`${editor.url}/api/packs/map-pack/stages/ws_editor_map`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(join(packDir, 'stages.json'), 'utf8')).ws_editor_map, undefined);
  });

  test('an invalid map is refused with the reason', async () => {
    const bad = await post(`${editor.url}/api/packs/map-pack/stages`, { spec: { ...stageSpec(), rows: ['rrr'] } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'BAD_SIZE'), 'the size error must be reported');
    assert.equal((await post(`${editor.url}/api/packs/map-pack/stages`, { spec: { ...stageSpec(), id: 'has spaces' } })).status, 400);
  });

  test('routes travel in the spec, and the preview returns the sim walk for each', async () => {
    const spec = { ...stageSpec(), routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }] };
    const pv = await post(`${editor.url}/api/stages/preview`, { spec }).then((x) => x.json());
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));
    assert.equal(pv.routePaths.length, 1, 'one authored route → one derived walk');
    assert.ok(Array.isArray(pv.routePaths[0].path) && pv.routePaths[0].path.length > 1, 'the sim must find a ground walk');
    assert.deepEqual(pv.routePaths[0].path[0], [9, 0]);
    assert.deepEqual(pv.routePaths[0].path.at(-1), [9, 20]);
    // routes belong to the WAVE, not to the stage record
    assert.equal(Object.hasOwn(pv.record, 'routes'), false);

    const saved = await post(`${editor.url}/api/packs/map-pack/stages`, { spec }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const stored = JSON.parse(fs.readFileSync(join(wsRoot, 'map-pack', 'stage-specs', 'ws_editor_map.json'), 'utf8'));
    assert.deepEqual(stored.routes, spec.routes, 'the placer must be able to re-open what it drew');
    // and a route nothing can walk is refused
    const walled = { ...spec, rows: Array.from({ length: 19 }, () => `${'r'.repeat(10)}X${'r'.repeat(10)}`) };
    walled.rows[9] = `S${'r'.repeat(9)}X${'r'.repeat(9)}E`;
    const blocked = await post(`${editor.url}/api/stages/preview`, { spec: walled }).then((x) => x.json());
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some((e) => e.code === 'ROUTE_NOPATH'), JSON.stringify(blocked.errors));
  });
});

describe('workshop editor: monsters (the enemy form API)', () => {
  const enemySpec = () => ({
    id: 'frost_hound', name: '霜牙猎犬', rank: 'ELITE', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys',
    desc: '被源石侵蚀的猎犬。',
    stats: { maxHp: 4200, atk: 620, def: 180, res: 20, moveSpeed: 1.6, bat: 1.3, blockCnt: 1, massLevel: 2 },
    abilities: [{ text: '无法被阻挡' }, { text: '被击倒时使周围减速' }],
    talents: { bb: { move_speed: 0.3 } }, skills: [], tags: ['origen'],
    immunities: { silence: true, frozen: true }, spine: 'enemy_1007_slime', beFactor: 1,
  });

  test('GET /api/enemies exposes the vocabularies the form renders and the official keys', async () => {
    const r = await fetch(`${editor.url}/api/enemies`).then((x) => x.json());
    for (const k of ['ranks', 'motions', 'dmgTypes', 'applyWays', 'acTypes', 'immunities', 'statDefaults']) {
      assert.ok(r.vocab[k] && (Array.isArray(r.vocab[k]) ? r.vocab[k].length : Object.keys(r.vocab[k]).length), `vocab.${k} is empty`);
    }
    assert.ok(r.officialEnemies.length > 100, 'the official roster must be listed for the collision check');
  });

  test('preview derives attrPower and be without writing', async () => {
    const r = await post(`${editor.url}/api/enemies/preview`, { spec: enemySpec() }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.record.key, 'enemy_ws_frost_hound');
    assert.equal(r.record.attrPower, attrPowerOf(r.record.stats));
    assert.equal(r.record.be, battleEffectivenessOf(r.record.stats, 1));
    assert.equal(r.record.tokenOnly, false, 'a workshop monster is spawned by a wave, not only by a token');
    assert.equal(fs.existsSync(join(wsRoot, 'monster-pack')), false, 'a preview must not write');
  });

  test('saving writes the spec and the generated record; deleting removes them', async () => {
    const saved = await post(`${editor.url}/api/packs/monster-pack/enemies`, { spec: enemySpec() }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.key, 'enemy_ws_frost_hound');
    const packDir = join(wsRoot, 'monster-pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).content, ['enemies']);
    assert.equal(fs.existsSync(join(packDir, 'enemy-specs/frost_hound.json')), true, 'the spec is the editable source');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'enemies.json'), 'utf8'));
    assert.ok(records['enemy_ws_frost_hound'].attrPower, 'the generated record carries the derived metrics');

    const listed = await fetch(`${editor.url}/api/enemies`).then((x) => x.json());
    const found = listed.enemies.find((e) => e.key === 'enemy_ws_frost_hound');
    assert.ok(found && found.managed);
    assert.deepEqual(found.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(found.abilities, 2);

    const del = await fetch(`${editor.url}/api/packs/monster-pack/enemies/enemy_ws_frost_hound`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(join(packDir, 'enemies.json'), 'utf8'))['enemy_ws_frost_hound'], undefined);
  });

  test('an invalid monster is refused with the reason', async () => {
    const bad = await post(`${editor.url}/api/packs/monster-pack/enemies`, { spec: { ...enemySpec(), stats: { maxHp: -1 } } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'BAD_NUMBER'), 'the number error must be reported');
    assert.equal((await post(`${editor.url}/api/packs/monster-pack/enemies`, { spec: { ...enemySpec(), id: '!!!' } })).status, 400);
  });

  test('the monster page is part of the editor, and only of the editor', async () => {
    const html = await fetch(`${editor.url}/enemy.html`).then((r) => r.text());
    assert.match(html, /工坊怪物编辑器/);
    assert.equal((await fetch(`${editor.url}/enemy.js`)).status, 200);
  });
});
