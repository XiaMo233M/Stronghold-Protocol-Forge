// test/roomSeatCap.test.js — 可变座位 + 房主用滑杆决定本房人数上限 (业主裁决 B5, docs/META.md §1.9).
//
// The feature has four moving parts and each one is asserted here on the layer that owns it:
//   1. `shared/protocol.js` — `room.create.seatCap` is judged on the wire: `[MIN_SEATS, SEAT_CAP]` or an explicit
//      `BAD_MSG` (never a silent clamp), absent / `null` = the server default.
//   2. `server/lobby.js` — the HOST's pick becomes the room's seat count, and the clamp that protects every caller
//      which never sees the protocol (matchmaking, package hooks, tests).
//   3. `public/js/screens/lobby.js` — the slider's range and the payload it builds.
//   4. The INVARIANT of the whole slice: a 4-seat room is byte-for-byte the room it was before this feature existed.
//      That is the one claim the previous cut pinned (`test/ps100-migration.test.js` §1 (D), whose
//      `Object.hasOwn(frame, 'seatCap') === false` assertion is NOT relaxed here) and the one this cut could break by
//      accident, so it is asserted three ways: the exact frame STRING, the key LIST, and a wire-level comparison of a
//      create that names the ceiling with one that says nothing.
//
// `SP_MAX_SEATS` is exercised in a CHILD process (§6): `LOBBY_DEFAULTS.maxSeats` and the protocol's `SEAT_CAP` are both
// read when their modules are EVALUATED, so a deployment's ceiling cannot be changed inside a running test process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ERR, ERR_TEXT, DEFAULT_MAX_SEATS, MAX_SEATS, MIN_SEATS, clampSeats, maxSeatsFrom } from '../shared/constants.js';
import { validateC2S, C2S } from '../shared/protocol.js';
import { LOBBY_DEFAULTS, Lobby, Room } from '../server/lobby.js';
import { MATCHMAKE_DEFAULTS } from '../server/matchmaking.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

/** 这台服务器允许的上限 —— 缺省 20（业主裁令 2026-10-12），不是官方 `MAX_SEATS` 那个 4。 */
const CEILING = DEFAULT_MAX_SEATS;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/** The msgid `ERR_TEXT` holds for the refused-shrink code (it is a `N_()` msgid, so it must exist in every pack). */
const ERR_TEXT_SEAT_CAP_TOO_SMALL = '新的人数上限不能小于同盟内现有人数（含 AI 队友）';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const errors = [];
const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };

/** Every client / server a test opened, closed by one `after` hook. */
const clients = [];
const servers = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
});

/**
 * A real server. `queue` is tuned short (a "wait 2 minutes" test is not a test); `MatchClass: StubMatch` is the
 * platform stub the lobby tests use, so a quick-matched room is a room without a real match.
 * @param {object} [queue] matchmaking options (MATCHMAKE_DEFAULTS)
 */
async function server(queue = {}) {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', log, MatchClass: StubMatch, seedFn: () => 7, lobbyGraceMs: 300,
    queue: { sweepMs: 20, waitMs: 3000, ...queue },
  });
  servers.push(srv);
  return srv;
}

/** Connect + hello. `.id` is the playerId this socket got. */
async function player(srv, name, token) {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(c);
  const welcome = await c.hello(name, token);
  c.id = welcome.playerId;
  c.welcome = welcome;
  return c;
}

/** The next `room.state` this client sees whose host is itself. */
const stateOf = (c, mode = 'coop') => c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);

/** A frame with the room code blanked, so two rooms of one server can be compared byte for byte. */
const withoutCode = (state) => JSON.stringify({ ...state, code: 'X' });

/** A `Lobby` with no sockets: `registry.byId` answers nobody, so `broadcastState` encodes and sends nothing. */
const bareLobby = (options = {}) => new Lobby({
  registry: { byId: () => null }, log: noopLog, MatchClass: StubMatch, getData: () => ({}), now: () => 1_000, options,
});
const fakeSession = (playerId) => ({
  playerId, name: playerId, connected: true, roomCode: null, limitKey: null, ws: null,
});

// ---------------------------------------------------------------------------------------------------------------
// §1 the protocol gate: an explicit refusal, never a silent clamp

test('roomSeatCap §1: room.create.seatCap is optional and typed — in range passes, junk and out-of-range do not', () => {
  const ok = (seatCap) => validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap });
  // absent and `null` are the same thing: the server default (what every existing client sends)
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }), null);
  assert.equal(ok(null), null, 'null = not sent');
  // the whole legal range, at both ends (the ceiling is `maxSeatsFrom(process.env)`: 20 by default)
  for (let n = MIN_SEATS; n <= CEILING; n++) assert.equal(ok(n), null, `seatCap ${n}`);
  // the ceiling the room.seat/kick gate already uses, and one past it
  assert.equal(ok(CEILING + 1), 'bad field seatCap', 'above the server ceiling ⇒ an error, not a clamp');
  assert.equal(ok(1e9), 'bad field seatCap');
  assert.equal(ok(MIN_SEATS - 1), 'bad field seatCap', 'below the floor');
  assert.equal(ok(0), 'bad field seatCap');
  assert.equal(ok(-3), 'bad field seatCap');
  // junk types (a fraction is NOT rounded: the wire wants a seat count, not an opinion)
  for (const bad of [2.5, '3', 'x', true, false, {}, [], [3], NaN, Infinity, -Infinity]) {
    assert.equal(ok(bad), 'bad field seatCap', `junk seatCap ${JSON.stringify(bad) ?? String(bad)}`);
  }
  // The field must STAY optional, by BOTH routes the protocol keeps for it: `$optional` covers "the key never
  // appeared" and the validator's own `v === null` covers "the client sent an explicit null" (`validateC2S` only
  // consults `$optional` for `undefined`). A `seatCap` that became required would refuse every existing client, and
  // the `$optional` entry is also the surface `server/modDispatch.js` copies to packs — a missing entry there makes a
  // legal `room.create` look like a missing field to a pack.
  const spec = C2S['room.create'];
  assert.equal(typeof spec.seatCap, 'function', 'the field is declared in the catalogue');
  assert.ok((spec.$optional || []).includes('seatCap'),
    'absent must be registered in $optional, exactly like every other nullable field (hello.token …)');
  assert.equal(spec.seatCap(null), true, 'an explicit null is the same thing as not sending it');
  assert.equal(spec.seatCap(undefined), true, 'and so is an explicit undefined');
});

