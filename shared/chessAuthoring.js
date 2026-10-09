// shared/chessAuthoring.js — turn the handful of facts a human (or an AI) actually knows into a VALID workshop chess
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
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
// fight with NO JavaScript at all, and it reads a fixed set of blackboard keys. An invented key silently does nothing —// so it is reported as a warning. GENERIC_BB_KEYS mirrors that file; test/chessAuthoring.test.js guards the mirror.

// 模组的「选了模组之后长什么样」只有一份实现（shared/loadoutRecord.js 的 composeStats / composeTalents，
// tools/build-data.mjs 与引擎都用它）：派生的精锐记录必须按同一套算术把默认模组烘进去，否则玩家选「不装备」
// 会得到带模组的数值 —— 这一类不一致不会报错，只会让作者的模组在游戏里表现不对。
import { composeStats, composeTalents } from './loadoutRecord.js';
import { talentAtRank, FULL_RANK } from './potential.js';

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

/**
 * 职业与位置的中英名（编辑器显示用；**引擎读的永远是上表里的大写枚举**）。
 *
 * 为什么单独列一份：职业枚举是数据里的英文缩写，而作者（以及任何看界面的人）认的是中文名。
 * 中文名按官方职业名（近卫 / 狙击 / …），英文名按官方英文版（Guard / Sniper / …）。界面显示成「近卫 WARRIOR」，
 * 这样作者既知道自己在选哪个职业，也看得见记录里真正写下去的字符串是什么。
 */
export const PROFESSION_NAMES = Object.freeze({
  WARRIOR: Object.freeze({ zh: '近卫', en: 'Guard' }),
  SNIPER: Object.freeze({ zh: '狙击', en: 'Sniper' }),
  CASTER: Object.freeze({ zh: '术师', en: 'Caster' }),
  MEDIC: Object.freeze({ zh: '医疗', en: 'Medic' }),
  SUPPORT: Object.freeze({ zh: '辅助', en: 'Supporter' }),
  TANK: Object.freeze({ zh: '重装', en: 'Defender' }),
  SPECIAL: Object.freeze({ zh: '特种', en: 'Specialist' }),
  PIONEER: Object.freeze({ zh: '先锋', en: 'Vanguard' }),
});

/** 部署位置的名称（`position` 只有两个取值；引擎按它决定干员能站哪些格）。 */
export const POSITION_NAMES = Object.freeze({
  MELEE: Object.freeze({ zh: '近战', en: 'Melee' }),
  RANGED: Object.freeze({ zh: '远程', en: 'Ranged' }),
});

/**
 * 攻击分类的三个字段（记录里的 `dmgType` / `attackKind` / `projectile`）＋ `canHitFly`。
 *
 * 平时它们由 `classify()` 按职业与分支推导（见下面），但**有特殊情况**：同分支的干员可能因为天赋、
 * 特性文字或官方特例而得到不同的分类。所以 spec 里可以显式覆盖这四个字段，覆盖优先于推导
 * （`deriveChessRecord` 的 `spec.dmgType` 等）—— 界面把「推导值 / 覆盖值」分开显示，避免作者以为改不掉。
 */
export const DMG_TYPES = Object.freeze(['phys', 'arts', 'heal', 'true', 'element']);
export const ATTACK_KINDS = Object.freeze(['melee', 'ranged', 'none', 'heal']);
export const PROJECTILES = Object.freeze(['none', 'arrow', 'bolt', 'orb']);

/**
 * 模组 `attr` 读的数值键（精锐数值 = 不带模组的 `statsBase` + 默认模组的 `attr`，见 shared/loadoutRecord.js 的
 * `composeStats`）。官方 184 个模组只用到这 8 个键。
 *
 * 为什么要列一份：写错键名（`atkScale`、`attack`）不会报任何错，模组看起来配好了、数值一点没变 —— 编辑器把它
 * 做成下拉，作者只能在真键里挑。少一个键就少一种模组，所以 test/chessModules.test.js 拿真实数据核对这张表。
 */
export const MODULE_ATTR_KEYS = Object.freeze(['maxHp', 'atk', 'def', 'res', 'aspd', 'cost', 'blockCnt', 'respawnTime']);

/** Sub-professions with a behaviour that changes combat classification or the normal attack. Everything else is fine. */
export const SUBPROF_ATTACK_KIND = Object.freeze({
  bard: 'none', phalanx: 'none', librator: 'none',
  lord: 'ranged', fortress: 'ranged', shotprotector: 'ranged', agent: 'ranged', hookmaster: 'ranged',
});
/** Sub-professions whose ranged attack cannot hit air units (要塞 fortress / 巡空者 skywalker — docs/DATA.md §2.1). */
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
/**
 * 自动释放的触发规则：**引擎里真的有分支**的那几条（server/sim/skills.js 的 TICK_RULES / rule 判断）。
 * 除此之外官方数据里还出现了两条自定义规则（`GDGLOW_SKILL_2` = 全场存在可选目标时释放，`MLYSS_WTRMAN` = 流形那类，
 * 由 kits 自己 activate）。它们不在这个表里，但**是合法的**（引擎的 normTriggerRule 原样放行任何字符串），
 * 所以校验层不能拒绝 —— 否则那三位官方干员连「以模板新建」都做不了。见下面的 KNOWN_CUSTOM_TRIGGER_RULES。
 */
