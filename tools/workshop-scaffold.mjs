#!/usr/bin/env node
// tools/workshop-scaffold.mjs — turn an authoring spec into a valid 创意工坊 pack (docs/WORKSHOP.md).
//
// This is the "hand it to an ordinary AI" entry point: the spec carries only what a human (or a model) actually knows —
// name, tier, profession, and the normal/elite numbers and skill text — and every mechanical field (id linking, price,
// rarity, dmgType/attackKind/projectile, immunities, status, empty talents) is derived by shared/chessAuthoring.js.
//
// Usage:
//   node tools/workshop-scaffold.mjs <spec.json> --pack <packId> [--workshop <root>] [--dry-run] [--json]
//   node tools/workshop-scaffold.mjs - --pack <packId>            # spec on stdin
//
// It writes <root>/<packId>/chess.json (merging into an existing file) and creates pack.json when missing, then prints
// the derived records and every validation warning. Run tools/workshop-validate.mjs afterwards for the engine check.
//
// Exit codes: 0 = written (warnings allowed), 1 = the spec is invalid, 2 = bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveChessRecord, validateChessRecord, formatIssues, authoringErrors } from '../shared/chessAuthoring.js';
import { deriveStage } from '../server/stageAuthoring.js';
import { WORKSHOP_DIR } from '../server/workshop.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL_IDS = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'))));
const USAGE = 'usage: node tools/workshop-scaffold.mjs <spec.json|-> --pack <packId> [--workshop <root>] [--dry-run] [--json]';

function parseArgs(argv) {
  const out = { spec: null, pack: null, workshop: WORKSHOP_DIR, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pack') { out.pack = argv[++i]; if (out.pack === undefined) throw new Error('--pack needs an id'); }
    else if (a === '--workshop') { const v = argv[++i]; if (v === undefined) throw new Error('--workshop needs a path'); out.workshop = path.resolve(v); }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-') && a !== '-') throw new Error(`unknown option ${a}`);
    else if (out.spec === null) out.spec = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (out.spec === null) throw new Error('a spec file (or -) is required');
  if (!out.pack || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(out.pack)) throw new Error('--pack must be a slug: letters, digits, _ and - (max 32)');
  return out;
}

function readSpec(src) {
  const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`the spec is not valid JSON: ${e.message}`);
  }
}

/** Merge the derived records into an existing chess.json without touching unrelated entries. */
function mergeChess(existing, added) {
  const out = { ...existing };
  const replaced = [];
  for (const [id, rec] of Object.entries(added)) {
    if (Object.hasOwn(out, id)) replaced.push(id);
    out[id] = rec;
  }
  return { records: out, replaced };
}

