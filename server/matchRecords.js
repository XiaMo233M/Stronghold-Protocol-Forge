// 对局战绩（`SP_ACCOUNTS=1` 时接线，docs/RECORDS.md §3）。
//
// 一次**完整结算**写一条记录（`server/lobby.js` 的结算点调 `save`）。中途退出、服务关闭都不产生记录 —— 没有
// 「补录」这回事，因为本文件只认结算那一刻给它的事件。
//
// ## 落盘形状：JSONL 追加日志 + **有界**压缩重写
// 每局一行 `JSON`（自含、可独立解析），行首 `v` 是**行格式版本**。装载时逐行 `JSON.parse`：坏行**跳过并告警**，
// 未知 `v` 同样**跳过并告警** —— 将来演进行形状时，旧进程读到新行是「少一条」而不是「起不来」。
//
// **不许无界增长**（业主裁令）：两个索引各自有上限，落盘文件随之被压缩重写。
//   * `byPlayer` ≤ `MAX_PLAYERS` 条（最近打过的那些玩家）—— 这是 `records.mine` 真正要的那张表；
//   * `byRoom` ≤ `MAX_ROOMS` 条（最近结算过的那些房间）；
//   * 追加行数达到 `COMPACT_AFTER_APPENDS` 时**压缩一次**：把「两个索引当前指向的记录」原子重写进文件，其余
//     历史行丢弃。于是文件行数的硬上界是 `MAX_PLAYERS + MAX_ROOMS + COMPACT_AFTER_APPENDS`
//     （`test/match-records.test.js` 断言的正是这一条），而两次压缩之间最多再涨 `COMPACT_AFTER_APPENDS` 行。
//     注意**不是**「每个房间一局」那么小：`byPlayer` 是给 `records.mine` 用的，它留的是「每个玩家最近一局」，
//     所以 20000 个各打过一局的玩家仍然各占一行 —— 这正是这两张表的用处，也是它们必须被限住的原因。
//   * **代价**（明写）：压缩会丢弃不再被任何索引引用的**历史局**。也就是说「ABCD 房间的上一局」查不到，只有
//     「最近一局」——这与 `GET /api/records/ABCD` 的语义（「最近一局」）一致，不是缺陷，但它意味着**这不是一份
//     可归档的战绩史**。要归档请把 `SP_RECORDS_FILE` 指到会被备份的地方，并在压缩前另行导出。
//   * 压缩是**原子**的：同目录临时文件（`flag:'wx'`）+ `renameSync`，读者看不到半个文件。
//
// ## 可见性分级（业主裁令：公开面只给 seat + 是否本人）
// `PUBLIC` / `MEMBER` / `OWNER` 三档，分别对应「只知道房间号的人」「同房的人」「本人」。昵称只在 `MEMBER`
// 及以上出现；**逐回合购卡明细只在 `OWNER` 出现**；`playerId` **任何档位都不出现**（它是会话凭证的一部分）。
// 于是「知道房间号」这件事的效果被限死在「4 个座位号 + 是否本人」。
//
// ## 隐私
// 记的是：座位、昵称、是否 AI、胜负、通过回合、统计数字、盟约层数、购卡明细、结算时刻。**不记** IP、不记会话
// token、不记 `playerId` 进公开面（journal 里留着，因为 `records.mine` 与压缩都要用它）。
//
// ## 版权
// 本文件的来源与许可声明见 THIRD-PARTY-NOTICES.md「投稿 b639e98e6efb」。

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** 行格式版本。加字段不改它（旧进程会照样读）；**删字段 / 改语义**才 +1。 */
export const RECORD_VERSION = 1;

/** 每次结算落进 journal 的统计键（顺序即公开面顺序，客户端按它渲染）。 */
const STAT_KEYS = ['dmgDealt', 'bossDamage', 'kills', 'activatedLayers', 'buys', 'refreshes', 'merges', 'itemsEquipped', 'gold', 'perfectRounds', 'leaks', 'lpLost'];

/** 房间号字母表与 `server/lobby.js:CODE_ALPHABET` 一致（无 I / O）。 */
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

/** 索引上限：超过就丢**最旧**的那些。 @type {number} */
export const MAX_PLAYERS = 20_000;
export const MAX_ROOMS = 5_000;
/** 追加多少行之后压缩一次。文件行数的硬上界因此是 `索引上限 + 这个数`。 */
export const COMPACT_AFTER_APPENDS = 5_000;

const num = (value) => Math.max(0, Number(value) || 0);

