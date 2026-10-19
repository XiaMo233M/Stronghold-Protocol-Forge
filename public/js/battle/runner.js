// Local battle runner — client-side combat (DESIGN §14, research 09 §3.2 / §6.4).
//
// Like the official client, the browser simulates battles itself with the shared deterministic sim (server/sim,
// served read-only at /sim/). The server sends a JSON BattleSpec (`b.start`); this module builds the Battle with
// /sim/spec.js createBattleFromSpec and
//   * steps it at the battle speed (fixed 1/30 s ticks, 2× → 60 ticks per real second; at most
//     max(8, 4·speed) ticks per animation frame, bounded fast-forward up to CATCHUP_TICKS per frame when it is far
//     behind: a reconnect, observing a running field, a tab back from the background),
//   * feeds the render engine every frame through the same wire formats the server used to stream
//     (`snap` = b.snap frame from battle.snapshot(), `ev` = b.ev frame from battle.drainEvents()) and publishes the
//     field meta (m.field shape) into store.match.field so the game screen enters the battle,
//   * when authoritative: reports b.progress (~1 Hz; boss fields 4 Hz with the shared-pool damage and the LP meter)
//     and b.result (compactResult) at the end; applies b.pool (LocalBossPool.sync) and b.end (forceEnd / takeover),
//   * keeps an authoritative battle running while the tab is hidden (a 250 ms interval pump; browsers throttle it to
//     ~1 Hz, the bounded fast-forward absorbs that); the server deadline + takeover cover anything worse.
// A frame that fast-forwards (catch-up) passes on only the state-bearing events (keepsState: spawns, deaths, deploys,
// statuses, skills, leaks and the fx that change an enemy's model form — shared/protocol.js fxForm); while the tab is
// hidden the battle on screen keeps the same events (compacted past HELD_MAX; a backlog still past it makes the view
// re-enter from the field meta) and the first frame back delivers them — or, for a battle that ended while hidden, the
// visibilitychange itself — so the view still knows every unit and every enemy's current form (player report #5 after
// 0.1.0: a 转译基底·α that changed form during a stall or in a background tab died in its first-form model). Such a
// frame or step covers seconds of play, so it drains the events every EV_SLICE ticks and each batch keeps its own game
// time (`gt`): the render engine then knows how late a form fx is and skips a change clip that has already ended.
// Display replicas (a teammate's field after the own battle, 联防 observers, the partner of a boss pair) run the same
// spec fast-forwarded to the server's clock (`elapsed`) and never report.
// A b.start is registered as pending the moment it arrives — before the sim module has loaded, while the Battle is built
// and caught up silently — so what comes for that battle meanwhile is applied to it in order (PR #266): a b.end takeover
// stops its reports; a forced / timeout b.end (the first end counts) ends it as soon as the Battle exists, without
// catching up; a second b.start of it updates its flags (never a second Battle); b.pool and the solo pause reach it. A
// b.start of another field supersedes it: an authority, or a battle the server already ended, is still built and kept, a
// display replica is dropped. The next prep's clear() drops it.
// A b.result lost with the socket (the request failed DISCONNECTED / OFFLINE, or timed out twice) is kept and sent
// again when the session is back online ('status' → 'online') or when a b.start still names this finished battle
// authoritative (the server is waiting for it); the server takes a duplicate idempotently. A server refusal is final.
// Solo pause (g.pause, DESIGN §14): while `m.public.paused` is true every local battle clock stands still (no ticks, no
// reports); on resume the clocks move on by the paused time, like the server's field clock.
// Live leaks (user playtest #3 item 2): every normal field simulated here keeps its counted leaks so far — the settle
// rule's count (leaked entries with counted !== false, /sim/spec.js battleProgress) — and publishes them as
// state().leaks { [fieldId]: n } whenever one changes, authoritative or display replica alike; the top bar shows the
// own field's min(lpCapPerRound, n) as the LP about to be lost (ui/hud.js liveLp). A 联防 field keeps each leaker's
// enemies still standing (/sim/spec.js uniteLeft; user playtest #6 item 7) as state().uniteLeft { [playerId]: n },
// published whenever it changes (it falls as the helpers kill them), and its authority reports it as b.progress `left`.
// Live bond layers (DESIGN §20.15): every battle simulated here keeps the bonds whose layers grew in it (IN_BATTLE gains,
// Battle.addLayers — normal battles only) as absolute counts per player, published as state().bondLayers
// { [playerId]: { [bondId]: n } } (every battle of the round: the own one, the teammates' replicas) whenever one grows;
// the bond strip of the player on screen — the own one, or a watched teammate's — shows them live (ui/watchBonds.js).
//
// The vanilla sim (≈ 0.2–1 ms per tick) runs on the main thread: one battle at a time is stepped for display (plus an
// authoritative one if it is not the one on screen). Gameplay sets use WorkerSimHost (DESIGN §34.11).
// stats() exposes the measured cost (Worker cost includes the message round trip).
//
//   import { battleRunner } from './battle/runner.js'     (browser singleton wired to net.js + store.js; null in Node)
//   battleRunner.on('snap' | 'ev' | 'field' | 'state', fn) → off
//   battleRunner.state()  → { battleId, fieldId, kind, authoritative, watch, done, own, members, loading, paused, leaks,
//                              uniteLeft, bondLayers } | null
//   battleRunner.stats()  → { ticks, stepMs, avgTickMs, maxFrameMs, catchups, errors, battles }
//   battleRunner.unitStats(unitId, fieldId?) → the live stats of a unit of the battle on screen (shared/protocol.js
//                           unitStatsEntry: current HP, effective max HP / ATK / DEF / RES / interval / block / move
//                           speed next to its base; an ally also its live attack range `range` — unit.liveRangeGrid,
//                           facing RIGHT, never a kit's target-selection grid) | null — the detail card reads it a few
//                           times a second (user playtest #4 item 7; the range mini-map, community report E1 after
//                           0.1.0). Read-only: it takes the stats the sim computed last (`unit._s`) and the range grid it
//                           keeps, and never makes the unit recompute them, so looking never changes the battle's floats.
//   battleRunner.damage() → the per-unit / per-player cumulative damage of the battle ON SCREEN plus its time basis
//                           (`gt`) — the one read a 伤害看板 needs to compute DPS itself (DESIGN §28.38); a frozen copy,
//                           `null` when there is no battle. Read-only: it takes the numbers the sim already accumulated
//                           (server/sim/damage.js) and never keeps a second account of its own.
//   battleRunner.unitIdOf(uid, ownerId, fieldId?) → the id of an own board piece's unit in that battle | null
//   battleRunner.ownerOps(ownerId, fieldId?) → [{ kind: 'op', ownerId, defId, items?, standInFor?, diy? }] that player's
//                           operators in the battle on screen with their equipment (a teammate's bond popup: the members in
//                           play, DESIGN §20.15, 变形同构体 wearers included; a 补位 stand-in names the replaced charId,
//                           a 自选 operator carries its pick like UnitInfo) | []
//
// createBattleRunner(deps) builds an instance with injectable net / store / clock / frame scheduler / sim loader
// (test/match/runner.test.js and test/match/runner-pending.test.js drive it under Node).

import { net as appNet } from '../net.js';
import { store as appStore } from '../store.js';
import { fxForm } from '../../../shared/protocol.js';
import { spectateEffects } from './observe.js';
import { recordError, setBattleSource } from '../diag.js';
import { roomDataBase } from '../mods/align.js';
import { loadBrowserSim } from './simLoader.js';
// 上游 0.3.1：工作室的控制台要自己拿到浏览器侧的战斗模拟器（public/studio/js/console/view.js），
// 所以这两个名字从 runner 转出去 —— 它本来就是 simLoader 的门面。
export { loadBrowserSim } from './simLoader.js';
import { InPageSimHost, WorkerSimHost } from './simHost.js';
import { trackCombat, combineCombat } from './metrics.js';
import { simContent as appSimContent, contentSet as appContentSet, contentFor as appContentFor } from '../content.js';
import { t } from '../../../shared/i18n.js';
import { currentModSet } from '../roomMods.js';

const TICK = 1 / 30;
/** Fast-forward budget per frame (ticks) when far behind. */
export const CATCHUP_TICKS = 240;
/** Silent catch-up slice (ticks) while a new battle is prepared before it is shown. */
const PREPARE_SLICE = 600;
const MAX_ENTRIES = 4;
const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill', 'leak']);
/**
 * The b.ev tuples a catch-up frame or the hidden-tab backlog keeps: the state-bearing kinds, and every fx that sets an
 * enemy's model form (shared/protocol.js fxForm — dropped, the view kept the old model: player report #5 after 0.1.0).
 */
export const keepsState = (x) => Array.isArray(x) && (STATE_EV.has(x[0]) || fxForm(x) !== undefined);
/**
 * Hidden-tab backlog cap (tuples) of the battle on screen. Past it the backlog is compacted (compactHeld: only the last
 * 'status' per unit and status, the last 'skill' per unit — what the view ends up showing); only a backlog still past it
 * (thousands of spawns) makes the view re-enter from the field meta.
 */
export const HELD_MAX = 3000;
/**
 * Ticks per event batch of a step that covers more than one frame of play (a catch-up frame of up to CATCHUP_TICKS, a
 * hidden-tab step): its events are drained every EV_SLICE ticks and stamped with that game time, not the frame's.
 */
export const EV_SLICE = 15;

/** 本地播放倍速的上下限（`setRate`）。上限不是「不能更快」，而是再快也只是画面跳 —— 帧预算由
 *  `ticksPerFrameCap` 夹住，所以放宽上限不会绕过任何判定。下限 0.5 让「慢放看清一次技能」可用。 */
export const RATE_MIN = 0.5;
export const RATE_MAX = 4;

