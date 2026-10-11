// test/helpers/wsClient.js — promise-based WebSocket test client for server tests.
//
// Every inbound JSON frame is appended to an inbox. `waitFor(type, predicate)` consumes the first matching
// frame already in the inbox or the next one to arrive (so there is no race between an action and the
// wait for its effect). `request(msg)` assigns a `rid` and resolves with the server's direct reply
// (`ok` / `error` / `welcome` / `pong` carrying that rid).
//
//   const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`);
//   const welcome = await c.hello('Doctor');
//   const reply = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
//   const state = await c.waitFor('room.state');
//   await c.close();
//
// `m.public` IS MATERIALIZED, exactly as the browser does it (DESIGN §8.2 "incremental frame"): the server sends a full
// frame first and one DELTA afterwards, and this client merges the deltas with the browser's own module
// (`public/js/matchDelta.js`), so a test that waits for `m.public` sees the complete view it always saw — never a patch.
// The RAW frames stay in `this.log` (and the materialized view in `this.public`), for the tests that judge the wire
// itself (test/match/public-delta*.test.js).

import WebSocket from 'ws';
import { applyPublic } from '../../public/js/matchDelta.js';
import { PROTOCOL_VERSION } from '../../shared/constants.js';

const REPLY_TYPES = new Set(['ok', 'error', 'welcome', 'pong']);
/** How many materialized `m.public` frames the client remembers (`publicFrames`). */
const PUBLIC_HISTORY = 500;

