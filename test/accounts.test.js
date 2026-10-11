// 账号（`SP_ACCOUNTS=1`, server/accounts.js, docs/RECORDS.md §2/§4）。
//
// 这个文件盯的是四件事，每一件都能因一个**真 bug** 变红：
//   1. **口令不落明文**（读落盘文件）；
//   2. **握手语义只在开关打开时改变** —— 不开账号的服务器上，不带 auth 的 hello 照旧成功（`SP_ACCOUNTS` 那条
//      不变量：文件存在不许悄悄改握手）；
//   3. **不知道口令拿不到别人的战绩**，而本人拿得到（可见性分级）；
//   4. **账号库坏掉时 fail closed**（不是「当空的用」）。
//
// 顺序敏感的一处：第 1 与第 3 段会临时设 `process.env.SP_ACCOUNTS`，用完立刻删掉。node:test 在同一文件内是
// **串行**的，而每个测试文件跑在**自己的进程**里（`--test-concurrency` 管的是文件之间），所以这个临时的环境
// 变量不会漏给别的文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { AccountStore } from '../server/accounts.js';
import { TestClient } from './helpers/wsClient.js';

test('accounts reserve case-insensitive names, verify passwords and keep private records across restarts', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-accounts-'));
  const accountsFile = path.join(directory, 'accounts.json');
  const recordsFile = path.join(directory, 'records.jsonl');
  let server;
  const clients = [];
  const connect = async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(client);
    return client;
  };
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: true, accountsFile, recordsFile });
    const owner = await connect();
    const welcome = await owner.hello('博士甲', null, { auth: 'register', password: 'correct horse battery' });
    // 账号给的是**稳定** playerId（`p_` + 20 hex = 10 字节随机），不是会话那 5 字节的临时 id。
    assert.match(welcome.playerId, /^p_[0-9a-f]{20}$/);

    // (1) 落盘里没有明文口令，且口令库默认只有属主可读（Windows 不报 mode，所以那里只查内容）。
    const file = readFileSync(accountsFile, 'utf8');
    assert.equal(file.includes('correct horse battery'), false);
    if (process.platform !== 'win32') assert.equal(statSync(accountsFile).mode & 0o777, 0o600);

    const rival = await connect();
    assert.equal((await rival.request({ t: 'hello', name: '博士甲', auth: 'register', password: 'another password' })).code, 'NAME_TAKEN');
    assert.equal((await rival.request({ t: 'hello', name: '博士甲', auth: 'login', password: 'wrong password' })).code, 'BAD_CREDENTIALS');
    assert.equal((await rival.request({ t: 'hello', name: '博士甲' })).code, 'AUTH_REQUIRED');
    // 没登录的人 `records.mine` 连会话都没有 ⇒ 先被 "hello required" 挡下（BAD_MSG），拿不到任何战绩。
    assert.equal((await rival.request({ t: 'records.mine' })).code, 'BAD_MSG');
    // 拿着别人的 token 也不够：开着账号时**只**认口令，token 不是身份证明。
    assert.equal((await rival.request({ t: 'hello', name: '博士乙', token: welcome.token })).code, 'AUTH_REQUIRED');

    const second = await connect();
    const other = await second.hello('博士乙', null, { auth: 'register', password: 'another password' });
    // 账号名不做「纯数字」之类的黑名单（`sanitizeName` 本刀一律不动）：数字账号名能正常注册。
    const numeric = await connect();
    const numericAccount = await numeric.hello('123456', null, { auth: 'register', password: 'numeric account password' });
    assert.match(numericAccount.playerId, /^p_[0-9a-f]{20}$/);

    server.records.save({ code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', matchCount: 1 }, {
      players: [
        { playerId: welcome.playerId, name: '博士甲', seat: 0, stats: { dmgDealt: 90 } },
        { playerId: other.playerId, name: '博士乙', seat: 1, stats: { dmgDealt: 10 } },
      ],
    });
    // (3) 本人拿得到自己的那一档：`ownSeat` 是自己，购卡明细（OWNER 档）不是 null。
    assert.equal((await owner.request({ t: 'records.mine' })).t, 'ok');
    const ownerRecord = await owner.waitFor('records.latest');
    assert.equal(ownerRecord.record.ownSeat, 0);
    assert.ok(Array.isArray(ownerRecord.record.players[0].purchases), 'OWNER 档应当带购卡明细');
    assert.equal((await second.request({ t: 'records.mine' })).t, 'ok');
    const rivalRecord = await second.waitFor('records.latest');
    assert.equal(rivalRecord.record.ownSeat, 1);

    // 重启（同一个账号文件与战绩文件）：身份还在，战绩还查得到。
    await Promise.all(clients.map((client) => client.terminate()));
    clients.length = 0;
    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: true, accountsFile, recordsFile });
    const returnee = await connect();
    // 重启后旧 token 既不是身份（开着账号）也不该让人免口令。
    assert.equal((await returnee.request({ t: 'hello', name: '博士甲', token: welcome.token })).code, 'AUTH_REQUIRED');
    const relogin = await returnee.hello('博士甲', null, { auth: 'login', password: 'correct horse battery' });
    assert.equal(relogin.playerId, welcome.playerId, '同一账号必须拿回同一个 playerId');
    assert.equal((await returnee.request({ t: 'records.mine' })).t, 'ok');
    const record = await returnee.waitFor('records.latest');
    assert.equal(record.record.ownSeat, 0);
    assert.equal(record.record.players[0].damageSharePct, 90);
  } finally {
    await Promise.all(clients.map((client) => client.terminate()));
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('account keys are case-insensitive and corrupted databases fail closed', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-account-key-'));
  const file = path.join(directory, 'accounts.json');
  try {
    const accounts = new AccountStore(file);
    const first = await accounts.authenticate('Alice', 'strong password', 'register');
    assert.ok(first.account);
    assert.equal((await accounts.authenticate('alice', 'different password', 'register')).error, 'NAME_TAKEN');
    assert.equal((await accounts.authenticate('ALICE', 'strong password', 'login')).account.playerId, first.account.playerId);
    // 弱口令是 WEAK_PASSWORD（「换个口令」），不是 BAD_CREDENTIALS（「你打错了」）。
    assert.equal((await accounts.authenticate('Bob', 'short', 'register')).error, 'WEAK_PASSWORD');
    // 坏库 ⇒ 抛，**不是**空库（当空的用就等于把所有人的账号静默注销）。
    writeFileSync(file, '{broken');
    assert.throws(() => new AccountStore(file));
    // 版本不对也抛（将来改形状时，旧进程读到新库是「起不来」，不是「读了一半」）。
    writeFileSync(file, JSON.stringify({ version: 2, accounts: [] }));
    assert.throws(() => new AccountStore(file));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('without SP_ACCOUNTS the handshake and the account routes are byte-for-byte unchanged', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sp-accounts-off-'));
  let server;
  const clients = [];
  try {
    // 连账号文件都不给：`accounts` 缺省 ⇒ 按 `SP_ACCOUNTS` 判，而它没设 ⇒ 功能整个不存在。
    assert.equal(process.env.SP_ACCOUNTS, undefined, '这个测试要求 SP_ACCOUNTS 未被外部设置');
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, recordsFile: path.join(directory, 'records.jsonl') });
    assert.equal(server.accounts, null);
    assert.equal(server.records, null);
    const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(client);
    // 不带 auth 的老客户端照旧拿到 welcome —— 这就是「没有 SP_ACCOUNTS 时握手逐字节不变」。
    const welcome = await client.hello('Doctor');
    assert.match(welcome.playerId, /^p_[0-9a-f]{10}$/, '没开账号时 playerId 还是今天那 5 字节临时 id');
    // 而账号查询路由**不存在**（404），不是「空结果」。
    assert.equal((await fetch(`${server.url}/api/records/account/Doctor`)).status, 404);
    // `records.mine` 仍然可用（无记录 ⇒ null），因为它查的是本会话的 playerId，不是账号。
    assert.equal((await client.request({ t: 'records.mine' })).t, 'ok');
    const latest = await client.waitFor('records.latest');
    assert.equal(latest.record, null);
  } finally {
    await Promise.all(clients.map((client) => client.terminate()));
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
