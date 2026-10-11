// public/js/matchDelta.js — the CLIENT half of the incremental `m.public` frame (DESIGN §8.2, "incremental frame";
// the server half is server/viewsDelta.js, and the two are written against the SAME rules).
//
// The server sends one FULL frame (the whole view, as it always did) and then one DELTA frame per change
// (`delta: true`): only the top-level keys that changed, and inside `players` only the fields of one row that changed.
// This module holds the materialized state the deltas merge into, so everything downstream (the store, every screen,
// every UI module) keeps reading a complete `m.public` and never learns that frames got smaller.
//
// Rules (docs/design/network.md §8.2 lists them for readers):
//   * APPLY A DELTA TO THE STATE YOU ALREADY HAVE. With no state — a fresh client, a reconnect, a delta before the
//     first full frame — there is nothing to merge: `applyPublic` refuses, and the caller sends `g.publicFull` and waits
//     for the full frame. Requirement: a joiner, a reconnect and a spectator always get a full frame first.
//   * `null` IS A REAL VALUE for a TOP-LEVEL key (`bossId`, `rerollVote`, `uniteResult`) and is stored as it is. A
//     top-level key that DISAPPEARED is named in the frame's `gone: [...]` and deleted. Inside a ROW the two are one
//     state: an unset row field (`bandId`, `fieldId`, `progress.resolved`) is read as "unset" by every consumer, so a
//     full frame's row null is materialized as `undefined` (`clonePublic` → `normalizeRow`) and a delta's row null means
//     "this key is gone" and is deleted — both paths end in the same row, and a delta is never ambiguous.
//   * a patch's `playerId` names the row; a patch with `gone: true` DROPS the row (the seat left the match — a `fields`
//     patch with `gone: true` drops that field entry the same way).
//   * `fields` arrives as per-entry patches (a changed entry carries only what changed, a new one is whole, a dropped one
//     is `{ fieldId, gone: true }`); `fieldsFull: true` (the whole list) is accepted too.
//   * arrays are copied, never aliased: the state this module returns is stable for the UI and safe to mutate by nobody.
//
// The functions are pure (no store, no net, no DOM) so they are unit-testable on their own: test/match/public-delta.test.js.

/** A materialized m.public view (the same shape `main.js` forks into the store). */
export const emptyPublic = () => ({});

/**
 * Whether a frame may be merged into `base`. False means "ask for a full frame again" (the caller's self-healing path):
 * a delta with nothing to merge into, or a patch that names no seat at all (malformed, or the server's shape changed
 * under an old client) — an unmergeable frame must never be applied half-way.
 * @param {unknown} base the materialized state (null/undefined when there is none)
 * @param {any} frame an `m.public` frame
 */
export function canMerge(base, frame) {
  if (!base || typeof base !== 'object') return false;
  if (!frame || frame.t !== 'm.public' || frame.delta !== true) return false;
  if (frame.players !== undefined) {
    if (!Array.isArray(frame.players)) return false;
    for (const p of frame.players) {
      if (!p || typeof p !== 'object' || typeof p.playerId !== 'string' || !p.playerId) return false;
    }
  }
  if (frame.fields !== undefined) {
    if (!Array.isArray(frame.fields)) return false;
    for (const f of frame.fields) {
      if (!f || typeof f !== 'object' || typeof f.fieldId !== 'string' || !f.fieldId) return false;
    }
  }
  if (frame.gone !== undefined && !Array.isArray(frame.gone)) return false;
  return true;
}

/** The wire markers of a delta frame: never part of the materialized state. */
const MARKERS = new Set(['t', 'rid', 'delta', 'fieldsFull', 'gone', 'players', 'fields']);

/**
 * Merge one delta frame into `base` (never mutated).
 *
 * @param {Record<string, any>} base the materialized state the previous frames built
 * @param {any} frame an `m.public` frame with `delta: true` (see canMerge)
 * @returns {Record<string, any> | null} the new state, or null when a patch is malformed (the caller then asks for a
 *   full frame — the frame is never applied half-way); `base` itself when the frame changed nothing
 */
