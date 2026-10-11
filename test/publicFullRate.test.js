// test/publicFullRate.test.js — the self-healing ask `g.publicFull` draws from the HEAVY bucket (server/net.js
// `HEAVY_TYPES`, DESIGN §8.2 "incremental frame").
//
// Why it belongs there: the ask is nearly free to send and expensive to answer. The server replies with a UNICAST FULL
// `m.public` (17 282 B for the 40-seat room, the size its own suite measures — test/match/public-delta-match.test.js)
// and ALSO turns the room's next broadcast frame full for every member (`platform.js resendPublic` →
// `markMembershipChanged`), so N asks buy N full frames. On the 40 msg/s bucket the burst alone was 6 × 17 kB before
// any refill; the heavy bucket caps the sustained rate at 2/s.
//
// Why no normal client loses anything: the browser throttles the ask itself — `PUBLIC_FULL_ASK_MS = 2000`
// (public/js/main.js:138, used at :367) — so a legitimate client sends at most 0.5/s, four times below the bucket's
// 2/s refill. These tests pin BOTH halves: the flood is capped, and the client's own cadence is never touched.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
import { HEAVY_TYPES, NET_DEFAULTS } from '../server/net.js';

/** The bucket the server SHIPS with (asserted below, not assumed): heavyPerSec / heavyBurst. */
const HEAVY_BURST = NET_DEFAULTS.heavyBurst;
const HEAVY_PER_SEC = NET_DEFAULTS.heavyPerSec;

// The client's own throttle is READ OUT of the file the browser loads, never imported: `import`ing public/js/main.js
// boots the whole page (see test/playtestLink.test.js's header), and a literal here would quietly stop describing the
// shipped client the day somebody retunes it.
const mainSource = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
const askMs = mainSource.match(/const PUBLIC_FULL_ASK_MS = (\d+)/);
assert.ok(askMs, 'public/js/main.js no longer declares PUBLIC_FULL_ASK_MS');
/** How often the browser may ask for the full frame — 2000 ms (public/js/main.js:138). */
const PUBLIC_FULL_ASK_MS = Number(askMs[1]);

class RecordingStub extends StubMatch {
  static instances = [];
  constructor(opts) { super(opts); this.opts = opts; RecordingStub.instances.push(this); }
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async player(name) {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      const w = await c.hello(name);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('g.publicFull draws from the heavy bucket (server/net.js HEAVY_TYPES)', () => {
  let srv;
  let pool;
  const errors = [];
  const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: RecordingStub });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { RecordingStub.instances = []; await pool.closeAll(); });
  after(async () => { await srv?.close(); });

