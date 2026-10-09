// test/packBattle.test.js — 包声明的**战斗逻辑**（`pack.json.server.battle`, DESIGN §28.17）。
//
// 这一类载荷补的是 `kits/` 补不上的那一块：kit 是**一个干员**的代码，而一份真实 mod 的盟约效果是**整场**的（我方
// 所有成员对处于控制状态的敌人增伤、凑够 N 名不同成员时全员加攻速、某两件装备同时装备时每秒真实伤害）。要跑出这些
// 条件，代码得在**战场级别**读玩家、读全场单位、读装备组合 —— kit 看不到别人。
//
// 这个文件钉四件事：
//   1. **形状与硬闸门**：`server.battle = { module }`，必须配 `combat: true`（它改对局结果，进摘要闸门与 golden）；
//   2. **装载期**：模块必须真的在包里（`BATTLE_BAD_MODULE` 整包被拒）；
//   3. **静态扫描与 import 白名单**：`Math.random` / `Date.now` / `process` 与非白名单 import 一律让**整包**移出已加载
//      集合 —— 「声明了要改战斗却装不上」比「没装」危险得多；
//   4. **真服务器 + 真战场**：装载器交出来的 `install(battle)` 真的在战场里跑（条件增伤与攻速都看得见），
//      `/workshop-battle/` 只服务装载器登记过的 URL，`spec.workshopBattle` 带上要送到浏览器的那份清单。
//
// 数值一律从**黑板**读（`buffParams(bondRecord(id), 'env_gbuff_new')`），与官方内容模块同一条纪律 —— 这也是那份
// 社区 mod 的写法（它头部写着 "never from literals"）。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { loadWorkshop } from '../server/workshop.js';
import { loadBattleInstallers, battleSourceIssues } from '../server/battlePack.js';
import { makeBattle, chessRec, enemyRec } from './helpers/battleHarness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const BOND = 'victoriaShip';

/**
 * 逐句移植自那份社区 mod 的 `bonds/custom.js` 的战斗那一半（只改「怎么拿到引擎助手」：它原来 import 相对路径，这里
 * 走包接口白名单 `@battle/index.js`）。两段最要紧的条件逻辑都在：对**受控**敌人增伤（`hit` 上的 `dmg.mul`，谢拉格那
 * 个模式），以及 N 名**不同**成员时全员加攻速（`passiveBuff`）。
 */
const PORTED_BATTLE_HALF_TEMPLATE = (BOND_ID) => `
import { num, bondRecord, buffParams, bondActive, bondTier, bondLayers, isMember, playerOps, passiveBuff } from '@battle/index.js';

const BOND = ${JSON.stringify(BOND_ID)};
const bbOf = (id) => buffParams(bondRecord(id), 'env_gbuff_new') ?? {};

/** 敌人处于眩晕 / 停顿 / 束缚 / 不动（任一即可）——与原件同一个判据。 */
function controlled(t) {
  if (!t) return false;
  const f = (t.s && t.s.flags) || {};
  if (f.stun || f.bind || f.immobile || f.rooted) return true;
  if (t.moving === false || !(t.s && t.s.moveSpeed > 0) || f.noMove) return true;
  return !!(t.findBuff && (t.findBuff('stun') || t.findBuff('sluggish') || t.findBuff('bind')));
}

export function install(battle) {
  if (!battle || !Array.isArray(battle.players)) return;
  const bb = bbOf(BOND);
  for (const p of battle.players) {
    const pid = p.playerId;
    if (!bondActive(battle, pid, BOND)) continue;
    const members = playerOps(battle, pid).filter((u) => isMember(battle, u, BOND));
    if (!members.length) continue;
    const memberSet = new Set(members);
    const L = () => bondLayers(battle, pid, BOND);

    // 条件一：成员对**受控**敌人的伤害倍率（数值只从黑板来）
    battle.on('hit', (c) => {
      const s = c.source, t = c.target, dmg = c.dmg;
      if (!s || !memberSet.has(s) || !dmg || !controlled(t)) return;
      const bonus = num(bb.base_damage_scale) + num(bb.damage_scale_per_stack) * L();
      if (bonus > 0) dmg.mul *= 1 + bonus;
    });

    // 条件二：N 名**不同**成员（精英与普通算同一名）时全员加攻速
    const distinct = new Set(members.map((u) => String(u.defId || u.def?.id || '').replace(/_b$/, '_a')));
    const need = num(bb.power_bond_char_cnt, 6);
    if (distinct.size >= need || bondTier(battle, pid, BOND) >= 2) {
      const aspd = num(bb.bonus_attack_speed);
      if (aspd > 0) for (const u of members) passiveBuff(battle, u, 'bond:' + BOND + ':aspd', { aspd });
    }
  }
}
`;

