// server/mod-manager/eventRouter.js — 进站消息的**分流骨架**（DESIGN 重构计划 Phase 5 的 `eventRouter.js`）。
//
// 现状：`server/net.js` 是**唯一**的 WebSocket 入口，`server.preDispatch` 钩子排在最前面、按固定顺序、连接级实例、
// hook 失败不拖垮其它连接 —— 这些优点**全部保留**。重构要加的是：进站消息先**分流**成有名字的事件种类，
// 再交给对应的适配器，而不是让每种扩展自己去认 `msg.type`。
//
//   { kind: 'room.mod.handshake' | 'resource.admission' | 'sdk.intercept' | 'pack.msg' | 'plain', type }
//
// 本文件是**纯**的：不碰网络、不读全局、不 import net.js。它只回答两件事 ——
// 「这条消息属于哪一类」与「按什么顺序交给谁」。接线进 `net.js` 是 Phase 5 的后续（要 CI 才能验）。

/** 事件种类闭集（新增种类必须具名加在这里，避免「随手一个新字符串」）。 */
export const EVENT_KINDS = Object.freeze(['room.mod.handshake', 'resource.admission', 'sdk.intercept', 'pack.msg', 'plain']);

/** C2S 类型 → 种类。没列出的走 `plain`（默认不改变任何既有行为）。 */
export const KIND_BY_TYPE = Object.freeze({
  'room.create': 'room.mod.handshake',
  'room.join': 'room.mod.handshake',
  'room.queue': 'room.mod.handshake',
  'resource.challenge.request': 'resource.admission',
  'resource.proof': 'resource.admission',
  'resource.reset': 'resource.admission',
  'pack.msg': 'pack.msg',
});

/**
 * 一条进站消息属于哪一类。**纯函数**，不认识的消息 ⇒ `plain`（保守：绝不把未知消息当扩展事件）。
 * @param {unknown} msg
 * @returns {{ kind: string, type: string|null }}
 */
export function classifyEvent(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const type = typeof m.type === 'string' ? m.type : null;
  const kind = (type && KIND_BY_TYPE[type]) || 'plain';
  return { kind, type };
}

/**
 * 建一个路由器。
 *
 * 拦截器形状：`{ pack, id, kinds?: string[]|null, types?: string[]|null, fn(msg, ctx) }`。
 * `fn` 返回 `true` ⇒ 这条消息**已被处理**，后面的拦截器不再看（与 `preDispatch` 的短路语义一致）。
 * `fn` 抛异常 ⇒ **只记日志**，后面的拦截器照跑 —— 一个包的钩子不该把别人的消息一起吃掉。
 *
 * @param {{ interceptors?: Array<object>, log?: any }} [opts]
 */
export function createEventRouter({ interceptors = [], log = null } = {}) {
  const list = Array.isArray(interceptors) ? interceptors.filter((i) => i && typeof i.fn === 'function') : [];
  return {
    get size() { return list.length; },
    /**
     * 分流 + 按固定顺序派发。
     * @returns {{ kind: string, type: string|null, handled: boolean, results: Array<{pack:string,id:string,ok:boolean,error?:any}> }}
     */
    route(msg, ctx = {}) {
      const { kind, type } = classifyEvent(msg);
      const results = [];
      let handled = false;
      for (const it of list) {
        if (Array.isArray(it.kinds) && !it.kinds.includes(kind)) continue;
        if (Array.isArray(it.types) && !(type && it.types.includes(type))) continue;
        try {
          const r = it.fn(msg, { ...ctx, kind, type });
          results.push({ pack: it.pack || '', id: it.id || '', ok: true });
          if (r === true) { handled = true; break; }
        } catch (e) {
          results.push({ pack: it.pack || '', id: it.id || '', ok: false, error: e });
          log?.warn?.(`[event-router] ${it.pack || '?'}/${it.id || '?'} threw on ${type || '(no type)'}: ${e && e.message ? e.message : e}`);
        }
      }
      return { kind, type, handled, results };
    },
  };
}
