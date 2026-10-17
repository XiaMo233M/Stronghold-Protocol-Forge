// Shared enums & constants (server + browser). Pure ESM, no Node APIs.

import { N_ } from './i18n.js';

/**
 * The **wire format** number, and the stale-page gate. A `hello` declares it (`public/js/net.js _sendHello`), the server
 * refuses a mismatch outright — `BAD_MSG` with `version mismatch: server <n>` (server/net.js onHelloMsg, the FIRST check
 * of the handshake) — and the browser turns that refusal into 「客户端版本与服务器不一致，请刷新页面」 (NetError, the
 * `version` detail). So a tab left open across a deployment never reaches a room: it gets tell-refresh instead of
 * decoding frames whose meaning changed under it (DESIGN §8.2.1).
 *
 * Bump it whenever the SHAPE of a pushed frame changes in a way an older page would read WRONG (not merely stale):
 * 2 = `m.public` incremental frames (a delta frame is only understood by a client that merges it — an older page would
 * read its `players` list as the whole roster). Additive fields an older page simply ignores do not need a bump.
 */
export const PROTOCOL_VERSION = 2;
/**
 * The **mod-layer API** version (DESIGN §28.5, §28.13): the version of the hook bus and the kit contract a workshop pack
 * may write against. A pack declares `pack.json.api` as a RANGE and this number is what that range is compared against
 * (`shared/workshop.js normalizePackManifest`), so a pack written for a different bus is refused instead of being run
 * unverified. It is a whole number, like `PROTOCOL_VERSION`: the bus changes shape, it does not drift by patch.
 * Bumping it is an owner decision — it stops every pack whose range excludes the new number from loading.
 *
 * NOT `APP_VERSION` (the release half above): the release number moves for reasons a pack's compat does not care about,
 * and `docs/design/mod-layer.md` §28.5 spells out the two ranges separately. The comparison needs a three-part version
 * (`shared/packs.js appVersionMatches` reads `v<major>.<minor>.<patch>` and **treats an unparsable one as a match** —
 * a fallback that would silently accept every pack), so `shared/workshop.js` builds the string from this number rather
 * than duplicating it here.
 */
export const MOD_API_VERSION = 1;
/** Release version shown to players (title screen, server banner, /healthz). Kept equal to package.json "version"
 * (test/version.test.js); PROTOCOL_VERSION above is the separate wire-format number. The release TAG spells both halves
 * out — `v<this>-<upstream>` (README 「版本号」) — because this one has to stay a plain three-part semver. */
export const APP_VERSION = '0.19.1';
/**
 * The UPSTREAM game version this checkout bundles (README 「版本号」). The release TAG spells both halves out —
 * `v<APP_VERSION>-<UPSTREAM_VERSION>` — because `APP_VERSION` itself has to stay a plain three-part semver.
 *
 * This is the ONE copy of the upstream half, and it exists because a release is identified by its TAG, not by
 * `APP_VERSION`: a release that only follows upstream keeps `APP_VERSION` and moves this number
 * (0.13.1 → 0.14.0 was the other way round: both halves moved). `scripts/make-windows-bundle.mjs` writes the pair
 * into `app/package.json` as `release`, so the identity travels INSIDE the artifact — that is what lets
 * `scripts/make-update-package.mjs` tell "the next release" from "the very release I am building"
 * (a bundle that only names `0.14.0` cannot: 0.14.0-0.2.3 and 0.14.0-0.2.4 look identical to it).
 */
export const UPSTREAM_VERSION = '0.3.0';
/**
 * The version a **plugin** manifest's `app` range is judged against — the **upstream half**, NOT `APP_VERSION`.
 *
 * The two numbers answer two different questions, and the plugin system's `app` field asks the upstream one: a plugin's
 * `app` says which **game** it was written for (every template under `plugins/_template/` — and every manifest upstream
 * 0.3.0 ships — declares `>=0.3.0 <0.4.0`), while this fork's `APP_VERSION` is **this fork's release number**. Judging a
 * release number against a game-version range is a category error: `0.18.6 ∉ [0.3.0, 0.4.0)` refused **every** upstream
 * plugin as `PLUGIN_INCOMPATIBLE`. The plugin **API** level is a separate field (`api`; `PLUGIN_API` below) and keeps its
 * own gate, so nothing about "this fork's API diverges from upstream" stops being checked.
 *
 * **One source.** `shared/plugins/manifest.js appVersionMatches`'s default parameter, and every reader of a plugin or
 * plugin-system pack manifest (`shared/plugins/manifest.js`, `shared/plugins/catalog.js`, `server/plugins/registry.js`,
 * `server/studio/templates/index.js appRangeNow`), take the app version from here.
 *
 * **What deliberately does NOT read it.**
 *   * `server/plugins/identity.js computeVanillaContent` / `shared/plugins/identity.js`: the content-set `cs` hashes
 *     `app` as an **identity** input (which bytes this content is), not as a compat gate — it stays on `APP_VERSION`
 *     (`test/plugins/identity.test.js` pins that), so no content hash and no golden result moves.
 *   * `shared/packs.js` / `shared/workshop.js`: this fork's **own** mod-pack layer. Those packs target this fork, so they
 *     keep `APP_VERSION`. (`shared/packs.js` re-exports `appVersionMatches`; its callers pass the version explicitly.)
 *   * `tools/i18n.mjs appRange` (the i18n skeleton generator): pinned to `APP_VERSION` by `test/i18n-packs.test.js`. The
 *     language packs it writes declare `>=0.2.0`, which both halves satisfy, and `lang` manifests take an `app` mismatch
 *     as a warning (`PLUGIN_APP_MISMATCH`), never a refusal.
 *   * `server/studio/index.js` (the studio `info` payload's `app`): "which build is this server" — an identity, not a
 *     compat gate; `test/playtestEditor.test.js` pins it. The studio's **template generator** (`appRangeNow`, what a new
 *     plugin declares) reads `PLUGIN_APP_VERSION` instead, so the studio never scaffolds a plugin this loader refuses.
 */
