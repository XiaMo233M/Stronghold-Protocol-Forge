#!/usr/bin/env node
// tools/workshop-validate.mjs — validate 创意工坊 packs against the format AND against the real engine
// (docs/WORKSHOP.md). This is the check an author runs, and the one an AI calls in a self-correction loop.
//
// Usage:
//   node tools/workshop-validate.mjs                      # every pack under workshop/
//   node tools/workshop-validate.mjs <dir>                # one pack directory, or a workshop root
//   node tools/workshop-validate.mjs --workshop <root>    # explicit pack root
//   node tools/workshop-validate.mjs --json               # machine-readable report
//
// It checks the layers cheapest-first: pack format → record semantics → the real engine → then one layer per content
// kind (kits, stages/maps, enemies/monsters, waves, items/equipment), each re-deriving what the engine derives.
// Layer 3 is what catches a record that is syntactically valid but silently unplayable.
//
// Exit codes: 0 = no errors (warnings allowed), 1 = errors found, 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChessRecord, formatIssues } from '../shared/chessAuthoring.js';
import { loadWorkshop, loadWorkshopKits, WORKSHOP_DIR } from '../server/workshop.js';
import { validateStageRecord } from '../server/stageAuthoring.js';
import { validateEnemy } from '../shared/enemyAuthoring.js';
import { validateWave } from '../shared/waveAuthoring.js';
import { validateItem } from '../shared/itemAuthoring.js';
import { validateKit } from '../shared/kitAuthoring.js';
import { loadData } from '../server/data.js';
import { WORKSHOP_ASSET_TYPES } from '../server/index.js';
import { GameData } from '../server/match/gamedata.js';
import { toDataSource, isShopItem } from '../server/sim/simdata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const USAGE = `usage: node tools/workshop-validate.mjs [dir] [--workshop <root>] [--json]`;

function parseArgs(argv) {
  const out = { dir: null, workshop: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--workshop') { out.workshop = argv[++i]; if (out.workshop === undefined) throw new Error('--workshop needs a path'); }
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (out.dir === null) out.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

/** A pack directory carries pack.json; anything else is treated as a workshop root. */
function resolveRoots(dir) {
  if (dir === null) return { root: WORKSHOP_DIR, only: null };
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  return fs.existsSync(path.join(abs, 'pack.json')) ? { root: path.dirname(abs), only: path.basename(abs) } : { root: abs, only: null };
}

const officialChess = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'chess.json'), 'utf8'));
const OFFICIAL_IDS = new Set(Object.keys(officialChess));

