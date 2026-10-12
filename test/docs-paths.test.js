// The newcomer docs name only paths that exist: every repository path in docs/ARCHITECTURE.md and CONTRIBUTING.md
// (inline code, the diagrams and commands in fenced blocks) and every relative Markdown link. A path with a
// placeholder (`<codename>`, `{a,b}`) or a glob (`*`) is checked up to its last fixed directory; a path ending in `/`
// must be a directory. Outputs that a fresh checkout does not have (downloaded art, vendored libraries) are exempt.
// The design document (0.2.0 split): docs/DESIGN.md is the index, every `## N.` section sits exactly once in
// docs/design/ (the current rules) or docs/history/ (the per-release revisions), the index names each file with its
// sections, and every "DESIGN §N" / "DESIGN §N.M" cited anywhere in the repository is a heading of it.
// The changelog (2026-10-12 split): CHANGELOG.md is the index plus the newest sections, every `## x.y.z — date`
// section sits exactly once in it or in one docs/changelog/*.md volume, the index names each volume's sections,
// and the top file still yields a full page of in-game announcements (they are generated from it — cutting one
// section too many drops one announcement, silently).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { designText, DESIGN_DIRS } from './helpers/designDocs.js';
import { CHANGELOG_DIR, changelogSections, changelogVolumeFiles } from './helpers/changelog.js';
import { engineAnnouncements, NOTICE_LIMITS } from '../server/notices.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Each document with the least number of paths it names (a guard against an extraction that finds nothing). */
const DOCS = [['docs/ARCHITECTURE.md', 100], ['CONTRIBUTING.md', 15]];
/** A repository path starts with one of these top-level directories … */
const TOP = /^(?:server|shared|public|data|tools|test|docs|types|scripts|\.github)\//;
/** … or is one of these root files (README.md is left out: a bare `README.md` often means a folder's own). */
const ROOT_FILES = new Set(['package.json', 'eslint.config.js', 'jsconfig.json', 'CHANGELOG.md', 'CONTRIBUTING.md']);
/** Git-ignored or made at install time. */
const EXEMPT = ['public/assets/', 'public/vendor/', 'data/local-assets.json'];

/** Repository paths named in a Markdown text (inline code and fenced blocks), without duplicates. */
function namedPaths(md) {
  const spans = [];
  const fenced = md.split(/^```.*$/m);
  fenced.forEach((part, i) => {
    if (i % 2 === 1) spans.push(part);                       // a fenced block: every word
    else for (const m of part.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  });
  const out = new Set();
  for (const span of spans) {
    for (let token of span.match(/[A-Za-z0-9_.\/*<>{}@-]+/g) ?? []) {
      token = token.replace(/\.+$/, '');
      if (TOP.test(token) || ROOT_FILES.has(token)) out.add(token);
    }
  }
  return [...out];
}

/** The part of a path that must exist: up to the last directory before a placeholder or a glob. */
function fixedPart(path) {
  const parts = path.split('/');
  const i = parts.findIndex((p) => /[*<>{}]/.test(p));
  if (i < 0) return { path, dir: path.endsWith('/') };
  return { path: parts.slice(0, i).join('/') + '/', dir: true };
}

function missing(path) {
  if (EXEMPT.some((e) => path === e || path.startsWith(e) || `${path}/` === e)) return null;
  const { path: fixed, dir } = fixedPart(path);
  const abs = join(ROOT, fixed.replace(/\/$/, ''));
  if (!existsSync(abs)) return `${path}: not found`;
  if (dir && !statSync(abs).isDirectory()) return `${path}: not a directory`;
  return null;
}

for (const [docPath, least] of DOCS) {
  const md = readFileSync(join(ROOT, docPath), 'utf8');

  test(`${docPath}: every repository path it names exists`, () => {
    const paths = namedPaths(md);
    assert.ok(paths.length >= least, `only ${paths.length} paths found — is the extraction broken?`);
    const bad = paths.map(missing).filter(Boolean);
    assert.deepEqual(bad, [], `stale paths in ${docPath}`);
  });

  test(`${docPath}: every relative link resolves`, () => {
    const bad = [];
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const file = normalize(join(ROOT, dirname(docPath), target.replace(/#.*$/, '')));
      if (!existsSync(file)) bad.push(target);
    }
    assert.deepEqual(bad, [], `broken links in ${docPath}`);
  });
}

test('the path extraction: placeholders, globs, directories and the exemptions', () => {
  const md = 'a `server/sim/content/kits/ops/op-<codename>.js` b `data/*.json` c `node tools/golden.mjs --update`\n'
    + '```\nnpm test → test/golden.test.js; public/assets/ README.md\n```\n';
  assert.deepEqual(namedPaths(md).sort(), ['data/*.json', 'public/assets/', 'server/sim/content/kits/ops/op-<codename>.js', 'test/golden.test.js', 'tools/golden.mjs'].sort());
  assert.deepEqual(fixedPart('server/sim/content/kits/ops/op-<codename>.js'), { path: 'server/sim/content/kits/ops/', dir: true });
  assert.equal(missing('public/assets/'), null);
  assert.equal(missing('server/no-such-file.js'), 'server/no-such-file.js: not found');
  assert.equal(missing('server/index.js/'), 'server/index.js/: not a directory');
});

/** The `## N.` section headings of a Markdown text. */
const sectionsOf = (md) => [...md.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));

test('DESIGN: every section is a `## N.` heading exactly once in docs/design/ or docs/history/, and the index names its file', () => {
  const index = readFileSync(join(ROOT, 'docs/DESIGN.md'), 'utf8');
  const where = new Map();                                    // § → the file that holds it
  for (const dir of DESIGN_DIRS) {
    for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith('.md')).sort()) {
      const file = `${dir}/${f}`;
      const md = readFileSync(join(ROOT, file), 'utf8');
      assert.match(md, /^# DESIGN §\d+(?:, §\d+)* — .+\n\nPart of \[DESIGN\.md\]\(\.\.\/DESIGN\.md\)/, `${file}: its title and the pointer to the index`);
      for (const n of sectionsOf(md)) {
        assert.ok(!where.has(n), `§${n} is in ${where.get(n)} and in ${file}`);
        where.set(n, file);
      }
    }
  }
  assert.deepEqual(sectionsOf(index), [], 'the index holds no section of its own');
  const max = Math.max(...where.keys());
  assert.ok(max >= 25, `sections up to §${max}`);
  for (let n = 0; n <= max; n++) assert.ok(where.has(n), `§${n} has a file`);
  // the index's table: one row per file, naming exactly the sections that file holds, with a link that resolves
  const listed = new Map();
  for (const [, secs, text, href] of index.matchAll(/^\| ((?:§\d+(?:, )?)+) \| \[([^\]]+)\]\(([^)]+)\) \|/gm)) {
    const file = `docs/${href}`;
    assert.equal(text, href, `${file}: the link text is its path`);
    assert.ok(existsSync(join(ROOT, file)), `${file} exists`);
    const ns = secs.split(', ').map((x) => Number(x.slice(1)));
    const held = [...where].filter(([, f]) => f === file).map(([n]) => n).sort((a, b) => a - b);
    assert.deepEqual(ns, held, `${file}: the index row names the sections it holds`);
    for (const n of ns) listed.set(n, file);
  }
  assert.equal(listed.size, where.size, 'the index names every section');
});

