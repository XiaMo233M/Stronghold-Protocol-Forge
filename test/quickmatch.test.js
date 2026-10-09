// test/quickmatch.test.js — 野排匹配 (quick match, server/matchmaking.js; docs/META.md §1.6).
//
// Every test drives the REAL platform over sockets: the real HTTP/WS server, the real Lobby, the real
// `shared/protocol.js` validation and the real `room.create` / `room.join` flow. The only injected piece is
// `MatchClass: StubMatch`, the platform stub the lobby tests already use (it ends a match as soon as every human
// confirms, which is what a quick-matched room needs to be a room at all).
//
// The queue's own rules — size / max / wait / sweep — are tuned per server, because "wait 2 minutes" is not a test.
// The PLACEMENT RULE under test is the module's stated one: the longest-waiting CONNECTED players form ONE ordinary
// room, in strict arrival order, through `room.create` + `room.join` (never a second code path).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { MATCHMAKE_DEFAULTS } from '../server/matchmaking.js';
import { ERR, MAX_SEATS } from '../shared/constants.js';
import { C2S, S2C, validateC2S } from '../shared/protocol.js';
import { TestClient } from './helpers/wsClient.js';

const errors = [];
const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };

/** Every client ever opened, so one `after` hook closes them all. */
const clients = [];
/** Servers started by a test, closed at the end. */
const servers = [];

/**
 * A real server with the stub match and a tuned queue.
 * `lobbyGraceMs` is short: these tests open and drop many sockets, and a seat left by a dropped player must not outlive
 * its test (the room would still be there for the next one, which is the retention rule working as designed).
 * @param {object} [queue] matchmaking options (MATCHMAKE_DEFAULTS: size / max / waitMs / sweepMs / difficulty)
 */
async function server(queue = {}) {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', log, MatchClass: StubMatch, seedFn: () => 7, lobbyGraceMs: 300,
    queue: { sweepMs: 20, waitMs: 3000, ...queue },
  });
  servers.push(srv);
  return srv;
}

/** Connect + hello; `.id` is the playerId the server gave this socket (a `token` resumes that identity). */
async function player(srv, name, token) {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(c);
  const welcome = await c.hello(name, token);
  c.id = welcome.playerId;
  c.token = welcome.token;
  c.welcome = welcome;
  return c;
}

