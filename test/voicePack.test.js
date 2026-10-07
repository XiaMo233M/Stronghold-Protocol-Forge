// test/voicePack.test.js — scripts/make-voice-pack.mjs 的 CLI 行为（真正打 zip 的那步很慢，由 release 流程手动跑一次，
// 见 CHANGELOG 0.7.2；这里只钉住「不写空包、用法可查」这类会静默出错的地方）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'make-voice-pack.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });

describe('make-voice-pack.mjs (release 的附加配音包)', () => {
  test('--help prints the usage and exits 0 without writing anything', () => {
    const r = run('--help');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--langs=/);
    assert.match(r.stdout, /--include-default/);
    assert.match(r.stdout, /release 附加资产/);
  });

  test('an unknown option throws instead of quietly packing the wrong thing', () => {
    const r = run('--nope');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown option --nope/);
  });

  test('a language list nothing matches fails loudly instead of writing an empty pack', () => {
    const out = join(ROOT, '.cache', 'voice-pack-test.zip');
    rmSync(out, { force: true });
    const r = run('--langs=de,fr', `--out=${out}`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /没有可打包的语言/);
    assert.equal(existsSync(out), false, 'no empty zip is left behind');
  });
});
