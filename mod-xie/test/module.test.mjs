// mod-xie/test/module.test.mjs — 包的服务端那一半：房间自门控、规则派生、通道 → 对局（借用/应答/债务）、
// 以及本轮审计 P2 那三条规则修正。
//
// 怎么跑：在**管理器树**里 `node --test mod-xie/test/module.test.mjs`（本文件用相对路径导入引擎的 shared/，
// 因为规则解析器住在那里；包本身不 import 引擎，test 可以）。
//
// 用**假对局**（一个最小宿主）而不是真 Match：这一层要断言的是「接缝挂上了没有、通道映射对不对、状态改没改」，
// 真 Match 的回合调度会把这三件事淹掉。真服务的端到端在 mod-xie 的装载验收（test/modxiePackLoads）与
// 管理器侧 test/modMatchChannels.test.mjs 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerServer, isXieRoom, XIE_CHANNELS } from '../server/mod.mjs';
import { rulesForDifficulty, teamEconomyOf, revivalOf } from '../server/rules.mjs';

/** 装上包装器并拿到子类（registrar 是同步的：host.matchClass(fn) 立刻把 fn(Base) 交回来）。 */
function subclassOf(Base) {
  let cls = null;
  registerServer({ matchClass: (fn) => { cls = fn(Base); } });
  return cls;
}

/** 最小宿主：假 Base 提供（虚拟的）引擎面，够经济与救援的法律路径跑起来。 */
function makeHost({ modRoom = true } = {}) {
  class FakeBase {
    constructor(opts) {
      this.mods = opts.mods || null;
      this.difficulty = opts.difficulty || 'NORMAL';
      this.seed = 1234;
      this.round = 1;
      this.phase = 'PREP';
      this.order = [];
      this.players = new Map();
      this.lastResults = new Map();
      this.uniteResultView = null;
      this.disposed = false;
      this.ended = false;
      this.gd = { lpCapPerRound: 3, leftoverKeptBands: [], lastRound: 14, bossRound: 8, hiddenRound: 15, income: (r) => 5 + Math.max(0, Number(r) || 1) };
      this.toasts = [];
      this.timers = [];
      this.sched = { now: () => 1000 };
      this.uid = 0;
    }
    // ---- 引擎面（虚拟）
    alivePlayers() { return [...this.players.values()].filter((p) => p.alive); }
    toast(ps, kind, text) { this.toasts.push({ playerId: ps && ps.playerId, kind, text }); return { ok: true }; }
    tickerText(text) { return { ok: true, text }; }
    later(fn, ms) { this.timers.push({ fn, ms }); return this.timers.length; }
    cancel() { return true; }
    markPrivate() { return true; }
    markPublic() { return true; }
    flush() { return true; }
    reportError(where, e) { this.reported = this.reported || []; this.reported.push({ where, message: e && e.message }); }
    nextUid() { return `u${++this.uid}`; }
    start() { this.started = true; return { ok: true }; }
    startRound(r) { this.superRounds = (this.superRounds || []).concat(r); return { ok: true }; }
    endPrep() { return { ok: true }; }
    settle(plan, res) { return { ok: true }; }
    afterSettle() { return { ok: true }; }
    handle() { return { ok: true }; }
    _quit() { return { ok: true }; }
    scheduleBotPrep() { return { ok: true }; }
    publicView() { return { players: [...this.players.keys()].map((playerId) => ({ playerId })) }; }
    addFunds() { return true; }
    // ---- 工具
    seat(playerId, funds = 5, extra = {}) {
      const match = this;
      const ps = {
        playerId, name: playerId, m: match, gd: match.gd,
        alive: true, left: false, isBot: false, ready: false,
        funds, pendingFunds: 0, lp: 10, bandId: null, deployCount: 0,
        shop: { level: 1, freeRefreshes: 0 },
        addFunds(n) { this.funds += n; },
        dirty() { return true; },
        privateView() { return { t: 'm.private', playerId: this.playerId }; },
        eliminate() { this.eliminated = true; return { ok: true }; },
        setReady(on) { this.ready = !!on; return { ok: true }; },
        ...extra,
      };
      this.players.set(playerId, ps);
      this.order.push(ps);
      return ps;
    }
  }
  const Sub = subclassOf(FakeBase);
  const match = new Sub({ difficulty: 'NORMAL', mods: { digest: 'x'.repeat(64), packs: modRoom ? [{ id: 'mod-xie' }] : [{ id: 'other' }] } });
  return { match, Sub };
}