test('roomSeatCap §1: the floor is MIN_SEATS and it is on the REQUEST, not on the Room', () => {
  // The rationale (shared/constants.js): the official range is 1–4 players and the ONE-seat shape already has a mode
  // of its own (`mode: 'solo'`), so a co-op room may not be created with fewer than MIN_SEATS seats.
  assert.equal(MIN_SEATS, 2, 'the floor this slice picked');
  assert.equal(MAX_SEATS, 4, 'the official room — the variant gate reads participants, not this');
  assert.equal(DEFAULT_MAX_SEATS, 20, 'and the DEFAULT ceiling is 20 (业主裁令 2026-10-12)');
  assert.equal(maxSeatsFrom(), DEFAULT_MAX_SEATS, 'what a deployment that says nothing gets');
  // A Room still accepts any cap ≥ 1 — the floor is a rule about what a client may ASK for, not a new class invariant.
  assert.equal(new Room('AAAA', 'coop', 'NORMAL', 0, 1).seats.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// §2 the invariant: capacity 4 is byte-for-byte today's room

test('roomSeatCap §2: a 4-seat frame is the EXACT string it was before this feature', () => {
  // The literal is the pre-B5 frame (pinned by hand, not derived from the code under test). The room is built with an
  // explicit 4 — since 业主裁令 2026-10-12 the Lobby's ceiling is 20, so "4" is now a PICK, and this test is about the
  // official-room shape rather than about the default.
  const EXPECTED = '{"t":"room.state","code":"ABCD","hostId":null,"mode":"coop","difficulty":"NORMAL",'
    + '"aiPicksLast":false,"chatMode":"open","inMatch":false,"seats":[null,null,null,null],"spectators":[]}';
  assert.equal(JSON.stringify(new Room('ABCD', 'coop', 'NORMAL', 0, MAX_SEATS).toState()), EXPECTED);
  // …and naming the ceiling explicitly (which is what the slider sends when the host leaves it alone) is NOT a
  // different room: same string, same keys, no key at all.
  const named = new Room('ABCD', 'coop', 'NORMAL', 0, MAX_SEATS).toState();
  assert.equal(JSON.stringify(named), EXPECTED, 'seatCap = MAX_SEATS is the official room');
  assert.equal(Object.hasOwn(named, 'seatCap'), false, 'a 4-seat room adds no key (byte-for-byte the old frame)');
  assert.deepEqual(Object.keys(named), ['t', 'code', 'hostId', 'mode', 'difficulty', 'aiPicksLast', 'chatMode',
    'inMatch', 'seats', 'spectators'], 'the key LIST is unchanged too, so key order cannot drift');
  // A solo room keeps those four slots as well: the client renders one card from `mode`, and this slice must not move it.
  assert.equal(JSON.stringify(new Room('ABCD', 'solo', 'FUNNY', 0, MAX_SEATS).toState()), EXPECTED.replace('"coop"', '"solo"').replace('"NORMAL"', '"FUNNY"'));
  // …while the DEFAULT room (20 seats) says so, and only a capacity ≠ 4 adds the key at all.
  assert.equal(new Room('ABCD', 'coop', 'NORMAL', 0, DEFAULT_MAX_SEATS).toState().seatCap, DEFAULT_MAX_SEATS);
  assert.equal(new Room('ABCD', 'coop', 'NORMAL', 0, 5).toState().seatCap, 5);
  assert.equal(new Room('ABCD', 'coop', 'NORMAL', 0, 3).toState().seatCap, 3);
  // The CLASS default stays the official `MAX_SEATS`: the class is also built directly by tests / packages, and the
  // Lobby is the one that always passes its own ceiling.
  assert.equal(new Room('ABCD', 'coop', 'NORMAL', 0).seatCap, MAX_SEATS);
});

test('roomSeatCap §2: over the WIRE, naming the ceiling equals saying nothing', async () => {
  const srv = await server();
  const a = await player(srv, 'Quiet');
  // The server's ceiling is 20, so a create that names NOTHING builds a 20-seat room — and that room is byte-for-byte
  // the one that NAMES the ceiling (which is what the slider sends when the host leaves it alone).
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const plain = await stateOf(a);
  assert.equal(plain.seatCap, CEILING, 'the default room says which cap it has');
  assert.equal(plain.seats.length, CEILING);
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap: CEILING })).t, 'ok');
  const named = await stateOf(a);
  assert.equal(withoutCode(named), withoutCode(plain), 'byte for byte, the room code aside');
  // …and a room that returns to the OFFICIAL 4 is byte-for-byte the pre-B5 frame: no `seatCap` key, 4 slots.
  // (The predicate names the 4-seat frame: the host's inbox still holds the 20-seat ones from the creates above.)
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap: MAX_SEATS })).t, 'ok');
  const four = await a.waitFor('room.state', (s) => s.hostId === a.id && s.seats.length === MAX_SEATS);
  assert.equal(Object.hasOwn(four, 'seatCap'), false, 'no field, no key at the official 4');
  assert.equal(four.seats.length, MAX_SEATS);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------------------------
// §3 the host's pick reaches the room, and the server clamps what it is handed

test('roomSeatCap §3: the host picks the room cap — over the wire, and only for co-op', async () => {
  const srv = await server();
  const a = await player(srv, 'Host');
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap: 3 })).t, 'ok');
  const state = await stateOf(a);
  assert.equal(state.seatCap, 3, 'the frame tells the client what to pad to');
  assert.equal(state.seats.length, 3, 'and the room really has three slots');
  assert.equal(state.seats[0].playerId, a.id, 'the host keeps seat 0');
  const room = srv.lobby.getRoom(state.code);
  assert.equal(room.seatCap, 3);
  assert.equal(room.freeSeat(), 1);
  // Two more humans take the last two seats; a FOURTH is refused (ROOM_FULL), i.e. the cap is the real seat count and
  // `room.join` cannot push past it.
  const b = await player(srv, 'Guest');
  assert.equal((await b.request({ t: 'room.join', code: state.code })).t, 'ok');
  assert.equal(room.freeSeat(), 2, 'three seats, the host and one guest in them');
  const c = await player(srv, 'Third');
  assert.equal((await c.request({ t: 'room.join', code: state.code })).t, 'ok');
  assert.equal(room.freeSeat(), -1, 'three seats, three players');
  const d = await player(srv, 'Late');
  const refused = await d.request({ t: 'room.join', code: state.code });
  assert.equal(refused.t, 'error');
  assert.equal(refused.code, ERR.ROOM_FULL);
  // A SOLO room ignores the field (its one-seat shape is the mode's): it keeps the SERVER's slot count whatever
  // `seatCap` the message named. Since the default ceiling is 20 that frame carries `seatCap: 20` (it differs from the
  // official 4 — the same rule every room follows); the mode still renders exactly one card.
  assert.equal((await a.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY', seatCap: 3 })).t, 'ok');
  const solo = await stateOf(a, 'solo');
  assert.equal(solo.seatCap, CEILING, 'the field is ignored: solo keeps the server slot count');
  assert.equal(solo.seats.length, CEILING, 'which is the 缺省上限 20, not the 3 the message asked for');
  // …and a solo room at the OFFICIAL 4 hides the key like any other 4-seat room (a class-level fact, so no extra room).
  assert.equal(Object.hasOwn(new Room('ZZZZ', 'solo', 'FUNNY', 0, MAX_SEATS).toState(), 'seatCap'), false);
  assert.deepEqual(errors, []);
});

test('roomSeatCap §3: out-of-range and junk seatCap are refused on the wire (no silent clamp)', async () => {
  const srv = await server();
  const a = await player(srv, 'Fuzzer');
  // NB: `NaN` is deliberately absent from this list — `JSON.stringify({ seatCap: NaN })` writes `null`, so the wire
  // cannot even carry it (the field then means "not sent"). The protocol's own handling of NaN is asserted in §1.
  for (const bad of [CEILING + 1, 1e9, MIN_SEATS - 1, 0, -3, 2.5, '3', true, {}, []]) {
    const r = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap: bad });
    assert.equal(r.t, 'error', `seatCap ${String(bad)} must be refused`);
    assert.equal(r.code, ERR.BAD_MSG);
    assert.equal(r.detail, 'bad field seatCap', 'the refusal NAMES the field');
  }
  // …and none of those attempts left a room behind
  assert.equal(srv.lobby.rooms.size, 0, 'a refused create builds nothing');
  assert.deepEqual(errors, []);
});