export const TRIGGER_RULES = Object.freeze(['DEFAULT', 'SKILL_RANGE', 'TAKE_DAMAGE', 'SP_FULL', 'SEARCH', 'CUSTOM_RANGE']);
/** 引擎没有通用分支、但官方数据真的在用的自定义触发规则（写了不报错，但要知道它靠手写 kit 才动）。 */
export const KNOWN_CUSTOM_TRIGGER_RULES = Object.freeze(['GDGLOW_SKILL_2', 'MLYSS_WTRMAN', 'ACTIVE_RANGE']);
/** 触发规则的整体形状：大写字母数字下划线（引擎的 normTriggerRule 放行任何字符串，这里只挡明显的错别字）。 */
export const TRIGGER_RULE_RE = /^[A-Z][A-Z0-9_]{0,47}$/;

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
 * 覆盖模式（override mode）的 id：**原样保留官方 id，不加 `chess_ws_` 前缀**。
 *
 * 为什么是「平行函数」而不是给 `chessIds` 加开关：`chessIds` 有六个调用点（编辑器的保存 / 复校验 / 列表 /
 * 取回，以及 `deriveChessRecord` 自己）。让它「有时候加前缀、有时候不加」会让每个调用点都得先想清自己在哪种
 * 模式里 —— 那是静默错 id 的温床。默认路径（新建 / 复制）因此**一字不动**。
 *
 * 取值只用记录自己的字段（`baseId` / `goldenId`），**不做字符串手术**：普通与精锐是一对，
 * `chess_char_1_01_a` 的兄弟 `_b` 只能从记录里读出来 —— 官方 id 的后缀规则不是本仓库定的。
 *
 * @param {object} rec 官方（或包内已有的）干员记录
 * @returns {{ slug: string, base: string, golden: string|null }|null}
 */
export function overrideChessIds(rec) {
  if (!isPlainObj(rec)) return null;
  const id = typeof rec.chessId === 'string' && rec.chessId ? rec.chessId : null;
  if (!id) return null;
  const base = typeof rec.baseId === 'string' && rec.baseId ? rec.baseId : id;
  const golden = typeof rec.goldenId === 'string' && rec.goldenId ? rec.goldenId : null;
  return { slug: base, base, golden };
}

/**
 * Value equality for the chain rebuild below (arrays and plain objects deep; key order is irrelevant — a talent entry at
 * two ranks is the same entry when its values are equal, not when its keys happen to be inserted in the same order).
 */
const sameValue = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (!isPlainObj(a) || !isPlainObj(b)) return Number.isNaN(a) && Number.isNaN(b);
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length
    && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
};

/**
 * One talent entry as the data build writes its chain (tools/build-data.mjs chainTalent): the rank-`hi` entry, plus
 * `potMin` (the lowest rank that builds the same entry) and `potBelow` (the entry below it — only the fields it changes,
 * itself chained) when a lower rank builds something else.
 */
function chainTalent(vals, hi) {
  const node = vals[hi];
  let m = hi;
  while (m > 0 && sameValue(vals[m - 1], node)) m--;
  if (m === 0) return node;
  const below = chainTalent(vals, m - 1);
  const part = {};
  for (const [k, v] of Object.entries(below)) if (k === 'potMin' || k === 'potBelow' || !sameValue(v, node[k])) part[k] = v;
  return { ...node, potMin: m, potBelow: part };
}

/**
 * 带默认模组的精锐天赋，**连同潜能链一起**合并（`deriveChessRecord` 精锐侧的 `talents`）。
 *
 * 合并规则与 `composeTalents` **同一套**（覆盖已有 index：模组的值赢、模组没重述的键保留基础值；否则追加；空占位丢弃），
 * 注解按同一优先级一起合并。做法是逐档合并再链式化，与官方数据的生成方式一致（`tools/build-data.mjs` 的
 * `withPotentialData` / `chainTalent`）：`shared/potential.js` 的 `talentAtRank` 把基础天赋与每条模组改动解析到该档，
 * 每档交给 `composeTalents` 合并一次，最后按档位把结果写成 `potMin` / `potBelow`。于是：
 *   * 改动带了自己的 `potMin` / `potBelow` → **模组的值赢**（`chess_char_6_02_b` 精锐链用它那一份 105% / 100%）；
 *   * 改动没重述 → 保留基础天赋上那一份（链不会因为过一遍模组就消失）；
 *   * 追加的条目（`talentIndex` 为负）用它自己带的。
 * `potBelow` 是**部分条目**（没重述的字段沿用上一档的值），所以「照抄 change 的 potBelow」不够：`chess_char_6_05_b`
 * 的改动只重述 desc / descRaw，它的低档仍要用改动自己的 bb 与基础的 bb 合并。
 *
 * 为什么不直接用 `composeTalents`：它的口径就是「一个潜能档位的结果」，故意剥掉 `potMin` / `potBelow`
 * （`shared/loadoutRecord.js` 写明，引擎先解析潜能再合并）。而创作层必须把作者的数据原样还回去 —— 覆盖模式每次保存
 * 都用 spec 重新派生一遍盘上的记录（`regeneratePack`），派生时丢掉的链是找不回来的。逐档复用同一个合并函数，既保住
 * 「只有一份合并规则」，又让注解按该规则一起落下来。某一档合并出来的列表与满档不同形状（更低潜能下多/少一条天赋）时
 * 写不成链：此时原样返回满档合并结果（与旧行为一致，不猜）。
 */