export const PLUGIN_APP_VERSION = UPSTREAM_VERSION;
/** A development build (the public `dev` branch): the title screen, the boot banner and the README say so, and
 * tools/package.mjs refuses to build a release zip from it without --allow-dev. */
export const DEV_BUILD = /-dev$/.test(APP_VERSION);
/**
 * The plugin API levels this build supports (DESIGN **§34** — 上游原文写的是它自己的 `§32`，按内容判据改写成我们的段号；
 * 见 `docs/DESIGN.md` 的索引表，上游 §N ↔ 我们 §(N+2)：`shared/plugins/manifest.js`): a manifest 2 states the level it
 * is written for (`api`); a level outside min…current keeps the plugin out. The level rises when the data shapes, the
 * DSL vocabulary or the SDK a plugin relies on change incompatibly (CHANGELOG says how to migrate). [ASSUMED]
 */
export const PLUGIN_API = Object.freeze({ current: 1, min: 1 });

/**
 * The voice slots a pack may ship lines for (角色语音台词) — the ONE copy of this vocabulary: the workshop validator
 * (`shared/workshop.js`, which only accepts these in a pack's `voices`), the editor's voice page and the CLI all read it
 * from here, so a typo cannot silently produce a line that never plays.
 *
 * The list follows the UPSTREAM 0.2.0 client: `public/js/audio.js` (VOICE_PRIORITY) plays
 * `audio.voice[charId][slot]`, and `tools/assets/audio.mjs` (VOICE_BATTLE_SLOTS) plans exactly these 12 — the slots a
 * running battle can request. The three prep-only UI slots (gacha / squad / squadFirst) are deliberately absent: no
 * battle asks for them, so a pack file filed under one would never be heard.
 */
export const VOICE_SLOTS = Object.freeze(['start', 'faceEnemy', 'select', 'place',
  'skill1', 'skill2', 'skill3', 'skill4', 'resultFour', 'resultThree', 'resultTwo', 'resultLose']);

/**
 * 配音语言 (v0.7.1, owner's request 「不同干员可以切换不同的配音语言」): the dubs the official voice dump ships, in the order
 * the UI shows them. The manifest's `audio.voice` holds the default dub and `audio.voiceLangs[lang]` the others
 * (`tools/assets/plan.mjs`); a player picks one for the whole game in 设置 → 干员语音, and any operator may override it
 * (`settings.voiceLangByChar`, 干员详情 → 配音).
 *
 * `jp` is the default **since 0.9.0** (owner's release decision): the downloadable bundle ships the Japanese dub, so a
 * fresh install hears Japanese out of the box, and the other three (cn / en / kr) come from the same release's voice
 * pack. This constant is the ONE place that decides what "the default dub" means, so it has to agree with
 * `data/assets.json`'s `audio.voiceLang` — a manifest naming another dub would leave the editor's 语音 page showing two
 * tabs for the same table, and `shared/workshop.js` would reject a pack that files Chinese lines under `voiceLangs.cn`.
 * Consequence for pack authors: a pack's `voices` table is the DEFAULT dub (now jp); other dubs go in `voiceLangs[lang]`.
 */
export const VOICE_LANGS = Object.freeze(['cn', 'jp', 'en', 'kr']);
export const DEFAULT_VOICE_LANG = 'jp';
/** Language names in their own language — never translated (that is how a language picker is read). */
export const VOICE_LANG_NAMES = Object.freeze({ cn: '中文', jp: '日本語', en: 'English', kr: '한국어' }); // i18n-ignore: 语言名按母语写法显示

export const MAX_SEATS = 4;
/**
 * 这台服务器**缺省**允许多少座 (业主裁令 2026-10-12：「你改成默认 20 吧，上限可加并给出文档」)。 **它不是
 * `MAX_SEATS`**：那个 4 是「官方房间 1–4 人」的声明，也是超容变体的闸门口径（见 `server/match/Match.js` 的
 * `variant`），所以它一个字不动 —— 移动的只是「缺省上限」。
 *
 * 座位上限的可配置覆盖 (100 人版移植, docs/PS100-MIGRATION.md)。缺省 **20** 座：一台没设任何环境变量的服务器
 * 允许房主开到 20 座；要更多座不必改 `shared/`：`SP_MAX_SEATS=100 npm start`。抬了席位**不会**自动抬别的上限，
 * 同抬的清单见 docs/NET-TUNING.md §2（`maxConnectionsPerAddr`——它是 `startServer` 选项、不是环境变量；lobby 的
 * `maxRoomsPerAddr` / `maxMatchesPerAddr`；`bossHpScale.aliveFull`；隐秘核心阈值）。注：注释里曾出现过
 * `SP_MAX_CONNS_PER_ADDR`，**代码里并不存在那个环境变量**，别照它去设。
 *
 * `SP_MAX_SEATS=4` 是**回到官方那一档**的口径：那时 `room.state` 与协议帧与「缺省 4 座」的旧部署**逐字节相同**
 * （`welcome.maxSeats` 仍会发、值为 4；`room.state.seatCap` 只在容量 ≠ 4 时才出现）。
 *
 * This file is loaded by the BROWSER too and sits inside the `npm run typecheck` slice (`jsconfig.json` includes
 * `shared/**`, with no node types), so it never touches `process`: the parser is PURE and its callers hand the
 * environment in — `server/lobby.js` (`process.env`) and `shared/protocol.js` (the SEAT_CAP gate). Absent /
 * unparsable ⇒ `DEFAULT_MAX_SEATS`, i.e. a deployment that says nothing gets a 20-seat ceiling.
 *
 * @param {Record<string, string|undefined>|null|undefined} env the environment to read (absent ⇒ the default)
 * @returns {number} the effective seat cap (an integer ≥ 1)
 */
