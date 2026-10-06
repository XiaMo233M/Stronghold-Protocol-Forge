// test/kitEditor.test.js — the behaviour-layer (kit) page of the standalone workshop editor, end to end.
//
// A kit is the ONLY content kind that is CODE. The other four are data: a spec is the editable source and a generated
// artifact is what the game reads. A kit has neither half — `<pack>/kits/<chessId>.js` is both — so the editor edits the
// file's TEXT, and the only honest live answer it can give is the STATIC one (shared/kitAuthoring.js). Two things this
// suite pins beyond that:
//
//   1. the editor must not become a code-execution surface. Nothing on these endpoints imports the author's file, and
//      the test proves it with a source whose top-level side effect would show up in this very process if it had been
//      evaluated. The real import check belongs to tools/workshop-validate.mjs.
//   2. the authorships stamp travels with the FILE. A `.js` kit has no object to hang `_meta` on, so it carries the same
//      notice in a header comment — and a stamp that resets `created` or stacks a second header on every save is a
//      stamp that lies about who made the thing and when.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { HOOK_EVENTS } from '../shared/kitAuthoring.js';
import { forgeHeader, parseForgeHeader, stampForgeHeader, FORGE_SOURCE, forgeNoticeText } from '../shared/forgeNotice.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const PACK = 'kit-pack';
const OP_ID = 'chess_ws_fixture_a';
const KIT_FILE = () => join(wsRoot, PACK, 'kits', `${OP_ID}.js`);

/** A minimal, legal kit: the loader reads `mod.default`, so that is the one thing a source must have. */
const KIT_OK = [
  'export default function kit(bb, chess, def) {',
  '  return {',
  "    skill: { kind: 'ammo', ammo: 8, mods: { atkPct: bb.atk || 0 } },",
  '    talents: [],',
  '  };',
  '}',
  '',
].join('\n');

const kitDir = () => join(wsRoot, PACK, 'kits');
const readKit = () => fs.readFileSync(KIT_FILE(), 'utf8');

