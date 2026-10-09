// test/workshopKits.test.js — the 行为层: a pack's `kits/<chessId>.js` reaching battle.on(...) (docs/WORKSHOP.md §4).
//
// The behaviour layer is a pack's JavaScript. It is injected per battle through `Battle opts.kits` — the sanctioned hook
// that server/sim/content/index.js setupUnitKit consults BEFORE the built-in registry — so nothing global is mutated.
//
// It has TWO consumers that must agree, and both are checked here:
//   * the server, for the battles it runs itself (and for verifying a client's result);
//   * the browser, which cannot receive a function over the wire and therefore rebuilds the map from the JSON-safe URL
//     list the battle spec carries (public/js/battle/runner.js loadSpecKits).
// Shipping only the server half would make a client-simulated battle disagree with the server and get rejected.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildBattleSpec } from '../server/sim/spec.js';
import { setupUnitKit } from '../server/sim/content/index.js';
import { startServer, workshopKitFilesFor } from '../server/index.js';
import { makeMatch, give, legalTileFor } from './match/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const BASE = 'chess_ws_kitprobe_a';
const GOLD = 'chess_ws_kitprobe_b';

/** The pack's kit: it installs a talent, which is how a pack runs arbitrary code through the hook bus. */
const KIT_SRC = `export default function kit() {
  return { talents: [{ install() { globalThis.__wsKitInstalls = (globalThis.__wsKitInstalls || 0) + 1; } }] };
}
`;

const SPEC = {
  id: 'kitprobe',
  name: '行为层探针',
  tier: 5,
  profession: 'WARRIOR',
  subProfessionId: 'sword',
  position: 'MELEE',
  stats: {
    normal: { maxHp: 2000, atk: 500, def: 200, res: 0, cost: 18, blockCnt: 2, bat: 1.2 },
    golden: { maxHp: 2600, atk: 650, def: 260, res: 0, cost: 18, blockCnt: 2, bat: 1.2 },
  },
  skill: null,
};