export function mergePublic(base, frame) {
  const src = base && typeof base === 'object' ? base : {};
  const out = { ...src };
  let changed = false;
  for (const [k, v] of Object.entries(frame)) {
    if (MARKERS.has(k)) continue;
    out[k] = v;
    if (src[k] !== v) changed = true;
  }
  for (const k of frame.gone || []) {
    if (k in out) { delete out[k]; changed = true; }
  }
  if (frame.players !== undefined) {
    const rows = Array.isArray(src.players) ? src.players.slice() : [];
    for (const patch of frame.players) {
      const i = rows.findIndex((r) => r && r.playerId === patch.playerId);
      if (patch.gone) {
        if (i >= 0) { rows.splice(i, 1); changed = true; }
        continue;
      }
      const { gone, ...fields } = patch; // eslint-disable-line no-unused-vars
      if (i < 0) { rows.push(normalizeRow({ ...fields })); changed = true; continue; }
      const row = { ...rows[i] };
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'playerId') continue;
        // inside a row, null means "the key is gone" (see the header): delete it, never store a null
        if (v === null) {
          if (k in row) { delete row[k]; changed = true; }
          continue;
        }
        if (row[k] !== v) changed = true;
        row[k] = v;
      }
      rows[i] = row;
    }
    out.players = rows;
  }
  if (frame.fields !== undefined) {
    // fields are patched per entry, exactly like player rows (server/viewsDelta.js diffFields): a changed entry carries
    // only what changed, a new one is whole, `{ fieldId, gone: true }` drops one, and an entry the frame does not name
    // keeps its object. (`fieldsFull: true` — the whole list in one array — is accepted too, so a future sender can
    // replace the list outright.)
    if (frame.fieldsFull === true) {
      out.fields = frame.fields.map((f) => ({ ...f }));
      return out;
    }
    const rows = Array.isArray(src.fields) ? src.fields.slice() : [];
    for (const patch of frame.fields) {
      const i = rows.findIndex((r) => r && r.fieldId === patch.fieldId);
      if (patch.gone) {
        if (i >= 0) { rows.splice(i, 1); changed = true; }
        continue;
      }
      if (i < 0) { const { gone, ...rest } = patch; void gone; rows.push(rest); changed = true; continue; }
      const row = { ...rows[i] };
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'fieldId') continue;
        if (v === null) {
          if (k in row) { delete row[k]; changed = true; }
          continue;
        }
        if (row[k] !== v) changed = true;
        row[k] = v;
      }
      rows[i] = row;
    }
    out.fields = rows;
  }
  return changed ? out : src;
}

/**
 * The full client-side rule, in one call: a delta is merged into `base`, a FULL frame replaces it. `ok: false` means
 * "cannot be merged — ask the server for a full frame (`g.publicFull`)"; the caller must not apply the frame then.
 *
 * @param {Record<string, any> | null} base the materialized state (null when the client has none)
 * @param {any} frame an `m.public` frame
 * @returns {{ ok: true, state: Record<string, any> } | { ok: false, reason: 'no-base' | 'bad-delta' }}
 */
export function applyPublic(base, frame) {
  if (!frame || frame.t !== 'm.public') return { ok: false, reason: 'bad-delta' };
  if (frame.delta === true) {
    if (!canMerge(base, frame)) return { ok: false, reason: base ? 'bad-delta' : 'no-base' };
    const state = mergePublic(base, frame);
    if (state == null) return { ok: false, reason: 'bad-delta' };
    return { ok: true, state };
  }
  return { ok: true, state: clonePublic(frame) };
}

/** The materialized state of a FULL frame: the view without the wire fields, rows normalized, arrays copied. */
export function clonePublic(frame) {
  const out = {};
  for (const [k, v] of Object.entries(frame)) {
    if (k === 't' || k === 'rid' || k === 'delta' || k === 'fieldsFull' || k === 'gone') continue;
    if (k === 'players' && Array.isArray(v)) { out[k] = v.map(normalizeRow); continue; }
    out[k] = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? { ...x } : x)) : v;
  }
  return out;
}

/**
 * A player row as the client materializes it: an unset field leaves the row entirely. A full frame writes those fields
 * as `null` (the engine's rows are frozen objects with an explicit `bandId: null` / `fieldId: null`), and a delta writes
 * a vanished field as `null` too — this is the one place both become the same state, which is what every consumer reads
 * anyway (`p.fieldId ?? null`, `typeof p.bandId === 'string'`, `p.resolved == null`). Nothing else is touched.
 */
function normalizeRow(row) {
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) if (v === null) delete out[k];
  return out;
}
