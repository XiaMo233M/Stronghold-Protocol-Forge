// public/js/ui/supportModel.js — 助战 (support) selection model: pure logic shared by the picker screen
// (screens/support.js) and the server sync (ui/supportSync.js).
//
// The rule that shapes this file (shared/support.js): **the pool is declared and enforced by the SERVER**, and a
// selection is never silently defaulted — an operator the pool does not list is DISABLED, so falling back to a default
// would quietly turn a disabled operator into a granted one. Everything here therefore works against the catalog the
// server sent (`room.state.support`) and DROPS nothing without reporting it.

import { checkSupport, SUPPORT_LIMITS } from '../../../shared/support.js';

/** localStorage pref key (store.js loadPref/savePref). */
export const SUPPORT_PREF = 'support';
export const SUPPORT_STORED_VERSION = 1;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Normalise the catalog the server sent with `room.state`. Tolerant: junk, a missing field or an older server all yield
 * a DISABLED catalog (the picker then shows nothing and the sync sends nothing), which is the only safe reading —
 * inventing a pool would let the client offer an operator the server refuses.
 * @param {any} raw `room.state.support`
 * @returns {{ enabled: boolean, label: string, tiers: {tier:number, slots:number, ids:string[]}[], capacity: number, slots: Record<number, number> }|null}
 *   null when the server has never sent a catalog (the sync must then WAIT, not guess)
 */
export function readCatalog(raw) {
  if (!isPlain(raw)) return null;
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : [])
    .filter((t) => isPlain(t) && Number.isInteger(t.tier) && Array.isArray(t.ids))
    .map((t) => ({ tier: t.tier, slots: Number.isInteger(t.slots) && t.slots > 0 ? t.slots : 0, ids: t.ids.filter((id) => typeof id === 'string' && id) }))
    .filter((t) => t.slots > 0 && t.ids.length > 0)
    .sort((a, b) => a.tier - b.tier);
  const slots = {};
  for (const t of tiers) slots[t.tier] = t.slots;
  return {
    enabled: raw.enabled === true && tiers.length > 0,
    label: typeof raw.label === 'string' && raw.label ? raw.label : '助战',
    tiers,
    capacity: tiers.reduce((n, t) => n + t.slots, 0),
    slots,
  };
}

/** Parse the stored preference. Tolerant of junk and of an older bare-array shape; never throws. */
export function parseStored(raw) {
  const src = isPlain(raw) && Array.isArray(raw.entries) ? raw.entries : (Array.isArray(raw) ? raw : []);
  const out = [];
  const seen = new Set();
  for (const id of src) {
    if (typeof id !== 'string' || !id || id.length > SUPPORT_LIMITS.idLen || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= SUPPORT_LIMITS.entries) break;
  }
  return out;
}

/** The stored envelope (versioned, like the loadout export). */
export const toStored = (entries) => ({ v: SUPPORT_STORED_VERSION, entries: Array.isArray(entries) ? [...entries] : [] });

/** The tier the catalog allows this id under, or null when the catalog does not list it at all. */
export function tierOf(catalog, id) {
  if (!catalog || !catalog.enabled || typeof id !== 'string') return null;
  for (const t of catalog.tiers) if (t.ids.includes(id)) return t.tier;
  return null;
}

/** How many of `tier` the selection already uses (0 when the catalog does not offer that tier). */
export function usedOf(catalog, entries, tier) {
  const t = catalog && catalog.enabled ? catalog.tiers.find((x) => x.tier === tier) : null;
  if (!t) return 0;
  return (Array.isArray(entries) ? entries : []).filter((id) => t.ids.includes(id)).length;
}

/** Per-tier `{ tier, slots, used, ids, full }` for the picker, ascending. */
export function tierUsage(catalog, entries) {
  if (!catalog || !catalog.enabled) return [];
  const list = Array.isArray(entries) ? entries : [];
  return catalog.tiers.map((t) => {
    const used = list.filter((id) => t.ids.includes(id)).length;
    return { tier: t.tier, slots: t.slots, used, ids: t.ids, full: used >= t.slots };
  });
}

/**
 * Drop what the catalog no longer allows: ids it does not list, and any tier over its quota (keeping the earliest, so
 * the result is deterministic). Returns what changed, so the caller can TELL the player rather than silently shrink
 * their selection — the pool may have shrunk since the browser stored it.
 * @returns {{ entries: string[], dropped: string[], reason: string|null }}
 */
export function sanitizeSupport(catalog, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!catalog) return { entries: [...list], dropped: [], reason: null };
  if (!catalog.enabled) return { entries: [], dropped: [...list], reason: 'support is off on this server' };
  const out = [];
  const dropped = [];
  const used = {};
  for (const id of list) {
    const tier = tierOf(catalog, id);
    if (tier === null) { dropped.push(id); continue; }
    used[tier] = (used[tier] || 0) + 1;
    if (used[tier] > catalog.slots[tier]) { dropped.push(id); continue; }
    out.push(id);
  }
  return { entries: out, dropped, reason: dropped.length ? 'the server pool changed while you were away' : null };
}

/**
 * Toggle one operator in the selection.
 * @returns {{ entries: string[], changed: boolean, full: boolean }}
 *   `full` means the request was refused because that tier's slots are used up (the UI shows the reason).
 */
export function toggleSupport(catalog, entries, id) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const at = list.indexOf(id);
  if (at >= 0) { list.splice(at, 1); return { entries: list, changed: true, full: false }; }
  const tier = tierOf(catalog, id);
  if (tier === null) return { entries: list, changed: false, full: false };   // not in the pool ⇒ disabled, not addable
  if (list.filter((x) => tierOf(catalog, x) === tier).length >= catalog.slots[tier]) return { entries: list, changed: false, full: true };
  list.push(id);
  return { entries: list, changed: true, full: false };
}

/**
 * Pre-check the selection with the SAME function the server uses (`checkSupport`), so the picker and the match cannot
 * disagree. The client passes the catalog it was given, expressed in the shared config shape.
 * @param {(id: string) => any} getChess chess record lookup
 */
export function checkSelection(catalog, entries, getChess) {
  if (!catalog) return { ok: false, error: 'NO_CATALOG', detail: 'the server has not sent its support pool yet' };
  const cfg = { enabled: catalog.enabled, label: catalog.label, strict: true, slots: { ...catalog.slots }, pool: Object.fromEntries(catalog.tiers.map((t) => [t.tier, t.ids])) };
  return checkSupport(entries, cfg, getChess);
}

/** A one-line summary for the status area: `5级 1/2 · 6级 0/1`. */
export function usageLine(catalog, entries) {
  const usage = tierUsage(catalog, entries);
  if (!usage.length) return '本服务器未开启助战';
  return usage.map((u) => `${u.tier}级 ${u.used}/${u.slots}`).join(' · ');
}
