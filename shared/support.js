// shared/support.js — 助战 (support operators) configuration and selection, pure ESM shared by the server (validation,
// the match's grant at start) and the client (the 助战 picker only offers what the server declares).
//
// REMake extension, NOT official data: the official mode has a 「助战及自选编队」 page but this remake implements its own
// server-controlled model of it. The one rule that matters for balance and for trust:
//
//   **The support pool is declared and enforced by the SERVER** (`data/support.json`, docs/WORKSHOP.md). An operator that
//   the pool does not list is DISABLED: the client does not show it, and a request that names it is rejected outright —
//   unlike the loadout, a support selection never falls back to a default, because falling back would silently turn a
//   disabled operator into a granted one.
//
// Shape of the config (data/support.json):
//   { enabled: bool, label: string, denyUnknown: bool,
//     slots: { [tier]: n },            // how many supports of that tier one player may bring (tier 1–6)
//     pool:  { [tier]: [chessId, …] } } // the base chess ids allowed at that tier (must match the record's own tier)
//
// One implementation for both sides (the convention of shared/loadoutRecord.js): the server checks an incoming selection
// with `checkSupport` and the client pre-checks with the same function, so the picker and the match never disagree.

/** Structural limits of a `room.support` selection (the wire message, shared/protocol.js). */
export const SUPPORT_LIMITS = Object.freeze({ entries: 16, idLen: 64 });

const isTier = (t) => Number.isInteger(t) && t >= 1 && t <= 6;
/** The same predicate, exported for the workshop overlay (a pack's 助战 tier must be one of these): one rule, one place. */
export const isSupportTier = isTier;
const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isChessId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SUPPORT_LIMITS.idLen && /^[A-Za-z0-9_\-.:]+$/.test(v);

/**
 * Normalise a raw `data/support.json` into the frozen shape every consumer reads. Tolerant by design: a missing file,
 * a partial file or junk keys yield a **disabled** config rather than a throw, so a server with no support.json keeps
 * working (the same stance as server/match/gamedata.js towards a partial data set).
 *
 * `enabled` is only true when the file asks for it AND there is at least one usable tier (a slot count > 0 with a
 * non-empty pool). A tier whose pool is empty therefore cannot be selected — "没有即禁用" holds even for a hand-edited
 * or truncated config.
 *
 * @param {any} raw parsed data/support.json (anything else is treated as absent)
 * @returns {{ enabled: boolean, label: string, strict: boolean, slots: Readonly<Record<number, number>>, pool: Readonly<Record<number, readonly string[]>> }}
 */
export function normalizeSupportConfig(raw) {
  const src = isPlainObj(raw) ? raw : {};
  /** @type {Record<number, number>} */
  const slots = {};
  if (isPlainObj(src.slots)) {
    for (const [k, v] of Object.entries(src.slots)) {
      const tier = Number(k);
      // a slot count of 0 is legal and means "this tier is off"; negative / non-integer counts are ignored
      if (isTier(tier) && Number.isInteger(v) && v >= 0) slots[tier] = v;
    }
  }
  /** @type {Record<number, string[]>} */
  const pool = {};
  if (isPlainObj(src.pool)) {
    for (const [k, v] of Object.entries(src.pool)) {
      const tier = Number(k);
      if (!isTier(tier) || !Array.isArray(v)) continue;
      const ids = [...new Set(v.filter(isChessId))].sort();
      if (ids.length) pool[tier] = ids;
    }
  }
  const usableTiers = Object.keys(slots).map(Number).filter((t) => slots[t] > 0 && Array.isArray(pool[t]) && pool[t].length > 0);
  return Object.freeze({
    enabled: src.enabled === true && usableTiers.length > 0,
    label: typeof src.label === 'string' && src.label ? src.label : '助战',
    // denyUnknown: a selection outside the pool is refused. Only an explicit `false` relaxes it to the same refusal
    // (the pool is the whitelist either way — the flag documents intent and is kept for future group plugins).
    strict: src.denyUnknown !== false,
    slots: Object.freeze(slots),
    pool: Object.freeze(pool),
  });
}

/** Tiers a player may actually pick from, ascending (slots > 0 and a non-empty pool). */
export function supportTiers(cfg) {
  if (!cfg || !cfg.enabled) return [];
  return Object.keys(cfg.slots)
    .map(Number)
    .filter((t) => cfg.slots[t] > 0 && Array.isArray(cfg.pool[t]) && cfg.pool[t].length > 0)
    .sort((a, b) => a - b);
}