test('房间自门控：普通房间（集合里没有本包）一个分支都不进', () => {
  const { match } = makeHost({ modRoom: false });
  assert.equal(isXieRoom(match.mods), false);
  match.start();
  assert.equal(match.__xieReady, false, '没有武装');
  assert.equal(match.teamEcon ?? null, null, '没有经济规则集');
  match.seat('p1');
  match.startRound(1);
  assert.deepEqual(match.superRounds, [1], '直通 super');
  match.handlePackMsg('p1', { channel: 'borrow', data: { to: 'p2', amount: 1 } });
  assert.equal(match.econRequests ?? null, null, '通道消息不进（没有经济容器）');
});

test('促融共竞房间：规则从难度派生（官方记录不复制），席位被包装', () => {
  const { match } = makeHost();
  match.seat('p1').ready = false;
  match.seat('p2');
  match.start();
  assert.equal(match.__xieReady, true);
  assert.equal(match.teamEcon.transfer.maxPerRequest, 1, '规则块到达解析器');
  assert.equal(match.teamEcon.transfer.requestsPerRound, 4);
  assert.equal(match.teamEcon.transfer.teamCapPerRound, 8);
  assert.deepEqual(Object.keys(match.teamEcon.projects).sort(), ['logistics', 'storehouse'], '这个模式只开这两个项目');
  assert.equal(match.revivalRuleInit.costPer, 5, '救援规则集解析出来了（每人 5 起步，从共享池扣）');
  assert.equal(match.revivalRuleInit.step, 5, '每复活一次每人 +5（依次叠加）');
  assert.equal(typeof match.econInit, 'function', '经济容器装上了（子类原型）');
  assert.equal(typeof match.revivalInit, 'function');
  assert.equal(match.players.get('p1').eliminate.__xieWrapped ?? true, true);
  assert.equal(match.players.get('p1').__xieWrapped, true, '席位被包装（淘汰/私有视图/…）');
  const priv = match.players.get('p1').privateView();
  assert.ok(priv.econ, '私有视图带 econ（HUD 的能力探针）');
  const pub = match.publicView();
  assert.ok('econ' in pub && 'revival' in pub, '公开视图带两个探针键');
});

test('通道 → 对局：借钱（borrow）与应答（answer）真的改资金、落下债务', () => {
  const { match } = makeHost();
  match.seat('p1', 1);
  match.seat('p2', 9);
  match.start();
  match.startRound(1);                                   // arm + 还债（第一回合没有债务）

  match.handlePackMsg('p1', { channel: 'borrow', data: { to: 'p2', amount: 1 } });
  assert.equal(match.econRequests.size, 1, '请求落在对局里');
  const [id, req] = [...match.econRequests.entries()][0];
  assert.equal(req.from, 'p1');
  assert.deepEqual(req.targets, ['p2'], 'v2.1：借钱是广播（目标是其余全体队友）');
  assert.equal(req.amount, 1);

  match.handlePackMsg('p2', { channel: 'answer', data: { id, approve: true } });
  assert.equal(match.players.get('p1').funds, 2, '借到的钱到了借款人手里');
  assert.equal(match.players.get('p2').funds, 8, '出借人扣了 1');
  const debts = match.econDebts.get('p1') || [];
  assert.equal(debts.length, 1, '债务账本记了这笔（方案 B：下一回合收入里还）');
  assert.equal(match.econRequests.size, 0, '请求消费掉就不在了');
  assert.equal(match.econCoverRate('p1'), 0, '兜底分红在包化第一版恒为 0（shim；账本不受影响）');

  // 还债：下一回合的 startRound 末尾把债务清掉
  match.round = 2;
  match.startRound(2);
  assert.equal((match.econDebts.get('p1') || []).length, 0, '收入到手即还款');
  assert.ok(match.players.get('p2').funds >= 9, '出借人拿回了钱');
});