/**
 * 三档可见性。`PUBLIC` = 只凭房间号（seat + 是否本人），`MEMBER` = 同房（+ 昵称），`OWNER` = 本人（+ 购卡明细）。
 * @type {Readonly<{ PUBLIC: 'public', MEMBER: 'member', OWNER: 'owner' }>}
 */
export const VIEW = Object.freeze({ PUBLIC: 'public', MEMBER: 'member', OWNER: 'owner' });

const seatLabel = (seat) => (Number.isInteger(seat) && seat >= 0 ? `P${seat + 1}` : 'P?');

/**
 * 一行玩家在某个可见档位下的形状。**房间面与账号面共用它** —— 两处各写一份是「同一件事有两份真相」的开始。
 * @param {object} player 内部记录里的一行
 * @param {boolean} showNames @param {boolean} showPurchases
 */
function visiblePlayer(player, showNames, showPurchases) {
  return {
    seat: player.seat,
    name: showNames ? player.name : seatLabel(player.seat),
    nameHidden: !showNames,
    isBot: player.isBot,
    victory: player.victory,
    roundsPassed: player.roundsPassed,
    damageSharePct: player.damageSharePct,
    stats: player.stats,
    bonds: player.bonds.map((bond) => ({ bondId: bond.bondId, name: bond.name, layers: bond.layers, active: bond.active })),
    // 购卡明细只在本人那一档出现；其余档位给 `null`（**不是**空数组 —— 空数组会撒谎说「他没买过」）。
    purchases: showPurchases ? player.purchases : null,
  };
}

/**
 * 把一条内部记录裁成某个可见档位的形状。
 * @param {object|null} record
 * @param {object|null} viewer `{ playerId }`，或 null（匿名）
 * @param {'public'|'member'|'owner'} audience 调用方**已经判定**的档位（HTTP 路由不知道房间成员，所以它只发 public）
 */
function visibleRecord(record, viewer, audience) {
  if (!record) return null;
  const viewerId = viewer && typeof viewer.playerId === 'string' ? viewer.playerId : null;
  const own = record.players.find((player) => player.playerId === viewerId) || null;
  // 请求者本人 ⇒ 无论调用方给什么档位，都至少是他自己的那一档（自己看自己永远不该被降级）。
  const tier = own ? VIEW.OWNER : audience;
  const showNames = tier === VIEW.MEMBER || tier === VIEW.OWNER;
  const showPurchases = tier === VIEW.OWNER;
  return {
    v: record.v,
    id: record.id,
    code: record.code,
    matchNo: record.matchNo,
    finishedAt: record.finishedAt,
    mode: record.mode,
    difficulty: record.difficulty,
    victory: record.victory,
    roundsPassed: record.roundsPassed,
    durationMs: record.durationMs,
    ownSeat: own ? own.seat : null,
    players: record.players.map((player) => visiblePlayer(player, showNames, showPurchases)),
  };
}

/**
 * **账号面**的形状（业主裁令）：只回**被查账号本人**那一行，绝不回同房其他人的昵称、也绝不回逐回合购卡明细。
 *
 * 与 `visibleRecord` 的差别是刻意的，不是简写：
 *   * 这里没有「请求者」这个身份 —— 拿账号名来查的调用方（机器人 / 任何知道名字的人）**不是**那个账号的持有者，
 *     所以档位固定在 `MEMBER`（给自己看名字，别人的行根本不出现），而且**不给购卡明细**；
 *   * 本人要拿完整明细，走的是 `records.mine`（已认证会话），不是这个 HTTP 端点。所以这个端点
 *     **比本人那一档更严**，而不是更松。
 * @param {object|null} record @param {string} playerId 被查账号的 playerId
 */
function ownAccountSummary(record, playerId) {
  if (!record) return null;
  const own = record.players.find((player) => player.playerId === playerId);
  if (!own) return null;
  return {
    v: record.v,
    code: record.code,
    matchNo: record.matchNo,
    finishedAt: record.finishedAt,
    mode: record.mode,
    difficulty: record.difficulty,
    victory: record.victory,
    roundsPassed: record.roundsPassed,
    durationMs: record.durationMs,
    ownSeat: own.seat,
    // 只有一行：被查账号自己。`visiblePlayer` 与房间面共用，所以字段形状两边一致。
    players: [visiblePlayer(own, true, false)],
  };
}