/** Cross-record checks the per-record validator cannot see (the base/elite pair). */
function pairIssues(records, file) {
  const out = [];
  if (file !== 'chess') return out;
  for (const [id, rec] of Object.entries(records)) {
    const isGolden = rec.isGolden === true || /_b$/.test(id);
    const partner = isGolden ? rec.baseId : rec.goldenId;
    if (!partner) {
      out.push({ field: `${id}.${isGolden ? 'baseId' : 'goldenId'}`, code: 'NO_PARTNER', severity: 'error', message: `${isGolden ? 'elite' : 'normal'} record has no partner id` });
      continue;
    }
    if (!Object.hasOwn(records, partner) && !OFFICIAL_IDS.has(partner)) {
      out.push({
        field: `${id}.${isGolden ? 'baseId' : 'goldenId'}`, code: 'PARTNER_MISSING', severity: 'error',
        message: `partner "${partner}" is neither in this pack nor in the official data`,
        hint: isGolden ? 'the elite must point at its normal record' : 'add the elite record, or leave goldenId null',
      });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // `--workshop <root>` used to be parsed and documented but never read, so it silently validated the default
  // workshop/ directory and could print a green VALID for the wrong tree. It now wins over the positional argument.
  const { root, only } = resolveRoots(args.workshop ?? args.dir);
  const report = { workshop: root, packs: [], errors: 0, warnings: 0, engine: [] };

  const loaded = loadWorkshop(root, { log: quiet });
  for (const e of loaded.errors) {
    report.packs.push({ pack: e.pack, issues: [{ field: '', code: 'PACK_LOAD', severity: 'error', message: e.reason }] });
  }
  const packs = only ? loaded.packs.filter((p) => p.id === only) : loaded.packs;
  if (only && packs.length === 0) throw new Error(`no loadable pack named "${only}" under ${root}`);

  for (const pack of packs) {
    const issues = [];
    for (const [file, records] of Object.entries(pack.files)) {
      for (const [id, rec] of Object.entries(records)) {
        if (file === 'chess') issues.push(...validateChessRecord(rec, { id, officialIds: OFFICIAL_IDS }));
      }
      issues.push(...pairIssues(records, file));
    }
    report.packs.push({ pack: pack.id, name: pack.name, files: Object.keys(pack.files), issues });
  }

  // ---- the voice pack layer (docs/WORKSHOP.md §1.4). `voices` is validated by the loader already (slots, char ids,
  // path shape); what only the FILESYSTEM can answer is whether the named files are really there and servable — a
  // typo'd name passes every shape check and would simply be a line that never plays.
  for (const pack of packs) {
    const voices = pack.voices || {};
    if (!Object.keys(voices).length) continue;
    const entry = report.packs.find((p) => p.pack === pack.id);
    let lines = 0;
    for (const [charId, slots] of Object.entries(voices)) {
      for (const [slot, files] of Object.entries(slots)) {
        lines += files.length;
        for (const rel of files) {
          const abs = path.join(pack.dir, 'assets', rel);
          const ext = path.extname(rel).toLowerCase();
          if (!WORKSHOP_ASSET_TYPES.has(ext)) {
            entry.issues.push({
              field: `${charId}.${slot}`, code: 'VOICE_TYPE_UNSERVABLE', severity: 'error',
              message: `"${rel}" (${ext || 'no extension'}) is not a media type the pack route serves`,
              hint: 'the route allowlists images / audio / fonts / atlas / skel — an .mp3, .ogg or .wav plays',
            });
          } else if (!fs.existsSync(abs)) {
            entry.issues.push({
              field: `${charId}.${slot}`, code: 'VOICE_FILE_MISSING', severity: 'error',
              message: `"${rel}" is declared in pack.json but not on disk at ${abs}`,
              hint: 'files must live inside the pack: <pack>/assets/<path>',
            });
          }
        }
      }
      // A line nobody can hear: the operator is neither official nor added by this pack (the client looks the id up in
      // the merged chess data, so an unknown id is silently dead content).
      const known = OFFICIAL_IDS.has(charId) || Object.keys(pack.files.chess || {}).includes(charId);
      if (!known) {
        entry.issues.push({
          field: charId, code: 'VOICE_UNKNOWN_OPERATOR', severity: 'warning',
          message: `${charId} is neither an official operator nor one this pack adds — these lines can never play`,
          hint: 'add the operator to this pack\'s chess.json, or ignore this if another installed pack adds it',
        });
      }
    }
    entry.voices = { operators: Object.keys(voices).length, lines };
    report.voiceLines = (report.voiceLines || 0) + lines;
  }

  // ---- layer 3: the engine. Load the merged data exactly as the server does and interrogate it.
  if (loaded.packs.length) {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: root });
    const gd = new GameData(data, 'mode_multi_hard');
    const ds = toDataSource(data);
    for (const pack of packs) {
      for (const id of Object.keys(pack.files.chess || {})) {
        const rec = data.chess[id];
        if (!rec) { report.engine.push({ id, code: 'NOT_MERGED', severity: 'error', message: 'the record did not reach the merged data' }); continue; }
        if (rec.isGolden) continue;
        if (!gd.visibleChess.includes(id)) {
          report.engine.push({ id, code: 'NOT_SHOP_ELIGIBLE', severity: 'warning', message: 'not shop-eligible: the operator can never be recruited', hint: 'set visible true, isHidden false, isDiy false and an integer tier' });
        }
        if (gd.goldenIdOf(id) !== rec.goldenId) {
          report.engine.push({ id, code: 'ELITE_LINK', severity: 'error', message: `goldenIdOf resolved to ${gd.goldenIdOf(id)} but the record says ${rec.goldenId}` });
        }
        // does the sim actually build a unit def? (missing stats/ranges only show up here)
        try {
          if (!ds.getChess(id)) report.engine.push({ id, code: 'SIM_NO_DEF', severity: 'error', message: 'the sim could not build a def for this operator' });
        } catch (e) {
          report.engine.push({ id, code: 'SIM_THREW', severity: 'error', message: `the sim threw while building a def: ${e.message}` });
        }
      }
    }
  }

  for (const p of report.packs) for (const i of p.issues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  for (const i of report.engine) (i.severity === 'error' ? report.errors++ : report.warnings++);

  // ---- layer 4: the behaviour layer (a pack's kits/<chessId>.js). Loading it here means a broken kit is caught BEFORE
  // the server boots, and an AI gets the same field/code/hint shape it already uses for the data layer.
  //
  // The IMPORT is only half the check. Importing proves the file parses and default-exports a function; it says nothing
  // about the failures that are SILENT in play — a hook name nothing emits (so the handler never runs), a Math.random()
  // or Date.now() that makes the server's recomputation reject the player's result, or a relative import that resolves
  // for the server and not for the browser. Those are static, so they are scanned for here (shared/kitAuthoring.js).
  if (loaded.packs.length) {
    const kitInfo = await loadWorkshopKits(loaded, {
      log: quiet,
      knownIds: new Set(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: root }).chess || {})),
    });
    const staticIssues = [];
    // a kit the static layer already explained is not reported a second time by the loader, whose message is blunter
    const explained = new Set();
    for (const pack of loaded.packs) {
      const kitDir = path.join(pack.dir, 'kits');
      if (!fs.existsSync(kitDir)) continue;
      const ownChessIds = Object.keys((pack.files && pack.files.chess) || {});
      for (const name of fs.readdirSync(kitDir).sort()) {
        if (!name.endsWith('.js')) continue;
        const id = name.slice(0, -'.js'.length);
        const issues = validateKit(fs.readFileSync(path.join(kitDir, name), 'utf8'), { id, ownChessIds, overrides: pack.overrides })
          .map((i) => ({ ...i, field: `kits/${pack.id}/${name}${i.field && i.field !== 'source' ? ` · ${i.field}` : ''}` }));
        if (issues.some((i) => i.severity === 'error')) explained.add(`${pack.id}/${id}`);
        staticIssues.push(...issues);
      }
    }
    report.kits = {
      loaded: kitInfo.modules.map((m) => m.id),
      modules: kitInfo.modules,
      issues: staticIssues,
      errors: kitInfo.errors
        .filter((e) => !explained.has(`${e.pack}/${e.id}`))
        .map((e) => ({ field: `kits/${e.id}.js`, code: 'KIT', severity: 'error', message: `${e.pack}: ${e.reason}` })),
    };
    for (const e of report.kits.errors) report.errors++;
    for (const i of staticIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 5: stages (maps). groundPaths / groundPathsWithDevices / deployTiles are DERIVED from the grid, so they
  // are RE-derived and compared. A hand-edited grid whose tables were left behind still looks well-formed, yet would send
  // enemies along a route the map no longer has — exactly the failure this layer exists to catch.
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.stages || {}).length)) {
    const data = loadData(DATA_DIR, { log: quiet, workshopDir: root });
    const officialStages = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stages.json'), 'utf8'))));
    const listedIn = new Set();
    for (const m of Object.values((data.config && data.config.modes) || {})) {
      for (const s of (Array.isArray(m && m.stages) ? m.stages : [])) listedIn.add(s);
    }
    const stageIssues = [];
    for (const pack of packs) {
      for (const [id, rec] of Object.entries(pack.files.stages || {})) {
        stageIssues.push(...validateStageRecord(rec, { id, officialIds: officialStages }));
        if (!listedIn.has(id)) {
          stageIssues.push({
            field: id, code: 'NOT_SELECTABLE', severity: 'warning',
            message: 'no mode lists this stage, so no match can ever pick it',
            hint: 'give the stage a `modes` array naming the modes it belongs to — the loader appends it to those',
          });
        }
      }
    }
    report.stages = stageIssues;
    for (const i of stageIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 6: enemies (monsters). `be` and `attrPower` are DERIVED from the stats and drive the per-faction enemy
  // replacement count, so they are re-derived and compared: a hand-typed value swaps the wrong number of enemies.
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.enemies || {}).length)) {
    const officialEnemies = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'enemies.json'), 'utf8'))));
    const enemyIssues = [];
    for (const pack of packs) {
      for (const [key, rec] of Object.entries(pack.files.enemies || {})) {
        enemyIssues.push(...validateEnemy(rec, { key, officialIds: officialEnemies }));
      }
    }
    report.enemies = enemyIssues;
    for (const i of enemyIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 7: waves (每关出怪). totalCount/slotCounts are DERIVED and re-derived here; the checks that matter most are
  // the cross-file ones — a spawn whose enemy nothing defines, or a routeIndex past the wave's own routes — because both
  // fail SILENTLY in game (the key spawns nothing; the sim falls back to route 0 and enemies walk a different path).
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.waves || {}).length)) {
    const officialWaves = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'waves.json'), 'utf8'))));
    // the merged enemy keys, so a pack may spawn its own monsters as well as official ones
    const knownEnemyKeys = new Set(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: root }).enemies || {}));
    const waveIssues = [];
    for (const pack of packs) {
      for (const [id, rec] of Object.entries(pack.files.waves || {})) {
        waveIssues.push(...validateWave(rec, { id, officialIds: officialWaves, knownEnemyKeys }));
      }
    }
    report.waves = waveIssues;
    for (const i of waveIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  // ---- layer 8: items (装备). `params` is DERIVED from the buffs' blackboards, and `mergeable` / `shopExcluded` from the
  // merge pair and the exclusion field. The engine reads `params`, NOT the buffs — so a hand-typed params block leaves an
  // item that looks right on its card and does nothing in play. All three are re-derived and compared. The cross-record
  // checks are the other silent ones: a merge target nothing defines (the merge goes nowhere) and an item no shop slot
  // can ever offer.
  if (loaded.packs.length && packs.some((p) => Object.keys(p.files.items || {}).length)) {
    const officialItems = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'items.json'), 'utf8'))));
    const merged = loadData(DATA_DIR, { log: quiet, workshopDir: root });
    const itemIssues = [];
    for (const pack of packs) {
      for (const [id, rec] of Object.entries(pack.files.items || {})) {
        itemIssues.push(...validateItem(rec, { id, officialIds: officialItems }));
        const m = (merged.items || {})[id];
        if (!m) {
          itemIssues.push({ field: id, code: 'NOT_MERGED', severity: 'error', message: 'the record did not reach the merged data' });
          continue;
        }
        if (!m.isGolden && m.goldenId && !(merged.items || {})[m.goldenId]) {
          itemIssues.push({
            field: `${id}.goldenId`, code: 'GOLDEN_MISSING', severity: 'error',
            message: `the merge target "${m.goldenId}" is neither in this pack nor in the official data`,
            hint: 'emit the elite record too, or set upgradeNum 0 for a standalone item',
          });
        }
        if (!m.isGolden && !isShopItem(m)) {
          itemIssues.push({
            field: id, code: 'NOT_SHOP_ELIGIBLE', severity: 'warning',
            message: 'not shop-eligible: no shop slot and no item card can ever offer it',
            hint: 'keep itemType EQUIP, hideInShop false, shopExcludedBy null and an integer tier — or accept it as effect-only',
          });
        }
      }
    }
    report.items = itemIssues;
    for (const i of itemIssues) (i.severity === 'error' ? report.errors++ : report.warnings++);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`workshop root: ${root}`);
    if (!loaded.present) console.log('  (the directory does not exist — nothing to validate)');
    if (!loaded.packs.length && !report.packs.length) console.log('  no packs found');
    for (const p of report.packs) {
      const bits = [];
      if (p.files && p.files.length) bits.push(p.files.join(', '));
      if (p.voices) bits.push(`${p.voices.lines} voice line(s) for ${p.voices.operators} operator(s)`);
      console.log(`\npack ${p.pack}${p.name ? ` (${p.name})` : ''}${bits.length ? ` — ${bits.join(' + ')}` : ''}`);
      if (!p.issues.length) console.log('  OK');
      else console.log(formatIssues(p.issues).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (report.engine.length) {
      console.log('\nengine checks:');
      console.log(formatIssues(report.engine).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (report.kits) {
      console.log(`\nbehaviour layer (kits/):`);
      console.log(report.kits.loaded.length ? `  loaded: ${report.kits.loaded.join(', ')}` : '  (no kits)');
      if (report.kits.errors.length) console.log(formatIssues(report.kits.errors).split('\n').map((l) => `  ${l}`).join('\n'));
      if (report.kits.issues && report.kits.issues.length) console.log(formatIssues(report.kits.issues).split('\n').map((l) => `  ${l}`).join('\n'));
    }
    if (report.stages) {
      console.log('\nstages (maps):');
      console.log(report.stages.length ? formatIssues(report.stages).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    if (report.enemies) {
      console.log('\nenemies (monsters):');
      console.log(report.enemies.length ? formatIssues(report.enemies).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    if (report.waves) {
      console.log('\nwaves (每关出怪):');
      console.log(report.waves.length ? formatIssues(report.waves).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    if (report.items) {
      console.log('\nitems (装备):');
      console.log(report.items.length ? formatIssues(report.items).split('\n').map((l) => `  ${l}`).join('\n') : '  OK');
    }
    console.log(`\n${report.errors} error(s), ${report.warnings} warning(s)`);
    if (report.errors === 0) console.log('VALID: the engine accepts this content.');
  }
  process.exit(report.errors ? 1 : 0);
}

main().catch((e) => {
  console.error(`workshop-validate: ${e.message}`);
  console.error(USAGE);
  process.exit(2);
});
