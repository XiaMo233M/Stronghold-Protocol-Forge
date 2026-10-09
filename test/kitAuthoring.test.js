// test/kitAuthoring.test.js — checking a workshop behaviour-layer kit (shared/kitAuthoring.js).
//
// A kit is the one content kind that is CODE, so it cannot be derived — but almost every way it goes wrong is static and
// SILENT: the loader skips a file with no default export (the operator just plays with the generic kit), an import
// resolves for the server and not the browser, a Math.random() makes the server's recomputation reject the player's
// result, and `battle.on('beforeAttck', …)` registers on a bus that never emits that name. None of these throw.
//
// The vocabulary check is the one that needs a drift guard: HOOK_EVENTS is a hand-kept list, so this suite re-extracts
// the engine's real emit() names from the sources and requires an exact match.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { HOOK_EVENTS, HOOK_BUS, KIT_FORBIDDEN_GLOBALS, hookNamesInSource, nearestEvent, validateKit, kitErrors } from '../shared/kitAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_KIT = join(ROOT, 'docs/examples/kit-demo/kits/chess_ws_abyss_hunter_a.js');

const codes = (issues) => issues.map((i) => i.code).sort();
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));

describe('kit authoring: the hook vocabulary is the engine\'s, not a guess', () => {
  test('HOOK_EVENTS is exactly the set of names the engine emits', () => {
    const emitted = new Set();
    for (const file of [...walk(join(ROOT, 'server/sim')), ...walk(join(ROOT, 'public/js'))]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\.emit\(\s*(['"`])([A-Za-z_][\w:]*)\1/g)) emitted.add(m[2]);
    }
    const declared = [...HOOK_EVENTS].sort();
    assert.deepEqual(declared, [...emitted].sort(),
      'the hook list drifted from the engine: a kit hooking a listed name that is gone would silently never fire');
  });

  test('every declared name is a plausible event name and the list has no duplicates', () => {
    assert.equal(new Set(HOOK_EVENTS).size, HOOK_EVENTS.length);
    for (const n of HOOK_EVENTS) assert.match(n, /^[A-Za-z_][\w:]*$/, `${n} is not an event name`);
    assert.ok(HOOK_EVENTS.length > 20, 'the bus is a large surface; a short list means the scan broke');
  });

  test('a near-miss is answered with a suggestion, a wild guess is not', () => {
    assert.equal(nearestEvent('beforeAttck'), 'beforeAttack');
    assert.equal(nearestEvent('damged'), 'damaged');
    assert.equal(nearestEvent('completelyUnrelatedEventName'), null, 'a bad suggestion is worse than none');
    assert.equal(nearestEvent('tick'), 'tick');
  });
});

// 归因（本次修复）：教作者写钩子的那段话曾经用手写行号指向 `server/sim/Battle.js`，而 `on` / `emit` 早就搬进了
// `server/sim/battle/hooks.js`（Battle.js 里已经没有这两个方法）—— 引用烂掉时没有任何东西会报错，作者照着点进去
// 看到的是别的东西。所以这里把「总线在哪」钉成 HOOK_BUS 的两个符号：方法改名 / 再搬家时测试会响，而不是等下一个作者踩空。
describe('kit authoring: where the hook bus lives is pinned by symbol, not by a line number', () => {
  test('HOOK_BUS.file really declares HOOK_BUS.register and HOOK_BUS.fire', () => {
    const src = fs.readFileSync(join(ROOT, HOOK_BUS.file), 'utf8');
    for (const name of [HOOK_BUS.register, HOOK_BUS.fire]) {
      assert.match(src, new RegExp(`^\\s{2}${name}\\s*\\(`, 'm'), `${name}() must still be declared in ${HOOK_BUS.file}`);
    }
    // and the file the old citation pointed at must NOT be where they live: that is what made it rot
    const battle = fs.readFileSync(join(ROOT, 'server/sim/Battle.js'), 'utf8');
    for (const name of [HOOK_BUS.register, HOOK_BUS.fire]) {
      assert.doesNotMatch(battle, new RegExp(`^\\s{2}${name}\\s*\\(`, 'm'), `server/sim/Battle.js declares ${name}() again — update HOOK_BUS and the header`);
    }
    assert.match(battle, /battle\/hooks\.js/, 'Battle.js is where the container is installed, so it must still name it');
  });

  test('the author-facing text never cites the hook bus as `Battle.js:<line>` again', () => {
    for (const rel of ['shared/kitAuthoring.js', 'docs/WORKSHOP.md']) {
      const text = fs.readFileSync(join(ROOT, rel), 'utf8');
      const stale = [...text.matchAll(/Battle\.js:\d+/g)].map((m) => m[0]);
      assert.deepEqual(stale, [], `${rel} cites ${stale.join(', ')} — the bus is ${HOOK_BUS.file}, and a line number there rots silently`);
      assert.match(text, /HOOK_BUS/, `${rel} must name the bus by the symbol the guard reads`);
    }
    // the two names the docs promise are the two names a kit actually calls
    assert.deepEqual([HOOK_BUS.register, HOOK_BUS.fire], ['on', 'emit']);
  });
});

describe('kit authoring: the shipped example kit is the reference', () => {
  test('it validates with no issues at all', () => {
    const source = fs.readFileSync(DEMO_KIT, 'utf8');
    const issues = validateKit(source, { id: 'chess_ws_abyss_hunter_a', ownChessIds: ['chess_ws_abyss_hunter_a'] });
    assert.deepEqual(issues, [], `the shipped demo kit must be clean, got ${JSON.stringify(issues)}`);
  });

  test('its own header explains the import rule — and prose must not trip it', () => {
    const source = fs.readFileSync(DEMO_KIT, 'utf8');
    // 示例 kit 讲的是「三条硬规则」，它的头注释里写着 `import` 这个词并解释相对路径为什么不行：
    // 这段说明文字**不得**被扫描器当成真的依赖（§28.18 之后 `./…` 是合法形式，示例仍然一个 import 都不写）。
    assert.match(source, /不能 import/, 'the demo kit documents the rule in a comment');
    assert.deepEqual(kitErrors(validateKit(source, { id: 'chess_ws_abyss_hunter_a', ownChessIds: ['chess_ws_abyss_hunter_a'] })), []);
  });
});

describe('kit authoring: the three rules that fail silently', () => {
  const kit = (body) => `export default function kit(bb, chess, def) { return { ${body} }; }`;

  test('no default export is an error, because the loader skips the file', () => {
    const issues = validateKit('function kit() { return {}; }', { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] });
    assert.deepEqual(codes(issues), ['NO_DEFAULT_EXPORT']);
    assert.match(issues[0].message, /default-export/);
  });

  test('an import is an error — the same file is loaded by path AND by URL', () => {
    for (const src of [
      `import { x } from '../../sim/battle.js';\n${kit('')}`,
      `import x from '/sim/x.js';\n${kit('')}`,
      `const x = require('./x.js');\n${kit('')}`,
      `export { x } from '../shared/tier1.js';\n${kit('')}`,
      `import x from './lib/x.mjs';\n${kit('')}`,
    ]) {
      assert.ok(codes(validateKit(src, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] })).includes('KIT_IMPORT'), src);
    }
  });

  test('§28.18: a DOWNWARD relative import or re-export of the kit\'s own package is not an error', () => {
    // `../…` walks up and can never agree on both ends; `./…` means `<packDir>/kits/…` on disk and
    // `/workshop-kits/<pack>/…` in the browser — the same file (DESIGN §28.18). A re-export is the same dependency.
    for (const src of [`import { x } from './lib/x.js';\n${kit('')}`, `export { x } from './lib/x.js';\n${kit('')}`]) {
      assert.deepEqual(kitErrors(validateKit(src, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] })), [], src);
    }
  });

  test('an import that only appears in a comment is not an import', () => {
    const src = `// import { helper } from '../../sim/helpers.js'  ← would break the browser\n${kit('')}`;
    assert.deepEqual(kitErrors(validateKit(src, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] })), []);
  });

  test('a browser global or a wall clock is a warning: the server recomputes and rejects', () => {
    const src = kit(`talents: [{ install(battle, unit) { battle.addBuff(unit, { key: String(Math.random()) }); if (Date.now() > 0) fetch('/x'); const d = document.body; } }]`);
    const issues = validateKit(src, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] });
    for (const needle of ['Math.random', 'Date.now', 'fetch', 'document']) {
      assert.ok(issues.some((i) => i.code === 'KIT_NONDETERMINISTIC' && i.message.includes(needle)), `${needle} must be reported`);
    }
    assert.deepEqual(kitErrors(issues), [], 'these are warnings: the kit still loads');
  });

  test('a longer name that merely contains a forbidden one is not reported', () => {
    // the check is on identifiers, not substrings: `myDocument` is not `document`, and `battle.setTimeout` is the
    // engine's own helper rather than the global timer
    const src = kit(`talents: [{ install(battle, unit) { const myDocument = 1; const r = ({ Math2: { randomize: () => 1 } }); battle.setTimeout(() => {}, 1); use(myDocument, r); } }]`);
    assert.deepEqual(codes(validateKit(src, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] })), []);
  });

  test('the forbidden list names why each one breaks the contract', () => {
    for (const [needle, why] of KIT_FORBIDDEN_GLOBALS) {
      assert.ok(needle && why && why.length > 20, `${needle} needs a real explanation`);
    }
    assert.ok(KIT_FORBIDDEN_GLOBALS.some(([n]) => n === 'Math.random') && KIT_FORBIDDEN_GLOBALS.some(([n]) => n === 'Date.now'));
  });
});

