// 对局战绩（server/matchRecords.js, docs/RECORDS.md §3/§4）。
//
// 盯四件事：
//   1. **落盘与重载**：追加的是 JSONL，重启后「房间最近一局」与「玩家最近一局」都还查得到；
//   2. **无界增长这道闸**：追加到上限后压缩重写，文件行数与两个索引都**有硬边界**；
//   3. **可见性分级**：公开（只凭房间号）只有 seat + 是否本人；昵称要同房；购卡明细只在本人那一档；
//   4. **HTTP 只读面**：`GET /api/records/<CODE>` 返回公开形状，**不含 playerId**。
//
// 这里 import 的是**真的** `startServer`（`../server/index.js`）。投稿的补丁 import 了
// `./helpers/legacyServer.js` —— 本仓库没有那个文件，照抄会直接红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MatchRecords, MAX_PLAYERS, MAX_ROOMS, COMPACT_AFTER_APPENDS, RECORD_VERSION } from '../server/matchRecords.js';
import { CODE_ALPHABET } from '../server/lobby.js';
import { startServer } from '../server/index.js';

const player = (playerId, name, damage, buys) => ({
  playerId, name, seat: 0, stats: { dmgDealt: damage, refreshes: 2, activatedLayers: 8 },
  bonds: [{ bondId: 'bond_test', name: '迅捷', layers: 8, active: true }],
  purchases: [{ kind: 'chess', id: 'char_amiya', name: '阿米娅', count: buys, spent: buys * 2,
    byRound: buys > 2 ? { 1: 2, 2: buys - 2 } : { 1: buys } }],
});