/** 顶栏那个按钮循环的四档（与原件 `SPEED_STEPS` 同一个语义：纯本地播放选择）。 */
export const RATE_STEPS = Object.freeze([1, 2, 3, 4]);

/**
 * A hidden-tab backlog without the superseded toggles: of the 'status' tuples only the last per (unit, status), of the
 * 'skill' tuples only the last per unit, every other tuple (spawn / die / deploy / leak / form fx — bounded by the units)
 * kept; order preserved. A long hidden boss fight toggles statuses thousands of times, the rest stays small.
 */
export function compactHeld(list) {
  const last = new Map();
  list.forEach((x, i) => {
    if (x[0] === 'status') last.set(`s:${x[1]}:${x[2]}`, i);
    else if (x[0] === 'skill') last.set(`k:${x[1]}`, i);
  });
  return list.filter((x, i) => (x[0] === 'status' ? last.get(`s:${x[1]}:${x[2]}`) === i : x[0] === 'skill' ? last.get(`k:${x[1]}`) === i : true));
}
/**
 * Data files the simulation reads (DataSource + content/support gameData()).
 *
 * 0.3.0: the list lives in the loader the Worker shares (`simLoader.js`) and this module re-exports it, so the browser
 * runner and the Worker can never disagree about which files the sim needs. Before this it was defined twice, with
 * identical contents — re-exporting keeps the behaviour unchanged.
 */
export { SIM_DATA_FILES } from './simLoader.js';

/**
 * 工坊行为层 (docs/WORKSHOP.md §4): build the per-battle kit maps from `spec.workshopKits` — the JSON-safe module list the
 * server puts in the spec, because a function cannot cross the wire. The maps are handed to createBattleFromSpec
 * (`opts.kits` for operators, `opts.tokenKits` for summons), which server/sim/content/index.js setupUnitKit consults
 * BEFORE the built-in registries.
 *
 * **Two key spaces, one list** (§4.7): the engine resolves a kit either by an operator key (`def.charId` / `def.baseId`
 * / `def.id`) or by a summon's token record id. Both travel in `spec.workshopKits`, and a summon module carries
 * `kind: 'token'` — the same marker the loader put on it, because the two spaces are arbitrated separately server-side
 * (an id may be known in both). A module with no `kind` is an OPERATOR kit, exactly as before this channel existed.
 *
 * This function is the reason the behaviour layer cannot be server-only: the server re-computes a client's battle result
 * with the SAME kits, so a browser that silently fell back to the generic kit would produce a result the server rejects.
 * A module that fails to load is reported and skipped rather than hidden.
 * @param {{ workshopKits?: Array<{ id: string, url: string, kind?: string, pack?: string, callBudget?: number }> }|null} spec
 * @returns {Promise<{ kits: Record<string, Function>, tokenKits: Record<string, Function>, kitOwners: Map<string, string>,
 *   tokenKitOwners: Map<string, string>, kitBudgets: Map<string, number> }>} `{}`-valued maps when the field needs no
 *   workshop kits (both maps are always objects, so a caller never has to test for undefined)
 */
export async function loadSpecKits(spec) {
  const list = Array.isArray(spec && spec.workshopKits) ? spec.workshopKits : [];
  /** @type {Record<string, Function>} */
  const kits = {};
  /** @type {Record<string, Function>} */
  const tokenKits = {};
  // kit 的**归属**与**预算**（DESIGN §28.52 的 kit 那一半）：`pack` 与 `callBudget` 本来就在这份清单上（服务端装载期
  // 写好一次），这里只把它们**读**出来交给战斗 —— **不在这里算一次**：两端读的必须是同一个数字，各算一次就是两端
  // 会漂的两个答案。归属与预算不取决于 import 成不成功，所以这两个表在下面的循环之前就建好。
  /** @type {Map<string, string>} */
  const kitOwners = new Map();
  /** @type {Map<string, string>} */
  const tokenKitOwners = new Map();
  /** @type {Map<string, number>} */
  const kitBudgets = new Map();
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || typeof m.pack !== 'string' || !m.pack) continue;
    (m.kind === 'token' ? tokenKitOwners : kitOwners).set(m.id, m.pack);
    if (Number.isInteger(m.callBudget) && !kitBudgets.has(m.pack)) kitBudgets.set(m.pack, m.callBudget);
  }
  if (!list.length) return { kits, tokenKits, kitOwners, tokenKitOwners, kitBudgets };
  for (const m of list) {
    // only a same-origin, root-relative URL is ever imported (the server built this list itself)
    if (!m || typeof m.id !== 'string' || typeof m.url !== 'string' || !m.url.startsWith('/')) continue;
    try {
      const mod = await import(/* @vite-ignore */ m.url);
      const fn = typeof mod.default === 'function' ? mod.default : (typeof mod.kit === 'function' ? mod.kit : null);
      if (typeof fn === 'function') (m.kind === 'token' ? tokenKits : kits)[m.id] = fn;
      else console.warn('[runner] workshop kit has no exported kit function', m.id);
    } catch (err) {
      console.warn('[runner] workshop kit failed to load', m.id, err);
    }
  }
  return { kits, tokenKits, kitOwners, tokenKitOwners, kitBudgets };
}

/**
 * 包声明的**战斗逻辑**（`pack.json.server.battle`, DESIGN §28.17）：按 `spec.workshopBattle` 的 URL 加载每个包的
 * `install(battle)`，交给 `createBattleFromSpec` 的 `opts.battleInstallers`。
 *
 * 为什么必须在浏览器里也跑一遍：与服务端复算同一场战斗的两个执行路径必须跑**同一段代码**（kit 那条通道的同一个
 * 理由，见 loadSpecKits）。一个加载不上的模块照实报出来，而不是悄悄少一个包的效果 —— 少了它，服务端算出来的战果
 * 会与客户端不一致，玩家的成绩会被拒。
 * @param {{ workshopBattle?: Array<{ id: string, url: string, callBudget?: number }> }|null} spec
 * @param {{ importModule?: (url: string) => Promise<any> }} [opts] `importModule` 与 `server/battlePack.js`
 *   `loadBattleInstallers` 的同名参数是同一个注入点：**两端唯一的差别就是「谁去 import」**，而预算不在这条
 *   差别里（`callBudget` 由服务端装载期算好、随清单过来，两端读同一个数字）。
 * @returns {Promise<Array<{ id: string, callBudget?: number, install: Function }>|undefined>} undefined when the field needs none
 */
export async function loadSpecBattleInstallers(spec, { importModule = (url) => import(/* @vite-ignore */ url) } = {}) {
  const list = Array.isArray(spec && spec.workshopBattle) ? spec.workshopBattle : [];
  if (!list.length) return undefined;
  /** @type {Array<{ id: string, callBudget?: number, install: Function }>} */
  const out = [];
  for (const m of list) {
    // only a same-origin, root-relative URL is ever imported (the server built this list itself)
    if (!m || typeof m.id !== 'string' || typeof m.url !== 'string' || !m.url.startsWith('/')) continue;
    // 调用预算（`pack.json.callBudget`, DESIGN §28.52）：服务端装载期算好的生效值，原样带进 installer —— 两端
    // 因此在**同一个数字**上记账、在**同一次调用**上回滚。清单上没有这个键（包没声明）⇒ 这里也不带。
    const budget = Number.isInteger(m.callBudget) ? { callBudget: m.callBudget } : {};
    try {
      const mod = await importModule(m.url);
      const install = typeof mod.install === 'function' ? mod.install : (typeof mod.default === 'function' ? mod.default : null);
      if (typeof install === 'function') out.push({ id: m.id, ...budget, install });
      else console.warn('[runner] workshop battle module has no exported install function', m.id);
    } catch (err) {
      console.warn('[runner] workshop battle module failed to load', m.id, err);
    }
  }
  return out.length ? out : undefined;
}

/** Request failures after which a b.result counts as never delivered (re-sent on resume / b.start). */
export const LOST_RESULT_CODES = Object.freeze(['DISCONNECTED', 'OFFLINE', 'TIMEOUT']);

/** Ticks per frame at a speed (same cap as the server pacing: server/match/fields.js maxTicksPerInterval). */
export const ticksPerFrameCap = (speed) => Math.max(8, Math.ceil((Number(speed) || 2) * 4));

/**
 * What the runner compares between two looks at a 联防 battle (noteUniteLeft) before it reads the leakers' enemies still
 * standing again: a knock-out, a leak, a spawn, the end. `total` stands for the spawns no longer — a split child or a summon
 * is outside the capsule's denominator (DESIGN §14 顶栏胶囊) — so the length of the enemy list does.
 * @param {any} b the battle
 */
export const uniteLeftMark = (b) => `${Number(b.killed) || 0}:${Number(b.leakedCount) || 0}:${Number(b.total) || 0}:${Array.isArray(b.enemies) ? b.enemies.length : 0}:${b.finished ? 1 : 0}`;

/**
 * Battle logger: content errors are isolated by the sim; report them as warnings (the server logs its own) and keep
 * them for the diagnostics a player copies (diag.js).
 */
const SIM_LOGGER = Object.freeze({
  error: (...a) => { console.warn('[sim]', ...a); recordError('sim', a.length === 1 ? a[0] : a.map(String).join(' ')); },
  warn: (...a) => console.warn('[sim]', ...a),
  info() {},
  debug() {},
});

