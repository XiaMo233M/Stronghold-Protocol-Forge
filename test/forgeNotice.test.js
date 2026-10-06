// test/forgeNotice.test.js — the authorship stamp the Forge editor writes into every Option (shared/forgeNotice.js).
//
// Two things this pins, and they pull in opposite directions:
//
//   1. the stamp must be PRESENT and complete in every Option an author saves — author, creation time, source, the
//      copyright statement and the anti-resale statement. A statement that lives only in a README does not travel with
//      a file, which is the entire reason this exists.
//   2. the stamp must NOT reach the generated record the game reads. `_meta` is metadata about the Option, not game
//      data; leaking it would put an authorship notice into `stages.json` / `chess.json` and from there onto the wire.
//
// And one licensing line that is easy to get wrong: `_meta` describes the creative content, it is not an extra
// restriction on the program. The code stays GPL-3.0-or-later, so the module must not claim to license anything.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { FORGE_SOURCE, FORGE_META_SCHEMA, forgeMeta, withForgeMeta, forgeNoticeText, forgeMetaLine } from '../shared/forgeNotice.js';
import { TILE_PALETTE } from '../shared/stageAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A known-good map spec: 19 rows × 21 columns, glyphs from the real palette (the editor's own fixture shape). */
const STAGE = {
  id: 'forge_map', name: '署名测试图', weight: 40, modes: ['mode_multi_normal'],
  rows: Array.from({ length: 19 }, (_, r) => (r === 9 ? `S${'r'.repeat(19)}E` : 'r'.repeat(21))),
  tiles: Object.fromEntries(TILE_PALETTE.map((t) => [t.glyph, {
    tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable,
    groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE', special: t.special ?? null, bb: {},
  }])),
  devices: [],
  options: { characterLimit: 8, moveMultiplier: 0.5 },
  routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }],
};

describe('forge notice: the _meta block', () => {
  test('it carries all five things the notice requires', () => {
    const meta = forgeMeta({ author: '水沫沐沐', packId: 'my-pack', now: '2026-03-04T05:06:07.000Z' });
    assert.equal(meta.schema, FORGE_META_SCHEMA);
    assert.equal(meta.source, FORGE_SOURCE);          // 来源
    assert.equal(meta.author, '水沫沐沐');              // 作者
    assert.equal(meta.created, '2026-03-04T05:06:07.000Z'); // 创建时间
    assert.match(meta.copyright.zh, /著作权归创建它的作者本人所有/); // 著作权声明
    assert.match(meta.copyright.en, /property of the author/);
    assert.match(meta.antiResale.zh, /打包、转售或批量分发/);        // 反打包转售声明
    assert.match(meta.antiResale.en, /package, resell, or bulk-distribute/);
  });

  test('the creation time survives later saves — an edit is not a new Option', () => {
    const first = forgeMeta({ author: '水沫沐沐', now: '2026-03-04T05:06:07.000Z' });
    const second = forgeMeta({ author: '水沫沐沐', now: '2026-09-09T09:09:09.000Z', previous: first });
    assert.equal(second.created, first.created, 'created must not be reset by a later edit');
    assert.equal(second.modified, '2026-09-09T09:09:09.000Z');
  });

  test('a hand-edited or absent previous stamp cannot poison a re-save', () => {
    for (const previous of [null, {}, { created: 'yesterday' }, { created: 42 }, { _meta: { created: 'not a date' } }]) {
      const meta = forgeMeta({ now: '2026-03-04T05:06:07.000Z', previous });
      assert.equal(meta.created, '2026-03-04T05:06:07.000Z', JSON.stringify(previous));
    }
    // …but a real nested `_meta` (a whole previous spec) is honoured
    const nested = forgeMeta({ now: '2026-03-04T05:06:07.000Z', previous: { _meta: { created: '2020-01-01T00:00:00.000Z' } } });
    assert.equal(nested.created, '2020-01-01T00:00:00.000Z');
  });

  test('an unknown author is recorded as unnamed, never invented', () => {
    assert.equal(forgeMeta({ now: '2026-03-04T05:06:07.000Z' }).author, '未署名 (anonymous)');
    assert.equal(forgeMeta({ author: '   ', now: '2026-03-04T05:06:07.000Z' }).author, '未署名 (anonymous)');
    // a name from a previous stamp is kept when the caller has none (the pack manifest may have been cleared)
    assert.equal(forgeMeta({ now: '2026-03-04T05:06:07.000Z', previous: { author: '旧作者' } }).author, '旧作者');
  });

  test('withForgeMeta does not mutate the spec it was given', () => {
    const spec = { id: 'x', name: 'y' };
    const stamped = withForgeMeta(spec, { author: 'a', packId: 'p', now: '2026-03-04T05:06:07.000Z' });
    assert.equal(spec._meta, undefined, 'the caller may still be deriving from the original');
    assert.equal(stamped._meta.author, 'a');
    assert.equal(stamped.id, 'x');
    assert.equal(withForgeMeta(null), null, 'a non-object passes through; the save path reports it');
  });

  test('the notice text states the scope, so it cannot be read as restricting the GPL code', () => {
    const text = forgeNoticeText();
    assert.match(text, /不改变本项目代码的 GPL-3\.0-or-later 授权/);
    assert.match(text, /只针对 Option 创作内容/);
    assert.match(forgeMetaLine({ _meta: forgeMeta({ author: 'a', now: '2026-03-04T05:06:07.000Z' }) }), /a · 创建 2026-03-04/);
    assert.match(forgeMetaLine({}), /还没有署名信息/);
  });
});

