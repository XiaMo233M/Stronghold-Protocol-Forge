// test/exportThirdParty.test.js — the third-party export path (tools/export-third-party.mjs).
//
// The point of this script is a legal boundary, so the test checks the boundary holds rather than that a copy happened:
// it must know what is third-party, it must not claim `data/support.json` (a hand-maintained project config) as
// third-party, and a dry run must write NOTHING. A real run is exercised into a temp dir so nothing lands in the repo.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { THIRD_PARTY_SOURCES, collectFiles } from '../tools/export-third-party.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'tools', 'export-third-party.mjs');
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });

describe('third-party export: the boundary', () => {
  test('every source says WHY it is third-party (the bundle has to explain itself)', () => {
    assert.ok(THIRD_PARTY_SOURCES.length >= 5);
    for (const s of THIRD_PARTY_SOURCES) {
      assert.ok(s.path && s.why && s.why.length > 12, `${s.path} needs a real explanation`);
      assert.ok(['dir', 'glob'].includes(s.kind), `${s.path}: kind`);
    }
  });

  test('it collects the game assets and the generated data', () => {
    const rels = collectFiles(ROOT).map((f) => f.rel);
    assert.ok(rels.length, 'the tree must contribute something');
    // categories the NOTICE names
    assert.ok(rels.some((r) => r.startsWith('data/')), 'generated data');
    assert.ok(rels.some((r) => r.startsWith('docs/research/')), 'research');
    assert.ok(rels.some((r) => r.startsWith('public/dev/recordings/')), 'recordings');
    assert.ok(rels.every((r) => !r.startsWith('third-party/')), 'never collect its own bundle');
  });

  test('it does NOT claim the project\'s own files as third-party', () => {
    const rels = new Set(collectFiles(ROOT).map((f) => f.rel));
    // data/support.json is a hand-maintained server config written by this project, not generated from official tables
    assert.equal(rels.has('data/support.json'), false, 'data/support.json is ours, not third-party');
    for (const ours of ['server/index.js', 'shared/workshop.js', 'editor/server.mjs', 'README.md', 'LICENSE', 'NOTICE.md']) {
      assert.equal(rels.has(ours), false, `${ours} must never be exported as third-party`);
    }
    // and only the official-* fixtures, not every fixture
    for (const r of rels) if (r.startsWith('test/fixtures/')) assert.match(r, /official-/, r);
  });

  test('--dry-run writes nothing and reports the sizes', () => {
    const out = join(tmpdir(), `sp-tp-dry-${Date.now()}`);
    const r = run(['--dry-run', '--out', out, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.ok(report.files > 0 && report.bytes > 0);
    assert.equal(report.dryRun, true);
    assert.equal(fs.existsSync(out), false, 'a dry run must not create the output directory');
    assert.ok(Object.keys(report.bySource).length >= 3, 'it must break the report down by source');
  });

  test('a real run produces the bundle with its NOTICE and MANIFEST', () => {
    const out = join(tmpdir(), `sp-tp-${Date.now()}`);
    try {
      // --copy: a temp dir may be on another volume, where hardlinks are impossible
      const r = run(['--out', out, '--copy', '--json']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(fs.existsSync(join(out, 'NOTICE.md')), 'the bundle carries the third-party notice');
      assert.ok(fs.existsSync(join(out, 'MANIFEST.json')), 'and a manifest');
      const notice = fs.readFileSync(join(out, 'NOTICE.md'), 'utf8');
      assert.ok(notice.includes('不属于本项目的 GPL 覆盖范围'), 'the heading states the boundary');
      assert.ok(notice.includes('不在**本项目的 GPL-3.0-or-later'), 'and that the content is outside the licence');
      assert.ok(notice.includes('非商业'), 'and the non-commercial limit');
      assert.match(notice, /Hypergryph/);
      assert.match(notice, /non-commercial/);
      const manifest = JSON.parse(fs.readFileSync(join(out, 'MANIFEST.json'), 'utf8'));
      assert.ok(manifest.files.length > 0);
      for (const f of manifest.files.slice(0, 5)) {
        assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.path} needs a real hash`);
        assert.ok(fs.existsSync(join(out, f.path)), `${f.path} must exist in the bundle`);
      }
      // a spot check that the copy is byte-identical to the source
      const sample = manifest.files.find((f) => f.bytes > 0);
      assert.deepEqual(fs.readFileSync(join(out, sample.path)), fs.readFileSync(join(ROOT, sample.path)), `${sample.path} must be byte-identical`);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  test('the bundle is gitignored so a run never pollutes the repository', () => {
    const r = spawnSync('git', ['check-ignore', '-q', 'third-party/bundle/x'], { cwd: ROOT });
    assert.equal(r.status, 0, 'third-party/bundle/** must be ignored');
  });
});
