// shared/chessAuthoring.js — turn the handful of facts a human (or an AI) actually knows into a VALID workshop chess
// record pair, and validate a record with precise, machine-readable errors (docs/WORKSHOP.md, docs/prompts/).
//
// Why this module exists (the "one interface" rule): a data/chess.json record has ~30 fields, most of them mechanical
// (id linking, price from tier, dmgType/attackKind/projectile from the profession, immunities, status, empty talents).
// Asking a human — or an AI — to invent them is how a pack ends up subtly broken. So:
//
//   * `deriveChessRecord(spec)` fills every DERIVABLE field deterministically from a small spec, and leaves only the
//     genuinely creative parts (name, numbers, skill text/blackboard) to the author.
//   * `validateChessRecord(rec)` returns `{ field, code, message, hint }[]` — never throws, never half-validates — so an
//     AI can call it in a loop and fix what it reports, and the editor can show the same errors on the same rules.
//
// The most valuable check is `BB_UNKNOWN_KEY`: the generic kit (server/sim/content/generic.js) is what makes an operator
// fight with NO JavaScript at all, and it reads a fixed set of blackboard keys. An invented key silently does nothing —
// so it is reported as a warning. GENERIC_BB_KEYS mirrors that file; test/chessAuthoring.test.js guards the mirror.

/**
 * The professions THIS project's data uses — which are NOT the global Arknights class names. The mapping that bit us
 * once already (an entire class of operators was unauthorable, and three invented names were accepted but matched no
 * engine rule):
 *
 *   重装 = TANK (not DEFENDER) · 先锋 = PIONEER (not VANGUARD) · 特种 = SPECIAL (not SPECIALIST)
 *
 * Verified against data/chess.json, and test/chessAuthoring.test.js now asserts this list EQUALS the profession set the
 * official data actually uses — the same drift guard that kept GENERIC_BB_KEYS honest. An operator written with a name
 * the engine does not use is accepted by the format layer yet silently loses every `profession === '…'` aura and talent.
 */
export const PROFESSIONS = Object.freeze(['WARRIOR', 'SNIPER', 'CASTER', 'MEDIC', 'SUPPORT', 'TANK', 'SPECIAL', 'PIONEER']);

/** Sub-professions with a behaviour that changes combat classification or the normal attack. Everything else is fine. */
export const SUBPROF_ATTACK_KIND = Object.freeze({
  bard: 'none', phalanx: 'none', librator: 'none',
  lord: 'ranged', fortress: 'ranged', shotprotector: 'ranged', agent: 'ranged', hookmaster: 'ranged',
});
/** Sub-professions whose ranged attack cannot hit air units (投掷手 / 要塞 — docs/DATA.md §2.1). */
export const NO_HIT_FLY = Object.freeze(['fortress', 'skywalker']);

/**
 * Blackboard keys the generic kit understands (mirrors the key list in the header of server/sim/content/generic.js).
 * A skill may use only these and still fight with no hand-written kit; any other key is reported by the validator.
 */
export const GENERIC_BB_KEYS = Object.freeze([
  // stat modifiers
  'atk', 'def', 'max_hp', 'attack_speed', 'base_attack_time', 'magic_resistance', 'damage_scale', 'block_cnt',
  'taunt_level', 'damage_resistance', 'hp_recovery_per_sec', 'hp_recovery_per_sec_by_max_hp_ratio', 'sp_recovery_per_sec',
  'magic_resist_penetrate_fixed', 'def_penetrate_fixed', 'ability_range_forward_extend',
  // targeting / attack
  'max_target', 'atk_scale', 'heal_scale', 'times', 'range_radius',
  // ammo / duration
  'trigger_time', 'ammo', 'cnt', 'duration',
  // statuses: the VALUE is the duration in seconds; the `attack@` spelling applies it on hit, a plain key once at skill
  // start for a timed skill (generic.js STATUS_KEYS + its status block). There is no separate `*_duration` key.
  'stun', 'cold', 'sleep', 'fear', 'sluggish', 'root', 'unmovable',
  // elements, shields, displacement, counters
  'ep_damage_ratio', 'shield_max_hp_ratio', 'hp_ratio', 'shield_max_duration', 'force', 'aoe_cd', 'prob',
]);