/** Ensure the pack manifest lists `file` in its content (creating the manifest when the pack is new). */
function ensurePackManifest(packDir, packId, spec, file) {
  const manifestPath = path.join(packDir, 'pack.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const content = new Set(Array.isArray(m.content) ? m.content : []);
      content.add(file);
      m.content = [...content].sort();
      fs.writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
      return;
    } catch { /* fall through to a fresh manifest */ }
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    id: packId,
    name: typeof spec.name === 'string' && spec.name ? spec.name : packId,
    version: '0.1.0', author: null, license: null, description: null, gameVersion: '0.2.2',
    content: [file], overrides: [],
  }, null, 2)}\n`);
}

/** Write a stage (map) into `<pack>/stages.json`, deriving every mechanical field. */
function scaffoldStage(args, spec) {
  const derived = deriveStage(spec);
  if (!derived.ok) {
    console.error('the stage spec is invalid:');
    console.error(formatIssues(derived.errors.map((e) => ({ ...e, severity: 'error' }))));
    process.exit(1);
  }
  const stage = derived.stage;
  const packDir = path.join(args.workshop, args.pack);
  const stagesPath = path.join(packDir, 'stages.json');
  let replaced = [];
  if (!args.dryRun) {
    fs.mkdirSync(packDir, { recursive: true });
    const existing = fs.existsSync(stagesPath) ? JSON.parse(fs.readFileSync(stagesPath, 'utf8')) : {};
    const merged = mergeChess(existing, { [stage.id]: stage });
    replaced = merged.replaced;
    fs.writeFileSync(stagesPath, `${JSON.stringify(merged.records, null, 2)}\n`);
    ensurePackManifest(packDir, args.pack, spec, 'stages');
  }
  const summary = {
    pack: args.pack, dir: packDir, wrote: !args.dryRun, replaced,
    stage: stage.id,
    derived: {
      groundPaths: Object.keys(stage.groundPaths).length,
      groundPathsWithDevices: Object.keys(stage.groundPathsWithDevices).length,
      deployMelee: stage.deployTiles.normal.melee.length,
      deployRanged: stage.deployTiles.normal.rangedOnly.length,
    },
    warnings: derived.warnings,
  };
  if (args.json) console.log(JSON.stringify({ ...summary, record: stage }, null, 2));
  else {
    console.log(`${args.dryRun ? 'dry run:' : 'wrote'} ${stagesPath}`);
    console.log(`  stage ${stage.id}  ${stage.name}  ${stage.size[0]}×${stage.size[1]}  weight ${stage.weight}  modes [${stage.modes.join(', ') || '—'}]`);
    console.log(`  derived: ${summary.derived.groundPaths} ground route(s), ${summary.derived.groundPathsWithDevices} with devices, deploy ${summary.derived.deployMelee} melee / ${summary.derived.deployRanged} ranged`);
    if (replaced.length) console.log(`  replaced: ${replaced.join(', ')}`);
    for (const w of derived.warnings) console.log(`  WARN  ${w}`);
    console.log(`\nnext: node tools/workshop-validate.mjs ${packDir}`);
  }
  process.exit(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = readSpec(args.spec);
  // A spec with `rows` is a STAGE (map): it has its own derive/validate pair. The mechanical fields of a stage — the two
  // path tables and the deploy tiles — are DERIVED by the sim, never authored (server/stageAuthoring.js).
  if (spec && typeof spec === 'object' && spec.rows !== undefined) return scaffoldStage(args, spec);
  const derived = deriveChessRecord(spec);
  if (!derived.ok) {
    console.error('the spec is invalid:');
    console.error(formatIssues(derived.errors.map((e) => ({ ...e, severity: 'error' }))));
    process.exit(1);
  }
  const added = { [derived.base.chessId]: derived.base, [derived.golden.chessId]: derived.golden };

  // validate what we are about to write, before touching the disk
  const issues = [];
  for (const [id, rec] of Object.entries(added)) issues.push(...validateChessRecord(rec, { id, officialIds: OFFICIAL_IDS }));
  const errors = authoringErrors(issues);
  if (errors.length) {
    console.error('the derived records did not validate (this is a bug in chessAuthoring, please report it):');
    console.error(formatIssues(errors));
    process.exit(1);
  }
  const warnings = [...derived.warnings, ...issues.filter((i) => i.severity === 'warning').map((i) => formatIssues([i]))];

  const packDir = path.join(args.workshop, args.pack);
  const chessPath = path.join(packDir, 'chess.json');
  const packPath = path.join(packDir, 'pack.json');
  let replaced = [];
  let wrote = false;
  if (!args.dryRun) {
    fs.mkdirSync(packDir, { recursive: true });
    const existing = fs.existsSync(chessPath) ? JSON.parse(fs.readFileSync(chessPath, 'utf8')) : {};
    const merged = mergeChess(existing, added);
    replaced = merged.replaced;
    fs.writeFileSync(chessPath, `${JSON.stringify(merged.records, null, 2)}\n`);
    if (!fs.existsSync(packPath)) {
      const manifest = {
        id: args.pack,
        name: typeof spec.name === 'string' ? spec.name : args.pack,
        version: '0.1.0',
        author: null,
        license: null,
        description: null,
        gameVersion: '0.2.2',
        content: ['chess'],
        overrides: [],
      };
      fs.writeFileSync(packPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    wrote = true;
  }

  if (args.json) {
    console.log(JSON.stringify({ pack: args.pack, dir: packDir, wrote, replaced, chess: Object.keys(added), warnings, derived: added }, null, 2));
  } else {
    console.log(`${wrote ? 'wrote' : 'dry run:'} ${chessPath}`);
    for (const id of Object.keys(added)) {
      const rec = added[id];
      console.log(`  ${rec.isGolden ? 'elite ' : 'normal'} ${id}  ${rec.name}  tier ${rec.tier}  ${rec.profession}/${rec.subProfessionId ?? '-'}  ${rec.dmgType}/${rec.attackKind}  hp ${rec.stats.maxHp} atk ${rec.stats.atk}`);
    }
    if (replaced.length) console.log(`  replaced: ${replaced.join(', ')}`);
    if (warnings.length) console.log(`\n${warnings.length} warning(s):\n${warnings.map((w) => `  ${w}`).join('\n')}`);
    console.log(`\nnext: node tools/workshop-validate.mjs ${packDir}`);
  }
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(`workshop-scaffold: ${e.message}`);
  console.error(USAGE);
  process.exit(2);
}