export const DEFAULT_MAX_SEATS = 20;
export function maxSeatsFrom(env) {
  const raw = env ? env.SP_MAX_SEATS : undefined;
  if (raw == null || String(raw).trim() === '') return DEFAULT_MAX_SEATS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SEATS;
  const i = Math.floor(n);
  return i >= 1 ? i : DEFAULT_MAX_SEATS;
}

/**
 * 本房座位数的**下限** (业主裁决 B5, 2026-10-11): the fewest seats a co-op room may be created with.
 *
 * 依据 (why 2 and not 1): the official room's player range is 1–4 (`MAX_SEATS` above), and the ONE-seat shape
 * already has its own mode — `mode: 'solo'` is 独立模拟, exactly one human, never bots, and the client renders it
 * as one card whatever the server's slot count is (public/js/screens/room.js `normalizeSeats`). A co-op room whose
 * `seatCap` were 1 would be a second way to spell that, with none of the solo mode's rules behind it (a solo room
 * refuses `room.addBot` and any second `room.join`), so the floor keeps 「coop ⇒ ≥ 2 seats」 true — the invariant
 * every existing co-op room satisfies (a room created without a pick gets the server's ceiling: 20 by default).
 *
 * It is a lower bound on the REQUEST, not a new ceiling on a room: `Room(code, 'coop', diff, now, 1)` still builds
 * (the class takes any `seatCap ≥ 1`), and a deployment whose `SP_MAX_SEATS` is below this value can still create
 * its rooms — `clampSeats` narrows the floor to the ceiling instead of leaving an empty range.
 */
export const MIN_SEATS = 2;

/**
 * 一局里一名玩家能同时站在场上的干员数上限（部署位）—— **一个数只许一个真相**。
 *
 * 它从前是**两处**硬编码的 `12`，本刀把它收到这里：
 *   * `server/match/effectsMeta.js` 的 `setDeployCapAtLeast`：销毁类装备 / 分队加成把部署位**至少**抬到这么多
 *     （本模式最多 12 个部署位），所以那个 `Math.min(v, 12)` 不是「随手挑的上限」，就是这一条；
 *   * `shared/variants.js` 的 `deploy: "max"` 口径（投稿 e4fe4d5cf0a0 要的「12 部署位」）把它写进
 *     `config.economy.deployCap`。
 *
 * **它不是官方值**：官方 `maxBattleChessCnt` 是 8（`data/config.json economy.deployCap` 由
 * `tools/build-data.mjs` 从 `act.constData.maxBattleChessCnt` 写出），8→12 这一段是这台服务器自己的天花板。
 * 所以缺省路径仍然逐字节是 `data/` 里那个 8，这个常量只在口径被**显式**打开时出现。
 */
export const DEPLOY_CAP_MAX = 12;

/**
 * 房主选的本房上限 → 这台服务器真正接受的座位数 (业主裁决 B5)。**纯函数**, `shared/` 的纪律同 `maxSeatsFrom`:
 * no `process`, no state, so the server and the browser clamp a pick the same way.
 *
 * `want` is what a host picked (or a caller passed); `max` is this deployment's ceiling
 * (`LOBBY_DEFAULTS.maxSeats` = `maxSeatsFrom(env)` server-side). The result is always an integer in
 * `[min(MIN_SEATS, max), max]`:
 *   * a usable integer inside the range ⇒ itself (a pick of exactly `max` is the DEFAULT, i.e. 「本房不另设上限」);
 *   * below the floor ⇒ the floor;
 *   * above the ceiling ⇒ the ceiling;
 *   * unusable (absent, a fraction, a string, `NaN`, `Infinity`) ⇒ `max`, the same room the server builds when the
 *     field is not sent at all — so a caller that bypasses `shared/protocol.js` can never widen a room by accident.
 *
 * This is the LAST line, never the first: `room.create.seatCap` is judged on the wire by `shared/protocol.js`
 * (a value outside `[MIN_SEATS, SEAT_CAP]` is a `BAD_MSG`, not a silent clamp), and this function covers the callers
 * that never see the protocol — `server/matchmaking.js` (a quick-matched room has no host to ask) and packages.
 *
 * @param {unknown} want the requested seat count
 * @param {number} [max] this server's ceiling. The default is the OFFICIAL 4, not the server's 缺省上限: every
 *   production caller passes `LOBBY_DEFAULTS.maxSeats` (= `maxSeatsFrom(env)`, 20 by default) explicitly, and an
 *   absent/unusable ceiling must not invent a 20-seat room for a caller that forgot to ask.
 * @returns {number} an integer in `[min(MIN_SEATS, max), max]`
 */
export function clampSeats(want, max = MAX_SEATS) {
  const hi = Number.isInteger(max) && max >= 1 ? max : MAX_SEATS;
  const lo = Math.min(MIN_SEATS, hi);
  if (!Number.isInteger(want)) return hi;
  const n = /** @type {number} */ (want);
  return Math.min(Math.max(n, lo), hi);
}
/**
 * Spectator seats of a co-op room (community report #26, owner's decision 2026-10-04) — a remake feature: the official
 * room has 1–4 players and no spectator seat (there only eliminated players and 联防 bystanders watch, research 09 §3.1).
 * A spectator never counts as a player, may not act, and watches like an eliminated player (server/lobby.js spectate,
 * server/match/match/watch.js addSpectator).
 */
export const MAX_SPECTATORS = 2;
export const ROOM_CODE_LEN = 4;
export const NAME_MAX_LEN = 12;
/**
 * How many workshop packs one room may declare (DESIGN §28.9, W-A). A room picks a SUBSET of the packs the server
 * already loaded, so the ceiling is the catalogue's own (`shared/modIdentity.js MOD_LIMITS.packs` = 64); a room that
 * declares more than this is refused as a malformed message rather than silently truncated.
 */
export const MAX_ROOM_MODS = 64;

export const DIFFICULTIES = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
export const DIFFICULTY_NAMES = { FUNNY: N_('标准模拟'), NORMAL: N_('险境模拟'), HARD: N_('绝境模拟'), ABYSS: N_('终极模拟') };
export const DIFFICULTY_COLORS = { FUNNY: '#f6a329', NORMAL: '#e85a1a', HARD: '#e73118', ABYSS: '#ff0024' };