/**
 * The base name of a blackboard key. generic.js reads stat/attack keys through a getter that tries the plain key, then
 * `attack@…`, then `skill@…` (and reads a status out of all three spellings too), so every canonical key is readable in
 * all three forms. Exactly ONE prefix is stripped — `attack@attack@x` is not a key.
 */
export function bbKeyBase(key) {
  const s = String(key);
  if (s.startsWith('attack@')) return s.slice('attack@'.length);
  if (s.startsWith('skill@')) return s.slice('skill@'.length);
  return s;
}

/** Whether the generic kit reads this blackboard key (in a spelling it accepts — see bbKeyProblem). */
export const isKnownBbKey = (key) => GENERIC_BB_KEYS.includes(bbKeyBase(key));

/**
 * Keys generic.js reads in ONE spelling only, with the line that proves it. Everything else accepts plain / `attack@` /
 * `skill@` because it goes through the getters at generic.js:48-67.
 *
 *   range_radius  `num(bb['attack@range_radius'])`  generic.js:182   → `attack@` only
 *   duration      `num(bb.duration)`               generic.js:258/281/303 → plain only
 *   aoe_cd        `num(bb.aoe_cd)`                 generic.js:352   → plain only
 *
 * This is the one blind spot of BB_UNKNOWN_KEY: writing `range_radius` plainly used to pass silently and then produce
 * no splash at all — the exact failure the check exists to prevent.
 */
export const BB_ATTACK_ONLY_KEYS = Object.freeze(['range_radius']);
export const BB_PLAIN_ONLY_KEYS = Object.freeze(['duration', 'aoe_cd']);

/**
 * What is wrong with a blackboard key, or null when the generic kit reads it as written.
 * @returns {'unknown'|'attack-only'|'plain-only'|null}
 */
export function bbKeyProblem(key) {
  const s = String(key);
  const form = s.startsWith('attack@') ? 'attack' : s.startsWith('skill@') ? 'skill' : 'plain';
  const base = bbKeyBase(s);
  if (!GENERIC_BB_KEYS.includes(base)) return 'unknown';
  if (BB_ATTACK_ONLY_KEYS.includes(base) && form !== 'attack') return 'attack-only';
  if (BB_PLAIN_ONLY_KEYS.includes(base) && form !== 'plain') return 'plain-only';
  return null;
}

/** Skill enums (server/sim/simdata.js normSpType / normTriggerRule / normalizeSkill). */
export const SKILL_TYPES = Object.freeze(['MANUAL', 'AUTO', 'PASSIVE']);
export const DURATION_TYPES = Object.freeze(['NONE', 'AMMO']);
export const SP_TYPES = Object.freeze([
  'INCREASE_WITH_TIME', 'INCREASE_WHEN_ATTACK', 'INCREASE_WHEN_TAKEN_DAMAGE', 'ON_DEPLOY',
]);
export const TRIGGER_RULES = Object.freeze(['DEFAULT', 'SKILL_RANGE', 'TAKE_DAMAGE', 'SP_FULL', 'SEARCH', 'CUSTOM_RANGE']);

/** Default attack grids (facing RIGHT). `melee` and the real rangeId "3-1" grid; longer ranges must be given explicitly. */
export const DEFAULT_MELEE_RANGE = Object.freeze([[0, 0], [0, 1]]);
export const DEFAULT_RANGED_RANGE = Object.freeze([
  [1, 0], [1, 1], [1, 2], [0, 0], [0, 1], [0, 2], [0, 3], [-1, 0], [-1, 1], [-1, 2],
]);

/** Price / rarity / merge by shop tier (economy.chessPrice and the pool's per-tier conventions). */
const TIER_DEFAULTS = Object.freeze({
  1: { price: 2, rarity: 1 }, 2: { price: 3, rarity: 2 }, 3: { price: 3, rarity: 3 },
  4: { price: 3, rarity: 4 }, 5: { price: 4, rarity: 5 }, 6: { price: 4, rarity: 6 },
});

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isPairGrid = (g) => Array.isArray(g) && g.length > 0
  && g.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1]));

