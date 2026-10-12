// mod-xie/server/mod.mjs — 促融共竞 · Forge 工坊包的服务端那一半。
//
// 与 v1（自研安装器 + `boot.template.mjs` 猴补丁）的差别**只有接缝的落点**：
//   v1 = 包装引擎原型（Match / PlayerState / GameData / Lobby）+ 自加 5 条 C2S + 往 index.html 插脚本；
//   v2 = 把自己挂成 `MatchClass` 包装器（DESIGN §28.14：引擎建对局时按包 id 次序层层套上）+ 在声明过的包通道上
//        接收玩家的操作（DESIGN §28.23）。引擎文件依旧一个字节都不改，而且不再需要安装器 / 锚点清单：
//        包的身份 = 内容哈希（管理器算），房间级启停 = `room.create.modIds`（W-B），两端对齐 = W-D。
//
// 两条装载纪律：
//   * **房间集合自门控**：`matchClass` 是进程级的（每个对局都会被套上），所以本类的每个覆写先看 `this.mods`
//     （房间的集合摘要）里有没有本包 —— 普通房间一个分支都不进，与上游逐字节相同（W-B）。
//   * **实例级包装**：引擎在构造之后、在 `settle` / `_quit` / `_sendPrivate` 内部**直接调 PlayerState 的方法**，
//     类级覆写够不到那几个点；这几处改为对**这一局的** PlayerState 实例挂一层自有属性（不是原型 ——
//     别的对局一个字节不受影响）。判据与 v1 的 `PlayerState.prototype` 包装逐条相同。

import { MatchEconomy } from './economy.mjs';
import { MatchRevival } from './revival.mjs';
import { PHASE } from './common.mjs';
import { teamEconomyFor, revivalFor } from './rules.mjs';
import { modXieBotEconStart, modXieBotEconEnd } from './botEcon.mjs';

/** 本包的 id：`pack.json` 的 id、房间集合里点名的名字、面板通道的前缀，都必须是它。 */
export const PACK_ID = 'mod-xie';

/** 面板能发、对局能收的通道（与 `pack.json` 的 `client.panels[].messages` / `server.modules[].channels` 逐字一致）。 */
export const XIE_CHANNELS = Object.freeze(['borrow', 'answer', 'project', 'vote', 'relief', 'revive']);

/** 通道 → v1 的意图名（`revive` 不走 `econIntent`，由 revival 容器接）。 */
const CHANNEL_INTENT = Object.freeze({
  borrow: 'econ.borrow',
  answer: 'econ.answer',
  project: 'econ.project',
  vote: 'econ.vote',
  relief: 'econ.relief',
});

/** v1 吞掉的那两条上游提示（真淘汰时照常播报，逐字匹配 —— v1 审计 F10）。 */
const HELD_TOAST = '你的目标生命值耗尽，已被淘汰';
const HELD_TICKER = '{name}博士的目标生命值已耗尽';

/** 这个对局跑的是不是本 MOD 的房间（W-B：房间点名的集合里有本包；房间没声明集合时跑进程集合 ⇒ 在）。 */
export function isXieRoom(mods) {
  return !!(mods && Array.isArray(mods.packs) && mods.packs.some((p) => p && p.id === PACK_ID));
}

/** 把 v1 的方法容器装到子类原型上（与引擎自己装 mixin 的同款写法；同名即抛，不静默覆盖 —— v1 审计 F17）。 */
export function installMixin(target, part) {
  for (const key of Reflect.ownKeys(part.prototype)) {
    if (key === 'constructor') continue;
    if (Object.hasOwn(target.prototype, key)) {
      throw new Error(`mod-xie: ${target.name}.${String(key)} is already defined — refusing to shadow it`);
    }
    Object.defineProperty(target.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key));
  }
}