/** 战绩日志与两个索引。构造即读盘（坏行跳过并告警），`save` 追加并原子压缩。 */
export class MatchRecords {
  /** @param {string} file `match-records.jsonl` @param {object} [log] `console` 形状 */
  constructor(file, log = console) {
    this.file = file;
    this.log = log;
    /** @type {Map<string, object>} 房间号 → 最近一局 */
    this.byRoom = new Map();
    /** @type {Map<string, object>} playerId → 该玩家最近一局 */
    this.byPlayer = new Map();
    /** 自上次压缩以来追加的行数。 */
    this.appended = 0;
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); }
        catch { log.warn?.('[records] skipped invalid journal entry'); continue; }
        if (row && row.v !== RECORD_VERSION) { log.warn?.(`[records] skipped journal entry with unknown version ${JSON.stringify(row.v)}`); continue; }
        try { this.index(row); }
        catch { log.warn?.('[records] skipped invalid journal entry'); }
      }
      // 装载的行都已在盘上；把计数起点设成「刚压缩过」，下一次压缩由新的追加量触发。
      this.appended = 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  /** 索引一条记录（构造装载与 `save` 共用）。形状不对就抛，由调用方决定跳过还是失败。 @param {object} record */
  index(record) {
    if (!record || !CODE_RE.test(record.code) || !Array.isArray(record.players) || !Number.isFinite(record.finishedAt)) {
      throw new Error('invalid record');
    }
    const prior = this.byRoom.get(record.code);
    if (!prior || record.finishedAt >= prior.finishedAt) this.byRoom.set(record.code, record);
    for (const player of record.players) {
      if (!player.playerId || player.isBot) continue;
      const last = this.byPlayer.get(player.playerId);
      if (!last || record.finishedAt >= last.finishedAt) this.byPlayer.set(player.playerId, record);
    }
    this.trim();
  }

  /** 两个索引各自的上限；只在上限**被超过**时才排序，所以正常路径是 O(1)。 */
  trim() {
    if (this.byRoom.size > MAX_ROOMS) this.dropOldest(this.byRoom, MAX_ROOMS);
    if (this.byPlayer.size > MAX_PLAYERS) this.dropOldest(this.byPlayer, MAX_PLAYERS);
  }

  /** @param {Map<string, object>} map @param {number} cap */
  dropOldest(map, cap) {
    const oldestFirst = [...map.entries()].sort((left, right) => left[1].finishedAt - right[1].finishedAt);
    for (let i = 0; i < oldestFirst.length - cap; i++) map.delete(oldestFirst[i][0]);
  }

  /**
   * 落一条**完整结算**。`summary` 形状不对（没有 players、房间号不合法）⇒ 返回 null 且**什么都不写**。
   * @param {{ code: string, mode?: string, difficulty?: string, matchCount?: number }} room
   * @param {object|null} summary `server/lobby.js` 的结算摘要
   * @param {number} [finishedAt] ms epoch（测试注入；生产走 `this.now()` 的调用方）
   * @returns {object|null} 内部记录（未裁剪）
   */
  save(room, summary, finishedAt = Date.now()) {
    if (!room || !CODE_RE.test(room.code)) return null;
    if (!summary || !Array.isArray(summary.players) || !summary.players.length) return null;
    const totalDamage = summary.players.reduce((total, player) => total + num(player.stats?.dmgDealt), 0);
    const record = {
      v: RECORD_VERSION,
      id: randomUUID(),
      code: room.code,
      matchNo: Number(room.matchCount) || 0,
      finishedAt,
      mode: room.mode,
      difficulty: summary.difficulty || room.difficulty,
      victory: !!summary.victory,
      roundsPassed: Number(summary.roundsPassed) || 0,
      durationMs: Number(summary.durationMs) || 0,
      players: summary.players.map((player) => ({
        playerId: String(player.playerId || ''),
        seat: Number(player.seat) || 0,
        name: String(player.name || '').slice(0, 24),
        isBot: !!player.isBot,
        victory: !!player.victory,
        roundsPassed: Number(player.roundsPassed) || 0,
        damageSharePct: totalDamage ? Math.round(num(player.stats?.dmgDealt) / totalDamage * 1000) / 10 : 0,
        stats: Object.fromEntries(STAT_KEYS.map((key) => [key, num(key === 'buys'
          ? player.stats?.buys ?? (Array.isArray(player.purchases) ? player.purchases.reduce((total, p) => total + (Number(p?.count) || 0), 0) : 0)
          : player.stats?.[key])])),
        bonds: (Array.isArray(player.bonds) ? player.bonds : []).filter((bond) => bond && typeof bond.bondId === 'string')
          .map((bond) => ({ bondId: bond.bondId, name: String(bond.name || bond.bondId).slice(0, 40), layers: num(bond.layers), active: !!bond.active })),
        purchases: (Array.isArray(player.purchases) ? player.purchases : []).filter((purchase) => purchase && typeof purchase.id === 'string')
          .map((purchase) => ({
            kind: purchase.kind === 'item' ? 'item' : 'chess',
            id: purchase.id,
            name: String(purchase.name || purchase.id).slice(0, 40),
            count: num(purchase.count),
            spent: num(purchase.spent),
            byRound: Object.fromEntries(Object.entries(purchase.byRound || {})
              .filter(([round, count]) => /^\d{1,2}$/.test(round) && Number.isInteger(count) && count > 0)),
          })),
      })),
    };
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(record) + '\n', { encoding: 'utf8', flag: 'a' });
    this.index(record);
    this.appended++;
    if (this.appended >= COMPACT_AFTER_APPENDS) {
      try { this.compact(); }
      catch (error) { this.log.error?.('[records] compaction failed', error); } // 压缩失败只记日志：索引仍对，文件只是偏大
    }
    return record;
  }

  /**
   * 原子压缩：把两个索引当前指向的记录重写进文件，其余历史行丢弃。临时文件 + `rename`，读者看不到半个文件。
   * 压缩后 `appended` 归零。索引**不动**（盘上正好就是索引指向的那批）。
   */
  compact() {
    const keep = new Map();
    for (const record of this.byPlayer.values()) keep.set(record.id, record);
    for (const record of this.byRoom.values()) keep.set(record.id, record);
    const rows = [...keep.values()].sort((left, right) => left.finishedAt - right.finishedAt);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, rows.map((record) => JSON.stringify(record)).join('\n') + (rows.length ? '\n' : ''), { encoding: 'utf8', flag: 'wx' });
      renameSync(temporary, this.file);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* 临时文件清不掉不影响正确性 */ }
      throw error;
    }
    this.appended = 0;
    return rows.length;
  }

  /** 校验房间号（导出给 HTTP 路由与测试用）。 @param {unknown} code */
  static isCode(code) { return typeof code === 'string' && CODE_RE.test(code); }

  /**
   * 房间的最近一局，按可见档位裁剪。HTTP 路由**只**发 `public`：它不知道请求者是不是房间成员，
   * 而把「不是成员」猜成「是成员」就是泄露。 @param {string} code @param {string} [audience]
   */
  latestRoom(code, audience = VIEW.PUBLIC) {
    if (!CODE_RE.test(code)) return null;
    return visibleRecord(this.byRoom.get(code) || null, null, audience);
  }

  /**
   * 某个 playerId 的最近一局（`records.mine` 走这条：请求者就是 playerId 的持有者，所以档位是 OWNER）。
   * @param {string} playerId @param {object|null} [viewer]
   */
  latestPlayer(playerId, viewer = null) {
    const record = this.byPlayer.get(playerId);
    if (!record) return null;
    return visibleRecord(record, viewer || { playerId }, VIEW.OWNER);
  }

  /**
   * 某账号的最近一局，**只回这个账号自己那一行**（业主裁令；形状见 `ownAccountSummary`）。
   *
   * 三种「没有」在返回值上是**同一件事**（都 null），因为调用方对它们必须给同一个答复：
   *   1. 服务器没开账号（`accounts` 为 null）—— 路由那一层已经先判了；
   *   2. 账号不存在（名字打错）；
   *   3. 账号存在但这局记录里没有他 / 他还没打完过一局。
   * 把 2 与 3 分开就会变成**账号存在性探针**：拿一个名字来问，用状态码就能分辨它存不存在。
   *
   * 名字走 `accounts.get` ⇒ 与登录**同一套**键（NFC 归一 + 小写、**精确匹配**）；这里不做前缀、模糊、正则。
   * @param {{ get: (name: string) => ({ playerId?: string }|null) }|null} accounts
   * @param {string} name
   */
  latestByAccount(accounts, name) {
    if (!accounts || typeof accounts.get !== 'function' || typeof name !== 'string' || !name.trim()) return null;
    const account = accounts.get(name.trim());
    if (!account || typeof account.playerId !== 'string') return null;
    return ownAccountSummary(this.byPlayer.get(account.playerId) || null, account.playerId);
  }
}