// modeId in data/config.json = `mode_${type}_${difficulty.toLowerCase()}` with type single|multi
export const modeIdFor = (roomMode, difficulty) =>
  `mode_${roomMode === 'solo' ? 'single' : 'multi'}_${difficulty.toLowerCase()}`;

export const PHASE = Object.freeze({
  LOBBY: 'LOBBY',
  INFO_CHECK: 'INFO_CHECK',
  BAND_DRAFT: 'BAND_DRAFT',
  BATTLE_CHECK: 'BATTLE_CHECK',
  ROUND_START: 'ROUND_START',
  SP_DRAFT: 'SP_DRAFT',
  PREP: 'PREP',
  COMBAT: 'COMBAT',
  UNITE: 'UNITE',
  SETTLE: 'SETTLE',
  FINAL_ASSAULT: 'FINAL_ASSAULT',
  HIDDEN_CORE: 'HIDDEN_CORE',
  RESULT: 'RESULT',
});

export const PHASE_NAMES = {
  LOBBY: N_('等待中'), INFO_CHECK: N_('确认本局信息'), BAND_DRAFT: N_('选择策略'), BATTLE_CHECK: N_('协议启动'),
  ROUND_START: N_('回合开始'), SP_DRAFT: N_('机变阶段'), PREP: N_('休整期'), COMBAT: N_('作战中'), UNITE: N_('联防阶段'),
  SETTLE: N_('结算'), FINAL_ASSAULT: N_('最终攻势'), HIDDEN_CORE: N_('隐秘核心'), RESULT: N_('模拟结束'),
};

// Board geometry on the **official** 19x21 stage grid (row 0 = bottom). See DESIGN §3 and shared/layout.js.
//
// ROWS/COLS are the official map size, and the unit every *semantic* measurement uses: board coordinates (FIELD, the
// hand / temp rows), the protocol's range checks, an attack range's horizontal reach. A **big map**
// (shared/layout.js, the owner's 2026-10-08 request) is a bigger window inside the engine canvas —
// CANVAS_ROWS×CANVAS_COLS, which is the sim's stride (server/sim/constants.js) — so the three rects below are the
// OFFICIAL layout's numbers: the default and the fallback, read per map through `layoutOf(stage)`.
export const GEO = Object.freeze({
  ROWS: 19, COLS: 21,
  CANVAS_ROWS: 27, CANVAS_COLS: 33,
  FIELD: { r0: 9, r1: 12, c0: 2, c1: 10 },        // own deployable board region (board coordinates)
  NORMAL_RECT: { r0: 9, r1: 12, c0: 0, c1: 10 },  // simulation rect of a normal battle (official layout)
  UNITE_RECT: { r0: 9, r1: 12, c0: 0, c1: 20 },
  BOSS_RECT: { r0: 0, r1: 5, c0: 0, c1: 20 },
  HAND_ROW: 7, HAND_SIZE: 10,                      // hand slot idx = col 0..9
  TEMP_ROW: 8, TEMP_C0: 4, TEMP_SIZE: 5,           // temp slot idx 0..4 = cols 4..8
  PARTNER_COL_OFFSET: 8,
});

export const AREA = Object.freeze({ BOARD: 'board', HAND: 'hand', TEMP: 'temp', OUTSIDE: 'outside' });

export const PIECE_KIND = Object.freeze({ CHESS: 'chess', ITEM: 'item', TOKEN: 'token' });

/**
 * Whether the placed piece of a skill's summon (赫默's 医疗探机, 巫恋's 诅咒娃娃) also deploys once, for free, at the
 * battle start. true = the PRTS reading (卫戍协议/帮助 §作战阶段: "所有手动部署的召唤物，无视所属干员的持有状态…作战开始时
 * 立即部署一次", example 赫默's drone), settled by the user on 2026-10-01 after playtest #6 (DESIGN §20); false = the
 * playtest #4 reading ("是赫默开技能释放一次，不是开局直接就部署了"): it takes its tile only when the owner's skill gives one.
 * Either way the piece re-appears on its tile each time the owner's skill gives one.
 * One switch for everything that depends on it: the sim (server/sim/content/tokens.js dockSkillSummons) and the summon
 * card's hint (public/js/ui/detailPanel.js summonDeployHint). docs/PLAYING.md §4 and docs/SIM.md (token pieces) state
 * the rule in prose — test/ui/playtest6_summons.test.js fails until they match the value.
 */
export const SKILL_SUMMON_START_DEPLOY = true;

/**
 * Official per-bond layer cap (docs/research/11-limits-official.md §1): the client's
 * `Torappu.Battle.AutoChessBattleConst.MAX_GARRISON_STACK = 999`, and its bond counter (`AddBondCount`) stores
 * `min(L + n, 999)` — each bond stops at 999 on its own; the community reports bonds sitting at 999 while fed (巴哈姆特
 * 12534 "每把都能999层", 12316 "999謝"; research 02 §layers). The only implementation of the cap (DESIGN §20.12). Every
 * writer of a bond's layers goes through `layerGainRoom`: the prep-side gains (server/match/player/economy.js addLayers —
 * 特质, items, bands, 机变 cards, bonds), the settle of the in-battle gains (server/match/match/settle.js) and the live in-battle
 * copy (server/sim/battle/economy.js addLayers, as the client's AddBondCount) — and the dev tools' direct writes (tools/matchrun.mjs
 * --layers, tools/balance.mjs applyBoard); a gain at the cap adds 0 (no onLayers, no 'layer'
 * event), and the client-result check (server/match/fields.js) bounds a reported gain by the room left. Milestones paid
 * per N layers (远见, 奇迹, 维多利亚 …) stop with the count. 0 / Infinity = no cap.
 */
export const BOND_LAYER_CAP = 999;