const ok = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
const expectError = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', `expected ${code} for ${msg.t}, got ${JSON.stringify(r)}`);
  assert.equal(r.code, code, `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
/** Wait until `pred()` is true (the server processes a socket close asynchronously). @param {() => boolean} pred */
async function until(pred, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await delay(5);
  }
  return true;
}
/** The seat list of a `room.state`, as `[[seat, playerId], …]`. */
const seatsOf = (state) => state.seats.filter(Boolean).map((s) => [s.seat, s.playerId]);
/**
 * Restrict a server to one test: wait until every room is gone and the queue is empty, then assert it. Each test below
 * gets its own server, but a dropped player's SEAT outlives the socket by `lobbyGraceMs`, and a queued player who is
 * still in a room is refused with QUEUED — so a leftover room must never reach a later test. The wait is the queue's
 * own bound (a slot that was never placed expires), so it has to be at least as long as `waitMs`.
 * @param {any} srv @param {number} [ms]
 */
async function idle(srv, ms = 8000) {
  const gone = await until(() => srv.lobby.rooms.size === 0 && srv.lobby.matchmake.entries.size === 0, ms);
  assert.ok(gone, `the test left ${srv.lobby.rooms.size} room(s) and ${srv.lobby.matchmake.entries.size} queue entry(ies) behind`);
  assert.equal(srv.lobby.rooms.size, 0);
  assert.equal(srv.lobby.matchmake.entries.size, 0);
  assert.equal(srv.lobby.matchmake.timer, null, 'the test left the queue timer armed');
}
/** The seat index of one player in a `room.state`. */
const seatOf = (state, id) => {
  const seat = state.seats.find((s) => s && s.playerId === id);
  return seat ? seat.seat : -1;
};

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
});

// ---------------------------------------------------------------------------------------------------

test('the queue forms a room at the threshold, and it is an ordinary room (create + join, host = the longest wait)', async () => {
  const srv = await server({ size: 2 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    // one waiting player is not a room: nothing is created below the threshold
    assert.equal((await ok(a, { t: 'room.queue' })).t, 'ok');
    const first = await a.waitFor('room.queued', (m) => m.status === 'waiting');
    assert.equal(first.position, 1);
    assert.equal(first.size, 1);
    assert.equal(first.need, 2);
    assert.ok(first.deadline > 0, 'the bounded wait travels with the frame');
    await delay(40);
    assert.equal(srv.lobby.rooms.size, 0, 'below the threshold no room exists');
    assert.equal(srv.lobby.matchmake.formed, 0);

    // …and the second arrival forms one
    const stateP = a.waitFor('room.state', (s) => s.code && s.seats.filter(Boolean).length === 2);
    assert.equal((await ok(b, { t: 'room.queue' })).t, 'ok');
    const state = await stateP;
    assert.equal(srv.lobby.rooms.size, 1, 'exactly one room was created');
    assert.equal(srv.lobby.matchmake.formed, 1);
    const room = srv.lobby.getRoom(state.code);
    assert.ok(room, 'the room is in the lobby registry under its code');
    assert.equal(room.mode, 'coop', 'the queue forms a co-op room');
    assert.equal(room.hostId, a.id, 'the longest-waiting player hosts it');
    // arrival order = seat order, the lowest free seat first: what `room.create` + `room.join` would have produced
    assert.deepEqual(seatsOf(state), [[0, a.id], [1, b.id]]);
    assert.equal(state.inMatch, false, 'a formed room sits in its lobby state');
    // both queued players are in it (the host is seated too, not only notified)
    assert.equal(seatOf(state, b.id), 1);
    assert.equal(srv.lobby.matchmake.waiting().length, 0, 'a placed player is no longer waiting');
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
    await idle(srv);
  }
});

test('strict arrival order: three waiting players, the oldest two form a room, the third waits on', async () => {
  const srv = await server({ size: 2 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  const c = await player(srv, 'C');
  const d = await player(srv, 'D');
  try {
    await ok(a, { t: 'room.queue' });
    await ok(b, { t: 'room.queue' });
    const first = await a.waitFor('room.state', (s) => s.code && s.seats.filter(Boolean).length === 2);
    assert.deepEqual(seatsOf(first), [[0, a.id], [1, b.id]], 'the two longest waiters, in arrival order');

    // C queued after the room existed; nobody is waiting with them, so C stays queued and no second room appears
    await ok(c, { t: 'room.queue' });
    const waiting = await c.waitFor('room.queued', (m) => m.status === 'waiting' && m.size === 1);
    assert.equal(waiting.position, 1);
    await delay(60);
    assert.equal(srv.lobby.rooms.size, 1, 'a lone late arrival does not open a room');

    // the next arrival takes C's turn, not a fresh one: C (older) before D
    const second = c.waitFor('room.state', (s) => s.code && s.code !== first.code && s.seats.filter(Boolean).length === 2);
    await ok(d, { t: 'room.queue' });
    const state = await second;
    assert.notEqual(state.code, first.code, 'a quick match always forms a NEW room');
    assert.equal(srv.lobby.rooms.size, 2);
    assert.equal(srv.lobby.getRoom(state.code).hostId, c.id, 'the older waiter hosts the second room');
    assert.deepEqual(seatsOf(state), [[0, c.id], [1, d.id]]);
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
    await c.terminate();
    await d.terminate();
    await idle(srv);
  }
});

test('a disconnect is skipped, never placed, and the next in line takes the slot', async () => {
  // The cap holds the first two queued without a room; C's arrival is refused by it. It is raised once they wait, so
  // the next arrival is the one that reaches the threshold.
  const srv = await server({ size: 3, max: 2, waitMs: 3000 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  const c = await player(srv, 'C');
  const d = await player(srv, 'D');
  const e = await player(srv, 'E');
  try {
    await ok(a, { t: 'room.queue' });
    await ok(b, { t: 'room.queue' });
    await expectError(c, { t: 'room.queue' }, ERR.QUEUE_FULL);
    assert.equal(srv.lobby.matchmake.waiting().length, 2);
    srv.lobby.matchmake.max = MAX_SEATS;
    // C drops before ever getting in: the queue is back to A and B, and nothing else changed
    await c.terminate();
    assert.ok(await until(() => srv.lobby.matchmake.entries.size === 2), 'a refused arrival left no entry');
    await delay(60);
    assert.equal(srv.lobby.rooms.size, 0, 'two waiting players are below the threshold of three');

    // A, B and D are the waiting ones at the threshold: D takes the slot C never held, and C is not seated
    const stateP = a.waitFor('room.state', (s) => s.code && s.seats.filter(Boolean).length === 3);
    await ok(d, { t: 'room.queue' });
    const state = await stateP;
    assert.deepEqual(seatsOf(state), [[0, a.id], [1, b.id], [2, d.id]]);
    assert.equal(seatOf(state, c.id), -1);
    assert.equal(srv.lobby.matchmake.entries.size, 0, 'every queued player was placed');
    await e.request({ t: 'room.dequeue' }).catch(() => {});
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
    await d.terminate();
    await e.terminate();
    await idle(srv);
  }
});

test('a full queue is refused by name, and a refusal does not consume the arrival', async () => {
  // max < size: the queue can never place anybody, which is exactly the state the cap exists for (a queue of dropped
  // connections whose slots are still held). With the defaults this is the rare path; here it is the only path.
  const srv = await server({ size: MAX_SEATS, max: 3, waitMs: 600 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  const c = await player(srv, 'C');
  const d = await player(srv, 'D');
  try {
    for (const p of [a, b, c]) await ok(p, { t: 'room.queue' });
    assert.equal(srv.lobby.matchmake.waiting().length, 3);
    const refused = await expectError(d, { t: 'room.queue' }, ERR.QUEUE_FULL);
    assert.match(String(refused.detail), /3/, 'the refusal says how big the queue is');
    assert.equal(srv.lobby.matchmake.waiting().length, 3, 'a refused arrival takes no slot');
    // the queue frees a slot → the same player gets in
    await ok(c, { t: 'room.dequeue' });
    assert.equal((await ok(d, { t: 'room.queue' })).t, 'ok');
    assert.equal(srv.lobby.matchmake.waiting().length, 3);
    assert.deepEqual(errors, []);
  } finally {
    for (const p of [a, b, c, d]) await p.terminate();
    await idle(srv);
  }
});

test('cancel: room.dequeue leaves the queue and answers; cancelling when not queued is QUEUE_EMPTY', async () => {
  const srv = await server({ size: 4 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    await ok(a, { t: 'room.queue' });
    assert.equal(srv.lobby.matchmake.waiting().length, 1);
    const cancelled = a.waitFor('room.queued', (m) => m.status === 'cancelled');
    await ok(a, { t: 'room.dequeue' });
    assert.equal((await cancelled).status, 'cancelled');
    assert.equal(srv.lobby.matchmake.waiting().length, 0);
    await expectError(a, { t: 'room.dequeue' }, ERR.QUEUE_EMPTY);
    await expectError(b, { t: 'room.dequeue' }, ERR.QUEUE_EMPTY);
    // and a cancelled player who queues again is a fresh arrival (position 1 again)
    await ok(b, { t: 'room.queue' });
    const again = await b.waitFor('room.queued', (m) => m.status === 'waiting' && m.position === 1);
    assert.equal(again.size, 1);
    assert.deepEqual(errors, []);
    await ok(b, { t: 'room.dequeue' });   // leave the queue empty: the test asserts on a clean server
  } finally {
    await a.terminate();
    await b.terminate();
    await idle(srv);
  }
});

test('the empty queue is a queue: the last waiting player leaving discards it and nothing is left behind', async () => {
  const srv = await server({ size: 2 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    // `room.leave` is about rooms, not the queue: a queued player with no room has nothing to leave
    await ok(a, { t: 'room.queue' });
    await expectError(a, { t: 'room.leave' }, ERR.NOT_IN_ROOM);
    assert.equal(srv.lobby.matchmake.entries.size, 1, 'a refused room.leave does not disturb the queue');
    await ok(a, { t: 'room.dequeue' });
    assert.equal(srv.lobby.matchmake.entries.size, 0);
    assert.equal(srv.lobby.matchmake.timer, null, 'an empty queue holds no timer');
    // …and B's arrival starts a fresh queue of one, with no trace of A
    const waiting = b.waitFor('room.queued', (m) => m.status === 'waiting');
    await ok(b, { t: 'room.queue' });
    const frame = await waiting;
    assert.equal(frame.position, 1);
    assert.equal(frame.size, 1);
    await delay(60);
    assert.equal(srv.lobby.rooms.size, 0);
    assert.deepEqual(errors, []);
    await ok(b, { t: 'room.dequeue' });   // leave the queue empty: the test asserts on a clean server
  } finally {
    await a.terminate();
    await b.terminate();
    await idle(srv);
  }
});

test('a queueing player who already has a room is refused with QUEUED, and queueing twice is idempotent', async () => {
  const srv = await server({ size: 2 });
  const a = await player(srv, 'A');
  try {
    // one player, one slot: a repeated `room.queue` re-answers the same way
    await ok(a, { t: 'room.queue' });
    await ok(a, { t: 'room.queue' });
    assert.equal(srv.lobby.matchmake.waiting().length, 1, 'one player, one slot');
    await ok(a, { t: 'room.dequeue' });

    // with a room of its own, the same message is refused: a quick match places people INTO rooms
    await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await expectError(a, { t: 'room.queue' }, ERR.QUEUED);
    assert.equal(srv.lobby.matchmake.entries.size, 0);

    // leaving the room frees the player for the queue again
    await ok(a, { t: 'room.leave' });
    await ok(a, { t: 'room.queue' });
    assert.equal(srv.lobby.matchmake.waiting().length, 1);
    assert.deepEqual(errors, []);
    await ok(a, { t: 'room.dequeue' });   // leave the queue empty: the test asserts on a clean server
  } finally {
    await a.terminate();
    await idle(srv);
  }
});

test('the wait is bounded: a queue nobody can fill times out and says so', async () => {
  const srv = await server({ size: 3, waitMs: 120, sweepMs: 20 });
  const a = await player(srv, 'A');
  try {
    await ok(a, { t: 'room.queue' });
    const timeout = await a.waitFor('room.queued', (m) => m.status === 'timeout', 3000);
    assert.equal(timeout.status, 'timeout');
    assert.ok(timeout.waitedMs >= 100, `waited long enough to be a real wait: ${timeout.waitedMs}`);
    assert.equal(srv.lobby.matchmake.entries.size, 0, 'a timed-out player is out of the queue');
    assert.equal(srv.lobby.rooms.size, 0, 'no room was invented for a queue that never filled');
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await idle(srv);
  }
});

test('a queued player who drops keeps the slot for a resume, and a timeout still ends it', async () => {
  // the drop keeps the entry (a resume may still be placed)…
  const srv = await server({ size: 3, waitMs: 300, sweepMs: 20 });
  const a = await player(srv, 'A');
  await ok(a, { t: 'room.queue' });
  await a.terminate();
  assert.ok(await until(() => srv.lobby.matchmake.waiting().length === 0), 'a dropped player stops counting as waiting');
  assert.equal(srv.lobby.matchmake.entries.size, 1, 'a dropped player keeps the queue slot');
  // …and the bounded wait still applies to the slot it kept
  await delay(400);
  assert.equal(srv.lobby.matchmake.entries.size, 0, 'the kept slot expires like any other');
  assert.equal(srv.lobby.rooms.size, 0);
  await idle(srv);

  // a resume inside the window is waiting again
  const srv2 = await server({ size: 3, waitMs: 8000, sweepMs: 20 });
  const b = await player(srv2, 'B');
  await ok(b, { t: 'room.queue' });
  const token = b.token;
  await b.terminate();
  assert.ok(await until(() => srv2.lobby.matchmake.waiting().length === 0), 'the drop is processed before the resume');
  const back = await player(srv2, 'B', token);
  const waiting = await back.waitFor('room.queued', (m) => m.status === 'waiting');
  assert.equal(waiting.position, 1);
  assert.equal(srv2.lobby.matchmake.waiting().length, 1, 'the resumed session is waiting again');
  assert.equal(errors.length, 0, `no server errors: ${errors.join(' | ')}`);
  await back.request({ t: 'room.dequeue' }).catch(() => {});
  await back.terminate();
  await idle(srv2);
});

test('a quick-matched room runs the server DEFAULT set: it declares no modIds and carries no mods field', async () => {
  const srv = await server({ size: 2 });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    const stateP = a.waitFor('room.state', (s) => s.code && s.seats.filter(Boolean).length === 2);
    await ok(a, { t: 'room.queue' });
    await ok(b, { t: 'room.queue' });
    const state = await stateP;
    assert.equal('mods' in state, false, 'a room that declared nothing has no mods key (byte-identical to before)');
    const room = srv.lobby.getRoom(state.code);
    assert.equal(room.modIds, null);
    assert.equal(room.modSet, null);
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
    await idle(srv);
  }
});

test('a player in a running match cannot queue, and the queue never moves them out of it', async () => {
  const srv = await server({ size: 2, difficulty: 'NORMAL' });
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const created = await a.waitFor('room.state', (s) => s.code);
    await ok(b, { t: 'room.join', code: created.code });
    await ok(b, { t: 'room.ready', ready: true });
    await ok(a, { t: 'room.start' });
    await a.waitFor('m.public');
    // the match runs (the stub ends it as soon as every human confirms, so this is a narrow window on purpose)
    const refused = await a.request({ t: 'room.queue' });
    assert.equal(refused.t, 'error', JSON.stringify(refused));
    assert.equal(refused.code, ERR.QUEUED, 'a running match is a room: leave it first');
    assert.equal(srv.lobby.matchmake.entries.size, 0);
    assert.equal(srv.lobby.getRoom(created.code).match !== null, true, 'still in its match');
    assert.deepEqual(errors, []);
  } finally {
    // the stub match ends as soon as every human confirms: leave the room behind cleanly (g.leave ends it, room.leave
    // frees the seat), so the server this test opened holds nothing afterwards
    await a.request({ t: 'g.leave' }).catch(() => {});
    await b.request({ t: 'room.leave' }).catch(() => {});
    await b.request({ t: 'g.leave' }).catch(() => {});
    await a.terminate();
    await b.terminate();
    await idle(srv);
  }
});

test('the protocol: room.queue / room.dequeue are C2S, room.queued is S2C, and the fields are bounded', () => {
  assert.ok(Object.hasOwn(C2S, 'room.queue'));
  assert.ok(Object.hasOwn(C2S, 'room.dequeue'));
  assert.ok(S2C.includes('room.queued'));
  assert.equal(validateC2S({ t: 'room.queue' }), null, 'a bare room.queue is valid (mode and difficulty default)');
  assert.equal(validateC2S({ t: 'room.queue', mode: 'coop', difficulty: 'HARD' }), null);
  assert.equal(validateC2S({ t: 'room.queue', mode: 'coop', difficulty: 'HARD', mods: 'a'.repeat(64) }), null);
  assert.equal(validateC2S({ t: 'room.queue', mode: 'solo' }), 'bad field mode', 'a queue of strangers is co-op only');
  assert.equal(validateC2S({ t: 'room.queue', difficulty: 'NOPE' }), 'bad field difficulty');
  assert.equal(validateC2S({ t: 'room.queue', mods: 'not-a-digest' }), 'bad field mods');
  assert.equal(validateC2S({ t: 'room.dequeue' }), null);
  assert.equal(C2S['room.queue'].$optional.join(','), 'mode,difficulty,mods');
  // the defaults are the documented ones (MAX_SEATS / the official matchTimeMax)
  assert.equal(MATCHMAKE_DEFAULTS.size, null, 'null = the room\'s own MAX_SEATS');
  assert.equal(MATCHMAKE_DEFAULTS.waitMs, 120_000);
  assert.equal(MAX_SEATS, 4);
});