let tmp;
let wsRoot;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-kit-editor-'));
  wsRoot = join(tmp, 'workshop');
  const packDir = join(wsRoot, PACK);
  fs.mkdirSync(kitDir(), { recursive: true });
  // A pack that already ships an operator, because that is what makes a kit legal: the file name must be a chess id
  // this pack contributes, or one it declared it may replace.
  fs.writeFileSync(join(packDir, 'pack.json'), `${JSON.stringify({
    id: PACK, name: 'kit 夹具包', version: '0.1.0', author: '测试作者', license: null, description: null,
    gameVersion: '0.1.3', content: ['chess'], overrides: [],
  }, null, 2)}\n`);
  fs.writeFileSync(join(packDir, 'chess.json'), `${JSON.stringify({ [OP_ID]: { id: OP_ID, name: '夹具干员', tier: 4 } }, null, 2)}\n`);
  // a hand-written kit with a real static error, so the list has something to report
  fs.writeFileSync(KIT_FILE(), 'function kit() { return {}; }\n');
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
});
after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workshop editor: the behaviour layer (the kit API)', () => {
  test('GET /api/kits exposes the vocab, the legal ids and each kit\'s static issues', async () => {
    const r = await fetch(`${editor.url}/api/kits`).then((x) => x.json());
    // the two vocabularies come straight from shared/kitAuthoring.js, so the page cannot invent an event name
    assert.ok(r.vocab.events.includes('beforeAttack') && r.vocab.events.includes('tick'));
    assert.deepEqual([...r.vocab.events].sort(), [...HOOK_EVENTS].sort());
    assert.ok(r.vocab.forbidden.some(([name]) => name === 'Math.random'), 'the forbidden globals must come with why');
    assert.ok(r.vocab.forbidden.every(([name, why]) => name && why.length > 20));

    // the pack's OWN ids, so the author can pick a legal file name instead of guessing one
    const pack = r.packs.find((p) => p.id === PACK);
    assert.ok(pack, 'the pack must be listed');
    assert.deepEqual(pack.ownChessIds, [OP_ID]);
    assert.deepEqual(pack.overrides, []);
    assert.deepEqual(pack.legalIds, [OP_ID]);

    const kit = r.kits.find((k) => k.id === OP_ID);
    assert.ok(kit, 'the hand-written kit must be listed');
    assert.equal(kit.pack, PACK);
    assert.equal(kit.bytes, Buffer.byteLength(fs.readFileSync(KIT_FILE(), 'utf8'), 'utf8'));
    // a kit file IS the editable source: there is no generated half to be "not managed"
    assert.equal(kit.managed, true);
    assert.deepEqual(kit.hooks, []);
    assert.equal(kit.hasNotice, false, 'a hand-written file carries no Forge header yet');
    assert.deepEqual(kit.issues.map((i) => i.code), ['NO_DEFAULT_EXPORT']);
    assert.equal(kit.issues[0].severity, 'error');
  });

  test('GET /api/kits/:pack/:id returns the raw file text, and null when it is absent', async () => {
    const r = await fetch(`${editor.url}/api/kits/${PACK}/${OP_ID}`).then((x) => x.json());
    assert.equal(r.pack, PACK);
    assert.equal(r.id, OP_ID);
    assert.equal(r.source, readKit());
    const missing = await fetch(`${editor.url}/api/kits/${PACK}/chess_ws_nothing_a`).then((x) => x.json());
    assert.equal(missing.source, null, 'an absent kit is a null source, not an error');
    assert.equal((await fetch(`${editor.url}/api/kits/${PACK}/not%20a%20file`)).status, 400);
  });

  test('preview reports a typo\'d hook and an import WITHOUT writing anything', async () => {
    const before = readKit();
    const typo = await post(`${editor.url}/api/kits/preview`, {
      pack: PACK, id: OP_ID,
      source: `export default function kit(bb, chess, def) {\n  return { talents: [{ install(battle, unit) { battle.on('beforeAttck', () => {}); } }] };\n}\n`,
    }).then((x) => x.json());
    assert.equal(typo.ok, true, 'a name nothing emits is a warning: the kit still loads');
    const hit = typo.warnings.find((w) => w.code === 'HOOK_UNKNOWN_EVENT');
    assert.ok(hit, JSON.stringify(typo.warnings));
    assert.match(hit.field, /^hooks\./);
    assert.match(hit.hint, /beforeAttack/, 'the suggestion is the whole point of the check');
    assert.deepEqual(typo.hooks, ['beforeAttck'], 'the hook list it registers is reported for the side panel');
    assert.equal(typo.notice, null);

    const imported = await post(`${editor.url}/api/kits/preview`, {
      pack: PACK, id: OP_ID,
      source: `import { helper } from '../../sim/helpers.js';\n${KIT_OK}`,
    }).then((x) => x.json());
    assert.equal(imported.ok, false);
    assert.deepEqual(imported.errors.map((e) => e.code), ['KIT_IMPORT']);
    assert.equal(imported.errors[0].severity, 'error');

    assert.equal(readKit(), before, 'a preview must not touch the file');
  });

  test('a kit for an id this pack does not define is refused (KIT_NO_TARGET) unless overrides declares it', async () => {
    const bad = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: 'chess_ws_missing_a', source: KIT_OK });
    assert.equal(bad.status, 400);
    const errors = (await bad.json()).errors;
    assert.ok(errors.some((e) => e.code === 'KIT_NO_TARGET'), JSON.stringify(errors));
    assert.match(errors.find((e) => e.code === 'KIT_NO_TARGET').hint, /chess:chess_ws_missing_a/);
    assert.equal(fs.existsSync(join(kitDir(), 'chess_ws_missing_a.js')), false, 'a refused save must not create the file');

    // …and declaring the replacement makes the very same file legal, exactly as loadWorkshopKits decides it
    const manifestPath = join(wsRoot, PACK, 'pack.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, overrides: ['chess:chess_ws_missing_a'] }, null, 2)}\n`);
    const good = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: 'chess_ws_missing_a', source: KIT_OK });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
    assert.equal(fs.existsSync(join(kitDir(), 'chess_ws_missing_a.js')), true);
    // the preview agrees with the save path, because both call the same helper
    const pv = await post(`${editor.url}/api/kits/preview`, { pack: PACK, id: 'chess_ws_missing_a', source: KIT_OK }).then((x) => x.json());
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));

    // put the manifest back, so the rest of the suite runs against the plain shape
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, overrides: [] }, null, 2)}\n`);
    await fetch(`${editor.url}/api/packs/${PACK}/kits/chess_ws_missing_a`, { method: 'DELETE' });
  });

  test('an invalid source is refused with 400 and the file is not (re)created', async () => {
    fs.rmSync(KIT_FILE(), { force: true });
    for (const source of [
      'function kit() { return {}; }',                                                        // rule 1: no default export
      `import { x } from '../../sim/battle.js';\n${KIT_OK}`,                                  // rule 2: an import
      '',                                                                                     // nothing at all
    ]) {
      const r = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source });
      assert.equal(r.status, 400, source);
      const body = await r.json();
      assert.ok(body.errors.length, `a refusal must carry the reason: ${JSON.stringify(body)}`);
      assert.equal(fs.existsSync(KIT_FILE()), false, 'a refused save must not write the file');
    }
    // a bad id is refused before anything else happens
    assert.equal((await post(`${editor.url}/api/packs/${PACK}/kits`, { id: 'not a file', source: KIT_OK })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source: null })).status, 400);
  });

  test('saving writes kits/<id>.js with the Forge header on top', async () => {
    const saved = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source: KIT_OK }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.id, OP_ID);
    assert.deepEqual(saved.warnings, [], 'a clean kit in a loaded pack has nothing to warn about');
    assert.equal(fs.existsSync(KIT_FILE()), true);

    const text = readKit();
    assert.ok(text.startsWith('// @forge '), `the file must OPEN with the header, got: ${text.slice(0, 60)}`);
    const header = parseForgeHeader(text);
    assert.ok(header, 'the header must be machine-readable');
    assert.equal(header.author, '测试作者', 'the author comes from the pack manifest when nothing else names one');
    assert.equal(header.pack, PACK);
    assert.equal(header.source, FORGE_SOURCE);
    assert.match(header.created, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(header.modified, /^\d{4}-\d{2}-\d{2}T/);
    // the five things the notice requires travel with the file: author, creation time, source, copyright, anti-resale
    assert.match(text, /著作权归创建它的作者本人所有/);
    assert.match(text, /property of the author who created it/);
    assert.match(text, /禁止未经授权从公开渠道收集他人 Option 并打包、转售或批量分发/);
    assert.match(text, /bulk-distribute/);
    assert.match(text, /不改变本项目代码的 GPL-3\.0-or-later 授权/);
    // …and the code the loader imports is still intact below it
    assert.ok(text.includes(KIT_OK.trim()));
    assert.equal((text.match(/@forge/g) || []).length, 1);

    // `kits` is NOT a content file: adding it to pack.json.content would make the loader look for a kits.json
    const manifest = JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'pack.json'), 'utf8'));
    assert.deepEqual(manifest.content, ['chess']);
    // the list now reports the stamp, so the page can show the header state without re-parsing anything
    const listed = await fetch(`${editor.url}/api/kits`).then((x) => x.json());
    assert.equal(listed.kits.find((k) => k.id === OP_ID).hasNotice, true);
    assert.deepEqual(listed.kits.find((k) => k.id === OP_ID).issues, []);
  });

  test('re-saving preserves created and moves modified — one header, never two', async () => {
    // pin `created` to a value from long ago, the way an older save would have left it
    const pinned = readKit().replace(/created=\S+/, 'created=2020-01-02T03:04:05.000Z');
    fs.writeFileSync(KIT_FILE(), pinned);
    const saved = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source: KIT_OK }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const header = parseForgeHeader(readKit());
    assert.equal(header.created, '2020-01-02T03:04:05.000Z', 'the author\'s creation instant must survive an edit');
    assert.notEqual(header.modified, header.created);
    assert.equal(header.author, '测试作者');
    assert.equal((readKit().match(/@forge/g) || []).length, 1, 'a re-save must not stack a second header');
    assert.equal((readKit().match(/著作权归创建它的作者本人所有/g) || []).length, 1, 'nor repeat the notice');
    assert.equal(saved.notice.created, '2020-01-02T03:04:05.000Z');
  });

  test('an author\'s own leading comment survives, and is not double-stamped', async () => {
    const mine = '// 我自己的注释：这条 kit 的算法在 docs 里，不要删。';
    const hand = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source: `${mine}\n${KIT_OK}` }).then((x) => x.json());
    assert.equal(hand.ok, true, JSON.stringify(hand));
    let text = readKit();
    assert.ok(text.includes(mine), 'the author\'s comment must be preserved verbatim');
    assert.equal((text.match(/@forge/g) || []).length, 1);

    // saving the SAME file again (the page posts the whole text, header included) changes nothing about the comment
    const again = await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source: text }).then((x) => x.json());
    assert.equal(again.ok, true, JSON.stringify(again));
    text = readKit();
    assert.equal((text.match(/@forge/g) || []).length, 1, 'never a second header');
    assert.equal((text.match(/我自己的注释/g) || []).length, 1, 'and never a stripped comment');
    assert.ok(text.indexOf(mine) > text.indexOf('// @forge'), 'the notice stays on top of it');
  });

  test('the endpoints never import the author\'s file (the editor is not a code-execution surface)', async () => {
    // If any endpoint `import()`ed this source, the assignment below would land in THIS process.
    const sideEffect = `globalThis.__spKitEditorExecuted = true;\n${KIT_OK}`;
    const pv = await post(`${editor.url}/api/kits/preview`, { pack: PACK, id: OP_ID, source: sideEffect }).then((x) => x.json());
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));
    assert.equal(globalThis.__spKitEditorExecuted, undefined, 'preview must not execute the source');
    await post(`${editor.url}/api/packs/${PACK}/kits`, { id: OP_ID, source: sideEffect });
    assert.equal(globalThis.__spKitEditorExecuted, undefined, 'saving must not execute the source either');
    assert.ok(readKit().includes('__spKitEditorExecuted'), 'the text is written, it is just never run here');
    // the static layer is what answered, so a module that would throw on import is simply not its business
    const bomb = await post(`${editor.url}/api/kits/preview`, { pack: PACK, id: OP_ID, source: `throw new Error('boom');\n${KIT_OK}` }).then((x) => x.json());
    assert.equal(bomb.ok, true, 'a runtime throw is invisible to static checking — and the CLI is where it surfaces');
  });

  test('deleting removes the file', async () => {
    assert.equal(fs.existsSync(KIT_FILE()), true);
    const del = await fetch(`${editor.url}/api/packs/${PACK}/kits/${OP_ID}`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(del.removed, OP_ID);
    assert.equal(fs.existsSync(KIT_FILE()), false);
    // deleting twice is not an error: the caller's intent is satisfied either way
    assert.equal((await fetch(`${editor.url}/api/packs/${PACK}/kits/${OP_ID}`, { method: 'DELETE' })).status, 200);
  });

  test('the kit page is part of the editor, and all six pages link to each other', async () => {
    const html = await fetch(`${editor.url}/kit.html`).then((r) => r.text());
    assert.match(html, /工坊 kit（行为层）编辑器/);
    assert.match(html, /<textarea|src="\.\/kit\.js"/);
    assert.equal((await fetch(`${editor.url}/kit.js`)).status, 200);
    // the cheat sheet links to the real document, and the editor serves it (markdown only)
    const page = await fetch(`${editor.url}/kit.js`).then((r) => r.text());
    assert.match(page, /\/docs\/prompts\/README\.md/);
    const doc = await fetch(`${editor.url}/docs/prompts/README.md`);
    assert.equal(doc.status, 200);
    assert.match(doc.headers.get('content-type') || '', /markdown/);
    // …but that mount is not a way to fetch arbitrary repository files
    assert.equal((await fetch(`${editor.url}/docs/examples/kit-demo/kits/chess_ws_abyss_hunter_a.js`)).status, 404);
    assert.equal((await fetch(`${editor.url}/docs/../package.json`)).status, 404);
    assert.equal((await fetch(`${editor.url}/docs/prompts/../../package.json`)).status, 404);

    // the six pages, every one linking to every OTHER one — kit.html included, so nothing is reachable only by typing
    const pages = ['index.html', 'stage.html', 'enemy.html', 'wave.html', 'item.html', 'kit.html'];
    for (const from of pages) {
      const other = await fetch(`${editor.url}/${from}`).then((r) => r.text());
      for (const to of pages) {
        if (to === from) continue;
        assert.match(other, new RegExp(to.replace('.', '\\.')), `${from} must link to ${to}`);
      }
    }
  });

  test('the page is plain DOM: a textarea, no bundler, no client import', async () => {
    const page = await fetch(`${editor.url}/kit.js`).then((r) => r.text());
    // code in a textarea is correct: a syntax highlighter would be a dependency and a source of drift for no gain
    assert.match(page, /createElement\('textarea'\)/);
    assert.doesNotMatch(page, /\bimport\s+[\w{*]/);
    assert.doesNotMatch(page, /import\(/, 'no dynamic import either');
    assert.match(page, /\/api\/kits\/preview/);
  });
});

// The header functions live in shared/forgeNotice.js (the `_meta` half of the same requirement); they are pure, so the
// round-trip rules are tested here rather than only through HTTP.
describe('forge notice: the file header (pure functions)', () => {
  const T1 = '2026-03-04T05:06:07.000Z';
  const T2 = '2026-09-09T09:09:09.000Z';
  const src = 'export default function kit() { return {}; }\n';

  test('forgeHeader writes one machine-readable line and then the notice prose', () => {
    const block = forgeHeader('', { author: '水沫沐沐', packId: 'my-pack', now: T1 });
    const lines = block.split('\n');
    assert.equal(lines[0], `// @forge created=${T1} modified=${T1} pack=my-pack source=${FORGE_SOURCE} author=水沫沐沐`);
    assert.ok(block.endsWith('\n'), 'the block can be prepended as-is');
    // the prose is the SAME statement the JSON specs carry — one source of truth, two containers
    for (const paragraph of forgeNoticeText().split('\n').filter((l) => l.trim())) assert.ok(block.includes(`// ${paragraph}`), paragraph.slice(0, 20));
    assert.ok(block.split('\n').slice(0, -1).every((l) => l === '//' || l.startsWith('// ')), 'every line must be a comment');
  });

  test('stamp → parse is a round trip, and a name with spaces survives it', () => {
    const stamped = stampForgeHeader(src, { author: 'John Doe', packId: 'p', now: T1 });
    assert.ok(stamped.startsWith('// @forge '));
    assert.ok(stamped.endsWith(src), 'the code is untouched below the header');
    const back = parseForgeHeader(stamped);
    assert.deepEqual(back, { created: T1, modified: T1, pack: 'p', source: FORGE_SOURCE, author: 'John Doe' });
    assert.equal(parseForgeHeader(src), null, 'a file with no marker has no header');
    // no pack field is written when there is no pack, and parsing still works
    assert.equal(parseForgeHeader(stampForgeHeader(src, { author: 'a', now: T1 })).pack, null);
  });

  test('re-stamping keeps created, moves modified, and never stacks a second header', () => {
    const once = stampForgeHeader(src, { author: 'a', packId: 'p', now: T1 });
    const twice = stampForgeHeader(once, { author: 'a', packId: 'p', now: T2 });
    assert.equal((twice.match(/@forge/g) || []).length, 1);
    const back = parseForgeHeader(twice);
    assert.equal(back.created, T1, 'created is the author\'s, not this save\'s');
    assert.equal(back.modified, T2);
    assert.equal(forgeHeader(once, { now: T2 }).split('\n')[0], `// @forge created=${T1} modified=${T2} pack=p source=${FORGE_SOURCE} author=a`);
  });

  test('the header block is the only thing rewritten: prose comments around it survive', () => {
    const mine = '// 我自己的注释';
    const once = stampForgeHeader(`${mine}\n${src}`, { author: 'a', now: T1 });
    const twice = stampForgeHeader(once, { author: 'a', now: T2 });
    assert.equal((twice.match(/我自己的注释/g) || []).length, 1);
    assert.ok(twice.includes(`${mine}\n${src}`), 'our block goes ABOVE the author\'s comment and leaves it whole');
  });

  test('a hand-edited instant cannot poison the next save', () => {
    const broken = '// @forge created=yesterday modified=never author=me\nexport default 1;\n';
    const back = parseForgeHeader(broken);
    assert.deepEqual(back, { created: null, modified: null, pack: null, source: null, author: 'me' });
    assert.equal(parseForgeHeader(stampForgeHeader(broken, { now: T2 })).created, T2, 'an unusable date is replaced, not trusted');
    // an explicit author wins over the one already in the file (the pack manifest may have changed)
    assert.equal(parseForgeHeader(stampForgeHeader(broken, { author: '新作者', now: T2 })).author, '新作者');
  });

  test('`previous` is only a fallback: a client that posts bare code cannot reset created', () => {
    const onDisk = stampForgeHeader(src, { author: 'a', packId: 'p', now: T1 });
    const bare = stampForgeHeader(KIT_OK, { author: 'a', packId: 'p', now: T2, previous: onDisk });
    assert.equal(parseForgeHeader(bare).created, T1);
    assert.equal(parseForgeHeader(bare).modified, T2);
    // …but the text in hand always wins, so a page editing the file keeps what it shows
    const edited = stampForgeHeader(onDisk, { author: 'a', packId: 'p', now: T2, previous: stampForgeHeader(src, { author: 'z', now: T1 }) });
    assert.equal(parseForgeHeader(edited).author, 'a');
  });

  test('an empty source gets the header and nothing else', () => {
    const only = stampForgeHeader('', { author: 'a', now: T1 });
    assert.ok(only.startsWith('// @forge '));
    assert.equal(only.trimEnd().endsWith('// 本声明只针对 Option 创作内容，不改变本项目代码的 GPL-3.0-or-later 授权，也不附加任何限制。'), true);
    assert.equal(parseForgeHeader(only).author, 'a');
  });

  test('without an author anywhere the header says so instead of guessing', () => {
    assert.equal(parseForgeHeader(stampForgeHeader(src, { now: T1 })).author, '未署名 (anonymous)');
  });
});
