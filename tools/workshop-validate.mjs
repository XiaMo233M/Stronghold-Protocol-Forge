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
// It checks three layers, cheapest first:
//   1. the pack format       — pack.json, content file shapes, per-record schema (shared/chessAuthoring.js)
//   2. the record semantics  — validateChessRecord: stats, ranges, skill enums, generic-kit blackboard keys
//   3. the ENGINE            — load the merged data and ask it: is the operator shop-eligible, does the sim build a
//                              def for it, does its elite resolve? Layer 3 is what catches a record that is
//                              syntactically valid but silently unplayable.
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
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { toDataSource } from '../server/sim/simdata.js';

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
  if (loaded.packs.length) {
    const kitInfo = await loadWorkshopKits(loaded, {
      log: quiet,
      knownIds: new Set(Object.keys(loadData(DATA_DIR, { log: quiet, workshopDir: root }).chess || {})),
    });
    report.kits = {
      loaded: kitInfo.modules.map((m) => m.id),
      modules: kitInfo.modules,
      errors: kitInfo.errors.map((e) => ({ field: `kits/${e.id}.js`, code: 'KIT', severity: 'error', message: `${e.pack}: ${e.reason}` })),
    };
    for (const e of report.kits.errors) report.errors++;
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

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`workshop root: ${root}`);
    if (!loaded.present) console.log('  (the directory does not exist — nothing to validate)');
    if (!loaded.packs.length && !report.packs.length) console.log('  no packs found');
    for (const p of report.packs) {
      console.log(`\npack ${p.pack}${p.name ? ` (${p.name})` : ''}${p.files ? ` — ${p.files.join(', ')}` : ''}`);
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
