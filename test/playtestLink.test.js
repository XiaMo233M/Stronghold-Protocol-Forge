// test/playtestLink.test.js — the `?playtest=1[&difficulty=KEY]` deep link (the Forge 一键试玩 button): a solo
// quick start that creates its own room, starts the match, then strips itself from the URL.
//
// No browser, no puppeteer and — deliberately — no `import` of public/js/main.js: that module boots the whole
// client on load (a socket, Preact, the DOM), which both fails under Node and leaves live handles behind, hanging
// `node --test` for every later file. Everything under test is therefore pure and directly importable:
//   * screens/lobby.js        parsePlaytestParam   (validated against the shared DIFFICULTIES list)
//   * playtestLink.js         deepLinkSeeds / stripDeepLinkParams / runSoloPlaytest (deps injected)
// main.js only wires those together; the one fact a unit test cannot observe from them — what boot writes into
// the store — is pinned by reading the store's initial state, and the wiring itself by the source text.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { DIFFICULTIES } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_JS = path.join(ROOT, 'public', 'js');
const mod = (rel) => import(pathToFileURL(path.join(PUBLIC_JS, rel)).href);
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const { parsePlaytestParam, DEFAULT_DIFFICULTY } = await mod('screens/lobby.js');
const { deepLinkSeeds, stripDeepLinkParams, runSoloPlaytest, DEEP_LINK_PARAMS } = await mod('playtestLink.js');

const mainSource = read('public/js/main.js');

// ---------------------------------------------------------------------------------------------------
// parsePlaytestParam (pure, beside parseRoomParam)
// ---------------------------------------------------------------------------------------------------

