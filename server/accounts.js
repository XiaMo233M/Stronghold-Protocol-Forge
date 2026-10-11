// 账号口令库（`SP_ACCOUNTS=1`，docs/RECORDS.md §2）。
//
// 这一层只做三件事：**账号名 → 稳定 playerId** 的持久映射、**口令的 scrypt 派生**、以及**原子落盘**。它不认识
// HTTP、不认识 WebSocket、不认识房间 —— `hello` 那一侧的接线在 server/net.js，战绩那一侧的接线在
// server/matchRecords.js（只通过 `get(name)` 借一个 playerId）。
//
// ## 它为什么存在
// 今天 `playerId` 每次连接都是新的（server/net.js `'p_' + randomBytes(5)`），所以「我的战绩」在换个会话之后就
// 找不回来了。账号给的就是一个**跨会话稳定**的 playerId；玩家侧的身份证明是口令，不是管理员密钥。
//
// ## 口令是怎么存的（这是本文件唯一要紧的事）
//   * 每个账号一条 **16 字节随机盐**（`randomBytes(16)`）+ **scrypt 派生**出的 32 字节键；文件里只有
//     `salt` / `hash` 的十六进制，**永不明文**、也**永不回显**（连错误信息里都没有）。
//   * 参数 `N=2^15, r=8, p=1`。这是**业主裁令**从投稿的 `N=16384 (2^14)` 抬上来的：OWASP 的口令存储备忘当前
//     推荐 `N=2^17, r=8, p=1`，`2^14` 已经低于它；`2^15` 是本项目愿意付的折中。
//   * **取舍（明写在这里，也写在 docs/RECORDS.md）**：一次派生约 32 MB 内存、单核几十毫秒。这两个数字
//     乘以「同时登录的人数」就是**攻击面** —— 拿它当 CPU 放大器打是划算的，所以上限不是靠参数，而是靠
//     `server/net.js` 的 `authBuckets`（按客户端网络键限流）+ `conn.authenticating`（同连接不并发派生）。
//     继续抬 N 会让合法玩家等更久、让攻击者更划算，所以本刀就停在 `2^15`。
//   * 比较一律 `timingSafeEqual`，且在**长度守卫之后**（`timingSafeEqual` 对不等长会抛，而抛就是一个可观测的
//     差异）。长度不等在这里只可能是记录损坏，不是攻击面。
//
// ## 落盘
// `save()` 走「同目录临时文件（`flag:'wx'`，`mode:0o600`）+ `rename`」—— 原子替换，读的人要么看到旧库要么看到
// 新库，看不到半个。**欠 `fsync`**：防的是进程崩溃，不是掉电/机器崩溃（要防那个得在 rename 前 fsync 文件、
// 之后 fsync 目录，本刀不做，理由是不值得为口令库引一次同步磁盘写）。
//
// ## 关掉账号时这个文件根本不加载
// 没有 `SP_ACCOUNTS=1` 时 `server/index.js` **不构造** `AccountStore`，`Network` 收到 `accounts: null`，
// `hello` 的分支整个不进 —— 握手与今天逐字节相同。
//
// ## 版权
// 本文件的来源与许可声明见 THIRD-PARTY-NOTICES.md「投稿 b639e98e6efb」。

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 32;
const SALT_BYTES = 16;
/**
 * scrypt 参数。`maxmem` 必须容得下 `128*N*r` **加上** Node 内部那次 `128*r*p` 的额外分配，否则 scrypt 直接抛
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` —— `2^15` 下前者是 32 MiB、后者 1 KiB，所以 64 MiB 有一倍余量。
 */
const PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

/** 口令门槛：长度 + 无控制字符。**不是**强度评分（那会变成一张要维护的规则表）。 @param {unknown} password */
export const validPassword = (password) => typeof password === 'string'
  && password.length >= 8 && password.length <= 128 && !/[\u0000-\u001f\u007f]/.test(password);

/**
 * 账号名的键：NFC 归一 + 小写。大小写与等价 Unicode 写法因此**互相占用**（`Alice` 与 `alice` 是同一个账号）——
 * 否则「看起来一样但登录不上」会变成一个只能靠猜的坑。
 * @param {string} name
 */