function composeTalentsWithPotential(base, changes) {
  const top = composeTalents(base, changes);
  const base0 = Array.isArray(base) ? base : [];
  const ch0 = Array.isArray(changes) ? changes : [];
  const ranks = [];
  for (let r = 0; r < FULL_RANK; r++) {
    ranks.push(composeTalents(base0.map((t) => talentAtRank(t, r)), ch0.map((t) => talentAtRank(t, r))));
  }
  ranks.push(top);
  // 链是**按数组位置**写的（官方生成器如此，`index` 可以是 -1 且重复），所以形状必须逐档一致才敢写
  const shape = (l) => l.map((t) => t.index).join(',');
  if (!ranks.every((l) => l.length === top.length && shape(l) === shape(top))) return top;
  return top.map((_, i) => chainTalent(ranks.map((l) => l[i]), FULL_RANK));
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
 *
 * 第二个参数是**覆盖模式**的 id 对（`overrideChessIds` 的产出）：省略时走默认路径（`chessIds(spec.id)`，产出
 * `chess_ws_<slug>_a/_b`），**一字不变** —— 那是 A 段护身符钉住的。形状不对就等于没给。
 */
export function deriveChessRecord(spec, overrideIds) {
  const errors = [];
  const warnings = [];
  const req = (cond, field, code, message, hint) => { if (!cond) errors.push({ field, code, message, hint }); };
  if (!isPlainObj(spec)) return { ok: false, errors: [{ field: '', code: 'NOT_AN_OBJECT', message: 'spec must be a JSON object' }] };

  // 默认路径：`chessIds` 无条件加前缀。覆盖模式由调用方给出 id 对（官方 id 原样保留），**这里不猜** ——
  // 猜就是「有时候加前缀、有时候不加」，正是 A 段特意没做的那件事。形状不对就等于没给（回到默认路径）。
  // `golden` 可以是 null（官方那条没有精锐兄弟），那时给一个 `_b` 占位；校验器认不认是它的事。
  const ids = (overrideIds && typeof overrideIds.slug === 'string' && typeof overrideIds.base === 'string' && overrideIds.base)
    ? {
      slug: overrideIds.slug,
      base: overrideIds.base,
      golden: typeof overrideIds.golden === 'string' && overrideIds.golden ? overrideIds.golden : `${overrideIds.base}_b`,
    }
    : chessIds(spec.id);
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
    if (sk.triggerRule !== undefined) req(TRIGGER_RULE_RE.test(String(sk.triggerRule).toUpperCase()), 'skill.triggerRule', 'BAD_ENUM', 'triggerRule must be UPPER_SNAKE (e.g. DEFAULT, SP_FULL, GDGLOW_SKILL_2)');
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
  const clsRaw = classify({ profession: prof, subProfessionId: sub, position, traitDesc: spec.traitDesc || '' });
  // 分类的**显式覆盖**：平时按职业与分支推导，但同分支的干员可能因为天赋/特性文字/官方特例而不同
  // （例如「要塞」默认打不到空中，可有的干员就是能打）。写了就用写的，并在 warnings 里说明覆盖了推导值。
  const pick = (v, allowed, derived, field) => {
    if (v === undefined || v === null || v === '') return derived;
    const want = String(v).toLowerCase();
    if (!allowed.includes(want)) {
      errors.push({ field, code: 'BAD_ENUM', message: `${field} must be one of ${allowed.join(', ')}` });
      return derived;
    }
    if (want !== derived) warnings.push(`${field} 覆盖了按职业与分支推导的值（${derived} → ${want}）`);
    return want;
  };
  const forceFly = spec.canHitFly === undefined || spec.canHitFly === null ? null : spec.canHitFly === true;
  if (forceFly !== null && forceFly !== clsRaw.canHitFly) {
    warnings.push(`canHitFly 覆盖了按职业与分支推导的值（${clsRaw.canHitFly} → ${forceFly}）`);
  }
  const cls = {
    dmgType: pick(spec.dmgType, DMG_TYPES, clsRaw.dmgType, 'dmgType'),
    attackKind: pick(spec.attackKind, ATTACK_KINDS, clsRaw.attackKind, 'attackKind'),
    projectile: pick(spec.projectile, PROJECTILES, clsRaw.projectile, 'projectile'),
    canHitFly: forceFly === null ? clsRaw.canHitFly : forceFly,
  };
  // 分类覆盖可能刚刚报了错（枚举外的值），所以这里要再挡一次 —— 上面的 errors 检查在它之前
  if (errors.length) return { ok: false, errors };
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
  const talentList = (list) => (Array.isArray(list) ? list : []).map((t, i) => ({
    // `index` 官方是**稀疏**的（例：0、1、3 —— 中间那个位置没有天赋），所以照抄它，别按数组位置重排
    index: t && Number.isInteger(t.index) ? t.index : i, name: t && t.name ? t.name : null,
    desc: t && t.desc ? t.desc : null,
    // 天赋的富文本与自带范围官方也会写（`descRaw` 里的 `<$ba.stun>` 这类标记、范围型天赋的 rangeGrid），
    // 所以 spec 里都是可选字段：写了照抄（模板不丢格式），没写就退回纯文本 / null。
    descRaw: t && typeof t.descRaw === 'string' && t.descRaw ? t.descRaw : (t && t.desc ? t.desc : null),
    bb: t && isPlainObj(t.bb) ? { ...t.bb } : {}, bbStr: t && isPlainObj(t.bbStr) ? { ...t.bbStr } : {},
    rangeGrid: t && isPairGrid(t.rangeGrid) ? t.rangeGrid.map((p) => [...p]) : null,
    tokenKey: t && typeof t.tokenKey === 'string' && t.tokenKey ? t.tokenKey : null,
    // `hidden` 官方对占位天赋（desc 是 `-`）两种写法都有，所以照抄记录里的布尔值，别自己推
    hidden: t && typeof t.hidden === 'boolean' ? t.hidden : !(t && t.desc), fromModule: false,
    // 0.2.2 的潜能注解**原样穿过**：`potMin` = 这条天赋从哪一档起生效，`potBelow` = 更低那一档换掉的字段
    // （`shared/potential.js` 的链式天赋）。它们不是「派生器算出来的东西」，而是**来源记录带过来的事实**：
    // `specFromChessRecord` 本来就把它们搬进了 spec，派生时丢掉就等于**每存一次覆盖就抹一层潜能链**
    // （`regeneratePack` 会用 spec 重新派生一遍盘上已有的记录，所以丢在这里的注解是找不回来的）。
    // 引擎那一侧照旧：真正「某一档建出来的记录」由 `stripPotential` / `atRank` 负责，不是这里。
    ...(t && Number.isInteger(t.potMin) ? { potMin: t.potMin } : {}),
    ...(t && isPlainObj(t.potBelow) ? { potBelow: { ...t.potBelow } } : {}),
  }));  const talentsOf = (golden) => talentList(golden && Array.isArray(spec.talentsGolden) ? spec.talentsGolden : spec.talents);

  // 模组（`data/chess.json` 精锐记录的 `modules[]`）：官方那 184 个模组就是长这个形状，引擎按它算
  // 「选了这个模组之后干员的数值/特性/天赋长什么样」（shared/loadoutRecord.js composeStats / composeTalents）。
  // 只有精锐记录带模组（普通记录只有一个 `module` 指针，`active:false`）。
  const modules = (Array.isArray(spec.modules) ? spec.modules : []).map((m, i) => {
    const mid = m && typeof m.id === 'string' ? m.id.trim() : '';
    const typeNameRaw = m && typeof m.type === 'string' && m.type.trim() ? m.type.trim() : `WS-${'XYZ'[i] ?? 'Z'}`;
    const attrSrc = m && isPlainObj(m.attr) ? m.attr : {};
    const attr = {};
    for (const [k, v] of Object.entries(attrSrc)) if (isFin(v) && v !== 0) attr[k] = v;
    const traitBb = m && isPlainObj(m.traitBb) ? { ...m.traitBb } : {};
    const traitBbStr = m && isPlainObj(m.traitBbStr) ? { ...m.traitBbStr } : {};
    const hasTrait = !!(m && (typeof m.traitDesc === 'string' && m.traitDesc.trim() || typeof m.moduleDesc === 'string' && m.moduleDesc.trim() || Object.keys(traitBb).length || Object.keys(traitBbStr).length || isPairGrid(m.rangeGrid)));
    const traitOverride = hasTrait ? {
      desc: typeof m.traitDesc === 'string' ? m.traitDesc : '',
      // 原始富文本（`<@ba.kw>…</>` 这类标记）：官方记录里有，spec 里是可选的 `traitDescRaw`。
      // 写了就用它（覆盖官方/以模板新建时不丢格式），没写就与纯文本一致。
      descRaw: typeof m.traitDescRaw === 'string' && m.traitDescRaw ? m.traitDescRaw : (typeof m.traitDesc === 'string' ? m.traitDesc : ''),
      bb: { ...traitBb }, bbStr: { ...traitBbStr },
      rangeGrid: isPairGrid(m.rangeGrid) ? m.rangeGrid.map((p) => [...p]) : null,
      // 官方只有**有话说**的模组才带这两个键（空串的模组不带），所以这里也只在非空时写
      ...(typeof m.moduleDesc === 'string' && m.moduleDesc ? {
        moduleDesc: m.moduleDesc,
        moduleDescRaw: typeof m.moduleDescRaw === 'string' && m.moduleDescRaw ? m.moduleDescRaw : m.moduleDesc,
      } : {}),
    } : null;
    const talentChanges = (m && Array.isArray(m.talentChanges) ? m.talentChanges : []).map((ch, ci) => ({
      talentIndex: Number.isInteger(ch && ch.talentIndex) ? ch.talentIndex : -1,
      name: ch && typeof ch.name === 'string' && ch.name ? ch.name : null,
      desc: ch && typeof ch.desc === 'string' && ch.desc ? ch.desc : null,
      descRaw: ch && typeof ch.descRaw === 'string' && ch.descRaw ? ch.descRaw : (ch && typeof ch.desc === 'string' && ch.desc ? ch.desc : null),
      bb: ch && isPlainObj(ch.bb) ? { ...ch.bb } : {}, bbStr: {},
      rangeGrid: ch && isPairGrid(ch.rangeGrid) ? ch.rangeGrid.map((p) => [...p]) : null,
      tokenKey: ch && typeof ch.tokenKey === 'string' && ch.tokenKey ? ch.tokenKey : null,
      hidden: ch ? ch.hidden !== false : true,
      ...(Number.isInteger(ch && ch.skillIndex) ? { skillIndex: ch.skillIndex } : {}),
      // 潜能注解（0.2.2）：模组自己也能重述某条天赋的链（官方 `chess_char_6_02` 的默认模组就带），
      // 这两条同样不许在派生时丢掉 —— `composeTalentsWithPotential` 按「模组的值赢」把它并进精锐侧。
      ...(Number.isInteger(ch && ch.potMin) ? { potMin: ch.potMin } : {}),
      ...(isPlainObj(ch && ch.potBelow) ? { potBelow: { ...ch.potBelow } } : {}),
      _ci: ci,
    }));
    for (const ch of talentChanges) delete ch._ci;
    return {
      uniEquipId: mid, name: m && typeof m.name === 'string' && m.name ? m.name : mid,
      // `typeIcon` 在官方数据里**不是**总等于小写的 typeName（例：DEC-X 那组写的是 `dec-X`），
      // 所以 spec 里可以显式给一个；没给才按 typeName 推。
      typeName: typeNameRaw,
      typeIcon: m && typeof m.typeIcon === 'string' && m.typeIcon ? m.typeIcon : typeNameRaw.toLowerCase(),
      icon: mid,
      isDefault: !!(m && m.isDefault === true),
      level: isIntIn(m && m.level, 1, 3) ? m.level : 1,
      attr, traitOverride, talentChanges,
    };
  });
  // 默认模组：官方每个精锐恰好一个 `isDefault`。没有默认时精英就是「不带模组」的原样。
  const defaultModule = modules.find((m) => m.isDefault) ?? null;
  if (modules.length && !defaultModule) {
    warnings.push('模组列表里没有 isDefault: true 的那一个：精锐记录会按「不带模组」生成，玩家在载入界面仍能选这些模组。');
  }
  const modulePointer = (golden) => ({
    id: defaultModule ? defaultModule.uniEquipId : null,
    name: defaultModule ? defaultModule.name : null,
    type: defaultModule ? defaultModule.typeName : null,
    // 官方形状：普通记录 level 0 / active false（没有模组时官方写的是 1），精锐记录是默认模组的 level（没有模组时 1）
    level: defaultModule ? (golden ? defaultModule.level : 0) : 1,
    active: golden && !!defaultModule,
  });

  const commons = () => ({
    tier, isHidden: false, isDiy: false, visible: true, chessType: 'NORMAL',
    // 「试玩时直接发到手上」（业主 2026-10-08 的开关）：默认 false，只有作者在干员页勾了才写进记录。
    // 引擎侧唯一的读者是 Match.grantDirectToHand，而它只在编辑器 spawn 的试玩服务器里发牌（SP_PLAYTEST=1）——
    // 正式对局即使装了这个包，干员仍然只在商店里被摇到（0.5.0 起「助战不白送」的口径不变）。
    directToHand: spec.directToHand === true,
    name: spec.name,
    appellation: typeof spec.appellation === 'string' && spec.appellation ? spec.appellation : spec.name,
    charId: null, profession: prof, subProfessionId: sub,
    // 分支的中文名：官方记录里是 `subProfessionName`（如 reaper → 收割者），界面与图鉴都显示它
    subProfessionName: typeof spec.subProfessionName === 'string' && spec.subProfessionName ? spec.subProfessionName : (sub ?? null),
    position, nationId: null,
    bonds: Array.isArray(spec.bonds) ? [...spec.bonds] : [],
    garrisonIds: [], price: isFin(spec.price) ? spec.price : td.price, sellPrice: 1,
    immunities: { stun: false, silence: false, sleep: false, frozen: false, levitate: false },
    rangeId: null, rangeGrid, dmgType: cls.dmgType, attackKind: cls.attackKind, projectile: cls.projectile,
    canHitFly: cls.canHitFly, targetPriority: null,
    trait: { ...traitBaseObj },
    tokens: [],
    assets: spine ? { avatar: spec.assetsAvatar || spine, portrait: spec.assetsAvatar || spine, spine, skillIcon: null, subProfIcon: null } : null,
    workshop: { schema: 1, id: ids.slug },
  });
  // 精锐的数值/特性/天赋分两套：`*Base` 是**不带模组**的原样，`stats`/`trait`/`talents` 是**带默认模组**的样子。
  // 官方数据就是这么生成的（tools/build-data.mjs 的 composeStats / composeTalents），玩家换成别的模组时
  // 引擎从 `*Base` 重算 —— 少了这一半，选「不装备」会得到带模组的数值。
  const goldenStatsBase = normStats(spec.stats.golden);
  // 精锐（精英 2）的特性与普通不同时（官方 26 位干员如此，例：链术师 3 → 4 个跳跃目标），spec 里用
  // `traitGolden` 单独给一份；没给就是与普通一份。少了它，模板出来的干员精锐特性会退回普通那一档。
  const traitFrom = (o, fallback) => ({
    desc: typeof o.desc === 'string' ? o.desc : (fallback.desc || ''),
    descRaw: typeof o.descRaw === 'string' && o.descRaw ? o.descRaw : (typeof o.desc === 'string' ? o.desc : (fallback.descRaw || '')),
    bb: isPlainObj(o.bb) ? { ...o.bb } : { ...fallback.bb },
    bbStr: isPlainObj(o.bbStr) ? { ...o.bbStr } : { ...fallback.bbStr },
    rangeGrid: isPairGrid(o.rangeGrid) ? o.rangeGrid.map((p) => [...p]) : (fallback.rangeGrid ?? null),
  });
  const traitBaseObj = {
    desc: spec.traitDesc || '',
    descRaw: typeof spec.traitDescRaw === 'string' && spec.traitDescRaw ? spec.traitDescRaw : (spec.traitDesc || ''),
    bb: isPlainObj(spec.traitBb) ? { ...spec.traitBb } : {},
    bbStr: isPlainObj(spec.traitBbStr) ? { ...spec.traitBbStr } : {},
    rangeGrid: isPairGrid(spec.traitRangeGrid) ? spec.traitRangeGrid.map((p) => [...p]) : null,
  };
  const goldenTraitBase = isPlainObj(spec.traitGolden) ? traitFrom(spec.traitGolden, traitBaseObj) : { ...traitBaseObj };
  const goldenTalentsBase = talentsOf(true);
  if (Array.isArray(spec.talentsGolden) && JSON.stringify(spec.talentsGolden) !== JSON.stringify(spec.talents ?? [])) {
    warnings.push('spec.talentsGolden 与 spec.talents 不同：精锐记录用的是精锐那一份（官方有 38 位干员两态天赋数值不同）');
  }
  const base = {
    ...commons(),
    chessId: ids.base, baseId: ids.base, goldenId: ids.golden, isGolden: false,
    rarity: isFin(spec.rarity) ? spec.rarity : td.rarity,
    upgradeNum: 3, upgradeChessId: ids.golden,
    status: statusOf(false), stats: normStats(spec.stats.normal),
    skill: skillRecord(false), skills: sk ? [skillRecord(false)] : [],
    talents: talentsOf(false),
    module: modulePointer(false),
  };
  const golden = {
    ...commons(),
    chessId: ids.golden, baseId: ids.base, goldenId: ids.golden, isGolden: true,
    rarity: isFin(spec.rarity) ? spec.rarity : td.rarity,
    upgradeNum: 0, upgradeChessId: null,
    status: statusOf(true),
    // 精锐自己的范围（官方少数干员精英扩范围）：没写就与普通一份
    ...(isPairGrid(spec.rangeGridGolden) ? { rangeGrid: spec.rangeGridGolden.map((p) => [...p]) } : {}),
    statsBase: goldenStatsBase, traitBase: goldenTraitBase, talentsBase: goldenTalentsBase,
    stats: defaultModule ? composeStats(goldenStatsBase, defaultModule.attr) : goldenStatsBase,
    trait: defaultModule && defaultModule.traitOverride ? { ...defaultModule.traitOverride } : goldenTraitBase,
    talents: defaultModule ? composeTalentsWithPotential(goldenTalentsBase, defaultModule.talentChanges) : goldenTalentsBase,
    modules: Array.isArray(spec.modules) ? modules.map((m) => ({ ...m })) : undefined,
    module: modulePointer(true),
    skill: skillRecord(true), skills: sk ? [skillRecord(true)] : [],
  };
  if (!Array.isArray(spec.modules)) delete golden.modules;
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
    for (const k of ['aspd', 'respawnTime', 'spRecovery', 'hpRecoveryPerSec', 'moveSpeed', 'tauntLevel', 'massLevel']) {
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
  /** 天赋的紧凑 spec 形状（可选字段只在「与默认不同」时才写，免得每个模板都带一大堆 null）。 */
  const slimTalents = (list) => (Array.isArray(list) ? list : []).map((t, i) => {
    const out = { name: (t && t.name) || '', desc: (t && t.desc) || '', bb: (t && isPlainObj(t.bb)) ? { ...t.bb } : {} };
    if (t && Number.isInteger(t.index) && t.index !== i) out.index = t.index;
    if (t && typeof t.descRaw === 'string' && t.descRaw && t.descRaw !== t.desc) out.descRaw = t.descRaw;
    if (t && isPlainObj(t.bbStr) && Object.keys(t.bbStr).length) out.bbStr = { ...t.bbStr };
    if (t && isPairGrid(t.rangeGrid)) out.rangeGrid = t.rangeGrid.map((p) => [...p]);
    if (t && typeof t.tokenKey === 'string' && t.tokenKey) out.tokenKey = t.tokenKey;
    if (t && typeof t.hidden === 'boolean') out.hidden = t.hidden;
    // 潜能注解（0.2.2）：这是**来源记录带过来的事实**，不是可以省略的元数据。覆盖模式把官方原文读成 spec、
    // 再派生回去，所以这里少搬一次，作者每存一次就会抹掉官方的一层潜能链（`deriveChessRecord` 的 `talentList`
    // 也会原样带出来，两头对齐）。
    if (t && Number.isInteger(t.potMin)) out.potMin = t.potMin;
    if (t && isPlainObj(t.potBelow)) out.potBelow = { ...t.potBelow };
    return out;
  });
  const spec = {
    id: '', name: typeof base.name === 'string' ? base.name : '',
    appellation: typeof base.appellation === 'string' ? base.appellation : '',
    tier: base.tier, profession: base.profession,
    // 「试玩时直接发到手上」：只有试玩服务器会读它（Match.grantDirectToHand），正式对局照样只在商店里摇
    ...(base.directToHand === true ? { directToHand: true } : {}),
    subProfessionId: typeof base.subProfessionId === 'string' ? base.subProfessionId : '',
    subProfessionName: typeof base.subProfessionName === 'string' ? base.subProfessionName : '',
    position: base.position,
    traitDesc: (isPlainObj(base.trait) && typeof base.trait.desc === 'string') ? base.trait.desc : '',
    ...(isPlainObj(base.trait) && typeof base.trait.descRaw === 'string' && base.trait.descRaw && base.trait.descRaw !== base.trait.desc
      ? { traitDescRaw: base.trait.descRaw } : {}),
    ...(isPlainObj(base.trait) && isPlainObj(base.trait.bb) && Object.keys(base.trait.bb).length ? { traitBb: { ...base.trait.bb } } : {}),
    ...(isPlainObj(base.trait) && isPlainObj(base.trait.bbStr) && Object.keys(base.trait.bbStr).length ? { traitBbStr: { ...base.trait.bbStr } } : {}),
    ...(isPlainObj(base.trait) && isPairGrid(base.trait.rangeGrid) ? { traitRangeGrid: base.trait.rangeGrid.map((p) => [...p]) } : {}),
    assetsSpine: (isPlainObj(base.assets) && typeof base.assets.spine === 'string') ? base.assets.spine : '',
    stats: {
      normal: statsOf(base),
      // **必须读 `statsBase`**：精锐记录的 `stats` 已经把默认模组的 attr 烘进去了，直接用它会和 spec.modules
      // 里的 attr 叠加两次（一次是搬过来的数值、一次是派生的默认模组）。官方记录两个字段都在，工坊记录也可能只有 stats。
      golden: statsOf(isPlainObj(g.statsBase) ? { ...g, stats: g.statsBase } : g),
    },
    talents: slimTalents(base.talents),
  };
  // 精锐（Lv7）的天赋与普通（Lv4）不同时（官方 38 位干员如此，例如弹药上限 +2 → +3），把精锐那一份单独带进 spec：
  // 少了它，「以模板新建」出来的干员精锐态会退回普通态的数值 —— 而模组的 talentChanges 正是改在精锐那一份上。
  const talentsBaseOf = Array.isArray(g.talentsBase) ? g.talentsBase : null;
  // 精锐特性与普通特性不同（精英 2 那一档）时带上精锐那一份
  if (isPlainObj(g.traitBase) && JSON.stringify(g.traitBase) !== JSON.stringify(isPlainObj(base.trait) ? base.trait : null)) {
    spec.traitGolden = {
      desc: typeof g.traitBase.desc === 'string' ? g.traitBase.desc : '',
      ...(typeof g.traitBase.descRaw === 'string' && g.traitBase.descRaw && g.traitBase.descRaw !== g.traitBase.desc ? { descRaw: g.traitBase.descRaw } : {}),
      ...(isPlainObj(g.traitBase.bb) && Object.keys(g.traitBase.bb).length ? { bb: { ...g.traitBase.bb } } : {}),
      ...(isPlainObj(g.traitBase.bbStr) && Object.keys(g.traitBase.bbStr).length ? { bbStr: { ...g.traitBase.bbStr } } : {}),
      ...(isPairGrid(g.traitBase.rangeGrid) ? { rangeGrid: g.traitBase.rangeGrid.map((p) => [...p]) } : {}),
    };
  }
  if (talentsBaseOf) {
    const slim = slimTalents(talentsBaseOf);
    if (JSON.stringify(slim) !== JSON.stringify(spec.talents)) spec.talentsGolden = slim;
  }
  const rg = grid(base.rangeGrid);
  if (rg) spec.rangeGrid = rg;
  // 精锐自己的攻击范围可能与普通不同（官方有少数干员精英扩范围），所以单独留一个可选字段
  if (isPairGrid(g.rangeGrid) && JSON.stringify(g.rangeGrid) !== JSON.stringify(base.rangeGrid)) spec.rangeGridGolden = g.rangeGrid.map((p) => [...p]);
  const sk = skillOf(base.skill);
  if (sk) spec.skill = sk;
  if (Array.isArray(base.bonds) && base.bonds.length) spec.bonds = [...base.bonds];
  if (isFin(base.price)) spec.price = base.price;
  if (isFin(base.rarity)) spec.rarity = base.rarity;
  // 分类的显式覆盖：只有与原记录**推导值不同**时才写进 spec，否则每个模板都会带上一份冗余的覆盖，
  // 作者照着改一个职业之后发现分类还钉在旧值上（这正是「留出接口」最容易被误用的地方）。
  const derived = classify({
    profession: base.profession, subProfessionId: base.subProfessionId, position: base.position,
    traitDesc: (isPlainObj(base.trait) && typeof base.trait.desc === 'string') ? base.trait.desc : '',
  });
  for (const k of ['dmgType', 'attackKind', 'projectile']) {
    if (typeof base[k] === 'string' && base[k] && base[k] !== derived[k]) spec[k] = base[k];
  }
  if (typeof base.canHitFly === 'boolean' && base.canHitFly !== derived.canHitFly) spec.canHitFly = base.canHitFly;
  // 模组：整套搬过来（精锐记录的 modules[]；普通记录没有）。以模板新建时模组是可继续编辑的底子，
  // 不是「原件专属」—— 这正是作者最想要的部分。
  const mods = Array.isArray(g.modules) ? g.modules : (Array.isArray(base.modules) ? base.modules : null);
  // 官方对「有模组概念但一个都没配」的干员写的是 `modules: []`（而不是缺字段），所以模板也照抄这个空数组
  if (mods && !mods.length) spec.modules = [];
  if (mods && mods.length) {
    spec.modules = mods.filter(isPlainObj).map((m) => {
      const out = {
        id: typeof m.uniEquipId === 'string' ? m.uniEquipId : '',
        name: typeof m.name === 'string' ? m.name : '',
        type: typeof m.typeName === 'string' ? m.typeName : '',
        // 只在 typeIcon 与「typeName 的小写」不一致时才写进 spec（官方有这种例外；一致时写了只是噪音）
        ...(typeof m.typeIcon === 'string' && m.typeIcon && m.typeIcon !== String(m.typeName || '').toLowerCase() ? { typeIcon: m.typeIcon } : {}),
        isDefault: m.isDefault === true,
        level: isIntIn(m.level, 1, 3) ? m.level : 1,
        attr: isPlainObj(m.attr) ? { ...m.attr } : {},
      };
      const to = isPlainObj(m.traitOverride) ? m.traitOverride : null;
      if (to) {
        if (typeof to.desc === 'string') out.traitDesc = to.desc;
        if (typeof to.descRaw === 'string' && to.descRaw && to.descRaw !== to.desc) out.traitDescRaw = to.descRaw;
        if (isPlainObj(to.bb)) out.traitBb = { ...to.bb };
        if (typeof to.moduleDesc === 'string' && to.moduleDesc) out.moduleDesc = to.moduleDesc;
        if (typeof to.moduleDescRaw === 'string' && to.moduleDescRaw && to.moduleDescRaw !== to.moduleDesc) out.moduleDescRaw = to.moduleDescRaw;
        if (isPlainObj(to.bbStr) && Object.keys(to.bbStr).length) out.traitBbStr = { ...to.bbStr };
        const mg = grid(to.rangeGrid);
        if (mg) out.rangeGrid = mg;
      }
      if (Array.isArray(m.talentChanges) && m.talentChanges.length) {
        out.talentChanges = m.talentChanges.filter(isPlainObj).map((ch) => {
          const c = {
            talentIndex: Number.isInteger(ch.talentIndex) ? ch.talentIndex : -1,
            name: typeof ch.name === 'string' ? ch.name : null,
            desc: typeof ch.desc === 'string' ? ch.desc : null,
            bb: isPlainObj(ch.bb) ? { ...ch.bb } : {},
          };
          if (typeof ch.descRaw === 'string' && ch.descRaw && ch.descRaw !== ch.desc) c.descRaw = ch.descRaw;
          if (isPlainObj(ch.bbStr) && Object.keys(ch.bbStr).length) c.bbStr = { ...ch.bbStr };
          if (typeof ch.tokenKey === 'string' && ch.tokenKey) c.tokenKey = ch.tokenKey;
          if (ch.hidden === false) c.hidden = false;
          // 潜能注解（0.2.2）：模组改动自带的链要一起搬进 spec，否则「记录 → spec → 记录」这一趟就把它丢了。
          if (Number.isInteger(ch.potMin)) c.potMin = ch.potMin;
          if (isPlainObj(ch.potBelow)) c.potBelow = { ...ch.potBelow };
          const cg = grid(ch.rangeGrid);
          if (cg) c.rangeGrid = cg;
          return c;
        });
      }
      return out;
    });
  }
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
  // 攻击分类（引擎直接读这三个字段 + canHitFly）：值必须在枚举里，否则引擎会拿它去比对却永远不相等
  if (!DMG_TYPES.includes(String(rec.dmgType))) err('dmgType', 'BAD_ENUM', `dmgType must be one of ${DMG_TYPES.join(', ')}`);
  if (!ATTACK_KINDS.includes(String(rec.attackKind))) err('attackKind', 'BAD_ENUM', `attackKind must be one of ${ATTACK_KINDS.join(', ')}`);
  if (rec.projectile !== undefined && rec.projectile !== null && !PROJECTILES.includes(String(rec.projectile))) {
    err('projectile', 'BAD_ENUM', `projectile must be one of ${PROJECTILES.join(', ')}`);
  }
  if (typeof rec.canHitFly !== 'boolean') warn('canHitFly', 'MISSING', 'canHitFly is not a boolean: the engine treats it as falsy');
  // 分类是不是「推导值」：不是的话说明作者显式覆盖了它 —— 这不是错，但要在界面上说得出来
  const clsDerived = classify({ profession: rec.profession, subProfessionId: rec.subProfessionId, position: rec.position, traitDesc: isPlainObj(rec.trait) ? rec.trait.desc : '' });
  const overridden = ['dmgType', 'attackKind', 'projectile'].filter((k) => typeof rec[k] === 'string' && rec[k] !== clsDerived[k]);
  if (typeof rec.canHitFly === 'boolean' && rec.canHitFly !== clsDerived.canHitFly) overridden.push('canHitFly');
  if (overridden.length) {
    warn('dmgType', 'CLASS_OVERRIDE', `this operator overrides the derived attack class (${overridden.join(', ')}): 职业与分支推导的是 ${clsDerived.dmgType}/${clsDerived.attackKind}，记录里写的是 ${rec.dmgType}/${rec.attackKind}`);
  }
  // 模组：只有精锐能带；每个模组必须有 id / 唯一、一个默认、attr 是数字、traitOverride.bb 的键通用 kit 认识
  if (rec.modules !== undefined) {
    const mods = rec.modules;
    if (!Array.isArray(mods)) err('modules', 'BAD_MODULES', 'modules must be an array of module records');
    else if (!rec.isGolden && mods.length) warn('modules', 'MODULES_ON_NORMAL', 'modules are only read on the elite (_b) record: the normal record\'s modules are ignored');
    else {
      const seen = new Set();
      let defaults = 0;
      mods.forEach((m, i) => {
        const at = `modules[${i}]`;
        if (!isPlainObj(m)) { err(at, 'BAD_MODULE', 'a module must be an object'); return; }
        if (typeof m.uniEquipId !== 'string' || !/^[A-Za-z0-9_\-.:]{1,64}$/.test(m.uniEquipId)) err(`${at}.uniEquipId`, 'BAD_ID', 'uniEquipId must be a usable id');
        else if (seen.has(m.uniEquipId)) err(`${at}.uniEquipId`, 'DUPLICATE', `"${m.uniEquipId}" is listed twice`);
        else seen.add(m.uniEquipId);
        if (typeof m.name !== 'string' || !m.name) warn(`${at}.name`, 'MISSING', 'a module without a name shows its id in the loadout screen');
        if (m.isDefault === true) defaults++;
        if (m.level !== undefined && !isIntIn(m.level, 1, 3)) warn(`${at}.level`, 'BAD_LEVEL', 'module level should be 1..3 (officially 1 or 3)');
        if (m.attr !== undefined) {
          if (!isPlainObj(m.attr)) err(`${at}.attr`, 'BAD_ATTR', 'attr must be an object of flat stat bonuses');
          else for (const [k, v] of Object.entries(m.attr)) if (!isFin(v)) err(`${at}.attr.${k}`, 'BAD_NUMBER', `attr["${k}"] must be a number`);
        }
        const to = m.traitOverride;
        if (to !== undefined && to !== null) {
          if (!isPlainObj(to)) err(`${at}.traitOverride`, 'BAD_OVERRIDE', 'traitOverride must be an object');
          else if (isPlainObj(to.bb)) {
            for (const key of Object.keys(to.bb)) {
              if (bbKeyProblem(key) === 'unknown') warn(`${at}.traitOverride.bb["${key}"]`, 'BB_UNKNOWN_KEY', `"${key}" is not read by the generic kit`);
            }
          }
        }
        for (const [ci, ch] of (Array.isArray(m.talentChanges) ? m.talentChanges : []).entries()) {
          if (!isPlainObj(ch)) { err(`${at}.talentChanges[${ci}]`, 'BAD_TALENT_CHANGE', 'a talent change must be an object'); continue; }
          if (!Number.isInteger(ch.talentIndex)) err(`${at}.talentChanges[${ci}].talentIndex`, 'BAD_INDEX', 'talentIndex must be an integer (-1 = a hidden module talent)');
        }
      });
      if (defaults > 1) err('modules', 'MULTIPLE_DEFAULTS', `${defaults} modules are marked isDefault: the loadout screen has exactly one default`);
      if (mods.length && !defaults) warn('modules', 'NO_DEFAULT', 'no module is marked isDefault: the elite record is generated without a module (players can still pick one)');
    }
  }
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
      // 记录里的字段是 `skill.trigger.rule`，spec 里叫 `triggerRule` —— 两处都要看，否则这条提醒对派生记录永不触发
      const triggerRule = isPlainObj(sk.trigger) && typeof sk.trigger.rule === 'string' ? sk.trigger.rule : sk.triggerRule;
      if (triggerRule !== undefined && !TRIGGER_RULES.includes(String(triggerRule).toUpperCase()) && !KNOWN_CUSTOM_TRIGGER_RULES.includes(String(triggerRule).toUpperCase())) {
        warn('skill.triggerRule', 'TRIGGER_CUSTOM', `"${triggerRule}" is not one of the engine's trigger rules (${TRIGGER_RULES.join(', ')}): 它不会自动释放，除非有手写 kit 自己 activate`);
      }
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