test('completed matches persist, calculate shares and keep latest room and player results', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-records-'));
  try {
    const file = path.join(directory, 'records.jsonl');
    const records = new MatchRecords(file, { warn() {}, error() {} });
    const room = { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', matchCount: 1 };
    // 没有结算摘要（中途退出 / 服务关闭）⇒ 不落盘。没写过的文件**根本不存在**（连空文件都不创建）。
    assert.equal(records.save(room, null), null);
    assert.equal(existsSync(file), false, '没有结算就不该产生任何文件');
    const first = records.save(room, { players: [player('p1', '阿米娅', 300, 3), player('p2', '凯尔希', 100, 1)], roundsPassed: 8 }, 1000);
    assert.equal(first.v, RECORD_VERSION);
    // 输出占比按本局总伤害算：300 / 400 = 75%。
    const publicFirst = records.latestRoom('ABCD');
    assert.equal(publicFirst.players[0].damageSharePct, 75);
    assert.equal(publicFirst.players[1].damageSharePct, 25);
    assert.equal(publicFirst.players[0].stats.buys, 3);
    assert.equal(publicFirst.players[0].stats.refreshes, 2);
    assert.equal(publicFirst.players[0].bonds[0].name, '迅捷');
    // 公开档：没有 playerId，没有昵称，没有购卡明细。
    assert.equal(Object.hasOwn(publicFirst.players[0], 'playerId'), false);
    assert.equal(publicFirst.players[0].nameHidden, true);
    assert.equal(publicFirst.players[0].name, 'P1');
    assert.equal(publicFirst.players[0].purchases, null);
    // 本人那一档（OWNER）：昵称、购卡明细、ownSeat 都有。
    const mine = records.latestPlayer('p1');
    assert.equal(mine.ownSeat, 0);
    assert.equal(mine.players[0].name, '阿米娅');
    assert.deepEqual(mine.players[0].purchases[0], { kind: 'chess', id: 'char_amiya', name: '阿米娅', count: 3, spent: 6, byRound: { 1: 2, 2: 1 } });

    room.matchCount++;
    records.save(room, { players: [player('p1', '阿米娅', 20, 5)], roundsPassed: 9, victory: true }, 2000);
    assert.equal(records.latestRoom('ABCD').matchNo, 2);
    assert.equal(records.latestRoom('ABCD').players[0].stats.buys, 5);
    // 房间索引只留最近一局，玩家索引各自留自己的最近一局（p2 没参加第二局）。
    assert.equal(records.latestPlayer('p2').matchNo, 1);
    assert.equal(records.latestPlayer('p1').ownSeat, 0);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);

    const reloaded = new MatchRecords(file, { warn() {}, error() {} });
    assert.equal(reloaded.latestRoom('ABCD').matchNo, 2);
    assert.equal(reloaded.latestPlayer('p2').players.length, 2);
    // 非法房间号（含 I/O 与路径片段）不进索引也不查得到。
    assert.equal(reloaded.latestRoom('../'), null);
    assert.equal(reloaded.latestRoom('ABCI'), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the journal is bounded: compaction rewrites it and drops history beyond the caps', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-records-cap-'));
  try {
    const file = path.join(directory, 'records.jsonl');
    const records = new MatchRecords(file, { warn() {}, error() {} });
    const lines = () => (readFileSync(file, 'utf8').match(/\n/g) || []).length;
    const roomCodes = 26 * 26;
    // 每局换一个房间号，但**同一个玩家** —— 这样两个索引各自只留最后一条，压缩的证据就很干净：
    // 文件必须从「追加了 COMPACT_AFTER_APPENDS + 1 行」掉回「索引真正指向的那几条」。
    // 房间号必须从**真的字母表**里取（`CODE_ALPHABET` 没有 I / O）：用 A-Z 会造出 `IKXY` 这种非法号，
    // `save` 会照规矩拒掉它，于是「追加了多少行」就跟循环次数对不上 —— 这正是第一次跑红的原因。
    const total = COMPACT_AFTER_APPENDS + 1;
    for (let i = 0; i < total; i++) {
      const code = CODE_ALPHABET[i % 24] + CODE_ALPHABET[Math.floor(i / 24) % 24] + 'XY';
      records.save({ code, mode: 'coop', matchCount: i }, { players: [player('p1', 'D', 10, 1)] }, 1000 + i);
    }
    // 压缩确实发生过：`appended` 是**上一次压缩以来**的追加数，所以它必然回到 [0, 阈值) 内 —— 跑完全程还没
    // 越过阈值的话它会是 `total`（5001）。这条断言就是「阈值真的被跨过并被重置」的证据。
    assert.ok(records.appended < COMPACT_AFTER_APPENDS, `压缩应已发生（计数应被重置），实为 ${records.appended}`);
    // 硬边界（server/matchRecords.js 的文件头写着同一条）：索引上限之和 + 阈值。每个房间只留最近一局
    // ⇒ 盘上剩的就是「各房间最近一局」那一批，而**绝不是**跑过的 5001 局。
    const hardCap = MAX_PLAYERS + MAX_ROOMS + COMPACT_AFTER_APPENDS;
    assert.ok(lines() < total, `压缩后行数应远小于跑过的局数，实为 ${lines()}`);
    assert.ok(lines() <= hardCap, `压缩后行数应在上界内，实为 ${lines()}`);
    assert.ok(records.byRoom.size <= MAX_ROOMS);
    assert.ok(records.byPlayer.size <= MAX_PLAYERS);
    // 压缩后文件仍是可重载的合法 JSONL，且**每个索引指向的记录都还在盘上**（压缩不能把索引与盘弄分叉）。
    const reloaded = new MatchRecords(file, { warn() {}, error() {} });
    assert.equal(reloaded.byPlayer.size, 1, '同一个玩家 ⇒ 玩家索引只留一条');
    assert.ok(reloaded.byRoom.size > 0);
    assert.ok(reloaded.byRoom.size <= roomCodes, `索引不该超过房间号空间，实为 ${reloaded.byRoom.size}`);
    // 关键证据：**不是**把跑过的每一局都留着 —— 否则 `byRoom` 会等于 `total`。
    assert.ok(reloaded.byRoom.size < total, '索引应当只留每个房间的最近一局');
    for (const [code, record] of reloaded.byRoom) {
      assert.equal(records.byRoom.get(code)?.id, record.id, `${code} 的最近一局在压缩后应当仍可查`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unknown record versions are skipped with a warning, invalid lines never throw', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-records-version-'));
  try {
    const file = path.join(directory, 'records.jsonl');
    const warnings = [];
    const good = { v: RECORD_VERSION, id: 'x', code: 'ABCD', matchNo: 1, finishedAt: 1000, mode: 'coop', difficulty: 'NORMAL', victory: false, roundsPassed: 1, durationMs: 1, players: [{ playerId: 'p1', seat: 0, name: 'D', isBot: false, victory: false, roundsPassed: 1, damageSharePct: 100, stats: {}, bonds: [], purchases: [] }] };
    writeFileSync(file, [
      JSON.stringify(good),
      '{not json',
      JSON.stringify({ ...good, v: 99, id: 'future' }),
      JSON.stringify({ ...good, id: 'nocode', code: 'AB' }),
    ].join('\n') + '\n');
    const records = new MatchRecords(file, { warn: (m) => warnings.push(m), error() {} });
    // 只有那条 v=1 的被索引；坏行与未知版本都被**跳过并告警**，构造不抛。
    assert.equal(records.byRoom.size, 1);
    assert.equal(records.latestRoom('ABCD').id, 'x');
    assert.equal(warnings.filter((m) => m.includes('unknown version')).length, 1);
    assert.equal(warnings.filter((m) => m.includes('invalid journal entry')).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('public records endpoint returns latest completed match without player ids', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-records-http-'));
  let server;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: true, recordsFile: path.join(directory, 'records.jsonl'), accountsFile: path.join(directory, 'accounts.json') });
    server.records.save({ code: 'WXYZ', mode: 'coop', difficulty: 'FUNNY', matchCount: 1 }, { players: [player('secret', 'Doctor', 50, 2)] }, 3000);
    const response = await fetch(`${server.url}/api/records/WXYZ`);
    assert.equal(response.status, 200);
    const record = await response.json();
    // 公开档：座位号在，昵称与购卡明细**不在**，playerId 更不在。
    assert.equal(record.players[0].seat, 0);
    assert.equal(record.players[0].nameHidden, true);
    assert.equal(record.players[0].purchases, null);
    assert.equal(JSON.stringify(record).includes('secret'), false);
    assert.equal(JSON.stringify(record).includes('Doctor'), false);
    assert.equal((await fetch(`${server.url}/api/records/ABCD`)).status, 404);
    // 房间号规则与既有房间号字母表一致：I / O / 小写都不是合法房间号 ⇒ 落到静态文件（404）。
    assert.equal((await fetch(`${server.url}/api/records/ABCI`)).status, 404);
    // 没有这个账号 ⇒ 404；这是只读面，没有写方法。
    assert.equal((await fetch(`${server.url}/api/records/account/Nobody`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/records/WXYZ`, { method: 'POST' })).status, 405);
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the account endpoint answers with the queried account row only, and cannot be used to probe names', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-records-account-'));
  let server;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: true, recordsFile: path.join(directory, 'records.jsonl'), accountsFile: path.join(directory, 'accounts.json') });
    const mine = server.accounts;
    const alice = await mine.authenticate('Alice', 'alice password', 'register');
    const bob = await mine.authenticate('Bob', 'bob password', 'register');
    // 队友 Bob 的昵称与购卡明细都进了记录：这两样**绝不许**从账号面漏出来（业主裁令）。
    server.records.save({ code: 'WXYZ', mode: 'coop', difficulty: 'NORMAL', matchCount: 1 }, {
      players: [
        { playerId: alice.account.playerId, name: 'Alice', seat: 0, stats: { dmgDealt: 30 }, purchases: [{ kind: 'chess', id: 'char_a', name: 'A', count: 2, spent: 4 }] },
        { playerId: bob.account.playerId, name: 'BobOfTheNorth', seat: 1, stats: { dmgDealt: 70 }, purchases: [{ kind: 'item', id: 'item_b', name: 'B', count: 9, spent: 99 }] },
      ],
    }, 5000);

    // 大小写不敏感但**精确**匹配（与登录同一套键）。
    for (const name of ['Alice', 'alice', 'ALICE']) {
      const response = await fetch(`${server.url}/api/records/account/${name}`);
      assert.equal(response.status, 200, name);
      const body = await response.json();
      // 只有本人那一行，座位是 0 —— 不是队友那行，也不是「全部玩家」。
      assert.equal(body.players.length, 1, '只回被查账号本人那一行');
      assert.equal(body.ownSeat, 0);
      assert.equal(body.players[0].seat, 0);
      // 统计按 `STAT_KEYS` 归一（缺的补 0），所以断言点名那两项而不是整对象 deepEqual。
      assert.equal(body.players[0].stats.dmgDealt, 30);
      assert.equal(body.players[0].stats.buys, 2, 'buys 由购卡明细折算 —— 折算是允许的，明细本身不许出现');
      assert.equal(body.players[0].purchases, null, '账号面绝不回逐回合购卡明细');
      const text = JSON.stringify(body);
      assert.equal(text.includes('BobOfTheNorth'), false, '绝不回其他玩家的昵称');
      assert.equal(text.includes('Bob'), false);
      assert.equal(text.includes('purchases":['), false, '响应里没有购卡明细字段');
      assert.equal(text.includes('item_b'), false);
      assert.equal(text.includes('char_a'), false, '连本人的购卡明细也不从这个端点出');
      assert.equal(text.includes(alice.account.playerId), false, 'playerId 任何档位都不出现');
    }

    // 「不存在的账号」与「存在但这一局里没有他」必须**同答复**：状态码与正文逐字节相同。
    const ghost = await fetch(`${server.url}/api/records/account/Ghost`);
    assert.equal(ghost.status, 404);
    const ghostText = await ghost.text();
    assert.equal(ghostText, '{"error":"RECORD_NOT_FOUND"}');
    // Bob 是**真的存在**的账号，只是刚才那局里他也在 —— 换一个存在但没打过一局的账号：
    const carol = await mine.authenticate('Carol', 'carol password', 'register');
    assert.ok(carol.account);
    const noMatch = await fetch(`${server.url}/api/records/account/Carol`);
    assert.equal(noMatch.status, 404);
    assert.equal(await noMatch.text(), ghostText, '不存在的账号与没有战绩的账号必须同答复（否则就是存在性探针）');
    // 超长名字也走同一答复，不是 400（分开就是长度探针）。
    assert.equal((await fetch(`${server.url}/api/records/account/${'x'.repeat(80)}`)).status, 404);
    // 不做前缀 / 模糊：'Ali' 不是 'Alice'。
    assert.equal((await fetch(`${server.url}/api/records/account/Ali`)).status, 404);
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the read-only records routes are rate-limited (burst, then 429)', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-records-rate-'));
  let server;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: true, recordsFile: path.join(directory, 'records.jsonl'), accountsFile: path.join(directory, 'accounts.json') });
    // 突发是 10：前 10 次必须**都不是** 429（否则正常用户会被误伤），第 11 次必须 429（否则桶没生效）。
    const codes = [];
    for (let i = 0; i < 11; i++) {
      const response = await fetch(`${server.url}/api/records/ABCD`);
      codes.push(response.status);
      if (i === 10) assert.equal(response.headers.get('retry-after'), '1');
    }
    assert.ok(codes.slice(0, 10).every((code) => code !== 429), `前 10 次不该限流，实为 ${codes.join(',')}`);
    assert.equal(codes[10], 429, `第 11 次该被限流，实为 ${codes.join(',')}`);
    // 两条只读路由共用同一只桶（不然换个路由就能翻倍额度）。
    assert.equal((await fetch(`${server.url}/api/records/account/Alice`)).status, 429);
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
