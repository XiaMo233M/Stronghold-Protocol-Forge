// server/sim/content/index.js — installs all content into a Battle (DESIGN §7).
//
// installContent(battle, { mode }) — applies the per-battle loadout data view (simdata withUnitLoadouts; DESIGN §16),
//   then mode 'full' (default): hand-authored kits (kits/index.js: one file per kit in kits/ops/) with generic
//   fallback + every domain module's install(battle); 'generic': generic kits only, no domain modules;
//   'none': no kits (units never cast skills) and no modules. Every module install runs inside try/catch:
//   a faulty content module is logged and skipped, never crashing the battle.
// setupUnitKit(battle, unit, mode) — resolves a unit's Kit: kits[baseChessId]?.(bb, chess, def) ?? generic.
//   Battle opts.kits ({ [baseChessId]: kitFn }) take precedence (tests / sandboxes).
//   补位 stand-ins (isStandInDef: the def of simdata getStandIn — the chess's ids, another character's body): the kit is
//   kits[def.charId] (the stand-in's own, kits/ops/standin-<codename>.js), never the chess id's — that is the replaced
//   operator's kit; without one, the generic kit plus the talents it can apply exactly (generic.js genericTalents).
//   A stand-in has no default skill: its kit authors every skill it supports in `skills` (selectSkillSpec).
//   自选 pieces (isDiyDef: the def of simdata getDiy — a DIY slot's ids, the picked operator's body) take their kit the
//   same way: kits[def.charId] (an owned 6★'s kits/ops/op-<codename>.js, a prototype's standin-<codename>.js), else the
//   generic kit plus genericTalents; no default skill either (the pick chooses any of the three).
//   Operator loadouts (DESIGN §16): the def is resolved for the unit's selected skill / module (simdata getChess), so
//   the kit receives `chess.skill` = the SELECTED skill record and `bb` = its blackboard (talents / trait / module of
//   the selected module). Kit contract (backward compatible): `{ skill?, skills?: { [skillId]: SkillSpec }, talents,
//   trait, install? }` — the skill spec is `skills[selectedSkillId]` when the kit authors it, else `skill` only when
//   the selected skill is the chess's default one, else the GENERIC spec of the selected skill (its generic install,
//   e.g. counter damage, is chained after the kit's). Talents / trait / install of the kit always apply.
//   syncUnitLoadout (called first, before the battle starts): a unit whose def lacks the loadout of its own input entry
//   (id-only data lookups in a multi-player field; an entry without loadout fields = the default) is given its own
//   def; summon pieces follow their owner (an inline `def` of a token entry is kept). Summons spawned AFTER the start
//   are resolved by Battle (getToken(id, owner.defId, owner.def.loadout)), not here.
// registerAllMeta(registry) — calls each domain module's registerMeta(registry) (prep side, server boot).

import { genericKit, genericTalents } from './generic.js';
import { EXTENSIONS, installExtensions } from './extensions.js';
import { compileDsl } from './dsl/compile.js';
import { validateSkillSpec, matchesSchema, MODS_SCHEMA } from '../../../shared/plugins/skillSpec.js';
import { withUnitLoadouts } from '../simdata.js';
import { isPotential } from '../../../shared/potential.js';