describe('forge notice: the editor writes it, and only into the source spec', () => {
  let tmp;
  let wsRoot;
  let editor;
  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-forge-'));
    wsRoot = join(tmp, 'workshop');
    fs.mkdirSync(wsRoot, { recursive: true });
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'), forgeAuthor: '水沫沐沐' });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a saved map carries the stamp, and the manifest records its author', async () => {
    const saved = await post(`${editor.url}/api/packs/forge-pack/stages`, { spec: STAGE }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const packDir = join(wsRoot, 'forge-pack');
    const spec = JSON.parse(fs.readFileSync(join(packDir, 'stage-specs/forge_map.json'), 'utf8'));
    assert.equal(spec._meta.author, '水沫沐沐');
    assert.equal(spec._meta.source, FORGE_SOURCE);
    assert.equal(spec._meta.pack, 'forge-pack');
    assert.match(spec._meta.copyright.zh, /著作权/);
    assert.match(spec._meta.antiResale.en, /bulk-distribute/);
    assert.equal(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).author, '水沫沐沐');
  });

  test('THE GUARD: the stamp never reaches the generated record the game reads', async () => {
    const packDir = join(wsRoot, 'forge-pack');
    const generated = JSON.parse(fs.readFileSync(join(packDir, 'stages.json'), 'utf8'));
    const rec = generated.forge_map;
    assert.ok(rec, 'the record must exist');
    assert.equal(rec._meta, undefined, 'game data must not carry an authorship notice');
    assert.equal(JSON.stringify(generated).includes('antiResale'), false, 'nor anywhere else in the file');
    // …and it survives the real loader + engine, which is what the game actually reads
    const { loadData } = await import('../server/data.js');
    const data = loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
    assert.ok(data.stages.forge_map, 'the merged map must exist');
    assert.equal(data.stages.forge_map._meta, undefined);
  });

  test('re-saving keeps created and moves modified — the editor does not reset an author\'s date', async () => {
    const packDir = join(wsRoot, 'forge-pack');
    const specPath = join(packDir, 'stage-specs/forge_map.json');
    const first = JSON.parse(fs.readFileSync(specPath, 'utf8'))._meta;
    // make the two instants clearly distinguishable without sleeping a whole second
    const edited = { ...first, created: '2020-01-02T03:04:05.000Z' };
    const withOld = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    withOld._meta = edited;
    fs.writeFileSync(specPath, JSON.stringify(withOld, null, 2));
    await post(`${editor.url}/api/packs/forge-pack/stages`, { spec: { ...STAGE, name: '改名了' } });
    const second = JSON.parse(fs.readFileSync(specPath, 'utf8'))._meta;
    assert.equal(second.created, '2020-01-02T03:04:05.000Z', 'created must survive the edit');
    assert.notEqual(second.modified, second.created);
    assert.equal(JSON.parse(fs.readFileSync(specPath, 'utf8')).name, '改名了');
  });

  test('every kind the editor can save is stamped, not just maps', async () => {
    const enemy = { id: 'forge_hound', name: 'x', rank: 'NORMAL', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys', stats: { maxHp: 100, atk: 10, def: 0, res: 0, moveSpeed: 1, bat: 1.2 } };
    const wave = { id: 'forge_wave', kind: 'normal', routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }], spawns: [{ time: 1, key: 'enemy_1007_slime', count: 1, interval: 0, routeIndex: 0, slot: 'N' }] };
    const item = { id: 'forge_charm', name: 'x', tier: 2, price: 5, upgradeNum: 0, buffs: [{ key: 'k', bb: { atk: 0.1 } }] };
    const operator = {
      id: 'forge_op', name: 'x', tier: 4, profession: 'SNIPER', subProfessionId: 'fastshot', position: 'RANGED',
      stats: { normal: { maxHp: 1000, atk: 300, def: 100, res: 0, cost: 15, blockCnt: 1, bat: 1 }, golden: { maxHp: 1300, atk: 400, def: 130, res: 0, cost: 15, blockCnt: 1, bat: 1 } },
      skill: { name: 's', desc: 'd', skillType: 'MANUAL', durationType: 'NONE', spType: 'INCREASE_WITH_TIME', spCost: 20, initSp: 5, duration: 10, bb: { atk: 0.3 } },
    };
    const cases = [
      ['enemies', 'enemy-specs/forge_hound.json', enemy],
      ['waves', 'wave-specs/forge_wave.json', wave],
      ['items', 'item-specs/forge_charm.json', item],
      ['operators', 'specs/forge_op.json', operator],
    ];
    for (const [endpoint, rel, spec] of cases) {
      const r = await post(`${editor.url}/api/packs/forge-pack/${endpoint}`, { spec }).then((x) => x.json());
      assert.equal(r.ok, true, `${endpoint}: ${JSON.stringify(r)}`);
      const written = JSON.parse(fs.readFileSync(join(wsRoot, 'forge-pack', rel), 'utf8'));
      assert.ok(written._meta, `${endpoint} spec must be stamped`);
      assert.equal(written._meta.author, '水沫沐沐', endpoint);
      assert.equal(written._meta.source, FORGE_SOURCE, endpoint);
    }
    // and none of the four artifacts may carry it
    for (const file of ['enemies.json', 'waves.json', 'items.json', 'chess.json']) {
      const text = fs.readFileSync(join(wsRoot, 'forge-pack', file), 'utf8');
      assert.equal(text.includes('antiResale'), false, `${file} must not carry the notice`);
    }
  });

  test('without an author anywhere, the stamp says so instead of guessing', async () => {
    const bare = await createEditorServer({ workshopRoot: join(tmp, 'ws2'), port: 0, host: '127.0.0.1', supportFile: join(tmp, 's2.json') });
    try {
      fs.mkdirSync(join(tmp, 'ws2'), { recursive: true });
      await post(`${bare.url}/api/packs/anon-pack/stages`, { spec: STAGE });
      const spec = JSON.parse(fs.readFileSync(join(tmp, 'ws2/anon-pack/stage-specs/forge_map.json'), 'utf8'));
      assert.equal(spec._meta.author, '未署名 (anonymous)');
    } finally {
      await bare.close();
    }
  });
});
