// shared/enemyAuthoring.js — authoring a workshop ENEMY: values + special mechanics, with the derived metrics computed
// rather than typed in.
//
// An enemies.json record has ~30 fields, and three of them are DERIVED from the stats (tools/build-data.mjs):
//
//   attrPower   `RandomEnemyGenerater._GetEnemyAttrPower` — float32, atk·5 + maxHp·1 + def·3 + res·3 (line 1672-1686)
//   be          `Math.round((maxHp·hpF + atk·atkF + def·defF + res·resF) / beFactor)` (line 1881)
//   beFactor    the season's battle-effectiveness divisor (default 1; the random-enemy attribute dict supplies it)
//
// be/attrPower drive the per-ACTION enemy replacement maths in server/match/waves.js, so a hand-typed value would make
// a faction swap in the wrong number of enemies. They are computed here from the enemy's OWN stats.
//
// Verified against the shipped data in test/enemyAuthoring.test.js: `be` reproduces 249/249 official enemies and
// `attrPower` 247/249 — the two exceptions are the season-overridden enemies, which build-data deliberately prices from
// the enemy DATABASE atk rather than the season value (its own comment at line 1670). A workshop enemy has no season
// override and no database record, so its authored stats ARE the source and the formula applies exactly.
//
// NOT derivable, and therefore authored (they are not in the game tables at all — build-data reads them from the PRTS
// manifests and a local client extraction): `hitArea` (giant units' hit rectangle), `modelScale`, `attackAnim`.

/** Ranks the data uses (drift-guarded). */
export const ENEMY_RANKS = Object.freeze(['NORMAL', 'ELITE', 'BOSS']);
/** Movement classes. `motion` also decides `isFlyEnemy` when no random-enemy attribute overrides it. */
export const ENEMY_MOTIONS = Object.freeze(['WALK', 'FLY']);
/** Damage types (lowercase; 'none' is a real value — 37 official enemies have no attack). */
export const ENEMY_DMG_TYPES = Object.freeze(['phys', 'arts', 'none']);
/** How the enemy applies damage: melee, ranged, none (no attack), all (either). */
export const ENEMY_APPLY_WAYS = Object.freeze(['MELEE', 'RANGED', 'NONE', 'ALL']);
/** `acType` — the ability classification the faction/替换 machinery reads; null is the common case. */
export const ENEMY_AC_TYPES = Object.freeze(['SPECIAL', 'ELEMENT', 'INVISIBLE', 'FLY', 'REFLECTION', 'DOT', 'TIMES']);
/** The immunity flags of `stats.immunities`. */
export const ENEMY_IMMUNITIES = Object.freeze(['stun', 'silence', 'sleep', 'frozen', 'levitate']);

/** Stat fields with their defaults (mirrors build-data's `mv(x, default)` calls at lines 1858-1878). */
export const ENEMY_STAT_DEFAULTS = Object.freeze({
  maxHp: 1000, atk: 0, def: 0, res: 0, moveSpeed: 1, bat: 1, aspd: 100,
  rangeRadius: 0, blockCnt: 1, massLevel: 0, lpr: 1, hpRecoveryPerSec: 0,
  elementRes: 0, elementDmgRes: 0, hitRatePhys: 0, hitRateArts: 0, tauntLevel: 0,
});

/** The power weights (constData enemyMaxHpFactor / enemyAtkFactor / enemyDefFactor / enemyMagicResistanceFactor). */
export const POWER_FACTORS = Object.freeze({ maxHp: 1, atk: 5, def: 3, res: 3 });

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const fin = (v, d) => (isFin(v) ? v : d);

/**
 * Official attribute power, in float32 like the client (tools/build-data.mjs:1672-1686).
 * @param {{maxHp:number, atk:number, def:number, res:number}} stats
 */
export function attrPowerOf(stats) {
  const s = isPlain(stats) ? stats : {};
  const f = Math.fround;
  const c = POWER_FACTORS;
  let p = f(f(f(fin(s.atk, 0) * c.atk) + f(fin(s.maxHp, 0) * c.maxHp)) + f(fin(s.def, 0) * c.def));
  p = f(p + f(c.res * fin(s.res, 0)));
  return p;
}