test('没声明的通道与守卫：不改状态、不抛异常', () => {
  const { match } = makeHost();
  match.seat('p1');
  match.seat('p2');
  match.start();
  match.handlePackMsg('p1', { channel: 'nope', data: {} });
  match.handlePackMsg('p1', { channel: 'revive', data: { round: 1, playerId: 'p2' } });  // 窗口没开 → 规则拒绝，不抛
  match.handlePackMsg('p2', { channel: 'borrow', data: { to: 'p1', amount: 1 } });        // p2 是真实席位，合法
  assert.equal(match.reported ?? null, null, `不该有 reportError（${JSON.stringify(match.reported)}）`);
  assert.equal(XIE_CHANNELS.length, 6, 'borrow/answer/project/vote/relief/revive');
  assert.ok(XIE_CHANNELS.includes('vote'), 'v2.1 的升级表态通道');
});

test('命令通道被消费（不再广播），身份只认平台给的 playerId', () => {
  const { match } = makeHost();
  match.seat('p1', 1);
  match.seat('p2', 9);
  match.start();
  match.startRound(1);

  // 载荷里自称的身份不作数：from / seat / playerId 全是伪造值，请求的 from 仍是 ps.playerId
  const consumed = match.handlePackMsg('p1', { channel: 'borrow', data: { to: 'p2', amount: 1, from: 'p2', seat: 3, playerId: 'p2' } });
  assert.equal(consumed, true, '命令通道返回 true = 平台不广播');
  const [, req] = [...match.econRequests.entries()][0];
  assert.equal(req.from, 'p1', '发起人来自平台给的 playerId（伪造的 from 不作数）');
  assert.deepEqual(req.targets, ['p2']);

  // 观战者：不在 players 里 ⇒ 消费掉但什么也不做
  const before = match.econRequests.size;
  assert.equal(match.handlePackMsg('spec1', { channel: 'borrow', data: { to: 'p2', amount: 1 } }), true, '观战者的命令同样消费');
  assert.equal(match.econRequests.size, before, '且不改状态');

  // 没声明的通道：不自称消费（平台层本来就会拒它）
  assert.notEqual(match.handlePackMsg('p1', { channel: 'nope', data: {} }), true);
});

test('审计 P2 的规则修正：空 projects 块 = 一个都不开；救援成本钳到 minDonorLp - 1', () => {
  const withEmpty = teamEconomyOf({ mode: { teamEconomy: { enabled: true, projects: {} } } });
  assert.deepEqual(Object.keys(withEmpty.projects), [], '显式的空块不再回落成默认集');
  const noBlock = teamEconomyOf({ mode: { teamEconomy: { enabled: true } } });
  assert.ok(Object.keys(noBlock.projects).length > 0, '整个键缺席才用默认集');

  const parsed = revivalOf({ mode: { revival: { enabled: true, costPer: 5, step: 5 } } });
  assert.equal(parsed.costPer, 5, 'v2.1：每人每次的池价');
  assert.equal(parsed.step, 5, 'v2.1：每复活一次往上加的量');
  const off = revivalOf({ mode: { revival: { enabled: false } } });
  assert.equal(off, null, '没开的模式没有救援规则集');

  for (const d of ['FUNNY', 'NORMAL', 'HARD', 'ABYSS']) {
    const r = rulesForDifficulty(d);
    assert.equal(typeof r.transferDesc, 'string', `${d}: 展示文案由同一份数字生成（audit P2）`);
    assert.match(r.transferDesc, new RegExp(`最多借调 ${r.teamEconomy.transfer.maxPerRequest} 资金`));
  }
});

