// server/match/gamedata.js — typed, defaulted view of data/*.json for the match engine.
//
// Every lookup is an own-property lookup (ids come from client intents) that never throws and returns null for
// unknown ids. Tunables come from data/config.json with the documented defaults (research 00-INDEX §2–§8) when a
// key is missing, so a partial data set (tests, data being regenerated) still yields a working match.
//
// No custom balance (DESIGN §14 corrections, research 08 §6): enemy numbers are the official ones — the PRTS
// per-round enemyScale table of data/config.json, the leader pool = bloodPoint per player alive at the fight's start
// (bossPoolShareOf). data/tuning.json only overrides result titles:
//   titles[titleId]                                                { stat?, rule? } merged over config.titles
// (the former enemyHpMul / enemyAtkMul / enemySpeedMul / bossHpMul / flyPlaceholders knobs were removed; a tuning file
// that still carries them is ignored).

import { getConfig, getMode } from '../data.js';
import { MAX_SEATS } from '../../shared/constants.js';
// 变体 / 口径层（DESIGN §28.39）：`opts.variants` → 这一局的 `config` 覆盖。值与轴表都在 `shared/variants.js`，
// 这里只消费它的判决（`null` = 什么都不用改，缺省路径逐字节不变）。
import { variantDataPatch, variantValue } from '../../shared/variants.js';
import { morphPairingOf, morphSlotPolicy } from '../../shared/morph.js';
import { formView, isEliteForm } from '../../shared/formProjection.js';
import { isShopItem } from '../sim/simdata.js';
import { mergeData } from '../../shared/plugins/dataUtils.js';
import { standInRecord } from '../../shared/standIn.js';
import { MAX_OFFER_SLOTS } from './player/common.js';
import {
  normalizeSupportConfig, supportSlotsFor, supportCapacity, supportPicker, isSupportChess, supportTierOf, supportPriceOf,
  checkSupport as checkSupportSelection,
} from '../../shared/support.js';

const own = (map, id) => (map && typeof map === 'object' && typeof id === 'string' && Object.hasOwn(map, id) && map[id] && typeof map[id] === 'object' ? map[id] : null);
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posIntOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

export const DEFAULTS = Object.freeze({
  income: [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12, 12, 12, 12, 12],
  incomeCap: 12,
  chessPrice: { 1: 2, 2: 3, 3: 3, 4: 3, 5: 4, 6: 4 },
  sellPrice: 1,
  refreshPrice: 1,
  poolCopies: { 1: 12, 2: 14, 3: 18, 4: 16, 5: 8, 6: 5 },
  mergeCount: 3,
  goldenCopies: 3,
  itemMergeCount: 2,
  benchSize: 10,
  tempSize: 5,
  deployCap: 8,
  equipPerChess: 2,
  maxArtsPerRound: 2,
  rewardOffer: { count: 3, tierOffset: 1, maxTier: 6, price: 0 },
  upgradePrices: [5, 8, 11, 12, 13],
  maxShopLevel: 6,
  shopSlots: { 1: { chess: 3, item: 1 }, 2: { chess: 4, item: 1 }, 3: { chess: 4, item: 1 }, 4: { chess: 5, item: 1 }, 5: { chess: 5, item: 1 }, 6: { chess: 5, item: 1 } },
  defaultBandId: 'band_bldsk',
  defaultStartLp: 28,
  lpCapPerRound: 10,
  bossOvertimeAfter: 150,
  bossOvertimeDrainPerSec: 1,
  hiddenCore: { single: 350, multi: 1200, minTeamLpExclusive: 1, difficulties: ['NORMAL', 'HARD', 'ABYSS'] },
  dp: { init: 10, perSec: 1, max: 99 },
  unite: { maxHelpers: 2, templates: { 1: 'act1autochess_escaped_single', 2: 'act1autochess_escaped_multi' } },
  timers: { infoCheck: 25, bandDraft: 50, bandTurn: 30, battleCheck: 3, spFirst: 30, spTurn: 16 },
  bans: { FUNNY: { core: 0, addon: 1 }, NORMAL: { core: 3, addon: 4 }, HARD: { core: 3, addon: 4 }, ABYSS: { core: 3, addon: 4 } },
  bandDraft: { skipsPerPlayer: 1, timeoutBandId: 'band_bldsk' },
  leftoverFundsKeptByBands: ['band_cannot'],
});

/** Game seconds per real second of a battle (forced 2×): combat limits in data are real seconds (combatTimeLimit). */
export const COMBAT_TIME_SCALE = 2;

/**
 * Multiplier of bloodPoint[difficulty] for the shared leader pool (DESIGN §20.10, §25.13.4), from config bossHpScale —
 * each key from the mode's entry first, then the global one; the defaults are the current rule:
 *   solo   `solo` (1: the table value — one player's share);
 *   co-op  `perPlayer` true (the owner's decision of 2026-10-06, adopting PR #209 by @qingjingshenghuo): `coop` (1) × the
 *          players alive when the fight starts — bots and AI 托管 seats count, eliminated and departed seats do not —
 *          at most `aliveFull` (4); a count left out means a full team;
 *          `perPlayer` false: the fixed pool of 0.1.x (「保持固定血量」, restorable with `solo` 0.25): `coop` whatever the
 *          count, × min(alive, aliveFull) / aliveFull with `aliveScaling`.
 *
 * `aliveFull` is a CEILING on the per-player multiplier, and it is calibrated for the official 4-seat room. A bigger
 * room (百卫补丁 v0.3, docs/PS100-MIGRATION.md §2.4) must not be silently clamped to it — `Math.min(32, 4)` made a
 * 32-seat pool exactly as large as a 4-seat one — so the effective ceiling is `max(aliveFull, seatCap)`.
 *
 * This reads the room's CAPACITY (`seatCap`), deliberately: it is a calibration floor, not the variant gate (that one
 * is `Match.variant` = 参与人数 > 4, 业主裁令 2026-10-12). With the 缺省上限 of 20 a room that fields fewer people is
 * therefore scaled as if it could hold 20 — a no-op for today's data (`data/config.json`'s only `bossHpScale` has
 * `perPlayer: true`, so the share is `coop × alive` and `full` never enters), but a mode switching to `perPlayer: false`
 * would see the 20-seat ceiling instead of the 4-seat one.
 * @param {object|null|undefined} modeScale config.modes[modeId].bossHpScale
 * @param {object|null|undefined} cfgScale config.bossHpScale
 * @param {boolean} isSolo
 * @param {number} [aliveCount] alive players at the Final Assault / Hidden Core start (co-op)
 * @param {number} [seatCap] seat slots of the room (default MAX_SEATS): the floor of the `aliveFull` ceiling
 * @returns {number}
 */