export function registerServer(host) {
  host.matchClass((Base) => {
    class ModXieMatch extends Base {
      constructor(opts) {
        super(opts);
        this.__xieActive = isXieRoom(this.mods);
        this.__xieReady = false;
      }

      // ---- 一次性初始化：v1 的懒门（`Match.prototype.start`）→ 子类的 `start` 覆写。构造器里 `this.gd` 未必就绪，
      //      `start` 是引擎保证会到的那一步，且仍在第一次视图 / 第一次回合之前。
      start() {
        if (this.__xieActive && !this.__xieReady) {
          this.__xieReady = true;
          this.__xieInit();
        }
        return super.start();
      }

      __xieInit() {
        this.teamEcon = teamEconomyFor(this.difficulty);      // 官方 mode 记录里没有 MOD 的规则块，这里合成
        this.revivalRuleInit = revivalFor(this.difficulty);
        this.econInit();
        this.revivalInit();
        for (const ps of this.players.values()) this.__xieWrapSeat(ps);
      }

      /** 席位级包装（只此一局；见文件头「实例级包装」）。 */
      __xieWrapSeat(ps) {
        if (!ps || ps.__xieWrapped) return;
        ps.__xieWrapped = true;
        const m = this;
        if (typeof ps.eliminate === 'function') {
          const orig = ps.eliminate.bind(ps);
          ps.eliminate = function xieEliminate(round) {
            // v1 的 `PlayerState.prototype.eliminate` 包装，判据逐条相同：救援窗口开时把这次淘汰扣住
            // （上游 `eliminate()` 会清空棋盘，而窗口恰恰要保留它）；真淘汰（`_modXieRealElim`）与离开放行。
            if (!m.revivalEnabled || this.pendingDeath) return orig(round);
            if (m.phase !== PHASE.SETTLE) return orig(round);
            if (this.left || m._modXieRealElim) return orig(round);
            if (typeof m.revivalDefer === 'function') { m.revivalDefer(this); return { ok: true }; }
            return orig(round);
          };
        }
        if (ps.isBot && typeof ps.setReady === 'function') {
          const orig = ps.setReady.bind(ps);
          ps.setReady = function xieBotReady(on, ...rest) {
            if (on === true) modXieBotEconEnd(m, ps);           // v1：bot 就绪前再问一次（before）
            return orig(on, ...rest);
          };
        }
        if (typeof ps.privateView === 'function') {
          const orig = ps.privateView.bind(ps);
          ps.privateView = function xiePrivateView() {
            // v1 的 `PlayerState.prototype.privateView` 包装：HUD 的能力探针（关规则集时整个键不出现）
            const view = orig();
            if (view && typeof view === 'object' && typeof m.econPrivateFor === 'function') {
              const econ = m.econPrivateFor(ps);
              if (econ) view.econ = econ;
            }
            return view;
          };
        }
      }

      // ---- 回合循环：phases.js `startRound(r)` 的循环两端（arm 在前、还债在后）。
      //      联合采购的免费刷新**逐玩家**发放（audit P2：v1 只发给第一个 startRound 的玩家）。
      startRound(r) {
        if (this.__xieReady && this.teamEcon && this._xieArmedRound !== r) {
          this._xieArmedRound = r;
          this.econNewRound();
        }
        const out = super.startRound(r);
        if (this.__xieReady && this.teamEcon) {
          const alive = this.alivePlayers();
          // 本轮参与者集合（全员无伤判定的输入；audit P2：不用结算后的存活状态反推）
          this._xieRoundAlive = new Set(alive.map((p) => p.playerId));
          const free = this.teamFreeRefreshes();
          if (free > 0) {
            for (const p of alive) if (p.shop) p.shop.freeRefreshes = Math.max(p.shop.freeRefreshes || 0, free);
          }
          if (alive.length && typeof this.econSettleDebts === 'function') this.econSettleDebts(alive);
        }
        return out;
      }

      // ---- prep.js `endPrep()`：关单 + 逐人结转（必须在 `super` 扫掉资金之前），之后恢复 应急仓储 的留存。
      endPrep() {
        let saved = null;
        if (this.__xieReady && this.teamEcon) {
          if (this._xieClosedRound !== this.round) {
            this._xieClosedRound = this.round;
            if (typeof this.econCloseAll === 'function') this.econCloseAll('prep-end');
          }
          saved = new Map();
          for (const ps of this.alivePlayers()) {
            if (typeof this.econConvertLeftover === 'function') this.econConvertLeftover(ps);
            saved.set(ps.playerId, ps.funds);
          }
        }
        const out = super.endPrep();
        if (saved) {
          for (const ps of this.alivePlayers()) {
            const gd = ps.gd;
            // 坎诺特乐队自己不参与钳制（上游自己的规则）—— 从不把它压回项目的留存额
            if (gd && Array.isArray(gd.leftoverKeptBands) && gd.leftoverKeptBands.includes(ps.bandId)) continue;
            const was = saved.get(ps.playerId);
            if (!Number.isFinite(was)) continue;
            const keep = typeof this.teamKeepFor === 'function' ? this.teamKeepFor(ps) : 0;
            ps.funds = keep > 0 ? Math.min(was, keep) : 0;
            ps.dirty();
          }
        }
        return out;
      }

      // ---- settle.js `settle(plan, uniteResult)`：开头冻结救援名单 + 记兜底计量；结尾判全员无伤。
      settle(plan, uniteResult) {
        if (this.__xieReady) {
          if (this.teamEcon && plan && Array.isArray(plan.helpers) && typeof this.econCoverTally === 'function') {
            this.econCoverTally(uniteResult, plan.helpers.map((p) => p.playerId));
          }
        }
        const out = super.settle(plan, uniteResult);
        if (this.__xieReady && this.teamEcon) {
          const cap = this.gd.lpCapPerRound;
          const charged = (ps) => {
            const fromView = this.uniteResultView?.losses?.[ps.playerId];
            if (Number.isFinite(fromView)) return fromView;
            const r = this.lastResults.get(ps.playerId) || {};
            return Math.min(cap, (r.leaked || []).filter((l) => l && l.counted !== false).length);
          };
          // audit P2：判定用**本轮参与者集合**（`startRound` 的快照）—— 「经济开、救援关」时，本回合刚被淘汰的
          // 队友仍然是这一轮队伍的一员，不该让全队丢掉全员无伤、也不该被排除在判定之外。
          const ids = this._xieRoundAlive || null;
          const team = this.order.filter((ps) => (ids ? ids.has(ps.playerId) : (ps.alive || ps.pendingDeath)));
          if (team.length && team.every((ps) => charged(ps) === 0) && typeof this.econPerfectReward === 'function') {
            this.econPerfectReward();
          }
        }
        return out;
      }

      // ---- settle.js `afterSettle()`：窗口结束 —— 仍然被扣住的席位在这里真淘汰（原因先记下）。
      afterSettle() {
        if (this.__xieReady && this.revivalEnabled && typeof this.revivalFinalizeAll === 'function') this.revivalFinalizeAll();
        return super.afterSettle();
      }

      // ---- intents.js `case 'g.ready'`：人类按就绪即撤回自己未答的请求（v1 审计 F6 的 after 翼）。
      handle(playerId, msg) {
        const out = super.handle(playerId, msg);
        if (!out || out.error) return out;
        if (this.__xieReady && this.teamEcon && msg && msg.t === 'g.ready') {
          const ps = this.players.get(playerId);
          if (ps && ps.ready && !ps.isBot && typeof this.econCloseAllFrom === 'function') this.econCloseAllFrom(playerId, 'ready');
        }
        return out;
      }

      // ---- platform.js `_quit`：中途退出记作淘汰 —— 清该席位的请求 + 发阵亡分红。
      //      上游对已淘汰席位早退，所以「调用前是否还活着」必须先取（v1 审计 F7）。
      _quit(ps) {
        const alive = !!(ps && ps.alive);
        const passedRound = this.phase === PHASE.SETTLE ? this.round + 1 : Math.max(1, this.round);
        const out = super._quit(ps);
        if (this.__xieReady && this.teamEcon && ps && alive) {
          if (typeof this.econCloseAllFor === 'function') this.econCloseAllFor(ps.playerId, 'left');
          if (typeof this.econOnEliminated === 'function') this.econOnEliminated(ps, passedRound);
        }
        return out;
      }

      // ---- bot 座位的经济：排 prep 时「答 + 问」（bot 就绪前的再问一次在席位包装里）。
      scheduleBotPrep(ps, i) {
        if (this.__xieReady && this.teamEcon && ps) modXieBotEconStart(this, ps);
        return super.scheduleBotPrep(ps, i);
      }

      // ---- 被扣住的席位不该收到「已被淘汰」那两条上游提示（真淘汰照常播报）。
      toast(ps, kind, text) {
        if (!this._modXieRealElim && ps && ps.pendingDeath && kind === 'error' && text === HELD_TOAST) return { ok: true };
        return super.toast(ps, kind, text);
      }

      tickerText(text) {
        if (!this._modXieRealElim && this.revival && this.revival.windowOpen && text && text.msgid === HELD_TICKER) return { ok: true };
        return super.tickerText(text);
      }

      // ---- match/views.js `publicView()`：`econ` / `revival` 是客户端的能力探针；官方名单借
      //      `pendingDeath` / `revivalReason` 说「等待救援」而不是「已淘汰」。
      publicView() {
        const view = super.publicView();
        if (!this.__xieReady || !view || typeof view !== 'object') return view;
        if (typeof this.econPublicView === 'function') view.econ = this.teamEcon ? this.econPublicView() : null;
        if (typeof this.revivalView === 'function') view.revival = this.revivalEnabled ? this.revivalView() : null;
        if (this.revivalEnabled && Array.isArray(view.players)) {
          for (const row of view.players) {
            const ps = row && this.players ? this.players.get(row.playerId) : null;
            if (!ps) continue;
            row.pendingDeath = !!ps.pendingDeath;
            row.revivalReason = ps.revivalUnavailableReason || null;
          }
        }
        return view;
      }

      // ---- 包通道 → 对局（DESIGN §28.23）：玩家操作的正门。平台在 `Lobby.packMsg` 的转发之前调用本方法，
      //      且只在本包于房间集合里、通道被声明过、有进行中的对局时。
      //
      //      **返回值 = 消费**：这五个通道是**命令**，它们的后果一律走视图（`m.public` / `m.private`），所以
      //      对局接管它们、平台不再把原始命令广播给全房 —— 私有债务与借款请求因此不会被默认公开，也不会有人
      //      看见一条「被拒绝的请求」的广播。守卫判掉的那些（观战者 / bot / 已离开 / 已结束）同样算消费：那条
      //      命令对任何人都没有意义。
      handlePackMsg(playerId, msg) {
        if (!this.__xieReady || !msg || typeof msg !== 'object' || typeof msg.channel !== 'string') return false;
        if (msg.pack && msg.pack !== PACK_ID) return false;                              // 别的包的消息：不认领
        if (!CHANNEL_INTENT[msg.channel] && msg.channel !== 'revive') return false;   // 不是本包的通道（引擎也不会投）
        const ps = this.players ? this.players.get(playerId) : null;
        if (!ps || ps.isBot || ps.left || this.disposed || this.ended) return true;   // 消费掉，什么也不做
        const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
        try {
          if (msg.channel === 'revive') {
            // v1 的 `g.revive`：消息体自带 round / playerId（`revive()` 自己判回合一致性、捐赠者是否合格、
            // 目标是否可救；认领在应用之前 ⇒ 同一时刻只可能被救一次）
            if (typeof this.reviveConsent === 'function') this.reviveConsent(ps, data.playerId);
          } else {
            const t = CHANNEL_INTENT[msg.channel];
            if (typeof this.econIntent === 'function') {
              // 身份只认平台给的 `playerId`：`data` 里的 `from` / `seat` / `playerId` 一律不展开进意图
              // （`to` 是合法的目标选择；金额 / 项目 / 请求 id 一律由 econ 容器自己校验）
              this.econIntent(ps, { t, to: data.to, amount: data.amount, id: data.id, approve: data.approve, project: data.project });
            }
          }
        } catch (e) {
          this.reportError(`handlePackMsg ${msg.channel}`, e);
        }
        // v1 的 handle 包装在答复后 `flush()`：私有视图（requestIn / owe / refused）立即落地
        try { this.flush(); } catch (e) { this.reportError('flush', e); }
        return true;
      }
    }

    installMixin(ModXieMatch, MatchEconomy);
    installMixin(ModXieMatch, MatchRevival);
    return ModXieMatch;
  });
}