describe('kit authoring: the hook bus', () => {
  const kit = (body) => `export default function kit(bb, chess, def) { return { talents: [{ install(battle, unit) { ${body} } }] }; }`;

  test('a handler for an event nothing emits is reported, with the name it probably meant', () => {
    const issues = validateKit(kit(`battle.on('beforeAttck', () => {});`), { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] });
    const hit = issues.find((i) => i.code === 'HOOK_UNKNOWN_EVENT');
    assert.ok(hit, JSON.stringify(issues));
    assert.match(hit.message, /never runs/);
    assert.match(hit.hint, /beforeAttack/);
    assert.equal(hit.severity, 'warning', 'a kit may legitimately hook an event it emits itself');
  });

  test('a real engine event is not reported, through on() or hasHook()', () => {
    for (const name of ['damaged', 'deploy', 'skillStart', 'battleEnd']) {
      const issues = validateKit(kit(`battle.on('${name}', () => {}); if (battle.hasHook('${name}')) battle.on("${name}", () => {});`),
        { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] });
      assert.equal(issues.filter((i) => i.code === 'HOOK_UNKNOWN_EVENT').length, 0, name);
    }
  });

  test('a namespaced event a kit emits itself is legal — that is how official content extends the bus', () => {
    const selfEmitted = kit(`battle.on('mypack:ready', () => {}); battle.emit('mypack:ready', { unit: null });`);
    assert.deepEqual(codes(validateKit(selfEmitted, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] })), []);
    const orphan = kit(`battle.on('mypack:ready', () => {});`);
    assert.deepEqual(codes(validateKit(orphan, { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] })), ['HOOK_UNKNOWN_EVENT']);
  });

  test('a computed event name cannot be checked, and saying so is worth a warning', () => {
    const issues = validateKit(kit(`const name = 'damaged'; battle.on(name, () => {});`), { id: 'chess_ws_x_a', ownChessIds: ['chess_ws_x_a'] });
    assert.deepEqual(codes(issues), ['HOOK_DYNAMIC_NAME']);
  });

  test('the extraction reads literals only, and counts the rest as dynamic', () => {
    const { on, emit, dynamicOn } = hookNamesInSource(`b.on('a', f); b.hasHook("b"); b.emit('c', {}); battle.on(x, f); battle.on(y, f);`);
    assert.deepEqual(on, ['a', 'b']);
    assert.deepEqual(emit, ['c']);
    assert.equal(dynamicOn, 2);
  });

  test('the engine\'s own pick of the vocabulary is what a kit may hook (no invented names)', () => {
    assert.ok(HOOK_EVENTS.includes('damaged') && HOOK_EVENTS.includes('nearl2:knockdown'));
    assert.ok(!HOOK_EVENTS.includes('onHit') && !HOOK_EVENTS.includes('update'), 'these are not engine events');
  });
});