export const accountKey = (name) => name.normalize('NFC').toLowerCase();

const isHex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

/** 账号库的持久形状。载荷本身是 `{ version, accounts }`。 */
export class AccountStore {
  /** @param {string} file `accounts.json` 的路径 */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, { name: string, playerId: string, salt: string, hash: string }>} */
    this.byName = new Map();
    let rows;
    try { rows = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error; // 存在但坏掉 ⇒ 抛（**fail closed**，绝不「当空的用」）
      rows = { version: 1, accounts: [] };
    }
    if (!rows || rows.version !== 1 || !Array.isArray(rows.accounts)) throw new Error('invalid account database');
    for (const row of rows.accounts) {
      if (!row || typeof row.name !== 'string' || typeof row.playerId !== 'string'
        || !isHex(row.salt, 32) || !isHex(row.hash, 64)
        || this.byName.has(accountKey(row.name))) throw new Error('invalid account database entry');
      this.byName.set(accountKey(row.name), row);
    }
  }

  /** @param {string} name @returns {{ name: string, playerId: string, salt: string, hash: string } | null} */
  get(name) { return typeof name === 'string' ? this.byName.get(accountKey(name)) || null : null; }

  /** 库里现在有多少条（测试与 /healthz 用；不含任何口令材料）。 */
  get size() { return this.byName.size; }

  /**
   * `hello` 的认证。`mode` = `'login'`（必须是已有账号且口令对上）或 `'register'`（必须没有同名账号）。
   *
   * 注册时口令不满足门槛 ⇒ `WEAK_PASSWORD`（**不是** `BAD_CREDENTIALS`），因为那是「换个口令」而不是「你打错了」。
   * 登录时账号不存在与口令不对**都**回 `BAD_CREDENTIALS` —— 分开就是账号枚举。
   * @param {string} name
   * @param {unknown} password
   * @param {'login'|'register'} mode
   * @returns {Promise<{ account?: object, error?: 'WEAK_PASSWORD'|'BAD_CREDENTIALS'|'AUTH_REQUIRED'|'NAME_TAKEN' }>}
   */
  async authenticate(name, password, mode) {
    if (!validPassword(password)) return { error: 'WEAK_PASSWORD' };
    const key = accountKey(name);
    const existing = this.byName.get(key);
    if (mode === 'login') {
      if (!existing) return { error: 'BAD_CREDENTIALS' };
      const derived = await scrypt(password, Buffer.from(existing.salt, 'hex'), KEY_LENGTH, PARAMS);
      return timingSafeEqual(derived, Buffer.from(existing.hash, 'hex'))
        ? { account: existing } : { error: 'BAD_CREDENTIALS' };
    }
    if (mode !== 'register') return { error: 'AUTH_REQUIRED' };
    if (existing) return { error: 'NAME_TAKEN' };
    const salt = randomBytes(SALT_BYTES);
    const hash = await scrypt(password, salt, KEY_LENGTH, PARAMS);
    // 派生是 await：这中间库可能已经被另一条路改过（同一进程内）。再查一次，避免后写覆盖先写。
    if (this.byName.has(key)) return { error: 'NAME_TAKEN' };
    const account = {
      name, playerId: 'p_' + randomBytes(10).toString('hex'), salt: salt.toString('hex'), hash: hash.toString('hex'),
    };
    this.byName.set(key, account);
    try { this.save(); }
    catch (error) { this.byName.delete(key); throw error; } // 落盘失败 ⇒ 内存回到落盘前的样子，两边不分叉
    return { account };
  }

  /**
   * 原子替换落盘：同目录临时文件（`flag:'wx'` 独占创建，防两个进程撞同一个名字）→ `renameSync` 覆盖。
   * 目录不存在就建（`recursive`）。`mode:0o600` 让口令库默认只有属主可读。
   *
   * 失败会抛：调用方负责把内存里的值放回去（`authenticate` 就是这么做的），**绝不吞**——一次没写下去的
   * 注册如果被当成成功，玩家下次就登不进自己的账号。
   */
  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, accounts: [...this.byName.values()] }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.file);
  }
}
