// public/js/resources/worker.js — 注册引擎自带的 Service Worker（DESIGN §28.13.5）。
//
// **谁注册**：引擎（本文件），而且只在 `welcome.modAssets` 真的带来了声明时才注册。包**不能**注册它 —— 业主裁决
// （2026-10-10）：根作用域的 SW 能拦截该站点所有请求，那是把客户端控制权交出去；引擎自带、包只声明。
//
// **作用域口径**（照参考实现的原样）：
//   * 脚本在站点**根**上（`/resource-sw.js`），所以它自己的最大作用域就是 `/`，`scope: '/'` 无需
//     `Service-Worker-Allowed` 响应头即可通过。把脚本搬进子目录时那个头才成为必需 —— 这条写进 docs/DEPLOY.md。
//   * `type: 'module'`：SW 与页面共用 `public/js/resources/common.js`（`shared/media.js` 的扩展名表只此一份）。
//   * `updateViaCache: 'none'`：SW 脚本本身绝不从 HTTP 缓存里取 —— 否则一次部署要等缓存过期才会到达浏览器。
//     （`server/http/files.js` 对 `.js` 已经回 `no-cache`，这是第二道。）
//
// **等待策略**：注册是**后台**的，返回值只是「已注册」，绝不作为入口放行的前置条件 —— 一个还没被 SW 接管的页面
// 只是暂时用不到本地缓存，不是「进不了游戏」。参考实现把这一点写在注释里，我们照抄这个姿态。

import { SW_URL, checkAbort } from './common.js';

/**
 * 注册 SW 并（在后台）等它接管本页。
 * @param {AbortSignal} [signal]
 * @param {ServiceWorkerContainer} [nav] `navigator.serviceWorker`（测试注入）
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} 本页是否已被这个 SW 接管
 */
export async function activateResourceWorker(signal, nav = globalThis.navigator?.serviceWorker, timeoutMs = 15000) {
  checkAbort(signal);
  if (!nav || typeof nav.register !== 'function') {
    throw new Error('当前浏览器不支持 Service Worker，本地资源缓存不可用');
  }
  let timer;
  let onChange;
  let onAbort;
  let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal?.reason || new Error('资源缓存服务启动已取消'));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new Error('资源缓存服务启动超时，请刷新页面重试')), timeoutMs);
      Promise.resolve()
        .then(() => nav.register(SW_URL, { type: 'module', scope: '/', updateViaCache: 'none' }))
        .then(() => {
          if (settled) return; // 超时 / 取消之后迟到的注册，不许再装监听器
          checkAbort(signal);
          onChange = () => { if (nav.controller?.scriptURL?.endsWith(SW_URL)) resolve(true); };
          nav.addEventListener('controllerchange', onChange);
          onChange(); // 已经接管（同一个 SW 的后续页面）时立刻成立
        })
        .catch(reject);
      if (signal?.aborted) onAbort();
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    if (onChange) nav.removeEventListener('controllerchange', onChange);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
