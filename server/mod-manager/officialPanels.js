// server/mod-manager/officialPanels.js — 官方档的**客户端 UI 面板**桥（Phase 4 的 C 档）。
//
// 与另外三个桥同一条做法：**不新造契约**，产出与 `server/workshop.js loadWorkshopPanels` 逐字同形的条目，
// 于是 `welcome.modPanels`、`/workshop-panels/<包>/<模块>` 的文件表、以及 Lobby 从面板推出来的
// `packChannels`（`pack.msg` 的「收不收」判据）**一行都不用改**。
//
// 这里的职责只有两件（描述符那边只判形状，理由写在 `shared/sdk/descriptor.js` 的那段注释里）：
//   * **槽位**必须落在引擎那张闭枚举 `CLIENT_PANEL_SLOTS` 里（与 Forge 档同一个位置表）；
//   * 模块文件**必须在插件目录之内且真实存在**（URL 只服务登记过的路径，与 kits / battle 同一条纪律）。
// 一条都不满足 ⇒ 这个面板**不进清单**，调用方从 `errors` 里点名。

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_PANEL_SLOTS, WORKSHOP_PANEL_PREFIX } from '../../shared/workshop.js';

const byPack = (a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0);

/**
 * 官方插件的面板清单（与 `loadWorkshopPanels` 的产物同形）。
 * `baseUrl` 必须与 `WORKSHOP_PANEL_PREFIX` 一致（调用方传 `server/workshop.js` 的那个常量）。
 * @param {Array<any>} plugins `loadOfficialPlugins(...)` 的 `plugins`
 * @param {{ baseUrl?: string }} [opts]
 * @returns {{ panels: Array<{ pack: string, id: string, slot: string, module: string, url: string, messages?: string[], styles?: Array<{path:string,url:string}> }>,
 *   errors: Array<{ pack: string, id: string, code: string, reason: string }> }}
 */
export function officialPanels(plugins, { baseUrl = WORKSHOP_PANEL_PREFIX } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const panels = [];
  const errors = [];
  const list = (Array.isArray(plugins) ? plugins : []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of list) {
    const declared = Array.isArray(p?.descriptor?.panels) ? p.descriptor.panels : [];
    if (!declared.length) continue;
    const hash = typeof p.hash === 'string' ? p.hash : '';
    for (const [i, d] of declared.entries()) {
      const id = typeof d.id === 'string' && d.id ? d.id : `${p.id}:${i}`;
      if (!CLIENT_PANEL_SLOTS.includes(d.slot)) {
        errors.push({ pack: p.id, id, code: 'PANEL_UNKNOWN_SLOT', reason: `panel "${id}" declares slot ${JSON.stringify(d.slot)}, which is not one of the ${CLIENT_PANEL_SLOTS.length} client panel slots (${CLIENT_PANEL_SLOTS.join(', ')})` });
        continue;
      }
      const abs = path.join(p.dir, ...d.module.split('/'));
      const inside = abs === p.dir || abs.startsWith(p.dir + path.sep);
      if (!inside || !fs.existsSync(abs)) {
        errors.push({ pack: p.id, id, code: 'PANEL_BAD_MODULE', reason: `panel "${id}" module ${JSON.stringify(d.module)} is not a readable file inside the plugin` });
        continue;
      }
      const fileUrl = (rel) => `${base}/${encodeURIComponent(p.id)}/${rel.split('/').map(encodeURIComponent).join('/')}?v=${hash.slice(0, 12)}`;
      const styles = (Array.isArray(d.styles) ? d.styles : [])
        .filter((s) => s && typeof s.path === 'string' && s.path && !s.path.startsWith('/') && !s.path.includes('..'))
        .map((s) => ({ path: s.path, url: fileUrl(s.path) }));
      panels.push({
        pack: p.id,
        id,
        slot: d.slot,
        module: d.module,
        url: fileUrl(d.module),
        ...(Array.isArray(d.messages) && d.messages.length ? { messages: [...d.messages] } : {}),
        ...(styles.length ? { styles } : {}),
      });
    }
  }
  return { panels: panels.sort(byPack), errors };
}