/** How many supports of `tier` one player may bring (0 when the tier is off or support is disabled). */
export function supportSlotsFor(cfg, tier) {
  if (!cfg || !cfg.enabled || !isTier(tier)) return 0;
  return cfg.slots[tier] || 0;
}

/** Total supports one player may bring (the sum of every usable tier's slots). */
export function supportCapacity(cfg) {
  return supportTiers(cfg).reduce((n, t) => n + cfg.slots[t], 0);
}

/**
 * Whether the server's pool allows this operator as a support. Fails closed on anything but a plain visible non-elite
 * base chess: the pool must list the id **under its own tier** (a tier-6 id listed under "5" is not allowed), so a
 * mis-edited config disables rather than promotes.
 * @param {any} cfg normalizeSupportConfig(…) output
 * @param {unknown} id base chess id
 * @param {(id: string) => any} getChess chess record lookup
 */
export function isSupportChess(cfg, id, getChess) {
  if (!cfg || !cfg.enabled || typeof id !== 'string' || !id) return false;
  const rec = typeof getChess === 'function' ? getChess(id) : null;
  if (!rec || rec.isGolden || rec.visible === false || rec.isHidden || rec.isDiy) return false;
  if (!Number.isInteger(rec.tier)) return false;
  const list = cfg.pool[rec.tier];
  return Array.isArray(list) && list.includes(id);
}

/** The tier this operator counts against (its own tier once the pool allows it), or null when it is not allowed. */
export function supportTierOf(cfg, id, getChess) {
  if (!isSupportChess(cfg, id, getChess)) return null;
  const rec = getChess(id);
  return rec && Number.isInteger(rec.tier) ? rec.tier : null;
}

/**
 * The pool a client may show, grouped by tier — the shape the 助战 picker renders. `{ tier, slots, ids }` per usable
 * tier, ascending; `[]` while support is off. Sorted so the payload is deterministic (and diffable in tests).
 */
export function supportPicker(cfg) {
  return supportTiers(cfg).map((tier) => ({ tier, slots: cfg.slots[tier], ids: [...cfg.pool[tier]] }));
}

/**
 * Structural check of a raw `room.support.entries` (the wire field, shared/protocol.js): an array of ids, bounded.
 * The array is DEDUPLICATED/capped by `entries`; semantic rules (pool membership, per-tier slots) are `checkSupport`.
 * @param {unknown} v
 */
export function isSupportEntries(v) {
  if (!Array.isArray(v) || v.length > SUPPORT_LIMITS.entries) return false;
  const seen = new Set();
  for (const id of v) {
    if (!isChessId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Semantic check + normalisation of a selection against the server's pool. Strict, and deliberately **without a
 * fallback**: a selection naming an operator outside the pool, repeating one, or exceeding its tier's slots rejects the
 * whole message (ERR.BAD_TARGET). An empty selection is always acceptable and means "no support" — including while
 * support is switched off entirely, which is the only selection a disabled server accepts.
 *
 * @param {unknown} entries `room.support.entries`
 * @param {any} cfg normalizeSupportConfig(…) output
 * @param {(id: string) => any} getChess chess record lookup
 * @returns {{ ok: true, entries: string[], byTier: Record<number, string[]> } | { error: 'BAD_MSG'|'BAD_TARGET', detail: string }}
 */
export function checkSupport(entries, cfg, getChess) {
  if (!isSupportEntries(entries)) return { error: 'BAD_MSG', detail: 'bad support entries' };
  if (!cfg || !cfg.enabled) {
    return entries.length === 0
      ? { ok: true, entries: [], byTier: {} }
      : { error: 'BAD_TARGET', detail: 'support is disabled on this server' };
  }
  /** @type {Record<number, string[]>} */
  const byTier = {};
  const out = [];
  for (const id of entries) {
    const tier = supportTierOf(cfg, id, getChess);
    if (tier === null) return { error: 'BAD_TARGET', detail: `support ${id} is not in the server pool` };
    const list = (byTier[tier] ||= []);
    const max = supportSlotsFor(cfg, tier);
    if (list.length >= max) return { error: 'BAD_TARGET', detail: `at most ${max} tier-${tier} support(s)` };
    list.push(id);
    out.push(id);
  }
  return { ok: true, entries: out, byTier };
}
