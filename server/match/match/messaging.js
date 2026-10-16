// server/match/match/messaging.js — Match methods: messaging — unicast, broadcast, toasts, the ticker lines
// (config.broadcasts by type; the remake's CUSTOM lines), the dirty marks and flush: m.private per player only when it
// changed (plus the prep scouts of that player's board), m.public throttled (DELAYS.PUBLIC_THROTTLE) and deduplicated.
// i18n (docs/I18N.md): a toast / CUSTOM line is a string (its own msgid) or a shared/i18n.js msg(msgid, params); the frame
// carries `text` (the Chinese rendering, what older clients show) plus `msgid` / `params`; a broadcast line carries its
// `args` so the client can fill the localized config.broadcasts template.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { DELAYS, PUBLIC_FULL_EVERY } from './common.js';
import { wireMessage } from '../../../shared/i18n.js';
import { publicDelta, publicBaseline, isEmptyDelta } from '../../viewsDelta.js';

export class MatchMessaging {
  sendTo(playerId, msg) {
    if (this.disposed) return false;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return false;
    try { return !!this.sendFn(playerId, msg); } catch (e) { this.reportError('send', e); return false; }
  }

  broadcast(msg) {
    if (this.disposed) return;
    try { this.broadcastFn(msg); } catch (e) { this.reportError('broadcast', e); }
  }

  /** @param {string|{ msgid: string, params?: object }} text a string or msg() (shared/i18n.js) */
  toast(ps, kind, text) {
    if (!ps || ps.isBot || ps.left || !ps.connected) return;
    this.sendTo(ps.playerId, { t: 'm.toast', kind, ...wireMessage(text) });
  }