export class TestClient {
  /**
   * Open a socket and resolve once connected.
   * @param {string} url ws://host:port/ws
   * @param {{ timeout?: number, wsOptions?: object }} [opts] wsOptions are passed to `new WebSocket`
   * @returns {Promise<TestClient>}
   */
  static connect(url, { timeout = 3000, wsOptions = {} } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, wsOptions);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`connect timeout ${url}`)); }, timeout);
      ws.once('open', () => { clearTimeout(timer); resolve(new TestClient(ws)); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    /** @type {any[]} unconsumed frames */
    this.inbox = [];
    /** @type {any[]} every frame ever received (never consumed, never materialized) */
    this.log = [];
    /** @type {Record<string, any> | null} the materialized `m.public` view (deltas merged, like the browser) */
    this.public = null;
    /** @type {Record<string, any>} the latest materialized frame per type (`m.public` merged, the rest as received) */
    this.materialized = {};
    /**
     * The last `m.public` frames as MATERIALIZED (each one the view a browser held when it arrived; the most recent
     * `PUBLIC_HISTORY` are kept). This is what a test reads to ask "which phases / rows did this client see", and it
     * must not be `log` — that one holds the wire frames, deltas included. Each entry keeps the frame's own `serverNow`
     * (the engine clock travels on every frame; a resync's unicast frame is the one that carries none).
     * @type {any[]}
     */
    this.publicFrames = [];
    /** @type {any[]} `m.public` frames the merge refused (a delta with no baseline — the server's rules forbid it) */
    this.mergeRefusals = [];
    /** @type {{ match: (m: any) => boolean, resolve: Function }[]} */
    this.waiters = [];
    this.nextRid = 1;
    /** @type {{ code: number, reason: string } | null} */
    this.closeInfo = null;
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        resolve(this.closeInfo);
      });
    });
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this.log.push(msg);
      // `m.public` (and only it) is pushed to waiters in its MATERIALIZED form: see the header. A frame the merge
      // refuses (a delta with no baseline — which the server's own rules forbid) is dropped for the waiters, so a test
      // never asserts on a state the browser could not build; the raw frame stays in `this.log` either way.
      let out = msg;
      if (msg && msg.t === 'm.public') {
        const res = applyPublic(this.public, msg);
        if (res.ok) {
          this.public = res.state;
          this.materialized['m.public'] = res.state;
          // the frame a waiter sees is the MATERIALIZED view, except that it keeps this frame's own `serverNow` (a
          // delta carries the engine's clock even when nothing else changed, and tests pace the stream by it)
          out = { t: 'm.public', ...this.public, serverNow: msg.serverNow };
          this.publicFrames.push(out);
          if (this.publicFrames.length > PUBLIC_HISTORY) this.publicFrames.splice(0, this.publicFrames.length - PUBLIC_HISTORY);
        } else {
          this.mergeRefusals.push(msg);
        }
      } else if (msg && typeof msg.t === 'string') {
        this.materialized[msg.t] = msg;
      }
      const i = this.waiters.findIndex((w) => w.match(out));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(out);
      } else {
        this.inbox.push(out);
      }
    });
  }

  /** True while the socket is OPEN. */
  get isOpen() { return this.ws.readyState === WebSocket.OPEN; }

  /**
   * Send a message; assigns `rid` unless the message already has one (use `rid: null` to omit it).
   * @param {object} msg
   * @returns {number | undefined} the rid used
   */
  send(msg) {
    const out = { ...msg };
    if (out.rid === undefined) out.rid = this.nextRid++;
    if (out.rid === null) delete out.rid;
    this.ws.send(JSON.stringify(out));
    return out.rid;
  }

  /** Send a raw frame (string or Buffer). @param {string | Buffer} data @param {{ binary?: boolean }} [opts] */
  sendRaw(data, { binary = false } = {}) {
    this.ws.send(data, { binary });
  }

  /**
   * Wait for a frame of `type` (or any type when null) matching `predicate`.
   * @param {string | null} type
   * @param {(m: any) => boolean} [predicate]
   * @param {number} [timeout] ms
   * @returns {Promise<any>}
   */
  waitFor(type, predicate = () => true, timeout = 2000) {
    const match = (m) => (type == null || m.t === type) && predicate(m);
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        const k = this.waiters.indexOf(waiter);
        if (k >= 0) this.waiters.splice(k, 1);
        const recent = this.log.slice(-8).map((m) => m.t + (m.code ? `:${m.code}` : '')).join(', ');
        reject(new Error(`timeout waiting for ${type ?? 'any'} (recent: ${recent || 'none'})`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  /**
   * Resolve after `ms` if no matching frame arrived (and none is in the inbox); reject otherwise.
   * @param {string | null} type @param {(m: any) => boolean} [predicate] @param {number} [ms]
   */
  async expectNone(type, predicate = () => true, ms = 150) {
    const got = await this.waitFor(type, predicate, ms).catch(() => null);
    if (got) throw new Error(`unexpected ${got.t}: ${JSON.stringify(got).slice(0, 200)}`);
  }

  /**
   * Send with a fresh rid and wait for the direct reply (ok / error / welcome / pong with that rid).
   * @param {object} msg @param {number} [timeout]
   * @returns {Promise<any>}
   */
  request(msg, timeout = 2000) {
    const rid = this.send({ ...msg, rid: this.nextRid++ });
    return this.waitFor(null, (m) => REPLY_TYPES.has(m.t) && m.rid === rid, timeout);
  }

  /**
   * Say hello and resolve with the `welcome` frame (rejects on `error`).
   * @param {string} name @param {string} [token] @param {object} [extra]
   */
  async hello(name, token, extra = {}) {
    // the CURRENT wire format, not a literal: a test client must be a client of this build, so a deliberate
    // PROTOCOL_VERSION bump (DESIGN §8.2.1) cannot leave the suites handshaking with a stale page's number
    const reply = await this.request({ t: 'hello', name, version: PROTOCOL_VERSION, ...(token ? { token } : {}), ...extra });
    if (reply.t !== 'welcome') throw new Error(`hello failed: ${JSON.stringify(reply)}`);
    return reply;
  }

  /** Drop every unconsumed frame. */
  clearInbox() { this.inbox.length = 0; }

  /**
   * The latest MATERIALIZED state of a frame type: for `m.public` the merged view a browser would hold (never a delta),
   * for anything else the last frame received. The non-consuming counterpart of `waitFor` — use it to poll a state.
   * @param {string} type @returns {any | null}
   */
  stateOf(type) { return this.materialized[type] ?? null; }

  /** Close gracefully and wait for the close event. */
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return this.closeInfo;
    this.ws.close();
    return this.closed;
  }

  /** Kill the TCP connection without a close handshake (simulates a network drop). */
  async terminate() {
    this.ws.terminate();
    return this.closed;
  }
}

/**
 * Connect and say hello in one step.
 * @param {string} url @param {string} name @param {string} [token]
 * @returns {Promise<{ client: TestClient, welcome: any }>}
 */
export async function connectAs(url, name, token) {
  const client = await TestClient.connect(url);
  const welcome = await client.hello(name, token);
  return { client, welcome };
}