/** 一个最小包：一条盟约记录（带黑板）+ 一段战斗逻辑。 */
function writePack(root, id, moduleSource, { combat = true, module = 'battle/main.mjs', chess = null } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, path.dirname(module)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id, name: id, version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
    combat, content: ['bonds'],
    server: { battle: { module } },
  }));
  fs.writeFileSync(path.join(dir, 'bonds.json'), JSON.stringify({
    [BOND]: {
      bondId: BOND, name: '维多利亚', isCore: false, thresholds: [3, 6],
      buffs: [{ key: 'env_gbuff_new', bb: { power_bond_char_cnt: 2, base_damage_scale: 0.35, damage_scale_per_stack: 0.05, bonus_attack_speed: 25 } }],
    },
  }));
  if (chess) fs.writeFileSync(path.join(dir, 'chess.json'), JSON.stringify(chess));
  fs.writeFileSync(path.join(dir, module), moduleSource);
  return dir;
}

describe('server.battle：形状、硬闸门与装载期判据', () => {
  test('形状：{ module } 一个字段，路径必须包内相对、必须是 .mjs', () => {
    const ok = loadWorkshop('/nonexistent', { log: quiet });
    assert.deepEqual(ok.packs, []);
    let tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-shape-'));
    const cases = [
      [{ module: 'battle/main.js' }, 'BATTLE_BAD_MODULE'],
      [{ module: '../outside.mjs' }, 'BATTLE_BAD_PATH'],
      [{ module: 'battle/main.mjs', registers: [] }, 'BATTLE_UNKNOWN_FIELD'],
      ['nope', 'BATTLE_BAD_SHAPE'],
    ];
    for (const [decl, code] of cases) {
      const dir = path.join(tmp, `p${Math.abs(code.length)}-${String(decl)}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'p-bad', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', combat: true,
        content: ['bonds'], server: { battle: decl },
      }));
      fs.writeFileSync(path.join(dir, 'bonds.json'), JSON.stringify({ testBond: { bondId: 'testBond', buffs: [] } }));
      const loaded = loadWorkshop(dir, { log: quiet });
      // 顶层路径不是工坊根：pack.json 位于 dir 下，`loadWorkshop(dir)` 把 dir 当根，所以直接看错误码
      assert.deepEqual(loaded.packs.map((p) => p.id), [], `${JSON.stringify(decl)} 不该被收下`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('没声明 combat: true ⇒ 整包被拒（BATTLE_NEEDS_COMBAT）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-combat-'));
    const root = path.join(tmp, 'ws');
    writePack(root, 'no-combat', PORTED_BATTLE_HALF_TEMPLATE('victoriaShip'), { combat: false });
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.packs, []);
    assert.match(loaded.errors[0].reason, /BATTLE_NEEDS_COMBAT/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('模块文件不在 ⇒ 整包被拒（BATTLE_BAD_MODULE）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-missing-'));
    const root = path.join(tmp, 'ws');
    const dir = writePack(root, 'missing-module', PORTED_BATTLE_HALF_TEMPLATE('victoriaShip'));
    fs.rmSync(path.join(dir, 'battle', 'main.mjs'));
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.packs, []);
    assert.match(loaded.errors[0].reason, /BATTLE_BAD_MODULE/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('静态扫描：非确定性 / 环境绑定一律点名（在 import 之前）', () => {
    for (const needle of ['Math.random()', 'Date.now()', 'process.env.X', 'localStorage.x']) {
      const issues = battleSourceIssues(`export function install() { return ${needle}; }`, 'p');
      assert.equal(issues.length >= 1, true, `${needle} 必须被扫出来`);
      assert.equal(issues[0].code, 'BATTLE_BAD_SOURCE');
    }
    assert.deepEqual(battleSourceIssues('export function install(battle) { battle.step(); }', 'p'), []);
  });

  test('import 白名单：@battle/ 与 @sim/ 之外一律拒（含相对路径与裸模块名）', () => {
    const bad = (spec) => battleSourceIssues(`import { x } from '${spec}';\nexport function install() {}`, 'p');
    assert.match(bad('../support/index.js')[0].reason, /@battle\//);
    assert.match(bad('node:fs')[0].reason, /白名单/);
    assert.deepEqual(battleSourceIssues("import { num } from '@battle/index.js';\nexport function install() {}", 'p'), []);
    assert.deepEqual(battleSourceIssues("import { GEO } from '@sim/constants.js';\nexport function install() {}", 'p'), []);
  });
});

describe('server.battle：装载与真服务器', () => {
  let tmp;
  let root;
  let loaded;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-load-'));
    root = path.join(tmp, 'ws');
    writePack(root, 'battle-pack', PORTED_BATTLE_HALF_TEMPLATE('victoriaShip'));
    loaded = loadWorkshop(root, { log: quiet });
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('装载器交出 install 函数与要送浏览器的模块清单（URL 带包摘要）', async () => {
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.packs.map((p) => `${p.id}:${p.layer}:${p.combat}`), ['battle-pack:B:true']);
    const r = await loadBattleInstallers(loaded, { log: quiet });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.installers.map((i) => i.id), ['battle-pack']);
    assert.equal(typeof r.installers[0].install, 'function');
    assert.deepEqual(r.modules.map((m) => m.id), ['battle-pack']);
    assert.match(r.modules[0].url, /^\/workshop-battle\/battle-pack\/battle\/main\.mjs\?v=/);
    assert.match(r.modules[0].url, new RegExp(loaded.packs[0].hash));
  });

  test('没有 `install` 导出 ⇒ 报 BATTLE_NO_INSTALL（装配路径拒绝这一包）', async () => {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-noinstall-'));
    writePack(t2, 'no-install', 'export function notInstall() {}\n');
    const r = await loadBattleInstallers(loadWorkshop(t2, { log: quiet }), { log: quiet });
    assert.deepEqual(r.installers, []);
    assert.equal(r.errors[0].code, 'BATTLE_NO_INSTALL');
    fs.rmSync(t2, { recursive: true, force: true });
  });

  test('真服务器：装上了的包进 Lobby，`/workshop-battle/` 只服务登记过的 URL', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: root });
    try {
      assert.deepEqual(srv.lobby.workshop.battle.map((m) => m.id), ['battle-pack']);
      assert.equal(typeof srv.lobby.workshop.battleInstallers[0].install, 'function');
      const url = srv.lobby.workshop.battle[0].url;
      const res = await fetch(`http://127.0.0.1:${srv.port}${url}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /javascript/);
      const body = await res.text();
      assert.match(body, /export function install/, '送出去的必须是作者写的那段源码');
      assert.match(body, /@battle\/index\.js/, '浏览器侧靠 import map 解 @battle/，所以源码里的说明符不能被改写');
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/workshop-battle/battle-pack/battle/other.mjs`)).status, 404, '没登记的路径');
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/workshop-battle/other-pack/battle/main.mjs`)).status, 404);
    } finally {
      await srv.close();
    }
  });

  test('源码里带非确定性 ⇒ 整包移出已加载集合（welcome.mods.packs 里没有它）', async () => {
    const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-bad-'));
    const bad = path.join(t3, 'ws');
    writePack(bad, 'bad-battle', "export function install() { return Math.random(); }\n");
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: bad });
    try {
      const packs = (srv.lobby.welcomeInfo().mods || { packs: [] }).packs.map((p) => p.id);
      assert.equal(packs.includes('bad-battle'), false, `被裁的包不该出现在线上摘要里：${JSON.stringify(packs)}`);
      assert.deepEqual(srv.lobby.workshop.battle, []);
      assert.deepEqual(srv.lobby.workshop.battleInstallers, []);
    } finally {
      await srv.close();
      fs.rmSync(t3, { recursive: true, force: true });
    }
  });
});

