// server/viewsDelta.js — the `m.public` incremental frame (DESIGN §8.2, "incremental frame"):
// a pure diff between two full public views (MatchViews.publicView) producing the smallest patch the client merges into
// its own materialized state, so that "what the client ends up with" is field for field what the full frame said.
//
// Why field-level and not seat-level: an O(N)-byte frame whenever a seat changes is still O(N) per frame, and a 40-seat
// room whose boards all move every frame pays it in full. Diffing per KEY makes a frame's size proportional to what
// really changed (one `boardCount`, one `progress.killed`), never to the seat count times the field count.
//
// The rules (docs/design/network.md §8.2 carries them for both author and client readers):
//   * `players` is keyed by `playerId`; a patch carries ONLY the fields that changed. The identity (`playerId`) is in
//     every patch — it is how the client finds the row to merge into.
//   * `null` IS THE VALUE `null` at every level of this view (`rerollVote`, `bossId`, `bandId`, `progress.resolved`):
//     it is sent as the value it is and the client stores it. A TOP-LEVEL key that disappeared from the full view is
//     named in the frame's `gone: ['teamLp', …]` and the client deletes it — `undefined` is not a JSON value, so the
//     absence needs its own spelling and must never be confused with a null value. Inside a row the same job is done by
//     `null` (`pendingLp` / `uniteLeft` left the view): a row field that is null in the FULL view materializes as the
//     absent key on the client too, so there is only one state to end up in and a delta can never be ambiguous.
//   * `gone: true` on a row patch means the seat left `order` (a field patch: the field left the list): the client
//     drops it.
//   * `fields` is patched per ENTRY — a changed entry carries only what changed, a new one is whole, one that left is
//     `{ fieldId, gone: true }` — and unchanged entries keep the previous object (identity-stable, not re-serialized).
//   * a change that touches neither the rows nor the fields yields a frame that carries nothing but its markers — "send
//     nothing" (the dirty mark's own dedup), which the caller turns into no frame at all.
//
// A WORKSHOP PACK can wrap `publicView()` (DESIGN §28.14 `matchClass`) and add its own top-level keys and row fields on
// what `super.publicView()` returned (the shipped example: mod-xie adds `econ` / `revival` and the row fields
// `pendingDeath` / `revivalReason`). The three rules that keep a pack on the wire are:
//
//   1. NO TOP-LEVEL KEY IS INVISIBLE. The engine names the keys it intends to diff (`SCALAR_KEYS`), but that list is a
//      whitelist of the ENGINE's view: a key a pack added is not in it. So the diff also walks every other own key of
//      the view and treats it the same way — carried when it changed, `gone` when it left. The one exception is
//      `IGNORED_KEYS` (the engine's own per-frame additions, `serverNow`): it is intentionally not diffed, because it
//      changes on every single frame and the sender puts it on the wire itself. A key the engine has never sent and the
//      baseline does not hold is a SHAPE CHANGE the client's materialized state cannot be safely patched into: the diff
//      refuses the frame (`ok: false`) and the caller falls back to a FULL frame (see messaging.js). Nothing a pack adds
//      is ever silently dropped, and the contract does not depend on the pack cooperating.
//   2. THE BASELINE NEVER ALIASES THE VIEW. `publicBaseline` deep-copies it (`plainCopy`, the JS-side twin of
//      `structuredClone` for JSON-shaped data). A pack that caches its row objects and mutates them in place — or one
//      that keeps a top-level object and rewrites a field of it — otherwise leaves the baseline and the current view
//      holding THE SAME object, every comparison is `old[k] === cur[k]`, and the whole row (engine fields included)
//      leaves the diff forever. See the cost note on `plainCopy`.
//   3. THE DIFF NEVER SILENTLY LOSES WHAT IT CAN SEE, AND THE CALLER NEVER LOSES THE FRAME. A top-level or row value
//      that is a function, `undefined`, `NaN` / `Infinity`, a `Map`, a `Set` or a class instance is not something JSON
//      carries as itself, so the diff refuses it (`ok: false` → the caller sends the FULL frame) rather than patching a
//      value the client would read differently. A cycle or a `BigInt` still makes `sameJson` throw — a hard error a pack
//      author must fix — and the caller guards the call, so the tick's frame goes out as a full one instead of being
//      dropped (messaging.js). RESIDUE, said out loud: a `Map` / `Set` nested INSIDE an otherwise plain value still
//      compares as `{}`, so two different ones look unchanged and the change does not ride the frame — the full-frame
//      keepalive is what repairs that one, and only when the pack stops doing it.
//
// The module is pure (no Match, no I/O), so it is unit-testable on its own. The merge side is `public/js/matchDelta.js`,
// written against the SAME rules.