/**
 * The layers a gain of `n` actually adds to a bond holding `before` under BOND_LAYER_CAP: min(n, cap − before), never
 * negative (a count already at or over the cap gains 0 and is never lowered); 0 for a non-positive / non-finite `n`
 * except +Infinity (= "the room left").
 */
export function layerGainRoom(before, n) {
  if (!(n > 0)) return 0;
  const cap = BOND_LAYER_CAP > 0 ? BOND_LAYER_CAP : Infinity;
  const b = Number.isFinite(before) && before > 0 ? before : 0;
  return Math.max(0, Math.min(n, cap - b));
}

/**
 * Official boss-hit limit "限伤" (docs/research/11-limits-official.md §2): `AutoChessBattleConst.MAX_BATTLE_DAMAGE =
 * 300000`. In a boss battle outside training — our battle kinds 'boss' (Final Assault) and 'hidden' (Hidden Core) — a
 * single hit on a leader (`AutoChessBattleUtil.IsBossEnemy`: an enemyId of activity_table autoChessData.bossInfoDict
 * = data/bosses.json `enemyKey`; in the sim the tag-'boss' units: those leaders and their mirrored copies, never parts,
 * escorts or drones) whose `ceil(final damage)` ≥ this is CANCELLED: 0 damage, nothing credited to the shared pool
 * (`AutoChessStepModeManager._OnBossEnemyTakeDamage` → `modifier.Cancel()`). It is not a clamp: a hit of 299999 lands.
 * Checked in server/sim/damage.js (dealDamage after DEF / RES and every multiplier, before shields; Battle.loseHp — not
 * the 胄 drone link's pool share, `noHitLimit`, DESIGN §25.13.4). Minions, normal rounds and 联防 are unaffected.
 * 0 / Infinity = off.
 *
 * This is the DEFAULT. A deployment may override it per process with `SP_BOSS_HIT_LIMIT` (see bossHitLimitFrom); the
 * official 300000 is what every existing test and deployment keeps when the variable is absent.
 */
export const BOSS_HIT_LIMIT = 300000;
/**
 * 限伤 override (百卫补丁 v0.3 移植, docs/PS100-MIGRATION.md §5): the third-party 100-seat variant turns 限伤 OFF
 * (`BOSS_HIT_LIMIT = Infinity`). That is REMOVING A MECHANIC, not a self-contained port — `leaderHitCancelled` also
 * fires on damage MY SIDE takes (a loss passed on to a leader counts as one hit), so switching it off changes play at
 * every seat count. So the default stays the official 300000 and the change is opt-in, like `SP_MAX_SEATS`.
 *
 * Pure, like `maxSeatsFrom`: this file is loaded by the browser and sits in the `npm run typecheck` slice, so its
 * callers hand the environment in (server/match/Match.js reads `process.env`).
 *
 * `undefined` ⇒ use `BOSS_HIT_LIMIT` (the built-in default, i.e. byte-for-byte today's behaviour).
 * `0`, `off`, `infinity`, `inf` (any case) ⇒ `Infinity`, the documented "off" of the constant above.
 * A positive finite number ⇒ that many HP. Anything else (empty, junk, negative) ⇒ `undefined` (the default).
 *
 * @param {Record<string, string|undefined>|null|undefined} env the environment to read
 * @returns {number|undefined} the override, or undefined for "keep BOSS_HIT_LIMIT"
 */
export function bossHitLimitFrom(env) {
  const raw = env ? env.SP_BOSS_HIT_LIMIT : undefined;
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'off' || s === 'infinity' || s === 'inf') return Infinity;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (n === 0) return Infinity;                 // the constant's own "0 = off"
  return n > 0 ? n : undefined;                 // negative / junk → the built-in default
}

// Snapshot unit flag bits (DESIGN §8.2)
export const UF = Object.freeze({
  BLOCKED: 1, STUNNED: 2, FROZEN: 4, STEALTH: 8, SKILL: 16, SHIELD: 32, INVULN: 64, COLD: 128, SLEEP: 256, FLYING: 512,
});

export const ANIM = Object.freeze({ IDLE: 0, MOVE: 1, ATTACK: 2, SKILL: 3, DIE: 4, STUN: 5, DEPLOY: 6 });