let tmp;
let wsRoot;
let loaded;
let kitInfo;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-kits-'));
  wsRoot = join(tmp, 'workshop');
  const packDir = join(wsRoot, 'probe-pack');
  fs.mkdirSync(join(packDir, 'kits'), { recursive: true });
  fs.writeFileSync(join(packDir, 'pack.json'), JSON.stringify({ id: 'probe-pack', name: 'Probe', version: '0.1.0', content: ['chess'], overrides: [] }));
  // derive the operator records with the same authoring layer the editor and CLIs use
  const { deriveChessRecord } = await import('../shared/chessAuthoring.js');
  const d = deriveChessRecord(SPEC);
  assert.equal(d.ok, true, JSON.stringify(d.errors));
  fs.writeFileSync(join(packDir, 'chess.json'), JSON.stringify({ [d.base.chessId]: d.base, [d.golden.chessId]: d.golden }));
  fs.writeFileSync(join(packDir, 'kits', `${d.base.chessId}.js`), KIT_SRC);
  fs.writeFileSync(join(packDir, 'kits', 'chess_ws_nowhere_a.js'), KIT_SRC);        // no such record → reported
  // a broken module for a KNOWN id: the unknown-id check runs first (dead code is never imported), so the export check
  // is only reached for an id that exists — that is the path this fixture exercises
  fs.writeFileSync(join(packDir, 'kits', `${GOLD}.js`), 'export default 1;\n');
  loaded = loadWorkshop(wsRoot, { log: quiet });
  assert.equal(loaded.packs.length, 1);
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('行为层: loading a pack\'s kits', () => {
  test('a default-exported kit function is loaded and gets a browser URL', async () => {
    kitInfo = await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set([BASE, GOLD]) });
    assert.equal(typeof kitInfo.kits[BASE], 'function');
    assert.equal(kitInfo.modules.length, 1);
    assert.equal(kitInfo.modules[0].id, BASE);
    assert.equal(kitInfo.modules[0].pack, 'probe-pack');
    // the URL carries a cache-buster: a browser that already loaded the module must pick up an edited kit, or it would
    // run old code against a server that verifies with the new code
    assert.match(kitInfo.modules[0].url, new RegExp(`^/workshop-kits/probe-pack/${BASE}\\.js\\?v=\\d+$`));
  });

  test('a kit whose operator does not exist, and a module that exports no function, are reported not fatal', async () => {
    const bad = kitInfo ?? await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set([BASE, GOLD]) });
    const reasons = bad.errors.map((e) => `${e.id}: ${e.reason}`);
    assert.equal(bad.errors.length, 2, reasons.join(' | '));
    assert.match(reasons.join(' | '), /chess_ws_nowhere_a: no chess record/);
    assert.match(reasons.join(' | '), new RegExp(`${GOLD}: the module must default-export`));
    assert.equal(bad.kits.chess_ws_nowhere_a, undefined);
    assert.equal(bad.kits[GOLD], undefined);
  });

  test('without a knownIds set, an id the pack does not contribute is still refused (overrides rule)', async () => {
    const all = await loadWorkshopKits(loaded, { log: quiet });
    // the pack ships no chess record with this id, so accepting the kit would let it rewrite behaviour for an operator
    // it does not own — the data layer demands `overrides` for that, and now the behaviour layer does too
    const nowhere = all.errors.find((e) => e.id === 'chess_ws_nowhere_a');
    assert.ok(nowhere, JSON.stringify(all.errors));
    assert.match(nowhere.reason, /overrides/);
    assert.equal(all.kits.chess_ws_nowhere_a, undefined);
    // GOLD IS owned by the pack, so its broken module is reported as a bad export rather than as an ownership problem
    assert.ok(all.errors.some((e) => e.id === GOLD && /default-export/.test(e.reason)), JSON.stringify(all.errors));
  });

  test('a kit named after an OFFICIAL operator needs a declared override', async () => {
    const officialId = 'chess_char_1_01_a';
    const dir = join(wsRoot, 'override-pack');
    fs.mkdirSync(join(dir, 'kits'), { recursive: true });
    fs.writeFileSync(join(dir, 'kits', `${officialId}.js`), KIT_SRC);
    fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({
      [BASE]: { chessId: BASE, baseId: BASE, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 1, atk: 1, def: 1, res: 0, cost: 1, blockCnt: 1, bat: 1 }, talents: [], bonds: [] },
    }));
    const writeManifest = (overrides) => fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id: 'override-pack', name: 'O', version: '0.1.0', content: ['chess'], overrides }));
    try {
      writeManifest([]);
      const undeclared = await loadWorkshopKits(loadWorkshop(wsRoot, { log: quiet }), { log: quiet });
      assert.ok(undeclared.errors.some((e) => e.id === officialId && /overrides/.test(e.reason)), JSON.stringify(undeclared.errors));
      assert.equal(undeclared.kits[officialId], undefined, 'an official kit must not be replaced without a declaration');

      writeManifest([`chess:${officialId}`]);
      const declared = await loadWorkshopKits(loadWorkshop(wsRoot, { log: quiet }), { log: quiet });
      assert.equal(typeof declared.kits[officialId], 'function', 'a declared override is honoured');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 归因 + 归一（DESIGN §28.3）：kit id 撞车必须**点名占位的那一个包**，而且赢家由包 id 决定，不由扫描顺序决定。
  test('two packs shipping the same kit id: the smaller pack id wins, and the report names the holder', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'sp-kit-tie-'));
    const REC = { chessId: BASE, baseId: BASE, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 1, atk: 1, def: 1, res: 0, cost: 1, blockCnt: 1, bat: 1 }, talents: [], bonds: [] };
    const pack = (id) => {
      const dir = join(root, id);
      fs.mkdirSync(join(dir, 'kits'), { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id, name: id, version: '0.1.0', content: ['chess'], overrides: [] }));
      fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify({ [BASE]: REC }));
      fs.writeFileSync(join(dir, 'kits', `${BASE}.js`), KIT_SRC);
      // what loadWorkshop would hand over: each pack OWNS the operator it kits, so ownership is not what refuses this
      return { id, dir, overrides: [], files: { chess: { [BASE]: REC } } };
    };
    const zeta = pack('zeta-kit');   // 数组里在前，但包 id 更大
    const alpha = pack('alpha-kit');
    try {
      for (const packs of [[zeta, alpha], [alpha, zeta]]) {
        const info = await loadWorkshopKits({ packs }, { log: quiet, knownIds: new Set([BASE]) });
        const hit = info.errors.find((e) => e.id === BASE);
        assert.ok(hit, JSON.stringify(info.errors));
        assert.equal(hit.code, 'KIT_ID_COLLISION');
        assert.equal(hit.pack, 'zeta-kit', 'the pack that lost is the one blamed');
        assert.equal(hit.definedBy, 'alpha-kit', 'and the winner is named in a field, not only in prose');
        assert.match(hit.reason, /pack "alpha-kit"/);
        assert.equal(info.modules.length, 1);
        assert.equal(info.modules[0].pack, 'alpha-kit', 'the smaller pack id owns the id');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('行为层: the injection point (battle.opts.kits wins over the registry)', () => {
  test('setupUnitKit returns the pack kit for its operator', () => {
    const seen = [];
    const kitFn = (bb, chess, def) => { seen.push(def.baseId); return { talents: [], marker: 'pack' }; };
    const battle = { opts: { kits: { [BASE]: kitFn } }, _handlerError() {} };
    const unit = { kind: 'op', def: { baseId: BASE, id: BASE, skill: { bb: {} }, raw: { stats: { maxHp: 1 } } } };
    const kit = setupUnitKit(battle, unit);
    assert.equal(kit.marker, 'pack');
    assert.deepEqual(seen, [BASE]);
  });

  test('a spec carries the JSON-safe module list (and drops malformed entries)', () => {
    const spec = buildBattleSpec({ workshopKits: [
      { id: BASE, pack: 'p', url: '/workshop-kits/p/x.js' },
      { id: 'bad' },                       // no url
      null,
      { id: 'bad2', url: 5 },              // url is not a string
    ] });
    assert.deepEqual(spec.workshopKits, [{ id: BASE, pack: 'p', url: '/workshop-kits/p/x.js' }]);
    // and a plain install carries an empty list, so nothing changes without packs
    assert.deepEqual(buildBattleSpec({}).workshopKits, []);
  });
});

describe('行为层: a real battle runs the pack\'s code', () => {
  test('the kit is installed on a deployed operator in a real battle', async () => {
    const info = kitInfo ?? await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set([BASE, GOLD]) });
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });
    assert.ok(data.chess[BASE], 'the probe operator must be in the merged data');
    assert.ok(data.chess[BASE].workshop, 'it must be recognisably workshop content');
    globalThis.__wsKitInstalls = 0;
    const h = makeMatch({
      mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 41, data,
      workshopKits: info.kits,
      workshopKitModules: info.modules,
    });
    h.start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    const tile = legalTileFor(h.m, ps, BASE);
    assert.ok(tile, 'no legal tile for the probe operator');
    give(h.m, ps, BASE, 'board', tile);
    assert.ok(h.drive(() => h.m.round >= 2 || h.ended != null), `stuck at ${h.m.phase} R${h.m.round}`);
    assert.deepEqual(h.logs.error, []);
    assert.ok(globalThis.__wsKitInstalls > 0, 'the pack kit must run in a real battle');
    delete globalThis.__wsKitInstalls;
  });
});