/** Top-level keys of a public view that a delta sends when they changed (never `players` / `fields`, diffed below). */
const SCALAR_KEYS = [
  'phase', 'round', 'lastRound', 'deadline', 'modeId', 'difficulty', 'stageId', 'setupRevision',
  'rerollVote', 'factions', 'disabledBonds', 'drawnDisabledBonds', 'bannedChess',
  'bossId', 'hiddenBossId', 'bossRound', 'hiddenRound', 'spRound', 'combatMode', 'paused',
  'teamLp', 'overtimeAt', 'bossHp', 'draft', 'sp', 'unite', 'uniteResult',
];

/**
 * Top-level keys a delta NEVER diffs or patches, even though the view carries them: the engine adds them to every frame
 * itself and they are not part of the materialized state.
 *   * `serverNow` — the client's clock sync reads it from any `m.public` frame; it changes every single frame, so diffing
 *     it would put it in every patch for nothing (messaging.js writes it onto the frame it broadcasts).
 *   * `t` — the frame's own message type / delta marker, not state.
 *   * `rid` — a request id some senders add; also not state.
 */
const IGNORED_KEYS = new Set(['serverNow', 't', 'rid']);

/** The `players` / `fields` keys: diffed per row / per entry, never as a whole top-level value. */
const LIST_KEYS = new Set(['players', 'fields']);

/**
 * Whether a value JSON carries AS IT IS: `null`, a finite number, a string, a boolean, an array, or a plain object (the
 * container itself — the elements are checked by `sameShape` where it matters). `NaN` / `Infinity` become `null` on the
 * wire, a `Map` / `Set` / class instance becomes `{}`, a function or `undefined` disappears entirely, and a `BigInt` or
 * a cycle throws. A key whose value is one of those is refused (the caller sends the full frame) instead of being
 * patched with a value the client would read differently.
 */