export function bossPoolShareOf(modeScale, cfgScale, isSolo, aliveCount, seatCap = MAX_SEATS) {
  const ms = modeScale && typeof modeScale === 'object' ? modeScale : {};
  const cs = cfgScale && typeof cfgScale === 'object' ? cfgScale : {};
  const pick = (k, d) => (Number.isFinite(ms[k]) && ms[k] > 0 ? ms[k] : Number.isFinite(cs[k]) && cs[k] > 0 ? cs[k] : d);
  const flag = (k, d) => (typeof ms[k] === 'boolean' ? ms[k] : typeof cs[k] === 'boolean' ? cs[k] : d);
  if (isSolo) return pick('solo', 1);
  const cap = Number.isFinite(seatCap) && seatCap >= 1 ? Math.floor(seatCap) : MAX_SEATS;
  const full = Math.max(1, Math.floor(pick('aliveFull', 4)), cap);
  const n = Number(aliveCount);
  const alive = Number.isFinite(n) && n >= 1 ? Math.min(full, Math.floor(n)) : full;
  if (flag('perPlayer', true)) return pick('coop', 1) * alive;
  return pick('coop', 1) * (flag('aliveScaling', false) ? alive / full : 1);
}

/** Strip the _a/_b suffix of an item id (the registry key of an item family). */
export const itemKey = (id) => (typeof id === 'string' ? id.replace(/_[ab]$/, '') : '');