test('roomSeatCap §3: clampSeats is the last line for callers that never see the protocol', () => {
  assert.equal(clampSeats(3, 4), 3, 'in range ⇒ itself');
  assert.equal(clampSeats(4, 4), 4, 'exactly the ceiling ⇒ the ceiling (= the default room)');
  assert.equal(clampSeats(9, 4), 4, 'above ⇒ the ceiling');
  assert.equal(clampSeats(1, 4), MIN_SEATS, 'below ⇒ the floor');
  assert.equal(clampSeats(0, 4), MIN_SEATS);
  assert.equal(clampSeats(-3, 4), MIN_SEATS);
  // unusable ⇒ the ceiling, i.e. the room the server builds when the field is not sent at all
  for (const bad of [undefined, null, 2.5, '3', true, {}, [], NaN, Infinity]) {
    assert.equal(clampSeats(bad, 4), 4, `junk ${String(bad)} ⇒ the default room`);
  }
  // a deployment whose own ceiling is below the floor: the floor narrows instead of leaving an empty range
  assert.equal(clampSeats(3, 1), 1);
  assert.equal(clampSeats(undefined, 1), 1);
  // an unusable ceiling falls back to MAX_SEATS rather than to `undefined`
  assert.equal(clampSeats(2, undefined), 2);
  assert.equal(clampSeats(9, 'x'), MAX_SEATS);
  // the picker and the server must agree: a value the client clamps can never be one the protocol refuses
  for (const max of [2, 3, 4, 8, 100]) {
    for (const want of [undefined, 0, 1, 2, 3, 4, 8, 100, 1e9, 'x']) {
      const cap = clampSeats(want, max);
      const lo = Math.min(MIN_SEATS, max);
      assert.ok(cap >= lo && cap <= max, `clampSeats(${String(want)}, ${max}) = ${cap}`);
    }
  }
});

test('roomSeatCap §3: Lobby.create clamps a raised ceiling and ignores the field for solo', () => {
  // A deployment whose ceiling is 8 (`SP_MAX_SEATS=8`, §6 proves the env path). No sockets: `registry.byId` answers
  // nobody, so the room is built and encoded but never sent.
  const lobby = bareLobby({ maxSeats: 8 });

  const plain = fakeSession('p_plain');
  assert.deepEqual(lobby.create(plain, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const plainRoom = lobby.roomOf(plain);
  assert.equal(plainRoom.seatCap, 8, 'not sending the field = this server\'s ceiling');
  assert.equal(plainRoom.toState().seatCap, 8, 'and a room that is not the official 4 says which cap it has');

  const six = fakeSession('p_six');
  lobby.create(six, { mode: 'coop', difficulty: 'NORMAL', seatCap: 6 });
  assert.equal(lobby.roomOf(six).seatCap, 6, 'the host\'s pick is honoured inside the ceiling');

  const four = fakeSession('p_four');
  lobby.create(four, { mode: 'coop', difficulty: 'NORMAL', seatCap: 4 });
  assert.equal(lobby.roomOf(four).seatCap, 4);
  assert.equal(Object.hasOwn(lobby.roomOf(four).toState(), 'seatCap'), false, 'a 4-seat room hides the cap');

  // The clamp (not the protocol) is what stops these: a caller that skips validation cannot widen a room.
  const huge = fakeSession('p_huge');
  lobby.create(huge, { mode: 'coop', difficulty: 'NORMAL', seatCap: 99 });
  assert.equal(lobby.roomOf(huge).seatCap, 8, 'clamped to this server\'s ceiling');
  const tiny = fakeSession('p_tiny');
  lobby.create(tiny, { mode: 'coop', difficulty: 'NORMAL', seatCap: 1 });
  assert.equal(lobby.roomOf(tiny).seatCap, MIN_SEATS, 'clamped to the floor');

  const solo = fakeSession('p_solo');
  lobby.create(solo, { mode: 'solo', difficulty: 'FUNNY', seatCap: 3 });
  assert.equal(lobby.roomOf(solo).seatCap, 8, 'solo keeps the server slot count (the client draws one card)');
  assert.equal(lobby.roomOf(solo).toState().seats.length, 8);
});

// ---------------------------------------------------------------------------------------------------------------
// §4 the ceiling travels: welcome.maxSeats, on EVERY handshake (业主裁令 2026-10-12)

test('roomSeatCap §4: welcome ALWAYS carries maxSeats — the default ceiling is no longer the official 4', () => {
  // It used to be sent only when the ceiling left the official `MAX_SEATS`; the default ceiling is 20 now, so there is
  // no "vanilla" case left to omit it for. `SP_MAX_SEATS=4` is the deployment whose frames stay byte-identical, and it
  // still gets the field (with the value 4).
  const plain = bareLobby();
  assert.equal(plain.opts.maxSeats, DEFAULT_MAX_SEATS);
  assert.deepEqual(Object.keys(plain.welcomeInfo()), ['diyKitted', 'maxSeats'], 'the field is always there');
  assert.equal(plain.welcomeInfo().maxSeats, DEFAULT_MAX_SEATS);
  // A raised ceiling announces itself, because the slider must not offer a number the server would refuse.
  const wide = bareLobby({ maxSeats: 8 });
  assert.equal(wide.welcomeInfo().maxSeats, 8);
  // …and the official-4 deployment announces 4 — the field is present, the VALUE is what moved.
  const official = bareLobby({ maxSeats: MAX_SEATS });
  assert.equal(official.welcomeInfo().maxSeats, MAX_SEATS);
});

test('roomSeatCap §4: the real handshake announces the default ceiling (20)', async () => {
  const srv = await server();
  const a = await player(srv, 'Defaulted');
  assert.equal(a.welcome.maxSeats, DEFAULT_MAX_SEATS, 'the slider learns its range from the handshake');
  assert.equal(a.welcome.diyKitted !== undefined, true, 'the fields it always did have are still there');
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------------------------
// §5 quick match: its queue is ONE official room, and the room it builds keeps the server ceiling

test('roomSeatCap §5: a quick-matched room keeps the server ceiling; the queue stays one official room', async () => {
  // The queue size is the OFFICIAL room (`MAX_SEATS`), NOT the server's ceiling (业主裁令 2026-10-12): raising
  // `SP_MAX_SEATS` must not make strangers wait for 20 people. The room the placement builds still gets the ceiling.
  assert.equal(MATCHMAKE_DEFAULTS.size, null, 'null = one official room, never the server ceiling');
  assert.equal(LOBBY_DEFAULTS.maxSeats, DEFAULT_MAX_SEATS, 'the server ceiling is 20 by default');

  const srv = await server({ size: 2 });
  const a = await player(srv, 'Solo1');
  const b = await player(srv, 'Solo2');
  assert.equal((await a.request({ t: 'room.queue' })).t, 'ok');
  assert.equal((await b.request({ t: 'room.queue' })).t, 'ok');
  const placed = await a.waitFor('room.queued', (m) => m.status === 'placed');
  const state = await stateOf(a);
  assert.equal(state.code, placed.code);
  assert.equal(state.seatCap, DEFAULT_MAX_SEATS, 'a quick-matched room carries the server ceiling');
  assert.equal(state.seats.length, DEFAULT_MAX_SEATS);
  assert.equal(srv.lobby.getRoom(state.code).seatCap, LOBBY_DEFAULTS.maxSeats);
  assert.deepEqual(errors, []);
});

test('roomSeatCap §5: the queue threshold does NOT follow the server ceiling (业主裁令 2026-10-12)', async () => {
  // A 20-seat server that queues with NO explicit `size` must still wait for ONE OFFICIAL ROOM (4), not for 20: the
  // queue has no host to ask, and 「陌生人要凑满 20 才开局」 would be a different product. `queue.size` is the only way
  // to move it.
  const srv = await server();           // queue: { sweepMs: 20, waitMs: 3000 } — no `size`
  assert.equal(srv.lobby.opts.maxSeats, DEFAULT_MAX_SEATS, 'this server really is the 20-seat default');
  assert.equal(srv.lobby.matchmake.size, MAX_SEATS, 'and its queue is one official room wide');
  const a = await player(srv, 'Q1');
  assert.equal((await a.request({ t: 'room.queue' })).t, 'ok');
  const waiting = await a.waitFor('room.queued', (m) => m.status === 'waiting');
  assert.equal(waiting.need, MAX_SEATS, 'the panel is told 4, not the ceiling');
  assert.equal((await a.request({ t: 'room.dequeue' })).t, 'ok');
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------------------------
// §6 the deployment path: SP_MAX_SEATS=8, read when the modules are evaluated

test('roomSeatCap §6: SP_MAX_SEATS=8 raises the ceiling, the welcome field and the protocol gate together', () => {
  // `LOBBY_DEFAULTS.maxSeats` (server/lobby.js) and the protocol's `SEAT_CAP` are module-load constants, so this runs
  // in a child process — the real `SP_MAX_SEATS=8 npm start` wiring, not a stub.
  const script = `
    const { LOBBY_DEFAULTS, Lobby } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/lobby.js')).href)});
    const { MAX_SEATS, DEFAULT_MAX_SEATS, maxSeatsFrom } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'shared/constants.js')).href)});
    const { validateC2S } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'shared/protocol.js')).href)});
    const lobby = new Lobby({ registry: { byId: () => null }, getData: () => ({}), options: {} });
    const create = (seatCap) => validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap });
    process.stdout.write(JSON.stringify({
      maxSeatsFrom: maxSeatsFrom(process.env),
      defaultCap: LOBBY_DEFAULTS.maxSeats,
      welcome: lobby.welcomeInfo(),
      gate8: create(8),
      gate9: create(9),
      gate5: create(5),
      gate1: create(1),
      official: MAX_SEATS,
      builtinDefault: DEFAULT_MAX_SEATS,
    }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, SP_MAX_SEATS: '8' }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.maxSeatsFrom, 8);
  assert.equal(out.defaultCap, 8, 'the Lobby default follows the environment');
  assert.equal(out.welcome.maxSeats, 8, 'and announces it, so the slider knows its range');
  assert.equal(out.gate8, null, 'seat 8 is now askable');
  assert.equal(out.gate5, null, 'and so is 5');
  assert.equal(out.gate9, 'bad field seatCap', 'while 9 is still refused — the gate moved WITH the ceiling');
  assert.equal(out.gate1, 'bad field seatCap', 'and the floor is unchanged');
  assert.equal(out.official, 4, 'MAX_SEATS itself never moves');
  assert.equal(out.builtinDefault, 20, 'and the built-in default ceiling is 20 even here (the env overrides it)');
});

test('roomSeatCap §6: with NO environment the ceiling, the welcome field and the gate are all the default 20', () => {
  // The mirror of the child above, with the variable REMOVED: this is what a plain `npm start` deployment gets since
  // 业主裁令 2026-10-12. A child process again, because all three are module-load constants.
  const script = `
    const { LOBBY_DEFAULTS, Lobby } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server/lobby.js')).href)});
    const { maxSeatsFrom } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'shared/constants.js')).href)});
    const { validateC2S } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'shared/protocol.js')).href)});
    const lobby = new Lobby({ registry: { byId: () => null }, getData: () => ({}), options: {} });
    const create = (seatCap) => validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', seatCap });
    process.stdout.write(JSON.stringify({
      env: process.env.SP_MAX_SEATS ?? null,
      maxSeatsFrom: maxSeatsFrom(process.env),
      defaultCap: LOBBY_DEFAULTS.maxSeats,
      welcome: lobby.welcomeInfo(),
      gate20: create(20),
      gate21: create(21),
      gate4: create(4),
    }));
  `;
  const env = { ...process.env };
  delete env.SP_MAX_SEATS;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, `child failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.env, null, 'the variable really is absent in the child');
  assert.equal(out.maxSeatsFrom, 20, 'no SP_MAX_SEATS ⇒ 20 seats, not 4');
  assert.equal(out.defaultCap, 20);
  assert.equal(out.welcome.maxSeats, 20, 'the handshake announces it');
  assert.equal(out.gate20, null, 'a 20-seat room is requestable');
  assert.equal(out.gate21, 'bad field seatCap', 'and 21 is refused — the gate followed the new default');
  assert.equal(out.gate4, null, 'the official 4 is still requestable');
});

