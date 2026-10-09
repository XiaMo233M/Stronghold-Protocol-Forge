// test/roomKeep.test.js — 房间保留 (room retention; server/lobby.js onMatchEnd, docs/META.md §1.7).
//
// The product rule: when a match ends the room is NOT torn down. It stays in the lobby in its LOBBY state with its
// members, its `modIds` / `modSet` (W-B: the room's own set must not be lost), its difficulty and its AI-picks-last
// option intact — so the group starts another match without re-inviting. It is reclaimed exactly like any other room:
// the last active human leaving disposes it, and a disconnected human's seat is released by the lobby grace.
//
// This file drives the REAL platform (startServer → Lobby → Match) with `MatchClass: StubMatch` so a whole match lasts
// milliseconds, and a REAL workshop pack so `room.create { modIds }` declares a set the server actually carries.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { loadWorkshop } from '../server/workshop.js';
import { modSetOf } from '../shared/modIdentity.js';
import { TestClient } from './helpers/wsClient.js';

const errors = [];
const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
const clients = [];
const servers = [];
let tmp = null;
let digest = null;

/** A minimal layer-A pack: one new operator record, no code (test/roomModSet.test.js writes the same shape). */
function writePack(root, id, name) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name, version: '0.1.0', content: ['chess'], overrides: [] }));
  const chessId = `chess_rk_${id.replace(/-/g, '_')}_a`;
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({ [chessId]: { chessId, baseId: chessId, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 2000, atk: 500, def: 200, res: 0, cost: 18, blockCnt: 2, bat: 1.2 }, talents: [], bonds: [] } }));
  return chessId;
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-roomkeep-'));
  const root = path.join(tmp, 'workshop');
  fs.mkdirSync(root, { recursive: true });
  writePack(root, 'keep-pack', 'Keep');
  // the identity the client must echo, computed the same way the server computes it (shared/modIdentity.js)
  digest = modSetOf(loadWorkshop(root, { log }).packs
    .map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }))).digest;
});

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A real server running the pack above, with a short lobby grace so a dropped seat does not outlive its test. */
async function server() {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', log, MatchClass: StubMatch, seedFn: () => 11, lobbyGraceMs: 250,
    workshopDir: path.join(tmp, 'workshop'),
  });
  servers.push(srv);
  return srv;
}

async function player(srv, name, token) {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(c);
  const welcome = await c.hello(name, token);
  c.id = welcome.playerId;
  c.token = welcome.token;
  return c;
}

const ok = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
/** Wait until `pred()` (the server processes socket events asynchronously). */
async function until(pred, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await delay(5);
  }
  return true;
}
/** A code that is in the lobby's registry — the retention rule's own question, asked of the real map. */
const kept = (srv, code) => srv.lobby.getRoom(code);
const seatIds = (state) => state.seats.filter(Boolean).map((s) => s.playerId);

/**
 * Create a co-op room that declares the pack, seat every player, start one match and drive it to its end.
 * @param {any} srv @param {any[]} players
 * @returns {Promise<{ code: string, state: any }>} the code of the retained room and its post-match `room.state`
 */
async function playOneMatch(srv, players) {
  const host = players[0];
  await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'HARD', mods: digest, modIds: ['keep-pack'] });
  const created = await host.waitFor('room.state', (s) => s.code && s.mods);
  for (const p of players.slice(1)) await ok(p, { t: 'room.join', code: created.code, mods: digest });
  for (const p of players) await p.waitFor('room.state', (s) => s.code === created.code && s.seats.filter(Boolean).length === players.length);
  // room.start needs every OTHER human connected and ready; the host's own start counts as its ready
  for (const p of players.slice(1)) await ok(p, { t: 'room.ready', ready: true });
  await ok(host, { t: 'room.start' });
  await host.waitFor('room.state', (s) => s.code === created.code && s.inMatch === true);
  // the stub match ends as soon as every human confirms
  for (const p of players) await p.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
  for (const p of players) await ok(p, { t: 'g.infoReady' });
  const ended = await host.waitFor('room.state', (s) => s.code === created.code && s.inMatch === false, 5000);
  return { code: created.code, state: ended };
}

test('a match ending KEEPS the room: same code, same members, same mod set, playable again', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    assert.ok(digest, 'the pack was loaded and has a digest');
    const { code, state } = await playOneMatch(srv, [a, b]);

    // the room is still in the registry, and `room.state` still names it
    const room = kept(srv, code);
    assert.ok(room, `the room survived the match (lobby.rooms has ${[...srv.lobby.rooms.keys()].join(',') || 'nothing'})`);
    assert.equal(srv.lobby.rooms.size, 1, 'exactly the one room');
    assert.equal(room.match, null, 'the match is gone');
    // …with ITS OWN mod set (W-B): the room's declared set must not be lost when the match ends. (This server carries
    // exactly one pack, so the room's set and the process set have the same digest — what matters is that the room
    // still holds the set it DECLARED, and that its digest is the one `modSetOf` computes from those packs.)
    assert.deepEqual(room.modIds, ['keep-pack']);
    assert.equal(room.modSet.digest, state.mods.digest, 'room.state still carries the room set after the match');
    assert.equal(room.modSet.digest, modSetOf(room.modSet.packs).digest, 'the room digest is recomputable from its packs');
    assert.deepEqual(state.mods.packs.map((p) => p.id), ['keep-pack']);
    // …its members, its difficulty and its option
    assert.deepEqual(seatIds(state), [a.id, b.id]);
    assert.equal(state.hostId, a.id);
    assert.equal(state.difficulty, 'HARD');
    assert.equal(state.aiPicksLast, false);
    assert.equal(room.matchCount, 1);
    assert.ok(room.lastSummary, 'the last match kept its summary');

    // the group starts another match without re-inviting anybody
    for (const p of [a, b]) await ok(p, { t: 'room.ready', ready: true });
    await ok(a, { t: 'room.start' });
    await a.waitFor('room.state', (s) => s.code === code && s.inMatch === true);
    for (const p of [a, b]) await p.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    for (const p of [a, b]) await ok(p, { t: 'g.infoReady' });
    const second = await a.waitFor('room.state', (s) => s.code === code && s.inMatch === false, 5000);
    assert.equal(srv.lobby.getRoom(code).matchCount, 2, 'the room counted both matches');
    assert.deepEqual(srv.lobby.getRoom(code).modIds, ['keep-pack'], 'the set is still there after the second match');
    assert.deepEqual(seatIds(second), [a.id, b.id], 'the same members are still seated');
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
    assert.ok(await until(() => srv.lobby.rooms.size === 0), 'the test left a room behind');
  }
});