export class GameData {
  /**
   * @param {Readonly<Record<string, any>>} data server/data.js getData() (may be partial)
   * @param {string} modeId e.g. 'mode_multi_hard'
   * @param {{ seatCap?: number, variants?: Array<{ axis: string, default: string }>|null, forms?: object|null }} [opts] seatCap = seat slots of the room (default MAX_SEATS): the floor of the
   *        bossHpScale `aliveFull` ceiling, so a bigger room is not clamped to the 4-seat calibration
   *        (bossPoolShareOf; 百卫补丁 v0.3, docs/PS100-MIGRATION.md §2.4).
   *        variants = the 口径 this match runs under (DESIGN §28.39, `pack.json.variants`); absent ⇒ the engine
   *        defaults, i.e. exactly today's behaviour.
   *        forms = 形态投影视图（`shared/formProjection.js` 的 `formView`，DESIGN §28.41）：`Match` 把它那一份传进来，
   *        与这一局的 `DataSource` **共用同一份**（两边分叉就是 bug）。不给 ⇒ 由 `variants` 自己建一份（等价）。
   */
  constructor(data, modeId, opts = {}) {
    this.raw = data && typeof data === 'object' ? data : {};
    this.config = getConfig(this.raw) || {};
    this.modeId = modeId;
    this.mode = getMode(modeId, this.raw) || {};
    // Mode-level globals inherit field by field; the vanilla mode never changes its config object.
    const overrides = Object.fromEntries(Object.keys(this.config).filter(k => k !== 'modes' && Object.hasOwn(this.mode, k)).map(k => [k, this.mode[k]]));
    if (Object.keys(overrides).length) this.config = mergeData(this.config, overrides);
    /**
     * 变体 / 口径层（DESIGN §28.39）给出的 `config` 覆盖 —— **一个轴一个值，值来自引擎常量，不是包**。
     * `opts.variants` 是本局声明的口径（`Array<{ axis, default }>`，`shared/variants.js` 归一化过的那一份）；
     * 没声明（`undefined` / 空数组）时它逐字是 `null`，于是下面每一个读点都走今天那条缺省路径。
     *
     * 为什么在**这里**读、而不是把 `config.economy.deployCap` 写进 `data`：`data/*.json` 是 generated 且
     * 逐字节被 `test/data.test.js` 钉住的（那张离线重建表要能逐字节复现 data/），口径改的是**这一局**的规则，
     * 不是那份基线。这条与工坊 overlay 的既有分工一致：overlay 加的是**内容**，口径加的是**规则的一个选项**。
     * @type {{ economy?: { deployCap?: number } } | null}
     */
    this.variantPatch = variantDataPatch(opts?.variants ?? null);
    /**
     * 行为开关 `morphPairing` 的档位（DESIGN §28.43.1）：`GameData` 是**这一局**的读取视图（prep 侧的
     * `pieceBonds` 从它读），所以档位也挂在这里、由 `Match` 建它时传进来 —— 与 `variants` 那条口径同一条分工
     * （改的是这一局的读取，不是 `data/*.json` 那份基线）。没声明 ⇒ `'official'`，也就是引擎今天的行为。
     * @type {'official'|'plus'}
     */
    this.morphPairing = morphPairingOf(opts?.behaviour ?? null);
    /**
     * 装备位语义的策略（第 7 段，与上面那一行是**同一格开关的另外半条**）：`plus` 档下变形同构体不占装备位、
     * 每名干员最多一件、第三件顶掉真正占格的那两件；缺省档 ⇒ `OFFICIAL_SLOT_POLICY`（**共享的冻结单例**，每一个
     * 方法都逐字是引擎今天那条算术）。
     *
     * 挂在 `GameData` 上的理由与 `morphPairing` 逐字相同：`GameData` 是**这一局**的读取视图，而槽位判定的调用方
     * （`server/match/player/items.js` / `acquire.js` / `bot.js` / `invariants.js`）手上有的就是它。**它不参与
     * `equipPerChess` 的取值** —— 那两格装备位是官方的；策略只回答「这一行占了几格、能不能再放一件、顶替挑哪一件」。
     * @type {import('../../shared/morph.js').MorphSlotPolicy}
     */
    this.morphSlots = morphSlotPolicy(opts?.behaviour ?? null);
    /** 口径给出的部署位；没有口径 ⇒ `null`（`deployCap` 落到数据 / DEFAULTS 那两级）。 */
    const cap = this.variantPatch?.economy?.deployCap;
    this._deployCap = Number.isInteger(cap) && cap > 0 ? cap : null;
    /**
     * Seat slots of the room this game data belongs to (MAX_SEATS when the caller has no seat list). Only the
     * boss-pool ceiling reads it — see bossPoolShareOf.
     */
    this.seatCap = Number.isFinite(opts?.seatCap) && opts.seatCap >= 1 ? Math.floor(opts.seatCap) : MAX_SEATS;
    this.economy = this.config.economy && typeof this.config.economy === 'object' ? this.config.economy : {};
    const chess = this.raw.chess && typeof this.raw.chess === 'object' ? this.raw.chess : {};
    this._chess = chess;
    /**
     * 形态投影（口径轴 `form`，DESIGN §28.41）：`form: "elite"` 时普通（`_a`）棋子按精锐（`_b`）的战斗职能出战。
     * 这一份是**读取期**的视图（`shared/formProjection.js`）：缺省（没声明这个轴）时它的 `chess(id)` 返回**原对象
     * 本身**，所以缺省路径逐字节不变、对象身份也不变（`sim/simdata.js` 的 DataSource 缓存与 golden 摘要都靠它）。
     * 与 `deploy` 那条口径的分工一样：口径改的是**这一局的读取**，`data/*.json` 那份基线一个字节都不动。
     */
    this.eliteForm = isEliteForm(variantValue(opts?.variants ?? null, 'form'));
    // 调用方（`Match`）可以把它那一份直接传进来：**同一份视图**才能在面板与战斗之间保证不分叉。
    this.formView = opts && opts.forms && typeof opts.forms.chess === 'function' && typeof opts.forms.token === 'function'
      ? opts.forms
      : formView(chess, this.eliteForm, { tokens: this.raw.tokens });
    this._tokensView = this.formView.token;
    this._items = this.raw.items && typeof this.raw.items === 'object' ? this.raw.items : {};
    // Fixed operator gifts are unlimited outputs, but every produced normal/advanced item still occupies 1/2 copies
    // (card-pool experiment BV1eLXXBqEgF, maintainer-confirmed 2026-10-11). Random subset gifts are not exempt.
    this._fixedGiftItems = new Set(Object.values(this.raw.garrisons || {})
      .filter(g => g.effectKey === 'SERVER_GAIN_EQUIP').map(g => g.bbStr?.chess).filter(id => this._items[id]));
    this._bonds = this.raw.bonds && typeof this.raw.bonds === 'object' ? this.raw.bonds : {};
    /** visible, shop-eligible base (normal) chess ids */
    this.visibleChess = Object.keys(chess).filter((id) => {
      const c = chess[id];
      return c && c.visible && !c.isGolden && !c.isDiy && !c.isHidden && Number.isInteger(c.tier);
    }).sort();
    /**
     * Shop item ids by tier (sim/simdata.js isShopItem: normal EQUIP, not hidden, not effect-only — the special
     * 维式重锤 and 突变细胞 are never sold). Every shop-item draw uses it: the shop item slot (pool.js), the 道具补给 /
     * 机密商店 cards (choices.js) and the shop-eligible item pools (Match.rollItemId). A pool's `also` list
     * (pool_equip_kathe: 突变细胞, #631) is appended there and is not in this table, so the shop slot still never sells it.
     */
    this.shopItemsByTier = {};
    for (const [id, it] of Object.entries(this._items)) {
      if (!isShopItem(it)) continue;
      (this.shopItemsByTier[it.tier] ||= []).push(id);
    }
    for (const k of Object.keys(this.shopItemsByTier)) this.shopItemsByTier[k].sort();
    this.bondIds = Object.keys(this._bonds).sort((a, b) => (numOr(this._bonds[a].identifier, 99) - numOr(this._bonds[b].identifier, 99)) || (a < b ? -1 : 1));
    this.modeInactiveBonds = new Set(Array.isArray(this.mode.inactiveBondIds) ? this.mode.inactiveBondIds : []);
    /** bandBondIds memo */
    this._bandBonds = new Map();
    this.inactiveEnemies = new Set(Array.isArray(this.mode.inactiveEnemyKeys) ? this.mode.inactiveEnemyKeys : []);
    /** data/tuning.json (titles only, see the header) */
    this.tuning = this.raw.tuning && typeof this.raw.tuning === 'object' ? this.raw.tuning : {};
    /** standIn memo: chess id → composed 补位 record | null */
    this._standIns = new Map();
    /**
     * 助战 (support operators, shared/support.js): the server-controlled pool declared by data/support.json. Disabled —
     * and then refusing every non-empty selection — when the file is missing, malformed or has no usable tier, so a
     * server without support.json behaves exactly as it did before this feature.
     */
    this.support = normalizeSupportConfig(this.raw.support);
  }