// Content files are loaded with guarded dynamic imports: a module that fails to load (syntax error, throwing
// top-level code, missing file) is logged and replaced by an empty module instead of breaking the server.
async function safeImport(path) {
  try {
    return await import(path);
  } catch (e) {
    console.error(`[content] failed to load ${path}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    return {};
  }
}

const KIT_REGISTRY = await safeImport('./kits/index.js');
const DOMAIN_NAMES = ['tokens', 'devices', 'enemies', 'bosses', 'bonds', 'garrisons', 'items', 'bands', 'choices'];
const DOMAINS = await Promise.all(DOMAIN_NAMES.map((n) => safeImport(`./${n}.js`)));
const tokens = DOMAINS[0];

/**
 * Merged kit registry: baseChessId → (bb, chess, def) => Kit, then the 补位 stand-in kits: stand-in charId → builder
 * (kits/index.js; each kit file is loaded guarded too)
 */
export const KITS = KIT_REGISTRY.KITS ?? Object.freeze({});

/** Domain modules in install order: tokens, devices, enemies, bosses, bonds, garrisons, items, bands, choices. */
export const MODULES = Object.freeze(DOMAIN_NAMES.map((n, i) => [n, DOMAINS[i]]));

/**
 * Whether `def` is a 补位 stand-in: a chess fielded with another character's body (simdata getStandIn — `standInFor` =
 * the replaced operator's charId, `charId` = the stand-in's, which differ).
 */
export function isStandInDef(def) {
  return !!(def && def.standInFor && def.charId && def.charId !== def.standInFor);
}

/**
 * Whether `def` is a 自选 piece: a DIY slot fielded with a picked operator's body (simdata getDiy — `diyFor` = the slot's
 * base id, `charId` = the operator's).
 */
export function isDiyDef(def) {
  return !!(def && def.diyFor && def.charId);
}

/** A def whose body is another character than its chess id names (补位 stand-in, 自选 piece): its kit is keyed by charId. */
const isOtherBody = (def) => isStandInDef(def) || isDiyDef(def);

/**
 * `kitOf` 命中的那个**键**（`null` = 没命中）。**键顺序只有这一份**：`kitOf` 与「这个 kit 属于哪个包」的读者必须
 * 命中同一个键，两处各写一遍就是两处会漂的判断。`??` 的语义逐字保留：第一个**非 `null` / `undefined`** 的值胜出
 * （所以 `reg[undefined]` 这种病态命中与从前同答）。
 */
export function kitKeyOf(def, reg) {
  if (!def || !reg) return null;
  if (isOtherBody(def)) return Object.prototype.hasOwnProperty.call(reg, def.charId) ? def.charId : null;
  const bare = String(def.baseId ?? def.id ?? '').replace(/_[ab]$/, '');
  for (const k of [def.baseId, def.id, bare]) if (reg[k] != null) return k;
  return null;
}

/**
 * The kit builder of an operator def in `reg` ({ [key]: (bb, chess, def) => Kit }), or undefined. A stand-in's and a
 * 自选 piece's kit is keyed by its charId (`char_609_acguad`, `char_112_siege`) and by nothing else: the chess id it keeps
 * names the replaced operator's kit (a DIY slot has none). Any other def: baseId (`…_a`, data/SIM.md), the exact id, or
 * the suffix-less id of DESIGN §5.6's example.
 */
/** 注册表查询。**D18**：`kitKeyOf` 是「哪个键胜出」的**唯一一份**实现 —— 上游的 `registeredKit` 是同一逻辑的
 * 另一份写法，且语义有别：它用 `.find(Boolean)` 会连**假值**一起跳过，而我们逐字保留 `??` 语义（`reg[k] != null`）。
 * ⇒ 结构取上游的**调度**，查询仍走我们的 `kitKeyOf`。 */
function registeredKit(def, reg) {
  const k = kitKeyOf(def, reg);
  return k === null ? undefined : reg[k];
}

/** Official kit key or file stem; no path supplied by a plugin is ever imported. */
export function officialKit(ref) {
  if (Object.hasOwn(KITS, ref)) return KITS[ref];
  const file = Object.values(KIT_REGISTRY.KIT_FILES || {}).flat().concat(KIT_REGISTRY.STANDIN_KIT_FILES || [], KIT_REGISTRY.OPERATOR_KIT_FILES || [])
    .find(f => f.replace(/\.js$/, '') === ref);
  if (!file) return undefined;
  const stem = file.replace(/\.js$/, '');
  if (stem.startsWith('chess_')) return KITS[stem.split('-')[0] + '_a'];
  const code = stem.replace(/^(op|standin)-/, '');
  return Object.entries(KITS).find(([k]) => k.startsWith('char_') && k.endsWith('_' + code))?.[1];
}

/**
 * [ASSUMED] A one-skill DIY or stand-in uses that kit's default skill (DESIGN **§34.5**，上游原文 `§32.5`). Multi-skill
 * clones keep explicit `skills[id]` so selectSkillSpec does not treat the default spec as every selected skill.
 */
function bindDefaultSkill(k, chess, d) {
  if (k?.skill && isOtherBody(d) && chess?.skills?.length === 1 && d?.skill?.id && !k.skills?.[d.skill.id]) {
    return { ...k, skills: { ...(k.skills || {}), [d.skill.id]: k.skill } };
  }
  return k;
}

/** C2 order: extension → DSL → JSON SkillSpec → kitRef → official → generic. */
export function kitOf(def, reg = KITS) {
  if (!def) return undefined;
  // Explicit Battle opts.kits retain their existing precedence and lookup-only semantics.
  if (reg !== KITS) return registeredKit(def, reg);
  const ext = registeredKit(def, EXTENSIONS) ?? (def.charId?.startsWith('char_x_') ? EXTENSIONS[def.charId] : undefined);
  if (ext) return ext;
  const raw = def.raw || {};
  if (raw.dsl != null) return (bb, chess, d) => bindDefaultSkill(compileDsl(raw.dsl, { bb, chess, def: d }), chess, d);
  if (raw.skillSpec != null) return (bb, chess, d) => {
    const spec = chess.skill?.skillSpec ?? raw.skillSpec;
    const errors = validateSkillSpec(spec);
    const mods = chess.talentMods ?? {};
    if (errors.length || !matchesSchema(mods, MODS_SCHEMA)) throw Object.assign(new Error('Invalid JSON SkillSpec'), { code: 'PLUGIN_SKILL_SPEC' });
    return { skills: { [d.skill?.id]: spec }, talents: Object.keys(mods).length ? [{ install(b, u) {
      b.addBuff(u, { key: 'talent:plugin', mods, persist: true, allowDead: true });
    } }] : [] };
  };
  if (raw.kitRef != null) {
    const f = officialKit(raw.kitRef);
    if (!f) return undefined;
    return (bb, chess, d) => {
      return bindDefaultSkill(f(bb, chess, d), chess, d);
    };
  }
  return registeredKit(def, KITS);
}

/**
 * 包提供的 Kit → 它属于哪个包（DESIGN §28.52 的 kit 那一半：`kits/<id>.js` 的逐单位回调要归到那个包的账上）。
 *
 * 为什么用 `WeakMap` 而不是给 Kit 加一个字段：`Kit` 是**包自己返回的对象**，往上加字段就是改包的返回值（会漏进
 * `kitShape` 之类的比对，也可能落在包自己冻结的对象上）。为什么不在这里按 `def` 重算一次：那会成为第二份「哪个
 * kit 胜出」的实现（`kitKeyOf` 的键顺序 + mode 分支 + 命中后返回假值时的回退），两份写法迟早漂。这张表只按
 * **对象身份**记：写它的地方就是选中那个 kit 的那一行，读它的地方是 `_setupUnit`（包的回调真正注册的地方）。
 */
const KIT_PACK = new WeakMap();

/** 这个 Kit 由哪个包提供（`null` = 引擎自己的 / 官方内容 —— 于是它一行预算都不记）。 @param {any} kit */
export function kitPackOf(kit) { return (kit && KIT_PACK.get(kit)) || null; }

/** `Battle opts.kitOwners` / `tokenKitOwners` 里这个 kit id 的包（表缺席、或这个 id 不在表里 ⇒ `null`）。 */
function packOfKit(battle, key, id) {
  const map = battle && battle.opts ? battle.opts[key] : null;
  if (!map || typeof map.get !== 'function' || id == null) return null;
  const owner = map.get(id);
  return typeof owner === 'string' && owner ? owner : null;
}

/** The generic kit of an operator def; a stand-in's / 自选 piece's also carries the talents generic.js can apply exactly. */
function fallbackKit(bb, raw, def) {
  const k = genericKit(bb, raw, def);
  if (!isOtherBody(def)) return k;
  const talents = genericTalents(def);
  return talents.length ? { ...k, talents: [...(k.talents ?? []), ...talents] } : k;
}

/** Resolve the Kit of an ally unit. Never throws (falls back to the generic kit). */
export function setupUnitKit(battle, unit, mode = 'full') {
  try { syncUnitLoadout(battle, unit); } catch (e) { battle._handlerError?.('loadout', unit, e); }
  if (mode === 'none') return {};
  const def = unit.def || {};
  const raw = def.raw ?? def;
  const bb = def.skill?.bb ?? {};
  if (unit.kind === 'token') {
    // 工坊的召唤物行为层（docs/WORKSHOP.md §4.7）：与干员那一半同一条纪律 —— 一张按对局注入的表，**先查它、再查
    // 内置注册表**。token 的键就是 token 记录的 id（`def.id`，normalizeToken 逐字写下），所以这一行的键规则与
    // 下面 `tokens.kits[def.id]` 完全一致；`Object.hasOwnProperty` 让它不顺着原型链、也不吃 `baseId` 之类的回退。
    // 没有包声明 summon kit 时 `opts.tokenKits` 根本不存在（`spec.js` 只在有值时传这个键），这一行是 no-op，
    // token 的解析与从前逐字节相同。两个键空间是分开的：`opts.kits` 永远不会被当成 token kit，反之亦然。
    const injectedTok = battle.opts && battle.opts.tokenKits;
    const packTok = mode === 'full' || injectedTok
      ? (injectedTok && Object.prototype.hasOwnProperty.call(injectedTok, def.id) ? injectedTok[def.id] : undefined)
      : undefined;
    const tk = packTok ?? (mode === 'full' ? (tokens.kits?.[def.id] ?? tokens.default?.[def.id]) : null);
    if (typeof tk === 'function') {
      // 这个 kit 是包给的 ⇒ 记下它的包（`_setupUnit` 应用它时把它的逐单位回调记到那本账上）。内建那一半命中时
      // 归属是 null（引擎自己的内容），与从前逐字节相同。
      const owner = packTok ? packOfKit(battle, 'tokenKitOwners', def.id) : null;
      try { const k = tk(bb, raw, def); if (k) { if (owner) KIT_PACK.set(k, owner); return k; } } catch (e) { battle._handlerError(`tokenKit:${def.id}`, unit, e); }
    }
    return def.skill ? genericKit(bb, raw, def) : {};
  }
  if (unit.kind !== 'op') return {};
  const injected = battle.opts && battle.opts.kits;
  if (mode === 'full' || injected) {
    const f = kitOf(def, injected) ?? (mode === 'full' ? kitOf(def, KITS) : undefined);
    if (typeof f === 'function') {
      // 归属：**包给的那一份**才有 owner（键顺序与 `kitOf` 是同一份 `kitKeyOf`，命中的是同一个键）；`f` 来自内建
      // 注册表时它是 null。记在返回的那个对象上（`selectSkillSpec` 可能返回一个新对象），`_setupUnit` 读它。
      const key = injected ? kitKeyOf(def, injected) : null;
      const owner = key === null ? null : packOfKit(battle, 'kitOwners', key);
      try {
        const k = f(bb, raw, def);
        if (k) { const out = selectSkillSpec(k, bb, raw, def); if (owner) KIT_PACK.set(out, owner); return out; }
      } catch (e) {
        const dslCode = typeof e?.code === 'string' && /^PLUGIN_DSL_[A-Z0-9_]+$/.test(e.code);
        // A record that carries DSL, or a throw whose code is a DSL problem, is a corrupt content set.
        // Do not substitute the generic kit or an empty kit (DESIGN **§34.7**，上游原文 `§32.7`). Any other throw still
        // falls back. Matched as a pattern, not a quoted PLUGIN_* name: the error catalogue scans those strings.
        if (dslCode || raw.dsl != null) {
          if (e && typeof e === 'object') {
            e.contentFault = true;
            if (typeof e.code === 'string' && !String(e.message || '').includes(e.code)) e.message = `${e.code} ${e.message || ''}`.trim();
          }
          battle.contentFault = {
            layer: 'setupUnitKit',
            code: typeof e?.code === 'string' ? e.code : 'PLUGIN_DSL_SHAPE',
            message: String(e?.message || e),
          };
          throw e;
        }
        battle._handlerError(`kit:${isOtherBody(def) ? def.charId : def.baseId}`, unit, e);
      }
    }
  }
  return fallbackKit(bb, raw, def);
}

/** A unit's own PlayerBattleInput entry (operators: kind ≠ 'token'; tokens: kind 'token'), or null. */
function inputEntry(unit) {
  const list = unit && unit.player && unit.player.input && Array.isArray(unit.player.input.units) ? unit.player.input.units : null;
  if (!list || unit.uid == null) return null;
  const tok = unit.kind === 'token';
  return list.find((v) => v && v.uid === unit.uid && (v.kind === 'token') === tok) ?? null;
}

/**
 * The loadout `{ skillIndex, moduleId }` a unit's PlayerBattleInput entry gives; an entry without loadout fields means
 * the DEFAULT loadout (`{}`), never "whatever the data view maps this chess id to" (another player's choice in a
 * multi-player field). `standIn: true` rides along (补位: the stand-in def whatever the skill / module fields say), as
 * do `diy` (自选: the pick of a DIY slot's piece) and `potential` (0.2.2: 1–6, never a stand-in's). Null when the unit
 * has no input entry.
 */
function inputLoadout(unit) {
  const x = inputEntry(unit);
  if (!x) return null;
  const extra = {
    ...(x.standIn === true ? { standIn: true } : null),
    ...(x.diy && typeof x.diy === 'object' ? { diy: x.diy } : null),
    ...(x.standIn !== true && isPotential(x.potential) ? { potential: x.potential } : null),
  };
  if (x.skillIndex == null && x.moduleId == null) return extra;
  return { skillIndex: x.skillIndex ?? null, moduleId: x.moduleId ?? null, ...extra };
}

/** Put a def on a not-yet-deployed ally (the fields Battle._makeAlly takes from the def). */
function swapDef(unit, def) {
  const st = def.stats;
  unit.def = def;
  unit.defId = def.id;
  unit.name = def.name;
  unit.rangeGrid = def.rangeGrid;
  Object.assign(unit.base, {
    maxHp: st.maxHp, atk: st.atk, def: st.def, res: st.res, aspd: st.aspd, bat: st.bat, blockCnt: st.blockCnt,
    spRecovery: st.spRecovery, tauntLevel: st.tauntLevel, massLevel: st.massLevel, hpRecoveryPerSec: st.hpRecoveryPerSec,
    cost: st.cost, respawnTime: st.respawnTime,
  });
  unit.markDirty?.();
  unit.hp = unit.s ? unit.s.maxHp : st.maxHp;
}

/**
 * Loadout exactness (DESIGN §16) before the battle starts: an operator whose def does not carry the loadout of its own
 * PlayerBattleInput entry (the per-battle data view resolves id-only lookups per chess id — two players of one field
 * may give the same chess different loadouts) gets the def of its own loadout — an entry without loadout fields means
 * the default — and a summon piece follows its owner's (unless its entry carries an inline `def`). A no-op when the def
 * already matches (Battle passing the unit's loadout to getChess / getToken).
 */
export function syncUnitLoadout(battle, unit) {
  if (!battle || battle.started || !unit || unit.deployed || !unit.def || !battle.data) return;
  if (unit.kind === 'op') {
    const lo = inputLoadout(unit);
    if (!lo || typeof battle.data.getChess !== 'function') return;
    // an entry without loadout fields only needs a look when the def carries a non-default loadout
    if (!Object.keys(lo).length && !(unit.def.loadout && unit.def.loadout.isDefault === false)) return;
    const want = battle.data.getChess(unit.def.id, lo);
    if (want && want !== unit.def && want.id === unit.def.id) swapDef(unit, want);
  } else if (unit.kind === 'token' && unit.ownerUnit && unit.ownerUnit.kind === 'op' && typeof battle.data.getToken === 'function') {
    // an explicit inline def of the input entry (Battle `_tokenDef(id, owner, inp.def)`) is never replaced
    if (inputEntry(unit)?.def) return;
    const owner = unit.ownerUnit;
    syncUnitLoadout(battle, owner);
    if (!owner.def || !owner.def.loadout) return;
    const want = battle.data.getToken(unit.def.id, owner.def.id, owner.def.loadout);
    if (want && want !== unit.def && want.id === unit.def.id) swapDef(unit, want);
  }
}

/** Id of the selected skill of an operator def (null without a skill). */
const selectedSkillId = (def) => def?.skill?.id ?? def?.raw?.skill?.skillId ?? null;

/**
 * True when the def's selected skill is the chess's default skill (no loadout info ⇒ default). Never for a stand-in:
 * the skill it fields is the one its chess names (S2 on one chess, S3 on another), so its kit authors each in `skills`;
 * nor for a 自选 piece (the pick chooses any of its skills).
 */
const skillIsDefault = (def) => !isOtherBody(def) && (!def?.loadout || def.loadout.skillIsDefault !== false);

/**
 * The kit with the skill spec of the SELECTED skill (see header): `kit.skills[id]` → `kit.skill` (default skill only;
 * never for a stand-in) → the generic spec. Returns the kit itself when nothing changes; `kit.skillSource` tells which
 * one was used ('skills' | 'kit' | 'generic').
 * @param {object} kit hand-authored kit
 */
export function selectSkillSpec(kit, bb, raw, def) {
  const id = selectedSkillId(def);
  const map = kit && kit.skills && typeof kit.skills === 'object' ? kit.skills : null;
  if (id && map && Object.prototype.hasOwnProperty.call(map, id)) return { ...kit, skill: map[id] ?? null, skillSource: 'skills' };
  if (skillIsDefault(def)) return kit;
  const g = genericKit(bb, raw, def);
  const own = typeof kit.install === 'function' ? kit.install : null;
  const gen = typeof g.install === 'function' ? g.install : null;
  const out = { ...kit, skill: g.skill ?? null, skillSource: 'generic' };
  if (own && gen) out.install = (battle, unit) => { own(battle, unit); gen(battle, unit); };
  else if (gen) out.install = gen;
  return out;
}

/**
 * Whether the kit of `def` has a hand-authored spec for its selected skill (tools/kit-coverage.mjs, tests): `skills`
 * entry, or the kit's `skill` for the default skill when the kit is not the generic fallback. Never throws.
 * @returns {'skills'|'kit'|'generic'|'none'} where the spec comes from ('none' = no kit function at all)
 */
export function skillSpecSource(def, kits = KITS) {
  const f = kitOf(def, kits);
  if (typeof f !== 'function') return 'none';
  let k = null;
  try { k = f(def.skill?.bb ?? {}, def.raw ?? def, def); } catch { return 'generic'; }
  if (!k || k.generic) return 'generic';
  const id = selectedSkillId(def);
  if (id && k.skills && Object.prototype.hasOwnProperty.call(k.skills, id)) return 'skills';
  return skillIsDefault(def) && k.skill !== undefined ? 'kit' : 'generic';
}

/**
 * Install kits for every ally unit and (mode 'full') every domain module. First, a Battle constructed without the spec
 * path (server-run fields, bot rehearsals, tests) gets the same per-battle loadout data view createBattleFromSpec uses
 * (simdata withUnitLoadouts over its players' inputs), so summons spawned during the battle (`getToken(id, owner)`)
 * and every other id-only lookup resolve the owner's selected skill / module there too (DESIGN §16).
 */
export function installContent(battle, { mode = 'full', extra = null, installers = null } = {}) {
  try {
    const view = withUnitLoadouts(battle.data, (battle.players || []).map((p) => p && p.input));
    if (view && view !== battle.data) battle.data = view;
  } catch (e) { battle._handlerError?.('loadoutView', null, e); }
  for (const u of battle.allyUnits) {
    if (u.kit) continue;
    try { battle._setupUnit(u); } catch (e) {
      if (e?.contentFault || battle.contentFault) {
        battle._handlerError('content:dsl', u, e);
        throw e;
      }
      battle._handlerError('setupUnit', u, e);
    }
  }
  if (mode === 'full') {
    installExtensions(battle);
    for (const [name, mod] of MODULES) {
      if (typeof mod.install !== 'function') continue;
      try { mod.install(battle); } catch (e) { battle._handlerError(`content:${name}`, null, e); }
    }
  }
  // 包声明的**战斗逻辑**（`pack.json.server.battle`, DESIGN §28.17）：每个包单独一层 try/catch，报错点名是哪个包。
  // 一个包抛异常只记一条内容错误，绝不让整个战场起不来 —— 与 kits 逐单位隔离同一条口径。**没有包声明时这里是空的**，
  // 所以干净安装与从前逐字节相同（golden 语料不动）。
  //
  // 调用预算（`pack.json.callBudget`, DESIGN §28.52）：声明过的包在这里**开账**，而且它的 `install` 在
  // `_withPackScope` 里跑 —— 这一趟挂上的 hook / 计时器 / buff 因此都带上 `pack` 标记，这一局就按那本账计。
  // 没声明 `callBudget` 的 installer 上面那个键根本不存在 ⇒ 两个动作都不做，module 档一行都不多跑。
  for (const m of installers || []) {
    if (!m || typeof m.install !== 'function') continue;
    const packId = m.id || '?';
    if (Number.isInteger(m.callBudget)) battle._declarePackBudget(packId, m.callBudget);
    try { battle._withPackScope(packId, () => m.install(battle)); } catch (e) { battle._handlerError(`content:pack:${packId}`, null, e); }
  }
  // kit 那一半的账（DESIGN §28.52）：上面那个循环只给**声明了 `server.battle`** 的包开账，而一个包的另一半战斗行为
  // 住在 `kits/<id>.js` —— 只带 `kits/` 的包过去根本建不了账，它的逐单位回调（每 tick 一次、每次又挂一批计时器）
  // 正是这一格要挡的那类回调。装载器（`server/workshop.js loadWorkshopKits`）已经把「包 id → 生效 max」算好一次
  // （`effectivePackCallBudget` 是唯一一份「包 → 生效 max」），这里只开账。同一个包两处都开时写的是同一个数字，
  // 而 `_declarePackBudget` 是幂等的；没有那张表时这一行一个字节都不多跑（干净安装 / 没包声明预算）。
  const kitBudgets = battle.opts && battle.opts.kitBudgets;
  if (kitBudgets && typeof kitBudgets.forEach === 'function') {
    kitBudgets.forEach((max, packId) => { battle._declarePackBudget(packId, max); });
  }
  for (const m of extra || []) {
    try { (typeof m === 'function' ? m : m.install)?.(battle); } catch (e) { battle._handlerError('content:extra', null, e); }
  }
}

/** Prep-side registration of every domain module (server boot). */
export function registerAllMeta(registry) {
  for (const [name, mod] of MODULES) {
    if (typeof mod.registerMeta !== 'function') continue;
    try { mod.registerMeta(registry); } catch (e) { console.error(`[content] ${name}.registerMeta failed:`, e); }
  }
}