  /** Broadcast ticker from config.broadcasts by type; `param` picks the variant (SHOP_LEVEL level, BOSS_HIT share…). */
  tickerFor(type, args = [], { playerId = null, to = null, param = null } = {}) {
    const list = Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts.filter((b) => b && b.type === type) : [];
    let b = list[0];
    if (param != null) b = list.find((x) => Array.isArray(x.params) && x.params.includes(String(param))) || b;
    const tpl = b && typeof b.text === 'string' ? b.text : null;
    if (!tpl) return;
    const text = tpl.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] != null ? String(args[Number(i)]) : ''));
    const msg = { t: 'm.ticker', text, id: b.id, type, priority: Number(b.priority) || 0, playerId, args: args.map((a) => String(a ?? '')) };
    if (to) this.sendTo(to, msg);
    else this.broadcast(msg);
  }

  /**
   * A ticker line of the remake's own (type CUSTOM). `priority`: the match-flow notices (隐秘核心已解锁, 联防阶段, a player out
   * or gone) take FLOW_TICKER_PRIORITY so the strip does not hold them behind shop-level lines; other lines 0.
   */
  tickerText(text, priority = 0) {
    if (!text) return;
    const w = wireMessage(text);
    this.broadcast({ t: 'm.ticker', ...w, text: w.text.slice(0, 200), id: null, type: 'CUSTOM', priority: Number(priority) || 0, playerId: null });
  }

  markPublic() { this._pubDirty = true; }

  /**
   * The NEXT m.public frame goes out in its FULL form (DESIGN §8.2, incremental frame). Called on everything that can
   * make a client's materialized state unusable: a seat joining / leaving / coming back (a resync sends that one human a
   * full frame, but the ROOM must stay on one baseline for all of them), a broadcast the sockets did not all take, and
   * the periodic keepalive (PUBLIC_FULL_EVERY frames) that bounds any divergence a dropped or mis-merged delta could
   * have started. Cheap: it only sets a flag.
   */
  markPublicFull() { this._pubFull = true; }

  /**
   * A member of the room changed (joined, left, dropped, came back): the next m.public is full, so every client's
   * baseline is one frame the whole room shares again.
   */
  markMembershipChanged() {
    this.markPublicFull();
    this.markPublic();
  }

  /**
   * A player's state changed: its m.private and (throttled, deduplicated) m.public (level, board, bonds…) — in a boss
   * round's prep also its pair partner's m.private, which shows this board on its other half (bossMate, item 51).
   */
  markPrivate(ps) {
    if (!ps) return;
    this._privDirty.add(ps);
    this._pubDirty = true;
    const m = this._bossMateOf(ps);
    if (m) this._privDirty.add(m.mate);
  }

  /** Send pending m.private (per player, only when changed) and m.public (throttled ≤ 10/s). */
  flush(forcePublic = false) {
    if (this.disposed) return;
    if (this._privDirty.size) {
      const list = [...this._privDirty];
      this._privDirty.clear();
      for (const ps of list) {
        if (!(ps.isBot || ps.left || !ps.connected)) this._sendPrivate(ps, false);
        this._notifyPrepScouts(ps);
      }
    }
    if (this._pubDirty || forcePublic) this._maybeSendPublic(forcePublic);
  }

  _sendPrivate(ps, force) {
    let view;
    try { view = ps.privateView(); } catch (e) { this.reportError('privateView', e); return; }
    const json = JSON.stringify(view);
    if (!force && json === ps._lastPriv) return;
    ps._lastPriv = json;
    this.sendTo(ps.playerId, view);
  }

  /**
   * m.public, throttled ≤ 10/s (DELAYS.PUBLIC_THROTTLE) and deduplicated — and, since the 40-seat load work, sent as an
   * INCREMENTAL frame (DESIGN §8.2 "incremental frame", server/viewsDelta.js): a full frame when the room has no shared
   * baseline yet or a member changed (`_pubFull`), a pure field-level diff otherwise.
   *
   * The ROOM SHARES ONE BASELINE by design: a match frame is encoded once and fanned out (lobby.broadcastRoom), so every
   * recipient's materialized state advances by the same patch. That is why a new member, a reconnect or a dropped
   * delivery makes the next frame full for the whole room (`markMembershipChanged`, and the lobby's broadcast hook that
   * calls it when a frame did not reach every socket) rather than for the one client that lagged — the alternative would
   * be N different frames per tick, the cost this replaces. `_pubPrev` is that one baseline: the full view the clients
   * are believed to hold. A recipient whose own state got off this baseline (it asked with `g.publicFull`) is answered
   * with a unicast full frame; the room's baseline is untouched (`_sendFullPublic`), so the room-wide stream stays
   * self-consistent.
   *
   * `_lastPubJson` (the legacy full-frame dedup) is still maintained in the full path, so a repeat frame that changed
   * nothing is still dropped.
   *
   * SAFE DEGRADATION (the pack contract, docs/design/network.md §8.2.1): the diff is *asked*, never trusted. A view it
   * cannot express as a patch — a top-level key the room's baseline never carried (a pack added `econ`), a cycle, a
   * `BigInt`, a `Map` — answers `ok: false` or throws, and both land on the FULL frame for the whole room, with the
   * reason logged (`public delta` / `public`). A pack key therefore reaches every client on the very frame it appears,
   * and from the full frame on it is part of the baseline and diffs like any other key.
   */
  _maybeSendPublic(force) {
    const now = this.sched.now();
    if (!force && now - this._lastPubAt < DELAYS.PUBLIC_THROTTLE) {
      if (!this._pubTimer) {
        const wait = Math.max(1, DELAYS.PUBLIC_THROTTLE - (now - this._lastPubAt));
        this._pubTimer = this.sched.setTimeout(() => {
          this._pubTimer = null;
          if (this.disposed) return;
          try { this._maybeSendPublic(false); } catch (e) { this.reportError('public', e); }
        }, wait);
      }
      return;
    }
    this._pubDirty = false;
    let full;
    try { full = this.publicView(); } catch (e) { this.reportError('publicView', e); return; }
    // The frame this tick GOES OUT, whatever the view is made of. `publicView()` is a workshop pack's too (DESIGN §28.14
    // `matchClass`), so its return value is not under this file's control: it may carry a cycle, a `BigInt`, a `Map`, a
    // function — none of them JSON, all of them `JSON.stringify` throws on. The whole dedup/diff block is therefore
    // guarded, and a throw degrades to the FULL frame (still sent) instead of costing the tick's frame entirely
    // (the frame used to be swallowed by `reportError('public', e)`, so neither the delta NOR the full frame went out and
    // that tick's state was permanently missed — the client stayed divergent until the keepalive).
    let json = null;
    let sendFull = this._pubFull || this._pubPrev == null;
    let frame = full;
    try {
      const { serverNow: _serverNow, ...rest } = full;
      json = JSON.stringify(rest);      // also the dedup key of the full path: a repeat frame is dropped
      if (!force && sendFull && json === this._lastPubJson) return;   // nothing changed: no frame at all
      if (!sendFull) {
        const res = publicDelta(this._pubPrev, full);
        // `ok: false` = the view cannot be expressed as a patch of the room's baseline (a pack added a top-level key,
        // or a value JSON cannot carry). Fall back to the full frame rather than dropping what it carried.
        if (res.ok === false) {
          this.reportError('public delta', new Error(res.why || 'not diffable'));
          this.markPublicFull();
        } else if (isEmptyDelta(res.frame)) {
          return;                                                     // a dirty mark without a real change: no frame
        } else {
          frame = res.frame;
          this._pubPrev = res.next;
        }
      }
    } catch (e) {
      this.reportError('public', e);
      this.markPublicFull();
    }
    sendFull = frame === full;            // a refused delta, a throw, or a dirty `_pubFull` all land on the full frame
    if (sendFull) {
      try { this._pubPrev = publicBaseline(full); } catch (e) { this.reportError('public baseline', e); this._pubPrev = null; }
      this._pubFull = false;
      this._pubFrames = 0;
    }
    try { this._lastPubJson = json != null ? json : JSON.stringify(full); } catch { this._lastPubJson = null; }
    // Snapshot building / serialization can take time; throttle from the actual broadcast, not its start.
    this._lastPubAt = this.sched.now();
    // the engine's clock rides EVERY frame (the client's clock sync reads it), and it is not part of the diffed state:
    // a delta carries it explicitly, since `publicDelta` never puts `serverNow` in the patch
    frame.serverNow = full.serverNow;
    this.broadcast(frame);
    // self-healing keepalive (DESIGN §8.2): every PUBLIC_FULL_EVERY frames the next one is full, which bounds any
    // divergence a lost or mis-merged delta could have started, without the client having to notice anything
    if (!sendFull && ++this._pubFrames >= PUBLIC_FULL_EVERY) this.markPublicFull();
  }

  /**
   * Unicast a FULL m.public to one member (a reconnect / resync, a spectator joining, or its own `g.publicFull` ask) and
   * move that member onto the room's baseline. The room's baseline object is left alone: this client now holds the same
   * state as everybody else, so the next broadcast patch fits it too.
   */
  _sendFullPublic(ps) {
    if (!ps || ps.isBot || ps.left) return false;
    const full = this.publicView();
    return this.sendTo(ps.playerId, full);
  }
}