  /**
   * Leader HP pool multiplier — always 1 (no custom balance). Kept for callers written against the old tuning layer
   * (finalAssault.bossPoolHp); use `bossPoolHp` / `bossPoolShare` for the official pool.
   * @deprecated
   */
  bossHpMul(bossId) { // eslint-disable-line no-unused-vars
    return 1;
  }

  /**
   * Shared leader HP pool (DESIGN §20.10, §25.13.4): ONE pool for every boss field of the match (official tip "最终攻势中，
   * 所有人将一起对敌方领袖造成伤害"; the mirrored copies of a pair field share it — notice 5114 "两侧的敌方领袖共享生命值
   * （敌方领袖的总生命值不变）", which is about those copies). Size = bloodPoint[difficulty] × bossPoolShare: the table value
   * per player alive when the fight starts (the owner's decision of 2026-10-06, PR #209; it replaces the fixed pool of
   * 「保持固定血量」, which config bossHpScale restores — bossPoolShareOf); `aliveCount` omitted ⇒ a full team. Leaders are
   * never scaled by enemyScale ("领袖单位于服务器的生命值加成不受上述加成影响").
   * @param {string} bossId
   * @param {number} [aliveCount] alive players at the Final Assault / Hidden Core start (co-op)
   * @returns {number}
   */
  bossPoolHp(bossId, aliveCount) {
    const boss = this.boss(bossId);
    const diff = this.difficulty;
    let base = boss && boss.bloodPoint && Number.isFinite(boss.bloodPoint[diff]) ? boss.bloodPoint[diff] : null;
    if (base == null && boss && boss.bloodPoint) base = Object.values(boss.bloodPoint).find((v) => Number.isFinite(v)) ?? null;
    if (base == null) base = 500000;
    return Math.max(1, Math.round(base * this.bossPoolShare(aliveCount)));
  }

  /**
   * Multiplier of bloodPoint for the leader pool (see bossPoolHp; the rule and the config keys: bossPoolShareOf).
   * @param {number} [aliveCount]
   */
  bossPoolShare(aliveCount) {
    return bossPoolShareOf(this.mode.bossHpScale, this.config.bossHpScale, this.isSolo, aliveCount, this.seatCap);
  }

  /** config.titles with the tuning overrides (stat / rule per title id) merged in. */
  get titles() {
    const list = Array.isArray(this.config.titles) ? this.config.titles : [];
    const ov = this.tuning.titles && typeof this.tuning.titles === 'object' ? this.tuning.titles : {};
    return list.map((t) => {
      if (!t || typeof t.id !== 'string' || !Object.hasOwn(ov, t.id) || !ov[t.id] || typeof ov[t.id] !== 'object') return t;
      const o = ov[t.id];
      const out = { ...t };
      if (typeof o.stat === 'string') out.stat = o.stat;
      if (o.rule === 'max' || o.rule === 'min') out.rule = o.rule;
      return out;
    });
  }

  // ---- ids ------------------------------------------------------------------------------------------

  /**
   * A chess record. 口径 `form: "elite"`（DESIGN §28.41）下**普通（`_a`）棋子**返回按它精锐兄弟烘出来的那一份
   * （`shared/formProjection.js`：职能取 `_b`，棋子 id / 阶级 / 价格 / 盟约 / 特质 / 合成数仍取 `_a`）；没声明这个
   * 轴时逐字返回 `data/chess.json` 里**那个对象本身**（`===`，对象身份不变）。
   */
  chess(id) { return this.formView.chess(id) ?? own(this._chess, id); }
  item(id) { return own(this._items, id); }
  bond(id) { return own(this._bonds, id); }
  band(id) { return own(this.raw.bands, id); }
  garrison(id) { return own(this.raw.garrisons, id); }
  effect(id) { return own(this.raw.effects, id); }
  enemy(key) { return own(this.raw.enemies, key); }
  wave(id) { return own(this.raw.waves, id); }
  stage(id) { return own(this.raw.stages, id); }
  boss(id) { return own(this.raw.bosses, id); }
  token(id) { return own(this.raw.tokens, id); }
  get choices() { return this.raw.choices && typeof this.raw.choices === 'object' ? this.raw.choices : {}; }
  get factions() { return this.raw.factions && typeof this.raw.factions === 'object' ? this.raw.factions : {}; }

  // ---- 助战 (support operators; the server-controlled pool of data/support.json) -----------------------

  /** Whether this server offers 助战 at all (a usable slot + pool pair exists). */
  supportEnabled() { return this.support.enabled; }
  /** How many tier-`tier` supports one player may bring (0 = the tier is off). */
  supportSlots(tier) { return supportSlotsFor(this.support, tier); }
  /** Total supports one player may bring. */
  supportCapacity() { return supportCapacity(this.support); }
  /** `{ tier, slots, ids }[]` — what a client may show in the picker (the only source of that list; never the client's). */
  supportPicker() { return supportPicker(this.support); }
  /** Whether the pool allows this operator as a support (fails closed; see shared/support.js isSupportChess). */
  isSupportChess(id) { return isSupportChess(this.support, id, (x) => this.chess(x)); }
  /** The tier this operator counts against, or null when the pool does not allow it. */
  supportTierOf(id) { return supportTierOf(this.support, id, (x) => this.chess(x)); }
  /**
   * 助战干员在**带上它的那名玩家**商店里的标价（`data/support.json` 的 `prices`），没配就是 null。
   * 没配时用它的阶级价（`chessPrice`）—— 助战是普通棋子，价格规则不另开一套。
   * @param {string} id base chess id
   */
  supportPrice(id) { return supportPriceOf(this.support, id); }
  /**
   * Semantic check of a `room.support` selection against the pool (shared/support.js checkSupport — the same call the
   * client makes before sending, so the picker and the match agree).
   * @param {unknown} entries
   */
  checkSupport(entries) { return checkSupportSelection(entries, this.support, (x) => this.chess(x)); }

