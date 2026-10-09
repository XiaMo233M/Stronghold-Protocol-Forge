// test/golden-isolation.test.js — the golden corpus runs the OFFICIAL content, whatever this machine has installed.
//
// docs/PACKS.md §4 promises "The golden results stay on the original content — a pack never changes them", and
// `tools/golden.mjs` keeps that promise by pinning every data entry point of its process to the official files:
// `resetData()` (a 创意工坊 pack under `workshop/` may already have been merged into the process-wide data singleton by
// the time the tool's own line runs — server/sim/simdata.js loads it in a top-level await) followed by
// `getData({ workshopDir: null })` (the overlay off). Only `workshopDir: null` would be a no-op: server/data.js ignores
// the options of every getData() call after the first.
//
// The test does not touch the repository's own `workshop/` directory (node --test runs the files in parallel, so a pack
// written there would leak into every other suite). Instead it reproduces the state a machine with a pack installed
// reaches anyway — a singleton that already holds the pack's records — and then checks that the corpus the tool derives
// from it is the official one:
//   * the pack is a real, live overlay in that process (266 → 268 chess records, docs/examples/demo-workshop);
//   * the roster scenario list and one computed digest equal the STORED golden ones, i.e. neither the pack's operators
//     nor a pack-valued record reached a digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGolden, storedDigests } from '../tools/golden.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = 'chess_char_ws_demo_01_a'; // the shipped example pack's base operator (docs/examples/demo-workshop)
const SCENARIO = 'roster-001';

test('a pack installed on this machine does not move the golden corpus or a digest', { timeout: 5 * 60_000 }, () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sp-golden-iso-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws);
    cpSync(join(ROOT, 'docs/examples/demo-workshop'), join(ws, 'demo-workshop'), { recursive: true });

    // The child: load the pack into the data singleton FIRST (what an import chain or an installed pack does), then let
    // the golden tool load its own data, then read back the data it kept and one of its digests.
    const script = `
      const { pathToFileURL } = await import('node:url');
      const repo = process.env.SP_ISO_REPO, pack = process.env.SP_ISO_PACK;
      const QUIET = { warn() {}, error() {}, info() {}, log() {}, debug() {} };
      const dataMod = await import(pathToFileURL(repo + '/server/data.js').href);
      const polluted = dataMod.getData({ log: QUIET, workshopDir: pack });
      const golden = await import(pathToFileURL(repo + '/tools/golden.mjs').href);
      const pinned = dataMod.getData({ log: QUIET }); // the singleton golden.mjs itself pinned
      const sc = golden.scenariosOf('roster').find((s) => s.id === process.env.SP_ISO_SCENARIO);
      console.log(JSON.stringify({
        polluted: Object.keys(polluted.chess).length,
        pollutedHasPack: Object.hasOwn(polluted.chess, process.env.SP_ISO_PACK_OP),
        pinned: Object.keys(pinned.chess).length,
        pinnedHasPack: Object.hasOwn(pinned.chess, process.env.SP_ISO_PACK_OP),
        ids: golden.scenariosOf('roster').map((s) => s.id),
        digest: golden.runScenario(sc),
      }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 4 * 60_000,
      env: {
        ...process.env,
        SP_ISO_REPO: ROOT, SP_ISO_PACK: ws, SP_ISO_PACK_OP: PACK, SP_ISO_SCENARIO: SCENARIO,
      },
    });
    const r = JSON.parse(out);

    // the pack really is live in that process: without this the test would pass even if nothing had been loaded
    assert.equal(r.polluted, 268, 'the example pack adds two chess records');
    assert.equal(r.pollutedHasPack, true, `the pack's operator must be visible to the polluted singleton`);
    // ... and the tool pinned the official data instead
    assert.equal(r.pinned, 266, 'golden.mjs must keep the official data, not the pack overlay');
    assert.equal(r.pinnedHasPack, false, `the pack's operator must not reach the corpus data`);

    // the corpus of that process is the stored one: same scenario list, same digest
    const doc = loadGolden('roster');
    assert.deepEqual(r.ids, Object.keys(doc.scenarios), 'the roster scenario list must not change when the pack exists');
    assert.deepEqual(r.digest, storedDigests(doc)[SCENARIO], `${SCENARIO} must reproduce its stored digest`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