/**
 * @param {{ net: any, store: any,
 *   loadSim?: ((dataBase: string, content?: object|null) => Promise<{ spec: any, ds: any }>)
 *     | ((content?: object|null) => Promise<{ spec: any, ds: any }>),
 *   dataBaseFor?: (spec: any) => string, contentFor?: (cs: string) => Promise<object|null>,
 *   simContent?: () => object|null, loadingContent?: () => string|null, vanillaCs?: () => string|null, now?: () => number,
 *   raf?: (fn: (t: number) => void) => any, caf?: (h: any) => void, setInterval?: Function, clearInterval?: Function,
 *   doc?: { hidden?: boolean, addEventListener?: Function } | null, logger?: object,
 *   combatMetrics?: boolean, createHost?: Function, toast?: (text: string, kind?: string) => void,
 *   workerTimeoutMs?: number }} deps
 *   ⚠️ **`loadSim` 有两个契约，按 `dataBaseFor` 注入与否区分**（见 `ensureSim`）：
 *   **注入了 `dataBaseFor`** ⇒ 你的 `loadSim` 必须是 `(dataBase, content?)`（我们的数据面契约：第一个参数是
 *   `/data/` 或 `/room-data/<摘要>/`，第二个是内容集那份已校验的数据或 null）；**没注入** ⇒ 必须是上游 0.3.0 的
 *   `(content?)`（干净页面 / 只要内容集的注入面；第一个参数就是内容集或 null）。两套调用形状由
 *   `test/match/runnerLoadSimContract.test.js` 钉住 —— 调换或删掉任一边，那条判据就红。
 *   `dataBaseFor`（W-D, DESIGN §28.16）: which data face a spec must be simulated on — `/data/` unless the room that
 *   started this battle declared its own set (`public/js/mods/align.js roomDataBase`). The sim is loaded and cached PER
 *   face, so a page that plays in a subset room and later in a plain one never mixes the two.
 *   `contentFor` / `simContent` / `loadingContent` / `vanillaCs`（DESIGN §34.6）: the room's content set the page holds or
 *   is downloading, and the server's original content's cs. Injectable so a Node test drives a content set without a
 *   page; public/js/content.js supplies the browser ones (and `store.content.vanilla`, written by main.js).
 *   `combatMetrics` true/false pins the 作战统计 meter for a test. Omit it and call setCombatMetrics (the settings
 *   screen does; the default is off). A Worker host never attaches the meter.
 *   `createHost`（DESIGN §34.11）: the simulation host to build instead of the two this file picks (public/js/battle/simHost.js).
 */