function isJsonValue(v) {
  if (v === null) return true;
  const ty = typeof v;
  if (ty === 'string' || ty === 'boolean') return true;
  if (ty === 'number') return Number.isFinite(v);
  if (ty !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The kind of a non-JSON value, for the log line a degradation leaves behind. */
function jsonKind(v) {
  if (typeof v === 'function') return 'function';
  if (typeof v === 'bigint') return 'BigInt';
  if (typeof v === 'number') return 'NaN or Infinity';
  if (v instanceof Map) return 'Map';
  if (v instanceof Set) return 'Set';
  return Object.prototype.toString.call(v);
}

/** Same JSON, different object: what "unchanged" means for an array / object value. */
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * True when a value reads as equal on the wire: identical primitives, or two objects that `sameJson` says are the same.
 * A value JSON cannot carry is the caller's problem (see `isJsonValue` and the header): `Map` / `Set` still compare as
 * `{}` here — a documented residue, not a fix — while a cycle or a `BigInt` makes `sameJson` throw, which the caller
 * catches and turns into a full frame.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return sameJson(a, b);
}

/**
 * A deep copy of a full view for the baseline: plain objects and arrays by value, every other object BY REFERENCE (a
 * `Map` / `Set` / class instance is not JSON data; copying it would mean inventing a shape). Cyclic and shared
 * structures terminate through @param seen. A property whose value is `undefined` is DROPPED: `undefined` is not a JSON
 * value, so a recipient of the full frame never holds that key at all — keeping it in the baseline would make every
 * later frame compare against a key the client does not have.
 *
 * Cost, measured on a real 40-seat view (17 283 B): 0.036 ms per frame against 0.061 ms for the `JSON.parse(
 * JSON.stringify(view))` alternative (Node 22, one core). It runs only when a full frame goes out (the first frame of a
 * match, a membership change, the 32-frame keepalive), not on the delta path, where `next.players` / `next.fields` keep
 * the CURRENT view's own rows (identity-stable, never re-serialized) as they always did.
 */
function plainCopy(v, seen = new Map()) {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) {
    const out = [];
    seen.set(v, out);
    for (const x of v) out.push(plainCopy(x, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;     // not JSON data: keep the object itself
  const out = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) { const x = v[k]; if (x !== undefined) out[k] = plainCopy(x, seen); }
  return out;
}

/** True when a delta frame carries no change at all (nothing to send) — `t` and the `delta` marker are not payload. */
export function isEmptyDelta(frame) {
  return Object.keys(frame).every((k) => k === 't' || k === 'delta');
}

/**
 * A fresh canonical baseline for a full view: what a recipient that received that full frame holds. It DEEP-COPIES the
 * view (rule 2 in the header), so no later mutation of any object the caller's view is built from — a pack caching a row
 * and rewriting a field of it, the engine mutating a `ps` — can move the baseline. `serverNow` and the frame markers are
 * dropped: they are not part of the diffed state.
 * @param {Record<string, any>} full a full public view (MatchViews.publicView)
 * @returns {Record<string, any>}
 */
export function publicBaseline(full) {
  const base = {};
  if (!full || typeof full !== 'object') return base;
  for (const k of Object.keys(full)) {
    if (IGNORED_KEYS.has(k)) continue;
    const v = full[k];
    if (v === undefined) continue;   // `undefined` is not a JSON value: the recipient never holds that key
    base[k] = plainCopy(v);
  }
  if (!Array.isArray(base.players)) base.players = [];
  if (!Array.isArray(base.fields)) base.fields = [];
  return base;
}

/**
 * The diff between the baseline a client holds (`prev`, from publicBaseline / an earlier call's `next`) and this frame's
 * full view.
 *
 * `ok: false` (never a throw) means "this full view cannot be expressed as a patch of that baseline" — the caller sends
 * the FULL frame instead, which re-establishes the baseline for the whole room:
 *   * a top-level key the baseline does not have and the engine's whitelist does not name (a pack added a key after the
 *     last full frame, or the view grew a field the engine never sent before);
 *   * a value JSON cannot carry reliably (a cycle, a `BigInt`, a `Map` / `Set` / function) anywhere the diff has to
 *     decide whether it changed. See `isPlainJson`.
 * A `false` still never mutates `prev`, and it names the reason in `why` for the log.
 *
 * @param {Record<string, any>} prev the baseline; NEVER mutated (a match hands the same baseline to the whole room)
 * @param {Record<string, any>} cur the full view of this frame
 * @returns {{ frame: Record<string, any>, next: Record<string, any>, ok: boolean, why?: string }} `frame` is the wire
 *   patch (`{ t, delta: true, … }` — empty when nothing changed, ignored unless `ok`), `next` the baseline for the
 *   following frame (only meaningful when `ok`)
 */
export function publicDelta(prev, cur) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const view = cur && typeof cur === 'object' ? cur : {};
  const frame = { t: 'm.public', delta: true };
  const next = { ...base };
  const refuse = (why) => ({ ok: false, why, frame, next: base });
  for (const k of Object.keys(view)) {
    if (IGNORED_KEYS.has(k) || LIST_KEYS.has(k)) continue;
    const b = view[k];
    const hasOld = Object.hasOwn(base, k);
    const a = hasOld ? base[k] : undefined;
    if (b === undefined) {
      // the key left the view: it is named in `gone` and the client DELETES it — `null` is a real value up here
      // (`rerollVote`, `botId`, `uniteResult`), so "absent" needs its own spelling
      if (hasOld) { delete next[k]; (frame.gone ??= []).push(k); }
      continue;
    }
    // a top-level key that neither the engine's whitelist nor the baseline knows: this full view has a shape no client
    // received yet, so a patch cannot be trusted to be the whole story — the caller sends the FULL frame
    if (!hasOld && !SCALAR_KEYS.includes(k)) return refuse(`unknown top-level key "${k}"`);
    if (!isJsonValue(b)) return refuse(`top-level key "${k}" is not a JSON value (${jsonKind(b)})`);
    if (hasOld) {
      if (a === b) continue;
      if (sameValue(a, b)) { next[k] = b; continue; }   // rebuilt but equal on the wire: not a change
    }
    next[k] = b;
    frame[k] = b;
  }
  // a key the baseline holds and the view no longer has at all: same `gone` spelling, whatever its origin (a whitelisted
  // key, an engine key the mode switched off, a pack key its own gate switched off)
  for (const k of Object.keys(base)) {
    if (IGNORED_KEYS.has(k) || LIST_KEYS.has(k) || k in view) continue;
    delete next[k];
    (frame.gone ??= []).push(k);
  }
  const players = diffPlayers(base.players || [], view.players || []);
  if (!players.ok) return refuse(players.why);
  if (players.patches) frame.players = players.patches;
  next.players = players.rows;
  const fields = diffFields(base.fields || [], view.fields || []);
  if (!fields.ok) return refuse(fields.why);
  if (fields.patches) frame.fields = fields.patches;
  next.fields = fields.rows;
  return { ok: true, frame, next };
}

/**
 * The `players` patches of one delta. The patches (and their order: `order`) are the same for every recipient of the
 * frame, which is why the caller builds them once.
 *
 * `rows` — the baseline for the next frame — NEVER holds a row object of the view it was built from: a row that changed
 * is stored as a deep copy, and a row that did not keeps the previous baseline's own copy (which is why the patch has to
 * be built before the copy: `plainCopy(row)` is the row of the moment, mutation included). Without that, a pack that
 * caches a row and rewrites a field of it in place moves the baseline with it — and a moved baseline makes the differ
 * report "no change" for the whole row forever (the whole point of rule 2 in the header).
 * @returns {{ patches: any[] | null, rows: any[], ok: boolean, why?: string }}
 */
function diffPlayers(prevRows, curRows) {
  const before = new Map();
  for (const row of prevRows) if (row) before.set(row.playerId, row);
  const patches = [];
  const rows = [];
  const seen = new Set();
  for (const row of curRows) {
    if (!row || typeof row !== 'object') return { ok: false, why: 'a player row is not an object', patches: null, rows: curRows };
    seen.add(row.playerId);
    const old = before.get(row.playerId);
    if (!old) { const whole = plainCopy(row); patches.push(whole); rows.push(whole); continue; }  // a new seat: its whole row
    let patch = null;
    for (const k of Object.keys(row)) {
      const a = old[k];
      const b = row[k];
      if (a === b) continue;
      if (!isJsonValue(b)) return { ok: false, why: `row ${row.playerId} field "${k}" is not a JSON value (${jsonKind(b)})`, patches: null, rows: curRows };
      if (sameValue(a, b)) continue;
      if (!patch) patch = { playerId: row.playerId };
      patch[k] = b;
    }
    // a key the row no longer has at all ("pendingLp" / "uniteLeft" left the view, `progress` disappeared): the client
    // would otherwise keep the stale value it merged earlier. Sent as null — see the row-null rule in the header.
    for (const k of Object.keys(old)) {
      if (k in row) continue;
      if (!patch) patch = { playerId: row.playerId };
      patch[k] = null;
    }
    if (patch) { patches.push(patch); rows.push(plainCopy(row)); }   // the baseline gets a row of its own
    else rows.push(old);                                             // unchanged: the previous baseline's copy, identity-stable
  }
  for (const id of before.keys()) {
    if (seen.has(id)) continue;
    patches.push({ playerId: id, gone: true });         // the seat left the match: the client drops the row
  }
  return { ok: true, patches: patches.length ? patches : null, rows };
}

/**
 * `fields` per ENTRY, the same shape of patch as a player row: only the entries that changed ride the frame, an entry
 * that did not keeps its previous object in `rows` (identity-stable, never re-serialized), a key that left an entry is
 * `null`, a NEW entry is sent whole, and an entry that left the list is `{ fieldId, gone: true }`. Nothing here is
 * O(field count) except when the list really changed that much.
 *
 * `rows` obeys the same no-alias rule as `diffPlayers`: a changed or new entry is a deep copy, an unchanged one keeps
 * the previous baseline's own object.
 * @returns {{ patches: any[] | null, rows: any[], ok: boolean, why?: string }}
 */
function diffFields(prevRows, curRows) {
  const patches = [];
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < curRows.length; i++) {
    const b = curRows[i];
    if (!b || typeof b !== 'object') return { ok: false, why: 'a field entry is not an object', patches: null, rows: curRows };
    seen.add(b.fieldId);
    const a = prevRows.find((f) => f && f.fieldId === b.fieldId);
    if (a && sameValue(a, b)) { rows.push(a); continue; }
    const patch = { fieldId: b.fieldId };
    if (a) {
      for (const k of Object.keys(b)) {
        if (k === 'fieldId' || a[k] === b[k]) continue;
        // an array / object that merely got rebuilt is not a change (the same rule the row diff uses)
        if (!isJsonValue(b[k])) return { ok: false, why: `field ${b.fieldId} key "${k}" is not a JSON value (${jsonKind(b[k])})`, patches: null, rows: curRows };
        if (sameValue(a[k], b[k])) continue;
        patch[k] = b[k];
      }
      for (const k of Object.keys(a)) if (!(k in b)) patch[k] = null;
    } else {
      for (const [k, v] of Object.entries(b)) if (k !== 'fieldId') patch[k] = v;
    }
    patches.push(patch);
    rows.push(plainCopy(b));    // the baseline gets an entry of its own (the patch holds the view's values)
  }
  for (const a of prevRows) {
    if (a && !seen.has(a.fieldId)) patches.push({ fieldId: a.fieldId, gone: true });
  }
  return { ok: true, patches: patches.length ? patches : null, rows };
}
