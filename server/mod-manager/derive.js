// server/mod-manager/derive.js — 由 ActivationPlan 的派生物推出运行时用的**小结构**。
//
// 存在的理由（DESIGN 重构计划 §一 原则 2）：这些结构原先在 `server/lobby.js` 的构造器里**就地**算出来，
// 于是「哪些通道开着」有两个读者、两处实现，谁漏一处就是「包照旧加载、只是它的话递不进来」。
// 收敛成纯函数之后，语义由 `test/modDerive.test.js` 钉住（就地循环钉不住），`lobby.js` 只调用。
//
// 边界：这里**只搬运**，绝不判断「包在不在」——那个判断只属于 `plan.activatedSet`
// (`isActivated(plan, id)`)。传进来的 `panels` / `serverChannels` 本来就来自**裁后**的装载结果。

/**
 * `<包id>` → 这个包声明过的**客户端可发**通道集合。声明人是**面板**
 * （`client.panels[].messages`，docs/WORKSHOP.md §1.9.6），所以这里不存在第二份真相。
 * 形状坏的条目**跳过**（就地版本原本就是 `continue`）。
 * @param {Array<{ pack?: string, messages?: string[] }>|undefined} panels
 * @returns {Map<string, Set<string>>}
 */
export function derivePackChannels(panels) {
  const map = new Map();
  for (const panel of (Array.isArray(panels) ? panels : [])) {
    if (!panel || typeof panel.pack !== 'string' || !Array.isArray(panel.messages)) continue;
    if (!map.has(panel.pack)) map.set(panel.pack, new Set());
    for (const channel of panel.messages) map.get(panel.pack).add(channel);
  }
  return map;
}

/**
 * `<包id>` → 这个包的服务端模块声明过的**可投递进对局**的通道集合（`server.modules[].channels`，
 * DESIGN §28.23）。这里是一次**浅拷贝**（每个包的集合重新建，避免与装载结果共享可变 Set）。
 * 非 Map 输入 ⇒ 空表（原本就是 `instanceof Map` 判据）。
 * @param {Map<string, Iterable<string>>|undefined} serverChannels
 * @returns {Map<string, Set<string>>}
 */
export function deriveServerChannels(serverChannels) {
  const map = new Map();
  if (serverChannels instanceof Map) {
    for (const [packId, channels] of serverChannels) {
      if (typeof packId === 'string' && channels) map.set(packId, new Set(channels));
    }
  }
  return map;
}