/**
 * Battle effectiveness (tools/build-data.mjs:1881) — plain arithmetic, then Math.round; null when beFactor ≤ 0.
 * @param {object} stats @param {number} [beFactor]
 */
export function battleEffectivenessOf(stats, beFactor = 1) {
  const s = isPlain(stats) ? stats : {};
  const c = POWER_FACTORS;
  const factor = isFin(beFactor) ? beFactor : 1;
  if (!(factor > 0)) return null;
  return Math.round((fin(s.maxHp, 0) * c.maxHp + fin(s.atk, 0) * c.atk + fin(s.def, 0) * c.def + fin(s.res, 0) * c.res) / factor);
}

/** `enemy_ws_<slug>` from a slug or id. */
export function enemyKey(idOrSlug) {
  const raw = String(idOrSlug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const slug = raw.startsWith('enemy_ws_') ? raw.slice('enemy_ws_'.length) : raw;
  return slug ? { slug, key: `enemy_ws_${slug}` } : null;
}

/**
 * Build a complete enemy record from the facts an author (or an AI) actually knows.
 *
 * Spec: { id, name, rank?, applyWay?, motion?, dmgType?, desc?,
 *         stats: { maxHp, atk, def, res, moveSpeed, bat, aspd?, rangeRadius?, blockCnt, massLevel?, lpr?, ... },
 *         abilities?: [{ text, format? }],            // 特殊机制的文字说明（游戏里显示的那几行）
 *         talents?: { bb }, skills?: [{ prefabKey, bb, cooldown, ... }],
 *         tags?: [], immunities?: { stun… }, otherImmunities?: [],
 *         isFlyEnemy?, spine?, modelScale?, hitArea?: {w,h,dx,dy}, attackAnim?: {clip,dur,hit}, beFactor?,
 *         notCountInTotal? }
 *
 * @returns {{ ok: true, enemy: object, warnings: string[] } | { ok: false, errors: object[] }}
 */
export function deriveEnemy(spec) {
  const errors = [];
  const warnings = [];
  const req = (cond, field, code, message, hint) => { if (!cond) errors.push({ field, code, message, ...(hint ? { hint } : {}) }); };
  if (!isPlain(spec)) return { ok: false, errors: [{ field: '', code: 'NOT_AN_OBJECT', message: 'spec must be a JSON object' }] };

  const ids = enemyKey(spec.id);
  req(ids, 'id', 'BAD_ID', 'id must contain at least one letter or digit', 'e.g. "frost_hound"');
  req(typeof spec.name === 'string' && spec.name.trim(), 'name', 'MISSING', 'name is required');
  if (spec.rank !== undefined) req(ENEMY_RANKS.includes(spec.rank), 'rank', 'BAD_ENUM', `rank must be one of ${ENEMY_RANKS.join(', ')}`);
  if (spec.applyWay !== undefined) req(ENEMY_APPLY_WAYS.includes(spec.applyWay), 'applyWay', 'BAD_ENUM', `applyWay must be one of ${ENEMY_APPLY_WAYS.join(', ')}`);
  if (spec.motion !== undefined) req(ENEMY_MOTIONS.includes(spec.motion), 'motion', 'BAD_ENUM', `motion must be one of ${ENEMY_MOTIONS.join(', ')}`);
  if (spec.dmgType !== undefined) req(ENEMY_DMG_TYPES.includes(spec.dmgType), 'dmgType', 'BAD_ENUM', `dmgType must be one of ${ENEMY_DMG_TYPES.join(', ')}`);
  const st = isPlain(spec.stats) ? spec.stats : null;
  req(st, 'stats', 'MISSING', 'stats is required');
  if (st) {
    req(isFin(st.maxHp) && st.maxHp > 0, 'stats.maxHp', 'BAD_NUMBER', 'maxHp must be a positive number');
    for (const k of ['atk', 'def', 'res', 'moveSpeed']) req(isFin(st[k]) && st[k] >= 0, `stats.${k}`, 'BAD_NUMBER', `${k} must be a number >= 0`);
    req(isFin(st.bat) && st.bat > 0, 'stats.bat', 'BAD_NUMBER', 'bat (attack interval, seconds) must be > 0');
    if (st.blockCnt !== undefined) req(isFin(st.blockCnt) && st.blockCnt >= 0, 'stats.blockCnt', 'BAD_NUMBER', 'blockCnt must be a number >= 0');
  }
  if (spec.hitArea !== undefined) {
    const h = spec.hitArea;
    req(isPlain(h) && isFin(h.w) && isFin(h.h) && h.w > 0 && h.h > 0, 'hitArea', 'BAD_HIT_AREA', 'hitArea needs positive w and h (tiles), and may carry dx/dy');
  }
  if (spec.abilities !== undefined && !Array.isArray(spec.abilities)) req(false, 'abilities', 'BAD_ABILITIES', 'abilities must be an array of { text }');
  if (spec.skills !== undefined && !Array.isArray(spec.skills)) req(false, 'skills', 'BAD_SKILLS', 'skills must be an array');
  if (errors.length) return { ok: false, errors };

  const motion = spec.motion ?? 'WALK';
  const dmgType = spec.dmgType ?? 'phys';
  const applyWay = spec.applyWay ?? 'MELEE';
  const stats = {};
  for (const [k, d] of Object.entries(ENEMY_STAT_DEFAULTS)) stats[k] = fin(st[k], d);
  // 官方数据里有 13 只怪同时打两种伤害（`stats.dmgTypes = ['phys','arts']`），而 spec 的 `dmgType` 只是单个枚举。
  // 于是 spec 允许给一个**显式覆盖** `dmgTypes`：以现成怪物为模板新建时它会被原样带过来，这样「复制」不会把
  // 双属性怪悄悄变成单属性。不给 `dmgTypes` 时行为与以前完全一样（由 `dmgType` 推导）。
  const dmgTypes = Array.isArray(spec.dmgTypes) && spec.dmgTypes.length
    ? spec.dmgTypes.filter((v) => ENEMY_DMG_TYPES.includes(v))
    : [];
  stats.dmgType = dmgType;
  stats.dmgTypes = dmgTypes.length ? dmgTypes : (dmgType === 'none' ? [] : [dmgType]);
  stats.motion = motion;
  stats.rangeRadius = fin(st.rangeRadius, applyWay === 'RANGED' ? 1.5 : 0);
  stats.rawRangeRadius = fin(st.rawRangeRadius, stats.rangeRadius);
  stats.immunities = Object.fromEntries(ENEMY_IMMUNITIES.map((k) => [k, isPlain(spec.immunities) ? spec.immunities[k] === true : false]));
  stats.otherImmunities = Array.isArray(spec.otherImmunities) ? spec.otherImmunities.filter((v) => typeof v === 'string') : [];
  const beFactor = fin(spec.beFactor, 1);
  const spine = typeof spec.spine === 'string' && spec.spine ? spec.spine : null;
  if (!spine) warnings.push('no spine: the enemy renders with the fallback model. Reusing an existing enemy prefab id is the only way to get real art without shipping assets.');
  if (dmgType !== 'none' && applyWay === 'RANGED' && !(stats.rangeRadius > 0)) warnings.push('a RANGED enemy with rangeRadius 0 can never reach anything');
  if (applyWay === 'NONE' && dmgType !== 'none') warnings.push(`applyWay NONE but dmgType ${dmgType}: the enemy cannot attack`);

  const enemy = {
    key: ids.key,
    name: spec.name,
    level: 0,
    rank: spec.rank ?? 'NORMAL',
    handbookIndex: null,
    desc: spec.desc ?? '',
    descRaw: spec.desc ?? '',
    applyWay,
    stats,
    abilities: (Array.isArray(spec.abilities) ? spec.abilities : []).map((a) => ({
      text: typeof a === 'string' ? a : String(a && a.text ? a.text : ''),
      textRaw: typeof a === 'string' ? a : String(a && a.text ? a.text : ''),
      format: (a && a.format) || 'NORMAL',
    })),
    talents: { bb: isPlain(spec.talents?.bb) ? { ...spec.talents.bb } : {}, bbStr: {} },
    skills: Array.isArray(spec.skills) ? spec.skills.map((s) => ({ ...s })) : [],
    notCountInTotal: spec.notCountInTotal === true,
    tags: Array.isArray(spec.tags) ? spec.tags.filter((t) => typeof t === 'string') : [],
    // ---- the three derived metrics
    be: battleEffectivenessOf(stats, beFactor),
    beFactor,
    attrPower: attrPowerOf(stats),
    // ---- facts a workshop enemy must state rather than inherit
    isFlyEnemy: spec.isFlyEnemy === undefined ? motion === 'FLY' : spec.isFlyEnemy === true,
    // it is NOT a token — it is spawned by a wave like any other enemy (the field means "only reachable via a token")
    tokenOnly: false,
    acTypes: Array.isArray(spec.acTypes) ? spec.acTypes.filter((t) => ENEMY_AC_TYPES.includes(t)) : [],
    acType: ENEMY_AC_TYPES.includes(spec.acType) ? spec.acType : null,
    templateSlot: null,          // not part of the official random generator until a faction lists it
    summons: [], inactiveIn: [], seasonOverride: null,
    iconId: ids.key,
    spine,
    modelScale: isFin(spec.modelScale) ? spec.modelScale : null,
    attackAnim: isPlain(spec.attackAnim) ? { ...spec.attackAnim } : null,
  };
  if (isPlain(spec.hitArea)) enemy.hitArea = { w: spec.hitArea.w, h: spec.hitArea.h, dx: fin(spec.hitArea.dx, 0), dy: fin(spec.hitArea.dy, 0) };
  if (isPlain(spec.sp)) enemy.sp = { type: spec.sp.type ?? null, maxSp: fin(spec.sp.maxSp, 0), initSp: fin(spec.sp.initSp, 0), increment: fin(spec.sp.increment, 0) };
  return { ok: true, enemy, warnings };
}

/**
 * `deriveEnemy` 的反方向：把一份已发布的怪物记录变成可继续编辑的 spec（「以现成怪物为模板新建」）。
 *
 * 对工坊作者来说，最难的从来不是填数值，而是**外观**：`spine` 必须是一个官方 prefab 键，填错了不会报错，
 * 只是在游戏里静默变成占位模型。以现成怪物为模板，这一项就自动是对的。
 *
 * 只搬 spec 真正拥有的字段；`key`/`level`/`be`/`attrPower`/`iconId`/`templateSlot` 这些推导量一律不搬
 * （搬过去反而会被 `validateEnemy` 当成手改推导量而报 STALE_DERIVED）。`id` 留空，避免撞官方 key。
 *
 * @param {object} rec 一份怪物记录（官方或工坊的都行）
 * @returns {object|null} 一份 spec（可直接交给 `deriveEnemy`），输入不是对象时返回 null
 */
export function specFromEnemyRecord(rec) {
  if (!isPlain(rec)) return null;
  const st = isPlain(rec.stats) ? rec.stats : {};
  const motion = ENEMY_MOTIONS.includes(st.motion) ? st.motion : (ENEMY_MOTIONS.includes(rec.motion) ? rec.motion : 'WALK');
  const dmgType = ENEMY_DMG_TYPES.includes(st.dmgType) ? st.dmgType : (ENEMY_DMG_TYPES.includes(rec.dmgType) ? rec.dmgType : 'phys');
  const spec = {
    id: '',
    name: typeof rec.name === 'string' ? rec.name : '',
    rank: ENEMY_RANKS.includes(rec.rank) ? rec.rank : 'NORMAL',
    applyWay: ENEMY_APPLY_WAYS.includes(rec.applyWay) ? rec.applyWay : 'MELEE',
    motion,
    dmgType,
    desc: typeof rec.desc === 'string' ? rec.desc : '',
    stats: {},
    abilities: (Array.isArray(rec.abilities) ? rec.abilities : []).map((a) => ({
      text: typeof a === 'string' ? a : String((a && a.text) || ''),
      format: (a && a.format) || 'NORMAL',
    })),
    talents: { bb: (isPlain(rec.talents) && isPlain(rec.talents.bb)) ? { ...rec.talents.bb } : {} },
    skills: Array.isArray(rec.skills) ? rec.skills.map((s) => ({ ...s })) : [],
    tags: Array.isArray(rec.tags) ? rec.tags.filter((v) => typeof v === 'string') : [],
    immunities: Object.fromEntries(ENEMY_IMMUNITIES.map((k) => [k, isPlain(st.immunities) ? st.immunities[k] === true : false])),
    otherImmunities: Array.isArray(st.otherImmunities) ? st.otherImmunities.filter((v) => typeof v === 'string') : [],
  };
  // 数值一律补全到 ENEMY_STAT_DEFAULTS：模板必须是「拿去就能派生」的，缺项会让 derive 直接报 BAD_NUMBER。
  for (const [k, d] of Object.entries(ENEMY_STAT_DEFAULTS)) spec.stats[k] = fin(st[k], d);
  // 两种伤害只在**与推导结果不一致**时显式带上：多属性（`['phys','arts']`）与官方的 `['none']` 都算不一致。
  const derivedTypes = dmgType === 'none' ? [] : [dmgType];
  if (Array.isArray(st.dmgTypes) && JSON.stringify(st.dmgTypes) !== JSON.stringify(derivedTypes)) {
    spec.dmgTypes = st.dmgTypes.filter((v) => ENEMY_DMG_TYPES.includes(v));
  }
  // rawRangeRadius 不在默认值表里，但 derive 会读它：官方数据里它与 rangeRadius 未必相等（首领常有），
  // 不原样带上就等于模板悄悄改了人家的射程。
  if (isFin(st.rawRangeRadius)) spec.stats.rawRangeRadius = st.rawRangeRadius;
  if (typeof rec.spine === 'string' && rec.spine) spec.spine = rec.spine;
  if (isFin(rec.modelScale)) spec.modelScale = rec.modelScale;
  if (isFin(rec.beFactor)) spec.beFactor = rec.beFactor;
  if (isPlain(rec.hitArea)) spec.hitArea = { w: rec.hitArea.w, h: rec.hitArea.h, dx: fin(rec.hitArea.dx, 0), dy: fin(rec.hitArea.dy, 0) };
  if (isPlain(rec.attackAnim)) spec.attackAnim = { ...rec.attackAnim };
  if (ENEMY_AC_TYPES.includes(rec.acType)) spec.acType = rec.acType;
  if (Array.isArray(rec.acTypes)) spec.acTypes = rec.acTypes.filter((v) => ENEMY_AC_TYPES.includes(v));
  if (isPlain(rec.sp)) spec.sp = { type: rec.sp.type ?? null, maxSp: fin(rec.sp.maxSp, 0), initSp: fin(rec.sp.initSp, 0), increment: fin(rec.sp.increment, 0) };
  if (rec.notCountInTotal === true) spec.notCountInTotal = true;
  if (rec.isFlyEnemy !== undefined) spec.isFlyEnemy = rec.isFlyEnemy === true;
  return spec;
}

/**
 * Validate one enemy record. Like the other validators: reports everything it can see, never throws, and `[]` is not a
 * proof of correctness (the derived metrics are RE-computed and compared, so a hand-typed `be` is caught).
 * @param {object} rec
 * @param {{ key?: string, officialIds?: Set<string>|string[] }} [opts]
 */
export function validateEnemy(rec, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  if (!isPlain(rec)) { err('', 'NOT_AN_OBJECT', 'record must be a JSON object'); return out; }
  const key = opts.key ?? rec.key;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_\-.:]{1,64}$/.test(key)) err('key', 'BAD_ID', `"${key}" is not a usable enemy key`);
  if (rec.key !== undefined && rec.key !== key) err('key', 'ID_MISMATCH', `key "${rec.key}" does not equal its map key "${key}"`);
  const official = opts.officialIds instanceof Set ? opts.officialIds : new Set(opts.officialIds || []);
  if (official.has(key)) {
    err('key', 'OFFICIAL_ID_COLLISION', `"${key}" already exists in the official data`, `replace it only on purpose: add "enemies:${key}" to the pack's overrides`);
  }
  if (typeof rec.name !== 'string' || !rec.name.trim()) err('name', 'MISSING', 'name is required');
  if (!ENEMY_RANKS.includes(rec.rank)) err('rank', 'BAD_ENUM', `rank must be one of ${ENEMY_RANKS.join(', ')}`);
  if (!ENEMY_APPLY_WAYS.includes(rec.applyWay)) err('applyWay', 'BAD_ENUM', `applyWay must be one of ${ENEMY_APPLY_WAYS.join(', ')}`);
  const st = rec.stats;
  if (!isPlain(st)) err('stats', 'MISSING', 'stats is required');
  else {
    if (!(isFin(st.maxHp) && st.maxHp > 0)) err('stats.maxHp', 'BAD_NUMBER', 'maxHp must be a positive number');
    for (const k of ['atk', 'def', 'res', 'moveSpeed']) if (!(isFin(st[k]) && st[k] >= 0)) err(`stats.${k}`, 'BAD_NUMBER', `${k} must be a number >= 0`);
    if (!(isFin(st.bat) && st.bat > 0)) err('stats.bat', 'BAD_NUMBER', 'bat must be > 0');
    if (!ENEMY_MOTIONS.includes(st.motion)) err('stats.motion', 'BAD_ENUM', `motion must be one of ${ENEMY_MOTIONS.join(', ')}`);
    if (!ENEMY_DMG_TYPES.includes(st.dmgType)) err('stats.dmgType', 'BAD_ENUM', `dmgType must be one of ${ENEMY_DMG_TYPES.join(', ')}`);
    if (!isPlain(st.immunities)) err('stats.immunities', 'MISSING', 'immunities must be an object of booleans');
    // the derived metrics must match the stats: a hand-typed be would swap the wrong number of enemies
    const wantBe = battleEffectivenessOf(st, fin(rec.beFactor, 1));
    if (rec.be !== undefined && rec.be !== wantBe) {
      err('be', 'STALE_DERIVED', `be is ${rec.be} but the stats give ${wantBe}`, 're-derive it (it drives the per-faction enemy replacement count)');
    }
    const wantPower = attrPowerOf(st);
    // A SEASON-OVERRIDDEN official enemy is deliberately priced from the enemy DATABASE rather than from its season
    // stats (build-data:1670), so its attrPower legitimately differs from what these stats compute. A workshop enemy has
    // no season override, so for it the comparison always applies.
    const pricedFromDatabase = Array.isArray(rec.seasonOverride) && rec.seasonOverride.length > 0;
    if (!pricedFromDatabase && rec.attrPower !== undefined && Math.abs((rec.attrPower ?? 0) - wantPower) > 1e-6) {
      err('attrPower', 'STALE_DERIVED', `attrPower is ${rec.attrPower} but the stats give ${wantPower}`, 're-derive it');
    }
    if (rec.be === undefined) err('be', 'MISSING_DERIVED', 'be is missing: it is derived, not authored');
    if (rec.attrPower === undefined) err('attrPower', 'MISSING_DERIVED', 'attrPower is missing: it is derived, not authored');
  }
  if (rec.tokenOnly === true) warn('tokenOnly', 'TOKEN_ONLY', 'tokenOnly is true: the enemy can only be spawned by a token, never by a wave');
  if (!Array.isArray(rec.abilities)) err('abilities', 'BAD_ABILITIES', 'abilities must be an array');
  if (!Array.isArray(rec.skills)) err('skills', 'BAD_SKILLS', 'skills must be an array');
  if (!Array.isArray(rec.tags)) err('tags', 'BAD_TAGS', 'tags must be an array');
  if (!isPlain(rec.talents)) err('talents', 'BAD_TALENTS', 'talents must be an object (use { bb: {} } for none)');
  if (!rec.spine) warn('spine', 'NO_SPINE', 'no spine: the enemy renders with the fallback model');
  if (rec.isFlyEnemy === true && st && st.motion !== 'FLY') warn('isFlyEnemy', 'FLY_MISMATCH', 'isFlyEnemy is true but motion is not FLY');
  if (st && st.motion === 'FLY' && rec.isFlyEnemy === false) warn('isFlyEnemy', 'FLY_MISMATCH', 'motion is FLY but isFlyEnemy is false: ground-only operators could hit it');
  return out;
}

/** The errors of a validation result. */
export const enemyErrors = (issues) => (Array.isArray(issues) ? issues.filter((i) => i.severity === 'error') : []);

/** A one-line power readout for the editor / CLI. */
export const enemyPowerLine = (rec) => {
  const st = rec && rec.stats ? rec.stats : {};
  return `attrPower ${rec?.attrPower ?? attrPowerOf(st)} · be ${rec?.be ?? battleEffectivenessOf(st, rec?.beFactor ?? 1)} (beFactor ${rec?.beFactor ?? 1})`;
};
