// test/workshopKits.test.js — the 行为层: a pack's `kits/<id>.js` reaching battle.on(...) (docs/WORKSHOP.md §4).
//
// The behaviour layer is a pack's JavaScript. It is injected per battle through `Battle opts.kits` (operators) or
// `Battle opts.tokenKits` (summons) — the sanctioned hooks that server/sim/content/index.js setupUnitKit consults
// BEFORE the built-in registries (§4.7: one file-name rule over two key spaces) — so nothing global is mutated.
//
// It has TWO consumers that must agree, and both are checked here:
//   * the server, for the battles it runs itself (and for verifying a client's result);
//   * the browser, which cannot receive a function over the wire and therefore rebuilds BOTH maps from the JSON-safe URL
//     list the battle spec carries (public/js/battle/runner.js loadSpecKits; a summon module carries `kind: 'token'`).
// Shipping only the server half would make a client-simulated battle disagree with the server and get rejected.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadWorkshop, loadWorkshopKits } from '../server/workshop.js';
import { loadData } from '../server/data.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { Battle } from '../server/sim/Battle.js';
import { setupUnitKit } from '../server/sim/content/index.js';
import { startServer, workshopKitFilesFor, workshopKitDirsFor } from '../server/index.js';
import { PHASE } from '../shared/constants.js';
import { makeMatch, give, legalTileFor } from './match/harness.js';
import { FakeBattle } from './match/fakeBattle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const BASE = 'chess_ws_kitprobe_a';
const GOLD = 'chess_ws_kitprobe_b';
/** The summon key space of the same channel (docs/WORKSHOP.md §4.7): a kit keyed by a token record id. */
const TOKEN_ID = 'token_ws_kitprobe';
/** An official token id every install carries — a pack reaches it only through `overrides` (`tokens:<id>`). */
const OFFICIAL_TOKEN = 'token_10000_silent_healrb';

/** The pack's kit: it installs a talent, which is how a pack runs arbitrary code through the hook bus. */
const KIT_SRC = `export default function kit() {
  return { talents: [{ install() { globalThis.__wsKitInstalls = (globalThis.__wsKitInstalls || 0) + 1; } }] };
}
`;
/** A summon kit's own source: a token kit is `(bb, raw, def) => Kit`, exactly like an operator's. */
const TOKEN_KIT_SRC = `export default function tokenKit() {
  return { skill: null, trait: { noAttack: true }, talents: [{ install() {} }] };
}
`;

