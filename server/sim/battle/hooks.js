// server/sim/battle/hooks.js — Battle methods: the hook bus (on / off / offOwner / emit, the MAX_HOOK_DEPTH guard and
// its chain diagnostics), the timers (after / every, run at the start of each tick), the isolation of content
// callbacks (_safe, _handlerError: a failing handler is skipped and counted; repeated engine errors end the battle as a
// timeout), and the per-pack CALL BUDGET (DESIGN §28.52).
//
// 调用预算（`pack.json.callBudget`）为什么落在这里而不是某一端：**这个文件在 Node 与浏览器里是同一段字节**
// （`server/sim` 两端共用），而预算的计数与回滚**必须**两端同规则 —— 两端若在不同的调用次数上回滚，之后的状态就
// 分叉了，而「同一份摘要 ⇒ 同一份行为」正是这个中间层存在的理由。规则本身（缺省值、`packCallAllowed`、回滚时记的
// 那笔错）住在 `shared/callBudget.js`；这里只做「按包记账 + 回滚」。
//
// 三个刻意的形状选择：
//   * **只盖 `pack` 字段，不动 `owner`**。既有的 `owner` 语义（`offOwner(unit)` 撤掉一个干员的全部 hook 与计时器，
//     `professions.js` / `spec.js` 的 `owner: 'lpMeter'`）一个字节都不改；预算账记在**另一个**字段上。
//   * **没声明预算的包一行都不多跑**：`_packBudget` 里没有这个包 ⇒ `_chargePackCall` 立刻返回 `true`。于是
//     module 档（内容文件 + kit 白名单 + 全能力）与今天逐字节相同。
//   * **回滚复用既有的那一套清扫**（与 `offOwner` 同一段循环，键从 `owner` 换成 `pack`），并跳过被撤 buff 的
//     `onRemove`：正在拆的就是这个包自己的东西，让它的回调再跑一轮只会给它一次在回滚里继续动手的机会。
// Installed on Battle.prototype by server/sim/Battle.js (a method container: never instantiated; `this` is the battle).

import { TICK, MAX_INTERNAL_ERRORS, MAX_HOOK_DEPTH } from '../constants.js';
import { callBudgetExhaustedReason, callBudgetOwner, packCallAllowed } from '../../../shared/callBudget.js';

let hookSeq = 0;

let schedSeq = 0;

export class BattleHooks {
  // =============================================================================================================
  // hook bus

  on(name, fn, opts = {}) {
    if (typeof fn !== 'function') return null;
    // `pack`：这个 hook 属于哪个包（装载期由 `_withPackScope` 盖，缺省 null = 引擎自己的 / 官方内容）。
    const h = { name, fn, priority: Number(opts.priority) || 0, owner: opts.owner ?? null, pack: opts.pack ?? this._packScope ?? null, seq: ++hookSeq, removed: false, once: !!opts.once };
    const list = this._hooks[name] ?? (this._hooks[name] = []);
    let i = list.length;
    while (i > 0 && list[i - 1].priority < h.priority) i--; // loop-cap: hook list length
    list.splice(i, 0, h);
    return h;
  }

