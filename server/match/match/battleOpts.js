// server/match/match/battleOpts.js — the ONE assembly of the Battle options a Match hands to its Battle class.
//
// A Match assembles a Battle on exactly two paths, and both must produce the SAME fields:
//   * 真跑 — `MatchCombat.newBattle` (server/match/match/combat.js): the battle the server really runs, and the one a
//     bot's rehearsal runs (server/match/bot.js);
//   * 复算 — `MatchClientCombat._specBattle` (server/match/match/clientCombat.js): the headless run of a client field,
//     a takeover, and the `SP_VERIFY` re-computation of a client's result.
// Everything the two paths decide **from the match itself** lives here, once. The per-path inputs stay at the call
// sites: 真跑 spreads its own `opts` (the round's spec-shaped fields), 复算 reads them back out of the client's BattleSpec
// (`createBattleFromSpec` does that reading) — and 复算 adds `recordEvents: false` (see `specBattleOpts` below).
//
// The five keys below accumulated by being written out twice, and the A-fix (DESIGN §28.12.1, docs/design/mod-layer.md)
// is what a missing half costs: `tokenKits` was added to `combat.js` and not to `_specBattle`, so the server
// re-computation ran a kit-carrying room against the built-in registry. A sixth key now has one place to go — and
// `test/battleOpts.test.js` pins that both paths read this one.
//
// KEY DISCIPLINE (byte-for-byte compatibility, the same rule as `server/sim/spec.js` and `server/lobby.js`): every
// optional key is spread ONLY when the match really has it, so a plain install produces the exact object shape it
// produced before each feature landed. An explicitly passed `opts.<key>` always wins (`baseBattleOpts` spreads the
// caller's options over the match's own fields), which is the precedence both call sites had.

/**
 * Base Battle options of one battle of this match: the match's data source, its sim content mode and its logger, with
 * the caller's own options spread over them (an explicit `opts.data` / `opts.content` / `opts.logger` wins, as it did
 * at both call sites).
 * @param {{ ds: any, battleContent?: string, log?: object }} owner the Match (`this`)
 * @param {object} opts the round's own options (fieldId, kind, seed, …)
 */
export function baseBattleOpts(owner, opts = {}) {
  return { data: owner.ds, content: owner.battleContent, logger: owner.log, ...opts };
}

/**
 * The match-owned extras, in ONE place:
 *   工坊行为层 (docs/WORKSHOP.md §4) — the operator kit table (`kits`, `roomAssets.forRoom(room.modSet)` trimmed to
 *     the room's declared packs, §28.16); 召唤物的行为层 (§4.7) — the summon table, another key space (`tokenKits`);
 *   包声明的战斗逻辑 (`server.battle`, DESIGN §28.17) — the pack's real `install(battle)` functions (`battleInstallers`,
 *     a function cannot cross the wire, so 复算 takes the same array and the browser rebuilds it from the spec);
 *   限伤 override (`SP_BOSS_HIT_LIMIT`, shared/constants.js bossHitLimitFrom) — an explicit per-battle value wins,
 *     absent leaves the key out so the battle falls back to BOSS_HIT_LIMIT.
 * Each key is set only from the match's own copy — never from a process-wide registry.
 */
export function battleOptsFromMatch(owner, opts = {}) {
  const full = baseBattleOpts(owner, opts);
  // an explicit opts.kits always wins (the browser may inject its own map); a match without packs is `null` ⇒ no key,
  // so the battle is byte-for-byte the one a plain install runs
  if (owner.workshopKits && !full.kits) full.kits = owner.workshopKits;
  if (owner.workshopTokenKits && !full.tokenKits) full.tokenKits = owner.workshopTokenKits;
  // kit 的**归属**与**预算**（DESIGN §28.52 的 kit 那一半）：`kits` / `tokenKits` 不带所属包，所以「逐单位回调归到
  // 哪本账上」要靠这三张表（两张 owner 表 + 一张「包 id → 生效 max」）。与上面两行逐字同一条 KEY DISCIPLINE：只有
  // 这一局真的装了包、且装载器真的产出了那张表时才写这个键 —— 干净安装的战斗拿不到它们，形状与从前逐字节相同。
  if (owner.workshopKitOwners && !full.kitOwners) full.kitOwners = owner.workshopKitOwners;
  if (owner.workshopTokenKitOwners && !full.tokenKitOwners) full.tokenKitOwners = owner.workshopTokenKitOwners;
  if (owner.workshopKitBudgets && !full.kitBudgets) full.kitBudgets = owner.workshopKitBudgets;
  if (Array.isArray(owner.battleInstallers) && owner.battleInstallers.length && !full.battleInstallers) full.battleInstallers = owner.battleInstallers;
  if (owner.bossHitLimit !== undefined && full.bossHitLimit === undefined) full.bossHitLimit = owner.bossHitLimit;
  // 行为开关 `morphPairing`（DESIGN §28.43.1）：只在**非缺省档**才写这个键 —— 缺省档（`official`）一个键都不多，
  // 于是没声明这一格的战斗与从前逐字节相同（KEY DISCIPLINE）。战斗里 `Battle` 把它压进 `withMorphPairing`。
  if (owner.morphPairing && owner.morphPairing !== 'official' && full.morphPairing === undefined) full.morphPairing = owner.morphPairing;
  return full;
}

/**
 * `createBattleFromSpec` options for the SECOND path (`_specBattle`): the same match-owned extras through the same
 * helper — the match's own kit tables, the same installers, the same 限伤 override — plus what only a re-computation
 * needs. Keeping this here (and not in clientCombat.js) is what makes the two paths share one assembly: a sixth key
 * cannot reach one path and stop at the other.
 *
 * `recordEvents` is the ONE deliberate difference: 真跑 records the battle's events (the client-side authority replays
 * them, and `b.opts.recordEvents !== false` is the engine default), while a re-computation only needs the RESULT — it
 * must not pay for a history nobody reads. It therefore does not change a single field of the result.
 * @param {{ ds: any, log?: object, BattleClass: Function }} owner the Match (`this`)
 * @param {{ sharedBoss?: object|null }} [o] `sharedBoss` = the pool a boss-like field credits (server/match/finalAssault.js)
 */
export function specBattleOpts(owner, { sharedBoss = null } = {}) {
  return {
    BattleClass: owner.BattleClass,
    sharedBoss,
    logger: owner.log,
    recordEvents: false,
    ...battleOptsFromMatch(owner, {}),
  };
}