/** A minimal token record a pack may ship (`tokens.json`, keyed by `tokenId`). */
const tokenRecord = (tokenId) => ({
  tokenId, kind: 'summon', name: '行为层召唤物探针', desc: '不会受到攻击', profession: 'TOKEN', position: 'ALL',
  stats: { maxHp: 100, atk: 10, def: 0, res: 0, cost: 0, blockCnt: 0, bat: 1, aspd: 100, respawnTime: 5, spRecovery: 1 },
  rangeGrid: [[0, 0]], dmgType: 'phys',
});

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
    // a plain install carries an empty list, so nothing changes without packs
    assert.deepEqual(buildBattleSpec({}).workshopKits, []);
  });

  test('the summon half rides in the same list, marked kind: "token" — and only that half carries the marker', () => {
    const spec = buildBattleSpec({ workshopKits: [
      { id: TOKEN_ID, pack: 'p', url: '/workshop-kits/p/t.js', kind: 'token' },
      { id: BASE, pack: 'p', url: '/workshop-kits/p/x.js' },
    ] });
    // `kind` is what tells the browser which of the two maps to put it in, and an operator kit keeps the exact shape it
    // had before this channel existed (absent marker ⇒ operator) — every existing reader of the list is unaffected.
    assert.deepEqual(spec.workshopKits, [
      { id: TOKEN_ID, pack: 'p', url: '/workshop-kits/p/t.js', kind: 'token' },
      { id: BASE, pack: 'p', url: '/workshop-kits/p/x.js' },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 召唤物的行为层（docs/WORKSHOP.md §4.7）：同一个文件名规则、**第二个键空间**。一个包的召唤物（例如一名干员的两个面具
// token）原来只能有数据、没有行为层 —— `tokens.kits` 是引擎内置的表，包碰不到。这一组把那条通道的两端与三条拒绝
// 一起钉住：声明过的 token id 装上、没声明的仍被拒（既有断言不放松）、两个空间各裁各的、注入点先查包的表。
//
// 每个包**只用一个 kit 文件名**：`KIT_ID_COLLISION` 先于别的判据，两个包抢同一个文件名会让后者拿不到它该拿的报告。

/** The kit a token unit resolves to: the pack's or the built-in one (told apart by their marker field). */
const unitKit = (opts, id) => {
  const battle = { opts, _handlerError() {} };
  const unit = { kind: 'token', def: { id, baseId: id, skill: null, raw: {} } };
  return setupUnitKit(battle, unit);
};
/** Two kits are the same if they serialise the same and carry the same methods (a kit holds functions). */
const kitShape = (k) => JSON.stringify(k, (key, v) => (typeof v === 'function' ? '[fn]' : v));

describe('行为层: 召唤物的 kit 通道（第二个键空间）', () => {
  const SHOWN = 'token_ws_shown';           // this pack ships the token record AND its kit → the summon key space
  const AMBI = 'token_ws_ambi';             // in BOTH merged tables → the ambiguity the loader refuses by name
  const KITLESS = 'token_ws_kitless';       // in a merged token table (the pack ships the record), owned by another pack
  const OVERRIDE_ID = OFFICIAL_TOKEN;       // the pack ships no record for it; only `tokens:<id>` can own this id
  const DIY_CHAR = 'char_ws_poolprobe';     // a 自选池 charId the pack declares but ships no chess record for
  let root;

  before(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'sp-tokenkits-'));
    const write = (id, { tokens = null, chess = null, kits = {}, overrides = [], content = ['tokens'] }) => {
      const dir = join(root, id);
      fs.mkdirSync(join(dir, 'kits'), { recursive: true });
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id, name: id, version: '0.1.0', content, overrides }));
      if (tokens) fs.writeFileSync(join(dir, 'tokens.json'), JSON.stringify(tokens));
      if (chess) fs.writeFileSync(join(dir, 'chess.json'), JSON.stringify(chess));
      for (const [kitId, src] of Object.entries(kits)) fs.writeFileSync(join(dir, 'kits', `${kitId}.js`), src);
      return dir;
    };
    // 1) the pack owns the token record → its kit lands in the summon key space
    write('token-pack', { tokens: { [SHOWN]: tokenRecord(SHOWN) }, kits: { [SHOWN]: TOKEN_KIT_SRC } });
    // 2) one id in BOTH spaces, all in one pack — its kit file is named after that very id
    write('both-pack', {
      content: ['chess', 'tokens'],
      chess: { [AMBI]: { chessId: AMBI } },
      tokens: { [AMBI]: tokenRecord(AMBI) },
      kits: { [AMBI]: TOKEN_KIT_SRC },
    });
    // 3) a chess record only: a kit named after a token id is NOT this pack's
    write('chess-only-pack', { content: ['chess'], chess: { [BASE]: { chessId: BASE } }, kits: { [KITLESS]: TOKEN_KIT_SRC } });
    // 4) ONE kit file for the OFFICIAL 医疗探机 id. The pack ships a token record of its own (a pack that declares
    // `content: ["tokens"]` must contribute that file), but it does NOT own the official id — only `tokens:<id>` can.
    write('override-pack', { tokens: { token_ws_decoy: tokenRecord('token_ws_decoy') }, kits: { [OVERRIDE_ID]: TOKEN_KIT_SRC } });
    // 5,6) two packs sharing a kit FILE name, both owning that id in their own `tokens.json` → the collision is decided
    // by pack id alone, which is the rule this pins (per key space, the smaller pack id keeps the id)
    for (const id of ['zeta-arb', 'alpha-arb']) {
      write(id, { tokens: { token_ws_arb: tokenRecord('token_ws_arb') }, kits: { token_ws_arb: TOKEN_KIT_SRC } });
    }
    // 7) an id no merged table carries
    write('nowhere-pack', { content: ['chess'], chess: { [BASE]: { chessId: BASE } }, kits: { token_ws_nowhere: TOKEN_KIT_SRC } });
    // 8) 自选池干员（pack.json operators）：这个包**没有** chess 记录，那个 charId 只靠声明进池 —— 模拟层对自选
    //    def 恰恰是按 `def.charId` 查 kit 的（content/index.js isDiyDef + kitOf），所以它必须能装上
    const poolDir = join(root, 'pool-pack');
    fs.mkdirSync(join(poolDir, 'kits'), { recursive: true });
    fs.writeFileSync(join(poolDir, 'pack.json'), JSON.stringify({
      id: 'pool-pack', name: 'P', version: '0.1.0', content: ['units'], overrides: [],
      operators: { [DIY_CHAR]: { bonds: [], powers: [] } },
    }));
    fs.writeFileSync(join(poolDir, 'units.json'), JSON.stringify({
      [DIY_CHAR]: { charId: DIY_CHAR, name: '自选池探针', rarity: 6, profession: 'WARRIOR' },
    }));
    fs.writeFileSync(join(poolDir, 'kits', `${DIY_CHAR}.js`), KIT_SRC);
  });
  after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  /**
   * The two merged key tables the server (server/index.js) hands the loader. `knownTokenIds` is built from the merged
   * data, i.e. `data/tokens.json` **plus every loaded pack's own `tokens.json`** — so the fixture tokens this block
   * declares appear here, exactly as they would on a real install. `token_ws_nowhere` is the one id no table carries;
   * `AMBI` is deliberately in BOTH tables (that is the ambiguity), which is why `knownIds` lists it too.
   */
  const officialTokenIds = () => Object.keys(JSON.parse(fs.readFileSync(join(DATA_DIR, 'tokens.json'), 'utf8')));
  const tables = () => ({
    knownIds: new Set([BASE, GOLD, AMBI, DIY_CHAR]),
    knownTokenIds: new Set([
      ...officialTokenIds(), SHOWN, AMBI, KITLESS, 'token_ws_decoy', 'token_ws_arb',
    ]),
  });
  const load = () => loadWorkshopKits(loadWorkshop(root, { log: quiet }), { log: quiet, ...tables() });

  test('a pack that ships the token record loads kits/<tokenId>.js as a SUMMON kit', async () => {
    const info = await load();
    assert.equal(typeof info.tokenKits[SHOWN], 'function', 'the summon key space must hold it');
    assert.equal(info.kits[SHOWN], undefined, 'and NOT the operator key space');
    assert.equal(info.tokenOwners.get(SHOWN), 'token-pack');
    // the browser rebuilds both maps from this one list: the summon half is marked, the operator half is not
    const mod = info.modules.find((m) => m.id === SHOWN);
    assert.equal(mod.kind, 'token');
    assert.match(mod.url, new RegExp(`^/workshop-kits/token-pack/${SHOWN}\\.js\\?v=\\d+$`));
  });

  test('no packs at all: the loader refuses nothing and reports nothing', async () => {
    const empty = await loadWorkshopKits({ packs: [] }, { log: quiet, ...tables() });
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.kits, {});
    assert.deepEqual(empty.tokenKits, {});
    assert.deepEqual(empty.modules, []);
  });

  test('an id neither merged table carries is still KIT_NO_TARGET (the existing rule, not relaxed)', async () => {
    const info = await load();
    const e = info.errors.find((x) => x.id === 'token_ws_nowhere');
    assert.ok(e, JSON.stringify(info.errors));
    assert.equal(e.code, 'KIT_NO_TARGET');
    assert.match(e.reason, /no chess record and no summon carries this id/);
    assert.equal(info.tokenKits.token_ws_nowhere, undefined);
    assert.equal(info.kits.token_ws_nowhere, undefined);
  });

  test('a token id the merged data HAS but this pack does not own needs the declaration, not silence', async () => {
    const info = await load();
    const e = info.errors.find((x) => x.pack === 'chess-only-pack' && x.id === KITLESS);
    assert.ok(e, JSON.stringify(info.errors));
    // the pack ships no token record for it and no override: the file names something that exists but is not this pack's,
    // which the behaviour layer reports instead of quietly installing a kit for another pack's (or an official) summon
    assert.equal(e.code, 'KIT_OFFICIAL_OVERRIDE_UNDECLARED');
    assert.match(e.reason, new RegExp(`"tokens:${KITLESS}" in pack.json overrides`));
    assert.equal(info.tokenKits[KITLESS], undefined);
  });

  test('an id that is BOTH a chess id and a token id is refused by name (never silently one of the two)', async () => {
    const info = await load();
    const e = info.errors.find((x) => x.id === AMBI);
    assert.ok(e, JSON.stringify(info.errors));
    assert.equal(e.code, 'KIT_TARGET_AMBIGUOUS');
    assert.match(e.reason, /both a chess id and a summon's token id/);
    assert.equal(info.kits[AMBI], undefined);
    assert.equal(info.tokenKits[AMBI], undefined);
  });

  test('declaring "tokens:<id>" in overrides is the sanctioned way to reach an OFFICIAL summon kit', async () => {
    const info = await load();
    const e = info.errors.find((x) => x.id === OVERRIDE_ID);
    assert.ok(e, JSON.stringify(info.errors));
    // the pack ships the official token record itself and declares no override: naming the OFFICIAL token id is the
    // declared act the behaviour layer demands for the operator space too — the same rule, one more key space
    assert.equal(e.code, 'KIT_OFFICIAL_OVERRIDE_UNDECLARED');
    assert.match(e.reason, new RegExp(`tokens:${OFFICIAL_TOKEN}`));
    assert.equal(info.tokenKits[OVERRIDE_ID], undefined);
  });

  test('the override declaration flips that very same file to accepted', async () => {
    const dir = join(root, 'override-pack');
    const original = fs.readFileSync(join(dir, 'pack.json'), 'utf8');
    try {
      fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ ...JSON.parse(original), overrides: [`tokens:${OFFICIAL_TOKEN}`] }));
      const info = await load();
      assert.equal(typeof info.tokenKits[OVERRIDE_ID], 'function', 'a declared override is honoured');
      assert.equal(info.tokenOwners.get(OVERRIDE_ID), 'override-pack');
      assert.equal(info.modules.find((m) => m.id === OVERRIDE_ID).kind, 'token');
    } finally {
      fs.writeFileSync(join(dir, 'pack.json'), original);
    }
  });

  test('two packs shipping the same summon kit id: the smaller pack id wins, and the report names the holder', async () => {
    const info = await load();
    const hit = info.errors.find((e) => e.id === 'token_ws_arb');
    assert.ok(hit, JSON.stringify(info.errors));
    assert.equal(hit.code, 'KIT_ID_COLLISION');
    assert.equal(hit.pack, 'zeta-arb', 'the pack that lost is the one blamed');
    assert.equal(hit.definedBy, 'alpha-arb', 'and the winner is named in a field, not only in prose');
    assert.equal(info.tokenOwners.get('token_ws_arb'), 'alpha-arb', 'the smaller pack id owns the id');
    assert.equal(info.modules.filter((m) => m.id === 'token_ws_arb').length, 1);
    assert.equal(info.modules.find((m) => m.id === 'token_ws_arb').kind, 'token');
  });

  // 自选池干员（pack.json operators）：那个 charId 就是模拟层对自选 def **唯一**查的键（`def.charId`），所以它是一条
  // 合法的 kit 目标 —— 而它**没有** chess 记录（一条都不是），所以走的是归属判据而不是 chess 表。
  test('a charId the pack declares into the 自选 pool loads its kit, with no chess record behind it', async () => {
    const info = await load();
    const e = info.errors.find((x) => x.id === DIY_CHAR);
    assert.equal(e, undefined, JSON.stringify(info.errors));
    assert.equal(typeof info.kits[DIY_CHAR], 'function', 'the operator key space holds it');
    assert.equal(info.tokenKits[DIY_CHAR], undefined);
    assert.equal(info.owners.get(DIY_CHAR), 'pool-pack');
    // …and the sim really resolves a DIY def (isDiyDef: `diyFor` = the slot, `charId` = the pick) through that key
    const marked = () => ({ skills: { s1: { kind: 'passive' } }, marker: 'diy-pack' });
    const battle = { opts: { kits: { [DIY_CHAR]: marked } }, _handlerError() {} };
    const unit = { kind: 'op', def: { id: 'chess_ws_slot_a', baseId: 'chess_ws_slot_a', diyFor: 'chess_ws_slot_a', charId: DIY_CHAR, skill: { bb: {}, skillId: 's1' }, raw: {} } };
    assert.equal(setupUnitKit(battle, unit).marker, 'diy-pack', 'a DIY piece must take the kit keyed by its charId');
  });

  test('the injection point: the pack map wins over the built-in token kit, in the summon space only', () => {
    const packKit = () => ({ skill: null, marker: 'pack-token' });
    assert.equal(unitKit({ tokenKits: { [SHOWN]: packKit } }, SHOWN).marker, 'pack-token');
    // an official summon the pack does not declare keeps the built-in kit
    const official = unitKit({ tokenKits: { [SHOWN]: packKit } }, OFFICIAL_TOKEN);
    assert.notEqual(official.marker, 'pack-token');
    assert.equal(typeof official.install, 'function', 'the official 医疗探机 kit still installs');
    // the operator map is a DIFFERENT space: handing a token id to `opts.kits` changes nothing for a token
    assert.notEqual(unitKit({ kits: { [SHOWN]: packKit } }, SHOWN).marker, 'pack-token');
  });

  test('no packs: the token path resolves exactly as it did before this key existed', () => {
    for (const id of [OFFICIAL_TOKEN, 'token_10017_skadi2_dedant', 'token_10028_vigil_wolf']) {
      const plain = unitKit({}, id);
      const empty = unitKit({ tokenKits: {} }, id);
      assert.equal(kitShape(empty), kitShape(plain), `${id}: an empty map must not change the resolved kit`);
    }
    // …and the operator half of the same battle is untouched by the new key's presence
    const opUnit = { kind: 'op', def: { baseId: BASE, id: BASE, skill: { bb: {} }, raw: {} } };
    const battle = (opts) => ({ opts, _handlerError() {} });
    assert.equal(kitShape(setupUnitKit(battle({}), opUnit)), kitShape(setupUnitKit(battle({ tokenKits: {} }), opUnit)));
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

  // 「无包对局逐字节不变」：同一份数据、同一个种子，一条**不注入任何 kit 表**（这一局跑的是内置注册表）与一条注入
  // **空**表（新键存在但没有任何包声明它）的对局必须逐字段一致 —— 新通道的存在不能改变无包时的任何一步。
  test('no packs: a battle with no kit maps and one with EMPTY maps produce identical results', async () => {
    const data = loadData(DATA_DIR, { log: quiet });
    const run = (extra) => {
      const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 97, data, ...extra });
      h.start();
      const ps = h.ps('p_0');
      const tile = legalTileFor(h.m, ps, 'chess_char_1_01_a');
      if (tile) give(h.m, ps, 'chess_char_1_01_a', 'board', tile);
      h.run(() => h.m.round >= 3 || h.ended != null);
      return { round: h.m.round, phase: h.m.phase, ended: h.ended ?? null, errors: h.logs.error.slice() };
    };
    const plain = run({});
    const injected = run({ workshopKits: {}, workshopTokenKits: {} });
    assert.deepEqual(injected, plain, 'an empty kit map must not move a single field');
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

  // §28.18 的服务面接线：路由要给「kit 用 ./… import 的兄弟文件」找到目录，靠的是**已装载包**的 id → `<包目录>/kits`。
  // 这条把两端钉在一起：装载结果里的 dir、这张表、以及磁盘上真的存在那个目录 —— 三者必须一致。
  test('§28.18：pack id → kits/ 目录的表来自已装载的包，且指向磁盘上真实存在的目录', () => {
    const dirs = workshopKitDirsFor(loaded);
    assert.deepEqual([...dirs.keys()], ['probe-pack']);
    // 同一份装载结果：装载器给出的 dir 与路由那张表必须指向同一个 kits/（两端不能各算一次路径）
    assert.equal(dirs.get('probe-pack'), join(loaded.packs.find((p) => p.id === 'probe-pack').dir, 'kits'));
    assert.ok(fs.existsSync(dirs.get('probe-pack')), 'kits/ 目录必须真的存在');
    // 没装载的包（表里没有）不是「被挡住」，而是根本没有可解析的目标
    assert.equal(dirs.has('not-loaded'), false);
    assert.equal(workshopKitDirsFor({ packs: [] }).size, 0);
    assert.equal(workshopKitDirsFor(null).size, 0);
  });

  test('the runner rebuilds the map from spec.workshopKits (client wiring present)', () => {
    const src = fs.readFileSync(join(ROOT, 'public/js/battle/runner.js'), 'utf8');
    assert.match(src, /export async function loadSpecKits/);
    assert.match(src, /spec\s*&&\s*spec\.workshopKits|spec\.workshopKits/);
    // 上游 0.2.1 把战斗启动重写成「待处理表 + prepare()」，参数从 `msg` 变成条目 `e`；0.3.0 又把**真正构造战斗的
    // 那一步**交给宿主（`e.host.start(spec, opts)`），于是 kits 不再内联进 `createBattleFromSpec(...)` 的实参。
    // 这条断言钉的是**工坊 kits 必须挂在真正构造战斗的那一处**（否则工坊行为层会静默失效），不是某个函数名。
    // 两张表（干员 / 召唤物）都必须挂在那里：少一个，那一半的包效果在浏览器侧就静默消失，服务端复算会把玩家的
    // 结果判为不一致。
    assert.match(src, /e\.host\.start\(e\.spec, \{[^}]*\blogger, kits, tokenKits\b/);
    // kit 的**归属**与**预算**（DESIGN §28.52 的 kit 那一半）走的是**同一个落点**：它们与两张 kit 表一起交给
    // 构造战斗的那一处，否则浏览器侧 kit 的逐单位回调不归账、而服务端复算那半会回滚 —— 两端在**不同**的
    // 调用次数上停，玩家算出来的战果会被判为不一致。空表不写这几个键（KEY DISCIPLINE）。
    assert.match(src, /kitOwners\.size \? \{ kitOwners \} : \{\}/);
    assert.match(src, /kitBudgets\.size \? \{ kitBudgets \} : \{\}/);
    assert.match(src, /const \{ kits, tokenKits, kitOwners, tokenKitOwners, kitBudgets \} = await loadSpecKits\(e\.spec\)/);
    assert.match(src, /m\.kind === 'token' \? tokenKits : kits/);
    assert.match(src, /import\(\/\* @vite-ignore \*\/ m\.url\)/);
    // 包声明的**战斗逻辑**（`server.battle`, DESIGN §28.17）走同一个落点：没有它，一个包的整场效果在浏览器侧会静默消失。
    assert.match(src, /export async function loadSpecBattleInstallers/);
    assert.match(src, /spec\.workshopBattle/);
    assert.match(src, /battleInstallers/);
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

  test('§28.18：docs/examples/kit-demo 的 kits/ 只有顶层 <id>.js 会被当成 kit（示例的扁平形态照旧）', () => {
    const src = fs.readFileSync(join(ROOT, 'docs/examples/kit-demo/kits', `${EX_BASE}.js`), 'utf8');
    // 示例本身仍然是「不 import 任何东西」的形态（它讲的就是三条硬规则），但这**不是**一条新的禁令：
    // §28.18 之后 `./…` 与 `@kit/` / `@sim/` 都是合法写法，见 test/packRelativeImports.test.js。
    assert.equal(/^\s*import\s/m.test(src), false, '示例 kit 保持自包含（示例的形态，不是对作者的禁令）');
    // 被当成 kit 的文件 = 顶层、`.js`、不以 `_` 开头；示例包里只有那一个
    const kitFiles = fs.readdirSync(join(ROOT, 'docs/examples/kit-demo/kits'))
      .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
      .filter((f) => fs.statSync(join(ROOT, 'docs/examples/kit-demo/kits', f)).isFile());
    assert.deepEqual(kitFiles, [`${EX_BASE}.js`], '示例包的 kit 清单');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 复算与真跑必须用**同一份**工坊 kit 表（DESIGN §28.12.1）。
//
// `MatchCombat.newBattle`（服务端真跑的那一场）从 `this.workshopKits` / `this.workshopTokenKits` 取表；
// `MatchClientCombat._specBattle`（headless / 接管 / **SP_VERIFY 复算**）是**第二条** Battle 组装路径。两条路
// 若只给一条装 kit，装了包的房间里客户端按工坊 kit 跑、服务端按内置注册表复算，`_verifyResult` 必然对不上 ——
// 要么误报不一致（玩家的正确结果被服务端复算顶掉），要么把真正的不一致放过。下面三条把这条不变量钉死：
//   1. 有包的房间：`_specBattle` 拿到的正是**这一局那一份**表（引用相等：同一个映射、同一个 kit 函数）；
//   2. 无包的房间：**不传**这两个字段时两个展开都不设键 ⇒ `Battle opts` 的对象形状与从前逐字段相同；空表（`{}`）
//      是另一种写法，它只会多出两个空映射（`setupUnitKit` 命中才读，是 no-op），其余字段逐字段相同；
//   3. 真跑（`newBattle`）与复算（`_specBattle`）对同一场给出相同的 `Battle opts`：每一个共同输入逐字段相同，
//      两个键空间是同一批函数。
// ---------------------------------------------------------------------------------------------------------------------

/** 打开一局并走到 COMBAT；返回 harness、Match 与最后一个正常（非 boss）场的 spec。 */
function driveToCombat(extra = {}, seed = 97) {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed, data: loadData(DATA_DIR, { log: quiet }), clientCombat: true, clients: false, captureFrames: false, ...extra });
  h.start();
  const ps = h.ps('p_0');
  const tile = legalTileFor(h.m, ps, 'chess_char_1_01_a');
  if (tile) give(h.m, ps, 'chess_char_1_01_a', 'board', tile);
  assert.ok(h.drive(() => h.m.phase === PHASE.COMBAT), `did not reach COMBAT (${h.m.phase} R${h.m.round})`);
  const f = h.m.fields.find((x) => x.spec && x.spec.kind === 'normal');
  assert.ok(f, 'a normal field at COMBAT');
  return { h, m: h.m, f };
}

/** 那一份「这一局自己」的工坊表：由房间声明的包裁剪出来的（`assets.kits`），也就是真跑用的那一份。 */
const roomKits = async () => (kitInfo ?? await loadWorkshopKits(loaded, { log: quiet, knownIds: new Set([BASE, GOLD]) }));

/** 函数不可 deepEqual：逐字段比结构，函数值比**同一性**（同一个包、同一份字节 ⇒ 同一个函数对象）。 */
function sameOpts(a, b, keys, label) {
  for (const k of keys) {
    if (typeof a[k] === 'function' || typeof b[k] === 'function') assert.equal(a[k], b[k], `${label}: opts.${k} 必须是同一个函数`);
    else assert.deepEqual(a[k], b[k], `${label}: opts.${k}`);
  }
}
describe('复算与真跑：同一条 Battle 组装路径（DESIGN §28.12.1）', () => {
  test('装了带 kit 的包：SP_VERIFY 的复算（_specBattle）拿到**这一局那一份**工坊表，两个键空间都到', async () => {
    const info = await roomKits();
    assert.equal(typeof info.kits[BASE], 'function', '前置：探针包声明了 ' + BASE + ' 的 kit');
    // 服务端真跑的那一场用的就是这两个字段（Match.js 从 lobby.js 的 `assets.kits` / `assets.tokenKits` 接过来）
    const { m, f } = driveToCombat({ workshopKits: info.kits, workshopKitModules: info.modules, workshopTokenKits: info.kits });
    const battle = m._specBattle(f.spec);
    assert.ok(battle instanceof Battle, 'a real battle, not a stand-in');
    // 复算这一场真的拿到了包的行为层：同一个映射、同一批函数（引用相等 —— 不是空表、不是另一份拷贝）
    assert.equal(battle.opts.kits, m.workshopKits, '复算必须用这一局自己那份干员 kit 表');
    assert.equal(battle.opts.kits[BASE], info.kits[BASE], '…并且是包的那一个 kit 函数');
    assert.equal(battle.opts.tokenKits, m.workshopTokenKits, '召唤物的表走同一个落点的第二个键');
    // 装配层也认：把复算的战斗交给注入点，解析出来的就是包的那个 kit（内置注册表被让位）
    const unit = { kind: 'op', def: { baseId: BASE, id: BASE, skill: { bb: {} }, raw: {} } };
    assert.equal(typeof setupUnitKit(battle, unit), 'object', 'the pack kit resolves through the battle\'s own opts');
    m.dispose();
  });

  test('无包：一条不注入、一条注入空表的对局，Battle opts 逐字段一致，且两个键都不出现', () => {
    // 空表（键存在但什么都没有）与完全不传，是「无包对局」的两种写法：两条都必须与从前逐字段相同
    const capture = (extra) => {
      const seen = { battles: 0, opts: [], spec: null };
      const { m, f } = driveToCombat(extra);
      seen.spec = JSON.parse(JSON.stringify(f.spec, (k, v) => (typeof v === 'function' ? '[fn]' : v)));
      const create = m._specBattle.bind(m);
      m._specBattle = (...args) => { const b = create(...args); seen.battles++; seen.opts.push(JSON.parse(JSON.stringify(b.opts, (k, v) => (typeof v === 'function' ? '[fn]' : v)))); return b; };
      m._specBattle(f.spec);
      m.dispose();
      return seen;
    };
    const plain = capture({});
    const empty = capture({ workshopKits: {}, workshopTokenKits: {} });
    assert.equal(plain.battles, 1);
    assert.equal(empty.battles, 1);
    // 干净安装（**不传**这两个字段，生产里没装包时 `lobby.js` 送的就是 undefined）：
    // 两个展开都不设键 —— `Battle opts` 的对象形状与今天逐字节相同
    assert.equal('kits' in plain.opts[0], false, '无包时不设键（对象形状与从前逐字节相同）');
    assert.equal('tokenKits' in plain.opts[0], false, '同上：每个键空间各自缺席');
    // 字段级：拿掉上面那两个「空表 ⇒ 空对象」的键之后，两份必须逐字段相同；空表只能**多**这两个键，
    // 多出来的两个空映射在 `setupUnitKit` / `content/index.js` 里是 no-op（既有的无包对局断言已钉住这条）
    const withoutKits = (o) => { const { kits, tokenKits, ...rest } = o; return rest; };
    assert.deepEqual(empty.opts.map(withoutKits), plain.opts.map(withoutKits), 'an empty kit map must not move a single other field of the Battle opts');
    // 同数据同种子跑两局：这一场的 spec 与 `Battle opts` 都必须逐字段相同（确定性 + 无包时形状不变）
    const again = capture({});
    assert.deepEqual(again.spec, plain.spec, '无包对局：同数据同种子的 spec 逐字节相同');
    assert.deepEqual(again.opts, plain.opts, '无包对局：同数据同种子的 Battle opts 逐字段相同');
  });

  test('同一场：真跑（newBattle 那条组装）与复算（_specBattle）的 Battle opts 逐字段相同（FakeBattle 逐字段 deepEqual）', async () => {
    const info = await roomKits();
    // fake: true —— Battle opts 里没有 DataSource / Pool 这类对象，构造参数本身可以逐字段比较
    const h = makeMatch({
      mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 98, fake: true, clientCombat: true, clients: false, captureFrames: false,
      workshopKits: info.kits, workshopKitModules: info.modules, workshopTokenKits: info.kits,
    });
    h.start();
    const ps = h.ps('p_0');
    const tile = legalTileFor(h.m, ps, 'chess_char_1_01_a');
    if (tile) give(h.m, ps, 'chess_char_1_01_a', 'board', tile);
    // 走到 COMBAT 的路上不该有服务端真跑（客户端战斗模式下正常场由浏览器 authority 跑）
    const normal = h.m._normalBattle.bind(h.m);
    let booted = 0;
    h.m._normalBattle = (...args) => { booted++; return normal(...args); };
    assert.ok(h.drive(() => h.m.phase === PHASE.COMBAT), `did not reach COMBAT (${h.m.phase} R${h.m.round})`);
    assert.equal(booted, 0, '客户端战斗模式：正常场不在服务端真跑（复算才走 _specBattle）');
    h.m._normalBattle = normal;
    // 战斗开始时 b.start 送出的那一份 spec：字段记录里就是权威的那一份（复算读的正是它）
    const f = h.m.fields.find((x) => x.fieldId === 'n:p_0' && x.spec && x.spec.kind === 'normal');
    assert.ok(f, 'COMBAT 的正常场记录');
    // 两边都取 `Battle opts`：真跑那条走 `newBattle`，复算那条走 `_specBattle`。比较两者**共同决定这一场战斗**的
    // 每一个输入。`recordEvents` 不在此列（复算明确关掉它，只影响事件记录、不影响结果）；`players` 单独比：
    // spec 会把缺省的 moduleId 写成 null，而模拟器把两者当同一个默认（`battle/players.js:165` 的 `?? null`）。
    const run = h.m.newBattle(h.m._normalOpts(ps)).opts;
    const recomputed = h.m._specBattle(f.spec).opts;
    sameOpts(recomputed, run, ['seed', 'kind', 'modeId', 'round', 'stageId', 'rect', 'timeLimit', 'spawns', 'routes', 'flags', 'fieldId', 'enemyOverrides', 'waveId', 'content'], '真跑 vs 复算');
    const loadouts = (players) => (players || []).map((p) => ({
      playerId: p.playerId, seat: p.seat, side: p.side, colOffset: p.colOffset, bandId: p.bandId,
      units: (p.units || []).map((u) => ({ ...u, skillIndex: u.skillIndex ?? null, moduleId: u.moduleId ?? null })),
    }));
    assert.deepEqual(loadouts(recomputed.players), loadouts(run.players), '玩家/单位（含默认化的技能与模组）必须相同');
    assert.equal(recomputed.kits, run.kits, '两个键空间都必须是同一批函数（真跑与复算用同一个映射）');
    assert.equal(recomputed.tokenKits, run.tokenKits);
    assert.equal(recomputed.kits, h.m.workshopKits, '复算用的是这一局自己那份表');
    assert.equal(recomputed.kits[BASE], info.kits[BASE], '…同一个 kit 函数（不是另一份拷贝、不是空表）');
    assert.deepEqual(h.logs.error, []);
    h.m.dispose();
  });
});