describe('parsePlaytestParam', () => {
  test('absent → null (inert by default, with or without other parameters)', () => {
    for (const search of ['', '?', '?room=ABCD', '?difficulty=HARD', '?x=playtest', '?room=ABCD&x=1']) {
      assert.equal(parsePlaytestParam(search), null, JSON.stringify(search));
    }
    assert.equal(parsePlaytestParam(undefined), null);
    assert.equal(parsePlaytestParam(null), null);
  });

  test('?playtest=1 → a solo request with the lobby default difficulty', () => {
    assert.deepEqual(parsePlaytestParam('?playtest=1'), { mode: 'solo', difficulty: DEFAULT_DIFFICULTY });
    assert.equal(DEFAULT_DIFFICULTY, 'FUNNY', 'the lobby default (the loadPref fallback)');
  });

  test('any non-empty value other than 0 / false is on', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', '2', ' Fun ', 'Playtest']) {
      assert.deepEqual(parsePlaytestParam(`?playtest=${encodeURIComponent(v)}`), { mode: 'solo', difficulty: DEFAULT_DIFFICULTY }, v);
    }
  });

  test('?playtest=1&difficulty=<valid key> → that key (every shared key, case-insensitive)', () => {
    for (const d of DIFFICULTIES) {
      assert.deepEqual(parsePlaytestParam(`?playtest=1&difficulty=${d}`), { mode: 'solo', difficulty: d });
      assert.deepEqual(parsePlaytestParam(`?playtest=1&difficulty=${d.toLowerCase()}`), { mode: 'solo', difficulty: d });
    }
  });

  test('unknown / malformed difficulty → the default, never a crash, never an invalid key', () => {
    const bad = ['', 'EASY', 'nope', '0', '%E0%A4%A', 'FUNNY2', 'admin', DIFFICULTIES.join(','), '终极'];
    for (const d of bad) {
      const r = parsePlaytestParam(`?playtest=1&difficulty=${d}`);
      assert.deepEqual(r, { mode: 'solo', difficulty: DEFAULT_DIFFICULTY }, d);
      assert.ok(DIFFICULTIES.includes(r.difficulty), 'never an invalid key reaches room.create');
    }
    assert.deepEqual(parsePlaytestParam('?playtest=1&difficulty'), { mode: 'solo', difficulty: DEFAULT_DIFFICULTY });
  });

  test('off values → null (0 / false, in any case, trimmed)', () => {
    for (const v of ['0', 'false', 'FALSE', 'False', ' false ', '', '%20']) {
      assert.equal(parsePlaytestParam(`?playtest=${v}`), null, JSON.stringify(v));
    }
  });

  test('pure: equal results, a fresh object each call, no state leaks between calls', () => {
    const a = parsePlaytestParam('?playtest=1&difficulty=HARD');
    const b = parsePlaytestParam('?playtest=1&difficulty=HARD');
    assert.deepEqual(a, b);
    assert.notEqual(a, b, 'a fresh object each call');
    a.difficulty = 'MUTATED';
    assert.deepEqual(parsePlaytestParam('?playtest=1&difficulty=HARD'), { mode: 'solo', difficulty: 'HARD' });
  });

  test('deepLinkSeeds: what boot writes into the store, and it is inert without parameters', () => {
    assert.deepEqual(deepLinkSeeds(''), { pendingJoin: null, pendingPlaytest: null });
    assert.deepEqual(deepLinkSeeds('?room=abcd'), { pendingJoin: 'ABCD', pendingPlaytest: null });
    assert.deepEqual(deepLinkSeeds('?playtest=1'), { pendingJoin: null, pendingPlaytest: { mode: 'solo', difficulty: DEFAULT_DIFFICULTY } });
    assert.deepEqual(deepLinkSeeds('?playtest=1&difficulty=HARD'), {
      pendingJoin: null, pendingPlaytest: { mode: 'solo', difficulty: 'HARD' },
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// runSoloPlaytest — the request sequence (injected net / store)
// ---------------------------------------------------------------------------------------------------

describe('?playtest=1 quick start (runSoloPlaytest)', () => {
  /** A fake `net`: records what was sent and can refuse one named intent. */
  function fakeNet({ status = 'online', failOn = null, code = 'ERR' } = {}) {
    const sent = [];
    return {
      status, sent,
      async request(t, fields = {}) {
        sent.push([t, fields]);
        if (t === failOn) { const err = new Error(`${t} refused`); err.code = code; throw err; }
        return { t: 'ok' };
      },
    };
  }

  /** A fake store holding the slices runSoloPlaytest reads (`session.entered`, `room`, `match`). */
  function fakeStore({ entered = true, room = null, match = { public: null } } = {}) {
    const state = { ui: { pendingPlaytest: { mode: 'solo', difficulty: 'HARD' } }, session: { entered }, room, match };
    return { state, get: () => state, patch: (key, obj) => { state[key] = { ...state[key], ...obj }; } };
  }

  test('sends room.create { mode: solo, difficulty } and then room.start, in that order', async () => {
    const net = fakeNet();
    const started = await runSoloPlaytest(net, fakeStore(), { difficulty: 'HARD' });
    assert.equal(started, true);
    assert.deepEqual(net.sent, [['room.create', { mode: 'solo', difficulty: 'HARD' }], ['room.start', {}]]);
  });

  test('no difficulty given → the lobby default; an unknown one never reaches the server', async () => {
    const plain = fakeNet();
    assert.equal(await runSoloPlaytest(plain, fakeStore(), {}), true);
    assert.deepEqual(plain.sent[0], ['room.create', { mode: 'solo', difficulty: DEFAULT_DIFFICULTY }]);

    const bogus = fakeNet();
    assert.equal(await runSoloPlaytest(bogus, fakeStore(), { difficulty: 'EASY' }), true);
    assert.deepEqual(bogus.sent[0], ['room.create', { mode: 'solo', difficulty: DEFAULT_DIFFICULTY }]);
    assert.ok(DIFFICULTIES.includes(bogus.sent[0][1].difficulty));
  });

  test('a refused room.create sends nothing else and reports quietly (the player stays in the lobby)', async () => {
    const reported = [];
    const net = fakeNet({ failOn: 'room.create' });
    const started = await runSoloPlaytest(net, fakeStore(), { difficulty: 'HARD', notifyError: (err) => reported.push(err) });
    assert.equal(started, false);
    assert.deepEqual(net.sent.map(([t]) => t), ['room.create'], 'room.start is never attempted');
    assert.equal(reported.length, 1, 'exactly one report');
    assert.equal(reported[0].code, 'ERR', 'the transport error itself is handed to the toast layer');
  });

  test('a refused room.start is reported too, and nothing throws', async () => {
    const reported = [];
    const net = fakeNet({ failOn: 'room.start' });
    const started = await runSoloPlaytest(net, fakeStore(), { difficulty: 'HARD', notifyError: (err) => reported.push(err) });
    assert.equal(started, false);
    assert.deepEqual(net.sent.map(([t]) => t), ['room.create', 'room.start']);
    assert.equal(reported.length, 1);
  });

  test('without notifyError the fallback notice is a message, never a crash', async () => {
    const messages = [];
    const net = fakeNet({ failOn: 'room.create' });
    assert.equal(await runSoloPlaytest(net, fakeStore(), { notify: (t, k) => messages.push([t, k]) }), false);
    assert.deepEqual(messages.map(([, k]) => k), ['error']);
    assert.ok(typeof messages[0][0] === 'string' && messages[0][0].length > 0);
  });

  test('never creates anything when already in a room or a match', async () => {
    const stores = [fakeStore({ room: { code: 'ABCD', mode: 'coop' } }), fakeStore({ match: { public: { phase: 'PREP' } } })];
    for (const store of stores) {
      const net = fakeNet();
      const notices = [];
      const started = await runSoloPlaytest(net, store, { difficulty: 'HARD', notify: (t, k) => notices.push([t, k]) });
      assert.equal(started, false);
      assert.deepEqual(net.sent, [], 'nothing is sent');
      assert.equal(notices.length, 1);
      assert.match(notices[0][0], /同盟/, 'the same wording the ?room= path uses');
    }
  });

  test('never creates anything before the player entered or while offline', async () => {
    const cases = [[fakeStore({ entered: false }), fakeNet()], [fakeStore(), fakeNet({ status: 'reconnecting' })]];
    for (const [store, net] of cases) {
      assert.equal(await runSoloPlaytest(net, store, { difficulty: 'HARD' }), false);
      assert.deepEqual(net.sent, []);
    }
  });

  test('a second call while the first is in flight does not create a second room', async () => {
    const net = fakeNet();
    const store = fakeStore();
    const first = runSoloPlaytest(net, store, { difficulty: 'HARD' });
    const second = await runSoloPlaytest(net, store, { difficulty: 'HARD' });
    assert.equal(second, false, 'the concurrent call is refused');
    assert.equal(await first, true);
    assert.deepEqual(net.sent.map(([t]) => t), ['room.create', 'room.start'], 'one sequence only');
  });
});

// ---------------------------------------------------------------------------------------------------
// URL consumption (history.replaceState) — stripDeepLinkParams
// ---------------------------------------------------------------------------------------------------

describe('the deep link is consumed once (URL stripped)', () => {
  /** Records what stripDeepLinkParams handed to history.replaceState(state, unused, url). */
  const recorder = () => {
    const urls = [];
    return { urls, replaceState: (state, unused, url) => urls.push(url) };
  };

  test('?playtest=1&difficulty=HARD&x=1 → both playtest parameters gone, unrelated ones kept', () => {
    const state = { keep: true };
    const seen = [];
    const spy = { state, replaceState: (s, unused, url) => { seen.push([s, unused, url]); } };
    assert.equal(stripDeepLinkParams({ href: 'http://localhost/?playtest=1&difficulty=HARD&x=1' }, spy), true);
    assert.equal(seen.length, 1, 'exactly one history write');
    assert.equal(seen[0][0], state, 'the history state is preserved');
    assert.equal(seen[0][2], '/?x=1');
    const q = new URL(`http://localhost${seen[0][2]}`).searchParams;
    assert.equal(q.has('playtest'), false);
    assert.equal(q.has('difficulty'), false);
    assert.equal(q.get('x'), '1');
  });

  test('keeps the path and the hash, and strips a ?room= link through the same path', () => {
    const hist = recorder();
    assert.equal(stripDeepLinkParams({ href: 'http://localhost/play/index.html?room=ABCD#lobby' }, hist), true);
    assert.deepEqual(hist.urls, ['/play/index.html#lobby']);
  });

  test('every deep-link parameter is owned here (?room= and the playtest pair)', () => {
    assert.deepEqual([...DEEP_LINK_PARAMS].sort(), ['difficulty', 'playtest', 'room']);
    const hist = recorder();
    assert.equal(stripDeepLinkParams({ href: 'http://localhost/?room=ABCD&playtest=1&difficulty=HARD' }, hist), true);
    assert.deepEqual(hist.urls, ['/']);
    // the unchanged URL of a link that only carries ?room= keeps its other parameters
    const kept = recorder();
    assert.equal(stripDeepLinkParams({ href: 'http://localhost/?room=ABCD&x=1#lobby' }, kept), true);
    const q = new URL(`http://localhost${kept.urls[0]}`).searchParams;
    assert.deepEqual([...q.keys()], ['x']);
  });

  test('a clean URL is left untouched (no history write at all)', () => {
    const hist = recorder();
    assert.equal(stripDeepLinkParams({ href: 'http://localhost/?x=1' }, hist), false);
    assert.equal(stripDeepLinkParams({ href: 'http://localhost/' }, hist), false);
    assert.deepEqual(hist.urls, []);
  });

  test('accepts a location-like object with only .search (a reload cannot re-trigger the link)', () => {
    const hist = recorder();
    assert.equal(stripDeepLinkParams({ search: '?playtest=1&difficulty=HARD' }, hist), true);
    assert.deepEqual(hist.urls, ['/']);
  });

  test('a malformed location or a refusing history never throws', () => {
    assert.equal(stripDeepLinkParams({ search: null, href: '' }, { replaceState: () => { throw new Error('nope'); } }), false);
    assert.equal(stripDeepLinkParams({ href: 'not a url' }, recorder()), false);
    assert.equal(stripDeepLinkParams({}, recorder()), false);
  });
});

// ---------------------------------------------------------------------------------------------------
// the wiring main.js keeps (checked from the source: main.js cannot be imported by a test)
// ---------------------------------------------------------------------------------------------------

describe('main.js wiring', () => {
  test('imports the pure module instead of re-implementing it', () => {
    assert.match(mainSource, /import \{ deepLinkSeeds, stripDeepLinkParams, runSoloPlaytest \} from '\.\/playtestLink\.js';/);
    assert.doesNotMatch(mainSource, /export (async )?function (runSoloPlaytest|stripDeepLinkParams|deepLinkSeeds)/, 'no duplicate implementation in the boot layer');
  });

  test('seeds ui.pendingPlaytest at boot and consumes it exactly once', () => {
    assert.match(mainSource, /const \{ pendingJoin, pendingPlaytest \} = deepLinkSeeds\(location\.search\)/);
    assert.match(mainSource, /store\.patch\('ui', \{ pendingPlaytest: null \}\)/);
    assert.match(mainSource, /stripDeepLinkParams\(location, history\)/, 'consumption rewrites the URL');
  });

  test('schedules the playtest on welcome and on entering, and reports failures like the ?room= path', () => {
    assert.match(mainSource, /net\.on\('welcome', onWelcome\)/);
    assert.match(mainSource, /schedulePendingJoin\(\);\s*schedulePendingPlaytest\(\);/);
    assert.match(mainSource, /if \(s\.session\.entered && !prev\.session\.entered\) \{ schedulePendingJoin\(\); schedulePendingPlaytest\(\); \}/);
    assert.match(mainSource, /runSoloPlaytest\(net, store, \{/);
    assert.match(mainSource, /notifyError: toastError/);
    assert.match(mainSource, /\.finally\(clearPendingPlaytest\)/);
  });

  test('the store declares the field beside pendingJoin', () => {
    assert.match(read('public/js/store.js'), /ui: \{ pendingJoin: null, pendingPlaytest: null, restoring: false, buildStale: false \}/);
  });
});