// ---------------------------------------------------------------------------------------------------------------
// §7 the client: the slider's range, the payload it builds, and the markup

test('roomSeatCap §7: the lobby builds a payload the server accepts, and stays silent at the default', async () => {
  const lobbyScreen = await import(pathToFileURL(path.join(ROOT, 'public/js/screens/lobby.js')).href);
  const { seatCapRange, seatCapPayload } = lobbyScreen;

  // The range: the floor, and the ceiling this client was told about. The slider itself starts from the 缺省上限 now
  // (20) — a client with no `welcome` yet keeps the OFFICIAL `MAX_SEATS`, which can only ever under-ask.
  assert.deepEqual(seatCapRange(DEFAULT_MAX_SEATS), { min: MIN_SEATS, max: DEFAULT_MAX_SEATS });
  assert.deepEqual(seatCapRange(MAX_SEATS), { min: MIN_SEATS, max: MAX_SEATS });
  assert.deepEqual(seatCapRange(100), { min: MIN_SEATS, max: 100 });
  assert.deepEqual(seatCapRange(undefined), { min: MIN_SEATS, max: MAX_SEATS }, 'unknown ⇒ the official room');
  assert.deepEqual(seatCapRange(0), { min: MIN_SEATS, max: MAX_SEATS });
  assert.deepEqual(seatCapRange(1), { min: 1, max: 1 }, 'a one-seat server: the floor narrows, the range is not empty');

  // The payload: `{}` whenever the room is the server's default one — which is now 20 seats.
  assert.deepEqual(seatCapPayload('coop', 3, 4), { seatCap: 3 });
  assert.deepEqual(seatCapPayload('coop', 2, 4), { seatCap: 2 });
  assert.deepEqual(seatCapPayload('coop', 4, 4), {}, 'an untouched slider sends NOTHING');
  assert.deepEqual(seatCapPayload('coop', DEFAULT_MAX_SEATS, DEFAULT_MAX_SEATS), {}, 'and so does the 20-seat default');
  assert.deepEqual(seatCapPayload('coop', 8, 8), {}, 'nor does one sitting at a raised ceiling');
  assert.deepEqual(seatCapPayload('coop', 9, 4), {}, 'above the ceiling ⇒ clamped to it ⇒ the default room');
  assert.deepEqual(seatCapPayload('coop', 1, 4), { seatCap: 2 }, 'below the floor ⇒ clamped to it');
  assert.deepEqual(seatCapPayload('coop', undefined, 4), {}, 'no pick yet ⇒ the default room');
  assert.deepEqual(seatCapPayload('solo', 3, 4), {}, 'a solo room never carries the field');
  assert.deepEqual(seatCapPayload('coop', 6, 8), { seatCap: 6 }, 'a raised server: 6 of 8 is a real choice');
  // Whatever the client builds must pass the very gate the server applies (§1) — for the ceilings THIS process's
  // protocol gate knows (`SEAT_CAP` = `maxSeatsFrom(process.env)` = 20 here). A deployment that sets `SP_MAX_SEATS`
  // moves BOTH together, which §6 proves end to end (8 admits 5 and 8; the default admits 20).
  for (const pick of [undefined, null, 0, 1, 2, 3, 4, 6, 99, 1e9]) {
    const payload = seatCapPayload('coop', pick, CEILING);
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', ...payload }), null,
      `pick ${String(pick)} of ${CEILING} must be a legal request`);
  }
  // The asymmetry this test cannot exercise in-process (a ceiling raised by OPTION while the gate stays at the
  // environment's) is unreachable in a deployment: `maxSeats` is not one of the lobby options startServer forwards
  // (server/http/config.js LOBBY_OPTION_KEYS), so the only production source of a raised ceiling is `SP_MAX_SEATS` —
  // and that one moves `LOBBY_DEFAULTS.maxSeats` and `SEAT_CAP` in the same evaluation. What matters for a STALE
  // client (a page too old to know `maxSeats` at all) is that assuming `MAX_SEATS` can only ever UNDER-ask, never
  // produce a request any server refuses — including the 20-seat default one.
  for (const pick of [undefined, 0, 1, 2, 5, 9, 1e9, 'x']) {
    const payload = seatCapPayload('coop', pick, MAX_SEATS);
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', ...payload }), null,
      `a client that never heard maxSeats (pick ${String(pick)}) stays legal`);
  }
});

