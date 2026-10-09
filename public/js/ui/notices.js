// public/js/ui/notices.js — 公告与鸣谢的**面板**（DESIGN §28.15 的客户端那一半）。
//
// 正文来自 `/data/notices.json`：引擎那一半由 `CHANGELOG.md` 生成，包那一半是各包 `pack.json.notices` 追加进来的
// （合并语义见 docs/WORKSHOP.md §1.13）。它经**既有的**数据层读（`data.get('notices')`），所以走的是页面本来就在用的
// 缓存与重试，不新开通道。
//
// 客户端是**第二个读者**：形状不对的条目在这里也复判一次。最要紧的一条是链接 —— 只认 `https://`，一个包写
// `javascript:` 或 `http:` 不该变成页面上的一个可点链接。判据与服务端那一份同形（两处都判，不是抄一份名单）。

import { html, Button, MicroLabel, Modal } from './components.js';
import { data, useData } from '../data.js';
import { t } from '../../../shared/i18n.js';

/** 与服务端 `server/notices.js NOTICE_LIMITS` 同形的展示上限（面板不该画一个包塞进来的 10 万条）。 */
export const NOTICE_LIMITS = Object.freeze({ announcements: 8, credits: 40, sections: 12, items: 40, chars: 200 });

const text = (v, max = NOTICE_LIMITS.chars) => {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? '' : s;
};
const httpsUrl = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^https:\/\/[^\s]+$/.test(s) ? s : '';
};

/**
 * 把合并体整理成面板要画的东西（**纯函数**，`test/modNoticesPanel.test.js` 直接跑它）。
 * @param {any} body `/data/notices.json` 的解析结果（还没到就是 undefined）
 * @returns {{ announcements: Array<{ pack: string|null, version: string, date: string, summary: string, sections: Array<{ name: string, items: string[] }> }>, credits: Array<{ name: string, note: string, url: string }> }}
 */
export function noticesView(body) {
  const src = body && typeof body === 'object' ? body : {};
  const announcements = [];
  for (const raw of Array.isArray(src.announcements) ? src.announcements : []) {
    if (announcements.length >= NOTICE_LIMITS.announcements) break;
    if (!raw || typeof raw !== 'object') continue;
    const version = text(raw.version, 32);
    const date = text(raw.date, 32);
    const summary = text(raw.summary, 600);
    if (!version || !summary) continue;   // 少了这两样就没有可展示的东西（与服务端同一条，客户端不画半个）
    const sections = [];
    for (const section of Array.isArray(raw.sections) ? raw.sections : []) {
      if (sections.length >= NOTICE_LIMITS.sections) break;
      if (!section || typeof section !== 'object') continue;
      const name = text(section.name, 80);
      const items = (Array.isArray(section.items) ? section.items : [])
        .map((i) => text(i)).filter(Boolean).slice(0, NOTICE_LIMITS.items);
      if (name && items.length) sections.push({ name, items });
    }
    announcements.push({ pack: text(raw.pack, 64) || null, version, date, summary, sections });
  }
  const credits = [];
  const seen = new Set();
  for (const raw of Array.isArray(src.credits) ? src.credits : []) {
    if (credits.length >= NOTICE_LIMITS.credits) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = text(raw.name, 80);
    if (!name) continue;
    const url = httpsUrl(raw.url);          // 认不出的网址丢掉**网址**，名字照旧展示
    const key = `${name}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credits.push({ name, note: text(raw.note, 200), url });
  }
  return { announcements, credits };
}

/** 标题页角落的那个按钮。 */
export function NoticesButton({ onOpen }) {
  return html`<${Button} variant="ghost" size="sm" class="title-notices" onClick=${onOpen}>${t('公告')}<//>`;
}

/**
 * 面板本体。`open` 为假时它也保持挂载（`useData` 是一次订阅，不是一次请求），所以「打开」这个动作不会触发网络。
 */
export function NoticesModal({ open, onClose }) {
  useData('notices');
  const view = noticesView(data.get('notices'));
  const empty = !view.announcements.length && !view.credits.length;
  return html`<${Modal} open=${open} title=${t('公告与鸣谢')} onClose=${onClose} width="lg" class="notices-modal">
    ${empty ? html`<p class="t-dim">${t('这一版没有要展示的公告。')}</p>` : null}
    ${view.announcements.length ? html`<section class="notices-block">
      <${MicroLabel} tone="mint">${t('更新记录')}<//>
      ${view.announcements.map((a) => html`<article key=${`${a.pack || 'engine'}-${a.version}-${a.date}`} class="notices-item"
          data-pack=${a.pack || null}>
        <header class="notices-item__head">
          <b>${a.pack ? t('来自 {pack}', { pack: a.pack }) : t('游戏更新')}</b>
          <span class="t-dim">v${a.version} · ${a.date}</span>
        </header>
        <p>${a.summary}</p>
        ${a.sections.map((s) => html`<div class="notices-sec">
          <h4>${s.name}</h4>
          <ul>${s.items.map((item) => html`<li>${item}</li>`)}</ul>
        </div>`)}
      </article>`)}
    </section>` : null}
    ${view.credits.length ? html`<section class="notices-block">
      <${MicroLabel} tone="mint">${t('鸣谢')}<//>
      <ul class="notices-credits">
        ${view.credits.map((c) => html`<li key=${`${c.name}|${c.url}`}>
          ${c.url ? html`<a href=${c.url} target="_blank" rel="noopener noreferrer">${c.name}</a>` : html`<span>${c.name}</span>`}
          ${c.note ? html`<span class="t-dim"> · ${c.note}</span>` : null}
        </li>`)}
      </ul>
    </section>` : null}
  <//>`;
}
