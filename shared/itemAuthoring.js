// shared/itemAuthoring.js — authoring a workshop EQUIPMENT item.
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
//
// An items.json record has ~30 fields, and most of them come from game tables a pack author does not have (the trap
// table, the shop table, the season's research notes). What an author DOES know is what the item says and does: its
// name, tier, price, description and its blackboard. This layer takes those and derives the rest — and the three
// derivations below are not guesses: each one reproduces all 115 shipped items exactly (test/itemAuthoring.test.js).
//
//   params         flattening of the buffs' blackboards  (tools/build-data.mjs effectParams: first key wins, over
//                  `{ ...bb, ...bbStr }`, across every buff in order)
//   mergeable      `!isGolden && 0 < upgradeNum < 100`
//   shopExcluded   `shopExcludedBy != null`
//
// The `_a` / `_b` id pair is the same shape chess uses, and it is what makes an item mergeable: `upgradeChessId` points
// at the golden twin. `upgradeNum` is the author's choice — 2 for a mergeable pair, 0 for a standalone item (the game's
// own data uses only 0, 2 and 100).
//
// NOT derivable, so authored: `trapId` (the art/trap key — reusing an existing one is the only way to get real art
// without shipping assets, exactly like an enemy's `spine`), `identifier`, `note`/`implFormula`/`flavor` (editorial
// card text) and `rangeGrid`.

/** `itemType` the shipped data uses (drift-guarded). */
export const ITEM_TYPES = Object.freeze(['EQUIP', 'MAGIC']);
/** The shop's grouping. */
export const ITEM_CATEGORIES = Object.freeze(['STAT', 'ON_HIT', 'RECRUIT', 'SURVIVAL', 'BOND_SIGNATURE', 'ECONOMY', 'SET', 'MAGIC', 'BOND', 'SP', 'BOND_GRANT']);
/** How a buff's blackboard counts up. */
export const COUNT_TYPES = Object.freeze(['NONE', 'COUNTING']);
/** `duration`: -1 = lasts the battle, 0 = instant. The shipped data uses only these two. */
export const ITEM_DURATIONS = Object.freeze([-1, 0]);
/** `upgradeNum` values the shipped data uses: 0 = standalone, 2 = mergeable pair, 100 = special (never mergeable). */
export const UPGRADE_NUMS = Object.freeze([0, 2, 100]);

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const fin = (v, d) => (isFin(v) ? v : d);
const int = (v, d) => (isInt(v) ? v : d);