test('roomSeatCap §7: the ceiling reaches the screen from `welcome`, and resets with it', async () => {
  const lobbyScreen = await import(pathToFileURL(path.join(ROOT, 'public/js/screens/lobby.js')).href);
  const { net } = await import(pathToFileURL(path.join(ROOT, 'public/js/net.js')).href);
  // The module starts at the OFFICIAL 4 (what a page that never hears `welcome` must assume), and follows the
  // handshake from there — a 20-seat default server announces 20, so the slider reaches 20.
  assert.equal(lobbyScreen.serverSeatMaxOf(), MAX_SEATS, 'no welcome yet ⇒ the official room, never a guess upward');
  // The module listens for the frame itself: the handshake lands before this screen is mounted, so a listener added
  // with the component would miss it and the slider would keep offering 4 on a 100-seat server.
  net._emit('welcome', { maxSeats: 100 });
  assert.equal(lobbyScreen.serverSeatMaxOf(), 100);
  assert.deepEqual(lobbyScreen.seatCapRange(lobbyScreen.serverSeatMaxOf()), { min: MIN_SEATS, max: 100 });
  // …and the 缺省上限 itself (20) is what a plain server sends.
  net._emit('welcome', { maxSeats: DEFAULT_MAX_SEATS });
  assert.equal(lobbyScreen.serverSeatMaxOf(), DEFAULT_MAX_SEATS);
  net._emit('welcome', { maxSeats: 'junk' });
  assert.equal(lobbyScreen.serverSeatMaxOf(), MAX_SEATS, 'junk ⇒ the official room, never `undefined`');
  net._emit('welcome', {});
  assert.equal(lobbyScreen.serverSeatMaxOf(), MAX_SEATS);
});

test('roomSeatCap §7: the slider is a range input inside the create box, co-op only, and nothing else moved', () => {
  const screen = src('public/js/screens/lobby.js');
  const css = src('public/css/screens/lobby.css');
  const room = src('public/js/screens/room.js');
  // A real slider, in the create box, carrying the current value and both ends for assistive tech.
  assert.match(screen, /type="range"/);
  assert.match(screen, /class="seat-cap__slider"/);
  assert.match(screen, /aria-valuemin=\$\{min\}[\s\S]{0,80}aria-valuemax=\$\{max\}[\s\S]{0,80}aria-valuenow=\$\{value\}/);
  assert.match(screen, /<div class="seat-cap__head">/, 'the current value and the ceiling are both shown');
  assert.match(screen, /class="seat-cap__value num">\$\{value\}/);
  // Host-only by construction: it is rendered by the lobby's create box, and only for a co-op room.
  assert.match(screen, /roomMode === 'coop'\s*\?\s*html`<\$\{SeatCapPicker\}/);
  // The payload reaches `room.create` and nothing else — quick match (`room.queue`) is NOT given a seat cap.
  assert.match(screen, /net\.request\('room\.create', \{\s*[\s\S]{0,160}\.\.\.seatCapPayload\(roomMode, seatValue, seatMax\)/);
  assert.equal(/room\.queue'[\s\S]{0,220}seatCap/.test(screen), false, 'a queued player picks nothing');
  // Styles: a NEW block, and no seat layout of the room screen touched (the previous cut's rule).
  assert.match(css, /\.seat-cap__slider \{/);
  assert.match(css, /\.seat-cap__slider::-webkit-slider-thumb/);
  assert.equal(/^\.seats\b/m.test(css), false, 'the room screen\'s seat grid is not restyled from the lobby');
  assert.match(room, /const MAX_RENDERED_SEATS = 256;/, 'room.js still clamps what it pads to');
  // ⚠️ 断言改动（第 1 处，旧 DOM 形状）：`.seats--dense` 属于**引擎的座席网格**（`main.seats` + room.css 的
  // `.seats--dense`）。ui-hub 包把房间主体换成 `main.rs-seats`，超容的密集排布由它自己的 `.rs--big` 承担
  // （room.js 里 `facts.seats.length > DEFAULT_SEATS ? ' rs--big'`）。判据要钉的**行为**没变 —— 只在超过官方上限
  // （DEFAULT_SEATS == MAX_SEATS == 4）时才切密集形态 —— 所以这里按新形状重新钉，不放松阈值。
  assert.match(room, /facts\.seats\.length > DEFAULT_SEATS \? ' rs--big'/, 'and still only densifies above 4');
});

test('roomSeatCap §7: the new interface strings exist in all four packs', () => {
  const ids = ['本房间人数上限', '服务器允许最多 {max} 人；本同盟开 {value} 张座位卡', '不能小于同盟内现有人数（含 AI 队友）'];
  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) {
    const pack = JSON.parse(src(`public/i18n/${lang}.json`));
    for (const id of ids) assert.equal(typeof pack[id], 'string', `${lang} is missing ${id}`);
    // The placeholders of a msgid must survive translation, or the string renders with a literal `{max}`.
    assert.match(pack[ids[1]], /\{max\}/, `${lang} drops {max}`);
    assert.match(pack[ids[1]], /\{value\}/, `${lang} drops {value}`);
    // …and the code the server answers a refused shrink with is a msgid too (`ERR_TEXT`, rendered by toasts.js).
    assert.equal(typeof pack[ERR_TEXT_SEAT_CAP_TOO_SMALL], 'string', `${lang} is missing the SEAT_CAP_TOO_SMALL text`);
  }
});

test('roomSeatCap §7: the mode card counts THIS server\'s ceiling, not the official 4 (业主裁令 2026-10-12)', async () => {
  const screen = src('public/js/screens/lobby.js');
  // The card's `{n}` is computed at render time from the handshake value — a fixed `MAX_SEATS - 1` would keep promising
  // 「至多 3 名博士」 on a 20-seat server.
  assert.match(screen, /const seats = card\.id === 'coop' \? serverSeatMaxOf\(\) : MAX_SEATS;/,
    'the co-op card reads the server ceiling');
  assert.match(screen, /const params = card\.id === 'coop' \? \{ n: Math\.max\(1, seats - 1\) \} : card\.params;/,
    'the description counts the other doctors (ceiling − 1)');
  assert.match(screen, /const pointParams = card\.id === 'coop' \? \{ n: seats \} : card\.pointParams;/,
    'the bullet counts the whole room (ceiling)');
  // The msgids themselves did not move: only the VALUE does, so every pack keeps working.
  assert.match(screen, /N_\('与至多 \{n\} 名博士组成同盟，共享干员池，联防协作抵御敌潮。'\)/);
  // ⚠️ 断言改动（第 2 处，被包版的文案取代）：包版把同盟卡的那一条从「可由 AI 队友补位」改成「邀请真人队友」——
  // 因为包版的新房间**不再提供手动添加 AI 队友**这个入口（它改走精确搜寻 / matchmaking）。msgid 换了，行为判据
  // （上面三条按本服务器上限重算 `{n}`）一字未动；这里只把被取代的那个 msgid 换成包版实际在用的那个。
  assert.match(screen, /N_\('1–\{n\} 名博士 · 邀请真人队友'\)/);
  // …and the translation renders the ceiling the server actually allows, in the official mode too.
  const { t } = await import(pathToFileURL(path.join(ROOT, 'shared/i18n.js')).href);
  const desc = '与至多 {n} 名博士组成同盟，共享干员池，联防协作抵御敌潮。';
  assert.match(t(desc, { n: DEFAULT_MAX_SEATS - 1 }), /19/, 'a 20-seat server says 19 other Doctors');
  assert.match(t(desc, { n: MAX_SEATS - 1 }), /3/, 'and an official 4-seat server still says 3');
});

// ---------------------------------------------------------------------------------------------------------------
// §8 what this slice did NOT touch

test('roomSeatCap §8: MAX_SEATS is untouched; the default ceiling and the queue threshold both moved for the right reason', () => {
  assert.equal(MAX_SEATS, 4, 'the official room, and the variant gate reads participants — never this');
  assert.equal(maxSeatsFrom(), DEFAULT_MAX_SEATS, 'no SP_MAX_SEATS ⇒ the DEFAULT ceiling (20)');
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '100' }), 100);
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: 'junk' }), DEFAULT_MAX_SEATS, 'junk ⇒ the default ceiling, not 4');
  assert.equal(maxSeatsFrom({ SP_MAX_SEATS: '4' }), MAX_SEATS, 'and the official 4 is one env var away');
  // server/matchmaking.js: the queue threshold is the OFFICIAL room, NOT the server ceiling (业主裁令 2026-10-12).
  const mm = src('server/matchmaking.js');
  assert.match(mm, /const seats = Number\.isInteger\(lobby\?\.opts\?\.maxSeats\)/);
  assert.match(mm, /\? Math\.min\(this\.opts\.size, seats\) : MAX_SEATS;/, 'an explicit size is clamped; the default is 4');
  assert.match(mm, /seatCap` is deliberately NOT sent here/, 'the decision is written down where it is taken');
  assert.match(mm, /this\.lobby\.create\(picked\[0\]\.session, \{ mode: QUEUE_MODE, difficulty: picked\[0\]\.difficulty \}\)/,
    'and the placement still asks for no seat cap at all');
  // A live queue proves it: a 20-seat server still opens a room for the OLD threshold (explicit size here, so the
  // default itself is pinned by the assertion above and by §5).
  assert.equal(MATCHMAKE_DEFAULTS.size, null);
});