  off(nameOrHandle, fn) {
    if (nameOrHandle && typeof nameOrHandle === 'object') {
      const h = nameOrHandle;
      h.removed = true;
      const list = this._hooks[h.name];
      if (list) {
        const i = list.indexOf(h);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) delete this._hooks[h.name];
      }
      return;
    }
    const list = this._hooks[nameOrHandle];
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) if (!fn || list[i].fn === fn) { list[i].removed = true; list.splice(i, 1); }
    if (!list.length) delete this._hooks[nameOrHandle];
  }

  /** Remove every hook and scheduled callback registered with `owner`. */
  offOwner(owner) {
    for (const name of Object.keys(this._hooks)) {
      const list = this._hooks[name];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) { list[i].removed = true; list.splice(i, 1); }
      if (!list.length) delete this._hooks[name];
    }
    for (const s of this._sched) if (s.owner === owner) s.cancelled = true;
  }

  hasHook(name) { return !!this._hooks[name]; }

  emit(name, ctx) {
    const list = this._hooks[name];
    if (!list) return ctx;
    // Recursion guard: handlers that re-trigger their own event (damaged → dealDamage → damaged …) would otherwise
    // recurse until a stack overflow, whose depth (and thus the outcome) depends on the machine — not deterministic.
    if (this._emitDepth >= MAX_HOOK_DEPTH) {
      this._handlerError(`hookDepth:${name}`, null, new Error(`hook nesting deeper than ${MAX_HOOK_DEPTH}; handlers skipped — ${this._chain(name)}`));
      return ctx;
    }
    const arr = list.length === 1 ? [list[0]] : list.slice();
    const d = this._emitDepth++;
    this._frameCtx[d] = ctx;
    try {
      for (const h of arr) {
        if (h.removed) continue;
        // 预算：这个包这一局还能不能被调。`false` = 不放行，而且它**已经**被回滚掉了（不是这里现拆）。
        if (h.pack && !this._chargePackCall(h.pack)) continue;
        this._frameName[d] = name;
        this._frameOwner[d] = h.owner;
        // 回调里新挂的 hook / 计时器 / buff 也归这个包（作用域会传下去），否则「在一个被预算限制的回调里
        // 再注册一批回调」就是一条自造的第二本账。
        const prevPack = this._packScope;
        if (h.pack) this._packScope = h.pack;
        try { h.fn(ctx, this); } catch (e) { this._handlerError(`hook:${name}`, h.owner, e); } finally { this._packScope = prevPack; }
        if (h.once) this.off(h);
        if (ctx && ctx.stopPropagation) break;
      }
    } finally {
      this._emitDepth--;
    }
    return ctx;
  }

  /**
   * The open hook/callback frames (outermost first) — names the loop when the nesting guard trips, e.g.
   * "chain: hit(enemy_1430_lrrook) > damaged(chess_char_3_18_a) > hit(enemy_1430_lrrook) > … > damaged".
   */
  _chain(last) {
    const id = (u) => (u && typeof u === 'object' ? (u.defId ?? u.name ?? '?') : u == null ? '' : String(u));
    const lab = (i) => {
      const o = this._frameOwner[i];
      let who = id(o);
      const c = this._frameCtx[i];
      if (!who && c && typeof c === 'object') { // global handler: show the units of the event instead
        const a = c.source ?? c.attacker ?? c.killer ?? null, t = c.target ?? c.unit ?? c.victim ?? c.enemy ?? null;
        who = a || t ? `${id(a)}→${id(t)}` : '';
      }
      return `${this._frameName[i]}${who ? `(${who})` : ''}`;
    };
    const n = this._emitDepth;
    const parts = [];
    for (let i = 0; i < Math.min(n, 4); i++) parts.push(lab(i));
    if (n > 12) parts.push('…');
    for (let i = Math.max(4, n - 8); i < n; i++) parts.push(lab(i));
    parts.push(last);
    return `chain: ${parts.join(' > ')}`;
  }

  // =============================================================================================================
  // scheduling

  after(seconds, fn, opts = {}) {
    const s = { due: this.time + Math.max(0, Number(seconds) || 0), fn, owner: opts.owner ?? null, pack: opts.pack ?? this._packScope ?? null, interval: 0, seq: ++schedSeq, cancelled: false, holdsBattle: !!opts.holdsBattle };
    s.cancel = () => { s.cancelled = true; };
    this._sched.push(s);
    return s;
  }

  every(seconds, fn, opts = {}) {
    const iv = Math.max(TICK, Number(seconds) || TICK);
    const s = { due: this.time + (opts.immediate ? 0 : iv), fn, owner: opts.owner ?? null, pack: opts.pack ?? this._packScope ?? null, interval: iv, seq: ++schedSeq, cancelled: false, count: 0, holdsBattle: false };
    s.cancel = () => { s.cancelled = true; };
    this._sched.push(s);
    return s;
  }

  _runScheduled() {
    if (!this._sched.length) return;
    const now = this.time + 1e-9;
    let due = this._sched.filter((s) => !s.cancelled && s.due <= now);
    if (!due.length) { if (this._sched.some((s) => s.cancelled)) this._sched = this._sched.filter((s) => !s.cancelled); return; }
    due.sort((a, b) => a.due - b.due || a.seq - b.seq);
    for (const s of due) {
      if (s.cancelled) continue;
      if (s.interval > 0) {
        let n = 0;
        while (s.due <= now && !s.cancelled && n++ < 8) { // loop-cap: battle.every at most 8 per tick
          // 预算由 `_safe` 记（它是每个内容回调的唯一入口 —— 在这里再记一次就是同一趟调两个数）。
          // 到顶时 `_rollbackPack` 已经把这个计时器 `cancelled` 掉，所以循环条件自己会停。
          s.count++;
          this._safe(() => s.fn(this, s), 'every', s.owner, s.pack);
          s.due += s.interval;
        }
        if (s.due <= now) s.due = this.time + s.interval;
      } else {
        s.cancelled = true;
        this._safe(() => s.fn(this, s), 'after', s.owner, s.pack);
      }
    }
    this._sched = this._sched.filter((s) => !s.cancelled);
  }

  // =============================================================================================================
  // 每局每插件的调用预算（DESIGN §28.52）
  //
  // 一本账 = 一个声明了 `pack.json.callBudget` 的包。规则本身（缺省 8000、什么算一次、回滚记什么错）住在
  // `shared/callBudget.js`；这里只负责「按包累计、到顶就把这个包整体拆掉」。

  /**
   * 开账：装载期一次（`server/sim/content/index.js` 跑每个包的 `install(battle)` 之前）。**没声明的包不会调它**
   * —— 这就是「按档启用」的落点，也是 module 档一行都不多跑的原因。
   * @param {string} packId @param {number} max 生效上限（`pack.json.callBudget.max`）
   */
  _declarePackBudget(packId, max) {
    if (typeof packId !== 'string' || !packId) return null;
    if (!Number.isInteger(max) || max < 1) return null;
    const entry = Object.freeze({ max });
    this._packBudget.set(packId, entry);
    return entry;
  }

  /**
   * 在这个包的作用域里跑一段：`on` / `after` / `every` / `addBuff` 建的东西因此都带上 `pack` 标记。
   * @template T @param {string} packId @param {() => T} fn @returns {T}
   */
  _withPackScope(packId, fn) {
    const prev = this._packScope;
    this._packScope = packId;
    try { return fn(); } finally { this._packScope = prev; }
  }

  /**
   * 记账：这一次调用放不放行。`false` = 不放行，**并且这个包已经被回滚了**（调用方只管跳过，不用再收尾）。
   * @param {string} packId
   */
  _chargePackCall(packId) {
    const entry = this._packBudget.get(packId);
    if (!entry) return true;                       // 没声明预算 ⇒ 不是沙箱档的包，一行都不多跑
    if (this._packRolled.has(packId)) return false; // 已经拆过了：它的东西都不在了，不再记第二次错
    if (!packCallAllowed(this._packUsed.get(packId) ?? 0, entry.max)) {
      this._rollbackPack(packId, entry);
      return false;
    }
    this._packUsed.set(packId, (this._packUsed.get(packId) ?? 0) + 1);
    return true;
  }

  /**
   * 回滚一个包：撤掉它**全部** hook 与计时器、撤掉它**标的** buff、记一笔点名到插件 id 的错。
   *
   * 与 `offOwner` 是同一套清扫（键从 `owner` 换成 `pack`），刻意不新造第二种「拆掉一个来源」的写法 —— 两份写法
   * 就是一个「撤干净了没有」的问题有两个答案。
   * @param {string} packId @param {{ max: number }} entry
   */
  _rollbackPack(packId, entry) {
    if (this._packRolled.has(packId)) return;
    this._packRolled.add(packId);
    for (const name of Object.keys(this._hooks)) {
      const list = this._hooks[name];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].pack === packId) { list[i].removed = true; list.splice(i, 1); }
      if (!list.length) delete this._hooks[name];
    }
    for (const s of this._sched) if (s.pack === packId) s.cancelled = true;
    // 撤标了记号的 buff。**不跑 `onRemove`**：正在拆的就是这个包自己的东西，而这个包的回调已经被停掉了 ——
    // 让它在回滚途中再跑一轮，只会给它一次在被拆的同时继续动手的机会。
    for (const u of this.units) {
      if (!u || !u.buffs || !u.buffs.length) continue;
      for (let i = u.buffs.length - 1; i >= 0; i--) if (u.buffs[i].pack === packId) this._removeBuffAt(u, i, false);
    }
    this._handlerError(callBudgetOwner(packId), null, new Error(callBudgetExhaustedReason(packId, entry.max)));
  }

  // =============================================================================================================
  // callback isolation and errors

  /** Run a content callback (skill/buff/projectile/timer/install) isolated from errors; shares the hook depth guard.
   *  `pack` = 这个回调属于哪个包（预算账就是按它记的；`null` = 引擎自己的 / 官方内容，永远不记账）。 */
  _safe(fn, label, owner = null, pack = null) {
    const p = pack ?? this._packScope ?? null;
    if (p && !this._chargePackCall(p)) return undefined;
    if (this._emitDepth >= MAX_HOOK_DEPTH) {
      this._handlerError(`hookDepth:${label}`, owner, new Error(`callback nesting deeper than ${MAX_HOOK_DEPTH}; skipped — ${this._chain(label)}`));
      return undefined;
    }
    const d = this._emitDepth++;
    this._frameName[d] = label;
    this._frameOwner[d] = owner;
    this._frameCtx[d] = null;
    const prevPack = this._packScope;
    if (p) this._packScope = p;
    try { return fn(); } catch (e) { this._handlerError(label, owner, e); return undefined; } finally { this._emitDepth--; this._packScope = prevPack; }
  }

  _handlerError(label, owner, e, internal = false) {
    this.errorCount++;
    const who = owner && owner.defId ? owner.defId : (owner && owner.name) || '';
    const key = `${label}|${who}|${e && e.message}`;
    if (!this._errKeys.has(key)) {
      this._errKeys.add(key);
      if (this.errors.length < 100) this.errors.push({ label, who, message: String(e && e.message), stack: e && e.stack });
      if (this.opts.quiet !== true) this.logger.error?.(`[sim] ${label}${who ? ' (' + who + ')' : ''} failed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    }
    // Content handler errors are isolated (the handler is skipped, the battle continues). Repeated *engine*
    // errors mean the field state is suspect: force-end it as a timeout (DESIGN §11).
    if (internal) {
      this.internalErrorCount = (this.internalErrorCount ?? 0) + 1;
      if (this.internalErrorCount > MAX_INTERNAL_ERRORS && !this.finished && !this._forcing) {
        this._forcing = true;
        try { this.forceEnd('timeout'); } catch { this._hardFinish('timeout'); }
      }
    }
  }

  _internalError(label, e) { this._handlerError('internal:' + label, null, e, true); }
}
