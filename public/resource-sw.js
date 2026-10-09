// public/resource-sw.js — 引擎自带的资源 Service Worker（DESIGN §28.13.5，docs/WORKSHOP.md §1.9.4）。
//
// **这是引擎文件，不是包的内容。** 业主裁决（2026-10-10）：根作用域的 SW 能拦截本站点**所有**请求，所以它必须由
// 引擎自带并由引擎维护；包**只声明** `pack.json.assets = { container, manifest, serverPolicy?, verify? }`，
// 绝不能提供 `.js` 去注册它。谁注册、注册成什么作用域，写在 `public/js/resources/worker.js` 里（口径照参考实现：
// 脚本在站点根上，所以 `scope: '/'` 无需 `Service-Worker-Allowed`；`type: 'module'`；`updateViaCache: 'none'`）。
//
// 行为一共三条：
//   * `install` / `activate`：立刻接管（`skipWaiting` + `clients.claim`），不让玩家为一次部署刷新两次；
//   * `fetch`：**只看** `GET` 且路径落在 `/assets|/fonts/*` 或 `/media/*` 的请求，其它一律不管（放行给网络）；
//   * 命中的那些交给 `handleResourceRequest` —— 它只用**本地校验过的缓存**回答，命不中回 **412，绝不回源**
//     （`public/js/resources/service.js` 的注释解释了为什么这两件事是一体的）。
//
// 缺省不启用：`welcome.modAssets` 里没有声明时，页面根本不 `import` 资源流程，也就不会注册这个文件。

import { isResourcePath } from './js/resources/common.js';
import { handleResourceRequest } from './js/resources/service.js';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  let url;
  try { url = new URL(event.request.url); } catch { return; }
  if (!isResourcePath(url.pathname)) return;
  event.respondWith(handleResourceRequest(event.request));
});