describe('kit authoring: ownership (the same rule loadWorkshopKits enforces)', () => {
  test('a kit for an operator this pack does not define is an error, and names the override that would fix it', () => {
    const src = 'export default function kit() { return {}; }';
    const issues = validateKit(src, { id: 'chess_char_3_18_a', ownChessIds: ['chess_ws_mine_a'], overrides: [] });
    assert.deepEqual(codes(issues), ['KIT_NO_TARGET']);
    assert.match(issues[0].hint, /chess:chess_char_3_18_a/);
  });

  test('declaring the override makes the same kit legal', () => {
    const src = 'export default function kit() { return {}; }';
    assert.deepEqual(kitErrors(validateKit(src, { id: 'chess_char_3_18_a', ownChessIds: [], overrides: ['chess:chess_char_3_18_a'] })), []);
  });

  test('the pack\'s own operator needs no override', () => {
    const src = 'export default function kit() { return {}; }';
    assert.deepEqual(kitErrors(validateKit(src, { id: 'chess_ws_mine_a', ownChessIds: ['chess_ws_mine_a'] })), []);
  });

  test('a bad id and an empty file are refused outright', () => {
    assert.deepEqual(codes(validateKit('', { id: 'not a filename' })), ['BAD_KIT_ID', 'EMPTY_KIT']);
    assert.deepEqual(codes(validateKit('   \n ', { id: 'chess_ws_x_a' })), ['EMPTY_KIT']);
  });
});