  /**
   * The 补位 record of chess `id` (normal or elite; DATA.md §18): shared/standIn.js standInRecord over data/backups.json
   * — the chess's identity (ids, tier, bonds, 特质, price, merge) with its official stand-in's body (stats, range, skills
   * with the backup skill as the default, talents, module, art, `standInFor`). Null for a PRESET / 自选 chess, an unknown
   * id or data without backups.json. Memoized (frozen records).
   * @param {string} id
   * @returns {object|null}
   */
  standIn(id) {
    if (typeof id !== 'string') return null;
    if (this._standIns.has(id)) return this._standIns.get(id);
    const c = this.chess(id);
    const backups = this.raw.backups && typeof this.raw.backups === 'object' ? this.raw.backups : null;
    let rec;
    try { rec = c && backups ? standInRecord(c, backups) : null; } catch { rec = null; }
    if (rec) Object.freeze(rec);
    this._standIns.set(id, rec);
    return rec;
  }

  /** Normal (base) chess id of a chess id (golden → base). */
  baseIdOf(id) {
    const c = this.chess(id);
    if (!c) return typeof id === 'string' ? id.replace(/_b$/, '_a') : null;
    return c.baseId || (c.isGolden ? id.replace(/_b$/, '_a') : id);
  }

  goldenIdOf(id) {
    const c = this.chess(this.baseIdOf(id));
    if (c && c.goldenId && this.chess(c.goldenId)) return c.goldenId;
    const alt = typeof id === 'string' ? id.replace(/_a$/, '_b') : null;
    return alt && this.chess(alt) ? alt : null;
  }

  isGolden(id) { const c = this.chess(id) || this.item(id); return !!(c && c.isGolden); }

  tierOf(id) {
    const c = this.chess(id) || this.item(id);
    return c && Number.isInteger(c.tier) ? c.tier : 1;
  }

  // ---- economy --------------------------------------------------------------------------------------

  income(round) {
    const arr = Array.isArray(this.economy.income) ? this.economy.income : DEFAULTS.income;
    const cap = numOr(this.economy.incomeCap, DEFAULTS.incomeCap);
    const v = arr[round];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return Math.max(0, Math.min(cap, 3 + round));
  }

  chessPrice(id) {
    const c = this.chess(id);
    const override = this.mode.economy?.chessPrice?.[this.tierOf(id)]?.[c?.isGolden ? 'golden' : 'normal'];
    if (Number.isFinite(override) && override >= 0) return override;
    if (c && Number.isFinite(c.price) && c.price >= 0) return c.price;
    const tier = this.tierOf(id);
    const row = this.economy.chessPrice && this.economy.chessPrice[tier];
    const golden = c && c.isGolden;
    if (row && typeof row === 'object') return numOr(golden ? row.golden : row.normal, DEFAULTS.chessPrice[tier] ?? 3);
    return DEFAULTS.chessPrice[tier] ?? 3;
  }

  sellPrice(id) {
    const c = this.chess(id);
    const override = this.mode.economy?.chessSell?.[this.tierOf(id)]?.[c?.isGolden ? 'golden' : 'normal'];
    if (Number.isFinite(override) && override >= 0) return override;
    if (c && Number.isFinite(c.sellPrice) && c.sellPrice >= 0) return c.sellPrice;
    const tier = this.tierOf(id);
    const row = this.economy.chessSell && this.economy.chessSell[tier];
    if (row && typeof row === 'object') return numOr(c && c.isGolden ? row.golden : row.normal, DEFAULTS.sellPrice);
    return DEFAULTS.sellPrice;
  }

  itemPrice(id) {
    const it = this.item(id);
    return it && Number.isFinite(it.price) && it.price >= 0 ? it.price : 2;
  }

  get refreshPrice() { return Math.max(0, numOr(this.economy.refreshPrice, DEFAULTS.refreshPrice)); }
  get benchSize() { return posIntOr(this.economy.benchSize, DEFAULTS.benchSize); }
  get tempSize() { return posIntOr(this.economy.tempSize, DEFAULTS.tempSize); }
  /**
   * 部署位（一名玩家同时站在场上的干员数）。三条来源，**优先级就是这个顺序**：
   *   1. 本局的**口径**（`pack.json.variants` 的 `deploy: "max"`，DESIGN §28.39）—— 见构造函数里的 `_deployCap`；
   *   2. 数据里的 `config.economy.deployCap`（官方 `maxBattleChessCnt` = 8）；
   *   3. `DEFAULTS.deployCap`（一份被裁过的 data 也还能开局）。
   * 没有口径、也没有数据时逐字回到今天那条：`posIntOr(economy.deployCap, DEFAULTS.deployCap)`。
   */
  get deployCap() { return this._deployCap ?? posIntOr(this.economy.deployCap, DEFAULTS.deployCap); }
  get equipPerChess() { return posIntOr(this.economy.equipPerChess, DEFAULTS.equipPerChess); }
  get maxArtsPerRound() { return posIntOr(this.economy.maxArtsPerRound, DEFAULTS.maxArtsPerRound); }
  get goldenCopies() { return posIntOr(this.economy.goldenCopies, DEFAULTS.goldenCopies); }
  get itemMergeCount() { return posIntOr(this.economy.itemMergeCount, DEFAULTS.itemMergeCount); }
  get leftoverKeptBands() {
    const ids = Array.isArray(this.economy.leftoverFundsKeptByBands) ? this.economy.leftoverFundsKeptByBands : DEFAULTS.leftoverFundsKeptByBands;
    const extra = Object.values(this.raw.bands || {}).filter(b => b.effectRef && ids.includes(b.effectRef)).map(b => b.bandId);
    return extra.length ? [...ids, ...extra] : ids;
  }
  get defaultBandId() { return typeof this.economy.defaultBandId === 'string' ? this.economy.defaultBandId : DEFAULTS.defaultBandId; }
  get defaultStartLp() { return posIntOr(this.economy.defaultStartLp, DEFAULTS.defaultStartLp); }