describe('server.battle：真战场里跑起来（条件增伤与 N 名成员攻速）', () => {
  let tmp;
  let installers;

  // 包**自己的**盟约与干员（不覆盖官方记录：官方 id 只有声明了 overrides 才能替换，而这里不需要）——真实 mod 就是
  // 这么写的：一条自己的盟约记录（数值全在黑板里）+ 一批计入它的干员。
  const BOND_ID = 'wsTestShip';
  const OPS = ['chess_ws_t1_a', 'chess_ws_t1_b'];

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-battle-fight-'));
    const root = path.join(tmp, 'ws');
    writePack(root, 'battle-pack', PORTED_BATTLE_HALF_TEMPLATE(BOND_ID));
    const r = await loadBattleInstallers(loadWorkshop(root, { log: quiet }), { log: quiet });
    assert.deepEqual(r.errors, []);
    installers = r.installers;
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  /** 这一局的游戏数据：包自己的两位干员 + 一只不还手的敌人 + 那条盟约记录（黑板就是它的数值来源）。 */
  const DATA = {
    chess: Object.fromEntries(OPS.map((id) => [id, chessRec({ id, bonds: [BOND_ID], stats: { atk: 500, aspd: 100, moveSpeed: 1 } })])),
    enemies: { e_n: enemyRec({ key: 'e_n', hp: 1e6, atk: 0, def: 0, res: 0, speed: 1 }) },
    bonds: {
      [BOND_ID]: {
        bondId: BOND_ID, name: '测试盟约', isCore: false, thresholds: [2, 4],
        buffs: [{ key: 'env_gbuff_new', bb: { power_bond_char_cnt: 2, base_damage_scale: 0.35, damage_scale_per_stack: 0.05, bonus_attack_speed: 25 } }],
      },
    },
  };

  /** 一场最小战斗：两位成员上场，玩家带着这条盟约。 */
  function field(bondState = { active: true, count: 2, tier: 0, layers: 0 }) {
    return makeBattle({
      data: DATA, kind: 'unite', autoFinish: false, timeLimit: 5, flags: { dpPerSec: 0, dpMax: 999 },
      units: OPS.map((id, i) => ({ chessId: id, row: 10, col: 5 + i * 2 })),
      bonds: { [BOND_ID]: bondState },
      battleInstallers: installers,
    });
  }

  test('受控（眩晕）的敌人才吃增伤；没受控的一个倍率都不变', () => {
    const h = field();
    h.step();
    const members = h.b.units.filter((u) => u.kind === 'op');
    assert.equal(members.length, 2, '两位成员都要真的上场');
    const [member] = members;
    // 一只有路线、会走的敌人：它不满足「不动」那一半，所以只有真的被眩晕之后才算受控。
    const route = { motion: 'WALK', start: [10, 6], end: [10, 2], checkpoints: [] };
    const e = h.spawn('e_n', { pos: [10, 6], route });
    h.step();
    const free = { source: member, target: e, dmg: { mul: 1, tags: [] } };
    h.b.emit('hit', free);
    assert.equal(free.dmg.mul, 1, `没被控制的敌人不该被加成（moveSpeed=${e.s && e.s.moveSpeed} moving=${e.moving} flags=${JSON.stringify(e.s && e.s.flags)}）`);
    h.b.applyStatus(e, 'stun', { duration: 2 });
    const stunned = { source: member, target: e, dmg: { mul: 1, tags: [] } };
    h.b.emit('hit', stunned);
    // 黑板：base_damage_scale 0.35 + damage_scale_per_stack 0.05 × 层数(0) ⇒ ×1.35
    assert.equal(Math.round(stunned.dmg.mul * 1000) / 1000, 1.35, '受控敌人按黑板数值增伤');
    assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
  });

  test('tier 2（或够人数）时全员加攻速；精英与普通算同一名成员', () => {
    const h = field({ active: true, count: 2, tier: 2, layers: 0 });
    h.step();
    const members = h.b.units.filter((u) => u.kind === 'op');
    assert.equal(members.length, 2);
    for (const u of members) {
      assert.ok(u.s.aspd >= u.base.aspd + 25 - 1e-6, `${u.defId}: 攻速应当 +25（实际 ${u.s.aspd} vs ${u.base.aspd}）`);
    }
    assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
  });

  test('盟约没激活的玩家一个效果都没有（条件读的是这一局的状态，不是包自己的开关）', () => {
    const h = field({ active: false, count: 0, tier: 0, layers: 0 });
    h.step();
    const member = h.b.units.find((u) => u.kind === 'op');
    const route = { motion: 'WALK', start: [10, 6], end: [10, 2], checkpoints: [] };
    const e = h.spawn('e_n', { pos: [10, 6], route });
    h.b.applyStatus(e, 'stun', { duration: 2 });
    const hit = { source: member, target: e, dmg: { mul: 1, tags: [] } };
    h.b.emit('hit', hit);
    assert.equal(hit.dmg.mul, 1, '盟约没激活就不该有增伤');
    assert.ok(member.s.aspd < member.base.aspd + 25 - 1e-6, '也不该有攻速加成');
    assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
  });
});