  /** A connected player in a started solo room — the state the self-healing ask is sent from. */
  async function inMatch(name) {
    const c = await pool.player(name);
    const r = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(r.t, 'ok', JSON.stringify(r));
    const started = await c.request({ t: 'room.start' });
    assert.equal(started.t, 'ok', JSON.stringify(started));
    await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 3000);
    return c;
  }

  test('the membership is explicit: g.publicFull is in HEAVY_TYPES', () => {
    assert.ok(HEAVY_TYPES.has('g.publicFull'), [...HEAVY_TYPES].join(','));
  });

  test('the safety margin itself is asserted: the shipped bucket refills faster than the client may ask', () => {
    // the whole justification of the change in one inequality — the client asks every PUBLIC_FULL_ASK_MS, the bucket
    // hands back HEAVY_PER_SEC per second. Retune either side (or drop the client's gate) and this goes red, instead of
    // the report's arithmetic quietly becoming false.
    const asksPerSec = 1000 / PUBLIC_FULL_ASK_MS;
    assert.ok(asksPerSec < HEAVY_PER_SEC, `the client asks ${asksPerSec}/s, the bucket refills ${HEAVY_PER_SEC}/s`);
    assert.ok(HEAVY_BURST >= 1);
    // and the bucket is not so small that a normal ask could be the one that misses
    assert.ok(HEAVY_PER_SEC >= 1);
  });

  test('a burst of asks beyond the heavy bucket is rate-limited, and the normal bucket is untouched', async () => {
    const c = await inMatch('Bill');
    const REQS = 20;
    const got = await Promise.all(Array.from({ length: REQS }, () => c.request({ t: 'g.publicFull' }, 5000)));
    const oks = got.filter((r) => r.t === 'ok').length;
    const rated = got.filter((r) => r.t === 'error' && r.code === ERR.RATE);

    assert.equal(oks + rated.length, REQS, got.map((r) => r.t + (r.code ? `:${r.code}` : '')).join(','));
    assert.ok(rated.length > 0, `no ask was rate-limited: ${oks}/${REQS} accepted — g.publicFull is not on the heavy bucket`);
    // burst 6 plus the 2/s refill over the few ms this loop takes; with g.publicFull OFF the bucket it is all 20
    assert.ok(oks >= HEAVY_BURST && oks <= HEAVY_BURST + 3, `accepted ${oks} of ${REQS}, expected about the burst of ${HEAVY_BURST}`);
    assert.ok(rated.every((r) => /g\.publicFull too often/.test(r.detail || '')), JSON.stringify(rated[0]));
    assert.equal(errors.length, 0, errors.join('\n'));

    // the asks that were refused burned no normal-bucket token beyond the ones every message costs, and there are 40:
    // an ordinary intent still goes straight through (a client that hit the heavy cap is not locked out of the game)
    await c.request({ t: 'g.emote', id: 'autochess_battle_happy' }).then((r) => assert.equal(r.t, 'ok', JSON.stringify(r)));
    assert.equal(c.isOpen, true);
  });

  test('the client\'s own cadence (PUBLIC_FULL_ASK_MS apart) is never limited', async () => {
    // ...and that throttle is really wired around the ask, not merely declared: with the constant and its use told
    // apart, a client that lost its gate would flood the bucket while this file still "knew" the interval
    assert.match(mainSource, /Date\.now\(\) - publicFullAskedAt >= PUBLIC_FULL_ASK_MS/, 'the ask is no longer gated by PUBLIC_FULL_ASK_MS');
    assert.match(mainSource, /publicFullAskedAt = Date\.now\(\)/, 'the ask no longer records when it was sent');
    const c = await inMatch('Cadence');
    const ASKS = 4;                       // 3 gaps of PUBLIC_FULL_ASK_MS: the bucket refills 4 tokens per gap
    for (let i = 0; i < ASKS; i++) {
      const r = await c.request({ t: 'g.publicFull' }, 5000);
      assert.equal(r.t, 'ok', `ask ${i + 1}/${ASKS} was refused: ${JSON.stringify(r)}`);
      if (i < ASKS - 1) await delay(PUBLIC_FULL_ASK_MS);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(c.isOpen, true);
  });

  test('the asks share the bucket with the other heavy intents instead of creating a second one', async () => {
    const c = await inMatch('Shared');
    const asks = await Promise.all(Array.from({ length: HEAVY_BURST + 4 }, () => c.request({ t: 'g.publicFull' }, 5000)));
    assert.ok(asks.some((r) => r.t === 'ok'), 'the burst was refused entirely');
    assert.ok(asks.some((r) => r.t === 'error' && r.code === ERR.RATE), 'the burst emptied no bucket');
    // g.watch is answered from the SAME bucket: right after the asks it must be refused too, which is what "the same
    // bucket" means — the fix must not hand g.publicFull a private allowance beside the existing heavy intents
    const watch = await c.request({ t: 'g.watch', fieldId: 'f0' }, 5000);
    assert.equal(watch.t, 'error', JSON.stringify(watch));
    assert.equal(watch.code, ERR.RATE, JSON.stringify(watch));
    assert.ok(HEAVY_PER_SEC > 0 && HEAVY_BURST > 0);
  });
});