export const ERR = Object.freeze({
  BAD_MSG: 'BAD_MSG',             // malformed / unknown message
  SESSION_IN_USE: 'SESSION_IN_USE', // a local recovery candidate cannot replace the connected holder
  RATE: 'RATE',                   // rate limited
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_STARTED: 'ROOM_STARTED',
  NOT_HOST: 'NOT_HOST',
  NOT_READY: 'NOT_READY',
  WRONG_PHASE: 'WRONG_PHASE',
  NO_FUNDS: 'NO_FUNDS',
  HAND_FULL: 'HAND_FULL',
  BOARD_FULL: 'BOARD_FULL',
  BAD_TILE: 'BAD_TILE',
  BAD_TARGET: 'BAD_TARGET',
  SOLD_OUT: 'SOLD_OUT',
  MAX_LEVEL: 'MAX_LEVEL',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ALREADY: 'ALREADY',
  TEMP_NOT_EMPTY: 'TEMP_NOT_EMPTY',
  ELIMINATED: 'ELIMINATED',
  SPECTATOR: 'SPECTATOR',         // a spectator seat only watches (MAX_SPECTATORS)
  // 房内聊天：这个房间的 `chatMode` 不允许这一类消息（`'quick'` 只许快捷短语，`'off'` 全禁）
  CHAT_MODE: 'CHAT_MODE',
  // 本房座位上限 (业主裁决 B5, docs/META.md §1.9): `room.setSeatCap` 想把上限缩到比**房间内现有人数
  // （真人 + AI）**还小 —— 那会有人被挤出座位，所以**点名拒绝**（不是静默钳到人数：那会让房主看到的数字
  // 与他按下去的不是同一个）。与 `BAD_MSG` 分开，是为了让「你给的数字根本不是合法座位数（越界 / 垃圾值）」
  // 与「数字合法、但这个房间现在装不下」这两件事在客户端可分辨 —— 前者改数字，后者先请人离开。
  SEAT_CAP_TOO_SMALL: 'SEAT_CAP_TOO_SMALL',
  MOD_UNKNOWN: 'MOD_UNKNOWN',     // room.create named a pack id this server does not have loaded (DESIGN §28.9, W-A)
  // 房间内改集合（G1/G2, docs/WORKSHOP.md §1.9.3）: `room.mods` 到得太晚 —— 对局已经开了，或者**已经有真人点了
  // 准备就绪**（那个人的客户端是按旧集合对齐的）。与 `NOT_READY` **分开**：`NOT_READY` 说的是「还有玩家没准备好，
  // 所以开不了局」，这里是「集合已经锁住了，改不了」—— 两句话在界面上正好相反，复用会让玩家读到与事实相反的理由。
  MOD_SET_LOCKED: 'MOD_SET_LOCKED',
  // 房间同意（W7, DESIGN §28.53）：进一个**声明了模组集合**的房间时，真人玩家必须明确同意才继续 ——
  // 未同意 ⇒ 进不去（`room.join`），已经进去了（集合中途改过）⇒ 开不了局（`room.start`）。与 `MOD_SET_LOCKED`
  // **分开**：那句是「集合锁住了、改不了」，这句是「你还没对**这一份**字节表过态」—— 前者要重开房间，后者只要点一下
  // 同意，在界面上正好是两件事。AI 座位与观战者不适用（见 `server/lobby.js` 的 `modConsentRefusal`）。
  MOD_CONSENT_REQUIRED: 'MOD_CONSENT_REQUIRED',
  // 野排匹配 (quick match, server/matchmaking.js): the queue already holds its limit of waiting players
  QUEUE_FULL: 'QUEUE_FULL',
  // 野排匹配: room.dequeue from a player who is not in the queue (nothing to cancel)
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  // 野排匹配: room.queue from a player who is already in a room — a quick match places people into rooms, it does not
  // pull them out of one (room.leave first)
  QUEUED: 'QUEUED',
  // 账号（`SP_ACCOUNTS=1`, server/accounts.js）: `hello.auth` 的四个失败。`AUTH_REQUIRED` 与 `BAD_CREDENTIALS`
  // 分开，是因为对客户端它们是两件事 —— 前者「你没带凭证，去登录或注册」，后者「凭证不对」。`NAME_TAKEN` /
  // `WEAK_PASSWORD` 是注册分支向用户解释「换个名字」与「换个口令」的唯一通道。
  AUTH_REQUIRED: 'AUTH_REQUIRED',     // hello 未带 auth，且本连接没有可复用的已认证会话
  BAD_CREDENTIALS: 'BAD_CREDENTIALS', // 账号不存在或口令不匹配（**故意不区分**：区分即账号枚举）
  NAME_TAKEN: 'NAME_TAKEN',           // 注册时该账号名已被占用（大小写不敏感）
  WEAK_PASSWORD: 'WEAK_PASSWORD',     // 口令不满足长度 / 字符集门槛
  // room.setPlugins (DESIGN **§34**，上游原文 `§32`；按内容判据改写 —— 插件架构那一节): a plugin this server has not
  // installed; one a room cannot switch on in this version (not a cosmetic or content plugin it loads, not of the room's
  // scope, or not allowed by the server owner's plugins/config.json); a requirement missing or out of range, or a
  // load-order cycle; two plugins in conflict; a set over the art size limit
  PLUGIN_SCRIPT_CONFLICT: 'PLUGIN_SCRIPT_CONFLICT',
  PLUGIN_SCRIPT_OVERRIDE: 'PLUGIN_SCRIPT_OVERRIDE',
  PLUGIN_SCRIPT_CHECK: 'PLUGIN_SCRIPT_CHECK',
  PLUGIN_SCRIPTS_DISABLED: 'PLUGIN_SCRIPTS_DISABLED',
  PLUGIN_TRUST_PIN: 'PLUGIN_TRUST_PIN',
  PLUGIN_TRUST_PUBLIC: 'PLUGIN_TRUST_PUBLIC',
  PLUGIN_CONSENT: 'PLUGIN_CONSENT',
  PLUGIN_UNKNOWN: 'PLUGIN_UNKNOWN',
  PLUGIN_BLOCKED: 'PLUGIN_BLOCKED',
  PLUGIN_DEPENDENCY: 'PLUGIN_DEPENDENCY',
  PLUGIN_CONFLICT: 'PLUGIN_CONFLICT',
  PLUGIN_LIMIT: 'PLUGIN_LIMIT',
  // P1c (DESIGN **§34.6**，上游原文 `§32.6`): a gameplay plugin made for other game versions or another plugin API
  // (refused unless the server owner allows it: plugins/config.json allowIncompatible); the server already runs as many
  // plugin content sets as its limit allows (plugins/config.json limits.maxSets); room.ready / room.start before every
  // player's page has loaded and checked the room's content (room.contentReady)
  PLUGIN_INCOMPATIBLE: 'PLUGIN_INCOMPATIBLE',
  PLUGIN_BUSY: 'PLUGIN_BUSY',
  CONTENT_NOT_READY: 'CONTENT_NOT_READY',
  INTERNAL: 'INTERNAL',
});