// ---- v2.1 新规则（业主 2026-10-12）--------------------------------------------------------------

test('借钱广播：三人各自可借 1，一人同意不关掉别人的提示', () => {
  const { match } = makeHost();
  match.seat('p1', 0);
  match.seat('p2', 5);
  match.seat('p3', 5);
  match.start();
  match.startRound(1);

  match.handlePackMsg('p1', { channel: 'borrow', data: { amount: 1 } });
  assert.equal(match.econRequests.size, 1, '一条广播');
  const [id, req] = [...match.econRequests.entries()][0];
  assert.deepEqual([...req.targets].sort(), ['p2', 'p3'], '发给其余两人');
  assert.equal(typeof req.phrase, 'string', '服务端随机挂了一句喊话（气泡用）');

  match.handlePackMsg('p2', { channel: 'answer', data: { id, approve: true } });
  assert.equal(match.players.get('p1').funds, 1, 'p2 借出 1');
  assert.equal(match.players.get('p2').funds, 4);
  assert.equal(match.econRequests.size, 1, '其余的不自动关闭：p3 还没答，请求还在');

  match.handlePackMsg('p3', { channel: 'answer', data: { id, approve: true } });
  assert.equal(match.players.get('p1').funds, 2, '一条广播最多由多人各借 1');
  assert.equal(match.econRequests.size, 0, '全员应答后关单');
});

test('复活：全体队友同意才成立，费用从共享池按人头扣（5 → 10 依次叠加）', () => {
  const { match } = makeHost();
  match.seat('p1');
  match.seat('p2');
  const downed = match.seat('p3', 0, { alive: false, pendingDeath: true, lp: 0 });
  match.start();
  match.teamReserve = 100;

  match.phase = 'SETTLE';
  match.revivalDefer(downed);
  assert.equal(match.revivalWindowOpen(), true, '窗口开了');
  const view = match.revivalView();
  assert.equal(view.costPer, 5, '第一次：每人 5');
  assert.deepEqual(view.targets[0].need.sort(), ['p1', 'p2'], '需要其余全体队友同意');

  match.reviveConsent(match.players.get('p1'), 'p3');
  assert.equal(match.teamReserve, 100, '票没到齐不落账');
  assert.equal(match.revivalView().targets[0].agreed.length, 1, '记了一票');

  match.reviveConsent(match.players.get('p2'), 'p3');
  assert.equal(match.teamReserve, 90, '全票到齐：池子扣 每人 5 × 2 人');
  assert.equal(match.players.get('p3').alive, true, '被救回来');
  assert.equal(match.players.get('p3').lp, 1, '带 1 点生命值');
  assert.equal(match.revivalCostFor(), 10, '第二次复活每人 10（依次叠加）');
});

test('升级 = 提案 + 队友同意（满级 4）；池子不够就不发提案', () => {
  const { match } = makeHost();
  match.seat('p1');
  match.seat('p2');
  match.start();
  match.startRound(1);
  match.teamReserve = 100;
  match.teamProjects.storehouse = 0;

  match.handlePackMsg('p1', { channel: 'project', data: { project: 'storehouse' } });
  assert.ok(match.projectVote, '点击 = 发起提案，不直接扣款');
  assert.equal(match.teamProjects.storehouse, 0, '还没升级');
  const voteId = match.projectVote.id;

  match.handlePackMsg('p2', { channel: 'vote', data: { id: voteId, approve: true } });
  assert.equal(match.teamProjects.storehouse, 1, '全员同意后升级');
  assert.equal(match.teamReserve, 96, '从共享池扣 4');
  assert.equal(match.projectVote, null, '提案关闭');

  match.teamProjects.storehouse = 4;
  assert.equal(match.econBuyProject(match.players.get('p1'), 'storehouse').error, 'MAX_LEVEL', '满级 4 不再受理');
});