describe('kit authoring: the validator runs these checks (the CLI wiring)', () => {
  /** The shipped demo pack, copied, with its kit replaced by one that breaks all three rules. The directory keeps the
   * pack's own id: a manifest id must match its directory, and that mismatch is a different error. */
  const brokenPack = () => {
    const tmp = fs.mkdtempSync(join(tmpdir(), 'sp-kit-cli-'));
    fs.cpSync(join(ROOT, 'docs/examples/kit-demo'), join(tmp, 'kit-demo'), { recursive: true });
    fs.writeFileSync(join(tmp, 'kit-demo/kits/chess_ws_abyss_hunter_a.js'), [
      "import { helper } from '../../sim/helpers.js';",
      'export default function kit(bb, chess, def) {',
      '  return { talents: [{ install(battle, unit) {',
      "    battle.on('beforeAttck', () => {});",
      "    battle.addBuff(unit, { key: 'ws:' + Math.random(), duration: Date.now() ? 1 : 2 });",
      '  } }] };',
      '}',
    ].join('\n'));
    return tmp;
  };

  test('a broken kit is reported as machine-readable issues and fails the run', () => {
    const tmp = brokenPack();
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), join(tmp, 'kit-demo'), '--json'], { encoding: 'utf8', timeout: 120_000 });
      const report = JSON.parse(r.stdout);
      assert.equal(r.status, 1, 'a kit that cannot behave correctly must fail validation');
      const found = (report.kits.issues || []).map((i) => i.code);
      assert.ok(found.includes('KIT_IMPORT'), `expected KIT_IMPORT, got ${JSON.stringify(found)}`);
      assert.ok(found.includes('KIT_NONDETERMINISTIC'), `expected KIT_NONDETERMINISTIC, got ${JSON.stringify(found)}`);
      assert.ok(found.includes('HOOK_UNKNOWN_EVENT'), `expected HOOK_UNKNOWN_EVENT, got ${JSON.stringify(found)}`);
      const typo = (report.kits.issues || []).find((i) => i.code === 'HOOK_UNKNOWN_EVENT');
      assert.match(typo.hint, /beforeAttack/, 'the suggestion must survive to the report');
      assert.match(typo.field, /kits\/kit-demo\/chess_ws_abyss_hunter_a\.js/, 'the issue must name the file');
      // the loader cannot even import this file, and its blunter message must not be counted a second time
      assert.deepEqual(report.kits.errors, [], 'a kit the static layer explained must not be reported twice');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the shipped demo pack still passes, so the new layer is not a wall of noise', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'workshop-validate.mjs'), join(ROOT, 'docs/examples/kit-demo'), '--json'], { encoding: 'utf8', timeout: 120_000 });
    const report = JSON.parse(r.stdout);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(report.kits.issues, []);
    assert.deepEqual(report.kits.errors, []);
    assert.deepEqual(report.kits.loaded, ['chess_ws_abyss_hunter_a']);
  });
});