export const ERR_TEXT = {
  SESSION_IN_USE: N_('此对局仍在其他窗口中，或当前浏览器无法安全恢复。请关闭原窗口后重试。'),
  BAD_MSG: N_('无效的请求'), RATE: N_('操作过于频繁'), NOT_IN_ROOM: N_('你不在房间中'), ROOM_NOT_FOUND: N_('未找到该同盟密钥对应的房间'),
  ROOM_FULL: N_('房间已满'), ROOM_STARTED: N_('模拟已开始'), NOT_HOST: N_('只有房主可以操作'), NOT_READY: N_('仍有玩家未就绪'),
  WRONG_PHASE: N_('当前阶段无法进行该操作'), NO_FUNDS: N_('资金不足'), HAND_FULL: N_('整备区已满'), BOARD_FULL: N_('已达到部署上限'),
  BAD_TILE: N_('无法部署在该位置'), BAD_TARGET: N_('无效的目标'), SOLD_OUT: N_('已售出'), MAX_LEVEL: N_('调度中心已达最高等级'),
  NOT_YOUR_TURN: N_('尚未轮到你'), ALREADY: N_('已完成该操作'), TEMP_NOT_EMPTY: N_('临时整备区不为空'), ELIMINATED: N_('你已被淘汰'),
  SPECTATOR: N_('观战中无法进行该操作'), MOD_UNKNOWN: N_('房间指定了本服务器没有的模组包'), INTERNAL: N_('服务器内部错误'),
  MOD_SET_LOCKED: N_('本房间的模组集合已锁定（模拟已开始，或已有博士准备就绪），要改请重开房间'),
  MOD_CONSENT_REQUIRED: N_('本房间声明了模组：请先确认同意加载这些模组，再进入/开始'),
  CHAT_MODE: N_('该房间的聊天设置不允许这条消息'),
  SEAT_CAP_TOO_SMALL: N_('新的人数上限不能小于同盟内现有人数（含 AI 队友）'),
  QUEUE_FULL: N_('正在搜寻的博士已满，请稍后再试'), QUEUE_EMPTY: N_('你不在快速匹配队列中'), QUEUED: N_('你已在同盟中：先离开同盟，才能开始快速匹配'),
  AUTH_REQUIRED: N_('本服务器需要账号：请登录或注册'), BAD_CREDENTIALS: N_('账号名或口令不正确'),
  NAME_TAKEN: N_('该代号已被占用'), WEAK_PASSWORD: N_('口令至少 8 位，且不能含控制字符'),
  PLUGIN_UNKNOWN: N_('本服务器没有安装该插件'), PLUGIN_BLOCKED: N_('该插件不能在房间中启用'), PLUGIN_DEPENDENCY: N_('缺少该插件需要的其他插件'),
  PLUGIN_CONFLICT: N_('所选插件互相冲突'), PLUGIN_LIMIT: N_('所选插件的素材总量超出本服务器的上限'),
  PLUGIN_INCOMPATIBLE: N_('该插件不适配本服务器的游戏版本'), PLUGIN_BUSY: N_('本服务器同时运行的插件组合已达上限，请稍后再试'),
  PLUGIN_CONSENT: N_('还有玩家未同意运行受信任插件'),
  PLUGIN_SCRIPTS_DISABLED: N_('服主没有启用脚本插件'),
  PLUGIN_TRUST_PIN: N_('插件的锁文件或文件内容与服主钉住的哈希不符'),
  PLUGIN_TRUST_PUBLIC: N_('公网监听默认禁止受信任插件'),
  PLUGIN_SCRIPT_CONFLICT: N_('两个插件注册了同一个效果'),
  PLUGIN_SCRIPT_OVERRIDE: N_('插件未声明要替换的官方技能'),
  PLUGIN_SCRIPT_CHECK: N_('脚本未通过兼容性检查'),
  CONTENT_NOT_READY: N_('仍有博士未载入房间的插件内容'),
};

