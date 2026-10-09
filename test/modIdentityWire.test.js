// test/modIdentityWire.test.js — the mod identity as it actually travels (DESIGN §28.2, §28.9).
//
// The point of an identity is that every surface quotes the SAME string: `welcome` (what the client is told on connect),
// `/healthz` (what a bug report can cite) and the BattleSpec (what THIS field ran with). If any two of them disagree,
// the identity is decoration. The second half is the gate: on a server that runs packs, entering a room requires the
// client to say which content it thinks it is joining, and a client that cannot answer is refused with a reason it can
// act on — never let in silently (docs/PACKS.md:135-136, DESIGN §28.4).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { buildBattleSpec } from '../server/sim/spec.js';
import { modSetOf } from '../shared/modIdentity.js';
import { validateC2S, C2S } from '../shared/protocol.js';
import { TestClient } from './helpers/wsClient.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A minimal pack: one new operator record, no code (layer A). */
function writePack(root, id, name) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name, version: '0.1.0', content: ['chess'], overrides: [] }));
  const chessId = `chess_ws_${id.replace(/-/g, '_')}_a`;
  fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify({ [chessId]: { chessId, baseId: chessId, goldenId: null, isGolden: false, visible: true, tier: 5, profession: 'WARRIOR', position: 'MELEE', rangeGrid: [[0, 0]], stats: { maxHp: 2000, atk: 500, def: 200, res: 0, cost: 18, blockCnt: 2, bat: 1.2 }, talents: [], bonds: [] } }));
  return chessId;
}

/** The WebSocket URL of a started server: the upgrade lives at /ws (server/http/websocket.js). */
const wsUrl = (srv) => `ws://127.0.0.1:${srv.port}/ws`;

function get(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

let tmp;
let modded;
let vanilla;
let digest;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modid-'));
  const root = path.join(tmp, 'workshop');
  fs.mkdirSync(root, { recursive: true });
  writePack(root, 'alpha-pack', 'Alpha');
  writePack(root, 'zeta-pack', 'Zeta');
  fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
  modded = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
  vanilla = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: path.join(tmp, 'empty') });
  digest = modSetOf(loadWorkshop(root, { log: quiet }).packs
    .map((p) => ({ id: p.id, hash: p.hash, layer: p.layer, combat: p.combat, api: p.api }))).digest;
});
after(async () => {
  await modded?.close();
  await vanilla?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mod identity on the wire: welcome, /healthz and the spec quote one digest', () => {
  test('/healthz names the mod set a bug report can cite', async () => {
    const body = JSON.parse((await get(modded.port, '/healthz')).body);
    assert.equal(body.mods, digest);
    assert.equal(body.modPacks, 2);
    // a plain install has no `mods` key at all — not an empty object, not a null
    const plain = JSON.parse((await get(vanilla.port, '/healthz')).body);
    assert.equal('mods' in plain, false);
    assert.equal('modPacks' in plain, false);
  });

  test('welcome carries the same digest, and the client can re-derive it from the list it is given', async () => {
    const c = await TestClient.connect(wsUrl(modded));
    try {
      const w = await c.hello('ModWire');
      assert.ok(w.mods, JSON.stringify(w).slice(0, 200));
      assert.equal(w.mods.digest, digest);
      assert.deepEqual(w.mods.packs.map((p) => p.id), ['alpha-pack', 'zeta-pack'], 'the list is sorted by pack id');
      // the client recomputes the digest from the list: pure JS, no server round trip (shared/modIdentity.js)
      assert.equal(modSetOf(w.mods.packs).digest, w.mods.digest);
    } finally {
      await c.terminate();
    }
  });
});

describe('mod identity: entering a modded room needs the client to confirm the content', () => {
  test('no digest, or the wrong one, is refused with a reason that names the packs', async () => {
    const c = await TestClient.connect(wsUrl(modded));
    try {
      await c.hello('ModGate');
      const missing = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
      assert.equal(missing.t, 'error', JSON.stringify(missing));
      assert.match(String(missing.detail), /alpha-pack/, 'the refusal says WHAT is running (error.detail)');
      const wrong = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: 'deadbeefdeadbeef' });
      assert.equal(wrong.t, 'error');
      assert.match(String(wrong.detail), /different mod set/);
      const ok = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL', mods: digest });
      assert.equal(ok.t, 'ok', JSON.stringify(ok));
    } finally {
      await c.terminate();
    }
  });

  test('a plain install still lets a client in without saying anything (the default must not change)', async () => {
    const c = await TestClient.connect(wsUrl(vanilla));
    try {
      const w = await c.hello('ModPlain');
      assert.equal(w.mods, undefined);
      const r = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
      assert.equal(r.t, 'ok', JSON.stringify(r));
    } finally {
      await c.terminate();
    }
  });

  test('the protocol accepts the field as optional and refuses a malformed one', () => {
    assert.equal(validateC2S({ t: 'room.join', code: 'ABCD' }), null, 'an old client that sends nothing is still valid');
    assert.equal(validateC2S({ t: 'room.join', code: 'ABCD', mods: digest }), null);
    assert.equal(validateC2S({ t: 'room.join', code: 'ABCD', mods: 'nope' }), 'bad field mods');
    assert.equal(validateC2S({ t: 'room.join', code: 'ABCD', mods: 42 }), 'bad field mods');
    assert.deepEqual(C2S['room.join'].$optional, ['mods']);
    // W-A (DESIGN §28.9): `room.create` gained `modIds` — the packs a ROOM declares, a subset of what this server
    // loaded. `room.join` deliberately did not: a room set is the host's to declare, never a joiner's.
    assert.deepEqual(C2S['room.create'].$optional, ['mods', 'modIds']);
  });
});

describe('mod identity: the BattleSpec carries the content the field ran with', () => {
  test('spec.mods is the same digest, and every kit module carries its pack hash', () => {
    const set = modSetOf([{ id: 'alpha-pack', hash: 'a'.repeat(64), layer: 'B', combat: true }]);
    const spec = buildBattleSpec({
      seed: 1, kind: 'normal', mods: set,
      workshopKits: [{ id: 'chess_ws_x_a', pack: 'alpha-pack', hash: 'a'.repeat(64), url: '/workshop-kits/alpha-pack/chess_ws_x_a.js?v=1' }],
    });
    assert.equal(spec.mods.digest, set.digest);
    assert.deepEqual(spec.mods.packs.map((p) => p.id), ['alpha-pack']);
    assert.equal(spec.workshopKits[0].hash, 'a'.repeat(64), 'the spec says WHICH bytes the URL should serve');
    // a plain install: no mods, no modules, and the field is explicitly null rather than missing
    const plain = buildBattleSpec({ seed: 1, kind: 'normal' });
    assert.equal(plain.mods, null);
    assert.deepEqual(plain.workshopKits, []);
  });
});
