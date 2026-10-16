// test/helpers/officialManifest2.js — 「我想要什么能力」→ **上游 0.3.0 的 manifest 2 词表**。
//
// 官方档的 manifest 不再由调用方直接写能力名（那是我上一版 provisional 的做法，且那些 api 名官方**根本不存在**）。
// 现在声明面是 0.3.0 的真词表：`manifest:2` / `class` / `api` / `permissions`(闭集) / `entry{sim,meta,client,server}` /
// `slots` / `overrides`；能力由这些**派生**。这组构造器把「意图」收在一处，测试只表达意图。

/** 一个最小合法 manifest 2。 */
export const m2 = (id, extra = {}) => ({
  manifest: 2, id, name: id, version: '1.0.0', api: 1,
  ...extra,
});

/** `class: 'content'` 档（声明式数据）。 */
export const contentPlugin = (id, extra = {}) => m2(id, { class: 'content', permissions: ['data.patch'], data: ['items.json'], ...extra });

/** `class: 'script'` + `sim.code`：战斗内代码（含 kits 注册）。 */
export const simPlugin = (id, extra = {}) => m2(id, { class: 'script', permissions: ['sim.code'], entry: { sim: 'plugin.mjs' }, ...extra });

/** `class: 'script'` + `sim.code` + `meta.code`（+ `overrides` 白名单）。 */
export const metaPlugin = (id, registers = [], extra = {}) => m2(id, {
  class: 'script', permissions: ['sim.code', 'meta.code'], entry: { sim: 'plugin.mjs', meta: 'plugin.mjs' },
  ...(registers.length ? { overrides: [...registers] } : {}), ...extra,
});

/** `class: 'ui'`：客户端面板（`entry.client` + `slots`）。 */
export const uiPlugin = (id, slots = ['screen.game.hud'], extra = {}) => m2(id, {
  class: 'ui', permissions: ['ui.frame'], entry: { client: 'panel/hud.js' }, slots: [...slots], ...extra,
});

/** `class: 'trusted'`：宿主进程内代码（默认要求逐玩家同意）。 */
export const trustedPlugin = (id, extra = {}) => m2(id, { class: 'trusted', permissions: ['trusted.server'], entry: { server: 'plugin.mjs' }, ...extra });