// ---- Emotes (交流, research 09 §4) -----------------------------------------------------------------------------
// The 36 official in-match emotes: display_meta_table emoticonData, scene AUTOCHESS_BATTLE, 6 themes × 6, one wheel
// page per theme in activity_table autoChessData.enabledEmoticonThemeIdList order, emotes by sortId. `g.emote { id }`
// / `m.emote { playerId, id }` carry the official emoji id. Generated reference: data/emotes.json
// (tools/build-emotes.mjs); test/ui/emotes.test.js keeps this table identical to it.
// Official emotes have no text (desc is null): `label` is ours and only ever an aria-label, never displayed.
// Art: extracted from a local client (tools/local-extract) to /assets/local/emoticon/<dir>/<picId>.png and listed in
// data/local-assets.json group `emoticon/<dir>`; also downloaded from the public mirror by tools/fetch-assets.mjs
// (tools/assets/plan.mjs UI_EXTRAS → data/assets.json ui['emoticon/<dir>/<picId>'], GitHub issue #42). The UI takes the
// local picture first, then the mirror copy, and shows a neutral glyph when neither is there. The picId is not
// derived from the id (autochess_battle_fooldoctor_03…06 → pic_fooldoctor_04/05/06/08_battle).
const emo = (id, sortId, picId, label) => Object.freeze({ id, sortId, picId, label });
export const EMOTE_THEMES = Object.freeze([
  { themeId: 'emoticon_autochess_basic', dir: 'basic', sortId: 100000, isBasic: true, name: N_('表情套组：卫戍协议'), emotes: [
    emo('autochess_battle_happy', 1001, 'pic_happy_battle', N_('开心')),
    emo('autochess_battle_scared', 1002, 'pic_scared_battle', N_('害怕')),
    emo('autochess_battle_sorry', 1003, 'pic_sorry_battle', N_('对不起')),
    emo('autochess_battle_thanks', 1004, 'pic_thanks_battle', N_('谢谢')),
    emo('autochess_battle_thinking', 1005, 'pic_thinking_battle', N_('思考')),
    emo('autochess_battle_nice_cooperate', 1006, 'pic_cooperate_battle', N_('合作愉快')),
  ] },
  { themeId: 'emoticon_originium_slug', dir: 'slug', sortId: 1001, isBasic: false, name: N_('表情套组：虫动'), emotes: [
    emo('slug_autochess_battle_nice_work', 2001, 'pic_nice_work_battle', N_('合作愉快！')),
    emo('slug_autochess_battle_thanks', 2002, 'pic_thanks_battle', N_('谢谢！')),
    emo('slug_autochess_battle_sorry', 2003, 'pic_sorry_battle', N_('对不起！')),
    emo('slug_autochess_battle_bye', 2004, 'pic_bye_battle', N_('再见！')),
    emo('slug_autochess_battle_distrust', 2005, 'pic_distrust_battle', '？？？'),
    emo('slug_autochess_battle_very_soon', 2006, 'pic_very_soon_battle', N_('很快就好！')),
  ] },
  { themeId: 'emoticon_autochess_basic_2', dir: 'basic_2', sortId: 100001, isBasic: true, name: N_('表情套组：卫戍协议'), emotes: [
    emo('autochess_battle_noproblem', 1007, 'pic_noproblem_battle', N_('没问题！')),
    emo('autochess_battle_respect', 1008, 'pic_respect_battle', N_('敬礼！')),
    emo('autochess_battle_call', 1009, 'pic_call_battle', N_('欢呼！')),
    emo('autochess_battle_playingcool', 1010, 'pic_playingcool_battle', N_('酷！')),
    emo('autochess_battle_sad', 1011, 'pic_sad_battle', N_('伤心')),
    emo('autochess_battle_dying', 1012, 'pic_dying_battle', N_('快死了')),
  ] },
  { themeId: 'emoticon_foolsday_doctor', dir: 'fooldoctor', sortId: 1002, isBasic: false, name: N_('表情套组：博士士'), emotes: [
    emo('autochess_battle_fooldoctor_01', 1020, 'pic_fooldoctor_01_battle', N_('博士士 1')),
    emo('autochess_battle_fooldoctor_02', 1021, 'pic_fooldoctor_02_battle', N_('博士士 2')),
    emo('autochess_battle_fooldoctor_03', 1022, 'pic_fooldoctor_04_battle', N_('博士士 3')),
    emo('autochess_battle_fooldoctor_04', 1023, 'pic_fooldoctor_05_battle', N_('博士士 4')),
    emo('autochess_battle_fooldoctor_05', 1024, 'pic_fooldoctor_06_battle', N_('博士士 5')),
    emo('autochess_battle_fooldoctor_06', 1025, 'pic_fooldoctor_08_battle', N_('博士士 6')),
  ] },
  { themeId: 'emoticon_foolsday_amiya', dir: 'foolamiya', sortId: 1003, isBasic: false, name: N_('表情套组：米米子'), emotes: [
    emo('autochess_battle_foolamiya_01', 1040, 'pic_foolamiya_01_battle', N_('米米子 1')),
    emo('autochess_battle_foolamiya_02', 1041, 'pic_foolamiya_02_battle', N_('米米子 2')),
    emo('autochess_battle_foolamiya_03', 1042, 'pic_foolamiya_03_battle', N_('米米子 3')),
    emo('autochess_battle_foolamiya_04', 1043, 'pic_foolamiya_04_battle', N_('米米子 4')),
    emo('autochess_battle_foolamiya_05', 1044, 'pic_foolamiya_05_battle', N_('米米子 5')),
    emo('autochess_battle_foolamiya_06', 1045, 'pic_foolamiya_06_battle', N_('米米子 6')),
  ] },
  { themeId: 'emoticon_foolsday_wisdel', dir: 'foolwisdel', sortId: 1004, isBasic: false, name: N_('表情套组：维维美'), emotes: [
    emo('autochess_battle_foolwisdel_01', 1060, 'pic_foolwisdel_01_battle', N_('维维美 1')),
    emo('autochess_battle_foolwisdel_02', 1061, 'pic_foolwisdel_02_battle', N_('维维美 2')),
    emo('autochess_battle_foolwisdel_03', 1062, 'pic_foolwisdel_03_battle', N_('维维美 3')),
    emo('autochess_battle_foolwisdel_04', 1063, 'pic_foolwisdel_04_battle', N_('维维美 4')),
    emo('autochess_battle_foolwisdel_05', 1064, 'pic_foolwisdel_05_battle', N_('维维美 5')),
    emo('autochess_battle_foolwisdel_06', 1065, 'pic_foolwisdel_06_battle', N_('维维美 6')),
  ] },
].map((t) => Object.freeze({ ...t, emotes: Object.freeze(t.emotes) })));
/** Every emote with its theme: `{ id, sortId, picId, label, themeId, dir }`, in wheel order. */
export const EMOTE_CATALOG = Object.freeze(EMOTE_THEMES.flatMap((t) => t.emotes.map((e) => Object.freeze({ ...e, themeId: t.themeId, dir: t.dir }))));
/** The 36 official emote ids (protocol whitelist: `EMOTES.includes(id)`). */
export const EMOTES = Object.freeze(EMOTE_CATALOG.map((e) => e.id));
const EMOTE_INDEX = new Map(EMOTE_CATALOG.map((e) => [e.id, e]));
/** Catalog record of an emote id, or null (safe for any input, including '__proto__'). */
export const emoteInfo = (id) => (typeof id === 'string' && EMOTE_INDEX.get(id)) || null;
// id-keyed maps without a prototype: a wire id like '__proto__' / 'toString' looks up undefined, never an Object method
const emoteMap = (pick) => Object.freeze(Object.assign(Object.create(null), Object.fromEntries(EMOTE_CATALOG.map((e) => [e.id, pick(e)]))));
/** Emote id → theme id. */
export const EMOTE_THEME = emoteMap((e) => e.themeId);
/** Emote id → our aria-label (never displayed). */
export const EMOTE_LABEL = emoteMap((e) => e.label);
/** data/local-assets.json group of an emote's art (`emoticon/<dir>`), or null. */
export const emoteArtGroup = (id) => { const e = emoteInfo(id); return e ? `emoticon/${e.dir}` : null; };
/** Canonical URL of an emote's extracted art (`/assets/local/emoticon/<dir>/<picId>.png`), or null for unknown ids. */
export const emoteArtPath = (id) => { const e = emoteInfo(id); return e ? `/assets/local/emoticon/${e.dir}/${e.picId}.png` : null; };
export const EMOTE_COOLDOWN_MS = 1000; // activity_table autoChessData.constData.chatCD (s)
export const EMOTE_BUBBLE_MS = 3000;   // constData.chatTime (s): how long a bubble stays up