test('the last human leaving reclaims the room (explicit room.leave) — the map drops it, nothing leaks', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    const { code } = await playOneMatch(srv, [a, b]);
    assert.ok(kept(srv, code), 'retained before anyone leaves');
    await ok(b, { t: 'room.leave' });
    assert.ok(kept(srv, code), 'one human is still in it: the room is kept');
    assert.equal(kept(srv, code).activeHumans().length, 1);
    await ok(a, { t: 'room.leave' });
    // the disposal is synchronous (removeMember → disposeRoom)
    assert.equal(kept(srv, code), null, 'the room is gone from the lobby map');
    assert.equal(srv.lobby.rooms.size, 0);
    assert.equal(srv.lobby.stats().rooms, 0);
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
  }
});

test('a disconnected last human is reclaimed by the lobby grace, not held for ever', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    const { code } = await playOneMatch(srv, [a, b]);
    assert.ok(kept(srv, code));
    // B leaves on purpose, A just drops: the retention rule must not turn into a leak
    await ok(b, { t: 'room.leave' });
    await a.terminate();
    assert.ok(kept(srv, code), 'the room waits for A to come back');
    assert.equal(kept(srv, code).activeHumans().length, 1, 'the seat is still there (no match is running)');
    assert.ok(await until(() => kept(srv, code) === null, 3000), 'the grace reclaimed the room');
    assert.equal(srv.lobby.rooms.size, 0);
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
  }
});

test('room.closed {empty} reaches a waiting spectator when the retained room is reclaimed', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  const watcher = await player(srv, 'Watcher');
  try {
    const { code } = await playOneMatch(srv, [a, b]);
    await ok(watcher, { t: 'room.spectate', code });
    await ok(a, { t: 'room.leave' });
    await ok(b, { t: 'room.leave' });
    const closed = await watcher.waitFor('room.closed', (m) => m.reason === 'empty');
    assert.equal(closed.reason, 'empty');
    assert.equal(kept(srv, code), null);
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
    await b.terminate();
    await watcher.terminate();
  }
});

test('a room that never had a match is reclaimed the moment its last human leaves, just the same', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  try {
    await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', mods: digest, modIds: ['keep-pack'] });
    const created = await a.waitFor('room.state', (s) => s.code);
    assert.ok(kept(srv, created.code));
    assert.equal(kept(srv, created.code).matchCount, 0, 'no match ran');
    await ok(a, { t: 'room.leave' });
    assert.equal(kept(srv, created.code), null, 'a room with no match is reclaimed just the same');
    assert.equal(srv.lobby.rooms.size, 0);
    assert.deepEqual(errors, []);
  } finally {
    await a.terminate();
  }
});

test('a non-host human can leave a retained room without tearing it down for the others', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  const c = await player(srv, 'C');
  const d = await player(srv, 'D');
  try {
    const { code } = await playOneMatch(srv, [a, b, c]);
    await ok(b, { t: 'room.leave' });
    const room = kept(srv, code);
    assert.ok(room, 'two humans remain');
    assert.equal(room.hostId, a.id, 'the host did not change');
    assert.deepEqual(room.seats.filter(Boolean).map((s) => s.playerId), [a.id, c.id], 'B\'s seat is free for someone else');
    const state = await c.waitFor('room.state', (s) => s.code === code && s.seats.filter(Boolean).length === 2);
    assert.equal(state.inMatch, false);
    assert.deepEqual(state.mods.packs.map((p) => p.id), ['keep-pack'], 'the room set survived the leave too');
    // the freed seat is a normal free seat: somebody else may take it
    await ok(d, { t: 'room.join', code, mods: digest });
    assert.equal(kept(srv, code).activeHumans().length, 3);
    await ok(d, { t: 'room.leave' });
    assert.deepEqual(errors, []);
  } finally {
    for (const c2 of [a, b, c, d]) await c2.terminate();
  }
});

test('the room is still there after the match for a reconnect: room.state and the result replay arrive', async () => {
  const srv = await server();
  const a = await player(srv, 'A');
  const b = await player(srv, 'B');
  try {
    const { code } = await playOneMatch(srv, [a, b]);
    const token = b.token;
    await b.terminate();
    const back = await player(srv, 'B', token);
    // a resumed member of a RETAINED room gets the room it is still in (not room.closed)
    const state = await back.waitFor('room.state', (s) => s.code === code);
    assert.equal(state.inMatch, false);
    assert.deepEqual(state.mods.packs.map((p) => p.id), ['keep-pack']);
    assert.ok(kept(srv, code), 'the room survived the reconnect');
    const replay = await back.waitFor('m.result', () => true, 1500).catch(() => null);
    assert.ok(replay, 'the result replay of the finished match is still owed to it');
    assert.deepEqual(errors, []);
    await back.terminate();
  } finally {
    await a.terminate();
    await b.terminate();
  }
});