export function createBattleRunner(deps) {
  const net = deps.net;
  const store = deps.store;
  const now = deps.now || (() => (globalThis.performance ? performance.now() : Date.now()));
  const raf = deps.raf || ((fn) => globalThis.requestAnimationFrame(fn));
  const caf = deps.caf || ((h) => globalThis.cancelAnimationFrame(h));
  const setIv = deps.setInterval || ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIv = deps.clearInterval || ((h) => globalThis.clearInterval(h));
  const doc = deps.doc !== undefined ? deps.doc : (typeof document !== 'undefined' ? document : null);
  // 两条加载契约的缝合处（见 ensureSim 的头注释）：`deps.dataBaseFor` **注入与否**决定 `loadSim` 的第一个参数是什么 ——
  // 注入（浏览器那一份就是 `dataBaseForBattle`，W-D, DESIGN §28.16）⇒ `loadSim(dataBase, content?)`；没注入
  // ⇒ 上游 0.3.0 的 `loadSim(content?)`。两种情况下 `content` 给了都用它那份**已校验**的数据（content.js
  // contentFor），没给就按数据面 / 默认面抓 —— 干净安装 / 没声明集合的房间与从前逐字节相同。
  const perFace = typeof deps.dataBaseFor === 'function';
  const dataBaseFor = perFace ? deps.dataBaseFor : (() => '/data/');
  const browserSim = (content) => loadBrowserSim({ data: content.data, cs: content.cs, bounds: content.bounds ?? null, scripts: content.scripts || [], hashInput: content.hashInput, nativeVerified: content.nativeVerified });
  const loadSim = deps.loadSim || (perFace
    ? (dataBase, content) => (content ? browserSim(content) : loadBrowserSim({ dataBase }))
    : (content) => (content ? browserSim(content) : loadBrowserSim()));
  const logger = deps.logger || SIM_LOGGER;
  // 内容集（DESIGN §34.6）：本页持有的房间内容集（content.js contentFor / simContent）与服务器那一份原始内容的 cs
  const contentFor = deps.contentFor || appContentFor;
  const heldContent = deps.simContent || appSimContent;
  /** the content set the page is downloading now (content.js contentSet: its cs while loading), else null */
  const loadingContent = deps.loadingContent || (() => { const c = appContentSet.get(); return c.status === 'loading' ? c.cs : null; });
  const vanillaCs = deps.vanillaCs || (() => { try { return store?.get?.()?.content?.vanilla ?? null; } catch { return null; } });

  const listeners = new Map();
  const emit = (type, payload) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.warn(`[runner] ${type} listener failed`, err); }
    }
  };

  /** @type {Map<string, any>} battleId → entry */
  const entries = new Map();
  /** Compact combat snapshots of locally simulated battles (battle/metrics.js) for the panel's match totals; `clear`
   *  drops them when the match really restarts（`keepMetrics`）—— 换一轮 prep 仍然留，离开对局才清。 */
  const combatHistory = new Map();
  const rememberCombat = (e) => {
    if (!e.combatMetrics) return;
    const record = e.combatMetrics();
    if (!(combatHistory.get(e.battleId)?.seconds > record.seconds)) combatHistory.set(e.battleId, record);
  };
  // Opt-in (设置「作战统计」, default off). A boolean deps.combatMetrics pins a test and ignores setCombatMetrics.
  // Otherwise screens/game.js pushes the settings store. A Worker host never attaches: its page battle is wire state.
  let metricsWanted = false;
  const metricsEnabled = () => (typeof deps.combatMetrics === 'boolean' ? deps.combatMetrics : metricsWanted);
  const detachCombat = (e) => {
    if (!e?.combatMetrics) return;
    rememberCombat(e);
    try { e.combatMetrics.stop?.(); } catch { /* the reader is already gone */ }
    e.combatMetrics = null;
  };
  function setCombatMetrics(on) {
    if (typeof deps.combatMetrics === 'boolean') return;
    const next = on === true;
    if (next === metricsWanted) return;
    metricsWanted = next;
    // [ASSUMED] turning the meter on does not backfill a battle already prepared: the hooks would have missed the
    // damage already dealt. The next prepare attaches. Turning it off detaches at once.
    if (next) return;
    for (const e of entries.values()) detachCombat(e);
    for (const e of pending.values()) detachCombat(e);
  }
  /** @type {Map<string, any>} battleId → entry of a b.start still being prepared (prepare(); `battle` null until built) */
  const pending = new Map();
  let cur = null;              // entry on screen
  /** data face（W-D, `/data/` 或房间自己那一份）或内容集的 `cs:`（DESIGN §34.6）→ the sim loaded for it（两种 key 分开缓存，
   *  一条来自我们的数据面、一条来自上游的内容集；一页可能都遇到） */
  const sims = new Map();
  let startSeq = 0;            // counts the b.starts: the latest one is the view asked for
  let loading = null;          // the pending entry of the latest b.start (shown when prepared)
  let rafH = null;
  let ivH = null;
  let lastPool = null;
  /** solo pause: the runner clock's instant when m.public.paused turned true (null while running) */
  let pausedAt = null;
  /**
   * **本地播放倍速**（玩家在顶栏按的那个）：只改「墙钟 → tick」的映射，**不改 tick 序列**。
   * 服务端给的 `speed`（`b.start` 里那一份，今天恒为 2）是**对局**的节奏，玩家改不了也不该改；
   * 这里乘上去的是**这台机器看得多快**，所以两端算出的战果仍然逐 tick 相同（`targetTick` 的注释）。
   * 上限见 `RATE_MAX`：再快也只是同一段 tick 跑得更急，但帧预算会被 `ticksPerFrameCap` 夹住，
   * 所以「无限快」不会绕过任何判定，只会让画面跳。
   */
  let rate = 1;
  /** a normal field's leak count (or a battle's bond layers) changed since the last publishState() */
  let leaksDirty = false;
  const stats = { ticks: 0, stepMs: 0, maxFrameMs: 0, catchups: 0, errors: 0, battles: 0, frames: 0 };
  /** Hidden-tab backlog tuple → the game time it was drained at (emitFrame batches the backlog by it). */
  const heldAt = new WeakMap();

  const hidden = () => !!(doc && doc.hidden);
  /** The battle clock: frozen at the pause instant while the solo battle is paused. */
  const clock = () => (pausedAt != null ? pausedAt : now());
  const bossLike = (e) => e.kind === 'boss' || e.kind === 'hidden';

  /**
   * Whether `cs` (a b.start spec's content) is a content this page can be the authority of. A spec with no `cs` is always
   * accepted — that is every spec of a server with no content identity, exactly as before (DESIGN §34). The server names
   * the content in every spec once it has one (`welcome.content.vanilla`, Lobby.welcomeInfo), and the page keeps that
   * identity in `store.content` — `main.js` writes it from `welcome`（本批合入）。
   *
   * **D24 已翻（本批）**：身份不知道时 `return false` —— 这是上游的写法，也正是
   * `test/ui/plugins-content.test.js`「a page that does not know the original content's cs is no authority of a spec
   * naming one」钉的那条：页面说不出该在哪份数据上模拟，就不该当这一场的权威。上一批曾**暂定 `return true`**
   * （那时 `main.js` 还没合，`store.content` 恒为 null，照上游写会让每一个带 cs 的 spec 都变非权威 —— 真回归）；
   * 本批把 `main.js` 的 `welcome.content.vanilla` 落进 store 之后翻回 false，这个分歧只活了那一批。
   * 已知是**另一个**内容集时两种写法都拒绝。
   * @param {unknown} cs @param {{ loading?: boolean }} [opts]
   */
  function csAccepted(cs, { loading = false } = {}) {
    if (typeof cs !== 'string' || cs === '') return true;
    const vanilla = vanillaCs();
    if (vanilla == null) return false; // D24 已翻：上游的写法（见上）
    if (cs === vanilla) return true;
    const held = heldContent();
    return (!!held && held.cs === cs) || (loading && loadingContent() === cs);
  }

  /**
   * The sim a spec must be simulated on: **our data face** (W-D, DESIGN §28.16 — `dataBaseFor`: `/data/` or the room's own
   * `/room-data/<digest>/`) unless the spec names a content set this page holds or is downloading (DESIGN §34.6) — then
   * that checked set's own data (content.js contentFor). One sim per face / per content set, cached: a page may meet both.
   *
   * ⚠️ 合入缝合处：上游把这一个函数整体换成「只按内容集」。本树保留 W-D 的数据面作为**没有内容集时**的那条来源 ——
   * 两条都在、key 分开缓存，所以干净安装 / 没声明集合的房间的加载器与从前逐字节相同
   * (`test/match/runnerDataBase.test.js` 钉的就是这条)。上游的 `deps.loadSim ? 本页加载 : remote` 判据照搬：
   * 没有注入加载器（浏览器）时，房间内容集交给 Worker 宿主；注入了（测试 / 注入面）就在本页建。
   *
   * **`loadSim` 的两个契约（`perFace`）**：注入 `deps.dataBaseFor` 的调用方是在要「按数据面加载」那条能力，它的
   * `loadSim` 因此是 `(dataBase, content?)`（我们的契约，`runnerDataBase.test.js` 钉着）；没注入的调用方（干净页面、
   * 只关心内容集的注入面）拿到的是**上游 0.3.0 的 `loadSim(content?)`**（`plugins-content.test.js` 钉着）。
   * 两个契约不能合成一个参数位（一个要面、一个要 content），所以按「有没有要数据面」分开 —— 这不是给测试开的后门，
   * 而是这次合并里唯一能把两条来源都留下的形状；`content` 给定时两条都进同一个 `browserSim`。
   */
  function ensureSim(spec = null) {
    const base = dataBaseFor(spec);
    const cs = spec && spec.cs;
    const vanilla = vanillaCs();
    const want = typeof cs === 'string' && cs !== '' && vanilla != null && cs !== vanilla ? cs : null;
    const key = want ? `cs:${want}` : base;
    let p = sims.get(key);
    if (!p) {
      p = (want
        ? contentFor(want).then((content) => {
          if (!content || content.cs !== want) throw new Error(`the content set ${want.slice(0, 8)} is not loaded on this page`);
          return deps.loadSim ? (perFace ? loadSim(base, content) : loadSim(content)) : { content, cs: want, remote: true };
        })
        : (perFace ? loadSim(base, null) : loadSim(null))).catch((err) => { sims.delete(key); throw err; });
      sims.set(key, p);
    }
    return p;
  }

  /** Counted leaks so far of every normal field simulated here: { [fieldId]: n } (user playtest #3 item 2). */
  function leakMap() {
    const out = {};
    for (const e of entries.values()) if (e.kind === 'normal' && e.fieldId) out[e.fieldId] = e.leaks;
    return out;
  }

  /**
   * Live bond layers of every battle simulated here (DESIGN §20.15): { [playerId]: { [bondId]: n } } — only the bonds
   * whose layers grew in this round's battle, as absolute counts (the battle's live copy, ≤ BOND_LAYER_CAP).
   */
  function layerMap() {
    const out = {};
    for (const e of entries.values()) {
      if (!e.live) continue;
      for (const [pid, m] of Object.entries(e.live)) out[pid] = { ...(out[pid] || {}), ...m };
    }
    return out;
  }

  /**
   * The 联防 field on screen (never an older round's kept entry, nor while a new battle is being prepared): each
   * leaker's enemies still standing { [playerId]: n } (absent = none left), else null.
   */
  function uniteLeftMap() {
    const e = cur;
    return !loading && e && e.kind === 'unite' && e.left ? { ...e.left } : null;
  }

  function state() {
    const e = cur;
    if (!e) return loading ? { loading: true, battleId: loading.battleId, fieldId: loading.fieldId, kind: loading.kind, leaks: leakMap(), uniteLeft: uniteLeftMap(), bondLayers: layerMap() } : null;
    return {
      battleId: e.battleId, fieldId: e.fieldId, kind: e.kind, authoritative: e.authoritative, watch: e.watch,
      done: e.done, own: e.own, members: e.members.slice(), loading: !!loading, speed: e.speed, paused: pausedAt != null,
      leaks: leakMap(), uniteLeft: uniteLeftMap(), bondLayers: layerMap(),
    };
  }

  function publishState() {
    leaksDirty = false;
    const s = state();
    try { store.patch('match', { battle: s }); } catch { /* store without a match slice */ }
    emit('state', s);
  }

  /**
   * Re-count an entry's leaks when its battle recorded a new one (Battle.leakedCount) or ended (timeout leaks, and the
   * final result): the settle rule's count, leaked entries with counted !== false (/sim/spec.js battleProgress).
   * 联防: each leaker's enemies still standing (/sim/spec.js uniteLeft) whenever a kill, a leak, a spawn or the end
   * changed them.
   */
  function noteLeaks(e) {
    noteLayers(e);
    if (e.kind === 'unite') { noteUniteLeft(e); return; }
    if (e.kind !== 'normal') return;
    const b = e.battle;
    const mark = `${Number(b.leakedCount) || 0}:${b.finished ? 1 : 0}`;
    if (mark === e.leakMark) return;
    e.leakMark = mark;
    let n = e.leaks;
    try { n = Math.max(0, Math.trunc(Number(e.host.progress().leaks) || 0)); } catch { /* keep the last count */ }
    if (n !== e.leaks) { e.leaks = n; leaksDirty = true; }
  }

  function noteUniteLeft(e) {
    const b = e.battle;
    const mark = uniteLeftMark(b);
    if (mark === e.leakMark) return;
    e.leakMark = mark;
    let left = e.left;
    try { left = e.host.uniteLeft() || left; } catch { /* keep the last count */ }
    if (JSON.stringify(left) !== JSON.stringify(e.left)) { e.left = left; leaksDirty = true; }
  }

  /**
   * Re-read an entry's live bond layers (DESIGN §20.15): per player of its spec, the bonds whose layers in the battle's
   * live copy (Battle.addLayers, clamped at BOND_LAYER_CAP like the client's AddBondCount) exceed the spec's start
   * count. Nothing to do when the battle disables gains (联防, boss rounds).
   */
  function noteLayers(e) {
    const b = e.battle;
    if (!b || (b.flags && b.flags.layerGainsEnabled === false) || typeof b.getPlayer !== 'function') return;
    let sum = 0;
    let live = null;
    for (const sp of Array.isArray(e.spec.players) ? e.spec.players : []) {
      const ps = sp && sp.playerId != null ? b.getPlayer(sp.playerId) : null;
      if (!ps || !ps.bonds || typeof ps.bonds !== 'object') continue;
      const start = sp.bonds && typeof sp.bonds === 'object' ? sp.bonds : {};
      for (const id of Object.keys(ps.bonds)) {
        const n = Number(ps.bonds[id] && ps.bonds[id].layers) || 0;
        const from = Number(start[id] && start[id].layers) || 0;
        if (!(n > from)) continue;
        sum += n - from;
        if (!live) live = {};
        if (!live[sp.playerId]) live[sp.playerId] = {};
        live[sp.playerId][id] = n;
      }
    }
    if (sum === e.layerSum) return;
    e.layerSum = sum;
    e.live = live;
    leaksDirty = true;
  }

  /** Publish the state when a leak count (or a battle's bond layers) changed since the last publish. */
  function flushLeaks() { if (leaksDirty) publishState(); }

  /**
   * Target tick of an entry on its clock.
   *
   * `rate` 是**本地播放倍速**（玩家按的那个 ×1/×2/×3/×4）：它只改「墙钟时间怎么映射到 tick」，**不改 tick 序列**
   * —— 同一场战斗、同一种子，无论 rate 是多少，跑过的 tick 数与判定完全相同，只是**跑得快慢**不同。
   * 这正是「只加快播放，结果不变」在代码里的形状，也是它安全的原因：`Battle` 的确定性来自 tick 序列，
   * 不来自我们多久调一次 `step()`。
   */
  const targetTick = (e, t) => Math.max(0, Math.floor((((t - e.t0) / 1000) * e.speed * rate) / TICK + 1e-9));

  /**
   * Step `n` ticks. `sliced` (a catch-up frame, a hidden-tab step): every EV_SLICE ticks the events drained so far go to
   * `e.slices` as { gt, ev } with that game time, for emitFrame / hold.
   */
  function stepEntry(e, n, sliced = false) {
    const b = e.battle;
    const t = now();
    let k = 0;
    const accept = (out) => { k = out.ticks; e.slices.push(...out.slices); };
    try {
      const out = e.host.step(n, { slice: sliced ? EV_SLICE : 0 });
      if (e.host.remote) return out.then((value) => {
        if (e.failed) return 0;
        accept(value);
        const dt = now() - t;
        stats.ticks += k; stats.stepMs += dt;
        return dt;
      });
      accept(out);
    } catch (err) {
      stats.errors++;
      console.warn('[runner] battle step failed', err);
      recordError('runner', err, 'battle step failed');
      try { b.forceEnd('timeout'); } catch { /* ignore */ }
    }
    const dt = now() - t;
    stats.ticks += k;
    stats.stepMs += dt;
    return dt;
  }

  function frameOf(e) {
    const snap = e.battle.snapshot();
    const { t: gt, ...rest } = snap || {};
    return { ...rest, t: 'b.snap', fieldId: e.fieldId, gt: Number.isFinite(gt) ? gt : 0 };
  }

  /** The steps' events, each batch with its own game time: the sliced ones (stepEntry), then the rest at `gt`. */
  function drainSlices(e, gt) {
    let ev;
    try { ev = e.battle.drainEvents() || []; } catch { ev = []; }
    const out = e.slices;
    e.slices = [];
    if (ev.length) out.push({ gt, ev });
    return out;
  }

  function emitFrame(e, catchingUp) {
    // the hidden-tab backlog overflowed: the view starts again from the field meta (UnitInfo carries every unit's form)
    if (e.stale) { show(e); return; }
    const gt = Number(e.battle.time) || 0;
    // the hidden-tab backlog first, batched by the game time each tuple was drained at (a tuple put there by hand: now)
    const held = e.held;
    if (held.length) e.held = [];
    let run = null;
    for (const x of held) {
      const at = heldAt.get(x) ?? gt;
      if (!run || run.gt !== at) { if (run) emit('ev', run); run = { t: 'b.ev', fieldId: e.fieldId, gt: at, ev: [] }; }
      run.ev.push(x);
    }
    if (run) emit('ev', run);
    for (const s of drainSlices(e, gt)) {
      const list = catchingUp ? s.ev.filter(keepsState) : s.ev;
      if (list.length) emit('ev', { t: 'b.ev', fieldId: e.fieldId, gt: s.gt, ev: list });
    }
    try { emit('snap', frameOf(e)); } catch (err) { console.warn('[runner] snapshot failed', err); recordError('runner', err, 'snapshot failed'); }
  }

  /**
   * Events of a step that is not rendered (hidden tab): the battle on screen keeps its state-bearing ones for the next
   * rendered frame (keepsState, ≤ HELD_MAX — beyond that it is re-entered from the field meta); any other battle starts
   * from its field meta when shown (show()), so its events go.
   */
  function hold(e) {
    const batches = drainSlices(e, Number(e.battle.time) || 0);
    if (e !== cur || e.stale) return;
    for (const s of batches) for (const x of s.ev) if (keepsState(x)) { e.held.push(x); heldAt.set(x, s.gt); }
    if (e.held.length > HELD_MAX) {
      e.held = compactHeld(e.held);
      if (e.held.length > HELD_MAX) { e.held = []; e.stale = true; }
    }
  }

  /**
   * The tab is visible again: the battle on screen that ended while it was hidden (advance() no longer runs for it)
   * delivers its backlog and last snapshot now — else the view kept the pre-hide state for the rest of the phase.
   */
  function flushHidden() {
    const e = cur;
    if (e && e.battle.finished && (e.held.length || e.stale)) emitFrame(e, false);
  }

  function progress(e, force = false) {
    if (!e.authoritative || e.resultSent || !net) return;
    const t = now();
    const every = bossLike(e) ? 250 : 1000;
    if (!force && t - e.lastProgressAt < every) return;
    e.lastProgressAt = t;
    e.meter = e.host.meter;
    const p = e.host.progress();
    const msg = { battleId: e.battleId, gt: Math.min(1e5, p.gt), killed: Math.min(p.killed, p.total), total: Math.min(1e5, p.total), done: !!p.done };
    // the HUD capsule's numerator of this field (shared/protocol.js b.progress `resolved`): the field's own scheduled
    // enemies knocked out or leaked. Sent only when the battle reports one (Battle.resolved) — an absent field leaves
    // the teammate UI on its `resolved ?? killed` fallback
    if (Number.isFinite(p.resolved)) msg.resolved = Math.max(0, Math.min(msg.total, p.resolved));
    if (bossLike(e)) {
      const pool = e.battle.sharedBoss;
      msg.leaks = Math.min(1e6, e.meter.lp);
      // the split of that LP between the players' own leaks (the rest is the leader's effects): the server holds the result's
      // leaked lists to it before a perfect-payout bounty pays (Match._bossLeaksAgree)
      if (p.leaksBy) msg.leaksBy = p.leaksBy;
      msg.bossDmg = pool && Number.isFinite(pool.cum) ? pool.cum : 0;
      if (pool && pool.byPlayer) {
        const by = {};
        for (const pid of Object.keys(pool.byPlayer).slice(0, 4)) by[pid] = pool.byPlayer[pid];
        msg.by = by;
      }
    } else {
      msg.leaks = Math.min(1e6, p.leaks);
      // 联防: the leakers' enemies still standing (shared/protocol.js b.progress `left`, ≤ 4 players)
      if (p.left) msg.left = Object.fromEntries(Object.entries(p.left).slice(0, 4));
    }
    try { net.send('b.progress', msg); } catch { /* offline */ }
  }

  function finished(e) {
    if (e.done) return;
    e.done = true;
    noteLeaks(e);
    if (e.authoritative && !e.resultSent && net) {
      progress(e, true);
      e.resultSent = true;
      let result = null;
      try {
        result = e.host.compactResult({ bossLike: bossLike(e), battleId: e.battleId });
      } catch (err) { console.warn('[runner] result failed', err); recordError('runner', err, 'result failed'); }
      if (result) {
        e.result = result;
        // the view answers with the settlement voice of this battle (screens/game.js → audio.voice result*): the
        // compact result carries the leaks and the kill count the slot is picked from
        emit('result', { fieldId: e.fieldId, battleId: e.battleId, own: !!e.own, result });
        deliver(e);
      }
    }
    if (e === cur) publishState();
    else flushLeaks();
  }

  /**
   * Send an entry's b.result (retried once on a timeout). `e.delivery`: 'pending' while a request is out, 'delivered'
   * once the server answered (ok, or a refusal — final), 'undelivered' when it never got there (LOST_RESULT_CODES): kept
   * for redeliver() (session back online) and for an authoritative b.start of the finished battle.
   */
  function deliver(e) {
    if (!net || !e.result || e.delivery === 'pending') return;
    e.delivery = 'pending';
    // a room's content set names itself in the result (DESIGN §34.6: the server refuses one without it) — the set the
    // battle was actually simulated on (its simulation's `cs`: loadBrowserSim's), never only what the spec claims; the
    // original content's result is what it always was
    const cs = e.sim && typeof e.sim.cs === 'string' && e.sim.cs ? e.sim.cs : null;
    const msg = cs ? { battleId: e.battleId, result: e.result, cs } : { battleId: e.battleId, result: e.result };
    const send = (tries) => {
      let req;
      try { req = net.request('b.result', msg, { timeout: 15000 }); } catch (err) { req = Promise.reject(err); }
      return Promise.resolve(req).then(() => { e.delivery = 'delivered'; }, (err) => {
        const code = err && err.code;
        if (code === 'TIMEOUT' && tries > 0) return send(tries - 1);
        if (LOST_RESULT_CODES.includes(code)) {
          e.delivery = 'undelivered';
          console.warn(`[runner] b.result not delivered (${code}) — sent again when the session resumes`);
        } else {
          e.delivery = 'delivered';
          console.warn('[runner] b.result refused', code);
          recordError('runner', code, 'b.result refused');
        }
        return null;
      });
    };
    send(1);
  }

  /** The session is back: every result lost with the socket goes out again. */
  function redeliver() {
    for (const e of entries.values()) if (e.delivery === 'undelivered') deliver(e);
  }

  /** Solo pause (m.public.paused): freeze / resume every local battle clock. */
  function setPaused(on) {
    if (on === (pausedAt != null)) return;
    if (on) {
      pausedAt = now();
    } else {
      const d = Math.max(0, now() - pausedAt);
      pausedAt = null;
      // a pending battle not built yet takes its clock when it is built
      for (const e of [...entries.values(), ...pending.values()]) if (e.t0 != null) { e.t0 += d; e.lastProgressAt += d; }
    }
    publishState();
    schedule();
  }

  /** Advance one entry to its clock (bounded); render it when it is on screen. */
  function advance(e, t, render) {
    if (e.battle.finished) { if (!e.done) finished(e); return; }
    const behind = targetTick(e, t) - (e.battle.tickCount || 0);
    if (behind <= 0) return;
    const cap = ticksPerFrameCap(e.speed);
    const catchingUp = behind > cap * 4;
    if (catchingUp) stats.catchups++;
    const n = Math.min(behind, catchingUp ? CATCHUP_TICKS : cap);
    if (e.stepping || e.failed) return;
    const finishStep = (dt) => {
      if (e.failed || entries.get(e.battleId) !== e) return;
      if (dt > stats.maxFrameMs) stats.maxFrameMs = dt;
      if (render && e === cur) emitFrame(e, catchingUp);
      else hold(e);
      noteLeaks(e);
      progress(e);
      if (e.battle.finished) finished(e);
      flushLeaks();
    };
    const step = stepEntry(e, n, catchingUp || !render);
    if (e.host.remote) {
      e.stepping = true;
      step.then(finishStep, err => failWorker(e, err)).finally(() => { e.stepping = false; schedule(); });
    } else finishStep(step);
  }

  /** Stop reports immediately. Existing server deadline/takeover is the fallback; b.result's cs refusal asks for it now. */
  function failWorker(e, err) {
    if (e.failed || (pending.get(e.battleId) !== e && entries.get(e.battleId) !== e)) return;
    const authority = e.authoritative;
    e.failed = true; e.authoritative = false; e.done = true;
    e.host?.stop();
    stats.errors++;
    recordError('runner', err, 'plugin worker stopped');
    const text = t('插件卡死，本场由服务器接管');
    if (deps.toast) deps.toast(text, 'error');
    else if (typeof document !== 'undefined') import('../ui/toasts.js').then(m => m.toast(text, 'error')).catch(() => {});
    emit('takeover', { battleId: e.battleId, fieldId: e.fieldId, text });
    // A structurally valid result with no cs is always refused for gameplay sets (requireCs), invoking _runOnServer.
    // It is a failure signal only, never a claimed battle outcome. Vanilla never reaches this path.
    if (authority) {
      const perPlayer = Object.fromEntries(e.members.map(id => [id, { killed: 0, total: 0, leaked: [], perfect: false, layerGains: {}, unitsEnd: [] }]));
      try { Promise.resolve(net.request('b.result', { battleId: e.battleId, result: { reason: 'forced', time: 0, perPlayer } })).catch(() => {}); } catch { /* deadline takes over offline */ }
    }
    if (cur === e) cur = null;
    if (loading === e) loading = null;
    publishState(); schedule();
  }

  function running(e) { return !e.failed && !e.battle.finished && (e === cur || (e.authoritative && !e.resultSent)); }

  function frame() {
    rafH = null;
    stats.frames++;
    const t = clock();
    for (const e of [...entries.values()]) if (running(e)) advance(e, t, e === cur);
    flushLeaks();
    schedule();
  }

  function pump() {
    // hidden tab: no animation frames — keep authoritative battles on their clock (no rendering)
    if (!hidden()) return;
    for (const e of [...entries.values()]) if (e.authoritative && running(e)) advance(e, clock(), false);
    flushLeaks();
  }

  function schedule() {
    // paused: nothing to step (the view keeps its last frame); resume reschedules
    const any = pausedAt == null && [...entries.values()].some(running);
    if (any && rafH == null && !hidden()) rafH = raf(frame);
    const needPump = pausedAt == null && [...entries.values()].some((e) => e.authoritative && running(e));
    if (needPump && ivH == null) ivH = setIv(pump, 250);
    else if (!needPump && ivH != null) { clearIv(ivH); ivH = null; }
  }

  /** Put an entry on screen: field meta into the store (the game screen enters it), then its current frame. */
  function show(e) {
    cur = e;
    e.held = [];
    e.slices = [];
    e.stale = false;
    let meta;
    try { meta = e.battle.fieldMeta(); } catch { meta = { units: [] }; }
    const field = {
      t: 'm.field', ...meta, fieldId: e.fieldId, kind: e.kind, rect: meta.rect ?? e.spec.rect, stageId: meta.stageId ?? e.spec.stageId,
      live: !e.done, battleId: e.battleId, players: e.members.slice(), local: true, speed: e.speed,
      // the watched player's effects column (user playtest #2; undefined for 联防 / boss pairs and server-run fields)
      effects: spectateEffects(e.spec, e.members),
      // which half each player holds (联防: the first helper takes the right half; boss pairs: L / R)
      sides: Object.fromEntries((e.spec.players || []).filter((p) => p && p.playerId).map((p) => [p.playerId, p.side === 'R' || Number(p.colOffset) >= 8 ? 'R' : 'L'])),
    };
    emit('field', field);
    try { store.patch('match', { field }); } catch { /* ignore */ }
    publishState();
    try { e.battle.drainEvents(); } catch { /* the view starts from the meta + this frame */ }
    emit('snap', frameOf(e));
    schedule();
  }

  function evict() {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [id, e] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (e === cur || (e.authoritative && !e.resultSent) || e.own || e.delivery === 'pending' || e.delivery === 'undelivered') continue;
      rememberCombat(e);
      e.host?.stop();
      entries.delete(id);
    }
  }

  function yieldFrame() { return new Promise((resolve) => { if (hidden()) setTimeout(resolve, 0); else raf(() => resolve()); }); }

  async function onStart(msg) {
    if (!msg || typeof msg !== 'object' || !msg.spec || typeof msg.battleId !== 'string') return;
    const speed = Number(msg.speed) > 0 ? Number(msg.speed) : 2;
    const seq = ++startSeq;
    const prep = pending.get(msg.battleId);
    const existing = entries.get(msg.battleId) || prep;
    if (existing) {
      existing.seq = seq;
      const was = existing.authoritative;
      existing.authoritative = !!msg.authoritative && !existing.failed && !existing.resultSent && csAccepted(existing.spec.cs, { loading: !existing.battle });
      existing.watch = !!msg.watch;
      // the server still waits for this finished battle's result (lost with the socket, or its answer was): again
      if (msg.authoritative && existing.resultSent) deliver(existing);
      if (!existing.battle) {
        // still loading: it starts from the latest field clock
        existing.elapsed = Number(msg.elapsed) || 0;
      } else if (existing.authoritative && !was) {
        // handover (the partner left): continue from the field's clock and report from now on
        existing.t0 = clock() - ((Number(msg.elapsed) || 0) / speed) * 1000;
        existing.lastProgressAt = -Infinity;
        if (existing.battle.finished) { existing.done = false; finished(existing); }
      }
      if (prep) {
        // being prepared: the view asked for again, shown when ready (one Battle per battleId)
        loading = prep;
        publishState();
        return prep.ready;
      }
      loading = null;
      // a resend of what is already on screen (reconnect / resync) only updates the state; switching back shows it
      if (existing.failed) return;
      if (cur !== existing) show(existing);
      else { publishState(); schedule(); }
      return;
    }
    const e = {
      battleId: msg.battleId, fieldId: msg.fieldId || msg.spec.fieldId, kind: msg.kind || msg.spec.kind, spec: msg.spec,
      // built by prepare(); `seq` = its latest b.start, `elapsed` = the field clock to start from, `endReason` = the first
      // forced / timeout b.end (applied once the Battle exists), `ready` = the preparation (a promise)
      sim: null, battle: null, meter: null, seq, elapsed: Number(msg.elapsed) || 0, endReason: null, ready: null,
      // (a spec of another content than the page's: a display replica only — see the header)
      authoritative: !!msg.authoritative && csAccepted(msg.spec.cs, { loading: true }), watch: !!msg.watch, own: !msg.watch, speed,
      members: (msg.spec.players || []).map((p) => p && p.playerId).filter(Boolean),
      t0: null, lastProgressAt: -Infinity, done: false, resultSent: false,
      result: null, delivery: null,
      // local-only combat accounting (battle/metrics.js), attached once the Battle exists; the 作战统计 panel reads
      // it on demand — never sent to the server
      combatMetrics: null,
      // counted leaks so far (normal fields; noteLeaks) and the Battle state they were counted at; 联防 fields: each
      // leaker's enemies still standing (noteUniteLeft)
      leaks: 0, leakMark: '', left: null,
      // live bond layers grown in this battle { [playerId]: { [bondId]: n } } and their total gain (noteLayers)
      live: null, layerSum: 0,
      // state-bearing events of the steps run while the tab was hidden (hold(); delivered by the next rendered frame;
      // heldAt = the game time each was drained at), and whether that backlog overflowed (the next frame re-enters the
      // view from the field meta); the event batches of the current sliced step (stepEntry)
      held: [], stale: false, slices: [],
    };
    pending.set(e.battleId, e);
    loading = e;
    publishState();
    e.ready = prepare(e);
    return e.ready;
  }

  /**
   * Build a pending entry's Battle once the sim is loaded, apply the b.end that came meanwhile, catch it up silently to
   * the field's clock and register it (shown when it is still the view asked for). It is dropped when clear() removed it
   * (or a new b.start replaced it after a clear) and when a b.start of another field superseded it — unless it is an
   * authority (it must finish and report) or the server already ended it (switching back shows the end).
   */
  async function prepare(e) {
    const wanted = () => pending.get(e.battleId) === e && (e.seq === startSeq || e.authoritative || !!e.endReason);
    try {
      let sim;
      try { sim = await ensureSim(e.spec); } catch (err) {
        console.warn('[runner] simulation unavailable', err);
        recordError('runner', err, 'simulation unavailable');
        return;
      }
      if (!wanted()) return;
      // the content the simulation holds must still be the spec's (the room could have changed it meanwhile)
      if (!csAccepted(e.spec.cs)) e.authoritative = false;
      let battle;
      try {
        // 宿主（DESIGN §34.11）：注入面给的 createHost；否则本页原始内容跑 InPageSimHost、房间的内容集跑 Worker 宿主
        e.host = deps.createHost ? deps.createHost(sim, (err) => failWorker(e, err))
          : sim.remote ? new WorkerSimHost({ onFailure: (err) => failWorker(e, err), timeoutMs: deps.workerTimeoutMs })
            : new InPageSimHost();
        if (e.host.remote) {
          await e.host.load(sim.cs, sim.content);
          if (!wanted()) return;
          await e.host.start(e.spec);
        } else {
          // 工坊行为层: rebuild the very kits the server verifies this field with (see loadSpecKits). Both key spaces —
          // operators (`kits`) and summons (`tokenKits`) — from that ONE module list; an empty map changes nothing.
          // 同一份清单还带着每个 kit 的**归属包**与那个包的**生效预算**（DESIGN §28.52 的 kit 那一半）：它们与 kits
          // 一起交给战斗，kit 的逐单位回调因此与服务端落在**同一本账**、**同一个数字**上。空表不写这几个键
          // （KEY DISCIPLINE：没有包时 Battle opts 的形状与从前逐字节相同）。
          const { kits, tokenKits, kitOwners, tokenKitOwners, kitBudgets } = await loadSpecKits(e.spec);
          // 包声明的战斗逻辑（`server.battle`, DESIGN §28.17）：同一场战斗、同一段代码（见 loadSpecBattleInstallers）
          const battleInstallers = await loadSpecBattleInstallers(e.spec);
          // ⚠️ 我们这条 sim 是按**数据面**（W-D）自己加载好的，所以这里不走 host.load()，直接交付给宿主
          e.host.sim = sim;
          e.host.start(e.spec, {
            logger, kits, tokenKits,
            ...(kitOwners.size ? { kitOwners } : {}),
            ...(tokenKitOwners.size ? { tokenKitOwners } : {}),
            ...(kitBudgets.size ? { kitBudgets } : {}),
            ...(battleInstallers ? { battleInstallers } : {}),
          });
        }
        battle = e.host.battle;
      } catch (err) {
        if (e.host?.remote) failWorker(e, err);
        else { console.warn('[runner] battle construction failed', err); recordError('runner', err, 'battle construction failed'); }
        return;
      }
      if (!wanted() || e.failed) return;
      stats.battles++;
      e.sim = sim;
      e.battle = battle;
      e.meter = e.host.meter;
      // The Worker page holds wire state only (time, ids): no `damaged` hook and no `heal`, so trackCombat cannot
      // run there. An in-page Battle gets the meter only when 作战统计 is on (default off; a test may pin it).
      if (metricsEnabled() && !e.host.remote) e.combatMetrics = trackCombat(battle);
      e.t0 = clock() - (e.elapsed / e.speed) * 1000;
      if (lastPool) await e.host.syncPool(lastPool.hp, lastPool.acked ? lastPool.acked[e.fieldId] : undefined);
      if (e.endReason) await endBattle(e);
      // silent catch-up to the field's clock before it is shown (a reconnect / observing a running field) — for the view
      // asked for; a superseded authority catches up in the background (advance)
      while (!battle.finished && e.seq === startSeq && targetTick(e, clock()) - battle.tickCount > ticksPerFrameCap(e.speed)) {
        const n = Math.min(PREPARE_SLICE, targetTick(e, clock()) - battle.tickCount);
        await stepEntry(e, n);
        try { battle.drainEvents(); } catch { /* ignore */ }
        noteLeaks(e);
        progress(e);
        await yieldFrame();
        if (!wanted() || e.failed) return;
      }
      pending.delete(e.battleId);
      entries.set(e.battleId, e);
      evict();
      noteLeaks(e);
      leaksDirty = true; // its leak count / bond layers join the published state
      if (e.seq === startSeq) { loading = null; show(e); }
      if (battle.finished) finished(e);
      flushLeaks();
      schedule();
    } catch (err) {
      if (e.host?.remote) failWorker(e, err); else throw err;
    } finally {
      if (entries.get(e.battleId) !== e) e.host?.stop();
      if (pending.get(e.battleId) === e) pending.delete(e.battleId);
      if (loading === e) { loading = null; publishState(); }
    }
  }

  function onPool(msg) {
    if (!msg || typeof msg !== 'object') return;
    lastPool = msg;
    // a pending battle not built yet takes lastPool when it is built
    for (const e of [...entries.values(), ...pending.values()]) {
      if (e.battle && !e.failed) e.host.syncPool(msg.hp, msg.acked ? msg.acked[e.fieldId] : undefined);
    }
    emit('pool', msg);
  }

  function onEnd(msg) {
    const e = msg && (entries.get(msg.battleId) || pending.get(msg.battleId));
    if (!e || e.failed) return;
    if (msg.reason === 'takeover') {
      e.authoritative = false;
      if (e === cur) publishState();
      schedule();
      return;
    }
    // the first end counts; a battle still loading ends as soon as it is built (prepare)
    if (!e.endReason) e.endReason = msg.reason === 'timeout' ? 'timeout' : 'forced';
    if (e.battle) endBattle(e);
  }

  /** End an entry's battle with its b.end reason; an authority reports it at once. */
  function endBattle(e) {
    if (e.host.remote) return e.host.forceEnd(e.endReason).then(() => {
      if (e.failed || (!entries.has(e.battleId) && !pending.has(e.battleId))) return;
      e.meter = e.host.meter;
      if (e === cur) emitFrame(e, false);
      finished(e); flushLeaks(); schedule();
    }, err => failWorker(e, err));
    if (!e.battle.finished) {
      try { e.host.forceEnd(e.endReason); } catch { /* ignore */ }
    }
    if (e === cur) emitFrame(e, false);
    finished(e);
    flushLeaks();
    schedule();
  }

  /**
   * Drop every battle (a new round's prep, the match ended, the player left). Each dropped battle keeps its last
   * combat snapshot in combatHistory for the panel's match totals; `keepMetrics` false (a new match) starts over.
   */
  function clear({ keepMetrics = false } = {}) {
    ++startSeq;
    loading = null;
    for (const e of entries.values()) {
      // never drop an unreported authoritative result (the round already moved on: the server has its own).
      // A Worker battle is ended by stopping its host below, not by forceEnd on the page-side stub.
      if (!e.host?.remote && e.authoritative && !e.resultSent && e.battle && !e.battle.finished) { try { e.battle.forceEnd('forced'); } catch { /* ignore */ } }
      rememberCombat(e);
    }
    // a battle still being prepared too: its preparation finds itself gone and stops (prepare). Snapshot first:
    // host.stop() drops the in-page Battle the meter reads.
    for (const e of pending.values()) rememberCombat(e);
    for (const e of [...entries.values(), ...pending.values()]) e.host?.stop();
    pending.clear();
    entries.clear();
    if (!keepMetrics) combatHistory.clear();
    cur = null;
    lastPool = null;
    if (rafH != null) { caf(rafH); rafH = null; }
    if (ivH != null) { clearIv(ivH); ivH = null; }
    publishState();
  }

  const offs = [];
  if (net && typeof net.on === 'function') {
    offs.push(net.on('b.start', (m) => { onStart(m).catch((err) => console.warn('[runner] b.start failed', err)); }));
    offs.push(net.on('b.pool', onPool));
    offs.push(net.on('b.end', onEnd));
    // the session is back (reconnect / resume): results lost with the old socket go out again
    offs.push(net.on('status', (st) => { if (st && st.status === 'online') redeliver(); }));
  }
  // phase changes: combat fields live until the next prep; leaving the match drops everything
  let lastPhase = null;
  let lastRound = 0;
  if (store && typeof store.subscribe === 'function') {
    offs.push(store.subscribe((s) => {
      const pub = s && s.match && s.match.public ? s.match.public : null;
      const round = Number(pub?.round) || 0;
      // a fresh match (m.public gone), a rewound round or a return to a lobby-like phase resets the combat totals
      const resetMetrics = (!pub && lastPhase != null) || round < lastRound
        || (pub?.phase !== lastPhase && ['LOBBY', 'INFO_CHECK', 'BAND_DRAFT', 'BATTLE_CHECK'].includes(pub?.phase));
      if (resetMetrics) combatHistory.clear();
      lastRound = round;
      // solo pause (DESIGN §14): the local battle clocks follow m.public.paused
      setPaused(!!(pub && pub.paused));
      const phase = pub ? pub.phase : null;
      if (phase === lastPhase && !resetMetrics) return;
      lastPhase = phase;
      if (!phase || ['PREP', 'ROUND_START', 'SP_DRAFT', 'RESULT', 'LOBBY', 'INFO_CHECK', 'BAND_DRAFT', 'BATTLE_CHECK'].includes(phase)) {
        if (entries.size || pending.size) clear({ keepMetrics: !resetMetrics });
      }
      // warm the simulation up as soon as a match runs (the first b.start then starts at once)
      if (phase && phase !== 'LOBBY' && sims.size === 0) ensureSim().catch(() => {});
    }));
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => { if (hidden()) return; flushHidden(); schedule(); });
  }

  return {
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    state,
    /**
     * 设置「作战统计」. Ignored when `deps.combatMetrics` pins the runner. Off detaches meters already attached.
     * On does not attach to a battle that was prepared while the meter was off.
     * @param {boolean} on
     */
    setCombatMetrics,
    /**
     * Local-only damage/healing accounting (battle/metrics.js) for the 作战统计 panel: the own current battle
     * (`battle`) or every battle simulated so far in this match (`match`), each restricted to `ownerId` when given.
     * Read on demand by the panel — never sent to the server.
     * @param {{ scope?: 'battle'|'match', ownerId?: string|null }} [opts]
     */
    combatMetrics({ scope = 'match', ownerId = null } = {}) {
      const localEntries = [...entries.values(), ...pending.values()];
      if (scope === 'battle') {
        // scouting another field must not replace the player's own current battle statistics
        const e = ownerId == null ? cur : localEntries.filter((entry) => entry.members.includes(ownerId))
          .sort((a, b) => b.seq - a.seq)[0];
        return combineCombat(e?.combatMetrics ? [e.combatMetrics()] : [], ownerId);
      }
      const records = new Map(combatHistory);
      for (const e of localEntries) if (e.combatMetrics) {
        const record = e.combatMetrics();
        if (!(records.get(e.battleId)?.seconds > record.seconds)) records.set(e.battleId, record);
      }
      return combineCombat(records.values(), ownerId);
    },
    /**
     * **本地播放倍速**（玩家按的 ×1/×2/×3/×4）。
     *
     * 它只改「墙钟时间怎么映射到 tick」（`targetTick` 乘上它），**不改 tick 序列** —— 同一场战斗无论按到几倍，
     * 跑过的 tick 与每一步判定完全相同，只是跑得快慢不同。所以它**不会**影响战果，也**不需要**服务端参与：
     * 服务端在 `b.start` 里给的 `speed` 是对局的节奏，这个 `rate` 是这台机器看得多快，两者相乘。
     *
     * 接受的值被夹在 `RATE_MIN..RATE_MAX`，取整到一位小数；非法值（0 / NaN / 负数）当作 1，**不抛**。
     * 改变它不会重放已过的帧 —— 下一帧起按新速率推进（这正是「加快播放」的语义）。
     * @param {number} next
     * @returns {number} 实际生效的倍速
     */
    setRate(next) {
      const n = Number(next);
      rate = Number.isFinite(n) && n > 0 ? Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n * 10) / 10)) : 1;
      // 广播出去：顶栏的那个按钮要显示当前倍速（它就是唯一的读者）
      emit('rate', rate);
      return rate;
    },
    /** 当前本地播放倍速（默认 1 = 完全按服务端给的 speed 走，与从前逐字相同）。 */
    rate: () => rate,
    /**
     * The battle on screen as a report attaches it (diag.js): its b.start fields and its game time; null without one.
     * @returns {{ battleId: string, fieldId: string, kind: string, spec: object, time: number|null }|null}
     */
    currentBattle() {
      const e = cur;
      if (!e || !e.spec) return null;
      const time = e.battle && Number.isFinite(e.battle.time) ? e.battle.time : null;
      return { battleId: e.battleId, fieldId: e.fieldId, kind: e.kind, spec: e.spec, time };
    },
    stats() {
      return { ...stats, avgTickMs: stats.ticks ? stats.stepMs / stats.ticks : 0, entries: entries.size, loadingSim: sims.size > 0 };
    },
    /**
     * Live stats of unit `unitId` of the battle on screen (null: no such battle / unit, or `fieldId` names another
     * field). Reads the sim's last computed stats (`unit._s`, falling back to the base) — never `unit.s`, whose lazy
     * recompute would run earlier than the sim itself would run it.
     * @param {number} unitId @param {string|null} [fieldId]
     */
    unitStats(unitId, fieldId = null) {
      const e = cur;
      if (!e || !Number.isInteger(unitId) || (fieldId != null && e.fieldId !== fieldId)) return null;
      // 读数由宿主给：`simHost.js:44-47` 的 InPageSimHost.unitStats 就是原来那份 unitStatsEntry(u, u._s || null) 逐字
      // 搬过去的（能力没丢、只是换了位置），Worker 宿主的同一读数走 RPC 缓存。`e.host` 在 prepare() 里必被赋值
      // （注入面 / Worker / 本页三种之一，每种都有 unitStats），所以这里没有第二条回退路。
      try { return e.host.unitStats(unitId); } catch { return null; }
    },
    /**
     * **逐单位伤害读数**（DESIGN §28.38）：本场战斗里每个单位的累计伤害与每个人自己的累计伤害，连同一个**时间
     * 基准**（`gt`，战斗内秒）—— 面板据此自己算 DPS。
     *
     * **它不在热路径上，也不需要累计一份自己的账**：伤害早在模拟里算好了 —— `server/sim/damage.js:424` 每次命中写
     * `source.stats.dmg += dealt`，`:371` 写 `battle._pp(ownerId).damageDealt`，`:352` 写 `bossDamage`（`units.js:97`
     * 初始化 `stats = { dmg, kills, heal, taken, attacks }`）。这个读者只是**把已经在那儿的数字取出来**，所以
     * `step()` / `drainEvents()` / `emit` 一个字都不改，并且**绝不**维护第二份累计 —— 两份口径对不上正是
     * 「面板可以画错、但不能算错」要消灭的东西。
     *
     * 形状：`{ battleId, fieldId, kind, authoritative, own, gt, t0, players: [{ playerId, dmg, bossDmg, kills, heal }],
     * units: [{ id, uid, defId, ownerId, kind, dmg, kills, heal }] }`（一次读一份新的、冻结的副本）。
     * `dmg` / `bossDmg` / `kills` / `heal` **取整**，与 `shared/protocol.js` `compactResult`（结果页读的那一份）
     * 同一个口径 —— DPS 是速率显示，给未取整的浮点只会装作更精确。`gt` 是 `battle.time`（战斗内秒），`t0` 恒为 0
     * （一局一场），所以 `dps = dmg / (gt - t0)`。
     *
     * **只给本场**：读的就是屏上这一场（与 `unitStats()` 同一语义），**不含**队友那几场、也不含正在准备的下一场；
     * `uid` 是这块棋在那个玩家棋盘上的 id（与 `unitIdOf()` / `unitsEnd` 同一个号，面板对名单要用它）。`players[]`
     * 只列**这一场真在场的玩家**（`battle.players`），不是 `b.start` 的座位表。
     *
     * 拿不到就是 `null`（没有正在跑的战斗、战斗还没建好）—— **不抛、不编造**。注入面那一层（`ctx.battle.damage()`）
     * 把这个 `null` 与「门面自己没接上」的几种原因分开记一行日志。
     * @returns {{ battleId: string, fieldId: string|null, kind: string, authoritative: boolean, own: boolean,
     *   gt: number, t0: number, players: ReadonlyArray<object>, units: ReadonlyArray<object> }|null}
     */
    damage() {
      const e = cur;
      const b = e && e.battle;
      if (!b) return null;
      const units = [];
      // 己方单位（**场上**的：操作员、召唤物、装置 —— 装置也算，它打的伤害一样进它拥有者那本账，所以面板拿
      // `uid` 对名单时，对不上号的几行可以按 `kind` 自己归并）
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        const s = u && u.stats;
        if (!s) continue;
        units.push({
          id: Number.isInteger(u.id) ? u.id : null,
          uid: Number.isInteger(u.uid) ? u.uid : null,
          defId: typeof u.defId === 'string' ? u.defId : null,
          ownerId: typeof u.ownerId === 'string' ? u.ownerId : null,
          kind: typeof u.kind === 'string' ? u.kind : null,
          dmg: Math.round(Number(s.dmg) || 0),
          kills: Math.trunc(Number(s.kills) || 0),
          heal: Math.round(Number(s.heal) || 0),
        });
      }
      const players = [];
      // **照 `Battle._buildResult()` 的配对写法**（`server/sim/battle/lifecycle.js:218-219`）：座位对象是
      // `battle.players[]`，而每人那本伤害账在 `battle._perPlayer[playerId]` —— **不是同一个对象**。写错一边
      // （例如去读 `getPlayer(pid).damageDealt`）会永远读到 0，而单位那几行照样有数字：正是「面板可以画错、
      // 但不能算错」要消灭的那种静默错误。
      for (const ps of Array.isArray(b.players) ? b.players : []) {
        const pid = ps && ps.playerId;
        if (typeof pid !== 'string') continue;
        const pp = typeof b._pp === 'function' ? b._pp(pid) : null;
        if (!pp) continue;
        players.push({
          playerId: pid,
          dmg: Math.round(Number(pp.damageDealt) || 0),
          bossDmg: Math.round(Number(pp.bossDamage) || 0),
          // 这个玩家的计入击破数（`_pp` 那本账里的 `killed`；结果页的 `kills` 同源）
          kills: Math.trunc(Number(pp.killed) || 0),
          heal: Math.round(Number(pp.healingDone) || 0),
        });
      }
      return {
        battleId: e.battleId,
        fieldId: e.fieldId ?? null,
        kind: e.kind,
        authoritative: !!e.authoritative,
        own: !!e.own,
        gt: Number.isFinite(Number(b.time)) ? Number(b.time) : 0,
        t0: 0,
        players,
        units,
      };
    },
    /**
     * The unit id of the board piece `uid` owned by `ownerId` in the battle on screen (an own operator's card opened in
     * prep and left open into the battle turns live); null when that battle has no such unit.
     * @param {number} uid @param {string} ownerId @param {string|null} [fieldId]
     */
    unitIdOf(uid, ownerId, fieldId = null) {
      const e = cur;
      if (!e || !Number.isInteger(uid) || (fieldId != null && e.fieldId !== fieldId)) return null;
      const list = Array.isArray(e.battle.allyUnits) ? e.battle.allyUnits : [];
      const u = list.find((x) => x && x.uid === uid && x.ownerId === ownerId);
      return u && Number.isInteger(u.id) ? u.id : null;
    },
    /**
     * The operators `ownerId` fields in the battle on screen — their board in that battle, waiting to deploy, deployed
     * or knocked out (the field meta published by show() is taken before they deploy) — as UnitInfo-like
     * { kind: 'op', ownerId, defId }: a teammate's bond popup lists them as the members in play (ui/watchBonds.js
     * ownerBoard). [] when no such battle is on screen.
     * @param {string} ownerId @param {string|null} [fieldId]
     */
    ownerOps(ownerId, fieldId = null) {
      const e = cur;
      if (!e || typeof ownerId !== 'string' || !ownerId || (fieldId != null && e.fieldId !== fieldId)) return [];
      return e.host.ownerOps(ownerId);
    },
    /** Re-show the current battle (the game screen remounted). */
    reshow() { if (cur) show(cur); },
    /** Test / debug hooks. */
    _entries: entries,
    _frame: frame,
    _pump: pump,
    onStart, onPool, onEnd, clear, ensureSim, redeliver, setPaused,
    dispose() { clear(); for (const off of offs) { try { off?.(); } catch { /* ignore */ } } },
  };
}

/**
 * W-D 的那个判据（DESIGN §28.16）：这一局要在哪个数据面上模拟 —— 房间声明了自己的集合就跑它自己那一份
 * （`/room-data/<摘要>/`），否则是进程那一份（`/data/`）。`currentModSet()` 是 `welcome` 给的进程集合，
 * 所以没声明集合的房间与干净安装都落在 `/data/`：加载器与从前逐字节相同。
 * @param {any} spec the BattleSpec of the b.start
 * @returns {string}
 */
function dataBaseForBattle(spec) {
  return roomDataBase(spec && spec.mods, currentModSet());
}

/** The browser runner, wired to the app's socket and store (null outside a browser). */
export const battleRunner = typeof window !== 'undefined' && typeof document !== 'undefined'
  ? createBattleRunner({ net: appNet, store: appStore, dataBaseFor: dataBaseForBattle })
  : null;
if (battleRunner) globalThis.__SP_RUNNER__ = battleRunner; // dev / E2E introspection
if (battleRunner) setBattleSource(() => battleRunner.currentBattle());
