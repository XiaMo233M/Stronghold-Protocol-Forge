// test/release-identity.test.js — 发行标识（release）与更新包的身份判断。
//
// 背景（一次真实卡壳）：`scripts/make-update-package.mjs` 原先用 `app/package.json` 的 **version** 当发行身份，
// 而那是本仓库那一半（`0.14.0`）。于是「**Forge 版本不动、只抬上游**」（0.14.0-0.2.3 → 0.14.0-0.2.4）这一对
// 会被判成「自己更新自己」而拒绝出包 —— 而这正是当时发版的形状。发行身份是 **tag**，现在由
// `scripts/make-windows-bundle.mjs` 写进包内 `app/package.json` 的 `release`，随包一起走。
//
// 身份判断分成两件事（两件都必须成立才行，见 samePackage）：
//   * `release`（`0.15.0-0.2.4`）说「这是哪一次发行」——「只抬上游」的下一版就靠它区分；
//   * 构建指纹（包内 `app/MANIFEST.json` 的 sha256）说「这是不是同一个包」——旧包没有 `release` 也能判。
//   **绝不退回比 `version` 相等**：那会把「旧 → 旧」这一对合法升级误杀。
//
// 不联网、不 npm ci、不碰真素材。运行：node --test test/release-identity.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION, UPSTREAM_VERSION } from '../shared/constants.js';
import { releaseIdentity, stampRelease } from '../scripts/make-windows-bundle.mjs';
import { candidateIdentity, identityLabel, main, samePackage } from '../scripts/make-update-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_FILE = 'MANIFEST.json';
const THIS_RELEASE = `${APP_VERSION}-${UPSTREAM_VERSION}`;   // 本版发版标识，如 0.15.0-0.2.4
const PREV_RELEASE = `${APP_VERSION}-0.2.3`;                 // 只差上游的那一版（同一次 Forge 版本线）

