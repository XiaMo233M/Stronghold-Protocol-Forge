// public/js/resources/release.js — 自愈阀：本引擎的 SW 不再被需要时，把控制权交回给页面（DESIGN §28.13.5 的补丁）。
//
// **为什么需要它**（业主现象：升级后图标 / 立绘 / 3D 场景不出来，「强刷即好」）：服务器只在包声明了 `assets` 时
// 才在 `welcome` 里带 `modAssets`，页面也只在那一刻注册 SW（`public/js/main.js` 的注册点）。可是「换一次部署」不
// 保证服务器还会声明 assets：包被删掉、`serverPolicy` 改回 `serve`、或者换回不带资源包的发行包 —— 这时新页面
// **不再注册**，而浏览器里那个根作用域 SW 还控制着页面。它对 `/assets|/fonts|/media` 只从「本地导入过的字节」
// 回答，索引里没有的一律 412 且**绝不回源**（`public/js/resources/service.js`）。于是整个素材面全空，只有强刷 /
// 清站点数据才解除 —— 一次注册变成了永久劫持。
//
// **这一格的分寸**：只注销**本引擎**那条注册（`scriptURL` 以 `SW_URL` 收尾），只删**本引擎**家族的缓存
// （`CACHE_PREFIX` 开头）。别人的 SW 与别人的缓存一个字节都不碰：本页面并不知道它们是谁的，也没有权力替玩家做
// 决定。（`CacheStorage` 里剩下的几百 MB 是本引擎自己写进去的，删掉它正是这个函数存在的理由。）
//
// 它是**动态** import 进来的（`main.js` 里就挂在注册点旁边）：干净环境（从没装过 SW）下这个文件根本不进浏览器，
// 于是「服务器不声明 assets ⇒ 无新请求、无新 DOM、无新全局」那条不变量仍是结构性的，而不是靠几个 `if` 拦出来的。
//
// 失败不抛：页面上少清一样东西不是「进不了游戏」（诊断记录里留一行就够，调用方自己决定说不说）。

import { CACHE_PREFIX, SW_URL } from './common.js';

/** 一条给日志用的错误描述（`Error` 取 message，别的原样转字符串）。 */
const describe = (err) => (err && err.message ? String(err.message) : String(err));

/**
 * 交回客户端控制权：注销本引擎的 SW 注册，并删掉本引擎家族的**全部**缓存（含当前那一个）。
 *
 * 幂等：没有注册、没有缓存、没有 `CacheStorage` 时都只是什么都做不了，返回值如实说明做了什么。
 * @param {{ nav?: any, caches?: CacheStorage }} [deps] 依赖注入（测试给桩，浏览器用真的）
 * @returns {Promise<{ hadController: boolean, unregistered: string[], deletedCaches: string[], failed: string[] }>}
 *   `unregistered` 是被注销注册的 scope，`deletedCaches` 是删掉的缓存名，`failed` 是每一步失败的描述。
 */
export async function releaseResourceWorker({ nav = globalThis.navigator?.serviceWorker, caches: storage = globalThis.caches } = {}) {
  /** @type {{ hadController: boolean, unregistered: string[], deletedCaches: string[], failed: string[] }} */
  const out = { hadController: !!(nav && nav.controller), unregistered: [], deletedCaches: [], failed: [] };
  if (nav && typeof nav.getRegistrations === 'function') {
    /** @type {any[]} */
    let regs = [];
    try { regs = (await nav.getRegistrations()) || []; } catch (err) { out.failed.push(`getRegistrations: ${describe(err)}`); }
    for (const reg of regs) {
      // 三条命（active / waiting / installing）任一条是本引擎的脚本，这条注册就是本引擎的。
      const worker = reg.active || reg.waiting || reg.installing;
      const url = worker && worker.scriptURL ? String(worker.scriptURL) : '';
      if (!url.endsWith(SW_URL)) continue;
      try { if (await reg.unregister()) out.unregistered.push(String(reg.scope || SW_URL)); }
      catch (err) { out.failed.push(`unregister: ${describe(err)}`); }
    }
  }
  if (storage && typeof storage.keys === 'function') {
    /** @type {string[]} */
    let names = [];
    try { names = (await storage.keys()) || []; } catch (err) { out.failed.push(`caches.keys: ${describe(err)}`); }
    for (const name of names) {
      if (typeof name !== 'string' || !name.startsWith(CACHE_PREFIX)) continue; // 别人的缓存：不碰
      try { if (await storage.delete(name)) out.deletedCaches.push(name); }
      catch (err) { out.failed.push(`caches.delete: ${describe(err)}`); }
    }
  }
  return out;
}