// ---------------------------------------------------------------------------------------------------------------
// §9 建房后改容量: room.setSeatCap (业主裁决 B5). The room's seat count is no longer fixed at creation — the HOST may
// resize the room it is already in, and the ONE rule that makes that safe is 新上限 ≥ 房间内现有人数: with it, a shrink
// can only ever drop EMPTY seats, so the feature can never evict anybody.

test('roomSeatCap §9: room.setSeatCap is a C2S message whose TWO fields are both required', () => {
  const spec = C2S['room.setSeatCap'];
  assert.ok(spec, 'the message is declared in the catalogue');
  const base = { t: 'room.setSeatCap', code: 'ABCD', seatCap: 3 };
  assert.equal(validateC2S(base), null);
  assert.equal(validateC2S({ ...base, code: 'abcd1' }), null, 'the same code alphabet as room.join');
  // Both fields are REQUIRED (there is no old client for a brand-new message): a message missing either one is malformed,
  // not "use the default" — that is what keeps `code` able to address one specific room.
  assert.equal(validateC2S({ t: 'room.setSeatCap', seatCap: 3 }), 'bad field code');
  assert.equal(validateC2S({ t: 'room.setSeatCap', code: 'ABCD' }), 'bad field seatCap');
  assert.equal(validateC2S({ t: 'room.setSeatCap', code: 'AB CD', seatCap: 3 }), 'bad field code');
  assert.equal(validateC2S({ t: 'room.setSeatCap', code: 42, seatCap: 3 }), 'bad field code');
  // `seatCap` shares room.create's bound and its explicit refusal, so one rule covers both messages.
  for (let n = MIN_SEATS; n <= MAX_SEATS; n++) assert.equal(validateC2S({ ...base, seatCap: n }), null, `seatCap ${n}`);
  assert.equal(validateC2S({ ...base, seatCap: CEILING }), null, `seatCap ${CEILING} is the ceiling itself`);
  for (const bad of [CEILING + 1, 1e9, MIN_SEATS - 1, 0, -3, 2.5, '3', true, {}, [], null]) {
    assert.equal(validateC2S({ ...base, seatCap: bad }), 'bad field seatCap',
      `junk seatCap ${JSON.stringify(bad) ?? String(bad)}`);
  }
});

test('roomSeatCap §9: the two refusals are DISTINGUISHABLE — a bad number vs a number this room cannot hold', () => {
  const lobby = bareLobby({ maxSeats: 8 });
  const host = fakeSession('p_host');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', seatCap: 4 });
  const room = lobby.roomOf(host);
  const ask = (seatCap, session = host, code = room.code) => lobby.setSeatCap(session, { code, seatCap });

  // (a) the number itself is not a seat count this server allows ⇒ BAD_MSG, and the detail names the range.
  const bad = ask(99);
  assert.equal(bad.error, ERR.BAD_MSG);
  assert.match(bad.detail, /\[2, 8\]/, 'the refusal says which numbers WOULD be legal');
  for (const junk of [1, 0, -3, 2.5, NaN, '3', null, undefined]) {
    assert.equal(ask(junk).error, ERR.BAD_MSG, `junk ${String(junk)}`);
  }
  assert.equal(room.seatCap, 4, 'a refused request changes nothing');

  // (b) the number is legal but the room cannot hold it ⇒ SEAT_CAP_TOO_SMALL, a DIFFERENT code (the client's next move
  // is "ask somebody to leave", not "type another number").
  const guests = ['p_b', 'p_c'].map((id) => fakeSession(id));
  for (const g of guests) lobby.join(g, { code: room.code });
  assert.equal(room.occupiedSeats().length, 3);
  const small = ask(MIN_SEATS);
  assert.equal(small.error, ERR.SEAT_CAP_TOO_SMALL);
  assert.notEqual(small.error, ERR.BAD_MSG, 'the two refusals must never collapse into one code');
  assert.equal(room.seatCap, 4, 'and this one changes nothing either');
  assert.equal(ERR_TEXT[ERR.SEAT_CAP_TOO_SMALL], ERR_TEXT_SEAT_CAP_TOO_SMALL, 'the code has a message of its own');
  assert.ok(ERR_TEXT[ERR.SEAT_CAP_TOO_SMALL], 'every ERR code carries an ERR_TEXT entry (client-static pins this)');
});

test('roomSeatCap §9: host-only, this-room-only, co-op only, and not during a match', () => {
  const lobby = bareLobby({ maxSeats: 8 });
  const host = fakeSession('p_host');
  const guest = fakeSession('p_guest');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', seatCap: 4 });
  const room = lobby.roomOf(host);
  lobby.join(guest, { code: room.code });

  assert.equal(lobby.setSeatCap(guest, { code: room.code, seatCap: 4 }).error, ERR.NOT_HOST, 'not the host');
  assert.equal(lobby.setSeatCap(host, { code: 'ZZZZ', seatCap: 5 }).error, ERR.NOT_IN_ROOM, 'not this room');
  // …and a session with no room at all is refused the same way (never "resize whatever you are in now")
  assert.equal(lobby.setSeatCap(fakeSession('p_out'), { code: room.code, seatCap: 5 }).error, ERR.NOT_IN_ROOM);
  assert.equal(room.seatCap, 4);

  // a running match: the lobby's seat array is not the one the match is playing with, so the honest answer is "no".
  // (Poked directly: driving a real match here would test StubMatch, not this guard — the wire test §10 covers the path.)
  room.match = { stub: true };
  assert.equal(lobby.setSeatCap(host, { code: room.code, seatCap: 5 }).error, ERR.ROOM_STARTED);
  room.match = null;

  // a solo room has no seat count to pick — its one-seat shape belongs to the MODE, not to a cap.
  const solo = fakeSession('p_solo');
  lobby.create(solo, { mode: 'solo', difficulty: 'FUNNY' });
  const soloRoom = lobby.roomOf(solo);
  assert.equal(lobby.setSeatCap(solo, { code: soloRoom.code, seatCap: 4 }).error, ERR.BAD_TARGET);
  assert.equal(soloRoom.seatCap, 8, 'and it keeps the server slot count');
});