/** `chess_item_ws_<slug>_a` / `_b` from a slug or an id. The `item` namespace mirrors the game's own `chess_item_…`. */
export function itemIds(idOrSlug) {
  const raw = String(idOrSlug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  let slug = raw;
  if (slug.startsWith('chess_item_ws_')) slug = slug.slice('chess_item_ws_'.length);
  else if (slug.startsWith('chess_item_')) slug = slug.slice('chess_item_'.length);
  slug = slug.replace(/_[ab]$/, '');
  return slug ? { slug, base: `chess_item_ws_${slug}_a`, golden: `chess_item_ws_${slug}_b` } : null;
}

/**
 * The blackboard flattening (tools/build-data.mjs effectParams): across the buffs in order, `{ ...bb, ...bbStr }`,
 * FIRST key wins. So within one buff `bbStr` overrides `bb` for a shared key, and across buffs the earliest buff wins.
 * (No shipped buff actually shares a key between bb and bbStr, so that half of the rule is pinned by test rather than by
 * the data.) Reproduces `params` for all 115 shipped items.
 * @param {Array<{bb?: object, bbStr?: object}>} buffs
 */
export function effectParams(buffs) {
  const params = {};
  for (const b of Array.isArray(buffs) ? buffs : []) {
    if (!isPlain(b)) continue;
    for (const [k, v] of Object.entries({ ...(isPlain(b.bb) ? b.bb : {}), ...(isPlain(b.bbStr) ? b.bbStr : {}) })) {
      if (!(k in params)) params[k] = v;
    }
  }
  return params;
}

/**
 * `mergeable` — tools/build-data.mjs:1465 is `!isGolden && upgradeNum > 0 && upgradeNum < 100`, and the shipped data
 * always satisfies one more thing: a mergeable item NAMES A TWIN to merge into (no shipped item is mergeable with a
 * null `goldenId`, and one could not resolve). Requiring that makes a hand-built record fail loudly instead of
 * advertising a merge that goes nowhere.
 */
export const isMergeable = (isGolden, upgradeNum, goldenId) => !isGolden && !!goldenId && upgradeNum > 0 && upgradeNum < 100;

const randGridOk = (g) => Array.isArray(g) && g.length > 0 && g.every((p) => Array.isArray(p) && p.length === 2 && p.every(isInt));

/**
 * Build a complete item record (and its golden twin) from what an author knows.
 *
 * Spec: { id, name, desc, tier, price, itemType?, category?, kind?, family?, upgradeNum?, golden?,
 *         trapId?, identifier?, duration?, giveBondId?, requiresBondId?, canGiveBond?, shopExcludedBy?, hideInShop?,
 *         effectId?, effectName?, buffs?: [{ key, countType?, bb, bbStr? }], rangeGrid?, note?, implFormula?, flavor? }
 *
 * @returns {{ ok: true, base: object, golden: object|null, warnings: string[] } | { ok: false, errors: object[] }}
 */
export function deriveItem(spec) {
  const errors = [];
  const warnings = [];
  if (!isPlain(spec)) return { ok: false, errors: [{ field: '', code: 'NOT_AN_OBJECT', message: 'spec must be a JSON object' }] };
  const ids = itemIds(spec.id);
  const req = (cond, field, code, message, hint) => { if (!cond) errors.push({ field, code, message, ...(hint ? { hint } : {}) }); };
  req(ids, 'id', 'BAD_ID', 'id must contain at least one letter or digit', 'e.g. "frost_charm"');
  req(typeof spec.name === 'string' && spec.name.trim(), 'name', 'MISSING', 'name is required');
  if (spec.itemType !== undefined) req(ITEM_TYPES.includes(spec.itemType), 'itemType', 'BAD_ENUM', `itemType must be one of ${ITEM_TYPES.join(', ')}`);
  if (spec.category != null) req(ITEM_CATEGORIES.includes(spec.category), 'category', 'BAD_ENUM', `category must be one of ${ITEM_CATEGORIES.join(', ')} or null`);
  if (spec.duration !== undefined) req(ITEM_DURATIONS.includes(spec.duration), 'duration', 'BAD_ENUM', `duration must be one of ${ITEM_DURATIONS.join(', ')}`);
  if (spec.upgradeNum !== undefined) req(isInt(spec.upgradeNum) && spec.upgradeNum >= 0, 'upgradeNum', 'BAD_NUMBER', 'upgradeNum must be an integer >= 0');
  req(isInt(spec.tier) && spec.tier >= 1 && spec.tier <= 6, 'tier', 'BAD_TIER', 'tier must be an integer 1..6');
  req(isInt(spec.price) && spec.price >= 0, 'price', 'BAD_NUMBER', 'price must be an integer >= 0');
  if (spec.rangeGrid !== undefined) req(randGridOk(spec.rangeGrid), 'rangeGrid', 'BAD_RANGE', 'rangeGrid must be a non-empty array of [row, col] integer pairs');
  if (spec.buffs !== undefined) {
    req(Array.isArray(spec.buffs), 'buffs', 'BAD_BUFFS', 'buffs must be an array of { key, bb, countType? }');
    for (const [i, b] of (Array.isArray(spec.buffs) ? spec.buffs : []).entries()) {
      if (!isPlain(b)) { errors.push({ field: `buffs[${i}]`, code: 'BAD_BUFF', message: 'a buff must be an object' }); continue; }
      if (typeof b.key !== 'string' || !b.key) errors.push({ field: `buffs[${i}].key`, code: 'MISSING', message: 'a buff key is required' });
      if (b.countType !== undefined && !COUNT_TYPES.includes(b.countType)) {
        errors.push({ field: `buffs[${i}].countType`, code: 'BAD_ENUM', message: `countType must be one of ${COUNT_TYPES.join(', ')}` });
      }
      if (b.bb !== undefined && !isPlain(b.bb)) errors.push({ field: `buffs[${i}].bb`, code: 'BAD_BB', message: 'bb must be an object of numbers' });
    }
  }
  if (errors.length) return { ok: false, errors };

  const upgradeNum = int(spec.upgradeNum, 2);
  const wantsGolden = spec.golden !== false && upgradeNum > 0 && upgradeNum < 100;
  if (spec.golden !== false && !wantsGolden) {
    warnings.push(`upgradeNum ${upgradeNum} means the item is not mergeable, so no golden twin is emitted (set golden: false to silence this).`);
  }
  const buffs = (Array.isArray(spec.buffs) ? spec.buffs : []).map((b) => ({
    key: b.key,
    countType: COUNT_TYPES.includes(b.countType) ? b.countType : 'NONE',
    bb: isPlain(b.bb) ? { ...b.bb } : {},
    bbStr: isPlain(b.bbStr) ? { ...b.bbStr } : {},
  }));
  if (!buffs.length) warnings.push('no buffs: the item has no mechanical effect, only its card text.');
  const name = spec.name;
  const common = {
    name,
    itemType: spec.itemType ?? 'EQUIP',
    tier: spec.tier,
    shopSortId: int(spec.shopSortId, 0),
    price: spec.price,
    hideInShop: spec.hideInShop === true,
    // DERIVED: the shop hides an item exactly when something else excludes it
    shopExcludedBy: spec.shopExcludedBy ?? null,
    shopExcluded: (spec.shopExcludedBy ?? null) != null,
    duration: ITEM_DURATIONS.includes(spec.duration) ? spec.duration : -1,
    giveBondId: spec.giveBondId ?? null,
    givePowerId: spec.givePowerId ?? null,
    canGiveBond: spec.canGiveBond === true,
    requiresBondId: spec.requiresBondId ?? null,
    effectId: typeof spec.effectId === 'string' && spec.effectId ? spec.effectId : `eff_ws_${ids.slug}`,
    effectName: typeof spec.effectName === 'string' && spec.effectName ? spec.effectName : name,
    desc: spec.desc ?? '',
    descRaw: spec.descRaw ?? spec.desc ?? '',
    buffs,
    // DERIVED: the flattening the engine reads
    params: effectParams(buffs),
    category: spec.category ?? null,
    kind: spec.kind ?? null,
    family: spec.family ?? null,
    implFormula: spec.implFormula ?? null,
    note: spec.note ?? null,
    rangeGrid: spec.rangeGrid ?? [[0, 0]],
    flavor: spec.flavor ?? null,
    trapId: spec.trapId ?? null,
    iconId: spec.trapId ?? null,
    identifier: isInt(spec.identifier) ? spec.identifier : null,
    workshop: { schema: 1, id: ids.slug },
  };
  const base = {
    ...common,
    id: ids.base, baseId: ids.base, goldenId: wantsGolden ? ids.golden : null, isGolden: false,
    upgradeNum,
    // DERIVED: mergeable is a function of isGolden, upgradeNum and whether a twin exists
    mergeable: isMergeable(false, upgradeNum, wantsGolden ? ids.golden : null),
    upgradeChessId: wantsGolden ? ids.golden : null,
  };
  const golden = wantsGolden ? {
    ...common,
    id: ids.golden, baseId: ids.base, goldenId: ids.golden, isGolden: true,
    upgradeNum,
    mergeable: isMergeable(true, upgradeNum, ids.golden),
    upgradeChessId: null,
  } : null;
  if (!common.trapId) {
    warnings.push('no trapId: the item renders with the fallback icon. Reusing an existing trap/equip id is the only way to get real art without shipping assets.');
  }
  return { ok: true, base, golden, warnings };
}

/**
 * Validate one item record. The three derived fields are RE-computed and compared, so a hand-edited or hand-typed value
 * is caught rather than silently kept.
 * @param {object} rec
 * @param {{ id?: string, officialIds?: Set<string>|string[] }} [opts]
 */
export function validateItem(rec, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  if (!isPlain(rec)) { err('', 'NOT_AN_OBJECT', 'record must be a JSON object'); return out; }
  const id = opts.id ?? rec.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.:]{1,64}$/.test(id)) err('id', 'BAD_ID', `"${id}" is not a usable item id`);
  if (rec.id !== undefined && rec.id !== id) err('id', 'ID_MISMATCH', `id "${rec.id}" does not equal its map key "${id}"`);
  const official = opts.officialIds instanceof Set ? opts.officialIds : new Set(opts.officialIds || []);
  if (official.has(id)) {
    err('id', 'OFFICIAL_ID_COLLISION', `"${id}" already exists in the official data`, `replace it only on purpose: add "items:${id}" to the pack's overrides`);
  }
  if (typeof rec.name !== 'string' || !rec.name.trim()) err('name', 'MISSING', 'name is required');
  if (!ITEM_TYPES.includes(rec.itemType)) err('itemType', 'BAD_ENUM', `itemType must be one of ${ITEM_TYPES.join(', ')}`);
  if (rec.category != null && !ITEM_CATEGORIES.includes(rec.category)) err('category', 'BAD_ENUM', `category must be one of ${ITEM_CATEGORIES.join(', ')} or null`);
  if (!(isInt(rec.tier) && rec.tier >= 1 && rec.tier <= 6)) err('tier', 'BAD_TIER', 'tier must be an integer 1..6');
  if (!(isInt(rec.price) && rec.price >= 0)) err('price', 'BAD_NUMBER', 'price must be an integer >= 0');
  if (!ITEM_DURATIONS.includes(rec.duration)) err('duration', 'BAD_ENUM', `duration must be one of ${ITEM_DURATIONS.join(', ')}`);
  if (!randGridOk(rec.rangeGrid)) err('rangeGrid', 'BAD_RANGE', 'rangeGrid must be a non-empty array of [row, col] integer pairs');
  if (!Array.isArray(rec.buffs)) err('buffs', 'BAD_BUFFS', 'buffs must be an array');
  if (!isPlain(rec.params)) err('params', 'MISSING_DERIVED', 'params is missing: it is derived from the buffs, not authored');
  // the three derived fields, re-computed
  if (Array.isArray(rec.buffs) && isPlain(rec.params)) {
    const want = effectParams(rec.buffs);
    if (JSON.stringify(want) !== JSON.stringify(rec.params)) {
      err('params', 'STALE_DERIVED', `params is ${JSON.stringify(rec.params)} but the buffs give ${JSON.stringify(want)}`, 're-derive it (the engine reads params, not the buffs)');
    }
  }
  const wantMerge = isMergeable(rec.isGolden === true, int(rec.upgradeNum, 0), rec.goldenId ?? null);
  if (rec.mergeable !== wantMerge) {
    err('mergeable', 'STALE_DERIVED', `mergeable is ${rec.mergeable} but isGolden=${rec.isGolden === true}, goldenId=${JSON.stringify(rec.goldenId)} and upgradeNum=${rec.upgradeNum} give ${wantMerge}`, 're-derive it');
  }
  if (rec.shopExcluded !== (rec.shopExcludedBy != null)) {
    err('shopExcluded', 'STALE_DERIVED', `shopExcluded is ${rec.shopExcluded} but shopExcludedBy is ${JSON.stringify(rec.shopExcludedBy)}`, 'shopExcluded is exactly "shopExcludedBy is set"');
  }
  if (rec.isGolden === true && rec.goldenId !== rec.id) {
    err('goldenId', 'PAIR_MISMATCH', `a golden record's goldenId must be its own id (${rec.id}), got ${JSON.stringify(rec.goldenId)}`);
  }
  if (rec.isGolden === false && rec.goldenId && rec.upgradeChessId !== rec.goldenId) {
    err('upgradeChessId', 'PAIR_MISMATCH', `upgradeChessId ${JSON.stringify(rec.upgradeChessId)} must equal goldenId ${rec.goldenId}`, 'the merge target is the golden twin');
  }
  if (rec.isGolden !== true && rec.mergeable === true && !rec.goldenId) {
    err('goldenId', 'PAIR_MISSING', 'a mergeable item must name its golden twin', 'set upgradeNum 0 (or golden false) for a standalone item');
  }
  if (!rec.trapId) warn('trapId', 'NO_ICON', 'no trapId: the item renders with the fallback icon');
  return out;
}

/** The errors of a validation result. */
export const itemErrors = (issues) => (Array.isArray(issues) ? issues.filter((i) => i.severity === 'error') : []);

/** A one-line readout for the editor / CLI. */
export const itemSummaryLine = (rec) => {
  const bb = Object.entries(rec?.params || {}).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${rec?.name ?? '?'} · ${rec?.tier ?? '?'} 阶 · ${rec?.price ?? '?'} 金 · ${rec?.mergeable ? '可合成' : '独立'}${bb ? ` · ${bb}` : ''}`;
};