describe('行为层: delivery to the browser', () => {
  test('the kit module is served as JavaScript at the URL the spec carries', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const url = `/workshop-kits/probe-pack/${BASE}.js`;
      const res = await fetch(srv.url + url);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /javascript/);
      const text = await res.text();
      assert.match(text, /export default function kit/);
      // only registered URLs are servable: the game server must not become a file server
      for (const p of ['/workshop-kits/probe-pack/../chess.json', '/workshop-kits/probe-pack/nope.js', '/workshop-kits/', '/workshop-kits/probe-pack/kits/x.js']) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
    } finally {
      await srv.close();
    }
  });

  test('the URL → file map is built from the loaded modules only', () => {
    const map = workshopKitFilesFor([{ id: BASE, pack: 'probe-pack', url: `/workshop-kits/probe-pack/${BASE}.js` }], wsRoot);
    const abs = map.get(`/workshop-kits/probe-pack/${BASE}.js`);
    assert.ok(abs && fs.existsSync(abs), 'the mapped file must exist on disk');
    assert.equal(workshopKitFilesFor([{ id: 'x', pack: 'p' }], wsRoot).size, 0);
    assert.equal(workshopKitFilesFor(null, wsRoot).size, 0);
  });

  test('the runner rebuilds the map from spec.workshopKits (client wiring present)', () => {
    const src = fs.readFileSync(join(ROOT, 'public/js/battle/runner.js'), 'utf8');
    assert.match(src, /export async function loadSpecKits/);
    assert.match(src, /spec\s*&&\s*spec\.workshopKits|spec\.workshopKits/);
    // 上游 0.2.1 把战斗启动重写成「待处理表 + prepare()」，参数从 `msg` 变成条目 `e`：
    // 这条断言钉的是**工坊 kits 必须挂在真正构造战斗的那一处**（否则工坊行为层会静默失效）。
    assert.match(src, /createBattleFromSpec\(e\.spec, sim\.ds, \{ logger, kits \}\)/);
    assert.match(src, /import\(\/\* @vite-ignore \*\/ m\.url\)/);
  });
});