/** Combat classification derived from the profession/sub-profession, mirroring docs/DATA.md §2.1 for workshop content. */
export function classify({ profession, subProfessionId, position, traitDesc = '' }) {
  const sub = typeof subProfessionId === 'string' ? subProfessionId : '';
  const pos = String(position || 'MELEE').toUpperCase();
  const prof = String(profession || 'WARRIOR').toUpperCase();
  const dmgType = (prof === 'MEDIC' && sub !== 'incantationmedic') || sub === 'bard' ? 'heal'
    : (prof === 'CASTER' || /法术伤害/.test(traitDesc)) ? 'arts'
      : 'phys';
  const attackKind = SUBPROF_ATTACK_KIND[sub] || (dmgType === 'heal' ? 'heal' : (pos === 'RANGED' ? 'ranged' : 'melee'));
  const canHitFly = attackKind === 'ranged' && !NO_HIT_FLY.includes(sub);
  const projectile = attackKind === 'none' || attackKind === 'melee' ? 'none'
    : dmgType === 'heal' ? 'orb' : dmgType === 'arts' ? 'bolt' : 'arrow';
  return { dmgType, attackKind, projectile, canHitFly };
}

/** `chess_ws_<slug>_a` / `_b` from a slug or an id. */
export function chessIds(idOrSlug) {
  const raw = String(idOrSlug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const slug = raw.startsWith('chess_ws_') ? raw.slice('chess_ws_'.length).replace(/_[ab]$/, '') : raw;
  if (!slug) return null;
  return { slug, base: `chess_ws_${slug}_a`, golden: `chess_ws_${slug}_b` };
}

/**
 * Build a valid base + elite record pair from an authoring spec.
 *
 * Spec (only `id`, `name`, `tier`, `profession`, `position` and `stats` are required):
 *   { id, name, appellation?, tier, profession, subProfessionId?, position, traitDesc?, assetsSpine?, assetsAvatar?,
 *     rangeGrid?, price?, rarity?, bonds?, stats: { normal:{…}, golden:{…} },
 *     skill: { name, desc, skillType?, durationType?, duration?, spType?, spCost?, initSp?, maxChargeTime?, bb?,
 *              rangeGrid?, triggerRule? },
 *     talents?: [{ name, desc, bb? }] }
 * Stats keys: maxHp, atk, def, res, cost, blockCnt, bat, aspd?, respawnTime?, spRecovery?, moveSpeed?
 *
 * @returns {{ ok: true, base: object, golden: object, warnings: string[] } | { ok: false, errors: Array<{field:string,code:string,message:string,hint?:string}> }}
 */
export function deriveChessRecord(spec) {
  const errors = [];
  const warnings = [];
  const req = (cond, field, code, message, hint) => { if (!cond) errors.push({ field, code, message, hint }); };
  if (!isPlainObj(spec)) return { ok: false, errors: [{ field: '', code: 'NOT_AN_OBJECT', message: 'spec must be a JSON object' }] };

  const ids = chessIds(spec.id);
  req(ids, 'id', 'BAD_ID', 'id must contain at least one letter or digit', 'e.g. "abyss_hunter"');
  req(typeof spec.name === 'string' && spec.name.trim(), 'name', 'MISSING', 'name is required');
  req(isIntIn(spec.tier, 1, 6), 'tier', 'BAD_TIER', 'tier must be an integer 1..6');
  req(PROFESSIONS.includes(String(spec.profession || '').toUpperCase()), 'profession', 'BAD_PROFESSION', `profession must be one of ${PROFESSIONS.join(', ')}`);
  req(['MELEE', 'RANGED'].includes(String(spec.position || '').toUpperCase()), 'position', 'BAD_POSITION', 'position must be MELEE or RANGED');
  for (const state of ['normal', 'golden']) {
    const st = isPlainObj(spec.stats) ? spec.stats[state] : null;
    req(isPlainObj(st), `stats.${state}`, 'MISSING', `stats.${state} is required`, 'both the normal and the elite state need numbers');
    if (isPlainObj(st)) {
      req(isFin(st.maxHp) && st.maxHp > 0, `stats.${state}.maxHp`, 'BAD_NUMBER', 'maxHp must be a positive number');
      for (const k of ['atk', 'def']) req(isFin(st[k]) && st[k] >= 0, `stats.${state}.${k}`, 'BAD_NUMBER', `${k} must be a number >= 0`);
      req(isFin(st.res) && st.res >= 0 && st.res <= 100, `stats.${state}.res`, 'BAD_NUMBER', 'res must be 0..100');
      req(isFin(st.bat) && st.bat > 0, `stats.${state}.bat`, 'BAD_NUMBER', 'bat (base attack time, seconds) must be > 0');
      req(isFin(st.cost) && st.cost >= 0, `stats.${state}.cost`, 'BAD_NUMBER', 'cost (DP) must be a number >= 0');
      req(isIntIn(st.blockCnt, 0, 9), `stats.${state}.blockCnt`, 'BAD_NUMBER', 'blockCnt must be an integer 0..9');
    }
  }
  const sk = isPlainObj(spec.skill) ? spec.skill : null;
  if (sk) {
    if (sk.skillType !== undefined) req(SKILL_TYPES.includes(String(sk.skillType).toUpperCase()), 'skill.skillType', 'BAD_ENUM', `skillType must be one of ${SKILL_TYPES.join(', ')}`);
    if (sk.spType !== undefined) req(SP_TYPES.includes(String(sk.spType).toUpperCase()), 'skill.spType', 'BAD_ENUM', `spType must be one of ${SP_TYPES.join(', ')}`);
    if (sk.triggerRule !== undefined) req(TRIGGER_RULES.includes(String(sk.triggerRule).toUpperCase()), 'skill.triggerRule', 'BAD_ENUM', `triggerRule must be one of ${TRIGGER_RULES.join(', ')}`);
    if (isPlainObj(sk.bb)) {
      for (const key of Object.keys(sk.bb)) {
        const problem = bbKeyProblem(key);
        if (problem === 'unknown') {
          warnings.push(`skill.bb["${key}"] is not a key the generic kit reads — it will do nothing without a hand-written kit (kits/<chessId>.js). See the key list in docs/prompts/operator-pack.md.`);
        } else if (problem === 'attack-only') {
          warnings.push(`skill.bb["${key}"] is read only as "attack@${key}" (generic.js) — the plain spelling does nothing.`);
        } else if (problem === 'plain-only') {
          warnings.push(`skill.bb["${key}"] is read only in its plain form (generic.js) — an attack@/skill@ prefix does nothing.`);
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const tier = spec.tier;
  const prof = String(spec.profession).toUpperCase();
  const position = String(spec.position).toUpperCase();
  const sub = typeof spec.subProfessionId === 'string' ? spec.subProfessionId : null;
  const cls = classify({ profession: prof, subProfessionId: sub, position, traitDesc: spec.traitDesc || '' });
  const rangeGrid = isPairGrid(spec.rangeGrid) ? spec.rangeGrid
    : (cls.attackKind === 'melee' || cls.attackKind === 'none' ? DEFAULT_MELEE_RANGE : DEFAULT_RANGED_RANGE);
  const td = TIER_DEFAULTS[tier];
  const spine = spec.assetsSpine || spec.assetsAvatar || null;
  if (!spine) warnings.push('no assetsSpine: the operator renders with the fallback look. Reusing an existing spine id is the only way to get real art without shipping assets.');

  const statusOf = (golden) => (golden
    ? { phase: 2, level: 60, skillLevel: 7, equipLevel: 0 }
    : { phase: 2, level: 1, skillLevel: 4, equipLevel: 0 });
  const normStats = (st) => ({
    maxHp: Math.round(st.maxHp), atk: Math.round(st.atk), def: Math.round(st.def), res: st.res,
    cost: Math.round(st.cost), blockCnt: st.blockCnt, bat: st.bat,
    aspd: isFin(st.aspd) ? st.aspd : 100,
    respawnTime: isFin(st.respawnTime) ? st.respawnTime : 70,
    spRecovery: isFin(st.spRecovery) ? st.spRecovery : 1,
    hpRecoveryPerSec: isFin(st.hpRecoveryPerSec) ? st.hpRecoveryPerSec : 0,
    moveSpeed: isFin(st.moveSpeed) ? st.moveSpeed : 1,
    tauntLevel: isFin(st.tauntLevel) ? st.tauntLevel : 0,
    massLevel: isFin(st.massLevel) ? st.massLevel : 0,
    deployLimit: 1, deckStack: 0,
  });
  const skillRecord = (golden) => {
    if (!sk) return null;
    const idx = 0;
    const rec = {
      skillId: `skchr_ws_${ids.slug}`, iconId: null,
      name: sk.name || spec.name, level: golden ? 7 : 4,
      desc: sk.desc || '', descRaw: sk.desc || '',
      skillType: String(sk.skillType || 'MANUAL').toUpperCase(),
      durationType: String(sk.durationType || 'NONE').toUpperCase(),
      duration: isFin(sk.duration) ? sk.duration : 0,
      spType: String(sk.spType || 'INCREASE_WITH_TIME').toUpperCase(),
      spCost: isFin(sk.spCost) ? sk.spCost : 0,
      initSp: isFin(sk.initSp) ? sk.initSp : 0,
      maxChargeTime: isIntIn(sk.maxChargeTime, 1, 9) ? sk.maxChargeTime : 1,
      increment: 1,
      bb: isPlainObj(sk.bb) ? { ...sk.bb } : {}, bbStr: {},
      rangeId: null, rangeGrid: isPairGrid(sk.rangeGrid) ? sk.rangeGrid : null,
      prefabId: null, overrideTokenKey: null,
      trigger: {
        rule: String(sk.triggerRule || 'DEFAULT').toUpperCase(),
        rawRule: String(sk.triggerRule || 'DEFAULT').toUpperCase(),
        customRangeGrid: null,
      },
      index: idx,
    };
    rec.isDefault = true;
    return rec;
  };
  const talentsOf = (golden) => (Array.isArray(spec.talents) ? spec.talents : []).map((t, i) => ({
    index: i, name: t && t.name ? t.name : null,
    desc: t && t.desc ? t.desc : null, descRaw: t && t.desc ? t.desc : null,
    bb: t && isPlainObj(t.bb) ? { ...t.bb } : {}, bbStr: {},
    rangeGrid: null, tokenKey: null, hidden: !(t && t.desc), fromModule: false,
  }));
  const commons = () => ({
    tier, isHidden: false, isDiy: false, visible: true, chessType: 'NORMAL',
    name: spec.name,
    appellation: typeof spec.appellation === 'string' && spec.appellation ? spec.appellation : spec.name,
    charId: null, profession: prof, subProfessionId: sub, subProfessionName: sub,
    position, nationId: null,
    bonds: Array.isArray(spec.bonds) ? [...spec.bonds] : [],
    garrisonIds: [], price: isFin(spec.price) ? spec.price : td.price, sellPrice: 1,
    immunities: { stun: false, silence: false, sleep: false, frozen: false, levitate: false },
    rangeId: null, rangeGrid, dmgType: cls.dmgType, attackKind: cls.attackKind, projectile: cls.projectile,
    canHitFly: cls.canHitFly, targetPriority: null,
    trait: { desc: spec.traitDesc || '', descRaw: spec.traitDesc || '', bb: {}, bbStr: {}, rangeGrid: null },
    tokens: [], module: null,
    assets: spine ? { avatar: spec.assetsAvatar || spine, portrait: spec.assetsAvatar || spine, spine, skillIcon: null, subProfIcon: null } : null,
    workshop: { schema: 1, id: ids.slug },
  });
  const base = {
    ...commons(),
    chessId: ids.base, baseId: ids.base, goldenId: ids.golden, isGolden: false,
    rarity: isFin(spec.rarity) ? spec.rarity : td.rarity,
    upgradeNum: 3, upgradeChessId: ids.golden,
    status: statusOf(false), stats: normStats(spec.stats.normal),
    skill: skillRecord(false), skills: sk ? [skillRecord(false)] : [],
    talents: talentsOf(false),
  };
  const golden = {
    ...commons(),
    chessId: ids.golden, baseId: ids.base, goldenId: ids.golden, isGolden: true,
    rarity: isFin(spec.rarity) ? spec.rarity : td.rarity,
    upgradeNum: 0, upgradeChessId: null,
    status: statusOf(true), stats: normStats(spec.stats.golden),
    skill: skillRecord(true), skills: sk ? [skillRecord(true)] : [],
    talents: talentsOf(true),
  };
  return { ok: true, base, golden, warnings };
}

/**
 * `deriveChessRecord` 的反方向：把一对已发布的记录（普通 `_a` + 精锐 `_b`）变成一份可继续编辑的 spec。
 *
 * 用途是「以现成干员为模板新建」：工坊作者最省事的起点不是一张空表单，而是一个已经能进游戏的干员——
 * 数值、职业、分支、攻击范围、技能与天赋全都填好，只需要改 id、名字与要改的那几个数字。
 *
 * 只搬 spec 真正拥有的字段（其余都是 derive 会重算的推导量，搬过来反而会互相矛盾）：
 * 身份、两态数值、攻击范围 `rangeGrid`、技能（含 `bb` 与技能范围）、天赋、羁绊、价格/稀有度。
 * `id` 一律留空——模板不能顺手把原干员的 id 也复制了，那会直接撞 `OFFICIAL_ID_COLLISION`。
 *
 * @param {object} base 普通形态记录（必填）
 * @param {object} [golden] 精锐形态记录；缺省时两态数值取同一份
 * @returns {object|null} 一份 spec（可直接交给 `deriveChessRecord`），输入不是对象时返回 null
 */
export function specFromChessRecord(base, golden) {
  if (!isPlainObj(base)) return null;
  const g = isPlainObj(golden) ? golden : base;
  const num = (v, fallback) => (isFin(v) ? v : fallback);
  const statsOf = (rec) => {
    const st = isPlainObj(rec.stats) ? rec.stats : {};
    const out = {
      maxHp: num(st.maxHp, 1400), atk: num(st.atk, 450), def: num(st.def, 140),
      res: num(st.res, 0), cost: num(st.cost, 18), blockCnt: num(st.blockCnt, 1), bat: num(st.bat, 1.2),
    };
    // 这几个不是必填，但作者通常调过：原样带上，省得模板与原件在再部署/攻速上悄悄不一致
    for (const k of ['aspd', 'respawnTime', 'spRecovery', 'hpRecoveryPerSec', 'moveSpeed']) {
      if (isFin(st[k])) out[k] = st[k];
    }
    return out;
  };
  const grid = (v) => (isPairGrid(v) ? v.map((p) => [...p]) : undefined);
  const skillOf = (sk) => {
    if (!isPlainObj(sk)) return undefined;
    const out = {
      name: typeof sk.name === 'string' ? sk.name : '',
      desc: typeof sk.desc === 'string' ? sk.desc : '',
      skillType: typeof sk.skillType === 'string' ? sk.skillType : 'MANUAL',
      durationType: typeof sk.durationType === 'string' ? sk.durationType : 'NONE',
      duration: num(sk.duration, 0),
      spType: typeof sk.spType === 'string' ? sk.spType : 'INCREASE_WITH_TIME',
      spCost: num(sk.spCost, 0), initSp: num(sk.initSp, 0), maxChargeTime: num(sk.maxChargeTime, 1),
      triggerRule: (isPlainObj(sk.trigger) && typeof sk.trigger.rule === 'string') ? sk.trigger.rule : 'DEFAULT',
      bb: isPlainObj(sk.bb) ? { ...sk.bb } : {},
    };
    const rg = grid(sk.rangeGrid);
    if (rg) out.rangeGrid = rg;
    return out;
  };
  const spec = {
    id: '', name: typeof base.name === 'string' ? base.name : '',
    appellation: typeof base.appellation === 'string' ? base.appellation : '',
    tier: base.tier, profession: base.profession,
    subProfessionId: typeof base.subProfessionId === 'string' ? base.subProfessionId : '',
    position: base.position,
    traitDesc: (isPlainObj(base.trait) && typeof base.trait.desc === 'string') ? base.trait.desc : '',
    assetsSpine: (isPlainObj(base.assets) && typeof base.assets.spine === 'string') ? base.assets.spine : '',
    stats: { normal: statsOf(base), golden: statsOf(g) },
    talents: Array.isArray(base.talents)
      ? base.talents.map((t) => ({ name: (t && t.name) || '', desc: (t && t.desc) || '', bb: (t && isPlainObj(t.bb)) ? { ...t.bb } : {} }))
      : [],
  };
  const rg = grid(base.rangeGrid);
  if (rg) spec.rangeGrid = rg;
  const sk = skillOf(base.skill);
  if (sk) spec.skill = sk;
  if (Array.isArray(base.bonds) && base.bonds.length) spec.bonds = [...base.bonds];
  if (isFin(base.price)) spec.price = base.price;
  if (isFin(base.rarity)) spec.rarity = base.rarity;
  return spec;
}

/**
 * Validate one (workshop or official) chess record. Returns every problem THIS layer can see; `[]` means it found none —
 * which is not a proof of correctness. It cannot see cross-record problems (the base/elite pair), whether the record is
 * shop-eligible, or what the sim does at runtime: tools/workshop-validate.mjs runs those extra layers.
 * @param {object} rec the record
 * @param {{ id?: string, officialIds?: Set<string>|string[] }} [opts] `id` defaults to the record's own id; `officialIds`
 *   turns an official-id collision into OFFICIAL_ID_COLLISION (the pack must declare it in overrides instead).
 * @returns {Array<{ field: string, code: string, message: string, hint?: string, severity: 'error'|'warning' }>}
 */
export function validateChessRecord(rec, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  if (!isPlainObj(rec)) { err('', 'NOT_AN_OBJECT', 'record must be a JSON object'); return out; }
  const id = opts.id ?? rec.chessId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.:]{1,64}$/.test(id)) err('chessId', 'BAD_ID', `"${id}" is not a usable id`);
  if (rec.chessId !== undefined && rec.chessId !== id) err('chessId', 'ID_MISMATCH', `chessId "${rec.chessId}" does not equal its key "${id}"`);
  const official = opts.officialIds instanceof Set ? opts.officialIds : new Set(opts.officialIds || []);
  if (official.has(id)) {
    err('chessId', 'OFFICIAL_ID_COLLISION', `"${id}" already exists in the official data`,
      `replace it only on purpose: add "chess:${id}" to the pack's overrides`);
  }
  const isGolden = rec.isGolden === true || /_b$/.test(String(id));
  if (isGolden && rec.isGolden !== true) warn('isGolden', 'IMPLIED', 'isGolden is implied by the _b suffix but not set');
  if (!isGolden && rec.isGolden === true) err('isGolden', 'CONFLICT', 'isGolden is true but the id does not end in _b');
  if (!isIntIn(rec.tier, 1, 6)) err('tier', 'BAD_TIER', 'tier must be an integer 1..6');
  if (!Number.isInteger(rec.rarity) || rec.rarity < 1 || rec.rarity > 6) warn('rarity', 'BAD_RARITY', 'rarity should be an integer 1..6');
  if (!PROFESSIONS.includes(String(rec.profession || '').toUpperCase())) err('profession', 'BAD_PROFESSION', `profession must be one of ${PROFESSIONS.join(', ')}`);
  if (!['MELEE', 'RANGED'].includes(String(rec.position || '').toUpperCase())) err('position', 'BAD_POSITION', 'position must be MELEE or RANGED');
  if (!isPairGrid(rec.rangeGrid)) err('rangeGrid', 'BAD_RANGE', 'rangeGrid must be a non-empty array of [dRow, dCol] integer pairs');
  if (rec.visible === false) warn('visible', 'NOT_VISIBLE', 'visible is false: the operator never enters the shop pool');
  const st = rec.stats;
  if (!isPlainObj(st)) err('stats', 'MISSING', 'stats is required');
  else {
    if (!(isFin(st.maxHp) && st.maxHp > 0)) err('stats.maxHp', 'BAD_NUMBER', 'maxHp must be a positive number');
    for (const k of ['atk', 'def']) if (!(isFin(st[k]) && st[k] >= 0)) err(`stats.${k}`, 'BAD_NUMBER', `${k} must be a number >= 0`);
    if (!(isFin(st.res) && st.res >= 0 && st.res <= 100)) err('stats.res', 'BAD_NUMBER', 'res must be 0..100');
    if (!(isFin(st.bat) && st.bat > 0)) err('stats.bat', 'BAD_NUMBER', 'bat must be > 0');
    if (!(isFin(st.cost) && st.cost >= 0)) err('stats.cost', 'BAD_NUMBER', 'cost must be a number >= 0');
  }
  const sk = rec.skill;
  if (sk !== null && sk !== undefined) {
    if (!isPlainObj(sk)) err('skill', 'BAD_SKILL', 'skill must be an object or null');
    else {
      if (!SKILL_TYPES.includes(String(sk.skillType || '').toUpperCase())) err('skill.skillType', 'BAD_ENUM', `skillType must be one of ${SKILL_TYPES.join(', ')}`);
      if (sk.durationType !== undefined && !DURATION_TYPES.includes(String(sk.durationType).toUpperCase())) err('skill.durationType', 'BAD_ENUM', `durationType must be one of ${DURATION_TYPES.join(', ')}`);
      if (!SP_TYPES.includes(String(sk.spType || '').toUpperCase())) err('skill.spType', 'BAD_ENUM', `spType must be one of ${SP_TYPES.join(', ')}`);
      if (!(isFin(sk.spCost) && sk.spCost >= 0)) err('skill.spCost', 'BAD_NUMBER', 'spCost must be a number >= 0');
      if (!(isFin(sk.initSp) && sk.initSp >= 0)) err('skill.initSp', 'BAD_NUMBER', 'initSp must be a number >= 0');
      if (isFin(sk.spCost) && isFin(sk.initSp) && sk.initSp > sk.spCost) warn('skill.initSp', 'INIT_OVER_COST', 'initSp is above spCost: the skill is ready at deployment');
      if (isFin(sk.duration) && sk.duration < -1) err('skill.duration', 'BAD_NUMBER', 'duration must be >= -1 (0 = instant, -1 = endless/ammo)');
      if (String(sk.skillType || '').toUpperCase() === 'MANUAL' && (!isFin(sk.spCost) || sk.spCost <= 0)) warn('skill.spCost', 'MANUAL_NO_COST', 'a MANUAL skill with spCost 0 fires immediately and forever');
      if (isPlainObj(sk.bb)) {
        const bases = new Set(Object.keys(sk.bb).map(bbKeyBase));
        for (const key of Object.keys(sk.bb)) {
          const problem = bbKeyProblem(key);
          if (problem === 'unknown') {
            warn(`skill.bb["${key}"]`, 'BB_UNKNOWN_KEY', `"${key}" is not read by the generic kit, so it does nothing without a hand-written kits/<chessId>.js`);
          } else if (problem === 'attack-only') {
            warn(`skill.bb["${key}"]`, 'BB_SPELLING', `generic.js reads this key only as "attack@${key}", so the plain spelling does nothing`);
          } else if (problem === 'plain-only') {
            warn(`skill.bb["${key}"]`, 'BB_SPELLING', `generic.js reads this key only in its plain form, so an attack@/skill@ prefix does nothing`);
          }
        }
        if (sk.durationType === 'AMMO' && !bases.has('trigger_time') && !bases.has('ammo') && !bases.has('cnt')) {
          warn('skill.bb', 'AMMO_NO_COUNT', 'durationType AMMO needs an ammo count: bb.trigger_time, bb.ammo or bb.cnt');
        }
      } else if (sk.durationType === 'AMMO' || (isFin(sk.duration) && sk.duration !== 0)) {
        warn('skill.bb', 'EMPTY_BB', 'the skill has a duration/ammo but no blackboard, so it changes no numbers');
      }
    }
  } else if (Array.isArray(rec.skills) && rec.skills.length > 0) {
    err('skill', 'SKILL_MISMATCH', 'skills[] is filled but skill is null — the engine fights with `skill`');
  }
  if (!Array.isArray(rec.talents)) err('talents', 'BAD_TALENTS', 'talents must be an array (use [] for none)');
  if (!Array.isArray(rec.bonds)) err('bonds', 'BAD_BONDS', 'bonds must be an array (use [] for none)');
  if (!isPlainObj(rec.immunities)) warn('immunities', 'MISSING', 'immunities is missing: the engine treats every immunity as false');
  if (!isPlainObj(rec.assets)) warn('assets', 'MISSING', 'assets is missing: the operator renders with the fallback look');
  // the elite link must be consistent, or a merge produces a piece the data cannot resolve
  if (!isGolden && rec.goldenId && rec.baseId !== id) warn('baseId', 'BAD_BASE', `baseId should equal the record id "${id}"`);
  if (isGolden && typeof rec.baseId === 'string' && !/_a$/.test(rec.baseId)) warn('baseId', 'BAD_BASE', 'an elite record\'s baseId should end in _a');
  return out;
}

/** The errors of a validation result (severity 'error'). */
export const authoringErrors = (issues) => (Array.isArray(issues) ? issues.filter((i) => i.severity === 'error') : []);
/** One-line-per-issue text, for a CLI or an editor panel. */
export function formatIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return 'no issues';
  return issues.map((i) => `${i.severity === 'error' ? 'ERROR' : 'WARN '} ${i.field || '(record)'} [${i.code}] ${i.message}${i.hint ? ` — ${i.hint}` : ''}`).join('\n');
}