const sha = (body) => crypto.createHash('sha256').update(body).digest('hex');
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-identity-${tag}-`));

/**
 * 一个最小的发行包目录：`app/package.json`（带或不带 release）、`app/<MANIFEST_FILE>` 与它列出的文件。
 * 形状与 scripts/make-windows-bundle.mjs 的产物一致（只是没有素材与 node_modules）。
 * `release: null` 就是 0.14.0-0.2.3 及更早那种**没有 release 字段**的真包形态。
 */
function fakeBundle(dir, { version = APP_VERSION, release = THIS_RELEASE, file = 'server/a.js', body = '// a\n' } = {}) {
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'server'), { recursive: true });
  const pkg = { name: 'stronghold-protocol-alliance', version };
  if (release) pkg.release = release;
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(app, file), body);
  const pkgBytes = fs.readFileSync(path.join(app, 'package.json'));
  const files = {
    [file]: { size: Buffer.byteLength(body), sha256: sha(body) },
    'package.json': { size: pkgBytes.length, sha256: sha(pkgBytes) },
  };
  fs.writeFileSync(path.join(app, MANIFEST_FILE), `{"format":1,"app":${JSON.stringify(version)},"files":${JSON.stringify(files)}}\n`);
  return dir;
}

/** 跑一次 main()，收集它打印的两路文本（拒绝都是 console.error + 返回 1，不退出进程）。 */
function run(args) {
  const out = [];
  const err = [];
  const oLog = console.log;
  const oErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try { return { code: main(args), out: out.join('\n'), err: err.join('\n') }; } finally { console.log = oLog; console.error = oErr; }
}

/** bsdtar / zip 能在本机出 zip 吗（与 test/package.test.js 同一个判据）。 */
function hasZipTool() {
  return !spawnSync('zip', ['-v'], { encoding: 'utf8' }).error
    || /bsdtar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout || '');
}

/** 三段 semver 抬一个小版本（`0.15.0` → `0.15.1`）：给「基准包比这一版还新」那条用，不写死版本号。 */
function bumpPatch(version) {
  const [a, b, c] = version.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

describe('发行标识 releaseIdentity / stampRelease（打包侧）', () => {
  test('默认是本仓库版本 + 上游版本，等于 tag v 后面那一串', () => {
    assert.equal(releaseIdentity(), THIS_RELEASE);
    assert.equal(releaseIdentity(''), THIS_RELEASE);
    assert.equal(releaseIdentity(`  ${APP_VERSION}-0.2.5  `), `${APP_VERSION}-0.2.5`, '显式给就用它（首尾空白去掉）');
  });

  test('写不成 tag 形态、或前半段不是本仓库版本，都拒绝', () => {
    for (const bad of [APP_VERSION, `v${THIS_RELEASE}`, UPSTREAM_VERSION, 'latest']) {
      assert.throws(() => releaseIdentity(bad), /--release/, bad);
    }
    assert.throws(() => releaseIdentity('0.13.1-0.2.4'), /APP_VERSION|前半段/, '前半段不是本仓库版本：发版号写错就是发错包');
  });

  test('stampRelease 盖章后 version 一字不动、release 紧跟其后', () => {
    const dir = tmp('stamp');
    try {
      fakeBundle(dir, { release: null });
      assert.equal(stampRelease(path.join(dir, 'app'), THIS_RELEASE), THIS_RELEASE);
      const text = fs.readFileSync(path.join(dir, 'app', 'package.json'), 'utf8');
      const pkg = JSON.parse(text);
      assert.equal(pkg.version, APP_VERSION, 'version 仍是三段 semver（游戏与 test/version.test.js 都按它读）');
      assert.equal(pkg.release, THIS_RELEASE);
      assert.deepEqual(Object.keys(pkg).slice(0, 3), ['name', 'version', 'release'], 'release 紧跟在 version 后面');
      assert.ok(text.endsWith('\n'), '文件以换行结尾（与仓库里的 package.json 一致）');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('包里的代码不是本仓库这一版时拒绝盖章（免得给错版本盖上发行标识）', () => {
    const dir = tmp('stamp-old');
    try {
      fakeBundle(dir, { version: '0.13.1', release: null });
      assert.throws(() => stampRelease(path.join(dir, 'app'), THIS_RELEASE), /version/, '包里的 version 与本仓库不一致');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('同一份包（指纹相同）判为同一个包；只差上游的两个发行判为不同', () => {
    const same = { release: THIS_RELEASE, fingerprint: 'a'.repeat(64) };
    assert.equal(samePackage(same, { release: THIS_RELEASE, fingerprint: 'b'.repeat(64) }), true, '同一次发行的重复打包');
    assert.equal(samePackage(same, { release: PREV_RELEASE, fingerprint: same.fingerprint }), true, '字节完全相同就是同一个包，与标识无关');
    assert.equal(samePackage(same, { release: PREV_RELEASE, fingerprint: 'c'.repeat(64) }), false, '只抬上游：必须放行');
    // 旧包（都没有 release）：靠指纹照样判得出同一个包
    assert.equal(samePackage({ release: null, fingerprint: 'd'.repeat(64) }, { release: null, fingerprint: 'd'.repeat(64) }), true);
    assert.equal(samePackage({ release: null, fingerprint: 'd'.repeat(64) }, { release: null, fingerprint: 'e'.repeat(64) }), false,
      '两个不同的旧包不能被判成同一个（绝不用 version 相等当身份）');
    assert.equal(identityLabel({ release: null, version: '0.14.0' }), '0.14.0', '显示时旧包退回 version');
    assert.deepEqual(candidateIdentity({ version: '0.14.0', release: PREV_RELEASE, fingerprint: 'f'.repeat(64) }),
      { release: PREV_RELEASE, fingerprint: 'f'.repeat(64) }, '身份 = 发行标识 + 构建指纹（version 不参与判定）');
  });
});

describe('更新包的身份判断（出包侧）', () => {
  test('正面：基准包是真实的 0.2.3 形态（只有 version、没有 release）⇒ 必须能出包', { skip: !hasZipTool() && 'no zip / tar' }, () => {
    const newDir = tmp('new');
    const baseDir = tmp('base');
    const outDir = tmp('out');
    try {
      fakeBundle(newDir, { release: THIS_RELEASE, body: '// a2\n' });
      fakeBundle(baseDir, { release: null, body: '// a1\n' });   // 0.14.0-0.2.3 的真包形态
      const zip = path.join(outDir, 'update.zip');
      const r = run(['--bundle', newDir, '--from', baseDir, '--out', zip]);
      assert.equal(r.code, 0, r.err);
      assert.ok(fs.existsSync(zip) && fs.statSync(zip).size > 0, '更新包真的产出了');
      assert.match(r.out, new RegExp(`${APP_VERSION} → v${THIS_RELEASE.replace(/\./g, '\\.')}`), '基准包退回 version 显示，新版说发行标识');
      const listed = spawnSync('tar', ['-tf', zip], { encoding: 'utf8' }).stdout;
      assert.match(listed, /app\/UPDATE\.json/);
      assert.match(listed, /app\/server\/a\.js/, '变了的文件随包带上');
    } finally { for (const d of [newDir, baseDir, outDir]) fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('正面：只抬上游（同一 Forge 版本线 0.2.3 → 0.2.4）⇒ 必须能出包', { skip: !hasZipTool() && 'no zip / tar' }, () => {
    const newDir = tmp('new2');
    const baseDir = tmp('base2');
    const outDir = tmp('out2');
    try {
      fakeBundle(newDir, { release: THIS_RELEASE, body: '// a2\n' });
      fakeBundle(baseDir, { release: PREV_RELEASE, body: '// a1\n' });
      const r = run(['--bundle', newDir, '--from', baseDir, '--out', path.join(outDir, 'update.zip')]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`v${PREV_RELEASE.replace(/\./g, '\\.')} → v${THIS_RELEASE.replace(/\./g, '\\.')}`),
        '摘要说的是发行标识，不是那个说不清的 version');
    } finally { for (const d of [newDir, baseDir, outDir]) fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('反面：同一个包更新自己 ⇒ 点名拒绝（有 release 与无 release 两种都拒绝）', () => {
    const newDir = tmp('self');
    try {
      fakeBundle(newDir, { release: THIS_RELEASE });
      const r = run(['--bundle', newDir, '--from', newDir, '--out', path.join(newDir, 'never.zip')]);
      assert.equal(r.code, 1);
      assert.match(r.err, /基准包就是这一版/, r.err);
      assert.ok(r.err.includes(THIS_RELEASE), '点名说出是哪一个发行');
      assert.match(r.err, /自己更新自己/);
      assert.ok(!fs.existsSync(path.join(newDir, 'never.zip')), '拒绝了就一个字节都不写');

      // 无 release 的旧包：靠指纹认出来（这正是旧→旧不被误杀、而自己更新自己被抓住的那条线）
      const bare = tmp('self-bare');
      const bareCopy = tmp('self-bare-copy');
      try {
        fakeBundle(bare, { release: null, body: '// same\n' });
        fakeBundle(bareCopy, { release: null, body: '// same\n' });
        const r2 = run(['--bundle', bare, '--from', bareCopy, '--out', path.join(bare, 'never.zip')]);
        assert.equal(r2.code, 1, '两个字节相同的旧包＝同一个包');
        assert.match(r2.err, /基准包就是这一版/);
        assert.ok(!fs.existsSync(path.join(bare, 'never.zip')));
      } finally { for (const d of [bare, bareCopy]) fs.rmSync(d, { recursive: true, force: true }); }
    } finally { fs.rmSync(newDir, { recursive: true, force: true }); }
  });

  test('反面：旧 → 旧（基准包是没有 release 的旧包）不得误杀', { skip: !hasZipTool() && 'no zip / tar' }, () => {
    const newDir = tmp('old-old');
    const baseDir = tmp('old-old-base');
    const outDir = tmp('old-old-out');
    try {
      // 基准包是 0.14.0-0.2.3 那种形态（只有 version），但两边不是同一个包 ⇒ 必须放行
      fakeBundle(newDir, { release: THIS_RELEASE, body: '// new\n' });
      fakeBundle(baseDir, { release: null, body: '// old\n' });
      const zip = path.join(outDir, 'update.zip');
      const r = run(['--bundle', newDir, '--from', baseDir, '--out', zip]);
      assert.equal(r.code, 0, `基准包没有 release 时必须能出包（曾经误杀在这里）：${r.err}`);
      assert.ok(fs.existsSync(zip));
    } finally { for (const d of [newDir, baseDir, outDir]) fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('反面：基准包的 version 比这一版还新 ⇒ 拒绝（更新包只往上走，用纯 version 排序）', () => {
    const newDir = tmp('down');
    const aheadDir = tmp('ahead');
    try {
      fakeBundle(newDir, { release: THIS_RELEASE });
      fakeBundle(aheadDir, { release: `${bumpPatch(APP_VERSION)}-0.2.9`, version: bumpPatch(APP_VERSION) });
      const r = run(['--bundle', newDir, '--from', aheadDir, '--out', path.join(newDir, 'never.zip')]);
      assert.equal(r.code, 1);
      assert.match(r.err, /还新/, r.err);
      assert.ok(!fs.existsSync(path.join(newDir, 'never.zip')));
    } finally { for (const d of [newDir, aheadDir]) fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('反面：这一版的 bundle 没有 release ⇒ 拒绝并说清怎么办（记在待办里的硬要求）', () => {
    const dir = tmp('unstamped');
    const stampedBase = tmp('unstamped-base');
    try {
      fakeBundle(dir, { release: null });
      fakeBundle(stampedBase, { release: PREV_RELEASE });
      const r1 = run(['--bundle', dir, '--from', stampedBase, '--out', path.join(dir, 'never.zip')]);
      assert.equal(r1.code, 1, '无 release 的 bundle 一律拒出包（否则「只抬上游」分不开这一版与上一版）');
      assert.match(r1.err, /没有 release/, r1.err);
      assert.match(r1.err, /make-windows-bundle/, '说清用哪个脚本重打');
      assert.ok(!fs.existsSync(path.join(dir, 'never.zip')));
    } finally { for (const d of [dir, stampedBase]) fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('基准包是一个 zip（顶层唯一文件夹）时同样认得出身份', { skip: !hasZipTool() && 'no zip / tar' }, () => {
    const newDir = tmp('zipnew');
    const baseDir = tmp('zipbase');
    const packed = tmp('zippack');
    const outDir = tmp('zipout');
    try {
      fakeBundle(newDir, { release: THIS_RELEASE, body: '// a2\n' });
      fakeBundle(path.join(packed, 'base-rel'), { release: PREV_RELEASE, body: '// a1\n' });
      const zipPath = path.join(baseDir, 'base.zip');
      fs.mkdirSync(baseDir, { recursive: true });
      const z = spawnSync('tar', ['-c', '--format', 'zip', '-f', zipPath, '-C', packed, 'base-rel'], { encoding: 'utf8' });
      assert.equal(z.status, 0, z.stderr);
      const r = run(['--bundle', newDir, '--from', zipPath, '--out', path.join(outDir, 'update.zip')]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`v${PREV_RELEASE.replace(/\./g, '\\.')} → v${THIS_RELEASE.replace(/\./g, '\\.')}`));
    } finally { for (const d of [newDir, baseDir, packed, outDir]) fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('本轮抬版本的落地：current-state 版本声明', () => {
  test('package.json / package-lock.json / APP_VERSION 说的是同一个版本', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, APP_VERSION);
    assert.equal(lock.version, APP_VERSION);
    assert.equal(lock.packages[''].version, APP_VERSION);
  });

  test('发行标识由两个常量拼出来，且等于 tag v 后面那一串', () => {
    assert.equal(releaseIdentity(), `${APP_VERSION}-${UPSTREAM_VERSION}`);
    assert.match(UPSTREAM_VERSION, /^\d+\.\d+\.\d+$/);
  });
});