describe('行为层: the shipped example kit (docs/examples/kit-demo)', () => {
  const EX_BASE = 'chess_ws_abyss_hunter_a';

  test('it loads, keeps its skill, and applies its talent through a documented engine helper', async () => {
    const loadedEx = loadWorkshop(join(ROOT, 'docs/examples'), { log: quiet });
    assert.ok(loadedEx.packs.some((p) => p.id === 'kit-demo'), 'the example pack must exist');
    const info = await loadWorkshopKits(loadedEx, { log: quiet });
    assert.deepEqual(info.errors, []);
    const kitFn = info.kits[EX_BASE];
    assert.equal(typeof kitFn, 'function');
    assert.deepEqual(info.modules.map((m) => m.id), [EX_BASE]);

    const buffs = [];
    const fake = { addBuff: (u, b) => buffs.push(b), opts: { kits: { [EX_BASE]: kitFn } }, _handlerError() {} };
    const bb = { atk: 0.6, attack_speed: 40, atk_scale: 1.6, trigger_time: 8 };
    const unit = { kind: 'op', def: { baseId: EX_BASE, id: EX_BASE, skill: { bb }, raw: {} } };
    const kit = setupUnitKit(fake, unit);
    // rule 1: a kit owns the skill — omitting it would leave the operator with NO skill (Battle: u.kit.skill || null)
    assert.equal(kit.skill.kind, 'ammo');
    assert.equal(kit.skill.ammo, 8);
    assert.equal(kit.skill.mods.atkPct, 0.6);
    for (const t of kit.talents || []) t.install(fake, unit);
    assert.equal(buffs.length, 1);
    assert.deepEqual(buffs[0].mods, { atkPct: 0.25 });
    assert.equal(buffs[0].duration, Infinity);
  });

  test('a pack kit stays self-contained (the same file is loaded from two different roots)', () => {
    const src = fs.readFileSync(join(ROOT, 'docs/examples/kit-demo/kits', `${EX_BASE}.js`), 'utf8');
    assert.equal(/^\s*import\s/m.test(src), false, 'a pack kit must not import engine modules: server and browser resolve them differently');
  });
});