test('roomSeatCap §9: THE INVARIANT — resizing never evicts anybody and never moves a seat', () => {
  const lobby = bareLobby({ maxSeats: 8 });
  const host = fakeSession('p_host');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', seatCap: 4 });
  const room = lobby.roomOf(host);
  const others = ['p_b', 'p_c'].map((id) => fakeSession(id));
  for (const g of others) lobby.join(g, { code: room.code });
  lobby.addBot(host);                       // a bot counts as an occupant too
  assert.equal(room.occupiedSeats().length, 4, 'four seats, four occupants');

  /** The identity of every occupied seat: who sits where. This is what "nobody was evicted" means. */
  const layout = () => room.seats.map((s, i) => (s ? `${i}:${s.playerId}` : null));
  const before = layout();
  assert.deepEqual(before, ['0:p_host', '1:p_b', '2:p_c', `3:${room.seats[3].playerId}`]);

  // Every legal move, in both directions, one at a time: the occupied set and the indices may not move by one inch.
  for (const cap of [8, 5, 4, 6, 4]) {
    const res = lobby.setSeatCap(host, { code: room.code, seatCap: cap });
    assert.equal(res.ok, true, `cap ${cap}: ${JSON.stringify(res)}`);
    assert.equal(room.seatCap, cap);
    assert.equal(room.seats.length, cap, 'the array is exactly as long as the cap');
    assert.deepEqual(layout().filter(Boolean), before, `cap ${cap} kept every occupant in its own seat`);
    for (const s of before) {
      const [idx, id] = s.split(':');
      assert.equal(room.seats[Number(idx)].playerId, id, 'nobody moved seat, nobody left');
    }
  }
  // …and the room still holds exactly those four people, each still on its own seat.
  assert.equal(room.occupiedSeats().length, 4);
  assert.equal(room.activeHumans().length, 3);
  assert.equal(room.seats.filter((s) => s && s.isBot).length, 1);
});

test('roomSeatCap §9: a seat GAP still cannot be shrunk over (a count-only rule would evict somebody)', () => {
  // The creator leaving for good empties seat 0 while seat 2 stays taken, so the number of people (2) is SMALLER than
  // the highest occupied index + 1 (3). The guard is the index rule, and this is the case that tells them apart.
  const lobby = bareLobby({ maxSeats: 8 });
  const a = fakeSession('p_a');
  const b = fakeSession('p_b');
  const c = fakeSession('p_c');
  lobby.create(a, { mode: 'coop', difficulty: 'NORMAL', seatCap: 4 });
  const room = lobby.roomOf(a);
  lobby.join(b, { code: room.code });
  lobby.join(c, { code: room.code });
  lobby.leave(a);
  assert.deepEqual(room.seats.map((s) => (s ? s.playerId : null)), [null, 'p_b', 'p_c', null]);
  assert.equal(room.occupiedSeats().length, 2, 'two people …');
  assert.equal(room.seats.reduce((m, s, i) => (s ? i : m), -1), 2, '… but somebody sits in seat index 2');
  const res = lobby.setSeatCap(b, { code: room.code, seatCap: 2 });
  assert.equal(res.error, ERR.SEAT_CAP_TOO_SMALL, '2 people, but a cap of 2 would drop the one at index 2');
  assert.deepEqual(room.seats.map((s) => (s ? s.playerId : null)), [null, 'p_b', 'p_c', null]);
  // The smallest legal cap is highestOccupiedIndex + 1, which is exactly what the client's slider offers as its minimum.
  assert.equal(lobby.setSeatCap(b, { code: room.code, seatCap: 3 }).ok, true);
  assert.deepEqual(room.seats.map((s) => (s ? s.playerId : null)), [null, 'p_b', 'p_c']);
});

test('roomSeatCap §9: 4 → 8 → 4 is BYTE-FOR-BYTE the frame it started from (the key comes back off)', () => {
  const lobby = bareLobby({ maxSeats: 8 });
  const host = fakeSession('p_host');
  const guest = fakeSession('p_guest');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', seatCap: 4 });
  const room = lobby.roomOf(host);
  lobby.join(guest, { code: room.code });
  const before = JSON.stringify(room.toState());
  assert.equal(Object.hasOwn(room.toState(), 'seatCap'), false, 'a 4-seat room carries no cap');

  assert.equal(lobby.setSeatCap(host, { code: room.code, seatCap: 8 }).ok, true);
  assert.equal(room.toState().seatCap, 8, 'grown: the frame now says which cap it has');
  assert.equal(room.toState().seats.length, 8);

  assert.equal(lobby.setSeatCap(host, { code: room.code, seatCap: 4 }).ok, true);
  assert.equal(Object.hasOwn(room.toState(), 'seatCap'), false, 'back to the official 4 ⇒ the key is GONE again');
  assert.equal(JSON.stringify(room.toState()), before, 'and the whole frame is the one it started from');

  // Re-asking for the cap it already has is a no-op that still answers ok (idempotent, so a retry is safe).
  assert.equal(lobby.setSeatCap(host, { code: room.code, seatCap: 4 }).ok, true);
  assert.equal(JSON.stringify(room.toState()), before);
});

// ---------------------------------------------------------------------------------------------------------------
// §10 the wire, and the room screen's own slider

test('roomSeatCap §10: the host resizes a live room over the wire, and the frame follows', async () => {
  const srv = await server();
  const host = await player(srv, 'Shrink');
  const guest = await player(srv, 'Stays');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const start = await stateOf(host);
  assert.equal(start.seats.length, CEILING, 'the room opens at the server ceiling (缺省 20)');
  assert.equal(start.seatCap, CEILING);
  assert.equal((await guest.request({ t: 'room.join', code: start.code })).t, 'ok');

  // shrink to 3 (2 people, so 3 is legal) — the broadcast is the room's own `room.state`. The predicate names the NEW
  // cap: the host's inbox still holds the frame the guest's join produced, and that one has no `seatCap`.
  assert.equal((await host.request({ t: 'room.setSeatCap', code: start.code, seatCap: 3 })).t, 'ok');
  const smaller = await host.waitFor('room.state', (s) => s.seatCap === 3);
  assert.equal(smaller.seats.length, 3);
  assert.equal(smaller.seats[1].playerId, guest.id, 'the guest is still exactly where they were');
  assert.equal(srv.lobby.getRoom(start.code).seatCap, 3);

  // …and the guest sees the same frame (every member is told, not only the host)
  const guestView = await guest.waitFor('room.state', (s) => s.seatCap === 3);
  assert.equal(guestView.seats.length, 3);

  // shrink to 2 with TWO people in it is legal (nobody is evicted): the seat count follows the people, not a constant
  assert.equal((await host.request({ t: 'room.setSeatCap', code: start.code, seatCap: 2 })).t, 'ok');
  await host.waitFor('room.state', (s) => s.seatCap === 2);
  const third = await player(srv, 'Third');
  assert.equal((await third.request({ t: 'room.join', code: start.code })).code, ERR.ROOM_FULL,
    'a 2-seat room takes exactly two people');
  assert.deepEqual(errors, []);
});