test('DESIGN: every "DESIGN §N" cited in the repository (code comments, tests, docs, data) is a heading of the design document', () => {
  const heads = new Set([...designText(ROOT).matchAll(/^#{2,4} (\d+(?:\.\d+)*)[. ]/gm)].map((m) => m[1]));
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.(?:m?js|cjs|md|json|html|css|ya?ml|sh|bat|ps1|py|txt)$/.test(f) && !f.startsWith('test/golden/'));
  let cited = 0;
  const bad = [];
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;                 // deleted in the working tree, not yet in the index
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/DESIGN(?:\.md)?[ ,]*§ ?(\d+(?:\.\d+)*)/g)) {
      cited++;
      if (!heads.has(m[1])) bad.push(`${f}: §${m[1]}`);
    }
  }
  assert.ok(cited >= 700, `only ${cited} citations found — is the scan broken?`);
  assert.deepEqual(bad, [], 'citations of a section or subsection with no heading');
});

test('CHANGELOG: every `## x.y.z — date` section sits exactly once in the index or a volume, the index names each volume\'s sections, and the top file still yields a full page of announcements', () => {
  const top = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const files = ['CHANGELOG.md', ...changelogVolumeFiles(ROOT).map((f) => `${CHANGELOG_DIR}/${f}`)];
  /** 节（保留 `-<上游>` 半边 —— 两节可以只差它）→ 住在哪个文件。 */
  const where = new Map();
  for (const file of files) {
    const md = readFileSync(join(ROOT, file), 'utf8');
    if (file !== 'CHANGELOG.md') {
      assert.match(md, /^# 更新记录 · \d+\.\d+ 分卷\n\nPart of \[CHANGELOG\.md\]\(\.\.\/CHANGELOG\.md\)/,
        `${file}: 它的标题与指回索引的那一行`);
    }
    for (const s of changelogSections(md)) {
      assert.ok(!where.has(s.release), `${s.release} 在 ${where.get(s.release)} 与 ${file} 里各有一份`);
      where.set(s.release, file);
    }
  }
  assert.ok(where.size >= 44, `只找到 ${where.size} 节 —— 抽取是不是坏了？`);
  assert.ok(where.has('0.1.0'), '最早那一节（0.1.0）还在册');
  assert.ok(where.has('0.17.0-0.2.4'), '最新那一节（带 `-<上游>` 半边的）还在册');
  // 索引那张表：一行一卷，点名的版本必须**恰好**是该文件持有的那些（顺序也一致：新 → 旧）
  const held = (file) => [...where].filter(([, f]) => f === file).map(([v]) => v);
  let rows = 0;
  for (const m of top.matchAll(/^\| ([^|]+) \| ([^|]+) \| [^|]+ \| ([^|]+) \|$/gm)) {
    const label = m[1].trim();
    if (label === '卷' || /^-+$/.test(label)) continue;        // 表头与分隔行
    rows++;
    const target = m[3].trim();
    const file = target === '本文' ? 'CHANGELOG.md' : (target.match(/^\[[^\]]+\]\(([^)]+)\)$/)?.[1] ?? target);
    assert.ok(files.includes(file), `索引里的「${label}」点名了 ${file} —— 它不在分卷清单里`);
    assert.deepEqual(m[2].split(' · ').map((x) => x.trim()), held(file),
      `${file}: 索引那一行点名的版本与它实际持有的对不上`);
  }
  assert.equal(rows, files.length, '索引一行一卷，一卷不少');
  // 顶层那一段必须仍能发满一页公告：公告**就是**从它生成的，少一节就少一条（而且是静默的）
  const list = engineAnnouncements({ changelogPath: join(ROOT, 'CHANGELOG.md') });
  assert.equal(list.length, NOTICE_LIMITS.announcements,
    `顶层只发得出 ${list.length} 条公告（上限 ${NOTICE_LIMITS.announcements}）—— 再往下切就会静默少发，把节挪回顶层`);
});