  rewardOffer() {
    const r = this.economy.rewardOffer && typeof this.economy.rewardOffer === 'object' ? this.economy.rewardOffer : {};
    return {
      // (an offer shows at most MAX_OFFER_SLOTS: a larger count — a data plugin's — only rolled for slots nobody sees)
      count: Math.min(MAX_OFFER_SLOTS, posIntOr(r.count, DEFAULTS.rewardOffer.count)),
      tierOffset: Number.isInteger(r.tierOffset) ? r.tierOffset : DEFAULTS.rewardOffer.tierOffset,
      maxTier: posIntOr(r.maxTier, DEFAULTS.rewardOffer.maxTier),
      price: Math.max(0, numOr(r.price, 0)),
    };
  }

  /**
   * Copies of a base chess in the shared pool — and, for a DIY slot, of a slotted 自选 piece in its player's own stock
   * (player/diy.js buildDiyStock).
   */
  poolCopies(baseId) {
    const ov = this.economy.poolCopiesOverrides;
    const tier = this.tierOf(baseId);
    const pc = this.economy.poolCopies;
    const v = ov && Number.isInteger(ov[baseId]) && ov[baseId] >= 0 ? ov[baseId] : pc?.[tier];
    const base = Number.isInteger(v) && v >= 0 ? v : (DEFAULTS.poolCopies[tier] ?? 10);
    // Co-op doubles the single-player counts: the measured shared pool (shared by the whole team, independent of team
    // size) and each player's private 自选 stock alike — the maintainer's decision of 2026-10-15 (GitHub #650): with
    // the shared pool doubled and the 自选 stock not, a 自选 operator was diluted in the copy-weighted rolls.
    const multiplier = this.isSolo ? 1 : posIntOr(this.economy.coopPoolMultiplier, 1);
    return base * multiplier;
  }

  /** Normal equipment copies in the shared pool; effect-only items have no shop stock limit. */
  itemPoolCopies(id) {
    const base = this.baseIdOf(id), rec = this.item(base);
    if (!rec || !isShopItem(rec)) return null;
    const count = this.economy.itemPoolCopiesOverrides?.[base] ?? this.economy.itemPoolCopies?.[rec.tier];
    return Number.isInteger(count) && count >= 0 ? count : null;
  }

  /** Whether a fixed trait gift may be produced beyond stock (including the advanced version of that item). */
  isUnlimitedGiftItem(id) { return this._fixedGiftItems.has(this.baseIdOf(id)); }

  /** Copies needed to merge (0 = never merges: golden chess). */
  mergeCount(id) {
    const c = this.chess(id);
    if (!c || c.isGolden) return 0;
    if (Number.isInteger(c.upgradeNum) && c.upgradeNum > 0) return c.upgradeNum;
    const ov = this.economy.mergeCountOverrides;
    if (ov && Number.isInteger(ov[id])) return ov[id];
    return posIntOr(this.economy.mergeCount, DEFAULTS.mergeCount);
  }

  // ---- mode -----------------------------------------------------------------------------------------

  get isSolo() { return this.mode.type === 'SINGLE' || /^mode_single_/.test(this.modeId || ''); }
  get difficulty() { return this.mode.difficulty || (this.modeId ? String(this.modeId).split('_').pop().toUpperCase() : 'NORMAL'); }
  get lastRound() {
    if (Number.isInteger(this.mode.lastRound) && this.mode.lastRound > 0) return this.mode.lastRound;
    return this.modeId === 'mode_single_funny' ? 9 : 14;
  }
  get bossRound() { return Number.isInteger(this.mode.bossRound) && this.mode.bossRound > 0 ? this.mode.bossRound : this.lastRound; }
  get hiddenRound() { return Number.isInteger(this.mode.hiddenRound) && this.mode.hiddenRound > 0 ? this.mode.hiddenRound : null; }
  get maxShopLevel() { return posIntOr(this.mode.maxShopLevel, DEFAULTS.maxShopLevel); }

  roundCfg(r) {
    const rounds = this.mode.rounds;
    return rounds && typeof rounds === 'object' && rounds[String(r)] && typeof rounds[String(r)] === 'object' ? rounds[String(r)] : null;
  }

  spRounds() { return Array.isArray(this.mode.spRounds) ? this.mode.spRounds.filter((n) => Number.isInteger(n)) : []; }

  upgradePrices() {
    const arr = Array.isArray(this.mode.upgradePrices) ? this.mode.upgradePrices : DEFAULTS.upgradePrices;
    return arr.map((v) => Math.max(0, numOr(v, 99)));
  }

  /** Base price to go from `level` to level+1 (null at max). */
  upgradeBase(level) {
    if (level >= this.maxShopLevel) return null;
    const arr = this.upgradePrices();
    return arr[level - 1] ?? 99;
  }

  shopSlots(level) {
    const s = this.mode.shopSlots && this.mode.shopSlots[String(level)];
    const d = DEFAULTS.shopSlots[level] || DEFAULTS.shopSlots[6];
    if (!s || typeof s !== 'object') return { ...d };
    const chess = Number.isInteger(s.chess) && s.chess >= 0 ? s.chess : d.chess;
    const item = Number.isInteger(s.item) && s.item >= 0 ? s.item : d.item;
    return { chess: Math.min(chess, 8), item: Math.min(item, 4) };
  }