test('roomSeatCap §10: the refusals over the wire — NOT_HOST, NOT_IN_ROOM, BAD_MSG, SEAT_CAP_TOO_SMALL', async () => {
  const srv = await server();
  const host = await player(srv, 'Host');
  const guest = await player(srv, 'Guest');
  const third = await player(srv, 'Third');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const state = await stateOf(host);
  assert.equal((await guest.request({ t: 'room.join', code: state.code })).t, 'ok');
  assert.equal((await third.request({ t: 'room.join', code: state.code })).t, 'ok');
  const ask = (c, body) => c.request({ t: 'room.setSeatCap', ...body });

  // non-host ⇒ NOT_HOST (the client shows 「只有房主可以操作」)
  const notHost = await ask(guest, { code: state.code, seatCap: 4 });
  assert.equal(notHost.t, 'error');
  assert.equal(notHost.code, ERR.NOT_HOST);

  // a room this sender is not in ⇒ NOT_IN_ROOM (a stale tab may not resize the room it moved to)
  const wrongRoom = await ask(host, { code: 'ZZZZ', seatCap: 4 });
  assert.equal(wrongRoom.code, ERR.NOT_IN_ROOM);

  // the number itself is wrong ⇒ BAD_MSG, and the detail names the field's bound
  const malformed = await ask(host, { code: state.code, seatCap: CEILING + 1 });
  assert.equal(malformed.code, ERR.BAD_MSG);
  assert.match(malformed.detail, /seatCap/);

  // legal number, room cannot hold it (3 people) ⇒ SEAT_CAP_TOO_SMALL, a DIFFERENT code — see §9
  const tooSmall = await ask(host, { code: state.code, seatCap: 2 });
  assert.equal(tooSmall.t, 'error');
  assert.equal(tooSmall.code, ERR.SEAT_CAP_TOO_SMALL);
  assert.notEqual(tooSmall.code, ERR.BAD_MSG);
  // the room is untouched by every one of them
  assert.equal(srv.lobby.getRoom(state.code).seatCap, CEILING);
  assert.deepEqual(errors, []);
});

test('roomSeatCap §10: room.setSeatCap is refused inside a running match (ROOM_STARTED over the wire)', async () => {
  const srv = await server();
  const host = await player(srv, 'Solo');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const state = await stateOf(host);
  assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
  const denied = await host.request({ t: 'room.setSeatCap', code: state.code, seatCap: 3 });
  assert.equal(denied.t, 'error');
  assert.equal(denied.code, ERR.ROOM_STARTED, 'a running match keeps the seats it started with');
  assert.equal(srv.lobby.getRoom(state.code).seatCap, CEILING);
});

test('roomSeatCap §10: the room slider range mirrors the server, so the host cannot drag into a refusal', async () => {
  const roomScreen = await import(pathToFileURL(path.join(ROOT, 'public/js/screens/room.js')).href);
  const { seatCapRoomRange } = roomScreen;
  const room = (seats, extra = {}) => ({ t: 'room.state', code: 'ABCD', hostId: 'me', mode: 'coop', difficulty: 'NORMAL', seats, ...extra });
  const filled = (ids) => ids.map((id, i) => ({ seat: i, playerId: id, name: id, isBot: false, ready: false, connected: true }));
  const empty = (n) => new Array(n).fill(null);

  // solo has no cap to choose; a room whose occupants already fill every legal seat has nothing to choose either
  assert.equal(seatCapRoomRange(room(filled(['me']), { mode: 'solo' }), MAX_SEATS), null);
  assert.equal(seatCapRoomRange(null, MAX_SEATS), null);
  assert.equal(seatCapRoomRange(room(filled(['a', 'b', 'c', 'd'])), MAX_SEATS), null, '4 people, official cap ⇒ no choice');

  // one human in a 4-seat room: 2…4, exactly the stops the server accepts
  assert.deepEqual(seatCapRoomRange(room(filled(['me'])), MAX_SEATS), { min: 2, max: 4, value: 4 });
  assert.deepEqual(seatCapRoomRange(room(filled(['me'])), 8), { min: 2, max: 8, value: 4 });
  assert.deepEqual(seatCapRoomRange(room(empty(4)), MAX_SEATS), { min: 2, max: 4, value: 4 }, 'an empty 4-seat room');
  // three people: the floor follows the ROOM (the server refuses cap <= highest occupied index)
  assert.deepEqual(seatCapRoomRange(room(filled(['a', 'b', 'c'])), MAX_SEATS), { min: 3, max: 4, value: 4 });
  assert.deepEqual(seatCapRoomRange(room(filled(['a', 'b', 'c'])), 8), { min: 3, max: 8, value: 4 });
  // a GAP (the creator left for good): the floor is highestIndex + 1, not the number of people — the same rule the
  // server's eviction guard uses (§9), so no stop the host can reach is one the server would refuse.
  assert.deepEqual(seatCapRoomRange(room([null, ...filled(['b', 'c'])]), 8), { min: 3, max: 8, value: 4 });
  // an already-raised room keeps showing its own cap as the value, and every value is inside [min, max]
  assert.deepEqual(seatCapRoomRange(room([...filled(['me']), ...empty(7)], { seatCap: 8 }), 8), { min: 2, max: 8, value: 8 });
  for (const [seats, serverMax, roomCap] of [[filled(['me']), MAX_SEATS, undefined], [filled(['a', 'b']), 8, undefined], [filled(['a']), 100, 40]]) {
    const r = seatCapRoomRange(room(seats, roomCap ? { seatCap: roomCap } : {}), serverMax);
    assert.ok(r.value >= r.min && r.value <= r.max, `value ${r.value} inside [${r.min}, ${r.max}]`);
    assert.ok(r.min >= MIN_SEATS, 'the floor never goes below MIN_SEATS');
    assert.ok(r.max >= serverMax || r.max >= roomCap, 'and the ceiling is never below the room');
  }
});

test('roomSeatCap §10: the slider is in the ROOM bar, host-only, and the seat layout is untouched', () => {
  const screen = src('public/js/screens/room.js');
  // a real range input, rendered from the host branch of the room bar next to the other host controls
  assert.match(screen, /class="seat-cap seat-cap--room"/);
  assert.match(screen, /<input class="seat-cap__slider" type="range" min=\$\{range\.min\} max=\$\{range\.max\} step="1" value=\$\{shown\}/);
  // ⚠️ 断言改动（第 3 处，旧 DOM 形状）：`.room-bar__opts` 是**引擎**房间底栏的那一列。ui-hub 包的房间把房主控件
  // 收进了 ⚙「同盟设置」浮层（`.rs-opts`，RoomOptions 组件内），`.room-bar__opts` 这个节点在新 DOM 里不存在。
  // 判据要钉的**行为**没变 —— 「和难度选择、AI 队友最后选择同列（房主控件那一列），不在座席上」—— 所以按新形状
  // 重钉到 RoomOptions 的函数体里，并显式排除座席卡的类名。
  const opts = screen.slice(screen.indexOf('function RoomOptions('), screen.indexOf('/** Room screen component. */'));
  assert.match(opts, /<\$\{SeatCapSetter\} room=\$\{room\} isHost=\$\{host\} onPick=\$\{onSeatCap\} \/>/,
    'the host settings popover is where it lives — next to the difficulty picker and the AI-picks-last switch');
  assert.equal(/rseat__/.test(opts), false, 'and it is not over the seats');
  // host-only, and only where there is something to choose (the component returns null otherwise)
  assert.match(screen, /const range = isHost \? seatCapRoomRange\(room, serverSeatMaxOf\(\)\) : null;/);
  assert.match(screen, /if \(!range\) return null;/);
  // it asks the SERVER's message, with the room code, and nothing else
  assert.match(screen, /net\.request\('room\.setSeatCap', \{ code: room\.code, seatCap \}\)/);
  // the seat grid keeps its rules: the dense form still appears ONLY above the official cap
  // （同第 1 处的理由：包版把 `.seats--dense` 换成它自己的 `.rs--big`，阈值与行为一字未动。）
  assert.match(screen, /facts\.seats\.length > DEFAULT_SEATS \? ' rs--big'/);
  assert.match(screen, /const MAX_RENDERED_SEATS = 256;/);
  // styles for the room variant live in the seat-cap block this slice added, and no `.seats` rule was touched
  const css = src('public/css/screens/lobby.css');
  assert.match(css, /\.seat-cap--room \{/);
  assert.equal(/^\.seats\b/m.test(css), false);
});