  /** Real-second prep timer for round r (null = untimed). */
  prepTime(r) {
    const rc = this.roundCfg(r);
    if (!rc) return this.isSolo ? null : 90;
    const v = rc.prepTime;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /** The round level's `maxPlayTime` (config rounds[r].combatTimeLimit) as data gives it — REAL seconds. */
  combatTimeLimitReal(r) {
    const rc = this.roundCfg(r);
    const v = rc ? rc.combatTimeLimit : undefined;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    const m = this.mode.combatTimeLimit && this.mode.combatTimeLimit[String(r)];
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 60;
  }

  /**
   * Combat time limit of round r in GAME seconds (what the Battle and 联防 use): maxPlayTime × the forced battle speed
   * (config.combatTimeScale, default COMBAT_TIME_SCALE 2). `maxPlayTime` counts real seconds of the 2× battle: read
   * as game seconds, the rounds' own spawn schedules would not fit (R2 spawns its last flyer at 43 s of a 45 s limit,
   * R3 at 62 s of 55 s — enemies that can never be killed, or never spawn), while × 2 every limit is ≈ the last spawn +
   * one flyer crossing (R2 43 + 44 ≈ 90, R3 62 + 44 ≈ 110, R5 38 + 67 ≈ 110). docs/BALANCE.md §2.1.
   */
  combatTimeLimit(r) {
    return this.combatTimeLimitReal(r) * this.combatTimeScale;
  }

  /** Game seconds per real second of a battle (config.combatTimeScale, default COMBAT_TIME_SCALE 2). */
  get combatTimeScale() {
    const k = numOr(this.config.combatTimeScale, COMBAT_TIME_SCALE);
    return k > 0 ? k : COMBAT_TIME_SCALE;
  }

  /**
   * The boss round level's `maxPlayTime` (config rounds[r].levelMaxPlayTime, 120) in REAL seconds — the countdown of
   * the Final Assault / Hidden Core. It is not a hard stop there ("计时结束后战斗仍然会继续", research 01 §10); null
   * when the data has none.
   */
  bossLevelTime(r) {
    const rc = this.roundCfg(r);
    const v = rc ? rc.levelMaxPlayTime : undefined;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * Official enemy multipliers of round r (config enemyScale: the PRTS table + 终极 speed ×1.15 from R3). `supplyHpMul`
   * (only when ≠ 1: co-op 终极 R5–R15) = the share of hpMul from 补给线 / 补给线II (config `supplyHp`), effects whose
   * `enemy_exclude` leaves out the 14 器物 hit-count keys — they take hpMul / supplyHpMul (archetypes.js `times`).
   */
  baseEnemyScale(r) {
    const e = this.mode.enemyScale && this.mode.enemyScale[String(r)];
    if (!e || typeof e !== 'object') return { hpMul: 1, atkMul: 1, speedMul: 1 };
    const supply = numOr(e.supplyHp, 1);
    return {
      hpMul: Math.max(0.01, numOr(e.hp, 1)),
      atkMul: Math.max(0, numOr(e.atk, 1)),
      speedMul: Math.max(0.01, numOr(e.speed, 1)),
      ...(supply > 0 && supply !== 1 ? { supplyHpMul: supply } : {}),
    };
  }

  /** Enemy multipliers of round r = the official table (baseEnemyScale; no custom multiplier). */
  enemyScale(r) {
    return this.baseEnemyScale(r);
  }

  timer(key) {
    const t = this.config.timers && this.config.timers[key];
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULTS.timers[key] ?? 10;
  }

  get lpCapPerRound() { return posIntOr(this.config.lpCapPerRound, DEFAULTS.lpCapPerRound); }
  /**
   * Boss overtime (`bossTurnHpReduceTime` 150 / 1 LP per second): a server turn timer of turnInfoDataDict like
   * prepPhaseTime, so REAL seconds on the same clock as the boss level's 120 s maxPlayTime (combat limits are real
   * seconds, docs/BALANCE.md §2.1) — the level countdown runs out first, the battle continues, and the merged team LP
   * drains 1 per real second from the 150 s mark (research 01 §10, 06 §11.7). Read as game seconds the drain would
   * start at 75 real s (45 s before the countdown ends) at 2 LP per real second.
   */
  get bossOvertimeAfterReal() { return Math.max(0, numOr(this.config.bossOvertimeAfter, DEFAULTS.bossOvertimeAfter)); }
  /** Team LP drained per REAL second of overtime. */
  get bossOvertimeDrainReal() { return Math.max(0, numOr(this.config.bossOvertimeDrainPerSec, DEFAULTS.bossOvertimeDrainPerSec)); }
  /** Overtime start in GAME seconds of a boss field clock (150 real s × the forced 2× = 300). */
  get bossOvertimeAfter() { return this.bossOvertimeAfterReal * this.combatTimeScale; }
  /** Team LP drained per GAME second of overtime (1 per real second = 0.5 per game second). */
  get bossOvertimeDrain() { return this.bossOvertimeDrainReal / this.combatTimeScale; }
  /**
   * Team LP the overtime drain has taken when a boss field clock reads `gt` game seconds: bossOvertimeDrainReal per
   * whole REAL second past bossOvertimeAfterReal (the first point at 151 real s).
   */
  bossOvertimeDue(gt, afterReal = this.bossOvertimeAfterReal) {
    const over = (Number(gt) || 0) / this.combatTimeScale - afterReal;
    return over >= 1 ? Math.floor(over) * this.bossOvertimeDrainReal : 0;
  }
  get dp() {
    const d = this.config.dp && typeof this.config.dp === 'object' ? this.config.dp : {};
    return { dpInit: numOr(d.init, 10), dpPerSec: numOr(d.perSec, 1), dpMax: numOr(d.max, 99) };
  }
  get unite() {
    const u = this.config.unite && typeof this.config.unite === 'object' ? this.config.unite : {};
    return {
      maxHelpers: posIntOr(u.maxHelpers, DEFAULTS.unite.maxHelpers),
      templates: u.templates && typeof u.templates === 'object' ? u.templates : DEFAULTS.unite.templates,
    };
  }
  get hiddenCore() {
    const h = this.config.hiddenCore && typeof this.config.hiddenCore === 'object' ? this.config.hiddenCore : {};
    return {
      single: numOr(h.single, DEFAULTS.hiddenCore.single),
      multi: numOr(h.multi, DEFAULTS.hiddenCore.multi),
      minTeamLpExclusive: numOr(h.minTeamLpExclusive, DEFAULTS.hiddenCore.minTeamLpExclusive),
      difficulties: Array.isArray(h.difficulties) ? h.difficulties : DEFAULTS.hiddenCore.difficulties,
    };
  }
  bans(difficulty) {
    const b = this.config.bans && this.config.bans[difficulty];
    const d = DEFAULTS.bans[difficulty] || { core: 0, addon: 0 };
    if (!b || typeof b !== 'object') return { ...d };
    return { core: Number.isInteger(b.core) && b.core >= 0 ? b.core : d.core, addon: Number.isInteger(b.addon) && b.addon >= 0 ? b.addon : d.addon };
  }
  get bandDraft() {
    const b = this.config.bandDraft && typeof this.config.bandDraft === 'object' ? this.config.bandDraft : {};
    return {
      skipsPerPlayer: Number.isInteger(b.skipsPerPlayer) && b.skipsPerPlayer >= 0 ? b.skipsPerPlayer : DEFAULTS.bandDraft.skipsPerPlayer,
      timeoutBandId: typeof b.timeoutBandId === 'string' && this.band(b.timeoutBandId) ? b.timeoutBandId : this.defaultBandId,
    };
  }

  /** Bosses weights for the boss round / hidden round. */
  bossWeights(hidden = false) {
    const w = hidden ? this.mode.hiddenBossWeights : this.mode.bossWeights;
    return w && typeof w === 'object' ? Object.entries(w).filter(([id, v]) => this.boss(id) && Number(v) > 0) : [];
  }

  /** Band usable in this mode type. */
  bandAllowed(bandId) {
    const b = this.band(bandId);
    if (!b) return false;
    const list = Array.isArray(b.modeTypeList) ? b.modeTypeList : null;
    if (!list) return true;
    return list.includes(this.isSolo ? 'SINGLE' : 'MULTI');
  }

  bandIds() {
    const bands = this.raw.bands && typeof this.raw.bands === 'object' ? this.raw.bands : {};
    return Object.keys(bands).filter((id) => this.bandAllowed(id)).sort((a, b) => numOr(bands[a].sortId, 99) - numOr(bands[b].sortId, 99) || (a < b ? -1 : 1));
  }

  startLp(bandId) {
    const b = this.band(bandId);
    return b && Number.isInteger(b.totalHp) && b.totalHp > 0 ? b.totalHp : this.defaultStartLp;
  }

  /**
   * The bonds a strategy's mechanic is built around (DESIGN §21.26): bands.json `bondIds`, written at build time by
   * shared/bandBonds.js from the band's own text and blackboards (潘格尼尼 → 拉特兰, 克莱门莎 → 阿戈尔, 玛恩纳 → 卡西米尔 …) —
   * the field the strategy draft's 本局禁用 mark reads too. Known bond ids in data order; [] for an unknown band, one tied to
   * no bond (华法琳, 阿米娅 …) or data without the field. The bot never picks a strategy tied to a bond the mode switches
   * off (bot.js botPickBand).
   * @param {string} bandId
   * @returns {string[]}
   */
  bandBondIds(bandId) {
    if (this._bandBonds.has(bandId)) return this._bandBonds.get(bandId);
    const listed = this.band(bandId)?.bondIds;
    const set = new Set(Array.isArray(listed) ? listed : []);
    const out = Object.freeze(this.bondIds.filter((id) => set.has(id)));
    this._bandBonds.set(bandId, out);
    return out;
  }

  /**
   * Placeable (hand) tokens a chess sends to the hand when placed on the board: [{ tokenId, count }] — its manually
   * deployable summons (tokens.json `placeable`: 医疗探机, 诅咒娃娃, 海嗣, 狼群, 流形, 爬行号·防护单元; user playtest #6)
   * that the chess makes under `loadout` ({ skillIndex } from shared/protocol.js resolveLoadout; absent ⇒ its default
   * skill): the owner variant's `sources` (`bySkill[skillIndex]` for a non-default skill) name a talent or a skill —
   * 赫默 / 巫恋 on S1 make no drone / doll. `count` = the summon's deploy limit (PRTS 卫戍协议/帮助 "根据召唤物部署数量
   * 上限（非初始持有量），发送等量召唤物至手牌区": 凯瑟琳 2 of her 3 devices).
   */
  placeableTokens(chessId, loadout = null) {
    const c = this.chess(chessId);
    if (!c || !Array.isArray(c.tokens)) return [];
    const out = [];
    for (const tid of c.tokens) {
      const t = this.token(tid);
      if (!t || t.kind !== 'summon' || t.placeable !== true) continue;
      const vs = t.variants && typeof t.variants === 'object' ? t.variants : {};
      const v = vs[chessId] ?? vs[String(chessId).replace(/_b$/, '_a')] ?? null;
      if (v) {
        const alt = loadout && Number.isInteger(loadout.skillIndex) && v.bySkill ? v.bySkill[loadout.skillIndex] : null;
        const src = Array.isArray(alt?.sources) ? alt.sources : Array.isArray(v.sources) ? v.sources : [];
        if (!src.includes('talent') && !src.includes('skill')) continue;
      }
      const count = posIntOr(v?.stats?.deployLimit, posIntOr(t.deployLimit, 1));
      out.push({ tokenId: tid, count: Math.min(count, 9) });
    }
    return out;
  }
}
